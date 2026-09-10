'use strict';

/* U2 · update check runtime.
 *
 * What this locks:
 *   [1] the fallback gate — fallback ONLY when no complete HTTP response entity
 *       was obtained; every other outcome is a hard failure that must not be
 *       retried down the other route (U-D1 Revised)
 *   [2] the two routes and the identity gate on the API route
 *   [3] ONE semver compare for the whole product (U-D4)
 *   [4] the 24 h cache, manual bypass, and "failures are never cached"
 *   [5] fail-open: check() never throws and never returns a non-answer
 *   [6] GET /__update-check — a thin endpoint that runs no check at boot
 *   [7] wiring (release payload, test registry)
 *
 * NO NETWORK. Every check injects a transport; the one behavioural server test
 * patches checkShared before creating the server. Temp files are cleaned up.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const uc = require(path.join(ROOT, 'runtime', 'update-check.js'));
const um = require(path.join(ROOT, 'runtime', 'update-manifest.js'));
const productVersion = require(path.join(ROOT, 'runtime', 'product-version.js'));

const GOOD_SHA = 'b'.repeat(64);
const GOOD_SIZE = 50787010;

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

/* ── Fixtures ────────────────────────────────────────────────────────────── */

function manifestFor(version, over) {
  const m = um.build({
    version: version, sha256: GOOD_SHA, sizeBytes: GOOD_SIZE,
    productVersion: version, releasedAt: '2026-09-10T06:00:00Z', notes: '修复若干问题'
  });
  return Object.assign(m, over || {});
}

/* A transport result as runtime/update-check.js defines it. */
function response(body, status, over) {
  return Object.assign({
    outcome: 'response', kind: null, message: null,
    status: typeof status === 'number' ? status : 200,
    headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body),
    finalUrl: null, hops: []
  }, over || {});
}
function network(kind, message) {
  return {
    outcome: 'network', kind: kind || 'connect-timeout', message: message || 'no response',
    status: null, headers: null, body: '', finalUrl: null, hops: []
  };
}
function protocol(kind, status) {
  return {
    outcome: 'protocol', kind: kind, message: kind,
    status: typeof status === 'number' ? status : null,
    headers: null, body: '', finalUrl: null, hops: []
  };
}

/* Scripted transport: `routes` maps a URL substring → result (or a function). */
function scripted(routes) {
  const calls = [];
  const fn = function (url, opts) {
    calls.push({ url: url, accept: (opts || {}).accept || '' });
    for (const key of Object.keys(routes)) {
      if (url.indexOf(key) >= 0) {
        const r = routes[key];
        return Promise.resolve(typeof r === 'function' ? r(url, opts) : r);
      }
    }
    return Promise.resolve(protocol('unscripted-url', null));
  };
  fn.calls = calls;
  fn.urls = function () { return calls.map(c => c.url); };
  return fn;
}

/* Isolated temp cache file per section. */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-u2-'));
let tmpSeq = 0;
function tmpCache() { return path.join(tmpRoot, 'c' + (++tmpSeq), 'update-check.json'); }
function cacheWrite(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
}
function cachePayload(manifest, checkedAtMs, over) {
  return Object.assign({
    schema: uc.CACHE_SCHEMA, schemaVersion: uc.CACHE_SCHEMA_VERSION,
    channel: um.CHANNEL_STABLE, checkedAt: new Date(checkedAtMs).toISOString(),
    transport: uc.TRANSPORT_DIRECT, manifest: manifest
  }, over || {});
}

const NOW = Date.parse('2026-09-10T12:00:00Z');

