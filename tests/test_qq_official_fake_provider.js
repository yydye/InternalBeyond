'use strict';

const assert = require('node:assert/strict');
const QQ = require('../assets/js/qq-onebot-core.js');

async function main() {
  const values = new Map();
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    key: index => Array.from(values.keys())[index] || null,
    get length() { return values.size; }
  };
  const providerCalls = [];
  const memoryRequests = [];
  const adapter = QQ.createConversationAdapter({
    storage,
    getRoleConfig: async id => ({ id, systemPrompt: 'role:' + id }),
    buildContext: async (config, event, history) => {
      const request = QQ.memoryRecallRequest(event, history);
      memoryRequests.push(request);
      return { system: config.systemPrompt, tail: 'public:' + event.conversationId };
    },
    generate: async (config, messages, options) => {
      providerCalls.push({ config, messages, options });
      return 'reply:' + config.id;
    },
    now: () => 9000
  });

  const official = {
    requestId: 'official-request-1', platform: 'qq-official', appId: 'mock-app-a',
    accountId: 'qqofficial_mock-app-a', roleId: 'role-official', messageType: 'private',
    senderId: 'opaque-open-id-a', peerId: 'opaque-open-id-a',
    friendId: 'qqofficial_mock-app-a_opaque-open-id-a',
    conversationId: 'qq-official:mock-app-a:c2c:opaque-open-id-a',
    messageId: 'official-msg-1', receivedAt: 8000, text: 'private test prompt'
  };
  const officialResult = await adapter.reply(official);
  assert.equal(officialResult.ok, true);
  assert.equal(officialResult.reply, 'reply:role-official');
  assert.equal(adapter.commit(officialResult), true);
  assert.equal(providerCalls[0].config.id, 'role-official', 'the selected existing role Provider is used');
  assert.equal(providerCalls[0].options.disableTools, true, 'QQ P0 cannot execute agent tools');
  assert.equal(providerCalls[0].options._noWebSearch, true);
  assert.equal(memoryRequests[0].characterId, 'role-official');
  assert.equal(memoryRequests[0].isGroup, true, 'external QQ contexts use the existing public-only Memory rule');
  assert.equal(memoryRequests[0].conversationId, official.conversationId);

  const napcat = Object.assign({}, official, {
    requestId: 'napcat-request-1', platform: undefined, appId: undefined,
    accountId: '12345678', roleId: 'role-napcat', peerId: 'opaque-open-id-a',
    friendId: 'qq_12345678_opaque-open-id-a',
    conversationId: 'dm:qq_12345678_opaque-open-id-a',
    messageId: 'napcat-msg-1', text: 'napcat private prompt'
  });
  const napcatResult = await adapter.reply(napcat);
  assert.equal(napcatResult.ok, true);
  assert.notEqual(officialResult.sessionKey, napcatResult.sessionKey,
    'Official Bot history is separate from NapCat even when the peer string matches');
  assert.equal(adapter.commit(napcatResult), true);

  const officialAgain = Object.assign({}, official, { requestId: 'official-request-2', messageId: 'official-msg-2', text: 'continue official' });
  const next = await adapter.reply(officialAgain);
  assert.equal(next.ok, true);
  assert.equal(next.historyCount, 4);
  assert.equal(providerCalls[2].messages.some(message => message.content === 'napcat private prompt'), false,
    'NapCat message content never enters the Official Bot conversation history');
  assert.equal(providerCalls[2].messages[0].content.includes(official.conversationId), true);

  const groupA = {
    requestId: 'official-group-request-1', platform: 'qq-official', appId: 'mock-app-a',
    accountId: 'qqofficial_mock-app-a', roleId: 'role-group-a', messageType: 'group',
    groupOpenId: 'opaque-group-a', peerId: 'opaque-group-a', senderId: 'member-open-a',
    senderName: 'Alice', senderRef: 'member-111111111111',
    conversationId: 'qq-official:mock-app-a:group:hash-a', messageId: 'group-msg-a',
    receivedAt: 9100, text: 'hello group A'
  };
  const groupB = Object.assign({}, groupA, {
    requestId: 'official-group-request-2', senderId: 'member-open-b', senderName: 'Bob',
    senderRef: 'member-222222222222', messageId: 'group-msg-b', text: 'hello group B'
  });
  const otherGroup = Object.assign({}, groupA, {
    requestId: 'official-group-request-3', roleId: 'role-group-b', groupOpenId: 'opaque-group-b',
    peerId: 'opaque-group-b', senderId: 'member-open-a', conversationId: 'qq-official:mock-app-a:group:hash-b',
    senderRef: 'member-333333333333', messageId: 'other-group-msg', text: 'other group'
  });
  assert.equal(QQ.conversationStorageKey(groupA), QQ.conversationStorageKey(groupB),
    'members in one group share the same history key');
  assert.notEqual(QQ.conversationStorageKey(groupA), QQ.conversationStorageKey(otherGroup),
    'different groups have isolated history keys');
  assert.notEqual(QQ.conversationStorageKey(groupA), QQ.conversationStorageKey(official),
    'group history cannot collide with C2C history');
  const groupResultA = await adapter.reply(groupA);
  assert.equal(groupResultA.ok, true);
  assert.equal(adapter.commit(groupResultA), true);
  const groupCallA = providerCalls[3];
  const groupCurrentA = groupCallA.messages[groupCallA.messages.length - 1].content;
  assert.equal(groupCurrentA.includes('Alice · member-111111111111'), true,
    'the prompt preserves a stable member identity without using the raw member OpenID');
  assert.equal(JSON.stringify(groupCallA.messages).includes('member-open-a'), false,
    'the raw member OpenID never enters the Provider prompt');
  assert.equal(JSON.stringify(groupCallA.messages).includes('opaque-group-a'), false,
    'the raw group OpenID never enters the Provider prompt');
  assert.equal(memoryRequests[3].message.includes('member-111111111111'), true,
    'Memory recall sees the same group speaker identity within the group public scope');
  const groupResultB = await adapter.reply(groupB);
  assert.equal(groupResultB.ok, true);
  const groupCallB = providerCalls[4];
  assert.equal(groupCallB.messages.some(message => typeof message.content === 'string'
    && message.content.includes('Alice · member-111111111111')), true,
  'group history is shared across members while speaker labels remain attached to each turn');
  assert.equal(groupCallB.messages[groupCallB.messages.length - 1].content.includes('Bob · member-222222222222'), true);
  const isolatedGroupResult = await adapter.reply(otherGroup);
  assert.equal(isolatedGroupResult.ok, true);
  const isolatedGroupMessages = providerCalls[5].messages;
  assert.equal(isolatedGroupMessages.some(message => typeof message.content === 'string'
    && message.content.includes('Alice · member-111111111111')), false,
  'a second group does not inherit the first group history');
  assert.equal(memoryRequests[5].isGroup, true, 'group Memory requests retain the existing public-only audience rule');

  const privateSession = Object.assign({}, official, {
    sessionId: 'session-private-next',
    conversationId: official.conversationId + ':session:session-private-next',
    messageId: 'private-new-session', text: 'fresh role session'
  });
  assert.notEqual(QQ.conversationStorageKey(privateSession), QQ.conversationStorageKey(official),
    'a new role session uses a distinct persistent history namespace');
  const privateSessionResult = await adapter.reply(privateSession);
  assert.equal(privateSessionResult.ok, true);
  assert.equal(privateSessionResult.historyCount, 2, 'a role switch starts with no earlier turn history');
  assert.equal(providerCalls.at(-1).messages.some(message => message.content === 'private test prompt'), false);
  assert.equal(adapter.commit(privateSessionResult), true);
  assert.equal(adapter.reset(privateSession), true, 'reset removes only the selected QQ conversation session');
  assert.deepEqual(adapter.historyStore.load(privateSessionResult.sessionKey), []);
  assert.equal(adapter.historyStore.load(officialResult.sessionKey).length, 2,
    'reset does not remove another session or desktop Role DM history');

  console.log('QQ Official Fake Provider and conversation isolation checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
