'use strict';
/* Internal Beyond — Credential Vault v1 单元测试（零网络）
   运行：node test_credential_vault.js
   验证：CRUD / AES-256-GCM encrypt-decrypt（落盘无明文）/ migration 幂等 /
   已存在有效凭证不被旧 snapshot 覆盖 / 两个“大黑塔”按 characterId 独立。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const createCredentialVault = require('./active/credential-vault');

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

try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}

console.log(failures ? `\ncredential-vault test failed: ${failures}` : `\ncredential-vault test passed ✔ (${passed})`);
if (failures) process.exitCode = 1;
