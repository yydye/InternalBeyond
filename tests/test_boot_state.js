'use strict';

/*
 * P2 · Degraded startup + boot-state contract regression.
 *
 * Real behaviour, not mocks-of-the-thing-under-test:
 *   - real HTTP health servers on real (random) ports for Bridge / Active
 *   - the real static web server (`internal-beyond-server.js`)
 *   - the real launcher decision path (`main()`), with only process *creation*
 *     intercepted where a real child would leak (browser tab / extra runner).
 *
 * Coverage map (P2 acceptance list):
 *   1  Bridge + Active healthy            → UI opens, overall=normal
 *   2  Bridge down                        → UI opens, overall=degraded
 *   3  Active down                        → UI opens, overall=degraded
 *   4  Bridge + Active down               → UI opens, overall=degraded
 *   5  static cannot serve                → fatal (three distinct causes)
 *   6  boot-state JSON valid + stable shape
 *   7  boot-state carries no credentials
 *   8  stale boot-state cannot pose as the current launch
 *   9  boot-state write failure never blocks a working launch
 *   10 normal path has no regression
 *   11 P1 bundled-node chain has no regression (see test_node_runtime.js)
 *   12 no visible console window (windowsHide on every spawn)
 */

const assert = require('assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const { spawn } = require('child_process');

const WEB = require(path.join(ROOT, 'services', 'internal-beyond-server.js'));
const BOOT = require(path.join(ROOT, 'runtime', 'boot-state.js'));
const LAUNCH_PATH = require.resolve(path.join(ROOT, 'runtime', 'launch-internal-beyond.js'));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
function section(title) { console.log('\n' + title); }

/* ── harness ── */

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise(resolve => { try { server.close(() => resolve()); } catch (e) { resolve(); } });
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
function healthServer(payload) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(typeof payload === 'function' ? payload(req) : payload));
  });
}
function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p2-' + tag + '-'));
}
function getJson(port, pathname) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2500 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
  });
}

/* Load a fresh launcher instance with env applied at module-load time (ports are
   module constants) and with child-process creation recorded. */
function loadLauncher(env) {
  const calls = [];
  const fakeChild = () => ({ pid: -1, unref() { }, on() { return this; }, kill() { }, stdout: null, stderr: null });
  const cp = require('child_process');
  const origSpawn = cp.spawn;
  const savedEnv = {};
  for (const key of Object.keys(env || {})) { savedEnv[key] = process.env[key]; process.env[key] = String(env[key]); }
  cp.spawn = function (cmd, args, opts) {
    calls.push({ cmd: String(cmd), args: (args || []).map(String), opts: opts || {} });
    const isRunner = (args || []).some(a => /local-services-runner\.js$/.test(String(a)));
    const isWeb = (args || []).some(a => /internal-beyond-server\.js$/.test(String(a)));
    const isStart = /cmd\.exe$/i.test(String(cmd)) && (args || []).some(a => String(a) === 'start');
    if (isStart || isRunner || isWeb) return fakeChild();
    return origSpawn.apply(cp, arguments);
  };
  delete require.cache[LAUNCH_PATH];
  let mod;
  try { mod = require(LAUNCH_PATH); } finally { cp.spawn = origSpawn; }
  const restore = () => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
  };
  return { mod, calls, restore, browserOpens: () => calls.filter(c => /cmd\.exe$/i.test(c.cmd)) };
}

/*
 * One full launch scenario.
 *   spec.services  'normal' | 'no-bridge' | 'no-active' | 'none'
 *   spec.web       'real' | 'conflict' | 'unavailable' | 'no-document'
 *   spec.stateDir  where boot-state.json goes
 *   spec.servicesTimeout / webTimeout
 */
