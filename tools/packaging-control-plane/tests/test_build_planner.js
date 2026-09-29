'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contract = require('../contract.js');
const planner = require('../build-planner.js');
const { createFixture } = require('./fixture.js');

function job(overrides) {
  return Object.assign({
    id: 'p35-plan-1',
    target: 'windows-installer',
    version: '',
    channel: 'stable',
    mode: 'release',
    options: {}
  }, overrides || {});
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof contract.PackagingContractError && error.code === code);
}

const fixture = createFixture({ dirty: true });
try {
  const inspection = fixture.inspect('release');
  const first = planner.createBuildPlan(job(), { root: fixture.root, inspection: inspection });
  const second = planner.createBuildPlan(job(), { root: fixture.root, inspection: inspection });
  assert.deepStrictEqual(first, second, 'same job and inspection must produce the same plan');
  assert.strictEqual(first.executes, false);
  assert.strictEqual(first.target, 'windows-installer');
  assert.strictEqual(first.version, '1.2.3');
  assert.strictEqual(first.sourceDirty, true);
  assert.strictEqual(first.releaseEligible, false);
  assert.strictEqual(first.publication, 'not-included');
  assert.ok(!first.steps.some((step) => step.id === 'publish'));
  assert.strictEqual(first.steps.find((step) => step.id === 'build-installer').command.arguments.includes('-TestMode'), false);
  assert.strictEqual(JSON.stringify(first).includes(fixture.root), false, 'plans must not contain absolute workspace paths');

  const testPlan = planner.createBuildPlan(job({ mode: 'test', channel: 'local' }), {
    root: fixture.root,
    inspection: fixture.inspect('test')
  });
  assert.strictEqual(testPlan.status, 'READY_WITH_WARNINGS');
  assert.strictEqual(testPlan.releaseEligible, false);
  assert.strictEqual(testPlan.artifact.outputRoot, 'tmp/installer-smoke-build');
  assert.ok(testPlan.steps.find((step) => step.id === 'build-installer').command.arguments.includes('-TestMode'));
  assert.ok(!JSON.stringify(testPlan).includes('update-stable.json'));

  const debugPlan = planner.createBuildPlan(job({ mode: 'debug', channel: 'local' }), { root: fixture.root });
  assert.strictEqual(debugPlan.status, 'UNSUPPORTED');
  assert.strictEqual(debugPlan.steps.length, 0);

  const futurePlan = planner.createBuildPlan(job({ target: 'android-apk' }), { root: fixture.root });
  assert.strictEqual(futurePlan.status, 'UNSUPPORTED');
  assert.strictEqual(futurePlan.steps.length, 0);

  const blockedInspection = Object.assign({}, inspection, { ready: false });
  const blockedPlan = planner.createBuildPlan(job(), { root: fixture.root, inspection: blockedInspection });
  assert.strictEqual(blockedPlan.status, 'BLOCKED');
  assert.strictEqual(blockedPlan.releaseEligible, false);
  assert.ok(blockedPlan.steps.every((step) => step.id === 'environment-check' || step.status === 'BLOCKED'));

  const inconsistentInspection = Object.assign({}, inspection, {
    ready: true,
    checks: inspection.checks.concat([{ name: 'forged-required-check', status: 'FAIL', required: true }])
  });
  const inconsistentPlan = planner.createBuildPlan(job(), { root: fixture.root, inspection: inconsistentInspection });
  assert.strictEqual(inconsistentPlan.status, 'BLOCKED', 'a required FAIL cannot be overridden by ready=true');

  expectCode(() => planner.createBuildPlan(job({ version: '8.8.8' }), { root: fixture.root, inspection: inspection }), 'VERSION_MISMATCH');

  const before = fs.readdirSync(path.join(fixture.root, 'dist'));
  assert.deepStrictEqual(fs.readdirSync(path.join(fixture.root, 'dist')), before);
  assert.strictEqual(fs.existsSync(path.join(fixture.root, 'tmp', 'installer-smoke-build')), false);
} finally {
  fixture.cleanup();
}

console.log('P35 build planner tests: PASS');
