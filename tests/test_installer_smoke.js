'use strict';

/* P7 · Windows installer smoke — strictly budgeted (docs/P7-TEST-BUDGET.md).
 *
 * Modes (at most one per invocation):
 *   (no flag)             SKIP, exit 0. Nothing is installed, launched or opened.
 *
 *   --install-audit       Isolated silent install → installed-payload audit →
 *                         uninstall. No launch, no browser (asserts 0 opens).
 *                         Requires a test-only installer produced with
 *                         scripts/build-installer.ps1 -TestMode.
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
 *   · temp install dir + temp LOCALAPPDATA + 5 free ports handed to EVERY child
 *     (installer, uninstaller, launcher, stop helper) — the dev checkout and the
 *     real %LOCALAPPDATA%\InternalBeyond are never touched
 *   · a deterministic TEST ONLY Inno AppId is compiled into the artifact; a
 *     production AppId or production dist artifact is rejected before install
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

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');

const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));
const audit = require(path.join(ROOT, 'scripts', 'release-audit.js'));
const productVersion = require(path.join(ROOT, 'runtime', 'product-version.js'));
const isolationGuard = require(path.join(ROOT, 'tests', 'p32-w4a-isolation-guard.js'));
const ISS_SOURCE = fs.readFileSync(path.join(ROOT, 'installer', 'InternalBeyond.iss'), 'utf8');

function issQuotedDefine(name) {
  const re = new RegExp('^\\s*#define\\s+' + name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\s+"([^"]+)"\\s*$', 'm');
  const m = ISS_SOURCE.match(re);
  return m ? m[1] : '';
}
function issGuidDefine(name) {
  const raw = issQuotedDefine(name);
  const m = /^\{\{([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}$/.exec(raw);
  return m ? m[1].toUpperCase() : '';
}

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

const PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'installer', 'runtime-pin.json'), 'utf8'));
const PRODUCT = productVersion.read();
const PROTECTED_PRODUCTION_APP_ID = '78B427F6-A48F-4443-86D5-2F50DC899D07';
const SOURCE_PRODUCTION_APP_ID = issGuidDefine('ProductionAppId');
const SOURCE_TEST_APP_ID = issGuidDefine('TestOnlyAppId');
const PRODUCTION_APP_ID = SOURCE_PRODUCTION_APP_ID || PROTECTED_PRODUCTION_APP_ID;
const TEST_APP_ID = SOURCE_TEST_APP_ID || 'A4D9E7B3-1F86-4C2A-9D57-6B3E1C8F0A24';
const TEST_APP_NAME = issQuotedDefine('TestOnlyAppName') || 'InternalBeyond Installer Smoke Test';
const TEST_INSTALL_DIRECTORY_NAME = issQuotedDefine('TestOnlyInstallDirectoryName') || 'InternalBeyond-Installer-Smoke-Test';
const TEST_OUTPUT_BASE_NAME = issQuotedDefine('TestOnlyOutputBaseName') || 'InternalBeyond-Installer-Smoke-Test';
const TEST_PUBLISHER = 'InternalBeyond (Test Only)';
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
/* The developer's real user-data directory. This harness never writes here:
   DATA_DIR is repointed at a temp tree in prepareIsolation() before anything runs. */
const REAL_DATA_DIR = path.join(LOCALAPPDATA, 'InternalBeyond');
let ISOLATED_LOCALAPPDATA = LOCALAPPDATA;
let ISOLATED_LOCALAPPDATA_OWNED = false;
const ISOLATED_EXTRA_ROOTS = [];
let DATA_DIR = REAL_DATA_DIR;
let MARKER_CREATED = false;
const REAL_APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_USERPROFILE = process.env.USERPROFILE || os.homedir();
const PRODUCTION_START_SHORTCUT = path.join(REAL_APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'InternalBeyond', 'InternalBeyond.lnk');
const PRODUCTION_DESKTOP_SHORTCUT = path.join(REAL_USERPROFILE, 'Desktop', 'InternalBeyond.lnk');
let ISOLATED_APPDATA = REAL_APPDATA;
let ISOLATED_USERPROFILE = REAL_USERPROFILE;
let ISOLATED_TEMP = os.tmpdir();
let ISOLATED_TMP = os.tmpdir();
let TEST_START_MENU = path.join(ISOLATED_APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', TEST_APP_NAME);
let TEST_START_SHORTCUT = path.join(TEST_START_MENU, TEST_APP_NAME + '.lnk');
let TEST_UNINSTALL_SHORTCUT = path.join(TEST_START_MENU, '卸载 ' + TEST_APP_NAME + '.lnk');
let TEST_DESKTOP_SHORTCUT = path.join(ISOLATED_USERPROFILE, 'Desktop', TEST_APP_NAME + '.lnk');
const PRODUCTION_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{' + PROTECTED_PRODUCTION_APP_ID + '}_is1';
const TEST_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{' + TEST_APP_ID + '}_is1';
const TAURI_UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InternalBeyond';
const TAURI_MANUFACTURER_KEY = 'HKCU\\Software\\InternalBeyond\\InternalBeyond';
/* Product ports. Overwritten with free ports in prepareIsolation() so this run
   can never collide with — or be stopped by — a dev instance. */
const DEV_PORTS = { web: 23120, restart: 23116, bridge: 23115, active: 23114, homeNode: 23118 };
let WEB_PORT = DEV_PORTS.web;
let RESTART_PORT = DEV_PORTS.restart;
let BRIDGE_PORT = DEV_PORTS.bridge;
let ACTIVE_PORT = DEV_PORTS.active;
let HOME_NODE_PORT = DEV_PORTS.homeNode;
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

function fatal(message) { throw new Error('FATAL:\n' + message); }
function normalizedPath(value) {
  return path.resolve(String(value || '')).replace(/[\\\/]+$/, '').toLowerCase();
}
function isSameOrWithin(candidate, parent) {
  const c = normalizedPath(candidate);
  const p = normalizedPath(parent);
  return c === p || c.indexOf(p + path.sep) === 0;
}
function canonicalPath(value) {
  const absolute = path.resolve(String(value));
  let probe = absolute;
  const suffix = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    suffix.unshift(path.basename(probe));
    probe = parent;
  }
  let real = probe;
  try { real = fs.realpathSync.native(probe); } catch (e) { }
  return suffix.length ? path.resolve(real, ...suffix) : path.resolve(real);
}
function assertNoReparseComponents(value) {
  const absolute = path.resolve(String(value));
  const root = path.parse(absolute).root;
  let current = root;
  const parts = path.relative(root, absolute).split(/[\\\/]/).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink()) fatal('reparse/symlink component is not allowed: ' + current);
    let real = current;
    try { real = fs.realpathSync.native(current); } catch (e) { }
    if (normalizedPath(real) !== normalizedPath(current)) {
      fatal('reparse/junction component is not allowed: ' + current + ' -> ' + real);
    }
  }
}
function assertPathSeparated(label, candidate, protectedRoot) {
  if (!protectedRoot) return;
  assertNoReparseComponents(candidate);
  assertNoReparseComponents(protectedRoot);
  const candidateCanonical = canonicalPath(candidate);
  const protectedCanonical = canonicalPath(protectedRoot);
  if (isSameOrWithin(candidateCanonical, protectedCanonical) || isSameOrWithin(protectedCanonical, candidateCanonical)) {
    fatal(label + ' overlaps protected root:\n  test=' + candidateCanonical + '\n  protected=' + protectedCanonical);
  }
}

