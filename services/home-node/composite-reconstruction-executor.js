'use strict';

/*
 * P32-W5-R3-C3.4. RecoveryOnly composite executor, deliberately not wired to
 * startup, a Tauri command, or an HTTP route in this phase. It requires an
 * externally verified one-use composite approval and injected official store
 * adapters. Unit tests may use the guarded synthetic hook only.
 */
const crypto = require('crypto');

const FROZEN = Object.freeze({
  bundleId: 'p32w5-r3c3:73527c524f091a8a44374090',
  bundleHash: '73527c524f091a8a4437409069979c2141f03b7048f8a042ae912c645e33bf7d',
  planId: 'r3b3:1ee6aba8f773b8297e25a3904bad0f9db51ec308e4d295a1718ae48912cf44c7',
  planSha256: '1ee6aba8f773b8297e25a3904bad0f9db51ec308e4d295a1718ae48912cf44c7',
  targetSnapshotSha256: 'e353295cdb6d2c8bdd344b2b54bf4f5da59bbf7b2b85081380faefe022c76d9c',
  sourcePrimarySha256: '1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401',
  provenanceRecordCount: 539,
  provenanceDigest: '420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5',
  authorityMatrixSha256: '3d541b2bafd6d3adcb57b7a9a131d89d07b4f104ad3d1a77b86ebea53357411f',
  conflictResolutionSha256: '957017349fab91012c7d6a064ea5f6a740d11c4a2b1cf68a7b74c28b3d1b0876',
  c2ReportSha256: 'e2168acd3c998eb89ccee0184ce07d2a5b16d353782f27937d24c1989cccc2a7',
  homeNodeTarget: Object.freeze({
    databaseName: 'home-node.db',
    path: 'C:\\Users\\admin\\AppData\\Local\\InternalBeyond\\home-node\\home-node.db',
    c1ObservedDatabaseSha256: 'eaad098dccfc21835a0b079da03d28f4323fc977abfe94a289d8aeb471c18276',
    schemaUserVersion: 0,
    integrityCheck: 'ok',
    revalidationRequiredAtExecution: true
  }),
  writeSetA: Object.freeze({
    schema: 'internalbeyond.p32-w5.r3-c3.home-node-reconstruction-write-set',
    writeSetSha256: 'c12255e8483c090ba53d15f711da63b6579a78721010e7a1aedc73b50dd916cf',
    proposalArtifactSha256: 'c2f567943f299621537077a73739bb16853b99f474fe74407e20e3033febb70a',
    insertSubsetSha256: '52819e4686ab0bea58985b108b0362e57a4efb145bd30a44f9dcddb4c2e96061',
    rows: 500,
    operationCounts: Object.freeze({ INSERT: 500, DEFER: 27, NOOP: 5 }),
    counts: Object.freeze({ messages: 341, memory_records: 4, moment_records: 155 })
  }),
  writeSetB: Object.freeze({
    schema: 'internalbeyond.p32-w5.r3-c3.character-projection-write-set',
    writeSetSha256: '5823cbfd64defc58e05f89c75bde3e8dd92c853d51cf5c71a7a32fe3035e2062',
    rows: 8,
    modelAssignments: 7,
    capabilityAssignments: 2,
    mutationBudget: Object.freeze({ INSERT: 500, UPDATE: 8, DELETE: 0 }),
    ids: Object.freeze([
      'friend_1785224987526', 'friend_1785251795342', 'friend_1785261242640', 'friend_1785262029060',
      'friend_1785301791932', 'friend_1785310595095', 'friend_1787391487573_1w3xz7', 'friend_1787813887723_w4lxqx'
    ])
  }),
  mutationBudget: Object.freeze({ INSERT: 500, UPDATE: 8, DELETE: 0 })
});

const DOMAINS = Object.freeze(['chatMessages', 'memories', 'moments']);
const TABLE_FOR_DOMAIN = Object.freeze({ chatMessages: 'messages', memories: 'memory_records', moments: 'moment_records' });
const ALLOWED_PROJECTION_PATHS = Object.freeze(['characters.dto_json.capabilities', 'characters.dto_json.model']);
const CAPABILITY_KEYS = Object.freeze(['chat', 'stream', 'vision', 'webSearch', 'imageGen']);
const TEST_TOKEN = Object.freeze({ synthetic: true });
const COMMON_JS = typeof module === 'object' && !!module.exports;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).sort().forEach(key => {
      if (value[key] !== undefined) out[key] = stableValue(value[key]);
    });
    return out;
  }
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function sha256Hex(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }
function stableHash(value) { return sha256Hex(stableJson(value)); }
function sameJson(a, b) { return stableJson(a) === stableJson(b); }
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function fail(code, details) {
  const error = Object.assign(new Error(code), { code: code });
  if (details !== undefined) error.details = details;
  return error;
}
function hashWithout(value, excluded) {
  const copy = {};
  Object.keys(value || {}).forEach(key => { if (!excluded.includes(key)) copy[key] = value[key]; });
  return stableHash(copy);
}
function itemBinding(item) {
  return {
    table: item.table, operation: item.operation, stableKey: item.stableKey,
    source: item.source, targetExistence: item.targetExistence,
    precondition: item.precondition, conflictClassification: item.conflictClassification,
    reason: item.reason
  };
}
function insertSubsetHash(items) {
  const sorted = (items || []).filter(item => item && item.operation === 'INSERT').slice()
    .sort((a, b) => String(a.table) < String(b.table) ? -1 : (String(a.table) > String(b.table) ? 1 :
      (String(a.stableKey) < String(b.stableKey) ? -1 : (String(a.stableKey) > String(b.stableKey) ? 1 : 0))))
    .map(itemBinding);
  return stableHash(sorted);
}

