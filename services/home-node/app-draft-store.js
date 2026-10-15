'use strict';

/* Home Node authority for small, isolated DSH generated app drafts.
   This is a draft workspace, not an App Store or source-project filesystem. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILES = Object.freeze(['index.html', 'styles.css', 'app.js']);
const WORKFLOW_ID = 'app.builder';
const DRAFT_ID_RE = /^ad_[A-Fa-f0-9-]{36}$/;
const RUN_ID_RE = /^wr_[A-Za-z0-9-]{36}$/;
const PROJECT_REF_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const FILE_LIMIT = 24 * 1024;
const TOTAL_LIMIT = 64 * 1024;
const INSTRUCTION_LIMIT = 2400;
const MAX_DRAFTS = 64;
const MAX_RUNS_PER_DRAFT = 16;

function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\u0000/g, '').trim();
  return text && text.length <= max ? text : null;
}
function safeFileName(value) { return typeof value === 'string' && FILES.includes(value); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validFiles(files) {
  return isRecord(files) && Object.entries(files).every(([name, content]) => safeFileName(name)
    && typeof content === 'string' && Buffer.byteLength(content, 'utf8') <= FILE_LIMIT)
    && FILES.reduce((sum, name) => sum + Buffer.byteLength(String(files[name] || ''), 'utf8'), 0) <= TOTAL_LIMIT;
}

function createAppDraftStore(options) {
  options = options || {};
  if (typeof options.dataDir !== 'string' || !options.dataDir.trim()) throw new Error('app-draft-data-dir-required');
  const dataDir = path.resolve(options.dataDir);
  const filePath = path.join(dataDir, 'app-drafts.json');
  let state = { schemaVersion: 1, drafts: Object.create(null) };

  function validateLoaded(value) {
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.drafts)) throw new Error('app-draft-store-invalid');
    for (const [draftRef, draft] of Object.entries(value.drafts)) {
      if (!DRAFT_ID_RE.test(draftRef) || !isRecord(draft) || draft.draftRef !== draftRef
        || !PROJECT_REF_RE.test(String(draft.projectRef || '')) || !isRecord(draft.files)
        || !isRecord(draft.runs)) throw new Error('app-draft-store-invalid');
      if (!validFiles(draft.files)) throw new Error('app-draft-store-invalid');
      if (!Array.isArray(draft.history)) draft.history = [];
      for (const version of draft.history) {
        if (!isRecord(version) || !Number.isSafeInteger(version.version) || version.version < 0
          || !validFiles(version.files) || !Array.isArray(version.changedPaths)) throw new Error('app-draft-store-invalid');
      }
      for (const run of Object.values(draft.runs)) {
        if (!isRecord(run) || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(run.status)) {
          throw new Error('app-draft-store-invalid');
        }
        if (run.workingFiles !== undefined && !validFiles(run.workingFiles)) throw new Error('app-draft-store-invalid');
        if (run.baseFiles !== undefined && !validFiles(run.baseFiles)) throw new Error('app-draft-store-invalid');
        if (run.changes !== undefined && !isRecord(run.changes)) throw new Error('app-draft-store-invalid');
      }
      if (!draft.history.length) {
        const orderedRuns = Object.entries(draft.runs).sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
        const newestRun = orderedRuns.length ? orderedRuns[orderedRuns.length - 1] : null;
        const recoverUncommittedTail = !!(newestRun && newestRun[1].status !== 'completed');
        const working = clone(draft.files);
        let workingVersion = Number(draft.version) || 0;
        let latestCommittedFiles = null, latestCommittedVersion = null;
        const reconstructed = [];
        function undoRunChanges(run) {
          for (const [pathname, change] of Object.entries(run && run.changes || {})) {
            if (!safeFileName(pathname) || !isRecord(change) || !Object.prototype.hasOwnProperty.call(change, 'before')) continue;
            if (change.before == null) delete working[pathname]; else if (typeof change.before === 'string') working[pathname] = change.before;
          }
          if (Number.isSafeInteger(run && run.startedVersion) && run.startedVersion >= 0) workingVersion = run.startedVersion;
        }
        for (const [runId, run] of orderedRuns.slice().reverse()) {
          const changedPaths = Object.keys(run.changes || {}).filter(pathname => {
            const change = run.changes[pathname]; return safeFileName(pathname) && isRecord(change) && change.before !== change.after;
          });
          if (run.status === 'completed') {
            if (changedPaths.length) {
              const entry = { version: workingVersion, runId: runId, instruction: run.instruction,
                changedPaths: changedPaths, committedAt: Number(run.finishedAt || run.updatedAt || run.createdAt) || Date.now(), files: clone(working) };
              if (!reconstructed.some(item => item.version === entry.version)) reconstructed.push(entry);
              if (latestCommittedFiles === null) { latestCommittedFiles = clone(working); latestCommittedVersion = workingVersion; }
            }
            undoRunChanges(run);
          } else undoRunChanges(run);
        }
        if (recoverUncommittedTail) {
          draft.files = latestCommittedFiles === null ? clone(working) : latestCommittedFiles;
          draft.version = latestCommittedVersion === null ? workingVersion : latestCommittedVersion;
        }
        reconstructed.reverse();
        if (!reconstructed.some(item => item.version === workingVersion)) {
          reconstructed.unshift({ version: workingVersion, runId: '', instruction: '初始草稿基线', changedPaths: [],
            committedAt: Number(draft.createdAt) || Date.now(), files: clone(working) });
        }
        if (!reconstructed.length) reconstructed.push({ version: Number(draft.version) || 0, runId: '', instruction: '当前草稿基线',
          changedPaths: [], committedAt: Number(draft.updatedAt) || Date.now(), files: clone(draft.files) });
        draft.history = reconstructed.sort((a, b) => a.version - b.version);
      }
    }
    return { schemaVersion: 1, drafts: value.drafts };
  }

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = filePath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, filePath);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch (_) {}
      throw error;
    }
  }

  function open() {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(filePath)) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
      catch (_) { throw new Error('app-draft-store-invalid'); }
      state = validateLoaded(parsed);
    } else persist();
    return { ok: true, schemaVersion: 1 };
  }

  function draftFor(draftRef, projectRef) {
    if (!DRAFT_ID_RE.test(String(draftRef || '')) || !PROJECT_REF_RE.test(String(projectRef || ''))) return null;
    const draft = state.drafts[draftRef];
    return draft && draft.projectRef === projectRef ? draft : null;
  }

  function summary(draft) {
    return {
      draftRef: draft.draftRef,
      projectRef: draft.projectRef,
      name: draft.name,
      version: draft.version,
      files: FILES.filter(name => Object.prototype.hasOwnProperty.call(draft.files, name)).map(name => ({
        path: name,
        bytes: Buffer.byteLength(draft.files[name], 'utf8'),
        sha256: crypto.createHash('sha256').update(draft.files[name], 'utf8').digest('hex')
      })),
      history: (draft.history || []).map(version => ({ version: version.version, runId: version.runId || '',
        instruction: version.instruction || '', changedPaths: version.changedPaths.slice(),
        committedAt: version.committedAt, restoredFrom: Number.isSafeInteger(version.restoredFrom) ? version.restoredFrom : null })),
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt
    };
  }

  function create(input) {
    if (!isRecord(input) || Object.keys(input).some(key => key !== 'projectRef' && key !== 'name')) return { ok: false, error: 'invalid-request' };
    const projectRef = String(input.projectRef || '');
    const name = cleanText(String(input.name || 'Todo'), 48) || 'Todo';
    if (!PROJECT_REF_RE.test(projectRef)) return { ok: false, error: 'invalid-project-ref' };
    if (Object.keys(state.drafts).length >= MAX_DRAFTS) return { ok: false, error: 'app-draft-count-limit' };
    const draftRef = 'ad_' + crypto.randomUUID();
    const now = Date.now();
    const draft = { draftRef, projectRef, name, version: 0, files: Object.create(null), runs: Object.create(null),
      history: [{ version: 0, runId: '', instruction: '初始草稿', changedPaths: [], committedAt: now, files: Object.create(null) }],
      lastRunId: '', createdAt: now, updatedAt: now };
    state.drafts[draftRef] = draft;
    try { persist(); } catch (_) { delete state.drafts[draftRef]; return { ok: false, error: 'app-draft-persist-failed' }; }
    return { ok: true, draft: summary(draft) };
  }

  function list(projectRef) {
    if (!PROJECT_REF_RE.test(String(projectRef || ''))) return { ok: false, error: 'invalid-project-ref' };
    const drafts = Object.values(state.drafts).filter(draft => draft.projectRef === projectRef)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30).map(summary);
    return { ok: true, drafts };
  }

  function get(input) {
    if (!isRecord(input) || Object.keys(input).some(key => key !== 'draftRef' && key !== 'projectRef' && key !== 'runId')) {
      return { ok: false, error: 'invalid-request' };
    }
    const draft = draftFor(String(input.draftRef || ''), String(input.projectRef || ''));
    if (!draft) return { ok: false, error: 'app-draft-not-found' };
    const runId = String(input.runId || '');
    if (runId && (!RUN_ID_RE.test(runId) || !draft.runs[runId])) return { ok: false, error: 'app-draft-run-not-found' };
    const run = runId && RUN_ID_RE.test(runId) ? draft.runs[runId] : null;
    const visibleRunId = runId || draft.lastRunId;
    const visibleRun = run || (draft.lastRunId ? draft.runs[draft.lastRunId] : null);
    const visibleFiles = run && ['queued', 'running'].includes(run.status)
      ? (run.workingFiles || draft.files) : draft.files;
    const newestVersion = draft.history[draft.history.length - 1];
    const changes = visibleRun && visibleRun.changes && newestVersion && newestVersion.runId === visibleRunId
      ? clone(visibleRun.changes) : {};
    return { ok: true, draft: Object.assign(summary(draft), {
      files: clone(visibleFiles),
      changes: changes,
      history: summary(draft).history,
      request: run ? run.instruction : '',
      lastRunId: draft.lastRunId,
      runStatus: run ? run.status : (visibleRun && visibleRun.status || '')
    }) };
  }

  function getVersion(input) {
    if (!isRecord(input) || Object.keys(input).some(key => key !== 'draftRef' && key !== 'projectRef' && key !== 'version')) {
      return { ok: false, error: 'invalid-request' };
    }
    const draft = draftFor(String(input.draftRef || ''), String(input.projectRef || ''));
    const versionNumber = Number(input.version);
    if (!draft || !Number.isSafeInteger(versionNumber) || versionNumber < 0) return { ok: false, error: 'invalid-app-draft-version' };
    const version = (draft.history || []).find(item => item && item.version === versionNumber);
    if (!version || !validFiles(version.files)) return { ok: false, error: 'app-draft-version-not-found' };
    return { ok: true, draftRef: draft.draftRef, projectRef: draft.projectRef, name: draft.name,
      version: version.version, files: clone(version.files) };
  }

  function queueRun(input) {
    if (!isRecord(input) || Object.keys(input).some(key => !['draftRef', 'projectRef', 'runId', 'instruction'].includes(key))) {
      return { ok: false, error: 'invalid-request' };
    }
    const draft = draftFor(String(input.draftRef || ''), String(input.projectRef || ''));
    const runId = String(input.runId || ''), instruction = cleanText(input.instruction, INSTRUCTION_LIMIT);
    if (!draft || !RUN_ID_RE.test(runId) || !instruction) return { ok: false, error: 'invalid-app-draft-run' };
    const existing = draft.runs[runId];
    if (existing) return existing.instruction === instruction ? { ok: true, duplicate: true, draft: summary(draft) } : { ok: false, error: 'app-draft-run-conflict' };
    if (Object.entries(draft.runs).some(([id, run]) => id !== runId && run && ['queued', 'running'].includes(run.status))) {
      return { ok: false, error: 'app-draft-run-active' };
    }
    const runEntries = Object.entries(draft.runs).sort((a, b) => Number(a[1].createdAt || 0) - Number(b[1].createdAt || 0));
    const prunedRuns = [];
    const previousLastRunId = draft.lastRunId;
    const previousUpdatedAt = draft.updatedAt;
    while (runEntries.length >= MAX_RUNS_PER_DRAFT) {
      const removable = runEntries.findIndex(([, run]) => run && ['completed', 'failed', 'cancelled'].includes(run.status));
      if (removable < 0) return { ok: false, error: 'app-draft-run-limit' };
      const [oldRunId, oldRun] = runEntries.splice(removable, 1)[0];
      prunedRuns.push([oldRunId, oldRun]);
      delete draft.runs[oldRunId];
    }
    draft.runs[runId] = { instruction, status: 'queued', changes: Object.create(null),
      baseVersion: draft.version, baseFiles: clone(draft.files), workingFiles: clone(draft.files), pendingRevision: 0, createdAt: Date.now() };
    draft.lastRunId = runId;
    draft.updatedAt = Date.now();
    try { persist(); } catch (_) {
      delete draft.runs[runId]; prunedRuns.forEach(([oldRunId, oldRun]) => { draft.runs[oldRunId] = oldRun; });
      draft.lastRunId = previousLastRunId; draft.updatedAt = previousUpdatedAt;
      return { ok: false, error: 'app-draft-persist-failed' };
    }
    return { ok: true, duplicate: false, draft: summary(draft) };
  }

  function runScope(draftRef, projectRef, runId, allowQueued) {
    const draft = draftFor(String(draftRef || ''), String(projectRef || ''));
    const run = draft && RUN_ID_RE.test(String(runId || '')) ? draft.runs[runId] : null;
    if (!draft || !run || (run.status !== 'running' && !(allowQueued && run.status === 'queued'))) return null;
    return { draft, run };
  }

  function activateRun(input) {
    const scope = input && runScope(input.draftRef, input.projectRef, input.runId, true);
    if (!scope) return { ok: false, error: 'app-draft-run-not-active' };
    const previousStatus = scope.run.status, previousStartedVersion = scope.run.startedVersion, previousUpdatedAt = scope.draft.updatedAt;
    scope.run.status = 'running';
    scope.run.startedVersion = scope.draft.version;
    scope.draft.updatedAt = Date.now();
    try { persist(); } catch (_) {
      scope.run.status = previousStatus;
      if (previousStartedVersion === undefined) delete scope.run.startedVersion; else scope.run.startedVersion = previousStartedVersion;
      scope.draft.updatedAt = previousUpdatedAt;
      return { ok: false, error: 'app-draft-persist-failed' };
    }
    return { ok: true, draft: summary(scope.draft) };
  }

  function getRunContext(input) {
    const scope = input && runScope(input.draftRef, input.projectRef, input.runId, true);
    if (!scope) return { ok: false, error: 'app-draft-run-not-active' };
    return { ok: true, draftRef: scope.draft.draftRef, projectRef: scope.draft.projectRef,
      name: scope.draft.name, version: Number.isSafeInteger(scope.run.baseVersion) ? scope.run.baseVersion : scope.draft.version,
      files: clone(scope.run.workingFiles || scope.draft.files), instruction: scope.run.instruction,
      runStatus: scope.run.status };
  }

  function listFiles(input) {
    const scope = input && runScope(input.draftRef, input.projectRef, input.runId, false);
    if (!scope) return { ok: false, error: 'app-draft-run-not-active' };
    const files = scope.run.workingFiles || scope.draft.files;
    return { ok: true, files: FILES.filter(name => Object.prototype.hasOwnProperty.call(files, name))
      .map(pathname => ({ path: pathname, bytes: Buffer.byteLength(files[pathname], 'utf8') })) };
  }

  function readFile(input) {
    const scope = input && runScope(input.draftRef, input.projectRef, input.runId, false);
    const pathname = input && input.path;
    const files = scope && (scope.run.workingFiles || scope.draft.files);
    if (!scope || !safeFileName(pathname) || !Object.prototype.hasOwnProperty.call(files, pathname)) {
      return { ok: false, error: 'app-draft-file-not-found' };
    }
    return { ok: true, path: pathname, content: files[pathname], bytes: Buffer.byteLength(files[pathname], 'utf8') };
  }

  function writeFile(input, createOnly) {
    const scope = input && runScope(input.draftRef, input.projectRef, input.runId, false);
    const pathname = input && input.path, content = input && cleanText(input.content, FILE_LIMIT);
    if (!scope || !safeFileName(pathname) || content === null) return { ok: false, error: 'app-draft-write-denied' };
    if (!scope.run.workingFiles) scope.run.workingFiles = clone(scope.draft.files);
    if (!scope.run.baseFiles) scope.run.baseFiles = clone(scope.draft.files);
    const workingFiles = scope.run.workingFiles;
    const exists = Object.prototype.hasOwnProperty.call(workingFiles, pathname);
    if ((createOnly && exists) || (!createOnly && !exists)) return { ok: false, error: createOnly ? 'app-draft-file-exists' : 'app-draft-file-not-found' };
    if (pathname === 'index.html' && /<\s*(?:script|iframe|frame|object|embed|base|link)\b|\son[a-z]+\s*=|javascript\s*:|\s(?:href|src|target)\s*=|<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(content)) {
      return { ok: false, error: 'app-draft-html-policy-denied' };
    }
    if (pathname === 'styles.css' && /@import\b|url\s*\(/i.test(content)) return { ok: false, error: 'app-draft-css-policy-denied' };
    if (pathname === 'app.js' && /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|localStorage|sessionStorage|indexedDB|navigator|history|location)\b|\b(?:parent|top|opener)\b|\bdocument\.(?:cookie|domain|forms)\b|\bwindow\s*\.\s*open\b|\bopen\s*\(/i.test(content)) {
      return { ok: false, error: 'app-draft-js-policy-denied' };
    }
    const total = FILES.reduce((sum, name) => sum + Buffer.byteLength(name === pathname ? content : String(workingFiles[name] || ''), 'utf8'), 0);
    if (total > TOTAL_LIMIT) return { ok: false, error: 'app-draft-size-limit' };
    const current = workingFiles[pathname];
    if (exists && current === content) return { ok: true, unchanged: true, path: pathname,
      version: Number(scope.run.baseVersion || 0) + Number(scope.run.pendingRevision || 0), bytes: Buffer.byteLength(content, 'utf8') };
    const hadChange = Object.prototype.hasOwnProperty.call(scope.run.changes, pathname);
    const previousChange = hadChange ? clone(scope.run.changes[pathname]) : null;
    if (!hadChange) {
      const baseExists = Object.prototype.hasOwnProperty.call(scope.run.baseFiles, pathname);
      scope.run.changes[pathname] = { before: baseExists ? scope.run.baseFiles[pathname] : null, after: content };
    } else scope.run.changes[pathname].after = content;
    const previousRevision = Number(scope.run.pendingRevision || 0);
    const previousUpdatedAt = scope.draft.updatedAt;
    workingFiles[pathname] = content;
    scope.run.pendingRevision = previousRevision + 1;
    scope.draft.updatedAt = Date.now();
    try { persist(); } catch (_) {
      if (exists) workingFiles[pathname] = current; else delete workingFiles[pathname];
      scope.run.pendingRevision = previousRevision;
      if (hadChange) scope.run.changes[pathname] = previousChange; else delete scope.run.changes[pathname];
      scope.draft.updatedAt = previousUpdatedAt;
      return { ok: false, error: 'app-draft-persist-failed' };
    }
    return { ok: true, path: pathname, version: Number(scope.run.baseVersion || 0) + scope.run.pendingRevision,
      bytes: Buffer.byteLength(content, 'utf8') };
  }

  function finishRun(input) {
    if (!isRecord(input) || Object.keys(input).some(key => !['draftRef', 'projectRef', 'runId', 'status'].includes(key))) {
      return { ok: false, error: 'invalid-request' };
    }
    const scope = input && runScope(input.draftRef, input.projectRef, input.runId, true);
    if (!['completed', 'failed', 'cancelled'].includes(input.status)) return { ok: false, error: 'invalid-run-status' };
    if (!scope) {
      const draft = draftFor(String(input.draftRef || ''), String(input.projectRef || ''));
      const runId = String(input.runId || ''), existing = draft && RUN_ID_RE.test(runId) ? draft.runs[runId] : null;
      if (existing && existing.status === input.status) return { ok: true, duplicate: true, draft: summary(draft) };
      return { ok: false, error: 'app-draft-run-not-active' };
    }
    const previousDraft = clone(scope.draft);
    const previousStatus = scope.run.status, previousUpdatedAt = scope.draft.updatedAt;
    const changedPaths = Object.keys(scope.run.changes || {}).filter(pathname => {
      const change = scope.run.changes[pathname]; return change && change.before !== change.after;
    });
    scope.run.status = input.status;
    if (input.status === 'completed' && changedPaths.length) {
      scope.draft.files = clone(scope.run.workingFiles || scope.draft.files);
      scope.draft.version = Number(scope.run.baseVersion || scope.draft.version) + Number(scope.run.pendingRevision || 0);
      scope.draft.history.push({ version: scope.draft.version, runId: String(input.runId), instruction: scope.run.instruction,
        changedPaths: changedPaths, committedAt: Date.now(), files: clone(scope.draft.files) });
      while (scope.draft.history.length > MAX_RUNS_PER_DRAFT + 1) scope.draft.history.shift();
    }
    delete scope.run.workingFiles;
    delete scope.run.baseFiles;
    delete scope.run.pendingRevision;
    scope.run.finishedAt = Date.now();
    scope.draft.updatedAt = Date.now();
    try { persist(); } catch (_) {
      state.drafts[scope.draft.draftRef] = previousDraft;
      if (!previousDraft.runs[input.runId]) return { ok: false, error: 'app-draft-persist-failed' };
      return { ok: false, error: 'app-draft-persist-failed' };
    }
    return { ok: true, draft: summary(scope.draft) };
  }

  function restoreVersion(input) {
    if (!isRecord(input) || Object.keys(input).some(key => !['draftRef', 'projectRef', 'version'].includes(key))) {
      return { ok: false, error: 'invalid-request' };
    }
    const draft = draftFor(String(input.draftRef || ''), String(input.projectRef || ''));
    const versionNumber = Number(input.version);
    if (!draft || !Number.isSafeInteger(versionNumber) || versionNumber < 0) return { ok: false, error: 'invalid-app-draft-version' };
    if (Object.values(draft.runs).some(run => run && ['queued', 'running'].includes(run.status))) {
      return { ok: false, error: 'app-draft-run-active' };
    }
    const target = draft.history.find(item => item.version === versionNumber);
    if (!target) return { ok: false, error: 'app-draft-version-not-found' };
    const targetFiles = clone(target.files);
    if (JSON.stringify(targetFiles) === JSON.stringify(draft.files)) return { ok: true, duplicate: true, draft: summary(draft) };
    const previousDraft = clone(draft);
    const changedPaths = FILES.filter(name => (draft.files[name] == null ? null : draft.files[name])
      !== (targetFiles[name] == null ? null : targetFiles[name]));
    draft.files = targetFiles;
    draft.version += 1;
    draft.history.push({ version: draft.version, runId: '', instruction: '恢复到版本 v' + versionNumber,
      changedPaths: changedPaths, committedAt: Date.now(), restoredFrom: versionNumber, files: clone(targetFiles) });
    while (draft.history.length > MAX_RUNS_PER_DRAFT + 1) draft.history.shift();
    draft.updatedAt = Date.now();
    try { persist(); } catch (_) { state.drafts[draft.draftRef] = previousDraft; return { ok: false, error: 'app-draft-persist-failed' }; }
    return { ok: true, duplicate: false, draft: summary(draft) };
  }

  return Object.freeze({ open, create, list, get, getVersion, queueRun, activateRun, getRunContext, listFiles, readFile,
    createFile: input => writeFile(input, true), updateFile: input => writeFile(input, false), finishRun, restoreVersion,
    describe: () => ({ enabled: true, fileNames: FILES.slice(), fileLimitBytes: FILE_LIMIT, totalLimitBytes: TOTAL_LIMIT,
      maxDrafts: MAX_DRAFTS, maxRunsPerDraft: MAX_RUNS_PER_DRAFT }) });
}

module.exports = createAppDraftStore;
module.exports.FILES = FILES;
module.exports.WORKFLOW_ID = WORKFLOW_ID;
module.exports.FILE_LIMIT = FILE_LIMIT;
module.exports.TOTAL_LIMIT = TOTAL_LIMIT;
module.exports.INSTRUCTION_LIMIT = INSTRUCTION_LIMIT;
module.exports.MAX_DRAFTS = MAX_DRAFTS;
module.exports.MAX_RUNS_PER_DRAFT = MAX_RUNS_PER_DRAFT;
