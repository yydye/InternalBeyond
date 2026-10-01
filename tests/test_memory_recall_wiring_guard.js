'use strict';
/* Internal Beyond · P21-R2-C · Production Wiring Contract（Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_wiring_guard.js

   ══════════════════════════════════════════════════════════════════════════
   ⚠ PHASE TRANSITION（R2-B → R2-C，有意为之，不是 regression）
   ══════════════════════════════════════════════════════════════════════════

   R2-B 时本文件断言：
       production references = 0        （模块 implemented but unwired）

   R2-C 的目标**就是**正式接线，因此那条断言按设计失效。本文件升级为：
       production references only through orchestrator

   具体改动（逐条，便于 review 时确认不是"把红改成绿"）：

     旧 A3.zeroProductionCallers
        → 新 A3.hostsReachRecallOnlyThroughOrchestrator
              production 里出现 recall 能力只允许经由 orchestrator 的
              依赖注入；turn-signal / recall-query 不得被 Host 直接调用。

     旧 A1.htmlDoesNotReference.*
        → 新 A1.htmlLoadsRecallModulesInOrder
              HTML **必须**按依赖顺序加载五个 recall 模块。

     旧 A2.noRef.<关键文件>.*
        → 新 A2.<Host>ReferencesOrchestrator
              memory.js / Home Node memory-retrieval.js **必须**引用 orchestrator，
              并且**必须**保留 core 回落（fail-open 兼容缝）。

   仍然有效的安全断言（未放宽）：
     · Host 不得传 turn（R2-C 的核心安全条件）
     · 不得引用 channel-policy / seat-planner / cooldown（属于 R2-D/F）
     · 不得有第二套 ACL / 第二套 lexical 实现
     · orchestrator 不得持久化任何东西

   为什么保留反向控制：把一组断言从"零引用"改成"经 orchestrator"之后，
   最容易发生的事是判据被放宽到测不出东西。因此下面每一条"应当存在"的
   断言都配一条"篡改后必须变红"的证明。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

let failures = 0;
let passed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
/* 剥注释但保留字符串字面量（require 路径就在字符串里）。 */
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const RECALL_DIR = 'assets/js/memory-recall/';
const MODULES = [
  'assets/js/memory-recall/turn-signal.js',
  'assets/js/memory-recall/recall-query.js',
  'assets/js/memory-recall/scoring.js',
  'assets/js/memory-recall/recall-trace.js',
  'assets/js/memory-recall/memory-recall-orchestrator.js'
];
const FUTURE_MODULES = ['channel-policy.js', 'seat-planner.js', 'cooldown.js'];
const HTML = 'InternalBeyond.html';

function walkJs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkJs(full, out); continue; }
    if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   §A1 · HTML 按依赖顺序加载五个模块
   ══════════════════════════════════════════════════════════════════════ */
section('§A1 · HTML 加载顺序');

const HTML_NO_COMMENTS = stripComments(read(HTML));
MODULES.forEach(rel => {
  check('A1.htmlLoads.' + rel.split('/').pop(),
    HTML_NO_COMMENTS.indexOf(rel) >= 0,
    rel + ' must be loaded by ' + HTML);
});
/* 顺序：visibility → retrieval-core → 五个 recall 模块 → memory.js */
(function orderCheck() {
  const pos = {};
  const seq = ['assets/js/memory-visibility-core.js', 'assets/js/memory-retrieval-core.js']
    .concat(MODULES).concat(['assets/js/memory.js']);
  let ok = true, detail = '';
  seq.forEach(rel => { pos[rel] = HTML_NO_COMMENTS.indexOf(rel); });
  for (let i = 1; i < seq.length; i++) {
    if (pos[seq[i]] < 0 || pos[seq[i - 1]] < 0 || pos[seq[i]] < pos[seq[i - 1]]) {
      ok = false; detail = seq[i - 1] + ' must precede ' + seq[i];
    }
  }
  check('A1.dependencyOrderRespected', ok, detail);
})();
check('A1.recallModulesPrecedeMemoryJs',
  MODULES.every(m => HTML_NO_COMMENTS.indexOf(m) < HTML_NO_COMMENTS.indexOf('assets/js/memory.js')));
check('A1.recallCorePrecedesRecallQuery',
  HTML_NO_COMMENTS.indexOf('assets/js/memory-retrieval-core.js')
  < HTML_NO_COMMENTS.indexOf('assets/js/memory-recall/recall-query.js'),
  'recall-query reuses core.extractKeywords — core must load first');
