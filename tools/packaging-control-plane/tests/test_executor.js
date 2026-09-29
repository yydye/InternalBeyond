'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const contract = require('../contract.js');
const planner = require('../build-planner.js');
const environmentInspector = require('../environment-inspector.js');
const validator = require('../artifact-validator.js');
const writer = require('../artifact-manifest-writer.js');
const executor = require('../executor.js');
const publicExecutor = require('../index.js').packagingExecutor;
const ownedProcess = require('../owned-process.js');
const { createArtifactFixture } = require('./artifact-fixture.js');

const fixedNow = () => new Date('2026-09-28T05:00:00.000Z');
let nextFakePid = 42000;

function processRecord(pid, parentPid, startTimeMs, name) {
  return {
    pid: pid,
    parentPid: parentPid,
    startTimeMs: startTimeMs,
    startTimeUtc: new Date(startTimeMs).toISOString(),
    name: name || 'node.exe'
  };
}

function fakeProcessAdapter(initial, onTerminate) {
  const state = { processes: initial.map((item) => Object.assign({}, item)), terminated: [] };
  return {
    state: state,
    listProcesses: async function () { return state.processes.map((item) => Object.assign({}, item)); },
    getProcess: async function (pid) {
      const found = state.processes.find((item) => item.pid === Number(pid));
      return found ? Object.assign({}, found) : null;
    },
    terminateProcess: async function (record) {
      const found = state.processes.find((item) => item.pid === record.pid);
      if (!ownedProcess.sameIdentity(found, record)) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
      state.terminated.push(record.pid);
      state.processes = state.processes.filter((item) => item.pid !== record.pid);
      if (onTerminate) onTerminate(record);
      return { ok: true, alreadyExited: false, exitTimeMs: Date.now() + 1000 };
    }
  };
}

