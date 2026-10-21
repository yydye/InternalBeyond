'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const QQCore = require('../assets/js/qq-onebot-core.js');
const providerDirectory = require('../assets/js/provider-directory.js');

async function main() {
  const values = new Map();
  const accounts = [
    { accountId: '12345678', roleId: 'role-a', takeover: true, allowedPrivateUserIds: ['23456789'], allowedGroupIds: [] },
    { accountId: '87654321', roleId: 'role-b', takeover: true, allowedPrivateUserIds: ['23456789'], allowedGroupIds: [] }
  ];
  values.set('ib_qq_onebot_settings_v1', JSON.stringify({ paused: false, accounts }));
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value)
  };
  const recallCalls = [];
  const providerCalls = [];
  const completions = [];
  const configWrites = [];
  let credentialFailure = false;
  const roleConfigs = Object.create(null);
  accounts.forEach(row => {
    roleConfigs[row.roleId] = {
      id: row.roleId, nickname: row.roleId, provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-v4-flash',
      credentialRef: row.roleId, systemPrompt: 'persona:' + row.roleId
    };
  });
  const window = {
    IBQQOneBotCore: QQCore,
    PROVIDERS_DIR: providerDirectory,
    _messageApiConfig: input => roleConfigs[input.friendId] || null,
    _ibApiHasCredential: cfg => !!String(cfg && (Object.prototype.hasOwnProperty.call(cfg, 'credentialRef') ? cfg.credentialRef : cfg.id) || '').trim(),
    _ibApiReady: cfg => !!(cfg && cfg.endpoint && cfg.model && window._ibApiHasCredential(cfg)),
    _ibIsLoopbackEndpoint: endpoint => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::|\/|$)/i.test(String(endpoint || '')),
    IB: {
      roleDm: { listCharacters: () => accounts.map(row => ({ id: row.roleId, name: row.roleId, ready: true })) },
      homeNode: {
        runtime: {
          runMemoryRecall: async input => {
            recallCalls.push(input);
            return { ok: true, context: { text: 'PUBLIC_ONLY_MEMORY:' + input.conversationId } };
          }
        },
        qqOnebot: {
          configure: async input => { configWrites.push(input); return { ok: true }; },
          complete: async (requestId, reply) => { completions.push({ requestId, reply }); return { ok: true, replied: !!reply }; },
          status: async () => ({ ok: true, accounts: [] }),
          poll: async () => ({ ok: true, event: null }),
          setup: async accountId => ({ ok: true, callbackUrl: 'http://127.0.0.1:23118/qq/onebot/v11/' + accountId })
        }
      },
      chat: {
        callExternalReply: async (roleId, messages, conversationId) => {
          if (credentialFailure) {
            const error = new Error('CREDENTIAL_UNAVAILABLE');
            error.code = 'CREDENTIAL_UNAVAILABLE';
            throw error;
          }
          providerCalls.push({ roleId, messages, conversationId });
          return 'fake:' + roleId;
        }
      }
    }
  };
  const document = { readyState: 'loading', addEventListener: function () {}, getElementById: function () { return null; } };
  const context = { window, document, localStorage: storage, console, Promise, setTimeout, clearTimeout, setInterval, URL, navigator: {} };
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets/js/qq-onebot.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'qq-onebot.js' });
  const api = window.IB.qqOnebot;

  const a = await api._processEvent({
    requestId: 'req-a', accountId: '12345678', roleId: 'role-a', messageType: 'private',
    peerId: '23456789', friendId: 'qq_12345678_23456789', conversationId: 'dm:qq_12345678_23456789',
    messageId: '1', receivedAt: 1000, text: 'hello A'
  });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(recallCalls[0].isGroup, true, 'external DM uses existing Memory public-only ACL');
  assert.strictEqual(providerCalls[0].roleId, 'role-a');
  assert.strictEqual(providerCalls[0].conversationId, 'dm:qq_12345678_23456789');
  assert.strictEqual(providerCalls[0].messages[0].content.includes('PUBLIC_ONLY_MEMORY:dm:qq_12345678_23456789'), true);
  assert.strictEqual(completions[0].reply, 'fake:role-a');

  const b = await api._processEvent({
    requestId: 'req-b', accountId: '87654321', roleId: 'role-b', messageType: 'private',
    peerId: '23456789', friendId: 'qq_87654321_23456789', conversationId: 'dm:qq_87654321_23456789',
    messageId: '2', receivedAt: 2000, text: 'hello B'
  });
  assert.strictEqual(b.ok, true);
  assert.notStrictEqual(a.sessionKey, b.sessionKey);
  assert.strictEqual(providerCalls[1].messages.some(message => message.content.includes('hello A')), false);

  const failureEventBase = {
    accountId: '12345678', roleId: 'role-a', messageType: 'private', peerId: '23456789',
    friendId: 'qq_12345678_23456789', conversationId: 'dm:qq_12345678_23456789', text: 'failure classification'
  };
  roleConfigs['role-a'].provider = 'removed-provider';
  const beforeUnknownProvider = providerCalls.length;
  const unsupported = await api._processEvent(Object.assign({}, failureEventBase, { requestId: 'req-unknown-provider', messageId: 'unknown-provider' }));
  assert.strictEqual(unsupported.error, 'provider-unavailable');
  assert.strictEqual(providerCalls.length, beforeUnknownProvider, 'unknown Providers are rejected before the existing chat Provider seam');
  roleConfigs['role-a'].provider = 'deepseek';

  credentialFailure = true;
  const vaultFailure = await api._processEvent(Object.assign({}, failureEventBase, { requestId: 'req-vault-failure', messageId: 'vault-failure' }));
  credentialFailure = false;
  assert.strictEqual(vaultFailure.error, 'credential-vault-unavailable');
  assert.strictEqual(completions[completions.length - 1].reply, '', 'unresolved Vault credentials never produce a QQ reply');

  await api.pause();
  const paused = await api._processEvent({
    requestId: 'req-paused', accountId: '12345678', roleId: 'role-a', messageType: 'private',
    peerId: '23456789', friendId: 'qq_12345678_23456789', conversationId: 'dm:qq_12345678_23456789',
    messageId: '3', text: 'must not send'
  });
  assert.strictEqual(paused.error, 'takeover-paused');
  assert.strictEqual(completions[completions.length - 1].reply, '');
  assert.strictEqual(providerCalls.length, 2);
  assert.strictEqual(configWrites[configWrites.length - 1].paused, true);
  console.log('QQ OneBot frontend Fake Provider checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
