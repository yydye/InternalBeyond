'use strict';

/* Synthetic-only RecoveryOnly apply executor contract tests. Never opens real
   IndexedDB, issues a native token, or invokes Tauri IPC. */
const assert = require('assert');
const { RecoveryOnlyApplyExecutor } = require('../assets/js/recovery-apply-executor.js');
const ProductionAdapterModule = require('../assets/js/recovery-production-adapter.js');

const hash = 'a'.repeat(64);
function prepared() {
  return {
    plan: {
      mode: 'dry-run',
      status: 'READY_FOR_EXPLICIT_RESTORE_APPROVAL',
      executionPhase: 'R3-B.3',
      planId: 'r3b3:' + hash,
      transactionId: 'r3b3-tx:' + hash,
      productionBinding: { productionPlanHash: hash }
    }
  };
}

function fakeAdapter(options = {}) {
  const sequence = [];
  return {
    hostTrusted: options.hostTrusted !== false,
    targetIdentity: 'synthetic-canonical-host',
    PRODUCTION_APPLY_ENABLED: false,
    sequence,
    failure: options.failure || '',
    async issueExplicitProductionRestoreApproval(value, request) {
      sequence.push('approval');
      assert.strictEqual(request.planId, value.plan.planId);
      assert.strictEqual(request.planHash, value.plan.productionBinding.productionPlanHash);
      return {
        kind: 'EXPLICIT_PRODUCTION_RESTORE_APPROVAL',
        token: 'synthetic-only-token',
        planId: request.planId,
        planHash: request.planHash,
        expiresAt: Date.now() + 60_000
      };
    },
    async createRollbackCheckpoint() {
      sequence.push('checkpoint');
      return { planId: 'r3b3:' + hash, integritySha256: 'b'.repeat(64), createdAt: 'synthetic' };
    },
    async verifyRollbackCheckpoint() {
      sequence.push('checkpoint-verify');
      return ['checkpoint', 'abort'].includes(options.failure) ? { ok: false, error: 'synthetic-checkpoint-failure' } :
        { ok: true, preStateRestorableByInsertRollback: true };
    },
    async abortRollbackCheckpoint() {
      sequence.push('checkpoint-abort');
      if (options.failure === 'abort') throw new Error('synthetic-checkpoint-abort-failure');
      return { ok: true, aborted: true };
    },
    async withApprovedApplyWindow(_prepared, _approval, operation) {
      sequence.push('window-open');
      try { return await operation(); }
      finally { sequence.push('window-close'); }
    },
    async applyTransaction() {
      sequence.push('transaction');
      if (options.failure === 'transaction') throw new Error('synthetic-transaction-failure');
      return { ok: true, planId: 'r3b3:' + hash, insertedKeys: { chatMessages: ['m1'] } };
    },
    async verifyAfterApply() {
      sequence.push('post-verify');
      if (options.failure === 'verify' || options.failure === 'rollback') return { ok: false, failures: [{ domain: 'chatMessages' }] };
      return {
        ok: true,
        domainResults: [{ domain: 'chatMessages', sourceCount: 1, insertedCount: 1, stableIdsVerified: true, referencesVerified: true }],
        credentialState: 'NEEDS_REBIND',
        credentialBearingFieldsRestored: 0
      };
    },
    async rollback() {
      sequence.push('rollback');
      if (options.failure === 'rollback') throw new Error('synthetic-rollback-failure');
      return { ok: true, deletedKeys: { chatMessages: ['m1'] } };
    }
  };
}

let pass = 0;
async function check(name, fn) {
  await fn();
  pass++;
  console.log('PASS ' + name);
}

