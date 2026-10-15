'use strict';

const path = require('path');
const fs = require('fs');
const { createRuntimeMemoryAssociation } = require('../services/home-node/runtime-memory-association.js');
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
function classifier(portState, relationFor) {
  return {
    run: async function (request) {
      portState.calls += 1;
      portState.lastRequest = request;
      const input = JSON.parse(request.messages[0].content);
      const items = input.pairs.map((pair) => ({
        anchorMemoryId: pair.anchor.memoryId,
        relatedMemoryId: pair.related.memoryId,
        relation: relationFor(pair.anchor.memoryId, pair.related.memoryId)
      }));
      return { text: JSON.stringify({ items: items }) };
    }
  };
}
function dependencies(port, extra) {
  return Object.assign({
    modelPort: port,
    registry: {
      getCharacterSpec: function () {
        return { provider: 'test', model: 'm1', endpoint: 'https://example.invalid', credentialRef: 'cred-1' };
      }
    },
    credentialAccess: {
      resolve: function () { return { ok: true, secret: 'association-test-secret' }; }
    },
    clock: function () { return 5000; }
  }, extra || {});
}

const records = [
  record('A', 'The user promised a weekend visit.'),
  record('B', 'The user missed the weekend visit.'),
  record('C', 'The user explained an emergency stopped the weekend visit.'),
  record('D', 'I felt abandoned after the missed weekend visit.')
];
const relationFor = (a, b) => {
  const key = a + '>' + b;
  if (key === 'A>B') return 'conflict';
  if (key === 'A>C') return 'contextualize';
  if (key === 'A>D') return 'contextualize';
  if (key === 'B>C') return 'correction';
  if (key === 'B>D' || key === 'C>D') return 'contextualize';
  return 'unrelated';
};

(async function main() {
  const state = { calls: 0, lastRequest: null };
  const runtime = createRuntimeMemoryAssociation(dependencies(classifier(state, relationFor)));
  const first = await runtime.expand({
    characterId: 'role-a',
    anchorIds: ['A'],
    records: records,
    currentMessage: 'What happened with the weekend visit?',
    budgetChars: 2000
  }, { timeoutMs: 1000 });
  check('R1.oneBatchedCallClassifiesBoundedPairs',
    first.ok === true && first.providerCalls === 1 && state.calls === 1
      && first.result.classifiedPairCount <= CORE.MAX_CLASSIFICATION_PAIRS,
    first.result && first.result.classifiedPairCount);
  check('R2.closedRelationsReachTensionSet',
    first.result && first.result.edges.some((edge) => edge.anchorMemoryId === 'A'
      && edge.relatedMemoryId === 'B' && edge.relation === 'conflict')
      && first.result.edges.some((edge) => edge.anchorMemoryId === 'B'
      && edge.relatedMemoryId === 'C' && edge.relation === 'correction'));
  check('R3.currentMessageOnlyRanksAfterClassification',
    state.lastRequest && state.lastRequest.temperature === 0
      && !state.lastRequest.messages[0].content.includes('What happened with the weekend visit?'));
  const callsBeforeMemo = state.calls;
  const second = await runtime.expand({
    characterId: 'role-a',
    anchorIds: ['A'],
    records: records,
    currentMessage: 'A different current topic: emergency care.',
    budgetChars: 2000
  }, { timeoutMs: 1000 });
  check('R4.structuralMemoIsContextIndependent',
    second.ok === true && second.providerCalls === 0 && state.calls === callsBeforeMemo
      && JSON.stringify(first.result.edges) === JSON.stringify(second.result.edges)
      && second.result.expansionIds.length <= CORE.MAX_EXPANSION);
  check('R5.modelCredentialDoesNotEnterResult',
    !JSON.stringify(first).includes('association-test-secret'));

  const invalidState = { calls: 0 };
  const invalidRuntime = createRuntimeMemoryAssociation(dependencies({
    run: async function () {
      invalidState.calls += 1;
      return { text: JSON.stringify({ items: [{
        anchorMemoryId: 'A', relatedMemoryId: 'B',
        relation: 'conflict', rewriteMemory: 'forbidden'
      }] }) };
    }
  }));
  const invalid = await invalidRuntime.expand({
    characterId: 'role-a', anchorIds: ['A'], records: records, budgetChars: 2000
  }, { timeoutMs: 1000 });
  check('R6.invalidOrOverreachingModelOutputFallsBackDirect',
    invalid.ok === false && invalid.status === 'fallback-direct'
      && invalid.reason === 'invalid-model-output' && invalidState.calls === 1);

  const timeoutState = { calls: 0 };
  const timeoutRuntime = createRuntimeMemoryAssociation(dependencies({
    run: function () {
      timeoutState.calls += 1;
      return new Promise(function () {});
    }
  }));
  const timeout = await timeoutRuntime.expand({
    characterId: 'role-a', anchorIds: ['A'], records: records, budgetChars: 2000
  }, { timeoutMs: 80 });
  check('R7.timeoutIsBoundedNoRetryAndDirectFallback',
    timeout.ok === false && timeout.status === 'fallback-direct'
      && timeout.reason === 'association-timeout' && timeoutState.calls === 1,
    timeout);

  const mechanicalState = { calls: 0 };
  const mechanicalRuntime = createRuntimeMemoryAssociation(dependencies(classifier(mechanicalState, relationFor)));
  const exactA = record('X1', 'The same canonical statement.', { title: 'Same' });
  const exactB = record('X2', 'The same canonical statement.', { title: 'Same' });
  const mechanical = await mechanicalRuntime.expand({
    characterId: 'role-a', anchorIds: ['X1'], records: [exactA, exactB], budgetChars: 1000
  }, { timeoutMs: 1000 });
  check('R8.mechanicalIdenticalContentSkipsModel',
    mechanical.ok === true && mechanical.providerCalls === 0 && mechanicalState.calls === 0
      && mechanical.result.edges.some((edge) => edge.relation === 'support'));

  const disabled = createRuntimeMemoryAssociation(dependencies(null, { enabled: false }));
  const disabledResult = await disabled.expand({
    characterId: 'role-a', anchorIds: ['A'], records: records
  });
  check('R9.disabledCapabilityFailsOpenToDirectRecall',
    disabledResult.ok === false && disabledResult.status === 'disabled');

  const described = runtime.describe();
  check('R10.authoritySurfaceHasNoWriters',
    described.canonicalMemoryWrites === 0
      && described.canonicalMemoryDeletes === 0
      && described.canonicalMemoryMerges === 0
      && described.relationshipWrites === 0
      && described.predictionErrorWrites === 0
      && described.selfNarrativeWrites === 0
      && described.maxDepth === 1
      && described.autoRetry === 'NONE');

  const source = fs.readFileSync(path.join(__dirname, '..', 'services/home-node/runtime-memory-association.js'), 'utf8');
  check('R11.runtimeHasNoCanonicalStoreWriterDependency',
    !/memory-store|putRecord|deleteRecord|recordActivation|relationshipAuthority/i.test(source));

  console.log('\nMemory Association Runtime: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
