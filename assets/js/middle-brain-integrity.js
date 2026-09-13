/* ====================================================================
   Middle Brain · Character Integrity Guard 层（P11-2 新增）
   --------------------------------------------------------------------
   职责（P11-2 唯一新增能力，Middle Brain 内部）：
     1. Judge：判定"候选回复是否明显偏离当前角色"——结构化、machine-readable、确定性解析
     2. Gate：只有高置信度 + 强 severity 的明显 OOC 才触发重写（阈值配置化、保守默认）
     3. Targeted rewrite：保留原意/事实/信息量/对话任务，只修被指出的 violation
     4. Optional verify：重写后可选复判，**只观测**，绝不触发第二次重写
     5. Telemetry：enabled / judge ran / pass / fail / judge error / rewrite / rewrite error / verify / latency
   边界（硬约束）：
     - 只读：绝不写 Memory / Understanding / Thread / Diary / Moments / IndexedDB / localStorage
     - 绝不生成最终回复之外的任何内容；不修改用户要求、工具结果、事实答案
     - 绝不成环：每条候选最多一次 rewrite（judge → rewrite → optional verify → STOP）
     - 任何失败（未就绪 / 超时 / HTTP / 非 JSON / 校验不过 / 重写异常）→ 返回原候选
     - 默认关闭：关闭时零模型调用，行为与 P11-1C 等价
   依赖：MBC.config / MBC.policy / MBC.astra（DAG 上游，只读）；对外唯一出口 = MBC.integrity（冻结）。
   对话证据来源（M1-C.2p）：assets/js/dialogue-core.js（canonical dialogue authority，只读）。
     本层**不再**持有"哪些消息构成当前对话"的定义 —— 它只消费共享核心的投影；
     自己的策略（总量预算 / 渲染成【最近对话】段 / 维度可用性）一律发生在投影之后。
   传输不重复实现：所有模型请求走 ASTRA.middleBrainModelCall（astra 层 = 唯一网络边界）。
   ==================================================================== */
