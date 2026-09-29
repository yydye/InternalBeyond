'use strict';

/* P35.5 orchestration only. The canonical build remains
   scripts/build-installer.ps1 → installer/InternalBeyond.iss → Inno Setup. */

const childProcess = require('child_process');
const path = require('path');

const contract = require('./contract.js');
const environmentInspector = require('./environment-inspector.js');
const buildPlanner = require('./build-planner.js');
const artifactValidator = require('./artifact-validator.js');
const artifactManifestWriter = require('./artifact-manifest-writer.js');
const ownedProcess = require('./owned-process.js');

const RESULT_SCHEMA = 'internalbeyond.packaging-execution-result';
const STATES = Object.freeze([
  'CREATED', 'PREFLIGHT', 'READY', 'BUILDING', 'BUILD_COMPLETE', 'VALIDATING',
  'VALIDATED', 'WRITING_MANIFEST', 'COMPLETE', 'FAILED', 'CANCELLING', 'CANCELLED'
]);
const TERMINAL_STATES = new Set(['COMPLETE', 'FAILED', 'CANCELLED']);
const TRANSITIONS = Object.freeze({
  CREATED: Object.freeze(['PREFLIGHT', 'FAILED', 'CANCELLED']),
  PREFLIGHT: Object.freeze(['READY', 'CANCELLING', 'FAILED', 'CANCELLED']),
  READY: Object.freeze(['BUILDING', 'FAILED', 'CANCELLED']),
  BUILDING: Object.freeze(['BUILD_COMPLETE', 'CANCELLING', 'FAILED']),
  BUILD_COMPLETE: Object.freeze(['VALIDATING', 'FAILED']),
  VALIDATING: Object.freeze(['VALIDATED', 'FAILED']),
  VALIDATED: Object.freeze(['WRITING_MANIFEST', 'FAILED']),
  WRITING_MANIFEST: Object.freeze(['COMPLETE', 'FAILED']),
  CANCELLING: Object.freeze(['CANCELLED', 'FAILED']),
  COMPLETE: Object.freeze([]),
  FAILED: Object.freeze([]),
  CANCELLED: Object.freeze([])
});

const jobs = new Map();
let activeBuildJobId = null;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyJobRequestFields(request) {
  if (!isPlainObject(request)) return false;
  for (const key of Reflect.ownKeys(request)) {
    if (key !== 'job' || typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(request, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) return false;
  }
  return Object.prototype.hasOwnProperty.call(request, 'job');
}

function checkStateTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to) || !TRANSITIONS[from].includes(to)) {
    return { ok: false, code: 'INVALID_STATE_TRANSITION', from: String(from), to: String(to) };
  }
  return { ok: true, from: from, to: to };
}

function nowIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function publicJob(job) {
  return {
    id: job.id,
    target: job.target,
    version: job.version,
    channel: job.channel,
    mode: job.mode,
    options: { includeDocs: job.options.includeDocs, includeExamples: job.options.includeExamples }
  };
}

function makeRecord(job, now) {
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
  return {
    id: job.id,
    job: publicJob(job),
    state: 'CREATED',
    createdAt: nowIso(now),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    events: [],
    inspectionSummary: null,
    planSummary: null,
    buildContext: null,
    preflightExitCode: null,
  buildExitCode: null,
  buildResult: null,
    artifactIdentity: null,
    validationSummary: null,
    manifestSummary: null,
    failure: null,
    result: null,
    processHandle: null,
    processPhase: null,
    processRoot: null,
    processMonitor: null,
    processRoots: [],
    processOwnershipCaptured: false,
    ownedProcess: [],
    lockHeld: false,
    buildOutcomeApplied: false,
    cancelPromise: null,
    terminalPromise: terminalPromise,
    resolveTerminal: resolveTerminal,
    resolveCompletion: null,
    now: now
  };
}

function logEvent(record, event, extra) {
  const item = {
    timestamp: nowIso(record.now),
    jobId: record.id,
    state: record.state,
    event: event
  };
  if (extra && Object.prototype.hasOwnProperty.call(extra, 'exitCode')) {
    item.exitCode = Number.isInteger(extra.exitCode) ? extra.exitCode : null;
  }
  record.events.push(item);
  return item;
}

function transitionRecord(record, nextState, event, extra) {
  const checked = checkStateTransition(record.state, nextState);
  if (!checked.ok) return checked;
  record.state = nextState;
  if (nextState === 'BUILDING' && !record.startedAt) record.startedAt = nowIso(record.now);
  logEvent(record, event || ('STATE_' + nextState), extra);
  return { ok: true, state: nextState };
}

function normalizedFailure(code) {
  const messages = {
    INVALID_REQUEST: 'PackagingExecutionRequest was rejected.',
    PREFLIGHT_FAILED: 'Environment preflight did not pass.',
    BUILD_PLAN_NOT_EXECUTABLE: 'Build Planner did not provide the approved canonical delegate.',
    RELEASE_NOT_ELIGIBLE: 'The current release plan is not eligible under the Planner policy.',
    PACKAGING_BUSY: 'Another installer job is active in this Executor process.',
    BUILD_SPAWN_FAILED: 'The canonical build delegate could not be started.',
    BUILD_FAILED: 'The canonical build delegate exited unsuccessfully.',
    BUILD_CANCELLED: 'The owned canonical build process tree was cancelled.',
    ARTIFACT_NOT_FOUND_AFTER_BUILD: 'The expected artifact was not found after a successful build.',
    ARTIFACT_IDENTITY_FAILED: 'The expected artifact identity could not be frozen consistently.',
    VALIDATION_FAILED: 'Artifact Validator did not return a valid complete PASS.',
    VALIDATION_WARNINGS_NOT_ACCEPTED: 'Artifact Validator returned PASS_WITH_WARNINGS; finalization is denied.',
    MANIFEST_WRITE_FAILED: 'Artifact Manifest Writer did not complete successfully.',
    ARTIFACT_CHANGED_DURING_FINALIZATION: 'Artifact size or SHA-256 changed during finalization.',
    EXECUTOR_INTERNAL_ERROR: 'Packaging Executor stopped after an internal orchestration error.',
    INVALID_STATE_TRANSITION: 'An invalid Packaging Job state transition was rejected.',
    PROCESS_OWNERSHIP_FAILED: 'The owned process tree could not be safely confirmed or terminated.',
    MANIFEST_ALREADY_EXISTS_CONFLICT: 'A different Artifact Manifest sidecar already exists and was not replaced.'
  };
  return { code: code, message: messages[code] || 'Packaging execution failed.' };
}

