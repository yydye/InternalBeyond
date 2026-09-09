'use strict';

/* P7 · Windows installer smoke — strictly budgeted (docs/P7-TEST-BUDGET.md).
 *
 * Modes (at most one per invocation):
 *   (no flag)             SKIP, exit 0. Nothing is installed, launched or opened.
 *
 *   --install-audit       Isolated silent install → installed-payload audit →
 *                         uninstall. No launch, no browser (asserts 0 opens).
 *                         Used by scripts/build-installer.ps1 -InstallAudit.
 *
 *   --real-install-smoke  THE one real smoke. One success per built installer:
 *                         install → payload audit → launch ONCE (browser
 *                         suppressed) → /health + document 200 → upgrade while
 *                         that instance is still running (own instance stopped,
 *                         runtime unlocked and replaced byte-exact, unrelated
 *                         Node survives) → uninstall → user data kept → the
 *                         developer instance on the product ports untouched.
 *                         Refused when this exact installer already passed;
 *                         --allow-rerun overrides deliberately.
 *
 * --force / IB_INSTALLER_SMOKE=1 / --allow-browser are REFUSED. They used to
 * drive repeated install → launch → upgrade → uninstall loops that disturbed the
 * development machine. What they covered now lives in:
 *   · test_installer.js       static contract (Inno / manifest / pin / secrets)
 *   · test_installer_mock.js  mocked launcher + stop-helper behaviour
 * and the full clean-machine matrix moves to P8.
 *
 * Hard rules enforced by this harness:
 *   · browserOpens === 0 always (the launcher's test seam is injected)
 *   · temp install dir + temp LOCALAPPDATA + 4 free ports handed to EVERY child
 *     (installer, uninstaller, launcher, stop helper) — the dev checkout and the
 *     real %LOCALAPPDATA%\InternalBeyond are never touched
 *   · the developer instance on the product ports is probed before and after and
 *     must be exactly as it was (deepStrictEqual)
 *   · every child PID is tracked and stopped by PID only — never by image name
 *   · hard per-case + global deadlines; leftovers are reported on failure
 *
 * Zero deps. Never calls process.exit(); every child is cleaned up in finally.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const manifest = require('./scripts/release-manifest.js');
const audit = require('./scripts/release-audit.js');
const productVersion = require('./product-version.js');

const argv = process.argv.slice(2);
const has = (n) => argv.indexOf(n) >= 0;
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? String(argv[i + 1] || '') : ''; };
const AUDIT_ONLY = has('--install-audit');
const REAL = has('--real-install-smoke');
const MODE = REAL ? 'real' : (AUDIT_ONLY ? 'audit' : 'skip');
/* Retired switches. Refusing them is the budget: there is no code path left that
   installs, launches and upgrades in a loop. */
const RETIRED = ['--force', '--allow-browser'].filter(has)
  .concat(process.env.IB_INSTALLER_SMOKE === '1' ? ['IB_INSTALLER_SMOKE=1'] : [])
  .concat(process.env.IB_SMOKE_ALLOW_BROWSER === '1' ? ['IB_SMOKE_ALLOW_BROWSER=1'] : []);

const ROOT = __dirname;
const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'installer', 'runtime-pin.json'), 'utf8'));
const PRODUCT = productVersion.read();
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
/* The developer's real user-data directory. This harness never writes here:
   DATA_DIR is repointed at a temp tree in prepareIsolation() before anything runs. */
const REAL_DATA_DIR = path.join(LOCALAPPDATA, 'InternalBeyond');
let ISOLATED_LOCALAPPDATA = LOCALAPPDATA;
let DATA_DIR = REAL_DATA_DIR;
const START_MENU = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'InternalBeyond');
const DESKTOP = path.join(os.homedir(), 'Desktop');
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{78B427F6-A48F-4443-86D5-2F50DC899D07}_is1';
/* Product ports. Overwritten with free ports in prepareIsolation() so this run
   can never collide with — or be stopped by — a dev instance. */
const DEV_PORTS = { web: 23120, restart: 23116, bridge: 23115, active: 23114 };
let WEB_PORT = DEV_PORTS.web;
let RESTART_PORT = DEV_PORTS.restart;
let BRIDGE_PORT = DEV_PORTS.bridge;
let ACTIVE_PORT = DEV_PORTS.active;
const WIN_AUDIT = path.join(ROOT, 'scripts', 'win-ib-processes.ps1');
/* One successful real smoke per built installer (keyed by the exe SHA-256). */
const LEDGER_FILE = path.join(os.tmpdir(), 'ib-p7-real-smoke-ledger.json');
const ALLOW_RERUN = has('--allow-rerun');

