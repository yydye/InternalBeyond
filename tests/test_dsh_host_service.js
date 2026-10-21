'use strict';

/* H2 Home Node assembly and authenticated API tests for the pinned DSH child. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn: nodeSpawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DEV_PORTS = require('../runtime/dev-service-contract.js').DEV_PORTS;
const DSH_ROOT = path.resolve(process.env.IB_DSH_INTERNAL_RUNTIME || path.join(ROOT, 'runtime', 'dsh-runtime'));
const DSH_REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const DSH_NODE = path.resolve(process.env.IB_POC_NODE_EXE || path.join(ROOT, 'runtime', 'node', 'node.exe'));
const DSH_MANIFEST = JSON.parse(fs.readFileSync(path.join(DSH_ROOT, 'runtime-manifest.json'), 'utf8'));
const DSH_REQUIRE = createRequire(path.join(DSH_ROOT, 'apps', 'cli', 'package.json'));
const DSH_BIN = path.join(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts');
const DSH_PATCH = path.join(DSH_ROOT, 'config', 'cordis.yml');
const DSH_PROTOCOL = DSH_REQUIRE.resolve('@agentclientprotocol/sdk');
const DSH_TSX = pathToFileURL(DSH_REQUIRE.resolve('tsx/esm')).href;

const TOKEN = 'H2_TEST_HOME_NODE_TOKEN';
const PROVIDER_REF = 'h2_fake_api_config_01';
const MIDDLE_REF = 'h2_fake_middle_api_config_01';
const PROJECT_REF = 'h2_workspace_project_01';
const FILE_ID = 'h2_consented_file_01';
const PROVIDER_URL = 'https://h2-fake-provider.invalid/v1/chat/completions';
const MIDDLE_URL = 'https://h2-fake-provider.invalid/v1/middle-brain';
const FAKE_SECRET = 'H2_FAKE_SECRET_NEVER_SENT_TO_DSH';
const ALLOWED_CONTENT = 'H2_CONSENTED_WORKSPACE_CONTENT';
const OUTSIDE_CONTENT = 'H2_UNCONSENTED_WORKSPACE_CONTENT';

const homeNodeService = require(path.join(ROOT, 'services', 'home-node-service.js'));
const createReadOnlyProjectTool = require(path.join(ROOT, 'assets', 'js', 'work-mode-project-tool.js'));
const mobileDto = require(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'));
const consentCore = require(path.join(ROOT, 'assets', 'js', 'work-mode-consent-core.js'));
const workModeExecutor = require(path.join(ROOT, 'assets', 'js', 'work-mode-executor.js'));
const createCredentialVault = require(path.join(ROOT, 'active', 'credential-vault.js'));
const createNodeModelPort = require(path.join(ROOT, 'active', 'node-model-port.js'));
const createWorkRunStore = require(path.join(ROOT, 'services', 'home-node', 'work-run-store.js'));

function selectionFor(providerScope, presetId = 'general') {
  const preset = workModeExecutor.preset(presetId);
  return workModeExecutor.normalizeSnapshot({
    schemaVersion: 1,
    roleId: '',
    roleName: 'H2 Synthetic Agent',
    profileRef: providerScope.providerRef,
    presetId,
    personaHash: crypto.createHash('sha256').update('h2 synthetic agent').digest('hex'),
    providerScope,
    allowedTools: preset.allowedTools.slice(),
    maxProjectReadCalls: preset.maxProjectReadCalls
  });
}

test('the process Home Node keeps DSH execution disabled by default', () => {
  assert.equal(homeNodeService.dshHost.describe().enabled, false);
  assert.equal(homeNodeService.dshHost.describe().activeRuns, 0);
});

test('Dev opt-in auto-configures the embedded ACP runtime in the real Home Node process', async t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsh-h2-H3'));
  const root = path.join(fixtureRoot, '.dev-data', 'synthetic', 'dev-sandbox');
  const dataDir = path.join(root, 'home-node');
  const credentialDir = path.join(root, 'credential-vault');
  const envDataDirs = [dataDir, credentialDir, path.join(root, 'local-app-data'), path.join(root, 'roaming-app-data'),
    path.join(root, 'temp'), path.join(root, 'logs'), path.join(root, 'host')];
  for (const directory of envDataDirs) fs.mkdirSync(directory, { recursive: true });
  const port = await freeLoopbackPort();
  const devIdentity = { instanceId: crypto.randomUUID(), sessionToken: crypto.randomBytes(32).toString('hex') };
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: path.join(root, 'local-app-data'),
    APPDATA: path.join(root, 'roaming-app-data'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    IB_DEV_MODE: '1',
    IB_DEV_SYNTHETIC: '1',
    IB_DEV_PROJECT_ROOT: fixtureRoot,
    IB_DEV_INSTANCE_ID: devIdentity.instanceId,
    IB_DEV_SESSION_TOKEN: devIdentity.sessionToken,
    IB_DEV_DSH_ENABLED: '1',
    IB_DEV_SANDBOX_ROOT: root,
    IB_BOOT_STATE_DIR: path.join(root, 'host'),
    IB_LOG_DIR: path.join(root, 'logs'),
    IB_ACTIVE_DATA_DIR: path.join(root, 'active'),
    IB_BRIDGE_DATA_DIR: path.join(root, 'bridge'),
    IB_HOME_NODE_DATA_DIR: dataDir,
    IB_HOME_NODE_HOST: '127.0.0.1',
    IB_HOME_NODE_PORT: String(port),
    IB_ACTIVE_PORT: String(DEV_PORTS.active),
    IB_BRIDGE_PORT: String(DEV_PORTS.bridge),
    IB_WEB_PORT: String(DEV_PORTS.web),
    IB_RESTART_PORT: String(DEV_PORTS.restart),
    IB_DEV_FAKE_PROVIDER_PORT: String(DEV_PORTS.fakeProvider),
    IB_ECONOMY_CHANNEL_SOURCE_PORT: String(DEV_PORTS.activeChannelSource),
    IB_DSH_CONTROL_PORT: String(DEV_PORTS.dshControl),
    IB_DSH_WEB_PORT: String(DEV_PORTS.dshWeb),
    IB_HOME_NODE_TOKEN: TOKEN,
    IB_CREDENTIAL_DATA_DIR: credentialDir,
    IB_CREDENTIAL_BINDINGS_DIR: credentialDir
  });
  delete env.IB_HOME_NODE_TOKEN_FILE;
  const child = nodeSpawn(DSH_NODE, [path.join(ROOT, 'services', 'home-node-service.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', chunk => { if (output.length < 16000) output += String(chunk); });
  child.stderr.on('data', chunk => { if (output.length < 16000) output += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitForChildExit(child, 5000);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForChildExit(child, 5000);
    removeFixtureRoot(fixtureRoot);
  });

  const health = await waitForChildHealth(child, port, () => output);
  assert.equal(health.service, 'internal-beyond-home-node');
  const response = await fetch('http://127.0.0.1:' + port + '/internal/work/dsh', {
    headers: { Authorization: 'Bearer ' + TOKEN }
  });
  const status = await response.json();
  assert.equal(response.status, 200, JSON.stringify(status));
  assert.equal(status.host.enabled, true);
  assert.equal(status.host.dshRevision, DSH_REVISION);

  const shutdown = await fetch('http://127.0.0.1:' + port + '/__shutdown', {
    method: 'POST', headers: { 'X-IB-Dev-Session': devIdentity.sessionToken, 'X-IB-Dev-Instance': devIdentity.instanceId }
  });
  assert.equal(shutdown.status, 202);
  assert.equal((await shutdown.json()).ok, true);
  assert.equal(await waitForChildExit(child, 7000), true, output);
  assert.equal(child.exitCode, 0, output);
});

test('the real Dev Home Node runs embedded DSH through Fake Provider, Consent, and the existing Project Tool', async t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsh-h2-H3run'));
  const root = path.join(fixtureRoot, '.dev-data', 'synthetic', 'dev-sandbox');
  const dataDir = path.join(root, 'home-node');
  const credentialDir = path.join(root, 'credential-vault');
  const workspaceRoot = path.join(root, 'workspace');
  const homeNodePort = await freeLoopbackPort();
  const envDataDirs = [dataDir, credentialDir, path.join(root, 'local-app-data'), path.join(root, 'roaming-app-data'),
    path.join(root, 'temp'), path.join(root, 'logs'), path.join(root, 'host')];
  for (const directory of envDataDirs) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'private'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'review.txt'), ALLOWED_CONTENT + '\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'private', 'secret.txt'), OUTSIDE_CONTENT + '\n', 'utf8');

  const vault = createCredentialVault({ dataDir: credentialDir });
  assert.equal(vault.upsert(PROVIDER_REF, { provider: 'openai', apiKey: FAKE_SECRET }), true);
  assert.equal(vault.upsert(MIDDLE_REF, { provider: 'openai', apiKey: FAKE_SECRET }), true);
  let modelCalls = 0;
  let observedAuthorization = '';
  let workspaceReadEvidence = null;
  const providerServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      modelCalls += 1;
      observedAuthorization = String(req.headers.authorization || '');
      const index = modelCalls;
      const messages = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages || [];
      const content = index === 1
        ? JSON.stringify({ action: 'call_tool', name: 'project.read_file', arguments: { fileId: FILE_ID } })
        : JSON.stringify({
          schemaVersion: 1,
          summary: 'Read the consented workspace file and return the verified result.',
          findings: [{
            fileId: FILE_ID,
            path: 'src/review.txt',
            line: 1,
            severity: 'info',
            title: 'Fake fixture content observed',
            detail: messages.some(message => JSON.stringify(message).includes(ALLOWED_CONTENT))
              ? ALLOWED_CONTENT : 'project tool content missing'
          }]
        });
      const body = JSON.stringify({
        choices: [{ message: { content }, finish_reason: index === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 16, completion_tokens: 12 }
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    providerServer.once('error', reject);
    providerServer.listen(0, '127.0.0.1', resolve);
  });
  const providerUrl = 'http://127.0.0.1:' + providerServer.address().port + '/v1/chat/completions';
  const devIdentity = { instanceId: crypto.randomUUID(), sessionToken: crypto.randomBytes(32).toString('hex') };
  const childEnv = Object.assign({}, process.env, {
    LOCALAPPDATA: path.join(root, 'local-app-data'),
    APPDATA: path.join(root, 'roaming-app-data'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
    IB_DEV_MODE: '1',
    IB_DEV_SYNTHETIC: '1',
    IB_DEV_PROJECT_ROOT: fixtureRoot,
    IB_DEV_INSTANCE_ID: devIdentity.instanceId,
    IB_DEV_SESSION_TOKEN: devIdentity.sessionToken,
    IB_DEV_DSH_ENABLED: '1',
    IB_DEV_SANDBOX_ROOT: root,
    IB_BOOT_STATE_DIR: path.join(root, 'host'),
    IB_LOG_DIR: path.join(root, 'logs'),
    IB_ACTIVE_DATA_DIR: path.join(root, 'active'),
    IB_BRIDGE_DATA_DIR: path.join(root, 'bridge'),
    IB_HOME_NODE_DATA_DIR: dataDir,
    IB_HOME_NODE_HOST: '127.0.0.1',
    IB_HOME_NODE_PORT: String(homeNodePort),
    IB_ACTIVE_PORT: String(DEV_PORTS.active),
    IB_BRIDGE_PORT: String(DEV_PORTS.bridge),
    IB_WEB_PORT: String(DEV_PORTS.web),
    IB_RESTART_PORT: String(DEV_PORTS.restart),
    IB_DEV_FAKE_PROVIDER_PORT: String(DEV_PORTS.fakeProvider),
    IB_ECONOMY_CHANNEL_SOURCE_PORT: String(DEV_PORTS.activeChannelSource),
    IB_DSH_CONTROL_PORT: String(DEV_PORTS.dshControl),
    IB_DSH_WEB_PORT: String(DEV_PORTS.dshWeb),
    IB_HOME_NODE_TOKEN: TOKEN,
    IB_CREDENTIAL_DATA_DIR: credentialDir,
    IB_CREDENTIAL_BINDINGS_DIR: credentialDir
  });
  delete childEnv.IB_HOME_NODE_TOKEN_FILE;
  const child = nodeSpawn(DSH_NODE, [path.join(ROOT, 'services', 'home-node-service.js')], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', chunk => { if (output.length < 16000) output += String(chunk); });
  child.stderr.on('data', chunk => { if (output.length < 16000) output += String(chunk); });
  let pumping = false;
  let pollController = null;
  let pumpPromise = Promise.resolve();
  t.after(async () => {
    pumping = false;
    if (pollController) pollController.abort();
    try { await Promise.race([pumpPromise, new Promise(resolve => setTimeout(resolve, 3000))]); } catch (_) {}
    if (child.exitCode === null && child.signalCode === null) {
      try { await fetch('http://127.0.0.1:' + homeNodePort + '/__shutdown', { method: 'POST', headers: {
        'X-IB-Dev-Session': devIdentity.sessionToken, 'X-IB-Dev-Instance': devIdentity.instanceId
      } }); } catch (_) {}
      if (!(await waitForChildExit(child, 5000))) child.kill('SIGKILL');
      await waitForChildExit(child, 5000);
    }
    await new Promise(resolve => providerServer.close(() => resolve()));
    removeFixtureRoot(fixtureRoot);
  });

  await waitForChildHealth(child, homeNodePort, () => output);
  const baseUrl = 'http://127.0.0.1:' + homeNodePort;
  const identityHeaders = { 'X-IB-Dev-Session': devIdentity.sessionToken, 'X-IB-Dev-Instance': devIdentity.instanceId };
  let sessionId = '';
  const api = (method, pathname, body, signal) => {
    if (pathname.endsWith('/dsh') && body && !body.sessionId) body = Object.assign({}, body, { sessionId: sessionId });
    return requestApi(baseUrl, method, pathname, body, signal, identityHeaders);
  };
  const apiConfigs = [
    { id: PROVIDER_REF, provider: 'openai', model: 'fake-h3-v1', endpoint: providerUrl, credentialRef: PROVIDER_REF, apiKey: FAKE_SECRET, nickname: 'H3 Fake Provider' },
    { id: MIDDLE_REF, provider: 'openai', model: 'fake-h3-middle', endpoint: providerUrl, credentialRef: MIDDLE_REF, apiKey: FAKE_SECRET, nickname: 'H3 Fake Middle Brain Provider' }
  ];
  const published = await api('POST', '/characters/publish', {
    characters: mobileDto.characterCatalog(apiConfigs, { withSpec: true }),
    merge: false
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  const route = async (destination, ref, config) => consentCore.providerScope(destination, ref, config, crypto.webcrypto);
  const scopes = [
    await route('agent', PROVIDER_REF, apiConfigs[0]),
    await route('middle_brain', MIDDLE_REF, apiConfigs[1])
  ].sort((left, right) => left.destination.localeCompare(right.destination));
  const created = await api('POST', '/internal/work/runs', {
    requestId: 'h3-process-create-' + crypto.randomUUID(),
    workflowId: createWorkRunStore.WORKFLOW_ID,
    projectRef: PROJECT_REF
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const executorSelection = selectionFor(scopes.find(scope => scope.destination === 'agent'));
  assert.ok(executorSelection, 'the DSH Run must freeze its Home Node provider and tool route');
  const pinned = await api('POST', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId) + '/executor-selection', {
    expectedVersion: created.body.run.version,
    executorSelection
  });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  const granted = await api('POST', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId) + '/consents', {
    requestId: 'h3-process-consent-' + crypto.randomUUID(),
    expectedVersion: pinned.body.run.version,
    projectRef: PROJECT_REF,
    providerScopes: scopes,
    fileIds: [FILE_ID],
    memoryScope: null,
    memoryDerivedScope: null,
    expiresInMs: 60000,
    termsVersion: createWorkRunStore.CONSENT_TERMS_VERSION,
    confirmed: true
  });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  sessionId = 'session-' + crypto.randomUUID();
  const latestRun = await api('GET', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId));
  const linked = await api('POST', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId) + '/dsh-session', {
    sessionId, consentId: granted.body.consent.consentId, expectedVersion: latestRun.body.run.version
  });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));

  let workspaceReads = 0;
  const projectTool = createReadOnlyProjectTool({
    workspace: {
      async wsGetWorkModeProjectSnapshot(projectRef) {
        if (projectRef !== PROJECT_REF) return { ok: false, error: 'project-not-found' };
        const content = fs.readFileSync(path.join(workspaceRoot, 'src', 'review.txt'), 'utf8');
        return {
          ok: true,
          projectRef,
          files: [{ fileId: FILE_ID, path: 'src/review.txt', size: Buffer.byteLength(content), contentHash: crypto.createHash('sha256').update(content).digest('hex') }]
        };
      },
      async wsReadWorkModeFile(projectRef, fileId) {
        if (projectRef !== PROJECT_REF || fileId !== FILE_ID) return { ok: false, error: 'scope-denied' };
        workspaceReads += 1;
        const content = fs.readFileSync(path.join(workspaceRoot, 'src', 'review.txt'), 'utf8');
        return {
          ok: true,
          projectRef,
          fileId,
          path: 'src/review.txt',
          content,
          size: Buffer.byteLength(content),
          contentHash: crypto.createHash('sha256').update(content, 'utf8').digest('hex')
        };
      }
    },
    maxFiles: 1,
    maxFileBytes: 4096,
    maxTotalReadBytes: 4096
  });
  pumping = true;
  pumpPromise = (async () => {
    while (pumping) {
      pollController = new AbortController();
      let polled;
      try {
        polled = await api('POST', '/internal/work/workspace-project-bridge/poll', { waitMs: 10000 }, pollController.signal);
      } catch (_) { if (pumping) await new Promise(resolve => setTimeout(resolve, 10)); continue; }
      if (!pumping || !polled.body || polled.body.ok !== true || !polled.body.job) continue;
      const job = polled.body.job;
      let result;
      if (job.operation === 'snapshot') result = await projectTool.snapshot(job.input.projectRef);
      else if (job.operation === 'read_file') {
        const read = await projectTool.readFile(job.input);
        workspaceReadEvidence = { ok: read && read.ok, error: read && read.error, bytesRead: read && read.bytesRead };
        const grant = job.input.scope.files.find(file => file.fileId === job.input.fileId);
        result = read && read.ok === true && grant ? {
          ok: true,
          projectRef: job.input.projectRef,
          fileId: read.fileId,
          path: read.path,
          content: read.content,
          contentHash: grant.contentHash,
          size: read.bytesRead
        } : read;
      } else result = { ok: false, error: 'workspace-operation-denied' };
      await api('POST', '/internal/work/workspace-project-bridge/resolve', { requestId: job.requestId, result });
    }
  })();

  const outcome = await api('POST', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId) + '/dsh', {
    consentId: granted.body.consent.consentId,
    providerRef: PROVIDER_REF,
    prompt: 'Read the one consented Workspace file and return a Work Result.',
    timeoutMs: 30000
  });
  pumping = false;
  if (pollController) pollController.abort();
  await pumpPromise;
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body) + '\n' + output);
  assert.equal(outcome.body.run.status, 'completed');
  assert.equal(outcome.body.result.status, 'available');
  assert.equal(workspaceReads, 1);
  assert.equal(modelCalls, 2);
  assert.equal(observedAuthorization, 'Bearer ' + FAKE_SECRET);
  assert.equal(outcome.body.result.report.findings[0].fileId, FILE_ID);
  assert.equal(outcome.body.result.report.findings[0].detail, ALLOWED_CONTENT, JSON.stringify(workspaceReadEvidence));
  const shutdown = await fetch(baseUrl + '/__shutdown', { method: 'POST', headers: identityHeaders });
  assert.equal(shutdown.status, 202);
  assert.equal(await waitForChildExit(child, 7000), true, output);
  assert.equal(child.exitCode, 0, output);
});

test('Dev Home Node manages DSH through Work Run APIs and the existing Project Tool bridge', async t => {
  const fixture = await createServiceFixture(t, 'complete');
  const status = await fixture.api.get('/internal/work/dsh');
  assert.equal(status.body.ok, true);
  assert.equal(status.body.host.enabled, true);
  assert.equal(status.body.host.dshRevision, DSH_REVISION);

  const request = fixture.api.post('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/dsh', {
    consentId: fixture.consent.consentId,
    providerRef: PROVIDER_REF,
    prompt: 'Read the one consented Workspace file and return a Work Result.',
    timeoutMs: 30000
  });
  const result = await request;
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.run.status, 'completed');
  assert.equal(result.body.result.status, 'available');
  assert.match(result.body.result.report.summary, /consented workspace file/i);
  assert.equal(result.body.result.report.findings[0].fileId, FILE_ID);
  assert.equal(result.body.result.report.findings[0].detail, ALLOWED_CONTENT);

  assert.equal(fixture.fakeProvider.calls, 2);
  assert.equal(fixture.fakeProvider.aborts, 0);
  assert.equal(fixture.fakeProvider.observedAuthorization, 'Bearer ' + FAKE_SECRET);
  assert.equal(fixture.workspaceReads, 1);
  assert.equal(fixture.children.length, 1);
  assert.equal(fixture.children[0].options.windowsHide, true);
  assert.notEqual(fixture.children[0].options.cwd, fixture.workspaceRoot);
  assert.equal(fixture.children[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(fixture.children[0].options.env.H2_FAKE_SECRET, undefined);
  assert.equal(JSON.stringify(fixture.children[0].options).includes(FAKE_SECRET), false);

  const persisted = await fixture.api.get('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/result');
  assert.equal(persisted.status, 200);
  assert.equal(persisted.body.result.report.findings[0].detail, ALLOWED_CONTENT);
  assert.equal(fixture.home.dshHost.describe().activeRuns, 0);
});

test('Home Node cancellation stops the DSH child and aborts the in-flight Fake Provider send', async t => {
  const fixture = await createServiceFixture(t, 'hold-first');
  const running = fixture.api.post('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/dsh', {
    consentId: fixture.consent.consentId,
    providerRef: PROVIDER_REF,
    prompt: 'Wait for cancellation during the first model request.',
    timeoutMs: 30000
  });
  await fixture.fakeProvider.waitForCall(1);
  const latest = await fixture.api.get('/internal/work/runs/' + encodeURIComponent(fixture.run.runId));
  assert.equal(latest.body.run.status, 'running');
  const cancelled = await fixture.api.post('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/cancel', {
    requestId: 'h2-cancel-' + crypto.randomUUID(),
    expectedVersion: latest.body.run.version
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.run.status, 'cancel_requested');

  const outcome = await running;
  assert.equal(outcome.status, 409);
  const finalRun = await fixture.api.get('/internal/work/runs/' + encodeURIComponent(fixture.run.runId));
  assert.equal(finalRun.body.run.status, 'cancelled');
  assert.equal(fixture.fakeProvider.calls, 1);
  assert.equal(fixture.fakeProvider.aborts, 1);
  const missing = await fixture.api.get('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/result');
  assert.equal(missing.status, 404);
  assert.equal(fixture.home.dshHost.describe().activeRuns, 0);
});

test('Home Node shutdown drains the active DSH child before closing Work Run stores', async t => {
  const fixture = await createServiceFixture(t, 'hold-first');
  const running = fixture.api.post('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/dsh', {
    consentId: fixture.consent.consentId,
    providerRef: PROVIDER_REF,
    prompt: 'Wait for Home Node shutdown during the first model request.',
    timeoutMs: 30000
  });
  await fixture.fakeProvider.waitForCall(1);
  await fixture.stop();
  await running.catch(() => null);
  assert.equal(fixture.fakeProvider.calls, 1);
  assert.equal(fixture.fakeProvider.aborts, 1);
  assert.equal(fixture.home.dshHost.describe().activeRuns, 0);
  assert.equal(fixture.children[0].child.exitCode !== null, true);
});

test('Home Node observes a DSH child crash, aborts its request and leaves no Result', async t => {
  const fixture = await createServiceFixture(t, 'hold-second');
  const running = fixture.api.post('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/dsh', {
    consentId: fixture.consent.consentId,
    providerRef: PROVIDER_REF,
    prompt: 'Read the authorized file, then hold the second model request.',
    timeoutMs: 30000
  });
  await fixture.fakeProvider.waitForCall(2);
  assert.equal(fixture.children.length, 1);
  fixture.children[0].child.kill('SIGKILL');

  const outcome = await running;
  assert.equal(outcome.status, 409);
  assert.equal(outcome.body.error, 'acp-child-exited');
  const finalRun = await fixture.api.get('/internal/work/runs/' + encodeURIComponent(fixture.run.runId));
  assert.equal(finalRun.body.run.status, 'failed');
  const events = await fixture.api.get('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/events?afterSequence=0&limit=50');
  assert.equal(events.body.events.at(-1).reasonCode, 'runtime_interrupted');
  assert.equal(fixture.fakeProvider.calls, 2);
  assert.equal(fixture.fakeProvider.aborts, 1);
  const missing = await fixture.api.get('/internal/work/runs/' + encodeURIComponent(fixture.run.runId) + '/result');
  assert.equal(missing.status, 404);
  assert.equal(fixture.home.dshHost.describe().activeRuns, 0);
});

async function createServiceFixture(t, providerMode) {
  assert.equal(DSH_MANIFEST.sourceRevision, DSH_REVISION);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsh-h2-'));
  const dataDir = path.join(root, 'home-node');
  const credentialDataDir = path.join(root, 'credential-vault');
  const workspaceRoot = path.join(root, 'desktop-workspace-fixture');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(credentialDataDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'private'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'review.txt'), ALLOWED_CONTENT + '\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'private', 'secret.txt'), OUTSIDE_CONTENT + '\n', 'utf8');

  const fakeProvider = createFakeProvider(providerMode);
  const dshNodeModelPort = createNodeModelPort({ fetch: fakeProvider.fetch, timeoutMs: 30000 });
  const children = [];
  const home = homeNodeService.buildHomeNode({
    dataDir,
    credentialDataDir,
    token: TOKEN,
    host: '127.0.0.1',
    allowedOrigins: [],
    dshHostEnabled: true,
    dshNodeModelPort,
    dshTempRoot: root,
    dshTimeoutMs: 30000,
    dshWorkspaceRequestTimeoutMs: 10000,
    dshProtocolVersion: 1,
    dsh: {
      revision: DSH_REVISION,
      nodeExe: DSH_NODE,
      repoRoot: DSH_ROOT,
      tsxLoader: DSH_TSX,
      binScript: DSH_BIN,
      patches: [DSH_PATCH]
    },
    dshSpawn(command, args, options) {
      const child = nodeSpawn(command, args, options);
      children.push({ child, options: options, args: args.slice() });
      return child;
    },
    logger: () => {}
  });
  let pumping = false;
  let pollController = null;
  let pumpPromise = Promise.resolve();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    pumping = false;
    if (pollController) pollController.abort();
    try { await Promise.race([pumpPromise, new Promise(resolve => setTimeout(resolve, 3000))]); } catch (_) {}
    try { await home.close(); } catch (_) {}
    removeFixtureRoot(root);
  };
  t.after(stop);

  home.open();
  const server = home.server;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = 'http://127.0.0.1:' + address.port;

  const vault = createCredentialVault({ dataDir: credentialDataDir });
  assert.equal(vault.upsert(PROVIDER_REF, { provider: 'openai', apiKey: FAKE_SECRET }), true);
  assert.equal(vault.upsert(MIDDLE_REF, { provider: 'openai', apiKey: FAKE_SECRET }), true);
  const apiConfigs = [
    {
      id: PROVIDER_REF,
      provider: 'openai',
      model: 'fake-h2-v1',
      endpoint: PROVIDER_URL,
      credentialRef: PROVIDER_REF,
      apiKey: FAKE_SECRET,
      nickname: 'H2 Fake Provider',
      systemPrompt: 'Read a consented test workspace file.'
    },
    {
      id: MIDDLE_REF,
      provider: 'openai',
      model: 'fake-h2-middle-v1',
      endpoint: MIDDLE_URL,
      credentialRef: MIDDLE_REF,
      apiKey: FAKE_SECRET,
      nickname: 'H2 Fake Middle Brain Provider'
    }
  ];
  const projectedCharacters = mobileDto.characterCatalog(apiConfigs, { withSpec: true });
  assert.equal(projectedCharacters.length, 2);
  assert.equal(JSON.stringify(projectedCharacters).includes(FAKE_SECRET), false);
  const published = await requestApi(baseUrl, 'POST', '/characters/publish', {
    characters: projectedCharacters,
    merge: false
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.ok, true);
  const providerSpec = home.registry.getCharacterSpec(PROVIDER_REF);
  const middleSpec = home.registry.getCharacterSpec(MIDDLE_REF);
  assert.equal(providerSpec.provider, apiConfigs[0].provider);
  assert.equal(providerSpec.model, apiConfigs[0].model);
  assert.equal(providerSpec.endpoint, apiConfigs[0].endpoint);
  assert.equal(providerSpec.credentialRef, apiConfigs[0].credentialRef);
  assert.equal(Object.prototype.hasOwnProperty.call(providerSpec, 'apiKey'), false);
  assert.equal(middleSpec.model, apiConfigs[1].model);
  assert.equal(middleSpec.credentialRef, apiConfigs[1].credentialRef);

  const routeScope = await consentCore.providerScope('agent', PROVIDER_REF, providerSpec, crypto.webcrypto);
  const middleScope = await consentCore.providerScope('middle_brain', MIDDLE_REF, middleSpec, crypto.webcrypto);
  assert.ok(routeScope && middleScope);
  const created = await requestApi(baseUrl, 'POST', '/internal/work/runs', {
    requestId: 'h2-create-' + crypto.randomUUID(),
    workflowId: createWorkRunStore.WORKFLOW_ID,
    projectRef: PROJECT_REF
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const executorSelection = selectionFor(routeScope);
  assert.ok(executorSelection, 'the DSH Run must freeze its Home Node provider and tool route');
  const pinned = await requestApi(baseUrl, 'POST', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId) + '/executor-selection', {
    expectedVersion: created.body.run.version,
    executorSelection
  });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  const consentResult = await requestApi(baseUrl, 'POST', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId) + '/consents', {
    requestId: 'h2-consent-' + crypto.randomUUID(),
    expectedVersion: pinned.body.run.version,
    projectRef: PROJECT_REF,
    providerScopes: [routeScope, middleScope].sort((left, right) => left.destination.localeCompare(right.destination)),
    fileIds: [FILE_ID],
    memoryScope: null,
    memoryDerivedScope: null,
    expiresInMs: 60000,
    termsVersion: createWorkRunStore.CONSENT_TERMS_VERSION,
    confirmed: true
  });
  assert.equal(consentResult.status, 200, JSON.stringify(consentResult.body));
  const sessionId = 'session-' + crypto.randomUUID();
  const latestRun = await requestApi(baseUrl, 'GET', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId));
  const linked = await requestApi(baseUrl, 'POST', '/internal/work/runs/' + encodeURIComponent(created.body.run.runId) + '/dsh-session', {
    sessionId, consentId: consentResult.body.consent.consentId, expectedVersion: latestRun.body.run.version
  });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));

  let workspaceReads = 0;
  const readFile = () => {
    const filePath = path.join(workspaceRoot, 'src', 'review.txt');
    const content = fs.readFileSync(filePath, 'utf8');
    const safePath = 'src/review.txt';
    const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    return { path: safePath, content, size: Buffer.byteLength(content, 'utf8'), contentHash };
  };
  const workspaceApi = {
    async wsGetWorkModeProjectSnapshot(projectRef) {
      if (projectRef !== PROJECT_REF) return { ok: false, error: 'project-not-found' };
      const file = readFile();
      return { ok: true, projectRef, files: [{ fileId: FILE_ID, path: file.path, size: file.size, contentHash: file.contentHash }] };
    },
    async wsReadWorkModeFile(projectRef, fileId) {
      if (projectRef !== PROJECT_REF || fileId !== FILE_ID) return { ok: false, error: 'scope-denied' };
      workspaceReads += 1;
      const file = readFile();
      return { ok: true, projectRef, fileId, ...file };
    }
  };
  const desktopProjectTool = createReadOnlyProjectTool({
    workspace: workspaceApi,
    maxFiles: 1,
    maxFileBytes: 4096,
    maxTotalReadBytes: 4096
  });

  pumping = true;
  pumpPromise = (async () => {
    while (pumping) {
      pollController = new AbortController();
      let polled;
      try {
        polled = await requestApi(baseUrl, 'POST', '/internal/work/workspace-project-bridge/poll',
          { waitMs: 15000 }, pollController.signal);
      } catch (_) {
        if (pumping) await new Promise(resolve => setTimeout(resolve, 10));
        continue;
      }
      if (!pumping || !polled.body || polled.body.ok !== true || !polled.body.job) continue;
      const job = polled.body.job;
      let result;
      try {
        if (job.operation === 'snapshot') result = await desktopProjectTool.snapshot(job.input.projectRef);
        else if (job.operation === 'read_file') {
          const read = await desktopProjectTool.readFile(job.input);
          const grant = job.input.scope.files.find(file => file.fileId === job.input.fileId);
          result = read && read.ok === true && grant ? {
            ok: true,
            projectRef: job.input.projectRef,
            fileId: read.fileId,
            path: read.path,
            content: read.content,
            contentHash: grant.contentHash,
            size: read.bytesRead
          } : read;
        }
        else result = { ok: false, error: 'workspace-operation-denied' };
      } catch (_) { result = { ok: false, error: 'workspace-unavailable' }; }
      await requestApi(baseUrl, 'POST', '/internal/work/workspace-project-bridge/resolve', {
        requestId: job.requestId,
        result: result
      });
    }
  })();

  return {
    root,
    workspaceRoot,
    home,
    api: {
      get: pathname => requestApi(baseUrl, 'GET', pathname),
      post: (pathname, body) => requestApi(baseUrl, 'POST', pathname,
        pathname.endsWith('/dsh') ? Object.assign({}, body, { sessionId: sessionId }) : body)
    },
    run: created.body.run,
    consent: consentResult.body.consent,
    fakeProvider,
    children,
    stop,
    get workspaceReads() { return workspaceReads; }
  };
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function waitForChildHealth(child, port, getOutput) {
  const deadline = Date.now() + 15000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Dev Home Node exited before health: ' + String(getOutput() || ''));
    }
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/health');
      if (response.ok) return await response.json();
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Dev Home Node health timed out: ' + String(lastError && lastError.message || '') + '\n' + String(getOutput() || ''));
}

async function requestApi(baseUrl, method, pathname, body, signal, additionalHeaders) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: Object.assign({ Authorization: 'Bearer ' + TOKEN }, body === undefined ? {} : { 'Content-Type': 'application/json' }, additionalHeaders || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });
  let parsed = {};
  try { parsed = await response.json(); } catch (_) {}
  return { status: response.status, body: parsed };
}

function removeFixtureRoot(root) {
  const resolved = path.resolve(String(root || ''));
  const parent = path.resolve(os.tmpdir());
  if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
    || !/^ib-dsh-h2-[A-Za-z0-9]+$/.test(path.basename(resolved))) {
    throw new Error('refusing to remove a path outside the H2 test temp root');
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (fs.existsSync(resolved)) throw new Error('H2 test temp root cleanup failed');
}

function createFakeProvider(mode) {
  let calls = 0;
  let aborts = 0;
  let observedAuthorization = '';
  const waiters = new Map();
  function waitForCall(index) {
    if (calls >= index) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fake Provider call timeout')), 15000);
      const pending = waiters.get(index) || [];
      pending.push(() => { clearTimeout(timer); resolve(); });
      waiters.set(index, pending);
    });
  }
  async function fetchFake(input, init) {
    calls += 1;
    const index = calls;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, PROVIDER_URL);
    observedAuthorization = String(init && init.headers && init.headers.Authorization || '');
    assert.equal(observedAuthorization, 'Bearer ' + FAKE_SECRET);
    for (const resolve of waiters.get(index) || []) resolve();
    waiters.delete(index);
    const hold = mode === 'hold-first' && index === 1 || mode === 'hold-second' && index === 2;
    if (hold) {
      await new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (!signal || signal.aborted) {
          aborts += 1;
          reject(Object.assign(new Error('Fake Provider request aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => {
          aborts += 1;
          reject(Object.assign(new Error('Fake Provider request aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
    const request = JSON.parse(String(init && init.body || '{}'));
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const content = index === 1
      ? JSON.stringify({ action: 'call_tool', name: 'project.read_file', arguments: { fileId: FILE_ID } })
      : JSON.stringify({
          schemaVersion: 1,
          summary: 'Read the consented workspace file and return the verified result.',
          findings: [{
            fileId: FILE_ID,
            path: 'src/review.txt',
            line: 1,
            severity: 'info',
            title: 'Fake fixture content observed',
            detail: messages.some(message => JSON.stringify(message).includes(ALLOWED_CONTENT))
              ? ALLOWED_CONTENT : 'project tool content missing'
          }]
        });
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: index === 1 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 16, completion_tokens: 12 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return {
    fetch: fetchFake,
    waitForCall,
    get calls() { return calls; },
    get aborts() { return aborts; },
    get observedAuthorization() { return observedAuthorization; }
  };
}
