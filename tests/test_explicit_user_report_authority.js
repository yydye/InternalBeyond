'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-E-R1 · Explicit User Report Authority
   （纯 Node · 零浏览器 · 零网络 · 零真实模型调用 · 零 durable 写）

   运行：node tests/test_explicit_user_report_authority.js

   ── 本文件的历史（重要）──────────────────────────────────────────────────
   它在 P5-B3-E 里是一份 **audit-freeze** 文件，冻结的结论是
   `EXPLICITNESS_AUTHORITY = NONE_AVAILABLE` / `PARTIAL`。P5-B3-E-R1 建立了
   真实的 authority 载体之后，本文件被**翻面**：仍然存在的 invariant 逐字保留，
   被本相位推翻的结论改成新的、更严格的规则（每条都带 ★ P5-B3-E-R1 翻面 注释）。

   ── 本相位冻结 ───────────────────────────────────────────────────────────
     EXPLICITNESS_AUTHORITY = DEDICATED_STRUCTURED_USER_REPORT_ACTION
     RAW_CHAT_TEXT_IS_EXPLICIT_REPORT = NO
     FREE_TEXT_EXPLICIT_REPORT_PARSER = NONE
     MODEL_MAY_DECLARE_EXPLICITNESS = NO · MATCHER_MAY_DECLARE_EXPLICITNESS = NO
     EXPLICIT_REPORT_FAMILY = USER_PREFERENCE · STANCE_ENUM = LIKE | DISLIKE
     REPORT_IDENTITY DOES NOT CONTAIN predictionId · != requestId
     REPORT_OCCURRED_AT = SERVER_ACCEPTED_REPORT_TIME
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WIRING = require('./helpers/activation-wiring-probe.js');
const G = require('./helpers/runtime-seam-guard.js');

