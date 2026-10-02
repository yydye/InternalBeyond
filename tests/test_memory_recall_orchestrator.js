'use strict';
/* Internal Beyond · P21-R2-C · Orchestrator new-turn semantics（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_orchestrator.js

   被测：assets/js/memory-recall/memory-recall-orchestrator.js

   ── 本文件覆盖 C2：新语义（early exit / query / visibility / relevance / gate）──
      legacy 模式与 parity 由 test_memory_recall_legacy_parity.js 单独把关
      （那是 R2-C 的硬门，不在这里重复）。

   ── 注意 ─────────────────────────────────────────────────────────────
     turn mode 目前**只有测试直接调用**。production Host 在本轮结束时
     仍然不传 turn。见 test_memory_recall_wiring_guard.js 的 Host 断言。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));

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
function mem(over) {
  return Object.assign({
    id: 'm', title: 't', content: 'c', importance: 5, arousal: 0.3, resolved: false,
    activationCount: 0, created: NOW - DAY, lastActivated: NOW - DAY,
    visibility: 'public', tags: [], domain: '日常'
  }, over || {});
}
const BASE = {
  apiId: 'role_a', now: NOW, random: () => 0.42, userMessage: '',
  isGroup: false, groupMemEnabled: false, maxChars: 2000, contentLen: 200
};
const withTurn = (message, over) => Object.assign({}, BASE, over || {}, { turn: { message: message } });

/* ══════════════════════════════════════════════════════════════════════
   §A · legacy mode
   ══════════════════════════════════════════════════════════════════════ */
section('§A · legacy mode');

const recs = [mem({ id: 'a', title: '显卡', content: '显卡选购' })];
const leg = ORCH.recall(recs, Object.assign({}, BASE, { userMessage: '显卡' }));
check('A1.noTurnMeansLegacy', leg.meta.mode === 'legacy' && leg.meta.channel === 'legacy');
check('A2.legacyResultEqualsCore',
  JSON.stringify(leg.result) === JSON.stringify(CORE.buildMemoryContext(recs, Object.assign({}, BASE, { userMessage: '显卡' }))));
check('A3.legacyConsultedTrue', leg.meta.consulted === true);
check('A4.nullTurnIsLegacy', ORCH.recall(recs, Object.assign({}, BASE, { turn: null })).meta.mode === 'legacy');
check('A5.undefinedTurnIsLegacy', ORCH.recall(recs, Object.assign({}, BASE, { turn: undefined })).meta.mode === 'legacy');
check('A6.turnPresentMeansTurnMode', ORCH.recall(recs, withTurn('显卡')).meta.mode === 'turn');
check('A7.hostileOptionsDoesNotThrow', (() => {
  try {
    [null, undefined, 42, 'x', []].forEach(o => ORCH.recall(recs, o));
    return true;
  } catch (e) { return false; }
})(), 'hostile options must fall back to legacy rather than throw');
check('A8.hostileRecordsDoesNotThrow', (() => {
  try { [null, undefined, 42, 'x', {}].forEach(r => ORCH.recall(r, BASE)); return true; }
  catch (e) { return false; }
})());

/* ══════════════════════════════════════════════════════════════════════
   §B · early exit
   ══════════════════════════════════════════════════════════════════════ */
section('§B · early exit');

const ee = ORCH.recall(recs, withTurn('嗯'));
check('B1.acknowledgementEarlyExits', ee.result.reason === 'early-exit');
check('B2.earlyExitResultEmpty', ee.result.text === '' && ee.result.selected.length === 0
  && ee.result.count === 0 && ee.result.chars === 0);
