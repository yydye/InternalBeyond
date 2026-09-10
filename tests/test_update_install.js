'use strict';

/* U3 · update install runtime (download → verify → spawn → exit).
 *
 * What this locks:
 *   [1] the U-D6 payload fallback gate — the API asset route is reached ONLY
 *       when the primary produced no complete HTTP response entity, and every
 *       hard failure is FINAL (the API is never touched at all)
 *   [2] the verification gates: Content-Length, actual size, sha256, and the PE
 *       ProductVersion/FileVersion identity — all checked on a .part file that
 *       is deleted on any mismatch, renamed atomically only when everything holds
 *   [3] the payload never lands in {app}
 *   [4] the spawn contract (frozen U-D3 arguments, shell:false, detached,
 *       unref'd) and the U-D5 promise that the helper exits immediately
 *   [5] the install state file: honest, never a lie, and stale-safe
 *   [6] the helper resolves its own manifest from the verified cache — nobody
 *       hands it a URL, a hash or a path
 *   [7] POST /__update/start and GET /__update-status contracts
 *   [8] wiring: release payload, launch path, no stop/relaunch in the helper
 *
 * NO NETWORK. Every payload transfer is driven through an injected transport
 * that drives the real sink exactly as runtime/update-transport.js does. No
 * installer is ever built or run: the one real process test spawns node.exe, and
 * only to prove that a detached child outlives its parent.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ui = require(path.join(ROOT, 'runtime', 'update-install.js'));
const transport = require(path.join(ROOT, 'runtime', 'update-transport.js'));
const um = require(path.join(ROOT, 'runtime', 'update-manifest.js'));
const uc = require(path.join(ROOT, 'runtime', 'update-check.js'));
const fixture = require(path.join(__dirname, 'pe-fixture.js'));

const VERSION = '1.2.0';
const NEWER = '1.2.1';
const SHA_OK = 'a'.repeat(64);

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(function () { pass++; console.log('  ✓ ' + name); },
        function (e) { fail++; failures.push(name + ': ' + ((e && e.message) || e)); console.log('  ✗ ' + name + ' — ' + ((e && e.message) || e)); });
    }
    pass++; console.log('  ✓ ' + name);
  } catch (e) {
    fail++; failures.push(name + ': ' + ((e && e.message) || e));
    console.log('  ✗ ' + name + ' — ' + ((e && e.message) || e));
  }
  return Promise.resolve();
}
function section(title) { console.log('\n' + title); }

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-u3-'));
let seq = 0;
function tmpDir(tag) {
  const dir = path.join(tmpRoot, (tag || 'd') + (++seq));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/*
 * A synthetic installer payload: a real PE image whose version resource says
 * `version`. Trailing padding is harmless to the PE reader (it only ever reads
 * the headers and the resource section) and lets a fixture be padded past
 * update-manifest.js's "an installer always bundles Node" floor so the REAL
 * validator accepts the manifest that describes it.
 */
function pePayload(version, padTo) {
  const pe = fixture.buildPe({ productVersion: version, fileVersion: version + '.0' });
  const size = Number(padTo) || 0;
  return size > pe.length ? Buffer.concat([pe, Buffer.alloc(size - pe.length, 0x5a)]) : pe;
}

/* A manifest object shaped like a validated one. `downloadInstaller` consumes
   validated manifests and is not itself the validator, so most tests use a small
   payload; the cache-driven tests below use a padded one through the real
   validator. */
function manifestFor(version, payload) {
  const bytes = payload || pePayload(version);
  return {
    schema: um.SCHEMA, schemaVersion: um.SCHEMA_VERSION, channel: um.CHANNEL_STABLE,
    version: version,
    installer: {
      url: um.installerUrl(version),
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
      productVersion: version
    }
  };
}

function networkResult(kind) {
  return { outcome: 'network', kind: kind || 'reset', message: 'socket died', status: null, headers: null, body: '', finalUrl: null, hops: [] };
}
function protocolResult(kind, status, message) {
  return { outcome: 'protocol', kind: kind, message: message || kind, status: typeof status === 'number' ? status : null, headers: null, body: '', finalUrl: null, hops: [] };
}
function textResult(body, status) {
  return {
    outcome: 'response', kind: null, message: null, status: typeof status === 'number' ? status : 200,
    headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body), finalUrl: null, hops: []
  };
}

/*
 * The fake transport. For a payload request it drives the REAL sink (head, then
 * chunks, then end) exactly as runtime/update-transport.js does, including
 * calling onAbort() for every non-response ending. For any other request it
 * answers with a text body.
 *
 * A route is a descriptor:
 *   { net:'reset' }                       transport failure
 *   { status:404 } / { protocol:'x' }     a response we refuse
 *   { text:'…' | object }                 a JSON document
 *   { payload: Buffer, chunks:n }         a payload body
 *   { omitLength:true }                   no Content-Length header
 *   { declared:n }                        a Content-Length that is not the truth
 *   { dropAfter:n }                       a network failure n chunks in
 *   { declares:false }                    a failure for the API metadata URL
 */
function fakeTransport(routes) {
  const calls = [];
  const fn = function (url, opts) {
    const o = opts || {};
    const sink = o.sink;
    const entry = { url: url, accept: o.accept || '', fileSink: !!(sink && sink.kind === 'file'), fed: 0 };
    calls.push(entry);
    let route = null;
    for (const key of Object.keys(routes)) {
      if (url.indexOf(key) >= 0) { route = routes[key]; break; }
    }
    if (!route) return Promise.resolve(protocolResult('unscripted-url', null, 'no route for ' + url));
    if (typeof route === 'function') route = route(url, opts);

    if (route.net) return Promise.resolve(networkResult(route.net));
    if (route.status && !route.payload && !route.text) {
      return Promise.resolve(protocolResult(route.protocol || 'http-status', route.status, 'HTTP ' + route.status));
    }
    if (route.protocol) return Promise.resolve(protocolResult(route.protocol, route.status || null));

    if (!entry.fileSink) return Promise.resolve(textResult(route.text !== undefined ? route.text : route));

    /* ── drive the file sink ────────────────────────────────────────────── */
    const bytes = route.payload || Buffer.alloc(0);
    const head = {};
    if (!route.omitLength) head['content-length'] = String(route.declared !== undefined ? route.declared : bytes.length);
    const end = function (kind, message) {
      if (sink.onAbort) sink.onAbort();
      return Promise.resolve(protocolResult(kind, route.status || 200, message));
    };
    const verdict = sink.onResponse ? sink.onResponse(route.status || 200, head) : null;
    if (verdict) return end(verdict.kind, verdict.message);

    const chunkSize = route.chunks ? Math.max(1, Math.ceil(bytes.length / route.chunks)) : bytes.length;
    for (let at = 0; at < bytes.length; at += chunkSize) {
      entry.fed += 1;
      if (route.dropAfter !== undefined && entry.fed > route.dropAfter) {
        if (sink.onAbort) sink.onAbort();
        return Promise.resolve(networkResult('reset'));
      }
      const v = sink.onData(bytes.slice(at, at + chunkSize));
      if (v) return end(v.kind, v.message);
    }
    const finished = sink.onEnd(route.status || 200, head);
    if (finished.kind) return end(finished.kind, finished.message);
    return Promise.resolve({
      outcome: 'response', kind: null, message: null, status: route.status || 200,
      headers: head, body: finished.value, finalUrl: url, hops: []
    });
  };
  fn.calls = calls;
  fn.urls = function () { return calls.map(function (c) { return c.url; }); };
  return fn;
}

function installerRoutes(payload) {
  const r = {};
  r['/releases/download/'] = { payload: payload };
  return r;
}

/* Source with comments removed, so a static assertion can be about code without
   tripping over prose that explains the same rule. Block comments go first (they
   may be several lines), then trailing line comments. */
function codeOnly(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return src.split(String.fromCharCode(10)).map(function (line) {
    const at = line.indexOf('//');
    return at >= 0 ? line.slice(0, at) : line;
  }).join(String.fromCharCode(10));
}