async function verifyOwnedProcessTree() {
  const base = Date.now() - 5000;
  const root = processRecord(41001, 11, base, 'powershell.exe');
  const child = processRecord(41002, root.pid, base + 10, 'cargo.exe');
  const grandchild = processRecord(41003, child.pid, base + 20, 'rustc.exe');
  const unrelated = processRecord(41004, 11, base + 30, 'node.exe');
  const tooEarly = processRecord(41005, root.pid, base - 1, 'old-process.exe');
  const snapshot = [root, child, grandchild, unrelated, tooEarly];
  const tree = ownedProcess.collectOwnedTree(root, snapshot);
  assert.strictEqual(tree.ok, true);
  assert.deepStrictEqual(tree.records.map((item) => item.pid), [root.pid, child.pid, grandchild.pid]);

  const adapter = fakeProcessAdapter(snapshot);
  const terminated = await ownedProcess.terminateOwnedProcessTree(root, tree.records, adapter);
  assert.strictEqual(terminated.ok, true);
  assert.deepStrictEqual(adapter.state.terminated, [root.pid, child.pid, grandchild.pid]);
  assert.ok(adapter.state.processes.some((item) => item.pid === unrelated.pid));
  assert.ok(adapter.state.processes.some((item) => item.pid === tooEarly.pid));

  const reusedRoot = processRecord(root.pid, 11, base + 90000, 'powershell.exe');
  const reusedAdapter = fakeProcessAdapter([reusedRoot, unrelated]);
  const reused = await ownedProcess.terminateOwnedProcessTree(root, tree.records, reusedAdapter);
  assert.strictEqual(reused.ok, false, 'PID reuse must fail the captured start-time identity check');
  assert.deepStrictEqual(reusedAdapter.state.terminated, []);

  const workerStart = Date.now() - 100;
  const workerCapture = await ownedProcess.captureInspectorWorker(41007, process.pid, Date.now() - 1000, {
    getProcess: async () => Object.assign(
      processRecord(41007, process.pid, workerStart, path.basename(process.execPath)),
      { commandLine: process.execPath + ' tools/packaging-control-plane/inspector-worker.js {}' }
    )
  });
  assert.strictEqual(workerCapture.ok, true);

  if (process.platform === 'win32') {
    const captured = await ownedProcess.captureRootProcess(41006, process.pid, Date.now() - 1000, 'release', {
      getProcess: async () => processRecord(41006, process.pid, Date.now() - 100, 'powershell.exe') && Object.assign(
        processRecord(41006, process.pid, Date.now() - 100, 'powershell.exe'),
        { commandLine: 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-installer.ps1' }
      )
    });
    assert.strictEqual(captured.ok, true);
  }
}

function makeInspection(fixture, mode, patch) {
  return Object.assign({
    ready: true,
    target: 'windows-installer',
    mode: mode,
    repository: { revision: fixture.revision, dirty: false },
    checks: [{ name: 'synthetic-preflight', status: 'PASS', required: true }]
  }, patch || {});
}

function makeHarness(fixture, options) {
  const config = options || {};
  const mode = config.mode || 'release';
  const job = {
    id: config.jobId || 'p35-executor-fixture',
    target: 'windows-installer', version: fixture.version,
    channel: mode === 'release' ? 'stable' : 'local', mode: mode, options: {}
  };
  const rootProcess = processRecord(nextFakePid++, process.pid, Date.now() - 10, 'powershell.exe');
  const processAdapter = fakeProcessAdapter([rootProcess], function (record) {
    if (record.pid === rootProcess.pid && config.onRootTerminated) config.onRootTerminated();
  });
  let completeBuild;
  const completion = new Promise((resolve) => { completeBuild = resolve; });
  const outcome = config.outcome || { code: 0, signal: null, spawnFailed: false };
  const handle = {
    pid: rootProcess.pid,
    ownershipReady: Promise.resolve({ ok: true, record: rootProcess }),
    completion: config.pending ? completion : Promise.resolve(outcome),
    hasExited: function () { return !config.pending || this._outcome !== null; },
    killRootHandle: function () { return true; },
    terminateOwnedTree: function (known) {
      if (config.pending) {
        config.pending = false;
        completeBuild({ code: null, signal: 'SIGTERM', spawnFailed: false });
      }
      return ownedProcess.terminateOwnedProcessTree(rootProcess, known, processAdapter);
    },
    _outcome: config.pending ? null : outcome
  };
  if (config.pending) {
    const original = handle.completion;
    handle.completion = original.then((result) => { handle._outcome = result; return result; });
  }
  const counters = { spawned: 0, validated: 0, wroteManifest: 0, plan: null, command: null };
  const dependencies = {
    processAdapter: processAdapter,
    inspectEnvironment: async (request) => makeInspection(fixture, request.mode, config.inspectionPatch),
    createBuildPlan: function (input, options) {
      const plan = planner.createBuildPlan(input, options);
      counters.plan = plan;
      return plan;
    },
    spawnBuild: function (plan) {
      counters.spawned++;
      counters.command = plan.steps.find((step) => step.id === 'build-installer').command;
      return handle;
    },
    measureArtifactIdentity: config.measureArtifactIdentity || validator.measureArtifactIdentity,
    validateArtifact: config.validateArtifact || function (request, options) {
      counters.validated++;
      return validator.validateArtifact(request, { root: options.root, adapters: fixture.adapters });
    },
    writeArtifactManifest: config.writeArtifactManifest || function (request, options) {
      counters.wroteManifest++;
      return writer.writeArtifactManifest(request, { root: options.root });
    }
  };
  return {
    fixture: fixture,
    job: job,
    rootProcess: rootProcess,
    processAdapter: processAdapter,
    handle: handle,
    completeBuild: completeBuild,
    counters: counters,
    dependencies: dependencies,
    execute: function (patch) {
      return executor.__test.executePackagingJobWithDependencies({ job: Object.assign({}, job, patch || {}) }, {
        root: fixture.root, now: fixedNow, dependencies: dependencies
      });
    }
  };
}

async function waitForState(jobId, expected) {
  for (let i = 0; i < 80; i++) {
    const snapshot = executor.getPackagingJobState(jobId);
    if (snapshot && snapshot.state === expected) return snapshot;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('job state did not reach ' + expected);
}

async function verifyTransitionsAndHappyPath() {
  assert.strictEqual(Object.prototype.hasOwnProperty.call(publicExecutor, '__test'), false,
    'dependency injection remains outside the public Control Plane API');
  assert.strictEqual(typeof publicExecutor.executePackagingJob, 'function');
  assert.strictEqual(executor.checkStateTransition('BUILDING', 'COMPLETE').code, 'INVALID_STATE_TRANSITION');
  assert.strictEqual(executor.checkStateTransition('BUILD_COMPLETE', 'COMPLETE').code, 'INVALID_STATE_TRANSITION');
  assert.strictEqual(executor.checkStateTransition('FAILED', 'BUILDING').code, 'INVALID_STATE_TRANSITION');
  assert.strictEqual(executor.checkStateTransition('BUILDING', 'BUILD_COMPLETE').ok, true);

  const fixture = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(fixture, { jobId: 'p35-executor-happy' });
    const result = await harness.execute();
    assert.strictEqual(result.status, 'COMPLETE');
    assert.strictEqual(result.failure, null);
    assert.strictEqual(result.validation.status, 'PASS');
    assert.strictEqual(result.manifest.status, 'WRITTEN');
    assert.strictEqual(result.artifact.sha256, fixture.artifactSha256);
    assert.strictEqual(harness.counters.spawned, 1);
    assert.deepStrictEqual(result.events.map((item) => item.state), [
      'CREATED', 'PREFLIGHT', 'PREFLIGHT', 'READY', 'BUILDING', 'BUILDING', 'BUILDING',
      'BUILD_COMPLETE', 'BUILD_COMPLETE', 'VALIDATING', 'VALIDATED', 'WRITING_MANIFEST', 'COMPLETE'
    ]);
    assert.strictEqual(result.build.exitCode, 0);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(fixture.root));
    assert.ok(!serialized.includes('stdout'));
    assert.ok(!serialized.includes('environment'));
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'artifactPath'));
  } finally { fixture.cleanup(); }
}

