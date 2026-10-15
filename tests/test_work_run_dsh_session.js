'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createWorkRunStore = require('../services/home-node/work-run-store.js');
const routeCore = require('../assets/js/work-mode-provider-route.js');
const consentCore = require('../assets/js/work-mode-consent-core.js');
const executorCore = require('../assets/js/work-mode-executor.js');

test('one DSH Session retains sequential Home Node Run bindings and restores history', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsh-session-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let store = createWorkRunStore({ dataDir: root, logger: () => {} });
  store.open();
  assert.equal(store.describe().schemaVersion, 9);
  const route = routeCore.normalize({ id: 'synthetic-provider', provider: 'openai', model: 'synthetic', endpoint: 'http://127.0.0.1:23139/v1/chat/completions' });
  const agent = consentCore.providerScope('agent', route.providerRef, route, crypto.webcrypto);
  const middleRoute = routeCore.normalize({ id: 'synthetic-middle', provider: 'openai', model: 'synthetic-middle', endpoint: 'http://127.0.0.1:23139/v1/chat/completions' });
  return Promise.all([
    agent,
    consentCore.providerScope('middle_brain', middleRoute.providerRef, middleRoute, crypto.webcrypto)
  ]).then(([agentScope, middleScope]) => {
    const created = store.createRun({ requestId: 'session-run-' + crypto.randomUUID(), workflowId: createWorkRunStore.WORKFLOW_ID, projectRef: 'synthetic-project' });
    assert.equal(created.ok, true);
    const sessionId = 'session-' + crypto.randomUUID();
    assert.deepEqual(store.getDshSession(sessionId), { ok: true, found: false, run: null, binding: null });
    const bindingInput = { runId: created.run.runId, sessionId, consentId: '', expectedVersion: created.run.version };
    const unprivilegedLink = store.bindDshSession(bindingInput);
    assert.equal(unprivilegedLink.ok, true);
    assert.equal(unprivilegedLink.binding.consentId, '', 'binding a Session grants no Consent');
    assert.equal(store.getDshSession(sessionId).binding.consentId, '');
    const consent = store.grantConsent({
      runId: created.run.runId, requestId: 'session-consent-' + crypto.randomUUID(), expectedVersion: created.run.version,
      projectRef: created.run.projectRef, providerScopes: [agentScope, middleScope], fileIds: ['synthetic-file'],
      memoryScope: {
        projectRef: created.run.projectRef, providerScope: agentScope,
        refs: [{ memoryId: 'am_' + crypto.randomUUID(), revision: 1, contentHash: 'a'.repeat(64) }],
        contextHash: 'b'.repeat(64), contextChars: 24
      },
      memoryDerivedScope: {
        projectRef: created.run.projectRef, contextHash: 'b'.repeat(64),
        review: { confirmed: true, providerScope: middleScope },
        result: { confirmed: true, destination: 'work_result', schemaVersion: consentCore.RESULT_SCHEMA_VERSION,
          storage: 'plaintext_home_node_sqlite', retentionMs: consentCore.RESULT_RETENTION_MS }
      }, expiresInMs: 60_000,
      termsVersion: createWorkRunStore.CONSENT_TERMS_VERSION, confirmed: true
    });
    assert.equal(consent.ok, true);
    const authorizedBinding = Object.assign({}, bindingInput, { consentId: consent.consent.consentId });
    const bound = store.bindDshSession(authorizedBinding);
    assert.equal(bound.ok, true);
    assert.equal(bound.rebound, true);
    assert.equal(store.getDshSession(sessionId).binding.consentId, consent.consent.consentId,
      'a fully consented project Memory scope can bind without storing plaintext in the Session link');
    assert.equal(store.bindDshSession(authorizedBinding).duplicate, true);
    assert.equal(store.bindDshSession({ ...authorizedBinding, sessionId: 'session-' + crypto.randomUUID() }).code, 'DSH_SESSION_ALREADY_BOUND');

    const secondRun = store.createRun({ requestId: 'session-run-' + crypto.randomUUID(), workflowId: createWorkRunStore.WORKFLOW_ID, projectRef: 'synthetic-project' });
    const secondConsent = store.grantConsent({
      runId: secondRun.run.runId, requestId: 'session-consent-' + crypto.randomUUID(), expectedVersion: secondRun.run.version,
      projectRef: secondRun.run.projectRef, providerScopes: [agentScope, middleScope], fileIds: ['synthetic-file'],
      memoryScope: null, memoryDerivedScope: null, expiresInMs: 60_000,
      termsVersion: createWorkRunStore.CONSENT_TERMS_VERSION, confirmed: true
    });
    assert.equal(secondConsent.ok, true);
    assert.equal(store.transition({ runId: created.run.runId, requestId: 'session-start-' + crypto.randomUUID(),
      expectedVersion: created.run.version, status: 'running', reasonCode: 'runtime_started' }).ok, true);
    const previous = store.getRun(created.run.runId).run;
    assert.equal(store.transition({ runId: created.run.runId, requestId: 'session-fail-' + crypto.randomUUID(),
      expectedVersion: previous.version, status: 'failed', reasonCode: 'runtime_failed' }).ok, true);
    const nextBinding = store.bindDshSession({ runId: secondRun.run.runId, sessionId, consentId: secondConsent.consent.consentId,
      expectedVersion: secondRun.run.version });
    assert.equal(nextBinding.ok, true, 'a terminal Run allows a new Run to join the same DSH Session');
    assert.equal(store.getDshSession(sessionId).binding.runId, secondRun.run.runId);
    assert.equal(store.getDshSession(sessionId).runs.length, 2);
    assert.equal(store.getDshSession(sessionId, created.run.runId).run.runId, created.run.runId,
      'a historical Run can be resolved by exact Run id');

    assert.equal(store.transition({ runId: secondRun.run.runId, requestId: 'session-start-next-' + crypto.randomUUID(),
      expectedVersion: secondRun.run.version, status: 'running', reasonCode: 'runtime_started' }).ok, true);
    const activeNext = store.getRun(secondRun.run.runId).run;
    assert.equal(store.transition({ runId: secondRun.run.runId, requestId: 'session-fail-next-' + crypto.randomUUID(),
      expectedVersion: activeNext.version, status: 'failed', reasonCode: 'runtime_failed' }).ok, true);

    const wrongProject = store.createRun({ requestId: 'session-run-other-' + crypto.randomUUID(), workflowId: createWorkRunStore.WORKFLOW_ID, projectRef: 'other-project' });
    assert.equal(store.bindDshSession({ runId: wrongProject.run.runId, sessionId, consentId: '',
      expectedVersion: wrongProject.run.version }).code, 'DSH_SESSION_SCOPE_MISMATCH');

    const appDraftRef = 'ad_' + crypto.randomUUID();
    const appBuilderSelection = executorCore.normalizeSnapshot({
      schemaVersion: 1, roleId: '', roleName: '标准 Agent', profileRef: 'synthetic-agent', presetId: 'app-builder',
      personaHash: 'a'.repeat(64),
      providerScope: { destination: 'agent', providerRef: 'synthetic-agent', provider: 'openai', model: 'synthetic-model', routeHash: 'b'.repeat(64) },
      allowedTools: executorCore.APP_DRAFT_TOOLS.slice(), maxProjectReadCalls: 0
    });
    assert.ok(appBuilderSelection);
    const appRun = store.createRun({ requestId: 'session-app-builder-' + crypto.randomUUID(),
      workflowId: createWorkRunStore.APP_BUILDER_WORKFLOW_ID, projectRef: 'synthetic-project',
      executorSelection: appBuilderSelection, appDraftRef: appDraftRef });
    assert.equal(appRun.ok, true);
    assert.equal(store.bindDshSession({ runId: appRun.run.runId, sessionId, consentId: '',
      expectedVersion: appRun.run.version }).ok, true, 'a Session can change workflows after its prior Run is terminal');
    assert.equal(store.cancel({ runId: appRun.run.runId, requestId: 'session-app-cancel-' + crypto.randomUUID(),
      expectedVersion: appRun.run.version }).run.status, 'cancelled');

    const auditAfterApp = store.createRun({ requestId: 'session-audit-after-app-' + crypto.randomUUID(),
      workflowId: createWorkRunStore.WORKFLOW_ID, projectRef: 'synthetic-project' });
    assert.equal(store.bindDshSession({ runId: auditAfterApp.run.runId, sessionId, consentId: '',
      expectedVersion: auditAfterApp.run.version }).ok, true, 'switching back keeps the same DSH Session history');
    assert.equal(store.getDshSession(sessionId).runs.length, 4);
    assert.equal(store.cancel({ runId: auditAfterApp.run.runId, requestId: 'session-audit-after-app-cancel-' + crypto.randomUUID(),
      expectedVersion: auditAfterApp.run.version }).run.status, 'cancelled');

    const differentDraft = store.createRun({ requestId: 'session-app-different-draft-' + crypto.randomUUID(),
      workflowId: createWorkRunStore.APP_BUILDER_WORKFLOW_ID, projectRef: 'synthetic-project',
      executorSelection: appBuilderSelection, appDraftRef: 'ad_' + crypto.randomUUID() });
    assert.equal(store.bindDshSession({ runId: differentDraft.run.runId, sessionId, consentId: '',
      expectedVersion: differentDraft.run.version }).code, 'DSH_SESSION_SCOPE_MISMATCH',
    'App Builder Runs in one Session cannot silently switch away from the shared draft');

    store.close();
    store = createWorkRunStore({ dataDir: root, logger: () => {} });
    store.open();
    const restored = store.getDshSession(sessionId);
    assert.equal(restored.ok, true);
    assert.equal(restored.run.runId, auditAfterApp.run.runId);
    assert.equal(restored.run.status, 'cancelled');
    assert.equal(restored.runs.length, 4);
    store.close();
  });
});

