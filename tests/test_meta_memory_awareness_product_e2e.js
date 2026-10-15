'use strict';

/* P21-R4-N · awareness is a turn-scoped projection of already-selected
 * Recall/H/K/L results. The suite uses pure fixtures plus the production
 * shared Recall core and an injected runtime failure; no store writers or
 * provider calls are used. */
const CORE = require('../assets/js/memory-retrieval-core.js');
const META = require('../assets/js/memory-recall/meta-memory-awareness-core.js');
const createMemoryRetrieval = require('../services/home-node/memory-retrieval.js');
const createRuntimeRecall = require('../services/home-node/runtime-recall.js').createRuntimeRecall;

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail))); }
}

function forgetting(overrides) {
  return Object.assign({
    schemaVersion: 'semantic-forgetting-v1', accessibility: 'accessible',
    factualDetail: 'accessible', emotionalResidue: 'accessible',
    narrativeMeaning: 'accessible', resurfaced: false
  }, overrides || {});
}
function meaning(uncertainty) {
  return {
    summary: 'The current explanation is a later understanding.',
    historicalFacts: [{ memoryId: 'mem-event', statement: 'The record says the user did not arrive.' }],
    historicalEmotions: [{ memoryId: 'mem-event', statement: 'The record says this felt painful.' }],
    currentKnowledge: [{ memoryId: 'mem-correction', statement: 'A later correction supplied new context.' }],
    currentBeliefs: [{ memoryId: 'mem-correction', statement: 'I currently think the absence was not intentional.' }],
    uncertainty: uncertainty || 'low'
  };
}
function interpretation(uncertainty, overrides) {
  const currentMeaning = Object.assign(meaning(uncertainty), overrides || {});
  return {
    ok: true, status: 'succeeded', contextualInterpretation: {
      identity: { value: 'sha256-v1:interpretation-ref' }, currentMeaning: currentMeaning
    }
  };
}
function narrative(uncertainty) {
  return {
    ok: true, status: 'created', narrative: {
      evidenceMemoryIds: ['mem-event', 'mem-correction'],
      interpretationRefs: ['sha256-v1:interpretation-ref'],
      narrative: {
        themes: [{ scope: 'self', statement: 'A later understanding can coexist with earlier hurt.', evidenceMemoryIds: ['mem-event', 'mem-correction'] }],
        currentBeliefs: [{ scope: 'self', statement: 'I now understand the event differently.', evidenceMemoryIds: ['mem-correction'] }],
        relationshipBeliefs: [], unresolvedTensions: [], resolvedTensions: [],
        turningPoints: [], continuityClaims: [], uncertainty: uncertainty || 'low'
      }
    }
  };
}
function derive(options) {
  const o = options || {};
  return META.derive({
    selectedIds: o.selectedIds || ['mem-event', 'mem-correction'],
    semanticForgettingById: o.semanticForgettingById || [
      { memoryId: 'mem-event', projection: forgetting(o.eventForgetting) },
      { memoryId: 'mem-correction', projection: forgetting() }
    ],
    reinterpretationResult: Object.prototype.hasOwnProperty.call(o, 'interpretationResult')
      ? o.interpretationResult : interpretation(o.interpretationUncertainty),
    reinterpretationTrace: o.interpretationTrace || {
      identity: { value: 'sha256-v1:interpretation-ref' },
      directMemoryIds: ['mem-event'], associatedMemoryIds: ['mem-correction'],
      relationsUsed: [{ anchorMemoryId: 'mem-event', relatedMemoryId: 'mem-correction',
        relation: 'correction', basis: ['provenance_reference'], pairRole: 'anchor_candidate' }]
    },
    selfNarrativeResult: Object.prototype.hasOwnProperty.call(o, 'selfNarrativeResult')
      ? o.selfNarrativeResult : narrative(o.narrativeUncertainty)
  });
}

