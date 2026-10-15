'use strict';

/* P28-WM-P1 · Home Node Work Run Authority integration.
   Uses isolated SQLite data and the real Home Node service/HTTP boundary. */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const createWorkModeRuntime = require('../assets/js/work-mode-runtime.js');
const workModeConsentUi = require('../assets/js/work-mode-consent-ui.js');
const workModeConsentCore = require('../assets/js/work-mode-consent-core.js');
const workModeMemoryRecall = require('../assets/js/work-mode-memory-recall.js');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_PATH = path.join(ROOT, 'services', 'home-node-service.js');
const STORE_PATH = path.join(ROOT, 'services', 'home-node', 'work-run-store.js');
const TOKEN = 'synthetic-work-run-authority-token';
const WORKFLOW = 'project.audit.readonly';
const CONSENT_TERMS_VERSION = workModeConsentCore.TERMS_VERSION;
const SENTINEL = 'synthetic-secret-must-not-persist';
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-work-run-'));
const previousEnv = {
  devMode: process.env.IB_DEV_MODE,
  dataDir: process.env.IB_HOME_NODE_DATA_DIR,
  port: process.env.IB_HOME_NODE_PORT,
  token: process.env.IB_HOME_NODE_TOKEN
};

process.env.IB_DEV_MODE = '0';
process.env.IB_HOME_NODE_DATA_DIR = path.join(TEST_ROOT, 'module-default');
process.env.IB_HOME_NODE_PORT = '23118';
process.env.IB_HOME_NODE_TOKEN = TOKEN;
const SERVICE = require(SERVICE_PATH);

function restoreEnv() {
  if (previousEnv.devMode === undefined) delete process.env.IB_DEV_MODE; else process.env.IB_DEV_MODE = previousEnv.devMode;
  if (previousEnv.dataDir === undefined) delete process.env.IB_HOME_NODE_DATA_DIR; else process.env.IB_HOME_NODE_DATA_DIR = previousEnv.dataDir;
  if (previousEnv.port === undefined) delete process.env.IB_HOME_NODE_PORT; else process.env.IB_HOME_NODE_PORT = previousEnv.port;
  if (previousEnv.token === undefined) delete process.env.IB_HOME_NODE_TOKEN; else process.env.IB_HOME_NODE_TOKEN = previousEnv.token;
}

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(port, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: port,
      path: pathname,
      method: method,
      headers: Object.assign(data ? { 'Content-Type': 'application/json' } : {}, headers || {})
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; }
        catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', error => { error.requestPath = pathname; error.requestMethod = method; reject(error); });
    if (data) req.write(data);
    req.end();
  });
}

function derivedScope(projectRef, contextHash, reviewProviderScope) {
  return {
    projectRef: projectRef,
    contextHash: contextHash,
    review: { confirmed: true, providerScope: reviewProviderScope },
    result: {
      confirmed: true, destination: 'work_result', schemaVersion: 1,
      storage: 'plaintext_home_node_sqlite', retentionMs: 90 * 24 * 60 * 60 * 1000
    }
  };
}

