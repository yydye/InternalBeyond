'use strict';

/*
 * Internal Beyond · zero-command Windows launcher.
 *
 * Double-click "Start Internal Beyond.cmd" / "启动 InternalBeyond.vbs" → this
 * Node process:
 *   1. Detects whether the local services (Bridge + Active) are already healthy
 *      via their real health endpoints (runner --json), falling back to a
 *      process-presence probe for the "starting but not ready" case.
 *   2. Starts the services manager ONLY when nothing healthy/starting is present
 *      (never a second copy when already healthy).
 *   3. Bounded-polls readiness. Optional services that do not come up are
 *      recorded as DEGRADED — they never prevent the main UI from opening.
 *   4. Detects / reuses / starts the static web server on 127.0.0.1:23120.
 *      The static layer is the ONLY fatal dependency: without it there is no UI.
 *   5. Writes a machine-readable launch record (boot-state.json) so diagnostics
 *      can report what was normal, what was degraded, and why.
 *   6. Opens http://127.0.0.1:23120/InternalBeyond.html.
 *   7. Fatal only when the main UI genuinely cannot be served — and then it
 *      never opens a broken URL.
 *
 * No second Chat / Memory / Tool / Voice runtime is created; the web server only
 * serves the existing static app so browser APIs (AudioWorklet) run on localhost.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const bootState = require('./boot-state.js');
const productVersion = require('./product-version.js');

/* Repository root == installed app root. This file lives in runtime/, so the
   root is one level up; the runner is a sibling, the static server lives in
   services/, and runtime/node + logs stay directly under the root. */
const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const WEB_PORT = optionPort('IB_WEB_PORT', 23120);
const WEB_URL = 'http://' + HOST + ':' + WEB_PORT + '/InternalBeyond.html';
const WEB_IDENTITY = 'InternalBeyond Web';
const RUNNER = path.join(__dirname, 'local-services-runner.js');
const WEB_SERVER = path.join(ROOT, 'services', 'internal-beyond-server.js');

const BRIDGE_PORT = optionPort('IB_BRIDGE_PORT', 23115);
const ACTIVE_PORT = optionPort('IB_ACTIVE_PORT', 23114);
const RESTART_PORT = optionPort('IB_RESTART_PORT', 23116);
const RESTART_IDENTITY = 'InternalBeyond Restart';
const VISION_PORT = optionPort('IB_VISION_PORT', 8765);
const NODE_REQUIRED_MAJOR = 18;

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
function errorBox(msg, opts) {
  log('[ERROR] ' + msg);
  const o = opts || {};
  /* Test / headless mode suppresses every native dialog (no window may appear). */
  if (o.noOpen || o.suppressDialogs || process.env.IB_LAUNCH_NO_OPEN === '1') return;
  try {
    const script = "Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.MessageBox]::Show(" +
      JSON.stringify(String(msg).slice(0, 1200)) + ",'Internal Beyond Launcher')";
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      windowsHide: true, detached: true, stdio: 'ignore'
    }).unref();
  } catch (e) { }
}

/* ── Runtime identity (P1 bundled Node) ── */

/* Product version (P7): read once from the single source file. Never fatal —
   diagnostics must stay honest and simply omit the row when unreadable. */
function productInfo() {
  const v = productVersion.get();
  return { version: v.ok ? v.version : '', source: v.source };
}

