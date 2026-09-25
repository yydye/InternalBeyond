'use strict';

/*
 * Request-scoped resolver over the existing Credential Vault.
 *
 * This is a read-only bridge, not a second credential store. The caller must
 * hold the returned apiKey only for one provider request and must not cache or
 * persist it. File preflight is required because credential-vault.load() can
 * create a new key when its key file is missing or malformed.
 */

const fs = require('fs');
const path = require('path');
const createCredentialVault = require('./credential-vault');

function validBindingId(value) {
  const id = String(value == null ? '' : value);
  return id.length > 0 && id.length <= 180 && /^[A-Za-z0-9_.:-]+$/.test(id);
}

function vaultMaterialIsReadOnlyUsable(dataDir) {
  if (!dataDir) return false;
  const keyFile = path.join(dataDir, 'credential-vault.key');
  const dataFile = path.join(dataDir, 'credential-vault.json');
  try {
    const keyStat = fs.statSync(keyFile);
    const dataStat = fs.statSync(dataFile);
    if (!keyStat.isFile() || !dataStat.isFile()) return false;

    const keyText = String(fs.readFileSync(keyFile, 'utf8')).trim();
    const keyBytes = Buffer.from(keyText, 'base64');
    const keyValid = keyBytes.length === 32 && keyBytes.toString('base64') === keyText;
    keyBytes.fill(0);
    if (!keyValid) return false;

    const envelope = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!envelope || envelope.v !== 1) return false;
    const iv = Buffer.from(String(envelope.iv || ''), 'base64');
    const tag = Buffer.from(String(envelope.tag || ''), 'base64');
    const data = Buffer.from(String(envelope.data || ''), 'base64');
    const valid = iv.length === 12 && tag.length === 16 && data.length > 0;
    iv.fill(0);
    tag.fill(0);
    data.fill(0);
    return valid;
  } catch (_) {
    return false;
  }
}

function createCredentialResolver(options) {
  const dataDir = String(options && options.dataDir || '').trim();

  function resolve(bindingId) {
    const id = String(bindingId == null ? '' : bindingId).trim();
    if (!validBindingId(id) || !vaultMaterialIsReadOnlyUsable(dataDir)) return null;

    try {
      /* Preflight guarantees ensureKey() takes its existing-key read path. */
      const vault = createCredentialVault({ dataDir });
      vault.load();
      const credential = vault.get(id);
      if (!credential || typeof credential.apiKey !== 'string' || !credential.apiKey.trim()) return null;
      const provider = String(credential.provider || '').trim().toLowerCase();
      if (!/^[A-Za-z0-9._-]{1,48}$/.test(provider)) return null;
      return { provider, apiKey: credential.apiKey };
    } catch (_) {
      return null;
    }
  }

  return Object.freeze({ resolve });
}

module.exports = createCredentialResolver;
