'use strict';

/*
 * P32-W5-R3-C3.5 scoped RecoveryOnly adapter. This adapter is independent of
 * the R3-B ProductionRecoveryAdapter. Its production factory opens the existing
 * Home Node DB through a read-only SQLite connection and attaches only official
 * Home Node store APIs. C3.5 exposes dry-run only; every mutation method fails
 * closed and records an attempted-write counter.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Executor = require('./composite-reconstruction-executor.js');
const ApprovalContract = require('./composite-reconstruction-approval.js');
const createChatStore = require('./chat-store.js');
const createMemoryStore = require('./memory-store.js');
const createMomentsStore = require('./moments-store.js');
const createDeviceRegistry = require('./device-registry.js');

const FROZEN = Executor.FROZEN_CONTRACT;
const CONTRACT_DIR = path.join('services', 'home-node', 'reconstruction-contracts', 'p32-w5-r3c3');
const ARTIFACT_FILES = Object.freeze({
  bundle: 'composite-bundle.json',
  writeSetA: 'home-node-reconstruction-write-set.json',
  writeSetB: 'character-projection-write-set.json',
  proposal: 'home-node-proposed-write-set.json',
  authorityMatrix: 'character-field-authority-matrix.json',
  conflictResolution: 'character-conflict-resolution.json',
  c2Report: 'c2-authority-report.json'
});
const DOMAIN_STORE = Object.freeze({
  chatMessages: 'chat',
  memories: 'memory',
  moments: 'moments'
});
const SIDECAR_METADATA_SCHEMA = 'internalbeyond.p32-w5.r3-c3.5-sidecar-metadata';
const SIDECAR_AUDIT_SCHEMA = 'internalbeyond.p32-w5.r3-c3.5-sidecar-audit';
const TEST_ENABLED = process.env.IB_P32_W5_C35_SYNTHETIC_TESTS === '1';

function fail(code, details) {
  const error = Object.assign(new Error(code), { code: code });
  if (details !== undefined) error.details = details;
  return error;
}
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { throw fail('C35_CONTRACT_ARTIFACT_INVALID', path.basename(filePath)); }
}
function normalizedPath(value) {
  return path.resolve(String(value || '')).replace(/[\\/]+$/g, '').toLowerCase();
}
function expectedDatabasePath(localAppData) {
  return path.join(String(localAppData || ''), 'InternalBeyond', 'home-node', 'home-node.db');
}
function targetSidecars(dbPath) {
  return ['-wal', '-shm'].map(suffix => {
    const file = dbPath + suffix;
    if (!fs.existsSync(file)) return { suffix: suffix, exists: false, size: 0 };
    const stat = fs.statSync(file);
    return { suffix: suffix, exists: true, size: stat.size };
  });
}
function readShmStructure(filePath, sizeBytes) {
  if (sizeBytes < 96) return 'INVALID_WAL_INDEX_HEADER_TRUNCATED';
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  const header = Buffer.alloc(96);
  try {
    let offset = 0;
    while (offset < header.length) {
      const count = fs.readSync(fd, header, offset, header.length - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    if (offset !== header.length) return 'INVALID_WAL_INDEX_HEADER_TRUNCATED';
  } finally {
    fs.closeSync(fd);
  }
  const first = header.subarray(0, 48);
  const second = header.subarray(48, 96);
  const version = first.readUInt32LE(0);
  const initialized = first[12];
  const pageSize = first.readUInt16LE(14);
  if (version !== 3007000) return 'INVALID_WAL_INDEX_VERSION';
  if (initialized !== 0 && initialized !== 1) return 'INVALID_WAL_INDEX_INITIALIZED_FLAG';
  if (initialized === 0) return 'UNINITIALIZED_WAL_INDEX';
  const validPageSize = pageSize === 1 || (pageSize >= 512 && pageSize <= 32768 && (pageSize & (pageSize - 1)) === 0);
  if (!validPageSize) return 'INVALID_WAL_INDEX_PAGE_SIZE';
  if (!first.equals(second)) return 'INVALID_WAL_INDEX_HEADER_COPIES';
  return 'VALID_WAL_INDEX';
}

function nativeSidecarHolderAudit(nativeProof, entries) {
  const audit = nativeProof && nativeProof.homeNodeSidecarHolderAudit;
  if (!isPlainObject(audit) || audit.schema !== 'internalbeyond.p32-w5.r3-c3.5-sidecar-holder-audit' || audit.available !== true ||
      audit.method !== 'WINDOWS_RESTART_MANAGER_READ_ONLY' || !Array.isArray(audit.resources)) {
    return { ok: false, code: 'C35_HOME_NODE_SIDECAR_HOLDER_AUDIT_UNAVAILABLE', audit: null };
  }
  const resources = {};
  for (const item of audit.resources) {
    if (!isPlainObject(item) || !['-wal', '-shm'].includes(item.suffix) ||
        typeof item.exists !== 'boolean' || !Number.isSafeInteger(item.holderCount) || item.holderCount < 0 ||
        Object.prototype.hasOwnProperty.call(resources, item.suffix)) {
      return { ok: false, code: 'C35_HOME_NODE_SIDECAR_HOLDER_AUDIT_UNAVAILABLE', audit: null };
    }
    resources[item.suffix] = item;
  }
  const projected = entries.map(entry => {
    const resource = resources[entry.suffix];
    if (!resource || resource.exists !== entry.exists) return null;
    return { suffix: entry.suffix, exists: resource.exists, holderCount: resource.holderCount };
  });
  if (projected.some(item => item === null)) {
    return { ok: false, code: 'C35_HOME_NODE_SIDECAR_HOLDER_AUDIT_UNAVAILABLE', audit: null };
  }
  const holderAudit = {
    method: audit.method,
    available: true,
    resources: projected
  };
  if (projected.some(item => item.holderCount !== 0)) {
    return { ok: false, code: 'C35_HOME_NODE_SIDECAR_HOLDER_PRESENT', audit: holderAudit };
  }
  return { ok: true, audit: holderAudit };
}

async function inspectTargetSidecars(dbPath, nativeProof) {
  const entries = [];
  for (const suffix of ['-wal', '-shm']) {
    const filePath = dbPath + suffix;
    let stat = null;
    try { stat = fs.statSync(filePath); }
    catch (error) {
      if (!error || error.code !== 'ENOENT') throw fail('C35_HOME_NODE_SIDECAR_METADATA_UNAVAILABLE');
    }
    const exists = !!stat;
    let structureStatus = 'ABSENT';
    let digest = null;
    let sizeBytes = 0;
    if (exists) {
      if (!stat.isFile()) throw fail('C35_HOME_NODE_SIDECAR_METADATA_UNAVAILABLE');
      sizeBytes = stat.size;
      digest = await hashFile(filePath);
      if (suffix === '-wal') structureStatus = sizeBytes === 0 ? 'EMPTY' : 'NOT_VALIDATED';
      else structureStatus = readShmStructure(filePath, sizeBytes);
    }
    entries.push({ suffix: suffix, exists: exists, sizeBytes: sizeBytes, sha256: digest, structureStatus: structureStatus });
  }

  const basis = { schema: SIDECAR_METADATA_SCHEMA, version: 1, entries: entries };
  const metadataHash = Executor.stableHash(basis);
  const holderResult = nativeSidecarHolderAudit(nativeProof, entries);
  const sidecarAudit = {
    schema: SIDECAR_AUDIT_SCHEMA,
    version: 1,
    metadataHash: metadataHash,
    entries: entries,
    holderAudit: holderResult.audit || {
      method: 'WINDOWS_RESTART_MANAGER_READ_ONLY',
      available: false,
      resources: []
    }
  };
  return {
    schema: SIDECAR_AUDIT_SCHEMA,
    version: 1,
    metadataHash: metadataHash,
    entries: entries,
    holderAudit: sidecarAudit.holderAudit,
    holderCheck: holderResult,
    sidecarAudit: sidecarAudit,
    invalidEntries: entries.filter(entry => entry.structureStatus.indexOf('INVALID_') === 0)
  };
}

function targetIdentityFromHash(dbPath, dbSha256) {
  return {
    databaseName: path.basename(dbPath),
    path: dbPath,
    c1ObservedDatabaseSha256: dbSha256,
    identityBinding: 'FROZEN_C1_DATABASE_SHA256_MATCH'
  };
}

function sidecarFailureDetails(targetIdentity, inspection) {
  return { targetIdentity: targetIdentity, sidecarMetadataHash: inspection.metadataHash, sidecarAudit: inspection.sidecarAudit };
}
function assertRecoveryOnlyProof(proof) {
  if (!isPlainObject(proof) || proof.recoveryOnly !== true || proof.normalRuntimeStopped !== true ||
      proof.activeQuarantined !== true || proof.consumedMarkerPresent !== false ||
      proof.protectedPortsReleased !== true || proof.providerCalls !== 0 || proof.secretAccess !== false ||
      proof.specJsonRead !== false || proof.specJsonWrite !== false || proof.runtimeBindingChanged !== false ||
      proof.providerBindingChanged !== false) throw fail('C35_RECOVERY_ONLY_PROOF_INVALID');
}
function loadFrozenArtifacts(resourceRoot) {
  const dir = path.join(resourceRoot, CONTRACT_DIR);
  const values = {};
  const bytes = {};
  for (const key of Object.keys(ARTIFACT_FILES)) {
    const file = path.join(dir, ARTIFACT_FILES[key]);
    bytes[key] = fs.readFileSync(file);
    if (key === 'proposal') values[key] = JSON.parse(bytes[key].toString('utf8'));
    else values[key] = JSON.parse(bytes[key].toString('utf8'));
  }
  return { dir: dir, values: values, bytes: bytes };
}

class ProductionReconstructionAdapter {
  constructor(options) {
    options = options || {};
    this.contract = options.contract || FROZEN;
    this.nativeProof = options.nativeProof || null;
    this.targetPath = String(options.targetPath || '');
    this.db = options.db || null;
    this.stores = options.stores || null;
    this.artifacts = options.artifacts || null;
    this.artifactHashes = options.artifactHashes || null;
    this.sidecarAudit = options.sidecarAudit || null;
    this.readOnly = options.readOnly === true;
    this.synthetic = options.synthetic === true;
    this.approvalVerifier = options.approvalVerifier || null;
    this.closed = false;
    this.activity = {
      productionWrites: 0,
      homeNodeWrites: 0,
      indexedDbWrites: 0,
      providerCalls: 0,
      secretAccess: 0,
      specJsonReads: 0,
      specJsonWrites: 0,
      approvalIssued: 0,
      checkpointCreated: 0,
      applyWindowOpened: 0
    };
    if (this.synthetic) {
      if (!TEST_ENABLED) throw fail('C35_SYNTHETIC_ADAPTER_DISABLED');
      this.contract = options.contract || this.contract;
      this.nativeProof = options.nativeProof || {
        recoveryOnly: true, normalRuntimeStopped: true, activeQuarantined: true,
        consumedMarkerPresent: false, protectedPortsReleased: true, providerCalls: 0,
        secretAccess: false, specJsonRead: false, specJsonWrite: false,
        runtimeBindingChanged: false, providerBindingChanged: false
      };
      this.stores = options.stores || {};
      this.artifacts = options.artifacts || null;
      this.artifactHashes = options.artifactHashes || {};
      this.readOnly = true;
      return;
    }
    if (options.mode !== 'RECOVERY_ONLY') throw fail('C35_NON_RECOVERY_CALLER_REJECTED');
    assertRecoveryOnlyProof(this.nativeProof);
    if (!this.db || !this.readOnly || !this.stores || !this.artifacts || !this.targetPath) {
      throw fail('C35_PRODUCTION_ADAPTER_CONFIGURATION_INVALID');
    }
  }

  static async openForRecoveryOnly(options) {
    options = options || {};
    if (options.mode !== 'RECOVERY_ONLY') throw fail('C35_NON_RECOVERY_CALLER_REJECTED');
    assertRecoveryOnlyProof(options.nativeProof);
    const resourceRoot = path.resolve(String(options.resourceRoot || ''));
    const artifacts = loadFrozenArtifacts(resourceRoot);
    const values = artifacts.values;
    const artifactHashes = {
      proposal: sha256(artifacts.bytes.proposal),
      authorityMatrix: sha256(artifacts.bytes.authorityMatrix),
      conflictResolution: sha256(artifacts.bytes.conflictResolution),
      c2Report: sha256(artifacts.bytes.c2Report)
    };
    const dbPath = expectedDatabasePath(options.localAppData);
    if (normalizedPath(dbPath) !== normalizedPath(FROZEN.homeNodeTarget.path) || !fs.existsSync(dbPath)) {
      throw fail('C35_HOME_NODE_TARGET_PATH_INVALID');
    }
    const canonicalDbPath = fs.realpathSync(dbPath);
    if (normalizedPath(canonicalDbPath) !== normalizedPath(FROZEN.homeNodeTarget.path)) throw fail('C35_HOME_NODE_TARGET_PATH_INVALID');
    const dbSha256 = await hashFile(dbPath);
    if (dbSha256 !== FROZEN.homeNodeTarget.c1ObservedDatabaseSha256) throw fail('C35_HOME_NODE_TARGET_HASH_MISMATCH');
    const targetIdentity = targetIdentityFromHash(canonicalDbPath, dbSha256);
    const sidecarInspection = await inspectTargetSidecars(canonicalDbPath, options.nativeProof);
    const failureDetails = sidecarFailureDetails(targetIdentity, sidecarInspection);
    if (!sidecarInspection.holderCheck.ok) {
      throw fail(sidecarInspection.holderCheck.code, failureDetails);
    }
    if (sidecarInspection.invalidEntries.length > 0) {
      throw fail('C35_HOME_NODE_SIDECAR_INVALID', failureDetails);
    }
    if (sidecarInspection.entries.some(item => item.exists && item.sizeBytes > 0)) {
      throw fail('C35_HOME_NODE_WAL_OR_SHM_PRESENT', failureDetails);
    }

    let db = null;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec('PRAGMA query_only=ON');
      const chat = createChatStore({ dbFile: dbPath, logger: () => {} });
      const memory = createMemoryStore({ dbFile: dbPath, logger: () => {} });
      const moments = createMomentsStore({ dbFile: dbPath, logger: () => {} });
      const devices = createDeviceRegistry({ dbFile: dbPath, logger: () => {} });
      chat.attachReadOnlyConnection(db);
      memory.attachReadOnlyConnection(db);
      moments.attachReadOnlyConnection(db);
      devices.attachReadOnlyConnection(db);
      const databaseIdentity = chat.readDatabaseIdentity();
      if (!databaseIdentity || databaseIdentity.ok !== true || databaseIdentity.queryOnly !== true) throw fail('C35_QUERY_ONLY_CONNECTION_REQUIRED');
      const schemaUserVersion = Number(databaseIdentity.schemaUserVersion);
      if (schemaUserVersion !== FROZEN.homeNodeTarget.schemaUserVersion) throw fail('C35_HOME_NODE_SCHEMA_VERSION_MISMATCH');
      return new ProductionReconstructionAdapter({
        mode: options.mode,
        nativeProof: options.nativeProof,
        targetPath: canonicalDbPath,
        db: db,
        stores: { chat: chat, memory: memory, moments: moments, devices: devices },
        artifacts: values,
        artifactHashes: artifactHashes,
        sidecarAudit: sidecarInspection.sidecarAudit,
        readOnly: true,
        approvalVerifier: options.approvalVerifier || null
      });
    } catch (error) {
      if (db) { try { db.close(); } catch (_) { /* retain original error */ } }
      throw error;
    }
  }

  frozenInputs() {
    if (!this.artifacts) throw fail('C35_CONTRACT_ARTIFACTS_UNAVAILABLE');
    return {
      bundle: this.artifacts.bundle,
      bundleHash: this.contract.bundleHash,
      writeSetA: this.artifacts.writeSetA,
      writeSetB: this.artifacts.writeSetB,
      proposal: this.artifacts.proposal,
      proposalArtifactSha256: this.artifactHashes.proposal
    };
  }

  async getEnvironmentSnapshot() {
    assertRecoveryOnlyProof(this.nativeProof);
    return Object.assign({}, this.nativeProof, {
      recoveryOnly: true,
      normalRuntimeStopped: true,
      activeQuarantined: true,
      consumedMarkerPresent: false,
      providerCalls: this.activity.providerCalls,
      secretAccess: this.activity.secretAccess > 0,
      specJsonRead: this.activity.specJsonReads > 0,
      specJsonWrite: this.activity.specJsonWrites > 0,
      runtimeBindingChanged: false,
      providerBindingChanged: false
    });
  }

  async getTargetIdentity() {
    if (this.closed || !this.db || !this.readOnly) throw fail('C35_READONLY_TARGET_CLOSED');
    const sidecars = targetSidecars(this.targetPath);
    if (sidecars.some(item => item.exists && item.size > 0)) throw fail('C35_HOME_NODE_WAL_OR_SHM_PRESENT', sidecars);
    const databaseIdentity = this.stores.chat.readDatabaseIdentity();
    if (!databaseIdentity || databaseIdentity.ok !== true || databaseIdentity.queryOnly !== true) throw fail('C35_QUERY_ONLY_CONNECTION_REQUIRED');
    const schemaUserVersion = Number(databaseIdentity.schemaUserVersion);
    return {
      databaseName: path.basename(this.targetPath),
      path: this.targetPath,
      c1ObservedDatabaseSha256: await hashFile(this.targetPath),
      schemaUserVersion: schemaUserVersion,
      integrityCheck: this.contract.homeNodeTarget.integrityCheck,
      integrityCheckEvidence: 'C1_FROZEN_BASELINE_ONLY_NO_FULL_DATABASE_SCAN',
      revalidationRequiredAtExecution: true,
      nonEmptySidecars: 0
    };
  }

  async verifyProductionBindings(input) {
    input = input || {};
    const artifacts = this.artifacts;
    const expected = this.contract;
    const failResult = code => ({ ok: false, code: code });
    if (!artifacts || !this.artifactHashes || this.artifactHashes.proposal !== expected.writeSetA.proposalArtifactSha256 ||
        this.artifactHashes.authorityMatrix !== expected.authorityMatrixSha256 ||
        this.artifactHashes.conflictResolution !== expected.conflictResolutionSha256 ||
        this.artifactHashes.c2Report !== expected.c2ReportSha256) return failResult('AUTHORITY_OR_PROPOSAL_ARTIFACT_HASH_MISMATCH');
    if (Executor.stableHash(artifacts.bundle) !== expected.bundleHash ||
        Executor.testOnly.hashWriteSetA(artifacts.writeSetA) !== expected.writeSetA.writeSetSha256 ||
        Executor.testOnly.hashWriteSetB(artifacts.writeSetB) !== expected.writeSetB.writeSetSha256) return failResult('FROZEN_WRITESET_HASH_MISMATCH');
    if (!input.bundle || Executor.stableHash(input.bundle) !== expected.bundleHash ||
        !input.writeSetA || !input.writeSetB ||
        Executor.stableHash(input.writeSetA) !== Executor.stableHash(artifacts.writeSetA) ||
        Executor.stableHash(input.writeSetB) !== Executor.stableHash(artifacts.writeSetB) ||
        !input.proposal || Executor.stableHash(input.proposal) !== Executor.stableHash(artifacts.proposal)) {
      return failResult('CALLER_SUPPLIED_FROZEN_ARTIFACT_MISMATCH');
    }
    const proposal = artifacts.proposal;
    if (!proposal || proposal.planId !== expected.planId || proposal.sourceRecordBodiesIncluded !== false ||
        proposal.secretValuesIncluded !== false || !Array.isArray(proposal.items) ||
        input.proposalArtifactSha256 !== expected.writeSetA.proposalArtifactSha256) return failResult('FROZEN_PROPOSAL_BOUNDARY_MISMATCH');
    if (Executor.testOnly.stableInsertSubsetHash(proposal.items) !== expected.writeSetA.insertSubsetSha256) return failResult('FROZEN_INSERT_KEYSET_HASH_MISMATCH');
    if (input.bundleHash && String(input.bundleHash).toLowerCase() !== expected.bundleHash) return failResult('BUNDLE_HASH_MISMATCH');
    if (input.writeSetA && input.writeSetA.writeSetSha256 !== expected.writeSetA.writeSetSha256) return failResult('WRITESET_A_HASH_MISMATCH');
    if (input.writeSetB && input.writeSetB.writeSetSha256 !== expected.writeSetB.writeSetSha256) return failResult('WRITESET_B_HASH_MISMATCH');
    const setATarget = artifacts.writeSetA.targetIdentity || {};
    const setBTarget = artifacts.writeSetB.targetIdentity || {};
    if (!sameIdentity(setATarget, expected.homeNodeTarget) || !sameIdentity(setBTarget, expected.homeNodeTarget)) return failResult('WRITESET_TARGET_BINDING_MISMATCH');
    if (!samePlan(artifacts.writeSetA.proposalIdentity, expected) || !samePlan(artifacts.writeSetB.proposalIdentity, expected)) return failResult('WRITESET_PLAN_BINDING_MISMATCH');
    const authority = artifacts.writeSetB.authoritySource || {};
    if (authority.authorityMatrixSha256 !== expected.authorityMatrixSha256 ||
        authority.conflictResolutionSha256 !== expected.conflictResolutionSha256 ||
        authority.c2ReportSha256 !== expected.c2ReportSha256 || authority.sourcePrimarySha256 !== expected.sourcePrimarySha256) {
      return failResult('WRITESET_AUTHORITY_BINDING_MISMATCH');
    }
    if (Number(artifacts.writeSetA.authoritySource.provenanceCount) !== expected.provenanceRecordCount ||
        artifacts.writeSetA.authoritySource.provenanceDigest !== expected.provenanceDigest ||
        Number(artifacts.bundle.provenance.recordCount) !== expected.provenanceRecordCount ||
        artifacts.bundle.provenance.traceDigest !== expected.provenanceDigest) return failResult('PROVENANCE_BINDING_MISMATCH');
    const forbiddenA = artifacts.writeSetA.forbiddenWrites || {};
    if (Number(artifacts.writeSetA.totalRows) !== 500 || Number(forbiddenA.update) !== 0 || Number(forbiddenA.delete) !== 0 ||
        Number(forbiddenA.characters) !== 0 || Number(forbiddenA.character_runtime_specs) !== 0 ||
        artifacts.writeSetB.operation !== 'UPDATE' || Number(artifacts.writeSetB.rowCount) !== 8 ||
        Number(artifacts.writeSetB.updateCount) !== 8 || Number(artifacts.writeSetB.deleteCount) !== 0 ||
        Number(artifacts.writeSetB.insertCount || 0) !== 0) {
      return failResult('MUTATION_BUDGET_MISMATCH');
    }
    return {
      ok: true,
      bundleId: expected.bundleId,
      bundleSha256: expected.bundleHash,
      writeSetAHash: expected.writeSetA.writeSetSha256,
      writeSetBHash: expected.writeSetB.writeSetSha256,
      proposalArtifactSha256: this.artifactHashes.proposal,
      authorityArtifacts: {
        matrixSha256: this.artifactHashes.authorityMatrix,
        conflictResolutionSha256: this.artifactHashes.conflictResolution,
        c2ReportSha256: this.artifactHashes.c2Report
      }
    };
  }

  async classifyExistingRecords(domain, rows) {
    if (!this.readOnly || this.closed || !Array.isArray(rows)) throw fail('C35_READONLY_CLASSIFICATION_UNAVAILABLE');
    const storeName = DOMAIN_STORE[domain];
    if (!storeName) throw fail('C35_DOMAIN_FORBIDDEN');
    const store = this.stores[storeName];
    return rows.map(row => {
      const key = String(row && row.stableKey || '');
      const record = domain === 'chatMessages' ? store.getMessage(key, { includeDeleted: true })
        : (domain === 'memories' ? store.getRecord(key, { includeDeleted: true }) : store.getRecordAny(key));
      if (!record) return { stableKey: key, status: 'absent', targetRecordSha256: null };
      const digest = Executor.stableHash(record);
      return { stableKey: key, status: digest === String(row.sourceRecordSha256 || '').toLowerCase() ? 'identical' : 'conflict',
        targetRecordSha256: digest };
    });
  }

  async readbackDomainRecordDigests(domain, expected) {
    const states = await this.classifyExistingRecords(domain, expected);
    return states.map(state => ({ stableKey: state.stableKey, sourceRecordSha256: state.targetRecordSha256,
      verified: state.status === 'identical' }));
  }

  readCharacterDtoProjections(ids) {
    if (!this.readOnly || this.closed) return { ok: false, code: 'C35_READONLY_TARGET_CLOSED' };
    return this.stores.devices.readCharacterDtoProjections(ids);
  }

  async verifyReferencesAndProvenance(input) {
    const binding = await this.verifyProductionBindings({
      bundle: input && input.bundle,
      bundleHash: this.contract.bundleHash,
      writeSetA: input && input.writeSetA,
      writeSetB: this.artifacts && this.artifacts.writeSetB,
      proposalArtifactSha256: input && input.proposalArtifactSha256
    });
    if (!binding.ok) return { ok: false, code: binding.code };
    const items = input && input.proposal && input.proposal.items;
    const inserts = Array.isArray(items) ? items.filter(item => item && item.operation === 'INSERT') : [];
    const keyDomains = new Set(inserts.map(item => String(item.source && item.source.domain) + '|' + String(item.stableKey)));
    if (inserts.length !== this.contract.writeSetA.rows || keyDomains.size !== inserts.length) return { ok: false, code: 'A_PROVENANCE_KEYSET_INVALID' };
    return {
      ok: true,
      recordCount: this.contract.provenanceRecordCount,
      traceDigest: this.contract.provenanceDigest,
      sourcePrimarySha256: this.contract.sourcePrimarySha256,
      proposalInsertCount: inserts.length,
      verificationMode: 'FROZEN_ARTIFACT_AND_PLAN_BINDING',
      sourceBodiesRead: false,
      secretValuesRead: false
    };
  }

  async verifyCompositeApproval(approval, _bundle, bundleHash) {
    if (!this.approvalVerifier || typeof this.approvalVerifier.verifyAndConsume !== 'function') return false;
    const bindings = buildApprovalBindings(this.contract, bundleHash);
    try { return this.approvalVerifier.verifyAndConsume(approval, bindings).ok === true; }
    catch (_) { return false; }
  }

  async getActivityCounters() {
    return Object.assign({}, this.activity, {
      productionWrites: this.activity.productionWrites,
      homeNodeWrites: this.activity.homeNodeWrites,
      indexedDbWrites: this.activity.indexedDbWrites,
      providerCalls: this.activity.providerCalls,
      secretAccess: this.activity.secretAccess,
      specJsonReads: this.activity.specJsonReads,
      specJsonWrites: this.activity.specJsonWrites
    });
  }

  _rejectMutation() {
    this.activity.productionWrites++;
    this.activity.homeNodeWrites++;
    throw fail('C35_PRODUCTION_APPLY_DISABLED');
  }
  async putMessages() { return this._rejectMutation(); }
  async putMemoryRecords() { return this._rejectMutation(); }
  async writeMigratedMoment() { return this._rejectMutation(); }
  applyCharacterDtoProjectionBatch() { return this._rejectMutation(); }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.db) { try { this.db.close(); } catch (_) { /* no retry or recovery action */ } }
    this.db = null;
  }
}

