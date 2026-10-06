'use strict';
/* ====================================================================
   IB Home Node · RealityEvent Authority（Prediction Error P5-B3-C）
   --------------------------------------------------------------------
   REALITY_EVENT != OUTCOME_OBSERVATION
   REALITY_EVENT_IDENTITY MUST NOT DEPEND ON PREDICTION_ID

   现实发生的一件事，先成为 **canonical RealityEvent**（与 Prediction 无关），
   之后才被 pairing 到候选 Prediction，投影成 prediction-scoped
   OutcomeObservation。

     source event → RealityEvent E42 → candidate pairing
                  → E42×P1 → O1 ，E42×P2 → O2

   ── schema 复用 ──────────────────────────────────────────────────────
     事件 schema **不另造**：直接复用既有 canonical
     `assets/js/domain-event-core.js`（UMD · Node 可用 · 注入 timestamp ·
     确定性 eventId 派生 · causation/correlation · 拒绝泄漏 body 字段）。
     本模块只补两件 domain-event-core **没有**的东西：
       ① trusted runtime producer 的 authority 校验
       ② capability seal（schema-valid != authoritative）

   ── 它**没有**的能力 ─────────────────────────────────────────────────
     relation · settlement state · predictionType · admissibility ·
     calibration · memory · relationship · 任何 prediction authority。
   ==================================================================== */

const path = require('path');

const ASSETS_JS = path.join(__dirname, '..', '..', 'assets', 'js');
const DOMAIN_EVENT = require(path.join(ASSETS_JS, 'domain-event-core.js'));
const PREF = require(path.join(ASSETS_JS, 'memory-recall', 'preference-proposition-core.js'));

const ENTRY = 'ingest';
const ID_LIFETIME = 'SESSION_ONLY';
const REALITY_EVENT_VERSION = DOMAIN_EVENT.DOMAIN_EVENT_VERSION;

/* ── 允许的 reality **source class**（冻结闭集）────────────────────────
   P5-B3-E-R1 · 最小 source-class admission：现实事实有两个来源类
     · CANONICAL_RUNTIME   —— 运行时的机械事实（delivery / activity / turn / memory-store）
     · EXPLICIT_USER_REPORT —— 用户**显式执行结构化报告动作**产生的自述事实
   ★ 这不是"放宽"：类目仍然是闭集，且每条 source 的 domain/type/body 都由
     下面的静态表逐条钉死；没有任何 wildcard，没有动态注册。
   ★ LANGUAGE / MODEL_INFERENCE / USER_BEHAVIOR **仍然不在**这个闭集里：
     它们不是"低权重"，而是**结构性**不能铸造现实。 */
const ALLOWED_REALITY_SOURCE_CLASSES = Object.freeze(['CANONICAL_RUNTIME', 'EXPLICIT_USER_REPORT']);

/* ── trusted reality source allowlist（静态；**禁止**动态注册）──────────
   只有 Home Node 侧的 authoritative runtime 才在这里。
   Browser / matcher / calibration / memory / relationship **不在**表内。 */
