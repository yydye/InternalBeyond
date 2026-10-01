'use strict';
/* Internal Beyond · P21-R2-C · Recall Trace（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_trace.js

   被测：assets/js/memory-recall/recall-trace.js（纯函数，零日志出口）

   本文件的重心是**隐私**：trace 必须能解释"为什么这轮注入了什么"，
   同时**不能**把记忆正文、标题、凭据或隐藏记录带出去。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'assets/js/memory-recall/recall-trace.js';
const T = require(path.join(ROOT, MODULE_REL));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
/* P21-R2-C.1：truthfulness 测试需要一个**可信的** relBoost 参照 ——
   它就是唯一 lexical 实现 core.calcRelevance（不复制公式）。 */
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'))
/* P21-R2-D：seat 词表由 seat-planner 定义（唯一来源，不在测试里复制字面量）。 */
const SP = require(path.join(ROOT, 'assets/js/memory-recall/seat-planner.js'));

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const NOW = 1750000000000;
const DAY = 86400000;

/* ── secret sentinels：任何一条出现在 trace 里都算泄漏 ────────────────── */
const SECRETS = {
  content: 'SENTINEL_CONTENT_9f3a',
  title: 'SENTINEL_TITLE_9f3a',
  summary: 'SENTINEL_SUMMARY_9f3a',
  tag: 'SENTINEL_TAG_9f3a',
  author: 'SENTINEL_AUTHOR_9f3a',
  apiKey: 'sk-SENTINELKEY9f3a',
  credential: 'SENTINEL_CREDENTIAL_9f3a',
  systemPrompt: 'SENTINEL_SYSTEMPROMPT_9f3a',
  source: 'SENTINEL_SOURCE_9f3a',
  aliasTarget: 'SENTINEL_ALIAS_TARGET_9f3a',
  rawText: 'SENTINEL_RAWTEXT_9f3a',
  normalized: 'SENTINEL_NORMALIZED_9f3a',
  lexical: 'SENTINEL_LEXICAL_9f3a'
};
function scanForSecrets(serialized) {
  const hits = [];
  Object.keys(SECRETS).forEach(k => {
    if (serialized.indexOf(SECRETS[k]) >= 0) hits.push(k);
  });
  return hits;
}
function mem(over) {
  return Object.assign({
    id: 'm1', title: SECRETS.title, content: SECRETS.content, summary: SECRETS.summary,
    tags: [SECRETS.tag], createdByName: SECRETS.author, source: SECRETS.source,
    importance: 8, arousal: 0.5, resolved: false, activationCount: 0,
    created: NOW - DAY, lastActivated: NOW - DAY, visibility: 'public', domain: '日常'
  }, over || {});
}
const BASE_OPTS = {
  apiId: 'role_a', now: NOW, random: () => 0.42, userMessage: '显卡',
  isGroup: false, groupMemEnabled: false, maxChars: 2000, contentLen: 200
};

