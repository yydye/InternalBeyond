/* ====================================================================
   IB Memory Recall · Recall Session State（P21-R2-F1b）· UMD dual-load
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/recall-session-state.js">
              → window.IBMemoryRecallSessionState
   - Node   : require('../assets/js/memory-recall/recall-session-state.js')

   ── 唯一职责 ────────────────────────────────────────────────────────
     session-local、per-character 的 **exposure authority**。

         characterId → memoryId → { lastExposureTurn, exposureCount }
         characterId → 单调 turn counter
         turnObject  → turnIndex            （Browser，WeakMap）
         turnId      → { characterId, turnIndex }（Home Node，**有界**）

   ── 明确不做（契约 §3 / §11 禁区）────────────────────────────────────
     ✗ DB / IndexedDB / localStorage / SQLite / Home Node canonical memory
     ✗ MemoryRecord 写入 / 任何 durable 字段（lastSurfacedAt / lastRecalledAt /
       lastSelectedAt / lastChannel / lastCooldownAt **一律不存在**）
     ✗ export / import / backup / migration
     ✗ Date.now / 任何 wall-clock（cooldown 按 **turn distance**，不按时间）
     ✗ ACL / ranking / relevance / selector / 渲染 / activation

   ── 为什么是嵌套 Map 而不是字符串键 ──────────────────────────────────
     `characterId + ":" + memoryId` 会碰撞：("a:b","c") 与 ("a","b:c") 得到同一个
     字符串。MEMORY_RECORD_CONTRACT.md 对 id **没有字符集限制**，因此不能靠
     "id 不含冒号" 这个未经保证的假设。嵌套 Map 从结构上消除该风险。

   ── 幂等（契约 §15.7 / §D）─────────────────────────────────────────
     刻意**不**使用 per-memory `turnIds: Set`（无上限、无 eviction、
     且把同一逻辑 turn 复制到每条 memory 上）。改为：
         lastExposureTurn === turnIndex  ⇒ no-op
     这天然幂等，且状态量与 (character, memory) 数量同阶。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryRecallSessionState = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* 只有非空字符串才算合法身份；其余一律 fail closed（返回 null，不猜）。 */
  function idOf(v) {
    if (typeof v !== 'string') return null;
    var s = v;
    return s.length ? s : null;
  }

  function createRecallSessionState() {
    /* characterId → Map<memoryId, {lastExposureTurn, exposureCount}> */
    var exposures = new Map();
    /* characterId → 单调 turn counter */
    var turnCounters = new Map();
    /* Browser：turn 对象身份 → turnIndex（由对象自身被 GC 界定，无需手工清理） */
    var browserTurnIndex = new WeakMap();
    /* Home Node：turnId → {characterId, turnIndex}；**必须在 endHomeTurn 删除** */
    var homeTurnIndex = new Map();

    function counterOf(characterId) {
      var n = turnCounters.get(characterId);
      return (typeof n === 'number') ? n : 0;
    }

    /* beginBrowserTurn({characterId, turnObject}) → turnIndex | null
       同一个 turn 对象重复调用**返回同一个 index**（retry / fallback /
       XML continuation 复用同一个 _ibTurn）⇒ 不会重复 increment。 */
    function beginBrowserTurn(input) {
      var o = isPlainObject(input) ? input : {};
      var cid = idOf(o.characterId);
      var turn = o.turnObject;
      if (cid == null) return null;
      if (!turn || (typeof turn !== 'object' && typeof turn !== 'function')) return null;
      var existing = browserTurnIndex.get(turn);
      if (typeof existing === 'number') return existing;
      var next = counterOf(cid) + 1;
      turnCounters.set(cid, next);
      browserTurnIndex.set(turn, next);
      return next;
    }

    /* beginHomeTurn({characterId, turnId}) → turnIndex | null
       同 turnId 重复调用返回同一个 index（duplicate request / retry）。 */
    function beginHomeTurn(input) {
      var o = isPlainObject(input) ? input : {};
      var cid = idOf(o.characterId);
      var tid = idOf(o.turnId);
      if (cid == null || tid == null) return null;
      var rec = homeTurnIndex.get(tid);
      if (rec && typeof rec.turnIndex === 'number') return rec.turnIndex;
      var next = counterOf(cid) + 1;
      turnCounters.set(cid, next);
      homeTurnIndex.set(tid, { characterId: cid, turnIndex: next });
      return next;
    }

    /* endHomeTurn({turnId}) → boolean（释放 turn 身份；成功/失败都必须调用） */
    function endHomeTurn(input) {
      var o = isPlainObject(input) ? input : {};
      var tid = idOf(o.turnId);
      if (tid == null) return false;
      return homeTurnIndex.delete(tid);
    }

    function getExposure(input) {
      var o = isPlainObject(input) ? input : {};
      var cid = idOf(o.characterId);
      var mid = idOf(o.memoryId);
      if (cid == null || mid == null) return null;
      var per = exposures.get(cid);
      if (!per) return null;
      var e = per.get(mid);
      if (!e) return null;
      return { lastExposureTurn: e.lastExposureTurn, exposureCount: e.exposureCount };
    }

    /* recordExposure({characterId, memoryIds, turnIndex}) → number（真正写入的条数）
       · 同一 (character, memory, turnIndex) 重复调用 ⇒ no-op
       · 空 ids / 非法 turnIndex / 非法身份 ⇒ 0，绝不抛
       · **只接受调用方给出的 final injected ids**，本函数不做任何选择 */
    function recordExposure(input) {
      var o = isPlainObject(input) ? input : {};
      var cid = idOf(o.characterId);
      var t = o.turnIndex;
      if (cid == null) return 0;
      if (typeof t !== 'number' || !isFinite(t)) return 0;
      var ids = Array.isArray(o.memoryIds) ? o.memoryIds : [];
      if (!ids.length) return 0;
      var per = exposures.get(cid);
      if (!per) { per = new Map(); exposures.set(cid, per); }
      var written = 0;
      for (var i = 0; i < ids.length; i++) {
        var mid = idOf(ids[i]);
        if (mid == null) continue;
        var cur = per.get(mid);
        if (cur && cur.lastExposureTurn === t) continue;   /* 幂等 */
        per.set(mid, {
          lastExposureTurn: t,
          exposureCount: (cur && typeof cur.exposureCount === 'number') ? cur.exposureCount + 1 : 1
        });
        written++;
      }
      return written;
    }

    function currentTurnIndex(input) {
      var o = isPlainObject(input) ? input : {};
      var cid = idOf(o.characterId);
      if (cid == null) return 0;
      return counterOf(cid);
    }

    function clear() {
      exposures.clear();
      turnCounters.clear();
      homeTurnIndex.clear();
      /* WeakMap 无法枚举/清空；换一个新实例即可（旧对象随 GC 消失）。 */
      browserTurnIndex = new WeakMap();
    }

    /* 仅供测试/诊断：**只暴露计数**，不暴露任何 memory 内容。 */
    function debugSize() {
      var memories = 0;
      exposures.forEach(function (per) { memories += per.size; });
      return {
        characters: exposures.size,
        memories: memories,
        turnCounters: turnCounters.size,
        homeTurns: homeTurnIndex.size
      };
    }

    return {
      beginBrowserTurn: beginBrowserTurn,
      beginHomeTurn: beginHomeTurn,
      endHomeTurn: endHomeTurn,
      getExposure: getExposure,
      recordExposure: recordExposure,
      currentTurnIndex: currentTurnIndex,
      clear: clear,
      debugSize: debugSize
    };
  }

  return { createRecallSessionState: createRecallSessionState };
}));
