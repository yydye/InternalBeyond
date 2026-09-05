'use strict';

/*
 * Internal Beyond local service runner (Node.js 18+)
 *
 * Keeps the Bridge and Active companion under one parent process, writes
 * readable per-service logs, and offers a small interactive control surface.
 * It deliberately never kills a process it did not spawn: Ctrl+C only stops
 * children started by this runner, so an existing independently-run service
 * remains untouched.
 *
 * Usage:
 *   node local-services-runner.js              # Bridge + Active
 *   node local-services-runner.js --vision     # also start vision helper
 *   node local-services-runner.js --status     # read-only health summary
 *   node local-services-runner.js --json       # machine-readable status
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const LOCAL_DIR = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
  : path.join(os.homedir(), '.internal-beyond');
const LOG_DIR = path.join(LOCAL_DIR, 'logs');
const args = new Set(process.argv.slice(2));
const includeVision = args.has('--vision');
const jsonOnly = args.has('--json');
const statusOnly = args.has('--status') || jsonOnly;
const children = [];
/* Tracks the current live child per service name (restart uses the newest
   entry, not the first spawned, so repeated restarts stop the right one). */
const currentChild = {};

/* ── Silent backend restart (back-end lifecycle management) ──
 * A localhost-only control surface that restarts the Bridge (23115) and
 * Active (23114) backends using the same spawn path below, fully hidden
 * (no console window), with an in-flight guard. Reuses the existing service
 * definitions — it never introduces a second startup configuration. */
const RESTART_HOST = '127.0.0.1';
const RESTART_PORT = optionPort('IB_RESTART_PORT', 23116);
const RESTART_SERVER_NAME = 'InternalBeyond Restart';

fs.mkdirSync(LOG_DIR, { recursive: true });

function optionPort(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

const SERVICES = [
  {
    name: 'Bridge',
    port: optionPort('IB_BRIDGE_PORT', 23115),
    endpoint: '/health',
    command: process.execPath,
    commandArgs: [path.join(ROOT, 'ib-bridge-service.js')],
    matchesHealth: data => data && data.server === 'IB Bridge',
    env: {}
  },
  {
    name: 'Active',
    port: optionPort('IB_ACTIVE_PORT', 23114),
    endpoint: '/health',
    command: process.execPath,
    commandArgs: [path.join(ROOT, 'active-message-service.js')],
    matchesHealth: data => data && data.service === 'internal-beyond-active-messages',
    env: {}
  }
];

if (includeVision) {
  SERVICES.push({
    name: 'Vision',
    port: optionPort('IB_VISION_PORT', 8765),
    endpoint: '/health',
    command: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'sh',
    commandArgs: process.platform === 'win32'
      ? ['/d', '/c', path.join(ROOT, 'start-vision-service.cmd')]
      : ['-lc', 'echo "Vision helper is currently provided by start-vision-service.cmd on Windows."; exit 1'],
    matchesHealth: data => data && data.service === 'internal-beyond-vision',
    env: {}
  });
}

function requestJson(port, endpoint, timeoutMs) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: endpoint, timeout: timeoutMs || 1800 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }
        resolve({
          responding: true,
          healthy: res.statusCode >= 200 && res.statusCode < 300 && !!(data && data.ok),
          status: res.statusCode,
          data
        });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ responding: false, healthy: false, status: 0, data: null }); });
    req.on('error', () => resolve({ responding: false, healthy: false, status: 0, data: null }));
  });
}

async function serviceStatus(service) {
  const health = await requestJson(service.port, service.endpoint);
  const identityMatches = health.healthy && (!service.matchesHealth || service.matchesHealth(health.data));
  return {
    name: service.name,
    port: service.port,
    online: identityMatches,
    conflict: health.responding && !identityMatches,
    status: health.status,
    version: health.data && (health.data.version || health.data.serviceVersion) || '',
    details: health.data || null
  };
}

async function allStatus() {
  return Promise.all(SERVICES.map(serviceStatus));
}

