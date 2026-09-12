/* ====================================================================
   IB Memory Contract — `memories` 记录的运行时中立契约（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-contract.js"> → window.IBMemoryContract
   - Node   : require('../assets/js/memory-contract.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零跨进程 I/O / 纯函数。

   为什么存在（M1-C.2d Wave 2）：
     `memories` 的权威搬到 Home Node 之后，"两条记录是不是同一条"必须有一个
     **两边都同意**的定义，否则：
       · Node 的 skip 判定可能与迁移方认定的"没变"不一致 → 迁移不再幂等；
       · 镜像重建时"哪个字段是内容、哪个是遥测"会各判各的。

   本文件只编码**既有** IB 语义，不新增字段、不改词表。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryContract = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MEMORY_STORE = 'memories';

  /* ── 遥测字段：**不参与**内容等价判定 ────────────────────────────────
     activationCount / lastActivated 是"排名提示"，不是内容：
       · 它们每一轮对话都在变（getMemoryContext 的强化阶段）；
       · 若参与等价判定，迁移重跑会因为计数漂移而全部变成 updated，
         幂等性立刻失效（Wave 1 §7.6c）。
     同理 lastConsolidatedAt 是归纳水位（会被 consolidate 主动推进），
     visibilityRepairedAt / visibilityRepairReason 是修复审计戳 ——
     它们描述的是"这条记忆被处理过"，而不是"这条记忆是什么"。

     注意：**只从等价判定里排除**，不是从记录里排除。payload 仍然完整保存
     这些字段（约束 5：未知字段必须能往返）。 */
  var TELEMETRY_FIELDS = [
    'activationCount',
    'lastActivated',
    'lastConsolidatedAt',
    'visibilityRepairedAt',
    'visibilityRepairReason'
  ];

  function isTelemetryField(key) { return TELEMETRY_FIELDS.indexOf(String(key)) >= 0; }

  /* 稳定序列化：按键名排序，因此"同样的字段、不同的插入顺序"不会被当成内容变化。
     与 chat-store.js 的 stableStringify 同思路，但多一层遥测字段剔除。 */
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    var keys = Object.keys(value).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(JSON.stringify(keys[i]) + ':' + stableStringify(value[keys[i]]));
    }
    return '{' + parts.join(',') + '}';
  }

  /* 剥掉遥测字段后的**新对象**（绝不改原对象 —— 调用方可能还要用完整记录）。 */
  function stripTelemetry(record) {
    var out = {};
    if (!record || typeof record !== 'object') return out;
    var keys = Object.keys(record);
    for (var i = 0; i < keys.length; i++) {
      if (!isTelemetryField(keys[i])) out[keys[i]] = record[keys[i]];
    }
    return out;
  }

  /* 内容投影 + 指纹：迁移与写入路径用同一个函数判断"内容是否相同"。 */
  function contentProjection(record) { return stripTelemetry(record); }
  function contentFingerprint(record) { return stableStringify(stripTelemetry(record)); }
  function contentIdentical(a, b) { return contentFingerprint(a) === contentFingerprint(b); }

  /* ── owner_id 的规范取值 ─────────────────────────────────────────────
     既有 production 语义（memory.js:894 / quickCreateMemory:990）：
       createdBy 缺省即 'user'。它是**分区键**，不是 ACL ——
     ACL 仍然是 visibility / visibleTo / excludeFrom，本文件不碰它们。 */
  function ownerIdOf(record) {
    var by = record && record.createdBy;
    var s = (by == null ? '' : String(by)).trim();
    return s || 'user';
  }

  /* ── 结构性校验（**不**是语义校验）──────────────────────────────────
     只拒绝 Node 无法安全存储的记录；visibility 的合法性**刻意不检查**：
     缺失/拼错的 visibility 必须原样存下去，因为 C1 的 fail-closed
     （isMemoryVisibleTo 末尾 return false）正是靠"缺失保持缺失"成立的。
     在这里替用户补一个 'public' 会把一条不可见记忆变成公开记忆。 */
  function validateRecord(record) {
    var errors = [];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { ok: false, errors: ['not-an-object'] };
    }
    var id = record.id;
    if (id == null || String(id).trim() === '') errors.push('missing-id');
    else if (String(id).length > 200) errors.push('id-too-long');
    if (record.visibility != null && typeof record.visibility !== 'string') errors.push('visibility-not-a-string');
    if (record.visibleTo != null && !Array.isArray(record.visibleTo)) errors.push('visibleTo-not-an-array');
    if (record.excludeFrom != null && !Array.isArray(record.excludeFrom)) errors.push('excludeFrom-not-an-array');
    return { ok: errors.length === 0, errors: errors };
  }

  /* 提升为查询列时的**保守**取值：无法解析的时间戳落 0（而不是"现在"），
     否则一条时间戳损坏的旧记忆会在排序里跳到最新，改变召回顺序。 */
  function intOf(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    return Math.trunc(n);
  }
  function createdAtOf(record) {
    if (!record) return 0;
    return intOf(record.created != null ? record.created : record.createdAt);
  }
  function lastActivatedAtOf(record) {
    if (!record || record.lastActivated == null) return null;
    var n = Number(record.lastActivated);
    return isFinite(n) ? Math.trunc(n) : null;
  }

  return {
    MEMORY_STORE: MEMORY_STORE,
    TELEMETRY_FIELDS: TELEMETRY_FIELDS,
    isTelemetryField: isTelemetryField,
    stableStringify: stableStringify,
    stripTelemetry: stripTelemetry,
    contentProjection: contentProjection,
    contentFingerprint: contentFingerprint,
    contentIdentical: contentIdentical,
    ownerIdOf: ownerIdOf,
    validateRecord: validateRecord,
    intOf: intOf,
    createdAtOf: createdAtOf,
    lastActivatedAtOf: lastActivatedAtOf
  };
});
