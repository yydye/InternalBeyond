'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const launcher = require(path.join(ROOT, 'runtime', 'ib-dev-launcher.js'));
const synthetic = require(path.join(ROOT, 'runtime', 'dev-synthetic-seed.js'));
const createDeviceRegistry = require(path.join(ROOT, 'services', 'home-node', 'device-registry.js'));
const createCredentialResolver = require(path.join(ROOT, 'active', 'credential-resolver.js'));
const ASSOCIATION = require(path.join(ROOT, 'assets', 'js', 'memory-recall', 'memory-association-core.js'));
const { createRuntimeMemoryAssociation } = require(path.join(ROOT, 'services', 'home-node', 'runtime-memory-association.js'));

test('Synthetic Seed selects a separate sandbox and leaves default Dev paths unchanged', () => {
  const activeSource = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'active-diary.js'), 'utf8');
  assert(/ACTIVE_COMPANION_URL\s*=\s*window\.__IB_DEV_MODE__\s*===\s*true[\s\S]*?ACTIVE_DEV_CONFIG&&ACTIVE_DEV_CONFIG\.activeUrl/.test(activeSource),
    'Dev Vault writes use the injected service contract and have no production fallback');
  const local = path.join(os.tmpdir(), 'ib-synthetic-seed-path-test');
  assert.deepEqual(launcher.resolveAppDataPaths(local, false), {
    appData: path.join(local, '.dev-data', 'development'),
    sandbox: path.join(local, '.dev-data', 'development', 'dev-sandbox'),
    credentialDataDir: path.join(local, '.dev-data', 'development', 'dev-sandbox', 'credential-vault')
  });
  assert.deepEqual(launcher.resolveAppDataPaths(local, true), {
    appData: path.join(local, '.dev-data', 'synthetic'),
    sandbox: path.join(local, '.dev-data', 'synthetic', 'dev-sandbox'),
    credentialDataDir: path.join(local, '.dev-data', 'synthetic', 'dev-sandbox', 'credential-vault')
  });
  assert.deepEqual(launcher.parseStartOptions(['--synthetic', '--dsh']), {
    dshEnabled: true, synthetic: true, manualExportPath: undefined
  });
  assert.deepEqual(launcher.parseStartOptions(['fixture.json', '--synthetic']), {
    dshEnabled: false, synthetic: true, manualExportPath: 'fixture.json'
  });
  assert.equal(launcher.TAURI_BUILD_TIMEOUT_MS, 15 * 60 * 1000);
  assert.equal(launcher.HOST_READINESS_TIMEOUT_MS, 60 * 1000);

  const isolatedBase = path.join(os.tmpdir(), 'ib-dev-launcher-test-synthetic-env');
  const modulePath = path.join(ROOT, 'runtime', 'ib-dev-launcher.js');
  const childSource = 'const launcher=require(' + JSON.stringify(modulePath) + ');'
    + 'const env=launcher.tauriEnvironment();'
    + 'process.stdout.write(JSON.stringify({sandbox:launcher.SANDBOX,credentialDataDir:env.IB_CREDENTIAL_DATA_DIR,'
    + 'cargoTarget:env.CARGO_TARGET_DIR,localAppData:env.LOCALAPPDATA,appData:env.APPDATA,temp:env.TEMP,'
    + 'webview:env.WEBVIEW2_USER_DATA_FOLDER,projectRoot:env.IB_DEV_PROJECT_ROOT,'
    + 'synthetic:env.IB_DEV_SYNTHETIC,debug:env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS}));';
  const isolated = JSON.parse(execFileSync(process.execPath, ['-e', childSource], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      LOCALAPPDATA: isolatedBase,
      IB_DEV_LAUNCHER_TEST_PROJECT_ROOT: isolatedBase,
      IB_DEV_SYNTHETIC: '1'
    })
  }));
  assert.deepEqual(isolated, {
    sandbox: path.join(isolatedBase, '.dev-data', 'synthetic', 'dev-sandbox'),
    credentialDataDir: path.join(isolatedBase, '.dev-data', 'synthetic', 'dev-sandbox', 'credential-vault'),
    cargoTarget: path.join(isolatedBase, '.dev-data', 'synthetic', 'dev-sandbox', 'cargo-target'),
    localAppData: path.join(isolatedBase, '.dev-data', 'synthetic', 'dev-sandbox', 'local-app-data'),
    appData: path.join(isolatedBase, '.dev-data', 'synthetic', 'dev-sandbox', 'roaming-app-data'),
    temp: path.join(isolatedBase, '.dev-data', 'synthetic', 'dev-sandbox', 'temp'),
    webview: path.join(isolatedBase, '.dev-data', 'synthetic', 'dev-sandbox', 'webview2'),
    projectRoot: isolatedBase,
    synthetic: '1', debug: '--remote-debugging-port=9225'
  });
});

