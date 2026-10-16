'use strict';
/* Internal Beyond — Credential Vault v1 单元测试（零网络）
   运行：node test_credential_vault.js
   验证：CRUD / AES-256-GCM encrypt-decrypt（落盘无明文）/ migration 幂等 /
   已存在有效凭证不被旧 snapshot 覆盖 / 两个“大黑塔”按 characterId 独立。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const assert = require('assert');
const createCredentialVault = require(path.join(ROOT, 'active', 'credential-vault'));
const createCredentialResolver = require(path.join(ROOT, 'active', 'credential-resolver'));


let passed = 0, failures = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failures++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-credvault-'));

function keyFile() { return path.join(DATA_DIR, 'credential-vault.key'); }
function dataFile() { return path.join(DATA_DIR, 'credential-vault.json'); }

/* ── CRUD ── */
(() => {
  const v = createCredentialVault({ dataDir: DATA_DIR });
  v.load();
  check('has 初始为空', v.count() === 0 && v.has('friend_A') === false);
  check('upsert 成功', v.upsert('friend_A', { provider: 'deepseek', apiKey: 'sk-secret-AAAA', endpoint: 'https://e', model: 'm1' }) === true);
  check('get 返回正确凭证', v.get('friend_A') && v.get('friend_A').apiKey === 'sk-secret-AAAA' && v.get('friend_A').provider === 'deepseek' && v.get('friend_A').model === 'm1');
  check('has 命中', v.has('friend_A') === true);
  /* 空值不覆盖已有有效凭证 */
  check('空 apiKey 不覆盖', v.upsert('friend_A', { provider: 'deepseek', apiKey: '' }) === true && v.get('friend_A').apiKey === 'sk-secret-AAAA');
  /* 更新真实值成功 */
  v.upsert('friend_A', { provider: 'deepseek', apiKey: 'sk-secret-BBBB', model: 'm2' });
  check('更新生效', v.get('friend_A').apiKey === 'sk-secret-BBBB' && v.get('friend_A').model === 'm2');
  check('remove 成功', v.remove('friend_A') === true && v.has('friend_A') === false);
})();

/* ── AES-256-GCM：落盘无明文 ── */
(() => {
  const v = createCredentialVault({ dataDir: DATA_DIR });
  v.load();
  v.upsert('friend_B', { provider: 'qwen', apiKey: 'PLAINTEXT_SHOULD_NOT_APPEAR_XYZ', endpoint: 'https://d', model: 'qwen-plus' });
  const raw = fs.readFileSync(dataFile(), 'utf8');
  check('key 文件生成（32B base64）', fs.existsSync(keyFile()) && Buffer.from(fs.readFileSync(keyFile(), 'utf8').trim(), 'base64').length === 32);
  check('vault 文件不包含明文 Key', raw.indexOf('PLAINTEXT_SHOULD_NOT_APPEAR_XYZ') === -1);
  check('vault 文件为加密 blob（v1/iv/tag/data）', /"v":1/.test(raw) && /"iv":/.test(raw) && /"data":/.test(raw));
  check('解密可读回', v.get('friend_B') && v.get('friend_B').apiKey === 'PLAINTEXT_SHOULD_NOT_APPEAR_XYZ');
})();