function validateBundle(bundle, suppliedHash, contract) {
  if (!isPlainObject(bundle) || String(suppliedHash || '').toLowerCase() !== contract.bundleHash || stableHash(bundle) !== contract.bundleHash) {
    throw fail('C34_BUNDLE_HASH_MISMATCH');
  }
  if (bundle.schema !== 'internalbeyond.p32-w5.r3-c3.composite-reconstruction-bundle' || Number(bundle.version) !== 1) {
    throw fail('C34_BUNDLE_SCHEMA_INVALID');
  }
  const plan = bundle.planIdentity || {};
  const authority = bundle.c2Authority || {};
  const target = bundle.targetHomeNodeIdentity || {};
  const provenance = bundle.provenance || {};
  const a = (bundle.writeSets || {}).A || {};
  const b = (bundle.writeSets || {}).B || {};
  const budget = bundle.totalMutationBudget || {};
  if (plan.planId !== contract.planId || plan.planSha256 !== contract.planSha256 ||
      plan.targetSnapshotSha256 !== contract.targetSnapshotSha256 || plan.sourcePrimarySha256 !== contract.sourcePrimarySha256) {
    throw fail('C34_PLAN_IDENTITY_MISMATCH');
  }
  if (authority.matrixSha256 !== contract.authorityMatrixSha256 || authority.conflictResolutionSha256 !== contract.conflictResolutionSha256 ||
      authority.c2ReportSha256 !== contract.c2ReportSha256) throw fail('C34_C2_AUTHORITY_MISMATCH');
  if (target.databaseName !== contract.homeNodeTarget.databaseName || target.path !== contract.homeNodeTarget.path ||
      target.c1ObservedDatabaseSha256 !== contract.homeNodeTarget.c1ObservedDatabaseSha256 ||
      Number(target.schemaUserVersion) !== Number(contract.homeNodeTarget.schemaUserVersion) ||
      target.integrityCheck !== contract.homeNodeTarget.integrityCheck ||
      target.revalidationRequiredAtExecution !== contract.homeNodeTarget.revalidationRequiredAtExecution) {
    throw fail('C34_HOME_NODE_TARGET_MISMATCH');
  }
  if (Number(provenance.recordCount) !== Number(contract.provenanceRecordCount) || provenance.traceDigest !== contract.provenanceDigest ||
      provenance.sourcePrimarySha256 !== contract.sourcePrimarySha256) throw fail('C34_PROVENANCE_MISMATCH');
  if (a.writeSetSha256 !== contract.writeSetA.writeSetSha256 || a.frozenProposalArtifactSha256 !== contract.writeSetA.proposalArtifactSha256 ||
      a.insertSubsetCanonicalSha256 !== contract.writeSetA.insertSubsetSha256 || Number(a.rows) !== Number(contract.writeSetA.rows) ||
      a.operation !== 'INSERT') {
    throw fail('C34_BUNDLE_SET_A_MISMATCH');
  }
  if (b.writeSetSha256 !== contract.writeSetB.writeSetSha256 || Number(b.rows) !== Number(contract.writeSetB.rows) ||
      b.operation !== 'UPDATE' || b.table !== 'characters' || b.storageColumn !== 'dto_json' ||
      !sameJson((b.fieldPaths || []).slice().sort(), ALLOWED_PROJECTION_PATHS.slice().sort())) throw fail('C34_BUNDLE_SET_B_MISMATCH');
  const expectedBudget = contract.mutationBudget || { INSERT: 500, UPDATE: 8, DELETE: 0 };
  if (Number(budget.INSERT) !== Number(expectedBudget.INSERT) || Number(budget.UPDATE) !== Number(expectedBudget.UPDATE) ||
      Number(budget.DELETE) !== Number(expectedBudget.DELETE)) throw fail('C34_BUNDLE_BUDGET_MISMATCH');
  const expectedOrder = ['A_PRECHECK_AND_APPLY', 'A_READBACK_VERIFY_ALL_500', 'B_PRECHECK_ALL_8',
    'B_SINGLE_TRANSACTION_UPDATE_8', 'B_READBACK_VERIFY_ALL_8', 'COMPOSITE_COMPLETE'];
  if (!sameJson(bundle.executionOrder, expectedOrder)) throw fail('C34_BUNDLE_ORDER_MISMATCH');
  const runtime = bundle.runtimeBoundary || {};
  if (runtime.character_runtime_specs !== 'DEFER' || runtime.specJsonRead !== false || runtime.specJsonWrite !== false ||
      runtime.runtimeBindingChanged !== false || (runtime.providerRebind != null && runtime.providerRebind !== false) || runtime.providerCalls !== 0 ||
      runtime.activeRearm !== false) throw fail('C34_BUNDLE_RUNTIME_BOUNDARY_MISMATCH');
  const approvalPolicy = bundle.approvalPolicy || {};
  if (approvalPolicy.type !== 'EXPLICIT_COMPOSITE_RECONSTRUCTION_APPROVAL' || Number(approvalPolicy.userApprovalCount) !== 1) {
    throw fail('C34_BUNDLE_APPROVAL_POLICY_INVALID');
  }
}

function validateApproval(approval, bundleHash, contract) {
  if (!isPlainObject(approval) || approval.type !== 'EXPLICIT_COMPOSITE_RECONSTRUCTION_APPROVAL' ||
      String(approval.bundleHash || '').toLowerCase() !== bundleHash ||
      String(approval.writeSetAHash || '').toLowerCase() !== contract.writeSetA.writeSetSha256 ||
      String(approval.writeSetBHash || '').toLowerCase() !== contract.writeSetB.writeSetSha256 ||
      approval.planId !== contract.planId || approval.targetSnapshotSha256 !== contract.targetSnapshotSha256 ||
      approval.oneUse !== true) throw fail('C34_COMPOSITE_APPROVAL_INVALID');
}

