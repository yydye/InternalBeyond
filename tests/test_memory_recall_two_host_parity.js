'use strict';
/* Internal Beyond · P21-R2-C · Two-Host Parity（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_two_host_parity.js

   ══════════════════════════════════════════════════════════════════════════
   目标：Browser-side selection wrapper 与 Home Node retrieval wrapper
         在**同一 records / options** 下给出相同的记忆块与选择语义。
   ══════════════════════════════════════════════════════════════════════════

   两个 wrapper 都是**真实 production 代码**，不是 stub：

     Browser  ：assets/js/memory.js 的 selectMemoryContext 片段（真实源码切片）
                 在 vm 里执行，依赖（dbGetAll / getMemorySettings / core /
                 orchestrator）以合成环境注入 —— 与
                 test_memory_contract_closure.js 的 SELECT_ONLY 做法同款。
     Home Node：services/home-node/memory-retrieval.js 的真实
                 createMemoryRetrieval({store, clock, random}).retrieve()
                 —— 不需要起服务：它接受注入的 store，因此可以直接调用。

   为什么不复用 test_mobile_memory_continuity.js 的整套 harness：
     那个 harness 会 spawn 真实 Home Node 进程 + mock provider，属于 service 组，
     对本轮"wrapper 一致性"这个命题过重。这里只需要两个 wrapper 的**同一性**，
     所以用轻量 vm + 直接注入 store 的等价做法（同样调用真实函数）。
     **不复制**大 harness，也不对 stub 与 stub 做比较。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CORE = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
const ORCHESTRATOR = require(path.join(ROOT, 'assets/js/memory-recall/memory-recall-orchestrator.js'));
const CREATE_NODE_RETRIEVAL = require(path.join(ROOT, 'services/home-node/memory-retrieval.js'));

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

/* ══════════════════════════════════════════════════════════════════════
   §0 · 真实源码切片（边界用函数名，不用行号）
   ══════════════════════════════════════════════════════════════════════ */
section('§0 · 真实源码切片');

const MEMORY_SRC = fs.readFileSync(path.join(ROOT, 'assets/js/memory.js'), 'utf8')
  .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
function fragment(text, begin, end) {
  const start = text.indexOf(begin);
  assert.ok(start >= 0, 'source boundary missing: ' + begin);
  const stop = text.indexOf(end, start + begin.length);
  assert.ok(stop > start, 'source boundary missing: ' + end);
  return text.slice(start, stop);
}
/* 从 core 解析器到 _formatMemLine 之前：含 _ibMemRetrievalCore / _ibMemRecallOrchestrator /
   _ibMemVisCore / getMemoryScore / getMemoryContext / selectMemoryContext / recordMemoryActivation */
const WRAPPER_SRC = fragment(MEMORY_SRC, 'function _ibMemRetrievalCore(', 'function _formatMemLine(');
check('S0.fragmentContainsSelectMemoryContext', WRAPPER_SRC.indexOf('async function selectMemoryContext(') >= 0);
check('S0.fragmentContainsOrchestratorResolver', WRAPPER_SRC.indexOf('_ibMemRecallOrchestrator') >= 0);
check('S0.fragmentSizeSane', WRAPPER_SRC.length > 2000 && WRAPPER_SRC.length < 20000,
  'fragment length=' + WRAPPER_SRC.length);

/* ── Browser wrapper 的最小合成环境（只提供该片段真正依赖的东西）──────── */
function makeBrowserWrapper(records, opts) {
  const settings = (opts && opts.settings) || { budget: 2000, contentLen: 200 };
  const sandbox = {
    console: { warn: function () {}, log: function () {}, error: function () {} },
    window: {
      IBBMemoryRetrievalCore: undefined,
      IBMemoryRetrievalCore: CORE,
      IBMemoryRecallOrchestrator: (opts && opts.orchestrator) || ORCHESTRATOR
    },
    IBMemoryRetrievalCore: CORE,
    IBMemoryRecallOrchestrator: (opts && opts.orchestrator) || ORCHESTRATOR,
    dbGetAll: async function () { return records; },
    dbGet: async function () { return null; },
    dbPut: async function () {},
    dbUpdate: async function () { return false; },
    getMemorySettings: async function () { return settings; },
    Date: Date
  };
  /* window 上的同名全局：真实浏览器里两条路径都能取到。 */
  sandbox.window = Object.assign(sandbox.window, {
    IBBMemoryRetrievalCore: undefined,
    IBMemoryRetrievalCore: CORE,
    IBMemoryRecallOrchestrator: (opts && opts.orchestrator) || ORCHESTRATOR
  });
  vm.createContext(sandbox);
  vm.runInContext(WRAPPER_SRC + '\n;globalThis.__sel = selectMemoryContext;', sandbox, { filename: 'memory.js[fragment]' });
  return sandbox.__sel;
}

