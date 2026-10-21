'use strict';

/* Launcher + static web server regression (Node, zero browser).
   Covers:
     - static server /health identity + MIME + path-traversal guard
     - launcher webServerState: healthy / conflict / down (idempotent reuse decision)
     - launcher servicesHealthy decision
     - runner --json service identity parsing (reuse of local-services-runner read-only status) */

const assert = require('assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const ORIGINAL_LOCALAPPDATA = process.env.LOCALAPPDATA;
const TEST_LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-launcher-local-'));
process.env.LOCALAPPDATA = TEST_LOCALAPPDATA;

const WEB = require(path.join(ROOT, 'services', 'internal-beyond-server.js'));
const LAUNCH_PATH = require.resolve(path.join(ROOT, 'runtime', 'launch-internal-beyond.js'));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
function healthResponder(payload) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}
function reRequireLauncher(webPort) {
  delete require.cache[LAUNCH_PATH];
  const prev = process.env.IB_WEB_PORT;
  process.env.IB_WEB_PORT = String(webPort);
  const mod = require(LAUNCH_PATH);

  if (prev == null) delete process.env.IB_WEB_PORT; else process.env.IB_WEB_PORT = prev;
  return mod;
}
function getJson(port, pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1500 }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: raw }));
    });
    req.on('error', () => resolve({ status: 0, type: '', body: '' }));
  });
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