/* ══════════════════════════════════════════════════════════════════════
   §1 · shape / version
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · Trace shape');

const trace = ORCH.recall([mem({ id: 'a', title: '显卡', content: '显卡选购' })],
  Object.assign({}, BASE_OPTS, { turn: { message: '显卡' } })).trace;

check('S1.topLevelKeys', (() => {
  const expected = ['version', 'channel', 'earlyExit', 'earlyExitReason', 'query',
    'counts', 'candidates', 'budget', 'reason'].sort();
  return JSON.stringify(Object.keys(trace).sort()) === JSON.stringify(expected);
})(), JSON.stringify(Object.keys(trace).sort()));
check('S1.versionIsNumber', trace.version === T.TRACE_VERSION && typeof trace.version === 'number');
check('S1.queryKeys', (() => {
  const expected = ['lexicalTerms', 'entities', 'temporalHints', 'aliases'].sort();
  return JSON.stringify(Object.keys(trace.query).sort()) === JSON.stringify(expected);
})());
check('S1.countsKeys', (() => {
  const expected = ['input', 'visible', 'gated', 'selected'].sort();
  return JSON.stringify(Object.keys(trace.counts).sort()) === JSON.stringify(expected);
})());
check('S1.budgetKeys', (() => {
  const expected = ['maxChars', 'usedChars'].sort();
  return JSON.stringify(Object.keys(trace.budget).sort()) === JSON.stringify(expected);
})());
check('S1.candidateKeys', (() => {
  const expected = ['memoryId', 'relevanceScore', 'memoryValue', 'cooldownFactor',
    'finalScore', 'seat', 'decision', 'reasons'].sort();
  return trace.candidates.length > 0
    && JSON.stringify(Object.keys(trace.candidates[0]).sort()) === JSON.stringify(expected);
})(), JSON.stringify(trace.candidates[0] && Object.keys(trace.candidates[0]).sort()));

/* ══════════════════════════════════════════════════════════════════════
   §2 · channel / early exit / reason
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · channel / earlyExit / reason');

check('C1.legacyChannel', ORCH.recall([mem({ id: 'a' })], BASE_OPTS).trace.channel === 'legacy');
check('C2.turnChannelPresent', typeof trace.channel === 'string' && trace.channel.length > 0);
check('C3.earlyExitFalseOnNormalTurn', trace.earlyExit === false && trace.earlyExitReason === null);

const ee = ORCH.recall([mem({ id: 'a' })], Object.assign({}, BASE_OPTS, { turn: { message: '嗯' } }));
check('C4.earlyExitTrue', ee.trace.earlyExit === true);
check('C4.earlyExitReasonPresent', typeof ee.trace.earlyExitReason === 'string' && ee.trace.earlyExitReason.length > 0);
check('C4.earlyExitHasNoCandidates', ee.trace.candidates.length === 0);
check('C4.earlyExitCountsZero', ee.trace.counts.visible === 0 && ee.trace.counts.gated === 0 && ee.trace.counts.selected === 0);

/* ══════════════════════════════════════════════════════════════════════
   §3 · counts
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · counts');

const mixed = ORCH.recall([
  mem({ id: 'a', title: '显卡', content: '显卡选购' }),
  mem({ id: 'b', title: '无关', content: '完全无关' }),
  mem({ id: 'c', visibility: 'private', content: 'hidden' })
], Object.assign({}, BASE_OPTS, { turn: { message: '显卡' } }));

check('N1.countsInputCountsAllRecords', mixed.trace.counts.input === 3);
check('N2.countsVisibleExcludesHidden', mixed.trace.counts.visible === 2);
check('N3.countsGatedExcludesZeroRelevance', mixed.trace.counts.gated === 1);
check('N4.countsSelectedMatchesResult', mixed.trace.counts.selected === mixed.result.selected.length);
check('N5.zeroSelectedIsLegal', (() => {
  const r = ORCH.recall([mem({ id: 'a', title: 'zzz', content: 'qqq' })],
    Object.assign({}, BASE_OPTS, { turn: { message: '完全无关' } }));
  return r.trace.counts.selected === 0 && r.result.count === 0 && r.trace.reason === 'gate-rejected';
})());

/* ══════════════════════════════════════════════════════════════════════
   §4 · budget / candidate numerics
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · budget 与 candidate 数值');

check('B1.budgetMaxCharsRecorded', mixed.trace.budget.maxChars === 2000);
check('B1.budgetUsedCharsMatchesResult', mixed.trace.budget.usedChars === mixed.result.chars);
check('B1.unspecifiedMaxCharsReportsNull', (() => {
  const opts = Object.assign({}, BASE_OPTS, { turn: { message: '显卡' } });
  delete opts.maxChars;
  const r = ORCH.recall([mem({ id: 'a', title: '显卡', content: '显卡' })], opts);
  /* 调用方**没有**指定预算时，trace 如实记 null —— 而不是抄 core 内部的
     缺省常量。契约 §13 允许 maxChars 为 null；把 core 的缺省值写进 trace
     会让"这一轮究竟被限到多少"变成一个猜测。 */
  return r.trace.budget.maxChars === null;
})(), 'an unspecified maxChars must be reported as null, not as the core default');
check('B2.candidateNumericScores', mixed.trace.candidates.every(c =>
  typeof c.relevanceScore === 'number' && typeof c.memoryValue === 'number'
  && c.relevanceScore >= 0 && c.relevanceScore <= 1));
/* ── P21-R2-C.1 · finalScore 必须是 null ────────────────────────────────
   测的是**诚实性**，不是"实现了没有"：
     selector 真实分数 = core 的 getMemoryScore × relBoost × fatigue，
     其中 fatigue / relBoost 在本层不可观察；本层的 relevanceScore 只是
     Hard Gate 的归一化信号。因此本层**没有**任何可以标成 finalScore 的真值。
   准确措辞：not truthfully observable at this layer。 */