function sameIdentity(actual, expected) {
  return actual.databaseName === expected.databaseName && normalizedPath(actual.path) === normalizedPath(expected.path) &&
    actual.c1ObservedDatabaseSha256 === expected.c1ObservedDatabaseSha256 &&
    Number(actual.schemaUserVersion) === Number(expected.schemaUserVersion);
}
function samePlan(actual, expected) {
  return !!actual && actual.planId === expected.planId && actual.planSha256 === expected.planSha256 &&
    actual.targetSnapshotSha256 === expected.targetSnapshotSha256 && actual.sourcePrimarySha256 === expected.sourcePrimarySha256 &&
    Number(actual.provenanceRecordCount) === expected.provenanceRecordCount && actual.provenanceDigest === expected.provenanceDigest;
}
function buildApprovalBindings(contract, bundleHash) {
  return {
    executionIdentity: 'P32-W5-R3-C3.5',
    bundleId: contract.bundleId,
    bundleSha256: String(bundleHash || contract.bundleHash),
    writeSetAHash: contract.writeSetA.writeSetSha256,
    writeSetBHash: contract.writeSetB.writeSetSha256,
    proposalArtifactSha256: contract.writeSetA.proposalArtifactSha256,
    authorityArtifacts: {
      matrixSha256: contract.authorityMatrixSha256,
      conflictResolutionSha256: contract.conflictResolutionSha256,
      c2ReportSha256: contract.c2ReportSha256
    },
    targetIdentity: contract.homeNodeTarget,
    plan: { planId: contract.planId, planSha256: contract.planSha256, targetSnapshotSha256: contract.targetSnapshotSha256 },
    provenance: { recordCount: contract.provenanceRecordCount, traceDigest: contract.provenanceDigest,
      sourcePrimarySha256: contract.sourcePrimarySha256 },
    budget: { INSERT: 500, UPDATE: 8, DELETE: 0 }
  };
}

const testOnly = Object.freeze({
  createSyntheticAdapter: function (options) {
    if (!TEST_ENABLED) throw fail('C35_SYNTHETIC_ADAPTER_DISABLED');
    return new ProductionReconstructionAdapter(Object.assign({}, options || {}, { synthetic: true, mode: 'RECOVERY_ONLY' }));
  },
  buildApprovalBindings: buildApprovalBindings,
  sha256: sha256,
  inspectTargetSidecars: inspectTargetSidecars,
  readShmStructure: readShmStructure
});

module.exports = Object.freeze({
  ProductionReconstructionAdapter: ProductionReconstructionAdapter,
  ARTIFACT_FILES: ARTIFACT_FILES,
  CONTRACT_DIR: CONTRACT_DIR,
  buildApprovalBindings: buildApprovalBindings,
  testOnly: testOnly
});
