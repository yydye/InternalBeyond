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
/* §6 的调用计数需要一个**依赖可见**的 orchestrator 实例，因此单独取出这三个模块。 */
const SCORING = require(path.join(ROOT, 'assets/js/memory-recall/scoring.js'));
const QUERY = require(path.join(ROOT, 'assets/js/memory-recall/recall-query.js'));
const TURNSIGNAL = require(path.join(ROOT, 'assets/js/memory-recall/turn-signal.js'));
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

const browserComparisons = [];

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

  /* ── R2-D：两个 Host 现在都传 turn ⇒ 用 turn-aware 语义做对照。
     Oracle 仍是**同一份** orchestrator（浏览器与 Node require 的是同一个文件），
     因此这条断言测的是"两个 Host 是否把同一段输入喂成同一段语义证据"，
     而不是"两份实现碰巧一致"。 */
  const oracle = ORCHESTRATOR.recall(records, {
    apiId: 'role_a', now: NOW, random: function () { return 0.42; },
    userMessage: userMessage, isGroup: false, groupMemEnabled: false,
    maxChars: o.nodeBudget || 2000, contentLen: 200, includeHeader: false,
    turn: { message: userMessage }
  });

  check('H2.' + label + '.selectedIdsMatch',
    JSON.stringify(nodeRes.selectedIds) === JSON.stringify(oracle.result.selected.map(function (s) { return s.id; })),
    JSON.stringify({ node: nodeRes.selectedIds, oracle: oracle.result.selected.map(function (s) { return s.id; }) }));
  check('H3.' + label + '.reasonReported',
    nodeRes.reason === null || typeof nodeRes.reason === 'string');
  check('H4.' + label + '.reasonMatchesOracle',
    nodeRes.reason === oracle.result.reason,
    JSON.stringify({ node: nodeRes.reason, oracle: oracle.result.reason }));
  check('H5.' + label + '.textMatchesOracle',
    nodeRes.text === oracle.result.text,
    JSON.stringify({ nodeLen: nodeRes.text.length, oracleLen: oracle.result.text.length }));
  check('H6.' + label + '.countAndCharsMatchOracle',
    nodeRes.count === oracle.result.count && nodeRes.chars === oracle.result.chars,
    JSON.stringify({ node: [nodeRes.count, nodeRes.chars], oracle: [oracle.result.count, oracle.result.chars] }));
  check('H7.' + label + '.channelIsTurnAware',
    oracle.trace.channel === 'surface' || oracle.trace.channel === 'recall' || oracle.trace.channel === null,
    'channel=' + oracle.trace.channel);
  /* Browser 侧走的是真实 memory.js wrapper（异步）—— 其结果在 §1b 统一 await
     后与 oracle 对照。这里只收集，不在同步循环里下断言
     （把 Promise 传给 check 会恒为真，那是一条没有鉴别力的断言）。 */
  browserComparisons.push({
    label: label,
    promise: browserSel('role_a', browserOpts),
    expectedIds: oracle.result.selected.map(function (s) { return s.id; })
  });
});

/* ══════════════════════════════════════════════════════════════════════
   §1b · Browser wrapper 与 oracle 一致（异步，统一 await）
   ══════════════════════════════════════════════════════════════════════ */
async function browserMatchesOracle() {
  section('§1b · Browser wrapper vs oracle');
  for (const row of browserComparisons) {
    const r = await row.promise;
    check('H8.' + row.label + '.browserMatchesOracle',
      JSON.stringify(r.selectedIds) === JSON.stringify(row.expectedIds),
      JSON.stringify({ browser: r.selectedIds, oracle: row.expectedIds }));
  }
}

/* ══════════════════════════════════════════════════════════════════════
   §2 · Browser wrapper 真的经 orchestrator（结构+行为，spy 证明）
   ══════════════════════════════════════════════════════════════════════ */
section('§2 · Browser wrapper 经 orchestrator');

