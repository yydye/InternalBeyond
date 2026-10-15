'use strict';

/* Memory Recall Selector V2 · isolated V1/V2 golden and repeated-activation
 * checks. Pure shared-core fixtures only: no store, provider, Vault, or runtime
 * selector wiring. Run: node tests/test_memory_v2_recall_selector.js */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const CORE = require('../assets/js/memory-retrieval-core.js');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'memory-v2-recall-selector', 'golden.json');
const GOLDEN = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = GOLDEN.now;
let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('PASS ' + name);
  } else {
    failed += 1;
    console.error('FAIL ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail)));
  }
}

function materialize(spec) {
  const row = Object.assign({
    source: 'user', kind: 'episodic', domain: '日常', tags: [],
    visibility: 'public', visibleTo: [], excludeFrom: [], pinned: false,
    importance: 5, arousal: 0.3, valence: 0.5, resolved: false,
    activationCount: 0
  }, spec);
  row.created = NOW - Number(spec.createdAgeDays || 0) * DAY;
  row.lastActivated = NOW - Number(spec.lastActivatedAgeHours || 0) * HOUR;
  delete row.createdAgeDays;
  delete row.lastActivatedAgeHours;
  return row;
}

function options(userMessage, now) {
  return {
    apiId: 'fixture-role', now: now == null ? NOW : now,
    userMessage: userMessage || '', isGroup: false, groupMemEnabled: false,
    maxChars: 4000, contentLen: 1200, includeHeader: false,
    allowExploration: false, random: function () { return 0.5; }
  };
}

function orderOf(rows) { return rows.map(function (row) { return row.id; }); }
function scoresOf(rows) {
  const out = Object.create(null);
  rows.forEach(function (row) { out[row.id] = Number(row._score.toFixed(2)); });
  return out;
}
function exactScores(actual, expected) {
  return Object.keys(expected).every(function (id) { return actual[id] === expected[id]; });
}

GOLDEN.cases.forEach(function (fixture) {
  const rows = fixture.records.map(materialize);
  const before = JSON.stringify(rows);
  const opts = options(fixture.userMessage);
  const v1 = CORE.rankMemoryCandidates(rows, opts);
  const v2 = CORE.rankMemoryCandidatesV2(rows, opts);
  check(fixture.id + '.v1GoldenOrder',
    JSON.stringify(orderOf(v1)) === JSON.stringify(fixture.expected.v1Order), orderOf(v1));
  check(fixture.id + '.v1GoldenScores',
    exactScores(scoresOf(v1), fixture.expected.v1Scores), scoresOf(v1));
  check(fixture.id + '.v2GoldenOrder',
    JSON.stringify(orderOf(v2)) === JSON.stringify(fixture.expected.v2Order), orderOf(v2));
  check(fixture.id + '.v2GoldenScores',
    exactScores(scoresOf(v2), fixture.expected.v2Scores), scoresOf(v2));
  check(fixture.id + '.selectorsDoNotMutateMemoryRows', JSON.stringify(rows) === before);
  if (fixture.expected.v2Forgetting) {
    const projection = v2[0]._semanticForgetting;
    check(fixture.id + '.v2ForgettingGolden',
      Object.keys(fixture.expected.v2Forgetting).every(function (key) {
        return projection[key] === fixture.expected.v2Forgetting[key];
      }), projection);
  }
});

/* Natural-language questions add English function words that are useful to a
 * person but dilute the lexical relevance ratio. V2 removes only those words
 * after using the shared core tokenizer; V1 keeps its frozen legacy terms. */
