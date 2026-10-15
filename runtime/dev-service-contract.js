'use strict';

/* One contract for the unpackaged Dev service graph. Production defaults stay
 * with the existing services; a process marked Dev must receive every Dev port,
 * an exact Sandbox path, and a per-launch identity capability. */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEV_PORTS = Object.freeze({
  web: 23130,
  bridge: 23135,
  active: 23134,
  restart: 23136,
  homeNode: 23138,
  fakeProvider: 23139,
  activeChannelSource: 23137,
  dshControl: 23140,
  dshWeb: 23141
});
const PORT_ENV = Object.freeze({
  web: 'IB_WEB_PORT', bridge: 'IB_BRIDGE_PORT', active: 'IB_ACTIVE_PORT',
  restart: 'IB_RESTART_PORT', homeNode: 'IB_HOME_NODE_PORT',
  fakeProvider: 'IB_DEV_FAKE_PROVIDER_PORT', activeChannelSource: 'IB_ECONOMY_CHANNEL_SOURCE_PORT',
  dshControl: 'IB_DSH_CONTROL_PORT', dshWeb: 'IB_DSH_WEB_PORT'
});
const PRODUCTION_PORTS = Object.freeze({
  web: 23120, bridge: 23115, active: 23114, restart: 23116, homeNode: 23118
});
const DEV_SESSION_HEADER = 'x-ib-dev-session';
const DEV_INSTANCE_HEADER = 'x-ib-dev-instance';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/i;

function port(value) {
  const result = Number(value);
  return Number.isInteger(result) && result >= 1 && result <= 65535 ? result : 0;
}

function normalizedPath(value) { return path.resolve(String(value || '')).replace(/[\\/]+$/, '').toLowerCase(); }

function exactPath(value, expected) { return normalizedPath(value) === normalizedPath(expected); }

function validateSandboxRoot(root, synthetic) {
  root = path.resolve(String(root || ''));
  const segments = root.split(path.sep).filter(Boolean).map(value => value.toLowerCase());
  if (path.basename(root).toLowerCase() !== 'dev-sandbox'
    || segments[segments.length - (synthetic ? 3 : 2)] !== 'internalbeyond'
    || (synthetic && path.basename(path.dirname(root)).toLowerCase() !== 'dev-synthetic')) {
    throw new Error('dev-sandbox-identity-invalid');
  }
  try { if (fs.lstatSync(root).isSymbolicLink()) throw new Error('dev-sandbox-reparse-point-blocked'); }
  catch (error) { if (error && error.code !== 'ENOENT') throw error; }
  return root;
}

function identityFromEnvironment(env) {
  env = env || process.env;
  if (String(env.IB_DEV_MODE || '') !== '1') return Object.freeze({ mode: 'production' });
  const synthetic = String(env.IB_DEV_SYNTHETIC || '') === '1';
  const sandboxRoot = validateSandboxRoot(env.IB_DEV_SANDBOX_ROOT, synthetic);
  const instanceId = String(env.IB_DEV_INSTANCE_ID || '').toLowerCase();
  const sessionToken = String(env.IB_DEV_SESSION_TOKEN || '').toLowerCase();
  if (!ID_RE.test(instanceId) || !TOKEN_RE.test(sessionToken)) throw new Error('dev-service-identity-required');
  const webPort = port(env[PORT_ENV.web]);
  if (!webPort) throw new Error('dev-service-port-required:' + PORT_ENV.web);
  const expectedDirs = {
    IB_ACTIVE_DATA_DIR: path.join(sandboxRoot, 'active'),
    IB_BRIDGE_DATA_DIR: path.join(sandboxRoot, 'bridge'),
    IB_HOME_NODE_DATA_DIR: path.join(sandboxRoot, 'home-node'),
    IB_CREDENTIAL_DATA_DIR: path.join(sandboxRoot, 'credential-vault'),
    IB_CREDENTIAL_BINDINGS_DIR: path.join(sandboxRoot, 'credential-vault')
  };
  for (const [key, expected] of Object.entries(expectedDirs)) {
    if (!env[key] || !exactPath(env[key], expected)) throw new Error('dev-data-directory-identity-invalid:' + key);
  }
  return Object.freeze({ mode: synthetic ? 'synthetic' : 'dev', synthetic,
    instanceId, sessionToken, sandboxRoot, webOrigin: 'http://127.0.0.1:' + String(webPort) });
}