function validateWriteSetA(writeSet, proposal, recordsByDomain, contract, proposalArtifactSha256, options) {
  options = options || {};
  if (!isPlainObject(writeSet) || writeSet.schema !== contract.writeSetA.schema || Number(writeSet.version) !== 1 ||
      writeSet.operation !== 'INSERT' || String(writeSet.writeSetSha256 || '').toLowerCase() !== contract.writeSetA.writeSetSha256 ||
      hashWithout(writeSet, ['writeSetSha256', 'status']) !== contract.writeSetA.writeSetSha256) throw fail('C34_SET_A_HASH_MISMATCH');
  const suppliedArtifactHash = String(proposalArtifactSha256 || (proposal && proposal.artifactSha256) || '').toLowerCase();
  if (!isPlainObject(proposal) || suppliedArtifactHash !== contract.writeSetA.proposalArtifactSha256 ||
      !Array.isArray(proposal.items)) throw fail('C34_PROPOSAL_ARTIFACT_MISMATCH');
  const opCounts = {};
  for (const item of proposal.items) {
    const op = String(item && item.operation || '');
    opCounts[op] = (opCounts[op] || 0) + 1;
    if (op === 'UPDATE' || op === 'DELETE') throw fail('C34_FORBIDDEN_SET_A_OPERATION');
  }
  const expectedOps = contract.writeSetA.operationCounts;
  if (!expectedOps || opCounts.INSERT !== expectedOps.INSERT || Number(opCounts.DEFER || 0) !== Number(expectedOps.DEFER || 0) ||
      Number(opCounts.NOOP || 0) !== Number(expectedOps.NOOP || 0) ||
      insertSubsetHash(proposal.items) !== contract.writeSetA.insertSubsetSha256) throw fail('C34_SET_A_ITEM_HASH_MISMATCH');
  const insertItems = proposal.items.filter(item => item.operation === 'INSERT');
  if (insertItems.length !== Number(contract.writeSetA.rows)) throw fail('C34_SET_A_INSERT_COUNT_MISMATCH');
  const counts = {};
  const proposalKeys = new Set();
  for (const item of insertItems) {
    if (!Object.prototype.hasOwnProperty.call(contract.writeSetA.counts, item.table) ||
        !item.source || TABLE_FOR_DOMAIN[item.source.domain] !== item.table || item.source.planId !== contract.planId ||
        !/^[a-f0-9]{64}$/i.test(String(item.source.recordSha256 || ''))) throw fail('C34_SET_A_TABLE_OR_SOURCE_BINDING_INVALID');
    const exactKey = String(item.source.domain) + '|' + String(item.table) + '|' + String(item.stableKey || '');
    if (!item.stableKey || proposalKeys.has(exactKey)) throw fail('C34_SET_A_DUPLICATE_PROPOSAL_KEY', exactKey);
    proposalKeys.add(exactKey);
    counts[item.table] = (counts[item.table] || 0) + 1;
  }
  for (const table of Object.keys(contract.writeSetA.counts)) {
    if (counts[table] !== contract.writeSetA.counts[table]) throw fail('C34_SET_A_DOMAIN_COUNT_MISMATCH', table);
  }
  if (options.allowMissingSourceRecords === true && recordsByDomain == null) {
    return { items: insertItems, records: null, sourceBodiesValidated: false };
  }
  const records = new Map();
  for (const domain of DOMAINS) {
    const rows = recordsByDomain && recordsByDomain[domain];
    if (!Array.isArray(rows)) throw fail('C34_SOURCE_DOMAIN_MISSING', domain);
    for (const row of rows) {
      const key = String(row && row.stableKey || '');
      if (!key || !row.record || String(row.record.id || '') !== key || records.has(domain + '|' + key)) {
        throw fail('C34_SOURCE_KEY_INVALID', { domain: domain, key: key });
      }
      records.set(domain + '|' + key, row);
    }
  }
  if (records.size !== Number(contract.writeSetA.rows)) throw fail('C34_SOURCE_ROW_COUNT_MISMATCH');
  if (proposalKeys.size !== records.size) throw fail('C34_SET_A_EXACT_KEYSET_MISMATCH');
  for (const item of insertItems) {
    const domain = item.source && item.source.domain;
    const table = TABLE_FOR_DOMAIN[domain];
    const row = records.get(domain + '|' + String(item.stableKey));
    if (!row || table !== item.table || item.source.planId !== contract.planId ||
        stableHash(row.record) !== String(item.source.recordSha256 || '').toLowerCase()) {
      throw fail('C34_SOURCE_RECORD_BINDING_MISMATCH', { table: item.table, stableKey: item.stableKey });
    }
  }
  return { items: insertItems, records: records };
}

function exactIdSet(actual, expected) {
  const a = actual.map(String).sort();
  const e = expected.map(String).sort();
  return a.length === e.length && sameJson(a, e) && new Set(a).size === a.length;
}

class HomeNodeReconstructionExecutor {
  constructor(adapter, contract) { this.adapter = adapter; this.contract = contract; }

  async prepare(input) {
    const validated = validateWriteSetA(input.writeSetA, input.proposal, input.recordsByDomain, this.contract,
      input.proposalArtifactSha256);
    const adapter = this.adapter || {};
    for (const name of ['classifyExistingRecords', 'putMessages', 'putMemoryRecords', 'writeMigratedMoment',
      'readbackDomainRecordDigests', 'verifyReferencesAndProvenance']) {
      if (typeof adapter[name] !== 'function') throw fail('C34_SET_A_ADAPTER_INCOMPLETE', name);
    }
    const byDomain = Object.fromEntries(DOMAINS.map(domain => [domain, []]));
    for (const item of validated.items) {
      const domain = item.source.domain;
      const record = validated.records.get(domain + '|' + String(item.stableKey));
      byDomain[domain].push({ item: item, stableKey: record.stableKey, record: record });
    }
    const plans = {};
    /* Read-only classification of every key/domain precedes any A or B write. */
    for (const domain of DOMAINS) {
      const entries = byDomain[domain];
      const states = await adapter.classifyExistingRecords(domain, entries.map(entry => ({
        stableKey: entry.stableKey,
        sourceRecordSha256: entry.item.source.recordSha256,
        record: entry.record.record
      })));
      if (!Array.isArray(states) || states.length !== entries.length) throw fail('C34_SET_A_PREFLIGHT_KEYSET_MISMATCH', domain);
      const stateByKey = new Map();
      for (const row of states) {
        const key = String(row && row.stableKey || '');
        if (!key || stateByKey.has(key) || !['absent', 'identical', 'conflict'].includes(row.status)) {
          throw fail('C34_SET_A_PREFLIGHT_RESULT_INVALID', domain);
        }
        stateByKey.set(key, row);
      }
      if (stateByKey.size !== entries.length || entries.some(entry => !stateByKey.has(String(entry.stableKey)))) {
        throw fail('C34_SET_A_PREFLIGHT_KEYSET_MISMATCH', domain);
      }
      let identical = 0;
      const pending = [];
      for (const entry of entries) {
        const current = stateByKey.get(String(entry.stableKey));
        if (!current) throw fail('C34_SET_A_PREFLIGHT_KEY_MISSING', entry.stableKey);
        if (current.status === 'conflict') throw fail('C34_DUPLICATE_CONTENT_CONFLICT', { domain: domain, stableKey: entry.stableKey });
        if (current.status === 'identical') identical++;
        else pending.push(entry);
      }
      plans[domain] = { entries: entries, pending: pending, identical: identical };
    }
    return { plans: plans, validated: validated, bundle: input.bundle, writeSetA: input.writeSetA };
  }

