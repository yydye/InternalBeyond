'use strict';

/* P7 · installer / launcher behaviour WITHOUT installing anything.

   Everything here runs in temp directories with mocked child processes:
   no installer run, no service launch, no browser window, no product port is
   bound or probed, and %LOCALAPPDATA%\InternalBeyond is never written.

     [1] VBS runtime preflight — a corrupt bundled runtime is rejected by the
         launcher script itself, before Windows is asked to load it
     [2] VBS resolution order + preflight ordering (source contract)
     [3] stop helper selection — only InternalBeyond command lines are targets,
         the install root is evidence (not a gate), and a decoy node process is
         never selected (the "upgrade while running" contract, mocked)
     [4] launcher browser seam — IB_LAUNCH_NO_OPEN=1 suppresses the browser and
         no cmd.exe is spawned
     [5] installer stop wiring — exactly one stop invocation per install /
         uninstall path, always with --root "{app}"
     [6] upgrade lock — the installer waits (bounded) for the bundled runtime to
         become replaceable; verified against a real locked copy of node.exe
     [7] post-install runtime validation — a broken runtime fails loudly at
         install time, never falls back to a system Node

   Run: node test_installer_mock.js
   Budget: docs/P7-TEST-BUDGET.md */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const ROOT = __dirname;
const VBS_NAME = '启动 InternalBeyond.vbs';
const VBS = path.join(ROOT, VBS_NAME);
const ISS = path.join(ROOT, 'installer', 'InternalBeyond.iss');
const LAUNCH_PATH = require.resolve('./runtime/launch-internal-beyond.js');
const ibStop = require('./installer/tools/ib-stop.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
async function acheck(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-mock-'));

/* A throwaway install-shaped sandbox: the real .vbs plus a bundled runtime we
   control. Nothing here can reach the developer checkout. */
function sandbox(name, runtimeBytes) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'runtime', 'node'), { recursive: true });
  fs.copyFileSync(VBS, path.join(dir, VBS_NAME));
  fs.writeFileSync(path.join(dir, 'runtime', 'node', 'node.exe'), runtimeBytes);
  return dir;
}
/* A sandbox whose runtime is a copy of the REAL bundled binary, mutated. Used
   to test the execute-time failure path without touching the developer's own
   runtime/node/node.exe. */
function sandboxFromRealRuntime(name, mutate) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'runtime', 'node'), { recursive: true });
  fs.copyFileSync(VBS, path.join(dir, VBS_NAME));
  const exe = path.join(dir, 'runtime', 'node', 'node.exe');
  fs.copyFileSync(path.join(ROOT, 'runtime', 'node', 'node.exe'), exe);
  fs.copyFileSync(path.join(ROOT, 'runtime', 'node', 'VERSION'), path.join(dir, 'runtime', 'node', 'VERSION'));
  if (mutate) mutate(exe);
  return dir;
}
function runVbs(dir) {
  const r = spawnSync('cscript.exe', ['//nologo', path.join(dir, VBS_NAME)], {
    cwd: dir, encoding: 'latin1', windowsHide: true, timeout: 60000,
    env: Object.assign({}, process.env, { IB_LAUNCH_NO_OPEN: '1' })
  });
  const logFile = path.join(dir, 'logs', 'launcher.log');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'latin1') : '';
  return { code: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), log: log };
}

console.log('Installer / launcher mock tests (P7)\n');

/* ── [1] VBS runtime preflight ─────────────────────────────────────────── */
console.log('[1] VBS runtime preflight (corrupt bundled runtime)');

check('a truncated bundled runtime is rejected before Windows loads it', () => {
  const dir = sandbox('tiny', Buffer.from('not a real executable'));
  const r = runVbs(dir);
  assert.notStrictEqual(r.code, 0, 'launcher must fail on a corrupt bundled runtime');
  assert.ok(/runtime binary rejected by preflight/.test(r.log),
    'preflight rejection must be logged (log: ' + JSON.stringify(r.log.slice(-300)) + ')');
  assert.ok(!/\[VBS\] node version/.test(r.log), 'a rejected binary must never be executed');
  assert.ok(/ERROR:/.test(r.stdout + r.stderr), 'the user must get a product-language error');
});

