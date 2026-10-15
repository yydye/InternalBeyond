'use strict';

const createRuntimeInterpretation = require('../services/home-node/runtime-interpretation.js');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) { passed += 1; console.log('PASS ' + name); }
  else { failed += 1; console.error('FAIL ' + name + (detail ? ' · ' + JSON.stringify(detail) : '')); }
}
function parseEnvelope(request) {
  const content = request && request.messages && request.messages[0] ? request.messages[0].content : '';
  const match = /```json\s*\n([\s\S]*?)\n\s*```/.exec(String(content || ''));
  return match ? JSON.parse(match[1]) : null;
}
const records = [
  { id: 'A', title: 'A', content: '用户没有赴约，我当时感到被抛弃。', source: 'user', kind: 'episodic', valence: -0.8, arousal: 0.7, visibility: 'public' },
  { id: 'B', title: 'B', content: '后来知道用户当天在急诊。', source: 'user', kind: 'episodic', valence: 0.1, arousal: 0.2, visibility: 'public' },
  { id: 'C', title: 'C', content: '之后用户又主动回来。', source: 'user', kind: 'episodic', valence: 0.5, arousal: 0.4, visibility: 'public' }
];
const RELATIONS = ['support', 'complement', 'conflict', 'correction', 'continuation', 'contextualize', 'unrelated'];
function tension(anchor, values) {
  const row = { anchorMemoryId: anchor };
  for (const relation of RELATIONS) row[relation] = (values && values[relation]) || [];
  return row;
}
const association = {
  schemaVersion: 'memory-association-v1', depth: 1, maxDepth: 1,
  workingSet: [
    { memoryId: 'A', activationReasons: ['direct_recall'], anchorMemoryIds: [] },
    { memoryId: 'B', activationReasons: ['association_correction'], anchorMemoryIds: ['A'] },
    { memoryId: 'C', activationReasons: ['association_contextualize'], anchorMemoryIds: ['A'] }
  ],
  edges: [
    { anchorMemoryId: 'A', relatedMemoryId: 'B', relation: 'correction', basis: ['provenance_reference'], pairRole: 'anchor_candidate' },
    { anchorMemoryId: 'A', relatedMemoryId: 'C', relation: 'contextualize', basis: ['same_recall_cluster'], pairRole: 'anchor_candidate' }
  ],
  tensionSets: [tension('A', { correction: ['B'], contextualize: ['C'] })]
};
const snapshot = JSON.stringify(records);
function createRuntime(options) {
  const opts = options || {};
  const calls = [];
  const mutation = { puts: 0, deletes: 0, relationshipWrites: 0 };
  const store = {
    getRecord: (id) => records.find((r) => r.id === id) || null,
    getRevision: () => 7,
    putRecord: () => { mutation.puts += 1; throw new Error('interpretation must not write Memory'); },
    deleteRecord: () => { mutation.deletes += 1; throw new Error('interpretation must not delete Memory'); }
  };
  const registry = {
    getCharacterSpec: () => ({ provider: 'test', model: 'test-model', endpoint: 'https://example.invalid', credentialRef: 'cred-test' }),
    getCharacter: () => ({ dto: { relationship: 'close friend' } })
  };
  const port = opts.port === null ? null : {
    run: async (request) => {
      calls.push(request);
      if (typeof opts.behavior === 'function') return opts.behavior(request, calls.length);
      const envelope = parseEnvelope(request);
      const directIds = envelope && envelope.ASSOCIATION_VIEW
        ? envelope.ASSOCIATION_VIEW.directMemoryIds
        : (envelope && envelope.MEMORY_BATCH || []).map((row) => row.memoryId);
      const payload = { items: directIds.map((id) => ({
        memoryId: id, meaning: '当前理解保留当时的体验。', appraisal: 'mixed', affect: 'hurt',
        relationshipMeaning: null, causalAttribution: null, basis: 'ai_inference', subjectiveConfidence: 0.5
      })) };
      if (envelope && envelope.ASSOCIATION_VIEW) {
        const ids = envelope.MEMORY_BATCH.map((row) => row.memoryId);
        payload.currentMeaning = {
          summary: '当时的受伤仍然真实，后来知道的情况改变了现在对缺席的理解。',
          historicalFacts: [{ memoryId: 'A', statement: '当时用户没有赴约。' }],
          historicalEmotions: [{ memoryId: 'A', statement: '当时我感到被抛弃。' }],
          currentKnowledge: [{ memoryId: 'B', statement: '后来知道用户当天在急诊。' }],
          currentBeliefs: [{ memoryId: 'B', statement: '现在不再认为缺席是故意不在乎。' }],
          uncertainty: 'medium'
        };
        if (!ids.includes('B')) payload.currentMeaning.currentKnowledge[0].memoryId = 'A';
      }
      return { ok: true, text: JSON.stringify(payload) };
    }
  };
  const runtime = createRuntimeInterpretation({
    registry: registry,
    memoryStore: store,
    credentialAccess: { resolve: () => ({ ok: true, secret: 'test-secret' }) },
    modelPort: port,
    autoInterpretationPolicy: { autoInterpretationEnabled: true },
    clock: () => 5000,
    logger: () => {}
  });
  return { runtime, calls, store, mutation };
}
function binding(turnId, extras) {
  return Object.assign({
    characterId: 'char-a', turnId: turnId,
    turnIdentity: { turnId: turnId, requestId: turnId, conversationId: 'dm:char-a' },
    selectedIds: ['A'], records: records,
    channel: 'surface', currentTopic: 'revisiting the missed visit with new information',
    relationshipConfig: 'close friend',
    association: association, associationRecords: records
  }, extras || {});
}

