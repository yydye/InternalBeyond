'use strict';

/* Focused H1 integration tests: Home Node Authority + Vault Resolver + DSH ACP child. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn: nodeSpawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DSH_ROOT = path.resolve(process.env.IB_DSH_INTERNAL_RUNTIME || path.join(ROOT, 'runtime', 'dsh-runtime'));
const DSH_REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const DSH_NODE = path.resolve(process.env.IB_POC_NODE_EXE || path.join(ROOT, 'runtime', 'node', 'node.exe'));
const DSH_MANIFEST = JSON.parse(fs.readFileSync(path.join(DSH_ROOT, 'runtime-manifest.json'), 'utf8'));
const DSH_REQUIRE = createRequire(path.join(DSH_ROOT, 'apps', 'cli', 'package.json'));
const DSH_BIN = path.join(DSH_ROOT, 'apps', 'cli', 'src', 'bin.ts');
const DSH_PATCH = path.join(DSH_ROOT, 'config', 'cordis.yml');
const DSH_PROTOCOL = DSH_REQUIRE.resolve('@agentclientprotocol/sdk');
const DSH_TSX = pathToFileURL(DSH_REQUIRE.resolve('tsx/esm')).href;
const PROJECT_REF = 'dsh-host-h1-project';
const PROVIDER_REF = 'dsh-host-h1-provider';
const MIDDLE_REF = 'dsh-host-h1-middle';
const FILE_ID = 'allowed-file';
const CONTENT_SENTINEL = 'IB_DSH_H1_ALLOWED_SENTINEL';
const OUTSIDE_SENTINEL = 'IB_DSH_H1_OUTSIDE_SENTINEL';
const FAKE_PROVIDER_SECRET = 'H1_FAKE_PROVIDER_SECRET_MUST_NOT_ENTER_DSH';
const PROVIDER_ENDPOINT = 'https://dsh-h1-fake.invalid/v1/chat/completions';

const createWorkRunStore = require(path.join(ROOT, 'services', 'home-node', 'work-run-store.js'));
const createAppDraftStore = require(path.join(ROOT, 'services', 'home-node', 'app-draft-store.js'));
const createDeviceRegistry = require(path.join(ROOT, 'services', 'home-node', 'device-registry.js'));
const createCredentialVault = require(path.join(ROOT, 'active', 'credential-vault.js'));
const createCredentialAccess = require(path.join(ROOT, 'services', 'home-node', 'credential-access.js'));
const createNodeModelPort = require(path.join(ROOT, 'active', 'node-model-port.js'));
const createDshHostAdapter = require(path.join(ROOT, 'services', 'home-node', 'dsh-host-adapter.js'));
const actionRegistryCore = require(path.join(ROOT, 'assets', 'js', 'action-registry.js'));
const createReadOnlyProjectTool = require(path.join(ROOT, 'assets', 'js', 'work-mode-project-tool.js'));
const consentCore = require(path.join(ROOT, 'assets', 'js', 'work-mode-consent-core.js'));
const workModeExecutor = require(path.join(ROOT, 'assets', 'js', 'work-mode-executor.js'));
const { providerScope } = consentCore;

test('the new DSH Host remains disabled until explicitly configured', async () => {
  const host = createDshHostAdapter();
  assert.equal(host.describe().enabled, false);
  await assert.rejects(host.run({}), error => error && error.code === 'dsh-host-disabled');
});

test('an unbound DSH Session is rejected before Run state, Provider or child changes', async t => {
  const fixture = await createFixture(t, { fakeMode: 'complete' });
  const input = fixture.runInput();
  delete input.sessionId;
  const result = await fixture.adapter.run(input);
  assert.deepEqual(result, { ok: false, error: 'dsh-session-binding-required', reason: 'failed' });
  assert.equal(fixture.workRunStore.getRun(fixture.run.runId).run.status, 'queued');
  assert.equal(fixture.fakeProvider.calls, 0);
  assert.equal(fixture.children.length, 0);
});

test('H1 uses the fixed DSH commit and the InternalBeyond bundled Windows Node', async () => {
  assert.equal(DSH_MANIFEST.sourceRevision, DSH_REVISION);
  assert.equal(DSH_MANIFEST.target, 'windows-x64');
  assert.equal(execFileSync(DSH_NODE, ['--version'], { encoding: 'utf8' }).trim(), 'v24.18.0');
  assert.equal(process.platform, 'win32');
  const cordis = fs.readFileSync(DSH_PATCH, 'utf8');
  assert.match(cordis, /- id: session-persistence-jsonl[\s\S]*?disabled: true/);
  assert.match(cordis, /name: '\.\/memory-session-persistence\.ts'/);
});

test('the embedded runtime retains the upstream Cordis CLI and ACP profile package graph', () => {
  const cli = JSON.parse(fs.readFileSync(path.join(DSH_ROOT, 'apps', 'cli', 'package.json'), 'utf8'));
  const profilePackages = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'];
  const runtimeNames = new Set(DSH_MANIFEST.workspacePackages.map(item => item.name));
  for (const name of Object.keys(cli.dependencies || {}).filter(name => name.startsWith('@deepseek-ai/'))) {
    assert.ok(runtimeNames.has(name), `missing upstream CLI workspace package ${name}`);
  }
  for (const name of profilePackages) assert.ok(runtimeNames.has(name), `missing ACP Cordis bundle ${name}`);
  for (const record of DSH_MANIFEST.workspacePackages.concat(DSH_MANIFEST.externalPackages)) {
    const resolved = path.resolve(DSH_ROOT, record.runtimePath);
    assert.ok(resolved === DSH_ROOT || resolved.startsWith(DSH_ROOT + path.sep), `runtime path escapes the repository: ${record.runtimePath}`);
  }
  assert.equal(DSH_MANIFEST.artifactBytes > 0, true);
  assert.equal(fs.existsSync(path.join(DSH_ROOT, 'LICENSE')), true);
  assert.equal(fs.existsSync(path.join(DSH_ROOT, 'THIRD_PARTY_NOTICES.md')), true);
  assert.equal(fs.existsSync(path.join(DSH_ROOT, 'THIRD_PARTY_RUNTIME.json')), true);
});

test('binary@0.3.0 uses the self-authored buffers compatibility package', async () => {
  const binaryEntry = DSH_REQUIRE.resolve('binary');
  const binaryRequire = createRequire(binaryEntry);
  const buffersEntry = binaryRequire.resolve('buffers');
  const replacementRoot = path.dirname(buffersEntry);
  const replacementManifest = JSON.parse(fs.readFileSync(path.join(replacementRoot, 'package.json'), 'utf8'));
  const binaryManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(binaryEntry), 'package.json'), 'utf8'));

  assert.equal(DSH_MANIFEST.externalPackages.some(item => item.name === 'buffers' && item.version === '0.1.1'), false);
  assert.equal(replacementManifest.name, 'buffers');
  assert.equal(replacementManifest.version, '1.0.0-ib.1');
  assert.equal(replacementManifest.license, 'MIT');
  assert.equal(replacementManifest.internalbeyond.replaces, 'buffers@0.1.1');
  assert.equal(binaryManifest.dependencies.buffers, replacementManifest.version);
  assert.equal(path.resolve(replacementRoot), path.resolve(DSH_ROOT, 'node_modules', 'buffers'));
  assert.ok(DSH_MANIFEST.compatibilityPackages.some(item => item.name === 'buffers'
    && item.version === replacementManifest.version && item.license === 'MIT'));
  assert.ok(DSH_MANIFEST.compatibilityOverrides.some(item => item.consumer === 'binary'
    && item.dependency === 'buffers' && item.requested === '~0.1.1'
    && item.replacement === replacementManifest.version));

  const createBuffers = binaryRequire('buffers');
  const chunks = createBuffers();
  chunks.push(Buffer.from('ab'), Buffer.from('cd'));
  assert.equal(chunks.length, 4);
  assert.equal(chunks.indexOf(Buffer.from('bc')), 1, 'indexOf searches across input chunk boundaries');
  assert.equal(chunks.slice(1, 3).toString(), 'bc');
  const removed = chunks.splice(1, 2);
  assert.equal(removed.slice().toString(), 'bc');
  assert.equal(chunks.slice().toString(), 'ad');
  chunks.unshift(Buffer.from('z'));
  assert.equal(chunks.slice().toString(), 'zad');
  assert.throws(() => chunks.push('not a Buffer'), /Buffer/);

  const binary = binaryRequire('binary');
  const parsed = await new Promise((resolve, reject) => {
    const stream = binary.stream();
    const timer = setTimeout(() => reject(new Error('binary scan did not finish')), 1000);
    stream.scan('prefix', Buffer.from('bc')).tap(values => {
      clearTimeout(timer);
      resolve(values.prefix.toString());
    });
    stream.write(Buffer.from('a'));
    stream.write(Buffer.from('bcx'));
  });
  assert.equal(parsed, 'a', 'the pinned binary consumer scans a marker across Buffer chunks');
});

test('Host manages one controlled ACP run and commits the validated Result via Work Run CAS', async t => {
  const registry = actionRegistryCore.createRegistry();
  const inspectInputs = [];
  const inspectOutputs = [];
  const actionRegistry = {
    resolveLegacyTool: registry.resolveLegacyTool,
    validateInput(actionId, input, caller) {
      if (actionId === 'ib.project.inspect.v1') inspectInputs.push(input);
      return registry.validateInput(actionId, input, caller);
    },
    validateOutput(actionId, output) {
      if (actionId === 'ib.project.inspect.v1') inspectOutputs.push(output);
      return registry.validateOutput(actionId, output);
    }
  };
  const fixture = await createFixture(t, { fakeMode: 'complete', actionRegistry });
  const outcome = await fixture.adapter.run(fixture.runInput());

  assert.equal(outcome.ok, true, JSON.stringify(outcome) + '\n' + fixture.processText());
  assert.equal(outcome.run.status, 'completed');
  assert.equal(outcome.result.status, 'available');
  assert.equal(outcome.result.schemaVersion, 1);
  assert.match(outcome.result.report.summary, /consented project file/);
  assert.equal(outcome.result.report.findings[0].fileId, FILE_ID);
  assert.equal(outcome.result.report.findings[0].detail, CONTENT_SENTINEL);
  assert.equal(fixture.fakeProvider.calls, 2);
  assert.equal(fixture.fakeProvider.aborts, 0);
  assert.equal(fixture.credentialCalls.length, 2);
  const traceEvents = fixture.adapter.getEvents(fixture.run.runId).filter(event => event.event === 'dsh-session-event');
  assert(traceEvents.some(event => event.dshEvent && event.dshEvent.type === 'request/header'),
    'the Host must retain the real DSH model request event');
  assert(traceEvents.some(event => event.dshEvent && event.dshEvent.type === 'tool/call'),
    'the Host must retain the real DSH tool-call event');
  assert(traceEvents.some(event => event.dshEvent && event.dshEvent.type === 'tool/result'),
    'the Host must retain the real DSH tool-result event');
  assert(traceEvents.every(event => event.dshEvent && event.dshEvent.model === 'fake-v1'),
    'the trace must use the Consent-bound Home Node model route');
  assert.equal(JSON.stringify(traceEvents).includes(CONTENT_SENTINEL), false,
    'DSH event projection must not copy the authorized source file into the progress cache');
  assert.equal(fixture.childOptions.length, 1);
  assert.equal(fixture.childOptions[0].windowsHide, true);
  assert.equal(fixture.childOptions[0].stdio.join(','), 'pipe,pipe,pipe');
  assert.notEqual(fixture.childOptions[0].cwd, fixture.workspaceRoot);
  assert.equal(fixture.childOptions[0].env.OPENAI_API_KEY, undefined);
  assert.equal(fixture.childOptions[0].env.ANTHROPIC_API_KEY, undefined);
  assert.equal(fixture.childOptions[0].env.DEEPSEEK_API_KEY, undefined);
  assert.equal(fixture.childOptions[0].env.H1_FAKE_PROVIDER_SECRET, undefined);
  assert.equal(fixture.childOptions[0].env.IB_POC_HOME_NODE_URL, undefined);
  assert.equal(fixture.childOptions[0].env.IB_POC_RUN_ID, undefined);
  assert.equal(fixture.childOptions[0].env.IB_POC_AGENT_SCOPE, undefined);
  assert.equal(fixture.processText().includes(FAKE_PROVIDER_SECRET), false);
  assert.equal(fixture.fakeProvider.observedAuthorization, `Bearer ${FAKE_PROVIDER_SECRET}`);

  const stored = fixture.workRunStore.getResult(fixture.run.runId);
  assert.equal(stored.ok, true);
  assert.equal(stored.result.report.findings[0].detail, CONTENT_SENTINEL);
  assert.equal(stored.run.version, fixture.run.version + 2);
  const actionTraces = fixture.workRunStore.listEvents(fixture.run.runId, { limit: 20 }).events
    .filter(event => event.eventType === 'action_trace').map(event => event.actionTrace);
  assert.deepEqual(inspectInputs[0].fileIds, [FILE_ID], 'inspect receives only the current Run Consent file IDs');
  assert.equal(inspectInputs[0].projectRef, PROJECT_REF, 'inspect uses the Run-injected projectRef');
  assert.equal(inspectOutputs[0].scope, 'run-consented-files');
  assert.deepEqual(inspectOutputs[0].files.map(file => file.fileId), [FILE_ID]);
  assert.deepEqual(actionTraces.map(trace => ({ actionId: trace.actionId, status: trace.status,
    authorityResult: trace.authorityResult, runId: trace.runId })), [{
    actionId: 'ib.project.inspect.v1', status: 'succeeded', authorityResult: 'allowed', runId: fixture.run.runId
  }, {
    actionId: 'ib.workspace.read_file.v1', status: 'succeeded', authorityResult: 'allowed', runId: fixture.run.runId
  }]);
  assert.equal(JSON.stringify(actionTraces).includes(CONTENT_SENTINEL), false);
  assert.equal(JSON.stringify(actionTraces).includes(FAKE_PROVIDER_SECRET), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'home-node', 'home-node.db')), true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'credential-vault', 'credential-vault.json')), true);
});

test('Project Inspect denies a consented file absent from the authorized Workspace snapshot', async t => {
  const fixture = await createFixture(t, {
    fakeMode: 'complete',
    projectToolFactory(workspaceRoot) {
      const tool = createWorkspaceProjectTool(workspaceRoot);
      return Object.assign({}, tool, {
        snapshot: async projectRef => ({ ok: true, projectRef, files: [] })
      });
    }
  });
  const outcome = await fixture.adapter.run(fixture.runInput());
  assert.equal(outcome.ok, false);
  assert.equal(fixture.fakeProvider.calls, 0, 'Workspace rejection happens before provider execution');
  assert.equal(fixture.childOptions.length, 0, 'Workspace rejection happens before child startup');
  const inspectTrace = fixture.workRunStore.listEvents(fixture.run.runId, { limit: 20 }).events
    .find(event => event.eventType === 'action_trace' && event.actionTrace.actionId === 'ib.project.inspect.v1');
  assert.deepEqual(inspectTrace && {
    status: inspectTrace.actionTrace.status,
    authorityResult: inspectTrace.actionTrace.authorityResult
  }, { status: 'denied', authorityResult: 'denied' });
});

test('Host refuses Project Inspect when the Action Registry denies the descriptor', async t => {
  const registry = actionRegistryCore.createRegistry();
  const fixture = await createFixture(t, {
    fakeMode: 'complete',
    actionRegistry: {
      resolveLegacyTool: registry.resolveLegacyTool,
      validateInput(actionId, input, caller) {
        if (actionId === 'ib.project.inspect.v1') return { ok: false, error: 'ACTION_NOT_REGISTERED' };
        return registry.validateInput(actionId, input, caller);
      },
      validateOutput: registry.validateOutput
    }
  });
  const outcome = await fixture.adapter.run(fixture.runInput());
  assert.equal(outcome.ok, false);
  assert.equal(fixture.fakeProvider.calls, 0);
  assert.equal(fixture.childOptions.length, 0);
  const inspectTrace = fixture.workRunStore.listEvents(fixture.run.runId, { limit: 20 }).events
    .find(event => event.eventType === 'action_trace' && event.actionTrace.actionId === 'ib.project.inspect.v1');
  assert.deepEqual(inspectTrace && {
    status: inspectTrace.actionTrace.status,
    authorityResult: inspectTrace.actionTrace.authorityResult
  }, { status: 'denied', authorityResult: 'denied' });
});

test('Host canonicalizes legacy snapshot error codes and preserves the snapshot reason', async t => {
  const hostEvents = [];
  const fixture = await createFixture(t, {
    fakeMode: 'complete',
    onEvent: event => hostEvents.push(event),
    projectToolFactory(workspaceRoot) {
      const tool = createWorkspaceProjectTool(workspaceRoot);
      return Object.assign({}, tool, {
        readFile: async () => ({ ok: false, error: 'workspace-changed-snapshot' })
      });
    }
  });
  const outcome = await fixture.adapter.run(fixture.runInput());
  const runEvents = fixture.adapter.getEvents(fixture.run.runId);
  const event = runEvents.find(item => item.event === 'tool-denied'
    && item.toolName === 'project.read_file' && item.reason === 'snapshot-mismatch');
  assert(event, 'the Run event retains the stale-snapshot reason: ' + JSON.stringify({ outcome: outcome,
    runEvents: runEvents, hostEvents: hostEvents, providerCalls: fixture.fakeProvider.calls, processText: fixture.processText() }));
  assert.equal(event.code, 'workspace-changed', 'new Run events emit only the canonical Workspace change code');
  assert(hostEvents.some(item => item.event === 'tool-denied' && item.code === 'workspace-changed'
    && item.reason === 'snapshot-mismatch'));
  assert.equal(JSON.stringify(fixture.adapter.getEvents(fixture.run.runId)).includes('workspace-changed-snapshot'), false,
    'legacy error values are normalized before entering the Run event projection');
});

test('P2 Host narrows DSH tools to the Middle Brain Plan and returns a transient candidate for Review', async t => {
  const fixture = await createFixture(t, { fakeMode: 'complete' });
  const started = fixture.workRunStore.transition({
    runId: fixture.run.runId,
    requestId: 'dsh-p2-runtime-start-' + crypto.randomUUID(),
    expectedVersion: fixture.run.version,
    status: 'running',
    reasonCode: 'runtime_started'
  });
  assert.equal(started.ok, true);
  const outcome = await fixture.adapter.run(fixture.runInput({ deferResult: true, plannedFileIds: [FILE_ID] }));

  assert.equal(outcome.ok, true, JSON.stringify(outcome) + '\n' + fixture.processText());
  assert.equal(outcome.run.status, 'running', 'DSH Host leaves the canonical Run open while Middle Brain reviews');
  assert.equal(outcome.candidate.schemaVersion, 1);
  assert.equal(outcome.candidate.findings[0].detail, CONTENT_SENTINEL);
  assert.equal(fixture.workRunStore.getResult(fixture.run.runId).code, 'RESULT_NOT_FOUND',
    'the DSH Gateway cannot persist a Result before the Home Node Review decision');
  assert.equal(fixture.fakeProvider.calls, 2);
  assert.equal(fixture.workRunStore.getRun(fixture.run.runId).run.status, 'running');

  const completed = fixture.workRunStore.completeRun({
    runId: fixture.run.runId,
    requestId: 'dsh-p2-reviewed-result-' + crypto.randomUUID(),
    expectedVersion: outcome.run.version,
    consentId: fixture.consent.consentId,
    result: outcome.candidate
  });
  assert.equal(completed.ok, true, JSON.stringify(completed));
  assert.equal(completed.run.status, 'completed');
  assert.equal(fixture.workRunStore.getResult(fixture.run.runId).result.report.findings[0].detail, CONTENT_SENTINEL);
});

test('General preset enforces its one-read project tool budget at the Host', async t => {
  const events = [];
  const fixture = await createFixture(t, { fakeMode: 'repeat-tool', presetId: 'general', onEvent: event => events.push(event) });
  await fixture.adapter.run(fixture.runInput());
  const hostEvents = fixture.adapter.getEvents(fixture.run.runId);
  assert.equal(hostEvents.filter(event => event.event === 'project-read').length, 1);
  assert(hostEvents.some(event => event.event === 'tool-denied' && event.code === 'preset-tool-call-limit'));
  assert(events.some(event => event.event === 'tool-denied' && event.code === 'preset-tool-call-limit'));
});

test('Host denies a legacy project read when its Action Registry has no registered mapping', async t => {
  let validations = 0;
  const registry = actionRegistryCore.createRegistry();
  const fixture = await createFixture(t, {
    fakeMode: 'complete',
    actionRegistry: {
      resolveLegacyTool: () => 'ib.unknown.v1',
      validateInput: (actionId, input, caller) => {
        if (actionId === 'ib.project.inspect.v1') return registry.validateInput(actionId, input, caller);
        validations++;
        return { ok: false, error: 'ACTION_NOT_REGISTERED' };
      },
      validateOutput: (actionId, output) => registry.validateOutput(actionId, output)
    }
  });
  await fixture.adapter.run(fixture.runInput());
  assert.ok(validations > 0, 'the DSH Host resolves and validates the legacy tool through the Registry');
  assert.equal(fixture.adapter.getEvents(fixture.run.runId).some(event => event.event === 'project-read'), false,
    'an unregistered Action never reaches Workspace read');
  const deniedTrace = fixture.workRunStore.listEvents(fixture.run.runId, { limit: 20 }).events
    .find(event => event.eventType === 'action_trace'
      && event.actionTrace && event.actionTrace.actionId === 'ib.unknown.v1');
  assert.deepEqual(deniedTrace && deniedTrace.actionTrace && {
    actionId: deniedTrace.actionTrace.actionId,
    status: deniedTrace.actionTrace.status,
    authorityResult: deniedTrace.actionTrace.authorityResult
  }, { actionId: 'ib.unknown.v1', status: 'denied', authorityResult: 'denied' });
});

test('App Builder DSH tools write only the consented isolated draft files', async t => {
  const fixture = await createFixture(t, { fakeMode: 'app-builder', presetId: 'app-builder', appBuilder: true });
  const outcome = await fixture.adapter.run(fixture.runInput({ deferResult: true, plannedFileIds: [] }));
  assert.equal(outcome.ok, true, JSON.stringify(outcome) + '\n' + fixture.processText());
  assert.equal(outcome.run.status, 'running');
  assert.equal(outcome.candidate.schemaVersion, 1);
  assert.deepEqual(Object.keys(fixture.appDraftStore.getRunContext({ draftRef: fixture.draft.draftRef, projectRef: PROJECT_REF,
    runId: fixture.run.runId }).files).sort(), ['app.js', 'index.html', 'styles.css'],
  'the Host sees its isolated candidate, while public draft reads retain only committed files');
  assert.deepEqual(Object.keys(fixture.appDraftStore.get({ draftRef: fixture.draft.draftRef, projectRef: PROJECT_REF }).draft.files), [],
    'the public committed draft remains unchanged until Home Node accepts the Result');
  assert.equal(fixture.fakeProvider.calls, 5);
  assert.equal(fixture.childOptions[0].env.IB_DSH_ALLOWED_TOOLS, workModeExecutor.APP_DRAFT_TOOLS.join(','));
  assert.equal(fixture.adapter.getEvents(fixture.run.runId).filter(event => event.event === 'app-draft-file-written').length, 3);
  assert.equal(fixture.adapter.getEvents(fixture.run.runId).some(event => event.event === 'project-read'), false);
  assert.equal(fixture.workRunStore.getConsent(fixture.run.runId, fixture.consent.consentId).consent.fileIds.length, 0);
});

test('Host refuses ACP MCP configuration before creating or starting a Run', async t => {
  const fixture = await createFixture(t, { fakeMode: 'complete' });
  const outcome = await fixture.adapter.run(Object.assign({}, fixture.runInput(), {
    mcpServers: [{ name: 'untrusted', command: 'C:\\Windows\\System32\\cmd.exe', args: [], env: [] }]
  }));
  assert.deepEqual(outcome, { ok: false, error: 'mcp-configuration-denied' });
  assert.equal(fixture.workRunStore.getRun(fixture.run.runId).run.status, 'queued');
  assert.equal(fixture.childOptions.length, 0);
  assert.equal(fixture.fakeProvider.calls, 0);
});

test('revoked Consent blocks the next Host ModelPort send', async t => {
  let revoked = false;
  const fixture = await createFixture(t, {
    fakeMode: 'complete',
    onEvent(event, deps) {
      if (event.event !== 'model-preflight' || event.call !== 2 || revoked) return;
      revoked = true;
      const current = deps.workRunStore.getRun(deps.runId).run;
      const result = deps.workRunStore.revokeConsent({
        runId: deps.runId,
        consentId: deps.consentId,
        requestId: 'dsh-h1-revoke-before-second-send',
        expectedVersion: current.version
      });
      assert.equal(result.ok, true);
    }
  });
  const outcome = await fixture.adapter.run(fixture.runInput());
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /consent/i);
  assert.equal(fixture.fakeProvider.calls, 1);
  assert.equal(fixture.workRunStore.getRun(fixture.run.runId).run.status, 'failed');
  assert.equal(fixture.workRunStore.getResult(fixture.run.runId).code, 'RESULT_NOT_FOUND');
});

test('a Provider Registry route change invalidates Consent before send', async t => {
  let changed = false;
  const fixture = await createFixture(t, {
    fakeMode: 'complete',
    onEvent(event, deps) {
      if (event.event !== 'model-preflight' || event.call !== 2 || changed) return;
      changed = true;
      const write = deps.registry.putCharacter(PROVIDER_REF, { id: PROVIDER_REF }, {
        provider: 'openai',
        model: 'fake-v2',
        endpoint: 'https://dsh-h1-fake.invalid/v2/chat/completions',
        credentialRef: PROVIDER_REF
      });
      assert.equal(write.ok, true);
    }
  });
  const outcome = await fixture.adapter.run(fixture.runInput());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'CONSENT_PROVIDER_MISMATCH');
  assert.equal(fixture.fakeProvider.calls, 1);
  assert.equal(fixture.workRunStore.getResult(fixture.run.runId).code, 'RESULT_NOT_FOUND');
});

test('an equivalent normalized endpoint retains its authorized Provider route', async t => {
  const fixture = await createFixture(t, { fakeMode: 'complete' });
  assert.equal(fixture.registry.putCharacter(PROVIDER_REF, { id: PROVIDER_REF }, {
    provider: 'openai', model: 'fake-v1',
    endpoint: ' HTTPS://DSH-H1-FAKE.INVALID:443/v1/chat/completions ', credentialRef: PROVIDER_REF
  }).ok, true);
  const result = await fixture.adapter.run(fixture.runInput());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fixture.fakeProvider.calls, 2);
  assert.equal(fixture.workRunStore.getRun(fixture.run.runId).run.status, 'completed');
});

test('Home Node cancellation aborts the in-flight model request before another tool or send', async t => {
  const fixture = await createFixture(t, { fakeMode: 'hold-first' });
  const running = fixture.adapter.run(fixture.runInput());
  await fixture.fakeProvider.waitForCall(1);
  const cancelled = await fixture.adapter.cancel(fixture.run.runId, 'user');
  assert.equal(cancelled.ok, true);
  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'execution-cancelled');
  assert.equal(fixture.fakeProvider.calls, 1);
  assert.equal(fixture.fakeProvider.aborts, 1);
  assert.equal(fixture.workRunStore.getRun(fixture.run.runId).run.status, 'cancelled');
  assert.equal(fixture.workRunStore.getResult(fixture.run.runId).code, 'RESULT_NOT_FOUND');
});

test('execution timeout aborts the provider request and terminalizes the Run', async t => {
  const fixture = await createFixture(t, { fakeMode: 'hold-first' });
  const running = fixture.adapter.run(fixture.runInput({ timeoutMs: 5000 }));
  await fixture.fakeProvider.waitForCall(1);
  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, 'execution-timeout');
  assert.equal(fixture.fakeProvider.calls, 1);
  assert.equal(fixture.fakeProvider.aborts, 1);
  assert.equal(fixture.workRunStore.getRun(fixture.run.runId).run.status, 'failed');
  assert.equal(fixture.workRunStore.getResult(fixture.run.runId).code, 'RESULT_NOT_FOUND');
});

test('child crash aborts the current send, fails the Run and prevents a later send', async t => {
  const fixture = await createFixture(t, { fakeMode: 'hold-second' });
  const running = fixture.adapter.run(fixture.runInput());
  await fixture.fakeProvider.waitForCall(2);
  assert.equal(fixture.children.length, 1);
  fixture.children[0].kill('SIGKILL');
  const outcome = await running;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'crash');
  assert.equal(fixture.fakeProvider.calls, 2);
  assert.equal(fixture.fakeProvider.aborts, 1);
  assert.equal(fixture.workRunStore.getRun(fixture.run.runId).run.status, 'failed');
  assert.equal(fixture.workRunStore.getResult(fixture.run.runId).code, 'RESULT_NOT_FOUND');
});

async function createFixture(t, options) {
  options = options || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsh-h1-'));
  const workspaceRoot = path.join(root, 'workspace');
  const homeNodeDir = path.join(root, 'home-node');
  const credentialDir = path.join(root, 'credential-vault');
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, 'private'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'project.txt'), `${CONTENT_SENTINEL}\n`, 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'private', 'secret.txt'), `${OUTSIDE_SENTINEL}\n`, 'utf8');
  fs.mkdirSync(homeNodeDir, { recursive: true });
  fs.mkdirSync(credentialDir, { recursive: true });

  const workRunStore = createWorkRunStore({ dataDir: homeNodeDir, logger: () => {} });
  const appDraftStore = createAppDraftStore({ dataDir: homeNodeDir });
  const registry = createDeviceRegistry({ dataDir: homeNodeDir, logger: () => {} });
  workRunStore.open();
  appDraftStore.open();
  registry.open();

  const agentSpec = {
    provider: 'openai',
    model: 'fake-v1',
    endpoint: PROVIDER_ENDPOINT,
    credentialRef: PROVIDER_REF
  };
  const middleSpec = {
    provider: 'openai',
    model: 'fake-middle-v1',
    endpoint: 'https://dsh-h1-fake.invalid/v1/middle',
    credentialRef: MIDDLE_REF
  };
  assert.equal(registry.putCharacter(PROVIDER_REF, { id: PROVIDER_REF }, agentSpec).ok, true);
  assert.equal(registry.putCharacter(MIDDLE_REF, { id: MIDDLE_REF }, middleSpec).ok, true);

  const vault = createCredentialVault({ dataDir: credentialDir });
  assert.equal(vault.upsert(PROVIDER_REF, { provider: 'openai', apiKey: FAKE_PROVIDER_SECRET }), true);
  const realCredentialAccess = createCredentialAccess({
    dataDir: credentialDir,
    isAllowed(bindingId) {
      return registry.listCharacters().some(character => {
        const spec = registry.getCharacterSpec(character.id);
        if (!spec) return false;
        const allowed = Object.prototype.hasOwnProperty.call(spec, 'credentialRef')
          ? String(spec.credentialRef || '').trim()
          : String(character.id || '');
        return allowed === bindingId;
      });
    }
  });
  const credentialCalls = [];
  const credentialAccess = Object.freeze({
    resolve(bindingId) {
      credentialCalls.push(bindingId);
      return realCredentialAccess.resolve(bindingId);
    }
  });

  const acpSdk = await import(pathToFileURL(DSH_PROTOCOL).href);

  const routeAgent = await providerScope('agent', PROVIDER_REF, agentSpec, crypto.webcrypto);
  const routeMiddle = await providerScope('middle_brain', MIDDLE_REF, middleSpec, crypto.webcrypto);
  assert.ok(routeAgent && routeMiddle);
  const appBuilder = options.appBuilder === true;
  const preset = workModeExecutor.preset(options.presetId || (appBuilder ? 'app-builder' : 'general'));
  const executorSelection = workModeExecutor.normalizeSnapshot({
    schemaVersion: 1,
    roleId: '',
    roleName: '标准 Agent',
    profileRef: PROVIDER_REF,
    presetId: preset.id,
    personaHash: crypto.createHash('sha256').update('', 'utf8').digest('hex'),
    providerScope: routeAgent,
    allowedTools: preset.allowedTools.slice(),
    maxProjectReadCalls: preset.maxProjectReadCalls
  });
  assert.ok(executorSelection, 'fixture pins the roleless executor and exact provider/tool scope');
  const draft = appBuilder ? appDraftStore.create({ projectRef: PROJECT_REF, name: 'Host App Draft' }).draft : null;
  const created = workRunStore.createRun({
    requestId: 'h1-run-create-' + crypto.randomUUID(),
    workflowId: appBuilder ? createWorkRunStore.APP_BUILDER_WORKFLOW_ID : createWorkRunStore.WORKFLOW_ID,
    projectRef: PROJECT_REF,
    executorSelection: executorSelection,
    ...(draft ? { appDraftRef: draft.draftRef } : {})
  });
  assert.equal(created.ok, true, JSON.stringify({ created: created, draftRef: draft && draft.draftRef,
    appBuilder: appBuilder, selection: executorSelection }));
  if (draft) assert.equal(appDraftStore.queueRun({ draftRef: draft.draftRef, projectRef: PROJECT_REF,
    runId: created.run.runId, instruction: 'Create a simple local todo app.' }).ok, true);
  const consent = workRunStore.grantConsent({
    runId: created.run.runId,
    requestId: 'h1-consent-grant-' + crypto.randomUUID(),
    expectedVersion: created.run.version,
    projectRef: PROJECT_REF,
    providerScopes: appBuilder ? [routeAgent] : [routeAgent, routeMiddle].sort((left, right) => left.destination.localeCompare(right.destination)),
    fileIds: appBuilder ? [] : [FILE_ID],
    memoryScope: null,
    memoryDerivedScope: null,
    expiresInMs: 60_000,
    termsVersion: createWorkRunStore.CONSENT_TERMS_VERSION,
    confirmed: true
  });
  assert.equal(consent.ok, true);
  const dshSessionId = 'session-' + crypto.randomUUID();
  const binding = workRunStore.bindDshSession({
    runId: created.run.runId, sessionId: dshSessionId, consentId: consent.consent.consentId,
    expectedVersion: created.run.version
  });
  assert.equal(binding.ok, true);

  const fakeProvider = createFakeProvider(options.fakeMode);
  const nodeModelPort = createNodeModelPort({ fetch: fakeProvider.fetch, timeoutMs: 30_000 });
  const childOptions = [];
  const children = [];
  const spawn = (command, args, spawnOptions) => {
    childOptions.push(spawnOptions);
    const child = nodeSpawn(command, args, spawnOptions);
    child.__h1Output = '';
    child.__h1Error = '';
    child.stdout.on('data', chunk => { child.__h1Output += String(chunk); });
    child.stderr.on('data', chunk => { child.__h1Error += String(chunk); });
    child.once('close', () => {
      try {
        const logDir = path.join(spawnOptions.env.DSH_HOME, 'logs');
        child.__h1DshLogs = fs.readdirSync(logDir).map(name => {
          return fs.readFileSync(path.join(logDir, name), 'utf8').slice(-12000);
        }).join('\n');
      } catch (_) { child.__h1DshLogs = ''; }
    });
    children.push(child);
    return child;
  };
  const host = createDshHostAdapter({
    enabled: true,
    actionRegistry: options.actionRegistry,
    workRunStore,
    appDraftStore,
    registry,
    credentialAccess,
    nodeModelPort,
    createProjectTool: () => options.projectToolFactory
      ? options.projectToolFactory(workspaceRoot) : createWorkspaceProjectTool(workspaceRoot),
    repoRoot: ROOT,
    protocolVersion: acpSdk.PROTOCOL_VERSION,
    tempRoot: root,
    timeoutMs: 30_000,
    spawn,
    onEvent(event) {
      if (typeof options.onEvent === 'function') options.onEvent(event, {
        workRunStore,
        registry,
        runId: created.run.runId,
        consentId: consent.consent.consentId
      });
    },
    dsh: {
      revision: DSH_REVISION,
      nodeExe: DSH_NODE,
      repoRoot: DSH_ROOT,
      tsxLoader: DSH_TSX,
      binScript: DSH_BIN,
      patches: [DSH_PATCH]
    }
  });

  t.after(async () => {
    try { await host.close(); } catch (_) {}
    try { registry.close(); } catch (_) {}
    try { workRunStore.close(); } catch (_) {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  });

  return {
    root,
    workspaceRoot,
    homeNodeDir,
    credentialDir,
    run: created.run,
    draft,
    appDraftStore,
    dshSessionId,
    consent: consent.consent,
    adapter: host,
    workRunStore,
    registry,
    credentialCalls,
    fakeProvider,
    childOptions,
    children,
    runInput(overrides) {
      return Object.assign({
        runId: created.run.runId,
        sessionId: dshSessionId,
        consentId: consent.consent.consentId,
        providerRef: PROVIDER_REF,
        prompt: 'Read the one consented project file and return the Work Result.',
        timeoutMs: 30_000
      }, overrides || {});
    },
    processText() {
      return children.map(child => [child.__h1Output, child.__h1Error, child.__h1DshLogs].filter(Boolean).join('\n')).join('\n');
    }
  };
}

function createWorkspaceProjectTool(workspaceRoot) {
  const fixedPath = path.join(workspaceRoot, 'src', 'project.txt');
  function readFixture(projectRef, fileId) {
    if (projectRef !== PROJECT_REF || fileId !== FILE_ID) return null;
    try {
      const root = fs.realpathSync(workspaceRoot);
      const target = fs.realpathSync(fixedPath);
      const relativePath = path.relative(root, target);
      if (relativePath !== path.join('src', 'project.txt') || relativePath === '..'
        || relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) return null;
      const metadata = fs.statSync(target);
      if (!metadata.isFile() || metadata.size > 4096) return null;
      const content = fs.readFileSync(target, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > 4096) return null;
      return {
        path: 'src/project.txt',
        content,
        size: Buffer.byteLength(content, 'utf8'),
        contentHash: crypto.createHash('sha256').update(content, 'utf8').digest('hex')
      };
    } catch (_) { return null; }
  }
  const workspace = {
    async wsGetWorkModeProjectSnapshot(projectRef) {
      const file = readFixture(projectRef, FILE_ID);
      if (!file) return { ok: false, error: 'workspace-unavailable' };
      return {
        ok: true,
        projectRef,
        files: [{ fileId: FILE_ID, path: file.path, size: file.size, contentHash: file.contentHash }]
      };
    },
    async wsReadWorkModeFile(projectRef, fileId) {
      const file = readFixture(projectRef, fileId);
      if (!file) return { ok: false, error: 'file-not-found' };
      return {
        ok: true,
        projectRef,
        fileId,
        path: file.path,
        content: file.content,
        contentHash: file.contentHash
      };
    }
  };
  return createReadOnlyProjectTool({ workspace, maxFiles: 1, maxFileBytes: 4096, maxTotalReadBytes: 4096 });
}

function createFakeProvider(mode) {
  let calls = 0;
  let aborts = 0;
  let observedAuthorization = '';
  const waiters = new Map();
  const notifyCall = index => {
    const pending = waiters.get(index) || [];
    waiters.delete(index);
    for (const resolve of pending) resolve();
  };
  function waitForCall(index) {
    if (calls >= index) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fake Provider call ${index} did not arrive`)), 15_000);
      const pending = waiters.get(index) || [];
      pending.push(() => { clearTimeout(timer); resolve(); });
      waiters.set(index, pending);
    });
  }
  async function fetch(input, init) {
    calls += 1;
    const index = calls;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, PROVIDER_ENDPOINT);
    observedAuthorization = init && init.headers && init.headers.Authorization || '';
    assert.equal(observedAuthorization, `Bearer ${FAKE_PROVIDER_SECRET}`);
    notifyCall(index);
    const signal = init && init.signal;
    const shouldHold = (mode === 'hold-first' || mode === 'timeout') && index === 1
      || mode === 'hold-second' && index === 2;
    if (shouldHold) {
      await new Promise((resolve, reject) => {
        if (!signal || signal.aborted) {
          aborts += 1;
          reject(Object.assign(new Error('fake provider aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => {
          aborts += 1;
          reject(Object.assign(new Error('fake provider aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
    const body = JSON.parse(String(init && init.body || '{}'));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (mode === 'app-builder') {
      const toolMessages = messages.filter(message => message && message.role === 'tool').map(message => String(message.content || ''));
      const hasExistingFiles = toolMessages.some(text => text.includes('"path":"index.html"'));
      const hasReadJavascript = toolMessages.some(text => text.includes('"path":"app.js"') && text.includes('AppStorage.get'));
      let content, finishReason = 'tool_calls';
      if (calls === 1) content = JSON.stringify({ action: 'call_tool', name: 'app_draft.list_files', arguments: {} });
      else if (calls === 2 && hasExistingFiles) content = JSON.stringify({ action: 'call_tool', name: 'app_draft.read_file', arguments: { path: 'app.js' } });
      else if (calls === 2) content = JSON.stringify({ action: 'call_tool', name: 'app_draft.create_file', arguments: {
        path: 'index.html', content: '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>待办清单</title></head><body><main class="app-shell"><header><span class="eyebrow">TODAY</span><h1>今日待办</h1><p>把重要的事，一件一件完成。</p></header><section class="composer"><input id="todo-input" aria-label="新待办" placeholder="准备完成什么？"><button id="add-todo">添加</button></section><section id="filters" class="filters" hidden><button data-filter="all">全部</button><button data-filter="important">重要</button><button data-filter="done">已完成</button></section><section class="list-head"><span id="todo-count">0 项待办</span><button id="clear-done">清除已完成</button></section><ul id="todo-list"></ul><footer>数据仅保存在此 APP 的本地空间</footer></main></body></html>'
      } });
      else if (calls === 3 && hasReadJavascript) content = JSON.stringify({ action: 'call_tool', name: 'app_draft.update_file', arguments: {
        path: 'app.js', content: 'let todos=[];let activeFilter="all";const input=document.getElementById("todo-input");const list=document.getElementById("todo-list");const filters=document.getElementById("filters");filters.hidden=false;async function save(){await AppStorage.set("todos",todos)}function render(){list.replaceChildren();const visible=todos.filter(item=>activeFilter==="important"?item.important:activeFilter==="done"?item.done:true);visible.forEach(item=>{const li=document.createElement("li");li.dataset.done=String(item.done);const check=document.createElement("input");check.type="checkbox";check.checked=item.done;check.addEventListener("change",async()=>{item.done=check.checked;await save();render()});const text=document.createElement("span");text.textContent=item.text;const star=document.createElement("button");star.textContent=item.important?"★":"☆";star.setAttribute("aria-label","切换重要程度");star.addEventListener("click",async()=>{item.important=!item.important;await save();render()});const remove=document.createElement("button");remove.textContent="删除";remove.addEventListener("click",async()=>{todos=todos.filter(entry=>entry.id!==item.id);await save();render()});li.append(check,text,star,remove);list.appendChild(li)});document.getElementById("todo-count").textContent=todos.filter(item=>!item.done).length+" 项未完成"}document.querySelectorAll("[data-filter]").forEach(button=>button.addEventListener("click",()=>{activeFilter=button.dataset.filter;render()}));document.getElementById("add-todo").addEventListener("click",async()=>{const text=input.value.trim();if(!text)return;todos.push({id:Date.now()+Math.random(),text:text,done:false,important:false});input.value="";await save();render()});document.getElementById("clear-done").addEventListener("click",async()=>{todos=todos.filter(item=>!item.done);await save();render()});(async()=>{const saved=await AppStorage.get("todos");if(saved.ok&&Array.isArray(saved.value))todos=saved.value;render()})();'
      } });
      else if (calls === 3) content = JSON.stringify({ action: 'call_tool', name: 'app_draft.create_file', arguments: {
        path: 'styles.css', content: ':root{font-family:Inter,"Segoe UI",sans-serif;color:#182c3a;background:#eef4f7}*{box-sizing:border-box}body{margin:0;padding:28px;min-height:100vh}.app-shell{max-width:620px;margin:0 auto;background:#ffffffdd;border:1px solid #d7e4eb;border-radius:24px;padding:30px;box-shadow:0 18px 48px #203f531a}.eyebrow{font-size:11px;letter-spacing:.22em;color:#6c97aa}h1{font-size:34px;margin:8px 0}header p{color:#66808e}.composer{display:flex;gap:10px;margin:28px 0 18px}.composer input{flex:1;min-width:0;padding:13px;border:1px solid #bfd1dc;border-radius:12px;font-size:15px}.composer button{border:0;border-radius:12px;background:#193d52;color:white;padding:0 20px}.list-head{display:flex;justify-content:space-between;color:#637e8d;font-size:13px}#clear-done,.filters button{border:0;background:transparent;color:#4e7d91;cursor:pointer}.filters{display:flex;gap:8px;margin:8px 0 18px}.filters[hidden]{display:none}.filters button{border:1px solid #d3e1e8;border-radius:999px;padding:7px 12px}ul{padding:0;list-style:none}li{display:flex;gap:12px;align-items:center;padding:13px 0;border-bottom:1px solid #e7eef2}li[data-done="true"] span{text-decoration:line-through;opacity:.55}li span{flex:1}li button{border:0;background:transparent;color:#728d9a;cursor:pointer}footer{margin-top:28px;color:#8aa0aa;font-size:12px;text-align:center}'
      } });
      else if (calls === 4 && hasReadJavascript && toolMessages.some(text => text.includes('priority'))) {
        finishReason = 'stop'; content = JSON.stringify({ schemaVersion: 1, summary: '已为待办清单增加重要程度标记和全部、重要、已完成筛选，并保留原有本地数据。' });
      } else if (calls === 4 && !hasReadJavascript) content = JSON.stringify({ action: 'call_tool', name: 'app_draft.create_file', arguments: {
        path: 'app.js', content: 'let todos=[];const input=document.getElementById("todo-input");const list=document.getElementById("todo-list");async function save(){await AppStorage.set("todos",todos)}function render(){list.replaceChildren();todos.forEach(item=>{const li=document.createElement("li");li.dataset.done=String(item.done);const check=document.createElement("input");check.type="checkbox";check.checked=item.done;check.addEventListener("change",async()=>{item.done=check.checked;await save();render()});const text=document.createElement("span");text.textContent=item.text;const remove=document.createElement("button");remove.textContent="删除";remove.addEventListener("click",async()=>{todos=todos.filter(entry=>entry.id!==item.id);await save();render()});li.append(check,text,remove);list.appendChild(li)});document.getElementById("todo-count").textContent=todos.filter(item=>!item.done).length+" 项未完成"}document.getElementById("add-todo").addEventListener("click",async()=>{const text=input.value.trim();if(!text)return;todos.push({id:Date.now()+Math.random(),text:text,done:false});input.value="";await save();render()});document.getElementById("clear-done").addEventListener("click",async()=>{todos=todos.filter(item=>!item.done);await save();render()});(async()=>{const saved=await AppStorage.get("todos");if(saved.ok&&Array.isArray(saved.value))todos=saved.value;render()})();'
      } });
      else { finishReason = 'stop'; content = JSON.stringify({ schemaVersion: 1, summary: '已生成包含基本交互与本地数据保存的 Todo App。' }); }
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 20, completion_tokens: 12 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const toolResponse = index === 1 || (mode === 'repeat-tool' && index === 2);
    const content = toolResponse
      ? JSON.stringify({ action: 'call_tool', name: 'project.read_file', arguments: { fileId: FILE_ID } })
      : JSON.stringify({
          schemaVersion: 1,
          summary: `Read the consented project file ${CONTENT_SENTINEL}.`,
          findings: [{
            fileId: FILE_ID,
            path: 'src/project.txt',
            line: 1,
            severity: 'info',
            title: 'Fixture content observed',
            detail: messages.some(message => JSON.stringify(message).includes(CONTENT_SENTINEL))
              ? CONTENT_SENTINEL
              : 'authorized tool result was not present'
          }]
        });
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: toolResponse ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 12 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return {
    fetch,
    waitForCall,
    get calls() { return calls; },
    get aborts() { return aborts; },
    get observedAuthorization() { return observedAuthorization; }
  };
}
