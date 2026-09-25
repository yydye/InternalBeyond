'use strict';

/* Synthetic-only tests for the versioned target snapshot manifest.
   The database below is an in-memory IndexedDB cursor contract. */
const assert = require('assert');
const crypto = require('crypto');
const Schema = require('../assets/js/webcore-db-schema.js');
const Engine = require('../assets/js/recovery-engine.js');
const Adapter = require('../assets/js/recovery-production-adapter.js');
const Snapshot = Adapter.testOnly;

const TARGET_IDENTITY = 'com.internalbeyond.desktop|canonical-inno|C:\\Synthetic\\InternalBeyond|1.0.6|' + 'a'.repeat(64);
const TARGET_ORIGIN = 'http://tauri.localhost';

function rowsFixture() {
  return {
    apiConfigs: {
      api_1: { id: 'api_1', provider: 'synthetic', model: 'model-a', endpoint: 'https://api.example.invalid/v1?api_key=SYNTHETIC_SECRET', apiKey: 'SYNTHETIC_SECRET', systemPrompt: 'SYNTHETIC_PROMPT' }
    },
    chatMessages: {
      chat_1: { id: 'chat_1', role: 'user', friendId: 'friend_1', threadId: 'thread_1', content: 'SYNTHETIC_CHAT_BODY', timestamp: 1700000000000 }
    },
    chatThreads: { thread_1: { id: 'thread_1', friendId: 'friend_1', title: 'SYNTHETIC_THREAD_TITLE' } },
    groups: { group_1: { id: 'group_1', members: [{ characterId: 'friend_1', name: 'SYNTHETIC_MEMBER_LABEL' }] } },
    memories: { memory_1: { id: 'memory_1', characterId: 'friend_1', content: 'SYNTHETIC_MEMORY_BODY' } },
    autoMemory: { auto_1: { id: 'auto_1', friendId: 'friend_1', content: 'SYNTHETIC_AUTO_MEMORY_BODY' } },
    diary_entries: { diary_1: { id: 'diary_1', characterId: 'friend_1', relatedMemoryIds: ['memory_1'], content: 'SYNTHETIC_DIARY_BODY', timestamp: 1700000000001 } },
    moments: { moment_1: { id: 'moment_1', roleId: 'friend_1', characterId: 'friend_1', content: 'SYNTHETIC_MOMENT_BODY' } },
    roleLetters: { letter_1: { id: 'letter_1', fromRoleId: 'friend_1', toRoleId: 'friend_2', parentId: null, content: 'SYNTHETIC_LETTER_BODY' } }
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function fakeReadonlyDatabase(rows, version = Schema.DB_VERSION) {
  const stats = { transactions: 0, writeTransactions: 0, cursorOpens: 0 };
  const db = {
    name: Schema.DB_NAME,
    version,
    transaction(names, mode) {
      assert.strictEqual(mode, 'readonly');
      stats.transactions++;
      if (mode !== 'readonly') stats.writeTransactions++;
      const stores = Array.isArray(names) ? names : [names];
      const tx = { oncomplete: null, onabort: null, onerror: null };
      let pending = stores.length;
      let completeScheduled = false;
      const finish = () => {
        if (pending !== 0 || completeScheduled) return;
        completeScheduled = true;
        setTimeout(() => tx.oncomplete && tx.oncomplete({ target: tx }), 0);
      };
      tx.objectStore = name => {
        assert.ok(stores.includes(name));
        return {
          openCursor() {
            stats.cursorOpens++;
            const request = { onsuccess: null, onerror: null, result: null };
            const entries = Object.values(rows[name] || {}).slice().sort((a, b) => String(a.id) < String(b.id) ? -1 : (String(a.id) > String(b.id) ? 1 : 0));
            const dispatch = index => setTimeout(() => {
              if (index >= entries.length) {
                request.result = null;
                if (request.onsuccess) request.onsuccess({ target: request });
                pending--;
                finish();
                return;
              }
              let advanced = false;
              const record = entries[index];
              request.result = {
                primaryKey: record.id,
                value: record,
                continue() {
                  if (advanced) throw new Error('synthetic-cursor-continued-twice');
                  advanced = true;
                  dispatch(index + 1);
                }
              };
              if (request.onsuccess) request.onsuccess({ target: request });
              if (!advanced) {
                pending--;
                finish();
              }
            }, 0);
            dispatch(0);
            return request;
          }
        };
      };
      return tx;
    }
  };
  return { db, stats };
}

async function capture(rows, version = Schema.DB_VERSION) {
  const fake = fakeReadonlyDatabase(rows, version);
  const snapshot = await Snapshot.snapshotDatabase(fake.db, Engine.DOMAIN_ORDER, TARGET_IDENTITY, TARGET_ORIGIN);
  assert.strictEqual(fake.stats.writeTransactions, 0);
  assert.strictEqual(fake.stats.transactions, 1);
  assert.strictEqual(fake.stats.cursorOpens, Engine.DOMAIN_ORDER.length);
  return { snapshot, manifest: snapshot.manifest, stats: fake.stats };
}

function componentHashes(manifest) {
  return Object.fromEntries(manifest.components.map(component => [component.name, component.sha256]));
}

async function run() {
  const baseRows = rowsFixture();
  const base = await capture(baseRows);
  const manifest = base.manifest;
  assert.strictEqual(manifest.schema, 'internalbeyond.target-snapshot-manifest');
  assert.strictEqual(manifest.version, 1);
  assert.strictEqual(manifest.targetIdentity, TARGET_IDENTITY);
  assert.strictEqual(manifest.origin, TARGET_ORIGIN);
  assert.strictEqual(manifest.databaseName, Schema.DB_NAME);
  assert.strictEqual(manifest.schemaVersion, Schema.DB_VERSION);
  assert.deepStrictEqual(manifest.stores.map(store => store.name), Object.keys(Engine.STORE_BY_DOMAIN).sort());
  assert.match(manifest.aggregateSha256, /^[a-f0-9]{64}$/);
  const unsigned = Object.assign({}, manifest);
  delete unsigned.aggregateSha256;
  assert.strictEqual(crypto.createHash('sha256').update(Snapshot.stableJson(unsigned), 'utf8').digest('hex'), manifest.aggregateSha256);
  assert.ok(!JSON.stringify(manifest).match(/SYNTHETIC_SECRET|SYNTHETIC_PROMPT|SYNTHETIC_.*BODY|SYNTHETIC_MEMBER_LABEL|timestamp|content|session|cache|wal/i));

  const reversedRows = {};
  for (const storeName of Object.keys(baseRows)) reversedRows[storeName] = Object.fromEntries(Object.entries(baseRows[storeName]).reverse());
  const reordered = await capture(reversedRows);
  assert.strictEqual(reordered.manifest.aggregateSha256, manifest.aggregateSha256, 'record insertion order must not affect the manifest');

  const addRows = clone(baseRows);
  addRows.chatMessages.chat_2 = { id: 'chat_2', role: 'assistant', friendId: 'friend_1', threadId: 'thread_1', content: 'NEW_SYNTHETIC_BODY', timestamp: 1700000000002 };
  const added = await capture(addRows);
  assert.notStrictEqual(added.manifest.aggregateSha256, manifest.aggregateSha256, 'record add must change snapshot');
  assert.notStrictEqual(componentHashes(added.manifest)['store:chatMessages:count'], componentHashes(manifest)['store:chatMessages:count']);
  assert.notStrictEqual(componentHashes(added.manifest)['store:chatMessages:keySet'], componentHashes(manifest)['store:chatMessages:keySet']);

  const deleteRows = clone(baseRows);
  delete deleteRows.chatMessages.chat_1;
  const deleted = await capture(deleteRows);
  assert.notStrictEqual(deleted.manifest.aggregateSha256, manifest.aggregateSha256, 'record delete must change snapshot');

  const relevantMutationRows = clone(baseRows);
  relevantMutationRows.chatMessages.chat_1.friendId = 'friend_2';
  const relevantMutation = await capture(relevantMutationRows);
  assert.notStrictEqual(relevantMutation.manifest.aggregateSha256, manifest.aggregateSha256, 'relevant reference metadata mutation must change snapshot');
  assert.strictEqual(componentHashes(relevantMutation.manifest)['store:chatMessages:keySet'], componentHashes(manifest)['store:chatMessages:keySet']);
  assert.notStrictEqual(componentHashes(relevantMutation.manifest)['store:chatMessages:recordProjection'], componentHashes(manifest)['store:chatMessages:recordProjection']);

  const keyChangeRows = clone(baseRows);
  keyChangeRows.chatMessages.chat_2 = Object.assign({}, keyChangeRows.chatMessages.chat_1, { id: 'chat_2' });
  delete keyChangeRows.chatMessages.chat_1;
  const keyChanged = await capture(keyChangeRows);
  assert.notStrictEqual(keyChanged.manifest.aggregateSha256, manifest.aggregateSha256, 'primary key change must change snapshot');
  assert.notStrictEqual(componentHashes(keyChanged.manifest)['store:chatMessages:keySet'], componentHashes(manifest)['store:chatMessages:keySet']);

  const schemaChanged = await capture(baseRows, Schema.DB_VERSION + 1);
  assert.notStrictEqual(schemaChanged.manifest.aggregateSha256, manifest.aggregateSha256, 'schema version change must change snapshot');
  assert.notStrictEqual(componentHashes(schemaChanged.manifest).schemaVersion, componentHashes(manifest).schemaVersion);

  const bodyOnlyRows = clone(baseRows);
  bodyOnlyRows.chatMessages.chat_1.content = 'CHANGED_SYNTHETIC_CHAT_BODY';
  bodyOnlyRows.chatMessages.chat_1.timestamp = 1800000000000;
  bodyOnlyRows.diary_entries.diary_1.content = 'CHANGED_SYNTHETIC_DIARY_BODY';
  bodyOnlyRows.diary_entries.diary_1.timestamp = 1800000000001;
  bodyOnlyRows.chatThreads.thread_1.title = 'CHANGED_SYNTHETIC_THREAD_TITLE';
  const bodyOnly = await capture(bodyOnlyRows);
  assert.strictEqual(bodyOnly.manifest.aggregateSha256, manifest.aggregateSha256, 'business bodies and volatile timestamps stay outside the manifest');

  const secretOnlyRows = clone(baseRows);
  secretOnlyRows.apiConfigs.api_1.apiKey = 'CHANGED_SYNTHETIC_SECRET';
  secretOnlyRows.apiConfigs.api_1.systemPrompt = 'CHANGED_SYNTHETIC_PROMPT';
  const secretOnly = await capture(secretOnlyRows);
  assert.strictEqual(secretOnly.manifest.aggregateSha256, manifest.aggregateSha256, 'credential secrets and prompt text stay outside apiConfigs projection');
  const apiMetadataRows = clone(baseRows);
  apiMetadataRows.apiConfigs.api_1.model = 'model-b';
  const apiMetadataChanged = await capture(apiMetadataRows);
  assert.notStrictEqual(apiMetadataChanged.manifest.aggregateSha256, manifest.aggregateSha256, 'apiConfigs identity metadata changes the record digest');

  const entries = {};
  for (const storeName of Object.keys(baseRows)) {
    entries[storeName] = Object.values(baseRows[storeName]).map(record => ({
      keyCanonical: Snapshot.canonicalIdbKeyJson(record.id),
      metadata: Snapshot.projectSnapshotRecord(storeName, record)
    }));
  }
  const noisySnapshot = Object.assign({}, base.snapshot, {
    fileMtime: '2099-01-01T00:00:00Z',
    webViewLogs: { lastWrite: 'different' },
    sessionMetadata: { id: 'different', lastSeen: 2 },
    cache: { entryCount: 999 },
    physicalLevelDbWal: { bytes: 'different' },
    shmBytes: 'different'
  });
  const noisyManifest = await Snapshot.buildTargetSnapshotManifest(TARGET_IDENTITY, TARGET_ORIGIN, noisySnapshot, entries);
  assert.strictEqual(noisyManifest.aggregateSha256, manifest.aggregateSha256, 'filesystem and WebView noise must not affect logical snapshot');

  assert.notStrictEqual(Snapshot.canonicalIdbKeyJson('1'), Snapshot.canonicalIdbKeyJson(1), 'IDB key types must be preserved');
  assert.strictEqual(Snapshot.canonicalIdbKeyJson(-0), Snapshot.canonicalIdbKeyJson(0), 'IDB numeric zero has one canonical representation');
  console.log('PASS target snapshot manifest synthetic checks');
}

run().catch(error => {
  process.stderr.write('FAIL ' + String(error && error.stack || error) + '\n');
  process.exitCode = 1;
});
