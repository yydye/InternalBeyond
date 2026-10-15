'use strict';

/* Ephemeral Home Node ↔ desktop bridge for the existing Work Mode Project Tool. */

const crypto = require('node:crypto');
const createReadOnlyProjectTool = require('../../assets/js/work-mode-project-tool.js');

const MAX_PENDING = 16;
const MAX_WAITERS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESULT_BYTES = 1024 * 1024;
const PROJECT_REF_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const HASH_RE = /^[a-f0-9]{64}$/i;

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeError(value) {
  const error = String(value || 'workspace-unavailable');
  return /^[a-z0-9_-]{1,80}$/i.test(error) ? error : 'workspace-unavailable';
}

function normalizeScope(value, projectRef) {
  if (!record(value) || value.projectRef !== projectRef || !Array.isArray(value.files) || value.files.length > 200) return null;
  const seen = new Set();
  const files = [];
  for (const item of value.files) {
    if (!record(item) || !IDENTIFIER_RE.test(String(item.fileId || ''))
      || typeof item.path !== 'string' || item.path.length > 400
      || !Number.isSafeInteger(Number(item.size)) || Number(item.size) < 0
      || !HASH_RE.test(String(item.contentHash || '')) || seen.has(item.fileId)) return null;
    seen.add(item.fileId);
    files.push({ fileId: item.fileId, path: item.path, size: Number(item.size), contentHash: item.contentHash,
      lastModified: Number.isSafeInteger(Number(item.lastModified)) ? Number(item.lastModified) : 0 });
  }
  return { projectRef: projectRef, files: files };
}