let pass = 0, fail = 0, skip = 0, refused = false;
const failures = [];
function guard() {
  if (globalTimedOut || Date.now() - RUN_STARTED_AT > GLOBAL_TIMEOUT_MS) {
    throw new Error('global timeout exceeded (' + Math.round(GLOBAL_TIMEOUT_MS / 1000) + 's)');
  }
}
function check(name, fn) {
  try {
    guard();
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('async check must use acheck');
    pass++; console.log('  ✓ ' + name);
  } catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
/* Every async case has a hard deadline: a hung installer, launcher or port probe
   fails the case and reports the resources it left behind instead of hanging. */
async function acheck(name, fn, opts) {
  const ms = (opts && opts.timeoutMs) || CASE_TIMEOUT_MS;
  try { await withDeadline(name, ms, fn); pass++; console.log('  ✓ ' + name); }
  catch (e) {
    fail++; failures.push(name + ': ' + (e && e.message || e));
    console.log('  ✗ ' + name + ' — ' + (e && e.message || e));
    if (/hard timeout/.test(String(e && e.message || e))) {
      console.log('  ! leftover resources after the timeout:');
      for (const line of await leftoverReport()) console.log('      ' + line);
    }
  }
}
function skipped(name, why) { skip++; console.log('  – ' + name + ' (SKIP: ' + why + ')'); }

/* ── helpers ───────────────────────────────────────────────────────────── */

function run(file, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: o.timeoutMs || 300000, cwd: o.cwd, env: o.env, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        error: err ? String(err.message) : null,
        stdout: String(stdout || ''), stderr: String(stderr || '')
      }));
  });
}
function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(url, { timeout: timeoutMs || 2500 }, (res) => {
        let raw = ''; res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null; try { json = JSON.parse(raw); } catch (e) { }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: raw, json: json });
        });
      });
    } catch (e) { resolve({ ok: false, status: 0, body: '', json: null, error: String(e && e.message || e) }); return; }
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } resolve({ ok: false, status: 0, body: '', json: null, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: '', json: null, error: String((e && e.code) || (e && e.message) || e) }));
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function walk(dir, prefix, out) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  for (const n of names) {
    const full = path.join(dir, n);
    const rel = prefix ? prefix + '/' + n : n;
    let st = null;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (st.isDirectory()) walk(full, rel, out); else out.push(rel);
  }
  return out;
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function portBound(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: port, timeout: 500 });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) { } resolve(v); };
    s.on('connect', () => fin(true)); s.on('timeout', () => fin(false)); s.on('error', () => fin(false));
  });
}
async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return true; await sleep(stepMs || 400); }
  return false;
}
function psFile(script, args) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args), { timeoutMs: 60000 })
    .then(r => r.stdout.trim().split(/\r?\n/).filter(Boolean));
}
function ibProcesses(root) { return psFile(WIN_AUDIT, ['-Root', root, '-Mode', 'processes']); }

/* ── state ─────────────────────────────────────────────────────────────── */

const EXE = argOf('--exe') || path.join(ROOT, 'dist', 'InternalBeyond-Setup-' + PRODUCT.version + '.exe');
const SMOKE_ROOT = path.join(os.tmpdir(), 'ib-p7-smoke');
const SMOKE_MARKER = 'ib-p7-smoke-root.json';
const INSTALL_DIR = path.join(SMOKE_ROOT, 'install-' + Date.now());
const MARKER = 'ib-p7-smoke-marker.json';
const MARKER_TEXT = JSON.stringify({ phase: 'P7', at: new Date().toISOString(), version: PRODUCT.version });
/* Reassigned by prepareIsolation() to the isolated data dir. */
let MARKER_PATH = path.join(DATA_DIR, MARKER);
const VBS = path.join(INSTALL_DIR, '启动 InternalBeyond.vbs');
const UNINSTALLER = path.join(INSTALL_DIR, 'unins000.exe');
/* Every child this harness starts, so cleanup() can stop exactly those and no
   process it did not create. */
const tracked = new Set();
/* Temp dirs holding decoy Node copies started by the upgrade scenario. */
const DECOYS = [];

/* ── isolation · deadlines · browser policy ────────────────────────────── */

const CASE_TIMEOUT_MS = Number(process.env.IB_SMOKE_CASE_TIMEOUT_MS) || 60000;
/* Installing ~120 MB of payload legitimately takes longer than a behavioural
   case; those steps get an explicit budget. */
const SLOW_TIMEOUT_MS = Number(process.env.IB_SMOKE_SLOW_TIMEOUT_MS) || 240000;
const GLOBAL_TIMEOUT_MS = Number(process.env.IB_SMOKE_GLOBAL_TIMEOUT_MS) || 15 * 60 * 1000;
const RUN_STARTED_AT = Date.now();
let globalTimedOut = false;

function withDeadline(name, ms, fn) {
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('hard timeout after ' + Math.round(ms / 1000) + 's: ' + name)), ms);
  });
  return Promise.race([Promise.resolve().then(fn), expired]).finally(() => clearTimeout(timer));
}

/* The environment every child inherits. The installer's stop helper and the
   launched app read the same product overrides, so both stay on the isolated
   ports and neither can see the developer's instance. */