async function main() {
  console.log('P32-W.5 P5.7 RecoveryOnly Apply Executor synthetic tests');

  await check('production apply defaults false and ordinary host cannot issue or execute approval', async () => {
    const adapter = fakeAdapter({ hostTrusted: false });
    const executor = new RecoveryOnlyApplyExecutor(adapter);
    await assert.rejects(executor.requestApproval(prepared(), {
      planId: 'r3b3:' + hash, planHash: hash, confirmation: '执行 R3-B.3 production restore'
    }), /recoveryonly-scoped-executor-required/);
    assert.strictEqual(adapter.PRODUCTION_APPLY_ENABLED, false);
    assert.deepStrictEqual(adapter.sequence, []);
  });

  await check('single module gate is exposed read-only on adapter instances and executor still requires the native issuer', async () => {
    assert.strictEqual(ProductionAdapterModule.PRODUCTION_APPLY_ENABLED, false);
    const adapter = new ProductionAdapterModule.ProductionRecoveryAdapter({
      testOnlySyntheticHost: true,
      trustedHost: true
    });
    assert.strictEqual(adapter.PRODUCTION_APPLY_ENABLED, false);
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(adapter), 'PRODUCTION_APPLY_ENABLED');
    assert.strictEqual(typeof descriptor.get, 'function');
    assert.strictEqual(descriptor.set, undefined);

    let nativeConfirmationRequests = 0;
    let checkpoints = 0;
    let applyWindows = 0;
    let writes = 0;
    let providerCalls = 0;
    adapter.issueExplicitProductionRestoreApproval = async () => {
      nativeConfirmationRequests++;
      throw new Error('synthetic-native-confirmation-required');
    };
    adapter.createRollbackCheckpoint = async () => { checkpoints++; };
    adapter.withApprovedApplyWindow = async () => { applyWindows++; };
    adapter.applyTransaction = async () => { writes++; };
    adapter.providerCalls = () => { providerCalls++; };

    const executor = new RecoveryOnlyApplyExecutor(adapter, { testOnlySyntheticHost: true, trustedHost: true });
    const request = {
      planId: 'r3b3:' + hash,
      planHash: hash,
      confirmation: '执行 R3-B.3 production restore'
    };
    await assert.rejects(executor.requestApproval(prepared(), request), /synthetic-native-confirmation-required/);
    assert.strictEqual(nativeConfirmationRequests, 1);
    assert.strictEqual(executor.approval, null);
    await assert.rejects(executor.execute(prepared()), /explicit-production-restore-approval-required/);
    assert.deepStrictEqual({ checkpoints, applyWindows, writes, providerCalls }, {
      checkpoints: 0, applyWindows: 0, writes: 0, providerCalls: 0
    });
  });

  await check('approval is typed to the exact production plan id and hash', async () => {
    const adapter = fakeAdapter();
    const executor = new RecoveryOnlyApplyExecutor(adapter, { testOnlySyntheticHost: true, trustedHost: true });
    await assert.rejects(executor.requestApproval(prepared(), {
      planId: 'r3b3:' + 'c'.repeat(64), planHash: hash, confirmation: '执行 R3-B.3 production restore'
    }), /approval-plan-id-mismatch/);
    await assert.rejects(executor.requestApproval(prepared(), {
      planId: 'r3b3:' + hash, planHash: 'd'.repeat(64), confirmation: '执行 R3-B.3 production restore'
    }), /approval-plan-hash-mismatch/);
    await assert.rejects(executor.requestApproval(prepared(), {
      planId: 'r3b3:' + hash, planHash: hash, confirmation: 'wrong phrase'
    }), /explicit-production-restore-approval-required/);
    assert.deepStrictEqual(adapter.sequence, []);
    const result = await executor.requestApproval(prepared(), {
      planId: 'r3b3:' + hash, planHash: hash, confirmation: '执行 R3-B.3 production restore'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.tokenExposed, false);
    assert.strictEqual(adapter.sequence.filter(event => event === 'approval').length, 1);
  });

  await check('durable checkpoint is verified before one scoped window and one transaction', async () => {
    const adapter = fakeAdapter();
    const executor = new RecoveryOnlyApplyExecutor(adapter, { testOnlySyntheticHost: true, trustedHost: true });
    await executor.requestApproval(prepared(), { planId: 'r3b3:' + hash, planHash: hash, confirmation: '执行 R3-B.3 production restore' });
    const report = await executor.execute(prepared());
    assert.deepStrictEqual(adapter.sequence, ['approval', 'checkpoint', 'checkpoint-verify', 'window-open', 'transaction', 'post-verify', 'window-close']);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.planHash, hash);
    assert.strictEqual(report.credentialState, 'NEEDS_REBIND');
    assert.strictEqual(report.credentialBearingFieldsRestored, 0);
    assert.strictEqual(report.applyWindowClosed, true);
    assert.strictEqual(report.activeQuarantined, true);
  });

  await check('transaction failure rolls back inside the scoped window and always closes it', async () => {
    const adapter = fakeAdapter({ failure: 'transaction' });
    const executor = new RecoveryOnlyApplyExecutor(adapter, { testOnlySyntheticHost: true, trustedHost: true });
    await executor.requestApproval(prepared(), { planId: 'r3b3:' + hash, planHash: hash, confirmation: '执行 R3-B.3 production restore' });
    await assert.rejects(executor.execute(prepared()), /PRODUCTION_RESTORE_FAILED_ROLLED_BACK/);
    assert.deepStrictEqual(adapter.sequence, ['approval', 'checkpoint', 'checkpoint-verify', 'window-open', 'transaction', 'rollback', 'window-close']);
  });

  await check('post-verify failure triggers rollback before closing the native window', async () => {
    const adapter = fakeAdapter({ failure: 'verify' });
    const executor = new RecoveryOnlyApplyExecutor(adapter, { testOnlySyntheticHost: true, trustedHost: true });
    await executor.requestApproval(prepared(), { planId: 'r3b3:' + hash, planHash: hash, confirmation: '执行 R3-B.3 production restore' });
    await assert.rejects(executor.execute(prepared()), /PRODUCTION_RESTORE_FAILED_ROLLED_BACK/);
    assert.deepStrictEqual(adapter.sequence, ['approval', 'checkpoint', 'checkpoint-verify', 'window-open', 'transaction', 'post-verify', 'rollback', 'window-close']);
  });

  await check('rollback failure is a critical stop and the scoped window is still closed', async () => {
    const adapter = fakeAdapter({ failure: 'rollback' });
    const executor = new RecoveryOnlyApplyExecutor(adapter, { testOnlySyntheticHost: true, trustedHost: true });
    await executor.requestApproval(prepared(), { planId: 'r3b3:' + hash, planHash: hash, confirmation: '执行 R3-B.3 production restore' });
    await assert.rejects(executor.execute(prepared()), /RECOVERY_CRITICAL_STOP:rollback-failed/);
    assert.strictEqual(adapter.sequence.at(-1), 'window-close');
  });

  await check('checkpoint prestate failure prevents apply-window opening and transaction', async () => {
    const adapter = fakeAdapter({ failure: 'checkpoint' });
    const executor = new RecoveryOnlyApplyExecutor(adapter, { testOnlySyntheticHost: true, trustedHost: true });
    await executor.requestApproval(prepared(), { planId: 'r3b3:' + hash, planHash: hash, confirmation: '执行 R3-B.3 production restore' });
    await assert.rejects(executor.execute(prepared()), /rollback-checkpoint-prestate-verification-failed/);
    assert.deepStrictEqual(adapter.sequence, ['approval', 'checkpoint', 'checkpoint-verify', 'checkpoint-abort']);
    assert.strictEqual(executor.lastCheckpoint, null);
  });

  await check('pre-apply checkpoint abort failure is a critical stop and never opens apply', async () => {
    const adapter = fakeAdapter({ failure: 'abort' });
    const executor = new RecoveryOnlyApplyExecutor(adapter, { testOnlySyntheticHost: true, trustedHost: true });
    await executor.requestApproval(prepared(), { planId: 'r3b3:' + hash, planHash: hash, confirmation: '执行 R3-B.3 production restore' });
    await assert.rejects(executor.execute(prepared()), /RECOVERY_CRITICAL_STOP:checkpoint-lifecycle-abort-failed/);
    assert.deepStrictEqual(adapter.sequence, ['approval', 'checkpoint', 'checkpoint-verify', 'checkpoint-abort']);
  });

  console.log('PASS ' + pass + ' P5.7 apply executor checks');
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
