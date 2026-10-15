'use strict';

/* Memory v2 Phase B/C.1 · isolated Home Node Recall shadow and salience curves.
 * Exercises the real wrapper/orchestrator/core path with a fake Memory store;
 * no Provider, canonical write, user data, or body-bearing telemetry. */
const assert = require('node:assert/strict');
const CORE = require('../assets/js/memory-retrieval-core.js');
const ORCHESTRATOR = require('../assets/js/memory-recall/memory-recall-orchestrator.js');
const createMemoryRetrieval = require('../services/home-node/memory-retrieval.js');

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 9, 13, 4, 0, 0);
const ROLE = 'shadow-fixture-role';
const QUERY = 'Do you remember the harbor inspection correction?';
const FIXTURE_BODY_MARKER = 'phase-b-fixture-only-body-marker';

function makeMemory(id, spec) {
  const s = spec || {};
  return Object.assign({
    id: id,
    title: 'harbor inspection note ' + id,
    summary: 'harbor inspection record ' + id,
    oneLine: 'harbor inspection memory ' + id,
    content: 'harbor inspection record text ' + id + ' ' + FIXTURE_BODY_MARKER,
    created: NOW - 20 * DAY,
    source: 'user', kind: 'episodic', domain: 'fixture', tags: ['harbor', 'inspection'],
    visibility: 'public', visibleTo: [], excludeFrom: [], pinned: false,
    importance: 5, arousal: 0.3, valence: 0.5, resolved: false,
    activationCount: 0, lastActivated: NOW - 20 * DAY
  }, s);
}

function makeRows(now) {
  return [
    makeMemory('old-distress', {
      title: 'harbor inspection concern', summary: 'the harbor inspection was unsafe',
      oneLine: 'I believed the harbor inspection had failed',
      content: 'Detailed earlier harbor inspection concern. ' + FIXTURE_BODY_MARKER,
      created: now - 820 * DAY, lastActivated: now - HOUR,
      importance: 9, arousal: 0.95, valence: 0.1, activationCount: 12
    }),
    makeMemory('new-correction', {
      title: 'harbor inspection correction', summary: 'the harbor inspection passed',
      oneLine: 'The official report corrected the earlier harbor inspection claim',
      content: 'New report: the inspection passed; the earlier conclusion was incorrect. ' + FIXTURE_BODY_MARKER,
      created: now - DAY, lastActivated: now - DAY,
      importance: 7, arousal: 0.2, valence: 0.5, activationCount: 0
    }),
    makeMemory('resolved-event', {
      title: 'resolved harbor inspection event', summary: 'harbor inspection follow-up resolved',
      oneLine: 'The harbor inspection follow-up was resolved',
      content: 'Resolved details from the older harbor inspection follow-up. ' + FIXTURE_BODY_MARKER,
      created: now - 400 * DAY, lastActivated: now - 400 * DAY,
      importance: 6, arousal: 0.75, valence: 0.2, resolved: true, activationCount: 1
    }),
    makeMemory('old-important', {
      title: 'harbor inspection historical context', summary: 'important harbor inspection history',
      oneLine: 'Long-term harbor inspection context',
      content: 'Historical harbor inspection context. ' + FIXTURE_BODY_MARKER,
      created: now - 600 * DAY, lastActivated: now - 300 * DAY,
      importance: 9, arousal: 0.3, valence: 0.5, activationCount: 0
    }),
    ...Array.from({ length: 6 }, (_, i) => makeMemory('support-' + i, {
      title: 'harbor inspection supporting detail ' + i,
      summary: 'supporting harbor inspection report ' + i,
      oneLine: 'Supporting harbor inspection fact ' + i,
      content: 'Supporting harbor inspection details ' + i + '. ' + FIXTURE_BODY_MARKER,
      created: now - (10 + i * 15) * DAY,
      importance: 3 + (i % 3), activationCount: i % 2
    }))
  ];
}