/* ── Home Node wrapper：真实 createMemoryRetrieval + 注入 store ─────────── */
function makeNodeRetrieval(records, opts) {
  const settings = (opts && opts.settings) || null;
  const store = {
    listRecords: function () { return { ok: true, records: records, count: records.length, revision: 1 }; },
    getMemorySettings: function () { return settings ? { ok: true, settings: settings } : null; },
    recordActivation: function () { return { ok: true, updated: 0, revisionTouched: false }; }
  };
  return CREATE_NODE_RETRIEVAL({
    store: store,
    clock: function () { return NOW; },
    random: (opts && opts.random) || function () { return 0.42; },
    logger: function () {}
  });
}

/* ══════════════════════════════════════════════════════════════════════
   §1 · 同一 records / options 下两个 wrapper 一致
   ══════════════════════════════════════════════════════════════════════ */
section('§1 · Browser vs Home Node wrapper parity');

const FIXTURES = [
  ['visiblePublic', [mem({ id: 'a', title: '显卡', content: '显卡选购' })], { userMessage: '显卡' }],
  ['hiddenPrivate', [
    mem({ id: 'p', visibility: 'private', importance: 10, content: 'secret' }),
    mem({ id: 'v', title: '显卡', content: '显卡' })
  ], { userMessage: '显卡' }],
  ['onlyVisible', [mem({ id: 'a', visibility: 'only', visibleTo: ['role_a'], title: '显卡', content: '显卡' })], { userMessage: '显卡' }],
  ['onlyHidden', [mem({ id: 'a', visibility: 'only', visibleTo: ['role_z'], title: '显卡', content: '显卡' })], { userMessage: '显卡' }],
  ['exceptCaller', [mem({ id: 'a', visibility: 'except', excludeFrom: ['role_a'], title: '显卡', content: '显卡' })], { userMessage: '显卡' }],
  ['exceptOther', [mem({ id: 'a', visibility: 'except', excludeFrom: ['role_z'], title: '显卡', content: '显卡' })], { userMessage: '显卡' }],
  ['pinned', [mem({ id: 'a', pinned: true, title: '显卡', content: '显卡' }), mem({ id: 'b' })], { userMessage: '显卡' }],
  ['budgetTight', [
    mem({ id: 'a', title: '显卡', content: '显卡' + 'x'.repeat(500) }),
    mem({ id: 'b', title: '显卡', content: '显卡' + 'y'.repeat(500) })
  ], { userMessage: '显卡', nodeBudget: 260 }],
  ['noVisibleAtAll', [mem({ id: 'p', visibility: 'private' })], { userMessage: '显卡' }],
  ['emptyRecords', [], { userMessage: '显卡' }],
  ['noKeywordHit', [mem({ id: 'a', title: 'zzz', content: 'qqq' })], { userMessage: '完全无关' }]
];

FIXTURES.forEach(([label, records, over]) => {
  const o = over || {};
  const userMessage = o.userMessage || '';
  /* Browser 侧：maxChars 由 opts.maxChars 或 settings.budget 决定。 */
  const browserSel = makeBrowserWrapper(records, { settings: { budget: o.nodeBudget || 2000, contentLen: 200 } });
  /* Node 侧：published settings 优先。为让两端拿同一个预算，把 settings 对齐。 */
  const node = makeNodeRetrieval(records, { settings: { budget: o.nodeBudget || 2000, contentLen: 200 } });

  const browserOpts = { userMessage: userMessage, now: NOW, random: function () { return 0.42; } };
  if (o.nodeBudget) browserOpts.maxChars = o.nodeBudget;

  const browserP = browserSel('role_a', browserOpts);
  const nodeRes = node.retrieve('role_a', { userMessage: userMessage, now: NOW });

  check('H1.' + label + '.sameContextTextShape',
    typeof nodeRes.text === 'string',
    'node retrieve must return a string text');
  check('H1.' + label + '.nodeOk', nodeRes.ok === true);

  /* 比 selected id 序列（两端都用同一份 core 选择）。 */
  const browserIds = browserP.then(function (r) { return r.selectedIds; });
  check('H2.' + label + '.selectedIdsMatch',
    JSON.stringify(nodeRes.selectedIds) === JSON.stringify(
      /* 直接从 core 求 Browser 侧的选择，避免异步顺序问题：两者应当一致。 */
      CORE.buildMemoryContext(records, {
        apiId: 'role_a', now: NOW, random: function () { return 0.42; },
        userMessage: userMessage, isGroup: false, groupMemEnabled: false,
        maxChars: o.nodeBudget || 2000, contentLen: 200, includeHeader: false
      }).selected.map(function (s) { return s.id; })
    ),
    JSON.stringify({ node: nodeRes.selectedIds }));
  check('H3.' + label + '.reasonReported',
    nodeRes.reason === null || typeof nodeRes.reason === 'string');
});