const naturalOld = materialize({
  id: 'natural-old-emotional', title: 'hospital abandonment: painful old event',
  summary: 'painful old event summary', oneLine: 'painful old event meaning',
  content: 'painful old event details', importance: 7, arousal: 1, valence: 0.05,
  createdAgeDays: 2.5, lastActivatedAgeHours: 3, activationCount: 19
});
const naturalCorrection = materialize({
  id: 'natural-new-correction', title: 'hospital abandonment report correction',
  summary: 'hospital abandonment report correction summary',
  oneLine: 'hospital abandonment report correction',
  content: 'hospital abandonment report correction evidence',
  importance: 6, arousal: 0.3, valence: 0.5,
  createdAgeDays: 0, lastActivatedAgeHours: 0, activationCount: 0
});
const naturalQuestion = 'What does the hospital abandonment correction report say?';
const naturalKeywordsV2 = CORE.extractKeywordsV2(naturalQuestion);
check('V2.naturalQuestionFiltersFunctionWordsWithSharedTokenizer',
  JSON.stringify(naturalKeywordsV2) === JSON.stringify(['hospital', 'abandonment', 'correction', 'report', 'say']),
  naturalKeywordsV2);
const naturalRows = [naturalOld, naturalCorrection];
const naturalV1 = CORE.rankMemoryCandidates(naturalRows, options(naturalQuestion));
const naturalV2 = CORE.rankMemoryCandidatesV2(naturalRows, options(naturalQuestion));
check('V1.naturalQuestionKeepsLegacyOrder', naturalV1[0].id === naturalOld.id, orderOf(naturalV1));
check('V2.naturalQuestionPrioritizesFullyMatchedCorrection', naturalV2[0].id === naturalCorrection.id,
  naturalV2.map(function (row) { return { id: row.id, score: Number(row._score.toFixed(3)) }; }));
const negationKeywordsV2 = CORE.extractKeywordsV2('What did we not correct about the old report?');
check('V2.naturalQueryRetainsNegationAndHistoricalTerms',
  negationKeywordsV2.indexOf('not') >= 0 && negationKeywordsV2.indexOf('old') >= 0
    && negationKeywordsV2.indexOf('report') >= 0,
  negationKeywordsV2);
const historyRecord = materialize({
  id: 'natural-old-history', title: 'older harbor plan',
  summary: 'the older harbor plan', oneLine: 'older harbor plan',
  content: 'older harbor plan details', importance: 8, arousal: 0.3,
  createdAgeDays: 365, lastActivatedAgeHours: 365 * 24, activationCount: 0
});
const historyKeywordsV2 = CORE.extractKeywordsV2('What did we say about the older harbor plan?');
check('V2.stopwordFilteringKeepsOnDemandHistoryTerms',
  ['older', 'harbor', 'plan'].every(function (term) { return historyKeywordsV2.indexOf(term) >= 0; })
    && CORE.rankMemoryCandidatesV2([historyRecord], options('What did we say about the older harbor plan?'))[0].id === historyRecord.id,
  historyKeywordsV2);

/* Lifetime activation count and the most recent activation timestamp remain
 * visible telemetry, but cannot alter V2 score or its H ranking projection. */
const dormant = materialize({
  id: 'telemetry-neutral', title: 'old bridge', summary: 'old bridge summary',
  oneLine: 'old bridge', content: 'old bridge detailed memory',
  importance: 6, arousal: 0.7, createdAgeDays: 60,
  lastActivatedAgeHours: 60 * 24, activationCount: 0
});
const frequentlyActivated = Object.assign({}, dormant, {
  activationCount: 900, lastActivated: NOW - HOUR
});
const v2Dormant = CORE.rankMemoryCandidatesV2([dormant], options('unrelated'))[0];
const v2Hot = CORE.rankMemoryCandidatesV2([frequentlyActivated], options('unrelated'))[0];
check('V2.activationCountAndLastActivatedAreNotScoreInputs',
  v2Dormant._score === v2Hot._score, { dormant: v2Dormant._score, hot: v2Hot._score });
check('V2.activationDoesNotResurfaceR4HRankingBand',
  v2Dormant._semanticForgetting.accessibility === v2Hot._semanticForgetting.accessibility
    && v2Dormant._semanticForgetting.resurfaced === v2Hot._semanticForgetting.resurfaced,
  { dormant: v2Dormant._semanticForgetting, hot: v2Hot._semanticForgetting });