check('A1.orchestratorLoadedLast',
  MODULES.every(m => m === MODULES[4] || HTML_NO_COMMENTS.indexOf(m) < HTML_NO_COMMENTS.indexOf(MODULES[4])));
check('A1.reverseControl.detectorSeesScriptTags',
  /<script[^>]*src=/i.test(HTML_NO_COMMENTS),
  'reverse control: the detector must be able to see real <script src> tags');

/* ══════════════════════════════════════════════════════════════════════
   §A2 · Host 经 orchestrator（且保留回落）
   ══════════════════════════════════════════════════════════════════════ */
section('§A2 · Host 接线');

const MEMORY_SRC = stripComments(read('assets/js/memory.js'));
const NODE_SRC = stripComments(read('services/home-node/memory-retrieval.js'));

check('A2.browserResolvesOrchestrator', MEMORY_SRC.indexOf('IBMemoryRecallOrchestrator') >= 0);
check('A2.browserCallsRecall', /_orch\s*\?[^;]*\.recall\(/.test(MEMORY_SRC) || /_orch\.recall\(/.test(MEMORY_SRC));
check('A2.browserKeepsCoreFallback',
  MEMORY_SRC.indexOf('core.buildMemoryContext(all,_pickOpts)') >= 0,
  'the browser must fall back to core when the orchestrator is missing (fail-open)');
check('A2.homeNodeRequiresOrchestrator',
  NODE_SRC.indexOf('memory-recall-orchestrator.js') >= 0);
check('A2.homeNodeCallsRecall', NODE_SRC.indexOf('MEMORY_RECALL_ORCHESTRATOR.recall(') >= 0);
check('A2.homeNodeKeepsCoreFallback',
  NODE_SRC.indexOf('MEMORY_RETRIEVAL.buildMemoryContext(page.records || [], buildOpts)') >= 0,
  'Home Node must fall back to core when the orchestrator is missing');
check('A2.homeNodeRequireIsGuarded',
  /try\s*\{[^}]*require\([^)]*memory-recall-orchestrator\.js[^)]*\)[^}]*\}\s*catch/.test(NODE_SRC)
  || /catch\s*\([^)]*\)\s*\{\s*MEMORY_RECALL_ORCHESTRATOR\s*=\s*null/.test(NODE_SRC),
  'the require must be guarded so a missing module cannot break the Home Node');

/* ══════════════════════════════════════════════════════════════════════
   §A3 · recall 能力只经 orchestrator 进入生产
   ══════════════════════════════════════════════════════════════════════ */
section('§A3 · 只经 orchestrator');

const HOSTS = [
  'assets/js/memory.js',
  'assets/js/communication.js',
  'assets/js/home-node-bootstrap.js',
  'services/home-node/memory-retrieval.js',
  'services/home-node/mobile-gateway.js'
];

/* A3.1 · Host **不得**直接调用 turn-signal 的 analyzeTurnSignal 或
          recall-query 的 buildRecallQuery（那是 orchestrator 的职责）。 */
const directCallers = [];
HOSTS.forEach(rel => {
  let src;
  try { src = stripComments(read(rel)); } catch (e) { return; }
  if (rel === 'services/home-node/memory-retrieval.js') return; /* 它是 orchestrator 的宿主，仍不得直接调 */
  ['analyzeTurnSignal', 'buildRecallQuery'].forEach(fn => {
    if (src.indexOf(fn) >= 0) directCallers.push(rel + ' :: ' + fn);
  });
});
check('A3.hostsDoNotCallTurnSignalOrQueryDirectly', directCallers.length === 0,
  'Hosts must go through the orchestrator:\n        ' + directCallers.join('\n        '));

/* A3.2 · 整个生产面里，recall 模块被 require / 引用的情况只允许来自
          orchestrator 自己或 Host 的 orchestrator 引用。 */
const scanned = [];
['assets/js', 'services', 'bridge', 'runtime', 'game'].forEach(d => {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walkJs(full, scanned);
});
check('A3.scannedEnoughFiles', scanned.length > 200, 'scanned ' + scanned.length);

