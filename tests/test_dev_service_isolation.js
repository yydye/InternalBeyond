'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const contract = require('../runtime/dev-service-contract.js');
const registry = require('../runtime/component-registry.js');
const lifecycle = require('../runtime/component-lifecycle.js');
const createActiveHttp = require('../active/http.js');
const launcher = require('../runtime/ib-dev-launcher.js');
const createActiveEconomyChannelClient = require('../active/economy-channel-client.js');
const syntheticSeed = require('../runtime/dev-synthetic-seed.js');

function makeDevEnvironment(root, options) {
  options = options || {};
  const synthetic = options.synthetic !== false;
  const sandbox = synthetic
    ? path.join(root, 'InternalBeyond', 'dev-synthetic', 'dev-sandbox')
    : path.join(root, 'InternalBeyond', 'dev-sandbox');
  const ports = Object.assign({}, contract.DEV_PORTS, options.ports || {});
  const env = {
    IB_DEV_MODE: '1',
    IB_DEV_SYNTHETIC: synthetic ? '1' : '0',
    IB_DEV_INSTANCE_ID: crypto.randomUUID(),
    IB_DEV_SESSION_TOKEN: crypto.randomBytes(32).toString('hex'),
    IB_DEV_SANDBOX_ROOT: sandbox,
    IB_ACTIVE_DATA_DIR: path.join(sandbox, 'active'),
    IB_BRIDGE_DATA_DIR: path.join(sandbox, 'bridge'),
    IB_HOME_NODE_DATA_DIR: path.join(sandbox, 'home-node'),
    IB_CREDENTIAL_DATA_DIR: path.join(sandbox, 'credential-vault'),
    IB_CREDENTIAL_BINDINGS_DIR: path.join(sandbox, 'credential-vault')
  };
  for (const [name, envName] of Object.entries(contract.PORT_ENV)) env[envName] = String(ports[name]);
  return { env, ports, sandbox };
}

function headers(identity, origin) {
  return Object.assign({ origin: origin || identity.webOrigin }, {
    'x-ib-dev-session': identity.sessionToken,
    'x-ib-dev-instance': identity.instanceId
  });
}

function activeContext(identity, env, vaultWrites) {
  return {
    HOST: '127.0.0.1', PORT: 0, maxBody: 4096,
    devIdentity: identity,
    authorizeRequestIdentity: request => contract.authorizeRequestIdentity(request, env, identity.webOrigin),
    getState: () => ({ credentialBindings: [] }),
    saveNow: () => {},
    queueSave: () => {},
    armedUsers: new Set(),
    publicPlan: value => value,
    sanitizeAiPlan: value => value,
    buildTaskReplacement: value => value,
    recordUserId: value => value,
    trimText: value => String(value || '').slice(0, 1200),
    deepClone: value => JSON.parse(JSON.stringify(value)),
    finiteTimestamp: () => 0,
    sanitizeMomentSchedule: value => value,
    publicMomentSchedule: value => value,
    proactiveTrace: { enabled: () => false, recent: () => [] },
    credentialVault: { upsert(id, value) { vaultWrites.push({ id, value }); return true; } }
  };
}

async function withServer(server, action) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try { return await action(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Dev service discovery fails closed on missing ports, role collisions, and any production port', () => {
  const { env, ports } = makeDevEnvironment(os.tmpdir());
  assert.deepEqual(Object.assign({}, contract.portsFromEnvironment(env)), ports);
  assert.throws(() => contract.portsFromEnvironment(Object.assign({}, env, { IB_ACTIVE_PORT: '' })), /dev-service-port-required:IB_ACTIVE_PORT/);
  assert.throws(() => contract.portsFromEnvironment(Object.assign({}, env, { IB_DSH_WEB_PORT: env.IB_ACTIVE_PORT })), /dev-service-port-conflict/);
  assert.throws(() => contract.portsFromEnvironment(Object.assign({}, env, { IB_ACTIVE_PORT: '23120' })), /dev-service-port-overlaps-production:active/);
  assert.throws(() => contract.portsFromEnvironment(Object.assign({}, env, { IB_ECONOMY_CHANNEL_SOURCE_PORT: '23114' })), /dev-service-port-overlaps-production:activeChannelSource/);
  assert.throws(() => contract.servicePort('active', Object.assign({}, env, { IB_ACTIVE_PORT: '' }), 23114), /dev-service-port-required:IB_ACTIVE_PORT/);
  assert.equal(registry.portOfEnv('IB_ACTIVE_PORT', 23114, { IB_DEV_MODE: '1' }), 0,
    'a missing Dev registry override must not resolve to production Active');
  assert.equal(lifecycle.legacyTargets({ IB_DEV_MODE: '1' }).every(target => target.port === 0), true,
    'the installer compatibility table must also fail closed in Dev');
});

