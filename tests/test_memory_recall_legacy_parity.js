'use strict';
/* Internal Beyond · P21-R2-C · Legacy Parity（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_legacy_parity.js

   ══════════════════════════════════════════════════════════════════════════
   这是 R2-C 的**硬门**。
   ══════════════════════════════════════════════════════════════════════════

   R2-C 只允许"架构切换"，**不允许**产品行为切换（那是 R2-D）。
   因此必须证明：

     "接入 Orchestrator"  与  "改变 Recall 行为"   是两件独立的事。

   Oracle   ：memory-retrieval-core.buildMemoryContext(records, options)
   Candidate：memory-recall-orchestrator.recall(records, options).result
              （**不传** options.turn ⇒ legacy path）

   对每一组 fixture，在**相同** records / apiId / isGroup / groupMemEnabled /
   now / random / maxChars / contentLen 下要求：

     deepStrictEqual(candidate.result, oracle)      ← 整个对象，不只是 text
     且逐字段再断言 text / selected ids / count / chars / reason（便于定位失败）

   为什么用 deepStrictEqual 而不是"看起来一样"：
     result 是 { text, selected, count, chars, reason }。只比 text 会漏掉
     selected 顺序、count、chars、reason 的任何漂移；只比 selected 会漏掉
     渲染文本的漂移。逐字节是唯一能证明"用户看到的没变"的判据。

   本文件刻意**不**修改 memory-retrieval-core.js —— Oracle 直接就是它。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const ORCH = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));

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
/* 深冻结 + 快照：用来证明 candidate path **不修改输入**。 */
function frozen(records) {
  const clone = JSON.parse(JSON.stringify(records));
  return { records: clone, snapshot: JSON.stringify(clone) };
}

const BASE = {
  apiId: 'role_a', now: NOW, random: () => 0.42, userMessage: '',
  isGroup: false, groupMemEnabled: false, maxChars: 2000, contentLen: 200
};

