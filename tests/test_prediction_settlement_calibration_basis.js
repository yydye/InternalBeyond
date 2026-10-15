'use strict';

/* P5-B3-J-R3 · Outcome-time calibration evidence basis.
 * Pure in-memory P1/P2/P3/P4-owner modules; no HTTP, model provider, app-data,
 * installed runtime, or Vault access.
 */

const { createRuntimeBehaviorEffect } = require('../services/home-node/runtime-behavior-effect.js');
const { createRuntimePredictionRegistry } = require('../services/home-node/runtime-prediction-registry.js');
const { createRuntimePredictionSettlement } = require('../services/home-node/runtime-prediction-settlement.js');
const { createRuntimePredictionCalibrationDriver } = require('../services/home-node/runtime-prediction-calibration-driver.js');
const OUTCOME = require('../assets/js/memory-recall/outcome-observation-core.js');

const T0 = 1760000000000;
const SCOPE = { characterId: 'j-r3-char', conversationId: 'dm:j-r3-char', subjectKind: 'user', subjectLabel: '' };
let passed = 0, failed = 0;

function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}

function ownerAt(clock) {
  return createRuntimeBehaviorEffect({ clock: clock, logger: function () {} });
}

function projectPrediction(attributionOwner, options) {
  const o = options || {};
  const at = o.at == null ? T0 : o.at;
  const turnId = o.turnId || 'turn-jr3';
  const registry = createRuntimePredictionRegistry({ clock: function () { return at; }, attributionAuthority: attributionOwner });
  const context = {
    now: at,
    characterId: SCOPE.characterId,
    conversationId: SCOPE.conversationId,
    turnId: turnId,
    expectationIndex: o.expectationIndex || 0
  };
  if (Object.prototype.hasOwnProperty.call(o, 'behaviorEffectAttribution')) {
    context.behaviorEffectAttribution = o.behaviorEffectAttribution;
  }
  const result = registry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction',
    prediction: 'The user will cancel the popup.',
    trigger: { kind: 'explicit-cue', label: 'popup shown' },
    evidenceMemoryIds: ['m-jr3'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: 'action.cancelled' }
  }, context);
  if (!result || result.ok !== true || !result.record) throw new Error('Prediction fixture failed: ' + JSON.stringify(result));
  return result.record;
}

function makeObservation(prediction, options) {
  const o = options || {};
  const intervention = Object.assign({
    behaviorEffectsInForce: [],
    predictionInfluencedSystem: false,
    contaminationClass: 'NONE',
    contaminationBasis: 'outcome-time-attribution:known-none:complete:NONE'
  }, o.interventionContext || {});
  const source = o.source || 'CANONICAL_RUNTIME';
  const sourceInstance = o.sourceInstance || 'runtime.popup';
  const targetDomain = o.targetDomain || 'user_behavior';
  const built = OUTCOME.buildOutcomeObservation({
    windowRef: {
      predictionId: prediction.predictionId,
      predictionCreatedAt: prediction.observationWindow.opensAt,
      opensAt: prediction.observationWindow.opensAt,
      closesAt: prediction.observationWindow.closesAt
    },
    source: source,
    sourceInstance: sourceInstance,
    targetDomain: targetDomain,
    observedAt: o.observedAt,
    completeness: 'point',
    scope: SCOPE,
    outcomeRef: { kind: 'token', token: o.token || 'action.cancelled' },
    evidenceRefs: ['evidence-jr3-' + String(o.observedAt)],
    interventionContext: intervention
  });
  if (!built || built.ok !== true) throw new Error('OutcomeObservation fixture failed: ' + JSON.stringify(built && built.errors));
  return built.value;
}

function opportunityAuthority(state, consumedAt) {
  const identities = new WeakSet();
  return {
    resolveForPrediction: function () {
      const required = state !== 'NOT-REQUIRED';
      const resolution = Object.freeze({
        state: state,
        opportunity: {
          required: required,
          existence: { present: state !== 'ABSENT', authoritySource: 'CANONICAL_RUNTIME' },
          consumedAt: state === 'SATISFIED' ? consumedAt : null
        }
      });
      identities.add(resolution);
      return resolution;
    },
    isResolution: function (value) { return identities.has(value); }
  };
}

function settle(prediction, observations, now, opportunityState) {
  const runtime = createRuntimePredictionSettlement({
    clock: function () { return now; },
    opportunityAuthority: opportunityAuthority(opportunityState || 'SATISFIED', prediction.observationWindow.opensAt + 500)
  });
  return { runtime: runtime, result: runtime.settlePrediction(prediction,
    observations.map(function (observation) { return { observation: observation }; }), { now: now }) };
}