function makeStore(records, settings) {
  const stats = { reads: 0, settingsReads: 0, activationWrites: 0 };
  return {
    stats: stats,
    listRecords: function () {
      stats.reads += 1;
      return { ok: true, records: records, count: records.length, revision: 1 };
    },
    getMemorySettings: function () {
      stats.settingsReads += 1;
      return { ok: true, settings: settings || { budget: 760, contentLen: 180 } };
    },
    recordActivation: function () {
      stats.activationWrites += 1;
      return { ok: true, updated: 0, revisionTouched: false };
    }
  };
}

function createRetrieval(records, shadow, randomTracker) {
  const store = makeStore(records, { budget: 760, contentLen: 180 });
  const retrieval = createMemoryRetrieval({
    store: store,
    clock: function () { return NOW; },
    random: function () {
      if (randomTracker) randomTracker.calls += 1;
      return 0.37;
    },
    selectorShadow: shadow === true,
    logger: function () { throw new Error('shadow must not log content or metrics'); }
  });
  return { store: store, retrieval: retrieval };
}

function resultProjection(result) {
  return {
    ok: result.ok,
    text: result.text,
    count: result.count,
    chars: result.chars,
    selectedIds: result.selectedIds,
    reinforcementIds: result.reinforcementIds,
    activationPolicy: result.activationPolicy,
    reason: result.reason
  };
}

const noShadowRows = makeRows(NOW);
const shadowRows = makeRows(NOW);
const beforeRecords = JSON.stringify(shadowRows);
const noShadowRandom = { calls: 0 };
const shadowRandom = { calls: 0 };
const noShadow = createRetrieval(noShadowRows, false, noShadowRandom);
const shadow = createRetrieval(shadowRows, true, shadowRandom);
const noShadowResult = noShadow.retrieval.retrieve(ROLE, {
  userMessage: QUERY, now: NOW, includeHeader: true, withTrace: true
});
const shadowResult = shadow.retrieval.retrieve(ROLE, {
  userMessage: QUERY, now: NOW, includeHeader: true, withTrace: true
});

assert.deepEqual(resultProjection(shadowResult), resultProjection(noShadowResult),
  'V1 remains byte-for-byte the selected Home Node result when shadow is enabled');
assert.deepEqual(shadowResult, noShadowResult,
  'the complete Home Node retrieval response shape and diagnostics remain unchanged');
assert.equal(noShadowRandom.calls, shadowRandom.calls,
  'the V1 random stream is consumed the same number of times');
assert.equal(shadowRandom.calls, 1, 'fixture exercises and replays the one production exploration draw');
assert.equal(noShadow.retrieval.getSelectorShadowMetrics().calls, 0,
  'the ordinary wrapper does not run shadow unless the Home Node composition enables it');
assert.equal(noShadow.store.stats.activationWrites, 0);
assert.equal(shadow.store.stats.activationWrites, 0,
  'shadow retrieval does not activate or write canonical Memory');
assert.equal(shadow.store.stats.reads, 1, 'the shadow reuses the V1 candidate read');
assert.equal(shadow.store.stats.settingsReads, 1, 'the shadow reuses the V1 budget read');
assert.equal(Object.prototype.hasOwnProperty.call(shadowResult, 'selectorShadow'), false,
  'per-turn shadow metrics are not added to the Recall result');
assert.equal(Object.prototype.hasOwnProperty.call(shadowResult.diagnostics || {}, 'selectorShadow'), false,
  'shadow metrics are not added to bounded Recall diagnostics');
assert.equal(JSON.stringify(shadowRows), beforeRecords, 'both selectors leave canonical candidate rows unchanged');

const firstMetrics = shadow.retrieval.getSelectorShadowMetrics();
assert.equal(firstMetrics.enabled, true);
assert.equal(firstMetrics.calls, 1, 'the real Home Node wrapper invoked one shadow comparison');
assert.ok(Number.isFinite(firstMetrics.candidateCount), 'aggregate candidate count is numeric');
assert.ok(firstMetrics.candidateCount > 0, 'the fixture entered the selector after the shared gate');
assert.equal(firstMetrics.randomReplayMisses, 0, 'V2 consumed only the V1 exploration draw or no draw');
const safeMetricsText = JSON.stringify(firstMetrics);
assert.equal(safeMetricsText.includes(FIXTURE_BODY_MARKER), false, 'metrics do not retain Memory body text');
assert.equal(safeMetricsText.includes(QUERY), false, 'metrics do not retain query text');
assert.equal(safeMetricsText.includes('old-distress'), false, 'metrics do not retain Memory ids');

