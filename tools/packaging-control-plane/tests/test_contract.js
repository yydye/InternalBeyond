'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contract = require('../contract.js');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof contract.PackagingContractError && error.code === code,
    'expected PackagingContractError ' + code);
}

const releaseJob = {
  id: 'p35-release-1',
  target: 'windows-installer',
  version: '',
  channel: 'stable',
  mode: 'release',
  options: {}
};

const valid = contract.validatePackagingJob(releaseJob);
assert.strictEqual(valid.targetState, 'supported');
assert.deepStrictEqual(valid.options, { includeDocs: false, includeExamples: false });
assert.deepStrictEqual(contract.getAvailableTargets().map((item) => item.id), ['windows-installer']);
assert.ok(contract.getReservedTargets().every((item) => item.enabled === false));
assert.strictEqual(contract.validatePackagingJob(Object.assign({}, releaseJob, {
  target: 'android-apk'
})).targetState, 'reserved');
assert.strictEqual(contract.validatePackagingJob(Object.assign({}, releaseJob, {
  mode: 'test', channel: 'local'
})).mode, 'test');
assert.strictEqual(contract.validatePackagingJob(Object.assign({}, releaseJob, {
  mode: 'debug', channel: 'local'
})).mode, 'debug');
assert.strictEqual(contract.resolveJobVersion(releaseJob, '1.2.3').version, '1.2.3');

expectCode(() => contract.validatePackagingJob(Object.assign({}, releaseJob, { outputDir: 'dist' })), 'UNKNOWN_FIELD');
expectCode(() => contract.validatePackagingJob(Object.assign({}, releaseJob, { apiKey: 'redacted' })), 'FORBIDDEN_FIELD');
expectCode(() => contract.validatePackagingJob(Object.assign({}, releaseJob, {
  options: { nested: { chat_history: 'redacted' } }
})), 'FORBIDDEN_FIELD');
expectCode(() => contract.validatePackagingJob(Object.assign({}, releaseJob, {
  options: { includeDocs: true }
})), 'OPTION_NOT_SUPPORTED');
expectCode(() => contract.validatePackagingJob(Object.assign({}, releaseJob, {
  channel: 'local'
})), 'MODE_CHANNEL_MISMATCH');
expectCode(() => contract.validatePackagingJob(Object.assign({}, releaseJob, {
  mode: 'publish'
})), 'INVALID_MODE');
expectCode(() => contract.resolveJobVersion(Object.assign({}, releaseJob, { version: '9.9.9' }), '1.2.3'), 'VERSION_MISMATCH');

for (const name of ['packaging-job.schema.json', 'artifact-manifest.schema.json', 'validation-result.schema.json', 'artifact-manifest-write-result.schema.json']) {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', name), 'utf8'));
  assert.strictEqual(schema.additionalProperties, false);
}
const manifestSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'artifact-manifest.schema.json'), 'utf8'));
const artifactFilePattern = new RegExp(manifestSchema.properties.artifactFile.pattern);
assert.strictEqual(artifactFilePattern.test('InternalBeyond-Setup-1.2.3.exe'), true);
assert.strictEqual(artifactFilePattern.test('..'), false);
assert.strictEqual(artifactFilePattern.test('C:\\Users\\developer\\setup.exe'), false);
const revisionPattern = new RegExp(manifestSchema.properties.revision.pattern);
assert.strictEqual(revisionPattern.test('a'.repeat(64)), true);

console.log('P35 contract tests: PASS');