function releaseBuildLock(record) {
  if (record.lockHeld && activeBuildJobId === record.id) activeBuildJobId = null;
  record.lockHeld = false;
}

function mergeOwnedProcessRecords(record, items) {
  const known = new Set(record.ownedProcess.map((item) => String(item.pid) + ':' + String(item.startTimeMs)));
  for (const item of items || []) {
    const key = String(item.pid) + ':' + String(item.startTimeMs);
    if (known.has(key)) continue;
    known.add(key);
    record.ownedProcess.push(Object.assign({}, item));
  }
}

function clearActiveProcess(record) {
  record.processHandle = null;
  record.processPhase = null;
  record.processRoot = null;
  record.processMonitor = null;
}

function executionResult(record) {
  return {
    schema: RESULT_SCHEMA,
    schemaVersion: 1,
    status: record.state,
    job: record.job ? publicJob(record.job) : null,
    build: record.buildResult ? Object.assign({}, record.buildResult) : null,
    artifact: record.artifactIdentity ? Object.assign({}, record.artifactIdentity) : null,
    validation: record.validationSummary ? {
      status: record.validationSummary.status,
      valid: record.validationSummary.valid,
      summary: Object.assign({}, record.validationSummary.summary)
    } : null,
    manifest: record.manifestSummary ? Object.assign({}, record.manifestSummary) : null,
    failure: record.failure ? Object.assign({}, record.failure) : null,
    events: record.events.map((item) => Object.assign({}, item))
  };
}

function sealTerminal(record) {
  if (record.result || !TERMINAL_STATES.has(record.state)) return record.result;
  record.finishedAt = nowIso(record.now);
  record.result = executionResult(record);
  releaseBuildLock(record);
  record.resolveTerminal(record.result);
  if (record.resolveCompletion) record.resolveCompletion(record.result);
  return record.result;
}

function failRecord(record, code) {
  if (TERMINAL_STATES.has(record.state)) return record.result;
  const moved = transitionRecord(record, 'FAILED', 'JOB_FAILED');
  if (!moved.ok) {
    record.failure = normalizedFailure('INVALID_STATE_TRANSITION');
    return null;
  }
  record.failure = normalizedFailure(code);
  return sealTerminal(record);
}

function cancelBeforeBuild(record) {
  if (TERMINAL_STATES.has(record.state)) return record.result;
  if (record.processMonitor) {
    mergeOwnedProcessRecords(record, record.processMonitor.records());
    record.processMonitor.stop();
  }
  clearActiveProcess(record);
  const moved = transitionRecord(record, 'CANCELLED', 'JOB_CANCELLED_BEFORE_BUILD');
  if (!moved.ok) return null;
  record.cancelRequested = true;
  record.failure = normalizedFailure('BUILD_CANCELLED');
  return sealTerminal(record);
}

function sameArtifactIdentity(left, right) {
  return !!left && !!right && left.name === right.name && left.size === right.size && left.sha256 === right.sha256;
}

function packagingJobInput(job) {
  return {
    id: job.id,
    target: job.target,
    version: job.version,
    channel: job.channel,
    mode: job.mode,
    options: { includeDocs: job.options.includeDocs, includeExamples: job.options.includeExamples }
  };
}

function expectedBuildArguments(mode) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/build-installer.ps1'];
  if (mode === 'test') args.push('-TestMode');
  return args;
}

