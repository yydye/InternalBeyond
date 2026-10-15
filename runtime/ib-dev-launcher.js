'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const readline = require('readline');
const snapshot = require('./dev-snapshot');
const syntheticSeed = require('./dev-synthetic-seed');
const devServiceContract = require('./dev-service-contract');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_APP_DATA = process.env.LOCALAPPDATA;
const SYNTHETIC_MODE = process.env.IB_DEV_SYNTHETIC === '1' || process.argv.includes('--synthetic');
const DATA_PATHS = resolveAppDataPaths(LOCAL_APP_DATA, SYNTHETIC_MODE);
const APP_DATA = DATA_PATHS.appData;
const SANDBOX = DATA_PATHS.sandbox;
const CREDENTIAL_DATA_DIR = DATA_PATHS.credentialDataDir;
function resolveCargoTargetDir(sandbox, override) {
  if (!override) return path.join(sandbox, 'cargo-target');
  const target = path.resolve(String(override));
  if (path.basename(target).toLowerCase() !== 'cargo-target') throw new Error('dev-cargo-target-path-invalid');
  const targetSandbox = path.dirname(target);
  try { devServiceContract.validateSandboxRoot(targetSandbox, path.basename(path.dirname(targetSandbox)).toLowerCase() === 'dev-synthetic'); }
  catch (_) { throw new Error('dev-cargo-target-must-belong-to-a-private-sandbox'); }
  return target;
}
const CARGO_TARGET_DIR = resolveCargoTargetDir(SANDBOX, process.env.IB_DEV_CARGO_TARGET_DIR);
const HOST_DATA = path.join(SANDBOX, 'host');
const LOG_DIR = path.join(SANDBOX, 'logs');
const STATE_FILE = path.join(SANDBOX, 'launcher-state.json');
const STOP_REQUEST_FILE = path.join(SANDBOX, 'stop-requested.json');
const SEED_FILE = path.join(SANDBOX, 'seed.json');
const SEED_IMPORTED_FILE = path.join(SANDBOX, 'seed-imported.json');
const CONFIG_FILE = path.join(SANDBOX, 'tauri-dev-config.json');
const SOURCE_DB = path.join(APP_DATA, 'home-node', 'home-node.db');
const SOURCE_WEB_PORT = validPort(process.env.IB_PROD_WEB_PORT, 23120);
const DEV_PORTS = devServiceContract.DEV_PORTS;
const DEV_ORIGIN = 'http://127.0.0.1:' + DEV_PORTS.web;
const DEV_INSTANCE_ID = crypto.randomUUID();
const DEV_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const HOST_STOP_MS = 15000;
const SERVICE_STOP_MS = 8000;
const DEFAULT_STARTUP_TIMEOUT_MS = 60000;
const SYNTHETIC_STARTUP_TIMEOUT_MS = 15 * 60 * 1000;

let child = null;
let childSpawnedAt = 0;
let stopRequested = false;
let currentState = null;

function validPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function resolveAppDataPaths(localAppData, syntheticMode) {
  const base = localAppData ? path.join(localAppData, 'InternalBeyond') : path.join(os.homedir(), '.internal-beyond');
  const appData = syntheticMode === true ? path.join(base, 'dev-synthetic') : base;
  const sandbox = path.join(appData, 'dev-sandbox');
  return Object.freeze({
    appData: appData,
    sandbox: sandbox,
    credentialDataDir: path.join(sandbox, 'credential-vault')
  });
}

function startupTimeoutMs(syntheticMode) {
  return syntheticMode === true ? SYNTHETIC_STARTUP_TIMEOUT_MS : DEFAULT_STARTUP_TIMEOUT_MS;
}

function timestamp() { return new Date().toISOString(); }

function safeLogText(value) {
  return String(value == null ? '' : value)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
}

function log(line) {
  const text = '[' + timestamp() + '] ' + safeLogText(line).replace(/[\r\n]+/g, ' ').slice(0, 1600) + '\n';
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(path.join(LOG_DIR, 'launcher.log'), text, 'utf8'); } catch (_) {}
  if (process.stdout.isTTY) process.stdout.write(text);
}

