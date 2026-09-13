/* ====================================================================
   Astra Readiness Phase 1B · CDP RPC 期限 > 生产模型期限（回归）
   --------------------------------------------------------------------
   本文件的存在理由是一个**实测到的真实 harness 缺陷**，形态与
   test_calibration_live_abort.js 记录的 TDZ 那一类完全同构：

   共享 CDP 客户端（tests/test_chat_smoke.js 的 Cdp.send）把
   `Runtime.evaluate` 的期限**硬编码**成 15000 ms。校准 harness 用
   `Runtime.evaluate{awaitPromise:true}` 等在页面里跑完**生产**角色一致性守卫，
   而生产守卫自己在 judge / astra / integrity 三层各挂 20000 ms 的
   AbortController 期限（assets/js/middle-brain-judge.js 的 MB_JUDGE_TIMEOUT_MS）。

   → 客户端期限 < 生产期限 ⇒ 客户端**先**放弃，抛出
     `CDP timeout: Runtime.evaluate`。这个字符串与"模型没回来"长得一模一样，
     于是**观测口径掩盖了生产裁决**：分不清"provider 慢"和"harness 没等够"。

   对照实验（本地延迟端点，无需真实凭据）已经把机制钉死：
       8 s 响应        → 全链路走完，judgeError:null
       >15 s 且 <20 s  → **假 CDP timeout**（客户端先放弃；生产还没说话）
       >20 s           → 生产自己的 judgeError:'timeout'（另一种可区分的失败）

   ── 本文件把修好的性质变成常驻断言（四组）────────────────────────────
     R 组（解析口径）：IB_CDP_TIMEOUT_MS 的合法值生效、非法值安全回落 15000。
     S 组（结构不变量）：**校准侧默认期限 > 生产 MB_JUDGE_TIMEOUT_MS**，
                        而且生产字面量是从**生产源码文本**里读出来的（不是复制常量）。
     W 组（行为证据）：同一个合成"慢" `Runtime.evaluate`，在**两个真实 Cdp 实例**上
                        因为期限不同而**结果相反**：
                          · 默认 15000 客户端 → 必须超时
                          · 校准   30000 客户端 → 必须成功，且等过了 15000 那条线

   ── 本文件的安全性质 ────────────────────────────────────────────────
   全程离线、零网络、零浏览器、零真实 API 调用：
     · 页面侧是**合成 socket**（不是 WebSocket，不过网络栈），
       它只把一条合法的 CDP 响应帧按指定延迟回给客户端；
     · 子进程不 require 生产文件、不发任何请求，只驱动 Cdp 的等待/放弃逻辑。
   ==================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HARNESS = 'tests/test_chat_smoke.js';
const CAL_HARNESS = 'tests/test_middle_brain_calibration_live.js';
const JUDGE_SRC = 'assets/js/middle-brain-judge.js';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};
const note = (s) => console.log('  · ' + s);

/* ── 从 harness 里抽出**共享客户端的真源**：默认常量 + 解析器 + Cdp 类。
      刻意抽取而不是复制：复制一份就等于把"两处必须一致"变成"两处碰巧一致"，
      那正是本缺陷最初的成因（同一份期限被硬编码在两个地方）。
      注意抽取的两侧边界（`function chromePath() {` / `async function evaluate(`）
      本身就是常驻断言：将来有人在中间塞代码，这里会大声失败而不是静默改变语义。 */
const harnessSrc = fs.readFileSync(path.join(ROOT, HARNESS), 'utf8');
function extract(src, from, to, what) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('harness boundary changed: cannot extract ' + what);
  return src.slice(a, b);
}
const DEFAULT_SRC = extract(harnessSrc, 'const CDP_TIMEOUT_DEFAULT_MS', 'function chromePath() {', 'resolver block');
const CLASS_SRC = extract(harnessSrc, 'class Cdp {', 'async function evaluate(', 'Cdp class');
const { resolveCdpTimeoutMs, CDP_TIMEOUT_DEFAULT_MS } =
  new Function('http', 'crypto', DEFAULT_SRC + '\n' + CLASS_SRC
    + '\nreturn {resolveCdpTimeoutMs, CDP_TIMEOUT_DEFAULT_MS};')(http, require('node:crypto'));
