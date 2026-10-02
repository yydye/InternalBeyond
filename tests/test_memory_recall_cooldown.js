'use strict';
/* Internal Beyond · P21-R2-F1b.1 · Cooldown 纯策略 + core 注入 + pinned 结构 + exploration
   运行：node tests/test_memory_recall_cooldown.js
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const CDP = path.join(ROOT, 'assets/js/memory-recall/cooldown.js');
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const { computeCooldown, factorForDistance, modeOf, DEFAULT_POLICY,
  REASON_PENALTY, REASON_BYPASSED } = require(CDP);
const CD_BARE = fs.readFileSync(CDP, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');

const NOW = 1750000000000, DAY = 86400000;
const mk = o => Object.assign({ id: 'm', title: 'T', content: 'C', importance: 5, arousal: 0.3,
  resolved: false, activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
  visibility: 'public', tags: [], domain: '日常', createdBy: 'user' }, o || {});
const B = { apiId: 'role_a', now: NOW, isGroup: false, groupMemEnabled: false,
  includeHeader: false, contentLen: 200, maxChars: 2000 };
const exp = (last) => ({ lastExposureTurn: last, exposureCount: 1 });
const at = (channel, cur, last) => computeCooldown({ channel, currentTurnIndex: cur, exposure: last == null ? null : exp(last) });

/* ── C1–C6 factor 曲线 ── */
section('C1–C6 · factor');
check('C1.noExposureIsOne', at('surface', 5, null).factor === 1);
check('C1.noExposureHasNoReason', at('surface', 5, null).reason === null
  && at('surface', 5, null).bypassed === false);
check('C2.distanceZeroIsOne', at('surface', 3, 3).factor === 1);
check('C2.distanceNegativeIsOne', at('surface', 2, 9).factor === 1);
check('C3.surfaceD1Is040', at('surface', 2, 1).factor === 0.40);
check('C4.surfaceD2Is070', at('surface', 3, 1).factor === 0.70);
check('C5.surfaceD3IsOne', at('surface', 4, 1).factor === 1);
check('C6.surfaceD100IsOne', at('surface', 101, 1).factor === 1);
check('C3.surfaceD1ReasonIsPenalty', at('surface', 2, 1).reason === REASON_PENALTY);
check('C5.recoveredHasNoPenaltyReason', at('surface', 4, 1).reason === null);

/* ── C7–C10 bypass truthfulness ── */
section('C7–C10 · bypass truthfulness');
check('C7.recallActiveCooldownFactorIsOne', at('recall', 2, 1).factor === 1);
check('C7.recallActiveCooldownBypassed', at('recall', 2, 1).bypassed === true
  && at('recall', 2, 1).reason === REASON_BYPASSED);
check('C8.glossaryActiveCooldownBypassed', at('glossary', 2, 1).factor === 1
  && at('glossary', 2, 1).bypassed === true && at('glossary', 2, 1).reason === REASON_BYPASSED);
check('C9.recallNoExposureNoFalseBypass', at('recall', 5, null).bypassed === false
  && at('recall', 5, null).reason === null);
check('C9.recallRecoveredNoFalseBypass', at('recall', 9, 1).bypassed === false
  && at('recall', 9, 1).reason === null);
check('C10.glossaryRecoveredNoFalseBypass', at('glossary', 4, 1).bypassed === false
  && at('glossary', 4, 1).reason === null);
check('C10.glossaryNoExposureNoFalseBypass', at('glossary', 4, null).reason === null);

/* ── C11–C12 coldStart read-none ── */
section('C11–C12 · coldStart read-none');
check('C11.coldStartAlwaysOne', at('coldStart', 2, 1).factor === 1
  && at('coldStart', 2, 1).bypassed === false && at('coldStart', 2, 1).reason === null);
check('C12.coldStartDoesNotComputeDistance', at('coldStart', 2, 1).distance === null);
check('C12.coldStartModeIsReadNone', modeOf('coldStart') === 'read-none'
  && at('coldStart', 2, 1).mode === 'read-none');
check('C12.coldStartIgnoresGarbageExposure', (() => {
  const bad = [{ lastExposureTurn: NaN }, { lastExposureTurn: 'x' }, 0, [], 'x', true];
  return bad.every(v => computeCooldown({ channel: 'coldStart', currentTurnIndex: 2, exposure: v }).factor === 1);
})());