check('a non-executable file of plausible size is rejected as well', () => {
  const dir = sandbox('nomez', Buffer.alloc(2 * 1024 * 1024, 0x58 /* 'X' */));
  const r = runVbs(dir);
  assert.notStrictEqual(r.code, 0, 'launcher must fail on a non-MZ binary');
  assert.ok(/runtime binary rejected by preflight/.test(r.log), 'preflight rejection must be logged');
  assert.ok(!/\[VBS\] node version/.test(r.log), 'a rejected binary must never be executed');
});

check('a truncated (MZ-intact) runtime fails loudly and never falls back to PATH', () => {
  /* Passes the cheap preflight (size + MZ) but cannot be loaded by Windows —
     exactly the "install completed, runtime broken" case. A real system Node is
     on PATH in this environment; it must NOT be used. */
  const dir = sandboxFromRealRuntime('truncated', (exe) => fs.truncateSync(exe, 1536 * 1024));
  const r = runVbs(dir);
  assert.notStrictEqual(r.code, 0, 'launcher must fail on an unloadable bundled runtime');
  /* The VBS Log() is best-effort (append can lose a line to a scanner lock), so
     accept the log line OR the console error as proof of the failure path. */
  assert.ok(/bundled node\.exe failed to run/.test(r.log) || /ERROR:/.test(r.stdout + r.stderr),
    'the bundled-runtime failure must be reported (log: ' + JSON.stringify(r.log.slice(-300)) + ')');
  assert.ok(!/\[VBS\] node version/.test(r.log), 'an unloadable binary must never produce a version');
  assert.ok(!/src=PATH/.test(r.log), 'must never fall back to a system Node');
  assert.ok(!/pathNode/.test(r.log), 'must never even look at PATH for a bundled failure');
});

check('a valid bundled runtime passes the preflight and is executed', () => {
  /* Positive control: the same sandbox with an intact runtime. The launcher
     script is deliberately absent, so nothing can actually start — the VBS must
     get past the preflight, run node --version, and only then fail on the
     missing launcher. */
  const dir = sandboxFromRealRuntime('valid', null);
  const r = runVbs(dir);
  assert.ok(!/runtime binary rejected by preflight/.test(r.log), 'a valid runtime must not be rejected');
  assert.ok(/\[VBS\] node version: v24\./.test(r.log),
    'the valid runtime must be executed and versioned (log: ' + JSON.stringify(r.log.slice(-300)) + ')');
  assert.ok(!/Opening http/.test(r.log), 'the sandbox must not start anything real');
});

/* ── [2] VBS resolution + ordering contract ────────────────────────────── */
console.log('\n[2] VBS runtime resolution contract');

const VBS_SRC = fs.readFileSync(VBS, 'latin1');

check('resolution order is IB_NODE → bundled → PATH', () => {
  const ibNode = VBS_SRC.indexOf('nodeSrc = "IB_NODE"');
  const bundled = VBS_SRC.indexOf('nodeSrc = "bundled"');
  const pathFallback = VBS_SRC.indexOf('pathNode = WhereNodeExe()');
  assert.ok(ibNode >= 0 && bundled >= 0 && pathFallback >= 0, 'all three resolution branches must exist');
  assert.ok(ibNode < bundled, 'IB_NODE must be tried before the bundled runtime');
  assert.ok(bundled < pathFallback, 'the bundled runtime must be tried before PATH');
});

check('the preflight runs before the runtime is executed', () => {
  const preflight = VBS_SRC.indexOf('RuntimeLooksValid(nodeExe, preflightWhy)');
  const execute = VBS_SRC.indexOf('nodeVer = NodeVersion(nodeExe)');
  assert.ok(preflight >= 0 && execute >= 0, 'both steps must exist');
  assert.ok(preflight < execute, 'a corrupt runtime must be rejected before it is executed');
});

