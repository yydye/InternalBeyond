'use strict';
/* P5-B3-D5-R1 · canonical terminal finality as independent event opportunity */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services/home-node-service.js'));
const OO = require(path.join(ROOT, 'assets/js/memory-recall/outcome-observation-core.js'));
const createExecutor = require(path.join(ROOT, 'services/home-node/execution.js'));
const { createRuntimePredictionSettlement } = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
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
const CHAT_CORE = require(path.join(ROOT, 'assets/js/chat-core.js'));

const T0 = 1760000000000;
const TERMINAL_AT = T0 + 1000;
const WINDOW_CLOSE = T0 + 86400000;
const CHAR = 'char_r1';
const CONVERSATION = 'dm:char_r1';
const TURN = 'turn_r1_e2e';
const TOKEN = code => 'runtime.turn_terminal.' + code;

let passed = 0;
let failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed += 1; console.log('  PASS  ' + name); return; }
  failed += 1; console.error('  FAIL  ' + name + (detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
};
const section = name => console.log('\n── ' + name + ' ──');
const P = (key, value) => console.log('  FACTS ' + key + ' = ' + value);

function strictRegistry(ids) {
  return {
    getCharacterSpec: id => ids.indexOf(String(id)) >= 0
      ? { endpoint: 'https://provider.invalid', model: 'test-model', systemPrompt: 'test', apiKey: 'test-key' }
      : null,
    open: function () { return true; }
  };
}

function buildProductionNode(tag, outcomeCode) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-r1-' + tag + '-'));
  const port = {
    runStream: async function () {
      if (outcomeCode === 'timeout') {
        const error = new Error('production assembly timeout'); error.name = 'TimeoutError'; throw error;
      }
      return { ok: true, text: 'production reply', reasoning: '', usage: null, streamed: false };
    }
  };
  const node = SERVICE.buildHomeNode({
    dataDir: dataDir,
    credentialDataDir: dataDir,
    token: 'r1-test-token',
    port: port,
    logger: function () {},
    clock: function () { return T0; },
    turnIdFactory: function () { return 'turn_r1_prod_' + tag; },
    registry: strictRegistry([CHAR])
  });
  node.open();
  node.__testTurnId = 'turn_r1_prod_' + tag;
  return node;
}

function seedProductionPrediction(node, expectedToken) {
  return node.runtimePredictionRegistry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction',
    prediction: 'this exact Home Node execution turn will reach a terminal outcome',
    trigger: { kind: 'explicit-cue', label: 'R1 production assembly fixture' },
    evidenceMemoryIds: ['r1_production_memory'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: expectedToken }
  }, {
    now: T0,
    characterId: CHAR,
    conversationId: CONVERSATION,
    turnId: node.__testTurnId,
    expectationIndex: 0
  }).record;
}

async function executeProductionNodeTurn(node, requestId) {
  return node.executor.executeCharacterTurn({
    requestId: requestId,
    userMessage: { id: 'u_' + requestId, role: 'user', content: 'hello', friendId: CHAR, timestamp: T0 },
    character: { id: CHAR, spec: { endpoint: 'https://provider.invalid', model: 'test-model', systemPrompt: 'test', apiKey: 'test-key' } },
    history: []
  }, {});
}

function createTestStore(failAssistantWrite) {
  let revision = 0;
  const requests = new Map();
  const messages = new Map();
  return {
    putMessage: function (message, options) {
      const o = options || {};
      if (failAssistantWrite && o.idempotent === false) {
        return { ok: false, error: 'synthetic-store-failure', errors: ['synthetic-store-failure'] };
      }
      if (o.requestId) {
        if (requests.has(o.requestId)) {
          const prior = requests.get(o.requestId);
          return { ok: true, outcome: 'duplicate-request', id: prior.id, revision: prior.revision };
        }
        const userId = String(message.id || ('user_' + o.requestId));
        const row = { id: userId, revision: ++revision };
        requests.set(o.requestId, row);
        messages.set(userId, message);
        return { ok: true, outcome: 'created', id: row.id, revision: row.revision };
      }
      const id = String(message.id || ('message_' + (revision + 1)));
      messages.set(id, message);
      return { ok: true, id: id, revision: ++revision };
    },
    getMessage: id => messages.get(String(id)) || null
  };
}

