'use strict';

/* P21-R4-P · two memory perspectives remain separately sourced in a derived
 * relationship view. No Memory writes, report rewrites, or model/provider calls. */
const CORE = require('../assets/js/memory-recall/shared-memory-core.js');
const createRuntimeRecall = require('../services/home-node/runtime-recall.js').createRuntimeRecall;

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail))); }
}
function metaMemory(ids, options) {
  const o = options || {};
  return {
    schemaVersion: 'meta-memory-awareness-v1', authority: 'DERIVED_MEMORY_STATE_AWARENESS', durability: 'TURN_SCOPED',
    states: ['remembered', 'partial', 'uncertain', 'faded', 'interpretation_only', 'unavailable'],
    memoryStates: ids.map((memoryId) => ({
      memoryId: memoryId, state: o.detailState || 'remembered', factualDetail: o.detailState || 'remembered',
      emotionalResidue: 'remembered', narrativeMeaning: 'remembered', source: 'selected_recall', resurfaced: false
    })),
    reinterpretation: {
      state: o.interpretationState || 'interpretation_only', authority: 'DERIVED_CURRENT_INTERPRETATION',
      source: 'current_derived_interpretation', historicalClaimsAreWorldFacts: 'NO',
      uncertainty: o.uncertainty || 'low',
      historicalFactMemoryIds: ['char-a'], historicalEmotionMemoryIds: ['char-a'],
      currentKnowledgeMemoryIds: [], currentBeliefMemoryIds: [], directMemoryIds: ids,
      associatedMemoryIds: [], associationRelations: [], interpretationRef: 'sha256-v1:K-ref'
    },
    selfNarrative: { state: 'interpretation_only', authority: 'DERIVED_CURRENT_NARRATIVE',
      source: 'current_derived_narrative', uncertainty: 'low', evidenceMemoryIds: ids,
      interpretationRefs: ['sha256-v1:K-ref'], claims: [] }
  };
}
function recollection(ids, options) {
  const o = options || {};
  const primaryId = ids[0];
  const uncertainDetails = o.detailState ? [{ memoryIds: [primaryId], dimension: 'factual_detail',
    state: o.detailState, basis: 'R4-H_AND_R4-N', distortionType: 'omission' }] : [];
  return {
    schemaVersion: 'reconstructed-recollection-v1', authority: 'DERIVED_CURRENT_RECOLLECTION', durability: 'TURN_SCOPED',
    memoryRefs: ids.slice(), reliabilityState: o.detailState ? 'partial' : 'reliable',
    distortionTypes: o.detailState ? ['omission'] : ['none'],
    preservedFacts: o.detailState ? [] : [{ memoryId: primaryId, state: 'remembered',
      claimAuthority: 'CANONICAL_MEMORY_CLAIM_NOT_WORLD_FACT' }],
    uncertainDetails: uncertainDetails, blendedSources: [], interpretationLeakage: [],
    IMAGINATION_AS_MEMORY: 'OUT_OF_SCOPE_V1', fabricatedEventCreation: 0
  };
}
function provenance(memoryId, authorSide, overrides) {
  return Object.assign({ memoryId: memoryId, authorSide: authorSide, provenanceState: 'clear',
    kind: 'episodic', upstreamCount: 0 }, overrides || {});
}
function relation(anchor, related, value, basis) {
  return { anchorMemoryId: anchor, relatedMemoryId: related, relation: value,
    basis: basis || ['lexical_overlap'], pairRole: 'anchor_candidate' };
}
function derive(options) {
  const o = options || {};
  return CORE.derive({
    reconstructedRecollection: o.recollection || recollection(['char-a', 'user-b'], o),
    metaMemoryAwareness: o.metaMemoryAwareness || metaMemory(['char-a', 'user-b'], o),
    memoryProvenanceById: o.memoryProvenanceById || [
      provenance('char-a', 'character_recollection'), provenance('user-b', 'user_report')
    ],
    associationEdges: o.associationEdges || [],
    explicitAcknowledgements: o.explicitAcknowledgements || []
  }, { verifyJointAcknowledgement: o.verifyJointAcknowledgement });
}

