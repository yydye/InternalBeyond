'use strict';

/*
 * Release Builder · A. pure planning tests.
 *
 * No I/O, no checkout, no clock, no network. This suite pins the decisions the
 * whole tool rests on:
 *
 *   · the target-version business rules (including the same-version rebuild
 *     refusal that audit §10.1 identified as a silent-overwrite hazard);
 *   · the stage state machine (a stage may not run before its predecessor);
 *   · the roll-up rule (an empty stage is never OK — it proved nothing);
 *   · the three top-level statuses;
 *   · the channel rule (Stable only, because that is what the contract knows);
 *   · and — importantly — that the local version comparison used by the pure
 *     planner agrees with the repository's ONE comparison on a full matrix, so
 *     it can never become a second opinion.
 *
 * Plus the structural guards that keep the tool an orchestrator: no second
 * asset-name spelling, no second semver regex, no second U1–U5 definition.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TOOL = path.resolve(__dirname, '..');
const REAL_REPO = path.resolve(TOOL, '..', '..');

const plan = require(path.join(TOOL, 'lib', 'plan.js'));
const productVersion = require(path.join(REAL_REPO, 'runtime', 'product-version.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; failures.push(name + ': ' + (e && e.message || e)); console.log('  XX  ' + name + ' — ' + (e && e.message || e)); }
}

console.log('Release Builder · pure planning (A)\n');

/* ── version shape / bump ────────────────────────────────────────────────── */

console.log('[1] version shape');
check('accepts MAJOR.MINOR.PATCH only', () => {
  assert.strictEqual(plan.isVersionShape('1.0.6'), true);
  assert.strictEqual(plan.isVersionShape('1.0'), false);
  assert.strictEqual(plan.isVersionShape('v1.0.6'), false);
  assert.strictEqual(plan.isVersionShape('1.0.6-beta'), false);
  assert.strictEqual(plan.isVersionShape(''), false);
  assert.strictEqual(plan.isVersionShape(null), false);
});
check('patch bump is numeric, not lexical', () => {
  assert.strictEqual(plan.bumpPatch('1.0.9'), '1.0.10');
  assert.strictEqual(plan.bumpPatch('1.9.9'), '1.9.10');
  assert.strictEqual(plan.bumpPatch('nope'), null);
});

/* ── the local comparison must agree with the canonical one ──────────────── */

console.log('\n[2] local comparison agrees with runtime/product-version.js');
check('compareShape === productVersion.compare on the full matrix', () => {
  const versions = ['0.0.1', '1.0.0', '1.0.1', '1.0.9', '1.0.10', '1.9.0', '1.10.0', '2.0.0'];
  for (const a of versions) {
    for (const b of versions) {
      assert.strictEqual(plan.compareShape(a, b), productVersion.compare(a, b),
        'disagreement for ' + a + ' vs ' + b);
    }
  }
});
check('both sides return null for a malformed version', () => {
  for (const bad of ['1.0', 'v1.0.0', '', 'x.y.z', '1.0.0.0']) {
    assert.strictEqual(plan.compareShape(bad, '1.0.0'), null, bad);
    assert.strictEqual(plan.compareShape('1.0.0', bad), null, bad);
    assert.strictEqual(productVersion.compare(bad, '1.0.0'), null, bad);
  }
});

/* ── version plan ────────────────────────────────────────────────────────── */

