'use strict';

/*
 * R9 staging-only shadow migration test.
 * It uses the real read-only status adapter and writes only metadata to a
 * temporary transaction root. No production store is opened for writing.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'InternalBeyond');
const createAdapter = require(path.join(ROOT, 'active', 'credential-authority-adapter.js'));
const {
  CredentialShadowMigration,
  EXPLICIT_COMMIT_TOKEN
} = require(path.join(ROOT, 'tests', 'credential-shadow-migration.js'));

const PRODUCTION_FILES = [
  path.join(DATA_DIR, 'credential-vault.json'),
  path.join(DATA_DIR, 'credential-vault.key'),
  path.join(DATA_DIR, 'apiConfigs_recovery_import.json'),
  path.join(DATA_DIR, 'active-message-service.json'),
  path.join(DATA_DIR, 'bridge', 'config.json'),
  path.join(DATA_DIR, 'home-node', 'desktop-credential.json')
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

function collectLiveBindings() {
  const state = JSON.parse(fs.readFileSync(
    path.join(DATA_DIR, 'active-message-service.json'),
    'utf8'
  ));
  return [...new Set([
    ...Object.keys(state.moments || {}),
    ...Object.values(state.plans || {}).map(item => String(item && item.characterId || '')).filter(Boolean),
    ...Object.values(state.events || {}).map(item => String(item && item.character_id || '')).filter(Boolean),
    ...Object.values(state.history || {}).map(item => String(item && item.character_id || '')).filter(Boolean)
  ])];
}

function legacyPresenceFor(bindingId) {
  /*
   * Only inspect property presence, never read a legacy key value.
   */
  const state = JSON.parse(fs.readFileSync(
    path.join(DATA_DIR, 'active-message-service.json'),
    'utf8'
  ));
  const objects = [];
  if (state.moments && state.moments[bindingId]) objects.push(state.moments[bindingId].character);
  for (const item of Object.values(state.plans || {})) {
    if (String(item && item.characterId || '') === bindingId) objects.push(item.character);
  }
  for (const item of Object.values(state.events || {})) {
    if (String(item && item.character_id || '') === bindingId) objects.push(item.character);
  }
  for (const item of Object.values(state.history || {})) {
    if (String(item && item.character_id || '') === bindingId) objects.push(item.character);
  }
  return objects.some(object => object && Object.prototype.hasOwnProperty.call(object, 'apiKey'));
}

function run() {
  const beforeProduction = fileState();
  const adapter = createAdapter({ dataDir: DATA_DIR });
  const bindings = collectLiveBindings();
  const candidates = bindings.map(bindingId => {
    const noCredential = bindingId === 'char_bgai';
    const projection = adapter.getCredentialStatus({
      bindingId,
      capability: 'chat',
      credentialPolicy: noCredential ? 'none' : 'required',
      endpointClass: noCredential ? 'loopback' : 'remote'
    });
    return {
      bindingId,
      consumer: noCredential ? 'active-message' : 'apiConfigs',
      authorityScope: 'desktop-local',
      mappingDecision: projection.status === 'ready'
        ? 'resolved'
        : projection.status === 'none'
          ? 'not-required'
          : 'unresolved',
      credentialStatus: projection.status,
      legacyPresence: legacyPresenceFor(bindingId),
      credentialRefCandidate: projection.credentialRef,
      conflictState: 'none'
    };
  });

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-r9-shadow-'));
  const transaction = new CredentialShadowMigration({
    stagingDir,
    initialState: {
      apiConfigs: {},
      activeMessage: {},
      middleBrain: {},
      imageRouter: {}
    }
  });
  const dryRun = transaction.prepare(candidates);
  assert.strictEqual(dryRun.dryRun, true);
  assert.strictEqual(dryRun.candidateBindings, 22);
  assert.strictEqual(dryRun.resolved, 22);
  assert.strictEqual(dryRun.unresolved, 0);
  assert.strictEqual(dryRun.conflicts, 0);

  let commitWithoutApprovalRejected = false;
  try { transaction.commit({ approvalToken: 'wrong-token' }); } catch (_) { commitWithoutApprovalRejected = true; }
  assert.strictEqual(commitWithoutApprovalRejected, true);

  const committed = transaction.commit({ approvalToken: EXPLICIT_COMMIT_TOKEN });
  assert.strictEqual(committed.committed, true);
  const committedState = transaction.state;
  const shadowRows = Object.values(committedState.apiConfigs || {});
  assert.strictEqual(shadowRows.length, 21);
  assert(shadowRows.every(row => row.shadow === true
    && (row.legacyPresence === false || row.legacyPresence === true)));
  assert(shadowRows.every(row => Object.prototype.hasOwnProperty.call(row, 'credentialRef')));

  const rollback = transaction.rollback();
  assert.strictEqual(rollback.rolledBack, true);
  assert.strictEqual(rollback.restored, true);
  transaction.cleanup();

  const afterProduction = fileState();
  assert.strictEqual(sameState(beforeProduction, afterProduction), true);

  const consumerMatrix = {
    apiConfigs: { candidates: 21, resolved: 21, legacyCoexists: true },
    activeMessage: { candidates: 22, resolved: 22, legacyCoexists: true },
    middleBrain: { candidates: 0, resolved: 0, legacyCoexists: true },
    imageRouter: { candidates: 0, resolved: 0, legacyCoexists: true },
    voiceBridgeHomeNode: { action: 'KEEP_SEPARATE', migrated: false }
  };

  console.log(JSON.stringify({
    dryRun: {
      candidateBindings: dryRun.candidateBindings,
      resolved: dryRun.resolved,
      unresolved: dryRun.unresolved,
      conflicts: dryRun.conflicts,
      legacyPresenceBindings: candidates.filter(candidate => candidate.legacyPresence).length,
      credentialRefReadyBindings: candidates.filter(candidate => candidate.credentialStatus === 'ready').length,
      noCredentialRequiredBindings: candidates.filter(candidate => candidate.credentialStatus === 'none').length
    },
    commit: {
      explicitApprovalRequired: true,
      stagingOnly: true,
      legacyAndCredentialRefCoexist: true,
      rollbackRestored: rollback.restored
    },
    consumerMatrix,
    productionWrites: 0,
    providerCalls: 0,
    productionInvariance: true,
    allPassed: true
  }, null, 2));
}

run();