/* Cdp 类真的被抽出来了（子进程用的就是它）—— 抽不出来就不可能跑行为证据。 */
if (!/\bclass Cdp\b/.test(CLASS_SRC) || CLASS_SRC.indexOf('this.timeoutMs') < 0) {
  throw new Error('Cdp class extraction lost the configured deadline');
}

/* ── 生产期限：从生产源码文本里读，不复制常量 ─────────────────────────── */
const prodSrc = fs.readFileSync(path.join(ROOT, JUDGE_SRC), 'utf8');
const prodMatch = prodSrc.match(/var\s+MB_JUDGE_TIMEOUT_MS\s*=\s*(\d+)\s*;/);
const PRODUCTION_MODEL_TIMEOUT_MS = prodMatch ? Number(prodMatch[1]) : null;

const CAL_SRC = fs.readFileSync(path.join(ROOT, CAL_HARNESS), 'utf8');

/* 每个子进程跑一次的合成等待：一条**在指定时刻**才回来的 Runtime.evaluate。
   ── 关于"什么才算是同一个合成延迟"（这个测试第一版在这里判错过，记下来）──
   要让"默认 15000 客户端超时 / 校准 30000 客户端成功"同时成立，延迟只能是
   **绝对值**：同一个 17000 ms 交给两个客户端，结果相反，唯一的差别就是期限。
   曾经想过用比例（delay = 0.6 × deadline）让两个子进程都一样快 —— 那是错的：
   比例一变，延迟本身也就变了，"两个客户端看到同一件事"这个前提就不成立了，
   于是它只证明了"快响应在两个客户端上都不超时"，什么也没证明。
   所以这里用真实带宽：
     · legacy 组：17000 ms —— 落在 Phase 1B 实测的 >15 s 且 <20 s 那一段，
                 **同一个值**两个客户端都跑一次（这是要求 6 的核心证据）；
     · calib  组：23500 ms —— 校准侧乘 0.99 的期限系数（约等于"差一点到 30000"），
                 用来证明校准客户端确实用的是 30000 而不是旧的 15000。
   总耗时约 24 s（两组并行），零网络、零浏览器、零真实 API 调用。 */
const BAND_DELAY_MS = 17000;             /* > 15000（旧硬编码期限），< 20000（生产期限） */
const CALIB_RATIO_DELAY_MS = 23500;      /* 0.99 × 30000 量级，远离 15000 那条线 */

