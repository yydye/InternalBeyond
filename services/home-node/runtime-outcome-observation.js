'use strict';
/* ====================================================================
   IB Home Node · OutcomeObservation Production Authority（P5-B3-B）
   --------------------------------------------------------------------
   OUTCOME_OBSERVATION_PRODUCER MAY OBSERVE FACTS
   OUTCOME_OBSERVATION_PRODUCER MAY NOT INTERPRET SETTLEMENT

   Producer 可以决定：what happened · when · where · concerning whom ·
     source provenance · bounded factual payload · observation identity
   Producer 禁止决定：support · conflict · matched · missed · mixed ·
     settleable · calibrationCounted · predictionType · authority level

   OBSERVATION_FACT_AUTHORITY != SEMANTIC_RELATION_AUTHORITY != SETTLEMENT_AUTHORITY

   ── 本模块不自己做第二套 validation ──────────────────────────────────
     事实 → **canonical P1 builder**（buildOutcomeObservation）→ sealed capability。
     `MODEL_INFERENCE` **不得** mint 现实事实。
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const OBSERVATION_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'outcome-observation-core.js'));
const ATTRIBUTION_CORE = require(path.join(ASSETS_JS, 'memory-recall', 'behavior-effect-attribution-core.js'));
const PREF = require(path.join(ASSETS_JS, 'memory-recall', 'preference-proposition-core.js'));

const ENTRY = 'mintObservation';
const ID_LIFETIME = 'SESSION_ONLY';

/* ── 静态 producer allowlist（**禁止**动态注册）─────────────────────────
   每项冻结：producer id · allowed source · allowed target domains ·
   timestamp authority · required identity fields · sourceInstance。
   `sourceInstance` 必须落在 P1 的 AUTHORIZED_OBSERVERS 里。 */
const PRODUCER_TABLE = Object.freeze({
  'runtime-state': Object.freeze({
    producerId: 'runtime-state',
    allowedSource: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.delivery',
    allowedDomains: Object.freeze(['runtime_state']),
    timestampAuthority: 'CANONICAL_EVENT_TIMESTAMP',
    requiredIdentity: Object.freeze(['sourceEventId', 'characterId', 'conversationId', 'occurredAt'])
  }),
  'runtime-activity': Object.freeze({
    producerId: 'runtime-activity',
    allowedSource: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.activity',
    allowedDomains: Object.freeze(['runtime_state']),
    timestampAuthority: 'CANONICAL_EVENT_TIMESTAMP',
    requiredIdentity: Object.freeze(['sourceEventId', 'characterId', 'conversationId', 'occurredAt'])
  }),
  'user-action': Object.freeze({
    producerId: 'user-action',
    allowedSource: 'USER_BEHAVIOR',
    sourceInstance: 'runtime.user-action',
    allowedDomains: Object.freeze(['user_behavior']),
    timestampAuthority: 'CANONICAL_EVENT_TIMESTAMP',
    requiredIdentity: Object.freeze(['sourceEventId', 'characterId', 'conversationId', 'occurredAt'])
  }),
  /* ordinary chat text 一律低权：**绝不**自动升为 explicit report */
  'linguistic-evidence': Object.freeze({
    producerId: 'linguistic-evidence',
    allowedSource: 'LINGUISTIC_EVIDENCE',
    sourceInstance: 'runtime.interpretation-evidence',
    allowedDomains: Object.freeze(['user_preference', 'latent_state', 'relationship', 'user_emotion', 'user_intent']),
    timestampAuthority: 'CANONICAL_EVENT_TIMESTAMP',
    requiredIdentity: Object.freeze(['sourceEventId', 'characterId', 'conversationId', 'occurredAt'])
  }),
  /* ── P5-B3-E-R1 · **唯一**一个 EXPLICIT_USER_REPORT producer ──────────────
     它只能由 dedicated structured report seam → reality source 这条链到达
     （EXPLICITNESS_AUTHORITY = DEDICATED_STRUCTURED_USER_REPORT_ACTION）。
     ★ 自由文本 / 语言证据 / 模型推断 / 用户行为**没有**任何 producer 能落到
       这个 source 上（见 test_structured_explicit_preference_report 的洗权矩阵）。
     ★ sourceInstance 是**新的精确 token**（`chat.user-utterance` 是旧泛化名，
       语义 = "任意用户聊天话语"，与本轮 authority model 冲突，故不复用）。
     ★ 第一版只开放 user_preference 一个域。 */
  'explicit-user-report': Object.freeze({
    producerId: 'explicit-user-report',
    allowedSource: 'EXPLICIT_USER_REPORT',
    sourceInstance: 'user.explicit-preference-report',
    allowedDomains: Object.freeze(['user_preference']),
    timestampAuthority: 'CANONICAL_EVENT_TIMESTAMP',
    requiredIdentity: Object.freeze(['sourceEventId', 'characterId', 'conversationId', 'occurredAt'])
  })
});