function ensureSandbox() {
  if (process.platform !== 'win32') throw new Error('IB Dev Launcher v1 currently supports Windows only.');
  if (!LOCAL_APP_DATA) throw new Error('LOCALAPPDATA is required for the Windows Dev Sandbox.');
  const expectedParent = path.resolve(APP_DATA).toLowerCase();
  const sandboxAbs = path.resolve(SANDBOX);
  if (path.dirname(sandboxAbs).toLowerCase() !== expectedParent || sandboxAbs.toLowerCase() === expectedParent) {
    throw new Error('Dev Sandbox path validation failed.');
  }
  try {
    const stat = fs.lstatSync(SANDBOX);
    if (stat.isSymbolicLink()) throw new Error('Dev Sandbox path is a reparse point; refusing to use it.');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  for (const dir of [SANDBOX, HOST_DATA, LOG_DIR, path.join(SANDBOX, 'home-node'), path.join(SANDBOX, 'bridge'), path.join(SANDBOX, 'active')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJsonAtomic(file, value) {
  snapshot.writeJsonAtomic(file, value);
}

function syncSpawn(command, args, options) {
  return spawnSync(command, args, Object.assign({ encoding: 'utf8', windowsHide: true, timeout: 10000 }, options || {}));
}

function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function powershell(script, timeout) {
  const result = syncSpawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: timeout || 10000,
    maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

function processInfo(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  const script = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + n + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; $created=([DateTime]$p.CreationDate).ToUniversalTime(); [pscustomobject]@{pid=[int]$p.ProcessId;image=[string]$p.ExecutablePath;command=[string]$p.CommandLine;startedAtMs=[Int64]([DateTimeOffset]$created).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress";
  const raw = powershell(script, 7000);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function nearStartedAt(actual, expected) {
  const a = Number(actual) || 0;
  const e = Number(expected) || 0;
  return a > 0 && e > 0 && Math.abs(a - e) <= 20000;
}

function processMatchesHost(pid, expectedStartedAt) {
  const info = processInfo(pid);
  if (!info || !nearStartedAt(info.startedAtMs, expectedStartedAt)) return false;
  const image = String(info.image || '').toLowerCase().replace(/\//g, '\\');
  const target = path.resolve(CARGO_TARGET_DIR).toLowerCase().replace(/\//g, '\\');
  return image.startsWith(target + '\\') && /internalbeyond-host(?:\.exe)?$/i.test(path.basename(image));
}

function terminateSnapshotHost(record) {
  if (!record || !processMatchesHost(record.hostPid, record.hostStartedAtMs)) return false;
  const pid = Number(record.hostPid);
  const imageRoot = CARGO_TARGET_DIR.replace(/'/g, "''");
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; if(([string]$p.ExecutablePath).IndexOf('" + imageRoot + "',[StringComparison]::OrdinalIgnoreCase) -lt 0){exit 3}; Stop-Process -Id " + pid + " -Force -ErrorAction Stop";
  return powershell(command, 7000) !== null;
}

function terminateSnapshotHelperProcess(pid, expectedStartedAt) {
  const info = processInfo(pid);
  const expectedImage = path.resolve(CARGO_TARGET_DIR, 'debug', 'internalbeyond-host.exe').toLowerCase();
  if (!info || !nearStartedAt(info.startedAtMs, expectedStartedAt)
    || path.resolve(String(info.image || '')).toLowerCase() !== expectedImage) return false;
  const image = expectedImage.replace(/'/g, "''");
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(pid) + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; if(([string]$p.ExecutablePath).ToLowerInvariant() -ne '" + image + "'){exit 3}; Stop-Process -Id " + Number(pid) + " -Force -ErrorAction Stop";
  return powershell(command, 7000) !== null;
}

function processMatchesLauncher(pid, state) {
  const info = processInfo(pid);
  if (!info || !nearStartedAt(info.startedAtMs, state.childStartedAtMs)) return false;
  const command = String(info.command || '').toLowerCase();
  const config = path.resolve(state.configFile || CONFIG_FILE).toLowerCase();
  return command.includes('tauri') && command.includes('dev') && command.includes(config);
}

function processMatchesNodeService(service, record) {
  const info = processInfo(record.pid);
  if (!info || !nearStartedAt(info.startedAtMs, record.startedAtMs)) return false;
  const command = String(info.command || '').toLowerCase().replace(/\//g, '\\');
  const script = serviceScript(service).toLowerCase().replace(/\//g, '\\');
  const root = path.resolve(ROOT).toLowerCase().replace(/\//g, '\\');
  return command.includes(script) && command.includes(root);
}

function serviceScript(kind) {
  const files = {
    runner: path.join(ROOT, 'runtime', 'local-services-runner.js'),
    static: path.join(ROOT, 'services', 'internal-beyond-server.js'),
    homeNode: path.join(ROOT, 'services', 'home-node-service.js'),
    bridge: path.join(ROOT, 'services', 'ib-bridge-service.js'),
    active: path.join(ROOT, 'services', 'active-message-service.js')
  };
  return files[kind] || '';
}

function childAlive(pid) { return !!processInfo(pid); }

function fetchJson(port, pathname, method, headers, body, timeoutMs) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: method || 'GET', headers: headers || {}, timeout: timeoutMs || 2000 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', part => { if (raw.length < 65536) raw += part; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw || '{}'); } catch (_) {}
        resolve({ status: res.statusCode || 0, data });
      });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, data: null }); });
    if (body) req.write(body);
    req.end();
  });
}

async function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function requireProductionSource() {
  const health = await fetchJson(SOURCE_WEB_PORT, '/health', 'GET', {}, null, 2500);
  if (health.status !== 200 || !health.data || health.data.server !== 'InternalBeyond Web') {
    throw new Error('Open the formal InternalBeyond desktop app first; its local Web service is unavailable.');
  }
  if (!fs.existsSync(SOURCE_DB) || !fs.statSync(SOURCE_DB).isFile()) {
    throw new Error('The formal Home Node database was not found. Start the formal app once so its data is available.');
  }
}

function runtimeNode() {
  const bundled = path.join(ROOT, 'runtime', 'node', 'node.exe');
  if (fs.existsSync(bundled)) return bundled;
  const result = syncSpawn('where.exe', ['node.exe'], { timeout: 3000 });
  const resolved = String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
  if (!resolved) throw new Error('Node.js is required. Use the repository runtime or add Node 22.5+ to PATH.');
  return resolved;
}

function checkTauriCli() {
  const result = syncSpawn(process.env.IB_CARGO || 'cargo', ['tauri', '--version'], { cwd: path.join(ROOT, 'src-tauri'), timeout: 15000 });
  if (result.error || result.status !== 0) {
    throw new Error('The Rust Tauri CLI is unavailable. Install the repository development toolchain, then run the launcher again.');
  }
}

function currentHostRecord() {
  const record = readJson(path.join(HOST_DATA, 'tauri-service-supervisor.json'));
  if (!record || typeof record !== 'object') return null;
  const root = String(record.runtimeRoot || record.runtime_root || '');
  if (path.resolve(root).toLowerCase() !== path.resolve(ROOT).toLowerCase()) return null;
  return record;
}

function servicesFrom(record) {
  const status = record && (record.status || record.runtimeStatus) || {};
  return Array.isArray(status.services) ? status.services : [];
}

function serviceField(row, camel, snake) { return row && (row[camel] !== undefined ? row[camel] : row[snake]); }

function hostPid(record) { return Number(record && (record.hostPid || record.host_pid)) || 0; }
function hostStartedAt(record) { return Number(record && (record.hostStartedAtMs || record.host_started_at_ms)) || 0; }
function sessionId(record) { return String(record && (record.hostSessionId || record.host_session_id) || ''); }

function hostIsAlive(record) {
  const pid = hostPid(record);
  return pid > 0 && processMatchesHost(pid, hostStartedAt(record));
}

function saveState(state) {
  currentState = state;
  writeJsonAtomic(STATE_FILE, state);
}

function tauriEnvironment(extra) {
  const env = Object.assign({}, process.env, {
    IB_DEV_MODE: '1',
    IB_DEV_DSH_ENABLED: '0',
    IB_DEV_SYNTHETIC: SYNTHETIC_MODE ? '1' : '0',
    IB_DEV_SANDBOX_ROOT: SANDBOX,
    IB_DEV_INSTANCE_ID: DEV_INSTANCE_ID,
    IB_DEV_SESSION_TOKEN: DEV_SESSION_TOKEN,
    IB_TAURI_HOST_INSTANCE_ID: '',
    CARGO_TARGET_DIR: CARGO_TARGET_DIR,
    IB_BOOT_STATE_DIR: HOST_DATA,
    IB_LOG_DIR: LOG_DIR,
    IB_HOME_NODE_DATA_DIR: path.join(SANDBOX, 'home-node'),
    IB_BRIDGE_DATA_DIR: path.join(SANDBOX, 'bridge'),
    IB_ACTIVE_DATA_DIR: path.join(SANDBOX, 'active'),
    IB_HOME_NODE_HOST: '127.0.0.1',
    IB_BRIDGE_HOST: '127.0.0.1',
    IB_ACTIVE_HOST: '127.0.0.1',
    IB_HOME_NODE_ORIGINS: '',
    IB_HOME_NODE_MOBILE_ORIGINS: '',
    IB_CREDENTIAL_DATA_DIR: CREDENTIAL_DATA_DIR,
    IB_CREDENTIAL_BINDINGS_DIR: CREDENTIAL_DATA_DIR,
    IB_HOME_NODE_PORT: String(DEV_PORTS.homeNode),
    IB_BRIDGE_PORT: String(DEV_PORTS.bridge),
    IB_ACTIVE_PORT: String(DEV_PORTS.active),
    IB_RESTART_PORT: String(DEV_PORTS.restart),
    IB_WEB_PORT: String(DEV_PORTS.web),
    IB_DEV_FAKE_PROVIDER_PORT: String(DEV_PORTS.fakeProvider),
    IB_ECONOMY_CHANNEL_SOURCE_PORT: String(DEV_PORTS.activeChannelSource),
    IB_DSH_CONTROL_PORT: String(DEV_PORTS.dshControl),
    IB_DSH_WEB_PORT: String(DEV_PORTS.dshWeb)
  }, extra && Object.prototype.hasOwnProperty.call(extra, 'IB_DEV_DSH_ENABLED')
    ? { IB_DEV_DSH_ENABLED: extra.IB_DEV_DSH_ENABLED === '1' ? '1' : '0' } : {});
  /* A production deployment can set these; they must never flow into the
     Dev Home Node, which creates its own credential inside the Sandbox. */
  delete env.IB_HOME_NODE_TOKEN;
  delete env.IB_HOME_NODE_TOKEN_FILE;
  delete env.IB_ECONOMY_CHANNEL_TOKEN;
  delete env.IB_ECONOMY_CHANNEL_BASE;
  delete env.IB_DEV_EXPORT_FILE;
  delete env.IB_DEV_SNAPSHOT_ONLY;
  delete env.IB_DEV_SNAPSHOT_METADATA_ONLY;
  delete env.IB_DEV_SNAPSHOT_PORT;
  delete env.IB_DEV_SNAPSHOT_TOKEN;
  delete env.IB_DEV_SNAPSHOT_ENDPOINT;
  delete env.IB_DEV_PRODUCTION_WEBVIEW_DATA_DIR;
  delete env.IB_DEV_SOURCE_ORIGIN;
  delete env.IB_PROD_WEB_PORT;
  if (SYNTHETIC_MODE) {
    env.IB_DEV_WEBVIEW_DEBUG_PORT = '9225';
    env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9225';
  } else {
    delete env.IB_DEV_WEBVIEW_DEBUG_PORT;
  }
  devServiceContract.portsFromEnvironment(env);
  return env;
}

function writeTauriConfig(origin) {
  writeJsonAtomic(CONFIG_FILE, { build: { devUrl: String(origin || DEV_ORIGIN) + '/InternalBeyond.html' } });
}

function spawnTauri(extraEnv, tag) {
  const command = process.env.IB_CARGO || 'cargo';
  const args = ['tauri', 'dev', '--config', CONFIG_FILE];
  const logPath = path.join(LOG_DIR, 'tauri-' + tag + '.log');
  const stdoutFd = fs.openSync(logPath, 'a');
  const stderrFd = fs.openSync(logPath, 'a');
  const childEnv = tauriEnvironment(extraEnv);
  log('Native Dev environment contract: instance=' + (!!childEnv.IB_DEV_INSTANCE_ID)
    + ', session=' + (!!childEnv.IB_DEV_SESSION_TOKEN) + ', mode=' + childEnv.IB_DEV_SYNTHETIC
    + ', ports=' + Object.values(DEV_PORTS).join(','));
  const processChild = spawn(command, args, {
    cwd: path.join(ROOT, 'src-tauri'),
    env: childEnv,
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: false
  });
  try { fs.closeSync(stdoutFd); } catch (_) {}
  try { fs.closeSync(stderrFd); } catch (_) {}
  return trackTauriChild(processChild, tag);
}

function trackTauriChild(processChild, tag) {
  child = processChild;
  childSpawnedAt = Date.now();
  child.on('error', error => { log('Tauri process could not start (' + (error && error.code || 'spawn-failed') + ').'); });
  child.on('exit', (code, signal) => {
    const latest = readJson(STATE_FILE) || currentState || {};
    latest.launcherState = stopRequested || fs.existsSync(STOP_REQUEST_FILE) ? 'stopped' : 'exited';
    latest.exitCode = Number.isInteger(code) ? code : null;
    latest.exitSignal = signal || null;
    latest.updatedAt = timestamp();
    saveState(latest);
    if (!stopRequested && code !== 0) log('Tauri development process exited with an error; see tauri-' + tag + '.log.');
    child = null;
    if (!stopRequested && tag === 'main') {
      stopOwnedServices(currentHostRecord(), false).then(() => stopLauncherStatic(latest)).catch(() => {});
    }
  });
  return child;
}

async function startDevStaticServer() {
  const node = runtimeNode();
  const script = path.join(ROOT, 'services', 'internal-beyond-server.js');
  const logPath = path.join(LOG_DIR, 'static-server.log');
  const stdoutFd = fs.openSync(logPath, 'a');
  const stderrFd = fs.openSync(logPath, 'a');
  const startedAtMs = Date.now();
  const staticChild = spawn(node, [script], {
    cwd: ROOT,
    env: tauriEnvironment({ IB_TAURI_HOST_INSTANCE_ID: '' }),
    stdio: ['ignore', stdoutFd, stderrFd],
    windowsHide: true
  });
  try { fs.closeSync(stdoutFd); } catch (_) {}
  try { fs.closeSync(stderrFd); } catch (_) {}
  const owned = { pid: staticChild.pid || 0, startedAtMs, script };
  const state = readJson(STATE_FILE) || {
    schema: 'internalbeyond.ib-dev-launcher-state', version: 1,
    mode: 'development', launcherState: 'starting', repoRoot: ROOT, sandboxRoot: SANDBOX,
    startedAt: timestamp()
  };
  state.staticPid = owned.pid;
  state.staticStartedAtMs = startedAtMs;
  state.updatedAt = timestamp();
  saveState(state);
  const healthy = await waitFor(async () => {
    const probe = await fetchJson(DEV_PORTS.web, '/health', 'GET', {}, null, 800);
    return probe.status === 200 && probe.data && probe.data.server === 'InternalBeyond Web'
      && Number(probe.data.pid) === Number(owned.pid)
      && probe.data.environment === (SYNTHETIC_MODE ? 'synthetic' : 'dev')
      && probe.data.devInstanceId === DEV_INSTANCE_ID;
  }, 15000, 250);
  if (!healthy) {
    if (processMatchesNodeService('static', owned)) killLauncherStatic(owned);
    state.staticPid = 0;
    state.staticStartedAtMs = 0;
    state.launcherState = 'failed';
    state.updatedAt = timestamp();
    saveState(state);
    throw new Error('The private Dev Web server failed to start. No existing process was stopped.');
  }
  log('Started the private source Web server on port ' + DEV_PORTS.web + '.');
  return owned;
}

async function startDshHost(env) {
  const contractEnv = env || tauriEnvironment({ IB_DEV_DSH_ENABLED: '1' });
  const identity = devServiceContract.identityFromEnvironment(contractEnv);
  if (identity.mode !== 'synthetic') throw new Error('dsh-requires-synthetic-dev-mode');
  const ports = devServiceContract.portsFromEnvironment(contractEnv);
  const script = path.join(ROOT, 'runtime', 'dsh-native-ui-p0.js');
  const logPath = path.join(LOG_DIR, 'dsh-p0-host.log');
  const fd = fs.openSync(logPath, 'a');
  const startedAtMs = Date.now();
  const processChild = spawn(runtimeNode(), [script, 'start'], {
    cwd: ROOT, env: contractEnv, stdio: ['ignore', fd, fd], windowsHide: true
  });
  try { fs.closeSync(fd); } catch (_) {}
  const owned = { pid: Number(processChild.pid) || 0, startedAtMs, script,
    identityHeaders: devServiceContract.identityHeaders(identity), child: processChild };
  if (!owned.pid) throw new Error('dsh-p0-host-spawn-failed');
  const healthy = await waitFor(async () => {
    if (processChild.exitCode !== null || processChild.signalCode !== null) return false;
    const probe = await fetchJson(ports.dshControl, '/status', 'GET', owned.identityHeaders, null, 1000);
    return probe.status === 200 && probe.data && probe.data.service === 'InternalBeyond DSH P0'
      && Number(probe.data.pid) === owned.pid && probe.data.environment === identity.mode
      && probe.data.devInstanceId === identity.instanceId && probe.data.phase === 'ready'
      && probe.data.revision === 'd743267388641bc76f17c45ce8b4c231aed1d32c';
  }, 30000, 250);
  if (!healthy) {
    await stopDshHost(owned);
    throw new Error('dsh-p0-host-failed-identity-or-readiness-check');
  }
  log('Started the Synthetic DSH Host with the current Dev instance identity.');
  return owned;
}

async function stopDshHost(owned) {
  if (!owned || !(Number(owned.pid) > 0)) return false;
  const identity = devServiceContract.identityFromEnvironment(tauriEnvironment({ IB_DEV_DSH_ENABLED: '1' }));
  const ports = devServiceContract.portsFromEnvironment(tauriEnvironment({ IB_DEV_DSH_ENABLED: '1' }));
  const headers = owned.identityHeaders || devServiceContract.identityHeaders(identity);
  const probe = await fetchJson(ports.dshControl, '/status', 'GET', headers, null, 1500);
  if (probe.status === 200 && probe.data && probe.data.service === 'InternalBeyond DSH P0'
    && Number(probe.data.pid) === Number(owned.pid) && probe.data.devInstanceId === identity.instanceId) {
    await fetchJson(ports.dshControl, '/shutdown', 'POST', headers, '', 1500);
    if (await waitFor(() => !childAlive(owned.pid), 8000, 200)) return true;
  }
  const info = processInfo(owned.pid);
  const expectedScript = path.resolve(owned.script || path.join(ROOT, 'runtime', 'dsh-native-ui-p0.js')).toLowerCase().replace(/\\/g, '/');
  if (!info || !nearStartedAt(info.startedAtMs, owned.startedAtMs)
    || String(info.command || '').toLowerCase().replace(/\\/g, '/').indexOf(expectedScript) < 0) return false;
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(owned.pid)
    + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; if(([string]$p.CommandLine).IndexOf('"
    + String(owned.script).replace(/'/g, "''") + "',[StringComparison]::OrdinalIgnoreCase) -lt 0){exit 3}; & taskkill.exe /PID "
    + Number(owned.pid) + " /T /F | Out-Null; if($LASTEXITCODE -ne 0){exit 4}";
  if (powershell(command, 7000) !== null) await waitFor(() => !childAlive(owned.pid), 3000, 200);
  return !childAlive(owned.pid);
}

function stageManualSnapshot(manualExport) {
  if (fs.existsSync(SEED_FILE)) throw new Error('dev-seed-already-exists');
  const serialized = JSON.stringify(manualExport && manualExport.snapshot);
  const bytes = Buffer.from(serialized, 'utf8');
  try {
    if (!bytes.length || bytes.length > snapshot.MAX_MANUAL_EXPORT_BYTES) throw new Error('manual-export-snapshot-size-invalid');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    writeJsonAtomic(SEED_FILE, manualExport.snapshot);
    const written = fs.readFileSync(SEED_FILE);
    try {
      const writtenSha256 = crypto.createHash('sha256').update(written).digest('hex');
      if (writtenSha256 !== sha256) throw new Error('manual-export-snapshot-integrity-failed');
    } finally { written.fill(0); }
    const storeCounts = {};
    for (const [name, rows] of Object.entries(manualExport.snapshot.stores || {})) storeCounts[name] = rows.length;
    return Object.freeze({
      bytes: bytes.length,
      sha256,
      storeCounts,
      sourceExport: manualExport.sourceExport
    });
  } catch (error) {
    try { fs.rmSync(SEED_FILE, { force: true }); } catch (_) {}
    throw error;
  } finally { bytes.fill(0); }
}

function stageManualExportFile(exportPath) {
  return stageManualSnapshot(snapshot.readManualExportFile(exportPath));
}

function manualSeedRequired() {
  return !fs.existsSync(SEED_IMPORTED_FILE) && !fs.existsSync(SEED_FILE);
}

async function promptManualExportPath(providedPath) {
  let selected = String(providedPath || process.env.IB_DEV_EXPORT_FILE || '').trim();
  if (selected) return path.resolve(selected.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted || singleQuoted));
  if (!process.stdin.isTTY) {
    throw new Error('manual-export-required: export 普通 JSON from the running formal app, then pass its path to `ib-dev-launcher.cmd start <file.json>`.');
  }
  console.log('在已运行的正式版中打开「本地数据保险库」并点击「普通 JSON」导出。请勿选择加密 .ibvault 文件。');
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    selected = String(await new Promise(resolve => input.question('输入刚导出的 .json 文件完整路径: ', resolve)) || '').trim();
  } finally { input.close(); }
  if (!selected) throw new Error('manual-export-required');
  selected = selected.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted || singleQuoted);
  return path.resolve(selected);
}

async function snapshotProductionOnce(exportPath) {
  if (fs.existsSync(SEED_FILE)) return;
  const manualExport = snapshot.readManualExportFile(exportPath);
  const dbTarget = path.join(SANDBOX, 'home-node', 'home-node.db');
  const homeNodeCapturedAt = timestamp();
  const dbResult = await snapshot.backupHomeNodeDatabase(SOURCE_DB, dbTarget);
  log('Created a consistent Home Node SQLite online backup in the Dev Sandbox (' + dbResult.bytes + ' bytes).');
  let staged = false;
  try {
    const imported = stageManualSnapshot(manualExport);
    staged = true;
    writeJsonAtomic(path.join(SANDBOX, 'snapshot-manifest.json'), {
      schema: 'internalbeyond.dev-snapshot-manifest',
      version: 1,
      homeNode: {
        capturedAt: homeNodeCapturedAt,
        method: dbResult.method,
        bytes: dbResult.bytes,
        snapshotFile: path.relative(SANDBOX, dbResult.file).split(path.sep).join('/')
      },
      indexedDb: {
        capturedAt: imported.sourceExport.exportDate,
        source: 'user-authorized-plain-json-export',
        sourceExportVersion: imported.sourceExport.version,
        databaseVersion: null,
        storeCounts: imported.storeCounts,
        sha256: imported.sha256
      },
      credentials: { copied: false, resolver: 'request-scoped-read-only-vault' }
    });
    log('Imported the user-selected redacted JSON export into the Dev Sandbox (' + imported.storeCounts.apiConfigs + ' role configurations, ' + imported.storeCounts.chatMessages + ' chat messages, ' + imported.storeCounts.memories + ' Memory rows).');
  } catch (error) {
    if (staged) {
      try { fs.rmSync(SEED_FILE, { force: true }); } catch (_) {}
    }
    throw error;
  }
}

function waitForChildExit(processChild, timeoutMs) {
  if (!processChild || processChild.exitCode !== null || processChild.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); processChild.removeListener('exit', onExit); resolve(result); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    processChild.once('exit', onExit);
  });
}

async function waitFor(predicate, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs || 250));
  }
  return !!(await predicate());
}

