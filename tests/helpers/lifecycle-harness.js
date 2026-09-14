'use strict';

/*
 * P11-3H · lifecycle test harness
 *
 * Shared plumbing for tests/test_p11_3h_lifecycle_gate.js and its mutation
 * runner. Nothing here decides anything about stopping: it only spawns private
 * processes on private ports with private data directories, and provides the
 * small amount of waiting/HTTP that the assertions need.
 *
 * TWO HARD RULES, both learned from measurements in this phase:
 *
 *   1. Never touch a default port (23114/23115/23116/23118/23120), never touch
 *      a process this harness did not spawn, and never write outside its own
 *      temp directory. The product ports may belong to a developer instance or
 *      to another installation.
 *   2. Never capture a child's output through a pipe. A child spawned with
 *      `stdio: ['ignore','pipe','pipe']` cannot be read in this environment —
 *      the harness boundary refuses the named pipe, and the observable symptom
 *      is an EMPTY capture that looks exactly like "the component said nothing".
 *      Every child here writes to a log FILE, and assertions read that file.
 */

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

/* This file lives in tests/helpers/, so the repository root is two levels up. */
const ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + (timeoutMs || 10000);
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return true;
    if (Date.now() > end) return false;
    await sleep(stepMs || 120);
  }
}

function get(port, p, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs || 1500 }, res => {
        let raw = ''; res.setEncoding('utf8');
        res.on('data', c => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) { } done({ status: res.statusCode, json: j, raw: raw }); });
      });
    } catch (e) { done({ status: 0, error: String(e && e.message || e) }); return; }
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } done({ status: 0, error: 'timeout' }); });
    req.on('error', e => done({ status: 0, error: String((e && e.code) || e) }));
    req.end();
  });
}

function postJson(port, p, body, headers) {
  return new Promise(resolve => {
    const raw = Buffer.from(JSON.stringify(body || {}), 'utf8');
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.request({
        host: '127.0.0.1', port, path: p, method: 'POST', timeout: 5000,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': raw.length }, headers || {})
      }, res => {
        let out = ''; res.setEncoding('utf8');
        res.on('data', c => { out += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (e) { } done({ status: res.statusCode, json: j, raw: out }); });
      });
    } catch (e) { done({ status: 0, error: String(e && e.message || e) }); return; }
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } done({ status: 0, error: 'timeout' }); });
    req.on('error', e => done({ status: 0, error: String((e && e.code) || e) }));
    req.end(raw);
  });
}

function post(port, p, headers) {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 5000, headers: headers || {} }, res => {
        let raw = ''; res.setEncoding('utf8');
        res.on('data', c => { raw += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) { } done({ status: res.statusCode, json: j, raw: raw }); });
      });
    } catch (e) { done({ status: 0, error: String(e && e.message || e) }); return; }
    req.on('timeout', () => { try { req.destroy(); } catch (e) { } done({ status: 0, error: 'timeout' }); });
    req.on('error', e => done({ status: 0, error: String((e && e.code) || e) }));
    req.end();
  });
}

function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function forceKill(pid) {
  try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(Number(pid))], { windowsHide: true, stdio: 'ignore' }); }
  catch (e) { /* already gone */ }
}

/*
 * A lifecycle harness: owns a temp root, the children it started, and the log
 * files they write to.
 */
/* Fixtures live INSIDE the checkout on purpose.
 *
 * The installer helper decides ownership by asking whether a process's command
 * line / executable path lives inside the install root it was given (`--root`).
 * A fixture spawned from `%TEMP%` is therefore correctly reported as
 * UNKNOWN_OWNER — the rule works, but a test that spawns there cannot exercise a
 * successful stop through the helper at all. `tests/.tmp/` puts the fixture
 * inside the root the suite passes, which is the shape a real install has.
 * It is gitignored and removed by the suite itself. */
const FIXTURE_BASE = path.join(ROOT, 'tests', '.tmp');

