'use strict';

/* Synthetic-only C3.5 contract and dry-run coverage. No production DB, Vault,
   WebView, provider, host process, approval issuer, checkpoint, or network. */
process.env.IB_P32_W5_C35_SYNTHETIC_TESTS = '1';
process.env.IB_P32_W5_C34_SYNTHETIC_TESTS = '1';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const Executor = require('../services/home-node/composite-reconstruction-executor.js');
const AdapterModule = require('../services/home-node/production-reconstruction-adapter.js');
const Approval = require('../services/home-node/composite-reconstruction-approval.js');
const Runner = require('../services/home-node/reconstruction-runner.js');
const createChatStore = require('../services/home-node/chat-store.js');
const createMemoryStore = require('../services/home-node/memory-store.js');
const createMomentsStore = require('../services/home-node/moments-store.js');
const createDeviceRegistry = require('../services/home-node/device-registry.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.then(() => {
      passed++; console.log('OK   ' + name);
    }, error => { failed++; console.error('FAIL ' + name + ' — ' + String(error && error.stack || error)); });
    passed++; console.log('OK   ' + name);
  } catch (error) { failed++; console.error('FAIL ' + name + ' — ' + String(error && error.stack || error)); }
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function hex(char) { return char.repeat(64); }
function stableHash(value) { return Executor.stableHash(value); }
function frozenInputs() {
  const root = path.join(__dirname, '..', 'services', 'home-node', 'reconstruction-contracts', 'p32-w5-r3c3');
  const files = AdapterModule.ARTIFACT_FILES;
  const artifacts = {};
  const hashes = {};
  for (const key of Object.keys(files)) {
    const bytes = fs.readFileSync(path.join(root, files[key]));
    artifacts[key] = JSON.parse(bytes.toString('utf8'));
    hashes[key === 'authorityMatrix' ? 'authorityMatrix' : key === 'conflictResolution' ? 'conflictResolution' : key === 'c2Report' ? 'c2Report' : key === 'proposal' ? 'proposal' : key] =
      crypto.createHash('sha256').update(bytes).digest('hex');
  }
  return { artifacts: artifacts, hashes: hashes };
}
function fakeTargetStores(ids, dtos, counters) {
  counters = counters || { writes: 0, specReads: 0, providerCalls: 0, secretReads: 0 };
  const stores = {
    chat: { getMessage() { return null; } },
    memory: { getRecord() { return null; } },
    moments: { getRecordAny() { return null; } },
    devices: {
      readCharacterDtoProjections(requested) {
        return { ok: true, rows: requested.map(id => Object.prototype.hasOwnProperty.call(dtos || {}, id)
          ? { id: id, exists: true, dto: clone(dtos[id]), dtoSha256: stableHash(dtos[id]) }
          : { id: id, exists: false, dto: null, dtoSha256: null }) };
      }
    }
  };
  Object.defineProperty(stores.devices, 'getCharacterSpec', { get() { counters.specReads++; throw new Error('runtime spec access forbidden'); } });
  return stores;
}