const CHILD_SRC = `
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const ROOT = ${JSON.stringify(ROOT)};
const HARNESS = ${JSON.stringify(HARNESS)};
const src = fs.readFileSync(path.join(ROOT, HARNESS), 'utf8');
function extract(from, to, what) { const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('harness boundary changed: cannot extract ' + what); return src.slice(a, b); }
const { resolveCdpTimeoutMs, CDP_TIMEOUT_DEFAULT_MS, Cdp } = new Function('http', 'crypto',
  extract('const CDP_TIMEOUT_DEFAULT_MS', 'function chromePath() {', 'resolver block') + '\\n'
  + extract('class Cdp {', 'async function evaluate(', 'Cdp class')
  + '\\nreturn {resolveCdpTimeoutMs, CDP_TIMEOUT_DEFAULT_MS, Cdp};')(http, crypto);
const out = { label: process.env.IB_TEST_LABEL, rawEnv: process.env.IB_CDP_TIMEOUT_MS || '',
              legacyDefaultInHarness: /CDP_TIMEOUT_DEFAULT_MS = 15000/.test(src) };
const resolved = resolveCdpTimeoutMs(process.env.IB_CDP_TIMEOUT_MS);
out.deadlineMs = resolved.ms;
out.source = resolved.source;
out.timedOut = false;
out.replyMs = null;
out.note = null;
const delayMs = Number(process.env.IB_TEST_DELAY_MS);
out.delayMs = delayMs;
/* 合成 socket：第一条（Runtime.enable）立刻回，第二条（Runtime.evaluate）延迟 delayMs 才回。 */
const socket = (function () {
  const queue = [0, delayMs];
  let buffer = Buffer.alloc(0);
  const listeners = [];
  function makeFrame(json) {
    const payload = Buffer.from(json, 'utf8'); const mask = Buffer.from([9, 8, 7, 6]);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    return Buffer.concat([header, mask, body]);
  }
  function flush() {
    for (;;) {
      if (buffer.length < 2) return;
      const masked = (buffer[1] & 0x80) !== 0;
      let offset = 2, length = buffer[1] & 0x7f;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      if (masked) { if (buffer.length < offset + 4) return; offset += 4; }
      if (buffer.length < offset + length) return;
      const frame = buffer.subarray(0, offset + length);
      buffer = buffer.subarray(offset + length);
      const mask = masked ? frame.subarray(offset - 4, offset) : null;
      let payload = frame.subarray(offset, offset + length);
      if (mask) { const d = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) d[i] = payload[i] ^ mask[i & 3]; payload = d; }
      if ((frame[0] & 0x0f) !== 0x1) continue;
      let message; try { message = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      const wait = queue.shift() || 0;
      setTimeout(function () {
        const bytes = makeFrame(JSON.stringify({ id: message.id, result: { value: 'ok' } }));
        for (const l of listeners) l(bytes);
      }, wait);
    }
  }
  return {
    write(chunk) { buffer = Buffer.concat([buffer, chunk]); flush(); },
    on(event, cb) { if (event === 'data') listeners.push(cb); },
    destroy() {}
  };
})();
const cdp = new Cdp(socket);
(async function () {
  await cdp.send('Runtime.enable', {});
  const t0 = Date.now();
  try {
    const res = await cdp.send('Runtime.evaluate', { expression: '1', awaitPromise: true });
    out.replyMs = Date.now() - t0;
    out.result = res && res.value;
  } catch (e) {
    out.timedOut = true; out.replyMs = Date.now() - t0; out.note = String(e && e.message || e);
  }
  /* 注意：这里**不能**读 cdp.timeouts 当作"放弃了几次"的证据 ——
     Runtime.enable 那一次的 setTimeout 还在飞（它要跑满整个期限才触发），
     而它触发时 pending 早已被清空，所以计数器天然是 0，跟等没等到毫无关系。
     判据只能是 timedOut / replyMs：它们由被 await 的那次调用自己给出。 */
  fs.writeFileSync(process.env.IB_TEST_OUT, JSON.stringify(out, null, 2), 'utf8');
})().catch(e => { out.crash = String(e && e.stack || e);
  fs.writeFileSync(process.env.IB_TEST_OUT, JSON.stringify(out, null, 2), 'utf8'); });
`;

/* 真跑一次子进程（零网络、零浏览器、零真实 API 调用）。 */
function runChild(label, envTimeoutMs, delayMs) {
  return new Promise(resolve => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cdp-band-'));
    const outFile = path.join(dir, 'result.json');
    const env = Object.assign({}, process.env,
      { IB_TEST_LABEL: label, IB_TEST_OUT: outFile, IB_TEST_DELAY_MS: String(delayMs) });
    if (envTimeoutMs === null) delete env.IB_CDP_TIMEOUT_MS; else env.IB_CDP_TIMEOUT_MS = String(envTimeoutMs);
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', CHILD_SRC], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', c => { stderr += String(c); });
    child.on('close', code => {
      let payload = null;
      try { payload = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { /* reported below */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      resolve({ label, code, payload, stderr: stderr.slice(0, 400), wallMs: Date.now() - started });
    });
  });
}

/* 真跑一次校准 harness（子进程）。凭据一律清空：这些运行只会走**模块求值期**的
   期限闸门或离线 mock 分支，绝不可能发起真实调用。 */