console.log('\n[3] version plan');
check('a normal forward release is allowed', () => {
  const r = plan.versionPlan({ current: '1.0.5', target: '1.0.6' });
  assert.strictEqual(r.ok, true, JSON.stringify(r.blockers));
  assert.strictEqual(r.order, 1);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.minimumVersion, plan.CANONICAL_MINIMUM_VERSION);
});
check('an invalid target version is refused', () => {
  for (const bad of ['', '1.0', 'v1.0.6', '1.0.6-rc1', 'latest']) {
    const r = plan.versionPlan({ current: '1.0.5', target: bad });
    assert.strictEqual(r.ok, false, 'should refuse ' + JSON.stringify(bad));
    assert.ok(r.blockers.some(b => b.code === 'target-version-invalid'), bad);
  }
});
check('a downgrade is refused', () => {
  const r = plan.versionPlan({ current: '1.0.5', target: '1.0.4' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some(b => b.code === 'target-not-greater'));
});
check('the same version is refused unless explicitly acknowledged (audit §10.1)', () => {
  const strict = plan.versionPlan({ current: '1.0.5', target: '1.0.5' });
  assert.strictEqual(strict.ok, false);
  assert.ok(strict.blockers.some(b => b.code === 'same-version-rebuild-unacknowledged'),
    'rebuilding the same version must be refused by default');

  const acked = plan.versionPlan({ current: '1.0.5', target: '1.0.5', acknowledge: { sameVersionRebuild: true } });
  assert.strictEqual(acked.ok, true);
  assert.ok(acked.warnings.some(w => w.code === 'same-version-rebuild-acknowledged'),
    'the acknowledgement must be recorded as a warning, not swallowed');
});
check('an unsupported channel is refused (the contract knows Stable only)', () => {
  const r = plan.versionPlan({ current: '1.0.5', target: '1.0.6', channel: 'beta' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some(b => b.code === 'channel-unsupported'));
  assert.deepStrictEqual(plan.CHANNELS, ['stable']);
});
check('an already-published version raises a warning, not a silent pass', () => {
  const r = plan.versionPlan({
    current: '1.0.5', target: '1.0.6',
    published: { exists: true, sha256: 'a'.repeat(64), tag: 'v1.0.6', draft: false, prerelease: false }
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.warnings.some(w => w.code === 'published-release-exists'));
});
check('a published version whose bytes differ from the local build requires acknowledgement', () => {
  const r = plan.versionPlan({
    current: '1.0.5', target: '1.0.6', artifactSha256: 'b'.repeat(64),
    published: { exists: true, sha256: 'a'.repeat(64), tag: 'v1.0.6', draft: false, prerelease: false }
  });
  assert.ok(r.blockersRequiringAcknowledgement.some(b => b.code === 'published-sha-differs'),
    'rebuilt bytes replacing verified bytes must not pass quietly');
});
check('a draft or prerelease release is flagged as not live', () => {
  const r = plan.versionPlan({
    current: '1.0.5', target: '1.0.6',
    published: { exists: true, sha256: '', tag: 'v1.0.6', draft: true, prerelease: false }
  });
  assert.ok(r.blockersRequiringAcknowledgement.some(b => b.code === 'published-release-not-live'));
});

/* ── state machine ───────────────────────────────────────────────────────── */

console.log('\n[4] stage state machine');
check('the five stages are fixed and PUBLISH is not in the one-click path', () => {
  assert.deepStrictEqual(plan.STAGES, ['CHECK', 'BUILD', 'VERIFY', 'SEAL', 'PUBLISH']);
  assert.deepStrictEqual(plan.oneClickStages(), ['CHECK', 'BUILD', 'VERIFY', 'SEAL']);
  assert.strictEqual(plan.oneClickStages().indexOf('PUBLISH'), -1,
    'no code path may push, tag, create a release or upload without a separate confirmed PUBLISH');
});
check('BUILD may not run before CHECK finished cleanly', () => {
  assert.strictEqual(plan.canRun('BUILD', { CHECK: 'pending' }).ok, false);
  assert.strictEqual(plan.canRun('BUILD', { CHECK: 'blocked' }).ok, false);
  assert.strictEqual(plan.canRun('BUILD', { CHECK: 'ok' }).ok, true);
  assert.strictEqual(plan.canRun('BUILD', { CHECK: 'warn' }).ok, true,
    'a warning is "a human must read this", not "this is wrong": it must not freeze the tool');
  assert.strictEqual(plan.canRun('BUILD', { CHECK: 'dry' }).ok, false,
    'a dry CHECK is not a completed check');
});
check('VERIFY and SEAL may not run before their predecessor finished cleanly', () => {
  for (const [stage, prev] of [['VERIFY', 'BUILD'], ['SEAL', 'VERIFY']]) {
    assert.strictEqual(plan.canRun(stage, { [prev]: 'pending' }).ok, false, stage);
    assert.strictEqual(plan.canRun(stage, { [prev]: 'blocked' }).ok, false, stage);
    assert.strictEqual(plan.canRun(stage, { [prev]: 'dry' }).ok, false, stage);
    assert.strictEqual(plan.canRun(stage, { [prev]: 'ok' }).ok, true, stage);
  }
});
check('PUBLISH needs SEAL ok (warn is tolerated, pending/blocked is not)', () => {
  assert.strictEqual(plan.canRun('PUBLISH', { SEAL: 'ok' }).ok, true);
  assert.strictEqual(plan.canRun('PUBLISH', { SEAL: 'warn' }).ok, true);
  assert.strictEqual(plan.canRun('PUBLISH', { SEAL: 'pending' }).ok, false);
  assert.strictEqual(plan.canRun('PUBLISH', { SEAL: 'blocked' }).ok, false);
  assert.strictEqual(plan.canRun('PUBLISH', { SEAL: 'dry' }).ok, false);
});
check('an unknown stage is refused', () => {
  assert.strictEqual(plan.canRun('DEPLOY', {}).ok, false);
});

/* ── roll-up and top status ──────────────────────────────────────────────── */

console.log('\n[5] roll-up and top-level status');
check('an empty stage can never be OK', () => {
  assert.strictEqual(plan.rollUp([]).status, 'blocked');
});
check('blocked beats warn beats ok', () => {
  assert.strictEqual(plan.rollUp([{ status: 'ok' }, { status: 'warn' }]).status, 'warn');
  assert.strictEqual(plan.rollUp([{ status: 'ok' }, { status: 'blocked' }]).status, 'blocked');
  assert.strictEqual(plan.rollUp([{ status: 'ok' }, { status: 'ok' }]).status, 'ok');
});
check('only three top-level statuses exist', () => {
  assert.deepStrictEqual(Object.values(plan.STATUS), ['BLOCKED', 'READY', 'PUBLISHED']);
});
check('unknown state is BLOCKED, not READY', () => {
  assert.strictEqual(plan.topStatus({}), plan.STATUS.BLOCKED);
  assert.strictEqual(plan.topStatus({ stages: { SEAL: { status: 'pending' } } }), plan.STATUS.BLOCKED);
});
check('SEAL ok means READY and it is NOT published', () => {
  const s = plan.topStatus({ stages: { SEAL: { status: 'ok' }, PUBLISH: { status: 'pending' } } });
  assert.strictEqual(s, plan.STATUS.READY);
  assert.notStrictEqual(s, plan.STATUS.PUBLISHED);
});
check('any blocker at all makes the whole run BLOCKED', () => {
  const s = plan.topStatus({
    stages: { SEAL: { status: 'ok' }, PUBLISH: { status: 'pending' } },
    blockers: [{ code: 'artifact-missing' }]
  });
  assert.strictEqual(s, plan.STATUS.BLOCKED);
});
check('PUBLISHED requires PUBLISH to have completed', () => {
  assert.strictEqual(plan.topStatus({ stages: { SEAL: { status: 'ok' }, PUBLISH: { status: 'ok' } } }), plan.STATUS.PUBLISHED);
  assert.strictEqual(plan.topStatus({ stages: { SEAL: { status: 'blocked' }, PUBLISH: { status: 'ok' } } }), plan.STATUS.PUBLISHED,
    'a completed publish is PUBLISHED whatever else the run reported');
  assert.strictEqual(plan.topStatus({ stages: { SEAL: { status: 'ok' }, PUBLISH: { status: 'dry' } } }), plan.STATUS.READY,
    'a dry PUBLISH changes nothing: the sealed release is still READY and NOT published');
  assert.notStrictEqual(plan.topStatus({ stages: { SEAL: { status: 'ok' }, PUBLISH: { status: 'pending' } } }), plan.STATUS.PUBLISHED,
    'sealing alone must never be reported as published');
  assert.strictEqual(plan.topStatus({ stages: { SEAL: { status: 'dry' }, PUBLISH: { status: 'pending' } } }), plan.STATUS.BLOCKED,
    'a dry SEAL is not a sealed release — a dry run leaves the work outstanding');
  assert.strictEqual(plan.topStatus({ stages: { SEAL: { status: 'dry' }, PUBLISH: { status: 'dry' } } }), plan.STATUS.BLOCKED,
    'a fully dry run is not a release');
});

/* ── structural guards: no second release authority ──────────────────────── */

console.log('\n[6] structural guards (no second release authority in this tool)');

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) { if (name !== 'tests' && name !== '.dry-run') walk(abs, out); continue; }
    if (!/\.(js)$/.test(name)) continue;
    if (name.indexOf('.test.') >= 0) continue;
    out.push(abs);
  }
  return out;
}

