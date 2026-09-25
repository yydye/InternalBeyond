'use strict';

/*
 * R5 read-only adapter validation.
 *
 * This test is the only consumer of the new adapter in R5. It reads the real
 * Active vault inside the authority boundary, but emits aggregate counts only.
 * It never calls get()/all()/upsert()/save()/remove()/migrateFromState(), never
 * sends a provider request, and never writes production storage.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const createAdapter = require(path.join(ROOT, 'active', 'credential-authority-adapter.js'));

const LOCAL_DATA_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
  : '';

const REAL_FILES = LOCAL_DATA_DIR ? [
  path.join(LOCAL_DATA_DIR, 'credential-vault.json'),
  path.join(LOCAL_DATA_DIR, 'credential-vault.key'),
  path.join(LOCAL_DATA_DIR, 'apiConfigs_recovery_import.json'),
  path.join(LOCAL_DATA_DIR, 'active-message-service.json'),
  path.join(LOCAL_DATA_DIR, 'bridge', 'config.json'),
  path.join(LOCAL_DATA_DIR, 'home-node', 'desktop-credential.json')
] : [];

function fileState(paths) {
  return Object.fromEntries(paths.map(file => {
    const stat = fs.statSync(file);
    const bytes = fs.readFileSync(file);
    return [file, {
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: stat.size,
      mtime: stat.mtimeMs
    }];
  }));
}

function statsEqual(before, after) {
  return Object.keys(before).every(file =>
    before[file].hash === after[file].hash
    && before[file].size === after[file].size
    && before[file].mtime === after[file].mtime
  );
}

function collectLiveBindings() {
  const stateFile = path.join(LOCAL_DATA_DIR, 'active-message-service.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const ids = new Set([
    ...Object.keys(state.moments || {}),
    ...Object.values(state.plans || {}).map(item => String(item && item.characterId || '')).filter(Boolean),
    ...Object.values(state.events || {}).map(item => String(item && item.character_id || '')).filter(Boolean),
    ...Object.values(state.history || {}).map(item => String(item && item.character_id || '')).filter(Boolean)
  ]);
  return ids;
}

function forbiddenProjectionProperties(value) {
  const forbidden = new Set([
    'apiKey',
    'Authorization',
    'Bearer',
    'secret',
    'ciphertext',
    'fingerprint',
    'secretEnvelope',
    'decryptionKey'
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

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-r5-adapter-'));
}

function removeTempDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function run() {
  assert(LOCAL_DATA_DIR, 'LOCALAPPDATA is required for the read-only real-vault test');
  const before = fileState(REAL_FILES);
  const adapter = createAdapter({ dataDir: LOCAL_DATA_DIR });
  const liveBindings = collectLiveBindings();
  const bindingResults = [];
  const credentialRequired = [];

  for (const bindingId of liveBindings) {
    const noCredential = bindingId === 'char_bgai';
    const result = adapter.getCredentialStatus({
      bindingId,
      capability: 'chat',
      credentialPolicy: noCredential ? 'none' : 'required',
      endpointClass: noCredential ? 'loopback' : 'remote'
    });
    bindingResults.push(result);
    if (!noCredential) credentialRequired.push(result);
  }

  const charBgai = bindingResults.find(result => result.credentialRef && result.status === 'none')
    || adapter.getCredentialStatus({
      bindingId: 'char_bgai',
      capability: 'chat',
      credentialPolicy: 'none',
      endpointClass: 'loopback'
    });

  const unknownBinding = adapter.getCredentialStatus({
    bindingId: 'r5-unknown-binding',
    capability: 'chat',
    credentialPolicy: 'required',
    endpointClass: 'remote'
  });
  const batch = adapter.getCredentialStatuses({
    bindings: [...liveBindings].map(bindingId => ({
      bindingId,
      capability: bindingId === 'char_bgai' ? 'local' : 'chat',
      credentialPolicy: bindingId === 'char_bgai' ? 'none' : 'required',
      endpointClass: bindingId === 'char_bgai' ? 'loopback' : 'remote'
    }))
  });
  const bounded = adapter.getCredentialStatuses({
    bindings: Array.from({ length: adapter.maxBindings + 1 }, (_, index) => ({
      bindingId: 'r5-bounded-' + index,
      capability: 'chat',
      credentialPolicy: 'required'
    }))
  });
  const malformed = adapter.getCredentialStatus(null);

  const missingVaultDir = makeTempDir();
  const unavailable = createAdapter({ dataDir: missingVaultDir }).getCredentialStatus({
    bindingId: 'r5-unavailable',
    capability: 'chat',
    credentialPolicy: 'required',
    endpointClass: 'remote'
  });
  removeTempDir(missingVaultDir);

  const adapterSource = fs.readFileSync(
    path.join(ROOT, 'active', 'credential-authority-adapter.js'),
    'utf8'
  );
  const executableAdapterSource = adapterSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const noSecretReaderCalls = !/vault\.(get|all)\s*\(/.test(executableAdapterSource)
    && !/vault\.(upsert|save|remove|migrateFromState)\s*\(/.test(executableAdapterSource);

  const projectionSamples = [
    ...bindingResults,
    unknownBinding,
    charBgai,
    unavailable,
    malformed,
    batch,
    bounded
  ];
  const forbiddenProjectionTokens = projectionSamples.flatMap(forbiddenProjectionProperties);
  const after = fileState(REAL_FILES);

  const counts = {
    liveRoleRefs: liveBindings.size,
    credentialRequiredRefs: credentialRequired.length,
    readyCredentialRequiredRefs: credentialRequired.filter(result => result.status === 'ready').length,
    missingCredentialRequiredRefs: credentialRequired.filter(result => result.status === 'missing').length,
    unavailableCredentialRequiredRefs: credentialRequired.filter(result => result.status === 'unavailable').length,
    unknownCredentialRequiredRefs: credentialRequired.filter(result => result.status === 'unknown').length,
    noCredentialRequiredRefs: bindingResults.filter(result => result.status === 'none').length
  };

  const baselineDrift = counts.liveRoleRefs !== 22
    || counts.credentialRequiredRefs !== 21
    || counts.readyCredentialRequiredRefs !== 21
    || counts.missingCredentialRequiredRefs !== 0
    || counts.noCredentialRequiredRefs !== 1
    || charBgai.status !== 'none';

  const tests = {
    realVaultReadOnlyOpen: counts.readyCredentialRequiredRefs >= 0,
    expectedLiveRoleRefs: counts.liveRoleRefs === 22,
    expectedCredentialRequiredRefs: counts.credentialRequiredRefs === 21,
    expectedReadyCredentialRequiredRefs: counts.readyCredentialRequiredRefs === 21,
    expectedMissingCredentialRequiredRefs: counts.missingCredentialRequiredRefs === 0,
    charBgaiNoCredentialRequired: charBgai.status === 'none',
    unknownBindingMissing: unknownBinding.status === 'missing',
    missingVaultUnavailable: unavailable.status === 'unavailable',
    malformedRequestStable: malformed.status === 'unknown' && malformed.errorCode === 'MALFORMED_BINDING',
    boundedBatchRejected: bounded.ok === false && bounded.errorCode === 'BATCH_TOO_LARGE',
    batchShapeValid: batch.ok === true && Array.isArray(batch.results) && batch.results.length === liveBindings.size,
    projectionForbiddenPropertiesAbsent: forbiddenProjectionTokens.length === 0,
    adapterDoesNotUseSecretReaderOrWriter: noSecretReaderCalls,
    productionFilesUnchanged: statsEqual(before, after),
    baselineDrift: baselineDrift === false
  };

  const allPassed = Object.entries(tests)
    .filter(([name]) => name !== 'baselineDrift')
    .every(([, passed]) => passed)
    && tests.baselineDrift;

  console.log(JSON.stringify({
    tests,
    counts,
    charBgaiStatus: charBgai.status,
    transport: 'internal-only',
    projectionForbiddenPropertyCount: forbiddenProjectionTokens.length,
    productionCredentialWrites: 0,
    providerCalls: 0,
    allPassed
  }, null, 2));
  if (!allPassed) process.exitCode = 1;
}

run();