function registryValue(snapshot, name) {
  const wanted = String(name).toLowerCase();
  const key = Object.keys(snapshot.values).find(k => k.toLowerCase() === wanted);
  return key ? snapshot.values[key] : null;
}
function readRegistrySnapshot(key) {
  let output = '';
  try {
    output = execFileSync('reg.exe', ['query', key], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e && e.status === 1) return { key: key, exists: false, values: {} };
    throw new Error('cannot read registry key ' + key + ': ' + (e && e.message || e));
  }
  const values = {};
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s+(REG_[A-Z0-9_]+)\s*(.*)$/.exec(line);
    if (m) values[m[1].trim()] = m[3].trim();
  }
  const sorted = {};
  Object.keys(values).sort((a, b) => a.localeCompare(b)).forEach(k => { sorted[k] = values[k]; });
  return { key: key, exists: true, values: sorted };
}
function protectedRegistrySnapshot() {
  return {
    productionInno: readRegistrySnapshot(PRODUCTION_UNINSTALL_KEY),
    tauriUninstall: readRegistrySnapshot(TAURI_UNINSTALL_KEY),
    tauriManufacturer: readRegistrySnapshot(TAURI_MANUFACTURER_KEY)
  };
}
function snapshotFile(file, includeText) {
  if (!fs.existsSync(file)) return { path: file, exists: false };
  const bytes = fs.readFileSync(file);
  const out = { path: file, exists: true, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  if (includeText) out.text = bytes.toString('utf8');
  return out;
}
function snapshotTreeMetadata(root) {
  if (!fs.existsSync(root)) return { root: root, exists: false, entries: [] };
  const entries = [];
  function visit(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        entries.push({ path: rel, type: 'symlink', target: fs.readlinkSync(full) });
      } else if (st.isDirectory()) {
        entries.push({ path: rel, type: 'dir', mtimeMs: st.mtimeMs });
        visit(full, rel);
      } else {
        entries.push({ path: rel, type: 'file', size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  visit(root, '');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { root: root, exists: true, entries: entries };
}
function protectedFilesystemSnapshot() {
  return {
    productionArtifacts: [
      snapshotFile(path.join(ROOT, 'dist', 'InternalBeyond-Setup-' + PRODUCT.version + '.exe'), false),
      snapshotFile(path.join(ROOT, 'dist', 'SHA256SUMS.txt'), false),
      snapshotFile(path.join(ROOT, 'dist', 'update-stable.json'), false),
      snapshotFile(path.join(ROOT, 'VERSION'), true)
    ],
    productionShortcuts: [
      snapshotFile(PRODUCTION_START_SHORTCUT, false),
      snapshotFile(PRODUCTION_DESKTOP_SHORTCUT, false)
    ],
    /* The live developer instance may legitimately update logs while this
       harness runs. Guard the exact files this installer-side test path could
       write instead of hashing or freezing the whole user-data directory. */
    realUserData: {
      root: REAL_DATA_DIR,
      exists: fs.existsSync(REAL_DATA_DIR),
      installerOwnedPaths: [
        snapshotFile(path.join(REAL_DATA_DIR, 'logs', 'upgrade-stop.json'), false),
        snapshotFile(path.join(REAL_DATA_DIR, 'logs', 'upgrade-prune.json'), false),
        snapshotFile(path.join(REAL_DATA_DIR, 'logs', 'runtime-invalid.txt'), false)
      ]
    }
  };
}
function protectedStateSnapshot() {
  return { registry: protectedRegistrySnapshot(), filesystem: protectedFilesystemSnapshot() };
}
function snapshotDiff(before, after, prefix, out) {
  if (out.length >= 12) return;
  if (before === after) return;
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') {
    out.push(prefix + ': ' + JSON.stringify(before) + ' -> ' + JSON.stringify(after));
    return;
  }
  const keys = new Set(Object.keys(before).concat(Object.keys(after)));
  for (const key of Array.from(keys).sort()) snapshotDiff(before[key], after[key], prefix ? prefix + '.' + key : key, out);
}
function assertProtectedStateUnchanged(label, before) {
  const after = protectedStateSnapshot();
  const diffs = [];
  snapshotDiff(before, after, '', diffs);
  if (diffs.length) fatal(label + ' changed protected state:\n  ' + diffs.join('\n  '));
  return after;
}
function bufferContainsToken(bytes, token) {
  const ascii = bytes.toString('latin1');
  const utf16 = bytes.toString('utf16le');
  return ascii.toLowerCase().indexOf(String(token).toLowerCase()) >= 0 ||
    utf16.toLowerCase().indexOf(String(token).toLowerCase()) >= 0;
}
function assertInstallerIdentity() {
  if (process.platform !== 'win32') fatal('installer smoke is Windows-only; refusing to run outside Windows');
  if (SOURCE_PRODUCTION_APP_ID !== PROTECTED_PRODUCTION_APP_ID) {
    fatal('canonical production Inno AppId changed or could not be read from installer/InternalBeyond.iss.\n' +
      'expected=' + PROTECTED_PRODUCTION_APP_ID + ' actual=' + (SOURCE_PRODUCTION_APP_ID || '(missing)'));
  }
  if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(TEST_APP_ID) || TEST_APP_ID === PROTECTED_PRODUCTION_APP_ID) {
    fatal('TEST ONLY AppId is missing, invalid, or equal to the protected production AppId');
  }
  const exeAbs = path.resolve(EXE);
  const productionDist = path.resolve(path.join(ROOT, 'dist'));
  if (isSameOrWithin(exeAbs, productionDist)) {
    fatal('Installer smoke test resolved to the production dist artifact. Refusing to execute installer:\n' + exeAbs);
  }
  const expectedArtifact = TEST_OUTPUT_BASE_NAME + '-Setup-' + PRODUCT.version + '.exe';
  if (path.basename(exeAbs) !== expectedArtifact) {
    fatal('test installer output name is not test-only.\nexpected=' + expectedArtifact + '\nactual=' + path.basename(exeAbs));
  }
  const evidenceFile = path.join(path.dirname(exeAbs), TEST_IDENTITY_FILE);
  if (!fs.existsSync(evidenceFile)) fatal('missing compiled test identity evidence: ' + evidenceFile);
  let evidence;
  try { evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')); }
  catch (e) { fatal('invalid compiled test identity evidence: ' + evidenceFile); }
  assert.strictEqual(evidence.testOnly, true, 'test identity evidence must be marked testOnly');
  assert.strictEqual(evidence.appId, '{' + TEST_APP_ID + '}');
  assert.strictEqual(evidence.productionAppId, '{' + PROTECTED_PRODUCTION_APP_ID + '}');
  assert.strictEqual(evidence.resolvedAppId, '{' + TEST_APP_ID + '}');
  assert.strictEqual(evidence.appName, TEST_APP_NAME);
  assert.strictEqual(evidence.installDirectoryName, TEST_INSTALL_DIRECTORY_NAME);
  assert.strictEqual(evidence.artifact, path.basename(exeAbs));
  assert.strictEqual(evidence.compilerDefine, 'InstallerTestMode=1');
  assert.ok(Array.isArray(evidence.compilerArgs) && evidence.compilerArgs.indexOf('/DInstallerTestMode=1') >= 0,
    'test identity evidence must record the explicit compile-time define');
  assert.strictEqual(evidence.source, 'installer/InternalBeyond.iss');
  assert.strictEqual(evidence.hostVersion, PRODUCT.version, 'test host PE version must match VERSION');
  assert.ok(/^[0-9a-f]{64}$/i.test(String(evidence.hostSha256 || '')), 'test identity evidence must carry a host SHA-256');
  assert.strictEqual(evidence.sha256, sha256(exeAbs), 'test identity evidence must bind to this installer bytes');
  const compileLog = path.join(path.dirname(exeAbs), 'build-compile.log');
  if (!fs.existsSync(compileLog)) fatal('missing compiler evidence log: ' + compileLog);
  const compileText = fs.readFileSync(compileLog, 'utf8');
  if (compileText.indexOf('InstallerTestMode=1') < 0 || compileText.indexOf(TEST_APP_ID) < 0) {
    fatal('compiler evidence does not prove the explicit test AppId define: ' + compileLog);
  }
  if (fs.existsSync(path.join(path.dirname(exeAbs), 'update-stable.json'))) {
    fatal('test installer output contains update-stable.json; update metadata is outside installer smoke scope');
  }
  const bytes = fs.readFileSync(exeAbs);
  if (bufferContainsToken(bytes, '{' + PROTECTED_PRODUCTION_APP_ID + '}') || bufferContainsToken(bytes, PROTECTED_PRODUCTION_APP_ID)) {
    fatal('Installer smoke test resolved to production Inno AppId. Refusing to execute installer.');
  }
  if (!bufferContainsToken(bytes, TEST_APP_NAME)) {
    fatal('compiled test installer display identity could not be statically proven from its bytes. Refusing to execute installer.');
  }
}
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

const EXE = argOf('--exe') || path.join(ROOT, 'tmp', 'installer-smoke-build', TEST_OUTPUT_BASE_NAME + '-Setup-' + PRODUCT.version + '.exe');
const SMOKE_ROOT = path.join(os.tmpdir(), 'ib-p7-smoke');
const SMOKE_MARKER = 'ib-p7-smoke-root.json';
const INSTALL_DIR = path.join(SMOKE_ROOT, 'install-' + Date.now());
const MARKER = 'ib-p7-smoke-marker.json';
const MARKER_TEXT = JSON.stringify({ phase: 'P7', at: new Date().toISOString(), version: PRODUCT.version });
/* Reassigned by prepareIsolation() to the isolated data dir. */
let MARKER_PATH = path.join(DATA_DIR, MARKER);
const HOST_EXE = path.join(INSTALL_DIR, 'internalbeyond-host.exe');
const VBS = path.join(INSTALL_DIR, '启动 InternalBeyond.vbs');
const UNINSTALLER = path.join(INSTALL_DIR, 'unins000.exe');
const TEST_IDENTITY_FILE = 'installer-test-identity.json';
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
    LOCALAPPDATA: ISOLATED_LOCALAPPDATA,
    APPDATA: ISOLATED_APPDATA,
    USERPROFILE: ISOLATED_USERPROFILE,
    TEMP: ISOLATED_TEMP,
    TMP: ISOLATED_TMP,
    IB_INSTALLER_SMOKE_DATA_DIR: DATA_DIR,
    IB_RUNTIME_MODE: 'production',
    IB_WEB_PORT: String(WEB_PORT),
    IB_RESTART_PORT: String(RESTART_PORT),
    IB_BRIDGE_PORT: String(BRIDGE_PORT),
    IB_ACTIVE_PORT: String(ACTIVE_PORT),
    IB_HOME_NODE_PORT: String(HOME_NODE_PORT)
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
  const ports = await allocateFreePorts(5);
  WEB_PORT = ports[0]; RESTART_PORT = ports[1]; BRIDGE_PORT = ports[2]; ACTIVE_PORT = ports[3]; HOME_NODE_PORT = ports[4];
  const clash = Object.keys(DEV_PORTS).filter(k => ports.indexOf(DEV_PORTS[k]) >= 0);
  assert.strictEqual(clash.length, 0, 'isolated ports must never reuse the product defaults: ' + clash.join(','));
  ISOLATED_LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-data-'));
  ISOLATED_APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-appdata-'));
  ISOLATED_USERPROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-user-'));
  ISOLATED_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-temp-'));
  ISOLATED_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p7-tmp-'));
  ISOLATED_EXTRA_ROOTS.push(ISOLATED_APPDATA, ISOLATED_USERPROFILE, ISOLATED_TEMP, ISOLATED_TMP);
  ISOLATED_LOCALAPPDATA_OWNED = true;
  for (const dir of [ISOLATED_LOCALAPPDATA, ISOLATED_APPDATA, ISOLATED_USERPROFILE, ISOLATED_TEMP, ISOLATED_TMP]) {
    assertNoReparseComponents(dir);
  }
  DATA_DIR = path.join(ISOLATED_LOCALAPPDATA, 'InternalBeyond');
  MARKER_PATH = path.join(DATA_DIR, MARKER);
  TEST_START_MENU = path.join(ISOLATED_APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', TEST_APP_NAME);
  TEST_START_SHORTCUT = path.join(TEST_START_MENU, TEST_APP_NAME + '.lnk');
  TEST_UNINSTALL_SHORTCUT = path.join(TEST_START_MENU, '卸载 ' + TEST_APP_NAME + '.lnk');
  TEST_DESKTOP_SHORTCUT = path.join(ISOLATED_USERPROFILE, 'Desktop', TEST_APP_NAME + '.lnk');
  fs.mkdirSync(path.dirname(TEST_DESKTOP_SHORTCUT), { recursive: true });
  assertIsolationBeforeSpawn();
  console.log('isolation: ports web=' + WEB_PORT + ' restart=' + RESTART_PORT +
    ' bridge=' + BRIDGE_PORT + ' active=' + ACTIVE_PORT + ' homeNode=' + HOME_NODE_PORT + ' · data=' + DATA_DIR +
    ' · appdata=' + ISOLATED_APPDATA + ' · userprofile=' + ISOLATED_USERPROFILE +
    ' · browser=suppressed');
}

function assertIsolationBeforeSpawn() {
  const before = protectedStateSnapshot();
  isolationGuard.assertIsolated({
    realLocalAppData: LOCALAPPDATA,
    realAppData: REAL_APPDATA,
    realUserProfile: REAL_USERPROFILE,
    realTemp: os.tmpdir(),
    realDataRoot: REAL_DATA_DIR,
    realInstallRoot: registryValue(before.registry.productionInno, 'InstallLocation'),
    realTauriRoot: registryValue(before.registry.tauriUninstall, 'InstallLocation'),
    realInnoRoot: registryValue(before.registry.productionInno, 'InstallLocation'),
    realStartMenu: path.dirname(PRODUCTION_START_SHORTCUT),
    realDesktop: PRODUCTION_DESKTOP_SHORTCUT,
    localAppData: ISOLATED_LOCALAPPDATA,
    appData: ISOLATED_APPDATA,
    temp: ISOLATED_TEMP,
    tmp: ISOLATED_TMP,
    userProfile: ISOLATED_USERPROFILE,
    installRoot: INSTALL_DIR,
    dataRoot: DATA_DIR,
    bootState: path.join(DATA_DIR, 'boot-state.json'),
    logs: path.join(DATA_DIR, 'logs'),
    activeData: path.join(DATA_DIR, 'active-message-service.json'),
    bridgeData: path.join(DATA_DIR, 'bridge'),
    homeNodeData: path.join(DATA_DIR, 'home-node'),
    webViewProfile: path.join(ISOLATED_LOCALAPPDATA, 'com.internalbeyond.desktop', 'EBWebView'),
    testStartMenu: TEST_START_MENU,
    testDesktopShortcut: TEST_DESKTOP_SHORTCUT,
    ports: { WEB_PORT, RESTART_PORT, BRIDGE_PORT, ACTIVE_PORT, HOME_NODE_PORT },
    defaultPorts: DEV_PORTS,
    productionInnoKey: PRODUCTION_UNINSTALL_KEY,
    tauriKey: TAURI_UNINSTALL_KEY,
    testInstallerKey: TEST_UNINSTALL_KEY,
    testAppName: TEST_APP_NAME
  });
  isolationGuard.assertWindowsShellIsolated({
    appData: ISOLATED_APPDATA,
    userProfile: ISOLATED_USERPROFILE
  });
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
    active: await ibIdentityAt(DEV_PORTS.active, '/health', j => j.service === 'internal-beyond-active-messages'),
    homeNode: await ibIdentityAt(DEV_PORTS.homeNode, '/health', j => j.service === 'internal-beyond-home-node')
  };
}

/* ── browser open accounting ───────────────────────────────────────────── */

/* The launcher logs "Opening <url>" for every real browser open and
   "[test] browser open suppressed" when the seam is used. Counting the former is
   the assertion that automated runs never open a window. */
function browserOpens() {
  const logFile = path.join(ISOLATED_LOCALAPPDATA, 'InternalBeyond', 'logs', 'launcher.log');
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
  if (fs.existsSync(INSTALL_DIR)) fatal('current smoke install root already exists; refusing to reuse it: ' + INSTALL_DIR);
  assertNoReparseComponents(INSTALL_DIR);
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.writeFileSync(path.join(INSTALL_DIR, SMOKE_MARKER),
    JSON.stringify({ phase: 'P7', root: INSTALL_DIR, at: new Date().toISOString(), version: PRODUCT.version }));
}
/* A directory is ours only if its marker names this harness and this exact root.
   The installed shape alone is not ownership proof. */
function looksLikeOurInstall(dir) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, SMOKE_MARKER), 'utf8'));
    return marker && marker.phase === 'P7' && normalizedPath(marker.root) === normalizedPath(dir);
  } catch (e) { return false; }
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

