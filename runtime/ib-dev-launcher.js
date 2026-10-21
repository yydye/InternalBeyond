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
const DEFAULT_DEV_DATA_ROOT = path.resolve(process.env.IB_DEV_DATA_ROOT || 'D:\\IB-Dev');
const DEFAULT_SHARED_CARGO_TARGET_DIR = path.resolve('D:\\IB-Dev\\cargo-target');
const SYNTHETIC_MODE = process.env.IB_DEV_SYNTHETIC === '1' || process.argv.includes('--synthetic');
const TEST_PROJECT_ROOT_OVERRIDE = process.env.IB_DEV_LAUNCHER_TEST_PROJECT_ROOT;
const DEV_DATA_PROJECT_ROOT = resolveDevDataProjectRoot(DEFAULT_DEV_DATA_ROOT, TEST_PROJECT_ROOT_OVERRIDE);
const DEV_ENV_ROOT = TEST_PROJECT_ROOT_OVERRIDE ? DEV_DATA_PROJECT_ROOT : DEFAULT_DEV_DATA_ROOT;
const DEV_CARGO_HOME = path.join(DEV_ENV_ROOT, 'cargo-home');
const DEV_RUSTUP_HOME = path.join(DEV_ENV_ROOT, 'rustup');
const DEV_RUSTUP_TOOLCHAIN = process.env.IB_DEV_RUSTUP_TOOLCHAIN || 'stable-x86_64-pc-windows-msvc';
const DEV_TOOLCHAIN_BIN = path.join(DEV_RUSTUP_HOME, 'toolchains', DEV_RUSTUP_TOOLCHAIN, 'bin');
const DEV_CARGO_BIN = path.join(DEV_CARGO_HOME, 'bin');
const DEV_TOOL_PATH = [DEV_CARGO_BIN, DEV_TOOLCHAIN_BIN, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
const DEV_CARGO_COMMAND = process.env.IB_CARGO || (TEST_PROJECT_ROOT_OVERRIDE ? 'cargo' : path.join(DEV_CARGO_BIN, 'cargo.exe'));
const DEV_CACHE_HOME = path.join(DEV_ENV_ROOT, 'cache');
const DEV_LAUNCHER_TEMP_DIR = path.join(DEV_ENV_ROOT, 'temp', 'launcher');
const DATA_PATHS = resolveAppDataPaths(DEV_DATA_PROJECT_ROOT, SYNTHETIC_MODE);
const APP_DATA = DATA_PATHS.appData;
const SANDBOX = DATA_PATHS.sandbox;
const CREDENTIAL_DATA_DIR = DATA_PATHS.credentialDataDir;
const DEV_LOCAL_APP_DATA = path.join(SANDBOX, 'local-app-data');
const DEV_ROAMING_APP_DATA = path.join(SANDBOX, 'roaming-app-data');
const DEV_TEMP_DIR = path.join(SANDBOX, 'temp');
const DEV_CACHE_DIR = path.join(SANDBOX, 'cache');
const DEV_WEBVIEW2_DIR = path.join(SANDBOX, 'webview2');
const FORMAL_APP_DATA = LOCAL_APP_DATA ? path.join(LOCAL_APP_DATA, 'InternalBeyond') : path.join(os.homedir(), '.internal-beyond');
function resolveCargoTargetDir(sandbox, override, projectRoot, syntheticMode) {
  const testRelative = path.relative(path.resolve(os.tmpdir()), path.resolve(String(projectRoot || '')));
  const testFirstSegment = testRelative.split(path.sep).filter(Boolean)[0] || '';
  const isTestProject = !!testRelative && testRelative !== '..' && !testRelative.startsWith('..' + path.sep)
    && !path.isAbsolute(testRelative) && testFirstSegment.toLowerCase().startsWith('ib-dev-launcher-test-');
  if (!override && isTestProject) return path.join(sandbox, 'cargo-target');
  const target = path.resolve(String(override || DEFAULT_SHARED_CARGO_TARGET_DIR));
  if (path.basename(target).toLowerCase() !== 'cargo-target') throw new Error('dev-cargo-target-path-invalid');
  if (target.toLowerCase() === DEFAULT_SHARED_CARGO_TARGET_DIR.toLowerCase()) return target;
  const targetSandbox = path.dirname(target);
  try { devServiceContract.validateSandboxRoot(targetSandbox, syntheticMode === true, projectRoot); }
  catch (_) { throw new Error('dev-cargo-target-must-belong-to-a-private-sandbox'); }
  return target;
}
const CARGO_TARGET_DIR = resolveCargoTargetDir(SANDBOX, process.env.IB_DEV_CARGO_TARGET_DIR, DEV_DATA_PROJECT_ROOT, SYNTHETIC_MODE);
const HOST_DATA = path.join(SANDBOX, 'host');
const LOG_DIR = path.join(SANDBOX, 'logs');
const STATE_FILE = path.join(SANDBOX, 'launcher-state.json');
const STOP_REQUEST_FILE = path.join(SANDBOX, 'stop-requested.json');
const SEED_FILE = path.join(SANDBOX, 'seed.json');
const SEED_IMPORTED_FILE = path.join(SANDBOX, 'seed-imported.json');
const CONFIG_FILE = path.join(SANDBOX, 'tauri-dev-config.json');
const SOURCE_DB = path.join(FORMAL_APP_DATA, 'home-node', 'home-node.db');
const SOURCE_WEB_PORT = validPort(process.env.IB_PROD_WEB_PORT, 23120);
const DEV_PORTS = devServiceContract.DEV_PORTS;
const DEV_ORIGIN = 'http://127.0.0.1:' + DEV_PORTS.web;
const DEV_INSTANCE_ID = crypto.randomUUID();
const DEV_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
const HOST_STOP_MS = 15000;
const SERVICE_STOP_MS = 8000;
const TAURI_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const HOST_READINESS_TIMEOUT_MS = 60000;
const HOST_STATUS_STALE_MS = 10000;
const RUNTIME_LIFECYCLE_POLL_MS = 2000;

let child = null;
let childSpawnedAt = 0;
let stopRequested = false;
let currentState = null;
let runtimeLifecycleTimer = null;
let runtimeLifecycleGeneration = 0;

function launcherStopRequested() {
  return stopRequested || fs.existsSync(STOP_REQUEST_FILE);
}

function validPort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function resolveDevDataProjectRoot(projectRoot, testOverride) {
  if (!testOverride) return path.resolve(projectRoot);
  const target = path.resolve(String(testOverride));
  const relative = path.relative(path.resolve(os.tmpdir()), target);
  const firstSegment = relative.split(path.sep).filter(Boolean)[0] || '';
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
    || !firstSegment.toLowerCase().startsWith('ib-dev-launcher-test-')) {
    throw new Error('dev-launcher-test-project-root-invalid');
  }
  return target;
}

