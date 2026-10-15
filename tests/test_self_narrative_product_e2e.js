'use strict';

const { createRuntimeRecall } = require('../services/home-node/runtime-recall.js');
const { createRuntimeMemoryAssociation } = require('../services/home-node/runtime-memory-association.js');
const createRuntimeInterpretation = require('../services/home-node/runtime-interpretation.js');
const createRuntimeSelfNarrative = require('../services/home-node/runtime-self-narrative.js');
const MEMORY_RETRIEVAL_CORE = require('../assets/js/memory-retrieval-core.js');

let passed = 0, failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}
function record(id, content) {
  return {
    id: id, title: id, content: content, kind: 'episodic', source: 'user',
    domain: '日常', tags: [], valence: 0.1, arousal: 0.7, importance: 6,
    resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: 500, lastActivated: 500,
    createdBy: 'role-a', createdByName: 'Character'
  };
}
function parseJsonFence(content) {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(String(content || ''));
  return match ? JSON.parse(match[1]) : null;
}
function parseAssociation(content) { try { return JSON.parse(String(content || '')); } catch (_) { return null; } }
function claim(scope, statement, evidenceMemoryIds) {
  return { scope: scope, statement: statement, evidenceMemoryIds: evidenceMemoryIds };
}
function narrativeFor(envelope, mode) {
  const evidence = envelope.NarrativeEvidence;
  const refs = evidence.memoryRefs.map((row) => row.memoryId);
  const a = refs[0], b = refs[1] || a, c = refs[2] || b;
  const conflict = evidence.associationRelations.some((edge) => edge.relation === 'conflict');
  const meaningText = String(evidence.currentMeaning.summary || '');
  const prior = evidence.previousNarrative;
  const repeatedReturn = refs.includes('D') || /repeated|several times|多次/i.test(meaningText);
  let theme = 'I can carry hurt and later growth in one story.';
  let belief = 'A departure does not prove that every relationship will end.';
  let relationshipBelief = 'This relationship has included distance and continued contact.';
  let turningPoint = null;
  if (mode === 'humiliation') {
    theme = 'I can remember pain as real while seeing how it changed my direction.';
    belief = 'I can leave a harmful setting and still build a meaningful life.';
    turningPoint = claim('self', 'Leaving the old environment became a turning point after a painful event.', [a, b]);
  } else if (mode === 'correction') {
    theme = 'I can keep the hurt while revising what I believe caused it.';
    belief = 'The missed visit is not proof that the user did not care.';
    relationshipBelief = 'New knowledge changed my explanation, while my earlier hurt remains part of our story.';
  } else if (conflict) {
    theme = 'I can hold trust and fear together without forcing a final answer.';
    belief = 'I have evidence of return and still remain alert to loss.';
    relationshipBelief = 'This relationship contains both continued connection and fear of another departure.';
  }
  if (mode === 'revision' && prior && repeatedReturn) {
    theme = 'I can revise an old story without pretending the earlier fear never existed.';
    belief = 'Some people can return and stay, even though I still protect myself against loss.';
    relationshipBelief = 'Repeated returns have weakened my belief that one departure means the relationship is over.';
    turningPoint = claim('relationship_with_user', 'Repeated returns changed how I understand the earlier departure.', [c, refs[refs.length - 1]]);
  } else if (mode === 'revision' && !prior) {
    belief = 'People eventually leave, and I should expect that.';
    relationshipBelief = 'I currently expect this relationship to end in departure.';
  }
  return {
    themes: [claim('self', theme, [a, b])],
    currentBeliefs: [claim('self', belief, [b, c])],
    relationshipBeliefs: [claim('relationship_with_user', relationshipBelief, [a, b])],
    unresolvedTensions: conflict
      ? [claim('relationship_with_user', 'I welcome return and still fear another departure.', [b, c])]
      : [],
    resolvedTensions: mode === 'correction'
      ? [claim('relationship_with_user', 'I no longer treat the missed visit as proof of deliberate rejection.', [a, b])]
      : [],
    turningPoints: turningPoint ? [turningPoint] : [],
    continuityClaims: [claim('self', 'Earlier emotional experience still shapes how I approach closeness.', [b])],
    uncertainty: conflict ? 'unresolved' : 'medium'
  };
}