function printStatus(rows) {
  if (jsonOnly) {
    process.stdout.write(JSON.stringify({ ok: true, services: rows }, null, 2) + '\n');
    return;
  }
  console.log('\nInternal Beyond local services');
  rows.forEach(row => {
    const state = row.online ? 'online' : (row.conflict ? 'conflict' : 'offline');
    const extra = row.online && row.version ? ' · v' + row.version : '';
    console.log('  ' + row.name.padEnd(7) + state.padEnd(8) + '127.0.0.1:' + row.port + extra);
  });
  console.log('  Logs: ' + LOG_DIR + '\n');
}

/* ── Redaction: never let secrets / full command lines reach logs or UI ── */
function redact(text) {
  let out = String(text == null ? '' : text);
  /* Keep the key label readable, mask the value. */
  out = out.replace(/(\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|bearer|authorization|x-ib-token|openai[_-]?key)\b\s*[:=]\s*)(['"]?)[^\s,'";]{4,}/gi,
    (m, p1, p2) => p1 + (p2 || '') + '***' + (p2 || ''));
  /* Bare credential tokens are masked entirely (never echoed). */
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, '****');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._-]{6,}\b/gi, (m, p1) => p1 + '****');
  out = out.replace(/\b(AIza[A-Za-z0-9_-]{15,})\b/g, '****');
  /* Never echo a full command line / spawn args. */
  out = out.replace(/(?:node(?:\.exe)?[^\r\n]*?(?:ib-bridge-service|active-message-service|local-services-runner)[^\r\n]*)/gi, '[script]');
  return out;
}
function appendRestartLog(msg) {
  const line = '[' + new Date().toISOString() + '] ' + redact(msg);
  try { fs.appendFileSync(path.join(LOG_DIR, 'restart.log'), line + '\n'); } catch (e) { /* logging must never take down services */ }
}

/* ── Port / process helpers (local management; fixed commands, no user input) ── */
function pidsForPort(port) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      const cmd = [ '-NoProfile', '-NonInteractive', '-Command',
        '$p=(Get-NetTCPConnection -LocalPort ' + Number(port) + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ","; Write-Output $p' ];
      execFile('powershell.exe', cmd, { windowsHide: true, timeout: 6000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        const pids = String(stdout || '').trim().split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0);
        resolve(pids);
      });
    } else {
      /* POSIX fallback (kept simple; the feature targets Windows). */
      execFile('sh', ['-c', '(netstat -tlnp 2>/dev/null || true) | grep ":' + Number(port) + '" | awk \'{print $7}\' | cut -d/ -f1'], { timeout: 6000 }, (err, stdout) => {
        if (err) { resolve([]); return; }
        const pids = String(stdout || '').trim().split(/\s+/).map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0);
        resolve(pids);
      });
    }
  });
}
function processCommandline(pid) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') { resolve(String(process.platform)); return; }
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '").CommandLine'], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}
function processMatchesService(pid, service) {
  return new Promise(resolve => {
    processCommandline(pid).then(cl => {
      const script = path.basename(service.commandArgs[0] || '');
      resolve(!!cl && cl.indexOf(path.basename(ROOT)) >= 0 && cl.indexOf(script) >= 0);
    });
  });
}
function killPid(pid) {
  return new Promise(resolve => {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/F', '/T', '/PID', String(Number(pid))], { windowsHide: true, timeout: 6000 }, () => resolve());
    } else {
      try { process.kill(Number(pid), 'SIGKILL'); } catch (e) { }
      resolve();
    }
  });
}

function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const probe = () => {
      if (Date.now() > deadline) { resolve(true); return; }
      const sock = net.connect({ host: '127.0.0.1', port: port, timeout: 300 });
      let settled = false;
      const done = bound => { if (settled) return; settled = true; try { sock.destroy(); } catch (e) { } resolve(bound); };
      sock.on('connect', () => { done(false); });
      sock.on('timeout', () => { done(true); });
      sock.on('error', () => { done(true); });
    };
    probe();
  }).then(free => {
    if (free) return true;
    return new Promise(r => setTimeout(r, 200)).then(() => waitPortFree(port, deadline - Date.now()));
  });
}