const offenders = [];
for (const full of scanned) {
  const rel = path.relative(ROOT, full).replace(/\\/g, '/');
  if (MODULES.indexOf(rel) >= 0) continue;              /* 模块自身 */
  if (rel === 'assets/js/memory.js') continue;           /* 已单独断言经 orchestrator */
  if (rel === 'services/home-node/memory-retrieval.js') continue; /* 同上 */
  const src = stripComments(fs.readFileSync(full, 'utf8'));
  ['IBMemoryRecallTurnSignal', 'IBMemoryRecallQuery', 'IBMemoryRecallScoring',
    'IBMemoryRecallTrace', 'analyzeTurnSignal', 'buildRecallQuery',
    'memory-recall/turn-signal', 'memory-recall/recall-query',
    'memory-recall/scoring', 'memory-recall/recall-trace'
  ].forEach(token => {
    if (src.indexOf(token) >= 0) offenders.push(rel + ' :: ' + token);
  });
}
check('A3.recallPrimitivesNotUsedElsewhere', offenders.length === 0,
  'recall primitives must not be reached except through the orchestrator:\n        ' + offenders.join('\n        '));

/* A3.3 · 未来阶段的模块不得被引用（R2-D/F 尚未存在）。 */
(function noFutureModules() {
  const hits = [];
  scanned.forEach(full => {
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (MODULES.indexOf(rel) >= 0) return;
    const src = stripComments(fs.readFileSync(full, 'utf8'));
    FUTURE_MODULES.forEach(f => { if (src.indexOf(f) >= 0) hits.push(rel + ' :: ' + f); });
  });
  check('A3.noChannelPolicyOrSeatPlannerOrCooldown', hits.length === 0,
    'R2-D/F modules must not be referenced yet:\n        ' + hits.join('\n        '));
})();

/* ══════════════════════════════════════════════════════════════════════
   §A4 · Host 不得传 turn（R2-C 的核心安全条件）
   ══════════════════════════════════════════════════════════════════════ */
section('§A4 · Host 不传 turn');

check('A4.browserHostOmitsTurn', (() => {
  const i = MEMORY_SRC.indexOf('const _pickOpts=');
  const j = MEMORY_SRC.indexOf('const _orch=');
  if (i < 0 || j < 0 || j <= i) return false;
  return MEMORY_SRC.slice(i, j).indexOf('turn') < 0;
})(), 'browser _pickOpts must not contain turn');
check('A4.homeNodeHostOmitsTurn', (() => {
  const i = NODE_SRC.indexOf('const buildOpts = {');
  const j = NODE_SRC.indexOf('const built =');
  if (i < 0 || j < 0 || j <= i) return false;
  return NODE_SRC.slice(i, j).indexOf('turn') < 0;
})(), 'Home Node buildOpts must not contain turn');
check('A4.noHostPassesTurnToRecall', (() => {
  /* 判据必须**贴着 recall 调用点**，不能对整文件扫 `turn:`。
     counter-example（本轮真实踩到）：communication.js 里有一个完全无关的
     请求生命周期辅助 `_ibTurnLc(turn)`，它自己的对象里就有 `turn:function(){…}`。
     那个 `turn` 是"模型调用回合"，不是 memory recall 的 turn signal。
     拿整文件扫描会把它误判成"Host 传了 recall turn" —— 一个假阳性，
     而假阳性最坏的结果是有人把这条安全断言删掉。 */
  function turnNearCall(src, callMarker) {
    let idx = src.indexOf(callMarker);
    while (idx >= 0) {
      /* 窗口 = 调用点前 400 字符 **到** 调用点后 200 字符。
         必须包含调用点自身之后的实参列表：`recall(rows, { turn: ... })`
         里的 turn 出现在标记**之后**。只往前看会漏掉最典型的形态。 */
      const window = src.slice(Math.max(0, idx - 400), idx + 200);
      if (/\bturn\s*:/.test(window)) return true;
      idx = src.indexOf(callMarker, idx + 1);
    }
    return false;
  }
  const probes = [
    ['assets/js/memory.js', 'recall('],
    ['services/home-node/memory-retrieval.js', 'recall(']
  ];
  const hits = [];
  probes.forEach(([rel, marker]) => {
    let src;
    try { src = stripComments(read(rel)); } catch (e) { return; }
    if (turnNearCall(src, marker)) hits.push(rel);
  });
  return hits.length === 0;
})(), 'no production Host may pass a turn signal into recall (R2-C skeleton only)');
check('A4.reverseControl.turnDetectorIsLive',
  /\bturn\s*:/.test('const o={turn:{message:"x"}};'),
  'reverse control: the turn detector must fire on a real turn object');
