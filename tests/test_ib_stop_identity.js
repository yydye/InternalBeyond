'use strict';

/* P7 · A 专项 — ib-stop.js root identity (isolated fixtures, no install).

   The stop helper must never touch an InternalBeyond instance that does not
   provably belong to the install root it was given. Every fixture here is a
   throwaway process on a free port in a temp directory; the developer instance
   on the product ports is never probed, stopped or written to. No browser.

   Cases:
     [1] pure classification (own / foreign / unknown)
     [2] no --root → refuses to stop anything
     [3] same root → stopped through the graceful control surface
     [4] different root + same script names → NOT stopped, reported foreign
     [5] InternalBeyond with no provable owner → NOT stopped, reported unknown
     [6] unrelated Node app on the product port → NOT stopped

   Run: node test_ib_stop_identity.js */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ibStop = require(path.join(ROOT, 'installer', 'tools', 'ib-stop.js'));


const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-stop-id-'));
const tracked = new Set();

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
async function acheck(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function getJson(port, pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1200 }, (res) => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(raw); } catch (e) { } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(fn, timeoutMs, stepMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await fn()) return true; await sleep(stepMs || 200); }
  return false;
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/* A throwaway InternalBeyond-shaped HTTP service. Its command line decides what
   the helper sees: absolute script path (provable root) or a relative one
   (InternalBeyond, but owner unprovable). */
const FIXTURE = `
'use strict';
const http = require('http');
const fs = require('fs');
const port = Number(process.env.FIXTURE_PORT);
const log = process.env.FIXTURE_LOG;
const isIb = process.env.FIXTURE_IB === '1';
const root = process.env.FIXTURE_ROOT || '';
const srv = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(isIb ? { ok: true, server: 'InternalBeyond Web' } : { ok: true, server: 'unrelated-http' }));
    return;
  }
  if (req.url === '/__boot-state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ present: true, bootState: { launcher: { root: root } } }));
    return;
  }
  if (req.url === '/__shutdown' && req.method === 'POST') {
    fs.appendFileSync(log, 'shutdown\\n');
    res.writeHead(202); res.end('{}');
    setTimeout(() => process.exit(0), 50);
    return;
  }
  res.writeHead(404); res.end('');
});
srv.listen(port, '127.0.0.1');
setInterval(() => { }, 1000);
`;

function makeRoot(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'internal-beyond-server.js'), FIXTURE);
  return dir;
}
function startFixture(dir, opts) {
  const o = opts || {};
  const script = o.relative ? 'internal-beyond-server.js' : path.join(dir, 'internal-beyond-server.js');
  const child = spawn(process.execPath, [script], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: Object.assign({}, process.env, {
      FIXTURE_PORT: String(o.port),
      FIXTURE_LOG: o.log,
      FIXTURE_IB: o.ib === false ? '0' : '1',
      FIXTURE_ROOT: o.root === undefined ? dir : o.root,
      IB_WEB_PORT: String(o.port)
    })
  });
  child.unref();
  tracked.add(child.pid);
  return child.pid;
}
function killFixture(pid) {
  try { execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }); }
  catch (e) { /* already gone */ }
  tracked.delete(pid);
}
function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}
/* Point the helper's service table at four free ports; the fixture only owns
   the web one, the rest stay silent so nothing else is ever probed. */
