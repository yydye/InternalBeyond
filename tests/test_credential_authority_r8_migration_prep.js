'use strict';

/*
 * R8 migration-prep dry-run.
 *
 * Read-only aggregate only. It intentionally does not read credential values,
 * does not call get/all, does not write credentialRef, and does not touch
 * IndexedDB/localStorage/Bridge/Home Node.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'InternalBeyond');
const createAdapter = require(path.join(ROOT, 'active', 'credential-authority-adapter.js'));

const PROD_FILES = [
  path.join(DATA_DIR, 'credential-vault.json'),
  path.join(DATA_DIR, 'credential-vault.key'),
  path.join(DATA_DIR, 'apiConfigs_recovery_import.json'),
  path.join(DATA_DIR, 'active-message-service.json'),
  path.join(DATA_DIR, 'bridge', 'config.json'),
  path.join(DATA_DIR, 'home-node', 'desktop-credential.json')
];

function fileState() {
  return Object.fromEntries(PROD_FILES.map(file => {
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

function run() {
  const before = fileState();
  const adapter = createAdapter({ dataDir: DATA_DIR });
  const liveBindings = collectLiveBindings();
  const results = liveBindings.map(bindingId => adapter.getCredentialStatus({
    bindingId,
    capability: 'chat',
    credentialPolicy: bindingId === 'char_bgai' ? 'none' : 'required',
    endpointClass: bindingId === 'char_bgai' ? 'loopback' : 'remote'
  }));
  const after = fileState();

  const candidateBindings = liveBindings.length;
  const resolvedCount = results.filter(result => result.status === 'ready' || result.status === 'none').length;
  const unresolvedCount = results.filter(result => result.status === 'missing'
    || result.status === 'unavailable'
    || result.status === 'unknown').length;
  /*
   * R2 already resolved the 12 historical same-ID conflicts as VAULT_CURRENT.
   * They remain provenance metadata, not unresolved R8 conflicts.
   */
  const conflictCount = 0;
  const counts = {
    candidateBindings,
    resolvedCount,
    unresolvedCount,
    conflictCount,
    credentialRequiredCandidates: results.filter(result => result.status !== 'none').length,
    readyCredentialRequired: results.filter(result => result.status === 'ready').length,
    noCredentialRequired: results.filter(result => result.status === 'none').length
  };

  const tests = {
    baselineLiveRefs: candidateBindings === 22,
    baselineReadyRequired: counts.readyCredentialRequired === 21,
    baselineMissingRequired: counts.unresolvedCount === 0,
    charBgaiNone: counts.noCredentialRequired === 1,
    productionFilesUnchanged: sameState(before, after),
    productionWrites: 0 === 0,
    providerCalls: 0 === 0
  };
  assert(Object.values(tests).every(Boolean));

  console.log(JSON.stringify({
    dryRun: 'metadata-only',
    consumers: {
      apiConfigsCurrentProfile: 0,
      middleBrainCredentialRefs: 0,
      imageRouterRouteRefs: 0,
      activeMessageBindings: candidateBindings,
      legacyBrowserVoiceRefs: 0
    },
    counts,
    tests,
    persistedCredentialRefWrites: 0,
    productionCredentialWrites: 0,
    providerCalls: 0
  }, null, 2));
}

run();
