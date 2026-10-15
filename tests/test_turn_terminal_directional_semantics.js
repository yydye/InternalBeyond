'use strict';
/* P5-B3-D5 · prediction-specific TurnTerminal relation and production path */

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const P3_CORE = require(path.join(ROOT, 'assets/js/memory-recall/prediction-settlement-core.js'));
const SETTLEMENT_MODULE = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
const { createRuntimePredictionSettlement } = SETTLEMENT_MODULE;
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const { createRuntimeBehaviorEffect } = require(path.join(ROOT, 'services/home-node/runtime-behavior-effect.js'));
const { createRuntimeRealityEvent } = require(path.join(ROOT, 'services/home-node/runtime-reality-event.js'));
const { createTurnTerminalRealitySource } = require(path.join(ROOT, 'services/home-node/turn-terminal-reality-source.js'));
const { createRuntimeOutcomeObservation } = require(path.join(ROOT, 'services/home-node/runtime-outcome-observation.js'));
const { createRuntimeRealityFeedback } = require(path.join(ROOT, 'services/home-node/runtime-reality-feedback.js'));
const { createRuntimeSubjectiveOpportunityAuthority } = require(path.join(ROOT, 'services/home-node/runtime-subjective-opportunity-authority.js'));
const { createRuntimeEventOpportunityAuthority } = require(path.join(ROOT, 'services/home-node/runtime-event-opportunity-authority.js'));
const { createRuntimeOpportunityAuthority } = require(path.join(ROOT, 'services/home-node/runtime-opportunity-authority.js'));
const { createRuntimePredictionCalibration } = require(path.join(ROOT, 'services/home-node/runtime-prediction-calibration.js'));
const { createRuntimePredictionCalibrationDriver } = require(path.join(ROOT, 'services/home-node/runtime-prediction-calibration-driver.js'));

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log('  PASS  ' + name); return; }
  failed += 1;
  console.error('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
};
const section = text => console.log('\n── ' + text + ' ──');
const P = (key, value) => console.log('  FACTS ' + key + ' = ' + value);
const T0 = 1760000000000;
const CLOSE = T0 + 86400000;
const CHAR = 'char_a';
const CONVERSATION = 'dm:char_a';
const TURN_TOKEN = code => 'runtime.turn_terminal.' + code;

const L3 = {
  ok: true,
  status: 'succeeded',
  recordSource: 'D5_CANONICAL_TEST',
  interpretation: { ok: true, items: [{ memoryId: 'm1', appraisal: 'positive' }] }
};
const L5 = { ok: true, status: 'created' };

function terminal(over) {
  return Object.freeze(Object.assign({
    turnId: 'turn_d5',
    characterId: CHAR,
    conversationId: CONVERSATION,
    requestCorrelationId: 'req_d5',
    outcome: 'completed',
    occurredAt: T0 + 1000
  }, over || {}));
}

