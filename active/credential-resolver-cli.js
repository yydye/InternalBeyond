'use strict';

/* Bounded Tauri child-process bridge for one request-scoped Vault lookup. */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const createCredentialResolver = require('./credential-resolver');

const MAX_REQUEST_BYTES = 2048;
const MAX_SECRET_BYTES = 8192;
const activeDataDir = process.env.IB_ACTIVE_DATA_DIR || (process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond')
  : '');
const dataDir = process.env.IB_CREDENTIAL_DATA_DIR || activeDataDir;

/* P34.1 · Non-Active system bindings explicitly allowed to use the Vault.
   This adds a fixed constant id only; role bindings remain governed solely by
   the Active metadata set below, so existing role behavior is unchanged. */
const SYSTEM_BINDING_IDS = ['middle_brain'];

function fail() {
  process.stdout.write(JSON.stringify({ ok: false, errorCode: 'CREDENTIAL_UNAVAILABLE' }));
}

function validBindingId(value) {
  const id = String(value == null ? '' : value);
  return id.length > 0 && id.length <= 180 && /^[A-Za-z0-9_.:-]+$/.test(id);
}

function knownActiveBindings() {
  if (!activeDataDir) return new Set(SYSTEM_BINDING_IDS);
  try {
    const state = JSON.parse(fs.readFileSync(path.join(activeDataDir, 'active-message-service.json'), 'utf8'));
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

function readOneRequest() {
  return new Promise(resolve => {
    let bytes = 0;
    let overflow = false;
    const chunks = [];
    const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    input.on('line', line => {
      const size = Buffer.byteLength(line, 'utf8') + 1;
      bytes += size;
      if (bytes > MAX_REQUEST_BYTES) overflow = true;
      else chunks.push(line);
    });
    input.on('close', () => resolve(overflow ? null : chunks.join('\n')));
  });
}

async function main() {
  try {
    const raw = await readOneRequest();
    if (raw == null) return fail();
    const request = JSON.parse(raw || '{}');
    if (!request || typeof request !== 'object' || Array.isArray(request)
      || Object.keys(request).length !== 1 || !validBindingId(request.bindingId)) return fail();

    const bindingId = String(request.bindingId);
    if (!knownActiveBindings().has(bindingId)) return fail();

    const resolver = createCredentialResolver({ dataDir });
    const credential = resolver.resolve(bindingId);
    if (!credential || Buffer.byteLength(credential.apiKey, 'utf8') > MAX_SECRET_BYTES) return fail();

    /* stdout is piped only to the Tauri host command; never log this response. */
    process.stdout.write(JSON.stringify({ ok: true, provider: credential.provider, apiKey: credential.apiKey }));
  } catch (_) {
    fail();
  }
}

main().catch(fail);
