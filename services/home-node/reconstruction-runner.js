'use strict';

/* Earliest safe evidence that Node entered this CommonJS file. Keep this
   fixed marker before module imports and avoid all file/database access. */
if (require.main === module) {
  try { process.stderr.write('C35_NODE_ENTRY_REACHED\n'); } catch (_) { /* diagnostic only */ }
}

/* RecoveryOnly-only C3.5 runner. It accepts exactly one native Tauri dry-run
   invocation, loads the frozen packaged artifacts, and never exposes an apply
   mode or HTTP server. */
const BOOTSTRAP_MARKERS = Object.freeze([
  'C35_BOOTSTRAP_STARTED',
  'C35_BOOTSTRAP_MODULES_OK',
  'C35_BOOTSTRAP_ARGS_OK',
  'C35_BOOTSTRAP_ARGS_REJECTED',
  'C35_BOOTSTRAP_ADAPTER_BEGIN',
  'C35_BOOTSTRAP_ADAPTER_OK',
  'C35_BOOTSTRAP_ADAPTER_FAILED',
  'C35_BOOTSTRAP_PREFLIGHT_BEGIN',
  'C35_BOOTSTRAP_PREFLIGHT_OK',
  'C35_BOOTSTRAP_PREFLIGHT_FAILED',
  'C35_BOOTSTRAP_REQUEST_REJECTED',
  'C35_BOOTSTRAP_MAIN_CAUGHT'
]);
const BOOTSTRAP_MARKER_SET = new Set(BOOTSTRAP_MARKERS);
const RUNNER_ENTRY = require.main === module;
function bootstrapMarker(marker) {
  if (!RUNNER_ENTRY || !BOOTSTRAP_MARKER_SET.has(marker)) return;
  try { process.stderr.write(marker + '\n'); } catch (_) { /* diagnostics do not alter runner behavior */ }
}
bootstrapMarker('C35_BOOTSTRAP_STARTED');

const path = require('path');
const crypto = require('crypto');
const { ProductionReconstructionAdapter } = require('./production-reconstruction-adapter.js');
const Executor = require('./composite-reconstruction-executor.js');
const { CompositeReconstructionExecutor } = Executor;
bootstrapMarker('C35_BOOTSTRAP_MODULES_OK');

const DRY_RUN_ARG = '--p32w5-r3c3-c3.5-production-dry-run';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024;
const REPORT_SCHEMA = 'internalbeyond.p32-w5.r3-c3.5-production-reconstruction-dry-run';
const REPORT_TYPE = 'PRODUCTION_RECONSTRUCTION_DRY_RUN';
const TEST_ENABLED = process.env.IB_P32_W5_C35_SYNTHETIC_TESTS === '1';

function safeCode(code) {
  const value = String(code || 'C35_RUNNER_FAILED');
  return /^(?:C34|C35)_[A-Z0-9_]{1,88}$/.test(value) ? value : 'C35_RUNNER_FAILED';
}

function zeroActivity() {
  return {
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
}

function safeTargetIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hash = String(value.c1ObservedDatabaseSha256 || '').toLowerCase();
  if (value.databaseName !== 'home-node.db' || typeof value.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash) || value.identityBinding !== 'FROZEN_C1_DATABASE_SHA256_MATCH') return null;
  return {
    databaseName: 'home-node.db',
    path: value.path,
    c1ObservedDatabaseSha256: hash,
    identityBinding: 'FROZEN_C1_DATABASE_SHA256_MATCH'
  };
}

function safeSidecarAudit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schema !== 'internalbeyond.p32-w5.r3-c3.5-sidecar-audit' || value.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(String(value.metadataHash || '')) || !Array.isArray(value.entries)) return null;
  const entries = value.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || !['-wal', '-shm'].includes(entry.suffix) ||
        typeof entry.exists !== 'boolean' || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 ||
        !(entry.sha256 === null || /^[a-f0-9]{64}$/.test(String(entry.sha256))) ||
        !/^[A-Z0-9_]{1,64}$/.test(String(entry.structureStatus || ''))) return null;
    return {
      suffix: entry.suffix, exists: entry.exists, sizeBytes: entry.sizeBytes,
      sha256: entry.sha256, structureStatus: entry.structureStatus
    };
  });
  if (entries.length !== 2 || entries.some(entry => entry === null) ||
      entries[0].suffix !== '-wal' || entries[1].suffix !== '-shm') return null;
  const rawHolderAudit = value.holderAudit;
  if (!rawHolderAudit || typeof rawHolderAudit !== 'object' || Array.isArray(rawHolderAudit) ||
      rawHolderAudit.method !== 'WINDOWS_RESTART_MANAGER_READ_ONLY' || typeof rawHolderAudit.available !== 'boolean' ||
      !Array.isArray(rawHolderAudit.resources)) return null;
  const resources = rawHolderAudit.resources.map(item => {
    if (!item || typeof item !== 'object' || !['-wal', '-shm'].includes(item.suffix) ||
        typeof item.exists !== 'boolean' || !(item.holderCount === null ||
          (Number.isSafeInteger(item.holderCount) && item.holderCount >= 0))) return null;
    return { suffix: item.suffix, exists: item.exists, holderCount: item.holderCount };
  });
  if (resources.some(item => item === null)) return null;
  return {
    schema: value.schema,
    version: 1,
    metadataHash: value.metadataHash,
    entries: entries,
    holderAudit: { method: rawHolderAudit.method, available: rawHolderAudit.available, resources: resources }
  };
}