function main() {
  /* Clean A independently proves matched; later UNKNOWN supporting B is not
     part of the decisive basis and must not poison the sample. */
  let now = T0;
  const externalOwner = ownerAt(function () { return now; });
  const predCleanAtCreation = projectPrediction(externalOwner, { turnId: 'turn-clean-a' });
  const cleanA = makeObservation(predCleanAtCreation, { observedAt: T0 + 1000, token: 'action.cancelled' });
  now = T0 + 1500;
  const registration = externalOwner.registerExternalInfluence({
    characterId: SCOPE.characterId, conversationId: SCOPE.conversationId,
    turnId: 'turn-clean-a', sourceKind: 'memory_behavior_modulation'
  });
  const unknownB = makeObservation(predCleanAtCreation, {
    observedAt: T0 + 2000,
    token: 'action.cancelled',
    interventionContext: {
      predictionInfluencedSystem: null,
      contaminationClass: 'UNKNOWN',
      contaminationBasis: 'outcome-time-attribution:unknown:partial:UNKNOWN'
    }
  });
  const cleanPlusUnknown = settle(predCleanAtCreation, [cleanA, unknownB], T0 + 3000);
  const cleanBasis = cleanPlusUnknown.result.settlement && cleanPlusUnknown.result.settlement.calibrationEvidenceBasis;
  const cleanInspection = cleanPlusUnknown.runtime.inspectSettlement(predCleanAtCreation.predictionId);
  check('J-R3-1.cleanDecisiveBasisSurvivesNonBasisUnknownSupport',
    registration.ok === true
      && cleanPlusUnknown.result.settlement.state === 'matched'
      && cleanPlusUnknown.result.settlement.calibrationCounted === true
      && cleanBasis.relation === 'support'
      && cleanBasis.requiredDecisiveCount === 1
      && cleanBasis.decisiveObservationIds.length === 1
      && cleanBasis.decisiveObservationIds[0] === cleanA.observationId
      && cleanBasis.cleanDecisiveObservationIds[0] === cleanA.observationId
      && cleanBasis.noOpposingEvidence === true
      && cleanPlusUnknown.result.settlement.trace.calibrationEvidenceBasis.reasonCode === 'calibration-counted'
      && cleanInspection.ok === true
      && cleanInspection.view.calibrationEvidenceBasis.cleanDecisiveObservationIds[0] === cleanA.observationId,
    { settlement: cleanPlusUnknown.result.settlement, basis: cleanBasis, inspection: cleanInspection });

  const replay = cleanPlusUnknown.runtime.settlePrediction(predCleanAtCreation,
    [{ observation: cleanA }, { observation: unknownB }], { now: T0 + 4000 });
  check('J-R3-2.replayReturnsIdenticalSealedBasis',
    replay.status === 'already-settled'
      && replay.settlement.calibrationEvidenceBasis.decisiveObservationIds.join('|')
        === cleanBasis.decisiveObservationIds.join('|')
      && replay.settlement.calibrationCounted === true);

  /* No independent clean basis: an outcome whose attribution is UNKNOWN is
     supporting at most and cannot produce a clean sample by itself. */
  now = T0 + 5000;
  const unknownOwner = ownerAt(function () { return now; });
  const unknownRegistration = unknownOwner.registerExternalInfluence({
    characterId: SCOPE.characterId, conversationId: SCOPE.conversationId,
    turnId: 'turn-unknown-only', sourceKind: 'memory_behavior_modulation'
  });
  const unknownPrediction = projectPrediction(unknownOwner, { at: now, turnId: 'turn-unknown-only', expectationIndex: 1 });
  const unknownOnly = makeObservation(unknownPrediction, {
    observedAt: now + 1000,
    interventionContext: {
      predictionInfluencedSystem: null,
      contaminationClass: 'UNKNOWN',
      contaminationBasis: 'outcome-time-attribution:unknown:partial:UNKNOWN'
    }
  });
  const unknownOnlyNow = unknownPrediction.observationWindow.closesAt + 1;
  const unknownOnlySettlement = settle(unknownPrediction, [unknownOnly], unknownOnlyNow);
  const unknownBasis = unknownOnlySettlement.result.settlement.calibrationEvidenceBasis;
  check('J-R3-3.unknownOnlyEvidenceCannotCreateCleanBasis',
    unknownRegistration.ok === true
      && unknownOnlySettlement.result.settlement.state === 'unresolvable'
      && unknownOnlySettlement.result.settlement.calibrationCounted === false
      && unknownBasis.cleanBasisAvailable === false,
    { state: unknownOnlySettlement.result.settlement.state, basis: unknownBasis });

  /* Outcome-time system influence can remain decisive for a mechanism/event
     fact; settlement continues, but the necessary evidence is not clean. */
  const eventOwner = ownerAt(function () { return T0; });
  const eventPrediction = projectPrediction(eventOwner, { turnId: 'turn-event-dirty', expectationIndex: 2 });
  const influencedSupport = makeObservation(eventPrediction, {
    observedAt: T0 + 1200,
    interventionContext: {
      behaviorEffectsInForce: [],
      predictionInfluencedSystem: true,
      downstreamOfSystemAction: true,
      contaminationClass: 'LIKELY',
      contaminationBasis: 'outcome-time-attribution:known-present:complete:LIKELY'
    }
  });
  const dirtyMatch = settle(eventPrediction, [influencedSupport], T0 + 3000);
  const dirtyBasis = dirtyMatch.result.settlement.calibrationEvidenceBasis;
  check('J-R3-4.influencedDecisiveSupportSettlesButCannotCalibrate',
    dirtyMatch.result.settlement.state === 'matched'
      && dirtyMatch.result.settlement.calibrationCounted === false
      && dirtyBasis.cleanBasisAvailable === false
      && dirtyBasis.reasonCode === 'decisive-evidence-system-influenced',
    { state: dirtyMatch.result.settlement.state, counted: dirtyMatch.result.settlement.calibrationCounted, basis: dirtyBasis });

  const alternativeBasisPrediction = projectPrediction(ownerAt(function () { return T0; }), {
    turnId: 'turn-alternative-basis', expectationIndex: 7
  });
  const cleanAlternative = makeObservation(alternativeBasisPrediction, { observedAt: T0 + 1250 });
  const influencedAlternative = makeObservation(alternativeBasisPrediction, {
    observedAt: T0 + 1260,
    interventionContext: {
      behaviorEffectsInForce: [],
      predictionInfluencedSystem: true,
      downstreamOfSystemAction: true,
      contaminationClass: 'LIKELY',
      contaminationBasis: 'outcome-time-attribution:known-present:complete:LIKELY'
    }
  });
  const alternativeOrderA = settle(alternativeBasisPrediction,
    [cleanAlternative, influencedAlternative], T0 + 3000).result.settlement.calibrationEvidenceBasis;
  const alternativeOrderB = settle(alternativeBasisPrediction,
    [influencedAlternative, cleanAlternative], T0 + 3000).result.settlement.calibrationEvidenceBasis;
  check('J-R3-4b.basisDoesNotDependOnObservationOrderOrPoisonCleanAlternative',
    alternativeOrderA.calibrationCounted === true && alternativeOrderB.calibrationCounted === true
      && alternativeOrderA.decisiveObservationIds.join('|') === alternativeOrderB.decisiveObservationIds.join('|')
      && alternativeOrderA.cleanDecisiveObservationIds.join('|') === cleanAlternative.observationId
      && alternativeOrderB.cleanDecisiveObservationIds.join('|') === cleanAlternative.observationId,
    { forward: alternativeOrderA, reversed: alternativeOrderB });

  const cleanConflictPrediction = projectPrediction(ownerAt(function () { return T0; }), {
    turnId: 'turn-clean-conflict', expectationIndex: 3
  });
  const cleanConflict = makeObservation(cleanConflictPrediction, {
    observedAt: T0 + 1300, token: 'action.confirmed'
  });
  const missed = settle(cleanConflictPrediction, [cleanConflict], T0 + 3000, 'SATISFIED');
  const missedBasis = missed.result.settlement.calibrationEvidenceBasis;
  check('J-R3-5.missedNeedsCleanDecisiveConflictAndSatisfiedOpportunity',
    missed.result.settlement.state === 'missed'
      && missed.result.settlement.calibrationCounted === true
      && missedBasis.relation === 'conflict'
      && missedBasis.opportunityStates.indexOf('SATISFIED') >= 0,
    { state: missed.result.settlement.state, basis: missedBasis });

  const dirtyConflictPrediction = projectPrediction(ownerAt(function () { return T0; }), {
    turnId: 'turn-dirty-conflict', expectationIndex: 4
  });
  const dirtyConflict = makeObservation(dirtyConflictPrediction, {
    observedAt: T0 + 1400,
    token: 'action.confirmed',
    interventionContext: {
      behaviorEffectsInForce: [],
      predictionInfluencedSystem: true,
      downstreamOfSystemAction: true,
      contaminationClass: 'LIKELY',
      contaminationBasis: 'outcome-time-attribution:known-present:complete:LIKELY'
    }
  });
  const dirtyMiss = settle(dirtyConflictPrediction, [dirtyConflict], T0 + 3000, 'SATISFIED');
  check('J-R3-6.dirtyDecisiveConflictKeepsMissedButExcludesCalibration',
    dirtyMiss.result.settlement.state === 'missed'
      && dirtyMiss.result.settlement.calibrationCounted === false
      && dirtyMiss.result.settlement.calibrationEvidenceBasis.reasonCode
        === 'decisive-evidence-system-influenced',
    { state: dirtyMiss.result.settlement.state, basis: dirtyMiss.result.settlement.calibrationEvidenceBasis });

  const createdInfluencedPrediction = projectPrediction(ownerAt(function () { return T0; }), {
    turnId: 'turn-created-influenced', expectationIndex: 5,
    behaviorEffectAttribution: {
      status: 'known-present', effects: [{ sourceTurn: 'turn-prior' }], influenced: true
    }
  });
  const createdInfluencedCleanObs = makeObservation(createdInfluencedPrediction, { observedAt: T0 + 1500 });
  const createdInfluencedResult = settle(createdInfluencedPrediction, [createdInfluencedCleanObs], T0 + 3000);
  check('J-R3-7.existingCreationSelfInfluenceVetoRemains',
    createdInfluencedResult.result.settlement.state === 'matched'
      && createdInfluencedResult.result.settlement.calibrationCounted === false
      && createdInfluencedResult.result.settlement.calibrationEvidenceBasis.reasonCode
        === 'prediction-creation-self-influenced');

  /* An irrelevant UNKNOWN observation is outside the basis and must not
     poison a separately sufficient clean decisive basis. */
  const irrelevantPrediction = projectPrediction(ownerAt(function () { return T0; }), {
    turnId: 'turn-irrelevant', expectationIndex: 6
  });
  const irrelevantClean = makeObservation(irrelevantPrediction, { observedAt: T0 + 1600 });
  const irrelevantUnknown = makeObservation(irrelevantPrediction, {
    observedAt: T0 + 1700,
    token: 'runtime.turn_terminal.started',
    sourceInstance: 'runtime.turn-execution',
    targetDomain: 'runtime_state',
    interventionContext: {
      behaviorEffectsInForce: [], predictionInfluencedSystem: null,
      contaminationClass: 'UNKNOWN',
      contaminationBasis: 'outcome-time-attribution:unknown:partial:UNKNOWN'
    }
  });
  const irrelevantResult = settle(irrelevantPrediction, [irrelevantClean, irrelevantUnknown], T0 + 3000);
  check('J-R3-8.irrelevantUnknownObservationIsNotInCalibrationBasis',
    irrelevantResult.result.settlement.state === 'matched'
      && irrelevantResult.result.settlement.calibrationCounted === true
      && irrelevantResult.result.settlement.trace.irrelevant === 1
      && irrelevantResult.result.settlement.calibrationEvidenceBasis.decisiveObservationIds.length === 1
      && irrelevantResult.result.settlement.calibrationEvidenceBasis.decisiveObservationIds[0] === irrelevantClean.observationId);

  let p4Ingests = 0;
  const driver = createRuntimePredictionCalibrationDriver({
    calibrationRuntime: {
      ingestSettlement: function () {
        p4Ingests += 1;
        return { ok: true, status: 'ingested', partitionKey: 'jr3', entryId: 'jr3-' + p4Ingests };
      }
    }
  });
  const p4Clean = driver.dispatchSettlement(missed.result.settlement, missed.result.predictionError);
  const p4Dirty = driver.dispatchSettlement(dirtyMiss.result.settlement, dirtyMiss.result.predictionError);
  check('J-R3-9.P4ConsumesOnlyTheSealedP3EligibilityDecision',
    p4Clean.status === 'ingested' && p4Dirty.status === 'skipped' && p4Ingests === 1);

  console.log('\nPREDICTION SETTLEMENT CALIBRATION BASIS · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main();
