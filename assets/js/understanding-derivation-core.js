/* ====================================================================
   IB Understanding Derivation Core — Understanding 派生的**唯一**共享实现
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/understanding-derivation-core.js">
              → window.IBUnderstandingDerivation
              （必须在 auto-memory.js / active-diary.js / understanding-authority.js 之前加载）
   - Node   : require('../assets/js/understanding-derivation-core.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 fetch / 零定时器 / 无副作用 / 纯函数。

   为什么存在（M1-C.2m）：
   M1-C.2l 判定 `<understanding>` 的 canonical authority 必须搬到 Home Node，
   并且**唯一写者必须对同一证据超集派生**。若只搬"写"而不搬"规则"，
   两端就会各持一份 admission / 提示词 / 证据准入的实现 —— 一个写者、
   两套派生，与本阶段要消灭的缺陷同形（见 M1-C.2l §10、M1-C.2k 的判据）。

   因此本模块是理解派生规则的**唯一实现**，供：
     ① 桌面 `_calibrateMemoryCandidate`（准入数值：它此前是唯一实现）
     ② 桌面 `_understandingTick`（提示词 / 证据准入 / 印章 / shouldUpdate 判定）
     ③ Home Node `understanding-derivation.js`（同一个 tick，同一个规则）
     ④ Home Node `understanding-retrieval.js`（渲染契约由 understanding-context 部分给出）
   四处共用，从而在结构上排除"第二套派生规则"。

   ── 与 memory-visibility-core 的分工（刻意复用，不发明第二套）──────────
   可见性语义仍然只有 memory-visibility-core 一份。本模块**不**自带 ACL，
   而是要求调用方传入已经过滤好的候选集 / 证据行（桌面用 `_memDerivationCandidates`，
   Home Node 用 `core.filterDerivationCandidates`），两边是同一个核心函数。

   ── 本模块**不**决定的事 ───────────────────────────────────────────────
   · 不选 store、不写盘、不分配 revision（那是 understanding-store.js 的契约）；
   · 不决定何时跑（那是水位线 / 调度器的事）；
   · 不做模型调用（那是各宿主的 model port）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBUnderstandingDerivation = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 契约常量（词表必须与既有浏览器实现逐字一致，否则历史行读不回来）── */
  var U_HISTORY_CAP = 20;
  var U_DIMENSIONS = ['values', 'habits', 'identity', 'relationship', 'preferences', 'context'];
  /* 注意：'ai_inference' 是 **basis 词表**成员，但不在 U_BASIS_ACCEPTED 里 ——
     它由模型输出、由 conviction 上限约束，历史行里确实存在，因此必须能往返。 */
  var U_BASIS = ['user_stated', 'user_corroborated', 'ai_inference', 'ai_guess'];
  var U_EVIDENCE_SIM_THRESHOLD = 0.5;
  var U_CONTENT_MAX = 500;
  var U_EVIDENCE_MAX = 50;

  /* ── 文本规范化 + 相似度（与 thread-derivation-core 同源，逐行等价）────
     真实来源是 active-diary.js 的 `_activeTextSimilarity`；这里保留一份**等价**实现，
     因为 Node 侧没有 active-diary.js。调用方可以显式传 sim 覆盖（浏览器就传
     `window._activeTextSimilarity`），从而保证两端用的是**同一个函数对象**。 */
  function textKey(text) {
    return String(text || '').toLowerCase().replace(/<[^>]*>/g, '').replace(/[\s\p{P}\p{S}]+/gu, '');
  }
  function textSimilarity(a, b) {
    var x = textKey(a), y = textKey(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
    var grams = function (s) {
      var out = new Set();
      for (var i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
      return out;
    };
    var gx = grams(x), gy = grams(y), overlap = 0;
    gx.forEach(function (g) { if (gy.has(g)) overlap++; });
    return (2 * overlap) / (gx.size + gy.size);
  }

  function scoreOf(v, fallback) {
    var n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
  }
  function reasonsOf(v) {
    if (typeof v === 'string') v = v.split(/\n|[；;]/);
    if (!Array.isArray(v)) return [];
    return v.map(function (x) {
      return String(x || '').replace(/^[\s✓✔•\-]+/, '').trim();
    }).filter(Boolean).slice(0, 3);
  }
  /* 关键词命中计数（沿用 memory.js `_extractKeywords` 的输出 + `_amScore` 的算法）。
     提取器本身依赖中文停用词表，仍留在浏览器（memory.js）；这里只做计分，
     因此两端对同一段文本给出同一个数。 */
  function scoreKeywordHits(content, keywords) {
    if (!keywords || !keywords.length) return 0;
    var low = String(content || '').toLowerCase();
    var s = 0;
    for (var i = 0; i < keywords.length; i++) {
      var k = keywords[i];
      if (k && low.indexOf(String(k).toLowerCase()) >= 0) s++;
    }
    return s;
  }
  function keywordThreshold(keywords) {
    var n = Array.isArray(keywords) ? keywords.length : 0;
    return Math.max(2, Math.ceil(n * 0.09));
  }

  /* ── 证据独立性：evidenceIds 中**语义不同**的记忆条数 ────────────────
     只信任传入的 memories（evidence 只能指向 memories，见 M1-C.2l §Q11）。
     近重复（相似度 ≥ 阈值）算同一事实，不凑数 —— 否则模型可以靠两条同义
     记忆绕过"≥2 条独立证据"的准入。 */
  function distinctEvidenceCount(evidenceIds, memories, options) {
    options = options || {};
    var sim = typeof options.sim === 'function' ? options.sim : textSimilarity;
    var threshold = options.threshold != null ? Number(options.threshold) : U_EVIDENCE_SIM_THRESHOLD;
    var ids = Array.isArray(evidenceIds) ? evidenceIds : [];
    if (!ids.length) return 0;
    var all = Array.isArray(memories) ? memories : [];
    var texts = [];
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i]);
      var m = null;
      for (var j = 0; j < all.length; j++) {
        if (all[j] && String(all[j].id) === id) { m = all[j]; break; }
      }
      if (!m) continue;
      var t = String((m.title || '') + ' ' + (m.content || '') + ' ' + (m.summary || '')).toLowerCase();
      if (t) texts.push(t);
    }
    if (!texts.length) return 0;
    /* 贪心分组：每遇一条与已收组内任何一条 ≥ 阈值 → 归并（同一事实） */
    var groups = [];
    for (var k = 0; k < texts.length; k++) {
      var t2 = texts[k], merged = false;
      for (var g = 0; g < groups.length; g++) {
        if (sim(t2, groups[g].text) >= threshold) { groups[g].pool.push(t2); groups[g].text = t2; merged = true; break; }
      }
      if (!merged) groups.push({ text: t2, pool: [t2] });
    }
    return groups.length;
  }

  /* ── 准入（数值）：与既有 `_calibrateMemoryCandidate` 逐行等价 ─────────
     inputs:
       content, confidence, reasons, basis, operation, targetStore, category,
       priority, createdByUser, priorityNever, repeatCount, distinctEvidence
     adpt:
       extractKeywords(text) → string[]   （浏览器传 memory.js 的 _extractKeywords）
       lookupEntries(targetStore, cfg) → Promise<entries[]>（重复计数用）
     返回 {confidence, reasons, repeatCount, distinctEvidence, rejected?}

     **刻意保留的一处既有语义**：`if (!explicit && !future) heuristic -= 8;`
     在既有实现里写的是 `!repeats`，而 repeats 在那一刻恒为真（短路保证非 0），
     因此该减分项**从不生效**。本模块逐字保留该行为（改写会改变所有普通记忆的
     confidence 数值），并在 M1-C.2l 的 deferred 清单里记录，不在本阶段"顺手修"。 */
  async function calibrate(inputs, adpt) {
    inputs = inputs || {};
    adpt = adpt || {};
    var content = String(inputs.content || '');
    var reasonList = reasonsOf(inputs.reasons);
    var reasonText = reasonList.join(' ');
    var evidence = (content + ' ' + reasonText).toLowerCase();
    var explicit = /(主动|明确|亲口|直接表达|反复强调|要求记住|偏好|喜欢|习惯|身份|职业|称呼|i prefer|i like|remember that)/i.test(evidence);
    var future = /(未来|长期|偏好|习惯|身份|职业|称呼|沟通方式|交互|推荐|体验|指令|边界|目标|工作流|workflow|preference|habit|identity)/i.test(evidence);
    var temporary = /(仅这次|一次性|临时|暂时|今天|今晚|刚刚|玩笑|随口|当前情绪|一时|马上|待会|temporary|just this once|joke)/i.test(evidence);
    var correction = /(更正|纠正|已经改变|不再|过时|更新为|应改为|错误|撤回|忘记|删除|obsolete|outdated|incorrect)/i.test(evidence);
    /* Understanding 专属：人格定性 / 心理类 越界拒止 */
    var personality = /(她|他|你|TA|它)?\s*(就是|本质上是|天生是|一直是).{0,10}(型人|的人|性格|人格)|(她|他|你|TA).{0,6}是个.{0,8}(焦虑|抑郁|内向|外向|自恋|偏执|依赖型|回避型)|intrinsically|is by nature/i.test(evidence);
    var psych = /(抑郁|抑郁症|焦虑症|双相|人格障碍|自恋型|边缘型|创伤后应激|ptsd|惊恐障碍)/i.test(evidence);

    var repeats = Number(inputs.repeatCount);
    if (!isFinite(repeats)) repeats = await repeatCount(inputs, adpt);
    repeats = Math.max(0, Math.min(5, Math.trunc(repeats)));

    var basis = reasonsOf(inputs.basis)[0] || inputs.basis || 'ai_guess';

    if (inputs.operation === 'understanding') {
      var evIds = Array.isArray(inputs.evidenceIds) ? inputs.evidenceIds : (inputs.evidenceIds ? [inputs.evidenceIds] : []);
      /* 心理类：仅 user_stated / user_corroborated 放行；ai_inference / ai_guess 一律拒 */
      if (psych && (basis === 'ai_inference' || basis === 'ai_guess')) {
        return { confidence: 0, reasons: ['心理健康类理解仅允许用户自述/旁证，禁止AI推断'], repeatCount: repeats, rejected: 'psych-inference' };
      }
      /* 人格定性：ai_inference 且 repeats<2 → 拒（去定性化） */
      if (personality && basis === 'ai_inference' && repeats < 2) {
        return { confidence: 0, reasons: ['人格定性推断需≥2次独立证据，当前证据不足'], repeatCount: repeats, rejected: 'personality-inference' };
      }
      /* 证据≥2 独立来源校验（非用户自述时强制） */
      if (basis !== 'user_stated') {
        var distinct = inputs.distinctEvidence != null
          ? Number(inputs.distinctEvidence)
          : distinctEvidenceCount(evIds, inputs.memories, { sim: adpt.sim });
        if (!(distinct >= 2)) {
          return { confidence: 0, reasons: ['理解需≥2条语义独立的记忆支撑（近重复证据不重复计数）'], repeatCount: repeats, rejected: 'insufficient-evidence', distinctEvidence: distinct };
        }
        inputs = Object.assign({}, inputs, { distinctEvidence: distinct });
      }
    }

    /* ── 普通记忆 create 硬拒：文学化自我感慨 / 观察性抒情 ──────────────── */
    if (inputs.operation === 'create' && inputs.targetStore === 'memories' && !inputs.createdByUser) {
      var fl = lyricFlags(evidence);
      var selfFulfilling = !explicit && !future && repeats < 1;
      if (fl.lyric && selfFulfilling && !temporary) {
        return { confidence: 0, reasons: ['这条记忆属于文学化自我感慨/观察性抒情，缺乏可作为长期事实的明确用户表达、未来价值或重复证据，已拒绝写入'], repeatCount: repeats, rejected: 'lyrical-musing' };
      }
      if (fl.personReflect && selfFulfilling) {
        return { confidence: 0, reasons: ['这条记忆更像角色的自我观察而非关于用户的长期事实，已拒绝写入'], repeatCount: repeats, rejected: 'self-reflective' };
      }
    }

    var heuristic = 35;
    if (explicit) heuristic += 30;
    heuristic += Math.min(24, repeats * 8);
    if (future) heuristic += 18;
    if (inputs.category === 'user_instructions' || inputs.category === 'long_term_background') heuristic += 8;
    if (inputs.priority === 'always') heuristic += 7;
    if (temporary) heuristic -= 25;
    if (inputs.operation === 'update') heuristic += correction ? 14 : -3;
    if (inputs.operation === 'delete') heuristic += correction ? 18 : -12;
    /* 既有语义逐字保留（见上方函数头注释）：repeats 在此时恒 ≥1，故本项从不生效。 */
    if (!explicit && !future) heuristic -= 8;
    heuristic = scoreOf(heuristic, 50);
    var model = scoreOf(inputs.confidence, null);
    var confidence = model == null ? heuristic : Math.round(model * 0.55 + heuristic * 0.45);
    var reasons = reasonList.slice();
    function addReason(s) { if (reasons.length < 3 && reasons.indexOf(s) < 0) reasons.push(s); }
    if (explicit) addReason('用户主动或明确表达了这项信息');
    if (repeats) addReason('相关信息在历史记忆中重复出现 ' + repeats + ' 次');
    if (future) addReason('这会影响未来的互动或个性化回应');
    if (temporary) addReason('内容可能只适用于当前情境，可靠度已下调');
    if (inputs.operation === 'update' && correction) addReason('现有记忆可能已经过时，需要校正');
    if (inputs.operation === 'delete' && correction) addReason('现有记忆可能已失效或被明确撤回');
    if (!reasons.length) addReason(inputs.operation === 'delete' ? 'AI 认为现有记忆可能不再适用' : 'AI 认为这项信息具有后续参考价值');

    var out = scoreOf(confidence, heuristic);
    var unDistinct = null;
    if (inputs.operation === 'understanding') {
      /* conviction 按 basis 上限封顶（user_stated 全高；ai 推断/猜测逐级降） */
      var cap = basis === 'user_stated' ? 100 : (basis === 'user_corroborated' ? 85 : (basis === 'ai_inference' ? 65 : 40));
      out = Math.min(out, cap);
      if (inputs.distinctEvidence != null) unDistinct = Number(inputs.distinctEvidence);
      else if (Array.isArray(inputs.evidenceIds)) {
        unDistinct = distinctEvidenceCount(inputs.evidenceIds, inputs.memories, { sim: adpt.sim });
      }
    }
    return { confidence: scoreOf(out, heuristic), reasons: reasons.slice(0, 3), repeatCount: repeats, distinctEvidence: unDistinct };
  }

  /* ── 重复计数（沿用既有口径：关键词命中 ≥ 阈值即算"重复出现"）─────────
     取回候选条目由 adpt.lookupEntries 提供：桌面是 memories/autoMemory 表，
     Home Node 是 canonical memory store。**同一算法，两个数据源。** */
  async function repeatCount(inputs, adpt) {
    try {
      if (typeof adpt.lookupEntries !== 'function') return 0;
      var entries = await adpt.lookupEntries(inputs.targetStore, inputs.cfg);
      if (!Array.isArray(entries)) return 0;
      var kws = (typeof adpt.extractKeywords === 'function')
        ? adpt.extractKeywords(String(inputs.content || ''))
        : [];
      kws = Array.isArray(kws) ? kws.slice(0, 90) : [];
      if (!kws.length) return 0;
      var threshold = keywordThreshold(kws);
      var count = 0;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e || e.id === inputs.excludeId) continue;
        var text = String((e.title || '') + ' ' + (e.summary || '') + ' ' + (e.content || ''));
        if (scoreKeywordHits(text, kws) >= threshold) count++;
      }
      return Math.min(5, count);
    } catch (e) { return 0; }
  }

  /* 文学化自我感慨 / 自我观察 判定（供 create 硬拒 + 存量审计共用）。 */
  function lyricFlags(text) {
    var ev = String(text || '').toLowerCase();
    return {
      lyric: /(珍惜|感悟|感慨|领悟|重新评估|恒久|永恒|静谧|宁静|温柔|治愈|芬芳|夜空|星河|月光|岁月|时光|生命的意义|看透|释怀|释然|欣慰|心绪|思绪|触动|共鸣|仿佛|宛如|像是|或许人生|也许自己|一种特别的|属于我们的)/i.test(ev),
      personReflect: /(我|自己|彼此|我们)。{0,12}(的|那些|此刻|这般|仿佛)/i.test(ev)
    };
  }

  /* ── 维度 / basis 归一（模型输出不可信，越界值一律落回缺省）─────────── */
  function dimensionOf(v) {
    var s = String(v == null ? '' : v).trim();
    return U_DIMENSIONS.indexOf(s) >= 0 ? s : 'context';
  }
  function basisOf(v) {
    var s = String(v == null ? '' : v).trim();
    return U_BASIS.indexOf(s) >= 0 ? s : 'ai_guess';
  }

  /* ── 提示词构造（**唯一实现**：桌面与 Home Node 必须给出同一段输入）────
     入参：
       charName, relationship, systemPrompt      —— 角色人格/关系（canonical 投影）
       fragments: [{domain,title,content}]        —— canonical 记忆碎片（已过可见性）
       current:   {content,dimension,conviction}  —— 当前理解（可为 null）
       corrections: [{text,basis,at,revision}]    —— **仍生效**的用户更正（可为 null）
     刻意**不含** moments / diary：见 M1-C.2m §5 与 M1-C.2l §Q18 ——
     同一份派生输入必须在任何宿主上都能拿到，否则"一个写者"会变成"两套派生"。 */
  function buildPrompt(input) {
    input = input || {};
    var charName = String(input.charName || 'AI');
    var rel = String(input.relationship || '') || '未设';
    var fragments = Array.isArray(input.fragments) ? input.fragments : [];
    var current = input.current || null;
    var corrections = (Array.isArray(input.corrections) ? input.corrections : []).filter(Boolean);

    var system = String(input.systemPrompt || '').slice(0, 20000)
      + '\n\n你正在为角色「' + charName + '」提炼一份【当前理解】(understanding)——反映"这段时间对这段关系的持续认识"。只输出严格 JSON，不输出其他文字。';

    var lines = [
      '【任务】基于近期碎片，提炼你对「' + charName + '」与用户这段关系当前最稳定的一条理解。若没有可扎根的稳定模式就 shouldUpdate:false。',
      '【角色】' + charName + '；与用户关系：' + rel + '。',
      '【近期碎片】' + (fragments.map(function (m) {
        return '- [' + (m.domain || '记忆') + '] ' + String((m.title || '') + ' ' + String(m.content || m.summary || '')).slice(0, 200);
      }).join('\n') || '（无）')
    ];
    /* 当前理解：让"演进"真的成为演进。没有它，每一轮都从零猜一条，
       历史只存在于磁盘上而不参与推理 —— 那正是 M1-C.2l §Q10 指出的缺陷。 */
    if (current && current.content) {
      lines.push('【当前理解（第 ' + (current.revision != null ? current.revision : '?') + ' 版）】'
        + '维度：' + dimensionOf(current.dimension) + ' · 置信：' + (current.conviction != null ? current.conviction : '') + '%\n- '
        + String(current.content).slice(0, U_CONTENT_MAX));
    }
    /* 用户更正：**durable evidence about the understanding itself**（M1-C.2m §1）。
       必须在提示词里显式出现，否则"下一次后台周期会不会忘记这次更正"
       只能靠模型自己记得 —— 而那正是产品要禁止的。 */
    if (corrections.length) {
      lines.push('【用户已更正的旧判断（**不得**重新提出，除非用户明确再次这样说）】'
        + corrections.map(function (c) {
          var when = c.at ? new Date(Number(c.at)).toISOString().slice(0, 10) : '';
          return '\n- ' + String(c.text || '').slice(0, 300)
            + '（针对第 ' + (c.revision != null ? c.revision : '?') + ' 版' + (when ? '，' + when : '') + '；依据：' + basisOf(c.basis) + '）';
        }).join(''));
    }
    lines.push('【输出格式】{"shouldUpdate":true/false,"content":"1-3句当前理解","basis":"user_stated|user_corroborated|ai_inference","dimension":"values|habits|identity|relationship|preferences|context","evidenceIds":["源id..."],"conviction":0-100}');
    lines.push('【规则】1. 只有稳定模式才 true。2. 不要对心理健康下推断(只记用户自述)。3. 不要人格定性(不写"她是...型人")。4. basis 必须诚实：用户明确说=user_stated；多方一致=user_corroborated；你自己推测=ai_inference。');
    return { system: system, user: lines.join('\n') };
  }

  /* ── 证据准入：模型输出的 evidenceIds **不可信** ──────────────────────
     它既可能指向幻觉 id，也可能指向一条对该角色隐藏的记忆。委托给共享可见性
     核心的 liveEvidenceIds（与桌面 `_memVisibleEvidenceIds` 是同一个函数）。 */
  function visibleEvidenceIds(ids, memories, roleId, visibilityCore) {
    if (!visibilityCore || typeof visibilityCore.liveEvidenceIds !== 'function') return []; /* fail closed */
    return visibilityCore.liveEvidenceIds(
      (Array.isArray(ids) ? ids : []).map(String),
      memories,
      roleId
    );
  }

  /* ── 写时印章（R1 / R6）：来源 = **本制品新旧两版的证据并集** ──────────
     只按本次新证据算，会在"先收窄、后重新派生"时把印章放宽回旧范围。
     无法解析的证据 id 追加一条降级来源 {visibility:undefined}（只可能更窄）。
     核心不可用 → private（fail closed）。 */
  function derivationStamp(sourceRows, roleId, visibilityCore) {
    var rows = (Array.isArray(sourceRows) ? sourceRows : []).filter(Boolean);
    if (!visibilityCore || typeof visibilityCore.deriveVisibility !== 'function') {
      return { visibility: 'private', visibleTo: [String(roleId)], excludeFrom: [] };
    }
    if (!rows.length) return { visibility: 'private', visibleTo: [String(roleId)], excludeFrom: [] };
    return visibilityCore.deriveVisibility(rows, roleId);
  }

  /* ── 逐条记忆 → 提示词碎片（两端同形，避免"同一批记忆渲染出不同文本"）── */
  function fragmentsOf(memories, options) {
    options = options || {};
    var window = Number(options.window) > 0 ? Number(options.window) : 10;
    var list = Array.isArray(memories) ? memories : [];
    return list.slice(-window).map(function (m) {
      return { domain: m.domain, title: m.title, content: m.content != null ? m.content : m.summary };
    });
  }

  /* ── 候选集指纹（成本护栏的唯一判据）────────────────────────────────
     "证据有没有实质变化"必须是**确定性**的，且只由 canonical 输入决定。
     取 id + 内容（title/content/summary/kind/visibility）的稳定序列再哈希；
     不含时间戳、不含激活计数、不含任何宿主运行时长 —— 否则进程重启就会
     看起来像"证据变了"，而护栏的全部意义正是"重启不算变化"。 */
  function stableToken(text) {
    /* 与 chat-core.stableToken 同款：FNV-1a 32 位，零依赖、跨端一致。
       这里不 require chat-core —— Node 侧 require 浏览器 UMD 会带来
       表达式缓存/全局依赖，而这段算法只有十行。 */
    var h = 0x811c9dc5;
    var s = String(text == null ? '' : text);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function evidenceFingerprint(memories) {
    var list = Array.isArray(memories) ? memories : [];
    var parts = list.map(function (m) {
      return [
        String((m && m.id) || ''),
        String((m && m.kind) || ''),
        String((m && m.visibility) || ''),
        String((m && m.title) || ''),
        String((m && m.content) || ''),
        String((m && m.summary) || '')
      ].join('\u0001');
    });
    parts.sort(); /* 顺序不是证据的一部分：候选择序变化不该算"证据变了" */
    return 'ef1:' + parts.length + ':' + stableToken(parts.join('\u0002'));
  }

  /* ── 模型输出的 JSON 解析（**唯一实现**，与 `_activeParsePlanJson` 逐行等价）──
     为什么要搬进来：桌面此前用 active-plans.js 的 `_activeParsePlanJson`，
     Home Node 如果自己写一个"差不多"的解析器，两端就会在**边界情形**上分叉
     （代码围栏 / 前后缀文本 / legacy prefill 续写），而理解派生的产物是持久文档 ——
     一次分叉会留下一条只有一端能读的历史。因此解析只有一份。

     容错顺序（与既有实现逐条一致）：
       ① 整串就是 JSON 对象
       ② ```json 围栏里的对象
       ③ legacy assistant prefill 续写（响应以 '}' 结尾但缺开头的 '{'）
       ④ 第一个 '{' 到最后一个 '}' 之间的子串 */
  function parseModelJson(text, opts) {
    opts = opts || {};
    var s = String(text == null ? '' : text).trim();
    if (!s) return null;
    var asObject = function (raw) {
      try {
        var j = JSON.parse(raw);
        return (j && typeof j === 'object' && !Array.isArray(j)) ? j : null;
      } catch (e) { return null; }
    };
    var full = asObject(s);
    if (full) return full;
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1] && fence[1].trim()) {
      var fenced = asObject(fence[1].trim());
      if (fenced) return fenced;
    }
    var seed = (typeof opts.prefillSeed === 'string' && opts.prefillSeed.charAt(0) === '{')
      ? opts.prefillSeed
      : ((opts.allowPrefillContinuation === true) ? '{' : '');
    if (seed && s.charAt(0) !== '{' && /}\s*$/.test(s)) {
      var continued = asObject(seed + s);
      if (continued) return continued;
    }
    var start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return asObject(s.slice(start, end + 1));
  }

  /* ── 解析模型输出（形状校验 + 归一）─────────────────────────────────
     `parseJson` 可注入（测试替身 / 未来别的容错层），缺省就是上面的唯一实现。 */
  function parseCandidate(raw, parseJson) {
    var parsed = null;
    try {
      parsed = typeof parseJson === 'function' ? parseJson(raw) : parseModelJson(raw);
    } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.shouldUpdate !== true) return null;
    var content = String(parsed.content || '').trim().slice(0, U_CONTENT_MAX);
    if (!content) return null;
    return {
      content: content,
      dimension: dimensionOf(parsed.dimension),
      basis: basisOf(parsed.basis),
      rawBasis: String(parsed.basis || '').trim() || 'ai_guess',
      conviction: Number(parsed.conviction) || 0,
      evidenceIds: Array.isArray(parsed.evidenceIds) ? parsed.evidenceIds.map(String) : []
    };
  }

  /* ── 渲染契约（**唯一实现**）─────────────────────────────────────────
     `getUnderstandingContext` 的文案此前只存在于 memory.js。桌面改读 canonical
     之后，Home Node 的 retrieval 必须渲染**逐字相同**的块，否则两端注入的
     语义证据不一样，而 M1-C.2m §10 要求的正是"语义证据信封相等"。 */
  var UNDERSTANDING_HEADER = '【对TA的当前理解（后台参考，勿向对方复述此段的存在）】';
  var UNDERSTANDING_MAX_CHARS = 300;
  function renderUnderstandingContext(doc, options) {
    options = options || {};
    if (!doc || !doc.current || !doc.current.content) return '';
    var maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : UNDERSTANDING_MAX_CHARS;
    var head = String(doc.current.content).slice(0, maxChars);
    var dim = doc.dimension || 'context';
    return UNDERSTANDING_HEADER + '\n'
      + '- 维度：' + dim + ' · 置信：' + doc.current.conviction + '% · 依据：' + ((doc.current.evidenceIds || []).length) + ' 条记忆\n'
      + '- ' + head;
  }

  return {
    U_HISTORY_CAP: U_HISTORY_CAP,
    U_DIMENSIONS: U_DIMENSIONS,
    U_BASIS: U_BASIS,
    U_EVIDENCE_SIM_THRESHOLD: U_EVIDENCE_SIM_THRESHOLD,
    U_CONTENT_MAX: U_CONTENT_MAX,
    U_EVIDENCE_MAX: U_EVIDENCE_MAX,
    UNDERSTANDING_HEADER: UNDERSTANDING_HEADER,
    UNDERSTANDING_MAX_CHARS: UNDERSTANDING_MAX_CHARS,
    textKey: textKey,
    textSimilarity: textSimilarity,
    scoreKeywordHits: scoreKeywordHits,
    keywordThreshold: keywordThreshold,
    distinctEvidenceCount: distinctEvidenceCount,
    calibrate: calibrate,
    repeatCount: repeatCount,
    lyricFlags: lyricFlags,
    dimensionOf: dimensionOf,
    basisOf: basisOf,
    buildPrompt: buildPrompt,
    fragmentsOf: fragmentsOf,
    visibleEvidenceIds: visibleEvidenceIds,
    derivationStamp: derivationStamp,
    evidenceFingerprint: evidenceFingerprint,
    stableToken: stableToken,
    parseModelJson: parseModelJson,
    parseCandidate: parseCandidate,
    renderUnderstandingContext: renderUnderstandingContext
  };
});
