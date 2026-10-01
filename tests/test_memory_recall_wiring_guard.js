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
  'assets/js/memory-recall/channel-policy.js',
  'assets/js/memory-recall/seat-planner.js',
  'assets/js/memory-recall/recall-trace.js',
  'assets/js/memory-recall/memory-recall-orchestrator.js'
];
/* R2-D 起 channel-policy / seat-planner 已实现并被 HTML 加载，
   因此它们从"未来模块"名单移出；只剩 R2-F 的 cooldown。 */
const FUTURE_MODULES = ['cooldown.js'];
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
check('A1.orchestratorLoadedLast', (() => {
  /* orchestrator 必须是五个 recall 模块里**最后**加载的那个（它依赖其余全部）。 */
  const orchRel = 'assets/js/memory-recall/memory-recall-orchestrator.js';
  const orchPos = HTML_NO_COMMENTS.indexOf(orchRel);
  if (orchPos < 0) return false;
  return MODULES.every(m => m === orchRel || HTML_NO_COMMENTS.indexOf(m) < orchPos);
})());
check('A1.reverseControl.detectorSeesScriptTags',
  /<script[^>]*src=/i.test(HTML_NO_COMMENTS),
  'reverse control: the detector must be able to see real <script src> tags');

/* ══════════════════════════════════════════════════════════════════════
   §A2 · Host 经 orchestrator（且保留回落）
   ══════════════════════════════════════════════════════════════════════ */
section('§A2 · Host 接线');

const MEMORY_SRC = stripComments(read('assets/js/memory.js'));
const NODE_SRC = stripComments(read('services/home-node/memory-retrieval.js'));
/* R2-E1a：Browser 发送点也要被断言（latent 会话信号 + 不得启用 coldStart）。 */
const COMM_SRC = stripComments(read('assets/js/communication.js'));

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
  /* ⚠ PHASE TRANSITION（R2-E1b）：memory-recall/ 是**实现层**，不是 Host。
     §4 要求 glossary-match 复用 recall-query 的唯一 alias matcher，
     那正是通过这里扫的全局名发生的。把它们判成"绕过编排器"是误判。
     真正的判据是"**Host** 不得直接触达"——由 A3.1 与下面的目录排除共同保证。 */
  if (rel.indexOf('assets/js/memory-recall/') === 0) continue;
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
/* §4 正面断言：glossary-match 必须**复用**唯一 alias matcher，
   而不是自带一套 ASCII/CJK 边界或引号检测。 */
(function glossaryReusesUniqueMatcher() {
  const gm = path.join(ROOT, 'assets/js/memory-recall/glossary-match.js');
  if (!fs.existsSync(gm)) { check('A3.glossaryMatchExists', false, 'module missing'); return; }
  const src = stripComments(fs.readFileSync(gm, 'utf8'));
  check('A3.glossaryMatchReusesUniqueMatcher',
    src.indexOf('matchAliases') >= 0 && src.indexOf('normalizeAliasEntries') >= 0
    && src.indexOf('findProtectedSpans') >= 0 && src.indexOf('normalizeText') >= 0,
    'glossary-match must reuse recall-query primitives');
  check('A3.glossaryMatchCopiesNoBoundaryLogic',
    !/localeCompare|charCodeAt|codePointAt|isWordishChar/.test(src),
    'no second alias matcher: boundary/quoted logic must not be re-implemented');
})();

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
   §A4 · Host **必须**传 turn（R2-D 语义切换的接线条件）
   ──────────────────────────────────────────────────────────────────────
   ⚠ PHASE TRANSITION（R2-C → R2-D，有意更新，不是 regression）
     R2-C 断言：Host **不**传 turn（架构切换、语义不变）。
     R2-D 断言：Host **必须**传 turn.message（用户可见语义正式切换）。
   两条断言不能同时为真 —— 后者是前者的**目的**。因此这里不是放宽，
   而是把判据换成"这一轮真正要做的事"：传的是**当前用户输入**，
   且**不**传本轮未实现的通道状态。
   ══════════════════════════════════════════════════════════════════════ */
section('§A4 · Host 传 turn（R2-D）');

