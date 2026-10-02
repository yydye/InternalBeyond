/* ====================================================================
   IB Memory Retrieval Core — runtime-neutral memories 召回语义（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-retrieval-core.js"> → window.IBMemoryRetrievalCore
              （必须在 memory.js 之前加载，且必须在 memory-visibility-core.js 之后）
   - Node   : require('../assets/js/memory-retrieval-core.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零 fetch /
           零副作用 / 纯函数。时钟与随机源**必须注入**。

   为什么存在（M1-C.2d Wave 2）：
     Wave 2 把 `memories` 的权威搬到 Home Node，而 Home Node 必须在**自己的**执行缝
     里召回记忆并注入 prompt。如果 Node 侧另写一份打分/排序/预算/渲染，
     就会出现两套"她记得什么"—— 浏览器一套、Node 一套，且没有任何测试能
     同时证明两者一致（它们会在每次改权重时悄悄漂移）。

     因此召回语义与可见性语义一样，必须收敛成**唯一实现**：
       · 可见性（ACL）    → assets/js/memory-visibility-core.js
       · 召回（打分/排序/top-k/渲染） → 本文件
     memory.js 只负责 I/O（读哪个 store、把激活写到哪里），不再持有判断。

   顺序契约（SAFE_PRE_FILTER，不可调换）：
       candidate set
         ↓  visibility / ACL            ← **先**过滤，隐藏记忆绝不进入打分
         ↓  relevance（关键词）
         ↓  ranking（score × 相关性 × 疲劳）
         ↓  top-k / budget（置顶优先 → 主选区 → 探索窗口）
         ↓  rendered context
   隐藏记忆因此**不可能**影响打分、排序或 top-k —— 它在那之前就被移除了。

   激活不是本文件的事：本文件**不写任何东西**。activationCount / lastActivated
   只作为打分输入被读取，强化由调用方在选中之后单独持久化
   （Wave 1 · C3 的 selection / reinforcement 分离）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./memory-visibility-core.js'));
  } else {
    root.IBMemoryRetrievalCore = factory(root.IBMemoryVisibilityCore);
  }
})(typeof self !== 'undefined' ? self : this, function (VIS) {
  'use strict';

  /* 既有 production 缺省（memory.js 的 getMemorySettings 缺省值）。
     写在这里是为了让 Node 与 Browser 用**同一个**缺省，而不是各自硬编码。 */
  var DEFAULT_BUDGET_CHARS = 2000;
  var DEFAULT_CONTENT_LEN = 200;
  var EXPLORE_RATIO = 0.15;
  /* P21-R2-F1a：EXPLORE_WINDOW（top-10 前缀窗口）已**删除**。
     旧实现 `remaining[floor(random * min(len, 10))]` 违反 MEMORY_RECALL_CONTRACT §9 的
     MUST NOT（"从 remaining 的最高分前 N 条中随机取一条"）—— 当 remaining 按分数降序时，
     索引前缀恰是分数最高的一段，采样区间与"唤起沉睡"的**目标相反**。
     新语义：FULL-REMAINING UNIFORM，即 `remaining[floor(random * remaining.length)]`。
     刻意**不**做 score-weighted / low-score-weighted / dormant-weighted：
     当前没有 exposure / dormant authority，加权只会伪造一个不存在的信号。
     本阶段只承诺**admitted candidate coverage**，**不**宣称 dormant / reminisce。 */

  /* 记忆块标题。放在这里是因为它必须进入 maxChars 总预算（见 selectWithinBudget）：
     旧实现先按 maxChars 填满正文、再把 header 拼上去并计入 chars，
     于是 chars 可以超过 maxChars（maxChars < ~113 时可达）；P21-R2-F1a 修正为
     payloadBudget = max(0, maxChars - header.length)，header 先扣。 */
  var MEMORY_HEADER = '【记忆（系统参考，勿提及此段）】\n';
  var DOMAINS = ['情感', '日常', '创作', '思考'];

  /* 可见性核心必须存在。缺失时**绝不**退化成"全部可见" —— 那是 fail-open，
     等于把"无法判定可见性"变成"对外公开"。调用方据此fail closed（返回空）。 */
  /* 把注入的 random 归一化到 [0, 1)。
     §9：random 是**外部注入**的，不能假设调用方守规矩。
     旧实现直接 `floor(rand() * n)` —— random=1 会得到 idx=n（越界，取到 undefined，
     随后 renderMemoryLine(undefined) 会抛；NaN / 负数同理得到不可预期的下标）。
     这里返回可测的归一化值，调用方**还会**再对下标做一次 clamp（双保险）。 */
  function normalizeRandom01(value) {
    var r = Number(value);
    if (!isFinite(r)) return 0;      /* NaN / ±Infinity ⇒ 确定性地取第一个 */
    if (r <= 0) return 0;
    if (r >= 1) return 1 - Number.EPSILON;   /* 仍严格 < 1，floor(r*n) 必落在 [0, n-1] */
    return r;
  }

  /* header 是否计入本轮的 maxChars 预算（includeHeader:false ⇒ 不占预算）。 */
  /* ── P21-R2-F1b · cooldown factor 的**安全**读取 ────────────────────
     唯一 selector 只认 "memoryId → factor" 这份**纯数据**；它不认识
     RecallSessionState / characterId / turnIndex（那些属于编排层）。

     两类风险都挡在这里：
       ① inherited-key：memory id 是 opaque string，可能是 "__proto__" /
          "constructor" / "toString"。用 hasOwnProperty 判定，绝不读原型链。
       ② 非法值：missing / NaN / ±Infinity / string / null / object / <=0 / >1
          **一律 fail-safe → 1**（= 无 cooldown）；绝不 clamp 成 0.01，
          也绝不让一个坏值把 memory 永久压没。 */
  function cooldownFactorOf(map, id) {
    if (!map || typeof map !== "object" || id == null) return 1;
    var key = String(id);
    if (!Object.prototype.hasOwnProperty.call(map, key)) return 1;
    var v = map[key];
    /* BUG-1（R2-F1b.1）：必须判**类型**，不能判"能否转成数"。
       早先写作 Number(v)，于是字符串 "0.4" 与布尔 true 都被悄悄接受，
       直接违反契约 §9/§20 的 invalid 清单（string / boolean 必须 → 1）。
       注意 NaN/±Infinity 都是 typeof number，因此 isFinite 仍需保留。 */
    if (typeof v !== "number") return 1;
    if (!isFinite(v) || v <= 0 || v > 1) return 1;
    return v;
  }

  function headerLength(opts) {
    return (opts && opts.includeHeader === false) ? 0 : MEMORY_HEADER.length;
  }

  function visibilityOf() {
    return (VIS && typeof VIS.isMemoryVisibleTo === 'function') ? VIS : null;
  }

  /* ── 1. 衰减评分（Ombre Brain 改进版艾宾浩斯）─────────────────────────
     与 memory.js 既有 getMemoryScore 逐行为等价。
     now 必须由调用方给出（注入）：衰减读时间，从全局读会让同一输入在不同
     时刻给出不同召回 —— 在浏览器里只是"行为飘"，在 Node 里就是不可复现。 */
  function getMemoryScore(mem, now) {
    if (!mem) return 0;
    if (mem.pinned) return 999;
    var t = Number(now);
    if (!isFinite(t)) t = 0;
    var daysSince = (t - (mem.lastActivated || mem.created || 0)) / (1000 * 60 * 60 * 24);
    var lambda = mem.resolved ? 0.12 : 0.05;   /* 已解决的记忆衰减更快 */
    var base = 1.0;
    var arousalBoost = 0.8;
    var emotionFactor = base + (mem.arousal || 0.3) * arousalBoost;
    var activationCount = Math.max(0, mem.activationCount || 0);
    /* AI 回忆习惯：长期软饱和。300 次≈1.5倍，600次≈1.67倍，1200次≈1.8倍；永远低于2倍 */
    var activationFactor = 1 + activationCount / (activationCount + 300);
    var decayFactor = Math.exp(-lambda * daysSince);
    var score = (mem.importance || 5) * activationFactor * decayFactor * emotionFactor;
    return Math.round(score * 100) / 100;
  }

  /* ── 2. 语义相关性：本地关键词匹配（零 token 消耗）────────────────── */
  function extractKeywords(text) {
    if (!text) return [];
    var keywords = [];
    var cleaned = String(text).replace(/[\[\]()（）【】「」《》、，。！？；：\s]/g, ' ').trim();
    var enWords = cleaned.match(/[a-zA-Z]{3,}/g);
    if (enWords) enWords.forEach(function (w) { keywords.push(w.toLowerCase()); });
    var zhOnly = cleaned.replace(/[a-zA-Z0-9\s]+/g, '');
    for (var i = 0; i < zhOnly.length - 1; i++) {
      keywords.push(zhOnly.slice(i, i + 2));
      if (i < zhOnly.length - 2) keywords.push(zhOnly.slice(i, i + 3));
    }
    var seen = {}, out = [];
    for (var k = 0; k < keywords.length; k++) {
      if (!seen[keywords[k]]) { seen[keywords[k]] = 1; out.push(keywords[k]); }
    }
    return out;
  }
  function calcRelevance(mem, keywords) {
    if (!keywords || !keywords.length) return 1;
    var haystack = (String(mem.title || '') + '|' + String(mem.content || '') + '|'
      + ((mem.tags || []).join('|')) + '|' + String(mem.domain || '')).toLowerCase();
    var hits = 0;
    for (var i = 0; i < keywords.length; i++) { if (haystack.indexOf(keywords[i]) >= 0) hits++; }
    var ratio = hits / keywords.length;
    return 1 + ratio * 1.5;   /* 最高 2.5x 加成 */
  }

  /* ── 3. candidate set → 可见性 → relevance → ranking ─────────────────
     返回**已排序**的候选（含 _score），或 null 表示"可见性不可判定"。
     null 与 [] 的区别很重要：[] 是"确实没有可见记忆"，null 是"无法判定"。
     两者对调用方的后果相同（不注入），但诊断上必须能区分。 */
  function rankMemoryCandidates(memories, options) {
    var opts = options || {};
    var vis = visibilityOf();
    if (!vis) return null;
    var apiId = String(opts.apiId == null ? '' : opts.apiId);
    var isGroup = !!opts.isGroup;
    var groupMemEnabled = !!opts.groupMemEnabled;
    var rows = Array.isArray(memories) ? memories : [];
    /* ① visibility / ACL —— 先于任何打分。隐藏记忆到此为止。 */
    var visible = [];
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i];
      if (!m) continue;
      var ok = false;
      try { ok = !!vis.isMemoryVisibleTo(m, apiId, isGroup, groupMemEnabled); } catch (e) { ok = false; }
      if (ok) visible.push(m);
    }
    if (!visible.length) return [];
    /* ② relevance + ③ ranking */
    var keywords = extractKeywords(opts.userMessage || '');
    var now = Number(opts.now);
    if (!isFinite(now)) now = 0;
    return visible.map(function (m) {
      var base = getMemoryScore(m, now);
      var relBoost = m.pinned ? 1 : calcRelevance(m, keywords);
      /* 反垄断：连续高频激活的记忆施加疲劳惩罚 */
      var fatigue = 1;
      if (!m.pinned && m.activationCount > 5) {
        var hoursSinceLast = (now - (m.lastActivated || m.created || 0)) / (1000 * 60 * 60);
        if (hoursSinceLast < 2) fatigue = 0.7;   /* 2 小时内反复激活 → 降权 */
      }
      var row = {};
      for (var key in m) { if (Object.prototype.hasOwnProperty.call(m, key)) row[key] = m[key]; }
      /* P21-R2-F1b · 唯一 selector 的 cooldown 注入点。canonical 契约公式（逐字）：
             effectivePinned(m) = m.pinned === true AND cooldownFactor(m) === 1
             scoreSource(m)     = effectivePinned ? 999 : getMemoryScore({...m, pinned:false})
             _score(m)          = scoreSource(m) × relBoost × fatigue × cooldownFactor(m)
         即：**只有 scoreSource 被替换**。relBoost 与 fatigue 继续按 record 的 **raw**
         pinned 计算 —— 契约公式对它们没有附加限定，本实现不擅自扩大契约。
         m 本身**绝不**被 mutate：非 pinned 副本只用于这一次分数计算。 */
      var _cd = cooldownFactorOf(opts.cooldownFactorsById, m.id);
      if (m.pinned && _cd < 1) {
        var _unpinned = {};
        for (var _uk in m) { if (Object.prototype.hasOwnProperty.call(m, _uk)) _unpinned[_uk] = m[_uk]; }
        _unpinned.pinned = false;
        base = getMemoryScore(_unpinned, now);
      }
      row._score = base * relBoost * fatigue * _cd;
      row._cooldownFactor = _cd;
      row._effPinned = (m.pinned === true) && _cd === 1;
      return row;
    }).sort(function (a, b) { return b._score - a._score; });
  }

  /* ── 4. 预算 / top-k：置顶优先 → 主选区 → 探索窗口 ─────────────────── */
  function selectWithinBudget(scored, options) {
    var opts = options || {};
    /* maxChars：0 是**真实的零预算**（不是"用缺省"）。旧实现把 <=0 一律替换成
       DEFAULT_BUDGET_CHARS，于是 maxChars=0 反而注入 ~1700 字符，违反
       `chars <= maxChars` —— 这是 §11 要求封死的边界。非法值（NaN / 负数 / 缺失）
       仍回落到缺省，保持 legacy 调用方的既有行为。 */
    var maxChars = Number(opts.maxChars);
    if (!isFinite(maxChars) || maxChars < 0) maxChars = DEFAULT_BUDGET_CHARS;
    var contentLen = Number(opts.contentLen);
    if (!isFinite(contentLen) || contentLen <= 0) contentLen = DEFAULT_CONTENT_LEN;
    var apiId = String(opts.apiId == null ? '' : opts.apiId);
    var rand = typeof opts.random === 'function' ? opts.random : Math.random;
    var rows = Array.isArray(scored) ? scored : [];

    /* header 先扣：正文预算必须给标题让路，否则 chars 会超过 maxChars。 */
    var payloadBudget = Math.max(0, maxChars - headerLength(opts));
    /* 85% = main selection cap；15% = **reserved exploration capacity（启用参考）**，
       ——不是 exploration 单条 line 的独立上限。探索项最终只需满足
       `chars <= payloadBudget`，因此它可以使用 main 未消费掉的 slack。
       旧变量名 exploreBudget 会误导成"严格子预算"，故改名。 */
    var mainBudget = Math.floor(payloadBudget * (1 - EXPLORE_RATIO));
    var reservedExploreCapacity = payloadBudget - mainBudget;
    var lines = [];          /* 逐条渲染文本（不含标题） */
    var selected = [];       /* [{id, score, line}] 按注入顺序 */
    var explorationIds = []; /* 真实由探索抽中的 id（供 seat planner / trace 使用） */
    var chars = 0;
    var seen = {};

    /* P21-R2-F1b：pinned-first 特权按 **effectivePinned** 判定，而不是 record.pinned。
       cooled pinned 因此落入 normal loop（它仍是 pinned 记录，seat 身份不变）。 */
    var pinned = rows.filter(function (m) { return m._effPinned === true; });
    var unpinned = rows.filter(function (m) { return m._effPinned !== true; });

    /* 置顶记忆优先注入 —— 但 pinned 只是"fitting candidates 中优先级最高"，
       **没有**超额豁免：装不下就跳过，且**不得**终止整个循环（D-4）。
       跳过而不是 break，后面的 fitting pinned / normal 仍会被检查。 */
    for (var i = 0; i < pinned.length; i++) {
      var line = renderMemoryLine(pinned[i], apiId, contentLen);
      if (chars + line.length > mainBudget) continue;
      chars += line.length;
      lines.push(line);
      selected.push({ id: pinned[i].id, score: pinned[i]._score, line: line });
      seen[pinned[i].id] = 1;
    }
    /* 主选区：剩余预算按分数从高到低填充非置顶记忆。
       同样 continue：一条装不下不代表后面都装不下（旧实现 break 会让大条目
       把它后面所有能装下的候选一起饿死 —— D-4）。 */
    for (var j = 0; j < unpinned.length; j++) {
      var line2 = renderMemoryLine(unpinned[j], apiId, contentLen);
      if (chars + line2.length > mainBudget) continue;
      chars += line2.length;
      lines.push(line2);
      selected.push({ id: unpinned[j].id, score: unpinned[j]._score, line: line2 });
      seen[unpinned[j].id] = 1;
    }
    /* 探索：FULL-REMAINING UNIFORM（§0.1 / §8）。
       · pool = 全部未入选、非 pinned 的候选（**不再是** top-10 前缀）
       · random **只调用一次**；allowExploration=false 时一次都不调用
       · 抽中的 line 装不下 ⇒ 本轮**不重抽**（重抽会改变随机分布），
         直接放弃探索项，main selection 原样保留（§10）
       · 仍受 reservedExploreCapacity > 50 的**启用门**约束（§0.6） */
    var allowExploration = (opts.allowExploration !== false);
    /* P21-R2-F1b：cooled candidate 仍 admitted、仍可 primary selected，
       但**不得作为 exploration pick**（契约 §12 —— 这不是 Hard Gate）。
       过滤后为空 ⇒ 本轮不产生 exploration 项，不重抽、不回退。 */
    var remaining = rows.filter(function (m) {
      return !seen[m.id] && m._effPinned !== true && !(m._cooldownFactor < 1);
    });
    if (allowExploration && remaining.length && reservedExploreCapacity > 50) {
      var r01 = normalizeRandom01(rand());
      var idx = Math.floor(r01 * remaining.length);
      if (!isFinite(idx) || idx < 0) idx = 0;
      if (idx > remaining.length - 1) idx = remaining.length - 1;   /* 双保险 */
      var pick = remaining[idx];
      var line3 = renderMemoryLine(pick, apiId, contentLen);
      if (chars + line3.length <= payloadBudget) {
        chars += line3.length;
        lines.push(line3);
        selected.push({ id: pick.id, score: pick._score, line: line3 });
        explorationIds.push(pick.id);
      }
    }
    return {
      lines: lines, selected: selected, chars: chars, count: selected.length,
      /* 内部 metadata：唯一 selector 才能诚实提供"谁是探索项"。
         buildMemoryContext 只在 opts.includeSelectionMeta === true 时才对外暴露。 */
      explorationIds: explorationIds
    };
  }

  /* ── 5. 渲染：与 memory.js 既有 _formatMemLine 逐字相同 ─────────────── */
  function renderMemoryLine(m, apiId, contentLen) {
    var authorTag = '';
    if (m.createdBy === 'user' || !m.createdBy) authorTag = '[用户记录] ';
    else if (m.createdBy === apiId) authorTag = '';
    else { var cname = m.createdByName || 'AI'; authorTag = '[' + cname + ' 记录] '; }
    var len = Number(contentLen);
    if (!isFinite(len) || len <= 0) len = DEFAULT_CONTENT_LEN;
    var content = String(m.content || '');
    var domain = DOMAINS.indexOf(m.domain) >= 0 ? m.domain : '记忆';
    return '- ' + authorTag + (m.title || '无标题') + '（' + domain
      + (m.tags && m.tags.length ? ' · ' + m.tags.join('、') : '')
      + '）：' + content.slice(0, len) + (content.length > len ? '…' : '')
      + (m.resolved ? ' [已解决]' : '')
      + '\n';
  }

  /* ── 6. 完整召回：candidate set → … → rendered context ──────────────
     这是**唯一**的召回入口（Browser 与 Node 都走这里）。
     返回 { text, selected, count, chars, reason }：
       · text      '' 表示不注入（此时调用方绝不塞空标题进 prompt）
       · selected  [{id, score, line}]，供调用方在**之后**做激活强化
       · reason    'no-visible-memory' | 'no-budget' | 'visibility-unavailable'

     opts.includeHeader（缺省 true）：是否带上「【记忆（系统参考…）】」标题。
     桌面把它与其它 tail 生产者拼在一起时依赖该标题；Home Node 自己有一个
     「【长期记忆】」小节标题，因此传 false 只要正文行 —— 这样两边的**行渲染**
     仍然由同一份实现产出，标题的差异是刻意的、显式的，而不是隐蔽的漂移。 */
  function buildMemoryContext(memories, options) {
    var opts = options || {};
    var scored = rankMemoryCandidates(memories, opts);
    if (scored === null) return { text: '', selected: [], count: 0, chars: 0, reason: 'visibility-unavailable' };
    if (!scored.length) return { text: '', selected: [], count: 0, chars: 0, reason: 'no-visible-memory' };
    var picked = selectWithinBudget(scored, opts);
    /* header 已由 selectWithinBudget 从 maxChars 中预扣 ⇒ 这里加上它仍然 <= maxChars。
       一条也放不下时返回 0 memory，**绝不**产生"只有 header 没有正文"的块。 */
    if (!picked.count) return { text: '', selected: [], count: 0, chars: 0, reason: 'no-budget' };
    var head = (opts.includeHeader === false) ? '' : MEMORY_HEADER;
    var out = {
      text: head + picked.lines.join(''),
      selected: picked.selected,
      count: picked.count,
      chars: picked.chars + head.length,
      reason: null
    };
    /* 只有显式请求时才多出 selectionMeta ⇒ 未请求的 caller 拿到的 result
       **逐字不变**（原有键与值一个不少、一个不多）。 */
    if (opts.includeSelectionMeta === true) {
      out.selectionMeta = { explorationIds: (picked.explorationIds || []).slice() };
    }
    return out;
  }

  return {
    getMemoryScore: getMemoryScore,
    extractKeywords: extractKeywords,
    calcRelevance: calcRelevance,
    rankMemoryCandidates: rankMemoryCandidates,
    selectWithinBudget: selectWithinBudget,
    renderMemoryLine: renderMemoryLine,
    buildMemoryContext: buildMemoryContext,
    DEFAULT_BUDGET_CHARS: DEFAULT_BUDGET_CHARS,
    DEFAULT_CONTENT_LEN: DEFAULT_CONTENT_LEN,
    EXPLORE_RATIO: EXPLORE_RATIO,
    MEMORY_HEADER: MEMORY_HEADER,
    normalizeRandom01: normalizeRandom01,
    DOMAINS: DOMAINS
  };
});
