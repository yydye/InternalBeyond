'use strict';
/* Internal Beyond · P21-R2-F1a · Semantic Delta（独立 phase matrix）
   运行：node tests/test_memory_recall_r2f_delta.js

   ── 为什么必须独立于 E1 matrix ────────────────────────────────────────
     tests/test_memory_recall_semantic_delta.js 表达 **E 相位**的不变量
     （surface/recall/glossary/coldStart 的通道语义）。R2-F1a 改的是
     canonical selector 自身的缺陷（D-3 / D-4 / header / seat），把它塞进
     E matrix 会让 E 相位开始承担 F 相位的 diff。两者分开。

   ── old side 从哪来 ──────────────────────────────────────────────────
     静态 frozen fixture：tests/fixtures/memory-recall-r2f-baseline/
     **绝不**调用旧 core 当 oracle —— 那会在 core 改动后一起漂移（=恒真）。
     本文件也不写 fixture；只读。

   ── accounting 必须机器闭合 ──────────────────────────────────────────
     rows === changed + same，id 唯一。反向控制证明这些判据**能失败**。
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
const CP = require(path.join(ROOT, 'assets/js/memory-recall/channel-policy.js'));
const SP = require(path.join(ROOT, 'assets/js/memory-recall/seat-planner.js'));
const GC = require(path.join(ROOT, 'assets/js/memory-recall/glossary-catalog.js'));

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log('  PASS  ' + n); } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

const DIR = path.join(ROOT, 'tests/fixtures/memory-recall-r2f-baseline');
const CASES = fs.readdirSync(path.join(DIR, 'cases')).filter(f => f.endsWith('.json')).sort()
  .map(f => JSON.parse(fs.readFileSync(path.join(DIR, 'cases', f), 'utf8')));
const byId = {};
CASES.forEach(c => { byId[c.id] = c; });
const preF = id => byId[id].expected;                       /* 静态 old side */
const nowOf = id => CORE.buildMemoryContext(byId[id].records,
  Object.assign({}, byId[id].options, { random: () => byId[id].random }));
const brief = r => ({ ids: r.selected.map(s => s.id), count: r.count, chars: r.chars, reason: r.reason });

/* ── 通用行机制（与 E1 matrix 同一套闭合原则） ─────────────────────── */
const ROWS = [];
/* 结构性不变量行（basis=invariant）：old/new 都是同一个不变量探针，
   want=actual=SAME。它与 frozen-fixture 行不同 —— 后者比较 pre-F 静态数据，
   前者断言"该不变量在 R2-F1a 之后仍然成立"。两类都进入同一套 accounting。 */
function invariantRow(id, label, ok, detail) {
  pushRow({ id, label, want: 'SAME', actual: 'SAME', old: 'invariant', neu: 'invariant',
    basis: 'invariant', pass: !!ok });
  check(id + '.invariant', ok, detail);
}
const CHANGED_ROWS = [], SAME_ROWS = [];
function pushRow(row) {
  if (row.want !== 'CHANGED' && row.want !== 'SAME') throw new Error('row must declare want: ' + row.id);
  ROWS.push(row);
  if (row.want === 'CHANGED') CHANGED_ROWS.push(row); else SAME_ROWS.push(row);
}
function row(id, label, want, oldSide, newSide, ok, detail) {
  const same = JSON.stringify(oldSide) === JSON.stringify(newSide);
  const actual = same ? 'SAME' : 'CHANGED';
  const expectOk = (want === 'SAME') ? same : !same;
  pushRow({ id, label, want, actual, old: JSON.stringify(oldSide), neu: JSON.stringify(newSide),
    pass: expectOk && ok });
  check(id + ' [' + want + ']', expectOk && ok, detail);
  return { same, actual };
}

const NOW = 1750000000000, DAY = 86400000;
const mk = o => Object.assign({ id: 'm', title: 'T', content: 'C', importance: 5, arousal: 0.3,
  resolved: false, activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
  visibility: 'public', tags: [], domain: '日常', createdBy: 'user' }, o || {});
const B = { apiId: 'role_a', now: NOW, isGroup: false, groupMemEnabled: false, maxChars: 700, contentLen: 200 };
const turnOf = (msg, e) => Object.assign({ message: msg, conversationSignalAvailable: true,
  isFirstTurn: false, conversationId: 'dm:role_a' }, e || {});
const FIVE = (pre) => [10, 9, 8, 7, 6].map((imp, i) => mk({
  id: pre + (i + 1), title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: imp }));