function portsFromEnvironment(env) {
  env = env || process.env;
  const identity = identityFromEnvironment(env);
  const ports = Object.create(null);
  if (identity.mode === 'production') {
    for (const name of Object.keys(PRODUCTION_PORTS)) {
      const configured = port(env[PORT_ENV[name]]);
      ports[name] = configured || PRODUCTION_PORTS[name];
    }
    return Object.freeze(ports);
  }
  for (const [name, envName] of Object.entries(PORT_ENV)) {
    ports[name] = port(env[envName]);
    if (!ports[name]) throw new Error('dev-service-port-required:' + envName);
  }
  const values = Object.values(ports);
  if (new Set(values).size !== values.length) throw new Error('dev-service-port-conflict');
  const reservedPorts = new Set(Object.values(PRODUCTION_PORTS));
  for (const [name, value] of Object.entries(ports)) {
    if (reservedPorts.has(value)) throw new Error('dev-service-port-overlaps-production:' + name);
  }
  return Object.freeze(ports);
}

function servicePort(name, env, productionDefault) {
  env = env || process.env;
  const envName = PORT_ENV[name];
  if (!envName) throw new Error('unknown-service-port:' + String(name));
  const configured = port(env[envName]);
  if (String(env.IB_DEV_MODE || '') === '1') {
    if (!configured) throw new Error('dev-service-port-required:' + envName);
    return configured;
  }
  return configured || productionDefault || PRODUCTION_PORTS[name] || 0;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8'), b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function header(request, name) {
  const headers = request && request.headers || {};
  return String(headers[name] || headers[name.toLowerCase()] || '');
}

function hasDevIdentityHeaders(request) {
  return !!(header(request, DEV_SESSION_HEADER) || header(request, DEV_INSTANCE_HEADER));
}

function isKnownDevOrigin(origin) {
  try {
    const parsed = new URL(String(origin || '').trim());
    const host = String(parsed.hostname || '').toLowerCase();
    const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    const effectivePort = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && isLocal && new Set(Object.values(DEV_PORTS)).has(effectivePort);
  } catch (_) { return false; }
}

function authorizeRequestIdentity(request, env, expectedOrigin) {
  env = env || process.env;
  const origin = String(header(request, 'origin') || '').trim();
  if (String(env.IB_DEV_MODE || '') === '1') {
    let identity;
    try { identity = identityFromEnvironment(env); } catch (_) { return false; }
    return safeEqual(header(request, DEV_SESSION_HEADER), identity.sessionToken)
      && safeEqual(header(request, DEV_INSTANCE_HEADER), identity.instanceId)
      && (!origin || origin === (expectedOrigin || identity.webOrigin));
  }
  return !hasDevIdentityHeaders(request) && !isKnownDevOrigin(origin);
}

function browserIdentity(identity, ports) {
  if (!identity || (identity.mode !== 'dev' && identity.mode !== 'synthetic') || !ports) return null;
  return Object.freeze({
    mode: identity.mode,
    instanceId: identity.instanceId,
    sessionToken: identity.sessionToken,
    webOrigin: identity.webOrigin,
    activeUrl: 'http://127.0.0.1:' + ports.active,
    restartUrl: 'http://127.0.0.1:' + ports.restart,
    homeNodeUrl: 'http://127.0.0.1:' + ports.homeNode,
    bridgeUrl: 'http://127.0.0.1:' + ports.bridge,
    dshControlUrl: 'http://127.0.0.1:' + ports.dshControl,
    dshWebOrigin: 'http://127.0.0.1:' + ports.dshWeb,
    fakeProviderUrl: 'http://127.0.0.1:' + ports.fakeProvider + '/v1/chat/completions'
  });
}

function identityHeaders(identity) {
  if (!identity || (identity.mode !== 'dev' && identity.mode !== 'synthetic')) return Object.freeze({});
  return Object.freeze({
    'X-IB-Dev-Session': identity.sessionToken,
    'X-IB-Dev-Instance': identity.instanceId
  });
}

module.exports = Object.freeze({
  DEV_PORTS, PORT_ENV, PRODUCTION_PORTS, DEV_SESSION_HEADER, DEV_INSTANCE_HEADER,
  identityFromEnvironment, portsFromEnvironment, servicePort, authorizeRequestIdentity,
  hasDevIdentityHeaders, isKnownDevOrigin, browserIdentity, identityHeaders, validateSandboxRoot
});
