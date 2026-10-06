/* ====================================================================
   IB Memory · OutcomeObservation Authority Core（Prediction Error P1）
   --------------------------------------------------------------------
   P26_2_OBSERVATION != OUTCOME_OBSERVATION

     P26-2 Observation（`assets/js/observation-core.js`，**本文件不碰**）
       = "现在是什么" —— 只读状态快照，无权威、无证据力。
     OutcomeObservation（本文件）
       = "关于某条 prediction，**后来发生了什么**" —— 有权威等级的结算候选证据。

   ── 本模块唯一的职责 ─────────────────────────────────────────────────
     回答一个问题：
       **"这条后来发生的事实，有没有资格参与某条 Prediction 的结算？"**

   它**不**结算。它不产出 matched / missed / 任何 settlement state，
   不计算 Prediction Error，不做 Calibration，不调模型，不读时钟。
   它只做三件事：
     ① `buildOutcomeObservation()` —— **唯一**合法的 observation 铸造点
     ② `isBuiltObservation()`      —— 能力闸门（身份 + 封存 + schema 三重校验）
     ③ `authorityGate()`           —— 确定性、只降不升、可复算的 authority 结果

   ── 纯度（与 `observation-core.js` / `prediction-observation-core.js` 同一纪律）──
     零 I/O · 零网络 · 零模型 ·零 durable 写 · 零时钟（**不读 Date.now**）·
     零随机（**不用 Math.random**）· 零计数器 · 零 DB · 零 relationship 写。
     时间由调用方注入；id 由确定性摘要派生（复用 `chat-core.stableToken`）。

   ── 边界（P1 硬约束，见 PREDICTION_ERROR_AUTHORITY_CONTRACT.md §D / §I）──────
     ONLY_BUILDER_MINTS_VALID_OUTCOME_OBSERVATION = YES
     `{ ...fields, validated: true }` **不是** authority；公开字段可复制，能力不可复制。
     MODULE_PRIVATE_CAPABILITY = WeakSet(identity) + WeakMap(sealed serialization)
     跨模块实例 / 跨进程 / 浏览器伪造的对象**一律** fail closed。

   ── 静态守卫承诺（tests/test_outcome_observation_authority.js §Static）──────
     本文件不含 fetch / XMLHttpRequest / WebSocket / provider / model 调用 /
     indexedDB / localStorage / dbPut / dbGet / writeFile / Date.now / Math.random /
     memory-store / relationship 写 / trust / affinity / settlement 状态机 /
     calibration 回写。词表与 authority 常量是**唯一**新增面。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var chatCore = null, memoryContract = null, preferenceProposition = null;
    try { chatCore = require('../chat-core.js'); } catch (e) { chatCore = null; }
    try { memoryContract = require('../memory-contract.js'); } catch (e) { memoryContract = null; }
    /* P5-B3-E-R1 · canonical preference proposition 文法的**唯一**出处。
       缺席 ⇒ 结构化偏好通道 fail closed（token 一律判 INCONSISTENT），
       绝不放宽成"看起来像就算"。 */
    try { preferenceProposition = require('./preference-proposition-core.js'); } catch (e) { preferenceProposition = null; }
    module.exports = factory(chatCore, memoryContract, preferenceProposition);
  } else {
    root.IBMemoryOutcomeObservation = factory(
      root.IBChatCore || null,
      root.IBMemoryContract || null,
      root.IBMemoryPreferenceProposition || null
    );
  }
})(typeof self !== 'undefined' ? self : this, function (CHAT_CORE, CONTRACT, PREFERENCE) {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════
     ① 冻结常量（contract §D.1 / §D.2 / §D.3 / §D.4）
     ══════════════════════════════════════════════════════════════════ */

  var SCHEMA_VERSION = 'outcome-observation/v1';
  var ID_PREFIX = 'oo_';
  var PRODUCER_AUTHORITY = 'AUTHORIZED_OBSERVER';
  var FINGERPRINT_AUTHORITY = 'memory-contract.stableStringify';

  /* source 闭集（contract §D.2）。顺序即契约表顺序。 */
  var SOURCES = Object.freeze([
    'CANONICAL_RUNTIME',      /* Home Node / tool / DB / provider 的权威结果 */
    'USER_BEHAVIOR',          /* 用户实际动作（点击 / 发送 / 删除 / 消费） */
    'EXPLICIT_USER_REPORT',   /* 用户显式陈述 */
    'LINGUISTIC_EVIDENCE',    /* 用户文本的语义证据（模型中介抽取 ⇒ 上限被压） */
    'MODEL_INFERENCE',        /* 模型自己的推断 —— 结构性禁止参与 settlement */
    'BEHAVIORAL_TELEMETRY'    /* 回复长度 / 沉默 / 延迟 / 话题延续等派生统计 —— 同上 */
  ]);

  /* targetDomain 闭集。顺序是矩阵列序，**唯一**出处。 */
  var DOMAINS = Object.freeze([
    'runtime_state', 'user_behavior', 'user_preference',
    'user_emotion', 'user_intent', 'latent_state', 'relationship'
  ]);

  /* 域分类：机制域说的是"发生了什么"，主观域说的是"人是什么样的"。
     污染闸门与 payload 一致性闸门都按这个划分工作。 */
  var MECHANISM_DOMAINS = Object.freeze(['runtime_state', 'user_behavior']);
  var SUBJECTIVE_DOMAINS = Object.freeze([
    'user_preference', 'user_emotion', 'user_intent', 'latent_state', 'relationship'
  ]);

  var CONTAMINATION_CLASSES = Object.freeze(['NONE', 'POSSIBLE', 'LIKELY', 'DIRECT', 'UNKNOWN']);
  /* 污染严重度偏序（用于"取更坏的那个"fail-closed 交叉校验）。 */
  var CONTAMINATION_SEVERITY = Object.freeze({
    NONE: 0, POSSIBLE: 1, LIKELY: 2, DIRECT: 3, UNKNOWN: 4
  });

  var ADMISSIBILITY_LEVELS = Object.freeze(['ELIGIBLE', 'SUPPORTING', 'CANDIDATE', 'FORBIDDEN']);
  /* 等级偏序：数值越大越强；min() 取最小。FORBIDDEN 是吸收元。 */
  var ADMISSIBILITY_RANK = Object.freeze({ FORBIDDEN: 0, CANDIDATE: 1, SUPPORTING: 2, ELIGIBLE: 3 });

  var TEMPORAL_VALIDITY = Object.freeze(['within-window', 'before-window', 'after-window', 'unknown']);
  var COMPLETENESS_VALUES = Object.freeze(['point', 'full-window-attested', 'unknown']);
  var OUTCOME_KINDS = Object.freeze(['token', 'numeric', 'statement']);
  var OPPORTUNITY_STATES = Object.freeze(['SATISFIED', 'NOT-REQUIRED', 'ABSENT', 'NOT-CONSUMED', 'UNKNOWN']);
  var SCOPE_GATE_STATES = Object.freeze(['MATCH', 'CHARACTER-MISMATCH', 'CONVERSATION-MISMATCH', 'SUBJECT-MISMATCH']);
  var DOMAIN_PAYLOAD_STATES = Object.freeze(['CONSISTENT', 'INCONSISTENT']);

  /* scope.subjectKind —— 与 contract §C.1 的 SUBJECT_KINDS 逐值一致。
     （TYPE_TABLE / predictionType 属于 P2 Prediction Registry，**不在本文件**。） */
  var SUBJECT_KINDS = Object.freeze([
    'character-self', 'user', 'third-party', 'system', 'world'
  ]);

  /* ── 授权 observer 注册表（contract §D.2）─────────────────────────────
     `source` 合法 **不等于** 该 producer 被授权：`sourceInstance` 必须逐字命中。
     未知 sourceInstance ⇒ FORBIDDEN。 */
  var AUTHORIZED_OBSERVERS = Object.freeze({
    CANONICAL_RUNTIME: Object.freeze([
      'runtime.delivery', 'runtime.popup', 'runtime.activity',
      'runtime.payment', 'runtime.memory-store',
      /* P5-B3-D4-R1 · owner ruling：turn execution runtime 是 canonical runtime
         observer，**scope 仅限 canonical TURN_TERMINAL_FACT projection**。
         精确 token，无 wildcard；allowlist 成员资格**不**授予 RealityEvent mint
         能力（仍须 canonical seal + CANONICAL_RUNTIME provenance）。 */
      'runtime.turn-execution'
    ]),
    USER_BEHAVIOR: Object.freeze([
      'ui.click', 'ui.compose', 'ui.dismiss', 'runtime.user-action'
    ]),
    /* P5-B3-E-R1 · owner ruling：explicit report 的**唯一**生产 observer 是
       "用户显式提交结构化偏好报告"这条窄面（exact token，无 wildcard）。
       `chat.user-utterance` 是 P1 冻结期的**旧泛化名**（语义 = "任意用户聊天
       话语"），它与本轮冻结的 authority model 冲突（raw chat text 明确
       **不**是 explicit report）⇒ **不**复用它做本轮 authority。
       ★ 它被**保留**在表内，理由仅有一条：P1/P3/P5 的既有冻结测试向量用它
         构造"假设存在的 explicit report 观察"，删除会让那些测试失据。
         生产侧**没有任何** producer 会发出它（见 runtime-outcome-observation
         的 PRODUCER_TABLE 与 tests/test_structured_explicit_preference_report）。
       ⇒ 它是一条**无生产来源的假设向量 token**，不是一条通道。 */
    EXPLICIT_USER_REPORT: Object.freeze(['chat.user-utterance', 'user.explicit-preference-report']),
    LINGUISTIC_EVIDENCE: Object.freeze(['runtime.interpretation-evidence']),
    /* 无授权实例 ⇒ 恒 FORBIDDEN（不是"低权重"，是**结构性**不参与）。 */
    MODEL_INFERENCE: Object.freeze([]),
    /* 有实例但矩阵整行 FORBIDDEN ⇒ 双重拦截（注册表 + 矩阵）。 */
    BEHAVIORAL_TELEMETRY: Object.freeze(['runtime.behavior-stats'])
  });

  /* ── Authority Matrix = source × targetDomain（contract §D.2）──────────
     行序与 DOMAINS 严格对应；构造后 deepFreeze。
     这是 **ceiling**，不是最终授权：任何后续闸门只能降低它。 */
  var MATRIX_ROWS = Object.freeze({
    CANONICAL_RUNTIME: Object.freeze([
      'ELIGIBLE', 'ELIGIBLE', 'SUPPORTING', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'
    ]),
    USER_BEHAVIOR: Object.freeze([
      'FORBIDDEN', 'ELIGIBLE', 'SUPPORTING', 'CANDIDATE', 'CANDIDATE', 'FORBIDDEN', 'SUPPORTING'
    ]),
    EXPLICIT_USER_REPORT: Object.freeze([
      'FORBIDDEN', 'SUPPORTING', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE'
    ]),
    LINGUISTIC_EVIDENCE: Object.freeze([
      'FORBIDDEN', 'CANDIDATE', 'SUPPORTING', 'SUPPORTING', 'SUPPORTING', 'FORBIDDEN', 'SUPPORTING'
    ]),
    MODEL_INFERENCE: Object.freeze([
      'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'
    ]),
    BEHAVIORAL_TELEMETRY: Object.freeze([
      'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'
    ])
  });

  var AUTHORITY_MATRIX = (function () {
    var m = {};
    for (var i = 0; i < SOURCES.length; i++) {
      var src = SOURCES[i];
      var row = MATRIX_ROWS[src];
      var cell = {};
      for (var j = 0; j < DOMAINS.length; j++) cell[DOMAINS[j]] = row[j];
      m[src] = Object.freeze(cell);
    }
    return Object.freeze(m);
  })();
  var MATRIX_CELL_COUNT = SOURCES.length * DOMAINS.length;   /* 6 × 7 = 42 */

  /* ── 已注册 payload 词表（contract §D.3）──────────────────────────────
     机制域**必须**用注册过的 token：不允许自由文本冒充"机制事实"。
     `delivery.*` 取自既有 `assets/js/delivery-runtime.js:57`
       STATES = ['queued','delivering','completed','cancelled','failed']（不发明第二套）。
     其余 token 是 **P1 冻结的设计词表**：P1 的生产 observer = 0，
     因此没有任何 token 已被真实生产路径产出。
     ⇒ 词表扩展**必须**是一次显式的相位迁移（与 runtime-seam-guard 同一纪律），
       不得由调用方就地新增。 */
  var RUNTIME_STATE_TOKENS = Object.freeze([
    'delivery.queued', 'delivery.delivering', 'delivery.completed',
    'delivery.cancelled', 'delivery.failed',
    'popup.shown', 'popup.dismissed', 'popup.answered',
    'activity.available', 'activity.unavailable',
    'memory.record-written', 'memory.record-refused',
    /* P5-B3-D4-R2 · owner ruling：canonical TURN_TERMINAL_FACT 进入 directional
       评估词表。语义**仅**表示"该 runtime turn 到达了终局"，
       不表示 turn started / streaming / healthy / provider succeeded /
       prediction matched。入表**不**授予 automatic support / conflict /
       matched / missed / calibration eligibility —— 后续仍须经过 source
       authority · scope · temporal · contamination · opportunity · target
       domain · prediction semantics · mutual-exclusivity · P3 settlement。 */
    'runtime.turn_terminal'
  ]);
  var USER_ACTION_TOKENS = Object.freeze([
    'action.clicked', 'action.dismissed', 'action.composed', 'action.sent',
    'action.deleted', 'action.cancelled', 'action.confirmed',
    'action.ignored', 'action.spent'
  ]);

  /* ── BOUNDS（有界，全部冻结）─────────────────────────────────────────── */
  var BOUNDS = Object.freeze({
    MAX_ID: 200,
    MAX_SOURCE_INSTANCE: 80,
    MAX_TOKEN: 80,
    MAX_UNIT: 24,
    MAX_STATEMENT: 280,
    MAX_REF: 200,
    MAX_BASIS: 120,
    MAX_SUBJECT_LABEL: 80,
    MAX_CHARACTER_ID: 200,
    MAX_CONVERSATION_ID: 200,
    MAX_EVIDENCE_REFS: 32,
    MAX_BEHAVIOR_EFFECTS: 16,
    MAX_REASON_CODES: 64
  });

  /* ── 闭合输入 / 输出键（未知键**拒绝**，不是静默丢弃）────────────────── */
  var INPUT_FIELDS = Object.freeze([
    'observationId', 'predictionId', 'windowRef', 'source', 'sourceInstance',
    'targetDomain', 'observedAt', 'completeness', 'scope', 'outcomeRef',
    'evidenceRefs', 'interventionContext', 'reasonCodes'
  ]);
  var WINDOW_REF_FIELDS = Object.freeze(['predictionId', 'predictionCreatedAt', 'opensAt', 'closesAt']);
  var SCOPE_FIELDS = Object.freeze(['characterId', 'conversationId', 'subjectKind', 'subjectLabel']);
  var INTERVENTION_FIELDS = Object.freeze([
    'behaviorEffectsInForce', 'predictionInfluencedSystem',
    'contaminationClass', 'contaminationBasis',
    /* 结构化事实：用于**系统**确定性判定 class（可选，缺省 false/null） */
    'generatedBySystem', 'downstreamOfSystemAction', 'causalityEstablished'
  ]);
  var BEHAVIOR_EFFECT_FIELDS = Object.freeze([
    'sourceTurn', 'stance', 'strategy', 'initiativeTendency', 'rationaleCode'
  ]);
  var OUTCOME_REF_FIELDS = Object.freeze({
    token: Object.freeze(['kind', 'token']),
    numeric: Object.freeze(['kind', 'value', 'unit']),
    statement: Object.freeze(['kind', 'statement'])
  });

  /* 正文体 / 大对象槽：出现在 outcomeRef 或顶层即拒绝（不是静默丢弃）。
     注意 `numeric` 合法使用 `value` —— 因此这一层按 **kind 白名单**判定，
     而不是按名字黑名单。 */
  var FORBIDDEN_BODY_KEYS = Object.freeze([
    'snapshot', 'payload', 'data', 'content', 'body', 'text', 'state', 'row',
    'record', 'canonical', 'fullstate', 'inline', 'messages', 'memory',
    'base64', 'dataurl', 'buffer', 'blob'
  ]);

  /* ── reasonCodes 闭集 ────────────────────────────────────────────────── */
  var REASON = Object.freeze({
    ok: 'ok',
    /* build 失败 */
    notAnObject: 'not-an-object',
    unknownField: 'unknown-field',
    forbiddenBodyField: 'forbidden-body-field',
    missingRequired: 'missing-required-field',
    fieldTooLong: 'field-exceeds-bound',
    badEnum: 'bad-enum',
    badObservedAt: 'bad-observed-at',
    badTime: 'bad-time-field',
    unknownObserver: 'source-instance-not-authorized-observer',
    unauthorizedSourceInstance: 'unauthorized-source-instance',
    reservedIdPrefix: 'observation-id-prefix-forbidden',
    tooManyItems: 'array-exceeds-bound',
    badRef: 'bad-evidence-ref',
    badNumeric: 'bad-numeric-outcome',
    /* gate 失败 */
    observationNotBuilt: 'observation-not-built',
    schemaInvalid: 'observation-schema-invalid',
    matrixCellMissing: 'matrix-cell-missing',
    scopeContextMissing: 'scope-context-missing',
    temporalUnknown: 'temporal-unknown',
    temporalValidityMismatch: 'temporal-validity-mismatch',
    evidenceBeforeWindow: 'evidence-before-window',
    evidenceAfterWindow: 'evidence-after-window',
    opportunityAbsent: 'opportunity-absent',
    opportunityNotConsumed: 'opportunity-not-consumed',
    opportunityUnknown: 'opportunity-unknown',
    opportunityExistenceNotAuthoritative: 'opportunity-existence-not-canonical-runtime',
    domainPayloadInconsistent: 'domain-payload-inconsistent',
    contaminationCapsSubjectiveDomain: 'contamination-caps-subjective-domain',
    contaminationUnknown: 'contamination-unknown',
    contaminationClassConflict: 'contamination-class-conflict',
    engineMatchCeiling: 'matrix-ceiling',
    gateLowered: 'gate-lowered-admissibility'
  });

  /* ══════════════════════════════════════════════════════════════════
     ② 纯 helper
     ══════════════════════════════════════════════════════════════════ */

  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlainObject(v) {
    if (!isObject(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function str(v, max) {
    if (v == null) return null;
    var s = String(v);
    if (max && s.length > max) return s.slice(0, max + 1);   /* 超长留痕，供判超限 */
    return s;
  }
  function text(v) { return v == null ? '' : String(v); }
  /* ── P5-B3-E-R1 · canonical preference proposition（委托给唯一出处）──────
     文法不在本文件里重新写一遍：`preference-proposition-core.js` 是唯一出处。
     它缺席时这里返回 false（fail closed）⇒ 结构化偏好通道整体不可用，
     而不是"退化成前缀匹配"。 */
  function isCanonicalPreferenceToken(token) {
    return !!(PREFERENCE && typeof PREFERENCE.isCanonicalPreferenceToken === 'function'
      && PREFERENCE.isCanonicalPreferenceToken(token) === true);
  }
  function finiteTime(v) {
    var n = Number(v);
    return (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && isFinite(n) && n > 0 ? n : null;
  }
  function uniq(list) {
    var out = [], seen = Object.create(null);
    (Array.isArray(list) ? list : []).forEach(function (x) {
      if (x == null) return;
      var s = String(x);
      if (!s || seen[s]) return;
      seen[s] = true; out.push(s);
    });
    return out;
  }

  /* 确定性 token：**复用**既有唯一实现（chat-core.stableToken），
     仅在它不可用时才退回逐字相同的本地实现（不发明第二套算法）。 */
  function stableToken(seed) {
    var s = text(seed);
    try {
      if (CHAT_CORE && typeof CHAT_CORE.stableToken === 'function') return text(CHAT_CORE.stableToken(s));
    } catch (e) { /* fall through */ }
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0;
      h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
      h2 = ((h2 ^ c) * 16777619) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36)).slice(0, 12);
  }

  /* 规范化序列化：沿用既有唯一序列化权威（memory-contract.stableStringify）。 */
  function canonicalize(v) {
    try {
      if (CONTRACT && typeof CONTRACT.stableStringify === 'function') return CONTRACT.stableStringify(v);
    } catch (e) { /* fall through */ }
    return JSON.stringify(v);
  }

  function deepFreeze(v) {
    if (!v || typeof v !== 'object' || Object.isFrozen(v)) return v;
    Object.freeze(v);
    Object.keys(v).forEach(function (k) { deepFreeze(v[k]); });
    return v;
  }

  /* ══════════════════════════════════════════════════════════════════
     ③ capability seal —— ONLY_BUILDER_MINTS
     ══════════════════════════════════════════════════════════════════ */

  /* 公开字符串 brand **不是** capability（可被复制）。
     真正的能力由两张**不导出**的模块私有表承担：
       OBSERVATION_IDENTITY  WeakSet —— 只有 builder 真正产出的那个对象才在表里
       OBSERVATION_SEAL      WeakMap —— 该对象封存时的规范化序列化
     ⇒ 普通对象伪造 / 复制 brand / Object.assign 克隆 / JSON round-trip 全部不在表里；
       改写已封存对象会让序列化与封存串不一致。
     跨模块实例：每个实例有自己的表 ⇒ 另一个实例产出的对象**必然**被拒（fail closed）。 */
  var OBSERVATION_IDENTITY = (typeof WeakSet === 'function') ? new WeakSet() : null;
  var OBSERVATION_SEAL = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var HAS_CAPABILITY_PRIMITIVES = !!(OBSERVATION_IDENTITY && OBSERVATION_SEAL);

  function sealObservation(v) {
    if (HAS_CAPABILITY_PRIMITIVES) {
      OBSERVATION_IDENTITY.add(v);
      OBSERVATION_SEAL.set(v, canonicalize(v));
    }
    deepFreeze(v);
    return v;
  }

  /* ══════════════════════════════════════════════════════════════════
     ④ 独立可测的确定性原语（每个 gate 一个，互不依赖）
     ══════════════════════════════════════════════════════════════════ */

  function admissibilityOf(value, fallback) {
    return ADMISSIBILITY_LEVELS.indexOf(String(value)) >= 0 ? String(value) : (fallback || 'FORBIDDEN');
  }

  /* 取最小等级：FORBIDDEN 是吸收元。空列表 ⇒ FORBIDDEN（fail-closed，不是"无约束"）。 */
  function minAdmissibility(list) {
    var arr = Array.isArray(list) ? list : [];
    if (!arr.length) return 'FORBIDDEN';
    var best = 'ELIGIBLE', sawAny = false;
    for (var i = 0; i < arr.length; i++) {
      var lv = admissibilityOf(arr[i], 'FORBIDDEN');
      if (!sawAny) { best = lv; sawAny = true; continue; }
      if (ADMISSIBILITY_RANK[lv] < ADMISSIBILITY_RANK[best]) best = lv;
    }
    return sawAny ? best : 'FORBIDDEN';
  }

  function matrixCeiling(source, targetDomain) {
    var row = isObject(AUTHORITY_MATRIX) ? AUTHORITY_MATRIX[String(source)] : null;
    if (!row) return null;
    if (DOMAINS.indexOf(String(targetDomain)) < 0) return null;
    return row[String(targetDomain)] || null;
  }

  function isAuthorizedObserver(source, sourceInstance) {
    var list = AUTHORIZED_OBSERVERS[String(source)];
    if (!list || !list.length) return false;
    return list.indexOf(String(sourceInstance)) >= 0;
  }

  /* ── temporal gate 原语（contract (q-7) / §E.2 T2）────────────────────
     OUTCOME_OBSERVATION_MUST_POSTDATE_PREDICTION = YES
       ① observedAt 必须 > predictionCreatedAt（过去 canonical memory 不得被
          重新包装成"后来发生的结果"）
       ② observedAt 必须落在 [opensAt, closesAt] 内
     缺任一关键时间字段（或窗口不自洽）⇒ 'unknown' ⇒ gate FORBIDDEN。 */
  function computeTemporalValidity(observedAt, windowRef) {
    var at = finiteTime(observedAt);
    var wr = isPlainObject(windowRef) ? windowRef : null;
    if (at == null || !wr) return 'unknown';
    var created = finiteTime(wr.predictionCreatedAt);
    var opens = finiteTime(wr.opensAt);
    var closes = finiteTime(wr.closesAt);
    if (created == null || opens == null || closes == null) return 'unknown';
    if (closes < opens) return 'unknown';                 /* 窗口不自洽 */
    if (at < created) return 'before-window';             /* 不 postdate ⇒ 不得使用 */
    if (at < opens) return 'before-window';
    if (at > closes) return 'after-window';
    return 'within-window';
  }

  function temporalGateOf(temporalValidity) {
    return String(temporalValidity) === 'within-window' ? 'ELIGIBLE' : 'FORBIDDEN';
  }

  /* ── scope gate 原语（contract §E.2 T3 / §D.6）──────────────────────── */
  function scopeMatch(observationScope, expectedScope) {
    var a = isPlainObject(observationScope) ? observationScope : null;
    var b = isPlainObject(expectedScope) ? expectedScope : null;
    if (!a || !b) return 'CHARACTER-MISMATCH';   /* 缺上下文 ⇒ 不得 MATCH（fail-closed） */
    if (text(a.characterId) !== text(b.characterId)) return 'CHARACTER-MISMATCH';
    if (text(a.conversationId) !== text(b.conversationId)) return 'CONVERSATION-MISMATCH';
    if (text(a.subjectKind) !== text(b.subjectKind)) return 'SUBJECT-MISMATCH';
    if (text(a.subjectLabel) !== text(b.subjectLabel)) return 'SUBJECT-MISMATCH';
    return 'MATCH';
  }

  function scopeGateOf(scopeGateState) {
    return String(scopeGateState) === 'MATCH' ? 'ELIGIBLE' : 'FORBIDDEN';
  }

  /* ── opportunity gate 原语（contract §E.3）────────────────────────────
     机会存在性的 authority **只能**是 CANONICAL_RUNTIME。
     模型 / 用户自述 / linguistic evidence 都**不能**证明机会存在。 */
  function opportunityState(opportunity) {
    var o = isPlainObject(opportunity) ? opportunity : null;
    if (!o) return { state: 'UNKNOWN', existenceAuthoritative: false, consumed: false };
    if (o.required !== true) return { state: 'NOT-REQUIRED', existenceAuthoritative: true, consumed: false };
    var ex = isPlainObject(o.existence) ? o.existence : null;
    if (!ex) return { state: 'UNKNOWN', existenceAuthoritative: false, consumed: false };
    var authoritative = text(ex.authoritySource) === 'CANONICAL_RUNTIME';
    if (!authoritative) return { state: 'UNKNOWN', existenceAuthoritative: false, consumed: false };
    if (ex.present !== true) return { state: 'ABSENT', existenceAuthoritative: true, consumed: false };
    var consumedAt = finiteTime(o.consumedAt);
    if (consumedAt == null) return { state: 'NOT-CONSUMED', existenceAuthoritative: true, consumed: false };
    return { state: 'SATISFIED', existenceAuthoritative: true, consumed: true };
  }

  /* 机会闸门对**标量** admissibility 的贡献恒为 ELIGIBLE —— 这是刻意的：
     机会限制是**方向性**的（只禁止把 observation 用作 negation），
     因为 §E.4 行 2「support 达门槛 ∧ conflictAll == 0 ⇒ matched」与机会状态无关；
     若把 ABSENT 压成标量上限，会错误地压制一条自发的 explicit user report。
     ⇒ 机会的真实效果表达在 `negationAllowed` / `directional.conflict`。 */
  function opportunityGateOf(opportunity) {
    var r = opportunityState(opportunity);
    return {
      state: r.state,
      existenceAuthoritative: r.existenceAuthoritative,
      consumed: r.consumed,
      negationAllowed: r.state === 'SATISFIED' || r.state === 'NOT-REQUIRED',
      admissibility: 'ELIGIBLE'
    };
  }

  /* ── contamination 判定 + 闸门（contract §D.4）────────────────────────
     判定顺序：先命中先返回（沿用 MetaMemory 的优先级纪律）。
     注意：`contaminationClass` 是**声明**字段且 REQUIRED（契约 §D.1）；
     本函数从结构化事实**再算一次**，两者不一致时取**更坏**的那个（fail-closed）——
     声明值永远无法低报结构性事实上已经存在的污染。 */
  function computeContaminationClass(interventionContext) {
    var ic = isPlainObject(interventionContext) ? interventionContext : null;
    if (!ic) return 'UNKNOWN';
    if (ic.generatedBySystem === true) return 'DIRECT';
    if (ic.downstreamOfSystemAction === true) return 'LIKELY';
    var effects = Array.isArray(ic.behaviorEffectsInForce) ? ic.behaviorEffectsInForce : [];
    if (effects.length > 0 && ic.causalityEstablished !== true) return 'POSSIBLE';
    return 'NONE';
  }

  /* 声明的 class 与结构性事实算出的 class 不一致时，取**更坏**的那个（fail-closed）。 */
  function resolveContaminationClass(interventionContext) {
    var ic = isPlainObject(interventionContext) ? interventionContext : null;
    var computed = computeContaminationClass(ic);
    var declared = ic && CONTAMINATION_CLASSES.indexOf(String(ic.contaminationClass)) >= 0
      ? String(ic.contaminationClass) : null;
    if (!declared) return { value: computed, declared: null, computed: computed, conflicted: false };
    var useComputed = CONTAMINATION_SEVERITY[computed] > CONTAMINATION_SEVERITY[declared];
    return {
      value: useComputed ? computed : declared,
      declared: declared,
      computed: computed,
      conflicted: useComputed
    };
  }

  function contaminationGateOf(contaminationClass, targetDomain) {
    var cls = CONTAMINATION_CLASSES.indexOf(String(contaminationClass)) >= 0
      ? String(contaminationClass) : 'UNKNOWN';
    var subjective = SUBJECTIVE_DOMAINS.indexOf(String(targetDomain)) >= 0;
    if (cls === 'NONE') {
      return { class: cls, admissibility: 'ELIGIBLE', missedForbidden: false };
    }
    if (cls === 'POSSIBLE') {
      return { class: cls, admissibility: subjective ? 'SUPPORTING' : 'ELIGIBLE', missedForbidden: false };
    }
    if (cls === 'LIKELY' || cls === 'DIRECT') {
      return { class: cls, admissibility: subjective ? 'SUPPORTING' : 'ELIGIBLE', missedForbidden: subjective };
    }
    /* UNKNOWN：主观域 FORBIDDEN；机制域上限 SUPPORTING。 */
    return { class: 'UNKNOWN', admissibility: subjective ? 'FORBIDDEN' : 'SUPPORTING', missedForbidden: true };
  }

  /* ── domain / payload 一致性闸门（contract §D.3）────────────────────── */
  function domainPayloadConsistency(source, targetDomain, outcomeRef) {
    var src = String(source), dom = String(targetDomain);
    var ref = isPlainObject(outcomeRef) ? outcomeRef : null;
    if (!ref) return { state: 'INCONSISTENT', reasonCode: REASON.missingRequired };
    var kind = String(ref.kind);
    if (OUTCOME_KINDS.indexOf(kind) < 0) return { state: 'INCONSISTENT', reasonCode: REASON.badEnum };
    if (kind === 'statement') {
      /* statement 只能来自 EXPLICIT_USER_REPORT 或 LINGUISTIC_EVIDENCE；
         CANONICAL_RUNTIME 不得对主观域发 statement。 */
      if (src !== 'EXPLICIT_USER_REPORT' && src !== 'LINGUISTIC_EVIDENCE') {
        return { state: 'INCONSISTENT', reasonCode: REASON.domainPayloadInconsistent };
      }
      return { state: 'CONSISTENT', reasonCode: null };
    }
    /* token / numeric ⇒ 只能用于机制域；主观域**不允许**（防止"把 0.73 当情绪"）。
       ★ P5-B3-E-R1 唯一例外：**结构化偏好命题**。它是本仓库第一条"主观域
         的结构化载荷通道"，而且必须同时满足三个条件才放行：
           ① targetDomain === 'user_preference'（本轮**只**开放这一个域）
           ② source === 'EXPLICIT_USER_REPORT'（模型 / 语言证据 / 行为**没有**资格）
           ③ token 命中 canonical preference 文法（pref.<like|dislike>.<target>）
         任一不满足 ⇒ INCONSISTENT（fail closed，绝不"宽容地"当机制 token）。 */
    if (MECHANISM_DOMAINS.indexOf(dom) < 0) {
      if (kind === 'token' && dom === 'user_preference' && src === 'EXPLICIT_USER_REPORT'
        && isCanonicalPreferenceToken(ref.token)) {
        return { state: 'CONSISTENT', reasonCode: null };
      }
      return { state: 'INCONSISTENT', reasonCode: REASON.domainPayloadInconsistent };
    }
    if (kind === 'token') {
      var token = text(ref.token);
      var table = dom === 'runtime_state' ? RUNTIME_STATE_TOKENS : USER_ACTION_TOKENS;
      if (table.indexOf(token) < 0) {
        return { state: 'INCONSISTENT', reasonCode: REASON.domainPayloadInconsistent };
      }
      return { state: 'CONSISTENT', reasonCode: null };
    }
    /* numeric：必须有限数值 + 有界单位。 */
    var n = Number(ref.value);
    if (!isFinite(n)) return { state: 'INCONSISTENT', reasonCode: REASON.badNumeric };
    if (!text(ref.unit).trim() || text(ref.unit).length > BOUNDS.MAX_UNIT) {
      return { state: 'INCONSISTENT', reasonCode: REASON.badNumeric };
    }
    return { state: 'CONSISTENT', reasonCode: null };
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑤ schema 校验（build 与 isBuiltObservation 共用**同一份**判定）
     ══════════════════════════════════════════════════════════════════ */

  function validateObservationShape(o) {
    var errors = [];
    if (!isPlainObject(o)) return { ok: false, errors: ['not-an-object'] };
    var i, k;

    if (o.schemaVersion !== SCHEMA_VERSION) errors.push('bad-schema-version');
    if (o.producerAuthority !== PRODUCER_AUTHORITY) errors.push('bad-producer-authority');
    if (o.fingerprintAuthority !== FINGERPRINT_AUTHORITY) errors.push('bad-fingerprint-authority');

    var id = text(o.observationId);
    if (!id) errors.push('missing-observation-id');
    else if (id.length > BOUNDS.MAX_ID) errors.push('observation-id-too-long');
    else if (id.indexOf(ID_PREFIX) !== 0) errors.push('bad-observation-id-prefix');

    if (SOURCES.indexOf(String(o.source)) < 0) errors.push('bad-source');
    if (DOMAINS.indexOf(String(o.targetDomain)) < 0) errors.push('bad-target-domain');
    if (COMPLETENESS_VALUES.indexOf(String(o.completeness)) < 0) errors.push('bad-completeness');
    if (TEMPORAL_VALIDITY.indexOf(String(o.temporalValidity)) < 0) errors.push('bad-temporal-validity');

    var si = text(o.sourceInstance);
    if (!si) errors.push('missing-source-instance');
    else if (si.length > BOUNDS.MAX_SOURCE_INSTANCE) errors.push('source-instance-too-long');
    if (!isAuthorizedObserver(o.source, o.sourceInstance)) errors.push('source-instance-not-authorized');

    if (finiteTime(o.observedAt) == null) errors.push('bad-observed-at');

    var wr = isPlainObject(o.windowRef) ? o.windowRef : null;
    if (!wr) errors.push('missing-window-ref');
    else {
      for (i = 0; i < WINDOW_REF_FIELDS.length; i++) {
        k = WINDOW_REF_FIELDS[i];
        if (!has(wr, k)) { errors.push('missing-window-ref-field:' + k); continue; }
      }
      if (!text(wr.predictionId)) errors.push('missing-prediction-id');
      if (wr.predictionCreatedAt != null && finiteTime(wr.predictionCreatedAt) == null) errors.push('bad-prediction-created-at');
      if (wr.opensAt != null && finiteTime(wr.opensAt) == null) errors.push('bad-opens-at');
      if (wr.closesAt != null && finiteTime(wr.closesAt) == null) errors.push('bad-closes-at');
    }

    var sc = isPlainObject(o.scope) ? o.scope : null;
    if (!sc) errors.push('missing-scope');
    else {
      for (i = 0; i < SCOPE_FIELDS.length; i++) {
        if (!has(sc, SCOPE_FIELDS[i])) errors.push('missing-scope-field:' + SCOPE_FIELDS[i]);
      }
      if (SUBJECT_KINDS.indexOf(String(sc.subjectKind)) < 0) errors.push('bad-subject-kind');
      if (text(sc.characterId).length > BOUNDS.MAX_CHARACTER_ID) errors.push('character-id-too-long');
      if (text(sc.conversationId).length > BOUNDS.MAX_CONVERSATION_ID) errors.push('conversation-id-too-long');
      if (text(sc.subjectLabel).length > BOUNDS.MAX_SUBJECT_LABEL) errors.push('subject-label-too-long');
    }

    var refKind = isPlainObject(o.outcomeRef) ? String(o.outcomeRef.kind) : '';
    if (OUTCOME_KINDS.indexOf(refKind) < 0) errors.push('bad-outcome-ref-kind');
    else {
      var allowed = OUTCOME_REF_FIELDS[refKind];
      var ref = o.outcomeRef;
      for (i = 0; i < allowed.length; i++) {
        if (!has(ref, allowed[i])) errors.push('missing-outcome-ref-field:' + allowed[i]);
      }
      Object.keys(ref).forEach(function (key) {
        if (allowed.indexOf(key) < 0) errors.push('unknown-outcome-ref-field:' + key);
      });
      if (refKind === 'token') {
        var tk = text(ref.token);
        if (!tk || tk.length > BOUNDS.MAX_TOKEN) errors.push('bad-outcome-token');
      } else if (refKind === 'numeric') {
        if (!isFinite(Number(ref.value))) errors.push('bad-outcome-numeric-value');
        var un = text(ref.unit);
        if (!un || un.length > BOUNDS.MAX_UNIT) errors.push('bad-outcome-numeric-unit');
      } else {
        var st = text(ref.statement);
        if (!st || st.length > BOUNDS.MAX_STATEMENT) errors.push('bad-outcome-statement');
      }
    }

    if (!Array.isArray(o.evidenceRefs)) errors.push('missing-evidence-refs');
    else {
      if (o.evidenceRefs.length > BOUNDS.MAX_EVIDENCE_REFS) errors.push('too-many-evidence-refs');
      for (i = 0; i < o.evidenceRefs.length; i++) {
        var r = text(o.evidenceRefs[i]);
        if (!r || r.length > BOUNDS.MAX_REF) { errors.push('bad-evidence-ref'); break; }
      }
    }

    var ic = isPlainObject(o.interventionContext) ? o.interventionContext : null;
    if (!ic) errors.push('missing-intervention-context');
    else {
      if (CONTAMINATION_CLASSES.indexOf(String(ic.contaminationClass)) < 0) errors.push('bad-contamination-class');
      if (!Array.isArray(ic.behaviorEffectsInForce)) errors.push('missing-behavior-effects');
      else if (ic.behaviorEffectsInForce.length > BOUNDS.MAX_BEHAVIOR_EFFECTS) errors.push('too-many-behavior-effects');
      if (!has(ic, 'predictionInfluencedSystem')) errors.push('missing-prediction-influenced-system');
      else if (ic.predictionInfluencedSystem !== null && typeof ic.predictionInfluencedSystem !== 'boolean') {
        errors.push('bad-prediction-influenced-system');
      }
      var basis = text(ic.contaminationBasis);
      if (!basis.trim()) errors.push('missing-contamination-basis');
      else if (basis.length > BOUNDS.MAX_BASIS) errors.push('contamination-basis-too-long');
    }

    if (!Array.isArray(o.reasonCodes)) errors.push('missing-reason-codes');

    return { ok: errors.length === 0, errors: errors };
  }

  /* 冻结完整性：顶层 + 结构子对象/数组都要 frozen。
     （schema 校验**不含**这一项 —— 因为 build 时先校验、后封存；冻结是
       `isBuiltObservation` 的 integrity 面，不是 schema 面。） */
  function isFrozenDeep(v) {
    if (!v || typeof v !== 'object') return true;
    if (!Object.isFrozen(v)) return false;
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) {
      var child = v[keys[i]];
      if (child && typeof child === 'object' && !isFrozenDeep(child)) return false;
    }
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑥ ① buildOutcomeObservation —— 唯一的铸造点
     ══════════════════════════════════════════════════════════════════ */

  function failBuild(codes) {
    return { ok: false, value: null, reasonCodes: uniq(codes), errors: uniq(codes) };
  }

  /**
   * buildOutcomeObservation(input, ctx)
   *   input —— 授权 observer 声明的结构化事实（闭集键；未知键**拒绝**）
   *   ctx   —— { now? } 仅供未来扩展；本核心**不读时钟**，也不使用 now。
   *
   * 返回 { ok, value, reasonCodes, errors }。
   * 只有 ok === true 的 value 才在 capability 表里 ⇒ 才能通过 isBuiltObservation()。
   */
  function buildOutcomeObservation(input, ctx) {
    void ctx;   /* 显式：本核心不读时钟，也不使用任何外部状态 */
    var codes = [];
    var src = isPlainObject(input) ? input : null;
    if (!src) return failBuild([REASON.notAnObject]);

    /* ── 闭集键：未知键拒绝；正文体键**具名**拒绝 ── */
    var keys = Object.keys(src);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (FORBIDDEN_BODY_KEYS.indexOf(String(key).toLowerCase()) >= 0) codes.push(REASON.forbiddenBodyField + ':' + key);
      else if (INPUT_FIELDS.indexOf(key) < 0) codes.push(REASON.unknownField + ':' + key);
    }
    if (codes.length) return failBuild(codes);

    /* ── 必填存在性 ── */
    var required = ['windowRef', 'source', 'sourceInstance', 'targetDomain',
      'observedAt', 'completeness', 'scope', 'outcomeRef', 'evidenceRefs'];
    for (var r = 0; r < required.length; r++) {
      if (!has(src, required[r])) codes.push(REASON.missingRequired + ':' + required[r]);
    }
    if (codes.length) return failBuild(codes);

    /* ── provenance ── */
    if (SOURCES.indexOf(String(src.source)) < 0) codes.push(REASON.badEnum + ':source');
    var sourceInstance = text(src.sourceInstance);
    if (!sourceInstance) codes.push(REASON.missingRequired + ':sourceInstance');
    else if (sourceInstance.length > BOUNDS.MAX_SOURCE_INSTANCE) codes.push(REASON.fieldTooLong + ':sourceInstance');
    else if (SOURCES.indexOf(String(src.source)) >= 0
      && !isAuthorizedObserver(src.source, sourceInstance)) {
      /* source 合法 ≠ producer 被授权：未知 sourceInstance 一律拒绝。 */
      var list = AUTHORIZED_OBSERVERS[String(src.source)];
      codes.push((list && list.length ? REASON.unauthorizedSourceInstance : REASON.unknownObserver) + ':' + sourceInstance);
    }

    /* ── target domain ── */
    if (DOMAINS.indexOf(String(src.targetDomain)) < 0) codes.push(REASON.badEnum + ':targetDomain');

    /* ── time ── */
    var observedAt = finiteTime(src.observedAt);
    if (observedAt == null) codes.push(REASON.badObservedAt);

    var wr = isPlainObject(src.windowRef) ? src.windowRef : null;
    if (!wr) codes.push(REASON.missingRequired + ':windowRef');
    else {
      Object.keys(wr).forEach(function (k) {
        if (WINDOW_REF_FIELDS.indexOf(k) < 0) codes.push(REASON.unknownField + ':windowRef.' + k);
      });
      if (!text(wr.predictionId)) codes.push(REASON.missingRequired + ':windowRef.predictionId');
      else if (text(wr.predictionId).length > BOUNDS.MAX_ID) codes.push(REASON.fieldTooLong + ':windowRef.predictionId');
      ['predictionCreatedAt', 'opensAt', 'closesAt'].forEach(function (k) {
        if (has(wr, k) && wr[k] != null && finiteTime(wr[k]) == null) codes.push(REASON.badTime + ':windowRef.' + k);
      });
    }

    /* ── completeness ── */
    if (COMPLETENESS_VALUES.indexOf(String(src.completeness)) < 0) codes.push(REASON.badEnum + ':completeness');

    /* ── scope ── */
    var sc = isPlainObject(src.scope) ? src.scope : null;
    if (!sc) codes.push(REASON.missingRequired + ':scope');
    else {
      Object.keys(sc).forEach(function (k) {
        if (SCOPE_FIELDS.indexOf(k) < 0) codes.push(REASON.unknownField + ':scope.' + k);
      });
      ['characterId', 'conversationId', 'subjectKind', 'subjectLabel'].forEach(function (k) {
        if (!has(sc, k)) codes.push(REASON.missingRequired + ':scope.' + k);
      });
      if (SUBJECT_KINDS.indexOf(String(sc.subjectKind)) < 0) codes.push(REASON.badEnum + ':scope.subjectKind');
      if (text(sc.characterId).length > BOUNDS.MAX_CHARACTER_ID) codes.push(REASON.fieldTooLong + ':scope.characterId');
      if (text(sc.conversationId).length > BOUNDS.MAX_CONVERSATION_ID) codes.push(REASON.fieldTooLong + ':scope.conversationId');
      if (text(sc.subjectLabel).length > BOUNDS.MAX_SUBJECT_LABEL) codes.push(REASON.fieldTooLong + ':scope.subjectLabel');
    }

    /* ── outcomeRef：按 kind 白名单（不是名字黑名单）── */
    var ref = isPlainObject(src.outcomeRef) ? src.outcomeRef : null;
    if (!ref) codes.push(REASON.missingRequired + ':outcomeRef');
    else {
      var rk = String(ref.kind);
      if (OUTCOME_KINDS.indexOf(rk) < 0) codes.push(REASON.badEnum + ':outcomeRef.kind');
      else {
        var allowedRef = OUTCOME_REF_FIELDS[rk];
        Object.keys(ref).forEach(function (k) {
          if (FORBIDDEN_BODY_KEYS.indexOf(String(k).toLowerCase()) >= 0) codes.push(REASON.forbiddenBodyField + ':outcomeRef.' + k);
          else if (allowedRef.indexOf(k) < 0) codes.push(REASON.unknownField + ':outcomeRef.' + k);
        });
        if (rk === 'token') {
          var tk = text(ref.token);
          if (!tk) codes.push(REASON.missingRequired + ':outcomeRef.token');
          else if (tk.length > BOUNDS.MAX_TOKEN) codes.push(REASON.fieldTooLong + ':outcomeRef.token');
        } else if (rk === 'numeric') {
          if (!isFinite(Number(ref.value))) codes.push(REASON.badNumeric + ':value');
          var un = text(ref.unit);
          if (!un) codes.push(REASON.missingRequired + ':outcomeRef.unit');
          else if (un.length > BOUNDS.MAX_UNIT) codes.push(REASON.fieldTooLong + ':outcomeRef.unit');
        } else {
          var st = text(ref.statement);
          if (!st) codes.push(REASON.missingRequired + ':outcomeRef.statement');
          else if (st.length > BOUNDS.MAX_STATEMENT) codes.push(REASON.fieldTooLong + ':outcomeRef.statement');
        }
      }
    }

    /* ── evidenceRefs（可为空数组；有界；不得是本正文体）── */
    if (!Array.isArray(src.evidenceRefs)) codes.push(REASON.missingRequired + ':evidenceRefs');
    else if (src.evidenceRefs.length > BOUNDS.MAX_EVIDENCE_REFS) codes.push(REASON.tooManyItems + ':evidenceRefs');
    else {
      for (var e = 0; e < src.evidenceRefs.length; e++) {
        var one = src.evidenceRefs[e];
        if (typeof one !== 'string' || !one.trim() || one.length > BOUNDS.MAX_REF) { codes.push(REASON.badRef); break; }
      }
    }

    /* ── interventionContext ── */
    var ic = isPlainObject(src.interventionContext) ? src.interventionContext : null;
    if (!ic) codes.push(REASON.missingRequired + ':interventionContext');
    else {
      Object.keys(ic).forEach(function (k) {
        if (INTERVENTION_FIELDS.indexOf(k) < 0) codes.push(REASON.unknownField + ':interventionContext.' + k);
      });
      if (!has(ic, 'contaminationClass')) {
        /* 契约 §D.1 把 contaminationClass 列为 REQUIRED。
           缺省**不得**被静默当成 NONE —— 那会让"没检查"伪装成"没有污染"（fail-open）。 */
        codes.push(REASON.missingRequired + ':contaminationClass');
      } else if (CONTAMINATION_CLASSES.indexOf(String(ic.contaminationClass)) < 0) {
        codes.push(REASON.badEnum + ':contaminationClass');
      }
      if (has(ic, 'predictionInfluencedSystem')
        && ic.predictionInfluencedSystem !== null
        && typeof ic.predictionInfluencedSystem !== 'boolean') {
        codes.push(REASON.badEnum + ':predictionInfluencedSystem');
      }
      var effects = ic.behaviorEffectsInForce;
      if (effects != null && !Array.isArray(effects)) codes.push(REASON.badEnum + ':behaviorEffectsInForce');
      else if (Array.isArray(effects)) {
        if (effects.length > BOUNDS.MAX_BEHAVIOR_EFFECTS) codes.push(REASON.tooManyItems + ':behaviorEffectsInForce');
        else {
          for (var b = 0; b < effects.length; b++) {
            var eff = effects[b];
            if (!isPlainObject(eff)) { codes.push(REASON.badEnum + ':behaviorEffect'); break; }
            var badKey = false;
            Object.keys(eff).forEach(function (k) {
              if (BEHAVIOR_EFFECT_FIELDS.indexOf(k) < 0) badKey = true;
              /* 词表权威在 runtime-behavior-effect.js —— 本核心**不复制**它，
                 只做形状与长度约束（不制造第二套词表）。 */
              if (text(eff[k]).length > BOUNDS.MAX_REF) badKey = true;
            });
            if (badKey) { codes.push(REASON.badEnum + ':behaviorEffect-shape'); break; }
          }
        }
      }
      var basis = text(ic.contaminationBasis);
      if (!basis.trim()) codes.push(REASON.missingRequired + ':contaminationBasis');
      else if (basis.length > BOUNDS.MAX_BASIS) codes.push(REASON.fieldTooLong + ':contaminationBasis');
    }

    if (codes.length) return failBuild(codes);

    /* ── 派生 ── */
    var temporalValidity = computeTemporalValidity(observedAt, wr);
    var contamination = resolveContaminationClass(ic);
    if (contamination.conflicted) codes.push(REASON.contaminationClassConflict);

    var predictionId = text(src.predictionId) || text(wr.predictionId);
    /* predictionId 若显式给出，必须与 windowRef 内的**逐字一致**（同一条 prediction）。 */
    if (has(src, 'predictionId') && text(src.predictionId) !== text(wr.predictionId)) {
      return failBuild([REASON.missingRequired + ':predictionId-windowRef-mismatch']);
    }

    var injectedId = src.observationId == null ? null : text(src.observationId);
    if (injectedId && injectedId.indexOf(ID_PREFIX) !== 0) return failBuild([REASON.reservedIdPrefix]);
    if (injectedId && injectedId.length > BOUNDS.MAX_ID) return failBuild([REASON.fieldTooLong + ':observationId']);

    /* 身份摘要**只**取结构化字段，绝不含正文 ⇒ id 不泄漏 statement/subjectLabel。 */
    var observationId = injectedId || (ID_PREFIX + stableToken([
      predictionId,
      text(src.source),
      sourceInstance,
      text(src.targetDomain),
      String(observedAt),
      String(wr.opensAt),
      String(wr.closesAt),
      text(sc.characterId),
      text(sc.conversationId),
      text(sc.subjectKind)
    ].join('|')));

    var value = {
      schemaVersion: SCHEMA_VERSION,
      observationId: observationId,
      producerAuthority: PRODUCER_AUTHORITY,
      fingerprintAuthority: FINGERPRINT_AUTHORITY,

      source: String(src.source),
      sourceInstance: sourceInstance,
      targetDomain: String(src.targetDomain),

      observedAt: observedAt,
      windowRef: {
        predictionId: text(wr.predictionId),
        predictionCreatedAt: finiteTime(wr.predictionCreatedAt),
        opensAt: finiteTime(wr.opensAt),
        closesAt: finiteTime(wr.closesAt)
      },
      temporalValidity: temporalValidity,
      completeness: String(src.completeness),

      scope: {
        characterId: text(sc.characterId),
        conversationId: text(sc.conversationId),
        subjectKind: String(sc.subjectKind),
        subjectLabel: text(sc.subjectLabel)
      },

      outcomeRef: buildOutcomeRef(ref),
      evidenceRefs: src.evidenceRefs.map(function (x) { return text(x); }),

      interventionContext: {
        behaviorEffectsInForce: (Array.isArray(ic.behaviorEffectsInForce) ? ic.behaviorEffectsInForce : []).map(function (eff) {
          return {
            sourceTurn: text(eff.sourceTurn),
            stance: text(eff.stance),
            strategy: text(eff.strategy),
            initiativeTendency: text(eff.initiativeTendency),
            rationaleCode: text(eff.rationaleCode)
          };
        }),
        predictionInfluencedSystem: has(ic, 'predictionInfluencedSystem') ? ic.predictionInfluencedSystem : null,
        contaminationClass: contamination.value,
        contaminationComputed: contamination.computed,
        contaminationDeclared: contamination.declared,
        contaminationBasis: text(ic.contaminationBasis)
      },

      reasonCodes: uniq(codes.concat([
        REASON.ok,
        'epistemic-authority-of-record-only',
        'not-a-settlement-state',
        'not-a-canonical-fact'
      ]))
    };

    var shape = validateObservationShape(value);
    if (!shape.ok) return failBuild(shape.errors);

    sealObservation(value);
    return { ok: true, value: value, reasonCodes: value.reasonCodes.slice(), errors: [] };
  }

  function buildOutcomeRef(ref) {
    var rk = String(ref.kind);
    if (rk === 'token') return { kind: 'token', token: text(ref.token) };
    if (rk === 'numeric') {
      return { kind: 'numeric', value: Number(ref.value), unit: text(ref.unit).trim() };
    }
    /* statement：**只**保留有界文本本身；不携带任何上下文对象。 */
    return { kind: 'statement', statement: text(ref.statement).trim() };
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑦ ② isBuiltObservation —— 能力闸门（身份 + 封存 + schema）
     ══════════════════════════════════════════════════════════════════ */

  /**
   * 只有满足**全部四项**才算 built：
   *   ① capability identity —— 是 builder 真正产出过的**那个**对象（WeakSet）
   *   ② frozen snapshot 一致性 —— 当前规范化序列化与封存串**逐字相同**（WeakMap）
   *   ③ schema validity —— 闭集字段/长度/枚举全部合法
   *   ④ 冻结完整性 —— 顶层与全部结构子对象都 frozen（不可再被改写）
   * 缺任一项 ⇒ invalid。永不抛错。
   */
  function isBuiltObservation(o) {
    try {
      if (!HAS_CAPABILITY_PRIMITIVES) return false;          /* 无能力原语 ⇒ fail closed */
      if (!isPlainObject(o)) return false;
      if (!OBSERVATION_IDENTITY.has(o)) return false;        /* 伪造 / 克隆 / JSON round-trip */
      var sealed = OBSERVATION_SEAL.get(o);
      if (typeof sealed !== 'string') return false;
      if (canonicalize(o) !== sealed) return false;          /* 被改写 ⇒ 序列化不一致 */
      if (!validateObservationShape(o).ok) return false;     /* schema 也要过 */
      if (!isFrozenDeep(o)) return false;                    /* 冻结完整性 */
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑧ ③ authorityGate —— 确定性、只降不升、可复算
     ══════════════════════════════════════════════════════════════════ */

  /**
   * authorityGate(observation, ctx)
   *   ctx = {
   *     expectedScope      : { characterId, conversationId, subjectKind, subjectLabel }  REQUIRED
   *     opportunity        : { required, existence:{present,authoritySource}, consumedAt } | null
   *   }
   *
   * 返回 { ok, gateTrace }。**不**产出任何 settlement state。
   * NO_GATE_MAY_RAISE_AUTHORITY = YES：全部闸门只参与 min()。
   */
  function authorityGate(observation, ctx) {
    var c = isPlainObject(ctx) ? ctx : {};
    var obs = isPlainObject(observation) ? observation : null;

    var trace = {
      predictionId: null,
      observationId: obs ? text(obs.observationId) || null : null,
      ceiling: null,
      scopeGate: null,
      temporalGate: null,
      opportunityGate: null,
      contaminationGate: null,
      domainPayloadGate: null,
      effectiveAdmissibility: 'FORBIDDEN',
      directional: { support: 'FORBIDDEN', conflict: 'FORBIDDEN' },
      negationAllowed: false,
      missedForbidden: true,
      loweredBy: [],
      reasonCodes: []
    };

    if (!isBuiltObservation(obs)) {
      trace.reasonCodes.push(REASON.observationNotBuilt);
      return { ok: false, gateTrace: trace };
    }

    var shape = validateObservationShape(obs);
    if (!shape.ok) {
      trace.reasonCodes.push(REASON.schemaInvalid);
      trace.loweredBy.push('schema');
      return { ok: false, gateTrace: trace };
    }

    trace.predictionId = text(obs.windowRef.predictionId) || null;

    /* ── ceiling：source × targetDomain（矩阵是天花板）── */
    var ceiling = matrixCeiling(obs.source, obs.targetDomain);
    if (ceiling == null) {
      trace.reasonCodes.push(REASON.matrixCellMissing);
      trace.loweredBy.push('matrix');
      return { ok: false, gateTrace: trace };
    }
    trace.ceiling = ceiling;

    /* ── temporal：重算并与封存值比对（defense in depth）── */
    var recomputedTemporal = computeTemporalValidity(obs.observedAt, obs.windowRef);
    trace.temporalGate = recomputedTemporal;
    var temporalAdm;
    if (recomputedTemporal !== obs.temporalValidity) {
      trace.reasonCodes.push(REASON.temporalValidityMismatch);
      temporalAdm = 'FORBIDDEN';
    } else {
      temporalAdm = temporalGateOf(recomputedTemporal);
      if (temporalAdm !== 'ELIGIBLE') {
        trace.reasonCodes.push(recomputedTemporal === 'before-window' ? REASON.evidenceBeforeWindow
          : recomputedTemporal === 'after-window' ? REASON.evidenceAfterWindow
            : REASON.temporalUnknown);
      }
    }

    /* ── scope ── */
    var expectedScope = isPlainObject(c.expectedScope) ? c.expectedScope : null;
    var scopeState, scopeAdm;
    if (!expectedScope) {
      scopeState = null;
      scopeAdm = 'FORBIDDEN';
      trace.reasonCodes.push(REASON.scopeContextMissing);
    } else {
      scopeState = scopeMatch(obs.scope, expectedScope);
      scopeAdm = scopeGateOf(scopeState);
    }
    trace.scopeGate = scopeState;

    /* ── opportunity（方向性闸门：只禁止 negation，不压标量上限）── */
    var opp = opportunityGateOf(c.opportunity);
    trace.opportunityGate = opp.state;
    trace.negationAllowed = opp.negationAllowed;
    if (opp.state === 'ABSENT') trace.reasonCodes.push(REASON.opportunityAbsent);
    else if (opp.state === 'NOT-CONSUMED') trace.reasonCodes.push(REASON.opportunityNotConsumed);
    else if (opp.state === 'UNKNOWN') {
      trace.reasonCodes.push(REASON.opportunityUnknown);
      if (isPlainObject(c.opportunity) && isPlainObject(c.opportunity.existence)
        && text(c.opportunity.existence.authoritySource) !== 'CANONICAL_RUNTIME') {
        trace.reasonCodes.push(REASON.opportunityExistenceNotAuthoritative);
      }
    }

    /* ── contamination ── */
    var cont = contaminationGateOf(obs.interventionContext.contaminationClass, obs.targetDomain);
    trace.contaminationGate = cont.class;
    trace.missedForbidden = cont.missedForbidden;
    if (cont.class === 'UNKNOWN') trace.reasonCodes.push(REASON.contaminationUnknown);
    else if (cont.admissibility === 'SUPPORTING') trace.reasonCodes.push(REASON.contaminationCapsSubjectiveDomain);

    /* ── domain / payload 一致性（独立复核，不依赖 observer 诚实）── */
    var dp = domainPayloadConsistency(obs.source, obs.targetDomain, obs.outcomeRef);
    trace.domainPayloadGate = dp.state;
    var dpAdm = dp.state === 'CONSISTENT' ? 'ELIGIBLE' : 'FORBIDDEN';
    if (dpAdm === 'FORBIDDEN') trace.reasonCodes.push(REASON.domainPayloadInconsistent);

    /* ── min()：六闸门，缺一即 FORBIDDEN（fail-closed）── */
    var gates = {
      ceiling: ceiling,
      scopeGate: scopeAdm,
      temporalGate: temporalAdm,
      opportunityGate: opp.admissibility,
      contaminationGate: cont.admissibility,
      domainPayloadGate: dpAdm
    };
    var effective = minAdmissibility([
      gates.ceiling, gates.scopeGate, gates.temporalGate,
      gates.opportunityGate, gates.contaminationGate, gates.domainPayloadGate
    ]);
    trace.effectiveAdmissibility = effective;

    /* ── loweredBy：哪些闸门把结果压到 ceiling 之下 ── */
    var names = ['scopeGate', 'temporalGate', 'opportunityGate', 'contaminationGate', 'domainPayloadGate'];
    for (var g = 0; g < names.length; g++) {
      var n = names[g];
      if (ADMISSIBILITY_RANK[gates[n]] < ADMISSIBILITY_RANK[ceiling]) trace.loweredBy.push(n);
    }
    if (trace.loweredBy.length) trace.reasonCodes.push(REASON.gateLowered);

    /* ── directional：support 用 effective；conflict 还须 negation 被允许 ──
       这正是"污染影响从事实推人的含义，不否定已经发生的机制事实"的机械形式。 */
    trace.directional = {
      support: effective,
      conflict: (opp.negationAllowed && !cont.missedForbidden) ? effective : 'FORBIDDEN'
    };

    /* ── 可复算细节：只有时间戳/等级，**没有**任何正文 ── */
    trace.recomputable = {
      observedAt: obs.observedAt,
      predictionCreatedAt: obs.windowRef.predictionCreatedAt,
      opensAt: obs.windowRef.opensAt,
      closesAt: obs.windowRef.closesAt,
      source: obs.source,
      sourceInstance: obs.sourceInstance,
      targetDomain: obs.targetDomain,
      outcomeKind: obs.outcomeRef.kind,
      subjectKind: obs.scope.subjectKind,
      admissibilityRank: { FORBIDDEN: 0, CANDIDATE: 1, SUPPORTING: 2, ELIGIBLE: 3 }
    };

    trace.reasonCodes = uniq(trace.reasonCodes.concat([REASON.ok]));
    return { ok: true, gateTrace: trace };
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑨ 导出
     ══════════════════════════════════════════════════════════════════ */

  return {
    /* API */
    buildOutcomeObservation: buildOutcomeObservation,
    isBuiltObservation: isBuiltObservation,
    validateObservationShape: validateObservationShape,
    authorityGate: authorityGate,

    /* 独立可测的 gate 原语 */
    minAdmissibility: minAdmissibility,
    admissibilityOf: admissibilityOf,
    matrixCeiling: matrixCeiling,
    isAuthorizedObserver: isAuthorizedObserver,
    /* P5-B3-E-R1 · 结构化偏好命题的唯一文法（转出，供 P2/P3/生产侧共用） */
    PREFERENCE: PREFERENCE,
    isCanonicalPreferenceToken: isCanonicalPreferenceToken,
    computeTemporalValidity: computeTemporalValidity,
    temporalGateOf: temporalGateOf,
    scopeMatch: scopeMatch,
    scopeGateOf: scopeGateOf,
    opportunityState: opportunityState,
    opportunityGateOf: opportunityGateOf,
    computeContaminationClass: computeContaminationClass,
    resolveContaminationClass: resolveContaminationClass,
    contaminationGateOf: contaminationGateOf,
    domainPayloadConsistency: domainPayloadConsistency,

    /* 冻结常量 */
    SCHEMA_VERSION: SCHEMA_VERSION,
    ID_PREFIX: ID_PREFIX,
    PRODUCER_AUTHORITY: PRODUCER_AUTHORITY,
    FINGERPRINT_AUTHORITY: FINGERPRINT_AUTHORITY,
    SOURCES: SOURCES,
    DOMAINS: DOMAINS,
    MECHANISM_DOMAINS: MECHANISM_DOMAINS,
    SUBJECTIVE_DOMAINS: SUBJECTIVE_DOMAINS,
    CONTAMINATION_CLASSES: CONTAMINATION_CLASSES,
    ADMISSIBILITY_LEVELS: ADMISSIBILITY_LEVELS,
    ADMISSIBILITY_RANK: ADMISSIBILITY_RANK,
    TEMPORAL_VALIDITY: TEMPORAL_VALIDITY,
    COMPLETENESS_VALUES: COMPLETENESS_VALUES,
    OUTCOME_KINDS: OUTCOME_KINDS,
    OPPORTUNITY_STATES: OPPORTUNITY_STATES,
    SCOPE_GATE_STATES: SCOPE_GATE_STATES,
    DOMAIN_PAYLOAD_STATES: DOMAIN_PAYLOAD_STATES,
    SUBJECT_KINDS: SUBJECT_KINDS,
    AUTHORITY_MATRIX: AUTHORITY_MATRIX,
    MATRIX_ROWS: MATRIX_ROWS,
    MATRIX_CELL_COUNT: MATRIX_CELL_COUNT,
    AUTHORIZED_OBSERVERS: AUTHORIZED_OBSERVERS,
    RUNTIME_STATE_TOKENS: RUNTIME_STATE_TOKENS,
    USER_ACTION_TOKENS: USER_ACTION_TOKENS,
    BOUNDS: BOUNDS,
    REASON: REASON,

    /* 能力边界自述（公开字符串，**不是** capability） */
    STATE_SUPPORT: Object.freeze({
      outcomeObservationAuthority: 'PURE_CORE_ONLY',
      productionObserverWiring: 'NONE',
      settlementEngine: 'NONE',
      predictionRegistryLive: 'NO',
      predictionErrorCalculation: 'NONE',
      calibration: 'NONE',
      evidenceMatcherInvocation: 'OFF',
      modelCalls: 0,
      durableWrites: 0,
      clockReads: 0,
      capabilityPrimitives: HAS_CAPABILITY_PRIMITIVES ? 'WEAKSET_AND_WEAKMAP' : 'UNAVAILABLE_FAIL_CLOSED',
      onlyBuilderMintsValidOutcomeObservation: 'YES',
      noGateMayRaiseAuthority: 'YES'
    })
  };
});