function runHarness(envTimeoutMs, args) {
  const env = Object.assign({}, process.env, { IB_CDP_TIMEOUT_MS: envTimeoutMs });
  delete env.IB_CI_CALIBRATION_KEY;
  delete env.IB_CI_CALIBRATION_ENDPOINT;
  delete env.IB_CI_CALIBRATION_MODEL;
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CAL_HARNESS].concat(args), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', c => { stderr += String(c); });
    child.on('close', code => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

(async () => {
  console.log('CDP RPC deadline > production model timeout regression\n');

  /* ---------- 前置：生产期限必须真的读到了 ---------- */
  check('S0.productionModelTimeoutLiteralRead',
    prodMatch && PRODUCTION_MODEL_TIMEOUT_MS >= 10000 && PRODUCTION_MODEL_TIMEOUT_MS <= 120000,
    prodMatch ? 'MB_JUDGE_TIMEOUT_MS=' + PRODUCTION_MODEL_TIMEOUT_MS : 'literal not found in ' + JUDGE_SRC);
  note('production model timeout (read from ' + JUDGE_SRC + '): ' + PRODUCTION_MODEL_TIMEOUT_MS + 'ms');

  /* ---------- R 组：解析口径（进程内，无需等待） ---------- */
  console.log('\nR. IB_CDP_TIMEOUT_MS parsing (safe fallback, no NaN into setTimeout)');
  {
    const unset = resolveCdpTimeoutMs(undefined);
    check('R1.unsetYieldsLegacyDefault', unset.ms === 15000 && unset.source === 'default' && unset.fellBack === false,
      JSON.stringify(unset));
    check('R2.legacyDefaultConstantIsFifteenSeconds', CDP_TIMEOUT_DEFAULT_MS === 15000,
      'CDP_TIMEOUT_DEFAULT_MS=' + CDP_TIMEOUT_DEFAULT_MS + '（其他 CDP harness 的既有行为必须逐字不变）');
    const ok = resolveCdpTimeoutMs('30000');
    check('R3.explicitValueWins', ok.ms === 30000 && ok.source === 'env' && ok.fellBack === false, JSON.stringify(ok));
    const bad = ['0', '-1', 'abc', '0x10', '15e3', ' ', 'NaN', 'Infinity', '99999999999'];
    const fallbacks = bad.map(v => [v, resolveCdpTimeoutMs(v)]);
    check('R4.invalidValuesFallBackToDefault',
      fallbacks.every(([, r]) => r.ms === 15000 && r.fellBack === true),
      JSON.stringify(fallbacks.map(([v, r]) => v + '->' + r.ms + '/' + r.fellBack)));
    check('R5.noZeroOrNonFiniteCanReachSetTimeout',
      fallbacks.every(([, r]) => Number.isFinite(r.ms) && r.ms > 0),
      'a 0/NaN deadline would make every CDP call fail instantly');
  }

  /* ---------- S 组：结构不变量（不需要凭据，也不需要浏览器） ---------- */
  console.log('\nS. structural invariant: calibration CDP deadline > production model timeout');
  {
    const m = CAL_SRC.match(/const\s+CDP_DEADLINE_DEFAULT_MS\s*=\s*(\d+)\s*;/);
    const calDefault = m ? Number(m[1]) : null;
    check('S1.calibrationDefaultDeclared', calDefault != null, 'CDP_DEADLINE_DEFAULT_MS not found');
    check('S2.calibrationCdpDeadlineExceedsProduction', calDefault != null && calDefault > PRODUCTION_MODEL_TIMEOUT_MS,
      'calibration default=' + calDefault + 'ms, production=' + PRODUCTION_MODEL_TIMEOUT_MS + 'ms');
    note('calibration CDP deadline default=' + calDefault + 'ms > production ' + PRODUCTION_MODEL_TIMEOUT_MS + 'ms');

    /* 期限关系必须由**真实解析器**决定，不能只写在一个常量里：
       "常量 > 生产" 但"连接实际拿到 15000" 这种错位必须被挡住。 */
    check('S3.calibrationResolvesThroughTheSharedParser',
      /resolveCdpTimeoutMs\(process\.env\.IB_CDP_TIMEOUT_MS\)/.test(CAL_SRC)
      && /process\.env\.IB_CDP_TIMEOUT_MS\s*=\s*String\(CDP_DEADLINE_DEFAULT_MS\)/.test(CAL_SRC),
      'calibration must set the env only when unset, then resolve through the shared parser');
    check('S4.explicitOverrideStillHonoredAndGuarded',
      /process\.env\.IB_CDP_TIMEOUT_MS === undefined \|\| process\.env\.IB_CDP_TIMEOUT_MS === ''/.test(CAL_SRC)
      && /String\(CDP_DEADLINE_DEFAULT_MS\)/.test(CAL_SRC)
      && /resolveCdpTimeoutMs\(process\.env\.IB_CDP_TIMEOUT_MS\)/.test(CAL_SRC)
      && /if \(!\(resolved\.ms > PRODUCTION_MODEL_TIMEOUT_MS\)\)/.test(CAL_SRC)
      && (CAL_SRC.match(/process\.exit\(4\)/g) || []).length >= 2,
      'an explicit-but-too-short override must abort (exit 4), and an unreadable production literal'
      + ' must abort too — neither may silently degrade');
    check('S5.productionLiteralNotHardCodedInCalibration',
      !/MB_JUDGE_TIMEOUT_MS\s*=\s*20000/.test(CAL_SRC),
      'the production value must be read from production source, not copied');
    check('S6.realConnectionDeadlineAssertedAtRuntime',
      /cdp\.timeoutMs > PRODUCTION_MODEL_TIMEOUT_MS/.test(CAL_SRC)
      && /cdp\.timeouts === 0/.test(CAL_SRC),
      'the effective (not just declared) deadline, and the "never fired" fact, must both be asserted');

    /* 反向保证：本次改动**没有**顺手把其他 waitFor(...,15000) 业务期限一起换掉
       （要求 4）。test_chat_smoke 里那些 15000 必须还是字面量。 */
    const literalWaitFors = (harnessSrc.match(/, 15000\)\)/g) || []).length;
    check('S7.businessWaitForTimeoutsUntouched', literalWaitFors >= 4 && !/waitFor\(cdp, [^)]*CDP_TIMEOUT_DEFAULT_MS/.test(harnessSrc),
      'expected the existing literal waitFor(...,15000) call sites to remain: found ' + literalWaitFors);
    /* 读点必须**可枚举且恰好两处**，而且都不在 send() 的热路径之外扩散：
       ① Cdp 构造（决定 send 的期限）② main() 的诊断打印（让每次运行自证等够了没有）。
       注释里提到变量名是刻意的（它解释了为什么要有它），所以按 `process.env.` 计数。
       如果将来有人在别处读它（例如把某个 waitFor 也接上），这条会失败并列出所有行号。 */
    const readSiteLines = harnessSrc.split('\n')
      .map((line, i) => (/process\.env\.IB_CDP_TIMEOUT_MS/.test(line) ? (i + 1) + ': ' + line.trim() : null))
      .filter(Boolean);
    /* 期限的**解析**恰好发生在两处，且两处都只服务 CDP RPC 期限：
       ① Cdp 构造（决定 send 的期限）② main() 的诊断打印（让每次运行自证等够了没有）。
       如果把 `resolveCdpTimeoutMs(...)` 挪到别处（例如接上某个 waitFor），这条会失败。 */
    const resolveSites = harnessSrc.split('\n')
      .map((line, i) => (/resolveCdpTimeoutMs\(process\.env\.IB_CDP_TIMEOUT_MS\)/.test(line) ? (i + 1) + ': ' + line.trim() : null))
      .filter(Boolean);
    check('S8b.exactlyTwoResolveSitesBothAboutTheCdpDeadline', resolveSites.length === 2,
      'resolve site lines: ' + JSON.stringify(resolveSites));
    check('S9.resolverIsDefinedBeforeTheClassReadsIt',
      harnessSrc.indexOf('function resolveCdpTimeoutMs') < harnessSrc.indexOf('class Cdp {'),
      'the parser must be declared before the class that calls it (TDZ discipline, same rule as LIVE_MODE)');
  }

  /* ---------- W 组：行为证据 ----------
     三件事，全部离线：
       (a) **同一个绝对 17 s 延迟**（落在 Phase 1B 实测的 >15 s 且 <20 s 段内），
           交给两个真实 Cdp 实例 —— 默认 15000 客户端放弃，校准 30000 客户端等到。
           唯一的差别就是期限，这就是要求 6 的核心证据。
       (b) 默认客户端仍在 15000 附近放弃（既有行为未被改动）。
       (c) 校准客户端使用的确实是 30000（不是旧的 15000）：给它一个 23.5 s 的延迟，
           它必须等到 —— 而任何 15000 的客户端在这里都必然放弃。 */
  console.log('\nW. behaviour: one absolute 17s synthetic response, two deadlines, opposite outcomes');
  {
    const [legacy, calibration, calibRatio] = await Promise.all([
      runChild('legacy-default', null, BAND_DELAY_MS),          /* 未设 env：15000 */
      runChild('calibration-default', 30000, BAND_DELAY_MS),    /* 校准默认：30000，**同一个延迟** */
      runChild('calibration-ratio', 30000, CALIB_RATIO_DELAY_MS) /* 证明它真的用了 30000 */
    ]);

    for (const run of [legacy, calibration, calibRatio]) {
      check('W0.childCompleted/' + run.label, run.code === 0 && !!run.payload && !run.payload.crash,
        'exit=' + run.code + ' crash=' + (run.payload && run.payload.crash ? run.payload.crash : 'none')
        + ' stderr=' + run.stderr);
    }
    if (!legacy.payload || !calibration.payload || !calibRatio.payload) {
      console.error('  -> child payload missing; the behaviour half of this test did not run');
      failures++;
    } else {
      const L = legacy.payload, C = calibration.payload, R = calibRatio.payload;

      /* (a) 同一个延迟、两个期限、相反结果 —— 要求 6 的直接证据。 */
      check('W1.bothClientsSawTheSameAbsoluteDelay',
        L.delayMs === BAND_DELAY_MS && C.delayMs === BAND_DELAY_MS && L.delayMs === C.delayMs,
        'legacy=' + L.delayMs + 'ms calibration=' + C.delayMs + 'ms (must be the identical value)');
      check('W2.bandDelayIsInsideThePhase1BWindow',
        BAND_DELAY_MS > 15000 && BAND_DELAY_MS < PRODUCTION_MODEL_TIMEOUT_MS,
        BAND_DELAY_MS + 'ms must be > 15000 (old hard-coded deadline) and < '
        + PRODUCTION_MODEL_TIMEOUT_MS + ' (production timeout)');

      check('W3.defaultClientIsStillFifteenSeconds',
        L.rawEnv === '' && L.deadlineMs === 15000 && L.source === 'default',
        JSON.stringify({ rawEnv: L.rawEnv, deadlineMs: L.deadlineMs, source: L.source }));
      check('W4.defaultClientTimesOutOnTheBandResponse', L.timedOut === true,
        JSON.stringify({ timedOut: L.timedOut, replyMs: L.replyMs, result: L.result }));
      check('W5.defaultClientGaveUpAtItsOwnDeadline', L.replyMs >= 14900 && L.replyMs <= 15600,
        'gave up after ' + L.replyMs + 'ms (expected ≈15000, before the 17000ms reply)');
      check('W6.defaultClientReportedTheConfiguredDeadlineInTheMessage',
        /CDP timeout: 15000ms \(default\)/.test(String(L.note || '')),
        'note=' + JSON.stringify(L.note));

      check('W7.calibrationClientUsesThirtySeconds',
        C.rawEnv === '30000' && C.deadlineMs === 30000 && C.source === 'env',
        JSON.stringify({ rawEnv: C.rawEnv, deadlineMs: C.deadlineMs, source: C.source }));
      check('W8.calibrationClientSucceedsOnTheSameBandResponse',
        C.timedOut === false && C.result === 'ok',
        JSON.stringify({ timedOut: C.timedOut, replyMs: C.replyMs, result: C.result, note: C.note }));
      check('W9.calibrationClientWaitedPastTheOldDeadline', C.replyMs >= BAND_DELAY_MS - 150 && C.replyMs > 15000,
        'resolved after ' + C.replyMs + 'ms — it waited past the old hard-coded 15000ms deadline');
      check('W10.calibrationDeadlineExceedsTheProductionTimeout', C.deadlineMs > PRODUCTION_MODEL_TIMEOUT_MS,
        'deadline=' + C.deadlineMs + 'ms production=' + PRODUCTION_MODEL_TIMEOUT_MS + 'ms');
      check('W11.legacyDefaultPreservedInTheHarnessText',
        L.legacyDefaultInHarness === true && C.legacyDefaultInHarness === true,
        'CDP_TIMEOUT_DEFAULT_MS = 15000 must still be in ' + HARNESS);

      /* (c) 校准客户端不是"碰巧等得久"：23.5 s 的延迟只有 30000 的期限才接得住。 */
      check('W12.calibrationClientWaitsFarBeyondFifteenSeconds',
        R.timedOut === false && R.result === 'ok' && R.delayMs === CALIB_RATIO_DELAY_MS,
        JSON.stringify({ timedOut: R.timedOut, delayMs: R.delayMs, replyMs: R.replyMs, result: R.result }));
      check('W13.ratioDelayWouldHaveDefeatedAnyFifteenSecondClient',
        R.delayMs > 15000 && R.replyMs >= CALIB_RATIO_DELAY_MS - 150,
        'resolved after ' + R.replyMs + 'ms on a ' + R.delayMs + 'ms synthetic response');

      /* W14：Phase 1B 的完整机制复现 —— 一条延迟，两个期限，两种结局。 */
      check('W14.regressionReproducesThePhase1BMechanism',
        L.delayMs === C.delayMs && C.delayMs > 15000 && C.delayMs < PRODUCTION_MODEL_TIMEOUT_MS
        && L.timedOut === true && C.timedOut === false,
        'same ' + C.delayMs + 'ms synthetic response: default client timed out at ' + L.replyMs
        + 'ms (CDP timeout), calibration client resolved at ' + C.replyMs + 'ms');
      note('default client     : synthetic ' + L.delayMs + 'ms  ->  TIMEOUT after ' + L.replyMs + 'ms');
      note('calibration client : synthetic ' + C.delayMs + 'ms  ->  RESOLVED after ' + C.replyMs + 'ms (same delay)');
      note('calibration client : synthetic ' + R.delayMs + 'ms  ->  RESOLVED after ' + R.replyMs + 'ms (beyond 15s)');
    }
  }

  /* ---------- G 组：期限闸门真的可达（运行期真跑一次校准 harness）----------
     只有"结构里有这个闸门"不够 —— 上一轮改动就把解析放在抽取之前，
     结果整个 harness 在模块求值期 ReferenceError，而**离线凭据回归照样全绿**
     （它在抽取之前就 exit 3 了）。所以这里必须真的把校准 harness 拉起来跑：
       G1：显式给一个 <= 生产期限的值 → 必须 exit 4、点名原因、不起浏览器；
       G2：显式给一个合法的更高值 → 必须被接受（证明不是写死的常量），
           并且离线 mock 分支完整跑完（含 D1/D2 那条"CDP 期限 > 生产期限"的断言）。 */
  console.log('\nG. the deadline gate is reachable at runtime (real harness runs, credentials scrubbed)');
  {
    const shortRun = await runHarness('15000', ['--corpus=readiness', '--max-cases=1']);
    check('G1.shortOverrideAbortsFour', shortRun.code === 4, 'exit=' + shortRun.code + ' ms=' + shortRun.ms);
    /* 注意别用裸 /chrome/i 判"起了浏览器"：中文"生产守卫"里就含 chrome 这几个字母，
       第一版这里因此产生了假失败。判据只用**真的会出现的启动痕迹**。 */
    const g2parts = {
      saysWhy: /CDP RPC 期限 15000ms 不大于生产模型期限 20000ms/.test(shortRun.stderr),
      saysMasking: /掩盖成 CDP timeout/.test(shortRun.stderr),
      noBrowser: !/--user-data-dir=|Chromium|chrome\.exe|msedge/i.test(shortRun.stderr),
      noCalibrationOutput: !/Layer B mode=|Character Integrity Calibration/.test(shortRun.stdout)
    };
    /* 注意：这里**不**断言"没打印 PLANNED API CALLS"。预算计划是在文件顶部、
       期限闸门**之前**算并打印的（它也确实是零调用的一次纯计算，不启动浏览器、
       不发请求），所以它会出现在这一行的 stdout 里。判据落在真正重要的事情上：
       没有浏览器、没有校准跑、exit 4、点名原因。 */
    check('G2.shortOverrideSaysWhyAndNeverStartsABrowser',
      g2parts.saysWhy && g2parts.saysMasking && g2parts.noBrowser && g2parts.noCalibrationOutput,
      JSON.stringify(g2parts) + ' stderr=' + JSON.stringify(shortRun.stderr.slice(0, 220)));
    note('short override: exit=' + shortRun.code + ' in ' + shortRun.ms + 'ms, no browser, no call');

    const overrideRun = await runHarness('45000', ['--corpus=readiness', '--max-cases=1']);
    check('G3.explicitValidOverrideIsHonoredNotSilentlyIgnored',
      /CDP RPC deadline: 45000ms \(env, > production model timeout 20000ms\)/.test(overrideRun.stdout),
      'stdout head=' + JSON.stringify(overrideRun.stdout.split('\n').slice(0, 3).join(' | ')));
    check('G4.harnessRunsToCompletionWithTheWidenedDeadline',
      overrideRun.code === 0 && /CDP deadline band|Character Integrity Calibration[\s\S]*0 failed/.test(overrideRun.stdout),
      'exit=' + overrideRun.code + ' ms=' + overrideRun.ms);
    note('valid override: exit=' + overrideRun.code + ' in ' + overrideRun.ms + 'ms (offline mock, zero real calls)');
  }

  console.log('\nCDP deadline band regression: ' + failures + ' failed');
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
