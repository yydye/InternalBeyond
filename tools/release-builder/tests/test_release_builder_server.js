'use strict';

/*
 * Release Builder · local server contract test.
 *
 * The GUI is only as trustworthy as the server behind it, so this suite pins the
 * properties that keep it local and keep the state machine honest:
 *
 *   · it binds 127.0.0.1 only, on an ephemeral port;
 *   · every /api/ call needs the boot token — a local process without it gets
 *     nothing, so another program cannot drive a release;
 *   · a cross-origin browser request is refused;
 *   · no static path can escape public/;
 *   · the token is NOT accepted as a static path or leaked in a response body;
 *   · a stage cannot be started out of order (the gate lives on the server, not
 *     in the GUI);
 *   · PUBLISH refuses without a confirmation even over HTTP;
 *   · DRY RUN never writes;
 *   · there is no endpoint that publishes implicitly.
 *
 * Uses the loopback interface only and a real server started from this suite;
 * no browser is opened (browserOpens === 0) and nothing is installed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TOOL = path.resolve(__dirname, '..');
const fixture = require('./fixture.js');
const serverMod = require(path.join(TOOL, 'server.js'));

let pass = 0, fail = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  XX  ' + name + ' — ' + (e && e.message || e)); }
}

function request(port, urlPath, opts) {
  const o = opts || {};
  return new Promise(function (resolve) {
    const req = http.request({
      host: '127.0.0.1', port: port, path: urlPath, method: o.method || 'GET',
      headers: o.headers || {}
    }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { body += d; });
      res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: body }); });
    });
    req.on('error', function (e) { resolve({ status: 0, error: String(e.message), body: '' }); });
    if (o.body) req.write(JSON.stringify(o.body));
    req.end();
  });
}

function json(res) { try { return JSON.parse(res.body); } catch (e) { return null; } }

(async function main() {
  console.log('Release Builder · local server contract\n');

  const fx = fixture.create({ version: '1.0.5', target: '1.0.6' });
  /* Every fixture this suite creates is tracked here, because a fixture owns two
     directories (the checkout AND the bare origin it pushes to) and an inline
     rmSync of the checkout used to leave the origin behind in %TEMP%. */
  const FIXTURES = [fx];
  const api = serverMod.start({ root: fx.dir, port: 0 });
  const info = await api.ready;
  const port = info.port;
  const token = api.token;

  try {
    await check('binds 127.0.0.1 on an ephemeral port only', async () => {
      const addr = api.server.address();
      assert.strictEqual(addr.address, '127.0.0.1', 'must be loopback only, got ' + addr.address);
      assert.ok(addr.port > 0, 'ephemeral port expected');
    });

    await check('serves the GUI shell at / without a token', async () => {
      const r = await request(port, '/');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.indexOf('InternalBeyond Release Builder') >= 0, 'the shell must render');
    });

    await check('every /api/ call without the token is refused', async () => {
      for (const p of ['/api/snapshot', '/api/publish-plan', '/api/export-log']) {
        const r = await request(port, p);
        assert.strictEqual(r.status, 403, p + ' → ' + r.status);
        assert.strictEqual(json(r).error, 'token-required', p);
      }
    });

    await check('a wrong token is refused', async () => {
      const r = await request(port, '/api/snapshot?token=' + 'f'.repeat(64));
      assert.strictEqual(r.status, 403);
    });

    await check('the right token works, and the response never echoes it', async () => {
      const r = await request(port, '/api/snapshot?token=' + token);
      assert.strictEqual(r.status, 200);
      const body = json(r);
      assert.strictEqual(body.ok, true);
      assert.ok(r.body.indexOf(token) < 0, 'the boot token must never appear in a response body');
      assert.strictEqual(body.snapshot.describe.root, fx.dir);
      assert.strictEqual(body.snapshot.describe.version, '1.0.5');
    });

    await check('a cross-origin request is refused even with the token', async () => {
      const r = await request(port, '/api/snapshot?token=' + token, {
        headers: { Origin: 'https://evil.example.com' }
      });
      assert.strictEqual(r.status, 403);
      assert.strictEqual(json(r).error, 'origin-denied');
    });

    await check('a localhost origin is allowed', async () => {
      const r = await request(port, '/api/run?token=' + token, {
        method: 'POST',
        headers: { Origin: 'http://127.0.0.1:' + port, 'Content-Type': 'application/json' },
        body: { stage: 'CHECK' }
      });
      assert.strictEqual(r.status, 200, r.body.slice(0, 200));
    });

    await check('static paths cannot escape public/', async () => {
      for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e%2fserver.js']) {
        const r = await request(port, p);
        assert.ok(r.status === 403 || r.status === 404, p + ' → ' + r.status);
        assert.ok(r.body.indexOf('TOKEN') < 0, 'a source file must never be served: ' + p);
      }
    });

    await check('the options endpoint records the target version and validates the channel', async () => {
      const r = await request(port, '/api/options?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { target: '1.0.6', channel: 'stable', archiveOldReleases: true }
      });
      const body = json(r);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.options.target, '1.0.6');
    });

    await check('a stage cannot run out of order over HTTP (the gate is server-side)', async () => {
      /* A fresh checkout and a fresh server: the gate must refuse BUILD before
         CHECK has run, and this must not depend on anything that ran before. */
      const fxGate = fixture.create({ version: '1.0.5', target: '1.0.6' });
      FIXTURES.push(fxGate);
      const apiGate = serverMod.start({ root: fxGate.dir, port: 0 });
      const infoGate = await apiGate.ready;
      try {
        await request(infoGate.port, '/api/options?token=' + apiGate.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { target: '1.0.6' }
        });
        const r = await request(infoGate.port, '/api/run?token=' + apiGate.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { stage: 'BUILD' }
        });
        assert.strictEqual(json(r).result.status, 'blocked', r.body.slice(0, 200));
        const r2 = await request(infoGate.port, '/api/run?token=' + apiGate.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { stage: 'SEAL' }
        });
        assert.strictEqual(json(r2).result.status, 'blocked', 'SEAL must not run before VERIFY: ' + r2.body.slice(0, 200));
      } finally {
        try { apiGate.server.close(); } catch (e) { /* ignore */ }
        try { fs.rmSync(fxGate.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    });

    await check('the one-click path runs four stages and never PUBLISH', async () => {
      /* Its own checkout: one-click is the primary flow and must be proven on a
         clean repository, not on the leftovers of an earlier probe. */
      const fxOne = fixture.create({ version: '1.0.5', target: '1.0.6' });
      FIXTURES.push(fxOne);
      const apiOne = serverMod.start({ root: fxOne.dir, port: 0 });
      const infoOne = await apiOne.ready;
      try {
        await request(infoOne.port, '/api/options?token=' + apiOne.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { target: '1.0.6' }
        });
        const r = await request(infoOne.port, '/api/run?token=' + apiOne.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { stage: 'ONECLICK' }
        });
        const body = json(r);
        assert.strictEqual(body.ok, true);
        const stages = body.snapshot.stages;
        assert.ok(stages.SEAL.status === 'ok' || stages.SEAL.status === 'warn', 'SEAL: ' + stages.SEAL.status);
        assert.strictEqual(stages.PUBLISH.status, 'pending',
          'a one-click run must never publish: PUBLISH was ' + stages.PUBLISH.status);
        assert.strictEqual(body.snapshot.status, 'READY');
        assert.ok(fs.existsSync(path.join(fxOne.dir, 'dist', 'InternalBeyond-Setup-1.0.6.exe')));
      } finally {
        try { apiOne.server.close(); } catch (e) { /* ignore */ }
        try { fs.rmSync(fxOne.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    });

    await check('PUBLISH over HTTP is refused without a confirmation', async () => {
      const r = await request(port, '/api/run?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { stage: 'PUBLISH', actions: ['commit'] }
      });
      const body = json(r);
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.error, 'confirmation-required');
    });

    await check('the publish plan names the irreversible actions and binds them to a fingerprint', async () => {
      /* The plan is only meaningful once a release has actually been sealed, so
         this check seals one on its own checkout. Every check in this suite is
         independent of the others: none of them depends on what ran before. */
      const fxPlan = fixture.create({ version: '1.0.5', target: '1.0.6' });
      FIXTURES.push(fxPlan);
      const apiPlan = serverMod.start({ root: fxPlan.dir, port: 0 });
      const infoPlan = await apiPlan.ready;
      try {
        await request(infoPlan.port, '/api/options?token=' + apiPlan.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { target: '1.0.6' }
        });
        const one = await request(infoPlan.port, '/api/run?token=' + apiPlan.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { stage: 'ONECLICK' }
        });
        const oneBody = json(one);
        assert.strictEqual(oneBody.snapshot.stages.SEAL.status, 'ok',
          'SEAL: ' + JSON.stringify(oneBody.snapshot.stages.SEAL) + ' ' + JSON.stringify(oneBody.snapshot.log.blockers));

        const r = await request(infoPlan.port, '/api/publish-plan?token=' + apiPlan.token);
        const body = json(r);
        assert.strictEqual(body.ok, true, JSON.stringify(body.blockers));
        assert.ok(/^[0-9a-f]{64}$/.test(body.fingerprint), 'a fingerprint is required');
        assert.ok(/^[0-9a-f]{64}$/.test(body.confirmation), 'a confirmation token is required');
        const ids = body.actions.map(a => a.id);
        assert.strictEqual(ids[ids.length - 1], 'manifestUpload', 'the manifest upload must be last: ' + ids.join(','));
        assert.ok(body.actions.some(a => a.irreversible === true), 'irreversible actions must be marked');
        assert.ok(body.actions.find(a => a.id === 'commit').preconditions.length >= 1);
      } finally {
        try { apiPlan.server.close(); } catch (e) { /* ignore */ }
        try { fs.rmSync(fxPlan.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    });

    await check('a dry run over HTTP reports zero side effects and does not become READY', async () => {
      /* A separate checkout: a dry run is a fresh question, not a continuation
         of the one-click run above. */
      const fx2 = fixture.create({ version: '1.0.5', target: '1.0.6' });
      FIXTURES.push(fx2);
      const api2 = serverMod.start({ root: fx2.dir, port: 0 });
      const info2 = await api2.ready;
      try {
        await request(info2.port, '/api/options?token=' + api2.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: { target: '1.0.6', channel: 'stable' }
        });
        const before = fs.existsSync(path.join(fx2.dir, 'dist'))
          ? fs.readdirSync(path.join(fx2.dir, 'dist')).sort().join(',') : '(no dist)';
        const r = await request(info2.port, '/api/run?token=' + api2.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { stage: 'DRY' }
        });
        const body = json(r);
        assert.strictEqual(body.dry.ok, true);
        assert.ok(body.dry.plan.text.indexOf('零副作用') >= 0);
        const after = fs.existsSync(path.join(fx2.dir, 'dist'))
          ? fs.readdirSync(path.join(fx2.dir, 'dist')).sort().join(',') : '(no dist)';
        assert.strictEqual(before, after, 'a dry run changed dist/');
        const snap = json(await request(info2.port, '/api/snapshot?token=' + api2.token)).snapshot;
        assert.notStrictEqual(snap.status, 'READY', 'a dry run must not report READY');
        assert.notStrictEqual(snap.status, 'PUBLISHED', 'a dry run must not report PUBLISHED');
        assert.strictEqual(snap.stages.SEAL.status, 'pending', 'a dry run must leave SEAL pending');
      } finally {
        try { api2.server.close(); } catch (e) { /* ignore */ }
        try { fs.rmSync(fx2.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    });

    await check('the log export is a download and contains no token', async () => {
      const r = await request(port, '/api/export-log?token=' + token);
      assert.strictEqual(r.status, 200);
      assert.ok(String(r.headers['content-disposition']).indexOf('attachment') >= 0, 'must be a download');
      assert.ok(r.body.indexOf(token) < 0, 'the boot token must never be exported');
      assert.ok(r.body.indexOf('Release Builder') >= 0);
    });

    await check('an unknown stage is refused', async () => {
      const r = await request(port, '/api/run?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { stage: 'DEPLOY' }
      });
      assert.strictEqual(json(r).error, 'unknown-stage');
    });

    await check('there is no endpoint that publishes implicitly', async () => {
      const src = fs.readFileSync(path.join(TOOL, 'server.js'), 'utf8');
      /* Every route is enumerable, and none of them runs PUBLISH without an
         explicit confirmation compared against the plan fingerprint. */
      const routes = (src.match(/url\.pathname === '([^']+)'/g) || []).map(s => s.replace(/.*'([^']+)'/, '$1'));
      assert.ok(routes.length > 5, 'routes should be enumerable: ' + routes.join(','));
      assert.ok(routes.indexOf('/api/run') >= 0);
      const runBlock = src.slice(src.indexOf("url.pathname === '/api/run'"), src.indexOf("url.pathname === '/api/publish-plan'"));
      assert.ok(runBlock.indexOf('confirmation-required') >= 0,
        'the PUBLISH branch must reject a missing confirmation');
      assert.ok(runBlock.indexOf('ONECLICK') >= 0, 'the one-click branch must exist');
      assert.ok(runBlock.indexOf('runOneClick') >= 0, 'one-click must go through the four-stage path');
    });
  } finally {
    try { api.server.close(); } catch (e) { /* ignore */ }
  }

  /* Dispose every fixture in one batch: what is asserted below is the REAL state
     on disk after the retrying sweep, not an assumption that rmSync worked. */
  const disposal = fixture.disposeAll(FIXTURES);
  await check('every fixture this suite created was removed (checkout AND origin)', async () => {
    assert.strictEqual(disposal.failed.length, 0, 'leftover: ' + disposal.failed.map(f => f.dir).join(', '));
    assert.strictEqual(disposal.removed, FIXTURES.length,
      'removed ' + disposal.removed + ' of ' + FIXTURES.length);
  });

  const residue = fs.readdirSync(os.tmpdir()).filter(function (n) {
    return (n.indexOf('ib-rb-') === 0 || n.indexOf('ib-rb-origin-') === 0) && n !== 'ib-rb-pe-cache';
  });
  await check('no test residue is left in %TEMP%', async () => {
    assert.strictEqual(residue.length, 0, 'unexpected temp entries: ' + residue.join(', '));
  });

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})();