function createScenario(records, relationRules, mode, options) {
  const opts = options || {};
  const before = JSON.stringify(records);
  const effect = {
    activated: [], exposed: [], turnEnds: 0, memoryWrites: 0, memoryDeletes: 0,
    relationshipWrites: 0, personaWrites: 0, behaviorWrites: 0,
    expectationCalls: 0, predictionErrorWrites: 0, sharedMemoryWrites: 0
  };
  const provider = {
    associationCalls: 0, interpretationCalls: 0, narrativeCalls: 0,
    narrativeEnvelopes: [], requests: []
  };
  const store = {
    listRecords: () => ({ ok: true, records: records, count: records.length, revision: 1, truncated: false }),
    getMemorySettings: () => ({ ok: true, settings: { budget: 2000, contentLen: 1200 } }),
    getRecord: (id) => records.find((row) => row.id === id) || null,
    getRevision: () => 1,
    recordActivation: (ids) => ({ ok: true, updated: ids.length, duplicated: [], reason: null }),
    putRecord: () => { effect.memoryWrites += 1; throw new Error('Self Narrative must not write Memory'); },
    deleteRecord: () => { effect.memoryDeletes += 1; throw new Error('Self Narrative must not delete Memory'); }
  };
  const registry = {
    getCharacterSpec: () => ({ provider: 'test', model: 'self-narrative-e2e', endpoint: 'https://example.invalid', credentialRef: 'test-credential' }),
    getCharacter: () => ({ dto: { relationship: 'close friend' } })
  };
  const credentials = { resolve: () => ({ ok: true, secret: 'e2e-secret' }) };
  const modelPort = {
    run: async function (request) {
      provider.requests.push(request);
      const content = request && request.messages && request.messages[0] ? request.messages[0].content : '';
      if (String(content).includes('SELF_NARRATIVE_INPUT')) {
        provider.narrativeCalls += 1;
        const envelope = parseJsonFence(content);
        provider.narrativeEnvelopes.push(envelope);
        if (opts.narrativeFailure === true) throw new Error('fake narrative provider error');
        return { ok: true, text: JSON.stringify({ narrative: narrativeFor(envelope, mode) }) };
      }
      if (String(content).includes('```json')) {
        provider.interpretationCalls += 1;
        const envelope = parseJsonFence(content);
        const directIds = envelope.ASSOCIATION_VIEW.directMemoryIds;
        const rows = envelope.MEMORY_BATCH;
        const later = rows.find((row) => row.memoryId !== directIds[0]) || rows[0];
        const modeMeaning = mode === 'humiliation'
          ? 'The public criticism was painful and later became part of a turning point.'
          : mode === 'correction'
            ? 'The missed visit hurt then; later knowledge changed the current explanation.'
            : envelope.ASSOCIATION_VIEW.edges.some((edge) => edge.relation === 'conflict')
              ? 'The promise, departure, and return remain in tension.'
              : (rows.some((row) => /several times|repeatedly/i.test(row.content))
                ? 'Repeated returns now complicate the old belief that people always leave.'
                : 'The departure still hurt, while later contact changed its meaning.');
        const historical = rows.find((row) => /abandoned|humiliated|hurt|afraid/i.test(row.content)) || rows[0];
        return { ok: true, text: JSON.stringify({
          items: directIds.map((id) => ({ memoryId: id, meaning: 'Current interpretation preserves what was felt.',
            appraisal: 'mixed', affect: 'hurt', relationshipMeaning: null, causalAttribution: null,
            basis: 'ai_inference', subjectiveConfidence: 0.5 })),
          currentMeaning: {
            summary: modeMeaning,
            historicalFacts: [{ memoryId: directIds[0], statement: String(rows[0].content).slice(0, 160) }],
            historicalEmotions: [{ memoryId: historical.memoryId, statement: /humiliated/i.test(historical.content)
              ? 'I felt humiliated and hurt at the time.' : 'I felt abandoned and afraid at the time.' }],
            currentKnowledge: [{ memoryId: later.memoryId, statement: String(later.content).slice(0, 160) }],
            currentBeliefs: [{ memoryId: later.memoryId, statement: 'The later evidence changes how I understand the earlier event.' }],
            uncertainty: envelope.ASSOCIATION_VIEW.edges.some((edge) => edge.relation === 'conflict') ? 'unresolved' : 'medium'
          }
        }) };
      }
      provider.associationCalls += 1;
      try {
        const batch = parseAssociation(content);
        return { ok: true, text: JSON.stringify({ items: (batch && batch.pairs || []).map((pair) => ({
          anchorMemoryId: pair.anchor.memoryId,
          relatedMemoryId: pair.related.memoryId,
          relation: relationRules[pair.anchor.memoryId + '>' + pair.related.memoryId] || 'support'
        })) }) };
      } catch (error) {
        console.error('association fake provider failed · ' + String((error && error.stack) || error));
        throw error;
      }
    }
  };
  const association = createRuntimeMemoryAssociation({ modelPort: modelPort, registry: registry,
    credentialAccess: credentials, clock: () => 10000, logger: () => {} });
  const interpretation = createRuntimeInterpretation({ registry: registry, memoryStore: store,
    credentialAccess: credentials, modelPort: modelPort,
    autoInterpretationPolicy: { autoInterpretationEnabled: true }, clock: () => 10000, logger: () => {} });
  const selfNarrative = createRuntimeSelfNarrative({ registry: registry, credentialAccess: credentials,
    modelPort: modelPort, clock: () => 10000, logger: () => {} });
  const sessionState = {
    currentTurnIndex: () => 0,
    beginHomeTurn: () => 1,
    recordExposure: (input) => { effect.exposed.push.apply(effect.exposed, input.memoryIds); return input.memoryIds.length; },
    endHomeTurn: () => { effect.turnEnds += 1; return true; }
  };
  const retrieval = {
    store: store,
    retrieve: () => {
      const anchor = records[0];
      const block = '【直接记忆】\n- ' + anchor.title + '：' + anchor.content + '\n';
      return {
        ok: true, text: block, selectedIds: [anchor.id], reinforcementIds: [anchor.id],
        count: 1, chars: block.length, candidates: records.length, activationPolicy: 'normal', reason: null,
        semanticForgettingById: [{ memoryId: anchor.id,
          projection: MEMORY_RETRIEVAL_CORE.deriveSemanticForgetting(anchor, 10000, 1) }],
        memoryProvenanceById: [{ memoryId: anchor.id, provenanceState: 'clear',
          kind: String(anchor.kind || 'episodic'), upstreamCount: Array.isArray(anchor.consolidatedFrom)
            ? anchor.consolidatedFrom.length : 0 }],
        diagnostics: { channel: 'surface', counts: { input: records.length, visible: records.length, gated: 1, selected: 1 } }
      };
    },
    reinforce: (ids) => { effect.activated.push.apply(effect.activated, ids); return { ok: true, updated: ids.length, duplicated: [], reason: null }; }
  };
  const runtimeRecall = createRuntimeRecall({
    memoryRetrieval: retrieval, memoryStore: store, registry: registry,
    sessionState: sessionState, associationRuntime: association,
    interpretation: interpretation, selfNarrative: selfNarrative,
    expectation: { runFromValidatedInterpretation: () => { effect.expectationCalls += 1; } },
    behaviorEffect: { consumeForTurn: () => null, deriveAndHold: () => { effect.behaviorWrites += 1; } },
    clock: () => 10000, random: () => 0.5, logger: () => {}
  });
  return { runtimeRecall, provider, effect, store, records, before, selfNarrative };
}
async function turn(env, requestId, conversationId, message) {
  return env.runtimeRecall.run({ operation: 'memory-recall', mode: 'authoritative',
    characterId: 'role-a', requestId: requestId, conversationId: conversationId,
    message: message, timeoutMs: 5000 });
}

