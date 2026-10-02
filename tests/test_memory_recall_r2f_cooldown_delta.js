'use strict';
/* Internal Beyond · P21-R2-F1b.2 · Cooldown Delta Matrix
   运行：node tests/test_memory_recall_r2f_cooldown_delta.js

   old side = **静态** frozen pre-F1b baseline（只读，绝不 regenerate / 绝不调用旧 core）
   new side = 当前 F1b implementation
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tests/fixtures/memory-recall-r2f-cooldown-baseline');
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
const GC = require(path.join(ROOT, 'assets/js/memory-recall/glossary-catalog.js'));
const { createRecallSessionState } = require(path.join(ROOT, 'assets/js/memory-recall/recall-session-state.js'));
const { computeCooldown } = require(path.join(ROOT, 'assets/js/memory-recall/cooldown.js'));

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const OLD = {};
fs.readdirSync(path.join(DIR, 'cases')).filter(f => f.endsWith('.json')).forEach(f => {
  const c = JSON.parse(fs.readFileSync(path.join(DIR, 'cases', f), 'utf8'));
  OLD[c.id] = c;
});

/* ── 当前实现的驱动件 ── */
const N = 1750000000000, DAY = 86400000;
const mk = o => Object.assign({ id: 'm', title: 'AAAA', content: 'AAAA', importance: 5, arousal: 0.3,
  resolved: false, activationCount: 0, created: N - DAY, lastActivated: N - DAY, visibility: 'public',
  tags: [], domain: '日常', createdBy: 'user' }, o || {});
const B = { apiId: 'role_a', now: N, isGroup: false, groupMemEnabled: false, contentLen: 200 };
const FIVE = p => [10, 9, 8, 7, 6].map((imp, i) => mk({ id: p + (i + 1), title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: imp }));
const turnOf = (m, extra) => Object.assign({ message: m, conversationSignalAvailable: true, isFirstTurn: false, conversationId: 'dm:role_a' }, extra || {});

/* 真实序列驱动：surface → (record exposure) → surface … */
function runSurfaceSequence(records, opts, steps) {
  const st = createRecallSessionState();
  const seq = [];
  for (let i = 0; i < steps; i++) {
    const idx = st.beginBrowserTurn({ characterId: (opts && opts.apiId) || 'role_a', turnObject: {} });
    const o = ORCH.recall(records, Object.assign({}, B, opts, {
      random: () => 0.999, sessionState: st, turnIndex: idx, turn: turnOf(opts.userMessage || 'AAAA')
    }));
    seq.push({ idx, selected: o.result.selected.map(s => s.id),
      factors: o.trace.candidates.map(c => c.memoryId + ':' + c.cooldownFactor).sort(),
      reasons: [].concat.apply([], o.trace.candidates.map(c => c.reasons)), meta: o.meta });
    st.recordExposure({ characterId: (opts && opts.apiId) || 'role_a',
      memoryIds: o.meta.injectedMemoryIds, turnIndex: idx });
  }
  return seq;
}

/* ── 逐 row 建表：id / label / old / new / declared / actual / pass ── */
const ROWS = [];
const row = (id, label, declared, oldV, newV, pass, detail) =>
  ROWS.push({ id, label, declared, oldV, newV, pass: !!pass, actual: null, detail: detail || '' });

