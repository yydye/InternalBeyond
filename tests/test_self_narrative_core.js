'use strict';

const CORE = require('../assets/js/memory-recall/self-narrative-core.js');

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}
const relations = ['support', 'complement', 'conflict', 'correction', 'continuation', 'contextualize', 'unrelated'];
function tensionSet(anchor, values) {
  const row = { anchorMemoryId: anchor };
  for (const relation of relations) row[relation] = (values && values[relation]) || [];
  return row;
}
function claim(scope, statement, evidenceMemoryIds) {
  return { scope: scope, statement: statement, evidenceMemoryIds: evidenceMemoryIds || ['A'] };
}
function narrative(overrides) {
  return Object.assign({
    themes: [claim('self', 'I can carry hurt and growth at the same time.', ['A', 'C'])],
    currentBeliefs: [claim('self', 'I am learning that endings are not always permanent.', ['B', 'C'])],
    relationshipBeliefs: [claim('relationship_with_user', 'This relationship has had both distance and return.', ['B', 'C'])],
    unresolvedTensions: [claim('relationship_with_user', 'I welcome the return but still fear another departure.', ['B', 'C'])],
    resolvedTensions: [],
    turningPoints: [claim('self', 'Leaving the old environment became a turning point.', ['B', 'C'])],
    continuityClaims: [claim('self', 'The earlier hurt still shapes how I approach closeness.', ['A', 'C'])],
    uncertainty: 'medium'
  }, overrides || {});
}
const input = {
  directMemoryIds: ['A'],
  associatedMemoryIds: ['B', 'C', 'D'],
  activationReasonsByMemoryId: {
    A: ['direct_recall'], B: ['association_conflict'],
    C: ['association_continuation'], D: ['association_support']
  },
  interpretationRefs: ['sha256-v1:current-r4k-meaning'],
  associationRelations: [
    { anchorMemoryId: 'A', relatedMemoryId: 'B', relation: 'conflict', basis: ['temporal_proximity'], pairRole: 'anchor_candidate' },
    { anchorMemoryId: 'B', relatedMemoryId: 'C', relation: 'continuation', basis: ['same_recall_cluster'], pairRole: 'candidate_candidate' },
    { anchorMemoryId: 'C', relatedMemoryId: 'D', relation: 'support', basis: ['provenance_reference'], pairRole: 'candidate_candidate' }
  ],
  tensionsUsed: [tensionSet('A', { conflict: ['B'] }), tensionSet('B', { continuation: ['C'] })],
  currentMeaning: {
    summary: 'A painful departure is now understood alongside later return and sustained contact.',
    historicalFacts: [{ memoryId: 'A', statement: 'The user left once.' }],
    historicalEmotions: [{ memoryId: 'A', statement: 'I felt abandoned then.' }],
    currentKnowledge: [{ memoryId: 'C', statement: 'The user later returned and stayed in contact.' }],
    currentBeliefs: [{ memoryId: 'C', statement: 'A departure does not always mean permanent abandonment.' }],
    uncertainty: 'medium'
  },
  previousNarrative: null
};
const canonicalInputSnapshot = JSON.stringify(input);

{
  const built = CORE.buildRequest(input);
  check('C1.oneStructuredNarrativeEnvelopeCarriesBoundedEvidence',
    built.envelope.kind === 'SELF_NARRATIVE_DERIVED_INPUT'
      && built.envelope.NarrativeEvidence.memoryRefs.length === 4
      && built.envelope.NarrativeEvidence.associationRelations.length === 3
      && built.envelope.NarrativeEvidence.interpretationRefs[0] === input.interpretationRefs[0]);
  check('C2.currentMeaningAndPriorTensionEnterTheEvidenceEnvelope',
    built.envelope.NarrativeEvidence.currentMeaning.historicalEmotions[0].statement.includes('abandoned')
      && built.envelope.NarrativeEvidence.tensionSets[0].conflict[0] === 'B');
  check('C3.narrativeSchemaRequiresThemesBeliefsTensionsAndTurningPoints',
    Object.keys(built.envelope.requestedSchema.narrative).join(',')
      === 'themes,currentBeliefs,relationshipBeliefs,unresolvedTensions,resolvedTensions,turningPoints,continuityClaims,uncertainty'
      && !Object.prototype.hasOwnProperty.call(built.envelope.requestedSchema.narrative, 'summary'));
  check('C4.modelInputDoesNotCarryRawMemoryBodiesOrAFullMemoryBatch',
    !Object.prototype.hasOwnProperty.call(built.envelope, 'MEMORY_BATCH')
      && !JSON.stringify(built.envelope).includes('rawMemoryBodySentinel'));
  check('C5.inputIsPureAndDeterministic',
    JSON.stringify(CORE.buildRequest(input).envelope) === JSON.stringify(built.envelope)
      && JSON.stringify(input) === canonicalInputSnapshot);
}

