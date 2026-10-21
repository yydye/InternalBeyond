'use strict';
/* Internal Beyond · Companion Credential Vault v1
   ------------------------------------------------------------------
   目标：把 API 凭证与「角色业务状态」分离。
   · 凭证单独加密落盘（AES-256-GCM，key 在本机 DATA_DIR）。
   · 业务 snapshot（moments/plans/tasks）不再持久化明文 apiKey。
   · vault 是运行时（浏览器关闭后的生成链路）的 authoritative 凭证来源。
   · character.apiKey 仅作为旧数据 migration / 兼容 fallback。
   ------------------------------------------------------------------
   Threat model：单用户本地应用。加密用于「业务备份/导出/巡视范围不再含明文 Key」，
   抵御被动的磁盘/备份刷读；本机同权限代码仍可解密（key 与 vault 同目录），
   不承诺对抗已取得本机文件读写权限的攻击者。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createCredentialVault(deps) {
  const dataDir = deps && deps.dataDir || process.cwd();
  const fileSystem = deps && deps.fs || fs;
  const KEY_FILE = path.join(dataDir, 'credential-vault.key');
  const DATA_FILE = path.join(dataDir, 'credential-vault.json');
  const TMP_FILE = DATA_FILE + '.tmp';
  let key = null;
  let vault = {}; /* characterId -> { provider, apiKey, endpoint, model, updatedAt } */
  let vaultError = null;

  function failVault(code) {
    vaultError = vaultError || code;
    if (String(vaultError).indexOf('CREDENTIAL_VAULT_KEY_') === 0) {
      if (key) key.fill(0);
      key = null;
      vault = {};
    }
    const error = new Error(vaultError);
    error.code = vaultError;
    return error;
  }

  function readExistingKey() {
    let raw;
    try { raw = String(fileSystem.readFileSync(KEY_FILE, 'utf8')).trim(); }
    catch (_) { throw failVault('CREDENTIAL_VAULT_KEY_UNREADABLE'); }
    const candidate = Buffer.from(raw, 'base64');
    if (candidate.length !== 32 || candidate.toString('base64') !== raw) {
      candidate.fill(0);
      throw failVault('CREDENTIAL_VAULT_KEY_INVALID');
    }
    if (key) key.fill(0);
    key = candidate;
    return key;
  }

  function ensureKey() {
    if (vaultError) throw failVault(vaultError);
    if (key) {
      let keyExists = false;
      try { keyExists = fileSystem.existsSync(KEY_FILE); }
      catch (_) { throw failVault('CREDENTIAL_VAULT_KEY_UNREADABLE'); }
      if (!keyExists) throw failVault('CREDENTIAL_VAULT_KEY_MISSING');
      let raw;
      try { raw = String(fileSystem.readFileSync(KEY_FILE, 'utf8')).trim(); }
      catch (_) { throw failVault('CREDENTIAL_VAULT_KEY_UNREADABLE'); }
      const onDisk = Buffer.from(raw, 'base64');
      const matches = onDisk.length === 32 && onDisk.toString('base64') === raw && onDisk.equals(key);
      onDisk.fill(0);
      if (!matches) throw failVault('CREDENTIAL_VAULT_KEY_INVALID');
      return key;
    }
    let keyExists = false, dataExists = false;
    try {
      keyExists = fileSystem.existsSync(KEY_FILE);
      dataExists = fileSystem.existsSync(DATA_FILE);
    } catch (_) { throw failVault('CREDENTIAL_VAULT_IO_UNAVAILABLE'); }
    if (keyExists) return readExistingKey();
    if (dataExists) throw failVault('CREDENTIAL_VAULT_KEY_MISSING');

    const candidate = crypto.randomBytes(32);
    try {
      /* Exclusive creation prevents a stale/corrupt key from ever being
         replaced by this process or by a concurrent first writer. */
      fileSystem.writeFileSync(KEY_FILE, candidate.toString('base64'), { flag: 'wx', mode: 0o600 });
      key = candidate;
      return key;
    } catch (error) {
      candidate.fill(0);
      if (error && error.code === 'EEXIST') return readExistingKey();
      throw failVault('CREDENTIAL_VAULT_KEY_WRITE_FAILED');
    }
  }

  function encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ensureKey(), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') });
  }

  function decrypt(blob) {
    let p;
    try {
      p = JSON.parse(blob);
    } catch (_) {
      throw failVault('CREDENTIAL_VAULT_DATA_INVALID');
    }
    if (!p || p.v !== 1 || typeof p.iv !== 'string' || typeof p.tag !== 'string' || typeof p.data !== 'string') {
      throw failVault('CREDENTIAL_VAULT_DATA_INVALID');
    }
    const iv = Buffer.from(p.iv, 'base64');
    const tag = Buffer.from(p.tag, 'base64');
    const data = Buffer.from(p.data, 'base64');
    if (iv.length !== 12 || tag.length !== 16 || !data.length
      || iv.toString('base64') !== p.iv || tag.toString('base64') !== p.tag || data.toString('base64') !== p.data) {
      iv.fill(0); tag.fill(0); data.fill(0);
      throw failVault('CREDENTIAL_VAULT_DATA_INVALID');
    }
    let clear;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', ensureKey(), iv);
      decipher.setAuthTag(tag);
      clear = Buffer.concat([decipher.update(data), decipher.final()]);
      const parsed = JSON.parse(clear.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-vault-payload');
      return parsed;
    } catch (error) {
      if (vaultError) throw error;
      throw failVault('CREDENTIAL_VAULT_DATA_INVALID');
    } finally {
      iv.fill(0); tag.fill(0); data.fill(0);
      if (clear) clear.fill(0);
    }
  }

  function load() {
    vault = {};
    vaultError = null;
    if (key) { key.fill(0); key = null; }
    try {
      const keyExists = fileSystem.existsSync(KEY_FILE);
      const dataExists = fileSystem.existsSync(DATA_FILE);
      if (keyExists) ensureKey(); /* validate even when the data file is absent */
      if (!dataExists) return status();
      vault = decrypt(fileSystem.readFileSync(DATA_FILE, 'utf8'));
      return status();
    } catch (error) {
      vault = {};
      if (!vaultError) vaultError = (error && error.code) || 'CREDENTIAL_VAULT_LOAD_FAILED';
      return status();
    }
  }

  function save() {
    if (vaultError) return false;
    try {
      fileSystem.writeFileSync(TMP_FILE, encrypt(vault));
      fileSystem.renameSync(TMP_FILE, DATA_FILE);
      return true;
    } catch (_) {
      if (!vaultError) vaultError = 'CREDENTIAL_VAULT_WRITE_FAILED';
      try { if (fileSystem.existsSync(TMP_FILE)) fileSystem.unlinkSync(TMP_FILE); } catch (_) {}
      return false;
    }
  }

  function status() {
    return { ok: !vaultError, errorCode: vaultError || null };
  }

  function upsert(characterId, credential) {
    if (vaultError) return false;
    const id = String(characterId || '');
    if (!id) return false;
    const previous = vault[id];
    const cur = previous || {};
    const incomingKey = String(credential && credential.apiKey || '');
    /* 已有有效凭证不被空值清空 */
    const apiKey = incomingKey || cur.apiKey || '';
    if (!apiKey) return false;
    vault[id] = {
      displayName: String(credential && (credential.displayName || credential.name) || cur.displayName || '').trim().slice(0, 80),
      userManaged: credential && typeof credential.userManaged === 'boolean' ? credential.userManaged : cur.userManaged === true,
      provider: String(credential && credential.provider || cur.provider || ''),
      apiKey: apiKey,
      endpoint: String(credential && credential.endpoint || cur.endpoint || ''),
      model: String(credential && credential.model || cur.model || ''),
      updatedAt: Date.now()
    };
    if (save()) return true;
    if (previous) vault[id] = previous;
    else delete vault[id];
    return false;
  }

  function get(characterId) {
    if (vaultError) return null;
    const c = vault[String(characterId || '')];
    if (!c) return null;
    return { provider: c.provider, apiKey: c.apiKey, endpoint: c.endpoint, model: c.model };
  }

  function has(characterId) {
    if (vaultError) return false;
    const c = vault[String(characterId || '')];
    return !!(c && String(c.apiKey || '').trim());
  }

  function remove(characterId) {
    if (vaultError) return false;
    const id = String(characterId || '');
    if (vault[id]) {
      const previous = vault[id];
      delete vault[id];
      if (save()) return true;
      vault[id] = previous;
      return false;
    }
    return false;
  }

  function all() { return vaultError ? {} : vault; }
  function bindingIds() { return vaultError ? [] : Object.keys(vault); }
  function listMetadata() {
    if (vaultError) return [];
    return Object.keys(vault).map(function (id) {
      const entry = vault[id] || {};
      let endpointHost = '', endpoint = '';
      try {
        const parsed = new URL(String(entry.endpoint || ''));
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password
          && !/(?:[?&])(?:api[_-]?key|key|token|secret|authorization|bearer|password|credential|signature|sig)=/i.test(String(entry.endpoint || ''))
          && !/(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/i.test(String(entry.endpoint || ''))) {
          endpointHost = parsed.host;
          parsed.search = '';
          parsed.hash = '';
          endpoint = parsed.toString().slice(0, 1000);
        }
      } catch (_) {}
      return {
        credentialRef: id,
        displayName: String(entry.displayName || '').slice(0, 80),
        userManaged: entry.userManaged === true,
        provider: String(entry.provider || '').slice(0, 48),
        endpointHost: String(endpointHost || '').slice(0, 180),
        endpoint: endpoint,
        model: String(entry.model || '').slice(0, 120),
        updatedAt: Number(entry.updatedAt) || 0,
        secretPresent: !!String(entry.apiKey || '').trim()
      };
    }).sort(function (a, b) {
      return (a.displayName || a.credentialRef).localeCompare(b.displayName || b.credentialRef);
    });
  }
  function count() { return vaultError ? 0 : Object.keys(vault).length; }

  /* ── 迁移：从旧业务 snapshot 的 character.apiKey 提取到 vault（幂等）──
     · 旧 snapshot 的 apiKey 保留不动（recovery source）；仅复制进 vault。
     · 已存在有效 vault 凭证时跳过（不覆盖更新、旧的）。
     · 单角色失败不影响其它角色。 */
  function migrateFromState(getState) {
    const state = getState ? getState() : null;
    if (!state) return { migrated: 0, skipped: 0, failed: 0 };
    let migrated = 0, skipped = 0, failed = 0;
    const visit = (character) => {
      if (!character) return;
      const id = String(character.id || '');
      const keyNow = String(character.apiKey || '');
      if (!id || !keyNow.trim()) return;
      if (has(id)) { skipped += 1; return; }
      try {
        if (upsert(id, { provider: character.provider || '', apiKey: keyNow, endpoint: character.endpoint || '', model: character.model || '' })) migrated += 1;
        else failed += 1;
      } catch (_) { /* keep going; single-failure isolation */ }
    };
    Object.values(state.moments || {}).forEach(function (m) { if (m && m.character) visit(m.character); });
    Object.values(state.plans || {}).forEach(function (p) { if (p && p.character) visit(p.character); });
    Object.values(state.tasks || {}).forEach(function (t) { if (t && t.character) visit(t.character); });
    return { migrated: migrated, skipped: skipped, failed: failed };
  }

  return {
    load, save, status, upsert, get, has, remove, all, bindingIds, listMetadata, count, migrateFromState
  };
}

module.exports = createCredentialVault;