test('Dev authorization requires the matching instance capability and production rejects Dev identities', () => {
  const { env } = makeDevEnvironment(os.tmpdir());
  const identity = contract.identityFromEnvironment(env);
  assert.equal(contract.authorizeRequestIdentity({ headers: headers(identity) }, env, identity.webOrigin), true);
  assert.equal(contract.authorizeRequestIdentity({ headers: Object.assign(headers(identity), { 'x-ib-dev-instance': crypto.randomUUID() }) }, env, identity.webOrigin), false);
  assert.equal(contract.authorizeRequestIdentity({ headers: Object.assign(headers(identity), { 'x-ib-dev-session': 'f'.repeat(64) }) }, env, identity.webOrigin), false);
  assert.equal(contract.authorizeRequestIdentity({ headers: headers(identity, 'http://127.0.0.1:23120') }, env, identity.webOrigin), false);

  const production = { IB_DEV_MODE: '0' };
  assert.equal(contract.authorizeRequestIdentity({ headers: headers(identity, '') }, production), false);
  assert.equal(contract.isKnownDevOrigin('http://localhost:23134'), true);
  assert.equal(contract.isKnownDevOrigin('http://127.0.0.1:23141'), true);
  assert.equal(contract.isKnownDevOrigin('http://127.0.0.1:23120'), false);
});