function protectedInstallRoots(state) {
  return [
    registryValue(state.registry.productionInno, 'InstallLocation'),
    registryValue(state.registry.tauriUninstall, 'InstallLocation'),
    registryValue(state.registry.tauriManufacturer, '(Default)')
  ].filter(Boolean);
}
function assertInitialSafety(state) {
  const testRegistry = readRegistrySnapshot(TEST_UNINSTALL_KEY);
  if (testRegistry.exists) {
    fatal('test uninstall key is already present; refusing to overwrite or clean an unknown prior run:\n' + JSON.stringify(testRegistry));
  }
  for (const shortcut of [TEST_START_SHORTCUT, TEST_UNINSTALL_SHORTCUT, TEST_DESKTOP_SHORTCUT]) {
    if (fs.existsSync(shortcut)) fatal('test-only shortcut already exists; refusing to overwrite it: ' + shortcut);
  }
  if (normalizedPath(ISOLATED_LOCALAPPDATA) === normalizedPath(LOCALAPPDATA)) {
    fatal('isolated LOCALAPPDATA resolved to the real LOCALAPPDATA');
  }
  assertPathSeparated('isolated user-data root', DATA_DIR, REAL_DATA_DIR);
  assertPathSeparated('test install root', INSTALL_DIR, REAL_DATA_DIR);
  for (const root of protectedInstallRoots(state)) assertPathSeparated('test install root', INSTALL_DIR, root);
  assertNoReparseComponents(INSTALL_DIR);
  assertNoReparseComponents(DATA_DIR);
}
function assertTestRegistryAfterInstall() {
  const snapshot = readRegistrySnapshot(TEST_UNINSTALL_KEY);
  if (!snapshot.exists) fatal('test-only uninstall key was not created: ' + TEST_UNINSTALL_KEY);
  assert.strictEqual(registryValue(snapshot, 'DisplayVersion'), PRODUCT.version);
  assert.ok(String(registryValue(snapshot, 'DisplayName') || '').indexOf(TEST_APP_NAME) >= 0,
    'test uninstall DisplayName must be visibly test-only');
  assert.strictEqual(registryValue(snapshot, 'Publisher'), TEST_PUBLISHER);
  assert.strictEqual(normalizedPath(registryValue(snapshot, 'InstallLocation')), normalizedPath(INSTALL_DIR),
    'test uninstall InstallLocation must equal the isolated install root');
  const expectedUninstaller = normalizedPath(UNINSTALLER);
  for (const name of ['UninstallString', 'QuietUninstallString']) {
    const value = registryValue(snapshot, name);
    if (value) {
      const executable = String(value).trim().replace(/^"([^"]+)".*$/, '$1').split(/\s+/)[0];
      assert.strictEqual(normalizedPath(executable), expectedUninstaller,
        name + ' must point to the test uninstaller inside the isolated root');
    }
  }
  return snapshot;
}
function shortcutMetadata(file) {
  if (!fs.existsSync(file)) return null;
  const q = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
    '$s=(New-Object -ComObject WScript.Shell).CreateShortcut(' + JSON.stringify(file) + ');' +
    'Write-Output ($s.TargetPath + "|" + $s.Arguments)';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q],
    { encoding: 'utf8', windowsHide: true }).trim();
  const i = out.indexOf('|');
  return { target: i >= 0 ? out.slice(0, i) : out, args: i >= 0 ? out.slice(i + 1) : '' };
}
function cleanupOwnedTestRegistry() {
  const snapshot = readRegistrySnapshot(TEST_UNINSTALL_KEY);
  if (!snapshot.exists) return;
  const location = registryValue(snapshot, 'InstallLocation');
  const displayName = String(registryValue(snapshot, 'DisplayName') || '');
  const owned = displayName.indexOf(TEST_APP_NAME) >= 0 &&
    normalizedPath(location) === normalizedPath(INSTALL_DIR) &&
    isSameOrWithin(location, SMOKE_ROOT);
  if (!owned) {
    console.log('  ! refusing to remove test registry residue without ownership proof: ' + TEST_UNINSTALL_KEY);
    return;
  }
  try {
    execFileSync('reg.exe', ['delete', TEST_UNINSTALL_KEY, '/f'], { windowsHide: true, stdio: 'ignore' });
    if (readRegistrySnapshot(TEST_UNINSTALL_KEY).exists) {
      console.log('  ! test registry residue remains after exact cleanup: ' + TEST_UNINSTALL_KEY);
    } else {
      console.log('  cleaned exact test-only uninstall key: ' + TEST_UNINSTALL_KEY);
    }
  } catch (e) {
    console.log('  ! could not remove exact test-only uninstall key: ' + (e && e.message || e));
  }
}
function cleanupOwnedTestShortcuts() {
  const expected = [
    { file: TEST_START_SHORTCUT, target: HOST_EXE, args: '' },
    { file: TEST_UNINSTALL_SHORTCUT, target: UNINSTALLER, args: '' },
    { file: TEST_DESKTOP_SHORTCUT, target: HOST_EXE, args: '' }
  ];
  for (const item of expected) {
    const file = item.file;
    if (!fs.existsSync(file)) continue;
    try {
      const meta = shortcutMetadata(file);
      const arg = String(meta && meta.args || '').trim().replace(/^"([^"]+)".*$/, '$1');
      if (!meta || normalizedPath(meta.target) !== normalizedPath(item.target) ||
          (item.args ? normalizedPath(arg) !== normalizedPath(item.args) : arg !== '')) {
        console.log('  ! refusing to remove test shortcut without exact target ownership: ' + file);
        continue;
      }
      fs.unlinkSync(file);
      console.log('  cleaned exact test-only shortcut: ' + file);
    } catch (e) {
      console.log('  ! could not inspect/remove test shortcut: ' + file + ' — ' + (e && e.message || e));
    }
  }
  try {
    if (fs.existsSync(TEST_START_MENU) && fs.readdirSync(TEST_START_MENU).length === 0) fs.rmdirSync(TEST_START_MENU);
  } catch (e) { /* leave a non-empty or locked test-only folder */ }
}