/* producer payload 里**禁止**出现的键（出现即拒绝，绝不静默生效） */
const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  'relation', 'support', 'conflict', 'irrelevant', 'ambiguous',
  'settlementState', 'state', 'lifecycleState', 'matched', 'missed', 'mixed',
  'expired_unobserved', 'unresolvable', 'superseded',
  'calibrationCounted', 'calibrationConfidence', 'settleable', 'validated',
  'predictionType', 'targetDomain', 'source', 'sourceInstance', 'authorityLevel',
  'admissibility', 'opportunity', 'predictionInfluencedSystem', 'contaminationClass',
  'confidence', 'probability', 'score'
]);

const REASON = Object.freeze({
  ok: 'ok',
  unknownProducer: 'producer-not-registered',
  sourceNotAllowed: 'producer-not-authorized-for-source',
  domainNotAllowed: 'producer-not-authorized-for-domain',
  missingIdentity: 'producer-event-identity-missing',
  missingEventTime: 'producer-event-time-missing',
  pairingBindingMissing: 'pairing-binding-missing',
  realityEventNotSealed: 'reality-event-not-sealed-authoritative',
  forbiddenPayloadField: 'producer-payload-carries-authority-field',
  payloadNotBounded: 'producer-payload-not-bounded',
  builderRefused: 'canonical-builder-refused',
  duplicateSuppressed: 'duplicate-source-event-suppressed',
  attributionUnavailable: 'outcome-attribution-unavailable',
  attributionUnknown: 'outcome-attribution-unknown',
  attributionKnownNone: 'outcome-attribution-known-none',
  attributionKnownPresent: 'outcome-attribution-known-present',
  modelInferenceForbidden: 'model-inference-may-not-mint-reality',
  structuredProjectionRefused: 'structured-source-projection-refused',
  internalAuditOnly: 'internal-audit-only',
  sessionOnly: 'session-only-lifetime'
});

const BOUNDS = Object.freeze({
  MAX_HELD_OBSERVATIONS: 256,
  MAX_EVIDENCE_REFS: 8,
  MAX_TOKEN_CHARS: 120,
  MAX_PAYLOAD_KEYS: 12,
  MAX_PAIRING_CANDIDATES: 16
});

/* ── P5-B3-E-R1 · RealityEvent provenance → projection descriptor（静态表）──
   机械 source（CANONICAL_RUNTIME）的映射规则**未改**：
     producer = runtime-state · targetDomain = runtime_state · token = domain.type
   结构化 source 需要一张显式的表，理由只有一条：它的 proposition 在
   `re.body` 里（targetKey + stance），**不可能**从 domain/type 推出来
   （`domain-event-core` 的 TOKEN_PATTERN 也不允许点号）。
   ★ 表是闭集 + 精确 sourceInstance，禁止动态注册。
   ★ 表命中时 producer/targetDomain **由 provenance 决定**，调用方无法覆盖
     （否则"给一个 producerId"就能把结构化事实塞进别的 source class）。 */
