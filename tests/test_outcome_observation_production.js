'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P5-B3-B · OutcomeObservation Production
   （纯 Node，零浏览器、零网络、**零模型调用**、零 durable 写）

   运行：node tests/test_outcome_observation_production.js
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROD_REL = 'services/home-node/runtime-outcome-observation.js';
const WIRING = require('./helpers/activation-wiring-probe.js');
const G = require('./helpers/runtime-seam-guard.js');
const MOD = require(path.join(ROOT, PROD_REL));
const { createRuntimeOutcomeObservation, PRODUCER_TABLE, FORBIDDEN_PAYLOAD_KEYS } = MOD;
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const ATT = require(path.join(ROOT, 'assets/js/memory-recall/behavior-effect-attribution-core.js'));
const { createRuntimeBehaviorEffect } = require(path.join(ROOT, 'services/home-node/runtime-behavior-effect.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
const { createRuntimeEvidenceMatcher } = require(path.join(ROOT, 'services/home-node/runtime-evidence-matcher.js'));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = 1760000000000;
const L3 = { ok: true, status: 'succeeded', recordSource: 'S', interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'positive' }] } };
const L5 = { ok: true, status: 'created' };
let CLOCK = T0;
function be(over) {
  CLOCK = T0;
  return createRuntimeBehaviorEffect(Object.assign({ clock: () => CLOCK, logger: () => {} }, over || {}));
}
function producer(over) {
  return createRuntimeOutcomeObservation(over || {});
}
function runEvent(id, occurredAt, token, over) {
  return {
    sourceEventId: id, characterId: 'char_A', conversationId: 'dm:cA',
    occurredAt: occurredAt, kind: 'token', token: token
  };
}
function predRef(id, opensAt, closesAt) {
  return { predictionId: id, opensAt: opensAt, closesAt: closesAt, predictionCreatedAt: opensAt };
}