test('DSH session binding rejects malformed identities', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsh-session-invalid-'));
  try {
    const store = createWorkRunStore({ dataDir: root, logger: () => {} });
    store.open();
    assert.equal(store.bindDshSession({}).code, 'INVALID_REQUEST');
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('schema 7 single-Run DSH Session uniqueness migrates without losing the binding', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dsh-session-v7-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let store = createWorkRunStore({ dataDir: root, logger: () => {} });
  store.open();
  const run = store.createRun({ requestId: 'migration-run-' + crypto.randomUUID(),
    workflowId: createWorkRunStore.WORKFLOW_ID, projectRef: 'synthetic-project' });
  const sessionId = 'session-' + crypto.randomUUID();
  assert.equal(store.bindDshSession({ runId: run.run.runId, sessionId, consentId: '', expectedVersion: run.run.version }).ok, true);
  store.close();

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, 'home-node.db'));
  try {
    db.exec('CREATE UNIQUE INDEX work_run_dsh_sessions_v7_unique ON work_run_dsh_sessions(session_id)');
    db.prepare("UPDATE meta SET value='7' WHERE key='work_runs_schema_version'").run();
  } finally { db.close(); }

  store = createWorkRunStore({ dataDir: root, logger: () => {} });
  store.open();
  assert.equal(store.describe().schemaVersion, 9);
  assert.equal(store.getDshSession(sessionId).binding.runId, run.run.runId);
  const migrated = new DatabaseSync(path.join(root, 'home-node.db'));
  try {
    const indexes = migrated.prepare('PRAGMA index_list(work_run_dsh_sessions)').all();
    const hasUniqueSession = indexes.some(index => Number(index.unique) === 1
      && migrated.prepare('PRAGMA index_info("' + String(index.name).replace(/"/g, '""') + '")').all()
        .some(column => String(column.name) === 'session_id'));
    assert.equal(hasUniqueSession, false, 'the v7 unique session index is removed');
  } finally { migrated.close(); store.close(); }
});
