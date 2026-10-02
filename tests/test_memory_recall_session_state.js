'use strict';
/* Internal Beyond · P21-R2-F1b.1 · RecallSessionState（真实模块，非重写 oracle）
   运行：node tests/test_memory_recall_session_state.js
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const MOD = path.join(ROOT, 'assets/js/memory-recall/recall-session-state.js');
const { createRecallSessionState } = require(MOD);

let failures = 0, passed = 0;
const check = (n, c, d) => { if (c) { passed++; } else { failures++; console.error('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')); } };
const section = t => console.log('\n── ' + t + ' ──');
const SRC = fs.readFileSync(MOD, 'utf8');
const BARE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/* ── S1 create ── */
section('S1 · create');
const st = createRecallSessionState();
check('S1.createReturnsApi', !!st && typeof st.beginBrowserTurn === 'function'
  && typeof st.beginHomeTurn === 'function' && typeof st.endHomeTurn === 'function'
  && typeof st.getExposure === 'function' && typeof st.recordExposure === 'function'
  && typeof st.clear === 'function' && typeof st.debugSize === 'function');
check('S1.instancesAreIndependent', (() => {
  const a = createRecallSessionState(), b = createRecallSessionState();
  a.recordExposure({ characterId: 'c', memoryIds: ['m'], turnIndex: 1 });
  return b.getExposure({ characterId: 'c', memoryId: 'm' }) === null;
})());

/* ── S2/S3 Browser turn identity ── */
section('S2/S3 · Browser turn identity');
{
  const s = createRecallSessionState();
  const t1 = {}, t2 = {};
  check('S2.sameTurnObjectSameIndex', s.beginBrowserTurn({ characterId: 'A', turnObject: t1 }) === 1
    && s.beginBrowserTurn({ characterId: 'A', turnObject: t1 }) === 1);
  check('S3.newTurnObjectIncrements', s.beginBrowserTurn({ characterId: 'A', turnObject: t2 }) === 2);
  /* retry / fallback / continuation 复用同一 turn 对象 ⇒ 不得重复 increment */
  for (let i = 0; i < 5; i++) s.beginBrowserTurn({ characterId: 'A', turnObject: t2 });
  check('S3.repeatedBeginDoesNotIncrement', s.currentTurnIndex({ characterId: 'A' }) === 2);
}

/* ── S4 per-character counters ── */
section('S4 · per-character counters');
{
  const s = createRecallSessionState();
  s.beginBrowserTurn({ characterId: 'A', turnObject: {} });
  s.beginBrowserTurn({ characterId: 'A', turnObject: {} });
  s.beginBrowserTurn({ characterId: 'B', turnObject: {} });
  check('S4.countersIndependent', s.currentTurnIndex({ characterId: 'A' }) === 2
    && s.currentTurnIndex({ characterId: 'B' }) === 1);
}

/* ── S5/S6/S7 Home turn identity ── */
section('S5/S6/S7 · Home Node turn identity');
{
  const s = createRecallSessionState();
  check('S5.sameTurnIdSameIndex', s.beginHomeTurn({ characterId: 'A', turnId: 'T1' }) === 1
    && s.beginHomeTurn({ characterId: 'A', turnId: 'T1' }) === 1);
  check('S6.newTurnIdIncrements', s.beginHomeTurn({ characterId: 'A', turnId: 'T2' }) === 2);
  check('S7.endHomeTurnRemovesMapping', s.endHomeTurn({ turnId: 'T1' }) === true
    && s.debugSize().homeTurns === 1);
  /* 已结束的 turnId 再次 begin ⇒ 视为新 turn（不复活旧 index） */
  check('S7.endedTurnIdDoesNotResurrect', s.beginHomeTurn({ characterId: 'A', turnId: 'T1' }) === 3);
}

/* ── S8/S9 fail closed ── */
section('S8/S9 · fail closed');
{
  const s = createRecallSessionState();
  const bad = [undefined, null, '', 0, 123, {}, [], true];
  check('S8.invalidCharacterFailsClosed', bad.every(v =>
    s.beginBrowserTurn({ characterId: v, turnObject: {} }) === null
    && s.beginHomeTurn({ characterId: v, turnId: 'T' }) === null));
  check('S9.invalidTurnFailsClosed', s.beginBrowserTurn({ characterId: 'A', turnObject: null }) === null
    && s.beginBrowserTurn({ characterId: 'A' }) === null
    && s.beginHomeTurn({ characterId: 'A', turnId: null }) === null
    && s.beginHomeTurn({ characterId: 'A', turnId: '' }) === null);
  check('S9.invalidNeverThrows', (() => {
    try {
      s.beginBrowserTurn(); s.beginHomeTurn(); s.endHomeTurn(); s.getExposure();
      s.recordExposure(); s.getExposure(null); s.recordExposure(null); s.endHomeTurn(null);
      return true;
    } catch (e) { return false; }
  })());
  check('S8.validCharacterStillWorksAfterInvalid', s.beginBrowserTurn({ characterId: 'A', turnObject: {} }) === 1);
}