function smokeEnv(extra) {
  return Object.assign({}, process.env, {
    IB_WEB_PORT: String(WEB_PORT),
    IB_RESTART_PORT: String(RESTART_PORT),
    IB_BRIDGE_PORT: String(BRIDGE_PORT),
    IB_ACTIVE_PORT: String(ACTIVE_PORT)
  }, extra || {});
}

/* Hold every ephemeral listener open until all ports are collected, so the same
   port can never be handed out twice inside one run. */
function allocateFreePorts(n) {
  return new Promise((resolve, reject) => {
    const servers = [], ports = [];
    const next = () => {
      if (ports.length === n) {
        for (const s of servers) { try { s.close(); } catch (e) { /* already closed */ } }
        resolve(ports);
        return;
      }
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { ports.push(s.address().port); servers.push(s); next(); });
    };
    next();
  });
}

/* Move the whole run off the product's default ports and off the developer's
   user-data directory. Called once, before anything is installed or launched. */
async function prepareIsolation() {
  const ports = await allocateFreePorts(4);
  WEB_PORT = ports[0]; RESTART_PORT = ports[1]; BRIDGE_PORT = ports[2]; ACTIVE_PORT = ports[3];
  const clash = Object.keys(DEV_PORTS).filter(k => ports.indexOf(DEV_PORTS[k]) >= 0);
  assert.strictEqual(clash.length, 0, 'isolated ports must never reuse the product defaults: ' + clash.join(','));
  ISOLATED_LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-data-'));
  DATA_DIR = path.join(ISOLATED_LOCALAPPDATA, 'InternalBeyond');
  MARKER_PATH = path.join(DATA_DIR, MARKER);
  console.log('isolation: ports web=' + WEB_PORT + ' restart=' + RESTART_PORT +
    ' bridge=' + BRIDGE_PORT + ' active=' + ACTIVE_PORT + ' · data=' + DATA_DIR +
    ' · browser=' + (REAL ? 'exactly one window' : 'suppressed'));
}

/* ── real-smoke ledger (one success per built installer) ───────────────── */

function readLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeLedger(ledger) {
  try { fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2)); } catch (e) { /* best effort */ }
}

/* ── developer-instance guard ──────────────────────────────────────────── */

function ibIdentityAt(port, pathname, test) {
  return getJson('http://127.0.0.1:' + port + pathname, 1500)
    .then(r => !!(r.ok && r.json && test(r.json)));
}
/* What the developer's instance looks like on the product's default ports. The
   smoke must leave this exactly as it found it. */
async function devInstanceState() {
  return {
    web: await ibIdentityAt(DEV_PORTS.web, '/health', j => j.server === 'InternalBeyond Web'),
    restart: await ibIdentityAt(DEV_PORTS.restart, '/status', j => j.service === 'InternalBeyond Restart'),
    bridge: await ibIdentityAt(DEV_PORTS.bridge, '/health', j => j.server === 'IB Bridge'),
    active: await ibIdentityAt(DEV_PORTS.active, '/health', j => j.service === 'internal-beyond-active-messages')
  };
}

/* ── browser open accounting ───────────────────────────────────────────── */

/* The launcher logs "Opening <url>" for every real browser open and
   "[test] browser open suppressed" when the seam is used. Counting the former is
   the assertion that automated runs never open a window. */
function browserOpens() {
  const logFile = path.join(INSTALL_DIR, 'logs', 'launcher.log');
  if (!fs.existsSync(logFile)) return 0;
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch (e) { return 0; }
  return (text.match(/Opening https?:\/\//g) || []).length;
}

/* ── leftover-resource report (printed on timeout or failure) ──────────── */

async function leftoverReport() {
  const lines = [];
  try {
    const rows = await ibProcesses(INSTALL_DIR);
    lines.push('IB processes from the temp install: ' +
      (rows.length ? rows.map(r => String(r).split('\t')[0]).join(',') : 'none'));
  } catch (e) { lines.push('IB process probe failed: ' + (e && e.message || e)); }
  lines.push('tracked child pids: ' + (tracked.size ? Array.from(tracked).join(',') : 'none'));
  lines.push('browser opens recorded: ' + browserOpens());
  lines.push('temp install dir: ' + INSTALL_DIR + ' (exists=' + fs.existsSync(INSTALL_DIR) + ')');
  lines.push('isolated data dir: ' + ISOLATED_LOCALAPPDATA + ' (exists=' + fs.existsSync(ISOLATED_LOCALAPPDATA) + ')');
  lines.push('developer ports: ' + JSON.stringify(await devInstanceState()));
  return lines;
}

/* ── temp install tree hygiene ─────────────────────────────────────────── */

/* Written into the install dir BEFORE the installer runs, so an interrupted
   run still leaves a directory that is provably ours. */
function prepareInstallDir() {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(path.join(INSTALL_DIR, SMOKE_MARKER),
    JSON.stringify({ phase: 'P7', root: INSTALL_DIR, at: new Date().toISOString(), version: PRODUCT.version }));
}
/* A directory is ours if it carries the marker, or — for trees left by an older
   run of this test — if it has the unmistakable installed shape. */
function looksLikeOurInstall(dir) {
  if (fs.existsSync(path.join(dir, SMOKE_MARKER))) return true;
  return fs.existsSync(path.join(dir, 'InternalBeyond.html')) &&
    fs.existsSync(path.join(dir, 'runtime', 'node', 'node.exe'));
}
async function killIbProcesses(root) {
  let rows = [];
  try { rows = await ibProcesses(root); } catch (e) { return; }
  for (const row of rows) {
    const pid = Number(String(row).split('\t')[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }); } catch (e) { /* already gone */ }
  }
}
async function removeTree(dir) {
  if (!fs.existsSync(dir)) return true;
  for (let i = 0; i < 12; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* locked for a moment */ }
    if (!fs.existsSync(dir)) return true;
    await sleep(700);
  }
  return !fs.existsSync(dir);
}
/* Remove install trees from an interrupted earlier run: kill their processes
   first (a live node.exe keeps the files locked), then delete the tree. */
