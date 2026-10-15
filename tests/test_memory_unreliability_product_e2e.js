'use strict';

/* P21-R4-O · deterministic reconstructive-recall reliability projection.
 * Inputs are existing H/N/K/L and Association outputs; this test never writes
 * Memory or calls a provider. */
const CORE = require('../assets/js/memory-recall/memory-unreliability-core.js');
const RETRIEVAL = require('../assets/js/memory-retrieval-core.js');
const createRuntimeRecall = require('../services/home-node/runtime-recall.js').createRuntimeRecall;

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail))); }
}
function memoryState(id, overrides) {
  return Object.assign({
    memoryId: id, state: 'remembered', factualDetail: 'remembered', emotionalResidue: 'remembered',
    narrativeMeaning: 'remembered', source: 'selected_recall', resurfaced: false
  }, overrides || {});
}
function awareness(options) {
  const o = options || {};
  const ids = o.ids || ['mem-a', 'mem-b'];
  const factIds = o.historicalFactMemoryIds || ['mem-a'];
  const knowledgeIds = o.currentKnowledgeMemoryIds || (o.leakage === false ? [] : ['mem-b']);
  const beliefIds = o.currentBeliefMemoryIds || (o.leakage === false ? [] : ['mem-b']);
  return {
    schemaVersion: 'meta-memory-awareness-v1', authority: 'DERIVED_MEMORY_STATE_AWARENESS', durability: 'TURN_SCOPED',
    memoryStates: ids.map((id) => memoryState(id, (o.memoryStates || {})[id])),
    reinterpretation: {
      state: o.interpretationState || 'interpretation_only', authority: 'DERIVED_CURRENT_INTERPRETATION',
      source: 'current_derived_interpretation', historicalClaimsAreWorldFacts: 'NO',
      uncertainty: o.interpretationUncertainty || 'low',
      historicalFactMemoryIds: factIds, historicalEmotionMemoryIds: factIds,
      currentKnowledgeMemoryIds: knowledgeIds, currentBeliefMemoryIds: beliefIds,
      directMemoryIds: ids.slice(0, 2), associatedMemoryIds: [], associationRelations: [],
      interpretationRef: 'sha256-v1:k-current-meaning'
    },
    selfNarrative: {
      state: o.narrativeState || 'interpretation_only', authority: 'DERIVED_CURRENT_NARRATIVE',
      source: 'current_derived_narrative', uncertainty: o.narrativeUncertainty || 'low',
      evidenceMemoryIds: ids.slice(), interpretationRefs: ['sha256-v1:k-current-meaning'], claims: []
    }
  };
}
function edge(anchor, related, relation, basis) {
  return { anchorMemoryId: anchor, relatedMemoryId: related, relation: relation,
    basis: basis.slice(), pairRole: 'anchor_candidate' };
}
function provenance(id, state, kind, upstream) {
  return { memoryId: id, provenanceState: state || 'clear', kind: kind || 'episodic',
    upstreamCount: Array.isArray(upstream) ? upstream.length : (Number(upstream) || 0) };
}
function forgettingState(value) {
  if (value === 'remembered') return 'accessible';
  if (value === 'partial') return 'suppressed';
  if (value === 'faded') return 'faded';
  return 'latent';
}
function derive(options) {
  const o = options || {};
  const meta = o.metaMemoryAwareness || awareness(o.awarenessOptions);
  return CORE.derive({
    metaMemoryAwareness: meta,
    semanticForgettingById: meta.memoryStates.map((row) => ({
      memoryId: row.memoryId,
      projection: {
        schemaVersion: 'semantic-forgetting-v1',
        accessibility: forgettingState(row.state),
        factualDetail: forgettingState(row.factualDetail),
        emotionalResidue: forgettingState(row.emotionalResidue),
        narrativeMeaning: forgettingState(row.narrativeMeaning),
        resurfaced: row.resurfaced
      }
    })),
    associationEdges: o.associationEdges || [],
    memoryProvenanceById: o.memoryProvenanceById || [provenance('mem-a'), provenance('mem-b')]
  });
}

