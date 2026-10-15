'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const devContract = require('../runtime/dev-service-contract.js');
const createHomeNodeHttp = require('../services/home-node/http.js');

function devEnvironment() {
  const sandboxRoot = path.join(os.tmpdir(), 'ib-memory-cors-fixture', 'InternalBeyond', 'dev-synthetic', 'dev-sandbox');
  const env = {
    IB_DEV_MODE: '1',
    IB_DEV_SYNTHETIC: '1',
    IB_DEV_INSTANCE_ID: crypto.randomUUID(),
    IB_DEV_SESSION_TOKEN: crypto.randomBytes(32).toString('hex'),
    IB_DEV_SANDBOX_ROOT: sandboxRoot,
    IB_ACTIVE_DATA_DIR: path.join(sandboxRoot, 'active'),
    IB_BRIDGE_DATA_DIR: path.join(sandboxRoot, 'bridge'),
    IB_HOME_NODE_DATA_DIR: path.join(sandboxRoot, 'home-node'),
    IB_CREDENTIAL_DATA_DIR: path.join(sandboxRoot, 'credential-vault'),
    IB_CREDENTIAL_BINDINGS_DIR: path.join(sandboxRoot, 'credential-vault')
  };
  for (const envName of Object.values(devContract.PORT_ENV)) env[envName] = '23130';
  env.IB_HOME_NODE_PORT = '23138';
  const identity = devContract.identityFromEnvironment(env);
  return { env, identity };
}

function startHttp(options) {
  const opts = options || {};
  const dispatches = [];
  const adminPaths = ['/memory/list', '/memory/records', '/memory/record', '/memory/activate'];
  const gateway = {
    ADMIN_PATHS: adminPaths,
    handles: pathname => adminPaths.includes(pathname) || pathname.indexOf('/mobile/') === 0,
    dispatch(pathname, req, res) {
      dispatches.push({ pathname, method: String(req.method || '').toUpperCase() });
      if (String(req.method || '').toUpperCase() === 'OPTIONS') {
        const origin = String(req.headers.origin || '');
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-IB-Mobile-Token, X-IB-Home-Token, X-IB-Protocol, Last-Event-ID'
        });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }
  };
  const instance = createHomeNodeHttp({
    store: { meta: () => ({ revision: 0 }), listConversations: () => [] },
    gateway,
    token: 'isolated-home-node-token',
    devMode: opts.devMode === true,
    devIdentity: opts.identity || { mode: 'production' },
    authorizeRequestIdentity: opts.authorizeRequestIdentity || (() => false),
    allowedOrigins: [],
    loopbackBind: true,
    logger: () => {}
  });
  return new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(0, '127.0.0.1', () => resolve({
      port: instance.server.address().port,
      server: instance.server,
      dispatches: dispatches
    }));
  });
}

function request(port, method, pathname, origin, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname,
      headers: Object.assign({ Origin: origin }, headers || {})
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch (_) { /* no body */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('Dev desktop Memory preflight uses Dev CORS headers while writes remain instance-authorized', async t => {
  const { env, identity } = devEnvironment();
  const auth = request => devContract.authorizeRequestIdentity(request, env, identity.webOrigin);
  const node = await startHttp({ devMode: true, identity, authorizeRequestIdentity: auth });
  t.after(() => new Promise(resolve => node.server.close(resolve)));

  const preflight = await request(node.port, 'OPTIONS', '/memory/records', identity.webOrigin, {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-ib-home-token,x-ib-protocol,x-ib-dev-session,x-ib-dev-instance'
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], identity.webOrigin);
  const allowed = String(preflight.headers['access-control-allow-headers'] || '').toLowerCase();
  assert.match(allowed, /x-ib-dev-session/);
  assert.match(allowed, /x-ib-dev-instance/);
  assert.equal(node.dispatches.length, 0, 'Dev desktop admin preflight uses the HTTP CORS policy');

  const noIdentity = await request(node.port, 'POST', '/memory/records', identity.webOrigin, {
    'X-IB-Home-Token': 'isolated-home-node-token',
    'Content-Type': 'application/json'
  });
  assert.equal(noIdentity.status, 403);
  assert.equal(noIdentity.body && noIdentity.body.error, 'environment-identity-mismatch');
  assert.equal(node.dispatches.length, 0, 'CORS permission does not authorize the actual write');

  const accepted = await request(node.port, 'POST', '/memory/records', identity.webOrigin, {
    'X-IB-Home-Token': 'isolated-home-node-token',
    'X-IB-Dev-Session': identity.sessionToken,
    'X-IB-Dev-Instance': identity.instanceId,
    'Content-Type': 'application/json'
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.deepEqual(node.dispatches, [{ pathname: '/memory/records', method: 'POST' }]);

  const foreign = await request(node.port, 'OPTIONS', '/memory/records', 'https://evil.example', {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'x-ib-dev-session,x-ib-dev-instance'
  });
  assert.equal(foreign.status, 204);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined,
    'the generic Dev preflight still does not expose the service to a foreign Origin');
});

test('production and mobile Gateway preflights retain the Gateway policy', async t => {
  const { identity } = devEnvironment();
  const production = await startHttp({ devMode: false, identity: { mode: 'production' } });
  t.after(() => new Promise(resolve => production.server.close(resolve)));

  const admin = await request(production.port, 'OPTIONS', '/memory/records', identity.webOrigin, {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-ib-dev-session,x-ib-dev-instance'
  });
  assert.equal(admin.status, 204);
  assert.deepEqual(production.dispatches, [{ pathname: '/memory/records', method: 'OPTIONS' }]);
  assert.doesNotMatch(String(admin.headers['access-control-allow-headers'] || '').toLowerCase(), /x-ib-dev-session/);

  const deniedWrite = await request(production.port, 'POST', '/memory/records', identity.webOrigin, {
    'X-IB-Home-Token': 'isolated-home-node-token',
    'X-IB-Dev-Session': identity.sessionToken,
    'X-IB-Dev-Instance': identity.instanceId,
    'Content-Type': 'application/json'
  });
  assert.equal(deniedWrite.status, 403);
  assert.equal(deniedWrite.body && deniedWrite.body.error, 'environment-identity-mismatch');
  assert.equal(production.dispatches.length, 1, 'production must reject the Dev write before Gateway dispatch');

  const mobile = await request(production.port, 'OPTIONS', '/mobile/v1/chat/send', identity.webOrigin, {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,x-ib-mobile-token'
  });
  assert.equal(mobile.status, 204);
  assert.deepEqual(production.dispatches[1], { pathname: '/mobile/v1/chat/send', method: 'OPTIONS' });
});

console.log('DEV MEMORY CORS · scoped preflight, actual-write identity gate, production/mobile policy');