const CHAT_CORE = require(path.join(ROOT, 'assets/js/chat-core.js'));
const PREF = require(path.join(ROOT, 'assets/js/memory-recall/preference-proposition-core.js'));
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const SETTLE_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-settlement-core.js'));
const OBS_PROD = require(path.join(ROOT, 'services/home-node/runtime-outcome-observation.js'));
const RE_MOD = require(path.join(ROOT, 'services/home-node/runtime-reality-event.js'));
const REPORT_MOD = require(path.join(ROOT, 'services/home-node/runtime-explicit-preference-report.js'));
const SRC_MOD = require(path.join(ROOT, 'services/home-node/explicit-preference-report-reality-source.js'));
const SEAM_MOD = require(path.join(ROOT, 'services/home-node/explicit-preference-report-seam.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = rel => WIRING.stripJsComments(read(rel));

const T0 = 1760000000000;
const CRED = 'desktop-token-xyz';
const PRODUCER_ID = 'explicit-user-report';
const SOURCE_INSTANCE = 'user.explicit-preference-report';

function actionIdOf(n) { return REPORT_MOD.actionIdOf('request-' + n); }
function submit(over) {
  return Object.assign({
    actionId: actionIdOf('a'), characterId: 'char_A', conversationId: 'dm:char_A',
    targetKey: 'SciFi', stance: 'like'
  }, over || {});
}
function freshProducer(over) {
  return REPORT_MOD.createRuntimeExplicitPreferenceReport(Object.assign({ clock: () => T0 }, over || {}));
}
/* 单元级 seam（不经过 buildHomeNode）：用来单独验证准入与拒绝面。 */
function unitSeam(over) {
  const o = over || {};
  const producer = o.producer || freshProducer();
  const re = RE_MOD.createRuntimeRealityEvent({});
  const src = SRC_MOD.createExplicitPreferenceReportRealitySource({ realityEvent: re });
  const seam = SEAM_MOD.createExplicitPreferenceReportSeam({
    reportProducer: producer,
    realitySink: report => src.emit(report),
    characterRegistry: o.characterRegistry === undefined
      ? { getCharacterSpec: id => (String(id) === 'char_A' ? { id: 'char_A' } : null) }
      : o.characterRegistry,
    desktopCredential: o.desktopCredential === undefined ? CRED : o.desktopCredential,
    clock: () => T0,
    logger: () => {}
  });
  return { seam, producer, re, src };
}
const OK_INFO = Object.freeze({ loopback: true, remoteAddress: '127.0.0.1', desktopCredential: CRED });
const BODY = Object.freeze({ requestId: 'req-1', characterId: 'char_A', targetKey: 'SciFi', stance: 'like' });

/* ══════════════════════════════════════════════════════════════════════════
   A · Explicitness authority ruling
   ══════════════════════════════════════════════════════════════════════════ */
section('A · explicitness authority');
{
  const producers = OBS_PROD.PRODUCER_TABLE;
  const ids = Object.keys(producers);
  const explicitIds = ids.filter(k => producers[k].allowedSource === 'EXPLICIT_USER_REPORT');
  check('A1.exactlyOneExplicitReportProducer',
    explicitIds.length === 1 && explicitIds[0] === PRODUCER_ID
    && producers[PRODUCER_ID].sourceInstance === SOURCE_INSTANCE
    && producers[PRODUCER_ID].allowedDomains.length === 1
    && producers[PRODUCER_ID].allowedDomains[0] === 'user_preference'
    && OBS_PROD.createRuntimeOutcomeObservation({}).describe().explicitUserReportProducer === 'LIVE_CAPABLE',
    explicitIds);
  check('A2.producerTableIsStaticNoDynamicRegistration',
    code('services/home-node/runtime-outcome-observation.js').indexOf('function register') < 0
    && code('services/home-node/runtime-outcome-observation.js').indexOf('.register(') < 0
    && OBS_PROD.createRuntimeOutcomeObservation({}).describe().dynamicProducerRegistration === 'FORBIDDEN',
    'PRODUCER_SOURCE_ALLOWLIST = STATIC');
  check('A3.noProducerBindsAUserIdentity',
    ids.every(k => producers[k].requiredIdentity.every(f => ['userId', 'authorId', 'speakerId', 'principalId'].indexOf(f) < 0)),
    ids.map(k => producers[k].requiredIdentity));
  /* canonical chat message schema：仍然**没有**任何 self-report 字段。 */
  const SCHEMA_FORBIDDEN = /explicit|report|preference|polarity|emotion|intent|like|dislike|selfstatement/i;
  check('A4.chatMessageSchemaHasNoSelfReportField',
    CHAT_CORE.KNOWN_FIELDS.every(f => !SCHEMA_FORBIDDEN.test(f)),
    CHAT_CORE.KNOWN_FIELDS);
  check('A5.chatMessageRoleIsAnEnumNotAnAuthenticatedAuthor',
    CHAT_CORE.ROLES.indexOf('user') >= 0 && CHAT_CORE.ROLES.length === 3
    && code('services/home-node/execution.js').indexOf('userMessage.role') < 0,
    'role 由客户端断言；execution 从不校验它 —— 所以 raw chat 不能当 report');
  check('A6.reportPathIsSeamOwnedNotALiteralInHttp',
    SEAM_MOD.REPORT_PATH.indexOf('/internal/') === 0
    && code('services/home-node/http.js').indexOf(SEAM_MOD.REPORT_PATH) < 0
    && code('services/home-node/http.js').indexOf('preferenceReportSeam.path') >= 0
    && code('services/home-node-service.js').indexOf(SEAM_MOD.REPORT_PATH) < 0,
    '路径字面量只有一份（seam 模块里）');
  check('A7.rawChatIngressIsNotExplicitReportIngress',
    SEAM_MOD.REPORT_PATH !== '/messages' && SEAM_MOD.REPORT_PATH !== '/turn'
    && read('services/home-node/explicit-preference-report-seam.js').indexOf('freeTextParser') >= 0
    && SEAM_MOD.createExplicitPreferenceReportSeam({}).describe().freeTextParser === 'NONE',
    'RAW_CHAT_INGRESS != EXPLICIT_REPORT_INGRESS');
}

/* ══════════════════════════════════════════════════════════════════════════
   B · Ingress：user authorship 来自传输 + 信封纪律
   ══════════════════════════════════════════════════════════════════════════ */
section('B · ingress & user authorship');
{
  const closed = unitSeam({ desktopCredential: '' });
  check('B1.credentialRequiredAndFailClosed',
    closed.seam.describe().open === false
    && closed.seam.dispatch(OK_INFO, BODY).reasonCode === SEAM_MOD.REFUSAL.CREDENTIAL_NOT_CONFIGURED
    && closed.seam.dispatch(OK_INFO, BODY).status === 503,
    closed.seam.dispatch(OK_INFO, BODY));
  const { seam } = unitSeam();
  check('B2.userAuthorshipAuthorityIsTransport',
    seam.dispatch({ loopback: false, desktopCredential: CRED }, BODY).reasonCode === SEAM_MOD.REFUSAL.NOT_LOOPBACK
    && seam.dispatch({ loopback: false, desktopCredential: CRED }, BODY).status === 401,
    'NOT_LOOPBACK');
  check('B3.missingOrWrongCredentialRefused',
    seam.dispatch({ loopback: true, desktopCredential: '' }, BODY).reasonCode === SEAM_MOD.REFUSAL.MISSING_USER_CREDENTIAL
    && seam.dispatch({ loopback: true, desktopCredential: 'nope' }, BODY).reasonCode === SEAM_MOD.REFUSAL.WRONG_USER_CREDENTIAL
    && seam.dispatch({ loopback: true, desktopCredential: 'nope' }, BODY).status === 403,
    'MISSING / WRONG credential');
  check('B4.callerDeclaredAuthorityKeysRefusedByName', (function () {
    const keys = ['userId', 'conversationId', 'timestamp', 'occurredAt', 'source', 'sourceInstance',
      'reportId', 'predictionId', 'validated', 'text', 'content'];
    return keys.every(k => {
      const r = seam.dispatch(OK_INFO, Object.assign({}, BODY, { [k]: 'x' }));
      return r.ok === false && r.reasonCode === SEAM_MOD.REFUSAL.FORBIDDEN_KEY
        && r.reachedProducer === false && r.rejectedKeys.indexOf(k) >= 0;
    });
  })(), '逐名拒绝，且不触碰 producer');
  check('B5.envelopeWhitelist',
    seam.dispatch(OK_INFO, Object.assign({}, BODY, { confidence: 0.9 })).reasonCode === SEAM_MOD.REFUSAL.FORBIDDEN_KEY
    && seam.dispatch(OK_INFO, Object.assign({}, BODY, { extra: 1 })).reasonCode === SEAM_MOD.REFUSAL.UNEXPECTED_ENVELOPE_KEYS
    && seam.dispatch(OK_INFO, Object.assign({}, BODY, { extra: 1 })).status === 400,
    '信封恰好五个键');
  check('B6.scopeComesFromTheCharacterRegistry',
    seam.dispatch(OK_INFO, Object.assign({}, BODY, { characterId: 'char_unknown' })).reasonCode === SEAM_MOD.REFUSAL.CHARACTER_NOT_BOUND
    && seam.dispatch(OK_INFO, Object.assign({}, BODY, { characterId: '' })).reasonCode === SEAM_MOD.REFUSAL.MISSING_CHARACTER_SELECTOR,
    'D3 accessor，不是新 resolver');
  const noRegistry = unitSeam({ characterRegistry: null });
  check('B7.closedWhenCharacterAuthorityUnavailable',
    noRegistry.seam.describe().open === false
    && noRegistry.seam.dispatch(OK_INFO, BODY).status === 503,
    noRegistry.seam.describe());
  check('B8.occurredAtComesFromTheServerClock',
    (function () {
      const s = unitSeam({ desktopCredential: CRED });
      const r = s.seam.dispatch(OK_INFO, BODY);
      return r.ok === true && r.report.occurredAt === T0;
    })(),
    'REPORT_OCCURRED_AT = SERVER_ACCEPTED_REPORT_TIME');
  check('B9.requestIdentityIsNotReportIdentity',
    (function () {
      const r = seam.dispatch(OK_INFO, Object.assign({}, BODY, { requestId: 'req-1' }));
      return r.ok === true && r.reportId !== 'req-1'
        && r.reportId.indexOf('pref_report_') === 0
        && r.report.sourceActionId !== 'req-1'
        && r.report.sourceActionId.indexOf('pref_action_') === 0;
    })(),
    'REQUEST_IDENTITY != REPORT_FACT_IDENTITY');
}

/* ══════════════════════════════════════════════════════════════════════════
   C · Canonical report contract
   ══════════════════════════════════════════════════════════════════════════ */
section('C · canonical report contract');
{
  const producer = freshProducer();
  const minted = producer.submit(submit());
  const report = minted.report;
  const EXPECTED_KEYS = ['schemaVersion', 'reportId', 'source', 'characterId', 'conversationId',
    'targetKey', 'stance', 'preferenceToken', 'sourceActionId', 'occurredAt', 'sealedBy', 'idLifetime'];
  check('C1.reportShapeIsClosed',
    Object.keys(report).sort().join(',') === EXPECTED_KEYS.slice().sort().join(',')
    && Object.isFrozen(report)
    && report.source === 'EXPLICIT_USER_REPORT'
    && report.targetKey === 'scifi'
    && report.stance === 'like'
    && report.preferenceToken === 'pref.like.scifi',
    Object.keys(report));
  check('C2.noPredictionFieldsOnTheReport',
    Object.prototype.hasOwnProperty.call(report, 'predictionId') === false
    && Object.prototype.hasOwnProperty.call(report, 'targetDomain') === false
    && Object.prototype.hasOwnProperty.call(report, 'relation') === false
    && report.sealedBy === 'EXPLICIT_USER_PREFERENCE_REPORT_AUTHORITY'
    && report.idLifetime === 'SESSION_ONLY',
    Object.keys(report));
  check('C3.stanceIsAClosedTwoValueSet',
    JSON.stringify(PREF.STANCES) === '["like","dislike"]'
    && ['love', 'hate', 'neutral', 'unsure', 'slightly_like', 'LIKE_A_LOT'].every(s =>
      producer.submit(submit({ actionId: actionIdOf('s_' + s), stance: s })).reasonCode === REPORT_MOD.REASON.stanceNotInClosedSet),
    PREF.STANCES);
  check('C4.targetKeyIsCanonicalizedAndBounded',
    freshProducer().submit(submit({ targetKey: 'SciFi' })).report.targetKey === 'scifi'
    && ['', '   ', 'a b', 'a/b', 'x'.repeat(49), 'ünïcode', 'a\u0000b'].every(t =>
      freshProducer().submit(submit({ targetKey: t })).reasonCode === REPORT_MOD.REASON.targetKeyNotCanonical),
    'lowercase [a-z0-9][a-z0-9._:-]{0,47}');
  check('C5.replayYieldsOneLogicalReport',
    (function () {
      const p = freshProducer();
      const first = p.submit(submit());
      let dups = 0;
      for (let i = 0; i < 99; i += 1) if (p.submit(submit()).status === 'duplicate') dups += 1;
      return first.status === 'minted' && dups === 99 && p.heldReportCount() === 1
        && p.submit(submit()).report === first.report;
    })(),
    '同一 action 100 次 ⇒ 1 条逻辑 report');
  check('C6.newActionOnTheSamePropositionIsANewFact',
    (function () {
      const p = freshProducer();
      const a = p.submit(submit({ actionId: actionIdOf('t1') }));
      const b = p.submit(submit({ actionId: actionIdOf('t3') }));
      return a.reportId !== b.reportId && p.heldReportCount() === 2;
    })(),
    'REPORT_CORRECTION = NEW FACT');
  check('C7.oppositeStanceIsADifferentReport',
    (function () {
      const p = freshProducer();
      const like = p.submit(submit({ actionId: actionIdOf('l'), stance: 'like' }));
      const dislike = p.submit(submit({ actionId: actionIdOf('d'), stance: 'dislike' }));
      return like.reportId !== dislike.reportId
        && like.report.preferenceToken !== dislike.report.preferenceToken
        && like.report.targetKey === dislike.report.targetKey;
    })(),
    'T1 LIKE / T2 DISLIKE 是两条事实');
  check('C8.reportIdentityIsDeterministicAndPredictionIndependent',
    (function () {
      /* 同一 action + 同一 proposition ⇒ 同一 identity —— **即使服务器接受时间不同**
         （证明时钟不在 identity 里）；不同 proposition ⇒ 不同 identity。 */
      const a = freshProducer({ clock: () => T0 }).submit(submit());
      const b = freshProducer({ clock: () => T0 + 999999 }).submit(submit());
      const c = freshProducer({ clock: () => T0 }).submit(submit({ stance: 'dislike' }));
      const d = freshProducer({ clock: () => T0 }).submit(submit({ targetKey: 'coffee' }));
      return a.reportId === b.reportId
        && a.report.occurredAt !== b.report.occurredAt
        && a.reportId !== c.reportId && a.reportId !== d.reportId
        && a.reportId.indexOf('pref_report_') === 0
        && code('services/home-node/runtime-explicit-preference-report.js').indexOf('Math.random') < 0;
    })(),
    '确定性（时钟不参与）+ 不读随机 + 不含 predictionId');
}

/* ══════════════════════════════════════════════════════════════════════════
   D · Provenance / seal
   ══════════════════════════════════════════════════════════════════════════ */
section('D · provenance & seal');
{
  const producer = freshProducer();
  const good = producer.submit(submit()).report;
  const clone = JSON.parse(JSON.stringify(good));
  const copied = Object.assign({}, good);
  const branded = Object.freeze(Object.assign({}, good));   /* 冻结 + 复制字段 */
  check('D1.onlyModuleMintedReportsAreCanonical',
    producer.isExplicitPreferenceReport(good) === true
    && producer.isExplicitPreferenceReport(clone) === false
    && producer.isExplicitPreferenceReport(copied) === false
    && producer.isExplicitPreferenceReport(branded) === false
    && REPORT_MOD.isExplicitPreferenceReport({ reportId: 'pref_report_x', source: 'EXPLICIT_USER_REPORT' }) === false,
    'PLAIN / CLONE / COPY / BRANDED FORGE ALL REJECTED');
  const tampered = (function () {
    /* 篡改检测：先拿到 seal 再改字段（Object.freeze 下不可改 ⇒ 用另一实例的 seal 语义验证） */
    const p2 = freshProducer();
    const r = p2.submit(submit());
    return p2.isExplicitPreferenceReport(r.report) === true && Object.isFrozen(r.report) === true;
  })();
  check('D2.reportIsDeepFrozen', tampered, 'DEEP_FROZEN');
  const { src } = unitSeam();
  check('D3.realitySourceRejectsUnsealedReports',
    src.emit({ reportId: 'pref_report_forged' }).reasonCode === 'not-canonical-explicit-preference-report'
    && src.emit(null).reasonCode === 'not-canonical-explicit-preference-report',
    'capability，不是 shape');
}

/* ══════════════════════════════════════════════════════════════════════════
   E · Source laundering
   ══════════════════════════════════════════════════════════════════════════ */
section('E · source laundering blocked');
{
  const obs = OBS_PROD.createRuntimeOutcomeObservation({});
  const ev = { sourceEventId: 'msg_u_1', characterId: 'char_A', conversationId: 'dm:char_A', occurredAt: T0, kind: 'statement', statement: 'I like scifi' };
  const ref = { predictionId: 'pred_x', opensAt: T0 - 1000, closesAt: T0 + 1000, predictionCreatedAt: T0 - 2000 };
  const plausible = ['explicit-report', 'user-report', 'self-report', 'chat-user-utterance', 'model-inference', 'linguistic-report'];
  check('E1.noOtherProducerIdCanMintAnExplicitReport',
    plausible.every(id => obs.mintObservation({ producerId: id, targetDomain: 'user_preference', predictionRef: ref, sourceEvent: ev }).reasonCode === 'producer-not-registered'),
    plausible);
  check('E2.callerDeclaredProvenanceCannotUpgradeTheNewProducer',
    (function () {
      const r = obs.mintObservation({
        producerId: PRODUCER_ID, targetDomain: 'user_preference', predictionRef: ref,
        source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.delivery',
        sourceEvent: Object.assign({}, ev, { source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.delivery', kind: 'token', token: 'pref.like.scifi', payload: { targetKey: 'scifi', stance: 'like' } })
      });
      return r.ok === true && r.observation.source === 'EXPLICIT_USER_REPORT'
        && r.observation.sourceInstance === SOURCE_INSTANCE
        && r.observation.targetDomain === 'user_preference';
    })(),
    'provenance 由 producer 表决定');
  check('E3.linguisticEvidenceCannotCarryAPreferenceProposition',
    OO.domainPayloadConsistency('LINGUISTIC_EVIDENCE', 'user_preference', { kind: 'token', token: 'pref.like.scifi' }).state === 'INCONSISTENT'
    && OO.domainPayloadConsistency('USER_BEHAVIOR', 'user_preference', { kind: 'token', token: 'pref.like.scifi' }).state === 'INCONSISTENT'
    && OO.domainPayloadConsistency('CANONICAL_RUNTIME', 'user_preference', { kind: 'token', token: 'pref.like.scifi' }).state === 'INCONSISTENT',
    '只有 EXPLICIT_USER_REPORT × user_preference × canonical token 可以通过');
  check('E4.explicitReportProducerIsClosedToOtherDomains',
    OO.domainPayloadConsistency('EXPLICIT_USER_REPORT', 'latent_state', { kind: 'token', token: 'pref.like.scifi' }).state === 'INCONSISTENT'
    && OO.domainPayloadConsistency('EXPLICIT_USER_REPORT', 'user_preference', { kind: 'statement', statement: 'x' }).state === 'CONSISTENT',
    '第一版只开放 user_preference；statement 路径不变');
  check('E5.modelInferenceCannotEvenBuildAnObservation',
    (function () {
      const r = OO.buildOutcomeObservation({
        windowRef: ref, source: 'MODEL_INFERENCE', sourceInstance: 'runtime.interpretation-evidence',
        targetDomain: 'user_preference', observedAt: T0, completeness: 'point',
        scope: { characterId: 'char_A', conversationId: 'dm:char_A', subjectKind: 'user', subjectLabel: '' },
        outcomeRef: { kind: 'token', token: 'pref.like.scifi' }, evidenceRefs: ['r1'],
        interventionContext: { behaviorEffectsInForce: [], predictionInfluencedSystem: null, contaminationClass: 'NONE', contaminationBasis: 'x' }
      });
      return r.ok === false;
    })(),
    'MODEL_INFERENCE 结构性不可 mint');
}

/* ══════════════════════════════════════════════════════════════════════════
   F · RealityEvent source class
   ══════════════════════════════════════════════════════════════════════════ */
section('F · reality source class');
{
  const CLASSES = RE_MOD.ALLOWED_REALITY_SOURCE_CLASSES;
  const sources = RE_MOD.REALITY_SOURCES;
  const keys = Object.keys(sources);
  const byClass = keys.filter(k => sources[k].source === 'EXPLICIT_USER_REPORT');
  check('F1.sourceClassSetIsFrozenAndClosed',
    JSON.stringify(CLASSES) === '["CANONICAL_RUNTIME","EXPLICIT_USER_REPORT"]'
    && CLASSES.indexOf('LINGUISTIC_EVIDENCE') < 0
    && CLASSES.indexOf('MODEL_INFERENCE') < 0
    && CLASSES.indexOf('USER_BEHAVIOR') < 0
    && keys.every(k => CLASSES.indexOf(sources[k].source) >= 0),
    CLASSES);
  check('F2.exactlyOneExplicitReportRealitySource',
    byClass.length === 1 && byClass[0] === 'user-explicit-preference-report'
    && sources['user-explicit-preference-report'].sourceInstance === SOURCE_INSTANCE
    && sources['user-explicit-preference-report'].domain === 'user_preference'
    && JSON.stringify(sources['user-explicit-preference-report'].allowedTypes) === '["preference_report"]',
    byClass);
  const re = RE_MOD.createRuntimeRealityEvent({});
  const src = SRC_MOD.createExplicitPreferenceReportRealitySource({ realityEvent: re });
  const producer = freshProducer();
  const report = producer.submit(submit()).report;
  const emitted = src.emit(report);
  check('F3.realityEventMapping', (function () {
    const ev = emitted.realityEvent;
    return emitted.ok === true && emitted.status === 'minted'
      && ev.source === 'EXPLICIT_USER_REPORT' && ev.sourceInstance === SOURCE_INSTANCE
      && ev.domain === 'user_preference' && ev.type === 'preference_report'
      && ev.entityId === report.reportId
      && ev.characterId === 'char_A' && ev.conversationId === 'dm:char_A'
      && JSON.stringify(ev.body) === JSON.stringify({ targetKey: 'scifi', stance: 'like', reportId: report.reportId });
  })(), emitted.realityEvent && { source: emitted.realityEvent.source, body: emitted.realityEvent.body });
  check('F4.realityEventTimestampIsTheReportTimestampNotAClock',
    emitted.realityEvent.occurredAt === report.occurredAt
    && code('services/home-node/explicit-preference-report-reality-source.js').indexOf('Date.now') < 0,
    'REALITY_EVENT_OCCURRED_AT = REPORT_OCCURRED_AT');
  check('F5.realityEventIdentityIsNotReportIdentityButIsDerivedFromIt',
    emitted.realityEvent.realityEventId !== report.reportId
    && emitted.realityEvent.realityEventId.indexOf('explicit_preference_report:') === 0
    && re.isRealityEvent(emitted.realityEvent) === true
    && Object.prototype.hasOwnProperty.call(emitted.realityEvent, 'predictionId') === false,
    emitted.realityEvent.realityEventId);
  check('F6.bodyContractIsClosedAndCanonical', (function () {
    const s = (id, body) => re.ingest({ sourceId: 'user-explicit-preference-report', sourceEvent: { eventId: id, domain: 'user_preference', type: 'preference_report', entityId: 'x', timestamp: T0, body: body } });
    const bad1 = s('e1', { targetKey: 'scifi' });                                    /* 缺 stance */
    const bad2 = s('e2', { targetKey: 'scifi', stance: 'like', extra: 1 });          /* 多键 */
    const bad3 = s('e3', { targetKey: 'SciFi', stance: 'like' });                    /* 非 canonical target */
    const bad4 = s('e4', { targetKey: 'scifi', stance: 'love' });                    /* 非闭集 stance */
    const bad5 = s('e5', { targetKey: 'scifi', stance: 'like', source: 'EXPLICIT_USER_REPORT' }); /* body 携带 authority 字段 */
    return bad1.reasonCode === 'reality-event-body-not-permitted-for-source'
      && bad2.reasonCode === 'reality-event-body-not-permitted-for-source'
      && bad3.reasonCode === 'reality-event-body-not-a-canonical-proposition'
      && bad4.reasonCode === 'reality-event-body-not-a-canonical-proposition'
      && bad5.reasonCode === 'reality-event-body-carries-authority-field';
  })(), '缺键 / 多键 / 非 canonical target / 非闭集 stance / body 越权字段 全部拒绝');
  check('F7.wrongDomainOrTypeRefusedForTheNewSource',
    re.ingest({ sourceId: 'user-explicit-preference-report', sourceEvent: { eventId: 'w1', domain: 'runtime', type: 'preference_report', entityId: 'x', timestamp: T0, body: { targetKey: 'scifi', stance: 'like' } } }).reasonCode === 'reality-event-domain-not-permitted-for-source'
    && re.ingest({ sourceId: 'user-explicit-preference-report', sourceEvent: { eventId: 'w2', domain: 'user_preference', type: 'explicit_report', entityId: 'x', timestamp: T0, body: { targetKey: 'scifi', stance: 'like' } } }).reasonCode === 'reality-event-type-not-permitted-for-source',
    'domain/type 逐条钉死');
  check('F8.predictionIdStillForbiddenInsideRealityEvent',
    re.ingest({ sourceId: 'user-explicit-preference-report', sourceEvent: { eventId: 'p1', domain: 'user_preference', type: 'preference_report', entityId: 'x', timestamp: T0, body: { targetKey: 'scifi', stance: 'like' }, predictionId: 'pred_x' } }).ok === false,
    'RealityEvent identity 与 prediction 无关');
}

/* ══════════════════════════════════════════════════════════════════════════
   G · boundaries
   ══════════════════════════════════════════════════════════════════════════ */
section('G · boundaries');
{
  const BOUNDARY = [
    'services/home-node/runtime-explicit-preference-report.js',
    'services/home-node/explicit-preference-report-reality-source.js',
    'services/home-node/explicit-preference-report-seam.js'
  ];
  const dirty = BOUNDARY.filter(rel => {
    const c = code(rel);
    return /require\([^)]*(memory-store|relationship)/i.test(c)
      || /dbPut|writeFileSync|sqlite|localStorage|indexedDB/i.test(c)
      /* 真实**调用**形态（不是 self-description 里的 'settlement: NONE' 字面量） */
      || /\.settlePrediction\s*\(|buildOutcomeObservation\s*\(|authorityGate\s*\(|ingestSettlement\s*\(/.test(c)
      || /require\([^)]*(outcome-observation|prediction-settlement|prediction-calibration|evidence-matcher)/.test(c)
      || /createNodeModelPort|modelPort\s*[:=]/.test(c)
      || /listOpenPredictions|getPrediction\s*\(/.test(c);
  });
  check('G1.reportChainHasNoPredictionSettlementMemoryOrRelationshipAuthority', dirty.length === 0, dirty);
  check('G2.noNewSeamPair',
    G.P3_SETTLEMENT_AUTHORITY_SURFACES.length === 2
    && G.P4_CALIBRATION_AUTHORITY_SURFACES.length === 2
    && G.P5_MATCHER_AUTHORITY_SURFACES.length === 2,
    '不新增跨模块 seam 对');
  check('G3.zeroModelCallsZeroDurableWrites',
    freshProducer().describe().modelCalls === 0 && freshProducer().describe().durableWrites === 0
    && freshProducer().describe().settlementCalls === 0
    && freshProducer().describe().memoryWrites === 0
    && freshProducer().describe().relationshipWrites === 0
    && SEAM_MOD.createExplicitPreferenceReportSeam({}).describe().modelCalls === 0
    && SEAM_MOD.createExplicitPreferenceReportSeam({}).describe().predictionLookups === 0,
    'MODEL_CALLS_ADDED = 0 · DURABLE_WRITES_ADDED = 0');
  check('G4.matcherStillDefaultOff',
    code('services/home-node-service.js').indexOf('enabled: false') >= 0
    && SETTLE_CORE.EVIDENCE_MATCHER_INVOCATION === 'OFF',
    'EVIDENCE_MATCHER_ENABLED_DEFAULT = false');
  check('G5.existingRegexClassifierStillCandidateOnly',
    (function () {
      const adSrc = read('assets/js/active-diary.js');
      const m = adSrc.match(/_explicit\s*=\s*\/(.+?)\/([a-z]*)\.test\(/);
      if (!m) return false;
      const re = new RegExp(m[1], m[2]);
      const ADVERSARIAL = ['她说她喜欢这个', '比如我可以说我喜欢这个', '如果我喜欢它会怎样', '角色A：我喜欢你', '我以前喜欢这个', '我可能有点喜欢这个'];
      const allFire = ADVERSARIAL.every(s => re.test(s));
      const notWired = fs.readdirSync(path.join(ROOT, 'services')).filter(f => f.endsWith('.js'))
        .every(f => code('services/' + f).indexOf('_explicit') < 0 && code('services/' + f).indexOf('active-diary') < 0);
      return allFire && notWired;
    })(),
    'EXISTING_REGEX_EXPLICITNESS_CLASSIFIER = CANDIDATE_ONLY（未被本相位修改或复用）');
}

/* ══════════════════════════════════════════════════════════════════════════
   H · readiness
   ══════════════════════════════════════════════════════════════════════════ */
section('H · readiness');
{
  P('EXPLICITNESS_AUTHORITY', 'DEDICATED_STRUCTURED_USER_REPORT_ACTION');
  P('RAW_CHAT_TEXT_IS_EXPLICIT_REPORT', 'NO');
  P('FREE_TEXT_EXPLICIT_REPORT_PARSER', 'NONE');
  P('MODEL_MAY_DECLARE_EXPLICITNESS', 'NO');
  P('MATCHER_MAY_DECLARE_EXPLICITNESS', 'NO');
  P('EXPLICIT_REPORT_FAMILY', 'USER_PREFERENCE');
  P('STANCE_ENUM', 'LIKE | DISLIKE');
  P('USER_AUTHORSHIP_AUTHORITY', 'LOOPBACK_SOCKET_PLUS_CONFIGURED_DESKTOP_CREDENTIAL');
  P('REPORT_OCCURRED_AT', 'SERVER_ACCEPTED_REPORT_TIME');
  P('REPORT_IDENTITY_INDEPENDENT_OF_PREDICTION', 'YES');
  P('EXPLICIT_USER_REPORT_PRODUCER', 'LIVE_CAPABLE');
  P('EXPLICIT_USER_REPORT_PRODUCTION_CALLER_LIVE', 'YES');
  P('STRUCTURED_EXPLICIT_USER_REPORT_PRODUCTION_LIVE', 'YES');
  P('FREE_TEXT_EXPLICIT_USER_REPORT_PRODUCTION_LIVE', 'NO');
  P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
  P('MATCHER_CALLS_ON_EXPLICIT_REPORT_PATH', 0);
  P('CALIBRATION_CONFIDENCE', 'null');
  P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
  P('MODEL_CALLS_ADDED', 0);
  P('DURABLE_WRITES_ADDED', 0);
  P('MEMORY_WRITE', 'NONE');
  P('RELATIONSHIP_WRITE', 'NONE');
}

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('EXPLICIT USER REPORT AUTHORITY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exit(1);
}
console.log('EXPLICIT USER REPORT AUTHORITY PASSED · ' + passed + ' assertions green');
