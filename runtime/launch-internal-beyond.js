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
 *   4. Detects / reuses / starts the static web server on 127.0.0.1 (port from
 *      the component registry: IB_WEB_PORT, default 23120).
 *   5. Writes a machine-readable launch record (boot-state.json) so diagnostics
 *      can report what was normal, what was degraded, and why.
 *   6. Opens the main UI document on that port.
 *   7. Fatal only when the main UI genuinely cannot be served — and then it
 *      never opens a broken URL.
 *
 * No second Chat / Memory / Tool / Voice runtime is created; the web server only
 * serves the existing static app so browser APIs (AudioWorklet) run on localhost.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const bootState = require('./boot-state.js');
const productVersion = require('./product-version.js');
/* P11-3B：端口、身份探针与组件轴来自组件注册表 —— 启动器不再自己维护第二份
   组件清单（那份清单里从来没有 Home Node，所以启动记录结构性地无法描述它）。 */
const registry = require('./component-registry.js');

/* Repository root == installed app root. This file lives in runtime/, so the
   root is one level up; the runner is a sibling, the static server lives in
   services/, and runtime/node + logs stay directly under the root. */
const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const WEB_PORT = registry.portOf('static');
const WEB_URL = 'http://' + HOST + ':' + WEB_PORT + '/InternalBeyond.html';
const WEB_IDENTITY = registry.byId('static').identity.server;
const RUNNER = path.join(__dirname, 'local-services-runner.js');
const WEB_SERVER = path.join(ROOT, 'services', 'internal-beyond-server.js');

const BRIDGE_PORT = registry.portOf('bridge');
const ACTIVE_PORT = registry.portOf('active');
const HOME_NODE_PORT = registry.portOf('homeNode');
const RESTART_PORT = registry.portOf('restart');
const RESTART_IDENTITY = registry.byId('restart').identity.service;
const VISION_PORT = registry.portOf('vision');
const NODE_REQUIRED_MAJOR = 18;

/* Runtime-generated logs belong to the per-user data root, not the replaceable
   install payload. Installer diagnostics keep their own bounded installer log
   contract; this path is only for the running launcher. */
const LOCAL_DIR = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
  : path.join(os.homedir(), '.internal-beyond');
const LOG_DIR = path.join(LOCAL_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'launcher.log');

const SERVICES_TIMEOUT_MS = Number(process.env.IB_LAUNCH_SERVICES_TIMEOUT_MS) || 25000;
const WEB_TIMEOUT_MS = Number(process.env.IB_LAUNCH_WEB_TIMEOUT_MS) || 15000;
const POLL_MS = 800;

/* Port resolution used to live here as its own `optionPort()`. It now lives in
   the component registry (registry.portOf), so the launcher, the runner and the
   server cannot disagree about which environment variable and which default a
   port comes from. `registry.portOfEnv` is exported for the parts of the product
   that name a port without naming a component. */

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

function payloadManifestInfo() {
  const file = path.join(ROOT, 'ib-payload-manifest.json');
  if (!fs.existsSync(file)) return { version: null, identity: null };
  try {
    const raw = fs.readFileSync(file);
    const parsed = JSON.parse(raw.toString('utf8'));
    return {
      version: Number.isInteger(parsed && parsed.version) ? parsed.version : null,
      identity: crypto.createHash('sha256').update(raw).digest('hex')
    };
  } catch (_) {
    return { version: null, identity: null };
  }
}