(function pureViews() {
  const aligned = derive({ associationEdges: [relation('char-a', 'user-b', 'support')] });
  const alignedView = aligned.projection.views[0];
  check('P1.consistentSidesAreAlignedButNotAutomaticallyJoint', aligned.ok === true
    && alignedView.relation === 'aligned'
    && alignedView.characterSide.memoryRefs.join(',') === 'char-a'
    && alignedView.userSide.userReportRefs.join(',') === 'user-b'
    && alignedView.userSide.sourceBasis === 'CANONICAL_USER_AUTHORED_MEMORY_RECORD'
    && alignedView.jointlyAcknowledgedFacts.length === 0);

  const complementary = derive({ associationEdges: [relation('char-a', 'user-b', 'complement')] });
  check('P2.complementaryPerspectivesStaySeparate', complementary.ok === true
    && complementary.projection.views[0].relation === 'complementary'
    && complementary.projection.views[0].topicIdentity.characterMemoryRefs[0] === 'char-a'
    && complementary.projection.views[0].topicIdentity.userReportRefs[0] === 'user-b');

  const asymmetric = derive({ associationEdges: [] });
  check('P3.differentUnlinkedRecordsRemainAsymmetric', asymmetric.ok === true
    && asymmetric.projection.relation === 'asymmetric'
    && asymmetric.projection.views.length === 2
    && asymmetric.projection.views.every((view) => view.relation === 'asymmetric'
      && (!view.characterSide.memoryRefs.length || !view.userSide.userReportRefs.length))
    && asymmetric.projection.views.every((view) => view.unresolvedDifferences[0].resolution === 'COUNTERPART_NOT_AVAILABLE'));

  const disputed = derive({ associationEdges: [relation('char-a', 'user-b', 'conflict', ['lexical_overlap'])] });
  check('P4.conflictIsDisputedWithoutChoosingAWinner', disputed.ok === true
    && disputed.projection.views[0].relation === 'disputed'
    && disputed.projection.views[0].unresolvedDifferences.length === 1
    && disputed.projection.views[0].unresolvedDifferences[0].resolution === 'UNRESOLVED_NO_WINNER');

  const mixed = CORE.derive({
    reconstructedRecollection: recollection(['char-a', 'char-c', 'user-b', 'user-d']),
    metaMemoryAwareness: metaMemory(['char-a', 'char-c', 'user-b', 'user-d']),
    memoryProvenanceById: [provenance('char-a', 'character_recollection'), provenance('char-c', 'character_recollection'),
      provenance('user-b', 'user_report'), provenance('user-d', 'user_report')],
    associationEdges: [relation('char-a', 'user-b', 'support'), relation('char-c', 'user-d', 'complement')]
  });
  check('P4b.mixedEventRelationsKeepSummaryUnresolved', mixed.ok === true
    && mixed.projection.relation === 'unresolved'
    && mixed.projection.views.map((view) => view.relation).sort().join(',') === 'aligned,complementary');

  const ack = {
    schemaVersion: 'shared-history-acknowledgement-v1', authority: 'EXPLICIT_SHARED_HISTORY_ACK',
    confirmationRef: 'ack-42', characterMemoryRefs: ['char-a'], userReportRefs: ['user-b'],
    explicitUserConfirmation: true, explicitCharacterConfirmation: true
  };
  const acknowledged = derive({ associationEdges: [relation('char-a', 'user-b', 'support')],
    explicitAcknowledgements: [ack], verifyJointAcknowledgement: (candidate) => candidate.confirmationRef === 'ack-42' });
  check('P5.jointAcknowledgementRequiresInjectedExplicitAuthority', acknowledged.ok === true
    && acknowledged.projection.views[0].relation === 'jointly_acknowledged'
    && acknowledged.projection.jointlyAcknowledgedFacts.length === 1
    && acknowledged.projection.jointlyAcknowledgedFacts[0].authority === 'VERIFIED_EXPLICIT_ACKNOWLEDGEMENT');

  const unverifiedAck = derive({ associationEdges: [relation('char-a', 'user-b', 'support')],
    explicitAcknowledgements: [ack] });
  check('P6.similarityOrRawAckShapeCannotClaimJointMemory', unverifiedAck.ok === true
    && unverifiedAck.projection.views[0].relation === 'aligned'
    && unverifiedAck.projection.jointlyAcknowledgedFacts.length === 0);

  const uncertainCharacter = derive({ detailState: 'faded', associationEdges: [relation('char-a', 'user-b', 'support')] });
  check('P7.userSideCannotRepairCharacterUnreliability', uncertainCharacter.ok === true
    && uncertainCharacter.projection.views[0].characterSide.reliabilityState === 'partial'
    && uncertainCharacter.projection.views[0].characterSide.distortionTypes.includes('omission')
    && uncertainCharacter.projection.views[0].userSide.reliabilityState === 'NOT_ASSESSED');

  const noAuthor = derive({ memoryProvenanceById: [provenance('mem-unknown', 'unknown')],
    recollection: recollection(['mem-unknown']), metaMemoryAwareness: metaMemory(['mem-unknown']) });
  check('P8.noAuthorizedPerspectivesProducesNoInventedSharedEvent', noAuthor.ok === true
    && noAuthor.status === 'not-needed' && noAuthor.projection.views.length === 0
    && noAuthor.projection.automaticTruthMerge === 0);

  const status = CORE.describe();
  check('P9.authorityAndAllMutationAssertionsAreZero', status.SHARED_MEMORY_RUNTIME === 'LIVE'
    && status.CO_CONSTRUCTED_MEMORY_VIEW === 'LIVE'
    && status.JOINT_ACKNOWLEDGEMENT === 'AUTHORITY_GATED'
    && status.CHARACTER_MEMORY_PRESERVED === 'YES' && status.USER_RECOLLECTION_PRESERVED === 'YES'
    && status.AUTOMATIC_TRUTH_MERGE === 0 && status.CANONICAL_MEMORY_MUTATION === 0
    && status.USER_REPORT_REWRITE === 0 && status.RELATIONSHIP_MUTATION === 0
    && status.PERSONA_MUTATION === 0 && status.SELF_NARRATIVE_MUTATION === 0
    && status.BEHAVIOR_MODULATION_MUTATION === 0 && status.PREDICTION_ERROR_MUTATION === 0);
})();