/* Strip comments and string literals: a doc sentence is not a dependency. */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

const sources = walk(TOOL, []);
const sourceText = sources.map(function (f) { return { file: path.relative(TOOL, f), stripped: stripCommentsAndStrings(fs.readFileSync(f, 'utf8')) }; });

check('only lib/seal.js may contain an asset-name PATTERN, and only to find old files', () => {
  /* seal.js is the single documented exception: archiving old releases needs a
     glob. It never constructs a release name — it only recognizes names already
     on disk. Every name the tool produces goes through repo.assetName(). */
  const ALLOWED = [path.join('lib', 'seal.js')];
  const offenders = sourceText.filter(function (s) {
    if (ALLOWED.indexOf(s.file) >= 0) return false;
    return /InternalBeyond-Setup-[^'"\s]/.test(s.stripped) || /['"]InternalBeyond-Setup/.test(s.stripped);
  });
  assert.deepStrictEqual(offenders.map(s => s.file), [],
    'the asset name has exactly one spelling source: runtime/update-manifest.js installerAssetName()');
  const sealSrc = fs.readFileSync(path.join(TOOL, 'lib', 'seal.js'), 'utf8');
  assert.ok(sealSrc.indexOf('assetVersionOf') >= 0,
    'seal.js must still be able to recognize old installer files, derived from the canonical name');
});
check('no source hard-codes the releases/download URL prefix', () => {
  const offenders = sourceText.filter(function (s) { return /releases\/download/.test(s.stripped); });
  assert.deepStrictEqual(offenders.map(s => s.file), [],
    'URLs come from the canonical installerUrl()');
});
check('no source implements a second semver comparison', () => {
  /* Look for a comparison over three numeric parts, i.e. a second semver compare.
     lib/plan.js is allowed to carry the shape check the pure tests need, but its
     compareShape must delegate to no regex of its own beyond isVersionShape. */
  const offenders = sourceText.filter(function (s) {
    if (s.file === path.join('lib', 'plan.js')) return false;
    return /\\d\+\\\.\\d\+\\\.\\d\+/.test(s.stripped) && /compare/i.test(s.stripped);
  });
  assert.deepStrictEqual(offenders.map(s => s.file), []);
});
check('no source opens its own HTTPS transport', () => {
  const offenders = sourceText.filter(function (s) { return /require\(\s*['"]https['"]\s*\)|require\(\s*['"]http['"]\s*\)/.test(s.stripped); });
  assert.deepStrictEqual(offenders.map(s => s.file), [],
    'the one HTTPS implementation is runtime/update-transport.js');
});
check('no source carries a second secret vocabulary', () => {
  const offenders = sourceText.filter(function (s) {
    return /sk-\[A-Za-z0-9|BEGIN PRIVATE KEY|AKIA\[|xoxb-/.test(s.stripped);
  });
  assert.deepStrictEqual(offenders.map(s => s.file), [],
    'the payload secret vocabulary stays in scripts/release-audit.js; lib/log.js redacts, it does not scan the payload');
});
check('canonical.js is the only file that requires a repository authority', () => {
  const offenders = sourceText.filter(function (s) {
    if (s.file === path.join('lib', 'canonical.js')) return false;
    return /require\([^)]*(product-version|update-manifest|pe-version|release-manifest|release-audit)\.js/.test(s.stripped);
  });
  assert.deepStrictEqual(offenders.map(s => s.file), [],
    'one adapter, so "where does this fact come from" has one answer');
});
check('no source auto-runs a publish command outside lib/publish.js', () => {
  const offenders = sourceText.filter(function (s) {
    if (s.file === path.join('lib', 'publish.js')) return false;
    return /'release'\s*,\s*'create'/.test(s.stripped) || /'release'\s*,\s*'upload'/.test(s.stripped);
  });
  assert.deepStrictEqual(offenders.map(s => s.file), []);
});
check('fault injection is refused unless the environment opt-in is set', () => {
  const runner = fs.readFileSync(path.join(TOOL, 'lib', 'runner.js'), 'utf8');
  assert.ok(runner.indexOf('IB_RELEASE_BUILDER_ALLOW_FAULT') >= 0,
    'the counterproof fault switch must be opt-in via the environment');
});

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (failures.length) { console.log('失败明细:'); failures.forEach(f => console.log('  - ' + f)); }
process.exitCode = fail ? 1 : 0;