/* ══ §20 · EXPECTED CHANGED ══════════════════════════════════════════ */
section('§20 · EXPECTED CHANGED');

/* F1 · top-10 tail reachability（core 层全量可达性） */
(function F1() {
  const c = byId['f03_exploration_random0999'];
  const scored = CORE.rankMemoryCandidates(c.records, Object.assign({}, c.options, { userMessage: '' }));
  const mb = Math.floor(Math.max(0, c.options.maxChars - 0) * 0.85);
  const main = []; let ch = 0;
  for (const m of scored.filter(x => x.pinned)) { const l = CORE.renderMemoryLine(m, 'role_a', c.options.contentLen); if (ch + l.length > mb) continue; ch += l.length; main.push(m.id); }
  for (const m of scored.filter(x => !x.pinned)) { const l = CORE.renderMemoryLine(m, 'role_a', c.options.contentLen); if (ch + l.length > mb) continue; ch += l.length; main.push(m.id); }
  const mainSet = new Set(main);
  const remaining = scored.filter(m => !mainSet.has(m.id) && !m.pinned);
  const idxs = new Set();
  for (let k = 0; k <= 2000; k++) {
    const o = CORE.selectWithinBudget(scored, Object.assign({}, c.options, { random: () => k / 2001 }));
    (o.explorationIds || []).forEach(id => idxs.add(remaining.findIndex(m => m.id === id)));
  }
  const list = [...idxs].sort((a, b) => a - b);
  row('F1', 'top-10 tail reachability', 'CHANGED',
    { reachableIndices: 10, maxIndex: 9 }, { reachableIndices: list.length, maxIndex: Math.max(...list) },
    list.length === remaining.length && Math.max(...list) === remaining.length - 1 && Math.max(...list) > 9,
    'remaining=' + remaining.length + ' reachable=' + JSON.stringify(list));
})();

/* F2 · random=0.999 从 m17 变成真正的 remaining tail */
row('F2', 'random=0.999 reaches the real tail', 'CHANGED',
  preF('f03_exploration_random0999'), nowOf('f03_exploration_random0999'),
  nowOf('f03_exploration_random0999').selected.map(s => s.id).indexOf('m20') >= 0,
  'preF=' + JSON.stringify(brief(preF('f03_exploration_random0999')))
  + ' now=' + JSON.stringify(brief(nowOf('f03_exploration_random0999'))));

/* F2b · random=0.5 也随窗口放开而移动 */
row('F2b', 'random=0.5 moves with the widened window', 'CHANGED',
  preF('f02_exploration_random05'), nowOf('f02_exploration_random05'), true,
  JSON.stringify(brief(nowOf('f02_exploration_random05'))));

/* F3 · oversized A then fitting B */
row('F3', 'oversized candidate skipped, later fitting admitted', 'CHANGED',
  preF('f07_oversized_then_fitting'), nowOf('f07_oversized_then_fitting'),
  nowOf('f07_oversized_then_fitting').selected.map(s => s.id).join(',') === 'B_small,C_small',
  JSON.stringify(brief(nowOf('f07_oversized_then_fitting'))));

/* F4 · oversized pinned then fitting later pinned */
row('F4', 'oversized pinned no longer starves a fitting pinned', 'CHANGED',
  preF('f23_pinned_oversized_then_fitting_pinned'), nowOf('f23_pinned_oversized_then_fitting_pinned'),
  nowOf('f23_pinned_oversized_then_fitting_pinned').selected.map(s => s.id).join(',') === 'PB_small',
  JSON.stringify(brief(nowOf('f23_pinned_oversized_then_fitting_pinned'))));

/* F5/F6 · header overflow closed */
row('F5', 'header 44 no longer overflows', 'CHANGED',
  preF('f10_header_44'), nowOf('f10_header_44'),
  nowOf('f10_header_44').chars <= 44,
  'preF chars=' + preF('f10_header_44').chars + ' > 44 ; now ' + nowOf('f10_header_44').chars);
row('F6', 'header 88 no longer overflows', 'CHANGED',
  preF('f11_header_88'), nowOf('f11_header_88'),
  nowOf('f11_header_88').chars <= 88,
  'preF chars=' + preF('f11_header_88').chars + ' > 88 ; now ' + nowOf('f11_header_88').chars);

