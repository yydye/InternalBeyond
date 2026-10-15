'use strict';

/* Home Node · Work Mode Authority (Phases 1, 3A and 3B.3)
   Owns durable run state, explicit egress consent, reviewed result artifacts,
   and their bounded retention metadata. Prompts, source, credentials, tool
   arguments, full model output, and Agent Memory plaintext remain outside this schema. */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const workModeExecutor = require('../../assets/js/work-mode-executor.js');

const DB_FILENAME = 'home-node.db';
const SCHEMA_VERSION = 10;
const META_SCHEMA = 'work_runs_schema_version';
const WORKFLOW_ID = 'project.audit.readonly';
const APP_BUILDER_WORKFLOW_ID = 'app.builder';
const CODING_WORKFLOW_ID = 'coding.workspace';
const APP_DRAFT_REF_RE = /^ad_[A-Fa-f0-9-]{36}$/;
const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  CANCEL_REQUESTED: 'cancel_requested',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});
const TERMINAL = Object.freeze([STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED]);
const MAX_EVENTS_PAGE = 100;
const MAX_ACTIVE_RUNS_PAGE = 100;
const MAX_RESULTS_PAGE = 100;
const MAX_CONSENT_FILES = 200;
const MAX_CLEANUP_BATCH = 100;
const MAX_CONSENT_TTL_MS = 60 * 60 * 1000;
const RESULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const RUN_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const RESULT_SCHEMA_VERSION = 1;
const CONSENT_TERMS_VERSION = 'work-mode-egress-result-memory-derived-coding-v6';
const RESULT_STORAGE = 'plaintext_home_node_sqlite';
const RESULT_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);
const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const ACTION_TRACE_REQUEST_ID_RE = /^(?:wm_[A-Fa-f0-9-]{32,36}|dsh_read_[A-Fa-f0-9-]{36})$/;
const ACTION_ID_RE = /^ib(?:\.[a-z0-9_-]+)+\.v[0-9]+$/;
const PROJECT_REF_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const RUN_ID_RE = /^wr_[A-Za-z0-9-]{36}$/;
const RESULT_ID_RE = /^wrres_[A-Za-z0-9_-]{1,180}$/;
const DSH_SESSION_ID_RE = /^session-[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-8][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12}$/;
const REASON_CODES = Object.freeze([
  'runtime_started',
  'runtime_completed',
  'runtime_failed',
  'runtime_cancelled',
  'user_cancelled',
  'runtime_interrupted'
]);
const ACTION_TRACE_STATUSES = Object.freeze(['succeeded', 'failed', 'denied']);
const ACTION_TRACE_AUTHORITY_RESULTS = Object.freeze(['allowed', 'denied', 'not_checked']);

function isSupportedWorkflow(value) { return value === WORKFLOW_ID || value === APP_BUILDER_WORKFLOW_ID || value === CODING_WORKFLOW_ID; }