(function pureAwarenessCases() {
  const clear = derive();
  check('N1.clearSelectedFactIsRemembered', clear.ok === true
    && clear.awareness.memoryStates[0].factualDetail === 'remembered'
    && clear.awareness.memoryStates[0].state === 'remembered');

  const fadedFact = derive({ eventForgetting: {
    accessibility: 'accessible', factualDetail: 'faded', emotionalResidue: 'accessible', narrativeMeaning: 'accessible'
  } });
  check('N2.fadedFactualDetailAndRememberedEmotionRemainSeparate', fadedFact.ok === true
    && fadedFact.awareness.memoryStates[0].factualDetail === 'faded'
    && fadedFact.awareness.memoryStates[0].emotionalResidue === 'remembered'
    && fadedFact.awareness.memoryStates[0].narrativeMeaning === 'remembered');
  const replayOne = JSON.stringify(derive({ interpretationUncertainty: 'high' }));
  const replayTwo = JSON.stringify(derive({ interpretationUncertainty: 'high' }));
  check('N2b.sameEvidenceAndContextReplayIsDeterministic', replayOne === replayTwo);

  const fadedAffect = derive({ eventForgetting: {
    accessibility: 'accessible', factualDetail: 'accessible', emotionalResidue: 'faded', narrativeMeaning: 'accessible'
  } });
  check('N3.weakEmotionCanFadeWhileFactRemainsRemembered', fadedAffect.ok === true
    && fadedAffect.awareness.memoryStates[0].factualDetail === 'remembered'
    && fadedAffect.awareness.memoryStates[0].emotionalResidue === 'faded');
  const fadedMeaning = derive({ eventForgetting: {
    accessibility: 'faded', factualDetail: 'faded', emotionalResidue: 'faded', narrativeMeaning: 'faded'
  } });
  check('N3b.narrativeMeaningHasItsOwnAvailabilityState', fadedMeaning.ok === true
    && fadedMeaning.awareness.memoryStates[0].factualDetail === 'faded'
    && fadedMeaning.awareness.memoryStates[0].emotionalResidue === 'faded'
    && fadedMeaning.awareness.memoryStates[0].narrativeMeaning === 'faded');

  const factVsMeaning = derive();
  check('N4.currentInterpretationIsDerivedAndNotTheHistoricalFact', factVsMeaning.ok === true
    && factVsMeaning.awareness.reinterpretation.state === 'interpretation_only'
    && factVsMeaning.awareness.reinterpretation.authority === 'DERIVED_CURRENT_INTERPRETATION'
    && factVsMeaning.awareness.reinterpretation.historicalClaimsAreWorldFacts === 'NO'
    && factVsMeaning.awareness.reinterpretation.source === 'current_derived_interpretation'
    && factVsMeaning.awareness.reinterpretation.historicalFactMemoryIds.join(',') === 'mem-event'
    && factVsMeaning.awareness.reinterpretation.currentBeliefMemoryIds.join(',') === 'mem-correction');

  const unresolved = derive({ interpretationUncertainty: 'unresolved', narrativeUncertainty: 'unresolved' });
  const unresolvedGuidance = META.renderGuidance(unresolved);
  check('N5.unresolvedReinterpretationRemainsUncertain', unresolved.ok === true
    && unresolved.awareness.reinterpretation.state === 'uncertain'
    && unresolved.awareness.reinterpretation.uncertainty === 'unresolved'
    && unresolvedGuidance.includes('不确定'));

  const provenance = derive();
  const narrativeClaim = provenance.awareness.selfNarrative.claims.find((claim) => claim.section === 'currentBeliefs');
  check('N6.narrativeClaimKeepsProvenanceAndDerivedAuthority', !!narrativeClaim
    && narrativeClaim.state === 'interpretation_only'
    && narrativeClaim.evidenceMemoryIds.join(',') === 'mem-correction'
    && provenance.awareness.selfNarrative.interpretationRefs[0] === 'sha256-v1:interpretation-ref'
    && provenance.awareness.reinterpretation.associationRelations[0].relation === 'correction');

  const prompt = META.renderGuidance(fadedFact);
  check('N7.guidanceDoesNotRepeatMemoryOrInventMissingSpecifics', prompt.includes('原话')
    && prompt.includes('未知就保持未知')
    && prompt.includes('情绪印象可能仍然清楚')
    && prompt.includes('不要求主动提起')
    && !prompt.includes('mem-event')
    && !prompt.includes('mem-correction')
    && !prompt.includes('The record says the user did not arrive'));

  const invalid = derive({ semanticForgettingById: [
    { memoryId: 'mem-event', projection: { schemaVersion: 'semantic-forgetting-v1', accessibility: 'certain',
      factualDetail: 'accessible', emotionalResidue: 'accessible', narrativeMeaning: 'accessible', resurfaced: false } }
  ] });
  check('N8.invalidProjectionFailsClosedToEmptyMetaGuidance', invalid.ok === false
    && META.renderGuidance(invalid) === '');

  const status = META.describe();
  check('N9.authorityIsDerivedTurnScopedAndHasZeroMutation', status.META_MEMORY_RUNTIME === 'LIVE'
    && status.META_MEMORY_IS_DERIVED === 'YES'
    && status.META_MEMORY_DOES_NOT_REWRITE_MEMORY === 'VERIFIED'
    && status.FAILURE_FALLBACK === 'LIVE'
    && status.META_MEMORY_MAY_NOT_MUTATE_SELF_NARRATIVE === 'YES'
    && status.META_MEMORY_MAY_NOT_MUTATE_BEHAVIOR_MODULATION === 'YES'
    && status.META_MEMORY_MAY_NOT_MUTATE_PREDICTION_ERROR === 'YES'
    && status.CANONICAL_MEMORY_MUTATION === 0 && status.SEMANTIC_FORGETTING_MUTATION === 0
    && status.RELATIONSHIP_MUTATION === 0 && status.PERSONA_MUTATION === 0
    && status.SELF_NARRATIVE_MUTATION === 0 && status.BEHAVIOR_MODULATION_MUTATION === 0
    && status.PREDICTION_ERROR_MUTATION === 0);
})();

