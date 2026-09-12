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
  var EXPLORE_WINDOW = 10;
  var DOMAINS = ['情感', '日常', '创作', '思考'];

  /* 可见性核心必须存在。缺失时**绝不**退化成"全部可见" —— 那是 fail-open，
     等于把"无法判定可见性"变成"对外公开"。调用方据此fail closed（返回空）。 */
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
      row._score = base * relBoost * fatigue;
      return row;
    }).sort(function (a, b) { return b._score - a._score; });
  }

  /* ── 4. 预算 / top-k：置顶优先 → 主选区 → 探索窗口 ─────────────────── */
  function selectWithinBudget(scored, options) {
    var opts = options || {};
    var maxChars = Number(opts.maxChars);
    if (!isFinite(maxChars) || maxChars <= 0) maxChars = DEFAULT_BUDGET_CHARS;
    var contentLen = Number(opts.contentLen);
    if (!isFinite(contentLen) || contentLen <= 0) contentLen = DEFAULT_CONTENT_LEN;
    var apiId = String(opts.apiId == null ? '' : opts.apiId);
    var rand = typeof opts.random === 'function' ? opts.random : Math.random;
    var rows = Array.isArray(scored) ? scored : [];

    var mainBudget = Math.floor(maxChars * (1 - EXPLORE_RATIO));
    var exploreBudget = maxChars - mainBudget;
    var lines = [];          /* 逐条渲染文本（不含标题） */
    var selected = [];       /* [{id, score, line}] 按注入顺序 */
    var chars = 0;
    var seen = {};

    var pinned = rows.filter(function (m) { return m.pinned; });
    var unpinned = rows.filter(function (m) { return !m.pinned; });

    /* 置顶记忆优先注入（保证每次都被 AI 看到），但它**仍然**占用字符预算 */
    for (var i = 0; i < pinned.length; i++) {
      var line = renderMemoryLine(pinned[i], apiId, contentLen);
      if (chars + line.length > mainBudget) break;
      chars += line.length;
      lines.push(line);
      selected.push({ id: pinned[i].id, score: pinned[i]._score, line: line });
      seen[pinned[i].id] = 1;
    }
    /* 主选区：剩余预算按分数从高到低填充非置顶记忆 */
    for (var j = 0; j < unpinned.length; j++) {
      var line2 = renderMemoryLine(unpinned[j], apiId, contentLen);
      if (chars + line2.length > mainBudget) break;
      chars += line2.length;
      lines.push(line2);
      selected.push({ id: unpinned[j].id, score: unpinned[j]._score, line: line2 });
      seen[unpinned[j].id] = 1;
    }
    /* 探索窗口：从未入选的中低分段随机抽一条 */
    var remaining = rows.filter(function (m) { return !seen[m.id] && !m.pinned; });
    if (remaining.length && exploreBudget > 50) {
      var pick = remaining[Math.floor(rand() * Math.min(remaining.length, EXPLORE_WINDOW))];
      var line3 = renderMemoryLine(pick, apiId, contentLen);
      if (chars + line3.length <= maxChars) {
        chars += line3.length;
        lines.push(line3);
        selected.push({ id: pick.id, score: pick._score, line: line3 });
      }
    }
    return { lines: lines, selected: selected, chars: chars, count: selected.length };
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
    if (!picked.count) return { text: '', selected: [], count: 0, chars: 0, reason: 'no-budget' };
    var head = (opts.includeHeader === false) ? '' : '【记忆（系统参考，勿提及此段）】\n';
    return {
      text: head + picked.lines.join(''),
      selected: picked.selected,
      count: picked.count,
      chars: picked.chars + head.length,
      reason: null
    };
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
    DOMAINS: DOMAINS
  };
});
