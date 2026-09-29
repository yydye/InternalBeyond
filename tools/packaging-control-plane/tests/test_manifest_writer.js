'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const artifactValidator = require('../artifact-validator.js');
const writer = require('../artifact-manifest-writer.js');
const { createArtifactFixture } = require('./artifact-fixture.js');
const artifactManifestSchema = require('../schemas/artifact-manifest.schema.json');

const CREATED_AT = '2026-09-28T05:00:00.000Z';

function validate(fixture, request) {
  return artifactValidator.validateArtifact(request || fixture.request(), {
    root: fixture.root,
    adapters: fixture.adapters
  });
}

function writeRequest(fixture, validationResult, patch) {
  const request = {
    job: {
      id: 'p35-writer-fixture', target: 'windows-installer', version: fixture.version,
      channel: 'stable', mode: 'release', options: {}
    },
    validationResult: validationResult,
    provenance: { createdAt: CREATED_AT }
  };
  return Object.assign(request, patch || {});
}

function assertDenied(result, code) {
  assert.strictEqual(result.status, 'DENIED');
  assert.strictEqual(result.code, code);
  assert.strictEqual(result.manifest, null);
}

function verifyPureBuildAndGate() {
  const revisionPattern = new RegExp(artifactManifestSchema.properties.revision.pattern);
  assert.strictEqual(revisionPattern.test('a'.repeat(64)), true, 'schema accepts SHA-256 Git revisions emitted by P35.3');

  const good = createArtifactFixture({ mode: 'release' });
  try {
    const validation = validate(good);
    assert.strictEqual(validation.status, 'PASS');
    const request = writeRequest(good, validation);
    const first = writer.buildArtifactManifest(request);
    const second = writer.buildArtifactManifest(request);
    assert.strictEqual(first.status, 'BUILT');
    assert.deepStrictEqual(second, first, 'same input must produce byte-for-byte deterministic output');
    assert.deepStrictEqual(JSON.parse(first.serialized), first.manifest);
    assert.strictEqual(first.manifest.createdAt, CREATED_AT);
    assert.strictEqual(first.manifest.revision, validation.context.revision);
    assert.strictEqual(first.manifest.sourceDirty, false);
    assert.strictEqual(first.manifest.artifactFile, validation.artifact.name);
    assert.strictEqual(first.manifest.artifactBytes, validation.artifact.size);
    assert.strictEqual(first.manifest.hash, validation.artifact.sha256);
    assert.strictEqual(first.manifest.validated, true);
    assert.deepStrictEqual(first.manifest.validation.checks,
      validation.checks.map((check) => ({ id: check.id, status: check.status })));
    assert.ok(first.manifest.validation.checks.every((check) => check.status === 'PASS'));
    assert.strictEqual(first.sha256, crypto.createHash('sha256').update(first.serialized).digest('hex'));
    assert.ok(!first.serialized.includes('message'));
    assert.ok(!first.serialized.includes('evidence'));

    const cloned = JSON.parse(JSON.stringify(validation));
    assertDenied(writer.buildArtifactManifest(writeRequest(good, cloned)), 'VALIDATION_RESULT_INVALID');
    assertDenied(writer.buildArtifactManifest(writeRequest(good, { status: 'PASS', valid: true })), 'VALIDATION_RESULT_INVALID');
    const missingValidation = writeRequest(good, validation);
    delete missingValidation.validationResult;
    assertDenied(writer.buildArtifactManifest(missingValidation), 'VALIDATION_RESULT_INVALID');
    const missingTimestamp = writeRequest(good, validation);
    delete missingTimestamp.provenance.createdAt;
    assertDenied(writer.buildArtifactManifest(missingTimestamp), 'INVALID_REQUEST');

    const forgedJob = writeRequest(good, validation, {
      job: Object.assign({}, request.job, { apiKey: 'TEST_ONLY_FAKE_SECRET_DO_NOT_USE' })
    });
    assertDenied(writer.buildArtifactManifest(forgedJob), 'FORBIDDEN_FIELD_DETECTED');

    const forbiddenProvenance = writeRequest(good, validation, {
      provenance: { createdAt: CREATED_AT, vault: 'TEST_ONLY_FAKE_VAULT' }
    });
    assertDenied(writer.buildArtifactManifest(forbiddenProvenance), 'FORBIDDEN_FIELD_DETECTED');
    const userDataProvenance = writeRequest(good, validation, {
      provenance: { createdAt: CREATED_AT, userData: 'TEST_ONLY_FAKE_USER_DATA' }
    });
    assertDenied(writer.buildArtifactManifest(userDataProvenance), 'FORBIDDEN_FIELD_DETECTED');
  } finally { good.cleanup(); }

  const warned = createArtifactFixture({ mode: 'release' });
  try {
    fs.rmSync(path.join(warned.outputRoot, 'staging'), { recursive: true, force: true });
    const validation = validate(warned);
    assert.strictEqual(validation.status, 'PASS_WITH_WARNINGS');
    assertDenied(writer.buildArtifactManifest(writeRequest(warned, validation)), 'VALIDATION_NOT_PASS');
  } finally { warned.cleanup(); }

  const failed = createArtifactFixture({ mode: 'release' });
  try {
    fs.truncateSync(failed.artifactPath, 1024);
    const validation = validate(failed);
    assert.strictEqual(validation.status, 'FAIL');
    assertDenied(writer.buildArtifactManifest(writeRequest(failed, validation)), 'VALIDATION_NOT_PASS');
  } finally { failed.cleanup(); }

  const tampered = createArtifactFixture({ mode: 'release' });
  try {
    const validation = validate(tampered);
    validation.valid = false;
    assertDenied(writer.buildArtifactManifest(writeRequest(tampered, validation)), 'VALIDATION_RESULT_INVALID');
  } finally { tampered.cleanup(); }

  assertDenied(writer.buildArtifactManifest({}), 'INVALID_REQUEST');
}

