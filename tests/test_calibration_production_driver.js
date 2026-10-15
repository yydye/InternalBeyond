'use strict';
/* P5-B3-J · P3 → P4 production calibration driver
   Run: node tests/test_calibration_production_driver.js */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const CAL_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-calibration-core.js'));
const RECORD_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-record-core.js'));
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const P3_MODULE = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = P3_MODULE;
const { createRuntimePredictionCalibration } = require(path.join(ROOT, 'services/home-node/runtime-prediction-calibration.js'));
const { createRuntimePredictionCalibrationDriver } = require(path.join(ROOT, 'services/home-node/runtime-prediction-calibration-driver.js'));

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log('  PASS  ' + name); return; }
  failed += 1;
  console.error('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
};
const T0 = 1760000000000;
let turnSeq = 0;
const SCOPE = { characterId: 'char_a', conversationId: 'dm:char_a' };
const registry = createRuntimePredictionRegistry({ clock: () => T0 });
const p3 = createRuntimePredictionSettlement({ clock: () => T0 });
const p4 = createRuntimePredictionCalibration({
  settlementRuntime: Object.assign({}, P3_MODULE, p3),
  clock: () => T0,
  matcherState: () => ({ present: true, enabled: false })
});
const driver = createRuntimePredictionCalibrationDriver({ settlementRuntime: p3, calibrationRuntime: p4 });

function prediction(type, token, attribution) {
  turnSeq += 1;
  const isPreference = type === 'preference';
  const expectation = {
    epistemicStatus: 'prediction',
    prediction: isPreference ? 'user preference' : 'delivery outcome',
    trigger: { kind: 'explicit-cue', label: 'calibration-driver-test' },
    evidenceMemoryIds: ['mem_1'], contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.8,
    subject: isPreference ? { kind: 'user', label: '' } : { kind: 'character-self', label: '' },
    predicate: isPreference ? { kind: 'prefers' } : { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: token }
  };
  const context = {
    now: T0, characterId: SCOPE.characterId, conversationId: SCOPE.conversationId,
    turnId: 'cal_turn_' + turnSeq, expectationIndex: 0
  };
  if (attribution) context.behaviorEffectAttribution = attribution;
  const projected = registry.projectFromValidatedExpectation(expectation, context);
  return projected && projected.ok && projected.settleable ? projected.record : null;
}

function observation(pred, token, options) {
  const o = options || {};
  const isPreference = o.targetDomain === 'user_preference';
  const result = OO.buildOutcomeObservation({
    windowRef: {
      predictionId: pred.predictionId,
      predictionCreatedAt: pred.createdAt,
      opensAt: pred.observationWindow.opensAt,
      closesAt: pred.observationWindow.closesAt
    },
    source: o.source || (isPreference ? 'EXPLICIT_USER_REPORT' : 'CANONICAL_RUNTIME'),
    sourceInstance: o.sourceInstance || (isPreference ? 'user.explicit-preference-report' : 'runtime.delivery'),
    targetDomain: isPreference ? 'user_preference' : 'runtime_state',
    observedAt: pred.createdAt + 1000,
    completeness: 'point', scope: pred.scope,
    outcomeRef: { kind: 'token', token: token },
    evidenceRefs: ['unit_evidence_' + pred.predictionId],
    interventionContext: o.interventionContext || {
      behaviorEffectsInForce: [], predictionInfluencedSystem: false,
      contaminationClass: 'NONE', contaminationBasis: 'no behavior effect in force'
    }
  }, {});
  return result && result.ok ? result.value : null;
}

function settle(pred, obs, context) {
  return p3.settlePrediction(pred, obs ? [{ observation: obs }] : [], Object.assign({ now: T0 + 2000 }, context || {}));
}