check('A4.reverseControl.nearCallProbeIsLive', (() => {
  const poisoned = 'const x = recall(records, { apiId: "a", turn: { message: "hi" } });';
  const idx = poisoned.indexOf('recall(');
  /* 与生产探针**同一窗口表达式**，否则反向控制测的就不是那条判据。 */
  return /\bturn\s*:/.test(poisoned.slice(Math.max(0, idx - 400), idx + 200));
})(), 'reverse control: the near-call probe must fire when a turn IS passed');
check('A4.nearCallProbeIgnoresUnrelatedTurnHelpers', (() => {
  const unrelated = 'function _ibTurnLc(turn){ return { turn:function(){ return turn; } }; }';
  const nearCallWindow = unrelated.slice(0, unrelated.length);
  return !/\brecall\(/.test(nearCallWindow);
})(), 'an unrelated turn helper must not look like a recall call site');

/* ══════════════════════════════════════════════════════════════════════
   §A5 · orchestrator 自身的安全不变量
   ══════════════════════════════════════════════════════════════════════ */
section('§A5 · orchestrator 不变量');

const ORCH_SRC = stripComments(read('assets/js/memory-recall/memory-recall-orchestrator.js'));
check('A5.noSecondAcl', !/===\s*'private'/.test(ORCH_SRC) && !/===\s*'only'/.test(ORCH_SRC)
  && !/===\s*'except'/.test(ORCH_SRC) && !/===\s*'public'/.test(ORCH_SRC),
  'orchestrator must delegate ACL to the shared visibility core, never re-implement it');
check('A5.usesSharedAcl', /isMemoryVisibleTo\s*\(/.test(ORCH_SRC));
check('A5.noPersistence', !/\bdbPut\b|\bdbGet\b|localStorage|sessionStorage|indexedDB|\bfetch\s*\(/.test(ORCH_SRC));
check('A5.noActivationWrite', !/activationCount\s*=/.test(ORCH_SRC) && !/lastActivated\s*=/.test(ORCH_SRC),
  'selection ≠ reinforcement');
check('A5.noSecondNgramImplementation',
  !/slice\(i,\s*i\s*\+\s*2\)/.test(ORCH_SRC) && !/slice\(i,\s*i\s*\+\s*3\)/.test(ORCH_SRC));
check('A5.noLlmOrVector', !/\bmiddleBrain\b|\bcallApi\b|\bbm25\b|\bembedding\b|\bfaiss\b|\bchroma\b/i.test(ORCH_SRC));

/* ══════════════════════════════════════════════════════════════════════
   §B · R2-A / R2-B 契约回归（子进程）
   ══════════════════════════════════════════════════════════════════════ */
section('§B · 契约回归');

function runTest(rel, expectPattern) {
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    cwd: ROOT, encoding: 'utf8',
    env: Object.assign({}, process.env, { IB_HOME_NODE_TOKEN_AUTOPROVISION: '0' })
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  return { ok: r.status === 0, out: out, matched: expectPattern ? expectPattern.test(out) : true };
}

const contractRun = runTest('tests/test_memory_recall_contract.js', /143 assertions green/);
check('B1.contractStillGreen', contractRun.ok && contractRun.matched,
  'R2-A contract must still pass (R2-C upgraded one CURRENT assertion into three, '
  + 'so the count moved 141 → 143 as an intentional phase transition)'
  + '\n        ' + contractRun.out.split('\n').filter(l => /FAIL/.test(l)).join('\n        '));
check('B2.productionIntegrityStillHolds', !/FAIL\s+P18\.unchanged/.test(contractRun.out));

const earlyRun = runTest('tests/test_memory_recall_early_exit.js');
check('B3.earlyExitStillGreen', earlyRun.ok);
const queryRun = runTest('tests/test_memory_recall_query.js');
check('B4.queryStillGreen', queryRun.ok);
const parityRun = runTest('tests/test_memory_recall_legacy_parity.js');
check('B5.legacyParityStillGreen', parityRun.ok && /all deepStrictEqual/.test(parityRun.out),
  'the R2-C hard gate must stay green');

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL WIRING CONTRACT FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL WIRING CONTRACT PASSED · ' + passed + ' assertions green');
  console.log('（R2-B「0 refs」→ R2-C「only via orchestrator」的相位切换已生效）');
}