(function recallProjectionIsOptInAndSelectedOnly() {
  const now = 2000 * 24 * 60 * 60 * 1000;
  const record = {
    id: 'recall-memory', title: 'old event', summary: 'The event mattered.',
    content: 'RAW_MEMORY_SENTINEL exact wording is not for the awareness layer.',
    oneLine: 'The event remained meaningful.', kind: 'episodic', source: 'user',
    domain: '日常', tags: [], valence: 0.1, arousal: 0.9, importance: 6,
    resolved: false, pinned: false, created: now - 120 * 24 * 60 * 60 * 1000,
    lastActivated: now - 120 * 24 * 60 * 60 * 1000,
    visibility: 'public', visibleTo: [], excludeFrom: []
  };
  const recordBefore = JSON.stringify(record);
  const withMeta = CORE.buildMemoryContext([record], {
    apiId: 'role-a', now: now, userMessage: 'old event', includeHeader: false,
    allowExploration: false, includeSemanticForgettingMeta: true
  });
  const defaultResult = CORE.buildMemoryContext([record], {
    apiId: 'role-a', now: now, userMessage: 'old event', includeHeader: false,
    allowExploration: false
  });
  check('N10.sharedRecallCorePassesHProjectionForFinalSelectedIdOnly', withMeta.selected.length === 1
    && withMeta.semanticForgettingById.length === 1
    && withMeta.semanticForgettingById[0].memoryId === withMeta.selected[0].id
    && withMeta.semanticForgettingById[0].projection.factualDetail === 'faded'
    && !Object.prototype.hasOwnProperty.call(defaultResult, 'semanticForgettingById')
    && JSON.stringify(record) === recordBefore
    && !JSON.stringify(withMeta.semanticForgettingById).includes('RAW_MEMORY_SENTINEL'));

  let candidateScans = 0;
  const nodeRetrieval = createMemoryRetrieval({
    store: {
      listRecords: function () { candidateScans += 1; return { ok: true, records: [record] }; },
      getMemorySettings: function () { return { ok: true, settings: { budget: 2000, contentLen: 200 } }; }
    },
    clock: function () { return now; }, random: function () { return 0.5 }
  });
  const mobileRuntime = nodeRetrieval.buildRuntimeContext({
    character: { id: 'role-a', dto: { relationship: '' } }, characterId: 'role-a',
    userMessage: 'old event', currentTime: 'today', now: now
  });
  check('N10b.NodeMobileRetrievalCarriesTheSameHStateFromItsSingleExistingScan',
    mobileRuntime.selectedIds.length === 1
      && mobileRuntime.semanticForgettingById.length === 1
      && mobileRuntime.semanticForgettingById[0].memoryId === mobileRuntime.selectedIds[0]
      && mobileRuntime.semanticForgettingById[0].projection.factualDetail === 'faded'
      && mobileRuntime.memoryProvenanceById.length === 1
      && mobileRuntime.memoryProvenanceById[0].memoryId === mobileRuntime.selectedIds[0]
      && mobileRuntime.memoryProvenanceById[0].provenanceState === 'clear'
      && candidateScans === 1);
})();