function createWorkspaceProjectBridge(options) {
  options = options || {};
  const requestTimeoutMs = Number.isSafeInteger(options.requestTimeoutMs)
    ? Math.max(1000, Math.min(options.requestTimeoutMs, 60_000))
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const pending = new Map();
  const queue = [];
  const waiters = [];
  let closed = false;

  function finish(job, error, result) {
    if (!job || !pending.has(job.requestId)) return false;
    pending.delete(job.requestId);
    if (job.timer) clearTimeout(job.timer);
    if (job.signal && job.abort) job.signal.removeEventListener('abort', job.abort);
    if (error) job.reject(error);
    else job.resolve(result);
    return true;
  }

  function nextJob() {
    while (queue.length) {
      const requestId = queue.shift();
      const job = pending.get(requestId);
      if (job && !job.delivered) {
        job.delivered = true;
        return job;
      }
    }
    return null;
  }

  function dispatch() {
    while (waiters.length && queue.length) {
      const waiter = waiters.shift();
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      if (!waiter.res || (!waiter.res.destroyed && !waiter.res.writableEnded)) {
        const job = nextJob();
        waiter.resolve({ ok: true, job: job ? { requestId: job.requestId, operation: job.operation, input: job.input } : null });
      }
    }
  }

  function request(operation, input, signal) {
    if (closed) return Promise.reject(new Error('workspace-bridge-closed'));
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error('workspace-bridge-busy'));
    if (signal && signal.aborted) return Promise.reject(new Error('workspace-request-cancelled'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const job = { requestId, operation, input, resolve, reject, signal, abort: null, timer: null, delivered: false };
      job.timer = setTimeout(() => finish(job, new Error('workspace-request-timeout')), requestTimeoutMs);
      if (signal) {
        job.abort = () => finish(job, new Error('workspace-request-cancelled'));
        signal.addEventListener('abort', job.abort, { once: true });
      }
      pending.set(requestId, job);
      queue.push(requestId);
      dispatch();
    });
  }

  function projectToolFactory() {
    const snapshots = new Map();
    const activeSignals = new Map();
    const workspace = {
      async wsGetWorkModeProjectSnapshot(projectRef) {
        if (!PROJECT_REF_RE.test(String(projectRef || ''))) return { ok: false, error: 'invalid-project-ref' };
        const result = await request('snapshot', { projectRef: projectRef }, activeSignals.get('snapshot:' + projectRef));
        if (result && result.ok === true && result.projectRef === projectRef && Array.isArray(result.files)) {
          snapshots.set(projectRef, result.files);
        }
        return result;
      },
      wsReadWorkModeFile(projectRef, fileId) {
        const snapshot = snapshots.get(projectRef) || [];
        const grant = snapshot.find(file => file && file.fileId === fileId);
        if (!grant) return Promise.resolve({ ok: false, error: 'scope-denied' });
        return request('read_file', {
          projectRef: projectRef,
          fileId: fileId,
          scope: { projectRef: projectRef, files: [grant] }
        }, activeSignals.get('read:' + projectRef + ':' + fileId));
      },
      wsReadWorkModeFileForWrite(projectRef, fileId, requestedGrant) {
        const snapshot = snapshots.get(projectRef) || [];
        const grant = snapshot.find(file => file && file.fileId === fileId);
        if (!grant || !record(requestedGrant) || requestedGrant.fileId !== grant.fileId
          || requestedGrant.path !== grant.path || requestedGrant.contentHash !== grant.contentHash) {
          return Promise.resolve({ ok: false, error: 'scope-denied' });
        }
        return request('write_preflight_read', {
          projectRef: projectRef, fileId: fileId, scope: { projectRef: projectRef, files: [grant] }
        }, activeSignals.get('write:' + projectRef));
      },
      wsWriteWorkModeFile(input) {
        input = record(input) ? input : {};
        const projectRef = String(input.projectRef || '');
        const scope = normalizeScope(input.scope, projectRef);
        if (!PROJECT_REF_RE.test(projectRef) || !scope || typeof input.content !== 'string'
          || Buffer.byteLength(input.content, 'utf8') > 131072) return Promise.resolve({ ok: false, error: 'invalid-request' });
        const signal = activeSignals.get('write:' + projectRef);
        if (input.operation === 'update') {
          const grant = scope.files.find(file => file.fileId === input.fileId);
          if (!grant || input.path !== grant.path || input.expectedHash !== grant.contentHash
            || Number(input.expectedLastModified) !== grant.lastModified) return Promise.resolve({ ok: false, error: 'scope-denied' });
          return request('update_file', { projectRef, fileId: grant.fileId, path: grant.path,
            content: input.content, expectedHash: grant.contentHash, expectedLastModified: grant.lastModified,
            scope: { projectRef, files: [grant] } }, signal);
        }
        if (input.operation === 'create') {
          const anchor = scope.files.find(file => file.fileId === input.anchorFileId);
          if (!anchor || typeof input.path !== 'string' || input.path.length > 400
            || typeof input.anchorPath !== 'string' || input.anchorPath !== anchor.path) return Promise.resolve({ ok: false, error: 'scope-denied' });
          return request('create_file', { projectRef, anchorFileId: anchor.fileId, anchorPath: anchor.path,
            path: input.path, content: input.content,
            scope: { projectRef, files: [anchor] } }, signal);
        }
        return Promise.resolve({ ok: false, error: 'operation-denied' });
      },
      wsRollbackWorkModeFile(change) {
        if (!record(change) || !PROJECT_REF_RE.test(String(change.projectRef || ''))
          || !IDENTIFIER_RE.test(String(change.fileId || '')) || typeof change.path !== 'string'
          || typeof change.afterContent !== 'string' || typeof change.beforeContent !== 'string'
          || !HASH_RE.test(String(change.afterHash || '')) || !Number.isSafeInteger(Number(change.afterLastModified))) {
          return Promise.resolve({ ok: false, error: 'invalid-rollback' });
        }
        return request('write_rollback', {
          operation: change.operation, projectRef: change.projectRef, fileId: change.fileId, path: change.path,
          beforeContent: change.beforeContent, afterContent: change.afterContent, afterHash: change.afterHash,
          afterLastModified: Number(change.afterLastModified)
        });
      }
    };
    const tool = createReadOnlyProjectTool({
      workspace: workspace,
      maxFiles: 200,
      maxFileBytes: 131072,
      maxTotalReadBytes: 524288,
      allowWrites: true,
      maxWriteCalls: 12
    });
    return Object.freeze({
      snapshot(projectRef, options) {
        const key = 'snapshot:' + projectRef;
        if (options && options.signal) activeSignals.set(key, options.signal);
        return Promise.resolve(tool.snapshot(projectRef)).finally(() => activeSignals.delete(key));
      },
      readFile(input) {
        input = record(input) ? input : {};
        const key = 'read:' + String(input.projectRef || '') + ':' + String(input.fileId || '');
        if (input.signal) activeSignals.set(key, input.signal);
        return Promise.resolve(tool.readFile(input)).finally(() => activeSignals.delete(key));
      },
      createFile(input) {
        input = record(input) ? input : {};
        const key = 'write:' + String(input.projectRef || '');
        if (input.signal) activeSignals.set(key, input.signal);
        return Promise.resolve(tool.createFile(input)).finally(() => activeSignals.delete(key));
      },
      updateFile(input) {
        input = record(input) ? input : {};
        const key = 'write:' + String(input.projectRef || '');
        if (input.signal) activeSignals.set(key, input.signal);
        return Promise.resolve(tool.updateFile(input)).finally(() => activeSignals.delete(key));
      },
      rollback: tool.rollback,
      commitChanges: tool.commitChanges,
      limits: tool.limits
    });
  }

  function poll(options) {
    options = options || {};
    const waitMs = Number.isSafeInteger(options.waitMs) ? Math.max(0, Math.min(options.waitMs, 25_000)) : 0;
    if (closed) return Promise.resolve({ ok: false, error: 'workspace-bridge-closed' });
    const job = nextJob();
    if (job) return Promise.resolve({ ok: true, job: { requestId: job.requestId, operation: job.operation, input: job.input } });
    if (!waitMs) return Promise.resolve({ ok: true, job: null });
    if (waiters.length >= MAX_WAITERS) return Promise.resolve({ ok: false, error: 'workspace-bridge-busy' });
    return new Promise(resolve => {
      const waiter = { resolve, res: options.response || null, signal: options.signal || null, timer: null, abort: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
        resolve({ ok: true, job: null });
      }, waitMs);
      if (waiter.signal) {
        waiter.abort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve({ ok: false, error: 'workspace-poll-cancelled' });
        };
        waiter.signal.addEventListener('abort', waiter.abort, { once: true });
      }
      waiters.push(waiter);
      dispatch();
    });
  }

  function resolveRequest(requestId, rawResult) {
    const job = pending.get(String(requestId || ''));
    if (!job || !job.delivered || !record(rawResult)) return { ok: false, error: 'workspace-request-not-found' };
    let size;
    try { size = Buffer.byteLength(JSON.stringify(rawResult), 'utf8'); }
    catch (_) { return { ok: false, error: 'workspace-result-invalid' }; }
    if (size > MAX_RESULT_BYTES) return { ok: false, error: 'workspace-result-too-large' };
    if (rawResult.ok !== true) {
      finish(job, null, { ok: false, error: safeError(rawResult.error) });
      return { ok: true };
    }
    if (job.operation === 'snapshot') {
      if (rawResult.projectRef !== job.input.projectRef || !Array.isArray(rawResult.files) || rawResult.files.length > 200) {
        return { ok: false, error: 'workspace-result-invalid' };
      }
      const seen = new Set();
      const files = [];
      for (const file of rawResult.files) {
        if (!record(file) || typeof file.fileId !== 'string' || !IDENTIFIER_RE.test(file.fileId)
          || typeof file.path !== 'string' || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0
          || !HASH_RE.test(String(file.contentHash || '')) || seen.has(file.fileId)) {
          return { ok: false, error: 'workspace-result-invalid' };
        }
        seen.add(file.fileId);
        files.push({ fileId: file.fileId, path: file.path, size: Number(file.size), contentHash: file.contentHash,
          lastModified: Number.isSafeInteger(Number(file.lastModified)) ? Number(file.lastModified) : 0 });
      }
      finish(job, null, { ok: true, projectRef: job.input.projectRef, files });
      return { ok: true };
    }
    if (job.operation === 'write_preflight_read') {
      const grant = normalizeScope(job.input.scope, job.input.projectRef);
      const file = grant && grant.files.find(item => item.fileId === job.input.fileId);
      if (!file || rawResult.projectRef !== job.input.projectRef || rawResult.fileId !== job.input.fileId
        || rawResult.path !== file.path || rawResult.contentHash !== file.contentHash
        || typeof rawResult.content !== 'string' || rawResult.content.length > 131072
        || !Number.isSafeInteger(Number(rawResult.lastModified)) || Number(rawResult.lastModified) !== file.lastModified) {
        return { ok: false, error: 'workspace-result-invalid' };
      }
      finish(job, null, { ok: true, projectRef: job.input.projectRef, fileId: job.input.fileId, path: file.path,
        content: rawResult.content, contentHash: file.contentHash, size: Buffer.byteLength(rawResult.content, 'utf8'),
        lastModified: file.lastModified });
      return { ok: true };
    }
    if (job.operation === 'update_file' || job.operation === 'create_file') {
      const grant = normalizeScope(job.input.scope, job.input.projectRef);
      const anchor = grant && grant.files[0];
      const targetPath = job.operation === 'update_file' ? anchor && anchor.path : String(job.input.path || '');
      const targetId = job.operation === 'update_file' ? String(job.input.fileId || '') : String(rawResult.fileId || '');
      if (!anchor || !targetPath || rawResult.projectRef !== job.input.projectRef
        || rawResult.path !== targetPath || !IDENTIFIER_RE.test(targetId)
        || (job.operation === 'update_file' && targetId !== anchor.fileId)
        || !HASH_RE.test(String(rawResult.contentHash || ''))
        || !Number.isSafeInteger(Number(rawResult.lastModified)) || Number(rawResult.lastModified) < 0) {
        return { ok: false, error: 'workspace-result-invalid' };
      }
      finish(job, null, { ok: true, projectRef: job.input.projectRef, fileId: targetId, path: targetPath,
        contentHash: String(rawResult.contentHash), lastModified: Number(rawResult.lastModified),
        size: Number(rawResult.size) || 0 });
      return { ok: true };
    }
    if (job.operation === 'write_rollback') {
      if (rawResult.status !== 'rolled-back') return { ok: false, error: 'workspace-result-invalid' };
      finish(job, null, { ok: true, status: 'rolled-back' });
      return { ok: true };
    }
    const grant = normalizeScope(job.input.scope, job.input.projectRef);
    const allowedFile = grant && grant.files.find(file => file.fileId === job.input.fileId);
    if (!allowedFile || rawResult.projectRef !== job.input.projectRef
      || rawResult.fileId !== job.input.fileId || rawResult.path !== allowedFile.path
      || rawResult.contentHash !== allowedFile.contentHash || typeof rawResult.path !== 'string'
      || typeof rawResult.content !== 'string' || rawResult.content.length > MAX_RESULT_BYTES) {
      return { ok: false, error: 'workspace-result-invalid' };
    }
    finish(job, null, {
      ok: true,
      projectRef: job.input.projectRef,
      fileId: job.input.fileId,
      path: rawResult.path,
      content: rawResult.content,
      contentHash: rawResult.contentHash,
      size: Number(rawResult.size) || Buffer.byteLength(rawResult.content, 'utf8'),
      bytesRead: Number(rawResult.bytesRead) || Buffer.byteLength(rawResult.content, 'utf8'),
      redactedSecrets: Number(rawResult.redactedSecrets) || 0,
      lastModified: Number.isSafeInteger(Number(rawResult.lastModified)) ? Number(rawResult.lastModified) : 0
    });
    return { ok: true };
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const job of Array.from(pending.values())) finish(job, new Error('workspace-bridge-closed'));
    for (const waiter of waiters.splice(0)) {
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve({ ok: false, error: 'workspace-bridge-closed' });
    }
    queue.length = 0;
  }

  return Object.freeze({
    createProjectTool: projectToolFactory,
    poll,
    resolve: resolveRequest,
    close,
    describe: () => Object.freeze({ pending: pending.size, waiters: waiters.length, durable: false })
  });
}

module.exports = createWorkspaceProjectBridge;
