'use strict';

/* Synthetic UI-only tests for the P5.8.6 restore preview and final-confirmation gate. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Engine = require('../assets/js/recovery-engine.js');
const UI = require('../assets/js/recovery-ui.js');

const DOMAIN_COUNTS = { apiConfigs: 2, chatMessages: 1, chatThreads: 1, groups: 1, memories: 2, autoMemory: 1, diary_entries: 1, moments: 1, roleLetters: 1 };
const DOMAINS = Engine.DOMAIN_ORDER.slice();
const ranges = [];
for (const domain of DOMAINS) {
  const supplemental = domain === 'apiConfigs' || domain === 'memories';
  ranges.push({ domain, source: 'PRIMARY_2026_09_02', recordCount: DOMAIN_COUNTS[domain] - (supplemental ? 1 : 0) });
  if (domain === 'apiConfigs') ranges.push({ domain, source: 'SUPPLEMENTAL_ROLE_2026_09_03', recordCount: 1 });
  if (domain === 'memories') ranges.push({ domain, source: 'SUPPLEMENTAL_MEMORY_2026_08_27', recordCount: 1 });
}

const compositeSummary = {
  primarySource: { fileName: 'synthetic-primary.json', size: 100, sha256: 'a'.repeat(64) },
  supplementalSources: [
    { kind: 'role-metadata', fileName: 'synthetic-role.json', size: 20, sha256: 'b'.repeat(64) },
    { kind: 'memory', fileName: 'synthetic-memory.json', size: 30, sha256: 'c'.repeat(64) }
  ],
  identitySuccession: [{ oldId: 'old_role', newId: 'new_role', authority: 'USER_CONFIRMED_IDENTITY_SUCCESSION', status: 'EXPLICIT_USER_CONFIRMATION', systemConfirmed: false }],
  authorityRevision: { identity: { planId: 'synthetic-authority-id', planSha256: 'd'.repeat(64) }, priorIdentityEvidence: { hiBit: { evidenceClass: 'SYNTHETIC', explicitTransitionFound: false }, roleContinuity: { evidenceClass: 'SYNTHETIC' } } },
  selectedDomains: DOMAINS,
  planIdentity: { id: 'synthetic-composite-id', sha256: 'e'.repeat(64) },
  summary: { domainCounts: DOMAIN_COUNTS },
  provenance: { recordCount: 11, traceDigest: 'f'.repeat(64), ranges },
  syntheticCredentialProbe: 'SYNTHETIC_SECRET_MUST_NOT_RENDER'
};
const compositePackage = { schema: 'synthetic-composite', backup: { apiKey: 'SYNTHETIC_SECRET_MUST_NOT_RENDER' } };
const compositeApi = {
  async buildFromFiles(files) { return files.length === 3 ? { ok: true, packagePlan: compositePackage, summary: compositeSummary } : { ok: false, error: 'source-count-invalid' }; },
  async validate(plan) { return plan === compositePackage ? { ok: true } : { ok: false, error: 'plan-invalid' }; }
};

function planFixture() {
  return {
    schema: 'internalbeyond.restore-plan', version: 1, mode: 'dry-run', status: 'READY_FOR_EXPLICIT_RESTORE_APPROVAL',
    planId: 'r3b3:' + '1'.repeat(64), transactionId: 'r3b3-tx:' + '1'.repeat(64), planHash: 'e'.repeat(64),
    compositeBinding: { frozenPlanId: 'synthetic-composite-id', frozenPlanSha256: 'e'.repeat(64), identityAuthority: 'USER_CONFIRMED_IDENTITY_SUCCESSION', identityStatus: 'EXPLICIT_USER_CONFIRMATION', authorityRevisionId: 'synthetic-authority-id', authorityRevisionSha256: 'd'.repeat(64), provenanceRecordCount: 11, provenanceDigest: 'f'.repeat(64) },
    productionBinding: { id: 'r3b3:' + '1'.repeat(64), productionPlanHash: '1'.repeat(64), targetSnapshotSha256: '2'.repeat(64) },
    target: { class: 'production', identity: 'synthetic-canonical-target', origin: 'http://tauri.localhost', databaseName: 'InternalBeyondDB', schemaVersion: 24 },
    selectedDomains: DOMAINS,
    summary: { sourceRecords: 11, targetCollisions: 0, referenceConflicts: 0, sourceDuplicates: 0, rejectedRecords: 0 },
    credentialBoundary: { credentialState: 'NEEDS_REBIND', secretValuesProjected: 0 },
    domains: DOMAINS.map(domain => ({ domain, sourceCount: DOMAIN_COUNTS[domain], validCount: DOMAIN_COUNTS[domain], targetCollisionCount: 0, referenceConflictCount: 0, sourceDuplicateCount: 0, rejectedCount: 0, action: 'INSERT' })),
    mutation: { productionWrites: 0, localStorageWrites: 0, providerCalls: 0 },
    diagnostics: { entries: [], blockerCount: 0, noticeCount: 0, total: 0 }
  };
}

class FakeElement {
  constructor(id, tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.files = [];
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.type = id.includes('confirm-') || id === 'approval-understands-production-write' ? 'checkbox' : 'text';
  }
  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  appendChild(child) { this.children.push(child); return child; }
  async fire(type) { for (const handler of this.listeners[type] || []) await handler({ target: this }); }
}

function fakeDocument() {
  const ids = [
    'recovery-controls','status','recovery-source-workflow','composite-files','validate-composite','dry-run','composite-summary','recovery-details','technical-plan-details',
    'recovery-preview','preview-domain-rows','preview-source-files','preview-excluded-data','preview-plan-id','preview-plan-hash','preview-target-snapshot-hash','preview-source-count','preview-provenance-count','preview-provenance-state',
    'preview-identity-old','preview-identity-new','preview-identity-authority','preview-identity-explanation','preview-api-metadata-count','preview-credential-state',
    'final-confirm-plan','final-confirm-snapshot','final-confirm-identity','final-confirm-credentials','final-restore-confirmation','enter-native-approval','final-confirmation-status',
    'production-approval-controls','approval-plan-id','approval-plan-hash','approval-confirmation','approval-understands-production-write','issue-production-approval','approval-status','execute-production-restore','active-rearm-state'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement(id)]));
  elements['active-rearm-state'].textContent = 'Active remains quarantined. Explicit re-arm is blocked.';
  elements['production-approval-controls'].hidden = true;
  elements['issue-production-approval'].disabled = true;
  elements['execute-production-restore'].disabled = true;
  return {
    elements,
    getElementById(id) { return elements[id] || null; },
    createElement(tagName) { return new FakeElement('', tagName); }
  };
}

function allText(element) {
  return String(element.textContent || '') + (element.children || []).map(allText).join('');
}

function executorStub() {
  const state = { last: null };
  class RecoveryOnlyApplyExecutor {
    constructor(adapter) { this.adapter = adapter; this.approvals = 0; this.executions = 0; state.last = this; }
    async requestApproval(prepared, request) {
      this.approvals++;
      return { ok: true, planId: request.planId, planHash: request.planHash, tokenExposed: false };
    }
    async execute() { this.executions++; return { ok: true, activeQuarantined: true }; }
  }
  return { Constructor: RecoveryOnlyApplyExecutor, state: state };
}

async function run() {
  const recoveryHtml = fs.readFileSync(path.join(__dirname, '..', 'Recovery.html'), 'utf8');
  for (const id of ['recovery-preview','preview-domain-rows','preview-identity-old','preview-identity-new','preview-credential-state','preview-excluded-data','final-confirm-plan','final-confirm-snapshot','final-confirm-identity','final-confirm-credentials','final-restore-confirmation','enter-native-approval','production-approval-controls']) {
    assert.ok(recoveryHtml.includes('id="' + id + '"'), 'Recovery.html missing ' + id);
  }
  assert.match(recoveryHtml, /id="recovery-preview"[^>]*hidden/);
  assert.match(recoveryHtml, /id="production-approval-controls"[^>]*hidden/);
  assert.ok(recoveryHtml.includes(UI.FINAL_RESTORE_CONFIRMATION));

  const previewPlan = planFixture();
  const model = UI.buildRecoveryPreviewModel(previewPlan, compositeSummary);
  assert.strictEqual(model.ok, true);
  assert.strictEqual(model.complete, true);
  assert.strictEqual(model.planId, previewPlan.planId);
  assert.strictEqual(model.planSha256, previewPlan.productionBinding.productionPlanHash);
  assert.strictEqual(model.targetSnapshotSha256, previewPlan.productionBinding.targetSnapshotSha256);
  assert.strictEqual(model.sourceCount, 11);
  assert.strictEqual(model.provenanceCount, 11);
  assert.deepStrictEqual(model.domains.map(item => item.domain), UI.PREVIEW_DOMAIN_ORDER);
  assert.strictEqual(model.domains.find(item => item.domain === 'apiConfigs').source, 'synthetic-primary.json + synthetic-role.json');
  assert.strictEqual(model.domains.find(item => item.domain === 'memories').source, 'synthetic-primary.json + synthetic-memory.json');
  assert.strictEqual(model.identitySuccession.oldId, 'old_role');
  assert.strictEqual(model.identitySuccession.newId, 'new_role');
  assert.strictEqual(model.identitySuccession.authority, 'USER_CONFIRMED_IDENTITY_SUCCESSION');
  assert.match(model.identitySuccession.explanation, /不是自动迁移发现/);
  assert.strictEqual(model.credentialBoundary.state, 'NEEDS_REBIND');
  assert.strictEqual(model.credentialBoundary.apiKeysRestored, false);
  assert.strictEqual(model.credentialBoundary.secretValuesRestored, false);
  assert.strictEqual(model.credentialBoundary.credentialVaultRestored, false);
  assert.deepStrictEqual(model.excludedData, ['cache', 'WebView session', 'WAL/SHM physical files', 'logs', 'runtime state']);
  assert.ok(!JSON.stringify(model).includes('SYNTHETIC_SECRET_MUST_NOT_RENDER'));

  const previous = {
    engine: global.IBRecoveryEngine,
    composite: global.IBCompositeRecoveryPlan,
    adapter: global.IBProductionRecoveryAdapter,
    executor: global.IBRecoveryApplyExecutor
  };
  const executorStubResult = executorStub();
  global.IBRecoveryEngine = Engine;
  global.IBCompositeRecoveryPlan = compositeApi;
  global.IBProductionRecoveryAdapter = {
    PRODUCTION_APPLY_ENABLED: false,
    ProductionRecoveryAdapter: class ProductionRecoveryAdapter {
      constructor() { this.PRODUCTION_APPLY_ENABLED = false; }
      async dryRun() { return { plan: planFixture(), payload: {} }; }
    }
  };
  global.IBRecoveryApplyExecutor = { CONFIRMATION: 'EXECUTE_SYNTHETIC_RESTORE', RecoveryOnlyApplyExecutor: executorStubResult.Constructor };
  try {
    const doc = fakeDocument();
    const machine = UI.mount({ document: doc });
    const el = doc.elements;
    el['composite-files'].files = [{ name: 'primary.json' }, { name: 'role.json' }, { name: 'memory.json' }];
    await el['composite-files'].fire('change');
    await el['validate-composite'].fire('click');
    await el['dry-run'].fire('click');

    assert.strictEqual(el['recovery-preview'].hidden, false);
    assert.strictEqual(el['recovery-source-workflow'].hidden, true);
    assert.strictEqual(el['preview-plan-id'].textContent, previewPlan.planId);
    assert.strictEqual(el['preview-plan-hash'].textContent, previewPlan.productionBinding.productionPlanHash);
    assert.strictEqual(el['preview-target-snapshot-hash'].textContent, previewPlan.productionBinding.targetSnapshotSha256);
    assert.strictEqual(el['preview-source-count'].textContent, '11');
    assert.strictEqual(el['preview-provenance-count'].textContent, '11');
    assert.strictEqual(el['preview-domain-rows'].children.length, 9);
    assert.ok(el['preview-domain-rows'].children.some(row => allText(row).includes('autoMemory')));
    assert.strictEqual(el['preview-identity-old'].textContent, 'old_role');
    assert.strictEqual(el['preview-identity-new'].textContent, 'new_role');
    assert.strictEqual(el['preview-identity-authority'].textContent, 'USER_CONFIRMED_IDENTITY_SUCCESSION');
    assert.strictEqual(el['preview-credential-state'].textContent, 'NEEDS_REBIND');
    assert.deepStrictEqual(el['preview-excluded-data'].children.map(item => item.textContent), model.excludedData);
    assert.ok(!allText(el['recovery-preview']).includes('SYNTHETIC_SECRET_MUST_NOT_RENDER'));
    assert.strictEqual(el['production-approval-controls'].hidden, true);
    assert.strictEqual(el['enter-native-approval'].disabled, true);
    assert.strictEqual(machine.view().approvalReady, false);

    const approvalExecutor = executorStubResult.state.last;
    const blockedApproval = await machine.approve({ planId: previewPlan.planId, planHash: previewPlan.productionBinding.productionPlanHash, confirmation: UI.APPROVAL_TEXT });
    assert.strictEqual(blockedApproval.error, 'final-restore-confirmation-required');
    assert.strictEqual((await machine.apply()).error, 'explicit-production-restore-approval-required');
    assert.strictEqual(machine.view().checkpointCreated, false);
    assert.strictEqual(machine.view().finalRestoreConfirmationComplete, false);

    el['final-confirm-plan'].checked = true;
    el['final-confirm-snapshot'].checked = true;
    el['final-confirm-identity'].checked = true;
    el['final-confirm-credentials'].checked = true;
    el['final-restore-confirmation'].value = UI.FINAL_RESTORE_CONFIRMATION;
    for (const id of ['final-confirm-plan','final-confirm-snapshot','final-confirm-identity','final-confirm-credentials']) await el[id].fire('change');
    await el['final-restore-confirmation'].fire('input');
    assert.strictEqual(el['enter-native-approval'].disabled, false);
    await el['enter-native-approval'].fire('click');

    assert.strictEqual(machine.view().finalRestoreConfirmationComplete, true);
    assert.strictEqual(machine.view().state, 'APPROVAL_REQUIRED');
    assert.strictEqual(machine.view().approvalReady, false);
    assert.strictEqual(el['production-approval-controls'].hidden, false);
    assert.strictEqual(el['issue-production-approval'].disabled, true);
    assert.strictEqual(el['execute-production-restore'].disabled, true);
    assert.strictEqual(el['final-confirmation-status'].textContent.includes('no approval has been issued'), true);
    assert.strictEqual(machine.view().checkpointCreated, false);
    assert.strictEqual(approvalExecutor.approvals, 0);
    assert.strictEqual(approvalExecutor.executions, 0);
    console.log('PASS P5.8.6 recovery preview UI and final-confirmation gate checks');
  } finally {
    global.IBRecoveryEngine = previous.engine;
    global.IBCompositeRecoveryPlan = previous.composite;
    global.IBProductionRecoveryAdapter = previous.adapter;
    global.IBRecoveryApplyExecutor = previous.executor;
  }
}

run().catch(error => {
  process.stderr.write('FAIL ' + String(error && error.stack || error) + '\n');
  process.exitCode = 1;
});