(function deterministicCases() {
  const omission = derive({ awarenessOptions: { memoryStates: {
    'mem-a': { state: 'faded', factualDetail: 'faded', emotionalResidue: 'remembered', narrativeMeaning: 'remembered' }
  } } });
  const omissionGuidance = CORE.renderGuidance(omission);
  check('O1.fadedDetailProducesOmissionWithoutReplacementContent', omission.ok === true
    && omission.recollection.distortionTypes.includes('omission')
    && omission.recollection.uncertainDetails.some((row) => row.memoryIds.includes('mem-a')
      && row.dimension === 'factual_detail' && row.state === 'faded')
    && omissionGuidance.includes('不要用推测补齐')
    && !JSON.stringify(omission.recollection).includes('invented event text'));

  const blend = derive({
    awarenessOptions: { memoryStates: {
      'mem-a': { state: 'partial', factualDetail: 'partial' }
    } },
    associationEdges: [edge('mem-a', 'mem-b', 'support', ['same_recall_cluster', 'lexical_overlap'])]
  });
  check('O2.blendingRequiresTwoRealRelatedSelectedMemoriesAndMetaUncertainty', blend.ok === true
    && blend.recollection.distortionTypes.includes('blending')
    && blend.recollection.blendedSources.length === 1
    && blend.recollection.blendedSources[0].sourceMemoryIds.join(',') === 'mem-a,mem-b'
    && blend.recollection.fabricatedEventCreation === 0
    && CORE.renderGuidance(blend).includes('不要把它们合成新事件'));

  const temporal = derive({
    awarenessOptions: { memoryStates: {
      'mem-a': { state: 'faded', factualDetail: 'faded' }
    } },
    associationEdges: [edge('mem-a', 'mem-b', 'continuation', ['temporal_proximity', 'lexical_overlap'])]
  });
  check('O3.temporalProximityOnlyProducesChronologyUncertaintyWithFadedDetail', temporal.ok === true
    && temporal.recollection.distortionTypes.includes('temporal_blur')
    && temporal.recollection.uncertainDetails.some((row) => row.dimension === 'temporal_order')
    && CORE.renderGuidance(temporal).includes('不等于事件先后已知'));

  const sourceBlur = derive({
    awarenessOptions: { interpretationState: 'uncertain', interpretationUncertainty: 'unresolved',
      memoryStates: { 'mem-a': { state: 'faded', factualDetail: 'faded' } } },
    memoryProvenanceById: [provenance('mem-a', 'ambiguous'), provenance('mem-b', 'clear')]
  });
  check('O4.ambiguousProvenanceRequiresMetaMemoryUncertaintyForSourceBlur', sourceBlur.ok === true
    && sourceBlur.recollection.distortionTypes.includes('source_blur')
    && sourceBlur.recollection.uncertainDetails.some((row) => row.dimension === 'source_attribution'));

  const leakage = derive({
    awarenessOptions: { ids: ['mem-a', 'mem-b'], historicalFactMemoryIds: ['mem-a'],
      currentKnowledgeMemoryIds: ['mem-b'], currentBeliefMemoryIds: ['mem-b'] },
    memoryProvenanceById: [provenance('mem-a', 'clear'), provenance('mem-b', 'clear')]
  });
  check('O5.laterInterpretationCannotBecomeHistoricalKnowledge', leakage.ok === true
    && leakage.recollection.distortionTypes.includes('interpretation_leakage')
    && leakage.recollection.interpretationLeakage[0].historicalMemoryIds.join(',') === 'mem-a'
    && leakage.recollection.interpretationLeakage[0].currentMeaningMemoryIds.join(',') === 'mem-b'
    && leakage.recollection.preservedFacts[0].claimAuthority === 'CANONICAL_MEMORY_CLAIM_NOT_WORLD_FACT'
    && CORE.renderGuidance(leakage).includes('当前解释不是事件发生时已经知道的证据'));

  const sameSourceLeakage = derive({
    awarenessOptions: { ids: ['mem-a'], historicalFactMemoryIds: ['mem-a'],
      currentKnowledgeMemoryIds: ['mem-a'], currentBeliefMemoryIds: ['mem-a'] },
    memoryProvenanceById: [provenance('mem-a', 'clear')]
  });
  check('O5b.sameMemorySourceStillKeepsHistoricalAndCurrentClaimLayersSeparate',
    sameSourceLeakage.ok === true
      && sameSourceLeakage.recollection.distortionTypes.includes('interpretation_leakage')
      && sameSourceLeakage.recollection.interpretationLeakage[0].historicalMemoryIds[0] === 'mem-a'
      && sameSourceLeakage.recollection.interpretationLeakage[0].currentMeaningMemoryIds[0] === 'mem-a');

  const clear = derive({
    awarenessOptions: { ids: ['mem-a'], historicalFactMemoryIds: ['mem-a'], leakage: false },
    associationEdges: [], memoryProvenanceById: [provenance('mem-a', 'clear')]
  });
  check('O6.rememberedFactWithClearProvenanceStaysUndistorted', clear.ok === true
    && clear.recollection.reliabilityState === 'reliable'
    && clear.recollection.distortionTypes.join(',') === 'none'
    && clear.recollection.preservedFacts.length === 1);

  const uncertainGate = derive({
    awarenessOptions: { interpretationState: 'uncertain', interpretationUncertainty: 'high',
      narrativeState: 'uncertain', narrativeUncertainty: 'unresolved', memoryStates: {
        'mem-a': { state: 'faded', factualDetail: 'faded' }
      } },
    associationEdges: [edge('mem-a', 'mem-b', 'support', ['same_recall_cluster'])]
  });
  check('O7.MetaMemoryUncertaintySurvivesAsAnExplicitGate', uncertainGate.ok === true
    && uncertainGate.recollection.reliabilityState === 'uncertain'
    && uncertainGate.recollection.distortionTypes.includes('omission')
    && uncertainGate.recollection.distortionTypes.includes('blending'));

  const noCandidate = derive({
    awarenessOptions: { ids: ['mem-a'], historicalFactMemoryIds: ['mem-a'], leakage: false,
      memoryStates: { 'mem-a': { state: 'faded', factualDetail: 'faded' } } },
    associationEdges: [], memoryProvenanceById: [provenance('mem-a', 'clear')]
  });
  check('O8.noRealSimilarMemoryNeverCreatesBlendOrThirdEvent', noCandidate.ok === true
    && noCandidate.recollection.memoryRefs.join(',') === 'mem-a'
    && noCandidate.recollection.blendedSources.length === 0
    && noCandidate.recollection.fabricatedEventCreation === 0
    && !noCandidate.recollection.distortionTypes.includes('blending'));

  const invalid = CORE.derive({ metaMemoryAwareness: { schemaVersion: 'wrong' }, associationEdges: [], memoryProvenanceById: [] });
  check('O9.invalidMetaMemoryProjectionProducesNoDistortion', invalid.ok === false
    && invalid.recollection === null && CORE.renderGuidance(invalid) === '');
  const missingForgetting = CORE.derive({ metaMemoryAwareness: awareness(), semanticForgettingById: [],
    associationEdges: [], memoryProvenanceById: [] });
  check('O9b.missingHProjectionFailsOpenWithoutOText', missingForgetting.ok === false
    && missingForgetting.recollection === null && CORE.renderGuidance(missingForgetting) === '');

  const status = CORE.describe();
  check('O10.authorityAndHardMutationAssertionsAreFrozenAtZero', status.MEMORY_UNRELIABILITY_RUNTIME === 'LIVE'
    && status.RECONSTRUCTED_RECOLLECTION === 'LIVE'
    && status.META_MEMORY_GATES_UNRELIABILITY === 'YES'
    && status.FABRICATED_EVENT_CREATION === 0 && status.CANONICAL_MEMORY_MUTATION === 0
    && status.CANONICAL_MEMORY_REWRITE === 0 && status.CANONICAL_MEMORY_DELETE === 0
    && status.PROVENANCE_REWRITE === 0
    && status.SEMANTIC_FORGETTING_MUTATION === 0 && status.META_MEMORY_MUTATION === 0
    && status.RELATIONSHIP_MUTATION === 0 && status.PERSONA_MUTATION === 0
    && status.SELF_NARRATIVE_MUTATION === 0 && status.BEHAVIOR_MODULATION_MUTATION === 0
    && status.PREDICTION_ERROR_MUTATION === 0);

  const day = 24 * 60 * 60 * 1000, now = 2000 * day;
  const consolidated = {
    id: 'mem-consolidated', title: 'merged-source summary', summary: 'A shared event theme.',
    oneLine: 'A shared event theme.', content: 'CONSOLIDATED_BODY_SENTINEL',
    kind: 'semantic', source: 'consolidation', sourceId: 'role-o',
    consolidatedFrom: ['mem-source-a', 'mem-source-b'], evidenceIds: [],
    valence: 0.1, arousal: 0.9, importance: 8, resolved: false, pinned: false,
    created: now - 120 * day, lastActivated: now - 120 * day,
    visibility: 'public', visibleTo: [], excludeFrom: [], domain: '日常', tags: []
  };
  const provenanceProjection = RETRIEVAL.buildMemoryContext([consolidated], {
    apiId: 'role-o', now: now, userMessage: 'merged-source summary', includeHeader: false,
    allowExploration: false, includeSemanticForgettingMeta: true
  });
  check('O10b.selectedConsolidationProvenanceIsBoundedWithoutMemoryBody',
    provenanceProjection.selected.length === 1
      && provenanceProjection.memoryProvenanceById.length === 1
      && provenanceProjection.memoryProvenanceById[0].memoryId === 'mem-consolidated'
      && provenanceProjection.memoryProvenanceById[0].provenanceState === 'ambiguous'
      && provenanceProjection.memoryProvenanceById[0].upstreamCount === 2
      && !JSON.stringify(provenanceProjection.memoryProvenanceById).includes('CONSOLIDATED_BODY_SENTINEL'));
})();

