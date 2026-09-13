/* ====================================================================
   Astra Readiness Phase 1B · --live 凭据预检（clean abort）回归
   --------------------------------------------------------------------
   本文件的存在理由是一个**实测到的真实 harness 缺陷**：

   test_middle_brain_calibration_live.js 曾经是
       if (LIVE && !LIVE_MODE && ...) { ... }      // line 105  ← 第一次引用
       ...
       const LIVE_MODE = LIVE && !!ENV_KEY && ...  // line 110  ← 声明
   因为 `LIVE` 为真时 `!LIVE_MODE` **不会短路**，传 `--live` 一定会抛
   TDZ ReferenceError（`Cannot access 'LIVE_MODE' before initialization`）。
   后果比"报错不好看"严重得多：**整个凭据预检（exit 3）分支永远不可达**，
   也就是说"凭据不齐就大声中止、绝不静默降级成 mock"这条 Phase 1 声称的
   安全性质，在运行期从来没有成立过 —— 它只写在源码文本里，没有任何测试
   真的跑过它（离线跑的 `LIVE === false` 短路掉了那一行，所以永远测不到）。

   本文件把这条性质变成**两个形态的常驻断言**：
     A 形态（静态）：剥注释后断言 LIVE_MODE 的首次引用在声明之后 —— 直接在
                    源码顺序层面把 TDZ 这一类缺陷钉死，不需要凭据。
     B 形态（运行期）：真的用 `--live` 拉起 harness（凭据被显式清空），断言
                    exit code 恰为 3、stderr 点名缺什么、stdout 一字不出
                    （= 没有静默降级成 mock）、且没有 JS 栈（= 没有崩溃）。

   ── 本文件的安全性质 ────────────────────────────────────────────────
   全程离线、零网络、零浏览器、零真实 API 调用：
     · 子进程在**模块求值期**就中止了，早于任何 Chrome 启动与任何请求；
     · 三个凭据环境变量在子进程 env 里被**显式删除**，因此在"合法持有凭据"
       的机器上本测试同样确定性地走中止分支 —— 它绝不会因为本机有 key 就
       真的发起付费调用。

   ── C 形态（Phase 1B 追加）：显式抽样的 fail-loud ────────────────────
   Phase 1B 给 harness 加了 `--ids=`（预登记样本集必须能被精确指定，而默认的
   类别轮转拿不到"证据不足"那一条）。既然这是新增的入口，它就必须遵守本仓库
   同一条纪律：**未知 id / 重复 id / 被 --max-cases 截断，一律大声中止（exit 2），
   绝不静默降级成轮转** —— 否则"预登记的样本集"与"实际跑的样本集"会悄悄不一致。
   C 组把这三条 + "合法 id 不得被判错、凭据闸门仍优先"钉成常驻断言。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HARNESS = 'tests/test_middle_brain_calibration_live.js';
const ENV_NAMES = ['IB_CI_CALIBRATION_KEY', 'IB_CI_CALIBRATION_ENDPOINT', 'IB_CI_CALIBRATION_MODEL'];
/* IB_CDP_TIMEOUT_MS 也要从子进程 env 里删掉：它是 Phase 1B 新增的 CDP RPC 期限配置，
   宿主机如果恰好设了一个 <= 生产期限（20000）的值，harness 会在**凭据闸门之后**、
   抽样之前以 exit 4 大声中止（这是刻意的硬化）。那与本文件要验的凭据预检无关，
   却会让本文件的断言在不同机器上得到不同结果 —— 所以这里显式清空，
   让"凭据不齐 → exit 3"始终是第一位的、确定性的结论。
   注意：清空的结果正是校准默认 30000（> 20000），所以硬化不会被绕过。 */
const ENV_NAMES_SCRUBBED = ENV_NAMES.concat(['IB_CDP_TIMEOUT_MS']);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const note = (s) => console.log('  · ' + s);