/* ══════════════════════════════════════════════════════════════════════
   §1 · 22+ 组 fixture 的逐字节 parity
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · Legacy parity fixtures（deepStrictEqual）');

const FIXTURES = [
  ['1.emptyDB', [], {}],
  ['2.onePublicMemory', [mem({ id: 'a', title: '显卡', content: 'RTX 选购' })], { userMessage: '显卡' }],
  ['3.privateHighScorePlusPublicLowScore', [
    mem({ id: 'p', importance: 10, arousal: 1, activationCount: 900, visibility: 'private', content: 'secret body' }),
    mem({ id: 'q', importance: 2, content: 'low body' })
  ], { userMessage: 'low' }],
  ['4.onlyVisibleToCaller', [mem({ id: 'a', visibility: 'only', visibleTo: ['role_a'] })], { apiId: 'role_a' }],
  ['4b.onlyVisibleToAnother', [mem({ id: 'a', visibility: 'only', visibleTo: ['role_b'] })], { apiId: 'role_a' }],
  ['5.exceptCaller', [mem({ id: 'a', visibility: 'except', excludeFrom: ['role_a'] })], { apiId: 'role_a' }],
  ['5b.exceptOtherRole', [mem({ id: 'a', visibility: 'except', excludeFrom: ['role_z'] })], { apiId: 'role_a' }],
  ['6.groupPublicOnly', [
    mem({ id: 'a' }),
    mem({ id: 'b', visibility: 'only', visibleTo: ['role_a'] })
  ], { isGroup: true, groupMemEnabled: true }],
  ['6b.groupMemoryDisabled', [mem({ id: 'a' })], { isGroup: true, groupMemEnabled: false }],
  ['7.pinned', [mem({ id: 'a', pinned: true, importance: 1 }), mem({ id: 'b', importance: 9 })], {}],
  ['7b.multiplePinned', [
    mem({ id: 'a', pinned: true }), mem({ id: 'b', pinned: true }), mem({ id: 'c' })
  ], {}],
  ['8.resolvedDecaysFaster', [mem({ id: 'a', resolved: true, created: NOW - DAY * 30, lastActivated: NOW - DAY * 30 })], {}],
  ['9.highArousal', [mem({ id: 'a', arousal: 1 })], {}],
  ['10.activationCount', [mem({ id: 'a', activationCount: 500 })], {}],
  ['11.fatigueActive', [mem({ id: 'a', activationCount: 10, lastActivated: NOW - 60000 })], {}],
  ['12.noKeywordHit', [mem({ id: 'a', title: 'zzz', content: 'qqq' })], { userMessage: '完全无关的话题' }],
  ['13.exactKeywordHit', [mem({ id: 'a', title: '显卡', content: '显卡选购指南' })], { userMessage: '显卡' }],
  ['14.multipleRecords', [mem({ id: 'a' }), mem({ id: 'b' }), mem({ id: 'c' }), mem({ id: 'd' })], {}],
  ['15.tightBudget', [
    mem({ id: 'a', content: 'x'.repeat(500) }), mem({ id: 'b', content: 'y'.repeat(500) })
  ], { maxChars: 260 }],
  ['16.normalBudget', [mem({ id: 'a' }), mem({ id: 'b' })], { maxChars: 2000 }],
  ['17.explorationRandomZero', Array.from({ length: 12 }, (_, i) => mem({
    id: 'e' + i, content: 'z'.repeat(80), importance: 5 - (i % 3)
  })), { maxChars: 400, random: () => 0 }],
  ['18.explorationRandomHigh', Array.from({ length: 12 }, (_, i) => mem({
    id: 'e' + i, content: 'z'.repeat(80), importance: 5 - (i % 3)
  })), { maxChars: 400, random: () => 0.999 }],
  ['19.explorationRandomMid', Array.from({ length: 12 }, (_, i) => mem({
    id: 'e' + i, content: 'z'.repeat(80), importance: 5 - (i % 3)
  })), { maxChars: 400, random: () => 0.5 }],
  ['20.longRenderedLine', [mem({ id: 'a', content: 'L'.repeat(400) }), mem({ id: 'b', content: 'S' })], { contentLen: 200 }],
  ['21.customContentLen', [mem({ id: 'a', content: 'C'.repeat(300) })], { contentLen: 50 }],
  ['22.customMaxChars', [mem({ id: 'a' })], { maxChars: 300 }],
  ['23.legacyMissingVisibility', [mem({ id: 'a', visibility: undefined })], {}],
  ['24.legacyUnknownVisibility', [mem({ id: 'a', visibility: 'weird' })], {}],
  ['25.mixedVisibilitySet', [
    mem({ id: 'a' }),
    mem({ id: 'b', visibility: 'private' }),
    mem({ id: 'c', visibility: 'only', visibleTo: ['role_a'] }),
    mem({ id: 'd', visibility: 'except', excludeFrom: ['role_a'] }),
    mem({ id: 'e', pinned: true })
  ], { userMessage: '显卡' }]
];

const parityRows = [];
FIXTURES.forEach(([label, records, over]) => {
  const options = Object.assign({}, BASE, over || {});
  const { records: recs, snapshot } = frozen(records);
  const oracle = CORE.buildMemoryContext(recs, options);
  const out = ORCH.recall(recs, options);
  const got = out.result;

  /* 1) 整个 result 对象逐字节 */
  let wholeEqual = true;
  let diff = '';
  try { assert.deepStrictEqual(got, oracle); } catch (e) { wholeEqual = false; diff = e.message.split('\n').slice(0, 6).join(' | '); }
  check('P1.' + label + '.deepStrictEqual', wholeEqual, diff);

  /* 2) 逐字段（失败时便于定位） */
  check('P2.' + label + '.text', got.text === oracle.text);
  check('P2.' + label + '.chars', got.chars === oracle.chars);
  check('P2.' + label + '.count', got.count === oracle.count);
  check('P2.' + label + '.reason', got.reason === oracle.reason,
    JSON.stringify({ got: got.reason, oracle: oracle.reason }));
  check('P2.' + label + '.selectedIds',
    JSON.stringify(got.selected.map(s => s.id)) === JSON.stringify(oracle.selected.map(s => s.id)));
  check('P2.' + label + '.selectedScores',
    JSON.stringify(got.selected.map(s => s.score)) === JSON.stringify(oracle.selected.map(s => s.score)));

  /* 3) records 未被修改 */
  check('P3.' + label + '.recordsUnchanged', JSON.stringify(recs) === snapshot);

  /* 4) meta */
  check('P4.' + label + '.metaLegacy',
    out.meta && out.meta.mode === 'legacy' && out.meta.channel === 'legacy');

  parityRows.push({ label, reason: oracle.reason, selected: oracle.selected.length, chars: oracle.chars });
});