const REALITY_SOURCES = Object.freeze({
  'runtime-delivery': Object.freeze({
    producerId: 'runtime-delivery',
    source: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.delivery',
    domain: 'delivery',
    domains: Object.freeze(['runtime_state']),
    allowedTypes: Object.freeze(['queued', 'delivering', 'completed', 'cancelled', 'failed'])
  }),
  'runtime-activity': Object.freeze({
    producerId: 'runtime-activity',
    source: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.activity',
    domain: 'activity',
    domains: Object.freeze(['runtime_state']),
    allowedTypes: Object.freeze(['available', 'unavailable'])
  }),
  /* P5-B3-D4 · 第一条 **character/conversation-scoped** mechanical live source。
     owner = execution runtime terminal seam；这里只登记 provenance 与 vocabulary。 */
  'turn-terminal': Object.freeze({
    producerId: 'turn-terminal',
    source: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.turn-execution',
    domain: 'runtime',
    domains: Object.freeze(['runtime_state']),
    allowedTypes: Object.freeze(['turn_terminal'])
  }),  'runtime-memory-store': Object.freeze({
    producerId: 'runtime-memory-store',
    source: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.memory-store',
    domain: 'memory',
    domains: Object.freeze(['runtime_state']),
    allowedTypes: Object.freeze(['record-written', 'record-refused'])
  }),
  /* P5-B3-E-R1 · 第一条 **EXPLICIT_USER_REPORT** 类的 live source。
     owner = dedicated structured report ingress；本表只登记 provenance 与词汇。
     ★ domain/type 不是 `prediction_error.*`（§25）：RealityEvent 描述**事实**
       （"用户报告了他对某物的立场"），不描述 PE。
     ★ body 是**闭合的结构化事实体**：恰好 targetKey + stance（+ reportId 作为
       source reference）。没有正文、没有 prompt、没有 memory、没有 relationship。 */
  'user-explicit-preference-report': Object.freeze({
    producerId: 'user-explicit-preference-report',
    source: 'EXPLICIT_USER_REPORT',
    sourceInstance: 'user.explicit-preference-report',
    domain: 'user_preference',
    domains: Object.freeze(['user_preference']),
    allowedTypes: Object.freeze(['preference_report']),
    requiredBodyKeys: Object.freeze(['targetKey', 'stance']),
    allowedBodyKeys: Object.freeze(['targetKey', 'stance', 'reportId']),
    /* defense in depth：RealityEvent body 本身也必须是 canonical proposition，
       否则"一个看起来合法的 domain/type"就能塞进任意 target/stance。 */
    requiresCanonicalPreferenceProposition: true
  })
  /* ★ 刻意**没有**：browser、matcher、calibration、memory(value)、relationship、
     MODEL_INFERENCE、user-behavior（Node 侧暂无权威 action stream）、
     自由文本 / 语言证据（普通 chat 文本**永远**不是 reality report 源）。 */
});

/* domain-event 的 body 里**禁止**出现的 authority 字段 */
const FORBIDDEN_BODY_KEYS = Object.freeze([
  'relation', 'support', 'conflict', 'irrelevant', 'ambiguous',
  'settlementState', 'matched', 'missed', 'mixed', 'settleable',
  'calibrationCounted', 'calibrationConfidence', 'validated',
  'predictionType', 'targetDomain', 'source', 'sourceInstance',
  'authorityLevel', 'admissibility', 'contaminationClass', 'confidence', 'probability', 'score'
]);

const REASON = Object.freeze({
  ok: 'ok',
  unknownSource: 'reality-source-not-registered',
  sourceNotAuthoritative: 'reality-source-not-authoritative',
  domainMismatch: 'reality-event-domain-not-permitted-for-source',
  typeNotPermitted: 'reality-event-type-not-permitted-for-source',
  forbiddenBodyField: 'reality-event-body-carries-authority-field',
  bodyNotPermittedForSource: 'reality-event-body-not-permitted-for-source',
  bodyNotCanonicalProposition: 'reality-event-body-not-a-canonical-proposition',
  schemaRefused: 'domain-event-schema-refused',
  duplicateSuppressed: 'duplicate-source-event-suppressed',
  noPredictionPair: 'reality-event-without-prediction-pair',
  factAuthorityOnly: 'reality-event-fact-authority-only'
});

const BOUNDS = Object.freeze({ MAX_HELD_EVENTS: 256, MAX_BODY_KEYS: 12 });

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return v == null ? '' : String(v); }
function num(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : null; }

/* ── capability seal（module-private · module 级）───────────────────────
   schema-valid != authoritative reality。只有本模块铸造的事件才算。 */