function makeEventPrediction(registry, token, over) {
  const x = over || {};
  const result = registry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction',
    prediction: 'this exact execution turn will reach the expected terminal outcome',
    trigger: { kind: 'explicit-cue', label: 'R1 canonical event fixture' },
    evidenceMemoryIds: ['r1_memory'],
    contradictoryEvidenceIds: [],
    generalizationLevel: 'episode-hypothesis',
    subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' },
    predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: token }
  }, {
    now: T0,
    characterId: x.characterId || CHAR,
    conversationId: x.conversationId || CONVERSATION,
    turnId: x.turnId || TURN,
    expectationIndex: x.expectationIndex == null ? 0 : x.expectationIndex
  });
  return result && result.ok === true ? result.record : null;
}

function buildWorld(predictionSpecs, options) {
  const opts = options || {};
  let now = T0;
  let feedback = null;
  let lastTerminal = null;
  let manualFeedbackCalls = 0;
  let manualCalibrationIngest = 0;
  let manualOpportunityInjection = 0;
  const clock = () => now;
  const logger = () => {};
  const behaviorEffect = createRuntimeBehaviorEffect({ clock: clock, logger: logger });
  if (opts.effectInForce === true) {
    behaviorEffect.deriveAndHold({
      characterId: CHAR,
      conversationId: CONVERSATION,
      turnId: 'turn_r1_effect_basis',
      interpretationValidated: true,
      interpretationResult: { ok: true, status: 'succeeded', recordSource: 'R1_TEST', interpretation: { ok: true, items: [{ memoryId: 'r1_memory', appraisal: 'positive' }] } },
      expectationHeld: true,
      expectation: { ok: true, status: 'created' }
    });
  }
  const registry = createRuntimePredictionRegistry({ clock: clock, logger: logger, attributionAuthority: behaviorEffect });
  const predictions = (predictionSpecs || []).map((spec, index) => {
    const s = spec || {};
    return makeEventPrediction(registry, s.expectedToken || TOKEN('completed'), {
      characterId: s.characterId,
      conversationId: s.conversationId,
      turnId: s.turnId,
      expectationIndex: s.expectationIndex == null ? index : s.expectationIndex
    });
  });

  const realityEvent = createRuntimeRealityEvent({
    logger: logger,
    onRealityEventMinted: event => { if (feedback) feedback.onRealityEventMinted(event); }
  });
  const observation = createRuntimeOutcomeObservation({
    registry: registry,
    isRealityEvent: realityEvent.isRealityEvent,
    attributionAuthority: behaviorEffect,
    logger: logger
  });
  const subjectiveOpportunityAuthority = createRuntimeSubjectiveOpportunityAuthority({
    realityEventAuthority: realityEvent,
    clock: clock
  });
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
  });
  const calibration = createRuntimePredictionCalibration({
    settlementRuntime: Object.assign({}, require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js')), settlement),
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
    onSettlement: (record, predictionError) => calibrationDriver.dispatchSettlement(record, predictionError),
    logger: logger
  });
  const source = createTurnTerminalRealitySource({ realityEvent: realityEvent, logger: logger });

  async function runCanonicalTurn(outcomeCode) {
    if (lastTerminal) throw new Error('one execution per R1 world');
    now = TERMINAL_AT;
    const store = createTestStore(outcomeCode === 'store-write-failed');
    const port = {
      runStream: async function () {
        if (outcomeCode === 'timeout') {
          const error = new Error('synthetic timeout'); error.name = 'TimeoutError'; throw error;
        }
        if (outcomeCode === 'abort') {
          const error = new Error('synthetic abort'); error.name = 'AbortError'; throw error;
        }
        if (outcomeCode === 'cancelled' || outcomeCode === 'unknown' || outcomeCode === 'provider-specific-kind' || outcomeCode === 'provider-error') {
          const error = new Error('synthetic provider result');
          error.kind = outcomeCode === 'provider-error' ? 'http' : outcomeCode;
          throw error;
        }
        if (outcomeCode === 'empty-output') return { ok: true, text: '  ', reasoning: '', usage: null, streamed: false };
        return { ok: true, text: 'assistant result', reasoning: '', usage: null, streamed: false };
      }
    };
    const executor = createExecutor({
      store: store,
      port: port,
      clock: clock,
      logger: logger,
      turnIdFactory: () => TURN,
      characterRegistry: { getCharacterSpec: id => String(id) === CHAR ? {
        endpoint: 'https://provider.invalid', model: 'test-model', systemPrompt: 'test', apiKey: 'test-key'
      } : null },
      onTurnTerminal: terminal => {
        lastTerminal = terminal;
        source.emit(terminal);
      }
    });
    const requestId = 'r1_req_' + outcomeCode;
    const result = await executor.executeCharacterTurn({
      requestId: requestId,
      userMessage: { id: 'u_' + requestId, role: 'user', content: 'hello', friendId: CHAR, timestamp: TERMINAL_AT },
      character: { id: CHAR, spec: { endpoint: 'https://provider.invalid', model: 'test-model', systemPrompt: 'test', apiKey: 'test-key' } },
      history: []
    }, {});
    lastTerminal = executor.terminalOutcomeOf(TURN);
    return { result: result, terminal: lastTerminal, executor: executor };
  }

  return {
    setNow: value => { now = value; },
    runCanonicalTurn: runCanonicalTurn,
    clock: clock,
    registry: registry,
    predictions: predictions,
    behaviorEffect: behaviorEffect,
    realityEvent: realityEvent,
    observation: observation,
    source: source,
    feedback: feedback,
    eventOpportunityAuthority: eventOpportunityAuthority,
    opportunityAuthority: opportunityAuthority,
    settlement: settlement,
    calibration: calibration,
    calibrationDriver: calibrationDriver,
    manualCounts: () => ({ manualFeedbackCalls, manualCalibrationIngest, manualOpportunityInjection })
  };
}