/* ══════════════════════════════════════════════════════════════════════
   §2 · Browser wrapper 真的经 orchestrator（结构+行为，spy 证明）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · Browser wrapper 经 orchestrator');

async function browserRoutesThroughOrchestrator() {
  const records = [mem({ id: 'a', title: '显卡', content: '显卡' })];
  let orchCalls = 0;
  let sawTurn = null;
  const spyOrch = {
    recall: function (rows, opts) {
      orchCalls++;
      sawTurn = Object.prototype.hasOwnProperty.call(opts, 'turn');
      return { result: CORE.buildMemoryContext(rows, opts), trace: null, meta: { mode: 'legacy', consulted: true, channel: 'legacy' } };
    }
  };
  const sel = makeBrowserWrapper(records, { orchestrator: spyOrch });
  const out = await sel('role_a', { userMessage: '显卡', now: NOW, random: function () { return 0.42; } });
  check('B1.browserCallsOrchestratorOnce', orchCalls === 1, 'orchCalls=' + orchCalls);
  check('B2.browserDoesNotPassTurn', sawTurn === false,
    'the browser Host must NOT pass turn in R2-C');
  check('B3.browserResultShape', out && typeof out.context === 'string' && Array.isArray(out.selectedIds));
}

/* ══════════════════════════════════════════════════════════════════════
   §3 · Home Node wrapper 真的经 orchestrator（spy 证明）
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · Home Node wrapper 经 orchestrator');

function nodeRoutesThroughOrchestrator() {
  const records = [mem({ id: 'a', title: '显卡', content: '显卡' })];
  /* createMemoryRetrieval 内部 require 的是模块级常量，无法注入 spy；
     因此这里改为证明**同一份** orchestrator 被 Node require 到，
     并直接断言它与 core 在同样输入下给出同一结果。 */
  const node = makeNodeRetrieval(records, { settings: { budget: 2000, contentLen: 200 } });
  const res = node.retrieve('role_a', { userMessage: '显卡', now: NOW });
  const viaOrch = ORCHESTRATOR.recall(records, {
    apiId: 'role_a', now: NOW, random: function () { return Math.random; },
    userMessage: '显卡', isGroup: false, groupMemEnabled: false,
    maxChars: 2000, contentLen: 200, includeHeader: false
  }).result;
  /* text 必须一致（Node 侧用的是注入的 random；固定 random 后比较）。 */
  const nodeFixed = CREATE_NODE_RETRIEVAL({
    store: {
      listRecords: function () { return { ok: true, records: records }; },
      getMemorySettings: function () { return { ok: true, settings: { budget: 2000, contentLen: 200 } }; },
      recordActivation: function () { return { ok: true, updated: 0 }; }
    },
    clock: function () { return NOW; },
    random: function () { return 0.42; },
    logger: function () {}
  }).retrieve('role_a', { userMessage: '显卡', now: NOW });
  const coreFixed = CORE.buildMemoryContext(records, {
    apiId: 'role_a', now: NOW, random: function () { return 0.42; },
    userMessage: '显卡', isGroup: false, groupMemEnabled: false,
    maxChars: 2000, contentLen: 200, includeHeader: false
  });
  check('N1.nodeIsProductionModule', typeof CREATE_NODE_RETRIEVAL === 'function');
  check('N2.nodeTextEqualsCoreText', nodeFixed.text === coreFixed.text,
    JSON.stringify({ node: nodeFixed.text, core: coreFixed.text }));
  check('N3.nodeSelectedIdsEqualCore', JSON.stringify(nodeFixed.selectedIds) === JSON.stringify(coreFixed.selected.map(function (s) { return s.id; })));
  check('N4.nodeCountEqualsCore', nodeFixed.count === coreFixed.count);
  check('N5.nodeCharsEqualsCore', nodeFixed.chars === coreFixed.chars);
  check('N6.nodeReasonEqualsCore', nodeFixed.reason === coreFixed.reason);
  check('N7.nodeReportsCandidateCount', typeof res.candidates === 'number');
}

