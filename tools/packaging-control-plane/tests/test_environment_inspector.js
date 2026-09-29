'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const inspector = require('../environment-inspector.js');
const { createFixture } = require('./fixture.js');

const childEnv = inspector.createBuildEnvironment({
  PATH: 'C:\\Windows\\System32',
  PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
  SystemRoot: 'C:\\Windows',
  ProgramData: 'C:\\ProgramData',
  API_KEY: 'TEST_ONLY_FAKE_SECRET_DO_NOT_USE',
  VAULT_TOKEN: 'TEST_ONLY_FAKE_VAULT'
});
assert.strictEqual(childEnv.PATH, 'C:\\Windows\\System32');
assert.strictEqual(childEnv.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
assert.strictEqual(childEnv.SystemRoot, 'C:\\Windows');
assert.strictEqual(childEnv.ProgramData, 'C:\\ProgramData');
assert.strictEqual(childEnv.GIT_OPTIONAL_LOCKS, '0');
assert.strictEqual(Object.prototype.hasOwnProperty.call(childEnv, 'API_KEY'), false);
assert.strictEqual(Object.prototype.hasOwnProperty.call(childEnv, 'VAULT_TOKEN'), false);

function byName(result, name) {
  return result.checks.find((item) => item.name === name);
}

const fixture = createFixture({ dirty: true, webview2: false });
try {
  const beforeDist = fs.readdirSync(path.join(fixture.root, 'dist'));
  const beforeTemp = fs.readdirSync(fixture.temporaryDir);
  const ready = fixture.inspect('release');
  assert.strictEqual(ready.ready, true);
  assert.strictEqual(ready.repository.dirty, true);
  assert.strictEqual(byName(ready, 'git-cleanliness').status, 'WARN');
  assert.strictEqual(byName(ready, 'npm').status, 'WARN');
  assert.strictEqual(byName(ready, 'tauri-cli').status, 'WARN');
  assert.strictEqual(byName(ready, 'webview2').status, 'WARN');
  assert.strictEqual(byName(ready, 'payload-closure').status, 'PASS');
  assert.deepStrictEqual(fs.readdirSync(path.join(fixture.root, 'dist')), beforeDist);
  assert.deepStrictEqual(fs.readdirSync(fixture.temporaryDir), beforeTemp);
  assert.strictEqual(fs.existsSync(path.join(fixture.programData, 'InternalBeyond', 'host-build')), false);
  assert.ok(ready.checks.every((item) => !item.message.includes(fixture.root)));

  const missingCargo = createFixture({ missingTools: ['cargo'] });
  try {
    const result = missingCargo.inspect('release');
    assert.strictEqual(result.ready, false);
    assert.strictEqual(byName(result, 'cargo').status, 'FAIL');
  } finally { missingCargo.cleanup(); }

  const missingGit = createFixture({ missingTools: ['git'] });
  try {
    const result = missingGit.inspect('release');
    assert.strictEqual(result.ready, false);
    assert.strictEqual(byName(result, 'git-revision').status, 'FAIL');
  } finally { missingGit.cleanup(); }

  const lowDisk = createFixture({ freeBytes: 1024 * 1024 * 1024 });
  try {
    const result = lowDisk.inspect('release');
    assert.strictEqual(result.ready, false);
    assert.strictEqual(byName(result, 'output-disk-space').status, 'FAIL');
  } finally { lowDisk.cleanup(); }

  const missingPayload = createFixture({ payloadOk: false });
  try {
    const result = missingPayload.inspect('release');
    assert.strictEqual(result.ready, false);
    assert.strictEqual(byName(result, 'payload-closure').status, 'FAIL');
  } finally { missingPayload.cleanup(); }

  const noWrite = createFixture({ writable: false });
  try {
    const result = noWrite.inspect('release');
    assert.strictEqual(result.ready, false);
    assert.strictEqual(byName(result, 'output-writable').status, 'FAIL');
  } finally { noWrite.cleanup(); }
} finally {
  fixture.cleanup();
}

console.log('P35 environment inspector tests: PASS');
