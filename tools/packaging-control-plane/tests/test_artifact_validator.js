'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const validator = require('../artifact-validator.js');
const { createArtifactFixture } = require('./artifact-fixture.js');

function check(result, id) { return result.checks.find((item) => item.id === id); }
function hasCode(result, code) { return result.checks.some((item) => item.code === code && item.status === 'FAIL'); }
function run(fixture, request) {
  return validator.validateArtifact(request || fixture.request(), { root: fixture.root, adapters: fixture.adapters });
}

function verifyGoodRelease() {
  const fixture = createArtifactFixture({ mode: 'release' });
  try {
    const before = fs.readdirSync(fixture.outputRoot).sort();
    const result = run(fixture);
    assert.strictEqual(result.status, 'PASS');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.artifact.name, fixture.artifactName);
    assert.strictEqual(result.artifact.size, fixture.artifactSize);
    assert.match(result.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.strictEqual(check(result, 'canonical-source-closure').status, 'PASS');
    assert.strictEqual(check(result, 'build-source-provenance').status, 'PASS');
    assert.deepStrictEqual(run(fixture), result, 'same bytes and context must produce the same result');
    assert.deepStrictEqual(fs.readdirSync(fixture.outputRoot).sort(), before, 'validator must not modify output');
    assert.strictEqual(fs.existsSync(path.join(fixture.outputRoot, 'artifact-manifest.json')), false,
      'P35.3 must not write the future manifest');
  } finally { fixture.cleanup(); }
}

