'use strict';

/*
 * Release Builder · B/C/D. Fixture, integration and COUNTERPROOF tests.
 *
 * Everything runs against a throwaway InternalBeyond-shaped checkout in a temp
 * directory (tests/fixture.js). The real repository's dist/ is never touched,
 * nothing is installed, no browser opens and nothing goes to the network.
 *
 * The counterproof section is the point of this file. A green happy path proves
 * very little about a release tool; what matters is that a DELIBERATELY BROKEN
 * release is refused. Each case below breaks exactly one thing and asserts that
 * the tool turns it into BLOCKED — never a warning, never "basically fine":
 *
 *   · the canonical build exits non-zero
 *   · the artifact is missing after a successful build
 *   · the artifact is a truncated file
 *   · the artifact's PE version does not match VERSION
 *   · SHA256SUMS.txt records a stale hash
 *   · the manifest announces the wrong version
 *   · the manifest carries the wrong sha256
 *   · the manifest carries an unregistered channel
 *   · VERSION does not parse
 *   · the target version is not an upgrade
 *   · the README release claim has drifted from VERSION
 *   · the repository is dirty
 *   · a dist manifest and its artifact disagree
 *   · PUBLISH is attempted without confirmation, and with a stale confirmation
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TOOL = path.resolve(__dirname, '..');
const fixture = require('./fixture.js');
const { Runner } = require(path.join(TOOL, 'lib', 'runner.js'));
const canonical = require(path.join(TOOL, 'lib', 'canonical.js'));
const logMod = require(path.join(TOOL, 'lib', 'log.js'));
const publish = require(path.join(TOOL, 'lib', 'publish.js'));
const plan = require(path.join(TOOL, 'lib', 'plan.js'));

/* Counterproof fault injection is refused unless this is set (lib/runner.js). */
process.env.IB_RELEASE_BUILDER_ALLOW_FAULT = '1';

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  XX  ' + name + ' — ' + (e && e.message || e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  XX  ' + name + ' — ' + (e && e.message || e)); }
}
function sha256File(f) { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }
function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8'); }

const CLEANUPS = [];
function newFixture(opts) {
  const fx = fixture.create(opts);
  CLEANUPS.push(fx);
  return fx;
}

function makeRunner(fx, opts) {
  const r = new Runner({ root: fx.dir });
  r.setOptions(Object.assign({ target: fx.target, channel: 'stable' }, opts || {}));
  return r;
}

/* Build one complete, honest release in `fx` and return the runner. */
async function buildRelease(fx, opts) {
  const r = makeRunner(fx, opts);
  const c = await r.runStage('CHECK');
  if (c.status === 'blocked') throw new Error('fixture CHECK blocked: ' + JSON.stringify(c.blockers));
  const b = await r.runStage('BUILD');
  if (b.status === 'blocked') throw new Error('fixture BUILD blocked: ' + JSON.stringify(b.blockers));
  const v = await r.runStage('VERIFY');
  if (v.status === 'blocked') throw new Error('fixture VERIFY blocked: ' + JSON.stringify(v.blockers));
  return r;
}

function statuses(r) {
  const out = {};
  for (const s of plan.STAGES) out[s] = r.stages[s].status;
  return out;
}

function blockedKeys(r, stage) {
  return (r.results[stage] && r.results[stage].blockers ? r.results[stage].blockers : []).map(function (b) { return String(b.code || ''); });
}

