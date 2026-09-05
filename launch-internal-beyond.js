'use strict';

/*
 * Internal Beyond · zero-command Windows launcher.
 *
 * Double-click "Start Internal Beyond.cmd" → this Node process:
 *   1. Detects whether the local services (Bridge + Active) are already healthy
 *      via their real health endpoints (runner --json), falling back to a
 *      process-presence probe for the "starting but not ready" case.
 *   2. Starts the services manager ONLY when nothing healthy/starting is present
 *      (never a second copy when already healthy).
 *   3. Bounded-polls readiness.
 *   4. Detects / reuses / starts the static web server on 127.0.0.1:23120.
 *   5. Opens http://127.0.0.1:23120/InternalBeyond.html.
 *   6. On failure: reports clearly and does NOT open a broken UI.
 *
 * No second Chat / Memory / Tool / Voice runtime is created; the web server only
 * serves the existing static app so browser APIs (AudioWorklet) run on localhost.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const WEB_PORT = optionPort('IB_WEB_PORT', 23120);
const WEB_URL = 'http://' + HOST + ':' + WEB_PORT + '/InternalBeyond.html';
const WEB_IDENTITY = 'InternalBeyond Web';
const RUNNER = path.join(ROOT, 'local-services-runner.js');
const WEB_SERVER = path.join(ROOT, 'internal-beyond-server.js');

/* Launcher log goes to the project's logs\launcher.log (requirement). Service
   logs continue to be written by local-services-runner.js to its own location. */
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'launcher.log');

const SERVICES_TIMEOUT_MS = Number(process.env.IB_LAUNCH_SERVICES_TIMEOUT_MS) || 25000;
const WEB_TIMEOUT_MS = Number(process.env.IB_LAUNCH_WEB_TIMEOUT_MS) || 15000;
const POLL_MS = 800;

function optionPort(name, fallback) {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { }
}
function log(msg) {
  ensureLogDir();
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { }
  console.log(msg);
}
function errorBox(msg) {
  log('[ERROR] ' + msg);
  try {
    const script = "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.MessageBox]::Show(" +
      JSON.stringify(String(msg).slice(0, 1200)) + ",'Internal Beyond Launcher')";
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      windowsHide: true, detached: true, stdio: 'ignore'
    }).unref();
  } catch (e) { }
}

/* ── Health probes ── */

function httpGetJson(port, pathname, timeoutMs) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port: port, path: pathname, timeout: timeoutMs || 1500 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch (e) { }
        resolve({ responding: true, status: res.statusCode, data });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ responding: false, status: 0, data: null }); });
    req.on('error', () => resolve({ responding: false, status: 0, data: null }));
  });
}

async function webHealthy() {
  const h = await httpGetJson(WEB_PORT, '/health', 1500);
  return !!(h.responding && h.data && h.data.ok === true && h.data.server === WEB_IDENTITY);
}

/* True when ANY process is bound to the web port (regardless of identity). */
function portListening(port) {
  return new Promise(resolve => {
    const sock = net.connect({ host: HOST, port: port, timeout: 800 });
    let done = false;
    const finish = ok => { if (done) return; done = true; try { sock.destroy(); } catch (e) { } resolve(!!ok); };
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

async function webServerState() {
  if (await webHealthy()) return 'healthy';
  if (await portListening(WEB_PORT)) return 'conflict';
  return 'down';
}

/* ── Services detection ── */

function servicesStatus() {
  return new Promise(resolve => {
    execFile(process.execPath, [RUNNER, '--json'], { cwd: ROOT, timeout: 8000 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const parsed = JSON.parse(String(stdout || ''));
        resolve(Array.isArray(parsed.services) ? parsed.services : []);
      } catch (e) { resolve([]); }
    });
  });
}

function servicesHealthy(rows) {
  const bridge = (rows || []).find(r => r && r.name === 'Bridge');
  const active = (rows || []).find(r => r && r.name === 'Active');
  return !!(bridge && bridge.online && active && active.online);
}

function managerProcessRunning() {
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'local-services-runner' } | Measure-Object | Select-Object -ExpandProperty Count"],
      { windowsHide: true, timeout: 6000 }, (err, stdout) => {
        if (err) { resolve(false); return; }
        try { resolve(parseInt(String(stdout || '').trim(), 10) > 0); } catch (e) { resolve(false); }
      });
  });
}