async function initializeDevHostLifecycle(dependencies) {
  const deps = dependencies || {};
  const handles = { staticServer: null, dshHost: null, state: null, devChild: null };
  const cleanup = async reason => {
    if (typeof deps.cleanupOwned !== 'function') return;
    await deps.cleanupOwned(handles, reason);
  };
  try {
    handles.staticServer = await deps.startStaticServer();
    if (!handles.staticServer || !(Number(handles.staticServer.pid) > 0)) throw new Error('static-server-handle-invalid');
    if (typeof deps.startDshHost === 'function') handles.dshHost = await deps.startDshHost();
    handles.state = deps.createState(handles.staticServer, handles.dshHost);
    if (!handles.state || typeof handles.state !== 'object') throw new Error('launcher-state-unavailable');
    await deps.saveState(handles.state);
    handles.devChild = await deps.spawnTauri(handles.state);
    if (!handles.devChild || !(Number(handles.devChild.pid) > 0)) throw new Error('tauri-dev-spawn-failed');
    handles.state.childPid = Number(handles.devChild.pid);
    handles.state.childStartedAtMs = Number(deps.childStartedAtMs()) || Date.now();
    await deps.saveState(handles.state);
    const ready = await deps.waitForReady(handles.state, handles.devChild);
    if (!ready) throw new Error('dev-host-startup-readiness-failed');
    return Object.freeze({
      staticServer: handles.staticServer,
      state: handles.state,
      devChild: handles.devChild,
      stop: () => cleanup('normal-exit')
    });
  } catch (error) {
    try { await cleanup('startup-failure'); }
    catch (cleanupError) {
      if (error && typeof error === 'object') error.cleanupError = String(cleanupError && cleanupError.message || cleanupError);
    }
    throw error;
  }
}

