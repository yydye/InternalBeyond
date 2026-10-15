(function (root) {
  'use strict';
  if (!root || !root.document || root.__IB_DEV_MODE__ !== true) return;

  var tauri = root.__TAURI__ && root.__TAURI__.core;
  var invoke = tauri && tauri.invoke;
  var schema = root.IBWebCoreDbSchema;

  function waitForTransaction(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = tx.onabort = function () { reject(new Error('dev-seed-transaction-failed')); };
    });
  }

  async function importSeed() {
    if (typeof invoke !== 'function' || !schema || typeof schema.open !== 'function') {
      throw new Error('dev-seed-runtime-unavailable');
    }
    var payload = await invoke('ib_dev_snapshot_load');
    if (payload && payload.state === 'already-imported') return;
    if (!payload || payload.schema !== 'internalbeyond.dev-snapshot' || !payload.stores) {
      throw new Error('dev-seed-snapshot-unavailable');
    }
    var stores = payload.stores;
    if (root.__IB_DEV_SYNTHETIC__ === true) {
      var synthetic = payload.syntheticWorkspace;
      if (!synthetic || synthetic.schema !== 'internalbeyond.dev-synthetic-workspace'
        || synthetic.version !== 1 || !Array.isArray(synthetic.projects) || synthetic.projects.length !== 1
        || !Array.isArray(synthetic.projectFiles) || synthetic.projectFiles.length !== 1) {
        throw new Error('dev-synthetic-workspace-invalid');
      }
      var project = synthetic.projects[0];
      var file = synthetic.projectFiles[0];
      var fixtureProjectId = 'dsh_synthetic_workspace';
      var fixtureFileId = 'dsh_synthetic_readme';
      var fixturePath = 'src/synthetic.js';
      if (!project || project.id !== fixtureProjectId || project.name !== 'DSH Synthetic Workspace'
        || !file || file.id !== fixtureFileId || file.projectId !== fixtureProjectId || file.path !== fixturePath
        || typeof file.content !== 'string' || file.content.length > 131072 || file.content.indexOf('\0') >= 0) {
        throw new Error('dev-synthetic-workspace-invalid');
      }
      var measuredSize;
      try { measuredSize = new TextEncoder().encode(file.content).length; }
      catch (_) { throw new Error('dev-synthetic-workspace-invalid'); }
      if (Number(file.size) !== measuredSize) throw new Error('dev-synthetic-workspace-invalid');
      stores = Object.assign({}, payload.stores, {
        projects: [{ id: fixtureProjectId, name: 'DSH Synthetic Workspace', created: Number(project.created) || Date.now() }],
        projectFiles: [{
          id: fixtureFileId, projectId: fixtureProjectId, path: fixturePath,
          content: file.content, size: measuredSize, updatedAt: Number(file.updatedAt) || Date.now()
        }]
      });
    }
    var db = await schema.open(root.indexedDB);
    var names = Object.keys(stores).filter(function (name) {
      return db.objectStoreNames.contains(name) && Array.isArray(stores[name]);
    });
    if (!names.length) { db.close(); throw new Error('dev-seed-stores-empty'); }

    var tx;
    try { tx = db.transaction(names, 'readwrite'); }
    catch (_) { db.close(); throw new Error('dev-seed-transaction-failed'); }
    var completion = waitForTransaction(tx);
    try {
      names.forEach(function (name) {
        var store = tx.objectStore(name);
        var keyPath = store.keyPath || (typeof schema.keyPathFor === 'function' ? schema.keyPathFor(name) : 'id');
        stores[name].forEach(function (row) {
          var key = row && row[keyPath];
          if (key == null) { try { tx.abort(); } catch (ignored) {} return; }
          var existing;
          try { existing = store.get(key); }
          catch (_) { try { tx.abort(); } catch (ignored) {} return; }
          existing.onerror = function () { try { tx.abort(); } catch (ignored) {} };
          existing.onsuccess = function () {
            /* Keep Dev-side edits and prior rows. If a previous boot committed
               the data but died before the import marker, retrying only fills
               missing keys; it never clears or overwrites the Sandbox. */
            if (existing.result !== undefined) return;
            var add;
            try { add = store.add(row); }
            catch (_) { try { tx.abort(); } catch (ignored) {} return; }
            add.onerror = function (event) {
              if (add.error && add.error.name === 'ConstraintError') {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
                return;
              }
              try { tx.abort(); } catch (ignored) {}
            };
          };
        });
      });
    } catch (_) {
      try { tx.abort(); } catch (ignored) {}
      db.close();
      throw new Error('dev-seed-write-failed');
    }
    try { await completion; }
    catch (error) { try { db.close(); } catch (_) {} throw error; }
    db.close();
    await invoke('ib_dev_snapshot_mark_imported');
  }

  root.__IB_DEV_BOOTSTRAP_PROMISE__ = importSeed().catch(function (error) {
    var code = String(error && error.message || 'dev-seed-failed').slice(0, 80);
    root.__IB_DEV_BOOTSTRAP_ERROR__ = code;
    try { console.error('[IB Dev] Seed import failed (' + code + ').'); } catch (_) {}
    throw error;
  });
})(typeof window !== 'undefined' ? window : null);