async function managerState() {
  const rows = await servicesStatus();
  if (servicesHealthy(rows)) return { state: 'healthy', rows: rows };
  if (await managerProcessRunning()) return { state: 'starting', rows: rows };
  return { state: 'down', rows: rows };
}

/* ── Start (idempotent — only called when state is 'down') ── */

function startManager() {
  log('Starting local services manager (Bridge + Active)…');
  spawn(process.execPath, [RUNNER], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore'
  }).unref();
}

function startWebServer() {
  log('Starting InternalBeyond web server on ' + HOST + ':' + WEB_PORT + '…');
  spawn(process.execPath, [WEB_SERVER], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore'
  }).unref();
}

async function waitFor(probe, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  const step = intervalMs || POLL_MS;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(step);
  }
  return false;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function openBrowser(url) {
  if (process.env.IB_LAUNCH_NO_OPEN === '1') { log('[test] browser open suppressed (IB_LAUNCH_NO_OPEN=1)'); return; }
  log('Opening ' + url);
  spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
}

/* ── Orchestration ── */

async function main(opts) {
  const o = opts || {};
  const silent = !!o.silent; /* test mode: no console noise */
  const say = silent ? function () { } : log;

  /* 1. Services */
  let st = await managerState();
  say('Services state: ' + st.state + ' (Bridge/Active).');
  if (st.state === 'down') {
    startManager();
    await sleep(1500);
  }
  const servicesReady = await waitFor(async () => servicesHealthy(await servicesStatus()), o.servicesTimeout || SERVICES_TIMEOUT_MS, POLL_MS);
  if (!servicesReady) {
    const rows = await servicesStatus();
    const detail = rows.map(r => r.name + '=' + (r.conflict ? 'conflict' : (r.online ? 'online' : 'offline'))).join(', ');
    errorBox('Local services did not become healthy. ' + (detail || '') + '. Check ' + LOG_DIR + '\\*.log');
    return { ok: false, reason: 'services', detail: detail };
  }
  say('Services healthy.');

  /* 2. Web server */
  const webState = await webServerState();
  say('Web server state: ' + webState + '.');
  if (webState === 'conflict') {
    errorBox('Port ' + WEB_PORT + ' is occupied by another process (not an InternalBeyond web server). Free the port and retry.');
    return { ok: false, reason: 'web-conflict' };
  }
  if (webState === 'down') {
    startWebServer();
    await sleep(500);
  }
  const webReady = await waitFor(webHealthy, o.webTimeout || WEB_TIMEOUT_MS, POLL_MS);
  if (!webReady) {
    errorBox('The InternalBeyond web server did not become ready on ' + HOST + ':' + WEB_PORT + '. See ' + LOG_FILE);
    return { ok: false, reason: 'web' };
  }
  say('Web server healthy.');

  /* 3. Open browser (only when everything is ready) */
  if (!o.noOpen) openBrowser(o.url || WEB_URL);
  return { ok: true, url: o.url || WEB_URL };
}

if (require.main === module) {
  main().then(result => {
    if (!result.ok) process.exit(1);
    process.exit(0);
  }).catch(err => {
    errorBox('Launcher failed: ' + String(err && err.stack || err));
    process.exit(1);
  });
}

module.exports = {
  ROOT: ROOT,
  HOST: HOST,
  WEB_PORT: WEB_PORT,
  WEB_URL: WEB_URL,
  WEB_IDENTITY: WEB_IDENTITY,
  LOG_FILE: LOG_FILE,
  optionPort: optionPort,
  httpGetJson: httpGetJson,
  webHealthy: webHealthy,
  portListening: portListening,
  webServerState: webServerState,
  servicesStatus: servicesStatus,
  servicesHealthy: servicesHealthy,
  managerProcessRunning: managerProcessRunning,
  managerState: managerState,
  main: main,
  sleep: sleep
};
