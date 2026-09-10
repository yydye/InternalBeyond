'use strict';

/* U5-2A · Welcome canvas payload closure.
 *
 * Frozen root cause (U5-2A Phase 0, read-only audit — there is NO path bug):
 *   · the welcome glass pane backdrop is loaded by document-relative probes in
 *     glass-canvas.js / glass-ripple.js, in this frozen order:
 *         assets/images/bg-canvas.png  →  assets/images/bg-canvas.jpg
 *   · the repo layout refactor (e612197) re-anchored every reference correctly,
 *     and the 6,268,353 B PNG has ALWAYS been kept out of the installer payload
 *     (release-manifest `exclude` + DENY_PATH rule) — by design.
 *   · but bg-canvas.jpg did not exist, so after install BOTH probes 404 and the
 *     welcome pane degraded to empty frosted glass.
 *   → payload contract gap, not a refactor regression.
 *
 * This test locks the closure in the places that must stay true together:
 *   [1] repo assets      PNG (source) still present; compressed JPG exists with
 *                        the same pixel dimensions (no crop, no resize) and is
 *                        materially smaller; PNG is not deleted
 *   [2] probe order      frozen png → jpg, identical in both scripts
 *   [3] static server    the REAL server answers 200 for both probes from the
 *                        repo root, byte-identical to the files on disk
 *   [4] installed fixture  PNG absent (as in every installed build) → the JPG
 *                        fallback URL is servable and returns 200
 *   [5] staging contract the REAL payload materialisation ships the JPG and
 *                        still ships NO PNG; the manifest needed no new rule
 *
 * Zero deps: no browser, no network, no install, no build. One real static
 * server on an ephemeral loopback port plus one real staging materialisation
 * into a temp directory; both reclaimed in `finally`.
 *
 * Out of scope here — recorded as U5-2B candidate, deliberately NOT fixed:
 *   installer/InternalBeyond.iss has no [InstallDelete], so a 1.0.0 → later
 *   same-directory upgrade can leave pre-refactor root-level files behind.
 *   The visual payload fix and the legacy cleanup stay in separate commits.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = require(path.join(ROOT, 'services', 'internal-beyond-server.js'));
const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));

const PNG_PATH = path.join(ROOT, 'assets', 'images', 'bg-canvas.png');
const JPG_PATH = path.join(ROOT, 'assets', 'images', 'bg-canvas.jpg');
const PROBE_PNG = 'assets/images/bg-canvas.png';
const PROBE_JPG = 'assets/images/bg-canvas.jpg';
/* Native dimensions of the tracked source PNG; the JPG must match exactly so the
   pane geometry (--gw-ar is calibrated from the decoded image) cannot shift. */
const NATIVE = { width: 2600, height: 1351 };
/* Payload intent: the JPG is the shipped copy, so it must stay far below the
   6.27 MB PNG and inside a sane ceiling. */
const MAX_JPG_BYTES = 2 * 1024 * 1024;
const MIN_SHRINK = 5;

let pass = 0, fail = 0;
const failures = [];
const detail = e => (e && e.message) || String(e);
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + detail(e)); console.log('  ✗ ' + name + ' — ' + detail(e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + detail(e)); console.log('  ✗ ' + name + ' — ' + detail(e)); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/* PNG header: 8-byte signature, then the IHDR chunk (length/type/data). */
function pngHeader(buf) {
  assert.strictEqual(buf.readUInt32BE(0), 0x89504e47, 'not a PNG (signature)');
  assert.strictEqual(buf.readUInt32BE(4), 0x0d0a1a0a, 'not a PNG (signature)');
  assert.strictEqual(buf.toString('ascii', 12, 16), 'IHDR', 'IHDR must be the first chunk');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

/* JPEG frame header: walk markers until a SOFn segment carries the dimensions. */
function jpegFrame(buf) {
  assert.strictEqual(buf[0], 0xff, 'not a JPEG (no SOI)');
  assert.strictEqual(buf[1], 0xd8, 'not a JPEG (no SOI)');
  let i = 2;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    let marker = buf[i + 1];
    while (marker === 0xff) { i++; marker = buf[i + 1]; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xda) break; /* start of scan → no frame header seen */
    const length = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: buf.readUInt16BE(i + 5),
        width: buf.readUInt16BE(i + 7),
        progressive: marker === 0xc2
      };
    }
    i += 2 + length;
  }
  throw new Error('no SOF frame header found');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function closeServer(server) {
  return new Promise(resolve => { try { server.close(() => resolve()); } catch (e) { resolve(); } });
}
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: String(res.headers['content-type'] || ''),
        body: Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* The probe order frozen in the two welcome-canvas scripts. */