/* F7/F8 · glossary / coldStart 不再随 random 变化 */
(function F78() {
  const gcProv = GC.createGlossaryCatalogProvider(() => [1, 2, 3, 4, 5].map(i =>
    ({ alias: '暗号', kind: 'term', target: { type: 'memory', id: 'g' + i } })));
  const probe = (recs, msg, extra, opts) => {
    const set = new Set(); let calls = 0;
    for (const r of [0, 0.5, 0.999]) {
      const o = ORCH.recall(recs, Object.assign({}, B, { userMessage: msg, random: () => { calls++; return r; },
        ...(opts || {}) }, { turn: turnOf(msg, extra) }));
      set.add(JSON.stringify(o.result.selected.map(s => s.id)));
    }
    return { distinct: set.size, calls, sample: JSON.parse([...set][0]) };
  };
  const gls = probe(FIVE('g'), '暗号', { isFirstTurn: false }, { glossaryProvider: gcProv });
  const anchors = [mk({ id: 'pin1', pinned: true, title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: 9 })]
    .concat([8, 7, 6, 5].map((imp, i) => mk({ id: 'sem' + (i + 1), kind: 'semantic', title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: imp })));
  const cds = probe(anchors, '嗯', { isFirstTurn: true });
  row('F7', 'glossary stops exploring (deterministic lookup)', 'CHANGED',
    { distinctAcrossRandoms: 3, randomCalls: 3 }, { distinctAcrossRandoms: gls.distinct, randomCalls: gls.calls },
    gls.distinct === 1 && gls.calls === 0, JSON.stringify(gls));
  row('F8', 'coldStart stops exploring (stable anchor restore)', 'CHANGED',
    { distinctAcrossRandoms: 3, randomCalls: 3 }, { distinctAcrossRandoms: cds.distinct, randomCalls: cds.calls },
    cds.distinct === 1 && cds.calls === 0, JSON.stringify(cds));
})();

/* F9 · surface：真实 exploration item 能进入 total-seat result */
(function F9() {
  const pol = CP.resolveChannelPolicy('surface').policy;
  const sel = [{ id: 'P1', score: 999, line: 'P1\n' }, { id: 'M1', score: 9, line: 'M1\n' },
    { id: 'M2', score: 8, line: 'M2\n' }, { id: 'M3', score: 7, line: 'M3\n' }];
  const labelled = sel.map(r => Object.assign({}, r, { seat: r.id === 'P1' ? SP.SEAT_PINNED : SP.SEAT_PRIMARY }));
  const plan = SP.applySeats(labelled, pol, { labelOf: id => (id === 'P1' ? SP.SEAT_PINNED : SP.SEAT_PRIMARY),
    explorationIds: ['M3'], allowExploration: true });
  const ids = plan.seats.map(s => s.id);
  row('F9', 'exploration item survives the total-seat cap', 'CHANGED',
    { seats: ['P1', 'M1', 'M2'], hasExploration: false },
    { seats: ids, hasExploration: ids.indexOf('M3') >= 0 },
    ids.indexOf('M3') >= 0 && ids.length === pol.maxTotalSeats
    && plan.seats.filter(s => s.seat === SP.SEAT_EXPLORATION).length <= 1,
    JSON.stringify(plan.seats.map(s => s.id + ':' + s.seat)));
})();

/* F10 · zero-budget 语义变化（closure §10）
   pre-F：maxChars <= 0 被替换成 DEFAULT_BUDGET_CHARS(2000) ⇒ **仍然注入非空记忆块**；
   F1a ：maxChars === 0 是**真实零预算** ⇒ 0 memory / no-budget。
   这是用户可见变化，因此必须有 matrix row，不能只写在报告散文里。 */
row('F10', 'maxChars=0 is a true zero budget', 'CHANGED',
  preF('f25_zero_budget'), nowOf('f25_zero_budget'),
  nowOf('f25_zero_budget').count === 0 && nowOf('f25_zero_budget').chars === 0
  && nowOf('f25_zero_budget').reason === 'no-budget' && preF('f25_zero_budget').count > 0,
  'preF=' + JSON.stringify(brief(preF('f25_zero_budget')))
  + ' now=' + JSON.stringify(brief(nowOf('f25_zero_budget'))));

/* ══ §21 · EXPECTED SAME ═════════════════════════════════════════════ */
section('§21 · EXPECTED SAME');