async function sweepLeftovers() {
  const parent = os.tmpdir();
  const candidates = [];
  let names = [];
  try { names = fs.readdirSync(parent); } catch (e) { return []; }
  for (const n of names) {
    if (/^ib-p7-install-\d+$/.test(n)) candidates.push(path.join(parent, n));
  }
  if (fs.existsSync(SMOKE_ROOT)) {
    for (const n of fs.readdirSync(SMOKE_ROOT)) candidates.push(path.join(SMOKE_ROOT, n));
  }
  const removed = [];
  for (const dir of candidates) {
    if (path.resolve(dir) === path.resolve(INSTALL_DIR)) continue;
    if (!fs.existsSync(dir) || !looksLikeOurInstall(dir)) continue;
    await killIbProcesses(dir);
    if (await removeTree(dir)) removed.push(dir);
  }
  return removed;
}

function silentInstall(dir) {
  /* env: the installer's PrepareToInstall preflight runs tools\ib-stop.js, which
     stops whatever answers on the product's ports. smokeEnv() moves those ports,
     so the preflight can only ever stop this smoke's own instance. */
  return run(EXE, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/LANG=chinesesimplified',
    '/MERGETASKS=desktopicon', '/DIR=' + dir, '/LOG=' + path.join(os.tmpdir(), 'ib-p7-setup-' + Date.now() + '.log')],
    { timeoutMs: SLOW_TIMEOUT_MS, env: smokeEnv() });
}
function silentUninstall() {
  /* Same for [UninstallRun] → ib-stop.js. */
  return run(UNINSTALLER, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
    { timeoutMs: SLOW_TIMEOUT_MS, env: smokeEnv() });
}
function launchApp(env) {
  /* Exactly what the shortcut does: wscript.exe + the .vbs, hidden, detached.
     The browser is ALWAYS suppressed (the launcher's own test seam): the final
     verification is about install → launch → upgrade → uninstall, not about
     opening a window. */
  const childEnv = smokeEnv(Object.assign({ LOCALAPPDATA: ISOLATED_LOCALAPPDATA, IB_LAUNCH_NO_OPEN: '1' }, env || {}));
  const child = spawn('wscript.exe', [VBS], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv });
  child.unref();
  tracked.add(child.pid);
  return child.pid;
}
/* A Node process that has nothing to do with this install, used to prove the
   upgrade never kills unrelated Node software. It runs from a COPY of the
   runtime in a separate temp dir, so it never locks the installed node.exe. */
function startDecoy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-decoy-'));
  const exe = path.join(dir, 'node.exe');
  fs.copyFileSync(path.join(INSTALL_DIR, 'runtime', 'node', 'node.exe'), exe);
  const child = spawn(exe, ['-e', 'setTimeout(function(){}, 600000)'],
    { stdio: 'ignore', windowsHide: true, detached: true, env: smokeEnv() });
  child.unref();
  tracked.add(child.pid);
  DECOYS.push(dir);
  return { pid: child.pid, dir: dir };
}
function alivePid(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}
function appHealthy() {
  return getJson('http://127.0.0.1:' + WEB_PORT + '/health').then(h => !!(h.ok && h.json && h.json.server === 'InternalBeyond Web'));
}

/* ── main ──────────────────────────────────────────────────────────────── */