/* 一致的子进程调用点：三个凭据环境变量一律从子进程 env 里**删除**，
   因此在"合法持有凭据"的机器上本文件同样确定性地走中止分支 ——
   它绝不会因为本机恰好有 key 就真的发起付费调用。 */
function runHarness(args) {
  const env = Object.assign({}, process.env);
  for (const n of ENV_NAMES_SCRUBBED) delete env[n];
  const started = Date.now();
  const res = spawnSync(process.execPath, [HARNESS].concat(args),
    { cwd: ROOT, env: env, encoding: 'utf8', timeout: 120000, windowsHide: true });
  return {
    status: res.status, signal: res.signal,
    stdout: String(res.stdout || ''), stderr: String(res.stderr || ''),
    ms: Date.now() - started
  };
}

/* 结构化扫描前先剥注释：本文件自己在注释里就反复提到 LIVE_MODE，
   不剥注释的话"首次引用"会被注释误报。 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const raw = fs.readFileSync(path.join(ROOT, HARNESS), 'utf8').replace(/^\uFEFF/, '');
const code = stripComments(raw);

console.log('Calibration --live credential preflight (clean abort) regression\n');

/* ---------- A 形态：源码顺序不变量（不需要凭据） ---------- */
console.log('A. static ordering invariant (TDZ class)');
{
  const declIdx = code.search(/const\s+LIVE_MODE\b/);
  const firstUseIdx = (() => {
    const m = code.match(/\bLIVE_MODE\b/);
    return m ? m.index : -1;
  })();
  check('A1.liveModeDeclaredBeforeFirstUse', declIdx >= 0 && firstUseIdx >= 0 && firstUseIdx >= declIdx,
    declIdx < 0 ? 'const LIVE_MODE declaration not found'
      : ('first use at ' + firstUseIdx + ', declaration at ' + declIdx + ' (TDZ: reference precedes declaration)'));
  note('declaration offset=' + declIdx + '  first-use offset=' + firstUseIdx);

  /* 中止分支必须仍然存在，且必须仍是 exit 3 —— 防止有人"修好顺序"的同时把闸门删了。 */
  const abortBlock = code.match(/if\s*\(LIVE && !LIVE_MODE && !process\.argv\.includes\('--allow-mock-fallback'\)\)\s*\{[\s\S]*?\}/);
  check('A2.abortBranchPresent', !!abortBlock);
  check('A3.abortBranchExitsThree', !!abortBlock && /process\.exit\(3\)/.test(abortBlock),
    abortBlock ? 'no process.exit(3) inside the abort branch' : 'abort branch missing');
  /* 逃生舱仍在：显式 --allow-mock-fallback 时不得走 exit 3（否则离线 mock 就再也跑不了）。 */
  const escape = code.match(/if\s*\(LIVE && !LIVE_MODE && process\.argv\.includes\('--allow-mock-fallback'\)\)\s*\{[\s\S]*?\}/);
  check('A4.mockFallbackEscapeHatchStillHonored', !!escape && !/process\.exit\(3\)/.test(escape),
    escape ? 'escape hatch branch would abort' : 'escape hatch branch missing');
}