check('V1.activationTelemetryStillChangesLegacyScore',
  CORE.getMemoryScore(frequentlyActivated, NOW) > CORE.getMemoryScore(dormant, NOW));

const zeroEncodedArousal = materialize({
  id: 'zero-encoded-arousal', importance: 5, arousal: 0, valence: 0.5,
  createdAgeDays: 0, lastActivatedAgeHours: 0
});
const defaultEncodedArousal = Object.assign({}, zeroEncodedArousal, {
  id: 'default-encoded-arousal', arousal: 0.3
});
check('V2.zeroHistoricalArousalIsNotReplacedByTheLegacyDefault',
  CORE.getMemoryScoreV2(zeroEncodedArousal, NOW, 1)
    < CORE.getMemoryScoreV2(defaultEncodedArousal, NOW, 1));
check('V1.zeroArousalLegacyBehaviorRemainsUnchanged',
  CORE.getMemoryScore(zeroEncodedArousal, NOW) === CORE.getMemoryScore(defaultEncodedArousal, NOW));

const v2SalienceAges = [0, 7, 14, 76, 90, 104, 165, 180, 195, 335, 365, 395,
  700, 730, 760, 1765, 1825, 1885, 4000];
function v2ScoreCurveIsMonotone(record) {
  let previous = Infinity;
  for (const ageDays of v2SalienceAges) {
    const score = CORE.getMemoryScoreV2(record, NOW + ageDays * DAY, 1);
    if (score > previous + 1e-12 || !Number.isFinite(score) || score < 0) return false;
    previous = score;
  }
  return true;
}
const strongSalienceRecord = materialize({
  id: 'strong-salience-curve', importance: 8, arousal: 1, valence: 0.5,
  createdAgeDays: 0, lastActivatedAgeHours: 0
});
const weakSalienceRecord = materialize({
  id: 'weak-salience-curve', importance: 8, arousal: 0.3, valence: 0.5,
  createdAgeDays: 0, lastActivatedAgeHours: 0
});
check('V2.continuousHistoricalAffectSalienceNeverRisesWithAge',
  v2ScoreCurveIsMonotone(strongSalienceRecord) && v2ScoreCurveIsMonotone(weakSalienceRecord));
check('V2.descriptorIdentifiesSmoothR4HAnchoredSalience',
  CORE.describeMemoryRecallV2().affectSalienceModel
    === 'R4-H-anchored piecewise smoothstep by immutable record age');

const visibleControl = materialize({
  id: 'visible-control', title: 'visible control', content: 'visible control',
  createdAgeDays: 1, lastActivatedAgeHours: 24
});
const hiddenHigh = materialize({
  id: 'hidden-high', title: 'hidden high', content: 'hidden high',
  importance: 10, arousal: 1, pinned: true, visibility: 'private',
  createdAgeDays: 1, lastActivatedAgeHours: 24
});
const v2Acl = CORE.rankMemoryCandidatesV2([hiddenHigh, visibleControl], options(''));
check('V2.visibilityACLRemainsTheFirstGate',
  v2Acl.length === 1 && v2Acl[0].id === 'visible-control', orderOf(v2Acl));

const cooldownA = materialize({
  id: 'cooldown-a', title: 'cooldown a', content: 'cooldown a',
  createdAgeDays: 1, lastActivatedAgeHours: 24
});
const cooldownB = materialize({
  id: 'cooldown-b', title: 'cooldown b', content: 'cooldown b',
  createdAgeDays: 1, lastActivatedAgeHours: 24
});
const cooldowns = Object.create(null);
cooldowns['cooldown-a'] = 0.2;
const v2Cooldown = CORE.rankMemoryCandidatesV2([cooldownA, cooldownB],
  Object.assign(options(''), { cooldownFactorsById: cooldowns }));
check('V2KeepsTheSeparateSessionCooldownFactor',
  v2Cooldown[0].id === 'cooldown-b'
    && v2Cooldown.find(function (row) { return row.id === 'cooldown-a'; })._cooldownFactor === 0.2,
  v2Cooldown.map(function (row) { return { id: row.id, score: row._score, factor: row._cooldownFactor }; }));

