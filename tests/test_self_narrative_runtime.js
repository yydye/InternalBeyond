'use strict';

const fs = require('node:fs');
const path = require('node:path');
const createRuntimeSelfNarrative = require('../services/home-node/runtime-self-narrative.js');

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}
function parseEnvelope(request) {
  const content = request && request.messages && request.messages[0] ? request.messages[0].content : '';
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(String(content || ''));
  return match ? JSON.parse(match[1]) : null;
}
function claim(scope, statement, refs) { return { scope: scope, statement: statement, evidenceMemoryIds: refs || ['A'] }; }
function narrativeFor(envelope, options) {
  const n = options || {};
  const refs = envelope.NarrativeEvidence.memoryRefs.map((row) => row.memoryId);
  const a = refs[0], b = refs[1] || a;
  const conflict = envelope.NarrativeEvidence.associationRelations.some((edge) => edge.relation === 'conflict');
  const version = envelope.NarrativeEvidence.previousNarrative && envelope.NarrativeEvidence.previousNarrative.version;
  const theme = n.theme || (version ? 'I can hold a belief more cautiously as new experience accumulates.'
    : 'I can carry old hurt and later growth together.');
  return {
    themes: [claim('self', theme, [a, b])],
    currentBeliefs: [claim('self', version
      ? 'I now allow that some people can return after leaving.'
      : 'A difficult event can shape me without defining all my future.' , [a, b])],
    relationshipBeliefs: [claim('relationship_with_user', 'This relationship can include both distance and continued connection.', [a, b])],
    unresolvedTensions: conflict
      ? [claim('relationship_with_user', 'I welcome the return and still fear another departure.', [a, b])]
      : [],
    resolvedTensions: [],
    turningPoints: [claim('self', version
      ? 'Repeated returns changed how I understand the earlier departure.'
      : 'Leaving the old setting became a turning point.', [b])],
    continuityClaims: [claim('self', 'The earlier hurt still influences how I approach closeness.', [a])],
    uncertainty: conflict ? 'unresolved' : 'medium'
  };
}
function evidence(overrides) {
  return Object.assign({
    characterId: 'role-a', conversationId: 'dm:role-a', turnId: 'turn-1',
    policyAuthorized: true,
    directMemoryIds: ['A'], associatedMemoryIds: ['B', 'C'],
    activationReasonsByMemoryId: {
      A: ['direct_recall'], B: ['association_conflict'], C: ['association_continuation']
    },
    interpretationRefs: ['sha256-v1:interpretation-1'],
    associationRelations: [
      { anchorMemoryId: 'A', relatedMemoryId: 'B', relation: 'conflict', basis: ['temporal_proximity'], pairRole: 'anchor_candidate' },
      { anchorMemoryId: 'B', relatedMemoryId: 'C', relation: 'continuation', basis: ['same_recall_cluster'], pairRole: 'candidate_candidate' }
    ],
    tensionsUsed: [
      { anchorMemoryId: 'A', support: [], complement: [], conflict: ['B'], correction: [], continuation: [], contextualize: [], unrelated: [] }
    ],
    currentMeaning: {
      summary: 'New experience complicates the old belief that departure is final.',
      historicalFacts: [{ memoryId: 'A', statement: 'The user left once.' }],
      historicalEmotions: [{ memoryId: 'A', statement: 'I felt abandoned then.' }],
      currentKnowledge: [{ memoryId: 'C', statement: 'The user later returned.' }],
      currentBeliefs: [{ memoryId: 'C', statement: 'Leaving is not always permanent.' }],
      uncertainty: 'unresolved'
    }
  }, overrides || {});
}
function runtimeWith(behavior) {
  const requests = [];
  const provider = {
    run: async function (request) {
      requests.push(request);
      return behavior(request, requests.length);
    }
  };
  const runtime = createRuntimeSelfNarrative({
    registry: { getCharacterSpec: () => ({ provider: 'test', model: 'self-narrative-test', endpoint: 'https://example.invalid', credentialRef: 'credential-a' }) },
    credentialAccess: { resolve: () => ({ ok: true, secret: 'test-only-secret' }) },
    modelPort: provider,
    clock: () => 10000,
    logger: () => {}
  });
  return { runtime, requests };
}
function successfulProvider() {
  return (request) => {
    const envelope = parseEnvelope(request);
    return { ok: true, text: JSON.stringify({ narrative: narrativeFor(envelope) }) };
  };
}