async function verifyPreflightAndPlannerGates() {
  const forgedRequest = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(forgedRequest, { jobId: 'p35-executor-no-command' });
    const result = await executor.__test.executePackagingJobWithDependencies({ job: harness.job, command: 'whoami.exe' }, {
      root: forgedRequest.root, now: fixedNow, dependencies: harness.dependencies
    });
    assert.strictEqual(result.failure.code, 'INVALID_REQUEST');
    assert.strictEqual(harness.counters.spawned, 0);
  } finally { forgedRequest.cleanup(); }

  const preflight = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(preflight, { jobId: 'p35-executor-preflight', inspectionPatch: { ready: false } });
    const result = await harness.execute();
    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(result.failure.code, 'PREFLIGHT_FAILED');
    assert.strictEqual(harness.counters.spawned, 0);
  } finally { preflight.cleanup(); }

  const dirty = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(dirty, {
      jobId: 'p35-executor-dirty',
      inspectionPatch: { repository: { revision: dirty.revision, dirty: true }, checks: [{ name: 'git', status: 'WARN' }] }
    });
    const result = await harness.execute();
    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(result.failure.code, 'RELEASE_NOT_ELIGIBLE');
    assert.strictEqual(harness.counters.spawned, 0);
  } finally { dirty.cleanup(); }

  const unsupported = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(unsupported, { jobId: 'p35-executor-unsupported' });
    const result = await harness.execute({ mode: 'debug', channel: 'local' });
    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(result.failure.code, 'BUILD_PLAN_NOT_EXECUTABLE');
    assert.strictEqual(harness.counters.spawned, 0);
  } finally { unsupported.cleanup(); }
}