/* A high relevance query still resurfaces old memories, while R4-H retains the
 * faded factual-detail state and the renderer continues to redact exact detail. */
const oldDetail = materialize({
  id: 'latent-detail', title: 'bridge incident testimony', summary: '', oneLine: '',
  content: 'RAW_DETAIL_SENTINEL: the exact old sequence and minute-by-minute facts.',
  importance: 8, arousal: 0.1, valence: 0.5,
  createdAgeDays: 900, lastActivatedAgeHours: 1, activationCount: 100
});
const oldRelevant = CORE.rankMemoryCandidatesV2([oldDetail], options('bridge incident testimony'))[0];
const oldRendered = CORE.renderMemoryLine(oldRelevant, 'fixture-role', 400);
check('V2.relevanceCanResurfaceWithoutRestoringFactualDetail',
  oldRelevant._semanticForgetting.accessibility === 'accessible'
    && oldRelevant._semanticForgetting.factualDetail === 'latent'
    && oldRelevant._semanticForgetting.resurfaced === true
    && oldRendered.indexOf('RAW_DETAIL_SENTINEL') < 0,
  { forgetting: oldRelevant._semanticForgetting, rendered: oldRendered });

/* Twenty distinct logical turns exercise the old selected-memory feedback
 * loop. V1 refreshes its score clock; V2 scores the same fixed record age on
 * every turn, regardless of the telemetry write simulated after selection. */
function simulate(selector, intervalMs) {
  const strong = materialize({
    id: 'strong-negative', title: 'bridge event', summary: 'bridge event summary',
    oneLine: 'bridge event meaning', content: 'bridge incident details',
    importance: 7, arousal: 1, valence: 0.05, createdAgeDays: 0,
    lastActivatedAgeHours: 0, activationCount: 0
  });
  const ordinary = materialize({
    id: 'ordinary', title: 'ordinary topic', summary: 'ordinary topic summary',
    oneLine: 'ordinary topic meaning', content: 'ordinary topic details',
    importance: 7, arousal: 0.3, valence: 0.5, createdAgeDays: 0,
    lastActivatedAgeHours: 0, activationCount: 0
  });
  const points = [];
  for (let turn = 0; turn < 20; turn++) {
    const now = NOW + turn * intervalMs;
    const ranked = selector === 'v1'
      ? CORE.rankMemoryCandidates([strong, ordinary], options('', now))
      : CORE.rankMemoryCandidatesV2([strong, ordinary], options('', now));
    if (turn === 0 || turn === 9 || turn === 19) {
      const strongRow = ranked.find(function (row) { return row.id === 'strong-negative'; });
      const ordinaryRow = ranked.find(function (row) { return row.id === 'ordinary'; });
      points.push({
        turn: turn + 1,
        strongScore: Number(strongRow._score.toFixed(2)),
        ordinaryScore: Number(ordinaryRow._score.toFixed(2)),
        top: ranked[0].id
      });
    }
    const selected = ranked[0].id === 'strong-negative' ? strong : ordinary;
    selected.activationCount += 1;
    selected.lastActivated = now;
  }
  return points;
}
const fastV1 = simulate('v1', 3 * HOUR);
const fastV2 = simulate('v2', 3 * HOUR);
check('simulation.v1ShowsRepeatRecallScoreRefresh',
  fastV1[2].strongScore > fastV1[0].strongScore, fastV1);
check('simulation.v2DoesNotRefreshFromActivation',
  fastV2[2].strongScore < fastV2[0].strongScore, fastV2);
check('simulation.v2KeepsSemanticRelevanceAndInitialSalience',
  fastV2[0].top === 'strong-negative' && fastV2[2].top === 'strong-negative', fastV2);

/* V2 is wired only as a Home Node shadow. Browser callers do not select it,
 * and the V1 result remains the sole result returned by the orchestrator. */