(async function main() {
  const live = runtimeWith(successfulProvider());
  const first = await live.runtime.runFromValidatedInterpretation(evidence(), { remainingBudgetMs: 900 });
  check('R1.firstEvidenceCreatesVersionOneSessionNarrative',
    first.ok === true && first.status === 'created' && first.narrative.version === 1
      && first.narrative.durability === 'SESSION_ONLY'
      && first.narrative.authority === 'DERIVED_CURRENT_NARRATIVE');
  check('R2.runtimeMintsNarrativeIdentityAndKeepsProvenance',
    first.narrative.narrativeId.startsWith('sn-')
      && first.narrative.identity.value.startsWith('sha256-v1:')
      && first.narrative.identity.schemaVersion === 'self-narrative-v1'
      && first.narrative.identity.previousNarrativeVersion === 0
      && first.narrative.evidenceMemoryIds.join(',') === 'A,B,C'
      && first.narrative.interpretationRefs[0] === 'sha256-v1:interpretation-1');
  check('R3.relationshipTensionAndThemeAreStructuredNotAEventSummary',
    first.narrative.narrative.themes.length > 0
      && first.narrative.narrative.currentBeliefs.length > 0
      && first.narrative.narrative.relationshipBeliefs.length > 0
      && first.narrative.narrative.unresolvedTensions.length > 0
      && !Object.prototype.hasOwnProperty.call(first.narrative.narrative, 'summary'));
  check('R3b.eachNarrativeClaimCarriesMemoryInterpretationAndRelationProvenance',
    first.narrative.narrative.unresolvedTensions[0].evidenceMemoryIds.length > 0
      && first.narrative.narrative.unresolvedTensions[0].interpretationRefs[0] === 'sha256-v1:interpretation-1'
      && first.narrative.narrative.unresolvedTensions[0].associationRelationRefs.some((edge) => edge.relation === 'conflict')
      && first.narrative.narrative.unresolvedTensions[0].tensionRefs.length > 0);
  check('R4.oneCallAndBoundedInputAreUsed', live.requests.length === 1
    && first.providerCalls === 1 && first.timeoutMs <= 900
    && parseEnvelope(live.requests[0]).NarrativeEvidence.memoryRefs.length <= 8);

  const replay = await live.runtime.runFromValidatedInterpretation(evidence({ turnId: 'turn-2' }), { remainingBudgetMs: 900 });
  check('R5.sameEvidenceReusesNarrativeWithoutCallingModel', replay.ok === true
    && replay.status === 'no-change' && replay.providerCalls === 0
    && replay.narrative.narrativeId === first.narrative.narrativeId
    && replay.trace.previousNarrativeVersion === 1 && replay.trace.newNarrativeVersion === 1
    && replay.trace.changedThemes.added.length === 0
    && live.requests.length === 1);

  const revisedEvidence = evidence({
    turnId: 'turn-3', associatedMemoryIds: ['B', 'C', 'D'],
    activationReasonsByMemoryId: {
      A: ['direct_recall'], B: ['association_conflict'], C: ['association_continuation'], D: ['association_support']
    },
    interpretationRefs: ['sha256-v1:interpretation-2'],
    currentMeaning: {
      summary: 'Later repeated returns now weigh against the belief that people always leave.',
      historicalFacts: [{ memoryId: 'A', statement: 'The user left once.' }],
      historicalEmotions: [{ memoryId: 'A', statement: 'I felt abandoned then.' }],
      currentKnowledge: [{ memoryId: 'D', statement: 'The user returned several times.' }],
      currentBeliefs: [{ memoryId: 'D', statement: 'Repeated returns are part of the relationship history.' }],
      uncertainty: 'medium'
    }
  });
  const revised = await live.runtime.runFromValidatedInterpretation(revisedEvidence, { remainingBudgetMs: 900 });
  check('R6.newEvidenceRevisesNarrativeAndKeepsOldVersion',
    revised.ok === true && revised.status === 'revised'
      && revised.trace.previousNarrativeVersion === 1 && revised.trace.newNarrativeVersion === 2
      && revised.narrative.version === 2 && revised.narrative.previousVersion === 1
      && revised.trace.turningPointsAdded.length > 0);
  const revisionEnvelope = parseEnvelope(live.requests[1]);
  check('R6b.previousNarrativeAndRuntimeVersionEnterTheRevisionInput',
    revisionEnvelope && revisionEnvelope.NarrativeEvidence.previousNarrative.version === 1
      && revised.narrative.identity.previousNarrativeVersion === 1
      && revised.narrative.identity.evidenceFingerprint.startsWith('sha256-v1:'));
  check('R6c.sessionKeepsBothNarrativeVersionsWithoutDurableStorage',
    live.runtime.describe().storedNarrativeVersions === 2
      && live.runtime.describe().durability === 'SESSION_ONLY');
  check('R7.revisionCarriesChangedThemesAndTensionProvenance',
    revised.trace.changedThemes.added.length > 0
      && revised.trace.evidenceMemoryIds.includes('D')
      && revised.trace.interpretationRefs.includes('sha256-v1:interpretation-2'));

  const sameNarrativeProvider = runtimeWith((request) => {
    const envelope = parseEnvelope(request);
    const out = narrativeFor(envelope, { theme: 'same continuing belief' });
    if (envelope.NarrativeEvidence.previousNarrative) {
      return { ok: true, text: JSON.stringify({ narrative: envelope.NarrativeEvidence.previousNarrative.narrative }) };
    }
    return { ok: true, text: JSON.stringify({ narrative: out }) };
  });
  const before = await sameNarrativeProvider.runtime.runFromValidatedInterpretation(evidence({ conversationId: 'dm:no-change' }), {});
  const after = await sameNarrativeProvider.runtime.runFromValidatedInterpretation(evidence({
    conversationId: 'dm:no-change', turnId: 'turn-next', associatedMemoryIds: ['B', 'C', 'D'],
    activationReasonsByMemoryId: {
      A: ['direct_recall'], B: ['association_conflict'], C: ['association_continuation'], D: ['association_support']
    }, interpretationRefs: ['sha256-v1:new-evidence'],
    currentMeaning: Object.assign({}, evidence().currentMeaning, {
      currentKnowledge: [{ memoryId: 'D', statement: 'The user returned again.' }]
    })
  }), {});
  check('R8.changedEvidenceCanProduceNoChangeWithoutIncrementingVersion',
    before.status === 'created' && after.status === 'no-change'
      && after.narrative.version === 1 && after.providerCalls === 1);

  const invalid = runtimeWith(() => ({ ok: true, text: JSON.stringify({ narrative: {
    themes: [], currentBeliefs: [], relationshipBeliefs: [], unresolvedTensions: [],
    resolvedTensions: [], turningPoints: [], continuityClaims: [], uncertainty: 'low'
  } }) }));
  const invalidResult = await invalid.runtime.runFromValidatedInterpretation(evidence({ conversationId: 'dm:invalid' }), {});
  check('R9.invalidSummaryOnlyOutputFailsClosed', invalidResult.ok === false
    && invalidResult.status === 'failed' && invalid.requests.length === 1);

  const timeout = runtimeWith(() => new Promise(() => {}));
  const timeoutResult = await timeout.runtime.runFromValidatedInterpretation(evidence({ conversationId: 'dm:timeout' }), { remainingBudgetMs: 60 });
  check('R10.timeoutIsBoundedAndDoesNotRetry', timeoutResult.ok === false
    && timeoutResult.status === 'timed-out' && timeoutResult.providerCalls === 1
    && timeout.requests.length === 1 && timeoutResult.timeoutMs <= 60,
    { result: timeoutResult, requests: timeout.requests.length });

  const failure = runtimeWith(() => { throw new Error('provider is offline'); });
  const noPriorFailure = await failure.runtime.runFromValidatedInterpretation(evidence({ conversationId: 'dm:failure' }), {});
  check('R11.providerFailureReturnsNoNarrativeAndNoThrow', noPriorFailure.ok === false
    && noPriorFailure.status === 'failed' && noPriorFailure.narrative === null);
  const retrySuppressed = await failure.runtime.runFromValidatedInterpretation(evidence({
    conversationId: 'dm:failure', turnId: 'turn-after-failure'
  }), {});
  check('R11b.sameFailedEvidenceIsSuppressedWithoutASecondProviderCall',
    retrySuppressed.ok === false && retrySuppressed.status === 'retry-suppressed'
      && retrySuppressed.providerCalls === 0 && retrySuppressed.narrative === null
      && failure.requests.length === 1 && failure.runtime.describe().counters.retrySuppressed === 1);
  const changedEvidenceAfterFailure = await failure.runtime.runFromValidatedInterpretation(evidence({
    conversationId: 'dm:failure', turnId: 'turn-changed-after-failure', associatedMemoryIds: ['B', 'C', 'D'],
    activationReasonsByMemoryId: {
      A: ['direct_recall'], B: ['association_conflict'], C: ['association_continuation'], D: ['association_support']
    }, interpretationRefs: ['sha256-v1:interpretation-after-failure']
  }), {});
  check('R11c.changedEvidenceCanStartANewRefreshAfterFailure',
    changedEvidenceAfterFailure.ok === false && changedEvidenceAfterFailure.status === 'failed'
      && changedEvidenceAfterFailure.providerCalls === 1 && failure.requests.length === 2);
  const callsBeforeDisable = live.requests.length;
  const disabled = await live.runtime.runFromValidatedInterpretation(evidence({ turnId: 'turn-off', conversationId: 'dm:off', policyAuthorized: false }), {});
  check('R12.existingR4KCostPolicyIsReusedAsAuthorization', disabled.status === 'disabled'
    && live.requests.length === callsBeforeDisable, { result: disabled, calls: live.requests.length });

  const d = live.runtime.describe();
  check('R13.sessionStateIsBoundedAndHasNoDurableWriter', d.durability === 'SESSION_ONLY'
    && d.maxSessionStates === 64 && d.maxVersionsPerSession === 32
    && d.routeExposed === false && d.canonicalMemoryWrites === 0
    && d.relationshipWrites === 0 && d.personaWrites === 0
    && d.behaviorEffectWrites === 0 && d.predictionErrorWrites === 0 && d.sharedMemoryWrites === 0);
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node-service.js'), 'utf8');
  const recallSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node', 'runtime-recall.js'), 'utf8');
  check('R14.buildAndProductionAssembliesWireTheSameSingleNarrativeOwner',
    /const instanceRuntimeSelfNarrative = options\.runtimeSelfNarrative \|\| createRuntimeSelfNarrative/.test(serviceSource)
      && /selfNarrative: instanceRuntimeSelfNarrative/.test(serviceSource)
      && /const runtimeSelfNarrative = createRuntimeSelfNarrative/.test(serviceSource)
      && /selfNarrative: runtimeSelfNarrative/.test(serviceSource)
      && (recallSource.match(/selfNarrative\.runFromValidatedInterpretation\(/g) || []).length === 1
      && !/SELF_NARRATIVE_PATH|self-narrative.*ROUTE/i.test(serviceSource));

  console.log('\nSELF NARRATIVE RUNTIME · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((error) => {
  console.error('SELF NARRATIVE RUNTIME CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