/* ── C13–C19 不变量 ── */
section('C13–C19 · invariants');
check('C13.deterministic', (() => {
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(at('surface', 2, 1)) !== JSON.stringify(at('surface', 2, 1))) return false;
  }
  return true;
})());
check('C14.neverBelowOrEqualZero', (() => {
  for (let d = -5; d < 30; d++) { const f = at('surface', 1 + d, 1).factor; if (!(f > 0)) return false; }
  return true;
})());
check('C15.neverAboveOne', (() => {
  for (let d = -5; d < 30; d++) { const f = at('surface', 1 + d, 1).factor; if (!(f <= 1)) return false; }
  return true;
})());
check('C16.noWallClockInSource', !/Date\.now|new Date\s*\(|performance\.now/.test(CD_BARE));
check('C17.pureNoStateWrite', !/\.set\s*\(|\.delete\s*\(|\.push\s*\(|localStorage|indexedDB|sqlite/i.test(CD_BARE));
check('C17.doesNotRequireSessionState', !/recall-session-state/.test(CD_BARE));
check('C17.noDbOrFs', !/require\s*\(\s*['"](fs|http|https|node:fs)['"]/.test(CD_BARE));
check('C17.noSortOrSelect', !/\.sort\s*\(|getMemoryScore|calcRelevance|visibility/i.test(CD_BARE));
check('C18.unknownChannelFailsSafeToObey', (() => {
  const r = computeCooldown({ channel: 'nonsense', currentTurnIndex: 2, exposure: exp(1) });
  return r.factor === 0.40 && r.mode === 'obey';
})());
check('C18.missingChannelFailsSafe', computeCooldown({ currentTurnIndex: 2, exposure: exp(1) }).factor === 0.40);
check('C19.malformedExposureFailsSafe', (() => {
  const bad = [undefined, null, 0, 'x', true, [], {}, { lastExposureTurn: NaN },
    { lastExposureTurn: Infinity }, { lastExposureTurn: 'x' }];
  return bad.every(v => {
    const r = computeCooldown({ channel: 'surface', currentTurnIndex: 5, exposure: v });
    return r.factor === 1 && r.reason === null;
  });
})());
check('C19.malformedCurrentTurnFailsSafe', (() => {
  const bad = [undefined, null, NaN, Infinity, 'x', {}];
  return bad.every(v => computeCooldown({ channel: 'surface', currentTurnIndex: v, exposure: exp(1) }).factor === 1);
})());
check('C19.badPolicyFailsSafeToOne', (() => {
  const bad = [{ 1: NaN }, { 1: 5 }, { 1: -1 }, { 1: 0 }, { 1: 'x' }, { 1: {} }, { 1: Infinity }];
  return bad.every(p => computeCooldown({ channel: 'surface', currentTurnIndex: 2, exposure: exp(1), policy: p }).factor === 1);
})());
check('C19.nullPolicyMeansDefaultNotInvalid',
  computeCooldown({ channel: 'surface', currentTurnIndex: 2, exposure: exp(1), policy: null }).factor === 0.40);
check('C20.policyConstantsExact', DEFAULT_POLICY[1] === 0.40 && DEFAULT_POLICY[2] === 0.70
  && DEFAULT_POLICY.recoveryTurns === 3);
check('C20.factorForDistanceTable', [[0, 1], [1, 0.40], [2, 0.70], [3, 1], [99, 1]]
  .every(([d, f]) => factorForDistance(d, DEFAULT_POLICY) === f));
check('C20.reasonVocabularyExact', REASON_PENALTY === 'cooldown-penalty'
  && REASON_BYPASSED === 'cooldown-bypassed');

/* ── §5 core factor 安全读取 ── */
section('§5 · core cooldownFactorsById fail-safe');
/* 三条都带可命中的关键词，P 才会真正 admitted（否则它只是 gate-rejected，
   seat 会是 legacy 而不是 pinned，测不到我们要钉的结构）。 */
const GATE_MSG = 'KEYWORD';
const R3 = [mk({ id: 'P', pinned: true, title: 'KEYWORD', content: 'KEYWORD ' + 'p'.repeat(20), importance: 10 }),
  mk({ id: 'N1', title: 'KEYWORD', content: 'KEYWORD ' + 'n'.repeat(20), importance: 12 }),
  mk({ id: 'N2', title: 'KEYWORD', content: 'KEYWORD ' + 'n'.repeat(20), importance: 11 })];
const selWith = (map) => CORE.buildMemoryContext(R3, Object.assign({}, B, { cooldownFactorsById: map }))
  .selected.map(s => s.id);
const mapOf = (v) => { const m = Object.create(null); m.P = v; return m; };

check('E1.missingMapBehavesAsNoCooldown', JSON.stringify(selWith(undefined)) === JSON.stringify(['P', 'N1', 'N2']));
check('E1.nullMapBehavesAsNoCooldown', JSON.stringify(selWith(null)) === JSON.stringify(['P', 'N1', 'N2']));
check('E1.nonObjectMapBehavesAsNoCooldown', ['x', 5, true, []].every(v =>
  JSON.stringify(selWith(v)) === JSON.stringify(['P', 'N1', 'N2'])));
check('E2.missingIdIsOne', (() => {
  const m = Object.create(null); m.somethingElse = 0.4;
  return JSON.stringify(selWith(m)) === JSON.stringify(['P', 'N1', 'N2']);
})());
check('E3.invalidFactorsAllEffectiveOne', (() => {
  const bad = [NaN, Infinity, -Infinity, '0.4', null, {}, 0, -0.1, 1.01, [], true, undefined];
  return bad.every(v => JSON.stringify(selWith(mapOf(v))) === JSON.stringify(['P', 'N1', 'N2']));
})(), bad => String(bad));
check('E4.legalFactorsApply', [0.4, 0.7, 1].every(f =>
  JSON.stringify(selWith(mapOf(f))) === (f === 1 ? JSON.stringify(['P', 'N1', 'N2']) : JSON.stringify(['N1', 'N2', 'P']))));
check('E5.prototypeKeysAreSafe', (() => {
  const m = Object.create(null);
  m['__proto__'] = 0.4; m['constructor'] = 0.4; m['toString'] = 0.4; m['evil'] = 0.4;
  const out = CORE.buildMemoryContext(
    [mk({ id: '__proto__', importance: 10 }), mk({ id: 'constructor', importance: 9 }),
     mk({ id: 'toString', importance: 8 }), mk({ id: 'evil', importance: 7 })],
    Object.assign({}, B, { cooldownFactorsById: m }));
  return out.selected.length === 4;                    /* 全部合法 ⇒ 全部可选，无异常 */
})());
check('E5.objectPrototypeNotPolluted', ({}).evil === undefined
  && Object.prototype.evil === undefined && ({}).polluted === undefined);
check('E5.plainObjectMapWithProtoKeyIsSafe', (() => {
  const m = {}; m['__proto__'] = 0.4;                   /* 普通对象：__proto__ 赋值不产生 own key */
  return JSON.stringify(selWith(m)) === JSON.stringify(['P', 'N1', 'N2']);
})());
check('E6.absentFactorDoesNotChangeNoTurnOutput', (() => {
  const a = JSON.stringify(CORE.buildMemoryContext(R3, B));
  const b = JSON.stringify(CORE.buildMemoryContext(R3, Object.assign({}, B, { cooldownFactorsById: Object.create(null) })));
  return a === b;
})());

/* ── §6 pinned 结构回归 ── */
section('§6 · pinned structural regression');
{
  const withF = (f) => CORE.buildMemoryContext(R3, Object.assign({}, B, { cooldownFactorsById: mapOf(f) }));
  const base = withF(1), cooled = withF(0.4);
  check('P1.factorOneKeepsPinnedFirst', base.selected[0].id === 'P');
  check('P2.cooledPinnedLosesPinnedFirstPrivilege', cooled.selected[0].id !== 'P');
  check('P2.cooledPinnedUsesNonPinnedScoreSource',
    JSON.stringify(cooled.selected.map(s => s.id)) === JSON.stringify(['N1', 'N2', 'P']));
  check('P3.cooledPinnedStillInjectedNotHardGated', cooled.selected.some(s => s.id === 'P'));
  check('P3.countUnchanged', cooled.count === base.count);
  check('P4.originalRecordsNotMutated', (() => {
  const pRec = R3.filter(r => r.id === 'P')[0];
  const others = R3.filter(r => r.id !== 'P');
  return pRec.pinned === true && others.every(r => !r.pinned)
    && !Object.prototype.hasOwnProperty.call(others[0], 'pinned');
})(), 'the record must not be mutated nor gain a pinned flag');
  check('P5.cooledPinnedRecoversWhenFactorReturnsToOne',
    withF(1).selected[0].id === 'P');
  /* seat 身份：经真实 orchestrator + seat planner */
  const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
  const SS = require(path.join(ROOT, 'assets/js/memory-recall/recall-session-state.js'));
  const st = SS.createRecallSessionState();
  const turnA = {};
  st.beginBrowserTurn({ characterId: 'role_a', turnObject: turnA });
  st.recordExposure({ characterId: 'role_a', memoryIds: ['P'], turnIndex: 1 });
  const turnB = {};
  const idx = st.beginBrowserTurn({ characterId: 'role_a', turnObject: turnB });
  const o = ORCH.recall(R3, Object.assign({}, B, { maxChars: 700, userMessage: GATE_MSG, sessionState: st,
    turnIndex: idx, random: () => 0.5,
    turn: { message: GATE_MSG, conversationSignalAvailable: true, isFirstTurn: false, conversationId: 'dm:role_a' } }));
  const pRow = o.trace.candidates.filter(c => c.memoryId === 'P')[0];
  check('P6.seatIdentityStaysPinned', pRow && pRow.seat === 'pinned', pRow && pRow.seat);
  check('P6.traceFactorIsReal', pRow && pRow.cooldownFactor === 0.4, pRow && String(pRow.cooldownFactor));
  check('P6.pinnedSeatNotPrimary', pRow && pRow.seat !== 'primary');
}

/* ── §7 raw pinned relBoost / fatigue 语义（显式钉死） ── */
section('§7 · relaxed interpretation pinned');
{
  /* 造一个 relevance 可区分的输入：cooled pinned 的 relBoost 仍按 **raw pinned** = 1，
     即非 pinned 副本只替换 scoreSource，不改变 relBoost。 */
  const recs = [mk({ id: 'CP', pinned: true, title: 'ZZZ', content: 'zzz', importance: 10 }),
    mk({ id: 'RN', title: 'AAAA', content: 'AAAA', importance: 10 })];
  const out = CORE.buildMemoryContext(recs, Object.assign({}, B,
    { userMessage: 'AAAA', cooldownFactorsById: (() => { const m = Object.create(null); m.CP = 0.4; return m; })() }));
  /* 若 relBoost 改为按 effectivePinned（raw pinned=true 但 eff=false）计算，CP 会得到
     相关性加成；按 canonical 公式它必须仍为 1。用同 importance 的两条来分离该差异。 */
  const cp = out.selected.filter(s => s.id === 'CP')[0];
  const rn = out.selected.filter(s => s.id === 'RN')[0];
  check('cooledPinnedKeepsRawPinnedRelBoostAndFatigueSemantics',
    !!cp && !!rn && rn.score > cp.score,
    'CP.score=' + (cp && cp.score) + ' RN.score=' + (rn && rn.score));
  /* fatigue 同理：cooled pinned 仍**跳过** fatigue（raw pinned 语义）。 */
  const fat = [mk({ id: 'FP', pinned: true, importance: 10, activationCount: 99, lastActivated: NOW - 60000 }),
    mk({ id: 'FN', importance: 10, activationCount: 99, lastActivated: NOW - 60000 })];
  const fo = CORE.buildMemoryContext(fat, Object.assign({}, B,
    { cooldownFactorsById: (() => { const m = Object.create(null); m.FP = 0.4; m.FN = 0.4; return m; })() }));
  const fp = fo.selected.filter(s => s.id === 'FP')[0];
  const fn = fo.selected.filter(s => s.id === 'FN')[0];
  /* 两条**同等** cooled（都 ×0.4）⇒ factor 差异被消去，只剩 fatigue：
     FN 被 fatigue×0.7，FP（raw pinned）不被 fatigue ⇒ FP 必须更高。
     若有人把 fatigue 改按 effectivePinned 判定，这条会立刻变红。 */
  check('cooledPinnedStillSkipsFatigueByRawPinned', !!fp && !!fn && fp.score > fn.score,
    'FP.score=' + (fp && fp.score) + ' FN.score=' + (fn && fn.score));
}

/* ── §8 exploration interaction ── */
section('§8 · exploration interaction');
{
  /* 6 条大记录 / contentLen 200 / maxChars 700 —— 实测 main 恰好装 2 条，
     remaining = [f3,f4,f5,f6]（n=4），random=0.5 ⇒ idx 2 ⇒ f5。
     这是能把 「过滤前抽中 cooled」 与 「过滤后一次抽中」 区分开的形态。 */
  const FRESH = [10, 9, 8, 7, 6, 5].map((imp, i) => mk({ id: 'f' + (i + 1), title: 'AAAA',
    content: 'AAAA ' + 'x'.repeat(195), importance: imp }));
  const BIG = Object.assign({}, B, { contentLen: 200, maxChars: 700 });
  let calls = 0;
  const runSel = (cooledIds) => {
    calls = 0;
    const m = Object.create(null);
    (cooledIds || []).forEach(id => { m[id] = 0.4; });
    /* ⚠ map 必须喂给 rankMemoryCandidates：_cooldownFactor 是在 ranking 阶段算出来的，
       只传给 selectWithinBudget 会让过滤条件恒为 false，测试会因为
       '什么都没过滤' 而假绿。 */
    const rankedWithCd = CORE.rankMemoryCandidates(FRESH, Object.assign({}, BIG, { cooldownFactorsById: m }));
    return CORE.selectWithinBudget(rankedWithCd, Object.assign({}, BIG, {
      random: () => { calls++; return 0.5; }, includeSelectionMeta: true, cooldownFactorsById: m
    }));
  };
  const baseline = runSel([]);
  check('X0.baselineDomainReachesTail', (baseline.explorationIds || []).length === 1
    && baseline.explorationIds[0] === 'f5', JSON.stringify(baseline.explorationIds));
  const cooled = runSel(['f4']);
  check('X1.cooledExcludedFromExplorationDomain', (cooled.explorationIds || []).indexOf('f4') < 0,
    JSON.stringify(cooled.explorationIds));
  check('X2.randomCalledExactlyOnce', calls === 1, 'calls=' + calls);
  check('X3.samplingDomainIsFilteredPoolNotRetry',
    JSON.stringify(cooled.explorationIds) === JSON.stringify(['f5']),
    JSON.stringify(cooled.explorationIds));
  check('X3.reverseControlWithoutRankingMapFilterIsInert', (() => {
    /* 故意只把 map 给 selectWithinBudget：这必须**复现**未过滤行为，
       从而证明 X1/X2/X3 不是空断言。 */
    const m = Object.create(null); m.f4 = 0.4;
    let c2 = 0;
    const out = CORE.selectWithinBudget(CORE.rankMemoryCandidates(FRESH, BIG), Object.assign({}, BIG, {
      /* r=0.3：未过滤 pool n=4 ⇒ idx=floor(0.3*4)=1 ⇒ f4（正是被冷却那条）；
         过滤后 n=3 ⇒ idx=0 ⇒ f3。同一个 r 把两种实现分开。 */
      random: () => { c2++; return 0.3; }, includeSelectionMeta: true, cooldownFactorsById: m
    }));
    return (out.explorationIds || []).indexOf('f4') >= 0;
  })(), 'unfiltered pool must be able to pick the cooled id');
  check('X3.cooledStillAdmittedInCanonicalRanking',
    CORE.rankMemoryCandidates(FRESH, BIG).some(r => r.id === 'f4'));
  const noneEligible = runSel(['f3', 'f4', 'f5', 'f6']);
  check('X4.allCooledYieldsNoExploration', (noneEligible.explorationIds || []).length === 0,
    JSON.stringify(noneEligible.explorationIds));
  check('X5.allCooledMakesZeroRandomCalls', calls === 0, 'calls=' + calls);
  check('X5.allCooledMainSelectionPreserved', noneEligible.selected.length === 2,
    JSON.stringify(noneEligible.selected.map(x => x.id)));
  check('X6.cooledStillSelectableAsPrimary', (() => {
    const only = [mk({ id: 'solo', importance: 10 })];
    const m = Object.create(null); m.solo = 0.4;
    const o = CORE.buildMemoryContext(only, Object.assign({}, B, { cooldownFactorsById: m }));
    return o.selected.length === 1 && o.selected[0].id === 'solo';
  })());
check('X7.cooledStillRankedCanonically', (() => {
    const m = Object.create(null); m.f2 = 0.4;
    const o = CORE.buildMemoryContext(FRESH, Object.assign({}, B, { cooldownFactorsById: m, maxChars: 2000 }));
    return o.selected.length > 0;
  })());
}

console.log('\n' + '='.repeat(64));
if (failures) { console.error('MEMORY RECALL COOLDOWN FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
else console.log('MEMORY RECALL COOLDOWN PASSED · ' + passed + ' assertions green');
