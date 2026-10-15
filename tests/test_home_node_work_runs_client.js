'use strict';

/* P28-WM-P1 · Work Run client contract.
   Runs the actual Home Node client against a request recorder. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONSENT_TERMS_VERSION = require(path.join(ROOT, 'assets', 'js', 'work-mode-consent-core.js')).TERMS_VERSION;
const CLIENT = path.join(ROOT, 'assets', 'js', 'home-node-client.js');
const BOOTSTRAP = path.join(ROOT, 'assets', 'js', 'home-node-bootstrap.js');
const P28 = path.join(ROOT, 'docs', 'P28-1-AGENT-RUNTIME-BOUNDARY-FREEZE.md');
const FOUNDATION = path.join(ROOT, 'docs', 'architecture', 'WORK_MODE_AGENT_RUNTIME_FOUNDATION_PHASE_1.md');
const TOKEN = 'synthetic-work-run-client-token';
const SENTINEL = 'synthetic-secret-must-not-cross-wire';
const oldWindow = global.window;
const oldStorage = global.localStorage;
const oldFetch = global.fetch;

function makeStorage() {
  const values = new Map([
    ['ib_home_node_http', 'http://127.0.0.1:23118'],
    ['ib_home_node_token', TOKEN]
  ]);
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

async function main() {
  const calls = [];
  global.localStorage = makeStorage();
  global.window = {};
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, protocolVersion: 1 }),
      blob: async () => new Blob(['synthetic agent memory snapshot']),
      headers: { get: name => name === 'Content-Disposition'
        ? 'attachment; filename="amb_12345678-1234-1234-1234-123456789012.db"'
        : (name === 'Content-Type' ? 'application/vnd.sqlite3' : '1') }
    };
  };
  delete require.cache[require.resolve(CLIENT)];
  require(CLIENT);

  const ib = global.window.IB;
  assert(ib && typeof ib.createWorkRunRemote === 'function', 'client should export the Work Run remote');
  const remote = ib.createWorkRunRemote({});
  assert(ib && typeof ib.createAgentMemoryRemote === 'function', 'client should export the independent Agent Memory remote');
  const agentMemory = ib.createAgentMemoryRemote({});
  const beforeUnconfirmedWrite = calls.length;
  assert.strictEqual((await agentMemory.create({
    type: 'Fact', projectRef: 'project_alpha', payload: { statement: 'Unconfirmed.' },
    provenance: { sourceKind: 'user_explicit' }
  })).error, 'explicit-memory-write-confirmation-required');
  assert.strictEqual(calls.length, beforeUnconfirmedWrite, 'generic Agent Memory writes fail before transport without confirmation');
  await agentMemory.create({
    type: 'Fact', projectRef: 'project_alpha', payload: { statement: 'Fixture fact.' },
    provenance: { sourceKind: 'user_explicit', sourceRef: 'fixture_1' }, confirmed: true, apiKey: SENTINEL
  });
  let memoryCall = calls[calls.length - 1];
  assert(memoryCall.url.endsWith('/internal/agent-memory/records'));
  assert.strictEqual(memoryCall.init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(memoryCall.init.body), {
    type: 'Fact', projectRef: 'project_alpha', payload: { statement: 'Fixture fact.' },
    provenance: { sourceKind: 'user_explicit', sourceRef: 'fixture_1' }, confirmed: true
  });
  assert.strictEqual(memoryCall.init.headers['X-IB-Home-Token'], TOKEN);
  assert(!memoryCall.init.body.includes(SENTINEL));
  await agentMemory.commitWorkResultCandidate({
    runId: 'wr_12345678-1234-1234-1234-123456789012',
    resultId: 'wrr_12345678-1234-1234-1234-123456789012',
    selectionRef: 'finding:0', expectedStoreRevision: 0, confirmed: true,
    projectRef: 'project_alpha', payload: { statement: SENTINEL }, apiKey: SENTINEL
  });
  memoryCall = calls[calls.length - 1];
  assert(memoryCall.url.endsWith('/internal/agent-memory/work-results/candidates/commit'));
  assert.deepStrictEqual(JSON.parse(memoryCall.init.body), {
    runId: 'wr_12345678-1234-1234-1234-123456789012',
    resultId: 'wrr_12345678-1234-1234-1234-123456789012',
    selectionRef: 'finding:0', expectedStoreRevision: 0, confirmed: true
  }, 'candidate transport cannot supply project scope or payload text');
  assert(!memoryCall.init.body.includes(SENTINEL));
  await agentMemory.commitWorkResultProcedureCandidate({
    runId: 'wr_12345678-1234-1234-1234-123456789012',
    resultId: 'wrr_12345678-1234-1234-1234-123456789012',
    resultSchemaVersion: 1, expectedStoreRevision: 2, confirmed: true,
    payload: { name: 'Review a scoped change', steps: ['Inspect the diff.', 'Run focused tests.'], whenToUse: 'Before accepting a small change.' },
    apiKey: SENTINEL
  });
  memoryCall = calls[calls.length - 1];
  assert(memoryCall.url.endsWith('/internal/agent-memory/work-results/procedure-candidates/commit'));
  assert.deepStrictEqual(JSON.parse(memoryCall.init.body), {
    runId: 'wr_12345678-1234-1234-1234-123456789012',
    resultId: 'wrr_12345678-1234-1234-1234-123456789012',
    resultSchemaVersion: 1, expectedStoreRevision: 2, confirmed: true,
    payload: { name: 'Review a scoped change', steps: ['Inspect the diff.', 'Run focused tests.'], whenToUse: 'Before accepting a small change.' }
  }, 'Procedure transport carries only the closed source and candidate payload');
  assert(!memoryCall.init.body.includes(SENTINEL));
  await agentMemory.query({ type: 'Fact', projectRef: 'project_alpha', status: 'active', limit: 10, offset: 2, apiKey: SENTINEL });
  assert(calls[calls.length - 1].url.endsWith('/internal/agent-memory/records?type=Fact&projectRef=project_alpha&status=active&limit=10&offset=2'));
  const memoryId = 'am_12345678-1234-1234-1234-123456789012';
  await agentMemory.get(memoryId);
  assert(calls[calls.length - 1].url.endsWith('/internal/agent-memory/records/' + memoryId));
  await agentMemory.update(memoryId, {
    expectedRevision: 1, payload: { statement: 'Revised fixture fact.' },
    provenance: { sourceKind: 'local_document_ref', sourceRef: 'doc_2' }, confirmed: true, raw: SENTINEL
  });
  memoryCall = calls[calls.length - 1];
  assert.strictEqual(memoryCall.init.method, 'POST');
  assert(memoryCall.url.endsWith('/' + memoryId + '/update'));
  assert.deepStrictEqual(JSON.parse(memoryCall.init.body), {
    expectedRevision: 1, payload: { statement: 'Revised fixture fact.' },
    provenance: { sourceKind: 'local_document_ref', sourceRef: 'doc_2' }, confirmed: true
  });
  await agentMemory.supersede(memoryId, {
    expectedRevision: 2, payload: { statement: 'Superseding fact.' },
    provenance: { sourceKind: 'user_explicit' }, confirmed: true
  });
  assert(calls[calls.length - 1].url.endsWith('/' + memoryId + '/supersede'));
  await agentMemory.retract(memoryId, {
    expectedRevision: 3, reasonCode: 'obsolete', provenance: { sourceKind: 'user_explicit' }, confirmed: true
  });
  assert(calls[calls.length - 1].url.endsWith('/' + memoryId + '/retract'));
  await agentMemory.purge({ limit: 10, path: SENTINEL });
  assert(calls[calls.length - 1].url.endsWith('/internal/agent-memory/maintenance/purge'));
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), { limit: 10 });
  await agentMemory.state();
  assert(calls[calls.length - 1].url.endsWith('/internal/agent-memory/state'));
  await agentMemory.retentionPolicy();
  assert(calls[calls.length - 1].url.endsWith('/internal/agent-memory/retention'));
  await agentMemory.expireObservations({ limit: 7 });
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), { limit: 7 });
  await agentMemory.createBackup();
  assert(calls[calls.length - 1].url.endsWith('/internal/agent-memory/backups'));
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), {});
  await agentMemory.listBackups({ limit: 9 });
  assert(calls[calls.length - 1].url.endsWith('/internal/agent-memory/backups?limit=9'));
  const backupId = 'amb_12345678-1234-1234-1234-123456789012';
  const exported = await agentMemory.exportBackup(backupId);
  assert.strictEqual(exported.ok, true);
  assert.strictEqual(exported.fileName, backupId + '.db');
  assert(exported.blob instanceof Blob, 'binary export uses the shared authenticated Home Node request path');
  await agentMemory.restoreBackup(backupId, { expectedStoreRevision: 4, confirmed: true });
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), { expectedStoreRevision: 4, confirmed: true });
  const snapshot = new Uint8Array([1, 2, 3]);
  await agentMemory.restoreUpload(snapshot, { expectedStoreRevision: null, confirmed: true });
  memoryCall = calls[calls.length - 1];
  assert.strictEqual(memoryCall.init.method, 'POST');
  assert(memoryCall.url.endsWith('/internal/agent-memory/restore?expectedStoreRevision=null&confirmed=true'));
  assert.strictEqual(memoryCall.init.headers['Content-Type'], 'application/vnd.sqlite3');
  assert.strictEqual(memoryCall.init.body, snapshot, 'restore uploads bytes without JSON wrapping');
  await agentMemory.deleteBackup(backupId);
  assert.strictEqual(calls[calls.length - 1].init.method, 'DELETE');
  await agentMemory.cleanupBackups({ limit: 4 });
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), { limit: 4 });

  await remote.create({
    requestId: 'create-1',
    workflowId: 'project.audit.readonly',
    projectRef: 'project_alpha',
    prompt: SENTINEL,
    apiKey: SENTINEL,
    toolArguments: { text: SENTINEL }
  });
  const createCall = calls[calls.length - 1];
  assert(createCall.url.endsWith('/internal/work/runs'));
  assert.strictEqual(createCall.init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(createCall.init.body), {
    requestId: 'create-1',
    workflowId: 'project.audit.readonly',
    projectRef: 'project_alpha'
  });
  assert.strictEqual(createCall.init.headers['X-IB-Home-Token'], TOKEN);
  assert(!createCall.init.body.includes(SENTINEL));

  await remote.transition('wr_12345678-1234-1234-1234-123456789012', {
    requestId: 'transition-1',
    expectedVersion: 1,
    status: 'running',
    reasonCode: 'runtime_started',
    prompt: SENTINEL,
    provider: 'openai'
  });
  const transitionCall = calls[calls.length - 1];
  assert(transitionCall.url.endsWith('/internal/work/runs/wr_12345678-1234-1234-1234-123456789012/transition'));
  assert.deepStrictEqual(JSON.parse(transitionCall.init.body), {
    requestId: 'transition-1',
    expectedVersion: 1,
    status: 'running',
    reasonCode: 'runtime_started'
  });
  assert(!transitionCall.init.body.includes(SENTINEL));

  await remote.cancel('wr_12345678-1234-1234-1234-123456789012', {
    requestId: 'cancel-1', expectedVersion: 2, secret: SENTINEL
  });
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), {
    requestId: 'cancel-1', expectedVersion: 2
  });

  await remote.events('wr_12345678-1234-1234-1234-123456789012', { afterSequence: 2, limit: 25 });
  assert(calls[calls.length - 1].url.endsWith('/events?afterSequence=2&limit=25'));
  await remote.memoryProvenance('wr_12345678-1234-1234-1234-123456789012');
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/wr_12345678-1234-1234-1234-123456789012/memory-provenance'));
  assert.strictEqual(calls[calls.length - 1].init.method, 'GET');
  await remote.recordActionTrace('wr_12345678-1234-1234-1234-123456789012', {
    requestId: 'trace-1', actionId: 'ib.work.plan.v1', status: 'succeeded',
    authorityResult: 'allowed', secret: SENTINEL
  });
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/wr_12345678-1234-1234-1234-123456789012/events'));
  assert.strictEqual(calls[calls.length - 1].init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), {
    requestId: 'trace-1', actionId: 'ib.work.plan.v1', status: 'succeeded', authorityResult: 'allowed'
  }, 'the closed client sends only Action Trace metadata');
  assert(!calls[calls.length - 1].init.body.includes(SENTINEL));
  await remote.dshStatus();
  assert(calls[calls.length - 1].url.endsWith('/internal/work/dsh'));
  await remote.bindDshSession('wr_12345678-1234-1234-1234-123456789012', {
    sessionId: 'session-12345678-1234-4234-8234-123456789012', consentId: '', expectedVersion: 1
  });
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/wr_12345678-1234-1234-1234-123456789012/dsh-session'));
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), {
    sessionId: 'session-12345678-1234-4234-8234-123456789012', consentId: '', expectedVersion: 1
  });
  await remote.getDshSession('session-12345678-1234-4234-8234-123456789012');
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/dsh-sessions/session-12345678-1234-4234-8234-123456789012'));
  await remote.getDshSession('session-12345678-1234-4234-8234-123456789012', 'wr_12345678-1234-1234-1234-123456789012');
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/dsh-sessions/session-12345678-1234-4234-8234-123456789012?runId=wr_12345678-1234-1234-1234-123456789012'));
  await remote.restoreAppDraftVersion('ad_12345678-1234-1234-1234-123456789012', 'project_alpha', 4);
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/app-drafts/ad_12345678-1234-1234-1234-123456789012/restore'));
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), { projectRef: 'project_alpha', version: 4 });
  await remote.getAppDraftVersion('ad_12345678-1234-1234-1234-123456789012', 'project_alpha', 3);
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/app-drafts/ad_12345678-1234-1234-1234-123456789012/versions/3?projectRef=project_alpha'));
  assert.strictEqual(calls[calls.length - 1].init.method, 'GET');
  await remote.runDsh('wr_12345678-1234-1234-1234-123456789012', {
    sessionId: 'session-12345678-1234-4234-8234-123456789012',
    consentId: 'wrc_12345678-1234-1234-1234-123456789012', providerRef: 'profile_alpha',
    prompt: SENTINEL, timeoutMs: 120000, plannedFileIds: ['pf_source'], deferResult: true, apiKey: SENTINEL
  });
  const dshRequestCall = calls[calls.length - 1];
  assert(dshRequestCall.url.endsWith('/internal/work/runs/wr_12345678-1234-1234-1234-123456789012/dsh'));
  assert.deepStrictEqual(JSON.parse(dshRequestCall.init.body), {
    sessionId: 'session-12345678-1234-4234-8234-123456789012',
    consentId: 'wrc_12345678-1234-1234-1234-123456789012',
    providerRef: 'profile_alpha', prompt: SENTINEL, plannedFileIds: ['pf_source'], deferResult: true, timeoutMs: 120000
  });
  assert.strictEqual(dshRequestCall.init.headers['X-IB-Home-Token'], TOKEN);
  assert(!dshRequestCall.init.body.includes('apiKey'));
  await remote.get('wr_12345678-1234-1234-1234-123456789012');
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/wr_12345678-1234-1234-1234-123456789012'));
  await remote.listActive({ limit: 33 });
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/active?limit=33'));
  await remote.listResults({ limit: 27 });
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/results?limit=27'));

  const runId = 'wr_12345678-1234-1234-1234-123456789012';
  const consentId = 'wrc_12345678-1234-1234-1234-123456789012';
  const providerScope = {
    destination: 'agent', providerRef: 'profile_alpha', provider: 'openai', model: 'mock-model', routeHash: 'a'.repeat(64)
  };
  const memoryScope = {
    projectRef: 'project_alpha', providerScope: providerScope,
    refs: [{ memoryId: 'am_12345678-1234-1234-1234-123456789012', revision: 2, contentHash: 'c'.repeat(64) }],
    contextHash: 'd'.repeat(64), contextChars: 512
  };
  const middleProviderScope = Object.assign({}, providerScope, { destination: 'middle_brain', providerRef: 'profile_mb' });
  const memoryDerivedScope = {
    projectRef: 'project_alpha', contextHash: memoryScope.contextHash,
    review: { confirmed: true, providerScope: middleProviderScope },
    result: { confirmed: true, destination: 'work_result', schemaVersion: 1,
      storage: 'plaintext_home_node_sqlite', retentionMs: 90 * 24 * 60 * 60 * 1000 }
  };
  await remote.grantConsent(runId, {
    requestId: 'consent-1', expectedVersion: 1, projectRef: 'project_alpha',
    providerScopes: [providerScope, middleProviderScope],
    fileIds: ['pf_source'], memoryScope: memoryScope, memoryDerivedScope: memoryDerivedScope, expiresInMs: 60000,
    termsVersion: CONSENT_TERMS_VERSION, confirmed: true, prompt: SENTINEL
  });
  let lastCall = calls[calls.length - 1];
  assert(lastCall.url.endsWith('/internal/work/runs/' + runId + '/consents'));
  assert.deepStrictEqual(JSON.parse(lastCall.init.body), {
    requestId: 'consent-1', expectedVersion: 1, projectRef: 'project_alpha',
    providerScopes: [providerScope, middleProviderScope],
    fileIds: ['pf_source'], workspaceWriteConfirmed: false, memoryScope: memoryScope, memoryDerivedScope: memoryDerivedScope,
    expiresInMs: 60000, termsVersion: CONSENT_TERMS_VERSION, confirmed: true
  });
  assert(!lastCall.init.body.includes(SENTINEL));

  await remote.checkConsent(runId, consentId, {
    projectRef: 'project_alpha', providerScope: providerScope, fileIds: ['pf_source'],
    consumer: 'agent', memoryScope: memoryScope, source: SENTINEL
  });
  lastCall = calls[calls.length - 1];
  assert(lastCall.url.endsWith('/consents/' + consentId + '/check'));
  assert.deepStrictEqual(JSON.parse(lastCall.init.body), {
    projectRef: 'project_alpha', providerScope: providerScope, fileIds: ['pf_source'],
    consumer: 'agent', memoryScope: memoryScope
  });
  await remote.checkConsent(runId, consentId, {
    projectRef: 'project_alpha', providerScope: providerScope, fileIds: ['pf_source'], consumer: 'agent'
  });
  lastCall = calls[calls.length - 1];
  assert.strictEqual(JSON.parse(lastCall.init.body).memoryScope, null,
    'every Agent destination check explicitly states either a bound Recall scope or no-memory scope');
  await remote.checkConsent(runId, consentId, {
    projectRef: 'project_alpha', providerScope: middleProviderScope, fileIds: ['pf_source'], consumer: 'middle_brain_review'
  });
  lastCall = calls[calls.length - 1];
  assert.deepStrictEqual(JSON.parse(lastCall.init.body), {
    projectRef: 'project_alpha', providerScope: middleProviderScope,
    fileIds: ['pf_source'], consumer: 'middle_brain_review'
  }, 'Review sink authorization is rechecked without resending memory scope or content');
  await remote.getConsent(runId, consentId);
  assert(calls[calls.length - 1].url.endsWith('/consents/' + consentId));
  const dshSessionId = 'session-12345678-1234-4234-9234-123456789012';
  await remote.bindDshSession(runId, { sessionId: dshSessionId, consentId: '', expectedVersion: 1 });
  assert(calls[calls.length - 1].url.endsWith('/dsh-session'));
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), {
    sessionId: dshSessionId, consentId: '', expectedVersion: 1
  }, 'the Home Node transport binds only Session identity, Consent id and Run CAS version');
  await remote.getDshSession(dshSessionId);
  assert(calls[calls.length - 1].url.endsWith('/internal/work/runs/dsh-sessions/' + dshSessionId));
  await remote.revokeConsent(runId, consentId, { requestId: 'revoke-1', expectedVersion: 2, secret: SENTINEL });
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), { requestId: 'revoke-1', expectedVersion: 2 });

  const resultInput = {
    requestId: 'complete-1', expectedVersion: 2, consentId: consentId,
    result: {
      schemaVersion: 1, summary: 'audit complete',
      findings: [{ fileId: 'pf_source', path: 'src/a.js', line: 2, severity: 'low', title: 'finding', detail: 'detail', raw: SENTINEL }]
    }, rawModelOutput: SENTINEL
  };
  await remote.complete(runId, resultInput);
  lastCall = calls[calls.length - 1];
  assert(lastCall.url.endsWith('/complete'));
  assert.deepStrictEqual(JSON.parse(lastCall.init.body), {
    requestId: 'complete-1', expectedVersion: 2, consentId: consentId,
    result: {
      schemaVersion: 1, summary: 'audit complete',
      findings: [{ fileId: 'pf_source', path: 'src/a.js', line: 2, severity: 'low', title: 'finding', detail: 'detail' }]
    }
  });
  assert(!lastCall.init.body.includes(SENTINEL), 'the transport drops uncontracted model and finding fields');
  await remote.result(runId);
  assert(calls[calls.length - 1].url.endsWith('/result'));
  await remote.resultReference(runId, {
    resultRunId: 'wr_12345678-1234-4234-8234-123456789013',
    resultId: 'wrres_12345678-1234-4234-8234-123456789014', prompt: SENTINEL
  });
  assert(calls[calls.length - 1].url.endsWith('/result/reference'));
  assert.strictEqual(calls[calls.length - 1].init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), {
    resultRunId: 'wr_12345678-1234-4234-8234-123456789013',
    resultId: 'wrres_12345678-1234-4234-8234-123456789014'
  }, 'Result reference transport sends only the immutable reference');
  await remote.deleteResult(runId, { requestId: 'delete-result', expectedVersion: 3 });
  assert.strictEqual(calls[calls.length - 1].init.method, 'POST');
  assert(calls[calls.length - 1].url.endsWith('/result/delete'));
  const retention = ib.createWorkRetentionRemote({});
  await retention.policy();
  assert(calls[calls.length - 1].url.endsWith('/internal/work/retention'));
  await retention.cleanup({ limit: 12 });
  assert.deepStrictEqual(JSON.parse(calls[calls.length - 1].init.body), { limit: 12 });

  const bootstrap = fs.readFileSync(BOOTSTRAP, 'utf8');
  assert(/workRuns:\s*\{/.test(bootstrap), 'IB.homeNode should expose the existing client remote');
  assert(/workRunRemote\.create/.test(bootstrap) && /workRunRemote\.cancel/.test(bootstrap)
    && /workRunRemote\.listActive/.test(bootstrap) && /workRunRemote\.listResults/.test(bootstrap) && /workRunRemote\.complete/.test(bootstrap)
    && /workRunRemote\.grantConsent/.test(bootstrap) && /workRunRemote\.result/.test(bootstrap)
    && /workRunRemote\.resultReference/.test(bootstrap)
    && /workRunRemote\.bindDshSession/.test(bootstrap) && /workRunRemote\.getDshSession/.test(bootstrap),
  'the existing Home Node Work Run facade must expose Session binding reads and writes');
  assert(/agentMemory:\s*\{/.test(bootstrap)
    && /agentMemoryRemote\.create/.test(bootstrap) && /agentMemoryRemote\.retract/.test(bootstrap)
    && /agentMemoryRemote\.commitWorkResultCandidate/.test(bootstrap)
    && /agentMemoryRemote\.commitWorkResultProcedureCandidate/.test(bootstrap)
    && /agentMemoryRemote\.restoreBackup/.test(bootstrap) && /agentMemoryRemote\.exportBackup/.test(bootstrap));
  const dbSchema = require(path.join(ROOT, 'assets', 'js', 'webcore-db-schema.js'));
  assert.strictEqual(dbSchema.DB_VERSION, 24, 'Work Run must not migrate the browser database');
  assert.strictEqual(dbSchema.STORE_NAMES.some(name => /work.?run|agent.?run/i.test(name)), false);
  assert.strictEqual(dbSchema.STORE_NAMES.some(name => /agent.?memory/i.test(name)), false,
    'Agent Memory does not migrate the browser database or add a Chat Memory index');
  assert(fs.readFileSync(P28, 'utf8').includes('P28-WM-P1'), 'P28 must record the scoped Work Mode amendment');
  const foundation = fs.readFileSync(FOUNDATION, 'utf8');
  assert(foundation.includes('Runtime Shell') && foundation.includes('Prompt Runtime'));
  console.log('Work Run client contract passed (closed request fields, shared token transport, Home Node facade).');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}).finally(() => {
  if (oldWindow === undefined) delete global.window; else global.window = oldWindow;
  if (oldStorage === undefined) delete global.localStorage; else global.localStorage = oldStorage;
  if (oldFetch === undefined) delete global.fetch; else global.fetch = oldFetch;
});
