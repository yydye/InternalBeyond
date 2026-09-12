/* ====================================================================
   IB Memory Visibility Core — runtime-neutral memory 可见性语义（UMD dual-load）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-visibility-core.js"> → window.IBMemoryVisibilityCore
              （必须在 memory.js 之前加载）
   - Node   : require('../assets/js/memory-visibility-core.js')
   - 规则：零 window / 零 DOM / 零 IndexedDB / 零 localStorage / 零副作用 / 纯函数。

   为什么存在：memory 的可见性语义此前只以字面量形式存在于 memory.js
   （isMemoryVisibleTo / _memoryDeriveVisibility）。derivation 侧（consolidation、
   Understanding、Thread）各自携带一份等价判断，任何一处漂移都会让"从角色隐藏的记忆"
   经派生制品回流进该角色的 prompt。本模块把该语义收敛为**唯一实现**，供：
     ① 直接召回（getMemoryContext 的 pre-ranking 过滤）
     ② 派生制品的证据过滤（理解 / 线索 producer）
     ③ 派生制品的可见范围合并（_memoryDeriveVisibility / 写时印章 stamp）
     ④ 证据存活性分类 + 读时存证（fail-closed）
   四个边界共用，从而在结构上排除"第二套 ACL 规则"。

   本模块只编码**既有** IB 语义，不引入新 ACL 模型、不新增可见性档位。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryVisibilityCore = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── 1. 单条记忆对该消费方是否可见 ──────────────────────────────────
     与 memory.js 既有 isMemoryVisibleTo 逐行为等价（含缺失 visibility 判不可见）。

     注意：本函数只回答"这条记忆能否被该消费方使用"。它不是排序函数，
     调用方必须**先**过滤、**再**做 relevance / ranking / top-k（SAFE_PRE_FILTER）。 */
  function isMemoryVisibleTo(mem, apiId, isGroupChat, groupMemEnabled) {
    if (mem.visibility === 'private') return false;
    if (isGroupChat) {
      if (!groupMemEnabled) return false;
      return mem.visibility === 'public';
    }
    if (mem.visibility === 'public') return true;
    if (mem.visibility === 'only') return (mem.visibleTo || []).includes(apiId);
    if (mem.visibility === 'except') return !(mem.excludeFrom || []).includes(apiId);
    return false;
  }

  /* ── 2. 派生制品不得比其证据更宽 ────────────────────────────────────
     多来源合并取**最严格**可见范围。private / 缺失 visibility（旧数据、日记）
     按"不能证明公开"保守处理，绝不放宽成 public：
       - 全部 public           → public
       - 任一 only             → only（visibleTo 取各 only 来源的交集，并保证角色自己能召回）
       - 任一 except           → except（excludeFrom 取各 except 来源的并集）
       - 任一 private          → private
     空来源集是"无法证明公开"的极端情形 → private（fail closed）。 */
  function deriveVisibility(sources, roleId) {
    if (!sources || !sources.length) return { visibility: 'private', visibleTo: [], excludeFrom: [] };
    var rank = 4, onlySets = [], exceptSets = [];
    for (var i = 0; i < sources.length; i++) {
      var m = sources[i], v = m && m.visibility;
      var r = 4;
      if (v === 'private') r = 1;
      else if (v === 'only') r = 2;
      else if (v === 'except') r = 3;
      else if (v === 'public') r = 4;
      else r = 2; /* 缺失 visibility（旧数据/日记）：不能证明公开，按 only 级保守 */
      if (r < rank) rank = r;
      if (v === 'only') onlySets.push((m.visibleTo || []).map(String));
      else if (v === 'except') { var ex = (m.excludeFrom || []).map(String); exceptSets = exceptSets.concat(ex); }
    }
    if (rank <= 1) return { visibility: 'private', visibleTo: [], excludeFrom: [] };
    if (rank === 2 && onlySets.length) {
      var inter = onlySets[0].filter(function (x) {
        for (var j = 1; j < onlySets.length; j++) if (onlySets[j].indexOf(x) < 0) return false;
        return true;
      });
      if (inter.indexOf(String(roleId)) < 0) inter.push(String(roleId)); /* 保证角色自己能召回 */
      return { visibility: 'only', visibleTo: inter, excludeFrom: [] };
    }
    if (rank === 2) return { visibility: 'only', visibleTo: [String(roleId)], excludeFrom: [] };
    if (rank === 3) return { visibility: 'except', visibleTo: [], excludeFrom: Array.from(new Set(exceptSets)) };
    return { visibility: 'public', visibleTo: [], excludeFrom: [] };
  }

  /* ── 3. 派生制品的**证据候选集**（D-1 的规范边界）────────────────────
     producer（consolidation / Understanding / Thread）在把记忆用作模型输入之前，
     必须且只能经过这里。它把"candidate set → visibility/ACL"这一步做成唯一入口，
     使 producer-specific selection 不可能绕过可见性。

     语义 = 既有 consolidation 的 `_vis(m) && (createdBy===role || visibleTo∋role)`：
       · private（或缺 visibility）的记忆即使 createdBy 是该角色也不进入派生
         —— 这正是 D-1：此前 Understanding / Thread 只判 createdBy，因此
            “对某角色隐藏、但由该角色写入”的记忆仍会被送进派生 LLM。 */
  function filterDerivationCandidates(memories, roleId, predicate) {
    var id = String(roleId);
    return (Array.isArray(memories) ? memories : []).filter(function (m) {
      if (!m) return false;
      if (predicate && !predicate(m)) return false;
      if (!isMemoryVisibleTo(m, id, false, false)) return false;
      if (String(m.createdBy || '') === id) return true;
      return Array.isArray(m.visibleTo) && m.visibleTo.map(String).indexOf(id) >= 0;
    });
  }

  /* ── 4. 证据存活性分类（存在 **且** 仍可见）· fail closed ────────────
     返回 {live, hidden, missing, degraded, reason, alive}。

     M1-C.2d Wave 1 · R7 要求区分两种失效原因（都在**既有** status 词表内，
     只新增 closedReason 取值，不新增 status）：
       · missing  —— 证据行已不在（真丢失）        → closedReason='evidence-lost'
       · hidden   —— 证据行仍在，但对该角色不可见  → closedReason='evidence-hidden'
     修复前两者都写成 'evidence-lost'，用户看到的是"记忆丢了"，
     而真相是"你自己把它藏起来了" —— 这会把用户引导去做错误的修复动作。

     fail-closed 的精确含义（修复 D-2 的 fail-open）：
       · memories 不可读（查询抛错 / 非数组）→ 全部计为 missing，且 degraded=true
       · core 不可用                          → 同上
       · id 重复                              → 只按首次出现计一次（caller 用 live.length
                                                与 ids.length 比较，重复 id 会破坏该判据）
       · 证据行已不存在                       → missing
       · 证据行存在但对该角色不可见            → hidden
       · 可见性判定自身抛错                    → hidden（不把无法判定的证据算作可用）
     因此调用方的 `live.length === 0` 在故障时**成立**（制品被标失效），
     而不再像此前那样因 `return ids` 让失效制品静默保持有效。

     roleId 缺省/空 → 不附加可见性谓词，只判存在性（既有调用方语义不变）。 */
  function evidenceLiveness(ids, memories, roleId) {
    var list = Array.isArray(ids) ? ids : [];
    var out = { live: [], hidden: [], missing: [], degraded: false, reason: null, alive: [] };
    if (!list.length) { out.reason = 'no-evidence'; return out; }
    if (!Array.isArray(memories)) { out.degraded = true; out.missing = list.map(String); out.reason = 'missing'; return out; }
    var byId = new Map();
    for (var i = 0; i < memories.length; i++) {
      var m = memories[i];
      if (m && m.id != null) byId.set(String(m.id), m);
    }
    var hasRole = (roleId != null && String(roleId) !== '');
    var seen = new Set();
    for (var k = 0; k < list.length; k++) {
      var id = String(list[k]);
      if (seen.has(id)) continue; /* 重复 id 只计一次 */
      seen.add(id);
      var mem = byId.get(id);
      if (!mem) { out.missing.push(id); continue; }
      if (!hasRole) { out.live.push(id); continue; }
      var ok = false;
      try { ok = !!isMemoryVisibleTo(mem, String(roleId), false, false); } catch (e) { ok = false; }
      if (ok) out.live.push(id); else out.hidden.push(id);
    }
    out.alive = out.live;
    out.reason = out.missing.length ? 'missing' : (out.hidden.length ? 'hidden' : null);
    return out;
  }
  /* 既有调用方（只关心"哪些证据算存活"）。 */
  function liveEvidenceIds(ids, memories, roleId) {
    return evidenceLiveness(ids, memories, roleId).live;
  }

  /* ── 5. 派生制品的可见性印章是否对该角色成立（R1 / R4-a）────────────
     stamp = deriveVisibility(evidence, roleId)，即"不得比证据更宽"。
     这里只回答：**印章是否允许该角色消费这个制品**。

     为什么不能只看印章：证据的可见性可以在制品写下之后被收窄，
     而制品里的印章是**当时**的快照。因此 R4 要求印章与证据实况**都**通过
     （见下方 attestDerivedArtifact）—— 印章是审计记录，证据实况才是强制点。

     stamp 缺失/非对象 → false（fail closed：无法证明它不宽，就不注入）。 */
  function stampPermits(stamp, roleId) {
    if (!stamp || typeof stamp !== 'object') return false;
    var id = String(roleId);
    var v = stamp.visibility;
    if (v === 'private') return false;
    if (v === 'public') return true;
    if (v === 'only') return (stamp.visibleTo || []).map(String).indexOf(id) >= 0;
    if (v === 'except') return (stamp.excludeFrom || []).map(String).indexOf(id) < 0;
    return false; /* 缺失/未知 → 不成立 */
  }

  /* ── 6. 读时存证（R4 的强制点）──────────────────────────────────────
     制品只有在**同时**满足两条时才可注入：
       (a) 印章允许该角色（stampPermits）
       (b) 每一条**仍可解析**的证据对该角色都可见（unresolvable 一律算不可见）
     并额外要求证据集非空：一套没有任何证据的制品无从存证，按 fail closed 处理。

     这使"隐藏证据"无法靠"修复遍尚未运行"来拖延 —— 读取即刻生效。 */
  function attestDerivedArtifact(stamp, evidenceIds, memories, roleId) {
    var liveness = evidenceLiveness(evidenceIds, memories, roleId);
    var permits = stampPermits(stamp, roleId);
    var ok = permits && liveness.live.length > 0 && liveness.hidden.length === 0 && liveness.missing.length === 0;
    return {
      ok: ok,
      permits: permits,
      evidence: liveness,
      reason: ok ? null
        : (!permits ? 'stamp-denied'
          : (liveness.missing.length ? 'evidence-lost'
            : (liveness.hidden.length ? 'evidence-hidden' : 'no-evidence')))
    };
  }

  return {
    isMemoryVisibleTo: isMemoryVisibleTo,
    deriveVisibility: deriveVisibility,
    filterDerivationCandidates: filterDerivationCandidates,
    evidenceLiveness: evidenceLiveness,
    liveEvidenceIds: liveEvidenceIds,
    stampPermits: stampPermits,
    attestDerivedArtifact: attestDerivedArtifact
  };
});