(async function main() {
  const live = createRuntime();
  const first = await live.runtime.runFromAuthoritativeRecall(binding('reinterpret-1'), { remainingBudgetMs: 900 });
  check('R1.sameRuntimeAcceptsBoundAssociationEvidence',
    first.ok === true && first.contextualInterpretation
      && first.contextualInterpretation.currentMeaning.currentKnowledge[0].memoryId === 'B'
      && first.contextualInterpretation.associatedMemoryIds.join(',') === 'B,C');
  check('R2.authoritativeRelationshipAndUnavailableEmotionAreUsed',
    first.contextualInterpretation.contextualFactorsUsed.relationship === 'character-configuration'
      && first.contextualInterpretation.contextualFactorsUsed.emotion === 'NOT_AVAILABLE'
      && first.contextualInterpretation.contextualFactorsUsed.cognitiveSnapshot === 'NOT_AVAILABLE');
  check('R3.identityIncludesMemoryAssociationContextAndSchema',
    first.contextualInterpretation.identity
      && first.contextualInterpretation.identity.memorySetFingerprint.startsWith('sha256-v1:')
      && first.contextualInterpretation.identity.associationFingerprint.startsWith('sha256-v1:')
      && first.contextualInterpretation.identity.contextFingerprint.startsWith('sha256-v1:')
      && first.contextualInterpretation.identity.schemaVersion === 'memory-reinterpretation-v1');
  check('R4.contextualModelCallIsSingleAndWithinRecallBudget',
    live.calls.length === 1 && first.providerCalls === 1 && first.timeoutMs <= 900);
  check('R5.canonicalMemoryIsReadOnly', JSON.stringify(records) === snapshot
    && live.mutation.puts === 0 && live.mutation.deletes === 0);

  const contextA = live.runtime.runFromAuthoritativeRecall(binding('context-a', {
    currentTopic: 'planning a future visit'
  }), { remainingBudgetMs: 900 });
  const contextB = live.runtime.runFromAuthoritativeRecall(binding('context-b', {
    currentTopic: 'revisiting an old hurt'
  }), { remainingBudgetMs: 900 });
  const [a, b] = await Promise.all([contextA, contextB]);
  check('R6.contextChangesInterpretationIdentity',
    a.ok === true && b.ok === true
      && a.contextualInterpretation.identity.value !== b.contextualInterpretation.identity.value
      && a.contextualInterpretation.identity.memorySetFingerprint === b.contextualInterpretation.identity.memorySetFingerprint
      && a.contextualInterpretation.identity.associationFingerprint === b.contextualInterpretation.identity.associationFingerprint);
  check('R7.sameMemorySetCanReceiveDifferentAuthoritativeTopics',
    parseEnvelope(live.calls[1]).CURRENT_CONTEXT.currentTopic !== parseEnvelope(live.calls[2]).CURRENT_CONTEXT.currentTopic);

  const directOnly = createRuntime();
  const direct = await directOnly.runtime.runFromAuthoritativeRecall(binding('direct-only', {
    association: null, associationRecords: undefined, currentTopic: undefined
  }), {});
  check('R8.directOnlyCallRemainsR4CCompatible',
    direct.ok === true && !direct.contextualInterpretation
      && parseEnvelope(directOnly.calls[0]).kind === 'MEMORY_INTERPRETATION_INPUT');

  const eightRecords = Array.from({ length: 9 }, (_, i) => Object.assign({}, records[0], {
    id: 'M' + i, title: 'M' + i, content: 'memory ' + i
  }));
  const boundedAssoc = Object.assign({}, association, {
    workingSet: eightRecords.slice(0, 8).map((row) => ({ memoryId: row.id, activationReasons: ['direct_recall'] }))
      .concat([{ memoryId: 'M8', activationReasons: ['association_support'] }]),
    edges: [{ anchorMemoryId: 'M0', relatedMemoryId: 'M8', relation: 'support', basis: ['lexical_overlap'], pairRole: 'anchor_candidate' }]
  });
  const bounded = createRuntime();
  const boundedResult = await bounded.runtime.runFromAuthoritativeRecall(binding('bounded', {
    selectedIds: eightRecords.slice(0, 8).map((row) => row.id),
    association: boundedAssoc, associationRecords: eightRecords
  }), {});
  const boundedEnvelope = parseEnvelope(bounded.calls[0]);
  check('R9.directIdsKeepPriorityUnderEightMemoryCap',
    boundedResult.ok === true && boundedEnvelope.MEMORY_BATCH.length === 8
      && boundedEnvelope.MEMORY_BATCH.every((row) => row.memoryId !== 'M8')
      && boundedEnvelope.kind === 'MEMORY_INTERPRETATION_INPUT');

  const invalid = createRuntime({ behavior: (request) => {
    const envelope = parseEnvelope(request);
    const payload = {
      items: [{ memoryId: 'A', meaning: 'bad', appraisal: 'mixed', affect: 'hurt', basis: 'ai_guess', subjectiveConfidence: 0.2 }],
      currentMeaning: {
        summary: 'bad', historicalFacts: [], historicalEmotions: [], currentKnowledge: [], currentBeliefs: [], uncertainty: 'low'
      }, deleteMemory: ['A']
    };
    return { ok: true, text: JSON.stringify(payload) };
  } });
  const invalidResult = await invalid.runtime.runFromAuthoritativeRecall(binding('invalid'), {});
  check('R10.unauthorizedMutationFieldFailsClosed', invalidResult.ok === false
    && invalidResult.status === 'failed' && invalidResult.providerCalls === 1);

  const timeout = createRuntime({ behavior: () => new Promise(() => {}) });
  const timeoutResult = await timeout.runtime.runFromAuthoritativeRecall(binding('timeout'), { remainingBudgetMs: 35 });
  check('R11.timeoutIsBoundedAndDoesNotRetry', timeoutResult.ok === false
    && timeoutResult.status === 'timed-out' && timeoutResult.providerCalls === 1
    && timeout.calls.length === 1 && timeoutResult.timeoutMs <= 35);

  const unavailable = createRuntime({ port: null });
  const unavailableResult = await unavailable.runtime.runFromAuthoritativeRecall(binding('provider-offline'), {});
  check('R12.providerUnavailableReturnsRuntimeFailureForRecallFallback', unavailableResult.ok === false
    && unavailableResult.status === 'failed' && unavailableResult.providerCalls === 0);

  const noPolicy = createRuntime();
  const gatedRuntime = createRuntimeInterpretation({
    registry: { getCharacterSpec: () => ({ provider: 'test', model: 'm', endpoint: 'https://example.invalid', credentialRef: 'c' }) },
    memoryStore: noPolicy.store,
    credentialAccess: { resolve: () => ({ ok: true, secret: 'x' }) },
    modelPort: { run: async () => { throw new Error('policy must prevent provider call'); } },
    autoInterpretationPolicy: { autoInterpretationEnabled: false },
    clock: () => 5000, logger: () => {}
  });
  const disabled = await gatedRuntime.runFromAuthoritativeRecall(binding('disabled'), {});
  check('R13.existingPerCharacterCostGateRemainsAuthority', disabled.status === 'disabled'
    && disabled.providerCalls === 0);

  console.log('\nMEMORY REINTERPRETATION RUNTIME · ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((error) => {
  console.error('MEMORY REINTERPRETATION RUNTIME CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