function verifyAtomicWriteAndConflictPolicy() {
  const fixture = createArtifactFixture({ mode: 'release' });
  try {
    const validation = validate(fixture);
    const request = writeRequest(fixture, validation);
    const expected = writer.buildArtifactManifest(request);
    const sidecarName = fixture.artifactName + '.manifest.json';
    const sidecarPath = path.join(fixture.outputRoot, sidecarName);
    const artifactBefore = fs.statSync(fixture.artifactPath);
    const baseRead = fs.readFileSync;
    let artifactRead = false;
    const result = writer.writeArtifactManifest(request, {
      root: fixture.root,
      io: {
        readFileSync: function (file, options) {
          if (path.resolve(String(file)) === path.resolve(fixture.artifactPath)) artifactRead = true;
          return baseRead(file, options);
        }
      }
    });
    assert.strictEqual(result.status, 'WRITTEN');
    assert.strictEqual(result.code, null);
    assert.deepStrictEqual(result.manifest, { name: sidecarName, sha256: expected.sha256 });
    assert.strictEqual(artifactRead, false, 'Writer must not read or rehash artifact bytes');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(sidecarPath, 'utf8')), expected.manifest);
    assert.strictEqual(fs.readFileSync(sidecarPath, 'utf8'), expected.serialized);
    assert.strictEqual(fs.existsSync(path.join(fixture.outputRoot, 'artifact-manifest.json')), false);
    assert.strictEqual(fs.readdirSync(fixture.outputRoot).some((name) => name.endsWith('.tmp')), false);
    const artifactAfter = fs.statSync(fixture.artifactPath);
    assert.strictEqual(artifactAfter.size, artifactBefore.size);
    assert.strictEqual(artifactAfter.mtimeMs, artifactBefore.mtimeMs);

    const identical = writer.writeArtifactManifest(request, { root: fixture.root });
    assert.strictEqual(identical.status, 'ALREADY_IDENTICAL');
    assert.strictEqual(identical.manifest.sha256, result.manifest.sha256);
    const original = fs.readFileSync(sidecarPath);
    const conflictBytes = Buffer.from(expected.serialized + ' ', 'utf8');
    fs.writeFileSync(sidecarPath, conflictBytes);
    const conflict = writer.writeArtifactManifest(request, { root: fixture.root });
    assertDenied(conflict, 'MANIFEST_ALREADY_EXISTS_CONFLICT');
    assert.deepStrictEqual(fs.readFileSync(sidecarPath), conflictBytes, 'conflicting evidence must remain untouched');
    fs.writeFileSync(sidecarPath, original);
  } finally { fixture.cleanup(); }
}