async function cleanupDevHostLifecycle(handles, reason) {
  if (!handles || (!handles.staticServer && !handles.dshHost && !handles.state && !handles.devChild)) return;
  if (reason === 'startup-failure') log('Startup failed; cleaning only processes recorded by this Launcher instance.');
  try { await stop(); }
  catch (error) { log('Owned-process cleanup reported an error (' + String(error && error.message || 'cleanup-failed') + ').'); }

  if (handles.dshHost) {
    try { await stopDshHost(handles.dshHost); }
    catch (error) { log('DSH Host cleanup reported an error (' + String(error && error.message || 'cleanup-failed') + ').'); }
  }

  if (handles.devChild && handles.state
    && processMatchesLauncher(handles.devChild.pid, handles.state)) {
    terminateLauncherChild(handles.devChild.pid, handles.state);
    await waitForChildExit(handles.devChild, HOST_STOP_MS);
  }
  if (handles.staticServer && processMatchesNodeService('static', handles.staticServer)) {
    await stopLauncherStatic({
      staticPid: handles.staticServer.pid,
      staticStartedAtMs: handles.staticServer.startedAtMs
    });
  }

  const latest = readJson(STATE_FILE) || handles.state || {};
  latest.launcherState = reason === 'startup-failure' ? 'failed' : 'stopped';
  latest.updatedAt = timestamp();
  saveState(latest);
}