check('B2.finalScoreIsNull', mixed.trace.candidates.every(c => c.finalScore === null),
  'R2-C: finalScore === null — real selection score is not truthfully observable at this layer');
check('B2.finalScoreKeyStillPresent', mixed.trace.candidates.every(c =>
  Object.prototype.hasOwnProperty.call(c, 'finalScore')),
  'the key must remain (canonical Trace shape froze it) — only its value is null');
check('B2.cooldownFactorIsOne', mixed.trace.candidates.every(c => c.cooldownFactor === 1),
  'R2-C has no cooldown module — the trace must not pretend otherwise');
/* ── ⚠ PHASE TRANSITION（R2-C → R2-D）────────────────────────────────────
   R2-C 断言 `seat === 'legacy'`，因为那时**没有** seat planner，
   任何别的值都是伪造。R2-D 有了 seat planner（pinned / primary），
   因此断言升级为"seat 必须来自 seat-planner 的真实词表"。 */
check('B2.seatIsFromRealVocabulary', mixed.trace.candidates.every(c =>
  c.seat === SP.SEAT_PINNED || c.seat === SP.SEAT_PRIMARY || c.seat === 'legacy'),
  'R2-D: seat must be pinned | primary (real evidence) — or legacy for rejected rows whose seat is unobservable');
check('B2.selectedRowsCarryRealSeat', (() => {
  const sel = mixed.trace.candidates.filter(c => c.decision === 'selected');
  return sel.length > 0 && sel.every(c => c.seat === SP.SEAT_PINNED || c.seat === SP.SEAT_PRIMARY);
})(), 'a selected row must carry a seat we can actually evidence');
check('B2.noFabricatedFutureSeats', mixed.trace.candidates.every(c =>
  ['exploration', 'dormant', 'glossary', 'reminisce', 'new-memory'].indexOf(c.seat) < 0),
  'R2-D must not invent seats for modules that do not exist yet');
check('B2.decisionIsFromFrozenVocabulary', mixed.trace.candidates.every(c =>
  T.DECISIONS.indexOf(c.decision) >= 0));
check('B2.reasonsIsArray', mixed.trace.candidates.every(c => Array.isArray(c.reasons)));

/* ══════════════════════════════════════════════════════════════════════
   §4b · P21-R2-C.1 · finalScore 诚实性（truthfulness）
   ──────────────────────────────────────────────────────────────────────
   旧实现把 `memoryValue × relevanceScore` 填进 finalScore。那个值**不是**
   selector 实际使用的分数，因此是一处"伪精确"：读 trace 的人会据此推断
   排序与幅度，而两件都可能是错的。

   本节做三件事：
     ① 证明旧组合确实与真实 selector 分数不同（可复现的反例）；
     ② 证明在这种情况下 finalScore 仍然是 null；
     ③ 源码 guard：那两个字段不得被组合成任何"看起来像分数"的表达式。
   ══════════════════════════════════════════════════════════════════════ */
section('§4b · finalScore truthfulness（P21-R2-C.1）');