  async prepareDryRun(input) {
    const validated = validateWriteSetA(input.writeSetA, input.proposal, null, this.contract,
      input.proposalArtifactSha256, { allowMissingSourceRecords: true });
    const adapter = this.adapter || {};
    if (typeof adapter.classifyExistingRecords !== 'function') throw fail('C35_READONLY_ADAPTER_INCOMPLETE', 'classifyExistingRecords');
    const byDomain = Object.fromEntries(DOMAINS.map(domain => [domain, []]));
    for (const item of validated.items) {
      byDomain[item.source.domain].push({ item: item, stableKey: item.stableKey });
    }
    const domains = {};
    let absent = 0;
    let identical = 0;
    let conflict = 0;
    for (const domain of DOMAINS) {
      const entries = byDomain[domain];
      const states = await adapter.classifyExistingRecords(domain, entries.map(entry => ({
        stableKey: entry.stableKey,
        sourceRecordSha256: entry.item.source.recordSha256,
        record: null
      })));
      if (!Array.isArray(states) || states.length !== entries.length) throw fail('C35_A_DRYRUN_KEYSET_MISMATCH', domain);
      const stateByKey = new Map();
      for (const row of states) {
        const key = String(row && row.stableKey || '');
        if (!key || stateByKey.has(key) || !['absent', 'identical', 'conflict'].includes(row.status)) {
          throw fail('C35_A_DRYRUN_RESULT_INVALID', domain);
        }
        stateByKey.set(key, row);
      }
      if (stateByKey.size !== entries.length || entries.some(entry => !stateByKey.has(String(entry.stableKey)))) {
        throw fail('C35_A_DRYRUN_KEYSET_MISMATCH', domain);
      }
      const counts = { planned: entries.length, absent: 0, identical: 0, conflict: 0 };
      for (const entry of entries) {
        const status = stateByKey.get(String(entry.stableKey)).status;
        counts[status]++;
      }
      absent += counts.absent;
      identical += counts.identical;
      conflict += counts.conflict;
      domains[domain] = counts;
    }
    return {
      planned: Number(this.contract.writeSetA.rows),
      operationCounts: { INSERT: Number(this.contract.writeSetA.rows), UPDATE: 0, DELETE: 0 },
      duplicateState: { absent: absent, identical: identical, conflict: conflict },
      domains: domains,
      exactKeySetVerified: true,
      proposalArtifactSha256: this.contract.writeSetA.proposalArtifactSha256,
      insertSubsetCanonicalSha256: this.contract.writeSetA.insertSubsetSha256,
      sourceBodiesRead: false
    };
  }

  async apply(prepared) {
    if (!prepared || !prepared.plans || !prepared.validated) throw fail('C34_SET_A_PREFLIGHT_REQUIRED');
    const adapter = this.adapter;
    const state = { phase: 'A_APPLY', status: 'A_STARTED', inserted: 0, alreadyPresent: 0, domains: {} };
    try {
      for (const domain of DOMAINS) {
        const plan = prepared.plans[domain];
        let inserted = 0;
        let skipped = plan.identical;
        state.currentDomain = domain;
        if (domain === 'moments') {
          state.alreadyPresent += plan.identical;
          for (const entry of plan.pending) {
            const result = await adapter.writeMigratedMoment(entry.record.record, {
              requestId: 'c3.4:' + this.contract.bundleId + ':moment:' + entry.record.stableKey
            });
            const outcome = result && (result.outcome || result.status);
            if (!result || result.ok === false || (outcome !== 'created' && outcome !== 'skipped')) {
              throw fail('C34_MOMENT_INSERT_FAILED', entry.record.stableKey);
            }
            if (outcome === 'created') {
              inserted++;
              state.inserted++;
            } else {
              skipped++;
              state.alreadyPresent++;
            }
            state.domains[domain] = { planned: plan.entries.length, inserted: inserted,
              alreadyPresentOrSkipped: skipped, readbackVerified: false };
          }
        } else if (plan.pending.length) {
          const batch = plan.pending.map(entry => entry.record.record);
          const requestId = 'c3.4:' + this.contract.bundleId + ':' + domain;
          const result = domain === 'chatMessages'
            ? await adapter.putMessages(batch, { existingPolicy: 'skip', requestId: requestId })
            : await adapter.putMemoryRecords(batch, { existingPolicy: 'skip', requestId: requestId });
          if (!result || result.ok !== true) throw fail('C34_DOMAIN_INSERT_FAILED', domain);
          const summary = result.summary || result;
          inserted = Number(summary.created || 0);
          skipped += Number(summary.skipped || 0);
          if (Number(summary.updated || 0) !== 0 || Number(summary.deleted || 0) !== 0 || inserted + skipped !== plan.entries.length) {
            throw fail('C34_NON_INSERT_OUTCOME', domain);
          }
          state.inserted += inserted;
          state.alreadyPresent += skipped;
        }
        if (!state.domains[domain]) state.domains[domain] = { planned: plan.entries.length, inserted: inserted,
          alreadyPresentOrSkipped: skipped, readbackVerified: false };
        const expected = plan.entries.map(entry => ({
          stableKey: entry.record.stableKey,
          sourceRecordSha256: entry.item.source.recordSha256,
          record: entry.record.record
        }));
        const readback = await adapter.readbackDomainRecordDigests(domain, expected);
        if (!Array.isArray(readback) || readback.length !== expected.length) throw fail('C34_DOMAIN_READBACK_KEYSET_MISMATCH', domain);
        const verified = new Map(readback.map(row => [String(row && row.stableKey || ''), row]));
        if (verified.size !== expected.length || expected.some(row => !verified.has(String(row.stableKey))) ||
            readback.some(row => !row || !expected.some(expectedRow => String(expectedRow.stableKey) === String(row.stableKey)))) {
          throw fail('C34_DOMAIN_READBACK_KEYSET_MISMATCH', domain);
        }
        for (const item of expected) {
          const row = verified.get(String(item.stableKey));
          if (!row || row.verified !== true || String(row.sourceRecordSha256 || '').toLowerCase() !== String(item.sourceRecordSha256).toLowerCase()) {
            throw fail('C34_DOMAIN_READBACK_DIGEST_MISMATCH', { domain: domain, stableKey: item.stableKey });
          }
        }
        state.domains[domain].readbackVerified = true;
      }
      delete state.currentDomain;
      state.phase = 'A_REFERENCE_PROVENANCE_VERIFY';
      const integrity = await adapter.verifyReferencesAndProvenance({ bundle: prepared.bundle, writeSetA: prepared.writeSetA });
      if (!integrity || integrity.ok !== true || Number(integrity.provenanceRecordCount) !== this.contract.provenanceRecordCount ||
          integrity.provenanceDigest !== this.contract.provenanceDigest) throw fail('C34_REFERENCE_OR_PROVENANCE_VERIFY_FAILED');
      state.phase = 'A_VERIFIED';
      state.status = 'A_VERIFIED';
      return cloneJson(state);
    } catch (error) {
      state.status = 'A_FAILED_OR_PARTIAL';
      state.failureCode = String(error && error.code || 'C34_A_FAILED');
      error.executionState = cloneJson(state);
      throw error;
    }
  }

