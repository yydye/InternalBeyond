'use strict';

/* Home Node · Independent Agent Memory Authority.
   This store intentionally opens agent-memory.db, never home-node.db. */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const homeNodeSnapshot = require('../../runtime/dev-snapshot.js');

const DB_FILENAME = 'agent-memory.db';
const SCHEMA_VERSION = 2;
const MAX_QUERY_LIMIT = 100;
const MAX_QUERY_OFFSET = 10000;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_TERMINAL_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BACKUP_COUNT = 100;
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const DEFAULT_OBSERVATION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_TYPES = Object.freeze(['Project', 'Decision', 'Fact', 'Observation', 'Procedure']);
const STATUSES = Object.freeze(['active', 'superseded', 'retracted', 'expired']);
const STORED_STATUSES = Object.freeze(['active', 'superseded', 'retracted']);
const SOURCE_KINDS = Object.freeze([
  'user_explicit', 'work_run_ref', 'work_result_ref', 'local_document_ref', 'external_reference', 'manual_import'
]);
const RETRACTION_REASONS = Object.freeze(['incorrect', 'obsolete', 'privacy_request', 'source_invalid', 'other']);
const RECORD_ID_RE = /^am_[A-Za-z0-9-]{36}$/;
const REF_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const WORK_RUN_ID_RE = /^wr_[A-Za-z0-9-]{36}$/;

const SQL = Object.freeze({
  createMeta: 'CREATE TABLE IF NOT EXISTS agent_memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  readMeta: 'SELECT value FROM agent_memory_meta WHERE key=?',
  writeMeta: 'INSERT INTO agent_memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  createRecords: 'CREATE TABLE IF NOT EXISTS agent_memory_records (' +
    'record_id TEXT PRIMARY KEY, memory_type TEXT NOT NULL, project_ref TEXT NOT NULL DEFAULT "", ' +
    'status TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ' +
    'terminal_at INTEGER, expires_at INTEGER, expired_at INTEGER, supersedes_id TEXT, ' +
    'superseded_by TEXT, superseded_at INTEGER, retracted_at INTEGER, retraction_reason TEXT, ' +
    'provenance_json TEXT NOT NULL, payload_json TEXT, ' +
    'FOREIGN KEY (superseded_by) REFERENCES agent_memory_records(record_id) ON DELETE SET NULL, ' +
    'FOREIGN KEY (supersedes_id) REFERENCES agent_memory_records(record_id) ON DELETE SET NULL, ' +
    'CHECK (memory_type IN (\'Project\', \'Decision\', \'Fact\', \'Observation\', \'Procedure\')), ' +
    'CHECK (status IN (\'active\', \'superseded\', \'retracted\')), ' +
    'CHECK ((status=\'retracted\' AND payload_json IS NULL) OR status<>\'retracted\'))',
  createByScope: 'CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory_records ' +
    '(status, memory_type, project_ref, updated_at DESC, record_id DESC)',
  createByTerminal: 'CREATE INDEX IF NOT EXISTS idx_agent_memory_terminal ON agent_memory_records (status, terminal_at)',
  createByExpiry: 'CREATE INDEX IF NOT EXISTS idx_agent_memory_expiry ON agent_memory_records (memory_type, status, expires_at, expired_at)',
  readRecord: 'SELECT * FROM agent_memory_records WHERE record_id=?',
  insertRecord: 'INSERT INTO agent_memory_records ' +
    '(record_id, memory_type, project_ref, status, revision, created_at, updated_at, terminal_at, expires_at, expired_at, ' +
    'supersedes_id, superseded_by, superseded_at, retracted_at, retraction_reason, provenance_json, payload_json) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, ?)',
  updateRecord: 'UPDATE agent_memory_records SET revision=?, updated_at=?, expires_at=?, provenance_json=?, payload_json=? ' +
    'WHERE record_id=? AND status=\'active\' AND revision=?',
  supersedeRecord: 'UPDATE agent_memory_records SET status=\'superseded\', revision=?, updated_at=?, terminal_at=?, ' +
    'superseded_by=?, superseded_at=?, provenance_json=? WHERE record_id=? AND status=\'active\' AND revision=?',
  retractRecord: 'UPDATE agent_memory_records SET status=\'retracted\', revision=?, updated_at=?, terminal_at=?, ' +
    'retracted_at=?, retraction_reason=?, provenance_json=?, payload_json=NULL ' +
    'WHERE record_id=? AND status=\'active\' AND revision=?',
  expireObservations: 'UPDATE agent_memory_records SET status=\'retracted\', revision=revision+1, updated_at=?, terminal_at=?, expired_at=?, ' +
    'retraction_reason=\'expired\', payload_json=NULL WHERE memory_type=\'Observation\' AND status=\'active\' ' +
    'AND expired_at IS NULL AND expires_at IS NOT NULL AND expires_at<=? AND record_id IN (' +
    'SELECT record_id FROM agent_memory_records WHERE memory_type=\'Observation\' AND status=\'active\' ' +
    'AND expired_at IS NULL AND expires_at IS NOT NULL AND expires_at<=? ORDER BY expires_at ASC, record_id ASC LIMIT ?)',
  purgeTerminal: 'DELETE FROM agent_memory_records WHERE record_id IN (' +
    'SELECT record_id FROM agent_memory_records WHERE status IN (\'superseded\', \'retracted\') ' +
    'AND terminal_at<=? ORDER BY terminal_at ASC, record_id ASC LIMIT ?)'
});

function exactKeys(value, required, optional) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const allowed = new Set(required.concat(optional || []));
  const actual = Object.keys(value);
  return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every(key => allowed.has(key));
}

function storeError(code, extra) { return Object.assign({ ok: false, code: code }, extra || {}); }