async function start(options) {
  options = options || {};
  const dshEnabled = options.dshEnabled === true;
  if (options.synthetic === true && !SYNTHETIC_MODE) {
    throw new Error('synthetic-mode-must-be-selected-before-launch');
  }
  if (options.dshEnabled === true && !SYNTHETIC_MODE) throw new Error('dsh-requires-synthetic-dev-mode');
  ensureSandbox();
  const existing = currentHostRecord();
  if (existing && hostIsAlive(existing)) {
    log('IB Dev Launcher is already running (host PID ' + hostPid(existing) + ').');
    return runConsole();
  }
  const previousSnapshotHost = readJson(path.join(HOST_DATA, 'dev-snapshot-host.json'));
  if (previousSnapshotHost && processMatchesHost(previousSnapshotHost.hostPid, previousSnapshotHost.hostStartedAtMs)) {
    throw new Error('A Dev data snapshot is already in progress. Use the stop command before starting another one.');
  }
  if (existing) await stopOwnedServices(existing, false);
  const oldState = readJson(STATE_FILE);
  if (oldState && oldState.mode === 'snapshot' && processMatchesHost(oldState.childPid, oldState.childStartedAtMs)) {
    throw new Error('A Dev data snapshot is already running. Use the stop command before starting another one.');
  }
  if (oldState && Number(oldState.childPid) > 0 && processMatchesLauncher(oldState.childPid, oldState)) {
    await terminateLauncherChild(oldState.childPid, oldState);
  }
  if (oldState) await stopLauncherStatic(oldState);
  try { fs.rmSync(STOP_REQUEST_FILE, { force: true }); } catch (_) {}

  const occupied = [];
  for (const port of Object.values(DEV_PORTS)) if (!(await isPortFree(port))) occupied.push(port);
  if (occupied.length) throw new Error('A private Dev port is already in use (' + occupied.join(', ') + '). No process was stopped.');
  if (!SYNTHETIC_MODE) await requireProductionSource();
  checkTauriCli();

  let fakeProvider = null;
  try {
    const serviceEnv = tauriEnvironment({ IB_DEV_DSH_ENABLED: dshEnabled ? '1' : '0' });
    const devIdentity = devServiceContract.identityFromEnvironment(serviceEnv);
    if (SYNTHETIC_MODE) {
      fakeProvider = await syntheticSeed.createSyntheticFakeProvider({
        port: DEV_PORTS.fakeProvider, identity: devIdentity, environment: serviceEnv
      });
      const seeded = syntheticSeed.seedSyntheticSandbox({
        sandboxRoot: SANDBOX,
        credentialDataDir: CREDENTIAL_DATA_DIR,
        providerEndpoint: fakeProvider.endpoint
      });
      log('Prepared isolated Synthetic Seed (' + seeded.profileRefs.length + ' fake Provider routes, one virtual Workspace file).');
    } else if (manualSeedRequired()) {
      const exportPath = await promptManualExportPath(options.manualExportPath);
      await snapshotProductionOnce(exportPath);
    }
    writeTauriConfig(DEV_ORIGIN);
    const lifecycle = await initializeDevHostLifecycle({
      startStaticServer: startDevStaticServer,
      startDshHost: dshEnabled ? () => startDshHost(serviceEnv) : undefined,
      createState: (staticServer, dshHost) => ({
        schema: 'internalbeyond.ib-dev-launcher-state', version: 1,
        mode: SYNTHETIC_MODE ? 'synthetic' : 'development', launcherState: 'starting',
        syntheticSeed: SYNTHETIC_MODE,
        dshEnabled: dshEnabled,
        repoRoot: ROOT, sandboxRoot: SANDBOX,
        childPid: 0, childStartedAtMs: Date.now(), configFile: CONFIG_FILE,
        staticPid: staticServer.pid, staticStartedAtMs: staticServer.startedAtMs,
        dshP0Pid: dshHost ? dshHost.pid : 0, dshP0StartedAtMs: dshHost ? dshHost.startedAtMs : 0,
        ports: Object.assign({}, DEV_PORTS, SYNTHETIC_MODE ? { fakeProvider: syntheticSeed.SYNTHETIC_PROVIDER_PORT } : {}),
        webviewDebugPort: SYNTHETIC_MODE ? 9225 : null,
        startedAt: timestamp(), updatedAt: timestamp()
      }),
      saveState,
      spawnTauri: () => {
        log('Starting Tauri Dev with isolated WebView and service data directories; DSH execution is ' + (dshEnabled ? 'enabled by explicit Dev opt-in.' : 'disabled.'));
        return spawnTauri(serviceEnv, 'main');
      },
      childStartedAtMs: () => childSpawnedAt,
      waitForReady: async (_state, devChild) => {
        const ready = await waitFor(async () => {
          if (devChild.exitCode !== null || devChild.signalCode !== null) return { exited: true };
          const record = currentHostRecord();
          return record && hostIsAlive(record) && (record.status || {}).staticReady === true
            ? { record }
            : false;
        }, startupTimeoutMs(SYNTHETIC_MODE), 350);
        if (!ready && (devChild.exitCode !== null || devChild.signalCode !== null)) throw new Error('tauri-dev-exited-before-readiness');
        if (!ready) throw new Error('dev-host-startup-timeout');
        const record = currentHostRecord();
        if (!record || !hostIsAlive(record) || (record.status || {}).staticReady !== true) {
          throw new Error('dev-host-exited-before-readiness');
        }
        log('Dev host started (PID ' + hostPid(record) + '). Sandbox writes are isolated.');
        return true;
      },
      cleanupOwned: cleanupDevHostLifecycle
    });
    return await runConsole(lifecycle.stop);
  } finally {
    if (fakeProvider) await fakeProvider.close();
  }
}

