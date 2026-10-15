'use strict';

const { createRuntimeRecall } = require('../services/home-node/runtime-recall.js');
const { createRuntimeMemoryAssociation } = require('../services/home-node/runtime-memory-association.js');
const createRuntimeInterpretation = require('../services/home-node/runtime-interpretation.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}
function record(id, content) {
  return {
    id: id, title: id, content: content, kind: 'episodic', source: 'user',
    domain: '日常', tags: [], valence: -0.6, arousal: 0.7, importance: 6,
    resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: 500, lastActivated: 500,
    createdBy: 'role-a', createdByName: 'Character'
  };
}
function parseJsonEnvelope(content) {
  const match = /```json\s*\n([\s\S]*?)\n\s*```/.exec(String(content || ''));
  return match ? JSON.parse(match[1]) : null;
}
function parseAssociationInput(content) {
  try { return JSON.parse(String(content || '')); } catch (_) { return null; }
}
function currentMeaningFor(envelope) {
  const rows = envelope.MEMORY_BATCH || [];
  const a = rows.find((row) => row.memoryId === 'A') || rows[0] || { memoryId: 'A', content: '' };
  const b = rows.find((row) => row.memoryId !== a.memoryId) || a;
  const relations = envelope.ASSOCIATION_VIEW.edges.map((edge) => edge.relation);
  const topic = envelope.CURRENT_CONTEXT.currentTopic || '';
  const summary = relations.includes('correction')
    ? '当时受到的伤害仍然真实；现在知道急诊情况后，我不再把缺席解释为故意抛弃。'
    : relations.includes('conflict')
      ? '承诺、离开和后来回来都保留在记忆里；目前仍有未解决的张力。'
      : topic.toLowerCase().includes('future') || topic.includes('未来')
        ? '这段受伤经历仍然真实；此刻它也提醒我如何看待未来的相处。'
        : '当时的羞辱和痛苦仍然真实；它后来也成为人生转折的一部分。';
  const historicalEmotion = String(a.content).includes('abandoned') ? '当时我感到被抛弃和难过。'
    : String(a.content).includes('afraid') || String(a.content).includes('feared') ? '当时的害怕是真实发生过的。'
      : '当时的羞辱和痛苦是真实发生过的。';
  const knowledge = String(b.content || '后来有了新的经历。').slice(0, 200);
  const belief = relations.includes('correction')
    ? '现在不再认为那次缺席表示用户不在乎。'
    : relations.includes('conflict')
      ? '目前不作可靠或不可靠的确定结论。'
      : '现在能同时保留痛苦和后来形成的新意义。';
  return {
    summary: summary,
    historicalFacts: [{ memoryId: a.memoryId, statement: String(a.content).slice(0, 200) }],
    historicalEmotions: [{ memoryId: a.memoryId, statement: historicalEmotion }],
    currentKnowledge: [{ memoryId: b.memoryId, statement: knowledge }],
    currentBeliefs: [{ memoryId: b.memoryId, statement: belief }],
    uncertainty: relations.includes('conflict') ? 'unresolved' : 'medium'
  };
}
function createScenario(records, relationRules) {
  const before = JSON.stringify(records);
  const effect = {
    activated: [], exposed: [], turnEnds: 0, behaviorWrites: 0,
    expectationCalls: 0, memoryWrites: 0, memoryDeletes: 0,
    relationshipWrites: 0, selfNarrativeWrites: 0, predictionErrorWrites: 0
  };
  const store = {
    listRecords: () => ({ ok: true, records: records, count: records.length, revision: 1, truncated: false }),
    getMemorySettings: () => ({ ok: true, settings: { budget: 2000, contentLen: 1200 } }),
    getRecord: (id) => records.find((row) => row.id === id) || null,
    getRevision: () => 1,
    recordActivation: (ids) => ({ ok: true, updated: ids.length, duplicated: [], reason: null }),
    putRecord: () => { effect.memoryWrites += 1; throw new Error('reinterpretation must not write'); },
    deleteRecord: () => { effect.memoryDeletes += 1; throw new Error('reinterpretation must not delete'); }
  };
  const provider = {
    calls: [], associationCalls: 0, interpretationCalls: 0,
    run: async function (request) {
      this.calls.push(request);
      const content = request && request.messages && request.messages[0] ? request.messages[0].content : '';
      if (String(content).includes('```json')) {
        this.interpretationCalls += 1;
        const envelope = parseJsonEnvelope(content);
        const directIds = envelope.ASSOCIATION_VIEW.directMemoryIds;
        const payload = {
          items: directIds.map((id) => ({
            memoryId: id, meaning: '当前解释保留历史体验。', appraisal: 'mixed', affect: 'hurt',
            relationshipMeaning: null, causalAttribution: null, basis: 'ai_inference', subjectiveConfidence: 0.5
          })),
          currentMeaning: currentMeaningFor(envelope)
        };
        return { ok: true, text: JSON.stringify(payload) };
      }
      this.associationCalls += 1;
      const batch = parseAssociationInput(content);
      const items = (batch && batch.pairs || []).map((pair) => {
        const key = pair.anchor.memoryId + '>' + pair.related.memoryId;
        return {
          anchorMemoryId: pair.anchor.memoryId,
          relatedMemoryId: pair.related.memoryId,
          relation: relationRules[key] || 'support'
        };
      });
      return { ok: true, text: JSON.stringify({ items: items }) };
    }
  };
  const registry = {
    getCharacterSpec: () => ({ provider: 'test', model: 'reinterp-test-model', endpoint: 'https://example.invalid', credentialRef: 'test-credential' }),
    getCharacter: () => ({ dto: { relationship: 'close friend' } })
  };
  const credentials = { resolve: () => ({ ok: true, secret: 'test-only-secret' }) };
  const memoryAssociation = createRuntimeMemoryAssociation({
    modelPort: provider, registry: registry, credentialAccess: credentials,
    clock: () => 5000, logger: () => {}
  });
  const interpretation = createRuntimeInterpretation({
    registry: registry, memoryStore: store, credentialAccess: credentials,
    modelPort: provider, autoInterpretationPolicy: { autoInterpretationEnabled: true },
    clock: () => 5000, logger: () => {}
  });
  const sessionState = {
    currentTurnIndex: () => 0,
    beginHomeTurn: () => 1,
    recordExposure: (input) => { effect.exposed.push.apply(effect.exposed, input.memoryIds); return input.memoryIds.length; },
    endHomeTurn: () => { effect.turnEnds += 1; return true; }
  };
  const retrieval = {
    store: store,
    retrieve: function () {
      const anchor = records[0];
      const text = '【直接记忆】\n- ' + anchor.title + '：' + anchor.content + '\n';
      return {
        ok: true, text: text, selectedIds: [anchor.id], reinforcementIds: [anchor.id],
        count: 1, chars: text.length, candidates: records.length, activationPolicy: 'normal', reason: null,
        diagnostics: { channel: 'surface', counts: { input: records.length, visible: records.length, gated: 1, selected: 1 } }
      };
    },
    reinforce: (ids) => { effect.activated.push.apply(effect.activated, ids); return { ok: true, updated: ids.length, duplicated: [], reason: null }; }
  };
  const runtimeRecall = createRuntimeRecall({
    memoryRetrieval: retrieval, memoryStore: store, registry: registry,
    sessionState: sessionState, associationRuntime: memoryAssociation,
    interpretation: interpretation,
    expectation: { runFromValidatedInterpretation: () => { effect.expectationCalls += 1; } },
    behaviorEffect: {
      consumeForTurn: () => null,
      deriveAndHold: () => { effect.behaviorWrites += 1; }
    },
    clock: () => 5000, random: () => 0.5, logger: () => {}
  });
  return { runtimeRecall, provider, effect, records, before };
}

async function recall(scenario, requestId, conversationId, message) {
  return scenario.runtimeRecall.run({
    operation: 'memory-recall', mode: 'authoritative', characterId: 'role-a',
    requestId: requestId, conversationId: conversationId, message: message, timeoutMs: 5000
  });
}

(async function main() {
  const turningPoint = createScenario([
    record('A', 'Ten years ago the public criticism in the old environment made me feel humiliated and hurt.'),
    record('B', 'After the public criticism, I left the old environment.'),
    record('C', 'In the new environment I met the most important person.')
  ], { 'A>B': 'continuation', 'A>C': 'contextualize', 'B>C': 'support' });
  const first = await recall(turningPoint, 'turn-1', 'conversation-1', 'Looking back on this period with a mature view.');
  check('E1.humiliationBecomesBroaderMeaningWithoutErasure',
    first.ok === true && first.selectedIds.join(',') === 'A'
      && first.reinterpretation && first.reinterpretation.status === 'succeeded'
      && first.reinterpretation.currentMeaning.summary.includes('转折')
      && first.reinterpretation.currentMeaning.historicalEmotions[0].statement.includes('羞辱和痛苦')
      && first.context.text.includes('【当前意义（派生解释）】'));
  check('E2.associationProvenanceFeedsInterpretationTrace',
    first.reinterpretation.associatedMemoryIds.length > 0
      && first.reinterpretation.relationsUsed.some((edge) => edge.relation === 'contextualize')
      && first.association.workingSet.some((item) => item.memoryId === 'B'
        && item.activationReasons.some((reason) => reason.indexOf('association_') === 0)));
  check('E3.directRecallSelectionAndLifecycleStayDirectOnly',
    first.selectedIds.join(',') === 'A'
      && turningPoint.effect.activated.join(',') === 'A'
      && turningPoint.effect.exposed.join(',') === 'A');
  check('E4.reinterpretationHasNoAuthorityWrites',
    JSON.stringify(turningPoint.records) === turningPoint.before
      && turningPoint.effect.memoryWrites === 0 && turningPoint.effect.memoryDeletes === 0
      && turningPoint.effect.relationshipWrites === 0 && turningPoint.effect.behaviorWrites === 0
      && turningPoint.effect.expectationCalls === 0 && turningPoint.effect.predictionErrorWrites === 0
      && turningPoint.effect.selfNarrativeWrites === 0);
  check('E5.recallAndInterpretationCallsAreIndependentlyBounded',
    turningPoint.provider.associationCalls <= 1
      && turningPoint.provider.interpretationCalls === 1
      && first.reinterpretation.providerCalls === 1
      && JSON.stringify(first.reinterpretation.currentMeaning).length <= 1200
      && first.context.text.slice(first.context.text.indexOf('【当前意义（派生解释）】')).length <= 1200);

  const missedVisit = createScenario([
    record('A', 'The user did not attend our appointment and I felt abandoned and sad.'),
    record('B', 'Later I learned the user was in the emergency room that day.'),
    record('C', 'I was still very sad after the missed appointment.')
  ], { 'A>B': 'correction', 'A>C': 'contextualize', 'B>C': 'support' });
  const corrected = await recall(missedVisit, 'turn-2', 'conversation-2', 'Revisiting the missed appointment after learning more.');
  check('E6.correctionChangesCurrentBeliefAndPreservesHistoricalHurt',
    corrected.ok === true && corrected.reinterpretation.currentMeaning.currentBeliefs[0].statement.includes('不再认为')
      && corrected.reinterpretation.currentMeaning.historicalEmotions[0].statement.includes('被抛弃')
      && corrected.reinterpretation.relationsUsed.some((edge) => edge.relation === 'correction'));

  const unresolved = createScenario([
    record('A', 'You promised to stay with me and I feared you would leave.'),
    record('B', 'After that promise you left once.'),
    record('C', 'After you left, you came back and stayed.')
  ], { 'A>B': 'conflict', 'A>C': 'continuation', 'B>C': 'continuation' });
  const tension = await recall(unresolved, 'turn-3', 'conversation-3', 'Thinking about the promise and what happened later.');
  check('E7.conflictRemainsAnUnresolvedTension',
    tension.ok === true && tension.reinterpretation.currentMeaning.uncertainty === 'unresolved'
      && tension.reinterpretation.relationsUsed.some((edge) => edge.relation === 'conflict')
      && tension.reinterpretation.currentMeaning.currentBeliefs[0].statement.includes('不作'));

  const contextSensitive = createScenario([
    record('A', 'Ten years ago the public criticism in the old environment made me feel humiliated and hurt.'),
    record('B', 'After the public criticism, I left the old environment.'),
    record('C', 'In the new environment I met the most important person.')
  ], { 'A>B': 'continuation', 'A>C': 'contextualize', 'B>C': 'support' });
  const mature = await recall(contextSensitive, 'turn-4a', 'conversation-4', 'Looking back at this stage with a mature view.');
  const future = await recall(contextSensitive, 'turn-4b', 'conversation-4', 'Looking back at this stage with a mature view and considering the future.');
  check('E8.sameMemorySetChangesMeaningWithCurrentTopic',
    mature.ok === true && future.ok === true
      && mature.selectedIds.join(',') === future.selectedIds.join(',')
      && mature.reinterpretation.identity.memorySetFingerprint === future.reinterpretation.identity.memorySetFingerprint
      && mature.reinterpretation.identity.associationFingerprint === future.reinterpretation.identity.associationFingerprint
      && mature.reinterpretation.identity.contextFingerprint !== future.reinterpretation.identity.contextFingerprint
      && mature.reinterpretation.currentMeaning.summary !== future.reinterpretation.currentMeaning.summary,
    { mature: mature.reinterpretation, future: future.reinterpretation });

  const replayCalls = contextSensitive.provider.calls.length;
  const replay = await recall(contextSensitive, 'turn-4b', 'conversation-4', 'Looking back at this stage with a mature view and considering the future.');
  check('E9.turnReplayReusesMeaningAndDoesNotCallAgain', replay.ok === true
    && JSON.stringify(replay.reinterpretation) === JSON.stringify(future.reinterpretation)
    && contextSensitive.provider.calls.length === replayCalls);

  const fallback = createScenario([
    record('A', 'The user did not attend our appointment and I felt abandoned and sad.'),
    record('B', 'Later I learned the user was in the emergency room that day.')
  ], { 'A>B': 'correction' });
  fallback.provider.run = async function (request) {
    const content = request.messages[0].content;
    if (String(content).includes('```json')) {
      this.interpretationCalls += 1;
      throw new Error('fake provider failure');
    }
    this.associationCalls += 1;
    const batch = parseAssociationInput(content);
    return { ok: true, text: JSON.stringify({ items: (batch.pairs || []).map((pair) => ({
      anchorMemoryId: pair.anchor.memoryId, relatedMemoryId: pair.related.memoryId, relation: 'correction'
    })) }) };
  };
  const fallbackRecall = await recall(fallback, 'turn-fallback', 'conversation-fallback', 'Revisiting the missed appointment.');
  check('E10.interpretationFailureFallsBackToRecallAndAssociation',
    fallbackRecall.ok === true && fallbackRecall.association.status === 'expanded'
      && fallbackRecall.context.text.includes('【关联记忆（派生关系视图）】')
      && !fallbackRecall.context.text.includes('【当前意义（派生解释）】')
      && fallbackRecall.reinterpretation.status === 'failed'
      && fallbackRecall.reinterpretation.fallbackReason === 'provider-error',
    { association: fallbackRecall.association, reinterpretation: fallbackRecall.reinterpretation, context: fallbackRecall.context });

  console.log('\nMEMORY REINTERPRETATION PRODUCT E2E · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((error) => {
  console.error('MEMORY REINTERPRETATION PRODUCT E2E CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