/* 16 条 frozen SAME（未被申报为变化的用例必须逐字不变） */
const DECLARED = byId && (function () {
  const mf = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const d = {}; Object.keys(mf.changedByR2F1a || {}).forEach(k => { if (k !== 'note') d[k] = 1; }); return d;
})();
(function frozenSame() {
  let bad = [];
  for (const c of CASES) {
    if (DECLARED[c.id]) continue;
    const now = CORE.buildMemoryContext(c.records, Object.assign({}, c.options, { random: () => c.random }));
    if (JSON.stringify(now) !== JSON.stringify(c.expected)) bad.push(c.id);
  }
  pushRow({ id: 'S1', label: 'un-declared frozen cases are byte-identical', want: 'SAME', actual: bad.length ? 'CHANGED' : 'SAME',
    old: 'frozen', neu: 'current', pass: bad.length === 0 });
  check('S1.frozenUndeclaredCasesUnchanged', bad.length === 0, JSON.stringify(bad));
})();

invariantRow('S2', 'ACL / visibility order', (() => {
  const recs = [mk({ id: 'v', title: 'AAAA', content: 'AAAA' }),
    mk({ id: 'p', visibility: 'private', title: 'AAAA', content: 'AAAA' }),
    mk({ id: 'o', visibility: 'only', visibleTo: ['role_a'], title: 'AAAA', content: 'AAAA' }),
    mk({ id: 'e', visibility: 'except', excludeFrom: ['role_a'], title: 'AAAA', content: 'AAAA' })];
  const r = CORE.buildMemoryContext(recs, Object.assign({}, B, { userMessage: 'AAAA', random: () => 0.5 }));
  return r.selected.every(s => s.id !== 'p' && s.id !== 'e');
})(), 'visibility still runs before everything else');

invariantRow('S3', 'Hard Gate rejects lexically empty', (() => {
  const o = ORCH.recall([mk({ id: 'x', title: 'ZZZ', content: 'zzz' })],
    Object.assign({}, B, { userMessage: 'AAAA', turn: turnOf('AAAA') }));
  return o.result.reason === 'gate-rejected' && o.result.count === 0;
})());

invariantRow('S4', 'renderMemoryLine formatting', (() => {
  const rec = mk({ id: 'r', title: 'T', content: 'C', tags: ['a'], resolved: true });
  return CORE.renderMemoryLine(rec, 'role_a', 200) === '- [用户记录] T（日常 · a）：C [已解决]\n';
})(), 'render format must be byte-identical');

invariantRow('S5', 'pinned score = 999', CORE.getMemoryScore(mk({ pinned: true }), NOW) === 999);
/* 孤立 fatigue：直接对 `_score === base × relBoost × fatigue` 这个恒等式取证。
   不能用"近期/久远两条的比值"——那会把 decay 一起算进去（第一次就是这么写错的）。 */
invariantRow('S6', 'fatigue formula (base x relBoost x fatigue)', (() => {
  const m = mk({ id: 'f', title: 'AAAA', content: 'AAAA', activationCount: 10, lastActivated: NOW });
  const scored = CORE.rankMemoryCandidates([m], Object.assign({}, B, { userMessage: 'AAAA' }))[0];
  const base = CORE.getMemoryScore(m, NOW);
  const rel = CORE.calcRelevance(m, CORE.extractKeywords('AAAA'));
  const fatigued = Math.abs(scored._score - base * rel * 0.7) < 1e-9;
  const calmM = mk({ id: 'c', title: 'AAAA', content: 'AAAA', activationCount: 10, lastActivated: NOW - 3 * DAY });
  const calm = CORE.rankMemoryCandidates([calmM], Object.assign({}, B, { userMessage: 'AAAA' }))[0];
  const noFatigue = Math.abs(calm._score - CORE.getMemoryScore(calmM, NOW) * CORE.calcRelevance(calmM, CORE.extractKeywords('AAAA')) * 1) < 1e-9;
  return fatigued && noFatigue;
})(), 'fatigue must still be a x0.7 multiplier for activationCount>5 within 2h');
invariantRow('S7', 'MemoryValue formula', (() => {
  const m = mk({ id: 'v', importance: 8, arousal: 0.3, activationCount: 0, lastActivated: NOW - DAY });
  return CORE.getMemoryScore(m, NOW) === Math.round(8 * 1 * Math.exp(-0.05 * 1) * (1 + 0.3 * 0.8) * 100) / 100;
})());
invariantRow('S8', 'seat totals 3 / 5 and inheritance', CP.resolveChannelPolicy('surface').policy.maxTotalSeats === 3
  && CP.resolveChannelPolicy('recall').policy.maxTotalSeats === 5
  && CP.resolveChannelPolicy('glossary').policy.maxTotalSeats === CP.MAX_RECALL_TOTAL_SEATS
  && CP.resolveChannelPolicy('coldStart').policy.maxTotalSeats === CP.MAX_SURFACE_TOTAL_SEATS);
