'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const projectInspect = require('../assets/js/work-mode-project-inspect.js');
const registry = require('../assets/js/action-registry.js').createRegistry();

test('Project Inspect projects only consented metadata into a bounded public structure', () => {
  const built = projectInspect.build({
    projectRef: 'project_1',
    projectName: 'Project Alpha',
    fileIds: ['file_src', 'file_test', 'file_secret_path', 'file_env'],
    files: [
      { fileId: 'file_src', path: 'src/index.js', size: 18, content: 'MUST_NOT_LEAK' },
      { fileId: 'file_test', path: 'tests/unit.test.js', size: 27 },
      { fileId: 'file_secret_path', path: 'config/credentials/app.json', size: 10 },
      { fileId: 'file_env', path: '.env.example', size: 4 },
      { fileId: 'not_consented', path: 'private/ignored.js', size: 1000 }
    ]
  });

  assert.equal(built.ok, true);
  assert.deepEqual(built.output, {
    projectRef: 'project_1',
    projectName: 'Project Alpha',
    scope: 'run-consented-files',
    fileCount: 4,
    displayableFileCount: 2,
    omittedFileCount: 2,
    totalBytes: 59,
    directories: [
      { path: 'src', fileCount: 1 },
      { path: 'tests', fileCount: 1 }
    ],
    extensions: [{ extension: '.js', fileCount: 2 }],
    files: [
      { fileId: 'file_src', path: 'src/index.js', size: 18 },
      { fileId: 'file_test', path: 'tests/unit.test.js', size: 27 }
    ]
  });
  assert.equal(registry.validateOutput('ib.project.inspect.v1', built.output).ok, true);
  assert.equal(JSON.stringify(built.output).includes('MUST_NOT_LEAK'), false);
  assert.equal(JSON.stringify(built.output).includes('not_consented'), false);
});

test('Project Inspect safely handles empty or incomplete Workspace data', () => {
  const empty = projectInspect.build({ projectRef: 'project_1', fileIds: [], files: [] });
  assert.deepEqual(empty, { ok: true, output: {
    projectRef: 'project_1', scope: 'run-consented-files', fileCount: 0,
    displayableFileCount: 0, omittedFileCount: 0, totalBytes: 0,
    directories: [], extensions: [], files: []
  } });
  assert.equal(registry.validateOutput('ib.project.inspect.v1', empty.output).ok, true);
  assert.deepEqual(projectInspect.build({ projectRef: 'project_1', fileIds: ['missing'], files: [] }),
    { ok: false, error: 'authorized-file-unavailable' });
  assert.equal(projectInspect.safeRelativePath('../outside.js'), false);
  assert.equal(projectInspect.safeRelativePath('C:\\private\\outside.js'), false);
});