function silentInstall(dir) {
  assertIsolationBeforeSpawn();
  /* env: the installer's PrepareToInstall preflight runs tools\ib-stop.js, which
     stops whatever answers on the product's ports. smokeEnv() moves those ports,
     so the preflight can only ever stop this smoke's own instance. */
  return run(EXE, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/LANG=chinesesimplified',
    '/MERGETASKS=desktopicon', '/DIR=' + dir, '/LOG=' + path.join(os.tmpdir(), 'ib-p7-setup-' + Date.now() + '.log')],
    { timeoutMs: SLOW_TIMEOUT_MS, env: smokeEnv() });
}
function silentUninstall() {
  assertIsolationBeforeSpawn();
  /* Same for [UninstallRun] → ib-stop.js. */
  return run(UNINSTALLER, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
    { timeoutMs: SLOW_TIMEOUT_MS, env: smokeEnv() });
}
function launchApp(env) {
  assertIsolationBeforeSpawn();
  /* Exactly what the canonical shortcut does: the installed Host executable,
     hidden from the parent console and detached. The Host reuses the existing
     launcher; browser opening is suppressed by the existing launch seam. */
  const childEnv = smokeEnv(Object.assign({ LOCALAPPDATA: ISOLATED_LOCALAPPDATA, IB_LAUNCH_NO_OPEN: '1' }, env || {}));
  const child = spawn(HOST_EXE, [], { cwd: INSTALL_DIR, detached: true, stdio: 'ignore', windowsHide: true, env: childEnv });
  child.unref();
  tracked.add(child.pid);
  return child.pid;
}
/* A Node process that has nothing to do with this install, used to prove the
   upgrade never kills unrelated Node software. It runs from a COPY of the
   runtime in a separate temp dir, so it never locks the installed node.exe. */