/* A spy around the same orchestrator proves that the shadow sees the exact
 * gated array and the same query/time/cooldown context as V1. */
const seen = [];
const spyCore = Object.assign({}, CORE, {
  buildMemoryContext: function (records, options) {
    seen.push({ selector: 'v1', records: records, options: options });
    return CORE.buildMemoryContext(records, options);
  },
  buildMemoryContextV2: function (records, options) {
    seen.push({ selector: 'v2', records: records, options: options });
    return CORE.buildMemoryContextV2(records, options);
  }
});
const spyOrchestrator = ORCHESTRATOR.createOrchestrator({ core: spyCore });
const spyRows = makeRows(NOW);
const spyRandom = { calls: 0 };
const spyOut = spyOrchestrator.recall(spyRows, {
  apiId: ROLE, now: NOW, random: function () { spyRandom.calls += 1; return 0.37; },
  isGroup: false, groupMemEnabled: false, maxChars: 760, contentLen: 180,
  includeHeader: true, selectorShadow: true,
  turn: { message: QUERY, isFirstTurn: false }
});
assert.equal(seen.length, 2, 'V1 and V2 each ran once');
assert.equal(seen[0].selector, 'v1');
assert.equal(seen[1].selector, 'v2');
assert.equal(seen[0].records, seen[1].records, 'both selectors received the same post-gate candidate array');
for (const key of ['apiId', 'now', 'userMessage', 'isGroup', 'groupMemEnabled', 'maxChars', 'contentLen']) {
  assert.equal(seen[0].options[key], seen[1].options[key], 'shared option: ' + key);
}
assert.equal(seen[0].options.cooldownFactorsById, seen[1].options.cooldownFactorsById,
  'both selectors read the same session cooldown factors');
assert.ok(spyRandom.calls <= 1, 'the production random source was called no more than once by V1');
assert.equal(spyOut.meta.selectorShadow.randomReplayMisses, 0);
assert.equal(spyOut.meta.selectorShadow.candidateCount, seen[0].records.length);
assert.equal(JSON.stringify(spyOut.result).includes(FIXTURE_BODY_MARKER), true,
  'only the V1 result carries rendered Memory text');
assert.equal(JSON.stringify(spyOut.meta.selectorShadow).includes(FIXTURE_BODY_MARKER), false,
  'the internal shadow metadata remains body-free');
assert.equal(JSON.stringify(spyOut.meta.selectorShadow).includes('old-distress'), false,
  'the internal shadow metadata remains id-free');
const ordinaryMeta = ORCHESTRATOR.recall(makeRows(NOW), {
  apiId: ROLE, now: NOW, userMessage: QUERY, isGroup: false, groupMemEnabled: false,
  maxChars: 760, contentLen: 180, includeHeader: true, random: () => 0.37,
  turn: { message: QUERY, isFirstTurn: false }
}).meta;
assert.equal(Object.prototype.hasOwnProperty.call(ordinaryMeta, 'selectorShadow'), false,
  'the non-shadow orchestrator meta contract keeps its prior keys');
let browserV2Calls = 0;
const browserGuardCore = Object.assign({}, CORE, {
  buildMemoryContextV2: function (records, options) {
    browserV2Calls += 1;
    return CORE.buildMemoryContextV2(records, options);
  }
});
const browserGuard = ORCHESTRATOR.createOrchestrator({
  core: browserGuardCore, selectorShadowHost: 'browser'
});
const browserGuardOut = browserGuard.recall(makeRows(NOW), {
  apiId: ROLE, now: NOW, userMessage: QUERY, isGroup: false, groupMemEnabled: false,
  maxChars: 760, contentLen: 180, includeHeader: true, random: () => 0.37,
  selectorShadow: true, selectorVersion: 'v2', turn: { message: QUERY, isFirstTurn: false }
});
assert.equal(browserV2Calls, 0, 'the browser-hosted orchestrator cannot start V2 even if given internal flags');
assert.equal(Object.prototype.hasOwnProperty.call(browserGuardOut.meta, 'selectorShadow'), false);