(function (root) {
  'use strict';
  var MBC = (root.IB = root.IB || {}).__middleBrainContracts || (root.IB.__middleBrainContracts = {});
  var CFG = MBC.config, POL = MBC.policy, ASTRA = MBC.astra;   /* contract 依赖：config / policy / astra（只读） */

  /* —— 判断维度（白名单：非白名单维度一律丢弃，避免模型自创维度） —— */
  var MB_CI_DIMENSIONS = ['persona', 'speech_style', 'relationship', 'emotional_continuity', 'knowledge_boundary', 'behavior'];
  var MB_CI_TIMEOUT_MS = 20000;
  var MB_CI_MAX_VIOLATIONS = 8;        /* 上限：防止模型输出长清单（也防 CoT 泄漏） */
  var MB_CI_EVIDENCE_CHARS = 200;      /* 单条 evidence/reason 上限：只留短理由，不存长推理 */
  var MB_CI_JUDGE_MAX_TOKENS = 900;
  var MB_CI_REWRITE_MAX_TOKENS = 1600;
  /* 保守默认（第一版宁可漏掉轻微 OOC，也不频繁误杀正常回复）：
     confidence = Judge 自评置信度下限；score = 一致性分数上限（越低越像 OOC）；
     severity = 单条 violation 强度下限；failBelow = 判定为 fail 的分数参考线（仅 telemetry 分类用）。 */
  var MB_CI_SENSITIVITY = {
    conservative: { confidence: 0.80, score: 0.35, severity: 0.85, failBelow: 0.50 },
    balanced: { confidence: 0.65, score: 0.45, severity: 0.70, failBelow: 0.60 },
    strict: { confidence: 0.50, score: 0.55, severity: 0.60, failBelow: 0.70 }
  };
  var MB_CI_DEFAULT_SENSITIVITY = 'conservative';

  var MB_CI_SCHEMA = {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      score: { type: 'number' },
      confidence: { type: 'number' },
      violations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dimension: { type: 'string' },
            severity: { type: 'number' },
            evidence: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['dimension', 'severity', 'evidence', 'reason'],
          additionalProperties: false
        }
      }
    },
    required: ['pass', 'score', 'confidence', 'violations'],
    additionalProperties: false
  };
  var MB_CI_REWRITE_SCHEMA = {
    type: 'object',
    properties: { reply: { type: 'string' } },
    required: ['reply'],
    additionalProperties: false
  };

  /* ── 系统裁定状态（P11-2B）────────────────────────────────────────────
     **系统**裁定状态，不是模型输出状态：Judge schema 的 pass:boolean 保持不变。
     四态中前两态只能来自一个**合法解析成功**的 Judge report；第三态 = 系统尝试
     过但**没有拿到合法 verdict**；第四态 = 系统**有意不尝试**（不是失败）。
     已确认事实：null 绝不能被 coercion 成 false / []；timeout 绝不能被建模成 OOC。
     P11-2C：本枚举是下游副作用闸门的**输入词汇表**，必须真正不可改写 ——
     原文只写了"冻结"而对象本身没被 Object.freeze（P11-2C 测试发现并修）。 */
  var MB_CI_VERDICT = Object.freeze({
    PASS: 'PASS',               /* Judge 合法 report 且 report.pass === true */
    OOC: 'OOC',                 /* Judge 合法 report 且 report.pass === false（含被 gate 拦下的） */
    UNDECIDED: 'UNDECIDED',     /* 尝试过 Judge，但 timeout / 传输失败 / malformed / 证据组装异常 */
    BYPASSED: 'BYPASSED'        /* 有意不调用 Judge：未启用 / 语音面 / 无可见文本 / Astra 未就绪 */
  });
  /* P11-2C · 受闸门保护的副作用入口（**声明式清单**：给下游一个明确输入，
     而不是让每个执行器自己猜"这条回复可不可信"）。
     清单只登记**桌面 Chat 回合里、由模型回复解析出的副作用**；不含群聊/博客留言/
     角色来信等不经过 Middle Brain 收口的路径（它们拿不到 verdict，属存量行为）。 */
  var MB_CI_SIDE_EFFECT_SITES = Object.freeze({
    MEM_OPS: 'mem_ops',            /* <mem_*> → _execMemOps：Auto Memory 写入 */
    CALENDAR: 'calendar',          /* <cal_note> → IBCAL.processReply：日历便笺入库 + 台账勾选 */
    BLOG_READ: 'blog_read',        /* <blog_read> → _execBlogReadOps：把日志正文排队注入下一轮 */
    WS_OPS: 'ws_ops'               /* <ws_*> → _execWsOps 等：文件/图片/搜索/工具执行 */
  });
  /* P11-2D · 抑制类别词表（**去标识化**：只描述副作用是哪一类，绝不描述它的内容）——
     与上表的关系是"闸门轴 × 类别轴"：MB_CI_SIDE_EFFECT_SITES 是**闸门位置**（4 个决策点），
     本表是**类别**（6 个），二者多对一。刻意不改 SITES 的值或粒度（那是 P11-2C 的冻结契约）。
     workspace/file_archive 是同一 `_execWsOps` / `_wsArchiveFileBlocks` 入口内、
     按产出物区分的两档；"文件内容 / 路径 / 搜索结果"这三类本阶段**不单独登记**：
     它们由 `_execWsOps` 一并执行，无法在闸门处可靠区分，宁可不精确也不虚报类别。 */
  var _MB_CI_SUPPRESSION_CATEGORIES = Object.freeze({
    MEMORY: 'memory',               /* _execMemOps —— Auto Memory 写入 */
    CALENDAR: 'calendar',           /* IBCAL.processReply —— 日历便笺 / 台账勾选 */
    BLOG_READ: 'blog_read',         /* _execBlogReadOps —— 日志正文排队注入下一轮 */
    WORKSPACE: 'workspace',         /* _execWsOps —— 文件 / 图片 / 搜索 / 工具指令 */
    FILE_ARCHIVE: 'file_archive',   /* _wsArchiveFileBlocks —— ```file: 块归档入库 */
    TOOL_CONTINUE: 'tool_continue'  /* _wsToolContinue —— 工具后续轮（会再发一次模型请求） */
  });
  var _MB_CI_SUPPRESSION_VALUES = Object.freeze(Object.keys(_MB_CI_SUPPRESSION_CATEGORIES)
    .map(function (k) { return _MB_CI_SUPPRESSION_CATEGORIES[k]; }));
  var _mbCiTelemetry = {
    checked: 0,          /* 进入 Guard（enabled）的次数 */
    skipped: {},         /* skipReason → 次数 */
    verdicts: {},        /* 系统裁定状态 → 次数（PASS / OOC / UNDECIDED / BYPASSED） */
    judgeUndecided: 0,   /* 「尝试过但没有 verdict」的次数（口径比 judgeError 宽：含 malformed / guard_error） */
    judgeRuns: 0, judgePass: 0, judgeFail: 0, judgeError: 0, judgeMalformed: 0,
    rewriteTriggered: 0, rewriteOk: 0, rewriteError: 0, rewriteSkipped: 0,
    verifyRuns: 0, verifyPass: 0, verifyFail: 0, verifyError: 0,
    judgeLatencyMs: 0, rewriteLatencyMs: 0,
    maxRewritesPerTurn: 0,
    /* P11-2D · 副作用抑制（**仅元数据**）——
       turn：最近一次被抑制的回合（categories 去重、无顺序语义）；null = 本回合没有发生抑制。
       计数：**只统计真正被闸门拦下的类别**，绝不用 verdict === UNDECIDED 代替。
       "UNDECIDED 但回复里根本没有指令" ⇒ 不产生任何记录（这是本阶段的关键语义）。 */
    sideEffectsSuppressed: 0, suppressedCategories: {}, turn: null, turnVerdict: null,
    last: null
  };
  function middleBrainCharacterIntegrityTelemetry() { return _mbCiTelemetry; }
  function middleBrainCharacterIntegrityReset() {
    _mbCiTelemetry.checked = 0; _mbCiTelemetry.skipped = {};
    _mbCiTelemetry.verdicts = {}; _mbCiTelemetry.judgeUndecided = 0;
    _mbCiTelemetry.judgeRuns = 0; _mbCiTelemetry.judgePass = 0; _mbCiTelemetry.judgeFail = 0;
    _mbCiTelemetry.judgeError = 0; _mbCiTelemetry.judgeMalformed = 0;
    _mbCiTelemetry.rewriteTriggered = 0; _mbCiTelemetry.rewriteOk = 0; _mbCiTelemetry.rewriteError = 0; _mbCiTelemetry.rewriteSkipped = 0;
    _mbCiTelemetry.verifyRuns = 0; _mbCiTelemetry.verifyPass = 0; _mbCiTelemetry.verifyFail = 0; _mbCiTelemetry.verifyError = 0;
    _mbCiTelemetry.judgeLatencyMs = 0; _mbCiTelemetry.rewriteLatencyMs = 0; _mbCiTelemetry.maxRewritesPerTurn = 0;
    _mbCiTelemetry.sideEffectsSuppressed = 0; _mbCiTelemetry.suppressedCategories = {};
    _mbCiTelemetry.turn = null; _mbCiTelemetry.turnVerdict = null;
    _mbCiTelemetry.last = null;
  }
  /* —— P11-2D · 副作用抑制记录（**唯一写入点**）────────────────────────────
     调用契约（向下游提供"实际被拦下"这一事实，而不是"本轮处于某个状态"）：
       · 只在判定结论为 allow === false **且**该副作用指令确实存在时被调用；
       · count 必须 > 0。**没有任何条目的询问（含调用点交出的空类别集合）一律不记录** ——
         "状态是 UNDECIDED"本身不是抑制，本函数也不接受它作为记录理由。
       · category 必须属于 MB_CI_SUPPRESSION_CATEGORIES，否则**一个字都不记**，
         连总计数也不加：本模块的职责是如实报告"哪一类被拦下"，
         报不出来的东西就不该出现在计数里（宁可少记，也不虚报一个说不清的类别）。
       · 只记类别与条数；不记文件名 / 路径 / 记忆正文 / 日历文本 / 日志内容 /
         搜索词 / 工具参数 / 回复正文。本函数的入参里根本没有可承载这些内容的字段。 */
  function _mbCiSuppress(category, count) {
    var cat = _ciStr(category).trim().toLowerCase();
    var n = Number(count);
    if (!(n > 0)) return;                                        /* 无条目 ⇒ 不是抑制 */
    if (_MB_CI_SUPPRESSION_VALUES.indexOf(cat) < 0) return;      /* 说不清类别 ⇒ 不记 */
    _mbCiTelemetry.sideEffectsSuppressed++;
    var turn = _mbCiTelemetry.turn;
    if (!turn) turn = _mbCiTelemetry.turn = { categories: [], count: 0 };
    turn.count += n;
    if (turn.categories.indexOf(cat) < 0) turn.categories.push(cat);
    _mbCiTelemetry.suppressedCategories[cat] = (_mbCiTelemetry.suppressedCategories[cat] || 0) + 1;
  }
  /* 回合边界：抑制记录是"本轮"的，绝不能跨轮残留 —— 否则一个 PASS 回合会读到
     上一轮 UNDECIDED 留下的记录，于是 trace 会声称"本轮抑制了 X"。

     判定依据是**显式裁定状态的取值变化**，而不是"第几次询问"：
       · 生产里 `_mbVerdict` 每个回合在收口时赋值一次，同回合内所有副作用点读到的
         是**同一个值**（含 null）。因此"取到了一个与上次不同的 verdict"唯一地
         标志着一个新回合，与它被询问多少次无关。
       · 这一点是关键：一个回合可能询问很多次（memory / calendar / blog / workspace /
         file / tool…）。若把"第一次询问"当成回合边界，第二次询问就会把本轮刚记下的
         类别一起清空 —— 多类抑制只剩最后一个。实现时实测踩到，T11 抓到。
       · 比较用 `String(v)`：本函数只处理字符串四态与 null，无对象语义。
     Reset() 仍会清空它（会话级），两者职责不同。 */
  function _mbCiTurnIdentity(v) {
    if (_mbCiTelemetry.turnVerdict !== v) {
      _mbCiTelemetry.turnVerdict = v;
      _mbCiTelemetry.turn = null;   /* 新回合：清掉上一轮的抑制记录 */
    }
  }
  /* 读取本轮抑制记录（供回合 trace 复制一次；**不清空**，清空只由上面的复位点负责）。 */
  function middleBrainSideEffectSuppression() {
    var t = _mbCiTelemetry.turn;
    return {
      categories: t ? t.categories.slice() : [],
      count: t ? t.count : 0,
      total: _mbCiTelemetry.sideEffectsSuppressed,
      byCategory: Object.assign({}, _mbCiTelemetry.suppressedCategories)
    };
  }
  function _ciSkip(reason) {
    _mbCiTelemetry.skipped[reason] = (_mbCiTelemetry.skipped[reason] || 0) + 1;
    _mbCiTelemetry.last = { skipReason: reason, ts: Date.now() };
  }
  function _ciLast(patch) {
    _mbCiTelemetry.last = Object.assign({}, _mbCiTelemetry.last || {}, patch, { ts: Date.now() });
  }
  /* 裁定状态计数（唯一出口）：verdicts 分布 + judgeUndecided（有独立含义：
     与 judgeError 的差别是它把 malformed / guard_error 也算进"没拿到 verdict"）。 */
  function _ciVerdict(oc) {
    var v = (oc && oc.verdict) || MB_CI_VERDICT.BYPASSED;
    _mbCiTelemetry.verdicts[v] = (_mbCiTelemetry.verdicts[v] || 0) + 1;
    if (v === MB_CI_VERDICT.UNDECIDED) _mbCiTelemetry.judgeUndecided++;
    return oc;
  }

  /* —— 证据提取（只读；只用仓库真实存在的数据） —— */
  function _ciStr(v) { return v == null ? '' : String(v); }
  function _ciCap(s, n) { s = _ciStr(s); return s.length > n ? s.slice(0, n) : s; }

  /* ── 当前对话证据：**共享核心**（assets/js/dialogue-core.js）────────────
     M1-C.2p：本层此前自带一份 `_ciHistory` —— 它自己决定窗口（最近 8 条）、
     单条上限（400 字）、总量预算（2400 字）、角色映射、排序与截断，于是
     "哪些消息构成当前对话"在 Character Integrity 这条路径上**有第二个定义**，
     而 Middle Brain 已在 M1-C.2o 收敛到 `IBDialogueCore.assemble`。同一份
     canonical 状态在两条路径上因此可以得到不同的对话证据（含"当前回合到底
     在不在里面"这种根本差异），而 guard 的判定正是建立在这段证据上。
     现在的结构（M1-C.2p §1/§10）：
        canonical dialogue → IBDialogueCore → shared rows
                                            ├── Middle Brain representation
                                            └── Character Integrity representation
     本层只**消费**，不重新定义：selection（角色映射 / 窗口 / 单条上限 / 当前回合
     归属）全部由共享核心决定；guard 自己的 policy（下面的总量预算、【最近对话】
     渲染、维度可用性）一律发生在投影**之后**。
     为什么不在本层再写一份"等价实现"或第二套上限常量：两份实现必然漂移，
     这正是本阶段要消灭的东西。核心缺席时如实降级为**无对话证据**（fail-safe），
     绝不重建第二份投影。 */
  var CI_DIALOGUE_TOTAL_CHARS = 2400;   /* guard 侧消费预算：历史行合计上限 */

  function _ciDialogueCore() {
    try {
      var core = root.IBDialogueCore;
      if (core && typeof core.assemble === 'function') return core;
    } catch (e) {}
    return null;
  }
  /* 带标签行 → 结构化行。标签取自核心自己导出的常量（USER_LABEL / ROLE_LABEL），
     这里只是它 labelFor() 的逆运算 —— **不是**第二套角色映射：role 语义仍然只由
     核心的 roleOf() 决定。 */
  function _ciRowOfLine(line, core) {
    var s = _ciStr(line);
    var user = _ciStr(core.USER_LABEL) || '用户：';
    var role = _ciStr(core.ROLE_LABEL) || '角色：';
    if (s.indexOf(user) === 0) return { role: 'user', text: s.slice(user.length) };
    if (s.indexOf(role) === 0) return { role: 'assistant', text: s.slice(role.length) };
    return null;
  }
  /* 共享核心投影 + guard 消费预算。
     返回 { dialogue: [{role,text}], meta }；任何异常 → 无对话证据（绝不抛错：
     证据组装在回合链路上，抛错会变成回合失败）。 */
  function _ciDialogue(history, userMessage, currentId) {
    var none = { dialogue: [], meta: { source: 'unavailable', historyCount: 0, priorRows: 0,
      currentIncluded: false, currentSkipped: null, truncatedHistory: 0, budgetDropped: 0 } };
    var core = _ciDialogueCore();
    if (!core) return none;
    var res = null;
    try { res = core.assemble({ history: history, userMessage: userMessage, currentId: currentId }); }
    catch (e) { return none; }
    if (!res || !Array.isArray(res.lines)) return none;

    var rows = [];
    for (var i = 0; i < res.lines.length; i++) {
      var row = _ciRowOfLine(res.lines[i], core);
      if (row) rows.push(row);
    }
    var historyCount = Number(res.historyCount);
    if (!isFinite(historyCount) || historyCount < 0) historyCount = 0;
    if (historyCount > rows.length) historyCount = rows.length;

    /* ── guard 消费预算（2400 字，数值沿用 _ciHistory 的同一量级）──────────
       作用域 = **历史行**：当前回合不是历史的一部分，也不是这条预算的分母
       （旧实现把它算进分母，是因为旧投影把当前回合当成一行普通历史）。
       丢弃方向从旧的一端开始，且**绝不丢最后一行** —— 当前回合要么是追加的
       末行、要么是历史前缀的末行，两种归属下都因此结构性存活。 */
    var head = rows.slice(0, historyCount), tail = rows.slice(historyCount);
    var total = 0;
    for (var j = 0; j < head.length; j++) total += head[j].text.length;
    var dropped = 0;
    while (head.length > 1 && total > CI_DIALOGUE_TOTAL_CHARS) {
      total -= head[0].text.length; head.shift(); dropped++;
    }
    var dialogue = head.concat(tail);
    /* 当前回合的归属（§4）：'已 canonical 在窗口内'（原位，只出现一次）
       或 '由核心追加为末行' 或 '不存在'（当前消息为空）。 */
    var currentIncluded = res.currentIncluded === true;
    var currentSkipped = res.currentSkipped || null;
    var currentOwned = currentIncluded || currentSkipped === 'duplicate';
    return {
      dialogue: dialogue,
      meta: {
        source: 'dialogue-core',
        historyCount: head.length,
        /* 前序对话行数（不含承载当前回合的那一行）—— 维度可用性只看它 */
        priorRows: Math.max(0, dialogue.length - (currentOwned ? 1 : 0)),
        currentIncluded: currentIncluded,
        currentSkipped: currentSkipped,
        truncatedHistory: Number(res.truncatedHistory) || 0,
        budgetDropped: dropped
      }
    };
  }
  /* 角色证据：只读消费方已经拿到的角色配置（不发明新 schema、不自行 retrieval） */
  function _mbCiBuildEvidence(characterId, userMessage, opts) {
    opts = opts || {};
    var ch = opts.character || {};
    var persona = {
      nickname: _ciCap(ch.nickname, 40),
      relationship: _ciCap(ch.relationship, 60),
      bio: _ciCap(ch.bio || ch.signature, 200),
      systemPrompt: _ciCap(ch.systemPrompt, 1600)
    };
    /* 对话证据 = 共享核心对 (history, userMessage, currentId) 的投影。
       `history` 是**canonical 对话行**（该宿主本轮交给模型的同一段），
       不是 provider 请求数组；`currentId` 是当前回合的消息身份（有则优先按
       身份识别"这一轮已经在窗口里"，没有才走核心声明的逐字原文回落）。 */
    var dlg = _ciDialogue(opts.history, userMessage, opts.currentId);
    var dialogue = dlg.dialogue;
    var ctx = { memory: '', understanding: '', thread: '', moments: '' };
    ['memory', 'understanding', 'thread', 'moments'].forEach(function (name) {
      try {
        var s = POL._mbSnapshotCtx(opts, name);
        if (s && s.provided && s.value) ctx[name] = _ciCap(s.value, 900);
      } catch (e) {}
    });
    var hasCtx = !!(ctx.memory || ctx.understanding || ctx.thread || ctx.moments);
    /* 前序对话是否存在（**不含**承载当前回合的那一行）：这就是旧实现的
       `dialogue.length > 0` 在 Home Node 上的语义 —— 保留它，而不是把
       "用户刚说的这一句"当成她自己的说话样本 / 情感连续性证据。 */
    var hasPriorDialogue = dlg.meta.priorRows > 0;
    return {
      characterId: _ciCap(characterId, 80),
      persona: persona,
      userMessage: _ciCap(userMessage, 600),
      dialogue: dialogue,
      /* 归属与投影元信息（只读；shape 为新增键，旧键不变）：当前回合在证据里
         **恰好一次** —— 要么已在窗口内原位（currentSkipped='duplicate'），
         要么由核心追加为末行（currentIncluded=true）。 */
      dialogueMeta: dlg.meta,
      context: ctx,
      /* 证据可用性：缺失的维度**不允许**被判 fail（防误杀）。
         persona / relationship / knowledge_boundary 的判据不变；
         speech_style / emotional_continuity / behavior 看的是**前序对话**。 */
      available: {
        persona: !!(persona.systemPrompt || persona.nickname || persona.bio),
        speech_style: !!(persona.systemPrompt || hasPriorDialogue),
        relationship: !!persona.relationship,
        emotional_continuity: hasPriorDialogue,
        knowledge_boundary: hasCtx,
        behavior: !!(persona.systemPrompt || hasPriorDialogue)
      }
    };
  }

  /* —— 控制标签：带功能标签的候选回复不做重写（工具副作用已无法安全重建） —— */
  function _mbCiHasControlTags(text) {
    return /<withdraw|<thinking>|<\/think|<ws_[a-z_]*|<mem_|<cal_note|<blog_read|```file:/i.test(_ciStr(text));
  }
  /* 供 Judge 阅读的"可见文本"（近似视图：只用于判定，不用于重写替换） */
  function _mbCiVisibleText(text) {
    var s = _ciStr(text);
    s = s.replace(/```file:[\s\S]*?```/gi, ' ');
    s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ');
    s = s.replace(/<\/?think(?:ing)?>/gi, ' ');
    s = s.replace(/<withdraw\s*\/?>/gi, ' ');
    s = s.replace(/<\/?(?:ws|mem|cal|blog)_[a-z_]*\b[^>]*>/gi, ' ');
    return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* —— 确定性解析：Judge JSON —— */
  function _mbParseCiJson(text) {
    try {
      var s = _ciStr(text).trim();
      var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence && fence[1]) s = fence[1].trim();
      var start = s.indexOf('{'), end = s.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      var obj = JSON.parse(s.slice(start, end + 1));
      if (!obj || typeof obj !== 'object') return null;
      if (typeof obj.pass !== 'boolean') return null;                     /* 必需字段缺失 → malformed */
      if (obj.score == null || isNaN(Number(obj.score))) return null;
      if (!Array.isArray(obj.violations)) return null;
      var violations = [];
      for (var i = 0; i < obj.violations.length && violations.length < MB_CI_MAX_VIOLATIONS; i++) {
        var v = obj.violations[i]; if (!v || typeof v !== 'object') continue;
        var dim = _ciStr(v.dimension).trim().toLowerCase();
        if (MB_CI_DIMENSIONS.indexOf(dim) < 0) continue;                  /* 非白名单维度 → 丢弃 */
        violations.push({
          dimension: dim,
          severity: POL._mbClamp01(Number(v.severity)),
          evidence: _ciCap(v.evidence, MB_CI_EVIDENCE_CHARS),
          reason: _ciCap(v.reason, MB_CI_EVIDENCE_CHARS)
        });
      }
      var maxSeverity = 0;
      for (var k = 0; k < violations.length; k++) if (violations[k].severity > maxSeverity) maxSeverity = violations[k].severity;
      /* confidence 缺失 → 0（保守：不允许"没给置信度"就触发重写） */
      var conf = (obj.confidence == null || isNaN(Number(obj.confidence))) ? 0 : POL._mbClamp01(Number(obj.confidence));
      return {
        pass: obj.pass === true,
        score: POL._mbClamp01(Number(obj.score)),
        confidence: conf,
        violations: violations,
        maxSeverity: maxSeverity,
        dimensions: violations.map(function (x) { return x.dimension; })
      };
    } catch (e) { return null; }
  }
  /* —— 确定性解析：Rewrite JSON —— */
  function _mbParseCiRewriteJson(text) {
    try {
      var s = _ciStr(text).trim();
      var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence && fence[1]) s = fence[1].trim();
      var start = s.indexOf('{'), end = s.lastIndexOf('}');
      if (start < 0 || end <= start) return null;
      var obj = JSON.parse(s.slice(start, end + 1));
      if (!obj || typeof obj !== 'object') return null;
      var r = obj.reply;
      if (typeof r !== 'string' || !r.trim()) return null;
      return r;
    } catch (e) { return null; }
  }

  /* —— 阈值 / 门控（纯函数，可确定性单测） —— */
  function _mbCiSensitivity(cfg) {
    var s = _ciStr(cfg && cfg.characterIntegritySensitivity).trim().toLowerCase();
    return MB_CI_SENSITIVITY[s] ? s : MB_CI_DEFAULT_SENSITIVITY;
  }
  function _mbCiThresholds(cfg) { return MB_CI_SENSITIVITY[_mbCiSensitivity(cfg)]; }
  /* gate：只有"Judge 明确 fail + 置信度够 + 分数够低 + severity 够高 + 未用过重写 + 无控制标签"才重写。
     任何一项不满足 → 原回复（保守优先）。 */
  function _mbCiGate(report, cfg, opts) {
    opts = opts || {};
    var th = _mbCiThresholds(cfg);
    if (!report) return { rewrite: false, reason: 'no_report', thresholds: th };
    /* maxSeverity 缺失时按 violations 现算（手写/降级 report 也能安全判定；缺失即 0 → 不重写） */
    var maxSev = (report.maxSeverity != null) ? Number(report.maxSeverity)
      : (Array.isArray(report.violations) ? report.violations.reduce(function (m, v) {
        var s = Number(v && v.severity); return isNaN(s) ? m : Math.max(m, s);
      }, 0) : 0);
    if (report.pass === true) return { rewrite: false, reason: 'judge_pass', thresholds: th };
    if (!(cfg && cfg.characterIntegrityRewrite === true)) return { rewrite: false, reason: 'rewrite_disabled', thresholds: th };
    if (opts.rewriteUsed === true) return { rewrite: false, reason: 'rewrite_already_used', thresholds: th };
    if (opts.controlTags === true) return { rewrite: false, reason: 'control_tags_present', thresholds: th };
    if (!(Number(report.confidence) >= th.confidence)) return { rewrite: false, reason: 'low_confidence', thresholds: th };
    if (!(Number(report.score) <= th.score)) return { rewrite: false, reason: 'score_above_threshold', thresholds: th };
    if (!(maxSev >= th.severity)) return { rewrite: false, reason: 'severity_below_threshold', thresholds: th };
    return { rewrite: true, reason: 'strong_ooc', thresholds: th, maxSeverity: maxSev };
  }

  /* —— Prompt 构建 —— */
  function _ciEvidenceBlock(ev) {
    var lines = [];
    if (ev.persona.nickname) lines.push('昵称：' + ev.persona.nickname);
    if (ev.persona.relationship) lines.push('与用户的关系：' + ev.persona.relationship);
    if (ev.persona.bio) lines.push('简介：' + ev.persona.bio);
    if (ev.persona.systemPrompt) lines.push('角色设定/系统提示词：\n' + ev.persona.systemPrompt);
    return lines.join('\n') || '(无角色设定)';
  }
  function _ciDialogueBlock(ev) {
    if (!ev.dialogue.length) return '(无)';
    return ev.dialogue.map(function (m) { return (m.role === 'assistant' ? '角色：' : '用户：') + m.text; }).join('\n');
  }
  function _ciContextBlock(ev) {
    var parts = [];
    if (ev.context.memory) parts.push('【记忆】' + ev.context.memory);
    if (ev.context.understanding) parts.push('【对TA的理解】' + ev.context.understanding);
    if (ev.context.thread) parts.push('【仍在推进的线索】' + ev.context.thread);
    if (ev.context.moments) parts.push('【近期动态】' + ev.context.moments);
    return parts.join('\n\n') || '(无)';
  }
  function _ciUnavailableBlock(ev) {
    var miss = MB_CI_DIMENSIONS.filter(function (d) { return !ev.available[d]; });
    return miss.length ? miss.join(' / ') : '(无)';
  }
  function _mbCiJudgePrompt(ev, candidateVisible) {
    return '你是 InternalBeyond（IB）的 Character Integrity Judge。'
      + '你只判断"这段候选回复是否**明显**偏离当前角色"，绝不修改它、绝不生成新回复、绝不评价文笔好坏。\n'
      + '【最重要的防误杀原则】当前上下文中的明确变化证据 > 静态人设刻板印象。\n'
      + '- 角色按用户要求暂时正式/冷淡/生气/开玩笑 → 不是 OOC。\n'
      + '- 角色正常生气、正常冷淡、正常开玩笑 → 不是 OOC。\n'
      + '- 角色讨论技术/事实问题、语气变平实 → 不是 OOC。\n'
      + '- 措辞、句式、口癖与"刻板印象"不同 → 不是 OOC（不同底层模型本来就该有不同的声音）。\n'
      + '- 只有当回复与角色人格、关系状态、已知事实或当前情境发生**实质冲突**时，才判 pass:false。\n'
      + '【维度】persona / speech_style / relationship / emotional_continuity / knowledge_boundary / behavior。\n'
      + '【证据不可用】下列维度缺少证据，**不得**据此判 fail：' + _ciUnavailableBlock(ev) + '\n'
      + '【输出】只输出 JSON，不要任何解释文字、不要 chain-of-thought：\n'
      + '{"pass":true,"score":0.93,"confidence":0.9,"violations":[]}\n'
      + 'score = 角色一致性分数（1 完全一致，0 完全偏离）；confidence = 你对本次判断的置信度（0..1）；\n'
      + 'violations[].dimension 必须取上述六个之一；severity 0..1；evidence 必须是候选回复里的原文片段（≤80字）；'
      + 'reason 一句话（≤60字）。无违规时 violations 为空数组。\n'
      + '【角色证据】\n' + _ciEvidenceBlock(ev) + '\n\n'
      + '【最近对话】\n' + _ciDialogueBlock(ev) + '\n\n'
      + '【可用上下文证据】\n' + _ciContextBlock(ev) + '\n\n'
      + '【当前用户消息】\n' + (ev.userMessage || '(无)') + '\n\n'
      + '【候选回复】\n' + candidateVisible + '\n\n'
      + '请判定【候选回复】是否明显偏离角色。';
  }
  function _mbCiRewritePrompt(ev, candidate, report) {
    var vs = (report.violations || []).map(function (v, i) {
      return (i + 1) + '. dimension=' + v.dimension + ' severity=' + v.severity
        + '\n   evidence: ' + (v.evidence || '(无)') + '\n   reason: ' + (v.reason || '(无)');
    }).join('\n');
    return '你是 IB 的 Character Integrity Rewriter。你的任务**不是**重新回答用户，'
      + '而是把【候选回复】按【需要修正的 violation】做**最小改写**。\n'
      + '必须保留：原意、信息量、事实内容、对用户请求的完成度、当前对话任务；保留原回复的语言风格与表达习惯。\n'
      + '只允许修正：下面列出的 violation。\n'
      + '严禁：增加剧情/新事实/新记忆；编造 Memory；修改事实答案；修改用户要求；修改工具结果；'
      + '为了"像角色"而降低答案正确性；把角色统一改写成温柔/礼貌/文学化的同一种风格；'
      + '输出解释、前言、markdown 代码块或任何标签。\n'
      + '若无法在不改变原意的前提下修正，则原样返回原回复。\n'
      + '【角色证据】\n' + _ciEvidenceBlock(ev) + '\n\n'
      + '【最近对话】\n' + _ciDialogueBlock(ev) + '\n\n'
      + '【当前用户消息】\n' + (ev.userMessage || '(无)') + '\n\n'
      + '【需要修正的 violation】\n' + (vs || '(无)') + '\n\n'
      + '【候选回复】\n' + candidate + '\n\n'
      + '只输出 JSON：{"reply":"改写后的完整回复"}';
  }

  /* —— 单次模型调用（复用 astra 层唯一网络边界；失败返回结构化原因）——
     P21：consumer 只用于 reasoning 观测归因；思考深度走 canonical 配置（auto → 不写字段）。 */
  async function _ciCall(prompt, schema, schemaName, maxTokens, timeoutMs) {
    try {
      var r = await ASTRA.middleBrainModelCall([{ role: 'user', content: prompt }], {
        maxTokens: maxTokens, jsonMode: true, schema: schema, schemaName: schemaName,
        timeoutMs: (timeoutMs != null ? Number(timeoutMs) : MB_CI_TIMEOUT_MS),
        consumer: 'middle_brain.integrity'
      });
      return r || { ok: false, error: 'error' };
    } catch (e) { return { ok: false, error: 'error' }; }
  }

  /* —— 重写结果净化：防止"自由发挥/漂移/注入控制标签" —— */
  function _mbCiSanitizeRewrite(reply, original) {
    var r = _ciStr(reply).trim();
    if (!r) return { ok: false, reason: 'empty' };
    if (_mbCiHasControlTags(r)) return { ok: false, reason: 'control_tags' };
    var olen = _ciStr(original).trim().length;
    if (olen > 60 && r.length < olen * 0.3) return { ok: false, reason: 'too_short' };
    if (r.length > olen * 2.5 + 200) return { ok: false, reason: 'too_long' };
    return { ok: true, reply: r };
  }

  /* —— 系统裁定状态组装（P11-2B；纯函数，可确定性单测）—————————————
     输入 = 内部已有的区别信息（ran / report / gate / rewrite / judgeError），输出 =
     一个显式的、下游可读的裁定状态。它**不是**第二个判定：不引入新的阈值/概率，
     只把"系统到底有没有拿到 verdict"这件事从隐式约定（judgeError != null）变成显式值。

     关键不变式（对应 P11-2B 的契约要求）：
       · PASS / OOC 只能来自合法 parsed Judge report（report.pass === true / false）；
       · timeout / 传输失败 / malformed / 证据组装异常 → UNDECIDED，reason 保留原因；
       · 有意不调用 Judge → BYPASSED（与 UNDECIDED 是不同事实，不得互相吞并）；
       · pass 只在有真实 verdict 时是 boolean，否则一律 null（绝不 coercion 成 false）；
       · 无 verdict 时 report / violations / maxSeverity 一律 null，绝不变成 [] / 0。 */
  function _mbCiOutcome(out) {
    out = out || {};
    var reply = typeof out.reply === 'string' ? out.reply : '';
    var report = out.report || null;
    var real = !!report && typeof report.pass === 'boolean';
    var verdict, reason, pass;
    if (real) {
      verdict = report.pass === true ? MB_CI_VERDICT.PASS : MB_CI_VERDICT.OOC;
      /* reason：真实 verdict 下它不承担「有没有判定」的职责（那是 verdict / pass 的职责），
         只承载 gate 给出的**决策理由** —— 于是 OOC 的几种结局（已改写 / 被拦下 /
         无报告 / 已用过）都能由 reason + rewritten 读出，而不是从文本变化去猜。 */
      reason = report.pass === true ? null : ((out.gate && out.gate.reason) || null);
      pass = report.pass === true;
    } else if (out.judgeError) {
      verdict = MB_CI_VERDICT.UNDECIDED; reason = _ciStr(out.judgeError) || 'judge_error'; pass = null;
    } else if (out.ran === true) {
      /* ran=true 且无 report 且无 judgeError → 只可能是 malformed */
      verdict = MB_CI_VERDICT.UNDECIDED; reason = 'malformed'; pass = null;
    } else {
      verdict = MB_CI_VERDICT.BYPASSED; reason = _ciStr(out.skipReason) || 'bypassed'; pass = null;
    }
    return {
      reply: reply,                  /* 本层解析出的最终文本（失败 = 原候选，与旧行为逐字一致） */
      verdict: verdict,
      reason: reason,
      pass: pass,                    /* 无 verdict → null（绝不是 false） */
      ran: out.ran === true,
      gate: out.gate || null,
      rewritten: !!(out.rewrite && typeof out.rewrite.reply === 'string'),
      report: report,
      violations: real && Array.isArray(report.violations) ? report.violations : null,
      maxSeverity: real && report.maxSeverity != null ? report.maxSeverity : null,
      judgeError: out.judgeError || null,
      verify: out.verify || null,
      evidence: out.evidence || null
    };
  }
  /* 每轮收口：内部 out → 显式裁定状态（同时计数）。integrity 层唯一出口处使用。 */
  function middleBrainIntegrityOutcome(out) { return _ciVerdict(_mbCiOutcome(out)); }

  /* ── P11-2C · 副作用闸门（下游安全边界）────────────────────────────────
     问题：一个**没有 verdict** 的回复，能不能触发副作用？

     这是四态契约的下游政策，不是第五个状态：裁定状态仍只由 _mbCiOutcome 产生。
     本函数唯一的职责是把「本轮裁定状态」翻译成「本轮允许不允许执行模型生成的副作用」。

     输入是**显式裁定状态**。闸门不读 reply、不看 candidate 是否相同、不看是否存在
     judgeError、不做字符串判断 —— 这些反推方式全部被禁止（它们正是 P11-2B 消灭的
     不确定性）。调用方必须把 verdict 交进来，不交就得不到保护。

     决策表（四态全覆盖，只有 UNDECIDED 被拦）：
       PASS       allow  —— 已判定没有越界，保持既有全部行为
       OOC        allow  —— 保持既有行为（改写已在 integrity 层发生；此处不做二次判定）
       UNDECIDED  block  —— 尝试过但没拿到 verdict：回复可以展示，但**不得执行**
                            由它解析出的副作用指令
       BYPASSED   allow  —— 有意不调用（未启用/语音面/无可见文本/未就绪）= 存量行为，
                            本阶段明确保持，不改
       null/unknown allow —— **仅在拿不到任何状态时**（Middle Brain 未启用 / 未装配 /
                            适配层不可达）。这是显式的 fail-open，理由有二：
                            一、它就是改动前的事实（未启用时副作用一直照常执行）；
                            二、闸门是安全边界，但"不知道"不等于"已知不安全"。
                            绝不允许把未知伪装成某个已知态。 */
  function _mbCiSideEffectPolicy(verdict) {
    var v = _ciStr(verdict).trim().toUpperCase();
    _mbCiTurnIdentity(v);
    if (!v) return { allow: true, verdict: null, reason: 'no_state' };
    if (v === MB_CI_VERDICT.PASS) return { allow: true, verdict: v, reason: 'pass' };
    if (v === MB_CI_VERDICT.OOC) return { allow: true, verdict: v, reason: 'ooc' };
    if (v === MB_CI_VERDICT.BYPASSED) return { allow: true, verdict: v, reason: 'bypassed' };
    if (v === MB_CI_VERDICT.UNDECIDED) return { allow: false, verdict: v, reason: 'unadjudicated' };
    /* 未知字符串不属于四态 —— 绝不当作 PASS。按 fail-open 处理，但如实标出来。 */
    return { allow: true, verdict: null, reason: 'unknown_verdict' };
  }
  /* P11-2D · 闸门 + 抑制记录（唯一读取入口）。
     `category` / `count` 由**调用方**在"该副作用指令确实存在、原本将要执行"的位置提供 ——
     闸门自身不解析文本，也不判断有没有指令（那正是它禁止做的事）：
     把这一事实交给已经解析过 ops 的调用方，是"不推断"原则的延续。
     不传 category（P11-2C 的既有调用方）时行为与当时逐字一致：只回答 allow，不记录。
     verdict 为 null（拿不到状态）时同样不记录 —— fail-open 不是"抑制"。 */
  function middleBrainSideEffectAllowed(verdict, category, count) {
    var d = _mbCiSideEffectPolicy(verdict);
    if (d.allow === false) _mbCiSuppress(category, count);
    return d.allow === true;
  }
  /* ── P11-2I · "不在裁定管线内"的唯一判据（稳定枚举）────────────────────
     P0 审计的结果是一条**事实**，不是一条新政策：存在若干路径，它们从模型回复里
     解析出真正的写入指令并执行，却从来不经过任何裁定 —— 因此它们既没有 verdict，
     也没有任何观测记录，在所有 trace 面上都是不可见的。

     本枚举让那句事实**可被断言**：这些路径必须在 trace 里自称
     `outside_adjudication`，于是"哪条路径在没有裁定的情况下产生了副作用"
     成为一条查询，而不是一句注释。

     刻意**不**把它们的值纳入 MB_CI_SIDE_EFFECT_SITES：那张表登记的是"闸门位置"
     （4 个决策点），而这里登记的是"没有闸门的位置" —— 两者是互补的两个集合，
     混在一张表里会让"有没有闸门"再也无法从表本身读出来。 */
  var MB_CI_OUTSIDE_ADJUDICATION = 'outside_adjudication';

  /* ── P11-2F · 群聊记忆写入政策（**纯分类器**，无 IO、无状态、无副作用）──────
     背景（先读 P11-2C 的既有边界，本阶段**没有**改变它）：
       MB_CI_SIDE_EFFECT_SITES 只登记单聊回合解析出的副作用；群聊/博客留言等
       路径**拿不到 verdict**，属存量行为。因此群聊的 mem_* 既不经过裁定，
       也不经过闸门 —— 但"没有闸门"不等于"没有政策"。

     存储事实（本政策据此成立，不是推测）：
       `_execMemOps(ops, cfg, authorName)` 的每一条写入都落
       `{friendId: cfg.id}`（autoMemory store），而群聊逐成员发言时 cfg 恒为
       **该发言成员自己的角色配置**。于是"角色 A 的私有记忆"与"角色 B 的私有
       记忆"在存储层就是两个 friendId，不存在能被 <mem_*> 表达的跨角色寻址：
       协议词汇表只有 create/update/delete 三种 kind，且 update/delete 的 id
       还要过 `ex.friendId !== cfg.id` 校验（见 auto-memory.js `_execMemOps`）。
       共享群记忆另走 `chatSummaries`（按 groupId 存储），与 autoMemory 不重叠。

     本函数的职责**只是把上面这段事实变成可执行、可断言的判据**，让"哪天有人
     把群对象当 cfg 传进来"这种退化在测试里立刻变红，而不是靠注释维持。

     四种 scope（**纯枚举，绝不是身份** —— 群聊没有、也不该有身份令牌）：
       session         本轮会话上下文，不落长期记忆 → 拒
       private_role    发言成员自己的私有长期记忆（唯一可写目标）
       group_shared    共享群记忆（本阶段不存在群侧写入路径 → 拒，如实报出）
       hidden_system   系统内部记忆 → 拒（不存在调用方，纯前瞻）

     判定顺序刻意如此：**先认 scope 合法性，再看裁定状态**。scope 非法时无论
     有没有 verdict 都必须拒 —— 一个"已判定"的越界写入仍然是越界写入。 */
  var MB_GROUP_MEMORY_SCOPE = Object.freeze({
    SESSION: 'session',
    PRIVATE_ROLE: 'private_role',
    GROUP_SHARED: 'group_shared',
    HIDDEN_SYSTEM: 'hidden_system'
  });
  /* 群聊唯一允许的写入目标。 */
  var MB_GROUP_MEMORY_WRITABLE_SCOPE = MB_GROUP_MEMORY_SCOPE.PRIVATE_ROLE;
  /* 群聊记忆写入的拒止原因（稳定枚举；永远不携带正文 / id / 路径）。 */
  var MB_GROUP_MEMORY_DENY = Object.freeze({
    OUT_OF_SCOPE: 'out_of_scope',        /* scope 不是 private_role */
    UNKNOWN_KIND: 'unknown_kind',        /* 不是 create/update/delete 之一 */
    NO_CHARACTER: 'no_character',        /* 拿不到发言角色的私有记忆域 */
    GROUP_AS_CHARACTER: 'group_as_character', /* cfg.id 是 group_* —— 会把私有记忆
                                                 塌缩成群共享桶（本函数存在的首要理由） */
    UNAVAILABLE: 'policy_unavailable'    /* 政策本体不可用（调用方缺失） */
  });
  /* `kind` 允许值 —— 与 auto-memory.js `_parseMemOps` 的正则捕获组**逐字同源**。
     刻意在本地重声明而不 import：integrity 层不依赖 UI 层的解析实现，两者由
     test_p11_2f 的 K1 断言锁成同一集合。 */
  var _MB_GROUP_MEM_OPS = Object.freeze(['create', 'update', 'delete']);
  function _mbGroupMemScopeOf(scope) {
    var s = _ciStr(scope).trim();
    return s;
  }
  /* 判定：模型提出的群聊记忆变更可否落地。
     返回 { allowed, policyDecision, blockedReason, scope, category }
       policyDecision: 'allow' | 'deny' | 'unverified'
         allow      —— scope 合法 + 本回合裁定为 PASS/OOC/BYPASSED（或无 verdict 可问）
         deny       —— scope 非法 / kind 未知 / 无角色域（**逐字给出 blockedReason**）
         unverified —— scope 合法，但本回合裁定为 UNDECIDED（"尝试过但没拿到裁定"）
     注意 unverified 时 allowed 仍为 true：**本阶段不改变群聊既有执行行为**
     （群聊本来就不经过裁定），只把这一事实如实标出来，供下游与测试消费。
     是否真的拦截由调用方决定，且调用方必须把 allowed=false 当作拦截。 */
  function middleBrainGroupMemoryPolicy(verdict, scope, kind, characterId) {
    var s = _mbGroupMemScopeOf(scope);
    var k = _ciStr(kind).trim().toLowerCase();
    var cid = _ciStr(characterId).trim();
    function deny(reason) {
      return { allowed: false, policyDecision: 'deny', blockedReason: reason, scope: s, category: null };
    }
    if (s !== MB_GROUP_MEMORY_SCOPE.PRIVATE_ROLE) return deny(MB_GROUP_MEMORY_DENY.OUT_OF_SCOPE);
    if (_MB_GROUP_MEM_OPS.indexOf(k) < 0) return deny(MB_GROUP_MEMORY_DENY.UNKNOWN_KIND);
    if (!cid) return deny(MB_GROUP_MEMORY_DENY.NO_CHARACTER);
    /* 群 id 冒充角色域 → 所有成员的私有记忆会写进同一个 friendId。
       头部与 assets/js/chat-core.js `isGroupFriendId` 同一判据（group_ 前缀）。 */
    if (cid.indexOf('group_') === 0) return deny(MB_GROUP_MEMORY_DENY.GROUP_AS_CHARACTER);
    var d = _mbCiSideEffectPolicy(verdict);
    return {
      allowed: true,
      policyDecision: d.allow === false ? 'unverified' : 'allow',
      blockedReason: null,
      scope: s,
      category: d.allow === false ? 'unadjudicated' : d.reason
    };
  }
  /* 政策本体的可用性自述（调用方 fail-closed 用；本身不做判定）。 */
  function middleBrainGroupMemoryPolicyAvailable() { return true; }

  /* ====================================================================
     主入口：Character Integrity Guard
     返回 {reply, ran, report, gate, rewrite, verify, judgeError, skipReason}
       · reply 永远是可用的字符串（失败 = 原候选）；
       · skipReason 只在**有意不调用 Judge**时写入（BYPASSED 的机器可读原因）；
       · 是否真的拿到 verdict 由 _mbCiOutcome 显式表达，调用方不再需要凭
         judgeError != null / reply === candidate 去推断（P11-2B）。
     ==================================================================== */
  async function middleBrainCharacterIntegrity(characterId, userMessage, candidate, opts) {
    opts = opts || {};
    var out = { reply: candidate, ran: false, report: null, gate: null, rewrite: null, verify: null, judgeError: null, evidence: null };
    /* _ciSkip 与 skipReason 同时写：前者是既有 telemetry 契约，后者是显式状态来源 */
    function skip(reason) { out.skipReason = reason; _ciSkip(reason); }
    try {
      if (typeof candidate !== 'string' || !candidate.trim()) { skip('empty_candidate'); return middleBrainIntegrityOutcome(out); }
      var cfg = await CFG.getMiddleBrainConfig();
      /* ① 默认关闭：零模型调用（Guard OFF 与 P11-1C 等价） */
      if (!(cfg && cfg.characterIntegrityEnabled === true)) {
        skip('disabled'); return middleBrainIntegrityOutcome(out);
      }
      _mbCiTelemetry.checked++;
      /* ② 范围：本阶段只接 single-chat 文本轮；voice 轮不接（改写会与已播报的语音失配） */
      if (opts.voice === true) { skip('voice_surface'); return middleBrainIntegrityOutcome(out); }
      /* ③ 无 Astra 就绪 → 不发起任何请求（增强层不得成为聊天单点故障） */
      if (!(await CFG.middleBrainReady())) { skip('astra_not_ready'); return middleBrainIntegrityOutcome(out); }
      var visible = _mbCiVisibleText(candidate);
      if (!visible) { skip('no_visible_text'); return middleBrainIntegrityOutcome(out); }
      var controlTags = _mbCiHasControlTags(candidate);
      var evidence = _mbCiBuildEvidence(characterId, userMessage, opts);
      out.evidence = evidence;
      out.ran = true;

      /* ④ Judge：整轮最多一次 */
      var t0 = Date.now();
      var jr = await _ciCall(_mbCiJudgePrompt(evidence, visible), MB_CI_SCHEMA, 'character_integrity_report', MB_CI_JUDGE_MAX_TOKENS, opts.judgeTimeoutMs);
      var jlat = Date.now() - t0;
      _mbCiTelemetry.judgeRuns++; _mbCiTelemetry.judgeLatencyMs += jlat;
      if (!jr.ok) {
        _mbCiTelemetry.judgeError++; out.judgeError = jr.error;
        skip('judge_' + jr.error); _ciLast({ judgeRan: true, judgeResult: 'error', judgeError: jr.error, judgeLatencyMs: jlat });
        return middleBrainIntegrityOutcome(out);
      }
      var report = _mbParseCiJson(jr.content);
      if (!report) {
        _mbCiTelemetry.judgeMalformed++;
        skip('judge_malformed'); _ciLast({ judgeRan: true, judgeResult: 'malformed', judgeLatencyMs: jlat });
        return middleBrainIntegrityOutcome(out);
      }
      out.report = report;
      var th = _mbCiThresholds(cfg);
      if (report.pass === true && report.score > th.failBelow) {
        _mbCiTelemetry.judgePass++;
        _ciLast({ judgeRan: true, judgeResult: 'pass', score: report.score, confidence: report.confidence, maxSeverity: report.maxSeverity, judgeLatencyMs: jlat, rewriteTriggered: false });
        return middleBrainIntegrityOutcome(out);
      }
      _mbCiTelemetry.judgeFail++;

      /* ⑤ Gate：只有强 OOC 才重写 */
      var gate = _mbCiGate(report, cfg, { controlTags: controlTags, rewriteUsed: false });
      out.gate = gate;
      _ciLast({
        judgeRan: true, judgeResult: 'fail', score: report.score, confidence: report.confidence,
        maxSeverity: report.maxSeverity, dimensions: report.dimensions, judgeLatencyMs: jlat,
        gateReason: gate.reason, rewriteTriggered: false
      });
      if (!gate.rewrite) { _mbCiTelemetry.rewriteSkipped++; skip('gate_' + gate.reason); return middleBrainIntegrityOutcome(out); }

      /* ⑥ Targeted rewrite：每条候选最多一次（无循环、无二次 judge→rewrite） */
      _mbCiTelemetry.rewriteTriggered++;
      _mbCiTelemetry.maxRewritesPerTurn = Math.max(_mbCiTelemetry.maxRewritesPerTurn, 1);
      var t1 = Date.now();
      var rr = await _ciCall(_mbCiRewritePrompt(evidence, candidate, report), MB_CI_REWRITE_SCHEMA, 'character_integrity_rewrite', MB_CI_REWRITE_MAX_TOKENS, opts.rewriteTimeoutMs);
      var rlat = Date.now() - t1;
      _mbCiTelemetry.rewriteLatencyMs += rlat;
      if (!rr.ok) {
        _mbCiTelemetry.rewriteError++;
        skip('rewrite_' + rr.error); _ciLast({ rewriteTriggered: true, rewriteOk: false, rewriteError: rr.error, rewriteLatencyMs: rlat });
        return middleBrainIntegrityOutcome(out);
      }
      var raw = _mbParseCiRewriteJson(rr.content);
      if (raw == null) {
        _mbCiTelemetry.rewriteError++;
        skip('rewrite_malformed'); _ciLast({ rewriteTriggered: true, rewriteOk: false, rewriteError: 'malformed', rewriteLatencyMs: rlat });
        return middleBrainIntegrityOutcome(out);
      }
      var san = _mbCiSanitizeRewrite(raw, candidate);
      if (!san.ok) {
        _mbCiTelemetry.rewriteError++;
        skip('rewrite_' + san.reason); _ciLast({ rewriteTriggered: true, rewriteOk: false, rewriteError: san.reason, rewriteLatencyMs: rlat });
        return middleBrainIntegrityOutcome(out);
      }
      out.reply = san.reply;
      out.rewrite = { reply: san.reply, latencyMs: rlat };
      _mbCiTelemetry.rewriteOk++;
      _ciLast({ rewriteTriggered: true, rewriteOk: true, rewriteLatencyMs: rlat, changed: san.reply !== candidate });

      /* ⑦ Optional verify：只观测。无论结果如何都**不得**触发第二次 rewrite。 */
      if (cfg.characterIntegrityVerify === true) {
        var vr = await _ciCall(_mbCiJudgePrompt(evidence, _mbCiVisibleText(san.reply)), MB_CI_SCHEMA, 'character_integrity_report', MB_CI_JUDGE_MAX_TOKENS, opts.judgeTimeoutMs);
        if (!vr.ok) { _mbCiTelemetry.verifyError++; out.verify = { ok: false, error: vr.error }; }
        else {
          var vrep = _mbParseCiJson(vr.content);
          if (!vrep) { _mbCiTelemetry.verifyError++; out.verify = { ok: false, error: 'malformed' }; }
          else {
            _mbCiTelemetry.verifyRuns++;
            if (vrep.pass === true) _mbCiTelemetry.verifyPass++; else _mbCiTelemetry.verifyFail++;
            out.verify = { ok: true, pass: vrep.pass, score: vrep.score, maxSeverity: vrep.maxSeverity };
          }
        }
        _ciLast({ verify: out.verify || null });
      }
      return middleBrainIntegrityOutcome(out);
    } catch (e) {
      /* 任何未预期异常 → 原候选（绝不因 Guard 失败而丢回复）；只记短错误串，不记上下文内容 */
      skip('guard_error');
      /* 未预期异常 = 基础设施失败，不是"有意不判"：显式归入 UNDECIDED，
         绝不允许它退化成看起来正常的 BYPASSED / PASS（P11-2B）。 */
      out.judgeError = 'guard_error';
      _ciLast({ guardError: _ciCap(String(e && e.message || e), 160) });
      return middleBrainIntegrityOutcome(out);
    }
  }

  /* —— layer contract（P11-2）：integrity 层唯一出口，冻结后下游只读 —— */
  MBC.integrity = Object.freeze({
    middleBrainCharacterIntegrity: middleBrainCharacterIntegrity,
    middleBrainCharacterIntegrityTelemetry: middleBrainCharacterIntegrityTelemetry,
    middleBrainCharacterIntegrityReset: middleBrainCharacterIntegrityReset,
    /* P11-2B：系统裁定状态契约（只读；下游按值判定，不再靠文本是否变化推断） */
    middleBrainIntegrityOutcome: middleBrainIntegrityOutcome,
    MB_CI_VERDICT: MB_CI_VERDICT,
    /* P11-2C：下游副作用政策（唯一决策点；调用方按值判定，禁止自行推断可信度） */
    middleBrainSideEffectAllowed: middleBrainSideEffectAllowed,
    _mbCiSideEffectPolicy: _mbCiSideEffectPolicy,
    MB_CI_SIDE_EFFECT_SITES: MB_CI_SIDE_EFFECT_SITES,
    /* P11-2F：群聊记忆写入政策（纯分类器）+ 冻结枚举；群聊路径的唯一判据来源 */
    middleBrainGroupMemoryPolicy: middleBrainGroupMemoryPolicy,
    middleBrainGroupMemoryPolicyAvailable: middleBrainGroupMemoryPolicyAvailable,
    MB_GROUP_MEMORY_SCOPE: MB_GROUP_MEMORY_SCOPE,
    MB_GROUP_MEMORY_WRITABLE_SCOPE: MB_GROUP_MEMORY_WRITABLE_SCOPE,
    MB_GROUP_MEMORY_DENY: MB_GROUP_MEMORY_DENY,
    /* P11-2I：不在裁定管线内的模型派生副作用路径的稳定标记（观测面用语，
       不是第五个裁定态 —— 裁定状态仍只由 _mbCiOutcome 产生） */
    MB_CI_OUTSIDE_ADJUDICATION: MB_CI_OUTSIDE_ADJUDICATION,
    /* P11-2D：抑制类别词表 + 抑制记录读取（只读快照；写入只由闸门内部完成） */
    MB_CI_SUPPRESSION_CATEGORIES: _MB_CI_SUPPRESSION_CATEGORIES,
    middleBrainSideEffectSuppression: middleBrainSideEffectSuppression,
    _mbCiOutcome: _mbCiOutcome,
    _mbParseCiJson: _mbParseCiJson,
    _mbParseCiRewriteJson: _mbParseCiRewriteJson,
    _mbCiGate: _mbCiGate,
    _mbCiVisibleText: _mbCiVisibleText,
    _mbCiHasControlTags: _mbCiHasControlTags,
    _mbCiBuildEvidence: _mbCiBuildEvidence,
    _mbCiJudgePrompt: _mbCiJudgePrompt,
    _mbCiRewritePrompt: _mbCiRewritePrompt,
    _mbCiSanitizeRewrite: _mbCiSanitizeRewrite,
    _mbCiSensitivity: _mbCiSensitivity,
    MB_CI_SCHEMA: MB_CI_SCHEMA,
    MB_CI_REWRITE_SCHEMA: MB_CI_REWRITE_SCHEMA,
    MB_CI_TIMEOUT_MS: MB_CI_TIMEOUT_MS,
    MB_CI_SENSITIVITY: MB_CI_SENSITIVITY,
    MB_CI_DIMENSIONS: MB_CI_DIMENSIONS
  });
})(typeof self !== 'undefined' ? self : globalThis);
