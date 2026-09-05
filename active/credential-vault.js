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
  const KEY_FILE = path.join(dataDir, 'credential-vault.key');
  const DATA_FILE = path.join(dataDir, 'credential-vault.json');
  const TMP_FILE = DATA_FILE + '.tmp';
  let key = null;
  let vault = {}; /* characterId -> { provider, apiKey, endpoint, model, updatedAt } */

  function ensureKey() {
    if (key) return key;
    try {
      if (fs.existsSync(KEY_FILE)) {
        const b = Buffer.from(String(fs.readFileSync(KEY_FILE, 'utf8')).trim(), 'base64');
        if (b.length === 32) { key = b; return key; }
      }
    } catch (_) { /* fall through to generate */ }
    key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key.toString('base64'), { flag: 'w' });
    return key;
  }

  function encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ensureKey(), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') });
  }

  function decrypt(blob) {
    try {
      const p = JSON.parse(blob);
      if (!p || p.v !== 1) return null;
      const iv = Buffer.from(p.iv, 'base64');
      const tag = Buffer.from(p.tag, 'base64');
      const data = Buffer.from(p.data, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', ensureKey(), iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(dec.toString('utf8'));
    } catch (_) { return null; }
  }

  function load() {
    try {
      if (!fs.existsSync(DATA_FILE)) { vault = {}; return; }
      const parsed = decrypt(fs.readFileSync(DATA_FILE, 'utf8'));
      vault = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (_) { vault = {}; }
  }

  function save() {
    try {
      fs.writeFileSync(TMP_FILE, encrypt(vault));
      fs.renameSync(TMP_FILE, DATA_FILE);
    } catch (_) { /* best effort; keep last good vault */ }
  }

  function upsert(characterId, credential) {
    const id = String(characterId || '');
    if (!id) return false;
    const cur = vault[id] || {};
    const incomingKey = String(credential && credential.apiKey || '');
    /* 已有有效凭证不被空值清空 */
    const apiKey = incomingKey || cur.apiKey || '';
    if (!apiKey) return false;
    vault[id] = {
      provider: String(credential && credential.provider || cur.provider || ''),
      apiKey: apiKey,
      endpoint: String(credential && credential.endpoint || cur.endpoint || ''),
      model: String(credential && credential.model || cur.model || ''),
      updatedAt: Date.now()
    };
    save();
    return true;
  }

  function get(characterId) {
    const c = vault[String(characterId || '')];
    if (!c) return null;
    return { provider: c.provider, apiKey: c.apiKey, endpoint: c.endpoint, model: c.model };
  }

  function has(characterId) {
    const c = vault[String(characterId || '')];
    return !!(c && String(c.apiKey || '').trim());
  }

  function remove(characterId) {
    const id = String(characterId || '');
    if (vault[id]) { delete vault[id]; save(); return true; }
    return false;
  }

  function all() { return vault; }
  function count() { return Object.keys(vault).length; }

  /* ── 迁移：从旧业务 snapshot 的 character.apiKey 提取到 vault（幂等）──
     · 旧 snapshot 的 apiKey 保留不动（recovery source）；仅复制进 vault。
     · 已存在有效 vault 凭证时跳过（不覆盖更新、旧的）。
     · 单角色失败不影响其它角色。 */
  function migrateFromState(getState) {
    const state = getState ? getState() : null;
    if (!state) return { migrated: 0, skipped: 0 };
    let migrated = 0, skipped = 0;
    const visit = (character) => {
      if (!character) return;
      const id = String(character.id || '');
      const keyNow = String(character.apiKey || '');
      if (!id || !keyNow.trim()) return;
      if (has(id)) { skipped += 1; return; }
      try {
        upsert(id, { provider: character.provider || '', apiKey: keyNow, endpoint: character.endpoint || '', model: character.model || '' });
        migrated += 1;
      } catch (_) { /* keep going; single-failure isolation */ }
    };
    Object.values(state.moments || {}).forEach(function (m) { if (m && m.character) visit(m.character); });
    Object.values(state.plans || {}).forEach(function (p) { if (p && p.character) visit(p.character); });
    Object.values(state.tasks || {}).forEach(function (t) { if (t && t.character) visit(t.character); });
    return { migrated: migrated, skipped: skipped };
  }

  return {
    load, save, upsert, get, has, remove, all, count, migrateFromState
  };
}

module.exports = createCredentialVault;