const SQL = Object.freeze({
  createMeta: 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  readMeta: 'SELECT value FROM meta WHERE key=?',
  writeMeta: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  createRuns: 'CREATE TABLE IF NOT EXISTS work_runs (' +
    'run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, project_ref TEXT NOT NULL, ' +
    'status TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ' +
    'executor_selection_json TEXT, app_draft_ref TEXT)',
  createRunEvents: 'CREATE TABLE IF NOT EXISTS work_run_events (' +
    'run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL, ' +
    'from_status TEXT, to_status TEXT NOT NULL, version INTEGER NOT NULL, ' +
    'reason_code TEXT, created_at INTEGER NOT NULL, action_trace_json TEXT, PRIMARY KEY (run_id, sequence), ' +
    'FOREIGN KEY (run_id) REFERENCES work_runs(run_id))',
  createIdempotency: 'CREATE TABLE IF NOT EXISTS work_run_idempotency (' +
    'request_key_hash TEXT PRIMARY KEY, request_hash TEXT NOT NULL, operation TEXT NOT NULL, ' +
    'run_id TEXT NOT NULL, result_version INTEGER NOT NULL, result_status TEXT NOT NULL, ' +
    'created_at INTEGER NOT NULL, FOREIGN KEY (run_id) REFERENCES work_runs(run_id))',
  createResults: 'CREATE TABLE IF NOT EXISTS work_run_results (' +
    'result_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL, ' +
    'status TEXT NOT NULL, report_json TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ' +
    'expired_at INTEGER, deleted_at INTEGER, memory_derived INTEGER NOT NULL DEFAULT 0, memory_context_hash TEXT, ' +
    'FOREIGN KEY (run_id) REFERENCES work_runs(run_id))',
  createConsents: 'CREATE TABLE IF NOT EXISTS work_run_consents (' +
    'consent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_ref TEXT NOT NULL, ' +
    'provider_scopes_json TEXT NOT NULL, file_ids_json TEXT NOT NULL, workspace_write_confirmed INTEGER NOT NULL DEFAULT 0, memory_scope_json TEXT NOT NULL DEFAULT \'null\', ' +
    'memory_derived_scope_json TEXT NOT NULL DEFAULT \'null\', ' +
    'terms_version TEXT NOT NULL, ' +
    'grant_request_key_hash TEXT NOT NULL UNIQUE, grant_request_hash TEXT NOT NULL, ' +
    'confirmation_method TEXT NOT NULL, confirmed_at INTEGER NOT NULL, ' +
    'issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER, revocation_reason TEXT, ' +
    'FOREIGN KEY (run_id) REFERENCES work_runs(run_id))',
  createDshSessions: 'CREATE TABLE IF NOT EXISTS work_run_dsh_sessions (' +
    'run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, consent_id TEXT, bound_at INTEGER NOT NULL, ' +
    'FOREIGN KEY (run_id) REFERENCES work_runs(run_id) ON DELETE CASCADE)',
  readDshSessionByRun: 'SELECT run_id, session_id, consent_id, bound_at FROM work_run_dsh_sessions WHERE run_id=?',
  readDshSessionById: 'SELECT run_id, session_id, consent_id, bound_at FROM work_run_dsh_sessions WHERE session_id=? ORDER BY bound_at DESC, run_id DESC LIMIT 1',
  readDshSessionsById: 'SELECT run_id, session_id, consent_id, bound_at FROM work_run_dsh_sessions WHERE session_id=? ORDER BY bound_at DESC, run_id DESC LIMIT 32',
  readDshSessionByIdAndRun: 'SELECT run_id, session_id, consent_id, bound_at FROM work_run_dsh_sessions WHERE session_id=? AND run_id=?',
  readAppDraftForDshSession: 'SELECT r.app_draft_ref FROM work_run_dsh_sessions s JOIN work_runs r ON r.run_id=s.run_id ' +
    'WHERE s.session_id=? AND r.workflow_id=? ORDER BY s.bound_at DESC, r.run_id DESC LIMIT 1',
  insertDshSession: 'INSERT INTO work_run_dsh_sessions (run_id, session_id, consent_id, bound_at) VALUES (?, ?, ?, ?)',
  createDshSessionLookupIndex: 'CREATE INDEX IF NOT EXISTS work_run_dsh_sessions_by_session ON work_run_dsh_sessions(session_id, bound_at DESC)',
  updateDshSessionConsent: 'UPDATE work_run_dsh_sessions SET consent_id=?, bound_at=? WHERE run_id=? AND session_id=?',
  backfillLegacyResults: 'INSERT OR IGNORE INTO work_run_results ' +
    '(result_id, run_id, schema_version, status, report_json, created_at, expires_at, expired_at, deleted_at) ' +
    "SELECT 'wrres_legacy_' || run_id, run_id, 1, 'legacy_unavailable', NULL, updated_at, updated_at, NULL, NULL " +
    'FROM work_runs WHERE status=?',
  readRun: 'SELECT run_id, workflow_id, project_ref, status, version, created_at, updated_at, executor_selection_json, app_draft_ref FROM work_runs WHERE run_id=?',
  listActive: 'SELECT run_id, workflow_id, project_ref, status, version, created_at, updated_at, executor_selection_json, app_draft_ref FROM work_runs WHERE status IN (?, ?, ?) ORDER BY updated_at ASC, run_id ASC LIMIT ?',
  listResults: 'SELECT r.run_id, r.workflow_id, r.project_ref, r.status AS run_status, r.version AS run_version, ' +
    'r.created_at AS run_created_at, r.updated_at AS run_updated_at, ' +
    'w.result_id, w.status AS result_status, w.created_at AS result_created_at, w.expires_at, w.expired_at, w.deleted_at, ' +
    'w.memory_derived, w.memory_context_hash, r.app_draft_ref ' +
    'FROM work_runs r JOIN work_run_results w ON w.run_id=r.run_id ' +
    'WHERE r.workflow_id IN (?, ?, ?) ORDER BY w.created_at DESC, r.run_id DESC LIMIT ?',
  insertRun: 'INSERT INTO work_runs (run_id, workflow_id, project_ref, status, version, created_at, updated_at, executor_selection_json, app_draft_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  pinExecutorSelection: 'UPDATE work_runs SET executor_selection_json=? WHERE run_id=? AND status=? AND executor_selection_json IS NULL',
  updateRun: 'UPDATE work_runs SET status=?, version=?, updated_at=? WHERE run_id=? AND version=?',
  nextEventSequence: 'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM work_run_events WHERE run_id=?',
  insertEvent: 'INSERT INTO work_run_events (run_id, sequence, event_type, from_status, to_status, version, reason_code, created_at, action_trace_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  listEvents: 'SELECT sequence, event_type, from_status, to_status, version, reason_code, created_at, action_trace_json FROM work_run_events WHERE run_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?',
  readIdempotency: 'SELECT request_hash, operation, run_id, result_version, result_status FROM work_run_idempotency WHERE request_key_hash=?',
  insertIdempotency: 'INSERT INTO work_run_idempotency (request_key_hash, request_hash, operation, run_id, result_version, result_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  insertResult: 'INSERT INTO work_run_results (result_id, run_id, schema_version, status, report_json, created_at, expires_at, expired_at, deleted_at, memory_derived, memory_context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
  readResult: 'SELECT result_id, run_id, schema_version, status, report_json, created_at, expires_at, expired_at, deleted_at, memory_derived, memory_context_hash FROM work_run_results WHERE run_id=?',
  readConsent: 'SELECT consent_id, run_id, project_ref, provider_scopes_json, file_ids_json, workspace_write_confirmed, memory_scope_json, memory_derived_scope_json, terms_version, confirmation_method, confirmed_at, issued_at, expires_at, revoked_at, revocation_reason FROM work_run_consents WHERE consent_id=? AND run_id=?',
  latestConsentByRun: 'SELECT consent_id FROM work_run_consents WHERE run_id=? ORDER BY issued_at DESC, rowid DESC LIMIT 1',
  readConsentByGrantKey: 'SELECT consent_id, run_id, project_ref, provider_scopes_json, file_ids_json, workspace_write_confirmed, memory_scope_json, memory_derived_scope_json, terms_version, confirmation_method, confirmed_at, issued_at, expires_at, revoked_at, revocation_reason FROM work_run_consents WHERE grant_request_key_hash=?',
  readActiveConsent: 'SELECT consent_id FROM work_run_consents WHERE run_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1',
  insertConsent: 'INSERT INTO work_run_consents (consent_id, run_id, project_ref, provider_scopes_json, file_ids_json, workspace_write_confirmed, memory_scope_json, memory_derived_scope_json, terms_version, grant_request_key_hash, grant_request_hash, confirmation_method, confirmed_at, issued_at, expires_at, revoked_at, revocation_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
  revokeConsent: 'UPDATE work_run_consents SET revoked_at=?, revocation_reason=? WHERE consent_id=? AND run_id=? AND revoked_at IS NULL',
  revokeRunConsents: 'UPDATE work_run_consents SET revoked_at=?, revocation_reason=? WHERE run_id=? AND revoked_at IS NULL',
  listExpiredResults: 'SELECT run_id FROM work_run_results WHERE status=? AND expires_at<=? ORDER BY expires_at ASC, run_id ASC LIMIT ?',
  expireResult: 'UPDATE work_run_results SET status=?, report_json=NULL, expired_at=? WHERE run_id=? AND status=?',
  deleteResult: 'UPDATE work_run_results SET status=?, report_json=NULL, deleted_at=? WHERE run_id=? AND status=?',
  listPurgeRuns: 'SELECT run_id FROM work_runs WHERE status IN (?, ?, ?) AND updated_at<=? ORDER BY updated_at ASC, run_id ASC LIMIT ?',
  deleteRunConsents: 'DELETE FROM work_run_consents WHERE run_id=?',
  deleteRunIdempotency: 'DELETE FROM work_run_idempotency WHERE run_id=?',
  deleteRunEvents: 'DELETE FROM work_run_events WHERE run_id=?',
  deleteRunResult: 'DELETE FROM work_run_results WHERE run_id=?',
  deleteRun: 'DELETE FROM work_runs WHERE run_id=?'
});

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const actual = Object.keys(value).sort();
  const expected = keys.slice().sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function createWorkRunStore(deps) {
  deps = deps || {};
  const dataDir = deps.dataDir || process.cwd();
  const dbFile = deps.dbFile || path.join(dataDir, DB_FILENAME);
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  let db = null;
  let opened = false;
  let openFailure = null;

  function loadSqlite() {
    try { return require('node:sqlite'); }
    catch (error) {
      const err = new Error('node:sqlite is unavailable in this runtime');
      err.code = 'SQLITE_UNAVAILABLE';
      throw err;
    }
  }

  function now() {
    const value = Number(clock());
    return isFinite(value) ? Math.trunc(value) : Date.now();
  }

  function hash(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function hasExactKeys(value, keys) {
    return isPlainObject(value)
      && Object.keys(value).length === keys.length
      && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
  }

  function validRunId(value) {
    return typeof value === 'string' && RUN_ID_RE.test(value);
  }

  function rowToRun(row) {
    if (!row) return null;
    let executorSelection = null;
    if (row.executor_selection_json != null) {
      try { executorSelection = workModeExecutor.normalizeSnapshot(JSON.parse(String(row.executor_selection_json))); }
      catch (_) { return null; }
      if (!executorSelection) return null;
    }
    const result = {
      runId: String(row.run_id),
      workflowId: String(row.workflow_id),
      projectRef: String(row.project_ref),
      status: String(row.status),
      version: Number(row.version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
    if (executorSelection) result.executorSelection = executorSelection;
    if (String(row.workflow_id) === APP_BUILDER_WORKFLOW_ID && typeof row.app_draft_ref === 'string') result.appDraftRef = row.app_draft_ref;
    return result;
  }

function normalizeFileIds(value, allowEmpty) {
  if (!Array.isArray(value) || value.length > MAX_CONSENT_FILES || (!allowEmpty && value.length === 0)) return null;
  const seen = new Set();
  const ids = [];
  for (const item of value) {
    if (typeof item !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(item) || seen.has(item)) return null;
    seen.add(item);
    ids.push(item);
  }
  return ids.sort();
}

function normalizeProviderScope(value) {
  if (!hasExactKeys(value, ['destination', 'providerRef', 'provider', 'model', 'routeHash'])) return null;
  if (value.destination !== 'agent' && value.destination !== 'middle_brain') return null;
  if (typeof value.providerRef !== 'string' || !REQUEST_ID_RE.test(value.providerRef)
    || typeof value.provider !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(value.provider)
    || typeof value.model !== 'string' || !/^[A-Za-z0-9_.:+/-]{1,120}$/.test(value.model)
    || typeof value.routeHash !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(value.routeHash)) return null;
  return {
    destination: value.destination,
    providerRef: value.providerRef,
    provider: value.provider,
    model: value.model,
    routeHash: value.routeHash.toLowerCase()
  };
}

function normalizeProviderScopes(value) {
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== 2)) return null;
  const scopes = value.map(normalizeProviderScope);
  if (scopes.some(scope => !scope)) return null;
  scopes.sort((a, b) => a.destination.localeCompare(b.destination));
  if (scopes.length === 1) return scopes[0].destination === 'agent' ? scopes : null;
  if (scopes[0].destination !== 'agent' || scopes[1].destination !== 'middle_brain') return null;
  return scopes;
}

function normalizeMemoryScope(value) {
  if (!hasExactKeys(value, ['projectRef', 'providerScope', 'refs', 'contextHash', 'contextChars'])) return null;
  const projectRef = String(value.projectRef || '');
  const providerScope = normalizeProviderScope(value.providerScope);
  if (!PROJECT_REF_RE.test(projectRef) || !providerScope || providerScope.destination !== 'agent'
    || !Array.isArray(value.refs) || !value.refs.length || value.refs.length > 12
    || typeof value.contextHash !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(value.contextHash)
    || !Number.isSafeInteger(value.contextChars) || value.contextChars < 1 || value.contextChars > 6000) return null;
  const seen = new Set(), refs = [];
  for (const item of value.refs) {
    if (!hasExactKeys(item, ['memoryId', 'revision', 'contentHash'])
      || typeof item.memoryId !== 'string' || !/^am_[A-Za-z0-9-]{36}$/.test(item.memoryId)
      || seen.has(item.memoryId) || !Number.isSafeInteger(item.revision) || item.revision < 1
      || typeof item.contentHash !== 'string' || !/^[A-Fa-f0-9]{64}$/.test(item.contentHash)) return null;
    seen.add(item.memoryId);
    refs.push({ memoryId: item.memoryId, revision: item.revision, contentHash: item.contentHash.toLowerCase() });
  }
  refs.sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  return {
    projectRef: projectRef,
    providerScope: providerScope,
    refs: refs,
    contextHash: value.contextHash.toLowerCase(),
    contextChars: value.contextChars
  };
}

function normalizeMemoryDerivedScope(value) {
  if (!hasExactKeys(value, ['projectRef', 'contextHash', 'review', 'result'])) return null;
  const projectRef = String(value.projectRef || '');
  if (!PROJECT_REF_RE.test(projectRef) || typeof value.contextHash !== 'string'
    || !/^[A-Fa-f0-9]{64}$/.test(value.contextHash)
    || !hasExactKeys(value.review, ['confirmed', 'providerScope']) || value.review.confirmed !== true
    || !hasExactKeys(value.result, ['confirmed', 'destination', 'schemaVersion', 'storage', 'retentionMs'])
    || value.result.confirmed !== true || value.result.destination !== 'work_result'
    || value.result.schemaVersion !== RESULT_SCHEMA_VERSION || value.result.storage !== RESULT_STORAGE
    || value.result.retentionMs !== RESULT_RETENTION_MS) return null;
  const reviewProviderScope = normalizeProviderScope(value.review.providerScope);
  if (!reviewProviderScope || reviewProviderScope.destination !== 'middle_brain') return null;
  return {
    projectRef: projectRef,
    contextHash: value.contextHash.toLowerCase(),
    review: { confirmed: true, providerScope: reviewProviderScope },
    result: {
      confirmed: true,
      destination: 'work_result',
      schemaVersion: RESULT_SCHEMA_VERSION,
      storage: RESULT_STORAGE,
      retentionMs: RESULT_RETENTION_MS
    }
  };
}

function sameJson(left, right) { return stableStringify(left) === stableStringify(right); }

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 400
    || value.charAt(0) === '/' || value.indexOf('\\') >= 0
    || /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    || /[\u0000-\u001F\u007F]/.test(value)) return false;
  return value.split('/').every(part => !!part && part !== '.' && part !== '..');
}

function sanitizeArtifactText(value, maxChars) {
  if (typeof value !== 'string' || value.length > maxChars) return null;
  let text = value.trim();
  if (!text || /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i.test(text)) return null;
  text = text.replace(/(\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|PASSWORD|SECRET|PRIVATE[_-]?KEY)\b\s*[:=]\s*)(["']?)([^'"\s,;]+)(["']?)/gi,
    '$1$2[REDACTED]$4');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]');
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, '$1[REDACTED]');
  return text.length <= maxChars ? text : null;
}