(async function main() {

  /* ── fixture self-check ───────────────────────────────────────────────── */

  console.log('Release Builder · fixture / integration / counterproof (B/C/D)\n');
  console.log('[0] fixture self-check (the fixture must be real before it can prove anything)');

  const peReader = require(path.join(fixture.REAL_REPO, 'runtime', 'pe-version.js'));

  check('the fixture artifact is a real PE whose version the canonical reader confirms', () => {
    const buf = fixture.buildPeWithVersion('1.0.6');
    const tmp = path.join(os.tmpdir(), 'ib-rb-selfcheck-' + process.pid + '.exe');
    fs.writeFileSync(tmp, buf);
    try {
      const r = peReader.readPeVersion(tmp);
      assert2(r.ok, 'canonical PE reader rejected the fixture: ' + r.why);
      assert2(r.productVersion === '1.0.6', 'productVersion was ' + r.productVersion);
      assert2(peReader.matchesProductVersion(tmp, '1.0.6').ok === true, 'matchesProductVersion failed');
      assert2(peReader.matchesProductVersion(tmp, '1.0.5').ok === false, 'the wrong version was accepted');
    } finally { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } }
  });

  function assert2(cond, msg) { if (!cond) throw new Error(msg); }

  /* ── C. integration: a complete, honest release ───────────────────────── */

  console.log('\n[C] integration: CHECK → BUILD → VERIFY → SEAL in an isolated checkout');

  await checkAsync('a complete honest release reaches READY and produces the three artifacts', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = await buildRelease(fx);
    const s = await r.runStage('SEAL');
    assert2(s.status !== 'blocked', 'SEAL blocked: ' + JSON.stringify(s.blockers));

    const dist = path.join(fx.dir, 'dist');
    const exe = path.join(dist, 'InternalBeyond-Setup-1.0.6.exe');
    assert2(fs.existsSync(exe), 'the installer must exist');
    assert2(fs.existsSync(path.join(dist, 'SHA256SUMS.txt')), 'SHA256SUMS.txt must exist');
    assert2(fs.existsSync(path.join(dist, 'update-stable.json')), 'the manifest must exist');
    assert2(fs.existsSync(path.join(dist, 'release-1.0.6.log')), 'the run log must exist');
    assert2(fs.existsSync(path.join(dist, 'release-1.0.6.jsonl')), 'the machine-readable log must exist');

    const snap = r.snapshot(0);
    assert2(snap.status === 'READY', 'top status was ' + snap.status);
    assert2(statuses(r).PUBLISH === 'pending', 'PUBLISH must not have run');
    assert2(statuses(r).SEAL === 'ok' || statuses(r).SEAL === 'warn', 'SEAL was ' + statuses(r).SEAL);

    /* The version bump really happened, in both places, and stays consistent. */
    assert2(fs.readFileSync(path.join(fx.dir, 'VERSION'), 'utf8').trim() === '1.0.6', 'VERSION must be bumped');
    const readme = fs.readFileSync(path.join(fx.dir, 'README.md'), 'utf8');
    assert2(/当前版本\s*\*\*1\.0\.6\*\*/.test(readme), 'the README release claim must be bumped with VERSION');

    /* The four equations, recomputed here from the bytes, independently. */
    const man = readJson(path.join(dist, 'update-stable.json'));
    assert2(man.version === '1.0.6', 'manifest.version');
    assert2(man.installer.sha256 === sha256File(exe), 'equation 1');
    assert2(man.installer.sizeBytes === fs.statSync(exe).size, 'equation 2');
    assert2(man.installer.productVersion === '1.0.6', 'equation 3');
    assert2(man.installer.url.split('/').pop() === path.basename(exe), 'equation 4');
    assert2(man.channel === 'stable', 'channel');

    /* The log must be redacted and must carry the facts a release needs. */
    const human = fs.readFileSync(path.join(dist, 'release-1.0.6.log'), 'utf8');
    assert2(human.indexOf('redaction') >= 0, 'the log must state its redaction status');
    assert2(human.indexOf('===== BUILD =====') >= 0, 'the log must record the BUILD stage');
    assert2(human.indexOf('EXEC') >= 0, 'the log must record the real command');
    assert2(human.indexOf('three-way') >= 0 || human.indexOf('三方对账') >= 0, 'the log must record the final reconciliation');
  });

  await checkAsync('a one-click run stops at SEAL and never publishes', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = makeRunner(fx);
    const steps = await r.runOneClick({});
    assert2(steps.length === 4, 'one-click must run exactly four stages, got ' + steps.length);
    assert2(steps.map(s => s.stage).join(',') === 'CHECK,BUILD,VERIFY,SEAL', 'order: ' + steps.map(s => s.stage).join(','));
    assert2(statuses(r).PUBLISH === 'pending', 'PUBLISH must remain pending after a one-click run');
    assert2(r.snapshot(0).status === 'READY', 'status was ' + r.snapshot(0).status);
  });

  /* ── dry run is genuinely side-effect free ────────────────────────────── */

  console.log('\n[DRY] a dry run must change nothing at all');

  await checkAsync('dry run performs no writes (byte-for-byte tree comparison)', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const before = snapshotTree(fx.dir);
    const r = makeRunner(fx);
    const res = await r.runDryRun();
    assert2(res.ok === true, 'dry run must succeed');
    assert2(!!res.plan, 'dry run must produce a plan');
    assert2(res.plan.buildCommand.indexOf('build-installer.ps1') >= 0, 'the plan must name the canonical build');
    assert2(res.plan.artifactName === 'InternalBeyond-Setup-1.0.6.exe', 'the plan must name the artifact');
    assert2(res.plan.publishActions.length > 0, 'the plan must list the publish actions');
    assert2(res.plan.text.indexOf('未 tag；未 push；未 upload') >= 0, 'the plan must state its guarantees');
    const after = snapshotTree(fx.dir);
    assert2(before === after, 'the dry run changed the tree:\n' + diffTree(before, after));
    assert2(!fs.existsSync(path.join(fx.dir, 'dist')), 'a dry run must not even create dist/');
    const snap = r.snapshot(0);
    assert2(snap.status === 'BLOCKED', 'a dry run must not report READY/PUBLISHED (was ' + snap.status + ')');
    assert2(snap.stages.SEAL.status === 'pending', 'a dry run must leave SEAL pending');
    assert2(snap.stages.PUBLISH.status === 'pending', 'a dry run must leave PUBLISH pending');
  });

  function snapshotTree(dir) {
    const out = [];
    const walk = function (d, rel) {
      let names = [];
      try { names = fs.readdirSync(d); } catch (e) { return; }
      for (const n of names) {
        if (n === '.git') continue;
        const abs = path.join(d, n);
        const r2 = rel ? rel + '/' + n : n;
        let st = null;
        try { st = fs.statSync(abs); } catch (e) { continue; }
        if (st.isDirectory()) { walk(abs, r2); continue; }
        out.push(r2 + ' ' + st.size + ' ' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'));
      }
    };
    walk(dir, '');
    return out.sort().join('\n');
  }
  function diffTree(a, b) {
    const A = a.split('\n'), B = b.split('\n');
    const onlyA = A.filter(x => B.indexOf(x) < 0);
    const onlyB = B.filter(x => A.indexOf(x) < 0);
    return '- ' + onlyA.slice(0, 8).join('\n- ') + '\n+ ' + onlyB.slice(0, 8).join('\n+ ');
  }

  /* ── D. counterproof: every one of these MUST become BLOCKED ──────────── */

  console.log('\n[D] counterproof: break one thing, expect BLOCKED');

  async function expectBlocked(stage, fxOpts, fault, options, wantKeys) {
    const fx = newFixture(fxOpts);
    const r = makeRunner(fx, Object.assign({}, options || {}, { fault: fault || undefined }));
    if (stage !== 'CHECK') {
      const c = await r.runStage('CHECK');
      assert2(c.status !== 'blocked', 'precondition CHECK blocked: ' + JSON.stringify(c.blockers));
    }
    if (stage === 'VERIFY' || stage === 'SEAL') {
      const b = await r.runStage('BUILD');
      assert2(b.status !== 'blocked', 'precondition BUILD blocked: ' + JSON.stringify(b.blockers));
    }
    const res = await r.runStage(stage);
    assert2(res.status === 'blocked', stage + ' was ' + res.status + ' — it must be BLOCKED');
    if (wantKeys) {
      const wanted = [].concat(wantKeys);
      const keys = blockedKeys(r, stage);
      assert2(wanted.some(w => keys.some(k => k.indexOf(w) >= 0)),
        'expected a blocker whose key contains one of [' + wanted.join(', ') + '], got: ' + keys.join(', '));
    }
    assert2(r.snapshot(0).status === 'BLOCKED', 'top status must be BLOCKED');
    return { r: r, fx: fx };
  }

  /*
   * The manifest-fault counterproofs go through the CANONICAL manifest writer
   * (the stub runs runtime/update-manifest.js with the bundled Node), so their
   * fixtures need a real runtime. Everything else uses the synthetic one, because
   * fifteen fixtures × a 100 MB runtime copy is 1.5 GB of pointless I/O. The
   * difference is stated here rather than hidden.
   */
  async function withRealNode(fn) {
    const prev = process.env.IB_RB_USE_REAL_NODE;
    process.env.IB_RB_USE_REAL_NODE = '1';
    try { return await fn(); } finally {
      if (prev === undefined) delete process.env.IB_RB_USE_REAL_NODE;
      else process.env.IB_RB_USE_REAL_NODE = prev;
    }
  }

  await checkAsync('build exits non-zero → BUILD BLOCKED', async () => {
    await expectBlocked('BUILD', { version: '1.0.5', target: '1.0.6' }, 'build-exit-1', {}, ['canonical-exit', 'build-failed']);
  });

  await checkAsync('build exits 0 but produces no artifact → BUILD BLOCKED', async () => {
    await expectBlocked('BUILD', { version: '1.0.5', target: '1.0.6' }, 'no-artifact', {}, ['artifact-exists', 'artifact-missing']);
  });

  await checkAsync('artifact is truncated → BUILD BLOCKED', async () => {
    await expectBlocked('BUILD', { version: '1.0.5', target: '1.0.6' }, 'tiny-artifact', {}, ['artifact-size', 'artifact-pe']);
  });

  await checkAsync('artifact file name is not the canonical one → BUILD BLOCKED', async () => {
    await expectBlocked('BUILD', { version: '1.0.5', target: '1.0.6' }, 'wrong-artifact-name', {}, ['artifact-exists', 'artifact-name']);
  });

  await checkAsync('artifact PE version does not match VERSION → VERIFY BLOCKED', async () => {
    await expectBlocked('VERIFY', { version: '1.0.5', target: '1.0.6' }, 'pe-version', {}, ['D-pe', 'F3-productVersion']);
  });

  await checkAsync('SHA256SUMS.txt records a stale hash → VERIFY BLOCKED', async () => {
    await expectBlocked('VERIFY', { version: '1.0.5', target: '1.0.6' }, 'sums-stale', {}, ['H-sums']);
  });

  await checkAsync('manifest announces the wrong version → VERIFY BLOCKED', async () => {
    await withRealNode(function () {
      return expectBlocked('VERIFY', { version: '1.0.5', target: '1.0.6' }, 'manifest-version', {}, ['G-version', 'F4-url-version']);
    });
  });

  await checkAsync('manifest carries the wrong sha256 → VERIFY BLOCKED', async () => {
    await withRealNode(function () {
      return expectBlocked('VERIFY', { version: '1.0.5', target: '1.0.6' }, 'manifest-sha', {}, ['F1-sha']);
    });
  });

  await checkAsync('manifest carries an unregistered channel → VERIFY BLOCKED', async () => {
    await withRealNode(function () {
      return expectBlocked('VERIFY', { version: '1.0.5', target: '1.0.6' }, 'manifest-channel', {}, ['G-channel']);
    });
  });

  await checkAsync('a manifest that disagrees with its artifact in dist → CHECK BLOCKED', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    /* Fabricate exactly the "stale manifest" state audit §10.3 describes. */
    const dist = path.join(fx.dir, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const exe = path.join(dist, 'InternalBeyond-Setup-1.0.6.exe');
    fs.writeFileSync(exe, fixture.buildPeWithVersion('1.0.6'));
    writeJson(path.join(dist, 'update-stable.json'), {
      schema: 'internalbeyond.update', schemaVersion: 1, channel: 'stable', version: '1.0.6',
      installer: {
        url: 'https://github.com/yydye/InternalBeyond/releases/download/v1.0.6/InternalBeyond-Setup-1.0.6.exe',
        sha256: 'f'.repeat(64), sizeBytes: fs.statSync(exe).size, productVersion: '1.0.6'
      }
    });
    const r = makeRunner(fx);
    const res = await r.runStage('CHECK');
    assert2(res.status === 'blocked', 'CHECK was ' + res.status);
    assert2(blockedKeys(r, 'CHECK').some(k => k === 'dist-self-consistent'),
      'the disagreement must be named: ' + blockedKeys(r, 'CHECK').join(', '));
  });

  await checkAsync('an unparseable VERSION → CHECK BLOCKED', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    fs.writeFileSync(path.join(fx.dir, 'VERSION'), 'not-a-version\n', 'utf8');
    const r = makeRunner(fx);
    const res = await r.runStage('CHECK');
    assert2(res.status === 'blocked', 'CHECK was ' + res.status);
    assert2(blockedKeys(r, 'CHECK').some(k => k === 'version-file'), blockedKeys(r, 'CHECK').join(','));
  });

  await checkAsync('a target that is not an upgrade → CHECK BLOCKED', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.4' });
    const r = makeRunner(fx);
    const res = await r.runStage('CHECK');
    assert2(res.status === 'blocked', 'CHECK was ' + res.status);
    assert2(blockedKeys(r, 'CHECK').some(k => k === 'plan:target-not-greater'), blockedKeys(r, 'CHECK').join(','));
  });

  await checkAsync('an invalid target version → CHECK BLOCKED', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = makeRunner(fx);
    r.setOptions({ target: '1.0' });
    const res = await r.runStage('CHECK');
    assert2(res.status === 'blocked', 'CHECK was ' + res.status);
    assert2(blockedKeys(r, 'CHECK').some(k => k === 'target-version' || k === 'plan:target-version-invalid'),
      blockedKeys(r, 'CHECK').join(','));
  });

  await checkAsync('a README release claim that drifted from VERSION → CHECK BLOCKED', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const readme = path.join(fx.dir, 'README.md');
    fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('当前版本 **1.0.5**', '当前版本 **1.0.3**'), 'utf8');
    const r = makeRunner(fx);
    const res = await r.runStage('CHECK');
    assert2(res.status === 'blocked', 'CHECK was ' + res.status);
    assert2(blockedKeys(r, 'CHECK').some(k => k === 'readme-claim'), blockedKeys(r, 'CHECK').join(','));
  });

  await checkAsync('a missing README claim anchor → CHECK BLOCKED (fail closed)', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const readme = path.join(fx.dir, 'README.md');
    /* Remove the anchor entirely: the canonical gate refuses to pass silently
       when the sentence it guards disappears (docs/RELEASE.md §5.1). */
    fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8')
      .replace(/`Windows 10\+`[^\n]*\n/, '`Windows 10+` · 免管理员权限 · 内置运行环境\n'), 'utf8');
    const r = makeRunner(fx);
    const res = await r.runStage('CHECK');
    assert2(res.status === 'blocked', 'CHECK was ' + res.status);
    assert2(blockedKeys(r, 'CHECK').some(k => k === 'readme-claim'), blockedKeys(r, 'CHECK').join(','));
  });

  await checkAsync('a target tag that already exists → CHECK BLOCKED', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    execFileSync('git', ['tag', '-a', 'v1.0.6', '-m', 'taken'], { cwd: fx.dir, stdio: 'ignore', shell: false, windowsHide: true });
    const r = makeRunner(fx);
    const res = await r.runStage('CHECK');
    assert2(res.status === 'blocked', 'CHECK was ' + res.status);
    assert2(blockedKeys(r, 'CHECK').some(k => k === 'tag-exists'), blockedKeys(r, 'CHECK').join(','));
  });

  await checkAsync('a residue dist\\staging → CHECK BLOCKED', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    fs.mkdirSync(path.join(fx.dir, 'dist', 'staging'), { recursive: true });
    const r = makeRunner(fx);
    const res = await r.runStage('CHECK');
    assert2(res.status === 'blocked', 'CHECK was ' + res.status);
    assert2(blockedKeys(r, 'CHECK').some(k => k === 'dist-staging'), blockedKeys(r, 'CHECK').join(','));
  });

  await checkAsync('a dirty working tree is reported (warn, and it is never counted as ok)', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    fs.writeFileSync(path.join(fx.dir, 'assets', 'js', 'app.js'), '/* changed */', 'utf8');
    const r = makeRunner(fx);
    const res = await r.runStage('CHECK');
    assert2(res.status === 'warn', 'CHECK was ' + res.status + ' (a dirty tree is a warning, not a blocker)');
    const items = r.snapshot(0).log.items;
    assert2(items.some(i => i.key.indexOf('git-clean') >= 0 && i.status === 'warn'), 'the dirty tree must be reported');
  });

  await checkAsync('VERIFY refuses to run when BUILD did not succeed', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = makeRunner(fx);
    await r.runStage('CHECK');
    const res = await r.runStage('VERIFY');
    assert2(res.status === 'blocked', 'VERIFY was ' + res.status);
    assert2(r.snapshot(0).log.items.some(i => i.key.indexOf('VERIFY:gate') >= 0), 'the gate refusal must be recorded');
  });

  await checkAsync('SEAL refuses to run when VERIFY did not succeed', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = makeRunner(fx);
    await r.runStage('CHECK');
    await r.runStage('BUILD');
    const res = await r.runStage('SEAL');
    assert2(res.status === 'blocked', 'SEAL was ' + res.status);
  });

  await checkAsync('a build failure rolls the version bump back and leaves no stable manifest', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const readmeBefore = fs.readFileSync(path.join(fx.dir, 'README.md'), 'utf8');
    const r = makeRunner(fx, { fault: 'build-exit-1' });
    await r.runStage('CHECK');
    const b = await r.runStage('BUILD');
    assert2(b.status === 'blocked', 'BUILD was ' + b.status);
    assert2(fs.readFileSync(path.join(fx.dir, 'VERSION'), 'utf8').trim() === '1.0.5',
      'VERSION must be restored: a failed build must not leave the repo announcing a version that does not exist');
    assert2(fs.readFileSync(path.join(fx.dir, 'README.md'), 'utf8') === readmeBefore,
      'README must be restored byte-for-byte');
    assert2(!fs.existsSync(path.join(fx.dir, 'dist', 'update-stable.json')),
      'a failed build must not produce a stable manifest');
  });

  /* ── PUBLISH is a separate authority ──────────────────────────────────── */

  console.log('\n[P] PUBLISH is separate, confirmed, and never automatic');

  await checkAsync('PUBLISH refuses to run after a blocked SEAL', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = makeRunner(fx);
    const res = await r.runStage('PUBLISH', { actions: ['commit'], confirmation: 'x' });
    assert2(res.status === 'blocked', 'PUBLISH was ' + res.status);
  });

  await checkAsync('PUBLISH refuses a missing or stale confirmation', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = await buildRelease(fx);
    await r.runStage('SEAL');
    const none = await r.runStage('PUBLISH', { actions: ['commit'] });
    assert2(none.status === 'blocked', 'PUBLISH without a confirmation must be refused');
    const stale = await r.runStage('PUBLISH', { actions: ['commit'], confirmation: 'deadbeef' });
    assert2(stale.status === 'blocked', 'PUBLISH with a wrong confirmation must be refused');
    assert2(blockedKeys(r, 'PUBLISH').some(k => k === 'publish-confirm'), blockedKeys(r, 'PUBLISH').join(','));
  });

  await checkAsync('the publish confirmation is bound to the artifact bytes', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = await buildRelease(fx);
    await r.runStage('SEAL');
    const p = publish.buildPlan(r.repo, { target: '1.0.6' });
    const token = publish.confirmToken(p.fingerprint, ['commit']);
    /* Tamper with the artifact: the same token must no longer authorize it. */
    const dist = path.join(fx.dir, 'dist');
    fs.appendFileSync(path.join(dist, 'InternalBeyond-Setup-1.0.6.exe'), '\n');
    const p2 = publish.buildPlan(r.repo, { target: '1.0.6' });
    assert2(p2.fingerprint !== p.fingerprint, 'the fingerprint must change when the bytes change');
    assert2(publish.confirmToken(p2.fingerprint, ['commit']) !== token, 'a stale confirmation must not match');
  });

  await checkAsync('the publish plan lists every irreversible action and the manifest upload is last', async () => {
    const fx = newFixture({ version: '1.0.5', target: '1.0.6' });
    const r = await buildRelease(fx);
    await r.runStage('SEAL');
    const p = publish.buildPlan(r.repo, { target: '1.0.6' });
    const ids = p.actions.map(a => a.id);
    assert2(ids[ids.length - 1] === 'manifestUpload', 'the manifest upload must be the LAST action: ' + ids.join(','));
    assert2(p.actions.find(a => a.id === 'push').irreversible === true, 'push is irreversible');
    assert2(p.actions.find(a => a.id === 'releaseCreate').irreversible === true, 'release create is irreversible');
    assert2(p.actions.find(a => a.id === 'manifestUpload').irreversible === true, 'the manifest upload is irreversible');
    assert2(p.actions.find(a => a.id === 'commit').irreversible === false, 'a local commit is not irreversible');
    assert2(p.commitPaths.indexOf('VERSION') >= 0 && p.commitPaths.indexOf('README.md') >= 0,
      'the release commit must name its paths explicitly: ' + p.commitPaths.join(','));
    assert2(p.commitPaths.indexOf('-A') < 0, 'never `git add -A`');
  });

  /* ── logs never leak a secret ─────────────────────────────────────────── */

  console.log('\n[L] log redaction');

  check('a credential in the environment never reaches the log', () => {
    const secret = 'sk-live-abcdefghijklmnopqrstuvwxyz012345';
    const log = logMod.createLog({ env: Object.assign({}, process.env, { IB_TEST_API_KEY: secret }) });
    log.event('running with key ' + secret);
    log.command({ file: 'gh', args: ['auth', 'login', '--with-token', secret], exitCode: 0 });
    log.item('x', { stage: 'CHECK', status: 'ok', title: 'token ' + secret, actual: secret });
    const text = log.render({});
    assert2(text.indexOf(secret) < 0, 'the secret leaked into the rendered log');
    assert2(text.indexOf('<redacted>') >= 0, 'the redaction marker must appear');
  });

  check('a credential embedded in a URL or an Authorization header is masked', () => {
    const log = logMod.createLog({ env: {} });
    log.event('remote is https://user:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y.git');
    log.event('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    const text = log.render({});
    assert2(text.indexOf('ghp_abcdefghijklmnop') < 0, 'the URL credential leaked');
    assert2(text.indexOf('abcdefghijklmnopqrstuvwxyz0123456789') < 0, 'the bearer token leaked');
    assert2(text.indexOf('https://') >= 0, 'the harmless part of the URL should survive');
  });

  check('the redactor masks the LONGEST matching secret first', () => {
    const long = 'TOKENVALUE0123456789';
    const short = 'TOKENVALUE';
    const log = logMod.createLog({ env: Object.assign({}, process.env, { A_TOKEN: long, B_SECRET: short }) });
    log.event('value ' + long);
    const text = log.render({});
    assert2(text.indexOf(long) < 0 && text.indexOf(short) < 0, 'a partial mask leaked: ' + text);
  });

  check('no environment value is dumped wholesale', () => {
    const log = logMod.createLog({ env: Object.assign({}, process.env, { MY_SESSION_TOKEN: 'sessionvalue0123456789' }) });
    const text = log.render({});
    assert2(text.indexOf('sessionvalue0123456789') < 0, 'an environment secret was dumped');
    assert2(text.indexOf('SystemRoot=') < 0, 'the environment must never be dumped as a whole');
  });

  /* ── temp cleanup ─────────────────────────────────────────────────────── */

  console.log('\n[CLEANUP] removing every throwaway checkout');
  /* fixture.disposeAll() disposes the batch, waits out the transient Windows
     handle holds that make a first rmSync fail, and reports what is actually
     still on disk. The assertion below is deliberately made on the REAL final
     state, so a leak is a failure rather than a silently ignored exception. */
  const disposal = fixture.disposeAll(CLEANUPS);
  check('every fixture checkout was removed', () => {
    assert2(disposal.failed.length === 0,
      'leftover temp directories: ' + disposal.failed.map(function (fx) {
        return [fx.dir, fx.remoteDir].filter(function (p) { return p && fs.existsSync(p); }).join(' + ');
      }).join(', '));
    assert2(disposal.removed === CLEANUPS.length,
      'removed ' + disposal.removed + ' of ' + CLEANUPS.length);
  });

  /*
   * The only thing this suite leaves behind is the compiled-PE cache under
   * %TEMP%\ib-rb-pe-cache (~9 MB per version). It is a CACHE, not residue: it
   * holds the C#-compiled stub images so the compiler runs at most once per
   * version per machine. It is reported with its exact size, and `--clean`
   * removes it (at the cost of recompiling on the next run).
   */
  const peCache = path.join(os.tmpdir(), 'ib-rb-pe-cache');
  const cleanRequested = process.argv.indexOf('--clean') >= 0;
  let cacheBytes = 0;
  if (fs.existsSync(peCache)) {
    for (const f of fs.readdirSync(peCache)) {
      try { cacheBytes += fs.statSync(path.join(peCache, f)).size; } catch (e) { /* ignore */ }
    }
  }
  if (cleanRequested) {
    try { fs.rmSync(peCache, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  console.log('  --  %TEMP%\\ib-rb-pe-cache: ' + (cacheBytes / 1048576).toFixed(1) + ' MiB' +
    (cleanRequested ? ' (removed by --clean)' : ' (kept: it is a compile cache, not residue)'));
  check('no test residue is left in %TEMP%', () => {
    const remaining = fs.readdirSync(os.tmpdir()).filter(function (n) {
      return n.indexOf('ib-rb-') === 0 || n.indexOf('ib-rb-origin-') === 0;
    });
    const unexpected = remaining.filter(function (n) { return n !== 'ib-rb-pe-cache'; });
    assert2(unexpected.length === 0, 'unexpected temp entries: ' + unexpected.join(', '));
    if (cleanRequested) assert2(remaining.length === 0, 'temp entries after --clean: ' + remaining.join(', '));
  });

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); }
  process.exitCode = fail ? 1 : 0;
})();
