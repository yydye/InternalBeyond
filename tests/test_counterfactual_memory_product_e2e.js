'use strict';

/* P21-R4-Q · private, turn-scoped alternative-history view over a preserved
 * canonical Memory claim. P3/P1 objects are read through their sealed owners. */
const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'assets/js/memory-recall/counterfactual-memory-core.js'));
const { createRuntimeCounterfactualMemory } = require(path.join(ROOT, 'services/home-node/runtime-counterfactual-memory.js'));
const { createRuntimeRealityEvent } = require(path.join(ROOT, 'services/home-node/runtime-reality-event.js'));
const { createRuntimeOutcomeObservation } = require(path.join(ROOT, 'services/home-node/runtime-outcome-observation.js'));
const { createRuntimePredictionRegistry } = require(path.join(ROOT, 'services/home-node/runtime-prediction-registry.js'));
const P3 = require(path.join(ROOT, 'services/home-node/runtime-prediction-settlement.js'));
const createRuntimeRecall = require(path.join(ROOT, 'services/home-node/runtime-recall.js')).createRuntimeRecall;

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail))); }
}

const MEMORY_ID = 'memory-visit-1';
const CHARACTER_ID = 'role-q';
const CONVERSATION_ID = 'conversation-q';
const TURN_ID = 'turn-q-1';
const CURRENT_MESSAGE = 'If he had attended that day, what might have changed?';
const MEMORY_TEXT = 'The user did not attend the visit that weekend; a serious argument followed.';
const ACTUAL_CLAIM = 'The user did not attend the visit.';
const MEMORY_RECORD = {
  id: MEMORY_ID, title: 'Missed visit', content: MEMORY_TEXT, summary: MEMORY_TEXT,
  source: 'chat', kind: 'episodic', createdBy: CHARACTER_ID, visibility: 'public',
  created: 1760000000000 - 86400000, tags: []
};
const MEMORY_RECORD_SNAPSHOT = JSON.stringify(MEMORY_RECORD);

function qInput(overrides) {
  const base = {
    characterId: CHARACTER_ID,
    conversationId: CONVERSATION_ID,
    turnId: TURN_ID,
    currentMessage: CURRENT_MESSAGE,
    selectedIds: [MEMORY_ID],
    records: [MEMORY_RECORD],
    memoryProvenanceById: [{ memoryId: MEMORY_ID, authorSide: 'character_recollection',
      provenanceState: 'clear', kind: 'episodic', upstreamCount: 0 }],
    association: { edges: [] },
    reinterpretation: { ok: true, contextualInterpretation: {
      identity: { value: 'sha256-v1:K-1' },
      currentMeaning: { summary: 'The missed visit and argument remain linked in the current interpretation.',
        historicalFacts: [{ memoryId: MEMORY_ID, statement: ACTUAL_CLAIM }],
        historicalEmotions: [], currentKnowledge: [], currentBeliefs: [], uncertainty: 'medium' }
    } },
    selfNarrative: null,
    metaMemoryAwareness: { memoryStates: [{ memoryId: MEMORY_ID, state: 'remembered', factualDetail: 'remembered' }] },
    reconstructedRecollection: { memoryRefs: [MEMORY_ID], reliabilityState: 'reliable',
      preservedFacts: [{ memoryId: MEMORY_ID, state: 'remembered',
        claimAuthority: 'CANONICAL_MEMORY_CLAIM_NOT_WORLD_FACT' }] },
    sharedMemoryView: null
  };
  return Object.assign(base, overrides || {});
}
function fakeModel(response, state) {
  return { run: async function (request) {
    state.calls += 1;
    state.lastRequest = request;
    if (response === 'throw') throw new Error('counterfactual-provider-failure');
    return { ok: true, text: typeof response === 'string' ? response : JSON.stringify(response) };
  } };
}
function standardResponse() {
  return { items: [{ basedOnMemoryIds: [MEMORY_ID],
    alternativeOutcome: 'The argument might have been less severe.',
    causalRationale: 'Clarifying the missed visit earlier could have changed how the absence was understood.' }] };
}
function makeQRuntime(response, state, extra) {
  return createRuntimeCounterfactualMemory(Object.assign({
    modelPort: fakeModel(response, state),
    registry: { getCharacterSpec: () => ({ provider: 'test', model: 'q-model',
      endpoint: 'https://counterfactual.invalid', credentialRef: 'q-credential' }) },
    credentialAccess: { resolve: () => ({ ok: true, secret: 'q-secret' }) },
    clock: () => 1760000100000,
    logger: () => {}
  }, extra || {}));
}