function normalizeResultArtifact(value, authorizedFileIds) {
  if (!hasExactKeys(value, ['schemaVersion', 'summary', 'findings'])
    || value.schemaVersion !== RESULT_SCHEMA_VERSION || !Array.isArray(value.findings)
    || value.findings.length > 8 || !authorizedFileIds) return null;
  const summary = sanitizeArtifactText(value.summary, 2000);
  if (!summary) return null;
  const findings = [];
  for (const item of value.findings) {
    if (!hasExactKeys(item, ['fileId', 'path', 'line', 'severity', 'title', 'detail'])
      || typeof item.fileId !== 'string' || !authorizedFileIds.has(item.fileId)
      || !isSafeRelativePath(item.path)
      || !(item.line === null || (Number.isSafeInteger(item.line) && item.line > 0))
      || RESULT_SEVERITIES.indexOf(item.severity) < 0) return null;
    const title = sanitizeArtifactText(item.title, 120);
    const detail = sanitizeArtifactText(item.detail, 500);
    if (!title || !detail) return null;
    findings.push({
      fileId: item.fileId,
      path: item.path,
      line: item.line,
      severity: item.severity,
      title: title,
      detail: detail
    });
  }
  const normalized = { schemaVersion: RESULT_SCHEMA_VERSION, summary: summary, findings: findings };
  return Buffer.byteLength(JSON.stringify(normalized), 'utf8') <= 12000 ? normalized : null;
}

  function readRunRow(runId) {
    return rowToRun(db.prepare(SQL.readRun).get(runId));
  }

  function rowToConsent(row) {
    if (!row) return null;
    let providerScopes = [], fileIds = [], memoryScope = null, memoryDerivedScope = null;
    try { providerScopes = JSON.parse(String(row.provider_scopes_json || '[]')); } catch (_) {}
    try { fileIds = JSON.parse(String(row.file_ids_json || '[]')); } catch (_) {}
    try {
      const parsedMemoryScope = JSON.parse(String(row.memory_scope_json || 'null'));
      if (parsedMemoryScope != null) {
        memoryScope = normalizeMemoryScope(parsedMemoryScope);
        if (!memoryScope) return null;
      }
    } catch (_) { return null; }
    try {
      const parsedDerivedScope = JSON.parse(String(row.memory_derived_scope_json || 'null'));
      if (parsedDerivedScope != null) {
        memoryDerivedScope = normalizeMemoryDerivedScope(parsedDerivedScope);
        if (!memoryDerivedScope) return null;
      }
    } catch (_) { return null; }
    const revokedAt = row.revoked_at == null ? null : Number(row.revoked_at);
    const expiresAt = Number(row.expires_at);
    return {
      consentId: String(row.consent_id),
      runId: String(row.run_id),
      projectRef: String(row.project_ref),
      providerScopes: providerScopes,
      fileIds: fileIds,
      workspaceWriteConfirmed: Number(row.workspace_write_confirmed || 0) === 1,
      memoryScope: memoryScope,
      memoryDerivedScope: memoryDerivedScope,
      termsVersion: String(row.terms_version),
      confirmationMethod: String(row.confirmation_method),
      confirmedAt: Number(row.confirmed_at),
      issuedAt: Number(row.issued_at),
      expiresAt: expiresAt,
      revokedAt: revokedAt,
      revocationReason: row.revocation_reason == null ? null : String(row.revocation_reason),
      status: revokedAt != null ? 'revoked' : (expiresAt <= now() ? 'expired' : 'active')
    };
  }

  function readConsentRow(runId, consentId) {
    return rowToConsent(db.prepare(SQL.readConsent).get(consentId, runId));
  }

  function rowToResult(row) {
    if (!row) return null;
    let report = null;
    if (row.status === 'available' && row.report_json != null) {
      try { report = JSON.parse(String(row.report_json)); } catch (_) { report = null; }
    }
    return {
      resultId: String(row.result_id),
      runId: String(row.run_id),
      schemaVersion: Number(row.schema_version),
      status: String(row.status),
      report: report,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      expiredAt: row.expired_at == null ? null : Number(row.expired_at),
      deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
      memoryDerived: Number(row.memory_derived || 0) === 1,
      memoryContextHash: row.memory_context_hash == null ? null : String(row.memory_context_hash)
    };
  }

  function readResultRow(runId) {
    return rowToResult(db.prepare(SQL.readResult).get(runId));
  }

  function resultError(code, extra) {
    return Object.assign({ ok: false, code: code }, extra || {});
  }

  function begin() {
    if (!opened || !db) throw Object.assign(new Error('work-run-store-unavailable'), { code: 'STORE_UNAVAILABLE' });
    db.exec('BEGIN IMMEDIATE');
  }

  function finishTransaction(work) {
    begin();
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* keep the original error */ }
      throw error;
    }
  }

  function idempotencyKey(operation, runId, requestId) {
    return hash(operation + ':' + String(runId || '') + ':' + requestId);
  }

  function findIdempotent(requestKeyHash, requestHash, operation) {
    const existing = db.prepare(SQL.readIdempotency).get(requestKeyHash);
    if (!existing) return null;
    if (existing.request_hash !== requestHash || existing.operation !== operation) {
      return resultError('IDEMPOTENCY_CONFLICT');
    }
    const run = readRunRow(String(existing.run_id));
    if (!run) return resultError('STORE_INTEGRITY_ERROR');
    return {
      ok: true,
      duplicate: true,
      resultVersion: Number(existing.result_version),
      resultStatus: String(existing.result_status),
      run: run
    };
  }

  function writeIdempotency(requestKeyHash, requestHash, operation, run, at) {
    db.prepare(SQL.insertIdempotency).run(
      requestKeyHash, requestHash, operation, run.runId, run.version, run.status, at
    );
  }

  function insertEvent(runId, version, eventType, fromStatus, toStatus, reasonCode, at) {
    const next = db.prepare(SQL.nextEventSequence).get(runId);
    const sequence = next ? Number(next.next_sequence) : 1;
    db.prepare(SQL.insertEvent).run(
      runId, sequence, eventType, fromStatus, toStatus, version, reasonCode || null, at, null
    );
    return sequence;
  }

  function insertActionTraceEvent(run, actionTrace, at) {
    const next = db.prepare(SQL.nextEventSequence).get(run.runId);
    const sequence = next ? Number(next.next_sequence) : 1;
    const serialized = JSON.stringify(actionTrace);
    db.prepare(SQL.insertEvent).run(
      run.runId, sequence, 'action_trace', run.status, run.status, run.version, null, at, serialized
    );
    return sequence;
  }

  function reasonMatches(fromStatus, toStatus, reasonCode) {
    if (REASON_CODES.indexOf(reasonCode) < 0) return false;
    if (reasonCode === 'runtime_interrupted') {
      return (toStatus === STATUS.FAILED && [STATUS.QUEUED, STATUS.RUNNING].indexOf(fromStatus) >= 0)
        || (fromStatus === STATUS.CANCEL_REQUESTED && toStatus === STATUS.CANCELLED);
    }
    if (toStatus === STATUS.RUNNING) return fromStatus === STATUS.QUEUED && reasonCode === 'runtime_started';
    if (toStatus === STATUS.COMPLETED) return fromStatus === STATUS.RUNNING && reasonCode === 'runtime_completed';
    if (toStatus === STATUS.FAILED) {
      return (fromStatus === STATUS.QUEUED || fromStatus === STATUS.RUNNING || fromStatus === STATUS.CANCEL_REQUESTED)
        && reasonCode === 'runtime_failed';
    }
    if (toStatus === STATUS.CANCEL_REQUESTED) return fromStatus === STATUS.RUNNING && reasonCode === 'user_cancelled';
    if (toStatus === STATUS.CANCELLED) {
      return (fromStatus === STATUS.QUEUED && reasonCode === 'user_cancelled')
        || (fromStatus === STATUS.CANCEL_REQUESTED && reasonCode === 'runtime_cancelled');
    }
    return false;
  }

  function canTransition(fromStatus, toStatus, reasonCode) {
    const allowed = (
      (fromStatus === STATUS.QUEUED && [STATUS.RUNNING, STATUS.FAILED, STATUS.CANCELLED].indexOf(toStatus) >= 0)
      || (fromStatus === STATUS.RUNNING && [STATUS.CANCEL_REQUESTED, STATUS.COMPLETED, STATUS.FAILED].indexOf(toStatus) >= 0)
      || (fromStatus === STATUS.CANCEL_REQUESTED && [STATUS.CANCELLED, STATUS.FAILED].indexOf(toStatus) >= 0)
    );
    return allowed && reasonMatches(fromStatus, toStatus, reasonCode);
  }

  function persistTransition(run, toStatus, reasonCode, operation, requestId, requestHash, requestKeyHash) {
    const at = now();
    const nextVersion = run.version + 1;
    const updated = db.prepare(SQL.updateRun).run(toStatus, nextVersion, at, run.runId, run.version);
    if (Number(updated.changes) !== 1) return resultError('VERSION_CONFLICT', { run: readRunRow(run.runId) });
    const eventType = toStatus === STATUS.CANCEL_REQUESTED ? 'cancel_requested'
      : (toStatus === STATUS.CANCELLED ? 'cancelled' : 'state_changed');
    insertEvent(run.runId, nextVersion, eventType, run.status, toStatus, reasonCode, at);
    if ([STATUS.CANCEL_REQUESTED, STATUS.CANCELLED, STATUS.FAILED, STATUS.COMPLETED].indexOf(toStatus) >= 0) {
      const revokeReason = toStatus === STATUS.CANCEL_REQUESTED ? 'cancellation_requested' : 'run_' + toStatus;
      db.prepare(SQL.revokeRunConsents).run(at, revokeReason, run.runId);
    }
    const next = readRunRow(run.runId);
    writeIdempotency(requestKeyHash, requestHash, operation, next, at);
    return { ok: true, duplicate: false, run: next };
  }

  function open() {
    if (opened) return { ok: true, alreadyOpen: true, schemaVersion: SCHEMA_VERSION };
    openFailure = null;
    let probe = null;
    try {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      const sqlite = loadSqlite();
      probe = new sqlite.DatabaseSync(dbFile);
      probe.exec('PRAGMA foreign_keys = ON');
      probe.exec('PRAGMA busy_timeout = 3000');
      probe.exec(SQL.createMeta);
      const meta = probe.prepare(SQL.readMeta).get(META_SCHEMA);
      const storedVersion = meta ? Number(meta.value) : 0;
      if (!Number.isInteger(storedVersion) || storedVersion < 0 || storedVersion > SCHEMA_VERSION) {
        throw Object.assign(new Error('work-run-schema-version-invalid'), { code: 'SCHEMA_VERSION_INVALID' });
      }
      probe.exec('BEGIN IMMEDIATE');
      try {
        probe.exec(SQL.createRuns);
        const runColumns = new Set(probe.prepare('PRAGMA table_info(work_runs)').all().map(row => String(row.name)));
        if (!runColumns.has('executor_selection_json')) {
          probe.exec('ALTER TABLE work_runs ADD COLUMN executor_selection_json TEXT');
        }
        if (!runColumns.has('app_draft_ref')) {
          probe.exec('ALTER TABLE work_runs ADD COLUMN app_draft_ref TEXT');
        }
        probe.exec(SQL.createRunEvents);
        const eventColumns = new Set(probe.prepare('PRAGMA table_info(work_run_events)').all().map(row => String(row.name)));
        if (!eventColumns.has('action_trace_json')) {
          probe.exec('ALTER TABLE work_run_events ADD COLUMN action_trace_json TEXT');
        }
        probe.exec(SQL.createIdempotency);
        probe.exec(SQL.createResults);
        probe.exec(SQL.createConsents);
        probe.exec(SQL.createDshSessions);
        const dshSessionIndexes = probe.prepare('PRAGMA index_list(work_run_dsh_sessions)').all();
        const hasUniqueSession = dshSessionIndexes.some(index => {
          if (Number(index.unique) !== 1) return false;
          const escapedIndex = String(index.name || '').replace(/"/g, '""');
          const columns = probe.prepare('PRAGMA index_info("' + escapedIndex + '")').all();
          return columns.length === 1 && String(columns[0].name) === 'session_id';
        });
        if (hasUniqueSession) {
          probe.exec('ALTER TABLE work_run_dsh_sessions RENAME TO work_run_dsh_sessions_v7');
          probe.exec(SQL.createDshSessions);
          probe.exec('INSERT INTO work_run_dsh_sessions (run_id, session_id, consent_id, bound_at) ' +
            'SELECT run_id, session_id, consent_id, bound_at FROM work_run_dsh_sessions_v7');
          probe.exec('DROP TABLE work_run_dsh_sessions_v7');
        }
        probe.exec(SQL.createDshSessionLookupIndex);
        const consentColumns = new Set(probe.prepare('PRAGMA table_info(work_run_consents)').all().map(row => String(row.name)));
        if (!consentColumns.has('workspace_write_confirmed')) {
          probe.exec('ALTER TABLE work_run_consents ADD COLUMN workspace_write_confirmed INTEGER NOT NULL DEFAULT 0');
        }
        if (!consentColumns.has('memory_scope_json')) {
          probe.exec("ALTER TABLE work_run_consents ADD COLUMN memory_scope_json TEXT NOT NULL DEFAULT 'null'");
        }
        if (!consentColumns.has('memory_derived_scope_json')) {
          probe.exec("ALTER TABLE work_run_consents ADD COLUMN memory_derived_scope_json TEXT NOT NULL DEFAULT 'null'");
        }
        const resultColumns = new Set(probe.prepare('PRAGMA table_info(work_run_results)').all().map(row => String(row.name)));
        if (!resultColumns.has('memory_derived')) {
          probe.exec('ALTER TABLE work_run_results ADD COLUMN memory_derived INTEGER NOT NULL DEFAULT 0');
        }
        if (!resultColumns.has('memory_context_hash')) {
          probe.exec('ALTER TABLE work_run_results ADD COLUMN memory_context_hash TEXT');
        }
        probe.prepare(SQL.backfillLegacyResults).run(STATUS.COMPLETED);
        probe.prepare(SQL.writeMeta).run(META_SCHEMA, String(SCHEMA_VERSION));
        probe.exec('COMMIT');
      } catch (error) {
        try { probe.exec('ROLLBACK'); } catch (_) { /* preserve original error */ }
        throw error;
      }
      db = probe;
      opened = true;
      logger('work-run-store-opened', { schemaVersion: SCHEMA_VERSION });
      return { ok: true, alreadyOpen: false, schemaVersion: SCHEMA_VERSION };
    } catch (error) {
      openFailure = error && error.code === 'SCHEMA_VERSION_INVALID' ? 'schema-version-invalid' : 'store-open-failed';
      try { if (probe) probe.close(); } catch (_) { /* best effort */ }
      db = null;
      opened = false;
      logger('work-run-store-open-failed', { code: openFailure });
      throw Object.assign(new Error(openFailure), { code: openFailure });
    }
  }

  function close() {
    if (db) {
      try { db.close(); } catch (_) { /* already closed */ }
    }
    db = null;
    opened = false;
    return { ok: true };
  }

  function createRun(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!isPlainObject(input) || Object.keys(input).some(key => !['requestId', 'workflowId', 'projectRef', 'executorSelection', 'appDraftRef'].includes(key))
      || !['requestId', 'workflowId', 'projectRef'].every(key => Object.prototype.hasOwnProperty.call(input, key))) return resultError('INVALID_REQUEST');
    const requestId = String(input.requestId || '');
    const workflowId = String(input.workflowId || '');
    const projectRef = String(input.projectRef || '');
    const appDraftRef = input.appDraftRef == null ? '' : String(input.appDraftRef);
    const executorSelection = input.executorSelection == null ? null : workModeExecutor.normalizeSnapshot(input.executorSelection);
    if (!REQUEST_ID_RE.test(requestId) || !isSupportedWorkflow(workflowId) || !PROJECT_REF_RE.test(projectRef)
      || (workflowId === APP_BUILDER_WORKFLOW_ID && !APP_DRAFT_REF_RE.test(appDraftRef))
      || (workflowId === WORKFLOW_ID && appDraftRef)
      || (workflowId === APP_BUILDER_WORKFLOW_ID && (!executorSelection || executorSelection.presetId !== 'app-builder'))
      || (workflowId === WORKFLOW_ID && executorSelection && executorSelection.presetId === 'app-builder')
      || (workflowId === CODING_WORKFLOW_ID && (!executorSelection || executorSelection.presetId !== 'coding' || appDraftRef))
      || (workflowId !== CODING_WORKFLOW_ID && executorSelection && executorSelection.presetId === 'coding')) {
      return resultError('INVALID_REQUEST');
    }
    if (input.executorSelection != null && !executorSelection) return resultError('INVALID_EXECUTOR_SELECTION');
    const requestKeyHash = idempotencyKey('create', '', requestId);
    const requestShape = { workflowId: workflowId, projectRef: projectRef };
    if (executorSelection) requestShape.executorSelection = executorSelection;
    if (appDraftRef) requestShape.appDraftRef = appDraftRef;
    const requestHash = hash(stableStringify(requestShape));
    try {
      return finishTransaction(() => {
        const duplicate = findIdempotent(requestKeyHash, requestHash, 'create');
        if (duplicate) return duplicate;
        const runId = 'wr_' + crypto.randomUUID();
        const at = now();
        db.prepare(SQL.insertRun).run(runId, workflowId, projectRef, STATUS.QUEUED, 1, at, at,
          executorSelection ? JSON.stringify(executorSelection) : null, appDraftRef || null);
        insertEvent(runId, 1, 'created', null, STATUS.QUEUED, null, at);
        const run = readRunRow(runId);
        writeIdempotency(requestKeyHash, requestHash, 'create', run, at);
        return { ok: true, duplicate: false, run: run };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function pinExecutorSelection(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!hasExactKeys(input, ['runId', 'expectedVersion', 'executorSelection'])) return resultError('INVALID_REQUEST');
    const runId = String(input.runId || '');
    const expectedVersion = Number(input.expectedVersion);
    const selection = workModeExecutor.normalizeSnapshot(input.executorSelection);
    if (!validRunId(runId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !selection) {
      return resultError('INVALID_REQUEST');
    }
    try {
      return finishTransaction(() => {
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        if (run.version !== expectedVersion) return resultError('VERSION_CONFLICT', { run: run });
        if (!isSupportedWorkflow(run.workflowId) || run.status !== STATUS.QUEUED) return resultError('RUN_NOT_ACTIVE', { run: run });
        const activeConsent = db.prepare(SQL.readActiveConsent).get(runId, now());
        if (activeConsent) return resultError('EXECUTOR_SELECTION_LOCKED', { run: run });
        if (run.executorSelection) {
          return stableStringify(run.executorSelection) === stableStringify(selection)
            ? { ok: true, duplicate: true, run: run }
            : resultError('EXECUTOR_SELECTION_LOCKED', { run: run });
        }
        const updated = db.prepare(SQL.pinExecutorSelection).run(JSON.stringify(selection), runId, STATUS.QUEUED);
        if (Number(updated.changes) !== 1) return resultError('EXECUTOR_SELECTION_LOCKED', { run: readRunRow(runId) });
        const pinned = readRunRow(runId);
        return { ok: true, duplicate: false, run: pinned };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  /** Bind one explicitly consented DSH Web Session to a sequential Home Node Run. */
  function bindDshSession(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!hasExactKeys(input, ['runId', 'sessionId', 'consentId', 'expectedVersion'])) return resultError('INVALID_REQUEST');
    const runId = String(input.runId || '');
    const sessionId = String(input.sessionId || '');
    const consentId = String(input.consentId || '');
    const expectedVersion = Number(input.expectedVersion);
    if (!validRunId(runId) || !DSH_SESSION_ID_RE.test(sessionId)
      || (consentId && !/^wrc_[A-Za-z0-9-]{36}$/.test(consentId))
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return resultError('INVALID_REQUEST');
    try {
      return finishTransaction(() => {
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        if (run.version !== expectedVersion) return resultError('VERSION_CONFLICT', { run: run });
        if (!isSupportedWorkflow(run.workflowId) || ![STATUS.QUEUED, STATUS.RUNNING].includes(run.status)) {
          return resultError('RUN_NOT_ACTIVE', { run: run });
        }
        if (consentId) {
          const consent = readConsentRow(runId, consentId);
          const memoryScope = consent && consent.memoryScope;
          const memoryDerivedScope = consent && consent.memoryDerivedScope;
          const memoryScopeValid = !memoryScope || (memoryDerivedScope
            && memoryScope.projectRef === run.projectRef
            && memoryDerivedScope.projectRef === run.projectRef
            && memoryDerivedScope.contextHash === memoryScope.contextHash
            && consent.providerScopes.some(scope => sameJson(scope, memoryScope.providerScope))
            && consent.providerScopes.some(scope => sameJson(scope, memoryDerivedScope.review.providerScope)));
          if (!consent || consent.status !== 'active'
            || consent.projectRef !== run.projectRef
            || consent.termsVersion !== CONSENT_TERMS_VERSION
            || ((memoryScope === null) !== (memoryDerivedScope === null))
            || !memoryScopeValid) {
            return resultError('CONSENT_INACTIVE', { run: run });
          }
        } else if (run.status !== STATUS.QUEUED) {
          return resultError('RUN_NOT_ACTIVE', { run: run });
        }
        const existing = db.prepare(SQL.readDshSessionByRun).get(runId);
        if (existing) {
          if (String(existing.session_id) === sessionId && String(existing.consent_id || '') === consentId) {
            return { ok: true, duplicate: true, run: run, binding: {
              runId: runId, sessionId: sessionId, consentId: existing.consent_id == null ? '' : String(existing.consent_id), boundAt: Number(existing.bound_at)
            } };
          }
          const previousConsent = db.prepare(SQL.readConsent).get(String(existing.consent_id), runId);
          if (String(existing.session_id) === sessionId && run.status === STATUS.QUEUED
            && (!String(existing.consent_id || '') || !previousConsent || previousConsent.revoked_at != null || Number(previousConsent.expires_at) <= now())) {
            db.prepare(SQL.updateDshSessionConsent).run(consentId || null, now(), runId, sessionId);
            const updated = db.prepare(SQL.readDshSessionByRun).get(runId);
            return { ok: true, duplicate: false, rebound: true, run: run, binding: {
              runId: runId, sessionId: sessionId, consentId: consentId, boundAt: Number(updated.bound_at)
            } };
          }
          return resultError('DSH_SESSION_ALREADY_BOUND', { run: run });
        }
        const latestRow = db.prepare(SQL.readDshSessionById).get(sessionId);
        if (latestRow) {
          const previousRun = readRunRow(String(latestRow.run_id));
          if (!previousRun) return resultError('STORE_INTEGRITY_ERROR');
          if (!TERMINAL.includes(previousRun.status)) return resultError('DSH_SESSION_RUN_ACTIVE', { run: previousRun });
          if (previousRun.projectRef !== run.projectRef) return resultError('DSH_SESSION_SCOPE_MISMATCH', { run: run });
          if (run.workflowId === APP_BUILDER_WORKFLOW_ID) {
            const priorAppBuilder = db.prepare(SQL.readAppDraftForDshSession).get(sessionId, APP_BUILDER_WORKFLOW_ID);
            if (priorAppBuilder && String(priorAppBuilder.app_draft_ref || '') !== run.appDraftRef) {
              return resultError('DSH_SESSION_SCOPE_MISMATCH', { run: run });
            }
          }
        }
        try { db.prepare(SQL.insertDshSession).run(runId, sessionId, consentId || null, now()); }
        catch (_) { return resultError('DSH_SESSION_ALREADY_BOUND'); }
        const row = db.prepare(SQL.readDshSessionByRun).get(runId);
        return { ok: true, duplicate: false, run: run, binding: {
          runId: runId, sessionId: sessionId, consentId: consentId, boundAt: Number(row.bound_at)
        } };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  /** Read the persisted run and consent binding without copying Session events. */
  function getDshSession(sessionId, requestedRunId) {
    sessionId = String(sessionId || '');
    requestedRunId = requestedRunId == null || requestedRunId === '' ? '' : String(requestedRunId);
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!DSH_SESSION_ID_RE.test(sessionId) || (requestedRunId && !validRunId(requestedRunId))) return resultError('INVALID_SESSION_ID');
    try {
      const row = requestedRunId
        ? db.prepare(SQL.readDshSessionByIdAndRun).get(sessionId, requestedRunId)
        : db.prepare(SQL.readDshSessionById).get(sessionId);
      if (!row) return { ok: true, found: false, run: null, binding: null };
      const run = readRunRow(String(row.run_id));
      if (!run) return resultError('STORE_INTEGRITY_ERROR');
      const sessionRuns = db.prepare(SQL.readDshSessionsById).all(sessionId).map(item => {
        const itemRun = readRunRow(String(item.run_id));
        if (!itemRun) throw new Error('DSH_SESSION_RUN_MISSING');
        return { run: itemRun, binding: {
          runId: String(item.run_id), sessionId: String(item.session_id),
          consentId: item.consent_id == null ? '' : String(item.consent_id), boundAt: Number(item.bound_at)
        } };
      });
      return { ok: true, found: true, run: run, binding: {
        runId: String(row.run_id), sessionId: String(row.session_id), consentId: row.consent_id == null ? '' : String(row.consent_id), boundAt: Number(row.bound_at)
      }, runs: sessionRuns };
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function getRun(runId) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!validRunId(runId)) return resultError('INVALID_RUN_ID');
    try {
      const run = readRunRow(runId);
      return run ? { ok: true, run: run } : resultError('RUN_NOT_FOUND');
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function listActive(options) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    options = options || {};
    const requestedLimit = options.limit == null ? MAX_ACTIVE_RUNS_PAGE : Number(options.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_ACTIVE_RUNS_PAGE) {
      return resultError('INVALID_QUERY');
    }
    try {
      const rows = db.prepare(SQL.listActive).all(
        STATUS.QUEUED, STATUS.RUNNING, STATUS.CANCEL_REQUESTED, requestedLimit + 1
      );
      const hasMore = rows.length > requestedLimit;
      return {
        ok: true,
        runs: rows.slice(0, requestedLimit).map(rowToRun),
        hasMore: hasMore
      };
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function listResults(options) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    options = options || {};
    const requestedLimit = options.limit == null ? MAX_RESULTS_PAGE : Number(options.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_RESULTS_PAGE) {
      return resultError('INVALID_QUERY');
    }
    try {
      const rows = db.prepare(SQL.listResults).all(WORKFLOW_ID, APP_BUILDER_WORKFLOW_ID, CODING_WORKFLOW_ID, requestedLimit + 1);
      const page = rows.slice(0, requestedLimit).map(row => ({
        runId: String(row.run_id),
        workflowId: String(row.workflow_id),
        projectRef: String(row.project_ref),
        runStatus: String(row.run_status),
        runVersion: Number(row.run_version),
        runCreatedAt: Number(row.run_created_at),
        runUpdatedAt: Number(row.run_updated_at),
        resultId: String(row.result_id),
        resultStatus: String(row.result_status),
        createdAt: Number(row.result_created_at),
        expiresAt: Number(row.expires_at),
        expiredAt: row.expired_at == null ? null : Number(row.expired_at),
        deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
        memoryDerived: Number(row.memory_derived || 0) === 1,
        memoryContextHash: row.memory_context_hash == null ? null : String(row.memory_context_hash),
        ...(row.app_draft_ref ? { appDraftRef: String(row.app_draft_ref) } : {})
      }));
      return { ok: true, results: page, hasMore: rows.length > requestedLimit };
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function listEvents(runId, options) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!validRunId(runId)) return resultError('INVALID_RUN_ID');
    options = options || {};
    const afterSequence = options.afterSequence == null ? 0 : Number(options.afterSequence);
    const requestedLimit = options.limit == null ? 50 : Number(options.limit);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_EVENTS_PAGE) {
      return resultError('INVALID_QUERY');
    }
    try {
      if (!readRunRow(runId)) return resultError('RUN_NOT_FOUND');
      const rows = db.prepare(SQL.listEvents).all(runId, afterSequence, requestedLimit + 1);
      const hasMore = rows.length > requestedLimit;
      const page = rows.slice(0, requestedLimit).map(row => ({
        sequence: Number(row.sequence),
        eventType: String(row.event_type),
        fromStatus: row.from_status == null ? null : String(row.from_status),
        toStatus: String(row.to_status),
        version: Number(row.version),
        reasonCode: row.reason_code == null ? null : String(row.reason_code),
        createdAt: Number(row.created_at),
        ...(function () {
          if (String(row.event_type) !== 'action_trace' || typeof row.action_trace_json !== 'string') return {};
          let value;
          try { value = JSON.parse(row.action_trace_json); } catch (_) { return {}; }
          if (!hasExactKeys(value, ['schemaVersion', 'actionId', 'requestId', 'runId', 'status', 'authorityResult'])
            || value.schemaVersion !== 1 || value.runId !== runId
            || typeof value.actionId !== 'string' || !ACTION_ID_RE.test(value.actionId)
            || typeof value.requestId !== 'string' || !ACTION_TRACE_REQUEST_ID_RE.test(value.requestId)
            || ACTION_TRACE_STATUSES.indexOf(value.status) < 0
            || ACTION_TRACE_AUTHORITY_RESULTS.indexOf(value.authorityResult) < 0) return {};
          return { actionTrace: {
            schemaVersion: 1,
            actionId: value.actionId,
            requestId: value.requestId,
            runId: value.runId,
            status: value.status,
            authorityResult: value.authorityResult
          } };
        })()
      }));
      return {
        ok: true,
        runId: runId,
        events: page,
        hasMore: hasMore,
        nextSequence: page.length ? page[page.length - 1].sequence : afterSequence
      };
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function recordActionTrace(runId, input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!validRunId(runId) || !hasExactKeys(input, ['requestId', 'actionId', 'status', 'authorityResult'])) {
      return resultError('INVALID_REQUEST');
    }
    const requestId = String(input.requestId || '');
    const actionId = String(input.actionId || '');
    const status = String(input.status || '');
    const authorityResult = String(input.authorityResult || '');
    if (!ACTION_TRACE_REQUEST_ID_RE.test(requestId) || !ACTION_ID_RE.test(actionId)
      || ACTION_TRACE_STATUSES.indexOf(status) < 0
      || ACTION_TRACE_AUTHORITY_RESULTS.indexOf(authorityResult) < 0) return resultError('INVALID_REQUEST');
    const actionTrace = {
      schemaVersion: 1,
      actionId: actionId,
      requestId: requestId,
      runId: runId,
      status: status,
      authorityResult: authorityResult
    };
    if (Buffer.byteLength(JSON.stringify(actionTrace), 'utf8') > 512) return resultError('INVALID_REQUEST');
    try {
      return finishTransaction(() => {
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        const at = now();
        const sequence = insertActionTraceEvent(run, actionTrace, at);
        return {
          ok: true,
          runId: runId,
          event: {
            sequence: sequence,
            eventType: 'action_trace',
            fromStatus: run.status,
            toStatus: run.status,
            version: run.version,
            reasonCode: null,
            createdAt: at,
            actionTrace: actionTrace
          }
        };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function grantConsent(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    const grantKeys = ['runId', 'requestId', 'expectedVersion', 'projectRef', 'providerScopes', 'fileIds',
      'workspaceWriteConfirmed', 'memoryScope', 'memoryDerivedScope', 'expiresInMs', 'termsVersion', 'confirmed'];
    const grantKeysReadOnly = grantKeys.filter(key => key !== 'workspaceWriteConfirmed');
    if (!hasExactKeys(input, grantKeys) && !hasExactKeys(input, grantKeysReadOnly)) {
      return resultError('INVALID_REQUEST');
    }
    const runId = String(input.runId || '');
    const requestId = String(input.requestId || '');
    const expectedVersion = Number(input.expectedVersion);
    const projectRef = String(input.projectRef || '');
    const providerScopes = normalizeProviderScopes(input.providerScopes);
    const fileIds = normalizeFileIds(input.fileIds, true);
    const workspaceWriteConfirmed = input.workspaceWriteConfirmed === true;
    const memoryScope = input.memoryScope === null ? null : normalizeMemoryScope(input.memoryScope);
    const memoryDerivedScope = input.memoryDerivedScope === null ? null : normalizeMemoryDerivedScope(input.memoryDerivedScope);
    const expiresInMs = Number(input.expiresInMs);
    if (!validRunId(runId) || !REQUEST_ID_RE.test(requestId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
      || !PROJECT_REF_RE.test(projectRef) || !providerScopes || !fileIds
      || (input.memoryScope !== null && !memoryScope)
      || (input.memoryDerivedScope !== null && !memoryDerivedScope)
      || ((memoryScope === null) !== (memoryDerivedScope === null))
      || (memoryScope && (memoryScope.projectRef !== projectRef
        || !providerScopes.some(scope => sameJson(scope, memoryScope.providerScope))))
      || (memoryDerivedScope && (memoryDerivedScope.projectRef !== projectRef
        || memoryDerivedScope.contextHash !== memoryScope.contextHash
        || !providerScopes.some(scope => sameJson(scope, memoryDerivedScope.review.providerScope))))
      || !Number.isSafeInteger(expiresInMs) || expiresInMs < 1000 || expiresInMs > MAX_CONSENT_TTL_MS
      || input.termsVersion !== CONSENT_TERMS_VERSION
      || input.confirmed !== true) return resultError('INVALID_REQUEST');

    const requestKeyHash = idempotencyKey('grant_consent', runId, requestId);
    const requestHash = hash(stableStringify({
      expectedVersion: expectedVersion,
      projectRef: projectRef,
      providerScopes: providerScopes,
      fileIds: fileIds,
      workspaceWriteConfirmed: workspaceWriteConfirmed,
      memoryScope: memoryScope,
      memoryDerivedScope: memoryDerivedScope,
      expiresInMs: expiresInMs,
      termsVersion: input.termsVersion,
      confirmed: true
    }));
    try {
      return finishTransaction(() => {
        const duplicate = findIdempotent(requestKeyHash, requestHash, 'grant_consent');
        if (duplicate) {
          const prior = db.prepare(SQL.readConsentByGrantKey).get(requestKeyHash);
          return prior ? { ok: true, duplicate: true, run: duplicate.run, consent: rowToConsent(prior) }
            : resultError('STORE_INTEGRITY_ERROR');
        }
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        if (((run.workflowId === APP_BUILDER_WORKFLOW_ID || run.workflowId === CODING_WORKFLOW_ID) && providerScopes.length !== 1)
          || (run.workflowId !== APP_BUILDER_WORKFLOW_ID && run.workflowId !== CODING_WORKFLOW_ID && providerScopes.length !== 2)
          || (run.workflowId === APP_BUILDER_WORKFLOW_ID && (!run.appDraftRef || fileIds.length !== 0))
          || (run.workflowId === CODING_WORKFLOW_ID && fileIds.length === 0)) {
          return resultError('INVALID_PROVIDER_SCOPE', { run: run });
        }
        if ((run.workflowId === CODING_WORKFLOW_ID) !== workspaceWriteConfirmed) {
          return resultError('WORKSPACE_WRITE_CONSENT_REQUIRED', { run: run });
        }
        if (run.version !== expectedVersion) return resultError('VERSION_CONFLICT', { run: run });
        if (run.status !== STATUS.QUEUED) return resultError('CONSENT_RUN_NOT_QUEUED', { run: run });
        if (run.projectRef !== projectRef) return resultError('CONSENT_SCOPE_MISMATCH', { run: run });
        const at = now();
        const existing = db.prepare(SQL.readActiveConsent).get(runId, at);
        if (existing) return resultError('CONSENT_EXISTS', { consentId: String(existing.consent_id), run: run });
        const consentId = 'wrc_' + crypto.randomUUID();
        const expiresAt = at + expiresInMs;
        db.prepare(SQL.insertConsent).run(
          consentId, runId, projectRef, JSON.stringify(providerScopes), JSON.stringify(fileIds), Number(workspaceWriteConfirmed), JSON.stringify(memoryScope),
          JSON.stringify(memoryDerivedScope),
          input.termsVersion, requestKeyHash, requestHash, 'explicit_user_action', at, at, expiresAt
        );
        writeIdempotency(requestKeyHash, requestHash, 'grant_consent', run, at);
        return { ok: true, duplicate: false, run: run, consent: readConsentRow(runId, consentId) };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function getConsent(runId, consentId) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!validRunId(runId) || typeof consentId !== 'string' || !/^wrc_[A-Za-z0-9-]{36}$/.test(consentId)) {
      return resultError('INVALID_REQUEST');
    }
    try {
      const run = readRunRow(runId);
      if (!run) return resultError('RUN_NOT_FOUND');
      const consent = readConsentRow(runId, consentId);
      return consent ? { ok: true, consent: consent } : resultError('CONSENT_NOT_FOUND');
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function getMemoryProvenance(runId) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!validRunId(runId)) return resultError('INVALID_RUN_ID');
    try {
      const run = readRunRow(runId);
      if (!run) return resultError('RUN_NOT_FOUND');
      const latest = db.prepare(SQL.latestConsentByRun).get(runId);
      const consent = latest ? readConsentRow(runId, String(latest.consent_id)) : null;
      const memoryScope = consent && consent.memoryScope;
      const derivedScope = consent && consent.memoryDerivedScope;
      const result = readResultRow(runId);
      return {
        ok: true,
        runId: runId,
        consent: consent ? {
          status: consent.status,
          issuedAt: consent.issuedAt,
          expiresAt: consent.expiresAt,
          revokedAt: consent.revokedAt,
          revocationReason: consent.revocationReason,
          memoryScope: memoryScope ? {
            projectRef: memoryScope.projectRef,
            refs: memoryScope.refs.map(ref => ({
              memoryId: ref.memoryId,
              revision: ref.revision,
              contentHash: ref.contentHash
            })),
            contextHash: memoryScope.contextHash,
            contextChars: memoryScope.contextChars
          } : null,
          memoryDerivedScope: derivedScope ? {
            contextHash: derivedScope.contextHash,
            reviewConfirmed: derivedScope.review.confirmed === true,
            resultConfirmed: derivedScope.result.confirmed === true
          } : null
        } : {
          status: 'not_found',
          issuedAt: null,
          expiresAt: null,
          revokedAt: null,
          revocationReason: null,
          memoryScope: null,
          memoryDerivedScope: null
        },
        result: result ? {
          resultId: result.resultId,
          status: result.status,
          createdAt: result.createdAt,
          expiredAt: result.expiredAt,
          deletedAt: result.deletedAt,
          memoryDerived: result.memoryDerived === true,
          memoryContextHash: result.memoryContextHash
        } : null
      };
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function checkConsent(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!isPlainObject(input)) return resultError('INVALID_REQUEST');
    const consumer = input.consumer;
    const isAgentCheck = consumer === 'agent';
    const isMiddleBrainCheck = consumer === 'middle_brain_plan' || consumer === 'middle_brain_review';
    if ((!isAgentCheck && !isMiddleBrainCheck)
      || (isAgentCheck && !hasExactKeys(input, ['runId', 'consentId', 'projectRef', 'providerScope', 'fileIds', 'consumer', 'memoryScope']))
      || (isMiddleBrainCheck && !hasExactKeys(input, ['runId', 'consentId', 'projectRef', 'providerScope', 'fileIds', 'consumer']))) {
      return resultError('INVALID_REQUEST');
    }
    const runId = String(input.runId || '');
    const consentId = String(input.consentId || '');
    const projectRef = String(input.projectRef || '');
    const providerScope = normalizeProviderScope(input.providerScope);
    const fileIds = normalizeFileIds(input.fileIds, true);
    if (!validRunId(runId) || !/^wrc_[A-Za-z0-9-]{36}$/.test(consentId)
      || !PROJECT_REF_RE.test(projectRef) || !providerScope || !fileIds
      || (isAgentCheck && providerScope.destination !== 'agent')
      || (isMiddleBrainCheck && providerScope.destination !== 'middle_brain')) return resultError('INVALID_REQUEST');
    const memoryScope = isAgentCheck
      ? (input.memoryScope === null ? null : normalizeMemoryScope(input.memoryScope)) : null;
    if (isAgentCheck && input.memoryScope !== null && !memoryScope) return resultError('INVALID_REQUEST');
    try {
      const run = readRunRow(runId);
      if (!run) return resultError('RUN_NOT_FOUND');
      if (((run.workflowId === APP_BUILDER_WORKFLOW_ID || run.workflowId === CODING_WORKFLOW_ID) && providerScope.destination !== 'agent')
        || (run.workflowId === APP_BUILDER_WORKFLOW_ID && fileIds.length !== 0)
        || (run.workflowId === CODING_WORKFLOW_ID && fileIds.length === 0)
        || (run.workflowId !== APP_BUILDER_WORKFLOW_ID && run.workflowId !== CODING_WORKFLOW_ID && providerScope.destination !== 'agent'
          && providerScope.destination !== 'middle_brain')) return resultError('CONSENT_SCOPE_MISMATCH', { run: run });
      if (run.projectRef !== projectRef) return resultError('CONSENT_SCOPE_MISMATCH', { run: run });
      if (run.status !== STATUS.QUEUED && run.status !== STATUS.RUNNING) return resultError('CONSENT_RUN_TERMINAL', { run: run });
      const consent = readConsentRow(runId, consentId);
      if (!consent) return resultError('CONSENT_NOT_FOUND', { run: run });
      if ((run.workflowId === CODING_WORKFLOW_ID) !== consent.workspaceWriteConfirmed) {
        return resultError('CONSENT_SCOPE_MISMATCH', { run: run, consent: consent });
      }
      if (consent.termsVersion !== CONSENT_TERMS_VERSION) return resultError('CONSENT_TERMS_STALE', { run: run });
      if (consent.status === 'revoked') return resultError('CONSENT_REVOKED', { run: run, consent: consent });
      if (consent.status === 'expired') return resultError('CONSENT_EXPIRED', { run: run, consent: consent });
      if (consent.projectRef !== projectRef) return resultError('CONSENT_SCOPE_MISMATCH', { run: run });
      const allowedProvider = consent.providerScopes.some(scope => stableStringify(scope) === stableStringify(providerScope));
      if (!allowedProvider) return resultError('CONSENT_PROVIDER_MISMATCH', { run: run });
      const allowedFiles = new Set(consent.fileIds);
      if (fileIds.some(fileId => !allowedFiles.has(fileId))) return resultError('CONSENT_SCOPE_MISMATCH', { run: run });
      if (isAgentCheck && !sameJson(memoryScope, consent.memoryScope)) {
        return resultError('CONSENT_MEMORY_SCOPE_MISMATCH', { run: run });
      }
      if (consumer === 'middle_brain_review' && consent.memoryScope !== null) {
        const derivedScope = consent.memoryDerivedScope;
        if (!derivedScope || derivedScope.projectRef !== projectRef
          || derivedScope.contextHash !== consent.memoryScope.contextHash
          || !derivedScope.review.confirmed
          || !sameJson(derivedScope.review.providerScope, providerScope)) {
          return resultError('CONSENT_MEMORY_DERIVED_REVIEW_REQUIRED', { run: run });
        }
      }
      return { ok: true, run: run, consent: consent };
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function revokeConsent(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!hasExactKeys(input, ['runId', 'consentId', 'requestId', 'expectedVersion'])) return resultError('INVALID_REQUEST');
    const runId = String(input.runId || '');
    const consentId = String(input.consentId || '');
    const requestId = String(input.requestId || '');
    const expectedVersion = Number(input.expectedVersion);
    if (!validRunId(runId) || !/^wrc_[A-Za-z0-9-]{36}$/.test(consentId)
      || !REQUEST_ID_RE.test(requestId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return resultError('INVALID_REQUEST');
    }
    const requestKeyHash = idempotencyKey('revoke_consent', runId, requestId);
    const requestHash = hash(stableStringify({ consentId: consentId, expectedVersion: expectedVersion }));
    try {
      return finishTransaction(() => {
        const duplicate = findIdempotent(requestKeyHash, requestHash, 'revoke_consent');
        if (duplicate) return { ok: true, duplicate: true, run: duplicate.run, consent: readConsentRow(runId, consentId) };
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        if (run.version !== expectedVersion) return resultError('VERSION_CONFLICT', { run: run });
        const consent = readConsentRow(runId, consentId);
        if (!consent) return resultError('CONSENT_NOT_FOUND', { run: run });
        const at = now();
        if (consent.revokedAt == null) db.prepare(SQL.revokeConsent).run(at, 'user_revoked', consentId, runId);
        writeIdempotency(requestKeyHash, requestHash, 'revoke_consent', run, at);
        return { ok: true, duplicate: false, run: run, consent: readConsentRow(runId, consentId) };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function completeRun(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!hasExactKeys(input, ['runId', 'requestId', 'expectedVersion', 'consentId', 'result'])) return resultError('INVALID_REQUEST');
    const runId = String(input.runId || '');
    const requestId = String(input.requestId || '');
    const expectedVersion = Number(input.expectedVersion);
    const consentId = String(input.consentId || '');
    if (!validRunId(runId) || !REQUEST_ID_RE.test(requestId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
      || !/^wrc_[A-Za-z0-9-]{36}$/.test(consentId)) return resultError('INVALID_REQUEST');
    const requestKeyHash = idempotencyKey('complete', runId, requestId);
    try {
      return finishTransaction(() => {
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        const consent = readConsentRow(runId, consentId);
        if (!consent) return resultError('CONSENT_NOT_FOUND', { run: run });
        if (consent.projectRef !== run.projectRef) return resultError('CONSENT_SCOPE_MISMATCH', { run: run });
        if (consent.termsVersion !== CONSENT_TERMS_VERSION) return resultError('CONSENT_TERMS_STALE', { run: run });
        const memoryDerived = consent.memoryScope !== null;
        const derivedScope = consent.memoryDerivedScope;
        if ((memoryDerived && (!derivedScope || derivedScope.projectRef !== run.projectRef
          || derivedScope.contextHash !== consent.memoryScope.contextHash
          || derivedScope.result.confirmed !== true || derivedScope.result.storage !== RESULT_STORAGE
          || derivedScope.result.retentionMs !== RESULT_RETENTION_MS))
          || (!memoryDerived && derivedScope !== null)) {
          return resultError('CONSENT_MEMORY_DERIVED_RESULT_REQUIRED', { run: run });
        }
        const authorizedFileIds = new Set(consent.fileIds);
        const normalized = normalizeResultArtifact(input.result, authorizedFileIds);
        if (!normalized) return resultError('INVALID_RESULT', { run: run });
        const requestHash = hash(stableStringify({
          expectedVersion: expectedVersion,
          consentId: consentId,
          result: normalized
        }));
        const duplicate = findIdempotent(requestKeyHash, requestHash, 'complete');
        if (duplicate) {
          const result = readResultRow(runId);
          return result ? { ok: true, duplicate: true, run: duplicate.run, result: result }
            : resultError('STORE_INTEGRITY_ERROR', { run: duplicate.run });
        }
        if (run.version !== expectedVersion) return resultError('VERSION_CONFLICT', { run: run });
        if (run.status !== STATUS.RUNNING) return resultError('INVALID_TRANSITION', { run: run });
        if (consent.status === 'revoked') return resultError('CONSENT_REVOKED', { run: run });
        if (consent.status === 'expired') return resultError('CONSENT_EXPIRED', { run: run });
        if (!canTransition(run.status, STATUS.COMPLETED, 'runtime_completed')) return resultError('INVALID_TRANSITION', { run: run });

        const at = now();
        const resultId = 'wrres_' + crypto.randomUUID();
        const reportJson = JSON.stringify(normalized);
        const expiresAt = at + RESULT_RETENTION_MS;
        const nextVersion = run.version + 1;
        const updated = db.prepare(SQL.updateRun).run(STATUS.COMPLETED, nextVersion, at, run.runId, run.version);
        if (Number(updated.changes) !== 1) return resultError('VERSION_CONFLICT', { run: readRunRow(runId) });
        db.prepare(SQL.insertResult).run(
          resultId, runId, RESULT_SCHEMA_VERSION, 'available', reportJson, at, expiresAt,
          memoryDerived ? 1 : 0, memoryDerived ? consent.memoryScope.contextHash : null
        );
        insertEvent(runId, nextVersion, 'state_changed', run.status, STATUS.COMPLETED, 'runtime_completed', at);
        db.prepare(SQL.revokeRunConsents).run(at, 'run_completed', runId);
        const completed = readRunRow(runId);
        writeIdempotency(requestKeyHash, requestHash, 'complete', completed, at);
        return { ok: true, duplicate: false, run: completed, result: readResultRow(runId) };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function getResult(runId) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!validRunId(runId)) return resultError('INVALID_RUN_ID');
    try {
      return finishTransaction(() => {
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        let result = readResultRow(runId);
        if (!result) return resultError('RESULT_NOT_FOUND', { run: run });
        if (result.status === 'available' && result.expiresAt <= now()) {
          const at = now();
          db.prepare(SQL.expireResult).run('expired', at, runId, 'available');
          result = readResultRow(runId);
        }
        return { ok: true, run: run, result: result };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function getAuthorizedResultReference(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!hasExactKeys(input, ['currentRunId', 'resultRunId', 'resultId'])) return resultError('INVALID_REQUEST');
    const currentRunId = String(input.currentRunId || '');
    const resultRunId = String(input.resultRunId || '');
    const resultId = String(input.resultId || '');
    if (!validRunId(currentRunId) || !validRunId(resultRunId) || !RESULT_ID_RE.test(resultId)) {
      return resultError('INVALID_REQUEST');
    }
    try {
      const currentRun = readRunRow(currentRunId);
      if (!currentRun) return resultError('RUN_NOT_FOUND');
      if (currentRun.status !== STATUS.RUNNING && currentRun.status !== STATUS.COMPLETED) {
        return resultError('RESULT_REFERENCE_DENIED');
      }
      const resultRun = readRunRow(resultRunId);
      if (!resultRun) return resultError('RESULT_REFERENCE_UNAVAILABLE');
      if (resultRun.projectRef !== currentRun.projectRef) return resultError('RESULT_REFERENCE_DENIED');

      /* This comparison-only read intentionally does not call getResult(): that API
         expires stale artifacts as a read side effect. */
      const row = db.prepare(SQL.readResult).get(resultRunId);
      if (!row || String(row.result_id) !== resultId) return resultError('RESULT_REFERENCE_UNAVAILABLE');
      const result = rowToResult(row);
      if (!result || result.status !== 'available' || result.expiresAt <= now() || !result.report) {
        return resultError('RESULT_NOT_AVAILABLE');
      }
      return {
        ok: true,
        currentRun: { runId: currentRun.runId, projectRef: currentRun.projectRef, status: currentRun.status },
        run: { runId: resultRun.runId, projectRef: resultRun.projectRef,
          workflowId: resultRun.workflowId, status: resultRun.status, createdAt: resultRun.createdAt },
        result: {
          resultId: result.resultId, runId: result.runId,
          schemaVersion: result.schemaVersion, status: result.status, report: result.report,
          createdAt: result.createdAt, expiresAt: result.expiresAt
        }
      };
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function deleteResult(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!hasExactKeys(input, ['runId', 'requestId', 'expectedVersion'])) return resultError('INVALID_REQUEST');
    const runId = String(input.runId || '');
    const requestId = String(input.requestId || '');
    const expectedVersion = Number(input.expectedVersion);
    if (!validRunId(runId) || !REQUEST_ID_RE.test(requestId)
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return resultError('INVALID_REQUEST');
    const requestKeyHash = idempotencyKey('delete_result', runId, requestId);
    const requestHash = hash(stableStringify({ expectedVersion: expectedVersion }));
    try {
      return finishTransaction(() => {
        const duplicate = findIdempotent(requestKeyHash, requestHash, 'delete_result');
        if (duplicate) return { ok: true, duplicate: true, run: duplicate.run, result: readResultRow(runId) };
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        if (run.version !== expectedVersion) return resultError('VERSION_CONFLICT', { run: run });
        if (run.status !== STATUS.COMPLETED) return resultError('INVALID_TRANSITION', { run: run });
        let result = readResultRow(runId);
        if (!result) return resultError('RESULT_NOT_FOUND', { run: run });
        const at = now();
        if (result.status === 'available') {
          db.prepare(SQL.deleteResult).run('deleted', at, runId, 'available');
          result = readResultRow(runId);
        }
        writeIdempotency(requestKeyHash, requestHash, 'delete_result', run, at);
        return { ok: true, duplicate: false, noOp: result.status !== 'deleted' || result.deletedAt !== at, run: run, result: result };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function retentionPolicy() {
    return {
      resultRetentionMs: RESULT_RETENTION_MS,
      runRetentionMs: RUN_RETENTION_MS,
      consentRetentionMs: RUN_RETENTION_MS,
      idempotencyReplayRetentionMs: RUN_RETENTION_MS,
      maxCleanupBatch: MAX_CLEANUP_BATCH,
      resultExpiresFrom: 'completed_at',
      runExpiresFrom: 'terminal_updated_at',
      activeRunsDeleted: false,
      resultDeleteKeepsRun: true,
      terminalRunPurgeIsAggregate: true,
      eventsPurgedWithRun: true,
      idempotencyPurgedWithRun: true,
      cleanupScheduled: false
    };
  }

  function cleanupExpired(options) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    options = options || {};
    const requestedLimit = options.limit == null ? MAX_CLEANUP_BATCH : Number(options.limit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_CLEANUP_BATCH) {
      return resultError('INVALID_QUERY');
    }
    try {
      return finishTransaction(() => {
        const at = now();
        const expired = db.prepare(SQL.listExpiredResults).all('available', at, requestedLimit);
        let resultsExpired = 0;
        for (const row of expired) {
          const changed = db.prepare(SQL.expireResult).run('expired', at, String(row.run_id), 'available');
          resultsExpired += Number(changed.changes) === 1 ? 1 : 0;
        }
        const purgeBefore = at - RUN_RETENTION_MS;
        const terminalRuns = db.prepare(SQL.listPurgeRuns).all(
          STATUS.COMPLETED, STATUS.FAILED, STATUS.CANCELLED, purgeBefore, requestedLimit
        );
        for (const row of terminalRuns) {
          const runId = String(row.run_id);
          db.prepare(SQL.deleteRunConsents).run(runId);
          db.prepare(SQL.deleteRunIdempotency).run(runId);
          db.prepare(SQL.deleteRunEvents).run(runId);
          db.prepare(SQL.deleteRunResult).run(runId);
          db.prepare(SQL.deleteRun).run(runId);
        }
        return {
          ok: true,
          resultsExpired: resultsExpired,
          terminalRunsPurged: terminalRuns.length,
          limitPerCollection: requestedLimit,
          activeRunsPreserved: true
        };
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function transition(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!hasExactKeys(input, ['runId', 'requestId', 'expectedVersion', 'status', 'reasonCode'])) {
      return resultError('INVALID_REQUEST');
    }
    const runId = String(input.runId || '');
    const requestId = String(input.requestId || '');
    const expectedVersion = Number(input.expectedVersion);
    const toStatus = String(input.status || '');
    const reasonCode = String(input.reasonCode || '');
    if (!validRunId(runId) || !REQUEST_ID_RE.test(requestId)
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1
      || Object.values(STATUS).indexOf(toStatus) < 0 || !REASON_CODES.includes(reasonCode)) {
      return resultError('INVALID_REQUEST');
    }
    if (toStatus === STATUS.COMPLETED) return resultError('RESULT_REQUIRED');
    const requestKeyHash = idempotencyKey('transition', runId, requestId);
    const requestHash = hash(stableStringify({ expectedVersion: expectedVersion, status: toStatus, reasonCode: reasonCode }));
    try {
      return finishTransaction(() => {
        const duplicate = findIdempotent(requestKeyHash, requestHash, 'transition');
        if (duplicate) return duplicate;
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        if (run.version !== expectedVersion) return resultError('VERSION_CONFLICT', { run: run });
        if (!canTransition(run.status, toStatus, reasonCode)) return resultError('INVALID_TRANSITION', { run: run });
        return persistTransition(run, toStatus, reasonCode, 'transition', requestId, requestHash, requestKeyHash);
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function cancel(input) {
    if (!opened) return resultError('STORE_UNAVAILABLE');
    if (!hasExactKeys(input, ['runId', 'requestId', 'expectedVersion'])) return resultError('INVALID_REQUEST');
    const runId = String(input.runId || '');
    const requestId = String(input.requestId || '');
    const expectedVersion = Number(input.expectedVersion);
    if (!validRunId(runId) || !REQUEST_ID_RE.test(requestId)
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      return resultError('INVALID_REQUEST');
    }
    const requestKeyHash = idempotencyKey('cancel', runId, requestId);
    const requestHash = hash(stableStringify({ expectedVersion: expectedVersion }));
    try {
      return finishTransaction(() => {
        const duplicate = findIdempotent(requestKeyHash, requestHash, 'cancel');
        if (duplicate) return duplicate;
        const run = readRunRow(runId);
        if (!run) return resultError('RUN_NOT_FOUND');
        if (run.version !== expectedVersion) return resultError('VERSION_CONFLICT', { run: run });
        if (TERMINAL.indexOf(run.status) >= 0) return resultError('RUN_TERMINAL', { run: run });
        if (run.status === STATUS.CANCEL_REQUESTED) {
          return { ok: true, duplicate: false, noOp: true, run: run };
        }
        const toStatus = run.status === STATUS.QUEUED ? STATUS.CANCELLED : STATUS.CANCEL_REQUESTED;
        const reasonCode = 'user_cancelled';
        const result = persistTransition(run, toStatus, reasonCode, 'cancel', requestId, requestHash, requestKeyHash);
        if (result.ok) result.cancelRequested = toStatus === STATUS.CANCEL_REQUESTED;
        return result;
      });
    } catch (_) { return resultError('STORE_UNAVAILABLE'); }
  }

  function describe() {
    return {
      available: opened,
      schemaVersion: opened ? SCHEMA_VERSION : null,
      reason: opened ? null : openFailure || 'store-not-open'
    };
  }

  return Object.freeze({
    open: open,
    close: close,
    isOpen: function () { return opened; },
    describe: describe,
    createRun: createRun,
    pinExecutorSelection: pinExecutorSelection,
    bindDshSession: bindDshSession,
    getDshSession: getDshSession,
    getRun: getRun,
    listActive: listActive,
    listResults: listResults,
    listEvents: listEvents,
    recordActionTrace: recordActionTrace,
    transition: transition,
    cancel: cancel,
    grantConsent: grantConsent,
    getConsent: getConsent,
    getMemoryProvenance: getMemoryProvenance,
    checkConsent: checkConsent,
    revokeConsent: revokeConsent,
    completeRun: completeRun,
    getResult: getResult,
    getAuthorizedResultReference: getAuthorizedResultReference,
    deleteResult: deleteResult,
    retentionPolicy: retentionPolicy,
    cleanupExpired: cleanupExpired
  });
}

module.exports = createWorkRunStore;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
module.exports.WORKFLOW_ID = WORKFLOW_ID;
module.exports.APP_BUILDER_WORKFLOW_ID = APP_BUILDER_WORKFLOW_ID;
module.exports.CODING_WORKFLOW_ID = CODING_WORKFLOW_ID;
module.exports.STATUS = STATUS;
module.exports.TERMINAL = TERMINAL;
module.exports.MAX_EVENTS_PAGE = MAX_EVENTS_PAGE;
module.exports.MAX_ACTIVE_RUNS_PAGE = MAX_ACTIVE_RUNS_PAGE;
module.exports.MAX_CONSENT_FILES = MAX_CONSENT_FILES;
module.exports.MAX_CLEANUP_BATCH = MAX_CLEANUP_BATCH;
module.exports.MAX_CONSENT_TTL_MS = MAX_CONSENT_TTL_MS;
module.exports.RESULT_RETENTION_MS = RESULT_RETENTION_MS;
module.exports.RUN_RETENTION_MS = RUN_RETENTION_MS;
module.exports.CONSENT_TERMS_VERSION = CONSENT_TERMS_VERSION;
