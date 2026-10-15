'use strict';

/* Selector switch mechanics only. Synthetic rows verify the explicit V1/V2
 * control path, canary scope, rollback, and shared Desktop/Mobile Home Node
 * selector. These fixtures are not a relevance-quality evaluation set. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CORE = require('../assets/js/memory-retrieval-core.js');
const ORCHESTRATOR = require('../assets/js/memory-recall/memory-recall-orchestrator.js');
const createMemoryRetrieval = require('../services/home-node/memory-retrieval.js');

const NOW = Date.UTC(2026, 9, 13, 4, 0, 0);
const DAY = 86400000;
const HOUR = 3600000;
const QUERY = 'Do you remember the harbor inspection correction?';

function record(id, overrides) {
  return Object.assign({
    id: id,
    title: 'harbor inspection record ' + id,
    summary: 'harbor inspection note ' + id,
    oneLine: 'harbor inspection ' + id,
    content: 'Harbor inspection fixture detail ' + id,
    created: NOW - DAY,
    lastActivated: NOW - DAY,
    source: 'user', kind: 'episodic', domain: 'fixture', tags: [],
    visibility: 'public', visibleTo: [], excludeFrom: [], pinned: false,
    importance: 5, arousal: 0.3, valence: 0.5, resolved: false,
    activationCount: 0
  }, overrides || {});
}

const records = [
  record('old-interpretation', {
    title: 'harbor inspection abandonment',
    summary: 'the harbor inspection was abandoned',
    oneLine: 'Earlier interpretation: the harbor inspection was abandoned',
    content: 'An earlier, highly emotional interpretation of the harbor inspection.',
    created: NOW - 2.5 * DAY, lastActivated: NOW - 3 * HOUR,
    importance: 7, arousal: 1, valence: 0.05, activationCount: 19
  }),
  record('correction', {
    title: 'harbor inspection correction',
    summary: 'new report corrects the harbor inspection account',
    oneLine: 'The signed harbor inspection report confirms completion',
    content: 'New evidence corrects the earlier harbor inspection account.',
    created: NOW, lastActivated: NOW,
    importance: 6, arousal: 0.2, valence: 0.5, activationCount: 0
  }),
  record('supporting-record', {
    title: 'harbor inspection supporting record',
    summary: 'harbor inspection supporting record',
    content: 'Additional harbor inspection context.',
    created: NOW - 20 * DAY,
    importance: 4
  }),
  record('private-hidden', {
    title: 'harbor inspection correction private',
    summary: 'harbor inspection correction hidden',
    content: 'hidden private harbor inspection detail',
    visibility: 'private', pinned: true, importance: 10, arousal: 1
  })
];

const storeStats = { reads: 0, writes: 0 };
const store = {
  listRecords: function () {
    storeStats.reads += 1;
    return { ok: true, records: records, count: records.length, revision: 1 };
  },
  getMemorySettings: function () {
    return { ok: true, settings: { budget: 4000, contentLen: 700 } };
  },
  recordActivation: function () {
    storeStats.writes += 1;
    return { ok: true, updated: 0, revisionTouched: false };
  }
};

const retrieval = createMemoryRetrieval({
  store: store,
  clock: function () { return NOW; },
  random: function () { return 0.42; },
  logger: function () { throw new Error('selector switch test must not log'); },
  selectorShadow: false
});
const configuredCanary = createMemoryRetrieval({
  store: store, clock: function () { return NOW; }, logger: function () {},
  selectorVersion: 'v2:canary-role', selectorShadow: false
});
assert.equal(configuredCanary.getSelectorVersion('canary-role'), 'v2',
  'the production policy string supports a character-scoped canary');
assert.equal(configuredCanary.getSelectorVersion('control-role'), 'v1');

assert.equal(retrieval.getSelectorVersion('canary-role'), 'v1', 'default selector is V1');
assert.equal(retrieval.getSelectorVersion('control-role'), 'v1', 'non-canary remains V1');
const canaryStartV1 = retrieval.retrieve('canary-role', {
  userMessage: QUERY, now: NOW, includeHeader: true
});
const requestCannotEnableV2 = retrieval.retrieve('control-role', {
  userMessage: QUERY, now: NOW, includeHeader: true, selectorVersion: 'v2'
});
assert.equal(retrieval.getSelectorVersion('control-role'), 'v1',
  'selector version is not read from per-turn request options');
assert.deepEqual(requestCannotEnableV2.selectedIds,
  retrieval.retrieve('control-role', { userMessage: QUERY, now: NOW, includeHeader: true }).selectedIds);

const enabled = retrieval.setSelectorVersion('v2', ['canary-role']);
assert.deepEqual(enabled, { ok: true, selectorVersion: 'v2', scopeCount: 1 });
assert.equal(retrieval.getSelectorVersion('canary-role'), 'v2');
assert.equal(retrieval.getSelectorVersion('control-role'), 'v1');
const canaryV2 = retrieval.retrieve('canary-role', {
  userMessage: QUERY, now: NOW, includeHeader: true
});
assert.ok(canaryV2.ok);
assert.equal(canaryV2.selectedIds.includes('private-hidden'), false,
  'the actual V2 switch retains the V1 ACL-first visibility gate');
assert.equal(retrieval.getSelectorShadowMetrics().calls, 0,
  'explicit V2 selection does not run the V1-authoritative Shadow branch too');

/* Desktop authoritative Recall calls retrieve(); Mobile's Home Node runtime
 * path calls buildRuntimeContext() on the same retrieval instance. V2 aligns
 * the core header budget/render path for both. */