function resolveAppDataPaths(projectRoot, syntheticMode) {
  const base = path.join(path.resolve(String(projectRoot || ROOT)), '.dev-data');
  const appData = path.join(base, syntheticMode === true ? 'synthetic' : 'development');
  const sandbox = path.join(appData, 'dev-sandbox');
  return Object.freeze({
    appData: appData,
    sandbox: sandbox,
    credentialDataDir: path.join(sandbox, 'credential-vault')
  });
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
  const directories = [
    DEV_DATA_PROJECT_ROOT, path.join(DEV_DATA_PROJECT_ROOT, '.dev-data'), APP_DATA, SANDBOX, HOST_DATA, LOG_DIR,
    path.join(SANDBOX, 'home-node'), path.join(SANDBOX, 'bridge'), path.join(SANDBOX, 'active'),
    CREDENTIAL_DATA_DIR, DEV_LOCAL_APP_DATA, DEV_ROAMING_APP_DATA, DEV_TEMP_DIR, DEV_CACHE_DIR, DEV_WEBVIEW2_DIR,
    DEV_CACHE_HOME, path.join(DEV_CACHE_HOME, 'npm'), path.join(DEV_CACHE_HOME, 'pip'),
    path.join(DEV_CACHE_HOME, 'huggingface', 'hub'), path.join(DEV_CACHE_HOME, 'torch'),
    path.join(DEV_CACHE_HOME, 'python-cache'), path.join(DEV_CACHE_HOME, 'matplotlib'),
    DEV_CARGO_HOME, DEV_RUSTUP_HOME, DEV_LAUNCHER_TEMP_DIR, path.dirname(CARGO_TARGET_DIR), CARGO_TARGET_DIR
  ];
  for (const dir of directories) {
    fs.mkdirSync(dir, { recursive: true });
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error('Dev data path is a reparse point; refusing to use it.');
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

function devToolEnvironment(extra) {
  return Object.assign({}, process.env, {
    CARGO_HOME: DEV_CARGO_HOME,
    RUSTUP_HOME: DEV_RUSTUP_HOME,
    RUSTUP_TOOLCHAIN: DEV_RUSTUP_TOOLCHAIN,
    CARGO_TARGET_DIR: CARGO_TARGET_DIR,
    PATH: DEV_TOOL_PATH,
    TEMP: DEV_LAUNCHER_TEMP_DIR,
    TMP: DEV_LAUNCHER_TEMP_DIR,
    TMPDIR: DEV_LAUNCHER_TEMP_DIR,
    npm_config_cache: path.join(DEV_CACHE_HOME, 'npm'),
    PIP_CACHE_DIR: path.join(DEV_CACHE_HOME, 'pip'),
    HF_HOME: path.join(DEV_CACHE_HOME, 'huggingface'),
    HF_HUB_CACHE: path.join(DEV_CACHE_HOME, 'huggingface', 'hub'),
    HUGGINGFACE_HUB_CACHE: path.join(DEV_CACHE_HOME, 'huggingface', 'hub'),
    TORCH_HOME: path.join(DEV_CACHE_HOME, 'torch'),
    PYTHONPYCACHEPREFIX: path.join(DEV_CACHE_HOME, 'python-cache'),
    MPLCONFIGDIR: path.join(DEV_CACHE_HOME, 'matplotlib')
  }, extra || {});
}

function checkTauriCli() {
  const result = syncSpawn(DEV_CARGO_COMMAND, ['tauri', '--version'], {
    cwd: path.join(ROOT, 'src-tauri'), env: devToolEnvironment(), timeout: 15000
  });
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

function hostRecordMatchesWatcher(record, watcherStartedAtMs) {
  const watcherStartedAt = Number(watcherStartedAtMs) || 0;
  return !watcherStartedAt || hostStartedAt(record) + 20000 >= watcherStartedAt;
}

function runtimeStatusSnapshot(record, watcherStartedAtMs) {
  if (!record) return null;
  const status = record.status || record.runtimeStatus || {};
  if (!hostRecordMatchesWatcher(record, watcherStartedAtMs)) {
    return {
      hostPid: hostPid(record),
      hostStartedAtMs: hostStartedAt(record),
      hostSessionId: sessionId(record),
      state: 'STALE',
      message: 'Last Host status belongs to a previous Dev launch.',
      updatedAtMs: Number(status.updatedAtMs || status.updated_at_ms) || 0,
      degraded: false,
      homeNodeReady: null,
      homeNodePort: 0,
      homeNodeReasonCode: '',
      bridgeReady: null,
      activeReady: null,
      staticReady: null,
      services: 'stale:previous-host-record'
    };
  }
  const services = servicesFrom(record).map(row => {
    const kind = String(serviceField(row, 'serviceKind', 'service_kind') || 'service');
    const state = String(serviceField(row, 'state', 'state') || 'unknown');
    return kind + ':' + state;
  }).sort();
  return {
    hostPid: hostPid(record),
    hostStartedAtMs: hostStartedAt(record),
    hostSessionId: sessionId(record),
    state: String(status.state || 'unknown'),
    message: String(status.message || ''),
    updatedAtMs: Number(status.updatedAtMs || status.updated_at_ms) || 0,
    degraded: status.degraded === true || String(status.state || '').toUpperCase() === 'DEGRADED',
    homeNodeReady: status.homeNodeReady === true || status.home_node_ready === true,
    homeNodePort: Number(status.homeNodePort || status.home_node_port) || 0,
    homeNodeReasonCode: String(status.homeNodeReasonCode || status.home_node_reason_code || ''),
    bridgeReady: typeof status.bridgeReady === 'boolean' ? status.bridgeReady
      : (typeof status.bridge_ready === 'boolean' ? status.bridge_ready : null),
    activeReady: typeof status.activeReady === 'boolean' ? status.activeReady
      : (typeof status.active_ready === 'boolean' ? status.active_ready : null),
    staticReady: typeof status.staticReady === 'boolean' ? status.staticReady
      : (typeof status.static_ready === 'boolean' ? status.static_ready : null),
    services: services.join(',')
  };
}

function runtimeHealthCategory(snapshot) {
  if (!snapshot) return 'unknown';
  if (String(snapshot.state || '').toUpperCase() === 'STALE') return 'unknown';
  if (String(snapshot.state || '').toUpperCase() === 'STOPPED') return 'stopped';
  if (snapshot.degraded === true || String(snapshot.state || '').toUpperCase() === 'DEGRADED') return 'service-degraded';
  return 'healthy';
}

function resolvedHomeNodePort(status, state) {
  return Number(status && (status.homeNodePort || status.home_node_port)) ||
    Number(state && state.ports && state.ports.homeNode) || DEV_PORTS.homeNode;
}

function formatRuntimeStatus(snapshot) {
  if (!snapshot) return 'hostState=unknown';
  const readiness = value => value === true ? 'ready' : (value === false ? 'unavailable' : 'unknown');
  return 'hostPid=' + (snapshot.hostPid || 'unknown') + ', hostState=' + snapshot.state
    + ', HomeNode=' + readiness(snapshot.homeNodeReady)
    + (snapshot.homeNodeReady ? '' : (snapshot.homeNodeReasonCode ? '(' + snapshot.homeNodeReasonCode + ')' : ''))
    + ', Bridge=' + readiness(snapshot.bridgeReady)
    + ', Active=' + readiness(snapshot.activeReady)
    + ', Web=' + readiness(snapshot.staticReady)
    + ', services=' + (snapshot.services || 'unknown')
    + (snapshot.message ? ', detail=' + safeLogText(snapshot.message) : '');
}

function classifyTauriExit(code, signal, launcherStopRequested, hostRecord) {
  if (launcherStopRequested === true) return 'launcher-requested-stop';
  const status = hostRecord && (hostRecord.status || hostRecord.runtimeStatus) || {};
  if (String(status.state || '').toUpperCase() === 'STOPPED') return 'host-closed-without-launcher-request';
  if (signal || (Number.isInteger(code) && code !== 0)) return 'tauri-dev-process-error';
  if (code === 0) return 'tauri-dev-process-exited-without-stop-request';
  return 'tauri-dev-process-exit-unknown';
}

function stopRuntimeLifecycleMonitor() {
  runtimeLifecycleGeneration += 1;
  if (runtimeLifecycleTimer) clearInterval(runtimeLifecycleTimer);
  runtimeLifecycleTimer = null;
}

function startRuntimeLifecycleMonitor(devChild) {
  stopRuntimeLifecycleMonitor();
  const generation = runtimeLifecycleGeneration;
  const watcherStartedAtMs = Number(devChild && devChild.launcherSpawnedAtMs) || 0;
  let previous = runtimeStatusSnapshot(currentHostRecord(), watcherStartedAtMs);
  let lastHostPid = previous ? previous.hostPid : 0;
  let lastHostSessionId = previous ? previous.hostSessionId : '';
  let previousCategory = runtimeHealthCategory(previous);
  let previousDegradedSignature = '';
  let staleReported = false;
  let rebuildObservedAt = 0;
  let logOffset = 0;
  try {
    if (devChild && devChild.buildLogPath) logOffset = fs.statSync(devChild.buildLogPath).size;
  } catch (_) {}

  const timer = setInterval(() => {
    if (generation !== runtimeLifecycleGeneration || child !== devChild
      || !devChild || devChild.exitCode !== null || devChild.signalCode !== null) {
      if (generation === runtimeLifecycleGeneration) stopRuntimeLifecycleMonitor();
      return;
    }

    if (devChild.buildLogPath) {
      const appended = readAppendedLog(devChild.buildLogPath, logOffset);
      logOffset = appended.offset;
      if (/Info\s+File\s+.+?\s+changed\.\s+Rebuilding application\.\.\./i.test(appended.text)) {
        rebuildObservedAt = Date.now();
        log('Runtime lifecycle: Tauri file watcher requested a rebuild; the Dev watcher remains active while the Host reloads.');
      }
    }

    const snapshot = runtimeStatusSnapshot(currentHostRecord(), watcherStartedAtMs);
    if (!snapshot) return;
    const category = runtimeHealthCategory(snapshot);
    const requestedStop = stopRequested || fs.existsSync(STOP_REQUEST_FILE);

    if (snapshot.hostPid > 0 && (snapshot.hostPid !== lastHostPid || snapshot.hostSessionId !== lastHostSessionId)) {
      if (lastHostPid > 0) {
        const isHotReload = rebuildObservedAt > 0 && Date.now() - rebuildObservedAt <= 120000;
        log('Runtime lifecycle: Tauri Host process changed under the live Dev watcher (oldPid=' + lastHostPid
          + ', newPid=' + snapshot.hostPid + ', cause=' + (isHotReload ? 'file-hot-reload' : 'host-replacement-without-file-change-evidence')
          + ', watcherPid=' + devChild.pid + '). ' + formatRuntimeStatus(snapshot));
      }
      lastHostPid = snapshot.hostPid;
      lastHostSessionId = snapshot.hostSessionId;
      staleReported = false;
      rebuildObservedAt = 0;
    }

    if (category === 'service-degraded'
      && (previousCategory !== 'service-degraded' || previousDegradedSignature !== formatRuntimeStatus(snapshot))) {
      log('Runtime lifecycle: service health degraded while the Dev watcher remains active. ' + formatRuntimeStatus(snapshot));
      previousDegradedSignature = formatRuntimeStatus(snapshot);
    } else if (category === 'healthy' && previousCategory === 'service-degraded') {
      log('Runtime lifecycle: service health recovered. ' + formatRuntimeStatus(snapshot));
      previousDegradedSignature = '';
    }

    if (snapshot.state.toUpperCase() === 'STOPPED' && previous && previous.state.toUpperCase() !== 'STOPPED') {
      const cause = requestedStop ? 'launcher-cleanup' : (rebuildObservedAt > 0 ? 'file-hot-reload' : 'host-closed-without-launcher-request');
      log('Runtime lifecycle: Tauri Host entered STOPPED while the Dev watcher remains alive (cause=' + cause
        + ', watcherPid=' + devChild.pid + '). ' + formatRuntimeStatus(snapshot));
    }

    const heartbeatAgeMs = snapshot.updatedAtMs > 0 ? Date.now() - snapshot.updatedAtMs : 0;
    const rebuilding = rebuildObservedAt > 0 && Date.now() - rebuildObservedAt <= 30000;
    if (snapshot.updatedAtMs > 0 && heartbeatAgeMs > HOST_STATUS_STALE_MS && !staleReported && !rebuilding
      && snapshot.state.toUpperCase() !== 'STOPPED') {
      const cause = snapshot.state.toUpperCase() === 'STOPPED'
        ? (requestedStop ? 'launcher-cleanup-complete' : 'host-closed-without-launcher-request')
        : 'host-crash-or-hang-suspected';
      log('Runtime lifecycle: Host status heartbeat is stale by ' + heartbeatAgeMs + 'ms (cause=' + cause
        + ', watcherPid=' + devChild.pid + ', lastUpdatedAtMs=' + snapshot.updatedAtMs
        + '). No startup timeout or automatic Dev shutdown is applied during runtime. ' + formatRuntimeStatus(snapshot));
      staleReported = true;
    } else if (heartbeatAgeMs <= HOST_STATUS_STALE_MS) {
      staleReported = false;
    }

    previous = snapshot;
    previousCategory = category;
  }, RUNTIME_LIFECYCLE_POLL_MS);
  timer.unref();
  runtimeLifecycleTimer = timer;
}

function hostIsAlive(record) {
  const pid = hostPid(record);
  return pid > 0 && processMatchesHost(pid, hostStartedAt(record));
}

function captureReadyHostSnapshot(record) {
  const status = record && (record.status || record.runtimeStatus) || {};
  if (!record || status.staticReady !== true || status.homeNodeReady !== true) return null;
  return { record, status: Object.assign({}, status) };
}

function saveState(state) {
  currentState = state;
  writeJsonAtomic(STATE_FILE, state);
}

function tauriEnvironment(extra) {
  const env = Object.assign(devToolEnvironment(), {
    IB_DEV_MODE: '1',
    IB_DEV_DSH_ENABLED: '0',
    IB_DEV_SYNTHETIC: SYNTHETIC_MODE ? '1' : '0',
    IB_DEV_PROJECT_ROOT: DEV_DATA_PROJECT_ROOT,
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
    IB_DSH_WEB_PORT: String(DEV_PORTS.dshWeb),
    LOCALAPPDATA: DEV_LOCAL_APP_DATA,
    APPDATA: DEV_ROAMING_APP_DATA,
    TEMP: DEV_TEMP_DIR,
    TMP: DEV_TEMP_DIR,
    TMPDIR: DEV_TEMP_DIR,
    XDG_CACHE_HOME: DEV_CACHE_DIR,
    WEBVIEW2_USER_DATA_FOLDER: DEV_WEBVIEW2_DIR,
    IB_DEV_WEBVIEW2_DATA_DIR: DEV_WEBVIEW2_DIR
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
  delete env.IB_DEV_LAUNCHER_TEST_PROJECT_ROOT;
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
  const command = DEV_CARGO_COMMAND;
  const args = ['tauri', 'dev', '--config', CONFIG_FILE];
  const logPath = path.join(LOG_DIR, 'tauri-' + tag + '.log');
  const stdoutFd = fs.openSync(logPath, 'a');
  const stderrFd = fs.openSync(logPath, 'a');
  const logStartOffset = fs.fstatSync(stdoutFd).size;
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
  processChild.buildLogPath = logPath;
  processChild.buildLogStartOffset = logStartOffset;
  return trackTauriChild(processChild, tag);
}

function trackTauriChild(processChild, tag) {
  child = processChild;
  childSpawnedAt = Date.now();
  processChild.launcherSpawnedAtMs = childSpawnedAt;
  child.on('error', error => {
    log('Tauri process could not start (tag=' + tag + ', code=' + (error && error.code || 'spawn-failed')
      + ', message=' + safeLogText(error && error.message || 'unknown-error') + ').');
  });
  child.on('exit', (code, signal) => {
    stopRuntimeLifecycleMonitor();
    const latest = readJson(STATE_FILE) || currentState || {};
    const requestedStop = launcherStopRequested();
    const hostRecord = currentHostRecord();
    const watcherStartedAtMs = Number(processChild.launcherSpawnedAtMs || latest.childStartedAtMs) || 0;
    const hostRecordIsCurrent = hostRecordMatchesWatcher(hostRecord, watcherStartedAtMs);
    const hostStatus = runtimeStatusSnapshot(hostRecord, watcherStartedAtMs);
    const exitReason = classifyTauriExit(code, signal, requestedStop, hostRecordIsCurrent ? hostRecord : null);
    latest.launcherState = requestedStop || exitReason === 'host-closed-without-launcher-request'
      ? 'stopped' : ((signal || (Number.isInteger(code) && code !== 0)) ? 'failed' : 'exited');
    latest.exitCode = Number.isInteger(code) ? code : null;
    latest.exitSignal = signal || null;
    latest.exitReason = exitReason;
    latest.updatedAt = timestamp();
    saveState(latest);
    log('Runtime lifecycle: Tauri Dev watcher exited (tag=' + tag + ', cause=' + exitReason
      + ', code=' + (Number.isInteger(code) ? code : 'none') + ', signal=' + (signal || 'none')
      + ', launcherStopRequested=' + requestedStop + ', watcherPid=' + (processChild.pid || 'unknown')
      + '). ' + formatRuntimeStatus(hostStatus) + '; log=' + (processChild.buildLogPath || 'tauri-' + tag + '.log'));
    child = null;
    if (!requestedStop && exitReason !== 'host-closed-without-launcher-request') {
      log('Runtime lifecycle: unexpected Tauri Dev watcher exit; cleaning only services recorded by this Launcher instance.');
    }
    if (!requestedStop && tag === 'main') {
      stopOwnedServices(hostRecord, false).then(() => stopLauncherStatic(latest)).then(() => {
        log('Runtime lifecycle: Launcher-owned service cleanup completed after Tauri Dev watcher exit (cause=' + exitReason + ').');
      }).catch(error => {
        log('Runtime lifecycle: Launcher-owned service cleanup failed after Tauri Dev watcher exit (cause=' + exitReason
          + ', error=' + safeLogText(error && error.message || 'cleanup-failed') + ').');
      });
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

function readAppendedLog(filePath, offset) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const start = size < offset ? 0 : offset;
    const length = Math.min(Math.max(0, size - start), 64 * 1024);
    if (length === 0) return { text: '', offset: start };
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString('utf8', 0, bytesRead), offset: start + bytesRead };
  } catch (_) {
    return { text: '', offset: offset };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

function hasCargoBuildFinished(text) {
  const plain = String(text || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  return /\bFinished\s+`dev`\s+profile\b/i.test(plain);
}

function cargoBuildFailure(text) {
  const plain = String(text || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const lines = plain.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const fatalLine = lines.find(line => /^error:\s+(?:failed to build archive\b|linking with\b|linker\b|failed to run custom build command\b)/i.test(line))
    || lines.find(line => /^error:\s+(?:could not compile\b|failed to compile\b)/i.test(line));
  return fatalLine ? safeLogText(fatalLine).slice(0, 480) : '';
}

function childExitDiagnostic(devChild, phase) {
  const code = Number.isInteger(devChild && devChild.exitCode) ? devChild.exitCode : 'none';
  const signal = devChild && devChild.signalCode ? devChild.signalCode : 'none';
  const logPath = devChild && devChild.buildLogPath ? devChild.buildLogPath : 'tauri-main.log';
  return 'tauri-dev-exited-' + phase + ' (code=' + code + ', signal=' + signal + '; log=' + logPath + ')';
}

async function waitForTauriBuild(devChild, timeoutMs, intervalMs, isHostRunning, isStopRequested) {
  const logPath = devChild && devChild.buildLogPath;
  if (!logPath) throw new Error('tauri-build-log-unavailable');
  const limitMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0
    ? Number(timeoutMs) : TAURI_BUILD_TIMEOUT_MS;
  const pollMs = Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0 ? Number(intervalMs) : 350;
  const deadline = Date.now() + limitMs;
  let offset = Math.max(0, Number(devChild.buildLogStartOffset) || 0);
  let recentOutput = '';
  let lastHostCheckAt = 0;
  const hostStarted = async force => {
    if (typeof isHostRunning !== 'function') return false;
    if (!force && Date.now() - lastHostCheckAt < 1000) return false;
    lastHostCheckAt = Date.now();
    try { return (await isHostRunning()) === true; }
    catch (_) { return false; }
  };
  const shouldStop = async () => {
    if (typeof isStopRequested === 'function') {
      try { return (await isStopRequested()) === true; }
      catch (_) { return launcherStopRequested(); }
    }
    return launcherStopRequested();
  };
  const throwIfBuildFailed = () => {
    const failure = cargoBuildFailure(recentOutput);
    if (failure) throw new Error('tauri-cargo-build-failed (' + failure + '; log=' + logPath + ')');
  };
  while (true) {
    const appended = readAppendedLog(logPath, offset);
    offset = appended.offset;
    recentOutput = (recentOutput + appended.text).slice(-4096);
    throwIfBuildFailed();
    if (await shouldStop()) throw new Error('launcher-stop-requested-during-build');
    if (hasCargoBuildFinished(recentOutput)) {
      devChild.buildCompletionSource = 'cargo-finished-marker';
      return true;
    }
    if (await hostStarted()) {
      devChild.buildCompletionSource = 'host-process-observed';
      return true;
    }
    if (devChild.exitCode !== null || devChild.signalCode !== null) {
      if (await shouldStop()) throw new Error('launcher-stop-requested-during-build');
      throw new Error(childExitDiagnostic(devChild, 'during-build'));
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }

  const appended = readAppendedLog(logPath, offset);
  recentOutput = (recentOutput + appended.text).slice(-4096);
  throwIfBuildFailed();
  if (await shouldStop()) throw new Error('launcher-stop-requested-during-build');
  if (hasCargoBuildFinished(recentOutput)) {
    devChild.buildCompletionSource = 'cargo-finished-marker';
    return true;
  }
  if (await hostStarted(true)) {
    devChild.buildCompletionSource = 'host-process-observed';
    return true;
  }
  if (devChild.exitCode !== null || devChild.signalCode !== null) {
    if (await shouldStop()) throw new Error('launcher-stop-requested-during-build');
    throw new Error(childExitDiagnostic(devChild, 'during-build'));
  }
  throw new Error('tauri-build-timeout (stage=rust-build, timeoutMs=' + limitMs + '; log=' + logPath + ')');
}

async function initializeDevHostLifecycle(dependencies) {
  const deps = dependencies || {};
  const handles = { staticServer: null, dshHost: null, state: null, devChild: null };
  const cleanup = async (reason, error) => {
    if (typeof deps.cleanupOwned !== 'function') return;
    await deps.cleanupOwned(handles, reason, error);
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
    const cleanupReason = launcherStopRequested() ? 'launcher-stop-requested' : 'startup-failure';
    try { await cleanup(cleanupReason, error); }
    catch (cleanupError) {
      if (error && typeof error === 'object') error.cleanupError = String(cleanupError && cleanupError.message || cleanupError);
    }
    throw error;
  }
}

async function cleanupDevHostLifecycle(handles, reason, startupError) {
  if (!handles || (!handles.staticServer && !handles.dshHost && !handles.state && !handles.devChild)) return;
  if (reason === 'startup-failure') log('Startup failed; cleaning only processes recorded by this Launcher instance.');
  else if (reason === 'launcher-stop-requested') log('Runtime lifecycle: explicit stop interrupted startup; cleaning only processes recorded by this Launcher instance.');
  else if (reason === 'normal-exit') log('Runtime lifecycle: explicit normal stop requested; cleaning only processes recorded by this Launcher instance.');
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
  latest.launcherState = launcherStateAfterCleanup(reason);
  if (reason === 'launcher-stop-requested') latest.exitReason = 'launcher-requested-stop';
  else if (reason === 'startup-failure') latest.exitReason = launcherFailureCode(startupError);
  latest.updatedAt = timestamp();
  saveState(latest);
}

function launcherStateAfterCleanup(reason) {
  return reason === 'startup-failure' ? 'failed' : 'stopped';
}

function launcherFailureCode(error) {
  const match = String(error && error.message || '').match(/^([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/i);
  return match ? match[1].toLowerCase() : 'startup-failure';
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
  for (const [name, port] of Object.entries(DEV_PORTS)) {
    /* Host and Runner verify Home Node's identity and choose a private fallback
       when its preferred port is occupied. Other Dev services keep their
       existing fail-fast port contract. */
    if (name === 'homeNode') continue;
    if (!(await isPortFree(port))) occupied.push(port);
  }
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
        projectRoot: DEV_DATA_PROJECT_ROOT,
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
        log('Waiting for Rust build completion (max ' + Math.round(TAURI_BUILD_TIMEOUT_MS / 60000) + ' minutes; output: tauri-main.log).');
        await waitForTauriBuild(devChild, TAURI_BUILD_TIMEOUT_MS, 350, () => {
          const record = currentHostRecord();
          const spawnedAt = Number(devChild.launcherSpawnedAtMs) || 0;
          const status = record && (record.status || record.runtimeStatus) || {};
          if (!record || !spawnedAt || hostStartedAt(record) + 20000 < spawnedAt
            || Number(status.updatedAtMs || status.updated_at_ms) + 20000 < spawnedAt) return false;
          return hostIsAlive(record);
        }, launcherStopRequested);
        if (devChild.buildCompletionSource === 'host-process-observed') {
          const record = currentHostRecord();
          log('Tauri Host process observed (PID ' + hostPid(record)
            + ') before the Cargo Finished marker; releasing the build-log wait and checking Host/Web/Home Node readiness separately.');
        } else {
          log('Rust build completion marker observed.');
        }
        log((devChild.buildCompletionSource === 'host-process-observed' ? 'Tauri Host process is live. Waiting up to ' : 'Rust build completed. Waiting up to ')
          + Math.round(HOST_READINESS_TIMEOUT_MS / 1000)
          + ' seconds for the Tauri Host, Web service and Home Node.');
        let readySnapshot = null;
        const ready = await waitFor(async () => {
          if (devChild.exitCode !== null || devChild.signalCode !== null) return false;
          const record = currentHostRecord();
          if (!record || !hostIsAlive(record)) return false;
          readySnapshot = captureReadyHostSnapshot(record);
          return !!readySnapshot;
        }, HOST_READINESS_TIMEOUT_MS, 350);
        if (!ready && (devChild.exitCode !== null || devChild.signalCode !== null)) {
          throw new Error(childExitDiagnostic(devChild, 'before-readiness'));
        }
        if (!ready) {
          const record = currentHostRecord();
          const status = record && (record.status || record.runtimeStatus) || {};
          throw new Error('dev-host-readiness-timeout (timeoutMs=' + HOST_READINESS_TIMEOUT_MS
            + ', webReady=' + (status.staticReady === true) + ', homeNodeReady=' + (status.homeNodeReady === true)
            + '; log=' + (devChild.buildLogPath || 'tauri-main.log') + ')');
        }
        /* Use the Host process and readiness state that passed the poll together.
           Re-reading the supervisor file here can observe a transient teardown or
           health refresh and reject a Host that was already ready. */
        if (!readySnapshot) throw new Error('dev-host-readiness-snapshot-unavailable');
        const record = readySnapshot.record;
        const status = readySnapshot.status;
        const actualHomeNodePort = Number(status.homeNodePort || status.home_node_port) || DEV_PORTS.homeNode;
        if (_state && _state.ports && _state.ports.homeNode !== actualHomeNodePort) {
          _state.ports.homeNode = actualHomeNodePort;
          _state.updatedAt = timestamp();
          saveState(_state);
        }
        log('Dev host started (PID ' + hostPid(record) + '); Web is ready and Home Node is ready on ' + actualHomeNodePort + '. Sandbox writes are isolated.');
        return true;
      },
      cleanupOwned: cleanupDevHostLifecycle
    });
    const runningState = readJson(STATE_FILE) || lifecycle.state;
    runningState.launcherState = 'running';
    runningState.exitCode = null;
    runningState.exitSignal = null;
    runningState.exitReason = null;
    runningState.updatedAt = timestamp();
    saveState(runningState);
    startRuntimeLifecycleMonitor(lifecycle.devChild);
    log('Runtime lifecycle monitor started after readiness; startup timeouts no longer apply.');
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
    'Home Node: ' + (status && status.homeNodeReady ? 'ready on ' + resolvedHomeNodePort(status, currentState) : 'not ready'),
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
  log('Runtime lifecycle: Launcher cleanup requested (source=' + (process.stdin.isTTY ? 'interactive-console' : 'stop-command') + ').');
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
    'Home Node: ' + (status.homeNodeReady === true ? 'ready (' + resolvedHomeNodePort(status, state) + ')' : 'not ready'),
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
  if (!TEST_PROJECT_ROOT_OVERRIDE) {
    fs.mkdirSync(DEV_LAUNCHER_TEMP_DIR, { recursive: true });
    Object.assign(process.env, devToolEnvironment());
  }
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
  ROOT, DEFAULT_DEV_DATA_ROOT, DEV_DATA_PROJECT_ROOT, DEV_ENV_ROOT, APP_DATA, SANDBOX, DEV_PORTS,
  CARGO_TARGET_DIR, DEV_CARGO_HOME, DEV_RUSTUP_HOME, SYNTHETIC_MODE, TAURI_BUILD_TIMEOUT_MS, HOST_READINESS_TIMEOUT_MS,
  resolveAppDataPaths, resolveCargoTargetDir, ensureSandbox, statusText, reset, waitForTauriBuild,
  classifyTauriExit, runtimeHealthCategory,
  runtimeStatusSnapshot, captureReadyHostSnapshot, launcherStateAfterCleanup, launcherFailureCode,
  stageManualExportFile, manualSeedRequired, initializeDevHostLifecycle, devToolEnvironment, tauriEnvironment, parseStartOptions, currentHostRecord, hostIsAlive,
  requestServiceStop, processMatchesHost, processMatchesLauncher
});