check('B3.earlyExitConsultedFalse', ee.meta.consulted === false);
check('B4.earlyExitModeIsTurn', ee.meta.mode === 'turn');
check('B5.earlyExitNoCandidates', ee.trace.candidates.length === 0);
check('B6.earlyExitCountsZero', ee.trace.counts.gated === 0 && ee.trace.counts.selected === 0);
check('B7.emptyMessageEarlyExits', ORCH.recall(recs, withTurn('')).result.reason === 'early-exit');
check('B8.punctuationOnlyEarlyExits', ORCH.recall(recs, withTurn('...')).result.reason === 'early-exit');
check('B9.emojiOnlyEarlyExits', ORCH.recall(recs, withTurn('😂')).result.reason === 'early-exit');

/* early exit 必须**不执行** scoring / value / buildMemoryContext。 */
(function earlyExitSkipsWork() {
  let scoreCalls = 0, valueCalls = 0, coreCalls = 0, queryCalls = 0;
  const spy = ORCH.createOrchestrator({
    core: {
      buildMemoryContext: function (rows, o) { coreCalls++; return CORE.buildMemoryContext(rows, o); },
      getMemoryScore: CORE.getMemoryScore, calcRelevance: CORE.calcRelevance,
      DEFAULT_BUDGET_CHARS: CORE.DEFAULT_BUDGET_CHARS, DEFAULT_CONTENT_LEN: CORE.DEFAULT_CONTENT_LEN
    },
    scoring: {
      scoreRelevance: function () { scoreCalls++; return { score: 0, signals: {} }; },
      computeLegacyMemoryValue: function () { valueCalls++; return 0; },
      passesHardGate: function () { return false; }
    },
    query: {
      buildRecallQuery: function () { queryCalls++; return { lexicalTerms: [] }; }
    }
  });
  const out = spy.recall(recs, withTurn('嗯'));
  check('B10.earlyExitDoesNotScore', scoreCalls === 0, 'scoreCalls=' + scoreCalls);
  check('B11.earlyExitDoesNotComputeMemoryValue', valueCalls === 0, 'valueCalls=' + valueCalls);
  check('B12.earlyExitDoesNotCallCore', coreCalls === 0, 'coreCalls=' + coreCalls);
  check('B13.earlyExitDoesNotBuildQuery', queryCalls === 0, 'queryCalls=' + queryCalls);
  check('B14.earlyExitReasonStillCorrect', out.result.reason === 'early-exit');
})();

/* ══════════════════════════════════════════════════════════════════════
   §C · visibility
   ══════════════════════════════════════════════════════════════════════ */
section('§C · visibility');

(function visibility() {
  let scoreCalls = 0;
  const spy = ORCH.createOrchestrator({
    scoring: {
      scoreRelevance: function (m, q) {
        scoreCalls++;
        return require(path.join(ROOT, 'assets/js/memory-recall/scoring.js')).scoreRelevance(m, q);
      },
      computeLegacyMemoryValue: require(path.join(ROOT, 'assets/js/memory-recall/scoring.js')).computeLegacyMemoryValue,
      passesHardGate: require(path.join(ROOT, 'assets/js/memory-recall/scoring.js')).passesHardGate
    }
  });
  const rows = [
    mem({ id: 'vis', title: '显卡', content: '显卡' }),
    mem({ id: 'hid1', visibility: 'private', title: '显卡', content: '显卡' }),
    mem({ id: 'hid2', visibility: 'only', visibleTo: ['role_z'], title: '显卡', content: '显卡' }),
    mem({ id: 'hid3', visibility: 'except', excludeFrom: ['role_a'], title: '显卡', content: '显卡' })
  ];
  const out = spy.recall(rows, withTurn('显卡'));
  check('C1.hiddenNeverReachesScoring', scoreCalls === 1,
    'only the 1 visible record may be scored — scoreCalls=' + scoreCalls);
  check('C2.hiddenAbsentFromCandidates',
    out.trace.candidates.length === 1 && out.trace.candidates[0].memoryId === 'vis');
  check('C3.hiddenAbsentFromSerializedTrace',
    ['hid1', 'hid2', 'hid3'].every(id => JSON.stringify(out.trace).indexOf(id) < 0));
  check('C4.countsInputIncludesHidden', out.trace.counts.input === 4);
  check('C5.countsVisibleExcludesHidden', out.trace.counts.visible === 1);
})();

