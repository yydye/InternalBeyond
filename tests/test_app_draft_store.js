'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const createAppDraftStore = require('../services/home-node/app-draft-store.js');

const RUN_ID = 'wr_123e4567-e89b-42d3-a456-426614174000';
const RUN_ID_2 = 'wr_123e4567-e89b-42d3-a456-426614174001';
const RUN_ID_3 = 'wr_123e4567-e89b-42d3-a456-426614174002';
const RUN_ID_4 = 'wr_123e4567-e89b-42d3-a456-426614174003';

test('App Draft store commits successful runs, rolls back failures, and restores persisted versions', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-app-draft-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createAppDraftStore({ dataDir });
  store.open();

  const created = store.create({ projectRef: 'synthetic-workspace', name: 'Synthetic Todo' });
  assert.equal(created.ok, true);
  const draftRef = created.draft.draftRef;
  assert.match(draftRef, /^ad_[A-Fa-f0-9-]{36}$/);
  assert.equal(store.create({ projectRef: 'synthetic-workspace', path: '../core.js' }).ok, false);

  assert.equal(store.queueRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    instruction: 'Create a todo app.' }).ok, true);
  assert.equal(store.queueRun({ draftRef, projectRef: 'synthetic-workspace',
    runId: 'wr_123e4567-e89b-42d3-a456-426614174001', instruction: 'Concurrent write.' }).error, 'app-draft-run-active');
  assert.equal(store.createFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: 'index.html', content: '<main>Todo</main>' }).error, 'app-draft-write-denied');
  assert.equal(store.activateRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID }).ok, true);

  assert.equal(store.createFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: '../src-tauri/src/lib.rs', content: 'unsafe' }).ok, false);
  assert.equal(store.createFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: 'index.html', content: '<main>Todo</main><script>parent.document.body.innerHTML="x"</script>' }).error,
  'app-draft-html-policy-denied');
  assert.equal(store.createFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: 'index.html', content: '<main id="app">Todo</main>' }).ok, true);
  assert.equal(store.createFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: 'app.js', content: 'document.querySelector("#app");' }).ok, true);
  assert.equal(store.createFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: 'styles.css', content: '@import url(https://example.com/app.css);' }).error, 'app-draft-css-policy-denied');
  assert.equal(store.updateFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: 'app.js', content: 'fetch("https://example.com")' }).error, 'app-draft-js-policy-denied');
  assert.equal(store.createFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: 'src-tauri/src/lib.rs', content: 'must not create' }).ok, false);
  assert.equal(store.readFile({ draftRef, projectRef: 'other-project', runId: RUN_ID, path: 'index.html' }).ok, false);
  assert.equal(store.readFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID, path: 'app.js' }).ok, true);
  assert.equal(store.updateFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID,
    path: 'app.js', content: 'document.querySelector("#app").textContent="Saved";' }).ok, true);

  const uncommitted = store.get({ draftRef, projectRef: 'synthetic-workspace' }).draft;
  assert.equal(uncommitted.version, 0, 'candidate writes do not mutate the visible committed version');
  assert.deepEqual(Object.keys(uncommitted.files), [], 'the draft summary keeps the committed file set until success');
  assert.equal(store.getRunContext({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID }).files['app.js'],
    'document.querySelector("#app").textContent="Saved";');
  assert.equal(store.get({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID }).draft.files['app.js'],
    'document.querySelector("#app").textContent="Saved";', 'an exact active Run may inspect its own candidate files');

  const restored = createAppDraftStore({ dataDir });
  restored.open();
  const pending = restored.get({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID }).draft;
  assert.equal(pending.version, 0, 'refresh during execution recovers the last committed version');
  assert.equal(restored.readFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID, path: 'app.js' }).ok, true,
    'the active Run can recover its isolated candidate after refresh');
  assert.equal(store.finishRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID, status: 'completed' }).ok, true);

  let draft = store.get({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID }).draft;
  assert.equal(draft.version, 3);
  assert.equal(draft.files['app.js'], 'document.querySelector("#app").textContent="Saved";');
  assert.equal(draft.changes['app.js'].before, null);
  assert.equal(draft.changes['app.js'].after, draft.files['app.js']);
  assert.equal(draft.history.some(item => item.version === 3 && item.runId === RUN_ID), true);
  const versionThree = store.getVersion({ draftRef, projectRef: 'synthetic-workspace', version: 3 });
  assert.equal(versionThree.ok, true);
  assert.equal(versionThree.files['app.js'], 'document.querySelector("#app").textContent="Saved";');
  versionThree.files['app.js'] = 'mutated export copy';
  assert.equal(store.getVersion({ draftRef, projectRef: 'synthetic-workspace', version: 3 }).files['app.js'],
    'document.querySelector("#app").textContent="Saved";', 'version reads return detached immutable snapshots');
  assert.equal(store.getVersion({ draftRef, projectRef: 'other-project', version: 3 }).ok, false);
  assert.equal(store.getVersion({ draftRef, projectRef: 'synthetic-workspace', version: 999 }).error, 'app-draft-version-not-found');

  assert.equal(store.queueRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_2,
    instruction: 'Change the button label.' }).ok, true);
  assert.equal(store.activateRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_2 }).ok, true);
  assert.equal(store.updateFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_2,
    path: 'app.js', content: 'document.querySelector("#app").textContent="Broken candidate";' }).ok, true);
  assert.equal(store.restoreVersion({ draftRef, projectRef: 'synthetic-workspace', version: 0 }).error, 'app-draft-run-active');
  assert.equal(store.get({ draftRef, projectRef: 'synthetic-workspace' }).draft.files['app.js'], draft.files['app.js'],
    'partial edits remain invisible to the committed draft');
  assert.equal(store.finishRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_2, status: 'failed' }).ok, true);
  assert.equal(store.finishRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_2, status: 'failed' }).duplicate, true,
    'terminal draft cleanup is idempotent if runtime and cancellation race');
  draft = store.get({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_2 }).draft;
  assert.equal(draft.version, 3);
  assert.equal(draft.files['app.js'], 'document.querySelector("#app").textContent="Saved";');

  assert.equal(store.queueRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_3,
    instruction: 'Polish the app.' }).ok, true);
  assert.equal(store.activateRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_3 }).ok, true);
  assert.equal(store.updateFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_3,
    path: 'app.js', content: 'document.querySelector("#app").textContent="Polished";' }).ok, true);
  assert.equal(store.finishRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_3, status: 'completed' }).ok, true);
  assert.equal(store.get({ draftRef, projectRef: 'synthetic-workspace' }).draft.version, 4);
  assert.equal(store.getVersion({ draftRef, projectRef: 'synthetic-workspace', version: 3 }).files['app.js'],
    'document.querySelector("#app").textContent="Saved";', 'later Runs do not rewrite earlier committed snapshots');
  const restoredVersion = store.restoreVersion({ draftRef, projectRef: 'synthetic-workspace', version: 3 });
  assert.equal(restoredVersion.ok, true);
  assert.equal(restoredVersion.draft.version, 5, 'restoring creates a new immutable version');

  assert.equal(store.queueRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_4,
    instruction: 'Try and cancel a change.' }).ok, true);
  assert.equal(store.activateRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_4 }).ok, true);
  assert.equal(store.updateFile({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_4,
    path: 'app.js', content: 'document.querySelector("#app").textContent="Cancelled candidate";' }).ok, true);
  assert.equal(store.finishRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_4, status: 'cancelled' }).ok, true);
  assert.equal(store.finishRun({ draftRef, projectRef: 'synthetic-workspace', runId: RUN_ID_4, status: 'cancelled' }).duplicate, true);

  const final = store.get({ draftRef, projectRef: 'synthetic-workspace' }).draft;
  assert.equal(final.version, 5);
  assert.equal(final.files['app.js'], 'document.querySelector("#app").textContent="Saved";');
  assert.equal(final.history.at(-1).restoredFrom, 3);
  const finalReopen = createAppDraftStore({ dataDir });
  finalReopen.open();
  assert.equal(finalReopen.get({ draftRef, projectRef: 'synthetic-workspace' }).draft.files['app.js'], final.files['app.js']);
  assert.equal(finalReopen.get({ draftRef, projectRef: 'synthetic-workspace' }).draft.history.at(-1).version, 5);
});

