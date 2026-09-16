/* ====================================================================
   M1-C.2i · 对照证明（counter-proof）
   --------------------------------------------------------------------
   目的：证明 test_middle_brain_convergence.js 的断言**真的有鉴别力**，
   而不是"因为函数被调用了所以绿"。

   做法（与"临时把实现改坏、看测试变红、再改回来"同一目的，但更安全）：
     ① 把工作区里**与本题相关的那几个文件**复制到一个临时目录；
     ② 在其中一处做**单向弱化**（模拟真正的漂移形态，不是删测试）；
     ③ 把 tests/ 也复制过去，在临时副本里跑同一份收敛测试；
     ④ 断言它**变红**，并断言红的是**预期的那些**断言；
     ⑤ 删掉临时目录。

   为什么不就地改坏再改回来：本仓库有多个并行会话与认领协议，就地改坏会短暂地
   让工作区处于"错的"状态。副本法没有这个窗口，而且可以一次跑多个变体。

   五个变体（对应任务书要求的五条对照证明）：
     B1 Home Node 绕开 middleBrainExecute      → 上下文/策略类断言必须红
     B2 Home Node 用另一个思考深度决策          → reasoningEffort 类断言必须红
     B3 integrity / OOC 结果被丢掉              → finalize 类断言必须红
     B4 Android（payload）能覆盖执行策略        → forge 类断言必须红
     B5 凭据被投影到设备面                      → secret 类断言必须红

   纪律：不触网、不写生产目录、不改工作区、结束时清理临时目录。
   ==================================================================== */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}

/* 只复制相关文件：整个工作区有 .venv / browser-data / dist 等大目录，
   全量拷贝既慢又没必要。 */
const COPY_FILES = [
  'assets/js/chat-core.js',
  'assets/js/context-snapshot.js',
  'assets/js/ib-model-core.js',
  'assets/js/memory-contract.js',
  'assets/js/memory-retrieval-core.js',
  'assets/js/memory-visibility-core.js',
  /* M1-C.2k：线索派生的唯一实现（浏览器与 Home Node 共用）。收敛测试的基线会
     经 services/home-node-service.js → mobile-gateway → thread-retrieval 触到它，
     因此副本里缺了它基线就跑不起来（表现为 base.copyIsGreen 无摘要地变红）。 */
  'assets/js/thread-derivation-core.js',
  /* M1-C.2m：理解派生的共享核心 + canonical 理解域的三个组件。
     同一类依赖：基线经 home-node-service 的 understandingAssembly
     → understanding-{store,derivation,retrieval} 触到它们，
     缺一个 `require` 就会抛 MODULE_NOT_FOUND，表现为基线无摘要变红。 */
  'assets/js/understanding-derivation-core.js',
  'services/home-node/understanding-store.js',
  'services/home-node/understanding-derivation.js',
  'services/home-node/understanding-retrieval.js',
  /* M1-C.2n：动态可见性的共享核心 + canonical 动态域的两个组件。
     **同一类依赖**（第三次出现）：基线经 home-node-service 的 momentsAssembly
     → moments-{store,retrieval} → moments-visibility-core 触到它们，
     缺一个 `require` 就抛 MODULE_NOT_FOUND，表现为基线无摘要变红。
     M1-C.2m 已经因此红过一次，所以这次一并补上，而不是等它在 CI 上复现。 */
  'assets/js/moments-visibility-core.js',
  'services/home-node/moments-store.js',
  'services/home-node/moments-retrieval.js',
  /* M1-C.2o：对话证据的共享核心。
     **同一类依赖**（第四次出现）：基线经 home-node-service →
     services/home-node/middle-brain.js 的 `require(ASSETS_JS/dialogue-core.js)`
     触到它，缺了就抛 MODULE_NOT_FOUND，表现为基线无摘要变红。
     M1-C.2m / M1-C.2n 各因此红过一次 —— 这次同样一并补上，不等它复现。 */
  'assets/js/dialogue-core.js',
  'assets/js/middle-brain-config-core.js',
  'assets/js/middle-brain-config.js',
  'assets/js/middle-brain-policy.js',
  'assets/js/middle-brain-astra.js',
  'assets/js/middle-brain-judge.js',
  'assets/js/middle-brain-integrity.js',
  'assets/js/middle-brain.js',
  'assets/js/mobile-dto.js',
  'assets/js/home-node-client.js',
  'assets/js/home-node-bootstrap.js',
  'assets/js/provider-directory.js',
  'services/home-node-service.js',
  'services/home-node/chat-store.js',
  'services/home-node/device-registry.js',
  'services/home-node/execution.js',
  'services/home-node/http.js',
  'services/home-node/memory-retrieval.js',
  /* M1-C.2k：线索派生器（与记忆共用 canonical memory store）。 */
  'services/home-node/thread-retrieval.js',
  'services/home-node/memory-store.js',
  'services/home-node/middle-brain.js',
  'services/home-node/mobile-gateway.js',
  'services/home-node/p0-context.js',
  'active/node-model-port.js',
  /* P22-15C note: these Economy files are only *loaded* in the copy (home-node-service's
     require graph needs them). This file never mutates any of them — the only mutation
     targets are execution.js / mobile-gateway.js / middle-brain-config-core.js. */
  /* ── P22-15C：以下九个是**闭包算出来的**，不是又一轮人工补名单 ──────────
     P11-3X-B（67c59be）给 home-node 的各 store 与装配层加了
     `require('../../runtime/db-failure.js')`（唯一一处数据库失败分类器），
     P22-2/9~14 又让装配层 require 了 Economy 的六个生产文件。
     本文件的 COPY_FILES 是人工维护的，没跟上 → 基线副本
     `Cannot find module '../../runtime/db-failure.js'`（MODULE_NOT_FOUND）
     → 收敛测试在真断言之前中止 → 0 passed / 11 failed 的**假红**。
     这里把它们显式登记（下面的 closure 判据会持续守住"不许再漏"）。 */
  'runtime/db-failure.js',
  'runtime/service-control.js',
  'services/home-node/economy-store.js',
  'services/home-node/economy-capability.js',
  'services/home-node/economy-action-adapter.js',
  'services/home-node/economy-command-channel.js',
  'services/home-node/economy-approval-decision.js',
  'services/home-node/economy-configuration.js',
  'services/home-node/economy-contract.js',
  'tests/test_middle_brain_convergence.js'
];

