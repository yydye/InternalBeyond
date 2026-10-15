'use strict';

const CORE = require('../assets/js/memory-recall/memory-association-core.js');

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('PASS ' + name);
  } else {
    failed += 1;
    console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : ''));
  }
}
function record(id, content, extra) {
  return Object.assign({
    id: id,
    title: id,
    content: content,
    kind: 'episodic',
    createdBy: 'role-a',
    visibility: 'public',
    visibleTo: [],
    excludeFrom: [],
    created: 1000
  }, extra || {});
}

const A = record('A', 'The user promised a weekend visit.');
const B = record('B', 'The user missed the weekend visit.');
const C = record('C', 'The user explained an emergency stopped the weekend visit.');
const D = record('D', 'I felt abandoned after the missed weekend visit.');
const HIDDEN = record('hidden', 'The user missed the weekend visit during the emergency.', {
  visibility: 'private'
});
const records = [A, B, C, D, HIDDEN];
const before = JSON.stringify(records);

const discovery = CORE.discoverCandidates({
  records: records,
  anchorIds: ['A'],
  apiId: 'role-a'
});
check('D1.depthOneAnchors', discovery.anchorIds.length === 1 && discovery.anchorIds[0] === 'A');
check('D2.semanticCandidatesAreBoundedAndVisible',
  discovery.candidateIds.includes('B')
    && discovery.candidateIds.includes('C')
    && discovery.candidateIds.includes('D')
    && !discovery.candidateIds.includes('hidden')
    && discovery.candidateIds.length <= CORE.MAX_CANDIDATES,
  discovery.candidateIds);

const pairs = CORE.buildClassificationPairs(discovery);
check('D3.boundedPairwiseClassificationCanSeeClusterTension',
  pairs.some((p) => p.anchorMemoryId === 'B' && p.relatedMemoryId === 'C')
    && pairs.some((p) => p.anchorMemoryId === 'C' && p.relatedMemoryId === 'D')
    && pairs.length <= CORE.MAX_CLASSIFICATION_PAIRS,
  pairs.map((p) => [p.anchorMemoryId, p.relatedMemoryId]));

const validPair = [{
  anchorMemoryId: 'A', relatedMemoryId: 'B', relation: 'conflict'
}];
check('D4.closedVocabularyAcceptsRelation',
  CORE.parseModelResponse(JSON.stringify({ items: validPair }), [{ anchorMemoryId: 'A', relatedMemoryId: 'B' }]).ok);
const vocabularyPairs = CORE.RELATIONS.map((relation, index) => ({
  anchorMemoryId: 'A' + index,
  relatedMemoryId: 'B' + index,
  relation: relation
}));
check('D4b.allSevenClosedRelationsAreAccepted',
  CORE.parseModelResponse(JSON.stringify({ items: vocabularyPairs }),
    vocabularyPairs.map((pair) => ({
      anchorMemoryId: pair.anchorMemoryId,
      relatedMemoryId: pair.relatedMemoryId
    }))).ok);
check('D5.modelCannotReturnTruthOrMutationFields',
  !CORE.parseModelResponse(JSON.stringify({
    items: [{ anchorMemoryId: 'A', relatedMemoryId: 'B', relation: 'conflict', truthWinner: 'B' }]
  }), [{ anchorMemoryId: 'A', relatedMemoryId: 'B' }]).ok);
check('D6.invalidRelationFailsClosed',
  !CORE.parseModelResponse(JSON.stringify({
    items: [{ anchorMemoryId: 'A', relatedMemoryId: 'B', relation: 'A-is-false' }]
  }), [{ anchorMemoryId: 'A', relatedMemoryId: 'B' }]).ok);

const prompt = CORE.buildPrompt(pairs);
check('D7.promptForbidsTruthAdjudicationAndEmotionalInvalidation',
  /does not decide which memory is true/.test(prompt.system)
    && /never erase or invalidate a remembered historical emotion/.test(prompt.system));

const relationMap = new Map();
for (const pair of pairs) {
  let relation = 'contextualize';
  if (pair.anchorMemoryId === 'A' && pair.relatedMemoryId === 'B') relation = 'continuation';
  if (pair.anchorMemoryId === 'A' && pair.relatedMemoryId === 'C') relation = 'contextualize';
  if (pair.anchorMemoryId === 'A' && pair.relatedMemoryId === 'D') relation = 'contextualize';
  if (pair.anchorMemoryId === 'B' && pair.relatedMemoryId === 'C') relation = 'correction';
  relationMap.set(CORE.pairKey(pair.anchorMemoryId, pair.relatedMemoryId), relation);
}
const result = CORE.assembleResult({
  discovery: discovery,
  pairs: pairs,
  relations: relationMap,
  directIds: ['A'],
  currentMessage: 'What happened with the weekend visit?',
  budgetChars: 2000
});
check('D8.directRecallProvenanceSurvivesExpansion',
  result.workingSet[0].memoryId === 'A'
    && result.workingSet[0].activationReasons.includes('direct_recall'));
check('D9.associatedMemoriesHaveRelationProvenance',
  result.workingSet.some((item) => item.memoryId === 'B'
    && item.activationReasons.includes('association_continuation'))
    && result.workingSet.some((item) => item.memoryId === 'C'
      && item.activationReasons.includes('association_contextualize')));
check('D10.tensionSetContainsCandidateToCandidateCorrection',
  result.edges.some((edge) => edge.anchorMemoryId === 'B'
    && edge.relatedMemoryId === 'C' && edge.relation === 'correction'));
check('D11.expansionIsOneHopAndWithinBudget',
  result.depth === 1 && result.maxDepth === 1
    && result.expandedCount <= CORE.MAX_EXPANSION
    && result.chars <= result.contextBudgetChars
    && result.contextBudgetChars <= CORE.MAX_CONTEXT_CHARS);
check('D12.renderedContextKeepsRelationAndTruthBoundary',
  result.text.includes('[continuation]')
    && result.text.includes('不裁决事实真伪'));
check('D13.coreNeverMutatesCanonicalInputs', JSON.stringify(records) === before);

const many = [A];
for (let i = 0; i < 20; i++) {
  many.push(record('M' + i, 'The user discussed the weekend visit and shared context ' + i + '.'));
}
const bounded = CORE.discoverCandidates({ records: many, anchorIds: ['A'], apiId: 'role-a' });
const boundedPairs = CORE.buildClassificationPairs(bounded);
const boundedRelations = new Map();
for (const pair of boundedPairs) {
  boundedRelations.set(CORE.pairKey(pair.anchorMemoryId, pair.relatedMemoryId), 'support');
}
const boundedResult = CORE.assembleResult({
  discovery: bounded,
  pairs: boundedPairs,
  relations: boundedRelations,
  directIds: ['A'],
  budgetChars: 8000
});
check('D14.candidatePairExpansionAndFinalSetHaveGlobalCaps',
  bounded.candidates.length <= 6
    && boundedPairs.length <= 12
    && boundedResult.expandedCount <= 4);

console.log('\nMemory Association Core: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
