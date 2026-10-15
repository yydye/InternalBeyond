'use strict';

/* P3.1 · Verify existing Home Node SQLite payload_json round-trips the nested quote pointer. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createStore = require('../services/home-node/chat-store.js');
const ChatCore = require('../assets/js/chat-core.js');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-message-quote-store-'));
const store = createStore({ dataDir: tempRoot });
try {
  const opened = store.open();
  assert.strictEqual(opened.ok, true, 'open isolated canonical store');
  const original = {
    id: 'msg_1791500000000_u', role: 'user', friendId: 'quote_store_fixture',
    content: '长消息里有一句可以引用。', timestamp: 1791500000000
  };
  const reference = {
    version: 1, sourceMessageId: original.id, sourceSenderKey: 'user:local',
    snippet: '有一句可以引用。', mode: 'excerpt'
  };
  const reply = {
    id: 'msg_1791500000001_12345', role: 'assistant', friendId: original.friendId,
    content: '我注意到那一句。', timestamp: 1791500000001,
    metadata: { config_id: 'quote_store_role', replyQuote: reference }
  };
  assert.strictEqual(store.putMessage(original).ok, true, 'write original canonical message');
  assert.strictEqual(store.putMessage(reply).ok, true, 'write reply through existing authority');
  assert.deepStrictEqual(store.getMessage(reply.id).metadata.replyQuote, reference, 'SQLite payload_json round trip');
  const schemaBeforeDelete = store.meta().storedSchemaVersion;
  assert.strictEqual(schemaBeforeDelete, ChatCore.SCHEMA_VERSION, 'existing schema version unchanged');
  assert.strictEqual(store.deleteMessage(original.id).deleted, true, 'soft delete source');
  assert.strictEqual(store.getMessage(original.id), null, 'deleted source is unavailable through canonical read');
  assert.deepStrictEqual(store.getMessage(reply.id).metadata.replyQuote, reference, 'reply pointer remains without duplicating source row');
  assert.strictEqual(store.meta().storedSchemaVersion, schemaBeforeDelete, 'quote persistence did not migrate schema');
  console.log('P3.1 Message Quote Home Node Store: 7 passed.');
} finally {
  store.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