function safeRuntimeBoundary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safe = {};
  for (const field of ['recoveryOnly', 'normalRuntimeStopped', 'activeQuarantined', 'consumedMarkerPresent',
    'protectedPortsReleased', 'secretAccess', 'specJsonRead', 'specJsonWrite', 'runtimeBindingChanged', 'providerBindingChanged']) {
    if (typeof value[field] === 'boolean') safe[field] = value[field];
  }
  for (const field of ['providerCalls', 'serviceProcessCount', 'otherHostProcessCount', 'protectedPortListenerCount']) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) safe[field] = value[field];
  }
  const audit = value.homeNodeSidecarHolderAudit;
  if (audit && typeof audit === 'object' && !Array.isArray(audit)) {
    const resources = Array.isArray(audit.resources) ? audit.resources.map(item => {
      if (!item || typeof item !== 'object' || !['-wal', '-shm'].includes(item.suffix) ||
          typeof item.exists !== 'boolean' || !(item.holderCount === null ||
            (Number.isSafeInteger(item.holderCount) && item.holderCount >= 0))) return null;
      return { suffix: item.suffix, exists: item.exists, holderCount: item.holderCount };
    }) : [];
    if (resources.every(Boolean)) safe.homeNodeSidecarHolderAudit = {
      schema: 'internalbeyond.p32-w5.r3-c3.5-sidecar-holder-audit',
      method: audit.method === 'WINDOWS_RESTART_MANAGER_READ_ONLY' ? audit.method : 'UNAVAILABLE',
      available: audit.available === true,
      resources: resources
    };
  }
  return safe;
}

function safeFailure(code, options) {
  options = options || {};
  const failureCode = safeCode(code);
  const sidecarAudit = safeSidecarAudit(options.sidecarAudit);
  const contract = Executor.FROZEN_CONTRACT;
  const identityPrefix = 'p32w5-r3c3-c3.5-dryrun:';
  const activity = Object.assign(zeroActivity(), options.adapter && options.adapter.activity || {});
  return {
    schema: REPORT_SCHEMA,
    reportType: REPORT_TYPE,
    version: 1,
    executionIdentity: identityPrefix + crypto.randomUUID(),
    generatedAtUtc: new Date().toISOString(),
    planIdentity: {
      planId: contract.planId,
      planSha256: contract.planSha256,
      targetSnapshotSha256: contract.targetSnapshotSha256
    },
    bundleIdentity: { bundleId: contract.bundleId, bundleSha256: contract.bundleHash },
    writeSetIdentities: {
      A: contract.writeSetA.writeSetSha256,
      B: contract.writeSetB.writeSetSha256
    },
    ok: false,
    writeAllowed: false,
    applyAllowed: false,
    targetIdentity: safeTargetIdentity(options.targetIdentity),
    status: 'DRY_RUN_BLOCKED',
    writesStarted: false,
    automaticRepair: false,
    blockers: [failureCode],
    failureCode: failureCode,
    reasonCode: failureCode,
    failureStage: String(options.failureStage || 'runner_initialization'),
    writeSetA: {
      planned: contract.writeSetA.rows,
      operationCounts: { INSERT: 500, UPDATE: 0, DELETE: 0 }
    },
    writeSetB: {
      planned: contract.writeSetB.rows,
      operationCounts: { INSERT: 0, UPDATE: 8, DELETE: 0 }
    },
    provenance: null,
    authorityArtifacts: null,
    sidecarMetadataHash: sidecarAudit ? sidecarAudit.metadataHash : null,
    sidecarAudit: sidecarAudit,
    runtimeBoundary: safeRuntimeBoundary(options.nativeProof),
    activity: activity
  };
}

