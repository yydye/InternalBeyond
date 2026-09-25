'use strict';

/* P32-W.5-R3-B.3-P5.5 synthetic-only composite planner tests. */
const assert = require('assert');
const Planner = require('../tmp/p32-w5-r3b/composite-recovery-planner.js');

const OLD = Planner.OLD_ROLE_ID;
const NEW = Planner.NEW_ROLE_ID;
const MEMORY = Planner.MEMORY_ID;
const PRIMARY_HASH = 'a'.repeat(64);
const ROLE_HASH = 'b'.repeat(64);
const MEMORY_SOURCE_HASH = 'c'.repeat(64);

function source(label, hash, extra) {
  return Object.assign({
    path: 'synthetic://' + label,
    size: 1234,
    sha256: hash,
    exportVersion: 8
  }, extra || {});
}
function verify(item) {
  return { ok: true, fileUnchanged: true, size: item.size, sha256: item.sha256, exportVersion: item.exportVersion };
}
function fixture() {
  const primary = {
    version: 8,
    apiConfigs: [],
    chatMessages: [{ id: 'message_1', role: 'user', content: 'Synthetic text mentions ' + OLD, friendId: OLD, timestamp: 1700000000000, threadId: 'thread_1' }],
    chatThreads: [{ id: 'thread_1', friendId: OLD, name: 'synthetic' }],
    groups: [{ id: 'group_1', name: 'synthetic', members: [{ characterId: OLD, status: 'active' }] }],
    memories: [{ id: 'memory_existing', characterId: OLD, content: 'synthetic memory' }],
    autoMemory: [{ id: 'auto_1', friendId: OLD, content: 'synthetic auto memory' }],
    diary_entries: [{ id: 'diary_1', characterId: OLD, relatedMemoryIds: [MEMORY], title: 'synthetic diary' }],
    moments: [{ id: 'moment_1', roleId: OLD, characterId: OLD, content: 'synthetic moment' }],
    roleLetters: [{ id: 'letter_1', fromRoleId: OLD, toRoleId: OLD, content: 'synthetic letter' }]
  };
  const roleRecord = {
    id: NEW,
    provider: 'synthetic-provider',
    model: 'synthetic-model',
    endpoint: 'https://example.invalid/v1',
    nickname: 'synthetic role',
    apiKey: 'SYNTHETIC_API_SECRET_SENTINEL',
    imageGenApiKey: 'SYNTHETIC_IMAGE_SECRET_SENTINEL'
  };
  const memoryRecord = { id: MEMORY, characterId: OLD, content: 'SYNTHETIC_MEMORY_BODY_SENTINEL', created: 1700000000000 };
  const primarySource = source('primary', PRIMARY_HASH);
  const roleSource = source('role-source', ROLE_HASH, { recordAlias: 'apiConfigs#000001' });
  const memorySource = source('memory-source', MEMORY_SOURCE_HASH, {
    recordAlias: 'memories#000001',
    recordSha256: Planner.stableRecordHash(memoryRecord)
  });
  return {
    primaryBackup: primary,
    primarySource,
    primaryVerification: verify(primarySource),
    roleRecord,
    roleSource,
    roleVerification: verify(roleSource),
    memoryRecord,
    memorySource,
    memoryVerification: verify(memorySource),
    expectedMemoryId: MEMORY,
    schemaVersion: 24,
    mapping: { oldId: OLD, newId: NEW, authority: 'USER_ASSERTED', status: 'EXPLICIT_USER_ASSERTION' }
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}

const first = Planner.buildCompositeDryRun(fixture());

check('supplemental NEW_ROLE closes old-role references', () => {
  assert.strictEqual(first.status, 'PASS');
  assert.strictEqual(first.planner.before.danglingReferences > 0, true);
  assert.strictEqual(first.planner.after.danglingReferences, 0);
  assert.strictEqual(first.planner.after.domainConflicts, 0);
});
check('supplemental memory closes missing memory identity', () => {
  assert.strictEqual(first.referentialVerification['diary_entries.relatedMemoryIds'].unresolved, 0);
  assert.strictEqual(first.domainCounts.composite.memories, first.domainCounts.primary.memories + 1);
});
check('supplemental memory old-role reference is migrated', () => {
  assert.strictEqual(first.referentialVerification['memories.characterId'].pass, true);
  assert.strictEqual(first.mapping.changedByField['memories.characterId'], 2);
});
check('mapping only touches approved identity-reference fields', () => {
  assert.deepStrictEqual(first.mapping.fieldsAllowed, Planner.REFERENCE_FIELDS.slice());
  assert.strictEqual(first.mapping.changedByField['chatMessages.friendId'], 1);
  assert.strictEqual(first.mapping.changedByField['groups.members[].characterId'], 1);
  assert.strictEqual(first.mapping.changedByField['moments.roleId'], 1);
  assert.strictEqual(first.mapping.changedByField['moments.characterId'], 1);
});
check('unrelated record IDs and reference fields remain unchanged', () => {
  assert.strictEqual(first.mapping.totalReferenceUpdates, 11);
  assert.strictEqual(first.referentialVerification['chatMessages.threadId'].checked, 1);
  const isolated = {
    apiConfigs: [{ id: OLD }],
    chatMessages: [{ id: 'message-id', friendId: OLD, threadId: 'thread-id', content: OLD }],
    groups: [{ id: 'group-id', members: [{ characterId: OLD }] }],
    memories: [{ id: 'memory-id', characterId: OLD }],
    diary_entries: [{ id: 'diary-id', characterId: OLD, relatedMemoryIds: ['memory-id'] }]
  };
  Planner.applyIdentitySuccession(isolated, OLD, NEW);
  assert.strictEqual(isolated.apiConfigs[0].id, OLD);
  assert.strictEqual(isolated.chatMessages[0].id, 'message-id');
  assert.strictEqual(isolated.chatMessages[0].threadId, 'thread-id');
  assert.strictEqual(isolated.chatMessages[0].content, OLD);
  assert.strictEqual(isolated.groups[0].id, 'group-id');
  assert.strictEqual(isolated.memories[0].id, 'memory-id');
  assert.deepStrictEqual(isolated.diary_entries[0].relatedMemoryIds, ['memory-id']);
  assert.strictEqual(first.safety.productionIndexedDbAccess, false);
  assert.ok(!JSON.stringify(first).includes('SYNTHETIC_MEMORY_BODY_SENTINEL'));
});
check('credential fields are stripped and output remains secret-free', () => {
  assert.strictEqual(first.credentialFirewall.status, 'PASS');
  assert.strictEqual(first.credentialFirewall.credentialBearingFieldsImported, 0);
  assert.strictEqual(first.credentialFirewall.apiConfigsStatus, 'NEEDS_REBIND');
  const serialized = JSON.stringify(first);
  assert.ok(!serialized.includes('SYNTHETIC_API_SECRET_SENTINEL'));
  assert.ok(!serialized.includes('SYNTHETIC_IMAGE_SECRET_SENTINEL'));
});
check('provenance is retained for every composite record', () => {
  assert.strictEqual(first.provenance.status, 'PASS');
  assert.strictEqual(first.provenance.recordCount, 10);
  assert.strictEqual(first.provenance.ranges.reduce((sum, item) => sum + item.recordCount, 0), 10);
  assert.ok(first.provenance.ranges.some((item) => item.source === 'SUPPLEMENTAL_ROLE_2026_09_03'));
  assert.ok(first.provenance.ranges.some((item) => item.source === 'SUPPLEMENTAL_MEMORY_2026_08_27'));
});
check('missing supplemental role fails closed', () => {
  const input = fixture(); input.roleRecord = null;
  const result = Planner.buildCompositeDryRun(input);
  assert.strictEqual(result.status, 'BLOCKED_COMPOSITE_PLAN');
  assert.ok(result.blockers.some((item) => item.includes('role record missing')));
});
check('missing supplemental memory fails closed', () => {
  const input = fixture(); input.memoryRecord = null;
  const result = Planner.buildCompositeDryRun(input);
  assert.strictEqual(result.status, 'BLOCKED_COMPOSITE_PLAN');
  assert.ok(result.blockers.some((item) => item.includes('memory record missing')));
});
check('wrong old/new succession cannot produce a ready plan', () => {
  const input = fixture(); input.mapping.oldId = 'friend_wrong_old_id';
  const result = Planner.buildCompositeDryRun(input);
  assert.strictEqual(result.status, 'BLOCKED_COMPOSITE_PLAN');
});
check('source hash mismatch fails closed', () => {
  const input = fixture(); input.roleVerification.sha256 = 'd'.repeat(64);
  const result = Planner.buildCompositeDryRun(input);
  assert.strictEqual(result.status, 'BLOCKED_COMPOSITE_PLAN');
  assert.ok(result.blockers.some((item) => item.includes('source hash/size/version')));
});
check('production IndexedDB capability is not accessed', () => {
  const previous = Object.getOwnPropertyDescriptor(global, 'indexedDB');
  Object.defineProperty(global, 'indexedDB', { configurable: true, get() { throw new Error('IndexedDB access forbidden in synthetic test'); } });
  try {
    const result = Planner.buildCompositeDryRun(fixture());
    assert.strictEqual(result.status, 'PASS');
    assert.strictEqual(result.safety.productionIndexedDbAccess, false);
  } finally {
    if (previous) Object.defineProperty(global, 'indexedDB', previous);
    else delete global.indexedDB;
  }
});
check('provider calls remain zero', () => {
  const priorFetch = global.fetch;
  let calls = 0;
  global.fetch = () => { calls++; throw new Error('provider/network call forbidden in synthetic test'); };
  try {
    const result = Planner.buildCompositeDryRun(fixture());
    assert.strictEqual(result.status, 'PASS');
    assert.strictEqual(calls, 0);
    assert.strictEqual(result.safety.providerCalls, 0);
  } finally {
    if (priorFetch) global.fetch = priorFetch;
    else delete global.fetch;
  }
});

console.log('PASS ' + passed + ' P32-W.5 composite synthetic checks');
