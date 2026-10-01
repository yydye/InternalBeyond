/* ====================================================================
   IB Memory Recall · Glossary Catalog（P21-R2-E1a）· UMD dual-load
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/glossary-catalog.js">
              → window.IBMemoryRecallGlossaryCatalog
   - Node   : require('../assets/js/memory-recall/glossary-catalog.js')

   ── 本模块**只**做四件事 ────────────────────────────────────────────
     ① contract      —— entry / catalog 的形状与不变量
     ② normalization —— NFKC + trim + 稳定排序 + 去重（**确定性**）
     ③ validation    —— 非法 entry 丢弃，绝不"猜 target"
     ④ provider      —— 消费**调用方注入**的数据源；不碰任何存储

   ── 明确不做（违反即违约）───────────────────────────────────────────
     ✗ DB read / IndexedDB / localStorage / 任何持久化
     ✗ 网络 / fetch / LLM / embedding / vector / BM25
     ✗ 时钟 / 随机（本模块**没有**任何非确定性来源）
     ✗ UI
     ✗ 从 title / tags / content **推导** alias（那是"凭空造词"）
     ✗ 语义解析 target（glossary 是 deterministic lookup）

   ── ★ target 必须是稳定引用，不是自由文本 ★ ────────────────────────
     R2-E1 第一版**只**支持：

         target: { type: 'memory', id: '<stable memory id>' }

     为什么禁止 `target: string` 作为 concept 文本：
       glossary 的语义是 `alias → target` 的**确定性查表**。
       若 target 是自由文本，命中之后必然还要再做一次
       "拿这段文本去找 Memory" —— 那一步没有 deterministic 的答案，
       于是会退化成 semantic / fuzzy / LLM resolve，
       与本 contract §5「deterministic / lexical / explainable」直接冲突。
       因此：**target 必须已经是一个可寻址的 id**，命中即终点。

     将来若需要非 Memory 的 concept，**另开 target type 扩展**
     （TARGET_TYPES 是显式白名单，未知 type 一律丢弃）。

   ── 为什么 catalog 不是 Memory 的副本 ──────────────────────────────
     entry **只**带 alias / kind / target —— 没有 title / content /
     summary / definition / embedding。catalog 回答"这个词指向哪条 memory"，
     内容一律由 memory 本体提供（唯一真源）。把内容抄进 catalog 会造出
     第二个内容真源，且必然与 Memory 漂移。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryRecallGlossaryCatalog = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 上限（防御性边界，**不是**相关性阈值）──────────────────────── */
  var MAX_CATALOG_ENTRIES = 500;
  var MAX_ALIAS_CHARS = 200;
  var MAX_TARGET_ID_CHARS = 200;

  /* ── 词表（显式白名单）─────────────────────────────────────────── */
  var TARGET_TYPES = ['memory'];
  var ENTRY_KINDS = ['alias', 'term'];
  var DEFAULT_KIND = 'alias';

  /* ── provider 可用性词表 ──────────────────────────────────────────
     这三个语义**必须**能区分（R2-E1a §6）：
       A. provider 不存在 / 取数失败 ⇒ available:false
          ⇒ glossary channel **unavailable** ⇒ 未来映射为 channel-unsupported
       B. provider 存在且成功返回 [] ⇒ available:true, entries:[]
          ⇒ channel **可用**，只是没有 entry ⇒ 未来是 0 hit，**不是** unsupported
       C. provider 返回畸形数据 ⇒ normalize 后可能 []，但 available:true
          ⇒ 仍属"provider 可用"
     把 B/C 混成 A 会让"术语表是空的"看起来像"这个通道没实现"，
     从而在诊断与产品上都指向错误的地方。 */
  var UNAVAILABLE_NOT_CONFIGURED = 'provider-not-configured';
  var UNAVAILABLE_ERROR = 'provider-error';
  var UNAVAILABLE_BAD_RESULT = 'provider-bad-result';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /* NFKC + trim + 折叠内部空白。
     为什么 NFKC：全角/半角、兼容字符（例如 `Ｐｒｏｊｅｃｔ` 与 `Project`）
     必须在**比较之前**归一，否则同一术语会因为输入法差异漏命中。
     大小写**不**在这里折叠 —— 大小写不敏感由匹配层按需施加
     （catalog 保留原样，便于诊断"用户到底写了什么"）。 */
  function normalizeAlias(raw) {
    var s = (raw == null) ? '' : String(raw);
    try { if (typeof s.normalize === 'function') s = s.normalize('NFKC'); } catch (e) { /* 老引擎：退化为原串 */ }
    return s.replace(/\s+/g, ' ').trim();
  }

  function normalizeTargetId(raw) {
    var s = (raw == null) ? '' : String(raw);
    try { if (typeof s.normalize === 'function') s = s.normalize('NFKC'); } catch (e) { /* 同上 */ }
    return s.trim();
  }

  /* ── 单条 entry 的规范化 + 校验 ─────────────────────────────────
     返回 { ok:true, entry } 或 { ok:false, reason }。
     **绝不猜 target**：target 缺失/非法 ⇒ 丢弃，不退化、不推断。 */
  function normalizeEntry(raw) {
    if (!isPlainObject(raw)) return { ok: false, reason: 'not-an-object' };

    var alias = normalizeAlias(raw.alias);
    if (!alias) return { ok: false, reason: 'missing-alias' };
    if (alias.length > MAX_ALIAS_CHARS) return { ok: false, reason: 'alias-too-long' };

    var kind = (raw.kind == null) ? DEFAULT_KIND : String(raw.kind);
    if (ENTRY_KINDS.indexOf(kind) < 0) return { ok: false, reason: 'unknown-kind' };

    /* target 必须存在且是 {type:'memory', id} —— 也接受等价的
       `targetMemoryId` 简写（§2.1 明确允许），但**只**接受这一种语义。 */
    var target = raw.target;
    var type = null, id = null;
    if (isPlainObject(target)) {
      type = (target.type == null) ? 'memory' : String(target.type);
      id = normalizeTargetId(target.id);
    } else if (raw.targetMemoryId != null) {
      type = 'memory';
      id = normalizeTargetId(raw.targetMemoryId);
    } else {
      return { ok: false, reason: 'missing-target' };
    }

    if (TARGET_TYPES.indexOf(type) < 0) return { ok: false, reason: 'unsupported-target-type' };
    if (!id) return { ok: false, reason: 'empty-target-id' };
    if (id.length > MAX_TARGET_ID_CHARS) return { ok: false, reason: 'target-id-too-long' };

    return { ok: true, entry: { alias: alias, kind: kind, target: { type: type, id: id } } };
  }

  /* 确定性比较器：先 alias，再 target.id。
     不用 localeCompare（受 locale 影响 ⇒ 非确定性），
     用码元序，保证同输入在任何环境给出同一顺序。 */
  function compareEntries(a, b) {
    if (a.alias !== b.alias) return a.alias < b.alias ? -1 : 1;
    if (a.target.id !== b.target.id) return a.target.id < b.target.id ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return 0;
  }

  /* ── normalizeCatalog(entries) ───────────────────────────────────
     返回 { entries, dropped, droppedReasons, truncated }。
     行为：
       · 逐条规范化；非法项**丢弃并记因**（不抛异常）
       · 按 (alias, target.id, kind) 去重 —— **同一个 alias 指向不同
         memory id 会被保留**（见下）
       · 码元序稳定排序 ⇒ 同输入同输出
       · 截断到 MAX_CATALOG_ENTRIES（截断发生在排序**之后**，因此
         截断是确定的、可复现的）

     为什么同 alias 多 target 要保留：那是一个**真实且需要被看见**的
     catalog 状态（"这个词有歧义"）。在这里静默挑一个等于**猜 target**，
     正是本 contract 禁止的。歧义裁决属检索层（确定性 tie-break），
     不属于规范化层。 */
  function normalizeCatalog(entries) {
    var out = { entries: [], dropped: 0, droppedReasons: {}, truncated: false };
    if (!Array.isArray(entries)) {
      /* 非数组 ⇒ 视为"0 条合法 entry"，并把整体计为一次丢弃。
         调用方据此仍可判 provider available（见 §6C）。 */
      out.dropped = (entries == null) ? 0 : 1;
      if (entries != null) out.droppedReasons['not-an-array'] = 1;
      return out;
    }

    var seen = {};
    var kept = [];
    for (var i = 0; i < entries.length; i++) {
      var r = normalizeEntry(entries[i]);
      if (!r.ok) {
        out.dropped++;
        out.droppedReasons[r.reason] = (out.droppedReasons[r.reason] || 0) + 1;
        continue;
      }
      var key = r.entry.alias + '\u0000' + r.entry.target.id + '\u0000' + r.entry.kind;
      if (seen[key]) { out.dropped++; out.droppedReasons['duplicate'] = (out.droppedReasons['duplicate'] || 0) + 1; continue; }
      seen[key] = 1;
      kept.push(r.entry);
    }

    kept.sort(compareEntries);
    if (kept.length > MAX_CATALOG_ENTRIES) {
      out.truncated = true;
      out.dropped += kept.length - MAX_CATALOG_ENTRIES;
      out.droppedReasons['over-max-entries'] = kept.length - MAX_CATALOG_ENTRIES;
      kept = kept.slice(0, MAX_CATALOG_ENTRIES);
    }
    out.entries = kept;
    return out;
  }

  /* ── createGlossaryCatalogProvider(sourceFn) ─────────────────────
     sourceFn(context) → entry[]（或 Promise<entry[]>）
       由**调用方**提供；本模块只消费它返回的纯数据。
       sourceFn 缺失 ⇒ provider 存在但 **not configured**（available:false）。

     getEntries(context) → {
       available: boolean,     // 通道是否**可用**（区别于"有没有 entry"）
       entries: Entry[],       // 规范化后的确定性快照
       dropped: number,        // 被丢弃的条数（诊断）
       droppedReasons: {},     // 丢弃原因直方图（诊断）
       truncated: boolean,
       reason: null | string   // available:false 时给出原因
     }
     **绝不抛异常**：sourceFn 抛错 ⇒ available:false + reason:'provider-error'。 */
  function createGlossaryCatalogProvider(sourceFn) {
    return {
      getEntries: function (context) {
        if (typeof sourceFn !== 'function') {
          return emptyResult(false, UNAVAILABLE_NOT_CONFIGURED);
        }
        var raw;
        try {
          raw = sourceFn(context);
        } catch (e) {
          return emptyResult(false, UNAVAILABLE_ERROR);
        }
        /* Promise 形态：显式拒绝而不是"当作空数组"——
           把异步源当成空会让"还没加载完"看起来像"没有术语"。 */
        if (raw && typeof raw.then === 'function') {
          return emptyResult(false, UNAVAILABLE_BAD_RESULT);
        }
        if (!Array.isArray(raw)) {
          return emptyResult(false, UNAVAILABLE_BAD_RESULT);
        }
        /* 到这里 ⇒ provider **可用**（即使 normalize 后是空数组）。
           这正是 §6B / §6C 与 §6A 的分界。 */
        var norm = normalizeCatalog(raw);
        return {
          available: true,
          entries: norm.entries,
          dropped: norm.dropped,
          droppedReasons: norm.droppedReasons,
          truncated: norm.truncated,
          reason: null
        };
      },
      /* 便于测试/诊断：provider 是否被配置（不等于可用性判定） */
      isConfigured: function () { return typeof sourceFn === 'function'; }
    };
  }

  function emptyResult(available, reason) {
    return {
      available: available, entries: [], dropped: 0,
      droppedReasons: {}, truncated: false, reason: reason
    };
  }

  /* 无 provider 时的静态空 catalog —— 供编排层在"没有 catalog"时使用，
     语义与 createGlossaryCatalogProvider(null) 一致（available:false）。 */
  function createEmptyCatalogProvider() {
    return createGlossaryCatalogProvider(null);
  }

  return {
    normalizeAlias: normalizeAlias,
    normalizeEntry: normalizeEntry,
    normalizeCatalog: normalizeCatalog,
    createGlossaryCatalogProvider: createGlossaryCatalogProvider,
    createEmptyCatalogProvider: createEmptyCatalogProvider,
    compareEntries: compareEntries,
    MAX_CATALOG_ENTRIES: MAX_CATALOG_ENTRIES,
    MAX_ALIAS_CHARS: MAX_ALIAS_CHARS,
    MAX_TARGET_ID_CHARS: MAX_TARGET_ID_CHARS,
    TARGET_TYPES: TARGET_TYPES.slice(),
    ENTRY_KINDS: ENTRY_KINDS.slice(),
    DEFAULT_KIND: DEFAULT_KIND,
    UNAVAILABLE_NOT_CONFIGURED: UNAVAILABLE_NOT_CONFIGURED,
    UNAVAILABLE_ERROR: UNAVAILABLE_ERROR,
    UNAVAILABLE_BAD_RESULT: UNAVAILABLE_BAD_RESULT
  };
}));