  async execute(input) { return this.apply(await this.prepare(input)); }
}

function normalizeSemanticCapabilities(value) {
  if (!isPlainObject(value) || Object.keys(value).some(key => CAPABILITY_KEYS.indexOf(key) < 0)) throw fail('C34_CAPABILITIES_SHAPE_INVALID');
  const out = {};
  for (const key of CAPABILITY_KEYS) {
    if (typeof value[key] !== 'boolean') throw fail('C34_CAPABILITY_BOOLEAN_REQUIRED', key);
    out[key] = value[key];
  }
  if (out.chat !== true) throw fail('C34_CHAT_CAPABILITY_REQUIRED');
  return out;
}
function capabilitiesForDto(semantic) {
  const value = normalizeSemanticCapabilities(semantic);
  const dto = { chat: true, stream: value.stream, vision: value.vision, webSearch: value.webSearch };
  if (value.imageGen) dto.imageGen = true;
  return dto;
}

function validateWriteSetB(writeSet, contract) {
  if (!isPlainObject(writeSet) || writeSet.schema !== contract.writeSetB.schema || Number(writeSet.version) !== 1 ||
      String(writeSet.writeSetSha256 || '').toLowerCase() !== contract.writeSetB.writeSetSha256 ||
      hashWithout(writeSet, ['writeSetSha256']) !== contract.writeSetB.writeSetSha256 ||
      writeSet.operation !== 'UPDATE' || writeSet.table !== 'characters' || writeSet.storageColumn !== 'dto_json' ||
      Number(writeSet.rowCount) !== contract.writeSetB.rows || Number(writeSet.updateCount) !== contract.writeSetB.rows ||
      Number(writeSet.deleteCount) !== 0) throw fail('C34_SET_B_HASH_OR_SCOPE_INVALID');
  if (!Array.isArray(writeSet.rows) || writeSet.rows.length !== contract.writeSetB.rows) throw fail('C34_SET_B_ROW_COUNT_INVALID');
  const ids = writeSet.rows.map(row => String(row && row.key && row.key.id || '')).sort();
  if (!exactIdSet(ids, contract.writeSetB.ids)) throw fail('C34_SET_B_ID_SET_INVALID');
  let models = 0;
  let capabilities = 0;
  for (const row of writeSet.rows) {
    if (row.operation !== 'UPDATE' || row.table !== 'characters' || !Array.isArray(row.fieldPaths) ||
        row.fieldPaths.some(path => ALLOWED_PROJECTION_PATHS.indexOf(path) < 0) ||
        !isPlainObject(row.fieldAuthority) || !Array.isArray(row.preserveUnchangedFields) ||
        !['id', 'dto_json.name', 'dto_json.avatar', 'dto_json.relationship'].every(field => row.preserveUnchangedFields.includes(field))) {
      throw fail('C34_SET_B_FORBIDDEN_FIELD_OR_TABLE', row && row.key && row.key.id);
    }
    if (!/^[a-f0-9]{64}$/i.test(String(row.expectedCurrentProjectionSha256 || '')) ||
        !/^[a-f0-9]{64}$/i.test(String(row.expectedAuthorityProjectionSha256 || ''))) throw fail('C34_SET_B_DIGEST_INVALID');
    const fields = row.fieldPaths.map(path => path.slice('characters.dto_json.'.length)).sort();
    if (!isPlainObject(row.beforeValues) || !isPlainObject(row.afterValues) ||
        !sameJson(fields, Object.keys(row.beforeValues).sort()) || !sameJson(fields, Object.keys(row.afterValues).sort())) {
      throw fail('C34_SET_B_FIELD_PATH_VALUE_MISMATCH', row.key.id);
    }
    if (fields.includes('model')) {
      models++;
      if (row.fieldAuthority.model !== 'AUTHORITATIVE_WEB_CORE' || typeof row.afterValues.model !== 'string') throw fail('C34_SET_B_MODEL_AUTHORITY_INVALID');
    }
    if (fields.includes('capabilities')) {
      capabilities++;
      if (row.fieldAuthority.capabilities !== 'DERIVED_RUNTIME_PROJECTION') throw fail('C34_SET_B_CAPABILITY_AUTHORITY_INVALID');
      normalizeSemanticCapabilities(row.afterValues.capabilities);
    }
  }
  if (models !== contract.writeSetB.modelAssignments || capabilities !== contract.writeSetB.capabilityAssignments) {
    throw fail('C34_SET_B_FIELD_ASSIGNMENT_COUNT_MISMATCH');
  }
  return writeSet.rows;
}

class CharacterProjectionExecutor {
  constructor(store, contract) { this.store = store; this.contract = contract; }

