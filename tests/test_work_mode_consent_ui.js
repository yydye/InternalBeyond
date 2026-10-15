'use strict';

/* P28-WM-P3A.1 · explicit UI controller contract; all Provider calls are mocked. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const uiModule = require('../assets/js/work-mode-consent-ui.js');
const consentCore = require('../assets/js/work-mode-consent-core.js');
const memoryRecall = require('../assets/js/work-mode-memory-recall.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = 'wr_12345678-1234-1234-1234-123456789012';
const CONSENT_ID = 'wrc_12345678-1234-1234-1234-123456789012';
const PROJECT_REF = 'project_ui_test';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function recallRecord(memoryId, projectRef, statement, revision) {
  return {
    memoryId: memoryId, type: 'Fact', projectRef: projectRef, status: 'active', effectiveStatus: 'active',
    revision: revision || 1, expiresAt: null, supersededBy: null, retractedAt: null,
    payload: { statement: statement, confidence: 'high', observedAt: 100 },
    provenance: [{ sourceKind: 'work_result_ref', sourceRef: 'wrr_recall_fixture', sourceRevision: '1',
      selectionRef: 'finding:0', recordedAt: 100 }]
  };
}

function createHarness(controllerOptions) {
  controllerOptions = controllerOptions || {};
  let routeHash = 'a'.repeat(64), middleRouteHash = 'b'.repeat(64);
  let currentRun = { runId: RUN_ID, workflowId: 'project.audit.readonly', projectRef: PROJECT_REF, status: 'queued', version: 1 };
  let consent = null;
  let consentGetResult = null;
  let memoryRevision = 0;
  let memoryRecords = [recallRecord('am_12345678-1234-1234-1234-123456789012', PROJECT_REF,
    'Use the existing parser contract.', 1)];
  let memoryQueryFailure = false;
  let report = { schemaVersion: 1, summary: 'Only the selected report content.', findings: [
    { severity: 'medium', title: 'Review one file', detail: 'A single finding, not the full report.', path: 'src/a.js', line: 4 }
  ] };
  let projects = [{ id: PROJECT_REF }];
  let workspaceFailure = false;
  let memoryCommitGate = null;
  let memoryCommitError = '';
  const calls = { grants: [], starts: [], dshStarts: [], revokes: [], eventReads: [], runCreates: [], recovers: 0, cancellations: 0, resultReads: 0, resultDeletes: 0,
    memoryCommits: [], procedureMemoryCommits: [], memoryRetractions: [], memoryPreviews: [], memoryProvenanceReads: [] };
  const files = [
    { fileId: 'file_a', path: 'src/a.js', size: 120, contentHash: 'a'.repeat(64) },
    { fileId: 'file_b', path: 'tests/a.test.js', size: 80, contentHash: 'b'.repeat(64) }
  ];
  const projectFiles = {
    [PROJECT_REF]: files,
    project_ui_next: [{ fileId: 'file_next', path: 'src/next.js', size: 40, contentHash: 'c'.repeat(64) }]
  };
  let savedDraft = null;
  let importFailure = null;
  let memoryProvenanceResult = controllerOptions.memoryProvenanceResult || null;
  const scopes = () => [
    { destination: 'agent', providerRef: 'agent_profile', provider: 'openai', model: 'audit-model', routeHash },
    { destination: 'middle_brain', providerRef: 'mb_profile', provider: 'openai', model: 'review-model', routeHash: middleRouteHash }
  ];
  let gate = null;
  const runtime = {
    recoverInterruptedRuns: async () => { calls.recovers++; return { ok: true }; },
    previewAuthorization: async input => ({
      ok: true,
      run: clone(currentRun),
      projectRef: PROJECT_REF,
      providers: scopes().map(scope => Object.assign({}, scope, { endpointLabel: 'https://provider.test/v1' })),
      files: clone(files),
      terms: { version: consentCore.TERMS_VERSION, purpose: 'project.audit.readonly',
        resultRetentionMs: consentCore.RESULT_RETENTION_MS, resultStorage: 'plaintext_home_node_sqlite' }
    }),
    previewMemoryRecall: async input => {
      calls.memoryPreviews.push(clone(input));
      if (memoryQueryFailure) return { ok: false, error: 'agent-memory-query-failed' };
      if (!projects.some(project => project && project.id === input.projectRef)) return { ok: false, error: 'project-access-denied' };
      const records = memoryRecall.normalizeRecords(memoryRecords.filter(record => record.projectRef === input.projectRef), input.projectRef, Date.now());
      if (!Object.prototype.hasOwnProperty.call(input, 'recordIds')) {
        return { ok: true, projectRef: input.projectRef, records, count: records.length, total: records.length, hasMore: false };
      }
      const snapshot = await memoryRecall.createSnapshot(memoryRecords, input.projectRef, input.recordIds, Date.now(), crypto.webcrypto);
      return snapshot.ok === true
        ? { ok: true, projectRef: input.projectRef, records, snapshot, count: records.length, total: records.length, hasMore: false }
        : snapshot;
    },
    grantConsent: async input => {
      calls.grants.push(clone(input));
      if (gate) await gate.promise;
      consent = {
        consentId: CONSENT_ID, runId: RUN_ID, projectRef: PROJECT_REF,
        providerScopes: clone(input.__scopes || scopes()), fileIds: input.fileIds.slice().sort(),
        memoryScope: clone(input.memoryScope == null ? null : input.memoryScope),
        memoryDerivedScope: clone(input.memoryDerivedScope == null ? null : input.memoryDerivedScope),
        termsVersion: input.termsVersion, status: 'active', expiresAt: Date.now() + input.expiresInMs
      };
      return { ok: true, run: clone(currentRun), consent: clone(consent) };
    },
    revokeConsent: async (runId, consentId) => {
      calls.revokes.push({ runId, consentId });
      if (consent) consent.status = 'revoked';
      return { ok: true, run: clone(currentRun), consent: clone(consent) };
    },
    start: async input => {
      calls.starts.push(clone(input));
      currentRun = Object.assign({}, currentRun, { status: 'completed', version: 2 });
      return { ok: true, run: clone(currentRun), result: { status: 'available' } };
    },
    startDsh: async input => {
      calls.dshStarts.push(clone(input));
      currentRun = Object.assign({}, currentRun, { status: 'completed', version: 2 });
      return { ok: true, run: clone(currentRun), result: { status: 'available' } };
    },
    cancel: async () => {
      calls.cancellations++;
      currentRun = Object.assign({}, currentRun, { status: 'cancelled', version: currentRun.version + 1 });
      if (consent) consent.status = 'revoked';
      return { ok: true, run: clone(currentRun) };
    },
    getResult: async runId => {
      calls.resultReads++;
      return { ok: true, run: clone(currentRun), result: {
        runId, resultId: 'wrr_12345678-1234-1234-1234-123456789012', schemaVersion: 1,
        status: 'available', expiresAt: Date.now() + 10000, report: clone(report)
      } };
    },
    deleteResult: async () => {
      calls.resultDeletes++;
      return { ok: true, run: clone(currentRun), result: { status: 'deleted' } };
    }
  };
  const homeNode = {
    create: async input => {
      calls.runCreates.push(clone(input));
      currentRun = Object.assign({}, currentRun, { projectRef: input.projectRef, status: 'queued', version: 1 },
        input.executorSelection ? { executorSelection: clone(input.executorSelection) } : {});
      return { ok: true, run: clone(currentRun) };
    },
    setExecutorSelection: async (runId, input) => {
      if (runId !== currentRun.runId || currentRun.status !== 'queued') return { ok: false, error: 'run-not-queued' };
      currentRun.executorSelection = clone(input.executorSelection);
      return { ok: true, run: clone(currentRun) };
    },
    get: async () => ({ ok: true, run: clone(currentRun) }),
    bindDshSession: async (runId, input) => ({ ok: true, run: clone(currentRun), binding: {
      runId: runId, sessionId: input.sessionId, consentId: input.consentId
    } }),
    getConsent: async () => consentGetResult ? clone(consentGetResult)
      : (consent ? { ok: true, consent: clone(consent) } : { ok: false, error: 'consent-not-found' }),
    listActive: async () => ({ ok: true, runs: currentRun.status === 'queued' ? [clone(currentRun)] : [], hasMore: false }),
    listResults: async () => ({ ok: true, results: [{ runId: RUN_ID, projectRef: PROJECT_REF, resultStatus: 'available', expiresAt: Date.now() + 10000 }], hasMore: false }),
    dshStatus: async () => ({ ok: true, host: {
      enabled: controllerOptions.dshEnabled === true,
      dshRevision: controllerOptions.dshEnabled === true ? 'd743267388641bc76f17c45ce8b4c231aed1d32c' : null,
      activeRuns: 0,
      activeRunIds: []
    } }),
    events: async (runId, options) => {
      calls.eventReads.push({ runId, options: clone(options) });
      return { ok: true, events: [{ sequence: 1, eventType: 'created', fromStatus: null,
        toStatus: 'queued', version: 1, reasonCode: null, createdAt: 100 }],
      executionEvents: clone(controllerOptions.executionEvents || []), hasMore: false, nextSequence: 1 };
    },
    memoryProvenance: async runId => {
      calls.memoryProvenanceReads.push(runId);
      return { ok: true, runId: runId,
        consent: consent ? {
          status: consent.status,
          issuedAt: Number(consent.issuedAt) || 100,
          expiresAt: Number(consent.expiresAt) || 200,
          revokedAt: consent.revokedAt == null ? null : Number(consent.revokedAt),
          memoryScope: clone(consent.memoryScope || null),
          memoryDerivedScope: consent.memoryDerivedScope ? {
            contextHash: consent.memoryDerivedScope.contextHash,
            reviewConfirmed: consent.memoryDerivedScope.review && consent.memoryDerivedScope.review.confirmed === true,
            resultConfirmed: consent.memoryDerivedScope.result && consent.memoryDerivedScope.result.confirmed === true
          } : null
        } : { status: 'not_found', issuedAt: null, expiresAt: null, revokedAt: null,
          memoryScope: null, memoryDerivedScope: null },
        result: clone(memoryProvenanceResult) };
    }
  };
  const agentMemory = {
    state: async () => ({ ok: true, state: { storeRevision: memoryRevision } }),
    query: async options => ({ ok: true, records: clone(memoryRecords.filter(record => record.projectRef === options.projectRef
      && (!options.type || record.type === options.type))) }),
    commitWorkResultCandidate: async input => {
      calls.memoryCommits.push(clone(input));
      if (memoryCommitGate) await memoryCommitGate.promise;
      if (memoryCommitError) return { ok: false, error: memoryCommitError };
      const duplicate = memoryRecords.find(record => record.type === 'Observation'
        && record.projectRef === PROJECT_REF && record.provenance.some(item => item.sourceRef === input.resultId
          && item.selectionRef === input.selectionRef));
      if (duplicate) return { ok: true, duplicate: true, record: clone(duplicate), storeRevision: memoryRevision };
      if (input.expectedStoreRevision !== memoryRevision) return { ok: false, error: 'version-conflict', storeRevision: memoryRevision };
      const record = {
        memoryId: 'am_12345678-1234-1234-1234-123456789012', type: 'Observation', projectRef: PROJECT_REF,
        status: 'active', revision: 1, payload: { statement: report.findings[0].severity + ' · '
          + report.findings[0].title + ': ' + report.findings[0].detail, contextRef: 'wm:' + input.selectionRef },
        provenance: [{ sourceKind: 'work_result_ref', sourceRef: input.resultId,
          sourceRevision: '1', selectionRef: input.selectionRef, recordedAt: Date.now() }], expiresAt: Date.now() + 30 * 86400000
      };
      memoryRecords.push(record);
      memoryRevision++;
      return { ok: true, duplicate: false, record: clone(record), storeRevision: memoryRevision };
    },
    commitWorkResultProcedureCandidate: async input => {
      calls.procedureMemoryCommits.push(clone(input));
      if (memoryCommitGate) await memoryCommitGate.promise;
      if (memoryCommitError) return { ok: false, error: memoryCommitError };
      if (input.expectedStoreRevision !== memoryRevision) return { ok: false, error: 'version-conflict', storeRevision: memoryRevision };
      const selectionRef = 'procedure:' + crypto.createHash('sha256').update(JSON.stringify(input.payload)).digest('hex');
      const duplicate = memoryRecords.find(record => record.type === 'Procedure' && record.projectRef === PROJECT_REF
        && record.provenance.some(item => item.sourceRef === input.resultId && item.sourceRunId === input.runId
          && item.selectionRef === selectionRef));
      if (duplicate) return { ok: true, duplicate: true, record: clone(duplicate), storeRevision: memoryRevision };
      const record = {
        memoryId: 'am_87654321-1234-4234-8234-123456789012', type: 'Procedure', projectRef: PROJECT_REF,
        status: 'active', revision: 1, payload: clone(input.payload), provenance: [{
          sourceKind: 'work_result_ref', sourceRef: input.resultId, sourceRevision: '1',
          sourceRunId: input.runId, selectionRef: selectionRef, recordedAt: Date.now()
        }]
      };
      memoryRecords.push(record);
      memoryRevision++;
      return { ok: true, duplicate: false, record: clone(record), storeRevision: memoryRevision };
    },
    retract: async (memoryId, input) => {
      calls.memoryRetractions.push({ memoryId, input: clone(input) });
      const record = memoryRecords.find(item => item.memoryId === memoryId);
      if (!record || record.revision !== input.expectedRevision) return { ok: false, error: 'version-conflict' };
      record.status = 'retracted';
      record.revision++;
      record.payload = null;
      memoryRevision++;
      return { ok: true, record: clone(record), storeRevision: memoryRevision };
    }
  };
  const workspace = {
    wsGetProjects: async () => {
      if (workspaceFailure) throw new Error('workspace-unavailable');
      return clone(projects);
    },
    wsGetWorkModeProjects: async () => workspaceFailure
      ? { ok: false, error: 'workspace-unavailable' }
      : { ok: true, projects: clone(projects) },
    wsGetWorkModeProjectSnapshot: async projectRef => workspaceFailure
      ? { ok: false, error: 'workspace-unavailable' }
      : (projects.some(project => project && project.id === projectRef)
        ? { ok: true, projectRef, projectName: (projects.find(project => project && project.id === projectRef) || {}).name || projectRef,
          projectPath: '', files: clone(projectFiles[projectRef] || []) }
        : { ok: false, error: 'project-not-found' }),
    wsCreateWorkModeProject: async name => {
      const existing = projects.find(project => project && project.name === name);
      if (existing) return { ok: true, projectRef: existing.id, projectName: name, created: false };
      const projectRef = 'project_ui_created';
      projects = projects.concat([{ id: projectRef, name }]);
      projectFiles[projectRef] = [];
      return { ok: true, projectRef, projectName: name, created: true };
    },
    wsDeleteProject: async projectRef => {
      projects = projects.filter(project => !project || project.id !== projectRef);
      delete projectFiles[projectRef];
      return { ok: true };
    },
    wsImportWorkModeFiles: async (projectRef, selectedFiles) => {
      if (importFailure) return clone(importFailure);
      const imported = [];
      if (!projectFiles[projectRef]) projectFiles[projectRef] = [];
      selectedFiles.forEach((file, index) => {
        const path = file.webkitRelativePath || file.name;
        const fileId = 'file_imported_' + index;
        projectFiles[projectRef].push({ fileId, path, size: Number(file.size) || 0, contentHash: 'f'.repeat(64) });
        imported.push(fileId);
      });
      return { ok: true, projectRef, imported, unchanged: [], skipped: {},
        snapshot: { ok: true, projectRef, projectPath: '', files: clone(projectFiles[projectRef] || []) } };
    }
  };
  const controller = uiModule.createController({
    runtime, homeNode, agentMemory, workspace, consentCore, memoryRecall,
    getApiProfiles: () => [{ id: 'agent_profile', nickname: 'Synthetic Test Agent', provider: 'openai', model: 'audit-model',
      endpoint: 'https://provider.test/v1', credentialRef: 'agent_profile', systemPrompt: 'Synthetic identity fixture.' },
    { id: 'mb_profile', nickname: 'Synthetic Review', provider: 'openai', model: 'review-model',
      endpoint: 'https://provider.test/v1', credentialRef: 'mb_profile' }],
    projectDraft: {
      load: () => clone(savedDraft),
      save: value => { savedDraft = clone(value); return true; },
      clear: () => { savedDraft = null; return true; }
    },
    requireFileSelection: controllerOptions.requireFileSelection === true,
    requestId: () => 'ui-request-1', now: () => Date.now()
  });
  return {
    controller, calls, setRouteHash(value) { routeHash = value; }, setMiddleRouteHash(value) { middleRouteHash = value; },
    setGrantGate(value) { gate = value; },
    releaseGrant() { if (gate) gate.resolve(); },
    getConsent() { return consent; },
    setConsent(value) { consent = value ? clone(value) : null; },
    setMemoryProvenanceResult(value) { memoryProvenanceResult = value ? clone(value) : null; },
    setConsentGetResult(value) { consentGetResult = value ? clone(value) : null; },
    setRunStatus(status) { currentRun = Object.assign({}, currentRun, { status }); },
    setProjects(value) { projects = value; },
    setWorkspaceFailure(value) { workspaceFailure = value === true; },
    setMemoryQueryFailure(value) { memoryQueryFailure = value === true; },
    setMemoryRecords(value) { memoryRecords = clone(value); },
    setMemoryRevision(value) { memoryRevision = value; },
    setMemoryCommitGate(value) { memoryCommitGate = value; },
    releaseMemoryCommit() { if (memoryCommitGate) memoryCommitGate.resolve(); },
    setMemoryCommitError(value) { memoryCommitError = value; },
    setReport(value) { report = clone(value); },
    getDraft() { return clone(savedDraft); },
    setDraft(value) { savedDraft = clone(value); },
    setWorkspaceFiles(projectRef, value) { projectFiles[projectRef] = clone(value); },
    setImportFailure(value) { importFailure = value ? clone(value) : null; }
  };
}

async function testExplicitConsentAndDuplicateSubmit() {
  const h = createHarness();
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  assert.strictEqual((await ui.createRun(PROJECT_REF)).ok, true);
  assert.strictEqual((await ui.previewAuthorization()).ok, true);
  await ui.setFileIds(['file_a']);
  assert.strictEqual((await ui.grant(300000, true)).error, 'explicit-consent-required',
    'the UI cannot mint consent without an explicit scope confirmation');
  assert.strictEqual(h.calls.grants.length, 0);
  assert.strictEqual(ui.confirmScope(true).ok, true);
  assert.strictEqual((await ui.grant(300000, true)).error, 'explicit-consent-required',
    'egress confirmation alone does not accept the separate local-storage risk');
  assert.strictEqual(h.calls.grants.length, 0);
  await ui.confirmStorageRisk(true);
  const gate = deferred();
  h.setGrantGate(gate);
  const first = ui.grant(300000, true);
  const second = ui.grant(300000, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(h.calls.grants.length, 1);
  h.releaseGrant();
  const granted = await first;
  assert.strictEqual(granted.ok, true);
  assert.deepStrictEqual(granted.consent.fileIds, ['file_a']);
  assert.strictEqual(h.calls.grants[0].confirmed, true);
  assert.strictEqual(h.calls.starts.length, 0, 'grant does not auto-start the Run');
  assert.strictEqual((await ui.grant(300000, true)).duplicate, true);
  assert.strictEqual(h.calls.grants.length, 1, 'a repeated grant after success cannot mint a second consent');
}

async function testRunTraceReadsOnlyHomeNodeEvents() {
  const h = createHarness();
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  assert.strictEqual((await ui.createRun(PROJECT_REF)).ok, true);
  const state = ui.getState();
  assert.strictEqual(state.runEventsRunId, RUN_ID);
  assert.strictEqual(state.runEventsStatus, 'ready');
  assert.deepStrictEqual(state.runEvents.map(event => event.sequence), [1]);
  assert.deepStrictEqual(h.calls.eventReads[0], { runId: RUN_ID, options: { afterSequence: 0, limit: 100 } });
  assert.strictEqual(JSON.stringify(state.runEvents).includes('prompt'), false,
    'the trace view only presents Home Node status events, not prompts or model output');
}

async function testActionTraceProjectionIsReadonlyAndMetadataOnly() {
  const event = { eventType: 'action_trace', createdAt: 100, actionTrace: {
    schemaVersion: 1, actionId: 'ib.work.plan.v1', requestId: 'trace-plan-1', runId: RUN_ID,
    status: 'denied', authorityResult: 'denied', injectedContent: 'MUST_NOT_RENDER'
  } };
  assert.strictEqual(uiModule.runEventLabel(event), '制定执行计划 · 已拒绝');
  const detail = uiModule.runEventDetail(event);
  assert(detail.includes('ib.work.plan.v1') && detail.includes('trace-plan-1') && detail.includes(RUN_ID));
  assert(detail.includes('Authority 未授权'));
  assert.strictEqual(detail.includes('MUST_NOT_RENDER'), false, 'the presentation allowlists trace metadata');
  assert.strictEqual(uiModule.runEventLabel({ eventType: 'action_trace', actionTrace: {
    actionId: 'ib.work.unknown.v1', status: 'denied'
  } }), 'Action 调用 · 已拒绝');
}

async function testWorkspaceChangeTraceSupportsCanonicalAndLegacyCodes() {
  const canonical = uiModule.runEventDetail({ executor: 'dsh', executionEvent: 'tool-denied',
    toolName: 'project.read_file', fileId: 'file_a', code: 'workspace-changed', reason: 'snapshot-mismatch' });
  const legacy = uiModule.runEventDetail({ executor: 'dsh', executionEvent: 'tool-denied',
    toolName: 'project.read_file', fileId: 'file_a', code: 'workspace-changed-snapshot' });
  assert.strictEqual(canonical, 'file_a · Workspace 与授权快照不一致');
  assert.strictEqual(legacy, canonical, 'old persisted Host events keep the same snapshot meaning');
  assert.strictEqual(uiModule.runEventDetail({ executor: 'dsh', executionEvent: 'tool-denied',
    toolName: 'project.read_file', fileId: 'file_a', code: 'workspace-changed' }), 'file_a · workspace-changed',
  'a generic change event is not mislabeled as an authorized-snapshot mismatch');
}

async function testMemoryProvenanceProjectionIsExactAndMetadataOnly() {
  const h = createHarness();
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  assert.strictEqual((await ui.createRun(PROJECT_REF)).ok, true);

  let projection = ui.getState().memoryProvenance;
  assert.strictEqual(projection.status, 'ready');
  assert.strictEqual(projection.consent.status, 'not_found');
  assert.deepStrictEqual(projection.records, [], 'no Consent has no inferred Memory references');

  const state = ui.getState();
  const memoryId = state.memoryRecall.records[0].memoryId;
  const localRecords = state.memoryRecall.records.map(record => Object.assign({
    projectRef: PROJECT_REF, status: 'active', effectiveStatus: 'active', expiresAt: null,
    supersededBy: null, retractedAt: null
  }, record));
  const snapshot = await memoryRecall.createSnapshot(localRecords, PROJECT_REF, [memoryId], Date.now(), crypto.webcrypto);
  assert.strictEqual(snapshot.ok, true);
  const memoryScope = {
    projectRef: PROJECT_REF, refs: snapshot.refs, contextHash: snapshot.contextHash, contextChars: snapshot.contextChars
  };
  h.setConsent({
    status: 'revoked', issuedAt: 100, expiresAt: 200, revokedAt: 150,
    memoryScope,
    memoryDerivedScope: { contextHash: snapshot.contextHash,
      review: { confirmed: true }, result: { confirmed: false } }
  });
  h.setMemoryProvenanceResult({
    resultId: 'wrr_12345678-1234-1234-1234-123456789012', status: 'available', createdAt: 180,
    memoryDerived: true, memoryContextHash: snapshot.contextHash
  });
  const previewCount = h.calls.memoryPreviews.length;
  assert.strictEqual((await ui.refreshMemoryProvenance(RUN_ID)).ok, true);
  projection = ui.getState().memoryProvenance;
  assert.strictEqual(projection.consent.status, 'revoked');
  assert.deepStrictEqual(projection.records[0], {
    memoryId: memoryId, projectRef: PROJECT_REF, type: 'Fact', revision: snapshot.refs[0].revision,
    contentHash: snapshot.refs[0].contentHash, recordStatus: 'matched'
  }, 'type is exposed only when the current project-scoped record matches the exact authorized hash');
  assert.strictEqual(projection.result.memoryDerived, true);
  assert.strictEqual(projection.result.memoryContextHash, snapshot.contextHash);
  assert.strictEqual(JSON.stringify(projection).includes('Use the existing parser contract.'), false,
    'the provenance projection never contains Memory payload text');
  assert.strictEqual(JSON.stringify(projection).includes('payload'), false);
  assert.strictEqual(h.calls.memoryPreviews.length, previewCount,
    'provenance verifies against the already-loaded preview and does not issue another Recall query');

  h.setConsent(Object.assign({}, h.getConsent(), { memoryScope: Object.assign({}, memoryScope, {
    refs: memoryScope.refs.map(ref => Object.assign({}, ref, { contentHash: '0'.repeat(64) }))
  }) }));
  assert.strictEqual((await ui.refreshMemoryProvenance(RUN_ID)).ok, true);
  projection = ui.getState().memoryProvenance;
  assert.strictEqual(projection.records[0].recordStatus, 'changed');
  assert.strictEqual(projection.records[0].type, '', 'a changed record never reveals unverified current metadata');
}

async function testWorkflowStatusAndResultExportProjection() {
  const status = uiModule.deriveWorkflowStatus;
  assert.strictEqual(status({}, false, 100).key, 'not-started');
  assert.strictEqual(status({ run: { runId: RUN_ID, status: 'queued' } }, false, 100).key, 'not-started');
  assert.strictEqual(status({ run: { runId: RUN_ID, status: 'running' } }, false, 100).key, 'running');
  assert.strictEqual(status({ run: { runId: RUN_ID, status: 'failed' } }, false, 100).key, 'failed');
  assert.strictEqual(status({ run: { runId: RUN_ID, status: 'cancelled' } }, false, 100).key, 'cancelled');

  const completedRun = { runId: RUN_ID, projectRef: PROJECT_REF, status: 'completed', credentialRef: 'sk-should-not-export' };
  const resultMeta = { runId: RUN_ID, resultStatus: 'available', expiresAt: 500 };
  assert.strictEqual(status({ run: completedRun, results: [resultMeta] }, false, 100).key, 'waiting-review');
  assert.strictEqual(status({ run: completedRun, results: [resultMeta] }, true, 100).key, 'completed');
  assert.strictEqual(status({ run: completedRun, results: [Object.assign({}, resultMeta, { expiresAt: 90 })] }, false, 100).key,
    'completed', 'expired result references never remain in the review stage');

  const selection = {
    run: completedRun,
    result: {
      status: 'available', resultId: 'wrr_export_fixture', expiresAt: 500,
      report: { summary: 'A reviewed summary.', findings: [
        { severity: 'low', title: 'Small note', path: 'src/a.js', line: 4, detail: 'Keep this finding.' }
      ] }, credential: 'sk-result-should-not-export'
    },
    consent: { token: 'sk-consent-should-not-export' }
  };
  assert.strictEqual(status({ run: completedRun, results: [resultMeta], selectedResult: selection }, false, 100).key,
    'waiting-review');
  const markdown = uiModule.formatResultMarkdown(selection);
  assert(markdown.includes('# Work Result') && markdown.includes('A reviewed summary.')
    && markdown.includes('Small note') && markdown.includes('src/a.js:4'));
  assert(!markdown.includes('sk-should-not-export') && !markdown.includes('sk-result-should-not-export')
    && !markdown.includes('sk-consent-should-not-export'), 'the local export includes only explicit Run/Result/report fields');
  assert.strictEqual(uiModule.formatResultMarkdown({ run: completedRun, result: { status: 'deleted' } }), '');
}

async function testExecutionStageProjectionUsesOnlyRunEvents() {
  const derive = uiModule.deriveExecutionStages;
  const running = { runId: RUN_ID, status: 'running' };
  const stageNames = ['Planning', 'Workspace Read', 'Processing', 'Result Generation', 'Review'];
  const noEvents = derive(running, [], 'ready');
  assert.deepStrictEqual(noEvents.stages.map(stage => stage.label), stageNames);
  assert.strictEqual(noEvents.currentStage, '', 'an empty event list does not invent a sub-stage');
  assert(noEvents.summary.includes('暂无阶段事件'));
  assert(noEvents.stages.every(stage => stage.status === 'unrecorded'));

  const lifecycleOnly = derive(running, [{ sequence: 2, eventType: 'state_changed', toStatus: 'running',
    reasonCode: 'runtime_started', createdAt: 2 }], 'ready');
  assert.strictEqual(lifecycleOnly.currentStage, 'processing');
  assert.strictEqual(lifecycleOnly.precision, 'coarse');
  assert(lifecycleOnly.summary.includes('不代表具体子步骤'));
  assert.strictEqual(lifecycleOnly.stages.find(stage => stage.key === 'processing').status, 'active');
  assert.strictEqual(lifecycleOnly.stages.find(stage => stage.key === 'workspace-read').status, 'unrecorded');

  const observed = derive(running, [
    { sequence: 2, eventType: 'state_changed', toStatus: 'running', reasonCode: 'runtime_started', createdAt: 1 },
    { sequence: 'd1', executionEvent: 'run-started', executor: 'dsh', createdAt: 2 },
    { sequence: 'd2', executionEvent: 'tool-call', toolName: 'project.read_file', executor: 'dsh', createdAt: 3 },
    { sequence: 'd3', executionEvent: 'project-read', toolName: 'project.read_file', executor: 'dsh', createdAt: 4 }
  ], 'ready');
  assert.strictEqual(observed.currentStage, 'processing');
  assert.strictEqual(observed.stages.find(stage => stage.key === 'planning').status, 'done');
  assert.strictEqual(observed.stages.find(stage => stage.key === 'workspace-read').status, 'done');
  assert.strictEqual(observed.stages.find(stage => stage.key === 'processing').status, 'active');
  assert.strictEqual(observed.stages.find(stage => stage.key === 'result-generation').status, 'unrecorded');
  assert.strictEqual(observed.stages.find(stage => stage.key === 'review').status, 'unrecorded');

  const denied = derive({ runId: RUN_ID, status: 'failed' }, [
    { sequence: 'd1', executionEvent: 'tool-denied', toolName: 'project.read_file', executor: 'dsh', createdAt: 10 }
  ], 'ready');
  assert.strictEqual(denied.stages.find(stage => stage.key === 'workspace-read').status, 'failed');

  const staleSnapshot = derive({ runId: RUN_ID, status: 'failed' }, [
    { sequence: 'd1', eventType: 'dsh_tool-denied', executionEvent: 'tool-denied',
      toolName: 'project.read_file', executor: 'dsh', code: 'workspace-changed',
      reasonCode: 'snapshot-mismatch', createdAt: 11 }
  ], 'ready');
  const staleReadStage = staleSnapshot.stages.find(stage => stage.key === 'workspace-read');
  assert.strictEqual(staleReadStage.status, 'failed');
  assert.strictEqual(staleReadStage.statusLabel, '快照已变化', 'a stale snapshot is not mislabeled as a permission denial');
  assert(staleReadStage.detail.includes('授权快照'));

  const completed = derive({ runId: RUN_ID, status: 'completed' }, [], 'ready');
  assert.strictEqual(completed.stages.length, 5);
  assert(completed.stages.every(stage => stage.status === 'done'), 'Home Node completed status closes the stage projection');
}

async function testRuntimeDiagnosticsProjectExistingEvidenceOnly() {
  const derive = uiModule.deriveRuntimeDiagnostics;
  const actionEvent = (sequence, actionId, status, authorityResult, extra) => ({
    sequence, eventType: 'action_trace', createdAt: sequence,
    actionTrace: Object.assign({ runId: RUN_ID, actionId, requestId: 'diag-' + sequence,
      status, authorityResult }, extra || {})
  });
  assert.strictEqual(uiModule.runEventLabel(actionEvent(0, 'ib.project.inspect.v1', 'failed', 'allowed')),
    '检查授权项目结构 · 失败');
  assert.strictEqual(uiModule.runEventLabel(actionEvent(0, 'ib.result.compare.v1', 'denied', 'denied')),
    '比较 Result Artifact · 已拒绝');
  const successRun = { runId: RUN_ID, status: 'completed' };
  const successfulEvents = [
    actionEvent(1, 'ib.project.inspect.v1', 'succeeded', 'allowed'),
    actionEvent(2, 'ib.work.plan.v1', 'succeeded', 'allowed'),
    actionEvent(3, 'ib.workspace.read_file.v1', 'succeeded', 'allowed'),
    actionEvent(4, 'ib.work.result.generate.v1', 'succeeded', 'allowed'),
    actionEvent(5, 'ib.work.review_result.v1', 'succeeded', 'allowed'),
    actionEvent(6, 'ib.work.persist_result.v1', 'succeeded', 'allowed', { prompt: 'DO_NOT_PROJECT' }),
    actionEvent(7, 'ib.result.compare.v1', 'succeeded', 'allowed')
  ];
  const provenance = {
    status: 'ready', consent: { status: 'revoked', memoryScope: { projectRef: PROJECT_REF, refs: [{}] } },
    records: [{ memoryId: 'am_12345678-1234-1234-1234-123456789012', payload: { statement: 'DO_NOT_PROJECT' } }],
    result: { memoryDerived: true, memoryContextHash: 'a'.repeat(64) }
  };
  const success = derive(successRun, successfulEvents, 'ready', provenance, 1000);
  assert.strictEqual(success.currentPhase, '已完成');
  assert.deepStrictEqual(success.completedSteps, [
    'Project Inspect', 'Planning', 'Workspace Read', 'Result Generation', 'Review', 'Result 保存', 'Result Compare'
  ], 'a complete Action Trace path yields only recorded successful steps');
  assert(success.authority.includes('7 条') && success.authority.includes('已授权'));
  assert.strictEqual(success.consent, '已撤销');
  assert(success.memory.includes('Agent Memory 引用 1 条') && success.memory.includes('Result memory-derived'));
  assert.strictEqual(JSON.stringify(success).includes('DO_NOT_PROJECT'), false,
    'diagnostics do not copy prompts, Memory payloads, or other event fields');

  const dshComplete = derive(successRun, [
    { sequence: 'd1', executor: 'dsh', executionEvent: 'model-preflight', createdAt: 1 },
    { sequence: 'd2', executor: 'dsh', executionEvent: 'project-read', toolName: 'project.read_file', createdAt: 2 },
    { sequence: 'd3', executor: 'dsh', executionEvent: 'run-completed', createdAt: 3 }
  ], 'ready', provenance, 1000);
  assert.deepStrictEqual(dshComplete.completedSteps,
    ['权限与模型路由复核', 'Workspace Read', 'Result 保存'],
    'DSH diagnostics derive only steps actually recorded by its existing Host events');

  const failedRun = { runId: RUN_ID, status: 'failed' };
  const failed = derive(failedRun, [
    actionEvent(1, 'ib.work.plan.v1', 'succeeded', 'allowed'),
    actionEvent(2, 'ib.project.inspect.v1', 'denied', 'denied', { secret: 'NO_LEAK' }),
    { sequence: 3, eventType: 'state_changed', toStatus: 'failed', reasonCode: 'runtime_failed', createdAt: 3 }
  ], 'ready', provenance, 1000);
  assert.strictEqual(failed.currentPhase, 'Workspace Read');
  assert.strictEqual(failed.failure.location, 'Workspace Read');
  assert.strictEqual(failed.failure.basis, 'action_trace');

  const compareDenied = derive(failedRun, [
    actionEvent(1, 'ib.result.compare.v1', 'denied', 'denied', { artifactBody: 'NO_LEAK' })
  ], 'ready', provenance, 1000);
  assert.strictEqual(compareDenied.failure.location, 'Review');
  assert(compareDenied.failure.note.includes('当前 Run 的项目范围'));
  assert.strictEqual(JSON.stringify(compareDenied).includes('NO_LEAK'), false);
  assert.strictEqual(failed.failure.authorityDenied, true);
  assert(failed.hint.includes('Consent') && failed.hint.includes('范围'));
  assert.strictEqual(JSON.stringify(failed).includes('NO_LEAK'), false);

  const dshDenied = derive(failedRun, [
    { sequence: 'd1', executor: 'dsh', executionEvent: 'tool-denied', toolName: 'project.read_file', createdAt: 1 },
    { sequence: 'd2', executor: 'dsh', executionEvent: 'run-failed', createdAt: 2 }
  ], 'ready', provenance, 1000);
  assert.strictEqual(dshDenied.failure.location, 'Workspace Read');
  assert.strictEqual(dshDenied.failure.basis, 'run_event');
  assert(dshDenied.authority.includes('DSH Host 记录 1 次工具拒绝'));

  const snapshotChanged = derive(failedRun, [
    { sequence: 'd1', executor: 'dsh', executionEvent: 'tool-denied', toolName: 'project.read_file',
      code: 'workspace-changed', reasonCode: 'snapshot-mismatch', createdAt: 1 },
    { sequence: 'd2', executor: 'dsh', executionEvent: 'run-failed', createdAt: 2 }
  ], 'ready', provenance, 1000);
  assert.strictEqual(snapshotChanged.failure.snapshotMismatch, true);
  assert.strictEqual(snapshotChanged.failure.authorityDenied, false,
    'a stale snapshot is a failed read, not a Consent or permission denial');
  assert(snapshotChanged.hint.includes('刷新 Workspace 文件快照'));
  assert.strictEqual(snapshotChanged.authority.includes('工具拒绝'), false);
  const legacySnapshotEvent = derive(failedRun, [
    { sequence: 'd1', executor: 'dsh', executionEvent: 'tool-denied', toolName: 'project.read_file',
      code: 'workspace-changed-snapshot', createdAt: 1 }
  ], 'ready', provenance, 1000);
  assert.strictEqual(legacySnapshotEvent.failure.snapshotMismatch, true,
    'legacy persisted events retain snapshot semantics in Diagnostics');
  const staleSummary = uiModule.deriveWorkRunSummary({ run: failedRun, results: [],
    runEventsRunId: RUN_ID, runEventsStatus: 'ready', runEvents: [
      { sequence: 'd1', executor: 'dsh', executionEvent: 'tool-denied', toolName: 'project.read_file',
        code: 'workspace-changed', reasonCode: 'snapshot-mismatch', createdAt: 1 }
    ], memoryProvenance: provenance }, false, 1000);
  assert(staleSummary.reason.includes('授权快照与当前 Workspace 不一致'));
  assert(!staleSummary.reason.includes('Consent 拒绝'), 'Summary preserves the stale-snapshot reason without calling it a permission denial');

  const unknownDenied = derive(failedRun, [
    actionEvent(9, 'ib.work.unlisted_action.v9', 'denied', 'denied')
  ], 'ready', provenance, 1000);
  assert.strictEqual(unknownDenied.failure.location, 'Action 阶段未映射');
  assert(unknownDenied.authority.includes('未授权'), 'unmapped Action denial still contributes to the Authority summary');
  assert.strictEqual(JSON.stringify(unknownDenied).includes('unlisted_action'), false,
    'diagnostics do not display unregistered Action identifiers');

  const sparse = derive(failedRun, [], 'unavailable', null, 1000);
  assert.strictEqual(sparse.currentPhase, '失败 · 阶段未定位');
  assert.strictEqual(sparse.failure, null, 'a lifecycle failure with no location remains explicitly unlocated');
  assert.deepStrictEqual(sparse.completedSteps, []);
  assert(sparse.hint.includes('不足以确认'));
  assert.strictEqual(derive(null, [], 'idle', null, 1000).currentPhase, '—');

  const expired = derive({ runId: RUN_ID, status: 'queued' }, [], 'ready', {
    status: 'ready', consent: { status: 'active', expiresAt: 500 }, records: [], result: null
  }, 1000);
  assert.strictEqual(expired.consent, '已过期', 'the diagnostics view does not present an expired active record as valid');
  const consentFallback = derive({ runId: RUN_ID, status: 'running' }, [], 'unavailable', {
    status: 'unavailable'
  }, 1000, { runId: RUN_ID, status: 'active', expiresAt: 1500 });
  assert.strictEqual(consentFallback.consent, '有效', 'the current Run Consent remains visible if Memory Provenance is unavailable');
  const otherRunConsent = derive({ runId: RUN_ID, status: 'running' }, [], 'unavailable', {
    status: 'unavailable'
  }, 1000, { runId: 'wr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'active', expiresAt: 1500 });
  assert.strictEqual(otherRunConsent.consent, 'Consent 状态暂不可用', 'Consent from another Run is never projected');
}

async function testWorkRunSummaryAggregatesExistingDataAndReviewState() {
  const derive = uiModule.deriveWorkRunSummary;
  const run = {
    runId: RUN_ID, workflowId: 'coding.workspace', projectRef: PROJECT_REF, status: 'completed',
    taskPrompt: 'PROMPT_MUST_NOT_RENDER', title: 'PROMPT_TITLE_MUST_NOT_RENDER',
    executorSelection: { credentialRef: 'sk-thiscredentialmustnotrender123456' }
  };
  const actionEvent = (sequence, actionId, requestId, status) => ({
    sequence, eventType: 'action_trace', createdAt: sequence,
    actionTrace: { runId: RUN_ID, actionId, requestId, status: status || 'succeeded', authorityResult: 'allowed',
      prompt: 'TRACE_PROMPT_MUST_NOT_RENDER' }
  });
  const events = [
    actionEvent(1, 'ib.work.plan.v1', 'summary-plan'),
    actionEvent(2, 'ib.workspace.read_file.v1', 'summary-read'),
    actionEvent(3, 'ib.work.result.generate.v1', 'summary-generate'),
    actionEvent(4, 'ib.work.result.generate.v1', 'summary-generate'),
    actionEvent(5, 'ib.work.review_result.v1', 'summary-review'),
    actionEvent(6, 'ib.work.persist_result.v1', 'summary-persist')
  ];
  const selectedResult = {
    run, result: { runId: RUN_ID, resultId: 'wrr_12345678-1234-1234-1234-123456789012',
      status: 'available', expiresAt: 2000, memoryDerived: true,
      report: { summary: 'RESULT_BODY_MUST_NOT_RENDER' }, credential: 'sk-resultcredentialmustnotrender123456' }
  };
  const memoryProvenance = {
    runId: RUN_ID, status: 'ready', consent: { status: 'revoked', memoryScope: {
      projectRef: PROJECT_REF, refs: [{ memoryId: 'am_one' }, { memoryId: 'am_two' }]
    } },
    records: [{ payload: { statement: 'MEMORY_BODY_MUST_NOT_RENDER' } }],
    result: { memoryDerived: true, memoryContextHash: 'a'.repeat(64) }
  };
  const state = {
    run, selectedResult, results: [{ runId: RUN_ID, projectRef: PROJECT_REF,
      resultStatus: 'available', expiresAt: 2000, memoryDerived: true }],
    runEventsRunId: RUN_ID, runEventsStatus: 'ready', runEvents: events,
    projectSnapshot: { projectRef: PROJECT_REF, projectName: 'Local Project sk-abcdefghijklmnopqrstuvwx' },
    memoryProvenance, consent: { runId: RUN_ID, status: 'revoked' }
  };
  const reviewed = derive(state, true, 1000);
  assert.strictEqual(reviewed.title, 'Coding Workspace Run', 'the title comes from the known workflow kind, never a prompt field');
  assert(reviewed.project.includes('Local Project') && reviewed.project.includes('[凭据已隐藏]'));
  assert.strictEqual(reviewed.status, '已完成');
  assert.strictEqual(reviewed.statusKey, 'completed');
  assert.strictEqual(reviewed.lifecycle, 'Completed · 已完成');
  assert.strictEqual(reviewed.completedActionCount, 5, 'duplicate Request IDs do not inflate the completed Action count');
  assert(reviewed.memory.includes('2 条 Recall 引用') && reviewed.memory.includes('Result memory-derived=true'));
  assert.strictEqual(reviewed.result, '可用');
  assert.strictEqual(reviewed.review, '已标记审阅（当前页面）');
  assert.strictEqual(reviewed.reason, '无待处理事项。');
  const pending = derive(state, false, 1000);
  assert.strictEqual(pending.status, uiModule.deriveWorkflowStatus(state, false, 1000).label,
    'Summary overall status follows the existing workflow / Result Review projection');
  assert.strictEqual(pending.review, '待审阅');
  assert.strictEqual(pending.reason, uiModule.deriveWorkflowStatus(state, false, 1000).detail,
    'the waiting reason matches the detailed Result Review workflow status');
  const renderedProjection = JSON.stringify(reviewed);
  for (const forbidden of [
    'PROMPT_MUST_NOT_RENDER', 'PROMPT_TITLE_MUST_NOT_RENDER', 'TRACE_PROMPT_MUST_NOT_RENDER',
    'RESULT_BODY_MUST_NOT_RENDER', 'MEMORY_BODY_MUST_NOT_RENDER', 'sk-thiscredentialmustnotrender123456',
    'sk-resultcredentialmustnotrender123456', 'memoryContextHash'
  ]) assert.strictEqual(renderedProjection.includes(forbidden), false, 'summary excludes ' + forbidden);

  const failedRun = { runId: RUN_ID, workflowId: 'project.audit.readonly', projectRef: PROJECT_REF, status: 'failed' };
  const failedState = {
    run: failedRun, results: [], runEventsRunId: RUN_ID, runEventsStatus: 'ready',
    runEvents: [{ sequence: 1, eventType: 'action_trace', createdAt: 1, actionTrace: {
      runId: RUN_ID, actionId: 'ib.project.inspect.v1', requestId: 'failed-inspect',
      status: 'denied', authorityResult: 'denied', injectedFileText: 'FILE_BODY_MUST_NOT_RENDER'
    } }],
    projectSnapshot: null, memoryProvenance: { runId: RUN_ID, status: 'ready',
      consent: { status: 'revoked', memoryScope: null }, records: [], result: null }
  };
  const failed = derive(failedState, false, 1000);
  assert.strictEqual(failed.statusKey, 'failed');
  assert.strictEqual(failed.lifecycle, 'Failed · 失败');
  assert.strictEqual(failed.completedActionCount, 0);
  assert.strictEqual(failed.result, '无 Result 记录');
  assert.strictEqual(failed.review, '未进入 Review');
  assert.strictEqual(failed.reason, 'Workspace Read · Project Inspect 被 Action Registry、Consent 或 Workspace 范围校验拒绝；Trace 不记录更细的拒绝原因。');
  assert.strictEqual(JSON.stringify(failed).includes('FILE_BODY_MUST_NOT_RENDER'), false);

  const sparse = derive({ run: { runId: RUN_ID, workflowId: 'unknown.workflow', status: 'queued',
    projectRef: PROJECT_REF, taskPrompt: 'SPARSE_PROMPT_MUST_NOT_RENDER' },
  runEventsRunId: 'wr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', runEventsStatus: 'unavailable',
  memoryProvenance: { runId: 'wr_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', status: 'ready',
    consent: { status: 'active', memoryScope: { refs: [{ memoryId: 'am_wrong_run' }] } }, records: [], result: null }
  }, false, 1000);
  assert.strictEqual(sparse.title, 'Work Run');
  assert.strictEqual(sparse.completedActionCount, null);
  assert(sparse.actionDetail.includes('正在读取'));
  assert.strictEqual(sparse.memory, 'Memory Provenance 暂不可用。', 'provenance from another Run is not reused');
  assert(sparse.reason.includes('明确授权'), 'a queued Run shows the existing authorization wait reason');
  assert.strictEqual(JSON.stringify(sparse).includes('SPARSE_PROMPT_MUST_NOT_RENDER'), false);
  assert.strictEqual(derive({}, false, 1000).hasRun, false);
}

async function testResultReviewProjectionIsReadonlyAndDegradesMissingFields() {
  const artifact = {
    schemaVersion: 1,
    report: { summary: '  Review summary  ', findings: [
      { severity: 'high', title: 'Check the boundary', detail: 'The path handling needs a human check.',
        fileId: 'file_a', path: 'src/a.js', line: 12, evidence: 'must not be treated as persisted proof' },
      { severity: 'medium', title: 'Missing source reference' }
    ] }
  };
  const before = clone(artifact);
  const model = uiModule.buildResultReviewModel(artifact);
  assert.strictEqual(model.summary, 'Review summary');
  assert.strictEqual(model.findings.length, 2);
  assert.deepStrictEqual(model.findings[0], {
    index: 0, severity: 'high', title: 'Check the boundary', detail: 'The path handling needs a human check.',
    path: 'src/a.js', fileId: 'file_a', line: 12, hasSource: true, location: 'src/a.js:12'
  });
  assert.strictEqual(model.findings[1].hasSource, false);
  assert.strictEqual(model.findings[1].title, 'Missing source reference');
  assert.strictEqual(model.findings[1].detail, 'Artifact 未提供 Finding 描述。');
  assert.strictEqual(model.evidenceExcerptStored, false, 'the display model does not invent persisted evidence excerpts');
  assert.deepStrictEqual(artifact, before, 'building a Review projection never mutates the Result Artifact');

  const missing = uiModule.buildResultReviewModel({});
  assert.strictEqual(missing.hasSummary, false);
  assert.strictEqual(missing.summary, '');
  assert.strictEqual(missing.hasFindings, false);
  assert.strictEqual(missing.findings.length, 0);
  const malformed = uiModule.buildResultReviewModel({ report: { findings: [null, { line: '12' }] } });
  assert.strictEqual(malformed.findings.length, 2);
  assert(malformed.findings.every(finding => typeof finding.title === 'string' && typeof finding.detail === 'string'));
}

async function testDshSelectionUsesHomeNodeRunAndResultProjection() {
  const disabledHarness = createHarness();
  assert.deepStrictEqual(await disabledHarness.controller.setExecutor('dsh'), { ok: false, error: 'dsh-host-disabled' });
  assert.strictEqual(disabledHarness.controller.getState().executor, 'native', 'Dev DSH stays unavailable unless Home Node reports it enabled');

  const h = createHarness({ dshEnabled: true, executionEvents: [
    { sequence: 1, event: 'tool-call', toolName: 'project.read_file', fileId: 'file_a', path: 'src/a.js', at: 100 },
    { sequence: 2, event: 'project-read', toolName: 'project.read_file', fileId: 'file_a', path: 'src/a.js', code: 'ok', at: 101 }
  ] });
  const ui = h.controller;
  assert.strictEqual((await ui.setExecutor('dsh')).ok, true);
  assert.strictEqual((await ui.setProfileRef('agent_profile')).ok, true);
  assert.strictEqual((await ui.createRun(PROJECT_REF)).ok, true);
  assert.strictEqual((await ui.previewAuthorization()).ok, true);
  assert.strictEqual((await ui.setFileIds(['file_a'])).ok, true);
  assert.strictEqual(ui.confirmScope(true).ok, true);
  assert.strictEqual((await ui.confirmStorageRisk(true)).ok, true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  assert.strictEqual(ui.bindDshSession('session-11111111-1111-4111-8111-111111111111').ok, true);
  const started = await ui.start();
  assert.strictEqual(started.ok, true);
  assert.strictEqual(h.calls.starts.length, 0, 'Native is not invoked after selecting DSH');
  assert.deepStrictEqual(h.calls.dshStarts, [{ runId: RUN_ID, profileRef: 'agent_profile', consentId: CONSENT_ID,
    sessionId: 'session-11111111-1111-4111-8111-111111111111' }]);
  assert.strictEqual(ui.getState().selectedResult.result.resultId, 'wrr_12345678-1234-1234-1234-123456789012');
  assert.strictEqual(ui.getState().selectedResult.result.report.findings[0].path, 'src/a.js');
  assert.strictEqual(ui.getState().runEvents.some(event => event.executionEvent === 'project-read'
    && event.executor === 'dsh' && event.path === 'src/a.js'), true,
  'sanitized DSH tool events returned by the Home Node join the existing run trace');
  assert.strictEqual(ui.getState().executor, 'dsh');
}

async function testQueuedRunCanRebindAfterRefreshAndRevokesOldConsent() {
  const h = createHarness({ dshEnabled: true });
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.selectRun(RUN_ID);
  assert.strictEqual(ui.getState().run.status, 'queued');
  assert.strictEqual(ui.getState().executor, 'native', 'a refresh with no active DSH child stays on the Native default');
  assert.strictEqual((await ui.setExecutor('dsh')).ok, true,
    'an unstarted queued Run can be explicitly rebound to DSH after refresh');

  const consentHarness = createHarness({ dshEnabled: true });
  const consentUi = consentHarness.controller;
  await consentUi.setProfileRef('agent_profile');
  await consentUi.createRun(PROJECT_REF);
  await consentUi.previewAuthorization();
  await consentUi.setFileIds(['file_a']);
  consentUi.confirmScope(true);
  await consentUi.confirmStorageRisk(true);
  assert.strictEqual((await consentUi.grant(300000, true)).ok, true);
  assert.strictEqual((await consentUi.setExecutor('dsh')).ok, true);
  assert.strictEqual(consentHarness.calls.revokes.length, 1,
    'changing engines on a queued Run revokes its prior route consent before asking again');
  assert.strictEqual(consentUi.getState().consentId, '');
  assert.strictEqual(consentHarness.getConsent().status, 'revoked');
}

async function testConfirmAndStartKeepsPermissionChecksAndUsesOneRunAction() {
  const h = createHarness({ dshEnabled: true });
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  assert.strictEqual((await ui.setExecutor('dsh')).ok, true);
  assert.strictEqual((await ui.confirmStorageRisk(true)).ok, true);
  assert.strictEqual(ui.confirmScope(true).ok, true);
  assert.strictEqual(ui.bindDshSession('session-22222222-2222-4222-8222-222222222222').ok, true);
  const result = await ui.confirmAndStart(300000);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(h.calls.grants.length, 1, 'the confirmed action saves one Home Node Consent');
  assert.strictEqual(h.calls.dshStarts.length, 1, JSON.stringify({ result, revokes: h.calls.revokes, state: ui.getState() }));
  assert.strictEqual(h.calls.starts.length, 0, 'Native remains untouched');
  assert.strictEqual(ui.getState().selectedResult.result.report.findings[0].path, 'src/a.js');

  const deniedHarness = createHarness({ dshEnabled: true });
  const denied = deniedHarness.controller;
  await denied.setProfileRef('agent_profile');
  await denied.createRun(PROJECT_REF);
  await denied.previewAuthorization();
  await denied.setFileIds(['file_a']);
  denied.confirmScope(true);
  assert.strictEqual((await denied.setExecutor('dsh')).ok, true);
  const missingRisk = await denied.confirmAndStart(300000);
  assert.strictEqual(missingRisk.error, 'dsh-session-binding-required');
  assert.strictEqual(deniedHarness.calls.grants.length, 0, 'Result risk stays a separate required confirmation');
  assert.strictEqual(deniedHarness.calls.dshStarts.length, 0);
}

async function testConsentReadFailureDoesNotRevokeOrHideTheLedgerRecord() {
  const h = createHarness({ dshEnabled: true });
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  await ui.confirmStorageRisk(true);
  ui.confirmScope(true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  h.setConsentGetResult({ ok: false, error: 'work-run-api-unavailable' });
  const failed = await ui.start();
  assert.strictEqual(failed.error, 'consent-read-failed');
  assert.strictEqual(h.calls.revokes.length, 0, 'a failed read is not evidence that the Ledger Consent is invalid');
  assert.strictEqual(h.getConsent().status, 'active');
  assert.strictEqual(ui.getState().consentId, CONSENT_ID);
  assert.match(ui.getState().notice, /保持原样/);
  assert.strictEqual(h.calls.starts.length, 0);
}

async function testConsentValidationDistinguishesRevokedLedgerFromChangedProviderScope() {
  const revokedHarness = createHarness();
  const revokedUi = revokedHarness.controller;
  await revokedUi.setProfileRef('agent_profile');
  await revokedUi.createRun(PROJECT_REF);
  await revokedUi.previewAuthorization();
  await revokedUi.setFileIds(['file_a']);
  await revokedUi.confirmStorageRisk(true);
  revokedUi.confirmScope(true);
  await revokedUi.grant(300000, true);
  revokedHarness.setConsentGetResult({ ok: true, consent: Object.assign({}, revokedHarness.getConsent(), { status: 'revoked' }) });
  const revoked = await revokedUi.start();
  assert.strictEqual(revoked.error, 'consent-already-revoked');
  assert.strictEqual(revokedHarness.calls.revokes.length, 0, 'already-revoked Ledger state is not revoked a second time');
  assert.strictEqual(revokedUi.getState().consentId, '');
  assert.match(revokedUi.getState().notice, /重新确认/);

  const mismatchHarness = createHarness();
  const mismatchUi = mismatchHarness.controller;
  await mismatchUi.setProfileRef('agent_profile');
  await mismatchUi.createRun(PROJECT_REF);
  await mismatchUi.previewAuthorization();
  await mismatchUi.setFileIds(['file_a']);
  await mismatchUi.confirmStorageRisk(true);
  mismatchUi.confirmScope(true);
  await mismatchUi.grant(300000, true);
  const mismatched = Object.assign({}, mismatchHarness.getConsent(), {
    providerScopes: mismatchHarness.getConsent().providerScopes.map(scope => scope.destination === 'agent'
      ? Object.assign({}, scope, { model: 'changed-route' }) : scope)
  });
  mismatchHarness.setConsentGetResult({ ok: true, consent: mismatched });
  const mismatch = await mismatchUi.start();
  assert.strictEqual(mismatch.error, 'consent-provider-mismatch');
  assert.strictEqual(mismatchHarness.calls.revokes.length, 1, 'a confirmed provider scope mismatch closes the active Ledger record');
  assert.match(mismatchUi.getState().notice, /Provider 路由/);
}

async function testReadonlyMemoryRecallNeedsExactContentAndRouteConsent() {
  const h = createHarness();
  const ui = h.controller;
  const memoryId = 'am_12345678-1234-1234-1234-123456789012';
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  await ui.confirmStorageRisk(true);
  assert.strictEqual(h.calls.starts.length, 0, 'Agent Memory preview is local-only');
  assert.strictEqual((await ui.setMemorySelection([memoryId])).ok, true);
  const snapshot = ui.getState().memorySnapshot;
  assert.strictEqual(snapshot.recordCount, 1);
  assert.strictEqual(snapshot.refs[0].memoryId, memoryId);
  assert.strictEqual((await ui.confirmScope(true)).error, 'explicit-memory-consent-required',
    'file egress confirmation cannot authorize memory egress');
  assert.strictEqual(h.calls.grants.length, 0);
  assert.strictEqual((await ui.confirmMemoryScope(true)).ok, true);
  assert.strictEqual((await ui.confirmScope(true)).error, 'explicit-memory-derived-consent-required',
    'Agent Memory permission alone does not authorize derived sinks');
  assert.strictEqual((await ui.confirmMemoryDerivedConsent('review', true)).ok, true);
  assert.strictEqual((await ui.confirmScope(true)).error, 'explicit-memory-derived-consent-required',
    'Review permission alone does not authorize persistent Result storage');
  assert.strictEqual((await ui.confirmMemoryDerivedConsent('result', true)).ok, true);
  assert.strictEqual((await ui.confirmScope(true)).ok, true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  assert.strictEqual(h.calls.grants.length, 1);
  const grantedScope = h.calls.grants[0].memoryScope;
  assert.strictEqual(grantedScope.providerScope.destination, 'agent');
  assert.strictEqual(grantedScope.refs[0].revision, 1);
  assert.strictEqual(grantedScope.contextHash, snapshot.contextHash);
  assert.strictEqual(h.calls.grants[0].memoryDerivedScope.review.confirmed, true);
  assert.strictEqual(h.calls.grants[0].memoryDerivedScope.review.providerScope.destination, 'middle_brain');
  assert.strictEqual(h.calls.grants[0].memoryDerivedScope.result.confirmed, true);
  assert.strictEqual(h.calls.grants[0].memoryDerivedScope.result.storage, 'plaintext_home_node_sqlite');
  assert(!JSON.stringify(h.calls.grants[0]).includes('Use the existing parser contract.'),
    'Consent stores a content hash and record refs, never the memory body');
  assert.strictEqual(h.calls.starts.length, 0, 'saving Consent does not auto-start a provider call');
  assert.strictEqual((await ui.start()).ok, true);
  assert.strictEqual(h.calls.starts.length, 1);
}

async function testMemoryContentOrRouteChangesInvalidateConsent() {
  const h = createHarness();
  const ui = h.controller;
  const memoryId = 'am_12345678-1234-1234-1234-123456789012';
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  await ui.confirmStorageRisk(true);
  await ui.setMemorySelection([memoryId]);
  await ui.confirmMemoryScope(true);
  await ui.confirmMemoryDerivedConsent('review', true);
  await ui.confirmMemoryDerivedConsent('result', true);
  await ui.confirmScope(true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  h.setMemoryRecords([recallRecord(memoryId, PROJECT_REF, 'Changed after approval.', 2)]);
  const stale = await ui.start();
  assert.strictEqual(stale.error, 'consent-scope-changed');
  assert.strictEqual(h.calls.starts.length, 0, 'a changed revision/hash is not sent under an older authorization');
  assert.strictEqual(h.getConsent().status, 'revoked');

  const routeHarness = createHarness();
  const routeUi = routeHarness.controller;
  await routeUi.setProfileRef('agent_profile');
  await routeUi.createRun(PROJECT_REF);
  await routeUi.previewAuthorization();
  await routeUi.setMemorySelection([memoryId]);
  await routeUi.confirmMemoryScope(true);
  await routeUi.confirmMemoryDerivedConsent('review', true);
  await routeUi.confirmMemoryDerivedConsent('result', true);
  routeHarness.setRouteHash('f'.repeat(64));
  assert.strictEqual((await routeUi.previewAuthorization()).ok, true);
  assert.strictEqual(routeUi.getState().memoryConfirmed, false,
    'Provider route changes require a fresh memory-content authorization');
  assert.strictEqual(routeUi.getState().memoryDerivedReviewConfirmed, false,
    'a route change invalidates the Review sink confirmation');
  assert.strictEqual(routeHarness.calls.starts.length, 0);
}

async function testMemoryQueryFailureHasNoEgressFallback() {
  const h = createHarness();
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  h.setMemoryQueryFailure(true);
  const recall = await ui.refreshMemoryRecall(PROJECT_REF);
  assert.strictEqual(recall.error, 'agent-memory-query-failed');
  assert.strictEqual(ui.getState().memorySelectedIds.length, 0);
  assert.strictEqual(h.calls.grants.length, 0);
  assert.strictEqual(h.calls.starts.length, 0,
    'query failure leaves recall unavailable and cannot silently create a Provider egress scope');
}

async function testDerivedSinkScopesAreIndependentAndRouteBound() {
  const noRiskHarness = createHarness();
  const noRiskUi = noRiskHarness.controller;
  const noRiskMemoryId = 'am_12345678-1234-1234-1234-123456789012';
  await noRiskUi.setProfileRef('agent_profile');
  await noRiskUi.createRun(PROJECT_REF);
  await noRiskUi.previewAuthorization();
  await noRiskUi.setMemorySelection([noRiskMemoryId]);
  await noRiskUi.confirmMemoryScope(true);
  assert.strictEqual((await noRiskUi.confirmMemoryDerivedConsent('review', true)).ok, true);
  assert.strictEqual((await noRiskUi.confirmMemoryDerivedConsent('result', true)).error,
    'storage-risk-acceptance-required', 'memory-derived plaintext persistence is never pre-accepted');
  assert.strictEqual(noRiskUi.getState().memoryDerivedResultConfirmed, false);

  const h = createHarness();
  const ui = h.controller;
  const memoryId = 'am_12345678-1234-1234-1234-123456789012';
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  await ui.confirmStorageRisk(true);
  await ui.setMemorySelection([memoryId]);
  await ui.confirmMemoryScope(true);
  await ui.confirmMemoryDerivedConsent('review', true);
  assert.strictEqual(ui.getState().memoryDerivedResultConfirmed, false,
    'Review authorization does not imply persistent Result authorization');
  await ui.confirmMemoryDerivedConsent('result', true);
  await ui.confirmScope(true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  assert.strictEqual(h.getConsent().memoryDerivedScope.review.providerScope.routeHash, 'b'.repeat(64));

  h.setMiddleRouteHash('c'.repeat(64));
  assert.strictEqual((await ui.previewAuthorization()).ok, true);
  assert.strictEqual(h.getConsent().status, 'revoked', 'Review route change revokes the entire prior Ledger consent');
  assert.strictEqual(ui.getState().memoryDerivedReviewConfirmed, false,
    'the Review confirmation is bound to the exact route');
  assert.strictEqual(ui.getState().memoryDerivedResultConfirmed, false,
    'the derived Result grant is also invalidated when its authorized Review route changes');
  assert.strictEqual(h.calls.starts.length, 0);
}

async function testScopeChangesRevokeAndFailClosed() {
  const h = createHarness();
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  ui.confirmScope(true);
  await ui.confirmStorageRisk(true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  assert.strictEqual((await ui.setFileIds(['file_b'])).ok, true);
  assert.strictEqual(h.calls.revokes.length, 1, 'a changed file selection revokes the existing consent');
  assert.strictEqual(ui.getState().consentId, '');
  assert.strictEqual(ui.getState().consentRevoked, true, 'revoked consent remains distinguishable from consent never loaded');
  assert.strictEqual((await ui.start()).error, 'consent-required');

  await ui.setFileIds(['file_a']);
  ui.confirmScope(true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  assert.strictEqual(ui.getState().consentRevoked, false, 'a fresh grant clears the prior revoked marker');
  h.setRouteHash('c'.repeat(64));
  const started = await ui.start();
  assert.notStrictEqual(started.ok, true, 'a Provider route change prevents start');
  assert.strictEqual(h.calls.starts.length, 0, 'changed Provider scope never reaches the Agent loop');
  assert(h.calls.revokes.length >= 2, 'the stale Provider consent is revoked');
}

async function testRefreshDoesNotResumeAndExplicitResultDeletion() {
  const h = createHarness();
  const ui = h.controller;
  await ui.refresh();
  assert.strictEqual(h.calls.recovers, 1, 'refresh asks the runtime to close abandoned Runs');
  assert.strictEqual(ui.getState().activeRuns.length, 1);
  assert.strictEqual(ui.getState().results.length, 1, 'Result list is rehydrated from Home Node metadata');
  assert.strictEqual(h.calls.starts.length, 0, 'refresh never resumes an Agent loop');
  assert.strictEqual((await ui.start()).error, 'consent-required');
  assert.strictEqual((await ui.deleteResult(RUN_ID, false)).error, 'explicit-delete-confirmation-required');
  assert.strictEqual(h.calls.resultDeletes, 0);
  assert.strictEqual((await ui.selectResult(RUN_ID)).ok, true);
  assert.strictEqual(h.calls.resultReads, 1);
  assert.strictEqual((await ui.deleteResult(RUN_ID, true)).ok, true);
  assert.strictEqual(h.calls.resultDeletes, 1);
  assert.strictEqual(h.calls.recovers, 1, 'manual ledger refresh does not reclassify a Run created in this UI session as interrupted');
}

async function testSelectionAndCancellation() {
  const h = createHarness();
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  ui.confirmScope(true);
  await ui.confirmStorageRisk(true);
  await ui.grant(300000, true);
  await ui.setProfileRef('different_profile');
  assert.strictEqual(h.calls.revokes.length, 1, 'a Provider profile switch revokes the previous consent');
  assert.strictEqual(ui.getState().consentId, '');
  assert.strictEqual(ui.getState().consentRevoked, true, 'the UI retains why Start is unavailable after a profile-bound revocation');
  assert.strictEqual((await ui.cancel()).ok, true);
  assert.strictEqual(h.calls.cancellations, 1);
}

async function testDevConsentRevokeTraceCapturesOrigin() {
  const h = createHarness();
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  await ui.confirmStorageRisk(true);
  await ui.confirmScope(true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);

  const restore = (name, descriptor) => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  };
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalTrace = Object.getOwnPropertyDescriptor(globalThis, '__workModeConsentRevocationTrace');
  const originalWarn = console.warn;
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { hostname: '127.0.0.1', port: '23130' } });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { activeElement: { id: 'wm-profile-select' } } });
  Object.defineProperty(globalThis, '__workModeConsentRevocationTrace', { configurable: true, writable: true, value: [] });
  console.warn = function () {};
  try {
    await ui.setProfileRef('different_profile');
    const trace = globalThis.__workModeConsentRevocationTrace[0];
    assert(trace, 'Dev revoke requests are recorded in the page-local trace');
    assert.strictEqual(trace.operation, 'work-consent.revoke');
    assert.strictEqual(trace.runId, RUN_ID);
    assert.strictEqual(trace.consentId, CONSENT_ID);
    assert(Number.isFinite(Date.parse(trace.at)), 'the trace records an ISO timestamp');
    assert.strictEqual(trace.activeElementId, 'wm-profile-select', 'the UI event target is recorded');
    assert(trace.callStack.join('\n').includes('setProfileRef'), 'the initiating controller function is recorded');
  } finally {
    console.warn = originalWarn;
    restore('location', originalLocation);
    restore('document', originalDocument);
    restore('__workModeConsentRevocationTrace', originalTrace);
  }
}

async function testProjectSwitchClearsOldScopeAndRunUsesSelectedProjectRef() {
  const h = createHarness();
  const ui = h.controller;
  h.setProjects([{ id: PROJECT_REF }, { id: 'project_ui_next' }]);
  assert.strictEqual((await ui.setSelectedProject(PROJECT_REF)).ok, true);
  await ui.setProfileRef('agent_profile');
  assert.strictEqual((await ui.createRun()).ok, true);
  assert.strictEqual(h.calls.runCreates[0].projectRef, PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  assert.strictEqual((await ui.setSelectedProject('project_ui_next')).error, 'active-run-must-be-closed',
    'an active Run cannot switch its authorized project');
  assert.strictEqual(ui.getState().selectedProjectRef, PROJECT_REF);
  assert.strictEqual((await ui.cancel()).ok, true);
  assert.strictEqual((await ui.setSelectedProject('project_ui_next')).ok, true);
  const switched = ui.getState();
  assert.strictEqual(switched.selectedProjectRef, 'project_ui_next');
  assert.strictEqual(switched.preview, null, 'a project switch clears the old file preview');
  assert.deepStrictEqual(switched.fileIds, [], 'a project switch clears selected file IDs');
  assert.strictEqual(switched.confirmedKey, '', 'a project switch clears prior authorization confirmation');
  assert.strictEqual(switched.storageRiskAccepted, false, 'a project switch requires fresh risk review');
  assert.strictEqual((await ui.createRun()).ok, true);
  assert.strictEqual(h.calls.runCreates[1].projectRef, 'project_ui_next',
    'the new Home Node Run is bound to the selected Workspace project');
}

async function testWorkspaceFilePreviewSelectionAndRunBinding() {
  const h = createHarness();
  const ui = h.controller;
  h.setProjects([{ id: PROJECT_REF, name: '真实本地项目' }]);
  assert.strictEqual((await ui.setSelectedProject(PROJECT_REF)).ok, true);
  const project = ui.getState();
  assert.strictEqual(project.projectSnapshot.projectRef, PROJECT_REF);
  assert.strictEqual(project.projectSnapshot.projectPath, '', 'the UI preserves missing root-path metadata');
  assert.deepStrictEqual(project.projectSnapshot.files.map(file => file.fileId), ['file_a', 'file_b']);
  assert.deepStrictEqual(project.fileIds, [], 'Workspace files preview locally with no default authorization selection');
  assert.strictEqual((await ui.setFileIds(['file_b'])).ok, true);
  assert.deepStrictEqual(h.getDraft(), { version: 1, projectRef: PROJECT_REF, fileIds: ['file_b'] });
  const created = await ui.createRun(PROJECT_REF);
  assert.strictEqual(created.ok, true);
  assert.strictEqual(h.calls.runCreates[0].projectRef, PROJECT_REF);
  assert.deepStrictEqual(ui.getState().fileIds, ['file_b'], 'pre-Run file range is carried into the queued authorization preview');
  assert.strictEqual(ui.getState().consentId, '', 'Run creation does not grant Consent Ledger authority');
  assert.strictEqual((await ui.setProfileRef('agent_profile')).ok, true);
  const preview = await ui.previewAuthorization();
  assert.strictEqual(preview.ok, true);
  assert.deepStrictEqual(preview.files.map(file => file.fileId), ['file_a', 'file_b']);
  assert.match(preview.providers.find(provider => provider.destination === 'agent').routeHash, /^[a-f0-9]{64}$/);
  assert.deepStrictEqual(ui.getState().fileIds, ['file_b']);
  assert.strictEqual(h.calls.starts.length, 0, 'authorization preparation never calls a Provider or starts a Run');
}

async function testEmptyWorkspaceCreatesProjectOnlyFromExplicitFiles() {
  const h = createHarness({ requireFileSelection: true });
  h.setProjects([]);
  const ui = h.controller;
  const selected = [{ name: 'onboarding.js', size: 42,
    webkitRelativePath: 'P3.1 Local Sample/src/onboarding.js', text: async () => 'export const ok = true;' }];
  const imported = await ui.importProjectFiles(selected);
  assert.strictEqual(imported.ok, true);
  assert.strictEqual(imported.projectRef, 'project_ui_created');
  const project = ui.getState();
  assert.strictEqual(project.selectedProjectRef, imported.projectRef);
  assert.strictEqual(project.projectSnapshot.projectName, 'P3.1 Local Sample');
  assert.strictEqual(project.projectSnapshot.projectPath, '', 'a selected browser folder does not invent an absolute root path');
  assert.strictEqual(project.projectSnapshot.files[0].path, 'P3.1 Local Sample/src/onboarding.js');
  assert.deepStrictEqual(project.fileIds, [], 'files from a newly created project remain unselected until the user chooses scope');
  assert.strictEqual(project.consentId, '');
  await ui.setFileIds(['file_imported_0']);
  const run = await ui.createRun();
  assert.strictEqual(run.ok, true);
  assert.strictEqual(h.calls.runCreates[0].projectRef, imported.projectRef);
  assert.deepStrictEqual(ui.getState().fileIds, ['file_imported_0']);
  assert.strictEqual(ui.getState().consentId, '');

  const failed = createHarness({ requireFileSelection: true });
  failed.setProjects([]);
  failed.setImportFailure({ ok: false, error: 'no-eligible-files', imported: [] });
  const failedImport = await failed.controller.importProjectFiles(selected);
  assert.strictEqual(failedImport.error, 'no-eligible-files');
  assert.deepStrictEqual(failed.controller.getState().selectedProjectRef, '',
    'a failed explicit import does not leave an empty temporary Workspace project selected');
  assert.deepStrictEqual(failed.getDraft(), null);
}

async function testRefreshRestoresOnlyValidProjectAndFileDraft() {
  const first = createHarness();
  first.setProjects([{ id: PROJECT_REF }]);
  await first.controller.setSelectedProject(PROJECT_REF);
  await first.controller.setFileIds(['file_a']);
  const saved = first.getDraft();
  const second = createHarness();
  second.setProjects([{ id: PROJECT_REF }]);
  second.setDraft(saved);
  const restored = await second.controller.restoreProjectDraft();
  assert.strictEqual(restored.ok, true);
  assert.strictEqual(second.controller.getState().selectedProjectRef, PROJECT_REF);
  assert.deepStrictEqual(second.controller.getState().fileIds, ['file_a']);
  assert.strictEqual(second.controller.getState().preview, null);
  assert.strictEqual(second.controller.getState().consentId, '');
  assert.strictEqual(second.controller.getState().storageRiskAccepted, false);
  second.setWorkspaceFiles(PROJECT_REF, [{ fileId: 'file_new', path: 'src/new.js', size: 10, contentHash: 'd'.repeat(64) }]);
  await second.controller.refreshProjectSnapshot(PROJECT_REF);
  assert.deepStrictEqual(second.controller.getState().fileIds, [], 'a draft file ID removed from Workspace is not restored');

  const denied = createHarness();
  denied.setDraft(saved);
  denied.setProjects([]);
  const access = await denied.controller.restoreProjectDraft();
  assert.strictEqual(access.error, 'project-access-denied');
  assert.strictEqual(denied.getDraft(), null, 'a removed project clears its stale local draft');
}

async function testWorkspaceFileMutationRevokesOldConsent() {
  const h = createHarness();
  const ui = h.controller;
  h.setProjects([{ id: PROJECT_REF }]);
  await ui.setSelectedProject(PROJECT_REF);
  await ui.setFileIds(['file_a']);
  await ui.createRun(PROJECT_REF);
  await ui.setProfileRef('agent_profile');
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  ui.confirmScope(true);
  await ui.confirmStorageRisk(true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  const before = ui.getState();
  assert(before.consentId);
  h.setWorkspaceFiles(PROJECT_REF, [
    { fileId: 'file_a', path: 'src/a.js', size: 120, contentHash: 'e'.repeat(64) },
    { fileId: 'file_b', path: 'tests/a.test.js', size: 80, contentHash: 'b'.repeat(64) }
  ]);
  const refreshed = await ui.refreshProjectSnapshot(PROJECT_REF);
  assert.strictEqual(refreshed.ok, true);
  assert.strictEqual(ui.getState().consentId, '');
  assert.strictEqual(h.calls.revokes.length, 1, 'a same-ID, same-size content mutation revokes the previous grant');
  assert.strictEqual(ui.getState().preview, null);
  assert.strictEqual(ui.getState().confirmedKey, '');
}

async function testRunCreationFailsClosedWhenWorkspaceAccessIsMissing() {
  const missing = createHarness();
  missing.setProjects([]);
  assert.strictEqual((await missing.controller.createRun(PROJECT_REF)).error, 'project-access-denied');
  assert.strictEqual(missing.calls.runCreates.length, 0, 'an inaccessible project never creates a Home Node Run');

  const unavailable = createHarness();
  unavailable.setWorkspaceFailure(true);
  assert.strictEqual((await unavailable.controller.createRun(PROJECT_REF)).error, 'workspace-unavailable');
  assert.strictEqual(unavailable.calls.runCreates.length, 0, 'a Workspace read failure cannot fall back to an unscoped Run');
}

async function testAtRestAcknowledgementWithdrawalRevokes() {
  const h = createHarness();
  const ui = h.controller;
  await ui.setProfileRef('agent_profile');
  await ui.createRun(PROJECT_REF);
  await ui.previewAuthorization();
  await ui.setFileIds(['file_a']);
  ui.confirmScope(true);
  await ui.confirmStorageRisk(true);
  assert.strictEqual((await ui.grant(300000, true)).ok, true);
  assert.strictEqual((await ui.confirmStorageRisk(false)).ok, false);
  assert.strictEqual(h.calls.revokes.length, 1);
  assert.strictEqual(ui.getState().consentId, '');
  assert.notStrictEqual((await ui.start()).ok, true);
  assert.strictEqual(h.calls.starts.length, 0);
}

async function testWorkResultMemoryCandidateReviewAndRevoke() {
  const h = createHarness();
  const ui = h.controller;
  h.setRunStatus('completed');
  assert.strictEqual((await ui.selectResult(RUN_ID)).ok, true);
  h.setProjects([]);
  assert.strictEqual((await ui.previewMemoryCandidate('finding:0')).error, 'project-access-denied',
    'candidate creation requires the Result project to remain in the local Workspace');
  assert.strictEqual(h.calls.memoryCommits.length, 0);
  h.setProjects([{ id: PROJECT_REF }]);

  const preview = await ui.previewMemoryCandidate('finding:0');
  assert.strictEqual(preview.ok, true);
  const candidate = preview.candidate;
  assert.strictEqual(candidate.type, 'Observation');
  assert.strictEqual(candidate.projectRef, PROJECT_REF);
  assert.strictEqual(candidate.basedOn.resultId, 'wrr_12345678-1234-1234-1234-123456789012');
  assert.strictEqual(candidate.provenance.sourceKind, 'work_result_ref');
  assert.strictEqual(candidate.provenance.selectionRef, 'finding:0');
  assert(candidate.payload.statement.includes('A single finding'));
  assert(!candidate.payload.statement.includes('Only the selected report content'),
    'one selected finding, not the whole report, becomes the candidate');
  assert.strictEqual((await ui.commitMemoryCandidate(true)).error, 'explicit-memory-candidate-confirmation-required');
  assert.strictEqual(h.calls.memoryCommits.length, 0);
  ui.confirmMemoryCandidate(true);
  h.setProjects([]);
  assert.strictEqual((await ui.commitMemoryCandidate(true)).error, 'project-access-denied',
    'project membership is rechecked at the moment of write');
  assert.strictEqual(h.calls.memoryCommits.length, 0);
  h.setProjects([{ id: PROJECT_REF }]);
  await ui.previewMemoryCandidate('finding:0');
  ui.confirmMemoryCandidate(true);
  const gate = deferred();
  h.setMemoryCommitGate(gate);
  const first = ui.commitMemoryCandidate(true);
  const second = ui.commitMemoryCandidate(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(h.calls.memoryCommits.length, 1, 'repeated submits share one in-flight commit');
  h.releaseMemoryCommit();
  const results = await Promise.all([first, second]);
  assert(results.every(result => result.ok));
  const record = results[0].record;
  assert.strictEqual(record.type, 'Observation');
  assert.strictEqual(record.projectRef, PROJECT_REF);
  assert.strictEqual(record.provenance[0].sourceRef, candidate.basedOn.resultId);

  const afterCommit = await ui.previewMemoryCandidate('finding:0');
  assert.strictEqual(afterCommit.candidate.committedRecord.memoryId, record.memoryId,
    'refreshing an identical selection discovers the existing idempotent record');
  assert.strictEqual(h.calls.memoryCommits.length, 1);
  assert.strictEqual((await ui.retractMemoryRecord(record, false)).error, 'explicit-memory-retraction-required');
  assert.strictEqual(h.calls.memoryRetractions.length, 0);
  const revoked = await ui.retractMemoryRecord(record, true);
  assert.strictEqual(revoked.ok, true);
  assert.strictEqual(h.calls.memoryRetractions[0].input.confirmed, true,
    'retraction is submitted with the separate user confirmation marker');
  assert.strictEqual(revoked.record.status, 'retracted');
  assert.strictEqual(revoked.record.payload, null, 'undo clears the payload and leaves the Authority tombstone');
}

async function testWorkResultProcedureCandidateNeedsPreviewAndConfirmation() {
  const h = createHarness();
  const ui = h.controller;
  h.setRunStatus('completed');
  assert.strictEqual((await ui.selectResult(RUN_ID)).ok, true);
  h.setProjects([]);
  assert.strictEqual((await ui.beginProcedureCandidate()).error, 'project-access-denied');
  assert.strictEqual(h.calls.procedureMemoryCommits.length, 0);
  h.setProjects([{ id: PROJECT_REF }]);

  const begun = await ui.beginProcedureCandidate();
  assert.strictEqual(begun.ok, true);
  assert.strictEqual(begun.candidate.type, 'Procedure');
  assert.strictEqual(begun.candidate.basedOn.runId, RUN_ID);
  assert.strictEqual(begun.candidate.basedOn.resultId, 'wrr_12345678-1234-1234-1234-123456789012');
  assert.strictEqual(begun.candidate.procedureReviewed, false);
  assert.strictEqual(ui.discardProcedureCandidate().ok, true);
  assert.strictEqual(ui.getState().memoryCandidate, null, 'discarding a draft leaves no durable candidate');
  assert.strictEqual(h.calls.procedureMemoryCommits.length, 0);
  await ui.beginProcedureCandidate();
  assert.strictEqual((await ui.commitMemoryCandidate(true)).error, 'explicit-memory-candidate-confirmation-required');
  assert.strictEqual(h.calls.procedureMemoryCommits.length, 0, 'drafting a Procedure never writes it');

  assert.strictEqual((await ui.previewProcedureCandidate({ name: 'Incomplete', steps: ['One step.'], whenToUse: '' })).error,
    'invalid-procedure-candidate', 'all three Procedure fields must be reviewed');
  assert.strictEqual(h.calls.procedureMemoryCommits.length, 0);

  const preview = await ui.previewProcedureCandidate({
    name: 'Review a bounded project change',
    steps: ['Inspect the selected diff.', 'Run the focused regression.'],
    whenToUse: 'Before accepting a small code change.'
  });
  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.candidate.procedureReviewed, true);
  assert.strictEqual(ui.getState().memoryCandidateConfirmed, false,
    'previewing a Procedure does not imply confirmation');
  ui.confirmMemoryCandidate(true);
  h.setProjects([]);
  assert.strictEqual((await ui.commitMemoryCandidate(true)).error, 'project-access-denied',
    'Workspace membership is checked again at commit time');
  assert.strictEqual(h.calls.procedureMemoryCommits.length, 0);
  h.setProjects([{ id: PROJECT_REF }]);
  ui.confirmMemoryCandidate(true);
  const saved = await ui.commitMemoryCandidate(true);
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.record.type, 'Procedure');
  assert.strictEqual(saved.record.payload.name, 'Review a bounded project change');
  assert.strictEqual(saved.record.provenance[0].sourceRunId, RUN_ID);
  assert.strictEqual(saved.record.provenance[0].sourceRef, preview.candidate.basedOn.resultId);
  assert.strictEqual(h.calls.procedureMemoryCommits.length, 1,
    'only the separately confirmed candidate reaches the Agent Memory write surface');
}

async function testCandidateCasConflictAndSensitiveRejection() {
  const h = createHarness();
  const ui = h.controller;
  h.setRunStatus('completed');
  await ui.selectResult(RUN_ID);
  await ui.previewMemoryCandidate('finding:0');
  ui.confirmMemoryCandidate(true);
  h.setMemoryRevision(1);
  const conflict = await ui.commitMemoryCandidate(true);
  assert.strictEqual(conflict.error, 'version-conflict');
  assert.strictEqual(h.calls.memoryCommits.length, 1);
  assert.strictEqual(ui.getState().memoryCandidateConfirmed, false,
    'CAS conflicts require a fresh preview and another explicit confirmation');

  h.setMemoryRevision(0);
  h.setReport({ schemaVersion: 1, summary: 'Safe alternate summary.', findings: [
    { severity: 'high', title: 'Sensitive candidate', detail: 'sk-agent-memory-secret-sentinel-123456789', path: 'src/a.js', line: 1 }
  ] });
  await ui.selectResult(RUN_ID);
  await ui.previewMemoryCandidate('finding:0');
  ui.confirmMemoryCandidate(true);
  h.setMemoryCommitError('invalid-record');
  const rejected = await ui.commitMemoryCandidate(true);
  assert.strictEqual(rejected.error, 'invalid-record');
  assert.strictEqual(ui.getState().memoryCandidate.committedRecord, null,
    'sensitive candidate rejection never becomes a local success projection');
}

async function testNoSecretsOrImplicitStorageContract() {
  const source = fs.readFileSync(path.join(ROOT, 'assets/js/work-mode-consent-ui.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
  assert(!/localStorage|sessionStorage|indexedDB/.test(source), 'consent and result indexes are never mirrored in browser storage');
  assert(!/innerHTML\s*=/.test(source), 'provider labels and report content render as text, never HTML');
  assert(/id="wm-consent-check" type="checkbox"/.test(page));
  assert(/id="wm-storage-check" type="checkbox"/.test(page));
  assert(/id="wm-start-run"[^>]*disabled/.test(page));
  assert(!/id="wm-grant-consent"/.test(page), 'Consent and Start use one task action after both explicit checks');
  assert(/id="wm-permission-summary"/.test(page) && /id="wm-permission-providers"/.test(page)
    && /id="wm-permission-files"/.test(page) && /id="wm-permission-result"/.test(page),
    'the confirmation view summarizes executor, provider routes, file scope, and Result storage');
  assert(/id="wm-results"/.test(page) && /id="wm-result-view"/.test(page));
  assert(/id="wm-workflow-status" data-state="not-started"/.test(page)
    && /id="wm-open-result"/.test(page) && /id="wm-export-status"/.test(page),
    'the Work canvas exposes explicit lifecycle status, Result review entry, and export feedback');
  assert(/assets\/js\/work-mode-consent-ui\.js\?v=[^"']*review=result-review-v1/.test(page),
    'the updated Work Mode UI and styles receive a cache refresh');
  assert(/id="wm-memory-candidate-confirm" type="checkbox"/.test(page));
  assert(/id="wm-memory-candidate-write"[^>]*disabled/.test(page));
  assert(/id="wm-memory-records"/.test(page) && /id="wm-memory-consent-check" type="checkbox"/.test(page));
  assert(/'workspace-changed':/.test(source) && /'workspace-changed-snapshot':/.test(source),
    'the Work UI presents both canonical and legacy Workspace change outcomes safely');
  assert(/id="wm-runtime-diagnostics"/.test(page) && /id="wm-diagnostics-current"/.test(page)
    && /id="wm-diagnostics-completed"/.test(page) && /id="wm-diagnostics-failure"/.test(page)
    && /id="wm-diagnostics-authority"/.test(page) && /id="wm-diagnostics-hint"/.test(page)
    && /renderRuntimeDiagnostics\(state\)/.test(source) && /deriveRuntimeDiagnostics: deriveRuntimeDiagnostics/.test(source),
    'the Work canvas renders the read-only Runtime Diagnostics projection');
  assert(/id="wm-run-summary"/.test(page) && /id="wm-summary-title"/.test(page)
    && /id="wm-summary-status"/.test(page) && /id="wm-summary-lifecycle"/.test(page)
    && /id="wm-summary-actions"/.test(page) && /id="wm-summary-memory"/.test(page)
    && /id="wm-summary-result"/.test(page) && /id="wm-summary-review"/.test(page)
    && /id="wm-summary-reason"/.test(page) && /renderWorkRunSummary\(state\)/.test(source)
    && /deriveWorkRunSummary: deriveWorkRunSummary/.test(source),
    'the Work canvas renders the read-only Run Summary fields');
  assert(/id="wm-memory-provenance"/.test(page) && /id="wm-memory-provenance-records"/.test(page)
    && /renderMemoryProvenance\(state\)/.test(source),
    'the Work Run has a dedicated read-only Memory provenance projection');
  assert(/没有读取或展示 Memory 正文/.test(source) && /SHA-256/.test(source)
    && /memory-derived=true/.test(source),
    'Memory provenance limits output to authorized references, hashes, and existing Result markers');
  assert(/class="wm-workspace-grid"/.test(page) && /id="wm-run-events"/.test(page));
  assert(/id="wm-project-nav"/.test(page) && /id="wm-inspector-details"/.test(page));
  assert(/id="wm-derived-review-check" type="checkbox"/.test(page));
  assert(/id="wm-derived-result-check" type="checkbox"/.test(page));
  assert(/id="wm-consent-state"/.test(page));
  assert(/id="wm-auth-provider-state" data-state="pending"/.test(page)
    && /providerAuthState\.setAttribute\('data-state', routeCount \? 'ready' : 'pending'\)/
      .test(fs.readFileSync(path.join(ROOT, 'assets/js/work-mode-consent-ui.js'), 'utf8')),
    'the queued view marks Provider routing pending until a real authorization preview succeeds');
  assert(/id="wm-file-picker"/.test(page) && /id="wm-folder-picker"[^>]*webkitdirectory/.test(page));
  assert(/assets\/js\/work-mode-project-draft\.js/.test(page) && /id="wm-project-file-status"/.test(page));
  const workCss = fs.readFileSync(path.join(ROOT, 'assets/css/work-mode.css'), 'utf8');
  const workUi = fs.readFileSync(path.join(ROOT, 'assets/js/work-mode-consent-ui.js'), 'utf8');
  assert(/id="wm-execution-stages"/.test(page) && /id="wm-execution-stage-list"/.test(page)
    && /Planning/.test(workUi) && /Workspace Read/.test(workUi) && /Result Generation/.test(workUi),
    'the Work canvas presents the five existing-event execution stages');
  assert(/Result 摘要/.test(workUi) && /Evidence \/ 来源/.test(workUi)
    && /需要用户确认的项目/.test(workUi) && /buildResultReviewModel/.test(workUi),
    'the read-only Result Review presents summary, source references, and manual confirmation items');
  assert(/assets\/css\/work-mode\.css\?v=work-mode-result-review-v1/.test(page),
    'the Result Review and execution stage styles receive a cache refresh');
  assert(/runtimeDiagnostics=v1/.test(page) && /\.wm-runtime-diagnostics-grid/.test(workCss)
    && /var\(--status-danger\)/.test(workCss),
    'Runtime Diagnostics uses the Work Mode cache refresh and semantic status tokens');
  assert(/workRunSummary=v1/.test(page) && /\.wm-run-summary-grid/.test(workCss)
    && /var\(--content-primary\)/.test(workCss),
    'Run Summary uses the Work Mode cache refresh and semantic surface tokens');
  assert(/标记审阅完成/.test(workUi) && /导出 Markdown/.test(workUi)
    && /formatResultMarkdown/.test(workUi), 'the selected Work Result can be reviewed and exported locally');
  assert(/id="wm-empty-state"/.test(page) && /id="wm-authorization-state"/.test(page)
    && /id="wm-running-state"/.test(page), 'the workspace has explicit empty, authorization, and running projections');
  assert(/id="wm-inspector-toggle"/.test(page) && /id="wm-inspector-details" class="wm-inspector-details"/.test(page),
    'route, file, memory, and consent details stay in the on-demand Inspector');
  assert(/id="wm-inspector-details" class="wm-inspector-details">/.test(page)
    && /id="wm-inspector-toggle" aria-controls="wm-inspector-details" aria-expanded="false"/.test(page),
    'the Inspector is closed by default and has an explicit accessible toggle');
  /* B.1：原断言要求 footer 出现在 content 之前，但它的契约描述是
     "Run controls remain pinned outside the scrollable Inspector content"——
     源码顺序属于实现细节。迁移后按「视觉顺序 = DOM 顺序」把 content 放回
     footer 之前（不再靠 flex order 让两者不一致），断言改为校验真实契约：
     两个区块都存在、footer 在 content 之后、且内容区独立滚动（下一条）。 */
  assert(/<div class="wm-inspector-footer">\s*<div class="wm-consent-actions">/.test(page),
    'the Inspector keeps a footer block holding the Run consent actions');
  assert(/<div class="wm-inspector-content">[\s\S]*<div class="wm-inspector-footer">/.test(page),
    'Run controls render after, and stay outside, the scrollable Inspector content');
  assert(/\.wm-inspector-content\s*\{[^}]*overflow:\s*auto;/.test(workCss),
    'Inspector disclosure content is independently scrollable');
  assert(/return run\.status === 'queued' \? 'authorization' : 'running'/.test(workUi)
    && /state\.selectedResult \|\| run && \['completed', 'failed', 'cancelled'\]/.test(workUi),
    'the view state is projected from persisted Run and Result state');
  assert(/id="wm-memory-consent-check" type="checkbox"/.test(page)
    && /id="wm-derived-review-check" type="checkbox"/.test(page)
    && /id="wm-derived-result-check" type="checkbox"/.test(page)
    && /id="wm-storage-check" type="checkbox"/.test(page)
    && /id="wm-consent-check" type="checkbox"/.test(page),
    'all Ledger v4 confirmations remain separate checkbox controls');
  assert(/beginProcedureCandidate/.test(workUi) && /procedureReviewed/.test(workUi)
    && /commitWorkResultProcedureCandidate/.test(workUi),
    'Procedure Candidate is a reviewed Work Result flow that writes only through the dedicated Home Node authority');
  assert(/Source Result/.test(workUi) && /Source Run/.test(workUi),
    'Procedure previews display their source Run and Result references');
  assert(/Procedure name/.test(workUi) && /Steps · 每行一步/.test(workUi) && /When to use/.test(workUi)
    && /id="wm-memory-candidate-confirm-text"/.test(page),
    'the UI exposes the required editable Procedure fields and a separate confirmation control');
  assert(!/agentMemory\.create\s*\(/.test(workUi),
    'the Work Mode UI cannot bypass the source-bound Procedure Candidate commit path');
  assert(/body\.wm-work-mode-active #page-overlay/.test(workCss),
    'the dedicated Work surface is not dimmed by the legacy subpage scrim');
  assert(page.indexOf('assets/js/work-mode-memory-recall.js') < page.indexOf('assets/js/work-mode-runtime.js'),
    'the isolated Recall contract loads before the Work Agent Runtime');
}

