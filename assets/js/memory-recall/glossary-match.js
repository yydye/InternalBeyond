/* ====================================================================
   IB Memory Recall · Glossary Match（P21-R2-E1b）· UMD dual-load
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/glossary-match.js">
              → window.IBMemoryRecallGlossaryMatch
   - Node   : require('../assets/js/memory-recall/glossary-match.js')

   ── 唯一职责 ────────────────────────────────────────────────────────
         catalog snapshot  +  当前文本  →  **exact deterministic hits**

   ── 明确不做 ────────────────────────────────────────────────────────
     ✗ DB / storage / 网络 / LLM / vector / fuzzy / edit distance
     ✗ ACL（可见性属 memory-visibility-core，且必须由**编排层**在
        target 解析之后立即施加 —— 本模块看不到 records）
     ✗ Memory ranking / 渲染 / activation
     ✗ 自己实现 alias 匹配

   ── ★ 复用唯一 alias matcher（不得形成第二套）★ ─────────────────────
     所有"什么算命中"的判定 —— ASCII 词边界、CJK 边界、引号/书名号
     protected spans、归一化、首次出现去重 —— 一律来自
     `recall-query.js` 已导出的 primitive：

         normalizeText(text)
         findProtectedSpans(text)
         normalizeAliasEntries(entries)
         matchAliases(normalized, entries, spans)

     本模块**不**复制其中任何一条规则。理由：一旦复制，两处边界规则
     必然漂移，同一条 alias 会在不同通道下得到不同命中结果 ——
     而 glossary 的整个价值就是"确定性"。

   ── 大小写语义（如实冻结）─────────────────────────────────────────
     唯一 matcher 是**大小写敏感**的（normalizeText 只做 NFKC +
     去零宽/控制符 + 折叠空白 + trim，**不** lowercase）。
     本模块**不**自行 lowercase —— 那会与 recall-query 的 aliases 行为
     分叉。catalog 保留用户书写的大小写；需要大小写不敏感时应由
     catalog 写入侧决定（写入多个变体），而不是在匹配层偷偷改语义。

   ── quoted 只提升、**不创造** ──────────────────────────────────────
     引号/书名号内的命中带 `quoted:true`（更强的 glossary intent），
     但**只有已存在的 catalog entry** 才会产生 hit。
     引用一个不存在的词**不产生**任何 hit —— 否则引号会变成凭空造词。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var q = null;
    try { q = require('./recall-query.js'); } catch (e) { q = null; }
    module.exports = factory(q);
  } else {
    root.IBMemoryRecallGlossaryMatch = factory(root.IBMemoryRecallQuery || null);
  }
}(typeof self !== 'undefined' ? self : this, function (QUERY) {
  'use strict';

  /* candidate reason 词表（冻结；§11 只扩 reasons[]，不扩 CANDIDATE_KEYS） */
  var REASON_EXACT_ALIAS = 'exact-alias';
  var REASON_EXACT_TERM = 'exact-term';
  var REASON_QUOTED_EXACT = 'quoted-exact';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /* matchGlossary(text, catalog, options) → {
       available : boolean,        // provider 可用性（透传，不重新判定）
       reason    : null | string,  // available:false 时给出原因
       hits      : [ { alias, memoryIds, kinds, quoted, matchedText, index } ],
       byMemoryId: { <memoryId>: { reasons[], quoted, aliases[] } }
     }
     catalog 是 **E1a glossary-catalog.js 的 getEntries() 结果**：
       { available, entries:[{alias,kind,target:{type:'memory',id}}], ... }
     provider 不可用 ⇒ available:false 且 hits 为空 —— **不抛异常**。 */
  function matchGlossary(text, catalog, options) {
    var out = { available: false, reason: null, hits: [], byMemoryId: {} };
    if (!isPlainObject(catalog)) { out.reason = 'catalog-missing'; return out; }
    if (catalog.available !== true) {
      /* 把 provider 的不可用原样上报 —— 编排层据此区分
         "通道不可用"（host-forced ⇒ channel-unsupported）与
         "通道可用但没有 entry"（⇒ 0 hit，绝不是 unsupported）。 */
      out.reason = catalog.reason || 'provider-unavailable';
      return out;
    }
    out.available = true;

    var entries = Array.isArray(catalog.entries) ? catalog.entries : [];
    if (!entries.length) return out;                 /* available 但 0 条 ⇒ 0 hit */
    if (!QUERY || typeof QUERY.matchAliases !== 'function'
      || typeof QUERY.normalizeText !== 'function'
      || typeof QUERY.normalizeAliasEntries !== 'function') {
      /* 唯一 matcher 缺失 ⇒ 绝不退化成本地实现（那就是第二套）。
         如实报告不可用。 */
      out.available = false;
      out.reason = 'alias-matcher-unavailable';
      return out;
    }

    var msg = (text == null) ? '' : String(text);
    var opts = isPlainObject(options) ? options : {};

    /* ① 把 typed catalog 投影成唯一 matcher 认识的形状
          （它期望 {alias, target:<string>}）。typed target 的 id 作为
          target 传入；映射回 typed entry 由本模块自己按 alias 完成，
          因此**不丢失** type/kind 信息。 */
    var raw = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!isPlainObject(e) || !isPlainObject(e.target)) continue;
      if (e.target.type !== 'memory') continue;
      if (typeof e.target.id !== 'string' || !e.target.id) continue;
      raw.push({ alias: e.alias, target: e.target.id });
    }
    if (!raw.length) return out;

    /* ② 全部走唯一 matcher 的**同一条**调用路径。 */
    var spans = (typeof QUERY.findProtectedSpans === 'function')
      ? QUERY.findProtectedSpans(msg) : [];
    var normalized = QUERY.normalizeText(msg);
    if (!normalized) return out;
    var matcherEntries = QUERY.normalizeAliasEntries(raw);
    var matched;
    try {
      matched = QUERY.matchAliases(normalized, matcherEntries, spans);
    } catch (err) {
      out.available = false;
      out.reason = 'alias-matcher-error';
      return out;
    }
    if (!Array.isArray(matched) || !matched.length) return out;

    /* ③ 把每个命中按 alias 展开回**全部** typed catalog entries。
          注意：一个 alias 可以指向多个 memory id（真实歧义状态），
          这里**一个都不挑** —— 全部交给 canonical selector。 */
    for (var h = 0; h < matched.length; h++) {
      var hit = matched[h];
      if (!hit || hit.matched !== true) continue;
      var alias = hit.alias;
      var ids = [], kinds = [], seen = {};
      for (var k = 0; k < entries.length; k++) {
        var ce = entries[k];
        if (!isPlainObject(ce) || ce.alias !== alias) continue;
        if (!isPlainObject(ce.target) || ce.target.type !== 'memory') continue;
        var id = ce.target.id;
        if (typeof id !== 'string' || !id) continue;
        if (!seen[id]) { seen[id] = 1; ids.push(id); }
        var kind = (ce.kind === 'term') ? 'term' : 'alias';
        if (kinds.indexOf(kind) < 0) kinds.push(kind);
      }
      if (!ids.length) continue;
      /* 顺序确定：ids 依 catalog 顺序（catalog 已按码元序稳定排序）；
         kinds 依 ['alias','term'] 固定序。 */
      kinds.sort();
      var one = {
        alias: alias,
        memoryIds: ids,
        kinds: kinds,
        quoted: hit.quoted === true,
        matchedText: (typeof hit.matchedText === 'string') ? hit.matchedText : alias,
        index: (typeof hit.index === 'number') ? hit.index : -1
      };
      out.hits.push(one);
    }
    if (!out.hits.length) return out;

    /* ④ 按 memory id 汇总 reasons（同一 candidate 可有多个 reasons）。
          reasons 顺序固定：exact-alias → exact-term → quoted-exact。 */
    for (var x = 0; x < out.hits.length; x++) {
      var hh = out.hits[x];
      for (var y = 0; y < hh.memoryIds.length; y++) {
        var mid = hh.memoryIds[y];
        if (!out.byMemoryId[mid]) out.byMemoryId[mid] = { reasons: [], quoted: false, aliases: [] };
        var bucket = out.byMemoryId[mid];
        for (var z = 0; z < hh.kinds.length; z++) {
          var r = (hh.kinds[z] === 'term') ? REASON_EXACT_TERM : REASON_EXACT_ALIAS;
          if (bucket.reasons.indexOf(r) < 0) bucket.reasons.push(r);
        }
        if (hh.quoted) {
          bucket.quoted = true;
          if (bucket.reasons.indexOf(REASON_QUOTED_EXACT) < 0) bucket.reasons.push(REASON_QUOTED_EXACT);
        }
        if (bucket.aliases.indexOf(hh.alias) < 0) bucket.aliases.push(hh.alias);
      }
    }
    /* reasons 归一为冻结顺序，保证 trace 可复现 */
    var ORDER = [REASON_EXACT_ALIAS, REASON_EXACT_TERM, REASON_QUOTED_EXACT];
    for (var mid2 in out.byMemoryId) {
      if (!Object.prototype.hasOwnProperty.call(out.byMemoryId, mid2)) continue;
      out.byMemoryId[mid2].reasons.sort(function (a, b) {
        return ORDER.indexOf(a) - ORDER.indexOf(b);
      });
    }
    return out;
  }

  /* hasExactHit(text, catalog, options) → boolean
     供自动通道路由使用：**只**关心"是否存在至少一个 exact catalog hit"。 */
  function hasExactHit(text, catalog, options) {
    var m = matchGlossary(text, catalog, options);
    return m.available === true && m.hits.length > 0;
  }

  return {
    matchGlossary: matchGlossary,
    hasExactHit: hasExactHit,
    REASON_EXACT_ALIAS: REASON_EXACT_ALIAS,
    REASON_EXACT_TERM: REASON_EXACT_TERM,
    REASON_QUOTED_EXACT: REASON_QUOTED_EXACT,
    REASON_ORDER: [REASON_EXACT_ALIAS, REASON_EXACT_TERM, REASON_QUOTED_EXACT]
  };
}));
