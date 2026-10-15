/* ====================================================================
   IB Memory · PredictionRecord projection core（Prediction Error P2）
   --------------------------------------------------------------------
   唯一职责：把一条**已经校验过的 Expectation** 忠实、确定性、不可偷换地
   投影成一条 PredictionRecord —— 供未来的 Settlement Engine（P3）使用。

   它**不**结算：不产出 matched / missed / mixed，不计算 Prediction Error，
   不做 Calibration，不调模型，不读时钟，不写任何 store。

   ── 四条硬纪律 ───────────────────────────────────────────────────────
     REGISTRY_MAY_NOT_INVENT_CONTENT = YES
       Registry **只能**投影 Expectation 已经明确表达的东西。
       禁止自由文本 NLP 解析、隐式语义推断、fallback 模型调用、
       猜 subject / 猜 predictionType / 猜 expectedOutcome。
       缺结构字段 ⇒ settleable = false（不是"补全"，是"拒绝"）。

     PROJECTION_IS_CONTENT_NON_EXPANSIVE = YES
       允许新增的只有**系统治理字段**（id / session ref / lifetime / createdAt /
       window / policy / type / contradictionMode / lifecycle / audit）。
       **不得**新增任何自然语言认知判断。

     MODEL_MAY_NOT_CHOOSE_PREDICTION_TYPE = YES
       模型只提供受闭集校验的 subject.kind / predicate.kind / expectedOutcome.kind；
       predictionType / settlementPolicy / contradictionMode 全部由冻结表推导。
       无法唯一推导 ⇒ settleable = false。

     MODEL_MAY_NOT_DECLARE_OPPORTUNITY_EXISTENCE = YES
       P2 只冻结 opportunity 的**期望形状**（required / kind / existenceAuthority）；
       consumedAt / consumedByObservationId **不得**由 Registry 猜。

   ── 纯度 ─────────────────────────────────────────────────────────────
     零 I/O · 零网络 · 零模型 · 零 durable 写 · 零时钟（now 由调用方注入）·
     零随机（不用 Math.random）· 零可变全局计数器。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var chatCore = null, memoryContract = null;
    try { chatCore = require('../chat-core.js'); } catch (e) { chatCore = null; }
    try { memoryContract = require('../memory-contract.js'); } catch (e) { memoryContract = null; }
    module.exports = factory(chatCore, memoryContract);
  } else {
    root.IBMemoryPredictionRecord = factory(root.IBChatCore || null, root.IBMemoryContract || null);
  }
})(typeof self !== 'undefined' ? self : this, function (CHAT_CORE, CONTRACT) {
  'use strict';

  var SCHEMA_VERSION = 'prediction-record/v1';
  var ID_PREFIX = 'pred_';
  var SESSION_REF_PREFIX = 'sess_';
  var ID_LIFETIME = 'SESSION_ONLY';

  /* ══════════════════════════════════════════════════════════════════
     ① 冻结闭集（与 contract §C.1 / §C.4 / §F.0 逐值一致）
     ══════════════════════════════════════════════════════════════════ */

  var PREDICTION_TYPES = Object.freeze(['event', 'preference', 'latent_state', 'relational']);

  var SUBJECT_KINDS = Object.freeze([
    'character-self', 'user', 'third-party', 'system', 'world'
  ]);

  /* R2 补口：relationship-* 是 relational 的**唯一**入口；
     holds-stance 永不映射到 relational。 */
  var PREDICATE_KINDS = Object.freeze([
    'will-do', 'will-not-do', 'will-occur', 'is-in-state', 'prefers', 'holds-stance',
    'relationship-state', 'relationship-change'
  ]);

  var PREDICATE_CLASS = Object.freeze({
    'will-do': 'action',
    'will-not-do': 'action',
    'will-occur': 'occurrence',
    'is-in-state': 'mental',
    'prefers': 'preference',
    'holds-stance': 'evaluative',
    'relationship-state': 'relational',
    'relationship-change': 'relational'
  });

  /* predicateClass → predictionType（**函数**：一类只映射到一个类型） */
  var CLASS_TO_TYPE = Object.freeze({
    action: 'event',
    occurrence: 'event',
    preference: 'preference',
    evaluative: 'preference',
    mental: 'latent_state',
    relational: 'relational'
  });

  var OUTCOME_KINDS = Object.freeze([
    'exclusive-outcome', 'threshold', 'state-claim', 'denial-claim', 'window-occurrence'
  ]);

  /* subject.kind 的允许集（按类型收紧：证据不足的主体不得塞进宽松类型） */
  var SUBJECT_ALLOWED = Object.freeze({
    event: Object.freeze(['character-self', 'user', 'third-party', 'system', 'world']),
    preference: Object.freeze(['user']),
    latent_state: Object.freeze(['user']),
    relational: Object.freeze(['user'])
  });

  /* expectedOutcome.kind 的允许集（= MODE_TABLE 的**非 ✗ 格**） */
  var OUTCOME_ALLOWED = Object.freeze({
    event: Object.freeze(['exclusive-outcome', 'threshold', 'window-occurrence', 'denial-claim']),
    preference: Object.freeze(['exclusive-outcome', 'state-claim', 'denial-claim']),
    latent_state: Object.freeze(['state-claim', 'denial-claim']),
    relational: Object.freeze(['state-claim', 'denial-claim'])
  });

  var CONTRADICTION_MODES = Object.freeze([
    'exclusive_outcome', 'threshold', 'explicit_denial', 'window_closure_negative', 'none'
  ]);

  /* contract §F.0 的 MODE_TABLE（✗ 格在 OUTCOME_ALLOWED 里已排除） */
  var MODE_TABLE = Object.freeze({
    event: Object.freeze({
      'exclusive-outcome': 'exclusive_outcome',
      threshold: 'threshold',
      'window-occurrence': 'window_closure_negative',
      'denial-claim': 'explicit_denial'
    }),
    preference: Object.freeze({
      'exclusive-outcome': 'exclusive_outcome',
      'state-claim': 'explicit_denial',
      'denial-claim': 'explicit_denial'
    }),
    latent_state: Object.freeze({
      'state-claim': 'explicit_denial',
      'denial-claim': 'explicit_denial'
    }),
    relational: Object.freeze({
      'state-claim': 'explicit_denial',
      'denial-claim': 'explicit_denial'
    })
  });

  /* contract §F.1–F.4 的 POLICY_TABLE（系统拥有；模型不得选择） */
  var POLICY_TABLE = Object.freeze({
    event: Object.freeze({
      type: 'event',
      autoSettlement: 'YES',
      strongestAuthority: Object.freeze(['CANONICAL_RUNTIME', 'USER_BEHAVIOR']),
      supportThreshold: 1,
      opportunityRequiredForNegative: true,
      autoSettlePreferenceFromBehavior: false
    }),
    preference: Object.freeze({
      type: 'preference',
      autoSettlement: 'CONDITIONAL',
      strongestAuthority: Object.freeze(['EXPLICIT_USER_REPORT']),
      supportThreshold: 1,
      opportunityRequiredForNegative: true,
      autoSettlePreferenceFromBehavior: false
    }),
    latent_state: Object.freeze({
      type: 'latent_state',
      autoSettlement: 'CONDITIONAL',
      strongestAuthority: Object.freeze(['EXPLICIT_USER_REPORT']),
      supportThreshold: 1,
      opportunityRequiredForNegative: true,
      autoSettlePreferenceFromBehavior: false
    }),
    relational: Object.freeze({
      type: 'relational',
      autoSettlement: 'NO',
      strongestAuthority: Object.freeze(['EXPLICIT_USER_REPORT']),
      supportThreshold: 1,
      opportunityRequiredForNegative: true,
      autoSettlePreferenceFromBehavior: false
    })
  });

  /* 观察窗口：**系统派生**。模型不得设置 opensAt / closesAt / windowKind。
     时长只由 predictionType 决定 —— 模型**无法**通过改窗口影响命中率。 */
  var HOUR = 60 * 60 * 1000;
  var WINDOW_TABLE = Object.freeze({
    event: Object.freeze({ windowKind: 'elapsed', durationMs: 24 * HOUR }),
    preference: Object.freeze({ windowKind: 'session', durationMs: 6 * HOUR }),
    latent_state: Object.freeze({ windowKind: 'turn-bounded', durationMs: 1 * HOUR }),
    relational: Object.freeze({ windowKind: 'session', durationMs: 12 * HOUR })
  });
  var WINDOW_KINDS = Object.freeze(['explicit-cue', 'elapsed', 'session', 'turn-bounded']);
  var TIME_AUTHORITY = 'SYSTEM_DERIVED';

  var OPPORTUNITY_KINDS = Object.freeze([
    'exclusive-choice', 'displayed-prompt', 'utterance-slot', 'elapsed-window', 'runtime-execution', 'none'
  ]);
  var OPPORTUNITY_EXISTENCE_AUTHORITY = 'CANONICAL_RUNTIME';

  /* ── P3.0 · BehaviorEffect attribution status（additive）────────────────
     `behaviorEffectsInForce: []` **不等于** "确认没有干预"。
     空的数组只说明"我们手上没有效果记录"，不说明"当时没有效果在生效"。
     因此用**显式三态**取代"用空数组暗示 known-absent"：

       known-none     —— 有可靠来源证明当时没有效果在生效
       known-present  —— 有可靠来源证明当时有效果在生效
       unknown        —— **没有可靠的 attribution source**（P2/P3 生产默认）

     硬规则：`unknown` MUST NOT 被当作 `NONE` 污染等级；
     对主观域 `unknown` ⇒ fail closed（见 settlement core）。 */
  var ATTRIBUTION_STATUSES = Object.freeze(['known-none', 'known-present', 'unknown']);
  var ATTRIBUTION_DEFAULT_STATUS = 'unknown';

  /* contract §F.0：opportunity.kind 由 (predictionType, predicateClass) 派生 */
  var OPPORTUNITY_TABLE = Object.freeze({
    event: 'runtime-execution',
    preference: 'exclusive-choice',
    latent_state: 'utterance-slot',
    relational: 'utterance-slot'
  });

  /* lifecyle：P2 只允许 open / superseded / withdrawn。
     matched / missed / mixed / expired_unobserved / unresolvable **属于 P3**。 */
  var LIFECYCLE_STATES = Object.freeze(['open', 'superseded', 'withdrawn']);
  var P2_SETTLEMENT_STATE_PLACEHOLDER = 'pending';

  var TRIGGER_KINDS = Object.freeze([
    'same-domain', 'same-topic', 'similar-situation', 'explicit-cue', 'time-bound'
  ]);

  var BOUNDS = Object.freeze({
    MAX_ID: 200, MAX_TEXT: 500, MAX_LABEL: 80, MAX_TOKEN: 80, MAX_UNIT: 24,
    MAX_REF: 200, MAX_REFS: 16, MAX_REASON_CODES: 32, MAX_SESSION_REF: 120
  });

  var REASON = Object.freeze({
    ok: 'ok',
    /* settleable = false 的原因（**不是**错误：非结构化 Expectation 依旧合法） */
    missingStructuredFields: 'missing-structured-prediction-fields',
    subjectKindOutOfVocabulary: 'subject-kind-out-of-vocabulary',
    predicateKindOutOfVocabulary: 'predicate-kind-out-of-vocabulary',
    outcomeKindOutOfVocabulary: 'outcome-kind-out-of-vocabulary',
    subjectKindNotPermittedForType: 'subject-kind-not-permitted-for-type',
    contradictionModeNotPermittedForType: 'contradiction-mode-not-permitted-for-type',
    predictionTypeAmbiguous: 'prediction-type-ambiguous',
    predictionTypeUnderivable: 'prediction-type-underivable',
    emptyPredictionText: 'empty-prediction-text',
    noEvidenceMemoryIds: 'no-evidence-memory-ids',
    projectionWouldExpandContent: 'projection-would-expand-content',
    attributionStatusOutOfVocabulary: 'behavior-effect-attribution-status-out-of-vocabulary',
    /* 调用方/环境问题 */
    notAnObject: 'not-an-object',
    notAValidatedExpectation: 'not-a-validated-expectation',
    turnIdentityMissing: 'turn-identity-missing',
    timeMissing: 'injected-time-missing',
    sessionRefMissing: 'registry-session-ref-missing',
    fieldTooLong: 'field-exceeds-bound',
    badConfidence: 'bad-subjective-confidence'
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
  function text(v) { return v == null ? '' : String(v); }
  function str(v, max) {
    if (v == null) return null;
    var s = String(v);
    return max && s.length > max ? s.slice(0, max + 1) : s;
  }
  function finiteTime(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : null;
  }
  function clamp01(v) {
    if (v == null) return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    if (n < 0 || n > 1) return undefined;   /* undefined = 非法（区别于 null = 无值） */
    return n;
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
     ③ 确定性推导（模型只提供三个闭集键）
     ══════════════════════════════════════════════════════════════════ */

  /* TYPE_TABLE：三个键 → **唯一** predictionType。 */
  function derivePredictionType(structured) {
    var s = isPlainObject(structured) ? structured : {};
    var subject = isPlainObject(s.subject) ? s.subject : null;
    var predicate = isPlainObject(s.predicate) ? s.predicate : null;
    var outcome = isPlainObject(s.expectedOutcome) ? s.expectedOutcome : null;
    if (!subject || !predicate || !outcome) {
      return { ok: false, reasonCode: REASON.missingStructuredFields };
    }
    var sk = text(subject.kind), pk = text(predicate.kind), ok = text(outcome.kind);
    if (SUBJECT_KINDS.indexOf(sk) < 0) return { ok: false, reasonCode: REASON.subjectKindOutOfVocabulary };
    if (PREDICATE_KINDS.indexOf(pk) < 0) return { ok: false, reasonCode: REASON.predicateKindOutOfVocabulary };
    if (OUTCOME_KINDS.indexOf(ok) < 0) return { ok: false, reasonCode: REASON.outcomeKindOutOfVocabulary };

    var cls = PREDICATE_CLASS[pk];
    var type = cls ? CLASS_TO_TYPE[cls] : null;
    if (!type || PREDICTION_TYPES.indexOf(type) < 0) {
      return { ok: false, reasonCode: REASON.predictionTypeUnderivable };
    }
    /* 主体必须在该类型的允许集内（防止把证据不足的主体塞进宽松类型） */
    if (SUBJECT_ALLOWED[type].indexOf(sk) < 0) {
      return { ok: false, reasonCode: REASON.subjectKindNotPermittedForType };
    }
    /* expectedOutcome 必须在该类型的允许集内（= MODE_TABLE 非 ✗ 格） */
    if (OUTCOME_ALLOWED[type].indexOf(ok) < 0) {
      return { ok: false, reasonCode: REASON.contradictionModeNotPermittedForType };
    }
    /* 防未来扩表引入歧义：三类键必须**唯一**判定 */
    var candidates = PREDICTION_TYPES.filter(function (t) {
      return t === type;
    });
    if (candidates.length !== 1) return { ok: false, reasonCode: REASON.predictionTypeAmbiguous };
    return { ok: true, predictionType: type, predicateClass: cls };
  }

  function derivePolicy(predictionType) {
    return POLICY_TABLE[String(predictionType)] || null;
  }

  function deriveContradictionMode(predictionType, outcomeKind) {
    var row = MODE_TABLE[String(predictionType)];
    if (!row) return null;
    return row[String(outcomeKind)] || null;
  }

  /* 观察窗口：**系统派生**；模型不得设置 opensAt / closesAt / windowKind。 */
  function deriveObservationWindow(predictionType, triggerKind, createdAt) {
    var t = String(predictionType);
    var spec = WINDOW_TABLE[t];
    if (!spec) return null;
    var at = finiteTime(createdAt);
    if (at == null) return null;
    /* trigger 只影响 **label**（windowKind），**不影响时长** ——
       模型无法通过拉长/缩短窗口影响命中率。 */
    var kind = spec.windowKind;
    if (String(triggerKind) === 'time-bound') kind = 'explicit-cue';
    if (WINDOW_KINDS.indexOf(kind) < 0) kind = spec.windowKind;
    return {
      opensAt: at,
      closesAt: at + spec.durationMs,
      windowKind: kind,
      durationMs: spec.durationMs,
      timeAuthority: TIME_AUTHORITY
    };
  }

  /* opportunity **期望形状**（P2 不计算 outcome；不猜 consumed） */
  function deriveOpportunity(predictionType, predicateClass) {
    var t = String(predictionType);
    var required = t === 'event'
      ? (POLICY_TABLE.event.opportunityRequiredForNegative === true)
      : true;
    var kind = OPPORTUNITY_TABLE[t] || 'none';
    if (String(predicateClass) === 'occurrence') kind = 'runtime-execution';
    return {
      required: required,
      kind: OPPORTUNITY_KINDS.indexOf(kind) >= 0 ? kind : 'none',
      existenceAuthority: OPPORTUNITY_EXISTENCE_AUTHORITY,
      consumedAt: null,               /* 只能由合法 OutcomeObservation / runtime evidence 产生 */
      consumedByObservationId: null
    };
  }

  /* attribution 归一：**默认 unknown**，且只有显式、闭集内的声明才被接受。
     ★ 绝不从"空数组"推断 `known-none`。 */
  function resolveAttribution(input) {
    var a = isPlainObject(input) ? input : null;
    if (!a) return { status: ATTRIBUTION_DEFAULT_STATUS, effects: [], influenced: null };
    if (ATTRIBUTION_STATUSES.indexOf(text(a.status)) < 0) return null;   /* 出集合 ⇒ 拒绝 */
    var effects = Array.isArray(a.effects) ? a.effects.slice(0, BOUNDS.MAX_REFS) : [];
    return {
      status: text(a.status),
      effects: effects,
      /* 三态**必须**保留：
         true  = 有稳定 ref 证明由本 Prediction 条件化
         false = **完整**依赖追踪证明没有 behavior 路径消费它（P5-B2 由具名
                 attribution authority 提供；追踪范围写在 snapshot 里）
         null  = 未知 / 不可用 —— **绝不**猜 false
         （P3.0 时 `false` 无法被证明，所以曾一律折成 null；P5-B2 之后
           只有当 authority 显式声明完整追踪时 `false` 才会到达这里。） */
      influenced: a.influenced === true ? true : (a.influenced === false ? false : null)
    };
  }

  function attributionIsKnownAbsent(record) {
    return !!record && record.behaviorEffectAttributionStatus === 'known-none';
  }
  function attributionIsUnknown(record) {
    return !record || record.behaviorEffectAttributionStatus === ATTRIBUTION_DEFAULT_STATUS;
  }

  /* 语义指纹：**任何**真正改变预测语义的输入都必须改变它 */
  function semanticFingerprint(input) {
    return stableToken(canonicalize({
      prediction: text(input.prediction),
      subjectKind: text(input.subjectKind),
      subjectLabel: text(input.subjectLabel),
      predicateKind: text(input.predicateKind),
      outcomeKind: text(input.outcomeKind),
      outcomeToken: text(input.outcomeToken),
      outcomeUnit: text(input.outcomeUnit)
    }));
  }

  /* 身份：确定性的，无随机 / 无全局计数器 / 不读时钟。 */
  function mintPredictionId(parts) {
    var p = isPlainObject(parts) ? parts : {};
    var required = ['characterId', 'conversationId', 'turnId'];
    for (var i = 0; i < required.length; i++) {
      if (!text(p[required[i]])) return null;
    }
    var index = p.expectationIndex == null ? '' : String(p.expectationIndex);
    return ID_PREFIX + stableToken([
      text(p.characterId), text(p.conversationId), text(p.turnId), index,
      text(p.semanticFingerprint)
    ].join('|'));
  }

  function mintRegistrySessionRef(parts) {
    var p = isPlainObject(parts) ? parts : {};
    var at = finiteTime(p.firstProjectionAt);
    if (at == null) return null;
    /* ★ 这是**实例内**审计归属，**不是**跨重启身份：
       它由 (characterId, conversationId, 首次投影时刻) 派生，且只活在本进程里。
       它**不**是 predictionId，也**不**用来关联不同 session。 */
    return SESSION_REF_PREFIX + stableToken([
      'reg', text(p.characterId), text(p.conversationId), String(at)
    ].join('|'));
  }

  /* ══════════════════════════════════════════════════════════════════
     ④ projection：唯一的建档路径
     ══════════════════════════════════════════════════════════════════ */

  function notSettleable(reasonCode, extra) {
    var out = { ok: false, settleable: false, reasonCode: reasonCode, record: null };
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /**
   * projectFromValidatedExpectation(expectation, ctx)
   *
   * expectation —— **已验证**的 R4-D expectation item（+ P2 加法式结构化字段）
   * ctx         —— { now, characterId, conversationId, turnId, expectationIndex,
   *                  registrySessionRef, evidenceIds?, interpretationRef?, currentState? }
   *
   * 返回 { ok, settleable, reasonCode, record, semanticPayload }
   *   · 非结构化 Expectation 依旧**合法** —— 只是 settleable = false（不是 crash、不是补全）
   *   · ok=false 只用于"调用方/环境"错误（缺 now / 缺身份）；语义缺字段走 settleable=false
   */
  function projectFromValidatedExpectation(expectation, ctx) {
    var e = isPlainObject(expectation) ? expectation : null;
    var c = isPlainObject(ctx) ? ctx : {};
    if (!e) return { ok: false, settleable: false, reasonCode: REASON.notAnObject, record: null };

    /* ── 调用方/环境前提（fail-closed）── */
    var now = finiteTime(c.now);
    if (now == null) return { ok: false, settleable: false, reasonCode: REASON.timeMissing, record: null };
    var characterId = text(c.characterId);
    var conversationId = text(c.conversationId);
    var turnId = text(c.turnId);
    if (!characterId || !conversationId || !turnId) {
      return { ok: false, settleable: false, reasonCode: REASON.turnIdentityMissing, record: null };
    }

    /* ── 只投影**已校验**的 expectation ── */
    if (e.epistemicStatus !== 'prediction') {
      return notSettleable(REASON.notAValidatedExpectation);
    }

    /* ── 文本与证据（缺则不可结算；**不补全**）── */
    var prediction = text(e.prediction);
    if (!prediction.trim()) return notSettleable(REASON.emptyPredictionText);
    if (prediction.length > BOUNDS.MAX_TEXT) return notSettleable(REASON.fieldTooLong);
    var evidenceIds = uniq(Array.isArray(e.evidenceMemoryIds) ? e.evidenceMemoryIds : []);
    if (!evidenceIds.length) return notSettleable(REASON.noEvidenceMemoryIds);
    var contradictory = uniq(Array.isArray(e.contradictoryEvidenceIds) ? e.contradictoryEvidenceIds : []);

    var confidence = clamp01(e.subjectivePredictionConfidence);
    if (confidence === undefined) return notSettleable(REASON.badConfidence);

    /* ── 结构字段（**模型只提供这三个闭集键**）── */
    var subject = isPlainObject(e.subject) ? e.subject : null;
    var predicate = isPlainObject(e.predicate) ? e.predicate : null;
    var outcome = isPlainObject(e.expectedOutcome) ? e.expectedOutcome : null;
    if (!subject || !predicate || !outcome) {
      return notSettleable(REASON.missingStructuredFields);
    }
    if (subject.label != null && text(subject.label).length > BOUNDS.MAX_LABEL) {
      return notSettleable(REASON.fieldTooLong);
    }
    if (outcome.token != null && text(outcome.token).length > BOUNDS.MAX_TOKEN) {
      return notSettleable(REASON.fieldTooLong);
    }
    if (outcome.unit != null && text(outcome.unit).length > BOUNDS.MAX_UNIT) {
      return notSettleable(REASON.fieldTooLong);
    }

    /* ── 类型推导（模型**不能**选 predictionType）── */
    var typeRes = derivePredictionType({
      subject: subject, predicate: predicate, expectedOutcome: outcome
    });
    if (!typeRes.ok) return notSettleable(typeRes.reasonCode);

    var predictionType = typeRes.predictionType;
    var policy = derivePolicy(predictionType);
    var contradictionMode = deriveContradictionMode(predictionType, outcome.kind);
    if (!policy || !contradictionMode) return notSettleable(REASON.predictionTypeUnderivable);

    /* ── 时间与窗口 ── */
    var triggerKind = isPlainObject(e.trigger) ? text(e.trigger.kind) : '';
    if (triggerKind && TRIGGER_KINDS.indexOf(triggerKind) < 0) triggerKind = '';
    var window = deriveObservationWindow(predictionType, triggerKind, now);
    if (!window) return notSettleable(REASON.timeMissing);

    var opportunity = deriveOpportunity(predictionType, typeRes.predicateClass);

    /* ── 干预归因（P3.0）：默认 unknown；出闭集 ⇒ 拒绝（不猜） ── */
    var attribution = resolveAttribution(c.behaviorEffectAttribution);
    if (!attribution) return notSettleable(REASON.attributionStatusOutOfVocabulary);

    /* ── 语义 payload：与 Expectation **逐字段同构**的副本（不新增自然语言）── */
    var semanticPayload = {
      prediction: prediction,
      subject: { kind: text(subject.kind), label: text(subject.label) },
      predicate: { kind: text(predicate.kind) },
      expectedOutcome: {
        kind: text(outcome.kind),
        token: outcome.token == null ? null : text(outcome.token),
        unit: outcome.unit == null ? null : text(outcome.unit)
      },
      generalizationLevel: text(e.generalizationLevel),
      trigger: { kind: triggerKind || null, label: isPlainObject(e.trigger) ? str(e.trigger.label, 200) : null }
    };

    var fingerprint = semanticFingerprint({
      prediction: prediction,
      subjectKind: subject.kind, subjectLabel: subject.label,
      predicateKind: predicate.kind,
      outcomeKind: outcome.kind, outcomeToken: outcome.token, outcomeUnit: outcome.unit
    });

    var predictionId = mintPredictionId({
      characterId: characterId, conversationId: conversationId, turnId: turnId,
      expectationIndex: c.expectationIndex, semanticFingerprint: fingerprint
    });
    if (!predictionId) return { ok: false, settleable: false, reasonCode: REASON.turnIdentityMissing, record: null };

    var record = {
      schemaVersion: SCHEMA_VERSION,
      predictionId: predictionId,
      idLifetime: ID_LIFETIME,
      registrySessionRef: c.registrySessionRef == null ? null : text(c.registrySessionRef),
      registryVersion: 'prediction-registry/v1',

      /* ── 建档快照：**只读、冻结、永不改写**（PREDICTION_CREATION_SNAPSHOT_IMMUTABLE） ── */
      predictionSnapshotAtCreation: {
        semanticPayload: semanticPayload,
        semanticFingerprint: fingerprint,
        predictionType: predictionType,
        settlementPolicy: policy.type,
        contradictionMode: contradictionMode,
        createdAt: now,
        observationWindow: window,
        scope: {
          characterId: characterId, conversationId: conversationId,
          subjectKind: text(subject.kind), subjectLabel: text(subject.label)
        },
        sourceMemoryRefs: { evidenceMemoryIds: evidenceIds, contradictoryEvidenceIds: contradictory },
        subjectivePredictionConfidence: confidence
      },

      /* ── 系统治理字段 ── */
      sourceExpectationRef: {
        characterId: characterId,
        conversationId: conversationId,
        turnId: turnId,
        expectationIndex: c.expectationIndex == null ? null : Number(c.expectationIndex)
      },
      sourceInterpretationRef: isPlainObject(c.interpretationRef) ? {
        turnId: text(c.interpretationRef.turnId),
        interpretationMemoryIds: uniq(c.interpretationRef.interpretationMemoryIds || [])
      } : null,

      predictionType: predictionType,
      settlementPolicy: policy.type,
      contradictionMode: contradictionMode,
      /* scope 必须与 P1 authority gate 的 scopeMatch 四字段**同构** ——
         少了 subjectKind/subjectLabel 会让一切观察都判成 SUBJECT-MISMATCH。 */
      scope: {
        characterId: characterId, conversationId: conversationId,
        subjectKind: text(subject.kind), subjectLabel: text(subject.label)
      },
      observationWindow: window,
      opportunity: opportunity,

      /* 三量分层（I22）：**不得**共用一个 blob */
      subjectivePredictionConfidence: confidence,
      evidenceConfidence: null,
      calibrationConfidence: null,

      /* 干预上下文（P3.0）：**三态**，默认 unknown。
         ★ `behaviorEffectsInForce: []` 只表示"手上没有效果记录"，
           **不**表示"确认没有干预" —— 不得据此得到 clean evidence。 */
      behaviorEffectsInForce: attribution.effects,
      behaviorEffectAttributionStatus: attribution.status,
      predictionInfluencedSystem: attribution.influenced,

      /* 生命周期（**P3 才允许 matched/missed/...**） */
      lifecycleState: 'open',
      settlementState: P2_SETTLEMENT_STATE_PLACEHOLDER,
      createdAt: now,
      settledAt: null,

      reasonCodes: ['ok', 'projection-is-content-non-expansive', 'not-a-settlement']
    };

    /* 内容非扩张自检：payload 的键必须 ⊆ 声明的许可集 ——
       任何**新增的认知字段**都会在这里被机械拒绝（不是靠 review）。 */
    var PAYLOAD_KEYS = ['prediction', 'subject', 'predicate', 'expectedOutcome',
      'generalizationLevel', 'trigger'];
    var extraKeys = Object.keys(semanticPayload).filter(function (k) {
      return PAYLOAD_KEYS.indexOf(k) < 0;
    });
    if (extraKeys.length) return notSettleable(REASON.projectionWouldExpandContent);

    deepFreeze(record);
    return { ok: true, settleable: true, reasonCode: REASON.ok, record: record, semanticPayload: semanticPayload };
  }

  /* ══════════════════════════════════════════════════════════════════
     ⑤ 结构校验（holder 与未来 P3 共用同一份判定）
     ══════════════════════════════════════════════════════════════════ */

  function validatePredictionRecord(r) {
    var errors = [];
    if (!isPlainObject(r)) return { ok: false, errors: ['not-an-object'] };
    if (r.schemaVersion !== SCHEMA_VERSION) errors.push('bad-schema-version');
    if (text(r.predictionId).indexOf(ID_PREFIX) !== 0) errors.push('bad-prediction-id');
    if (r.idLifetime !== ID_LIFETIME) errors.push('bad-id-lifetime');
    if (PREDICTION_TYPES.indexOf(text(r.predictionType)) < 0) errors.push('bad-prediction-type');
    if (LIFECYCLE_STATES.indexOf(text(r.lifecycleState)) < 0) errors.push('bad-lifecycle-state');
    if (r.settlementState !== P2_SETTLEMENT_STATE_PLACEHOLDER) errors.push('settlement-state-must-stay-pending-in-p2');
    if (CONTRADICTION_MODES.indexOf(text(r.contradictionMode)) < 0) errors.push('bad-contradiction-mode');
    if (!isPlainObject(r.predictionSnapshotAtCreation)) errors.push('missing-creation-snapshot');
    if (!isPlainObject(r.observationWindow)) errors.push('missing-observation-window');
    if (r.evidenceConfidence !== null) errors.push('evidence-confidence-must-be-null-in-p2');
    if (r.calibrationConfidence !== null) errors.push('calibration-confidence-must-be-null-in-p2');
    if (ATTRIBUTION_STATUSES.indexOf(text(r.behaviorEffectAttributionStatus)) < 0) {
      errors.push('bad-behavior-effect-attribution-status');
    }
    if (!Array.isArray(r.behaviorEffectsInForce)) errors.push('bad-behavior-effects-in-force');
    if (r.settledAt !== null) errors.push('settled-at-must-be-null-in-p2');
    if (!Object.isFrozen(r)) errors.push('record-not-frozen');
    return { ok: errors.length === 0, errors: errors };
  }

  return {
    /* API */
    projectFromValidatedExpectation: projectFromValidatedExpectation,
    derivePredictionType: derivePredictionType,
    derivePolicy: derivePolicy,
    deriveContradictionMode: deriveContradictionMode,
    deriveObservationWindow: deriveObservationWindow,
    deriveOpportunity: deriveOpportunity,
    resolveAttribution: resolveAttribution,
    attributionIsKnownAbsent: attributionIsKnownAbsent,
    attributionIsUnknown: attributionIsUnknown,
    semanticFingerprint: semanticFingerprint,
    mintPredictionId: mintPredictionId,
    mintRegistrySessionRef: mintRegistrySessionRef,
    validatePredictionRecord: validatePredictionRecord,
    canonicalize: canonicalize,

    /* 冻结常量 */
    SCHEMA_VERSION: SCHEMA_VERSION,
    ID_PREFIX: ID_PREFIX,
    SESSION_REF_PREFIX: SESSION_REF_PREFIX,
    ID_LIFETIME: ID_LIFETIME,
    PREDICTION_TYPES: PREDICTION_TYPES,
    SUBJECT_KINDS: SUBJECT_KINDS,
    PREDICATE_KINDS: PREDICATE_KINDS,
    PREDICATE_CLASS: PREDICATE_CLASS,
    CLASS_TO_TYPE: CLASS_TO_TYPE,
    OUTCOME_KINDS: OUTCOME_KINDS,
    OUTCOME_ALLOWED: OUTCOME_ALLOWED,
    SUBJECT_ALLOWED: SUBJECT_ALLOWED,
    MODE_TABLE: MODE_TABLE,
    POLICY_TABLE: POLICY_TABLE,
    WINDOW_TABLE: WINDOW_TABLE,
    WINDOW_KINDS: WINDOW_KINDS,
    OPPORTUNITY_TABLE: OPPORTUNITY_TABLE,
    OPPORTUNITY_KINDS: OPPORTUNITY_KINDS,
    OPPORTUNITY_EXISTENCE_AUTHORITY: OPPORTUNITY_EXISTENCE_AUTHORITY,
    ATTRIBUTION_STATUSES: ATTRIBUTION_STATUSES,
    ATTRIBUTION_DEFAULT_STATUS: ATTRIBUTION_DEFAULT_STATUS,
    CONTRADICTION_MODES: CONTRADICTION_MODES,
    LIFECYCLE_STATES: LIFECYCLE_STATES,
    P2_SETTLEMENT_STATE_PLACEHOLDER: P2_SETTLEMENT_STATE_PLACEHOLDER,
    TRIGGER_KINDS: TRIGGER_KINDS,
    BOUNDS: BOUNDS,
    REASON: REASON,

    STATE_SUPPORT: Object.freeze({
      predictionRegistry: 'PURE_PROJECTION_CORE',
      registryLifetime: 'SESSION_ONLY',
      durablePredictionStore: 'NO_V1',
      modelMayNotChoosePredictionType: 'YES',
      freeTextToPredictionParsing: 'FORBIDDEN',
      registryMayNotInventContent: 'YES',
      projectionIsContentNonExpansive: 'YES',
      creationSnapshotImmutable: 'YES',
      modelMayNotDeclareOpportunityExistence: 'YES',
      behaviorEffectAttributionDefault: ATTRIBUTION_DEFAULT_STATUS,
      emptyEffectsArrayDoesNotImplyKnownAbsent: 'YES',
      settlementEngine: 'NONE',
      predictionErrorCalculation: 'NONE',
      calibration: 'NONE',
      modelCalls: 0,
      durableWrites: 0,
      clockReads: 0
    })
  };
});
