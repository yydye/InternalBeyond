'use strict';

/* U1 · update manifest contract (Stable channel).
 *
 * Pure contract test: no network, no install, no browser, no build. It locks the
 * shape of dist\update-stable.json, the one URL constructor, and the client-side
 * validator/parser that U2 will call on a fetched manifest.
 *
 * The real end-to-end check (a manifest generated from a freshly compiled
 * installer, with matching hash/size/PE version) lives in test_installer_build.js,
 * which needs Inno Setup and is opt-in.
 *
 * Zero deps. No process.exit(); temp files are cleaned up.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const um = require(path.join(ROOT, 'runtime', 'update-manifest.js'));
const productVersion = require(path.join(ROOT, 'runtime', 'product-version.js'));

const PRODUCT = productVersion.read();
const GOOD_SHA = 'a'.repeat(64);
const GOOD_SIZE = 50787010;

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}

/* A manifest that must validate, built from measured-looking values. */
function goodManifest(over) {
  const base = um.build({
    version: '1.0.0',
    sha256: GOOD_SHA,
    sizeBytes: GOOD_SIZE,
    productVersion: '1.0.0',
    releasedAt: '2026-09-10T06:00:00Z',
    notes: '修复若干问题'
  });
  return Object.assign(base, over || {});
}
/* Deep-ish override of the installer block. */
function withInstaller(over) {
  const m = goodManifest();
  m.installer = Object.assign({}, m.installer, over);
  return m;
}
function expectError(manifest, field, label) {
  const r = um.validate(manifest);
  assert.strictEqual(r.ok, false, label + ': expected rejection, got ok');
  assert.ok(r.errors.some(e => e.field === field),
    label + ': expected an error on ' + field + ', got ' + JSON.stringify(r.errors));
  return r;
}

console.log('Update manifest contract (U1)\n');

/* ── [1] frozen distribution identity ───────────────────────────────────── */
console.log('[1] frozen identity (U-D1)');

check('stable manifest URL is the frozen GitHub Release asset', () => {
  assert.strictEqual(um.MANIFEST_URL,
    'https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json');
  assert.strictEqual(um.MANIFEST_ASSET, 'update-stable.json');
  assert.strictEqual(um.CHANNEL_STABLE, 'stable');
  assert.strictEqual(um.SCHEMA, 'internalbeyond.update');
  assert.strictEqual(um.SCHEMA_VERSION, 1);
});

check('installer URL is complete and version-pinned (tag + asset from one place)', () => {
  const url = um.installerUrl('1.2.3');
  assert.strictEqual(url, 'https://github.com/yydye/InternalBeyond/releases/download/v1.2.3/InternalBeyond-Setup-1.2.3.exe');
  assert.strictEqual(um.installerAssetName('1.2.3'), 'InternalBeyond-Setup-1.2.3.exe');
  assert.strictEqual(um.tagFor('1.2.3'), 'v1.2.3');
});

check('every install artifact name derives from the version, never a literal', () => {
  /* The build script may not spell out a tag or asset name itself. */
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-installer.ps1'), 'utf8');
  assert.ok(build.indexOf('releases/download') < 0, 'build script must not hand-write a download URL');
  assert.ok(build.indexOf("'v' + ") < 0 && build.indexOf('"v" + ') < 0, 'build script must not build a tag itself');
  assert.ok(build.indexOf('update-manifest.js') >= 0, 'build script must go through the shared module');
});

/* ── [2] build() is honest ──────────────────────────────────────────────── */
console.log('\n[2] build()');

check('produces the frozen schema with a fixed key order', () => {
  const m = goodManifest();
  assert.deepStrictEqual(Object.keys(m),
    ['schema', 'schemaVersion', 'channel', 'version', 'installer', 'releasedAt', 'notes']);
  assert.deepStrictEqual(Object.keys(m.installer), ['url', 'sha256', 'sizeBytes', 'productVersion']);
  assert.strictEqual(m.channel, 'stable');
  assert.strictEqual(m.schemaVersion, 1);
});