check('C6.noVisibleYieldsNoVisibleMemory', (() => {
  const out = ORCH.recall([mem({ id: 'p', visibility: 'private' })],
    withTurn('显卡'));
  return out.result.reason === 'no-visible-memory' && out.result.count === 0;
})(), 'ACL-emptied candidate set is no-visible-memory, NOT gate-rejected');
check('C6.noVisibleIsNotGateRejected',
  ORCH.recall([mem({ id: 'p', visibility: 'private' })], withTurn('显卡')).result.reason !== 'gate-rejected');
check('C6.noVisibleConsultedTrue',
  ORCH.recall([mem({ id: 'p', visibility: 'private' })], withTurn('显卡')).meta.consulted === true);
check('C7.visibilityUnavailableFailsClosed', (() => {
  const spy = ORCH.createOrchestrator({ visibility: null });
  const out = spy.recall([mem({ id: 'a' })], withTurn('显卡'));
  return out.result.reason === 'visibility-unavailable' && out.result.text === ''
    && out.result.count === 0 && out.result.selected.length === 0;
})(), 'missing ACL core must fail closed, never degrade to public');
check('C7.visibilityThrowsFailsClosed', (() => {
  const spy = ORCH.createOrchestrator({
    visibility: { isMemoryVisibleTo: function () { throw new Error('boom'); } }
  });
  const out = spy.recall([mem({ id: 'a' })], withTurn('显卡'));
  return out.result.reason === 'visibility-unavailable' && out.result.count === 0;
})());
check('C7.visibilityUnavailableConsultedFalse',
  ORCH.createOrchestrator({ visibility: null }).recall([mem({ id: 'a' })], withTurn('显卡')).meta.consulted === false);
check('C8.usesSharedAclPrimitive', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  /* 必须调用共享 primitive，且**不得**自带 public/only/except 判定。 */
  return /vis\.isMemoryVisibleTo\s*\(/.test(bare)
    && !/===\s*'private'/.test(bare) && !/===\s*'only'/.test(bare)
    && !/===\s*'except'/.test(bare) && !/===\s*'public'/.test(bare);
})(), 'orchestrator must delegate ACL to memory-visibility-core, never branch on visibility values');

/* ══════════════════════════════════════════════════════════════════════
   §D · Hard Gate
   ══════════════════════════════════════════════════════════════════════ */
section('§D · Hard Gate');

const unrelated = ORCH.recall([mem({ id: 'a', title: 'zzz', content: 'qqq' })], withTurn('完全无关的量子物理'));
check('D1.unrelatedVisibleMemoriesGateRejected', unrelated.result.reason === 'gate-rejected');
check('D2.gateRejectedCountZero', unrelated.result.count === 0 && unrelated.result.selected.length === 0
  && unrelated.result.text === '' && unrelated.result.chars === 0);
check('D3.gateRejectedConsultedTrue', unrelated.meta.consulted === true);
check('D4.candidateRecordedAsRejected',
  unrelated.trace.candidates.length === 1
  && unrelated.trace.candidates[0].decision === 'rejected'
  && unrelated.trace.candidates[0].reasons.indexOf('gate-rejected') >= 0);
check('D4.candidateRelevanceScoreIsZero', unrelated.trace.candidates[0].relevanceScore === 0);
/* P21-R2-C.1 · finalScore 诚实性：Hard Gate 仍然用 relevanceScore > 0（不变），
   但 finalScore **不再是**本层组合出来的数 —— selector 真实分数
   （getMemoryScore × relBoost × fatigue）在本层不可观察。 */
check('D4.finalScoreIsNull', unrelated.trace.candidates.every(c => c.finalScore === null),
  'finalScore must be null — not truthfully observable at this layer');