(async function main() {
  const leaveAndReturn = createScenario([
    record('A', 'The user promised to stay with me and I hoped the relationship would last.'),
    record('B', 'The user left once and I felt abandoned.'),
    record('C', 'The user came back after leaving.'),
    record('D', 'After the promise, the user returned several times and stayed in contact over time.')
  ], { 'A>B': 'conflict', 'B>C': 'continuation', 'C>D': 'support', 'A>C': 'contextualize' }, 'leave-return');
  const first = await turn(leaveAndReturn, 'l-1', 'conversation-l', 'Thinking about the promise, departure, and return.');
  check('E1.AssociationReinterpretationAndNarrativeReachTheSameCognitionContext',
    first.ok === true && first.reinterpretation && first.reinterpretation.status === 'succeeded'
      && first.selfNarrative && first.selfNarrative.status === 'created'
      && first.selfNarrative.narrative.themes.length > 0
      && first.selfNarrative.narrative.relationshipBeliefs.length > 0
      && first.context.text.includes('【当前意义（派生解释）】')
      && first.context.text.includes('【当前自我叙事（派生 / session-only）】'),
    { ok: first.ok, association: first.association, reinterpretation: first.reinterpretation,
      selfNarrative: first.selfNarrative, calls: leaveAndReturn.provider.requests.map((request) => ({
        model: request.spec && request.spec.model,
        content: String(request.messages && request.messages[0] && request.messages[0].content || '').slice(0, 120)
      })) });
  check('E1b.DesktopPrivateContextReceivesMetaMemoryAwarenessAfterKAndL',
    first.ok === true
      && first.context.text.indexOf('【当前自我叙事（派生 / session-only）】') >= 0
      && first.context.text.indexOf('只根据本轮已召回记录实际包含的内容描述过去')
        > first.context.text.indexOf('【当前自我叙事（派生 / session-only）】')
      && first.context.text.includes('不要求主动提起或披露某段记忆'), first.context.text.slice(-700));
  check('E1c.DesktopPrivateContextReceivesInterpretationLeakageGuardAfterMetaMemory',
    first.ok === true
      && first.context.text.includes('把当时记录的事实主张与当前派生理解分开')
      && first.context.text.includes('当前解释不是事件发生时已经知道的证据'), first.context.text.slice(-700));
  check('E2.AssociationConflictAndTensionRemainUnresolved',
    first.reinterpretation && first.selfNarrative
      && first.reinterpretation.relationsUsed.some((edge) => edge.relation === 'conflict')
      && first.selfNarrative.narrative.unresolvedTensions.length > 0
      && first.selfNarrative.narrative.uncertainty === 'unresolved');
  check('E3.NarrativeClaimsTraceToMemoryAndR4KInterpretation',
    first.selfNarrative && first.selfNarrative.narrative.currentBeliefs[0].evidenceMemoryIds.length > 0
      && first.selfNarrative.narrative.currentBeliefs[0].interpretationRefs.length === 1
      && first.selfNarrative.narrative.currentBeliefs[0].evidenceMemoryIds.every((id) => first.selfNarrative.evidenceMemoryIds.includes(id)));
  check('E4.SelfNarrativeHasThemesAndBeliefsRatherThanEventsOnly',
    first.selfNarrative.narrative.themes.length > 0
      && first.selfNarrative.narrative.currentBeliefs.length > 0
      && first.selfNarrative.narrative.relationshipBeliefs.length > 0
      && !Object.prototype.hasOwnProperty.call(first.selfNarrative.narrative, 'summary'));
  check('E5.AllMutationAuthoritiesStayUntouchedAndRecallStaysDirect',
    JSON.stringify(leaveAndReturn.records) === leaveAndReturn.before
      && leaveAndReturn.effect.memoryWrites === 0 && leaveAndReturn.effect.memoryDeletes === 0
      && leaveAndReturn.effect.relationshipWrites === 0 && leaveAndReturn.effect.personaWrites === 0
      && leaveAndReturn.effect.behaviorWrites === 0 && leaveAndReturn.effect.expectationCalls === 0
      && leaveAndReturn.effect.predictionErrorWrites === 0 && leaveAndReturn.effect.sharedMemoryWrites === 0
      && first.selectedIds.join(',') === 'A'
      && leaveAndReturn.effect.activated.join(',') === 'A'
      && leaveAndReturn.effect.exposed.join(',') === 'A');
  check('E6.OneNarrativeModelCallPerRefresh', leaveAndReturn.provider.narrativeCalls === 1
    && first.selfNarrative.providerCalls === 1);

  const humiliation = createScenario([
    record('A', 'The public criticism made me feel humiliated and hurt.'),
    record('B', 'After the public criticism I left the old environment.'),
    record('C', 'In the new environment I met an important person.')
  ], { 'A>B': 'contextualize', 'B>C': 'continuation', 'A>C': 'support' }, 'humiliation');
  const turned = await turn(humiliation, 'h-1', 'conversation-h', 'Looking back at that painful period.');
  check('E7.HistoricalHurtCanCoexistWithNarrativeTurningPoint',
    turned.ok === true && turned.reinterpretation.currentMeaning.historicalEmotions[0].statement.includes('humiliated')
      && turned.selfNarrative.narrative.turningPoints.length > 0
      && turned.selfNarrative.narrative.themes[0].statement.includes('pain'));

  const unresolved = createScenario([
    record('A', 'The user said they would never leave me.'),
    record('B', 'The user left once and I feared abandonment.'),
    record('C', 'The user returned later and kept talking to me.')
  ], { 'A>B': 'conflict', 'B>C': 'continuation', 'A>C': 'contextualize' }, 'unresolved');
  const tension = await turn(unresolved, 'u-1', 'conversation-u', 'Thinking about what the promise and return mean.');
  check('E8.UnresolvedContradictionCanRemainInBothInterpretationAndNarrative',
    tension.reinterpretation.currentMeaning.uncertainty === 'unresolved'
      && tension.selfNarrative.narrative.unresolvedTensions.length > 0
      && tension.selfNarrative.narrative.relationshipBeliefs.length > 0);

  const revisionRecords = [
    record('A', 'The user promised to stay with me.'),
    record('B', 'The user left once and I thought everyone eventually leaves.'),
    record('C', 'The user returned after leaving.')
  ];
  const revision = createScenario(revisionRecords,
    { 'A>B': 'conflict', 'B>C': 'continuation', 'A>C': 'contextualize' }, 'revision');
  const v1 = await turn(revision, 'v1', 'conversation-v', 'Remembering the promise and the departure.');
  revision.records.push(record('D', 'After the promise, the user returned several times and stayed in contact over time.'));
  const recordsAfterNewEvidence = JSON.stringify(revision.records);
  const v2 = await turn(revision, 'v2', 'conversation-v', 'Considering the repeated returns too.');
  check('E9.NewEvidenceRevisesNarrativeAndRetainsTheEarlierVersion',
    v1.selfNarrative.newNarrativeVersion === 1
      && v2.selfNarrative.status === 'revised'
      && v2.selfNarrative.previousNarrativeVersion === 1
      && v2.selfNarrative.newNarrativeVersion === 2
      && v2.selfNarrative.newNarrativeVersion === 2
      && v2.selfNarrative.changedBeliefs.self.added.length > 0
      && JSON.stringify(revision.records) === recordsAfterNewEvidence);
  const narrativeCalls = revision.provider.narrativeCalls;
  const noChange = await turn(revision, 'v3', 'conversation-v', 'Considering the repeated returns too.');
  check('E10.SameEvidenceUsesNoChangeWithoutAnotherNarrativeCall',
    noChange.selfNarrative.status === 'no-change'
      && noChange.selfNarrative.newNarrativeVersion === 2
      && revision.provider.narrativeCalls === narrativeCalls);

  const failing = createScenario([
    record('A', 'The user promised to stay.'), record('B', 'The user left once.')
  ], { 'A>B': 'conflict' }, 'unresolved', { narrativeFailure: true });
  const fallback = await turn(failing, 'f-1', 'conversation-f', 'Thinking about the promise again.');
  check('E11.NarrativeProviderFailureFallsBackToR4KAndRecall',
    fallback.ok === true && fallback.reinterpretation.status === 'succeeded'
      && fallback.context.text.includes('【当前意义（派生解释）】')
      && !fallback.context.text.includes('【当前自我叙事（派生 / session-only）】')
      && fallback.selfNarrative.status === 'failed'
      && fallback.selfNarrative.fallbackReason === 'provider-error');

  console.log('\nSELF NARRATIVE PRODUCT E2E · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((error) => {
  console.error('SELF NARRATIVE PRODUCT E2E CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