function syntheticDryRunFixture() {
  const planId = 'synthetic-c35-plan';
  const planSha256 = hex('a');
  const targetSnapshotSha256 = hex('b');
  const sourcePrimarySha256 = hex('c');
  const provenanceDigest = hex('d');
  const matrixSha256 = hex('e');
  const resolutionSha256 = hex('f');
  const c2ReportSha256 = hex('1');
  const proposalArtifactSha256 = hex('2');
  const target = { databaseName: 'synthetic-home-node.db', path: 'C:\Synthetic\home-node.db',
    c1ObservedDatabaseSha256: hex('3'), schemaUserVersion: 0, integrityCheck: 'ok', revalidationRequiredAtExecution: true };
  const domains = [
    { domain: 'chatMessages', table: 'messages', count: 341 },
    { domain: 'memories', table: 'memory_records', count: 4 },
    { domain: 'moments', table: 'moment_records', count: 155 }
  ];
  const items = [];
  const id = domain => 'synthetic-' + domain + '-' + String(items.filter(row => row.source.domain === domain).length).padStart(3, '0');
  for (const entry of domains) for (let i = 0; i < entry.count; i++) {
    const key = entry.domain + '-' + String(i).padStart(3, '0');
    items.push({ table: entry.table, operation: 'INSERT', stableKey: key,
      source: { domain: entry.domain, authority: 'synthetic', planId: planId, recordSha256: hex('4') },
      targetExistence: 'ABSENT', precondition: { missingStableKey: true },
      conflictClassification: 'NO_CONFLICT', reason: 'synthetic-only' });
  }
  const proposal = { schema: 'synthetic-proposal', version: 1, planId: planId,
    operationCounts: { INSERT: 500 }, items: items, sourceRecordBodiesIncluded: false, secretValuesIncluded: false };
  const setA = {
    schema: 'internalbeyond.p32-w5.r3-c3.home-node-reconstruction-write-set', version: 1,
    operation: 'INSERT', writeSetSha256: '', frozenProposalArtifactSha256: proposalArtifactSha256,
    insertSubsetCanonicalSha256: Executor.testOnly.stableInsertSubsetHash(items), rows: 500,
    operationCounts: { INSERT: 500, DEFER: 0, NOOP: 0 },
    counts: { messages: 341, memory_records: 4, moment_records: 155 },
    existingPolicy: { messages: 'skip', memory_records: 'skip', moment_records: 'writeMigrated stable-ID skip' },
    authoritySource: { kind: 'synthetic', planId: planId, provenanceCount: 539, provenanceDigest: provenanceDigest },
    targetIdentity: target, forbiddenWrites: { characters: 0, character_runtime_specs: 0, update: 0, delete: 0 },
    status: 'SYNTHETIC',
    proposalIdentity: { planId: planId, planSha256: planSha256, targetSnapshotSha256: targetSnapshotSha256,
      sourcePrimarySha256: sourcePrimarySha256, provenanceRecordCount: 539, provenanceDigest: provenanceDigest }
  };
  setA.writeSetSha256 = Executor.testOnly.hashWriteSetA(setA);
  const characterIds = Array.from({ length: 8 }, (_, i) => 'synthetic-character-' + (i + 1));
  const dtos = {};
  const bRows = characterIds.map((characterId, i) => {
    dtos[characterId] = { id: characterId, name: 'Synthetic ' + (i + 1), avatar: 'avatar-' + (i + 1),
      relationship: 'synthetic', model: 'model-before',
      capabilities: { chat: true, stream: true, vision: false, webSearch: false } };
    return { operation: 'UPDATE', table: 'characters', key: { id: characterId },
      fieldPaths: ['characters.dto_json.model'], expectedCurrentProjectionSha256: stableHash(dtos[characterId]),
      expectedAuthorityProjectionSha256: hex('5'), beforeValues: { model: 'model-before' }, afterValues: { model: 'model-after' },
      fieldAuthority: { model: 'AUTHORITATIVE_WEB_CORE' },
      preserveUnchangedFields: ['id', 'dto_json.name', 'dto_json.avatar', 'dto_json.relationship'] };
  });
  const setB = { schema: 'internalbeyond.p32-w5.r3-c3.character-projection-write-set', version: 1,
    status: 'SYNTHETIC', writeSetSha256: '', proposalIdentity: { planId: planId, planSha256: planSha256,
      targetSnapshotSha256: targetSnapshotSha256, sourcePrimarySha256: sourcePrimarySha256,
      provenanceRecordCount: 539, provenanceDigest: provenanceDigest }, targetIdentity: target,
    authoritySource: { authorityMatrixSha256: matrixSha256, conflictResolutionSha256: resolutionSha256,
      c2ReportSha256: c2ReportSha256, sourcePrimarySha256: sourcePrimarySha256 },
    operation: 'UPDATE', table: 'characters', storageColumn: 'dto_json', rows: bRows, rowCount: 8,
    fieldAssignmentCounts: { model: 8, capabilities: 0, total: 8 }, updateCount: 8, deleteCount: 0,
    runtimeBoundary: { character_runtime_specs: 'DEFER', specJsonRead: false, specJsonWrite: false, runtimeBindingChanged: false } };
  setB.writeSetSha256 = Executor.testOnly.hashWriteSetB(setB);
  const bundle = { schema: 'internalbeyond.p32-w5.r3-c3.composite-reconstruction-bundle', version: 1,
    planIdentity: { planId: planId, planSha256: planSha256, targetSnapshotSha256: targetSnapshotSha256,
      sourcePrimarySha256: sourcePrimarySha256, provenanceRecordCount: 539, provenanceDigest: provenanceDigest },
    c2Authority: { matrixSha256: matrixSha256, conflictResolutionSha256: resolutionSha256, c2ReportSha256: c2ReportSha256 },
    targetHomeNodeIdentity: target,
    provenance: { recordCount: 539, traceDigest: provenanceDigest, sourcePrimarySha256: sourcePrimarySha256 },
    writeSets: {
      A: { schema: setA.schema, writeSetSha256: setA.writeSetSha256, frozenProposalArtifactSha256: proposalArtifactSha256,
        insertSubsetCanonicalSha256: setA.insertSubsetCanonicalSha256, rows: 500, operation: 'INSERT' },
      B: { schema: setB.schema, writeSetSha256: setB.writeSetSha256, rows: 8, operation: 'UPDATE',
        table: 'characters', storageColumn: 'dto_json', fieldPaths: ['characters.dto_json.capabilities', 'characters.dto_json.model'] }
    },
    totalMutationBudget: { INSERT: 500, UPDATE: 8, DELETE: 0 },
    executionOrder: ['A_PRECHECK_AND_APPLY', 'A_READBACK_VERIFY_ALL_500', 'B_PRECHECK_ALL_8',
      'B_SINGLE_TRANSACTION_UPDATE_8', 'B_READBACK_VERIFY_ALL_8', 'COMPOSITE_COMPLETE'],
    approvalPolicy: { type: 'EXPLICIT_COMPOSITE_RECONSTRUCTION_APPROVAL', userApprovalCount: 1 },
    runtimeBoundary: { character_runtime_specs: 'DEFER', specJsonRead: false, specJsonWrite: false,
      runtimeBindingChanged: false, providerCalls: 0, activeRearm: false }
  };
  const contract = {
    bundleId: 'synthetic-c35-bundle', bundleHash: stableHash(bundle),
    planId: planId, planSha256: planSha256, targetSnapshotSha256: targetSnapshotSha256,
    sourcePrimarySha256: sourcePrimarySha256, provenanceRecordCount: 539, provenanceDigest: provenanceDigest,
    authorityMatrixSha256: matrixSha256, conflictResolutionSha256: resolutionSha256, c2ReportSha256: c2ReportSha256,
    homeNodeTarget: target,
    writeSetA: { schema: setA.schema, writeSetSha256: setA.writeSetSha256,
      proposalArtifactSha256: proposalArtifactSha256, insertSubsetSha256: setA.insertSubsetCanonicalSha256,
      rows: 500, operationCounts: setA.operationCounts, counts: setA.counts },
    writeSetB: { schema: setB.schema, writeSetSha256: setB.writeSetSha256, rows: 8,
      modelAssignments: 8, capabilityAssignments: 0, ids: characterIds },
    mutationBudget: { INSERT: 500, UPDATE: 8, DELETE: 0 }
  };
  const activity = { productionWrites: 0, homeNodeWrites: 0, indexedDbWrites: 0, providerCalls: 0,
    secretAccess: 0, specJsonReads: 0, specJsonWrites: 0, approvalIssued: 0, checkpointCreated: 0, applyWindowOpened: 0 };
  const homeNode = {
    calls: { classify: 0, writes: 0 },
    async getEnvironmentSnapshot() { return { recoveryOnly: true, normalRuntimeStopped: true, activeQuarantined: true,
      consumedMarkerPresent: false, providerCalls: 0, secretAccess: false, specJsonRead: false, specJsonWrite: false,
      runtimeBindingChanged: false, providerBindingChanged: false }; },
    async getTargetIdentity() { return target; },
    async verifyProductionBindings() { return { ok: true, authorityArtifacts: { matrixSha256: matrixSha256,
      conflictResolutionSha256: resolutionSha256, c2ReportSha256: c2ReportSha256 } }; },
    async classifyExistingRecords(domain, rows) { this.calls.classify += rows.length; return rows.map(row => ({ stableKey: row.stableKey, status: 'absent' })); },
    async verifyReferencesAndProvenance() { return { ok: true, recordCount: 539, traceDigest: provenanceDigest,
      sourcePrimarySha256: sourcePrimarySha256 }; },
    async getActivityCounters() { return activity; },
    async putMessages() { this.calls.writes++; throw new Error('synthetic dry-run write denied'); },
    async putMemoryRecords() { this.calls.writes++; throw new Error('synthetic dry-run write denied'); },
    async writeMigratedMoment() { this.calls.writes++; throw new Error('synthetic dry-run write denied'); }
  };
  let specReads = 0;
  const projectionStore = {
    async readCharacterDtoProjections(ids) { return { ok: true, rows: ids.map(id => ({ id, exists: true, dto: clone(dtos[id]), dtoSha256: stableHash(dtos[id]) })) }; }
  };
  Object.defineProperty(projectionStore, 'getCharacterSpec', { get() { specReads++; throw new Error('spec_json prohibited'); } });
  return { contract, bundle, writeSetA: setA, writeSetB: setB, proposal, proposalArtifactSha256,
    recordsByDomain: null, dtos, homeNode, projectionStore, getSpecReads: () => specReads };
}