check('omits releasedAt/notes instead of inventing them', () => {
  const m = um.build({ version: '1.0.1', sha256: GOOD_SHA, sizeBytes: GOOD_SIZE, productVersion: '1.0.1' });
  assert.ok(!('releasedAt' in m), 'releasedAt must be absent, not fabricated');
  assert.ok(!('notes' in m), 'notes must be absent, not fabricated');
  assert.ok(!('minimumVersion' in m), 'minimumVersion must be absent, not fabricated');
  assert.strictEqual(um.validate(m).ok, true, 'a manifest without the optional fields is still valid');
});

check('never writes a timestamp of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-manifest.js'), 'utf8');
  assert.ok(src.indexOf('new Date') < 0, 'module must not synthesize a date');
  assert.ok(src.indexOf('Date.now') < 0, 'module must not synthesize a timestamp');
});

check('normalizes sha256 to lowercase and rejects junk', () => {
  assert.strictEqual(um.build({ version: '1.0.0', sha256: GOOD_SHA.toUpperCase(), sizeBytes: GOOD_SIZE, productVersion: '1.0.0' })
    .installer.sha256, GOOD_SHA);
});

check('url always points at the manifest version', () => {
  for (const v of ['0.0.1', '1.0.0', '1.10.0']) {
    assert.strictEqual(um.build({ version: v, sha256: GOOD_SHA, sizeBytes: GOOD_SIZE, productVersion: v }).installer.url,
      um.installerUrl(v));
  }
});

check('serialize() is deterministic JSON with a trailing newline and LF only', () => {
  const text = um.serialize(goodManifest());
  assert.ok(text.endsWith('}\n'), 'must end with a newline');
  assert.ok(text.indexOf('\r') < 0, 'must be LF only');
  assert.strictEqual(text.indexOf('  "schema"'), 2, 'must be 2-space indented');
  assert.deepStrictEqual(JSON.parse(text), JSON.parse(um.serialize(goodManifest())), 'byte-stable output');
});

/* ── [3] validate() accepts the good case ───────────────────────────────── */
console.log('\n[3] validate() · accepted');

check('a complete manifest validates with no errors', () => {
  const r = um.validate(goodManifest());
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
});

check('the manifest for the current VERSION validates', () => {
  const m = um.build({
    version: PRODUCT.version, sha256: GOOD_SHA, sizeBytes: GOOD_SIZE, productVersion: PRODUCT.version
  });
  assert.strictEqual(um.validate(m).ok, true, JSON.stringify(um.validate(m).errors));
});

check('unknown extra fields are tolerated (forward compatibility)', () => {
  const m = goodManifest({ futureField: 'whatever' });
  const r = um.validate(m);
  assert.strictEqual(r.ok, true, 'a newer publisher must not break an older client');
  assert.ok(r.warnings.some(w => /futureField/.test(w.why)), 'the drift must be reported as a warning');
});

check('a query string on the installer URL is tolerated', () => {
  const m = withInstaller({ url: um.installerUrl('1.0.0') + '?download=1' });
  assert.strictEqual(um.validate(m).ok, true);
});

/* ── [4] validate() rejects what the updater depends on ─────────────────── */
console.log('\n[4] validate() · rejected');

check('rejects a foreign schema or a newer schemaVersion', () => {
  expectError(goodManifest({ schema: 'other.thing' }), 'schema', 'schema');
  expectError(goodManifest({ schemaVersion: 2 }), 'schemaVersion', 'schemaVersion');
});

check('rejects an unknown channel', () => {
  expectError(goodManifest({ channel: 'beta' }), 'channel', 'channel');
  expectError(goodManifest({ channel: undefined }), 'channel', 'channel missing');
});

check('rejects a malformed version and minimumVersion', () => {
  expectError(goodManifest({ version: '1.0' }), 'version', 'version 1.0');
  expectError(goodManifest({ version: 1.1 }), 'version', 'version number');
  expectError(goodManifest({ minimumVersion: 'v1.0.0' }), 'minimumVersion', 'minimumVersion');
});

check('rejects a missing installer block', () => {
  expectError(goodManifest({ installer: null }), 'installer', 'installer null');
  expectError(goodManifest({ installer: [] }), 'installer', 'installer array');
});