check('a broken bundled runtime never falls back to PATH', () => {
  const broken = VBS_SRC.indexOf('[VBS] ERROR: bundled node.exe failed to run');
  assert.ok(broken >= 0, 'the bundled-runtime failure path must exist');
  const after = VBS_SRC.slice(broken, broken + 400);
  assert.ok(/Fatal\(/.test(after), 'a broken bundled runtime must abort, not continue to PATH');
});

/* ── [3] stop helper selection (mocked process table) ──────────────────── */
console.log('\n[3] stop helper selection (mocked, no process is touched)');

/* A realistic table: two IB processes from the temp install, a decoy node
   process, a foreign node app, a python service, and a developer checkout that
   answers on the same product ports. */
const INSTALL_ROOT = 'C:\\Temp\\ib-p7-smoke\\install-1';
const table = [
  { pid: 101, cmd: '"C:\\Temp\\ib-p7-smoke\\install-1\\runtime\\node\\node.exe" C:\\Temp\\ib-p7-smoke\\install-1\\runtime\\local-services-runner.js' },
  { pid: 102, cmd: '"C:\\Temp\\ib-p7-smoke\\install-1\\runtime\\node\\node.exe" C:\\Temp\\ib-p7-smoke\\install-1\\services\\internal-beyond-server.js' },
  { pid: 103, cmd: '"C:\\Temp\\ib-p7-smoke\\install-1\\runtime\\node\\node.exe" -e "setTimeout(function(){},600000)"' },
  { pid: 104, cmd: 'C:\\Program Files\\OtherApp\\node.exe server.js' },
  { pid: 105, cmd: 'python.exe C:\\x\\vision\\main.py' },
  { pid: 106, cmd: 'node.exe C:\\dev\\InternalBeyond-main\\services\\ib-bridge-service.js' }
];
const selected = table.filter(row => ibStop.commandLineIsInternalBeyond(row.cmd)).map(row => row.pid);

check('only InternalBeyond command lines are selected', () => {
  assert.deepStrictEqual(selected, [101, 102, 106],
    'selection must be by our script names only, got ' + JSON.stringify(selected));
});

check('an unrelated node process is never selected (upgrade safety)', () => {
  assert.ok(selected.indexOf(103) < 0, 'a decoy node process must survive');
  assert.ok(selected.indexOf(104) < 0, 'a foreign node app must survive');
  assert.ok(selected.indexOf(105) < 0, 'a python service must survive');
});

check('the install root is evidence, not a gate', () => {
  const inRoot = table.filter(row => ibStop.commandLineMatchesRoot(row.cmd, INSTALL_ROOT)).map(row => row.pid);
  /* Root matching also sees the decoy (its exe path lives in the install dir) —
     which is exactly why the root alone must never select a target. */
  assert.deepStrictEqual(inRoot, [101, 102, 103], 'root matching must follow the command line, got ' + JSON.stringify(inRoot));
  assert.ok(selected.indexOf(103) < 0, 'the script-name check is what keeps the decoy alive');
  assert.strictEqual(ibStop.commandLineIsInternalBeyond(table[5].cmd), true,
    'a dev checkout on the same ports is still ours by script name (documented)');
  assert.strictEqual(ibStop.commandLineMatchesRoot(table[5].cmd, INSTALL_ROOT), false,
    'root mismatch must be reported, not silently ignored');
});

check('the helper knows every InternalBeyond script', () => {
  for (const s of ['internal-beyond-server.js', 'launch-internal-beyond.js', 'local-services-runner.js',
    'ib-bridge-service.js', 'active-message-service.js', 'ib-stop.js']) {
    assert.ok(ibStop.IB_SCRIPTS.indexOf(s) >= 0, 'helper must know ' + s);
  }
});

/* ── [4] launcher browser seam (mocked child processes) ────────────────── */
console.log('\n[4] launcher browser seam (no window is opened)');

function loadLauncher(env) {
  const calls = [];
  const cp = require('child_process');
  const orig = cp.spawn;
  const saved = {};
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; process.env[k] = String(env[k]); }
  cp.spawn = function (cmd, args) {
    calls.push({ cmd: String(cmd), args: (args || []).map(String) });
    return { pid: -1, unref() { }, on() { return this; }, kill() { } };
  };
  delete require.cache[LAUNCH_PATH];
  let mod = null;
  try { mod = require(LAUNCH_PATH); } finally { cp.spawn = orig; }
  const restore = () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
  return { mod: mod, calls: calls, restore: restore };
}