const tempDirs = [];

/* ── P22-15C：COPY_FILES 不再只靠人工维护 ─────────────────────────────
   这个清单是**人工**长的，而生产依赖是自动长的 —— P11-3X-B（67c59be）给
   chat-store / device-registry / memory-store / home-node-service 加了
   `require('../../runtime/db-failure.js')`，清单没跟上。后果不是一条断言变红，
   而是**基线副本连模块都加载不了**：

       Error: Cannot find module '../../runtime/db-failure.js'
       Require stack: .../services/home-node/chat-store.js  (MODULE_NOT_FOUND)

   于是收敛测试在真断言之前就中止 → '(no summary)' → base.copyIsGreen 与
   五个变体的 turnsRed / redAreTheExpectedOnes 一起红（0 passed / 11 failed），
   而生产侧的收敛其实完全正常。**假红**是最坏的一种红：它让人以为被测系统坏了。

   修法不是"再补一个文件名"（下一个新依赖会再来一次），而是让副本集**自维护**：
   从 COPY_FILES 出发做一次**相对 require 闭包**（只在本仓库内解析，裸模块说明符
   与 node: 内置一律跳过），把缺口并进来。清单仍然保留 —— 它是"种子"，
   而种子决定这次复制**只为哪些文件做对照证明**。 */
const COPY_DIRS = ['assets/js/', 'services/home-node/', 'services/', 'runtime/', 'active/', 'tests/'];

function requiresOf(rel) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');
  /* 只在本仓库的源码目录里解析：裸说明符（包名 / node: 内置）在闭包里没有意义，
     而越出这些目录的路径本来就不该出现在生产 require 里（出现了要另立一条断言）。 */
  if (!COPY_DIRS.some(d => rel.indexOf(d) === 0)) return [];
  const out = [];
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(raw))) {
    const head = raw.slice(0, m.index);
    /* 与 tests/test_p22_1_economy_boundary.js 的 scanRequires 同口径：注释里的
       require 字样不是依赖（这个仓库的解释性注释极多，误判的代价是删解释）。 */
    if (head.slice(head.lastIndexOf('\n') + 1).indexOf('//') >= 0) continue;
    if (head.lastIndexOf('/*') > head.lastIndexOf('*/')) continue;
    if (!/^\.{1,2}\//.test(m[1])) continue;
    out.push(m[1]);
  }
  return out;
}
function resolveRelative(fromRel, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const cand of [base, base + '.js', base + '/index.js']) {
    const abs = path.join(ROOT, cand);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return cand;
  }
  return null;
}
/* 返回 { files, added }：files = 种子 ∪ 闭包（保持种子顺序，新增项按发现顺序）。 */
function copyClosure() {
  const files = COPY_FILES.slice();
  const known = new Set(files);
  const added = [];
  const queue = files.slice();
  while (queue.length) {
    const rel = queue.shift();
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    for (const spec of requiresOf(rel)) {
      const target = resolveRelative(rel, spec);
      if (!target || known.has(target)) continue;
      known.add(target);
      files.push(target);
      added.push(rel + ' -> ' + target);
      queue.push(target);
    }
  }
  return { files: files, added: added };
}
const CLOSURE = copyClosure();