function verifyOutputBoundary() {
  const fixture = createArtifactFixture({ mode: 'release' });
  try {
    const validation = validate(fixture);
    const request = writeRequest(fixture, validation);
    for (const outputPath of ['../elsewhere', 'C:\\Users\\developer\\out', '\\\\server\\share\\out']) {
      assertDenied(writer.writeArtifactManifest(Object.assign({}, request, { outputPath }), { root: fixture.root }), 'OUTPUT_PATH_INVALID');
    }

    const realOutput = path.join(fixture.root, 'dist-real');
    fs.renameSync(fixture.outputRoot, realOutput);
    fs.symlinkSync(realOutput, fixture.outputRoot, 'junction');
    const linked = writer.writeArtifactManifest(request, { root: fixture.root });
    assertDenied(linked, 'OUTPUT_PATH_INVALID');
  } finally { fixture.cleanup(); }
}

function verifyWriteFailures() {
  const malformed = createArtifactFixture({ mode: 'release' });
  try {
    const request = writeRequest(malformed, validate(malformed));
    const baseRead = fs.readFileSync;
    const result = writer.writeArtifactManifest(request, {
      root: malformed.root,
      io: {
        readFileSync: function (file, options) {
          if (String(file).endsWith('.tmp')) return Buffer.from('{', 'utf8');
          return baseRead(file, options);
        }
      }
    });
    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(result.code, 'MANIFEST_READBACK_FAILED');
    assert.strictEqual(fs.existsSync(path.join(malformed.outputRoot, malformed.artifactName + '.manifest.json')), false);
    assert.strictEqual(fs.readdirSync(malformed.outputRoot).some((name) => name.endsWith('.tmp')), false);
  } finally { malformed.cleanup(); }

  const writeFailure = createArtifactFixture({ mode: 'release' });
  try {
    const request = writeRequest(writeFailure, validate(writeFailure));
    const result = writer.writeArtifactManifest(request, {
      root: writeFailure.root,
      io: { linkSync: function () { const error = new Error('synthetic write failure'); error.code = 'EIO'; throw error; } }
    });
    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(result.code, 'MANIFEST_WRITE_FAILED');
    assert.strictEqual(fs.existsSync(path.join(writeFailure.outputRoot, writeFailure.artifactName + '.manifest.json')), false);
    assert.strictEqual(fs.readdirSync(writeFailure.outputRoot).some((name) => name.endsWith('.tmp')), false);
  } finally { writeFailure.cleanup(); }

  const finalReadback = createArtifactFixture({ mode: 'release' });
  try {
    const request = writeRequest(finalReadback, validate(finalReadback));
    const baseRead = fs.readFileSync;
    const result = writer.writeArtifactManifest(request, {
      root: finalReadback.root,
      io: {
        readFileSync: function (file, options) {
          if (String(file).endsWith('.manifest.json')) return Buffer.from('{"broken":true}', 'utf8');
          return baseRead(file, options);
        }
      }
    });
    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(result.code, 'MANIFEST_READBACK_FAILED');
    assert.strictEqual(fs.existsSync(path.join(finalReadback.outputRoot, finalReadback.artifactName + '.manifest.json')), true,
      'an atomic committed file is left for inspection after read-back failure');
  } finally { finalReadback.cleanup(); }

  const contentMismatch = createArtifactFixture({ mode: 'release' });
  try {
    const request = writeRequest(contentMismatch, validate(contentMismatch));
    const baseRead = fs.readFileSync;
    const result = writer.writeArtifactManifest(request, {
      root: contentMismatch.root,
      io: {
        readFileSync: function (file, options) {
          if (String(file).endsWith('.manifest.json')) {
            const expected = writer.buildArtifactManifest(request).manifest;
            expected.createdAt = '2026-09-28T05:00:01.000Z';
            return Buffer.from(JSON.stringify(expected, null, 2) + '\n', 'utf8');
          }
          return baseRead(file, options);
        }
      }
    });
    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(result.code, 'MANIFEST_CONTENT_MISMATCH');
  } finally { contentMismatch.cleanup(); }
}

verifyPureBuildAndGate();
verifyAtomicWriteAndConflictPolicy();
verifyOutputBoundary();
verifyWriteFailures();

console.log('P35 artifact manifest writer tests: PASS');
