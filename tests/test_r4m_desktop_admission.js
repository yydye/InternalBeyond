'use strict';

/*
 * P21-R4-M0-R2 · Desktop fail-closed calibration admission guard.
 * Pure in-memory modules only: no app-data, HTTP server, provider, or Vault.
 *
 * Cross-module guard for outcome-time evidence basis semantics. A clean
 * decisive basis survives later non-basis UNKNOWN support; an UNKNOWN-only
 * outcome cannot become a clean calibration sample. No app-data, HTTP server,
 * provider, or Vault is used.
 */

const behaviorEffectModule = require('../services/home-node/runtime-behavior-effect.js');
const { createRuntimePredictionRegistry } = require('../services/home-node/runtime-prediction-registry.js');
const { createRuntimePredictionSettlement } = require('../services/home-node/runtime-prediction-settlement.js');
const { createRuntimePredictionCalibrationDriver } = require('../services/home-node/runtime-prediction-calibration-driver.js');
const outcomeCore = require('../assets/js/memory-recall/outcome-observation-core.js');

const T0 = 1760000000000;
const scope = {
  characterId: 'r2-char', conversationId: 'dm:r2-char',
  subjectKind: 'user', subjectLabel: ''
};
let now = T0;
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('PASS ' + name);
  } else {
    failed += 1;
    console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : ''));
  }
}

function makeObservation(prediction, observedAt, contaminationClass) {
  const built = outcomeCore.buildOutcomeObservation({
    windowRef: {
      predictionId: prediction.predictionId,
      predictionCreatedAt: prediction.observationWindow.opensAt,
      opensAt: prediction.observationWindow.opensAt,
      closesAt: prediction.observationWindow.closesAt
    },
    source: 'CANONICAL_RUNTIME',
    sourceInstance: 'runtime.popup',
    targetDomain: 'user_behavior',
    observedAt: observedAt,
    completeness: 'point',
    scope: scope,
    outcomeRef: { kind: 'token', token: 'action.cancelled' },
    evidenceRefs: ['r2-evidence-' + observedAt],
    interventionContext: {
      behaviorEffectsInForce: [],
      predictionInfluencedSystem: null,
      contaminationClass: contaminationClass,
      contaminationBasis: 'R2 isolated admission guard'
    }
  });
  if (!built || built.ok !== true) throw new Error('fixture observation rejected: ' + JSON.stringify(built && built.errors));
  return built.value;
}