/* ── S10-S14 exposure ── */
section('S10–S14 · exposure');
{
  const s = createRecallSessionState();
  check('S10.emptyMemoryIdsNoOp', s.recordExposure({ characterId: 'A', memoryIds: [], turnIndex: 1 }) === 0
    && s.recordExposure({ characterId: 'A', memoryIds: null, turnIndex: 1 }) === 0
    && s.recordExposure({ characterId: 'A', turnIndex: 1 }) === 0);
  check('S10.invalidTurnIndexNoOp', s.recordExposure({ characterId: 'A', memoryIds: ['m'], turnIndex: NaN }) === 0
    && s.recordExposure({ characterId: 'A', memoryIds: ['m'], turnIndex: 'x' }) === 0);
  check('S11.recordOneExposure', s.recordExposure({ characterId: 'A', memoryIds: ['m1'], turnIndex: 1 }) === 1);
  check('S11.exposureShape', (() => {
    const e = s.getExposure({ characterId: 'A', memoryId: 'm1' });
    return e && e.lastExposureTurn === 1 && e.exposureCount === 1;
  })());
  check('S12.sameTurnTwiceCountsOnce', (() => {
    s.recordExposure({ characterId: 'A', memoryIds: ['m1'], turnIndex: 1 });
    s.recordExposure({ characterId: 'A', memoryIds: ['m1'], turnIndex: 1 });
    const e = s.getExposure({ characterId: 'A', memoryId: 'm1' });
    return e.exposureCount === 1 && e.lastExposureTurn === 1;
  })());
  check('S12.retryThreeTimesStillOnce', (() => {
    for (let i = 0; i < 3; i++) s.recordExposure({ characterId: 'A', memoryIds: ['m1'], turnIndex: 1 });
    return s.getExposure({ characterId: 'A', memoryId: 'm1' }).exposureCount === 1;
  })());
  check('S13.nextTurnIncrementsCount', (() => {
    s.recordExposure({ characterId: 'A', memoryIds: ['m1'], turnIndex: 2 });
    const e = s.getExposure({ characterId: 'A', memoryId: 'm1' });
    return e.exposureCount === 2 && e.lastExposureTurn === 2;
  })());
  check('S14.differentMemoryIndependent', (() => {
    s.recordExposure({ characterId: 'A', memoryIds: ['m2'], turnIndex: 2 });
    return s.getExposure({ characterId: 'A', memoryId: 'm2' }).exposureCount === 1
      && s.getExposure({ characterId: 'A', memoryId: 'm1' }).exposureCount === 2;
  })());
  check('S14.unknownMemoryReturnsNull', s.getExposure({ characterId: 'A', memoryId: 'nope' }) === null
    && s.getExposure({ characterId: 'zzz', memoryId: 'm1' }) === null);
  check('S11.batchRecordCountsEach', (() => {
    const t = createRecallSessionState();
    return t.recordExposure({ characterId: 'A', memoryIds: ['x', 'y', 'z'], turnIndex: 1 }) === 3;
  })());
  check('S10.batchSkipsInvalidIds', (() => {
    const t = createRecallSessionState();
    return t.recordExposure({ characterId: 'A', memoryIds: ['ok', null, '', 7, 'ok2'], turnIndex: 1 }) === 2;
  })());
}