test('legacy P1 drafts discard a failed Run partial write when the transactional store opens', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-app-draft-legacy-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createAppDraftStore({ dataDir });
  store.open();
  const draft = store.create({ projectRef: 'synthetic-workspace', name: 'Legacy Todo' }).draft;
  assert.equal(store.queueRun({ draftRef: draft.draftRef, projectRef: draft.projectRef, runId: RUN_ID,
    instruction: 'Create a legacy Todo.' }).ok, true);
  assert.equal(store.activateRun({ draftRef: draft.draftRef, projectRef: draft.projectRef, runId: RUN_ID }).ok, true);
  for (const [pathname, content] of [['index.html', '<main>Todo</main>'], ['styles.css', 'main{color:#123}'],
    ['app.js', 'document.querySelector("main");']]) {
    assert.equal(store.createFile({ draftRef: draft.draftRef, projectRef: draft.projectRef, runId: RUN_ID,
      path: pathname, content }).ok, true);
  }

  const filePath = path.join(dataDir, 'app-drafts.json');
  const legacy = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const storedDraft = legacy.drafts[draft.draftRef];
  const run = storedDraft.runs[RUN_ID];
  storedDraft.files = run.workingFiles;
  storedDraft.version = run.baseVersion + run.pendingRevision;
  storedDraft.history = undefined;
  run.status = 'failed';
  delete run.workingFiles; delete run.baseFiles; delete run.pendingRevision; delete run.baseVersion;
  fs.writeFileSync(filePath, JSON.stringify(legacy));

  const migrated = createAppDraftStore({ dataDir });
  migrated.open();
  const current = migrated.get({ draftRef: draft.draftRef, projectRef: draft.projectRef }).draft;
  assert.equal(current.version, 0);
  assert.deepEqual(Object.keys(current.files), [], 'legacy partial files are rolled back to the prior saved version');
  assert.equal(current.history[0].version, 0);
});
