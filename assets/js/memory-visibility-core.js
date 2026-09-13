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
     ⑤ 读主体显式化 + 记忆读取边界（canReadMemory / changeVisibilityOf，P11-2G）
   五个边界共用，从而在结构上排除"第二套 ACL 规则"。

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

  /* ── 7. 读主体（read principal）· P11-2G 移动记忆读边界 ──────────────
     为什么需要它：`isMemoryVisibleTo(mem, apiId, …)` 表达的是**注入边界**的
     可见性（"这条记忆能否进入该角色的 prompt"），但它在**签名上**没有说清
     "apiId 是谁" —— 调用方很容易把"移动 owner / 设备 id / 会话 id"当成角色
     传进来，从而得到一个看起来通过的判定。P11-2G 把读主体显式化：

         owner    记录所属（memory-store 的 owner_id）—— 只做**分区**，不是权限
         viewer   本次读取的**主体**（角色 id）—— 唯一进入可见性判定的身份
         subject  记录所描述的对象 —— 既有模型里**没有**这个维度（见 canReadMemory）

     ── 为什么没有第二套可见性语义 ────────────────────────────────────────
     `canReadMemory` 不重新实现任何规则：它只做三件事 ——（1）把读主体归一化；
     （2）把"缺失/畸形/未知/空主体"这些**本模块此前没有代表**的情形显式判为
     拒绝；（3）把判定委托给**同一个** isMemoryVisibleTo。因此它与
     memory-retrieval-core（浏览器与 Home Node 共用）、thread-retrieval、
     understanding-* 的注入判定逐字同源，不可能漂移出第二套语义。

     `VISIBILITY_CATEGORIES` 是**已有**的四档存储词表的冻结副本（memory-store
     的 visibility 列、understanding-store 的合法档位检查都用的就是这四个）。
     它只用于**归类**拒绝原因与判"未知档位"，从不用来放行任何记录。 */

  var VISIBILITY_CATEGORIES = ['public', 'only', 'except', 'private'];

  var ACCESS_REASON = {
    ok: 'ok',
    no_principal: 'no-principal',
    missing_visibility: 'missing-visibility',
    malformed_visibility: 'malformed-visibility',
    unknown_visibility: 'unknown-visibility',
    stamp_denied: 'stamp-denied',
    hidden: 'hidden',
    deleted: 'deleted',
    no_record: 'no-record',
    core_unavailable: 'core-unavailable'
  };

  /* 读主体归一化。只接受非空字符串（或 {id} 对象）—— 返回 null 表示
     "无法证明这个读主体是谁"，调用方必须据此 fail closed。
     刻意**不**回退到 owner / 设备 id / 会话 id：那不是读主体的替代品。 */
  function normalizeViewer(viewer) {
    if (viewer == null) return null;
    var raw = viewer;
    if (typeof viewer === 'object') {
      if (Array.isArray(viewer)) return null;
      if (viewer.kind != null && String(viewer.kind) !== 'role') return null;
      raw = viewer.id;
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    var id = String(raw).trim();
    return id ? id : null;
  }
  function categoryOf(visibility) {
    if (visibility == null || visibility === '') return 'missing';
    if (typeof visibility !== 'string') return 'malformed';
    return VISIBILITY_CATEGORIES.indexOf(visibility) >= 0 ? visibility : 'unknown';
  }

  /* ── 8. 唯一 canonical 读谓词 ────────────────────────────────────────
     canReadMemory(record, principal, context) → { ok, reason, category, viewer }

     · pure / deterministic / 无 IO / 无全局可变状态。
     · 不可判定的输入**一律拒绝**，并给出稳定 reason（可断言、可观测）。
     · context.stamp 只用于**派生制品**（理解 / 线索）：制品先过印章再过证据，
       两条都成立才可读 —— 与 attestDerivedArtifact 同一纪律。

     这里如实记录两条**既有**语义（P11-2G 只把它们显式化，**未**改动）：
       · `private` 是硬性的："任何主体都不注入"（isMemoryVisibleTo 的第一行在
         任何 viewer 判定**之前**就返回 false）。因此**不存在**"owner 因为拥有
         它就自动可读"这回事 —— 读边界不该比注入边界更宽。P11-2G 测试把这条
         钉住，而不是顺手放宽它（那是另一个阶段、另一处契约）。
       · `subject` 维度在既有模型里**不存在**：记忆没有"关于谁"的字段。
         归属只有一个 —— `createdBy`（缺省 'user'），它在 store 里被提升成
         owner_id **分区键**（memory-contract.js ownerIdOf 已明确："ACL 仍然是
         visibility / visibleTo / excludeFrom"）。因此本谓词**只**依据
         visibility 判定，绝不依据"是不是这条记录的创建者" —— 那会凭空发明
         一条既有模型里没有规则，并让读边界比注入边界更宽。
       · 缺主体（null / 空串 / 非字符串 / kind!=='role'）→ 拒绝。设备 id、
         owner id、会话 id 都**不是**读主体，也不得冒充。 */
  function canReadMemory(record, principal, context) {
    var ctx = context || {};
    var viewer = normalizeViewer(principal);
    var category = categoryOf(record && record.visibility);
    if (!record || typeof record !== 'object') {
      return { ok: false, reason: ACCESS_REASON.no_record, category: category, viewer: viewer };
    }
    if (!viewer) {
      /* 缺主体 → 无法证明它合法。**不是**"按 owner 放行"，也不是"按 public 放行"。 */
      return { ok: false, reason: ACCESS_REASON.no_principal, category: category, viewer: null };
    }
    if (category === 'missing') {
      /* 缺失 visibility（旧数据 / 日记）在既有语义里**判不可见**，P11-2G 保持一致：
         不因为"读主体是 owner"就放行（那正是 memory-contract.js 警告过的放宽）。 */
      return { ok: false, reason: ACCESS_REASON.missing_visibility, category: category, viewer: viewer };
    }
    if (category === 'unknown') {
      return { ok: false, reason: ACCESS_REASON.unknown_visibility, category: category, viewer: viewer };
    }
    if (category === 'malformed') {
      return { ok: false, reason: ACCESS_REASON.malformed_visibility, category: category, viewer: viewer };
    }
    /* 派生制品的印章先于证据：印章不允许该主体 → 直接拒绝，连证据都不看。 */
    if (ctx.stamp && !stampPermits(ctx.stamp, viewer)) {
      return { ok: false, reason: ACCESS_REASON.stamp_denied, category: category, viewer: viewer };
    }
    var visible = false;
    try {
      visible = !!isMemoryVisibleTo(record, viewer, false, false);
    } catch (e) {
      visible = false;   /* 判定自身抛错 → 不可读，绝不"当作可用" */
    }
    if (!visible) return { ok: false, reason: ACCESS_REASON.hidden, category: category, viewer: viewer };
    return { ok: true, reason: ACCESS_REASON.ok, category: category, viewer: viewer };
  }

  /* ── 9. 镜像同步的删除/撤销判定（P11-2G · changes 的撤销语义）────────
     客户端本地镜像是**累加**的：它只会因为收到一条 delete 才删除本地副本。
     因此"某条记忆对该主体不再可读"必须有**一个**事件通知它，否则旧正文会
     永久留在本地。

     本函数回答的就是"这一条变更要发哪种事件"：
       · 行已不存在 / 已软删（物理真相）        → 'deleted'
       · 行存在且对主体可读                     → 'upsert'
       · 行存在但对该主体**不再可读**（收窄 / 撤销）→ 'delete' + 'visibility-revoked'

     复用既有 delete 通道（而不是发明新 verb / 新事件类型）的理由：客户端
     早就实现并测试了"收到 delete 就删本地行"（recordId 键与既有 delete 条目
     逐字同款），撤销因此不需要任何客户端改动，也不会再出现第二套同步语义。 */
  function changeVisibilityOf(record, principal, context) {
    if (!record || typeof record !== 'object') {
      return { event: 'delete', reason: ACCESS_REASON.no_record };
    }
    var decision = canReadMemory(record, principal, context);
    if (decision.ok) return { event: 'upsert', reason: ACCESS_REASON.ok, category: decision.category };
    /* 无法判定可见性（缺 visibility / 畸形 / 未知档位）同样**不能**留在镜像里：
       它与"已撤销"对客户端而言是同一件事 —— 本地副本不再被允许存在。
       这里不把两者混为一个 reason，而是如实透出判定给出的稳定原因。 */
    var revoked = decision.reason === ACCESS_REASON.stamp_denied
      || (decision.category === 'private' || decision.category === 'only' || decision.category === 'except')
      || decision.reason === ACCESS_REASON.missing_visibility
      || decision.reason === ACCESS_REASON.malformed_visibility
      || decision.reason === ACCESS_REASON.unknown_visibility;
    return {
      event: 'delete',
      reason: revoked ? 'visibility-revoked' : decision.reason,
      category: decision.category
    };
  }

  /* 按读主体分类一批行 —— list 路径的归类入口，与上面两条共用同一谓词。
     返回 { readable, refused, byReason }；byReason 只含**计数**与稳定原因，
     绝不含记忆正文（观测面据此记录，见 mobile-gateway 的 memory-* 日志）。 */
  function partitionByAccess(records, principal, context) {
    var rows = Array.isArray(records) ? records : [];
    var readable = [], refused = [], byReason = {};
    for (var i = 0; i < rows.length; i++) {
      var decision = canReadMemory(rows[i], principal, context);
      if (decision.ok) { readable.push(rows[i]); continue; }
      refused.push(rows[i]);
      byReason[decision.reason] = (byReason[decision.reason] || 0) + 1;
    }
    return { readable: readable, refused: refused, byReason: byReason };
  }

  return {
    isMemoryVisibleTo: isMemoryVisibleTo,
    deriveVisibility: deriveVisibility,
    filterDerivationCandidates: filterDerivationCandidates,
    evidenceLiveness: evidenceLiveness,
    liveEvidenceIds: liveEvidenceIds,
    stampPermits: stampPermits,
    attestDerivedArtifact: attestDerivedArtifact,
    /* P11-2G · 移动记忆读边界 */
    normalizeViewer: normalizeViewer,
    canReadMemory: canReadMemory,
    changeVisibilityOf: changeVisibilityOf,
    partitionByAccess: partitionByAccess,
    VISIBILITY_CATEGORIES: VISIBILITY_CATEGORIES,
    ACCESS_REASON: ACCESS_REASON
  };
});