function verifyValidationLayers() {
  const unavailable = createArtifactFixture({ mode: 'release' });
  try {
    fs.rmSync(path.join(unavailable.outputRoot, 'staging'), { recursive: true, force: true });
    const result = run(unavailable);
    assert.strictEqual(result.status, 'PASS_WITH_WARNINGS');
    assert.strictEqual(result.valid, false);
    assert.strictEqual(check(result, 'staging-payload-manifest').code, 'STAGING_EVIDENCE_UNAVAILABLE');
    assert.strictEqual(check(result, 'staging-secret-scan').status, 'WARN');
  } finally { unavailable.cleanup(); }

  const noManifest = createArtifactFixture({ mode: 'release' });
  try {
    fs.rmSync(path.join(noManifest.outputRoot, 'update-stable.json'));
    const result = run(noManifest);
    assert.strictEqual(result.status, 'PASS_WITH_WARNINGS');
    assert.strictEqual(check(result, 'canonical-update-metadata').code, 'VERSION_METADATA_UNAVAILABLE');
  } finally { noManifest.cleanup(); }

  const noBuildContext = createArtifactFixture({ mode: 'release' });
  try {
    const request = noBuildContext.request();
    delete request.buildContext;
    const result = run(noBuildContext, request);
    assert.strictEqual(result.status, 'PASS_WITH_WARNINGS');
    assert.strictEqual(check(result, 'build-source-provenance').code, 'PROVENANCE_INCOMPLETE');
  } finally { noBuildContext.cleanup(); }

  const noPe = createArtifactFixture({ mode: 'release' });
  try {
    const adapters = Object.assign({}, noPe.adapters, {
      readPeVersion: function () { return { ok: false, read: { ok: false, productVersion: null } }; }
    });
    const result = validator.validateArtifact(noPe.request(), { root: noPe.root, adapters: adapters });
    assert.strictEqual(result.status, 'PASS_WITH_WARNINGS');
    assert.strictEqual(check(result, 'installer-pe-version').code, 'VERSION_METADATA_UNAVAILABLE');
  } finally { noPe.cleanup(); }

  const badSize = createArtifactFixture({ mode: 'release' });
  try {
    fs.truncateSync(badSize.artifactPath, 1024);
    const result = run(badSize);
    assert.strictEqual(result.status, 'FAIL');
    assert.strictEqual(check(result, 'artifact-size').code, 'ARTIFACT_SIZE_INVALID');
  } finally { badSize.cleanup(); }

  const wrongPe = createArtifactFixture({ mode: 'release' });
  try {
    const adapters = Object.assign({}, wrongPe.adapters, {
      readPeVersion: function () {
        return { ok: false, read: { ok: true, productVersion: '1.2.2', productVersionFixed: '1.2.2.0', fileVersionFixed: '1.2.2.0' } };
      }
    });
    const result = validator.validateArtifact(wrongPe.request(), { root: wrongPe.root, adapters: adapters });
    assert.strictEqual(result.status, 'FAIL');
    assert.strictEqual(check(result, 'installer-pe-version').code, 'VERSION_MISMATCH');
  } finally { wrongPe.cleanup(); }

  const wrongRevision = createArtifactFixture({ mode: 'release' });
  try {
    const request = wrongRevision.request({
      buildContext: { revision: 'b'.repeat(40), dirty: false }
    });
    const result = run(wrongRevision, request);
    assert.strictEqual(result.status, 'FAIL');
    assert.strictEqual(check(result, 'build-source-provenance').code, 'BUILD_METADATA_MISMATCH');
  } finally { wrongRevision.cleanup(); }

  const mismatch = createArtifactFixture({ mode: 'release' });
  try {
    const manifestPath = path.join(mismatch.outputRoot, 'update-stable.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.installer.sha256 = 'f'.repeat(64);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const before = fs.readFileSync(manifestPath, 'utf8');
    const result = run(mismatch);
    assert.strictEqual(result.status, 'FAIL');
    assert.strictEqual(check(result, 'build-metadata-sha256').code, 'ARTIFACT_HASH_FAILED');
    assert.strictEqual(fs.readFileSync(manifestPath, 'utf8'), before, 'validator must not repair stale metadata');
  } finally { mismatch.cleanup(); }
}

function verifyPathBoundary() {
  const fixture = createArtifactFixture({ mode: 'release' });
  try {
    const escaped = fixture.request({ artifact: { path: '../outside.exe' } });
    const escapeResult = run(fixture, escaped);
    assert.strictEqual(check(escapeResult, 'artifact-path-boundary').code, 'ARTIFACT_OUTSIDE_ALLOWED_ROOT');

    const absolute = fixture.request({ artifact: { path: 'C:\\Users\\someone\\setup.exe' } });
    const absoluteResult = run(fixture, absolute);
    assert.strictEqual(check(absoluteResult, 'artifact-path-boundary').code, 'ARTIFACT_OUTSIDE_ALLOWED_ROOT');

    const wrongName = fixture.request({ artifact: { path: 'dist/other.exe' } });
    const nameResult = run(fixture, wrongName);
    assert.strictEqual(check(nameResult, 'artifact-filename').code, 'ARTIFACT_FILENAME_MISMATCH');

    const missing = createArtifactFixture({ mode: 'release' });
    try {
      fs.rmSync(missing.artifactPath);
      const missingResult = run(missing);
      assert.strictEqual(check(missingResult, 'artifact-identity').code, 'ARTIFACT_NOT_FOUND');
    } finally { missing.cleanup(); }

    const outside = path.join(fixture.root, 'outside.exe');
    fs.writeFileSync(outside, 'synthetic');
    fs.rmSync(fixture.artifactPath);
    let junctionMade = false;
    try {
      fs.renameSync(fixture.outputRoot, path.join(fixture.root, 'dist-real'));
      fs.symlinkSync(path.join(fixture.root, 'dist-real'), fixture.outputRoot, 'junction');
      junctionMade = true;
    } catch (_) { /* Junction creation can be disabled on some Windows hosts. */ }
    if (junctionMade) {
      const linked = run(fixture);
      assert.strictEqual(check(linked, 'artifact-identity').code, 'ARTIFACT_OUTSIDE_ALLOWED_ROOT');
      console.log('  output-root junction boundary: PASS');
    } else {
      console.log('  output-root junction boundary: SKIP (junction creation unavailable)');
    }
  } finally { fixture.cleanup(); }
}

function verifySecurityAndMode() {
  const safeKeyName = createArtifactFixture({ mode: 'release' });
  try {
    const result = run(safeKeyName);
    assert.strictEqual(check(result, 'staging-secret-scan').status, 'PASS', 'an innocent apiKey field label is not a secret');
  } finally { safeKeyName.cleanup(); }

  const fakeSecret = createArtifactFixture({ mode: 'release' });
  try {
    fakeSecret.rebuildStage({ 'assets/leak.js': 'const apiKey = "TEST_ONLY_FAKE_SECRET_DO_NOT_USE";\n' });
    const result = run(fakeSecret);
    assert.strictEqual(result.status, 'FAIL');
    assert.ok(hasCode(result, 'SECRET_DETECTED'));
    assert.ok(!JSON.stringify(result).includes('TEST_ONLY_FAKE_SECRET_DO_NOT_USE'));
  } finally { fakeSecret.cleanup(); }

  const userDb = createArtifactFixture({ mode: 'release' });
  try {
    userDb.rebuildStage({ 'chat-history.sqlite': 'TEST_ONLY_FAKE_DATABASE\n' });
    const result = run(userDb);
    assert.strictEqual(result.status, 'FAIL');
    assert.ok(hasCode(result, 'USER_DATA_DETECTED'));
  } finally { userDb.cleanup(); }

  const controlPlane = createArtifactFixture({ mode: 'release' });
  try {
    controlPlane.rebuildStage({
      'tools/packaging-control-plane/artifact-validator.js': 'synthetic P35 control-plane source\n',
      'tests/fake-test.js': 'synthetic test source\n',
      'tmp/build.log': 'synthetic temporary log\n',
      'reports/fake-report.json': '{}\n'
    });
    const result = run(controlPlane);
    assert.strictEqual(result.status, 'FAIL');
    assert.strictEqual(check(result, 'staging-payload-deny-rules').code, 'PAYLOAD_VALIDATION_FAILED');
  } finally { controlPlane.cleanup(); }

  const pathLeak = createArtifactFixture({ mode: 'release' });
  try {
    pathLeak.rebuildStage(null, 'InternalBeyond 非官方二次开发版\n当前版本 **1.2.3**\n\n## 关于本仓库 / About this fork\n\n' + pathLeak.root + '\n');
    const result = run(pathLeak);
    assert.strictEqual(result.status, 'FAIL');
    assert.ok(hasCode(result, 'PATH_LEAK_DETECTED'));
    assert.ok(!JSON.stringify(result).includes(pathLeak.root));
  } finally { pathLeak.cleanup(); }

  const test = createArtifactFixture({ mode: 'test' });
  try {
    const result = run(test);
    assert.strictEqual(result.status, 'PASS_WITH_WARNINGS');
    assert.strictEqual(check(result, 'test-installer-identity').status, 'PASS');
    assert.strictEqual(check(result, 'test-mode-stable-manifest').status, 'PASS');
    assert.strictEqual(check(result, 'build-source-provenance').code, 'PROVENANCE_INCOMPLETE');
  } finally { test.cleanup(); }
}

function verifyFailureAggregation() {
  const fixture = createArtifactFixture({ mode: 'release' });
  try {
    fixture.rebuildStage({
      'assets/leak.js': 'const apiKey = "TEST_ONLY_FAKE_SECRET_DO_NOT_USE";\n',
      'chat-history.sqlite': 'TEST_ONLY_FAKE_DATABASE\n'
    });
    const result = run(fixture);
    assert.strictEqual(result.status, 'FAIL');
    assert.strictEqual(result.valid, false);
    assert.ok(result.summary.fail >= 2, 'multiple independent failures must be retained');
    assert.strictEqual(result.summary.pass + result.summary.warn + result.summary.fail, result.checks.length);
  } finally { fixture.cleanup(); }
}

verifyGoodRelease();
verifyValidationLayers();
verifyPathBoundary();
verifySecurityAndMode();
verifyFailureAggregation();

console.log('P35 artifact validator tests: PASS');