async function sealedPredictionErrorEvidence() {
  const now = 1760000000000;
  const reality = createRuntimeRealityEvent({});
  const cause = reality.ingest({ sourceId: 'runtime-delivery', sourceEvent: {
    eventId: 'delivery:q-cause', domain: 'delivery', type: 'failed', entityId: 'visit-q',
    timestamp: now + 500, characterId: CHARACTER_ID, conversationId: CONVERSATION_ID,
    body: { statement: 'The missed visit happened.' }
  } }).realityEvent;
  const eventResult = reality.ingest({ sourceId: 'runtime-delivery', sourceEvent: {
    eventId: 'delivery:q-evidence', domain: 'delivery', type: 'completed', entityId: 'visit-q',
    timestamp: now + 1000, characterId: CHARACTER_ID, conversationId: CONVERSATION_ID,
    causationId: cause.realityEventId,
    body: { statement: 'The argument after the missed visit was serious.' }
  } });
  const event = eventResult.realityEvent;
  const registry = createRuntimePredictionRegistry({ clock: () => now });
  const projected = registry.projectFromValidatedExpectation({
    epistemicStatus: 'prediction', prediction: 'The visit will be completed.',
    trigger: { kind: 'explicit-cue', label: 'visit outcome' }, evidenceMemoryIds: [MEMORY_ID],
    contradictoryEvidenceIds: [], generalizationLevel: 'episode-hypothesis', subjectivePredictionConfidence: 0.8,
    subject: { kind: 'user', label: '' }, predicate: { kind: 'will-do' },
    expectedOutcome: { kind: 'exclusive-outcome', token: 'delivery.completed' }
  }, { now: now, characterId: CHARACTER_ID, conversationId: CONVERSATION_ID,
    turnId: 'turn-q-prediction', expectationIndex: 0 });
  const prediction = projected.record;
  const outcomeObservation = createRuntimeOutcomeObservation({ registry: registry,
    isRealityEvent: reality.isRealityEvent }).projectForPrediction({
    realityEvent: event,
    predictionRef: { predictionId: prediction.predictionId, opensAt: prediction.observationWindow.opensAt,
      closesAt: prediction.observationWindow.closesAt, predictionCreatedAt: prediction.createdAt }
  });
  const settlement = P3.createRuntimePredictionSettlement({ clock: () => now + 25 * 60 * 60 * 1000 });
  const settled = settlement.settlePrediction(prediction, [{ observation: outcomeObservation.observation }], {
    now: now + 25 * 60 * 60 * 1000
  });
  return { reality, registry, prediction, settlement, settled };
}