(function truthfulness() {
  /* 构造一个能让 relBoost ≠ 归一化 relevanceScore 的 fixture：
     4 个词元、恰好 2 个命中 ⇒ ratio = 0.5 ⇒ relBoost = 1 + 0.5×1.5 = 1.75
     而归一化 relevanceScore = (1.75 − 1)/1.5 = 0.5。 */
  const target = mem({
    id: 'scorecase',
    title: 'Alpha',
    content: 'alpha beta',
    importance: 8, arousal: 0.5, activationCount: 0,
    created: NOW - DAY, lastActivated: NOW - DAY
  });
  const terms = ['alpha', 'beta', 'zzz', 'qqq'];
  const relBoost = CORE.calcRelevance(target, terms);
  check('T1.fixtureProducesRelBoost175', relBoost === 1.75, 'relBoost=' + relBoost);

  const out = ORCH.recall([target], Object.assign({}, BASE_OPTS, {
    userMessage: 'alpha beta zzz qqq',
    queryOptions: {},
    turn: { message: 'alpha beta zzz qqq' }
  }));
  const row = out.trace.candidates.find(c => c.memoryId === 'scorecase');
  check('T2.candidatePresent', !!row);
  check('T3.relevanceScoreIsNormalized', row && row.relevanceScore === 0.5,
    'relevanceScore (Hard Gate signal) = (relBoost−1)/1.5 = ' + (row && row.relevanceScore));
  check('T4.memoryValueIsNonNull', row && typeof row.memoryValue === 'number' && row.memoryValue > 0,
    'memoryValue=' + (row && row.memoryValue));

  /* ① 旧组合与真实 selector 分数**不同** —— 这就是"伪精确"的可复现证据。 */
  const fabricated = row.memoryValue * row.relevanceScore;
  const legacyRanked = row.memoryValue * relBoost;
  check('T5.fabricatedDiffersFromLegacyRanking', fabricated !== legacyRanked,
    JSON.stringify({ fabricated: fabricated, legacyRanked: legacyRanked }));
  check('T5.fabricatedUnderstatesByFactor', Math.abs(legacyRanked / fabricated - 3.5) < 1e-9,
    'the old combination understated the real ranking by relBoost/relevanceScore = 3.5×');

  /* ② 两个字段都非 null，finalScore 仍必须是 null。 */
  check('T6.finalScoreNullDespiteNonNullInputs',
    row.relevanceScore !== null && row.memoryValue !== null && row.finalScore === null,
    JSON.stringify({ relevanceScore: row.relevanceScore, memoryValue: row.memoryValue, finalScore: row.finalScore }));
  check('T7.finalScoreIsNotTheFabricatedValue', row.finalScore !== fabricated,
    'finalScore must NOT equal memoryValue × relevanceScore');
  check('T7.finalScoreIsNotLegacyRankedValue', row.finalScore !== legacyRanked,
    'nor may it silently contain a locally recomputed legacy ranking');
  check('T8.allCandidatesFinalScoreNull',
    out.trace.candidates.every(c => c.finalScore === null),
    'null applies to every candidate row, selected or rejected');

  /* ③ 源码 guard：不得把 memoryValue 与 relevanceScore 组合成乘积。 */
  const ORCH_SRC = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const TRACE_SRC = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const COMBOS = [
    /memoryValue\s*\*\s*[^;]*relevanceScore/,
    /relevanceScore\s*\*\s*[^;]*memoryValue/,
    /memoryValue\s*\*\s*\(?\s*row\.relevance/,
    /finalScore\s*:\s*[^,;\n]*\*/,
    /* finalScore 除了 null（以及透传一个已归一化的变量）之外，不得被赋成计算式。
       注意不要写成"任何非 null 字符"—— 那会把字面量 1.5 也当成违规。 */
    /finalScore\s*:\s*(?!null)[^,;\n]*[\w.)\]]\s*[+\-*/]\s*[\w.(]/
  ];
  COMBOS.forEach((re, i) => {
    check('T9.noFabricatedCombination.orchestrator#' + i, !re.test(ORCH_SRC),
      'orchestrator must not combine memoryValue with relevanceScore into a score-like value');
    check('T9.noFabricatedCombination.trace#' + i, !re.test(TRACE_SRC),
      'trace must not compute a score-like value either');
  });
  check('T9.orchestratorAssignsFinalScoreNull', /finalScore\s*:\s*null/.test(ORCH_SRC),
    'the orchestrator must assign finalScore: null explicitly (not omit-and-hope)');
  /* 反向控制：guard 必须有能力命中一个真实的自造组合。 */
  check('T10.reverseControl.guardIsLive',
    COMBOS[0].test('const finalScore = row.memoryValue * row.relevanceScore;'),
    'reverse control: the source guard must fire on the old implementation');
})();
check('B2.rejectedCandidateCarriesGateReason', (() => {
  const r = ORCH.recall([mem({ id: 'a', title: 'zzz', content: 'qqq' })],
    Object.assign({}, BASE_OPTS, { turn: { message: '完全无关' } }));
  return r.trace.candidates.every(c => c.decision === 'rejected' && c.reasons.indexOf('gate-rejected') >= 0);
})());
check('B2.selectedCandidateHasNoReasons', (() => {
  const sel = mixed.trace.candidates.filter(c => c.decision === 'selected');
  return sel.length > 0 && sel.every(c => c.reasons.length === 0);
})());