async function runtimeProductionView() {
  const records = [
    { id: 'char-a', title: 'argument', content: 'A disagreement happened.', summary: 'A disagreement.',
      source: 'chat', kind: 'episodic', createdBy: 'role-p', visibility: 'public', created: 1000, tags: [] },
    { id: 'user-b', title: 'argument report', content: 'The user recalls the disagreement.',
      summary: 'Disagreement report.', source: 'chat', kind: 'episodic', createdBy: 'user',
      visibility: 'public', created: 1001, tags: [] }
  ];
  const before = JSON.stringify(records);
  const associationEdge = relation('char-a', 'user-b', 'conflict');
  const runtime = createRuntimeRecall({ clock: () => 30000, logger: () => {},
    associationRuntime: { expand: async function () {
      return { ok: true, status: 'succeeded', providerCalls: 0, result: {
        status: 'succeeded', authority: 'DERIVED_RELATION_VIEW', durability: 'RUNTIME_ONLY',
        schemaVersion: 'memory-association-v1', depth: 1, maxDepth: 1, candidateCount: 2,
        candidatePairCount: 1, classifiedPairCount: 1, expandedCount: 0,
        contextBudgetChars: 1200, chars: 0, text: '', edges: [associationEdge],
        tensionSets: [], workingSet: []
      } };
    } } });
  const requestId = 'p-runtime-request', conversationId = 'p-runtime-conversation';
  const ids = ['char-a'];
  const result = await runtime.deriveFromExistingRecall({
    characterId: 'role-p', conversationId: conversationId, requestId: requestId,
    turnId: createRuntimeRecall.deriveStableTurnId(requestId, conversationId),
    message: 'Think about that disagreement.', selectedIds: ids,
    candidateRecords: records, candidateRecordsTruncated: false,
    semanticForgettingById: ids.map((memoryId) => ({ memoryId: memoryId, projection: {
      schemaVersion: 'semantic-forgetting-v1', accessibility: 'accessible', factualDetail: 'accessible',
      emotionalResidue: 'accessible', narrativeMeaning: 'accessible', resurfaced: false
    } })),
    memoryProvenanceById: [provenance('char-a', 'character_recollection')],
    memoryText: 'Existing Recall.', remainingBudgetMs: 5000
  });
  check('P11.productionPostNAndOSeamReturnsPrivateDisputedView', result.ok === true
    && result.sharedMemoryView.schemaVersion === 'shared-memory-view-v1'
    && result.sharedMemoryView.views.length === 1
    && result.sharedMemoryView.views[0].relation === 'disputed'
    && result.sharedMemoryView.views[0].characterSide.memoryRefs.join(',') === 'char-a'
    && result.sharedMemoryView.views[0].userSide.userReportRefs.join(',') === 'user-b'
    && result.sharedMemoryView.views[0].userSide.sourceBasis === 'CANONICAL_USER_AUTHORED_MEMORY_RECORD'
    && result.sharedMemoryView.views[0].characterSide.reliabilityState === 'reliable'
    && result.sharedMemoryView.views[0].userSide.provenance[0].evidenceSource === 'association_candidate_snapshot'
    && result.sharedMemoryText.includes('不选赢家')
    && result.sharedMemoryText.includes('不要仅因该视图存在就主动披露')
    && runtime.describe().sharedMemory.explicitAcknowledgementAuthorityAssembled === false
    && runtime.describe().sharedMemory.requestCanSubmitAcknowledgement === 'NO'
    && result.durable === false);
  check('P12.runtimeViewDoesNotMutateEitherCanonicalSide', JSON.stringify(records) === before
    && runtime.describe().sharedMemory.CANONICAL_MEMORY_MUTATION === 0
    && runtime.describe().sharedMemory.USER_REPORT_REWRITE === 0
    && runtime.describe().sharedMemory.RELATIONSHIP_MUTATION === 0);
}

