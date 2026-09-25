'use strict';

/* Explicit production-read-only P5.8.5 gate. Not registered in test-all.
   It runs synthetic coverage, captures S1, closes the RecoveryOnly window,
   captures S2 after a fresh launch, compares every component, and only then
   runs the new composite production dry-run. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ReleaseManifest = require('../scripts/release-manifest.js');

const ROOT = path.resolve(__dirname, '..');
const INSTALL_ROOT = 'C:\\Users\\admin\\AppData\\Local\\Programs\\InternalBeyond';
const HARNESS = path.join(__dirname, 'test_p32_w5_composite_recovery_production_dryrun.js');
const REPORT_DIR = path.join(ROOT, 'tmp', 'p32-w5-r3b');
const REPORT_PATH = path.join(REPORT_DIR, 'p5.8.5-report.json');
const S1_PATH = path.join(REPORT_DIR, 'p5.8.5-s1-manifest.json');
const S2_PATH = path.join(REPORT_DIR, 'p5.8.5-s2-manifest.json');
const EXPECTED_SOURCES = [
  { fileName: 'InternalBeyond_auto_2026-09-02.json', sha256: '1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401' },
  { fileName: 'IB_backup_2026-09-03.json', sha256: '37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d' },
  { fileName: 'InternalBeyond_auto_2026-08-27.json', sha256: '5963c2d3957b4c1aaf1dba26e1ab94561998d2ac18566e0e51c378d404d4bd84' }
];
const AUTHORITY_REVISION_ID = 'p32-w5-r3b3-p5.6.2:f14b0deee333a2bcb51b24ca';
const AUTHORITY_REVISION_SHA256 = 'f14b0deee333a2bcb51b24ca93e74028ebfc11be6687e83bf49da47dd99a57f7';
const PROVENANCE_DIGEST = '420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5';
const BUILT_HOST_SHA256 = 'ea3c355a9f3033a3226e8e9913cbac4dad6c15cc902ab41c3d01d2dd044cb4dd';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}
function stableJson(value) { return JSON.stringify(stableValue(value)); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }

function componentDiff(left, right) {
  const a = new Map((left.components || []).map(item => [item.name, item.sha256]));
  const b = new Map((right.components || []).map(item => [item.name, item.sha256]));
  const names = Array.from(new Set([...a.keys(), ...b.keys()])).sort();
  return names.filter(name => a.get(name) !== b.get(name)).map(name => ({ name, s1Sha256: a.get(name) || null, s2Sha256: b.get(name) || null }));
}

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 240000,
    maxBuffer: 24 * 1024 * 1024
  });
  if (result.error) throw new Error(label + ': ' + String(result.error.message || result.error));
  if (result.status !== 0) throw new Error(label + ': exit ' + String(result.status) + ' · ' + String(result.stderr || result.stdout || '').slice(-3000));
  return String(result.stdout || '');
}

function readP585Result(stdout, label) {
  const line = String(stdout).split(/\r?\n/).filter(item => item.startsWith('P585_RESULT=')).pop();
  if (!line) throw new Error(label + ': live harness result marker missing');
  return JSON.parse(line.slice('P585_RESULT='.length));
}

function verifyInstalledParity() {
  const payloadPath = path.join(INSTALL_ROOT, 'ib-payload-manifest.json');
  if (!fs.existsSync(payloadPath)) throw new Error('canonical-payload-manifest-missing');
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  if (payload.schema !== 'internalbeyond.payload-manifest' || payload.product !== '1.0.6' || payload.count !== 369 || payload.files.length !== 369) throw new Error('canonical-payload-manifest-contract-invalid');
  const listed = new Set(payload.files);
  const resolution = ReleaseManifest.resolve();
  if (!resolution.ok || resolution.files.length !== 367) throw new Error('release-whitelist-resolution-invalid');
  const sourcesByDestination = new Map(resolution.files.map(item => [item.to, item.abs]));
  if (!listed.has('ib-payload-manifest.json') || !listed.has('internalbeyond-host.exe')) throw new Error('canonical-payload-generated-entry-missing');
  const files = [];
  for (const relative of payload.files) {
    const installedPath = path.join(INSTALL_ROOT, ...relative.split('/'));
    if (!fs.existsSync(installedPath)) throw new Error('canonical-payload-file-missing:' + relative);
    const installedSha256 = sha256(installedPath);
    if (relative === 'ib-payload-manifest.json') {
      files.push({ path: relative, sha256: installedSha256, parity: 'SELF_LISTED_MANIFEST' });
      continue;
    }
    if (relative === 'internalbeyond-host.exe') {
      if (installedSha256 !== BUILT_HOST_SHA256) throw new Error('canonical-host-build-parity-failed');
      files.push({ path: relative, sha256: installedSha256, parity: 'BUILD_HASH_MATCH' });
      continue;
    }
    const sourcePath = sourcesByDestination.get(relative);
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('canonical-payload-source-missing:' + relative);
    const sourceSha256 = sha256(sourcePath);
    if (sourceSha256 !== installedSha256) throw new Error('canonical-payload-parity-failed:' + relative);
    files.push({ path: relative, sha256: installedSha256, parity: true });
  }
  const unexpected = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
      else if (!listed.has(relative) && !/^unins\d+\.(?:exe|dat)$/i.test(relative)) unexpected.push(relative);
    }
  };
  visit(INSTALL_ROOT);
  if (unexpected.length) throw new Error('canonical-payload-unexpected-files:' + unexpected.slice(0, 8).join(','));
  if (resolution.files.some(item => !listed.has(item.to))) throw new Error('canonical-payload-release-whitelist-entry-missing');
  return { manifestCount: payload.count, matchedEntries: files.length, sourceBytesCompared: files.filter(item => item.parity === true).length, builtHostSha256: BUILT_HOST_SHA256, manifestSha256: sha256(payloadPath), unexpectedFiles: unexpected.length, files };
}

function closureEvidence(result, label) {
  if (!result || !result.servicesAfterClose || result.servicesAfterClose.hostProcessCount !== 0 || result.servicesAfterClose.canonicalRuntimeNodeCount !== 0 || result.servicesAfterClose.listeners.length !== 0) {
    throw new Error(label + ': RecoveryOnly Host or normal service closure failed');
  }
  if (!result.safetyFacts || !Object.values(result.safetyFacts).every(Boolean)) throw new Error(label + ': read-only safety facts failed');
  if (result.activeQuarantined !== true) throw new Error(label + ': Active quarantine is not confirmed');
  return {
    hostIdentity: result.hostIdentity,
    activeQuarantined: result.activeQuarantined,
    servicesBefore: result.servicesBefore,
    servicesDuring: result.servicesDuring,
    servicesAfterClose: result.servicesAfterClose,
    safetyFacts: result.safetyFacts
  };
}

function algorithmContract(manifest) {
  const rootDescriptions = {
    manifestSchema: { source: 'TARGET_SNAPSHOT_MANIFEST_SCHEMA constant', canonicalSerialization: 'stableJson({name,value})', ordering: 'Fixed first root component', businessData: false, changesOnReadOnlyStartup: false },
    manifestVersion: { source: 'TARGET_SNAPSHOT_MANIFEST_VERSION constant', canonicalSerialization: 'stableJson({name,value}) with number value', ordering: 'Fixed after manifestSchema', businessData: false, changesOnReadOnlyStartup: false },
    targetIdentity: { source: 'RecoveryOnly target identity binding passed to snapshotDatabase', canonicalSerialization: 'stableJson({name,value})', ordering: 'Fixed after manifestSchema and manifestVersion', businessData: false, changesOnReadOnlyStartup: false },
    origin: { source: 'location.origin captured by the trusted RecoveryOnly adapter', canonicalSerialization: 'stableJson({name,value})', ordering: 'Fixed after targetIdentity', businessData: false, changesOnReadOnlyStartup: false },
    databaseName: { source: 'IndexedDB database.name from the already-existing v24 database', canonicalSerialization: 'stableJson({name,value})', ordering: 'Fixed after origin', businessData: false, changesOnReadOnlyStartup: false },
    schemaVersion: { source: 'IndexedDB database.version; openExistingDatabase aborts any upgrade', canonicalSerialization: 'stableJson({name,value}) with number value', ordering: 'Fixed after databaseName', businessData: false, changesOnReadOnlyStartup: false },
    storeList: { source: 'RecoveryEngine.STORE_BY_DOMAIN for the frozen selected domain list', canonicalSerialization: 'stableJson(sortedStoreNames)', ordering: 'Store names sorted by JavaScript code-unit order', businessData: false, changesOnReadOnlyStartup: false }
  };
  const perStore = {
    apiConfigs: 'id, provider, model, imageGenProvider, imageGenModel, archived; endpoint origin only (HTTP(S), no userinfo/path/query); voice enabled/provider/source/voiceId/model. Secret fields, prompts, profile text and raw endpoints are excluded.',
    chatMessages: 'role, friendId, threadId; message body and timestamps are excluded.',
    chatThreads: 'friendId; title and timestamps are excluded.',
    groups: 'ordered members projected to id/characterId/roleId/friendId only; labels and body text are excluded.',
    memories: 'characterId only; memory body is excluded.',
    autoMemory: 'friendId only; auto-memory body is excluded.',
    diary_entries: 'characterId and ordered relatedMemoryIds; diary body, date and timestamps are excluded.',
    moments: 'roleId and characterId; moment body and timestamps are excluded.',
    roleLetters: 'fromRoleId, toRoleId and parentId; letter body and timestamps are excluded.'
  };
  const components = (manifest.components || []).map(component => {
    const description = rootDescriptions[component.name];
    if (description) return Object.assign({ name: component.name, sha256: component.sha256 }, description);
    const match = /^store:([^:]+)(?::(count|keySet|recordProjection))?$/.exec(component.name);
    const storeName = match && match[1];
    const kind = match && match[2];
    return {
      name: component.name,
      source: kind === 'count' ? 'snapshotDatabase readonly cursor row count' : kind === 'keySet' ? 'canonicalIdbKeyJson over IndexedDB primary keys' : kind === 'recordProjection' ? 'projectSnapshotRecord allowlist' : 'per-store count + key set digest + safe record projection digest',
      canonicalSerialization: kind === 'count' ? 'stableJson({store,count})' : kind === 'keySet' ? 'stableJson(sorted typed canonical key strings)' : kind === 'recordProjection' ? 'stableJson(records sorted by canonical key, each {key,metadata})' : 'stableJson({name,count,keySetSha256,recordProjectionSha256})',
      ordering: kind === 'count' ? 'One component per store, in alphabetical store order' : kind === 'keySet' || kind === 'recordProjection' ? 'Canonical typed key strings sorted by code-unit order; projection array follows key order' : 'Per store: count, keySet, recordProjection, combined store component',
      businessData: true,
      changesOnReadOnlyStartup: false,
      storeProjection: perStore[storeName] || 'Unknown store projection',
      sha256: component.sha256
    };
  });
  return {
    schema: manifest.schema,
    version: manifest.version,
    targetSnapshotHash: 'SHA-256(UTF-8(stableJson(unsignedManifest))) where unsignedManifest is the full manifest without aggregateSha256',
    canonicalSerialization: 'stableJson recursively sorts object property names; arrays preserve declared order; UTF-8 bytes feed SHA-256; lowercase hex output',
    ordering: 'Root components fixed; store list sorted by code-unit order; keys sorted by canonical typed-key JSON; record projections follow sorted keys; projection object fields sorted by stableJson',
    components,
    storeProjectionAllowlist: perStore,
    excluded: ['credential secrets and API keys', 'chat/diary/memory/moment/letter bodies and prompts', 'volatile timestamps', 'WebView logs and session metadata', 'cache', 'physical LevelDB/WAL/SHM bytes']
  };
}

async function main() {
  if (!process.argv.includes('--allow-read-only-production-determinism')) throw new Error('explicit-flag-required: --allow-read-only-production-determinism');
  const parity = verifyInstalledParity();
  const report = {
    schema: 'internalbeyond.p32-w5.r3b.p5.8.5-report',
    version: 1,
    phase: 'P32-W.5-R3-B.3-P5.8.5 Target Snapshot Determinism & Component Manifest',
    capturedAt: new Date().toISOString(),
    mode: 'READ_ONLY_PRODUCTION_SNAPSHOTS_AND_SYNTHETIC_TESTS',
    status: 'IN_PROGRESS',
    canonicalPayloadParity: parity,
    historicalDrift: 'UNATTRIBUTED',
    historicalDriftEvidence: {
      status: 'UNATTRIBUTED',
      authorizedAggregateSha256: 'a2571cb4ea3e1b58a3a955c8bf98bf969024ae836c26ee4f0e3ddcf97e312ac1',
      priorLiveAggregateSha256: 'a2571cb4ea3e1b58a3a955c8bf98bf78237b3032298f72fd74ccebcd37a27503',
      priorComponentManifestReconstructed: false,
      historicalAttributionAttempted: false
    },
    approval: false,
    checkpoint: false,
    applyWindow: false,
    restore: false,
    activeQuarantined: true
  };
  writeJson(REPORT_PATH, report);

  const manifestTests = runNode([path.join(__dirname, 'test_p32_w5_target_snapshot_manifest.js')], 'target snapshot mutation-sensitivity tests');
  const adapterTests = runNode([path.join(__dirname, 'test_recovery_production_adapter.js')], 'production adapter synthetic tests');
  report.syntheticTests = {
    targetSnapshotManifest: { status: 'PASS', output: manifestTests.trim() },
    productionAdapter: { status: 'PASS', finalLine: adapterTests.trim().split(/\r?\n/).pop() }
  };
  writeJson(REPORT_PATH, report);

  const captureArgs = ['--allow-read-only-production-dry-run', '--p5.8.5-snapshot-only', '--p5.8.5-result-marker'];
  const s1Result = readP585Result(runNode([HARNESS, ...captureArgs], 'RecoveryOnly snapshot S1'), 'S1');
  const s1Closure = closureEvidence(s1Result, 'S1');
  const s1 = s1Result.snapshotManifest;
  writeJson(S1_PATH, s1);
  report.s1 = { manifest: s1, hostSession: s1Closure };
  report.status = 'S1_CAPTURED';
  writeJson(REPORT_PATH, report);

  const s2Result = readP585Result(runNode([HARNESS, ...captureArgs], 'RecoveryOnly snapshot S2'), 'S2');
  const s2Closure = closureEvidence(s2Result, 'S2');
  const s2 = s2Result.snapshotManifest;
  writeJson(S2_PATH, s2);
  const changedComponents = componentDiff(s1, s2);
  const manifestsEqual = stableJson(s1) === stableJson(s2);
  const aggregateEqual = s1.aggregateSha256 === s2.aggregateSha256;
  report.s2 = { manifest: s2, hostSession: s2Closure };
  report.determinism = { aggregateEqual, manifestsEqual, changedComponents, status: aggregateEqual && manifestsEqual && changedComponents.length === 0 ? 'PASS' : 'FAIL' };
  report.algorithm = algorithmContract(s2);
  report.status = aggregateEqual && manifestsEqual && changedComponents.length === 0 ? 'S1_S2_DETERMINISM_PASS' : 'BLOCKED_TARGET_SNAPSHOT_NONDETERMINISTIC';
  writeJson(REPORT_PATH, report);
  if (report.status !== 'S1_S2_DETERMINISM_PASS') {
    process.stderr.write('BLOCKED: S1/S2 mismatch; changed components=' + JSON.stringify(changedComponents) + '\n');
    process.exitCode = 1;
    return;
  }

  const dryRunArgs = ['--allow-read-only-production-dry-run', '--p5.8.5-result-marker'];
  const dryRunResult = readP585Result(runNode([HARNESS, ...dryRunArgs], 'new read-only composite production dry-run'), 'production dry-run');
  const dryRunClosure = closureEvidence(dryRunResult, 'new plan dry-run');
  const manifestMatchesS2 = stableJson(dryRunResult.targetSnapshotManifest) === stableJson(s2);
  const sourceHashesMatch = stableJson((dryRunResult.verifiedSources || []).map(item => ({ fileName: item.fileName, sha256: item.sha256 })) .sort((a, b) => a.fileName.localeCompare(b.fileName))) === stableJson(EXPECTED_SOURCES.map(item => ({ fileName: item.fileName, sha256: item.sha256 })).sort((a, b) => a.fileName.localeCompare(b.fileName)));
  const planIdentityMatch = /^r3b3:[a-f0-9]{64}$/.test(String(dryRunResult.productionBoundPlanId || '')) && dryRunResult.productionBoundPlanId === 'r3b3:' + dryRunResult.productionBoundPlanSha256;
  const preflight = dryRunResult.preflight || {};
  const mutation = dryRunResult.mutation || {};
  const readonlyFacts = dryRunResult.safetyFacts || {};
  const newPlanFacts = {
    readOnlyCompositeDryRunReady: dryRunResult.status === 'READY_FOR_EXPLICIT_APPROVAL',
    targetManifestMatchesS2: manifestMatchesS2,
    planIdHashBindingValid: planIdentityMatch,
    sourceHashesUnchanged: sourceHashesMatch,
    authorityUnchanged: dryRunResult.authority === 'USER_CONFIRMED_IDENTITY_SUCCESSION' && dryRunResult.authorityRevisionId === AUTHORITY_REVISION_ID && dryRunResult.authorityRevisionSha256 === AUTHORITY_REVISION_SHA256,
    provenance539: dryRunResult.authorityProvenance && dryRunResult.authorityProvenance.recordCount === 539 && dryRunResult.authorityProvenance.traceDigest === PROVENANCE_DIGEST,
    plannerBlockersZero: preflight.targetCollisions === 0 && preflight.danglingReferences === 0 && preflight.duplicates === 0 && preflight.rejected === 0,
    credentialsNeedRebind: preflight.credentialState === 'NEEDS_REBIND',
    secretProjectionZero: preflight.secretValuesProjected === 0,
    productionWritesZero: mutation.productionWrites === 0,
    localStorageWritesZero: mutation.localStorageWrites === 0,
    providerCallsZero: mutation.providerCalls === 0,
    activeQuarantined: dryRunResult.activeQuarantined === true,
    applyAndApprovalClosed: readonlyFacts.approvalNotIssuedAndApplyDisabled === true && readonlyFacts.productionApplyClosed === true && dryRunResult.approvalTokenIssued === false && dryRunResult.applyWindowOpened === false,
    restoreNotRun: dryRunResult.productionIndexedDbWrites === 0
  };
  report.newProductionBoundPlan = {
    status: Object.values(newPlanFacts).every(Boolean) ? 'READY_FOR_NEW_EXPLICIT_PRODUCTION_RESTORE_APPROVAL' : 'BLOCKED_NEW_PLAN_PREFLIGHT',
    facts: newPlanFacts,
    planId: dryRunResult.productionBoundPlanId,
    planSha256: dryRunResult.productionBoundPlanSha256,
    targetSnapshotSha256: dryRunResult.targetSnapshotSha256,
    targetSnapshotManifest: dryRunResult.targetSnapshotManifest,
    targetIdentity: dryRunResult.targetIdentity,
    authority: dryRunResult.authority,
    authorityRevisionId: dryRunResult.authorityRevisionId,
    authorityRevisionSha256: dryRunResult.authorityRevisionSha256,
    authorityProvenance: dryRunResult.authorityProvenance,
    verifiedSources: dryRunResult.verifiedSources,
    preflight,
    mutation,
    activeState: dryRunResult.activeState,
    approvalNotIssuedAndApplyDisabled: dryRunResult.approvalNotIssuedAndApplyDisabled,
    productionApplyEnabled: dryRunResult.productionApplyEnabled,
    approvalTokenIssued: dryRunResult.approvalTokenIssued,
    applyWindowOpened: dryRunResult.applyWindowOpened,
    hostSession: dryRunClosure
  };
  report.finalGate = {
    p5_8_5: Object.values(newPlanFacts).every(Boolean) ? 'PASS' : 'BLOCKED',
    r3b3: Object.values(newPlanFacts).every(Boolean) ? 'READY_FOR_NEW_EXPLICIT_PRODUCTION_RESTORE_APPROVAL' : 'BLOCKED',
    restoreApproval: false,
    restoreExecuted: false,
    checkpointCreated: false,
    applyWindowOpened: false,
    activeRearm: false,
    historicalDrift: 'UNATTRIBUTED'
  };
  report.status = Object.values(newPlanFacts).every(Boolean) ? 'PASS' : 'BLOCKED_NEW_PLAN_PREFLIGHT';
  writeJson(REPORT_PATH, report);
  process.stdout.write(JSON.stringify({ status: report.status, determinism: report.determinism, newPlan: report.newProductionBoundPlan && { status: report.newProductionBoundPlan.status, planId: report.newProductionBoundPlan.planId, planSha256: report.newProductionBoundPlan.planSha256, targetSnapshotSha256: report.newProductionBoundPlan.targetSnapshotSha256 } }, null, 2) + '\n');
  if (report.status !== 'PASS') process.exitCode = 1;
}

module.exports = { verifyInstalledParity, algorithmContract, componentDiff, stableJson };
if (require.main === module) {
  main().catch(error => {
    const report = {
      schema: 'internalbeyond.p32-w5.r3b.p5.8.5-report',
      version: 1,
      phase: 'P32-W.5-R3-B.3-P5.8.5 Target Snapshot Determinism & Component Manifest',
      capturedAt: new Date().toISOString(),
      mode: 'READ_ONLY_PRODUCTION_SNAPSHOTS_AND_SYNTHETIC_TESTS',
      status: 'BLOCKED_P5_8_5_EXECUTION',
      error: String(error && error.message || error),
      historicalDrift: 'UNATTRIBUTED',
      historicalDriftEvidence: {
        status: 'UNATTRIBUTED',
        authorizedAggregateSha256: 'a2571cb4ea3e1b58a3a955c8bf98bf969024ae836c26ee4f0e3ddcf97e312ac1',
        priorLiveAggregateSha256: 'a2571cb4ea3e1b58a3a955c8bf98bf78237b3032298f72fd74ccebcd37a27503',
        priorComponentManifestReconstructed: false,
        historicalAttributionAttempted: false
      },
      approval: false,
      checkpoint: false,
      applyWindow: false,
      restore: false,
      activeQuarantined: true
    };
    try { writeJson(REPORT_PATH, report); } catch (_) {}
    process.stderr.write('BLOCKED ' + report.error + '\n');
    process.exitCode = 1;
  });
}
