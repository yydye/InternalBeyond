'use strict';

/*
 * P35.6 · Same-origin presentation adapter for the P35 Packaging Control Plane.
 * It exposes only a fixed release preflight, exact PackagingJob requests, state,
 * current-process session history, and Executor-owned cancellation. The control
 * plane itself remains outside the canonical runtime payload; installed builds
 * answer PACKAGING_BACKEND_UNAVAILABLE when its source module is absent.
 */

const fs = require('fs');
const path = require('path');

const STATES = new Set([
  'CREATED', 'PREFLIGHT', 'READY', 'BUILDING', 'BUILD_COMPLETE', 'VALIDATING',
  'VALIDATED', 'WRITING_MANIFEST', 'COMPLETE', 'FAILED', 'CANCELLING', 'CANCELLED'
]);
const FAILURE_CODES = new Set([
  'INVALID_REQUEST', 'PREFLIGHT_FAILED', 'BUILD_PLAN_NOT_EXECUTABLE',
  'RELEASE_NOT_ELIGIBLE', 'PACKAGING_BUSY', 'BUILD_SPAWN_FAILED', 'BUILD_FAILED',
  'BUILD_CANCELLED', 'CANCELLATION_TOO_LATE', 'ALREADY_TERMINAL',
  'INVALID_STATE_TRANSITION', 'ARTIFACT_NOT_FOUND_AFTER_BUILD',
  'ARTIFACT_IDENTITY_FAILED', 'VALIDATION_FAILED', 'VALIDATION_WARNINGS_NOT_ACCEPTED',
  'MANIFEST_WRITE_FAILED', 'MANIFEST_ALREADY_EXISTS_CONFLICT',
  'ARTIFACT_CHANGED_DURING_FINALIZATION', 'PROCESS_OWNERSHIP_FAILED',
  'EXECUTOR_INTERNAL_ERROR'
]);
const PLAN_STEPS = Object.freeze({
  'environment-check': 'Environment check',
  'prepare-staging': 'Prepare staging',
  'stage-tauri-host': 'Stage the Windows host',
  'audit-staged-payload': 'Audit the staged payload',
  'compile-inno-installer': 'Compile the installer',
  'build-installer': 'Build the Windows installer',
  'validate-artifact': 'Validate the artifact'
});
const CHECK_LABELS = Object.freeze({
  target: 'Target',
  'operating-system': 'Windows host',
  node: 'Node.js',
  npm: 'npm',
  rustc: 'Rust compiler',
  cargo: 'Cargo',
  'tauri-cli': 'Tauri CLI',
  powershell: 'Windows PowerShell',
  'inno-setup': 'Inno Setup',
  webview2: 'WebView2',
  'required-files': 'Build inputs',
  'release-manifest': 'Release manifest',
  'payload-closure': 'Payload closure',
  'git-revision': 'Source revision',
  'git-cleanliness': 'Source worktree',
  'output-writable': 'Output location',
  'temporary-writable': 'Temporary location',
  'host-build-writable': 'Host build location',
  'output-disk-space': 'Output disk space',
  'host-build-disk-space': 'Host build disk space',
  'temporary-disk-space': 'Temporary disk space'
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function respond(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function errorResponse(res, status, code) {
  respond(res, status, { ok: false, code: code });
}

function readJson(req, maxBytes) {
  return new Promise(function (resolve) {
    const chunks = [];
    let total = 0;
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }
    req.on('data', function (chunk) {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        done({ ok: false });
        try { req.resume(); } catch (_) { }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
      if (!raw) { done({ ok: false }); return; }
      try { done({ ok: true, json: JSON.parse(raw) }); }
      catch (_) { done({ ok: false }); }
    });
    req.on('error', function () { done({ ok: false }); });
  });
}

function canonicalVersion(root) {
  let version = '';
  try { version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(); }
  catch (_) { return ''; }
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ? version : '';
}

function safeCheck(check) {
  if (!check || typeof check !== 'object') return null;
  const name = typeof check.name === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/i.test(check.name)
    ? check.name : '';
  const status = ['PASS', 'WARN', 'FAIL'].includes(check.status) ? check.status : '';
  if (!name || !status) return null;
  return {
    name: name,
    label: CHECK_LABELS[name] || 'Additional check',
    status: status,
    required: check.required !== false
  };
}

function safePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const steps = Array.isArray(plan.steps) ? plan.steps.slice(0, 20).map(function (step) {
    if (!step || typeof step !== 'object' || !Object.prototype.hasOwnProperty.call(PLAN_STEPS, step.id)) return null;
    const status = step.status === 'PASS' ? 'COMPLETE'
      : (step.status === 'FAIL' ? 'BLOCKED' : (['PLANNED', 'BLOCKED', 'COMPLETE'].includes(step.status) ? step.status : 'BLOCKED'));
    return {
      label: PLAN_STEPS[step.id],
      status: status
    };
  }).filter(Boolean) : [];
  return {
    status: ['READY', 'READY_WITH_WARNINGS', 'BLOCKED', 'UNSUPPORTED'].includes(plan.status) ? plan.status : 'BLOCKED',
    executes: plan.executes === false,
    releaseEligible: plan.releaseEligible === true,
    steps: steps
  };
}

function safeJob(job) {
  if (!job || typeof job !== 'object') return null;
  const id = typeof job.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(job.id) ? job.id : '';
  const version = typeof job.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(job.version)
    ? job.version : '';
  if (!id || !version || job.target !== 'windows-installer') return null;
  return {
    id: id,
    target: 'windows-installer',
    version: version,
    channel: job.channel === 'stable' ? 'stable' : '',
    mode: job.mode === 'release' ? 'release' : ''
  };
}

function safeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const status = STATES.has(result.status) ? result.status : 'FAILED';
  const output = { status: status, job: safeJob(result.job), build: null, artifact: null, validation: null, manifest: null, failure: null, events: [] };
  if (result.build && typeof result.build === 'object') {
    output.build = { exitCode: Number.isInteger(result.build.exitCode) ? result.build.exitCode : null };
  }
  if (result.artifact && typeof result.artifact === 'object') {
    const name = typeof result.artifact.name === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(result.artifact.name)
      ? result.artifact.name : '';
    const sha256 = typeof result.artifact.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(result.artifact.sha256)
      ? result.artifact.sha256.toLowerCase() : '';
    if (name && sha256 && Number.isSafeInteger(result.artifact.size) && result.artifact.size >= 0) {
      output.artifact = { name: name, size: result.artifact.size, sha256: sha256 };
    }
  }
  if (result.validation && typeof result.validation === 'object') {
    output.validation = {
      status: ['PASS', 'FAIL', 'PASS_WITH_WARNINGS'].includes(result.validation.status) ? result.validation.status : 'FAIL',
      valid: result.validation.valid === true
    };
  }
  if (result.manifest && typeof result.manifest === 'object') {
    output.manifest = {
      status: ['WRITTEN', 'ALREADY_IDENTICAL'].includes(result.manifest.status) ? result.manifest.status : 'FAILED'
    };
  }
  if (result.failure && typeof result.failure === 'object') {
    const code = FAILURE_CODES.has(result.failure.code) ? result.failure.code : 'EXECUTOR_INTERNAL_ERROR';
    output.failure = { code: code };
  }
  output.events = safeEvents(result.events);
  return output;
}

function safeEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(-200).map(function (event) {
    if (!event || typeof event !== 'object') return null;
    const state = STATES.has(event.state) ? event.state : '';
    const name = typeof event.event === 'string' && /^[A-Z0-9_]{1,80}$/.test(event.event) ? event.event : '';
    if (!state || !name) return null;
    const item = { state: state, event: name };
    if (typeof event.timestamp === 'string' && event.timestamp.length <= 40) item.timestamp = event.timestamp;
    if (Number.isInteger(event.exitCode)) item.exitCode = event.exitCode;
    return item;
  }).filter(Boolean);
}

function safeState(snapshot, jobId) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const state = STATES.has(snapshot.state) ? snapshot.state : 'FAILED';
  return {
    jobId: jobId,
    state: state,
    createdAt: typeof snapshot.createdAt === 'string' ? snapshot.createdAt.slice(0, 40) : '',
    startedAt: typeof snapshot.startedAt === 'string' ? snapshot.startedAt.slice(0, 40) : '',
    finishedAt: typeof snapshot.finishedAt === 'string' ? snapshot.finishedAt.slice(0, 40) : '',
    cancelRequested: snapshot.cancelRequested === true,
    result: safeResult(snapshot.result),
    events: safeEvents(snapshot.events)
  };
}

function createPackagingCenterApi(options) {
  const o = options || {};
  const root = path.resolve(o.root || path.resolve(__dirname, '..'));
  const originAllowed = typeof o.originAllowed === 'function' ? o.originAllowed : function () { return false; };
  let controlPlane = Object.prototype.hasOwnProperty.call(o, 'controlPlane') ? o.controlPlane : null;
  let loadAttempted = Object.prototype.hasOwnProperty.call(o, 'controlPlane');
  const sessionJobs = new Map();

  function getControlPlane() {
    if (!loadAttempted) {
      loadAttempted = true;
      try { controlPlane = require(path.join(root, 'tools', 'packaging-control-plane', 'index.js')); }
      catch (_) { controlPlane = null; }
    }
    return controlPlane;
  }

  function available(module) {
    return !!(module && module.contract && typeof module.contract.validatePackagingJob === 'function'
      && module.environmentInspector && typeof module.environmentInspector.inspectEnvironment === 'function'
      && module.buildPlanner && typeof module.buildPlanner.createBuildPlan === 'function'
      && module.packagingExecutor && typeof module.packagingExecutor.executePackagingJob === 'function'
      && typeof module.packagingExecutor.getPackagingJobState === 'function'
      && typeof module.packagingExecutor.cancelPackagingJob === 'function');
  }

  function jobForPreview(module, version) {
    return module.contract.validatePackagingJob({
      id: 'packaging-preview',
      target: 'windows-installer',
      version: version,
      channel: 'stable',
      mode: 'release',
      options: { includeDocs: false, includeExamples: false }
    });
  }

  function preflight(res) {
    const module = getControlPlane();
    if (!available(module)) return errorResponse(res, 503, 'PACKAGING_BACKEND_UNAVAILABLE');
    const version = canonicalVersion(root);
    if (!version) return errorResponse(res, 503, 'CANONICAL_VERSION_UNAVAILABLE');
    try {
      const job = jobForPreview(module, version);
      const inspection = module.environmentInspector.inspectEnvironment({
        root: root,
        target: job.target,
        mode: job.mode
      });
      const plan = module.buildPlanner.createBuildPlan(job, { root: root, inspection: inspection });
      const projectedPlan = safePlan(plan);
      const checks = Array.isArray(inspection.checks) ? inspection.checks.map(safeCheck).filter(Boolean).slice(0, 80) : [];
      const canStart = inspection.ready === true && projectedPlan && projectedPlan.executes
        && projectedPlan.releaseEligible && projectedPlan.status !== 'BLOCKED'
        && projectedPlan.status !== 'UNSUPPORTED';
      respond(res, 200, {
        ok: true,
        available: true,
        version: version,
        target: 'windows-installer',
        mode: 'release',
        environment: { ready: inspection.ready === true, checks: checks },
        plan: projectedPlan,
        actions: { start: canStart === true }
      });
    } catch (_) {
      errorResponse(res, 503, 'PACKAGING_PREFLIGHT_UNAVAILABLE');
    }
  }

  function validateSubmittedJob(module, payload) {
    if (!isPlainObject(payload) || Object.keys(payload).length !== 1 || !Object.prototype.hasOwnProperty.call(payload, 'job')) return null;
    let job;
    try { job = module.contract.validatePackagingJob(payload.job); }
    catch (_) { return null; }
    const version = canonicalVersion(root);
    if (!version || job.target !== 'windows-installer' || job.mode !== 'release'
      || job.channel !== 'stable' || job.version !== version) return null;
    return job;
  }

  function stateFor(module, id) {
    const entry = sessionJobs.get(id);
    if (!entry) return null;
    let current = null;
    try { current = module.packagingExecutor.getPackagingJobState(id); } catch (_) { current = null; }
    if (current) return safeState(current, id);
    if (entry.result) {
      return {
        jobId: id,
        state: STATES.has(entry.result.status) ? entry.result.status : 'FAILED',
        createdAt: entry.createdAt,
        startedAt: '',
        finishedAt: entry.createdAt,
        cancelRequested: false,
        result: entry.result,
        events: entry.result.events || []
      };
    }
    return { jobId: id, state: 'CREATED', createdAt: entry.createdAt, startedAt: '', finishedAt: '', cancelRequested: false, result: null, events: [] };
  }

  function startJob(req, res, module) {
    if (req.method !== 'POST') return errorResponse(res, 405, 'METHOD_NOT_ALLOWED');
    readJson(req, 8192).then(function (body) {
      if (!body.ok) return errorResponse(res, 400, 'INVALID_REQUEST');
      const job = validateSubmittedJob(module, body.json);
      if (!job) return errorResponse(res, 400, 'INVALID_REQUEST');
      if (sessionJobs.has(job.id)) return errorResponse(res, 409, 'JOB_ID_ALREADY_USED');

      const entry = { job: job, createdAt: new Date().toISOString(), result: null };
      sessionJobs.set(job.id, entry);
      let completion;
      try { completion = module.packagingExecutor.executePackagingJob({ job: job }); }
      catch (_) { completion = Promise.resolve({ status: 'FAILED', failure: { code: 'EXECUTOR_INTERNAL_ERROR' } }); }
      Promise.resolve(completion).then(function (result) {
        entry.result = safeResult(result);
      }, function () {
        entry.result = safeResult({ status: 'FAILED', failure: { code: 'EXECUTOR_INTERNAL_ERROR' } });
      });
      respond(res, 202, { ok: true, accepted: true, jobId: job.id });
    });
  }

  function handle(req, res, pathname, requestUrl) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/__packaging')) return false;
    if (!originAllowed(req)) {
      errorResponse(res, 403, 'ORIGIN_DENIED');
      return true;
    }
    const module = getControlPlane();
    if (!available(module)) {
      errorResponse(res, 503, 'PACKAGING_BACKEND_UNAVAILABLE');
      return true;
    }
    const url = requestUrl instanceof URL ? requestUrl : new URL(String(req.url || '/'), 'http://127.0.0.1');

    if (pathname === '/__packaging/preflight') {
      if (req.method !== 'GET' || Array.from(url.searchParams.keys()).length) errorResponse(res, 400, 'INVALID_REQUEST');
      else preflight(res);
      return true;
    }
    if (pathname === '/__packaging/jobs') {
      if (Array.from(url.searchParams.keys()).length) { errorResponse(res, 400, 'INVALID_REQUEST'); return true; }
      if (req.method === 'POST') startJob(req, res, module);
      else if (req.method === 'GET') {
        const jobs = Array.from(sessionJobs.keys()).reverse().map(function (id) { return stateFor(module, id); }).filter(Boolean);
        respond(res, 200, { ok: true, available: true, jobs: jobs });
      } else errorResponse(res, 405, 'METHOD_NOT_ALLOWED');
      return true;
    }

    let match = pathname.match(/^\/__packaging\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:\/(cancel))?$/);
    if (match) {
      const id = match[1];
      if (Array.from(url.searchParams.keys()).length) { errorResponse(res, 400, 'INVALID_REQUEST'); return true; }
      if (!sessionJobs.has(id)) { errorResponse(res, 404, 'JOB_NOT_FOUND'); return true; }
      if (match[2] === 'cancel') {
        if (req.method !== 'POST') { errorResponse(res, 405, 'METHOD_NOT_ALLOWED'); return true; }
        readJson(req, 1024).then(function (body) {
          if (!body.ok || !isPlainObject(body.json) || Object.keys(body.json).length) {
            errorResponse(res, 400, 'INVALID_REQUEST');
            return;
          }
          Promise.resolve().then(function () { return module.packagingExecutor.cancelPackagingJob(id); }).then(function (result) {
            const status = result && ['CANCELLED', 'CANCELLING', 'DENIED', 'ALREADY_TERMINAL'].includes(result.status)
              ? result.status : 'DENIED';
            const code = result && FAILURE_CODES.has(result.code) ? result.code
              : (result && result.code === 'ALREADY_TERMINAL' ? 'ALREADY_TERMINAL' : null);
            respond(res, 200, { ok: true, status: status, code: code });
          }, function () { errorResponse(res, 500, 'CANCEL_REQUEST_FAILED'); });
        });
      } else if (req.method === 'GET') {
        respond(res, 200, { ok: true, job: stateFor(module, id) });
      } else errorResponse(res, 405, 'METHOD_NOT_ALLOWED');
      return true;
    }

    errorResponse(res, 404, 'PACKAGING_ROUTE_NOT_FOUND');
    return true;
  }

  return { handle: handle };
}

module.exports = {
  createPackagingCenterApi: createPackagingCenterApi,
  safeResult: safeResult,
  safeState: safeState,
  safeCheck: safeCheck,
  safePlan: safePlan
};
