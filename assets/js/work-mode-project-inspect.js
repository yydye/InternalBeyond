(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.IB = root.IB || {};
    root.IB.workMode = root.IB.workMode || {};
    root.IB.workMode.projectInspect = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var IDENTIFIER = /^[A-Za-z0-9_.:-]{1,180}$/;
  var MAX_FILES = 200;
  var MAX_FILE_BYTES = 131072;
  var MAX_TOTAL_BYTES = MAX_FILES * MAX_FILE_BYTES;
  var SECRET_SEGMENT = /(^|[._-])(api[_-]?keys?|access[_-]?tokens?|auth[_-]?tokens?|tokens?|passwords?|secrets?|credentials?|private[-_]?keys?|id_rsa|id_ed25519|service[-_]?accounts?)([._-]|$)/i;
  var HIDDEN_NAMES = { '.git': 1, 'node_modules': 1, '.venv': 1, 'venv': 1, 'vendor': 1 };
  var DENIED_FILE_NAMES = { '.npmrc': 1, '.pypirc': 1, '.netrc': 1, '.dockercfg': 1, '.htpasswd': 1,
    authorized_keys: 1, id_rsa: 1, id_ed25519: 1 };

  function safeRelativePath(value) {
    if (typeof value !== 'string' || !value || value.length > 400 || value.charAt(0) === '/'
      || value.indexOf('\\') >= 0 || /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
      || /[\u0000-\u001F\u007F]/.test(value)) return false;
    var parts = value.split('/');
    return parts.every(function (part, index) {
      var lower = part.toLowerCase();
      if (!part || part === '.' || part === '..' || HIDDEN_NAMES[lower]) return false;
      if (index === parts.length - 1 && (DENIED_FILE_NAMES[lower] || lower === '.env'
        || lower.indexOf('.env.') === 0 || lower.indexOf('.env-') === 0
        || /\.(pem|key|p12|pfx|keystore|jks)$/i.test(lower))) return false;
      return !SECRET_SEGMENT.test(part);
    });
  }

  function safeProjectName(value) {
    if (typeof value !== 'string') return '';
    var name = value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 180);
    if (!name || /[\\/]/.test(name) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(name) || SECRET_SEGMENT.test(name)) return '';
    return name;
  }

  function build(input) {
    input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    var projectRef = input.projectRef;
    var fileIds = input.fileIds;
    var snapshotFiles = input.files;
    if (typeof projectRef !== 'string' || !IDENTIFIER.test(projectRef)
      || !Array.isArray(fileIds) || fileIds.length > MAX_FILES
      || !Array.isArray(snapshotFiles) || snapshotFiles.length > MAX_FILES) {
      return { ok: false, error: 'project-inspection-scope-invalid' };
    }
    var authorized = Object.create(null);
    for (var i = 0; i < fileIds.length; i++) {
      if (typeof fileIds[i] !== 'string' || !IDENTIFIER.test(fileIds[i]) || authorized[fileIds[i]]) {
        return { ok: false, error: 'project-inspection-scope-invalid' };
      }
      authorized[fileIds[i]] = true;
    }
    var byId = Object.create(null);
    for (var f = 0; f < snapshotFiles.length; f++) {
      var source = snapshotFiles[f];
      if (!source || typeof source.fileId !== 'string' || !IDENTIFIER.test(source.fileId)
        || byId[source.fileId] || !Number.isSafeInteger(Number(source.size))
        || Number(source.size) < 0 || Number(source.size) > MAX_FILE_BYTES) {
        return { ok: false, error: 'workspace-integrity' };
      }
      byId[source.fileId] = source;
    }

    var displayFiles = [], totalBytes = 0;
    for (var selected = 0; selected < fileIds.length; selected++) {
      var file = byId[fileIds[selected]];
      if (!file || !authorized[file.fileId]) return { ok: false, error: 'authorized-file-unavailable' };
      var size = Number(file.size);
      totalBytes += size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
        return { ok: false, error: 'project-inspection-size-limit' };
      }
      if (safeRelativePath(file.path)) {
        displayFiles.push({ fileId: file.fileId, path: file.path, size: size });
      }
    }
    displayFiles.sort(function (left, right) {
      return left.path < right.path ? -1 : (left.path > right.path ? 1 : left.fileId.localeCompare(right.fileId));
    });

    var directoryCounts = Object.create(null), extensionCounts = Object.create(null);
    displayFiles.forEach(function (file) {
      var parts = file.path.split('/');
      var directory = '';
      for (var partIndex = 0; partIndex < parts.length - 1; partIndex++) {
        directory = directory ? directory + '/' + parts[partIndex] : parts[partIndex];
        directoryCounts[directory] = (directoryCounts[directory] || 0) + 1;
      }
      var base = parts[parts.length - 1];
      var dot = base.lastIndexOf('.');
      var extension = dot > 0 ? base.slice(dot).toLowerCase() : '';
      if (extension.length > 20) extension = '.other';
      extensionCounts[extension] = (extensionCounts[extension] || 0) + 1;
    });

    var output = {
      projectRef: projectRef,
      scope: 'run-consented-files',
      fileCount: fileIds.length,
      displayableFileCount: displayFiles.length,
      omittedFileCount: fileIds.length - displayFiles.length,
      totalBytes: totalBytes,
      directories: Object.keys(directoryCounts).sort().map(function (path) {
        return { path: path, fileCount: directoryCounts[path] };
      }),
      extensions: Object.keys(extensionCounts).sort().map(function (extension) {
        return { extension: extension, fileCount: extensionCounts[extension] };
      }),
      files: displayFiles
    };
    var projectName = safeProjectName(input.projectName);
    if (projectName) output.projectName = projectName;
    return { ok: true, output: output };
  }

  return Object.freeze({ build: build, safeRelativePath: safeRelativePath });
});