(async function main() {
  const responseState = { calls: 0, lastRequest: null };
  const runtime = makeQRuntime(standardResponse(), responseState);
  const result = await runtime.derive(qInput(), { remainingBudgetMs: 800 });
  check('Q1.oneRealPremiseProducesOneBoundedAlternative', result.ok === true
    && result.view.schemaVersion === 'counterfactual-view-v1'
    && result.view.factualAnchorRefs.join(',') === MEMORY_ID
    && result.view.changedPremise.memoryRefs.join(',') === MEMORY_ID
    && result.view.alternativeOutcome.length <= 360
    && responseState.calls === 1);
  check('Q2.actualAndAlternativeOutcomesRemainSeparate', result.view.actualOutcome.statement === ACTUAL_CLAIM
    && result.view.actualOutcome.claimAuthority === 'CANONICAL_MEMORY_RECORD_CLAIM_NOT_WORLD_FACT'
    && result.view.alternativeOutcome !== result.view.actualOutcome.statement
    && result.view.observed === false && result.view.canonicalEvidence === false);
  check('Q3.weakKOnlyCausalBasisIsUncertain', result.view.uncertainty === 'uncertain'
    && result.view.causalBasis.some((row) => row.type === 'current-interpretation')
    && result.view.causalRelationProven === false);
  const noOverlap = qInput({ currentMessage: 'If a third person appeared, what might have changed?' });
  const callsBeforeUnsupported = responseState.calls;
  const unsupported = await runtime.derive(noOverlap, { remainingBudgetMs: 800 });
  check('Q4.unanchoredPremiseCreatesNoAlternativeOrProviderCall', unsupported.ok === false
    && unsupported.view === null && unsupported.uncertainty === 'unsupported'
    && responseState.calls === callsBeforeUnsupported);

  const inventedState = { calls: 0, lastRequest: null };
  const inventedRuntime = makeQRuntime({ items: [{ basedOnMemoryIds: [MEMORY_ID],
    alternativeOutcome: 'A third person might have appeared and changed everything.',
    causalRationale: 'An additional participant could have changed the outcome.' }] }, inventedState);
  const invented = await inventedRuntime.derive(qInput(), { remainingBudgetMs: 800 });
  check('Q5.unsupportedHistoricalParticipantIsRejected', invented.ok === false
    && invented.view === null && inventedState.calls === 1);
  const rewriteState = { calls: 0, lastRequest: null };
  const rewriteRuntime = makeQRuntime({ items: [Object.assign(standardResponse().items[0], {
    actualOutcome: 'The argument did not happen.'
  })] }, rewriteState);
  const rewrite = await rewriteRuntime.derive(qInput(), { remainingBudgetMs: 800 });
  check('Q5b.modelCannotRewriteThePreservedActualOutcome', rewrite.ok === false
    && rewrite.view === null && rewriteState.calls === 1);

  const { reality, registry, prediction, settlement, settled } = await sealedPredictionErrorEvidence();
  const sealedState = { calls: 0, lastRequest: null };
  const sealedRuntime = makeQRuntime(standardResponse(), sealedState, {
    predictionRegistry: registry, predictionSettlement: settlement, realityEventAuthority: reality,
    clock: () => 1760000000000 + 25 * 60 * 60 * 1000
  });
  const withPE = await sealedRuntime.derive(qInput(), { remainingBudgetMs: 800 });
  const sameSettlement = settlement.getSettlement(prediction.predictionId);
  check('Q6.sealedPredictionErrorAndOutcomeAreReadOnlyEvidence', withPE.ok === true
    && withPE.view.causalBasis.some((row) => row.type === 'prediction-error'
      && row.predictionError && row.predictionError.settlementState === settled.settlement.state)
    && withPE.view.causalBasis.some((row) => row.type === 'explicit-event-causation')
    && withPE.view.uncertainty === 'plausible'
    && withPE.view.provenance.predictionErrorRefs.length === 1
    && sameSettlement === settled.settlement
    && registry.listOpenPredictions({ characterId: CHARACTER_ID, conversationId: CONVERSATION_ID }).length === 1,
    { ok: withPE.ok, reason: withPE.reason, uncertainty: withPE.view && withPE.view.uncertainty,
      basis: withPE.view && withPE.view.causalBasis });

  const fadedState = { calls: 0, lastRequest: null };
  const fadedRuntime = makeQRuntime(standardResponse(), fadedState);
  const faded = await fadedRuntime.derive(qInput({
    metaMemoryAwareness: { memoryStates: [{ memoryId: MEMORY_ID, state: 'faded', factualDetail: 'faded' }] },
    reconstructedRecollection: { memoryRefs: [MEMORY_ID], reliabilityState: 'partial', preservedFacts: [] }
  }), { remainingBudgetMs: 800 });
  check('Q7.fadedOrUncertainMemoryIsNotElevatedToFactualAnchor', faded.ok === false
    && faded.view === null && faded.uncertainty === 'unsupported' && fadedState.calls === 0);

  const disputeState = { calls: 0, lastRequest: null };
  const disputeRuntime = makeQRuntime(standardResponse(), disputeState);
  const disputed = await disputeRuntime.derive(qInput({ sharedMemoryView: { views: [{ relation: 'disputed',
    characterSide: { memoryRefs: [MEMORY_ID] }, userSide: { userReportRefs: ['user-report-1'] } }] } }), { remainingBudgetMs: 800 });
  check('Q8.sharedMemoryDisputeCannotBeAdjudicatedByCounterfactual', disputed.ok === false
    && disputed.view === null && disputeState.calls === 0);
  const edgeDisputeState = { calls: 0, lastRequest: null };
  const edgeDisputeRuntime = makeQRuntime(standardResponse(), edgeDisputeState);
  const edgeDispute = await edgeDisputeRuntime.derive(qInput({
    association: { edges: [{ anchorMemoryId: MEMORY_ID, relatedMemoryId: 'user-memory',
      relation: 'conflict', basis: ['provenance_reference'], pairRole: 'anchor_candidate' }] }
  }), { remainingBudgetMs: 800 });
  check('Q8b.unresolvedR3ConflictAlsoBlocksSingleOutcome', edgeDispute.ok === false
    && edgeDispute.view === null && edgeDisputeState.calls === 0);

  const failureState = { calls: 0, lastRequest: null };
  const failureRuntime = makeQRuntime('throw', failureState);
  const failure = await failureRuntime.derive(qInput(), { remainingBudgetMs: 800 });
  check('Q9.providerFailureReturnsNoCounterfactual', failure.ok === false
    && failure.view === null && failure.providerCalls === 1 && failureState.calls === 1);

  const replayState = { calls: 0, lastRequest: null };
  const replayRuntime = makeQRuntime(standardResponse(), replayState);
  const replayFirst = await replayRuntime.derive(qInput(), { remainingBudgetMs: 800 });
  const replaySecond = await replayRuntime.derive(qInput(), { remainingBudgetMs: 800 });
  check('Q10.sameEvidenceReplayDoesNotCallProviderAgain', replayFirst.ok === true && replaySecond.ok === true
    && JSON.stringify(replayFirst.view) === JSON.stringify(replaySecond.view) && replayState.calls === 1);

  const status = runtime.describe();
  check('Q11.allHardMutationAssertionsAreZero', status.COUNTERFACTUAL_RUNTIME === 'LIVE'
    && status.CANONICAL_MEMORY_MUTATION === 0 && status.PREDICTION_CREATION === 0
    && status.PREDICTION_CREATION_FROM_COUNTERFACTUAL === 0
    && status.PREDICTION_ERROR_MUTATION === 0
    && status.PREDICTION_SETTLEMENT_MUTATION === 0 && status.P4_MUTATION === 0
    && status.SELF_NARRATIVE_MUTATION === 0 && status.RELATIONSHIP_MUTATION === 0
    && status.PERSONA_MUTATION === 0 && status.BEHAVIOR_MODULATION_MUTATION === 0
    && JSON.stringify(MEMORY_RECORD) === MEMORY_RECORD_SNAPSHOT);

  const seamView = { schemaVersion: 'counterfactual-view-v1', uncertainty: 'uncertain', observed: false };
  const seamRuntime = createRuntimeRecall({ clock: () => 1760000100000, logger: () => {}, counterfactualMemory: {
    derive: async function () { return { ok: true, status: 'succeeded', view: seamView,
      text: '实际结果仍成立；另一路径可能不同。', durable: false, providerCalls: 1 }; },
    describe: function () { return CORE.describe(); }
  } });
  const requestId = 'q-seam-request', conversationId = 'q-seam-conversation';
  const seam = await seamRuntime.deriveFromExistingRecall({
    characterId: CHARACTER_ID, conversationId: conversationId, requestId: requestId,
    turnId: createRuntimeRecall.deriveStableTurnId(requestId, conversationId),
    message: CURRENT_MESSAGE, selectedIds: [MEMORY_ID], memoryText: 'Original Recall.', remainingBudgetMs: 800
  });
  check('Q12.onePostKLOProductionSeamKeepsChatAndPromptPrivate', seam.ok === true
    && seam.counterfactualMemoryView === seamView
    && seam.counterfactualMemoryText.includes('另一路径')
    && seam.durable === false);
  const runtimeSource = fs.readFileSync(path.join(ROOT, 'services/home-node/runtime-counterfactual-memory.js'), 'utf8');
  check('Q13.P3P1IntegrationIsReadOnlyAndDoesNotReachP4',
    /predictionSettlement\.getSettlement\(/.test(runtimeSource)
      && /predictionSettlement\.getPredictionError\(/.test(runtimeSource)
      && /realityEventAuthority\.getRealityEventById\(/.test(runtimeSource)
      && !/\.settlePrediction\s*\(/.test(runtimeSource)
      && !/projectFromValidatedExpectation\s*\(/.test(runtimeSource)
      && !/calibration(Runtime|Driver|Counted|Confidence)/i.test(runtimeSource));

  const failedSeamRuntime = createRuntimeRecall({ clock: () => 1760000100000, logger: () => {},
    counterfactualMemory: { derive: async function () { throw new Error('injected-q-failure'); } } });
  const failRequestId = 'q-fallback-request', failConversationId = 'q-fallback-conversation';
  const failedSeam = await failedSeamRuntime.deriveFromExistingRecall({
    characterId: CHARACTER_ID, conversationId: failConversationId, requestId: failRequestId,
    turnId: createRuntimeRecall.deriveStableTurnId(failRequestId, failConversationId),
    message: CURRENT_MESSAGE, selectedIds: [MEMORY_ID], candidateRecords: [MEMORY_RECORD],
    memoryText: 'Original Recall remains available.', remainingBudgetMs: 800,
    semanticForgettingById: [{ memoryId: MEMORY_ID, projection: {
      schemaVersion: 'semantic-forgetting-v1', accessibility: 'accessible', factualDetail: 'accessible',
      emotionalResidue: 'accessible', narrativeMeaning: 'accessible', resurfaced: false
    } }],
    memoryProvenanceById: [{ memoryId: MEMORY_ID, authorSide: 'character_recollection',
      provenanceState: 'clear', kind: 'episodic', upstreamCount: 0 }]
  });
  check('Q14.runtimeFailureLeavesRecallAndChatUsable', failedSeam.ok === true
    && failedSeam.memoryAwarenessText.includes('只根据本轮已召回记录')
    && failedSeam.counterfactualMemoryText === '' && failedSeam.counterfactualMemoryView === null);

  console.log('\nCOUNTERFACTUAL MEMORY PRODUCT E2E · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error('COUNTERFACTUAL MEMORY PRODUCT E2E CRASHED · ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
