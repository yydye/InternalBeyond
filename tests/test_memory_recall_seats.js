'use strict';
/* Internal Beyond · P21-R2-D/D.1 · Seat Planner（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_seats.js

   被测：assets/js/memory-recall/seat-planner.js（纯函数）

   ── P21-R2-D.1 的裁决（本文件的核心）──────────────────────────────────
     Seat planner 的职责**只是**：
       "对 canonical selector 已经决定的顺序/集合施加 channel seat policy"
     它**不是**：
       "先决定 core 能看见谁"

     旧实现接收 [{record, memoryValue}]、按 memoryValue 降序截断后再交给 core。
     canonical ranking 是 base × relBoost × fatigue，memoryValue 只是 base ——
     因此候选数 > cap 时它会删掉 canonical 本会排得更高的记录，
     等价于在 core 之前偷偷长出了**第二个 selector**。
     §8 用对抗性反例把这件事钉死。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MODULE_REL = 'assets/js/memory-recall/seat-planner.js';
const SP = require(path.join(ROOT, MODULE_REL));
const CP = require(path.join(ROOT, 'assets/js/memory-recall/channel-policy.js'));

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const surfacePolicy = CP.resolveChannelPolicy('surface').policy;
const recallPolicy = CP.resolveChannelPolicy('recall').policy;
/* cap 取自 policy；改名过渡期用 fallback，确保测的是**行为**而不是字段名。 */
const CAP = surfacePolicy.maxTotalSeats != null ? surfacePolicy.maxTotalSeats : surfacePolicy.maxPrimarySeats;

/* selected 条目的真实形状：core.selectWithinBudget 产出 [{id, score, line}]，
   **已经是 canonical 顺序**。 */
const sel = (id, score, line) => ({ id: id, score: score, line: line == null ? ('- ' + id + '\n') : line });
const selN = n => Array.from({ length: n }, (_, i) => sel('m' + i, 100 - i));
const ids = rows => rows.map(r => r.id);

/* ══════════════════════════════════════════════════════════════════════
   §1 · 恒等变换（装得下时对现有语义完全透明）
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · 恒等变换');

const few = [sel('a', 30), sel('b', 20)];
const planFew = SP.applySeats(few, surfacePolicy);
check('S1.underCapReturnsAll', planFew.seats.length === 2 && planFew.dropped.length === 0);
check('S1.underCapNotCapped', planFew.capped === false);
check('S1.preservesOrder', JSON.stringify(ids(planFew.seats)) === JSON.stringify(['a', 'b']),
  'under the cap the planner must be an identity transform — no reordering');
check('S1.preservesPayload', planFew.seats[0].id === 'a' && planFew.seats[0].score === 30
  && planFew.seats[0].line === few[0].line,
  'id / score / line must pass through untouched');

/* ══════════════════════════════════════════════════════════════════════
   §2 · 上限生效（按 canonical 顺序取前缀）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · 通道上限');

const many = selN(12);
const planMany = SP.applySeats(many, surfacePolicy);
check('S4.surfaceCapRespected', planMany.seats.length === CAP,
  JSON.stringify({ got: planMany.seats.length, cap: CAP }));
check('S4.overflowAccounted', planMany.dropped.length === 12 - CAP);
check('S4.cappedFlagSet', planMany.capped === true);
check('S4.capReported', planMany.cap === CAP);
check('S4.capTakesCanonicalPrefix',
  JSON.stringify(ids(planMany.seats)) === JSON.stringify(ids(many).slice(0, CAP)),
  'the kept set must be the canonical PREFIX, not a re-derived top-N');

const planRecall = SP.applySeats(many, recallPolicy);
check('S5.recallCapRespected', planRecall.seats.length === recallPolicy.maxTotalSeats);
check('S5.recallCapIsWider', planRecall.seats.length > planMany.seats.length,
  'recall must admit more than surface — the two policies must actually differ');
check('S7.selectedNeverExceedsPolicy',
  planMany.seats.length <= surfacePolicy.maxTotalSeats
  && planRecall.seats.length <= recallPolicy.maxTotalSeats);

/* ══════════════════════════════════════════════════════════════════════
   §3 · 不重排 / 不重算 / 不重新解释
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · 不重排 / 不重算');

check('S1.capIsOrderPreservingNotValuePreserving', (() => {
  /* 输入顺序 = canonical 顺序。值故意与顺序相反：
     若实现按 score/memoryValue 重排，结果会变成 [e, d, c] 而不是前缀 [a, b, c]。 */
  const input = [sel('a', 1), sel('b', 2), sel('c', 3), sel('d', 9), sel('e', 8)];
  const p = SP.applySeats(input, surfacePolicy);
  return JSON.stringify(ids(p.seats)) === JSON.stringify(['a', 'b', 'c']);
})(), 'the planner must take the canonical prefix even when later entries have higher scores');
check('S2.doesNotRescore', (() => {
  const input = [sel('a', 3), sel('b', 8), sel('c', 1), sel('d', 9)];
  const p = SP.applySeats(input, surfacePolicy);
  const src = {}; input.forEach(r => { src[r.id] = r.score; });
  return p.seats.length > 0 && p.seats.every(s => s.score === src[s.id]);
})());
check('S2.scoreIsNeverRead', (() => {
  /* score 缺失也不影响结果 —— 证明实现不依赖它。 */
  const bare = [{ id: 'x', line: 'L\n' }, { id: 'y', line: 'L\n' }];
  const p = SP.applySeats(bare, surfacePolicy);
  return p.seats.length === 2 && ids(p.seats).join(',') === 'x,y';
})());
check('S3.linesPassThroughVerbatim', (() => {
  const input = [sel('a', 1, '- 原文 A\n'), sel('b', 2, '- 原文 B\n')];
  const p = SP.applySeats(input, surfacePolicy);
  return p.seats[0].line === '- 原文 A\n' && p.seats[1].line === '- 原文 B\n';
})(), 'the planner must not render — it forwards the line core already produced');
check('S3.noRenderFunction', typeof SP.applySeats === 'function'
  && Object.keys(SP).every(k => !/render|format/i.test(k)));