test('Synthetic Seed imports only fake Providers and one virtual Workspace file', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsh-synthetic-seed-'));
  const sandboxRoot = path.join(parent, '.dev-data', 'synthetic', 'dev-sandbox');
  const credentialDataDir = path.join(sandboxRoot, 'credential-vault');
  const fakeProvider = await synthetic.createSyntheticFakeProvider({ port: 0 });
  t.after(async () => { await fakeProvider.close(); fs.rmSync(parent, { recursive: true, force: true }); });

  const seeded = synthetic.seedSyntheticSandbox({
    sandboxRoot, credentialDataDir, providerEndpoint: fakeProvider.endpoint, clock: () => 1000
  });
  let snapshot = JSON.parse(fs.readFileSync(seeded.seedFile, 'utf8'));
  assert.equal(snapshot.schema, 'internalbeyond.dev-snapshot');
  assert.deepEqual(snapshot.stores.apiConfigs.map(item => item.id), [
    synthetic.SYNTHETIC_AGENT_REF, synthetic.SYNTHETIC_AGENT_ALT_REF, synthetic.SYNTHETIC_MIDDLE_REF
  ]);
  assert.deepEqual(snapshot.stores.apiConfigs.filter(item => item.isRole === true).map(item => item.nickname),
    ['Synthetic Role Alpha', 'Synthetic Role Beta'], 'Synthetic role data is anonymized and contains more than one dynamic role');
  assert.equal(snapshot.stores.apiConfigs.find(item => item.id === synthetic.SYNTHETIC_MIDDLE_REF).roleSelectable, false,
    'service-only profiles do not appear in the character selector');
  const staleSeed = JSON.parse(JSON.stringify(snapshot));
  staleSeed.stores.apiConfigs = staleSeed.stores.apiConfigs.filter(item => item.id !== synthetic.SYNTHETIC_AGENT_ALT_REF);
  staleSeed.stores.apiConfigs[0].nickname = 'Legacy Synthetic Role';
  fs.writeFileSync(seeded.seedFile, JSON.stringify(staleSeed));
  synthetic.seedSyntheticSandbox({ sandboxRoot, credentialDataDir, providerEndpoint: fakeProvider.endpoint, clock: () => 2000 });
  snapshot = JSON.parse(fs.readFileSync(seeded.seedFile, 'utf8'));
  assert.deepEqual(snapshot.stores.apiConfigs.filter(item => item.isRole === true).map(item => item.nickname),
    ['Synthetic Role Alpha', 'Synthetic Role Beta'], 'an existing owned Synthetic seed refreshes its anonymous role catalog');
  assert.equal(snapshot.stores.apiConfigs.every(item => item.endpoint === fakeProvider.endpoint), true);
  const syntheticMiddleBrain = snapshot.stores.apiSettings.find(item => item.id === 'middle_brain');
  assert.equal(syntheticMiddleBrain.providerConfigId, synthetic.SYNTHETIC_MIDDLE_REF,
    'Middle Brain keeps the Fake Provider profile as its normalized route');
  assert.equal(syntheticMiddleBrain.credentialRef, 'middle_brain',
    'Middle Brain fake credentials use the existing allowlisted system Vault binding');
  assert.equal(JSON.stringify(snapshot).includes(synthetic.SYNTHETIC_FAKE_KEY), false);
  assert.equal(JSON.stringify(snapshot).includes('apiKey'), false);
  assert.equal(snapshot.stores.projects, undefined, 'the normal user-export store allowlist is unchanged');
  assert.equal(snapshot.syntheticWorkspace.schema, 'internalbeyond.dev-synthetic-workspace');
  assert.equal(snapshot.syntheticWorkspace.projects[0].id, synthetic.SYNTHETIC_PROJECT_REF);
  assert.deepEqual(snapshot.syntheticWorkspace.projectFiles.map(file => ({ id: file.id, projectId: file.projectId, path: file.path })), [{
    id: synthetic.SYNTHETIC_FILE_ID,
    projectId: synthetic.SYNTHETIC_PROJECT_REF,
    path: synthetic.SYNTHETIC_FILE_PATH
  }]);
  assert.equal(fs.readFileSync(path.join(credentialDataDir, 'credential-vault.json'), 'utf8')
    .includes(synthetic.SYNTHETIC_FAKE_KEY), false, 'fake credential is encrypted at rest');

  const registry = createDeviceRegistry({ dataDir: seeded.homeNodeDir, logger: () => {} });
  registry.open();
  try {
    for (const ref of seeded.profileRefs) {
      const route = registry.getCharacterSpec(ref);
      assert.equal(route.provider, 'openai');
      assert.equal(route.endpoint, fakeProvider.endpoint);
      assert.equal(route.credentialRef, ref === synthetic.SYNTHETIC_AGENT_ALT_REF ? synthetic.SYNTHETIC_AGENT_REF : ref);
      assert.equal(Object.prototype.hasOwnProperty.call(route, 'apiKey'), false);
    }
  } finally { registry.close(); }

  const resolved = createCredentialResolver({ dataDir: credentialDataDir }).resolve(synthetic.SYNTHETIC_AGENT_REF);
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.apiKey, synthetic.SYNTHETIC_FAKE_KEY);
  const middleBrainCredential = createCredentialResolver({ dataDir: credentialDataDir }).resolve('middle_brain');
  assert.equal(middleBrainCredential.provider, 'openai');
  assert.equal(middleBrainCredential.apiKey, synthetic.SYNTHETIC_FAKE_KEY,
    'the isolated Desktop Middle Brain can resolve only its Synthetic Fake Provider system binding');
  assert.equal(fs.existsSync(path.join(parent, 'InternalBeyond', 'home-node', 'home-node.db')), false,
    'Synthetic seeding does not create or read the formal Home Node database path');
});