/* ── migration + 幂等 + 不覆盖已有 + 双大黑塔独立 ── */
(() => {
  const v = createCredentialVault({ dataDir: DATA_DIR });
  v.load();
  v.upsert('friend_old_A', { provider: 'qwen', apiKey: 'vault-existing-KEY', model: 'qwen-plus' });
  const state = {
    moments: {
      friend_old_A: { character: { id: 'friend_old_A', provider: 'qwen', apiKey: 'STALE-KEY-FROM-SNAPSHOT', model: 'qwen-plus' } },/* 已有 vault → 跳过 */
      friend_old_B: { character: { id: 'friend_old_B', provider: 'deepseek', apiKey: 'sk-new-migrate', model: 'm' } }/* 无 vault → 迁移 */
    },
    plans: {
      plan_1: { character: { id: 'friend_old_B', provider: 'deepseek', apiKey: 'sk-same-again', model: 'm' } }/* 同 id 已迁移 → 跳过 */
    },
    tasks: {
      task_1: { character: { id: 'friend_1785260690497', provider: 'qwen', apiKey: 'sk-p7LH', model: 'qwen-plus', nickname: '大黑塔' } },
      task_2: { character: { id: 'friend_1788318367937', provider: 'qwen', apiKey: 'sk-jJag', model: 'qwen3.8-max', nickname: '大黑塔' } }
    }
  };
  const mig1 = v.migrateFromState(() => state);
  check('migration 迁移 3 个新凭证（friend_old_B / 两大黑塔）', mig1.migrated === 3, mig1);
  check('migration 跳过 2 个已存在（friend_old_A + plans 重复的 friend_old_B）', mig1.skipped === 2, mig1);
  check('已有有效凭证不被旧 snapshot 覆盖', v.get('friend_old_A').apiKey === 'vault-existing-KEY' && v.get('friend_old_A').apiKey !== 'STALE-KEY-FROM-SNAPSHOT');
  check('新迁移凭证可读', v.get('friend_old_B').apiKey === 'sk-new-migrate');
  /* 两大黑塔独立 */
  const d1 = v.get('friend_1785260690497'), d2 = v.get('friend_1788318367937');
  check('大黑塔1 独立（qwen-plus）', d1 && d1.model === 'qwen-plus' && d1.apiKey === 'sk-p7LH');
  check('大黑塔2 独立（qwen3.8-max）', d2 && d2.model === 'qwen3.8-max' && d2.apiKey === 'sk-jJag');
  check('两大黑塔未合并', d1.apiKey !== d2.apiKey);
  /* 幂等：再跑一次 → 0 迁移, 全跳过 */
  const mig2 = v.migrateFromState(() => state);
  check('migration 幂等（第二次 0 迁移）', mig2.migrated === 0, mig2);
  /* reset state to get migration counts: use a fresh vault sharing file */
  const v2 = createCredentialVault({ dataDir: DATA_DIR });
  v2.load();
  check('重复加载后凭证仍在（幂等持久化）', v2.count() === 5);
})();

/* A failed encrypted-file write must not be reported as a successful upsert. */
(() => {
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-credvault-write-fail-'));
  const failingFs = Object.assign({}, fs, {
    writeFileSync: function (file, ...args) {
      if (String(file).endsWith('.tmp')) throw new Error('synthetic-write-failure');
      return fs.writeFileSync(file, ...args);
    }
  });
  const v = createCredentialVault({ dataDir: failDir, fs: failingFs });
  v.load();
  check('Vault 写入失败时 upsert 返回失败', v.upsert('write_fail', { provider: 'openai', apiKey: 'SYNTHETIC_FAILURE_ONLY' }) === false);
  check('失败的 upsert 不留内存凭据', v.has('write_fail') === false && v.count() === 0);
  check('失败的 upsert 不生成 Vault 数据文件', fs.existsSync(path.join(failDir, 'credential-vault.json')) === false);
  try { fs.rmSync(failDir, { recursive: true, force: true }); } catch (_) {}
})();

/* A damaged existing key must never be replaced, and its ciphertext must stay byte-identical. */
(() => {
  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-credvault-corrupt-key-'));
  const keyPath = path.join(corruptDir, 'credential-vault.key');
  const dataPath = path.join(corruptDir, 'credential-vault.json');
  const initial = createCredentialVault({ dataDir: corruptDir });
  initial.load();
  initial.upsert('synthetic-corrupt-role', { provider: 'test', apiKey: 'SYNTHETIC_VAULT_VALUE' });
  fs.writeFileSync(keyPath, 'CORRUPTED_SYNTHETIC_KEY');
  const corruptKey = fs.readFileSync(keyPath);
  const originalCiphertext = fs.readFileSync(dataPath);

  const reopened = createCredentialVault({ dataDir: corruptDir });
  const loadStatus = reopened.load();
  check('损坏的既有 key 明确报错', loadStatus.ok === false && loadStatus.errorCode === 'CREDENTIAL_VAULT_KEY_INVALID', loadStatus);
  check('损坏 key 后 upsert 被拒绝', reopened.upsert('other-role', { provider: 'test', apiKey: 'SYNTHETIC_OTHER_VALUE' }) === false);
  check('损坏 key 后 remove 被拒绝', reopened.remove('synthetic-corrupt-role') === false);
  check('损坏 key 后不暴露已解密记录', reopened.count() === 0 && reopened.get('synthetic-corrupt-role') === null);
  check('request resolver 对损坏 key fail closed', createCredentialResolver({ dataDir: corruptDir }).resolve('synthetic-corrupt-role') === null);
  check('损坏 key 与原密文均保持原始字节', fs.readFileSync(keyPath).equals(corruptKey) && fs.readFileSync(dataPath).equals(originalCiphertext));
  try { fs.rmSync(corruptDir, { recursive: true, force: true }); } catch (_) {}
})();