async function stopService(service) {
  /* 1. Runner-owned child (clean stop via child handle). */
  const entry = currentChild[service.name];
  if (entry && !entry.exited && entry.child && !entry.child.killed) {
    try { entry.child.kill('SIGTERM'); } catch (e) { /* best effort */ }
  }
  /* 2. Any remaining process bound to the port that matches our service script
        (covers services started outside this runner). Only ever kills verified
        Internal Beyond service processes — never an arbitrary process. */
  const pids = await pidsForPort(service.port);
  for (const pid of pids) {
    if (await processMatchesService(pid, service)) await killPid(pid);
  }
  appendRestartLog('stopping ' + service.name + ' (port ' + service.port + ')');
}

/* ── Restart state machine (idle → restarting → ready | failed) ── */
const restartState = { state: 'idle', lastError: '', startedAt: 0 };

function restartRunning() {
  return restartState.state === 'restarting';
}

async function runRestart() {
  restartState.state = 'restarting';
  restartState.startedAt = Date.now();
  restartState.lastError = '';
  appendRestartLog('restart requested');
  try {
    const targets = SERVICES.filter(s => s.name === 'Bridge' || s.name === 'Active');
    /* stop → confirm old processes exit → release ports → start → health → ready */
    for (const service of targets) await stopService(service);
    for (const service of targets) await waitPortFree(service.port, 10000);
    const launched = [];
    for (const service of targets) {
      spawnService(service);
      launched.push(service);
    }
    for (const service of launched) {
      const healthy = await waitUntilHealthy(service, 25000);
      if (!healthy) throw new Error(service.name + ' did not become healthy');
      appendRestartLog(service.name + ' ready');
    }
    restartState.state = 'ready';
    appendRestartLog('restart complete');
  } catch (e) {
    restartState.state = 'failed';
    restartState.lastError = redact(String(e && e.message || e)).slice(0, 300);
    appendRestartLog('restart failed: ' + restartState.lastError);
  }
}

/* ── Restart control server (localhost-only; Origin guard) ── */
function restartOriginAllowed(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true; /* loopback / non-browser local call */
  if (origin === 'null') return true; /* file:// */
  try {
    const u = new URL(origin);
    if (u.protocol === 'file:') return true;
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const host = String(u.hostname).toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    }
  } catch (e) { /* illegal origin → deny */ }
  return false;
}
function acaOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin === 'null') return 'null';
  if (origin && restartOriginAllowed(req)) return origin;
  return null;
}
function sendJsonRes(res, status, obj, allowedOrigin) {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };
  if (allowedOrigin) headers['Access-Control-Allow-Origin'] = allowedOrigin;
  if (allowedOrigin) headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
  if (allowedOrigin) headers['Access-Control-Allow-Headers'] = 'Content-Type';
  res.writeHead(status, headers);
  res.end(JSON.stringify(obj));
}

function startRestartServer() {
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://' + (req.headers.host || RESTART_HOST + ':' + RESTART_PORT)); }
    catch (e) { sendJsonRes(res, 400, { ok: false, error: 'invalid-request' }); return; }
    const origin = acaOrigin(req);

    if (req.method === 'OPTIONS') { sendJsonRes(res, 204, {}, origin); return; }

    if (req.method === 'GET' && url.pathname === '/status') {
      sendJsonRes(res, 200, { ok: true, service: RESTART_SERVER_NAME, state: restartState.state, error: restartState.lastError || '' }, origin);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/restart') {
      if (!restartOriginAllowed(req)) { sendJsonRes(res, 403, { ok: false, error: 'origin-denied' }, origin); return; }
      if (restartRunning()) { sendJsonRes(res, 409, { ok: false, state: 'restarting', error: 'restart-in-progress' }, origin); return; }
      /* Fire-and-forget: the mutex is held for the whole run; UI polls /status. */
      runRestart();
      sendJsonRes(res, 202, { ok: true, state: 'restarting' }, origin);
      return;
    }
    sendJsonRes(res, 404, { ok: false, error: 'not-found' }, origin);
  });
  server.on('error', e => { appendRestartLog('restart control server error: ' + redact(String(e && e.message || e))); });
  server.listen(RESTART_PORT, RESTART_HOST, () => {
    appendRestartLog('restart control server listening on ' + RESTART_HOST + ':' + RESTART_PORT);
  });
}

