'use strict';

/* P5-B3-L-R1 · the user-message fact boundary is Home Node chat-store.
   Tests post-commit provenance only; no P1 observation is inserted here. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createChatStore = require(path.resolve(__dirname, '../services/home-node/chat-store.js'));
const CHAT_CORE = require(path.resolve(__dirname, '../assets/js/chat-core.js'));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ling-fact-'));
const SERVER_TIME = 1760000002345;
let passed = 0;
function check(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log('PASS ' + name);
}

try {
  const facts = [];
  const store = createChatStore({
    dataDir: path.join(ROOT, 'canonical'),
    clock: () => SERVER_TIME,
    logger: () => {},
    onCanonicalUserMessage: fact => { facts.push(fact); }
  });
  store.open();
  const message = {
    id: 'canonical_message_user_1', role: 'user',
    content: '  ' + 'statement '.repeat(60) + '  ',
    friendId: 'character_alpha', threadId: 'topic_alpha', timestamp: SERVER_TIME - 3000,
    metadata: {
      provider: 'payload-provider', model: 'payload-model', endpoint: 'https://payload.invalid',
      apiKey: 'PAYLOAD_SECRET', conversationId: 'dm:attacker-conversation', characterId: 'attacker-character'
    },
    images: [{ dataUrl: 'data:image/png;base64,INLINE_IMAGE_SENTINEL' }]
  };
  const created = store.putMessage(message, { requestId: 'canonical-user-req-1' });
  assert.equal(created.ok, true);
  assert.equal(created.outcome, 'created');
  check('A.newUserFactIsEmittedOnlyAfterCanonicalCommit', facts.length === 1
    && store.isCanonicalUserMessageFact(facts[0]) === true
    && Object.isFrozen(facts[0]) === true);
  check('B.identityAndScopeComeFromStoredRow', facts[0].sourceMessageId === message.id
    && facts[0].characterId === message.friendId
    && facts[0].conversationId === CHAT_CORE.conversationIdOf(message.friendId, message.threadId)
    && facts[0].threadId === message.threadId);
  check('C.occurredAtUsesServerChangeLogTime', facts[0].occurredAt === SERVER_TIME
    && facts[0].occurredAt !== message.timestamp);
  check('D.textIsBoundedAndPrivatePayloadIsExcluded', facts[0].statementText.length === 400
    && Object.keys(facts[0]).sort().join(',') === 'characterId,conversationId,occurredAt,role,sourceMessageId,statementText,threadId'
    && JSON.stringify(facts[0]).indexOf('PAYLOAD_SECRET') < 0
    && JSON.stringify(facts[0]).indexOf('INLINE_IMAGE_SENTINEL') < 0);
  check('E.copyingFactShapeDoesNotCopyTheStoreSeal', store.isCanonicalUserMessageFact(Object.assign({}, facts[0])) === false);

  for (let i = 0; i < 100; i += 1) store.putMessage(message, { requestId: 'canonical-user-req-1' });
  check('F.oneHundredRequestReplaysEmitOneLogicalFact', facts.length === 1);

  const edited = Object.assign({}, message, { content: 'edited after original commit' });
  const updated = store.putMessage(edited);
  assert.equal(updated.outcome, 'updated');
  check('G.updateDoesNotRewriteOrReemitOriginalFact', facts.length === 1
    && facts[0].statementText.indexOf('statement') >= 0);

  const assistant = store.putMessage({
    id: 'canonical_message_assistant_1', role: 'assistant', content: 'reply',
    friendId: message.friendId, threadId: message.threadId, timestamp: SERVER_TIME
  });
  assert.equal(assistant.ok, true);
  const imported = store.putMessages([{
    id: 'historical_user_message', role: 'user', content: 'historical import',
    friendId: message.friendId, threadId: message.threadId, timestamp: SERVER_TIME - 100000
  }], { requestId: 'migration-batch-1' });
  assert.equal(imported.ok, true);
  check('H.assistantAndBatchImportDoNotEmitLiveFacts', facts.length === 1);

  const deleted = store.deleteMessage(message.id);
  assert.equal(deleted.ok, true);
  check('I.deleteDoesNotRetroactivelyRevokeFact', store.isCanonicalUserMessageFact(facts[0]) === true
    && store.getMessage(message.id) === null);
  store.close();

  const isolatedStore = createChatStore({
    dataDir: path.join(ROOT, 'callback-failure'),
    clock: () => SERVER_TIME,
    logger: () => {},
    onCanonicalUserMessage: () => { throw new Error('synthetic observer failure'); }
  });
  isolatedStore.open();
  const chatWrite = isolatedStore.putMessage({
    id: 'canonical_message_user_failure', role: 'user', content: 'chat remains valid',
    friendId: 'character_alpha', timestamp: SERVER_TIME
  });
  check('J.producerFailureCannotFailChatWrite', chatWrite.ok === true
    && isolatedStore.getMessage('canonical_message_user_failure').content === 'chat remains valid');
  isolatedStore.close();

  console.log('LINGUISTIC EVIDENCE PRODUCER BOUNDARY PASSED · ' + passed + ' assertions green');
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
}