const RE_IDENTITY = new WeakSet();
const RE_SEAL = new WeakMap();
const RE_BRAND = 'ib.reality-event.v1';
function reFingerprint(v) { try { return JSON.stringify(v); } catch (e) { return null; } }
function sealRealityEvent(ev) {
  RE_IDENTITY.add(ev);
  RE_SEAL.set(ev, Object.freeze({ brand: RE_BRAND, fingerprint: reFingerprint(ev) }));
  return ev;
}
function isRealityEvent(x) {
  if (!x || typeof x !== 'object') return false;
  if (!RE_IDENTITY.has(x)) return false;
  if (!Object.isFrozen(x)) return false;
  const s = RE_SEAL.get(x);
  if (!s || s.brand !== RE_BRAND) return false;
  const shapeOk = typeof x.realityEventId === 'string' && x.realityEventId.length > 0
    && typeof x.domain === 'string' && typeof x.type === 'string'
    && typeof x.entityId === 'string' && typeof x.occurredAt === 'number'
    && typeof x.realitySourceId === 'string';
  if (!shapeOk) return false;
  /* RealityEvent identity **绝不**包含 predictionId */
  if (Object.prototype.hasOwnProperty.call(x, 'predictionId')) return false;
  return reFingerprint(x) === s.fingerprint;
}