function verifyBuildPlan(plan, requestJob, inspection) {
  if (!plan || plan.schema !== 'internalbeyond.build-plan' || plan.schemaVersion !== 1 ||
      plan.executes !== false || plan.publication !== 'not-included' ||
      !['READY', 'READY_WITH_WARNINGS'].includes(plan.status) || !Array.isArray(plan.steps) ||
      !plan.artifact || typeof plan.artifact !== 'object') {
    return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' };
  }
  let job;
  try { job = contract.resolveJobVersion(requestJob, plan.version); }
  catch (_) { return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' }; }
  if (job.target !== 'windows-installer' || !['release', 'test'].includes(job.mode) ||
      plan.jobId !== job.id || plan.target !== job.target || plan.mode !== job.mode ||
      plan.channel !== job.channel || plan.version !== job.version ||
      plan.artifact.outputRoot !== artifactValidator.OUTPUT_ROOTS[job.mode] ||
      !inspection || inspection.ready !== true || inspection.target !== job.target || inspection.mode !== job.mode) {
    return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' };
  }
  const expectedIds = [
    'environment-check', 'prepare-staging', 'stage-tauri-host', 'audit-staged-payload',
    'compile-inno-installer', 'build-installer', 'validate-artifact'
  ];
  if (plan.steps.length !== expectedIds.length || plan.steps.some((step, i) => !step || step.id !== expectedIds[i])) {
    return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' };
  }
  if (plan.steps[0].type !== 'inspection' || plan.steps[0].status !== 'PASS' ||
      plan.steps[1].type !== 'delegated-substep' || plan.steps[1].owner !== 'scripts/build-installer.ps1' || plan.steps[1].status !== 'PLANNED' ||
      plan.steps[2].type !== 'delegated-substep' || plan.steps[2].owner !== 'scripts/build-installer.ps1' || plan.steps[2].status !== 'PLANNED' ||
      plan.steps[3].type !== 'delegated-substep' || plan.steps[3].owner !== 'scripts/build-installer.ps1' || plan.steps[3].status !== 'PLANNED' ||
      plan.steps[4].type !== 'delegated-substep' || plan.steps[4].owner !== 'scripts/build-installer.ps1' || plan.steps[4].status !== 'PLANNED' ||
      plan.steps[6].type !== 'verification' || plan.steps[6].status !== 'PLANNED' ||
      !plan.artifact || plan.artifact.validated !== false || plan.artifact.manifestSchema !== 'internalbeyond.artifact-manifest@1') {
    return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' };
  }
  const delegate = plan.steps[5];
  const wantedArgs = expectedBuildArguments(job.mode);
  if (delegate.type !== 'delegate' || delegate.status !== 'PLANNED' ||
      !delegate.command || delegate.command.executable !== 'powershell.exe' ||
      JSON.stringify(delegate.command.arguments) !== JSON.stringify(wantedArgs) ||
      delegate.outputRoot !== plan.artifact.outputRoot) {
    return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' };
  }
  if (plan.steps.some((step, i) => i !== 5 && Object.prototype.hasOwnProperty.call(step, 'command'))) {
    return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' };
  }
  const repository = inspection.repository || {};
  const revision = typeof repository.revision === 'string' ? repository.revision : 'unknown';
  if (plan.sourceRevision !== revision || plan.sourceDirty !== (repository.dirty === true)) {
    return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' };
  }
  if (job.mode === 'release') {
    if (plan.releaseEligible !== true || repository.dirty !== false ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) {
      return { ok: false, code: 'RELEASE_NOT_ELIGIBLE' };
    }
  } else if (plan.releaseEligible !== false) {
    return { ok: false, code: 'BUILD_PLAN_NOT_EXECUTABLE' };
  }
  return { ok: true, job: packagingJobInput(job), revision: revision, dirty: typeof repository.dirty === 'boolean' ? repository.dirty : null };
}

function startCanonicalBuild(plan, context) {
  const delegate = plan.steps[5];
  const spawnedAtMs = Date.now();
  let child;
  let spawnError = false;
  let processExitOutcome = null;
  let completionOutcome = null;
  let rootRecord = null;
  let rootCapture = Promise.resolve({ ok: false, code: 'PROCESS_OWNERSHIP_FAILED' });
  try {
    child = childProcess.spawn(delegate.command.executable, delegate.command.arguments, {
      cwd: context.root,
      env: context.environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (_) {
    return {
      pid: null,
      spawnFailed: true,
      ownershipReady: Promise.resolve({ ok: false, code: 'PROCESS_OWNERSHIP_FAILED' }),
      completion: Promise.resolve({ code: null, signal: null, spawnFailed: true }),
      hasExited: function () { return true; },
      killRootHandle: function () { return false; },
      terminateOwnedTree: async function () { return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' }; }
    };
  }
  const drain = function (stream) {
    if (stream && typeof stream.on === 'function') stream.on('data', function () { /* Drain, never persist raw build output. */ });
  };
  drain(child.stdout);
  drain(child.stderr);
  const completion = new Promise((resolve) => {
    child.on('error', function () {
      spawnError = true;
      processExitOutcome = { code: null, signal: null, spawnFailed: true };
    });
    child.on('exit', function (code, signal) {
      processExitOutcome = { code: Number.isInteger(code) ? code : null, signal: signal || null, spawnFailed: spawnError };
    });
    child.on('close', function (code, signal) {
      completionOutcome = { code: Number.isInteger(code) ? code : null, signal: signal || null, spawnFailed: spawnError };
      resolve(completionOutcome);
    });
  });
  if (Number.isInteger(child.pid) && context.processAdapter) {
    try {
      rootCapture = Promise.resolve(ownedProcess.captureRootProcess(child.pid, process.pid, spawnedAtMs, plan.mode, context.processAdapter))
        .catch(() => ({ ok: false, code: 'PROCESS_OWNERSHIP_FAILED' }));
    } catch (_) { rootCapture = Promise.resolve({ ok: false, code: 'PROCESS_OWNERSHIP_FAILED' }); }
    rootCapture.then((value) => { if (value && value.ok) rootRecord = value.record; }).catch(() => {});
  }
  return {
    pid: child.pid || null,
    spawnFailed: false,
    ownershipReady: rootCapture,
    completion: completion,
    hasExited: function () { return processExitOutcome !== null || completionOutcome !== null; },
    killRootHandle: function () { try { return !!child.kill(); } catch (_) { return false; } },
    terminateOwnedTree: async function (known) {
      const captured = await rootCapture;
      if (!captured || captured.ok !== true || !rootRecord) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
      return ownedProcess.terminateOwnedProcessTree(rootRecord, known, context.processAdapter);
    }
  };
}

function startEnvironmentInspectorWorker(request, context) {
  const workerFile = path.join(__dirname, 'inspector-worker.js');
  const payload = JSON.stringify({ root: context.root, target: request.target, mode: request.mode });
  const spawnedAtMs = Date.now();
  let child;
  let spawnError = false;
  let exited = false;
  let overflow = false;
  let output = '';
  const maxOutput = 2 * 1024 * 1024;
  try {
    child = childProcess.spawn(process.execPath, [workerFile, payload], {
      cwd: context.root,
      env: context.environment,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    });
  } catch (_) {
    return {
      pid: null, spawnFailed: true, started: false,
      ownershipReady: Promise.resolve({ ok: false, code: 'PROCESS_OWNERSHIP_FAILED' }),
      completion: Promise.resolve({ code: null, signal: null, spawnFailed: true, output: '', overflow: false }),
      hasExited: function () { return true; },
      start: function () { return false; },
      killRootHandle: function () { return false; },
      terminateOwnedTree: async function () { return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' }; }
    };
  }
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (chunk) {
      if (output.length + chunk.length > maxOutput) { overflow = true; return; }
      output += chunk;
    });
  }
  if (child.stderr) child.stderr.on('data', function () { /* No raw preflight output is retained. */ });
  const completion = new Promise((resolve) => {
    child.on('error', function () { spawnError = true; });
    child.on('exit', function () { exited = true; });
    child.on('close', function (code, signal) {
      exited = true;
      resolve({ code: Number.isInteger(code) ? code : null, signal: signal || null,
        spawnFailed: spawnError, output: output, overflow: overflow });
    });
  });
  const ownershipReady = Number.isInteger(child.pid)
    ? ownedProcess.captureInspectorWorker(child.pid, process.pid, spawnedAtMs, context.processAdapter)
        .catch(() => ({ ok: false, code: 'PROCESS_OWNERSHIP_FAILED' }))
    : Promise.resolve({ ok: false, code: 'PROCESS_OWNERSHIP_FAILED' });
  return {
    pid: child.pid || null,
    spawnFailed: false,
    started: false,
    ownershipReady: ownershipReady,
    completion: completion,
    hasExited: function () { return exited; },
    start: function () {
      if (this.started) return false;
      this.started = true;
      try { child.stdin.end('GO\n'); return true; } catch (_) { return false; }
    },
    killRootHandle: function () { try { return !!child.kill(); } catch (_) { return false; } },
    terminateOwnedTree: async function (known) {
      const captured = await ownershipReady;
      if (!captured || captured.ok !== true) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
      return ownedProcess.terminateOwnedProcessTree(captured.record, known, context.processAdapter);
    }
  };
}

function releaseContext(record) {
  const buildContext = record.buildContext || {};
  return {
    revision: typeof buildContext.revision === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(buildContext.revision)
      ? buildContext.revision : '',
    dirty: typeof buildContext.dirty === 'boolean' ? buildContext.dirty : null
  };
}

function markBuildOutcome(record, outcome) {
  if (record.buildOutcomeApplied) return record.state;
  record.buildOutcomeApplied = true;
  record.buildExitCode = Number.isInteger(outcome && outcome.code) ? outcome.code : null;
  record.buildResult = {
    exitCode: record.buildExitCode,
    signal: outcome && typeof outcome.signal === 'string' ? outcome.signal : null,
    spawnFailed: !!(outcome && outcome.spawnFailed)
  };
  logEvent(record, 'BUILD_PROCESS_EXITED', { exitCode: record.buildExitCode });
  if (record.state !== 'BUILDING') return record.state;
  if (!outcome || outcome.spawnFailed) {
    failRecord(record, 'BUILD_SPAWN_FAILED');
    return record.state;
  }
  if (outcome.code !== 0 || outcome.signal) {
    failRecord(record, 'BUILD_FAILED');
    return record.state;
  }
  const moved = transitionRecord(record, 'BUILD_COMPLETE', 'BUILD_COMPLETE');
  if (!moved.ok) failRecord(record, 'INVALID_STATE_TRANSITION');
  return record.state;
}

function recordPreflightOutcome(record, outcome) {
  record.preflightExitCode = Number.isInteger(outcome && outcome.code) ? outcome.code : null;
  logEvent(record, 'PREFLIGHT_PROCESS_EXITED', { exitCode: record.preflightExitCode });
}

async function waitForTerminal(record) {
  if (record.result) return record.result;
  return record.terminalPromise;
}

async function runRecord(record, dependencies, root) {
  if (TERMINAL_STATES.has(record.state)) return;
  try {
    let moved = transitionRecord(record, 'PREFLIGHT', 'PREFLIGHT_STARTED');
    if (!moved.ok) { failRecord(record, 'INVALID_STATE_TRANSITION'); return; }
    let inspection;
    if (typeof dependencies.inspectEnvironment === 'function') {
      try { inspection = await dependencies.inspectEnvironment({ root: root, target: record.job.target, mode: record.job.mode }); }
      catch (_) { failRecord(record, 'PREFLIGHT_FAILED'); return; }
    } else {
      if (process.platform !== 'win32') { failRecord(record, 'PREFLIGHT_FAILED'); return; }
      let handle;
      try {
        handle = dependencies.startInspector({ target: record.job.target, mode: record.job.mode }, {
          root: root,
          environment: environmentInspector.createBuildEnvironment(),
          processAdapter: dependencies.processAdapter
        });
      } catch (_) { failRecord(record, 'PREFLIGHT_FAILED'); return; }
      if (!handle || !handle.ownershipReady || !handle.completion || typeof handle.start !== 'function' ||
          typeof handle.hasExited !== 'function' || typeof handle.killRootHandle !== 'function' ||
          typeof handle.terminateOwnedTree !== 'function') {
        failRecord(record, 'PREFLIGHT_FAILED');
        return;
      }
      record.processHandle = handle;
      record.processPhase = 'preflight';
      if (handle.spawnFailed === true || !Number.isInteger(handle.pid) || handle.pid <= 0) {
        const outcome = await handle.completion;
        if (TERMINAL_STATES.has(record.state)) return;
        if (record.state === 'CANCELLING') {
          await record.cancelPromise;
          if (!record.result) await waitForTerminal(record);
          return;
        }
        recordPreflightOutcome(record, outcome);
        clearActiveProcess(record);
        failRecord(record, 'PREFLIGHT_FAILED');
        return;
      }
      let ownership;
      try { ownership = await handle.ownershipReady; } catch (_) { ownership = null; }
      if (TERMINAL_STATES.has(record.state)) return;
      if (record.state === 'CANCELLING') {
        await record.cancelPromise;
        if (!record.result) await waitForTerminal(record);
        return;
      }
      if (!ownership || ownership.ok !== true || !ownership.record) {
        if (typeof handle.killRootHandle === 'function') handle.killRootHandle();
        const outcome = await handle.completion;
        if (TERMINAL_STATES.has(record.state)) return;
        if (record.state === 'CANCELLING') {
          await record.cancelPromise;
          if (!record.result) await waitForTerminal(record);
          return;
        }
        recordPreflightOutcome(record, outcome);
        clearActiveProcess(record);
        failRecord(record, outcome && outcome.spawnFailed ? 'PREFLIGHT_FAILED' : 'PROCESS_OWNERSHIP_FAILED');
        return;
      }
      record.processRoot = ownership.record;
      record.processOwnershipCaptured = true;
      record.processRoots.push(ownership.record);
      record.processMonitor = ownedProcess.createMonitor(ownership.record, dependencies.processAdapter);
      mergeOwnedProcessRecords(record, record.processMonitor.records());
      logEvent(record, 'PREFLIGHT_PROCESS_OWNERSHIP_CAPTURED');
      if (record.state === 'CANCELLING') {
        await record.cancelPromise;
        if (!record.result) await waitForTerminal(record);
        return;
      }
      if (handle.start() !== true) {
        if (typeof handle.killRootHandle === 'function') handle.killRootHandle();
        const outcome = await handle.completion;
        if (TERMINAL_STATES.has(record.state)) return;
        if (record.state === 'CANCELLING') {
          await record.cancelPromise;
          if (!record.result) await waitForTerminal(record);
          return;
        }
        recordPreflightOutcome(record, outcome);
        await record.processMonitor.refresh();
        mergeOwnedProcessRecords(record, record.processMonitor.records());
        record.processMonitor.stop();
        clearActiveProcess(record);
        failRecord(record, 'PREFLIGHT_FAILED');
        return;
      }
      const outcome = await handle.completion;
      if (TERMINAL_STATES.has(record.state)) return;
      if (record.state === 'CANCELLING') {
        await record.cancelPromise;
        if (!record.result) await waitForTerminal(record);
        return;
      }
      recordPreflightOutcome(record, outcome);
      await record.processMonitor.refresh();
      mergeOwnedProcessRecords(record, record.processMonitor.records());
      record.processMonitor.stop();
      clearActiveProcess(record);
      if (!outcome || outcome.spawnFailed || outcome.code !== 0 || outcome.signal || outcome.overflow) {
        failRecord(record, 'PREFLIGHT_FAILED');
        return;
      }
      try { inspection = JSON.parse(outcome.output); }
      catch (_) { failRecord(record, 'PREFLIGHT_FAILED'); return; }
    }
    if (TERMINAL_STATES.has(record.state)) return;
    if (!inspection || typeof inspection.ready !== 'boolean' || inspection.target !== record.job.target ||
        inspection.mode !== record.job.mode || !Array.isArray(inspection.checks) ||
        inspection.checks.some((item) => !item || typeof item.name !== 'string' || !['PASS', 'WARN', 'FAIL'].includes(item.status))) {
      failRecord(record, 'PREFLIGHT_FAILED');
      return;
    }
    record.inspectionSummary = {
      ready: !!(inspection && inspection.ready),
      pass: inspection && Array.isArray(inspection.checks) ? inspection.checks.filter((item) => item.status === 'PASS').length : 0,
      warn: inspection && Array.isArray(inspection.checks) ? inspection.checks.filter((item) => item.status === 'WARN').length : 0,
      fail: inspection && Array.isArray(inspection.checks) ? inspection.checks.filter((item) => item.status === 'FAIL').length : 0
    };
    logEvent(record, 'PREFLIGHT_CHECKED');
    await new Promise((resolve) => setImmediate(resolve));
    if (TERMINAL_STATES.has(record.state)) return;

    let plan;
    try { plan = await dependencies.createBuildPlan(record.job, { root: root, inspection: inspection }); }
    catch (_) {
      failRecord(record, inspection && inspection.ready === false ? 'PREFLIGHT_FAILED' : 'BUILD_PLAN_NOT_EXECUTABLE');
      return;
    }
    record.planSummary = plan ? {
      status: plan.status || 'INVALID', releaseEligible: plan.releaseEligible === true,
      mode: plan.mode || '', version: plan.version || '', sourceDirty: plan.sourceDirty === true
    } : { status: 'INVALID', releaseEligible: false, mode: '', version: '', sourceDirty: null };
    if (TERMINAL_STATES.has(record.state)) return;
    if (!inspection || inspection.ready !== true) {
      failRecord(record, 'PREFLIGHT_FAILED');
      return;
    }
    const planCheck = verifyBuildPlan(plan, record.job, inspection);
    if (!planCheck.ok) {
      failRecord(record, planCheck.code);
      return;
    }
    record.job = planCheck.job;
    record.buildContext = { revision: planCheck.revision, dirty: planCheck.dirty };
    moved = transitionRecord(record, 'READY', 'BUILD_PLAN_READY');
    if (!moved.ok) { failRecord(record, 'INVALID_STATE_TRANSITION'); return; }
    await new Promise((resolve) => setImmediate(resolve));
    if (TERMINAL_STATES.has(record.state)) return;
    if (activeBuildJobId !== null) {
      failRecord(record, 'PACKAGING_BUSY');
      return;
    }
    activeBuildJobId = record.id;
    record.lockHeld = true;
    moved = transitionRecord(record, 'BUILDING', 'BUILD_STARTED');
    if (!moved.ok) { failRecord(record, 'INVALID_STATE_TRANSITION'); return; }

    const environment = environmentInspector.createBuildEnvironment();
    let handle;
    try {
      handle = dependencies.spawnBuild(plan, {
        root: root,
        environment: environment,
        processAdapter: dependencies.processAdapter
      });
    } catch (_) {
      failRecord(record, 'BUILD_SPAWN_FAILED');
      return;
    }
    if (!handle || !handle.completion || !handle.ownershipReady || typeof handle.hasExited !== 'function' ||
        typeof handle.killRootHandle !== 'function' || typeof handle.terminateOwnedTree !== 'function') {
      failRecord(record, 'BUILD_SPAWN_FAILED');
      return;
    }
    record.processHandle = handle;
    record.processPhase = 'build';
    if (handle.spawnFailed === true || !Number.isInteger(handle.pid) || handle.pid <= 0) {
      const outcome = await handle.completion;
      markBuildOutcome(record, outcome);
      clearActiveProcess(record);
      failRecord(record, 'BUILD_SPAWN_FAILED');
      return;
    }
    const ownership = await handle.ownershipReady;
    if (record.state === 'CANCELLING') {
      await record.cancelPromise;
      if (!record.result) await waitForTerminal(record);
      return;
    }
    if (!ownership || ownership.ok !== true || !ownership.record) {
      if (typeof handle.killRootHandle === 'function') handle.killRootHandle();
      const outcome = await handle.completion;
      markBuildOutcome(record, outcome);
      clearActiveProcess(record);
      failRecord(record, outcome && outcome.spawnFailed ? 'BUILD_SPAWN_FAILED' : 'PROCESS_OWNERSHIP_FAILED');
      return;
    }
    record.processRoot = ownership.record;
    record.processOwnershipCaptured = true;
    record.processRoots.push(ownership.record);
    record.processMonitor = ownedProcess.createMonitor(ownership.record, dependencies.processAdapter);
    mergeOwnedProcessRecords(record, record.processMonitor.records());
    logEvent(record, 'BUILD_PROCESS_OWNERSHIP_CAPTURED');
    const outcome = await handle.completion;
    if (record.processMonitor) {
      await record.processMonitor.refresh();
      mergeOwnedProcessRecords(record, record.processMonitor.records());
      record.processMonitor.stop();
    }
    clearActiveProcess(record);
    if (record.state === 'CANCELLING') {
      await record.cancelPromise;
      if (!record.result) await waitForTerminal(record);
      return;
    }
    markBuildOutcome(record, outcome);
    if (record.state !== 'BUILD_COMPLETE') return;

    let measured;
    try { measured = await dependencies.measureArtifactIdentity(root, record.job.mode, record.job.version); }
    catch (_) { measured = null; }
    if (!measured || measured.ok !== true || !measured.identity || !measured.relativePath) {
      failRecord(record, measured && measured.code === 'ARTIFACT_NOT_FOUND' ? 'ARTIFACT_NOT_FOUND_AFTER_BUILD' : 'ARTIFACT_IDENTITY_FAILED');
      return;
    }
    record.artifactIdentity = Object.assign({}, measured.identity);
    record.artifactRelativePath = measured.relativePath;
    logEvent(record, 'ARTIFACT_IDENTITY_FROZEN');
    moved = transitionRecord(record, 'VALIDATING', 'ARTIFACT_VALIDATION_STARTED');
    if (!moved.ok) { failRecord(record, 'INVALID_STATE_TRANSITION'); return; }

    let validationResult;
    try {
      validationResult = await dependencies.validateArtifact({
        job: record.job,
        artifact: { path: measured.relativePath },
        buildContext: releaseContext(record)
      }, { root: root });
    } catch (_) {
      failRecord(record, 'VALIDATION_FAILED');
      return;
    }
    if (!validationResult || !artifactValidator.isIssuedValidationResult(validationResult) ||
        !validationResult.summary || !validationResult.artifact) {
      failRecord(record, 'VALIDATION_FAILED');
      return;
    }
    record.validationSummary = {
      status: validationResult.status,
      valid: validationResult.valid === true,
      summary: {
        pass: Number(validationResult.summary.pass) || 0,
        warn: Number(validationResult.summary.warn) || 0,
        fail: Number(validationResult.summary.fail) || 0
      }
    };
    if (!sameArtifactIdentity(record.artifactIdentity, validationResult.artifact)) {
      failRecord(record, 'ARTIFACT_IDENTITY_FAILED');
      return;
    }
    if (validationResult.status === 'PASS_WITH_WARNINGS') {
      failRecord(record, 'VALIDATION_WARNINGS_NOT_ACCEPTED');
      return;
    }
    if (validationResult.status !== 'PASS' || validationResult.valid !== true) {
      failRecord(record, 'VALIDATION_FAILED');
      return;
    }
    moved = transitionRecord(record, 'VALIDATED', 'VALIDATOR_PASS');
    if (!moved.ok) { failRecord(record, 'INVALID_STATE_TRANSITION'); return; }
    moved = transitionRecord(record, 'WRITING_MANIFEST', 'MANIFEST_WRITE_STARTED');
    if (!moved.ok) { failRecord(record, 'INVALID_STATE_TRANSITION'); return; }

    let manifestResult;
    try {
      manifestResult = await dependencies.writeArtifactManifest({
        job: record.job,
        validationResult: validationResult,
        provenance: { createdAt: record.createdAt }
      }, { root: root });
    } catch (_) {
      failRecord(record, 'MANIFEST_WRITE_FAILED');
      return;
    }
    if (!manifestResult || !['WRITTEN', 'ALREADY_IDENTICAL'].includes(manifestResult.status) || !manifestResult.manifest) {
      const code = manifestResult && manifestResult.code === 'MANIFEST_ALREADY_EXISTS_CONFLICT'
        ? 'MANIFEST_ALREADY_EXISTS_CONFLICT' : 'MANIFEST_WRITE_FAILED';
      failRecord(record, code);
      return;
    }
    record.manifestSummary = {
      status: manifestResult.status,
      name: manifestResult.manifest.name,
      sha256: manifestResult.manifest.sha256
    };

    let finalIdentity;
    try { finalIdentity = await dependencies.measureArtifactIdentity(root, record.job.mode, record.job.version); }
    catch (_) { finalIdentity = null; }
    if (!finalIdentity || finalIdentity.ok !== true || !sameArtifactIdentity(record.artifactIdentity, finalIdentity.identity)) {
      failRecord(record, 'ARTIFACT_CHANGED_DURING_FINALIZATION');
      return;
    }
    moved = transitionRecord(record, 'COMPLETE', 'PACKAGING_COMPLETE');
    if (!moved.ok) { failRecord(record, 'INVALID_STATE_TRANSITION'); return; }
    sealTerminal(record);
  } catch (_) {
    if (record.state === 'BUILDING' && record.processHandle && !record.processHandle.hasExited()) {
      const moved = transitionRecord(record, 'CANCELLING', 'INTERNAL_ERROR_CANCELLATION_COMMITTED');
      if (moved.ok) {
        record.cancelRequested = true;
        await performCancellation(record, { terminalState: 'FAILED', failureCode: 'EXECUTOR_INTERNAL_ERROR' });
      }
    } else if (!TERMINAL_STATES.has(record.state) && record.state !== 'CANCELLING') {
      failRecord(record, 'EXECUTOR_INTERNAL_ERROR');
    }
  } finally {
    if (TERMINAL_STATES.has(record.state)) {
      if (record.processMonitor) record.processMonitor.stop();
      releaseBuildLock(record);
    }
  }
}

function immediateFailure(code) {
  const failure = normalizedFailure(code);
  return {
    schema: RESULT_SCHEMA, schemaVersion: 1, status: 'FAILED', job: null,
    artifact: null, validation: null, manifest: null, failure: failure, events: []
  };
}

function createDependencies(options) {
  const supplied = options.dependencies || {};
  const processAdapter = options.processAdapter || supplied.processAdapter || ownedProcess.defaultAdapter();
  return Object.assign({
    startInspector: startEnvironmentInspectorWorker,
    createBuildPlan: buildPlanner.createBuildPlan,
    spawnBuild: startCanonicalBuild,
    measureArtifactIdentity: artifactValidator.measureArtifactIdentity,
    validateArtifact: artifactValidator.validateArtifact,
    writeArtifactManifest: artifactManifestWriter.writeArtifactManifest,
    processAdapter: processAdapter
  }, supplied, { processAdapter: processAdapter });
}

function executePackagingJob(request) {
  return executePackagingJobWithDependencies(request, {});
}

function executePackagingJobWithDependencies(request, options) {
  const o = options || {};
  if (!hasOnlyJobRequestFields(request)) return Promise.resolve(immediateFailure('INVALID_REQUEST'));
  let job;
  try { job = contract.validatePackagingJob(request.job); }
  catch (_) { return Promise.resolve(immediateFailure('INVALID_REQUEST')); }
  if (jobs.has(job.id)) return Promise.resolve(immediateFailure('INVALID_REQUEST'));
  const now = typeof o.now === 'function' ? o.now : function () { return new Date(); };
  const record = makeRecord(packagingJobInput(job), now);
  jobs.set(record.id, record);
  logEvent(record, 'JOB_CREATED');
  const root = path.resolve(o.root || path.resolve(__dirname, '..', '..'));
  const dependencies = createDependencies(o);
  record.completion = new Promise((resolve) => { record.resolveCompletion = resolve; });
  setImmediate(function () {
    runRecord(record, dependencies, root).then(function () {
      if (TERMINAL_STATES.has(record.state)) sealTerminal(record);
      /* An unconfirmed CANCELLING job stays pending and keeps the build lock. */
    }).catch(function () {
      if (!TERMINAL_STATES.has(record.state) && record.state !== 'CANCELLING') failRecord(record, 'EXECUTOR_INTERNAL_ERROR');
      else if (TERMINAL_STATES.has(record.state)) sealTerminal(record);
    });
  });
  return record.completion;
}

function cancelResponse(status, code) {
  return { status: status, code: code || null };
}

async function performCancellation(record, finalization) {
  const handle = record.processHandle;
  if (!handle) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
  const phase = record.processPhase;
  let ownership;
  try { ownership = await handle.ownershipReady; } catch (_) { ownership = null; }
  if (!ownership || ownership.ok !== true || !ownership.record) {
    /* Before the Inspector worker receives GO it has no descendants. Its
       ChildProcess handle is sufficient to cancel that not-yet-started probe. */
    if (phase === 'preflight' && handle.started !== true) {
      if (typeof handle.killRootHandle === 'function') handle.killRootHandle();
      const outcome = await handle.completion;
      recordPreflightOutcome(record, outcome);
      if (record.state !== 'CANCELLING') return { ok: false, code: 'INVALID_STATE_TRANSITION' };
      clearActiveProcess(record);
      const moved = transitionRecord(record, 'CANCELLED', 'PREFLIGHT_WORKER_CANCELLED');
      if (!moved.ok) return moved;
      record.failure = normalizedFailure('BUILD_CANCELLED');
      sealTerminal(record);
      return { ok: true };
    }
    if (typeof handle.killRootHandle === 'function') handle.killRootHandle();
    await handle.completion;
    return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
  }
  let activeOwnedProcess = [ownership.record];
  if (record.processMonitor) {
    await record.processMonitor.refresh();
    activeOwnedProcess = record.processMonitor.records();
    mergeOwnedProcessRecords(record, activeOwnedProcess);
  } else mergeOwnedProcessRecords(record, activeOwnedProcess);
  let terminated;
  try { terminated = await handle.terminateOwnedTree(activeOwnedProcess); }
  catch (_) { terminated = null; }
  if (!terminated || terminated.ok !== true) return { ok: false, code: 'PROCESS_OWNERSHIP_FAILED' };
  const outcome = await handle.completion;
  if (phase === 'build' && !record.buildResult) {
    record.buildExitCode = Number.isInteger(outcome && outcome.code) ? outcome.code : null;
    record.buildResult = {
      exitCode: record.buildExitCode,
      signal: outcome && typeof outcome.signal === 'string' ? outcome.signal : null,
      spawnFailed: !!(outcome && outcome.spawnFailed)
    };
    logEvent(record, 'BUILD_PROCESS_EXITED', { exitCode: record.buildExitCode });
  } else if (phase === 'preflight') {
    record.preflightExitCode = Number.isInteger(outcome && outcome.code) ? outcome.code : null;
    logEvent(record, 'PREFLIGHT_PROCESS_EXITED', { exitCode: record.preflightExitCode });
  }
  if (record.processMonitor) {
    await record.processMonitor.refresh();
    mergeOwnedProcessRecords(record, record.processMonitor.records());
    record.processMonitor.stop();
  }
  if (record.state !== 'CANCELLING') return { ok: false, code: 'INVALID_STATE_TRANSITION' };
  clearActiveProcess(record);
  const terminalState = finalization && finalization.terminalState === 'FAILED' ? 'FAILED' : 'CANCELLED';
  const failureCode = finalization && finalization.failureCode ? finalization.failureCode : 'BUILD_CANCELLED';
  const moved = transitionRecord(record, terminalState,
    terminalState === 'CANCELLED' ? 'BUILD_PROCESS_TREE_CANCELLED' : 'OWNED_PROCESS_TREE_STOPPED_AFTER_INTERNAL_ERROR');
  if (!moved.ok) return moved;
  record.failure = normalizedFailure(failureCode);
  sealTerminal(record);
  return { ok: true };
}

async function cancelPackagingJob(jobId) {
  const record = jobs.get(String(jobId || ''));
  if (!record) return cancelResponse('DENIED', 'INVALID_REQUEST');
  if (TERMINAL_STATES.has(record.state)) return cancelResponse('ALREADY_TERMINAL', 'ALREADY_TERMINAL');
  if (record.state === 'CREATED' || record.state === 'READY') {
    cancelBeforeBuild(record);
    return cancelResponse('CANCELLED', null);
  }
  if (record.state === 'PREFLIGHT') {
    const handle = record.processHandle;
    if (!handle || handle.hasExited()) {
      cancelBeforeBuild(record);
      return cancelResponse('CANCELLED', null);
    }
    const moved = transitionRecord(record, 'CANCELLING', 'CANCELLATION_COMMITTED');
    if (!moved.ok) return cancelResponse('DENIED', moved.code);
    record.cancelRequested = true;
    record.cancelPromise = performCancellation(record);
    const preflightCancellation = await record.cancelPromise;
    record.cancelPromise = null;
    if (record.state === 'CANCELLED') return cancelResponse('CANCELLED', null);
    return cancelResponse('CANCELLING', preflightCancellation && preflightCancellation.code || 'PROCESS_OWNERSHIP_FAILED');
  }
  if (record.state === 'BUILD_COMPLETE' || ['VALIDATING', 'VALIDATED', 'WRITING_MANIFEST'].includes(record.state)) {
    return cancelResponse('DENIED', 'CANCELLATION_TOO_LATE');
  }
  if (record.state === 'CANCELLING') {
    if (record.cancelPromise) return cancelResponse('CANCELLING', null);
    record.cancelPromise = performCancellation(record);
  } else if (record.state === 'BUILDING') {
    if (record.processHandle && record.processHandle.hasExited()) {
      const outcome = await record.processHandle.completion;
      markBuildOutcome(record, outcome);
      return cancelResponse('DENIED', 'CANCELLATION_TOO_LATE');
    }
    const moved = transitionRecord(record, 'CANCELLING', 'CANCELLATION_COMMITTED');
    if (!moved.ok) return cancelResponse('DENIED', moved.code);
    record.cancelRequested = true;
    record.cancelPromise = performCancellation(record);
  } else {
    return cancelResponse('DENIED', 'CANCELLATION_TOO_LATE');
  }
  const result = await record.cancelPromise;
  record.cancelPromise = null;
  if (record.state === 'CANCELLED') return cancelResponse('CANCELLED', null);
  return cancelResponse('CANCELLING', result && result.code || 'PROCESS_OWNERSHIP_FAILED');
}

function getPackagingJobState(jobId) {
  const record = jobs.get(String(jobId || ''));
  if (!record) return null;
  return {
    jobId: record.id,
    state: record.state,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    cancelRequested: record.cancelRequested,
    processOwnership: {
      captured: record.processOwnershipCaptured,
      descendantCount: Math.max(0, record.ownedProcess.length - record.processRoots.length)
    },
    result: record.result ? executionResult(record) : null,
    events: record.events.map((item) => Object.assign({}, item))
  };
}

module.exports = {
  RESULT_SCHEMA: RESULT_SCHEMA,
  STATES: STATES,
  TERMINAL_STATES: TERMINAL_STATES,
  checkStateTransition: checkStateTransition,
  executePackagingJob: executePackagingJob,
  cancelPackagingJob: cancelPackagingJob,
  getPackagingJobState: getPackagingJobState,
  __test: Object.freeze({ executePackagingJobWithDependencies: executePackagingJobWithDependencies })
};