check('S3.moduleHasNoRenderCode', (() => {
  const bare = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return !/renderMemoryLine|【记忆|'- '/.test(bare);
})(), 'rendering stays in the unique core');
check('S3.noBudgetReinterpretation', (() => {
  const bare = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return !/maxChars|EXPLORE_RATIO|mainBudget|exploreBudget/.test(bare);
})(), 'budget was already decided by core.selectWithinBudget — the planner must not touch it');

/* ══════════════════════════════════════════════════════════════════════
   §4 · pinned 标签（注入式，不由本模块重算）
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · pinned');

const withLabels = SP.applySeats([sel('p', 999), sel('q', 10)], surfacePolicy, {
  labelOf: id => (id === 'p' ? SP.SEAT_PINNED : SP.SEAT_PRIMARY)
});
check('S6.pinnedLabelInjected', withLabels.seats[0].seat === SP.SEAT_PINNED
  && withLabels.seats[1].seat === SP.SEAT_PRIMARY);
check('S6.seatLabelHelper', SP.seatLabel({ pinned: true }) === SP.SEAT_PINNED
  && SP.seatLabel({ pinned: false }) === SP.SEAT_PRIMARY
  && SP.seatLabel(null) === SP.SEAT_PRIMARY);
check('S6.defaultLabelIsPrimary',
  SP.applySeats([sel('a', 1)], surfacePolicy).seats[0].seat === SP.SEAT_PRIMARY);
check('S6.pinnedDoesNotBypassCap', (() => {
  /* pinned 是**标签**，不是"永远保留"：上限对它同样生效。 */
  const input = [sel('p1', 999), sel('a', 9), sel('b', 8), sel('c', 7)];
  const p = SP.applySeats(input, surfacePolicy, { labelOf: id => (id === 'p1' ? SP.SEAT_PINNED : SP.SEAT_PRIMARY) });
  return p.seats.length === CAP;
})(), 'pinned must not bypass the channel seat cap');
check('S6.noPinnedReorder', (() => {
  /* 即使 pinned 排在后面，也不得把它提到前面 —— 顺序由 core 决定。 */
  const input = [sel('a', 1), sel('p', 999), sel('b', 2)];
  const p = SP.applySeats(input, surfacePolicy, { labelOf: id => (id === 'p' ? SP.SEAT_PINNED : SP.SEAT_PRIMARY) });
  return JSON.stringify(ids(p.seats)) === JSON.stringify(['a', 'p', 'b']);
})(), 'the planner must not hoist pinned entries — ordering is canonical');
check('S6.seatVocabularyMinimal', (() => {
  const labels = [SP.SEAT_PINNED, SP.SEAT_PRIMARY];
  return labels.length === 2 && ['exploration', 'dormant', 'glossary', 'reminisce', 'new-memory']
    .every(x => labels.indexOf(x) < 0);
})(), 'the seat vocabulary must be honest: only labels we can actually evidence');