{
  const valid = CORE.validateResponse({ narrative: narrative() }, { allowedMemoryIds: ['A', 'B', 'C', 'D'] });
  check('C6.validInterpretiveNarrativePassesWithProvenance', valid.ok === true
    && valid.narrative.themes[0].evidenceMemoryIds.join(',') === 'A,C'
    && valid.narrative.relationshipBeliefs[0].scope === 'relationship_with_user');
  check('C7.narrativeIsNotAnEventSummary', valid.ok === true
    && valid.narrative.themes.length > 0
    && valid.narrative.currentBeliefs.length + valid.narrative.relationshipBeliefs.length > 0
    && !Object.prototype.hasOwnProperty.call(valid.narrative, 'summary'));

  const onlyEvents = CORE.validateResponse({ narrative: narrative({
    themes: [], currentBeliefs: [], relationshipBeliefs: [],
    unresolvedTensions: [], resolvedTensions: [], turningPoints: [], continuityClaims: []
  }) }, { allowedMemoryIds: ['A', 'B', 'C', 'D'] });
  check('C8.eventsOnlySummaryIsRejected', onlyEvents.ok === false && onlyEvents.reason === CORE.REASON_CODES.summaryOnly);
  const unknownEvidence = CORE.validateResponse({ narrative: narrative({
    currentBeliefs: [claim('self', 'Forged event.', ['NOT-BOUND'])]
  }) }, { allowedMemoryIds: ['A', 'B', 'C', 'D'] });
  check('C9.unboundProvenanceIsRejected', unknownEvidence.ok === false
    && unknownEvidence.reason === CORE.REASON_CODES.invalidReference);
  const extraAuthority = CORE.validateResponse({ narrative: narrative(), relationshipUpdate: { trust: 1 } }, {
    allowedMemoryIds: ['A', 'B', 'C', 'D']
  });
  check('C10.extraAuthorityFieldIsRejected', extraAuthority.ok === false);
}

{
  const previous = {
    version: 2,
    narrativeId: 'sn-previous-runtime-id',
    narrative: narrative({ uncertainty: 'unresolved' })
  };
  const withPrevious = CORE.buildRequest(Object.assign({}, input, { previousNarrative: previous }));
  check('C11.previousNarrativeIsBoundedDerivedContext',
    withPrevious.envelope.NarrativeEvidence.previousNarrative.version === 2
      && withPrevious.envelope.NarrativeEvidence.previousNarrative.narrativeId === previous.narrativeId
      && withPrevious.stats.previousNarrativeChars <= CORE.BOUNDS.MAX_PREVIOUS_NARRATIVE_CHARS);
}

{
  const records = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const bounded = CORE.normalizeInput({
    directMemoryIds: records,
    associatedMemoryIds: ['NINTH'],
    interpretationRefs: ['sha256-v1:bound'],
    currentMeaning: input.currentMeaning,
    associationRelations: [], tensionsUsed: []
  });
  check('C12.directMemoryPriorityKeepsTheEightReferenceCap',
    bounded.memoryIds.length === 8 && bounded.memoryIds.every((id) => id !== 'NINTH')
      && bounded.associatedMemoryIds.length === 0);
}

console.log('\nSELF NARRATIVE CORE · ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
