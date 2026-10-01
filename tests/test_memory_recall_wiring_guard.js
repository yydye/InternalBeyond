'use strict';
/* Internal Beyond · P21-R2-B · Production Wiring Guard + R2-A Contract Regression
   （Node，零依赖，不开浏览器）
   运行：node tests/test_memory_recall_wiring_guard.js

   ══════════════════════════════════════════════════════════════════════════
   本文件回答两个问题，**只回答这两个**：

   §A · 两个新模块（turn-signal / recall-query）确实存在，
        但 **production active path 对它们的引用数为 0**。
        —— 因此"现有 production recall output 与接线前 byte-identical"
           不是一句声明，而是一个可断言的结构事实。

   §B · R2-B 的新模块**没有**破坏 R2-A 的 contract test。
        R2-A 的 CURRENT 断言用于证明某些未来行为尚未进入现有 runtime；
        新增"未接线模块"后它们必须继续成立。本文件把 R2-A 的完整契约测试
        作为子进程跑一遍，把"没被我弄坏"变成可重复的检查而不是一句保证。

   为什么扫描要**剥注释**：R2-B 的模块头、契约文档与测试都在注释/字符串里
   反复提到这些名字。裸词扫描会把"文档在描述它"误判成"生产在调用它"——
   这个仓库已经在这条教训上栽过（见 test_p22_20 §7 / test_p22_21 T5 的注释）。
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

const read = rel => {
  const p = path.join(ROOT, rel);
  assert.ok(fs.existsSync(p), 'required file missing: ' + rel);
  return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
};
/* 剥注释但**保留字符串字面量**：我们要抓的是"代码里的引用"，
   而一个 require('…') 的路径就在字符串里。 */
const stripComments = s => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const NEW_MODULES = [
  'assets/js/memory-recall/turn-signal.js',
  'assets/js/memory-recall/recall-query.js'
];
const NEW_NAMES = [
  'IBMemoryRecallTurnSignal',
  'IBMemoryRecallQuery',
  'memory-recall/turn-signal',
  'memory-recall/recall-query'
];
const NEW_FUNCS = ['analyzeTurnSignal', 'buildRecallQuery'];

const PRODUCTION_DIRS = ['assets/js', 'services', 'bridge', 'runtime', 'game'];
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
   §A · Production Wiring Guard
   ══════════════════════════════════════════════════════════════════════ */
section('§A · Production wiring guard');

/* A0 · 两个模块确实存在，且确实是可加载的纯模块。 */
NEW_MODULES.forEach(rel => {
  const p = path.join(ROOT, rel);
  check('A0.moduleExists.' + rel, fs.existsSync(p), rel + ' must exist');
});
const TS = require(path.join(ROOT, NEW_MODULES[0]));
const Q = require(path.join(ROOT, NEW_MODULES[1]));
check('A0.turnSignalLoadable', typeof TS.analyzeTurnSignal === 'function');
check('A0.recallQueryLoadable', typeof Q.buildRecallQuery === 'function');
check('A0.modulesAreDirectoriesUnderMemoryRecall',
  NEW_MODULES.every(rel => rel.startsWith('assets/js/memory-recall/')));

/* A1 · InternalBeyond.html 没有新增 script。 */
const htmlSrc = read(HTML);
const htmlNoComments = stripComments(htmlSrc);
NEW_NAMES.forEach(n => {
  check('A1.htmlDoesNotReference.' + n, htmlNoComments.indexOf(n) < 0,
    HTML + ' must not reference ' + n);
});
check('A1.htmlHasNoMemoryRecallScriptTag',
  !/<script[^>]*memory-recall[^>]*>/i.test(htmlNoComments),
  'no <script> may load a memory-recall module');
/* 反向控制：证明这条判据真的能看见 script 标签。 */
check('A1.reverseControl.detectorSeesScriptTags',
  /<script[^>]*src=/i.test(htmlNoComments),
  'reverse control: the detector must be able to see real <script src> tags');