test('Synthetic Fake Provider supports tool-result replies and an abortable hold for UI cancel', async t => {
  const provider = await synthetic.createSyntheticFakeProvider({ port: 0 });
  t.after(() => provider.close());

  const preflight = await fetch(provider.endpoint, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:23130',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:23130');
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/i,
    'Synthetic Work Cognition sends Vault credentials through browser Authorization headers');

  const request = body => fetch(provider.endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + synthetic.SYNTHETIC_FAKE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const first = await request({ model: 'fake', messages: [] });
  assert.equal(first.status, 200);
  const firstMessage = (await first.json()).choices[0].message.content;
  assert.deepEqual(JSON.parse(firstMessage), {
    action: 'call_tool', name: 'project.read_file', arguments: { fileId: synthetic.SYNTHETIC_FILE_ID }
  });
  const second = await request({ model: 'fake', messages: [{ role: 'tool', content: synthetic.SYNTHETIC_FILE_CONTENT }] });
  const secondMessage = JSON.parse((await second.json()).choices[0].message.content);
  assert.equal(secondMessage.findings[0].detail, synthetic.SYNTHETIC_FILE_CONTENT.trim());

  const reset = await fetch('http://127.0.0.1:' + provider.port + '/__control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true })
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { ok: true, calls: 0, holdNext: false, holdNextModel: '' }, 'each isolated Run can restart the deterministic Fake Provider sequence');
  const nextRunFirst = await request({ model: 'fake', messages: [] });
  assert.equal(JSON.parse((await nextRunFirst.json()).choices[0].message.content).action, 'call_tool');

  const resetAgain = await fetch('http://127.0.0.1:' + provider.port + '/__control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true })
  });
  assert.equal(resetAgain.status, 200);
  const associationRecords = [
    { id: 'synthetic-old-hospital', title: 'Old hospital location', content: 'The hospital was previously in Beijing.',
      created: Date.now() - 300 * 86400000, visibility: 'public', tags: [], domain: 'Synthetic' },
    { id: 'synthetic-hospital-correction', title: 'Hospital location correction', content: 'Correction: the hospital is in Shanghai.',
      created: Date.now() - 5 * 86400000, visibility: 'public', tags: [], domain: 'Synthetic' }
  ];
  const beforeAssociation = JSON.stringify(associationRecords);
  const associationRuntime = createRuntimeMemoryAssociation({
    modelPort: { run: async input => {
      const messages = [{ role: 'system', content: input.prompt.system }].concat(input.prompt.messages || []);
      const response = await fetch(input.spec.endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + input.spec.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: input.spec.model, messages: messages, temperature: 0, response_format: { type: 'json_object' } })
      });
      if (!response.ok) throw new Error('synthetic-provider-status-' + response.status);
      return response.json();
    } },
    registry: { getCharacterSpec: () => ({ provider: 'openai', model: 'ib-dsh-synthetic-agent',
      endpoint: provider.endpoint, credentialRef: 'synthetic-agent' }) },
    credentialAccess: { resolve: () => ({ ok: true, secret: synthetic.SYNTHETIC_FAKE_KEY }) }
  });
  const associationRun = await associationRuntime.expand({
    characterId: synthetic.SYNTHETIC_AGENT_REF,
    records: associationRecords,
    anchorIds: ['synthetic-old-hospital'],
    currentMessage: 'hospital location correction',
    budgetChars: 1200
  });
  assert.equal(associationRun.ok, true, JSON.stringify(associationRun));
  assert.equal(associationRun.result.schemaVersion, ASSOCIATION.SCHEMA_VERSION);
  assert.equal(associationRun.result.status, 'expanded');
  assert.ok(associationRun.result.expansionIds.includes('synthetic-hospital-correction'));
  assert.ok(associationRun.result.edges.some(edge => edge.relation === 'correction'));
  assert.equal(associationRun.providerCalls, 1);
  assert.equal(JSON.stringify(associationRecords), beforeAssociation, 'Association only derives a bounded view and does not mutate Memory records');
  assert.equal(provider.status().associationObserved, true);
  assert.equal(provider.status().associationCalls, 1);
  assert.ok(provider.status().associationPairCount >= 1);
  assert.equal(provider.status().associationSchemaVersion, 'memory-association-v1');

  const failingAssociationRuntime = createRuntimeMemoryAssociation({
    modelPort: { run: async input => {
      const response = await fetch(input.spec.endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + input.spec.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: input.spec.model, messages: [
          { role: 'system', content: input.prompt.system }, ...(input.prompt.messages || [])
        ], temperature: 0, response_format: { type: 'json_object' } })
      });
      if (!response.ok) throw new Error('synthetic-provider-status-' + response.status);
      return response.json();
    } },
    registry: { getCharacterSpec: () => ({ provider: 'openai', model: 'ib-dsh-synthetic-agent',
      endpoint: provider.endpoint, credentialRef: 'synthetic-agent' }) },
    credentialAccess: { resolve: () => ({ ok: true, secret: synthetic.SYNTHETIC_FAKE_KEY }) }
  });
  provider.setFailNext(true);
  const failedAssociationRun = await failingAssociationRuntime.expand({
    characterId: synthetic.SYNTHETIC_AGENT_REF,
    records: associationRecords.map(record => Object.assign({}, record, {
      id: record.id + '-failure', content: record.content + ' isolated failure check'
    })),
    anchorIds: ['synthetic-old-hospital-failure'],
    currentMessage: 'hospital location correction',
    budgetChars: 1200
  });
  assert.equal(failedAssociationRun.ok, false);
  assert.equal(failedAssociationRun.status, 'fallback-direct');
  assert.equal(failedAssociationRun.reason, 'provider-transport-error');
  assert.equal(failedAssociationRun.providerCalls, 1, 'provider failure is bounded to one call and falls back to direct Recall');

  const plan = await request({ model: 'ib-dsh-synthetic-middle', messages: [{ role: 'user', content: JSON.stringify({ task: 'Read-only project audit', files: [] }) }] });
  assert.deepEqual(JSON.parse((await plan.json()).choices[0].message.content), {
    steps: [{ fileId: synthetic.SYNTHETIC_FILE_ID, focus: 'implementation' }]
  });
  const review = await request({ model: 'ib-dsh-synthetic-middle', messages: [{ role: 'user', content: JSON.stringify({ report: 'synthetic report' }) }] });
  assert.deepEqual(JSON.parse((await review.json()).choices[0].message.content), { decision: 'approve', issueCodes: [] });
  await request({ model: 'fake', messages: [{ role: 'user', content: synthetic.SYNTHETIC_MEMORY_SENTINEL }] });
  assert.equal(provider.status().memoryObserved, true, 'the Synthetic Fake Provider can verify project Recall egress without logging plaintext');

  const resetAppBuilder = await fetch('http://127.0.0.1:' + provider.port + '/__control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true })
  });
  assert.equal(resetAppBuilder.status, 200);
  const appBuilderFirst = await request({ model: 'ib-dsh-synthetic-agent', messages: [
    { role: 'system', content: '【Agent 预设 · App Builder】IB_SYNTHETIC_PERSONA_ALPHA' },
    { role: 'user', content: '生成一个 Todo app' }
  ] });
  assert.deepEqual(JSON.parse((await appBuilderFirst.json()).choices[0].message.content), {
    action: 'call_tool', name: 'app_draft.list_files', arguments: {}
  });
  assert.equal(provider.status().appBuilderObserved, true);
  assert.equal(provider.status().appBuildRuns, 1);
  assert.deepEqual(provider.status().appDraftToolNames, ['app_draft.list_files']);

  provider.setHoldNext(true);
  const controller = new AbortController();
  const held = requestWithSignal(controller.signal);
  async function requestWithSignal(signal) {
    return fetch(provider.endpoint, {
      method: 'POST', signal,
      headers: { Authorization: 'Bearer ' + synthetic.SYNTHETIC_FAKE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'fake', messages: [] })
    });
  }
  const deadline = Date.now() + 3000;
  while (provider.status().waiting === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(provider.status().waiting, 1);
  controller.abort();
  await assert.rejects(held);
  const cancelDeadline = Date.now() + 3000;
  while (provider.status().cancelled === 0 && Date.now() < cancelDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(provider.status().cancelled, 1, 'a cancelled Home Node fetch closes the held fake request');
});