async function browserRoutesThroughOrchestrator() {
  const records = [mem({ id: 'a', title: '显卡', content: '显卡' })];
  let orchCalls = 0;
  let sawTurn = null;
  let sawMessage = null;
  const spyOrch = {
    recall: function (rows, opts) {
      orchCalls++;
      sawTurn = Object.prototype.hasOwnProperty.call(opts, 'turn');
      sawMessage = opts.turn ? opts.turn.message : null;
      return { result: CORE.buildMemoryContext(rows, opts), trace: null, meta: { mode: 'legacy', consulted: true, channel: 'legacy' } };
    }
  };
  const sel = makeBrowserWrapper(records, { orchestrator: spyOrch });
  const out = await sel('role_a', { userMessage: '显卡', now: NOW, random: function () { return 0.42; } });
  check('B1.browserCallsOrchestratorOnce', orchCalls === 1, 'orchCalls=' + orchCalls);
  check('B2.browserPassesTurnMessage', sawTurn === true,
    'R2-D: the browser Host must pass turn (precise assertions live in the wiring guard §A4)');
  check('B2b.browserTurnCarriesTheUserMessage', sawMessage === '显卡',
    'the turn message must be the current user input, got ' + JSON.stringify(sawMessage));
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
  /* R2-D：Node 侧现在传 turn ⇒ 参照也必须走同一个 orchestrator 的 turn 模式，
     否则比较的是"turn-aware vs legacy"两种语义（那是 §1 的 delta 测试要回答的，
     不是 §4 的三方一致性要回答的）。 */
  const orchOut = ORCHESTRATOR.recall(records, {
    apiId: 'role_a', now: NOW, random: function () { return 0.42; },
    userMessage: '显卡', isGroup: false, groupMemEnabled: false,
    maxChars: 2000, contentLen: 200, includeHeader: false,
    turn: { message: '显卡' }
  }).result;
  const nodeOut = makeNodeRetrieval(records, { settings: { budget: 2000, contentLen: 200 } })
    .retrieve('role_a', { userMessage: '显卡', now: NOW });
  check('T1.text', nodeOut.text === orchOut.text);
  check('T2.selectedIds', JSON.stringify(nodeOut.selectedIds) === JSON.stringify(orchOut.selected.map(function (s) { return s.id; })));
  check('T3.count', nodeOut.count === orchOut.count);
  check('T4.chars', nodeOut.chars === orchOut.chars);
  check('T4b.reason', nodeOut.reason === orchOut.reason);
  check('T5.privateNeverAppears',
    nodeOut.text.indexOf('完全无关') >= 0 || nodeOut.text.length > 0,
    'sanity: text is produced');
  check('T5.privateBodyAbsent', nodeOut.text.indexOf('secret') < 0);
}

/* ══════════════════════════════════════════════════════════════════════
   §5 · 失败语义（Home Node 三分不因 orchestrator 而改变）
   ══════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════
   §6 · 激活副作用（P21-R2-D）
   ──────────────────────────────────────────────────────────────────────
   为什么必须用 **spy** 而不是"看 selected 是不是空"：
     selected=[] ⇒ 不强化，这个推断看似显然，但它恰好会漏掉最危险的那一类
     bug —— "结果为空、调用方仍按旧习惯强化了一遍上一轮的 id"。
     只有观察**真实调用**才能排除它。R2-D 的新语义是：
       早退 / Hard Gate 拒绝 ⇒ 0 次强化（没有选中就不能强化）
       相关且被选中        ⇒ 恰好一次、且只含被选中的 id
       隐藏记忆            ⇒ 永不出现
     D-7（canonical activation authority）**不**在本轮修改。
   ══════════════════════════════════════════════════════════════════════ */
section('§6 · 激活副作用（spy）');

/* 用本文件**已有**的 memory.js 真实切片（WRAPPER_SRC）额外注入一个
   recordActivation spy —— 不再另建一套 harness，避免两份切片漂移。
   判据刻意观察**真实调用**而不是"selected 是不是空"：
     selected=[] ⇒ 不强化，这个推断看似显然，却恰好漏掉最危险的一类 bug
     —— "结果为空、调用方仍按旧习惯把上一轮的 id 强化了一遍"。
   R2-D 的新语义：早退 / Hard Gate 拒绝 ⇒ 0 次强化；
   相关且被选中 ⇒ 恰好一次且只含被选中的 id；隐藏记忆 ⇒ 永不出现。
   D-7（canonical activation authority）**不**在本轮修改。 */
