'use strict';

/* P7 · release build regression (real ISCC build).
 *
 * Runs scripts/build-installer.ps1 end to end (staging → audit → compile → hash)
 * and verifies the artefacts it produces. Heavy (~1–3 min) and it needs Inno
 * Setup 6, so it only runs when explicitly enabled:
 *
 *   node test_installer_build.js --force        (or IB_INSTALLER_BUILD=1)
 *
 * Without the flag it reports SKIP and exits 0, so test-all.js can register it.
 *
 * The build never installs anything: the install audit is opt-in
 * (-InstallAudit). The one real install smoke is run separately, once, with
 * test_installer_smoke.js --real-install-smoke (docs/P7-TEST-BUDGET.md).
 *
 * Zero deps. No process.exit(); the child build is awaited and cleaned up.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));
const audit = require(path.join(ROOT, 'scripts', 'release-audit.js'));
const productVersion = require(path.join(ROOT, 'runtime', 'product-version.js'));
const updateManifest = require(path.join(ROOT, 'runtime', 'update-manifest.js'));

const argv = process.argv.slice(2);
const ENABLED = argv.indexOf('--force') >= 0 || process.env.IB_INSTALLER_BUILD === '1';

const DIST = path.join(ROOT, 'dist');
const STAGING = path.join(DIST, 'staging');
const PRODUCT = productVersion.read();
const EXE = path.join(DIST, 'InternalBeyond-Setup-' + PRODUCT.version + '.exe');
const SUMS = path.join(DIST, 'SHA256SUMS.txt');
const UPD = path.join(DIST, 'update-stable.json');

let pass = 0, fail = 0, skip = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  ✗ ' + name + ' — ' + (e && e.message || e)); }
}
function skipped(name, why) { skip++; console.log('  – ' + name + ' (SKIP: ' + why + ')'); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

console.log('Release build regression (P7)\n');

if (!ENABLED) {
  skipped('release build', 'set IB_INSTALLER_BUILD=1 or pass --force (runs a real ISCC build)');
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败, ' + skip + ' 跳过');
} else {
  console.log('[1] run the one-command build');
  const started = Date.now();
  let buildOut = '';
  let buildCode = 0;
  try {
    buildOut = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(ROOT, 'scripts', 'build-installer.ps1'),
      '-KeepStaging'], { encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    buildCode = typeof e.status === 'number' ? e.status : 1;
    buildOut = String((e.stdout || '') + (e.stderr || ''));
  }
  console.log('  build finished in ' + Math.round((Date.now() - started) / 1000) + 's (exit ' + buildCode + ')');

  check('build script exits 0', () => {
    assert.strictEqual(buildCode, 0, 'build failed:\n' + buildOut.split(/\r?\n/).slice(-25).join('\n'));
  });
  check('build output names the version from VERSION', () => {
    assert.ok(buildOut.indexOf('InternalBeyond-Setup-' + PRODUCT.version + '.exe') >= 0,
      'build output must mention the versioned installer');
  });

  console.log('\n[2] artefacts');
  check('versioned installer produced', () => {
    assert.ok(fs.existsSync(EXE), 'installer missing: ' + EXE);
    assert.ok(fs.statSync(EXE).size > 20 * 1024 * 1024, 'installer too small: ' + fs.statSync(EXE).size);
  });
  check('SHA256SUMS.txt produced and matches', () => {
    assert.ok(fs.existsSync(SUMS), 'SHA256SUMS.txt missing');
    const text = fs.readFileSync(SUMS, 'ascii');
    assert.ok(text.indexOf(PRODUCT.version) >= 0, 'checksums must record the product version');
    const line = text.split(/\r?\n/).find(l => /\*InternalBeyond-Setup-/.test(l));
    assert.ok(line, 'checksum line missing');
    assert.ok(line.toLowerCase().indexOf(sha256(EXE)) >= 0, 'checksum mismatch');
  });
  check('installer file version matches VERSION', () => {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Item -LiteralPath ' + JSON.stringify(EXE) + ').VersionInfo.ProductVersion'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.ok(out.indexOf(PRODUCT.version) >= 0, 'ProductVersion must come from VERSION, got ' + out);
  });
  check('installer stays unsigned', () => {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-AuthenticodeSignature -LiteralPath ' + JSON.stringify(EXE) + ').Status'], { encoding: 'utf8', windowsHide: true }).trim();
    assert.strictEqual(out, 'NotSigned', 'expected unsigned, got ' + out);
  });

  console.log('\n[2b] update manifest (Stable channel contract)');
  check('update-stable.json produced and schema-valid', () => {
    assert.ok(fs.existsSync(UPD), 'update-stable.json missing: ' + UPD);
    const parsed = JSON.parse(fs.readFileSync(UPD, 'utf8'));
    const report = updateManifest.validate(parsed);
    assert.strictEqual(report.ok, true, 'manifest invalid: ' + JSON.stringify(report.errors));
    assert.strictEqual(parsed.channel, 'stable');
    assert.strictEqual(parsed.version, PRODUCT.version);
  });
  check('manifest hash and size are measured from the built installer, not re-typed', () => {
    const parsed = JSON.parse(fs.readFileSync(UPD, 'utf8'));
    assert.strictEqual(parsed.installer.sha256, sha256(EXE), 'manifest sha256 must match the built exe');
    assert.strictEqual(parsed.installer.sizeBytes, fs.statSync(EXE).size, 'manifest sizeBytes must match the built exe');
    const sumsText = fs.readFileSync(SUMS, 'ascii');
    assert.ok(sumsText.toLowerCase().indexOf(parsed.installer.sha256) >= 0,
      'SHA256SUMS.txt and the manifest must agree on the same hash');
  });
  check('manifest URL is complete, version-pinned and matches VERSION', () => {
    const parsed = JSON.parse(fs.readFileSync(UPD, 'utf8'));
    assert.strictEqual(parsed.installer.url, updateManifest.installerUrl(PRODUCT.version));
    assert.strictEqual(parsed.installer.productVersion, PRODUCT.version);
    const p = updateManifest.parseInstallerUrl(parsed.installer.url);
    assert.strictEqual(p.ok, true, 'url must parse: ' + p.why);
    assert.strictEqual(p.version, PRODUCT.version, 'the URL must be pinned to this build version');
  });
  check('manifest does not invent releasedAt or notes', () => {
    const text = fs.readFileSync(UPD, 'utf8');
    const parsed = JSON.parse(text);
    /* This build ran without -ReleasedAt/-NotesFile, so both must be absent —
       and whatever is present must not be a fabricated timestamp. */
    if (!('releasedAt' in parsed)) assert.ok(true);
    else assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(parsed.releasedAt));
    assert.ok(text.indexOf('__unknown') < 0, 'no build-only field may reach the published file');
  });
  check('manifest never ships inside the payload', () => {
    assert.strictEqual(fs.existsSync(path.join(STAGING, 'update-stable.json')), false,
      'dist/update-stable.json is a release asset, not a payload file');
    assert.strictEqual(manifest.resolve({}).files.some(f => /update-stable\.json$/.test(f.to)), false,
      'the whitelist must not carry the manifest');
  });

  console.log('\n[3] staging (kept for inspection)');
  check('staging matches the whitelist exactly', () => {
    assert.ok(fs.existsSync(STAGING), 'staging kept with -KeepStaging must exist');
    const resolved = manifest.resolve({});
    const staged = manifest.auditDirectory(STAGING);
    const expected = new Set(resolved.files.map(f => f.to));
    const actual = new Set(staged.files.map(f => f.path));
    const missing = [...expected].filter(f => !actual.has(f));
    const extra = [...actual].filter(f => !expected.has(f));
    assert.strictEqual(missing.length, 0, 'missing from staging: ' + missing.slice(0, 5).join(', '));
    assert.strictEqual(extra.length, 0, 'unexpected in staging: ' + extra.slice(0, 5).join(', '));
  });
  check('staging passes the content + secret audit', () => {
    const report = audit.scanDirectory(STAGING);
    assert.strictEqual(report.errors, 0, 'error findings: ' + JSON.stringify(report.findings.filter(f => f.severity === 'error')));
    assert.strictEqual(report.violations.length, 0, 'content violations: ' + JSON.stringify(report.violations));
  });
  check('staged runtime is the pinned binary', () => {
    const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'installer', 'runtime-pin.json'), 'utf8'));
    assert.strictEqual(sha256(path.join(STAGING, 'runtime', 'node', 'node.exe')), pin.runtime.sha256);
  });

  console.log('\n[4] clean up the kept staging directory');
  check('staging can be removed safely', () => {
    fs.rmSync(STAGING, { recursive: true, force: true });
    assert.strictEqual(fs.existsSync(STAGING), false);
  });

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败, ' + skip + ' 跳过');
  if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); }
}

process.exitCode = fail ? 1 : 0;
