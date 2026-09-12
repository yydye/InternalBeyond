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
  'tests/test_middle_brain_convergence.js'
];

const tempDirs = [];
function mirrorWorkspace(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cp-' + tag + '-'));
  tempDirs.push(dir);
  for (const rel of COPY_FILES) {
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

/* 在临时副本里跑收敛测试，返回 { failedNames, allPassed, output }。 */
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
  console.log('  baseline: ' + baseline.summary + '\n');

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
    check(variant.id + '.turnsRed', result.exitCode !== 0 && names.length > 0,
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