function startDecoy() {
  assertIsolationBeforeSpawn();
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
function hostWindowState(pid) {
  const q = '$p=Get-Process -Id ' + Number(pid) + ' -ErrorAction Stop;' +
    '$p | Select-Object Id,MainWindowTitle,MainWindowHandle,Responding | ConvertTo-Json -Compress';
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], {
      encoding: 'utf8', windowsHide: true
    }).trim());
  } catch (e) { return null; }
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
     console.log('      node test_installer_smoke.js --install-audit --exe <test-only-exe>');
     console.log('      node test_installer_smoke.js --real-install-smoke --exe <test-only-exe>');
    return;
  }
  if (MODE === 'skip') {
    skipped('installer smoke', 'pass --install-audit/--real-install-smoke with a test-only installer');
    return;
  }
  if (!fs.existsSync(EXE)) {
    fail++; failures.push('installer exists');
    console.log('  ✗ installer exists — not found: ' + EXE);
    return;
  }

  /* Identity must be proven before any temp state is created and, critically,
     before the installer gets a chance to touch the registry. */
  assertInstallerIdentity();

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
  const protectedBefore = protectedStateSnapshot();
  assertInitialSafety(protectedBefore);
  const devBefore = await devInstanceState();

  /* ── [0] start from a clean temp tree ── */
  const swept = await sweepLeftovers();
  if (swept.length) console.log('swept leftovers from an earlier run:\n  ' + swept.join('\n  '));
  prepareInstallDir();
  /* The isolated user-data marker is written in BOTH modes so "uninstall keeps
     user data" is verified without ever launching the app. */
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MARKER_PATH, MARKER_TEXT);
  MARKER_CREATED = true;

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
    const systemModules = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    const signatureEnv = Object.assign({}, process.env, { PSModulePath: systemModules });
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; (Get-AuthenticodeSignature -LiteralPath ' + JSON.stringify(EXE) + ').Status'],
      { encoding: 'utf8', windowsHide: true, env: signatureEnv }).trim();
    assert.strictEqual(out, 'NotSigned', 'expected an unsigned build, got ' + out);
  });
  check('SHA256SUMS.txt matches the installer', () => {
    assert.ok(fs.existsSync(sumsFile), 'SHA256SUMS.txt missing next to the installer');
    const line = fs.readFileSync(sumsFile, 'ascii').split(/\r?\n/).find(l => l.indexOf('*' + path.basename(EXE)) >= 0);
    assert.ok(line, 'checksum line missing');
    assert.ok(line.toLowerCase().indexOf(exeHash) >= 0, 'checksum mismatch: ' + line);
  });

  /* ── [2] silent install ── */
  console.log('\n[2] silent install (per-user, temp directory)');
  const install = await withDeadline('silent install', SLOW_TIMEOUT_MS, () => silentInstall(INSTALL_DIR));
  assertProtectedStateUnchanged('after install', protectedBefore);
  assertTestRegistryAfterInstall();
  if (install.code !== 0) fatal('test installer failed after creating or probing its isolated identity: ' + (install.stderr || install.error || install.code));
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
    /* The whitelist enumerates everything staged FROM THE REPOSITORY. One payload
       file is not in it, because it cannot be: the install root's own payload
       manifest is generated by the build from the staged list itself, to a
       location that does not exist in the repository — declaring it as a
       whitelist source entry is impossible, and declaring a nonexistent source
       entry would fail staging outright (`missing`). Naming it here is what keeps
     the equality honest: the set is still exact, it is just (whitelist + the
     generated host + the one file the build generates). Adding any OTHER file still fails. */
     const buildGenerated = ['internalbeyond-host.exe', 'ib-payload-manifest.json'];
    const expected = new Set(manifest.resolve({}).files.map(f => f.to));
    const extra = installedFiles.filter(f => !expected.has(f) && buildGenerated.indexOf(f) < 0);
    assert.strictEqual(extra.length, 0, 'unexpected files installed: ' + extra.slice(0, 10).join(', '));
    for (const rel of buildGenerated) {
      assert.ok(installedFiles.indexOf(rel) >= 0, 'build-generated payload file missing after install: ' + rel);
    }
  });
  check('installed payload manifest declares exactly what was installed', () => {
    /* The upgrade path deletes (previous manifest - this manifest) and nothing
       else, so a manifest that does not describe its OWN release would have the
       next upgrade delete files this release just installed. Check the installed
       copy against the installed bytes, not against the build's declaration. */
    const man = JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, 'ib-payload-manifest.json'), 'utf8'));
    const declared = new Set(man.files.map(f => f.replace(/\\/g, '/')));
    assert.strictEqual(man.count, man.files.length, 'manifest count disagrees with its own list');
    assert.strictEqual(declared.size, man.files.length, 'manifest lists a file twice');
    assert.ok(declared.has('ib-payload-manifest.json'), 'manifest must declare itself, or the next upgrade deletes it');
    const installed = new Set(installedFiles);
    const undeclared = installedFiles.filter(f => !declared.has(f));
    const missing = man.files.filter(f => !installed.has(f.replace(/\\/g, '/')));
    assert.strictEqual(undeclared.length, 0, 'installed but undeclared (next upgrade would leak it): ' + undeclared.slice(0, 10).join(', '));
    assert.strictEqual(missing.length, 0, 'declared but not installed (next upgrade would delete it): ' + missing.slice(0, 10).join(', '));
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
    const sm = TEST_START_SHORTCUT;
    const dk = TEST_DESKTOP_SHORTCUT;
    assert.ok(fs.existsSync(sm), 'start menu shortcut missing: ' + sm);
    assert.ok(fs.existsSync(dk), 'desktop shortcut missing: ' + dk);
    const q = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' +
      'foreach ($p in @(' + JSON.stringify(sm) + ',' + JSON.stringify(dk) + ')) {' +
      '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); Write-Output ($s.TargetPath + "|" + $s.Arguments)}';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { encoding: 'utf8', windowsHide: true });
    const lines = out.trim().split(/\r?\n/).filter(Boolean);
    assert.strictEqual(lines.length, 2, 'expected two shortcuts, got ' + lines.length);
    for (const line of lines) {
      const target = line.split('|')[0].replace(/^"|"$/g, '');
      const args = line.split('|').slice(1).join('|').trim();
      assert.strictEqual(normalizedPath(target), normalizedPath(HOST_EXE), 'shortcut must target the canonical Host: ' + line);
      assert.strictEqual(args, '', 'canonical Host shortcut must not carry arguments: ' + line);
      assert.ok(fs.existsSync(target), 'shortcut target must exist: ' + target);
    }
  });
  check('no development launcher was installed', () => {
    const cmds = installedFiles.filter(f => /\.cmd$/i.test(f));
    assert.strictEqual(cmds.length, 0, 'dev .cmd installed: ' + cmds.join(', '));
  });
  check('uninstall entry registered for the current user', () => {
    const snapshot = readRegistrySnapshot(TEST_UNINSTALL_KEY);
    assert.strictEqual(snapshot.exists, true, 'test uninstall entry must exist after install');
    assert.strictEqual(registryValue(snapshot, 'DisplayVersion'), PRODUCT.version);
    assert.ok(String(registryValue(snapshot, 'DisplayName') || '').indexOf(TEST_APP_NAME) >= 0,
      'uninstall entry must be visibly test-only');
  });
  check('stop helper installed for future upgrades', () => {
    assert.ok(fs.existsSync(path.join(INSTALL_DIR, 'tools', 'ib-stop.js')), 'tools/ib-stop.js missing');
  });
  check('canonical runtime dependencies are installed', () => {
    for (const rel of ['runtime/host-origin.js', 'services/project-knowledge.js']) {
      assert.ok(fs.existsSync(path.join(INSTALL_DIR, rel)), 'installed payload missing canonical runtime dependency: ' + rel);
    }
  });

  /* ── [4] the single real launch (browser suppressed) ── */
  if (REAL) {
    console.log('\n[4] single real launch (canonical Tauri Host → existing launcher, browser suppressed)');
    const hostPid = launchApp();
    const launchHealthy = await waitFor(appHealthy, 90000, 500);
    await acheck('app becomes reachable on its local page service', async () => {
      assert.ok(launchHealthy, 'web server did not become healthy within 90s');
    }, { timeoutMs: SLOW_TIMEOUT_MS });
    if (!launchHealthy) fatal('launch acceptance failed; refusing to continue to upgrade or uninstall');

    await acheck('canonical Host window is visible and responding', async () => {
      let snapshot = null;
      const ready = await waitFor(async () => {
        snapshot = hostWindowState(hostPid);
        return !!(snapshot && Number(snapshot.MainWindowHandle) > 0 && snapshot.Responding !== false &&
          String(snapshot.MainWindowTitle || '').indexOf('InternalBeyond') >= 0);
      }, 30000, 500);
      assert.ok(ready, 'Host window was not visible/responding: ' + JSON.stringify(snapshot));
    }, { timeoutMs: SLOW_TIMEOUT_MS });

    const secondHostPid = launchApp();
    await acheck('second Host launch focuses the existing instance', async () => {
      const exited = await waitFor(async () => !alivePid(secondHostPid), 15000, 250);
      assert.ok(exited, 'second Host process did not exit through single-instance handling');
      assert.strictEqual(alivePid(hostPid), true, 'first Host process must remain alive');
    }, { timeoutMs: CASE_TIMEOUT_MS });

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
    if (!bootComplete) fatal('boot-state acceptance failed; refusing to continue to upgrade or uninstall');
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
    check('installed service-control resolves host-origin inside the installed root', () => {
      const node = path.join(INSTALL_DIR, 'runtime', 'node', 'node.exe');
      const serviceControl = path.join(INSTALL_DIR, 'runtime', 'service-control.js');
      const expected = normalizedPath(path.join(INSTALL_DIR, 'runtime', 'host-origin.js'));
      const script = 'const sc=require(' + JSON.stringify(serviceControl) + ');' +
        'process.stdout.write(require.resolve("./host-origin.js", { paths: [' + JSON.stringify(path.dirname(serviceControl)) + '] }));';
      const resolved = execFileSync(node, ['-e', script], {
        cwd: path.dirname(serviceControl), env: smokeEnv(), encoding: 'utf8', windowsHide: true
      }).trim();
      assert.strictEqual(normalizedPath(resolved), expected,
        'host-origin must resolve from the installed runtime, got ' + resolved);
      assert.ok(normalizedPath(resolved).indexOf(normalizedPath(ROOT) + path.sep) !== 0,
        'installed runtime must not resolve host-origin from the repository checkout');
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
    await acheck('canonical Web Core assets and Project Knowledge endpoint are reachable', async () => {
      for (const asset of ['/assets/css/core.css', '/assets/js/core.js', '/assets/js/host-capability.js', '/assets/images/bg-internal.jpg']) {
        const r = await getJson('http://127.0.0.1:' + WEB_PORT + asset, 5000);
        assert.strictEqual(r.status, 200, 'asset not reachable from installed root: ' + asset);
      }
      const pk = await getJson('http://127.0.0.1:' + WEB_PORT + '/__project-knowledge/status', 5000);
      assert.strictEqual(pk.status, 200, 'Project Knowledge status failed: ' + pk.status);
      assert.ok(pk.json && pk.json.ok === true, 'Project Knowledge status not ready: ' + JSON.stringify(pk.json));
      const pkList = await getJson('http://127.0.0.1:' + WEB_PORT + '/__project-knowledge/list', 5000);
      assert.strictEqual(pkList.status, 200, 'Project Knowledge list failed: ' + pkList.status);
      assert.ok(pkList.json && pkList.json.ok === true && Array.isArray(pkList.json.docs) && pkList.json.docs.length > 0,
        'Project Knowledge list is empty/not ready: ' + JSON.stringify(pkList.json));
      const pkSearch = await getJson('http://127.0.0.1:' + WEB_PORT + '/__project-knowledge/search?q=' + encodeURIComponent('InternalBeyond') + '&limit=3', 5000);
      assert.strictEqual(pkSearch.status, 200, 'Project Knowledge search failed: ' + pkSearch.status);
      assert.ok(pkSearch.json && pkSearch.json.ok === true && Array.isArray(pkSearch.json.results),
        'Project Knowledge search is not ready: ' + JSON.stringify(pkSearch.json));
      const docId = pkList.json.docs[0].docId;
      const pkRead = await getJson('http://127.0.0.1:' + WEB_PORT + '/__project-knowledge/read?docId=' + encodeURIComponent(docId), 5000);
      assert.strictEqual(pkRead.status, 200, 'Project Knowledge read failed: ' + pkRead.status);
      assert.ok(pkRead.json && pkRead.json.ok === true, 'Project Knowledge read is not ready: ' + JSON.stringify(pkRead.json));
      const direct = await getJson('http://127.0.0.1:' + WEB_PORT + '/InternalBeyond.html?middlebrain', 5000);
      assert.strictEqual(direct.status, 200, 'P31 Direct route document failed: ' + direct.status);
    }, { timeoutMs: SLOW_TIMEOUT_MS });
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
    assertProtectedStateUnchanged('after upgrade', protectedBefore);
    assertTestRegistryAfterInstall();
    if (upgrade.code !== 0) fatal('test installer upgrade failed after the protected-state check: ' + (upgrade.stderr || upgrade.error || upgrade.code));
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
  assertProtectedStateUnchanged('after uninstall', protectedBefore);
  const testRegistryAfterUninstall = readRegistrySnapshot(TEST_UNINSTALL_KEY);
  if (testRegistryAfterUninstall.exists) {
    fatal('test-only uninstall key survived the test uninstaller:\n' + JSON.stringify(testRegistryAfterUninstall));
  }
  if (un.code !== 0) fatal('test-only uninstaller failed after the protected-state check: ' + (un.stderr || un.error || un.code));
  await acheck('uninstaller exits 0 and removes program files + shortcuts', async () => {
    assert.strictEqual(un.code, 0, 'uninstaller failed: ' + (un.stderr || un.error));
    const gone = await waitFor(async () => !fs.existsSync(path.join(INSTALL_DIR, 'InternalBeyond.html')), 90000, 500);
    assert.ok(gone, 'program files must be removed');
    assert.strictEqual(fs.existsSync(TEST_START_SHORTCUT), false, 'test start menu shortcut must be removed');
    assert.strictEqual(fs.existsSync(TEST_DESKTOP_SHORTCUT), false, 'test desktop shortcut must be removed');
  });
  check('uninstall keeps user data', () => {
    assert.ok(fs.existsSync(MARKER_PATH), 'uninstall deleted user data');
    assert.strictEqual(fs.readFileSync(MARKER_PATH, 'utf8'), MARKER_TEXT, 'user data content changed');
    assert.ok(fs.existsSync(DATA_DIR), 'user data directory must be preserved');
  });
  check('uninstall entry removed from the registry', () => {
    assert.strictEqual(readRegistrySnapshot(TEST_UNINSTALL_KEY).exists, false, 'test uninstall registry entry must be removed');
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
  if (MARKER_CREATED) {
    try { fs.rmSync(MARKER_PATH, { force: true }); } catch (e) { /* keep going */ }
  }
  /* A fail-closed stop may abort after the test installer has registered its
     exact test identity but before the test uninstaller can run. Remove only
     residue whose AppId, display name, install root and shortcut target prove
     ownership; production/Tauri registry keys are never candidates. */
  if (MODE !== 'skip') {
    try { cleanupOwnedTestRegistry(); } catch (e) { console.log('  ! test registry cleanup probe failed: ' + (e && e.message || e)); }
    try { cleanupOwnedTestShortcuts(); } catch (e) { console.log('  ! test shortcut cleanup probe failed: ' + (e && e.message || e)); }
  }
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
  let removed = true;
  if (fs.existsSync(INSTALL_DIR)) {
    if (looksLikeOurInstall(INSTALL_DIR)) {
      await killIbProcesses(INSTALL_DIR);
      removed = await removeTree(INSTALL_DIR);
      if (!removed) console.log('  ! could not remove the temp install tree: ' + INSTALL_DIR);
    } else {
      removed = false;
      console.log('  ! refusing to remove an install tree without this run marker: ' + INSTALL_DIR);
    }
  }
  for (const dir of DECOYS) await removeTree(dir);
  if (ISOLATED_LOCALAPPDATA_OWNED) {
    const gone = await removeTree(ISOLATED_LOCALAPPDATA);
    if (!gone) console.log('  ! could not remove the isolated data dir: ' + ISOLATED_LOCALAPPDATA);
  }
  for (const root of ISOLATED_EXTRA_ROOTS.splice(0)) {
    const gone = await removeTree(root);
    if (!gone) console.log('  ! could not remove isolated sandbox root: ' + root);
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