async function isolatePorts() {
  const ports = {
    IB_WEB_PORT: await freePort(), IB_RESTART_PORT: await freePort(),
    IB_BRIDGE_PORT: await freePort(), IB_ACTIVE_PORT: await freePort()
  };
  const saved = {};
  for (const k of Object.keys(ports)) { saved[k] = process.env[k]; process.env[k] = String(ports[k]); }
  return {
    ports,
    restore: () => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
}

async function main() {
  console.log('ib-stop root identity (P7 · A)\n');

  /* ── [1] pure classification ─────────────────────────────────────────── */
  console.log('[1] pure classification');

  check('same root → own (command line + executable path are proof)', () => {
    const r = ibStop.classifyTarget({
      commandLine: '"C:\\x\\rootA\\runtime\\node\\node.exe" C:\\x\\rootA\\internal-beyond-server.js',
      executablePath: 'C:\\x\\rootA\\runtime\\node\\node.exe'
    }, 'C:\\x\\rootA');
    assert.strictEqual(r.verdict, 'own');
    assert.deepStrictEqual(r.proof, ['executable-path', 'command-line']);
  });

  check('boot-state launcher.root is proof as well', () => {
    const r = ibStop.classifyTarget({ commandLine: 'node internal-beyond-server.js', bootStateRoot: 'C:\\x\\rootA' }, 'C:\\x\\rootA');
    assert.strictEqual(r.verdict, 'own');
    assert.deepStrictEqual(r.proof, ['boot-state']);
  });

  check('different root + same script names → foreign', () => {
    const r = ibStop.classifyTarget({
      commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\x\\rootB\\internal-beyond-server.js',
      executablePath: 'C:\\Program Files\\nodejs\\node.exe'
    }, 'C:\\x\\rootA');
    assert.strictEqual(r.verdict, 'foreign');
    assert.strictEqual(r.reason, 'other-root');
    assert.strictEqual(r.internalBeyond, true);
  });

  check('unrelated Node app → foreign (never ours)', () => {
    const r = ibStop.classifyTarget({
      commandLine: 'node.exe -e "setTimeout(function(){},1)"',
      executablePath: 'C:\\Program Files\\nodejs\\node.exe'
    }, 'C:\\x\\rootA');
    assert.strictEqual(r.verdict, 'foreign');
    assert.strictEqual(r.reason, 'not-internalbeyond');
  });

  check('InternalBeyond without a provable owner → unknown (never guessed)', () => {
    const r = ibStop.classifyTarget({
      commandLine: 'node internal-beyond-server.js',
      executablePath: 'C:\\Program Files\\nodejs\\node.exe'
    }, 'C:\\x\\rootA');
    assert.strictEqual(r.verdict, 'unknown');
    assert.strictEqual(r.reason, 'unproven-owner');
  });

  check('no evidence at all → unknown', () => {
    const r = ibStop.classifyTarget({}, 'C:\\x\\rootA');
    assert.strictEqual(r.verdict, 'unknown');
    assert.strictEqual(r.reason, 'no-evidence');
  });

  check('without a root nothing can be own', () => {
    const r = ibStop.classifyTarget({ commandLine: 'C:\\x\\rootA\\internal-beyond-server.js' }, '');
    assert.notStrictEqual(r.verdict, 'own', 'a missing root must never yield a stoppable target');
  });

  /* ── [2] no --root refuses to act ────────────────────────────────────── */
  console.log('\n[2] missing --root');

  await acheck('stop() refuses without --root', async () => {
    const report = await ibStop.stop({ timeoutMs: 2000 });
    assert.strictEqual(report.ok, false, 'must not report success');
    assert.ok(report.errors.join('|').indexOf('root-required') >= 0, 'must explain that --root is required');
    assert.strictEqual(report.own.length + report.graceful.length + report.fallback.length, 0, 'must not stop anything');
  });

  /* ── [3] same root → stopped ─────────────────────────────────────────── */
  console.log('\n[3] same root → stopped');

  await acheck('an instance inside the given root is stopped gracefully', async () => {
    const iso = await isolatePorts();
    const dir = makeRoot('own');
    const log = path.join(dir, 'fixture.log');
    const pid = startFixture(dir, { port: iso.ports.IB_WEB_PORT, log, root: dir });
    try {
      assert.ok(await waitFor(async () => (await getJson(iso.ports.IB_WEB_PORT, '/health')).status === 200, 10000),
        'fixture did not start');
      const report = await ibStop.stop({ root: dir, timeoutMs: 6000 });
      assert.ok(report.own.length > 0, 'must classify the instance as ours: ' + JSON.stringify(report));
      assert.ok(report.graceful.indexOf('web') >= 0, 'must use the graceful control surface');
      assert.strictEqual(report.foreign.length, 0);
      assert.strictEqual(report.remaining.length, 0, 'our port must be free: ' + JSON.stringify(report.remaining));
      assert.strictEqual(report.ok, true);
      assert.ok(await waitFor(() => !alive(pid), 8000), 'fixture must have exited');
      assert.ok(readLog(log).indexOf('shutdown') >= 0, 'graceful stop must have been requested');
    } finally { killFixture(pid); iso.restore(); }
  });

  /* ── [4] different root → foreign, untouched ─────────────────────────── */
  console.log('\n[4] different root → foreign, untouched');

  await acheck('an instance from another root is reported, never stopped', async () => {
    const iso = await isolatePorts();
    const ours = makeRoot('ours');
    const other = makeRoot('other');
    const log = path.join(other, 'fixture.log');
    const pid = startFixture(other, { port: iso.ports.IB_WEB_PORT, log, root: other });
    try {
      assert.ok(await waitFor(async () => (await getJson(iso.ports.IB_WEB_PORT, '/health')).status === 200, 10000), 'fixture did not start');
      const report = await ibStop.stop({ root: ours, timeoutMs: 4000 });
      assert.ok(report.foreign.length > 0, 'must report a foreign instance: ' + JSON.stringify(report));
      assert.ok(report.foreign.join('|').indexOf('other-root') >= 0, 'reason must be other-root');
      assert.strictEqual(report.graceful.length, 0, 'must not use any stop surface');
      assert.strictEqual(report.fallback.length, 0, 'must not kill anything');
      assert.strictEqual(readLog(log), '', 'the foreign instance must never receive a stop request');
      assert.strictEqual(alive(pid), true, 'the foreign instance must still be running');
      assert.strictEqual(report.ok, true, 'a foreign instance is not our failure');
    } finally { killFixture(pid); iso.restore(); }
  });

  /* ── [5] unprovable owner → unknown, untouched ───────────────────────── */
  console.log('\n[5] unprovable owner → unknown, untouched');

  await acheck('InternalBeyond with no root evidence is reported, never guessed', async () => {
    const iso = await isolatePorts();
    const dir = makeRoot('relative');
    const log = path.join(dir, 'fixture.log');
    const pid = startFixture(dir, { port: iso.ports.IB_WEB_PORT, log, relative: true, root: '' });
    try {
      assert.ok(await waitFor(async () => (await getJson(iso.ports.IB_WEB_PORT, '/health')).status === 200, 10000), 'fixture did not start');
      const report = await ibStop.stop({ root: dir, timeoutMs: 4000 });
      assert.ok(report.unknown.length > 0, 'must report unknown: ' + JSON.stringify(report));
      assert.strictEqual(report.graceful.length, 0, 'must not stop an unproven instance');
      assert.strictEqual(report.fallback.length, 0);
      assert.strictEqual(readLog(log), '', 'no stop request may be sent');
      assert.strictEqual(alive(pid), true, 'the unproven instance must still be running');
    } finally { killFixture(pid); iso.restore(); }
  });

  /* ── [6] unrelated Node on the product port → untouched ──────────────── */
  console.log('\n[6] unrelated Node app on the product port');

  await acheck('a non-InternalBeyond service on the port is never touched', async () => {
    const iso = await isolatePorts();
    const dir = makeRoot('unrelated');
    const log = path.join(dir, 'fixture.log');
    const pid = startFixture(dir, { port: iso.ports.IB_WEB_PORT, log, ib: false, root: dir });
    try {
      assert.ok(await waitFor(async () => (await getJson(iso.ports.IB_WEB_PORT, '/health')).status === 200, 10000), 'fixture did not start');
      const report = await ibStop.stop({ root: dir, timeoutMs: 4000 });
      assert.strictEqual(report.detected.length, 0, 'a non-IB service must not be detected as ours');
      assert.strictEqual(report.graceful.length + report.fallback.length, 0);
      assert.strictEqual(readLog(log), '');
      assert.strictEqual(alive(pid), true, 'the unrelated process must survive');
    } finally { killFixture(pid); iso.restore(); }
  });

  /* ── cleanup + report ────────────────────────────────────────────────── */
  for (const pid of Array.from(tracked)) killFixture(pid);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error('\nUNEXPECTED FAILURE: ' + (e && e.stack || e));
  for (const pid of Array.from(tracked)) killFixture(pid);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { /* best effort */ }
  process.exitCode = 1;
});
