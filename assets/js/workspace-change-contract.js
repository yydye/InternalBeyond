(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.IB = root.IB || {};
    root.IB.workMode = root.IB.workMode || {};
    root.IB.workMode.workspaceChangeContract = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var WORKSPACE_CHANGED = 'workspace-changed';
  var LEGACY_SNAPSHOT_CHANGED = 'workspace-changed-snapshot';
  var SNAPSHOT_MISMATCH = 'snapshot-mismatch';

  function snapshotChangedResult() {
    return {
      ok: false,
      error: WORKSPACE_CHANGED,
      workspaceChange: { scope: 'authorized-snapshot', reason: SNAPSHOT_MISMATCH }
    };
  }

  function normalizeError(error) {
    return error === LEGACY_SNAPSHOT_CHANGED ? WORKSPACE_CHANGED : error;
  }

  function normalizeResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.error !== LEGACY_SNAPSHOT_CHANGED) return result;
    return {
      ok: false,
      error: WORKSPACE_CHANGED,
      workspaceChange: {
        scope: 'authorized-snapshot',
        reason: SNAPSHOT_MISMATCH,
        legacyCode: LEGACY_SNAPSHOT_CHANGED
      }
    };
  }

  return Object.freeze({
    WORKSPACE_CHANGED: WORKSPACE_CHANGED,
    LEGACY_SNAPSHOT_CHANGED: LEGACY_SNAPSHOT_CHANGED,
    SNAPSHOT_MISMATCH: SNAPSHOT_MISMATCH,
    snapshotChangedResult: snapshotChangedResult,
    normalizeError: normalizeError,
    normalizeResult: normalizeResult
  });
});