/* The same bytes with one bit flipped: same length, same PE header, different
   hash — the only way to reach the SHA-256 gate without the size gate firing
   first. */
function flipOneByte(buf) {
  const copy = Buffer.from(buf);
  copy[copy.length - 1] = copy[copy.length - 1] ^ 0xff;
  return copy;
}

async function main() {
  console.log('Update install runtime (U3)\n');

  /* ═══ [1] primary route and the U-D6 fallback gate ════════════════════ */
  section('[1] the payload fallback gate (U-D6)');

  await check('the primary payload route is the manifest URL, used verbatim', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const t = fakeTransport(installerRoutes(payload));
    const r = await ui.downloadInstaller({ manifest: manifest, dir: tmpDir('primary'), transport: t });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.transport, 'direct');
    assert.deepStrictEqual(t.urls(), [manifest.installer.url]);
    assert.strictEqual(t.calls[0].url, um.installerUrl(VERSION),
      'the URL must be the manifest contract constructor, version-pinned');
    assert.ok(fs.existsSync(r.file), 'the verified payload must be in place');
  });

  await check('an HTTP error response is FINAL: the API is never called', async () => {
    for (const status of [404, 403, 429, 500, 503]) {
      const manifest = manifestFor(VERSION);
      const t = fakeTransport({ '/releases/download/': { status: status } });
      const r = await ui.downloadInstaller({ manifest: manifest, dir: tmpDir('http'), transport: t });
      assert.strictEqual(r.ok, false, 'HTTP ' + status + ' must fail');
      assert.strictEqual(t.calls.length, 1, 'HTTP ' + status + ' must not reach the API (got ' + t.urls().join(', ') + ')');
      assert.ok(['http-status', 'rate-limited'].indexOf(r.kind) >= 0, 'kind: ' + r.kind);
    }
  });

  await check('a refused redirect is FINAL: the API is never called', async () => {
    const t = fakeTransport({ '/releases/download/': { protocol: 'redirect-host-not-allowed', status: 302 } });
    const r = await ui.downloadInstaller({ manifest: manifestFor(VERSION), dir: tmpDir('redir'), transport: t });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'redirect-host-not-allowed');
    assert.strictEqual(t.calls.length, 1, 'a security refusal must not become a reason to try the other route');
  });

  await check('verification failures are FINAL: the API is never called', async () => {
    const payload = pePayload(VERSION);
    const cases = [
      ['missing Content-Length', { payload: payload, omitLength: true }, 'content-length-invalid'],
      ['Content-Length disagrees with the manifest', { payload: payload, declared: payload.length + 5 }, 'size-mismatch'],
      ['body is truncated', { payload: payload.slice(0, payload.length - 8), declared: payload.length }, 'size-mismatch'],
      ['bytes are not the published bytes', { payload: flipOneByte(payload) }, 'sha256-mismatch']
    ];
    for (const [label, route, expected] of cases) {
      const manifest = manifestFor(VERSION, payload);
      const t = fakeTransport({ '/releases/download/': route });
      const r = await ui.downloadInstaller({ manifest: manifest, dir: tmpDir('verify'), transport: t });
      assert.strictEqual(r.ok, false, label + ' must fail');
      assert.strictEqual(r.kind, expected, label + ': got ' + r.kind + ' (' + r.why + ')');
      assert.strictEqual(t.calls.length, 1, label + ' must not reach the API');
    }
  });

  await check('a PE version mismatch is FINAL and deletes the payload', async () => {
    const payload = pePayload('9.9.9');                 /* hash matches, version does not */
    const manifest = manifestFor(VERSION, payload);     /* manifest says 1.2.0 */
    const dir = tmpDir('pe');
    const t = fakeTransport(installerRoutes(payload));
    const r = await ui.downloadInstaller({ manifest: manifest, dir: dir, transport: t });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'pe-version-mismatch', r.why);
    assert.strictEqual(t.calls.length, 1, 'a PE mismatch must not be retried elsewhere');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing may be left behind: ' + fs.readdirSync(dir).join(', '));
  });

  await check('a primary NETWORK failure is the only thing that reaches the API', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const release = {
      tag_name: 'v' + VERSION, draft: false, prerelease: false, name: 'IB ' + VERSION,
      assets: [{ name: um.installerAssetName(VERSION), id: 4242, size: payload.length, digest: 'sha256:' + sha256(payload) }]
    };
    const t = fakeTransport({
      '/releases/download/': { net: 'reset' },
      '/releases/latest': { text: release },
      '/releases/assets/4242': { payload: payload, chunks: 3 }
    });
    const r = await ui.downloadInstaller({ manifest: manifest, dir: tmpDir('api'), transport: t });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.transport, 'api');
    assert.deepStrictEqual(t.urls(), [
      um.installerUrl(VERSION), um.API_LATEST_RELEASE, um.assetApiUrl(4242)
    ]);
    assert.strictEqual(t.calls[2].accept, 'application/octet-stream');
    assert.strictEqual(r.bytes, payload.length);
    assert.strictEqual(r.sha256, sha256(payload));
  });

  await check('a truncated download (response head, no complete entity) may use the other route', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const release = {
      tag_name: 'v' + VERSION, draft: false, prerelease: false,
      assets: [{ name: um.installerAssetName(VERSION), id: 7 }]
    };
    const t = fakeTransport({
      '/releases/download/': { payload: payload, chunks: 4, dropAfter: 2 },
      '/releases/latest': { text: release },
      '/releases/assets/7': { payload: payload }
    });
    const r = await ui.downloadInstaller({ manifest: manifest, dir: tmpDir('trunc'), transport: t });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.transport, 'api');
    assert.strictEqual(t.calls.length, 3);
  });

  await check('the fallback itself is not retried and has no third route', async () => {
    const manifest = manifestFor(VERSION);
    const release = {
      tag_name: 'v' + VERSION, draft: false, prerelease: false,
      assets: [{ name: um.installerAssetName(VERSION), id: 9 }]
    };
    const cases = [
      ['API metadata network failure', { '/releases/download/': { net: 'dns' }, '/releases/latest': { net: 'reset' } }],
      ['API metadata HTTP error', { '/releases/download/': { net: 'dns' }, '/releases/latest': { status: 403 } }],
      ['API asset network failure', { '/releases/download/': { net: 'dns' }, '/releases/latest': { text: release }, '/releases/assets/9': { net: 'refused' } }],
      ['API asset HTTP error', { '/releases/download/': { net: 'dns' }, '/releases/latest': { text: release }, '/releases/assets/9': { status: 404 } }]
    ];
    for (const [label, routes] of cases) {
      const t = fakeTransport(routes);
      const r = await ui.downloadInstaller({ manifest: manifest, dir: tmpDir('nofb'), transport: t });
      assert.strictEqual(r.ok, false, label + ' must fail');
      const unique = t.urls().filter(function (u, i, all) { return all.indexOf(u) === i; });
      assert.strictEqual(unique.length, t.urls().length, label + ' must not repeat a URL: ' + t.urls().join(', '));
      assert.ok(t.urls().length <= 3, label + ': at most three requests');
      assert.ok(r.kind, 'a failure must name its kind');
    }
  });

  await check('the API route accepts only a published, stable release with the exact asset', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const good = { tag_name: 'v' + VERSION, draft: false, prerelease: false, assets: [{ name: um.installerAssetName(VERSION), id: 5 }] };
    const cases = [
      ['draft is not proven false', Object.assign({}, good, { draft: undefined })],
      ['draft is true', Object.assign({}, good, { draft: true })],
      ['prerelease is not proven false', Object.assign({}, good, { prerelease: undefined })],
      ['prerelease is true', Object.assign({}, good, { prerelease: true })],
      ['tag is not the manifest version', Object.assign({}, good, { tag_name: 'v9.9.9' })],
      ['tag has no v prefix', Object.assign({}, good, { tag_name: VERSION })],
      ['the installer asset is missing', Object.assign({}, good, { assets: [{ name: 'update-stable.json', id: 5 }] })],
      ['the installer asset is duplicated', Object.assign({}, good, { assets: [{ name: um.installerAssetName(VERSION), id: 5 }, { name: um.installerAssetName(VERSION), id: 6 }] })],
      ['no assets array', Object.assign({}, good, { assets: undefined })]
    ];
    for (const [label, release] of cases) {
      const t = fakeTransport({ '/releases/download/': { net: 'reset' }, '/releases/latest': { text: release } });
      const r = await ui.downloadInstaller({ manifest: manifest, dir: tmpDir('rel'), transport: t });
      assert.strictEqual(r.ok, false, label + ' must be refused');
      assert.strictEqual(r.kind, 'api-release-unusable', label + ': ' + r.kind);
      assert.strictEqual(t.urls().length, 2, label + ': the asset must not be fetched');
    }
  });

  await check('the API digest is enforced when declared, and its absence is not a failure', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const base = { tag_name: 'v' + VERSION, draft: false, prerelease: false };
    const run = function (digest) {
      const asset = { name: um.installerAssetName(VERSION), id: 11 };
      if (digest !== undefined) asset.digest = digest;
      const t = fakeTransport({
        '/releases/download/': { net: 'reset' },
        '/releases/latest': { text: Object.assign({}, base, { assets: [asset] }) },
        '/releases/assets/11': { payload: payload }
      });
      return ui.downloadInstaller({ manifest: manifest, dir: tmpDir('digest'), transport: t }).then(function (r) {
        return { r: r, calls: t.calls.length };
      });
    };
    return Promise.all([
      run('sha256:' + sha256(payload)),
      run(undefined),
      run(null),
      run('sha256:' + 'f'.repeat(64)),
      run('sha256:not-hex'),
      run('md5:' + sha256(payload))
    ]).then(function (out) {
      assert.strictEqual(out[0].r.ok, true, 'a matching digest must pass: ' + out[0].r.why);
      assert.strictEqual(out[1].r.ok, true, 'an absent digest must not be a failure: ' + out[1].r.why);
      assert.strictEqual(out[2].r.ok, true, 'a null digest must not be a failure: ' + out[2].r.why);
      assert.strictEqual(out[3].r.ok, false, 'a mismatching digest must fail');
      assert.strictEqual(out[4].r.ok, false, 'an uninterpretable digest must fail');
      assert.strictEqual(out[5].r.ok, false, 'a non-sha256 digest must fail');
      assert.strictEqual(out[3].calls, 2, 'a digest failure must not fetch the asset');
    });
  });

  await check('the gate is the shared predicate, not a second rule', () => {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-install.js'), 'utf8');
    assert.ok(/transport\.fallbackAllowed\(primary\)/.test(src),
      'the payload fallback must ask the shared predicate');
    const code = codeOnly('runtime/update-install.js');
    assert.strictEqual(/outcome\s*===\s*['"]network['"]/.test(code), false,
      'the payload path must not re-state the fallback rule in its own words');
    assert.ok(code.indexOf('https.request') < 0, 'the install runtime must not open its own socket');
  });

  /* ═══ [2] verification details ════════════════════════════════════════ */
  section('[2] what is verified, and in what order');

  await check('a bad Content-Length is refused before a single body byte', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const t = fakeTransport({ '/releases/download/': { payload: payload, omitLength: true } });
    const dir = tmpDir('nobody');
    const r = await ui.downloadInstaller({ manifest: manifest, dir: dir, transport: t });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'content-length-invalid', r.why);
    assert.strictEqual(t.calls[0].fed, 0, 'no chunk may be consumed');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no file may be created');
  });

  await check('the payload is streamed through a .part file and renamed only when verified', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const dir = tmpDir('part');
    const t = fakeTransport({ '/releases/download/': { payload: payload, chunks: 5 } });
    /* Watch the directory at the moment the last chunk lands: the final name must
       not exist yet. */
    const seen = [];
    const r = await ui.downloadInstaller({
      manifest: manifest, dir: dir, transport: t,
      onProgress: function () { seen.push(fs.readdirSync(dir).slice().sort().join(',')); }
    });
    assert.strictEqual(r.ok, true, r.why);
    assert.ok(seen.length >= 1, 'progress must be reported');
    for (const snapshot of seen) {
      const names = snapshot ? snapshot.split(',') : [];
      assert.strictEqual(names.indexOf(um.installerAssetName(VERSION)), -1,
        'the final name must not exist while the download is running: ' + snapshot);
      assert.ok(names.indexOf(um.installerAssetName(VERSION) + '.part') >= 0,
        'the in-progress payload must live under the .part name: ' + snapshot);
    }
    assert.deepStrictEqual(fs.readdirSync(dir), [um.installerAssetName(VERSION)],
      'exactly the verified payload must remain');
  });

  await check('a mismatching file is deleted, never left to be installed later', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const tampered = flipOneByte(payload);
    const dir = tmpDir('delete');
    /* Same length, same PE header: the size gate passes and the SHA gate is the
       one that fires. */
    const t = fakeTransport({ '/releases/download/': { payload: tampered, declared: tampered.length } });
    const r = await ui.downloadInstaller({ manifest: manifest, dir: dir, transport: t });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'sha256-mismatch');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'the tampered file must be gone');
  });

  await check('an interrupted transfer leaves nothing behind', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const dir = tmpDir('interrupted');
    const t = fakeTransport({ '/releases/download/': { payload: payload, chunks: 6, dropAfter: 3 } });
    const r = await ui.downloadInstaller({ manifest: manifest, dir: dir, transport: t });
    assert.strictEqual(r.ok, false);
    /* The drop is a transport failure, which is exactly the case U-D6 allows a
       detour for — so the API is consulted, and there is no route for it here. */
    assert.strictEqual(t.calls.length, 2, 'a truncated transfer is a network failure: ' + t.urls().join(', '));
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'a half-written .part must be removed');
  });

  await check('the manifest URL is re-parsed by the contract, so a smuggled URL cannot download', async () => {
    const manifest = manifestFor(VERSION);
    const cases = [
      'https://evil.example.com/yydye/InternalBeyond/releases/download/v1.2.0/InternalBeyond-Setup-1.2.0.exe',
      'http://github.com/yydye/InternalBeyond/releases/download/v1.2.0/InternalBeyond-Setup-1.2.0.exe',
      'https://github.com/attacker/InternalBeyond/releases/download/v1.2.0/InternalBeyond-Setup-1.2.0.exe',
      'https://github.com/yydye/InternalBeyond/releases/download/v1.1.9/InternalBeyond-Setup-1.1.9.exe'
    ];
    for (const url of cases) {
      const bad = JSON.parse(JSON.stringify(manifest));
      bad.installer.url = url;
      const t = fakeTransport({});
      const r = await ui.downloadInstaller({ manifest: bad, dir: tmpDir('smuggle'), transport: t });
      assert.strictEqual(r.ok, false, url + ' must be refused');
      assert.ok(['invalid-installer-url', 'identity-mismatch'].indexOf(r.kind) >= 0, url + ': ' + r.kind);
      assert.strictEqual(t.calls.length, 0, 'a refused URL must not open a connection');
    }
  });

  /* ═══ [3] never into {app} ════════════════════════════════════════════ */
  section('[3] the payload never lands in {app}');

  await check('the default payload directory is outside the application directory', () => {
    assert.strictEqual(ui.isInsideApp(ui.updatesDir()), false,
      'default payload dir: ' + ui.updatesDir());
    assert.strictEqual(ui.isInsideApp(path.join(ROOT, 'updates')), true);
    assert.strictEqual(ui.isInsideApp(ROOT), true);
    assert.strictEqual(ui.isInsideApp(path.join(ROOT, '..', 'InternalBeyond-main', 'x')), true);
    assert.strictEqual(ui.isInsideApp(os.tmpdir()), false);
  });

  await check('a payload directory inside {app} is refused, not obeyed', async () => {
    const payload = pePayload(VERSION);
    const manifest = manifestFor(VERSION, payload);
    const inside = path.join(ROOT, 'dist', 'ib-u3-should-never-exist');
    const t = fakeTransport(installerRoutes(payload));
    const r = await ui.downloadInstaller({ manifest: manifest, dir: inside, transport: t });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'payload-dir-inside-app', r.why);
    assert.strictEqual(t.calls.length, 0, 'nothing may be requested');
    assert.strictEqual(fs.existsSync(inside), false, 'nothing may be created');
  });

  /* ═══ [4] the spawn contract ══════════════════════════════════════════ */
  section('[4] spawning the installer (U-D3 / U-D5)');

  await check('the frozen arguments, detachment and shell:false are exactly right', () => {
    const exe = path.join(tmpDir('spawn'), 'InternalBeyond-Setup-' + VERSION + '.exe');
    fs.writeFileSync(exe, 'not really an installer');
    let seen = null;
    const fakeChild = { pid: 4242, unref: function () { fakeChild.unrefCalled = true; }, unrefCalled: false };
    const r = ui.spawnInstaller(exe, {
      spawn: function (file, args, opts) { seen = { file: file, args: args, opts: opts }; return fakeChild; }
    });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(seen.file, exe);
    assert.deepStrictEqual(seen.args, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/IBRELAUNCH=1'],
      'the U-D3 argument list is frozen');
    assert.strictEqual(seen.opts.detached, true, 'the installer must outlive the helper');
    assert.strictEqual(seen.opts.shell, false, 'no shell may reinterpret anything');
    assert.strictEqual(seen.opts.stdio, 'ignore');
    assert.strictEqual(seen.opts.windowsHide, true);
    assert.strictEqual(seen.opts.cwd, path.dirname(exe));
    assert.strictEqual(fakeChild.unrefCalled, true, 'the child must be unref\'d so the helper can exit');
    assert.strictEqual(r.pid, 4242);
  });

  await check('a missing installer is refused, and a throwing spawn is a refusal too', () => {
    const r1 = ui.spawnInstaller(path.join(tmpRoot, 'nope.exe'));
    assert.strictEqual(r1.ok, false);
    assert.ok(/not on disk/.test(r1.why), r1.why);
    const exe = path.join(tmpDir('spawn2'), 'x.exe');
    fs.writeFileSync(exe, 'x');
    const r2 = ui.spawnInstaller(exe, { spawn: function () { throw new Error('EPERM from the OS'); } });
    assert.strictEqual(r2.ok, false);
    assert.ok(/EPERM/.test(r2.why), r2.why);
    const r3 = ui.spawnInstaller(exe, { spawn: function () { return { pid: 0 }; } });
    assert.strictEqual(r3.ok, false);
  });

  await check('a detached installer really outlives the helper process that started it', async () => {
    /* The U-D5 promise, tested against the OS instead of against a stub: a child
       process runs the real spawnInstaller (recording the arguments), starts a
       real detached grandchild that writes a marker 700 ms later, and then —
       because the handle is unref'd — exits immediately. The marker must appear
       AFTER the helper is gone. */
    const dir = tmpDir('detach');
    const marker = path.join(dir, 'marker.txt');
    const record = path.join(dir, 'record.json');
    const probe = path.join(dir, 'probe.js');
    fs.writeFileSync(probe, [
      "'use strict';",
      'const fs = require("fs");',
      'const cp = require("child_process");',
      'const ui = require(' + JSON.stringify(path.join(ROOT, 'runtime', 'update-install.js')) + ');',
      'let recorded = null;',
      'const r = ui.spawnInstaller(process.execPath, {',
      '  spawn: function (file, args, opts) {',
      '    recorded = { file: file, args: args, opts: { detached: opts.detached, shell: opts.shell, stdio: opts.stdio } };',
      '    return cp.spawn(process.execPath, ["-e", "setTimeout(()=>require(String.fromCharCode(102,115)).writeFileSync(process.argv[1],String.fromCharCode(49)),700)", process.argv[2]], { detached: true, stdio: "ignore" });',
      '  }',
      '});',
      'fs.writeFileSync(process.argv[3], JSON.stringify({ r: r, recorded: recorded }));'
    ].join('\n'), 'utf8');

    const started = Date.now();
    const probeRun = childProcess.spawnSync(process.execPath, [probe, marker, record], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const helperExitMs = Date.now() - started;
    assert.strictEqual(probeRun.status, 0, 'the probe must exit cleanly: ' + String(probeRun.stderr || ''));

    const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.strictEqual(rec.r.ok, true, rec.r.why);
    assert.deepStrictEqual(rec.recorded.args, ui.INSTALL_ARGS, 'the real spawn must use the frozen arguments');
    assert.strictEqual(rec.recorded.opts.detached, true);
    assert.strictEqual(rec.recorded.opts.shell, false);

    /* The grandchild is detached and unref'd, so the helper cannot have waited
       for it: the marker can only appear afterwards. */
    let waited = 0;
    while (!fs.existsSync(marker) && waited < 6000) {
      await new Promise(function (r) { setTimeout(r, 100); });
      waited += 100;
    }
    assert.ok(fs.existsSync(marker), 'the detached installer must survive the helper');
    assert.ok(helperExitMs < 3000, 'the helper must not wait for the installer (' + helperExitMs + ' ms)');
  });

  await check('the helper never stops or relaunches anything itself (U-D5 keeps that in the installer)', () => {
    const src = codeOnly('runtime/update-install.js');
    for (const forbidden of ['ib-stop', 'taskkill', '__shutdown', 'wscript', 'execFile', 'execSync']) {
      assert.strictEqual(src.indexOf(forbidden) < 0, true,
        'runtime/update-install.js must not contain ' + JSON.stringify(forbidden) + ': the installer owns stopping and relaunching');
    }
    /* /IBRELAUNCH=1 may appear exactly once: as an ARGUMENT handed to the
       installer. The helper never launches anything itself. */
    const relaunch = src.match(/IBRELAUNCH/g) || [];
    assert.strictEqual(relaunch.length, 1, 'IBRELAUNCH may only be the frozen installer argument');
    assert.ok(/'\/IBRELAUNCH=1'/.test(src), 'and it must be inside the frozen argument list');
    /* The only signal it may send is signal 0 — "does this pid exist?", which
       stops nothing. A real kill would be the helper reaching into the stop
       business the installer owns. */
    const signals = src.match(/process\.kill\([^)]*\)/g) || [];
    assert.strictEqual(signals.length, 1, 'exactly one process.kill call: ' + signals.join(' '));
    assert.ok(/process\.kill\(pid,\s*0\)/.test(signals[0]), 'and it must be the liveness probe: ' + signals[0]);
    const iss = fs.readFileSync(path.join(ROOT, 'installer', 'InternalBeyond.iss'), 'utf8');
    assert.ok(/IBRELAUNCH/.test(iss), 'the installer is where the relaunch happens');
  });

  /* ═══ [5] the install state file ══════════════════════════════════════ */
  section('[5] the install state file');

  await check('no state file is idle, and a broken one is never a lie', () => {
    const dir = tmpDir('state');
    assert.strictEqual(ui.readState({ dir: dir }).state, 'idle');
    assert.strictEqual(ui.readState({ dir: dir }).active, false);
    const file = ui.stateFile({ dir: dir });
    for (const junk of ['not json', '{}', '[]', '{"schema":"other"}', '{"schema":"' + ui.STATE_SCHEMA + '","schemaVersion":99}', '{"schema":"' + ui.STATE_SCHEMA + '","schemaVersion":1,"state":"weird"}']) {
      fs.writeFileSync(file, junk, 'utf8');
      const r = ui.readState({ dir: dir });
      assert.strictEqual(r.state, 'idle', 'junk must read as idle: ' + junk);
      assert.strictEqual(r.present, false);
      assert.strictEqual(r.active, false);
    }
  });

  await check('active means: non-terminal AND the pid is alive AND the state is fresh', () => {
    const dir = tmpDir('active');
    const file = ui.stateFile({ dir: dir });
    const write = function (state, pid, updatedAt) {
      fs.writeFileSync(file, JSON.stringify({
        schema: ui.STATE_SCHEMA, schemaVersion: 1, state: state, pid: pid,
        updatedAt: new Date(updatedAt).toISOString(), startedAt: new Date(updatedAt).toISOString()
      }), 'utf8');
    };
    const now = Date.now();
    write(ui.STATE_DOWNLOADING, process.pid, now);
    assert.strictEqual(ui.readState({ dir: dir }).active, true, 'a live download must be active');
    for (const terminal of ui.TERMINAL_STATES) {
      write(terminal, process.pid, now);
      assert.strictEqual(ui.readState({ dir: dir }).active, false, terminal + ' must never be active');
    }
    write(ui.STATE_DOWNLOADING, process.pid, now - ui.ACTIVE_GRACE_MS - 60000);
    assert.strictEqual(ui.readState({ dir: dir }).active, false, 'a stalled run must not block the next one');
    write(ui.STATE_DOWNLOADING, 999999999, now);
    assert.strictEqual(ui.readState({ dir: dir }).active, false, 'a dead pid must not block the next one');
    write(ui.STATE_VERIFYING, process.pid, now);
    assert.strictEqual(ui.readState({ dir: dir }).active, true);
  });

  await check('a finished run with a dead pid is not active (the pid is reused in real life)', () => {
    const dead = childProcess.spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    const dir = tmpDir('deadpid');
    fs.writeFileSync(ui.stateFile({ dir: dir }), JSON.stringify({
      schema: ui.STATE_SCHEMA, schemaVersion: 1, state: ui.STATE_LAUNCHING,
      pid: dead.pid, updatedAt: new Date().toISOString()
    }), 'utf8');
    assert.strictEqual(ui.pidAlive(dead.pid), false, 'the probe pid must be gone');
    assert.strictEqual(ui.readState({ dir: dir }).active, false);
  });

  await check('the state projection is exact and carries no paths or pids', () => {
    const dir = tmpDir('proj');
    ui.writeState({ state: ui.STATE_DOWNLOADING, version: VERSION, transport: 'direct', bytes: 10, totalBytes: 100, pid: 1234 }, { dir: dir });
    const projection = ui.summarizeState(ui.readState({ dir: dir }));
    assert.deepStrictEqual(Object.keys(projection).sort(), [
      'active', 'bytes', 'error', 'finishedAt', 'ok', 'startedAt', 'state', 'totalBytes',
      'transport', 'updatedAt', 'version'
    ]);
    assert.strictEqual(projection.version, VERSION);
    assert.strictEqual(projection.bytes, 10);
    assert.strictEqual(projection.totalBytes, 100);
    assert.strictEqual(JSON.stringify(projection).indexOf(ROOT) < 0, true, 'no filesystem paths may leak to the UI');
  });

  await check('the state file is written atomically (no half-written state can be read back)', () => {
    const dir = tmpDir('atomic');
    for (let i = 0; i < 25; i++) {
      ui.writeState({ state: ui.STATE_DOWNLOADING, version: VERSION, bytes: i * 1000, pid: process.pid }, { dir: dir });
      const r = ui.readState({ dir: dir });
      assert.strictEqual(r.present, true, 'the state must always be readable');
      assert.strictEqual(r.bytes, i * 1000);
    }
    assert.deepStrictEqual(fs.readdirSync(dir), ['update-install-state.json'], 'no .tmp file may be left behind');
  });

  /* ═══ [6] the helper resolves its own manifest ════════════════════════ */
  section('[6] the helper trusts only the verified cache');

  const MIN_SIZE = um.MIN_PLAUSIBLE_INSTALLER_BYTES;
  function cachedManifest(version) {
    /* Past the validator's "an installer always bundles the Node runtime" floor,
       then padded: the real validator is what accepts this. */
    const bytes = pePayload(version, MIN_SIZE + 4096);
    return { manifest: um.build({ version: version, sha256: sha256(bytes), sizeBytes: bytes.length, productVersion: version }), bytes: bytes };
  }
  function cacheFileWith(dir, manifest, at) {
    const file = path.join(dir, 'update-check.json');
    fs.writeFileSync(file, JSON.stringify({
      schema: uc.CACHE_SCHEMA, schemaVersion: uc.CACHE_SCHEMA_VERSION, channel: um.CHANNEL_STABLE,
      checkedAt: new Date(at || Date.now()).toISOString(), transport: 'direct', manifest: manifest
    }), 'utf8');
    return file;
  }

  await check('with no verified manifest there is nothing to install and no request is made', async () => {
    const dir = tmpDir('nocache');
    const t = fakeTransport({});
    const r = await ui.startInstall({ dir: dir, cacheFile: path.join(dir, 'missing.json'), transport: t });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'no-verified-manifest');
    assert.strictEqual(t.calls.length, 0);
    assert.strictEqual(ui.readState({ dir: dir }).state, ui.STATE_FAILED);
    assert.strictEqual(ui.readState({ dir: dir }).error.kind, 'no-verified-manifest');
  });

  await check('an expired cache is not a manifest', async () => {
    const dir = tmpDir('expired');
    const built = cachedManifest(NEWER);
    const file = cacheFileWith(dir, built.manifest, Date.now() - uc.CACHE_TTL_MS - 60000);
    const r = await ui.resolveManifest({ cacheFile: file });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'no-verified-manifest');
  });

  await check('the whole helper flow: download, verify, spawn, exit', async () => {
    const dir = tmpDir('flow');
    const built = cachedManifest(NEWER);
    const file = cacheFileWith(dir, built.manifest);
    const t = fakeTransport({ '/releases/download/': { payload: built.bytes, chunks: 4 } });
    let spawned = null;
    const r = await ui.startInstall({
      dir: dir, cacheFile: file, transport: t, version: NEWER,
      spawn: function (exe, args, opts) { spawned = { exe: exe, args: args, opts: opts }; return { pid: 777, unref: function () { } }; }
    });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.state, ui.STATE_LAUNCHED);
    assert.strictEqual(r.version, NEWER);
    assert.strictEqual(r.transport, 'direct');
    assert.strictEqual(r.bytes, built.bytes.length);
    assert.ok(spawned, 'the installer must be started');
    assert.strictEqual(spawned.exe, path.join(dir, um.installerAssetName(NEWER)));
    assert.deepStrictEqual(spawned.args, ui.INSTALL_ARGS);
    assert.ok(fs.existsSync(spawned.exe), 'the verified payload must be on disk when it is spawned');
    const state = ui.readState({ dir: dir });
    assert.strictEqual(state.state, ui.STATE_LAUNCHED);
    assert.strictEqual(state.version, NEWER);
    assert.strictEqual(state.bytes, built.bytes.length);
  });

  await check('a version the verified manifest does not announce is refused before anything happens', async () => {
    const dir = tmpDir('wrongversion');
    const built = cachedManifest(NEWER);
    const file = cacheFileWith(dir, built.manifest);
    const t = fakeTransport({});
    const r = await ui.startInstall({ dir: dir, cacheFile: file, transport: t, version: VERSION });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'version-mismatch');
    assert.strictEqual(t.calls.length, 0, 'nothing may be downloaded');
  });

  await check('a run already in progress is never doubled', async () => {
    const dir = tmpDir('inflight');
    const built = cachedManifest(NEWER);
    const file = cacheFileWith(dir, built.manifest);
    ui.writeState({ state: ui.STATE_DOWNLOADING, version: NEWER, pid: process.pid }, { dir: dir });
    const t = fakeTransport({});
    const r = await ui.startInstall({ dir: dir, cacheFile: file, transport: t, version: NEWER });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'already-in-progress');
    assert.strictEqual(t.calls.length, 0);
  });

  await check('a failed download is recorded honestly, with its kind', async () => {
    const dir = tmpDir('failed');
    const built = cachedManifest(NEWER);
    const file = cacheFileWith(dir, built.manifest);
    const t = fakeTransport({ '/releases/download/': { status: 404 } });
    const r = await ui.startInstall({ dir: dir, cacheFile: file, transport: t, version: NEWER });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'http-status');
    const state = ui.readState({ dir: dir });
    assert.strictEqual(state.state, ui.STATE_FAILED);
    assert.strictEqual(state.error.kind, 'http-status');
    assert.strictEqual(state.active, false);
    assert.ok(state.finishedAt, 'a failed run must be finished');
  });

  await check('two helpers can never stream into the same payload', async () => {
    /* The state file alone cannot serialise this: a second helper can be spawned
       in the window before the first has written anything. The lock file can, and
       the refusal must not clobber the state of the run that is still going. */
    const dir = tmpDir('lock');
    const built = cachedManifest(NEWER);
    const file = cacheFileWith(dir, built.manifest);
    ui.writeState({ state: ui.STATE_DOWNLOADING, version: NEWER, bytes: 4096, pid: process.pid }, { dir: dir });
    const held = ui.acquireLock({ dir: dir, pid: process.pid });
    assert.strictEqual(held.ok, true, held.why);

    const t = fakeTransport({});
    const r = await ui.startInstall({ dir: dir, cacheFile: file, transport: t, version: NEWER });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'already-in-progress');
    assert.strictEqual(t.calls.length, 0, 'nothing may be downloaded');
    const state = ui.readState({ dir: dir });
    assert.strictEqual(state.state, ui.STATE_DOWNLOADING, 'the running helper\'s state must survive the refusal');
    assert.strictEqual(state.bytes, 4096);
    assert.strictEqual(ui.isBusy({ dir: dir }), true);
  });

  await check('a lock whose owner is gone is taken over, so a crash cannot wedge the feature', async () => {
    const dir = tmpDir('stale-lock');
    const dead = childProcess.spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
    fs.writeFileSync(ui.lockFile({ dir: dir }), JSON.stringify({
      pid: dead.pid, at: new Date(Date.now() - ui.ACTIVE_GRACE_MS - 60000).toISOString(), role: 'helper'
    }), 'utf8');
    const taken = ui.acquireLock({ dir: dir, pid: process.pid });
    assert.strictEqual(taken.ok, true, taken.why);
    assert.strictEqual(taken.tookOver, true);
    assert.strictEqual(ui.readLock({ dir: dir }).pid, process.pid);
    /* Garbage in the lock file is not an owner either. */
    fs.writeFileSync(ui.lockFile({ dir: dir }), 'not json', 'utf8');
    assert.strictEqual(ui.acquireLock({ dir: dir }).ok, true);
  });

  await check('a successful run hands the lock to the installer; a failed one releases it', async () => {
    const okDir = tmpDir('lock-ok');
    const built = cachedManifest(NEWER);
    const okCache = cacheFileWith(okDir, built.manifest);
    const t = fakeTransport({ '/releases/download/': { payload: built.bytes } });
    const done = await ui.startInstall({
      dir: okDir, cacheFile: okCache, transport: t, version: NEWER,
      spawn: function () { return { pid: 4242, unref: function () { } }; }
    });
    assert.strictEqual(done.ok, true, done.why);
    const lock = ui.readLock({ dir: okDir });
    assert.strictEqual(lock.role, 'installer', 'the installer, not the dead helper, owns the lock now');
    assert.strictEqual(lock.pid, 4242);

    const badDir = tmpDir('lock-bad');
    const badCache = cacheFileWith(badDir, built.manifest);
    const t2 = fakeTransport({ '/releases/download/': { status: 500 } });
    const failed = await ui.startInstall({ dir: badDir, cacheFile: badCache, transport: t2, version: NEWER });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(fs.existsSync(ui.lockFile({ dir: badDir })), false,
      'a failed run must not leave the feature locked out');
    assert.strictEqual(ui.isBusy({ dir: badDir }), false);
  });

  await check('stale payloads of other versions are cleaned up, the current one is kept', async () => {
    const dir = tmpDir('cleanup');
    fs.writeFileSync(path.join(dir, um.installerAssetName('1.0.0')), 'old');
    fs.writeFileSync(path.join(dir, um.installerAssetName('1.1.0')), 'older');
    fs.writeFileSync(path.join(dir, um.installerAssetName(NEWER) + '.part'), 'half');
    fs.writeFileSync(path.join(dir, um.installerAssetName(NEWER)), 'current');
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep me');
    const r = ui.cleanupStale({ dir: dir, keepVersion: NEWER });
    assert.strictEqual(r.ok, true);
    const left = fs.readdirSync(dir).sort();
    assert.deepStrictEqual(left, [um.installerAssetName(NEWER), 'unrelated.txt'],
      'only the current payload and unrelated files may remain: ' + left.join(', '));
  });

  await check('the helper really is a program: it runs, reports honestly and exits', () => {
    /* The U-D5 promise is about a PROCESS, so it is checked as one: the real
       helper, started the way the server starts it, must finish on its own (no
       lingering handle), say what happened, write an honest state and leave no
       lock behind. */
    const dir = tmpDir('cli');
    const started = Date.now();
    const run = childProcess.spawnSync(process.execPath, [ui.HELPER_SCRIPT, '--version', NEWER], {
      encoding: 'utf8', timeout: 15000, windowsHide: true, cwd: ROOT,
      env: Object.assign({}, process.env, { IB_UPDATE_DIR: dir })
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(run.error, undefined, 'the helper must exit on its own: ' + (run.error && run.error.code));
    assert.strictEqual(run.status, 1, 'with nothing verified there is nothing to install');
    assert.ok(elapsed < 10000, 'and it must not linger (' + elapsed + ' ms)');
    assert.ok(/\[ib-update\]/.test(run.stdout), 'it must report: ' + run.stdout);
    const reported = JSON.parse(run.stdout.slice(run.stdout.indexOf('{')));
    assert.strictEqual(reported.ok, false);
    assert.strictEqual(reported.kind, 'no-verified-manifest');
    const state = ui.readState({ dir: path.join(dir, 'updates') });
    assert.strictEqual(state.state, ui.STATE_FAILED);
    assert.strictEqual(state.error.kind, 'no-verified-manifest');
    assert.strictEqual(fs.existsSync(ui.lockFile({ dir: path.join(dir, 'updates') })), false,
      'no run may leave the feature locked out');
  });

  /* ═══ [7] the endpoints ═══════════════════════════════════════════════ */
  section('[7] POST /__update/start and GET /__update-status');

  const serverPath = require.resolve(path.join(ROOT, 'services', 'internal-beyond-server.js'));

  function startServer(opts) {
    const server = require(serverPath).createWebServer(Object.assign({ port: 0, host: '127.0.0.1' }, opts || {}));
    return new Promise(function (resolve) {
      server.listen(0, '127.0.0.1', function () { resolve(server); });
    });
  }
  function request(server, pathname, method, body, headers) {
    return new Promise(function (resolve) {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: pathname, method: method || 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {})
      }, function (res) {
        let raw = '';
        res.on('data', function (c) { raw += c; });
        res.on('end', function () {
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { }
          resolve({ status: res.statusCode, json: json, raw: raw });
        });
      });
      req.on('error', function (e) { resolve({ status: 0, json: null, raw: String(e.message) }); });
      if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }

  /* A stub pair: the server must use whatever module it is given, so the endpoint
     contract can be tested without a network or an install. */
  function stubs(over) {
    const o = over || {};
    const calls = { spawn: [], readState: 0 };
    const checkStub = {
      STATUS_NO_INFORMATION: 'no-information',
      readCache: function () { return o.cache === undefined ? { hit: false, why: 'none' } : o.cache; },
      checkShared: function () { return Promise.resolve({}); },
      summarize: function () { return { ok: true, status: 'up-to-date' }; }
    };
    const installStub = {
      INSTALL_ARGS: ui.INSTALL_ARGS,
      readState: function () { calls.readState++; return o.state || { state: 'idle', active: false }; },
      summarizeState: function (r) { return { ok: true, state: (r && r.state) || 'idle', active: !!(r && r.active) }; },
      spawnHelper: function (args) { calls.spawn.push(args); return o.spawnResult || { ok: true, pid: 99 }; }
    };
    return { check: checkStub, install: installStub, calls: calls };
  }
  function goodCache(version) {
    return { hit: true, at: Date.now(), transport: 'direct', manifest: manifestFor(version) };
  }

  await check('the start endpoint refuses everything that is not a POST from this origin', async () => {
    const s = stubs({ cache: goodCache(VERSION) });
    const server = await startServer({ updateCheck: s.check, updateInstall: s.install });
    try {
      const get = await request(server, '/__update/start', 'GET');
      assert.strictEqual(get.status, 405);
      assert.strictEqual(get.json.error.kind, 'method-not-allowed');
      const foreign = await request(server, '/__update/start', 'POST', { version: VERSION }, { Origin: 'https://evil.example.com' });
      assert.strictEqual(foreign.status, 403);
      assert.strictEqual(foreign.json.error.kind, 'origin-denied');
      assert.strictEqual(s.calls.spawn.length, 0);
      for (const origin of ['null', 'file://', 'http://127.0.0.1:23120', 'http://localhost:9999']) {
        const ok = await request(server, '/__update/start', 'POST', { version: VERSION }, { Origin: origin });
        assert.strictEqual(ok.status, 202, origin + ' must be allowed: ' + ok.raw);
      }
    } finally { server.close(); }
  });

  await check('the browser may not submit a URL, a hash or a path (U-D6 item 7)', async () => {
    const s = stubs({ cache: goodCache(VERSION) });
    const server = await startServer({ updateCheck: s.check, updateInstall: s.install });
    try {
      const bodies = [
        { version: VERSION, url: 'https://evil.example.com/x.exe' },
        { version: VERSION, sha256: SHA_OK },
        { version: VERSION, path: 'C:\\Windows\\System32\\calc.exe' },
        { version: VERSION, file: 'x.exe' },
        { version: VERSION, hash: SHA_OK },
        { version: VERSION, installer: { url: 'x' } },
        { version: VERSION, args: ['/X'] }
      ];
      for (const body of bodies) {
        const r = await request(server, '/__update/start', 'POST', body);
        assert.strictEqual(r.status, 400, JSON.stringify(body) + ' must be refused');
        assert.strictEqual(r.json.error.kind, 'browser-supplied-transport-fields', r.raw);
        const named = Object.keys(body).filter(function (k) { return k !== 'version'; })[0];
        assert.ok(r.json.error.message.indexOf(named) >= 0, 'the refused field must be named: ' + r.json.error.message);
      }
      assert.strictEqual(s.calls.spawn.length, 0, 'nothing may be started');
    } finally { server.close(); }
  });

  await check('a malformed body, a missing version and a huge body are refused', async () => {
    const s = stubs({ cache: goodCache(VERSION) });
    const server = await startServer({ updateCheck: s.check, updateInstall: s.install });
    try {
      const bad = await request(server, '/__update/start', 'POST', '{not json');
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.json.error.kind, 'bad-json');
      const arr = await request(server, '/__update/start', 'POST', '[1,2,3]');
      assert.strictEqual(arr.status, 400);
      assert.strictEqual(arr.json.error.kind, 'bad-body');
      const none = await request(server, '/__update/start', 'POST', {});
      assert.strictEqual(none.status, 400);
      assert.strictEqual(none.json.error.kind, 'version-required');
      const empty = await request(server, '/__update/start', 'POST', '');
      assert.strictEqual(empty.status, 400);
      const huge = await request(server, '/__update/start', 'POST', { version: VERSION, pad: 'x'.repeat(9000) });
      assert.strictEqual(huge.status, 400);
      assert.strictEqual(s.calls.spawn.length, 0);
    } finally { server.close(); }
  });

  await check('a version that is not the verified one is refused with 409', async () => {
    const s = stubs({ cache: goodCache(VERSION) });
    const server = await startServer({ updateCheck: s.check, updateInstall: s.install });
    try {
      const r = await request(server, '/__update/start', 'POST', { version: '9.9.9' });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error.kind, 'version-mismatch');
      assert.strictEqual(s.calls.spawn.length, 0);
    } finally { server.close(); }
  });

  await check('with nothing verified there is nothing to start', async () => {
    const s = stubs({ cache: { hit: false, why: 'no cache file' } });
    const server = await startServer({ updateCheck: s.check, updateInstall: s.install });
    try {
      const r = await request(server, '/__update/start', 'POST', { version: VERSION });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error.kind, 'no-verified-manifest');
      assert.strictEqual(s.calls.spawn.length, 0);
    } finally { server.close(); }
  });

  await check('an accepted start passes the version and ONLY the version to the helper', async () => {
    const s = stubs({ cache: goodCache(VERSION) });
    const server = await startServer({ updateCheck: s.check, updateInstall: s.install });
    try {
      const r = await request(server, '/__update/start', 'POST', { version: VERSION });
      assert.strictEqual(r.status, 202, r.raw);
      assert.strictEqual(r.json.ok, true);
      assert.strictEqual(r.json.accepted, true);
      assert.strictEqual(r.json.version, VERSION);
      assert.strictEqual(s.calls.spawn.length, 1);
      assert.deepStrictEqual(Object.keys(s.calls.spawn[0]), ['version'],
        'exactly one key may cross the boundary: ' + JSON.stringify(s.calls.spawn[0]));
      assert.strictEqual(s.calls.spawn[0].version, VERSION);
    } finally { server.close(); }
  });

  await check('an install already running is 409, and a helper that will not start is 503', async () => {
    const busy = stubs({ cache: goodCache(VERSION), state: { state: 'downloading', active: true } });
    const server1 = await startServer({ updateCheck: busy.check, updateInstall: busy.install });
    try {
      const r = await request(server1, '/__update/start', 'POST', { version: VERSION });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error.kind, 'already-in-progress');
      assert.strictEqual(busy.calls.spawn.length, 0);
    } finally { server1.close(); }

    const broken = stubs({ cache: goodCache(VERSION), spawnResult: { ok: false, why: 'no node' } });
    const server2 = await startServer({ updateCheck: broken.check, updateInstall: broken.install });
    try {
      const r = await request(server2, '/__update/start', 'POST', { version: VERSION });
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.json.error.kind, 'start-failed');
    } finally { server2.close(); }
  });

  await check('the busy lock window is honoured, not just the state file', async () => {
    /* The state file alone leaves a gap: between the server spawning the helper
       and the helper writing anything, a second click used to be able to start a
       second download. The lock closes it, so the server must ask about the lock. */
    const s = stubs({ cache: goodCache(VERSION) });
    s.install.isBusy = function () { return true; };
    const server = await startServer({ updateCheck: s.check, updateInstall: s.install });
    try {
      const r = await request(server, '/__update/start', 'POST', { version: VERSION });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error.kind, 'already-in-progress');
      assert.strictEqual(s.calls.spawn.length, 0, 'nothing may be started while the lock is held');
    } finally { server.close(); }
  });

  await check('the status endpoint always answers 200 with the frozen projection', async () => {
    const s = stubs({ state: { state: 'downloading', active: true, version: VERSION, bytes: 5, totalBytes: 10 } });
    const server = await startServer({ updateCheck: s.check, updateInstall: s.install });
    try {
      const r = await request(server, '/__update/status', 'GET');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json, { ok: true, state: 'downloading', active: true });
      const post = await request(server, '/__update/status', 'POST', {});
      assert.strictEqual(post.status, 200, 'status is read-only and never fails');
    } finally { server.close(); }
  });

  await check('a broken install module degrades the endpoints without touching the app', async () => {
    /* The same fail-open rule as U2: the static server, /health and the file
       serving must all survive a missing/broken update install module. */
    const Module = require('module');
    const original = Module.prototype.require;
    Module.prototype.require = function (request) {
      if (String(request).indexOf('update-install') >= 0) throw new Error('simulated broken module');
      return original.apply(this, arguments);
    };
    let server = null;
    try {
      delete require.cache[serverPath];
      server = require(serverPath).createWebServer({ port: 0, host: '127.0.0.1' });
    } finally {
      Module.prototype.require = original;
    }
    await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
    try {
      const status = await request(server, '/__update/status', 'GET');
      assert.strictEqual(status.status, 200);
      assert.strictEqual(status.json.ok, false);
      assert.strictEqual(status.json.state, 'unavailable');
      assert.strictEqual(status.json.error.kind, 'update-module-unavailable');
      const start = await request(server, '/__update/start', 'POST', { version: VERSION });
      assert.strictEqual(start.status, 503);
      assert.strictEqual(start.json.error.kind, 'update-module-unavailable');
      const page = await request(server, '/InternalBeyond.html', 'GET');
      assert.strictEqual(page.status, 200, 'the app must still be served');
      const health = await request(server, '/health', 'GET');
      assert.strictEqual(health.status, 200);
      assert.strictEqual(health.json.ok, true);
    } finally {
      server.close();
      delete require.cache[serverPath];
      require(serverPath);
    }
  });

  /* ═══ [8] the shared transport the payload rides on ═══════════════════ */
  section('[8] shared transport (what U3 reuses instead of copying)');

  await check('the text sink still caps and decodes the way U2 depends on', () => {
    /* This behaviour moved out of update-check.js into the shared transport so
       the payload download could reuse the same walker. It must be unchanged. */
    const sink = transport.textSink({ maxBytes: 4 });
    assert.strictEqual(sink.onData(Buffer.from('abc')), null);
    const tooLarge = sink.onData(Buffer.from('de'));
    assert.strictEqual(tooLarge.kind, 'body-too-large');
    assert.strictEqual(transport.MAX_BODY_BYTES, 256 * 1024);

    const zlib = require('zlib');
    const gz = transport.textSink({});
    gz.onData(zlib.gzipSync(Buffer.from('{"ok":true}', 'utf8')));
    assert.strictEqual(gz.onEnd(200, { 'content-encoding': 'gzip' }).value, '{"ok":true}');
    const plain = transport.textSink({});
    plain.onData(Buffer.from('plain', 'utf8'));
    assert.strictEqual(plain.onEnd(200, {}).value, 'plain');

    const broken = transport.textSink({});
    broken.onData(Buffer.from('not really gzip', 'utf8'));
    assert.strictEqual(broken.onEnd(200, { 'content-encoding': 'gzip' }).kind, 'bad-encoding');
  });

  await check('a decompression bomb cannot expand past the same budget', () => {
    const zlib = require('zlib');
    const bomb = zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x41));
    const sink = transport.textSink({ maxBytes: 64 * 1024 });
    const verdict = sink.onEnd(200, { 'content-encoding': 'gzip', 'content-length': String(bomb.length) });
    assert.ok(verdict.kind, 'the decompressed output must be capped, got ' + JSON.stringify(verdict).slice(0, 80));
  });

  await check('the payload gets a whole-exchange ceiling and a stall deadline', () => {
    assert.ok(ui.PAYLOAD_TIMEOUT_MS >= 10 * 60 * 1000, 'a 48 MB payload legitimately takes minutes');
    assert.ok(ui.PAYLOAD_STALL_MS > 0 && ui.PAYLOAD_STALL_MS < ui.PAYLOAD_TIMEOUT_MS,
      'a peer that stops sending must be given up on long before the hard ceiling');
    const src = codeOnly('runtime/update-transport.js');
    assert.ok(/stallTimeoutMs/.test(src), 'the shared walker must implement the stall deadline');
    assert.ok(/if \(stallTimer\) \{ clearTimeout\(stallTimer\)/.test(src));
    assert.ok(/typeof stallTimer\.unref === 'function'/.test(src), 'a timer must never hold the helper open');
    /* Every terminal path clears it, so no timer can outlive a request. */
    const cleared = (src.match(/clearStall\(\);/g) || []).length;
    assert.ok(cleared >= 5, 'every exit path must clear the stall timer, found ' + cleared);
    const checkSrc = codeOnly('runtime/update-check.js');
    assert.strictEqual(/stallTimeoutMs/.test(checkSrc), false,
      'the U2 document path must keep its original single deadline');
  });

  /* ═══ [9] wiring ══════════════════════════════════════════════════════ */
  section('[9] wiring');

  await check('the helper is a real file, and it is the one the server spawns', () => {
    assert.ok(fs.existsSync(ui.HELPER_SCRIPT), 'the helper must exist: ' + ui.HELPER_SCRIPT);
    assert.strictEqual(path.basename(ui.HELPER_SCRIPT), 'update-install.js');
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-install.js'), 'utf8');
    assert.ok(/require\.main === module/.test(src), 'the helper must be runnable as a program');
    assert.ok(/HELPER_SCRIPT = path\.join\(__dirname, 'update-install\.js'\)/.test(src));
  });

  await check('the helper process receives only a version on its command line', () => {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-install.js'), 'utf8');
    const cli = src.slice(src.indexOf('function parseArgs'));
    assert.ok(/--version/.test(cli));
    assert.strictEqual(/--url|--sha256|--path|--file|--dir/.test(cli), false,
      'the CLI must not accept a locator of any kind');
    let seen = null;
    const r = ui.spawnHelper({
      version: VERSION,
      spawn: function (file, args, opts) { seen = { file: file, args: args, opts: opts }; return { pid: 31337, unref: function () { } }; }
    });
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(seen.file, process.execPath, 'the bundled runtime runs the helper');
    assert.deepStrictEqual(seen.args, [ui.HELPER_SCRIPT, '--version', VERSION]);
    assert.strictEqual(seen.opts.detached, true);
    assert.strictEqual(seen.opts.shell, false);
    assert.strictEqual(seen.opts.stdio, 'ignore');
    assert.strictEqual(ui.spawnHelper({ version: '' }).ok, false, 'a version is mandatory');
  });

  await check('every U3 runtime module ships in the release payload', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'release-manifest.js'), 'utf8');
    for (const file of ['runtime/update-transport.js', 'runtime/update-install.js', 'runtime/pe-version.js']) {
      assert.ok(src.indexOf(file) >= 0, file + ' must be whitelisted in the payload');
    }
  });

  await check('the launch chain still knows nothing about updating', () => {
    for (const file of ['launch-internal-beyond.js', 'local-services-runner.js']) {
      const src = fs.readFileSync(path.join(ROOT, 'runtime', file), 'utf8');
      for (const needle of ['update-install', 'update-check', 'update-transport', 'pe-version']) {
        assert.strictEqual(src.indexOf(needle) < 0, true, file + ' must not reference ' + needle);
      }
    }
  });

  await check('the server loads the install runtime defensively', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'internal-beyond-server.js'), 'utf8');
    assert.ok(/try \{\s*updateInstall = require\('\.\.\/runtime\/update-install\.js'\)/.test(src),
      'a hard require would let a broken updater stop the whole app from starting');
  });

  await check('test_update_install.js and test_pe_version.js are registered in the suite', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tests', 'test-all.js'), 'utf8');
    assert.ok(/test_update_install\.js/.test(src), 'the U3 test must be registered');
    assert.ok(/test_pe_version\.js/.test(src), 'the PE reader test must be registered');
  });

  /* ── teardown ───────────────────────────────────────────────────────── */
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { }

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed');
  for (const f of failures) console.log('  · ' + f);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch(e => {
  console.error('harness error:', (e && e.stack) || e);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { }
  process.exitCode = 1;
});