check('rejects non-https, foreign host, foreign repo and non-release URLs', () => {
  expectError(withInstaller({ url: um.installerUrl('1.0.0').replace('https://', 'http://') }), 'installer.url', 'http');
  expectError(withInstaller({ url: 'https://evil.example.com/yydye/InternalBeyond/releases/download/v1.0.0/InternalBeyond-Setup-1.0.0.exe' }),
    'installer.url', 'foreign host');
  expectError(withInstaller({ url: 'https://github.com/attacker/InternalBeyond/releases/download/v1.0.0/InternalBeyond-Setup-1.0.0.exe' }),
    'installer.url', 'foreign repo');
  expectError(withInstaller({ url: 'https://github.com/yydye/InternalBeyond/raw/main/setup.exe' }), 'installer.url', 'raw path');
  expectError(withInstaller({ url: '' }), 'installer.url', 'empty');
  expectError(withInstaller({ url: 'not a url' }), 'installer.url', 'not a url');
});

check('rejects a URL whose version, tag or asset does not match the manifest', () => {
  expectError(withInstaller({ url: um.installerUrl('9.9.9') }), 'installer.url', 'url version mismatch');
  expectError(withInstaller({ url: 'https://github.com/yydye/InternalBeyond/releases/download/1.0.0/InternalBeyond-Setup-1.0.0.exe' }),
    'installer.url', 'tag without v');
  expectError(withInstaller({ url: 'https://github.com/yydye/InternalBeyond/releases/download/v1.0.0/other.exe' }),
    'installer.url', 'wrong asset');
  expectError(withInstaller({ url: 'https://github.com/yydye/InternalBeyond/releases/download/v1.0.0/InternalBeyond-Setup-9.9.9.exe' }),
    'installer.url', 'asset version mismatch');
});

check('rejects a bad sha256', () => {
  expectError(withInstaller({ sha256: 'abc' }), 'installer.sha256', 'too short');
  expectError(withInstaller({ sha256: 'z'.repeat(64) }), 'installer.sha256', 'non-hex');
  expectError(withInstaller({ sha256: undefined }), 'installer.sha256', 'missing');
  expectError(withInstaller({ sha256: 'a'.repeat(63) }), 'installer.sha256', '63 chars');
  expectError(withInstaller({ sha256: 'a'.repeat(65) }), 'installer.sha256', '65 chars');
});

check('rejects an implausible size (truncation / nonsense guard)', () => {
  expectError(withInstaller({ sizeBytes: 0 }), 'installer.sizeBytes', 'zero');
  expectError(withInstaller({ sizeBytes: 1024 }), 'installer.sizeBytes', 'too small');
  expectError(withInstaller({ sizeBytes: 900 * 1024 * 1024 }), 'installer.sizeBytes', 'too large');
  expectError(withInstaller({ sizeBytes: 1.5 }), 'installer.sizeBytes', 'non-integer');
  expectError(withInstaller({ sizeBytes: '50787010' }), 'installer.sizeBytes', 'string');
  expectError(withInstaller({ sizeBytes: undefined }), 'installer.sizeBytes', 'missing');
});

check('rejects productVersion that disagrees with version', () => {
  expectError(withInstaller({ productVersion: '1.0.1' }), 'installer.productVersion', 'mismatch');
  expectError(withInstaller({ productVersion: 'v1.0.0' }), 'installer.productVersion', 'not semver');
});

check('rejects a malformed releasedAt', () => {
  expectError(goodManifest({ releasedAt: '2026-09-10' }), 'releasedAt', 'date only');
  expectError(goodManifest({ releasedAt: '2026-09-10T06:00:00+08:00' }), 'releasedAt', 'non-UTC offset');
  expectError(goodManifest({ releasedAt: 'yesterday' }), 'releasedAt', 'prose');
});

check('rejects oversized notes and a non-https notesUrl', () => {
  expectError(goodManifest({ notes: 'x'.repeat(um.NOTES_MAX_CHARS + 1) }), 'notes', 'too long');
  expectError(goodManifest({ notesUrl: 'http://github.com/yydye/InternalBeyond/releases' }), 'notesUrl', 'http');
  expectError(goodManifest({ notesUrl: 'https://evil.example.com/x' }), 'notesUrl', 'foreign host');
});