/* Twenty-turn isolated recurrence. Only the test fixture is updated after
 * each result to model the ordinary post-reply V1 activation writer. */
const simV1Rows = makeRows(NOW);
const simShadowRows = makeRows(NOW);
const simV1 = createRetrieval(simV1Rows, false, null);
const simShadow = createRetrieval(simShadowRows, true, null);
for (let turn = 0; turn < 20; turn += 1) {
  const now = NOW + turn * HOUR;
  const v1 = simV1.retrieval.retrieve(ROLE, { userMessage: QUERY, now: now, includeHeader: true });
  const shadowed = simShadow.retrieval.retrieve(ROLE, { userMessage: QUERY, now: now, includeHeader: true });
  assert.deepEqual(shadowed.selectedIds, v1.selectedIds, 'actual result remains V1 at turn ' + turn);
  for (const id of v1.selectedIds) {
    for (const rows of [simV1Rows, simShadowRows]) {
      const row = rows.find(item => item.id === id);
      if (!row) continue;
      row.activationCount += 1;
      row.lastActivated = now;
    }
  }
}
assert.equal(simShadow.store.stats.activationWrites, 0, 'twenty shadow recalls caused zero activation writes');
const simMetrics = simShadow.retrieval.getSelectorShadowMetrics();
assert.equal(simMetrics.calls, 20);
assert.ok(simMetrics.repeatedActivationSelectedV1 > 0, 'repeat activation was observed as aggregate telemetry');
assert.ok(simMetrics.longTermSelectedV2 > 0, 'query relevance retained long-term retrieval');
assert.equal(simMetrics.r4h.factualDetailMismatch, 0, 'shared selected rows preserve factual-detail decay bands');
assert.equal(simMetrics.r4h.emotionalResidueMismatch, 0, 'shared selected rows preserve emotional-residue decay bands');
assert.equal(simMetrics.r4h.narrativeMeaningMismatch, 0, 'shared selected rows preserve narrative decay bands');
assert.ok(simMetrics.r4h.commonSelectedCompared > 0, 'R4-H was compared on overlapping actual selections');
assert.ok(simMetrics.r4h.v1ActivationOnlyResurfaced >= 0);

const weaklyRelevantRecent = makeMemory('weak-activation-only', {
  title: 'harbor', summary: 'archived detail', oneLine: 'old meaning', content: 'harbor',
  created: NOW - 2000 * DAY, lastActivated: NOW - HOUR,
  importance: 5, arousal: 0.9, valence: 0.5, activationCount: 8
});
const weakQuery = 'harbor correction';
const weakKeywords = CORE.extractKeywords(weakQuery);
const weakBoost = CORE.calcRelevance(weaklyRelevantRecent, weakKeywords);
assert.ok(weakBoost > 1 && weakBoost < 2, 'fixture isolates activation resurfacing below strong relevance');
const weakV1Projection = CORE.deriveSemanticForgetting(weaklyRelevantRecent, NOW, weakBoost);
const weakV2Context = CORE.buildMemoryContextV2([weaklyRelevantRecent], {
  apiId: ROLE, now: NOW, userMessage: weakQuery, isGroup: false, groupMemEnabled: false,
  maxChars: 5000, contentLen: 300, includeHeader: false, allowExploration: false,
  includeSemanticForgettingMeta: true
});
const weakV2Projection = weakV2Context.semanticForgettingById[0].projection;
assert.equal(weakV1Projection.resurfaced, true, 'V1 can accessibility-resurface this weakly relevant recent activation');
assert.equal(weakV2Projection.resurfaced, false, 'V2 does not use activation to resurface R4-H accessibility');
assert.equal(weakV1Projection.factualDetail, weakV2Projection.factualDetail);
assert.equal(weakV1Projection.emotionalResidue, weakV2Projection.emotionalResidue);
assert.equal(weakV1Projection.narrativeMeaning, weakV2Projection.narrativeMeaning);
assert.notEqual(weakV1Projection.accessibility, weakV2Projection.accessibility,
  'only accessibility changes; R4-H detail dimensions remain the same');