/* ══════════════════════════════════════════════════════════════════════
   §5 · 空输入 / 边界
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · 边界');

check('S8.emptyInput', (() => {
  const p = SP.applySeats([], surfacePolicy);
  return p.seats.length === 0 && p.dropped.length === 0 && p.capped === false;
})());
check('S8.hostileInputDoesNotThrow', (() => {
  try {
    [null, undefined, 42, 'x', {}, [null, undefined, 1, 'a']].forEach(v => SP.applySeats(v, surfacePolicy));
    return true;
  } catch (e) { return false; }
})());
check('S8.nonObjectEntriesFiltered',
  SP.applySeats([null, sel('a', 1), undefined], surfacePolicy).seats.length === 1);
check('S8.zeroCapAdmitsNothing', (() => {
  const p = SP.applySeats(selN(5), { maxTotalSeats: 0 });
  return p.seats.length === 0 && p.dropped.length === 5;
})());
check('S8.noPolicyAdmitsNothing', SP.applySeats(selN(5), null).seats.length === 0,
  'without a policy the planner must not invent a cap');
check('S8.legacyFieldNameStillInterpretedAsTotal', (() => {
  /* 过渡期兼容：旧字段名按**同一个** total 语义解释，不会变成"主选区"。 */
  const p = SP.applySeats(selN(10), { maxPrimarySeats: 4 });
  return p.seats.length === 4;
})());

/* ══════════════════════════════════════════════════════════════════════
   §6 · 确定性 / 无副作用
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · 确定性');

check('S9.deterministic', (() => {
  const input = selN(20);
  const a = JSON.stringify(SP.applySeats(input, surfacePolicy));
  for (let i = 0; i < 100; i++) {
    if (JSON.stringify(SP.applySeats(input, surfacePolicy)) !== a) return false;
  }
  return true;
})());
check('S10.doesNotMutateInput', (() => {
  const input = selN(10);
  const snap = JSON.stringify(input);
  SP.applySeats(input, surfacePolicy);
  return JSON.stringify(input) === snap;
})());
check('S10.doesNotMutateInputObjects', (() => {
  const input = [sel('a', 1)];
  const before = Object.keys(input[0]).sort().join(',');
  SP.applySeats(input, surfacePolicy);
  return Object.keys(input[0]).sort().join(',') === before && input[0].seat === undefined;
})(), 'adding a seat label must be a shallow copy, never a write into the caller object');

/* ══════════════════════════════════════════════════════════════════════
   §7 · 纯函数静态证明（无 IO / 无随机 / 无 ACL / 无打分 / 无排序）
   ══════════════════════════════════════════════════════════════════════ */
section('§7 · 纯函数与职责边界');

const SRC = fs.readFileSync(path.join(ROOT, MODULE_REL), 'utf8');
/* 只剥**注释**，保留字符串字面量 —— 因为这里要断言的正是"某些词根本不出现"。
   （模块头注释里为了说明历史而提到 memoryValue / fatigue，属文档，不算实现。） */
const BARE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