async function runScenario(spec) {
  const s = spec || {};
  const servers = [];
  const env = {};
  const bridgePort = await freePort();
  const activePort = await freePort();
  env.IB_BRIDGE_PORT = bridgePort;
  env.IB_ACTIVE_PORT = activePort;
  env.IB_RESTART_PORT = await freePort();
  env.IB_LAUNCH_SERVICES_TIMEOUT_MS = String(s.servicesTimeout == null ? 1200 : s.servicesTimeout);
  env.IB_LAUNCH_WEB_TIMEOUT_MS = String(s.webTimeout == null ? 1200 : s.webTimeout);

  if (s.services !== 'no-bridge' && s.services !== 'none') {
    const srv = healthServer({ ok: true, server: 'IB Bridge', version: 3 });
    env.IB_BRIDGE_PORT = await listen(srv);
    servers.push(srv);
  }
  if (s.services !== 'no-active' && s.services !== 'none') {
    const srv = healthServer({ ok: true, service: 'internal-beyond-active-messages', version: 3 });
    env.IB_ACTIVE_PORT = await listen(srv);
    servers.push(srv);
  }
  if (s.web === 'real') {
    const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
    env.IB_WEB_PORT = await listen(webSrv);
    servers.push(webSrv);
  } else if (s.web === 'conflict') {
    const srv = healthServer({ ok: true, server: 'Not InternalBeyond' });
    env.IB_WEB_PORT = await listen(srv);
    servers.push(srv);
  } else if (s.web === 'no-document') {
    /* identity-correct /health but the UI document is not servable */
    const srv = http.createServer((req, res) => {
      const p = String(req.url || '').split('?')[0];
      if (p === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, server: 'InternalBeyond Web' }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });
    env.IB_WEB_PORT = await listen(srv);
    servers.push(srv);
  } else {
    env.IB_WEB_PORT = await freePort(); /* 'unavailable': nothing there, spawn intercepted */
  }

  const launcher = loadLauncher(env);
  let restoreFault = null;
  if (s.injectFault) {
    /* Fault injection: the first final ('complete') record throws once, exactly
       like an unexpected bug after the starting record was already written. */
    let thrown = false;
    const orig = BOOT.buildBootState;
    BOOT.buildBootState = function (input) {
      if (!thrown && input && input.phase === 'complete') { thrown = true; throw new Error('injected launcher fault'); }
      return orig.apply(BOOT, arguments);
    };
    restoreFault = () => { BOOT.buildBootState = orig; };
  }
  try {
    const result = await launcher.mod.main({
      silent: true,
      noOpen: s.open === true ? false : true,
      stateDir: s.stateDir,
      servicesTimeout: s.servicesTimeout == null ? 1200 : s.servicesTimeout,
      webTimeout: s.webTimeout == null ? 1200 : s.webTimeout
    });
    return { result, calls: launcher.calls, browserOpens: launcher.browserOpens(), env, servers, launcher };
  } finally {
    if (restoreFault) restoreFault();
    launcher.restore();
    for (const srv of servers) await close(srv);
  }
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'boot-state.json'), 'utf8'));
}

/* ── teardown discipline ──
   No process.exit(0): the suite must drain its own handles and exit naturally.
   If anything is still holding the event loop open, report it instead of hiding
   it behind a hard exit. */
function describeHandles() {
  const out = [];
  if (typeof process.getActiveResourcesInfo === 'function') {
    out.push('activeResources=' + process.getActiveResourcesInfo().join(','));
  }
  if (typeof process._getActiveHandles === 'function') {
    for (const h of process._getActiveHandles()) {
      if (!h) continue;
      const name = (h.constructor && h.constructor.name) || 'Handle';
      let extra = '';
      if (typeof h.address === 'function') {
        try { extra = ' ' + JSON.stringify(h.address()); } catch (e) { }
      }
      out.push(name + extra);
    }
  }
  return out.length ? out.join('\n    ') : '(none reported)';
}

function finalize() {
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
  /* Unref'd: never keeps the loop alive, but still fires if something else does. */
  setTimeout(() => {
    console.error('\nLEAK: event loop still alive 5s after the suite finished — unreleased resources:');
    console.error('    ' + describeHandles());
    process.exit(2);
  }, 5000).unref();
}

/* ── suite ── */

