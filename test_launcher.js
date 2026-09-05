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

const WEB = require('./internal-beyond-server.js');
const LAUNCH_PATH = require.resolve('./launch-internal-beyond.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
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
    webSrv = WEB.createWebServer({ port: 0, root: __dirname });
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
      assert.strictEqual(WEB.resolveRequest(__dirname, '/../../Windows/win.ini'), null);
      assert.strictEqual(WEB.resolveRequest(__dirname, '/InternalBeyond.html').file.endsWith('InternalBeyond.html'), true);
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

  /* ── 4. runner --json identity parsing (read-only, randomized ports) ── */
  await check('servicesStatus supports offline shape', async () => {
    const mod = reRequireLauncher(await freePort());
    const srv = healthResponder({ ok: true, service: 'internal-beyond-active-messages', version: 1 });
    const ap = await listen(srv);
    try {
      process.env.IB_BRIDGE_PORT = String(await freePort());
      process.env.IB_ACTIVE_PORT = String(ap);
      const rows = await mod.servicesStatus();
      delete process.env.IB_BRIDGE_PORT; delete process.env.IB_ACTIVE_PORT;
      const active = rows.find(r => r.name === 'Active');
      const bridge = rows.find(r => r.name === 'Bridge');
      assert.ok(active && active.online === true, 'Active mock identity should be online');
      assert.ok(bridge && bridge.online === false, 'Bridge on free port should be offline');
    } finally {
      delete process.env.IB_BRIDGE_PORT; delete process.env.IB_ACTIVE_PORT;
      await close(srv);
    }
  });

  /* ── 5. End-to-end reuse path: healthy services + healthy web → reuse, no spawn, ok ── */
  await check('main reuses healthy services + web (no duplicate, ok)', async () => {
    const bridgeSrv = healthResponder({ ok: true, server: 'IB Bridge', version: 2 });
    const activeSrv = healthResponder({ ok: true, service: 'internal-beyond-active-messages', version: 2 });
    const webSrv = WEB.createWebServer({ port: 0, root: __dirname });
    const bp = await listen(bridgeSrv);
    const ap = await listen(activeSrv);
    const wp = await listen(webSrv);
    try {
      process.env.IB_BRIDGE_PORT = String(bp);
      process.env.IB_ACTIVE_PORT = String(ap);
      const mod = reRequireLauncher(wp);
      const result = await mod.main({ silent: true, noOpen: true, servicesTimeout: 5000, webTimeout: 5000 });
      assert.strictEqual(result.ok, true, 'should reuse and succeed');
      assert.ok(result.url.indexOf(':' + wp) !== -1);
    } finally {
      delete process.env.IB_BRIDGE_PORT; delete process.env.IB_ACTIVE_PORT;
      await close(bridgeSrv); await close(activeSrv); await close(webSrv);
    }
  });

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