check('D4.finalScoreKeyKept',
  Object.prototype.hasOwnProperty.call(unrelated.trace.candidates[0], 'finalScore'),
  'the key stays (canonical shape) — only the value is null');
check('D5.relevantMemoryPassesGate',
  ORCH.recall([mem({ id: 'a', title: '显卡', content: '显卡' })], withTurn('显卡')).result.count === 1);
check('D5.gatePassedConsultedTrue',
  ORCH.recall([mem({ id: 'a', title: '显卡', content: '显卡' })], withTurn('显卡')).meta.consulted === true);

/* pinned 不特判：Contract §6.3 已冻结。 */
check('D6.pinnedIrrelevantIsGateRejected', (() => {
  const out = ORCH.recall([mem({ id: 'p', pinned: true, title: 'zzz', content: 'qqq' })], withTurn('完全无关'));
  return out.result.reason === 'gate-rejected' && out.result.count === 0;
})(), 'pinned + relevanceScore 0 must be rejected (no special case)');
check('D6.pinnedRelevantIsSelectedNormally', (() => {
  const out = ORCH.recall([mem({ id: 'p', pinned: true, title: '显卡', content: '显卡' })], withTurn('显卡'));
  return out.result.count === 1 && out.result.selected[0].id === 'p';
})(), 'pinned passes when relevanceScore > 0 and keeps legacy value 999');
check('D6.pinnedRelevantKeepsLegacyValue999', (() => {
  const out = ORCH.recall([mem({ id: 'p', pinned: true, title: '显卡', content: '显卡' })], withTurn('显卡'));
  const row = out.trace.candidates.find(c => c.memoryId === 'p');
  return row && row.memoryValue === 999;
})());
/* P21-R2-C.1：即使 memoryValue 与 relevanceScore 都非 null，
   finalScore 仍必须是 null —— 并且不得等于它们的乘积。 */
check('D6.finalScoreNullEvenWhenBothInputsPresent', (() => {
  const out = ORCH.recall([mem({ id: 'p', pinned: true, title: '显卡', content: '显卡' })], withTurn('显卡'));
  const row = out.trace.candidates.find(c => c.memoryId === 'p');
  return row && row.memoryValue !== null && row.relevanceScore !== null
    && row.finalScore === null
    && row.finalScore !== row.memoryValue * row.relevanceScore;
})(), 'finalScore must never be the locally fabricated memoryValue × relevanceScore');
check('D7.gateIsPurelyRelevanceBased', (() => {
  /* importance / arousal / activation 再高，只要 relevanceScore 为 0 就拒绝。 */
  const out = ORCH.recall([
    mem({ id: 'hi', importance: 10, arousal: 1, activationCount: 5000, title: 'zzz', content: 'qqq' })
  ], withTurn('完全无关'));
  return out.result.reason === 'gate-rejected';
})(), 'high memoryValue must not override the gate');
check('D8.emptyVisibleSetIsNotGateRejected', (() => {
  const out = ORCH.recall([], withTurn('显卡'));
  return out.result.reason === 'no-visible-memory';
})(), 'empty candidate set is no-visible-memory');

/* ══════════════════════════════════════════════════════════════════════
   §E · query
   ══════════════════════════════════════════════════════════════════════ */
section('§E · query construction');