async function main() {
  const frozen = frozenInputs();
  const adapter = AdapterModule.testOnly.createSyntheticAdapter({ artifacts: frozen.artifacts, artifactHashes: frozen.hashes,
    stores: fakeTargetStores([], {}) });
  const goodBinding = { bundle: frozen.artifacts.bundle, bundleHash: Executor.FROZEN_CONTRACT.bundleHash,
    writeSetA: frozen.artifacts.writeSetA, writeSetB: frozen.artifacts.writeSetB,
    proposal: frozen.artifacts.proposal, proposalArtifactSha256: frozen.hashes.proposal };

  await check('correct frozen bundle and both write sets accepted', async () => {
    const result = await adapter.verifyProductionBindings(goodBinding);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.bundleSha256, Executor.FROZEN_CONTRACT.bundleHash);
  });
  await check('wrong bundle rejected', async () => {
    const input = clone(goodBinding); input.bundle.planIdentity.planSha256 = hex('9');
    assert.notStrictEqual((await adapter.verifyProductionBindings(input)).ok, true);
  });
  await check('wrong WriteSet A rejected', async () => {
    const input = clone(goodBinding); input.writeSetA.writeSetSha256 = hex('9');
    assert.notStrictEqual((await adapter.verifyProductionBindings(input)).ok, true);
  });
  await check('wrong WriteSet B rejected', async () => {
    const input = clone(goodBinding); input.writeSetB.writeSetSha256 = hex('9');
    assert.notStrictEqual((await adapter.verifyProductionBindings(input)).ok, true);
  });
  await check('wrong frozen proposal rejected', async () => {
    const input = clone(goodBinding); input.proposal.items[0].stableKey = 'tampered-key';
    assert.notStrictEqual((await adapter.verifyProductionBindings(input)).ok, true);
  });
  await check('wrong C2 authority artifact rejected', async () => {
    const originalHash = adapter.artifactHashes.authorityMatrix;
    adapter.artifactHashes.authorityMatrix = hex('9');
    assert.notStrictEqual((await adapter.verifyProductionBindings(goodBinding)).ok, true);
    adapter.artifactHashes.authorityMatrix = originalHash;
  });
  await check('wrong target identity rejected', async () => {
    const input = clone(goodBinding); input.writeSetA.targetIdentity.path = 'C:\\Synthetic\\other.db';
    assert.notStrictEqual((await adapter.verifyProductionBindings(input)).ok, true);
  });
  await check('wrong provenance identity rejected', async () => {
    const input = clone(goodBinding); input.bundle.provenance.traceDigest = hex('9');
    assert.notStrictEqual((await adapter.verifyProductionBindings(input)).ok, true);
  });
  await check('wrong mutation budget rejected', async () => {
    const input = clone(goodBinding); input.bundle.totalMutationBudget.UPDATE = 7;
    assert.notStrictEqual((await adapter.verifyProductionBindings(input)).ok, true);
  });
  await check('non-RecoveryOnly caller rejected', () => {
    assert.throws(() => new AdapterModule.ProductionReconstructionAdapter({ mode: 'NORMAL' }), /C35_NON_RECOVERY_CALLER_REJECTED/);
  });

  await check('composite approval nonce is one-use and replay is rejected', () => {
    const secretKey = Buffer.alloc(32, 7); const hostSessionId = 'synthetic-session'; const now = 1000000;
    const expected = AdapterModule.buildApprovalBindings(Executor.FROZEN_CONTRACT, Executor.FROZEN_CONTRACT.bundleHash);
    const approval = Approval.testOnly.issueSyntheticApproval(expected, { secretKey, hostSessionId,
      issuedAtUnixMs: now, expiresAtUnixMs: now + 30000, nonce: 'a'.repeat(32) });
    const verifier = Approval.createCompositeReconstructionApprovalVerifier({ secretKey, hostSessionId, now: () => now });
    assert.strictEqual(verifier.verifyAndConsume(approval, expected).consumed, true);
    assert.throws(() => verifier.verifyAndConsume(approval, expected), /C35_APPROVAL_REPLAY_REJECTED/);
  });
  await check('expired composite approval is rejected', () => {
    const secretKey = Buffer.alloc(32, 8); const hostSessionId = 'synthetic-session-expired'; const now = 2000000;
    const expected = AdapterModule.buildApprovalBindings(Executor.FROZEN_CONTRACT, Executor.FROZEN_CONTRACT.bundleHash);
    const approval = Approval.testOnly.issueSyntheticApproval(expected, { secretKey, hostSessionId,
      issuedAtUnixMs: now - 60000, expiresAtUnixMs: now - 1, nonce: 'b'.repeat(32) });
    const verifier = Approval.createCompositeReconstructionApprovalVerifier({ secretKey, hostSessionId, now: () => now });
    assert.throws(() => verifier.verifyAndConsume(approval, expected), /C35_APPROVAL_EXPIRED_OR_INVALID_TTL/);
  });

  await check('A dry-run validates exactly 500 keys and reports 341/4/155 without writes', async () => {
    const fixture = syntheticDryRunFixture();
    const executor = Executor.testOnly.createSyntheticExecutor({ contract: fixture.contract,
      homeNodeAdapter: fixture.homeNode, projectionStore: fixture.projectionStore });
    const report = await executor.dryRun({ bundle: fixture.bundle, bundleHash: fixture.contract.bundleHash,
      writeSetA: fixture.writeSetA, writeSetB: fixture.writeSetB, proposal: fixture.proposal,
      proposalArtifactSha256: fixture.proposalArtifactSha256 });
    assert.strictEqual(report.status, 'DRY_RUN_PASS');
    assert.strictEqual(report.reportType, 'PRODUCTION_RECONSTRUCTION_DRY_RUN');
    assert.strictEqual(report.writeSetA.planned, 500);
    assert.deepStrictEqual(report.writeSetA.operationCounts, { INSERT: 500, UPDATE: 0, DELETE: 0 });
    assert.deepStrictEqual(report.writeSetA.domains, {
      chatMessages: { planned: 341, absent: 341, identical: 0, conflict: 0 },
      memories: { planned: 4, absent: 4, identical: 0, conflict: 0 },
      moments: { planned: 155, absent: 155, identical: 0, conflict: 0 }
    });
    assert.strictEqual(report.writeSetB.planned, 8);
    assert.deepStrictEqual(report.writeSetB.operationCounts, { INSERT: 0, UPDATE: 8, DELETE: 0 });
    assert.strictEqual(fixture.homeNode.calls.classify, 500);
    assert.strictEqual(fixture.homeNode.calls.writes, 0);
    assert.strictEqual(fixture.getSpecReads(), 0);
    assert.strictEqual(report.activity.productionWrites, 0);
    assert.strictEqual(report.activity.homeNodeWrites, 0);
    assert.strictEqual(report.activity.indexedDbWrites, 0);
  });

  await check('Production adapter read-only attachment rejects writes and preserves synthetic DB bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-c35-readonly-'));
    const dbPath = path.join(root, 'home-node.db');
    const chat = createChatStore({ dbFile: dbPath, logger: () => {} });
    const memory = createMemoryStore({ dbFile: dbPath, logger: () => {} });
    const moments = createMomentsStore({ dbFile: dbPath, logger: () => {} });
    const devices = createDeviceRegistry({ dbFile: dbPath, logger: () => {} });
    try {
      chat.open(); memory.open(); moments.open(); devices.open();
      devices.putCharacters([{ id: 'synthetic-char', dto: { id: 'synthetic-char', name: 'Synthetic', model: 'm', capabilities: { chat: true, stream: true, vision: false, webSearch: false } }, spec: { synthetic: true } }]);
      devices.close(); moments.close(); memory.close(); chat.close();
      const before = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const roChat = createChatStore({ dbFile: dbPath, logger: () => {} });
        const roMemory = createMemoryStore({ dbFile: dbPath, logger: () => {} });
        const roMoments = createMomentsStore({ dbFile: dbPath, logger: () => {} });
        const roDevices = createDeviceRegistry({ dbFile: dbPath, logger: () => {} });
        roChat.attachReadOnlyConnection(db); roMemory.attachReadOnlyConnection(db); roMoments.attachReadOnlyConnection(db); roDevices.attachReadOnlyConnection(db);
        assert.strictEqual(roChat.readDatabaseIdentity().queryOnly, true);
        const dto = roDevices.readCharacterDtoProjections(['synthetic-char']);
        assert.strictEqual(dto.ok, true);
        assert.strictEqual(dto.rows[0].exists, true);
        const beforeDto = dto.rows[0].dto;
        const afterDto = Object.assign({}, beforeDto, { model: 'synthetic-next-model' });
        const blocked = roDevices.applyCharacterDtoProjectionBatch([{
          id: 'synthetic-char', fieldPaths: ['characters.dto_json.model'], nextDto: afterDto,
          expectedBeforeDtoSha256: stableHash(beforeDto), expectedAfterDtoSha256: stableHash(afterDto)
        }]);
        assert.strictEqual(blocked.ok, false);
        assert.strictEqual(blocked.code, 'CHARACTER_PROJECTION_READ_ONLY');
      } finally { db.close(); }
      const after = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
      assert.strictEqual(after, before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await check('spec_json and provider/credential/Vault modules are not accessed by the C3.5 adapter', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node', 'production-reconstruction-adapter.js'), 'utf8');
    assert.doesNotMatch(source, /require\s*\(\s*['"][^'"]*(?:credential|vault|provider|node-model-port)[^'"]*['"]\s*\)/i);
    assert.doesNotMatch(source, /SELECT\s+[^;]*spec_json/i);
    assert.strictEqual(frozen.artifacts.proposal.secretValuesIncluded, false);
    assert.strictEqual(frozen.artifacts.proposal.sourceRecordBodiesIncluded, false);
    const noProvider = AdapterModule.testOnly.createSyntheticAdapter({ artifacts: frozen.artifacts, artifactHashes: frozen.hashes,
      stores: fakeTargetStores([], {}) });
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = () => { fetchCalls++; throw new Error('provider/network path denied'); };
    try {
      const result = await noProvider.verifyProductionBindings({ bundle: frozen.artifacts.bundle,
        bundleHash: Executor.FROZEN_CONTRACT.bundleHash, writeSetA: frozen.artifacts.writeSetA,
        writeSetB: frozen.artifacts.writeSetB, proposal: frozen.artifacts.proposal,
        proposalArtifactSha256: frozen.hashes.proposal });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(fetchCalls, 0);
      assert.strictEqual(noProvider.activity.secretAccess, 0);
    } finally { global.fetch = originalFetch; }
  });

  await check('RecoveryOnly wiring registers dry-run command only in the RecoveryOnly handler and exposes no C3.5 apply mode', () => {
    const rust = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const recoveryBranch = rust.slice(rust.indexOf('let builder = if recovery_only'), rust.indexOf('} else if recovery_policy.blocked()'));
    const normalBranch = rust.slice(rust.indexOf('} else if recovery_policy.blocked()'), rust.indexOf('builder\n        .build'));
    assert.match(recoveryBranch, /p32_w5_r3_c3_5_reconstruction_dry_run/);
    assert.doesNotMatch(normalBranch, /p32_w5_r3_c3_5_reconstruction_dry_run/);
    assert.match(rust, /if state\.reconstruction_dry_run_only\s*\{\s*return Err\("C35_RECONSTRUCTION_DRYRUN_ONLY"/);
    assert.match(rust, /const C35_RECONSTRUCTION_REPORT_TYPE: &str = "PRODUCTION_RECONSTRUCTION_DRY_RUN"/);
    assert.doesNotMatch(rust, /C35_DRYRUN_REPORT_INVALID/);
    const nativeRunner = rust.slice(rust.indexOf('fn p32_w5_r3_c3_5_reconstruction_dry_run('), rust.indexOf('fn issue_recovery_restore_approval('));
    const nativeSpawnHelper = rust.slice(rust.indexOf('fn c35_spawn_native_child('), rust.indexOf('fn c35_native_spawn_context('));
    assert.match(nativeSpawnHelper, /\.stderr\(Stdio::piped\(\)\)/);
    assert.match(nativeRunner, /c35_spawn_native_child\(&node, &child_arguments, &root, Some\(&request_bytes\)\)/);
    assert.match(nativeRunner, /c35_check_runner_output\(/);
    assert.match(nativeRunner, /C35_RUNNER_STDOUT_INVALID_JSON/);
    const runner = require('../services/home-node/reconstruction-runner.js');
    assert.strictEqual(runner.DRY_RUN_ARG, '--p32w5-r3c3-c3.5-production-dry-run');
    assert.strictEqual(runner.REPORT_TYPE, 'PRODUCTION_RECONSTRUCTION_DRY_RUN');
  });

  await check('runner safe-failure envelope keeps frozen identities, typed activity counters, and a safe stage code', () => {
    const proof = { recoveryOnly: true, normalRuntimeStopped: true, activeQuarantined: true,
      consumedMarkerPresent: false, protectedPortsReleased: true, providerCalls: 0, secretAccess: false,
      specJsonRead: false, specJsonWrite: false, runtimeBindingChanged: false, providerBindingChanged: false };
    const report = Runner.safeFailure('C35_HOME_NODE_WAL_OR_SHM_PRESENT', {
      failureStage: 'adapter_open', nativeProof: proof
    });
    assert.strictEqual(report.schema, Runner.REPORT_SCHEMA);
    assert.strictEqual(report.reportType, Runner.REPORT_TYPE);
    assert.strictEqual(report.version, 1);
    assert.strictEqual(report.status, 'DRY_RUN_BLOCKED');
    assert.strictEqual(report.failureCode, 'C35_HOME_NODE_WAL_OR_SHM_PRESENT');
    assert.strictEqual(report.failureStage, 'adapter_open');
    assert.strictEqual(report.bundleIdentity.bundleSha256, Executor.FROZEN_CONTRACT.bundleHash);
    assert.strictEqual(report.writeSetIdentities.A, Executor.FROZEN_CONTRACT.writeSetA.writeSetSha256);
    assert.strictEqual(report.writeSetIdentities.B, Executor.FROZEN_CONTRACT.writeSetB.writeSetSha256);
    assert.deepStrictEqual(report.writeSetA.operationCounts, { INSERT: 500, UPDATE: 0, DELETE: 0 });
    assert.deepStrictEqual(report.writeSetB.operationCounts, { INSERT: 0, UPDATE: 8, DELETE: 0 });
    assert.strictEqual(report.activity.homeNodeWrites, 0);
    assert.strictEqual(report.activity.indexedDbWrites, 0);
    assert.strictEqual(report.runtimeBoundary.activeQuarantined, true);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.writeAllowed, false);
    assert.strictEqual(report.applyAllowed, false);
    assert.strictEqual(report.reasonCode, 'C35_HOME_NODE_WAL_OR_SHM_PRESENT');
  });

  await check('runner request version is explicit and wrong versions fail before adapter open', async () => {
    const proof = { recoveryOnly: true };
    const request = { schema: 'internalbeyond.p32-w5.r3-c3.5-recovery-only-dry-run-request',
      version: 2, mode: 'RECOVERY_ONLY_DRY_RUN', localAppData: 'synthetic', nativeProof: proof };
    const report = await Runner.runRecoveryOnlyDryRun([Runner.DRY_RUN_ARG], JSON.stringify(request));
    assert.strictEqual(report.status, 'DRY_RUN_BLOCKED');
    assert.strictEqual(report.failureCode, 'C35_NATIVE_PROOF_INVALID');
    assert.strictEqual(report.activity.homeNodeWrites, 0);
  });

  await check('runner bootstrap markers are fixed enums and bracket module, argument, adapter, and preflight stages', () => {
    const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'home-node', 'reconstruction-runner.js'), 'utf8');
    const markers = Runner.testOnly.bootstrapMarkers;
    assert.deepStrictEqual(markers, [
      'C35_BOOTSTRAP_STARTED', 'C35_BOOTSTRAP_MODULES_OK', 'C35_BOOTSTRAP_ARGS_OK',
      'C35_BOOTSTRAP_ARGS_REJECTED', 'C35_BOOTSTRAP_ADAPTER_BEGIN', 'C35_BOOTSTRAP_ADAPTER_OK',
      'C35_BOOTSTRAP_ADAPTER_FAILED', 'C35_BOOTSTRAP_PREFLIGHT_BEGIN', 'C35_BOOTSTRAP_PREFLIGHT_OK',
      'C35_BOOTSTRAP_PREFLIGHT_FAILED', 'C35_BOOTSTRAP_REQUEST_REJECTED', 'C35_BOOTSTRAP_MAIN_CAUGHT'
    ]);
    assert.match(runnerSource, /bootstrapMarker\('C35_BOOTSTRAP_STARTED'\)[\s\S]*?require\('path'\)/);
    assert.match(runnerSource, /bootstrapMarker\('C35_BOOTSTRAP_MODULES_OK'\)/);
    assert.match(runnerSource, /bootstrapMarker\('C35_BOOTSTRAP_ARGS_OK'\)/);
    assert.match(runnerSource, /bootstrapMarker\('C35_BOOTSTRAP_ADAPTER_OK'\)/);
    assert.match(runnerSource, /bootstrapMarker\('C35_BOOTSTRAP_PREFLIGHT_OK'\)/);
  });

  await check('synthetic invalid SHM is classified read-only and sidecar metadata hash is deterministic', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-c35-sidecar-'));
    const dbPath = path.join(root, 'home-node.db');
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    fs.writeFileSync(dbPath, Buffer.from('synthetic database identity'));
    fs.writeFileSync(walPath, Buffer.alloc(0));
    const shm = Buffer.alloc(32768);
    shm.writeUInt32LE(3007000, 0);
    shm[12] = 1;
    shm.writeUInt32LE(3007000, 48);
    shm[60] = 1;
    fs.writeFileSync(shmPath, shm);
    const holderProof = { homeNodeSidecarHolderAudit: {
      schema: 'internalbeyond.p32-w5.r3-c3.5-sidecar-holder-audit',
      method: 'WINDOWS_RESTART_MANAGER_READ_ONLY', available: true,
      resources: [
        { suffix: '-wal', exists: true, holderCount: 0 },
        { suffix: '-shm', exists: true, holderCount: 0 }
      ]
    } };
    try {
      const before = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
      const audit = await AdapterModule.testOnly.inspectTargetSidecars(dbPath, holderProof);
      const after = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
      assert.strictEqual(before, after);
      assert.strictEqual(audit.invalidEntries.length, 1);
      assert.strictEqual(audit.invalidEntries[0].suffix, '-shm');
      assert.strictEqual(audit.invalidEntries[0].structureStatus, 'INVALID_WAL_INDEX_PAGE_SIZE');
      assert.strictEqual(audit.holderCheck.ok, true);
      assert.strictEqual(audit.metadataHash, Executor.stableHash({
        schema: 'internalbeyond.p32-w5.r3-c3.5-sidecar-metadata', version: 1, entries: audit.entries
      }));
      assert.deepStrictEqual(audit.entries.map(entry => entry.suffix), ['-wal', '-shm']);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(audit.entries[1], 'bytes'), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await check('runner converts invalid-sidecar adapter error to a versioned zero-write failure report', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-c35-runner-sidecar-'));
    const dbPath = path.join(root, 'home-node.db');
    fs.writeFileSync(dbPath, Buffer.from('synthetic target identity'));
    const targetHash = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
    fs.writeFileSync(dbPath + '-wal', Buffer.alloc(0));
    const shm = Buffer.alloc(32768);
    shm.writeUInt32LE(3007000, 0); shm[12] = 1;
    shm.writeUInt32LE(3007000, 48); shm[60] = 1;
    fs.writeFileSync(dbPath + '-shm', shm);
    const holderAudit = { schema: 'internalbeyond.p32-w5.r3-c3.5-sidecar-holder-audit',
      method: 'WINDOWS_RESTART_MANAGER_READ_ONLY', available: true,
      resources: [
        { suffix: '-wal', exists: true, holderCount: 0 },
        { suffix: '-shm', exists: true, holderCount: 0 }
      ] };
    const inspection = await AdapterModule.testOnly.inspectTargetSidecars(dbPath, { homeNodeSidecarHolderAudit: holderAudit });
    assert.strictEqual(inspection.invalidEntries[0].structureStatus, 'INVALID_WAL_INDEX_PAGE_SIZE');
    const sidecarAudit = inspection.sidecarAudit;
    const targetIdentity = {
      databaseName: 'home-node.db', path: dbPath, c1ObservedDatabaseSha256: targetHash,
      identityBinding: 'FROZEN_C1_DATABASE_SHA256_MATCH'
    };
    const proof = {
      recoveryOnly: true, normalRuntimeStopped: true, activeQuarantined: true,
      consumedMarkerPresent: false, protectedPortsReleased: true, providerCalls: 0,
      secretAccess: false, specJsonRead: false, specJsonWrite: false,
      runtimeBindingChanged: false, providerBindingChanged: false,
      homeNodeSidecarHolderAudit: holderAudit
    };
    const request = { schema: 'internalbeyond.p32-w5.r3-c3.5-recovery-only-dry-run-request',
      version: 1, mode: 'RECOVERY_ONLY_DRY_RUN', localAppData: root, nativeProof: proof };
    const error = Object.assign(new Error('synthetic safe error'), {
      code: 'C35_HOME_NODE_SIDECAR_INVALID', details: { targetIdentity: targetIdentity, sidecarAudit: sidecarAudit }
    });
    try {
      const before = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
      const report = await Runner.testOnly.runRecoveryOnlyDryRun([Runner.DRY_RUN_ARG], JSON.stringify(request), {
        adapterFactory: async () => { throw error; }
      });
      const after = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
      assert.strictEqual(before, after);
      assert.strictEqual(report.schema, Runner.REPORT_SCHEMA);
      assert.strictEqual(report.reportType, Runner.REPORT_TYPE);
      assert.strictEqual(report.version, 1);
      assert.strictEqual(report.status, 'DRY_RUN_BLOCKED');
      assert.strictEqual(report.ok, false);
      assert.strictEqual(report.writeAllowed, false);
      assert.strictEqual(report.applyAllowed, false);
      assert.strictEqual(report.failureCode, 'C35_HOME_NODE_SIDECAR_INVALID');
      assert.strictEqual(report.reasonCode, report.failureCode);
      assert.strictEqual(report.targetIdentity.c1ObservedDatabaseSha256, targetHash);
      assert.strictEqual(report.sidecarMetadataHash, sidecarAudit.metadataHash);
      assert.deepStrictEqual(report.activity, Runner.zeroActivity());
      const encoded = JSON.stringify(report);
      assert.doesNotMatch(encoded, /synthetic safe error|business body|apiKey|tokenValue|secretValue/i);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(report, 'rows'), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await check('RecoveryOnly UI displays frozen scope and hides restore approval controls in C3.5', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'Recovery.html'), 'utf8');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'recovery-c3-5-reconstruction.js'), 'utf8');
    assert.match(html, /id="reconstruction-dry-run-panel"/);
    assert.match(html, /id="reconstruction-dry-run-button"/);
    assert.match(html, /id="reconstruction-dry-run-summary"/);
    assert.match(html, /^    <\/section>\r?\n    <section id="reconstruction-dry-run-panel"/m,
      'C3.5 panel must sit outside the legacy container hidden in RecoveryOnly mode');
    assert.match(html, /73527c524f091a8a4437409069979c2141f03b7048f8a042ae912c645e33bf7d/);
    assert.match(html, /c12255e8483c090ba53d15f711da63b6579a78721010e7a1aedc73b50dd916cf/);
    assert.match(html, /5823cbfd64defc58e05f89c75bde3e8dd92c853d51cf5c71a7a32fe3035e2062/);
    assert.match(ui, /production-approval-controls/);
    assert.match(ui, /enter-native-approval/);
    assert.match(ui, /p32_w5_r3_c3_5_reconstruction_dry_run/);
    assert.match(ui, /requestSchema: dryRunRequestSchema/);
    assert.match(ui, /requestVersion: dryRunRequestVersion/);
    assert.match(ui, /function safeReasonCode/);
    assert.match(ui, /function safeRunnerDiagnostics/);
    assert.match(ui, /bootstrapStages/);
    assert.match(ui, /C35_HOME_NODE_SIDECAR_INVALID/);
    assert.match(ui, /sidecarMetadataHash/);
    assert.match(ui, /typeof error === 'string'/);
    assert.match(ui, /Dry-run blocked: C35_HOME_NODE_SIDECAR_INVALID/);
    assert.match(ui, /No reconstruction was applied/);
    assert.doesNotMatch(ui, /String\(error\s*&&\s*error\.message\s*\|\|\s*error\)/);
  });

  console.log('RESULT ' + passed + ' passed / ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error('FATAL ' + String(error && error.stack || error)); process.exitCode = 1; });
