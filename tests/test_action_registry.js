const assert = require('node:assert/strict');
const test = require('node:test');

const registryCore = require('../assets/js/action-registry.js');
const registry = registryCore.createRegistry();
const RUN_ID = 'wr_12345678-1234-4234-8234-123456789012';
const CONSENT_ID = 'wrc_12345678-1234-4234-8234-123456789012';
const ROUTE_HASH = 'a'.repeat(64);

test('registers the v1 Work Actions as descriptors, not an execution system', () => {
  assert.equal(registryCore.registryVersion, 1);
  assert.deepEqual(registry.actionIds(), [
    'ib.project.inspect.v1',
    'ib.result.compare.v1',
    'ib.work.persist_result.v1',
    'ib.work.plan.v1',
    'ib.work.result.generate.v1',
    'ib.work.review_result.v1',
    'ib.workspace.read_file.v1'
  ]);
  assert.equal(typeof registry.execute, 'undefined');
  for (const actionId of registry.actionIds()) {
    const descriptor = registry.getDescriptor(actionId);
    assert.equal(descriptor.actionId, actionId);
    assert.equal(typeof descriptor.executionMode, 'string');
    assert.ok(Array.isArray(descriptor.requiredAuthority));
    assert.equal(typeof descriptor.consentRequirement, 'object');
    assert.equal(typeof descriptor.inputSchema, 'object');
    assert.equal(typeof descriptor.outputSchema, 'object');
  }
});

test('validates read-only Result Compare references and structured output', () => {
  const input = {
    runId: RUN_ID,
    sourceResultRef: { runId: RUN_ID, resultId: 'wrres_12345678-1234-4234-8234-123456789012' },
    targetArtifactRevision: { runId: 'wr_22345678-1234-4234-8234-123456789012',
      resultId: 'wrres_22345678-1234-4234-8234-123456789012' }
  };
  const output = {
    schemaVersion: 1,
    sourceResultRef: input.sourceResultRef,
    targetArtifactRevision: input.targetArtifactRevision,
    summary: { sourceFindingCount: 2, targetFindingCount: 2, addedFindings: 1,
      removedFindings: 1, changedFindings: 1, summaryChanged: true },
    statusChange: { sourceRunStatus: 'completed', targetRunStatus: 'completed',
      sourceResultStatus: 'available', targetResultStatus: 'available', changed: false },
    metadataDiff: [{ field: 'artifactCreatedAt', sourceValue: '100', targetValue: '200' }]
  };
  assert.equal(registry.validateInput('ib.result.compare.v1', input).ok, true);
  assert.equal(registry.validateInput('ib.result.compare.v1', input, 'agent').error, 'ACTION_EXECUTION_MODE_DENIED');
  assert.equal(registry.validateInput('ib.result.compare.v1', { ...input, report: 'private' }).ok, false);
  assert.equal(registry.validateOutput('ib.result.compare.v1', output).ok, true);
  assert.equal(registry.validateOutput('ib.result.compare.v1', {
    ...output, summary: { ...output.summary, addedFindings: 0 }
  }).ok, false);
  assert.equal(registry.validateOutput('ib.result.compare.v1', {
    ...output, metadataDiff: [output.metadataDiff[0], output.metadataDiff[0]]
  }).ok, false);
});

test('validates Project Inspect against the Run consent scope and bounds its public structure output', () => {
  const input = {
    runId: RUN_ID, consentId: CONSENT_ID, projectRef: 'project_1', fileIds: ['src_index']
  };
  const output = {
    projectRef: 'project_1', projectName: 'Project Alpha', scope: 'run-consented-files',
    fileCount: 1, displayableFileCount: 1, omittedFileCount: 0, totalBytes: 12,
    directories: [{ path: 'src', fileCount: 1 }],
    extensions: [{ extension: '.js', fileCount: 1 }],
    files: [{ fileId: 'src_index', path: 'src/index.js', size: 12 }]
  };
  assert.equal(registry.validateInput('ib.project.inspect.v1', input).ok, true);
  assert.equal(registry.validateInput('ib.project.inspect.v1', input, 'agent').error, 'ACTION_EXECUTION_MODE_DENIED');
  assert.equal(registry.validateInput('ib.project.inspect.v1', { ...input, fileIds: ['src_index', 'src_index'] }).ok, false);
  assert.equal(registry.validateInput('ib.project.inspect.v1', { ...input, projectPath: 'C:\\private' }).ok, false);
  assert.equal(registry.validateOutput('ib.project.inspect.v1', output).ok, true);
  assert.equal(registry.validateOutput('ib.project.inspect.v1', { ...output, fileCount: 2 }).ok, false);
  assert.equal(registry.validateOutput('ib.project.inspect.v1', { ...output, files: [{ ...output.files[0], content: 'private' }] }).ok, false);
});

test('rejects unknown Actions and enforces the dispatched read-only caller mode', () => {
  assert.equal(registry.validateInput('ib.unknown.v1', {}).error, 'ACTION_NOT_REGISTERED');
  assert.equal(registry.validateOutput('ib.unknown.v1', {}).error, 'ACTION_NOT_REGISTERED');
  assert.equal(registry.validateInput('ib.work.plan.v1', {}, 'agent').error, 'ACTION_EXECUTION_MODE_DENIED');
  assert.equal(registry.resolveLegacyTool('project.read_file'), 'ib.workspace.read_file.v1');
  assert.equal(registry.resolveLegacyTool('shell.exec'), null);
  assert.equal(registry.validateInput('ib.workspace.read_file.v1', { fileId: 'src_index', extra: true }, 'agent').error,
    'ACTION_INPUT_INVALID');
});