async function verifyBuildArtifactAndValidationFailures() {
  const buildFailure = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(buildFailure, { jobId: 'p35-executor-build-fail', outcome: { code: 7, signal: null, spawnFailed: false } });
    const result = await harness.execute();
    assert.strictEqual(result.failure.code, 'BUILD_FAILED');
    assert.strictEqual(harness.counters.validated, 0);
    assert.strictEqual(harness.counters.wroteManifest, 0);
  } finally { buildFailure.cleanup(); }

  const spawnFailure = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(spawnFailure, { jobId: 'p35-executor-spawn-fail' });
    harness.dependencies.spawnBuild = function () {
      harness.counters.spawned++;
      return {
        pid: null,
        spawnFailed: true,
        ownershipReady: Promise.resolve({ ok: false }),
        completion: Promise.resolve({ code: null, signal: null, spawnFailed: true }),
        hasExited: function () { return true; },
        killRootHandle: function () { return false; }
      };
    };
    const result = await harness.execute();
    assert.strictEqual(result.failure.code, 'BUILD_SPAWN_FAILED');
    assert.strictEqual(harness.counters.validated, 0);
  } finally { spawnFailure.cleanup(); }

  const missingArtifact = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(missingArtifact, {
      jobId: 'p35-executor-missing',
      measureArtifactIdentity: function (root, mode, version) {
        if (harness.counters.spawned) fs.rmSync(missingArtifact.artifactPath, { force: true });
        return validator.measureArtifactIdentity(root, mode, version);
      }
    });
    const result = await harness.execute();
    assert.strictEqual(result.failure.code, 'ARTIFACT_NOT_FOUND_AFTER_BUILD');
    assert.strictEqual(harness.counters.validated, 0);
  } finally { missingArtifact.cleanup(); }

  const warned = createArtifactFixture({ mode: 'release' });
  try {
    fs.rmSync(path.join(warned.outputRoot, 'staging'), { recursive: true, force: true });
    const harness = makeHarness(warned, { jobId: 'p35-executor-warning' });
    const result = await harness.execute();
    assert.strictEqual(result.status, 'FAILED');
    assert.strictEqual(result.failure.code, 'VALIDATION_WARNINGS_NOT_ACCEPTED');
    assert.strictEqual(harness.counters.wroteManifest, 0);
  } finally { warned.cleanup(); }

  const validatorFail = createArtifactFixture({ mode: 'release' });
  try {
    fs.truncateSync(validatorFail.artifactPath, 1024);
    const harness = makeHarness(validatorFail, { jobId: 'p35-executor-validation-fail' });
    const result = await harness.execute();
    assert.strictEqual(result.failure.code, 'VALIDATION_FAILED');
    assert.strictEqual(harness.counters.wroteManifest, 0);
    fs.truncateSync(validatorFail.artifactPath, validatorFail.artifactSize);
    validatorFail.writeMetadata();
    const retry = makeHarness(validatorFail, { jobId: 'p35-executor-after-validation-fail' });
    assert.strictEqual((await retry.execute()).status, 'COMPLETE', 'validation failure must release the single-flight lock');
  } finally { validatorFail.cleanup(); }

  const identityMismatch = createArtifactFixture({ mode: 'release' });
  const other = createArtifactFixture({ mode: 'release' });
  try {
    const descriptor = fs.openSync(other.artifactPath, 'r+');
    try { fs.writeSync(descriptor, Buffer.from('X'), 0, 1, 0); } finally { fs.closeSync(descriptor); }
    other.writeMetadata();
    const alternateResult = validator.validateArtifact(other.request(), { root: other.root, adapters: other.adapters });
    assert.strictEqual(alternateResult.status, 'PASS');
    const harness = makeHarness(identityMismatch, {
      jobId: 'p35-executor-identity-mismatch',
      validateArtifact: function () { return alternateResult; }
    });
    const result = await harness.execute();
    assert.strictEqual(result.failure.code, 'ARTIFACT_IDENTITY_FAILED');
    assert.strictEqual(harness.counters.wroteManifest, 0);
  } finally { identityMismatch.cleanup(); other.cleanup(); }
}

async function verifyManifestFailureAndFinalizationMutation() {
  const conflictFixture = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(conflictFixture, {
      jobId: 'p35-executor-manifest-conflict',
      writeArtifactManifest: function () {
        return { status: 'DENIED', code: 'MANIFEST_ALREADY_EXISTS_CONFLICT', manifest: null };
      }
    });
    const result = await harness.execute();
    assert.strictEqual(result.failure.code, 'MANIFEST_ALREADY_EXISTS_CONFLICT');
    assert.strictEqual(result.status, 'FAILED');

    const retry = makeHarness(conflictFixture, { jobId: 'p35-executor-manifest-retry' });
    const retried = await retry.execute();
    assert.strictEqual(retried.status, 'COMPLETE', 'manifest failure must release the single-flight lock');
  } finally { conflictFixture.cleanup(); }

  const identicalFixture = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(identicalFixture, {
      jobId: 'p35-executor-manifest-identical',
      writeArtifactManifest: function () {
        return {
          status: 'ALREADY_IDENTICAL',
          manifest: { name: identicalFixture.artifactName + '.manifest.json', sha256: 'a'.repeat(64) }
        };
      }
    });
    const result = await harness.execute();
    assert.strictEqual(result.status, 'COMPLETE');
    assert.strictEqual(result.manifest.status, 'ALREADY_IDENTICAL');
  } finally { identicalFixture.cleanup(); }

  const mutated = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(mutated, {
      jobId: 'p35-executor-postwrite-mutation',
      validateArtifact: function (request, options) {
        const result = validator.validateArtifact(request, { root: options.root, adapters: mutated.adapters });
        fs.writeFileSync(mutated.artifactPath, Buffer.from('changed after synthetic validation'));
        return result;
      }
    });
    const result = await harness.execute();
    assert.strictEqual(result.failure.code, 'ARTIFACT_CHANGED_DURING_FINALIZATION');
    assert.strictEqual(result.status, 'FAILED');
    assert.ok(result.manifest, 'a committed sidecar remains available for inspection after the final identity failure');
  } finally { mutated.cleanup(); }
}

