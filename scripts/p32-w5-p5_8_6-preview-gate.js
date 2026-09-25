'use strict';

/* Explicit P5.8.6 gate: synthetic preview tests, installed parity, then one
   read-only RecoveryOnly composite dry-run. It never approves or applies. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'tmp', 'p32-w5-r3b');
const REPORT_PATH = path.join(REPORT_DIR, 'p5.8.6-restore-preview-report.json');
const PRIOR_REPORT_PATH = path.join(REPORT_DIR, 'p5.8.5-report.json');
const LIVE_HARNESS = path.join(ROOT, 'tests', 'test_p32_w5_composite_recovery_production_dryrun.js');
const EXPECTED_SOURCES = [
  { fileName: 'InternalBeyond_auto_2026-09-02.json', sha256: '1170f2a805f25ce2e151b880858e0ab1fdd2aad61281a16754da08a843238401' },
  { fileName: 'IB_backup_2026-09-03.json', sha256: '37f45afe4c4477931dd475ec8be3816e75133bc361a6b471b088be7d70ed198d' },
  { fileName: 'InternalBeyond_auto_2026-08-27.json', sha256: '5963c2d3957b4c1aaf1dba26e1ab94561998d2ac18566e0e51c378d404d4bd84' }
];
const AUTHORITY_REVISION_ID = 'p32-w5-r3b3-p5.6.2:f14b0deee333a2bcb51b24ca';
const AUTHORITY_REVISION_SHA256 = 'f14b0deee333a2bcb51b24ca93e74028ebfc11be6687e83bf49da47dd99a57f7';
const PROVENANCE_DIGEST = '420de82d7223ba160e5520c6abe4980e5aa6f066bd37ab430b8235bd2fdf82d5';

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function runNode(args, label, timeout = 240000) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 24 * 1024 * 1024 });
  if (result.error) throw new Error(label + ': ' + String(result.error.message || result.error));
  if (result.status !== 0) throw new Error(label + ': exit ' + String(result.status) + ' · ' + String(result.stderr || result.stdout || '').slice(-3000));
  return String(result.stdout || '');
}
function parseResult(stdout) {
  const line = String(stdout).split(/\r?\n/).filter(item => item.startsWith('P585_RESULT=')).pop();
  if (!line) throw new Error('RecoveryOnly result marker missing');
  return JSON.parse(line.slice('P585_RESULT='.length));
}
function sourceHashesMatch(sources) {
  const actual = (sources || []).map(item => ({ fileName: item.fileName, sha256: item.sha256 })).sort((a, b) => a.fileName.localeCompare(b.fileName));
  const expected = EXPECTED_SOURCES.slice().sort((a, b) => a.fileName.localeCompare(b.fileName));
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function assertNoRestoreOrApproval(result) {
  const facts = result && result.safetyFacts || {};
  const preview = result && result.recoveryPreview || {};
  const checks = {
    readyReadonlyPlan: result && result.status === 'READY_FOR_EXPLICIT_APPROVAL',
    exactPlanBinding: /^r3b3:[a-f0-9]{64}$/.test(String(result && result.productionBoundPlanId || '')) && result.productionBoundPlanId === 'r3b3:' + result.productionBoundPlanSha256,
    sourceHashesUnchanged: sourceHashesMatch(result && result.verifiedSources),
    authorityUnchanged: result && result.authority === 'USER_CONFIRMED_IDENTITY_SUCCESSION' && result.authorityRevisionId === AUTHORITY_REVISION_ID && result.authorityRevisionSha256 === AUTHORITY_REVISION_SHA256,
    provenance539: result && result.authorityProvenance && result.authorityProvenance.recordCount === 539 && result.authorityProvenance.traceDigest === PROVENANCE_DIGEST,
    plannerBlockersZero: result && result.preflight && result.preflight.targetCollisions === 0 && result.preflight.danglingReferences === 0 && result.preflight.duplicates === 0 && result.preflight.rejected === 0,
    credentialsNeedRebind: result && result.preflight && result.preflight.credentialState === 'NEEDS_REBIND',
    secretProjectionZero: result && result.preflight && result.preflight.secretValuesProjected === 0,
    productionWritesZero: result && result.mutation && result.mutation.productionWrites === 0 && result.productionIndexedDbWrites === 0,
    localStorageWritesZero: result && result.mutation && result.mutation.localStorageWrites === 0,
    providerCallsZero: result && result.mutation && result.mutation.providerCalls === 0,
    activeQuarantined: result && result.activeQuarantined === true,
    previewMatchesCurrentPlan: preview.visible === true && preview.planId === result.productionBoundPlanId && preview.planSha256 === result.productionBoundPlanSha256 && preview.targetSnapshotSha256 === result.targetSnapshotSha256,
    previewSourceAndProvenance: preview.sourceCount === 539 && preview.provenanceCount === 539 && preview.provenanceState === 'Provenance bound',
    previewShowsAllDomains: Array.isArray(preview.domainRows) && preview.domainRows.length === 9 && preview.domainRows.some(row => row.includes('autoMemory')) && preview.domainRows.every(row => row.includes('BOUND ·')),
    previewIdentitySuccession: preview.oldIdentity === 'friend_1785260690497' && preview.newIdentity === 'friend_1788318367937_tcmw0p' && preview.identityAuthority === 'USER_CONFIRMED_IDENTITY_SUCCESSION' && String(preview.identityExplanation).includes('不是自动迁移发现'),
    previewCredentialBoundary: preview.credentialState === 'NEEDS_REBIND' && preview.apiConfigMetadataCount === 13,
    excludedDataVisible: ['cache','WebView session','WAL/SHM physical files','logs','runtime state'].every(value => (preview.excludedData || []).includes(value)),
    finalConfirmationPending: preview.finalChecksUnchecked === true && preview.finalPhraseBlank === true && preview.continueToNativeDisabled === true,
    nativeApprovalNotEntered: preview.nativeApprovalControlsHidden === true && preview.issueApprovalDisabled === true && preview.executeRestoreDisabled === true && result.approvalTokenIssued === false && result.applyWindowOpened === false
  };
  const failed = Object.keys(checks).filter(key => checks[key] !== true);
  return { checks, failed };
}

async function main() {
  if (!process.argv.includes('--allow-read-only-preview-audit')) throw new Error('explicit-flag-required: --allow-read-only-preview-audit');
  const prior = JSON.parse(fs.readFileSync(PRIOR_REPORT_PATH, 'utf8'));
  if (prior.status !== 'PASS' || prior.finalGate && prior.finalGate.p5_8_5 !== 'PASS') throw new Error('P5.8.5-contract-not-passing');

  const report = {
    schema: 'internalbeyond.p32-w5.r3b.p5.8.6-restore-preview-report',
    version: 1,
    phase: 'P32-W.5-R3-B.3-P5.8.6 Recovery Preview & Final Production Restore Gate',
    capturedAt: new Date().toISOString(),
    status: 'IN_PROGRESS',
    preservedP5_8_5: { status: prior.status, aggregateSha256: prior.s2.manifest.aggregateSha256, componentCount: prior.s2.manifest.components.length, determinism: prior.determinism.status },
    historicalDrift: 'UNATTRIBUTED',
    approvalIssued: false,
    checkpointCreated: false,
    applyWindowOpened: false,
    restoreExecuted: false,
    activeRearm: false
  };
  writeJson(REPORT_PATH, report);

  report.tests = {
    targetSnapshotContract: { status: 'PASS', output: runNode([path.join(ROOT, 'tests', 'test_p32_w5_target_snapshot_manifest.js')], 'P5.8.5 snapshot contract regression').trim() },
    productionAdapterContract: { status: 'PASS', finalLine: runNode([path.join(ROOT, 'tests', 'test_recovery_production_adapter.js')], 'P5.8.5 production adapter regression').trim().split(/\r?\n/).pop() },
    previewUI: { status: 'PASS', output: runNode([path.join(ROOT, 'tests', 'test_p32_w5_p5_8_6_recovery_preview.js')], 'preview UI tests').trim() },
    recoveryStateMachine: { status: 'PASS', finalLine: runNode([path.join(ROOT, 'tests', 'test_recovery_ui_state_machine.js')], 'RecoveryOnly state-machine tests').trim().split(/\r?\n/).pop() },
    htmlScripts: { status: 'PASS', output: runNode([path.join(ROOT, 'scripts', 'scripts_check_html.js'), 'Recovery.html'], 'Recovery.html structure check').trim() },
    installedPayloadParity: { status: 'PASS', output: runNode([path.join(ROOT, 'tests', 'test_recovery_installed_payload_parity.js')], 'installed payload parity').trim() }
  };
  writeJson(REPORT_PATH, report);

  const dryRun = parseResult(runNode([LIVE_HARNESS, '--allow-read-only-production-dry-run', '--p5.8.5-result-marker', '--p5.8.6-preview-audit'], 'read-only RecoveryOnly composite dry-run'));
  const checked = assertNoRestoreOrApproval(dryRun);
  const oldPlan = prior.newProductionBoundPlan;
  const newIdentity = dryRun.targetIdentity && dryRun.targetIdentity.identity || '';
  const oldIdentity = prior.newProductionBoundPlan && prior.newProductionBoundPlan.targetIdentity && prior.newProductionBoundPlan.targetIdentity.identity || '';
  const newPlanId = String(dryRun.productionBoundPlanId || '');
  const newPlanHash = String(dryRun.productionBoundPlanSha256 || '').toLowerCase();
  const planInvalidation = {
    payloadIdentityChanged: !!oldIdentity && newIdentity !== oldIdentity,
    priorPlanNotReused: !!oldPlan && newPlanId !== oldPlan.planId && newPlanHash !== String(oldPlan.planSha256 || '').toLowerCase(),
    newTargetSnapshotGenerated: !!dryRun.targetSnapshotSha256 && dryRun.targetSnapshotSha256 !== prior.newProductionBoundPlan.targetSnapshotSha256
  };
  checked.checks.previousPlanInvalidatedAfterPayloadChange = planInvalidation.payloadIdentityChanged && planInvalidation.priorPlanNotReused && planInvalidation.newTargetSnapshotGenerated;
  checked.failed = Object.keys(checked.checks).filter(key => checked.checks[key] !== true);
  report.productionPreview = {
    checks: checked.checks,
    failedChecks: checked.failed,
    planInvalidation: planInvalidation,
    preview: dryRun.recoveryPreview,
    previewScreenshotPath: dryRun.previewScreenshotPath,
    previewScreenshotError: dryRun.previewScreenshotError,
    planId: dryRun.productionBoundPlanId,
    planSha256: dryRun.productionBoundPlanSha256,
    targetSnapshotSha256: dryRun.targetSnapshotSha256,
    targetIdentity: dryRun.targetIdentity,
    verifiedSources: dryRun.verifiedSources,
    authority: dryRun.authority,
    authorityRevisionId: dryRun.authorityRevisionId,
    authorityRevisionSha256: dryRun.authorityRevisionSha256,
    provenance: dryRun.authorityProvenance,
    preflight: dryRun.preflight,
    mutation: dryRun.mutation,
    safetyFacts: dryRun.safetyFacts,
    approvalNotIssued: dryRun.approvalTokenIssued === false,
    checkpointCreated: false,
    applyWindowOpened: dryRun.applyWindowOpened === false,
    restoreWrites: dryRun.productionIndexedDbWrites,
    activeQuarantined: dryRun.activeQuarantined,
    servicesAfterClose: dryRun.servicesAfterClose
  };
  report.finalGate = {
    p5_8_6: checked.failed.length === 0 ? 'PASS' : 'BLOCKED',
    r3b3: checked.failed.length === 0 ? 'READY_FOR_EXPLICIT_PRODUCTION_RESTORE_APPROVAL' : 'BLOCKED_P5_8_6_PREVIEW_GATE',
    nativeApprovalExecuted: false,
    checkpointCreated: false,
    applyWindowOpened: false,
    restoreExecuted: false,
    activeRearm: false,
    r3cStarted: false,
    historicalDrift: 'UNATTRIBUTED'
  };
  report.status = checked.failed.length === 0 ? 'PASS' : 'BLOCKED_P5_8_6_PREVIEW_GATE';
  writeJson(REPORT_PATH, report);
  process.stdout.write(JSON.stringify({ status: report.status, finalGate: report.finalGate, failedChecks: checked.failed, planId: report.productionPreview.planId, planSha256: report.productionPreview.planSha256, targetSnapshotSha256: report.productionPreview.targetSnapshotSha256 }, null, 2) + '\n');
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    const report = {
      schema: 'internalbeyond.p32-w5.r3b.p5.8.6-restore-preview-report',
      version: 1,
      phase: 'P32-W.5-R3-B.3-P5.8.6 Recovery Preview & Final Production Restore Gate',
      capturedAt: new Date().toISOString(),
      status: 'BLOCKED_P5_8_6_EXECUTION',
      error: String(error && error.message || error),
      historicalDrift: 'UNATTRIBUTED',
      approvalIssued: false,
      checkpointCreated: false,
      applyWindowOpened: false,
      restoreExecuted: false,
      activeRearm: false
    };
    try { writeJson(REPORT_PATH, report); } catch (_) {}
    process.stderr.write('BLOCKED ' + report.error + '\n');
    process.exitCode = 1;
  });
}
