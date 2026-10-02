/* ====================================================================
   IB Memory Recall · Cooldown（P21-R2-F1b）· UMD dual-load
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/memory-recall/cooldown.js">
              → window.IBMemoryRecallCooldown
   - Node   : require('../assets/js/memory-recall/cooldown.js')

   ── 唯一职责 ────────────────────────────────────────────────────────
     纯函数：已知 exposure + turn distance + channel mode → factor。

         computeCooldown({channel, currentTurnIndex, exposure, policy})
           → { factor, bypassed, reason }

   ── 契约（MEMORY_COOLDOWN_CONTRACT.md）─────────────────────────────
     distance = currentTurnIndex - lastExposureTurn
       无 exposure / distance <= 0 → 1
       surface:  d1 → 0.40   d2 → 0.70   d>=3 → 1      （recoveryTurns = 3）
       recall / glossary: BYPASS —— selection factor 恒 1
       coldStart: READ-NONE —— 不读 cooldown，factor 恒 1

     不变量：0 < factor <= 1 · deterministic · **不读 wall-clock**

   ── 明确不做（契约 §11 禁区）────────────────────────────────────────
     ✗ 读 global session state（state 由调用方传入）
     ✗ 读 DB / IndexedDB / SQLite / MemoryRecord telemetry
     ✗ Date.now / 任何时钟
     ✗ sort / select / ACL / relevance / 渲染
     ✗ 写 exposure（写入是 state 的职责）

   ── reason 的诚实性（契约 §19 / §27）────────────────────────────────
     只有**真实存在 active cooldown**（0 < distance < recoveryTurns）时，
     bypass 通道才报 `cooldown-bypassed`。从未 exposure 过的 candidate 不会被
     贴上 bypass 标签 —— 那会把"查过了、没有"伪装成"绕过了惩罚"。
     coldStart 是 read-none：它**从不查询**，因此也从不产生任何 cooldown reason。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMemoryRecallCooldown = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* channel mode（declarative）：
       'obey'      —— 受 cooldown 影响（surface）
       'bypass'    —— selection 不受影响，但**知道**是否存在 active cooldown（recall / glossary）
       'read-none' —— 完全不读 cooldown（coldStart）
     未列出的 channel 一律按 'obey' 处理（fail-safe：不认识就按最保守的可用语义走）。 */
  var MODES = {
    surface: 'obey',
    recall: 'bypass',
    glossary: 'bypass',
    coldStart: 'read-none'
  };

  var DEFAULT_POLICY = Object.freeze({ 1: 0.40, 2: 0.70, recoveryTurns: 3 });

  var REASON_PENALTY = 'cooldown-penalty';
  var REASON_BYPASSED = 'cooldown-bypassed';

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function modeOf(channel) {
    var c = (typeof channel === 'string') ? channel : '';
    return MODES[c] || 'obey';
  }

  /* 按 distance 求 factor。d<1（含同轮/陈旧）→ 1；d>=recoveryTurns → 1。 */
  function factorForDistance(distance, policy) {
    var p = isPlainObject(policy) ? policy : DEFAULT_POLICY;
    var d = Math.floor(Number(distance));
    if (!isFinite(d) || d < 1) return 1;
    var recovery = Number(p.recoveryTurns);
    if (!isFinite(recovery) || recovery < 2) recovery = DEFAULT_POLICY.recoveryTurns;
    if (d >= recovery) return 1;
    var f = Number(p[d]);
    /* 非法/越界一律 fail-safe → 1（绝不 clamp 成 0.01，也绝不让候选消失）。 */
    if (!isFinite(f) || f <= 0 || f > 1) return 1;
    return f;
  }

  /* distanceOf(currentTurnIndex, exposure) → number | null
     无 exposure / 参数非法 ⇒ null（调用方据此判定"从未浮现"）。 */
  function distanceOf(currentTurnIndex, exposure) {
    if (!isPlainObject(exposure)) return null;
    var last = Number(exposure.lastExposureTurn);
    var cur = Number(currentTurnIndex);
    if (!isFinite(last) || !isFinite(cur)) return null;
    return cur - last;
  }

  function computeCooldown(input) {
    var o = isPlainObject(input) ? input : {};
    var mode = modeOf(o.channel);

    /* coldStart：**不读** —— 连 distance 都不算，因此不可能产生 penalty / bypass reason。 */
    if (mode === 'read-none') {
      return { factor: 1, bypassed: false, reason: null, distance: null, mode: mode };
    }

    var d = distanceOf(o.currentTurnIndex, o.exposure);
    /* 从未 exposure ⇒ factor 1，且**不带**任何 cooldown reason。 */
    if (d === null) return { factor: 1, bypassed: false, reason: null, distance: null, mode: mode };

    var f = factorForDistance(d, o.policy);
    var active = f < 1;   /* 只有 0 < d < recoveryTurns 才可能 <1 */

    if (mode === 'bypass') {
      return {
        /* selection 恒不受影响 */
        factor: 1,
        bypassed: active,
        reason: active ? REASON_BYPASSED : null,
        distance: d,
        mode: mode
      };
    }

    return {
      factor: f,
      bypassed: false,
      reason: active ? REASON_PENALTY : null,
      distance: d,
      mode: mode
    };
  }

  return {
    computeCooldown: computeCooldown,
    factorForDistance: factorForDistance,
    distanceOf: distanceOf,
    modeOf: modeOf,
    MODES: MODES,
    DEFAULT_POLICY: DEFAULT_POLICY,
    REASON_PENALTY: REASON_PENALTY,
    REASON_BYPASSED: REASON_BYPASSED
  };
}));
