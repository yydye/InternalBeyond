'use strict';

const CORE = require('../assets/js/memory-recall/memory-interpretation-core.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}
function memory(id, content, extra) {
  return Object.assign({
    id: id, title: id, content: content, source: 'user', kind: 'episodic',
    valence: -0.7, arousal: 0.8
  }, extra || {});
}
const RELATIONS = ['support', 'complement', 'conflict', 'correction', 'continuation', 'contextualize', 'unrelated'];
function tensionSet(anchor, values) {
  const out = { anchorMemoryId: anchor };
  for (const relation of RELATIONS) out[relation] = (values && values[relation]) || [];
  return out;
}
function association(workingSet, edges, tensionSets) {
  return {
    schemaVersion: 'memory-association-v1', depth: 1, maxDepth: 1,
    workingSet: workingSet, edges: edges, tensionSets: tensionSets
  };
}
function directItem(id) {
  return {
    memoryId: id, meaning: '当前意义仍基于这段经历。', appraisal: 'mixed', affect: 'hurt',
    relationshipMeaning: null, causalAttribution: null, basis: 'ai_inference', subjectiveConfidence: 0.5
  };
}
function meaning(overrides) {
  return Object.assign({
    summary: '受伤的经历仍然真实，后来信息扩展了它现在的意义。',
    historicalFacts: [{ memoryId: 'A', statement: '当时用户没有出现。' }],
    historicalEmotions: [{ memoryId: 'A', statement: '当时我感到被抛弃并且难过。' }],
    currentKnowledge: [{ memoryId: 'B', statement: '后来知道用户当天在急诊。' }],
    currentBeliefs: [{ memoryId: 'B', statement: '现在不再把缺席解释为故意不在乎。' }],
    uncertainty: 'medium'
  }, overrides || {});
}

const records = [
  memory('A', '用户没有赴约，我当时觉得被抛弃。'),
  memory('B', '后来知道用户当天在急诊。'),
  memory('C', '那时我确实很难过。')
];
const canonicalBefore = JSON.stringify(records);
const relations = association([
  { memoryId: 'A', activationReasons: ['direct_recall'], anchorMemoryIds: [] },
  { memoryId: 'B', activationReasons: ['association_correction'], anchorMemoryIds: ['A'] },
  { memoryId: 'C', activationReasons: ['association_contextualize'], anchorMemoryIds: ['A'] }
], [
  { anchorMemoryId: 'A', relatedMemoryId: 'B', relation: 'correction', basis: ['provenance_reference'], pairRole: 'anchor_candidate' },
  { anchorMemoryId: 'A', relatedMemoryId: 'C', relation: 'contextualize', basis: ['same_recall_cluster'], pairRole: 'anchor_candidate' },
  { anchorMemoryId: 'A', relatedMemoryId: 'C', relation: 'conflict', basis: ['temporal_proximity'], pairRole: 'candidate_candidate' }
], [
  tensionSet('A', { correction: ['B'], contextualize: ['C'], conflict: ['C'] })
]);
const input = {
  selectedIds: ['A'], records: records, association: relations,
  currentContext: {
    currentTopic: 'revisiting the missed visit with new information',
    currentTopicSource: 'current-user-message',
    relationship: 'close friend', relationshipSource: 'character-configuration'
  }
};

{
  const built = CORE.buildRequest({ selectedIds: ['A'], records: records });
  check('C1.directOnlyShapeRemainsCompatible',
    built.envelope.kind === 'MEMORY_INTERPRETATION_INPUT'
      && !Object.prototype.hasOwnProperty.call(built.envelope, 'ASSOCIATION_VIEW')
      && !Object.prototype.hasOwnProperty.call(built.envelope.requestedSchema, 'currentMeaning'));
  check('C2.directOnlyValidatorStillAcceptsLegacyShape',
    CORE.validateResponse({ items: [directItem('A')] }, { allowedIds: ['A'] }).ok === true);
}

{
  const built = CORE.buildRequest(input);
  const envelope = built.envelope;
  check('C3.associationWorkingSetEntersOneInterpretationEnvelope',
    envelope.kind === 'MEMORY_CONTEXTUAL_REINTERPRETATION_INPUT'
      && envelope.MEMORY_BATCH.map((m) => m.memoryId).join(',') === 'A,B,C'
      && envelope.ASSOCIATION_VIEW.edges.length === 3);
  check('C4.activationAndRelationProvenanceAreRetained',
    envelope.MEMORY_BATCH[1].activationReasons.includes('association_correction')
      && envelope.ASSOCIATION_VIEW.edges[0].basis[0] === 'provenance_reference'
      && envelope.ASSOCIATION_VIEW.edges[0].pairRole === 'anchor_candidate');
  check('C5.authoritativeContextDimensionsAreExplicit',
    envelope.CURRENT_CONTEXT.currentTopic === input.currentContext.currentTopic
      && envelope.CURRENT_CONTEXT.relationship === 'close friend'
      && envelope.CURRENT_CONTEXT.relationshipSource === 'character-configuration'
      && envelope.CURRENT_CONTEXT.emotionalStateStatus === 'NOT_AVAILABLE'
      && envelope.CURRENT_CONTEXT.cognitiveSnapshotStatus === 'NOT_AVAILABLE'
      && envelope.currentState.emotion === null);
  check('C6.currentMeaningSeparatesPastAndPresentClaims',
    Object.keys(envelope.requestedSchema.currentMeaning).join(',')
      === 'summary,historicalFacts,historicalEmotions,currentKnowledge,currentBeliefs,uncertainty');
  check('C6b.promptForbidsCorrectionFromDeclaringAHistoryWinner',
    CORE.SYSTEM_INSTRUCTIONS.includes('不得把任一历史 Memory 标为 false')
      && CORE.SYSTEM_INSTRUCTIONS.includes('不得选出事实赢家'));
  check('C7.contextChangesPromptWithoutChangingCanonicalEvidence', (function () {
    const other = CORE.buildRequest(Object.assign({}, input, { currentContext: Object.assign({}, input.currentContext, {
      currentTopic: 'talking about a future plan'
    }) }));
    return JSON.stringify(envelope.MEMORY_BATCH) === JSON.stringify(other.envelope.MEMORY_BATCH)
      && envelope.CURRENT_CONTEXT.currentTopic !== other.envelope.CURRENT_CONTEXT.currentTopic
      && JSON.stringify(records) === canonicalBefore;
  })());

  const validated = CORE.validateResponse({ items: [directItem('A')], currentMeaning: meaning() }, {
    allowedIds: ['A'], currentMeaningAllowedIds: ['A', 'B', 'C'], contextualMode: true
  });
  const result = CORE.assembleContextualInterpretation(input, validated, { status: 'ok' });
  check('C8.claimsMayReferenceDirectAndAssociatedMemoryIds',
    validated.ok === true && validated.currentMeaning.currentKnowledge[0].memoryId === 'B');
  check('C9.historicalEmotionRemainsSeparateFromCurrentKnowledge',
    result && result.currentMeaning.historicalEmotions[0].statement.includes('被抛弃')
      && result.currentMeaning.currentKnowledge[0].statement.includes('急诊'));
  check('C10.correctionContextualizeAndConflictStayNonAdjudicative',
    result && result.correctionsConsidered.length === 2
      && result.activeTensions.length === 1
      && result.currentMeaning.uncertainty === 'medium'
      && result.authority === 'DERIVED_CURRENT_INTERPRETATION'
      && result.durability === 'RUNTIME_ONLY'
      && !Object.prototype.hasOwnProperty.call(result, 'historicalFactWinner'));
  check('C11.allR3RelationLabelsRemainClosedVocabulary',
    envelope.ASSOCIATION_VIEW.edges.every((edge) => RELATIONS.includes(edge.relation)));
}

{
  const eight = Array.from({ length: 8 }, (_, i) => memory('D' + i, 'direct memory ' + i));
  const workingSet = eight.map((record) => ({ memoryId: record.id, activationReasons: ['direct_recall'] }));
  workingSet.push({ memoryId: 'ASSOCIATED', activationReasons: ['association_support'] });
  const bounded = CORE.buildRequest({
    selectedIds: eight.map((record) => record.id), records: eight.concat([memory('ASSOCIATED', 'related')]),
    association: association(workingSet, [
      { anchorMemoryId: 'D0', relatedMemoryId: 'ASSOCIATED', relation: 'support', basis: ['lexical_overlap'], pairRole: 'anchor_candidate' }
    ], [tensionSet('D0', { support: ['ASSOCIATED'] })])
  });
  check('C12.directRecallPriorityAndEightMemoryCap',
    bounded.stats.memoryCount === 8
      && bounded.envelope.ASSOCIATION_VIEW.directMemoryIds.length === 8
      && bounded.envelope.ASSOCIATION_VIEW.associatedMemoryIds.length === 0
      && bounded.envelope.ASSOCIATION_VIEW.edges.length === 0);
}

{
  const badClaim = CORE.validateResponse({
    items: [directItem('A')],
    currentMeaning: meaning({ currentKnowledge: [{ memoryId: 'NOT-IN-WORKING-SET', statement: 'forged' }] })
  }, { allowedIds: ['A'], currentMeaningAllowedIds: ['A', 'B'], contextualMode: true });
  const extraAuthority = CORE.validateResponse({
    items: [directItem('A')], currentMeaning: meaning(), rewriteMemory: { id: 'A', content: 'rewritten' }
  }, { allowedIds: ['A'], currentMeaningAllowedIds: ['A', 'B'], contextualMode: true });
  check('C13.unknownMeaningClaimIsRejected', badClaim.ok === false);
  check('C14.mutationAuthorityFieldsAreRejected', extraAuthority.ok === false);
}

console.log('\nMEMORY REINTERPRETATION CORE · ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
