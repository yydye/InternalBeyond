'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const fs = require('node:fs');
const { test } = require('node:test');
const p0 = require('../runtime/dsh-native-ui-p0.js');

test('Synthetic child receives no inherited Provider, Vault, proxy or Node injection', () => {
  const root = path.join(os.tmpdir(), 'synthetic-ui-fixture');
  const env = p0.childEnvironment('E:\\pinned-source', root, {
    PATH: 'fixture-path', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'fixture-secret',
    DEEPSEEK_API_KEY: 'fixture-secret', HTTPS_PROXY: 'fixture-proxy',
    NODE_OPTIONS: '--require fixture', IB_HOME_NODE_TOKEN: 'fixture-token',
    DSH_HOME: 'fixture-user-home',
  });
  for (const key of ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS', 'IB_HOME_NODE_TOKEN']) assert.equal(env[key], undefined);
  assert.equal(env.DSH_HOME, path.join(root, 'dsh-home'));
  assert.equal(env.IB_DEV_SYNTHETIC, '1');
  assert.equal(env.PATH, 'fixture-path');
});

test('Overlay keeps the official Gateway and only the synthetic preset/provider', () => {
  const rows = p0.overlay('E:\\source', 'E:\\fixture');
  for (const id of ['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
    assert.equal(rows.find(row => row.id === id).disabled, true);
  }
  assert.equal(rows.some(row => row.id === 'api-gateway' || row.id === 'connection'), false);
  assert.equal(rows.find(row => row.id === 'agent-default-model').config.provider, 'ib-home-node-run-required');
  const host = fs.readFileSync(path.join(__dirname, '../runtime/dsh-native-ui-p0/host.mjs'), 'utf8');
  assert.match(host, /IB_WORK_RUN_REQUIRED/);
  assert.match(host, /ctx\.tools\.guard\(\(\) => 'IB_HOME_NODE_WORK_RUN_REQUIRED'\)/);
  assert.doesNotMatch(host, /fetch\(endpoint/);
});

test('Production and ordinary Dev pages do not mount or contact the candidate', () => {
  const code = fs.readFileSync(path.join(__dirname, '../assets/js/work-mode-native-ui.js'), 'utf8');
  for (const flags of [{}, { __IB_DEV_MODE__: true }, { __IB_DEV_SYNTHETIC__: true }]) {
    const root = Object.assign({ document: new Proxy({}, { get() { throw new Error('production DOM touched'); } }) }, flags);
    vm.runInNewContext(code, { window: root });
  }
});

test('Synthetic path fence rejects siblings and traversal before controller operations', async () => {
  const oldRoot = process.env.IB_DSH_P0_WORKSPACE;
  const oldMode = process.env.IB_DEV_SYNTHETIC;
  const root = path.join(os.tmpdir(), 'ib-p0-path-fixture');
  process.env.IB_DSH_P0_WORKSPACE = root;
  process.env.IB_DEV_SYNTHETIC = '1';
  try {
    const { inside } = await import('../runtime/dsh-native-ui-p0/containment.mjs');
    assert.equal(inside(path.join(root, 'sample.js')), path.join(root, 'sample.js'));
    assert.throws(() => inside(root + '-sibling'), /P0_SYNTHETIC_PATH_ONLY/);
    assert.throws(() => inside(path.join(root, '..', 'outside')), /P0_SYNTHETIC_PATH_ONLY/);
  } finally {
    if (oldRoot === undefined) delete process.env.IB_DSH_P0_WORKSPACE; else process.env.IB_DSH_P0_WORKSPACE = oldRoot;
    if (oldMode === undefined) delete process.env.IB_DEV_SYNTHETIC; else process.env.IB_DEV_SYNTHETIC = oldMode;
  }
});
