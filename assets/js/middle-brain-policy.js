/* ====================================================================
   Middle Brain · Deterministic Policy / Gate 层（P11-1A 自 middle-brain.js 物理拆分）
   --------------------------------------------------------------------
   职责（纯本地、确定性、零网络）：
     1. Context Organization（复用现有 getMemoryContext 等 producer / 只读快照）
     2. Local Compression（去重 + 优先级 + 预算；绝不新增事实）
     3. Admission Gate（是否值得花一次 Astra 调用的成本闸门；无 LLM）
   不含：配置 UI、Astra 传输、Judge。gate 状态仍为纯内存 MB_GATE_STATE（不落盘）。
   拆分只动位置，不改逻辑。
   ==================================================================== */
(function (NS) {
  'use strict';
  var root = typeof self !== 'undefined' ? self : globalThis;
  /* ====================================================================
     Middle Brain v0 · Context Organization + Compression（独立 pipeline）
     --------------------------------------------------------------------
     - Astra 只读现有上下文；先组织（分类）再压缩（去重+按优先级保留+预算）。
     - 复用现有 Context 构建（getMemoryContext / getUnderstandingContext /
       getThreadContext / getMomentsContext），不重复实现 Memory 检索。
     - 压缩不改事实含义；不确定信息保持不确定（不变成确定事实）。
     - 不修改 Memory / Understanding / Thread；不做 OOC、Output Repair、
       模型路由、自动重写；不改角色模型调用链（本 pipeline 独立，供将来接入）。
     ==================================================================== */
  var MB_CTX_DEFAULT_BUDGET = 2600;  /* 字符预算（近似 token 的粗估：中文约 1 字≈1-1.5 token） */
  function _mbEstChars(s) { return String(s || '').length; }

  function _mbTextSimilarity(a, b) {
    if (typeof root._activeTextSimilarity === 'function') return root._activeTextSimilarity(a, b);
    /* 回落：字符 bigram 相似度（无 active-diary 依赖时也能去重） */
    var norm = function (s) { return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); };
    var x = norm(a), y = norm(b); if (!x || !y) return 0; if (x === y) return 1;
    var grams = function (s) { var o = new Set(); for (var i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; };
    var gx = grams(x), gy = grams(y), ov = 0; gx.forEach(function (g) { if (gy.has(g)) ov++; });
    return (2 * ov) / (gx.size + gy.size);
  }

  /* C2 step 1 · canonical Context 快照优先（只读）。
     返回 null → 调用方走既有 opts.*Ctx 逻辑（未接入快照，行为完全不变）。
     返回 {provided:true,value} → present（原文）/ empty（''）：本轮已读取，**禁止**再次 retrieval。
     返回 {provided:false}     → missing：本轮未读取/被门控，等价于 undefined，
                                 调用方继续走既有链（opts.*Ctx → producer retrieval）。 */
  function _mbSnapshotCtx(opts, name) {
    try {
      var snap = opts && opts.contextSnapshot;
      var CS = root.IBContextSnapshot;
      if (!snap || !CS || typeof CS.state !== 'function' || typeof CS.value !== 'function') return null;
      var st = CS.state(snap, name);
      if (st === 'present' || st === 'empty') return { provided: true, value: CS.value(snap, name) };
      return { provided: false };
    } catch (e) { return null; }
  }

  /* ① 组织：复用现有 Context 构建，把上下文聚成结构化分类。 */
  async function middleBrainOrganizeContext(characterId, userMessage, opts) {
    opts = opts || {};
    var organized = { memory: [], understanding: [], threads: [], moments: [], dialogue: opts.dialogue || [], stats: {} };
    /* 记忆（复用现有召回） */
    try {
      var mSnap = _mbSnapshotCtx(opts, 'memory');
      if (mSnap && mSnap.provided) { if (mSnap.value) organized.memory = [mSnap.value]; }
      else if (opts.memoryCtx != null) { if (opts.memoryCtx) organized.memory = [opts.memoryCtx]; }
      else if (typeof root.getMemoryContext === 'function') {
        var mc = await root.getMemoryContext(characterId, { userMessage: userMessage || '' });
        if (mc) organized.memory = [mc];
      }
    } catch (e) {}
    /* 理解（活文档） */
    try {
      var uSnap = _mbSnapshotCtx(opts, 'understanding');
      if (uSnap && uSnap.provided) { if (uSnap.value) organized.understanding = [uSnap.value]; }
      else if (opts.understandingCtx != null) { if (opts.understandingCtx) organized.understanding = [opts.understandingCtx]; }
      else if (typeof root.getUnderstandingContext === 'function') {
        var uc = await root.getUnderstandingContext(characterId);
        if (uc) organized.understanding = [uc];
      }
    } catch (e) {}
    /* 线索（open thread） */
    try {
      var tSnap = _mbSnapshotCtx(opts, 'thread');
      if (tSnap && tSnap.provided) { if (tSnap.value) organized.threads = [tSnap.value]; }
      else if (opts.threadCtx != null) { if (opts.threadCtx) organized.threads = [opts.threadCtx]; }
      else if (typeof root.getThreadContext === 'function') {
        var tc = await root.getThreadContext(characterId);
        if (tc) organized.threads = [tc];
      }
    } catch (e) {}
    /* 动态（moments） */
    try {
      var mMom = _mbSnapshotCtx(opts, 'moments');
      if (mMom && mMom.provided) { if (mMom.value) organized.moments = [mMom.value]; }
      else if (opts.momentsCtx != null) { if (opts.momentsCtx) organized.moments = [opts.momentsCtx]; }
      else if (typeof root.getMomentsContext === 'function') {
        var mC = await root.getMomentsContext(characterId, { userMessage: userMessage || '' });
        if (mC) organized.moments = [mC];
      } else if (opts.momentsText) { organized.moments = [opts.momentsText]; }
    } catch (e) {}
    return organized;
  }

  /* ② 压缩：把一层 line 列表去重（近重复合并）、按优先级保留、吃进预算。
     规则：绝不新增事实；保留"不确定"原样标记；删的是冗余/重复/过期，不是事实本身。 */
  function _mbCompressLines(lines, budget) {
    budget = Math.max(0, Number(budget) || 0);
    var picked = [];
    var used = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i] || '').trim();
      if (!line) continue;
      var len = _mbEstChars(line);
      /* 近重复：与已入选任一条相似度≥0.86 → 视为冗余，丢弃（保留更完整/更早的一条） */
      var dup = false;
      for (var j = 0; j < picked.length; j++) {
        if (_mbTextSimilarity(line, picked[j]) >= 0.86) { dup = true; break; }
      }
      if (dup) continue;
      if (budget && used + len > budget) continue;  /* 超预算则省略（不半截） */
      picked.push(line); used += len;
    }
    return picked;
  }

  /* ③ 压缩主流程：给每类设定优先级，按保序结构输出，控制总预算。
     优先级（高→低）：当前对话(dialogue) > 记忆(memory) > 理解(understanding) >
                      线索(threads) > 动态(moments)。
     ★ 关键保证：当前用户消息(dialogue)为最高优先级，永不因 budget 被省略。
     历史分类(memory/understanding/threads/moments)共享剩余预算（budget - 保底对话）。 */
  function middleBrainCompressContext(organized, opts) {
    opts = opts || {};
    var budget = Number(opts.budget) || MB_CTX_DEFAULT_BUDGET;
    var out = {
      memory: [], understanding: [], threads: [], moments: [], dialogue: (organized && Array.isArray(organized.dialogue)) ? organized.dialogue : (opts.dialogue || []),
      stats: { totalChars: 0, compressedChars: 0, droppedChars: 0, deduped: 0, categories: 0, fallback: false }
    };
    var flatten = [];
    /* 当前对话：最高优先级，原样保留（去重后），不参与 budget 省略。
       当前对话来自 organized.dialogue（第一参数组装），非 opts.dialogue。 */
    var dialogueArr = (organized && Array.isArray(organized.dialogue)) ? organized.dialogue : (opts.dialogue || []);
    var dialogueLines = _mbCompressLines(dialogueArr, 0 /* 无预算限制：当前消息永不完全省略 */);
    out.dialogue = dialogueLines;
    var dialogueLen = 0; dialogueLines.forEach(function (l) { dialogueLen += _mbEstChars(l); });
    /* 历史预算 = 总预算 - 当前对话保底占用；至少给历史留一小块，超支则不挤占对话 */
    var histBudget = Math.max(0, budget - dialogueLen);
    var catId = { memory: 0, understanding: 1, threads: 2, moments: 3, dialogue: 4 };

    function pushCat(cat, lines) {
      var arr = Array.isArray(lines) ? lines : (lines ? [lines] : []);
      var rawTotal = 0; arr.forEach(function (l) { rawTotal += _mbEstChars(l); });
      var picked = _mbCompressLines(arr, histBudget);
      var catLen = 0; picked.forEach(function (l) { catLen += _mbEstChars(l); });
      out[cat] = picked;
      out.stats.totalChars += rawTotal;
      out.stats.compressedChars += catLen;
      out.stats.droppedChars += Math.max(0, rawTotal - catLen);
      out.stats.deduped += Math.max(0, arr.length - picked.length);
      if (picked.length) out.stats.categories++;
      flatten.push({ cat: cat, order: catId[cat], lines: picked });
    }
    /* 历史分类按优先级共享剩余预算 */
    pushCat('memory', organized.memory);
    pushCat('understanding', organized.understanding);
    pushCat('threads', organized.threads);
    pushCat('moments', organized.moments);
    /* 把当前对话纳入统计（不计入历史压缩 dropped，但计入压缩总量与分类数） */
    out.stats.totalChars += dialogueLen;
    out.stats.compressedChars += dialogueLen;
    if (dialogueLines.length) out.stats.categories++;
    /* 按分类拼装 compressedContext（保序：记忆→理解→线索→动态→当前对话；对话恒在最后但永不省略） */
    var parts = [];
    flatten.sort(function (a, b) { return a.order - b.order; });
    flatten.forEach(function (f) {
      if (!f.lines.length) return;
      switch (f.cat) {
        case 'memory': parts.push('【记忆】\n' + f.lines.join('\n')); break;
        case 'understanding': parts.push('【对TA的理解】\n' + f.lines.join('\n')); break;
        case 'threads': parts.push('【仍在推进的线索】\n' + f.lines.join('\n')); break;
        case 'moments': parts.push('【近期动态】\n' + f.lines.join('\n')); break;
      }
    });
    if (dialogueLines.length) parts.push('【当前对话】\n' + dialogueLines.join('\n'));
    out.compressedContext = parts.join('\n\n');
    return out;
  }

  /* ④ pipeline：组织 → 压缩 → {structured, compressedContext, stats}。
     空上下文 / Astra 不可用 → 安全回落（返回组织后的原样，不丢信息）。 */
  async function middleBrainContextPipeline(characterId, userMessage, opts) {
    opts = opts || {};
    var organized = await NS.middleBrainOrganizeContext(characterId, userMessage, opts);
    var hasAnything = organized.memory.length || organized.understanding.length || organized.threads.length || organized.moments.length || (opts.dialogue && opts.dialogue.length);
    if (!hasAnything) {
      return { structured: organized, compressedContext: '', stats: { totalChars: 0, compressedChars: 0, droppedChars: 0, deduped: 0, categories: 0, empty: true, fallback: false } };
    }
    var compressed = NS.middleBrainCompressContext(organized, opts);
    compressed.stats.empty = false;
    return { structured: organized, compressedContext: compressed.compressedContext, stats: compressed.stats };
  }
  function middleBrainPipelineAvailable() {
    try { return typeof root.middleBrainContextPipeline === 'function'; } catch (e) { return false; }
  }

  /* ====================================================================
     Middle Brain Phase 2 · Astra Admission Gate（本地、确定性、无 LLM）
     --------------------------------------------------------------------
     目标：在调用 Astra 之前，用纯粹本地、确定性的信号判断"这次 Context
     是否值得花一次 Astra API 调用进行语义整理"，从而降低 Astra 调用次数与成本。

     链路：
       Context → Local Organization → Admission Gate
         ├─ NO  → Local Compress → Character Model（不产生任何 Astra 网络请求）
         └─ YES → Astra Responses API → Character Model（保持 Phase 1 不变）

     边界（与 Phase 1/要求一致）：
       - Gate 完全本地运行，绝不调用 LLM；绝不改写 Memory/Understanding/Thread/
         Diary/Moments；绝不改角色 Provider/模型/Prompt 语义。
       - Gate 不判断事实真假，只判断复杂度/价值（"是否值得一次语义整理"）。
       - 仅做降低成本的 gate；OOC/Output Repair/Memory Governance/Model Routing
         等一律不做（本阶段范围外）。
     可通过 admissionEnabled===false 完全关闭 → 恢复 Phase 1（永远尝试 Astra）。
     ==================================================================== */
  var MB_GATE_DEFAULTS = {
    scoreOn: 0.60,          /* 冷启动阈值：加权分 >= 此值 → YES（reason=context_complexity） */
    scoreHold: 0.45,        /* 迟滞保持阈值：近期我曾 YES，分 >= 此值 → 继续保持 YES */
    cooldownMs: 90000,      /* 冷却：同一角色两次 YES/调用之间至少间隔 90s（防连续轰击） */
    hysteresisMs: 180000,   /* 迟滞窗口：3 分钟内刚 YES 过 → 用 scoreHold 保持 */
    ctxCharsLow: 2500,      /* contextChars 低于 → context 分 0；高于 ctxCharsHigh → 1 */
    ctxCharsHigh: 7000,
    dlgCharsLow: 600,       /* dialogueChars 映射（当前对话长度） */
    dlgCharsHigh: 3500,
    budgetRatio: 0.90,      /* nearBudget：contextChars >= budgetRatio*ctxCharsHigh → YES */
    itemMax: 10,            /* 条目总数归一化上限 */
    reentryMs: 21600000,    /* 长时间离开（6h）后重新进入 → reentry 信号 */
    weights: { context: 0.35, dialogue: 0.15, items: 0.20, redundancy: 0.30 }
  };
  var MB_GATE_STATE = {};   /* 内存态：{characterId: {lastAstraAt,lastDecision,lastDecisionAt,lastMessageAt}}，不落盘 */
  function _mbGateCfg(cfg) {
    var g = (cfg && cfg.gate) || {};
    return Object.assign({}, MB_GATE_DEFAULTS, g);
  }
  function _mbClamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
  function _mbRamp(x, lo, hi) {
    if (hi <= lo) return Number(x) >= hi ? 1 : 0;
    return _mbClamp01((Number(x) - lo) / (hi - lo));
  }
  /* 加权复杂度分（0..1）。ratio 越低（越多被压缩/冗余）→ redundancy 分越高。 */
  function _mbGateScore(signals, cfg) {
    var w = (cfg && cfg.weights) || MB_GATE_DEFAULTS.weights;
    var ctxScore = _mbRamp(signals.contextChars, cfg.ctxCharsLow, cfg.ctxCharsHigh);
    var dlgScore = _mbRamp(signals.dialogueChars, cfg.dlgCharsLow, cfg.dlgCharsHigh);
    var items = (signals.memoryItems || 0) + (signals.understandingItems || 0) + (signals.threadItems || 0) + (signals.momentItems || 0);
    var itemScore = _mbRamp(items, 0, cfg.itemMax);
    var ratio = (signals.localCompressionRatio == null) ? 1 : signals.localCompressionRatio;
    var redScore = _mbClamp01((1 - ratio - 0.10) / 0.45);
    var score = w.context * ctxScore + w.dialogue * dlgScore + w.items * itemScore + w.redundancy * redScore;
    return { score: _mbClamp01(score), contextScore: ctxScore };
  }
  /* 纯判定（无副作用；可注入 signals/state/now 做确定性单元验证）。
     state: {lastAstraAt, lastDecision('yes'|'no'), lastDecisionAt} */
  function _mbDecisionFromSignals(signals, cfg, state, now) {
    cfg = _mbGateCfg(cfg); state = state || {}; if (signals == null) signals = {};
    now = (now == null ? Date.now() : now);
    var sc = _mbGateScore(signals, cfg);
    /* 硬触发（高价值信号，无视冷却）：明显冲突 / 多线程 / 接近预算 */
    if (signals.conflictSignal) return { useAstra: true, reason: 'conflict_signal', score: sc.score };
    if (signals.multipleThreads) return { useAstra: true, reason: 'multiple_threads', score: sc.score };
    if (signals.nearBudget) return { useAstra: true, reason: 'near_budget', score: sc.score };
    /* 冷却：刚 YES 过，同复杂度信号不立刻再轰 */
    if (state.lastAstraAt && (now - state.lastAstraAt) < cfg.cooldownMs) return { useAstra: false, reason: 'cooldown', score: sc.score };
    /* 迟滞：近期刚 YES → 用更低阈值保持，防止来回抖 */
    if (state.lastDecision === 'yes' && (now - state.lastDecisionAt) < cfg.hysteresisMs && sc.score >= cfg.scoreHold) {
      return { useAstra: true, reason: 'hysteresis_hold', score: sc.score };
    }
    /* 冷启动：达到 scoreOn → YES；否则省成本 → NO */
    if (sc.score >= cfg.scoreOn) return { useAstra: true, reason: 'context_complexity', score: sc.score };
    return { useAstra: false, reason: 'simple_context', score: sc.score };
  }
  /* 冲突信号启发式（复杂度代理，非事实判定）：识别组织文本中明显的矛盾/不一致标记。 */
  function _mbDetectConflict(organized) {
    var parts = [];
    (['memory', 'understanding', 'threads', 'moments']).forEach(function (k) {
      (organized && organized[k] || []).forEach(function (s) { if (s) parts.push(String(s)); });
    });
    var joined = parts.join('\n');
    if (!joined) return false;
    var markers = ['矛盾', '冲突', '不一致', '自相矛盾', '前后矛盾', '说法矛盾', '改口', '推翻', '完全相反', '恰好相反', '和之前不同', '说法不一致'];
    for (var i = 0; i < markers.length; i++) { if (joined.indexOf(markers[i]) >= 0) return true; }
    return false;
  }
  /* 从 organized 提取本地、确定性的信号（不写任何存储；无 LLM）。
     支持 opts.organized 复用（测试/接入方），否则组织一次。 */
  async function _mbAnalyzeSignals(characterId, userMessage, opts, cfg) {
    opts = opts || {};
    var organized = opts.organized || await NS.middleBrainOrganizeContext(characterId, userMessage, opts);
    var dialogueArr = (
      organized && Array.isArray(organized.dialogue) && organized.dialogue.length
    ) ? organized.dialogue : (userMessage ? [userMessage] : []);
    function countLines(arr) {
      var n = 0; (arr || []).forEach(function (s) { if (!s) return; String(s).split(/\n+/).forEach(function (l) { if (l.trim()) n++; }); });
      return n;
    }
    function catChars(arr) { var c = 0; (arr || []).forEach(function (s) { if (s) c += String(s).length; }); return c; }
    var memoryItems = countLines(organized.memory), understandingItems = countLines(organized.understanding),
        threadItems = countLines(organized.threads), momentItems = countLines(organized.moments);
    var dialogueChars = 0; dialogueArr.forEach(function (l) { if (l) dialogueChars += String(l).length; });
    var contextChars = catChars(organized.memory) + catChars(organized.understanding) + catChars(organized.threads) + catChars(organized.moments) + dialogueChars;
    /* 本地压缩比例：越低 = 被压缩/冗余越多 = 越值得 Astra 语义整理 */
    var local, total = 0, comp = 0, deduped = 0;
    try {
      local = NS.middleBrainCompressContext(organized, opts);
      total = (local && local.stats && local.stats.totalChars) || 0;
      comp = (local && local.stats && local.stats.compressedChars) || 0;
      deduped = (local && local.stats && local.stats.deduped) || 0;
    } catch (e) { total = 0; comp = 0; deduped = 0; }
    var localCompressionRatio = total > 0 ? (comp / total) : 1;
    var totalLines = memoryItems + understandingItems + threadItems + momentItems + dialogueArr.length;
    var duplicateRatio = totalLines > 0 ? (deduped / totalLines) : 0;
    var gcfg = _mbGateCfg(cfg);
    return {
      contextChars: contextChars, dialogueChars: dialogueChars,
      memoryItems: memoryItems, understandingItems: understandingItems,
      threadItems: threadItems, momentItems: momentItems,
      localCompressionRatio: localCompressionRatio, duplicateRatio: duplicateRatio,
      conflictSignal: _mbDetectConflict(organized),
      multipleThreads: (threadItems >= 2 || understandingItems >= 2),
      nearBudget: contextChars >= (gcfg.budgetRatio * gcfg.ctxCharsHigh),
      timeSinceLastAstraMs: null, longAbsenceReentry: false
    };
  }
  function _mbGateState(key, val) {
    if (val === undefined) return MB_GATE_STATE[key] || null;
    MB_GATE_STATE[key] = val; return val;
  }
  function middleBrainAdmissionGateReset(characterId) {
    if (characterId == null) { MB_GATE_STATE = {}; return; }
    delete MB_GATE_STATE[String(characterId)];
    return true;
  }
  /* Admission Gate 统一入口：返回 {useAstra, reason, signals, score}。
     - admissionEnabled===false → 绕过（永远允许 Astra，恢复 Phase 1）。
     - Astra 未就绪 → NO（本地压缩，不打 Astra）。
     - opts.signals 可注入（确定性测试）；opts.now / opts.state 可注入。 */
  async function middleBrainAdmissionGate(characterId, userMessage, opts, cfg) {
    opts = opts || {}; cfg = cfg || await NS.getMiddleBrainConfig();
    var now = (opts.now != null ? opts.now : Date.now());
    /* feature flag 完全关闭 → 恢复 Phase 1（永远尝试 Astra） */
    if (cfg.admissionEnabled === false) return { useAstra: true, reason: 'gate_disabled', signals: {} };
    /* Astra 未配置/未启用 → 无 Astra 可用 → 本地压缩 */
    if (!(await NS.middleBrainReady())) return { useAstra: false, reason: 'astra_not_ready', signals: {} };
    var signals = opts.signals || await _mbAnalyzeSignals(characterId, userMessage, opts, cfg);
    var state = opts.state ? opts.state : (_mbGateState(String(characterId)) || {});
    /* 时间型信号：距离上次 Astra 调用 / 长时间离开后重进 */
    signals.timeSinceLastAstraMs = (state.lastAstraAt && now) ? (now - state.lastAstraAt) : null;
    var lastMsg = state.lastMessageAt || 0;
    signals.longAbsenceReentry = !!(lastMsg && (now - lastMsg) > _mbGateCfg(cfg).reentryMs) && signals.contextChars >= 1200;
    var dec = _mbDecisionFromSignals(signals, cfg, state, now);
    /* 更新内存态（除非注入 state 由测试自行管理） */
    if (!opts.state) {
      state.lastMessageAt = now;
      state.lastDecision = dec.useAstra ? 'yes' : 'no';
      state.lastDecisionAt = now;
      if (dec.useAstra) state.lastAstraAt = now;  /* 以"判定 YES"为冷却锚点，防连续轰击 */
      _mbGateState(String(characterId), state);
    }
    return {
      useAstra: dec.useAstra,
      reason: dec.reason,
      signals: signals,
      score: dec.score != null ? Math.round(dec.score * 1000) / 1000 : null
    };
  }

  /* —— 注册到 IB.__middleBrain（内部装配点，非公开契约）—— */
  NS.middleBrainOrganizeContext = middleBrainOrganizeContext;
  NS.middleBrainCompressContext = middleBrainCompressContext;
  NS.middleBrainContextPipeline = middleBrainContextPipeline;
  NS.middleBrainPipelineAvailable = middleBrainPipelineAvailable;
  NS.middleBrainAdmissionGate = middleBrainAdmissionGate;
  NS.middleBrainAdmissionGateReset = middleBrainAdmissionGateReset;
  NS._mbAnalyzeSignals = _mbAnalyzeSignals;
  NS._mbDecisionFromSignals = _mbDecisionFromSignals;
  NS._mbGateScore = _mbGateScore;
  NS.MB_GATE_DEFAULTS = MB_GATE_DEFAULTS;
  NS.MB_CTX_DEFAULT_BUDGET = MB_CTX_DEFAULT_BUDGET;

  /* 内部共享（同层其它 part 使用，不进入 window/_middleBrain 契约） */
  NS._mbClamp01 = _mbClamp01;
})((function (r) { var ib = r.IB || (r.IB = {}); return ib.__middleBrain || (ib.__middleBrain = {}); })(typeof self !== 'undefined' ? self : globalThis));
