/* P32-W.3B/.3A · installed WebView acceptance probe.
   The existing P7 real smoke owns install/upgrade/uninstall/cleanup. This
   wrapper only enables the explicit fixed probe seam and reads its bounded
   result over the existing loopback static server. It never sends JS input.
   Default mode is the W.3B transport ladder; --full-dom restores W.3A. */
'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = process.argv[process.argv.indexOf('--exe') + 1] || path.join(ROOT, 'tmp', 'installer-smoke-build', 'InternalBeyond-Installer-Smoke-Test-Setup-1.0.6.exe');
const SMOKE = path.join(ROOT, 'tests', 'test_installer_smoke.js');
const FULL_DOM = process.argv.indexOf('--full-dom') >= 0;
const REQUIRED_FULL = [
  'ready', 'tauri', 'navHome', 'initialConsoleHidden', 'sixClicksNoConsole',
  'timeoutReset', 'consoleOpened', 'consoleInput', 'consoleFocus',
  'maliciousRejected', 'beyondOpened', 'beyondClosed', 'consoleReopened',
  'middlebrainOpened', 'noNormalPage', 'middlebrainClosed', 'hashReturned',
  'noMiddlebrainQuery', 'done'
];
const RUN_ID = crypto.randomBytes(12).toString('hex');
const TRANSPORT_LOG = path.join(os.tmpdir(), 'p32-w3a-' + RUN_ID + '-transport.log');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function getJson(port, pathname) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + pathname, { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  } catch (error) { return { status: 0, body: null, error: String(error && error.message || error) }; }
}
async function waitForResult(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    const response = await getJson(port, '/__p32-w3a/acceptance');
    const candidate = response.body && response.body.result;
    if (candidate) last = candidate;
    const complete = FULL_DOM ? !!(candidate && candidate.done && candidate.phase === 'probe_complete')
      : !!(candidate && candidate.phase === 'nav_home_found');
    if (response.status === 200 && response.body && response.body.ready && complete) return candidate;
    await sleep(200);
  }
  waitForResult.last = last;
  return null;
}
async function waitForEndpoint(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await getJson(port, '/__p32-w3a/acceptance');
    if (last.status === 200 && last.body && last.body.ok === true) return last;
    await sleep(250);
  }
  return last || { status: 0, body: null, error: 'endpoint-timeout' };
}
function stopChild(child) {
  if (!child || !child.pid) return;
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
}
function childStillAlive(child) {
  if (!child || !child.pid) return false;
  try { process.kill(child.pid, 0); return true; } catch (_) { return false; }
}
function readTransportLogs() {
  const paths = [
    TRANSPORT_LOG,
    path.join(os.tmpdir(), 'p32-w3a-missing-transport.log')
  ];
  return paths.filter(file => fs.existsSync(file)).map(file => fs.readFileSync(file, 'utf8')).join('');
}
function check(name, condition, detail) {
  if (condition) console.log('  PASS  ' + name);
  else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

let failures = 0;

async function main() {
  if (!fs.existsSync(EXE)) throw new Error('test-only installer not found: ' + EXE);
  let webPort = 0;
  let outputBuffer = '';
  let portResolve;
  const portReady = new Promise(resolve => { portResolve = resolve; });
  const child = spawn(process.execPath, [SMOKE, '--real-install-smoke', '--allow-rerun', '--exe', EXE], {
    cwd: ROOT,
    windowsHide: true,
    env: Object.assign({}, process.env, {
      IB_ACCEPTANCE_SECRET_ROUTES: '1',
      IB_ACCEPTANCE_SECRET_ROUTES_RUN_ID: RUN_ID,
      IB_ACCEPTANCE_SECRET_ROUTES_MODE: FULL_DOM ? 'full' : 'transport'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const onOutput = chunk => {
    const text = String(chunk || '');
    process.stdout.write(text);
    outputBuffer = (outputBuffer + text).slice(-12000);
    if (!webPort) {
      const match = outputBuffer.match(/isolation:\s+ports\s+web=(\d+)/i);
      if (match) { webPort = Number(match[1]); portResolve(webPort); }
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', chunk => process.stderr.write(String(chunk || '')));
  let result = null;
  try {
    webPort = await Promise.race([portReady, sleep(20000).then(() => 0)]);
    check('acceptance.port-isolated', webPort > 0, outputBuffer.slice(-400));
    if (webPort > 0) {
      const armed = await waitForEndpoint(webPort, 90000);
      check('installed.acceptance-endpoint-armed', armed.status === 200 && armed.body && armed.body.ok === true, JSON.stringify(armed));
      result = await waitForResult(webPort, 110000);
    }
    check('installed.webview-probe-result', !!result, result ? '' : 'no bounded result from the installed WebView probe; last=' + JSON.stringify(waitForResult.last || null));
    if (result) {
      check('installed.run-id-correlated', result.runId === RUN_ID, JSON.stringify(result.runId));
      if (FULL_DOM) {
        check('installed.probe-complete', result.phase === 'probe_complete', JSON.stringify(result.phase));
        for (const key of REQUIRED_FULL) check('installed.' + key, result[key] === true, JSON.stringify(result));
        check('installed.model-calls-zero', result.modelCallsObserved === 0 && result.directMessageSent === false, JSON.stringify(result));
      } else {
        check('transport.final-phase', result.phase === 'nav_home_found', JSON.stringify(result.phase));
        check('transport.ready', result.ready === true, JSON.stringify(result));
        check('transport.tauri', result.tauri === true, JSON.stringify(result));
        check('transport.nav-home', result.navHome === true, JSON.stringify(result));
        check('transport.ready-state', result.readyState === 'complete', JSON.stringify(result.readyState));
        check('transport.document-seq', Number.isInteger(result.documentSeq) && result.documentSeq > 0, JSON.stringify(result.documentSeq));
        check('transport.url-class', result.urlClass === 'INTERNALBEYOND', JSON.stringify(result.urlClass));
        check('transport.page-load-phase', result.pageLoadPhase === 'finished', JSON.stringify(result.pageLoadPhase));
      }
      check('installed.origin-bounded', typeof result.origin === 'string' && result.origin.length > 0 && result.origin.length <= 160);
      check('installed.pathname-is-document', typeof result.pathname === 'string' && /InternalBeyond\.html$/i.test(result.pathname));
      const boot = await getJson(webPort, '/__boot-state');
      const stateRoot = boot.body && boot.body.bootState && boot.body.bootState.launcher && boot.body.bootState.launcher.root;
      check('installed.root-bounded', typeof stateRoot === 'string' && /[\\/]ib-p7-smoke[\\/]install-/i.test(stateRoot) && stateRoot.toLowerCase().indexOf(ROOT.toLowerCase()) < 0, String(stateRoot || ''));
      check('installed.host-exe-present-at-root', typeof stateRoot === 'string' && fs.existsSync(path.join(stateRoot, 'internalbeyond-host.exe')));
    }
    const transportLog = readTransportLogs();
    if (transportLog) console.log('  transport-log  ' + transportLog.trim().replace(/\r?\n/g, ' | '));
    if (!FULL_DOM) {
      for (const phase of ['PROBE_STARTED', 'DOCUMENT_STATE', 'TAURI_RECOGNIZED', 'NAV_HOME_FOUND']) {
        check('transport.' + phase.toLowerCase().replace(/_/g, '-'), transportLog.indexOf('event=M2_PHASE_' + phase) >= 0, transportLog);
      }
      check('transport.result-channel-confirmed', transportLog.indexOf('event=M2_BODY_ACCEPTED') >= 0, transportLog);
      check('transport.bootstrap-registered', transportLog.indexOf('event=M1_BOOTSTRAP_PROBE_REGISTERED') >= 0, transportLog);
      check('transport.target-document-finished', /event=M1B_PAGE_FINISHED_DOC\d+_CLASS_INTERNALBEYOND/.test(transportLog), transportLog);
      check('transport.document-probe-scheduled', /event=M1B_DOCUMENT_PROBE_SCHEDULED_DOC\d+_CLASS_INTERNALBEYOND/.test(transportLog), transportLog);
      check('transport.document-probe-executed', /event=M1B_DOCUMENT_PROBE_EXECUTED_DOC\d+/.test(transportLog), transportLog);
    }
    check('installed.host-m0-gate', transportLog.indexOf('event=M0_GATE_DETECTED') >= 0, transportLog);
    check('installed.host-m1-probe-registered', transportLog.indexOf('event=M1_PROBE_REGISTERED') >= 0, transportLog);
    check('installed.host-m1b-page-load', transportLog.indexOf('event=M1B_PAGE_FINISHED') >= 0, transportLog);
    check('installed.host-m1b-probe-eval', transportLog.indexOf('event=M1B_PROBE_EVAL_OK') >= 0, transportLog);
  } finally {
    const childDone = new Promise(resolve => {
      if (child.exitCode != null) return resolve();
      let settled = false;
      const finish = function () { if (settled) return; settled = true; clearInterval(timer); resolve(); };
      const timer = setInterval(function () { if (!childStillAlive(child)) finish(); }, 250);
      child.once('exit', finish);
    });
    const finished = await Promise.race([childDone.then(() => true), sleep(120000).then(() => false)]);
    if (!finished) {
      stopChild(child);
      await Promise.race([childDone, sleep(5000)]);
      failures++;
    }
    if (child.exitCode !== 0) failures++;
    for (const file of [TRANSPORT_LOG, path.join(os.tmpdir(), 'p32-w3a-missing-transport.log')]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
    }
  }
  console.log(failures === 0 ? '\nP32-W.3A installed WebView DOM acceptance passed ✔' : '\nP32-W.3A installed WebView DOM acceptance FAILED ✘');
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