async function runtimeFallback() {
  const failCore = { derive: function () { throw new Error('injected-recollection-projection-failure'); } };
  const runtime = createRuntimeRecall({ memoryUnreliabilityCore: failCore, clock: () => 10000, logger: () => {} });
  const candidateRecord = { id: 'mem-fallback', content: 'Canonical source body stays unchanged.',
    source: 'user', kind: 'episodic', consolidatedFrom: [], created: 1000 };
  const candidateBefore = JSON.stringify(candidateRecord);
  const requestId = 'o-failure-request', conversationId = 'o-failure-conversation';
  const result = await runtime.deriveFromExistingRecall({
    characterId: 'role-o', conversationId: conversationId, requestId: requestId,
    turnId: createRuntimeRecall.deriveStableTurnId(requestId, conversationId),
    message: 'Recall this old event carefully.', selectedIds: ['mem-fallback'],
    candidateRecords: [candidateRecord], candidateRecordsTruncated: false,
    semanticForgettingById: [{ memoryId: 'mem-fallback', projection: {
      schemaVersion: 'semantic-forgetting-v1', accessibility: 'faded', factualDetail: 'faded',
      emotionalResidue: 'accessible', narrativeMeaning: 'faded', resurfaced: false
    } }], memoryText: 'Existing normal Recall.', remainingBudgetMs: 5000
  });
  check('O11.failureUsesOriginalRecallAndMetaMemoryWithoutDistortion', result.ok === true
    && result.memoryAwarenessText.includes('只根据本轮已召回记录')
    && result.memoryUnreliabilityText === ''
    && result.reconstructedRecollection === null);
  check('O12.failureLeavesCanonicalCandidateAndAllWritersUntouched',
    JSON.stringify(candidateRecord) === candidateBefore
      && runtime.describe().memoryUnreliability.CANONICAL_MEMORY_MUTATION === 0
      && runtime.describe().memoryUnreliability.SEMANTIC_FORGETTING_MUTATION === 0
      && runtime.describe().memoryUnreliability.META_MEMORY_MUTATION === 0);
  console.log('\nMEMORY UNRELIABILITY PRODUCT E2E · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

async function runtimeStructuredSuccess() {
  const runtime = createRuntimeRecall({ clock: () => 20000, logger: () => {} });
  const requestId = 'o-structured-request', conversationId = 'o-structured-conversation';
  const result = await runtime.deriveFromExistingRecall({
    characterId: 'role-o', conversationId: conversationId, requestId: requestId,
    turnId: createRuntimeRecall.deriveStableTurnId(requestId, conversationId),
    message: 'I remember a clear event.', selectedIds: ['mem-clear'],
    semanticForgettingById: [{ memoryId: 'mem-clear', projection: {
      schemaVersion: 'semantic-forgetting-v1', accessibility: 'accessible', factualDetail: 'accessible',
      emotionalResidue: 'accessible', narrativeMeaning: 'accessible', resurfaced: false
    } }],
    memoryProvenanceById: [{ memoryId: 'mem-clear', provenanceState: 'clear', kind: 'episodic', upstreamCount: 0 }],
    memoryText: 'Existing clear Recall.', remainingBudgetMs: 5000
  });
  check('O13.runtimeReturnsStructuredRecollectionWithoutNewModelCall', result.ok === true
    && result.reconstructedRecollection.schemaVersion === 'reconstructed-recollection-v1'
    && result.reconstructedRecollection.reliabilityState === 'reliable'
    && result.reconstructedRecollection.distortionTypes.join(',') === 'none'
    && result.memoryUnreliabilityText.includes('不要为了显得像人而扭曲清晰记忆'));
}

runtimeStructuredSuccess().then(runtimeFallback).catch((error) => {
  console.error('MEMORY UNRELIABILITY PRODUCT E2E CRASHED · ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
