'use strict';

/*
 * Tauri Host bridge for the R6 Desktop Local Credential Authority.
 *
 * stdin: bounded { bindings: [{ bindingId, credentialPolicy, endpointClass, capability }] }
 * stdout: bounded secret-free projection only
 *
 * This process owns no second credential authority. It calls the R5 adapter
 * and restricts requests to Active metadata plus refs registered by the
 * /credentials writer. Unknown IDs never reach Vault status lookup.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const createAdapter = require('./credential-authority-adapter.js');
const devServiceContract = require('../runtime/dev-service-contract.js');

const MAX_BINDINGS = 200;
const DEV_IDENTITY = devServiceContract.identityFromEnvironment(process.env);
devServiceContract.portsFromEnvironment(process.env);
const activeDataDir = process.env.IB_ACTIVE_DATA_DIR || (process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
  : '');
const bindingDataDir = DEV_IDENTITY.mode === 'dev' || DEV_IDENTITY.mode === 'synthetic'
  ? path.join(DEV_IDENTITY.sandboxRoot, 'active')
  : (process.env.IB_CREDENTIAL_BINDINGS_DIR || activeDataDir);
const dataDir = DEV_IDENTITY.mode === 'dev' || DEV_IDENTITY.mode === 'synthetic'
  ? path.join(DEV_IDENTITY.sandboxRoot, 'credential-vault')
  : (process.env.IB_CREDENTIAL_DATA_DIR || activeDataDir);

/* P34.1 · Non-Active system bindings explicitly allowed to use the Vault.
   Adds a fixed constant id only; role binding status stays governed solely by
   the Active metadata set below. */
const SYSTEM_BINDING_IDS = ['middle_brain'];

function fixedError(errorCode) {
  return { ok: false, errorCode, results: [] };
}

function validBindingId(value) {
  const id = String(value == null ? '' : value);
  return id.length > 0 && id.length <= 180 && /^[A-Za-z0-9_.:-]+$/.test(id);
}

function knownActiveBindings() {
  if (!bindingDataDir) return new Set(SYSTEM_BINDING_IDS);
  try {
    const file = path.join(bindingDataDir, 'active-message-service.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set([
      ...SYSTEM_BINDING_IDS,
      ...Object.keys(state.moments || {}),
      ...Object.values(state.plans || {}).map(item => String(item && item.characterId || '')).filter(Boolean),
      ...Object.values(state.events || {}).map(item => String(item && item.character_id || '')).filter(Boolean),
      ...Object.values(state.history || {}).map(item => String(item && item.character_id || '')).filter(Boolean),
      ...(Array.isArray(state.credentialBindings) ? state.credentialBindings.filter(validBindingId) : [])
    ]);
  } catch (_) {
    return new Set(SYSTEM_BINDING_IDS);
  }
}

function projectionForUnknown(binding) {
  const id = String(binding && binding.bindingId || '');
  return {
    credentialRef: null,
    authorityScope: 'desktop-local',
    status: 'unknown',
    secretPresent: false,
    sourceClass: 'binding-not-current',
    errorCode: 'BINDING_NOT_CURRENT',
    bindingId: id
  };
}

function readRequest() {
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', line => {
      bytes += Buffer.byteLength(line, 'utf8') + 1;
      if (bytes <= 128 * 1024) chunks.push(line);
    });
    input.on('close', () => resolve(chunks.join('\n')));
  });
}

async function main() {
  let request;
  try {
    const raw = await readRequest();
    request = JSON.parse(raw || '{}');
  } catch (_) {
    process.stdout.write(JSON.stringify(fixedError('CREDENTIAL_STATUS_REQUEST_INVALID')));
    return;
  }
  if (!request || !Array.isArray(request.bindings)) {
    process.stdout.write(JSON.stringify(fixedError('CREDENTIAL_STATUS_REQUEST_INVALID')));
    return;
  }
  if (request.bindings.length > MAX_BINDINGS) {
    process.stdout.write(JSON.stringify(fixedError('BATCH_TOO_LARGE')));
    return;
  }
  if (!request.bindings.every(binding => binding && validBindingId(binding.bindingId))) {
    process.stdout.write(JSON.stringify(fixedError('BINDING_ID_INVALID')));
    return;
  }

  const known = knownActiveBindings();
  const adapter = createAdapter({ dataDir });
  const results = request.bindings.map(binding => {
    if (!known.has(String(binding.bindingId))) return projectionForUnknown(binding);
    const status = adapter.getCredentialStatus({
      bindingId: String(binding.bindingId),
      capability: String(binding.capability || ''),
      credentialPolicy: String(binding.credentialPolicy || 'required'),
      endpointClass: String(binding.endpointClass || 'remote')
    });
    return Object.assign({ bindingId: String(binding.bindingId) }, status);
  });
  process.stdout.write(JSON.stringify({ ok: true, results }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify(fixedError('CREDENTIAL_STATUS_UNAVAILABLE')));
  process.exitCode = 0;
});