const weakFlow = createRetrieval([weaklyRelevantRecent], true, null);
const weakFlowResult = weakFlow.retrieval.retrieve(ROLE, {
  userMessage: weakQuery, now: NOW, includeHeader: true, includeSemanticForgettingMeta: true
});
assert.deepEqual(weakFlowResult.selectedIds, ['weak-activation-only'],
  'real Home Node Recall still retrieves a weakly relevant memory on demand');
assert.equal(weakFlow.store.stats.activationWrites, 0);
const weakFlowMetrics = weakFlow.retrieval.getSelectorShadowMetrics();
assert.equal(weakFlowMetrics.r4h.commonSelectedCompared, 1);
assert.equal(weakFlowMetrics.r4h.factualDetailMismatch, 0);
assert.equal(weakFlowMetrics.r4h.emotionalResidueMismatch, 0);
assert.equal(weakFlowMetrics.r4h.narrativeMeaningMismatch, 0);
assert.equal(weakFlowMetrics.r4h.accessibilityMismatch, 1,
  'the real shadow observes the expected V1 activation resurfacing difference');
assert.equal(weakFlowMetrics.r4h.v1ActivationOnlyResurfaced, 1);

/* Candidate V2 behavior scenarios, on the same fixture data/time basis. */
const lateNow = NOW + 365 * DAY;
const correctionRows = [
  makeMemory('old-interpretation', {
    title: 'harbor inspection abandonment', summary: 'harbor inspection abandonment',
    oneLine: 'The harbor team abandoned the inspection',
    content: 'Earlier interpretation of the harbor inspection was that it was abandoned.',
    created: NOW - 2.5 * DAY, lastActivated: lateNow - HOUR,
    importance: 7, arousal: 1, valence: 0.05, activationCount: 19
  }),
  makeMemory('corrected-evidence', {
    title: 'harbor inspection correction', summary: 'harbor inspection was completed',
    oneLine: 'New evidence corrects the prior harbor interpretation',
    content: 'The signed inspection report confirms completion.',
    created: lateNow - DAY, lastActivated: lateNow - DAY,
    importance: 6, arousal: 0.2, valence: 0.5, activationCount: 0
  })
];
const correctionOptions = {
  apiId: ROLE, now: lateNow, userMessage: 'harbor inspection abandonment correction',
  isGroup: false, groupMemEnabled: false, maxChars: 1800, contentLen: 600,
  includeHeader: false, allowExploration: false
};
const correctionV1 = CORE.rankMemoryCandidates(correctionRows, correctionOptions);
const correctionV2 = CORE.rankMemoryCandidatesV2(correctionRows, correctionOptions);
assert.equal(correctionV2[0].id, 'corrected-evidence', 'new corrective evidence outranks repeatedly activated old interpretation in V2');
assert.notEqual(correctionV1[0].id, 'corrected-evidence', 'fixture reproduces the V1 reactivation bias');

const oldRelevant = makeMemory('old-relevant', {
  title: 'harbor inspection long-term record', summary: 'harbor inspection long-term record',
  oneLine: 'A long-term harbor inspection record',
  content: 'The archived harbor inspection evidence remains relevant on direct query.',
  created: NOW - 900 * DAY, lastActivated: NOW - 800 * DAY,
  importance: 8, activationCount: 0
});
const oldRanked = CORE.rankMemoryCandidatesV2([oldRelevant], Object.assign({}, correctionOptions, {
  now: lateNow, userMessage: 'harbor inspection long-term record'
}));
assert.equal(oldRanked.length, 1, 'an old relevant memory remains retrievable on demand');
assert.ok(oldRanked[0]._score > 0);

const resolved = makeMemory('resolved-old-event', {
  title: 'resolved harbor inspection', summary: 'resolved harbor inspection details',
  oneLine: 'Resolved harbor inspection follow-up',
  content: 'Historic detailed information about the resolved harbor inspection.',
  created: NOW - 400 * DAY, lastActivated: NOW - 390 * DAY,
  importance: 7, arousal: 0.8, valence: 0.2, resolved: true
});
const resolvedProjection = CORE.deriveSemanticForgetting(resolved, NOW, 1);
assert.equal(resolvedProjection.factualDetail, 'latent', 'resolved-event detail remains faded by R4-H');
assert.equal(resolvedProjection.emotionalResidue, 'faded', 'historical emotional residue follows its separate age band');