function createHarness(name) {
  fs.mkdirSync(FIXTURE_BASE, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(FIXTURE_BASE, 'ib-3h-' + name + '-'));
  const tracked = new Set();
  const logs = new Map();

  function start(script, opts) {
    const o = opts || {};
    /* One name, one file. `logName` is used verbatim when it already ends in
       `.log` and gets the suffix when it does not, so a caller can pass either
       form and the log the assertions read is always the log the child wrote. */
    const base = String(o.logName || path.basename(String(script)));
    const logName = /\.log$/i.test(base) ? base : base + '.log';
    const logPath = path.join(tmp, logName);
    const fd = fs.openSync(logPath, 'a');
    const child = spawn(NODE, [path.isAbsolute(script) ? script : path.join(ROOT, script)].concat(o.args || []), {
      cwd: o.cwd || ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: Object.assign({}, process.env, o.env || {})
    });
    child.unref();
    tracked.add(child.pid);
    logs.set(logName, logPath);
    const exitAt = { code: null, signal: null };
    child.on('exit', (code, signal) => { exitAt.code = code; exitAt.signal = signal || null; });
    return { pid: child.pid, child: child, logPath: logPath, exitAt: exitAt };
  }

  function logText(logName) {
    const p = logs.get(logName) || path.join(tmp, logName);
    try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
  }

  function stopAll() {
    for (const pid of Array.from(tracked)) { forceKill(pid); tracked.delete(pid); }
  }

  function cleanup() {
    /* IB_KEEP_FIXTURES=1 leaves the temp tree behind for post-mortem inspection
       (the debugging aid this suite's own error messages point at). */
    if (String(process.env.IB_KEEP_FIXTURES || '') === '1') return;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    /* Leave the shared container only when it is empty. */
    try { if (fs.readdirSync(FIXTURE_BASE).length === 0) fs.rmdirSync(FIXTURE_BASE); } catch (e) { /* best effort */ }
  }

  return {
    tmp: tmp,
    start: start,
    logText: logText,
    logPath: n => logs.get(n) || path.join(tmp, n),
    tracked: tracked,
    forget: pid => tracked.delete(pid),
    stopAll: stopAll,
    cleanup: cleanup
  };
}

/* A private product-service-shaped executable. It answers the registry's own
   identity predicate for `shape`, and can be told to behave like a component
   that refuses to stop, one that accepts and never goes, or one whose
   cooperative surface is missing entirely. */
const FIXTURE_SOURCE = `
'use strict';
const http = require('http');
const fs = require('fs');
/* The fixture uses the PRODUCT'S OWN admission rule for /__shutdown, not a copy
   of it. That is the point of a fixture in this suite: a test double that
   re-implements the rule would keep passing after the real rule changed. */
const serviceControl = require(${JSON.stringify(path.join(ROOT, 'runtime', 'service-control.js'))});
const port = Number(process.env.FX_PORT);
const shape = process.env.FX_SHAPE || 'homeNode';
const behavior = process.env.FX_BEHAVIOR || 'cooperative';
const logFile = process.env.FX_LOG;
const pidFile = process.env.FX_PIDFILE;
function note(line) { try { fs.appendFileSync(logFile, line + String.fromCharCode(10)); } catch (e) {} }
const bodies = {
  static: { ok: true, server: 'InternalBeyond Web' },
  bridge: { ok: true, server: 'IB Bridge' },
  active: { ok: true, service: 'internal-beyond-active-messages' },
  homeNode: { ok: true, service: 'internal-beyond-home-node' },
  restart: { ok: true, service: 'InternalBeyond Restart' }
};
let stopping = false;
/* behavior=deceive: answer as this component while it is being discovered and
   while the stop is requested, then stop being it — while still holding the
   port. That is the shape in which the fallback's own identity re-read is the
   only thing standing between "kill the wrong thing" and "walk away". */
let impersonating = true;
function identityBody() {
  if (behavior === 'deceive' && !impersonating) return { hello: 'no-longer-internalbeyond' };
  return bodies[shape] || bodies.homeNode;
}
/* The endpoint's decision comes from the PRODUCT'S OWN dispatch object, so the
   fixture cannot disagree with the product about what "already stopping" means,
   what the accepted body looks like, or which origins are refused. */
const stopDispatch = serviceControl.createStopDispatch({
  service: 'internal-beyond-fixture',
  exposeBody: true,
  /* The exit is the fixture's own, so a fixture that is supposed to survive the
     stop can actually survive it — which is the whole point of the hang and
     close-only behaviours. */
  server: null,
  exit: code => process.exit(code),
  onAccepted: () => {
    note('cooperative:' + behavior);
    if (behavior === 'deceive') {
      /* It accepts the stop and then stops being recognisable, without ever
         going away. */
      setTimeout(() => { impersonating = false; note('stopped-impersonating'); }, Number(process.env.FX_DECEIVE_MS) || 400);
      return;
    }
    /* behavior=hang and close-only both deliberately stay alive AND keep
       listening, which is the only shape in which a repeated stop request can be
       observed at all. */
    if (behavior === 'hang' || behavior === 'close-only') return;
    if (behavior === 'slow') {
      /* A component that really needs a moment: it accepts, then takes a
         measurable time to finish going away. Nothing here is "sleeping to flush
         data" — it is a stop that takes time, which is what makes a
         clamped-to-nothing cooperative budget distinguishable from a real one. */
      setTimeout(() => { srv.close(() => {}); process.exit(0); }, Number(process.env.FX_SLOW_MS) || 400);
      return;
    }
    srv.close(() => {});
    setTimeout(() => process.exit(0), 200);
  }
});
const srv = http.createServer((req, res) => {
  const p = String(req.url || '/').split('?')[0];
  const health = shape === 'restart' ? '/status' : '/health';
  if (p === health) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(identityBody()));
    return;
  }
  if (p === serviceControl.STOP_PATH) {
    if (behavior === 'refuse') {
      note('refused-by-behavior');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'refusing' }));
      return;
    }
    if (behavior === 'hang') note('accepted-hang');
    const decision = stopDispatch(req, res);
    if (decision) return;
  }
  res.writeHead(404); res.end('');
});
if (behavior === 'no-stop-surface') {
  srv.removeAllListeners('request');
  srv.on('request', (req, res) => {
    const p = String(req.url || '/').split('?')[0];
    if (p === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(identityBody()));
      return;
    }
    res.writeHead(404); res.end('');
  });
}
if (process.env.FX_SILENT === '1') {
  /* A listener that holds the port and answers NOTHING — no HTTP, no identity,
     not even a 404. It is the shape that "nothing answered /health" alone cannot
     distinguish from "nothing is running", and the only shape in which the state
     machine's bindability check is the deciding fact. The HTTP server is never
     bound at all here, so there is no half-closed listener in the way. */
  const net = require('net');
  net.createServer(socket => { /* accept, and never reply */ }).listen(port, '127.0.0.1');
} else {
  srv.listen(port, '127.0.0.1');
}
if (pidFile) { try { fs.writeFileSync(pidFile, String(process.pid)); } catch (e) {} }
note('listening ' + port);
`;