async function main() {
  console.log('Update check runtime (U2)\n');

  /* ═══ [1] the fallback gate ═══════════════════════════════════════════ */
  section('[1] fallback gate (U-D1 Revised)');

  await check('fallback is allowed for network outcome and nothing else', () => {
    assert.strictEqual(uc.fallbackAllowed({ outcome: 'network' }), true);
    assert.strictEqual(uc.fallbackAllowed({ outcome: 'response', status: 200 }), false);
    assert.strictEqual(uc.fallbackAllowed({ outcome: 'protocol', kind: 'http-status' }), false);
    assert.strictEqual(uc.fallbackAllowed(null), false);
    assert.strictEqual(uc.fallbackAllowed(undefined), false);
  });

  await check('the three outcomes are the whole vocabulary', () => {
    assert.strictEqual(uc.OUTCOME_RESPONSE, 'response');
    assert.strictEqual(uc.OUTCOME_NETWORK, 'network');
    assert.strictEqual(uc.OUTCOME_PROTOCOL, 'protocol');
  });

  await check('network kinds are exactly the U-D1 Revised list', () => {
    assert.deepStrictEqual(uc.NETWORK_KINDS.slice().sort(),
      ['connect-timeout', 'dns', 'refused', 'reset', 'socket', 'tls', 'unreachable']);
  });

  await check('socket errors classify into the frozen kinds', () => {
    const cases = [
      ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['EAI_FAIL', 'dns'],
      ['ETIMEDOUT', 'connect-timeout'], ['ESOCKETTIMEDOUT', 'connect-timeout'],
      ['ECONNRESET', 'reset'], ['EPIPE', 'reset'],
      ['ECONNREFUSED', 'refused'],
      ['EHOSTUNREACH', 'unreachable'], ['ENETUNREACH', 'unreachable'], ['ENETDOWN', 'unreachable'],
      ['EPROTO', 'tls'], ['CERT_HAS_EXPIRED', 'tls'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
      ['WEIRD_NEW_CODE', 'socket']
    ];
    for (const [code, kind] of cases) {
      const got = uc.classifyNetworkError(Object.assign(new Error('x'), { code: code }));
      assert.strictEqual(got, kind, code + ' → ' + got + ', expected ' + kind);
    }
  });

  await check('every classified kind is fallback-eligible (no orphan kinds)', () => {
    for (const kind of uc.NETWORK_KINDS) {
      assert.ok(uc.fallbackAllowed({ outcome: 'network', kind: kind }),
        kind + ' must be a network kind');
    }
  });

  await check('transport host allowlist is the frozen four, https only', () => {
    assert.deepStrictEqual(um.TRANSPORT_HOSTS.slice().sort(),
      ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
    assert.strictEqual(uc.hostAllowed('https://github.com/x'), true);
    assert.strictEqual(uc.hostAllowed('https://api.github.com/x'), true);
    assert.strictEqual(uc.hostAllowed('https://objects.githubusercontent.com/x'), true);
    assert.strictEqual(uc.hostAllowed('https://release-assets.githubusercontent.com/x'), true);
    assert.strictEqual(uc.hostAllowed('https://evil.example.com/x'), false);
    assert.strictEqual(uc.hostAllowed('http://github.com/x'), false, 'plain http must be refused');
    assert.strictEqual(uc.hostAllowed('https://github.com.evil.example/x'), false, 'suffix tricks refused');
    assert.strictEqual(uc.hostAllowed('not a url'), false);
  });

  await check('fetchText refuses a non-allowlisted URL without opening a socket', async () => {
    const r = await uc.fetchText('https://evil.example.com/update-stable.json');
    assert.strictEqual(r.outcome, 'protocol');
    assert.strictEqual(r.kind, 'host-not-allowed');
    const r2 = await uc.fetchText('http://github.com/update-stable.json');
    assert.strictEqual(r2.outcome, 'protocol');
    assert.strictEqual(r2.kind, 'host-not-allowed');
  });

  await check('every redirect hop is checked against the allowlist (static)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-check.js'), 'utf8');
    assert.ok(/hostAllowed\(next\)/.test(src),
      'the redirect target must be checked, not just the initial URL');
    assert.ok(/redirect-host-not-allowed/.test(src),
      'a redirect outside the allowlist must be a named protocol refusal');
    /* Redirects are followed by hand; an automatic follower would leave the
       allowlist. */
    assert.ok(!/followRedirect/.test(src), 'must not delegate redirect following to the HTTP client');
  });

  /* ═══ [2] the two routes ══════════════════════════════════════════════ */
  section('[2] primary route, then API fallback');

  await check('the primary URL is the frozen manifest URL, never rebuilt here', () => {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-check.js'), 'utf8');
    assert.ok(src.indexOf('releases/download') < 0,
      'update-check.js must not spell out a download path; MANIFEST_URL is the only source');
    assert.ok(src.indexOf("'v' +") < 0 && src.indexOf('"v" +') < 0,
      'update-check.js must not build a tag');
    assert.ok(src.indexOf('updateManifest.MANIFEST_URL') >= 0, 'primary URL comes from the contract module');
  });

  await check('up to date: primary answers, no fallback, manifest judged', async () => {
    const t = scripted({ '/latest/download/': response(manifestFor('1.0.0')) });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, uc.STATUS_UP_TO_DATE);
    assert.strictEqual(r.updateAvailable, false);
    assert.strictEqual(r.latestVersion, '1.0.0');
    assert.strictEqual(r.transport, uc.TRANSPORT_DIRECT);
    assert.strictEqual(r.error, null);
    assert.strictEqual(t.calls.length, 1, 'the primary route must be the only request');
    assert.strictEqual(t.calls[0].url, um.MANIFEST_URL);
  });

  await check('update available when the manifest is newer', async () => {
    const t = scripted({ '/latest/download/': response(manifestFor('1.2.0')) });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.status, uc.STATUS_UPDATE_AVAILABLE);
    assert.strictEqual(r.updateAvailable, true);
    assert.strictEqual(r.latestVersion, '1.2.0');
    assert.strictEqual(r.manifest.installer.sha256, GOOD_SHA);
  });

  await check('a LOWER manifest version never offers a downgrade', async () => {
    const t = scripted({ '/latest/download/': response(manifestFor('0.9.0')) });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.status, uc.STATUS_UP_TO_DATE);
    assert.strictEqual(r.updateAvailable, false);
  });

  await check('primary network failure → API route, real asset endpoint', async () => {
    const t = scripted({
      '/latest/download/': network('connect-timeout'),
      '/releases/latest': response({ tag_name: 'v1.2.0', draft: false, prerelease: false, name: 'r', assets: [{ name: 'update-stable.json', id: 987 }] }),
      '/releases/assets/987': response(manifestFor('1.2.0'))
    });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.status, uc.STATUS_UPDATE_AVAILABLE);
    assert.strictEqual(r.transport, uc.TRANSPORT_API);
    assert.strictEqual(r.latestVersion, '1.2.0');
    assert.deepStrictEqual(t.urls(), [um.MANIFEST_URL, um.API_LATEST_RELEASE, um.assetApiUrl(987)]);
    assert.strictEqual(t.calls[2].accept, 'application/octet-stream');
  });

  await check('every fallback-eligible network kind reaches the API route', async () => {
    for (const kind of uc.NETWORK_KINDS) {
      const t = scripted({
        '/latest/download/': network(kind),
        '/releases/latest': response({ tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [{ name: 'update-stable.json', id: 1 }] }),
        '/releases/assets/1': response(manifestFor('1.2.0'))
      });
      const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
      assert.strictEqual(r.status, uc.STATUS_UPDATE_AVAILABLE, kind + ' should have fallen back');
      assert.strictEqual(r.transport, uc.TRANSPORT_API, kind);
    }
  });

  await check('HARD failures never touch the API route (the whole rule)', async () => {
    const bad = {
      '404': response('Not Found', 404),
      '403-rate': response('rate limited', 403),
      '429': response('slow down', 429),
      '500': response('boom', 500),
      'not-json': response('this is not json'),
      'wrong-schema': response(Object.assign(manifestFor('1.2.0'), { schema: 'other.product' })),
      'bad-sha': response((() => { const m = manifestFor('1.2.0'); m.installer.sha256 = 'zz'; return m; })()),
      'bad-size': response((() => { const m = manifestFor('1.2.0'); m.installer.sizeBytes = 12; return m; })()),
      'url-mismatch': response((() => { const m = manifestFor('1.2.0'); m.installer.url = um.installerUrl('9.9.9'); return m; })()),
      'pv-mismatch': response((() => { const m = manifestFor('1.2.0'); m.installer.productVersion = '1.2.1'; return m; })()),
      'redirect-refused': protocol('redirect-host-not-allowed', 302),
      'too-many-redirects': protocol('too-many-redirects', 302),
      'body-too-large': protocol('body-too-large', 200)
    };
    for (const label of Object.keys(bad)) {
      const t = scripted({
        '/latest/download/': bad[label],
        '/releases/latest': response({ tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [{ name: 'update-stable.json', id: 1 }] }),
        '/releases/assets/1': response(manifestFor('1.2.0'))
      });
      const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
      assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION, label + ' must degrade to no-information');
      assert.strictEqual(r.ok, false, label);
      assert.strictEqual(t.calls.length, 1,
        label + ' made ' + t.calls.length + ' requests — a hard failure must NOT be retried on the other route');
    }
  });

  await check('the API route is tried at most once (no retry loop)', async () => {
    const t = scripted({
      '/latest/download/': network('dns'),
      '/releases/latest': network('reset')
    });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION);
    assert.strictEqual(r.transport, uc.TRANSPORT_API);
    assert.strictEqual(t.calls.length, 2);
  });

  await check('the asset download failing is final (no second detour)', async () => {
    const t = scripted({
      '/latest/download/': network('dns'),
      '/releases/latest': response({ tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [{ name: 'update-stable.json', id: 5 }] }),
      '/releases/assets/5': network('connect-timeout')
    });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION);
    assert.strictEqual(t.calls.length, 3);
    assert.strictEqual(r.error.kind, 'connect-timeout');
  });

  await check('API release must be published and stable (draft/prerelease)', async () => {
    const variants = [
      { tag_name: 'v1.2.0', draft: true, prerelease: false, assets: [{ name: 'update-stable.json', id: 1 }] },
      { tag_name: 'v1.2.0', draft: false, prerelease: true, assets: [{ name: 'update-stable.json', id: 1 }] },
      { tag_name: 'v1.2.0', assets: [{ name: 'update-stable.json', id: 1 }] },
      { tag_name: 'v1.2.0', draft: false, assets: [{ name: 'update-stable.json', id: 1 }] },
      { tag_name: 'latest', draft: false, prerelease: false, assets: [{ name: 'update-stable.json', id: 1 }] },
      { tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [{ name: 'OTHER.json', id: 1 }] },
      { tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [{ name: 'update-stable.json', id: 1 }, { name: 'update-stable.json', id: 2 }] },
      { tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [] },
      { tag_name: 'v1.2.0', draft: false, prerelease: false }
    ];
    for (const release of variants) {
      const t = scripted({ '/latest/download/': network('dns'), '/releases/latest': response(release) });
      const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
      assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION, JSON.stringify(release));
      assert.strictEqual(t.calls.length, 2, 'must not fetch an asset it did not accept');
      assert.strictEqual(r.error.kind, 'api-release-unusable');
    }
  });

  await check('the release payload itself must be JSON', async () => {
    const t = scripted({ '/latest/download/': network('dns'), '/releases/latest': response('<html>nope</html>') });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.error.kind, 'api-release-unusable');
  });

  await check('manifest version must match the release tag (asset identity)', async () => {
    const t = scripted({
      '/latest/download/': network('dns'),
      '/releases/latest': response({ tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [{ name: 'update-stable.json', id: 7 }] }),
      '/releases/assets/7': response(manifestFor('1.3.0'))
    });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION);
    assert.strictEqual(r.error.kind, 'identity-mismatch');
  });

  await check('selectManifestAsset is the only asset chooser and is exact', () => {
    assert.strictEqual(um.selectManifestAsset(null).ok, false);
    assert.strictEqual(um.selectManifestAsset({ draft: false, prerelease: false, tag_name: 'v1.0.0', assets: [{ name: 'Update-Stable.json', id: 1 }] }).ok, false,
      'the asset name match must be case-sensitive');
    const ok = um.selectManifestAsset({ draft: false, prerelease: false, tag_name: 'v1.2.3', assets: [{ name: 'update-stable.json', id: 42 }] });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.version, '1.2.3');
    assert.strictEqual(ok.assetId, 42);
    assert.strictEqual(um.assetApiUrl(0), null);
    assert.strictEqual(um.assetApiUrl('abc'), null);
  });

  /* ═══ [3] one semver compare ══════════════════════════════════════════ */
  section('[3] one semver compare (U-D4)');

  await check('productVersion.compare is numeric, not lexicographic', () => {
    assert.strictEqual(productVersion.compare('1.10.0', '1.9.0'), 1);
    assert.strictEqual(productVersion.compare('1.9.0', '1.10.0'), -1);
    assert.strictEqual(productVersion.compare('2.0.0', '1.99.99'), 1);
    assert.strictEqual(productVersion.compare('1.0.1', '1.0.0'), 1);
    assert.strictEqual(productVersion.compare('1.0.0', '1.0.0'), 0);
  });

  await check('compare refuses invalid input instead of guessing 0', () => {
    assert.strictEqual(productVersion.compare('1.0', '1.0.0'), null);
    assert.strictEqual(productVersion.compare('1.0.0', ''), null);
    assert.strictEqual(productVersion.compare('v1.0.0', '1.0.0'), null);
    assert.strictEqual(productVersion.compare(null, undefined), null);
    assert.strictEqual(productVersion.compare('1.0.0-beta', '1.0.0'), null);
  });

  await check('the update runtime delegates comparison instead of reimplementing it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-check.js'), 'utf8');
    assert.ok(/productVersion\.compare\(/.test(src), 'must call the one compare');
    assert.ok(!/\.major\b/.test(src) && !/\.minor\b/.test(src) && !/\.patch\b/.test(src),
      'update-check.js must not compare version fields itself');
    /* The browser must never carry a second implementation. */
    const jsDir = path.join(ROOT, 'assets', 'js');
    for (const name of fs.readdirSync(jsDir)) {
      if (!name.endsWith('.js')) continue;
      const s = fs.readFileSync(path.join(jsDir, name), 'utf8');
      assert.ok(!/semver|\bmajor\s*\*\s*10000/.test(s), name + ' appears to implement its own version compare');
    }
  });

  /* ═══ [4] cache ═══════════════════════════════════════════════════════ */
  section('[4] cache (24 h, manual bypass, failures never cached)');

  await check('the default cache lives outside the application directory', () => {
    assert.strictEqual(uc.CACHE_TTL_MS, 24 * 60 * 60 * 1000);
    const def = uc.cacheFile();
    assert.ok(path.resolve(def).indexOf(path.resolve(ROOT)) !== 0,
      'the update cache must never be written into {app}: ' + def);
    assert.ok(/update-check\.json$/.test(def), def);
  });

  await check('a successful check writes the cache and the second check is offline', async () => {
    const file = tmpCache();
    const t1 = scripted({ '/latest/download/': response(manifestFor('1.2.0')) });
    const r1 = await uc.check({ currentVersion: '1.0.0', transport: t1, now: NOW, cacheFile: file });
    assert.strictEqual(r1.fromCache, false);
    assert.ok(fs.existsSync(file), 'the cache must be written after a determination');

    const t2 = scripted({});
    const r2 = await uc.check({ currentVersion: '1.0.0', transport: t2, now: NOW + 1000, cacheFile: file });
    assert.strictEqual(r2.fromCache, true);
    assert.strictEqual(r2.status, uc.STATUS_UPDATE_AVAILABLE);
    assert.strictEqual(r2.latestVersion, '1.2.0');
    assert.strictEqual(t2.calls.length, 0, 'a fresh cache must not hit the network');
    assert.strictEqual(r2.checkedAt, r1.checkedAt, 'fromCache must report the original answer time');
  });

  await check('a manual check (force) bypasses the cache and refreshes it', async () => {
    const file = tmpCache();
    await uc.check({ currentVersion: '1.0.0', transport: scripted({ '/latest/download/': response(manifestFor('1.2.0')) }), now: NOW, cacheFile: file });
    const t = scripted({ '/latest/download/': response(manifestFor('1.4.0')) });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW + 2000, cacheFile: file, force: true });
    assert.strictEqual(t.calls.length, 1, 'force must go to the network');
    assert.strictEqual(r.fromCache, false);
    assert.strictEqual(r.latestVersion, '1.4.0');
    const again = await uc.check({ currentVersion: '1.0.0', transport: scripted({}), now: NOW + 3000, cacheFile: file });
    assert.strictEqual(again.latestVersion, '1.4.0', 'the refreshed cache must hold the new answer');
  });

  await check('the cache expires exactly at 24 h, not before', async () => {
    const file = tmpCache();
    cacheWrite(file, cachePayload(manifestFor('1.2.0'), NOW));
    const boundary = uc.readCache({ cacheFile: file, now: NOW + uc.CACHE_TTL_MS });
    assert.strictEqual(boundary.hit, true, 'age == TTL is still fresh');
    const expired = uc.readCache({ cacheFile: file, now: NOW + uc.CACHE_TTL_MS + 1 });
    assert.strictEqual(expired.hit, false);
    assert.ok(/24 h/.test(expired.why), expired.why);
  });

  await check('a cache that no longer validates is a miss, never an answer', () => {
    const variants = [
      ['broken json', '{ not json'],
      ['not an object', '[1,2,3]'],
      ['wrong schema', cachePayload(manifestFor('1.2.0'), NOW, { schema: 'other' })],
      ['wrong version', cachePayload(manifestFor('1.2.0'), NOW, { schemaVersion: 99 })],
      ['wrong channel', cachePayload(manifestFor('1.2.0'), NOW, { channel: 'beta' })],
      ['bad timestamp', cachePayload(manifestFor('1.2.0'), NOW, { checkedAt: 'yesterday' })],
      ['future dated', cachePayload(manifestFor('1.2.0'), NOW + 60000)],
      ['bad manifest', cachePayload((() => { const m = manifestFor('1.2.0'); m.installer.sha256 = 'nope'; return m; })(), NOW)]
    ];
    for (const [label, payload] of variants) {
      const file = tmpCache();
      cacheWrite(file, payload);
      const at = label === 'future dated' ? NOW : NOW + 1000;
      const r = uc.readCache({ cacheFile: file, now: at });
      assert.strictEqual(r.hit, false, label + ' must be a cache miss');
    }
  });

  await check('a failure is never cached', async () => {
    const file = tmpCache();
    const t = scripted({ '/latest/download/': protocol('http-status', 404) });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: file });
    assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION);
    assert.strictEqual(fs.existsSync(file), false, 'an outage must not be cached for 24 h');
  });

  await check('useCache:false neither reads nor writes', async () => {
    const file = tmpCache();
    cacheWrite(file, cachePayload(manifestFor('9.9.9'), NOW));
    const t = scripted({ '/latest/download/': response(manifestFor('1.2.0')) });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW + 1000, cacheFile: file, useCache: false });
    assert.strictEqual(t.calls.length, 1, 'must not read the cache');
    assert.strictEqual(r.latestVersion, '1.2.0');
    const after = uc.readCache({ cacheFile: file, now: NOW + 1000 });
    assert.strictEqual(after.manifest.version, '9.9.9', 'must not overwrite the cache either');
  });

  await check('an unwritable cache is a warning, not a failure', async () => {
    const blocker = path.join(tmpRoot, 'blocker-file');
    fs.writeFileSync(blocker, 'x');
    const t = scripted({ '/latest/download/': response(manifestFor('1.2.0')) });
    const r = await uc.check({
      currentVersion: '1.0.0', transport: t, now: NOW,
      cacheFile: path.join(blocker, 'nested', 'update-check.json')
    });
    assert.strictEqual(r.ok, true, 'the answer is still valid');
    assert.strictEqual(r.status, uc.STATUS_UPDATE_AVAILABLE);
    assert.ok(r.warnings.some(w => w.field === 'cache'), JSON.stringify(r.warnings));
  });

  /* ═══ [5] fail-open ═══════════════════════════════════════════════════ */
  section('[5] fail-open: never throws, never a non-answer');

  await check('check() always returns a promise, even for a bad current version', async () => {
    const p = uc.check({ currentVersion: 'not-a-version', transport: scripted({}), cacheFile: tmpCache() });
    assert.strictEqual(typeof p.then, 'function', 'must be a thenable');
    const r = await p;
    assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION);
    assert.strictEqual(r.error.kind, 'bad-current-version');
  });

  await check('a transport that throws synchronously is still no-information', async () => {
    const t = function () { throw new Error('boom'); };
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.ok(r && r.status, 'must resolve to a result, got ' + JSON.stringify(r));
    assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION);
  });

  await check('a transport that rejects is treated as a network failure (fallback allowed)', async () => {
    const dnsErr = Object.assign(new Error('dns'), { code: 'ENOTFOUND' });
    const seen = [];
    const t = function (url) {
      seen.push(url);
      if (seen.length === 1) return Promise.reject(dnsErr);
      if (url.indexOf('/releases/latest') >= 0) {
        return Promise.resolve(response({ tag_name: 'v1.2.0', draft: false, prerelease: false, assets: [{ name: 'update-stable.json', id: 3 }] }));
      }
      return Promise.resolve(response(manifestFor('1.2.0')));
    };
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.attempts[0].kind, 'dns', 'a rejection must classify as a network kind');
    assert.strictEqual(r.attempts[0].transport, uc.TRANSPORT_DIRECT);
    assert.ok(r.attempts.some(a => a.transport === uc.TRANSPORT_API),
      'a rejected fetch must still be fallback-eligible');
    assert.strictEqual(r.status, uc.STATUS_UPDATE_AVAILABLE, 'the fallback must be able to succeed');
  });

  await check('garbage from a transport cannot escape as an exception', async () => {
    const shapes = [undefined, null, 42, 'text', {}, { outcome: 'nonsense' }];
    for (const s of shapes) {
      const r = await uc.check({ currentVersion: '1.0.0', transport: () => Promise.resolve(s), now: NOW, cacheFile: tmpCache() });
      assert.ok(r && typeof r.status === 'string', 'shape ' + JSON.stringify(s) + ' produced ' + JSON.stringify(r));
      assert.strictEqual(r.status, uc.STATUS_NO_INFORMATION, JSON.stringify(s));
    }
  });

  await check('every no-information result carries a usable error and an attempt trail', async () => {
    const t = scripted({ '/latest/download/': protocol('http-status', 404) });
    const r = await uc.check({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache() });
    assert.strictEqual(r.checkedAt, null);
    assert.strictEqual(r.latestVersion, null);
    assert.strictEqual(r.manifest, null);
    assert.ok(r.error && r.error.kind && r.error.message);
    assert.ok(Array.isArray(r.attempts) && r.attempts.length >= 1);
    assert.strictEqual(r.attempts[0].status, 404);
    assert.strictEqual(r.attempts[0].transport, uc.TRANSPORT_DIRECT);
  });

  await check('the runtime module has no execution surface', () => {
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-check.js'), 'utf8');
    assert.ok(src.indexOf('process.exit') < 0, 'must never exit the host process');
    assert.ok(src.indexOf('child_process') < 0, 'must never spawn anything');
    assert.ok(src.indexOf('shell') < 0, 'no shell surface');
    assert.ok(src.indexOf('eval(') < 0, 'no eval');
    assert.ok(src.indexOf('require.main') < 0, 'no CLI: this module is a library');
  });

  await check('no credentials are ever sent (U-D1 Revised item 7)', () => {
    for (const rel of ['runtime/update-check.js', 'runtime/update-manifest.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.ok(!/authorization/i.test(src), rel + ' must not send an Authorization header');
      assert.ok(!/ghp_|gho_|github_pat_/.test(src), rel + ' must not embed a token');
      assert.ok(!/GITHUB_TOKEN|process\.env\.\w*TOKEN/i.test(src), rel + ' must not read a token from the environment');
    }
  });

  /* ═══ [6] single flight + the server endpoint ═════════════════════════ */
  section('[6] single flight and GET /__update-check');

  await check('concurrent automatic checks share one round trip', async () => {
    uc.resetInFlight();
    let calls = 0;
    const t = function (url) {
      calls++;
      return new Promise(resolve => setTimeout(() => resolve(response(manifestFor('1.2.0'))), 30));
    };
    const opts = () => ({ currentVersion: '1.0.0', transport: t, now: NOW, cacheFile: tmpCache(), useCache: false });
    const results = await Promise.all([uc.checkShared(opts()), uc.checkShared(opts()), uc.checkShared(opts())]);
    assert.strictEqual(calls, 1, 'three callers must share one request, saw ' + calls);
    for (const r of results) assert.strictEqual(r.status, uc.STATUS_UPDATE_AVAILABLE);
    assert.strictEqual(results[0], results[2], 'the shared promise resolves to the same result');
    uc.resetInFlight();
  });

  await check('a manual check does not join an automatic one', async () => {
    uc.resetInFlight();
    let calls = 0;
    const t = function () {
      calls++;
      return new Promise(resolve => setTimeout(() => resolve(response(manifestFor('1.2.0'))), 30));
    };
    const base = { currentVersion: '1.0.0', transport: t, now: NOW, useCache: false };
    await Promise.all([
      uc.checkShared(Object.assign({}, base, { cacheFile: tmpCache() })),
      uc.checkShared(Object.assign({}, base, { cacheFile: tmpCache(), force: true }))
    ]);
    assert.strictEqual(calls, 2, 'a manual check must be a real check, saw ' + calls + ' requests');
    uc.resetInFlight();
  });

  /* The behavioural half: patch the module the server will call, then prove no
     check happens at boot and one happens per request. */
  const realCheckShared = uc.checkShared;
  let serverChecks = [];

  await check('the static server runs NO update check at boot', async () => {
    uc.checkShared = function (o) {
      serverChecks.push(o || {});
      return Promise.resolve({
        ok: true, status: uc.STATUS_UPDATE_AVAILABLE, updateAvailable: true,
        currentVersion: '1.0.0', latestVersion: '1.2.0', transport: uc.TRANSPORT_DIRECT,
        fromCache: false, checkedAt: '2026-09-10T12:00:00Z', error: null,
        manifest: manifestFor('1.2.0'), attempts: [], warnings: []
      });
    };
    delete require.cache[require.resolve(path.join(ROOT, 'services', 'internal-beyond-server.js'))];
    const server = require(path.join(ROOT, 'services', 'internal-beyond-server.js'))
      .createWebServer({ port: 0, host: '127.0.0.1' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    server.__testPort = server.address().port;
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(serverChecks.length, 0,
      'the server must not check for updates while starting: ' + JSON.stringify(serverChecks));
    global.__ibTestServer = server;
  });

  await check('GET /__update-check is thin, cached-optional and 200-always', async () => {
    const server = global.__ibTestServer;
    const port = server.__testPort;
    const get = function (p, origin) {
      return new Promise((resolve, reject) => {
        const headers = {};
        if (origin) headers.Origin = origin;
        const req = http.request({ host: '127.0.0.1', port: port, path: p, method: 'GET', headers: headers }, res => {
          let body = '';
          res.on('data', c => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body }));
        });
        req.on('error', reject);
        req.end();
      });
    };

    const plain = await get('/__update-check');
    assert.strictEqual(plain.status, 200);
    assert.strictEqual(plain.headers['cache-control'], 'no-store');
    assert.strictEqual(serverChecks.length, 1, 'exactly one check for one request');
    assert.strictEqual(serverChecks[0].force, false, 'a plain check is not forced');
    const body = JSON.parse(plain.body);
    assert.strictEqual(body.updateAvailable, true);
    assert.strictEqual(body.latestVersion, '1.2.0');
    assert.strictEqual(body.update.version, '1.2.0');
    assert.strictEqual(body.update.notes, '修复若干问题');
    assert.strictEqual(body.update.sha256, GOOD_SHA);
    assert.ok(!('manifest' in body), 'the raw manifest must not be forwarded');
    assert.ok(!('attempts' in body), 'internals must not be forwarded');
    assert.ok(!('warnings' in body), 'internals must not be forwarded');

    const forced = await get('/__update-check?force=1');
    assert.strictEqual(forced.status, 200);
    assert.strictEqual(serverChecks.length, 2);
    assert.strictEqual(serverChecks[1].force, true, '?force=1 is the manual check');
    assert.strictEqual(JSON.parse((await get('/__update-check?force=true')).body).ok, true);

    /* A foreign page must not be able to spend the user's API quota. */
    const foreign = await get('/__update-check', 'https://evil.example.com');
    assert.strictEqual(foreign.status, 403);
    assert.strictEqual(serverChecks.length, 3, 'a denied request must not run a check');

    /* file:// and loopback origins (the real app) stay allowed. */
    assert.strictEqual((await get('/__update-check', 'null')).status, 200, 'file:// origin (null) must be allowed');
    assert.strictEqual((await get('/__update-check', 'http://127.0.0.1:23120')).status, 200, 'loopback origin must be allowed');
    assert.ok(serverChecks.length >= 4);
    serverChecks.length = 0;

    const put = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: port, path: '/__update-check', method: 'PUT' }, res => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('error', reject); req.end();
    });
    assert.strictEqual(put, 405);
    assert.strictEqual(serverChecks.length, 0, 'a rejected method must not run a check');
  });

  await check('summarize() exposes exactly the frozen projection', () => {
    const full = uc.summarize({
      ok: true, status: uc.STATUS_UPDATE_AVAILABLE, updateAvailable: true,
      currentVersion: '1.0.0', latestVersion: '1.2.0', fromCache: false,
      transport: uc.TRANSPORT_API, checkedAt: '2026-09-10T12:00:00Z', error: null,
      manifest: manifestFor('1.2.0'), attempts: [{ secret: true }], warnings: [{ secret: true }]
    });
    assert.deepStrictEqual(Object.keys(full).sort(),
      ['checkedAt', 'currentVersion', 'error', 'fromCache', 'latestVersion', 'ok', 'status',
        'transport', 'update', 'updateAvailable']);
    assert.deepStrictEqual(Object.keys(full.update).sort(),
      ['minimumVersion', 'notes', 'notesUrl', 'releasedAt', 'sha256', 'sizeBytes', 'version']);

    const none = uc.summarize({ ok: false, status: uc.STATUS_NO_INFORMATION, updateAvailable: false, error: { kind: 'dns', message: 'x' } });
    assert.strictEqual(none.update, null, 'no update block when there is no update');
    assert.deepStrictEqual(none.error, { kind: 'dns', message: 'x' });
    const empty = uc.summarize(null);
    assert.strictEqual(empty.status, uc.STATUS_NO_INFORMATION);
    assert.strictEqual(empty.ok, false);
  });

  await check('a server check that somehow rejects still answers 200/no-information', async () => {
    const server = global.__ibTestServer;
    uc.checkShared = function () { return Promise.reject(new Error('synthetic internal failure')); };
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.__testPort, path: '/__update-check' }, res => {
        let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject); req.end();
    });
    assert.strictEqual(body.status, 200, 'the UI must never see an error status for a failed check');
    const parsed = JSON.parse(body.body);
    assert.strictEqual(parsed.status, uc.STATUS_NO_INFORMATION);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.update, null);
    assert.ok(parsed.error && parsed.error.kind === 'internal-error');
  });

  await check('closing the server leaves no check in flight', async () => {
    const server = global.__ibTestServer;
    /* Node's global agent keeps sockets alive; without this, close() can hang
       and the test would look like a hang instead of a pass. */
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    uc.checkShared = realCheckShared;
    uc.resetInFlight();
    delete require.cache[require.resolve(path.join(ROOT, 'services', 'internal-beyond-server.js'))];
  });

  /* ═══ [7] wiring ══════════════════════════════════════════════════════ */
  section('[7] wiring');

  await check('a broken update module cannot stop the app from starting', async () => {
    /* The frozen invariant is fail-open: update machinery must never block
       startup. Simulate the module being unloadable and prove the static server
       still comes up and still answers -- with "no information", not a crash. */
    const Module = require('module');
    const target = require.resolve(path.join(ROOT, 'runtime', 'update-check.js'));
    const original = Module.prototype.require;
    Module.prototype.require = function (request) {
      const resolved = (() => { try { return Module._resolveFilename(request, this); } catch (e) { return null; } })();
      if (resolved === target) throw new Error('synthetic: update module is unloadable');
      return original.apply(this, arguments);
    };
    const serverPath = require.resolve(path.join(ROOT, 'services', 'internal-beyond-server.js'));
    let server = null;
    try {
      delete require.cache[serverPath];
      server = require(serverPath).createWebServer({ port: 0, host: '127.0.0.1' });
    } finally {
      Module.prototype.require = original;
    }
    assert.ok(server, 'the server must still be constructible');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: port, path: '/__update-check' }, r => {
        let b = ''; r.on('data', c => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', reject); req.end();
    });
    assert.strictEqual(res.status, 200, 'the endpoint must still answer');
    const parsed = JSON.parse(res.body);
    assert.strictEqual(parsed.status, 'no-information');
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.update, null);
    assert.strictEqual(parsed.error.kind, 'update-module-unavailable');
    assert.ok(/unloadable/.test(parsed.error.message), parsed.error.message);
    /* And the rest of the app is untouched: static files still serve. */
    const page = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: port, path: '/health' }, r => {
        let b = ''; r.on('data', c => { b += c; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', reject); req.end();
    });
    assert.strictEqual(page.status, 200);
    assert.strictEqual(JSON.parse(page.body).ok, true, 'the app itself must be unaffected');
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    delete require.cache[serverPath];
  });

  await check('runtime/update-check.js ships in the release payload', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'release-manifest.js'), 'utf8');
    assert.ok(/runtime\/update-check\.js/.test(src), 'the updater runtime must be in the payload whitelist');
  });

  await check('the launcher never requires the update runtime (not on the critical path)', () => {
    const launcher = fs.readFileSync(path.join(ROOT, 'runtime', 'launch-internal-beyond.js'), 'utf8');
    assert.ok(launcher.indexOf('update-check') < 0, 'the launch chain must not touch update checking');
    assert.ok(launcher.indexOf('update-manifest') < 0, 'the launch chain must not touch the update contract');
    const runner = fs.readFileSync(path.join(ROOT, 'runtime', 'local-services-runner.js'), 'utf8');
    assert.ok(runner.indexOf('update-check') < 0, 'the service runner must not check for updates');
  });

  await check('test_update_check.js is registered in the suite', () => {
    const src = fs.readFileSync(path.join(ROOT, 'tests', 'test-all.js'), 'utf8');
    assert.ok(/test_update_check\.js/.test(src), 'the U2 test must be registered');
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