/* R4-H presentation remains ordinal, while V2 salience stays smooth through
 * each of its emotional-residue boundaries. Check the same near-tie fixture
 * immediately before / at / after the age threshold. */
const boundaryObservations = [];
for (const [boundaryDays, ordinaryImportance] of [[180, 5.5], [730, 5.3], [1825, 5.1]]) {
  const rows = [
    makeMemory('boundary-strong', {
      title: 'harbor', summary: 'archive', oneLine: 'archive meaning', content: 'archive details',
      created: NOW - boundaryDays * DAY,
      importance: 5, arousal: 1, valence: 0.5, activationCount: 0
    }),
    makeMemory('boundary-ordinary', {
      title: 'harbor', summary: 'archive', oneLine: 'archive meaning', content: 'archive details',
      created: NOW - boundaryDays * DAY,
      importance: ordinaryImportance, arousal: 0.3, valence: 0.5, activationCount: 0
    })
  ];
  const boundaryOptions = {
    apiId: ROLE, userMessage: 'harbor correction report', isGroup: false, groupMemEnabled: false,
    allowExploration: false
  };
  const beforeNow = NOW - 0.001 * DAY;
  const atNow = NOW;
  const afterNow = NOW + 0.001 * DAY;
  const before = CORE.rankMemoryCandidatesV2(rows, Object.assign({}, boundaryOptions, { now: beforeNow }));
  const at = CORE.rankMemoryCandidatesV2(rows, Object.assign({}, boundaryOptions, { now: atNow }));
  const after = CORE.rankMemoryCandidatesV2(rows, Object.assign({}, boundaryOptions, { now: afterNow }));
  const strongBefore = before.find(row => row.id === 'boundary-strong')._score;
  const strongAt = at.find(row => row.id === 'boundary-strong')._score;
  const strongAfter = after.find(row => row.id === 'boundary-strong')._score;
  const projectionBefore = CORE.deriveSemanticForgetting(rows[0], beforeNow, 1.5);
  const projectionAt = CORE.deriveSemanticForgetting(rows[0], atNow, 1.5);
  const projectionAfter = CORE.deriveSemanticForgetting(rows[0], afterNow, 1.5);
  const expectedResidues = boundaryDays === 180
    ? ['accessible', 'accessible', 'faded']
    : (boundaryDays === 730 ? ['faded', 'faded', 'suppressed'] : ['suppressed', 'suppressed', 'latent']);
  assert.deepEqual([
    projectionBefore.emotionalResidue,
    projectionAt.emotionalResidue,
    projectionAfter.emotionalResidue
  ], expectedResidues, boundaryDays + '-day R4-H display band remains discrete');
  assert.equal(at[0].id, before[0].id, boundaryDays + '-day rank is stable up to the threshold');
  assert.equal(after[0].id, at[0].id, boundaryDays + '-day rank is stable through the threshold');
  assert.ok(Math.abs(strongAfter - strongBefore) < 1e-5,
    boundaryDays + '-day score is continuous across the display band transition');
  assert.ok(Math.abs((strongAt - strongBefore) - (strongAfter - strongAt)) < 1e-6,
    boundaryDays + '-day local score slope is stable');
  boundaryObservations.push({
    boundaryDays: boundaryDays,
    strongScoreBefore: strongBefore,
    strongScoreAt: strongAt,
    strongScoreAfter: strongAfter,
    r4hResidues: expectedResidues,
    nearTieRank: at[0].id,
    nearTieRankStable: true
  });
}
const weakBoundaryObservations = [];
for (const [boundaryDays, expectedResidues] of [
  [7, ['accessible', 'accessible', 'faded']],
  [90, ['faded', 'faded', 'suppressed']],
  [365, ['suppressed', 'suppressed', 'latent']]
]) {
  const weakMemory = makeMemory('weak-r4h-boundary', {
    title: 'harbor', summary: 'archive', oneLine: 'archive meaning', content: 'archive details',
    created: NOW - boundaryDays * DAY,
    importance: 5, arousal: 0.3, valence: 0.5, activationCount: 0
  });
  const times = [NOW - 0.001 * DAY, NOW, NOW + 0.001 * DAY];
  const projections = times.map(now => CORE.deriveSemanticForgetting(weakMemory, now, 1.5));
  assert.deepEqual(projections.map(projection => projection.emotionalResidue), expectedResidues,
    boundaryDays + '-day weak-affect R4-H presentation remains ordinal');
  const scores = times.map(now => CORE.getMemoryScoreV2(weakMemory, now, 1.5));
  assert.ok(Math.abs(scores[2] - scores[0]) < 0.001,
    boundaryDays + '-day weak-affect score has no boundary jump');
  assert.ok(Math.abs((scores[1] - scores[0]) - (scores[2] - scores[1])) < 0.0001,
    boundaryDays + '-day weak-affect local slope stays bounded');
  weakBoundaryObservations.push({
    boundaryDays: boundaryDays,
    scores: scores,
    r4hResidues: expectedResidues
  });
}