(async function main() {
  await testRunTraceReadsOnlyHomeNodeEvents();
  await testActionTraceProjectionIsReadonlyAndMetadataOnly();
  await testWorkspaceChangeTraceSupportsCanonicalAndLegacyCodes();
  await testMemoryProvenanceProjectionIsExactAndMetadataOnly();
  await testWorkflowStatusAndResultExportProjection();
  await testExecutionStageProjectionUsesOnlyRunEvents();
  await testRuntimeDiagnosticsProjectExistingEvidenceOnly();
  await testWorkRunSummaryAggregatesExistingDataAndReviewState();
  await testResultReviewProjectionIsReadonlyAndDegradesMissingFields();
  await testDshSelectionUsesHomeNodeRunAndResultProjection();
  await testQueuedRunCanRebindAfterRefreshAndRevokesOldConsent();
  await testConfirmAndStartKeepsPermissionChecksAndUsesOneRunAction();
  await testConsentReadFailureDoesNotRevokeOrHideTheLedgerRecord();
  await testConsentValidationDistinguishesRevokedLedgerFromChangedProviderScope();
  await testExplicitConsentAndDuplicateSubmit();
  await testReadonlyMemoryRecallNeedsExactContentAndRouteConsent();
  await testMemoryContentOrRouteChangesInvalidateConsent();
  await testMemoryQueryFailureHasNoEgressFallback();
  await testDerivedSinkScopesAreIndependentAndRouteBound();
  await testScopeChangesRevokeAndFailClosed();
  await testRefreshDoesNotResumeAndExplicitResultDeletion();
  await testSelectionAndCancellation();
  await testProjectSwitchClearsOldScopeAndRunUsesSelectedProjectRef();
  await testWorkspaceFilePreviewSelectionAndRunBinding();
  await testEmptyWorkspaceCreatesProjectOnlyFromExplicitFiles();
  await testRefreshRestoresOnlyValidProjectAndFileDraft();
  await testWorkspaceFileMutationRevokesOldConsent();
  await testDevConsentRevokeTraceCapturesOrigin();
  await testRunCreationFailsClosedWhenWorkspaceAccessIsMissing();
  await testAtRestAcknowledgementWithdrawalRevokes();
  await testWorkResultMemoryCandidateReviewAndRevoke();
  await testWorkResultProcedureCandidateNeedsPreviewAndConfirmation();
  await testCandidateCasConflictAndSensitiveRejection();
  await testNoSecretsOrImplicitStorageContract();
  console.log('Work Mode consent UI contract passed (explicit egress and memory consent, scoped candidate preview/write/retract, CAS, duplicate submit, refresh).');
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