invariantRow('S9', 'activationPolicy normal / none', CP.resolveChannelPolicy('glossary').policy.activationPolicy === 'normal'
  && CP.resolveChannelPolicy('coldStart').policy.activationPolicy === 'none');
invariantRow('S10', 'public result shape (no selectionMeta)', (() => {
  const o = ORCH.recall(FIVE('s'), Object.assign({}, B, { userMessage: 'AAAA', random: () => 0.999, turn: turnOf('AAAA') }));
  return JSON.stringify(Object.keys(o.result).sort()) === JSON.stringify(['chars', 'count', 'reason', 'selected', 'text'])
    && JSON.stringify(o.result).indexOf('selectionMeta') < 0;
})(), 'selectionMeta is internal and must be stripped');
invariantRow('S11', 'CANDIDATE_KEYS unchanged', (() => {
  const T = require(path.join(ROOT, 'assets/js/memory-recall/recall-trace.js'));
  return JSON.stringify(T.CANDIDATE_KEYS) === JSON.stringify(['memoryId', 'relevanceScore', 'memoryValue',
    'cooldownFactor', 'finalScore', 'seat', 'decision', 'reasons']);
})());
invariantRow('S12', 'finalScore still null', (() => {
  const o = ORCH.recall(FIVE('s'), Object.assign({}, B, { userMessage: 'AAAA', random: () => 0.999, turn: turnOf('AAAA') }));
  return o.trace.candidates.every(c => c.finalScore === null);
})());
invariantRow('S13', 'cooldownFactor still 1 (no cooldown)', (() => {
  const o = ORCH.recall(FIVE('s'), Object.assign({}, B, { userMessage: 'AAAA', random: () => 0.999, turn: turnOf('AAAA') }));
  return o.trace.candidates.every(c => c.cooldownFactor === 1);
})(), 'R2-F1a must NOT introduce cooldown');
invariantRow('S14', 'DB_VER still 24', (() => {
  const cc = fs.readFileSync(path.join(ROOT, 'assets/js/chat-core.js'), 'utf8');
  const m = cc.match(/DB_VER\s*=\s*(\d+)/);
  return !!m && m[1] === '24';
})());
invariantRow('S15', 'coldStart activation suppressed', (() => {
  const anchors = [mk({ id: 'pin1', pinned: true, title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: 9 }),
    mk({ id: 'sem1', kind: 'semantic', title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: 8 })];
  const o = ORCH.recall(anchors, Object.assign({}, B, { userMessage: '嗯', random: () => 0.5,
    turn: turnOf('嗯', { isFirstTurn: true }) }));
  return o.meta.activationPolicy === 'none' && o.result.selected.length > 0;
})());
invariantRow('S16', 'legacy no-turn shape', (() => {
  const recs = FIVE('l');
  const a = ORCH.recall(recs, Object.assign({}, B, { userMessage: 'AAAA', random: () => 0.5 })).result;
  const b = CORE.buildMemoryContext(recs, Object.assign({}, B, { userMessage: 'AAAA', random: () => 0.5 }));
  return JSON.stringify(a) === JSON.stringify(b);
})());
invariantRow('S17', 'glossary stable target', (() => {
  const GC2 = GC.createGlossaryCatalogProvider(() => [{ alias: '暗号', kind: 'term', target: { type: 'memory', id: 'g1' } }]);
  const o = ORCH.recall(FIVE('g'), Object.assign({}, B, { userMessage: '暗号', random: () => 0.5,
    glossaryProvider: GC2, turn: turnOf('暗号') }));
  return o.trace.channel === 'glossary' && o.result.selected.map(s => s.id).indexOf('g1') >= 0;
})());
invariantRow('S18', 'coldStart admission', (() => {
  const recs = [mk({ id: 'pin', pinned: true }), mk({ id: 'sem', kind: 'semantic' }),
    mk({ id: 'man', source: 'manual' }), mk({ id: 'res', pinned: true, resolved: true })];
  const o = ORCH.recall(recs, Object.assign({}, B, { userMessage: '嗯', random: () => 0.5,
    turn: turnOf('嗯', { isFirstTurn: true }) }));
  const ids = o.result.selected.map(s => s.id);
  return ids.indexOf('man') < 0 && (ids.indexOf('pin') >= 0 || ids.indexOf('res') >= 0);
})());
invariantRow('S19', 'random normalization is safe', (() => {
  const safe = [0, 0.5, 0.999999, 1, NaN, -1, Infinity, 2].every(v => {
    const r = CORE.normalizeRandom01(v);
    return isFinite(r) && r >= 0 && r < 1;
  });
  const recs = FIVE('n');
  let threw = false;
  try { CORE.buildMemoryContext(recs, Object.assign({}, B, { userMessage: 'AAAA', maxChars: 200, random: () => 1 })); }
  catch (e) { threw = true; }
  return safe && !threw;
})());
invariantRow('S20', 'exploration enablement gate', (() => {
  const a = CORE.buildMemoryContext(FIVE('n'), Object.assign({}, B, { userMessage: 'AAAA', maxChars: 300, contentLen: 200, random: () => 0.999 }));
  return !a.selected.some(s => s.id === 'n5');
})(), 'reservedExploreCapacity <= 50 still disables exploration');

