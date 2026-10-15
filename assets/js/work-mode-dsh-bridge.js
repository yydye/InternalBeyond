(function (root) {
  'use strict';
  if (!root || root.__IB_DEV_MODE__ !== true) return;

  var IB = root.IB || {};
  var workspace = IB.workspace && IB.workspace.files;
  var workspaceChangeContract = IB.workMode && IB.workMode.workspaceChangeContract;
  if (!IB.createWorkRunRemote || !IB.workMode || typeof IB.workMode.createReadOnlyProjectTool !== 'function'
    || !workspace || typeof workspace.wsGetWorkModeProjectSnapshot !== 'function'
    || typeof workspace.wsReadWorkModeFile !== 'function'
    || typeof workspace.wsWriteWorkModeFile !== 'function' || typeof workspace.wsRollbackWorkModeFile !== 'function') return;

  var remote = IB.createWorkRunRemote({ readTimeoutMs: 30000, writeTimeoutMs: 30000 });
  var projectTool = IB.workMode.createReadOnlyProjectTool({ workspace: workspace, allowWrites: true, maxWriteCalls: 12 });
  var stopped = false;
  var delay = function (ms) { return new Promise(function (resolve) { root.setTimeout(resolve, ms); }); };

  async function handleJob(job) {
    if (!job || typeof job !== 'object' || typeof job.requestId !== 'string' || !job.input || typeof job.input !== 'object') return;
    var result;
    try {
      if (job.operation === 'snapshot' && typeof job.input.projectRef === 'string') {
        result = await projectTool.snapshot(job.input.projectRef);
      } else if (job.operation === 'read_file' && typeof job.input.projectRef === 'string'
        && typeof job.input.fileId === 'string' && job.input.scope && typeof job.input.scope === 'object') {
        var read = await projectTool.readFile(job.input);
        var grant = Array.isArray(job.input.scope.files)
          ? job.input.scope.files.find(function (file) { return file && file.fileId === job.input.fileId; }) : null;
        result = read && read.ok === true && grant ? {
          ok: true,
          projectRef: job.input.projectRef,
          fileId: read.fileId,
          path: read.path,
          content: read.content,
          contentHash: grant.contentHash,
          size: read.bytesRead,
          lastModified: read.lastModified
        } : read;
      } else if (job.operation === 'write_preflight_read' && typeof job.input.projectRef === 'string'
        && typeof job.input.fileId === 'string' && job.input.scope && typeof job.input.scope === 'object') {
        var grant = Array.isArray(job.input.scope.files)
          ? job.input.scope.files.find(function (file) { return file && file.fileId === job.input.fileId; }) : null;
        var current = grant ? await workspace.wsReadWorkModeFile(job.input.projectRef, job.input.fileId) : null;
        result = current && current.ok === true && current.projectRef === job.input.projectRef
          && current.fileId === job.input.fileId && current.path === grant.path
          && current.contentHash === grant.contentHash && current.lastModified === grant.lastModified ? {
            ok: true, projectRef: job.input.projectRef, fileId: current.fileId, path: current.path,
            content: current.content, contentHash: current.contentHash, size: current.size, lastModified: current.lastModified
          } : { ok: false, error: current && current.error || 'workspace-changed' };
      } else if ((job.operation === 'update_file' || job.operation === 'create_file')
        && typeof job.input.projectRef === 'string' && job.input.scope && typeof job.input.scope === 'object') {
        await projectTool.snapshot(job.input.projectRef);
        result = job.operation === 'update_file' ? await projectTool.updateFile(job.input) : await projectTool.createFile(job.input);
        if (result && result.ok === true) {
          var changed = await workspace.wsReadWorkModeFile(job.input.projectRef, result.fileId);
          result = changed && changed.ok === true ? {
            ok: true, projectRef: job.input.projectRef, fileId: result.fileId, path: result.path,
            contentHash: changed.contentHash, lastModified: changed.lastModified, size: changed.size,
            addedLines: result.addedLines, removedLines: result.removedLines
          } : { ok: false, error: changed && changed.error || 'workspace-write-verification-failed' };
        }
      } else if (job.operation === 'write_rollback' && job.input && typeof job.input.projectRef === 'string') {
        result = await workspace.wsRollbackWorkModeFile(job.input);
        result = result && result.ok === true ? { ok: true, status: 'rolled-back' }
          : { ok: false, error: result && result.error || 'workspace-rollback-failed' };
      } else {
        result = { ok: false, error: 'workspace-operation-denied' };
      }
    } catch (_) {
      result = { ok: false, error: 'workspace-unavailable' };
    }
    if (workspaceChangeContract && typeof workspaceChangeContract.normalizeResult === 'function') {
      result = workspaceChangeContract.normalizeResult(result);
    }
    try { await remote.workspaceProjectResolve(job.requestId, result); }
    catch (_) { /* Home Node owns request expiry; the desktop keeps no local copy. */ }
  }

  async function pump() {
    var initialStatus;
    try { initialStatus = await remote.dshStatus(); }
    catch (_) { return; }
    if (!initialStatus || initialStatus.ok !== true || !initialStatus.host || initialStatus.host.enabled !== true) return;
    while (!stopped) {
      try {
        var response = await remote.workspaceProjectPoll(20000);
        if (response && response.ok === true && response.job) await handleJob(response.job);
        else if (response && response.error === 'dsh-host-disabled') return;
      } catch (_) {
        await delay(5000);
        try {
          var currentStatus = await remote.dshStatus();
          if (!currentStatus || currentStatus.ok !== true || !currentStatus.host || currentStatus.host.enabled !== true) return;
        } catch (_) { return; }
      }
    }
  }

  root.addEventListener('pagehide', function () { stopped = true; }, { once: true });
  void pump();
})(typeof window !== 'undefined' ? window : null);