/* A2 · 关键生产文件逐个不得引用。 */
const KEY_FILES = [
  'assets/js/memory.js',
  'assets/js/communication.js',
  'assets/js/home-node-bootstrap.js',
  'services/home-node/memory-retrieval.js',
  'assets/js/memory-retrieval-core.js',
  'assets/js/memory-visibility-core.js',
  'assets/js/memory-contract.js',
  'assets/js/memory-authority.js'
];
KEY_FILES.forEach(rel => {
  const src = stripComments(read(rel));
  NEW_NAMES.concat(NEW_FUNCS).forEach(n => {
    check('A2.noRef.' + rel + '.' + n, src.indexOf(n) < 0,
      rel + ' must not reference ' + n);
  });
});

/* A3 · 整个生产面（assets/js + services + bridge + runtime + game）零引用。
      两个新模块自身除外 —— 它们当然包含自己的函数名。 */
const scanned = [];
PRODUCTION_DIRS.forEach(d => {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full)) walkJs(full, scanned);
});
check('A3.scannedEnoughFiles', scanned.length > 200,
  'the sweep must actually cover the production surface (scanned ' + scanned.length + ')');

const offenders = [];
for (const full of scanned) {
  const rel = path.relative(ROOT, full).replace(/\\/g, '/');
  if (NEW_MODULES.indexOf(rel) >= 0) continue;   /* 自我引用不算 */
  const src = stripComments(fs.readFileSync(full, 'utf8'));
  for (const n of NEW_NAMES.concat(NEW_FUNCS)) {
    if (src.indexOf(n) >= 0) { offenders.push(rel + ' :: ' + n); break; }
  }
}
check('A3.zeroProductionCallers', offenders.length === 0,
  'production must not call the new modules:\n        ' + offenders.join('\n        '));

/* A3b · 反向控制：如果生产文件里真的出现引用，扫描必须能发现。
      做法：把一段真实引用注入到内存中的副本里，验证同一套判据会命中。
      **不写任何文件** —— 判据本身必须是可证伪的。 */
(function reverseControl() {
  const probe = 'const x = require("../../assets/js/memory-recall/recall-query.js");';
  const probeCore = stripComments(probe);
  const detected = NEW_NAMES.some(n => probeCore.indexOf(n) >= 0) || NEW_FUNCS.some(n => probeCore.indexOf(n) >= 0);
  check('A3b.reverseControl.detectorIsLive', detected,
    'the reference detector must actually fire on a real reference');
  /* 再证一次：把注入内容混进一个真实生产文件的文本副本，判据必须报出来。 */
  const realSrc = stripComments(read('assets/js/memory.js'));
  const poisoned = realSrc + '\n' + probe;
  const poisonedDetected = NEW_NAMES.concat(NEW_FUNCS).some(n => poisoned.indexOf(n) >= 0);
  const cleanDetected = NEW_NAMES.concat(NEW_FUNCS).some(n => realSrc.indexOf(n) >= 0);
  check('A3b.reverseControl.poisonedDetected', poisonedDetected,
    'a poisoned copy must be flagged');
  check('A3b.reverseControl.cleanCopyIsClean', cleanDetected === false,
    'the unpoisoned copy must stay clean — proves the sweep is not trivially red');
})();

/* A4 · 行为等价的结构论证：没有调用路径 ⇒ 不可能改变召回结果。
      这里断言的是"路径不存在"，不是"结果看起来一样"——
      后者需要真实运行，而前者在结构上就足以推出结论。 */