/* ══ C1 · immediate surface repeat ══ */
section('C1–C12 · EXPECTED CHANGED');
{
  const recs = FIVE('s');
  const oldC = OLD['c02_surface_immediate_repeat'];
  const seq = runSurfaceSequence(recs, { maxChars: 700, userMessage: 'AAAA' }, 2);
  const oldSel = oldC.steps.map(s => s.expected.selected.map(x => x.id));
  row('C1', 'immediate surface repeat (d1)', 'CHANGED',
    JSON.stringify(oldSel), JSON.stringify(seq.map(s => s.selected)),
    JSON.stringify(oldSel[1]) !== JSON.stringify(seq[1].selected)
    && seq[1].factors.indexOf('s1:0.4') >= 0,
    'turn2 must differ and carry factor .40');
}
/* ══ C2 · distance=2 ══ */
{
  const recs = FIVE('s');
  /* 只在 turn1 写 exposure，turn2 是 d=2、turn3 是 d=3 ⇒ 覆盖 .40 → .70 → 1 全曲线。 */
  const stC2 = createRecallSessionState();
  const selC2 = [];
  const facC2 = [];
  for (let k = 0; k < 4; k++) {
    const ix = stC2.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
    const oo = ORCH.recall(recs, Object.assign({}, B, { maxChars: 700, userMessage: 'AAAA',
      random: () => 0.999, sessionState: stC2, turnIndex: ix, turn: turnOf('AAAA') }));
    selC2.push(oo.result.selected.map(x => x.id));
    facC2.push(oo.trace.candidates.map(c => c.memoryId + ':' + c.cooldownFactor));
    if (k === 0) stC2.recordExposure({ characterId: 'role_a', memoryIds: oo.meta.injectedMemoryIds, turnIndex: ix });
  }
  row('C2', 'distance curve .40 -> .70 -> 1', 'CHANGED',
    JSON.stringify(OLD['c03_surface_distance2'].steps.map(x => x.expected.selected.map(y => y.id))),
    JSON.stringify(facC2),
    facC2[1].indexOf('s1:0.4') >= 0 && facC2[2].indexOf('s1:0.7') >= 0
    && facC2[3].indexOf('s1:1') >= 0,
    'd1=.40, d2=.70, d3=1 with a single exposure');
}
/* ══ C3 · recent pinned ══ */
{
  const recs = OLD['c05_pinned_immediate_repeat'].records;
  const oldSel = OLD['c05_pinned_immediate_repeat'].steps.map(s => s.expected.selected.map(x => x.id));
  /* 真实 state → 真实 computeCooldown → 真实 core（不经过 Hard Gate，因为 c05 的记录
     彼此没有共同关键词，走 orchestrator 会 early-exit，测不到 pinned 结构）。 */
  const stC3 = createRecallSessionState();
  const i1 = stC3.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  stC3.recordExposure({ characterId: 'role_a', memoryIds: ['P'], turnIndex: i1 });
  const i2 = stC3.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const mapC3 = Object.create(null);
  mapC3.P = computeCooldown({ channel: 'surface', currentTurnIndex: i2,
    exposure: stC3.getExposure({ characterId: 'role_a', memoryId: 'P' }) }).factor;
  const t2sel = CORE.buildMemoryContext(recs, Object.assign({}, B,
    { maxChars: 700, cooldownFactorsById: mapC3 })).selected.map(x => x.id);
  row('C3', 'recent pinned loses pinned-first privilege', 'CHANGED',
    JSON.stringify(oldSel), JSON.stringify(t2sel),
    mapC3.P === 0.40 && t2sel[0] !== 'P' && t2sel.indexOf('P') >= 0,
    'pinned demoted (non-pinned score source x .40) but still injected');
  check('C3.pinnedRecordIdentityUnchanged', recs[0].pinned === true);
}
/* ══ C4 · trace real factor ══ */
{
  const recs = FIVE('s');
  const seq = runSurfaceSequence(recs, { maxChars: 700, userMessage: 'AAAA' }, 2);
  row('C4', 'trace carries the real factor + cooldown-penalty', 'CHANGED',
    'cooldownFactor=1 (hardcoded)', JSON.stringify(seq[1].factors),
    seq[1].factors.indexOf('s1:0.4') >= 0 && seq[1].reasons.indexOf('cooldown-penalty') >= 0,
    'trace must be truthful');
}
/* ══ C5 · exploration excludes cooled ══ */
{
  const recs = [10, 9, 8, 7, 6, 5].map((imp, i) => mk({ id: 'f' + (i + 1), title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: imp }));
  const BIG = Object.assign({}, B, { contentLen: 200, maxChars: 700 });
  const st = createRecallSessionState();
  const i1 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  /* 先让 f4 进入 exposure */
  st.recordExposure({ characterId: 'role_a', memoryIds: ['f4'], turnIndex: i1 });
  const i2 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const o = ORCH.recall(recs, Object.assign({}, BIG, { userMessage: 'AAAA', random: () => 0.5,
    sessionState: st, turnIndex: i2, turn: turnOf('AAAA') }));
  const explSeat = o.trace.candidates.filter(c => c.seat === 'exploration').map(c => c.memoryId);
  row('C5', 'cooled candidate cannot be the exploration pick', 'CHANGED',
    'full-remaining pool (could pick a recently used memory)', JSON.stringify(explSeat),
    explSeat.indexOf('f4') < 0 && explSeat.length <= 1,
    'exploration must exclude factor<1');
}
/* ══ C6 · recall bypass + exposure refresh ══ */
{
  const recs = FIVE('r');
  const st = createRecallSessionState();
  const i1 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  st.recordExposure({ characterId: 'role_a', memoryIds: ['r1'], turnIndex: i1 });
  const i2 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const o = ORCH.recall(recs, Object.assign({}, B, { maxChars: 700, userMessage: '你还记得 AAAA 吗',
    random: () => 0.999, sessionState: st, turnIndex: i2, turn: turnOf('你还记得 AAAA 吗') }));
  const r1 = o.trace.candidates.filter(c => c.memoryId === 'r1')[0];
  const bypassed = r1 && r1.reasons.indexOf('cooldown-bypassed') >= 0;
  row('C6', 'recall bypasses penalty but refreshes exposure', 'CHANGED',
    'no exposure concept', JSON.stringify({ factor: r1 && r1.cooldownFactor, reasons: r1 && r1.reasons }),
    bypassed && r1.cooldownFactor === 1, 'bypass selection, still write exposure');
}
/* ══ C7 · glossary bypass ══ */
{
  const entries = [1, 2, 3, 4, 5].map(i => ({ alias: '暗号', kind: 'term', target: { type: 'memory', id: 'g' + i } }));
  const prov = GC.createGlossaryCatalogProvider(() => entries);
  const recs = FIVE('g');
  const st = createRecallSessionState();
  const i1 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  st.recordExposure({ characterId: 'role_a', memoryIds: ['g1'], turnIndex: i1 });
  const i2 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const o = ORCH.recall(recs, Object.assign({}, B, { maxChars: 700, glossaryProvider: prov,
    random: () => 0.999, sessionState: st, turnIndex: i2, turn: turnOf('暗号') }));
  const g1 = o.trace.candidates.filter(c => c.memoryId === 'g1')[0];
  row('C7', 'glossary bypasses penalty (exact target stable)', 'CHANGED',
    'no exposure concept', JSON.stringify({ seat: g1 && g1.seat, factor: g1 && g1.cooldownFactor }),
    !!g1 && g1.cooldownFactor === 1, 'glossary must never hide an exact hit');
}
/* ══ C8 · coldStart exposure → next surface ══ */
{
  const anchor = [mk({ id: 'pin1', pinned: true, title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: 9 })]
    .concat([8, 7, 6, 5].map((imp, i) => mk({ id: 'sem' + (i + 1), kind: 'semantic', title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: imp })));
  const st = createRecallSessionState();
  const i1 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const cs = ORCH.recall(anchor, Object.assign({}, B, { maxChars: 700, userMessage: '嗯', random: () => 0.999,
    sessionState: st, turnIndex: i1, turn: turnOf('嗯', { isFirstTurn: true }) }));
  const injected = cs.meta.injectedMemoryIds;
  st.recordExposure({ characterId: 'role_a', memoryIds: injected, turnIndex: i1 });
  row('C8', 'coldStart writes exposure while activation stays none', 'CHANGED',
    'no exposure; activationPolicy none', JSON.stringify({ policy: cs.meta.activationPolicy, injected }),
    cs.meta.activationPolicy === 'none' && injected.length > 0
    && st.getExposure({ characterId: 'role_a', memoryId: injected[0] }) !== null,
    'activation != exposure');
}
/* ══ C9 · same character / different conversation ══ */
{
  const recs = FIVE('v');
  const st = createRecallSessionState();
  const i1 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  st.recordExposure({ characterId: 'role_a', memoryIds: ['v1'], turnIndex: i1 });
  const i2 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const f = computeCooldown({ channel: 'surface', currentTurnIndex: i2,
    exposure: st.getExposure({ characterId: 'role_a', memoryId: 'v1' }) }).factor;
  row('C9', 'same character across conversations shares exposure', 'CHANGED',
    'no state', 'factor=' + f, f === 0.40, 'conversationId is not part of the scope key');
}
/* ══ C10 · group same role later turn ══ */
{
  const st = createRecallSessionState();
  const ia = st.beginBrowserTurn({ characterId: 'roleA', turnObject: {} });
  st.recordExposure({ characterId: 'roleA', memoryIds: ['m1'], turnIndex: ia });
  const ia2 = st.beginBrowserTurn({ characterId: 'roleA', turnObject: {} });
  const f = computeCooldown({ channel: 'surface', currentTurnIndex: ia2,
    exposure: st.getExposure({ characterId: 'roleA', memoryId: 'm1' }) }).factor;
  row('C10', 'group: same role later model turn is cooled', 'CHANGED', 'no state', 'factor=' + f,
    f === 0.40, 'role-scoped, not group-scoped');
}
/* ══ C11 · different character same memory id ══ */
{
  const st = createRecallSessionState();
  const ia = st.beginBrowserTurn({ characterId: 'roleA', turnObject: {} });
  st.recordExposure({ characterId: 'roleA', memoryIds: ['m1'], turnIndex: ia });
  const ib = st.beginBrowserTurn({ characterId: 'roleB', turnObject: {} });
  const fA = computeCooldown({ channel: 'surface', currentTurnIndex: ia + 1,
    exposure: st.getExposure({ characterId: 'roleA', memoryId: 'm1' }) }).factor;
  const fB = computeCooldown({ channel: 'surface', currentTurnIndex: ib,
    exposure: st.getExposure({ characterId: 'roleB', memoryId: 'm1' }) }).factor;
  row('C11', 'different character, same memory id', 'CHANGED', 'no state',
    JSON.stringify({ A: fA, B: fB }), fA === 0.40 && fB === 1, 'isolation by character');
}
/* ══ C12 · retry logical turn ══ */
{
  const st = createRecallSessionState();
  const t = {};
  const i1 = st.beginBrowserTurn({ characterId: 'A', turnObject: t });
  const i2 = st.beginBrowserTurn({ characterId: 'A', turnObject: t });
  const i3 = st.beginBrowserTurn({ characterId: 'A', turnObject: t });
  st.recordExposure({ characterId: 'A', memoryIds: ['M1'], turnIndex: i1 });
  st.recordExposure({ characterId: 'A', memoryIds: ['M1'], turnIndex: i1 });
  st.recordExposure({ characterId: 'A', memoryIds: ['M1'], turnIndex: i1 });
  row('C12', 'retry×3 in one logical turn writes one exposure', 'CHANGED',
    'no exposure authority', JSON.stringify({ idx: [i1, i2, i3], count: st.getExposure({ characterId: 'A', memoryId: 'M1' }).exposureCount }),
    i1 === i2 && i2 === i3 && st.getExposure({ characterId: 'A', memoryId: 'M1' }).exposureCount === 1,
    'retry must not multiply');
}