function writeFixture(harness, name) {
  const dir = path.join(harness.tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ib-fixture.js');
  fs.writeFileSync(file, FIXTURE_SOURCE);
  return { dir: dir, file: file };
}

/* One fixture process, with the env it needs wired up. */
function startFixture(harness, opts) {
  const o = opts || {};
  const f = writeFixture(harness, o.name || String(o.port));
  const marker = path.join(f.dir, 'marker.txt');
  const proc = harness.start(f.file, {
    logName: (o.name || String(o.port)) + '.log',
    env: Object.assign({
      FX_PORT: String(o.port),
      FX_SHAPE: o.shape || 'homeNode',
      FX_BEHAVIOR: o.behavior || 'cooperative',
      FX_LOG: marker,
      FX_PIDFILE: path.join(f.dir, 'pid.txt')
    }, o.env || {})
  });
  return { dir: f.dir, file: f.file, marker: marker, proc: proc, pid: proc.pid };
}

/* A lifecycle target descriptor for an arbitrary fixture, shaped exactly like
   the ones runtime/component-lifecycle.js derives from the registry. */
function targetFor(shape, port, identify) {
  const registry = require(path.join(ROOT, 'runtime', 'component-registry.js'));
  const component = registry.COMPONENTS.find(c => c.id === shape);
  return {
    id: shape,
    name: component ? component.name : shape,
    label: component ? component.label : shape,
    port: port,
    healthPath: component ? component.healthPath : '/health',
    stopPath: '/__shutdown',
    matchesHealth: identify || (component ? component.matchesHealth : null)
  };
}

module.exports = {
  ROOT: ROOT,
  NODE: NODE,
  freePort: freePort,
  sleep: sleep,
  waitFor: waitFor,
  get: get,
  post: post,
  postJson: postJson,
  alive: alive,
  forceKill: forceKill,
  createHarness: createHarness,
  writeFixture: writeFixture,
  startFixture: startFixture,
  targetFor: targetFor,
  FIXTURE_SOURCE: FIXTURE_SOURCE
};