function mirrorWorkspace(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cp-' + tag + '-'));
  tempDirs.push(dir);
  for (const rel of CLOSURE.files) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return dir;
}

/* 读文件（剥 BOM）→ 替换一段**必须存在**的文本 → 写回（补 BOM，与仓库编码约定一致）。 */
function mutate(dir, rel, from, to) {
  const file = path.join(dir, rel);
  const raw = fs.readFileSync(file);
  const hadBom = raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF;
  let text = raw.toString('utf8').replace(/^\uFEFF/, '');
  if (!text.includes(from)) throw new Error('mutation anchor not found in ' + rel + ': ' + JSON.stringify(from.slice(0, 60)));
  text = text.replace(from, to);
  fs.writeFileSync(file, Buffer.concat([hadBom ? Buffer.from([0xEF, 0xBB, 0xBF]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]));
}

/* 在临时副本里跑收敛测试，返回 { exitCode, failedNames, passedCount, failedCount, hasSummary, summary, output }。
   P22-15C：把"跑到了真断言"变成可断言的读数 —— 只看 exitCode !== 0 的话，
   一次 MODULE_NOT_FOUND 崩溃与"断言真的红了"完全无法区分（这正是本次假红的形状）。 */
function runConvergence(dir) {
  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync(process.execPath, [path.join(dir, 'tests', 'test_middle_brain_convergence.js')], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
    });
  } catch (error) {
    exitCode = error.status == null ? 1 : error.status;
    output = String(error.stdout || '') + String(error.stderr || '');
  }
  const failedNames = (output.match(/\u2718\s+([A-Za-z0-9_.]+)/g) || [])
    .map(s => s.replace(/^\u2718\s+/, '').trim());
  const summary = output.match(/(\d+) passed, (\d+) failed/);
  return {
    exitCode: exitCode,
    failedNames: failedNames,
    passedCount: summary ? Number(summary[1]) : 0,
    failedCount: summary ? Number(summary[2]) : 0,
    hasSummary: !!summary,
    summary: summary ? summary[0] : '(no summary)',
    output: output
  };
}

function reportsAny(names, prefixes) {
  return prefixes.some(p => names.some(n => n === p || n.startsWith(p)));
}

