'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createPackagingCenterApi } = require('../services/packaging-center-api.js');
const contract = require('../tools/packaging-control-plane/contract.js');

const ROOT = path.resolve(__dirname, '..');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();

function createFakeControlPlane() {
  const states = new Map();
  const starts = [];
  const cancels = [];
  const timers = new Map();
  const completions = new Map();
  let dirty = false;
  const executor = {
    executePackagingJob: function (request) {
      starts.push(request);
      const job = request.job;
      states.set(job.id, {
        jobId: job.id, state: 'BUILDING', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
        finishedAt: '', cancelRequested: false, processOwnership: { pid: 777, descendantCount: 4 }, events: [
          { timestamp: new Date().toISOString(), state: 'BUILDING', event: 'BUILD_PROCESS_STARTED', pid: 777, stdout: 'sensitive output' }
        ], result: null
      });
      return new Promise(function (resolve) {
        completions.set(job.id, resolve);
        const timer = setTimeout(function () {
          timers.delete(job.id);
          if (states.get(job.id).state === 'CANCELLED') {
            const cancelled = { status: 'CANCELLED', job: job, failure: { code: 'BUILD_CANCELLED', message: 'sensitive path E:\\private' } };
            states.set(job.id, Object.assign({}, states.get(job.id), { state: 'CANCELLED', finishedAt: new Date().toISOString(), result: cancelled }));
            resolve(cancelled);
            return;
          }
          const result = {
            status: 'COMPLETE', job: job, build: { exitCode: 0, stdout: 'secret log' },
            artifact: { name: 'InternalBeyond-Setup-' + VERSION + '.exe', size: 4096, sha256: 'a'.repeat(64), path: 'E:\\private\\dist\\installer.exe' },
            validation: { status: 'PASS', valid: true, summary: { path: 'E:\\private' } },
            manifest: { status: 'WRITTEN', path: 'E:\\private\\manifest.json' },
            failure: null,
            events: [{ timestamp: new Date().toISOString(), state: 'COMPLETE', event: 'JOB_COMPLETE', pid: 777, environment: { SECRET: 'x' } }]
          };
          states.set(job.id, { jobId: job.id, state: 'COMPLETE', createdAt: '', startedAt: '', finishedAt: new Date().toISOString(), cancelRequested: false, result: result, events: result.events });
          resolve(result);
          completions.delete(job.id);
        }, job.id.indexOf('cancel') >= 0 ? 5000 : 15);
        timers.set(job.id, timer);
      });
    },
    getPackagingJobState: function (id) { return states.get(id) || null; },
    cancelPackagingJob: function (id) {
      cancels.push(id);
      const current = states.get(id);
      if (!current) return Promise.resolve({ status: 'DENIED', code: 'INVALID_REQUEST' });
      if (current.state === 'BUILDING') {
        if (timers.has(id)) clearTimeout(timers.get(id));
        timers.delete(id);
        const cancelledResult = { status: 'CANCELLED', job: current.job || starts.find(item => item.job.id === id).job, failure: { code: 'BUILD_CANCELLED', message: 'sensitive path E:\\private' } };
        states.set(id, Object.assign({}, current, { state: 'CANCELLED', cancelRequested: true, result: cancelledResult, finishedAt: new Date().toISOString() }));
        if (completions.has(id)) completions.get(id)(cancelledResult);
        completions.delete(id);
        return Promise.resolve({ status: 'CANCELLED', code: 'BUILD_CANCELLED' });
      }
      return Promise.resolve({ status: 'DENIED', code: 'CANCELLATION_TOO_LATE' });
    }
  };
  return {
    starts: starts,
    cancels: cancels,
    setDirty: function (value) { dirty = value; },
    module: {
      contract: contract,
      environmentInspector: {
        inspectEnvironment: function (options) {
          assert.strictEqual(options.root, ROOT);
          assert.strictEqual(options.target, 'windows-installer');
          assert.strictEqual(options.mode, 'release');
          return {
            ready: true,
            repository: { revision: 'a'.repeat(40), dirty: dirty },
            checks: [
              { name: 'node', status: 'PASS', required: true, message: 'Node ready' },
              { name: 'git-cleanliness', status: dirty ? 'WARN' : 'PASS', required: false, message: 'E:\\private checkout has changes' },
              { name: 'unexpected', status: 'PASS', required: false, message: 'secret contents' }
            ]
          };
        }
      },
      buildPlanner: {
        createBuildPlan: function (job, options) {
          assert.strictEqual(options.root, ROOT);
          return {
            status: dirty ? 'READY_WITH_WARNINGS' : 'READY',
            executes: false,
            releaseEligible: !dirty,
            steps: [
              { id: 'environment-check', status: 'PASS', authority: 'unsafe text does not cross the API' },
              { id: 'prepare-staging', status: 'PLANNED', command: 'powershell.exe', outputRoot: 'E:\\private' },
              { id: 'build-installer', status: 'PLANNED', command: { executable: 'powershell.exe', arguments: ['-File', 'E:\\private\\build.ps1'] } }
            ]
          };
        }
      },
      packagingExecutor: executor
    }
  };
}