/* The launcher logs through console.log; keep this suite's output readable. */
function quiet(fn) {
  const orig = console.log;
  console.log = function () { };
  try { return fn(); } finally { console.log = orig; }
}

check('IB_LAUNCH_NO_OPEN=1 suppresses the browser (no cmd.exe at all)', () => {
  const l = loadLauncher({ IB_LAUNCH_NO_OPEN: '1', IB_WEB_PORT: '9' });
  try {
    const opened = quiet(() => l.mod.openBrowser('http://127.0.0.1:9/x', {}));
    assert.strictEqual(opened, false, 'must report that nothing was opened');
    assert.strictEqual(l.calls.length, 0, 'no child process may be spawned');
  } finally { l.restore(); }
});

check('the noOpen option suppresses the browser as well', () => {
  const l = loadLauncher({ IB_WEB_PORT: '9' });
  try {
    const opened = quiet(() => l.mod.openBrowser('http://127.0.0.1:9/x', { noOpen: true }));
    assert.strictEqual(opened, false);
    assert.strictEqual(l.calls.length, 0, 'no child process may be spawned');
  } finally { l.restore(); }
});

check('without the seam the launcher opens exactly one default browser', () => {
  const l = loadLauncher({ IB_WEB_PORT: '9' });
  try {
    const opened = quiet(() => l.mod.openBrowser('http://127.0.0.1:9/x', {}));
    assert.strictEqual(opened, true);
    assert.strictEqual(l.calls.length, 1, 'exactly one browser command');
    assert.ok(/cmd\.exe$/i.test(l.calls[0].cmd), 'must go through the shell');
    assert.ok(l.calls[0].args.indexOf('start') >= 0, 'must use the shell start verb');
    assert.strictEqual(l.calls[0].args[l.calls[0].args.length - 1], 'http://127.0.0.1:9/x', 'must open the requested URL');
  } finally { l.restore(); }
});

/* ── [5] installer stop wiring ─────────────────────────────────────────── */
console.log('\n[5] installer stop wiring');

const ISS_SRC = fs.readFileSync(ISS, 'utf8');

check('one stop invocation per install and uninstall path', () => {
  const codeCalls = (ISS_SRC.match(/Result := StopInternalBeyond\(\);/g) || []).length;
  assert.strictEqual(codeCalls, 1, 'PrepareToInstall must stop exactly once, got ' + codeCalls);
  const uninstallRuns = (ISS_SRC.match(/RunOnceId: "StopInternalBeyond"/g) || []).length;
  assert.strictEqual(uninstallRuns, 1, 'uninstall must stop exactly once, got ' + uninstallRuns);
});

check('the stop helper is always told the install root', () => {
  const m = ISS_SRC.match(/--root ""\{app\}""/g) || [];
  assert.ok(m.length >= 1, 'the helper must receive --root {app}');
  assert.ok(/ExtractTemporaryFile\('\{#StopHelper\}'\)/.test(ISS_SRC), 'helper must be extracted on demand');
});

check('the installer identity probe honours the port overrides', () => {
  assert.ok(/OptionPort\('IB_WEB_PORT',\s*23120\)/.test(ISS_SRC), 'must read IB_WEB_PORT so a smoke can isolate the probe');
  assert.ok(/OptionPort\('IB_RESTART_PORT',\s*23116\)/.test(ISS_SRC), 'must read IB_RESTART_PORT');
  assert.ok(/GetEnv\(Name\)/.test(ISS_SRC), 'the override must come from the environment');
  assert.ok(!/\bWEB_PORT\s*=\s*23120/.test(ISS_SRC), 'must not hard-code the web port in [Code]');
  assert.ok(!/\bRESTART_PORT\s*=\s*23116/.test(ISS_SRC), 'must not hard-code the restart port in [Code]');
});

/* ── [6] upgrade lock · [7] post-install validation ────────────────────── */

