'use strict';

/*
 * Desktop Local Credential Authority · R5 read-only compatibility adapter.
 *
 * This module is intentionally not wired into the Active HTTP server or the
 * frontend in R5. It is a narrow authority-side projection:
 *   bindingId -> vault.has(bindingId) -> secret-free status
 *
 * Safety invariant:
 * - Never calls vault.get(), vault.all(), vault.upsert(), vault.save(),
 *   vault.remove(), or vault.migrateFromState().
 * - Refuses to call vault.load() when the key/vault prerequisites are absent
 *   or the key material is malformed, because the v1 loader can create a key
 *   through ensureKey().
 * - Never returns provider, endpoint, model, secret, fingerprint, or cipher
 *   material. The v1 vault has no capability metadata contract.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createCredentialVault = require('./credential-vault');

const MAX_BINDINGS = 200;
const AUTHORITY_SCOPE = 'desktop-local';
const SOURCE_CLASS = 'credential-vault-v1';

function opaqueCompatibilityRef(bindingId) {
  const digest = crypto.createHash('sha256')
    .update(AUTHORITY_SCOPE + '\0' + String(bindingId), 'utf8')
    .digest('hex')
    .slice(0, 12);
  return 'cred-live-' + digest;
}

function statusProjection(bindingId, status, extra) {
  return Object.assign({
    credentialRef: bindingId ? opaqueCompatibilityRef(bindingId) : null,
    authorityScope: AUTHORITY_SCOPE,
    status,
    secretPresent: status === 'ready',
    sourceClass: status === 'none' ? 'local-policy' : SOURCE_CLASS
  }, extra || {});
}

function createDesktopCredentialAuthorityAdapter(options) {
  const dataDir = String(options && options.dataDir || '').trim();
  const keyFile = dataDir ? path.join(dataDir, 'credential-vault.key') : '';
  const dataFile = dataDir ? path.join(dataDir, 'credential-vault.json') : '';
  let state = 'uninitialized';
  let vault = null;

  function safeFileState() {
    if (!dataDir || !keyFile || !dataFile) return { ok: false, errorCode: 'AUTHORITY_UNAVAILABLE' };
    let keyText;
    let envelopeText;
    try {
      if (!fs.existsSync(keyFile) || !fs.existsSync(dataFile)) {
        return { ok: false, errorCode: 'VAULT_MATERIAL_UNAVAILABLE' };
      }
      const keyStat = fs.statSync(keyFile);
      const dataStat = fs.statSync(dataFile);
      if (!keyStat.isFile() || !dataStat.isFile()) {
        return { ok: false, errorCode: 'VAULT_MATERIAL_UNAVAILABLE' };
      }
      keyText = String(fs.readFileSync(keyFile, 'utf8')).trim();
      const keyBytes = Buffer.from(keyText, 'base64');
      if (keyBytes.length !== 32) {
        return { ok: false, errorCode: 'VAULT_KEY_INVALID' };
      }
      envelopeText = String(fs.readFileSync(dataFile, 'utf8'));
      const envelope = JSON.parse(envelopeText);
      if (!envelope || envelope.v !== 1 || !envelope.iv || !envelope.tag || !envelope.data) {
        return { ok: false, errorCode: 'VAULT_ENVELOPE_INVALID' };
      }
      return { ok: true, encryptedBytes: envelopeText.length };
    } catch (_) {
      return { ok: false, errorCode: 'VAULT_UNAVAILABLE' };
    }
  }

  function ensureLoaded() {
    if (state === 'ready' || state === 'unknown' || state === 'unavailable') return state;
    const material = safeFileState();
    if (!material.ok) {
      state = 'unavailable';
      return state;
    }
    try {
      /*
       * safeFileState() proves the key exists and is structurally valid before
       * this call, so credential-vault.ensureKey() cannot take its write path.
       */
      vault = createCredentialVault({ dataDir });
      vault.load();
      /*
       * v1 load() intentionally swallows authentication/decryption errors.
       * An empty result for a non-empty encrypted envelope is therefore not
       * safe to call missing; preserve it as UNKNOWN.
       */
      state = vault.count() > 0 ? 'ready' : 'unknown';
      return state;
    } catch (_) {
      vault = null;
      state = 'unavailable';
      return state;
    }
  }

  function getCredentialStatus(input) {
    const request = input && typeof input === 'object' ? input : {};
    const bindingId = String(request.bindingId || '').trim();
    const policy = String(request.credentialPolicy || 'required').trim().toLowerCase();
    const endpointClass = String(request.endpointClass || '').trim().toLowerCase();

    if (!bindingId && policy !== 'none' && endpointClass !== 'loopback' && endpointClass !== 'local') {
      return statusProjection('', 'unknown', { errorCode: 'MALFORMED_BINDING' });
    }
    if (policy === 'none' || endpointClass === 'loopback' || endpointClass === 'local') {
      return statusProjection(bindingId, 'none', { secretPresent: false });
    }

    const loaded = ensureLoaded();
    if (loaded === 'unavailable') {
      return statusProjection(bindingId, 'unavailable', { errorCode: 'AUTHORITY_UNAVAILABLE' });
    }
    if (loaded === 'unknown' || !vault) {
      return statusProjection(bindingId, 'unknown', { errorCode: 'AUTHORITY_STATE_UNKNOWN' });
    }

    /*
     * has() only reads the already loaded in-memory vault. It returns a
     * boolean, performs no migration, and has no persistence side effect.
     */
    const present = vault.has(bindingId);
    return statusProjection(bindingId, present ? 'ready' : 'missing', {
      secretPresent: present
    });
  }

  function getCredentialStatuses(input) {
    const request = input && typeof input === 'object' ? input : {};
    if (!Array.isArray(request.bindings)) {
      return { ok: false, errorCode: 'MALFORMED_BINDINGS', results: [] };
    }
    if (request.bindings.length > MAX_BINDINGS) {
      return { ok: false, errorCode: 'BATCH_TOO_LARGE', results: [] };
    }
    return {
      ok: true,
      results: request.bindings.map(binding => getCredentialStatus(binding))
    };
  }

  return {
    authorityScope: AUTHORITY_SCOPE,
    maxBindings: MAX_BINDINGS,
    getCredentialStatus,
    getCredentialStatuses
  };
}

module.exports = createDesktopCredentialAuthorityAdapter;