test('validates plan input and output with exact fields, bounds, and unique file IDs', () => {
  const input = {
    runId: RUN_ID,
    consentId: CONSENT_ID,
    projectRef: 'project_1',
    files: [{ fileId: 'src_index', path: 'src/index.js', size: 12 }]
  };
  assert.equal(registry.validateInput('ib.work.plan.v1', input).ok, true);
  assert.equal(registry.validateInput('ib.work.plan.v1', {
    ...input,
    files: [{ ...input.files[0], contentHash: ROUTE_HASH }]
  }).error, 'ACTION_INPUT_INVALID');
  assert.equal(registry.validateInput('ib.work.plan.v1', { ...input, hidden: 1 }).error, 'ACTION_INPUT_INVALID');
  assert.equal(registry.validateOutput('ib.work.plan.v1', {
    steps: [{ fileId: 'src_index', focus: 'implementation' }]
  }).ok, true);
  assert.equal(registry.validateOutput('ib.work.plan.v1', {
    steps: [
      { fileId: 'src_index', focus: 'implementation' },
      { fileId: 'src_index', focus: 'tests' }
    ]
  }).ok, false);
});

test('validates native generation inputs and parsed legacy Agent turns', () => {
  const input = {
    mode: 'native', runId: RUN_ID, consentId: CONSENT_ID, projectRef: 'project_1',
    providerScope: {
      destination: 'agent', providerRef: 'profile_agent', provider: 'openai',
      model: 'model-1', routeHash: ROUTE_HASH
    },
    messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'user prompt' }],
    jsonMode: true, budget: 1800, executor: { disableTools: true, timeoutMs: 90000 }
  };
  assert.equal(registry.validateInput('ib.work.result.generate.v1', input).ok, true);
  assert.equal(registry.validateInput('ib.work.result.generate.v1', { ...input, apiKey: 'secret' }).ok, false);
  assert.equal(registry.validateOutput('ib.work.result.generate.v1', {
    kind: 'tool_call', name: 'project.read_file', fileId: 'src_index'
  }).ok, true);
  assert.equal(registry.validateOutput('ib.work.result.generate.v1', {
    kind: 'tool_call', name: 'project.read_file', arguments: { fileId: 'src_index' }
  }).ok, false);
  assert.equal(registry.validateOutput('ib.work.result.generate.v1', {
    kind: 'final', summary: 'Reviewed source.', findings: [{
      fileId: 'src_index', line: null, severity: 'info', title: 'No issue', detail: 'No actionable issue found.'
    }]
  }).ok, true);
});

test('validates existing DSH generation route references without granting extra tools', () => {
  const input = {
    mode: 'dsh', workflowId: 'project.audit.readonly', runId: RUN_ID, consentId: CONSENT_ID,
    projectRef: 'project_1', providerRef: 'profile_agent', sessionId: 'session-12345678-1234-4234-8234-123456789012',
    plannedFileIds: ['src_index'], deferResult: true, prompt: 'Review the selected source.', timeoutMs: 600000
  };
  assert.equal(registry.validateInput('ib.work.result.generate.v1', input).ok, true);
  assert.equal(registry.validateInput('ib.work.result.generate.v1', {
    ...input, workflowId: 'coding.workspace', plannedFileIds: []
  }).ok, false);
  assert.equal(registry.validateInput('ib.work.result.generate.v1', {
    ...input, browser: true
  }).ok, false);
  assert.equal(registry.validateInput('ib.work.result.generate.v1', {
    ...input, workflowId: 'app.builder', plannedFileIds: []
  }).ok, true);
  assert.equal(registry.validateOutput('ib.work.result.generate.v1', {
    schemaVersion: 1, summary: 'Draft ready.'
  }).ok, true);
});

test('validates Review and Result persistence schemas without relaxing exact inputs', () => {
  const reviewInput = {
    runId: RUN_ID, consentId: CONSENT_ID, projectRef: 'project_1',
    steps: [{ fileId: 'src_index', focus: 'implementation' }],
    evidence: [{ fileId: 'src_index', path: 'src/index.js', bytesRead: 12, excerpt: '1: export {}' }],
    report: '{"schemaVersion":1}', dataClassification: 'project_only'
  };
  assert.equal(registry.validateInput('ib.work.review_result.v1', reviewInput).ok, true);
  assert.equal(registry.validateInput('ib.work.review_result.v1', { ...reviewInput, apiKey: 'secret' }).ok, false);
  assert.equal(registry.validateOutput('ib.work.review_result.v1', { decision: 'approve', issueCodes: [] }).ok, true);
  assert.equal(registry.validateOutput('ib.work.review_result.v1', { decision: 'revise', issueCodes: [] }).ok, false);

  const result = { schemaVersion: 1, summary: 'Review complete.', findings: [] };
  const persistInput = {
    runId: RUN_ID, requestId: 'wm-test-1', expectedVersion: 2, consentId: CONSENT_ID, result
  };
  assert.equal(registry.validateInput('ib.work.persist_result.v1', persistInput).ok, true);
  assert.equal(registry.validateInput('ib.work.persist_result.v1', { ...persistInput, note: 'extra' }).ok, false);
  assert.equal(registry.validateOutput('ib.work.persist_result.v1', {
    ok: true,
    run: { runId: RUN_ID, status: 'completed', version: 3 },
    result: {
      resultId: 'wrres_1', runId: RUN_ID, schemaVersion: 1, status: 'available', report: result
    }
  }).ok, true);
});