async function verifyCancellationAndConcurrency() {
  const beforeBuild = createArtifactFixture({ mode: 'release' });
  try {
    let resolveInspection;
    const inspectionPromise = new Promise((resolve) => { resolveInspection = resolve; });
    const harness = makeHarness(beforeBuild, {
      jobId: 'p35-executor-cancel-preflight',
      inspection: null
    });
    harness.dependencies.inspectEnvironment = function () { return inspectionPromise; };
    const completion = harness.execute();
    await waitForState(harness.job.id, 'PREFLIGHT');
    const cancelled = await executor.cancelPackagingJob(harness.job.id);
    assert.strictEqual(cancelled.status, 'CANCELLED');
    resolveInspection(makeInspection(beforeBuild, 'release'));
    const result = await completion;
    assert.strictEqual(result.status, 'CANCELLED');
    assert.strictEqual(harness.counters.spawned, 0);
  } finally { beforeBuild.cleanup(); }

  const preflightWorker = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(preflightWorker, { jobId: 'p35-executor-cancel-inspector' });
    delete harness.dependencies.inspectEnvironment;
    const root = processRecord(43001, process.pid, Date.now() - 20, 'node.exe');
    harness.processAdapter.state.processes = [root];
    let finishWorker;
    let workerOutcome = null;
    let workerStarted = false;
    const completion = new Promise((resolve) => { finishWorker = resolve; });
    harness.dependencies.startInspector = function () {
      return {
        pid: root.pid,
        spawnFailed: false,
        started: false,
        ownershipReady: Promise.resolve({ ok: true, record: root }),
        completion: completion,
        hasExited: function () { return workerOutcome !== null; },
        start: function () { this.started = true; workerStarted = true; return true; },
        killRootHandle: function () { return true; },
        terminateOwnedTree: async function (known) {
          const stopped = await ownedProcess.terminateOwnedProcessTree(root, known, harness.processAdapter);
          if (stopped.ok && !workerOutcome) {
            workerOutcome = { code: null, signal: 'SIGTERM', spawnFailed: false, output: '', overflow: false };
            finishWorker(workerOutcome);
          }
          return stopped;
        }
      };
    };
    const execution = harness.execute();
    await waitForState(harness.job.id, 'PREFLIGHT');
    for (let i = 0; i < 80 && !workerStarted; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.strictEqual(workerStarted, true);
    const state = executor.getPackagingJobState(harness.job.id);
    assert.strictEqual(state.state, 'PREFLIGHT');
    const cancelled = await executor.cancelPackagingJob(harness.job.id);
    assert.strictEqual(cancelled.status, 'CANCELLED', JSON.stringify({ cancelled: cancelled, state: executor.getPackagingJobState(harness.job.id) }));
    assert.strictEqual((await execution).status, 'CANCELLED');
    assert.strictEqual(harness.counters.spawned, 0);
    assert.deepStrictEqual(harness.processAdapter.state.terminated, [root.pid]);
  } finally { preflightWorker.cleanup(); }

  const duringBuild = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(duringBuild, { jobId: 'p35-executor-cancel-build', pending: true });
    const completion = harness.execute();
    await waitForState(harness.job.id, 'BUILDING');
    const firstCancelPromise = executor.cancelPackagingJob(harness.job.id);
    const duplicateCancel = await executor.cancelPackagingJob(harness.job.id);
    assert.strictEqual(duplicateCancel.status, 'CANCELLING');
    const firstCancel = await firstCancelPromise;
    assert.strictEqual(firstCancel.status, 'CANCELLED');
    const result = await completion;
    assert.strictEqual(result.status, 'CANCELLED');
    assert.deepStrictEqual(harness.processAdapter.state.terminated, [harness.rootProcess.pid]);
    assert.strictEqual((await executor.cancelPackagingJob(harness.job.id)).status, 'ALREADY_TERMINAL');

    const retry = makeHarness(duringBuild, { jobId: 'p35-executor-after-cancel' });
    assert.strictEqual((await retry.execute()).status, 'COMPLETE', 'cancellation must release the single-flight lock');
  } finally { duringBuild.cleanup(); }

  const tooLate = createArtifactFixture({ mode: 'release' });
  try {
    let resolveValidation;
    const validationPromise = new Promise((resolve) => { resolveValidation = resolve; });
    const harness = makeHarness(tooLate, {
      jobId: 'p35-executor-cancel-late',
      validateArtifact: function (request, options) {
        return validator.validateArtifact(request, { root: options.root, adapters: tooLate.adapters });
      }
    });
    const originalValidate = harness.dependencies.validateArtifact;
    harness.dependencies.validateArtifact = async function () {
      const result = await originalValidate.apply(null, arguments);
      await validationPromise;
      return result;
    };
    const completion = harness.execute();
    await waitForState(harness.job.id, 'VALIDATING');
    const denied = await executor.cancelPackagingJob(harness.job.id);
    assert.strictEqual(denied.code, 'CANCELLATION_TOO_LATE');
    resolveValidation();
    const result = await completion;
    assert.strictEqual(result.status, 'COMPLETE');
  } finally { tooLate.cleanup(); }

  const naturalRace = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(naturalRace, { jobId: 'p35-executor-natural-race', pending: true });
    const completion = harness.execute();
    await waitForState(harness.job.id, 'BUILDING');
    const naturalExit = { code: 0, signal: null, spawnFailed: false };
    harness.handle._outcome = naturalExit;
    const cancellation = executor.cancelPackagingJob(harness.job.id);
    harness.completeBuild(naturalExit);
    const denied = await cancellation;
    assert.strictEqual(denied.code, 'CANCELLATION_TOO_LATE');
    assert.strictEqual((await completion).status, 'COMPLETE');
  } finally { naturalRace.cleanup(); }

  const busy = createArtifactFixture({ mode: 'release' });
  try {
    const harness = makeHarness(busy, { jobId: 'p35-executor-lock-first', pending: true });
    const first = harness.execute();
    await waitForState(harness.job.id, 'BUILDING');
    const second = await executor.__test.executePackagingJobWithDependencies({
      job: Object.assign({}, harness.job, { id: 'p35-executor-lock-second' })
    }, { root: busy.root, now: fixedNow, dependencies: harness.dependencies });
    assert.strictEqual(second.failure.code, 'PACKAGING_BUSY');
    assert.strictEqual(harness.counters.spawned, 1);
    harness.completeBuild({ code: 9, signal: null, spawnFailed: false });
    const firstResult = await first;
    assert.strictEqual(firstResult.failure.code, 'BUILD_FAILED');

    const third = await executor.__test.executePackagingJobWithDependencies({
      job: Object.assign({}, harness.job, { id: 'p35-executor-lock-third' })
    }, { root: busy.root, now: fixedNow, dependencies: harness.dependencies });
    assert.strictEqual(third.failure.code, 'BUILD_FAILED');
    assert.strictEqual(harness.counters.spawned, 2, 'the single-flight lock must be released after build failure');
  } finally { busy.cleanup(); }
}

async function verifyTestModeDelegate() {
  const fixture = createArtifactFixture({ mode: 'test' });
  try {
    const harness = makeHarness(fixture, { mode: 'test', jobId: 'p35-executor-test-mode' });
    const result = await harness.execute();
    assert.strictEqual(harness.counters.command.executable, 'powershell.exe');
    assert.deepStrictEqual(harness.counters.command.arguments.slice(-1), ['-TestMode']);
    assert.strictEqual(harness.counters.plan.artifact.outputRoot, 'tmp/installer-smoke-build');
    assert.strictEqual(result.failure.code, 'VALIDATION_WARNINGS_NOT_ACCEPTED');
    assert.strictEqual(harness.counters.wroteManifest, 0);
  } finally { fixture.cleanup(); }
}

async function main() {
  await verifyOwnedProcessTree();
  await verifyTransitionsAndHappyPath();
  await verifyPreflightAndPlannerGates();
  await verifyBuildArtifactAndValidationFailures();
  await verifyManifestFailureAndFinalizationMutation();
  await verifyCancellationAndConcurrency();
  await verifyTestModeDelegate();
}

main().then(() => console.log('P35 executor tests: PASS')).catch((error) => {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exitCode = 1;
});