function createAgentMemoryStore(deps) {
  deps = deps || {};
  const dataDir = path.resolve(deps.dataDir || process.cwd());
  const dbFile = path.resolve(deps.dbFile || path.join(dataDir, DB_FILENAME));
  if (path.basename(dbFile).toLowerCase() !== DB_FILENAME) throw new Error('agent-memory-database-name-invalid');
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  let db = null;
  let opened = false;
  let openFailure = null;
  const backupDir = path.join(path.dirname(dbFile), 'agent-memory-backups');
  const renameFile = typeof deps.renameFile === 'function' ? deps.renameFile : fs.renameSync;
  const createSqliteBackup = typeof deps.backupDatabase === 'function'
    ? deps.backupDatabase : homeNodeSnapshot.backupHomeNodeDatabase;

  function loadSqlite() {
    try { return require('node:sqlite'); }
    catch (error) {
      const unavailable = new Error('node:sqlite is unavailable in this runtime');
      unavailable.code = 'SQLITE_UNAVAILABLE';
      throw unavailable;
    }
  }

  function readRow(id) {
    const row = db.prepare(SQL.readRecord).get(id);
    if (!row) return null;
    return rowToRecord(row);
  }

  function rowToRecord(row) {
    let provenance = [], payload = null;
    try { provenance = JSON.parse(String(row.provenance_json || '[]')); } catch (_) { provenance = []; }
    const memoryType = String(row.memory_type);
    const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
    const expiredByTime = String(row.status) === 'active' && memoryType === 'Observation'
      && expiresAt != null && expiresAt <= clock();
    const expired = expiredByTime || row.expired_at != null || String(row.retraction_reason || '') === 'expired';
    if (row.payload_json != null && String(row.status) !== 'retracted' && !expired) {
      try { payload = JSON.parse(String(row.payload_json)); } catch (_) { payload = null; }
    }
    return {
      memoryId: String(row.record_id),
      type: memoryType,
      projectRef: row.project_ref ? String(row.project_ref) : null,
      status: expired ? 'expired' : String(row.status),
      revision: Number(row.revision),
      payload: payload,
      provenance: provenance,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      expiresAt: expiresAt,
      expiredAt: row.expired_at == null ? (expiredByTime ? expiresAt : null) : Number(row.expired_at),
      supersedes: row.supersedes_id == null ? null : String(row.supersedes_id),
      supersededBy: row.superseded_by == null ? null : String(row.superseded_by),
      supersededAt: row.superseded_at == null ? null : Number(row.superseded_at),
      retractedAt: row.retracted_at == null ? null : Number(row.retracted_at),
      retractionReason: row.retraction_reason == null ? null : String(row.retraction_reason),
      effectiveStatus: expired ? 'expired' : String(row.status)
    };
  }

  function begin() {
    if (!opened || !db) throw Object.assign(new Error('agent-memory-store-unavailable'), { code: 'STORE_UNAVAILABLE' });
    db.exec('BEGIN IMMEDIATE');
  }

  function transaction(work) {
    begin();
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* keep original failure */ }
      throw error;
    }
  }

  function validReference(value, optional) {
    if (optional && (value == null || value === '')) return true;
    return typeof value === 'string' && REF_RE.test(value);
  }

  function text(value, max, nonEmpty) {
    return typeof value === 'string' && value.length <= max && (!nonEmpty || !!value.trim());
  }

  function containsSensitivePattern(value) {
    const source = String(value || '');
    return /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i.test(source)
      || /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(source)
      || /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i.test(source)
      || /\b[A-Z0-9_]*(?:API[_-]?(?:KEY|TOKEN)|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|SECRET|PRIVATE[_-]?KEY)\b\s*[:=]\s*[^\s,;]{6,}/i.test(source);
  }

  function validatePayload(memoryType, payload) {
    if (MEMORY_TYPES.indexOf(memoryType) < 0 || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    let valid = false;
    if (memoryType === 'Project') {
      valid = exactKeys(payload, ['name'], ['summary']) && text(payload.name, 160, true)
        && (payload.summary == null || text(payload.summary, 1500, true));
    } else if (memoryType === 'Decision') {
      valid = exactKeys(payload, ['statement'], ['rationale']) && text(payload.statement, 1600, true)
        && (payload.rationale == null || text(payload.rationale, 2400, true));
    } else if (memoryType === 'Fact') {
      valid = exactKeys(payload, ['statement'], ['confidence', 'observedAt']) && text(payload.statement, 2400, true)
        && (payload.confidence == null || ['low', 'medium', 'high'].indexOf(payload.confidence) >= 0)
        && (payload.observedAt == null || (Number.isSafeInteger(payload.observedAt) && payload.observedAt >= 0));
    } else if (memoryType === 'Observation') {
      valid = exactKeys(payload, ['statement'], ['observedAt', 'contextRef']) && text(payload.statement, 2400, true)
        && (payload.observedAt == null || (Number.isSafeInteger(payload.observedAt) && payload.observedAt >= 0))
        && (payload.contextRef == null || validReference(payload.contextRef, false));
    } else if (memoryType === 'Procedure') {
      valid = exactKeys(payload, ['name', 'steps'], ['whenToUse']) && text(payload.name, 160, true)
        && Array.isArray(payload.steps) && payload.steps.length > 0 && payload.steps.length <= 30
        && payload.steps.every(step => text(step, 500, true))
        && (payload.whenToUse == null || text(payload.whenToUse, 600, true));
    }
    if (!valid) return null;
    let serialized;
    try { serialized = JSON.stringify(payload); } catch (_) { return null; }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES || containsSensitivePattern(serialized)) return null;
    return serialized;
  }

  function validateProvenance(value) {
    if (!exactKeys(value, ['sourceKind'], ['sourceRef', 'sourceRevision', 'selectionRef', 'sourceRunId'])
      || SOURCE_KINDS.indexOf(value.sourceKind) < 0
      || (value.sourceRef != null && !validReference(value.sourceRef, false))
      || (value.sourceRevision != null && !validReference(String(value.sourceRevision), false))
      || (value.selectionRef != null && (value.sourceKind !== 'work_result_ref' || !validReference(value.selectionRef, false)))
      || (value.sourceRunId != null && (value.sourceKind !== 'work_result_ref'
        || typeof value.sourceRunId !== 'string' || !WORK_RUN_ID_RE.test(value.sourceRunId)))) return null;
    return {
      sourceKind: value.sourceKind,
      sourceRef: value.sourceRef == null ? null : value.sourceRef,
      sourceRevision: value.sourceRevision == null ? null : String(value.sourceRevision),
      ...(value.selectionRef == null ? {} : { selectionRef: value.selectionRef }),
      ...(value.sourceRunId == null ? {} : { sourceRunId: value.sourceRunId }),
      recordedAt: clock()
    };
  }

  function validateCreateInput(input) {
    if (!exactKeys(input, ['type', 'payload', 'provenance'], ['projectRef', 'expiresAt'])
      || MEMORY_TYPES.indexOf(input.type) < 0 || !validReference(input.projectRef, true)) return null;
    if (input.type === 'Project' && !validReference(input.projectRef, false)) return null;
    let expiresAt = null;
    if (input.type === 'Observation') {
      expiresAt = input.expiresAt == null ? clock() + DEFAULT_OBSERVATION_EXPIRY_MS : input.expiresAt;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= clock()) return null;
    } else if (input.type !== 'Observation' && input.expiresAt != null) return null;
    const payloadJson = validatePayload(input.type, input.payload);
    const provenance = validateProvenance(input.provenance);
    if (!payloadJson || !provenance) return null;
    return {
      type: input.type,
      projectRef: input.projectRef == null || input.projectRef === '' ? '' : input.projectRef,
      expiresAt: expiresAt,
      payloadJson: payloadJson,
      provenance: [provenance]
    };
  }

  function validateStoredProvenance(history) {
    if (!Array.isArray(history) || history.length < 1 || history.length > 10000) return false;
    return history.every(entry => exactKeys(entry, ['sourceKind', 'recordedAt'], ['sourceRef', 'sourceRevision', 'selectionRef', 'sourceRunId'])
      && SOURCE_KINDS.indexOf(entry.sourceKind) >= 0
      && Number.isSafeInteger(entry.recordedAt) && entry.recordedAt >= 0
      && (entry.sourceRef == null || validReference(entry.sourceRef, false))
      && (entry.sourceRevision == null || validReference(String(entry.sourceRevision), false))
      && (entry.selectionRef == null || (entry.sourceKind === 'work_result_ref' && validReference(entry.selectionRef, false)))
      && (entry.sourceRunId == null || (entry.sourceKind === 'work_result_ref'
        && typeof entry.sourceRunId === 'string' && WORK_RUN_ID_RE.test(entry.sourceRunId))));
  }

  function inspectSnapshotFile(file) {
    const resolved = path.resolve(file);
    let stat;
    try { stat = fs.lstatSync(resolved); } catch (_) { return storeError('BACKUP_NOT_FOUND'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 512 || stat.size > MAX_BACKUP_BYTES) {
      return storeError('BACKUP_INVALID');
    }
    let connection = null;
    try {
      const sqlite = deps.sqlite || loadSqlite();
      connection = new sqlite.DatabaseSync(resolved, { readOnly: true });
      connection.exec('PRAGMA query_only = ON');
      const quick = connection.prepare('PRAGMA quick_check').get();
      if (!quick || String(quick.quick_check || '').toLowerCase() !== 'ok') return storeError('BACKUP_INTEGRITY_FAILED');
      const metaTable = connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='agent_memory_meta'").get();
      if (!metaTable) return storeError('BACKUP_DOMAIN_MISMATCH');
      const meta = connection.prepare('SELECT key, value FROM agent_memory_meta').all();
      const metaValues = Object.create(null);
      meta.forEach(row => { metaValues[String(row.key)] = String(row.value); });
      const version = Number(metaValues.schema_version);
      if (version > SCHEMA_VERSION) return storeError('BACKUP_SCHEMA_FUTURE');
      if (version !== 1 && version !== 2) return storeError('BACKUP_SCHEMA_VERSION_INVALID');
      const tableNames = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all().map(row => String(row.name)).sort();
      if (JSON.stringify(tableNames) !== JSON.stringify(['agent_memory_meta', 'agent_memory_records'])) {
        return storeError('BACKUP_DOMAIN_MISMATCH');
      }
      const executableObjects = connection.prepare("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view') AND name NOT LIKE 'sqlite_%'").all();
      if (executableObjects.length) return storeError('BACKUP_DOMAIN_MISMATCH');
      const columns = connection.prepare('PRAGMA table_info(agent_memory_records)').all().map(row => String(row.name)).sort();
      const v1Columns = ['created_at', 'memory_type', 'payload_json', 'project_ref', 'provenance_json', 'record_id',
        'retracted_at', 'retraction_reason', 'revision', 'status', 'superseded_at', 'superseded_by', 'terminal_at', 'updated_at'].sort();
      const v2Columns = v1Columns.concat(['expired_at', 'expires_at', 'supersedes_id']).sort();
      if (JSON.stringify(columns) !== JSON.stringify(version === 1 ? v1Columns : v2Columns)) return storeError('BACKUP_SCHEMA_COLUMNS_INVALID');
      const foreignErrors = connection.prepare('PRAGMA foreign_key_check').all();
      if (foreignErrors.length) return storeError('BACKUP_INTEGRITY_FAILED');
      const foreignKeyFrom = new Set(connection.prepare('PRAGMA foreign_key_list(agent_memory_records)').all().map(row => String(row.from)));
      if (!foreignKeyFrom.has('superseded_by') || (version === 2 && !foreignKeyFrom.has('supersedes_id'))) {
        return storeError('BACKUP_SCHEMA_COLUMNS_INVALID');
      }
      const rows = connection.prepare('SELECT * FROM agent_memory_records ORDER BY record_id').all();
      const ids = new Set(rows.map(row => String(row.record_id)));
      for (const row of rows) {
        const id = String(row.record_id || ''), type = String(row.memory_type || ''), status = String(row.status || '');
        const revision = Number(row.revision), createdAt = Number(row.created_at), updatedAt = Number(row.updated_at);
        const projectRef = String(row.project_ref || '');
        if (!RECORD_ID_RE.test(id) || MEMORY_TYPES.indexOf(type) < 0 || STORED_STATUSES.indexOf(status) < 0
          || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(createdAt) || createdAt < 0
          || !Number.isSafeInteger(updatedAt) || updatedAt < 0
          || (projectRef !== '' && !validReference(projectRef, false)) || (type === 'Project' && !projectRef)) {
          return storeError('BACKUP_RECORD_INVALID');
        }
        let provenance, payload = null;
        try { provenance = JSON.parse(String(row.provenance_json || '')); } catch (_) { return storeError('BACKUP_RECORD_INVALID'); }
        if (!validateStoredProvenance(provenance)) return storeError('BACKUP_RECORD_INVALID');
        if (row.payload_json != null) {
          try { payload = JSON.parse(String(row.payload_json)); } catch (_) { return storeError('BACKUP_RECORD_INVALID'); }
        }
        if (status === 'retracted') {
          if (row.payload_json != null || !row.terminal_at || !row.retraction_reason) return storeError('BACKUP_RECORD_INVALID');
        } else if (!validatePayload(type, payload)) return storeError('BACKUP_RECORD_INVALID');
        const expiresAt = version === 1 || row.expires_at == null ? null : Number(row.expires_at);
        const expiredAt = version === 1 || row.expired_at == null ? null : Number(row.expired_at);
        const supersedes = version === 1 || row.supersedes_id == null ? null : String(row.supersedes_id);
        if ((expiresAt != null && (type !== 'Observation' || !Number.isSafeInteger(expiresAt) || expiresAt < 0))
          || (expiredAt != null && (type !== 'Observation' || status !== 'retracted' || row.retraction_reason !== 'expired'))
          || (supersedes != null && !RECORD_ID_RE.test(supersedes))
          || (row.superseded_by != null && !RECORD_ID_RE.test(String(row.superseded_by)))) return storeError('BACKUP_RECORD_INVALID');
        if (row.superseded_by != null && !ids.has(String(row.superseded_by))) return storeError('BACKUP_RECORD_INVALID');
        if (supersedes != null && !ids.has(supersedes)) return storeError('BACKUP_RECORD_INVALID');
      }
      const storeRevision = metaValues.store_revision == null
        ? Number(rows.reduce((sum, row) => sum + Number(row.revision || 0), 0))
        : Number(metaValues.store_revision);
      if (version === SCHEMA_VERSION && metaValues.store_revision == null) return storeError('BACKUP_SCHEMA_REVISION_MISSING');
      if (!Number.isSafeInteger(storeRevision) || storeRevision < 0) return storeError('BACKUP_SCHEMA_REVISION_INVALID');
      return {
        ok: true,
        schemaVersion: version,
        storeRevision: storeRevision,
        recordCount: rows.length,
        bytes: stat.size,
        modifiedAt: Number(stat.mtimeMs)
      };
    } catch (_) { return storeError('BACKUP_INTEGRITY_FAILED'); }
    finally { if (connection) { try { connection.close(); } catch (_) { /* best effort */ } } }
  }

  function ensureBackupDirectory() {
    fs.mkdirSync(backupDir, { recursive: true });
    const stat = fs.lstatSync(backupDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('backup-directory-invalid'), { code: 'BACKUP_PATH_INVALID' });
  }

  function backupPath(backupId) {
    if (typeof backupId !== 'string' || !/^amb_[A-Za-z0-9-]{36}$/.test(backupId)) return null;
    return path.join(backupDir, backupId + '.db');
  }

  function validateExpectedRevision(value) {
    return Number.isSafeInteger(value) && value >= 1;
  }

  function readStoreRevision() {
    const row = db.prepare(SQL.readMeta).get('store_revision');
    return row ? Number(row.value) : 0;
  }

  function bumpStoreRevision() {
    const next = readStoreRevision() + 1;
    db.prepare(SQL.writeMeta).run('store_revision', String(next));
    return next;
  }

  function assertIndependentTarget() {
    const homeNodeFile = path.join(path.dirname(dbFile), 'home-node.db');
    for (const candidate of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
      let stat;
      try { stat = fs.lstatSync(candidate); } catch (error) { if (error && error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error('agent-memory-file-not-regular'), { code: 'AGENT_MEMORY_PATH_INVALID' });
    }
    try {
      const agentStat = fs.statSync(dbFile);
      const homeStat = fs.statSync(homeNodeFile);
      if (Number(agentStat.ino) > 0 && Number(homeStat.ino) > 0
        && agentStat.dev === homeStat.dev && agentStat.ino === homeStat.ino) {
        throw Object.assign(new Error('agent-memory-shares-chat-inode'), { code: 'AGENT_MEMORY_PATH_INVALID' });
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
  }

  function migrateConnection(connection, currentVersion) {
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 0 || currentVersion > SCHEMA_VERSION) {
      throw Object.assign(new Error('agent-memory-schema-version-invalid'), { code: 'SCHEMA_VERSION_INVALID' });
    }
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec(SQL.createRecords);
      if (currentVersion === 1) {
        const columns = new Set(connection.prepare('PRAGMA table_info(agent_memory_records)').all().map(row => String(row.name)));
        if (!columns.has('expires_at')) connection.exec('ALTER TABLE agent_memory_records ADD COLUMN expires_at INTEGER');
        if (!columns.has('expired_at')) connection.exec('ALTER TABLE agent_memory_records ADD COLUMN expired_at INTEGER');
        if (!columns.has('supersedes_id')) {
          connection.exec('ALTER TABLE agent_memory_records ADD COLUMN supersedes_id TEXT REFERENCES agent_memory_records(record_id) ON DELETE SET NULL');
        }
        const links = connection.prepare('SELECT record_id, superseded_by FROM agent_memory_records WHERE superseded_by IS NOT NULL').all();
        const setParent = connection.prepare('UPDATE agent_memory_records SET supersedes_id=? WHERE record_id=? AND supersedes_id IS NULL');
        for (const link of links) setParent.run(String(link.record_id), String(link.superseded_by));
        const baseline = Number(connection.prepare('SELECT COALESCE(SUM(revision), 0) AS revision FROM agent_memory_records').get().revision);
        connection.prepare(SQL.writeMeta).run('store_revision', String(baseline));
      } else if (currentVersion === 0) {
        connection.prepare(SQL.writeMeta).run('store_revision', '0');
      } else if (!connection.prepare(SQL.readMeta).get('store_revision')) {
        throw Object.assign(new Error('agent-memory-store-revision-missing'), { code: 'SCHEMA_VERSION_INVALID' });
      }
      connection.exec(SQL.createByScope);
      connection.exec(SQL.createByTerminal);
      connection.exec(SQL.createByExpiry);
      connection.prepare(SQL.writeMeta).run('schema_version', String(SCHEMA_VERSION));
      connection.exec('COMMIT');
      return { ok: true, from: currentVersion, to: SCHEMA_VERSION };
    } catch (error) {
      try { connection.exec('ROLLBACK'); } catch (_) { /* keep original */ }
      throw error;
    }
  }

  function open() {
    if (opened) return { ok: true, alreadyOpen: true, file: dbFile, schemaVersion: SCHEMA_VERSION };
    openFailure = null;
    let connection = null;
    try {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      assertIndependentTarget();
      const sqlite = deps.sqlite || loadSqlite();
      connection = new sqlite.DatabaseSync(dbFile);
      connection.exec('PRAGMA foreign_keys = ON');
      connection.exec('PRAGMA journal_mode = WAL');
      connection.exec('PRAGMA synchronous = FULL');
      connection.exec('PRAGMA busy_timeout = 3000');
      connection.exec(SQL.createMeta);
      const stored = connection.prepare(SQL.readMeta).get('schema_version');
      const current = stored ? Number(stored.value) : 0;
      migrateConnection(connection, current);
      db = connection;
      opened = true;
      logger('agent-memory-store-opened', { schemaVersion: SCHEMA_VERSION, file: path.basename(dbFile) });
      return { ok: true, alreadyOpen: false, file: dbFile, schemaVersion: SCHEMA_VERSION, storeRevision: readStoreRevision() };
    } catch (error) {
      openFailure = error && error.code === 'SCHEMA_VERSION_INVALID' ? 'schema-version-invalid' : 'store-open-failed';
      try { if (connection) connection.close(); } catch (_) { /* best effort */ }
      const failure = new Error('agent-memory-store-open-failed');
      failure.code = openFailure === 'schema-version-invalid' ? 'SCHEMA_VERSION_INVALID' : 'STORE_UNAVAILABLE';
      throw failure;
    }
  }

  function close() {
    if (!opened || !db) return { ok: true, alreadyClosed: true };
    try { db.close(); } catch (_) { /* best effort */ }
    db = null;
    opened = false;
    logger('agent-memory-store-closed', { schemaVersion: SCHEMA_VERSION });
    return { ok: true, alreadyClosed: false };
  }

  function getRecord(memoryId) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    if (typeof memoryId !== 'string' || !RECORD_ID_RE.test(memoryId)) return storeError('INVALID_MEMORY_ID');
    try {
      const record = readRow(memoryId);
      return record ? { ok: true, record: record } : storeError('MEMORY_NOT_FOUND');
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function createRecord(input) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    const normalized = validateCreateInput(input);
    if (!normalized) return storeError('INVALID_RECORD');
    try {
      return transaction(() => {
        const id = 'am_' + crypto.randomUUID();
        const at = clock();
        db.prepare(SQL.insertRecord).run(id, normalized.type, normalized.projectRef, 'active', 1, at, at,
          normalized.expiresAt, null, JSON.stringify(normalized.provenance), normalized.payloadJson);
        const storeRevision = bumpStoreRevision();
        return { ok: true, duplicate: false, record: readRow(id), storeRevision: storeRevision };
      });
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function createWorkResultObservation(input) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    if (!exactKeys(input, ['expectedStoreRevision', 'confirmed', 'projectRef', 'resultId',
      'resultSchemaVersion', 'selectionRef', 'statement'])
      || input.confirmed !== true
      || !Number.isSafeInteger(input.expectedStoreRevision) || input.expectedStoreRevision < 0
      || !validReference(input.projectRef, false) || !validReference(input.resultId, false)
      || !Number.isSafeInteger(input.resultSchemaVersion) || input.resultSchemaVersion < 1
      || !/^(summary|finding:[0-7])$/.test(String(input.selectionRef || ''))) {
      return storeError(input && input.confirmed !== true ? 'CONFIRMATION_REQUIRED' : 'INVALID_REQUEST');
    }
    const at = clock();
    const normalized = validateCreateInput({
      type: 'Observation',
      projectRef: input.projectRef,
      expiresAt: at + DEFAULT_OBSERVATION_EXPIRY_MS,
      payload: { statement: input.statement, observedAt: at, contextRef: 'wm:' + input.selectionRef },
      provenance: {
        sourceKind: 'work_result_ref', sourceRef: input.resultId,
        sourceRevision: String(input.resultSchemaVersion), selectionRef: input.selectionRef
      }
    });
    if (!normalized) return storeError('INVALID_RECORD');
    try {
      return transaction(() => {
        const rows = db.prepare('SELECT * FROM agent_memory_records WHERE memory_type=? AND project_ref=?')
          .all('Observation', input.projectRef);
        for (const row of rows) {
          let history = [];
          try { history = JSON.parse(String(row.provenance_json || '[]')); } catch (_) { continue; }
          const duplicateSource = history.some(entry => entry && entry.sourceKind === 'work_result_ref'
            && entry.sourceRef === input.resultId && entry.selectionRef === input.selectionRef);
          if (duplicateSource) {
            return { ok: true, duplicate: true, record: rowToRecord(row), storeRevision: readStoreRevision() };
          }
        }
        const currentRevision = readStoreRevision();
        if (currentRevision !== input.expectedStoreRevision) {
          return storeError('VERSION_CONFLICT', { storeRevision: currentRevision });
        }
        const id = 'am_' + crypto.randomUUID();
        db.prepare(SQL.insertRecord).run(id, normalized.type, normalized.projectRef, 'active', 1, at, at,
          normalized.expiresAt, null, JSON.stringify(normalized.provenance), normalized.payloadJson);
        return { ok: true, duplicate: false, record: readRow(id), storeRevision: bumpStoreRevision() };
      });
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function createWorkResultProcedure(input) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    const required = ['expectedStoreRevision', 'confirmed', 'projectRef', 'runId', 'resultId', 'resultSchemaVersion', 'payload'];
    if (!exactKeys(input, required) || input.confirmed !== true
      || !Number.isSafeInteger(input.expectedStoreRevision) || input.expectedStoreRevision < 0
      || !validReference(input.projectRef, false) || typeof input.runId !== 'string' || !WORK_RUN_ID_RE.test(input.runId)
      || !validReference(input.resultId, false)
      || !Number.isSafeInteger(input.resultSchemaVersion) || input.resultSchemaVersion < 1) {
      return storeError(input && input.confirmed !== true ? 'CONFIRMATION_REQUIRED' : 'INVALID_REQUEST');
    }
    if (!exactKeys(input.payload, ['name', 'steps', 'whenToUse'])) return storeError('INVALID_RECORD');
    const payload = { name: input.payload.name, steps: input.payload.steps };
    payload.whenToUse = input.payload.whenToUse;
    const payloadJson = validatePayload('Procedure', payload);
    if (!payloadJson) return storeError('INVALID_RECORD');
    const selectionRef = 'procedure:' + crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
    const normalized = validateCreateInput({
      type: 'Procedure', projectRef: input.projectRef, payload: payload,
      provenance: {
        sourceKind: 'work_result_ref', sourceRef: input.resultId,
        sourceRevision: String(input.resultSchemaVersion), sourceRunId: input.runId, selectionRef: selectionRef
      }
    });
    if (!normalized) return storeError('INVALID_RECORD');
    try {
      return transaction(() => {
        const rows = db.prepare('SELECT * FROM agent_memory_records WHERE memory_type=? AND project_ref=?')
          .all('Procedure', input.projectRef);
        for (const row of rows) {
          let history = [];
          try { history = JSON.parse(String(row.provenance_json || '[]')); } catch (_) { continue; }
          const duplicateSource = history.some(entry => entry && entry.sourceKind === 'work_result_ref'
            && entry.sourceRef === input.resultId && entry.sourceRunId === input.runId
            && entry.selectionRef === selectionRef);
          if (duplicateSource) return { ok: true, duplicate: true, record: rowToRecord(row), storeRevision: readStoreRevision() };
        }
        const currentRevision = readStoreRevision();
        if (currentRevision !== input.expectedStoreRevision) {
          return storeError('VERSION_CONFLICT', { storeRevision: currentRevision });
        }
        const id = 'am_' + crypto.randomUUID();
        const at = clock();
        db.prepare(SQL.insertRecord).run(id, normalized.type, normalized.projectRef, 'active', 1, at, at,
          normalized.expiresAt, null, JSON.stringify(normalized.provenance), normalized.payloadJson);
        return { ok: true, duplicate: false, record: readRow(id), storeRevision: bumpStoreRevision() };
      });
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function updateRecord(memoryId, input) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    if (typeof memoryId !== 'string' || !RECORD_ID_RE.test(memoryId)
      || !exactKeys(input, ['expectedRevision', 'payload', 'provenance'], ['expiresAt'])
      || !validateExpectedRevision(input.expectedRevision)) return storeError('INVALID_REQUEST');
    try {
      return transaction(() => {
        const current = readRow(memoryId);
        if (!current) return storeError('MEMORY_NOT_FOUND');
        if (current.revision !== input.expectedRevision) return storeError('VERSION_CONFLICT', { record: current });
        if (current.status !== 'active') return storeError('MEMORY_NOT_ACTIVE', { record: current });
        let expiresAt = current.expiresAt;
        if (current.type !== 'Observation' && Object.prototype.hasOwnProperty.call(input, 'expiresAt') && input.expiresAt != null) {
          return storeError('INVALID_RECORD');
        }
        if (current.type === 'Observation' && Object.prototype.hasOwnProperty.call(input, 'expiresAt')) {
          expiresAt = input.expiresAt == null ? null : Number(input.expiresAt);
          if (expiresAt != null && (!Number.isSafeInteger(expiresAt) || expiresAt <= clock())) return storeError('INVALID_RECORD');
        }
        const payloadJson = validatePayload(current.type, input.payload);
        const provenanceEntry = validateProvenance(input.provenance);
        if (!payloadJson || !provenanceEntry) return storeError('INVALID_RECORD');
        const provenance = current.provenance.concat([provenanceEntry]);
        const revision = current.revision + 1;
        const updated = db.prepare(SQL.updateRecord).run(revision, clock(), expiresAt, JSON.stringify(provenance), payloadJson,
          memoryId, current.revision);
        if (Number(updated.changes) !== 1) return storeError('VERSION_CONFLICT', { record: readRow(memoryId) });
        return { ok: true, duplicate: false, record: readRow(memoryId), storeRevision: bumpStoreRevision() };
      });
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function supersedeRecord(memoryId, input) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    if (typeof memoryId !== 'string' || !RECORD_ID_RE.test(memoryId)
      || !exactKeys(input, ['expectedRevision', 'payload', 'provenance'], ['expiresAt'])
      || !validateExpectedRevision(input.expectedRevision)) return storeError('INVALID_REQUEST');
    try {
      return transaction(() => {
        const current = readRow(memoryId);
        if (!current) return storeError('MEMORY_NOT_FOUND');
        if (current.revision !== input.expectedRevision) return storeError('VERSION_CONFLICT', { record: current });
        if (current.status !== 'active') return storeError('MEMORY_NOT_ACTIVE', { record: current });
        let expiresAt = current.type === 'Observation' ? current.expiresAt : null;
        if (current.type === 'Observation' && Object.prototype.hasOwnProperty.call(input, 'expiresAt')) {
          expiresAt = input.expiresAt == null ? null : Number(input.expiresAt);
          if (expiresAt != null && (!Number.isSafeInteger(expiresAt) || expiresAt <= clock())) return storeError('INVALID_RECORD');
        } else if (current.type !== 'Observation' && Object.prototype.hasOwnProperty.call(input, 'expiresAt') && input.expiresAt != null) {
          return storeError('INVALID_RECORD');
        }
        const payloadJson = validatePayload(current.type, input.payload);
        const provenanceEntry = validateProvenance(input.provenance);
        if (!payloadJson || !provenanceEntry) return storeError('INVALID_RECORD');
        const replacementId = 'am_' + crypto.randomUUID();
        const at = clock();
        const newProvenance = current.provenance.concat([provenanceEntry]);
        const oldProvenance = current.provenance.concat([provenanceEntry]);
        db.prepare(SQL.insertRecord).run(replacementId, current.type, current.projectRef, 'active', 1, at, at,
          expiresAt, memoryId, JSON.stringify(newProvenance), payloadJson);
        const updated = db.prepare(SQL.supersedeRecord).run(current.revision + 1, at, at, replacementId, at,
          JSON.stringify(oldProvenance), memoryId, current.revision);
        if (Number(updated.changes) !== 1) return storeError('VERSION_CONFLICT', { record: readRow(memoryId) });
        return { ok: true, duplicate: false, previous: readRow(memoryId), record: readRow(replacementId),
          storeRevision: bumpStoreRevision() };
      });
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function retractRecord(memoryId, input) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    if (typeof memoryId !== 'string' || !RECORD_ID_RE.test(memoryId)
      || !exactKeys(input, ['expectedRevision', 'reasonCode', 'provenance'])
      || !validateExpectedRevision(input.expectedRevision)
      || RETRACTION_REASONS.indexOf(input.reasonCode) < 0) return storeError('INVALID_REQUEST');
    try {
      return transaction(() => {
        const current = readRow(memoryId);
        if (!current) return storeError('MEMORY_NOT_FOUND');
        if (current.revision !== input.expectedRevision) return storeError('VERSION_CONFLICT', { record: current });
        if (current.status !== 'active') return storeError('MEMORY_NOT_ACTIVE', { record: current });
        const provenanceEntry = validateProvenance(input.provenance);
        if (!provenanceEntry) return storeError('INVALID_RECORD');
        const provenance = current.provenance.concat([provenanceEntry]);
        const at = clock();
        const updated = db.prepare(SQL.retractRecord).run(current.revision + 1, at, at, at, input.reasonCode,
          JSON.stringify(provenance), memoryId, current.revision);
        if (Number(updated.changes) !== 1) return storeError('VERSION_CONFLICT', { record: readRow(memoryId) });
        return { ok: true, duplicate: false, record: readRow(memoryId), storeRevision: bumpStoreRevision() };
      });
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function queryRecords(query) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    query = query || {};
    if (!exactKeys(query, [], ['type', 'projectRef', 'status', 'limit', 'offset'])) return storeError('INVALID_QUERY');
    const type = query.type == null || query.type === '' ? null : String(query.type);
    const projectRef = query.projectRef == null || query.projectRef === '' ? null : String(query.projectRef);
    const status = query.status == null || query.status === '' ? 'active' : String(query.status);
    const limit = query.limit == null ? 50 : Number(query.limit);
    const offset = query.offset == null ? 0 : Number(query.offset);
    if ((type && MEMORY_TYPES.indexOf(type) < 0) || (projectRef && !validReference(projectRef, false))
      || (status !== 'all' && STATUSES.indexOf(status) < 0)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT
      || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_QUERY_OFFSET) return storeError('INVALID_QUERY');
    const clauses = [], params = [];
    if (type) { clauses.push('memory_type=?'); params.push(type); }
    if (projectRef) { clauses.push('project_ref=?'); params.push(projectRef); }
    if (status === 'active') {
      clauses.push("status='active' AND NOT (memory_type='Observation' AND expires_at IS NOT NULL AND expires_at<=? AND expired_at IS NULL)");
      params.push(clock());
    } else if (status === 'expired') {
      clauses.push("((status='active' AND memory_type='Observation' AND expires_at IS NOT NULL AND expires_at<=?) OR " +
        "(status='retracted' AND retraction_reason='expired'))");
      params.push(clock());
    } else if (status !== 'all') {
      clauses.push('status=?'); params.push(status);
      if (status === 'retracted') clauses.push("COALESCE(retraction_reason,'')<>'expired'");
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    try {
      const total = Number(db.prepare('SELECT COUNT(*) AS count FROM agent_memory_records' + where).get(...params).count);
      const rows = db.prepare('SELECT * FROM agent_memory_records' + where +
        ' ORDER BY updated_at DESC, record_id DESC LIMIT ? OFFSET ?').all(...params, limit + 1, offset);
      return {
        ok: true, storeRevision: readStoreRevision(),
        records: rows.slice(0, limit).map(rowToRecord),
        total: total,
        hasMore: offset + limit < total
      };
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function cleanupExpiredObservations(options) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    options = options || {};
    if (!exactKeys(options, [], ['limit'])) return storeError('INVALID_QUERY');
    const limit = options.limit == null ? MAX_QUERY_LIMIT : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) return storeError('INVALID_QUERY');
    const at = clock();
    try {
      return transaction(() => {
        const changed = db.prepare(SQL.expireObservations).run(at, at, at, at, at, limit);
        const expired = Number(changed.changes);
        return { ok: true, expired: expired, limit: limit, storeRevision: expired ? bumpStoreRevision() : readStoreRevision() };
      });
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function purgeTombstones(options) {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    options = options || {};
    if (!exactKeys(options, [], ['limit'])) return storeError('INVALID_QUERY');
    const limit = options.limit == null ? MAX_QUERY_LIMIT : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_QUERY_LIMIT) return storeError('INVALID_QUERY');
    const cutoff = clock() - MAX_TERMINAL_RETENTION_MS;
    try {
      return transaction(() => {
        const before = Number(db.prepare('SELECT COUNT(*) AS count FROM agent_memory_records ' +
          'WHERE status IN (\'superseded\', \'retracted\') AND terminal_at<=?').get(cutoff).count);
        db.prepare(SQL.purgeTerminal).run(cutoff, limit);
        const after = Number(db.prepare('SELECT COUNT(*) AS count FROM agent_memory_records ' +
          'WHERE status IN (\'superseded\', \'retracted\') AND terminal_at<=?').get(cutoff).count);
        const purged = before - after;
        return { ok: true, purged: purged, limit: limit, activePreserved: true,
          storeRevision: purged ? bumpStoreRevision() : readStoreRevision() };
      });
    } catch (_) { return storeError('STORE_UNAVAILABLE'); }
  }

  function backupMetadata(backupId, file, info) {
    return {
      backupId: backupId,
      fileName: backupId + '.db',
      bytes: info.bytes,
      createdAt: info.modifiedAt,
      schemaVersion: info.schemaVersion,
      storeRevision: info.storeRevision,
      recordCount: info.recordCount
    };
  }

  async function createBackupFromFile(sourceFile) {
    try {
      ensureBackupDirectory();
      const existing = fs.readdirSync(backupDir).filter(name => /^amb_[A-Za-z0-9-]{36}\.db$/.test(name));
      if (existing.length >= MAX_BACKUP_COUNT) return storeError('BACKUP_LIMIT');
      const backupId = 'amb_' + crypto.randomUUID();
      const target = backupPath(backupId);
      const made = await createSqliteBackup(sourceFile, target);
      const info = inspectSnapshotFile(target);
      if (!info.ok) {
        safeRemoveFile(target);
        return info;
      }
      return { ok: true, backup: backupMetadata(backupId, target, info), method: made.method || 'sqlite-online-backup' };
    } catch (_) { return storeError('BACKUP_FAILED'); }
  }

  async function createBackup() {
    if (!opened) return storeError('STORE_UNAVAILABLE');
    return await createBackupFromFile(dbFile);
  }

  function listBackups(options) {
    options = options || {};
    if (!exactKeys(options, [], ['limit'])) return storeError('INVALID_QUERY');
    const limit = options.limit == null ? 50 : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BACKUP_COUNT) return storeError('INVALID_QUERY');
    try {
      if (!fs.existsSync(backupDir)) return { ok: true, backups: [], hasMore: false };
      ensureBackupDirectory();
      const candidates = fs.readdirSync(backupDir).filter(name => /^amb_[A-Za-z0-9-]{36}\.db$/.test(name))
        .map(name => ({ id: name.slice(0, -3), file: path.join(backupDir, name) }))
        .filter(item => {
          try { const stat = fs.lstatSync(item.file); return stat.isFile() && !stat.isSymbolicLink(); }
          catch (_) { return false; }
        })
        .sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs || a.id.localeCompare(b.id));
      const page = candidates.slice(0, limit + 1);
      const backups = page.slice(0, limit).map(item => {
        const info = inspectSnapshotFile(item.file);
        if (!info.ok) return { backupId: item.id, valid: false, error: info.code };
        return Object.assign({ valid: true }, backupMetadata(item.id, item.file, info));
      });
      return { ok: true, backups: backups, hasMore: candidates.length > limit };
    } catch (_) { return storeError('BACKUP_LIST_FAILED'); }
  }

  function exportBackup(backupId) {
    const file = backupPath(backupId);
    if (!file) return storeError('INVALID_BACKUP_ID');
    const info = inspectSnapshotFile(file);
    if (!info.ok) return info;
    try {
      const data = fs.readFileSync(file);
      return { ok: true, backup: backupMetadata(backupId, file, info), data: data };
    } catch (_) { return storeError('BACKUP_READ_FAILED'); }
  }

  function deleteBackup(backupId) {
    const file = backupPath(backupId);
    if (!file) return storeError('INVALID_BACKUP_ID');
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return storeError('BACKUP_INVALID');
      fs.unlinkSync(file);
      return { ok: true, backupId: backupId, deleted: true };
    } catch (error) { return error && error.code === 'ENOENT' ? storeError('BACKUP_NOT_FOUND') : storeError('BACKUP_DELETE_FAILED'); }
  }

  function cleanupBackups(options) {
    options = options || {};
    if (!exactKeys(options, [], ['limit'])) return storeError('INVALID_QUERY');
    const limit = options.limit == null ? MAX_BACKUP_COUNT : Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BACKUP_COUNT) return storeError('INVALID_QUERY');
    try {
      if (!fs.existsSync(backupDir)) return { ok: true, deleted: 0, limit: limit, cleanupScheduled: false };
      ensureBackupDirectory();
      const cutoff = clock() - MAX_BACKUP_RETENTION_MS;
      const expired = fs.readdirSync(backupDir).filter(name => /^amb_[A-Za-z0-9-]{36}\.db$/.test(name))
        .map(name => ({ id: name.slice(0, -3), file: path.join(backupDir, name) }))
        .filter(item => {
          try {
            const stat = fs.lstatSync(item.file);
            return stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs <= cutoff;
          } catch (_) { return false; }
        })
        .sort((a, b) => fs.statSync(a.file).mtimeMs - fs.statSync(b.file).mtimeMs || a.id.localeCompare(b.id))
        .slice(0, limit);
      expired.forEach(item => fs.unlinkSync(item.file));
      return { ok: true, deleted: expired.length, limit: limit, cleanupScheduled: false };
    } catch (_) { return storeError('BACKUP_CLEANUP_FAILED'); }
  }

  function migrateSnapshotFile(file) {
    let connection = null;
    try {
      const initial = inspectSnapshotFile(file);
      if (!initial.ok) return initial;
      if (initial.schemaVersion === SCHEMA_VERSION) return initial;
      const sqlite = deps.sqlite || loadSqlite();
      connection = new sqlite.DatabaseSync(file);
      connection.exec('PRAGMA foreign_keys = ON');
      connection.exec('PRAGMA busy_timeout = 3000');
      const stored = connection.prepare(SQL.readMeta).get('schema_version');
      const version = stored ? Number(stored.value) : 0;
      if (version !== initial.schemaVersion) return storeError('BACKUP_SCHEMA_UNSUPPORTED');
      migrateConnection(connection, version);
      connection.close();
      connection = null;
      return inspectSnapshotFile(file);
    } catch (_) { return storeError('BACKUP_MIGRATION_FAILED'); }
    finally { if (connection) { try { connection.close(); } catch (_) { /* best effort */ } } }
  }

  function safeRemoveFile(file) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(file);
    } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  }

  function restoreRequest(input, openedState) {
    if (!exactKeys(input, ['expectedStoreRevision', 'confirmed']) || input.confirmed !== true) return null;
    if (openedState) {
      return Number.isSafeInteger(input.expectedStoreRevision) && input.expectedStoreRevision >= 0
        ? input.expectedStoreRevision : null;
    }
    return input.expectedStoreRevision === null ? null : undefined;
  }

  async function restoreFromFile(sourceFile, input) {
    const sourceInfo = inspectSnapshotFile(sourceFile);
    if (!sourceInfo.ok) return sourceInfo;
    const expectedStoreRevision = restoreRequest(input, opened);
    if (expectedStoreRevision === null && opened) return storeError('INVALID_REQUEST');
    if (expectedStoreRevision === undefined) return storeError('INVALID_REQUEST');
    if (opened && readStoreRevision() !== expectedStoreRevision) {
      return storeError('VERSION_CONFLICT', { storeRevision: readStoreRevision() });
    }

    const stage = dbFile + '.restore-' + crypto.randomUUID() + '.staging';
    const rollbackFile = dbFile + '.rollback-' + crypto.randomUUID();
    const rollbackWal = rollbackFile + '-wal';
    const rollbackShm = rollbackFile + '-shm';
    let movedLiveFile = false, movedWal = false, movedShm = false, installedStage = false, rollbackBackupId = null;
    const previousWasOpen = opened;
    let previousStoreRevision = expectedStoreRevision;
    try {
      fs.copyFileSync(sourceFile, stage, fs.constants.COPYFILE_EXCL);
      const candidate = migrateSnapshotFile(stage);
      if (!candidate.ok) return candidate;
      if (fs.existsSync(dbFile)) {
        const currentFileInfo = inspectSnapshotFile(dbFile);
        if (currentFileInfo.ok) {
          const rollback = await createBackupFromFile(dbFile);
          if (!rollback.ok) return storeError('RESTORE_PREPARATION_FAILED', { cause: rollback.code || 'backup-failed' });
          rollbackBackupId = rollback.backup.backupId;
        } else if (opened) {
          return storeError('RESTORE_PREPARATION_FAILED', { cause: currentFileInfo.code || 'backup-failed' });
        } else if (currentFileInfo.code === 'BACKUP_SCHEMA_FUTURE') {
          return storeError('CURRENT_SCHEMA_FUTURE');
        }
        if (opened && readStoreRevision() !== expectedStoreRevision) {
          return storeError('VERSION_CONFLICT', { storeRevision: readStoreRevision(), rollbackBackupId: rollbackBackupId });
        }
        if (opened) previousStoreRevision = readStoreRevision();
      }

      if (opened) close();
      assertIndependentTarget();
      if (fs.existsSync(dbFile + '-wal')) { renameFile(dbFile + '-wal', rollbackWal); movedWal = true; }
      if (fs.existsSync(dbFile + '-shm')) { renameFile(dbFile + '-shm', rollbackShm); movedShm = true; }
      if (fs.existsSync(dbFile)) { renameFile(dbFile, rollbackFile); movedLiveFile = true; }
      renameFile(stage, dbFile);
      installedStage = true;
      open();
      const restoredValidation = inspectSnapshotFile(dbFile);
      if (!restoredValidation.ok) throw new Error('restored-agent-memory-invalid');
      const restoredStoreRevision = Math.max(Number(previousStoreRevision || 0), candidate.storeRevision) + 1;
      transaction(() => { db.prepare(SQL.writeMeta).run('store_revision', String(restoredStoreRevision)); });
      if (movedLiveFile) safeRemoveFile(rollbackFile);
      if (movedWal) safeRemoveFile(rollbackWal);
      if (movedShm) safeRemoveFile(rollbackShm);
      return {
        ok: true,
        restored: true,
        recordCount: restoredValidation.recordCount,
        schemaVersion: SCHEMA_VERSION,
        storeRevision: restoredStoreRevision,
        sourceStoreRevision: candidate.storeRevision,
        migratedFrom: sourceInfo.schemaVersion === SCHEMA_VERSION ? null : sourceInfo.schemaVersion,
        rollbackBackupId: rollbackBackupId
      };
    } catch (_) {
      if (opened) close();
      if (installedStage) {
        try { safeRemoveFile(dbFile); } catch (_) { /* rollback below decides availability */ }
        try { safeRemoveFile(dbFile + '-wal'); } catch (_) { }
        try { safeRemoveFile(dbFile + '-shm'); } catch (_) { }
      }
      try {
        if (movedLiveFile && fs.existsSync(rollbackFile)) renameFile(rollbackFile, dbFile);
        if (movedWal && fs.existsSync(rollbackWal)) renameFile(rollbackWal, dbFile + '-wal');
        if (movedShm && fs.existsSync(rollbackShm)) renameFile(rollbackShm, dbFile + '-shm');
        if (previousWasOpen && fs.existsSync(dbFile)) open();
        return storeError('RESTORE_FAILED', { rolledBack: fs.existsSync(dbFile), rollbackBackupId: rollbackBackupId });
      } catch (_) {
        return storeError('RESTORE_ROLLBACK_FAILED', { rolledBack: false, rollbackBackupId: rollbackBackupId });
      }
    } finally {
      try { safeRemoveFile(stage); } catch (_) { }
      try { safeRemoveFile(stage + '-wal'); } catch (_) { }
      try { safeRemoveFile(stage + '-shm'); } catch (_) { }
    }
  }

  async function restoreBackup(backupId, input) {
    const file = backupPath(backupId);
    if (!file) return storeError('INVALID_BACKUP_ID');
    const info = inspectSnapshotFile(file);
    if (!info.ok) return info;
    return await restoreFromFile(file, input);
  }

  async function restoreUpload(buffer, input) {
    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) return storeError('INVALID_BACKUP');
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (bytes.length < 512 || bytes.length > MAX_BACKUP_BYTES) return storeError('INVALID_BACKUP');
    const sourceFile = path.join(path.dirname(dbFile), '.agent-memory-upload-' + crypto.randomUUID() + '.staging');
    try {
      fs.writeFileSync(sourceFile, bytes, { flag: 'wx' });
    } catch (_) { return storeError('RESTORE_UPLOAD_FAILED'); }
    try { return await restoreFromFile(sourceFile, input); }
    finally { try { safeRemoveFile(sourceFile); } catch (_) { } }
  }

  function describe() {
    return { available: opened, file: DB_FILENAME, schemaVersion: opened ? SCHEMA_VERSION : null,
      storeRevision: opened ? readStoreRevision() : null,
      reason: opened ? null : openFailure || 'store-closed' };
  }

  return Object.freeze({
    open: open,
    close: close,
    isOpen: function () { return opened; },
    describe: describe,
    getRecord: getRecord,
    queryRecords: queryRecords,
    createRecord: createRecord,
    createWorkResultObservation: createWorkResultObservation,
    createWorkResultProcedure: createWorkResultProcedure,
    updateRecord: updateRecord,
    supersedeRecord: supersedeRecord,
    retractRecord: retractRecord,
    cleanupExpiredObservations: cleanupExpiredObservations,
    purgeTombstones: purgeTombstones,
    createBackup: createBackup,
    listBackups: listBackups,
    exportBackup: exportBackup,
    deleteBackup: deleteBackup,
    cleanupBackups: cleanupBackups,
    restoreBackup: restoreBackup,
    restoreUpload: restoreUpload,
    file: dbFile,
    currentStoreRevision: function () { return opened ? { ok: true, storeRevision: readStoreRevision() } : storeError('STORE_UNAVAILABLE'); },
    retentionPolicy: function () {
      return { activeAutoExpiry: false, observationEffectiveExpiry: true, observationCleanupScheduled: false,
        observationDefaultExpiryMs: DEFAULT_OBSERVATION_EXPIRY_MS,
        workResultObservationDefaultExpiryMs: DEFAULT_OBSERVATION_EXPIRY_MS,
        terminalRetentionMs: MAX_TERMINAL_RETENTION_MS, cleanupScheduled: false,
        backupRetentionMs: MAX_BACKUP_RETENTION_MS, backupCleanupScheduled: false,
        backupMaxCount: MAX_BACKUP_COUNT, backupMaxBytes: MAX_BACKUP_BYTES,
        retractionClearsPayload: true, physicalDeleteRequiresExplicitCleanup: true,
        encryptedAtRest: false };
    }
  });
}

module.exports = createAgentMemoryStore;
module.exports.AGENT_MEMORY_TYPES = MEMORY_TYPES;
module.exports.AGENT_MEMORY_STATUSES = STATUSES;
module.exports.AGENT_MEMORY_RETENTION_MS = MAX_TERMINAL_RETENTION_MS;
module.exports.AGENT_MEMORY_DB_FILENAME = DB_FILENAME;