function probeList(relPath) {
  const text = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const match = text.match(/\}\)\(\[([^\]]*)\]\);/);
  assert.ok(match, relPath + ': probe list not found');
  return (match[1].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
}

async function main() {
  const pngBuf = fs.existsSync(PNG_PATH) ? fs.readFileSync(PNG_PATH) : null;

  section('[1] repo assets — source PNG kept, compressed JPG added');
  check('assets.pngPresent', () => {
    assert.ok(pngBuf, PROBE_PNG + ' must stay in the repo (it is the source for the JPG)');
  });
  check('assets.pngIsRgbaOfNativeSize', () => {
    const h = pngHeader(pngBuf);
    assert.strictEqual(h.colorType, 6, 'expected truecolour+alpha (RGBA), got color type ' + h.colorType);
    assert.strictEqual(h.bitDepth, 8, 'expected 8-bit channels');
    assert.strictEqual(h.width, NATIVE.width);
    assert.strictEqual(h.height, NATIVE.height);
    console.log('      png %s B  %dx%d RGBA  sha256=%s', pngBuf.length, h.width, h.height, sha256(pngBuf));
  });
  check('assets.jpgPresent', () => {
    assert.ok(fs.existsSync(JPG_PATH), PROBE_JPG + ' must exist so the installed build has a fallback');
  });
  const jpgBuf = fs.existsSync(JPG_PATH) ? fs.readFileSync(JPG_PATH) : Buffer.alloc(0);
  check('assets.jpgIsJpegOfSameNativeSize', () => {
    const f = jpegFrame(jpgBuf);
    assert.strictEqual(f.width, NATIVE.width, 'JPG must not be resized');
    assert.strictEqual(f.height, NATIVE.height, 'JPG must not be cropped');
    console.log('      jpg %s B  %dx%d%s  sha256=%s', jpgBuf.length, f.width, f.height,
      f.progressive ? ' progressive' : '', sha256(jpgBuf));
  });
  check('assets.jpgIsMateriallySmaller', () => {
    assert.ok(jpgBuf.length < pngBuf.length, 'JPG must be smaller than the PNG');
    assert.ok(pngBuf.length / jpgBuf.length >= MIN_SHRINK,
      'payload intent: JPG must be at least ' + MIN_SHRINK + 'x smaller, got ' +
      (pngBuf.length / jpgBuf.length).toFixed(2) + 'x');
    assert.ok(jpgBuf.length <= MAX_JPG_BYTES,
      'JPG must stay under ' + MAX_JPG_BYTES + ' B, got ' + jpgBuf.length);
  });

  section('[2] probe order — frozen png → jpg in both scripts');
  for (const rel of ['assets/js/glass-canvas.js', 'assets/js/glass-ripple.js']) {
    check('probe.orderFrozen.' + path.basename(rel), () => {
      assert.deepStrictEqual(probeList(rel), [PROBE_PNG, PROBE_JPG],
        rel + ': the png → jpg order is part of the release contract (U5-2A) and must not be reordered');
    });
  }

  section('[3] real static server on the repo root');
  const repoServers = [];
  const repoServer = WEB.createWebServer({ root: ROOT, host: '127.0.0.1' });
  repoServers.push(repoServer);
  const repoPort = await listen(repoServer);
  await checkAsync('staticServer.pngServedFromRepo', async () => {
    const res = await get(repoPort, '/' + PROBE_PNG);
    assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
    assert.ok(/^image\/png/.test(res.type), 'expected image/png, got ' + res.type);
    assert.strictEqual(sha256(res.body), sha256(pngBuf), 'served bytes must be the tracked PNG');
  });
  await checkAsync('staticServer.jpgServedFromRepo', async () => {
    const res = await get(repoPort, '/' + PROBE_JPG);
    assert.strictEqual(res.status, 200, 'expected 200, got ' + res.status);
    assert.ok(/^image\/jpeg/.test(res.type), 'expected image/jpeg, got ' + res.type);
    assert.strictEqual(sha256(res.body), sha256(jpgBuf), 'served bytes must be the shipped JPG');
  });

  section('[4] installed-like fixture — PNG absent, JPG fallback servable');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-welcome-canvas-'));
  let fixtureServer = null;
  try {
    /* A served root that mirrors the payload: the PNG is deliberately missing
       (excluded from every installed build), the JPG is present. */
    const fixtureRoot = path.join(tmp, 'installed');
    fs.mkdirSync(path.join(fixtureRoot, 'assets', 'images'), { recursive: true });
    fs.copyFileSync(JPG_PATH, path.join(fixtureRoot, 'assets', 'images', 'bg-canvas.jpg'));

    check('fixture.resolveRequestRejectsMissingPng', () => {
      assert.strictEqual(WEB.resolveRequest(fixtureRoot, '/' + PROBE_PNG), null,
        'the server must not resolve a png that is not in the payload');
    });
    fixtureServer = WEB.createWebServer({ root: fixtureRoot, host: '127.0.0.1' });
    const fixturePort = await listen(fixtureServer);
    await checkAsync('fixture.pngAbsentReturns404', async () => {
      const res = await get(fixturePort, '/' + PROBE_PNG);
      assert.strictEqual(res.status, 404, 'first probe must miss in an installed build, got ' + res.status);
    });
    await checkAsync('fixture.jpgFallbackReturns200', async () => {
      const res = await get(fixturePort, '/' + PROBE_JPG);
      assert.strictEqual(res.status, 200, 'the jpg fallback must resolve, got ' + res.status);
      assert.ok(/^image\/jpeg/.test(res.type), 'expected image/jpeg, got ' + res.type);
      assert.strictEqual(sha256(res.body), sha256(jpgBuf), 'fallback bytes must be the shipped JPG');
    });

    section('[5] installer staging contract (real materialisation)');
    const stageDir = path.join(tmp, 'staging');
    const staged = manifest.stage(stageDir, { clean: true });
    check('staging.succeeded', () => {
      assert.strictEqual(staged.ok, true, 'staging failed: ' + JSON.stringify(staged));
      assert.strictEqual(staged.missing.length, 0, 'staging reported missing entries: ' + JSON.stringify(staged.missing));
      assert.strictEqual(staged.denied.filter(p => /bg-canvas\.jpg$/i.test(String(p))).length, 0,
        'the JPG must never be denied by a deny rule: ' + JSON.stringify(staged.denied));
    });
    check('staging.jpgShippedAtRepoPath', () => {
      const stagedJpg = path.join(stageDir, ...PROBE_JPG.split('/'));
      assert.ok(fs.existsSync(stagedJpg), PROBE_JPG + ' must be in the payload');
      assert.strictEqual(sha256(fs.readFileSync(stagedJpg)), sha256(jpgBuf),
        'staged bytes must be byte-identical to the repo JPG');
      assert.ok(staged.files.indexOf(PROBE_JPG) >= 0, 'payload file list must carry ' + PROBE_JPG);
    });
    check('staging.pngStaysAbsent', () => {
      assert.ok(!fs.existsSync(path.join(stageDir, ...PROBE_PNG.split('/'))),
        PROBE_PNG + ' must NOT be in the payload (6 MB source stays out)');
      assert.strictEqual(staged.files.filter(f => f.toLowerCase().endsWith('bg-canvas.png')).length, 0,
        'payload file list must not carry any bg-canvas.png');
    });
    check('staging.denyRulesUnchanged', () => {
      assert.ok(manifest.DENY_PATH.some(rule => rule.test.test(PROBE_PNG)),
        'the deny rule must keep rejecting the PNG');
      assert.ok(!manifest.DENY_PATH.some(rule => rule.test.test(PROBE_JPG)),
        'the deny rules must allow the JPG');
    });
    check('staging.noRedundantManifestRule', () => {
      /* The JPG ships purely through the existing `{ from: 'assets', dir: true }`
         whitelist. Making it explicit would be redundant — guard against it. */
      const mentioning = manifest.ENTRIES.filter(e =>
        JSON.stringify([e.from, e.to, e.exclude]).indexOf('bg-canvas') >= 0);
      const jpgRules = manifest.ENTRIES.filter(e =>
        JSON.stringify([e.from, e.to, e.exclude]).indexOf('bg-canvas.jpg') >= 0);
      assert.strictEqual(jpgRules.length, 0,
        'the JPG must ride the assets whitelist, not a new explicit entry');
      assert.strictEqual(mentioning.length, 1, 'expected exactly the pre-existing assets exclude to mention bg-canvas');
      assert.deepStrictEqual(mentioning[0].exclude, ['images/bg-canvas.png'],
        'the frozen assets entry must keep excluding only the PNG');
      assert.strictEqual(mentioning[0].dir, true, 'the assets entry must stay a directory whitelist');
    });
  } finally {
    for (const server of repoServers.concat(fixtureServer ? [fixtureServer] : [])) await closeServer(server);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures.length
    ? '\nWelcome canvas payload closure failed: ' + fail + '\n  ' + failures.join('\n  ')
    : '\nWelcome canvas payload closure passed ✔ (' + pass + ' checks)');
  process.exit(fail ? 1 : 0);
}

main().catch(error => {
  console.error('Welcome canvas payload closure crashed:', (error && error.stack) || error);
  process.exit(1);
});