  async prepare(writeSet) {
    const rows = validateWriteSetB(writeSet, this.contract);
    if (!this.store || typeof this.store.readCharacterDtoProjections !== 'function') throw fail('C34_PROJECTION_STORE_INCOMPLETE');
    const read = await this.store.readCharacterDtoProjections(rows.map(row => row.key.id));
    if (!read || read.ok !== true || !Array.isArray(read.rows)) throw fail('C34_PROJECTION_READ_FAILED');
    if (!exactIdSet(read.rows.map(row => String(row && row.id || '')), rows.map(row => row.key.id))) {
      throw fail('C34_PROJECTION_READ_KEYSET_MISMATCH');
    }
    const currentById = new Map(read.rows.map(row => [String(row.id), row]));
    const updates = [];
    const afterDigests = new Map();
    for (const row of rows) {
      const id = String(row.key.id);
      const entry = currentById.get(id);
      if (!entry || entry.exists !== true || !isPlainObject(entry.dto) || String(entry.dto.id || '') !== id) throw fail('C34_PROJECTION_TARGET_MISSING', id);
      const before = entry.dto;
      const beforeDigest = stableHash(before);
      if (beforeDigest !== String(row.expectedCurrentProjectionSha256).toLowerCase()) throw fail('C34_PROJECTION_BEFORE_DIGEST_MISMATCH', id);
      const next = cloneJson(before);
      const fields = row.fieldPaths.map(path => path.slice('characters.dto_json.'.length));
      if (fields.includes('model')) {
        if (before.model !== row.beforeValues.model) throw fail('C34_PROJECTION_BEFORE_MODEL_MISMATCH', id);
        next.model = row.afterValues.model;
      }
      if (fields.includes('capabilities')) {
        if (!sameJson(normalizeSemanticCapabilities(before.capabilities), normalizeSemanticCapabilities(row.beforeValues.capabilities))) {
          throw fail('C34_PROJECTION_BEFORE_CAPABILITIES_MISMATCH', id);
        }
        next.capabilities = capabilitiesForDto(row.afterValues.capabilities);
      }
      for (const field of ['id', 'name', 'avatar', 'relationship']) {
        if (!sameJson(before[field], next[field])) throw fail('C34_PROJECTION_PROTECTED_FIELD_CHANGED', { id: id, field: field });
      }
      const changedFields = Object.keys(Object.assign({}, before, next)).filter(key => !sameJson(before[key], next[key])).sort();
      if (!sameJson(changedFields, fields.slice().sort())) throw fail('C34_PROJECTION_MUTATED_FORBIDDEN_FIELD', id);
      const afterDigest = stableHash(next);
      afterDigests.set(id, afterDigest);
      updates.push({
        id: id, fieldPaths: row.fieldPaths,
        expectedBeforeDtoSha256: beforeDigest,
        expectedAfterDtoSha256: afterDigest,
        beforeDtoSha256: beforeDigest,
        authoritySourceProjectionSha256: row.expectedAuthorityProjectionSha256,
        nextDto: next
      });
    }
    return { writeSet: writeSet, rows: rows, updates: updates, afterDigests: afterDigests };
  }

  async apply(prepared) {
    if (!prepared || !Array.isArray(prepared.rows) || !Array.isArray(prepared.updates) || !prepared.afterDigests) {
      throw fail('C34_PROJECTION_PREFLIGHT_REQUIRED');
    }
    const rows = prepared.rows;
    if (!this.store || typeof this.store.applyCharacterDtoProjectionBatch !== 'function') throw fail('C34_PROJECTION_STORE_INCOMPLETE');
    let applied;
    try { applied = await this.store.applyCharacterDtoProjectionBatch(prepared.updates); }
    catch (error) {
      error.code = error.code || 'C34_PROJECTION_TRANSACTION_FAILED';
      error.transactionRolledBack = true;
      throw error;
    }
    if (!applied || applied.ok !== true || Number(applied.updated) !== rows.length || Number(applied.deleted || 0) !== 0) {
      const error = fail('C34_PROJECTION_TRANSACTION_FAILED', applied && applied.code);
      error.transactionRolledBack = !!(applied && applied.transactionRolledBack);
      throw error;
    }
    const readback = await this.store.readCharacterDtoProjections(rows.map(row => row.key.id));
    if (!readback || readback.ok !== true || !Array.isArray(readback.rows)) throw fail('C34_PROJECTION_READBACK_FAILED');
    if (!exactIdSet(readback.rows.map(row => String(row && row.id || '')), rows.map(row => row.key.id))) {
      const error = fail('C34_PROJECTION_READBACK_KEYSET_MISMATCH');
      error.transactionCommitted = true;
      throw error;
    }
    const afterById = new Map(readback.rows.map(row => [String(row.id), row]));
    for (const row of rows) {
      const id = String(row.key.id);
      const actual = afterById.get(id);
      if (!actual || actual.exists !== true || !isPlainObject(actual.dto) || stableHash(actual.dto) !== prepared.afterDigests.get(id)) {
        const error = fail('C34_PROJECTION_AFTER_DIGEST_MISMATCH', id);
        error.transactionCommitted = true;
        throw error;
      }
    }
    return { status: 'B_VERIFIED', updated: rows.length, deleted: 0,
      rows: rows.map(row => ({ id: row.key.id,
        beforeDtoSha256: prepared.updates.find(update => update.id === row.key.id).beforeDtoSha256,
        afterDtoSha256: prepared.afterDigests.get(row.key.id) })) };
  }

  async execute(writeSet) { return this.apply(await this.prepare(writeSet)); }
}

class CompositeReconstructionExecutor {
  constructor(options) {
    options = options || {};
    const synthetic = options.testToken === TEST_TOKEN;
    if (options.testToken && !synthetic) throw fail('C34_SYNTHETIC_CONTRACT_REJECTED');
    if (synthetic && (!COMMON_JS || process.env.IB_P32_W5_C34_SYNTHETIC_TESTS !== '1')) throw fail('C34_SYNTHETIC_HOOK_DISABLED');
    this.contract = synthetic ? options.contract : FROZEN;
    if (!this.contract) throw fail('C34_CONTRACT_REQUIRED');
    this.synthetic = synthetic;
    this.adapter = options.homeNodeAdapter || null;
    this.projectionStore = options.projectionStore || null;
    this.aExecutor = new HomeNodeReconstructionExecutor(this.adapter, this.contract);
    this.bExecutor = new CharacterProjectionExecutor(this.projectionStore, this.contract);
  }

