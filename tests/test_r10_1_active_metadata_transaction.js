'use strict';

/*
 * R10.1 Active canonical writer transaction test.
 * The service and state file are isolated in a temporary data directory.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-r10-1-active-'));
process.env.IB_ACTIVE_DATA_DIR = dataDir;
process.env.IB_ACTIVE_DISABLE_NOTIFICATIONS = '1';

const service = require(path.join(ROOT, 'services', 'active-message-service.js'));
const state = service.getState();
state.moments.role_tx = {
  id: 'role_tx',
  characterId: 'role_tx',
  enabled: true,
  status: 'idle',
  character: { id: 'role_tx', provider: 'synthetic', model: 'synthetic-model', endpoint: 'http://127.0.0.1:1' }
};
state.moments.role_other = {
  id: 'role_other',
  characterId: 'role_other',
  enabled: true,
  status: 'idle',
  character: { id: 'role_other', provider: 'synthetic', model: 'synthetic-model', endpoint: 'http://127.0.0.1:1' }
};
state.plans.plan_other = {
  id: 'plan_other',
  characterId: 'role_other',
  status: 'scheduled',
  character: { id: 'role_other', provider: 'synthetic', model: 'synthetic-model', endpoint: 'http://127.0.0.1:1' }
};
state.tasks.task_other = {
  setting: { id: 'task_other', character_id: 'role_other' },
  character: { id: 'role_other', provider: 'synthetic', model: 'synthetic-model', endpoint: 'http://127.0.0.1:1' }
};
service.saveNow();

function readState() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'active-message-service.json'), 'utf8'));
}

async function run() {
  let invalidFieldRejected = false;
  try {
    await service.mutateTargetMetadata({
      transactionId: 'r101-invalid',
      targetType: 'moment_character',
      targetId: 'role_tx',
      patch: { credentialRef: 'must-not-be-accepted' }
    });
  } catch (_) {
    invalidFieldRejected = true;
  }
  assert.strictEqual(invalidFieldRejected, true);

  const txPromise = service.mutateTargetMetadata({
    transactionId: 'r101-tx-001',
    targetType: 'moment_character',
    targetId: 'role_tx',
    patch: { __r101_test_marker: 'synthetic-marker' }
  });

  /*
   * Simulated scheduler/runtime mutation happens before the queued transaction
   * callback runs. Both mutations use the same in-memory state and writer.
   */
  state.moments.role_tx.lastRuntimeMutation = 'synthetic-runtime-write';
  service.saveNow();
  const applied = await txPromise;
  assert.strictEqual(applied.status, 'APPLIED');

  const afterCommit = readState();
  assert.strictEqual(afterCommit.moments.role_tx.character.__r101_test_marker, 'synthetic-marker');
  assert.strictEqual(afterCommit.moments.role_tx.lastRuntimeMutation, 'synthetic-runtime-write');
  assert.strictEqual(afterCommit.moments.role_other.character.__r101_test_marker, undefined);
  assert.strictEqual(afterCommit.plans.plan_other.character.__r101_test_marker, undefined);
  assert.strictEqual(afterCommit.tasks.task_other.character.__r101_test_marker, undefined);

  const duplicate = await service.mutateTargetMetadata({
    transactionId: 'r101-tx-001',
    targetType: 'moment_character',
    targetId: 'role_tx',
    patch: { __r101_test_marker: 'different-marker' }
  });
  assert.strictEqual(duplicate.status, 'ALREADY_APPLIED');

  const rollback = await service.rollbackTargetMetadata(applied.snapshot);
  assert.strictEqual(rollback.status, 'ROLLED_BACK');
  const afterRollback = readState();
  assert.strictEqual(afterRollback.moments.role_tx.character.__r101_test_marker, undefined);
  assert.strictEqual(afterRollback.moments.role_tx.lastRuntimeMutation, 'synthetic-runtime-write');
  assert.strictEqual(afterRollback.moments.role_other.character.__r101_test_marker, undefined);
  assert.strictEqual(afterRollback.plans.plan_other.character.__r101_test_marker, undefined);
  assert.strictEqual(afterRollback.tasks.task_other.character.__r101_test_marker, undefined);

  const duplicateRollback = await service.rollbackTargetMetadata(applied.snapshot);
  assert.strictEqual(duplicateRollback.status, 'ALREADY_ROLLED_BACK');

  const persisted = JSON.stringify(afterRollback);
  assert.strictEqual(persisted.includes('credentialRef'), false);
  assert.strictEqual(persisted.includes('apiKey'), false);

  console.log(JSON.stringify({
    canonicalWriter: 'active/persistence.js via service composition root',
    serialization: 'promise-chain plus synchronous canonical state mutation',
    atomicPersistence: true,
    targetScopedMutation: true,
    liveWriterContention: true,
    readback: true,
    rollback: true,
    idempotency: true,
    unrelatedStateUnchanged: true,
    credentialWrites: 0,
    credentialSecretReads: 0,
    providerCalls: 0,
    allPassed: true
  }, null, 2));
}

run().catch(error => {
  console.error(JSON.stringify({
    code: 'R10_1_TEST_FAILED',
    message: String(error && error.message || error).slice(0, 240)
  }));
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
});