/* ══════════════════════════════════════════════════════════════════════
   §5 · 隐私：secret sentinel 扫描
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · 隐私（secret sentinel 扫描）');

(function privacy() {
  const records = [
    mem({ id: 'visibleHit', title: '显卡', content: '显卡选购' }),
    mem({ id: 'visibleMiss', title: '无关', content: '完全无关' }),
    mem({ id: 'hidden1', visibility: 'private' }),
    mem({ id: 'hidden2', visibility: 'only', visibleTo: ['role_z'] }),
    mem({ id: 'hidden3', visibility: 'except', excludeFrom: ['role_a'] })
  ];
  const out = ORCH.recall(records, Object.assign({}, BASE_OPTS, { turn: { message: '显卡' } }));
  const json = JSON.stringify(out.trace);
  const hits = scanForSecrets(json);
  check('P1.noSecretSentinelInTrace', hits.length === 0, 'leaked: ' + JSON.stringify(hits));
  check('P1.noSystemPromptKeyText', json.indexOf('systemPrompt') < 0);
  check('P1.noApiKeyText', json.indexOf('apiKey') < 0 && json.indexOf('api_key') < 0);

  /* 隐藏记录：连 memoryId 都不许出现。 */
  const hiddenIds = ['hidden1', 'hidden2', 'hidden3'];
  const leakedIds = hiddenIds.filter(id => json.indexOf(id) >= 0);
  check('P2.hiddenMemoryIdsAbsent', leakedIds.length === 0, 'leaked ids: ' + JSON.stringify(leakedIds));
  /* 隐藏记录也不产生 candidate row：candidate 数 = visible 数，不是 input 数。 */
  check('P2.candidatesOnlyForVisibleRecords',
    out.trace.candidates.length === out.trace.counts.visible,
    JSON.stringify({ candidates: out.trace.candidates.length, visible: out.trace.counts.visible }));
  check('P2.hiddenCountExpressedOnlyByDifference',
    out.trace.counts.input - out.trace.counts.visible === 3,
    'hidden records are expressed only as input-minus-visible');
  /* 反向控制：若隐藏记录真的被写进 trace，扫描必须能发现。 */
  const poisoned = json.replace('"input":5', '"input":5,"hidden":"' + SECRETS.content + '"');
  check('P2.reverseControl.sentinelScanIsLive', scanForSecrets(poisoned).length > 0,
    'the sentinel scan must be capable of failing');
})();

/* ══════════════════════════════════════════════════════════════════════
   §6 · query 脱敏
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · query 脱敏');

(function queryRedaction() {
  const aliasTarget = SECRETS.aliasTarget;
  const out = ORCH.recall([mem({ id: 'a', title: '地下室', content: '地下室' })],
    Object.assign({}, BASE_OPTS, {
      userMessage: '你还记得地下室吗',
      queryOptions: { aliases: [{ alias: '地下室', target: aliasTarget }] },
      turn: { message: '你还记得地下室吗' }
    }));
  const json = JSON.stringify(out.trace);

  check('Q1.rawTextAbsent', json.indexOf(SECRETS.rawText) < 0 && !('rawText' in out.trace.query));
  check('Q1.normalizedTextAbsent', !('normalizedText' in out.trace.query));
  check('Q1.lexicalTextAbsent', !('lexicalText' in out.trace.query));
  check('Q2.aliasTargetAbsent', json.indexOf(aliasTarget) < 0,
    'alias target must never be serialized into the trace');
  check('Q2.aliasKeepsOnlySafeFields', out.trace.query.aliases.every(a => {
    const keys = Object.keys(a).sort();
    return JSON.stringify(keys) === JSON.stringify(['alias', 'matched', 'quoted']);
  }), JSON.stringify(out.trace.query.aliases));
  check('Q2.aliasMatchedRecorded', out.trace.query.aliases.some(a => a.alias === '地下室' && a.matched === true));
  check('Q2.aliasTargetFieldGone', out.trace.query.aliases.every(a => !('target' in a)));

  /* entities / temporalHints 只保留 kind/raw/index */
  const rich = ORCH.recall([mem({ id: 'a', title: '显卡', content: '显卡' })],
    Object.assign({}, BASE_OPTS, {
      userMessage: '《地下室》与 RTX 5070 Ti 在 2026年9月28日',
      turn: { message: '《地下室》与 RTX 5070 Ti 在 2026年9月28日' }
    })).trace;
  check('Q3.entitiesOnlySafeFields', rich.query.entities.every(e => {
    const keys = Object.keys(e).sort();
    return JSON.stringify(keys) === JSON.stringify(['index', 'kind', 'raw']);
  }), JSON.stringify(rich.query.entities));
  check('Q3.temporalOnlySafeFields', rich.query.temporalHints.every(h => {
    const keys = Object.keys(h).sort();
    return JSON.stringify(keys) === JSON.stringify(['index', 'kind', 'raw']);
  }), JSON.stringify(rich.query.temporalHints));
  check('Q3.entitiesReachTrace', rich.query.entities.length > 0);
  check('Q3.temporalHintsReachTrace', rich.query.temporalHints.length > 0);
  check('Q3.lexicalTermsReachTrace', Array.isArray(rich.query.lexicalTerms));
})();

