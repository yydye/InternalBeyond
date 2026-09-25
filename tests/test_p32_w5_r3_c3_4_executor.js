'use strict';

/* C3.4 synthetic-only executor tests. No installed DB, IndexedDB, Tauri IPC,
   Home Node service, provider, credential store, or runtime binding is used. */
process.env.IB_P32_W5_C34_SYNTHETIC_TESTS = '1';

const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const Executor = require('../services/home-node/composite-reconstruction-executor.js');
const createCharacterProjectionStore = require('../services/home-node/character-projection-store.js');
const stableJson = Executor.testOnly.stableJson;
const stableHash = Executor.testOnly.stableHash;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => { passed++; console.log('OK   ' + name); }, error => {
        failed++; console.error('FAIL ' + name + ' — ' + String(error && error.stack || error));
      });
    }
    passed++; console.log('OK   ' + name);
  } catch (error) {
    failed++; console.error('FAIL ' + name + ' — ' + String(error && error.stack || error));
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hex(char) { return char.repeat(64); }
function record(id, extra) { return Object.assign({ id: id, kind: 'synthetic', marker: 'SYNTHETIC_ONLY' }, extra || {}); }

function makeFixture(options) {
  options = options || {};
  const planId = 'synthetic-plan-c34';
  const planSha256 = hex('a');
  const targetSnapshotSha256 = hex('b');
  const sourcePrimarySha256 = hex('c');
  const provenanceDigest = hex('d');
  const matrixSha = hex('e');
  const resolutionSha = hex('f');
  const c2ReportSha = hex('1');
  const homeTarget = { databaseName: 'synthetic-home-node.db', path: 'C:\\Synthetic\\home-node.db', c1ObservedDatabaseSha256: hex('2'),
    schemaUserVersion: 0, integrityCheck: 'ok', revalidationRequiredAtExecution: true };
  const sourceRecords = {
    chatMessages: [record('syn-msg-1'), record('syn-msg-2')],
    memories: [record('syn-mem-1')],
    moments: [record('syn-moment-1'), record('syn-moment-2')]
  };
  const tables = { chatMessages: 'messages', memories: 'memory_records', moments: 'moment_records' };
  const recordsByDomain = {};
  const proposalItems = [];
  for (const domain of Object.keys(sourceRecords)) {
    recordsByDomain[domain] = sourceRecords[domain].map(item => ({ stableKey: item.id, record: item }));
    for (const row of recordsByDomain[domain]) {
      proposalItems.push({
        table: tables[domain], operation: 'INSERT', stableKey: row.stableKey,
        source: { domain: domain, authority: 'synthetic verified source', planId: planId, recordSha256: stableHash(row.record) },
        targetExistence: 'ABSENT', precondition: { missingStableKey: true },
        conflictClassification: 'NO_CONFLICT', reason: 'synthetic-only fixture'
      });
    }
  }
  const proposalArtifactSha256 = hex('3');
  const proposal = { items: proposalItems };
  const setA = {
    schema: 'internalbeyond.p32-w5.r3-c3.home-node-reconstruction-write-set', version: 1,
    operation: 'INSERT', writeSetSha256: '', proposalArtifactSha256: proposalArtifactSha256,
    insertSubsetCanonicalSha256: Executor.testOnly.stableInsertSubsetHash(proposalItems), rows: proposalItems.length,
    operationCounts: { INSERT: proposalItems.length, DEFER: 0, NOOP: 0 },
    counts: { messages: 2, memory_records: 1, moment_records: 2 },
    status: 'FROZEN_SYNTHETIC',
    proposalIdentity: { planId: planId, planSha256: planSha256, targetSnapshotSha256: targetSnapshotSha256, sourcePrimarySha256: sourcePrimarySha256 },
    authoritySource: { kind: 'synthetic source', provenanceRecordCount: 5, provenanceDigest: provenanceDigest },
    targetIdentity: homeTarget,
    existingPolicy: { messages: 'skip', memory_records: 'skip', moment_records: 'writeMigrated stable-ID skip' },
    forbiddenWrites: { characters: 0, character_runtime_specs: 0, update: 0, delete: 0 }
  };
  setA.writeSetSha256 = Executor.testOnly.hashWriteSetA(setA);

  const ids = ['synthetic-character-1', 'synthetic-character-2'];
  const beforeDtos = {
    [ids[0]]: { id: ids[0], name: 'Synthetic One', avatar: 'synthetic-avatar-1', relationship: 'synthetic relation', model: 'model-before', capabilities: { chat: true, stream: true, vision: false, webSearch: false, imageGen: true }, status: 'active' },
    [ids[1]]: { id: ids[1], name: 'Synthetic Two', avatar: 'synthetic-avatar-2', relationship: 'synthetic relation', model: 'model-two', capabilities: { chat: true, stream: false, vision: false, webSearch: false, imageGen: true }, status: 'active' }
  };
  const bRows = [
    {
      operation: 'UPDATE', table: 'characters', key: { id: ids[0] },
      fieldPaths: ['characters.dto_json.model'],
      expectedCurrentProjectionSha256: stableHash(beforeDtos[ids[0]]), expectedAuthorityProjectionSha256: hex('4'),
      beforeValues: { model: 'model-before' }, afterValues: { model: 'model-after' },
      fieldAuthority: { model: 'AUTHORITATIVE_WEB_CORE' },
      preserveUnchangedFields: ['id', 'dto_json.name', 'dto_json.avatar', 'dto_json.relationship']
    },
    {
      operation: 'UPDATE', table: 'characters', key: { id: ids[1] },
      fieldPaths: ['characters.dto_json.capabilities'],
      expectedCurrentProjectionSha256: stableHash(beforeDtos[ids[1]]), expectedAuthorityProjectionSha256: hex('5'),
      beforeValues: { capabilities: { chat: true, stream: false, vision: false, webSearch: false, imageGen: true } },
      afterValues: { capabilities: { chat: true, stream: false, vision: true, webSearch: false, imageGen: false } },
      fieldAuthority: { capabilities: 'DERIVED_RUNTIME_PROJECTION' },
      preserveUnchangedFields: ['id', 'dto_json.name', 'dto_json.avatar', 'dto_json.relationship']
    }
  ];
  if (options.forbiddenProjectionField) {
    bRows[0].fieldPaths = ['characters.dto_json.name'];
    bRows[0].beforeValues = { name: 'Synthetic One' };
    bRows[0].afterValues = { name: 'Mutated Name' };
  }
  if (options.badBeforeDigest) bRows[0].expectedCurrentProjectionSha256 = hex('9');
  const setB = {
    schema: 'internalbeyond.p32-w5.r3-c3.character-projection-write-set', version: 1,
    status: 'DESIGN_ONLY_NOT_APPROVED', writeSetSha256: '',
    proposalIdentity: { planId: planId, planSha256: planSha256, targetSnapshotSha256: targetSnapshotSha256, sourcePrimarySha256: sourcePrimarySha256 },
    targetIdentity: homeTarget,
    authoritySource: { authorityMatrixSha256: matrixSha, conflictResolutionSha256: resolutionSha, c2ReportSha256: c2ReportSha, sourcePrimarySha256: sourcePrimarySha256 },
    operation: 'UPDATE', table: 'characters', storageColumn: 'dto_json', rows: bRows,
    rowCount: bRows.length, fieldAssignmentCounts: { model: 1, capabilities: 1, total: 2 }, updateCount: bRows.length, deleteCount: 0,
    runtimeBoundary: { character_runtime_specs: 'DEFER', specJsonRead: false, specJsonWrite: false, runtimeBindingChanged: false }
  };
  setB.writeSetSha256 = Executor.testOnly.hashWriteSetB(setB);

  const bundle = {
    schema: 'internalbeyond.p32-w5.r3-c3.composite-reconstruction-bundle', version: 1,
    planIdentity: { planId: planId, planSha256: planSha256, targetSnapshotSha256: targetSnapshotSha256, sourcePrimarySha256: sourcePrimarySha256, provenanceRecordCount: 5, provenanceDigest: provenanceDigest },
    c2Authority: { matrixSha256: matrixSha, conflictResolutionSha256: resolutionSha, c2ReportSha256: c2ReportSha },
    targetHomeNodeIdentity: homeTarget,
    provenance: { recordCount: 5, traceDigest: provenanceDigest, sourcePrimarySha256: sourcePrimarySha256 },
    writeSets: {
      A: { schema: setA.schema, writeSetSha256: setA.writeSetSha256, frozenProposalArtifactSha256: proposalArtifactSha256, insertSubsetCanonicalSha256: setA.insertSubsetCanonicalSha256, rows: proposalItems.length, operation: 'INSERT' },
      B: { schema: setB.schema, writeSetSha256: setB.writeSetSha256, rows: bRows.length, operation: 'UPDATE', table: 'characters', storageColumn: 'dto_json', fieldPaths: ['characters.dto_json.capabilities', 'characters.dto_json.model'] }
    },
    totalMutationBudget: { INSERT: proposalItems.length, UPDATE: bRows.length, DELETE: 0 },
    executionOrder: ['A_PRECHECK_AND_APPLY', 'A_READBACK_VERIFY_ALL_500', 'B_PRECHECK_ALL_8', 'B_SINGLE_TRANSACTION_UPDATE_8', 'B_READBACK_VERIFY_ALL_8', 'COMPOSITE_COMPLETE'],
    approvalPolicy: { type: 'EXPLICIT_COMPOSITE_RECONSTRUCTION_APPROVAL', userApprovalCount: 1 },
    runtimeBoundary: { character_runtime_specs: 'DEFER', specJsonRead: false, specJsonWrite: false, runtimeBindingChanged: false,
      providerRebind: false, providerCalls: 0, activeRearm: false }
  };
  const contract = {
    bundleId: 'synthetic-c3-bundle', bundleHash: stableHash(bundle),
    planId: planId, planSha256: planSha256, targetSnapshotSha256: targetSnapshotSha256, sourcePrimarySha256: sourcePrimarySha256,
    provenanceRecordCount: 5, provenanceDigest: provenanceDigest,
    authorityMatrixSha256: matrixSha, conflictResolutionSha256: resolutionSha, c2ReportSha256: c2ReportSha,
    homeNodeTarget: homeTarget,
    writeSetA: { schema: setA.schema, writeSetSha256: setA.writeSetSha256, proposalArtifactSha256: proposalArtifactSha256, insertSubsetSha256: setA.insertSubsetCanonicalSha256, rows: proposalItems.length, operationCounts: setA.operationCounts, counts: setA.counts },
    writeSetB: { schema: setB.schema, writeSetSha256: setB.writeSetSha256, rows: bRows.length, modelAssignments: 1, capabilityAssignments: 1, ids: ids },
    mutationBudget: { INSERT: proposalItems.length, UPDATE: bRows.length, DELETE: 0 }
  };
  const approval = { type: 'EXPLICIT_COMPOSITE_RECONSTRUCTION_APPROVAL', bundleHash: contract.bundleHash, writeSetAHash: setA.writeSetSha256, writeSetBHash: setB.writeSetSha256, planId: planId, targetSnapshotSha256: targetSnapshotSha256, oneUse: true, synthetic: true };
  return { bundle: bundle, bundleHash: contract.bundleHash, contract: contract, writeSetA: setA, writeSetB: setB,
    proposal: proposal, proposalArtifactSha256: proposalArtifactSha256,
    recordsByDomain: recordsByDomain, beforeDtos: beforeDtos, approval: approval };
}

function createFakeHomeNodeAdapter(fixture, options) {
  options = options || {};
  const tables = { chatMessages: new Map(), memories: new Map(), moments: new Map() };
  const callLog = [];
  for (const domain of Object.keys(fixture.recordsByDomain)) {
    if (options.preexisting === 'identical' && domain === 'chatMessages') {
      const row = fixture.recordsByDomain[domain][0];
      tables[domain].set(row.stableKey, stableHash(row.record));
    } else if (options.preexisting === 'conflict' && domain === 'chatMessages') {
      const row = fixture.recordsByDomain[domain][0];
      tables[domain].set(row.stableKey, hex('8'));
    }
  }
  function apply(domain, rows, opts) {
    callLog.push({ method: 'insert', domain: domain, count: rows.length, policy: opts.existingPolicy });
    if (opts.existingPolicy !== 'skip') throw new Error('existingPolicy must be skip');
    if (options.failDomain === domain) throw Object.assign(new Error('synthetic A failure'), { code: 'SYNTHETIC_A_FAILURE' });
    let created = 0; let skipped = 0;
    for (const row of rows) {
      const key = row.id;
      const digest = stableHash(row);
      if (tables[domain].has(key)) {
        if (tables[domain].get(key) !== digest) throw Object.assign(new Error('synthetic duplicate conflict'), { code: 'SYNTHETIC_DUPLICATE_CONFLICT' });
        skipped++;
      } else { tables[domain].set(key, digest); created++; }
    }
    return { ok: true, summary: { created: created, skipped: skipped, updated: 0, deleted: 0 } };
  }
  return {
    callLog: callLog, tables: tables,
    async getEnvironmentSnapshot() { return { recoveryOnly: true, normalRuntimeStopped: true, activeQuarantined: true, consumedMarkerPresent: false, providerCalls: 0, specJsonRead: false }; },
    async getTargetIdentity() { return fixture.contract.homeNodeTarget; },
    async verifyCompositeApproval(approval, _bundle, bundleHash) { return approval && approval.synthetic === true && approval.bundleHash === bundleHash; },
    async classifyExistingRecords(domain, rows) {
      return rows.map(row => {
        const existing = tables[domain].get(row.stableKey);
        return { stableKey: row.stableKey, status: existing == null ? 'absent' : (existing === row.sourceRecordSha256 ? 'identical' : 'conflict') };
      });
    },
    async putMessages(rows, opts) { return apply('chatMessages', rows, opts); },
    async putMemoryRecords(rows, opts) { return apply('memories', rows, opts); },
    async writeMigratedMoment(row, opts) {
      callLog.push({ method: 'insert', domain: 'moments', stableKey: row.id, requestId: opts.requestId });
      if (options.failDomain === 'moments') throw Object.assign(new Error('synthetic moment failure'), { code: 'SYNTHETIC_A_FAILURE' });
      const digest = stableHash(row); const old = tables.moments.get(row.id);
      if (old && old !== digest) return { ok: false, outcome: 'conflict' };
      if (old) return { ok: true, outcome: 'skipped' };
      tables.moments.set(row.id, digest); return { ok: true, outcome: 'created' };
    },
    async readbackDomainRecordDigests(domain, expected) {
      return expected.map(row => {
        const actual = tables[domain].get(row.stableKey);
        const mismatch = options.failReadbackDomain === domain;
        return { stableKey: row.stableKey, sourceRecordSha256: mismatch ? hex('7') : actual,
          verified: !mismatch && actual === row.sourceRecordSha256 };
      });
    },
    async verifyReferencesAndProvenance() { return { ok: true, provenanceRecordCount: fixture.contract.provenanceRecordCount, provenanceDigest: fixture.contract.provenanceDigest }; }
  };
}

function createFakeProjectionStore(initial, options) {
  options = options || {};
  const state = new Map(Object.entries(clone(initial)));
  const calls = { reads: 0, applies: 0, getCharacterSpec: 0 };
  const store = {
    calls: calls,
    async readCharacterDtoProjections(ids) {
      calls.reads++;
      return { ok: true, rows: ids.map(id => {
        if (!state.has(id)) return { id: id, exists: false, dto: null, dtoSha256: null };
        const dto = clone(state.get(id));
        if (options.lieAfterApplyRead && calls.reads > 1) dto.model = 'synthetic-unexpected-readback';
        return { id: id, exists: true, dto: dto, dtoSha256: stableHash(dto) };
      }) };
    },
    async applyCharacterDtoProjectionBatch(updates) {
      calls.applies++;
      const snapshot = new Map(Array.from(state.entries()).map(([id, dto]) => [id, clone(dto)]));
      try {
        for (let i = 0; i < updates.length; i++) {
          const update = updates[i];
          const current = state.get(update.id);
          if (!current || stableHash(current) !== update.expectedBeforeDtoSha256) throw Object.assign(new Error('before digest'), { code: 'SYNTHETIC_BEFORE_DIGEST' });
          if (options.failAtIndex === i) throw Object.assign(new Error('synthetic SQLite transaction failure'), { code: 'SYNTHETIC_B_ROLLBACK' });
          state.set(update.id, clone(update.nextDto));
        }
        return { ok: true, updated: updates.length, deleted: 0 };
      } catch (error) {
        state.clear(); for (const [id, dto] of snapshot.entries()) state.set(id, dto);
        error.transactionRolledBack = true;
        throw error;
      }
    },
    snapshot: () => Object.fromEntries(Array.from(state.entries()).map(([id, dto]) => [id, clone(dto)]))
  };
  Object.defineProperty(store, 'getCharacterSpec', { get() { calls.getCharacterSpec++; throw new Error('spec-read-forbidden'); } });
  return store;
}

function makeApproval(fixture) { return fixture.approval; }
function makeExecutor(fixture, adapterOptions, projectionStore) {
  const adapter = createFakeHomeNodeAdapter(fixture, adapterOptions);
  const store = projectionStore || createFakeProjectionStore(fixture.beforeDtos);
  const executor = Executor.testOnly.createSyntheticExecutor({ contract: fixture.contract, homeNodeAdapter: adapter, projectionStore: store });
  return { executor: executor, adapter: adapter, store: store };
}

function makeSqliteProjectionStore(fixture, triggerId) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE characters (id TEXT PRIMARY KEY, dto_json TEXT NOT NULL, for_turn INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)');
  const insert = db.prepare('INSERT INTO characters (id,dto_json,for_turn,updated_at) VALUES (?,?,0,0)');
  for (const [id, dto] of Object.entries(fixture.beforeDtos)) insert.run(id, JSON.stringify(dto));
  if (triggerId) {
    db.exec("CREATE TRIGGER synthetic_projection_abort BEFORE UPDATE ON characters WHEN OLD.id='" + triggerId + "' BEGIN SELECT RAISE(ABORT, 'synthetic projection abort'); END");
  }
  const rawStore = createCharacterProjectionStore(db);
  return {
    db: db,
    store: {
      readCharacterDtoProjections(ids) { return { ok: true, rows: rawStore.readCharacterDtoProjections(ids) }; },
      applyCharacterDtoProjectionBatch(updates) { return rawStore.applyCharacterDtoProjectionBatch(updates); }
    },
    rawStore: rawStore
  };
}