function buildWorld(predictionSpecs, options) {
  const o = options || {};
  let now = T0;
  const clock = () => now;
  const logger = () => {};
  const behaviorEffect = createRuntimeBehaviorEffect({ clock: clock, logger: logger });
  if (o.effectInForce === true) {
    behaviorEffect.deriveAndHold({
      characterId: CHAR,
      conversationId: CONVERSATION,
      turnId: 'turn_behavior_basis',
      interpretationValidated: true,
      interpretationResult: L3,
      expectationHeld: true,
      expectation: L5
    });
  }
  const registry = createRuntimePredictionRegistry({
    clock: clock,
    logger: logger,
    attributionAuthority: behaviorEffect
  });
  const predictions = (predictionSpecs || []).map(function (spec, index) {
    const s = spec || {};
    const result = registry.projectFromValidatedExpectation({
      epistemicStatus: 'prediction',
      prediction: 'this execution turn will reach a specific terminal outcome',
      trigger: { kind: 'explicit-cue', label: 'D5 canonical event fixture' },
      evidenceMemoryIds: ['m1'],
      contradictoryEvidenceIds: [],
      generalizationLevel: 'episode-hypothesis',
      subjectivePredictionConfidence: 0.8,
      subject: { kind: 'user', label: '' },
      predicate: { kind: 'will-do' },
      expectedOutcome: { kind: 'exclusive-outcome', token: s.expectedToken || TURN_TOKEN('completed') }
    }, {
      now: T0,
      characterId: s.characterId || CHAR,
      conversationId: s.conversationId || CONVERSATION,
      turnId: s.turnId || 'turn_d5',
      expectationIndex: s.expectationIndex == null ? index : s.expectationIndex
    });
    return result && result.ok === true ? result.record : null;
  });

  let feedback = null;
  const realityEvent = createRuntimeRealityEvent({
    logger: logger,
    onRealityEventMinted: function (event) {
      if (feedback) feedback.onRealityEventMinted(event);
    }
  });
  const observation = createRuntimeOutcomeObservation({
    registry: registry,
    isRealityEvent: realityEvent.isRealityEvent,
    attributionAuthority: behaviorEffect,
    logger: logger
  });
  const subjectiveOpportunityAuthority = createRuntimeSubjectiveOpportunityAuthority({ clock: clock });
  const eventOpportunityAuthority = createRuntimeEventOpportunityAuthority({
    realityEventAuthority: realityEvent,
    clock: clock
  });
  const opportunityAuthority = createRuntimeOpportunityAuthority({
    eventAuthority: eventOpportunityAuthority,
    subjectiveAuthority: subjectiveOpportunityAuthority
  });
  const settlement = createRuntimePredictionSettlement({
    clock: clock,
    logger: logger,
    opportunityAuthority: opportunityAuthority
    /* R1 routes terminal event opportunities to their own fact-only authority. */
  });
  const calibration = createRuntimePredictionCalibration({
    settlementRuntime: Object.assign({}, SETTLEMENT_MODULE, settlement),
    clock: clock,
    logger: logger,
    attributionAuthority: behaviorEffect,
    matcherState: () => ({ present: true, enabled: false })
  });
  const calibrationDriver = createRuntimePredictionCalibrationDriver({
    settlementRuntime: settlement,
    calibrationRuntime: calibration,
    logger: logger
  });
  feedback = createRuntimeRealityFeedback({
    registry: registry,
    observationRuntime: observation,
    settlementRuntime: settlement,
    isRealityEvent: realityEvent.isRealityEvent,
    clock: clock,
    onSettlement: (record, pe) => calibrationDriver.dispatchSettlement(record, pe),
    logger: logger
  });
  const source = createTurnTerminalRealitySource({ realityEvent: realityEvent, logger: logger });

  return {
    setNow: function (value) { now = value; },
    behaviorEffect: behaviorEffect,
    registry: registry,
    predictions: predictions,
    realityEvent: realityEvent,
    source: source,
    observation: observation,
    opportunityAuthority: opportunityAuthority,
    eventOpportunityAuthority: eventOpportunityAuthority,
    subjectiveOpportunityAuthority: subjectiveOpportunityAuthority,
    settlement: settlement,
    calibration: calibration,
    calibrationDriver: calibrationDriver,
    feedback: feedback
  };
}

function refOf(record) {
  return {
    predictionId: record.predictionId,
    opensAt: record.observationWindow.opensAt,
    closesAt: record.observationWindow.closesAt,
    predictionCreatedAt: record.createdAt
  };
}