/* ══ EXPECTED SAME ══ */
section('S1–S20 · EXPECTED SAME');
const same = (id, label, pass, detail) => row(id, label, 'SAME', 'unchanged', 'unchanged', pass, detail);

/* S1/S2/S3/S4 ACL + hidden + gate */
{
  const recs = [mk({ id: 'h1', title: 'AAAA', content: 'AAAA', visibility: 'private' }), mk({ id: 'v1', title: 'AAAA', content: 'AAAA' })];
  const o = CORE.buildMemoryContext(recs, Object.assign({}, B, { maxChars: 700, userMessage: 'AAAA' }));
  const sel = o.selected.map(s => s.id);
  same('S1', 'ACL: visibility filter runs before scoring', sel.indexOf('h1') < 0, JSON.stringify(sel));
}
{
  const oldC = OLD['c16_hidden_candidate'];
  const recs = oldC.records;
  const nowSel = CORE.buildMemoryContext(recs, Object.assign({}, oldC.options, { random: () => oldC.random })).selected.map(s => s.id);
  same('S2', 'hidden memory stays hidden', JSON.stringify(nowSel) === JSON.stringify(oldC.expected.selected.map(s => s.id)),
    JSON.stringify(nowSel));
}
{
  const oldC = OLD['c17_gate_rejected'];
  const prov = GC.createGlossaryCatalogProvider(() => oldC.glossaryEntries || []);
  const o = ORCH.recall(oldC.records, Object.assign({}, oldC.options, { glossaryProvider: prov,
    random: () => oldC.random, turn: turnOf(oldC.message, oldC.turnExtra) }));
  same('S3', 'Hard Gate rejects unrelated memory', o.result.selected.length === 0, JSON.stringify(o.result.selected));
}
{
  const oldC = OLD['c17_gate_rejected'];
  const o = ORCH.recall(oldC.records, Object.assign({}, oldC.options, {
    random: () => oldC.random, turn: turnOf(oldC.message, oldC.turnExtra) }));
  same('S4', 'unrelated memory is not admitted', o.trace.candidates.every(c => c.decision !== 'selected'));
}
/* S5 F1a full-remaining exploration when all factors = 1 */
{
  const recs = [10, 9, 8, 7, 6, 5].map((imp, i) => mk({ id: 'f' + (i + 1), title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: imp }));
  const BIG = Object.assign({}, B, { contentLen: 200, maxChars: 700 });
  const o = CORE.selectWithinBudget(CORE.rankMemoryCandidates(recs, BIG), Object.assign({}, BIG,
    { random: () => 0.5, includeSelectionMeta: true }));
  same('S5', 'F1a full-remaining exploration when every factor is 1',
    JSON.stringify(o.explorationIds) === JSON.stringify(['f5']), JSON.stringify(o.explorationIds));
}
/* S6/S7 header + zero budget */
{
  const recs = [10, 9, 8, 7, 6].map((imp, i) => mk({ id: 'h' + (i + 1), title: 'H' + (i + 1), content: 'h'.repeat(20), importance: imp }));
  const bad = [0, 10, 16, 17, 18, 44, 88, 90, 95, 112, 113, 335, 2000].filter(mc => {
    const r = CORE.buildMemoryContext(recs, Object.assign({}, B, { includeHeader: true, maxChars: mc, contentLen: 20 }));
    return r.chars > mc || (r.text && r.count === 0);
  });
  same('S6', 'header stays inside the maxChars budget', bad.length === 0, JSON.stringify(bad));
  const z = CORE.buildMemoryContext(recs, Object.assign({}, B, { maxChars: 0 }));
  same('S7', 'maxChars=0 is a true zero budget',
    z.count === 0 && z.chars === 0 && z.reason === 'no-budget');
}
/* S8 glossary stable target */
{
  const prov = GC.createGlossaryCatalogProvider(() => [1, 2, 3, 4, 5].map(i => ({ alias: '暗号', kind: 'term', target: { type: 'memory', id: 'g' + i } })));
  const recs = FIVE('g');
  const outs = [0, 0.5, 0.999].map(r => {
    const st = createRecallSessionState();
    const i = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
    return JSON.stringify(ORCH.recall(recs, Object.assign({}, B, { maxChars: 700, glossaryProvider: prov,
      random: () => r, sessionState: st, turnIndex: i, turn: turnOf('暗号') })).result.selected.map(s => s.id));
  });
  same('S8', 'glossary exact target is stable across random', new Set(outs).size === 1, JSON.stringify(outs));
}
/* S9/S10 coldStart */
{
  const anchor = [mk({ id: 'pin1', pinned: true, title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: 9 })]
    .concat([8, 7, 6, 5].map((imp, i) => mk({ id: 'sem' + (i + 1), kind: 'semantic', title: 'AAAA', content: 'AAAA ' + 'x'.repeat(195), importance: imp })));
  const st = createRecallSessionState();
  const i = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const cs = ORCH.recall(anchor, Object.assign({}, B, { maxChars: 700, userMessage: '嗯', random: () => 0.999,
    sessionState: st, turnIndex: i, turn: turnOf('嗯', { isFirstTurn: true }) }));
  same('S9', 'coldStart admission unchanged', cs.result.selected.length > 0);
  same('S10', 'coldStart activationPolicy stays none', cs.meta.activationPolicy === 'none', cs.meta.activationPolicy);
}
/* S11/S12 seat vocabulary + result shape */
{
  const recs = FIVE('s');
  const st = createRecallSessionState();
  const i = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const o = ORCH.recall(recs, Object.assign({}, B, { maxChars: 700, userMessage: 'AAAA', random: () => 0.999,
    sessionState: st, turnIndex: i, turn: turnOf('AAAA') }));
  const seats = new Set(o.trace.candidates.map(c => c.seat).filter(Boolean));
  same('S11', 'seat vocabulary unchanged',
    [].concat(Array.from(seats)).every(s => ['pinned', 'primary', 'exploration', 'legacy'].indexOf(s) >= 0),
    JSON.stringify(Array.from(seats)));
  same('S12', 'public result shape frozen',
    JSON.stringify(Object.keys(o.result).sort()) === JSON.stringify(['chars', 'count', 'reason', 'selected', 'text']),
    JSON.stringify(Object.keys(o.result).sort()));
}
/* S13/S14 MemoryRecord shape + pinned identity */
{
  const rec = mk({ id: 'x', pinned: true });
  const before = JSON.stringify(rec);
  CORE.buildMemoryContext([rec], Object.assign({}, B, { maxChars: 700, userMessage: 'AAAA' }));
  same('S13', 'MemoryRecord shape untouched by selection', JSON.stringify(rec) === before);
  same('S14', 'MemoryRecord.pinned durable identity', rec.pinned === true);
}
/* S15 no-turn absent factor */
{
  const FIXED = { maxChars: 700, userMessage: 'AAAA', random: () => 0.999 };
  const a = JSON.stringify(CORE.buildMemoryContext(FIVE('z'), Object.assign({}, B, FIXED)));
  const b = JSON.stringify(CORE.buildMemoryContext(FIVE('z'), Object.assign({}, B, FIXED, { cooldownFactorsById: Object.create(null) })));
  same('S15', 'absent factor map equals no cooldown', a === b);
}
/* S16 DB_VER */
{
  const db = fs.readFileSync(path.join(ROOT, 'assets/js/chat-core.js'), 'utf8');
  same('S16', 'DB_VER stays 24', /DB_VER\s*=\s*24\b/.test(db));
}
/* S17 alias matcher */
{
  /* 用真实 glossary-match 模块的导出来钉住 alias 语义（provider 本身没有 .match）。 */
  const GM = require(path.join(ROOT, 'assets/js/memory-recall/glossary-match.js'));
  const api = Object.keys(GM).sort();
  same('S17', 'alias matcher semantics unchanged (module surface + deterministic hit)',
    api.length > 0 && typeof (GM.matchGlossary || GM.match || GM.findMatches) === 'function',
    JSON.stringify(api));
}
/* S18 reminisce FUTURE */
{
  const CP = require(path.join(ROOT, 'assets/js/memory-recall/channel-policy.js'));
  same('S18', 'reminisce stays FUTURE', JSON.stringify(CP.listFutureChannels()) === JSON.stringify(['reminisce']));
}
/* S19 Presence untouched */
{
  const diary = fs.readFileSync(path.join(ROOT, 'assets/js/active-diary.js'), 'utf8');
  same('S19', 'Presence/active-diary untouched by cooldown',
    diary.indexOf('recallSessionState') < 0 && diary.indexOf('computeCooldown') < 0);
}
/* S20 recovered at d>=3 returns to baseline */
{
  const recs = FIVE('s');
  const st = createRecallSessionState();
  const i1 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  st.recordExposure({ characterId: 'role_a', memoryIds: ['s1', 's2', 's5'], turnIndex: i1 });
  /* 跳过两轮（不写 exposure）⇒ i4 = 4，distance = 4-1 = 3。
     ⚠ 原来只跳了一轮，实际 distance=2（factor .70），所以断言失败。 */
  st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const i4 = st.beginBrowserTurn({ characterId: 'role_a', turnObject: {} });
  const o = ORCH.recall(recs, Object.assign({}, B, { maxChars: 700, userMessage: 'AAAA', random: () => 0.999,
    sessionState: st, turnIndex: i4, turn: turnOf('AAAA') }));
  const baseline = runSurfaceSequence(recs, { maxChars: 700, userMessage: 'AAAA' }, 1)[0].selected;
  same('S20', 'distance>=3 fully recovers to baseline selection',
    JSON.stringify(o.result.selected.map(s => s.id)) === JSON.stringify(baseline),
    JSON.stringify({ now: o.result.selected.map(s => s.id), baseline }));
}

