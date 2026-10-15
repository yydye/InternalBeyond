'use strict';

/* P21-R4-H · ephemeral, ordinal forgetting projection at the shared Recall
 * seam. Pure fixtures: no Memory store writer, provider, Vault, or UI. */
const CORE = require('../assets/js/memory-retrieval-core.js');

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail))); }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 2000 * DAY;
const STATES = ['accessible', 'faded', 'suppressed', 'latent'];
function memory(id, ageDays, overrides) {
  return Object.assign({
    id: id, title: 'bridge incident', summary: 'A difficult event changed how I understood the situation.',
    oneLine: 'The event mattered and changed my understanding.',
    content: 'RAW_DETAIL_SENTINEL: every exact sentence and minute of the old conversation.',
    kind: 'episodic', source: 'user', domain: '日常', tags: [],
    valence: 0.5, arousal: 0.3, importance: 5, resolved: false, pinned: false,
    created: NOW - ageDays * DAY, lastActivated: NOW - ageDays * DAY,
    visibility: 'public', visibleTo: [], excludeFrom: []
  }, overrides || {});
}
function projection(record, relevance) {
  return CORE.deriveSemanticForgetting(record, NOW, relevance == null ? 1 : relevance);
}

(function main() {
  const strongAffect = memory('strong-affect', 120, { valence: 0.1, arousal: 0.9 });
  const hurt = projection(strongAffect);
  check('H1.factualDetailFadesFasterThanStrongEmotionalResidue',
    hurt && hurt.factualDetail === 'faded' && hurt.emotionalResidue === 'accessible'
      && STATES.includes(hurt.accessibility));
  const hurtRow = CORE.rankMemoryCandidates([strongAffect], {
    apiId: 'role-h', userMessage: 'unrelated current topic', now: NOW
  })[0];
  const hurtLine = CORE.renderMemoryLine(hurtRow, 'role-h', 200);
  check('H1b.fadedFactualDetailProjectsMeaningAndRetainsAffectCue',
    hurtLine.includes('The event mattered')
      && !hurtLine.includes('RAW_DETAIL_SENTINEL')
      && hurtLine.includes('情绪残留仍清晰'));

  const weakAffect = memory('weak-affect', 14, { valence: 0.5, arousal: 0.1 });
  const weak = projection(weakAffect);
  check('H2.weakEmotionCanFadeWhileRecentFactDetailRemainsClear',
    weak && weak.factualDetail === 'accessible' && weak.emotionalResidue === 'faded');

  const meaningOutlivesDetail = memory('meaning-outlives-detail', 400, {
    valence: 0.5, arousal: 0.2, summary: 'The event established an important boundary.',
    oneLine: 'A boundary was established.'
  });
  const meaning = projection(meaningOutlivesDetail);
  const meaningRow = CORE.rankMemoryCandidates([meaningOutlivesDetail], {
    apiId: 'role-h', userMessage: 'unrelated current topic', now: NOW
  })[0];
  const meaningLine = CORE.renderMemoryLine(meaningRow, 'role-h', 200);
  check('H3.narrativeMeaningRemainsAvailableWhileFactualDetailIsSuppressed',
    meaning && meaning.factualDetail === 'suppressed'
      && meaning.emotionalResidue === 'latent'
      && meaning.narrativeMeaning === 'faded'
      && meaningLine.includes('A boundary was established.')
      && !meaningLine.includes('RAW_DETAIL_SENTINEL'));

  const suppressedMemory = memory('suppressed-memory', 200, {
    valence: 0.5, arousal: 0.1, summary: '', oneLine: '', resolved: false
  });
  const snapshot = JSON.stringify([strongAffect, weakAffect, meaningOutlivesDetail, suppressedMemory]);
  const ranked = CORE.rankMemoryCandidates([strongAffect, weakAffect, meaningOutlivesDetail, suppressedMemory], {
    apiId: 'role-h', userMessage: 'unrelated current topic', now: NOW
  });
  const suppressed = ranked.find(function (row) { return row.id === 'suppressed-memory'; });
  check('H4.fadedAndSuppressedRecordsRemainCandidatesAndCanonicalInputsStayUnchanged',
    !!suppressed && suppressed._semanticForgetting.accessibility === 'suppressed'
      && JSON.stringify([strongAffect, weakAffect, meaningOutlivesDetail, suppressedMemory]) === snapshot);

  const old = memory('old-resurfaced', 900, {
    title: 'bridge incident testimony', content: 'The bridge incident testimony described a precise sequence of events.',
    summary: '', oneLine: '', valence: 0.5, arousal: 0.1
  });
  const before = CORE.rankMemoryCandidates([old], { apiId: 'role-h', userMessage: 'unrelated topic', now: NOW })[0];
  const resurfaced = CORE.rankMemoryCandidates([old], {
    apiId: 'role-h', userMessage: 'bridge incident testimony', now: NOW
  })[0];
  check('H5.relevantRecallResurfacesAccessibilityWithoutRestoringFadedDetails',
    before._semanticForgetting.accessibility === 'latent'
      && resurfaced._semanticForgetting.accessibility === 'accessible'
      && resurfaced._semanticForgetting.resurfaced === true
      && resurfaced._semanticForgetting.factualDetail === 'latent');

  const activatedCopy = Object.assign({}, old, { lastActivated: NOW });
  const afterReactivation = projection(activatedCopy);
  check('H5b.existingRecallActivationRaisesAccessibilityButNotDetailAvailability',
    afterReactivation.accessibility === 'suppressed'
      && afterReactivation.factualDetail === 'latent');

  check('H6.suppressionIsAnOrdinalAccessibilityStateNotDeletion',
    STATES.includes(suppressed._semanticForgetting.accessibility)
      && ranked.some(function (row) { return row.id === suppressedMemory.id; })
      && suppressedMemory.id === 'suppressed-memory');

  const firstReplay = CORE.rankMemoryCandidates([strongAffect, weakAffect, meaningOutlivesDetail], {
    apiId: 'role-h', userMessage: 'unrelated current topic', now: NOW
  }).map(function (row) {
    return { id: row.id, score: row._score, forgetting: row._semanticForgetting };
  });
  const secondReplay = CORE.rankMemoryCandidates([strongAffect, weakAffect, meaningOutlivesDetail], {
    apiId: 'role-h', userMessage: 'unrelated current topic', now: NOW
  }).map(function (row) {
    return { id: row.id, score: row._score, forgetting: row._semanticForgetting };
  });
  check('H7.identicalEvidenceAndContextReplayIsDeterministic', JSON.stringify(firstReplay) === JSON.stringify(secondReplay));

  const broken = memory('forgetting-error', 500, { summary: '', oneLine: '' });
  Object.defineProperty(broken, 'summary', { enumerable: false, get: function () { throw new Error('projection-failure'); } });
  const fallbackRows = CORE.rankMemoryCandidates([broken], {
    apiId: 'role-h', userMessage: 'unrelated topic', now: NOW
  });
  const fallbackLine = fallbackRows.length ? CORE.renderMemoryLine(fallbackRows[0], 'role-h', 200) : '';
  const legacyLine = CORE.renderMemoryLine(broken, 'role-h', 200);
  check('H8.forgettingFailureFallsBackToOriginalRecallAndDetailProjection',
    fallbackRows.length === 1 && !fallbackRows[0]._semanticForgetting
      && fallbackRows[0]._score === CORE.getMemoryScore(broken, NOW)
      && fallbackLine === legacyLine
      && fallbackLine.includes('RAW_DETAIL_SENTINEL'));

  const hidden = memory('hidden-memory', 500, { visibility: 'private', createdBy: 'other-role' });
  Object.defineProperty(hidden, 'summary', { enumerable: false, get: function () { throw new Error('hidden record must not be projected'); } });
  const visibleControl = memory('visible-control', 14);
  const aclRows = CORE.rankMemoryCandidates([hidden, visibleControl], {
    apiId: 'role-h', userMessage: 'unrelated topic', now: NOW
  });
  check('H9.visibilityAclRunsBeforeAnyForgettingProjection',
    aclRows.length === 1 && aclRows[0].id === visibleControl.id
      && !!aclRows[0]._semanticForgetting);

  const status = CORE.describeSemanticForgetting();
  check('H10.runtimeAuthorityAndHardMutationFlagsAreLiveAndZero',
    status.SEMANTIC_FORGETTING_RUNTIME === 'LIVE'
      && status.SEMANTIC_FORGETTING_IS_DERIVED === 'YES'
      && status.FACTUAL_DETAIL_DECAY === 'LIVE'
      && status.EMOTIONAL_RESIDUE_DECAY === 'LIVE'
      && status.NARRATIVE_MEANING_DECAY === 'LIVE'
      && status.FORGETTING_MAY_CHANGE_ACCESSIBILITY === 'YES'
      && status.FORGETTING_MAY_CHANGE_DETAIL_AVAILABILITY === 'YES'
      && status.FORGETTING_MAY_NOT_DELETE_CANONICAL_MEMORY === 'YES'
      && status.FORGETTING_MAY_NOT_REWRITE_HISTORICAL_FACT === 'YES'
      && status.FORGETTING_MAY_NOT_MUTATE_PERSONA === 'YES'
      && status.FORGETTING_MAY_NOT_MUTATE_RELATIONSHIP === 'YES'
      && status.FORGETTING_AFFECTS_RECALL_ACCESSIBILITY === 'YES'
      && status.FORGETTING_IS_NOT_DELETION === 'VERIFIED'
      && status.RESURFACING === 'LIVE'
      && status.FAILURE_FALLBACK_TO_NORMAL_RECALL === 'LIVE'
      && status.CANONICAL_MEMORY_DELETE === 0 && status.CANONICAL_MEMORY_REWRITE === 0
      && status.CANONICAL_MEMORY_DELETES_FROM_FORGETTING === 0
      && status.CANONICAL_MEMORY_TEXT_REWRITES_FROM_FORGETTING === 0
      && status.RELATIONSHIP_MUTATION === 0 && status.PERSONA_MUTATION === 0
      && status.SELF_NARRATIVE_MUTATION === 0 && status.BEHAVIOR_MODULATION_MUTATION === 0
      && status.PREDICTION_ERROR_MUTATION === 0);

  console.log('\nSEMANTIC FORGETTING PRODUCT E2E · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})();