function runtimeIdentity() {
  const manifest = payloadManifestInfo();
  const explicitMode = String(process.env.IB_RUNTIME_MODE || '').trim().toLowerCase();
  const mode = ['production', 'acceptance', 'development'].includes(explicitMode)
    ? explicitMode
    : (manifest.identity ? 'production' : (process.env.IB_TAURI_HOST === '1' ? 'acceptance' : 'development'));
  const rootClass = String(process.env.IB_RUNTIME_ROOT_CLASS || '').trim() || {
    production: 'canonical-inno',
    acceptance: 'tauri-resource',
    development: 'workspace'
  }[mode] || 'unknown';
  const product = String(process.env.IB_RUNTIME_PRODUCT_VERSION || '').trim() || productInfo().version;
  const manifestVersion = String(process.env.IB_RUNTIME_PAYLOAD_MANIFEST_VERSION || '').trim();
  const payloadIdentity = String(process.env.IB_RUNTIME_PAYLOAD_IDENTITY || '').trim() || manifest.identity;
  return {
    runtimeMode: mode,
    runtimeRootClass: rootClass,
    productVersion: product,
    payloadManifestVersion: manifestVersion ? Number(manifestVersion) : manifest.version,
    payloadIdentity: payloadIdentity || null,
    hostRoot: ROOT,
    runnerRootClass: rootClass,
    serviceRootClass: rootClass
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

/* "The services manager has done its job" is defined by the registry, not by a
   hand-written pair of names: every component marked healthyRequiredForServices
   must be online. Home Node is deliberately NOT one of them — the desktop UI
   works without it, so its absence must not make the launcher wait, and must not
   make it start a second runner while the existing one is doing fine. */
function servicesHealthy(rows) {
  const required = registry.requiredForServices();
  if (!required.length) return false;
  return required.every(c => {
    const row = (rows || []).find(r => r && r.name === c.name);
    return !!(row && row.online);
  });
}

/* Registry rows, as the runner reports them, keyed by component id. */
function rowForComponent(rows, component) {
  return (rows || []).find(r => r && (r.componentId === component.id || r.name === component.name)) || null;
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

/* Build one boot-record component from a runner status row. The port and the
   "what counts as healthy" predicate come from the registry; this function only
   decides how to WORD a failure, using boot-state's frozen reason vocabulary. */
function serviceComponent(component, row, opts) {
  const o = opts || {};
  const port = o.port;
  const spec = {
    required: component.required === true,
    affectsOverall: component.affectsOverall === true,
    probed: true,
    healthy: false,
    state: bootState.REASON.UNKNOWN,
    port: port
  };
  if (!row) {
    spec.state = bootState.REASON.UNKNOWN;
    spec.reason = {
      category: bootState.REASON.PROBE_FAILED,
      message: component.name + ' status could not be read from the local services runner'
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
      message: 'port ' + port + ' answered but is not ' + component.label + ' (' + component.name + ')'
    };
    return spec;
  }
  spec.state = 'offline';
  spec.reason = o.waitedMs
    ? { category: bootState.REASON.TIMEOUT, message: component.name + ' did not answer ' + component.healthPath + ' within ' + o.waitedMs + 'ms' }
    : { category: bootState.REASON.OFFLINE, message: component.name + ' is not answering ' + component.healthPath + ' on port ' + port };
  return spec;
}

async function probeRestartPlane() {
  const restartComponent = registry.byId('restart');
  const spec = {
    required: restartComponent.required === true,
    affectsOverall: restartComponent.affectsOverall === true,
    probed: true,
    healthy: false,
    state: bootState.REASON.UNKNOWN,
    port: RESTART_PORT
  };
  const h = await httpGetJson(RESTART_PORT, restartComponent.healthPath, 1200);
  if (h.responding && h.data && h.data.service === RESTART_IDENTITY) {
    spec.healthy = true;
    spec.state = 'healthy';
    spec.controlState = String(h.data.state || '');
    return spec;
  }
  if (h.responding) {
    spec.state = 'conflict';
    spec.reason = { category: bootState.REASON.CONFLICT, message: 'port ' + RESTART_PORT + ' answered but is not ' + restartComponent.label };
    return spec;
  }
  spec.state = 'offline';
  spec.reason = { category: bootState.REASON.OFFLINE, message: restartComponent.label + ' is not running on port ' + RESTART_PORT };
  return spec;
}

/*
 * Attempts to bring the registry's managed services up, then reports their REAL
 * state — including Home Node, which the launcher had no way to report before
 * P11-3B. Returns { components, manager, warnings }.
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

  /* One component per registry entry the runner manages (plus the restart plane,
     which lives inside the runner process). A component the run did not register
     at all — Vision without --vision — is reported as not-enabled, never as an
     outage of something the user never asked for. */
  const components = {};
  const managedRows = [];
  for (const component of registry.managed()) {
    const row = rowForComponent(rows, component);
    if (!row) {
      if (component.id === 'vision') {
        components[component.id] = {
          required: false,
          affectsOverall: component.affectsOverall === true,
          probed: false,
          healthy: false,
          state: bootState.REASON.NOT_ENABLED,
          port: registry.portOf(component.id),
          reason: { category: bootState.REASON.NOT_ENABLED, message: 'Vision is an optional extra and is not started by the launcher' }
        };
      } else {
        components[component.id] = serviceComponent(component, null, { port: registry.portOf(component.id) });
      }
      continue;
    }
    components[component.id] = serviceComponent(component, row, { port: component.defaultPort, waitedMs: waitedMs });
    managedRows.push(row);
  }

  if (!manager.wasRunning && !manager.started && managedRows.every(r => r.online !== true)) {
    manager.state = 'down';
  }

  components.restart = await probeRestartPlane();

  return { components: components, manager: manager, warnings: warnings, waitedMs: waitedMs };
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
      serviceManager: ctx.serviceManager || null,
      runtime: runtimeIdentity()
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
  /* The component axis comes from the registry (P11-3B). The static layer keeps
     its launcher-specific detail (host/url/identity) on top. */
  const components = bootState.initialComponentRecords();
  components.static = Object.assign(components.static, {
    required: true,
    affectsOverall: true,
    host: HOST,
    port: WEB_PORT,
    url: WEB_URL,
    identity: WEB_IDENTITY
  });
  const ctx = { startedAt: startedAt, components: components, warnings: warnings, serviceManager: null };

  const write = (phase, extra) => {
    const state = buildState(bootId, phase, ctx, extra);
    return { state: state, written: persistBootState(state, o) };
  };

  /* 0. Immediately invalidate any previous launch record, so a stale
        boot-state can never be mistaken for this launch even if we crash. */
  write('starting');

  try {
    /* 1. Local services — degraded on failure, never fatal. Every registry
          component the runner manages is recorded, including Home Node. */
    const services = await ensureServices(o);
    for (const id of Object.keys(services.components)) components[id] = services.components[id];
    for (const w of services.warnings) if (!warnings.some(x => x.code === w.code)) warnings.push(w);
    ctx.serviceManager = services.manager;
    say('Services state: ' + registry.managed().map(c => c.name + '=' + (components[c.id] ? components[c.id].state : 'unknown')).join(', ') +
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
  HOME_NODE_PORT: HOME_NODE_PORT,
  RESTART_PORT: RESTART_PORT,
  VISION_PORT: VISION_PORT,
  nodeRuntimeInfo: nodeRuntimeInfo,
  runtimeIdentity: runtimeIdentity,
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