/* ══ accounting 闭合 + 反向控制 ══════════════════════════════════════ */
section('§accounting · 机器闭合');
function computeSummary(rows) {
  const ids = rows.map(r => r.id);
  return { total: rows.length, changed: rows.filter(r => r.actual === 'CHANGED').length,
    same: rows.filter(r => r.actual === 'SAME').length, uniqueIds: new Set(ids).size, ids,
    unknown: rows.filter(r => r.actual !== 'CHANGED' && r.actual !== 'SAME').map(r => r.id) };
}
const SUMMARY = computeSummary(ROWS);
check('D1.summaryCloses', SUMMARY.total === SUMMARY.changed + SUMMARY.same,
  SUMMARY.total + ' vs ' + SUMMARY.changed + '+' + SUMMARY.same);
check('D2.idsUnique', SUMMARY.uniqueIds === SUMMARY.total, SUMMARY.uniqueIds + '/' + SUMMARY.total);
check('D3.noUnknownActual', SUMMARY.unknown.length === 0, JSON.stringify(SUMMARY.unknown));
check('D4.declaredSplitMatchesActual', CHANGED_ROWS.length === SUMMARY.changed && SAME_ROWS.length === SUMMARY.same,
  'declared(' + CHANGED_ROWS.length + ',' + SAME_ROWS.length + ') actual(' + SUMMARY.changed + ',' + SUMMARY.same + ')');
check('D5.allRowsPass', ROWS.every(r => r.pass), JSON.stringify(ROWS.filter(r => !r.pass).map(r => r.id)));
check('D6.reverseControl.duplicateIdDetectable',
  computeSummary(ROWS.concat([{ id: ROWS[0].id, want: 'SAME', actual: 'SAME' }])).uniqueIds !== ROWS.length + 1);
check('D7.reverseControl.missingRowBreaksIdentity', (() => {
  const s = computeSummary(ROWS.slice(0, ROWS.length - 1));
  return ROWS.length !== s.changed + s.same;
})(), 'tallying over a subset must break rows === changed + same');
check('D8.reverseControl.inflatedCountBreaksIdentity', SUMMARY.total !== (SUMMARY.changed + 1) + SUMMARY.same);

console.log('\n' + '─'.repeat(96));
console.log('R2-F1A SEMANTIC DELTA MATRIX');
console.log('─'.repeat(96));
ROWS.forEach(r => console.log('  ' + r.id.padEnd(5) + r.label.padEnd(48)
  + r.want.padEnd(10) + r.actual.padEnd(9) + (r.pass ? 'PASS' : 'FAIL')));
console.log('─'.repeat(96));
console.log('rows=' + SUMMARY.total + '  changed=' + SUMMARY.changed + '  same=' + SUMMARY.same);
console.log('assert rows === changed + same : ' + (SUMMARY.total === SUMMARY.changed + SUMMARY.same));
console.log('unique row ids               : ' + SUMMARY.uniqueIds + ' / ' + SUMMARY.total);
console.log('row ids                      : ' + SUMMARY.ids.join(', '));

console.log('\n' + '='.repeat(64));
if (failures) { console.error('MEMORY RECALL R2F DELTA FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
else console.log('MEMORY RECALL R2F DELTA PASSED · ' + passed + ' assertions green');