[
  ['Date.now', /Date\s*\.\s*now\s*\(/], ['Math.random', /Math\s*\.\s*random\s*\(/],
  ['fetch', /\bfetch\s*\(/], ['localStorage', /\blocalStorage\b/], ['indexedDB', /\bindexedDB\b/],
  ['require', /\brequire\s*\(/], ['window', /\bwindow\s*\./], ['console', /\bconsole\s*\./]
].forEach(([label, re]) => check('S11-12.noForbidden.' + label, !re.test(BARE)));

check('S7.noOwnRankingFormula', !/\.sort\s*\(/.test(BARE),
  'the planner must never sort — ordering is canonical and arrives already decided');
check('S8.noMemoryValueSort', !/memoryValue/.test(BARE),
  'memoryValue must not appear in the implementation at all (it is only the base term)');
check('S9.noRelevanceSort', !/relevance|relBoost|calcRelevance|scoreRelevance/.test(BARE));
check('S10.noFatigueImplementation', !/fatigue/.test(BARE));
check('S11.idIsNotASecondSorter', !/localeCompare|>\s*id|\bid\s*<\s*|sortBy/.test(BARE),
  'id is a stable identity, never a second ordering key');
check('S13.noAclLogic',
  !/isMemoryVisibleTo|visibleTo|excludeFrom|visibility\s*[=!]/.test(BARE),
  'the planner must not do ACL — that is memory-visibility-core');
check('S14.noScoringAtAll',
  !/getMemoryScore|importance\s*\*|arousal\s*\*|_score/.test(BARE),
  'the planner must not score — that is memory-retrieval-core / scoring.js');
check('S14.noSecondSelector',
  !/rankMemoryCandidates|selectWithinBudget|buildMemoryContext/.test(BARE),
  'the planner must not duplicate the selector — it consumes its output');
check('S14.doesNotImportCore', !/memory-retrieval-core/.test(BARE),
  'consuming canonical output must not require reaching into the core');

/* ══════════════════════════════════════════════════════════════════════
   §8 · 对抗性：seat cap 不得形成"第二个 selector"（P21-R2-D.1）
   ──────────────────────────────────────────────────────────────────────
   为什么必须有这一节：
     canonical selector 的真实 ranking 是 base × relBoost × fatigue，
     而 memoryValue 只是其中的 base。因此"按 memoryValue 降序截断"
     会在候选数 > cap 时删掉一条 canonical 本会排得更高的记录 ——
     那时 seat-planner 就不只是 seat cap，而是**在 core 之前偷偷形成了
     第二个 selector**，违反"唯一 ranking implementation"。
   ══════════════════════════════════════════════════════════════════════ */
section('§8 · 对抗性 · ranking inversion');

const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));

const NOW = 1750000000000;
/* 查询词刻意用 4 个英文词：extractKeywords 对纯英文只产出这 4 个词元，
   因此 relBoost 精确可控（命中 1/4 → 1.375；命中 4/4 → 2.5）。 */
const QUERY = 'alpha beta gamma delta';
const KEYWORDS = CORE.extractKeywords(QUERY);

const mkmem = o => Object.assign({
  id: 'm', title: '记录', content: '', importance: 5, arousal: 0.3, resolved: false,
  activationCount: 0, created: NOW, lastActivated: NOW,
  visibility: 'public', tags: [], domain: '日常'
}, o || {});

/* ── fixture 1：relevance 反演 ────────────────────────────────────────
   四条全部 relevant（都至少命中 1 个词元 ⇒ 都过 Hard Gate）。
     A importance 10, 命中 alpha             → base 10k, relBoost 1.375
     B importance  9, 命中 beta              → base  9k, relBoost 1.375
     C importance  8, 命中 gamma             → base  8k, relBoost 1.375
     D importance  7, 命中全部 4 个           → base  7k, relBoost 2.5
   （k = activationFactor × decayFactor × emotionFactor，四条相同）

     memoryValue 序：A(10) > B(9) > C(8) > D(7)
     canonical _score 序：D(17.5) > A(13.75) > B(12.375) > C(11)
   ⇒ cap = 3 时：
        正确（canonical）：[D, A, B]
        错误（memoryValue）：[A, B, C]   ← D 被提前删掉
   两组都是 3 条，但集合不同 —— 因此"数量对"不能证明"顺序对"。 */
const REL_A = mkmem({ id: 'A', importance: 10, content: 'alpha' });
const REL_B = mkmem({ id: 'B', importance: 9, content: 'beta' });
const REL_C = mkmem({ id: 'C', importance: 8, content: 'gamma' });
const REL_D = mkmem({ id: 'D', importance: 7, content: 'alpha beta gamma delta' });
const REL_SET = [REL_A, REL_B, REL_C, REL_D];

const mvOf = m => CORE.getMemoryScore(m, NOW);
const mvOrder = REL_SET.slice().sort((a, b) => mvOf(b) - mvOf(a)).map(m => m.id);
const canonOrder = CORE.rankMemoryCandidates(REL_SET, { apiId: 'role_a', now: NOW, userMessage: QUERY })
  .map(r => r.id);

check('S21.fixtureIsAdversarial.memoryValueOrder', JSON.stringify(mvOrder) === JSON.stringify(['A', 'B', 'C', 'D']),
  'memoryValue order=' + JSON.stringify(mvOrder));
check('S21.fixtureIsAdversarial.canonicalOrder', JSON.stringify(canonOrder) === JSON.stringify(['D', 'A', 'B', 'C']),
  'canonical order=' + JSON.stringify(canonOrder)
  + ' (relevance inversion must be real, else this fixture proves nothing)');
check('S21.fixtureIsAdversarial.ordersDiffer', JSON.stringify(mvOrder) !== JSON.stringify(canonOrder),
  'the whole point: memoryValue order must differ from canonical rank order');
check('S21.fixtureAllPassGate', REL_SET.every(m => CORE.calcRelevance(m, KEYWORDS) > 1),
  'all four must be relevant so the seat cap — not the gate — is what decides');

/* 在**完整** gated 候选集上，canonical selector 会把 D 排进 top 3。 */
const canonFull = CORE.buildMemoryContext(REL_SET, {
  apiId: 'role_a', now: NOW, random: () => 0, userMessage: QUERY,
  maxChars: 4000, contentLen: 200
});
check('S21.coreRanksDIntoTargetSet', canonFull.selected.some(s => s.id === 'D'),
  'canonical selector on the full set must select D — selected=' + JSON.stringify(canonFull.selected.map(s => s.id)));

const seatRun = () => ORCH.recall(REL_SET, {
  apiId: 'role_a', now: NOW, random: () => 0, userMessage: QUERY,
  isGroup: false, groupMemEnabled: false, maxChars: 4000, contentLen: 200,
  turn: { message: QUERY }
}).result;
const capped = seatRun();
const cappedIds = capped.selected.map(s => s.id);

check('S22.surfaceCapActuallyEngaged', capped.selected.length === CAP,
  'the surface cap (' + CAP + ') must really be the limiter — selected=' + JSON.stringify(cappedIds));
check('S22.canonicalTopNIsKept', cappedIds.every(id => canonOrder.slice(0, CAP).indexOf(id) >= 0),
  'selected=' + JSON.stringify(cappedIds)
  + ' must be a subset of canonical top-' + CAP + '=' + JSON.stringify(canonOrder.slice(0, CAP)));
check('S23.seatPlannerPreservesCanonicalOrder',
  JSON.stringify(cappedIds) === JSON.stringify(canonOrder.slice(0, CAP)),
  'expected ' + JSON.stringify(canonOrder.slice(0, CAP)) + ' got ' + JSON.stringify(cappedIds));
check('S23.highestMemoryValueIsNotTheCriterion',
  JSON.stringify(cappedIds) !== JSON.stringify(mvOrder.slice(0, CAP)),
  'if this equals the memoryValue top-N, the planner is acting as a second selector again');

/* 文本必须由**保留下来的**那些行组成（chars 与 text 一致）。 */
check('S25.cappedTextIsExactlyTheKeptLines', (() => {
  const lines = capped.selected.map(s => s.line).join('');
  return capped.text.slice(-lines.length) === lines && capped.chars === capped.text.length;
})(), 'the rebuilt block must be composed of core\'s own lines, and chars must match the text');

/* trace 的 seat 与 decision 必须描述**真正注入**的那批。 */
const seatRunFull = ORCH.recall(REL_SET, {
  apiId: 'role_a', now: NOW, random: () => 0, userMessage: QUERY,
  isGroup: false, groupMemEnabled: false, maxChars: 4000, contentLen: 200,
  turn: { message: QUERY }
});
check('S26.traceSelectedRowsMatchResult', (() => {
  const selRows = seatRunFull.trace.candidates.filter(c => c.decision === 'selected').map(c => c.memoryId);
  return JSON.stringify(selRows) === JSON.stringify(cappedIds);
})(), 'trace selected rows must equal the injected set');
check('S26.traceRejectedDoNotClaimSeat', seatRunFull.trace.candidates
  .filter(c => c.decision === 'rejected').every(c => c.seat === SP.SEAT_UNKNOWN),
  'a non-injected row must not claim a planner seat');

/* ── fixture 2：fatigue 反演 ──────────────────────────────────────────
     E importance 10, activationCount 10, lastActivated = now
       → fatigue 0.7（2 小时内反复激活），activationFactor = 1+10/310
       → base ≈ 12.80，_score ≈ 12.80 × 1.375 × 0.7 ≈ 12.32
     F importance  9, activationCount 0, lastActivated = now
       → fatigue 1，activationFactor 1 → base = 9 × 1.24 = 11.16
       → _score ≈ 11.16 × 1.375 ≈ 15.35
     memoryValue 序：E > F；canonical 序：F > E  ⇒ 只看 memoryValue 会选错。 */
const FAT_E = mkmem({ id: 'E', importance: 10, activationCount: 10, lastActivated: NOW, content: 'alpha' });
const FAT_F = mkmem({ id: 'F', importance: 9, content: 'beta' });
const FAT_SET = [FAT_E, FAT_F];
const fatMvOrder = FAT_SET.slice().sort((a, b) => mvOf(b) - mvOf(a)).map(m => m.id);
const fatCanon = CORE.rankMemoryCandidates(FAT_SET, { apiId: 'role_a', now: NOW, userMessage: QUERY }).map(r => r.id);

check('S24.fatigueFixtureIsAdversarial', JSON.stringify(fatMvOrder) === JSON.stringify(['E', 'F'])
  && JSON.stringify(fatCanon) === JSON.stringify(['F', 'E']),
  'memoryValue=' + JSON.stringify(fatMvOrder) + ' canonical=' + JSON.stringify(fatCanon));
check('S24.fatigueInversionIsObservableUncapped', (() => {
  const r = ORCH.recall(FAT_SET, {
    apiId: 'role_a', now: NOW, random: () => 0, userMessage: QUERY,
    isGroup: false, groupMemEnabled: false, maxChars: 4000, contentLen: 200,
    turn: { message: QUERY }
  }).result;
  return JSON.stringify(r.selected.map(s => s.id)) === JSON.stringify(['F', 'E']);
})(), 'uncapped canonical selection must already order F before E — the fatigue term is only visible in core');
check('S24.fatigueIsNotReimplementedInOrchestrator', (() => {
  const orchSrc = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8');
  const bare = orchSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return !/fatigue|relBoost|activationCount\s*[><=]/.test(bare);
})(), 'the orchestrator must not carry a copy of the fatigue/relBoost formula either');

/* ══════════════════════════════════════════════════════════════════════
   §9 · Exploration candidate space 不得被 seat 上限改变（R2-D.1 §6）
   ──────────────────────────────────────────────────────────────────────
   R2-D 明确冻结"旧 85/15 exploration 实现本轮不修"。
   但若 seat cap 施加在 core **之前**，探索池就会被压进 top-N ——
   那等于偷偷改写了 exploration 的候选空间（R2-F 才该处理这件事）。

   三条独立证据：
     ① **spy**：拦截 orchestrator 传给 core.buildMemoryContext 的候选列表，
        断言它是**完整**的 gated 候选集，而不是被截断过的 top-N。
     ② **行为**：预算合适时，core 的探索窗口仍能从排名**尾部**抽中一条低尾候选。
     ③ **结构**：seat planner 一定在 core **之后**被调用。
   ══════════════════════════════════════════════════════════════════════ */
section('§9 · exploration candidate space 不变');

const QUERY2 = 'alpha beta gamma delta';
/* 8 条全部 relevant，cap = 3 ⇒ 若实现事先截断，core 只会看到 3 条。 */
const POOL = Array.from({ length: 8 }, (_, i) => mkmem({ id: 'p' + i, importance: 10 - i, content: 'alpha' }));

let seenByCore = null;
const spyOrch = ORCH.createOrchestrator({
  core: {
    buildMemoryContext: function (recs, opts) {
      seenByCore = { count: Array.isArray(recs) ? recs.length : -1, ids: (recs || []).map(r => r.id) };
      return CORE.buildMemoryContext(recs, opts);
    }
  }
});
spyOrch.recall(POOL, {
  apiId: 'role_a', now: NOW, random: () => 0, userMessage: QUERY2,
  isGroup: false, groupMemEnabled: false, maxChars: 4000, contentLen: 200,
  turn: { message: QUERY2 }
});
check('S27.coreSeesTheFullGatedCandidateSet', seenByCore && seenByCore.count === POOL.length,
  'core must receive ALL ' + POOL.length + ' gated candidates — got ' + JSON.stringify(seenByCore)
  + '. A pre-truncated list means the seat cap ran a second selector.');
check('S27.coreSeesEveryCandidate', seenByCore
  && JSON.stringify(seenByCore.ids.slice().sort()) === JSON.stringify(POOL.map(m => m.id).sort()),
  'no candidate may be dropped on the way in');

/* ② 行为证据：探索窗口仍可从排名尾部抽取。
   预算 400 → mainBudget = 340，探索预算 60 > 50 从而启用探索窗口。
   random()=0.999 ⇒ 取 remaining 的**最后**一条（排名最低的候选）。 */
const expOrch = ORCH.createOrchestrator({});
const expCanon = CORE.rankMemoryCandidates(POOL, { apiId: 'role_a', now: NOW, userMessage: QUERY2 }).map(r => r.id);
const tailId = expCanon[expCanon.length - 1];
const rawCore = CORE.buildMemoryContext(POOL, {
  apiId: 'role_a', now: NOW, random: () => 0.999, userMessage: QUERY2,
  maxChars: 400, contentLen: 12
});
check('S27.explorationStillReachesRankTail', rawCore.selected.some(s => s.id === tailId),
  'core\'s exploration window must still reach the lowest-ranked candidate (' + tailId
  + ') — selected=' + JSON.stringify(rawCore.selected.map(s => s.id))
  + '. This is the candidate space R2-D must not shrink.');
check('S27.resultIsCanonicalPrefixOfCoreSelection', (() => {
  const got = expOrch.recall(POOL, {
    apiId: 'role_a', now: NOW, random: () => 0.999, userMessage: QUERY2,
    isGroup: false, groupMemEnabled: false, maxChars: 400, contentLen: 12,
    turn: { message: QUERY2 }
  }).result.selected.map(s => s.id);
  const coreSel = rawCore.selected.map(s => s.id);
  return got.length > 0 && got.every(function (id, idx) { return id === coreSel[idx]; });
})(), 'the injected set must be a canonical PREFIX of what core chose — the seat cap only truncates the tail');

/* ③ 结构证据：seat 上限一定在 core 之后 —— 由调用顺序直接钉住。 */
check('S28.seatCapIsAppliedAfterSelection', (() => {
  const order = [];
  const probe = ORCH.createOrchestrator({
    core: {
      buildMemoryContext: function (recs, opts) {
        order.push('core');
        return CORE.buildMemoryContext(recs, opts);
      }
    },
    seatPlanner: {
      applySeats: function (selected, policy, options) {
        order.push('seats:' + (Array.isArray(selected) ? selected.length : -1));
        return SP.applySeats(selected, policy, options);
      },
      seatLabel: SP.seatLabel
    }
  });
  probe.recall(POOL, {
    apiId: 'role_a', now: NOW, random: () => 0, userMessage: QUERY2,
    isGroup: false, groupMemEnabled: false, maxChars: 4000, contentLen: 200,
    turn: { message: QUERY2 }
  });
  return order.length === 2 && order[0] === 'core'
    && /^seats:\d+$/.test(order[1]) && Number(order[1].split(':')[1]) > 0;
})(), 'seat planner must consume core\'s selected output, never precede it');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL SEATS FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL SEATS PASSED · ' + passed + ' assertions green');
}