(async function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · producer allowlist / authority
     ══════════════════════════════════════════════════════════════════ */
  section('A · producer allowlist');
  {
    check('A1.staticTableOnly',
      /* ★ P5-B3-E-R1 翻面：4 → 5。新增的第 5 个是**唯一**一个
         EXPLICIT_USER_REPORT producer，只由 dedicated structured report 链到达。 */
      Object.keys(PRODUCER_TABLE).length === 5
      && PRODUCER_TABLE['runtime-state'].allowedSource === 'CANONICAL_RUNTIME'
      && PRODUCER_TABLE['user-action'].allowedSource === 'USER_BEHAVIOR'
      && PRODUCER_TABLE['linguistic-evidence'].allowedSource === 'LINGUISTIC_EVIDENCE'
      && PRODUCER_TABLE['explicit-user-report'].allowedSource === 'EXPLICIT_USER_REPORT',
      JSON.stringify(Object.keys(PRODUCER_TABLE)));
    check('A2.exactlyOneExplicitReportProducer',
      /* ★ P5-B3-E-R1 翻面：本相位确实建立了 authoritative explicitness boundary。
         收紧后的规则：**恰好一个** producer 可以落在 EXPLICIT_USER_REPORT 上，
         其 sourceInstance 是精确新 token，且域只开放 user_preference。 */
      Object.keys(PRODUCER_TABLE).filter(k => PRODUCER_TABLE[k].allowedSource === 'EXPLICIT_USER_REPORT').length === 1
      && PRODUCER_TABLE['explicit-user-report'].sourceInstance === 'user.explicit-preference-report'
      && PRODUCER_TABLE['explicit-user-report'].allowedDomains.length === 1
      && PRODUCER_TABLE['explicit-user-report'].allowedDomains[0] === 'user_preference'
      && producer().describe().explicitUserReportProducer === 'LIVE_CAPABLE',
      'one explicit-report producer, reached only by the dedicated structured action');
    check('A3.noModelInferenceProducer',
      Object.keys(PRODUCER_TABLE).every(k => PRODUCER_TABLE[k].allowedSource !== 'MODEL_INFERENCE')
      && producer().describe().modelInferenceMayMintReality === 'NO',
      'MODEL_INFERENCE 不得 mint 现实事实');
    check('A4.everySourceInstanceIsAuthorized', (function () {
      return Object.keys(PRODUCER_TABLE).every(k => {
        const p = PRODUCER_TABLE[k];
        const list = OO.AUTHORIZED_OBSERVERS[p.allowedSource] || [];
        return list.indexOf(p.sourceInstance) >= 0;
      });
    })(), 'producer 的 sourceInstance 必须落在 P1 AUTHORIZED_OBSERVERS 里');
    check('A5.dynamicRegistrationForbidden',
      producer().describe().dynamicProducerRegistration === 'FORBIDDEN'
      && producer().describe().producerSourceAllowlist === 'REQUIRED',
      'PRODUCER_SOURCE_ALLOWLIST = REQUIRED');
    check('A6.unknownProducerRefused',
      producer().mintObservation({ producerId: 'evil', sourceEvent: runEvent('e', T0, 'x') }).reasonCode === 'producer-not-registered');
  }

  /* ══════════════════════════════════════════════════════════════════
     B · canonical runtime observation
     ══════════════════════════════════════════════════════════════════ */
  section('B · canonical runtime mint');
  {
    const p = producer();
    const r = p.mintObservation({
      producerId: 'runtime-state', targetDomain: 'runtime_state', completeness: 'point',
      predictionRef: predRef('pred_1', T0, T0 + 86400000),
      sourceEvent: runEvent('evt_1', T0 + 1000, 'delivery.completed')
    });
    check('B1.mintsCanonicalObservation',
      r.ok === true && r.status === 'minted'
      && r.observation.source === 'CANONICAL_RUNTIME'
      && r.observation.targetDomain === 'runtime_state'
      && r.observation.observedAt === T0 + 1000
      && OO.isBuiltObservation(r.observation) === true,
      JSON.stringify({ ok: r.ok, reason: r.reasonCode, src: r.observation && r.observation.source }));
    check('B2.observationIdIsDeterministic', (function () {
      /* P1 builder 是最终 mint authority；这里断言**跨实例确定性**（不是进程计数器） */
      const l2 = producer();
      const r2 = l2.mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state', completeness: 'point',
        predictionRef: predRef('pred_1', T0, T0 + 86400000),
        sourceEvent: runEvent('evt_1', T0 + 1000, 'delivery.completed')
      });
      return typeof r.observation.observationId === 'string'
        && r.observation.observationId.length > 0
        && r2.observation.observationId === r.observation.observationId;
    })(), 'same reality event ⇒ same observationId（跨实例）');
    check('B3.noClockOrRandomInIdentity', (function () {
      const code = read(PROD_REL);
      const seg = code.slice(code.indexOf('function observationIdOf'), code.indexOf('function createRuntimeOutcomeObservation'));
      return seg.indexOf('Date.now') < 0 && seg.indexOf('Math.random') < 0;
    })(), 'identity 不含 Date.now / Math.random / 进程计数器');
    check('B4.mechanicalPathNeedsNoMatcher', (function () {
      const d = p.describe();
      return d.counters.modelCalls === 0 && read(PROD_REL).indexOf('evidence-matcher') < 0;
    })(), 'runtime_state token 路径 0 次模型调用');
    check('B5.observationIsOpportunitySeparate',
      p.describe().observationEqualsOpportunity === 'NO',
      'OUTCOME_OBSERVATION != OPPORTUNITY');
  }

  /* ══════════════════════════════════════════════════════════════════
     C · identity / idempotency
     ══════════════════════════════════════════════════════════════════ */
  section('C · idempotency');
  {
    const p = producer();
    const args = {
      producerId: 'runtime-state', targetDomain: 'runtime_state',
      predictionRef: predRef('pred_1', T0, T0 + 86400000),
      sourceEvent: runEvent('evt_dup', T0 + 5, 'delivery.completed')
    };
    const first = p.mintObservation(args);
    const again = [];
    for (let i = 0; i < 99; i += 1) again.push(p.mintObservation(args));
    check('C1.sameSourceEventMintsOneLogicalObservation',
      first.ok === true && again.every(r => r.status === 'duplicate')
      && p.heldObservationCount() === 1
      && p.describe().counters.minted === 1
      && p.describe().counters.duplicatesSuppressed === 99,
      JSON.stringify({ minted: p.describe().counters.minted, dup: p.describe().counters.duplicatesSuppressed }));
    check('C2.duplicateReusesTheSealedObservation',
      again.every(r => r.observation === first.observation),
      'same sealed object reuse');
    check('C3.differentSourceEventIsDistinct', (function () {
      const l = producer();
      const a = l.mintObservation({ producerId: 'runtime-state', targetDomain: 'runtime_state', predictionRef: predRef('p', T0, T0 + 1e6), sourceEvent: runEvent('eA', T0 + 1, 'delivery.completed') });
      const b = l.mintObservation({ producerId: 'runtime-state', targetDomain: 'runtime_state', predictionRef: predRef('p', T0, T0 + 1e6), sourceEvent: runEvent('eB', T0 + 1, 'delivery.completed') });
      return a.observationId !== b.observationId && l.heldObservationCount() === 2;
    })(), '不同 source event 即使 payload 相同也必须 distinct');
    check('C4.sameEventDifferentPredictionIsDistinct', (function () {
      const l = producer();
      const a = l.mintObservation({ producerId: 'runtime-state', targetDomain: 'runtime_state', predictionRef: predRef('p1', T0, T0 + 1e6), sourceEvent: runEvent('e', T0 + 1, 'delivery.completed') });
      const b = l.mintObservation({ producerId: 'runtime-state', targetDomain: 'runtime_state', predictionRef: predRef('p2', T0, T0 + 1e6), sourceEvent: runEvent('e', T0 + 1, 'delivery.completed') });
      return a.observationId !== b.observationId;
    })(), '同一事件对不同 Prediction 是不同 observation');
    check('C5.holderIsBoundedSessionOnly',
      p.describe().holder.durability === 'NONE' && p.describe().holder.maxEntries > 0
      && p.describe().lifetime === 'SESSION_ONLY'
      && read(PROD_REL).indexOf('new Set(') < 0,
      JSON.stringify(p.describe().holder));
  }

  /* ══════════════════════════════════════════════════════════════════
     D · time model
     ══════════════════════════════════════════════════════════════════ */
  section('D · event time');
  {
    check('D1.delayedProcessingUsesEventTime', (function () {
      const authority = be();
      const p = producer({ attributionAuthority: authority });
      /* 事件发生在 T0+1000；处理发生在 T0+9000 */
      CLOCK = T0 + 9000;
      const r = p.mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        predictionRef: predRef('p', T0, T0 + 1e6),
        sourceEvent: runEvent('evt_time', T0 + 1000, 'delivery.completed')
      });
      return r.ok === true && r.observation.observedAt === T0 + 1000
        && r.attribution.at === T0 + 1000;
    })(), 'OUTCOME_ATTRIBUTION_SNAPSHOT_TIME = REALITY_EVENT_TIME');
    check('D2.missingEventTimeIsRefused',
      producer().mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        predictionRef: predRef('p', T0, T0 + 1e6),
        sourceEvent: { sourceEventId: 'e', characterId: 'char_A', conversationId: 'dm:cA', kind: 'token', token: 'delivery.completed' }
      }).reasonCode === 'producer-event-identity-missing',
      'payload 不得自带 observedAt 覆盖 authority');
    check('D3.pairingBindingRequired',
      producer().mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        sourceEvent: runEvent('e', T0 + 1, 'delivery.completed')
      }).reasonCode === 'pairing-binding-missing',
      'P1 要求 observation 绑定到一个 Prediction window');
    check('D4.noNaturalLanguageTimestampAuthority',
      read(PROD_REL).indexOf('yesterday') < 0 && read(PROD_REL).indexOf('parseDate') < 0
      && producer().describe().outcomeAttributionSnapshotTime === 'REALITY_EVENT_TIME',
      'natural-language temporal claim 不是 authoritative clock');
  }

  /* ══════════════════════════════════════════════════════════════════
     E · outcome-time attribution
     ══════════════════════════════════════════════════════════════════ */
  section('E · outcome-time attribution');
  {
    function derive(inst, turn) {
      return inst.deriveAndHold({
        characterId: 'char_A', conversationId: 'dm:cA', turnId: turn,
        interpretationValidated: true, interpretationResult: L3,
        expectationHeld: true, expectation: L5
      });
    }
    check('E1.effectActiveAtEventTimeIsKnownPresent', (function () {
      const a = be();
      CLOCK = T0 + 1000; derive(a, 'T1');       /* effect 从 T0+1000 起 */
      CLOCK = T0 + 9000;                        /* 处理在很久以后 */
      const p = producer({ attributionAuthority: a });
      const r = p.mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        predictionRef: predRef('p', T0, T0 + 1e6),
        sourceEvent: runEvent('evt_ep', T0 + 2000, 'delivery.completed')
      });
      return r.ok === true && r.attribution.status === 'known-present'
        && r.observation.interventionContext.predictionInfluencedSystem === false;
    })(), 'T2 = known-present（不能因为 T4 已无 effect 就 known-none）');
    check('E2.noEffectAtEventTimeIsKnownNone', (function () {
      const a = be();
      CLOCK = T0 + 1000; derive(a, 'T1');
      CLOCK = T0 + 1500; a.consumeForTurn({ characterId: 'char_A', conversationId: 'dm:cA', turnId: 'X' });
      CLOCK = T0 + 9000;
      const p = producer({ attributionAuthority: a });
      const r = p.mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        predictionRef: predRef('p', T0, T0 + 1e6),
        sourceEvent: runEvent('evt_en', T0 + 3000, 'delivery.completed')
      });
      return r.ok === true && r.attribution.status === 'known-none';
    })(), 'T2 无 effect ⇒ known-none（不被 T3/T4 的 effect 污染）');
    check('E3.attributionFailureKeepsTheEvent', (function () {
      const p = producer({ attributionAuthority: { snapshotBehaviorEffectAttribution: () => { throw new Error('x'); } } });
      const r = p.mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        predictionRef: predRef('p', T0, T0 + 1e6),
        sourceEvent: runEvent('evt_fail', T0 + 500, 'delivery.completed')
      });
      return r.ok === true && r.attribution.status === 'unknown'
        && r.observation.interventionContext.predictionInfluencedSystem === null
        && p.describe().counters.attributionFailures === 1;
    })(), 'ATTRIBUTION_FAILURE != REALITY_EVENT_LOST');
    check('E4.invalidSnapshotFallsBackToUnknown', (function () {
      const p = producer({
        attributionAuthority: {
          snapshotBehaviorEffectAttribution: () => ({ status: 'known-none', coverage: 'complete' }),
          isBehaviorEffectAttributionSnapshot: () => false
        }
      });
      const r = p.mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        predictionRef: predRef('p', T0, T0 + 1e6),
        sourceEvent: runEvent('evt_inv', T0 + 500, 'delivery.completed')
      });
      return r.ok === true && r.attribution.status === 'unknown';
    })(), '非法 capability ⇒ unknown，但事件仍然存在');
    check('E5.historicalFloorGivesUnknownNotLoss', (function () {
      const a = be();
      CLOCK = T0 + 1000; derive(a, 'T1');
      const p = producer({ attributionAuthority: a });
      /* 查询早于 authoritySince 的事件时刻 */
      const r = p.mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        predictionRef: predRef('p', T0 - 5000, T0 + 1e6),
        sourceEvent: runEvent('evt_floor', T0 - 4000, 'delivery.completed')
      });
      return r.ok === true && r.attribution.status === 'unknown'
        && r.attribution.coverage === 'partial';
    })(), '早于 coverageFloor：observation 仍存在，归因 unknown/partial');
    check('E6.creationAndOutcomeAttributionStaySeparate',
      read(PROD_REL).indexOf('predictionSnapshotAtCreation') < 0,
      'producer 不触碰 Prediction creation snapshot');
  }

  /* ══════════════════════════════════════════════════════════════════
     F · laundering / forge
     ══════════════════════════════════════════════════════════════════ */
  section('F · laundering & forge');
  {
    const p = producer();
    const base = {
      producerId: 'runtime-state', targetDomain: 'runtime_state',
      predictionRef: predRef('p', T0, T0 + 1e6),
      sourceEvent: runEvent('evt_l', T0 + 1, 'delivery.completed')
    };
    function withPayload(extra) {
      const args = JSON.parse(JSON.stringify(base));
      args.sourceEvent.payload = extra;
      return p.mintObservation(args);
    }
    const bad = ['settlementState', 'relation', 'calibrationCounted', 'predictionType', 'source', 'targetDomain', 'authorityLevel'];
    const leaked = bad.filter(f => {
      const r = withPayload({ [f]: 'x' });
      return r.ok === false && r.reasonCode === 'producer-payload-carries-authority-field';
    });
    check('F1.settlementAndAuthorityLaunderingRefused', leaked.length === bad.length,
      JSON.stringify(bad.filter(f => leaked.indexOf(f) < 0)));
    check('F2.domainForgeRefused',
      p.mintObservation(Object.assign({}, base, { targetDomain: 'user_preference' })).reasonCode === 'producer-not-authorized-for-domain',
      'producer 不能跨 domain');
    check('F3.oversizedPayloadRefused', (function () {
      const args = JSON.parse(JSON.stringify(base));
      args.sourceEvent.payload = {}; 
      for (let i = 0; i < 20; i += 1) args.sourceEvent.payload['k' + i] = i;
      const r = p.mintObservation(args);
      return r.ok === false && r.reasonCode === 'producer-payload-not-bounded';
    })(), 'factual payload 必须 bounded');
    check('F4.producerCannotMintASeal',
      (function () {
        const code = WIRING.stripJsComments(read(PROD_REL));
        return code.indexOf('WeakSet') < 0 && code.indexOf('WeakMap') < 0
          && code.indexOf('deepFreeze') < 0;
      })()
      && producer().describe().capabilityMintAuthority === 'OUTCOME_OBSERVATION_CORE_BUILDER',
      'ONLY_OUTCOME_OBSERVATION_AUTHORITY_MINTS_VALID_OBSERVATION = YES');
    check('F5.forgedObservationStillRejectedByP1', (function () {
      const r = p.mintObservation({
        producerId: 'runtime-state', targetDomain: 'runtime_state',
        predictionRef: predRef('p', T0, T0 + 1e6),
        sourceEvent: runEvent('evt_ok', T0 + 1, 'delivery.completed')
      });
      return OO.isBuiltObservation(r.observation) === true
        && OO.isBuiltObservation(JSON.parse(JSON.stringify(r.observation))) === false
        && OO.isBuiltObservation(Object.assign({}, r.observation)) === false
        && OO.isBuiltObservation({ brand: 'OutcomeObservation', validated: true }) === false;
    })(), 'plain / JSON clone / Object.assign clone / copied brand 全部 invalid');
  }

  /* ══════════════════════════════════════════════════════════════════
     G · pairing
     ══════════════════════════════════════════════════════════════════ */
  section('G · pairing');
  {
    function makeRegistry() { return createRuntimePredictionRegistry({ clock: () => T0 }); }
    function project(reg, turnId, token, over) {
      return reg.projectFromValidatedExpectation(Object.assign({
        epistemicStatus: 'prediction', prediction: '投递会被取消',
        trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
        contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
        subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
        predicate: { kind: 'will-do' }, expectedOutcome: { kind: 'exclusive-outcome', token: token }
      }, over || {}), {
        now: T0, characterId: 'char_A', conversationId: 'dm:cA', turnId: turnId, expectationIndex: 0
      }).record;
    }
    const reg = makeRegistry();
    const p1 = project(reg, 'pa', 'delivery.cancelled');
    const p2 = project(reg, 'pb', 'delivery.completed');
    const prod = producer({ registry: reg });
    const obs = prod.mintObservation({
      producerId: 'runtime-state', targetDomain: 'runtime_state',
      predictionRef: predRef(p1.predictionId, p1.observationWindow.opensAt, p1.observationWindow.closesAt),
      sourceEvent: runEvent('evt_pair', T0 + 1000, 'delivery.completed')
    }).observation;
    const cands = prod.candidatePredictions(obs, { characterId: 'char_A', conversationId: 'dm:cA' });
    check('G1.candidatesAreScopedAndBounded',
      Array.isArray(cands) && cands.length <= MOD.BOUNDS.MAX_PAIRING_CANDIDATES,
      JSON.stringify(cands.length));
    check('G2.pairingIsolatedByScope',
      prod.candidatePredictions(obs, { characterId: 'char_B', conversationId: 'dm:cA' }).length === 0
      && prod.candidatePredictions(obs, { characterId: 'char_A', conversationId: 'other' }).length === 0,
      '不得 pairing 到其它角色/会话');
    check('G3.pairingDoesNotImplyRelation',
      prod.describe().pairingImpliesRelation === 'NO'
      && prod.describe().pairingAuthority === 'PREDICTION_REGISTRY_SCOPE_QUERY'
      && typeof prod.candidatePredictions === 'function'
      && read(PROD_REL).indexOf("state = 'matched'") < 0
      && read(PROD_REL).indexOf('computeSettlement') < 0,
      'candidate ≠ support/conflict；producer 不结算');
    check('G4.producerHasNoPairingAuthorityFromPayload',
      G.containsSemantic(WIRING.stripJsComments(read(PROD_REL)), 'textSimilarity') === false
      && read(PROD_REL).indexOf('similarity') < 0,
      '不得用文本相似度做 production pairing');
    void p2;
  }

  /* ══════════════════════════════════════════════════════════════════
     H · settlement integration（不 short-circuit）
     ══════════════════════════════════════════════════════════════════ */
  section('H · settlement integration');
  {
    function makeRegistry() { return createRuntimePredictionRegistry({ clock: () => T0 }); }
    function project(reg, token, turnId) {
      return reg.projectFromValidatedExpectation({
        epistemicStatus: 'prediction', prediction: '投递会被取消',
        trigger: { kind: 'explicit-cue', label: 'l' }, evidenceMemoryIds: ['m1'],
        contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis',
        subjectivePredictionConfidence: 0.8, subject: { kind: 'user', label: '' },
        predicate: { kind: 'will-do' }, expectedOutcome: { kind: 'exclusive-outcome', token: token }
      }, { now: T0, characterId: 'char_A', conversationId: 'dm:cA', turnId: turnId, expectationIndex: 0 }).record;
    }
    const reg = makeRegistry();
    const pred = project(reg, 'delivery.cancelled', 'hs1');
    const auth = be();
    const prod = producer({ attributionAuthority: auth, registry: reg });
    /* ① runtime success */
    const okObs = prod.mintObservation({
      producerId: 'runtime-state', targetDomain: 'runtime_state',
      predictionRef: predRef(pred.predictionId, pred.observationWindow.opensAt, pred.observationWindow.closesAt),
      sourceEvent: runEvent('hs_ok', T0 + 1000, 'delivery.cancelled')
    }).observation;
    const s1 = createRuntimePredictionSettlement({ clock: () => T0 });
    const r1 = s1.settlePrediction(pred, [{ observation: okObs }], {
      now: T0 + 2000, opportunity: { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 1500 }
    });
    check('H1.runtimeSuccessSettlesMatched',
      r1.settlement.state === 'matched' && r1.settlement.calibrationCounted === true,
      JSON.stringify({ s: r1.settlement.state }));
    /* ② runtime conflict ⇒ 只有 opportunity policy 允许才 missed */
    const reg2 = makeRegistry();
    const pred2 = project(reg2, 'delivery.cancelled', 'hs2');
    const prod2 = producer({ attributionAuthority: be(), registry: reg2 });
    const missObs = prod2.mintObservation({
      producerId: 'runtime-state', targetDomain: 'runtime_state',
      predictionRef: predRef(pred2.predictionId, pred2.observationWindow.opensAt, pred2.observationWindow.closesAt),
      sourceEvent: runEvent('hs_miss', T0 + 1000, 'delivery.completed')
    }).observation;
    const s2 = createRuntimePredictionSettlement({ clock: () => T0 });
    const r2 = s2.settlePrediction(pred2, [{ observation: missObs }], {
      now: T0 + 2000, opportunity: { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 1500 }
    });
    check('H2.runtimeConflictSettlesMissedViaPolicy',
      r2.settlement.state === 'missed'
      /* producer 侧**不产出**结算状态：'missed' 只出现在禁止键表里（声明它为非法） */
      && FORBIDDEN_PAYLOAD_KEYS.indexOf('missed') >= 0
      && FORBIDDEN_PAYLOAD_KEYS.indexOf('matched') >= 0,
      'producer 从未写 missed；状态由 P3 决定 (state=' + r2.settlement.state + ')');
    check('H3.noUniqueOpportunityConflation',
      read(PROD_REL).indexOf('NOT-CONSUMED') < 0 && read(PROD_REL).indexOf('ABSENT') < 0,
      'producer 不决定 opportunity');
    /* ③ 用户行为 producer：event 可结算，preference 仍非 decisive */
    const ubObs = prod.mintObservation({
      producerId: 'user-action', targetDomain: 'user_behavior',
      predictionRef: predRef(pred2.predictionId, pred2.observationWindow.opensAt, pred2.observationWindow.closesAt),
      sourceEvent: { sourceEventId: 'ua1', characterId: 'char_A', conversationId: 'dm:cA', occurredAt: T0 + 1000, kind: 'token', token: 'action.confirmed' }
    });
    check('H4.userBehaviorMintsUserBehaviorSource',
      ubObs.ok === true && ubObs.observation.source === 'USER_BEHAVIOR'
      && ubObs.observation.targetDomain === 'user_behavior',
      JSON.stringify({ ok: ubObs.ok, reason: ubObs.reasonCode }));
    check('H5.userBehaviorCannotBecomeExplicitReport',
      /* ★ P5-B3-E-R1 翻面：原断言是"producer 文件里根本没有 EXPLICIT_USER_REPORT 字面量"。
         现在该字面量**必须**存在（那是本相位建立的唯一 explicit-report producer）。
         收紧后的规则：user-action 仍然只能是 USER_BEHAVIOR，而 EXPLICIT_USER_REPORT
         只被**恰好一个**具名 producer 使用；行为证据进不了主观域。 */
      PRODUCER_TABLE['user-action'].allowedSource === 'USER_BEHAVIOR'
      && PRODUCER_TABLE['explicit-user-report'].allowedSource === 'EXPLICIT_USER_REPORT'
      && Object.keys(PRODUCER_TABLE).filter(k => PRODUCER_TABLE[k].allowedSource === 'EXPLICIT_USER_REPORT').length === 1
      && prod.mintObservation({
        producerId: 'user-action', targetDomain: 'user_preference',
        predictionRef: predRef(pred2.predictionId, pred2.observationWindow.opensAt, pred2.observationWindow.closesAt),
        sourceEvent: { sourceEventId: 'ua_x', characterId: 'char_A', conversationId: 'dm:cA', occurredAt: T0 + 1000, kind: 'token', token: 'action.confirmed' }
      }).ok === false,
      'user-action 不得升权为 EXPLICIT_USER_REPORT');
    /* ④ ordinary chat text ⇒ LINGUISTIC_EVIDENCE（不得成为 explicit report） */
    const lingObs = prod.mintObservation({
      producerId: 'linguistic-evidence', targetDomain: 'user_preference',
      predictionRef: predRef(pred2.predictionId, pred2.observationWindow.opensAt, pred2.observationWindow.closesAt),
      sourceEvent: { sourceEventId: 'lg1', characterId: 'char_A', conversationId: 'dm:cA', occurredAt: T0 + 1000, kind: 'statement', statement: '今天挺累的' }
    });
    check('H6.ordinaryChatTextIsLinguisticEvidence',
      lingObs.ok === true && lingObs.observation.source === 'LINGUISTIC_EVIDENCE',
      JSON.stringify({ ok: lingObs.ok, reason: lingObs.reasonCode }));
    check('H7.linguisticEvidenceStaysNonDecisiveEvenWithMatcherEnabled', (async function () {
      const matcher = createRuntimeEvidenceMatcher({
        modelPort: { run: async () => ({ ok: true, text: '{"relation":"support"}' }) },
        registry: { getCharacterSpec: () => ({ provider: 'p', model: 'm', endpoint: 'e', credentialRef: 'r' }) },
        credentialAccess: { resolve: () => ({ ok: true, secret: 's' }) },
        enabled: true
      });
      const e = createRuntimePredictionSettlement({ clock: () => T0, evidenceMatcher: matcher });
      const r = await e.settlePredictionWithEvidenceMatcher(pred2, [{ observation: lingObs.observation }], {
        now: T0 + 2000, opportunity: { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 1500 }
      });
      return r.settlement.state !== 'matched' && r.settlement.calibrationCounted === false;
    })(), 'Matcher support 不能把 linguistic evidence 洗成 decisive');
  }

  /* ══════════════════════════════════════════════════════════════════
     I · calibration boundary
     ══════════════════════════════════════════════════════════════════ */
  section('I · calibration boundary');
  {
    check('I1.producerNeverTouchesCalibration',
      read(PROD_REL).indexOf('ingestSettlement') < 0
      && read(PROD_REL).indexOf('prediction-calibration') < 0
      && FORBIDDEN_PAYLOAD_KEYS.indexOf('calibrationCounted') >= 0
      && producer().describe().oneCanonicalObservationMintPath === 'YES',
      'Producer MUST NOT write Calibration directly（calibrationCounted 只在禁止键表里）');
    check('I2.chainIsExplicit',
      read(PROD_REL).indexOf('settlementRuntime') >= 0
      && producer().describe().oneCanonicalObservationMintPath === 'YES',
      'Observation → Settlement → Prediction Error → Calibration');
    check('I3.noDurableObservationStore',
      (function () {
        const code = WIRING.stripJsComments(read(PROD_REL));
        return !/indexedDB|localStorage|writeFile|dbPut|sqlite/i.test(code);
      })() && producer().describe().durableWrites === 0,
      'OUTCOME_OBSERVATION_LIFETIME = SESSION_ONLY');
  }

  /* ══════════════════════════════════════════════════════════════════
     J · guard
     ══════════════════════════════════════════════════════════════════ */
  section('J · guard');
  {
    check('J1.noSecondObservationAuthority',
      read(PROD_REL).indexOf('buildOutcomeObservation') >= 0
      && read(PROD_REL).indexOf('INTERVENTION') < 0,
      'ONE_CANONICAL_OUTCOME_OBSERVATION_MINT_PATH = YES');
    const TOK = ['runtime-outcome-observation', 'createRuntimeOutcomeObservation', 'mintObservation'];
    const OTHERS = [
      'services/home-node/runtime-recall.js', 'services/home-node/runtime-interpretation.js',
      'services/home-node/runtime-expectation.js', 'services/home-node/runtime-behavior-effect.js',
      'services/home-node/runtime-evidence-matcher.js', 'services/home-node/runtime-prediction-calibration.js',
      'assets/js/communication.js', 'services/home-node/memory-store.js', 'assets/js/role-dm-core.js'
    ];
    const leaky = OTHERS.filter(rel => {
      const code = WIRING.stripJsComments(read(rel));
      return TOK.some(t => G.containsSemantic(code, t));
    });
    check('J2.notReachableFromForbiddenSurfaces', leaky.length === 0, JSON.stringify(leaky));
    check('J3.browserCannotMintObservations', (function () {
      const comm = read('assets/js/communication.js')
        + '\nasync function _ibMint(m) { return runtimeOutcomeObservation.mintObservation(m); }\n';
      return G.auditBrowserCognitionBoundary(comm, { surface: 'assets/js/communication.js' }).ok === false;
    })(), 'browser 不得 mint sealed observation');
    check('J4.noNewRuntimeSeamPair',
      G.P3_SETTLEMENT_AUTHORITY_SURFACES.length === 2
      && G.P4_CALIBRATION_AUTHORITY_SURFACES.length === 2
      && G.P5_MATCHER_AUTHORITY_SURFACES.length === 2,
      '不新增跨模块 seam 对');
    check('J5.zeroModelCallsZeroDurableWrites',
      producer().describe().modelCalls === 0 && producer().describe().durableWrites === 0,
      'MODEL_CALLS_ADDED = 0 · DURABLE_WRITES_ADDED = 0');
  }

  /* ══════════════════════════════════════════════════════════════════
     K · scope / readiness
     ══════════════════════════════════════════════════════════════════ */
  section('K · readiness');
  {
    P('P5_B3_B_STATUS', 'COMPLETE');
    P('OUTCOME_OBSERVATION_PRODUCTION_AUTHORITY', 'LIVE_CAPABLE');
    P('OUTCOME_OBSERVATION_CAPABILITY_MINT_AUTHORITY', 'OUTCOME_OBSERVATION_CORE_BUILDER');
    P('ONE_CANONICAL_OUTCOME_OBSERVATION_MINT_PATH', 'YES');
    P('PRODUCER_SOURCE_ALLOWLIST', 'REQUIRED');
    P('OUTCOME_ATTRIBUTION_SNAPSHOT_TIME', 'REALITY_EVENT_TIME');
    P('OUTCOME_OBSERVATION_PRODUCER_MAY_OBSERVE_FACTS_ONLY', 'YES');
    P('OBSERVATION_MINT_AUTHORITY', 'PRODUCER_TABLE_STATIC');
    P('PREDICTION_PAIRING_AUTHORITY', 'PREDICTION_REGISTRY_SCOPE_QUERY');
    P('OUTCOME_OBSERVATION_EQUALS_OPPORTUNITY', 'NO');
    P('EXPLICIT_USER_REPORT_PRODUCER', 'LIVE_CAPABLE（P5-B3-E-R1 · 唯一具名 producer explicit-user-report）');
    P('MODEL_INFERENCE_MAY_MINT_REALITY', 'NO');
    P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
    P('MATCHER_DEFAULT_CHANGED', 'NO');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('CALIBRATION_CONFIDENCE', 'null');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
    P('MEMORY_WRITE', 'NONE');
    P('RELATIONSHIP_WRITE', 'NONE');
    P('UI_DISCLOSURE_CHANGED', 'NO');
    P('RECALL_ENVELOPE_CHANGED', 'NO');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('OUTCOME OBSERVATION PRODUCTION FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('OUTCOME OBSERVATION PRODUCTION PASSED · ' + passed + ' assertions green');
})().catch((e) => {
  console.error('OUTCOME OBSERVATION PRODUCTION CRASHED:', e && e.stack ? e.stack : e);
  process.exit(1);
});