check('A4.noImportPathFromProduction', (() => {
  const core = stripComments(read('assets/js/memory-retrieval-core.js'));
  const mem = stripComments(read('assets/js/memory.js'));
  const nodeRetrieval = stripComments(read('services/home-node/memory-retrieval.js'));
  return NEW_NAMES.every(n => core.indexOf(n) < 0 && mem.indexOf(n) < 0 && nodeRetrieval.indexOf(n) < 0);
})(), 'neither browser nor Home Node retrieval can reach the new modules');
check('A4.legacyResultShapeUnchanged', (() => {
  /* 生产仍走**同一份** core 的 buildMemoryContext，其返回形状未被改动。 */
  const core = require(path.join(ROOT, 'assets/js/memory-retrieval-core.js'));
  const built = core.buildMemoryContext([], { apiId: 'role_a', now: 0, random: () => 0, userMessage: '' });
  return built && built.text === '' && Array.isArray(built.selected)
    && built.count === 0 && built.chars === 0 && built.reason === 'no-visible-memory';
})(), 'the live production retrieval entry point is untouched and still returns its frozen shape');

/* ══════════════════════════════════════════════════════════════════════
   §B · R2-A Contract Regression
   ══════════════════════════════════════════════════════════════════════ */
section('§B · R2-A contract regression（以子进程跑完整契约测试）');

const CONTRACT_TEST = 'tests/test_memory_recall_contract.js';
check('B0.contractTestExists', fs.existsSync(path.join(ROOT, CONTRACT_TEST)));

const run = spawnSync(process.execPath, [path.join(ROOT, CONTRACT_TEST)], {
  cwd: ROOT,
  encoding: 'utf8',
  env: Object.assign({}, process.env, { IB_HOME_NODE_TOKEN_AUTOPROVISION: '0' })
});
const contractOut = String(run.stdout || '') + String(run.stderr || '');
check('B1.contractTestStillGreen', run.status === 0,
  'R2-A contract test must still pass (exit ' + run.status + ')'
  + '\n        ' + contractOut.split('\n').filter(l => /FAIL/.test(l)).join('\n        '));
check('B2.contractTestReports141', /141 assertions green/.test(contractOut),
  'R2-A reported 141 assertions — R2-B must not have silently changed that');
/* R2-A 的 CURRENT 断言特别值得单独点名：它们证明未来行为**尚未**进入生产。
   R2-B 增加了两个未接线模块，这些断言必须继续成立。 */
check('B3.currentAssertionsStillHold',
  /PASS\s+R\.currentCalcRelevanceFloorIsOne/.test(contractOut)
  && /PASS\s+R\.currentRelevanceCannotExpressZero/.test(contractOut)
  && /PASS\s+R\.newReasonsAreNotYetInProduction/.test(contractOut),
  'the CURRENT assertions (proving future behaviour has not entered production) must still hold');
check('B4.productionIntegrityStillHolds',
  !/FAIL\s+P18\.unchanged/.test(contractOut),
  'R2-B must not have touched any production memory runtime file');

/* ══════════════════════════════════════════════════════════════════════
   §C · R2-B 自身的新模块也不得被注册进 HTML 的加载顺序
   ══════════════════════════════════════════════════════════════════════ */
section('§C · 模块自我声明与加载顺序');

NEW_MODULES.forEach(rel => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  check('C1.declaresUnwired.' + rel, /implemented but unwired/i.test(src),
    rel + ' must declare its R2-B wiring status');
  check('C2.declaresUmdDualLoad.' + rel,
    /typeof module === 'object'/.test(src) && /module\.exports/.test(src) && /root\.IBMemoryRecall/.test(src),
    rel + ' must keep the shared-core UMD dual-load form');
});
check('C3.turnSignalBrowserGlobal', /root\.IBMemoryRecallTurnSignal = factory\(\)/.test(read(NEW_MODULES[0])));
check('C4.recallQueryBrowserGlobal', /root\.IBMemoryRecallQuery = factory\(/.test(read(NEW_MODULES[1])));

/* ══════════════════════════════════════════════════════════════════════ */

console.log('\n' + '='.repeat(64));
if (failures) {
  console.error('MEMORY RECALL WIRING GUARD FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
  process.exitCode = 1;
} else {
  console.log('MEMORY RECALL WIRING GUARD PASSED · ' + passed + ' assertions green');
}