function startServer(options) {
  const api = createPackagingCenterApi(Object.assign({ root: ROOT, originAllowed: function (req) {
    return !req.headers.origin || req.headers.origin === 'http://127.0.0.1';
  } }, options || {}));
  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!api.handle(req, res, url.pathname, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function request(server, pathname, method, body, headers) {
  return new Promise(function (resolve, reject) {
    const url = new URL(pathname, server.base);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: method || 'GET',
      headers: Object.assign({}, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}, headers || {})
    }, function (res) {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', function () {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { }
        resolve({ status: res.statusCode, body: json, raw: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForJobState(server, jobId, expectedState) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request(server, '/__packaging/jobs/' + jobId, 'GET');
    if (response.status === 200 && response.body && response.body.job && response.body.job.state === expectedState) return response;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('job did not reach expected synthetic state: ' + expectedState);
}

async function run() {
  const fake = createFakeControlPlane();
  const server = await startServer({ controlPlane: fake.module });
  try {
    const preview = await request(server, '/__packaging/preflight', 'GET');
    assert.strictEqual(preview.status, 200);
    assert.strictEqual(preview.body.available, true);
    assert.strictEqual(preview.body.version, VERSION);
    assert.strictEqual(preview.body.target, 'windows-installer');
    assert.strictEqual(preview.body.mode, 'release');
    assert.strictEqual(preview.body.actions.start, true);
    assert.deepStrictEqual(preview.body.environment.checks.map(item => item.name), ['node', 'git-cleanliness', 'unexpected']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(preview.body.environment.checks[0], 'message'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(preview.body.plan.steps[0], 'command'), false);
    assert.strictEqual(JSON.stringify(preview.body).includes('E:\\private'), false);
    assert.strictEqual(JSON.stringify(preview.body).includes('secret contents'), false);

    fake.setDirty(true);
    const dirtyPreview = await request(server, '/__packaging/preflight', 'GET');
    assert.strictEqual(dirtyPreview.body.actions.start, false, 'UI gate is derived from Planner eligibility');
    assert.strictEqual(dirtyPreview.body.plan.releaseEligible, false);
    fake.setDirty(false);

    const job = {
      id: 'pc-test-job-1', target: 'windows-installer', version: VERSION,
      channel: 'stable', mode: 'release', options: { includeDocs: false, includeExamples: false }
    };
    const started = await request(server, '/__packaging/jobs', 'POST', { job: job });
    assert.strictEqual(started.status, 202);
    assert.strictEqual(started.body.accepted, true);
    assert.deepStrictEqual(Object.keys(fake.starts[0]).sort(), ['job']);
    assert.strictEqual(fake.starts[0].job.id, job.id);

    const state = await waitForJobState(server, job.id, 'COMPLETE');
    assert.strictEqual(state.status, 200);
    assert.strictEqual(state.body.job.state, 'COMPLETE');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(state.body.job, 'processOwnership'), false);
    assert.strictEqual(JSON.stringify(state.body).includes('E:\\private'), false);
    assert.strictEqual(JSON.stringify(state.body).includes('sensitive output'), false);
    assert.strictEqual(JSON.stringify(state.body).includes('SECRET'), false);
    assert.strictEqual(state.body.job.result.artifact.name, 'InternalBeyond-Setup-' + VERSION + '.exe');
    assert.strictEqual(state.body.job.result.validation.status, 'PASS');
    assert.strictEqual(state.body.job.result.manifest.status, 'WRITTEN');

    const listed = await request(server, '/__packaging/jobs', 'GET');
    assert.strictEqual(listed.status, 200);
    assert.strictEqual(listed.body.jobs.length, 1);
    assert.strictEqual(listed.body.jobs[0].jobId, job.id);

    const duplicate = await request(server, '/__packaging/jobs', 'POST', { job: job });
    assert.strictEqual(duplicate.status, 409);
    const extraRequestField = await request(server, '/__packaging/jobs', 'POST', { job: Object.assign({}, job, { command: 'whoami' }) });
    assert.strictEqual(extraRequestField.status, 400);
    const extraTopLevelField = await request(server, '/__packaging/jobs', 'POST', { job: job, command: 'whoami' });
    assert.strictEqual(extraTopLevelField.status, 400);
    const wrongVersion = await request(server, '/__packaging/jobs', 'POST', { job: Object.assign({}, job, { id: 'pc-bad-version', version: '0.0.0' }) });
    assert.strictEqual(wrongVersion.status, 400);
    const wrongTarget = await request(server, '/__packaging/jobs', 'POST', { job: Object.assign({}, job, { id: 'pc-bad-target', target: 'web-export' }) });
    assert.strictEqual(wrongTarget.status, 400);

    const foreign = await request(server, '/__packaging/preflight', 'GET', undefined, { Origin: 'https://evil.example' });
    assert.strictEqual(foreign.status, 403);
    const queryInput = await request(server, '/__packaging/preflight?mode=debug', 'GET');
    assert.strictEqual(queryInput.status, 400);

    const cancelJob = Object.assign({}, job, { id: 'pc-cancel-job' });
    const cancelStarted = await request(server, '/__packaging/jobs', 'POST', { job: cancelJob });
    assert.strictEqual(cancelStarted.status, 202);
    const cancelExtraField = await request(server, '/__packaging/jobs/' + cancelJob.id + '/cancel', 'POST', { command: 'whoami' });
    assert.strictEqual(cancelExtraField.status, 400);
    const cancelled = await request(server, '/__packaging/jobs/' + cancelJob.id + '/cancel', 'POST', {});
    assert.strictEqual(cancelled.status, 200);
    assert.strictEqual(cancelled.body.status, 'CANCELLED');
    assert.deepStrictEqual(fake.cancels, [cancelJob.id]);
  } finally {
    await new Promise(resolve => server.server.close(resolve));
  }

  const unavailableServer = await startServer({ controlPlane: null });
  try {
    const unavailable = await request(unavailableServer, '/__packaging/preflight', 'GET');
    assert.strictEqual(unavailable.status, 503);
    assert.strictEqual(unavailable.body.code, 'PACKAGING_BACKEND_UNAVAILABLE');
  } finally {
    await new Promise(resolve => unavailableServer.server.close(resolve));
  }

  console.log('PASS test_packaging_center_api');
}

run().catch(function (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