(function query() {
  let captured = null;
  const Q = require(path.join(ROOT, 'assets/js/memory-recall/recall-query.js'));
  const spy = ORCH.createOrchestrator({
    query: {
      buildRecallQuery: function (msg, opts) { captured = { msg: msg, opts: opts }; return Q.buildRecallQuery(msg, opts); }
    }
  });
  const out = spy.recall([mem({ id: 'a', title: '地下室', content: '地下室' })],
    withTurn('你还记得《地下室》与 RTX 5070 Ti 在 2026年9月28日吗',
      { queryOptions: { aliases: [{ alias: '地下室', target: 'SECRET_TARGET' }] } }));
  check('E1.usesBuildRecallQuery', captured !== null && captured.msg.indexOf('地下室') >= 0);
  check('E1.forwardsQueryOptions', captured !== null && captured.opts
    && Array.isArray(captured.opts.aliases) && captured.opts.aliases.length === 1);
  check('E2.entitiesReachTrace', out.trace.query.entities.length > 0,
    JSON.stringify(out.trace.query.entities));
  check('E3.temporalHintsReachTrace', out.trace.query.temporalHints.length > 0,
    JSON.stringify(out.trace.query.temporalHints));
  check('E4.lexicalTermsReachTrace', out.trace.query.lexicalTerms.length > 0);
  check('E5.aliasTargetAbsentFromTrace',
    JSON.stringify(out.trace).indexOf('SECRET_TARGET') < 0);
  check('E5.aliasMatchedRecorded', out.trace.query.aliases.some(a => a.alias === '地下室' && a.matched === true));
  check('E6.doesNotRenormalize', (() => {
    /* orchestrator **不得**自行再 normalize 一遍：它必须把 turn.message 原样
       交给 buildRecallQuery。用一个带空格的原始串来证明没有被 trim 掉。 */
    let seenMsg = null;
    const spy2 = ORCH.createOrchestrator({
      query: { buildRecallQuery: function (m) { seenMsg = m; return { lexicalTerms: [] }; } }
    });
    spy2.recall([mem({ id: 'a' })], withTurn('  显卡  '));
    return seenMsg === '  显卡  ';
  })());
})();

/* ══════════════════════════════════════════════════════════════════════
   §F · 复用既有 core 的选择
   ══════════════════════════════════════════════════════════════════════ */
section('§F · 复用既有 core 的 selection');

(function reuse() {
  const rows = [
    mem({ id: 'a', title: '显卡', content: '显卡 A' }),
    mem({ id: 'b', title: '显卡', content: '显卡 B' }),
    mem({ id: 'x', title: 'zzz', content: 'qqq' })
  ];
  let coreRows = null, coreOpts = null;
  const spy = ORCH.createOrchestrator({
    core: {
      buildMemoryContext: function (r, o) { coreRows = r; coreOpts = o; return CORE.buildMemoryContext(r, o); },
      getMemoryScore: CORE.getMemoryScore, calcRelevance: CORE.calcRelevance,
      DEFAULT_BUDGET_CHARS: CORE.DEFAULT_BUDGET_CHARS, DEFAULT_CONTENT_LEN: CORE.DEFAULT_CONTENT_LEN
    }
  });
  const out = spy.recall(rows, withTurn('显卡'));
  check('F1.coreCalledOnceWithGatedRecords', coreRows !== null && coreRows.length === 2,
    'core must receive only the 2 gated records, got ' + (coreRows ? coreRows.length : 'null'));
  check('F1.gatedRecordsAreOriginalObjects',
    coreRows !== null && coreRows[0] === rows[0] && coreRows[1] === rows[1],
    'gated records must be the ORIGINAL objects (no cloning)');
  check('F2.optionsForwardedToCoreIntact',
    coreOpts !== null && coreOpts.apiId === 'role_a' && coreOpts.maxChars === 2000
    && coreOpts.contentLen === 200 && coreOpts.now === NOW && coreOpts.random === BASE.random);
  check('F2b.coreGetsTurnMessageAsUserMessage', coreOpts !== null && coreOpts.userMessage === '显卡',
    'gate and selection must use the SAME relevance input — otherwise a memory can pass ' +
    'the gate under one relevance and be ranked under another');
  check('F3.noTurnLeakedIntoCoreOptions', coreOpts !== null
    && !Object.prototype.hasOwnProperty.call(coreOpts, 'turn'),
    'turn is an orchestration input, not a core semantic');
  /* 渲染与 gate 后候选一致：把 gated 集合直接喂给 core，结果必须逐字节相同。 */
  const direct = CORE.buildMemoryContext([rows[0], rows[1]],
    Object.assign({}, BASE, { userMessage: '显卡' }));
  check('F4.resultMatchesDirectCoreOnGatedSet',
    JSON.stringify(out.result) === JSON.stringify(direct), JSON.stringify({ got: out.result, direct: direct }));
})();