  async _verifyPreflight(input) {
    validateBundle(input.bundle, input.bundleHash, this.contract);
    validateApproval(input.approval, input.bundleHash, this.contract);
    const adapter = this.adapter || {};
    for (const method of ['getEnvironmentSnapshot', 'getTargetIdentity', 'verifyCompositeApproval']) {
      if (typeof adapter[method] !== 'function') throw fail('C34_COMPOSITE_ADAPTER_INCOMPLETE', method);
    }
    const env = await adapter.getEnvironmentSnapshot();
    if (!env || env.recoveryOnly !== true || env.normalRuntimeStopped !== true || env.activeQuarantined !== true ||
        env.consumedMarkerPresent !== false || env.providerCalls !== 0 || env.specJsonRead !== false) throw fail('C34_ENVIRONMENT_GATE_FAILED');
    const target = await adapter.getTargetIdentity();
    if (!target || target.databaseName !== this.contract.homeNodeTarget.databaseName || target.path !== this.contract.homeNodeTarget.path ||
        Number(target.schemaUserVersion) !== Number(this.contract.homeNodeTarget.schemaUserVersion) ||
        target.c1ObservedDatabaseSha256 !== this.contract.homeNodeTarget.c1ObservedDatabaseSha256 ||
        target.integrityCheck !== this.contract.homeNodeTarget.integrityCheck ||
        target.revalidationRequiredAtExecution !== this.contract.homeNodeTarget.revalidationRequiredAtExecution) throw fail('C34_TARGET_IDENTITY_MISMATCH');
    if (await adapter.verifyCompositeApproval(input.approval, input.bundle, input.bundleHash) !== true) throw fail('C34_COMPOSITE_APPROVAL_REJECTED');
  }

  async dryRun(input) {
    input = input || {};
    const adapter = this.adapter || {};
    const report = {
      schema: 'internalbeyond.p32-w5.r3-c3.5-production-reconstruction-dry-run',
      reportType: 'PRODUCTION_RECONSTRUCTION_DRY_RUN',
      version: 1,
      executionIdentity: 'p32w5-r3c3-c3.5-dryrun:' + crypto.randomUUID(),
      generatedAtUtc: new Date().toISOString(),
      planIdentity: { planId: this.contract.planId, planSha256: this.contract.planSha256,
        targetSnapshotSha256: this.contract.targetSnapshotSha256 },
      bundleIdentity: { bundleId: this.contract.bundleId, bundleSha256: this.contract.bundleHash },
      writeSetIdentities: { A: this.contract.writeSetA.writeSetSha256, B: this.contract.writeSetB.writeSetSha256 },
      status: 'DRY_RUN_BLOCKED',
      writesStarted: false,
      automaticRepair: false,
      blockers: [],
      writeSetA: null,
      writeSetB: null,
      provenance: null,
      authorityArtifacts: null,
      activity: null
    };
    let failureStage = 'bundle_validation';
    try {
      validateBundle(input.bundle, input.bundleHash, this.contract);
      failureStage = 'runtime_boundary';
      for (const method of ['getEnvironmentSnapshot', 'getTargetIdentity', 'verifyProductionBindings',
        'verifyReferencesAndProvenance', 'getActivityCounters']) {
        if (typeof adapter[method] !== 'function') throw fail('C35_PRODUCTION_ADAPTER_INCOMPLETE', method);
      }
      const env = await adapter.getEnvironmentSnapshot();
      if (!env || env.recoveryOnly !== true || env.normalRuntimeStopped !== true || env.activeQuarantined !== true ||
          env.consumedMarkerPresent !== false || env.providerCalls !== 0 || env.secretAccess !== false ||
          env.specJsonRead !== false || env.specJsonWrite !== false || env.runtimeBindingChanged !== false ||
          env.providerBindingChanged !== false) throw fail('C35_RUNTIME_BOUNDARY_FAILED');
      report.runtimeBoundary = env;
      failureStage = 'target_identity';
      const targetBefore = await adapter.getTargetIdentity();
      if (!targetBefore || targetBefore.databaseName !== this.contract.homeNodeTarget.databaseName ||
          targetBefore.path !== this.contract.homeNodeTarget.path ||
          Number(targetBefore.schemaUserVersion) !== Number(this.contract.homeNodeTarget.schemaUserVersion) ||
          targetBefore.c1ObservedDatabaseSha256 !== this.contract.homeNodeTarget.c1ObservedDatabaseSha256 ||
          targetBefore.integrityCheck !== this.contract.homeNodeTarget.integrityCheck) throw fail('C35_TARGET_IDENTITY_MISMATCH');
      report.targetIdentity = targetBefore;
      failureStage = 'authority_binding';
      const binding = await adapter.verifyProductionBindings({
        bundle: input.bundle, bundleHash: input.bundleHash, writeSetA: input.writeSetA, writeSetB: input.writeSetB,
        proposal: input.proposal, proposalArtifactSha256: input.proposalArtifactSha256
      });
      if (!binding || binding.ok !== true) throw fail('C35_PRODUCTION_BINDING_MISMATCH', binding && binding.code);
      report.authorityArtifacts = binding.authorityArtifacts;
      failureStage = 'write_set_a_preflight';
      const writeSetA = await this.aExecutor.prepareDryRun(input);
      report.writeSetA = writeSetA;
      failureStage = 'write_set_b_preflight';
      const writeSetBRows = validateWriteSetB(input.writeSetB, this.contract);
      const preparedB = await this.bExecutor.prepare(input.writeSetB);
      report.writeSetB = {
        planned: writeSetBRows.length,
        operationCounts: { INSERT: 0, UPDATE: writeSetBRows.length, DELETE: 0 },
        rows: preparedB.updates.map(update => ({
          stableId: update.id,
          expectedBeforeDtoSha256: update.expectedBeforeDtoSha256,
          expectedAfterDtoSha256: update.expectedAfterDtoSha256,
          changedFieldPaths: update.fieldPaths.slice().sort(),
          allowedFieldDiffOnly: true
        }))
      };
      failureStage = 'provenance';
      const provenance = await adapter.verifyReferencesAndProvenance({
        bundle: input.bundle, writeSetA: input.writeSetA, proposal: input.proposal,
        proposalArtifactSha256: input.proposalArtifactSha256, readOnly: true
      });
      if (!provenance || provenance.ok !== true || Number(provenance.recordCount) !== this.contract.provenanceRecordCount ||
          provenance.traceDigest !== this.contract.provenanceDigest || provenance.sourcePrimarySha256 !== this.contract.sourcePrimarySha256) {
        throw fail('C35_PROVENANCE_BINDING_FAILED');
      }
      failureStage = 'target_revalidation';
      const targetAfter = await adapter.getTargetIdentity();
      if (!targetAfter || !sameJson(targetBefore, targetAfter)) throw fail('C35_TARGET_DRIFT_DURING_DRYRUN');
      failureStage = 'activity_counters';
      const activity = await adapter.getActivityCounters();
      if (!activity || Number(activity.productionWrites) !== 0 || Number(activity.homeNodeWrites) !== 0 || Number(activity.indexedDbWrites) !== 0 ||
          Number(activity.providerCalls) !== 0 || Number(activity.secretAccess) !== 0 || Number(activity.specJsonReads) !== 0 ||
          Number(activity.specJsonWrites) !== 0 || Number(activity.approvalIssued) !== 0 ||
          Number(activity.checkpointCreated) !== 0 || Number(activity.applyWindowOpened) !== 0) throw fail('C35_READONLY_ACTIVITY_VIOLATION');
      report.provenance = { recordCount: provenance.recordCount, traceDigest: provenance.traceDigest,
        sourcePrimarySha256: provenance.sourcePrimarySha256, status: 'FROZEN_BINDING_VERIFIED' };
      report.activity = activity;
      report.blockers = writeSetA.duplicateState.conflict > 0 ? ['A_DUPLICATE_CONTENT_CONFLICT'] : [];
      report.status = report.blockers.length ? 'DRY_RUN_BLOCKED' : 'DRY_RUN_PASS';
      if (report.blockers.length) {
        report.failureCode = report.blockers[0];
        report.failureStage = 'duplicate_policy';
      }
      return cloneJson(report);
    } catch (error) {
      report.blockers.push(String(error && error.code || 'C35_DRYRUN_FAILED'));
      report.failureCode = String(error && error.code || 'C35_DRYRUN_FAILED');
      report.failureStage = failureStage;
      report.failureDetails = error && error.details != null ? error.details : undefined;
      try { report.activity = await adapter.getActivityCounters(); } catch (_) { report.activity = null; }
      return cloneJson(report);
    }
  }