check('warns (does not fail) when notes contain angle brackets', () => {
  const r = um.validate(goodManifest({ notes: 'fix <bug> in parser' }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some(w => w.field === 'notes'), 'must warn so the UI renders it as text');
});

check('a non-object manifest is rejected without throwing', () => {
  for (const bad of [null, undefined, 42, 'text', []]) {
    const r = um.validate(bad);
    assert.strictEqual(r.ok, false, 'must reject ' + JSON.stringify(bad));
  }
});

/* ── [5] parseInstallerUrl() ────────────────────────────────────────────── */
console.log('\n[5] parseInstallerUrl()');

check('round-trips the constructed URL', () => {
  const p = um.parseInstallerUrl(um.installerUrl('1.10.0'));
  assert.deepStrictEqual(p, {
    ok: true, why: null, host: 'github.com', tag: 'v1.10.0', version: '1.10.0',
    asset: 'InternalBeyond-Setup-1.10.0.exe'
  });
});

check('returns a reason instead of throwing on junk', () => {
  for (const bad of ['', null, undefined, 'javascript:alert(1)', 'https://github.com/', 'https://github.com/a/b/c/d/e/f/g']) {
    const p = um.parseInstallerUrl(bad);
    assert.strictEqual(p.ok, false, 'must reject ' + JSON.stringify(bad));
    assert.ok(typeof p.why === 'string' && p.why.length > 0, 'must explain the rejection');
  }
});

/* ── [6] writeManifest() ────────────────────────────────────────────────── */
console.log('\n[6] writeManifest()');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-update-manifest-'));

check('writes a valid manifest and reports what it could not supply', () => {
  const out = path.join(tmp, 'update-stable.json', 'nested.json');
  const r = um.writeManifest({
    out: out, version: '1.0.0', sha256: GOOD_SHA, sizeBytes: GOOD_SIZE, productVersion: '1.0.0'
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.strictEqual(r.releasedAtSupplied, false);
  assert.strictEqual(r.notesSupplied, false);
  const written = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(written.installer.sha256, GOOD_SHA);
  assert.strictEqual(um.validate(written).ok, true);
});

check('refuses to write a manifest that fails validation', () => {
  const out = path.join(tmp, 'invalid.json');
  const r = um.writeManifest({
    out: out, version: '1.0.0', sha256: 'nope', sizeBytes: GOOD_SIZE, productVersion: '1.0.0'
  });
  assert.strictEqual(r.ok, false, 'must not report success');
  assert.ok(r.errors.length > 0, 'must explain why');
  assert.strictEqual(fs.existsSync(out), false, 'a broken contract must never reach disk');
});

check('does not leak a build-time only field into the file', () => {
  const out = path.join(tmp, 'noleak.json');
  um.writeManifest({ out: out, version: '1.0.0', sha256: GOOD_SHA, sizeBytes: GOOD_SIZE, productVersion: '1.0.0' });
  const keys = Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')));
  const allowed = ['schema', 'schemaVersion', 'channel', 'version', 'releasedAt', 'minimumVersion', 'installer', 'notes', 'notesUrl'];
  for (const k of keys) assert.ok(allowed.indexOf(k) >= 0, 'unexpected key in published manifest: ' + k);
});

/* ── [7] the contract has no executable surface ─────────────────────────── */
console.log('\n[7] no executable surface');

check('every field the client reads is data, never a command', () => {
  const fields = Object.keys(goodManifest());
  assert.deepStrictEqual(fields, ['schema', 'schemaVersion', 'channel', 'version', 'installer', 'releasedAt', 'notes'],
    'adding a field here means re-reviewing the execution surface (U3)');
  const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-manifest.js'), 'utf8');
  for (const forbidden of ['child_process', 'execSync', 'spawn', 'shell:']) {
    assert.ok(src.indexOf(forbidden) < 0, 'the contract module must never execute anything: ' + forbidden);
  }
});

check('the module stays dependency-free (ships inside the payload)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'runtime', 'update-manifest.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]);
  for (const r of requires) {
    assert.ok(r === './product-version.js' || r === 'fs' || r === 'path', 'unexpected dependency: ' + r);
  }
});

/* ── [8] transport routes (U-D1 Revised) ────────────────────────────────── */
console.log('\n[8] transport routes (U-D1 Revised)');