const sourceRoot = path.resolve(__dirname, '..');
const productionHostSources = [
  'assets/js/memory.js',
  'services/home-node/memory-retrieval.js'
].map(function (file) { return fs.readFileSync(path.join(sourceRoot, file), 'utf8'); }).join('\n');
const orchestratorSource = fs.readFileSync(path.join(sourceRoot,
  'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8');
check('wiring.browserAndWrapperDoNotCallV2Directly',
  productionHostSources.indexOf('rankMemoryCandidatesV2') < 0
    && productionHostSources.indexOf('buildMemoryContextV2') < 0);
check('wiring.v2CallIsGuardedByShadowFlag',
  /options\.selectorShadow\s*===\s*true[\s\S]{0,160}buildMemoryContextV2/.test(orchestratorSource));
check('wiring.v2ShadowIsNodeOnly',
  /selectorShadowHost:\s*'browser'/.test(orchestratorSource)
    && /selectorShadowHost\s*===\s*'node'/.test(orchestratorSource));
check('wiring.v2ActualSelectionRequiresExplicitNodeVersion',
  /selectorV2Actual\s*=\s*deps\.selectorShadowHost\s*===\s*'node'[\s\S]{0,120}options\.selectorVersion\s*===\s*'v2'/.test(orchestratorSource));
check('wiring.v1RemainsTheDefaultRecallBranch',
  /selectorV2Actual\s*\?\s*core\.buildMemoryContextV2\(gated,\s*coreOpts\)\s*:\s*core\.buildMemoryContext\(gated,\s*coreOpts\)/.test(orchestratorSource)
    && /result:\s*result/.test(orchestratorSource));
check('wiring.productionAssemblyEnablesOnlyShadow',
  /selectorShadow:\s*options\.memorySelectorShadow\s*!==\s*false/.test(
    fs.readFileSync(path.join(sourceRoot, 'services/home-node-service.js'), 'utf8'))
    && /selectorShadow:\s*selectorShadowEnabled/.test(
      fs.readFileSync(path.join(sourceRoot, 'services/home-node/memory-retrieval.js'), 'utf8'))
    && /selectorVersion:\s*options\.memorySelectorVersion/.test(
      fs.readFileSync(path.join(sourceRoot, 'services/home-node-service.js'), 'utf8')));
const testAllSource = fs.readFileSync(path.join(sourceRoot, 'tests', 'test-all.js'), 'utf8');
const testAllLines = testAllSource.split('\n');
let currentTestGroup = null;
const testAllV2Groups = [];
testAllLines.forEach(function (line) {
  const group = /^\s{4}name:\s*'([^']+)'/.exec(line);
  if (group) currentTestGroup = group[1];
  if (/\['test_memory_v2_recall_selector\.js'\]/.test(line)) testAllV2Groups.push(currentTestGroup);
});
check('wiring.v2GoldenRegisteredInStaticTestGroup',
  testAllV2Groups.length === 1 && testAllV2Groups[0] === 'static', testAllV2Groups);
const single = materialize({
  id: 'legacy-default', title: 'legacy', summary: 'legacy summary',
  oneLine: 'legacy', content: 'legacy details', createdAgeDays: 1,
  lastActivatedAgeHours: 24
});
const legacyContext = CORE.buildMemoryContext([single], options(''));
const v2Context = CORE.buildMemoryContextV2([single], options(''));
check('wiring.defaultBuildMemoryContextRemainsV1Shape',
  !Object.prototype.hasOwnProperty.call(legacyContext, 'selectorVersion')
    && JSON.stringify(Object.keys(legacyContext)) === JSON.stringify(['text', 'selected', 'count', 'chars', 'reason']),
  Object.keys(legacyContext));
check('wiring.explicitV2ContextIdentifiesItsVersion',
  v2Context.selectorVersion === 'memory-recall-v2');
check('wiring.describeV2RequiresExplicitV1DefaultOverride',
  CORE.describeMemoryRecallV2().productionWired === true
    && CORE.describeMemoryRecallV2().defaultSelector === 'V1'
    && CORE.describeMemoryRecallV2().productionRequiresExplicitConfig === true);

console.log('\nMEMORY V2 RECALL SELECTOR · ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