test('Tauri Dev imports synthetic Workspace rows only when the Synthetic flag is present', async () => {
  const endpoint = 'http://127.0.0.1:' + synthetic.SYNTHETIC_PROVIDER_PORT + '/v1/chat/completions';
  const payload = synthetic.syntheticSnapshot(endpoint, () => 2000);
  const syntheticImport = await importDevSeed(payload, true);
  assert.equal(syntheticImport.records.get('projects').has(synthetic.SYNTHETIC_PROJECT_REF), true);
  assert.equal(syntheticImport.records.get('projectFiles').has(synthetic.SYNTHETIC_FILE_ID), true);
  assert.deepEqual(syntheticImport.invoked, ['ib_dev_snapshot_load', 'ib_dev_snapshot_mark_imported']);

  const regularImport = await importDevSeed(payload, false);
  assert.equal(regularImport.records.has('projects'), false, 'ordinary snapshot import ignores syntheticWorkspace');
  assert.equal(regularImport.records.has('projectFiles'), false);

  const invalid = Object.assign({}, payload);
  delete invalid.syntheticWorkspace;
  await assert.rejects(importDevSeed(invalid, true), /dev-synthetic-workspace-invalid/);
});

async function importDevSeed(payload, syntheticMode) {
  const records = new Map();
  const invoked = [];
  const storeNames = ['apiConfigs', 'apiSettings', 'projects', 'projectFiles'];
  const db = {
    objectStoreNames: { contains: name => storeNames.includes(name) },
    transaction(names) {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      let pending = 0;
      function finishOne() {
        pending -= 1;
        if (pending === 0) setImmediate(() => { if (tx.oncomplete) tx.oncomplete(); });
      }
      tx.objectStore = name => {
        if (!records.has(name)) records.set(name, new Map());
        const store = records.get(name);
        return {
          keyPath: 'id',
          get(key) {
            const request = {};
            pending += 1;
            setImmediate(() => {
              request.result = store.get(key);
              if (request.onsuccess) request.onsuccess();
              finishOne();
            });
            return request;
          },
          add(value) {
            const request = {};
            pending += 1;
            setImmediate(() => {
              store.set(value.id, value);
              if (request.onsuccess) request.onsuccess();
              finishOne();
            });
            return request;
          }
        };
      };
      return tx;
    },
    close() {}
  };
  const window = {
    document: {},
    __IB_DEV_MODE__: true,
    __IB_DEV_SYNTHETIC__: syntheticMode,
    __TAURI__: { core: { invoke: async command => {
      invoked.push(command);
      return command === 'ib_dev_snapshot_load' ? payload : {};
    } } },
    IBWebCoreDbSchema: { open: async () => db }
  };
  const source = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'dev-runtime.js'), 'utf8');
  vm.runInNewContext(source, { window, Promise, Date, TextEncoder, setImmediate, console });
  await window.__IB_DEV_BOOTSTRAP_PROMISE__;
  return { records, invoked };
}