function createRuntimeRealityEvent(deps) {
  const d = deps || {};
  const logger = typeof d.logger === 'function' ? d.logger : null;
  /* P5-B3-D4-R3 · post-mint subscriber seam。**只**在 NEW canonical mint 之后触发；
     duplicate / refused **不**触发。subscriber 只见 sealed RealityEvent，绝不接触
     raw source input。下游异常**不得**影响 mint 结果。 */
  const onRealityEventMinted = typeof d.onRealityEventMinted === 'function' ? d.onRealityEventMinted : null;
  const maxHeld = Number.isFinite(Number(d.maxHeldEvents)) && Number(d.maxHeldEvents) > 0
    ? Number(d.maxHeldEvents) : BOUNDS.MAX_HELD_EVENTS;

  /* bounded session 幂等：key = domain-event 的 dedupeKey（**不含** predictionId） */
  const held = new Map();
  const heldOrder = [];
  const counters = {
    attempts: 0, minted: 0, duplicatesSuppressed: 0,
    rejectedSource: 0, rejectedDomain: 0, rejectedType: 0,
    rejectedBody: 0, schemaRefused: 0, evicted: 0,
    pairedProjections: 0, modelCalls: 0, durableWrites: 0
  };

  function evict() {
    while (held.size > maxHeld && heldOrder.length) {
      const k = heldOrder.shift();
      if (held.has(k)) { held.delete(k); counters.evicted += 1; }
    }
  }
  function refuse(reasonCode, extra) {
    return Object.assign({ ok: false, status: 'refused', reasonCode: reasonCode, realityEvent: null }, extra || {});
  }

  /**
   * ingest({ sourceId, sourceEvent })
   *   sourceEvent = { eventId?, domain, type, entityId, timestamp,
   *                   characterId, conversationId, body?, causationId?, correlationId? }
   * ★ `timestamp` 是**事实发生时间**（domain-event-core 明确不读 Date.now）。
   * ★ 事件里**不得**出现 predictionId / relation / 结算状态。
   */
  function ingest(input) {
    const i = isPlainObject(input) ? input : {};
    counters.attempts += 1;
    const src = REALITY_SOURCES[text(i.sourceId)];
    if (!src) { counters.rejectedSource += 1; return refuse(REASON.unknownSource); }
    /* ① source **class** 必须落在冻结闭集里（CANONICAL_RUNTIME | EXPLICIT_USER_REPORT）。
       其它一切 —— 语言证据、模型推断、用户行为 —— 结构性不得铸造现实。 */
    if (ALLOWED_REALITY_SOURCE_CLASSES.indexOf(src.source) < 0) {
      counters.rejectedSource += 1;
      return refuse(REASON.sourceNotAuthoritative, { source: src.source });
    }
    const ev = isPlainObject(i.sourceEvent) ? i.sourceEvent : null;
    if (!ev) { counters.schemaRefused += 1; return refuse(REASON.schemaRefused); }

    /* ② 该 source 只允许自己那个 domain 的事件 */
    if (text(ev.domain) !== src.domain) {
      counters.rejectedDomain += 1;
      return refuse(REASON.domainMismatch, { domain: text(ev.domain), expected: src.domain });
    }
    /* ③ type 必须在 source 的闭集里 */
    if (src.allowedTypes.indexOf(text(ev.type)) < 0) {
      counters.rejectedType += 1;
      return refuse(REASON.typeNotPermitted, { type: text(ev.type), allowed: src.allowedTypes.slice() });
    }
    /* ④ body 不得携带 authority 字段（出现即拒绝，绝不静默生效） */
    const body = isPlainObject(ev.body) ? ev.body : {};
    const bodyKeys = Object.keys(body);
    if (bodyKeys.length > BOUNDS.MAX_BODY_KEYS) { counters.rejectedBody += 1; return refuse(REASON.forbiddenBodyField, { reason: 'too-many-body-keys' }); }
    for (const k of bodyKeys) {
      if (FORBIDDEN_BODY_KEYS.indexOf(k) >= 0) {
        counters.rejectedBody += 1;
        return refuse(REASON.forbiddenBodyField, { field: k });
      }
    }
    /* ④b 声明了结构化 body 契约的 source：键集与命题都必须命中（fail closed） */
    if (Array.isArray(src.requiredBodyKeys)) {
      for (const need of src.requiredBodyKeys) {
        if (!Object.prototype.hasOwnProperty.call(body, need) || text(body[need]) === '') {
          counters.rejectedBody += 1;
          return refuse(REASON.bodyNotPermittedForSource, { missing: need, required: src.requiredBodyKeys.slice() });
        }
      }
    }
    if (Array.isArray(src.allowedBodyKeys)) {
      const extra = bodyKeys.filter(k => src.allowedBodyKeys.indexOf(k) < 0);
      if (extra.length) {
        counters.rejectedBody += 1;
        return refuse(REASON.bodyNotPermittedForSource, { rejectedBodyKeys: extra, allowed: src.allowedBodyKeys.slice() });
      }
    }
    if (src.requiresCanonicalPreferenceProposition === true
      && PREF.buildPreferenceToken(text(body.stance), text(body.targetKey)) == null) {
      counters.rejectedBody += 1;
      return refuse(REASON.bodyNotCanonicalProposition, {
        stanceAccepted: PREF.STANCES.slice(),
        targetKeyGrammar: 'lowercase [a-z0-9][a-z0-9._:-]{0,47}'
      });
    }
    /* ⑤ `predictionId` 绝不允许出现在**现实事件**里 */
    if (Object.prototype.hasOwnProperty.call(ev, 'predictionId')) {
      counters.rejectedBody += 1;
      return refuse(REASON.forbiddenBodyField, { field: 'predictionId' });
    }

    /* ⑤ 交给既有 canonical schema（**不另造** event schema） */
    const created = DOMAIN_EVENT.createDomainEvent({
      eventId: ev.eventId,
      domain: ev.domain,
      type: ev.type,
      entityId: ev.entityId,
      timestamp: ev.timestamp,
      actorId: ev.actorId,
      origin: src.sourceInstance,
      causationId: ev.causationId,
      correlationId: ev.correlationId
    });
    if (!created || created.ok !== true || !created.event) {
      counters.schemaRefused += 1;
      return refuse(REASON.schemaRefused, { schemaErrors: (created && created.errors) || null });
    }
    const canonical = created.event;
    const dedupeKey = DOMAIN_EVENT.dedupeKeyFor(canonical);
    if (held.has(dedupeKey)) {
      counters.duplicatesSuppressed += 1;
      return {
        ok: true, status: 'duplicate', reasonCode: REASON.duplicateSuppressed,
        realityEvent: held.get(dedupeKey), dedupeKey: dedupeKey, reused: true
      };
    }

    /* ⑥ 铸造 sealed RealityEvent（**事实层**：不含评价上下文） */
    const realityEvent = Object.freeze({
      schemaVersion: REALITY_EVENT_VERSION,
      realityEventId: canonical.eventId,
      dedupeKey: dedupeKey,
      orderingKey: DOMAIN_EVENT.orderingKeyFor(canonical, 'entity'),
      realitySourceId: src.producerId,
      source: src.source,
      sourceInstance: src.sourceInstance,
      domain: canonical.domain,
      type: canonical.type,
      entityId: canonical.entityId,
      characterId: text(ev.characterId),
      conversationId: text(ev.conversationId),
      occurredAt: canonical.timestamp,
      body: Object.freeze(Object.assign({}, body)),
      causationId: text(ev.causationId),
      correlationId: text(ev.correlationId),
      /* 审计指向：schema-valid != authoritative，这个标记只说明 seal 来源 */
      sealedBy: 'REALITY_EVENT_AUTHORITY',
      idLifetime: ID_LIFETIME
    });
    sealRealityEvent(realityEvent);
    held.set(dedupeKey, realityEvent);
    heldOrder.push(dedupeKey);
    counters.minted += 1;
    evict();
    /* canonical mint 先成立，再通知下游；下游失败不回滚、不改写。 */
    if (onRealityEventMinted) {
      try { onRealityEventMinted(realityEvent); }
      catch (error) {
        try { if (logger) logger('reality-event-subscriber-failed', { realityEventId: text(realityEvent.realityEventId), error: String((error && error.message) || error).slice(0, 200) }); } catch (_) { /* diagnostics 不得影响 mint */ }
      }
    }
    return {
      ok: true, status: 'minted', reasonCode: REASON.ok,
      realityEvent: realityEvent, dedupeKey: dedupeKey, reused: false
    };
  }

  function describe() {
    return {
      status: 'LIVE_CAPABLE',
      entry: ENTRY,
      schemaAuthority: 'assets/js/domain-event-core.js',
      realityEventVersion: REALITY_EVENT_VERSION,
      identityIndependentOfPrediction: 'YES',
      factAuthorityOnly: 'YES',
      realityEventEqualsOutcomeObservation: 'NO',
      browserDomainEventIsAuthoritative: 'NO',
      /* P5-B3-E-R1 · 冻结闭集（不是"只要是 runtime 就行"） */
      allowedSourceClasses: ALLOWED_REALITY_SOURCE_CLASSES.slice(),
      languageEvidenceMayMintReality: 'NO',
      modelInferenceMayMintReality: 'NO',
      userBehaviorMayMintReality: 'NO',
      freeTextMayMintReality: 'NO',
      dynamicSourceRegistration: 'FORBIDDEN',
      lifetime: ID_LIFETIME,
      holder: { maxEntries: maxHeld, current: held.size, durability: 'NONE' },
      sources: Object.keys(REALITY_SOURCES).map(function (k) {
        return {
          sourceId: k, source: REALITY_SOURCES[k].source,
          sourceInstance: REALITY_SOURCES[k].sourceInstance,
          domain: REALITY_SOURCES[k].domain,
          allowedTypes: REALITY_SOURCES[k].allowedTypes.slice()
        };
      }),      modelCalls: 0,
      durableWrites: 0,
      counters: Object.assign({}, counters)
    };
  }

  return {
    ENTRY: ENTRY,
    ingest: ingest,
    describe: describe,
    isRealityEvent: isRealityEvent,
    heldEventCount: function () { return held.size; },
    dispose: function () { held.clear(); heldOrder.length = 0; },
    __counters: counters,
    awaitIdle: function () { return Promise.resolve({ idle: true, inFlight: 0 }); }
  };
}

module.exports = {
  createRuntimeRealityEvent: createRuntimeRealityEvent,
  REALITY_SOURCES: REALITY_SOURCES,
  ALLOWED_REALITY_SOURCE_CLASSES: ALLOWED_REALITY_SOURCE_CLASSES,
  FORBIDDEN_BODY_KEYS: FORBIDDEN_BODY_KEYS,
  isRealityEvent: isRealityEvent,
  RE_BRAND: RE_BRAND,
  REALITY_EVENT_VERSION: REALITY_EVENT_VERSION,
  REASON: REASON,
  BOUNDS: BOUNDS,
  ID_LIFETIME: ID_LIFETIME,
  ENTRY: ENTRY
};