async function main() {
  const tests = [];
  const add = (name, fn) => tests.push({ name: name, fn: fn });

  add('bundle hash validation fails before writes', async () => {
    const f = makeFixture(); const env = makeExecutor(f);
    const badBundle = clone(f.bundle); badBundle.totalMutationBudget.DELETE = 1;
    await assert.rejects(() => env.executor.execute(Object.assign({}, f, { bundle: badBundle })), /C34_BUNDLE_HASH_MISMATCH/);
    assert.strictEqual(env.adapter.callLog.length, 0);
    assert.strictEqual(env.store.calls.applies, 0);
  });

  add('WriteSet A exact INSERT validation rejects UPDATE and extra keys', async () => {
    const f = makeFixture(); const env = makeExecutor(f);
    const bad = clone(f.proposal); bad.items[0].operation = 'UPDATE';
    await assert.rejects(() => env.executor.execute(Object.assign({}, f, { proposal: bad })), /C34_FORBIDDEN_SET_A_OPERATION/);
    assert.strictEqual(env.adapter.callLog.length, 0);
  });

  add('WriteSet B field allowlist is checked before A starts', async () => {
    const f = makeFixture({ forbiddenProjectionField: true }); const env = makeExecutor(f);
    await assert.rejects(() => env.executor.execute(f), /C34_SET_B_FORBIDDEN_FIELD_OR_TABLE/);
    assert.strictEqual(env.adapter.callLog.length, 0);
    assert.strictEqual(env.store.calls.applies, 0);
  });

  add('WriteSet B exact stable ID set rejects a substituted ID', async () => {
    const f = makeFixture();
    f.writeSetB.rows[0].key.id = 'synthetic-character-extra';
    f.writeSetB.writeSetSha256 = Executor.testOnly.hashWriteSetB(f.writeSetB);
    f.bundle.writeSets.B.writeSetSha256 = f.writeSetB.writeSetSha256;
    f.contract.writeSetB.writeSetSha256 = f.writeSetB.writeSetSha256;
    f.contract.bundleHash = stableHash(f.bundle);
    f.bundleHash = f.contract.bundleHash;
    f.approval.bundleHash = f.contract.bundleHash;
    f.approval.writeSetBHash = f.writeSetB.writeSetSha256;
    const env = makeExecutor(f);
    await assert.rejects(() => env.executor.execute(f), /C34_SET_B_ID_SET_INVALID/);
    assert.strictEqual(env.adapter.callLog.length, 0);
    assert.strictEqual(env.store.calls.applies, 0);
  });

  add('A success validates exact keys, duplicate policy, readback, then SQLite B commits', async () => {
    const f = makeFixture();
    const sqlite = makeSqliteProjectionStore(f);
    const env = makeExecutor(f, {}, sqlite.store);
    const result = await env.executor.execute(f);
    assert.strictEqual(result.status, 'COMPOSITE_VERIFIED');
    assert.strictEqual(result.setA.inserted, 5);
    assert.strictEqual(result.setB.updated, 2);
    assert.strictEqual(result.setB.rows.length, 2);
    for (const row of result.setB.rows) {
      assert.match(row.beforeDtoSha256, /^[a-f0-9]{64}$/);
      assert.match(row.afterDtoSha256, /^[a-f0-9]{64}$/);
      assert.notStrictEqual(row.beforeDtoSha256, row.afterDtoSha256);
    }
    assert.ok(env.adapter.callLog.every(call => call.domain === 'moments' || call.policy === 'skip'));
    const after = sqlite.rawStore.readCharacterDtoProjections(Object.keys(f.beforeDtos));
    for (const row of after) assert.strictEqual(stableHash(row.dto), result.setB.rows.find(item => item.id === row.id).afterDtoSha256);
    sqlite.db.close();
  });

  add('A failure stops before B and records partial stage state', async () => {
    const f = makeFixture(); const env = makeExecutor(f, { failDomain: 'memories' });
    await assert.rejects(async () => {
      try { await env.executor.execute(f); } catch (error) {
        assert.strictEqual(error.executionState.status, 'A_FAILED_OR_PARTIAL_B_NOT_STARTED');
        assert.strictEqual(error.executionState.setB, null);
        assert.strictEqual(error.executionState.setA.inserted, 2);
        throw error;
      }
    }, error => error.code === 'SYNTHETIC_A_FAILURE');
    assert.strictEqual(env.store.calls.applies, 0);
    assert.strictEqual(env.adapter.callLog.filter(call => call.domain === 'moments').length, 0);
  });

  add('A readback digest mismatch stops after recording inserted rows; B never starts', async () => {
    const f = makeFixture(); const env = makeExecutor(f, { failReadbackDomain: 'chatMessages' });
    await assert.rejects(async () => {
      try { await env.executor.execute(f); } catch (error) {
        assert.strictEqual(error.executionState.status, 'A_FAILED_OR_PARTIAL_B_NOT_STARTED');
        assert.strictEqual(error.executionState.setA.inserted, 2);
        assert.strictEqual(error.executionState.setA.domains.chatMessages.inserted, 2);
        assert.strictEqual(error.executionState.setA.domains.chatMessages.readbackVerified, false);
        throw error;
      }
    }, /C34_DOMAIN_READBACK_DIGEST_MISMATCH/);
    assert.strictEqual(env.store.calls.applies, 0);
  });

  add('B SQLite transaction failure rolls back only B; A remains verified', async () => {
    const f = makeFixture();
    const sqlite = makeSqliteProjectionStore(f, 'synthetic-character-2');
    const env = makeExecutor(f, {}, sqlite.store);
    await assert.rejects(async () => {
      try { await env.executor.execute(f); } catch (error) {
        assert.strictEqual(error.executionState.status, 'A_VERIFIED_B_ROLLED_BACK');
        assert.strictEqual(error.executionState.setA.status, 'A_VERIFIED');
        throw error;
      }
    }, /synthetic projection abort/);
    const after = sqlite.store.readCharacterDtoProjections(Object.keys(f.beforeDtos));
    assert.strictEqual(after.ok, true);
    for (const row of after.rows) assert.strictEqual(stableHash(row.dto), stableHash(f.beforeDtos[row.id]));
    assert.strictEqual(env.adapter.callLog.filter(call => call.method === 'insert').length > 0, true);
    assert.strictEqual(env.adapter.tables.chatMessages.size, 2);
    sqlite.db.close();
  });

  add('B before-digest mismatch records the verified partial A state and leaves B untouched', async () => {
    const f = makeFixture({ badBeforeDigest: true }); const env = makeExecutor(f);
    await assert.rejects(async () => {
      try { await env.executor.execute(f); } catch (error) {
        assert.strictEqual(error.executionState.status, 'PARTIAL_A_VERIFIED_B_NOT_STARTED');
        assert.strictEqual(error.executionState.setA.status, 'A_VERIFIED');
        assert.strictEqual(error.executionState.partialCommitted.setA, 'VERIFIED');
        throw error;
      }
    }, /C34_PROJECTION_BEFORE_DIGEST_MISMATCH/);
    assert.ok(env.adapter.callLog.length > 0);
    assert.strictEqual(env.adapter.tables.chatMessages.size, 2);
    assert.strictEqual(env.store.calls.applies, 0);
  });

  add('post-commit B readback mismatch stops without compensating either write set', async () => {
    const f = makeFixture(); const env = makeExecutor(f, {}, createFakeProjectionStore(f.beforeDtos, { lieAfterApplyRead: true }));
    await assert.rejects(async () => {
      try { await env.executor.execute(f); } catch (error) {
        assert.strictEqual(error.executionState.status, 'A_VERIFIED_B_COMMITTED_READBACK_FAILED');
        assert.deepStrictEqual(error.executionState.partialCommitted, { setA: 'VERIFIED', setB: 'COMMITTED_UNVERIFIED' });
        throw error;
      }
    }, /C34_PROJECTION_AFTER_DIGEST_MISMATCH/);
    assert.strictEqual(env.adapter.tables.chatMessages.size, 2);
    assert.strictEqual(env.store.calls.applies, 1);
  });

  add('forbidden DTO field mutation is rejected by the DTO-only SQLite store', async () => {
    const f = makeFixture();
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE characters (id TEXT PRIMARY KEY, dto_json TEXT NOT NULL, for_turn INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)');
    const id = 'synthetic-character-1'; const before = f.beforeDtos[id];
    db.prepare('INSERT INTO characters (id,dto_json) VALUES (?,?)').run(id, JSON.stringify(before));
    const store = createCharacterProjectionStore(db);
    const next = Object.assign({}, before, { name: 'forbidden synthetic change' });
    assert.throws(() => store.applyCharacterDtoProjectionBatch([{
      id: id, fieldPaths: ['characters.dto_json.name'], nextDto: next,
      expectedBeforeDtoSha256: stableHash(before), expectedAfterDtoSha256: stableHash(next)
    }]), /CHARACTER_PROJECTION_FORBIDDEN_FIELD|CHARACTER_PROJECTION_FIELD_SET_MISMATCH/);
    const reread = store.readCharacterDtoProjections([id]);
    assert.strictEqual(stableHash(reread[0].dto), stableHash(before));
    db.close();
  });

  add('runtime spec access is denied by the executor boundary', async () => {
    const f = makeFixture(); const env = makeExecutor(f);
    const result = await env.executor.execute(f);
    assert.strictEqual(result.status, 'COMPOSITE_VERIFIED');
    assert.strictEqual(env.store.calls.getCharacterSpec, 0);
    assert.strictEqual(result.setB.updated, 2);
  });

  add('duplicate protection skips identical rows and blocks conflicting rows', async () => {
    const identical = makeFixture(); const env1 = makeExecutor(identical, { preexisting: 'identical' });
    const result = await env1.executor.execute(identical);
    assert.strictEqual(result.status, 'COMPOSITE_VERIFIED');
    assert.strictEqual(result.setA.alreadyPresent, 1);
    assert.strictEqual(result.setA.inserted, 4);

    const conflict = makeFixture(); const env2 = makeExecutor(conflict, { preexisting: 'conflict' });
    await assert.rejects(() => env2.executor.execute(conflict), /C34_DUPLICATE_CONTENT_CONFLICT/);
    assert.strictEqual(env2.adapter.callLog.length, 0);
    assert.strictEqual(env2.store.calls.applies, 0);
  });

  for (const item of tests) {
    try { await item.fn(); console.log('OK   ' + item.name); }
    catch (error) { failed++; console.error('FAIL ' + item.name + ' — ' + String(error && error.stack || error)); }
  }
  passed = tests.length - failed;
  console.log('RESULT ' + passed + ' passed / ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error('FATAL ' + String(error && error.stack || error)); process.exitCode = 1; });