function requestBytes(port, method, pathname, bytes, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(bytes || []);
    const req = http.request({
      host: '127.0.0.1', port: port, path: pathname, method: method,
      headers: Object.assign({ 'Content-Type': 'application/vnd.sqlite3', 'Content-Length': data.length }, headers || {})
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await request(port, 'GET', '/health');
      if (result.status === 200 && result.body && result.body.ok) return result.body;
    } catch (_) { /* service is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

function startProduction(dataDir, port) {
  const child = spawn(process.execPath, [SERVICE_PATH], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      IB_DEV_MODE: '0',
      IB_HOME_NODE_DATA_DIR: dataDir,
      IB_HOME_NODE_PORT: String(port),
      IB_HOME_NODE_TOKEN: TOKEN,
      IB_HOME_NODE_TOKEN_AUTOPROVISION: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child: child, output: () => output };
}

async function stopProduction(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  child.kill('SIGTERM');
  await Promise.race([
    exit,
    new Promise(resolve => setTimeout(resolve, 3500))
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await exit;
  }
}

function runId(body) {
  return body && body.run && body.run.runId;
}

async function testQueuedConsentSurvivesUiRefresh(port, auth) {
  const projectRef = 'project_consent_refresh';
  const fileId = 'pf_consent_refresh';
  const file = { fileId: fileId, path: 'README.txt', size: 24, contentHash: 'a'.repeat(64) };
  const providerScopes = [
    { destination: 'agent', providerRef: 'profile_refresh_test', provider: 'openai', model: 'test-model', routeHash: 'b'.repeat(64) },
    { destination: 'middle_brain', providerRef: 'profile_review_test', provider: 'openai', model: 'review-test-model', routeHash: 'c'.repeat(64) }
  ];
  let draft = null, requestSequence = 0, grantHttpStatus = 0, startCalls = 0;
  const runPath = runIdValue => '/internal/work/runs/' + encodeURIComponent(runIdValue);
  const apiCall = async (method, pathname, body) => (await request(port, method, pathname, body, auth)).body;
  const homeNode = {
    create: input => apiCall('POST', '/internal/work/runs', input),
    get: runIdValue => apiCall('GET', '/internal/work/runs/' + encodeURIComponent(runIdValue)),
    listActive: options => apiCall('GET', '/internal/work/runs/active?limit=' + encodeURIComponent(options && options.limit || 100)),
    listResults: options => apiCall('GET', '/internal/work/runs/results?limit=' + encodeURIComponent(options && options.limit || 100)),
    events: (runIdValue, options) => apiCall('GET', '/internal/work/runs/' + encodeURIComponent(runIdValue)
      + '/events?afterSequence=' + encodeURIComponent(options && options.afterSequence || 0)
      + '&limit=' + encodeURIComponent(options && options.limit || 100)),
    transition: (runIdValue, input) => apiCall('POST', '/internal/work/runs/' + encodeURIComponent(runIdValue) + '/transition', input),
    cancel: (runIdValue, input) => apiCall('POST', '/internal/work/runs/' + encodeURIComponent(runIdValue) + '/cancel', input),
    getConsent: (runIdValue, consentId) => apiCall('GET', '/internal/work/runs/' + encodeURIComponent(runIdValue)
      + '/consents/' + encodeURIComponent(consentId)),
    checkConsent: (runIdValue, consentId, input) => apiCall('POST', '/internal/work/runs/' + encodeURIComponent(runIdValue)
      + '/consents/' + encodeURIComponent(consentId) + '/check', input),
    revokeConsent: (runIdValue, consentId, input) => apiCall('POST', '/internal/work/runs/' + encodeURIComponent(runIdValue)
      + '/consents/' + encodeURIComponent(consentId) + '/revoke', input),
    complete: (runIdValue, input) => apiCall('POST', '/internal/work/runs/' + encodeURIComponent(runIdValue) + '/complete', input)
  };
  const createRuntime = () => Object.assign({}, createWorkModeRuntime({
    homeNode: homeNode,
    root: {},
    runExclusive: async callback => ({ acquired: true, value: await callback() }),
    createRequestId: () => 'refresh-runtime-' + (++requestSequence)
  }), {
    previewAuthorization: async input => {
      const current = await homeNode.get(input.runId);
      if (!current || current.ok !== true) return current;
      return {
        ok: true, run: current.run, projectRef: projectRef,
        files: [Object.assign({}, file)],
        providers: providerScopes.map(scope => Object.assign({}, scope, { scope: Object.assign({}, scope), endpointLabel: 'isolated-test-route' })),
        terms: { version: CONSENT_TERMS_VERSION, purpose: WORKFLOW, resultStorage: 'plaintext_home_node_sqlite' }
      };
    },
    grantConsent: async input => {
      const current = await homeNode.get(input.runId);
      const response = await request(port, 'POST', runPath(input.runId) + '/consents', {
        requestId: 'refresh-lifecycle-grant-' + (++requestSequence),
        expectedVersion: current.run.version,
        projectRef: current.run.projectRef,
        providerScopes: providerScopes,
        fileIds: input.fileIds,
        memoryScope: null,
        memoryDerivedScope: null,
        expiresInMs: input.expiresInMs,
        termsVersion: input.termsVersion,
        confirmed: input.confirmed === true
      }, auth);
      grantHttpStatus = response.status;
      return response.body;
    },
    previewMemoryRecall: async input => ({ ok: true, projectRef: input.projectRef, records: [], count: 0, total: 0, hasMore: false }),
    start: async () => { startCalls++; return { ok: false, error: 'test-provider-call-forbidden' }; }
  });
  const workspace = {
    wsGetWorkModeProjects: async () => ({ ok: true, projects: [{ id: projectRef, name: 'Consent refresh fixture' }] }),
    wsGetWorkModeProjectSnapshot: async requestedProject => requestedProject === projectRef
      ? { ok: true, projectRef: projectRef, projectName: 'Consent refresh fixture', projectPath: '', files: [Object.assign({}, file)] }
      : { ok: false, error: 'project-not-found' }
  };
  const createController = runtime => workModeConsentUi.createController({
    runtime: runtime,
    homeNode: homeNode,
    workspace: workspace,
    consentCore: workModeConsentCore,
    memoryRecall: workModeMemoryRecall,
    projectDraft: {
      load: () => draft && JSON.parse(JSON.stringify(draft)),
      save: value => { draft = JSON.parse(JSON.stringify(value)); return true; },
      clear: () => { draft = null; return true; }
    },
    requireFileSelection: true,
    requestId: () => 'refresh-ui-' + (++requestSequence)
  });
  const first = createController(createRuntime());
  await first.refresh(); // first document mount: no queued Run exists yet
  assert.strictEqual((await first.setSelectedProject(projectRef)).ok, true);
  assert.strictEqual((await first.setFileIds([fileId])).ok, true);
  assert.strictEqual((await first.setProfileRef('profile_refresh_test')).ok, true);
  assert.strictEqual((await first.createRun(projectRef)).ok, true);
  const runId = first.getState().run.runId;
  assert.strictEqual((await first.previewAuthorization()).ok, true);
  await first.confirmStorageRisk(true);
  assert.strictEqual((await first.confirmScope(true)).ok, true);
  const saved = await first.grant(60000, true);
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(grantHttpStatus, 200, 'the isolated Home Node accepted the test Consent');
  assert.strictEqual((await homeNode.getConsent(runId, saved.consent.consentId)).consent.status, 'active');

  await first.refresh(); // same-document Work UI refresh
  assert.strictEqual((await homeNode.getConsent(runId, saved.consent.consentId)).consent.status, 'active',
    'same-document refresh does not revoke Home Node Consent');

  const remounted = createController(createRuntime()); // new controller/runtime, as after a document reload
  assert.strictEqual((await remounted.restoreProjectDraft()).ok, true);
  await remounted.refresh();
  const afterReloadRun = await homeNode.get(runId);
  const afterReloadConsent = await homeNode.getConsent(runId, saved.consent.consentId);
  assert.strictEqual(afterReloadRun.run.status, 'queued', 'a queued Run survives page recovery');
  assert.strictEqual(afterReloadConsent.consent.status, 'active', 'remount does not revoke a scope-unchanged Ledger Consent');
  assert.strictEqual(remounted.getState().consentId, '', 'the new UI instance does not restore front-end authorization state');
  assert.strictEqual((await remounted.selectRun(runId)).ok, true, 'selecting the queued Run after remount is a read-only recovery');
  await remounted.setProfileRef('profile_refresh_test'); // async profile restoration remains local to UI state
  assert.strictEqual((await remounted.previewAuthorization()).ok, true, 'the current route can be re-previewed without revoking the saved Consent');
  assert.strictEqual((await homeNode.getConsent(runId, saved.consent.consentId)).consent.status, 'active');
  assert.strictEqual((await remounted.start()).error, 'consent-required', 'the reloaded UI cannot start without restored authorization state');
  assert.strictEqual(startCalls, 0, 'refresh/remount never invokes a Provider');

  file.contentHash = 'd'.repeat(64);
  assert.strictEqual((await first.refreshProjectSnapshot(projectRef)).ok, true);
  assert.strictEqual((await homeNode.getConsent(runId, saved.consent.consentId)).consent.status, 'revoked',
    'a real Workspace fingerprint change still revokes the old Consent');
  const cancelled = await homeNode.cancel(runId, { requestId: 'refresh-lifecycle-cleanup', expectedVersion: 1 });
  assert.strictEqual(cancelled.run.status, 'cancelled', 'the isolated queued fixture is cleaned up');
}

async function testBuildAssembly(dataDir) {
  const options = { dataDir: dataDir, credentialDataDir: path.join(TEST_ROOT, 'vault'), token: TOKEN, logger: () => {} };
  let first = SERVICE.buildHomeNode(options);
  try {
    first.open();
    assert.strictEqual(first.workRunStore.isOpen(), true, 'buildHomeNode should open its Work Run store');
    const created = first.workRunStore.createRun({
      requestId: 'build-create-1', workflowId: WORKFLOW, projectRef: 'project_build'
    });
    assert.strictEqual(created.ok, true);
    const firstRunId = created.run.runId;
    const legacyCompleted = first.workRunStore.createRun({
      requestId: 'build-create-legacy-complete', workflowId: WORKFLOW, projectRef: 'project_legacy_completed'
    });
    const legacyRunId = legacyCompleted.run.runId;
    const legacyStarted = first.workRunStore.transition({
      runId: legacyRunId, requestId: 'build-start-legacy-complete', expectedVersion: 1,
      status: 'running', reasonCode: 'runtime_started'
    });
    assert.strictEqual(legacyStarted.ok, true);
    first.close();
    first = null;

    const { DatabaseSync } = require('node:sqlite');
    const legacyDb = new DatabaseSync(path.join(dataDir, 'home-node.db'));
    try {
      legacyDb.exec('DROP TABLE work_run_results');
      legacyDb.exec('DROP TABLE work_run_consents');
      legacyDb.exec('DROP TABLE work_run_dsh_sessions');
      legacyDb.exec('BEGIN IMMEDIATE');
      legacyDb.prepare('UPDATE work_runs SET status=?, version=?, updated_at=? WHERE run_id=?').run(
        'completed', 3, Date.now(), legacyRunId
      );
      legacyDb.prepare('INSERT INTO work_run_events (run_id, sequence, event_type, from_status, to_status, version, reason_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(legacyRunId, 3, 'state_changed', 'running', 'completed', 3, 'runtime_completed', Date.now());
      legacyDb.prepare("UPDATE meta SET value='1' WHERE key='work_runs_schema_version'").run();
      legacyDb.exec('COMMIT');
    } finally { legacyDb.close(); }

    const second = SERVICE.buildHomeNode(options);
    try {
      second.open();
      assert.strictEqual(second.workRunStore.describe().schemaVersion, 10, 'Work Run data migrates with executor, multi-Run DSH Session, App Draft references, Coding write consent, and Action Trace payloads');
      assert.strictEqual(second.workRunStore.getRun(firstRunId).run.status, 'queued',
        'buildHomeNode should reopen the same Home Node database');
      assert.strictEqual(second.workRunStore.getResult(legacyRunId).result.status, 'legacy_unavailable',
        'legacy completed Runs receive a tombstone rather than a fabricated report');
      assert.deepStrictEqual(second.workRunStore.getDshSession('session-12345678-1234-4234-8234-123456789012'),
        { ok: true, found: false, run: null, binding: null }, 'legacy Runs migrate without invented DSH Session links');
    } finally { second.close(); }
  } finally {
    if (first) first.close();
  }

  const chatOnly = SERVICE.buildHomeNode({
    dataDir: path.join(TEST_ROOT, 'chat-with-unavailable-work-runs'),
    credentialDataDir: path.join(TEST_ROOT, 'vault'),
    token: TOKEN,
    logger: () => {},
    workRunStore: {
      open: function () { throw Object.assign(new Error('synthetic open failure'), { code: 'SYNTHETIC_OPEN_FAILURE' }); },
      close: function () {},
      createRun: function () { return { ok: false, code: 'STORE_UNAVAILABLE' }; }
    }
  });
  try {
    chatOnly.open();
    assert.strictEqual(chatOnly.store.isOpen(), true, 'Work Run schema failure must not disable canonical Chat');
  } finally { chatOnly.close(); }

  const agentMemoryUnavailable = SERVICE.buildHomeNode({
    dataDir: path.join(TEST_ROOT, 'chat-with-unavailable-agent-memory'),
    credentialDataDir: path.join(TEST_ROOT, 'vault'),
    token: TOKEN,
    logger: () => {},
    agentMemoryStore: {
      open: function () { throw Object.assign(new Error('synthetic agent memory open failure'), { code: 'SYNTHETIC_OPEN_FAILURE' }); },
      close: function () {}
    }
  });
  try {
    agentMemoryUnavailable.open();
    assert.strictEqual(agentMemoryUnavailable.store.isOpen(), true,
      'Agent Memory DB failure must not disable canonical Chat');
    assert.strictEqual(agentMemoryUnavailable.memoryStore.isOpen(), true,
      'Agent Memory DB failure must not disable Chat Memory');
  } finally { agentMemoryUnavailable.close(); }
}

async function testDshSessionRunBinding(port, auth) {
  const created = await request(port, 'POST', '/internal/work/runs', {
    requestId: 'dsh-session-run-create', workflowId: WORKFLOW, projectRef: 'project_dsh_session'
  }, auth);
  assert.equal(created.status, 200);
  const runIdValue = runId(created.body);
  const sessionId = 'session-12345678-1234-4234-8234-123456789012';
  const runPath = '/internal/work/runs/' + encodeURIComponent(runIdValue);
  const linkPath = runPath + '/dsh-session';
  const noAuth = await request(port, 'POST', linkPath, { sessionId: sessionId, consentId: '', expectedVersion: 1 });
  assert.equal(noAuth.status, 401);

  const linked = await request(port, 'POST', linkPath, {
    sessionId: sessionId, consentId: '', expectedVersion: 1
  }, auth);
  assert.equal(linked.status, 200);
  assert.equal(linked.body.run.status, 'queued');
  assert.equal(linked.body.run.version, 1, 'Session binding is metadata, not a Work Run state transition');
  assert.equal(linked.body.binding.consentId, '', 'a Session link does not grant consent');
  const reloaded = await request(port, 'GET', '/internal/work/runs/dsh-sessions/' + encodeURIComponent(sessionId), null, auth);
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.found, true);
  assert.equal(reloaded.body.binding.runId, runIdValue);

  const scopes = [
    { destination: 'agent', providerRef: 'profile-agent', provider: 'openai', model: 'fake', routeHash: 'a'.repeat(64) },
    { destination: 'middle_brain', providerRef: 'profile-review', provider: 'openai', model: 'fake-review', routeHash: 'b'.repeat(64) }
  ];
  const grant = await request(port, 'POST', runPath + '/consents', {
    requestId: 'dsh-session-consent', expectedVersion: 1, projectRef: 'project_dsh_session',
    providerScopes: scopes, fileIds: ['file-synthetic'], memoryScope: null, memoryDerivedScope: null,
    expiresInMs: 60000, termsVersion: CONSENT_TERMS_VERSION, confirmed: true
  }, auth);
  assert.equal(grant.status, 200);
  const authorizedLink = await request(port, 'POST', linkPath, {
    sessionId: sessionId, consentId: grant.body.consent.consentId, expectedVersion: 1
  }, auth);
  assert.equal(authorizedLink.status, 200);
  assert.equal(authorizedLink.body.binding.consentId, grant.body.consent.consentId);

  const second = await request(port, 'POST', '/internal/work/runs', {
    requestId: 'dsh-session-second-run', workflowId: WORKFLOW, projectRef: 'project_dsh_session'
  }, auth);
  const reused = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(runId(second.body)) + '/dsh-session', {
    sessionId: sessionId, consentId: '', expectedVersion: 1
  }, auth);
  assert.equal(reused.status, 409, 'an active Run prevents another Run from taking over the DSH Session');
  const cleanupLinkedRun = await request(port, 'POST', runPath + '/cancel', {
    requestId: 'dsh-session-run-cleanup', expectedVersion: 1
  }, auth);
  assert.equal(cleanupLinkedRun.body.run.status, 'cancelled');
  const sequential = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(runId(second.body)) + '/dsh-session', {
    sessionId: sessionId, consentId: '', expectedVersion: 1
  }, auth);
  assert.equal(sequential.status, 200, 'a terminal Run allows a sequential Run in the same DSH Session');
  const history = await request(port, 'GET', '/internal/work/runs/dsh-sessions/' + encodeURIComponent(sessionId), null, auth);
  assert.equal(history.body.binding.runId, runId(second.body));
  assert.equal(history.body.runs.length, 2);
  const prior = await request(port, 'GET', '/internal/work/runs/dsh-sessions/' + encodeURIComponent(sessionId)
    + '?runId=' + encodeURIComponent(runIdValue), null, auth);
  assert.equal(prior.body.binding.runId, runIdValue, 'a historical DSH Run can be addressed directly');
  const cleanupSecondRun = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(runId(second.body)) + '/cancel', {
    requestId: 'dsh-session-second-cleanup', expectedVersion: 1
  }, auth);
  assert.equal(cleanupSecondRun.body.run.status, 'cancelled');
}

async function testProductionApi(dataDir, port) {
  let service = startProduction(dataDir, port);
  const auth = { 'X-IB-Home-Token': TOKEN };
  let savedRunId = null;
  let savedAgentMemoryId = null;
  const savedChatId = 'msg_work_run_chat_u';
  try {
    const health = await waitForHealth(port, 12000);
    assert(health, 'production Home Node should start: ' + service.output().slice(-500));
    await testDshSessionRunBinding(port, auth);

    const noAuth = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'unauth-create', workflowId: WORKFLOW, projectRef: 'project_private'
    });
    assert.strictEqual(noAuth.status, 401, 'private run API must inherit desktop token protection');
    const noAuthActive = await request(port, 'GET', '/internal/work/runs/active?limit=5');
    assert.strictEqual(noAuthActive.status, 401, 'active-run recovery query must inherit desktop token protection');
    const noAuthResults = await request(port, 'GET', '/internal/work/runs/results?limit=5');
    assert.strictEqual(noAuthResults.status, 401, 'Result index must inherit desktop token protection');
    const noAuthRetention = await request(port, 'GET', '/internal/work/retention');
    assert.strictEqual(noAuthRetention.status, 401, 'retention policy remains behind the desktop private API');
    const noAuthConsent = await request(port, 'POST', '/internal/work/runs/wr_12345678-1234-1234-1234-123456789012/consents', {});
    assert.strictEqual(noAuthConsent.status, 401, 'consent minting must inherit desktop-token protection');
    await testQueuedConsentSurvivesUiRefresh(port, auth);
    const noAuthAgentMemory = await request(port, 'GET', '/internal/agent-memory/records');
    assert.strictEqual(noAuthAgentMemory.status, 401, 'Agent Memory API must inherit desktop-token protection');
    const noAuthAgentMemoryWrite = await request(port, 'POST', '/internal/agent-memory/records', {});
    assert.strictEqual(noAuthAgentMemoryWrite.status, 401, 'Agent Memory writes must inherit desktop-token protection');
    const noAuthAgentMemoryPurge = await request(port, 'POST', '/internal/agent-memory/maintenance/purge', { limit: 5 });
    assert.strictEqual(noAuthAgentMemoryPurge.status, 401, 'Agent Memory lifecycle cleanup is private');
    const restorePreflight = await request(port, 'OPTIONS', '/internal/agent-memory/restore?expectedStoreRevision=0&confirmed=true', null, {
      Origin: 'http://127.0.0.1:3000',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-ib-home-token,x-ib-protocol'
    });
    assert.strictEqual(restorePreflight.status, 204);
    assert(restorePreflight.headers['access-control-allow-methods'].includes('POST'));
    assert(restorePreflight.headers['access-control-allow-headers'].toLowerCase().includes('content-type'));

    const unconfirmedAgentMemoryCreate = await request(port, 'POST', '/internal/agent-memory/records', {
      type: 'Project', projectRef: 'project_agent_memory', confirmed: false,
      payload: { name: 'Unconfirmed fixture' }, provenance: { sourceKind: 'user_explicit' }
    }, auth);
    assert.strictEqual(unconfirmedAgentMemoryCreate.status, 400,
      'the generic Authority create endpoint is not an unconfirmed write bypass');
    const agentMemoryCreate = await request(port, 'POST', '/internal/agent-memory/records', {
      type: 'Project', projectRef: 'project_agent_memory',
      payload: { name: 'Temporary isolated project', summary: 'A local memory fixture with no project source.' },
      provenance: { sourceKind: 'user_explicit', sourceRef: 'fixture_entry_1' }, confirmed: true
    }, auth);
    assert.strictEqual(agentMemoryCreate.status, 200);
    assert.strictEqual(agentMemoryCreate.body.record.type, 'Project');
    assert.strictEqual(agentMemoryCreate.body.record.revision, 1);
    savedAgentMemoryId = agentMemoryCreate.body.record.memoryId;
    const agentMemoryPhysicalDelete = await request(port, 'DELETE', '/internal/agent-memory/records/' + encodeURIComponent(savedAgentMemoryId), null, auth);
    assert.strictEqual(agentMemoryPhysicalDelete.status, 405,
      'record deletion is a versioned retract transition; no physical DELETE route exists');
    const agentMemoryQuery = await request(port, 'GET', '/internal/agent-memory/records?projectRef=project_agent_memory&status=active', null, auth);
    assert.strictEqual(agentMemoryQuery.status, 200);
    assert(agentMemoryQuery.body.records.some(record => record.memoryId === savedAgentMemoryId));
    const agentMemoryQueryLimit = await request(port, 'GET', '/internal/agent-memory/records?limit=101', null, auth);
    assert.strictEqual(agentMemoryQueryLimit.status, 400, 'Agent Memory query is bounded');
    const unconfirmedAgentMemoryUpdate = await request(port, 'POST', '/internal/agent-memory/records/' + encodeURIComponent(savedAgentMemoryId) + '/update', {
      expectedRevision: 1, payload: { name: 'Unconfirmed edit' }, provenance: { sourceKind: 'user_explicit' }
    }, auth);
    assert.strictEqual(unconfirmedAgentMemoryUpdate.status, 400,
      'generic update cannot bypass the explicit confirmation marker');
    const agentMemoryUpdate = await request(port, 'POST', '/internal/agent-memory/records/' + encodeURIComponent(savedAgentMemoryId) + '/update', {
      expectedRevision: 1,
      payload: { name: 'Temporary isolated project', summary: 'Revision two.' },
      provenance: { sourceKind: 'user_explicit', sourceRef: 'fixture_entry_2' }, confirmed: true
    }, auth);
    assert.strictEqual(agentMemoryUpdate.status, 200);
    assert.strictEqual(agentMemoryUpdate.body.record.revision, 2);
    const agentMemoryStale = await request(port, 'POST', '/internal/agent-memory/records/' + encodeURIComponent(savedAgentMemoryId) + '/update', {
      expectedRevision: 1,
      payload: { name: 'Temporary isolated project', summary: 'Stale overwrite.' },
      provenance: { sourceKind: 'user_explicit', sourceRef: 'fixture_entry_3' }, confirmed: true
    }, auth);
    assert.strictEqual(agentMemoryStale.status, 409);
    assert.strictEqual(agentMemoryStale.body.error, 'version-conflict');
    const agentMemorySensitive = await request(port, 'POST', '/internal/agent-memory/records', {
      type: 'Fact', projectRef: 'project_agent_memory',
      payload: { statement: 'API_KEY=synthetic-agent-memory-key-123456' },
      provenance: { sourceKind: 'user_explicit' }, confirmed: true
    }, auth);
    assert.strictEqual(agentMemorySensitive.status, 400, 'sensitive credential-shaped memory is rejected');
    const decisionCreate = await request(port, 'POST', '/internal/agent-memory/records', {
      type: 'Decision', projectRef: 'project_agent_memory',
      payload: { statement: 'Use separate storage.' },
      provenance: { sourceKind: 'user_explicit', sourceRef: 'decision_1' }, confirmed: true
    }, auth);
    const oldDecisionId = decisionCreate.body.record.memoryId;
    const decisionSupersede = await request(port, 'POST', '/internal/agent-memory/records/' + encodeURIComponent(oldDecisionId) + '/supersede', {
      expectedRevision: 1,
      payload: { statement: 'Keep storage and indexes isolated.', rationale: 'Separate authority.' },
      provenance: { sourceKind: 'user_explicit', sourceRef: 'decision_2' }, confirmed: true
    }, auth);
    assert.strictEqual(decisionSupersede.status, 200);
    assert.strictEqual(decisionSupersede.body.previous.status, 'superseded');
    const decisionRetract = await request(port, 'POST', '/internal/agent-memory/records/' + encodeURIComponent(decisionSupersede.body.record.memoryId) + '/retract', {
      expectedRevision: 1, reasonCode: 'obsolete', provenance: { sourceKind: 'user_explicit', sourceRef: 'decision_3' }, confirmed: true
    }, auth);
    assert.strictEqual(decisionRetract.status, 200);
    assert.strictEqual(decisionRetract.body.record.status, 'retracted');
    assert.strictEqual(decisionRetract.body.record.payload, null);
    const agentMemoryPurge = await request(port, 'POST', '/internal/agent-memory/maintenance/purge', { limit: 10 }, auth);
    assert.strictEqual(agentMemoryPurge.status, 200);
    assert.strictEqual(agentMemoryPurge.body.purged, 0, 'recent tombstones remain within lifecycle retention');

    const agentMemoryState = await request(port, 'GET', '/internal/agent-memory/state', null, auth);
    const backupCreate = await request(port, 'POST', '/internal/agent-memory/backups', {}, auth);
    assert.strictEqual(backupCreate.status, 200);
    const backupId = backupCreate.body.backup.backupId;
    assert.match(backupId, /^amb_[A-Za-z0-9-]{36}$/);
    assert.strictEqual(backupCreate.body.backup.schemaVersion, 2);
    const backupList = await request(port, 'GET', '/internal/agent-memory/backups?limit=10', null, auth);
    assert(backupList.body.backups.some(item => item.backupId === backupId));
    const exported = await requestBytes(port, 'GET', '/internal/agent-memory/backups/' + encodeURIComponent(backupId) + '/export', null, auth);
    assert.strictEqual(exported.status, 200);
    assert.strictEqual(exported.headers['content-type'], 'application/vnd.sqlite3');
    assert.strictEqual(exported.headers['content-disposition'], 'attachment; filename="' + backupId + '.db"');
    assert(exported.body.length > 512, 'export returns a validated SQLite backup file');

    const conflictSource = await request(port, 'POST', '/internal/agent-memory/records', {
      type: 'Fact', projectRef: 'project_agent_memory',
      payload: { statement: 'A post-snapshot mutation.' }, provenance: { sourceKind: 'user_explicit', sourceRef: 'later_fact' }, confirmed: true
    }, auth);
    assert.strictEqual(conflictSource.status, 200);
    const beforeRestoreState = await request(port, 'GET', '/internal/agent-memory/state', null, auth);
    const staleRestore = await request(port, 'POST', '/internal/agent-memory/backups/' + encodeURIComponent(backupId) + '/restore', {
      expectedStoreRevision: agentMemoryState.body.state.storeRevision, confirmed: true
    }, auth);
    assert.strictEqual(staleRestore.status, 409, 'restore CAS rejects intervening Agent Memory writes');
    assert.strictEqual(staleRestore.body.storeRevision, beforeRestoreState.body.state.storeRevision);
    const localRestore = await request(port, 'POST', '/internal/agent-memory/backups/' + encodeURIComponent(backupId) + '/restore', {
      expectedStoreRevision: beforeRestoreState.body.state.storeRevision, confirmed: true
    }, auth);
    assert.strictEqual(localRestore.status, 200);
    assert.strictEqual(localRestore.body.restored, true);
    const afterLocalRestore = await request(port, 'GET', '/internal/agent-memory/state', null, auth);
    assert.strictEqual(afterLocalRestore.body.state.storeRevision, beforeRestoreState.body.state.storeRevision + 1);
    assert.strictEqual((await request(port, 'GET', '/internal/agent-memory/records/' + encodeURIComponent(conflictSource.body.record.memoryId), null, auth)).status, 404,
      'restore replaces the snapshot as a whole and never merges newer records');

    const uploadRestore = await requestBytes(port, 'POST', '/internal/agent-memory/restore?expectedStoreRevision=' +
      encodeURIComponent(String(afterLocalRestore.body.state.storeRevision)) + '&confirmed=true', exported.body, auth);
    assert.strictEqual(uploadRestore.status, 200, uploadRestore.body.toString('utf8'));
    assert.strictEqual(JSON.parse(uploadRestore.body.toString('utf8')).restored, true);
    const afterUploadRestore = await request(port, 'GET', '/internal/agent-memory/state', null, auth);
    assert.strictEqual(afterUploadRestore.body.state.storeRevision, afterLocalRestore.body.state.storeRevision + 1);
    assert.strictEqual((await request(port, 'DELETE', '/internal/agent-memory/backups/' + encodeURIComponent(backupId), null, auth)).status, 200);
    assert.strictEqual((await request(port, 'POST', '/internal/agent-memory/backups/cleanup', { limit: 10 }, auth)).status, 200);

    const leaked = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'invalid-secret',
      workflowId: WORKFLOW,
      projectRef: 'project_private',
      prompt: SENTINEL,
      apiKey: SENTINEL
    }, auth);
    assert.strictEqual(leaked.status, 400, 'unknown and secret-bearing fields must be rejected');

    const createBody = { requestId: 'create-main', workflowId: WORKFLOW, projectRef: 'project_alpha' };
    const created = await request(port, 'POST', '/internal/work/runs', createBody, auth);
    assert.strictEqual(created.status, 200);
    assert.strictEqual(created.body.run.workflowId, WORKFLOW);
    assert.strictEqual(created.body.run.status, 'queued');
    assert.strictEqual(created.body.run.version, 1);
    savedRunId = runId(created.body);
    const noAuthResult = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/result');
    assert.strictEqual(noAuthResult.status, 401, 'Work Result reads must inherit desktop-token protection');
    const activeRuns = await request(port, 'GET', '/internal/work/runs/active?limit=10', null, auth);
    assert.strictEqual(activeRuns.status, 200);
    assert.strictEqual(activeRuns.body.hasMore, false);
    assert(activeRuns.body.runs.some(run => run.runId === savedRunId && run.status === 'queued'));
    const activeLimitDenied = await request(port, 'GET', '/internal/work/runs/active?limit=101', null, auth);
    assert.strictEqual(activeLimitDenied.status, 400, 'recovery query must remain bounded');
    const resultLimitDenied = await request(port, 'GET', '/internal/work/runs/results?limit=101', null, auth);
    assert.strictEqual(resultLimitDenied.status, 400, 'Result index remains bounded');

    const duplicate = await request(port, 'POST', '/internal/work/runs', createBody, auth);
    assert.strictEqual(duplicate.status, 200);
    assert.strictEqual(duplicate.body.duplicate, true);
    assert.strictEqual(runId(duplicate.body), savedRunId);

    const keyConflict = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'create-main', workflowId: WORKFLOW, projectRef: 'project_other'
    }, auth);
    assert.strictEqual(keyConflict.status, 409);
    assert.strictEqual(keyConflict.body.error, 'idempotency-conflict');

    const invalidEdge = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/transition', {
      requestId: 'invalid-edge', expectedVersion: 1, status: 'completed', reasonCode: 'runtime_completed'
    }, auth);
    assert.strictEqual(invalidEdge.status, 409);
    assert.strictEqual(invalidEdge.body.error, 'result-required', 'a Run cannot complete without an atomic Work Result Artifact');

    const startBody = {
      requestId: 'start-main', expectedVersion: 1, status: 'running', reasonCode: 'runtime_started'
    };
    const start = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/transition', startBody, auth);
    assert.strictEqual(start.status, 200);
    assert.strictEqual(start.body.run.version, 2);

    const stale = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/transition', {
      requestId: 'stale-main', expectedVersion: 1, status: 'failed', reasonCode: 'runtime_failed'
    }, auth);
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.error, 'version-conflict');
    assert.strictEqual(stale.body.run.version, 2);

    const chat = await request(port, 'POST', '/messages', {
      message: {
        id: savedChatId,
        role: 'user',
        content: 'synthetic chat authority regression',
        friendId: 'char_work_run',
        timestamp: 1800000000001
      }
    }, auth);
    assert.strictEqual(chat.status, 200, 'existing Chat canonical write remains available');

    const events = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/events?afterSequence=0&limit=10', null, auth);
    assert.strictEqual(events.status, 200);
    assert.deepStrictEqual(events.body.events.map(event => event.sequence), [1, 2]);
    assert.deepStrictEqual(Object.keys(events.body.events[0]).sort(), [
      'createdAt', 'eventType', 'fromStatus', 'reasonCode', 'sequence', 'toStatus', 'version'
    ]);

    const actionTrace = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/events', {
      requestId: 'wm_12345678-1234-4234-8234-123456789015', actionId: 'ib.work.plan.v1', status: 'succeeded', authorityResult: 'allowed'
    }, auth);
    assert.strictEqual(actionTrace.status, 200);
    assert.strictEqual(actionTrace.body.event.eventType, 'action_trace');
    const actionEvents = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/events?afterSequence=0&limit=10', null, auth);
    assert.strictEqual(actionEvents.status, 200);
    assert.deepStrictEqual(actionEvents.body.events[2].actionTrace, {
      schemaVersion: 1, actionId: 'ib.work.plan.v1', requestId: 'wm_12345678-1234-4234-8234-123456789015', runId: savedRunId,
      status: 'succeeded', authorityResult: 'allowed'
    });
    const untrustedTrace = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/events', {
      requestId: 'wm_12345678-1234-4234-8234-123456789016', actionId: 'ib.work.plan.v1', status: 'succeeded', authorityResult: 'allowed',
      memoryContent: 'MUST_NOT_BE_PERSISTED'
    }, auth);
    assert.strictEqual(untrustedTrace.status, 400, 'Trace inputs reject any non-metadata field');
    assert.strictEqual(JSON.stringify(actionEvents.body).includes('MUST_NOT_BE_PERSISTED'), false);

    const racingRun = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'race-create', workflowId: WORKFLOW, projectRef: 'project_cas'
    }, auth);
    assert.strictEqual(racingRun.status, 200);
    const raceId = runId(racingRun.body);
    const race = await Promise.all([
      request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(raceId) + '/transition', {
        requestId: 'race-start', expectedVersion: 1, status: 'running', reasonCode: 'runtime_started'
      }, auth),
      request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(raceId) + '/transition', {
        requestId: 'race-fail', expectedVersion: 1, status: 'failed', reasonCode: 'runtime_failed'
      }, auth)
    ]);
    assert.deepStrictEqual(race.map(result => result.status).sort(), [200, 409]);
    assert.strictEqual(race.find(result => result.status === 409).body.error, 'version-conflict');

    const cancelCreate = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'cancel-create', workflowId: WORKFLOW, projectRef: 'project_cancel'
    }, auth);
    const cancelId = runId(cancelCreate.body);
    const cancelStart = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(cancelId) + '/transition', {
      requestId: 'cancel-start', expectedVersion: 1, status: 'running', reasonCode: 'runtime_started'
    }, auth);
    assert.strictEqual(cancelStart.status, 200);
    const cancelRequest = { requestId: 'cancel-request', expectedVersion: 2 };
    const cancel = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(cancelId) + '/cancel', cancelRequest, auth);
    assert.strictEqual(cancel.status, 200);
    assert.strictEqual(cancel.body.run.status, 'cancel_requested');
    const cancelDuplicate = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(cancelId) + '/cancel', cancelRequest, auth);
    assert.strictEqual(cancelDuplicate.status, 200);
    assert.strictEqual(cancelDuplicate.body.duplicate, true);
    const cancelNoOp = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(cancelId) + '/cancel', {
      requestId: 'cancel-noop', expectedVersion: 3
    }, auth);
    assert.strictEqual(cancelNoOp.status, 200);
    assert.strictEqual(cancelNoOp.body.noOp, true);
    assert.strictEqual(cancelNoOp.body.run.version, 3);
    const acknowledge = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(cancelId) + '/transition', {
      requestId: 'cancel-ack', expectedVersion: 3, status: 'cancelled', reasonCode: 'runtime_cancelled'
    }, auth);
    assert.strictEqual(acknowledge.status, 200);
    assert.strictEqual(acknowledge.body.run.version, 4);
    const terminalCancel = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(cancelId) + '/cancel', {
      requestId: 'cancel-terminal', expectedVersion: 4
    }, auth);
    assert.strictEqual(terminalCancel.status, 409);
    assert.strictEqual(terminalCancel.body.error, 'run-terminal');
    const cancelEvents = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(cancelId) + '/events?afterSequence=0&limit=10', null, auth);
    assert.deepStrictEqual(cancelEvents.body.events.map(event => event.sequence), [1, 2, 3, 4],
      'cancel no-op and terminal cancel must not append state events');

    const resultCreate = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'result-run-create', workflowId: WORKFLOW, projectRef: 'project_result'
    }, auth);
    const resultRunId = runId(resultCreate.body);
    const providerScopes = [
      { destination: 'agent', providerRef: 'profile_agent', provider: 'openai', model: 'gpt-mock', routeHash: 'a'.repeat(64) },
      { destination: 'middle_brain', providerRef: 'profile_middle', provider: 'openai', model: 'mb-mock', routeHash: 'b'.repeat(64) }
    ];
    const consentBody = {
      requestId: 'result-consent', expectedVersion: 1, projectRef: 'project_result',
      providerScopes: providerScopes, fileIds: ['pf_source'],
      memoryScope: {
        projectRef: 'project_result', providerScope: providerScopes[0],
        refs: [{ memoryId: 'am_12345678-1234-1234-1234-123456789012', revision: 2, contentHash: 'c'.repeat(64) }],
        contextHash: 'd'.repeat(64), contextChars: 640
      },
      memoryDerivedScope: derivedScope('project_result', 'd'.repeat(64), providerScopes[1]),
      expiresInMs: 60000,
      termsVersion: CONSENT_TERMS_VERSION, confirmed: true
    };
    const consentResponse = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents', consentBody, auth);
    assert.strictEqual(consentResponse.status, 200);
    assert.strictEqual(consentResponse.body.run.version, 1, 'consent is not a Run status Event');
    assert.strictEqual(consentResponse.body.consent.confirmationMethod, 'explicit_user_action');
    assert.deepStrictEqual(consentResponse.body.consent.fileIds, ['pf_source']);
    assert.deepStrictEqual(consentResponse.body.consent.memoryScope, consentBody.memoryScope,
      'Home Node persists only the selected memory refs/hash and Agent route scope');
    assert.deepStrictEqual(consentResponse.body.consent.memoryDerivedScope, consentBody.memoryDerivedScope,
      'the same Ledger separately binds Review route and explicit plaintext Result persistence');
    assert(!JSON.stringify(consentResponse.body.consent.memoryScope).includes('parser contract'),
      'Consent metadata never stores memory plaintext');
    const consentId = consentResponse.body.consent.consentId;
    const consentDuplicate = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents', consentBody, auth);
    assert.strictEqual(consentDuplicate.body.duplicate, true);
    assert.strictEqual(consentDuplicate.body.consent.consentId, consentId);
    const consentDenied = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents', {
      ...consentBody, requestId: 'result-consent-unconfirmed', confirmed: false
    }, auth);
    assert.strictEqual(consentDenied.status, 400, 'grant endpoint requires an explicit confirmation attestation');
    const derivedScopeOmitted = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents', {
      ...consentBody, requestId: 'result-consent-derived-scope-omitted', memoryDerivedScope: null
    }, auth);
    assert.strictEqual(derivedScopeOmitted.status, 400,
      'Agent Memory consent cannot be granted without independent Review and plaintext Result scopes');
    const wrongProvider = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents/' + encodeURIComponent(consentId) + '/check', {
      projectRef: 'project_result',
      providerScope: { ...providerScopes[0], routeHash: 'c'.repeat(64) },
      fileIds: ['pf_source'], consumer: 'agent', memoryScope: consentBody.memoryScope
    }, auth);
    assert.strictEqual(wrongProvider.status, 409, 'memory route authorization must match the Agent Provider route');
    const wrongFile = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents/' + encodeURIComponent(consentId) + '/check', {
      projectRef: 'project_result', providerScope: providerScopes[0], fileIds: ['pf_other'], consumer: 'agent', memoryScope: consentBody.memoryScope
    }, auth);
    assert.strictEqual(wrongFile.status, 409, 'a file outside the consent scope is denied');
    const consentCheck = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents/' + encodeURIComponent(consentId) + '/check', {
      projectRef: 'project_result', providerScope: providerScopes[0], fileIds: ['pf_source'], consumer: 'agent', memoryScope: consentBody.memoryScope
    }, auth);
    assert.strictEqual(consentCheck.status, 200);
    assert.strictEqual(consentCheck.body.consent.status, 'active');
    const memoryProvenanceBefore = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/memory-provenance', null, auth);
    assert.strictEqual(memoryProvenanceBefore.status, 200);
    assert.strictEqual(memoryProvenanceBefore.body.consent.status, 'active');
    assert.deepStrictEqual(memoryProvenanceBefore.body.consent.memoryScope, {
      projectRef: 'project_result', refs: consentBody.memoryScope.refs,
      contextHash: consentBody.memoryScope.contextHash, contextChars: consentBody.memoryScope.contextChars
    });
    assert.deepStrictEqual(memoryProvenanceBefore.body.consent.memoryDerivedScope, {
      contextHash: consentBody.memoryDerivedScope.contextHash, reviewConfirmed: true, resultConfirmed: true
    });
    assert.strictEqual(JSON.stringify(memoryProvenanceBefore.body).includes('parser contract'), false,
      'Memory Provenance exposes only consent references and hashes, never Memory content or Provider routes');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(memoryProvenanceBefore.body.consent.memoryScope, 'providerScope'), false);
    const changedMemoryScope = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents/' + encodeURIComponent(consentId) + '/check', {
      projectRef: 'project_result', providerScope: providerScopes[0], fileIds: ['pf_source'],
      consumer: 'agent', memoryScope: Object.assign({}, consentBody.memoryScope, { contextHash: 'e'.repeat(64) })
    }, auth);
    assert.strictEqual(changedMemoryScope.status, 409,
      'a changed memory content scope is rejected even while Provider route and files match');
    const middleBrainMemoryCheck = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents/' + encodeURIComponent(consentId) + '/check', {
      projectRef: 'project_result', providerScope: providerScopes[1], fileIds: ['pf_source'], consumer: 'middle_brain_review'
    }, auth);
    assert.strictEqual(middleBrainMemoryCheck.status, 200,
      'the Review consumer is separately authorized only for the exact persisted Middle Brain route');

    const resultStart = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/transition', {
      requestId: 'result-run-start', expectedVersion: 1, status: 'running', reasonCode: 'runtime_started'
    }, auth);
    assert.strictEqual(resultStart.status, 200);
    const resultRequest = {
      requestId: 'result-run-complete', expectedVersion: 2, consentId: consentId,
      result: {
        schemaVersion: 1,
        summary: 'Audit complete API_TOKEN="synthetic-result-secret-123"',
        findings: [{
          fileId: 'pf_source', path: 'src/index.js', line: 4, severity: 'medium',
          title: 'Authorization: Bearer synthetic-result-bearer-456',
          detail: 'The report is structured, scoped, and reviewed.'
        }]
      }
    };
    const attemptedDerivedFlagBypass = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/complete', {
      ...resultRequest, requestId: 'result-run-complete-derived-flag-bypass', memoryDerived: false
    }, auth);
    assert.strictEqual(attemptedDerivedFlagBypass.status, 400,
      'callers cannot downgrade a memory-enabled Run by claiming its report is not derived');
    const completedResult = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/complete', resultRequest, auth);
    assert.strictEqual(completedResult.status, 200);
    assert.strictEqual(completedResult.body.run.status, 'completed');
    assert.strictEqual(completedResult.body.run.version, 3);
    assert.strictEqual(completedResult.body.result.status, 'available');
    assert.strictEqual(completedResult.body.result.memoryDerived, true);
    assert.strictEqual(completedResult.body.result.memoryContextHash, consentBody.memoryScope.contextHash);
    assert(completedResult.body.result.report.summary.includes('[REDACTED]'));
    assert(completedResult.body.result.report.findings[0].title.includes('[REDACTED]'));
    assert(!JSON.stringify(completedResult.body.result).includes('synthetic-result-secret-123'));
    const completeDuplicate = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/complete', resultRequest, auth);
    assert.strictEqual(completeDuplicate.status, 200);
    assert.strictEqual(completeDuplicate.body.duplicate, true);
    const completedConsent = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/consents/' + encodeURIComponent(consentId), null, auth);
    assert.strictEqual(completedConsent.body.consent.status, 'revoked');
    assert.strictEqual(completedConsent.body.consent.revocationReason, 'run_completed');
    const memoryProvenanceAfter = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/memory-provenance', null, auth);
    assert.strictEqual(memoryProvenanceAfter.body.consent.status, 'revoked', 'the view reflects the authoritative post-Run Consent state');
    assert.strictEqual(memoryProvenanceAfter.body.result.memoryDerived, true);
    assert.strictEqual(memoryProvenanceAfter.body.result.memoryContextHash, consentBody.memoryScope.contextHash);
    const savedResult = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/result', null, auth);
    assert.strictEqual(savedResult.body.result.resultId, completedResult.body.result.resultId);
    const resultReference = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/result/reference', {
      resultRunId: resultRunId, resultId: completedResult.body.result.resultId
    }, auth);
    assert.strictEqual(resultReference.status, 200);
    assert.strictEqual(resultReference.body.result.report.summary, completedResult.body.result.report.summary);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(resultReference.body.result, 'memoryContextHash'), false,
      'Result reference reads do not expose Memory provenance metadata');
    assert.strictEqual(JSON.stringify(resultReference.body).includes('synthetic-result-secret-123'), false);
    const outsideRun = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'result-reference-outside-create', workflowId: WORKFLOW, projectRef: 'project_elsewhere'
    }, auth);
    assert.strictEqual(outsideRun.status, 200);
    const outsideRunStarted = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(outsideRun.body.run.runId) + '/transition', {
      requestId: 'result-reference-outside-start', expectedVersion: 1, status: 'running', reasonCode: 'runtime_started'
    }, auth);
    assert.strictEqual(outsideRunStarted.status, 200);
    const outsideReference = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/result/reference', {
      resultRunId: outsideRun.body.run.runId, resultId: 'wrres_unavailable_revision'
    }, auth);
    assert.strictEqual(outsideReference.status, 403,
      'a different-project Result reference is rejected before its Artifact content is read');
    const resultIndex = await request(port, 'GET', '/internal/work/runs/results?limit=10', null, auth);
    assert.strictEqual(resultIndex.status, 200);
    const indexed = resultIndex.body.results.find(item => item.runId === resultRunId);
    assert(indexed, 'the authority lists persisted Work Result metadata after refresh');
    assert.strictEqual(indexed.resultStatus, 'available');
    assert.strictEqual(indexed.memoryDerived, true, 'the metadata-only Result index preserves the conservative classification');
    assert.strictEqual(indexed.memoryContextHash, consentBody.memoryScope.contextHash);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(indexed, 'report'), false,
      'Result index never leaks the artifact body');
    assert.strictEqual(JSON.stringify(indexed).includes('synthetic-result-secret-123'), false);
    const candidateRevision = await request(port, 'GET', '/internal/agent-memory/state', null, auth);
    const candidateBody = {
      runId: resultRunId, resultId: completedResult.body.result.resultId,
      selectionRef: 'finding:0', expectedStoreRevision: candidateRevision.body.state.storeRevision,
      confirmed: true
    };
    const unconfirmedCandidate = await request(port, 'POST', '/internal/agent-memory/work-results/candidates/commit', {
      ...candidateBody, confirmed: false
    }, auth);
    assert.strictEqual(unconfirmedCandidate.status, 400,
      'Work Result candidate API refuses writes without explicit confirmation');
    const crossProjectCandidate = await request(port, 'POST', '/internal/agent-memory/work-results/candidates/commit', {
      ...candidateBody, projectRef: 'project_elsewhere'
    }, auth);
    assert.strictEqual(crossProjectCandidate.status, 400,
      'candidate caller cannot override the project bound to the Home Node Result');
    const wrongResultCandidate = await request(port, 'POST', '/internal/agent-memory/work-results/candidates/commit', {
      ...candidateBody, resultId: 'wrr_unrelated_result'
    }, auth);
    assert.strictEqual(wrongResultCandidate.status, 409,
      'candidate source must match the Result attached to the requested Run');
    const sensitiveCandidate = await request(port, 'POST', '/internal/agent-memory/work-results/candidates/commit', {
      ...candidateBody, selectionRef: 'summary'
    }, auth);
    assert.strictEqual(sensitiveCandidate.status, 400,
      'a sanitized-but-credential-shaped Result summary is still rejected by Agent Memory');
    const revisionAfterSensitiveReject = await request(port, 'GET', '/internal/agent-memory/state', null, auth);
    assert.strictEqual(revisionAfterSensitiveReject.body.state.storeRevision, candidateRevision.body.state.storeRevision,
      'sensitive candidate rejection leaves Agent Memory unchanged');
    const savedCandidate = await request(port, 'POST', '/internal/agent-memory/work-results/candidates/commit', candidateBody, auth);
    assert.strictEqual(savedCandidate.status, 200);
    assert.strictEqual(savedCandidate.body.record.type, 'Observation');
    assert.strictEqual(savedCandidate.body.record.projectRef, 'project_result');
    assert.strictEqual(savedCandidate.body.record.provenance[0].sourceKind, 'work_result_ref');
    assert.strictEqual(savedCandidate.body.record.provenance[0].sourceRef, completedResult.body.result.resultId);
    assert.strictEqual(savedCandidate.body.record.provenance[0].selectionRef, 'finding:0');
    assert.strictEqual(savedCandidate.body.record.payload.contextRef, 'wm:finding:0');
    assert.strictEqual(savedCandidate.body.record.payload.statement,
      'medium · Authorization: Bearer [REDACTED]: The report is structured, scoped, and reviewed.');
    assert(savedCandidate.body.record.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000,
      'the confirmed Work Result Observation uses the frozen 30-day default');
    const duplicateCandidate = await request(port, 'POST', '/internal/agent-memory/work-results/candidates/commit', candidateBody, auth);
    assert.strictEqual(duplicateCandidate.status, 200);
    assert.strictEqual(duplicateCandidate.body.duplicate, true,
      'retrying the same Result selection returns the original record instead of duplicating it');
    assert.strictEqual(duplicateCandidate.body.record.memoryId, savedCandidate.body.record.memoryId);
    const procedureRevision = await request(port, 'GET', '/internal/agent-memory/state', null, auth);
    const procedureCandidateBody = {
      runId: resultRunId,
      resultId: completedResult.body.result.resultId,
      resultSchemaVersion: completedResult.body.result.schemaVersion,
      expectedStoreRevision: procedureRevision.body.state.storeRevision,
      confirmed: true,
      payload: {
        name: 'Review a bounded project change',
        steps: ['Inspect the selected diff.', 'Run the focused regression.'],
        whenToUse: 'Before accepting a small code change.'
      }
    };
    const unconfirmedProcedure = await request(port, 'POST', '/internal/agent-memory/work-results/procedure-candidates/commit', {
      ...procedureCandidateBody, confirmed: false
    }, auth);
    assert.strictEqual(unconfirmedProcedure.status, 400,
      'Procedure candidate API refuses writes without explicit confirmation');
    const overriddenProcedure = await request(port, 'POST', '/internal/agent-memory/work-results/procedure-candidates/commit', {
      ...procedureCandidateBody, projectRef: 'project_elsewhere'
    }, auth);
    assert.strictEqual(overriddenProcedure.status, 400,
      'Procedure candidate caller cannot override the project bound to the Home Node Run');
    const wrongProcedureSchema = await request(port, 'POST', '/internal/agent-memory/work-results/procedure-candidates/commit', {
      ...procedureCandidateBody, resultSchemaVersion: procedureCandidateBody.resultSchemaVersion + 1
    }, auth);
    assert.strictEqual(wrongProcedureSchema.status, 409,
      'Procedure source schema must match the current Home Node Result');
    const unsafeProcedure = await request(port, 'POST', '/internal/agent-memory/work-results/procedure-candidates/commit', {
      ...procedureCandidateBody,
      payload: { name: 'Unsafe Procedure', steps: ['Use token sk-agent-memory-secret-sentinel-123456789.'] }
    }, auth);
    assert.strictEqual(unsafeProcedure.status, 400, 'Procedure content uses the Agent Memory sensitive-content guard');
    const incompleteProcedure = await request(port, 'POST', '/internal/agent-memory/work-results/procedure-candidates/commit', {
      ...procedureCandidateBody,
      payload: { name: 'Incomplete Procedure', steps: ['Inspect the selected diff.'] }
    }, auth);
    assert.strictEqual(incompleteProcedure.status, 400, 'the source-bound candidate requires name, steps, and whenToUse');
    const procedureSaved = await request(port, 'POST', '/internal/agent-memory/work-results/procedure-candidates/commit', procedureCandidateBody, auth);
    assert.strictEqual(procedureSaved.status, 200);
    assert.strictEqual(procedureSaved.body.record.type, 'Procedure');
    assert.strictEqual(procedureSaved.body.record.projectRef, 'project_result');
    assert.deepStrictEqual(procedureSaved.body.record.payload, procedureCandidateBody.payload);
    assert.strictEqual(procedureSaved.body.record.provenance[0].sourceKind, 'work_result_ref');
    assert.strictEqual(procedureSaved.body.record.provenance[0].sourceRef, completedResult.body.result.resultId);
    assert.strictEqual(procedureSaved.body.record.provenance[0].sourceRunId, resultRunId);
    assert(/^procedure:[a-f0-9]{64}$/.test(procedureSaved.body.record.provenance[0].selectionRef));
    const procedureDuplicate = await request(port, 'POST', '/internal/agent-memory/work-results/procedure-candidates/commit', procedureCandidateBody, auth);
    assert.strictEqual(procedureDuplicate.status, 200);
    assert.strictEqual(procedureDuplicate.body.duplicate, true,
      'retrying the same Procedure payload and result source is idempotent');
    assert.strictEqual(procedureDuplicate.body.record.memoryId, procedureSaved.body.record.memoryId);
    const resultEvents = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/events?afterSequence=0&limit=10', null, auth);
    assert.deepStrictEqual(resultEvents.body.events.map(event => event.toStatus), ['queued', 'running', 'completed']);
    const deleteBody = { requestId: 'result-delete', expectedVersion: 3 };
    const resultDelete = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/result/delete', deleteBody, auth);
    assert.strictEqual(resultDelete.status, 200);
    assert.strictEqual(resultDelete.body.result.status, 'deleted');
    assert.strictEqual(resultDelete.body.result.report, null);
    assert.strictEqual(resultDelete.body.run.version, 3, 'deleting a Result does not rewrite terminal Run history');
    const deletedIndex = await request(port, 'GET', '/internal/work/runs/results?limit=10', null, auth);
    assert.strictEqual(deletedIndex.body.results.find(item => item.runId === resultRunId).resultStatus, 'deleted');
    const resultDeleteDuplicate = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(resultRunId) + '/result/delete', deleteBody, auth);
    assert.strictEqual(resultDeleteDuplicate.body.duplicate, true);
    const candidateAfterDelete = await request(port, 'POST', '/internal/agent-memory/work-results/candidates/commit', {
      ...candidateBody, selectionRef: 'summary'
    }, auth);
    assert.strictEqual(candidateAfterDelete.status, 404, 'a deleted Result cannot mint new memory candidates');
    const procedureAfterDelete = await request(port, 'POST', '/internal/agent-memory/work-results/procedure-candidates/commit', procedureCandidateBody, auth);
    assert.strictEqual(procedureAfterDelete.status, 404, 'a deleted Result cannot mint new Procedure candidates');
    const candidateSurvivesResultDelete = await request(port, 'GET', '/internal/agent-memory/records/' + encodeURIComponent(savedCandidate.body.record.memoryId), null, auth);
    assert.strictEqual(candidateSurvivesResultDelete.body.record.status, 'active',
      'deleting Work Result does not silently mutate its previously confirmed Agent Memory entry');
    const procedureSurvivesResultDelete = await request(port, 'GET', '/internal/agent-memory/records/' + encodeURIComponent(procedureSaved.body.record.memoryId), null, auth);
    assert.strictEqual(procedureSurvivesResultDelete.body.record.status, 'active',
      'deleting Work Result does not silently mutate its previously confirmed Procedure');

    const revokeRunResponse = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'consent-revoke-run-create', workflowId: WORKFLOW, projectRef: 'project_revoke'
    }, auth);
    const revokeRunId = runId(revokeRunResponse.body);
    const revokeGrant = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(revokeRunId) + '/consents', {
      requestId: 'consent-revoke-grant', expectedVersion: 1, projectRef: 'project_revoke',
      providerScopes: providerScopes, fileIds: ['pf_revoke'], memoryScope: null, expiresInMs: 60000,
      memoryDerivedScope: null,
      termsVersion: CONSENT_TERMS_VERSION, confirmed: true
    }, auth);
    const revokeConsentId = revokeGrant.body.consent.consentId;
    const revoked = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(revokeRunId) + '/consents/' + encodeURIComponent(revokeConsentId) + '/revoke', {
      requestId: 'consent-revoke-explicit', expectedVersion: 1
    }, auth);
    assert.strictEqual(revoked.status, 200);
    assert.strictEqual(revoked.body.consent.status, 'revoked');
    assert.strictEqual(revoked.body.consent.revocationReason, 'user_revoked');
    const afterRevoke = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(revokeRunId) + '/consents/' + encodeURIComponent(revokeConsentId) + '/check', {
      projectRef: 'project_revoke', providerScope: providerScopes[0], fileIds: ['pf_revoke'], consumer: 'agent', memoryScope: null
    }, auth);
    assert.strictEqual(afterRevoke.status, 409);
    assert.strictEqual(afterRevoke.body.error, 'consent-revoked');

    const derivedRevokeCreate = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'derived-result-revoke-create', workflowId: WORKFLOW, projectRef: 'project_derived_revoke'
    }, auth);
    const derivedRevokeRunId = runId(derivedRevokeCreate.body);
    const derivedMemoryScope = {
      projectRef: 'project_derived_revoke', providerScope: providerScopes[0],
      refs: [{ memoryId: 'am_12345678-1234-1234-1234-123456789012', revision: 1, contentHash: 'f'.repeat(64) }],
      contextHash: 'e'.repeat(64), contextChars: 420
    };
    const derivedRevokeGrant = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(derivedRevokeRunId) + '/consents', {
      requestId: 'derived-result-revoke-grant', expectedVersion: 1, projectRef: 'project_derived_revoke',
      providerScopes: providerScopes, fileIds: ['pf_source'], memoryScope: derivedMemoryScope,
      memoryDerivedScope: derivedScope('project_derived_revoke', derivedMemoryScope.contextHash, providerScopes[1]),
      expiresInMs: 60000, termsVersion: CONSENT_TERMS_VERSION, confirmed: true
    }, auth);
    const derivedRevokeConsentId = derivedRevokeGrant.body.consent.consentId;
    await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(derivedRevokeRunId) + '/transition', {
      requestId: 'derived-result-revoke-start', expectedVersion: 1, status: 'running', reasonCode: 'runtime_started'
    }, auth);
    const derivedRevoke = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(derivedRevokeRunId)
      + '/consents/' + encodeURIComponent(derivedRevokeConsentId) + '/revoke', {
      requestId: 'derived-result-revoke-now', expectedVersion: 2
    }, auth);
    assert.strictEqual(derivedRevoke.body.consent.status, 'revoked');
    const revokedDerivedComplete = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(derivedRevokeRunId) + '/complete', {
      requestId: 'derived-result-revoke-complete', expectedVersion: 2, consentId: derivedRevokeConsentId,
      result: { schemaVersion: 1, summary: 'Must not persist after revoke', findings: [] }
    }, auth);
    assert.strictEqual(revokedDerivedComplete.status, 409);
    assert.strictEqual(revokedDerivedComplete.body.error, 'consent-revoked',
      'Home Node rechecks revoked derived persistence authorization inside the completion transaction');
    const noRevokedDerivedResult = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(derivedRevokeRunId) + '/result', null, auth);
    assert.strictEqual(noRevokedDerivedResult.status, 404);

    const retentionPolicy = await request(port, 'GET', '/internal/work/retention', null, auth);
    assert.strictEqual(retentionPolicy.status, 200);
    assert.strictEqual(retentionPolicy.body.policy.cleanupScheduled, false);
    assert.strictEqual(retentionPolicy.body.policy.eventsPurgedWithRun, true);
    const cleanupLimitDenied = await request(port, 'POST', '/internal/work/retention', { limit: 101 }, auth);
    assert.strictEqual(cleanupLimitDenied.status, 400, 'manual retention work remains bounded');
    const cleanupNoop = await request(port, 'POST', '/internal/work/retention', { limit: 10 }, auth);
    assert.strictEqual(cleanupNoop.status, 200);

    const queuedCreate = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'queued-create', workflowId: WORKFLOW, projectRef: 'project_queued'
    }, auth);
    const queuedId = runId(queuedCreate.body);
    const queuedCancel = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(queuedId) + '/cancel', {
      requestId: 'queued-cancel', expectedVersion: 1
    }, auth);
    assert.strictEqual(queuedCancel.status, 200);
    assert.strictEqual(queuedCancel.body.run.status, 'cancelled');

    const interruptedCancelCreate = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'interrupted-cancel-create', workflowId: WORKFLOW, projectRef: 'project_interrupted_cancel'
    }, auth);
    const interruptedCancelId = runId(interruptedCancelCreate.body);
    const interruptedCancelStart = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(interruptedCancelId) + '/transition', {
      requestId: 'interrupted-cancel-start', expectedVersion: 1, status: 'running', reasonCode: 'runtime_started'
    }, auth);
    assert.strictEqual(interruptedCancelStart.status, 200);
    const interruptedCancelIntent = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(interruptedCancelId) + '/cancel', {
      requestId: 'interrupted-cancel-intent', expectedVersion: 2
    }, auth);
    assert.strictEqual(interruptedCancelIntent.body.run.status, 'cancel_requested');
    const interruptedCancelAck = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(interruptedCancelId) + '/transition', {
      requestId: 'interrupted-cancel-ack', expectedVersion: 3, status: 'cancelled', reasonCode: 'runtime_interrupted'
    }, auth);
    assert.strictEqual(interruptedCancelAck.status, 200);

    const interruptedQueuedCreate = await request(port, 'POST', '/internal/work/runs', {
      requestId: 'interrupted-queued-create', workflowId: WORKFLOW, projectRef: 'project_interrupted_queued'
    }, auth);
    const interruptedQueuedId = runId(interruptedQueuedCreate.body);
    const interruptedQueued = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(interruptedQueuedId) + '/transition', {
      requestId: 'interrupted-queued-ack', expectedVersion: 1, status: 'failed', reasonCode: 'runtime_interrupted'
    }, auth);
    assert.strictEqual(interruptedQueued.status, 200);

    const misrouted = await request(port, 'GET', '/mobile/v1/work/runs/' + encodeURIComponent(savedRunId), null, auth);
    assert.notStrictEqual(misrouted.status, 200, 'Mobile API must not expose desktop Work Run records');
    assert.strictEqual(misrouted.body.run, undefined);
    const misroutedAgentMemory = await request(port, 'GET', '/mobile/v1/agent-memory/records', null, auth);
    assert.notStrictEqual(misroutedAgentMemory.status, 200, 'Mobile API must not expose Agent Memory records');
  } catch (error) {
    console.error(service.output().slice(-1600));
    console.error('requestMethod=' + String(error.requestMethod || 'unknown'));
    throw error;
  } finally {
    await stopProduction(service.child);
  }

  service = startProduction(dataDir, port);
  try {
    const health = await waitForHealth(port, 12000);
    assert(health, 'production Home Node should restart: ' + service.output().slice(-500));
    const auth = { 'X-IB-Home-Token': TOKEN };
    const persisted = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(savedRunId), null, auth);
    assert.strictEqual(persisted.status, 200);
    assert.strictEqual(persisted.body.run.status, 'running');
    assert.strictEqual(persisted.body.run.version, 2);
    const staleRuns = await request(port, 'GET', '/internal/work/runs/active?limit=100', null, auth);
    assert(staleRuns.body.runs.some(run => run.runId === savedRunId), 'a restarted runtime can enumerate the dangling run');
    const interrupted = await request(port, 'POST', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/transition', {
      requestId: 'restart-interrupted', expectedVersion: 2, status: 'failed', reasonCode: 'runtime_interrupted'
    }, auth);
    assert.strictEqual(interrupted.status, 200);
    assert.strictEqual(interrupted.body.run.status, 'failed');
    assert.strictEqual(interrupted.body.run.version, 3);
    const interruptionEvents = await request(port, 'GET', '/internal/work/runs/' + encodeURIComponent(savedRunId) + '/events?afterSequence=0&limit=10', null, auth);
    assert.strictEqual(interruptionEvents.body.events.find(event => event.reasonCode === 'runtime_interrupted').toStatus, 'failed');
    const persistedChat = await request(port, 'GET', '/message?id=msg_work_run_chat_u', null, auth);
    assert.strictEqual(persistedChat.status, 200);
    assert.strictEqual(persistedChat.body.message.content, 'synthetic chat authority regression');
    const persistedAgentMemory = await request(port, 'GET', '/internal/agent-memory/records/' + encodeURIComponent(savedAgentMemoryId), null, auth);
    assert.strictEqual(persistedAgentMemory.status, 200);
    assert.strictEqual(persistedAgentMemory.body.record.revision, 2,
      'Agent Memory survives Home Node process restart in its independent database');
  } finally {
    await stopProduction(service.child);
  }
}

async function testRetentionAndAtomicCompletion(dataDir) {
  const createWorkRunStore = require(STORE_PATH);
  const day = 24 * 60 * 60 * 1000;
  let now = Date.now();
  const store = createWorkRunStore({ dataDir: dataDir, clock: () => now, logger: () => {} });
  const providers = [
    { destination: 'agent', providerRef: 'profile_agent', provider: 'openai', model: 'gpt-mock', routeHash: 'd'.repeat(64) },
    { destination: 'middle_brain', providerRef: 'profile_middle', provider: 'openai', model: 'mb-mock', routeHash: 'e'.repeat(64) }
  ];
  let completedRunId, activeRunId;
  try {
    store.open();
    const create = store.createRun({ requestId: 'retention-create', workflowId: WORKFLOW, projectRef: 'project_retention' });
    completedRunId = create.run.runId;
    const grant = store.grantConsent({
      runId: completedRunId, requestId: 'retention-consent', expectedVersion: 1,
      projectRef: 'project_retention', providerScopes: providers, fileIds: ['pf_retained'], memoryScope: null,
      memoryDerivedScope: null,
      expiresInMs: 60000, termsVersion: CONSENT_TERMS_VERSION, confirmed: true
    });
    assert.strictEqual(grant.ok, true, JSON.stringify(grant));
    assert.strictEqual(grant.consent.confirmationMethod, 'explicit_user_action');
    const start = store.transition({
      runId: completedRunId, requestId: 'retention-start', expectedVersion: 1,
      status: 'running', reasonCode: 'runtime_started'
    });
    assert.strictEqual(start.ok, true);
    const complete = store.completeRun({
      runId: completedRunId, requestId: 'retention-complete', expectedVersion: 2,
      consentId: grant.consent.consentId,
      result: { schemaVersion: 1, summary: 'Retained', findings: [] }
    });
    assert.strictEqual(complete.ok, true);

    const failed = store.createRun({ requestId: 'retention-failed-create', workflowId: WORKFLOW, projectRef: 'project_retention' });
    const failedRunId = failed.run.runId;
    assert.strictEqual(store.transition({
      runId: failedRunId, requestId: 'retention-fail', expectedVersion: 1,
      status: 'failed', reasonCode: 'runtime_failed'
    }).ok, true);
    const active = store.createRun({ requestId: 'retention-active-create', workflowId: WORKFLOW, projectRef: 'project_retention' });
    activeRunId = active.run.runId;
    assert.strictEqual(store.transition({
      runId: activeRunId, requestId: 'retention-active-start', expectedVersion: 1,
      status: 'running', reasonCode: 'runtime_started'
    }).ok, true);

    const readReference = store.getAuthorizedResultReference({
      currentRunId: activeRunId, resultRunId: completedRunId, resultId: complete.result.resultId
    });
    assert.strictEqual(readReference.ok, true, JSON.stringify(readReference));
    assert.strictEqual(readReference.result.report.summary, 'Retained');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(readReference.result, 'memoryContextHash'), false,
      'the comparison-only read omits Memory provenance metadata');
    const outsideProjectRun = store.createRun({ requestId: 'retention-other-project', workflowId: WORKFLOW,
      projectRef: 'project_other' });
    assert.strictEqual(store.getAuthorizedResultReference({
      currentRunId: activeRunId, resultRunId: outsideProjectRun.run.runId, resultId: 'wrres_not_authorized'
    }).code, 'RESULT_REFERENCE_DENIED', 'an out-of-project reference is denied before its Artifact row is read');
    assert.strictEqual(store.getAuthorizedResultReference({
      currentRunId: activeRunId, resultRunId: completedRunId, resultId: 'wrres_wrong_revision'
    }).code, 'RESULT_REFERENCE_UNAVAILABLE');

    now += createWorkRunStore.RESULT_RETENTION_MS + 1;
    assert.strictEqual(store.getAuthorizedResultReference({
      currentRunId: activeRunId, resultRunId: completedRunId, resultId: complete.result.resultId
    }).code, 'RESULT_NOT_AVAILABLE');
    assert.strictEqual(store.listResults({ limit: 100 }).results.find(item => item.runId === completedRunId).resultStatus,
      'available', 'the comparison read does not expire or mutate the Artifact');
    const resultSweep = store.cleanupExpired({ limit: 10 });
    assert.strictEqual(resultSweep.resultsExpired, 1);
    assert.strictEqual(store.getResult(completedRunId).result.status, 'expired');
    assert.strictEqual(store.getResult(completedRunId).result.report, null);
    assert.strictEqual(store.getRun(completedRunId).run.status, 'completed');
    assert.strictEqual(store.listEvents(completedRunId, { limit: 10 }).events.length, 3,
      'result expiry preserves the Run and its state Events');

    now += createWorkRunStore.RUN_RETENTION_MS - createWorkRunStore.RESULT_RETENTION_MS + 1;
    const aggregateSweep = store.cleanupExpired({ limit: 10 });
    assert.strictEqual(aggregateSweep.terminalRunsPurged, 2, 'terminal Runs age out as complete aggregates');
    assert.strictEqual(store.getRun(completedRunId).code, 'RUN_NOT_FOUND');
    assert.strictEqual(store.getRun(failedRunId).code, 'RUN_NOT_FOUND');
    assert.strictEqual(store.getRun(activeRunId).run.status, 'running', 'active Runs are never retention-deleted');
    assert.strictEqual(store.retentionPolicy().cleanupScheduled, false, 'retention has no background scheduler');
  } finally { store.close(); }

  const { DatabaseSync } = require('node:sqlite');
  const cleanupDb = new DatabaseSync(path.join(dataDir, 'home-node.db'));
  try {
    for (const table of ['work_runs', 'work_run_events', 'work_run_idempotency', 'work_run_results', 'work_run_consents']) {
      const columns = cleanupDb.prepare('PRAGMA table_info(' + table + ')').all().map(row => String(row.name));
      assert(columns.length > 0, 'retention aggregate table is part of the Home Node Work authority: ' + table);
      const count = cleanupDb.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE run_id=?').get(completedRunId).count;
      assert.strictEqual(Number(count), 0, 'aggregate retention removes linked rows together: ' + table);
    }
  } finally { cleanupDb.close(); }

  let atomicNow = Date.now();
  const atomicDir = path.join(path.dirname(dataDir), 'atomic-completion');
  const atomic = createWorkRunStore({ dataDir: atomicDir, clock: () => atomicNow, logger: () => {} });
  try {
    atomic.open();
    const created = atomic.createRun({ requestId: 'atomic-create', workflowId: WORKFLOW, projectRef: 'project_atomic' });
    const runId = created.run.runId;
    const grant = atomic.grantConsent({
      runId: runId, requestId: 'atomic-consent', expectedVersion: 1, projectRef: 'project_atomic',
      providerScopes: providers, fileIds: ['pf_atomic'], memoryScope: null, expiresInMs: 60000,
      memoryDerivedScope: null,
      termsVersion: CONSENT_TERMS_VERSION, confirmed: true
    });
    atomic.transition({ runId: runId, requestId: 'atomic-start', expectedVersion: 1, status: 'running', reasonCode: 'runtime_started' });
    const faultDb = new DatabaseSync(path.join(atomicDir, 'home-node.db'));
    try {
      faultDb.exec("CREATE TRIGGER fail_work_result_insert BEFORE INSERT ON work_run_results BEGIN SELECT RAISE(ABORT, 'synthetic-result-write-failure'); END");
    } finally { faultDb.close(); }
    const failedComplete = atomic.completeRun({
      runId: runId, requestId: 'atomic-complete', expectedVersion: 2, consentId: grant.consent.consentId,
      result: { schemaVersion: 1, summary: 'Atomic rollback', findings: [] }
    });
    assert.strictEqual(failedComplete.code, 'STORE_UNAVAILABLE');
    assert.strictEqual(atomic.getRun(runId).run.status, 'running');
    assert.strictEqual(atomic.getRun(runId).run.version, 2);
    assert.strictEqual(atomic.listEvents(runId, { limit: 10 }).events.length, 2);
    assert.strictEqual(atomic.getResult(runId).code, 'RESULT_NOT_FOUND');
  } finally { atomic.close(); }
}

async function testAvailableResultSurvivesStoreReopen(dataDir) {
  const createWorkRunStore = require(STORE_PATH);
  const providers = [
    { destination: 'agent', providerRef: 'profile_agent', provider: 'openai', model: 'gpt-mock', routeHash: '1'.repeat(64) },
    { destination: 'middle_brain', providerRef: 'profile_middle', provider: 'openai', model: 'mb-mock', routeHash: '2'.repeat(64) }
  ];
  let now = Date.now();
  let store = createWorkRunStore({ dataDir: dataDir, clock: () => now, logger: () => {} });
  let runId;
  try {
    store.open();
    const created = store.createRun({ requestId: 'refresh-create', workflowId: WORKFLOW, projectRef: 'project_refresh' });
    runId = created.run.runId;
    const consent = store.grantConsent({
      runId: runId, requestId: 'refresh-consent', expectedVersion: 1,
      projectRef: 'project_refresh', providerScopes: providers, fileIds: ['file_readme'],
      memoryScope: null, memoryDerivedScope: null, expiresInMs: 60000, termsVersion: CONSENT_TERMS_VERSION, confirmed: true
    });
    assert.strictEqual(consent.ok, true);
    assert.strictEqual(store.transition({
      runId: runId, requestId: 'refresh-start', expectedVersion: 1,
      status: 'running', reasonCode: 'runtime_started'
    }).ok, true);
    const completed = store.completeRun({
      runId: runId, requestId: 'refresh-complete', expectedVersion: 2,
      consentId: consent.consent.consentId,
      result: { schemaVersion: 1, summary: 'Safe temporary project audit', findings: [] }
    });
    assert.strictEqual(completed.ok, true);
    store.close();

    store = createWorkRunStore({ dataDir: dataDir, clock: () => now, logger: () => {} });
    store.open();
    const restored = store.getResult(runId);
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(restored.result.status, 'available');
    assert.strictEqual(restored.result.report.summary, 'Safe temporary project audit');
    const index = store.listResults({ limit: 10 });
    assert(index.results.some(item => item.runId === runId && item.resultStatus === 'available'));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(index.results[0], 'report'), false,
      'the refreshed Result index remains metadata-only');
    const removed = store.deleteResult({ runId: runId, requestId: 'refresh-delete', expectedVersion: 3 });
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(removed.result.status, 'deleted');
    assert.strictEqual(removed.result.report, null);
    assert.strictEqual(store.listEvents(runId, { limit: 10 }).events.length, 3,
      'explicit Result deletion preserves the completed Run history');
  } finally { store.close(); }

  store = createWorkRunStore({ dataDir: dataDir, clock: () => now, logger: () => {} });
  try {
    store.open();
    const deleted = store.getResult(runId);
    assert.strictEqual(deleted.ok, true);
    assert.strictEqual(deleted.result.status, 'deleted', 'the logical deletion tombstone survives reopen');
    assert.strictEqual(deleted.result.report, null);
  } finally { store.close(); }
}

async function testVersionTwoConsentMemoryScopeMigration() {
  const { DatabaseSync } = require('node:sqlite');
  const createWorkRunStore = require(STORE_PATH);
  const dataDir = path.join(TEST_ROOT, 'work-run-v2-consent-migration');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'home-node.db'));
  try {
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('work_runs_schema_version', '2');
    db.exec('CREATE TABLE work_run_consents (' +
      'consent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_ref TEXT NOT NULL, ' +
      'provider_scopes_json TEXT NOT NULL, file_ids_json TEXT NOT NULL, terms_version TEXT NOT NULL, ' +
      'grant_request_key_hash TEXT NOT NULL UNIQUE, grant_request_hash TEXT NOT NULL, ' +
      'confirmation_method TEXT NOT NULL, confirmed_at INTEGER NOT NULL, issued_at INTEGER NOT NULL, ' +
      'expires_at INTEGER NOT NULL, revoked_at INTEGER, revocation_reason TEXT)');
  } finally { db.close(); }
  const store = createWorkRunStore({ dataDir, clock: () => Date.now(), logger: () => {} });
  try {
    store.open();
      assert.strictEqual(store.describe().schemaVersion, 10);
    const migratedDb = new DatabaseSync(path.join(dataDir, 'home-node.db'), { readOnly: true });
    try {
      const columns = new Set(migratedDb.prepare('PRAGMA table_info(work_run_consents)').all().map(row => String(row.name)));
      assert(columns.has('memory_scope_json'), 'v2 Consent schema is upgraded with an explicit memory scope slot');
      assert(columns.has('memory_derived_scope_json'), 'the v4 migration adds derived-sink scope metadata');
      assert(new Set(migratedDb.prepare('PRAGMA table_info(work_run_dsh_sessions)').all().map(row => String(row.name))).has('session_id'),
        'v5 adds the one-to-one Home Node Run and DSH Session binding');
      assert.strictEqual(String(migratedDb.prepare('PRAGMA table_info(work_run_consents)').all()
        .find(row => String(row.name) === 'memory_derived_scope_json').dflt_value), "'null'",
      'legacy Consent rows migrate without derived-output authorization');
      const resultColumns = new Set(migratedDb.prepare('PRAGMA table_info(work_run_results)').all().map(row => String(row.name)));
      assert(resultColumns.has('memory_derived') && resultColumns.has('memory_context_hash'),
        'Result migration adds conservative classification metadata without report-body duplication');
    } finally { migratedDb.close(); }
  } finally { store.close(); }
}

function inspectLedger(dataDir) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'home-node.db'));
  try {
    const tables = ['work_runs', 'work_run_events', 'work_run_idempotency', 'work_run_results', 'work_run_consents'];
    const forbidden = ['prompt', 'messages', 'api_key', 'tool_args', 'artifact', 'stdout', 'tool_output', 'transcript', 'raw_output'];
    for (const table of tables) {
      const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map(row => String(row.name).toLowerCase());
      for (const field of forbidden) {
        assert.strictEqual(columns.includes(field), false, 'Work Run table must not add sensitive column ' + table + '.' + field);
      }
    }
    const data = JSON.stringify({
      runs: db.prepare('SELECT * FROM work_runs').all(),
      events: db.prepare('SELECT * FROM work_run_events').all(),
      keys: db.prepare('SELECT * FROM work_run_idempotency').all(),
      results: db.prepare('SELECT * FROM work_run_results').all(),
      consents: db.prepare('SELECT * FROM work_run_consents').all()
    });
    assert.strictEqual(data.includes(SENTINEL), false, 'rejected sensitive input must not reach SQLite');
    assert(!data.includes('synthetic-result-secret-123') && !data.includes('synthetic-result-bearer-456'),
      'structured Results redact common credentials before persistence');
    assert(!data.includes('https://provider.invalid'), 'Consent persists route fingerprints, not Provider endpoints');
    for (const requestId of ['create-main', 'start-main', 'cancel-request', 'cancel-ack',
      'result-consent', 'result-consent-unconfirmed', 'result-run-start', 'result-run-complete', 'result-delete',
      'consent-revoke-run-create', 'consent-revoke-grant', 'consent-revoke-explicit']) {
      assert.strictEqual(data.includes(requestId), false, 'raw idempotency keys must not be persisted');
    }
  } finally { db.close(); }
}

async function main() {
  await testVersionTwoConsentMemoryScopeMigration();
  const workRunSource = fs.readFileSync(STORE_PATH, 'utf8');
  const modules = Array.from(workRunSource.matchAll(/require\(['"]([^'"]+)['"]\)/g)).map(match => match[1]);
  assert.deepStrictEqual(modules.sort(), ['../../assets/js/work-mode-executor.js', 'crypto', 'fs', 'node:sqlite', 'path'],
    'Work Run storage may validate the shared executor snapshot, but must not copy Chat, Memory, Credential, Provider, or Tool authorities');

  const buildDataDir = path.join(TEST_ROOT, 'build-home-node');
  await testBuildAssembly(buildDataDir);

  const retentionDataDir = path.join(TEST_ROOT, 'retention-home-node');
  await testRetentionAndAtomicCompletion(retentionDataDir);

  const resultPersistenceDir = path.join(TEST_ROOT, 'result-persistence-home-node');
  await testAvailableResultSurvivesStoreReopen(resultPersistenceDir);

  const productionDataDir = path.join(TEST_ROOT, 'production-home-node');
  const port = await freePort();
  await testProductionApi(productionDataDir, port);
  inspectLedger(productionDataDir);

  console.log('Home Node Work Run and Agent Memory authorities passed (private APIs, independent DB, CAS, lifecycle, restart, secret boundary).');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack + (error.requestPath ? '\nrequestPath=' + error.requestPath : '') : String(error));
  process.exitCode = 1;
}).finally(() => {
  restoreEnv();
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (_) { /* temp test data only */ }
});
