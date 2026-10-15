'use strict';

const { createRuntimeRecall } = require('../services/home-node/runtime-recall.js');
const { createRuntimeMemoryAssociation } = require('../services/home-node/runtime-memory-association.js');
const createMemoryRetrieval = require('../services/home-node/memory-retrieval.js');
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
    createdByName: 'Character',
    visibility: 'public',
    visibleTo: [],
    excludeFrom: [],
    created: 1000
  }, extra || {});
}

const records = [
  record('A', 'You promised to visit this weekend.'),
  record('B', 'You failed to attend the visit that weekend.'),
  record('C', 'Your hospital emergency explains the missed visit that weekend.'),
  record('D', 'I felt abandoned after the absent weekend visit.')
];
const recordSnapshot = JSON.stringify(records);
const effects = { activated: [], exposed: [], turnEnds: 0 };
let capAssociationScan = false;
const model = {
  calls: 0,
  run: async function (request) {
    this.calls += 1;
    const batch = JSON.parse(request.messages[0].content);
    const items = batch.pairs.map((pair) => {
      const key = pair.anchor.memoryId + '>' + pair.related.memoryId;
      let relation = 'contextualize';
      if (key === 'A>B') relation = 'continuation';
      else if (key === 'A>C') relation = 'contextualize';
      else if (key === 'A>D') relation = 'contextualize';
      else if (key === 'B>C') relation = 'correction';
      return {
        anchorMemoryId: pair.anchor.memoryId,
        relatedMemoryId: pair.related.memoryId,
        relation: relation
      };
    });
    return { text: JSON.stringify({ items: items }) };
  }
};
const store = {
  listRecords: function (query) {
    return {
      ok: true, records: records, count: records.length, revision: 1,
      /* P21-R4-M supplies the same Recall snapshot to the existing Association
         stage, so the capped fixture marks that single snapshot as truncated. */
      truncated: !!capAssociationScan
    };
  },
  getMemorySettings: function () {
    return { ok: true, settings: { budget: 2000, contentLen: 200 } };
  },
  recordActivation: function (ids) {
    effects.activated.push.apply(effects.activated, ids);
    return { ok: true, updated: ids.length, duplicated: [], reason: null, revisionTouched: false };
  },
  getRevision: function () { return 1; },
  putRecord: function () { throw new Error('Association must not write Memory'); },
  deleteRecord: function () { throw new Error('Association must not delete Memory'); }
};
const sessionState = {
  currentTurnIndex: function () { return 0; },
  beginHomeTurn: function () { return 1; },
  recordExposure: function (input) {
    effects.exposed.push.apply(effects.exposed, input.memoryIds);
    return input.memoryIds.length;
  },
  endHomeTurn: function () { effects.turnEnds += 1; return true; }
};
const retrieval = createMemoryRetrieval({
  store: store,
  sessionState: sessionState,
  clock: function () { return 5000; },
  random: function () { return 0.5 }
});
const association = createRuntimeMemoryAssociation({
  modelPort: model,
  registry: { getCharacterSpec: function () {
    return { provider: 'test', model: 'association-model', endpoint: 'https://example.invalid', credentialRef: 'c1' };
  } },
  credentialAccess: { resolve: function () { return { ok: true, secret: 'private-test-secret' }; } },
  clock: function () { return 5000; }
});
const runtimeRecall = createRuntimeRecall({
  memoryRetrieval: retrieval,
  memoryStore: store,
  registry: { getCharacterSpec: function () { return {}; } },
  sessionState: sessionState,
  associationRuntime: association,
  clock: function () { return 5000; },
  random: function () { return 0.5 }
});

(async function main() {
  const request = {
    operation: 'memory-recall',
    mode: 'authoritative',
    characterId: 'role-a',
    requestId: 'turn-1',
    conversationId: 'conversation-1',
    message: 'Please remember my promise.',
    timeoutMs: 2000
  };
  const first = await runtimeRecall.run(request);
  check('E1.productionRecallRunsAssociationAfterDirectSelection',
    first.ok === true && first.association
      && first.association.status === 'expanded'
      && first.association.depth === 1
      && model.calls === 1,
    first.association);
  check('E2.directRecallIdsRemainSelectionAuthority',
    JSON.stringify(first.selectedIds) === JSON.stringify(['A'])
      && JSON.stringify(effects.activated) === JSON.stringify(['A'])
      && JSON.stringify(effects.exposed) === JSON.stringify(['A']));
  check('E3.workingSetCarriesActivationProvenance',
    first.association.workingSet.some((row) => row.memoryId === 'A'
      && row.activationReasons.includes('direct_recall'))
      && first.association.workingSet.some((row) => row.memoryId === 'B'
        && row.activationReasons.includes('association_continuation'))
      && first.association.workingSet.some((row) => row.memoryId === 'C'
        && row.activationReasons.includes('association_contextualize')));
  check('E4.currentContextReceivesBoundedTensionView',
    first.context.text.includes('【关联记忆（派生关系视图）】')
      && first.context.text.includes('[correction]')
      && first.context.associatedCount <= CORE.MAX_EXPANSION
      && first.context.chars <= first.chars + CORE.MAX_CONTEXT_CHARS);
  check('E5.factualCorrectionDoesNotEraseEmotionMemory',
    first.association.edges.some((edge) => edge.anchorMemoryId === 'B'
      && edge.relatedMemoryId === 'C' && edge.relation === 'correction')
      && first.association.edges.some((edge) => edge.relatedMemoryId === 'D'));
  check('E6.directLifecycleCountersExcludeAssociationExpansion',
    first.boundary.providerCalls === 1
      && first.effects.activation.updated === 1
      && first.effects.exposure.written === 1);
  check('E7.associationNeverMutatesCanonicalMemoryOrOtherAuthorities',
    JSON.stringify(records) === recordSnapshot
      && effects.turnEnds === 1
      && !JSON.stringify(first.association).includes('private-test-secret'));

  const replay = await runtimeRecall.run(request);
  check('E8.replayReusesDerivedResultWithoutSecondMutation',
    replay.ok === true && replay.association.status === 'expanded'
      && JSON.stringify(replay.context) === JSON.stringify(first.context)
      && model.calls === 1
      && effects.activated.length === 1
      && effects.exposed.length === 1
      && effects.turnEnds === 1);

  capAssociationScan = true;
  const capped = await runtimeRecall.run(Object.assign({}, request, {
    requestId: 'turn-2',
    message: 'Please remember my promise again.'
  }));
  check('E9.candidateScanCapFallsBackWithoutChangingDirectRecall',
    capped.ok === true && capped.selectedIds.includes('A')
      && capped.association.status === 'fallback-direct'
      && capped.association.reason === 'candidate-scan-cap-reached'
      && capped.boundary.providerCalls === 0
      && model.calls === 1);

  console.log('\nMemory Association Product E2E: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