async function runtimeFailureFallback() {
  const badCore = { derive: function () { throw new Error('injected-shared-memory-failure'); } };
  const runtime = createRuntimeRecall({ sharedMemoryCore: badCore, clock: () => 30000, logger: () => {} });
  const requestId = 'p-fallback-request', conversationId = 'p-fallback-conversation';
  const memoryRecord = { id: 'char-a', title: 'argument', content: 'A disagreement happened.',
    summary: 'A disagreement.', oneLine: 'A disagreement.', source: 'chat', kind: 'episodic',
    createdBy: 'role-p', valence: 0.5, arousal: 0.5, importance: 5, created: 1000,
    lastActivated: 1000, resolved: false, pinned: false, visibility: 'public', tags: [] };
  const before = JSON.stringify(memoryRecord);
  const result = await runtime.deriveFromExistingRecall({
    characterId: 'role-p', conversationId: conversationId, requestId: requestId,
    turnId: createRuntimeRecall.deriveStableTurnId(requestId, conversationId),
    message: 'Think carefully about that disagreement.', selectedIds: ['char-a'],
    semanticForgettingById: [{ memoryId: 'char-a', projection: {
      schemaVersion: 'semantic-forgetting-v1', accessibility: 'accessible', factualDetail: 'accessible',
      emotionalResidue: 'accessible', narrativeMeaning: 'accessible', resurfaced: false
    } }],
    memoryProvenanceById: [{ memoryId: 'char-a', provenanceState: 'clear', authorSide: 'character_recollection',
      kind: 'episodic', upstreamCount: 0 }],
    candidateRecords: [memoryRecord], candidateRecordsTruncated: false,
    memoryText: 'Existing Recall.', remainingBudgetMs: 5000
  });
  check('P10.sharedProjectionFailureFallsBackToRecallNandOWithoutChatFailure', result.ok === true
    && result.memoryAwarenessText.includes('只根据本轮已召回记录')
    && result.memoryUnreliabilityText !== ''
    && !!result.reinterpretation && !!result.selfNarrative && !!result.reconstructedRecollection
    && result.sharedMemoryText === '' && result.sharedMemoryView === null
    && JSON.stringify(memoryRecord) === before);
  console.log('\nSHARED MEMORY PRODUCT E2E · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

runtimeProductionView().then(runtimeFailureFallback).catch((error) => {
  console.error('SHARED MEMORY PRODUCT E2E CRASHED · ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