function main() {
  console.log('\n── automatic P3 → P4 pass-through ──');
  const matchedPred = prediction('preference', 'pref.like.scifi', { status: 'known-none', effects: [] });
  const matched = settle(matchedPred, observation(matchedPred, 'pref.like.scifi', { targetDomain: 'user_preference' }));
  const accepted = driver.dispatchSettlement(matched.settlement, matched.predictionError);
  const preference = p4.getPartition('preference', 'user_preference');
  check('A1.canonicalMatchedRecordIngestsAutomaticallyAtTheDriverBoundary',
    matched.settlement.state === 'matched' && matched.settlement.calibrationCounted === true
    && accepted.status === 'ingested' && preference.calibrationCounts.matched === 1
    && preference.calibrationCounts.eligibleTotal === 1,
    { state: matched.settlement.state, counted: matched.settlement.calibrationCounted,
      ingest: accepted.status, counts: preference && preference.calibrationCounts });
  check('A2.P4PartitionsByExistingTypeAndDomain',
    preference.partitionKey === 'preference\u0000user_preference'
    && preference.calibrationConfidence === null
    && p4.describe().partitionKeyFields.join(',') === 'predictionType,targetDomain',
    preference);
  check('A3.productionSettleableFailsClosedWithoutAttributionAuthority',
    preference.capabilityCoverage.policyAllowed === true
    && preference.capabilityCoverage.runtimeClassifiable === true
    && preference.capabilityCoverage.attributionAuthorityAvailable === false
    && preference.capabilityCoverage.productionSettleable === false
    && preference.capabilityCoverage.noEligibleSample === false,
    preference.capabilityCoverage);

  console.log('\n── replay and multiple partitions ──');
  const replay = [];
  for (let i = 0; i < 100; i += 1) replay.push(driver.dispatchSettlement(matched.settlement, matched.predictionError));
  check('B1.oneSettlementIsCountedOnceAcross100DriverReplays',
    replay.every(r => r.status === 'duplicate')
    && p4.getPartition('preference', 'user_preference').calibrationCounts.matched === 1
    && p4.describe().counters.duplicates === 100,
    { sampleCount: p4.getPartition('preference', 'user_preference').calibrationCounts.eligibleTotal,
      duplicates: p4.describe().counters.duplicates });

  const secondPred = prediction('preference', 'pref.like.scifi', { status: 'known-none', effects: [] });
  const second = settle(secondPred, observation(secondPred, 'pref.like.scifi', { targetDomain: 'user_preference' }));
  driver.dispatchSettlement(second.settlement, second.predictionError);
  const eventPred = prediction('event', 'delivery.cancelled');
  const eventResult = settle(eventPred, observation(eventPred, 'delivery.cancelled'));
  const eventIngest = driver.dispatchSettlement(eventResult.settlement, eventResult.predictionError);
  check('B2.distinctSettlementsKeepDistinctP4SamplesAndPartitions',
    eventResult.settlement.state === 'matched' && eventIngest.status === 'ingested'
    && p4.getPartition('preference', 'user_preference').calibrationCounts.eligibleTotal === 2
    && p4.getPartition('event', 'runtime_state').calibrationCounts.eligibleTotal === 1
    && p4.listPartitions().length === 2,
    { preference: p4.getPartition('preference', 'user_preference').calibrationCounts,
      event: p4.getPartition('event', 'runtime_state').calibrationCounts });
  const relationalPartition = CAL_CORE.partitionResolution({
    predictionSnapshotAtCreation: { predictionType: 'relational' }, admittedTargetDomains: ['relationship']
  });
  check('B3.relationalPartitionShapeRemainsFrozenWithoutOpeningProductionSamples',
    relationalPartition.ok === true && relationalPartition.partition.key === 'relational\u0000relationship'
    && p4.listPartitions().every(p => p.predictionType !== 'relational'), relationalPartition);

  console.log('\n── P3 non-counted records never call P4 ──');
  const attemptsBeforeSkips = p4.describe().counters.attempts;
  const nonCounted = [];
  const pendingPred = prediction('preference', 'pref.like.pending');
  nonCounted.push(settle(pendingPred, observation(pendingPred, 'pref.like.pending', { targetDomain: 'user_preference' })).settlement);
  const selfInfluencedPred = prediction('preference', 'pref.like.self', {
    status: 'known-present', effects: [{ effectInstanceId: 'be_self_1' }]
  });
  nonCounted.push(settle(selfInfluencedPred,
    observation(selfInfluencedPred, 'pref.like.self', { targetDomain: 'user_preference' })).settlement);

  const mixedPred = prediction('preference', 'pref.like.mixed', { status: 'known-none', effects: [] });
  const mixedSupport = observation(mixedPred, 'pref.like.mixed', { targetDomain: 'user_preference' });
  const mixedConflict = observation(mixedPred, 'pref.dislike.mixed', {
    targetDomain: 'user_preference',
    interventionContext: {
      behaviorEffectsInForce: [{ sourceTurn: 'prior_turn', stance: 'supportive' }],
      predictionInfluencedSystem: false,
      contaminationClass: 'POSSIBLE',
      contaminationBasis: 'possible BehaviorEffect influence'
    }
  });
  /* The test runtime holds both P1 capabilities, while a test-scoped authority
     only supplies the completed-choice primitive needed by this P3 policy case. */
  const p3Mixed = createRuntimePredictionSettlement({
    clock: () => T0,
    opportunityAuthority: (function () {
      const identity = new WeakSet();
      return {
        resolveForPrediction: () => {
          const result = Object.freeze({ state: 'SATISFIED', opportunity: {
            required: true, existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' }, consumedAt: T0 + 500
          } });
          identity.add(result);
          return result;
        },
        isResolution: r => !!r && identity.has(r)
      };
    })()
  });
  const mixedRecord = p3Mixed.settlePrediction(mixedPred, [
    { observation: mixedSupport }, { observation: mixedConflict }
  ], { now: T0 + 2000 }).settlement;
  nonCounted.push(mixedRecord);

  const expiredPred = prediction('preference', 'pref.like.expired');
  const absentIdentity = new WeakSet();
  const absentRuntime = createRuntimePredictionSettlement({
    clock: () => T0,
    opportunityAuthority: {
      resolveForPrediction: () => {
        const result = Object.freeze({ state: 'ABSENT', opportunity: {
          required: true, existence: { present: false, authoritySource: 'CANONICAL_RUNTIME' }
        } });
        absentIdentity.add(result);
        return result;
      },
      isResolution: r => !!r && absentIdentity.has(r)
    }
  });
  nonCounted.push(absentRuntime.settlePrediction(expiredPred, [], {
    now: expiredPred.observationWindow.closesAt + 1
  }).settlement);
  const unresolvablePred = prediction('preference', 'pref.like.unresolvable');
  const unresolvableObs = observation(unresolvablePred, 'pref.like.unresolvable', {
    targetDomain: 'user_preference', source: 'LINGUISTIC_EVIDENCE', sourceInstance: 'chat.user-utterance'
  });
  const noOpportunityRuntime = createRuntimePredictionSettlement({ clock: () => T0 });
  nonCounted.push(noOpportunityRuntime.settlePrediction(unresolvablePred, [{ observation: unresolvableObs }], {
    now: unresolvablePred.observationWindow.closesAt + 1
  }).settlement);
  const supersededPred = prediction('preference', 'pref.like.superseded', { status: 'known-none', effects: [] });
  nonCounted.push(noOpportunityRuntime.settlePrediction(supersededPred, [], {
    now: T0 + 2000, supersededByNewer: true
  }).settlement);

  const skipResults = nonCounted.map(s => driver.dispatchSettlement(s, null));
  check('C1.pendingSelfInfluencedMixedExpiredUnresolvableAndSupersededAreSkipped',
    nonCounted.every(s => s && s.calibrationCounted === false)
    && nonCounted[1].interventionSummary.selfInfluenced === true
    && skipResults.every(r => r.ok === true && r.status === 'skipped')
    && p4.describe().counters.attempts === attemptsBeforeSkips,
    { states: nonCounted.map(s => s && s.state), attemptsBefore: attemptsBeforeSkips,
      attemptsAfter: p4.describe().counters.attempts });

  console.log('\n── provenance and failure isolation ──');
  const attemptsBeforeForgery = p4.describe().counters.attempts;
  const forged = driver.dispatchSettlement({ state: 'matched', calibrationCounted: true }, matched.predictionError);
  check('D1.plainSettlementCannotEnterP4', forged.status === 'rejected'
    && forged.reasonCode === 'settlement-not-sealed-by-p3'
    && p4.describe().counters.attempts === attemptsBeforeForgery, forged);
  const forgedError = driver.dispatchSettlement(matched.settlement, Object.assign({}, matched.predictionError));
  check('D2.plainPredictionErrorCannotEnterP4', forgedError.status === 'rejected'
    && forgedError.reasonCode === 'prediction-error-not-sealed-by-p3'
    && p4.describe().counters.attempts === attemptsBeforeForgery, forgedError);

  const failingDriver = createRuntimePredictionCalibrationDriver({
    settlementRuntime: p3,
    calibrationRuntime: { ingestSettlement: () => { throw new Error('test ledger failure'); } }
  });
  const ledgerFailure = failingDriver.dispatchSettlement(matched.settlement, matched.predictionError);
  check('D3.ledgerFailureLeavesP3SettlementSealedAndReadable',
    ledgerFailure.status === 'failed' && P3_MODULE.isSettlementRecord(matched.settlement) === true
    && p3.getSettlement(matched.settlement.predictionId).settlementId === matched.settlement.settlementId,
    ledgerFailure);
  check('D4.liveApplicationAndWritesRemainDisabled',
    p4.describe().calibrationConfidence === null
    && p4.describe().calibrationAppliedToLive === 'NO'
    && p4.describe().expectationWriteback === 'NONE'
    && p4.describe().interpretationWriteback === 'NONE'
    && p4.describe().memoryAuthority === 'NONE'
    && p4.describe().relationshipAuthority === 'NONE', p4.describe());
  check('D5.driverDoesNotRejudgeOrOwnP4Policy',
    driver.describe().rejudgesSettlement === 'NO'
    && driver.describe().ownsPartitioning === 'NO'
    && driver.describe().ownsDedupe === 'NO'
    && driver.describe().p4LedgerAuthority === 'YES', driver.describe());

  console.log('\nRESULT ' + (failed ? 'FAIL' : 'PASS') + ' · ' + passed + ' passed · ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main();