function nodeRuntimeInfo() {
  const bundledPath = path.join(ROOT, 'runtime', 'node', 'node.exe');
  const exe = path.resolve(process.execPath);
  const envNode = String(process.env.IB_NODE || '').trim();
  let source = 'PATH';
  if (envNode && path.resolve(envNode) === exe) source = 'IB_NODE';
  else if (exe.toLowerCase() === path.resolve(bundledPath).toLowerCase()) source = 'bundled';
  return {
    path: exe,
    version: process.version,
    source: source,
    bundled: exe.toLowerCase() === path.resolve(bundledPath).toLowerCase(),
    requiredMajor: NODE_REQUIRED_MAJOR,
    ok: Number(String(process.version).replace(/^v/, '').split('.')[0]) >= NODE_REQUIRED_MAJOR
  };
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

/* The main UI document must actually be servable — an identity-correct server
   that cannot serve InternalBeyond.html still means "no UI". */
async function webUiDocumentReady() {
  const h = await httpGetJson(WEB_PORT, '/InternalBeyond.html', 2500);
  return !!(h.responding && h.status === 200);
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

/* Same probe, but keeps the failure reason so boot-state can say WHY it is
   unknown instead of pretending the services are offline. */
function probeServices() {
  return new Promise(resolve => {
    execFile(process.execPath, [RUNNER, '--json'], { cwd: ROOT, timeout: 8000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, rows: [], error: { category: bootState.REASON.RUNNER_UNAVAILABLE, message: 'local-services-runner.js --json failed: ' + String(err.message || err).slice(0, 200) } });
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout || ''));
        if (!parsed || !Array.isArray(parsed.services)) throw new Error('missing services array');
        resolve({ ok: true, rows: parsed.services, error: null });
      } catch (e) {
        resolve({ ok: false, rows: [], error: { category: bootState.REASON.RUNNER_UNAVAILABLE, message: 'unparsable runner status: ' + String(e.message || e).slice(0, 200) } });
      }
    });
  });
}

function servicesHealthy(rows) {
  const bridge = (rows || []).find(r => r && r.name === 'Bridge');
  const active = (rows || []).find(r => r && r.name === 'Active');
  return !!(bridge && bridge.online && active && active.online);
}

/* A services manager counts only when its command line names THIS install root.
   A second InternalBeyond — or a developer checkout — may legitimately run its
   own runner on its own ports; treating it as ours would leave our Bridge/Active
   unstarted and the launch degraded. */