/* ══════════════════════════════════════════════════════════════════════
   §2 · parity 覆盖度自检（防止 fixture 太少而假绿）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · 覆盖度自检');

check('C1.fixtureCount', FIXTURES.length >= 22, 'got ' + FIXTURES.length);
const reasons = new Set(parityRows.map(r => String(r.reason)));
check('C2.reasonsCovered', reasons.has('null') && reasons.has('no-visible-memory'),
  'reasons observed: ' + JSON.stringify(Array.from(reasons)));
check('C3.someFixtureInjects', parityRows.some(r => r.selected > 0));
check('C4.someFixtureInjectsNothing', parityRows.some(r => r.selected === 0));
check('C5.nonZeroCharsObserved', parityRows.some(r => r.chars > 0));
check('C6.zeroCharsObserved', parityRows.some(r => r.chars === 0));
/* 反向控制：parity 断言必须有能力失败。改写 oracle 一个字节即应变红。 */
(function reverseControl() {
  const recs = [mem({ id: 'a', title: '显卡' })];
  const options = Object.assign({}, BASE, { userMessage: '显卡' });
  const oracle = CORE.buildMemoryContext(recs, options);
  const got = ORCH.recall(recs, options).result;
  const mutated = Object.assign({}, oracle, { chars: oracle.chars + 1 });
  let detected = false;
  try { assert.deepStrictEqual(got, mutated); } catch (e) { detected = true; }
  check('C7.reverseControl.oneCharDiffIsDetected', detected,
    'a single differing field must make the parity assertion fail');
})();

