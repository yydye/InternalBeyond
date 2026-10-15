'use strict';

/* P28-WM-P3B.2 · portable Agent Memory recovery between isolated installations. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createAgentMemoryStore = require('../services/home-node/agent-memory-store.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-agent-memory-cross-install-'));
const SOURCE_DIR = path.join(ROOT, 'installation-a', 'home-node');
const TARGET_DIR = path.join(ROOT, 'installation-b', 'home-node');
const PROVENANCE = { sourceKind: 'user_explicit', sourceRef: 'cross_install_fixture' };

async function main() {
  const source = createAgentMemoryStore({ dataDir: SOURCE_DIR, logger: () => {} });
  let interruptedTarget = null;
  let target = null;
  try {
    source.open();
    const oldFact = source.createRecord({
      type: 'Fact', projectRef: 'project_portable',
      payload: { statement: 'Portable source revision one.' }, provenance: PROVENANCE
    });
    assert.strictEqual(oldFact.ok, true);
    const newFact = source.supersedeRecord(oldFact.record.memoryId, {
      expectedRevision: 1,
      payload: { statement: 'Portable source revision two.' },
      provenance: { sourceKind: 'work_result_ref', sourceRef: 'wrr_portable_1', selectionRef: 'finding:0' }
    });
    assert.strictEqual(newFact.ok, true);
    const sourceRevision = source.currentStoreRevision().storeRevision;
    const backup = await source.createBackup();
    assert.strictEqual(backup.ok, true);
    const exported = source.exportBackup(backup.backup.backupId);
    assert.strictEqual(exported.ok, true);
    assert(Buffer.isBuffer(exported.data), 'portable handoff contains the dedicated SQLite snapshot bytes');

    const targetFile = path.join(TARGET_DIR, 'agent-memory.db');
    interruptedTarget = createAgentMemoryStore({
      dataDir: TARGET_DIR,
      logger: () => {},
      renameFile: (from, to) => {
        if (to === targetFile && String(from).indexOf('.restore-') >= 0) throw new Error('simulated cross-install swap failure');
        fs.renameSync(from, to);
      }
    });
    interruptedTarget.open();
    const targetOnly = interruptedTarget.createRecord({
      type: 'Project', projectRef: 'project_target_only',
      payload: { name: 'Destination installation' }, provenance: PROVENANCE
    });
    assert.strictEqual(targetOnly.ok, true);
    const beforeFailureRevision = interruptedTarget.currentStoreRevision().storeRevision;
    const failed = await interruptedTarget.restoreUpload(exported.data, {
      expectedStoreRevision: beforeFailureRevision, confirmed: true
    });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.code, 'RESTORE_FAILED');
    assert.strictEqual(failed.rolledBack, true, 'failed installation replacement reports successful rollback');
    assert.strictEqual(interruptedTarget.getRecord(targetOnly.record.memoryId).ok, true,
      'destination installation keeps its pre-restore authority after failed replacement');
    assert.strictEqual(interruptedTarget.getRecord(newFact.record.memoryId).ok, false,
      'failed cross-install import does not partially merge source records');
    assert.strictEqual(interruptedTarget.currentStoreRevision().storeRevision, beforeFailureRevision);
    interruptedTarget.close();

    target = createAgentMemoryStore({ dataDir: TARGET_DIR, logger: () => {} });
    target.open();
    const beforeSuccessRevision = target.currentStoreRevision().storeRevision;
    const restored = await target.restoreUpload(exported.data, {
      expectedStoreRevision: beforeSuccessRevision, confirmed: true
    });
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(restored.storeRevision, Math.max(beforeSuccessRevision, sourceRevision) + 1,
      'cross-install recovery advances the larger revision rather than adopting an older counter');
    assert.strictEqual(target.getRecord(targetOnly.record.memoryId).ok, false,
      'successful recovery is a whole-database replacement, not a merge');
    const restoredFact = target.getRecord(newFact.record.memoryId);
    assert.strictEqual(restoredFact.ok, true);
    assert.strictEqual(restoredFact.record.projectRef, 'project_portable');
    assert.strictEqual(restoredFact.record.supersedes, oldFact.record.memoryId);
    assert.strictEqual(target.getRecord(oldFact.record.memoryId).record.supersededBy, newFact.record.memoryId,
      'cross-install restore preserves traceable revision links');
    console.log('Agent Memory cross-install restore passed (isolated directories, full replacement, provenance, revision links, rollback).');
  } finally {
    try { if (target) target.close(); } catch (_) { }
    try { if (interruptedTarget) interruptedTarget.close(); } catch (_) { }
    try { source.close(); } catch (_) { }
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { }
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
