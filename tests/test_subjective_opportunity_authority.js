'use strict';
/* P5-B3-I · canonical subjective opportunity authority
   Run: node tests/test_subjective_opportunity_authority.js */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { createRuntimeRealityEvent } = require(path.join(ROOT, 'services/home-node/runtime-reality-event.js'));
const { createRuntimeSubjectiveOpportunityAuthority } = require(path.join(ROOT, 'services/home-node/runtime-subjective-opportunity-authority.js'));
const { createExplicitPreferenceReportRealitySource } = require(path.join(ROOT, 'services/home-node/explicit-preference-report-reality-source.js'));
const { createRuntimeExplicitPreferenceReport } = require(path.join(ROOT, 'services/home-node/runtime-explicit-preference-report.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log('  PASS  ' + name); return; }
  failed += 1;
  console.error('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
};
const T0 = 1760000000000;
let now = T0;
let predictionSeq = 0;

function newAuthority(over) {
  const realityEventAuthority = createRuntimeRealityEvent(Object.assign({ maxHeldEvents: 64 }, over || {}));
  const reportProducer = createRuntimeExplicitPreferenceReport({ clock: () => now });
  const opportunityAuthority = createRuntimeSubjectiveOpportunityAuthority({
    realityEventAuthority: realityEventAuthority,
    reportAuthority: reportProducer,
    clock: () => now
  });
  const reportRealitySource = createExplicitPreferenceReportRealitySource({ realityEvent: realityEventAuthority });
  return { realityEventAuthority, opportunityAuthority, reportProducer, reportRealitySource };
}

function submitReport(authority, actionId, targetKey, stance, scope) {
  const s = scope || { characterId: 'char_a', conversationId: 'dm:char_a' };
  const minted = authority.reportProducer.submit({
    actionId: actionId,
    characterId: s.characterId,
    conversationId: s.conversationId,
    targetKey: targetKey,
    stance: stance
  });
  if (!minted || minted.ok !== true) return null;
  const emitted = authority.reportRealitySource.emit(minted.report);
  return emitted && emitted.ok === true ? emitted.realityEvent : null;
}

function prediction(token, scope, attribution) {
  predictionSeq += 1;
  const s = scope || { characterId: 'char_a', conversationId: 'dm:char_a' };
  const registry = createRuntimePredictionRegistry({ clock: () => now });
  const result = registry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction',
    prediction: 'user preference prediction',
    trigger: { kind: 'explicit-cue', label: 'preference-report' },
    evidenceMemoryIds: ['mem_1'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'prefers' },
    expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, {
    now: now,
    characterId: s.characterId,
    conversationId: s.conversationId,
    turnId: 'opp_turn_' + predictionSeq,
    expectationIndex: 0,
    behaviorEffectAttribution: attribution || { status: 'known-none', effects: [] }
  });
  return result && result.ok && result.settleable ? result.record : null;
}

function observation(pred, event, over) {
  const token = event && event.body ? 'pref.' + event.body.stance + '.' + event.body.targetKey : 'pref.dislike.scifi';
  const input = Object.assign({
    windowRef: {
      predictionId: pred.predictionId,
      predictionCreatedAt: pred.createdAt,
      opensAt: pred.observationWindow.opensAt,
      closesAt: pred.observationWindow.closesAt
    },
    source: 'EXPLICIT_USER_REPORT',
    sourceInstance: 'user.explicit-preference-report',
    targetDomain: 'user_preference',
    observedAt: event && event.occurredAt ? event.occurredAt : pred.createdAt + 1000,
    completeness: 'point',
    scope: event ? {
      characterId: event.characterId,
      conversationId: event.conversationId,
      subjectKind: 'user', subjectLabel: ''
    } : pred.scope,
    outcomeRef: { kind: 'token', token: token },
    evidenceRefs: [event ? event.realityEventId : 'forged-reality-event'],
    interventionContext: {
      behaviorEffectsInForce: [],
      predictionInfluencedSystem: false,
      contaminationClass: 'NONE',
      contaminationBasis: 'no behavior effect in force'
    }
  }, over || {});
  const built = OO.buildOutcomeObservation(input, {});
  return built && built.ok === true ? built.value : null;
}

function settle(authority, pred, obs, at) {
  const engine = createRuntimePredictionSettlement({
    clock: () => now,
    opportunityAuthority: authority.opportunityAuthority
  });
  return { engine, result: engine.settlePrediction(pred, obs ? [{ observation: obs }] : [], { now: at }) };
}

async function main() {
  console.log('\n── canonical report action witness ──');
  const authority = newAuthority();
  const p1 = prediction('pref.like.scifi');
  const p2 = prediction('pref.like.scifi');
  const pConflict = prediction('pref.like.scifi');
  const pWrongTarget = prediction('pref.like.coffee');
  const pWrongScope = prediction('pref.like.scifi', { characterId: 'char_b', conversationId: 'dm:char_b' });
  const pSupport = prediction('pref.like.scifi');
  const pForged = prediction('pref.like.scifi');
  const pContaminated = prediction('pref.like.scifi', null, {
    status: 'known-present',
    effects: [{ effectInstanceId: 'effect_1' }]
  });
  now = T0 + 1000;
  const conflictEvent = submitReport(authority, 'pref_action_conflict', 'scifi', 'dislike');
  const o1 = observation(p1, conflictEvent);
  const o2 = observation(p2, conflictEvent);
  const r1 = authority.opportunityAuthority.resolveForPrediction({ prediction: p1, observation: o1, now: now });
  const r2 = authority.opportunityAuthority.resolveForPrediction({ prediction: p2, observation: o2, now: now });
  check('A1.sealedSameTargetReportIsSatisfiedOpportunity',
    !!conflictEvent && authority.opportunityAuthority.isResolution(r1)
    && r1.state === 'SATISFIED' && r1.opportunity.consumedAt === conflictEvent.occurredAt
    && r1.targetKey === 'scifi', r1);
  check('A2.witnessIdentityIsPredictionIndependent',
    p1.predictionId !== p2.predictionId && r1.witnessId === r2.witnessId
    && r1.witnessId === conflictEvent.body.reportId
    && !Object.prototype.hasOwnProperty.call(r1, 'predictionId'),
    { p1: p1.predictionId, p2: p2.predictionId, witnessId: r1.witnessId });
  check('A3.reportStanceDoesNotCreateItsOwnOpportunity',
    r1.state === 'SATISFIED' && r1.reasonCode === 'canonical-preference-choice-observed'
    && r1.witnessId === conflictEvent.body.reportId,
    'resolution uses sealed event identity and exact target/scope; it does not inspect relation');

  console.log('\n── P3 support and conflict ──');
  now = T0 + 2000;
  const supportEvent = submitReport(authority, 'pref_action_support', 'scifi', 'like');
  const supportObs = observation(pSupport, supportEvent);
  const support = settle(authority, pSupport, supportObs, now);
  check('B1.sameStanceRemainsMatched',
    support.result.ok === true && support.result.settlement.state === 'matched'
    && support.result.settlement.opportunityState === 'SATISFIED'
    && support.result.settlement.calibrationCounted === true,
    support.result.settlement && { state: support.result.settlement.state, opportunity: support.result.settlement.opportunityState });

  const conflictObs = observation(pConflict, conflictEvent);
  const conflict = settle(authority, pConflict, conflictObs, now);
  check('B2.oppositeSameTargetCanMissThroughP3',
    conflict.result.ok === true && conflict.result.settlement.state === 'missed'
    && conflict.result.settlement.opportunityState === 'SATISFIED'
    && conflict.result.settlement.conflictSummary.decisive === 1
    && conflict.result.settlement.calibrationCounted === true,
    conflict.result.settlement && { state: conflict.result.settlement.state, opportunity: conflict.result.settlement.opportunityState,
      decisive: conflict.result.settlement.conflictSummary.decisive, calibrationCounted: conflict.result.settlement.calibrationCounted });
  check('B3.P3RefusesCallerOpportunityInjection',
    conflict.engine.describe().callerOpportunityInjection === 'FORBIDDEN'
    && conflict.engine.describe().feedbackDriverMaySupplyOpportunity === 'NO', conflict.engine.describe());

  console.log('\n── target and scope boundaries ──');
  const wrongTargetObs = observation(pWrongTarget, conflictEvent);
  const wrongTarget = settle(authority, pWrongTarget, wrongTargetObs, now);
  check('C1.wrongTargetCannotSettleMissed',
    wrongTarget.result.ok === true && wrongTarget.result.settlement.state !== 'missed'
    && wrongTarget.result.settlement.conflictSummary.decisive === 0
    && wrongTarget.result.settlement.trace.irrelevant >= 1,
    wrongTarget.result.settlement && { state: wrongTarget.result.settlement.state, trace: wrongTarget.result.settlement.trace });

  const wrongScopeObs = observation(pWrongScope, conflictEvent);
  const wrongScope = settle(authority, pWrongScope, wrongScopeObs, now);
  check('C2.wrongScopeCannotSettleMissed',
    wrongScope.result.ok === true && wrongScope.result.settlement.state !== 'missed'
    && wrongScope.result.settlement.conflictSummary.decisive === 0
    && wrongScope.result.settlement.gateTraceRefs.some(g => g.opportunityGate !== 'SATISFIED'),
    wrongScope.result.settlement && { state: wrongScope.result.settlement.state, gates: wrongScope.result.settlement.gateTraceRefs });

  console.log('\n── forged event and no report ──');
  const emptyAuthority = newAuthority();
  const forgedMint = emptyAuthority.realityEventAuthority.ingest({
    sourceId: 'user-explicit-preference-report',
    sourceEvent: {
      eventId: 'explicit_preference_report:forged', domain: 'user_preference', type: 'preference_report',
      entityId: 'forged_report', timestamp: now, characterId: 'char_a', conversationId: 'dm:char_a',
      body: { targetKey: 'scifi', stance: 'dislike', reportId: 'forged_report' }
    }
  });
  const fakeEvent = forgedMint && forgedMint.realityEvent;
  const fakeObs = observation(pForged, fakeEvent);
  const forgedResolution = emptyAuthority.opportunityAuthority.resolveForPrediction({ prediction: pForged, observation: fakeObs, now: now });
  const forged = settle(emptyAuthority, pForged, fakeObs, now);
  check('D1.forgedRealityEventCannotSatisfyOpportunity',
    forgedMint && forgedMint.status === 'minted'
    && emptyAuthority.realityEventAuthority.isRealityEvent(fakeEvent) === true
    && forgedResolution.state !== 'SATISFIED' && forged.result.ok === true
    && forged.result.settlement.state !== 'missed',
    { realityEventSealed: emptyAuthority.realityEventAuthority.isRealityEvent(fakeEvent),
      resolution: forgedResolution.state, settlement: forged.result.settlement && forged.result.settlement.state });

  const pNoReport = prediction('pref.like.no_report_target');
  const atClose = pNoReport.observationWindow.closesAt + 1;
  const beforeClose = emptyAuthority.opportunityAuthority.resolveForPrediction({ prediction: pNoReport, now: pNoReport.observationWindow.closesAt - 1 });
  const noReport = settle(emptyAuthority, pNoReport, null, atClose);
  check('D2.noReportStaysUnknownUntilWindowCloses', beforeClose.state === 'UNKNOWN', beforeClose);
  check('D3.noReportExpiresUnobservedNeverMissed',
    noReport.result.ok === true && noReport.result.settlement.state === 'expired_unobserved'
    && noReport.result.settlement.opportunityState === 'ABSENT'
    && noReport.result.settlement.conflictSummary.decisive === 0,
    noReport.result.settlement && { state: noReport.result.settlement.state, opportunity: noReport.result.settlement.opportunityState });

  const reportOnlyAuthority = newAuthority();
  const pReportWithoutReality = prediction('pref.like.report_only');
  now = T0 + 4000;
  const accepted = reportOnlyAuthority.reportProducer.submit({
    actionId: 'pref_action_report_without_reality',
    characterId: 'char_a', conversationId: 'dm:char_a', targetKey: 'report_only', stance: 'dislike'
  });
  const unavailableRealitySource = createExplicitPreferenceReportRealitySource({ realityEvent: null });
  const failedReality = unavailableRealitySource.emit(accepted.report);
  const reportOnlyAtClose = reportOnlyAuthority.opportunityAuthority.resolveForPrediction({
    prediction: pReportWithoutReality, now: pReportWithoutReality.observationWindow.closesAt + 1
  });
  const noObservationSettlement = settle(reportOnlyAuthority, pReportWithoutReality, null,
    pReportWithoutReality.observationWindow.closesAt + 1);
  check('D4.realityMintFailureDoesNotEraseAcceptedChoiceOrInventEvidence',
    accepted.ok === true && failedReality.ok === false
    && reportOnlyAtClose.state === 'SATISFIED'
    && noObservationSettlement.result.settlement.state === 'unresolvable'
    && noObservationSettlement.result.settlement.state !== 'missed',
    { reportAccepted: accepted.ok, reality: failedReality.status, opportunity: reportOnlyAtClose.state,
      settlement: noObservationSettlement.result.settlement && noObservationSettlement.result.settlement.state });

  console.log('\n── BehaviorEffect contamination and replay ──');
  const contaminatedObs = observation(pContaminated, conflictEvent, {
    interventionContext: {
      behaviorEffectsInForce: [{ sourceTurn: 'turn_before_report', stance: 'supportive' }],
      predictionInfluencedSystem: true,
      downstreamOfSystemAction: true,
      contaminationClass: 'LIKELY',
      contaminationBasis: 'report followed an in-force BehaviorEffect'
    }
  });
  const contaminated = settle(authority, pContaminated, contaminatedObs, now);
  check('E1.opportunityDoesNotRemoveBehaviorEffectContamination',
    contaminated.result.ok === true && contaminated.result.settlement.state !== 'missed'
    && contaminated.result.settlement.opportunityState === 'SATISFIED'
    && contaminated.result.settlement.calibrationCounted === false,
    contaminated.result.settlement && { state: contaminated.result.settlement.state,
      opportunity: contaminated.result.settlement.opportunityState, calibrationCounted: contaminated.result.settlement.calibrationCounted });

  const beforeReplayCount = authority.realityEventAuthority.heldEventCount();
  const duplicateReport = authority.reportProducer.submit({
    actionId: 'pref_action_conflict', characterId: 'char_a', conversationId: 'dm:char_a', targetKey: 'scifi', stance: 'dislike'
  });
  const duplicateEvent = authority.reportRealitySource.emit(duplicateReport.report);
  check('E2.reportReplayReusesOneCanonicalRealityEvent',
    duplicateReport.status === 'duplicate' && duplicateEvent.status === 'duplicate'
    && duplicateEvent.realityEvent.realityEventId === conflictEvent.realityEventId
    && authority.realityEventAuthority.heldEventCount() === beforeReplayCount,
    { report: duplicateReport.status, event: duplicateEvent.status, held: authority.realityEventAuthority.heldEventCount() });
  const replaySettlement = conflict.engine.settlePrediction(pConflict, [{ observation: conflictObs }], { now: now + 1 });
  check('E3.replayCannotRewriteTheP3Settlement',
    replaySettlement.status === 'already-settled' && replaySettlement.settlement.state === 'missed'
    && conflict.engine.getSettlement(pConflict.predictionId).state === 'missed',
    replaySettlement.settlement && replaySettlement.settlement.state);

  check('F1.matcherMemoryAndRelationshipRemainOff',
    conflict.engine.describe().memoryAuthority === 'NONE'
    && conflict.engine.describe().relationshipAuthority === 'NONE'
    && conflict.engine.describe().modelCalls === 0,
    conflict.engine.describe());

  console.log('\nRESULT ' + (failed ? 'FAIL' : 'PASS') + ' · ' + passed + ' passed · ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
