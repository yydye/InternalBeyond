/* ====================================================================
   IB Memory Recall · ColdStart Anchor（P21-R2-E1b）· UMD dual-load
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/coldstart-anchor.js">
              → window.IBMemoryRecallColdStartAnchor
   - Node   : require('../assets/js/memory-recall/coldstart-anchor.js')

   ── 唯一职责 ────────────────────────────────────────────────────────
     从**已经过 visibility 的** canonical Memory records 中，
     筛出 anchor-eligible set。

         records → (shared memory-visibility-core, 由编排层执行)
                 → visible
                 → 本模块：anchor eligibility
                 → canonical core selection

   ── 唯一 admission（§2.2 / §12 冻结）──────────────────────────────
         pinned === true
           OR
         kind === 'semantic'

     · `source === 'manual'` **不**单独获得 admission ——
       manual 只是 provenance（谁写的），不等于长期稳定性。
     · `resolved` **不**作 hard exclusion —— 现有证据只证明它影响
       decay lambda（core: λ = resolved ? 0.12 : 0.05），
       没有证据支持"已了结 ⇒ 不能作长期背景"。
     · identity / relationship / promise 等字段在本仓库**不存在**
       （R2-E0 已取证），因此不得凭名字实现。

   ── 明确不做 ────────────────────────────────────────────────────────
     ✗ ACL（可见性必须**先**由编排层用唯一实现施加，本模块看不到 hidden）
     ✗ 自己的 IO / DB / 时钟 / 随机
     ✗ 渲染 / ranking / 排序（eligibility 是**谓词**，不是排序）
     ✗ activation
     ✗ lexical relevance（§14：current turn 的词元**不得**参与 admission）
     ✗ LLM 判断 / semantic rewrite

   ── 为什么 eligibility 只做谓词、不做排序 ──────────────────────────
     排序（重要性 / memoryValue / pinned 优先 / 预算）属**唯一 canonical
     selector**（memory-retrieval-core）。在这里排序会长出第二套
     ranking —— 正是 R2-D.1 花整轮消除的东西。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryRecallColdStartAnchor = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REASON_PINNED = 'pinned';
  var REASON_SEMANTIC = 'semantic';
  var REASON_NOT_ANCHOR = 'not-cold-start-anchor';
  var REASON_COLD_START_ANCHOR = 'cold-start-anchor';

  var K_SEMANTIC = 'semantic';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /* anchorAdmission(record) → null | 'pinned' | 'semantic'
     返回**为什么**被接纳（供 trace 的 reasons[] 使用），或 null 表示不合格。

     注意：`pinned` 与 `kind==='semantic'` 是**并列**的两个 admission，
     不排序、不优先。两者都成立时返回 'pinned'（第一个命中的谓词），
     仅用于标注，**不**影响任何排序。 */
  function anchorAdmission(record) {
    if (!isPlainObject(record)) return null;
    if (record.pinned === true) return REASON_PINNED;
    if (record.kind === K_SEMANTIC) return REASON_SEMANTIC;
    return null;
  }

  function isAnchorEligible(record) {
    return anchorAdmission(record) !== null;
  }

  /* selectEligibleAnchors(visibleRecords) → {
       anchors  : [record...],   // 原对象引用，**保持输入顺序**
       rejected : [record...],
       admitted : { <id>: 'pinned'|'semantic' }   // 供 trace 标注
     }
     · 不排序、不克隆、不改写
     · 输入应当是**已经过 visibility** 的 records（隐藏项不该出现在这里） */
  function selectEligibleAnchors(visibleRecords) {
    var rows = Array.isArray(visibleRecords) ? visibleRecords : [];
    var anchors = [], rejected = [], admitted = {};
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i];
      if (!isPlainObject(m)) { rejected.push(m); continue; }
      var why = anchorAdmission(m);
      if (why) {
        anchors.push(m);
        if (m.id != null) admitted[String(m.id)] = why;
      } else {
        rejected.push(m);
      }
    }
    return { anchors: anchors, rejected: rejected, admitted: admitted };
  }

  /* coldStartApplicable(signal, options) → boolean
     §22：automatic coldStart 必须**同时**满足全部条件，缺一不可。

       conversationSignalAvailable === true
       isFirstTurn === true
       conversationId 为非空 string
       isGroup !== true          ← §23：群聊本轮不自动 coldStart

     signal unavailable ⇒ **不猜**（返回 false）。
     本函数是纯决策，不读任何 IO。 */
  function coldStartApplicable(signal, options) {
    var s = isPlainObject(signal) ? signal : {};
    var o = isPlainObject(options) ? options : {};
    if (s.conversationSignalAvailable !== true) return false;
    if (s.isFirstTurn !== true) return false;
    if (typeof s.conversationId !== 'string' || !s.conversationId) return false;
    if (o.isGroup === true) return false;
    return true;
  }

  return {
    anchorAdmission: anchorAdmission,
    isAnchorEligible: isAnchorEligible,
    selectEligibleAnchors: selectEligibleAnchors,
    coldStartApplicable: coldStartApplicable,
    REASON_PINNED: REASON_PINNED,
    REASON_SEMANTIC: REASON_SEMANTIC,
    REASON_NOT_ANCHOR: REASON_NOT_ANCHOR,
    REASON_COLD_START_ANCHOR: REASON_COLD_START_ANCHOR
  };
}));