function managerProcessRunning() {
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'local-services-runner' } | Select-Object -ExpandProperty CommandLine"],
      { windowsHide: true, timeout: 6000 }, (err, stdout) => {
        if (err) { resolve(false); return; }
        const root = path.resolve(ROOT).toLowerCase().replace(/\//g, '\\');
        const lines = String(stdout || '').split(/\r?\n/)
          .map(s => s.trim().toLowerCase().replace(/\//g, '\\'))
          .filter(Boolean);
        resolve(lines.some(cl => cl.indexOf(root) >= 0));
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
  try {
    spawn(process.execPath, [RUNNER], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore'
    }).unref();
    return { ok: true, error: null };
  } catch (e) {
    const message = 'could not spawn local-services-runner.js: ' + String(e && e.message || e).slice(0, 200);
    log('[WARN] ' + message);
    return { ok: false, error: { category: bootState.REASON.SPAWN_FAILED, message: message } };
  }
}

function startWebServer() {
  log('Starting InternalBeyond web server on ' + HOST + ':' + WEB_PORT + '…');
  try {
    spawn(process.execPath, [WEB_SERVER], {
      cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore'
    }).unref();
    return { ok: true, error: null };
  } catch (e) {
    const message = 'could not spawn internal-beyond-server.js: ' + String(e && e.message || e).slice(0, 200);
    log('[WARN] ' + message);
    return { ok: false, error: { category: bootState.REASON.SPAWN_FAILED, message: message } };
  }
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

/* UI URL: the static document plus the product version as a query parameter, so
   the in-app Guide can show the real version from the single source (VERSION)
   without any runtime request. The app routes on the hash only, so an extra
   query parameter is inert. */
function uiUrl() {
  const pv = productInfo();
  return pv.version ? (WEB_URL + '?ibv=' + encodeURIComponent(pv.version)) : WEB_URL;
}

function openBrowser(url, opts) {
  const o = opts || {};
  if (o.noOpen || process.env.IB_LAUNCH_NO_OPEN === '1') {
    log('[test] browser open suppressed (IB_LAUNCH_NO_OPEN=1)');
    return false;
  }
  log('Opening ' + url);
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) {
    log('[WARN] could not open the browser: ' + String(e && e.message || e));
    return false;
  }
}

/* ── Optional components (never fatal) ── */

function serviceComponent(name, row, opts) {
  const o = opts || {};
  const port = o.port;
  const spec = {
    required: false,
    affectsOverall: true,
    probed: true,
    healthy: false,
    state: bootState.REASON.UNKNOWN,
    port: port
  };
  if (!row) {
    spec.state = bootState.REASON.UNKNOWN;
    spec.reason = {
      category: bootState.REASON.PROBE_FAILED,
      message: name + ' status could not be read from the local services runner'
    };
    return spec;
  }
  if (row.version) spec.version = String(row.version);
  if (row.online) {
    spec.healthy = true;
    spec.state = 'healthy';
    return spec;
  }
  if (row.conflict) {
    spec.state = 'conflict';
    spec.reason = {
      category: bootState.REASON.CONFLICT,
      message: 'port ' + port + ' answered but is not ' + name
    };
    return spec;
  }
  spec.state = 'offline';
  spec.reason = o.waitedMs
    ? { category: bootState.REASON.TIMEOUT, message: name + ' did not answer /health within ' + o.waitedMs + 'ms' }
    : { category: bootState.REASON.OFFLINE, message: name + ' is not answering /health on port ' + port };
  return spec;
}

async function probeRestartPlane() {
  const spec = {
    required: false,
    affectsOverall: false, /* informational: the UI restart button is optional */
    probed: true,
    healthy: false,
    state: bootState.REASON.UNKNOWN,
    port: RESTART_PORT
  };
  const h = await httpGetJson(RESTART_PORT, '/status', 1200);
  if (h.responding && h.data && h.data.service === RESTART_IDENTITY) {
    spec.healthy = true;
    spec.state = 'healthy';
    spec.controlState = String(h.data.state || '');
    return spec;
  }
  if (h.responding) {
    spec.state = 'conflict';
    spec.reason = { category: bootState.REASON.CONFLICT, message: 'port ' + RESTART_PORT + ' answered but is not the Internal Beyond restart control plane' };
    return spec;
  }
  spec.state = 'offline';
  spec.reason = { category: bootState.REASON.OFFLINE, message: 'restart control plane is not running on port ' + RESTART_PORT };
  return spec;
}

/*
 * Attempts to bring Bridge + Active up, then reports their REAL state.
 * Returns { bridge, active, restart, manager, warnings }.
 * This function never throws and never fails the launch.
 */
async function ensureServices(opts) {
  const o = opts || {};
  const timeout = o.servicesTimeout || SERVICES_TIMEOUT_MS;
  const warnings = [];
  const manager = { state: 'unknown', started: false, wasRunning: false, error: null };

  const first = await probeServices();
  if (first.error) warnings.push({ code: first.error.category, message: first.error.message });
  const alreadyHealthy = servicesHealthy(first.rows);

  let waitedMs = 0;
  if (!alreadyHealthy) {
    manager.wasRunning = await managerProcessRunning();
    manager.state = manager.wasRunning ? 'starting' : 'down';
    if (!manager.wasRunning) {
      const started = startManager();
      manager.started = started.ok;
      if (!started.ok) {
        manager.error = started.error;
        warnings.push({ code: started.error.category, message: started.error.message });
      }
      await sleep(1500);
    }
    const t0 = Date.now();
    await waitFor(async () => servicesHealthy(await servicesStatus()), timeout, POLL_MS);
    waitedMs = Date.now() - t0;
    if (waitedMs >= timeout) waitedMs = timeout;
  }

  const finalProbe = await probeServices();
  if (finalProbe.error && !warnings.some(w => w.code === finalProbe.error.category)) {
    warnings.push({ code: finalProbe.error.category, message: finalProbe.error.message });
  }
  const rows = finalProbe.rows;
  const rowFor = name => rows.find(r => r && r.name === name) || null;

  const bridge = serviceComponent('Bridge', rowFor('Bridge'), { port: BRIDGE_PORT, waitedMs: waitedMs });
  const active = serviceComponent('Active', rowFor('Active'), { port: ACTIVE_PORT, waitedMs: waitedMs });
  if (!manager.wasRunning && !manager.started && (bridge.state === 'offline' || active.state === 'offline')) {
    manager.state = 'down';
  }

  const restart = await probeRestartPlane();

  return { bridge: bridge, active: active, restart: restart, manager: manager, warnings: warnings, waitedMs: waitedMs };
}

/* ── Static layer (the ONLY fatal dependency) ── */

async function ensureWebServer(opts) {
  const o = opts || {};
  const base = {
    required: true,
    affectsOverall: true,
    probed: true,
    healthy: false,
    state: bootState.REASON.UNKNOWN,
    host: HOST,
    port: WEB_PORT,
    url: WEB_URL,
    identity: WEB_IDENTITY
  };
  const fatal = (state, reason, wasReused) => ({
    component: Object.assign({}, base, { state: state, reused: wasReused === true, reason: reason }),
    fatalCategory: reason.category,
    fatalMessage: reason.message
  });

  const state = await webServerState();
  if (state === 'conflict') {
    return fatal('conflict', {
      category: bootState.REASON.PORT_CONFLICT,
      message: 'Port ' + WEB_PORT + ' is occupied by another process (not an InternalBeyond web server).'
    });
  }
  const reused = state === 'healthy';
  if (state === 'down') {
    const started = startWebServer();
    if (!started.ok) {
      return fatal('offline', {
        category: bootState.REASON.STATIC_UNAVAILABLE,
        message: 'The InternalBeyond web server could not be started: ' + started.error.message
      });
    }
    await sleep(500);
  }

  const ready = await waitFor(webHealthy, o.webTimeout || WEB_TIMEOUT_MS, POLL_MS);
  if (!ready) {
    return fatal('offline', {
      category: bootState.REASON.STATIC_UNAVAILABLE,
      message: 'The InternalBeyond web server did not become ready on ' + HOST + ':' + WEB_PORT + '.'
    });
  }
  if (!(await webUiDocumentReady())) {
    return fatal('error', {
      category: bootState.REASON.UI_DOCUMENT_UNAVAILABLE,
      message: 'The web server is running but InternalBeyond.html could not be served.'
    }, reused);
  }
  return {
    component: Object.assign({}, base, { healthy: true, state: 'healthy', reused: reused, reason: null }),
    fatalCategory: null,
    fatalMessage: null
  };
}

/* ── Orchestration ── */

function buildState(bootId, phase, ctx, extra) {
  return bootState.buildBootState(Object.assign({
    bootId: bootId,
    now: Date.now(),
    phase: phase,
    opened: false,
    fatal: null,
    launcher: {
      pid: process.pid,
      startedAt: ctx.startedAt,
      finishedAt: Date.now(),
      root: ROOT,
      platform: process.platform,
      arch: process.arch,
      product: productInfo(),
      node: nodeRuntimeInfo(),
      serviceManager: ctx.serviceManager || null
    },
    components: ctx.components,
    warnings: ctx.warnings,
    staleAfterMs: Number(process.env.IB_BOOT_STATE_STALE_MS) || undefined
  }, extra || {}));
}

function persistBootState(state, opts) {
  const o = opts || {};
  const written = bootState.writeBootState(state, { dir: o.stateDir, file: o.stateFile });
  if (!written.ok) {
    /* Writing diagnostics must never take down a working launch. */
    log('[WARN] boot-state write failed (' + written.error.category + ': ' + written.error.message + ') at ' + written.path + ' — continuing');
  }
  return written;
}

async function main(opts) {
  const o = opts || {};
  const silent = !!o.silent; /* test mode: no console noise */
  const say = silent ? function () { } : log;
  const startedAt = Date.now();
  const bootId = bootState.newBootId(startedAt);
  const warnings = [];
  const components = {
    static: { required: true, affectsOverall: true, probed: false, healthy: false, state: bootState.REASON.UNKNOWN, host: HOST, port: WEB_PORT, url: WEB_URL, identity: WEB_IDENTITY },
    bridge: { required: false, affectsOverall: true, probed: false, healthy: false, state: bootState.REASON.UNKNOWN, port: BRIDGE_PORT },
    active: { required: false, affectsOverall: true, probed: false, healthy: false, state: bootState.REASON.UNKNOWN, port: ACTIVE_PORT },
    restart: { required: false, affectsOverall: false, probed: false, healthy: false, state: bootState.REASON.UNKNOWN, port: RESTART_PORT },
    vision: {
      required: false,
      affectsOverall: false,
      probed: false,
      healthy: false,
      state: bootState.REASON.NOT_ENABLED,
      port: VISION_PORT,
      reason: { category: bootState.REASON.NOT_ENABLED, message: 'Vision is an optional extra and is not started by the launcher' }
    }
  };
  const ctx = { startedAt: startedAt, components: components, warnings: warnings, serviceManager: null };

  const write = (phase, extra) => {
    const state = buildState(bootId, phase, ctx, extra);
    return { state: state, written: persistBootState(state, o) };
  };

  /* 0. Immediately invalidate any previous launch record, so a stale
        boot-state can never be mistaken for this launch even if we crash. */
  write('starting');

  try {
    /* 1. Optional local services — degraded on failure, never fatal. */
    const services = await ensureServices(o);
    components.bridge = services.bridge;
    components.active = services.active;
    components.restart = services.restart;
    for (const w of services.warnings) if (!warnings.some(x => x.code === w.code)) warnings.push(w);
    ctx.serviceManager = services.manager;
    say('Services state: Bridge=' + components.bridge.state + ', Active=' + components.active.state +
      ', manager=' + services.manager.state + '.');

    /* 2. Static layer — the only thing that can be fatal. */
    const web = await ensureWebServer(o);
    components.static = web.component;
    if (!web.component.healthy) {
      const fatal = { category: web.fatalCategory, message: web.fatalMessage };
      const finalState = write('complete', { fatal: fatal, opened: false });
      errorBox(web.fatalMessage + ' See ' + LOG_FILE, o);
      return {
        ok: false,
        reason: web.fatalCategory,
        overall: finalState.state.overall,
        url: null,
        bootState: finalState.state,
        bootStateWrite: finalState.written
      };
    }
    say('Web server healthy (reused=' + !!web.component.reused + ').');

    /* 3. Open the main UI — the static layer is serving it. */
    const url = o.url || uiUrl();
    const opened = openBrowser(url, o);

    /* 4. Final launch record. */
    const finalState = write('complete', { opened: opened });
    const overall = finalState.state.overall;
    if (overall === bootState.OVERALL.DEGRADED) {
      say('Degraded launch: ' + finalState.state.degradedReasons.map(r => r.component + '=' + r.category).join(', '));
    } else {
      say('Launch state: ' + overall + '.');
    }
    return {
      ok: true,
      url: url,
      opened: opened,
      overall: overall,
      degraded: finalState.state.degraded,
      degradedReasons: finalState.state.degradedReasons,
      bootState: finalState.state,
      bootStateWrite: finalState.written
    };
  } catch (err) {
    /* An unexpected launcher bug is fatal (no UI was served) — but it must still
       leave an honest record instead of a stranded 'starting' entry. */
    const message = 'Launcher error: ' + String(err && err.stack || err).slice(0, 600);
    const finalState = write('complete', {
      fatal: { category: bootState.REASON.LAUNCHER_ERROR, message: message },
      opened: false
    });
    errorBox(message + ' See ' + LOG_FILE, o);
    return {
      ok: false,
      reason: bootState.REASON.LAUNCHER_ERROR,
      overall: finalState.state.overall,
      url: null,
      bootState: finalState.state,
      bootStateWrite: finalState.written
    };
  }
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
  BRIDGE_PORT: BRIDGE_PORT,
  ACTIVE_PORT: ACTIVE_PORT,
  RESTART_PORT: RESTART_PORT,
  VISION_PORT: VISION_PORT,
  optionPort: optionPort,
  nodeRuntimeInfo: nodeRuntimeInfo,
  httpGetJson: httpGetJson,
  webHealthy: webHealthy,
  webUiDocumentReady: webUiDocumentReady,
  portListening: portListening,
  webServerState: webServerState,
  servicesStatus: servicesStatus,
  probeServices: probeServices,
  servicesHealthy: servicesHealthy,
  managerProcessRunning: managerProcessRunning,
  managerState: managerState,
  ensureServices: ensureServices,
  ensureWebServer: ensureWebServer,
  openBrowser: openBrowser,
  bootStateFile: bootState.stateFile,
  main: main,
  sleep: sleep
};