/* ══════════════════════════════════════════════════════════════════════
   §7 · 严格白名单（未知 candidate 键必须抛错）
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · candidate 键白名单');

check('A1.unknownKeyThrows', (() => {
  try {
    T.createCandidateEntry({ memoryId: 'x', decision: 'selected', content: SECRETS.content });
    return false;
  } catch (e) { return true; }
})(), 'passing a raw memory field must fail loudly, not be silently dropped');
check('A1.rawRecordThrows', (() => {
  try { T.createCandidateEntry(mem({ id: 'x' }) && Object.assign(mem({ id: 'x' }), { decision: 'selected' })); return false; }
  catch (e) { return true; }
})(), 'passing a whole memory record must throw');
check('A2.invalidDecisionThrows', (() => {
  try { T.createCandidateEntry({ memoryId: 'x', decision: 'maybe' }); return false; }
  catch (e) { return true; }
})());
check('A3.validEntryAccepted', (() => {
  const e = T.createCandidateEntry({
    memoryId: 'x', relevanceScore: 0.5, memoryValue: 3, finalScore: 1.5,
    seat: 'legacy', decision: 'rejected', reasons: ['gate-rejected']
  });
  return e.memoryId === 'x' && e.cooldownFactor === 1;
})());

/* ══════════════════════════════════════════════════════════════════════
   §8 · 确定性与纯函数
   ══════════════════════════════════════════════════════════════════════ */
section('§8 · 确定性与纯函数');

check('D1.repeatedCallsDeepEqual', (() => {
  const records = [mem({ id: 'a', title: '显卡', content: '显卡' })];
  const opts = Object.assign({}, BASE_OPTS, { turn: { message: '显卡' } });
  const first = JSON.stringify(ORCH.recall(records, opts).trace);
  for (let i = 0; i < 100; i++) {
    if (JSON.stringify(ORCH.recall(records, opts).trace) !== first) return false;
  }
  return true;
})());
check('D2.traceDoesNotMutateRecords', (() => {
  const records = [mem({ id: 'a', title: '显卡', content: '显卡' })];
  const snap = JSON.stringify(records);
  ORCH.recall(records, Object.assign({}, BASE_OPTS, { turn: { message: '显卡' } }));
  return JSON.stringify(records) === snap;
})());