async function runtimeFailureFallback() {
  const recordOne = { id: 'm-one', title: 'bridge event', content: 'A bridge event was painful.', summary: 'A painful bridge event.',
    oneLine: 'A difficult event.', kind: 'episodic', source: 'user', domain: '日常', tags: [], valence: 0.1,
    arousal: 0.8, importance: 5, resolved: false, pinned: false, created: 1000, lastActivated: 1000,
    visibility: 'public', visibleTo: [], excludeFrom: [] };
  const recordTwo = Object.assign({}, recordOne, { id: 'm-two', title: 'later correction',
    content: 'A later correction supplied context.', summary: 'A later correction.', oneLine: 'Later context.' });
  const records = [recordOne, recordTwo];
  const before = JSON.stringify(records);
  const associationRuntime = {
    expand: async function () {
      return { ok: true, status: 'expanded', providerCalls: 0, result: {
        schemaVersion: 'memory-association-v1', authority: 'DERIVED_RELATION_VIEW', durability: 'RUNTIME_ONLY',
        depth: 1, candidateCount: 2, candidatePairCount: 1, classifiedPairCount: 1,
        expandedCount: 1, contextBudgetChars: 600, chars: 24,
        edges: [{ anchorMemoryId: 'm-one', relatedMemoryId: 'm-two', relation: 'correction',
          basis: ['provenance_reference'], pairRole: 'anchor_candidate' }],
        tensionSets: [], workingSet: [
          { memoryId: 'm-one', activationReasons: ['direct_recall'], anchorMemoryIds: [] },
          { memoryId: 'm-two', activationReasons: ['association_correction'], anchorMemoryIds: ['m-one'] }
        ]
      } };
    }
  };
  const meaningResult = interpretation('medium');
  const interpRuntime = {
    AUTO_INTERPRETATION_CHANNELS: ['surface'],
    runFromAuthoritativeRecall: async function () { return meaningResult; }
  };
  const narrativeView = narrative('medium').narrative;
  const narrativeRuntime = {
    runFromValidatedInterpretation: async function () {
      return { ok: true, status: 'created', providerCalls: 0, narrative: narrativeView,
        trace: { schemaVersion: 'self-narrative-v1', status: 'created', providerCalls: 0 } };
    }
  };
  const failCore = { derive: function () { throw new Error('injected-meta-memory-failure'); } };
  const runtime = createRuntimeRecall({
    associationRuntime: associationRuntime,
    interpretation: interpRuntime,
    selfNarrative: narrativeRuntime,
    metaMemoryAwarenessCore: failCore,
    clock: () => 10000,
    logger: () => {}
  });
  const requestId = 'n-failure-request', conversationId = 'n-failure-conversation';
  const result = await runtime.deriveFromExistingRecall({
    characterId: 'role-a', conversationId: conversationId, requestId: requestId,
    turnId: createRuntimeRecall.deriveStableTurnId(requestId, conversationId),
    message: 'Thinking about the bridge event and later correction.', selectedIds: ['m-one'],
    semanticForgettingById: [{ memoryId: 'm-one', projection: forgetting({ factualDetail: 'faded' }) }],
    candidateRecords: records, candidateRecordsTruncated: false,
    memoryText: 'Existing direct Recall block.', channel: 'surface', remainingBudgetMs: 5000
  });
  check('N11.metaMemoryFailureLeavesRecallInterpretationAndNarrativeUsable', result.ok === true
    && result.reinterpretation && result.reinterpretation.status === 'succeeded'
    && result.selfNarrative && result.selfNarrative.status === 'created'
    && result.memoryAwarenessText === ''
    && JSON.stringify(records) === before);
  check('N12.desktopAndMobileUseSamePrivateRuntimeSeam', runtime.describe().metaMemoryAwareness.desktopConsumption === 'PRIVATE_COGNITION_CONTEXT'
    && runtime.describe().metaMemoryAwareness.mobileConsumption === 'EXISTING_RUNTIME_CONTEXT'
    && runtime.describe().metaMemoryAwareness.consumesRecallAgain === 'NO'
    && runtime.describe().metaMemoryAwareness.memoryDatabaseScan === 'NO');
  console.log('\nMETA-MEMORY AWARENESS PRODUCT E2E · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

runtimeFailureFallback().catch((error) => {
  console.error('META-MEMORY AWARENESS PRODUCT E2E CRASHED · ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