async function main() {
  console.log('Windows installer smoke (P7 · budgeted)\n');

  if (RETIRED.length) {
    refused = true;
    console.log('  ✗ refused: ' + RETIRED.join(', ') + ' is retired by the P7 test budget.');
    console.log('    Repeated install → launch → upgrade → uninstall loops disturb the development');
    console.log('    machine. Use ONE of:');
    console.log('      node test_installer.js                 (static contract, no install)');
    console.log('      node test_installer_mock.js            (mocked launcher / stop helper)');
    console.log('      node test_installer_smoke.js --install-audit      (isolated payload audit)');
    console.log('      node test_installer_smoke.js --real-install-smoke (the single real run)');
    return;
  }
  if (MODE === 'skip') {
    skipped('installer smoke', 'pass --install-audit (isolated payload audit) or --real-install-smoke (the single real run)');
    return;
  }
  if (!fs.existsSync(EXE)) {
    fail++; failures.push('installer exists');
    console.log('  ✗ installer exists — not found: ' + EXE);
    return;
  }

  const exeHash = sha256(EXE);
  const ledger = readLedger();
  const previous = ledger[exeHash] || null;
  if (REAL && previous && previous.success && !ALLOW_RERUN) {
    refused = true;
    console.log('  ✗ refused: this installer already passed the real smoke on ' + previous.at +
      ' (' + exeHash.slice(0, 12) + '…).');
    console.log('    The P7 budget allows one successful real install smoke per built installer.');
    console.log('    Rebuild the installer (new SHA-256) or pass --allow-rerun deliberately.');
    return;
  }
  if (REAL && previous && previous.success) {
    console.log('  ! --allow-rerun: repeating a real smoke that already passed on ' + previous.at);
  }

  /* Isolate ports + user data first: nothing below may run against the
     developer's instance on the product's default ports. */
  await prepareIsolation();
  const devBefore = await devInstanceState();

  /* ── [0] start from a clean temp tree ── */
  const swept = await sweepLeftovers();
  if (swept.length) console.log('swept leftovers from an earlier run:\n  ' + swept.join('\n  '));
  prepareInstallDir();
  /* The isolated user-data marker is written in BOTH modes so "uninstall keeps
     user data" is verified without ever launching the app. */
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MARKER_PATH, MARKER_TEXT);

  /* ── [1] installer artefact ── */
  console.log('\n[1] installer artefact');
  const sumsFile = path.join(path.dirname(EXE), 'SHA256SUMS.txt');

  check('installer exists and is a PE executable of plausible size', () => {
    assert.strictEqual(fs.readFileSync(EXE).slice(0, 2).toString('latin1'), 'MZ', 'must be a Windows executable');
    assert.ok(fs.statSync(EXE).size > 20 * 1024 * 1024, 'installer looks too small: ' + fs.statSync(EXE).size);
  });
  check('installer requests asInvoker (no UAC elevation)', () => {
    const buf = fs.readFileSync(EXE).toString('latin1');
    assert.ok(buf.indexOf('requestedExecutionLevel') >= 0, 'embedded manifest must declare an execution level');
    assert.ok(/level="asInvoker"/i.test(buf), 'must be asInvoker');
    assert.ok(buf.indexOf('requireAdministrator') < 0, 'must not require administrator');
  });
  check('installer is unsigned (documented release policy)', () => {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-AuthenticodeSignature -LiteralPath ' + JSON.stringify(EXE) + ').Status'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.strictEqual(out, 'NotSigned', 'expected an unsigned build, got ' + out);
  });
  check('SHA256SUMS.txt matches the installer', () => {
    assert.ok(fs.existsSync(sumsFile), 'SHA256SUMS.txt missing next to the installer');
    const line = fs.readFileSync(sumsFile, 'ascii').split(/\r?\n/).find(l => /\*InternalBeyond-Setup-/.test(l));
    assert.ok(line, 'checksum line missing');
    assert.ok(line.toLowerCase().indexOf(exeHash) >= 0, 'checksum mismatch: ' + line);
  });

  /* ── [2] silent install ── */
  console.log('\n[2] silent install (per-user, temp directory)');
  const install = await withDeadline('silent install', SLOW_TIMEOUT_MS, () => silentInstall(INSTALL_DIR));
  await acheck('installer exits 0', () => {
    assert.strictEqual(install.code, 0, 'installer failed: ' + (install.stderr || install.error || install.code));
  });
  check('installs the app + bundled runtime into the requested per-user directory', () => {
    assert.ok(fs.existsSync(path.join(INSTALL_DIR, 'InternalBeyond.html')), 'app document missing after install');
    assert.ok(fs.existsSync(path.join(INSTALL_DIR, 'runtime', 'node', 'node.exe')), 'bundled runtime missing after install');
  });

  /* ── [3] installed payload audit ── */
  console.log('\n[3] installed payload audit');
  /* SMOKE_MARKER is the harness's own "this tree is mine" file, written before
     the installer ran — it is not part of the payload. */
  const installedFiles = walk(INSTALL_DIR, '', []).filter(f => !/^logs\//.test(f) && !/^unins\d+\./i.test(f) && f !== SMOKE_MARKER);

  check('installed payload has no forbidden content', () => {
    const content = manifest.auditDirectory(INSTALL_DIR);
    const relevant = content.violations.filter(v => !/^unins\d+/.test(v.path));
    assert.strictEqual(relevant.length, 0, 'forbidden files installed: ' + JSON.stringify(relevant));
  });
  check('installed payload secret scan is clean', () => {
    /* Ignore what the installer itself generates locally: Inno's uninstall data
       (records the local install path) and the runtime log directory. Neither is
       part of the shipped payload; the staged-payload scan covers that. */
    const report = audit.scanDirectory(INSTALL_DIR, { ignore: [/^unins\d+\./i, /^logs\//] });
    assert.strictEqual(report.errors, 0, 'secret findings: ' + JSON.stringify(report.findings.filter(f => f.severity === 'error')));
  });
  check('installed payload equals the whitelist (no extra dev files)', () => {
    const expected = new Set(manifest.resolve({}).files.map(f => f.to));
    const extra = installedFiles.filter(f => !expected.has(f));
    assert.strictEqual(extra.length, 0, 'unexpected files installed: ' + extra.slice(0, 10).join(', '));
  });
  check('bundled runtime installed, byte-exact and at the pinned version', () => {
    const exe = path.join(INSTALL_DIR, 'runtime', 'node', 'node.exe');
    assert.strictEqual(sha256(exe), PIN.runtime.sha256, 'installed node.exe hash mismatch');
    const v = execFileSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.strictEqual(v, 'v' + PIN.runtime.version, 'installed runtime version mismatch');
  });
  check('guide assets installed (16 shots + module + stylesheet)', () => {
    const shots = installedFiles.filter(f => /^docs\/guide\/shots\/.+\.png$/.test(f));
    assert.strictEqual(shots.length, 16, 'expected 16 guide screenshots, got ' + shots.length);
    assert.ok(installedFiles.indexOf('assets/js/guide-beginner.js') >= 0, 'guide module missing');
    assert.ok(installedFiles.indexOf('assets/css/guide-beginner.css') >= 0, 'guide stylesheet missing');
  });
  check('single user entry point installed (start menu + desktop shortcut)', () => {
    const sm = path.join(START_MENU, 'InternalBeyond.lnk');
    const dk = path.join(DESKTOP, 'InternalBeyond.lnk');
    assert.ok(fs.existsSync(sm), 'start menu shortcut missing: ' + sm);
    assert.ok(fs.existsSync(dk), 'desktop shortcut missing: ' + dk);
    const q = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      'foreach ($p in @(' + JSON.stringify(sm) + ',' + JSON.stringify(dk) + ')) {' +
      '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); Write-Output ($s.TargetPath + "|" + $s.Arguments)}';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { encoding: 'utf8', windowsHide: true });
    const lines = out.trim().split(/\r?\n/).filter(Boolean);
    assert.strictEqual(lines.length, 2, 'expected two shortcuts, got ' + lines.length);
    for (const line of lines) {
      assert.ok(/wscript\.exe/i.test(line), 'shortcut must launch wscript (no console): ' + line);
      assert.ok(/\.vbs"?\s*$/i.test(line), 'shortcut must target the silent .vbs launcher: ' + line);
      const target = line.split('|')[1].replace(/^"|"$/g, '');
      assert.ok(fs.existsSync(target), 'shortcut target must exist: ' + target);
    }
  });
  check('no development launcher was installed', () => {
    const cmds = installedFiles.filter(f => /\.cmd$/i.test(f));
    assert.strictEqual(cmds.length, 0, 'dev .cmd installed: ' + cmds.join(', '));
  });
  check('uninstall entry registered for the current user', () => {
    const out = execFileSync('reg.exe', ['query', UNINSTALL_KEY, '/v', 'DisplayVersion'], { encoding: 'utf8', windowsHide: true });
    assert.ok(out.indexOf(PRODUCT.version) >= 0, 'uninstall entry must record the product version: ' + out);
  });
  check('stop helper installed for future upgrades', () => {
    assert.ok(fs.existsSync(path.join(INSTALL_DIR, 'tools', 'ib-stop.js')), 'tools/ib-stop.js missing');
  });

  /* ── [4] the single real launch (browser suppressed) ── */
  if (REAL) {
    console.log('\n[4] single real launch (wscript → .vbs → launcher, browser suppressed)');
    launchApp();
    await acheck('app becomes reachable on its local page service', async () => {
      const ok = await waitFor(appHealthy, 90000, 500);
      assert.ok(ok, 'web server did not become healthy within 90s');
    }, { timeoutMs: SLOW_TIMEOUT_MS });

    check('the launch opened no browser window', () => {
      assert.strictEqual(browserOpens(), 0, 'a browser window was opened: ' + browserOpens());
    });

    const health = await getJson('http://127.0.0.1:' + WEB_PORT + '/health');
    check('/health reports the product version from the single source', () => {
      assert.strictEqual(health.json.version, PRODUCT.version, 'version mismatch: ' + JSON.stringify(health.json));
    });

    /* /__boot-state is written twice (starting → complete). Assert on the
       completed record, never on the in-flight one. */
    const bootComplete = await waitFor(async () => {
      const b = await getJson('http://127.0.0.1:' + WEB_PORT + '/__boot-state');
      return !!(b.ok && b.json && b.json.bootState && b.json.bootState.phase === 'complete');
    }, 60000, 500);
    check('the launcher finished its launch record', () => {
      assert.ok(bootComplete, 'boot-state never reached phase=complete within 60s');
    });
    const boot = await getJson('http://127.0.0.1:' + WEB_PORT + '/__boot-state');
    check('boot state is present and not fatal', () => {
      assert.strictEqual(boot.json.present, true, 'boot-state missing');
      assert.notStrictEqual(boot.json.bootState.overall, 'fatal', 'launch was fatal: ' + JSON.stringify(boot.json.bootState.degradedReasons));
    });
    check('the served instance is the temp install, not the developer checkout', () => {
      const root = String(boot.json.bootState.launcher.root || '');
      assert.ok(root.toLowerCase() === INSTALL_DIR.toLowerCase(),
        'served instance must run from the temp install dir, got ' + root);
      assert.strictEqual(boot.json.bootState.launcher.serviceManager.startedByLauncher, true,
        'the temp install must manage its own services');
    });
    check('launch used the bundled runtime, not a system Node', () => {
      const n = boot.json.bootState.launcher.node;
      assert.strictEqual(n.bundled, true, 'must use the bundled runtime');
      assert.strictEqual(n.source, 'bundled', 'runtime source must be bundled, got ' + n.source);
      assert.ok(n.path.toLowerCase().indexOf(INSTALL_DIR.toLowerCase()) === 0, 'runtime path must live in the install dir: ' + n.path);
      assert.strictEqual(n.version, 'v' + PIN.runtime.version);
    });
    check('boot state records the product version', () => {
      assert.strictEqual(boot.json.bootState.launcher.product.version, PRODUCT.version);
    });

    const doc = await getJson('http://127.0.0.1:' + WEB_PORT + '/InternalBeyond.html');
    check('the main document answers 200', () => {
      assert.strictEqual(doc.status, 200, 'document not served: ' + doc.status);
      assert.ok(doc.body.indexOf('InternalBeyond') >= 0, 'document content unexpected');
    });
    await acheck('all 16 guide screenshots are reachable over HTTP', async () => {
      const shots = manifest.resolve({}).files.map(f => f.to).filter(f => /^docs\/guide\/shots\/.+\.png$/.test(f));
      assert.strictEqual(shots.length, 16);
      for (const s of shots) {
        const r = await getJson('http://127.0.0.1:' + WEB_PORT + '/' + s, 5000);
        assert.strictEqual(r.status, 200, 'guide shot not reachable: ' + s + ' → ' + r.status);
      }
    });
    await acheck('static server refuses private paths', async () => {
      for (const p of ['/.git/config', '/logs/launcher.log', '/tools/ib-stop.js', '/runtime/node/node.exe']) {
        const r = await getJson('http://127.0.0.1:' + WEB_PORT + p, 4000);
        assert.ok(r.status === 404 || r.status === 403, p + ' must not be served, got ' + r.status);
      }
    });

    /* ── [5] upgrade while this instance is still running ── */
    console.log('\n[5] upgrade while the instance is running');
    const decoy = startDecoy();
    check('a decoy Node process from outside the install dir is running', () => {
      assert.ok(decoy.pid > 0 && alivePid(decoy.pid), 'the decoy failed to start');
    });

    const upgrade = await withDeadline('silent upgrade over a running instance', SLOW_TIMEOUT_MS,
      () => silentInstall(INSTALL_DIR));
    await acheck('the installer upgrades over a running instance (no file-lock failure)', () => {
      assert.strictEqual(upgrade.code, 0, 'upgrade failed: ' + (upgrade.stderr || upgrade.error || upgrade.code));
    });
    check('an unrelated Node process survived the upgrade', () => {
      assert.strictEqual(alivePid(decoy.pid), true, 'the installer must never kill unrelated Node processes');
    });
    await acheck('the running instance was stopped and its runtime released', async () => {
      const gone = await waitFor(async () => (await ibProcesses(INSTALL_DIR)).length === 0, 60000, 500);
      assert.ok(gone, 'an IB process from the install dir is still running after the upgrade');
      const free = await waitFor(async () => !(await portBound(WEB_PORT)), 30000, 500);
      assert.ok(free, 'the web port was not released after the upgrade');
    });
    check('the bundled runtime was replaced and is byte-exact', () => {
      assert.strictEqual(sha256(path.join(INSTALL_DIR, 'runtime', 'node', 'node.exe')), PIN.runtime.sha256,
        'node.exe must be replaced cleanly (a stale lock would leave it behind)');
      assert.strictEqual(fs.readFileSync(path.join(INSTALL_DIR, 'VERSION'), 'utf8').trim(), PRODUCT.version);
    });
    check('user data survived the upgrade', () => {
      assert.ok(fs.existsSync(MARKER_PATH), 'user data marker was deleted by the upgrade');
      assert.strictEqual(fs.readFileSync(MARKER_PATH, 'utf8'), MARKER_TEXT, 'user data content changed');
    });
    check('the upgrade opened no browser window', () => {
      assert.strictEqual(browserOpens(), 0, 'a browser window was opened during the upgrade: ' + browserOpens());
    });
  } else {
    check('isolated audit run never opened a browser', () => {
      assert.strictEqual(browserOpens(), 0, 'a browser window was opened during the payload audit');
    });
  }

  /* ── [6] uninstall ── */
  console.log('\n[6] uninstall');
  const un = await withDeadline('silent uninstall', SLOW_TIMEOUT_MS, () => silentUninstall());
  await acheck('uninstaller exits 0 and removes program files + shortcuts', async () => {
    assert.strictEqual(un.code, 0, 'uninstaller failed: ' + (un.stderr || un.error));
    const gone = await waitFor(async () => !fs.existsSync(path.join(INSTALL_DIR, 'InternalBeyond.html')), 90000, 500);
    assert.ok(gone, 'program files must be removed');
    assert.strictEqual(fs.existsSync(path.join(START_MENU, 'InternalBeyond.lnk')), false, 'start menu shortcut must be removed');
    assert.strictEqual(fs.existsSync(path.join(DESKTOP, 'InternalBeyond.lnk')), false, 'desktop shortcut must be removed');
  });
  check('uninstall keeps user data', () => {
    assert.ok(fs.existsSync(MARKER_PATH), 'uninstall deleted user data');
    assert.strictEqual(fs.readFileSync(MARKER_PATH, 'utf8'), MARKER_TEXT, 'user data content changed');
    assert.ok(fs.existsSync(DATA_DIR), 'user data directory must be preserved');
  });
  check('uninstall entry removed from the registry', () => {
    let present = true;
    try { execFileSync('reg.exe', ['query', UNINSTALL_KEY], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { present = false; }
    assert.strictEqual(present, false, 'uninstall registry entry must be removed');
  });

  /* ── [7] the developer's own instance must be exactly as it was ── */
  console.log('\n[7] developer instance untouched');
  const devAfter = await devInstanceState();
  check('the developer instance on the default ports is untouched', () => {
    assert.deepStrictEqual(devAfter, devBefore,
      'the smoke changed the instance on the product ports: before=' + JSON.stringify(devBefore) +
      ' after=' + JSON.stringify(devAfter));
  });

  /* Record the budget outcome: a real smoke that passed is spent. */
  if (REAL) {
    const entry = {
      success: fail === 0,
      at: new Date().toISOString(),
      version: PRODUCT.version,
      attempts: ((previous && previous.attempts) || 0) + 1,
      installDir: INSTALL_DIR
    };
    ledger[exeHash] = entry;
    writeLedger(ledger);
    console.log('\nledger: ' + (entry.success ? 'real smoke recorded as PASSED (one per installer)' : 'real smoke attempt recorded (not successful)'));
  }
}

async function cleanup() {
  try { fs.rmSync(MARKER_PATH, { force: true }); } catch (e) { /* keep going */ }
  /* Stop exactly the children this run started — never a process we did not
     create. taskkill by PID (and tree), never by image name. */
  for (const pid of tracked) {
    try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }); }
    catch (e) { /* already gone */ }
  }
  tracked.clear();
  /* Leave nothing behind: no InternalBeyond process still running out of the
     temp install, no temp user-data tree, and no ~90 MB temp copy of the runtime
     — a leftover truncated node.exe is exactly what makes Windows offer to run a
     broken binary later. */
  await killIbProcesses(INSTALL_DIR);
  const removed = await removeTree(INSTALL_DIR);
  if (!removed) console.log('  ! could not remove the temp install tree: ' + INSTALL_DIR);
  for (const dir of DECOYS) await removeTree(dir);
  if (ISOLATED_LOCALAPPDATA !== LOCALAPPDATA) {
    const gone = await removeTree(ISOLATED_LOCALAPPDATA);
    if (!gone) console.log('  ! could not remove the isolated data dir: ' + ISOLATED_LOCALAPPDATA);
  }
  try { if (fs.existsSync(SMOKE_ROOT) && fs.readdirSync(SMOKE_ROOT).length === 0) fs.rmdirSync(SMOKE_ROOT); } catch (e) { /* not empty */ }
}

main().then(cleanup, (err) => {
  console.error('smoke harness error: ' + (err && err.stack || err));
  fail++; failures.push('harness: ' + (err && err.message || err));
  return leftoverReport().then((lines) => {
    console.log('leftover resources at failure:');
    for (const l of lines) console.log('  ' + l);
    return cleanup();
  });
})
  .then(() => {
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败, ' + skip + ' 跳过');
    if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exitCode = refused ? 2 : (fail ? 1 : 0);
  });