console.log('MEMORY V2 RECALL SHADOW · Phase C.1 smooth-salience, real wrapper fixture, no Provider or writes');
console.log('SHADOW_METRICS ' + JSON.stringify(firstMetrics));
console.log('TWENTY_TURN_METRICS ' + JSON.stringify(simMetrics));
console.log('WEAK_R4H_METRICS ' + JSON.stringify(weakFlowMetrics));
console.log('R4H_BOUNDARY_SMOOTH ' + JSON.stringify(boundaryObservations));
console.log('R4H_WEAK_BOUNDARY_SMOOTH ' + JSON.stringify(weakBoundaryObservations));

if (process.argv.includes('--bench')) {
  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  function runBatch(retrieval, n) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < n; i += 1) {
      retrieval.retrieve(ROLE, { userMessage: QUERY, now: NOW + i, includeHeader: true });
    }
    return Number(process.hrtime.bigint() - start) / 1e6;
  }
  for (const candidateCount of [30, 180, 500, 1000]) {
    const benchRows = Array.from({ length: candidateCount }, (_, i) => makeMemory('bench-' + i, {
      title: 'harbor inspection reference ' + i,
      summary: 'harbor inspection summary ' + i,
      oneLine: 'harbor inspection note ' + i,
      content: ('Harbor inspection candidate detail ' + i + '. ').repeat(5),
      created: NOW - ((i % 900) + 1) * DAY,
      importance: (i % 10) + 1,
      arousal: (i % 10) / 10,
      activationCount: i % 18,
      lastActivated: NOW - (i % 24) * HOUR
    }));
    const offSamples = [], onSamples = [];
    for (let sample = 0; sample < 5; sample += 1) {
      const off = createRetrieval(benchRows, false, null).retrieval;
      const on = createRetrieval(benchRows, true, null).retrieval;
      runBatch(off, 4); runBatch(on, 4); // warm-up
      const firstMode = sample % 2 === 0;
      const a = firstMode ? runBatch(off, 40) : runBatch(on, 40);
      const b = firstMode ? runBatch(on, 40) : runBatch(off, 40);
      if (firstMode) { offSamples.push(a); onSamples.push(b); }
      else { onSamples.push(a); offSamples.push(b); }
    }
    const offMedian = median(offSamples), onMedian = median(onSamples);
    console.log('PERF_FIXTURE candidates=' + candidateCount + ' samples=5 recalls_per_sample=40');
    console.log('PERF_V1_ONLY median_ms=' + offMedian.toFixed(2)
      + ' per_recall_ms=' + (offMedian / 40).toFixed(3));
    console.log('PERF_SHADOW median_ms=' + onMedian.toFixed(2)
      + ' per_recall_ms=' + (onMedian / 40).toFixed(3)
      + ' overhead_percent=' + (((onMedian / offMedian) - 1) * 100).toFixed(1));
  }
}