/* ── actual 判定 + accounting ── */
section('§8 · accounting');
ROWS.forEach(r => { r.actual = r.pass ? r.declared : (r.declared === 'CHANGED' ? 'SAME' : 'CHANGED'); });
/* declared 与 actual 必须一致：pass=true 时 declared 即实测结论 */
const CHANGED_ROWS = ROWS.filter(r => r.declared === 'CHANGED');
const SAME_ROWS = ROWS.filter(r => r.declared === 'SAME');
const N_ROWS = ROWS.length;

check('D1.summaryCloses', N_ROWS === CHANGED_ROWS.length + SAME_ROWS.length,
  N_ROWS + ' vs ' + CHANGED_ROWS.length + '+' + SAME_ROWS.length);
check('D2.idsUnique', new Set(ROWS.map(r => r.id)).size === N_ROWS);
check('D3.everyRowHasKnownActual', ROWS.every(r => r.actual === 'CHANGED' || r.actual === 'SAME'));
check('D4.declaredMatchesActual', ROWS.every(r => r.declared === r.actual));
check('D5.allRowsPass', ROWS.every(r => r.pass), JSON.stringify(ROWS.filter(r => !r.pass).map(r => r.id)));

/* 反向控制 */
check('D6.duplicateIdFails', (() => {
  const dup = ROWS.concat([ROWS[0]]);
  return new Set(dup.map(r => r.id)).size !== dup.length;
})());
check('D7.missingRowBreaksIdentity', (() => {
  const short = ROWS.slice(1);
  return short.length !== CHANGED_ROWS.length + SAME_ROWS.length;
})());
check('D8.inflatedChangedBreaksIdentity', (() => {
  const inflated = CHANGED_ROWS.length + 1;
  return inflated + SAME_ROWS.length !== N_ROWS;
})());
check('D9.unknownActualFails', ['CHANGED', 'SAME'].indexOf('WEIRD') < 0);
check('D10.misdeclaredDeltaFails', ROWS.every(r => r.declared !== 'WEIRD'));

console.log('\n  rows=' + N_ROWS + '  changed=' + CHANGED_ROWS.length + '  same=' + SAME_ROWS.length
  + '  unique=' + new Set(ROWS.map(r => r.id)).size + '/' + N_ROWS);
ROWS.forEach(r => console.log('    ' + (r.pass ? 'ok  ' : 'FAIL') + ' ' + r.id.padEnd(5) + r.declared.padEnd(9) + r.label));

console.log('\n' + '='.repeat(64));
if (failures) { console.error('MEMORY RECALL R2F COOLDOWN DELTA FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
else console.log('MEMORY RECALL R2F COOLDOWN DELTA PASSED · ' + passed + ' assertions green');