(async () => {
  /* Hard watchdog (unref'd): a hung suite fails in 45s and names the leak
     instead of waiting forever. */
  const watchdog = setTimeout(() => {
    console.error('\nWATCHDOG: suite exceeded 45s — unreleased resources:');
    console.error('    ' + describeHandles());
    process.exit(1);
  }, 45000);
  watchdog.unref();
  console.log('P2 · degraded startup + boot-state regression\n');

  /* ═══ 1. contract shape ═══ */
  section('1. boot-state contract (pure)');

  await check('schema/version/generatedAt/overall present', async () => {
    const st = BOOT.buildBootState({
      phase: 'complete',
      components: {
        static: { required: true, healthy: true, state: 'healthy', port: 23120 },
        bridge: { healthy: true, state: 'healthy', port: 23115 },
        active: { healthy: true, state: 'healthy', port: 23114 }
      }
    });
    assert.strictEqual(st.schema, 'internalbeyond.boot-state');
    assert.strictEqual(st.version, 1);
    assert.ok(!Number.isNaN(Date.parse(st.generatedAt)), 'generatedAt must be an ISO timestamp');
    assert.strictEqual(st.overall, 'normal');
    assert.strictEqual(st.ok, true);
    assert.strictEqual(st.degraded, false);
    assert.deepStrictEqual(st.degradedReasons, []);
    assert.strictEqual(st.fatal, null);
    assert.ok(st.launcher && st.launcher.node && st.launcher.node.version, 'launcher/runtime info present');
    assert.ok(st.launcher.serviceManager && typeof st.launcher.serviceManager.state === 'string', 'service manager info present');
    assert.strictEqual(typeof st.launcher.serviceManager.startedByLauncher, 'boolean');
  });

  await check('every component carries required/affectsOverall/probed/healthy/state/reason', async () => {
    const st = BOOT.buildBootState({ phase: 'complete', components: { static: { required: true, healthy: true, state: 'healthy' } } });
    for (const name of BOOT.COMPONENT_ORDER) {
      const c = st.components[name];
      assert.ok(c, name + ' missing');
      for (const key of ['required', 'affectsOverall', 'probed', 'healthy', 'state']) {
        assert.ok(Object.prototype.hasOwnProperty.call(c, key), name + '.' + key + ' missing');
      }
      assert.ok(Object.prototype.hasOwnProperty.call(c, 'reason'), name + '.reason missing');
    }
  });

  await check('degraded components produce degradedReasons with category', async () => {
    const st = BOOT.buildBootState({
      phase: 'complete',
      components: {
        static: { required: true, healthy: true, state: 'healthy' },
        bridge: { healthy: false, state: 'offline', reason: { category: 'offline', message: 'no answer' } },
        active: { healthy: true, state: 'healthy' }
      }
    });
    assert.strictEqual(st.overall, 'degraded');
    assert.strictEqual(st.degraded, true);
    assert.strictEqual(st.degradedReasons.length, 1);
    assert.strictEqual(st.degradedReasons[0].component, 'bridge');
    assert.strictEqual(st.degradedReasons[0].category, 'offline');
  });

  await check('fatal wins over degraded and sets ok=false', async () => {
    const st = BOOT.buildBootState({
      phase: 'complete',
      components: { static: { required: true, healthy: false, state: 'conflict' }, bridge: { healthy: false, state: 'offline' } },
      fatal: { category: 'port-conflict', message: 'port busy' }
    });
    assert.strictEqual(st.overall, 'fatal');
    assert.strictEqual(st.ok, false);
    assert.strictEqual(st.fatal.category, 'port-conflict');
  });

  await check('required static unhealthy ⇒ derived fatal (contract cannot lie)', async () => {
    const st = BOOT.buildBootState({ phase: 'complete', components: { static: { required: true, healthy: false, state: 'offline' } } });
    assert.strictEqual(st.overall, 'fatal');
    assert.ok(st.fatal && st.fatal.category);
  });

  await check('optional components (vision/restart) never degrade on their own', async () => {
    const st = BOOT.buildBootState({
      phase: 'complete',
      components: {
        static: { required: true, healthy: true, state: 'healthy' },
        bridge: { healthy: true, state: 'healthy' },
        active: { healthy: true, state: 'healthy' },
        restart: { affectsOverall: false, healthy: false, state: 'offline' },
        vision: { affectsOverall: false, probed: false, healthy: false, state: 'not-enabled' }
      }
    });
    assert.strictEqual(st.overall, 'normal');
    assert.deepStrictEqual(st.degradedReasons, []);
  });

  await check('starting phase is not normal/degraded/fatal', async () => {
    const st = BOOT.buildBootState({ phase: 'starting', components: { static: { required: true, healthy: false, state: 'unknown' } } });
    assert.strictEqual(st.overall, 'starting');
    assert.strictEqual(st.fatal, null, 'starting must not be auto-fatal');
  });

  /* ═══ 2. redaction ═══ */
  section('2. redaction — boot-state never carries credentials');

  await check('scrub drops secret keys and masks secret values', async () => {
    const dirty = {
      apiKey: 'sk-live-abcdef123456',
      nested: { token: 'abc', authorization: 'Bearer xyz', ok: 1 },
      note: 'key is sk-live-abcdef123456 and Bearer abcdefghijkl',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij',
      list: [{ secret: 's' }, 'sk-zzzzzzzzzzzz']
    };
    const clean = BOOT.scrub(dirty);
    const text = JSON.stringify(clean);
    assert.ok(!/apiKey|"token"|authorization|secret/i.test(text), 'secret-shaped keys must be dropped: ' + text);
    assert.ok(!/sk-live/.test(text), 'secret-shaped values must be masked');
    assert.ok(!/Bearer abcdef/.test(text), 'bearer values must be masked');
    assert.ok(!/eyJhbGci/.test(text), 'JWT values must be masked');
    assert.strictEqual(clean.nested.ok, 1, 'non-secret data must survive');
  });

  await check('written boot-state file contains no credential-shaped text', async () => {
    const dir = tempDir('redact');
    const st = BOOT.buildBootState({
      phase: 'complete',
      components: { static: { required: true, healthy: true, state: 'healthy', url: 'http://127.0.0.1:23120/InternalBeyond.html' } },
      warnings: [{ code: 'x', message: 'apiKey=sk-live-abcdef123456 token: abcdef' }]
    });
    const res = BOOT.writeBootState(st, { dir: dir });
    assert.strictEqual(res.ok, true);
    const raw = fs.readFileSync(path.join(dir, 'boot-state.json'), 'utf8');
    assert.ok(!/sk-live/.test(raw), 'no sk- value may reach the file');
    assert.ok(!/"apiKey"|"token"|"authorization"|"password"/i.test(raw), 'no secret-shaped key may reach the file');
    assert.ok(raw.includes('InternalBeyond.html'), 'normal data must still be there');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ═══ 3. atomic write + staleness ═══ */
  section('3. atomic write + staleness');

  await check('atomic write: a reader never observes partial JSON', async () => {
    const dir = tempDir('atomic');
    const file = path.join(dir, 'boot-state.json');
    const base = BOOT.buildBootState({ phase: 'complete', components: { static: { required: true, healthy: true, state: 'healthy' } } });
    let reads = 0, bad = 0, stop = false;
    /* The reader leaves a small gap between reads: on Windows a rename cannot
       replace a file that another process holds open, so a reader glued to the
       file would only exercise the retry path (slow) instead of atomicity. */
    const reader = (async () => {
      while (!stop) {
        try {
          JSON.parse(fs.readFileSync(file, 'utf8'));
          reads++;
        } catch (e) {
          if (e.code !== 'ENOENT') bad++;
        }
        await new Promise(r => setTimeout(r, 1));
      }
    })();
    try {
      for (let i = 0; i < 60; i++) {
        const res = BOOT.writeBootState(Object.assign({}, base, { bootId: 'b' + i }), { file: file });
        assert.strictEqual(res.ok, true, 'write ' + i + ' failed: ' + JSON.stringify(res.error));
        /* Yield so the reader really interleaves with the writer. */
        await new Promise(r => setTimeout(r, 1));
      }
    } finally {
      stop = true;
      await reader;
    }
    assert.strictEqual(bad, 0, bad + ' partial/corrupt reads out of ' + reads);
    assert.ok(reads > 0, 'reader must have observed writes');
    const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'no temp files may be left behind');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('write replaces (never appends to) an existing record', async () => {
    const dir = tempDir('replace');
    const file = path.join(dir, 'boot-state.json');
    const mk = id => BOOT.buildBootState({ bootId: id, phase: 'complete', components: { static: { required: true, healthy: true, state: 'healthy' } } });
    BOOT.writeBootState(mk('first'), { file: file });
    BOOT.writeBootState(mk('second'), { file: file });
    const read = BOOT.readBootState({ file: file });
    assert.strictEqual(read.state.bootId, 'second');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).bootId, 'second');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('missing record is present:false / stale:missing', async () => {
    const dir = tempDir('missing');
    const read = BOOT.readBootState({ dir: dir });
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.present, false);
    assert.strictEqual(read.stale, true);
    assert.strictEqual(read.staleReason, 'missing');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('invalid JSON is rejected, not trusted', async () => {
    const dir = tempDir('invalid');
    fs.writeFileSync(path.join(dir, 'boot-state.json'), '{"schema":"internalbeyond.boot-state","overall":');
    const read = BOOT.readBootState({ dir: dir });
    assert.strictEqual(read.ok, false);
    assert.strictEqual(read.stale, true);
    assert.strictEqual(read.staleReason, 'invalid');
    assert.strictEqual(read.error.category, 'invalid-json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('age / clock-skew / abandoned-start / web-port-mismatch are detected', async () => {
    const dir = tempDir('stale');
    const file = path.join(dir, 'boot-state.json');
    const now = Date.now();
    const write = (overall, generatedAt, port) => {
      fs.writeFileSync(file, JSON.stringify({
        schema: 'internalbeyond.boot-state', version: 1, overall: overall,
        generatedAt: new Date(generatedAt).toISOString(), staleAfterMs: 60000,
        components: { static: { port: port } }
      }));
    };
    write('normal', now - 10 * 60 * 1000, 23120);
    let r = BOOT.readBootState({ file: file, now: now, expectWebPort: 23120 });
    assert.strictEqual(r.stale, true);
    assert.strictEqual(r.staleReason, 'age');

    write('normal', now + 30 * 60 * 1000, 23120);
    r = BOOT.readBootState({ file: file, now: now, expectWebPort: 23120 });
    assert.strictEqual(r.staleReason, 'clock-skew');

    write('starting', now - 10 * 60 * 1000, 23120);
    r = BOOT.readBootState({ file: file, now: now, expectWebPort: 23120 });
    assert.strictEqual(r.staleReason, 'abandoned-start');

    write('normal', now, 23120);
    r = BOOT.readBootState({ file: file, now: now, expectWebPort: 23199 });
    assert.strictEqual(r.stale, true);
    assert.strictEqual(r.staleReason, 'web-port-mismatch');

    r = BOOT.readBootState({ file: file, now: now, expectWebPort: 23120 });
    assert.strictEqual(r.stale, false);
    assert.strictEqual(r.staleReason, null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ═══ 4. classification, end to end ═══ */
  section('4. launch classification (real health servers + real static server)');

  let normalDir = tempDir('normal');
  await check('1) Bridge + Active healthy → overall=normal, UI served', async () => {
    const run = await runScenario({ services: 'normal', web: 'real', stateDir: normalDir });
    const r = run.result;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.overall, 'normal');
    assert.strictEqual(r.degraded, false);
    assert.strictEqual(r.bootState.components.static.healthy, true);
    assert.strictEqual(r.bootState.components.bridge.healthy, true);
    assert.strictEqual(r.bootState.components.active.healthy, true);
    assert.strictEqual(r.bootState.components.static.reused, true, 'pre-existing static server must be reused');
    assert.deepStrictEqual(r.degradedReasons, []);
    const onDisk = readState(normalDir);
    assert.strictEqual(onDisk.overall, 'normal');
    assert.strictEqual(onDisk.ok, true);
    assert.ok(['unknown', 'healthy', 'starting', 'down'].includes(onDisk.launcher.serviceManager.state),
      'service manager state: ' + onDisk.launcher.serviceManager.state);
  });

  await check('2) Bridge down → UI still opens, overall=degraded', async () => {
    const dir = tempDir('nobridge');
    const run = await runScenario({ services: 'no-bridge', web: 'real', stateDir: dir });
    const r = run.result;
    assert.strictEqual(r.ok, true, 'launch must not fail');
    assert.strictEqual(r.overall, 'degraded');
    assert.strictEqual(r.bootState.components.bridge.healthy, false);
    assert.ok(['offline', 'timeout', 'conflict'].includes(r.bootState.components.bridge.reason.category),
      'bridge reason category: ' + JSON.stringify(r.bootState.components.bridge.reason));
    assert.strictEqual(r.bootState.components.active.healthy, true);
    assert.strictEqual(r.bootState.components.static.healthy, true);
    assert.ok(r.url.indexOf('/InternalBeyond.html') > 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('3) Active down → UI still opens, overall=degraded', async () => {
    const dir = tempDir('noactive');
    const run = await runScenario({ services: 'no-active', web: 'real', stateDir: dir });
    const r = run.result;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.overall, 'degraded');
    assert.strictEqual(r.bootState.components.active.healthy, false);
    assert.ok(['offline', 'timeout', 'conflict'].includes(r.bootState.components.active.reason.category));
    assert.strictEqual(r.bootState.components.bridge.healthy, true);
    assert.strictEqual(r.bootState.components.static.healthy, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('4) Bridge + Active down → UI still opens, overall=degraded', async () => {
    const dir = tempDir('none');
    const run = await runScenario({ services: 'none', web: 'real', stateDir: dir });
    const r = run.result;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.overall, 'degraded');
    assert.strictEqual(r.bootState.components.bridge.healthy, false);
    assert.strictEqual(r.bootState.components.active.healthy, false);
    assert.strictEqual(r.bootState.components.static.healthy, true);
    const reasons = r.degradedReasons.map(x => x.component).sort();
    assert.deepStrictEqual(reasons, ['active', 'bridge']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ═══ 5. fatal static ═══ */
  section('5. static layer failures are fatal (and no broken URL is opened)');

  await check('5a) web port conflict → fatal=port-conflict, no browser', async () => {
    const dir = tempDir('conflict');
    const run = await runScenario({ services: 'normal', web: 'conflict', stateDir: dir });
    const r = run.result;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.overall, 'fatal');
    assert.strictEqual(r.bootState.fatal.category, 'port-conflict');
    assert.strictEqual(r.url, null, 'no URL may be returned for a broken launch');
    assert.strictEqual(run.browserOpens.length, 0, 'browser must not be opened');
    const onDisk = readState(dir);
    assert.strictEqual(onDisk.overall, 'fatal');
    assert.strictEqual(onDisk.fatal.category, 'port-conflict');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('5b) static server cannot start → fatal=static-unavailable', async () => {
    const dir = tempDir('noweb');
    const run = await runScenario({ services: 'normal', web: 'unavailable', stateDir: dir });
    const r = run.result;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.overall, 'fatal');
    assert.strictEqual(r.bootState.fatal.category, 'static-unavailable');
    assert.strictEqual(run.browserOpens.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('5c) identity ok but UI document missing → fatal=ui-document-unavailable', async () => {
    const dir = tempDir('nodoc');
    const run = await runScenario({ services: 'normal', web: 'no-document', stateDir: dir });
    const r = run.result;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.overall, 'fatal');
    assert.strictEqual(r.bootState.fatal.category, 'ui-document-unavailable');
    assert.strictEqual(run.browserOpens.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ═══ 6. degraded still opens the UI ═══ */
  section('6. the UI really is opened when degraded');

  await check('degraded launch issues the real browser-open command', async () => {
    const dir = tempDir('open');
    const run = await runScenario({ services: 'none', web: 'real', stateDir: dir, open: true });
    assert.strictEqual(run.result.ok, true);
    assert.strictEqual(run.result.overall, 'degraded');
    assert.strictEqual(run.browserOpens.length, 1, 'exactly one browser-open attempt expected');
    const call = run.browserOpens[0];
    assert.ok(/cmd\.exe$/i.test(call.cmd), 'opens through cmd.exe start');
    assert.deepStrictEqual(call.args.slice(0, 3), ['/c', 'start', '']);
    assert.strictEqual(call.args[3], run.result.url);
    /* uiUrl() appends ?ibv=<product version> so the Guide can show the real
       version without a runtime request; the app routes on the hash only. */
    assert.ok(/\/InternalBeyond\.html(\?ibv=[\w.\-]+)?$/.test(call.args[3]), 'must open the real UI document');
    assert.strictEqual(run.result.opened, true);
    assert.strictEqual(readState(dir).opened, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('every launcher spawn hides its window (no visible console)', async () => {
    const dir = tempDir('hide');
    const run = await runScenario({ services: 'none', web: 'real', stateDir: dir, open: true });
    const ours = run.calls.filter(c => /cmd\.exe$/i.test(c.cmd) || /local-services-runner|internal-beyond-server/.test(c.args.join(' ')));
    assert.ok(ours.length > 0, 'expected at least one managed spawn');
    for (const call of ours) {
      assert.strictEqual(call.opts.windowsHide, true, 'windowsHide missing for ' + call.cmd + ' ' + call.args.join(' '));
      assert.strictEqual(call.opts.detached, true, 'detached missing for ' + call.cmd);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ═══ 7. stale cannot impersonate the current launch ═══ */
  section('7. stale records cannot pose as the current launch');

  await check('a previous normal record is invalidated before probing', async () => {
    const dir = tempDir('invalidate');
    const stale = BOOT.buildBootState({
      bootId: 'yesterdays-boot', phase: 'complete',
      components: { static: { required: true, healthy: true, state: 'healthy', port: 23120 }, bridge: { healthy: true, state: 'healthy' }, active: { healthy: true, state: 'healthy' } }
    });
    stale.generatedAt = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    stale.overall = 'normal';
    BOOT.writeBootState(stale, { dir: dir });

    const seen = new Set();
    const poller = setInterval(() => {
      try { seen.add(JSON.parse(fs.readFileSync(path.join(dir, 'boot-state.json'), 'utf8')).overall); } catch (e) { }
    }, 40);
    let run;
    try {
      run = await runScenario({ services: 'none', web: 'real', stateDir: dir, servicesTimeout: 2600 });
    } finally {
      clearInterval(poller);
    }

    assert.strictEqual(run.result.overall, 'degraded');
    const onDisk = readState(dir);
    assert.strictEqual(onDisk.overall, 'degraded', 'stale normal must not survive the launch');
    assert.notStrictEqual(onDisk.bootId, 'yesterdays-boot', 'bootId must be refreshed');
    assert.ok(Date.parse(onDisk.generatedAt) > Date.now() - 120000, 'generatedAt must be fresh');
    assert.ok(seen.has('starting'), 'record must pass through an explicit starting phase (crash safety), saw: ' + [...seen].join(','));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('fatal launches still refresh the record', async () => {
    const dir = tempDir('fatalrefresh');
    const stale = BOOT.buildBootState({ bootId: 'old', phase: 'complete', components: { static: { required: true, healthy: true, state: 'healthy' } } });
    BOOT.writeBootState(stale, { dir: dir });
    const run = await runScenario({ services: 'normal', web: 'conflict', stateDir: dir });
    assert.strictEqual(run.result.ok, false);
    const onDisk = readState(dir);
    assert.notStrictEqual(onDisk.bootId, 'old');
    assert.strictEqual(onDisk.overall, 'fatal');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ═══ 8. write failure tolerance ═══ */
  section('8. boot-state write failure never blocks a launch');

  await check('unwritable state dir → launch still succeeds, failure recorded', async () => {
    const dir = tempDir('writefail');
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x'); /* a file where the state dir should be */
    const badDir = path.join(blocker, 'nested');
    const run = await runScenario({ services: 'normal', web: 'real', stateDir: badDir });
    const r = run.result;
    assert.strictEqual(r.ok, true, 'a diagnostics write failure must not fail the launch');
    assert.strictEqual(r.overall, 'normal');
    assert.strictEqual(r.bootStateWrite.ok, false, 'the failure must be reported');
    assert.ok(r.bootStateWrite.error && r.bootStateWrite.error.category, 'failure must carry a category');
    assert.strictEqual(r.bootState.overall, 'normal', 'in-memory state is still correct');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('writeBootState never throws on an impossible path', async () => {
    const res = BOOT.writeBootState({ schema: BOOT.SCHEMA }, { file: path.join(os.tmpdir(), 'ib-p2-' + Date.now(), 'nope', '\u0000bad', 'x.json') });
    assert.strictEqual(res.ok, false);
    assert.ok(res.error && res.error.message);
  });

  await check('unexpected launcher fault is recorded as fatal launcher-error', async () => {
    const dir = tempDir('fault');
    const run = await runScenario({ services: 'normal', web: 'real', stateDir: dir, injectFault: true });
    const r = run.result;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.overall, 'fatal');
    assert.strictEqual(r.bootState.fatal.category, 'launcher-error');
    const onDisk = readState(dir);
    assert.strictEqual(onDisk.overall, 'fatal', 'a crashed launch must not leave a stranded starting record');
    assert.strictEqual(onDisk.fatal.category, 'launcher-error');
    assert.strictEqual(run.browserOpens.length, 0, 'a crashed launch must not open a URL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ═══ 9. /__boot-state consumption endpoint ═══ */
  section('9. GET /__boot-state (P5 consumption interface)');

  {
    const dir = tempDir('endpoint');
    const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
    const webPort = await listen(webSrv);
    const savedDir = process.env.IB_BOOT_STATE_DIR;
    try {
      process.env.IB_BOOT_STATE_DIR = dir;

      await check('absent record → 200 present:false stale:missing', async () => {
        const h = await getJson(webPort, '/__boot-state');
        assert.strictEqual(h.status, 200);
        assert.strictEqual(h.headers['cache-control'], 'no-store');
        assert.strictEqual(h.headers['access-control-allow-origin'], undefined, 'must stay same-origin only');
        const data = JSON.parse(h.body);
        assert.strictEqual(data.present, false);
        assert.strictEqual(data.ok, false);
        assert.strictEqual(data.stale, true);
        assert.strictEqual(data.staleReason, 'missing');
        assert.strictEqual(data.bootState, null);
        assert.strictEqual(data.schema, 'internalbeyond.boot-state');
        assert.strictEqual(data.version, 1);
      });

      await check('fresh record for this port → present, not stale, full state', async () => {
        const st = BOOT.buildBootState({
          bootId: 'endpoint-boot', phase: 'complete',
          components: {
            static: { required: true, healthy: true, state: 'healthy', port: webPort, host: '127.0.0.1', url: 'http://127.0.0.1:' + webPort + '/InternalBeyond.html', identity: 'InternalBeyond Web' },
            bridge: { healthy: true, state: 'healthy', port: 23115 },
            active: { healthy: false, state: 'offline', reason: { category: 'offline', message: 'no answer' } }
          }
        });
        BOOT.writeBootState(st, { dir: dir });
        const h = await getJson(webPort, '/__boot-state');
        const data = JSON.parse(h.body);
        assert.strictEqual(data.present, true);
        assert.strictEqual(data.ok, true);
        assert.strictEqual(data.stale, false);
        assert.strictEqual(data.staleReason, null);
        assert.strictEqual(data.bootState.overall, 'degraded');
        assert.strictEqual(data.bootState.components.active.reason.category, 'offline');
        assert.ok(typeof data.ageMs === 'number' && data.ageMs >= 0);
      });

      await check('record written for another port is reported stale (web-port-mismatch)', async () => {
        const st = BOOT.buildBootState({ phase: 'complete', components: { static: { required: true, healthy: true, state: 'healthy', port: 1 } } });
        BOOT.writeBootState(st, { dir: dir });
        const data = JSON.parse((await getJson(webPort, '/__boot-state')).body);
        assert.strictEqual(data.stale, true);
        assert.strictEqual(data.staleReason, 'web-port-mismatch');
      });

      await check('old record is reported stale (age)', async () => {
        const st = BOOT.buildBootState({ phase: 'complete', components: { static: { required: true, healthy: true, state: 'healthy', port: webPort } } });
        st.generatedAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
        BOOT.writeBootState(st, { dir: dir });
        const data = JSON.parse((await getJson(webPort, '/__boot-state')).body);
        assert.strictEqual(data.stale, true);
        assert.strictEqual(data.staleReason, 'age');
      });

      await check('endpoint never serves credential-shaped content', async () => {
        fs.writeFileSync(path.join(dir, 'boot-state.json'), JSON.stringify({
          schema: 'internalbeyond.boot-state', version: 1, overall: 'normal',
          generatedAt: new Date().toISOString(),
          apiKey: 'sk-live-abcdef123456',
          components: { static: { port: webPort, note: 'Bearer abcdefghijkl' } }
        }));
        const raw = (await getJson(webPort, '/__boot-state')).body;
        assert.ok(!/sk-live/.test(raw), 'secret value must be scrubbed on read');
        assert.ok(!/Bearer abcdefghijkl/.test(raw));
        assert.ok(!/"apiKey"/.test(raw), 'secret key must be dropped on read');
      });
    } finally {
      if (savedDir === undefined) delete process.env.IB_BOOT_STATE_DIR; else process.env.IB_BOOT_STATE_DIR = savedDir;
      await close(webSrv);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /* ═══ 10. launcher decision helpers (no regression) ═══ */
  section('10. launcher helper contracts (no regression)');

  await check('servicesHealthy / webServerState unchanged', async () => {
    const free = await freePort();
    const launcher = loadLauncher({ IB_WEB_PORT: free });
    try {
      assert.strictEqual(launcher.mod.servicesHealthy([{ name: 'Bridge', online: true }, { name: 'Active', online: true }]), true);
      assert.strictEqual(launcher.mod.servicesHealthy([{ name: 'Bridge', online: true }, { name: 'Active', online: false }]), false);
      assert.strictEqual(await launcher.mod.webServerState(), 'down');
    } finally { launcher.restore(); }
  });

  await check('probeServices reports runner failure instead of faking offline', async () => {
    const launcher = loadLauncher({});
    try {
      const probe = await launcher.mod.probeServices();
      assert.ok(probe && Array.isArray(probe.rows), 'probe must always return rows');
      if (probe.error) assert.ok(probe.error.category, 'failure must carry a category');
    } finally { launcher.restore(); }
  });

  await check('nodeRuntimeInfo identifies the P1 bundled runtime', async () => {
    const launcher = loadLauncher({});
    try {
      const info = launcher.mod.nodeRuntimeInfo();
      assert.ok(['bundled', 'IB_NODE', 'PATH'].includes(info.source), 'source: ' + info.source);
      assert.strictEqual(info.requiredMajor, 18);
      assert.strictEqual(info.bundled, /runtime[\\/]node[\\/]node\.exe$/i.test(info.path));
      assert.ok(info.version.startsWith('v'));
    } finally { launcher.restore(); }
  });

  await check('managerProcessRunning only counts a runner from THIS install', async () => {
    const cp = require('child_process');
    const origExecFile = cp.execFile;
    const thisRoot = path.resolve(__dirname, '..');
    const mine = path.join(thisRoot, 'runtime', 'local-services-runner.js');
    const other = 'C:\\dev\\InternalBeyond-main\\runtime\\local-services-runner.js';
    const probe = (rows) => new Promise((resolve) => {
      cp.execFile = function (file, args, opts, cb) { cb(null, rows.join('\r\n'), ''); };
      delete require.cache[LAUNCH_PATH];
      let mod = null;
      try { mod = require(LAUNCH_PATH); } finally { cp.execFile = origExecFile; }
      mod.managerProcessRunning().then(resolve, () => resolve(null));
    });
    try {
      assert.strictEqual(await probe(['"C:\\Program Files\\nodejs\\node.exe" ' + other]), false,
        'a runner from another install must not count as ours');
      assert.strictEqual(await probe(['"C:\\x\\node.exe" ' + mine]), true,
        'a runner from this install must count');
      assert.strictEqual(await probe([]), false, 'no runner must mean false');
    } finally { cp.execFile = origExecFile; }
  });

  finalize();
})().catch(e => {
  console.error('\nUNEXPECTED FAILURE: ' + (e && e.stack || e));
  console.error('    ' + describeHandles());
  process.exitCode = 1;
});