const mobileV2 = retrieval.buildRuntimeContext({
  characterId: 'canary-role', userMessage: QUERY, now: NOW,
  currentTime: 'fixture time', relationship: '', userProfile: null
});
assert.deepEqual(mobileV2.selectedIds, canaryV2.selectedIds);
assert.equal(mobileV2.memoryBlock, canaryV2.text,
  'Desktop retrieval and Mobile runtime context use the same V2 selection and block');

const rolledBack = retrieval.setSelectorVersion('v1', ['canary-role']);
assert.deepEqual(rolledBack, { ok: true, selectorVersion: 'v1', scopeCount: 1 });
assert.equal(retrieval.getSelectorVersion('canary-role'), 'v1');
const canaryAfterRollback = retrieval.retrieve('canary-role', {
  userMessage: QUERY, now: NOW, includeHeader: true
});
assert.deepEqual(canaryAfterRollback, canaryStartV1,
  'scoped rollback restores the exact V1 response');

const allV2 = retrieval.setSelectorVersion('v2');
assert.deepEqual(allV2, { ok: true, selectorVersion: 'v2', scope: 'all' });
assert.equal(retrieval.getSelectorVersion('control-role'), 'v2');
const allV1 = retrieval.setSelectorVersion('v1');
assert.deepEqual(allV1, { ok: true, selectorVersion: 'v1', scope: 'all' });
assert.equal(retrieval.getSelectorVersion('canary-role'), 'v1');
assert.equal(retrieval.getSelectorVersion('control-role'), 'v1');
assert.equal(retrieval.setSelectorVersion('v3').ok, false);
assert.equal(retrieval.setSelectorVersion('v2', []).ok, false);
assert.equal(storeStats.writes, 0, 'selector changes and retrievals do not write activation');

const homeNodeServiceSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node-service.js'), 'utf8');
const mobileGatewaySource = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node', 'mobile-gateway.js'), 'utf8');
const runtimeRecallSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node', 'runtime-recall.js'), 'utf8');
assert.match(homeNodeServiceSource,
  /const runtimeRecall = createRuntimeRecall\(\{\s*memoryRetrieval: memory\.memoryRetrieval/,
  'Desktop authoritative Recall receives the canonical retrieval instance');
assert.match(homeNodeServiceSource,
  /runtimeRecall:\s*runtimeRecall,[\s\S]{0,120}memoryRetrieval:\s*memory\.memoryRetrieval/,
  'Mobile gateway receives the same retrieval instance');
assert.match(runtimeRecallSource, /memoryRetrieval\.retrieve\(characterId/);
assert.match(mobileGatewaySource, /memoryRetrieval\.buildRuntimeContext\(/);

/* The orchestrator's actual V2 branch is Node-only and version-gated. */
let v1Calls = 0, v2Calls = 0;
const spyCore = Object.assign({}, CORE, {
  buildMemoryContext: function (rows, options) {
    v1Calls += 1;
    return CORE.buildMemoryContext(rows, options);
  },
  buildMemoryContextV2: function (rows, options) {
    v2Calls += 1;
    return CORE.buildMemoryContextV2(rows, options);
  }
});
const spyOrchestrator = ORCHESTRATOR.createOrchestrator({ core: spyCore });
const turnOptions = {
  apiId: 'canary-role', now: NOW, userMessage: QUERY,
  isGroup: false, groupMemEnabled: false, maxChars: 4000, contentLen: 700,
  includeHeader: true, allowExploration: false, random: () => 0.42,
  turn: { message: QUERY, isFirstTurn: false }
};
const outV1 = spyOrchestrator.recall(records, turnOptions);
assert.equal(outV1.meta.selectorVersion, undefined);
const outV2 = spyOrchestrator.recall(records, Object.assign({}, turnOptions, { selectorVersion: 'v2' }));
assert.equal(outV2.meta.selectorVersion, 'memory-recall-v2');
assert.equal(v1Calls, 1);
assert.equal(v2Calls, 1);

console.log('MEMORY V2 SELECTOR SWITCH · default V1, scoped canary, rollback, shared Home Node path; mechanics only');

if (process.argv.includes('--bench')) {
  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  function makeBenchRecords(count) {
    return Array.from({ length: count }, (_, index) => record('bench-' + index, {
      title: 'harbor inspection reference ' + index,
      summary: 'harbor inspection summary ' + index,
      oneLine: 'harbor inspection note ' + index,
      content: ('harbor inspection detail ' + index + '. ').repeat(5),
      created: NOW - ((index % 900) + 1) * DAY,
      importance: (index % 10) + 1,
      arousal: (index % 10) / 10,
      activationCount: index % 18,
      lastActivated: NOW - (index % 24) * HOUR
    }));
  }
  function makeBenchRetrieval(rows, version) {
    const benchStore = {
      listRecords: () => ({ ok: true, records: rows, count: rows.length, revision: 1 }),
      getMemorySettings: () => ({ ok: true, settings: { budget: 4000, contentLen: 700 } }),
      recordActivation: () => ({ ok: true, updated: 0, revisionTouched: false })
    };
    return createMemoryRetrieval({
      store: benchStore, clock: () => NOW, random: () => 0.42,
      selectorVersion: version, selectorShadow: false, logger: () => {}
    });
  }
  function runBatch(instance, count) {
    const started = process.hrtime.bigint();
    for (let index = 0; index < count; index += 1) {
      instance.retrieve('bench-role', { userMessage: QUERY, now: NOW + index, includeHeader: true });
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
  }
  for (const candidateCount of [30, 180, 500, 1000]) {
    const rows = makeBenchRecords(candidateCount);
    const v1 = makeBenchRetrieval(rows, 'v1');
    const v2 = makeBenchRetrieval(rows, 'v2');
    const v1Samples = [], v2Samples = [];
    for (let sample = 0; sample < 5; sample += 1) {
      runBatch(v1, 4); runBatch(v2, 4);
      const v1First = sample % 2 === 0;
      const first = v1First ? runBatch(v1, 40) : runBatch(v2, 40);
      const second = v1First ? runBatch(v2, 40) : runBatch(v1, 40);
      if (v1First) { v1Samples.push(first); v2Samples.push(second); }
      else { v2Samples.push(first); v1Samples.push(second); }
    }
    const v1Median = median(v1Samples), v2Median = median(v2Samples);
    console.log('PERF_SELECTOR_FIXTURE candidates=' + candidateCount + ' samples=5 recalls_per_sample=40');
    console.log('PERF_SELECTOR_V1 median_ms=' + v1Median.toFixed(2)
      + ' per_recall_ms=' + (v1Median / 40).toFixed(3));
    console.log('PERF_SELECTOR_V2 median_ms=' + v2Median.toFixed(2)
      + ' per_recall_ms=' + (v2Median / 40).toFixed(3)
      + ' overhead_percent=' + (((v2Median / v1Median) - 1) * 100).toFixed(1));
  }
}