const STRUCTURED_PROJECTIONS = Object.freeze({
  'user.explicit-preference-report': Object.freeze({
    producerId: 'explicit-user-report',
    targetDomain: 'user_preference',
    tokenOf: function (re) {
      return PREF.buildPreferenceToken(text(re.body && re.body.stance), text(re.body && re.body.targetKey));
    }
  })
});

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : null; }
function stableToken(seed) {
  var s = text(seed), h1 = 0x811c9dc5, h2 = 0x01000193;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
    h2 = ((h2 ^ c) * 16777619) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 14);
}
function canonicalize(v) {
  try { return OBSERVATION_CORE.canonicalize ? OBSERVATION_CORE.canonicalize(v) : JSON.stringify(v); }
  catch (e) { try { return JSON.stringify(v); } catch (e2) { return null; } }
}

/** 事实指纹：只取**事实**字段，且顺序固定 ⇒ 确定性。 */
function factualFingerprint(sourceEvent, payload) {
  return canonicalize({
    kind: text(sourceEvent && sourceEvent.kind),
    token: text(sourceEvent && sourceEvent.token),
    statement: text(sourceEvent && sourceEvent.statement).slice(0, 400),
    completeness: text(sourceEvent && sourceEvent.completeness),
    payload: isPlainObject(payload) ? payload : null
  });
}

/* ── P5-B3-C · projection identity ──────────────────────────────────────
   OutcomeObservation = RealityEvent 针对某条 Prediction 的 **evaluation projection**。
   identity = f(realityEventId, predictionId, projectionVersion) ⇒
     · 同一现实事实对不同 Prediction ⇒ 不同 projection（O1 ≠ O2）
     · 同一 (E, P) 重复 ⇒ 同一 projection（幂等）
   ★ RealityEvent 自身的 identity **不含** predictionId（见 runtime-reality-event.js）。 */
const OBSERVATION_PROJECTION_VERSION = 'observation-projection/v1';
function projectionIdOf(realityEventId, predictionId) {
  return 'obs_' + stableToken([
    text(realityEventId), text(predictionId), OBSERVATION_PROJECTION_VERSION
  ].join('|'));
}
/** lineage 读取：evidenceRefs[0] 约定为 realityEventRef（P1 schema 未新增字段）。 */
function realityEventRefOf(observation) {
  const refs = observation && Array.isArray(observation.evidenceRefs) ? observation.evidenceRefs : [];
  return refs.length ? text(refs[0]) : null;
}

/** observationId：确定性；**不含** Date.now / Math.random / 进程计数器。 */
function observationIdOf(producer, sourceEvent, characterId, conversationId, predictionId) {
  return 'obs_' + stableToken([
    producer.producerId,
    text(sourceEvent.sourceEventId),
    text(characterId),
    text(conversationId),
    text(predictionId),
    String(num(sourceEvent.occurredAt) || 0),
    factualFingerprint(sourceEvent, sourceEvent.payload)
  ].join('|'));
}

/**
 * §20 · 事实 → contaminationClass 的**确定性**映射（attribution 只给事实）。
 * 这是机械查表，不是模型判断，也不是 attribution authority 的越权。
 *   unknown / unavailable        → UNKNOWN
 *   known-none（完整覆盖、零 effect）→ NONE
 *   known-present ∧ influenced    → DIRECT（system 行为由本 Prediction 条件化）
 *   known-present ∧ ¬influenced   → LIKELY（时间重叠但不是本 Prediction 引起）
 *   known-present ∧ null          → UNKNOWN
 * ★ 最终**门**仍由 P1 core 施加（这里只提供 class）。
 */
function contaminationClassFromFacts(attribution) {
  var a = attribution || {};
  if (a.status === 'known-none' && a.coverage === 'complete') return 'NONE';
  if (a.status === 'known-present') {
    if (a.influenced === true) return 'DIRECT';
    if (a.influenced === false) return 'LIKELY';
    return 'UNKNOWN';
  }
  return 'UNKNOWN';
}