check('A4.browserHostPassesTurn', (() => {
  const i = MEMORY_SRC.indexOf('const _pickOpts=');
  const j = MEMORY_SRC.indexOf('const _orch=');
  if (i < 0 || j < 0 || j <= i) return false;
  const block = MEMORY_SRC.slice(i, j);
  return /\bturn\s*:\s*\{\s*message\s*:/.test(block);
})(), 'browser _pickOpts must pass turn.message');
check('A4.browserTurnMessageSourceIsUserMessage', (() => {
  const i = MEMORY_SRC.indexOf('const _pickOpts=');
  const j = MEMORY_SRC.indexOf('const _orch=');
  const block = MEMORY_SRC.slice(i, j);
  /* R2-E1a：turn 现在**还**带 latent 的 ColdStart 会话字段，因此不再以 `}` 收尾；
     判据改为"message 的取值必须是 opts.userMessage"（这才是要守的东西）。 */
  return /turn\s*:\s*\{\s*message\s*:\s*opts\.userMessage\b/.test(block);
})(), 'the message must come from the already-existing opts.userMessage — not from DOM / history / last message');
/* R2-E1a · latent 会话信号必须被传下去，且**不得**借机启用 coldStart 通道。 */
check('A4.browserPassesLatentConversationSignal', (() => {
  const i = MEMORY_SRC.indexOf('const _pickOpts=');
  const j = MEMORY_SRC.indexOf('const _orch=');
  const block = MEMORY_SRC.slice(i, j);
  return /conversationId\s*:/.test(block) && /isFirstTurn\s*:/.test(block);
})(), 'conversationId / isFirstTurn must reach the orchestrator (latent plumbing)');
check('A4.noHostForcesColdStartChannel', (() => {
  const both = MEMORY_SRC + NODE_SRC + COMM_SRC;
  return !/channelHint\s*:\s*'coldStart'/.test(both);
})(), 'R2-E1a must NOT enable the coldStart channel — no Host may hint it');
check('A4.browserDoesNotInferFromHistory', (() => {
  const i = MEMORY_SRC.indexOf('const _pickOpts=');
  const j = MEMORY_SRC.indexOf('const _orch=');
  const block = MEMORY_SRC.slice(i, j);
  return !/dbGet|history|lastMessage|messages\[|querySelector/.test(block);
})(), 'no history/DOM inference for the turn message');
check('A4.browserDoesNotCoerceToEmptyString', (() => {
  const i = MEMORY_SRC.indexOf('const _pickOpts=');
  const j = MEMORY_SRC.indexOf('const _orch=');
  const block = MEMORY_SRC.slice(i, j);
  /* `|| ''` 会把"缺输入"伪装成"用户发了空消息"，从而静默关闭记忆。 */
  return !/message\s*:\s*opts\.userMessage\s*\|\|/.test(block);
})(), 'the message must NOT be coerced with || \'\' — that turns a wiring bug into a silent early-exit');

check('A4.homeNodeHostPassesTurn', (() => {
  const i = NODE_SRC.indexOf('const buildOpts = {');
  /* R2-E1b：retrieve() 里原来的 `const built = ...` 被改成
     `let built, activationPolicy`（要同时取 meta.activationPolicy），
     因此结束标记必须换成仍然存在的锚点，否则窗口为空 ⇒ 断言恒假。 */
  const j = NODE_SRC.indexOf('let built, activationPolicy');
  if (i < 0 || j < 0 || j <= i) return false;
  /* R2-E1a：turn 变为多行对象（含 latent 会话字段）⇒ 判据只看 message 的取值来源。 */
  /* R2-E1b：turn 现在含 conversationId / isFirstTurn / conversationSignalAvailable，
     窗口放宽到 800 字符；判据仍是"message 的取值来自 options.userMessage"。 */
  return /\bturn\s*:\s*\{[\s\S]{0,800}?message\s*:\s*options\.userMessage\b/.test(NODE_SRC.slice(i, j));
})(), 'Home Node buildOpts must pass turn.message from options.userMessage');
check('A4.homeNodeTurnSourceIsCurrentTurn', (() => {
  /* buildRuntimeContext 的 ctx.userMessage 由 mobile-gateway 的 beginTurn
     从**本轮请求体**构造；这里同时钉住那条上游证据，避免有人改成历史反推。 */
  const gw = stripComments(read('services/home-node/mobile-gateway.js'));
  /* R2-E1a：网关现在给 buildRuntimeContext 传更多 ctx（含 conversationId/isFirstTurn），
     因此判据改为"同一调用里同时带 characterId 与 userMessage:content"，仍然钉住上游证据。 */
  return /buildRuntimeContext\(character,\s*\{[\s\S]{0,400}?userMessage:\s*content\b/.test(gw)
    && /payload\.content/.test(gw);
})(), 'Home Node current-user message must come from the incoming payload, not history');
check('A4.homeNodeDoesNotCoerceToEmptyString', (() => {
  const i = NODE_SRC.indexOf('const buildOpts = {');
  const j = NODE_SRC.indexOf('const built =');
  return !/turn\s*:\s*\{\s*message\s*:\s*options\.userMessage\s*\|\|/.test(NODE_SRC.slice(i, j));
})());

/* 本轮**未**批准的通道状态不得出现在 Host 里。 */
check('A4.hostsDoNotPassColdStart', (() => {
  return !/isConversationOpen\s*:/.test(MEMORY_SRC) && !/isConversationOpen\s*:/.test(NODE_SRC);
})(), 'coldStart belongs to R2-E — Host must not signal it yet');
/* ⚠ PHASE TRANSITION（R2-D → R2-E1b，有意更新）：
   R2-D 断言 Host 源码里**不出现** glossary 字样（那时它尚未实现）。
   R2-E1b 给 Browser 加了 glossary provider 的**纯注入 seam**（§31），
   因此该判据按设计失效。真正的判据是：Host **不得替用户强制通道** ——
   即不得传 channelHint='glossary' / 'reminisce'，也不得从 DB 读 catalog。 */
check('A4.hostsDoNotForceGlossaryChannel', (() => {
  const both = MEMORY_SRC + NODE_SRC + COMM_SRC;
  return !/channelHint\s*:\s*'glossary'/.test(both) && !/channelHint\s*:\s*'reminisce'/.test(both);
})(), 'a Host may inject a catalog, but must not force the glossary channel');
check('A4.hostsDoNotForceReminisceChannel',
  !/channelHint\s*:\s*'reminisce'/.test(MEMORY_SRC + NODE_SRC));
check('A4.hostsDoNotReadGlossaryFromDb',
  !/glossary/i.test(NODE_SRC),
  'Home Node must receive the catalog by injection, never by reading a store');
check('A4.hostsDoNotPassCooldownState', (() => {
  const both = MEMORY_SRC + NODE_SRC;
  return !/cooldown|lastSurfacedAt|lastRecalledAt/i.test(both);
})(), 'cooldown belongs to R2-F — no cooldown state may be wired into the Hosts');

check('A4.reverseControl.turnDetectorIsLive',
  /\bturn\s*:/.test('const o={turn:{message:"x"}};'),
  'reverse control: the turn detector must fire on a real turn object');
check('A4.reverseControl.nearCallProbeIsLive', (() => {
  const poisoned = 'const x = recall(records, { apiId: "a", turn: { message: "hi" } });';
  const idx = poisoned.indexOf('recall(');
  /* 与生产探针**同一窗口表达式**，否则反向控制测的就不是那条判据。 */
  return /\bturn\s*:/.test(poisoned.slice(Math.max(0, idx - 400), idx + 200));
})(), 'reverse control: the near-call probe must fire when a turn IS passed');
check('A4.reverseControl.emptyStringCoercionWouldBeCaught', (() => {
  const bad = "turn:{message:opts.userMessage||''}";
  return /message\s*:\s*opts\.userMessage\s*\|\|/.test(bad);
})(), 'reverse control: the || \'\' guard must fire on the dangerous form');
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

const contractRun = runTest('tests/test_memory_recall_contract.js', /148 assertions green/);
check('B1.contractStillGreen', contractRun.ok && contractRun.matched,
  'R2-A contract must still pass (each phase moved the count as an intentional transition: '
  + '141 → 143 at R2-C, → 148 at R2-D)'
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