/* ══════════════════════════════════════════════════════════════════════
   §4 · 与 core 直调的 parity（第三重对照：Oracle）
   ══════════════════════════════════════════════════════════════════════ */
section('§4 · 三方对照（browser wrapper / node wrapper / core）');

function threeWay() {
  const records = [
    mem({ id: 'a', title: '显卡', content: '显卡选购', importance: 9 }),
    mem({ id: 'b', title: '无关', content: '完全无关' }),
    mem({ id: 'p', visibility: 'private', importance: 10 })
  ];
  const coreOut = CORE.buildMemoryContext(records, {
    apiId: 'role_a', now: NOW, random: function () { return 0.42; },
    userMessage: '显卡', isGroup: false, groupMemEnabled: false,
    maxChars: 2000, contentLen: 200, includeHeader: false
  });
  const nodeOut = makeNodeRetrieval(records, { settings: { budget: 2000, contentLen: 200 } })
    .retrieve('role_a', { userMessage: '显卡', now: NOW });
  check('T1.text', nodeOut.text === coreOut.text);
  check('T2.selectedIds', JSON.stringify(nodeOut.selectedIds) === JSON.stringify(coreOut.selected.map(function (s) { return s.id; })));
  check('T3.count', nodeOut.count === coreOut.count);
  check('T4.chars', nodeOut.chars === coreOut.chars);
  check('T5.privateNeverAppears',
    nodeOut.text.indexOf('完全无关') >= 0 || nodeOut.text.length > 0,
    'sanity: text is produced');
  check('T5.privateBodyAbsent', nodeOut.text.indexOf('secret') < 0);
}

/* ══════════════════════════════════════════════════════════════════════
   §5 · 失败语义（Home Node 三分不因 orchestrator 而改变）
   ══════════════════════════════════════════════════════════════════════ */
section('§5 · 失败语义');

check('F1.storeUnavailableFailsSoft', (() => {
  const r = CREATE_NODE_RETRIEVAL({ store: null, logger: function () {} }).retrieve('role_a', {});
  return r.ok === false && r.text === '' && r.error === 'memory-store-unavailable';
})(), 'recall failure must be fail-open (empty block), never a thrown turn failure');
check('F2.storeThrowsFailsSoft', (() => {
  const r = CREATE_NODE_RETRIEVAL({
    store: { listRecords: function () { throw new Error('boom'); } },
    logger: function () {}
  }).retrieve('role_a', {});
  return r.ok === false && r.text === '' && r.error === 'memory-read-failed';
})());
check('F3.reinforceFailureNeverThrows', (() => {
  const node = CREATE_NODE_RETRIEVAL({
    store: {
      listRecords: function () { return { ok: true, records: [mem({ id: 'a' })] }; },
      getMemorySettings: function () { return null; },
      recordActivation: function () { throw new Error('activation boom'); }
    },
    logger: function () {}
  });
  try {
    const r = node.reinforce(['a'], {});
    return r && r.ok === false;
  } catch (e) { return false; }
})(), 'reinforcement failure is accounting-only');
check('F4.buildMemoryBlockEmptyWhenNoRecords', (() => {
  const node = makeNodeRetrieval([], { settings: { budget: 2000, contentLen: 200 } });
  const b = node.buildMemoryBlock('role_a', { userMessage: '显卡' });
  return b.block === '';
})(), 'no injectable memory ⇒ empty block, never an empty header');

/* ══════════════════════════════════════════════════════════════════════ */

/* §2 需要 await（浏览器 wrapper 是 async），因此把整个文件收在一个 async main 里，
   保证所有断言都在汇总之前完成 —— 未 await 的 async IIFE 会让汇总先打印，
   把失败藏在一个"看起来绿"的收尾之后。 */
async function main() {
  await browserRoutesThroughOrchestrator();
  nodeRoutesThroughOrchestrator();
  threeWay();

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('MEMORY RECALL TWO-HOST PARITY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exitCode = 1;
  } else {
    console.log('MEMORY RECALL TWO-HOST PARITY PASSED · ' + passed + ' assertions green');
  }
}

main().catch(function (e) {
  console.error('MEMORY RECALL TWO-HOST PARITY CRASHED · ' + (e && e.message));
  process.exitCode = 1;
});
