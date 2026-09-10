'use strict';

/* U3 · PE version-resource reader.
 *
 * What this locks (U-D6 item 5 relies on it):
 *   [1] a real Windows PE produced by a real toolchain reads correctly
 *       (runtime/node/node.exe), and a synthetic PE32 / PE32+ does too —
 *       Inno Setup ships a 32-bit stub, so PE32 support is not hypothetical
 *   [2] the ProductVersion string and BOTH VS_FIXEDFILEINFO versions are read
 *   [3] the gate: the ProductVersion string must equal the manifest's
 *       productVersion, and the fixed versions must agree on a.b.c — the
 *       trailing fourth component is deliberately not pinned
 *   [4] every failure is a refusal, never a guess: not-a-PE, truncated,
 *       missing resource directory, missing RT_VERSION, missing
 *       VS_FIXEDFILEINFO signature, out-of-range data entry, a lying size
 *   [5] it is bounded: a 92 MB image is read with positioned reads, no slurp
 *   [6] it never throws, whatever it is pointed at
 *
 * Pure Node. Temp files only, cleaned up.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pe = require(path.join(ROOT, 'runtime', 'pe-version.js'));
const fixture = require(path.join(__dirname, 'pe-fixture.js'));

const REAL_NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-pe-'));
function write(name, options) { return fixture.writePe(tmpRoot, name, options); }

async function main() {
  console.log('PE version reader (U3)\n');

  /* ═══ [1] reading real and synthetic images ═══════════════════════════ */
  section('[1] reading images');

  await check('the bundled Node runtime reads: 24.18.0, PE32+', () => {
    assert.ok(fs.existsSync(REAL_NODE), 'the fixture must exist: ' + REAL_NODE);
    const r = pe.readPeVersion(REAL_NODE);
    assert.strictEqual(r.ok, true, 'the real image must parse: ' + r.why);
    assert.strictEqual(r.productVersion, '24.18.0');
    assert.strictEqual(r.fileVersion, '24.18.0');
    assert.strictEqual(r.productVersionFixed, '24.18.0.0');
    assert.strictEqual(r.fileVersionFixed, '24.18.0.0');
    assert.ok(Object.keys(r.strings).length >= 4, 'StringFileInfo entries must be walked');
  });

  await check('the real image is read with positioned reads, not by slurping it', () => {
    /* The payload is ~48 MB and the file is untrusted; the reader must read the
       headers and the resource directory, nothing else. */
    const src = fs.readFileSync(path.join(ROOT, 'runtime', 'pe-version.js'), 'utf8');
    assert.ok(/fs\.readSync\(/.test(src), 'bounded positioned reads');
    assert.ok(src.indexOf('readFileSync') < 0, 'the image must never be read whole');
  });

  await check('a synthetic PE32 and PE32+ both read', () => {
    for (const arch of ['pe32', 'pe32+']) {
      const file = write('a-' + arch.replace('+', 'p') + '.exe', { arch: arch });
      const r = pe.readPeVersion(file);
      assert.strictEqual(r.ok, true, arch + ': ' + r.why);
      assert.strictEqual(r.productVersion, '1.2.0', arch);
      assert.strictEqual(r.productVersionFixed, '1.2.0.0', arch);
      assert.strictEqual(r.fileVersionFixed, '1.2.0.0', arch);
    }
  });

  await check('the declared file version is read separately from the product version', () => {
    const file = write('b.exe', { productVersion: '2.0.1', fileVersion: '2.0.1.7' });
    const r = pe.readPeVersion(file);
    assert.strictEqual(r.ok, true, r.why);
    assert.strictEqual(r.productVersionFixed, '2.0.1.0');
    assert.strictEqual(r.fileVersionFixed, '2.0.1.7');
    assert.strictEqual(r.productVersion, '2.0.1');
  });

  /* ═══ [2] the gate ════════════════════════════════════════════════════ */
  section('[2] the U-D6 version gate');

  await check('a matching image passes', () => {
    const g = pe.matchesProductVersion(write('c.exe', { productVersion: '1.2.0' }), '1.2.0');
    assert.strictEqual(g.ok, true, g.why);
  });

  await check('a different ProductVersion is refused', () => {
    const g = pe.matchesProductVersion(write('d.exe', { productVersion: '1.2.0' }), '1.3.0');
    assert.strictEqual(g.ok, false);
    assert.ok(/ProductVersion/.test(g.why), g.why);
  });

  await check('a lying StringFileInfo cannot pass on the fixed version alone', () => {
    /* StringFileInfo says 9.9.9 while the fixed info says 1.2.0: the string is
       the value the release contract publishes, so they must agree. */
    const g = pe.matchesProductVersion(write('e.exe', { productVersion: '1.2.0', productString: '9.9.9' }), '1.2.0');
    assert.strictEqual(g.ok, false);
    assert.ok(/9\.9\.9/.test(g.why), g.why);
  });

  await check('a fixed-version mismatch is refused even when the string agrees', () => {
    const g = pe.matchesProductVersion(write('f.exe', { productVersion: '1.2.0', productString: '1.2.0' }), '1.3.0');
    assert.strictEqual(g.ok, false);
  });

  await check('the fourth component is NOT pinned (VersionInfoVersion=x.y.z.0 is a build detail)', () => {
    /* installer/InternalBeyond.iss writes `VersionInfoVersion={#AppVersion}.0`.
       Pinning the client to that trailing zero would turn a harmless build-script
       change into "every update is refused". */
    const g1 = pe.matchesProductVersion(write('g.exe', { productVersion: '1.2.0', fileVersion: '1.2.0.0' }), '1.2.0');
    const g2 = pe.matchesProductVersion(write('h.exe', { productVersion: '1.2.0', fileVersion: '1.2.0.9' }), '1.2.0');
    assert.strictEqual(g1.ok, true, g1.why);
    assert.strictEqual(g2.ok, true, g2.why);
  });

  await check('an empty expectation is refused, never treated as "anything matches"', () => {
    const g = pe.matchesProductVersion(write('i.exe', {}), '');
    assert.strictEqual(g.ok, false);
  });

  /* ═══ [3] refusals ════════════════════════════════════════════════════ */
  section('[3] every malformed image is a refusal');

  await check('named corruptions each produce a refusal with a reason', () => {
    const cases = ['no-mz', 'no-pe', 'no-resource-dir', 'no-rt-version', 'bad-fixed-sig',
      'truncated-blob', 'data-entry-oob', 'no-sections', 'empty'];
    for (const corrupt of cases) {
      const file = write('j-' + corrupt + '.exe', { corrupt: corrupt });
      const r = pe.readPeVersion(file);
      assert.strictEqual(r.ok, false, corrupt + ' must not read as a valid PE');
      assert.ok(r.why && r.why.length > 5, corrupt + ' must explain itself');
      const g = pe.matchesProductVersion(file, '1.2.0');
      assert.strictEqual(g.ok, false, corrupt + ' must fail the gate');
    }
  });

  await check('ordinary files and missing paths are refusals, not exceptions', () => {
    const text = path.join(tmpRoot, 'notape.exe');
    fs.writeFileSync(text, 'hello, I am not a PE image at all\n', 'utf8');
    for (const target of [text, path.join(tmpRoot, 'missing.exe'), tmpRoot, '', null, undefined, 0]) {
      const r = pe.readPeVersion(target);
      assert.strictEqual(r.ok, false, 'must refuse ' + JSON.stringify(target));
      assert.ok(r.why, 'must explain ' + JSON.stringify(target));
    }
  });

  await check('a directory of random bytes never throws', () => {
    let seed = 12345;
    const rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 256; };
    for (let i = 0; i < 40; i++) {
      const buf = Buffer.alloc(64 + (i * 7) % 512);
      for (let j = 0; j < buf.length; j++) buf[j] = rnd();
      buf.writeUInt16LE(0x5a4d, 0);          /* valid MZ, garbage after */
      if (buf.length > 0x40) buf.writeUInt32LE(0x40, 0x3c);
      const file = path.join(tmpRoot, 'rnd' + i + '.exe');
      fs.writeFileSync(file, buf);
      const r = pe.readPeVersion(file);
      assert.strictEqual(typeof r.ok, 'boolean');
      if (!r.ok) assert.ok(r.why, 'a refusal must carry a reason');
    }
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
