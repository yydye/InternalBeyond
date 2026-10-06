'use strict';
/* ====================================================================
   P34.3-B · Home Node credential migration contract (Node, no browser)
     node tests/test_home_node_credential_migration.js

   Proves, with a synthetic Vault (no real secret):
     1. writer  : published runtime spec carries credentialRef, NOT apiKey
     2. reader  : executeCharacterTurn resolves the secret from the Vault
     3. fail-closed : no Vault binding => credential-unavailable (no plaintext fallback)
     4. DTO boundary: listCharacters carries no spec/credential
   ==================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const createVault = require(path.join(ROOT, 'active', 'credential-vault.js'));

/* ── P5-B3-D3 · character binding test seam ──────────────────────────
   TURN_CHARACTER_SCOPE_AUTHORITY = SERVER_VALIDATED_CANONICAL_CHARACTER_BINDING。
   生产由 device-registry.getCharacterSpec 提供；测试在**构造期**注入等价接口
   （绝不通过 execute({...}) 逐次传入 —— authority 属于 executor 实例）。
   这里只确认"该 character id 存在"，provider 配置仍走既有 request 契约。 */
const testCharacterRegistry = { getCharacterSpec: function (id) { return String(id || '').trim() ? {} : null; } };

let passed = 0, failed = 0;
function check(name, cond, extra) { if (cond) { passed++; console.log('OK   ' + name); } else { failed++; console.error('FAIL ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); } }

const CHAR = 'friend_mig_a';
const SECRET = 'sk-SYNTHETIC-VAULT-SECRET-0123456789';

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p343b-'));
  const homeNodeDataDir = path.join(dataDir, 'home-node');
  fs.mkdirSync(homeNodeDataDir, { recursive: true });
  const vault = createVault({ dataDir: dataDir });
  vault.load();
  vault.upsert(CHAR, { provider: 'custom', apiKey: SECRET });
  vault.upsert('role_ref_old', { provider: 'custom', apiKey: 'SYNTHETIC_OLD_VAULT_KEY' });
  vault.save();

  const captured = {};
  const port = {
    runStream: async (req) => { captured.spec = req.spec; captured.secretAtCall = req.spec.apiKey; captured.system = String((req.prompt && req.prompt.system) || ''); return { ok: true, text: 'pong', usage: null }; }
  };
  const instance = SERVICE.buildHomeNode({ dataDir: homeNodeDataDir, credentialDataDir: dataDir, token: 'p343b-admin', port: port, logger: () => {} });
  instance.open();
  const registry = instance.registry;

  try {
    /* publish an apiConfigs-shaped entry (with a plaintext apiKey that must NOT persist) */
    const entry = {
      id: CHAR, nickname: '迁移角色', model: 'mock-model', provider: 'custom',
      endpoint: 'https://example.invalid/v1/chat/completions',
      apiKey: 'sk-PLAINTEXT-MUST-NOT-PERSIST', systemPrompt: 'PERSONA-P343B'
    };
    const MOBILE_DTO = require(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'));
    const written = registry.putCharacters([MOBILE_DTO.characterCatalogEntry(entry, { withSpec: true })], { merge: true });
    check('publish ok (withSpec=1)', written.ok === true && written.withSpec === 1, written);

    const spec = registry.getCharacterSpec(CHAR);
    check('spec 含 credentialRef（= character id）', !!spec && spec.credentialRef === CHAR, spec && Object.keys(spec));
    check('spec 不含明文 apiKey', !!spec && spec.apiKey === undefined && JSON.stringify(spec).indexOf('sk-PLAINTEXT') < 0, spec);
    check('spec 保留 provider/model/endpoint/systemPrompt', !!spec && spec.provider === 'custom' && spec.model === 'mock-model' && !!spec.endpoint && spec.systemPrompt === 'PERSONA-P343B', spec);

    /* DTO boundary: listCharacters must not carry the spec */
    const dtoJson = JSON.stringify(registry.listCharacters());
    check('DTO 不含 spec / credential / secret', dtoJson.indexOf('credentialRef') < 0 && dtoJson.indexOf('sk-') < 0 && dtoJson.indexOf('apiKey') < 0, dtoJson.slice(0, 200));

    /* reader: executeCharacterTurn resolves the secret from the Vault and hands it to the port */
    const createExecutor = require(path.join(ROOT, 'services', 'home-node', 'execution.js'));
    const executor = instance.executor;
    const res = await executor.executeCharacterTurn({
      requestId: 'p343b-turn-1',
      userMessage: { id: 'm1', role: 'user', content: 'hi', friendId: CHAR, timestamp: Date.now() },
      character: { id: CHAR, spec: spec },
      history: []
    }, {});
    check('Home Node 使用共享 app-root Vault（与 SQLite 子目录分离）', res && res.ok === true, res && { ok: res.ok, error: res.error });
    check('provider port 收到从 Vault 解析出的 secret', captured.secretAtCall === SECRET, captured.secretAtCall && { apiKeyLen: captured.secretAtCall.length });
    check('请求完成后 runtime spec 清除 apiKey', captured.spec && captured.spec.apiKey === '', captured.spec && { apiKeyLen: (captured.spec.apiKey || '').length });
    check('provider port 收到 persona system', captured.system.indexOf('PERSONA-P343B') >= 0, { len: captured.system.length });

    /* Existing refs win over an inline value; the inline value cannot mask a stale Vault binding. */
    captured.spec = null; captured.secretAtCall = '';
    const staleEntry = Object.assign({}, entry, { credentialRef: 'role_ref_old' });
    registry.putCharacters([MOBILE_DTO.characterCatalogEntry(staleEntry, { withSpec: true })], { merge: true });
    const staleSpec = registry.getCharacterSpec(CHAR);
    const staleRefResult = await executor.executeCharacterTurn({
      requestId: 'p343b-turn-stale-ref',
      userMessage: { id: 'm-stale', role: 'user', content: 'hi', friendId: CHAR, timestamp: Date.now() },
      character: { id: CHAR, spec: Object.assign({}, staleSpec, { apiKey: 'SYNTHETIC_INLINE_NEW_KEY' }) },
      history: []
    }, {});
    check('credentialRef 对应旧绑定时优先使用 Vault secret', staleRefResult && staleRefResult.ok === true && captured.secretAtCall === 'SYNTHETIC_OLD_VAULT_KEY', staleRefResult && { ok: staleRefResult.ok, apiKeyLen: captured.secretAtCall.length });
    check('stale-ref 请求完成后 secret 已清除', captured.spec && captured.spec.apiKey === '');

    /* fail-closed: a character with no Vault binding must not run */
    const accessDenied = require(path.join(ROOT, 'services', 'home-node', 'credential-access.js'))({ dataDir: dataDir, isAllowed: () => true });
    const executor2 = createExecutor({
  characterRegistry: testCharacterRegistry, store: instance.store, port: port, credentialAccess: accessDenied, logger: () => {} });
    const res2 = await executor2.executeCharacterTurn({
      requestId: 'p343b-turn-2',
      userMessage: { id: 'm2', role: 'user', content: 'hi', friendId: 'no-binding', timestamp: Date.now() },
      character: { id: 'no-binding', spec: { provider: 'custom', model: 'm', endpoint: 'https://x/y', credentialRef: 'no-binding', apiKey: 'SYNTHETIC_INLINE_MUST_NOT_FALLBACK' } },
      history: []
    }, {});
    check('无 Vault 绑定时 fail-closed（credential-unavailable）', res2 && res2.ok === false && res2.error === 'credential-unavailable', res2);
  } catch (error) {
    failed++;
    console.error('FAIL migration test exception — ' + String((error && error.stack) || error));
  } finally {
    instance.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }

  if (failed) { console.error('P34.3-B migration contract FAILED: ' + failed + ' (passed ' + passed + ')'); process.exitCode = 1; }
  else console.log('P34.3-B migration contract passed (' + passed + ')');
})();