(async () => {
  console.log('\n[6] upgrade lock (real file-lock fixture, no install)');

  check('the installer waits, bounded, for the runtime to become replaceable', () => {
    assert.ok(/function WaitForRuntimeReplaceable\(/.test(ISS_SRC), 'must define the bounded unlock wait');
    assert.ok(/--wait-unlock/.test(ISS_SRC), 'must use the shipped --wait-unlock probe');
    assert.ok(/WaitForRuntimeReplaceable\(ExpandConstant\('\{app\}\\runtime\\node\\node\.exe'\),\s*20000\)/.test(ISS_SRC),
      'must wait on the file it is about to replace, with a bounded timeout');
    assert.ok(/仍被占用/.test(ISS_SRC) && /请关闭 InternalBeyond/.test(ISS_SRC),
      'a locked runtime must end in a friendly message, not a blind continue');
    /* A probe executed from the very file it probes locks itself and would
       report "still locked" forever — it must run from a temp copy. */
    assert.ok(/FileCopy\(NodeExe, ProbeExe, False\)/.test(ISS_SRC),
      'the lock probe must run from a temp copy of the runtime');
    assert.ok(/Exec\(ProbeExe, Params/.test(ISS_SRC), 'the probe must be executed from that copy');
    const stopIdx = ISS_SRC.indexOf('if Code <> 0 then');
    const waitIdx = ISS_SRC.indexOf('WaitForRuntimeReplaceable(ExpandConstant');
    assert.ok(stopIdx >= 0 && waitIdx > stopIdx, 'the unlock wait must run after the stop helper');
  });

  await acheck('a running copy of the bundled runtime is locked and unlocks after exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-lock-'));
    const exe = path.join(dir, 'node.exe');
    fs.copyFileSync(path.join(ROOT, 'runtime', 'node', 'node.exe'), exe);
    const child = spawn(exe, ['-e', 'setTimeout(function(){}, 60000)'], { stdio: 'ignore', windowsHide: true, detached: true });
    child.unref();
    const stop = () => { try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); } catch (e) { /* gone */ } };
    try {
      await new Promise(r => setTimeout(r, 2500));
      const locked = await ibStop.waitForUnlock(exe, 1500);
      assert.strictEqual(locked.ok, false, 'a running image must not be replaceable');
      assert.strictEqual(locked.error, 'still-locked');
      stop();
      const unlocked = await ibStop.waitForUnlock(exe, 20000);
      assert.strictEqual(unlocked.ok, true, 'after the process exits the file must become replaceable');
    } finally { stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await acheck('a missing runtime needs no wait', async () => {
    const r = await ibStop.waitForUnlock(path.join(TMP, 'not-there.exe'), 1000);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.missing, true);
  });

  console.log('\n[7] post-install runtime validation');

  check('the installer validates the bundled runtime right after copying it', () => {
    assert.ok(/function ValidateBundledRuntime\(\): String;/.test(ISS_SRC), 'must define the validation');
    assert.ok(/procedure CurStepChanged\(CurStep: TSetupStep\)/.test(ISS_SRC), 'must hook the install step');
    assert.ok(/CurStep = ssPostInstall/.test(ISS_SRC), 'must run after the payload is installed');
    assert.ok(/Problem := ValidateBundledRuntime\(\);/.test(ISS_SRC), 'the hook must call the validation');
    assert.ok(/--version > /.test(ISS_SRC), 'must actually execute the runtime (--version)');
    assert.ok(/runtime\\node\\VERSION/.test(ISS_SRC), 'must compare against the pinned VERSION');
    assert.ok(/runtime-invalid\.txt/.test(ISS_SRC), 'must leave a marker for diagnostics');
    assert.ok(/重新下载安装包/.test(ISS_SRC), 'must tell the user what to do');
    const body = ISS_SRC.slice(ISS_SRC.indexOf('function ValidateBundledRuntime'), ISS_SRC.indexOf('procedure CurStepChanged'));
    assert.ok(!/FileSearch\('node\.exe'/.test(body), 'validation must never fall back to a system Node');
  });

  /* ── cleanup + report ──────────────────────────────────────────────────── */
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('\nUNEXPECTED FAILURE: ' + (e && e.stack || e));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { /* best effort */ }
  process.exitCode = 1;
});