async function runRecoveryOnlyDryRun(argv, stdinText, options) {
  options = options || {};
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== DRY_RUN_ARG) {
    bootstrapMarker('C35_BOOTSTRAP_ARGS_REJECTED');
    return safeFailure('C35_RUNNER_MODE_REJECTED', { failureStage: 'request_validation' });
  }
  if (Buffer.byteLength(String(stdinText || ''), 'utf8') > MAX_INPUT_BYTES) {
    bootstrapMarker('C35_BOOTSTRAP_REQUEST_REJECTED');
    return safeFailure('C35_NATIVE_PROOF_TOO_LARGE', { failureStage: 'request_validation' });
  }
  let request;
  try { request = JSON.parse(String(stdinText || '')); }
  catch (_) {
    bootstrapMarker('C35_BOOTSTRAP_REQUEST_REJECTED');
    return safeFailure('C35_NATIVE_PROOF_INVALID', { failureStage: 'request_validation' });
  }
  if (!request || request.schema !== 'internalbeyond.p32-w5.r3-c3.5-recovery-only-dry-run-request' ||
      request.version !== 1 || request.mode !== 'RECOVERY_ONLY_DRY_RUN' || !request.nativeProof) {
    bootstrapMarker('C35_BOOTSTRAP_REQUEST_REJECTED');
    return safeFailure('C35_NATIVE_PROOF_INVALID', { failureStage: 'request_validation' });
  }
  bootstrapMarker('C35_BOOTSTRAP_ARGS_OK');

  let adapter = null;
  let failureStage = 'adapter_open';
  try {
    const resourceRoot = path.resolve(options.resourceRoot || path.join(__dirname, '..', '..'));
    bootstrapMarker('C35_BOOTSTRAP_ADAPTER_BEGIN');
    if (typeof options.adapterFactory === 'function') {
      if (!TEST_ENABLED) throw Object.assign(new Error('C35_SYNTHETIC_HOOK_DISABLED'), { code: 'C35_SYNTHETIC_HOOK_DISABLED' });
      adapter = await options.adapterFactory({ mode: 'RECOVERY_ONLY', nativeProof: request.nativeProof,
        localAppData: request.localAppData, resourceRoot: resourceRoot });
    } else {
      adapter = await ProductionReconstructionAdapter.openForRecoveryOnly({
        mode: 'RECOVERY_ONLY', nativeProof: request.nativeProof,
        localAppData: request.localAppData, resourceRoot: resourceRoot
      });
    }
    bootstrapMarker('C35_BOOTSTRAP_ADAPTER_OK');
    failureStage = 'frozen_input';
    const input = adapter.frozenInputs();
    const executor = new CompositeReconstructionExecutor({ homeNodeAdapter: adapter, projectionStore: adapter });
    bootstrapMarker('C35_BOOTSTRAP_PREFLIGHT_BEGIN');
    failureStage = 'composite_dry_run';
    const result = await executor.dryRun(input);
    bootstrapMarker('C35_BOOTSTRAP_PREFLIGHT_OK');
    result.reportType = REPORT_TYPE;
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_OUTPUT_BYTES) {
      return safeFailure('C35_DRYRUN_REPORT_TOO_LARGE', {
        failureStage: 'report_serialization', nativeProof: request.nativeProof, adapter: adapter
      });
    }
    return result;
  } catch (error) {
    if (failureStage === 'adapter_open') bootstrapMarker('C35_BOOTSTRAP_ADAPTER_FAILED');
    else bootstrapMarker('C35_BOOTSTRAP_PREFLIGHT_FAILED');
    const details = error && error.details && typeof error.details === 'object' ? error.details : {};
    return safeFailure(error && error.code || 'C35_RUNNER_FAILED', {
      failureStage: failureStage,
      nativeProof: request.nativeProof,
      adapter: adapter,
      targetIdentity: details.targetIdentity,
      sidecarAudit: details.sidecarAudit
    });
  } finally {
    if (adapter) adapter.close();
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
      bootstrapMarker('C35_BOOTSTRAP_REQUEST_REJECTED');
      const result = safeFailure('C35_NATIVE_PROOF_TOO_LARGE', { failureStage: 'request_validation' });
      process.stdout.write(JSON.stringify(result));
      process.exitCode = 2;
      return;
    }
  }
  const result = await runRecoveryOnlyDryRun(process.argv.slice(2), input);
  process.stdout.write(JSON.stringify(result));
  if (result.status !== 'DRY_RUN_PASS') process.exitCode = 2;
}

if (require.main === module) main().catch(async error => {
  bootstrapMarker('C35_BOOTSTRAP_MAIN_CAUGHT');
  const result = safeFailure(error && error.code || 'C35_RUNNER_FAILED', { failureStage: 'runner_main' });
  process.stdout.write(JSON.stringify(result));
  process.exitCode = 2;
});

module.exports = Object.freeze({
  DRY_RUN_ARG: DRY_RUN_ARG,
  REPORT_SCHEMA: REPORT_SCHEMA,
  REPORT_TYPE: REPORT_TYPE,
  zeroActivity: zeroActivity,
  safeFailure: safeFailure,
  runRecoveryOnlyDryRun: runRecoveryOnlyDryRun,
  testOnly: Object.freeze({
    bootstrapMarkers: BOOTSTRAP_MARKERS,
    runRecoveryOnlyDryRun: function (argv, stdinText, options) {
      if (!TEST_ENABLED) throw new Error('C35_SYNTHETIC_HOOK_DISABLED');
      return runRecoveryOnlyDryRun(argv, stdinText, options || {});
    }
  })
});
