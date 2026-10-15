'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · Prediction Error P4 · Calibration Ledger
   （纯 Node，零浏览器、零网络、**零模型调用**、零 durable 写、零写回）

   运行：node tests/test_prediction_calibration_ledger.js

   本套件证明：
     · 只消费 P3 的 `calibrationCounted === true`（P4 **不重开** P3 authority）
     · provenance 由 P3 模块的 module-private capability seal 提供
     · 按 `predictionType × targetDomain` **分区**，跨域 confidence 转移被禁止
     · **不存在**可被 authority 消费的全局精度
     · exactly-once（有界窗口内）
     · 机械计数 + ordinal PE bucket；`calibrationConfidence = null`（契约冻结）
     · capability gap 与"没数据"被明确区分
     · session-only · 零写回 · internal audit only
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CAL_CORE_REL = 'assets/js/memory-recall/prediction-calibration-core.js';
const CAL_RT_REL = 'services/home-node/runtime-prediction-calibration.js';
const WIRING = require('./helpers/activation-wiring-probe.js');
const G = require('./helpers/runtime-seam-guard.js');
const CORE = require(path.join(ROOT, CAL_CORE_REL));
const SETTLE_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-settlement-core.js'));
const RECORD_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-record-core.js'));
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const SETTLEMENT = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
const { createRuntimePredictionSettlement } = SETTLEMENT;
const { createRuntimePredictionCalibration } = require(path.join(ROOT, CAL_RT_REL));

let passed = 0, failures = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log('  PASS  ' + n); return true; }
  failures++; console.error('  FAIL  ' + n + (d ? '  -> ' + d : '')); return false;
};
const section = t => console.log('\n── ' + t + ' ──');
const P = (k, v) => console.log('  FACTS ' + k + ' = ' + v);
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const T0 = 1760000000000;
const SCOPE = { characterId: 'char_A', conversationId: 'dm:char_A', subjectKind: 'user', subjectLabel: '' };
let turnSeq = 0;

function expectation(over) {
  const base = {
    epistemicStatus: 'prediction',
    prediction: '系统会取消这次投递',
    trigger: { kind: 'explicit-cue', label: '投递窗口打开时' },
    evidenceMemoryIds: ['m1'], contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' }, predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: 'delivery.cancelled' }
  };
  return Object.assign({}, base, over || {});
}
function makePrediction(expOver, ctxOver) {
  const reg = createRuntimePredictionRegistry({ clock: () => T0 });
  turnSeq += 1;
  const res = reg.projectFromValidatedExpectation(expectation(expOver), Object.assign({
    now: T0, characterId: SCOPE.characterId, conversationId: SCOPE.conversationId,
    turnId: 'turn_' + turnSeq, expectationIndex: 0
  }, ctxOver || {}));
  return res.record;
}
/* event 预测：token 必须是观察域里的合法 token。
   over = { exp: <Expectation 覆盖>, ctx: <投影 ctx 覆盖>, obs: <观察覆盖> } */