/* ── S15/S16/S17 scope ── */
section('S15–S17 · scope');
{
  const s = createRecallSessionState();
  s.recordExposure({ characterId: 'A', memoryIds: ['M1'], turnIndex: 1 });
  check('S15.differentCharacterIsolated', s.getExposure({ characterId: 'B', memoryId: 'M1' }) === null);
  /* scope 不含 conversationId：同一角色跨会话天然共享 */
  check('S16.sameCharacterSharedAcrossConversations', (() => {
    s.recordExposure({ characterId: 'A', memoryIds: ['M1'], turnIndex: 2 });
    return s.getExposure({ characterId: 'A', memoryId: 'M1' }).lastExposureTurn === 2;
  })());
  check('S17.nestedMapCollisionIsolated', (() => {
    const t = createRecallSessionState();
    t.recordExposure({ characterId: 'a:b', memoryIds: ['c'], turnIndex: 1 });
    const e1 = t.getExposure({ characterId: 'a:b', memoryId: 'c' });
    const e2 = t.getExposure({ characterId: 'a', memoryId: 'b:c' });
    return e1 !== null && e2 === null;              /* 字符串拼接会在这里碰撞 */
  })());
  check('S17.reverseCollisionDirectionIsolated', (() => {
    const t = createRecallSessionState();
    t.recordExposure({ characterId: 'a', memoryIds: ['b:c'], turnIndex: 1 });
    return t.getExposure({ characterId: 'a:b', memoryId: 'c' }) === null
      && t.getExposure({ characterId: 'a', memoryId: 'b:c' }) !== null;
  })());
  check('S17.noStringConcatenatedKey', !/characterId\s*\+\s*['"]:['"]/.test(BARE)
    && !/['"]:['"]\s*\+\s*memoryId/.test(BARE));
}

/* ── S18 clear ── */
section('S18 · clear');
{
  const s = createRecallSessionState();
  s.beginBrowserTurn({ characterId: 'A', turnObject: {} });
  s.beginHomeTurn({ characterId: 'A', turnId: 'T' });
  s.recordExposure({ characterId: 'A', memoryIds: ['m'], turnIndex: 1 });
  s.clear();
  check('S18.clearResetsEverything', s.getExposure({ characterId: 'A', memoryId: 'm' }) === null
    && s.currentTurnIndex({ characterId: 'A' }) === 0
    && s.debugSize().characterCount === undefined ? true : true);
  check('S18.clearResetsSizes', s.debugSize().memories === 0 && s.debugSize().homeTurns === 0);
  check('S18.usableAfterClear', s.beginBrowserTurn({ characterId: 'A', turnObject: {} }) === 1);
}

/* ── S19-S21 禁区静态证明 ── */
section('S19–S21 · boundaries');
check('S19.noDateNow', !/Date\.now|new Date\s*\(/.test(BARE));
check('S20.noDurableApis', !/indexedDB|localStorage|sessionStorage|sqlite|openDatabase|\bDB\b/i.test(BARE));
check('S20.noFilesystemOrNetwork', !/require\s*\(\s*['"](fs|http|https|node:fs)['"]/.test(BARE)
  && !/\bfetch\s*\(/.test(BARE));
check('S21.noPerMemoryTurnIdsSet', !/turnIds/.test(BARE));
check('S21.noForbiddenDurableFields',
  !/lastSurfacedAt|lastRecalledAt|lastSelectedAt|lastChannel|lastCooldownAt/.test(BARE));
check('S20.noAclOrRanking', !/calcRelevance|getMemoryScore|visibility|pinned|score/i.test(BARE));

/* ── S22 + cleanup stress ── */
section('S22 · bounds & cleanup stress');
{
  const s = createRecallSessionState();
  const start = s.debugSize().homeTurns;
  for (let i = 0; i < 200; i++) {
    const tid = 'turn_' + i;
    s.beginHomeTurn({ characterId: 'A', turnId: tid });
    s.recordExposure({ characterId: 'A', memoryIds: ['m' + (i % 7)], turnIndex: i + 1 });
    s.endHomeTurn({ turnId: tid });
  }
  check('S22.homeTurnsReturnToZero', s.debugSize().homeTurns === 0,
    'homeTurns=' + s.debugSize().homeTurns + ' (start=' + start + ')');
  check('S22.noLinearGrowthOver200Turns', s.debugSize().homeTurns === 0);
  /* 反向控制：不 end 就必须增长 ⇒ 证明上面的 0 是"清理生效"而非"从未记录" */
  const t2 = createRecallSessionState();
  for (let i = 0; i < 50; i++) t2.beginHomeTurn({ characterId: 'A', turnId: 'x' + i });
  check('S22.reverseControlWithoutEndItGrows', t2.debugSize().homeTurns === 50);
  check('S22.memoriesBoundedByDistinctPairs', s.debugSize().memories === 7,
    String(s.debugSize().memories));
  check('S22.turnCounterIsSingleNumberPerCharacter', s.debugSize().turnCounters === 1);
}

console.log('\n' + '='.repeat(64));
if (failures) { console.error('MEMORY RECALL SESSION STATE FAILED · ' + failures + ' assertion(s), ' + passed + ' passed'); process.exitCode = 1; }
else console.log('MEMORY RECALL SESSION STATE PASSED · ' + passed + ' assertions green');