function main() {
  console.log('M1-C.2i counter-proof (each variant runs the convergence test on a mutated copy)\n');

  /* 先证明"未变异的副本是绿的" —— 否则后面每一条"变红"都没有意义
     （红的可能是环境问题，而不是我们改坏的那一处）。 */
  const baselineDir = mirrorWorkspace('baseline');
  const baseline = runConvergence(baselineDir);
  check('base.copyIsGreen', baseline.exitCode === 0 && baseline.failedNames.length === 0,
    { exit: baseline.exitCode, failed: baseline.failedNames, summary: baseline.summary });
  /* P22-15C：绿还不够 —— 必须绿在**真断言**上。
     崩溃（MODULE_NOT_FOUND / 语法错误 / 找不到文件）只会给出 '(no summary)'，
     以前它与"断言真的红了"长得一模一样，于是五个变体一起变成假绿或假红。
     这里把"跑到过断言"变成独立判据：pass>0 且 failed=0 且 exit=0。 */
  check('base.ranRealAssertions', baseline.hasSummary && baseline.passedCount > 0 && baseline.failedCount === 0,
    { summary: baseline.summary, exit: baseline.exitCode, tail: baseline.output.split(/\r?\n/).slice(-6) });
  /* 副本集自维护：闭包缺一个相对依赖 → 基线连模块都加载不了（本次的根因）。 */
  check('base.copyClosureIsComplete', CLOSURE.added.length === 0,
    { addedByClosure: CLOSURE.added });
  console.log('  baseline: ' + baseline.summary + '  [copyFiles=' + CLOSURE.files.length
    + ' closureAdded=' + CLOSURE.added.length + ']\n');

  const variants = [
    {
      id: 'B1',
      name: 'Home Node 绕开 canonical 执行缝（注入契约恒 false）',
      expect: ['inject.', 'finalize.', 'forge.policy', 'fail.'],
      expectedRed: '上下文/注入类断言',
      apply: (dir) => mutate(dir, 'services/home-node/execution.js',
        '      if (!result || result.applied !== true) return false;',
        '      if (!result || result.applied !== true) return false;\n      return false; /* COUNTER-PROOF B1: 故意永不允许注入 */')
    },
    {
      id: 'B2',
      name: 'Home Node 用另一个思考深度决策（恒定 low）',
      expect: ['parity.reasoningEffortDecision', 'wire.reasoningEffortSemantic', 'forge.effortImmune'],
      expectedRed: 'reasoningEffort 类断言',
      apply: (dir) => mutate(dir, 'services/home-node/execution.js',
        "            mbReasoningEffort = String((await middleBrain.reasoningEffort()) || 'auto');",
        "            mbReasoningEffort = 'low'; /* COUNTER-PROOF B2: 故意用另一个档位 */")
    },
    {
      id: 'B3',
      name: '生成后执行缝（OOC/Integrity）结果被丢掉',
      expect: ['finalize.rewriteReachesCanonicalStore', 'finalize.rewriteIsLabelled'],
      expectedRed: 'integrity 类断言',
      apply: (dir) => mutate(dir, 'services/home-node/execution.js',
        '          const finalized = await middleBrain.finalizeReply(Object.assign({}, mbCtx, { candidate: text }));',
        '          const finalized = { reply: text, ran: false, rewritten: false }; /* COUNTER-PROOF B3 */')
    },
    {
      id: 'B4',
      name: 'Android（payload）可以覆盖执行策略',
      expect: ['forge.effortImmune', 'forge.payloadFieldRemovedAtParse', 'parity.reasoningEffortDecision'],
      expectedRed: '伪造请求类断言',
      apply: (dir) => mutate(dir, 'services/home-node/mobile-gateway.js',
        '        maxTokens: numOrNull(spec.maxTokens),',
        '        reasoningEffort: payload.reasoningEffort,  /* COUNTER-PROOF B4: 重新透传客户端策略 */\n        maxTokens: payload.maxTokens,')
    },
    {
      id: 'B5',
      name: '凭据被投影到设备面（reasoning 之外顺带放行 apiKey）',
      expect: ['secret.', 'proj.'],
      expectedRed: 'secret 类断言',
      apply: (dir) => mutate(dir, 'assets/js/middle-brain-config-core.js',
        '    out.enabled = src.enabled === true;',
        "    out.enabled = src.enabled === true;\n    out.apiKey = String(src.apiKey || ''); /* COUNTER-PROOF B5: 故意把凭据投出去 */\n    out.endpoint = String(src.endpoint || '');")
    }
  ];

  for (const variant of variants) {
    const dir = mirrorWorkspace(variant.id);
    let mutated = true;
    try { variant.apply(dir); }
    catch (error) { mutated = false; check(variant.id + '.mutationApplied', false, String(error && error.message || error)); }
    if (!mutated) continue;

    const result = runConvergence(dir);
    const names = result.failedNames;
    /* P22-15C：这三条把"假红"和"真红"分开。
       ① mutationApplied 已由 apply 不抛错证明（锚点必须存在，否则抛）；
       ② turnsRed 要求**跑到过真断言**（有 summary）且失败数 > 0；
       ③ redAreTheExpectedOnes 要求红的是指名断言。
       旧版只要求 exitCode !== 0 && names.length > 0 —— 崩溃时 exitCode 也是非 0，
       但打印里一条 ✘ 都没有，于是两条断言一起红成"harness 起不来"的样子。 */
    check(variant.id + '.turnsRed',
      result.exitCode !== 0 && result.hasSummary && result.failedCount > 0 && names.length > 0,
      { name: variant.name, exit: result.exitCode, summary: result.summary, failed: names });
    check(variant.id + '.redAreTheExpectedOnes', reportsAny(names, variant.expect),
      { name: variant.name, expected: variant.expectedRed, actuallyRed: names });
    console.log('  ' + variant.id + ' ' + variant.name + ' -> ' + result.summary +
      (names.length ? '  [' + names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '') + ']' : ''));
  }

  console.log('\nM1-C.2i counter-proof: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

try { main(); }
finally {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (_) { /* Windows 句柄未释放时留待系统清理 */ }
  }
}