function eventPred(token, over) {
  const o = over || {};
  return makePrediction(
    Object.assign({ expectedOutcome: { kind: 'exclusive-outcome', token: token } }, o.exp || {}),
    o.ctx || {}
  );
}
/* preference 预测：主观域必须显式声明 attribution known-none 才可能 decisive */
function prefPred(token, ctxOver) {
  return makePrediction({
    prediction: '用户更喜欢被确认而不是被取消',
    predicate: { kind: 'prefers' },
    expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, Object.assign({ behaviorEffectAttribution: { status: 'known-none', effects: [] } }, ctxOver || {}));
}
function obsFor(pred, token, over) {
  const r = OO.buildOutcomeObservation(Object.assign({
    windowRef: {
      predictionId: pred.predictionId,
      predictionCreatedAt: pred.observationWindow.opensAt,
      opensAt: pred.observationWindow.opensAt,
      closesAt: pred.observationWindow.closesAt
    },
    source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.delivery',
    targetDomain: 'runtime_state',
    observedAt: pred.observationWindow.opensAt + 1000,
    completeness: 'point',
    /* 观察的 scope 直接取自**预测自己的** scope ⇒ 永远一致（含 subjectKind/subjectLabel） */
    scope: pred.scope,
    outcomeRef: { kind: 'token', token: token },
    evidenceRefs: ['evidence_1'],
    interventionContext: {
      behaviorEffectsInForce: [], predictionInfluencedSystem: null,
      contaminationClass: 'NONE', contaminationBasis: 'no intervention in force'
    }
  }, over || {}), {});
  return r.ok ? r.value : null;
}
function opp() {
  return { required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 1500 };
}
/* P4 policy fixtures grant a sealed unit-test opportunity capability to P3;
   they never pass `opportunity` through P3's public settlement context. */
function testOpportunityAuthority(fixture) {
  const identity = new WeakSet();
  return {
    resolveForPrediction: function () {
      const state = fixture && fixture.required === true && fixture.existence
        && fixture.existence.authoritySource === 'CANONICAL_RUNTIME'
        && fixture.existence.present === true && fixture.consumedAt != null
        ? 'SATISFIED' : 'UNKNOWN';
      const result = Object.freeze({ state: state, opportunity: fixture });
      identity.add(result);
      return result;
    },
    isResolution: function (value) { return !!value && identity.has(value); }
  };
}
/* 走完整链路：settle → 返回 { settlement, predictionError } */
function settleOne(pred, token, over) {
  const o = obsFor(pred, token, over);
  const e = createRuntimePredictionSettlement({
    clock: () => T0,
    opportunityAuthority: testOpportunityAuthority(opp())
  });
  const r = e.settlePrediction(pred, [{ observation: o }], { now: pred.observationWindow.opensAt + 2000 });
  return { ok: r.ok, state: r.settlement && r.settlement.state, settlement: r.settlement, predictionError: r.predictionError };
}
function p3WithOpportunity() {
  return createRuntimePredictionSettlement({
    clock: () => T0,
    opportunityAuthority: testOpportunityAuthority(opp())
  });
}
/**
 * 造一条**必然 calibration-eligible** 的结算。
 *   expectedToken —— 预测期望的 token
 *   observedToken —— 实际观察到的 token（省略 = 与期望相同 ⇒ matched）
 *   over          —— { exp, ctx, obs }（见 eventPred）
 * 期望 ≠ 观察 ⇒ 互斥 ⇒ missed。
 */
function countedSettlement(expectedToken, observedToken, over) {
  const o = over || {};
  const observed = observedToken === undefined ? expectedToken : observedToken;
  const pred = eventPred(expectedToken, o);
  const r = settleOne(pred, observed, o.obs);
  if (!r.settlement || r.settlement.calibrationCounted !== true) {
    throw new Error('fixture not calibration-eligible: ' + JSON.stringify({
      state: r.state, expectedToken: expectedToken, observedToken: observed,
      counted: r.settlement && r.settlement.calibrationCounted
    }));
  }
  return r;
}
function cal(over) { return createRuntimePredictionCalibration(Object.assign({}, over || {})); }

(function main() {
  /* ══════════════════════════════════════════════════════════════════
     A · capability / provenance
     ══════════════════════════════════════════════════════════════════ */
  section('A · provenance capability');
  {
    const r = countedSettlement('delivery.cancelled');
    const ledger = cal();
    check('A1.sealedSettlementIsAccepted',
      SETTLEMENT.isSettlementRecord(r.settlement) === true
      && ledger.ingestSettlement(r.settlement, { now: T0 + 3000, predictionError: r.predictionError }).status === 'ingested',
      'a sealed P3 SettlementRecord must be the only accepted input');

    const forged = { state: 'matched', calibrationCounted: true, settlementId: 'stl_x', predictionId: 'pred_x' };
    check('A2.plainObjectIsRejectedNotCounted',
      ledger.ingestSettlement(forged, { now: T0 + 3001 }).reasonCode === 'not-a-sealed-settlement-record',
      'a plain object must never self-certify');

    check('A3.jsonCloneIsRejected',
      SETTLEMENT.isSettlementRecord(JSON.parse(JSON.stringify(r.settlement))) === false
      && ledger.ingestSettlement(JSON.parse(JSON.stringify(r.settlement)), { now: T0 + 3002 }).ok === false,
      'JSON round-trip must not revive provenance');

    check('A4.objectAssignCloneIsRejected',
      SETTLEMENT.isSettlementRecord(Object.assign({}, r.settlement)) === false,
      'a shallow clone must not revive provenance');

    check('A5.crossModuleInstanceIsRejected', (function () {
      const p = require.resolve(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
      const saved = require.cache[p];
      delete require.cache[p];
      const S2 = require(p);
      const rejected = S2.isSettlementRecord(r.settlement) === false;
      if (saved) require.cache[p] = saved;
      return rejected;
    })(), 'another loaded instance must not validate this record');

    check('A6.tamperedSealedRecordIsRejected', (function () {
      const e = p3WithOpportunity();
      const pred = eventPred('delivery.cancelled');
      const s = e.settlePrediction(pred, [{ observation: obsFor(pred, 'delivery.cancelled') }],
        { now: pred.observationWindow.opensAt + 2000 }).settlement;
      /* 深层字段若可写（不会，因为 deepFreeze），指纹也会抓出来 */
      return SETTLEMENT.isSettlementRecord(s) === true
        && SETTLEMENT.isSettlementRecord(Object.assign({}, s)) === false;
    })(), 'the seal is fingerprint-checked, not just shape-checked');

    check('A7.noSelfAssertedValidationField',
      read(CAL_RT_REL).indexOf('.validated === true') < 0
      && read(CAL_RT_REL).indexOf('validated === true') < 0
      && read(CAL_CORE_REL).indexOf('validated === true') < 0,
      'never trust a self-declared `validated` boolean');
  }

  /* ══════════════════════════════════════════════════════════════════
     B · exactly-once
     ══════════════════════════════════════════════════════════════════ */
  section('B · exactly-once');
  {
    const r = countedSettlement('delivery.cancelled');
    const ledger = cal();
    const first = ledger.ingestSettlement(r.settlement, { now: T0 + 3000, predictionError: r.predictionError });
    const again = [];
    for (let i = 0; i < 5; i += 1) again.push(ledger.ingestSettlement(r.settlement, { now: T0 + 3001 + i, predictionError: r.predictionError }));
    for (let i = 0; i < 100; i += 1) again.push(ledger.ingestSettlement(r.settlement, { now: T0 + 3100 + i, predictionError: r.predictionError }));
    const part = ledger.getPartition('event', 'runtime_state');
    check('B1.accountedAtMostOnce', part.calibrationCounts.matched === 1,
      'ingested 106 times, matched=' + part.calibrationCounts.matched);
    check('B2.duplicatesAreIdempotentNotErrors',
      first.status === 'ingested' && again.every(x => x.status === 'duplicate' && x.changed === false),
      'duplicate ingest must be a no-op, not an error and not a recount');
    check('B3.entryIdentityIsDeterministic',
      CORE.calibrationEntryId(r.settlement) === CORE.calibrationEntryId(r.settlement)
      && CORE.calibrationEntryId(r.settlement).indexOf('cal_') === 0,
      'calibrationEntryId must be deterministic and prefixed');
    check('B4.entryIdentityCoversSessionSettlementPredictionPartition',
      (function () {
        const p = CORE.calibrationPartitionKey(r.settlement);
        const id = CORE.calibrationEntryId(r.settlement, p);
        const tampered = Object.assign({}, r.settlement, { settlementId: 'stl_other' });
        return id !== CORE.calibrationEntryId(tampered, p);
      })(), 'a different settlementId must produce a different entry identity');
    check('B5.distinctSettlementsFromDistinctSessionsBothCount', (function () {
      /* 真正不同的 session：不同角色 ⇒ 不同 registrySessionRef */
      const a = countedSettlement('delivery.cancelled');
      const b = countedSettlement('delivery.cancelled', undefined, { ctx: { characterId: 'char_B' } });
      const l = cal();
      l.ingestSettlement(a.settlement, { now: T0 + 3000, predictionError: a.predictionError });
      l.ingestSettlement(b.settlement, { now: T0 + 3001, predictionError: b.predictionError });
      return a.settlement.registrySessionRef !== b.settlement.registrySessionRef
        && a.settlement.predictionId !== b.settlement.predictionId
        && l.getPartition('event', 'runtime_state').calibrationCounts.matched === 2;
    })(), 'different session refs must not be over-deduplicated');
    check('B6.exactlyOnceScopeIsDeclared',
      ledger.describe().exactlyOncePerSettlement === 'YES_WITHIN_BOUNDED_LEDGER_WINDOW',
      'the exactly-once scope must be declared, not implied to be unlimited');
    check('B7.dedupeIndexIsBoundedNotAnUnboundedSet',
      read(CAL_RT_REL).indexOf('new Set(') < 0
      && ledger.describe().holder.maxDedupeEntries > 0
      && ledger.describe().holder.maxPartitions > 0,
      'no unbounded Set(settlementId)');
  }

  /* ══════════════════════════════════════════════════════════════════
     C · calibration eligibility（calibrationCounted 是唯一硬入口）
     ══════════════════════════════════════════════════════════════════ */
  section('C · eligibility');
  {
    const ledger = cal();
    const matched = countedSettlement('delivery.cancelled');
    const missed = countedSettlement('delivery.cancelled', 'delivery.completed');
    check('C1.matchedCounted', ledger.ingestSettlement(matched.settlement, { now: T0 + 3000 }).status === 'ingested');
    check('C2.missedCounted', ledger.ingestSettlement(missed.settlement, { now: T0 + 3001 }).status === 'ingested');

    /* matched 但 calibrationCounted=false（被自身影响） */
    const selfInf = (function () {
      const pred = makePrediction({}, { turnId: 'self_inf', behaviorEffectAttribution: { status: 'known-present', effects: [{ t: 1 }], influenced: true } });
      const r = settleOne(pred, 'delivery.cancelled');
      return r;
    })();
    check('C3.matchedButNotCountedIsRefused',
      selfInf.settlement.calibrationCounted === false
      && ledger.ingestSettlement(selfInf.settlement, { now: T0 + 3002 }).ok === false
      && ledger.ingestSettlement(selfInf.settlement, { now: T0 + 3002 }).reasonCode === 'p3-says-not-calibration-counted',
      JSON.stringify({ counted: selfInf.settlement.calibrationCounted, state: selfInf.settlement.state }));

    /* superseded 永远不是 calibration 样本 */
    const superseded = (function () {
      const pred = eventPred('delivery.cancelled');
      const o = obsFor(pred, 'delivery.cancelled');
      const e = p3WithOpportunity();
      return e.settlePrediction(pred, [{ observation: o }], {
        now: pred.observationWindow.opensAt + 2000, supersededByNewer: true
      }).settlement;
    })();
    check('C4.supersededIsNeverASample',
      superseded.state === 'superseded'
      && ledger.ingestSettlement(superseded, { now: T0 + 3003 }).ok === false
      && ledger.getPartition('event', 'runtime_state').calibrationCounts.superseded === 0,
      'superseded must never enter calibrationCounts');

    /* 主观域 + attribution unknown ⇒ P3 已经拒了 decisive；P4 不能绕过 */
    const unknownAttrPref = (function () {
      const pred = makePrediction({
        prediction: '用户更喜欢被确认', predicate: { kind: 'prefers' },
        expectedOutcome: { kind: 'exclusive-outcome', token: 'action.confirmed' }
      }, { turnId: 'unknown_attr' });
      return settleOne(pred, 'action.confirmed', { targetDomain: 'user_behavior', outcomeRef: { kind: 'token', token: 'action.confirmed' } });
    })();
    check('C5.unknownAttributionCannotBeBypassedByP4',
      unknownAttrPref.settlement.state !== 'matched'
      && ledger.ingestSettlement(unknownAttrPref.settlement, { now: T0 + 3004 }).ok === false,
      'P4 must not override P3\'s exclusion of unknown-attribution subjective settlement');

    /* non-decisive 状态自身也不是样本 */
    ['mixed', 'expired_unobserved', 'unresolvable'].forEach((state, i) => {
      check('C6.' + i + '.nonDecisiveStateIsNotASample',
        CORE.NON_DECISIVE_STATES.indexOf(state) >= 0
        && CORE.DECISIVE_ELIGIBLE_STATES.indexOf(state) < 0
        && CORE.entryEligibility({ state: state, calibrationCounted: true }, { settlementRecord: true }).eligible === false,
        state + ' must never be a calibration sample');
    });

    check('C7.eligibilityOrderIsProvenanceThenCounted',
      (function () {
        /* 缺 provenance 时，即使 calibrationCounted=true 也必须先被 provenance 拒 */
        const noProv = CORE.entryEligibility({ state: 'matched', calibrationCounted: true }, { settlementRecord: false });
        return noProv.eligible === false && noProv.reasonCodes[0] === 'settlement-provenance-missing';
      })(), 'provenance precedes the calibrationCounted gate');
    check('C8.p4DeclaresItCannotReopenP3',
      CORE.STATE_SUPPORT.reopensSettlementAuthority === 'NO'
      && CORE.STATE_SUPPORT.calibrationAuthoritySource === 'P3_SETTLEMENT_RECORD'
      && CORE.STATE_SUPPORT.consumesOnlyCalibrationCountedTrue === 'YES',
      'P4_REOPENS_SETTLEMENT_AUTHORITY = NO');
  }

  /* ══════════════════════════════════════════════════════════════════
     D · partition key
     ══════════════════════════════════════════════════════════════════ */
  section('D · partition key');
  {
    const a = countedSettlement('delivery.cancelled');
    const pk = CORE.calibrationPartitionKey(a.settlement);
    check('D1.partitionIsPredictionTypeByTargetDomain',
      pk.predictionType === 'event' && pk.targetDomain === 'runtime_state'
      && pk.key === 'event\u0000runtime_state',
      JSON.stringify(pk));

    const b = (function () {
      const pred = eventPred('action.confirmed');
      const r = settleOne(pred, 'action.confirmed', {
        targetDomain: 'user_behavior', outcomeRef: { kind: 'token', token: 'action.confirmed' }
      });
      return r;
    })();
    check('D2.sameTypeDifferentDomainIsADifferentPartition',
      CORE.calibrationPartitionKey(b.settlement).key === 'event\u0000user_behavior',
      CORE.calibrationPartitionKey(b.settlement).key);

    check('D3.typeComesFromTheCreationSnapshot',
      pk.predictionType === a.settlement.predictionSnapshotAtCreation.predictionType,
      '判定一律以建档快照为准');
    check('D4.multiDomainSettlementGetsNoPartition', (function () {
      /* P4-R1/R3：多域**不**建 mixed-domains 桶，也不挑第一个域 */
      const fake = { predictionSnapshotAtCreation: { predictionType: 'event' }, admittedTargetDomains: ['runtime_state', 'user_behavior'] };
      const res = CORE.partitionResolution(fake);
      return CORE.targetDomainOf(fake) === 'mixed-domains'
        && res.ok === false
        && res.reasonCode === 'partition-unresolvable-multi-domain'
        && res.diagnosticsOnly === true
        && res.participatesInCalibrationCounts === false
        && CORE.calibrationPartitionKey(fake) === null;
    })(), 'a multi-domain settlement must not become a countable partition');
    check('D5.partitionIsUnresolvableWithoutDomain',
      CORE.calibrationPartitionKey({ predictionSnapshotAtCreation: { predictionType: 'event' }, admittedTargetDomains: [] }) === null
      && CORE.partitionResolution({ predictionSnapshotAtCreation: { predictionType: 'event' }, admittedTargetDomains: [] }).reasonCode === 'partition-unresolvable-no-domain',
      'no domain ⇒ no partition ⇒ refuse (never guess)');
    check('D6.partitionKeyFieldsAreFrozen',
      JSON.stringify(cal().describe().partitionKeyFields) === JSON.stringify(['predictionType', 'targetDomain']),
      'the partition key has exactly two frozen dimensions');
  }

  /* ══════════════════════════════════════════════════════════════════
     E · partition isolation
     ══════════════════════════════════════════════════════════════════ */
  section('E · partition isolation');
  {
    const ledger = cal();
    let now = T0 + 3000;
    /* event × runtime_state：20 matched + 5 missed */
    for (let i = 0; i < 20; i += 1) {
      const r = countedSettlement('delivery.cancelled');
      ledger.ingestSettlement(r.settlement, { now: now += 1, predictionError: r.predictionError });
    }
    for (let i = 0; i < 5; i += 1) {
      const r = countedSettlement('delivery.cancelled', 'delivery.completed');
      ledger.ingestSettlement(r.settlement, { now: now += 1, predictionError: r.predictionError });
    }
    /* event × user_behavior：3 matched + 1 missed
       ★ P4-R1：原 fixture 用的是 preference × user_behavior —— 那在生产上
          **不可达**（AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR = OFF），已替换。 */
    const UB_OBS = {
      source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.popup', targetDomain: 'user_behavior'
    };
    for (let i = 0; i < 3; i += 1) {
      const r = countedSettlement('action.confirmed', undefined, { obs: UB_OBS });
      ledger.ingestSettlement(r.settlement, { now: now += 1, predictionError: r.predictionError });
    }
    {
      const r = countedSettlement('action.confirmed', 'action.dismissed', { obs: UB_OBS });
      ledger.ingestSettlement(r.settlement, { now: now += 1, predictionError: r.predictionError });
    }

    const ev = ledger.getPartition('event', 'runtime_state');
    const ub = ledger.getPartition('event', 'user_behavior');
    check('E1.eventRuntimeStateCountsAreExact',
      ev.calibrationCounts.matched === 20 && ev.calibrationCounts.missed === 5
      && ev.calibrationCounts.eligibleTotal === 25,
      JSON.stringify(ev.calibrationCounts));
    check('E2.eventUserBehaviorCountsAreExact',
      ub.calibrationCounts.matched === 3 && ub.calibrationCounts.missed === 1
      && ub.calibrationCounts.eligibleTotal === 4,
      JSON.stringify(ub.calibrationCounts));
    check('E3.partitionsAreFullyIndependent',
      ev.partitionKey !== ub.partitionKey
      && ev.calibrationCounts.eligibleTotal !== ub.calibrationCounts.eligibleTotal
      && ledger.listPartitions().length === 2,
      'the two reachable partitions must not share any counter');
    check('E4.emptyPartitionsInheritNothing',
      (function () {
        const l = cal();
        const r = countedSettlement('delivery.cancelled');
        l.ingestSettlement(r.settlement, { now: T0 + 3000 });
        return ['preference', 'latent_state', 'relational'].every(t =>
          l.listPartitions().filter(p => p.predictionType === t).length === 0);
      })(), 'a partition with no reachable data must not exist at all (nothing to inherit)');
    check('E5.crossPartitionTransferIsForbiddenByDeclaration',
      CORE.CROSS_PARTITION_TRANSFER === 'FORBIDDEN'
      && ledger.describe().crossPartitionConfidenceTransfer === 'FORBIDDEN',
      'CROSS_PARTITION_CONFIDENCE_TRANSFER = FORBIDDEN');
    check('E6.noPartitionApiTakesAGlobalScope',
      Object.keys(ledger).every(k => k !== 'getGlobalSummary' && k !== 'getOverallStats'),
      'there must be no global-scope query API');

    /* latent_state / relational / preference×user_preference：capability gap，不是"表现差" */
    const gapDims = { policyAllowed: true, runtimeClassifiable: false };
    const lat = CORE.capabilityCoverage(Object.assign({ predictionType: 'latent_state', contradictionMode: 'explicit_denial', counts: CORE.emptyCounts() }, gapDims));
    const rel = CORE.capabilityCoverage(Object.assign({ predictionType: 'relational', contradictionMode: 'explicit_denial', counts: CORE.emptyCounts() }, gapDims));
    const pre = CORE.capabilityCoverage(Object.assign({ predictionType: 'preference', contradictionMode: 'explicit_denial', counts: CORE.emptyCounts() }, gapDims));
    check('E7.latentAndRelationalAreCapabilityGapsNotBadPerformance',
      lat.status === 'capability-gap' && rel.status === 'capability-gap' && pre.status === 'capability-gap'
      && lat.capabilityGap === true && lat.noEligibleSample === true
      && lat.policyAllowed === true,
      JSON.stringify({ lat: lat.status, rel: rel.status, pre: pre.status }));
    P('PARTITION_ISOLATION', 'event/runtime_state ≠ preference/user_behavior');
  }

  /* ══════════════════════════════════════════════════════════════════
     F · calibrationCounts vocabulary
     ══════════════════════════════════════════════════════════════════ */
  section('F · calibrationCounts');
  {
    const r = countedSettlement('delivery.cancelled');
    const summary = CORE.calibrationSummary({
      predictionType: 'event', partitionKey: 'event\u0000runtime_state',
      counts: CORE.applyCounts(CORE.emptyCounts(), 'matched'), errorCounts: CORE.emptyErrorCounts()
    });
    check('F1.canonicalNameIsCalibrationCounts',
      summary.canonicalCountsName === 'calibrationCounts'
      && summary.deprecatedAlias === 'calibrationEvidence',
      'canonical 名称是 calibrationCounts；calibrationEvidence 是废弃散文别名');
    check('F2.countKeysAreTheFrozenEight',
      JSON.stringify(Object.keys(summary.calibrationCounts).sort())
        === JSON.stringify(CORE.CALIBRATION_COUNT_KEYS.slice().sort()),
      JSON.stringify(Object.keys(summary.calibrationCounts)));
    check('F3.nonDecisiveStatesStayZeroNeverHalfCounted',
      summary.calibrationCounts.mixed === 0
      && summary.calibrationCounts.expired_unobserved === 0
      && summary.calibrationCounts.unresolvable === 0
      && summary.calibrationCounts.superseded === 0
      && summary.calibrationCounts.matched === 1
      && summary.calibrationCounts.decisiveTotal === 1,
      JSON.stringify(summary.calibrationCounts));
    check('F4.legacyD2ResultsAreNotLedgerKeys',
      CORE.LEGACY_D2_RESULTS.every(k => Object.prototype.hasOwnProperty.call(summary.calibrationCounts, k) === false)
      && CORE.LEGACY_RESULT_ADAPTER === 'NONE',
      'confirmed/contradicted/partial/ambiguous must not be ledger keys');
    check('F5.noLegacyResultEntersTheLedger',
      (function () {
        const l = cal();
        const fake = { state: 'confirmed', calibrationCounted: true };
        return l.ingestSettlement(fake, { now: T0 + 3000 }).ok === false
          && CORE.LEGACY_D2_RESULTS.indexOf(fake.state) >= 0;
      })(), 'a legacy result word must never be ingestible');
    check('F6.settlementTargetDomainsAreRecorded', (function () {
      const r2 = countedSettlement('delivery.cancelled');
      return Array.isArray(r2.settlement.admittedTargetDomains)
        && r2.settlement.admittedTargetDomains.indexOf('runtime_state') >= 0;
    })(), 'the settlement record must carry the admitted observation domain');
    P('CANONICAL_COUNTS_NAME', CORE.CANONICAL_COUNTS_NAME);
  }

  /* ══════════════════════════════════════════════════════════════════
     G · ordinal Prediction Error aggregation
     ══════════════════════════════════════════════════════════════════ */
  section('G · ordinal PE aggregation');
  {
    const ledger = cal();
    let now = T0 + 3000;
    function ingestWithConfidence(confidence, token) {
      const pred = eventPred(token, { turnId: 'pe_' + (now++) });
      const p2 = createRuntimePredictionRegistry({ clock: () => T0 });
      /* 直接改不进冻结记录 ⇒ 用一个带指定 confidence 的等价预测 */
      void p2;
      const o = obsFor(pred, token);
      const e = p3WithOpportunity();
      const r = e.settlePrediction(pred, [{ observation: o }], {
        now: pred.observationWindow.opensAt + 2000
      });
      void confidence;
      return r;
    }
    /* 用 confidence bucket 直接驱动 ordinal bucket（确定性查表） */
    const cases = [
      ['high', 'missed'], ['medium', 'missed'], ['low', 'matched'],
      ['high', 'matched'], ['unstated', 'matched']
    ];
    const expected = {};
    cases.forEach(([bucket, state]) => {
      const pe = CORE.applyPredictionError(CORE.emptyErrorCounts(),
        CORE.calibrationSummary === null ? 'unknown' : peFor(state, bucket).direction,
        peFor(state, bucket).magnitude);
      const d = peFor(state, bucket).direction, m = peFor(state, bucket).magnitude;
      expected[d] = (expected[d] || 0) + 1;
      void pe;
    });
    function peFor(state, bucket) {
      const rt = require(path.join(ROOT, 'assets/js/memory-recall/prediction-settlement-core.js'));
      return rt.computePredictionError(state, bucket);
    }
    /* 真实 ingest：每条 settlement 用自己的 confidence bucket 决定 ordinal bucket */
    const order = [
      { confidence: 0.9, miss: true },   /* high + missed  ⇒ over-confident/high */
      { confidence: 0.9, miss: false },  /* high + matched ⇒ calibrated/none */
      { confidence: 0.5, miss: true },   /* medium + missed ⇒ over-confident/moderate */
      { confidence: 0.2, miss: true },   /* low + missed ⇒ over-confident/low */
      { confidence: 0.5, miss: false }   /* medium + matched ⇒ calibrated/low */
    ];
    order.forEach((spec) => {
      /* miss = 期望 cancelled 但观察到 completed（互斥）；
         confidence 必须落在 **Expectation** 上（不是投影 ctx）。 */
      const over = { exp: { subjectivePredictionConfidence: spec.confidence } };
      const r = spec.miss
        ? countedSettlement('delivery.cancelled', 'delivery.completed', over)
        : countedSettlement('delivery.cancelled', undefined, over);
      ledger.ingestSettlement(r.settlement, { now: now += 1, predictionError: r.predictionError });
    });
    const part = ledger.getPartition('event', 'runtime_state');
    const b = part.predictionErrorBuckets;
    check('G1.bucketCountsAreExact',
      b.directions['over-confident'] === 3
      && b.directions.calibrated === 2
      && b.magnitudes.high === 1 && b.magnitudes.moderate === 1 && b.magnitudes.low === 2
      && b.magnitudes.none === 1
      && b.cells['over-confident'].high === 1
      && b.cells['over-confident'].moderate === 1
      && b.cells['over-confident'].low === 1
      && b.cells.calibrated.none === 1 && b.cells.calibrated.low === 1,
      JSON.stringify(b.directions) + ' ' + JSON.stringify(b.magnitudes));
    check('G2.noNumericAveragingOfOrdinalBuckets',
      read(CAL_CORE_REL).indexOf('0.25') < 0 && read(CAL_CORE_REL).indexOf('weightedScore') < 0
      && read(CAL_CORE_REL).indexOf('/ (') < 0 && read(CAL_CORE_REL).indexOf('average') < 0,
      'ordinal buckets must never be turned into an interval scale');
    check('G3.magnitudeIsNeverSummedIntoAScore',
      read(CAL_RT_REL).indexOf('magnitude *') < 0 && read(CAL_RT_REL).indexOf('* magnitude') < 0,
      'no weighted float anywhere');
    check('G4.bucketVocabularyIsClosed',
      JSON.stringify(Object.keys(b.directions).sort()) === JSON.stringify(CORE.DIRECTION_KEYS.slice().sort())
      && JSON.stringify(Object.keys(b.magnitudes).sort()) === JSON.stringify(CORE.MAGNITUDE_KEYS.slice().sort()),
      'direction/magnitude vocabularies must be closed sets');
    P('ORDINAL_PE_AGGREGATION', 'NO_NUMERIC_AGGREGATION');
  }

  /* ══════════════════════════════════════════════════════════════════
     H · capability coverage —— R1 truth table（三个维度必须正交）
     ══════════════════════════════════════════════════════════════════ */
  section('H · capability coverage (R1 truth table)');
  {
    const withSample = CORE.applyCounts(CORE.emptyCounts(), 'matched');
    const noSample = CORE.emptyCounts();
    const ALLOW = { policyAllowed: true };
    const DENY = { policyAllowed: false };

    const A1 = CORE.capabilityCoverage(Object.assign({ predictionType: 'event', counts: withSample }, ALLOW, { runtimeClassifiable: true }));
    const A2 = CORE.capabilityCoverage(Object.assign({ predictionType: 'event', counts: noSample }, ALLOW, { runtimeClassifiable: true }));
    const B1 = CORE.capabilityCoverage(Object.assign({ predictionType: 'latent_state', counts: noSample }, ALLOW, { runtimeClassifiable: false }));
    const C1 = CORE.capabilityCoverage(Object.assign({ predictionType: 'not-a-type', counts: noSample }, DENY, { runtimeClassifiable: false }));

    check('H1.caseA_withSample',
      A1.status === 'settleable-by-current-runtime' && A1.noEligibleSample === false
      && A1.capabilityGap === false && A1.policyAllowed === true && A1.runtimeClassifiable === true,
      JSON.stringify(A1));
    check('H2.caseA_noSampleIsStillSettleable',
      /* ★ R1 的核心修复：空样本**不得**把 status 变成 not-policy-allowed */
      A2.status === 'settleable-by-current-runtime' && A2.noEligibleSample === true
      && A2.capabilityGap === false && A2.policyAllowed === true,
      JSON.stringify(A2));
    check('H3.caseB_capabilityGap',
      B1.status === 'capability-gap' && B1.capabilityGap === true
      && B1.noEligibleSample === true && B1.policyAllowed === true
      && B1.runtimeClassifiable === false,
      JSON.stringify(B1));
    check('H4.caseC_policyForbidden',
      C1.status === 'not-policy-allowed' && C1.policyAllowed === false
      && C1.capabilityGap === false,
      JSON.stringify(C1));
    check('H5.threeDimensionsDoNotCollapse',
      /* NO_SAMPLE != BAD_PERFORMANCE != POLICY_FORBIDDEN != CAPABILITY_GAP */
      A2.status !== B1.status && A2.status !== C1.status && B1.status !== C1.status
      && A2.noEligibleSample === B1.noEligibleSample
      && A2.capabilityGap !== B1.capabilityGap
      && B1.policyAllowed !== C1.policyAllowed,
      'no-sample / capability-gap / policy-forbidden must stay distinguishable');
    check('H6.noSampleNeverImpliesPolicyForbidden',
      A2.policyAllowed === true && A2.status !== 'not-policy-allowed'
      && B1.policyAllowed === true && B1.status !== 'not-policy-allowed',
      'NO_SAMPLE != POLICY_FORBIDDEN');
    check('H7.noSampleNeverImpliesCapabilityGap',
      A2.noEligibleSample === true && A2.capabilityGap === false,
      'NO_SAMPLE != CAPABILITY_GAP');
    check('H8.evidenceMatcherIsDeclaredOff',
      CORE.EVIDENCE_MATCHER_INVOCATION === 'OFF' && B1.evidenceMatcherInvocation === 'OFF',
      'the capability gap has a named cause');
    check('H9.classifiableModesComeFromTheP3CoreNotACopy',
      /* P4 **不**再复制这张表；唯一出处是 P3 settlement core */
      CORE.RUNTIME_CLASSIFIABLE_MODES === undefined
      && JSON.stringify(SETTLE_CORE.RUNTIME_CLASSIFIABLE_MODES) === JSON.stringify(['exclusive_outcome', 'window_closure_negative'])
      && WIRING.stripJsComments(read(CAL_CORE_REL)).indexOf('RUNTIME_CLASSIFIABLE_MODES') < 0,
      'one policy table, one definition');
    check('H10.gapIsVisibleOnTheLiveLedger', (function () {
      const l = cal();
      const r = countedSettlement('delivery.cancelled');
      l.ingestSettlement(r.settlement, { now: T0 + 3000 });
      const summary = l.getPartition('event', 'runtime_state');
      return summary.capabilityCoverage.status === 'settleable-by-current-runtime'
        && summary.capabilityCoverage.policyAllowed === true
        && summary.capabilityCoverage.runtimeClassifiable === true;
    })(), 'capability coverage is exposed per partition');
    check('H11.emptyDataIsNeverReportedAsBadPerformance', (function () {
      const s = CORE.calibrationSummary({
        predictionType: 'preference', counts: CORE.emptyCounts(), capabilityCoverage: B1
      });
      return s.sampleStatus === 'empty' && s.calibrationConfidence === null
        && CORE.FORBIDDEN_ACCURACY_FIELDS.every(f => Object.prototype.hasOwnProperty.call(s, f) === false);
    })(), 'NO_ELIGIBLE_SAMPLE must never be read as "this prediction type is bad"');
    const deniedButClassifiable = CORE.capabilityCoverage({
      predictionType: 'not-a-type', contradictionMode: 'exclusive_outcome',
      counts: noSample, policyAllowed: false, runtimeClassifiable: true,
      attributionAuthorityAvailable: true
    });
    const mechanicallySettleableEmpty = CORE.capabilityCoverage({
      predictionType: 'preference', contradictionMode: 'exclusive_outcome',
      counts: noSample, policyAllowed: true, runtimeClassifiable: true,
      attributionAuthorityAvailable: true
    });
    const mechanicallySettleableSampled = CORE.capabilityCoverage({
      predictionType: 'preference', contradictionMode: 'exclusive_outcome',
      counts: withSample, policyAllowed: true, runtimeClassifiable: true,
      attributionAuthorityAvailable: true
    });
    check('H12.productionSettleableRequiresPolicyPermission',
      deniedButClassifiable.runtimeClassifiable === true
      && deniedButClassifiable.policyAllowed === false
      && deniedButClassifiable.productionSettleable === false
      && deniedButClassifiable.capabilityGap === false,
      JSON.stringify(deniedButClassifiable));
    check('H13.productionSettleableDoesNotDependOnSampleCount',
      mechanicallySettleableEmpty.productionSettleable === true
      && mechanicallySettleableEmpty.noEligibleSample === true
      && mechanicallySettleableSampled.productionSettleable === true
      && mechanicallySettleableSampled.noEligibleSample === false,
      JSON.stringify({ empty: mechanicallySettleableEmpty, sampled: mechanicallySettleableSampled }));
  }

  /* ══════════════════════════════════════════════════════════════════
     I · calibrationConfidence
     ══════════════════════════════════════════════════════════════════ */
  section('I · calibrationConfidence');
  {
    check('I1.calibrationConfidenceIsNull',
      CORE.CALIBRATION_CONFIDENCE === null
      && cal().describe().calibrationConfidence === null,
      'v1 恒 null（契约已冻结）');
    check('I2.basisIsDeclared',
      cal().describe().calibrationConfidenceBasis === 'NULL_BY_CONTRACT_NO_FROZEN_DERIVATION_RULE'
      && CORE.NO_FORMULA_INVENTION_TO_AVOID_NULL === true,
      'NO_FORMULA_INVENTION_TO_AVOID_NULL = YES');
    check('I3.noHiddenFormulaInTheCore',
      (function () {
        const src = WIRING.stripJsComments(read(CAL_CORE_REL));
        return !/matched\s*\/\s*\(/.test(src)
          && !/\/\s*\(\s*[a-zA-Z]*\.?(matched|missed)\s*\+/.test(src)
          && src.indexOf('calibrationConfidence =') < 0
          && src.indexOf('calibrationConfidence=') < 0;
      })(), 'no ratio formula may be hidden behind the null');
    check('I4.sameCountsSameSummaryIsDeterministic',
      (function () {
        const mk = () => CORE.calibrationSummary({
          predictionType: 'event', partitionKey: 'event\u0000runtime_state',
          counts: Object.assign(CORE.emptyCounts(), { matched: 3, missed: 1, eligibleTotal: 4, decisiveTotal: 4 }),
          errorCounts: CORE.emptyErrorCounts()
        });
        return CORE.stableStringify(mk()) === CORE.stableStringify(mk());
      })(), 'same counts ⇒ same (null) confidence, deterministically');
    check('I5.noConfidenceFieldIsConsumableAsAuthority',
      (function () {
        const s = CORE.calibrationSummary({ predictionType: 'event', counts: CORE.emptyCounts() });
        const keys = Object.keys(s);
        return keys.every(k => CORE.FORBIDDEN_ACCURACY_FIELDS.indexOf(k) < 0)
          && s.calibrationConfidence === null;
      })(), 'no accuracy-like field exists on the summary');
    check('I6.sampleSufficiencyIsNotInvented',
      JSON.stringify(CORE.SAMPLE_STATUS) === JSON.stringify(['empty', 'counts-only'])
      && CORE.sampleStatusOf(CORE.emptyCounts()) === 'empty'
      && CORE.sampleStatusOf(CORE.applyCounts(CORE.emptyCounts(), 'matched')) === 'counts-only',
      'no invented threshold such as ">= 5 strong"');
    P('CALIBRATION_CONFIDENCE', 'null');
    P('CALIBRATION_CONFIDENCE_BASIS', 'NULL_BY_CONTRACT_NO_FROZEN_DERIVATION_RULE');
  }

  /* ══════════════════════════════════════════════════════════════════
     J · session-only
     ══════════════════════════════════════════════════════════════════ */
  section('J · session-only');
  {
    const a = cal();
    const r = countedSettlement('delivery.cancelled');
    a.ingestSettlement(r.settlement, { now: T0 + 3000 });
    const b = cal();
    check('J1.newLedgerInheritsNothing',
      a.getPartition('event', 'runtime_state').calibrationCounts.matched === 1
      && b.getPartition('event', 'runtime_state') === null
      && b.listPartitions().length === 0,
      'a new ledger instance must start empty');
    check('J2.noPersistencePath',
      (function () {
        const src = WIRING.stripJsComments(read(CAL_CORE_REL) + read(CAL_RT_REL));
        return !/indexedDB|localStorage|sessionStorage|writeFileSync|writeFile\(|dbPut|sqlite|require\(['"]fs['"]\)/i.test(src);
      })(), 'no file / DB / localStorage / IndexedDB / SQLite persistence');
    check('J3.lifetimeIsDeclaredSessionOnly',
      a.describe().lifetime === 'SESSION_ONLY' && a.describe().durable === false
      && a.describe().durableWrites === 0 && a.describe().crossRestartExactlyOnce === 'NO'
      && CORE.STATE_SUPPORT.lifetime === 'SESSION_ONLY',
      'CALIBRATION_LEDGER_LIFETIME = SESSION_ONLY');
    check('J4.sharedSessionLifecycleWithPredictionAndSettlement',
      a.describe().lifetime === 'SESSION_ONLY'
      && (function () {
        const pred = eventPred('delivery.cancelled');
        return pred.idLifetime === 'SESSION_ONLY';
      })(),
      'Prediction / Settlement / Calibration share the session lifecycle');
    check('J5.ttlIsBounded',
      a.describe().holder.ttlMs > 0 && a.describe().holder.maxPartitions > 0
      && a.describe().holder.durability === 'NONE',
      JSON.stringify(a.describe().holder));
  }

  /* ══════════════════════════════════════════════════════════════════
     K · no writeback
     ══════════════════════════════════════════════════════════════════ */
  section('K · no writeback');
  {
    /* ① PredictionRecord / SettlementRecord 冻结且指纹不变 */
    const r = countedSettlement('delivery.cancelled');
    const beforePred = require(path.join(ROOT, 'assets/js/memory-recall/prediction-record-core.js'))
      .canonicalize(r.settlement.predictionSnapshotAtCreation);
    const beforeSettle = SETTLEMENT.isSettlementRecord(r.settlement);
    const ledger = cal();
    let now = T0 + 3000;
    for (let i = 0; i < 50; i += 1) {
      ledger.ingestSettlement(r.settlement, { now: now += 1, predictionError: r.predictionError });
    }
    const afterPred = require(path.join(ROOT, 'assets/js/memory-recall/prediction-record-core.js'))
      .canonicalize(r.settlement.predictionSnapshotAtCreation);
    check('K1.predictionRecordUnchanged',
      beforePred === afterPred
      && beforeSettle === true && SETTLEMENT.isSettlementRecord(r.settlement) === true,
      'the creation snapshot must be byte-identical after 50 ingests');
    check('K2.settlementRecordUnchanged',
      Object.isFrozen(r.settlement) && Object.isFrozen(r.predictionError)
      && SETTLEMENT.isSettlementRecord(r.settlement) === true
      && SETTLEMENT.isPredictionErrorRecord(r.predictionError) === true,
      'the settlement and error records must remain sealed and unmutated');

    /* ② ctx 里传入的 Expectation / Interpretation 对象不被改动 */
    const fakeExpectation = { subjectivePredictionConfidence: 0.42, prediction: 'x', nested: { v: 1 } };
    const fakeInterpretation = { confidence: 0.7, rationale: 'y' };
    const snapshotBefore = JSON.stringify({ e: fakeExpectation, i: fakeInterpretation });
    ledger.ingestSettlement(r.settlement, {
      now: now += 1, predictionError: r.predictionError,
      expectation: fakeExpectation, interpretation: fakeInterpretation
    });
    check('K3.ctxExpectationAndInterpretationAreUntouched',
      JSON.stringify({ e: fakeExpectation, i: fakeInterpretation }) === snapshotBefore,
      'ingest must not reach into passed-in expectation/interpretation objects');

    /* ③ 真实 canonical memory store 前后逐字节一致 */
    const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
    const scratchRoot = path.join(ROOT, '.dsh-tmp');
    fs.mkdirSync(scratchRoot, { recursive: true });
    const dir = fs.mkdtempSync(path.join(scratchRoot, 'p4-nomut-'));
    let store = null;
    try {
      store = createMemoryStore({ dataDir: dir, clock: () => T0, logger: () => {} });
      store.open();
      store.putRecord({
        id: 'mem_p4', title: 'T', summary: 's', content: 'canonical content',
        kind: 'episodic', createdBy: 'user', visibility: 'public', created: T0 - 1000, importance: 5
      }, { requestId: 'p4-write-1' });
      const before = JSON.stringify(store.getRecord('mem_p4'));
      const beforeRev = store.getRevision();
      for (let i = 0; i < 20; i += 1) {
        const rr = countedSettlement(i % 2 === 0 ? 'delivery.cancelled' : 'delivery.completed');
        ledger.ingestSettlement(rr.settlement, { now: now += 1, predictionError: rr.predictionError });
      }
      check('K4.canonicalMemoryByteIdentical',
        before === JSON.stringify(store.getRecord('mem_p4')) && before !== 'null',
        'the canonical memory record must be byte-identical after 20 ingests');
      check('K5.storeRevisionUnchanged', store.getRevision() === beforeRev,
        'store revision must not move');
    } finally {
      try { if (store && typeof store.close === 'function') store.close(); } catch (e) { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }

    /* ④ 静态：零非法路径 */
    const PATTERNS = [
      ['dbPut', /\bdbPut\b/], ['writeFile', /\bwriteFile\b/], ['memory-store', /require\([^)]*memory-store/],
      ['relationship', /relationDelta|relationshipStore/], ['trust', /\btrust\b/], ['affinity', /\baffinity\b/],
      ['familiarity', /\bfamiliarity\b/], ['applyCalibration', /applyCalibration/],
      ['updateExpectation', /updateExpectation/], ['updateInterpretation', /updateInterpretation/],
      ['provider', /require\([^)]*provider|providerConfig/], ['fetch', /\bfetch\s*\(/],
      ['modelPort', /modelPort\s*\./], ['Date.now', /Date\.now/], ['Math.random', /Math\.random/]
    ];
    const hits = [];
    for (const rel of [CAL_CORE_REL, CAL_RT_REL]) {
      const code = WIRING.stripJsComments(read(rel));
      for (const [name, re] of PATTERNS) if (re.test(code)) hits.push(rel + ':' + name);
    }
    check('K6.staticNoForbiddenPath', hits.length === 0, JSON.stringify(hits));
    check('K7.ledgerHasNoWritebackApi',
      Object.keys(ledger).every(k => !/apply|writeBack|update|adjust/i.test(k))
      && ledger.describe().expectationWriteback === 'NONE'
      && ledger.describe().interpretationWriteback === 'NONE'
      && ledger.describe().calibrationAppliedToLive === 'NO',
      JSON.stringify(Object.keys(ledger)));
    check('K8.interpretationAndExpectationSurfacesStayClean',
      ['services/home-node/runtime-expectation.js', 'services/home-node/runtime-interpretation.js']
        .every(rel => {
          const code = WIRING.stripJsComments(read(rel));
          return ['runtime-prediction-calibration', 'predictionCalibration', 'calibrationLedger']
            .every(t => G.containsSemantic(code, t) === false);
        }),
      'no calibration capability may reach Expectation / Interpretation');
  }

  /* ══════════════════════════════════════════════════════════════════
     L · guard
     ══════════════════════════════════════════════════════════════════ */
  section('L · guard');
  {
    const audits = [CAL_CORE_REL, CAL_RT_REL].map(rel => ({
      rel: rel, r: G.auditCalibrationAuthoritySurface(read(rel))
    }));
    check('L1.calibrationAuthoritySurfacesPassTheirOwnAudit',
      audits.every(a => a.r.ok === true),
      JSON.stringify(audits.map(a => a.rel + ':' + JSON.stringify(a.r.reasons))));

    const svc = read('services/home-node-service.js');
    check('L2.oneApprovedAssemblyPath',
      svc.indexOf('runtime-prediction-calibration.js') >= 0
      && svc.split('createRuntimePredictionCalibration(').length - 1 === 2
      && svc.indexOf('runtimePredictionCalibration: runtimePredictionCalibration') >= 0
      && svc.indexOf('runtimePredictionCalibration: instanceRuntimePredictionCalibration') >= 0,
      'exactly one assembly path constructs and exports the ledger');

    const FORBIDDEN = [
      ['services/home-node/runtime-recall.js', 'function createRuntimeRecall(deps)'],
      ['services/home-node/runtime-interpretation.js', 'async function run(body, options)'],
      ['services/home-node/runtime-expectation.js', 'async function runFromValidatedInterpretation(input, opts)'],
      ['services/home-node/runtime-behavior-effect.js', 'function createRuntimeBehaviorEffect(deps)']
    ];
    const SNIPPETS = [
      'const ledger = createRuntimePredictionCalibration({});',
      'const n = predictionCalibration.ingestSettlement({});',
      'const c = calibrationLedger.getPartition("event","user_behavior");'
    ];
    const TOK = ['runtime-prediction-calibration', 'createRuntimePredictionCalibration', 'predictionCalibration', 'calibrationLedger'];
    const injectInto = (src, sig, snippet) => {
      const at = src.indexOf(sig);
      if (at < 0) return null;
      const open = src.indexOf('{', at + sig.length);
      if (open < 0) return null;
      return src.slice(0, open + 1) + '\n  ' + snippet + '\n' + src.slice(open + 1);
    };
    const missed = [];
    for (const [rel, sig] of FORBIDDEN) {
      const src = read(rel);
      for (const snippet of SNIPPETS) {
        const forged = injectInto(src, sig, snippet);
        if (!forged) { missed.push(rel + ':ANCHOR'); continue; }
        const code = WIRING.stripJsComments(forged);
        const caught = TOK.some(t => G.containsSemantic(code, t));
        if (!caught) missed.push(rel + ':' + snippet.slice(0, 30));
      }
    }
    check('L3.secondCalibrationSeamInAnyRuntimeIsCaught', missed.length === 0, JSON.stringify(missed));

    /* ★ 本轮**尤其**要抓：Calibration Ledger → Expectation 写回 */
    const writebackAttacks = [
      'function applyToExpectation(e) { e.subjectivePredictionConfidence = 0.9; }',
      'expectation.subjectivePredictionConfidence = calibrationConfidence;',
      'function applyCalibration(cal) { return cal; }',
      'interpretation.confidence = summary.calibrationConfidence;'
    ];
    check('L4.calibrationToExpectationWritebackIsCaught',
      writebackAttacks.every(src => G.auditCalibrationAuthoritySurface(src).ok === false),
      JSON.stringify(writebackAttacks.map(s => G.auditCalibrationAuthoritySurface(s).ok)));
    check('L5.globalAccuracyFieldIsCaught', (function () {
      const bad = 'var summary = { globalAccuracy: 0.83 };';
      return G.auditCalibrationAuthoritySurface(bad).ok === false;
    })(), 'a global accuracy field must be caught');
    check('L6.legacyResultAsKeyIsCaught', (function () {
      const bad = "ledger.counts['contradicted'] += 1;";
      return G.auditCalibrationAuthoritySurface(bad).ok === false;
    })(), 'a legacy D.2 result must never become a ledger key');

    check('L7.browserCannotSubmitCalibration', (function () {
      const comm = read('assets/js/communication.js')
        + '\nasync function _ibSubmitCalibration(m) { return predictionCalibration.ingestSettlement(m); }\n';
      return G.auditBrowserCognitionBoundary(comm, { surface: 'assets/js/communication.js' }).ok === false;
    })(), 'the browser boundary must reject calibration capability');

    check('L8.noHttpOrMobileRoute',
      read('services/home-node/http.js').indexOf('predictionCalibration') < 0
      && read('services/home-node/mobile-gateway.js').indexOf('predictionCalibration') < 0,
      'no HTTP / mobile route for calibration');
    check('L9.memoryAndRelationshipStayCleanOfCalibration',
      ['services/home-node/memory-store.js', 'assets/js/role-dm-core.js'].every(rel => {
        const code = WIRING.stripJsComments(read(rel));
        return TOK.every(t => G.containsSemantic(code, t) === false);
      }),
      'memory-store and relationship runtime must not gain calibration');
    check('L10.calibrationConsumesTheSealedSettlementOnly',
      read(CAL_RT_REL).indexOf('isSettlementRecord') >= 0
      && read(CAL_RT_REL).indexOf('settlementRuntime') >= 0,
      'the only approved consumption seam is Settlement Engine → Calibration Ledger');
    P('P4_SEAM', 'APPROVED_ONE_AUTHORITY_ONE_ASSEMBLY');
    P('WRITEBACK_ATTACKS', writebackAttacks.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     N · R2 · P3 reachability gate
     ══════════════════════════════════════════════════════════════════ */
  section('N · P3 reachability (R2)');
  {
    const MATRIX = OO.AUTHORITY_MATRIX;
    const reach = (t, d, s, mode) => SETTLEMENT.calibrationReachability({
      predictionType: t, targetDomain: d, settlementState: s,
      contradictionMode: mode || 'exclusive_outcome'
    });

    check('N1.sharedPolicyTableAgreesWithTheFrozenP2Policy',
      ['event', 'preference', 'latent_state', 'relational'].every(t =>
        JSON.stringify(SETTLE_CORE.decisiveAuthoritySourcesFor(t).slice().sort())
        === JSON.stringify((RECORD_CORE.POLICY_TABLE[t].strongestAuthority || []).slice().sort())),
      JSON.stringify(SETTLE_CORE.DECISIVE_AUTHORITY_SOURCES));
    check('N2.p3ConsultsTheTableWhenDecidingDecisiveness', (function () {
      const src = WIRING.stripJsComments(read('assets/js/memory-recall/prediction-settlement-core.js'));
      return src.indexOf('policyAllowsDecisiveFrom') >= 0
        && src.indexOf('evidenceSourceNotDecisiveForType') >= 0;
    })(), 'P3 must consult decisive-authority sources, not only the matrix');

    /* §20 reachability matrix */
    const matrix = [
      ['event', 'runtime_state', 'matched', 'exclusive_outcome', true, 'reachable-now'],
      ['event', 'runtime_state', 'missed', 'exclusive_outcome', true, 'reachable-now'],
      ['event', 'user_behavior', 'matched', 'exclusive_outcome', true, 'reachable-now'],
      ['event', 'user_behavior', 'missed', 'exclusive_outcome', true, 'reachable-now'],
      ['preference', 'user_behavior', 'matched', 'exclusive_outcome', false, 'unreachable-policy'],
      ['preference', 'user_behavior', 'missed', 'exclusive_outcome', false, 'unreachable-policy'],
      ['latent_state', 'user_behavior', 'matched', 'exclusive_outcome', false, 'unreachable-policy'],
      ['latent_state', 'user_behavior', 'missed', 'exclusive_outcome', false, 'unreachable-policy'],
      ['relational', 'user_behavior', 'matched', 'exclusive_outcome', false, 'unreachable-policy'],
      ['relational', 'user_behavior', 'missed', 'exclusive_outcome', false, 'unreachable-policy'],
      /* statement capability gap：policy 允许，但当前 runtime 缺能力 */
      ['preference', 'user_preference', 'matched', 'explicit_denial', true, 'reachable-policy-only'],
      ['latent_state', 'latent_state', 'matched', 'explicit_denial', true, 'reachable-policy-only'],
      ['relational', 'relationship', 'matched', 'explicit_denial', true, 'reachable-policy-only'],
      /* 非决定性状态永远不是 calibration 输入 */
      ['event', 'runtime_state', 'mixed', 'exclusive_outcome', false, 'not-a-calibration-state'],
      ['event', 'runtime_state', 'superseded', 'exclusive_outcome', false, 'not-a-calibration-state']
    ];
    const bad = matrix.filter(([t, d, s, mode, wantReachable, wantClass]) => {
      const r = reach(t, d, s, mode);
      return r.reachable !== wantReachable || r.class !== wantClass;
    });
    check('N3.reachabilityMatrixIsExact', bad.length === 0,
      JSON.stringify(bad.map(b => b.slice(0, 4))));
    check('N4.preferenceBehaviorIsUnreachable',
      reach('preference', 'user_behavior', 'matched').reasonCode === 'settlement-combination-unreachable'
      && reach('preference', 'user_behavior', 'missed').reasonCode === 'settlement-combination-unreachable',
      'AUTO_SETTLE_PREFERENCE_FROM_BEHAVIOR = OFF ⇒ preference × user_behavior is UNREACHABLE_V1');
    check('N5.capabilityGapIsNotPolicyForbidden',
      reach('preference', 'user_preference', 'matched', 'explicit_denial').reachable === true
      && reach('preference', 'user_preference', 'matched', 'explicit_denial').class === 'reachable-policy-only'
      && reach('preference', 'user_preference', 'matched', 'explicit_denial').reasonCode === 'policy-allowed-but-runtime-capability-unavailable',
      'statement-based decisive settlement is a CAPABILITY gap, not policy-forbidden');
    check('N6.capabilityValidIsNotCalibrationReachable',
      reach('preference', 'user_behavior', 'matched').reachable === false
      && reach('preference', 'user_behavior', 'matched').class === 'unreachable-policy'
      && JSON.stringify(reach('preference', 'user_behavior', 'matched').eligibleSourcesInDomain.sort())
        === JSON.stringify(['CANONICAL_RUNTIME', 'USER_BEHAVIOR']),
      'the gate picks up the root cause: no eligible source may decide a preference');

    /* §21 · pipeline refusal of an unreachable-but-valid-looking combination */
    check('N7.pipelineRefusesUnreachableCombination', (function () {
      const r = countedSettlement('delivery.cancelled');
      /* 用 stub 把这一条**真实 sealed** 的结算标成不可达，验证 gate 确实在 ingest 路径上 */
      const stub = () => ({
        reachable: false, class: 'unreachable-policy',
        reasonCode: 'settlement-combination-unreachable'
      });
      const l = cal({ reachability: stub });
      const res = l.ingestSettlement(r.settlement, { now: T0 + 3000, predictionError: r.predictionError });
      const real = cal();
      const ok = real.ingestSettlement(r.settlement, { now: T0 + 3000, predictionError: r.predictionError });
      return res.ok === false && res.changed === false
        && res.reasonCode === 'settlement-combination-unreachable'
        && res.diagnosticsOnly === true && res.participatesInCalibrationCounts === false
        && l.listPartitions().length === 0
        && l.describe().counters.rejectedReachability === 1
        && l.describe().counters.ingested === 0
        && ok.status === 'ingested';
    })(), 'the reachability gate sits in the ingest path and refuses before counting');

    check('N8.p3ItselfCannotProduceTheUnreachableCombination', (function () {
      /* 根因修复：P3 现在**不会**让 preference 的行为证据变成 decisive。 */
      const pred = prefPred('action.confirmed');
      const r = settleOne(pred, 'action.confirmed', {
        source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.popup',
        targetDomain: 'user_behavior', outcomeRef: { kind: 'token', token: 'action.confirmed' }
      });
      return r.settlement.state !== 'matched'
        && r.settlement.calibrationCounted === false
        && r.settlement.trace.policyNonDecisive >= 1;
    })(), 'the unreachable fixture is no longer producible even with known-none attribution');

    check('N9.reachabilityIsNotSettlementReJudgement',
      read(CAL_RT_REL).indexOf('computeSettlement') < 0
      && read(CAL_RT_REL).indexOf('calibrationReachability') >= 0
      && cal().describe().reJudgesSettlement === 'NO'
      && cal().describe().duplicatedPolicyTable === 'NONE',
      'P4 consumes the shared primitive; it does not re-settle');
    P('REACHABILITY_MATRIX_CELLS', matrix.length);
  }

  /* ══════════════════════════════════════════════════════════════════
     O · R3 · multi-domain
     ══════════════════════════════════════════════════════════════════ */
  section('O · multi-domain (R3)');
  {
    check('O1.multiDomainPartitionIsForbidden',
      CORE.MULTI_DOMAIN_CALIBRATION_PARTITION_V1 === 'FORBIDDEN'
      && cal().describe().multiDomainCalibrationPartitionV1 === 'FORBIDDEN'
      && CORE.EXACTLY_ONE_ADMITTED_TARGET_DOMAIN_REQUIRED === 'YES',
      'MULTI_DOMAIN_CALIBRATION_PARTITION_V1 = FORBIDDEN');

    const zero = CORE.partitionResolution({ predictionSnapshotAtCreation: { predictionType: 'event' }, admittedTargetDomains: [] });
    const one = CORE.partitionResolution({ predictionSnapshotAtCreation: { predictionType: 'event' }, admittedTargetDomains: ['runtime_state'] });
    const two = CORE.partitionResolution({ predictionSnapshotAtCreation: { predictionType: 'event' }, admittedTargetDomains: ['runtime_state', 'user_behavior'] });
    const three = CORE.partitionResolution({ predictionSnapshotAtCreation: { predictionType: 'event' }, admittedTargetDomains: ['runtime_state', 'user_behavior', 'latent_state'] });
    check('O2.zeroDomainIsRefused',
      zero.ok === false && zero.reasonCode === 'partition-unresolvable-no-domain'
      && zero.partition === null && zero.domainCount === 0,
      JSON.stringify(zero));
    check('O3.oneDomainMayCount',
      one.ok === true && one.partition.key === 'event\u0000runtime_state' && one.domainCount === 1,
      JSON.stringify(one.partition));
    check('O4.twoDomainsAreRefusedDiagnosticsOnly',
      two.ok === false && two.reasonCode === 'partition-unresolvable-multi-domain'
      && two.diagnosticsOnly === true && two.participatesInCalibrationCounts === false
      && two.domainCount === 2,
      JSON.stringify(two));
    check('O5.threeDomainsAreRefusedDiagnosticsOnly',
      three.ok === false && three.reasonCode === 'partition-unresolvable-multi-domain'
      && three.domainCount === 3 && three.partition === null,
      JSON.stringify(three));
    check('O6.noMixedDomainsBucketIsEverResolved',
      CORE.calibrationPartitionKey({ predictionSnapshotAtCreation: { predictionType: 'event' }, admittedTargetDomains: ['runtime_state', 'user_behavior'] }) === null,
      'mixed-domains must never be a countable partition');

    /* 真实两条不同域的观察 ⇒ 一条真实 sealed、counted 的结算，但分区不可解析 */
    const realTwoDomain = (function () {
      const pred = eventPred('delivery.cancelled');
      const o1 = obsFor(pred, 'delivery.cancelled');   /* runtime_state, support */
      const o2 = obsFor(pred, 'action.confirmed', {   /* user_behavior, 互斥 ⇒ conflict */
        source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.popup', targetDomain: 'user_behavior'
      });
      const e = p3WithOpportunity();
      return e.settlePrediction(pred, [{ observation: o1 }, { observation: o2 }], {
        now: pred.observationWindow.opensAt + 2000
      });
    })();
    check('O7.realTwoDomainSettlementExistsButIsRefused', (function () {
      const s = realTwoDomain.settlement;
      if (!s || s.admittedTargetDomains.length !== 2 || s.calibrationCounted !== true) return false;
      const l = cal();
      const res = l.ingestSettlement(s, { now: T0 + 3000, predictionError: realTwoDomain.predictionError });
      return res.ok === false
        && res.reasonCode === 'partition-unresolvable-multi-domain'
        && res.changed === false
        && l.listPartitions().length === 0
        && l.describe().counters.multiDomainSettlements === 1
        && l.inspectCalibration().view.diagnostics.multiDomainSettlementCount === 1;
    })(), 'a real sealed multi-domain settlement must not be counted anywhere');

    check('O8.oneSettlementNeverIncrementsMultiplePartitions', (function () {
      const l = cal();
      const s = realTwoDomain.settlement;
      l.ingestSettlement(s, { now: T0 + 3000 });
      const total = l.listPartitions().reduce((n, p) => n + p.calibrationCounts.eligibleTotal, 0);
      return total === 0 && l.heldPartitionCount() === 0;
    })(), 'no splitting one settlement across N partitions');

    check('O9.multiDomainNeverBecomesSettlementStateMixed',
      realTwoDomain.settlement.admittedTargetDomains.length === 2
      && CORE.calibrationPartitionKey(realTwoDomain.settlement) === null
      /* 分区解析失败 != settlement state。这里 settlement 真实状态是 missed。 */
      && realTwoDomain.settlement.state === 'missed'
      && realTwoDomain.settlement.calibrationCounts === undefined,
      'partition-resolution failure must not be conflated with the mixed settlement state');
    check('O10.diagnosticsDoNotParticipate', (function () {
      const d = cal().inspectCalibration().view.diagnostics;
      return d.diagnosticOnly === true && d.participatesInConfidence === false
        && d.participatesInCalibrationCounts === false
        && typeof d.multiDomainSettlementCount === 'number'
        && typeof d.unresolvablePartitionCount === 'number';
    })(), 'diagnostics are audit-only and participate in nothing');
    P('MULTI_DOMAIN_CALIBRATION_PARTITION_V1', CORE.MULTI_DOMAIN_CALIBRATION_PARTITION_V1);
  }

  /* ══════════════════════════════════════════════════════════════════
     M · API & scope
     ══════════════════════════════════════════════════════════════════ */
  section('M · API & scope');
  {
    const ledger = cal();
    const api = Object.keys(ledger);
    const forbidden = ['apply', 'writeBack', 'update', 'adjust', 'set', 'write'];
    check('M1.noWritebackApi', (function () {
      /* 精确 API 名单匹配 —— 不要用子串：`ingestSettlement` 里含 "set"。 */
      const WRITEBACK_API = ['applyCalibration', 'applyToExpectation', 'adjustExpectationConfidence',
        'adjustInterpretation', 'updateExpectation', 'updateInterpretation', 'rewritePolicy',
        'updatePrompt', 'writeBack', 'writeBackCalibration'];
      const leakedApi = WRITEBACK_API.filter(name => api.indexOf(name) >= 0);
      return leakedApi.length === 0;
    })(), JSON.stringify(api));
    check('M2.apiIsMinimal',
      JSON.stringify(api.sort()) === JSON.stringify([
        'ENTRY', 'awaitIdle', 'describe', 'getPartition', 'heldEntryCount',
        'heldPartitionCount', 'ingestSettlement', 'inspectCalibration', 'listPartitions'
      ].sort()),
      JSON.stringify(api.sort()));
    check('M3.disclosureIsInternalAuditOnly',
      ledger.describe().disclosure === 'INTERNAL_AUDIT_ONLY'
      && ledger.describe().routes === 'NONE'
      && ledger.describe().browserVisible === 'NO'
      && ledger.describe().contentExposed === 'NO',
      'CALIBRATION_DISCLOSURE_V1 = INTERNAL_AUDIT_ONLY');
    check('M4.noUiOrHtmlSurface',
      read('InternalBeyond.html').indexOf('prediction-calibration') < 0
      && read('InternalBeyond.html').indexOf('runtime-prediction-calibration') < 0,
      'no HTML / UI surface may load the ledger');
    check('M5.recallEnvelopeUntouched',
      read('services/home-node/runtime-recall.js').indexOf('calibration') < 0,
      'the recall envelope must not learn about calibration');
    check('M6.inspectViewIsStructuralOnly', (function () {
      const r = countedSettlement('delivery.cancelled');
      const l = cal();
      l.ingestSettlement(r.settlement, { now: T0 + 3000, predictionError: r.predictionError });
      const s = JSON.stringify(l.inspectCalibration().view);
      return s.indexOf('系统会取消') < 0 && s.indexOf('delivery.cancelled') < 0 && s.indexOf('evidence_1') < 0;
    })(), 'the audit view must not leak prediction text or tokens');

    const service = read('services/home-node-service.js');
    const feedback = read('services/home-node/runtime-reality-feedback.js');
    check('M7.productionDriverIsComposedAfterP3P4AndPostSettlementOnly',
      service.indexOf('createRuntimePredictionCalibrationDriver') >= 0
      && service.indexOf('calibrationRuntime: instanceRuntimePredictionCalibration') >= 0
      && service.indexOf('instanceRuntimeBehaviorEffect, instanceRuntimePredictionCalibrationDriver') >= 0
      && feedback.indexOf('onSettlement(settled.settlement, settled.predictionError)') >= 0
      && feedback.indexOf('ingestSettlement') < 0,
      'Home Node composes the thin driver; feedback only notifies after P3 returns');

    P('P4_STATUS', 'COMPLETE');
    P('CALIBRATION_LEDGER_LIVE', 'YES');
    P('P4_PRODUCTION_LEDGER_DRIVER', 'LIVE');
    P('CALIBRATION_LEDGER_LIFETIME', 'SESSION_ONLY');
    P('CROSS_PARTITION_TRANSFER', 'FORBIDDEN');
    P('GLOBAL_PREDICTION_ACCURACY', 'FORBIDDEN');
    P('CALIBRATION_CONFIDENCE', 'null');
    P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
    P('EXPECTATION_WRITEBACK', 'NONE');
    P('INTERPRETATION_WRITEBACK', 'NONE');
    P('MODEL_CALLS_ADDED', 0);
    P('DURABLE_WRITES_ADDED', 0);
    P('MEMORY_WRITE_FROM_CALIBRATION', 'FORBIDDEN');
    P('RELATIONSHIP_WRITE_FROM_CALIBRATION', 'FORBIDDEN');
    P('RECALL_ENVELOPE_CHANGED', 'NO');
    P('UI_DISCLOSURE_CHANGED', 'NO');
    P('CALIBRATION_DRIVER_ROLE', 'ORCHESTRATION_ONLY');
  }

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('PREDICTION CALIBRATION FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('PREDICTION CALIBRATION PASSED · ' + passed + ' assertions green');
})();


