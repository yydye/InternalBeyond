(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.IB) {
    root.IB.workMode = root.IB.workMode || {};
    var storage = null;
    try { storage = root.sessionStorage; } catch (_) {}
    root.IB.workMode.projectDraft = api.createSessionStore(storage);
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';
  var KEY = 'ib-work-mode-project-draft-v1';

  function normalize(value) {
    if (!value || typeof value !== 'object' || value.version !== 1
      || typeof value.projectRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(value.projectRef)
      || !Array.isArray(value.fileIds) || value.fileIds.length > 200) return null;
    var seen = Object.create(null), fileIds = [];
    for (var i = 0; i < value.fileIds.length; i++) {
      var id = value.fileIds[i];
      if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,180}$/.test(id) || seen[id]) return null;
      seen[id] = true;
      fileIds.push(id);
    }
    return { version: 1, projectRef: value.projectRef, fileIds: fileIds.sort() };
  }

  function createSessionStore(storage) {
    return Object.freeze({
      load: function () {
        if (!storage || typeof storage.getItem !== 'function') return null;
        try { return normalize(JSON.parse(storage.getItem(KEY) || 'null')); } catch (_) { return null; }
      },
      save: function (value) {
        var safe = normalize(Object.assign({ version: 1 }, value || {}));
        if (!safe || !storage || typeof storage.setItem !== 'function') return false;
        try { storage.setItem(KEY, JSON.stringify(safe)); return true; } catch (_) { return false; }
      },
      clear: function () {
        if (!storage || typeof storage.removeItem !== 'function') return false;
        try { storage.removeItem(KEY); return true; } catch (_) { return false; }
      }
    });
  }

  return { KEY: KEY, normalize: normalize, createSessionStore: createSessionStore };
});