function statusText() {
  ensureSandbox();
  const state = readJson(STATE_FILE) || {};
  const host = currentHostRecord();
  const running = host && hostIsAlive(host);
  const status = running ? (host.status || {}) : {};
  const lines = [
    'IB Dev Launcher v1: ' + (running ? 'RUNNING' : (state.launcherState || 'STOPPED')),
    'Sandbox: ' + SANDBOX,
    'Home Node: ' + (status && status.homeNodeReady ? 'ready on ' + DEV_PORTS.homeNode : 'not ready'),
    'Bridge: ' + (status && status.bridgeReady ? 'ready on ' + DEV_PORTS.bridge : 'not ready'),
    'Active scheduler: disabled in Dev mode',
    'Web: ' + (status && status.staticReady ? 'ready on ' + DEV_PORTS.web : 'not ready'),
    'Host PID: ' + (running ? hostPid(host) : 'none'),
    'Log directory: ' + LOG_DIR
  ];
  if (SYNTHETIC_MODE) {
    lines.splice(1, 0, 'Mode: isolated Synthetic Seed',
      'Fake Provider: 127.0.0.1:' + syntheticSeed.SYNTHETIC_PROVIDER_PORT,
      'WebView debug port: 9225');
  }
  return lines.join('\n');
}

async function printStatus() { console.log(statusText()); }

async function showLogs() {
  ensureSandbox();
  const files = ['launcher.log', 'tauri-main.log', 'tauri-snapshot.log', 'homenode.log', 'bridge.log', 'active.log', 'restart.log', 'static-server.log'];
  for (const file of files) {
    const full = path.join(LOG_DIR, file);
    if (!fs.existsSync(full)) continue;
    console.log('\n--- ' + file + ' ---');
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    console.log(lines.slice(-120).join('\n'));
  }
}

async function requestServiceStop(kind, row, session) {
  if (!row || serviceField(row, 'spawnedByHost', 'spawned_by_host') !== true
    || String(serviceField(row, 'hostSessionId', 'host_session_id') || '') !== session) return false;
  const pid = Number(row.pid) || 0;
  const port = Number(row.port) || 0;
  const kindToPath = { runner: '/shutdown', static: '/__tauri/shutdown', homeNode: '/__shutdown', bridge: '/__shutdown', active: '/__shutdown' };
  const kindToIdentity = {
    runner: value => value && value.service === 'InternalBeyond Restart' && Number(value.pid) === pid,
    static: value => value && value.server === 'InternalBeyond Web' && Number(value.pid) === pid,
    homeNode: value => value && value.service === 'internal-beyond-home-node',
    bridge: value => value && value.server === 'IB Bridge',
    active: value => value && value.service === 'internal-beyond-active-messages'
  };
  if (!pid || !port || !kindToPath[kind] || !processMatchesNodeService(kind, row)) return false;
  const identityPath = kind === 'runner' ? '/status' : '/health';
  const probe = await fetchJson(port, identityPath, 'GET', {}, null, 1500);
  if (probe.status !== 200 || !kindToIdentity[kind](probe.data)) return false;
  if (!probe.data || probe.data.environment !== (SYNTHETIC_MODE ? 'synthetic' : 'dev')
    || probe.data.devInstanceId !== DEV_INSTANCE_ID) return false;
  const headers = { 'X-IB-Tauri-Host-Session': session };
  Object.assign(headers, devServiceContract.identityHeaders(devServiceContract.identityFromEnvironment(tauriEnvironment())));
  const result = await fetchJson(port, kindToPath[kind], 'POST', headers, '', 2000);
  return result.status === 202 && result.data && result.data.ok === true;
}

