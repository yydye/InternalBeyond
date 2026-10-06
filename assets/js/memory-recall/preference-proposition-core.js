/* ====================================================================
   IB Memory · Canonical Preference Proposition Core（P5-B3-E-R1）
   --------------------------------------------------------------------
   UMD 双载：
     - Browser: <script src="assets/js/memory-recall/preference-proposition-core.js">
     - Node   : require('./preference-proposition-core.js')
   **零依赖 / 零 window / 零 DOM / 零 IO / 零模型调用 / 零副作用**。

   ── 它存在的唯一理由：一处定义 ────────────────────────────────────────
   一条"用户对 X 的立场"必须能用**同一个**字符串表示在两侧：

     Prediction 侧（P2 建档快照）:
       predictionSnapshotAtCreation.semanticPayload.expectedOutcome.token
     Report 侧（P1 观察）:
       outcomeRef.token

   否则 P3 的机械 relation 就只能在**两套 ontology** 之间猜（而"猜"在本
   项目里是禁止的）。本模块就是那**一套** representation 的唯一出处：

     token = 'pref.' + stance + '.' + targetKey
     stance ∈ { like, dislike }      （闭集，恰好两个）
     targetKey = 规范化后的 canonical target（小写 + 受限字符集）

   ── 为什么是 token 而不是新增 schema 字段 ──────────────────────────────
   P2 的 `expectedOutcome.token` 是既有、已冻结、**唯一**承载"期望值"的字
   段（`prediction-record-core.js` 只对它做长度约束）。新增一个
   `object/target` 字段会同时改 P2 schema、P2 验证、P1 观察 schema 三处，
   而本阶段需要的是一个**共享的规范化表示**，不是一个更宽的结构。因此
   第一版把"canonical target representation"定义为这个 token 文法。

   ── fail closed ───────────────────────────────────────────────────────
   · 任何不符合文法的字符串 **不是** canonical preference token；
   · 一旦任一侧进入 `pref.` 命名空间而两侧没有**同时**解析成功，
     机械 relation **不得**产 conflict（见 prediction-settlement-core）。
   · 不做大小写折叠以外的任何归一化：没有同义词、没有单复数、没有
     上位/下位概念、没有 LLM entity resolution（§35）。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IBMemoryPreferenceProposition = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOKEN_PREFIX = 'pref.';

  /* stance 闭集：**恰好两个**。没有 love / hate / neutral / unsure /
     slightly_like / LIKE_A_LOT —— 它们不在表里，因此只能被拒绝。 */
  var STANCES = Object.freeze(['like', 'dislike']);

  /* targetKey 的 canonical 形态：小写 ASCII + 受限标点。
     首字符必须是字母或数字（禁止以分隔符开头，避免 '..' 之类的伪造形态）。
     长度 1..48。
     ★ 它**不是**语义归一化：只做大小写折叠与字符集约束。 */
  var TARGET_KEY_MAX = 48;
  var CANONICAL_TARGET_KEY = /^[a-z0-9][a-z0-9._:-]{0,47}$/;
  /* 客户端提交时允许的**输入**形态（可以有大写，其余同上）。 */
  var INPUT_TARGET_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,47}$/;

  /* token 的完整文法。targetKey 段与上面的 canonical 形态逐字一致。 */
  var CANONICAL_TOKEN = /^pref\.(like|dislike)\.[a-z0-9][a-z0-9._:-]{0,47}$/;

  /* 与 P1 observation core 的 BOUNDS.MAX_TOKEN = 80 对齐：
     'pref.'(5) + 'dislike'(7) + '.'(1) + 48 = 61 ≤ 80。 */
  var MAX_TOKEN_LENGTH = 61;

  function text(v) { return v == null ? '' : String(v); }

  function isStance(v) { return STANCES.indexOf(text(v)) >= 0; }

  /* 客户端提交的 target → canonical target（小写）。失败返回 null。 */
  function canonicalTargetKey(raw) {
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s || s.length > TARGET_KEY_MAX) return null;
    if (!INPUT_TARGET_KEY.test(s)) return null;
    return s.toLowerCase();
  }

  /* 由 (stance, canonical target) 构造 token。任一不合法返回 null。 */
  function buildPreferenceToken(stance, canonicalTarget) {
    if (!isStance(stance)) return null;
    if (typeof canonicalTarget !== 'string' || !CANONICAL_TARGET_KEY.test(canonicalTarget)) return null;
    var token = TOKEN_PREFIX + text(stance) + '.' + canonicalTarget;
    return token.length <= MAX_TOKEN_LENGTH ? token : null;
  }

  /* 该字符串是否落在 `pref.` 命名空间里（**只**看前缀）。
     用途：fail-closed 判据 —— 一旦任一侧进入命名空间，就必须双侧可解析。 */
  function isPreferenceNamespace(token) {
    return text(token).indexOf(TOKEN_PREFIX) === 0;
  }

  /* 解析 canonical token → { stance, targetKey }；不合文法返回 null。 */
  function parsePreferenceToken(token) {
    var s = text(token);
    if (s.length === 0 || s.length > MAX_TOKEN_LENGTH) return null;
    if (!CANONICAL_TOKEN.test(s)) return null;
    var rest = s.slice(TOKEN_PREFIX.length);
    var dot = rest.indexOf('.');
    var stance = rest.slice(0, dot);
    var targetKey = rest.slice(dot + 1);
    if (!isStance(stance) || !CANONICAL_TARGET_KEY.test(targetKey)) return null;
    return { stance: stance, targetKey: targetKey };
  }

  function isCanonicalPreferenceToken(token) {
    return parsePreferenceToken(token) !== null;
  }

  /* 两个 canonical proposition 的**机械**关系（§33/§34/§35）：
       target 不同                ⇒ 'irrelevant'（绝不 conflict）
       target 同 + stance 同      ⇒ 'support'
       target 同 + stance 不同    ⇒ 'conflict'（like/dislike 在该 target 上互斥）
     任一不可解析 ⇒ null（调用方必须 fail closed，不得当 conflict）。 */
  function relatePreferenceTokens(expectedToken, observedToken) {
    var a = parsePreferenceToken(expectedToken);
    var b = parsePreferenceToken(observedToken);
    if (!a || !b) return null;
    if (a.targetKey !== b.targetKey) return 'irrelevant';
    return a.stance === b.stance ? 'support' : 'conflict';
  }

  return {
    TOKEN_PREFIX: TOKEN_PREFIX,
    STANCES: STANCES,
    TARGET_KEY_MAX: TARGET_KEY_MAX,
    MAX_TOKEN_LENGTH: MAX_TOKEN_LENGTH,
    CANONICAL_TARGET_KEY: CANONICAL_TARGET_KEY,
    INPUT_TARGET_KEY: INPUT_TARGET_KEY,
    CANONICAL_TOKEN: CANONICAL_TOKEN,

    text: text,
    isStance: isStance,
    canonicalTargetKey: canonicalTargetKey,
    buildPreferenceToken: buildPreferenceToken,
    isPreferenceNamespace: isPreferenceNamespace,
    parsePreferenceToken: parsePreferenceToken,
    isCanonicalPreferenceToken: isCanonicalPreferenceToken,
    relatePreferenceTokens: relatePreferenceTokens
  };
});
