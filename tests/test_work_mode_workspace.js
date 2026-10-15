'use strict';

/* P28-WM-P2 · exercise the production Workspace read-only projection without a browser. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const projectToolFactory = require('../assets/js/work-mode-project-tool.js');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'assets/js/workspace/files.js'), 'utf8');
const PAGE = fs.readFileSync(path.join(ROOT, 'InternalBeyond.html'), 'utf8');
assert(PAGE.indexOf('assets/js/workspace-change-contract.js') >= 0
  && PAGE.indexOf('assets/js/workspace-change-contract.js') < PAGE.indexOf('assets/js/work-mode-project-tool.js')
  && PAGE.indexOf('assets/js/workspace-change-contract.js') < PAGE.indexOf('assets/js/work-mode-dsh-bridge.js'),
'the shared Workspace change contract loads before Work Mode project tools and the DSH bridge');
const projects = new Map([
  ['proj_alpha', { id: 'proj_alpha', name: { displayName: 'Alpha', path: 'E:\\workspace\\alpha' } }],
  ['proj_empty', { id: 'proj_empty', name: 'Empty', path: 'E:\\workspace\\empty' }],
  ['proj_no_path', { id: 'proj_no_path', name: 'No path metadata' }],
  ['proj_nested_id', { id: { value: 'proj_nested_id' }, name: { value: 'Nested project' }, rootPath: 'E:\\workspace\\nested' }],
  ['proj_beta', { id: 'proj_beta', name: 'Beta' }]
]);
const sourceText = 'const token = "sk-test-secret";\nexport const ready = true;';
const testText = value => Buffer.byteLength(value, 'utf8');
const hashText = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const files = new Map([
  ['pf_source', { id: 'pf_source', projectId: 'proj_alpha', path: 'src/index.js', size: testText(sourceText), content: sourceText }],
  ['pf_env', { id: 'pf_env', projectId: 'proj_alpha', path: '.env', size: 14, content: 'SECRET=hidden' }],
  ['pf_traversal', { id: 'pf_traversal', projectId: 'proj_alpha', path: '../outside.js', size: 10, content: 'outside' }],
  ['pf_binary', { id: 'pf_binary', projectId: 'proj_alpha', path: 'assets/logo.png', size: 5, content: 'aGVsbG8=' }],
  ['pf_large', { id: 'pf_large', projectId: 'proj_alpha', path: 'large.txt', size: 140000, content: 'large' }],
  ['pf_foreign', { id: 'pf_foreign', projectId: 'proj_beta', path: 'src/private.js', size: 10, content: 'foreign' }]
]);
let projectReadFailure = false;
let fileIndexReadFailure = false;
const context = {
  TextEncoder,
  Blob,
  crypto: crypto.webcrypto,
  dbGetAll: async store => {
    if (store === 'projects' && projectReadFailure) throw new Error('workspace-unavailable');
    return store === 'projects' ? Array.from(projects.values()) : store === 'projectFiles' ? Array.from(files.values()) : [];
  },
  dbGet: async (store, key) => store === 'projects' ? projects.get(key) || null : (files.get(key) || null),
  dbGetByIndex: async (store, index, value) => {
    if (store === 'projectFiles' && fileIndexReadFailure) throw new Error('file index unavailable');
    return store === 'projectFiles' ? Array.from(files.values()).filter(file => file.projectId === value) : [];
  },
  dbPut: async (store, value) => {
    if (store === 'projects') projects.set(value.id, value);
    else if (store === 'projectFiles') files.set(value.id, value);
    return value && value.id;
  },
  document: { addEventListener: function () {} },
  console: console
};
context.window = context;
context.IB = {
  expose: function (name, value) {
    const parts = name.split('.');
    let target = context.IB;
    while (parts.length > 1) {
      const part = parts.shift();
      target = target[part] || (target[part] = {});
    }
    target[parts[0]] = value;
  }
};
vm.runInNewContext(SOURCE, context, { filename: 'assets/js/workspace/files.js' });

async function main() {
  const workspace = context.IB.workspace.files;
  const projectList = await workspace.wsGetWorkModeProjects();
  assert.strictEqual(projectList.ok, true);
  assert.deepStrictEqual(Array.from(projectList.projects, project => [project.id, project.name, project.path]), [
    ['proj_alpha', 'Alpha', 'E:\\workspace\\alpha'],
    ['proj_empty', 'Empty', 'E:\\workspace\\empty'],
    ['proj_no_path', 'No path metadata', ''],
    ['proj_nested_id', 'Nested project', 'E:\\workspace\\nested'],
    ['proj_beta', 'Beta', '']
  ], 'Work Mode projects project name, path, and ID are normalized to text values');
  assert.strictEqual(JSON.stringify(projectList).includes('[object Object]'), false);
  projectReadFailure = true;
  assert.strictEqual((await workspace.wsGetWorkModeProjects()).error, 'workspace-unavailable',
    'a project-list read failure is not projected as an empty Workspace');
  projectReadFailure = false;
  const snapshot = await workspace.wsGetWorkModeProjectSnapshot('proj_alpha');
  assert.strictEqual(snapshot.ok, true);
  assert.deepStrictEqual(Array.from(snapshot.files, file => file.fileId), ['pf_source']);
  assert.match(snapshot.files[0].contentHash, /^[a-f0-9]{64}$/);
  assert.strictEqual(snapshot.projectPath, 'E:\\workspace\\alpha');
  const emptySnapshot = await workspace.wsGetWorkModeProjectSnapshot('proj_empty');
  assert.strictEqual(emptySnapshot.ok, true, 'an accessible empty project is distinct from a failed Workspace read');
  assert.deepStrictEqual(Array.from(emptySnapshot.files), []);
  fileIndexReadFailure = true;
  assert.strictEqual((await workspace.wsGetWorkModeProjectSnapshot('proj_empty')).error, 'workspace-unavailable',
    'an IndexedDB file-index failure remains a failure and is never shown as an empty project');
  fileIndexReadFailure = false;
  const nestedIdSnapshot = await workspace.wsGetWorkModeProjectSnapshot('proj_nested_id');
  assert.strictEqual(nestedIdSnapshot.ok, true, 'a normalized project ID resolves to the same Workspace record');
  assert.deepStrictEqual(Array.from(nestedIdSnapshot.files), []);
  const noPathSnapshot = await workspace.wsGetWorkModeProjectSnapshot('proj_no_path');
  assert.strictEqual(noPathSnapshot.projectPath, '', 'missing root-path metadata is preserved rather than fabricated');
  assert.strictEqual((await workspace.wsGetWorkModeProjectSnapshot('../proj_alpha')).error, 'invalid-project-ref');
  assert.strictEqual((await workspace.wsGetWorkModeProjectSnapshot('proj_missing')).error, 'project-not-found');

  const read = await workspace.wsReadWorkModeFile('proj_alpha', 'pf_source');
  assert.strictEqual(read.ok, true);
  assert.strictEqual(read.content.includes('sk-test-secret'), true, 'Workspace source is transient; tool adapter owns egress redaction');
  assert.strictEqual((await workspace.wsReadWorkModeFile('proj_alpha', 'pf_foreign')).error, 'scope-denied');
  assert.strictEqual((await workspace.wsReadWorkModeFile('proj_alpha', 'pf_env')).error, 'file-not-readable');
  assert.strictEqual((await workspace.wsReadWorkModeFile('proj_alpha', 'pf_traversal')).error, 'file-not-readable');
  assert.strictEqual((await workspace.wsReadWorkModeFile('proj_alpha', 'pf_binary')).error, 'file-not-readable');
  assert.strictEqual((await workspace.wsReadWorkModeFile('proj_alpha', 'pf_large')).error, 'file-not-readable');

  const importedText = 'export const onboarded = true;';
  const picked = { name: 'notes.md', size: testText(importedText), webkitRelativePath: 'selected_project/docs/notes.md',
    text: async () => importedText };
  const imported = await workspace.wsImportWorkModeFiles('proj_alpha', [picked]);
  assert.strictEqual(imported.ok, true, 'the explicit picker writes into the selected existing Workspace project');
  assert.strictEqual(imported.imported.length, 1);
  assert.strictEqual(imported.snapshot.projectRef, 'proj_alpha');
  const importedFile = imported.snapshot.files.find(file => file.fileId === imported.imported[0]);
  assert.strictEqual(importedFile.path, 'selected_project/docs/notes.md');
  assert.strictEqual((await workspace.wsReadWorkModeFile('proj_alpha', importedFile.fileId)).content, importedText);
  const repeated = await workspace.wsImportWorkModeFiles('proj_alpha', [picked]);
  assert.deepStrictEqual(Array.from(repeated.unchanged), [importedFile.fileId], 'identical files are idempotent');
  assert.strictEqual((await workspace.wsImportWorkModeFiles('proj_alpha', [{ ...picked, webkitRelativePath: '../escape.js' }])).error,
    'workspace-file-path-invalid', 'parent traversal paths are rejected before a Workspace write');
  assert.strictEqual((await workspace.wsImportWorkModeFiles('proj_alpha', [{ ...picked, name: '.env', webkitRelativePath: '.env' }])).error,
    'no-eligible-files', 'sensitive names are excluded by the read-only allowlist');
  assert.strictEqual((await workspace.wsImportWorkModeFiles('proj_alpha', [{ ...picked, webkitRelativePath: 'src/index.js', text: async () => 'changed' }])).error,
    'workspace-file-conflict', 'existing Workspace content is never overwritten implicitly');
  const countBeforeFailedBatch = files.size;
  const failedBatch = await workspace.wsImportWorkModeFiles('proj_alpha', [picked,
    { name: 'other.js', size: 1, webkitRelativePath: 'other.js', text: async () => { throw new Error('read denied'); } }]);
  assert.strictEqual(failedBatch.error, 'file-read-failed');
  assert.strictEqual(files.size, countBeforeFailedBatch, 'a selected-file read failure writes none of that batch');

  const createdProject = await workspace.wsCreateWorkModeProject('P3.1 selected folder');
  assert.strictEqual(createdProject.ok, true);
  assert.strictEqual(createdProject.created, true, 'an explicit folder selection can create a Workspace project when none exists');
  const createdSnapshot = await workspace.wsGetWorkModeProjectSnapshot(createdProject.projectRef);
  assert.strictEqual(createdSnapshot.projectPath, '', 'browser folder selection never fabricates an absolute root path');
  const reusedProject = await workspace.wsCreateWorkModeProject('P3.1 selected folder');
  assert.strictEqual(reusedProject.projectRef, createdProject.projectRef);
  assert.strictEqual(reusedProject.created, false, 'repeated project names bind to the existing Workspace project');
  assert.strictEqual((await workspace.wsCreateWorkModeProject('')).error, 'project-name-required');

  const tool = projectToolFactory({ workspace });
  const oldScope = await tool.snapshot('proj_alpha');
  assert.strictEqual(oldScope.projectName, 'Alpha', 'the read-only snapshot keeps the existing project name metadata');
  const sourceRecord = files.get('pf_source');
  const changedSource = sourceRecord.content.replace('true', 'nope');
  sourceRecord.content = changedSource;
  sourceRecord.size = testText(changedSource);
  files.set('pf_source', sourceRecord);
  const staleRead = await tool.readFile({ projectRef: 'proj_alpha', fileId: 'pf_source', scope: oldScope });
  assert.strictEqual(staleRead.error, 'workspace-changed', 'same file ID with changed contents invalidates the old snapshot');
  assert.deepStrictEqual(staleRead.workspaceChange, {
    scope: 'authorized-snapshot', reason: 'snapshot-mismatch'
  }, 'the canonical error keeps the stale authorized-snapshot meaning');

  const legacyWorkspace = Object.assign({}, workspace, {
    wsReadWorkModeFile: async () => ({ ok: false, error: 'workspace-changed-snapshot' })
  });
  const legacyTool = projectToolFactory({ workspace: legacyWorkspace });
  const legacyScope = await legacyTool.snapshot('proj_alpha');
  const legacyRead = await legacyTool.readFile({ projectRef: 'proj_alpha', fileId: 'pf_source', scope: legacyScope });
  assert.strictEqual(legacyRead.error, 'workspace-changed', 'legacy Workspace results normalize to the canonical error');
  assert.deepStrictEqual(legacyRead.workspaceChange, {
    scope: 'authorized-snapshot', reason: 'snapshot-mismatch', legacyCode: 'workspace-changed-snapshot'
  }, 'legacy snapshot-specific meaning remains available during migration');
  assert.strictEqual((await workspace.wsReadWorkModeFile('proj_beta', 'pf_source')).error, 'scope-denied');
  console.log('Work Mode Workspace read-only boundary passed (exact project scope, relative text files, denied sensitive paths).');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