/* A missing key beside existing ciphertext is also corruption, not a fresh Vault. */
(() => {
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-credvault-missing-key-'));
  const keyPath = path.join(missingDir, 'credential-vault.key');
  const dataPath = path.join(missingDir, 'credential-vault.json');
  const initial = createCredentialVault({ dataDir: missingDir });
  initial.load();
  initial.upsert('synthetic-missing-role', { provider: 'test', apiKey: 'SYNTHETIC_MISSING_KEY_VALUE' });
  fs.unlinkSync(keyPath);
  const originalCiphertext = fs.readFileSync(dataPath);

  const reopened = createCredentialVault({ dataDir: missingDir });
  const loadStatus = reopened.load();
  check('密文存在但 key 缺失时明确报错', loadStatus.ok === false && loadStatus.errorCode === 'CREDENTIAL_VAULT_KEY_MISSING', loadStatus);
  check('缺 key 时不会创建替代 key 或覆盖密文', reopened.upsert('other-role', { provider: 'test', apiKey: 'SYNTHETIC_OTHER_VALUE' }) === false
    && !fs.existsSync(keyPath) && fs.readFileSync(dataPath).equals(originalCiphertext));
  try { fs.rmSync(missingDir, { recursive: true, force: true }); } catch (_) {}
})();

/* Detect an on-disk key change after this instance loaded, before any new ciphertext is written. */
(() => {
  const changedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-credvault-runtime-key-change-'));
  const keyPath = path.join(changedDir, 'credential-vault.key');
  const dataPath = path.join(changedDir, 'credential-vault.json');
  const vault = createCredentialVault({ dataDir: changedDir });
  vault.load();
  vault.upsert('synthetic-runtime-role', { provider: 'test', apiKey: 'SYNTHETIC_RUNTIME_VALUE' });
  fs.writeFileSync(keyPath, 'CHANGED_SYNTHETIC_KEY');
  const changedKey = fs.readFileSync(keyPath);
  const originalCiphertext = fs.readFileSync(dataPath);
  check('运行期间 key 文件变更会锁定 Vault', vault.upsert('runtime-other', { provider: 'test', apiKey: 'SYNTHETIC_RUNTIME_OTHER' }) === false
    && vault.status().errorCode === 'CREDENTIAL_VAULT_KEY_INVALID');
  check('运行期间 key 变更不会覆盖 key 文件或密文', fs.readFileSync(keyPath).equals(changedKey)
    && fs.readFileSync(dataPath).equals(originalCiphertext));
  try { fs.rmSync(changedDir, { recursive: true, force: true }); } catch (_) {}
})();

/* An unreadable/authentication-failed ciphertext cannot be silently reset by a later write. */
(() => {
  const corruptDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-credvault-corrupt-data-'));
  const keyPath = path.join(corruptDataDir, 'credential-vault.key');
  const dataPath = path.join(corruptDataDir, 'credential-vault.json');
  const initial = createCredentialVault({ dataDir: corruptDataDir });
  initial.load();
  initial.upsert('synthetic-data-role', { provider: 'test', apiKey: 'SYNTHETIC_DATA_VALUE' });
  const originalKey = fs.readFileSync(keyPath);
  fs.writeFileSync(dataPath, '{"v":1,"iv":"bad","tag":"bad","data":"bad"}');
  const corruptCiphertext = fs.readFileSync(dataPath);

  const reopened = createCredentialVault({ dataDir: corruptDataDir });
  const loadStatus = reopened.load();
  check('损坏密文明确进入只读故障态', loadStatus.ok === false && loadStatus.errorCode === 'CREDENTIAL_VAULT_DATA_INVALID', loadStatus);
  check('request resolver 对损坏密文 fail closed', createCredentialResolver({ dataDir: corruptDataDir }).resolve('synthetic-data-role') === null);
  check('损坏密文不能被后续 save/upsert 覆盖', reopened.upsert('other-role', { provider: 'test', apiKey: 'SYNTHETIC_OTHER_VALUE' }) === false
    && reopened.save() === false && fs.readFileSync(keyPath).equals(originalKey) && fs.readFileSync(dataPath).equals(corruptCiphertext));
  try { fs.rmSync(corruptDataDir, { recursive: true, force: true }); } catch (_) {}
})();

try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}

console.log(failures ? `\ncredential-vault test failed: ${failures}` : `\ncredential-vault test passed ✔ (${passed})`);
if (failures) process.exitCode = 1;
