'use strict';

/* P28-WM-P3B.0 · isolated Home Node Agent Memory store contract. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createChatStore = require('../services/home-node/chat-store.js');
const createMemoryStore = require('../services/home-node/memory-store.js');
const createAgentMemoryStore = require('../services/home-node/agent-memory-store.js');
const devSnapshot = require('../runtime/dev-snapshot.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-agent-memory-'));
const DATA = path.join(TMP, 'home-node');
const NOW = 1800000000000;
const SECRET = 'sk-agent-memory-secret-sentinel-123456789';

function tables(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)); }
  finally { db.close(); }
}

function count(file, table) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number(db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count); }
  finally { db.close(); }
}

function createVersionOneAgentMemoryDatabase(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE agent_memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec('CREATE TABLE agent_memory_records (' +
      'record_id TEXT PRIMARY KEY, memory_type TEXT NOT NULL, project_ref TEXT NOT NULL DEFAULT "", ' +
      'status TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ' +
      'terminal_at INTEGER, superseded_by TEXT, superseded_at INTEGER, retracted_at INTEGER, retraction_reason TEXT, ' +
      'provenance_json TEXT NOT NULL, payload_json TEXT, FOREIGN KEY (superseded_by) REFERENCES agent_memory_records(record_id) ON DELETE SET NULL, ' +
      "CHECK (memory_type IN ('Project','Decision','Fact','Observation','Procedure')), " +
      "CHECK (status IN ('active','superseded','retracted')), " +
      "CHECK ((status='retracted' AND payload_json IS NULL) OR status<>'retracted'))");
    db.prepare('INSERT INTO agent_memory_meta (key,value) VALUES (?,?)').run('schema_version', '1');
    db.prepare('INSERT INTO agent_memory_records ' +
      '(record_id,memory_type,project_ref,status,revision,created_at,updated_at,terminal_at,superseded_by,superseded_at,' +
      'retracted_at,retraction_reason,provenance_json,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        'am_12345678-1234-1234-1234-123456789012', 'Project', 'legacy_project', 'active', 3,
        1790000000000, 1790000001000, null, null, null, null, null,
        JSON.stringify([{ sourceKind: 'user_explicit', sourceRef: 'legacy_seed', sourceRevision: null, recordedAt: 1790000000000 }]),
        JSON.stringify({ name: 'Legacy Project', summary: 'Migration fixture.' })
      );
  } finally { db.close(); }
}

async function main() {
  let now = NOW;
  const chatStore = createChatStore({ dataDir: DATA, logger: () => {} });
  const memoryStore = createMemoryStore({ dataDir: DATA, logger: () => {} });
  const agentStore = createAgentMemoryStore({ dataDir: DATA, clock: () => now, logger: () => {} });
  const homeDb = path.join(DATA, 'home-node.db');
  const agentDb = path.join(DATA, 'agent-memory.db');
  try {
    chatStore.open();
    memoryStore.open();
    agentStore.open();
    assert.strictEqual(path.basename(agentStore.file), 'agent-memory.db');
    assert.notStrictEqual(path.resolve(agentStore.file), path.resolve(homeDb));
    const homeTables = tables(homeDb);
    const agentTables = tables(agentDb);
    assert(homeTables.includes('messages'));
    assert(homeTables.includes('memory_records'));
    assert(agentTables.includes('agent_memory_records'));
    assert(agentTables.includes('agent_memory_meta'));
    assert.strictEqual(agentTables.includes('messages'), false);
    assert.strictEqual(agentTables.includes('memory_records'), false);

    const linkedDir = path.join(TMP, 'hardlink-boundary');
    fs.mkdirSync(linkedDir, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const linkedHomeDb = path.join(linkedDir, 'home-node.db');
    const linkedAgentDb = path.join(linkedDir, 'agent-memory.db');
    const seedDb = new DatabaseSync(linkedHomeDb);
    seedDb.exec('CREATE TABLE chat_boundary_probe (id TEXT PRIMARY KEY)');
    seedDb.close();
    fs.linkSync(linkedHomeDb, linkedAgentDb);
    const linkedStore = createAgentMemoryStore({ dataDir: linkedDir, logger: () => {} });
    assert.throws(() => linkedStore.open(), /agent-memory-store-open-failed/,
      'the Agent Memory authority refuses a hard link to the Chat database file');
    assert.strictEqual(tables(linkedHomeDb).includes('agent_memory_records'), false);
    linkedStore.close();

    const provenance = { sourceKind: 'user_explicit', sourceRef: 'consent_ref_1' };
    const created = {};
    created.project = agentStore.createRecord({ type: 'Project', projectRef: 'project_alpha', payload: { name: 'Atlas', summary: 'Local design notes.' }, provenance });
    created.decision = agentStore.createRecord({ type: 'Decision', projectRef: 'project_alpha', payload: { statement: 'Keep transport adapters narrow.', rationale: 'Reduce authority overlap.' }, provenance });
    created.fact = agentStore.createRecord({ type: 'Fact', projectRef: 'project_alpha', payload: { statement: 'The app uses a desktop Home Node.', confidence: 'high', observedAt: NOW }, provenance });
    created.observation = agentStore.createRecord({ type: 'Observation', projectRef: 'project_alpha', payload: { statement: 'Result list displays metadata only.', observedAt: NOW, contextRef: 'test_case_7' }, provenance });
    created.procedure = agentStore.createRecord({ type: 'Procedure', projectRef: 'project_alpha', payload: { name: 'Review a bounded change', steps: ['Inspect the diff.', 'Run focused tests.'], whenToUse: 'Before a small release.' }, provenance });
    for (const type of Object.keys(created)) assert.strictEqual(created[type].ok, true, type + ' create should succeed');
    assert.strictEqual(created.observation.record.expiresAt, NOW + 30 * 24 * 60 * 60 * 1000,
      'new Observation defaults to a 30-day effective lifetime');
    assert.deepStrictEqual(agentStore.queryRecords({ projectRef: 'project_alpha' }).records.map(item => item.type).sort(),
      ['Decision', 'Fact', 'Observation', 'Procedure', 'Project']);
    assert.strictEqual(count(homeDb, 'memory_records'), 0, 'Agent Memory writes never enter Chat Memory');
    assert.strictEqual(count(homeDb, 'messages'), 0, 'Agent Memory writes never enter Chat messages');

    const candidateRevision = agentStore.currentStoreRevision().storeRevision;
    const candidateInput = {
      expectedStoreRevision: candidateRevision, confirmed: true,
      projectRef: 'project_alpha', resultId: 'wrr_result_alpha_1', resultSchemaVersion: 1,
      selectionRef: 'finding:0', statement: 'Selected audit finding, not the full Work Result.'
    };
    assert.strictEqual(agentStore.createWorkResultObservation(Object.assign({}, candidateInput, { confirmed: false })).code,
      'CONFIRMATION_REQUIRED', 'candidate writes require explicit confirmation');
    const workCandidate = agentStore.createWorkResultObservation(candidateInput);
    assert.strictEqual(workCandidate.ok, true);
    assert.strictEqual(workCandidate.record.type, 'Observation');
    assert.strictEqual(workCandidate.record.projectRef, 'project_alpha');
    assert.strictEqual(workCandidate.record.provenance[0].sourceRef, 'wrr_result_alpha_1');
    assert.strictEqual(workCandidate.record.provenance[0].selectionRef, 'finding:0');
    assert.strictEqual(workCandidate.record.payload.statement, candidateInput.statement);
    assert.strictEqual(workCandidate.record.expiresAt, NOW + 30 * 24 * 60 * 60 * 1000);
    const candidateDuplicate = agentStore.createWorkResultObservation(Object.assign({}, candidateInput, {
      expectedStoreRevision: 0
    }));
    assert.strictEqual(candidateDuplicate.ok, true);
    assert.strictEqual(candidateDuplicate.duplicate, true,
      'retrying the same Work Result selection is idempotent even with the pre-commit revision');
    assert.strictEqual(candidateDuplicate.record.memoryId, workCandidate.record.memoryId);
    assert.strictEqual(agentStore.currentStoreRevision().storeRevision, workCandidate.storeRevision,
      'idempotent candidate retry does not advance store revision');
    assert.strictEqual(count(homeDb, 'memory_records'), 0,
      'Work Result candidate writes remain absent from Chat Memory after commit');
    assert.strictEqual(count(homeDb, 'messages'), 0,
      'Work Result candidate writes do not create Chat messages');
    const procedureInput = {
      expectedStoreRevision: agentStore.currentStoreRevision().storeRevision,
      confirmed: true,
      projectRef: 'project_beta',
      runId: 'wr_12345678-1234-4234-8234-123456789012',
      resultId: 'wrr_result_beta_procedure',
      resultSchemaVersion: 1,
      payload: { name: 'Review a bounded change', steps: ['Inspect the selected diff.', 'Run the focused regression.'], whenToUse: 'Before accepting a small code change.' }
    };
    assert.strictEqual(agentStore.createWorkResultProcedure(Object.assign({}, procedureInput, { confirmed: false })).code,
      'CONFIRMATION_REQUIRED', 'Procedure candidates require explicit human confirmation');
    const procedureCandidate = agentStore.createWorkResultProcedure(procedureInput);
    assert.strictEqual(procedureCandidate.ok, true);
    assert.strictEqual(procedureCandidate.record.type, 'Procedure');
    assert.deepStrictEqual(procedureCandidate.record.payload, procedureInput.payload);
    assert.strictEqual(procedureCandidate.record.provenance[0].sourceKind, 'work_result_ref');
    assert.strictEqual(procedureCandidate.record.provenance[0].sourceRunId, procedureInput.runId);
    assert.strictEqual(procedureCandidate.record.provenance[0].sourceRef, procedureInput.resultId);
    assert(/^procedure:[a-f0-9]{64}$/.test(procedureCandidate.record.provenance[0].selectionRef));
    const procedureDuplicate = agentStore.createWorkResultProcedure(Object.assign({}, procedureInput, { expectedStoreRevision: 0 }));
    assert.strictEqual(procedureDuplicate.ok, true);
    assert.strictEqual(procedureDuplicate.duplicate, true, 'retrying the same reviewed Procedure is idempotent');
    assert.strictEqual(procedureDuplicate.record.memoryId, procedureCandidate.record.memoryId);
    const procedureRevision = agentStore.currentStoreRevision().storeRevision;
    const missingProcedureUse = agentStore.createWorkResultProcedure(Object.assign({}, procedureInput, {
      expectedStoreRevision: procedureRevision,
      resultId: 'wrr_result_beta_missing_use',
      payload: { name: 'Incomplete Procedure', steps: ['Inspect the selected diff.'] }
    }));
    assert.strictEqual(missingProcedureUse.code, 'INVALID_RECORD', 'Procedure candidate requires whenToUse');
    const sensitiveProcedure = agentStore.createWorkResultProcedure(Object.assign({}, procedureInput, {
      expectedStoreRevision: procedureRevision,
      resultId: 'wrr_result_beta_sensitive_procedure',
      payload: { name: 'Unsafe Procedure', steps: ['Use token sk-agent-memory-secret-sentinel-123456789.'] }
    }));
    assert.strictEqual(sensitiveProcedure.code, 'INVALID_RECORD', 'sensitive Procedure fields remain rejected');
    assert.strictEqual(agentStore.currentStoreRevision().storeRevision, procedureRevision,
      'a rejected Procedure candidate never advances Agent Memory revision');
    agentStore.createRecord({ type: 'Fact', projectRef: 'project_beta', payload: { statement: 'Advance CAS.' }, provenance: provenance });
    const staleProcedure = agentStore.createWorkResultProcedure(Object.assign({}, procedureInput, {
      expectedStoreRevision: procedureRevision, resultId: 'wrr_result_beta_stale_procedure',
      payload: { name: 'Stale Procedure', steps: ['Inspect the selected diff.'], whenToUse: 'Before accepting a small change.' }
    }));
    assert.strictEqual(staleProcedure.code, 'VERSION_CONFLICT', 'Procedure candidate preserves Agent Memory revision CAS');
    assert.strictEqual(count(homeDb, 'memory_records'), 0, 'Procedure candidates stay out of Chat Memory records');
    assert.strictEqual(count(homeDb, 'messages'), 0, 'Procedure candidates do not create Chat messages');
    const betaCandidate = agentStore.createWorkResultObservation(Object.assign({}, candidateInput, {
      expectedStoreRevision: agentStore.currentStoreRevision().storeRevision,
      projectRef: 'project_beta', resultId: 'wrr_result_beta_1'
    }));
    assert.strictEqual(betaCandidate.ok, true);
    assert.strictEqual(agentStore.queryRecords({ projectRef: 'project_alpha', type: 'Observation' }).records
      .some(item => item.memoryId === betaCandidate.record.memoryId), false,
    'a project-scoped candidate is never returned through another project query');
    const staleCandidateRevision = agentStore.currentStoreRevision().storeRevision;
    agentStore.createRecord({ type: 'Project', projectRef: 'project_alpha', payload: { name: 'Concurrent revision' }, provenance: provenance });
    const staleCandidate = agentStore.createWorkResultObservation(Object.assign({}, candidateInput, {
      expectedStoreRevision: staleCandidateRevision, resultId: 'wrr_result_alpha_stale', selectionRef: 'summary'
    }));
    assert.strictEqual(staleCandidate.code, 'VERSION_CONFLICT');
    const sensitiveCandidate = agentStore.createWorkResultObservation(Object.assign({}, candidateInput, {
      expectedStoreRevision: agentStore.currentStoreRevision().storeRevision,
      resultId: 'wrr_result_secret', selectionRef: 'summary', statement: 'Leaked credential ' + SECRET
    }));
    assert.strictEqual(sensitiveCandidate.code, 'INVALID_RECORD', 'sensitive candidate content is rejected');

    const factId = created.fact.record.memoryId;
    const updated = agentStore.updateRecord(factId, {
      expectedRevision: 1,
      payload: { statement: 'The app uses one desktop Home Node authority.', confidence: 'high', observedAt: NOW + 1 },
      provenance: { sourceKind: 'local_document_ref', sourceRef: 'architecture_doc_2' }
    });
    assert.strictEqual(updated.ok, true);
    assert.strictEqual(updated.record.revision, 2);
    assert.strictEqual(updated.record.provenance.length, 2, 'provenance appends on each revision');
    assert(agentStore.describe().storeRevision >= 6, 'store-wide revision advances with mutations');
    const stale = agentStore.updateRecord(factId, {
      expectedRevision: 1,
      payload: { statement: 'Stale overwrite.', confidence: 'low' },
      provenance: provenance
    });
    assert.strictEqual(stale.code, 'VERSION_CONFLICT');
    assert.strictEqual(stale.record.revision, 2);

    const decisionId = created.decision.record.memoryId;
    const replaced = agentStore.supersedeRecord(decisionId, {
      expectedRevision: 1,
      payload: { statement: 'Keep adapters domain-specific.', rationale: 'Authority stays legible.' },
      provenance: { sourceKind: 'user_explicit', sourceRef: 'decision_revision_2' }
    });
    assert.strictEqual(replaced.ok, true);
    assert.strictEqual(replaced.previous.status, 'superseded');
    assert.strictEqual(replaced.previous.revision, 2);
    assert.strictEqual(replaced.previous.supersededBy, replaced.record.memoryId);
    assert.strictEqual(replaced.record.supersedes, decisionId, 'the successor links back to its prior revision');
    assert.strictEqual(replaced.record.status, 'active');
    assert.strictEqual(replaced.record.revision, 1);

    const observationId = created.observation.record.memoryId;
    const retracted = agentStore.retractRecord(observationId, {
      expectedRevision: 1, reasonCode: 'source_invalid',
      provenance: { sourceKind: 'user_explicit', sourceRef: 'review_1' }
    });
    assert.strictEqual(retracted.ok, true);
    assert.strictEqual(retracted.record.status, 'retracted');
    assert.strictEqual(retracted.record.payload, null, 'retraction clears record content immediately');
    assert.strictEqual(agentStore.getRecord(observationId).record.payload, null);

    const expiringObservation = agentStore.createRecord({
      type: 'Observation', projectRef: 'project_alpha', expiresAt: NOW + 1000,
      payload: { statement: 'This temporary observation should expire.' }, provenance: provenance
    });
    assert.strictEqual(expiringObservation.ok, true);
    now += 1001;
    const expiredView = agentStore.getRecord(expiringObservation.record.memoryId);
    assert.strictEqual(expiredView.record.status, 'expired');
    assert.strictEqual(expiredView.record.payload, null, 'expired Observation content is not returned');
    assert.strictEqual(agentStore.queryRecords({ projectRef: 'project_alpha' }).records.some(
      record => record.memoryId === expiringObservation.record.memoryId), false,
    'expired Observations are absent from the default active query');
    assert(agentStore.queryRecords({ projectRef: 'project_alpha', status: 'expired' }).records.some(
      record => record.memoryId === expiringObservation.record.memoryId));
    assert.strictEqual(agentStore.cleanupExpiredObservations({ limit: 10 }).expired, 1);
    assert.strictEqual(agentStore.getRecord(expiringObservation.record.memoryId).record.status, 'expired',
      'explicit cleanup creates an expired tombstone, not a Chat Memory mutation');
    assert.strictEqual(agentStore.createRecord({
      type: 'Project', projectRef: 'project_alpha', expiresAt: NOW + 2000,
      payload: { name: 'Invalid expiry.' }, provenance: provenance
    }).code, 'INVALID_RECORD', 'only Observation accepts expiresAt');

    const invalid = agentStore.createRecord({
      type: 'Fact', projectRef: 'project_alpha',
      payload: { statement: 'API_KEY=' + SECRET }, provenance: provenance
    });
    assert.strictEqual(invalid.code, 'INVALID_RECORD', 'credential-shaped memory content is rejected');
    assert(!fs.readFileSync(agentDb).includes(Buffer.from(SECRET)), 'rejected sensitive content never reaches the database file');
    assert.strictEqual(agentStore.createRecord({
      type: 'Fact', projectRef: 'project_alpha', payload: { statement: 'x', extra: 'closed schema' }, provenance: provenance
    }).code, 'INVALID_RECORD');

    const rollbackSource = agentStore.createRecord({
      type: 'Fact', projectRef: 'project_alpha', payload: { statement: 'Rollback source record.' }, provenance: provenance
    });
    const triggerDb = new DatabaseSync(agentDb);
    try {
      triggerDb.exec("CREATE TRIGGER fail_agent_memory_supersede BEFORE UPDATE ON agent_memory_records " +
        "WHEN OLD.record_id='" + rollbackSource.record.memoryId + "' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END");
    } finally { triggerDb.close(); }
    const rollback = agentStore.supersedeRecord(rollbackSource.record.memoryId, {
      expectedRevision: 1, payload: { statement: 'This replacement must roll back.' }, provenance: provenance
    });
    assert.strictEqual(rollback.code, 'STORE_UNAVAILABLE');
    assert.strictEqual(agentStore.getRecord(rollbackSource.record.memoryId).record.status, 'active');
    assert.strictEqual(agentStore.queryRecords({ projectRef: 'project_alpha', type: 'Fact' }).total, 2,
      'a failed supersede rolls its replacement insert back');
    const cleanupTriggerDb = new DatabaseSync(agentDb);
    try { cleanupTriggerDb.exec('DROP TRIGGER fail_agent_memory_supersede'); }
    finally { cleanupTriggerDb.close(); }

    const memoryBackup = await agentStore.createBackup();
    assert.strictEqual(memoryBackup.ok, true, JSON.stringify(memoryBackup));
    assert.strictEqual(memoryBackup.backup.schemaVersion, 2);
    const exported = agentStore.exportBackup(memoryBackup.backup.backupId);
    assert.strictEqual(exported.ok, true);
    assert(exported.data.length > 512);
    const postBackup = agentStore.createRecord({
      type: 'Fact', projectRef: 'project_alpha', payload: { statement: 'Created after the snapshot.' }, provenance: provenance
    });
    assert.strictEqual(postBackup.ok, true);
    const staleRestore = await agentStore.restoreBackup(memoryBackup.backup.backupId, {
      expectedStoreRevision: memoryBackup.backup.storeRevision, confirmed: true
    });
    assert.strictEqual(staleRestore.code, 'VERSION_CONFLICT', 'restore conflicts if the store changed after its snapshot was reviewed');
    assert.strictEqual(agentStore.getRecord(postBackup.record.memoryId).ok, true);
    const revisionBeforeRestore = agentStore.currentStoreRevision().storeRevision;
    const restored = await agentStore.restoreBackup(memoryBackup.backup.backupId, {
      expectedStoreRevision: revisionBeforeRestore, confirmed: true
    });
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(restored.recordCount > 0, true);
    assert.strictEqual(agentStore.currentStoreRevision().storeRevision, revisionBeforeRestore + 1,
      'restore advances the target store revision instead of rewinding it');
    assert.strictEqual(agentStore.getRecord(postBackup.record.memoryId).code, 'MEMORY_NOT_FOUND',
      'restore is a whole-database replacement, not a merge');

    const postLocalRestore = agentStore.createRecord({
      type: 'Fact', projectRef: 'project_alpha', payload: { statement: 'Created before uploaded restore.' }, provenance: provenance
    });
    const revisionBeforeUpload = agentStore.currentStoreRevision().storeRevision;
    const uploadedRestore = await agentStore.restoreUpload(exported.data, {
      expectedStoreRevision: revisionBeforeUpload, confirmed: true
    });
    assert.strictEqual(uploadedRestore.ok, true, 'the exported SQLite file can be restored through the upload contract');
    assert.strictEqual(agentStore.currentStoreRevision().storeRevision, revisionBeforeUpload + 1);
    assert.strictEqual(agentStore.getRecord(postLocalRestore.record.memoryId).code, 'MEMORY_NOT_FOUND');
    const backups = agentStore.listBackups({ limit: 10 });
    assert(backups.backups.some(item => item.backupId === memoryBackup.backup.backupId));

    let failInstall = true;
    const rollbackStore = createAgentMemoryStore({
      dataDir: path.join(TMP, 'restore-rollback'),
      logger: () => {},
      renameFile: function (source, target) {
        if (failInstall && path.resolve(target) === path.resolve(path.join(TMP, 'restore-rollback', 'agent-memory.db'))
          && String(source).indexOf('.restore-') >= 0) {
          failInstall = false;
          throw new Error('synthetic restore install failure');
        }
        return fs.renameSync(source, target);
      }
    });
    try {
      rollbackStore.open();
      const stable = rollbackStore.createRecord({
        type: 'Project', projectRef: 'project_rollback', payload: { name: 'Rollback fixture.' }, provenance: provenance
      });
      const rollbackSnapshot = await rollbackStore.createBackup();
      const failedRestore = await rollbackStore.restoreBackup(rollbackSnapshot.backup.backupId, {
        expectedStoreRevision: rollbackStore.currentStoreRevision().storeRevision, confirmed: true
      });
      assert.strictEqual(failedRestore.code, 'RESTORE_FAILED');
      assert.strictEqual(failedRestore.rolledBack, true);
      assert.strictEqual(rollbackStore.getRecord(stable.record.memoryId).record.payload.name, 'Rollback fixture.',
        'failed file replacement reopens the original Authority');
    } finally { rollbackStore.close(); }

    const policy = agentStore.retentionPolicy();
    assert.strictEqual(policy.cleanupScheduled, false);
    now += policy.terminalRetentionMs + 1;
    const purged = agentStore.purgeTombstones({ limit: 10 });
    assert.strictEqual(purged.ok, true);
    assert.strictEqual(purged.purged, 3);
    assert.strictEqual(agentStore.getRecord(observationId).code, 'MEMORY_NOT_FOUND');
    assert.strictEqual(agentStore.getRecord(decisionId).code, 'MEMORY_NOT_FOUND');
    assert.strictEqual(agentStore.getRecord(created.project.record.memoryId).record.status, 'active',
      'cleanup never purges active records');

    agentStore.close();
    agentStore.open();
    assert.strictEqual(agentStore.getRecord(factId).record.revision, 2, 'active revisions survive reopen');
    assert.strictEqual(agentStore.getRecord(replaced.record.memoryId).record.payload.statement, 'Keep adapters domain-specific.');
    assert.strictEqual(chatStore.isOpen(), true);
    assert.strictEqual(memoryStore.isOpen(), true);

    const homeBackup = path.join(TMP, 'home-node-copy.db');
    const backup = await devSnapshot.backupHomeNodeDatabase(homeDb, homeBackup);
    assert(fs.existsSync(backup.file));
    const backupTables = tables(homeBackup);
    assert.strictEqual(backupTables.includes('agent_memory_records'), false,
      'existing home-node.db backups exclude the physically separate Agent Memory database');
    assert.strictEqual(devSnapshot.SNAPSHOT_STORE_NAMES.some(name => /agent.?memory/i.test(name)), false,
      'existing browser JSON export does not add an Agent Memory store');
    const launcherSource = fs.readFileSync(path.join(__dirname, '..', 'runtime/ib-dev-launcher.js'), 'utf8');
    assert(/path\.join\(APP_DATA,\s*'home-node',\s*'home-node\.db'\)/.test(launcherSource));
    assert(!/agent-memory\.db/.test(launcherSource), 'existing Dev snapshot backup remains scoped to home-node.db');

    const legacyDir = path.join(TMP, 'schema-v1');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, 'agent-memory-v1.db');
    createVersionOneAgentMemoryDatabase(legacyFile);
    const migrationDir = path.join(TMP, 'schema-v1-restore-target');
    const migrationStore = createAgentMemoryStore({ dataDir: migrationDir, logger: () => {} });
    try {
      migrationStore.open();
      const migrated = await migrationStore.restoreUpload(fs.readFileSync(legacyFile), {
        expectedStoreRevision: migrationStore.currentStoreRevision().storeRevision, confirmed: true
      });
      assert.strictEqual(migrated.ok, true);
      assert.strictEqual(migrated.migratedFrom, 1, 'supported Agent Memory v1 snapshots migrate in staging');
      const legacyRecord = migrationStore.getRecord('am_12345678-1234-1234-1234-123456789012');
      assert.strictEqual(legacyRecord.ok, true);
      assert.strictEqual(legacyRecord.record.payload.name, 'Legacy Project');
      const { DatabaseSync } = require('node:sqlite');
      const futureFile = path.join(legacyDir, 'agent-memory-future.db');
      const futureDb = new DatabaseSync(futureFile);
      try {
        futureDb.exec('CREATE TABLE agent_memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        futureDb.exec('CREATE TABLE agent_memory_records (future_column TEXT)');
        futureDb.prepare('INSERT INTO agent_memory_meta (key,value) VALUES (?,?)').run('schema_version', '999');
        futureDb.prepare('INSERT INTO agent_memory_meta (key,value) VALUES (?,?)').run('future_padding', 'x'.repeat(1024));
      } finally { futureDb.close(); }
      const unsupported = await migrationStore.restoreUpload(fs.readFileSync(futureFile), {
        expectedStoreRevision: migrationStore.currentStoreRevision().storeRevision, confirmed: true
      });
      assert.strictEqual(unsupported.code, 'BACKUP_SCHEMA_FUTURE');
      assert.strictEqual(migrationStore.getRecord('am_12345678-1234-1234-1234-123456789012').ok, true,
        'incompatible restore leaves the current Authority untouched');
    } finally { migrationStore.close(); }
    const futureTargetDir = path.join(TMP, 'future-current-schema');
    fs.mkdirSync(path.join(futureTargetDir, 'agent-memory-backups'), { recursive: true });
    const futureTargetFile = path.join(futureTargetDir, 'agent-memory.db');
    const futureCurrentDb = new DatabaseSync(futureTargetFile);
    try {
      futureCurrentDb.exec('CREATE TABLE agent_memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      futureCurrentDb.exec('CREATE TABLE future_agent_memory_data (future_value TEXT)');
      futureCurrentDb.prepare('INSERT INTO agent_memory_meta (key,value) VALUES (?,?)').run('schema_version', '999');
    } finally { futureCurrentDb.close(); }
    const recoveryId = 'amb_87654321-4321-4321-8321-210987654321';
    fs.copyFileSync(path.join(DATA, 'agent-memory-backups', memoryBackup.backup.backupId + '.db'),
      path.join(futureTargetDir, 'agent-memory-backups', recoveryId + '.db'));
    const futureCurrentStore = createAgentMemoryStore({ dataDir: futureTargetDir, logger: () => {} });
    try {
      assert.throws(() => futureCurrentStore.open(), /agent-memory-store-open-failed/);
      const downgrade = await futureCurrentStore.restoreBackup(recoveryId, { expectedStoreRevision: null, confirmed: true });
      assert.strictEqual(downgrade.code, 'CURRENT_SCHEMA_FUTURE', 'restore refuses to downgrade a future live database');
      const stillFuture = new DatabaseSync(futureTargetFile, { readOnly: true });
      try { assert.strictEqual(stillFuture.prepare('SELECT value FROM agent_memory_meta WHERE key=?').get('schema_version').value, '999'); }
      finally { stillFuture.close(); }
    } finally { futureCurrentStore.close(); }
    const oldBackups = agentStore.listBackups({ limit: 10 });
    assert(oldBackups.backups.length > 0);
    assert.strictEqual(agentStore.cleanupBackups({ limit: 10 }).cleanupScheduled, false);
    assert.strictEqual(agentStore.listBackups({ limit: 10 }).backups.length, 0,
      'aged plaintext backup/export artifacts require explicit bounded cleanup');
    for (const relative of [
      'services/home-node/memory-store.js', 'services/home-node/memory-retrieval.js',
      'assets/js/memory-authority.js', 'assets/js/memory-retrieval-core.js',
      'assets/js/communication.js', 'assets/js/role-dm.js', 'assets/js/middle-brain.js'
    ]) {
      const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
      assert(!/agentMemory|agent-memory/.test(source), relative + ' has no Agent Memory read/write integration');
    }
    const workRuntime = fs.readFileSync(path.join(__dirname, '..', 'assets/js/work-mode-runtime.js'), 'utf8');
    assert(/agentMemory\.query/.test(workRuntime), 'Work Agent Recall reads through the existing Agent Memory Authority');
    assert(!/agentMemory\.(create|update|supersede|retract|purge)/.test(workRuntime),
      'Work Agent Recall has no Agent Memory write or lifecycle authority');
    console.log('Agent Memory store contract passed (separate DB, five types, revisions, expiry, backup/export/restore, schema migration, rollback, redaction, reopen, export boundary).');
  } finally {
    try { agentStore.close(); } catch (_) { }
    try { memoryStore.close(); } catch (_) { }
    try { chatStore.close(); } catch (_) { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { }
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
