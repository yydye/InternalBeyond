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
      assert.ok(r.body.indexOf('InternalBeyond') >= 0 && /Release Builder/.test(r.body),
        'the shell must render');
    });

    await check('the GUI shell carries the screen the workflow needs, and no inline script', async () => {
      const r = await request(port, '/');
      /* The R2 screen is judged on what it shows: a four-stage pipeline, the
         status facts, the artifact block, the notes editor and the separate
         publish entry point. A missing id here is a missing screen element, so
         this is a contract on the shipped markup, not a style preference. */
      for (const id of ['pipeline', 'flow-steps', 'facts', 'card-result', 'artifact', 'alerts',
        'btn-check', 'btn-build', 'btn-open-dist', 'btn-notes', 'btn-publish', 'notes-modal',
        'notes-text', 'publish-modal', 'publish-confirm', 'logbar-body']) {
        assert.ok(r.body.indexOf('id="' + id + '"') >= 0, 'the shell has no #' + id);
      }
      assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(r.body),
        'the page carries an inline script; the boot token must never be inlined into markup');
    });

    await check('the notes editor writes only the canonical release-notes file, and nothing else', async () => {
      /* The canonical path is the one lib/publish.js hands to `gh release
         create --notes-file`; the GUI editor must reach exactly that file and
         no other. Everything below is asserted against the REAL checkout. */
      const rel = 'docs/release-notes/1.0.6.md';
      const abs = path.join(fx.dir, rel);

      /* The path is a function of the target, so the target must be set first —
         exactly as the GUI does it before it offers the editor at all. */
      await request(port, '/api/options?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { target: '1.0.6' }
      });

      const pre = json(await request(port, '/api/notes?token=' + token));
      assert.strictEqual(pre.ok, true, 'GET must answer: ' + JSON.stringify(pre));
      assert.strictEqual(pre.rel, rel, 'the canonical path is derived, not supplied by the caller');
      assert.strictEqual(pre.exists, true, 'the fixture ships notes for 1.0.6');
      assert.ok(pre.content.indexOf('1.0.6') >= 0, 'the editor must read the real file');

      /* A browser textarea posts CRLF; the file on disk must still be LF so the
         manifest's `notes` and the file can never differ by line endings. */
      const text = '# InternalBeyond 1.0.6\n\n第二行。\n';
      const w = json(await request(port, '/api/notes?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { content: text.replace(/\n/g, '\r\n') }
      }));
      assert.strictEqual(w.ok, true, 'write failed: ' + JSON.stringify(w));
      assert.strictEqual(w.rel, rel);
      assert.strictEqual(w.created, false);
      const onDisk = fs.readFileSync(abs, 'utf8');
      assert.strictEqual(onDisk, text, 'the file must be written as-is with LF endings: ' + JSON.stringify(onDisk));
      assert.ok(onDisk.indexOf('\r') < 0, 'CRLF must never reach the canonical notes file');

      /* Deleting the target's notes must be reported as "not written yet", and
         a fresh write must CREATE the file rather than fail. */
      fs.rmSync(abs);
      const gone = json(await request(port, '/api/notes?token=' + token));
      assert.strictEqual(gone.exists, false);
      const created = json(await request(port, '/api/notes?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { content: '# created by the GUI\n' }
      }));
      assert.strictEqual(created.created, true, 'a missing file must be created: ' + JSON.stringify(created));
      assert.strictEqual(fs.readFileSync(abs, 'utf8'), '# created by the GUI\n');

      /* No version, no path: the caller cannot name a file of its own. */
      await request(port, '/api/options?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { target: '' }
      });
      const noTarget = json(await request(port, '/api/notes?token=' + token));
      assert.strictEqual(noTarget.ok, false);
      assert.strictEqual(noTarget.error, 'bad-target');

      await request(port, '/api/options?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { target: '../../VERSION' }
      });
      const traversal = json(await request(port, '/api/notes?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { content: 'x\n' }
      }));
      assert.strictEqual(traversal.ok, false, 'a path-shaped target must be refused');
      assert.strictEqual(fs.readFileSync(path.join(fx.dir, 'VERSION'), 'utf8').trim(), '1.0.5',
        'VERSION must be untouched');

      await request(port, '/api/options?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { target: '1.0.6' }
      });
      const tooBig = json(await request(port, '/api/notes?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { content: 'x'.repeat(300 * 1024) }
      }));
      assert.strictEqual(tooBig.error, 'notes-too-large', 'the editor must not be a way to write a huge file');
    });

    await check('opening a folder takes a fixed keyword, never a path', async () => {
      /* A path-shaped argument is refused outright: the GUI can ask to open the
         dist folder or this release's log, and can ask for nothing else. */
      const bad = await request(port, '/api/reveal?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { what: '../../' }
      });
      assert.strictEqual(bad.status, 400, 'only the two fixed keywords are accepted');
      const missing = await request(port, '/api/reveal?token=' + token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { what: 'dist' }
      });
      assert.strictEqual(missing.status, 200);
      const m = json(missing);
      /* Either dist does not exist yet (the honest "build first" answer) or the
         open itself was attempted; both are fine, a crash is not. */
      assert.ok(m.ok === true || m.error === 'dist-missing', 'unexpected: ' + JSON.stringify(m));
    });

    await check('the notes editor cannot be aimed at a path the caller chose', async () => {
      /*
       * Two facts, both about the same guarantee: the file the editor writes is
       * a function of (resolved root, target version) and of nothing else.
       *
       * This test performs NO write at all, and that is deliberate. An earlier
       * version of it pointed a server at a disposed fixture and then POSTed
       * "just to see" — but discovery falls back to walking up from the tool, so
       * that server resolved to the REAL checkout and the probe write landed in
       * the real docs/release-notes/. A test for a write boundary must not be
       * able to write outside its fixture, so the write path is checked by
       * construction instead: no root, or no target, means no write.
       */
      const absent = path.join(os.tmpdir(), 'ib-rb-does-not-exist-' + Date.now());
      assert.strictEqual(fs.existsSync(absent), false, 'the probe path must not exist');

      const apiNoRepo = serverMod.start({ root: absent, port: 0 });
      const infoNoRepo = await apiNoRepo.ready;
      try {
        assert.notStrictEqual(infoNoRepo.root, absent, 'a deleted path must never be accepted as the root');

        /* 1. No target version means no path, which means no write — the same
              answer whether or not a checkout was found. */
        const noTarget = json(await request(infoNoRepo.port, '/api/notes?token=' + apiNoRepo.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { content: '# x\n' }
        }));
        assert.strictEqual(noTarget.ok, false);
        assert.strictEqual(noTarget.error, 'bad-target');
        assert.strictEqual(fs.existsSync(path.join(absent, 'docs')), false, 'nothing may be created where we pointed');
      } finally {
        apiNoRepo.server.close();
      }

      /* 2. With a target but no checkout, the write is refused outright.
            Discovery is pinned for this case rather than argued with: the tool
            lives inside a real checkout, so `walkUp(__dirname)` legitimately
            finds one, and no environment variable can talk it out of that. The
            seam is stubbed to model "there is no checkout anywhere", which is
            the state this branch exists for, and it is restored immediately. */
      const canonicalMod = require(path.join(TOOL, 'lib', 'canonical.js'));
      const realDiscover = canonicalMod.discover;
      const fakeRoot = path.join(os.tmpdir(), 'ib-rb-not-a-checkout-' + Date.now());
      canonicalMod.discover = function () { return { root: null, via: null, tried: ['stubbed'] }; };
      const apiBare = serverMod.start({ root: fakeRoot, port: 0 });
      try {
        const infoBare = await apiBare.ready;
        assert.strictEqual(infoBare.root, null, 'no checkout may be resolved in this case');
        await request(infoBare.port, '/api/options?token=' + apiBare.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { target: '1.0.6' }
        });
        const r = json(await request(infoBare.port, '/api/notes?token=' + apiBare.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { content: '# probe\n' }
        }));
        assert.strictEqual(r.ok, false, 'no checkout, no write');
        assert.strictEqual(r.error, 'no-repo');
        assert.strictEqual(fs.existsSync(path.join(fakeRoot, 'docs')), false, 'no file may be created anywhere');

        const reveal = json(await request(infoBare.port, '/api/reveal?token=' + apiBare.token, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { what: 'dist' }
        }));
        assert.strictEqual(reveal.ok, false, 'reveal must also refuse without a checkout');
        assert.strictEqual(reveal.error, 'no-repo');
      } finally {
        canonicalMod.discover = realDiscover;
        apiBare.server.close();
      }
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
