'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const contract = require('../assets/js/workspace-change-contract.js');

test('the canonical Workspace change result preserves authorized-snapshot semantics', () => {
  assert.deepEqual(contract.snapshotChangedResult(), {
    ok: false,
    error: 'workspace-changed',
    workspaceChange: { scope: 'authorized-snapshot', reason: 'snapshot-mismatch' }
  });
});

test('legacy snapshot error codes normalize without mutating older result objects', () => {
  const legacy = { ok: false, error: 'workspace-changed-snapshot', content: 'MUST_NOT_PASS_THROUGH' };
  const normalized = contract.normalizeResult(legacy);
  assert.deepEqual(normalized, {
    ok: false,
    error: 'workspace-changed',
    workspaceChange: {
      scope: 'authorized-snapshot', reason: 'snapshot-mismatch', legacyCode: 'workspace-changed-snapshot'
    }
  });
  assert.equal(legacy.error, 'workspace-changed-snapshot');
  assert.equal(JSON.stringify(normalized).includes('MUST_NOT_PASS_THROUGH'), false,
    'the compatibility normalizer only projects canonical diagnostic metadata');
  assert.equal(contract.normalizeError('workspace-changed-snapshot'), 'workspace-changed');
  assert.equal(contract.normalizeError('workspace-changed'), 'workspace-changed');
});

test('unrelated Workspace outcomes pass through unchanged', () => {
  const result = { ok: false, error: 'scope-denied' };
  assert.equal(contract.normalizeResult(result), result);
  assert.equal(contract.normalizeError('workspace-changed-before-write'), 'workspace-changed-before-write');
  assert.equal(contract.normalizeResult(null), null);
});

test('the contract document records canonical, legacy, and snapshot-detail semantics', () => {
  const document = fs.readFileSync(path.join(__dirname, '..', 'docs/contracts/WORKSPACE_CHANGE_RESULT_CONTRACT.md'), 'utf8');
  assert.match(document, /`workspace-changed` is the canonical error code/);
  assert.match(document, /`workspace-changed-snapshot` is a legacy alias/);
  assert.match(document, /`reason: "snapshot-mismatch"`/);
  assert.match(document, /No standalone Workspace event bus or event store/);
});