function p1Projection(world, prediction) {
  const terminal = world.realityEvent.queryRealityEvents({
    realitySourceId: 'turn-terminal', sourceInstance: 'runtime.turn-execution',
    characterId: CHAR, conversationId: CONVERSATION
  }).events[0];
  if (!terminal) return null;
  return world.observation.projectForPrediction({
    realityEvent: terminal,
    predictionRef: {
      predictionId: prediction.predictionId,
      opensAt: prediction.observationWindow.opensAt,
      closesAt: prediction.observationWindow.closesAt,
      predictionCreatedAt: prediction.createdAt
    }
  });
}

(async function main() {
  section('authority boundary and opportunity contract');
  {
    const world = buildWorld([{ expectedToken: TOKEN('completed') }]);
    const prediction = world.predictions[0];
    const noFact = world.opportunityAuthority.resolveForPrediction({ prediction: prediction, observation: null, now: WINDOW_CLOSE + 1 });
    check('A1.eventOpportunityIsRequiredRuntimeExecution',
      prediction.predictionType === 'event' && prediction.opportunity.required === true
      && prediction.opportunity.kind === 'runtime-execution' && noFact.state === 'UNKNOWN',
      { type: prediction.predictionType, opportunity: prediction.opportunity, state: noFact.state });
  }

  section('real execution terminal → support / conflict → P3 → P4');
  {
    const support = buildWorld([{ expectedToken: TOKEN('completed') }]);
    const supportPrediction = support.predictions[0];
    const supportRun = await support.runCanonicalTurn('completed');
    const supportSettlement = support.settlement.getSettlement(supportPrediction.predictionId);
    const supportPartition = support.calibration.getPartition('event', 'runtime_state');
    check('B1.realExecutionExactTerminalStillMatchesAndAutoIngestsP4',
      supportRun.terminal && supportRun.terminal.outcome === 'completed'
      && supportSettlement && supportSettlement.state === 'matched'
      && supportSettlement.opportunityState === 'SATISFIED'
      && supportPartition.calibrationCounts.matched === 1,
      { terminal: supportRun.terminal && supportRun.terminal.outcome,
        state: supportSettlement && supportSettlement.state,
        opportunity: supportSettlement && supportSettlement.opportunityState,
        counts: supportPartition.calibrationCounts });

    const conflict = buildWorld([{ expectedToken: TOKEN('completed') }]);
    const conflictPrediction = conflict.predictions[0];
    const conflictRun = await conflict.runCanonicalTurn('timeout');
    const conflictEventId = conflict.source.toRealityEventInput(conflictRun.terminal).sourceEvent.eventId;
    const conflictEvent = conflict.realityEvent.getRealityEventById(conflictEventId);
    const conflictSettlement = conflict.settlement.getSettlement(conflictPrediction.predictionId);
    const conflictPartition = conflict.calibration.getPartition('event', 'runtime_state');
    const directProjection = p1Projection(conflict, conflictPrediction);
    const directOpportunity = conflict.eventOpportunityAuthority.resolveForPrediction({
      prediction: conflictPrediction,
      observation: directProjection && directProjection.observation,
      now: conflict.clock()
    });
    const fakeEvent = conflictEvent ? Object.freeze(Object.assign({}, conflictEvent)) : null;
    check('B2.realTimeoutConflictGetsIndependentSameTurnOpportunityAndMissed',
      conflictRun.terminal && conflictRun.terminal.outcome === 'timeout'
      && conflictSettlement && conflictSettlement.state === 'missed'
      && conflictSettlement.opportunityState === 'SATISFIED'
      && conflictSettlement.calibrationCounted === true
      && conflictPartition.calibrationCounts.missed === 1,
      { terminal: conflictRun.terminal && conflictRun.terminal.outcome,
        state: conflictSettlement && conflictSettlement.state,
        opportunity: conflictSettlement && conflictSettlement.opportunityState,
        counted: conflictSettlement && conflictSettlement.calibrationCounted,
        counts: conflictPartition.calibrationCounts });
    check('B3.opportunityIdentityIsPredictionIndependentAndForgedEventRefused',
      directOpportunity.state === 'SATISFIED'
      && directOpportunity.opportunity.identity.realityEventId === conflictEventId
      && !Object.prototype.hasOwnProperty.call(directOpportunity.opportunity.identity, 'predictionId')
      && conflict.eventOpportunityAuthority.isCanonicalTerminalEvent(conflictEvent) === true
      && conflict.eventOpportunityAuthority.isCanonicalTerminalEvent(fakeEvent) === false,
      { opportunity: directOpportunity.opportunity && directOpportunity.opportunity.identity,
        genuine: conflict.eventOpportunityAuthority.isCanonicalTerminalEvent(conflictEvent),
        forged: conflict.eventOpportunityAuthority.isCanonicalTerminalEvent(fakeEvent) });
    const counts = conflict.manualCounts();
    check('B4.noManualOpportunityFeedbackOrCalibrationInjection',
      counts.manualOpportunityInjection === 0 && counts.manualFeedbackCalls === 0 && counts.manualCalibrationIngest === 0,
      counts);
  }

  section('production Home Node assembly E2E');
  {
    const supportNode = buildProductionNode('support', 'completed');
    const supportPrediction = seedProductionPrediction(supportNode, TOKEN('completed'));
    const supportRun = await executeProductionNodeTurn(supportNode, 'r1_prod_support');
    const supportSettlement = supportNode.runtimePredictionSettlement.getSettlement(supportPrediction.predictionId);
    const supportPartition = supportNode.runtimePredictionCalibration.getPartition('event', 'runtime_state');
    check('P1.buildHomeNodeRunsRealCompletionThroughP3AndP4',
      supportRun.ok === true && supportRun.outcome === 'completed'
      && supportSettlement && supportSettlement.state === 'matched'
      && supportSettlement.opportunityState === 'SATISFIED'
      && supportPartition.calibrationCounts.matched === 1,
      { result: supportRun.outcome, state: supportSettlement && supportSettlement.state,
        opportunity: supportSettlement && supportSettlement.opportunityState,
        counts: supportPartition && supportPartition.calibrationCounts });

    const conflictNode = buildProductionNode('conflict', 'timeout');
    const conflictPrediction = seedProductionPrediction(conflictNode, TOKEN('completed'));
    let manualFeedbackCalls = 0;
    let manualOpportunityInjection = 0;
    let directLedgerIngests = 0;
    const feedback = conflictNode.runtimeRealityFeedback;
    const publicFeedbackCall = feedback.processRealityEvent.bind(feedback);
    feedback.processRealityEvent = function () {
      manualFeedbackCalls += 1;
      return publicFeedbackCall.apply(null, arguments);
    };
    const p3 = conflictNode.runtimePredictionSettlement;
    const canonicalSettle = p3.settlePrediction.bind(p3);
    p3.settlePrediction = function (prediction, observations, context) {
      if (context && Object.prototype.hasOwnProperty.call(context, 'opportunity')) manualOpportunityInjection += 1;
      return canonicalSettle(prediction, observations, context);
    };
    const calibration = conflictNode.runtimePredictionCalibration;
    const canonicalIngest = calibration.ingestSettlement.bind(calibration);
    calibration.ingestSettlement = function () {
      directLedgerIngests += 1;
      return canonicalIngest.apply(null, arguments);
    };
    const conflictRun = await executeProductionNodeTurn(conflictNode, 'r1_prod_conflict');
    const conflictSettlement = conflictNode.runtimePredictionSettlement.getSettlement(conflictPrediction.predictionId);
    const conflictPartition = conflictNode.runtimePredictionCalibration.getPartition('event', 'runtime_state');
    const calibrationDriver = conflictNode.runtimePredictionCalibrationDriver;
    const driverCounters = calibrationDriver.describe().counters;
    const manualCalibrationIngest = directLedgerIngests - driverCounters.ledgerAttempts;
    check('P2.buildHomeNodeRealTimeoutFlowsToMissedAndAutomaticP4Ingest',
      conflictRun.ok === false && conflictRun.error === 'timeout'
      && conflictSettlement && conflictSettlement.state === 'missed'
      && conflictSettlement.opportunityState === 'SATISFIED'
      && conflictSettlement.calibrationCounted === true
      && conflictPartition.calibrationCounts.missed === 1
      && feedback.counters.dispatchAttempted === 1
      && feedback.counters.observationCount === 1
      && feedback.counters.settlementCount === 1
      && feedback.counters.modelCalls === 0
      && driverCounters.ledgerAccepted === 1,
      { result: conflictRun.error, state: conflictSettlement && conflictSettlement.state,
        opportunity: conflictSettlement && conflictSettlement.opportunityState,
        counts: conflictPartition && conflictPartition.calibrationCounts,
        feedback: feedback.counters });
    check('P3.noManualHooksInProductionPathAndRouterIsWired',
      conflictNode.runtimeEventOpportunityAuthority.describe().status === 'LIVE_CAPABLE'
      && conflictNode.runtimeOpportunityAuthority.describe().eventAndSubjectiveSemanticsSeparated === 'YES'
      && manualOpportunityInjection === 0
      && manualFeedbackCalls === 0
      && manualCalibrationIngest === 0
      && conflictNode.runtimePredictionCalibration.describe().calibrationConfidence === null
      && conflictNode.runtimePredictionCalibration.describe().calibrationAppliedToLive === 'NO',
      { manualOpportunityInjection: manualOpportunityInjection,
        manualFeedbackCalls: manualFeedbackCalls,
        manualCalibrationIngest: manualCalibrationIngest,
        automaticLedgerAccepted: driverCounters.ledgerAccepted });
  }

  section('same fact fans out to multiple Predictions');
  {
    const world = buildWorld([
      { expectedToken: TOKEN('completed'), expectationIndex: 0 },
      { expectedToken: TOKEN('timeout'), expectationIndex: 1 }
    ]);
    const [expectsCompleted, expectsTimeout] = world.predictions;
    const run = await world.runCanonicalTurn('completed');
    const completed = world.settlement.getSettlement(expectsCompleted.predictionId);
    const timeout = world.settlement.getSettlement(expectsTimeout.predictionId);
    const projectionA = p1Projection(world, expectsCompleted);
    const projectionB = p1Projection(world, expectsTimeout);
    const opportunityA = world.eventOpportunityAuthority.resolveForPrediction({ prediction: expectsCompleted, observation: projectionA.observation, now: world.clock() });
    const opportunityB = world.eventOpportunityAuthority.resolveForPrediction({ prediction: expectsTimeout, observation: projectionB.observation, now: world.clock() });
    check('C1.sameTerminalFactSupportsOnePredictionAndMissesTheOther',
      run.terminal && run.terminal.outcome === 'completed'
      && completed && completed.state === 'matched' && completed.opportunityState === 'SATISFIED'
      && timeout && timeout.state === 'missed' && timeout.opportunityState === 'SATISFIED',
      { completed: completed && completed.state, timeout: timeout && timeout.state });
    check('C2.opportunityIdentitySharedAcrossPredictionScopedObservations',
      opportunityA.state === 'SATISFIED' && opportunityB.state === 'SATISFIED'
      && opportunityA.opportunity.identity.opportunityId === opportunityB.opportunity.identity.opportunityId
      && projectionA.observation.observationId !== projectionB.observation.observationId,
      { opportunityA: opportunityA.opportunity && opportunityA.opportunity.identity.opportunityId,
        opportunityB: opportunityB.opportunity && opportunityB.opportunity.identity.opportunityId });
  }

  section('scope, proposition, missing fact, unknown outcome, and replay');
  {
    const world = buildWorld([
      { expectedToken: TOKEN('completed'), expectationIndex: 0 },
      { expectedToken: 'delivery.completed', expectationIndex: 1 },
      { expectedToken: TOKEN('completed'), turnId: 'turn_other', expectationIndex: 2 },
      { expectedToken: TOKEN('completed'), characterId: 'char_other', conversationId: 'dm:char_other', expectationIndex: 3 },
      { expectedToken: TOKEN('completed'), conversationId: 'group:other', expectationIndex: 4 }
    ]);
    const [matching, unrelated, wrongTurn, wrongCharacter, wrongConversation] = world.predictions;
    const preference = world.registry.projectFromValidatedExpectation({
      epistemicStatus: 'prediction',
      prediction: 'the user will prefer science fiction',
      trigger: { kind: 'explicit-cue', label: 'unrelated preference fixture' },
      evidenceMemoryIds: ['r1_memory'],
      contradictoryEvidenceIds: [],
      generalizationLevel: 'episode-hypothesis',
      subjectivePredictionConfidence: 0.8,
      subject: { kind: 'user', label: '' },
      predicate: { kind: 'prefers' },
      expectedOutcome: { kind: 'exclusive-outcome', token: 'pref.like.scifi' }
    }, {
      now: T0, characterId: CHAR, conversationId: CONVERSATION,
      turnId: TURN, expectationIndex: 9
    }).record;
    const run = await world.runCanonicalTurn('completed');
    const matchingProjection = p1Projection(world, matching);
    const facts = pred => world.eventOpportunityAuthority.resolveForPrediction({ prediction: pred, observation: matchingProjection.observation, now: world.clock() });
    check('D1.wrongTurnCharacterConversationAndOtherFamilyCannotSatisfy',
      facts(wrongTurn).state === 'UNKNOWN'
      && facts(wrongCharacter).state === 'UNKNOWN'
      && facts(wrongConversation).state === 'UNKNOWN'
      && facts(unrelated).state === 'UNKNOWN'
      && world.eventOpportunityAuthority.resolveForPrediction({ prediction: preference, observation: matchingProjection.observation, now: world.clock() }).state === 'UNKNOWN',
      { turn: facts(wrongTurn).state, character: facts(wrongCharacter).state,
        conversation: facts(wrongConversation).state, proposition: facts(unrelated).state,
        preference: world.eventOpportunityAuthority.resolveForPrediction({ prediction: preference, observation: matchingProjection.observation, now: world.clock() }).state });
    check('D2.noTerminalFactDoesNotSatisfyOpportunity', (function () {
      const noFact = buildWorld([{ expectedToken: TOKEN('completed') }]);
      const prediction = noFact.predictions[0];
      const result = noFact.opportunityAuthority.resolveForPrediction({ prediction: prediction, observation: null, now: WINDOW_CLOSE + 1 });
      const settlement = noFact.settlement.settlePrediction(prediction, [], { now: WINDOW_CLOSE + 1 }).settlement;
      return result.state === 'UNKNOWN' && result.opportunity === null
        && settlement && settlement.opportunityState === 'UNKNOWN'
        && ['pending', 'expired_unobserved', 'unresolvable'].indexOf(settlement.state) >= 0;
    })(), 'no terminal cannot become missed or SATISFIED at window close');

    const unknown = buildWorld([{ expectedToken: TOKEN('completed') }]);
    const unknownPrediction = unknown.predictions[0];
    const unknownRun = await unknown.runCanonicalTurn('provider-specific-kind');
    const unknownEventId = unknown.source.toRealityEventInput(unknownRun.terminal).sourceEvent.eventId;
    const unknownEvent = unknown.realityEvent.getRealityEventById(unknownEventId);
    const unknownProjection = unknown.observation.projectForPrediction({
      realityEvent: unknownEvent,
      predictionRef: {
        predictionId: unknownPrediction.predictionId,
        opensAt: unknownPrediction.observationWindow.opensAt,
        closesAt: unknownPrediction.observationWindow.closesAt,
        predictionCreatedAt: unknownPrediction.createdAt
      }
    });
    const unknownOpportunity = unknown.eventOpportunityAuthority.resolveForPrediction({ prediction: unknownPrediction, observation: null, now: unknown.clock() });
    check('D3.unknownTerminalRemainsFactButCannotCreateDecisiveOpportunity',
      unknownEvent && unknownProjection.ok === false
      && unknown.eventOpportunityAuthority.isCanonicalTerminalEvent(unknownEvent) === false
      && unknownOpportunity.state === 'UNKNOWN'
      && unknown.settlement.getSettlement(unknownPrediction.predictionId) === null,
      { eventBody: unknownEvent && unknownEvent.body,
        projection: unknownProjection.reasonCode,
        opportunity: unknownOpportunity.state });

    const replay = buildWorld([{ expectedToken: TOKEN('completed') }]);
    const replayPrediction = replay.predictions[0];
    const replayRun = await replay.runCanonicalTurn('timeout');
    const replayEventId = replay.source.toRealityEventInput(replayRun.terminal).sourceEvent.eventId;
    const replayEvent = replay.realityEvent.getRealityEventById(replayEventId);
    for (let i = 0; i < 100; i += 1) replay.source.emit(replayRun.terminal);
    const replaySettlement = replay.settlement.getSettlement(replayPrediction.predictionId);
    const replayPartition = replay.calibration.getPartition('event', 'runtime_state');
    check('D4.replay100xKeepsOneEventDispatchSettlementAndSample',
      replay.realityEvent.heldEventCount() === 1
      && replay.feedback.dispatchedCount() === 1
      && replay.settlement.describe().counters.settled === 1
      && replaySettlement.state === 'missed'
      && replayPartition.calibrationCounts.missed === 1
      && replay.calibration.describe().counters.duplicates === 0,
      { eventId: replayEvent && replayEvent.realityEventId,
        events: replay.realityEvent.heldEventCount(), dispatches: replay.feedback.dispatchedCount(),
        settlements: replay.settlement.describe().counters.settled, counts: replayPartition.calibrationCounts });
  }

  section('contamination, Matcher, and P4 boundaries');
  {
    const contaminated = buildWorld([{ expectedToken: TOKEN('completed') }], { effectInForce: true });
    const prediction = contaminated.predictions[0];
    await contaminated.runCanonicalTurn('timeout');
    const settlement = contaminated.settlement.getSettlement(prediction.predictionId);
    const partition = contaminated.calibration.getPartition('event', 'runtime_state');
    const missedCount = partition && partition.calibrationCounts ? partition.calibrationCounts.missed : 0;
    check('E1.opportunityDoesNotOverrideBehaviorEffectContamination',
      prediction.behaviorEffectAttributionStatus === 'known-present'
      && settlement && settlement.state === 'missed'
      && settlement.calibrationCounted === false
      && missedCount === 0,
      { attribution: prediction.behaviorEffectAttributionStatus,
        state: settlement && settlement.state, counted: settlement && settlement.calibrationCounted,
        counts: partition && partition.calibrationCounts });
    check('E2.matcherAndCalibrationApplicationRemainOff',
      contaminated.settlement.describe().evidenceMatcherAttached === false
      && contaminated.settlement.describe().counters.matcherCalls === 0
      && contaminated.calibration.describe().calibrationConfidence === null
      && contaminated.calibration.describe().calibrationAppliedToLive === 'NO');
  }

  P('EVENT_OPPORTUNITY_AUTHORITY', failed ? 'BLOCKED' : 'LIVE');
  P('D5_DECISIVE_NEGATIVE_SETTLEMENT', failed ? 'BLOCKED' : 'LIVE');
  P('TEST_MANUAL_OPPORTUNITY_INJECTION', 0);
  P('TEST_MANUAL_FEEDBACK_CALLS', 0);
  P('TEST_MANUAL_CALIBRATION_INGEST', 0);
  P('MATCHER_CALLS', 0);
  P('CALIBRATION_CONFIDENCE', 'null');
  P('CALIBRATION_APPLIED_TO_LIVE', 'NO');
  P('EVENT_PRODUCTION_PREDICTION_CREATION', 'LIVE · runtime.turn_terminal only');
  P('P5_B3_D5_R1_STATUS', failed ? 'BLOCKED' : 'COMPLETE');
  P('P5_B3_D5_R1_FREEZE', failed ? 'NOT_FROZEN' : 'FROZEN');
  console.log('\nRESULT ' + (failed ? 'FAIL' : 'PASS') + ' · ' + passed + ' passed · ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