check('F5.doesNotMutateRecords', (() => {
  const rows = [mem({ id: 'a', title: '显卡', content: '显卡' }), mem({ id: 'b', visibility: 'private' })];
  const snap = JSON.stringify(rows);
  ORCH.recall(rows, withTurn('显卡'));
  return JSON.stringify(rows) === snap;
})());
check('F6.worksWithFrozenInput', (() => {
  const rows = [Object.freeze(mem({ id: 'a', title: '显卡', content: '显卡' }))];
  const opts = Object.freeze(Object.assign({}, BASE, { turn: Object.freeze({ message: '显卡' }) }));
  try {
    const out = ORCH.recall(rows, opts);
    return out.result.count === 1;
  } catch (e) { return false; }
})(), 'orchestrator must not attempt to write into caller-owned records/options');
check('F7.doesNotWriteActivation', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return !/activationCount\s*=/.test(bare) && !/recordMemoryActivation/.test(bare)
    && !/lastActivated\s*=/.test(bare);
})(), 'selection ≠ reinforcement: the orchestrator must not persist activation');
check('F8.noPersistenceAtAll', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return !/\bdbPut\b|\bdbGet\b|localStorage|sessionStorage|indexedDB|\bfetch\s*\(/.test(bare);
})());

/* ══════════════════════════════════════════════════════════════════════
   §G · 确定性 / 纯函数 / 结果形状
   ══════════════════════════════════════════════════════════════════════ */
section('§G · 确定性与形状');

check('G1.repeatedCallsDeepEqual', (() => {
  const rows = [mem({ id: 'a', title: '显卡', content: '显卡' })];
  const opts = withTurn('显卡');
  const first = JSON.stringify(ORCH.recall(rows, opts));
  for (let i = 0; i < 100; i++) if (JSON.stringify(ORCH.recall(rows, opts)) !== first) return false;
  return true;
})());
check('G2.traceNotInsideResult', (() => {
  const out = ORCH.recall([mem({ id: 'a', title: '显卡', content: '显卡' })], withTurn('显卡'));
  return !('trace' in out.result) && !('meta' in out.result);
})(), 'result must keep the existing Memory result shape exactly');
check('G3.resultKeysClosed', (() => {
  const out = ORCH.recall([mem({ id: 'a', title: '显卡', content: '显卡' })], withTurn('显卡'));
  const expected = ['text', 'selected', 'count', 'chars', 'reason'].sort();
  return JSON.stringify(Object.keys(out.result).sort()) === JSON.stringify(expected);
})());
check('G4.envelopeKeysClosed', (() => {
  const out = ORCH.recall([mem({ id: 'a' })], BASE);
  const expected = ['result', 'trace', 'meta'].sort();
  return JSON.stringify(Object.keys(out).sort()) === JSON.stringify(expected);
})());
check('G5.metaKeysClosed', (() => {
  /* legacy 与 turn 两种模式各自有固定的 meta 键集（R2-D 为 turn 模式
     新增 turnUsable / channelSupported 等**如实报告**字段）。 */
  const legacyKeys = ['mode', 'consulted', 'channel', 'turnUsable'].sort();
  /* R2-E1b：meta 新增 activationPolicy（§19 —— 只在这里暴露，不扩 result）。 */
  const turnKeys = ['mode', 'consulted', 'channel', 'turnUsable', 'decisionSource',
    'channelSupported', 'channelImplemented', 'channelUnsupportedReason', 'earlyExitReason',
    /* R2-F1b：meta 新增 injectedMemoryIds —— **内部 seam**，供调用方在 success seam
     写 exposure（final post-seat injected ids）。它只在 meta 上，result 键集不变。 */
  'activationPolicy', 'injectedMemoryIds'].sort();
  const legacy = ORCH.recall([mem({ id: 'a' })], BASE);
  const turn = ORCH.recall([mem({ id: 'a', title: '显卡', content: '显卡' })], withTurn('显卡'));
  const lk = Object.keys(legacy.meta).sort();
  const tk = Object.keys(turn.meta).sort();
  return lk.every(k => legacyKeys.indexOf(k) >= 0) && tk.every(k => turnKeys.indexOf(k) >= 0)
    && lk.indexOf('mode') >= 0 && lk.indexOf('consulted') >= 0 && lk.indexOf('channel') >= 0;
})(), 'meta keys must stay within the documented set for each mode');
check('G6.modeVocabularyClosed',
  ['legacy', 'turn'].indexOf(ORCH.recall([mem({ id: 'a' })], BASE).meta.mode) >= 0
  && ['legacy', 'turn'].indexOf(ORCH.recall([mem({ id: 'a' })], withTurn('显卡')).meta.mode) >= 0);
