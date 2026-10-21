'use strict';

const assert = require('assert');
const QQ = require('../assets/js/qq-onebot-core.js');

async function main() {
  const saved = new Map();
  const storage = {
    getItem: key => saved.has(key) ? saved.get(key) : null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
    key: index => Array.from(saved.keys())[index] || null,
    get length() { return saved.size; }
  };
  const memoryRequests = [];
  const providerCalls = [];
  const adapter = QQ.createConversationAdapter({
    storage,
    getRoleConfig: async id => ({ id, systemPrompt: 'persona:' + id }),
    buildContext: async (cfg, event, history) => {
      const request = QQ.memoryRecallRequest(event, history);
      memoryRequests.push(request);
      return { system: cfg.systemPrompt, tail: 'PUBLIC_MEMORY_FOR:' + event.conversationId };
    },
    generate: async (cfg, messages, options) => {
      providerCalls.push({ cfg, messages, options });
      return 'fake reply for ' + cfg.id;
    },
    now: () => 5000
  });

  const first = {
    requestId: 'req-1', accountId: '12345678', roleId: 'role-a', messageType: 'private',
    peerId: '23456789', friendId: 'qq_12345678_23456789', conversationId: 'dm:qq_12345678_23456789',
    messageId: '1001', receivedAt: 4000, text: 'hello from account A'
  };
  const firstResult = await adapter.reply(first);
  assert.strictEqual(firstResult.ok, true);
  assert.strictEqual(firstResult.reply, 'fake reply for role-a');
  assert.strictEqual(adapter.commit(firstResult), true);

  const secondAccountSamePeer = Object.assign({}, first, {
    requestId: 'req-2', accountId: '87654321', roleId: 'role-b',
    friendId: 'qq_87654321_23456789', conversationId: 'dm:qq_87654321_23456789',
    messageId: '1002', text: 'hello from account B'
  });
  const secondResult = await adapter.reply(secondAccountSamePeer);
  assert.strictEqual(secondResult.ok, true);
  assert.strictEqual(secondResult.historyCount, 2, 'account B gets a fresh conversation history');
  assert.strictEqual(adapter.commit(secondResult), true);
  assert.notStrictEqual(firstResult.sessionKey, secondResult.sessionKey);

  const nextA = Object.assign({}, first, { requestId: 'req-3', messageId: '1003', text: 'continue A' });
  const nextAResult = await adapter.reply(nextA);
  assert.strictEqual(nextAResult.ok, true);
  assert.strictEqual(nextAResult.historyCount, 4);
  assert.strictEqual(providerCalls[2].messages.filter(message => message.role === 'user').length, 2);
  assert.strictEqual(providerCalls[2].options.disableTools, true);
  assert.strictEqual(providerCalls[2].options._noWebSearch, true);
  assert.strictEqual(providerCalls[2].messages[0].content.includes('PUBLIC_MEMORY_FOR:dm:qq_12345678_23456789'), true);
  assert.strictEqual(providerCalls[2].messages.some(message => message.content.includes('hello from account B')), false);

  const group = {
    requestId: 'req-4', accountId: '12345678', roleId: 'role-a', messageType: 'group',
    peerId: '34567890', friendId: 'group_qq_12345678_34567890',
    conversationId: 'group:group_qq_12345678_34567890', messageId: '1004', text: 'group question'
  };
  const groupRequest = QQ.memoryRecallRequest(group, []);
  assert.strictEqual(groupRequest.isGroup, true);
  assert.strictEqual(groupRequest.isFirstTurn, true);
  assert.strictEqual(groupRequest.conversationId, group.conversationId);
  assert.strictEqual(memoryRequests[0].isGroup, true, 'DM recall also uses Memory public-only ACL for external peers');

  const store = adapter.historyStore;
  assert.strictEqual(store.load(firstResult.sessionKey).length, 2);
  assert.strictEqual(store.load(secondResult.sessionKey).length, 2);
  assert.strictEqual(store.clearAccount('12345678'), 1, 'removing an account clears only its local QQ history');
  assert.strictEqual(store.load(firstResult.sessionKey).length, 0);
  assert.strictEqual(store.load(secondResult.sessionKey).length, 2);

  const credentialFailure = QQ.createConversationAdapter({
    storage,
    getRoleConfig: async id => ({ id, systemPrompt: 'persona:' + id }),
    generate: async () => { const error = new Error('CREDENTIAL_UNAVAILABLE'); error.code = 'CREDENTIAL_UNAVAILABLE'; throw error; }
  });
  const unavailableCredential = await credentialFailure.reply(Object.assign({}, first, {
    accountId: '11223344', roleId: 'role-vault', conversationId: 'dm:role-vault', text: 'vault check'
  }));
  assert.strictEqual(unavailableCredential.error, 'credential-vault-unavailable', 'Vault resolution failures remain distinct from provider failures');

  const providerFailure = QQ.createConversationAdapter({
    storage,
    getRoleConfig: async id => ({ id, systemPrompt: 'persona:' + id }),
    generate: async () => { const error = new Error('qq-provider-unavailable'); error.code = 'qq-provider-unavailable'; throw error; }
  });
  const unavailableProvider = await providerFailure.reply(Object.assign({}, first, {
    accountId: '11223344', roleId: 'role-provider', conversationId: 'dm:role-provider', text: 'provider check'
  }));
  assert.strictEqual(unavailableProvider.error, 'provider-unavailable', 'unsupported Provider failures keep their own status');

  console.log('QQ OneBot Fake Provider checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