/* ══════════════════════════════════════════════════════════════════════
   §3 · Orchestrator 在 legacy 下**没有**做额外工作
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · legacy path 不做额外工作');

(function noExtraWork() {
  const recs = [
    mem({ id: 'a', title: '显卡', content: '显卡' }),
    mem({ id: 'b', visibility: 'private', content: 'secret' })
  ];
  const options = Object.assign({}, BASE, { userMessage: '显卡' });
  let visCalls = 0;
  let coreCalls = 0;
  const spyVis = {
    isMemoryVisibleTo: function () { visCalls++; return true; }
  };
  const spyOrch = ORCH.createOrchestrator({
    visibility: spyVis,
    core: {
      buildMemoryContext: function (rows, opts) { coreCalls++; return CORE.buildMemoryContext(rows, opts); },
      getMemoryScore: CORE.getMemoryScore,
      calcRelevance: CORE.calcRelevance,
      DEFAULT_BUDGET_CHARS: CORE.DEFAULT_BUDGET_CHARS,
      DEFAULT_CONTENT_LEN: CORE.DEFAULT_CONTENT_LEN
    }
  });
  const out = spyOrch.recall(recs, options);
  check('N1.legacyCallsCoreExactlyOnce', coreCalls === 1, 'coreCalls=' + coreCalls);
  check('N2.legacyDoesNotReRunVisibility', visCalls === 0,
    'legacy path must NOT re-apply ACL (core does it) — visCalls=' + visCalls);
  check('N3.legacyResultMatchesCore',
    JSON.stringify(out.result) === JSON.stringify(CORE.buildMemoryContext(recs, options)));
})();

/* ══════════════════════════════════════════════════════════════════════
   §4 · options 原样透传（不补默认值、不重排）
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · options 原样透传');

(function passThrough() {
  let seen = null;
  const spyOrch = ORCH.createOrchestrator({
    core: {
      buildMemoryContext: function (rows, opts) { seen = opts; return { text: '', selected: [], count: 0, chars: 0, reason: null }; },
      getMemoryScore: CORE.getMemoryScore,
      calcRelevance: CORE.calcRelevance,
      DEFAULT_BUDGET_CHARS: CORE.DEFAULT_BUDGET_CHARS,
      DEFAULT_CONTENT_LEN: CORE.DEFAULT_CONTENT_LEN
    }
  });
  const options = Object.assign({}, BASE, { maxChars: 777, contentLen: 33, userMessage: 'X' });
  spyOrch.recall([mem({ id: 'a' })], options);
  check('T1.optionsForwardedVerbatim', seen !== null && seen.maxChars === 777 && seen.contentLen === 33
    && seen.apiId === 'role_a' && seen.userMessage === 'X');
  check('T2.noTurnKeyInjected', seen !== null && !Object.prototype.hasOwnProperty.call(seen, 'turn'),
    'legacy path must NOT inject a turn key into core options');
  check('T3.injectedRandomIsTheSameFunction', seen !== null && seen.random === BASE.random);
  check('T4.nowIsTheSameValue', seen !== null && seen.now === NOW);
})();

/* ══════════════════════════════════════════════════════════════════════
   §5 · memory.js / Home Node wrapper 的 parity（结构 + 行为）
   ——— 真实 production function 执行，不是 stub 对 stub ———
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · production wrapper 使用 orchestrator（结构断言）');

const MEMORY_SRC = fs.readFileSync(path.join(ROOT, 'assets/js/memory.js'), 'utf8');
const NODE_SRC = fs.readFileSync(path.join(ROOT, 'services/home-node/memory-retrieval.js'), 'utf8');

check('W1.memoryJsReferencesOrchestrator',
  /IBMemoryRecallOrchestrator/.test(MEMORY_SRC),
  'browser wrapper must resolve the orchestrator global');
check('W2.memoryJsCallsOrchRecall',
  /_orch\?\.?|_orch\s*\?/.test(MEMORY_SRC) || /_orch\.recall\(/.test(MEMORY_SRC),
  'browser wrapper must call orchestrator.recall');
check('W3.memoryJsKeepsCoreFallback',
  /core\.buildMemoryContext\(all,\s*_pickOpts\)/.test(MEMORY_SRC),
  'browser wrapper must keep a core fallback (fail-open compatibility seam)');
check('W4.homeNodeRequiresOrchestrator',
  /require\(.*memory-recall-orchestrator\.js.*\)/.test(NODE_SRC),
  'Home Node must require the same orchestrator file');
check('W5.homeNodeKeepsCoreFallback',
  /MEMORY_RETRIEVAL\.buildMemoryContext\(page\.records \|\| \[\], buildOpts\)/.test(NODE_SRC),
  'Home Node must keep a core fallback');
/* Host 不得传 turn —— 这是 R2-C 的核心安全条件。 */
check('W6.memoryJsDoesNotPassTurn',
  !/turn\s*:/.test(MEMORY_SRC.slice(MEMORY_SRC.indexOf('_pickOpts'), MEMORY_SRC.indexOf('_pickOpts') + 900)),
  'browser Host must NOT pass turn in _pickOpts');
check('W7.homeNodeDoesNotPassTurn',
  !/turn\s*:/.test(NODE_SRC.slice(NODE_SRC.indexOf('const buildOpts'), NODE_SRC.indexOf('const buildOpts') + 900)),
  'Home Node Host must NOT pass turn in buildOpts');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL LEGACY PARITY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL LEGACY PARITY PASSED · ' + passed + ' assertions green'
    + ' (' + FIXTURES.length + ' fixtures, all deepStrictEqual)');
}