function timestamp() { return new Date().toISOString(); }

function appendLog(service, stream, chunk) {
  const text = String(chunk || '');
  const prefix = '[' + timestamp() + '] [' + stream + '] ';
  try { fs.appendFileSync(path.join(LOG_DIR, service.name.toLowerCase() + '.log'), prefix + text); } catch (e) { /* logging must never take down services */ }
  if (!jsonOnly) process.stdout.write('[' + service.name + '] ' + text);
}

function spawnService(service) {
  const child = spawn(service.command, service.commandArgs, {
    cwd: ROOT,
    env: Object.assign({}, process.env, service.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const entry = { service, child, exited: false };
  children.push(entry);
  currentChild[service.name] = entry;
  child.stdout.on('data', chunk => appendLog(service, 'out', chunk));
  child.stderr.on('data', chunk => appendLog(service, 'err', chunk));
  child.on('error', error => appendLog(service, 'err', 'spawn failed: ' + error.message + '\n'));
  child.on('exit', (code, signal) => {
    entry.exited = true;
    appendLog(service, 'runner', 'stopped (code=' + code + ', signal=' + (signal || '') + ')\n');
  });
  appendLog(service, 'runner', 'started pid=' + child.pid + '\n');
  return entry;
}

async function waitUntilHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await serviceStatus(service);
    if (row.online) return true;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

async function startServices() {
  const initial = await allStatus();
  const launched = [];
  for (let i = 0; i < SERVICES.length; i++) {
    const service = SERVICES[i];
    const existing = initial[i];
    if (existing.online) {
      console.log('[runner] ' + service.name + ' is already healthy on port ' + service.port + '; leaving it alone.');
      continue;
    }
    if (existing.conflict) {
      console.error('[runner] Port ' + service.port + ' answered /health but is not ' + service.name +
        '; refusing to treat it as healthy or start a competing process.');
      continue;
    }
    spawnService(service);
    launched.push(service);
  }
  for (const service of launched) {
    const healthy = await waitUntilHealthy(service, service.name === 'Vision' ? 120000 : 15000);
    console.log('[runner] ' + service.name + (healthy ? ' is ready.' : ' did not become healthy yet; inspect its log.'));
  }
  printStatus(await allStatus());
}

function stopChildren() {
  children.forEach(entry => {
    if (entry.exited || !entry.child || entry.child.killed) return;
    try { entry.child.kill('SIGTERM'); } catch (e) { /* best effort */ }
  });
}

function installInteractiveControls() {
  if (!process.stdin.isTTY) return;
  console.log('Controls: [s] status · [q] stop services and exit');
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', async data => {
    const key = String(data || '').trim().toLowerCase();
    if (key === 's' || key === 'status') printStatus(await allStatus());
    if (key === 'q' || key === 'quit' || key === 'exit') shutdown(0);
  });
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[runner] Stopping services started by this runner…');
  stopChildren();
  setTimeout(() => process.exit(code), 1200).unref();
}

async function main() {
  if (statusOnly) {
    printStatus(await allStatus());
    return;
  }
  await startServices();
  startRestartServer();
  installInteractiveControls();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', error => {
  console.error('[runner] Unexpected error:', error && error.stack || error);
  shutdown(1);
});

main().catch(error => {
  console.error('[runner] Failed:', error && error.stack || error);
  shutdown(1);
});