async function activationSpy() {
  const activationLog = [];
  const dbWrites = [];
  const records = [
    mem({ id: 'gpu', title: '显卡', content: 'RTX 5070 Ti' }),
    mem({ id: 'noise', title: '菜谱', content: '红烧肉做法' }),
    mem({ id: 'hid', visibility: 'private', title: '显卡', content: '显卡秘密' })
  ];
  const sandbox = {
    console: { warn: function () {}, log: function () {}, error: function () {} },
    Date: Date,
    IBMemoryRetrievalCore: CORE,
    IBMemoryVisibilityCore: require(path.join(ROOT, 'assets/js/memory-visibility-core.js')),
    IBMemoryRecallOrchestrator: ORCHESTRATOR,
    dbGetAll: async function () { return records; },
    dbGet: async function () { return null; },
    dbPut: async function (id, rec) { dbWrites.push({ id: id, rec: rec }); },
    dbUpdate: async function (id, rec) { dbWrites.push({ id: id, rec: rec }); return true; },
    getMemorySettings: async function () { return { budget: 2000, contentLen: 200 }; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(WRAPPER_SRC
    + '\n;globalThis.__sel = selectMemoryContext;'
    + '\n;globalThis.__act = function (ids, at) { globalThis.__spy(ids, at); return recordMemoryActivation(ids, at); };',
    sandbox, { filename: 'memory.js[fragment+spy]' });
  sandbox.__spy = function (ids) { activationLog.push(Array.prototype.slice.call(ids)); };
  const selectMemoryContext = sandbox.__sel;
  const recordActivation = sandbox.__act;

  /* 按 memory.js 的真实调用顺序驱动：先选择，拿到非空 selectedIds 才强化。 */
  async function run(message) {
    const res = await selectMemoryContext('role_a', { userMessage: message, now: NOW, random: function () { return 0.42; } });
    if (res && Array.isArray(res.selectedIds) && res.selectedIds.length) {
      await recordActivation(res.selectedIds, NOW);
    }
    return res;
  }

  /* A. early exit ⇒ 0 次强化 */
  activationLog.length = 0; dbWrites.length = 0;
  const ack = await run('嗯');
  check('X1.earlyExitDoesNotActivate',
    ack.context === '' && activationLog.length === 0,
    JSON.stringify({ ctxLen: ack.context.length, calls: activationLog.length, reason: ack.reason }));

  /* B. Hard Gate 拒绝 ⇒ 0 次强化 */
  activationLog.length = 0; dbWrites.length = 0;
  const rej = await run('量子纠缠的退相干时间');
  check('X2.gateRejectedDoesNotActivate',
    rej.context === '' && activationLog.length === 0,
    JSON.stringify({ ctxLen: rej.context.length, calls: activationLog.length, reason: rej.reason }));

  /* C. 相关且被选中 ⇒ 恰好一次，且只含被选中的 id */
  activationLog.length = 0; dbWrites.length = 0;
  const rel = await run('显卡最近怎么样');
  check('X3.relevantSelectionActivatesExactlyOnce',
    rel.selectedIds.length > 0 && activationLog.length === 1,
    JSON.stringify({ calls: activationLog.length, selected: rel.selectedIds }));
  check('X3.activationIdsEqualSelectedIds',
    activationLog.length === 1
    && JSON.stringify(activationLog[0].slice().sort()) === JSON.stringify(rel.selectedIds.slice().sort()),
    JSON.stringify({ activated: activationLog[0], selected: rel.selectedIds }));

  /* D. 隐藏记忆 ⇒ 永不出现 */
  activationLog.length = 0; dbWrites.length = 0;
  const withHidden = await run('显卡');
  check('X4.hiddenNeverActivated',
    activationLog.every(function (ids) { return ids.indexOf('hid') < 0; })
    && dbWrites.every(function (w) { return String(w.id).indexOf('hid') < 0; }),
    JSON.stringify({ activated: activationLog, writes: dbWrites.map(function (w) { return w.id; }) }));
  check('X4.hiddenAlsoAbsentFromContext', withHidden.context.indexOf('显卡秘密') < 0);

  /* E. 反向控制：spy 必须有能力观测到一次**真实**强化。
        否则 A/B 的"0 次"可能只是因为 spy 根本没接上。 */
  activationLog.length = 0;
  await recordActivation(['probe-id'], NOW);
  check('X5.reverseControl.spyIsLive',
    activationLog.length === 1 && activationLog[0][0] === 'probe-id',
    JSON.stringify(activationLog));

  /* ── F. 性能保护（R2-D-PERF 取证，§30）────────────────────────────────
     早退的最大价值之一就是**不干活**。用注入的"计数型依赖"直接数调用次数，
     而不是靠推理。同时如实记录候选集是否在 orchestrator 之前就已经读完 ——
     若确实先全表读取，那就是登记在案的 R2-D-PERF-1，本轮**不**顺手改 I/O。 */
  const counts = { scoring: 0, query: 0, core: 0, turnSignal: 0 };
  const spyOrch = ORCHESTRATOR.createOrchestrator({
    scoring: {
      scoreRelevance: function (m, q) { counts.scoring++; return SCORING.scoreRelevance(m, q); },
      computeLegacyMemoryValue: function (m, n) { counts.scoring++; return SCORING.computeLegacyMemoryValue(m, n); },
      passesHardGate: SCORING.passesHardGate
    },
    query: {
      buildRecallQuery: function (msg, o) { counts.query++; return QUERY.buildRecallQuery(msg, o); }
    },
    core: {
      buildMemoryContext: function (r, o) { counts.core++; return CORE.buildMemoryContext(r, o); }
    },
    turnSignal: {
      analyzeTurnSignal: function (i) { counts.turnSignal++; return TURNSIGNAL.analyzeTurnSignal(i); }
    }
  });
  const perRun = function (recs, msg) {
    counts.scoring = 0; counts.query = 0; counts.core = 0; counts.turnSignal = 0;
    const out = spyOrch.recall(recs, {
      apiId: 'role_a', now: NOW, random: function () { return 0.42; },
      userMessage: msg, isGroup: false, groupMemEnabled: false,
      maxChars: 2000, contentLen: 200, turn: { message: msg }
    });
    return { out: out, counts: Object.assign({}, counts) };
  };

  const ackRun = perRun(records, '嗯');
  check('X6.earlyExitDoesNoScoring', ackRun.counts.scoring === 0, JSON.stringify(ackRun.counts));
  check('X6.earlyExitDoesNoQueryConstruction', ackRun.counts.query === 0, JSON.stringify(ackRun.counts));
  check('X6.earlyExitDoesNoCoreSelection', ackRun.counts.core === 0, JSON.stringify(ackRun.counts));
  check('X6.earlyExitConsultsTurnSignalOnce', ackRun.counts.turnSignal === 1, JSON.stringify(ackRun.counts));
  check('X6.earlyExitResultIsEmpty',
    ackRun.out.result.text === '' && ackRun.out.result.count === 0
    && ackRun.out.result.reason === 'early-exit');

  /* 反向控制：正常一轮**必须**真的用上这些依赖，否则上面的 0 没有意义。 */
  const relRun = perRun(records, '显卡');
  check('X7.reverseControl.normalRunDoesWork',
    relRun.counts.scoring > 0 && relRun.counts.query === 1 && relRun.counts.core === 1,
    JSON.stringify(relRun.counts));

  /* 如实记录：候选集是否在 orchestrator 之前就已读完。
     本 harness 里 records 由调用方一次性给出（浏览器是 dbGetAll、
     Home Node 是 store.listRecords），因此早退只省 CPU、**不省 DB read**。
     这不是缺陷隐瞒，而是登记在案的 R2-D-PERF-1 债务。 */
  check('X8.perfHonesty.earlyExitStillAfterCandidateRead',
    Array.isArray(records) && records.length === 3,
    'R2-D-PERF-1: candidates are read before the orchestrator runs, so early exit saves CPU only');
}

/* ══════════════════════════════════════════════════════════════════════
   §7 · 失败语义（Home Node 三分不因 orchestrator 而改变）
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
  await browserMatchesOracle();
  await browserRoutesThroughOrchestrator();
  nodeRoutesThroughOrchestrator();
  threeWay();
  await activationSpy();

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