(function main() {
  console.log('\n── canonical terminal taxonomy ──');
  const outcomes = [
    'completed', 'credential-unavailable', 'empty-output', 'store-write-failed',
    'abort', 'timeout', 'cancelled', 'provider-error'
  ];
  check('A1.directionalOutcomeCodesAreExistingExecutionOutcomes',
    JSON.stringify(OO.DIRECTIONAL_TURN_TERMINAL_OUTCOME_CODES) === JSON.stringify(outcomes)
    && OO.RUNTIME_STATE_TOKENS.indexOf('runtime.turn_terminal') >= 0
    && outcomes.every(code => OO.RUNTIME_STATE_TOKENS.indexOf(TURN_TOKEN(code)) >= 0),
    OO.DIRECTIONAL_TURN_TERMINAL_OUTCOME_CODES);
  check('A2.openExecutionPassthroughDoesNotBecomeAConflictingToken',
    OO.turnTerminalTokenOfOutcomeCode('unknown') === null
    && OO.turnTerminalTokenOfOutcomeCode('provider-specific-kind') === null
    && OO.turnTerminalOutcomeCodeOfToken(TURN_TOKEN('unknown')) === null
    && OO.turnTerminalOutcomeCodeOfToken(TURN_TOKEN('provider-specific-kind')) === null
    && OO.isTurnTerminalTokenFamily(TURN_TOKEN('provider-specific-kind')) === true);
  check('A3.onlyRecognizedOutcomesAreMutuallyExclusiveWithinTheTurnFamily', (function () {
    for (let i = 0; i < outcomes.length; i += 1) {
      for (let j = 0; j < outcomes.length; j += 1) {
        const prediction = {
          predictionType: 'event', contradictionMode: 'exclusive_outcome',
          predictionSnapshotAtCreation: { semanticPayload: { expectedOutcome: { token: TURN_TOKEN(outcomes[i]) } } }
        };
        const observation = {
          source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.turn-execution', targetDomain: 'runtime_state',
          outcomeRef: { kind: 'token', token: TURN_TOKEN(outcomes[j]) }
        };
        const expectedRelation = i === j ? 'support' : 'conflict';
        if (P3_CORE.classifyRelation(prediction, observation) !== expectedRelation) return false;
      }
    }
    return true;
  })(), { recognizedOutcomeCount: outcomes.length, relationCells: outcomes.length * outcomes.length });
  check('A4.otherRuntimeOutcomeFamilyIsIrrelevant', P3_CORE.classifyRelation({
    predictionType: 'event', contradictionMode: 'exclusive_outcome',
    predictionSnapshotAtCreation: { semanticPayload: { expectedOutcome: { token: 'delivery.completed' } } }
  }, {
    source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.turn-execution', targetDomain: 'runtime_state',
    outcomeRef: { kind: 'token', token: TURN_TOKEN('completed') }
  }) === 'irrelevant');

  console.log('\n── proposition-specific relation ──');
  {
    const support = buildWorld([{ expectedToken: TURN_TOKEN('completed') }]);
    const supportRecord = support.predictions[0];
    support.setNow(T0 + 2000);
    const supportEvent = support.source.emit(terminal());
    const supportProjection = support.observation.projectForPrediction({
      realityEvent: supportEvent.realityEvent,
      predictionRef: refOf(supportRecord)
    });
    check('B1.exactExpectedTerminalOutcomeSupports',
      supportProjection.ok === true
      && supportProjection.observation.sourceInstance === 'runtime.turn-execution'
      && supportProjection.observation.targetDomain === 'runtime_state'
      && supportProjection.observation.outcomeRef.token === TURN_TOKEN('completed')
      && P3_CORE.classifyRelation(supportRecord, supportProjection.observation) === 'support',
      supportProjection.observation && supportProjection.observation.outcomeRef);
    check('B2.realitySourceCarriesFactsOnlyAndNoPredictionIdentity',
      supportEvent.status === 'minted'
      && JSON.stringify(supportEvent.realityEvent.body) === JSON.stringify({ outcomeCode: 'completed' })
      && supportEvent.realityEvent.realityEventId.indexOf(supportRecord.predictionId) < 0
      && Object.prototype.hasOwnProperty.call(supportEvent.realityEvent.body, 'relation') === false
      && Object.prototype.hasOwnProperty.call(supportEvent.realityEvent.body, 'settlementState') === false,
      supportEvent.realityEvent);
    const exactSettlement = support.settlement.getSettlement(supportRecord.predictionId);
    check('B3.productionAuthorityPathSettlesExactSupportAndP4Counts',
      exactSettlement && exactSettlement.state === 'matched'
      && exactSettlement.calibrationCounted === true
      && support.calibration.getPartition('event', 'runtime_state').calibrationCounts.matched === 1
      && support.calibration.getPartition('event', 'runtime_state').capabilityCoverage.attributionAuthorityAvailable === true
      && support.calibration.getPartition('event', 'runtime_state').capabilityCoverage.productionSettleable === true,
      exactSettlement && { state: exactSettlement.state, counted: exactSettlement.calibrationCounted });
  }

  console.log('\n── conflict and opportunity boundary ──');
  {
    const conflict = buildWorld([{ expectedToken: TURN_TOKEN('completed') }]);
    const record = conflict.predictions[0];
    conflict.setNow(CLOSE + 1);
    const event = conflict.source.emit(terminal({ outcome: 'store-write-failed' }));
    const projection = conflict.observation.projectForPrediction({
      realityEvent: event.realityEvent,
      predictionRef: refOf(record)
    });
    const settlement = conflict.settlement.getSettlement(record.predictionId);
    check('C1.recognizedMutuallyExclusiveTerminalYieldsMechanicalConflict',
      projection.ok === true
      && projection.observation.outcomeRef.token === TURN_TOKEN('store-write-failed')
      && P3_CORE.classifyRelation(record, projection.observation) === 'conflict',
      projection.observation && projection.observation.outcomeRef);
    check('C2.canonicalTerminalFinalityAuthorizesMissed',
      settlement && settlement.opportunityState === 'SATISFIED'
      && settlement.state === 'missed'
      && settlement.calibrationCounted === true,
      settlement && { state: settlement.state, opportunity: settlement.opportunityState, counted: settlement.calibrationCounted });
  }

  console.log('\n── irrelevant, target binding, and unknown outcomes ──');
  {
    const unrelated = buildWorld([{ expectedToken: 'delivery.completed' }]);
    const unrelatedRecord = unrelated.predictions[0];
    unrelated.setNow(T0 + 2000);
    const unrelatedEvent = unrelated.source.emit(terminal());
    const unrelatedProjection = unrelated.observation.projectForPrediction({
      realityEvent: unrelatedEvent.realityEvent,
      predictionRef: refOf(unrelatedRecord)
    });
    check('D1.unrelatedRuntimePropositionIsIrrelevant',
      unrelatedProjection.ok === true
      && P3_CORE.classifyRelation(unrelatedRecord, unrelatedProjection.observation) === 'irrelevant'
      && unrelated.settlement.getSettlement(unrelatedRecord.predictionId).state !== 'matched',
      unrelatedProjection.observation && unrelatedProjection.observation.outcomeRef);

    const wrongTurn = buildWorld([{ expectedToken: TURN_TOKEN('completed'), turnId: 'turn_A' }]);
    const wrongRecord = wrongTurn.predictions[0];
    wrongTurn.setNow(T0 + 2000);
    const wrongEvent = wrongTurn.source.emit(terminal({ turnId: 'turn_B' }));
    const candidates = wrongTurn.observation.candidatePredictions(wrongEvent.realityEvent, {
      characterId: CHAR, conversationId: CONVERSATION
    });
    const refused = wrongTurn.observation.projectForPrediction({
      realityEvent: wrongEvent.realityEvent,
      predictionRef: refOf(wrongRecord)
    });
    check('D2.terminalCannotPairAcrossTurnIds',
      candidates.length === 0 && refused.ok === false
      && refused.reasonCode === 'turn-terminal-target-turn-mismatch'
      && wrongTurn.settlement.getSettlement(wrongRecord.predictionId) === null,
      { candidates: candidates, refused: refused.reasonCode });

    const wrongScope = buildWorld([{
      expectedToken: TURN_TOKEN('completed'),
      characterId: 'char_other', conversationId: 'dm:char_other', turnId: 'turn_scope'
    }]);
    const scopeRecord = wrongScope.predictions[0];
    wrongScope.setNow(T0 + 2000);
    const scopeEvent = wrongScope.source.emit(terminal({ turnId: 'turn_scope' }));
    const scopeRefused = wrongScope.observation.projectForPrediction({
      realityEvent: scopeEvent.realityEvent,
      predictionRef: refOf(scopeRecord)
    });
    check('D3.characterAndConversationScopeMustMatch',
      scopeRefused.ok === false && scopeRefused.reasonCode === 'turn-terminal-target-scope-mismatch'
      && wrongScope.settlement.getSettlement(scopeRecord.predictionId) === null,
      scopeRefused.reasonCode);

    const unknown = buildWorld([{ expectedToken: TURN_TOKEN('completed') }]);
    const unknownRecord = unknown.predictions[0];
    unknown.setNow(T0 + 2000);
    const unknownResults = ['unknown', 'provider-specific-kind'].map(function (code) {
      const event = unknown.source.emit(terminal({ turnId: 'turn_d5', outcome: code }));
      const projection = unknown.observation.projectForPrediction({
        realityEvent: event.realityEvent,
        predictionRef: refOf(unknownRecord)
      });
      return { code: code, event: event, projection: projection };
    });
    check('D4.unknownExecutionKindsRemainFactsButNotDirectionalEvidence',
      unknownResults.every(row => row.event.status === 'minted' && row.projection.ok === false
        && row.projection.reasonCode === 'structured-source-projection-refused')
      && unknown.settlement.getSettlement(unknownRecord.predictionId) === null,
      unknownResults.map(row => ({ code: row.code, body: row.event.realityEvent.body, projection: row.projection.reasonCode })));
    check('D5.unknownOrMalformedTerminalTokenCannotConflict',
      P3_CORE.classifyRelation(unknownRecord, {
        source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.turn-execution', targetDomain: 'runtime_state',
        outcomeRef: { kind: 'token', token: TURN_TOKEN('not-in-closed-set') }
      }) === 'unclassifiable'
      && P3_CORE.classifyRelation(unknownRecord, {
        source: 'CANONICAL_RUNTIME', sourceInstance: 'runtime.turn-execution', targetDomain: 'runtime_state',
        outcomeRef: { kind: 'token', token: 'runtime.turn_terminal' }
      }) === 'unclassifiable');
    const malformed = buildWorld([{ expectedToken: TURN_TOKEN('completed') }]);
    check('D6.emptyOutcomeIsRejectedAtTerminalSource',
      malformed.source.emit(terminal({ outcome: '' })).ok === false
      && malformed.realityEvent.heldEventCount() === 0);
  }

  console.log('\n── replay and multi-Prediction projection ──');
  {
    const replay = buildWorld([{ expectedToken: TURN_TOKEN('completed') }]);
    const record = replay.predictions[0];
    replay.setNow(T0 + 2000);
    const fact = terminal({ turnId: record.sourceExpectationRef.turnId });
    const first = replay.source.emit(fact);
    for (let i = 0; i < 100; i += 1) replay.source.emit(fact);
    for (let i = 0; i < 100; i += 1) replay.feedback.processRealityEvent(first.realityEvent);
    const settlement = replay.settlement.getSettlement(record.predictionId);
    check('E1.replayKeepsOneRealityEventDispatchSettlementAndSample',
      replay.realityEvent.heldEventCount() === 1
      && replay.feedback.dispatchedCount() === 1
      && replay.settlement.describe().counters.settled === 1
      && replay.calibration.getPartition('event', 'runtime_state').calibrationCounts.matched === 1
      && replay.calibration.describe().counters.duplicates === 0
      && settlement.state === 'matched',
      { realityEvents: replay.realityEvent.heldEventCount(), dispatches: replay.feedback.dispatchedCount(),
        settlements: replay.settlement.describe().counters.settled,
        counts: replay.calibration.getPartition('event', 'runtime_state').calibrationCounts });

    const multi = buildWorld([
      { expectedToken: TURN_TOKEN('completed'), turnId: 'turn_multi', expectationIndex: 0 },
      { expectedToken: TURN_TOKEN('timeout'), turnId: 'turn_multi', expectationIndex: 1 }
    ]);
    multi.setNow(T0 + 2000);
    const event = multi.source.emit(terminal({ turnId: 'turn_multi', outcome: 'completed' }));
    const [expectsCompleted, expectsTimeout] = multi.predictions;
    const completedSettlement = multi.settlement.getSettlement(expectsCompleted.predictionId);
    const timeoutObservation = multi.observation.projectForPrediction({
      realityEvent: event.realityEvent,
      predictionRef: refOf(expectsTimeout)
    });
    check('E2.oneRealityFactFansOutWithoutSelectingAWinner',
      multi.realityEvent.heldEventCount() === 1
      && multi.feedback.counters.candidateCount === 2
      && multi.feedback.counters.observationCount === 2
      && new Set([expectsCompleted.predictionId, expectsTimeout.predictionId]).size === 2
      && P3_CORE.classifyRelation(expectsCompleted, multi.observation.projectForPrediction({ realityEvent: event.realityEvent, predictionRef: refOf(expectsCompleted) }).observation) === 'support'
      && timeoutObservation.ok === true
      && P3_CORE.classifyRelation(expectsTimeout, timeoutObservation.observation) === 'conflict'
      && completedSettlement.state === 'matched'
       && multi.settlement.getSettlement(expectsTimeout.predictionId).state === 'missed'
       && multi.settlement.getSettlement(expectsTimeout.predictionId).opportunityState === 'SATISFIED',
      { candidates: multi.feedback.counters.candidateCount, observations: multi.feedback.counters.observationCount,
        completed: completedSettlement.state,
        timeout: multi.settlement.getSettlement(expectsTimeout.predictionId).state });
    check('E3.multiProjectionIdentityRemainsPredictionScoped',
      multi.observation.projectForPrediction({ realityEvent: event.realityEvent, predictionRef: refOf(expectsCompleted) }).observation.observationId
        !== timeoutObservation.observation.observationId
      && event.realityEvent.realityEventId.indexOf(expectsCompleted.predictionId) < 0
      && event.realityEvent.realityEventId.indexOf(expectsTimeout.predictionId) < 0);
  }

  console.log('\n── attribution, P4, and frozen runtime boundaries ──');
  {
    const contaminated = buildWorld([{ expectedToken: TURN_TOKEN('completed') }], { effectInForce: true });
    const record = contaminated.predictions[0];
    contaminated.setNow(T0 + 2000);
    const event = contaminated.source.emit(terminal({ turnId: record.sourceExpectationRef.turnId }));
    const projection = contaminated.observation.projectForPrediction({ realityEvent: event.realityEvent, predictionRef: refOf(record) });
    const settlement = contaminated.settlement.getSettlement(record.predictionId);
    check('F1.BehaviorEffectAttributionStillFlowsThroughP1AndP3',
      record.behaviorEffectAttributionStatus === 'known-present'
      && projection.ok === true
      && projection.observation.interventionContext.behaviorEffectsInForce.length > 0
      && settlement && settlement.calibrationCounted === false,
      { recordAttribution: record.behaviorEffectAttributionStatus,
        observationEffects: projection.observation && projection.observation.interventionContext.behaviorEffectsInForce.length,
        counted: settlement && settlement.calibrationCounted });
    check('F2.sourceAndP1NeverDeclareRelationOrSettlement',
      contaminated.source.toRealityEventInput(terminal()).sourceEvent.body.outcomeCode === 'completed'
      && ['relation', 'settlementState', 'predictionId', 'opportunitySatisfied']
        .every(key => Object.prototype.hasOwnProperty.call(contaminated.source.toRealityEventInput(terminal()).sourceEvent.body, key) === false)
      && contaminated.source.describe().relationClassification === 'NONE'
      && contaminated.observation.describe().producerMayInterpretSettlement === 'NO',
      { body: contaminated.source.toRealityEventInput(terminal()).sourceEvent.body,
        source: contaminated.source.describe() });
    check('F3.matcherRemainsOffAndNoP3P4ApplicationWasAdded',
      contaminated.settlement.describe().evidenceMatcherAttached === false
      && contaminated.settlement.describe().counters.matcherCalls === 0
      && contaminated.settlement.describe().calibrationAppliedToLive === 'NO'
      && contaminated.calibration.describe().calibrationConfidence === null
      && contaminated.calibration.describe().calibrationAppliedToLive === 'NO'
      && contaminated.feedback.counters.modelCalls === 0);
  }

  P('TURN_TERMINAL_OUTCOME_DIRECTIONAL_DISCRIMINATION', 'LIVE');
  P('TERMINAL_EXACT_MATCH', 'support');
  P('TERMINAL_MUTUALLY_EXCLUSIVE_MISMATCH', 'conflict');
  P('EVENT_OPPORTUNITY_AUTHORITY', 'LIVE · same-turn sealed terminal fact');
  P('EVENT_PRODUCTION_PREDICTION_CREATION', 'LIVE · runtime.turn_terminal only');
  P('EVIDENCE_MATCHER_ENABLED_DEFAULT', false);
  P('MATCHER_CALLS', 0);
  P('CALIBRATION_CONFIDENCE', 'null');
  P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
  P('D5_DIRECTIONAL_RELATION', failed ? 'BLOCKED' : 'COMPLETE');
  P('D5_DECISIVE_NEGATIVE_SETTLEMENT', 'LIVE');
  P('D5_R1_STATUS', failed ? 'BLOCKED' : 'COMPLETE');
  P('D5_R1_FREEZE', failed ? 'NOT_FROZEN' : 'FROZEN');
  P('P5_B3_D5_STATUS', failed ? 'BLOCKED' : 'COMPLETE');
  P('P5_B3_D5_FREEZE', failed ? 'NOT_FROZEN' : 'FROZEN');

  console.log('\nRESULT ' + (failed ? 'FAIL' : 'PASS') + ' · ' + passed + ' passed · ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
