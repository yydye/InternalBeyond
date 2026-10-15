'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const createWorkRunStore = require('../services/home-node/work-run-store.js');

function fixtureStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-action-trace-'));
  const store = createWorkRunStore({ dataDir, logger: () => {} });
  assert.equal(store.open().ok, true);
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, store };
}

function createRunningRun(store) {
  const created = store.createRun({
    requestId: 'trace-run-' + crypto.randomUUID(),
    workflowId: createWorkRunStore.WORKFLOW_ID,
    projectRef: 'trace-project'
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const running = store.transition({
    runId: created.run.runId,
    requestId: 'trace-start-' + crypto.randomUUID(),
    expectedVersion: created.run.version,
    status: 'running',
    reasonCode: 'runtime_started'
  });
  assert.equal(running.ok, true, JSON.stringify(running));
  return running.run;
}

test('Work Run events persist bounded Action traces and denied unregistered Actions', t => {
  const { store } = fixtureStore(t);
  const run = createRunningRun(store);
  const success = store.recordActionTrace(run.runId, {
    requestId: 'wm_12345678-1234-4234-8234-123456789012', actionId: 'ib.work.plan.v1', status: 'succeeded', authorityResult: 'allowed'
  });
  assert.equal(success.ok, true, JSON.stringify(success));

  const denied = store.recordActionTrace(run.runId, {
    requestId: 'wm_12345678-1234-4234-8234-123456789013', actionId: 'ib.work.unknown.v1', status: 'denied', authorityResult: 'denied'
  });
  assert.equal(denied.ok, true, JSON.stringify(denied));
  const compare = store.recordActionTrace(run.runId, {
    requestId: 'wm_12345678-1234-4234-8234-123456789015', actionId: 'ib.result.compare.v1',
    status: 'succeeded', authorityResult: 'allowed'
  });
  assert.equal(compare.ok, true, JSON.stringify(compare));
  assert.equal(store.getRun(run.runId).run.version, run.version, 'Action Trace append never changes Run status or version');

  const events = store.listEvents(run.runId, { afterSequence: 0, limit: 10 });
  assert.equal(events.ok, true);
  assert.deepEqual(events.events.map(event => event.eventType), [
    'created', 'state_changed', 'action_trace', 'action_trace', 'action_trace'
  ]);
  assert.deepEqual(events.events[2].actionTrace, {
    schemaVersion: 1,
    actionId: 'ib.work.plan.v1',
    requestId: 'wm_12345678-1234-4234-8234-123456789012',
    runId: run.runId,
    status: 'succeeded',
    authorityResult: 'allowed'
  });
  assert.deepEqual(events.events[3].actionTrace, {
    schemaVersion: 1,
    actionId: 'ib.work.unknown.v1',
    requestId: 'wm_12345678-1234-4234-8234-123456789013',
    runId: run.runId,
    status: 'denied',
    authorityResult: 'denied'
  });
  assert.deepEqual(events.events[4].actionTrace, {
    schemaVersion: 1,
    actionId: 'ib.result.compare.v1',
    requestId: 'wm_12345678-1234-4234-8234-123456789015',
    runId: run.runId,
    status: 'succeeded',
    authorityResult: 'allowed'
  });
  assert.ok(events.events[3].createdAt >= events.events[2].createdAt);

  const invalid = store.recordActionTrace(run.runId, {
    requestId: 'wm_12345678-1234-4234-8234-123456789014', actionId: 'ib.work.plan.v1', status: 'succeeded',
    authorityResult: 'allowed', memoryText: 'SENSITIVE_MEMORY_SENTINEL'
  });
  assert.equal(invalid.code, 'INVALID_REQUEST');
  assert.equal(JSON.stringify(store.listEvents(run.runId, { limit: 10 }).events)
    .includes('SENSITIVE_MEMORY_SENTINEL'), false);
  assert.equal(JSON.stringify(events.events).includes('Credential'), false);
});

test('schema v9 Run Events upgrade in place to the optional Action Trace payload column', t => {
  const { dataDir, store } = fixtureStore(t);
  const run = store.createRun({ requestId: 'trace-migrate-create',
    workflowId: createWorkRunStore.WORKFLOW_ID, projectRef: 'trace-project' });
  assert.equal(run.ok, true);
  const dbFile = path.join(dataDir, 'home-node.db');
  store.close();
  const legacy = new DatabaseSync(dbFile);
  try {
    legacy.exec('ALTER TABLE work_run_events DROP COLUMN action_trace_json');
    legacy.prepare('UPDATE meta SET value=? WHERE key=?').run('9', 'work_runs_schema_version');
  } finally { legacy.close(); }

  assert.equal(store.open().ok, true);
  assert.equal(store.describe().schemaVersion, 10);
  const migrated = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const columns = new Set(migrated.prepare('PRAGMA table_info(work_run_events)').all().map(row => String(row.name)));
    assert.equal(columns.has('action_trace_json'), true);
    assert.equal(store.listEvents(run.run.runId, { limit: 10 }).events.length, 1,
      'the lifecycle event is retained during the additive column migration');
  } finally { migrated.close(); }
});
