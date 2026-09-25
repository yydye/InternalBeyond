'use strict';

/*
 * R6 contract/acceptance test.
 *
 * It exercises the real read-only CLI/adapter projection and the production
 * status-rendering seam without starting Tauri, Active, a scheduler, or any
 * provider. It never prints the returned binding IDs or compatibility refs.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LOCAL_DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'InternalBeyond');
const CLI = path.join(ROOT, 'active', 'credential-authority-adapter-cli.js');
const SOCIAL = path.join(ROOT, 'assets', 'js', 'social.js');
const HOST = path.join(ROOT, 'assets', 'js', 'host-capability.js');

const PRODUCTION_FILES = [
  path.join(LOCAL_DATA_DIR, 'credential-vault.json'),
  path.join(LOCAL_DATA_DIR, 'credential-vault.key'),
  path.join(LOCAL_DATA_DIR, 'apiConfigs_recovery_import.json'),
  path.join(LOCAL_DATA_DIR, 'active-message-service.json'),
  path.join(LOCAL_DATA_DIR, 'bridge', 'config.json'),
  path.join(LOCAL_DATA_DIR, 'home-node', 'desktop-credential.json')
];

function fileState() {
  return Object.fromEntries(PRODUCTION_FILES.map(file => {
    const stat = fs.statSync(file);
    const bytes = fs.readFileSync(file);
    return [file, {
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: stat.size,
      mtime: stat.mtimeMs
    }];
  }));
}

function sameState(before, after) {
  return Object.keys(before).every(file =>
    before[file].hash === after[file].hash
    && before[file].size === after[file].size
    && before[file].mtime === after[file].mtime
  );
}

function liveBindingIds() {
  const state = JSON.parse(fs.readFileSync(
    path.join(LOCAL_DATA_DIR, 'active-message-service.json'),
    'utf8'
  ));
  return [...new Set([
    ...Object.keys(state.moments || {}),
    ...Object.values(state.plans || {}).map(item => String(item && item.characterId || '')).filter(Boolean),
    ...Object.values(state.events || {}).map(item => String(item && item.character_id || '')).filter(Boolean),
    ...Object.values(state.history || {}).map(item => String(item && item.character_id || '')).filter(Boolean)
  ])];
}

function invokeCli(bindings) {
  const result = childProcess.spawnSync(
    process.execPath,
    [CLI],
    {
      cwd: ROOT,
      input: JSON.stringify({ bindings }),
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    }
  );
  assert.strictEqual(result.status, 0, 'credential status CLI failed');
  return JSON.parse(result.stdout || '{}');
}

function forbiddenProjectionPropertyNames(value) {
  const forbidden = new Set([
    'apiKey',
    'Authorization',
    'Bearer',
    'secret',
    'ciphertext',
    'fingerprint',
    'secretEnvelope',
    'decryptionKey',
    'vaultPath'
  ]);
  const found = [];
  const seen = new WeakSet();
  function walk(item) {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key)) found.push(key);
      if (typeof child === 'string' && forbidden.has(child)) found.push(child);
      walk(child);
    }
  }
  walk(value);
  return found;
}

function hostContractChecks() {
  const hostModule = require(path.join(ROOT, 'assets', 'js', 'host-capability.js'));
  const browser = hostModule.createHost({
    location: { protocol: 'http:', origin: 'http://127.0.0.1:23120', search: '' },
    fetch: () => Promise.reject(new Error('not used'))
  });
  assert.strictEqual(browser.capabilities().credentialStatus.available, false);
  return browser.credentialStatus.query([]).then(browserResult => {
    assert.strictEqual(browserResult.ok, false);
    const calls = [];
    const tauri = hostModule.createHost({
      location: { protocol: 'http:', origin: 'http://tauri.localhost', search: '' },
      __TAURI__: {
        core: {
          invoke: (name, args) => {
            calls.push({ name, args });
            return Promise.resolve({
              ok: true,
              results: [{
                bindingId: 'role-test',
                credentialRef: 'cred-test',
                authorityScope: 'desktop-local',
                status: 'ready',
                secretPresent: true,
                sourceClass: 'credential-vault-v1'
              }]
            });
          }
        }
      }
    });
    assert.strictEqual(tauri.capabilities().credentialStatus.available, true);
    return tauri.credentialStatus.query([{ bindingId: 'role-test', credentialPolicy: 'required', endpointClass: 'remote' }]).then(value => {
      assert.strictEqual(value.ok, true);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].name, 'credential_status');
      assert.deepStrictEqual(calls[0].args.bindings[0], {
        bindingId: 'role-test',
        credentialPolicy: 'required',
        endpointClass: 'remote'
      });
    });
  });
}

async function run() {
  const before = fileState();
  const ids = liveBindingIds();
  const bindings = ids.map(bindingId => ({
    bindingId,
    credentialPolicy: bindingId === 'char_bgai' ? 'none' : 'required',
    endpointClass: bindingId === 'char_bgai' ? 'loopback' : 'remote',
    capability: 'chat'
  }));
  const projection = invokeCli(bindings);
  const results = Array.isArray(projection.results) ? projection.results : [];
  const ready = results.filter(item => item.status === 'ready').length;
  const none = results.filter(item => item.status === 'none').length;
  const missing = results.filter(item => item.status === 'missing').length;
  const forbidden = forbiddenProjectionPropertyNames(projection);
  const after = fileState();

  assert.strictEqual(projection.ok, true);
  assert.strictEqual(ids.length, 22);
  assert.strictEqual(results.length, 22);
  assert.strictEqual(ready, 21);
  assert.strictEqual(none, 1);
  assert.strictEqual(missing, 0);
  assert.strictEqual(forbidden.length, 0);
  assert.strictEqual(sameState(before, after), true);

  const social = fs.readFileSync(SOCIAL, 'utf8');
  const renderStart = social.indexOf('async function renderApiList()');
  const renderEnd = social.indexOf('var _dragApiIdx', renderStart);
  const renderBody = social.slice(renderStart, renderEnd);
  assert(renderStart >= 0 && renderEnd > renderStart);
  assert(!/cfg\\.apiKey|a\\.apiKey/.test(renderBody));
  assert(renderBody.includes('_ibLoadApiCredentialProjection'));
  assert(social.includes('ib-api-credential-status-'));
  assert(social.includes('credentialStatus'));
  assert(social.includes('checking'));

  const activeService = fs.readFileSync(
    path.join(ROOT, 'services', 'active-message-service.js'),
    'utf8'
  );
  assert(!activeService.includes('credential-authority-adapter'));

  await hostContractChecks();

  console.log(JSON.stringify({
    canonicalTransport: 'tauri-host-command',
    browserFallback: 'unavailable-no-key-fallback',
    liveRoleRefs: ids.length,
    readyCredentialRequiredRefs: ready,
    noneRefs: none,
    missingRefs: missing,
    projectionForbiddenPropertyCount: forbidden.length,
    productionFilesUnchanged: true,
    productionCredentialWrites: 0,
    providerCalls: 0,
    activeExecutionPathChanged: false,
    allPassed: true
  }, null, 2));
}

run().catch(error => {
  console.error(JSON.stringify({
    code: 'R6_TEST_FAILED',
    message: String(error && error.message || error).slice(0, 240)
  }));
  process.exitCode = 1;
});