const SRC = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
const BARE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
[
  ['console', /\bconsole\s*\./],
  ['window', /\bwindow\s*\./],
  ['document', /\bdocument\s*\./],
  ['Date.now', /Date\s*\.\s*now\s*\(/],
  ['Math.random', /Math\s*\.\s*random\s*\(/],
  ['fetch', /\bfetch\s*\(/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['indexedDB', /\bindexedDB\b/],
  ['setTimeout', /\bsetTimeout\s*\(/],
  ['fs', /\brequire\s*\(\s*'fs'\s*\)/],
  ['globalThis', /\bglobalThis\s*\./]
].forEach(([label, re]) => check('D3.noForbidden.' + label, !re.test(BARE), label + ' must not appear'));
check('D3.noSinkRegistration', !/_sink|registerSink|setSink|__traceSink/.test(BARE),
  'R2-C trace is pure — sinks belong to R2-I Observatory');
check('D4.traceToJSONWorks', typeof T.traceToJSON(trace) === 'string' && T.traceToJSON(trace).length > 2);

/* ══════════════════════════════════════════════════════════════════════
   §E · R2-F1a · exploration 席位的 trace 真实性
   ──────────────────────────────────────────────────────────────────────
   §16 要求：最终**真正进入 prompt** 的探索项必须有
       seat='exploration' 且 reasons 含 'exploration-selected'；
   被 seat cap 裁掉的探索项**不得**声称 seat='exploration'/decision='selected'。
   ══════════════════════════════════════════════════════════════════════ */
section('§E · exploration seat truthfulness');

const F1A_NOW = 1750000000000;
const f1aMem = o => Object.assign({ id: 'm', title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195),
  importance: 5, arousal: 0.3, resolved: false, activationCount: 0, created: F1A_NOW - DAY,
  lastActivated: F1A_NOW - DAY, visibility: 'public', tags: [], domain: '日常', createdBy: 'user' }, o || {});
/* 5 条使 main 只装得下 2 条 ⇒ 第 3 条来自探索窗口（surface cap = 3）。 */
const F1A_RECS = [10, 9, 8, 7, 6].map((imp, i) => f1aMem({ id: 'e' + (i + 1), importance: imp }));
const f1aRun = (r) => ORCH.recall(F1A_RECS, {
  apiId: 'role_a', now: F1A_NOW, isGroup: false, groupMemEnabled: false,
  maxChars: 700, contentLen: 200, userMessage: 'AAAA', random: () => r,
  turn: { message: 'AAAA', conversationSignalAvailable: true, isFirstTurn: false, conversationId: 'dm:role_a' }
});

const f1aOut = f1aRun(0.999);
const f1aSel = f1aOut.trace.candidates.filter(c => c.decision === 'selected');
const explRows = f1aSel.filter(c => c.seat === SP.SEAT_EXPLORATION);
check('E1.seatVocabularyHasExploration', SP.SEAT_EXPLORATION === 'exploration');
check('E2.explorationItemIsLabelled', explRows.length === 1,
  'exactly one injected row must carry seat=exploration: ' + JSON.stringify(f1aSel.map(c => c.memoryId + ':' + c.seat)));
check('E3.explorationReasonPresent', explRows.length === 1
  && explRows[0].reasons.indexOf('exploration-selected') >= 0,
  JSON.stringify(explRows.map(c => c.reasons)));
check('E4.explorationRowIsLastInCanonicalOrder',
  explRows.length === 1 && f1aSel[f1aSel.length - 1].memoryId === explRows[0].memoryId,
  'the exploration item is appended after the main selection (core order preserved)');
check('E5.mainRowsAreNotLabelledExploration',
  f1aSel.filter(c => c.seat === SP.SEAT_PRIMARY).every(c => c.reasons.indexOf('exploration-selected') < 0),
  JSON.stringify(f1aSel.map(c => ({ id: c.memoryId, seat: c.seat, r: c.reasons }))));

/* 反向控制：被 seat cap 裁掉的探索项必须是 rejected，且**不得**带 exploration 席位。 */
check('E6.cappedExplorationIsNotClaimedAsSelected', (() => {
  const recs = [10, 9, 8, 7, 6, 5, 4].map((imp, i) => f1aMem({ id: 'c' + (i + 1), importance: imp }));
  const o = ORCH.recall(recs, {
    apiId: 'role_a', now: F1A_NOW, isGroup: false, groupMemEnabled: false,
    maxChars: 700, contentLen: 200, userMessage: 'AAAA', random: () => 0.999,
    turn: { message: 'AAAA', conversationSignalAvailable: true, isFirstTurn: false, conversationId: 'dm:role_a' }
  });
  const rejected = o.trace.candidates.filter(c => c.decision === 'rejected');
  return rejected.every(c => c.seat !== SP.SEAT_EXPLORATION
    && c.reasons.indexOf('exploration-selected') < 0)
    && o.trace.candidates.every(c => !(c.seat === SP.SEAT_EXPLORATION && c.decision !== 'selected'));
})(), 'trace must describe final injection truth, not intent');

check('E7.seatTotalsRespected', f1aSel.length <= 3,
  'surface cap is 3, got ' + f1aSel.length);
check('E8.explorationRespectsBudget', f1aOut.result.chars <= 700,
  'chars=' + f1aOut.result.chars);
check('E9.noCooldownIntroduced', f1aOut.trace.candidates.every(c => c.cooldownFactor === 1),
  'R2-F1a must not introduce cooldown');
check('E10.candidateKeysStillFrozen', f1aOut.trace.candidates.every(c =>
  JSON.stringify(Object.keys(c).sort()) === JSON.stringify(T.CANDIDATE_KEYS.slice().sort())));

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL TRACE FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL TRACE PASSED · ' + passed + ' assertions green');
}