(async () => {
  console.log('Launcher / static server regression\n');

  /* ── 1. Static server endpoints ── */
  let webSrv, webPort;
  try {
    webSrv = WEB.createWebServer({ port: 0, root: ROOT });
    webPort = await listen(webSrv);
    await check('web health identity', async () => {
      const h = await getJson(webPort, '/health');
      const data = JSON.parse(h.body);
      assert.strictEqual(h.status, 200);
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.server, 'InternalBeyond Web');
    });
    await check('web serves InternalBeyond.html', async () => {
      const h = await getJson(webPort, '/InternalBeyond.html');
      assert.strictEqual(h.status, 200);
      assert.ok(/<html/i.test(h.body));
    });
    await check('web serves worklet with JS MIME', async () => {
      const h = await getJson(webPort, '/assets/js/voice-worklet.js');
      assert.strictEqual(h.status, 200);
      assert.ok(/javascript/i.test(h.type));
      assert.ok(h.body.includes('registerProcessor'));
    });
    await check('web directory index -> InternalBeyond.html', async () => {
      const h = await getJson(webPort, '/');
      assert.strictEqual(h.status, 200);
      assert.ok(/<html/i.test(h.body));
    });
    await check('web blocks path traversal', async () => {
      const h = await getJson(webPort, '/..%2f..%2f..%2fWindows%2fwin.ini');
      assert.strictEqual(h.status, 404);
    });
    await check('web 404 unknown', async () => {
      const h = await getJson(webPort, '/nope.xyz');
      assert.strictEqual(h.status, 404);
    });
    check('resolveRequest escapes root -> null', () => {
      assert.strictEqual(WEB.resolveRequest(ROOT, '/../../Windows/win.ini'), null);
      assert.strictEqual(WEB.resolveRequest(ROOT, '/InternalBeyond.html').file.endsWith('InternalBeyond.html'), true);
    });
  } finally {
    if (webSrv) await close(webSrv);
  }

  /* ── 2. Launcher webServerState: healthy / conflict / down (reuse decision) ── */
  {
    const healthy = healthResponder({ ok: true, server: 'InternalBeyond Web' });
    const conflict = healthResponder({ ok: true, server: 'Some Other Server' });
    const hp = await listen(healthy);
    const cp = await listen(conflict);
    const free = await freePort();
    try {
      await check('webServerState healthy -> reused (no duplicate)', async () => {
        assert.strictEqual(await reRequireLauncher(hp).webServerState(), 'healthy');
      });
      await check('webServerState conflict (wrong identity)', async () => {
        assert.strictEqual(await reRequireLauncher(cp).webServerState(), 'conflict');
      });
      await check('webServerState down (free port)', async () => {
        assert.strictEqual(await reRequireLauncher(free).webServerState(), 'down');
      });
      await check('webHealthy true only for our identity', async () => {
        assert.strictEqual(await reRequireLauncher(hp).webHealthy(), true);
        assert.strictEqual(await reRequireLauncher(cp).webHealthy(), false);
      });
    } finally {
      await close(healthy); await close(conflict);
    }
  }

  /* ── 3. servicesHealthy decision (pure) ── */
  await check('servicesHealthy true when Bridge+Active online', async () => {
    const mod = reRequireLauncher(await freePort());
    assert.strictEqual(mod.servicesHealthy([{ name: 'Bridge', online: true }, { name: 'Active', online: true }]), true);
  });
  await check('servicesHealthy false when one offline', async () => {
    const mod = reRequireLauncher(await freePort());
    assert.strictEqual(mod.servicesHealthy([{ name: 'Bridge', online: true }, { name: 'Active', online: false }]), false);
  });
  await check('servicesHealthy false when rows empty', async () => {
    const mod = reRequireLauncher(await freePort());
    assert.strictEqual(mod.servicesHealthy([]), false);
  });
  await check('Runner ownership requires the exact script path, not a nested repo copy', async () => {
    const mod = reRequireLauncher(await freePort());
    const expectedRunner = path.join(mod.ROOT, 'runtime', 'local-services-runner.js');
    assert.strictEqual(mod.managerCommandMatchesRunner('node.exe "' + expectedRunner + '"'), true);
    const nestedCopy = path.join(mod.ROOT, 'tmp', 'coastline-webview-final', 'runtime', 'local-services-runner.js');
    assert.strictEqual(mod.managerCommandMatchesRunner('node.exe "' + nestedCopy + '"'), false);
    const productionCopy = 'C:\\Users\\admin\\AppData\\Local\\Programs\\InternalBeyond\\runtime\\local-services-runner.js';
    assert.strictEqual(mod.managerCommandMatchesRunner('node.exe "' + productionCopy + '"'), false);
  });

  /* ── 4. runner --json identity parsing (read-only, randomized ports) ── */
  await check('servicesStatus supports offline shape', async () => {
    const original = {
      bridge: process.env.IB_BRIDGE_PORT,
      active: process.env.IB_ACTIVE_PORT,
      homeNode: process.env.IB_HOME_NODE_PORT,
      restart: process.env.IB_RESTART_PORT,
      dev: process.env.IB_DEV_MODE
    };
    const srv = healthResponder({ ok: true, service: 'internal-beyond-active-messages', version: 1 });
    const ap = await listen(srv);
    try {
      process.env.IB_BRIDGE_PORT = String(await freePort());
      process.env.IB_ACTIVE_PORT = String(ap);
      process.env.IB_HOME_NODE_PORT = String(await freePort());
      process.env.IB_RESTART_PORT = String(await freePort());
      process.env.IB_DEV_MODE = '0';
      const mod = reRequireLauncher(await freePort());
      const rows = await mod.servicesStatus();
      const active = rows.find(r => r.name === 'Active');
      const bridge = rows.find(r => r.name === 'Bridge');
      assert.ok(active && active.online === true, 'Active mock identity should be online');
      assert.ok(bridge && bridge.online === false, 'Bridge on free port should be offline: ' + JSON.stringify(rows));
    } finally {
      for (const [key, value] of Object.entries({
        IB_BRIDGE_PORT: original.bridge,
        IB_ACTIVE_PORT: original.active,
        IB_HOME_NODE_PORT: original.homeNode,
        IB_RESTART_PORT: original.restart,
        IB_DEV_MODE: original.dev
      })) {
        if (value == null) delete process.env[key]; else process.env[key] = value;
      }
      await close(srv);
    }
  });

  await check('launcher reads the negotiated Home Node port from its compatible Runner', async () => {
    const restartPort = await freePort();
    const preferredHomePort = await freePort();
    const actualHomePort = await freePort();
    const unrelated = healthResponder({ ok: true, service: 'unrelated-port-holder' });
    await listenOn(unrelated, preferredHomePort);
    const rows = [
      { name: 'Bridge', componentId: 'bridge', online: true, port: 23115 },
      { name: 'Active', componentId: 'active', online: true, port: 23114 },
      { name: 'HomeNode', componentId: 'homeNode', online: true, port: actualHomePort }
    ];
    const control = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/status') {
        res.end(JSON.stringify({ ok: true, service: 'InternalBeyond Restart', environment: 'production', pid: 12345 }));
      } else if (req.url === '/components') {
        res.end(JSON.stringify({ ok: true, service: 'InternalBeyond Restart', pid: 12345, services: rows }));
      } else {
        res.writeHead(404); res.end('{}');
      }
    });
    await listenOn(control, restartPort);
    const previous = {
      restart: process.env.IB_RESTART_PORT,
      preferred: process.env.IB_HOME_NODE_PORT,
      dev: process.env.IB_DEV_MODE,
      hostSession: process.env.IB_TAURI_HOST_INSTANCE_ID
    };
    try {
      process.env.IB_RESTART_PORT = String(restartPort);
      process.env.IB_HOME_NODE_PORT = String(preferredHomePort);
      process.env.IB_DEV_MODE = '0';
      delete process.env.IB_TAURI_HOST_INSTANCE_ID;
      const mod = reRequireLauncher(await freePort());
      const result = await mod.ensureServices({ servicesTimeout: 100 });
      const homeNode = result.components.homeNode;
      assert.strictEqual(homeNode.healthy, true, 'the live Runner health snapshot should be used');
      assert.strictEqual(homeNode.port, actualHomePort, 'status should carry the negotiated port, not the preferred port');
      assert.strictEqual((await getJson(preferredHomePort, '/health')).status, 200, 'the unrelated preferred-port listener remains alive');
    } finally {
      for (const [key, value] of Object.entries({
        IB_RESTART_PORT: previous.restart,
        IB_HOME_NODE_PORT: previous.preferred,
        IB_DEV_MODE: previous.dev,
        IB_TAURI_HOST_INSTANCE_ID: previous.hostSession
      })) {
        if (value == null) delete process.env[key]; else process.env[key] = value;
      }
      await close(control);
      await close(unrelated);
    }
  });

  /* ── 5. End-to-end reuse path: healthy services + healthy web → reuse, no spawn, ok ── */
  await check('main reuses healthy services + web (no duplicate, ok)', async () => {
    const bridgeSrv = healthResponder({ ok: true, server: 'IB Bridge', version: 2 });
    const activeSrv = healthResponder({ ok: true, service: 'internal-beyond-active-messages', version: 2 });
    const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
    const bp = await listen(bridgeSrv);
    const ap = await listen(activeSrv);
    const wp = await listen(webSrv);
    /* P2: boot-state must never be written to the real per-user location by a test. */
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-launcher-'));
    try {
      process.env.IB_BRIDGE_PORT = String(bp);
      process.env.IB_ACTIVE_PORT = String(ap);
      const mod = reRequireLauncher(wp);
      const result = await mod.main({ silent: true, noOpen: true, servicesTimeout: 5000, webTimeout: 5000, stateDir: stateDir });
      assert.strictEqual(result.ok, true, 'should reuse and succeed');
      assert.ok(result.url.indexOf(':' + wp) !== -1);
      assert.strictEqual(result.overall, 'normal', 'all-healthy reuse must classify as normal');
      const written = JSON.parse(fs.readFileSync(path.join(stateDir, 'boot-state.json'), 'utf8'));
      assert.strictEqual(written.overall, 'normal');
      assert.strictEqual(written.components.static.reused, true);
    } finally {
      delete process.env.IB_BRIDGE_PORT; delete process.env.IB_ACTIVE_PORT;
      await close(bridgeSrv); await close(activeSrv); await close(webSrv);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (ORIGINAL_LOCALAPPDATA == null) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
  fs.rmSync(TEST_LOCALAPPDATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => {
  if (ORIGINAL_LOCALAPPDATA == null) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
  try { fs.rmSync(TEST_LOCALAPPDATA, { recursive: true, force: true }); } catch (_) {}
  console.error(e && e.stack || e); process.exit(1);
});