function createRuntimeOutcomeObservation(deps) {
  const d = deps || {};
  const registry = d.registry || null;                       /* Prediction Registry（只读） */
  const attributionAuthority = d.attributionAuthority || null;
  const settlementRuntime = d.settlementRuntime || null;     /* 唯一消费接力点（不在本轮自动调用） */
  const logger = typeof d.logger === 'function' ? d.logger : null;
  const maxHeld = Number.isFinite(Number(d.maxHeldObservations)) && Number(d.maxHeldObservations) > 0
    ? Number(d.maxHeldObservations) : BOUNDS.MAX_HELD_OBSERVATIONS;

  /* bounded session idempotency（**不是** durable store，也不是无界 Set） */
  const held = new Map();
  const heldOrder = [];
  const counters = {
    attempts: 0, minted: 0, duplicatesSuppressed: 0,
    rejectedProducer: 0, rejectedSource: 0, rejectedDomain: 0,
    rejectedIdentity: 0, rejectedEventTime: 0, rejectedPayload: 0,
    builderRefused: 0, attributionFailures: 0, evicted: 0, rejectedPairing: 0,
    rejectedRealityEvent: 0, projected: 0,
    pairingQueries: 0, modelCalls: 0, durableWrites: 0
  };

  function evict() {
    while (held.size > maxHeld && heldOrder.length) {
      const k = heldOrder.shift();
      if (held.has(k)) { held.delete(k); counters.evicted += 1; }
    }
  }
  function refuse(reasonCode, extra) {
    return Object.assign({ ok: false, status: 'refused', reasonCode: reasonCode, observation: null }, extra || {});
  }

  /** 事件时间归因：**必须**用 reality event time，不是处理时间。 */
  function attributionAt(characterId, conversationId, at, subjectLabel) {
    if (!attributionAuthority || typeof attributionAuthority.snapshotBehaviorEffectAttribution !== 'function') {
      return { status: 'unknown', coverage: 'unavailable', influenced: null, reasonCode: REASON.attributionUnavailable, refs: [], effects: [] };
    }
    try {
      const snap = attributionAuthority.snapshotBehaviorEffectAttribution({
        characterId: characterId, conversationId: conversationId, at: at, subjectLabel: subjectLabel
      });
      const valid = typeof attributionAuthority.isBehaviorEffectAttributionSnapshot !== 'function'
        || attributionAuthority.isBehaviorEffectAttributionSnapshot(snap) === true;
      if (!snap || valid !== true) {
        return { status: 'unknown', coverage: 'unavailable', influenced: null, reasonCode: REASON.attributionUnavailable, refs: [], effects: [] };
      }
      if (text(snap.scope && snap.scope.characterId) !== text(characterId)
        || text(snap.scope && snap.scope.conversationId) !== text(conversationId)) {
        return { status: 'unknown', coverage: 'unavailable', influenced: null, reasonCode: REASON.attributionUnavailable, refs: [], effects: [] };
      }
      return {
        status: ATTRIBUTION_CORE.STATUSES.indexOf(text(snap.status)) >= 0 ? text(snap.status) : 'unknown',
        coverage: text(snap.coverage),
        influenced: snap.predictionInfluencedSystem === true ? true
          : (snap.predictionInfluencedSystem === false ? false : null),
        reasonCode: text(snap.status) === 'known-none' ? REASON.attributionKnownNone
          : (text(snap.status) === 'known-present' ? REASON.attributionKnownPresent : REASON.attributionUnknown),
        effects: (Array.isArray(snap.effects) ? snap.effects : []).slice(0, 8).map(function (e) {
          return {
            sourceTurn: text(e && e.sourceTurn),
            stance: text(e && e.stance),
            strategy: text(e && e.strategy),
            initiativeTendency: text(e && e.initiativeTendency),
            rationaleCode: text(e && e.rationaleCode)
          };
        }),
        refs: (Array.isArray(snap.effects) ? snap.effects : []).map(function (e) { return text(e && e.effectInstanceId); }).slice(0, 8)
      };
    } catch (_) {
      return { status: 'unknown', coverage: 'unavailable', influenced: null, reasonCode: REASON.attributionUnavailable, refs: [], effects: [] };
    }
  }

  /* ── 唯一 mint 入口 ─────────────────────────────────────────────────── */
  /**
   * mintObservation({ producerId, sourceEvent, predictionRef, targetDomain, ... })
   *   sourceEvent   = { sourceEventId, characterId, conversationId, occurredAt,
   *                     kind, token, statement, payload }        ← producer 提供**事实**
   *   predictionRef = { predictionId, opensAt, closesAt, predictionCreatedAt }
   *                                                               ← **pairing authority** 提供
   * ★ producer 不拥有 pairing authority：它不知道"哪些 Prediction 该看这个事件"。
   * ★ payload 无权携带 source / targetDomain / 结算状态 / relation。
   */
  function mintObservation(input) {
    const i = isPlainObject(input) ? input : {};
    counters.attempts += 1;
    const producer = PRODUCER_TABLE[text(i.producerId)];
    if (!producer) { counters.rejectedProducer += 1; return refuse(REASON.unknownProducer); }
    /* `MODEL_INFERENCE` 永远不能成为现实的 producer */
    if (text(producer.allowedSource) === 'MODEL_INFERENCE') {
      return refuse(REASON.modelInferenceForbidden);
    }
    const ev = isPlainObject(i.sourceEvent) ? i.sourceEvent : null;
    if (!ev) { counters.rejectedIdentity += 1; return refuse(REASON.missingIdentity); }

    /* ① 身份完整性（含 event time） */
    for (const need of producer.requiredIdentity) {
      if (ev[need] == null || text(ev[need]) === '') {
        counters.rejectedIdentity += 1;
        return refuse(REASON.missingIdentity, { missing: need });
      }
    }
    const occurredAt = num(ev.occurredAt);
    if (occurredAt == null) { counters.rejectedEventTime += 1; return refuse(REASON.missingEventTime); }
    const characterId = text(ev.characterId);
    const conversationId = text(ev.conversationId);

    /* ①b pairing binding：观察必须绑定到一个 Prediction window（P1 要求）。
       它来自 pairing authority（Registry），**不**来自 producer 的 payload。 */
    const ref = isPlainObject(i.predictionRef) ? i.predictionRef : null;
    const predictionId = text(ref && ref.predictionId);
    if (!predictionId) { counters.rejectedPairing += 1; return refuse(REASON.pairingBindingMissing); }

    /* ② payload 越权字段：拒绝（绝不静默生效） */
    const payload = isPlainObject(ev.payload) ? ev.payload : {};
    const payloadKeys = Object.keys(payload);
    if (payloadKeys.length > BOUNDS.MAX_PAYLOAD_KEYS) {
      counters.rejectedPayload += 1;
      return refuse(REASON.payloadNotBounded, { keys: payloadKeys.length });
    }
    for (const k of payloadKeys) {
      if (FORBIDDEN_PAYLOAD_KEYS.indexOf(k) >= 0) {
        counters.rejectedPayload += 1;
        return refuse(REASON.forbiddenPayloadField, { field: k });
      }
    }
    /* source / domain **由 producer 表决定**，payload 无权覆盖 */
    const source = text(producer.allowedSource);
    const targetDomain = text(i.targetDomain) || producer.allowedDomains[0];
    if (producer.allowedDomains.indexOf(targetDomain) < 0) {
      counters.rejectedDomain += 1;
      return refuse(REASON.domainNotAllowed, { targetDomain: targetDomain, allowed: producer.allowedDomains.slice() });
    }

    /* ③ 观察身份 + bounded 幂等（同 source event ⇒ 同一条逻辑 observation） */
    const observationId = observationIdOf(producer, ev, characterId, conversationId, predictionId);
    if (held.has(observationId)) {
      counters.duplicatesSuppressed += 1;
      return {
        ok: true, status: 'duplicate', reasonCode: REASON.duplicateSuppressed,
        observation: held.get(observationId), observationId: observationId, reused: true
      };
    }

    /* ④ outcome-time attribution：**at = reality event time**（不是 now） */
    const attribution = attributionAt(characterId, conversationId, occurredAt, text(i.subjectLabel));
    if (attribution.status === 'unknown') counters.attributionFailures += 1;

    /* ⑤ 交给 **canonical P1 builder**（不自己造第二套 validation） */
    const scope = {
      characterId: characterId, conversationId: conversationId,
      subjectKind: text(i.subjectKind) || 'user', subjectLabel: text(i.subjectLabel)
    };
    const outcomeRef = { kind: text(ev.kind) === 'statement' ? 'statement' : 'token' };
    if (outcomeRef.kind === 'token') outcomeRef.token = text(ev.token);
    else outcomeRef.statement = text(ev.statement).slice(0, 600);
    const built = OBSERVATION_CORE.buildOutcomeObservation({
      windowRef: {
        predictionId: predictionId,
        predictionCreatedAt: num(ref.predictionCreatedAt),
        opensAt: num(ref.opensAt) || occurredAt,
        closesAt: num(ref.closesAt) || occurredAt
      },
      source: source,
      sourceInstance: producer.sourceInstance,
      targetDomain: targetDomain,
      observedAt: occurredAt,
      completeness: text(i.completeness) || text(ev.completeness) || 'point',
      scope: scope,
      outcomeRef: outcomeRef,
      evidenceRefs: (Array.isArray(i.evidenceRefs) ? i.evidenceRefs : []).map(text).slice(0, BOUNDS.MAX_EVIDENCE_REFS),
      /* interventionContext 是**闭集 4 键**；attribution 只提供 facts，
         contaminationClass 的分类权在 P1 core（这里刻意给 UNKNOWN，不越权）。 */
      interventionContext: {
        behaviorEffectsInForce: attribution.effects || [],
        predictionInfluencedSystem: attribution.influenced == null ? null : attribution.influenced === true,
        contaminationClass: contaminationClassFromFacts(attribution),
        contaminationBasis: 'outcome-time-attribution:' + attribution.status + ':' + attribution.coverage
          + ':' + contaminationClassFromFacts(attribution)
      },
      /* 审计指向信息走 reasonCodes（observation 的允许字段） */
      reasonCodes: [
        'outcome-attribution:' + attribution.status,
        'outcome-attribution-at:' + occurredAt,
        REASON.internalAuditOnly
      ]
    });
    if (!built || built.ok !== true) {
      counters.builderRefused += 1;
      return refuse(REASON.builderRefused, { builderErrors: (built && built.errors) || null });
    }
    held.set(observationId, built.value);
    heldOrder.push(observationId);
    counters.minted += 1;
    evict();
    return {
      ok: true, status: 'minted', reasonCode: REASON.ok,
      observation: built.value, observationId: observationId,
      attribution: { status: attribution.status, coverage: attribution.coverage, at: occurredAt },
      reused: false
    };
  }

  /* ── 候选 pairing：**只**回答"值不值得评估"，不回答 relation ─────────── */
  function candidatePredictions(observation, query) {
    counters.pairingQueries += 1;
    if (!registry || typeof registry.listOpenPredictions !== 'function' || !observation) return [];
    const q = isPlainObject(query) ? query : {};
    let list = [];
    try { list = registry.listOpenPredictions({ characterId: q.characterId, conversationId: q.conversationId }) || []; }
    catch (_) { list = []; }
    /* P5-B3-D4-R3 · 同时接受两种 canonical 输入形状：
       · OutcomeObservation（.scope / .observedAt）
       · sealed RealityEvent（.characterId / .conversationId / .occurredAt）
       两者都是 canonical，这里只是把**同一个** scope/时间查询喂给 Registry；
       **不**复制任何 scope matching 逻辑（仍由 listOpenPredictions + 窗口包含判定）。 */
    const subject = (observation && observation.scope && typeof observation.scope === 'object')
      ? { characterId: text(observation.scope.characterId), conversationId: text(observation.scope.conversationId), at: num(observation.observedAt) }
      : { characterId: text(observation && observation.characterId), conversationId: text(observation && observation.conversationId), at: num(observation && observation.occurredAt) };
    return list
      .filter(function (r) {
        if (!r) return false;
        if (text(r.scope && r.scope.characterId) !== subject.characterId) return false;
        if (text(r.scope && r.scope.conversationId) !== subject.conversationId) return false;
        /* 时间窗必须覆盖事件时刻 */
        const opens = num(r.observationWindow && r.observationWindow.opensAt);
        const closes = num(r.observationWindow && r.observationWindow.closesAt);
        const at = subject.at;
        if (opens != null && at != null && at < opens) return false;
        if (closes != null && at != null && at > closes) return false;
        return true;
      })
      .slice(0, BOUNDS.MAX_PAIRING_CANDIDATES)
      .map(function (r) { return text(r.predictionId); });
  }

  /* ── P5-B3-C · RealityEvent → prediction-scoped projection ───────────── */
  /**
   * projectForPrediction({ realityEvent, predictionRef, targetDomain, ... })
   *   ① 只接受 **sealed** RealityEvent（schema-valid != authoritative）
   *   ② 事实（character/conversation/occurredAt/token）**全部**取自 RealityEvent
   *   ③ projection identity = f(realityEventId, predictionId, projectionVersion)
   *   ④ lineage：evidenceRefs[0] = realityEventId（P1 schema 不新增字段）
   *   ⑤ 归因在 **RealityEvent.occurredAt** 查询（不是处理时间）
   */
  function projectForPrediction(input) {
    const i = isPlainObject(input) ? input : {};
    const re = isPlainObject(i.realityEvent) ? i.realityEvent : null;
    const validator = typeof i.isRealityEvent === 'function'
      ? i.isRealityEvent
      : (typeof d.isRealityEvent === 'function' ? d.isRealityEvent : null);
    if (!re || !validator || validator(re) !== true) {
      counters.rejectedRealityEvent += 1;
      return refuse(REASON.realityEventNotSealed);
    }
    const ref = isPlainObject(i.predictionRef) ? i.predictionRef : null;
    if (!text(ref && ref.predictionId)) {
      counters.rejectedPairing += 1;
      return refuse(REASON.pairingBindingMissing);
    }
    /* 事实 → 既有 canonical mint 路径（**不**复制 validation） */
    const structured = STRUCTURED_PROJECTIONS[text(re.sourceInstance)] || null;
    /* ★ 结构化 source：producer / targetDomain / token 全部由 **provenance** 决定，
       调用方给的 i.producerId / i.targetDomain 在这里**不参与**（防止跨 source 洗权）。 */
    const token = structured ? structured.tokenOf(re) : (text(re.domain) + '.' + text(re.type));
    if (structured && !token) return refuse(REASON.structuredProjectionRefused);
    const res = mintObservation({
      producerId: structured ? structured.producerId : (text(i.producerId) || 'runtime-state'),
      targetDomain: structured ? structured.targetDomain : (text(i.targetDomain) || 'runtime_state'),
      predictionRef: ref,
      completeness: text(i.completeness) || 'point',
      subjectKind: i.subjectKind, subjectLabel: i.subjectLabel,
      evidenceRefs: [text(re.realityEventId)].concat(
        Array.isArray(i.evidenceRefs) ? i.evidenceRefs.map(text) : []).slice(0, BOUNDS.MAX_EVIDENCE_REFS),
      sourceEvent: {
        sourceEventId: text(re.realityEventId),
        characterId: text(re.characterId),
        conversationId: text(re.conversationId),
        occurredAt: re.occurredAt,
        kind: 'token',
        token: token,
        completeness: 'point',
        payload: re.body
      }
    });
    if (!res.ok) return res;
    counters.projected += 1;
    return Object.assign({}, res, {
      realityEventRef: text(re.realityEventId),
      projectionId: projectionIdOf(re.realityEventId, ref.predictionId),
      projectionVersion: OBSERVATION_PROJECTION_VERSION
    });
  }

  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      entry: ENTRY,
      lifetime: ID_LIFETIME,
      disclosure: 'INTERNAL_AUDIT_ONLY',
      oneCanonicalObservationMintPath: 'YES',
      capabilityMintAuthority: 'OUTCOME_OBSERVATION_CORE_BUILDER',
      producerSourceAllowlist: 'REQUIRED',
      dynamicProducerRegistration: 'FORBIDDEN',
      producerMayInterpretSettlement: 'NO',
      outcomeAttributionSnapshotTime: 'REALITY_EVENT_TIME',
      observationEqualsOpportunity: 'NO',
      pairingAuthority: 'PREDICTION_REGISTRY_SCOPE_QUERY',
      pairingImpliesRelation: 'NO',
      modelInferenceMayMintReality: 'NO',
      /* P5-B3-E-R1：从 NOT_AVAILABLE 到 LIVE_CAPABLE —— producer 存在，且**只有**
         dedicated structured report 链能到达它。 */
      explicitUserReportProducer: 'LIVE_CAPABLE',
      explicitUserReportSourceInstance: 'user.explicit-preference-report',
      explicitUserReportDomains: ['user_preference'],
      structuredProjectionSources: Object.keys(STRUCTURED_PROJECTIONS),
      structuredProjectionOverridableByCaller: 'NO',
      freeTextMayReachExplicitReportProducer: 'NO',
      /* P5-B3-C */
      outcomeObservationRole: 'PREDICTION_SCOPED_REALITY_PROJECTION',
      realityEventIdentityIndependentOfPrediction: 'YES',
      observationProjectionVersion: OBSERVATION_PROJECTION_VERSION,
      requiresSealedRealityEvent: 'YES',
      observationIdentityContainsPredictionId: 'YES',
      realityEventIdentityContainsPredictionId: 'NO',
      lineageField: 'evidenceRefs[0] = realityEventId',
      producers: Object.keys(PRODUCER_TABLE).map(function (k) {
        return {
          producerId: k,
          allowedSource: PRODUCER_TABLE[k].allowedSource,
          sourceInstance: PRODUCER_TABLE[k].sourceInstance,
          allowedDomains: PRODUCER_TABLE[k].allowedDomains.slice(),
          timestampAuthority: PRODUCER_TABLE[k].timestampAuthority
        };
      }),
      holder: { maxEntries: maxHeld, current: held.size, durability: 'NONE' },
      durableWrites: 0,
      modelCalls: 0,
      counters: Object.assign({}, counters)
    };
  }

  return {
    ENTRY: ENTRY,
    mintObservation: mintObservation,
    projectForPrediction: projectForPrediction,
    realityEventRefOf: realityEventRefOf,
    projectionIdOf: projectionIdOf,
    candidatePredictions: candidatePredictions,
    describe: describe,
    heldObservationCount: function () { return held.size; },
    PRODUCER_TABLE: PRODUCER_TABLE,
    FORBIDDEN_PAYLOAD_KEYS: FORBIDDEN_PAYLOAD_KEYS,
    awaitIdle: function () { return Promise.resolve({ idle: true, inFlight: 0 }); }
  };
}

module.exports = {
  createRuntimeOutcomeObservation: createRuntimeOutcomeObservation,
  PRODUCER_TABLE: PRODUCER_TABLE,
  FORBIDDEN_PAYLOAD_KEYS: FORBIDDEN_PAYLOAD_KEYS,
  observationIdOf: observationIdOf,
  projectionIdOf: projectionIdOf,
  realityEventRefOf: realityEventRefOf,
  OBSERVATION_PROJECTION_VERSION: OBSERVATION_PROJECTION_VERSION,
  factualFingerprint: factualFingerprint,
  REASON: REASON,
  BOUNDS: BOUNDS,
  ID_LIFETIME: ID_LIFETIME,
  ENTRY: ENTRY
};