check('G7.dependenciesAreInjectedNotHostImports', (() => {
  /* orchestrator 只允许 require 它的**同层/下层**依赖（共享 core 与自己的兄弟模块）；
     不得 require Host 层文件（memory.js / communication.js / home-node/*）。 */
  /* 先剥注释：模块头部的文档块里**举例**写了 require(...)，
     裸正则会把"文档在描述依赖"误判成"代码在 require"。 */
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const reqs = (src.match(/require\s*\(\s*'([^']+)'\s*\)/g) || []).map(s => s.slice(s.indexOf("'") + 1, s.lastIndexOf("'")));
  /* R2-E1b：新增 glossary-catalog / glossary-match / coldstart-anchor 三个 sibling。 */
  const allowed = ['../memory-retrieval-core.js', '../memory-visibility-core.js',
  './recall-query.js', './scoring.js', './channel-policy.js', './seat-planner.js', './recall-trace.js',
  './turn-signal.js', './glossary-catalog.js', './glossary-match.js', './coldstart-anchor.js',
  /* R2-F1b：cooldown 纯策略模块（state 由调用方注入，orchestrator 只 require 策略）。 */
  './cooldown.js'];
  return reqs.length > 0 && reqs.every(r => allowed.indexOf(r) >= 0);
})(), 'the orchestrator may only depend on the shared core and its sibling recall modules');
check('G7b.noHostOrReverseDependency', (() => {
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  /* R2-D 起 channel-policy / seat-planner 已实现并被依赖；
     cooldown 仍属 R2-F，不得出现。 */
  /* R2-F1b：cooldown 已实现并被合法依赖 ⇒ 从禁用表移除；Host 层依旧禁止。 */
  return !/communication\.js|home-node|memory\.js|active-diary/.test(bare);
})(), 'no Host import and no reverse dependency (cooldown is a legitimate sibling as of R2-F1b)');
check('G8.coreMissingFailsOpenNotThrows', (() => {
  const spy = ORCH.createOrchestrator({ core: null });
  const out = spy.recall([mem({ id: 'a' })], BASE);
  return out.result.reason === 'visibility-unavailable' && out.result.text === '';
})(), 'a missing core must produce an empty block, never an exception');
check('G9.coreMissingTurnModeAlsoFailsOpen', (() => {
  const spy = ORCH.createOrchestrator({ core: null });
  const out = spy.recall([mem({ id: 'a' })], withTurn('显卡'));
  return out.result.text === '' && out.result.count === 0;
})());

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL ORCHESTRATOR FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL ORCHESTRATOR PASSED · ' + passed + ' assertions green');
}