test('Synthetic Active credential writes stay in the owning environment', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dev-identity-active-'));
  const { env } = makeDevEnvironment(tempRoot, { ports: { web: 24001 } });
  const identity = contract.identityFromEnvironment(env);
  const vaultWrites = [];
  const active = createActiveHttp(activeContext(identity, env, vaultWrites));
  try {
    await withServer(active.server, async port => {
      const url = 'http://127.0.0.1:' + port + '/credentials';
      const payload = { credentials: [{ credentialRef: 'synthetic-fixture', provider: 'openai', apiKey: 'fake-only-key' }] };
      const denied = await fetch(url, { method: 'POST', headers: { Origin: identity.webOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      assert.equal(denied.status, 403);
      assert.equal(vaultWrites.length, 0);

      const wrongOrigin = await fetch(url, { method: 'POST', headers: Object.assign(headers(identity, 'http://127.0.0.1:23120'), { 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      assert.equal(wrongOrigin.status, 403);
      assert.equal(vaultWrites.length, 0);

      const accepted = await fetch(url, { method: 'POST', headers: Object.assign(headers(identity), { 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      assert.equal(accepted.status, 200);
      assert.equal((await accepted.json()).stored, 1);
      assert.equal(vaultWrites.length, 1);
    });

    const productionWrites = [];
    const productionEnv = { IB_DEV_MODE: '0' };
    const production = createActiveHttp(Object.assign(activeContext({ mode: 'production' }, productionEnv, productionWrites), {
      authorizeRequestIdentity: request => contract.authorizeRequestIdentity(request, productionEnv)
    }));
    await withServer(production.server, async port => {
      const payload = { credentials: [{ credentialRef: 'cross-environment', provider: 'openai', apiKey: 'fake-only-key' }] };
      const response = await fetch('http://127.0.0.1:' + port + '/credentials', {
        method: 'POST', headers: Object.assign(headers(identity), { 'Content-Type': 'application/json' }), body: JSON.stringify(payload)
      });
      assert.equal(response.status, 403);
      assert.equal(productionWrites.length, 0, 'a Synthetic WebView request cannot write the formal Active Vault');
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Synthetic Active economy route ignores production override and sends Dev instance identity', async () => {
  const { env } = makeDevEnvironment(os.tmpdir());
  env.IB_ECONOMY_CHANNEL_BASE = 'http://127.0.0.1:23118';
  env.IB_ECONOMY_CHANNEL_TOKEN = 'synthetic-channel-fixture';
  const identity = contract.identityFromEnvironment(env);
  let seen = null;
  const client = createActiveEconomyChannelClient({
    env,
    token: 'synthetic-channel-fixture',
    identityHeaders: contract.identityHeaders(identity),
    fetch: async (url, init) => {
      seen = { url, headers: init.headers };
      return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
    }
  });
  const config = createActiveEconomyChannelClient.configFromEnv(env);
  assert.equal(config.base, 'http://127.0.0.1:' + env.IB_HOME_NODE_PORT);
  assert.equal(config.sourcePort, Number(env.IB_ECONOMY_CHANNEL_SOURCE_PORT));
  const result = await client.sendCommand({ commandId: 'synthetic-1', idempotencyKey: 'synthetic-1', proposal: {} }, 'economy.propose_purchase');
  assert.equal(result.ok, true);
  assert.equal(seen.url, 'http://127.0.0.1:' + env.IB_HOME_NODE_PORT + '/internal/economy/command');
  assert.equal(seen.headers['X-IB-Dev-Session'], identity.sessionToken);
  assert.equal(seen.headers['X-IB-Dev-Instance'], identity.instanceId);
  assert.throws(() => createActiveEconomyChannelClient.configFromEnv(Object.assign({}, env, { IB_ECONOMY_CHANNEL_SOURCE_PORT: '0' })), /dev-economy-source-port-required/);
});

test('Synthetic Fake Provider control writes require the same Dev instance identity', async t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dev-identity-fake-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const { env } = makeDevEnvironment(tempRoot);
  const identity = contract.identityFromEnvironment(env);
  const provider = await syntheticSeed.createSyntheticFakeProvider({ port: 0, identity, environment: env });
  t.after(() => provider.close());
  const base = 'http://127.0.0.1:' + provider.port;
  const deniedStatus = await fetch(base + '/__status');
  assert.equal(deniedStatus.status, 403);
  const deniedWrite = await fetch(base + '/__control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true })
  });
  assert.equal(deniedWrite.status, 403);
  const accepted = await fetch(base + '/__control', {
    method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, contract.identityHeaders(identity)),
    body: JSON.stringify({ reset: true })
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).ok, true);
});

test('Tauri Dev environment overrides caller-supplied production ports and Vault paths', () => {
  const env = launcher.tauriEnvironment({
    IB_ACTIVE_PORT: '23114', IB_RESTART_PORT: '23116', IB_HOME_NODE_PORT: '23118',
    IB_CREDENTIAL_DATA_DIR: path.join(os.tmpdir(), 'formal-vault'),
    IB_HOME_NODE_TOKEN: 'formal-token'
  });
  assert.equal(env.IB_ACTIVE_PORT, String(launcher.DEV_PORTS.active));
  assert.equal(env.IB_RESTART_PORT, String(launcher.DEV_PORTS.restart));
  assert.equal(env.IB_HOME_NODE_PORT, String(launcher.DEV_PORTS.homeNode));
  assert.equal(env.IB_CREDENTIAL_DATA_DIR, path.join(launcher.SANDBOX, 'credential-vault'));
  assert.equal(env.IB_HOME_NODE_TOKEN, undefined);
});

test('a shared Cargo cache override must still resolve inside a private Sandbox', () => {
  const root = path.join(os.tmpdir(), 'ib-dev-cargo-cache-fixture');
  const modulePath = path.resolve(__dirname, '../runtime/ib-dev-launcher.js');
  const target = path.join(root, 'InternalBeyond', 'dev-synthetic', 'dev-sandbox', 'cargo-target');
  const script = 'const l=require(' + JSON.stringify(modulePath) + '); process.stdout.write(l.tauriEnvironment().CARGO_TARGET_DIR);';
  const accepted = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', env: Object.assign({}, process.env, {
    LOCALAPPDATA: path.join(root, 'local-app-data'), IB_DEV_CARGO_TARGET_DIR: target
  }) });
  assert.equal(path.resolve(accepted), path.resolve(target));
  const rejected = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: Object.assign({}, process.env, {
    LOCALAPPDATA: path.join(root, 'local-app-data'), IB_DEV_CARGO_TARGET_DIR: path.join(root, 'outside', 'cargo-target')
  }) });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /dev-cargo-target-must-belong-to-a-private-sandbox/);
});

test('Synthetic restart control has no production-port fallback and sends its identity', async () => {
  const code = fs.readFileSync(path.join(__dirname, '../assets/js/backend-restart.js'), 'utf8');
  const calls = [];
  const document = { readyState: 'loading', addEventListener() {}, getElementById() { return null; } };
  const root = { __IB_DEV_MODE__: true, IB: {}, document };
  const context = {
    window: root, document, console,
    AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: Object.assign({}, init && init.headers || {}) });
      return { status: 403, ok: false, async json() { return { ok: false }; } };
    }
  };
  vm.runInNewContext(code, context);
  root.ibRestartBackend();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0, 'a missing Dev service config must fail closed');

  const identity = { sessionToken: crypto.randomBytes(32).toString('hex'), instanceId: crypto.randomUUID() };
  root.__IB_DEV_SERVICE_CONFIG__ = Object.assign({ mode: 'synthetic', restartUrl: 'http://127.0.0.1:26036' }, identity);
  root.__ibRestartState = undefined;
  root.ibRestartBackend();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:26036/restart');
  assert.equal(calls[0].headers['X-IB-Dev-Session'], identity.sessionToken);
  assert.equal(calls[0].headers['X-IB-Dev-Instance'], identity.instanceId);
});