  async execute(input) {
    input = input || {};
    const state = { phase: 'PREFLIGHT', status: 'NOT_STARTED', writesStarted: false, setA: null, setB: null,
      partialCommitted: { setA: 'NOT_STARTED', setB: 'NOT_STARTED' }, automaticRepair: false };
    try {
      await this._verifyPreflight(input);
      /* Validate/classify both sets before the first mutation. */
      const preparedA = await this.aExecutor.prepare({
        bundle: input.bundle,
        writeSetA: input.writeSetA,
        proposal: input.proposal,
        proposalArtifactSha256: input.proposalArtifactSha256,
        recordsByDomain: input.recordsByDomain
      });
      /* Bind the exact B contract before A starts, but defer target DTO reads
         and before-digest checks until A has fully read back, as frozen in C3.3. */
      validateWriteSetB(input.writeSetB, this.contract);
      state.phase = 'A';
      state.status = 'A_RUNNING';
      state.writesStarted = true;
      state.setA = await this.aExecutor.apply(preparedA);
      if (!state.setA || state.setA.status !== 'A_VERIFIED') throw fail('C34_A_PHASE_NOT_VERIFIED');
      state.partialCommitted = { setA: 'VERIFIED', setB: 'NOT_STARTED' };
      state.phase = 'B_PREFLIGHT';
      const preparedB = await this.bExecutor.prepare(input.writeSetB);
      state.phase = 'B';
      state.status = 'B_RUNNING';
      state.setB = await this.bExecutor.apply(preparedB);
      if (!state.setB || state.setB.status !== 'B_VERIFIED') throw fail('C34_B_PHASE_NOT_VERIFIED');
      state.partialCommitted = { setA: 'VERIFIED', setB: 'VERIFIED' };
      state.phase = 'COMPOSITE';
      state.status = 'COMPOSITE_VERIFIED';
      return cloneJson(state);
    } catch (error) {
      if (!state.setA && error && error.executionState) state.setA = error.executionState;
      if (state.phase === 'PREFLIGHT') state.status = 'PREFLIGHT_FAILED_NO_WRITES';
      else if (state.phase === 'A') state.status = 'A_FAILED_OR_PARTIAL_B_NOT_STARTED';
      else if (state.phase === 'B_PREFLIGHT') state.status = 'PARTIAL_A_VERIFIED_B_NOT_STARTED';
      else if (state.phase === 'B') {
        if (error && error.transactionRolledBack) {
          state.status = 'A_VERIFIED_B_ROLLED_BACK';
          state.partialCommitted = { setA: 'VERIFIED', setB: 'ROLLED_BACK' };
        } else if (error && error.transactionCommitted) {
          state.status = 'A_VERIFIED_B_COMMITTED_READBACK_FAILED';
          state.partialCommitted = { setA: 'VERIFIED', setB: 'COMMITTED_UNVERIFIED' };
        } else {
          state.status = 'A_VERIFIED_B_FAILED_STOPPED';
        }
      }
      state.failureCode = String(error && error.code || 'C34_COMPOSITE_FAILED');
      error.executionState = cloneJson(state);
      throw error;
    }
  }
}

const testOnly = Object.freeze({
  stableJson: stableJson,
  stableHash: stableHash,
  stableInsertSubsetHash: insertSubsetHash,
  hashWriteSetA: value => hashWithout(value, ['writeSetSha256', 'status']),
  hashWriteSetB: value => hashWithout(value, ['writeSetSha256']),
  normalizeSemanticCapabilities: normalizeSemanticCapabilities,
  capabilitiesForDto: capabilitiesForDto,
  createSyntheticExecutor: function (options) {
    if (!COMMON_JS || process.env.IB_P32_W5_C34_SYNTHETIC_TESTS !== '1') throw fail('C34_SYNTHETIC_HOOK_DISABLED');
    return new CompositeReconstructionExecutor(Object.assign({}, options || {}, { testToken: TEST_TOKEN }));
  }
});

module.exports = Object.freeze({
  CompositeReconstructionExecutor: CompositeReconstructionExecutor,
  HomeNodeReconstructionExecutor: HomeNodeReconstructionExecutor,
  CharacterProjectionExecutor: CharacterProjectionExecutor,
  FROZEN_CONTRACT: FROZEN,
  stableJson: stableJson,
  stableHash: stableHash,
  testOnly: testOnly
});