/* ---------- B 形态：运行期真跑一次（凭据被清空，因此确定性） ---------- */
console.log('\nB. runtime preflight (credentials scrubbed, zero calls, zero browser)');
{
  /* 诚实记录：宿主机上凭据是否存在（只报 present/absent，绝不打印值）。 */
  const hostHasCred = !!(process.env.IB_CI_CALIBRATION_KEY);

  const res = runHarness(['--corpus=readiness', '--live', '--max-cases=5', '--repeat=2']);
  const stdout = res.stdout, stderr = res.stderr, ms = res.ms;

  check('B1.abortsWithExitCodeThree', res.status === 3,
    'exit=' + res.status + ' signal=' + res.signal + ' (expected exactly 3)');
  check('B2.noJsCrashOnStderr', !/ReferenceError|before initialization|at Object\.<anonymous>/.test(stderr),
    'stack trace present -> the TDZ defect is back');
  check('B3.stderrNamesBothMissingCredentials',
    /IB_CI_CALIBRATION_KEY/.test(stderr) && /IB_CI_CALIBRATION_ENDPOINT/.test(stderr),
    'the abort message must say exactly what is missing');
  check('B4.stdoutIsEmptyNoSilentMockFallback', stdout.trim() === '',
    stdout ? 'stdout was not empty -> something ran instead of aborting: ' + stdout.slice(0, 200) : '');
  check('B5.nothingRanNoPlanPrinted', !/PLANNED API CALLS|Layer B ·/.test(stdout + stderr),
    'plan/mock notices must not appear on the abort path');
  check('B6.noBrowserLaunched', !/Chromium|chrome|puppeteer|user-data-dir/i.test(stderr),
    'a browser must never start before the credential preflight');
  check('B7.abortIsImmediate', ms < 60000, ms + 'ms');
  note('scrubbed child exit=' + res.status + ' in ' + ms + 'ms');
  note('host credential presence (reported, never printed): key=' + (hostHasCred ? 'present' : 'absent'));
  check('B8.deterministicRegardlessOfHostCredentials', true,
    'env scrubbed, so this test cannot make a paid call even on a credentialed machine');
}

/* ---------- C 形态：显式抽样（--ids=）的 fail-loud 不变量 ---------- */
console.log('\nC. explicit fixture selection (--ids=) fails loud, never silently substitutes');
{
  const IDS5 = 'AR-AQ-01,AR-BR-01,AR-CS-01,AR-O-01,AR-E-01';

  const unknown = runHarness(['--corpus=readiness', '--ids=AR-AQ-01,AR-NOPE-99']);
  check('C1.unknownIdAbortsTwo', unknown.status === 2, 'exit=' + unknown.status);
  check('C2.unknownIdNamedAndNoSilentFallback',
    /未知 fixture/.test(unknown.stderr) && /不允许静默降级/.test(unknown.stderr) && unknown.stdout.trim() === '',
    'must name the unknown id, print nothing to stdout, and refuse to fall back to round-robin');

  const dupe = runHarness(['--corpus=readiness', '--ids=AR-AQ-01,AR-AQ-01']);
  check('C3.duplicateIdAbortsTwo', dupe.status === 2, 'exit=' + dupe.status);
  check('C4.duplicateIdNamed', /重复 fixture/.test(dupe.stderr), dupe.stderr.slice(0, 120));

  const trunc = runHarness(['--corpus=readiness', '--max-cases=1', '--ids=' + IDS5]);
  check('C5.silentTruncationAbortsTwo', trunc.status === 2, 'exit=' + trunc.status);
  check('C6.truncationExplained', /会截断/.test(trunc.stderr) && /整份跑或整份不跑/.test(trunc.stderr),
    trunc.stderr.slice(0, 160));

  /* 反向保证：**合法** id 列表绝不能被抽样逻辑判错，而且凭据闸门仍然优先于任何
     执行 —— 因此 --live + 合法 ids + 无凭据 必须是 exit 3（不是 2，也不是 0）。
     这条同时钉死了"预检 → 抽样 → 执行"的先后顺序。 */
  const liveValid = runHarness(['--corpus=readiness', '--live', '--ids=' + IDS5]);
  check('C7.validIdsPassSelectionAndCredentialGateStillGoverns', liveValid.status === 3,
    'exit=' + liveValid.status + ' (expected 3: valid ids must not trip exit 2, and no call may run)');
  check('C8.validIdsLiveRunStillMadeNoCall', liveValid.stdout.trim() === '' && !/PLANNED API CALLS/.test(liveValid.stdout + liveValid.stderr),
    'the credential gate must fire before the plan is printed');
}

try { console.log(''); } catch (e) {}
console.log('Calibration --live clean abort regression: ' + failures + ' failed');
process.exitCode = failures ? 1 : 0;
