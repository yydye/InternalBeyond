/* ====================================================================
   IB BehaviorEffect Renderer — P21-R4-F.2 · 固定枚举表渲染器（零插值）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/behavior-effect-render.js"> → window.IBBehaviorEffectRender
              （实际由 communication.js 经**既有**动态插入路径装载，见下）
   - Node   : require('./assets/js/behavior-effect-render.js')
   - 规则：零 window（除 UMD 根）· 零 DOM · 零 fetch · 零 storage · 零时钟 · 纯函数。

   ── 它是什么 ────────────────────────────────────────────────────────
   把服务端 authoritative Recall 第 17 键（**闭合 7 键对象或 null**）投影成
   **固定模板**的一段低优先级行为指引，或者明确地"不放置"。

   ── 它**不是**什么（结构性，不是靠约定）────────────────────────────
   它**没有**任何自由文本入口：不接收 L3 原文、不接收 L5 原文、不接收
   `rationale` 自由文本、不接收 prompt fragment / instruction。
   表里的每一行都是**服务端镜像的固定字符串**（`RENDER_TABLE` 与
   `services/home-node/runtime-behavior-effect.js#RENDER_TABLE` **逐字节相等**，
   由 tests/test_r4f_live_behavior_effect_browser.js §0 机械断言）。
   本模块**不拼接**、**不插值**、**不做 best-effort 渲染**：
   未知组合一律 REFUSED。

   ── 输出只有三种形状（冻结）──────────────────────────────────────
     { kind:'PLACEMENT',    lines:[<固定模板行>] }
     { kind:'NO_PLACEMENT' }
     { kind:'REFUSED',      reasonCode:'<闭集原因码>' }

   ── 优先级框架（§12，用**固定文本**表达，不用自由文本拼接）────────
   每一行固定模板都自带：本条是**低优先级**建议，且当它与
   **系统设定（system/developer policy）** 或 **用户明示要求**冲突时，
   以它们为准。因此行为基调**不可能**命令模型违反 system / developer /
   用户明示请求 / 工具安全：它只是一句可被覆盖的语气倾向。

   ── 与 null 的关系 ─────────────────────────────────────────────────
   `null`（服务端说"本轮没有可交付的效果"）⇒ `{kind:'NO_PLACEMENT'}`，
   不是 REFUSED：那是**合法事实**，不是坏对象。只有"形状不对"才 REFUSED。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBBehaviorEffectRender = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = 1;
  var KIND = { PLACEMENT: 'PLACEMENT', NO_PLACEMENT: 'NO_PLACEMENT', REFUSED: 'REFUSED' };
  var MAX_SOURCE_TURN_CHARS = 200;

  /* ── 闭集词表：与服务端 runtime-behavior-effect.js 逐值一致 ────────── */
  var STANCES = ['neutral', 'warm', 'guarded', 'focused', 'playful', 'apologetic'];
  var STRATEGIES = ['answer_directly', 'ask_clarifying', 'offer_options', 'defer_to_user', 'hold_back'];
  var INITIATIVE_TENDENCIES = ['low', 'normal', 'high'];
  var RATIONALE_CODES = [
    'derived-from-negative-interpretation',
    'derived-from-positive-interpretation',
    'derived-from-uncertain-interpretation',
    'no-signal'
  ];
  /* ★ 冻结 schema 的**唯一**合法值（与服务端 DERIVED_FROM 单元素闭集一致）。 */
  var DERIVED_FROM = 'L3_AND_L5';
  var TTL_TURNS = 1;

  /* 冻结的 7 键（白名单；多一个键就不是 v1 效果）。 */
  var EFFECT_KEYS = ['stance', 'strategy', 'initiativeTendency', 'rationaleCode', 'sourceTurn', 'derivedFrom', 'ttlTurns'];
  /* 免费文本通道：**具名**拒绝（§23 的恶意对象就是这一组）。 */
  var FREE_TEXT_FIELDS = ['promptText', 'instruction', 'fragment', 'guidance', 'text', 'prompt'];
  /* 不属于本对象的情绪 / 关系轴。 */
  var FORBIDDEN_AXES = ['warmth', 'patience', 'openness', 'guardedness', 'protectiveness', 'trust', 'familiarity', 'affinity'];

  /* ── 固定渲染表（**服务端镜像**；逐字节相等由测试断言）─────────────── */
  var RENDER_TABLE = {
    'warm|answer_directly|normal': '【行为基调·低优先级】本轮语气偏暖，直接回应；与系统设定或用户明示要求冲突时，以它们为准。',
    'guarded|ask_clarifying|low': '【行为基调·低优先级】本轮先确认再展开，不主动扩大话题；与系统设定或用户明示要求冲突时，以它们为准。',
    'neutral|offer_options|normal': '【行为基调·低优先级】本轮给出选项，不替对方决定；与系统设定或用户明示要求冲突时，以它们为准。'
  };
  /* ★ 中性 = **一等合法结果**，但固定渲染器**不放置**任何一行：
     结构化的效果存在 ≠ 一定要污染 prompt。 */
  var NO_PLACEMENT_KEYS = ['neutral|answer_directly|normal'];

  /* 机器可读的优先级声明（与固定模板文本同义；供审计与测试断言）。 */
  var PRIORITY = 'SYSTEM_DEVELOPER_POLICY > EXPLICIT_USER_REQUEST > BOUNDED_BEHAVIOR_EFFECT_GUIDANCE';
  var PLACEMENT_TARGET = 'DEDICATED_SYSTEM_ROLE_MESSAGE';
  var MIRROR_OF = 'services/home-node/runtime-behavior-effect.js#RENDER_TABLE';

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function text(v) { return v == null ? '' : String(v); }
  function bounded(v, n) { return text(v).slice(0, n); }
  function keyOf(e) { return [text(e.stance), text(e.strategy), text(e.initiativeTendency)].join('|'); }

  /* ── 严格校验：任何未知 / 缺失 / 非法 / 隧道字段 ⇒ 不是效果 ──────────
     顺序与服务端 validateEffect **逐条同序**：免费文本 → 情绪轴 → 未知键 →
     缺字段 → 枚举 → derivedFrom → sourceTurn → ttlTurns。 */
  function validate(effect) {
    if (!isPlainObject(effect)) return { ok: false, reasonCode: 'effect-not-an-object' };
    for (var i = 0; i < FREE_TEXT_FIELDS.length; i++) {
      if (has(effect, FREE_TEXT_FIELDS[i])) return { ok: false, reasonCode: 'free-text-field-present:' + FREE_TEXT_FIELDS[i] };
    }
    for (var j = 0; j < FORBIDDEN_AXES.length; j++) {
      if (has(effect, FORBIDDEN_AXES[j])) return { ok: false, reasonCode: 'forbidden-axis-present:' + FORBIDDEN_AXES[j] };
    }
    var keys = Object.keys(effect);
    for (var k = 0; k < keys.length; k++) {
      if (EFFECT_KEYS.indexOf(keys[k]) < 0) return { ok: false, reasonCode: 'unknown-field:' + bounded(keys[k], 40) };
    }
    for (var m = 0; m < EFFECT_KEYS.length; m++) {
      if (!has(effect, EFFECT_KEYS[m])) return { ok: false, reasonCode: 'missing-field:' + EFFECT_KEYS[m] };
    }
    if (STANCES.indexOf(effect.stance) < 0) return { ok: false, reasonCode: 'stance-not-in-closed-set' };
    if (STRATEGIES.indexOf(effect.strategy) < 0) return { ok: false, reasonCode: 'strategy-not-in-closed-set' };
    if (INITIATIVE_TENDENCIES.indexOf(effect.initiativeTendency) < 0) return { ok: false, reasonCode: 'initiativeTendency-not-in-closed-set' };
    if (RATIONALE_CODES.indexOf(effect.rationaleCode) < 0) return { ok: false, reasonCode: 'rationaleCode-not-in-closed-set' };
    if (effect.derivedFrom !== DERIVED_FROM) return { ok: false, reasonCode: 'derivedFrom-must-be-L3_AND_L5' };
    var sourceTurn = text(effect.sourceTurn);
    if (!sourceTurn || sourceTurn.length > MAX_SOURCE_TURN_CHARS) return { ok: false, reasonCode: 'sourceTurn-missing-or-too-long' };
    if (effect.ttlTurns !== TTL_TURNS) return { ok: false, reasonCode: 'ttlTurns-must-be-1' };
    return { ok: true, reasonCode: null };
  }

  /* ── 唯一的渲染入口（纯函数，无副作用）──────────────────────────────
     null / undefined ⇒ NO_PLACEMENT（服务端说"没有效果"是合法事实）。
     形状不合法 ⇒ REFUSED + reasonCode（绝不 best-effort）。 */
  function render(effect) {
    if (effect === null || effect === undefined) return { kind: KIND.NO_PLACEMENT };
    var v = validate(effect);
    if (!v.ok) return { kind: KIND.REFUSED, reasonCode: v.reasonCode };
    var key = keyOf(effect);
    if (has(RENDER_TABLE, key)) {
      var line = RENDER_TABLE[key];
      if (typeof line !== 'string' || !line) return { kind: KIND.REFUSED, reasonCode: 'render-row-invalid' };
      return { kind: KIND.PLACEMENT, lines: [line] };
    }
    if (NO_PLACEMENT_KEYS.indexOf(key) >= 0) return { kind: KIND.NO_PLACEMENT };
    return { kind: KIND.REFUSED, reasonCode: 'no-render-row' };
  }

  return {
    VERSION: VERSION,
    KIND: KIND,
    render: render,
    validate: validate,
    keyOf: keyOf,
    /* 词表 / 表 / 契约常量（镜像与契约由测试逐字断言） */
    STANCES: STANCES,
    STRATEGIES: STRATEGIES,
    INITIATIVE_TENDENCIES: INITIATIVE_TENDENCIES,
    RATIONALE_CODES: RATIONALE_CODES,
    DERIVED_FROM: DERIVED_FROM,
    TTL_TURNS: TTL_TURNS,
    EFFECT_KEYS: EFFECT_KEYS,
    FREE_TEXT_FIELDS: FREE_TEXT_FIELDS,
    FORBIDDEN_AXES: FORBIDDEN_AXES,
    RENDER_TABLE: RENDER_TABLE,
    NO_PLACEMENT_KEYS: NO_PLACEMENT_KEYS,
    PRIORITY: PRIORITY,
    PLACEMENT_TARGET: PLACEMENT_TARGET,
    MIRROR_OF: MIRROR_OF
  };
});
