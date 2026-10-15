(function (root, factory) {
  'use strict';
  var workspaceChangeContract = root && root.IB && root.IB.workMode && root.IB.workMode.workspaceChangeContract;
  if (!workspaceChangeContract && typeof module === 'object' && module.exports) {
    workspaceChangeContract = require('./workspace-change-contract.js');
  }
  if (typeof module === 'object' && module.exports) module.exports = function (options) { return factory(options, workspaceChangeContract); };
  if (root && root.IB) {
    root.IB.workMode = root.IB.workMode || {};
    root.IB.workMode.createReadOnlyProjectTool = function (options) { return factory(options, workspaceChangeContract); };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createReadOnlyProjectTool(options, workspaceChangeContract) {
  'use strict';
  options = options || {};
  workspaceChangeContract = workspaceChangeContract || options.workspaceChangeContract || null;
  function snapshotChangedResult() {
    return workspaceChangeContract && typeof workspaceChangeContract.snapshotChangedResult === 'function'
      ? workspaceChangeContract.snapshotChangedResult()
      : { ok: false, error: 'workspace-changed', workspaceChange: { scope: 'authorized-snapshot', reason: 'snapshot-mismatch' } };
  }
  function normalizeWorkspaceResult(result) {
    return workspaceChangeContract && typeof workspaceChangeContract.normalizeResult === 'function'
      ? workspaceChangeContract.normalizeResult(result) : result;
  }
  function workspaceFailure(result, fallback) {
    var normalized = normalizeWorkspaceResult(result);
    if (normalized && normalized.error === 'workspace-changed' && normalized.workspaceChange) return normalized;
    return { ok: false, error: String(normalized && normalized.error || fallback) };
  }
  var workspace = options.workspace || null;
  var maxFiles = options.maxFiles || 200;
  var maxFileBytes = options.maxFileBytes || 131072;
  var maxTotalReadBytes = options.maxTotalReadBytes || 524288;
  var allowWrites = options.allowWrites === true;
  var maxWriteCalls = Number.isSafeInteger(options.maxWriteCalls) ? Math.max(1, Math.min(options.maxWriteCalls, 24)) : 12;
  var readIds = Object.create(null);
  var totalReadBytes = 0;
  var writeCalls = 0;
  var changes = new Map();
  var textExtensions = {
    '.c':1,'.cc':1,'.cpp':1,'.cs':1,'.css':1,'.go':1,'.h':1,'.hpp':1,'.htm':1,'.html':1,
    '.ini':1,'.java':1,'.js':1,'.json':1,'.jsx':1,'.kt':1,'.md':1,'.mjs':1,'.cjs':1,
    '.ps1':1,'.py':1,'.rb':1,'.rs':1,'.rst':1,'.scss':1,'.sh':1,'.sql':1,'.svg':1,
    '.toml':1,'.ts':1,'.tsx':1,'.txt':1,'.xml':1,'.yaml':1,'.yml':1
  };
  var textNames = { readme:1, license:1, makefile:1, dockerfile:1, procfile:1,
    '.gitignore':1, '.gitattributes':1, '.editorconfig':1 };
  var deniedNames = { '.env':1, '.npmrc':1, '.pypirc':1, '.netrc':1, '.dockercfg':1,
    '.htpasswd':1, authorized_keys:1, id_rsa:1, id_ed25519:1 };

  function validProjectRef(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,180}$/.test(value);
  }

  function safePath(value) {
    if (typeof value !== 'string' || !value || value.length > 400) return false;
    if (value.charAt(0) === '/' || value.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(value)
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[\u0000-\u001F\u007F]/.test(value)) return false;
    var parts = value.split('/');
    if (!parts.every(function (part) { return !!part && part !== '.' && part !== '..'; })) return false;
    if (parts.some(function (part) { return ['.git', 'node_modules', '.venv', 'venv', 'vendor'].indexOf(part.toLowerCase()) >= 0; })) return false;
    var base = parts[parts.length - 1].toLowerCase();
    if (deniedNames[base] || base.indexOf('.env.') === 0 || base.indexOf('.env-') === 0
      || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(base)
      || /(^|[._-])(secrets?|credentials?|private[-_]?key|id_rsa|id_ed25519|service[-_]?account)([._-]|$)/i.test(base)) return false;
    var dot = base.lastIndexOf('.'), ext = dot >= 0 ? base.slice(dot) : '';
    return !!textNames[base] || !!textExtensions[ext];
  }

  function utf8Size(value) {
    try { return new TextEncoder().encode(value).length; } catch (_) { return -1; }
  }

  function redactSecrets(source) {
    var redactions = 0;
    var content = String(source || '');
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i.test(content)) return null;
    content = content.replace(/(\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|PASSWORD|SECRET|PRIVATE[_-]?KEY)\b\s*[:=]\s*)(["']?)([^'"\s,;]+)(["']?)/gi,
      function (_, prefix, open, value, close) { redactions++; return prefix + open + '[REDACTED]' + close; });
    content = content.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, function (_, prefix) { redactions++; return prefix + '[REDACTED]'; });
    content = content.replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g,
      function () { redactions++; return '[REDACTED]'; });
    content = content.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      function () { redactions++; return '[REDACTED]'; });
    return { content: content, redactions: redactions };
  }

  async function snapshot(projectRef) {
    if (!validProjectRef(projectRef)) return { ok: false, error: 'invalid-project-ref' };
    if (!workspace || typeof workspace.wsGetWorkModeProjectSnapshot !== 'function') {
      return { ok: false, error: 'workspace-unavailable' };
    }
    var result;
    try { result = await workspace.wsGetWorkModeProjectSnapshot(projectRef); }
    catch (_) { return { ok: false, error: 'workspace-unavailable' }; }
    if (!result || result.ok !== true) {
      return workspaceFailure(result, 'workspace-unavailable');
    }
    if (result.projectRef !== projectRef || !Array.isArray(result.files)) {
      return { ok: false, error: String(result && result.error || 'workspace-unavailable') };
    }
    if (result.files.length > maxFiles) return { ok: false, error: 'project-file-limit' };
    var ids = Object.create(null), paths = Object.create(null), files = [];
    for (var i = 0; i < result.files.length; i++) {
      var file = result.files[i];
      if (!file || typeof file.fileId !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(file.fileId)
        || !safePath(file.path) || !Number.isSafeInteger(Number(file.size)) || Number(file.size) < 0
        || typeof file.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(file.contentHash)
        || ids[file.fileId] || paths[file.path]) return { ok: false, error: 'workspace-integrity' };
      ids[file.fileId] = true;
      paths[file.path] = true;
      files.push({ fileId: file.fileId, path: file.path, size: Number(file.size), contentHash: file.contentHash,
        lastModified: Number.isSafeInteger(Number(file.lastModified)) ? Number(file.lastModified) : 0 });
    }
    var projectName = typeof result.projectName === 'string' ? result.projectName.slice(0, 180) : '';
    return { ok: true, projectRef: projectRef, projectName: projectName, files: files };
  }

  async function readFile(input) {
    input = input || {};
    var projectRef = input.projectRef, fileId = input.fileId, scope = input.scope;
    if (!validProjectRef(projectRef) || typeof fileId !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(fileId)) {
      return { ok: false, error: 'invalid-reference' };
    }
    if (!scope || scope.projectRef !== projectRef || !Array.isArray(scope.files)) return { ok: false, error: 'scope-denied' };
    var grant = scope.files.find(function (file) { return file && file.fileId === fileId; });
    if (!grant || !safePath(grant.path)) return { ok: false, error: 'scope-denied' };
    if (readIds[fileId]) return { ok: false, error: 'file-already-read' };
    if (!workspace || typeof workspace.wsReadWorkModeFile !== 'function') return { ok: false, error: 'workspace-unavailable' };
    var result;
    try { result = await workspace.wsReadWorkModeFile(projectRef, fileId); }
    catch (_) { return { ok: false, error: 'workspace-unavailable' }; }
    if (!result || result.ok !== true) {
      return workspaceFailure(result, 'tool-read-failed');
    }
    if (result.projectRef !== projectRef || result.fileId !== fileId || result.path !== grant.path || !safePath(result.path)
      || result.contentHash !== grant.contentHash) {
      return snapshotChangedResult();
    }
    if (typeof result.content !== 'string' || result.content.indexOf('\0') >= 0) return { ok: false, error: 'file-not-text' };
    var redacted = redactSecrets(result.content);
    if (!redacted) return { ok: false, error: 'sensitive-content-denied' };
    var bytesRead = utf8Size(redacted.content);
    if (bytesRead < 0) return { ok: false, error: 'file-not-text' };
    if (bytesRead > maxFileBytes) return { ok: false, error: 'file-size-limit' };
    if (totalReadBytes + bytesRead > maxTotalReadBytes) return { ok: false, error: 'run-read-limit' };
    readIds[fileId] = true;
    totalReadBytes += bytesRead;
    return {
      ok: true,
      fileId: fileId,
      path: result.path,
      content: redacted.content,
      bytesRead: bytesRead,
      redactedSecrets: redacted.redactions,
      lastModified: Number.isSafeInteger(Number(result.lastModified)) ? Number(result.lastModified) : 0
    };
  }

  function contentLineStats(before, after) {
    before = String(before || '').split(/\r?\n/);
    after = String(after || '').split(/\r?\n/);
    var start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    var endBefore = before.length, endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
    return { addedLines: Math.min(10000, endAfter - start), removedLines: Math.min(10000, endBefore - start) };
  }

  function diffText(before, after) {
    var oldLines = String(before || '').replace(/\r\n/g, '\n').split('\n');
    var newLines = String(after || '').replace(/\r\n/g, '\n').split('\n');
    var max = 900, out = [];
    oldLines.forEach(function (line) { out.push('- ' + line); });
    newLines.forEach(function (line) { out.push('+ ' + line); });
    var text = out.join('\n');
    return text.length > max ? text.slice(0, max) + '\n… diff clipped …' : text;
  }

  function relativeDirectory(value) {
    var index = value.lastIndexOf('/');
    return index < 0 ? '' : value.slice(0, index);
  }

  function safeWritableContent(value) {
    if (typeof value !== 'string' || value.indexOf('\0') >= 0) return { ok: false, error: 'file-not-text' };
    var bytes = utf8Size(value);
    if (bytes < 0) return { ok: false, error: 'file-not-text' };
    if (bytes > maxFileBytes) return { ok: false, error: 'file-size-limit' };
    var redacted = redactSecrets(value);
    if (!redacted || redacted.redactions > 0) return { ok: false, error: 'sensitive-content-denied' };
    return { ok: true, bytes: bytes };
  }

  function nextChangeId() {
    return 'wmchange_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  }

  async function updateFile(input) {
    input = input || {};
    var projectRef = input.projectRef, fileId = input.fileId, scope = input.scope;
    if (!allowWrites) return { ok: false, error: 'workspace-write-disabled' };
    if (!validProjectRef(projectRef) || typeof fileId !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(fileId)
      || !scope || scope.projectRef !== projectRef || !Array.isArray(scope.files)) return { ok: false, error: 'invalid-reference' };
    if (writeCalls >= maxWriteCalls) return { ok: false, error: 'project-write-call-limit' };
    var grant = scope.files.find(function (file) { return file && file.fileId === fileId; });
    if (!grant || !safePath(grant.path) || !workspace || typeof workspace.wsReadWorkModeFile !== 'function'
      || typeof workspace.wsWriteWorkModeFile !== 'function') return { ok: false, error: 'scope-denied' };
    var next = safeWritableContent(input.content);
    if (!next.ok) return next;
    var current;
    var versionReader = typeof workspace.wsReadWorkModeFileForWrite === 'function'
      ? workspace.wsReadWorkModeFileForWrite : workspace.wsReadWorkModeFile;
    try { current = await versionReader.call(workspace, projectRef, fileId, grant); }
    catch (_) { return { ok: false, error: 'workspace-unavailable' }; }
    if (!current || current.ok !== true || current.projectRef !== projectRef || current.fileId !== fileId
      || current.path !== grant.path || !safePath(current.path) || current.contentHash !== grant.contentHash) {
      return snapshotChangedResult();
    }
    if (typeof current.content !== 'string' || current.content.indexOf('\0') >= 0) return { ok: false, error: 'file-not-text' };
    var prior = redactSecrets(current.content);
    if (!prior || prior.redactions > 0) return { ok: false, error: 'sensitive-content-denied' };
    if (utf8Size(current.content) > maxFileBytes) return { ok: false, error: 'file-size-limit' };
    if (!Number.isSafeInteger(Number(current.lastModified)) || Number(current.lastModified) < 0) return { ok: false, error: 'workspace-version-unavailable' };
    var result;
    try {
      result = await workspace.wsWriteWorkModeFile({ operation: 'update', projectRef: projectRef, fileId: fileId,
        path: grant.path, content: input.content, expectedHash: grant.contentHash,
        expectedLastModified: Number(current.lastModified), scope: scope });
    } catch (_) { return { ok: false, error: 'workspace-write-failed' }; }
    if (!result || result.ok !== true) {
      return workspaceFailure(result, 'workspace-write-failed');
    }
    if (result.fileId !== fileId || result.path !== grant.path
      || !/^[a-f0-9]{64}$/.test(String(result.contentHash || ''))
      || !Number.isSafeInteger(Number(result.lastModified))) return { ok: false, error: 'workspace-write-failed' };
    writeCalls++;
    var changeId = nextChangeId();
    var stats = contentLineStats(current.content, input.content);
    changes.set(changeId, { operation: 'update', projectRef: projectRef, fileId: fileId, path: grant.path,
      beforeContent: current.content, afterContent: input.content, afterHash: result.contentHash,
      afterLastModified: Number(result.lastModified) });
    return { ok: true, changeId: changeId, fileId: fileId, path: grant.path,
      addedLines: stats.addedLines, removedLines: stats.removedLines, diff: diffText(current.content, input.content) };
  }

  async function createFile(input) {
    input = input || {};
    var projectRef = input.projectRef, anchorFileId = input.anchorFileId, filePath = input.path, scope = input.scope;
    if (!allowWrites) return { ok: false, error: 'workspace-write-disabled' };
    if (!validProjectRef(projectRef) || typeof anchorFileId !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(anchorFileId)
      || !safePath(filePath) || !scope || scope.projectRef !== projectRef || !Array.isArray(scope.files)) {
      return { ok: false, error: 'invalid-reference' };
    }
    if (writeCalls >= maxWriteCalls) return { ok: false, error: 'project-write-call-limit' };
    var anchor = scope.files.find(function (file) { return file && file.fileId === anchorFileId; });
    if (!anchor || !safePath(anchor.path) || relativeDirectory(anchor.path) !== relativeDirectory(filePath)) return { ok: false, error: 'scope-denied' };
    if (!workspace || typeof workspace.wsGetWorkModeProjectSnapshot !== 'function' || typeof workspace.wsWriteWorkModeFile !== 'function') {
      return { ok: false, error: 'workspace-unavailable' };
    }
    var next = safeWritableContent(input.content);
    if (!next.ok) return next;
    var snapshot;
    try { snapshot = await workspace.wsGetWorkModeProjectSnapshot(projectRef); }
    catch (_) { return { ok: false, error: 'workspace-unavailable' }; }
    if (!snapshot || snapshot.ok !== true || snapshot.projectRef !== projectRef || !Array.isArray(snapshot.files)) return { ok: false, error: 'workspace-unavailable' };
    if (snapshot.files.some(function (file) { return file && file.path === filePath; })) return { ok: false, error: 'file-already-exists' };
    var result;
    try {
      result = await workspace.wsWriteWorkModeFile({ operation: 'create', projectRef: projectRef,
        anchorFileId: anchorFileId, anchorPath: anchor.path, path: filePath, content: input.content,
        expectedAnchorLastModified: Number(anchor.lastModified || 0), scope: scope });
    } catch (_) { return { ok: false, error: 'workspace-write-failed' }; }
    if (!result || result.ok !== true) {
      return workspaceFailure(result, 'workspace-write-failed');
    }
    if (typeof result.fileId !== 'string' || result.path !== filePath
      || !/^[a-f0-9]{64}$/.test(String(result.contentHash || ''))
      || !Number.isSafeInteger(Number(result.lastModified))) return { ok: false, error: 'workspace-write-failed' };
    writeCalls++;
    var changeId = nextChangeId();
    var stats = contentLineStats('', input.content);
    changes.set(changeId, { operation: 'create', projectRef: projectRef, fileId: result.fileId, path: filePath,
      beforeContent: '', afterContent: input.content, afterHash: result.contentHash,
      afterLastModified: Number(result.lastModified) });
    return { ok: true, changeId: changeId, fileId: result.fileId, path: filePath,
      addedLines: stats.addedLines, removedLines: 0, diff: diffText('', input.content) };
  }

  async function rollback(changeId) {
    if (!allowWrites || !workspace || typeof workspace.wsRollbackWorkModeFile !== 'function') return { ok: false, error: 'workspace-rollback-unavailable' };
    var change = changes.get(String(changeId || ''));
    if (!change) return { ok: false, error: 'workspace-change-not-found' };
    var result;
    try { result = await workspace.wsRollbackWorkModeFile(change); }
    catch (_) { return { ok: false, error: 'workspace-rollback-failed' }; }
    if (result && result.ok === true) changes.delete(String(changeId));
    if (result && result.ok === true) return { ok: true, path: change.path };
    return workspaceFailure(result, 'workspace-rollback-failed');
  }

  function commitChanges() { changes.clear(); return { ok: true }; }

  return Object.freeze({
    snapshot: snapshot,
    readFile: readFile,
    ...(allowWrites ? { createFile: createFile, updateFile: updateFile, rollback: rollback, commitChanges: commitChanges } : {}),
    limits: Object.freeze({ maxFiles: maxFiles, maxFileBytes: maxFileBytes, maxTotalReadBytes: maxTotalReadBytes,
      maxWriteCalls: allowWrites ? maxWriteCalls : 0 })
  });
});