function main() {
  const attributionOwner = behaviorEffectModule.createRuntimeBehaviorEffect({
    clock: () => now,
    logger: () => {}
  });
  const registry = createRuntimePredictionRegistry({
    clock: () => now,
    attributionAuthority: attributionOwner
  });
  const projected = registry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction',
    prediction: 'The user will cancel the popup.',
    trigger: { kind: 'explicit-cue', label: 'popup shown' },
    evidenceMemoryIds: ['m-r2'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: 'action.cancelled' }
  }, {
    now: T0,
    characterId: scope.characterId,
    conversationId: scope.conversationId,
    turnId: 'turn-r2',
    expectationIndex: 0
  });
  const prediction = projected && projected.record;
  if (!prediction) throw new Error('prediction fixture did not project: ' + JSON.stringify(projected));
  check('R2-1.predictionWasCreatedBeforeInfluenceRegistration',
    prediction.behaviorEffectAttributionStatus === 'known-none',
    prediction.behaviorEffectAttributionStatus);

  const lateUnknownProjection = registry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction',
    prediction: 'The user will cancel the popup.',
    trigger: { kind: 'explicit-cue', label: 'popup shown' },
    evidenceMemoryIds: ['m-r2'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: 'action.cancelled' }
  }, {
    now: T0,
    characterId: scope.characterId,
    conversationId: scope.conversationId,
    turnId: 'turn-r2-late-unknown',
    expectationIndex: 1
  });
  const lateUnknownPrediction = lateUnknownProjection && lateUnknownProjection.record;
  if (!lateUnknownPrediction) throw new Error('late-unknown prediction did not project: ' + JSON.stringify(lateUnknownProjection));
  check('R2-1b.lateUnknownPredictionAlsoStartsKnownNone',
    lateUnknownPrediction.behaviorEffectAttributionStatus === 'known-none');

  /* One authoritative outcome precedes the new influence. A second one occurs
     after Desktop registers an influence that has no trusted consumption receipt. */
  const cleanObservation = makeObservation(prediction, T0 + 1000, 'NONE');
  now = T0 + 1500;
  const registered = attributionOwner.registerExternalInfluence({
    characterId: scope.characterId,
    conversationId: scope.conversationId,
    turnId: 'turn-r2',
    sourceKind: 'memory_behavior_modulation'
  });
  const unknownOnlyRegistration = attributionOwner.registerExternalInfluence({
    characterId: scope.characterId,
    conversationId: scope.conversationId,
    turnId: 'turn-r2-late-unknown',
    sourceKind: 'memory_behavior_modulation'
  });
  const unknownSnapshot = attributionOwner.snapshotBehaviorEffectAttribution({
    characterId: scope.characterId,
    conversationId: scope.conversationId,
    turnId: 'turn-r2',
    at: T0 + 2000
  });
  const unknownObservation = makeObservation(prediction, T0 + 2000, 'UNKNOWN');
  check('R2-2.registeredDesktopInfluenceWithoutReceiptIsUnknownPartial',
    registered.ok === true && unknownSnapshot.status === 'unknown'
      && unknownSnapshot.coverage === 'partial'
      && unknownObservation.interventionContext.contaminationClass === 'UNKNOWN',
    { registration: registered.status, snapshot: unknownSnapshot.status + '/' + unknownSnapshot.coverage });

  const opportunityIdentity = new WeakSet();
  const opportunityAuthority = {
    resolveForPrediction: function () {
      const resolution = Object.freeze({
        state: 'SATISFIED',
        opportunity: {
          required: true,
          existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' },
          consumedAt: T0 + 500
        }
      });
      opportunityIdentity.add(resolution);
      return resolution;
    },
    isResolution: function (resolution) { return opportunityIdentity.has(resolution); }
  };
  const settlementRuntime = createRuntimePredictionSettlement({
    clock: () => T0 + 3000,
    opportunityAuthority: opportunityAuthority
  });
  const settled = settlementRuntime.settlePrediction(prediction, [
    { observation: cleanObservation },
    { observation: unknownObservation }
  ], { now: T0 + 3000 });
  if (!settled || !settled.settlement) throw new Error('settlement fixture failed: ' + JSON.stringify(settled));

  const cleanBasis = settled.settlement.calibrationEvidenceBasis;
  check('R2-3.cleanDecisiveBasisSurvivesLaterUnknownSupportingEvidence',
    settled.settlement.state === 'matched'
      && settled.settlement.calibrationCounted === true
      && settled.predictionError.calibrationEligible === true
      && cleanBasis && cleanBasis.cleanBasisAvailable === true
      && cleanBasis.cleanDecisiveObservationIds.indexOf(cleanObservation.observationId) >= 0
      && cleanBasis.decisiveObservationIds.indexOf(unknownObservation.observationId) < 0,
    {
      state: settled.settlement.state,
      calibrationCounted: settled.settlement.calibrationCounted,
      predictionAttribution: prediction.behaviorEffectAttributionStatus,
      decisiveSupport: settled.settlement.trace.supportDecisive,
      nonDecisiveSupport: settled.settlement.trace.supportNonDecisive,
      basis: cleanBasis
    });

  let p4IngestCalls = 0;
  const calibrationDriver = createRuntimePredictionCalibrationDriver({
    calibrationRuntime: {
      ingestSettlement: function () {
        p4IngestCalls += 1;
        return { ok: true, status: 'ingested', partitionKey: 'test-partition', entryId: 'test-entry' };
      }
    }
  });
  const p4Result = calibrationDriver.dispatchSettlement(settled.settlement, settled.predictionError);
  check('R2-4.cleanBasisReachesP4WithoutP4Rejudgment',
    p4IngestCalls === 1 && p4Result.status === 'ingested',
    { ingestCalls: p4IngestCalls, driverStatus: p4Result.status });

  const unknownOnlyPrediction = lateUnknownPrediction;
  const unknownOnlyObservation = makeObservation(unknownOnlyPrediction, T0 + 2500, 'UNKNOWN');
  const unknownOnlySnapshot = attributionOwner.snapshotBehaviorEffectAttribution({
    characterId: scope.characterId,
    conversationId: scope.conversationId,
    turnId: 'turn-r2-late-unknown',
    at: T0 + 2500
  });
  const unknownOnlyOpportunityIdentity = new WeakSet();
  const unknownOnlyOpportunityAuthority = {
    resolveForPrediction: function () {
      const resolution = Object.freeze({
        state: 'SATISFIED',
        opportunity: {
          required: true,
          existence: { present: true, authoritySource: 'CANONICAL_RUNTIME' },
          consumedAt: T0 + 500
        }
      });
      unknownOnlyOpportunityIdentity.add(resolution);
      return resolution;
    },
    isResolution: function (resolution) { return unknownOnlyOpportunityIdentity.has(resolution); }
  };
  const unknownOnlySettlement = createRuntimePredictionSettlement({
    clock: () => unknownOnlyPrediction.observationWindow.closesAt + 1,
    opportunityAuthority: unknownOnlyOpportunityAuthority
  }).settlePrediction(unknownOnlyPrediction, [{ observation: unknownOnlyObservation }], {
    now: unknownOnlyPrediction.observationWindow.closesAt + 1
  });
  if (!unknownOnlySettlement || !unknownOnlySettlement.settlement) {
    throw new Error('unknown-only settlement fixture failed: ' + JSON.stringify(unknownOnlySettlement));
  }
  const unknownOnlyP4 = calibrationDriver.dispatchSettlement(
    unknownOnlySettlement.settlement, unknownOnlySettlement.predictionError);
  check('R2-5.unknownOnlyOutcomeHasNoCleanDecisiveBasis',
    unknownOnlyRegistration.ok === true
      && unknownOnlyPrediction.behaviorEffectAttributionStatus === 'known-none'
      && unknownOnlySnapshot.status === 'unknown' && unknownOnlySnapshot.coverage === 'partial'
      && unknownOnlySettlement.settlement.state === 'unresolvable'
      && unknownOnlySettlement.settlement.calibrationCounted === false
      && unknownOnlyP4.status === 'skipped'
      && p4IngestCalls === 1,
    {
      predictionAttribution: unknownOnlyPrediction.behaviorEffectAttributionStatus,
      settlementState: unknownOnlySettlement.settlement.state,
      calibrationCounted: unknownOnlySettlement.settlement.calibrationCounted,
      driverStatus: unknownOnlyP4.status,
      ingestCalls: p4IngestCalls
    });

  console.log('\nR4-M0-R2 DESKTOP ADMISSION · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main();