async function waitForPidGone(pid, timeoutMs) {
  return waitFor(() => !childAlive(pid), timeoutMs, 200);
}

function killVerifiedService(kind, row, session) {
  if (!row || serviceField(row, 'spawnedByHost', 'spawned_by_host') !== true
    || String(serviceField(row, 'hostSessionId', 'host_session_id') || '') !== session
    || !processMatchesNodeService(kind, row)) return false;
  const pid = Number(row.pid) || 0;
  if (!pid) return false;
  const info = processInfo(pid);
  if (!info || !nearStartedAt(info.startedAtMs, Number(row.startedAtMs || row.started_at_ms))) return false;
  const script = serviceScript(kind);
  const expected = script.replace(/'/g, "''");
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; if(([string]$p.CommandLine).IndexOf('" + expected + "',[StringComparison]::OrdinalIgnoreCase) -lt 0){exit 3}; Stop-Process -Id " + pid + " -Force -ErrorAction Stop";
  return powershell(command, 7000) !== null;
}

function killLauncherStatic(record) {
  if (!record || !processMatchesNodeService('static', record)) return false;
  const pid = Number(record.pid) || 0;
  const info = processInfo(pid);
  if (!info || !nearStartedAt(info.startedAtMs, Number(record.startedAtMs))) return false;
  const script = serviceScript('static').replace(/'/g, "''");
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; if(([string]$p.CommandLine).IndexOf('" + script + "',[StringComparison]::OrdinalIgnoreCase) -lt 0){exit 3}; Stop-Process -Id " + pid + " -Force -ErrorAction Stop";
  return powershell(command, 7000) !== null;
}

async function stopLauncherStatic(state) {
  const record = state && Number(state.staticPid) > 0
    ? { pid: Number(state.staticPid), startedAtMs: Number(state.staticStartedAtMs), script: serviceScript('static') }
    : null;
  if (!record || !processMatchesNodeService('static', record)) return false;
  const devHeaders = devServiceContract.identityHeaders(devServiceContract.identityFromEnvironment(tauriEnvironment()));
  const health = await fetchJson(DEV_PORTS.web, '/health', 'GET', {}, null, 1500);
  if (health.status === 200 && health.data && health.data.server === 'InternalBeyond Web'
    && Number(health.data.pid) === record.pid && health.data.devInstanceId === DEV_INSTANCE_ID
    && health.data.environment === (SYNTHETIC_MODE ? 'synthetic' : 'dev')) {
    const response = await fetchJson(DEV_PORTS.web, '/__shutdown', 'POST', devHeaders, '', 2000);
    if (response.status === 202 && response.data && response.data.ok === true
      && await waitForPidGone(record.pid, SERVICE_STOP_MS)) return true;
  }
  if (killLauncherStatic(record)) {
    await waitForPidGone(record.pid, 2500);
    return true;
  }
  return false;
}

async function stopOwnedServices(record, killHostAfter) {
  if (!record) return;
  const session = sessionId(record);
  if (!session) return;
  const rows = servicesFrom(record).filter(row => serviceField(row, 'spawnedByHost', 'spawned_by_host') === true
    && String(serviceField(row, 'hostSessionId', 'host_session_id') || '') === session);
  const order = ['runner', 'homeNode', 'bridge', 'active', 'static'];
  for (const kind of order) {
    const row = rows.find(item => String(serviceField(item, 'serviceKind', 'service_kind') || '') === kind);
    if (!row) continue;
    const accepted = await requestServiceStop(kind, row, session);
    const pid = Number(row.pid) || 0;
    if (accepted && await waitForPidGone(pid, SERVICE_STOP_MS)) continue;
    if (processMatchesNodeService(kind, row)) {
      killVerifiedService(kind, row, session);
      await waitForPidGone(pid, 2500);
    }
  }
  if (killHostAfter) {
    const pid = hostPid(record);
    const started = hostStartedAt(record);
    if (pid && processMatchesHost(pid, started)) {
      const image = CARGO_TARGET_DIR;
      const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; if(([string]$p.ExecutablePath).IndexOf('" + image.replace(/'/g, "''") + "',[StringComparison]::OrdinalIgnoreCase) -lt 0){exit 3}; Stop-Process -Id " + pid + " -Force -ErrorAction Stop";
      powershell(command, 7000);
    }
  }
}

async function closeHostNormally(record) {
  const pid = hostPid(record);
  if (!pid || !hostIsAlive(record)) return false;
  const info = processInfo(pid);
  if (!info || !nearStartedAt(info.startedAtMs, hostStartedAt(record))) return false;
  const title = String(info.command || '').toLowerCase();
  if (!title.includes('internalbeyond-host')) return false;
  const command = "$p=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; if(-not $p.CloseMainWindow()){exit 3}; Start-Sleep -Milliseconds 100";
  return powershell(command, 5000) !== null;
}

async function terminateLauncherChild(pid, state) {
  if (!processMatchesLauncher(pid, state)) return false;
  const command = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " + Number(pid) + "' -ErrorAction SilentlyContinue; if($null -eq $p){exit 2}; if(([string]$p.CommandLine).IndexOf('" + path.resolve(state.configFile || CONFIG_FILE).replace(/'/g, "''") + "',[StringComparison]::OrdinalIgnoreCase) -lt 0){exit 3}; Stop-Process -Id " + Number(pid) + " -Force -ErrorAction Stop";
  return powershell(command, 7000) !== null;
}

async function stop() {
  ensureSandbox();
  stopRequested = true;
  try { writeJsonAtomic(STOP_REQUEST_FILE, { requestedAt: timestamp() }); } catch (_) {}
  const snapshotHostFile = path.join(HOST_DATA, 'dev-snapshot-host.json');
  const snapshotHost = readJson(snapshotHostFile);
  if (snapshotHost && processMatchesHost(snapshotHost.hostPid, snapshotHost.hostStartedAtMs)) {
    log('Stopping the launcher-owned, read-only snapshot helper.');
    terminateSnapshotHost(snapshotHost);
    await waitForPidGone(Number(snapshotHost.hostPid), 5000);
  }
  const record = currentHostRecord();
  if (record && hostIsAlive(record)) {
    log('Requesting a normal close from the Dev Tauri window (PID ' + hostPid(record) + ').');
    await closeHostNormally(record);
    const graceful = await waitFor(() => !hostIsAlive(record), HOST_STOP_MS, 250);
    if (!graceful) {
      log('Graceful close timed out; stopping only the processes recorded as owned by this Dev host.');
      await stopOwnedServices(record, true);
    }
  } else if (record) {
    await stopOwnedServices(record, false);
  }
  const state = readJson(STATE_FILE);
  if (state && Number(state.childPid) > 0 && processMatchesLauncher(state.childPid, state)) {
    await terminateLauncherChild(state.childPid, state);
  } else if (state && state.mode === 'snapshot' && processMatchesHost(state.childPid, state.childStartedAtMs)) {
    terminateSnapshotHelperProcess(state.childPid, state.childStartedAtMs);
    await waitForPidGone(Number(state.childPid), 5000);
  }
  if (state && Number(state.dshP0Pid) > 0) {
    await stopDshHost({ pid: Number(state.dshP0Pid), startedAtMs: Number(state.dshP0StartedAtMs),
      script: path.join(ROOT, 'runtime', 'dsh-native-ui-p0.js') });
  }
  if (state) await stopLauncherStatic(state);
  const latest = readJson(STATE_FILE) || {};
  latest.launcherState = 'stopped';
  latest.updatedAt = timestamp();
  saveState(latest);
  log('Dev stop completed. The Sandbox data remains available for the next launch.');
}

function sandboxIsLive() {
  const host = currentHostRecord();
  if (host && hostIsAlive(host)) return true;
  const snapshotHost = readJson(path.join(HOST_DATA, 'dev-snapshot-host.json'));
  if (snapshotHost && processMatchesHost(snapshotHost.hostPid, snapshotHost.hostStartedAtMs)) return true;
  const state = readJson(STATE_FILE);
  if (state && Number(state.childPid) > 0 && processMatchesLauncher(state.childPid, state)) return true;
  if (state && state.mode === 'snapshot' && processMatchesHost(state.childPid, state.childStartedAtMs)) return true;
  if (state && Number(state.staticPid) > 0 && processMatchesNodeService('static', {
    pid: Number(state.staticPid), startedAtMs: Number(state.staticStartedAtMs), script: serviceScript('static')
  })) return true;
  if (state && Number(state.dshP0Pid) > 0) {
    const info = processInfo(Number(state.dshP0Pid));
    const script = path.resolve(ROOT, 'runtime', 'dsh-native-ui-p0.js').toLowerCase().replace(/\\/g, '/');
    if (info && nearStartedAt(info.startedAtMs, state.dshP0StartedAtMs)
      && String(info.command || '').toLowerCase().replace(/\\/g, '/').indexOf(script) >= 0) return true;
  }
  return false;
}

async function reset() {
  ensureSandbox();
  if (sandboxIsLive()) throw new Error('Stop the Dev Launcher before resetting its Sandbox.');
  const target = path.resolve(SANDBOX);
  const parent = path.resolve(APP_DATA);
  if (path.dirname(target).toLowerCase() !== parent.toLowerCase() || target.toLowerCase() === parent.toLowerCase()) {
    throw new Error('Reset path validation failed; no files were removed.');
  }
  try {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) throw new Error('Reset target is a reparse point; no files were removed.');
  } catch (error) { if (error && error.code === 'ENOENT') { console.log('Dev Sandbox is already empty.'); return; } throw error; }
  fs.rmSync(target, { recursive: true, force: false });
  console.log('Dev Sandbox reset. The next start requires a new plain JSON export from the formal app.');
}

function printStatus() { console.log(statusText()); }

function statusText() {
  const state = readJson(STATE_FILE) || {};
  const host = currentHostRecord();
  const running = !!host && hostIsAlive(host);
  const status = running ? (host.status || {}) : {};
  return [
    'IB Dev Launcher v1: ' + (running ? 'RUNNING' : (state.launcherState || 'STOPPED')),
    'Sandbox: ' + SANDBOX,
    'Tauri host: ' + (running ? 'PID ' + hostPid(host) : 'not running'),
    'Static Web: ' + (status.staticReady === true ? 'ready (' + DEV_PORTS.web + ')' : 'not ready'),
    'Home Node: ' + (status.homeNodeReady === true ? 'ready (' + DEV_PORTS.homeNode + ')' : 'not ready'),
    'DSH execution: ' + (state.dshEnabled === true ? 'enabled (Dev opt-in)' : 'disabled'),
    'Bridge: ' + (status.bridgeReady === true ? 'ready (' + DEV_PORTS.bridge + ')' : 'not ready'),
    'Active scheduler: disabled in Dev mode',
    'Logs: ' + LOG_DIR
  ].join('\n');
}

async function showLogs() {
  ensureSandbox();
  const files = ['launcher.log', 'tauri-main.log', 'tauri-snapshot.log', 'home-node.log', 'bridge.log', 'active.log', 'static.log'];
  for (const file of files) {
    const full = path.join(LOG_DIR, file);
    if (!fs.existsSync(full)) continue;
    console.log('\n--- ' + file + ' ---');
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    console.log(lines.slice(-120).join('\n'));
  }
}

async function runConsole(stopDevHost) {
  if (!child) return;
  const stopOwnedHost = typeof stopDevHost === 'function' ? stopDevHost : stop;
  if (!process.stdin.isTTY) return waitForChildExit(child, Number(process.env.IB_DEV_INTERACTIVE_WAIT_MS) || 0);
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  console.log('Commands: s=status, l=logs, q=normal stop and quit');
  for await (const line of input) {
    const command = String(line || '').trim().toLowerCase();
    if (command === 's') printStatus();
    else if (command === 'l') await showLogs();
    else if (command === 'q') { input.close(); await stopOwnedHost(); return; }
    else if (command) console.log('Use s, l, or q.');
    if (!child) { input.close(); return; }
  }
  if (child) await stopOwnedHost();
}

function printUsage() {
  console.log('Usage: ib-dev-launcher [start [plain-export.json] [--dsh] [--synthetic]|status|logs|stop|reset]');
}

function parseStartOptions(args) {
  const values = Array.isArray(args) ? args.map(value => String(value)) : [];
  return {
    dshEnabled: values.includes('--dsh'),
    synthetic: values.includes('--synthetic'),
    manualExportPath: values.find(value => value !== '--dsh' && value !== '--synthetic' && !value.startsWith('--')) || undefined
  };
}

async function main() {
  const arg = String(process.argv[2] || 'start').toLowerCase();
  if (arg === 'status' || arg === '--status') { ensureSandbox(); printStatus(); return; }
  if (arg === 'logs' || arg === '--logs') { await showLogs(); return; }
  if (arg === 'stop' || arg === '--stop') { await stop(); return; }
  if (arg === 'reset' || arg === '--reset') { await reset(); return; }
  if (arg === 'start' || arg === '--start') { await start(parseStartOptions(process.argv.slice(3))); return; }
  printUsage();
  process.exitCode = 2;
}

if (require.main === module) {
  main().catch(error => {
    log('Launcher error: ' + (error && error.message || 'unknown-error'));
    console.error('IB Dev Launcher: ' + (error && error.message || 'unknown error'));
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  ROOT, APP_DATA, SANDBOX, DEV_PORTS, SYNTHETIC_MODE, resolveAppDataPaths, startupTimeoutMs, ensureSandbox, statusText, reset,
  stageManualExportFile, manualSeedRequired, initializeDevHostLifecycle, tauriEnvironment, parseStartOptions, currentHostRecord, hostIsAlive,
  requestServiceStop, processMatchesHost, processMatchesLauncher
});