check('the revision did NOT move the frozen stable manifest URL', () => {
  /* The whole point of U-D1 Revised is that the canonical address and the
     publish order are untouched; only an extra transport route was added. */
  assert.strictEqual(um.MANIFEST_URL,
    'https://github.com/yydye/InternalBeyond/releases/latest/download/update-stable.json');
  assert.strictEqual(um.MANIFEST_ASSET, 'update-stable.json');
  assert.deepStrictEqual(um.ALLOWED_HOSTS, ['github.com'],
    'the manifest-declared host allowlist must not be widened by the transport revision');
});

check('the API route is the frozen endpoint, anonymously readable', () => {
  assert.strictEqual(um.API_BASE, 'https://api.github.com');
  assert.strictEqual(um.API_LATEST_RELEASE,
    'https://api.github.com/repos/yydye/InternalBeyond/releases/latest');
  assert.strictEqual(um.API_VERSION_HEADER, '2022-11-28');
  assert.ok(um.API_LATEST_RELEASE.indexOf('?') < 0, 'no query string: the endpoint is exactly this');
});

check('the transport allowlist is exactly the four documented hosts', () => {
  assert.deepStrictEqual(um.TRANSPORT_HOSTS.slice().sort(),
    ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  for (const h of um.TRANSPORT_HOSTS) {
    assert.ok(/^[a-z0-9.-]+$/.test(h), 'host must be a bare hostname: ' + h);
  }
});

check('assetApiUrl() is the only asset-routing constructor', () => {
  assert.strictEqual(um.assetApiUrl(12345),
    'https://api.github.com/repos/yydye/InternalBeyond/releases/assets/12345');
  for (const bad of [0, -1, 1.5, 'abc', null, undefined, '', NaN, {}]) {
    assert.strictEqual(um.assetApiUrl(bad), null, 'must refuse ' + JSON.stringify(bad));
  }
});

check('selectManifestAsset() refuses anything not provably the stable manifest', () => {
  const at = (over) => Object.assign({ draft: false, prerelease: false, tag_name: 'v1.0.1', assets: [{ name: 'update-stable.json', id: 9 }] }, over);
  assert.strictEqual(um.selectManifestAsset(at({})).ok, true);
  assert.strictEqual(um.selectManifestAsset(at({})).version, '1.0.1');
  const rejects = [
    ['draft', at({ draft: true })], ['draft missing', at({ draft: undefined })],
    ['prerelease', at({ prerelease: true })], ['prerelease missing', at({ prerelease: undefined })],
    ['bad tag', at({ tag_name: '1.0.1' })], ['non-semver tag', at({ tag_name: 'v1.0' })],
    ['no assets array', at({ assets: undefined })], ['empty assets', at({ assets: [] })],
    ['wrong asset name', at({ assets: [{ name: 'SHA256SUMS.txt', id: 1 }] })],
    ['case-different name', at({ assets: [{ name: 'Update-Stable.json', id: 1 }] })],
    ['duplicate asset', at({ assets: [{ name: 'update-stable.json', id: 1 }, { name: 'update-stable.json', id: 2 }] })],
    ['asset without id', at({ assets: [{ name: 'update-stable.json' }] })],
    ['not an object', null], ['a string', 'v1.0.1']
  ];
  for (const [label, release] of rejects) {
    const r = um.selectManifestAsset(release);
    assert.strictEqual(r.ok, false, 'must refuse ' + label);
    assert.ok(r.why, 'a refusal must say why: ' + label);
  }
});

/* ── U3: the installer payload asset (U-D6) ─────────────────────────────── */

check('installerAssetName() is the only place the payload name is spelled out', () => {
  assert.strictEqual(um.installerAssetName('1.2.3'), 'InternalBeyond-Setup-1.2.3.exe');
  assert.strictEqual(um.ASSET_PREFIX, 'InternalBeyond-Setup-');
  assert.strictEqual(um.ASSET_SUFFIX, '.exe');
  assert.strictEqual(um.installerUrl('1.2.3'),
    'https://github.com/yydye/InternalBeyond/releases/download/v1.2.3/InternalBeyond-Setup-1.2.3.exe');
});

check('selectInstallerAsset() accepts only the version-pinned payload asset', () => {
  const payloadSha = 'b'.repeat(64);
  const at = (over) => Object.assign({
    draft: false, prerelease: false, tag_name: 'v1.2.3',
    assets: [{ name: 'InternalBeyond-Setup-1.2.3.exe', id: 55, size: 50787010 }]
  }, over);
  const good = um.selectInstallerAsset(at({}), '1.2.3', payloadSha);
  assert.strictEqual(good.ok, true, good.why);
  assert.strictEqual(good.assetId, 55);
  assert.strictEqual(good.tag, 'v1.2.3');
  assert.strictEqual(good.version, '1.2.3');
  assert.strictEqual(good.name, 'InternalBeyond-Setup-1.2.3.exe');
  assert.strictEqual(good.digestDeclared, false, 'an absent digest is not a failure');

  const rejects = [
    ['a draft', at({ draft: true })], ['draft not proven false', at({ draft: undefined })],
    ['a prerelease', at({ prerelease: true })], ['prerelease not proven false', at({ prerelease: undefined })],
    ['a tag for another version', at({ tag_name: 'v1.2.4' })],
    ['a tag without the prefix', at({ tag_name: '1.2.3' })],
    ['a mismatching asset name', at({ assets: [{ name: 'InternalBeyond-Setup-1.2.4.exe', id: 1 }] })],
    ['the manifest asset instead of the payload', at({ assets: [{ name: 'update-stable.json', id: 1 }] })],
    ['a duplicated asset', at({ assets: [{ name: 'InternalBeyond-Setup-1.2.3.exe', id: 1 }, { name: 'InternalBeyond-Setup-1.2.3.exe', id: 2 }] })],
    ['an asset without an id', at({ assets: [{ name: 'InternalBeyond-Setup-1.2.3.exe' }] })],
    ['no assets array', at({ assets: undefined })],
    ['not an object', null], ['a string', 'v1.2.3']
  ];
  for (const [label, release] of rejects) {
    const r = um.selectInstallerAsset(release, '1.2.3', payloadSha);
    assert.strictEqual(r.ok, false, 'must refuse ' + label);
    assert.ok(r.why, 'a refusal must say why: ' + label);
  }
  /* The version must be a real version, and the hash must be a real hash: this
     function is the last thing between a release payload and a download. */
  assert.strictEqual(um.selectInstallerAsset(at({}), 'not-a-version', payloadSha).ok, false);
  assert.strictEqual(um.selectInstallerAsset(at({}), '1.2.3', 'nope').ok, false);
  assert.strictEqual(um.selectInstallerAsset(at({}), '1.2.3', '').ok, false);
});

check('selectInstallerAsset() enforces the API digest when it is declared (U-D6 item 6)', () => {
  const sha = 'c'.repeat(64);
  const withDigest = (digest) => ({
    draft: false, prerelease: false, tag_name: 'v1.2.3',
    assets: [{ name: 'InternalBeyond-Setup-1.2.3.exe', id: 7, digest: digest }]
  });
  assert.strictEqual(um.selectInstallerAsset(withDigest('sha256:' + sha), '1.2.3', sha).ok, true);
  assert.strictEqual(um.selectInstallerAsset(withDigest('sha256:' + sha.toUpperCase()), '1.2.3', sha).ok, true,
    'digests are case-insensitive hex');
  assert.strictEqual(um.selectInstallerAsset(withDigest(undefined), '1.2.3', sha).ok, true);
  assert.strictEqual(um.selectInstallerAsset(withDigest(null), '1.2.3', sha).ok, true);
  assert.strictEqual(um.selectInstallerAsset(withDigest(''), '1.2.3', sha).ok, true);
  assert.strictEqual(um.selectInstallerAsset(withDigest('sha256:' + 'd'.repeat(64)), '1.2.3', sha).ok, false,
    'a digest that disagrees with the manifest is a hard failure');
  assert.strictEqual(um.selectInstallerAsset(withDigest('sha256:deadbeef'), '1.2.3', sha).ok, false,
    'an uninterpretable digest must not read as "no claim"');
  assert.strictEqual(um.selectInstallerAsset(withDigest('md5:' + sha), '1.2.3', sha).ok, false,
    'only sha256 is the frozen algorithm');
});

/* ── cleanup ────────────────────────────────────────────────────────────── */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); }
process.exitCode = fail ? 1 : 0;
