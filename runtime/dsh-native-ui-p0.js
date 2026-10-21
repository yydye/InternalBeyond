'use strict';

// Development-only owner of the official DSH Web profile. Models and tools
// requested through this standalone Gateway always fail closed.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const devServiceContract = require('./dev-service-contract.js');
const workModeExecutor = require('../assets/js/work-mode-executor.js');

const REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const ROOT = path.resolve(__dirname, '..');

function syntheticRoot(sandboxRoot) {
  if (!sandboxRoot) throw new Error('DEV_SANDBOX_ROOT-required');
  const projectRoot = process.env.IB_DEV_PROJECT_ROOT || path.resolve(sandboxRoot, '..', '..', '..');
  devServiceContract.validateSandboxRoot(sandboxRoot, true, projectRoot);
  const root = path.resolve(sandboxRoot, 'dsh-native-ui-p0');
  for (let dir = root; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('synthetic-root-reparse-point');
  }
  return root;
}

function childEnvironment(source, root, inherited) {
  const sandboxRoot = path.resolve(root, '..');
  const projectRoot = inherited.IB_DEV_PROJECT_ROOT || path.resolve(sandboxRoot, '..', '..', '..');
  const env = {};
  // Inherit executable/OS support only, never Provider credentials, proxies,
  // NODE_OPTIONS, product tokens, or the user's DSH configuration.
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'ComSpec', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
    if (inherited[name]) env[name] = inherited[name];
  }
  return Object.assign(env, {
    IB_DEV_MODE: '1', IB_DEV_SYNTHETIC: '1', IB_DEV_PROJECT_ROOT: projectRoot,
    IB_DEV_SANDBOX_ROOT: sandboxRoot, IB_DSH_P0_SOURCE: source,
    IB_DSH_P0_WORKSPACE: path.join(root, 'workspace'),
    DSH_HOME: path.join(root, 'dsh-home'), DSH_AGENTS_HOME: path.join(root, 'agents'),
    DSH_BUNDLED_SKILL_DIR: path.join(root, 'skills'),
    USERPROFILE: path.join(root, 'user'), HOME: path.join(root, 'user'),
    APPDATA: path.join(root, 'user', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, 'user', 'AppData', 'Local'),
    TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
  });
}

function workModePreset(nativeId, modeId, order) {
  const mode = workModeExecutor.preset(modeId);
  if (!mode) throw new Error('work-mode-preset-unavailable: ' + modeId);
  const tools = mode.allowedTools.length ? mode.allowedTools.join(', ') : 'none';
  const readLimit = mode.maxProjectReadCalls > 0 ? ` Workspace 文件读取上限 ${mode.maxProjectReadCalls} 次。` : '';
  const boundary = modeId === 'coding'
    ? '写入须经本次 Home Node Consent；修改限于选中文件 ID，新建限于这些文件所在目录。'
    : modeId === 'app-builder'
      ? '文件变更仅作用于此项目的 Home Node App Draft。'
      : '此模式不写入 Workspace 文件。';
  return {
    id: 'preset-work-' + modeId,
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: nativeId,
      name: mode.label,
      description: `${mode.strategy} Home Node 可用工具：${tools}。${readLimit}${boundary} Shell 和网络不包含在此模式中。`,
      order,
      plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
        prefix: `You are using The Lost Beyond ${mode.label} mode. Use only the Home Node tools authorized for this Run. ${mode.strategy} Do not use Shell, network, or unlisted tools.`,
        complete: true,
        includeRuntimeContext: false,
      } }],
    },
  };
}

function overlay(source, root) {
  const disabled = [
    'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account',
    'session-log-deepseek', 'session-title-llm', 'otel', 'session-telemetry-otel',
    'desktop-product-telemetry', 'product-analytics',
    'account-controller', 'ui-settings-account', 'ui-settings-models', 'ui-settings-agent-loop',
    'ui-settings-shell', 'ui-settings-web-search', 'ui-settings-subagent', 'ui-settings-session-log',
    'directory-picker', 'open-in-app', 'ui-open-in-app', 'terminal-controller',
    'ui-sidebar-terminal', 'ui-sidebar-browser',
    'preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis',
  ];
  return disabled.map(id => ({ id, disabled: true })).concat([
    { id: 'tool-plugin-manager', disabled: false },
    { id: 'plugin-manager', disabled: false },
    { id: 'plugin-package-inventory-deepseek', disabled: false },
    { id: 'agent-default-model', config: { provider: 'ib-home-node-run-required', model: 'consent-bound-session-only' } },
    { id: 'agent-preset-registry', config: { default: 'synthetic-p0' } },
    { id: 'permission', config: { presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask', name: '本地工具 · 只读',
        description: '限制 DSH 本地 Host 工具。Coding 的 Workspace 写入仅由 Home Node 按本次 Run Consent 和选中文件范围授权。' },
    }, defaultPreset: 'read-only' } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: path.join(root, 'workspace') } },
    { id: 'workspace', name: path.join(ROOT, 'runtime', 'dsh-native-ui-p0', 'adapters', 'workspace.mjs') },
    { id: 'fs-sandbox', name: path.join(ROOT, 'runtime', 'dsh-native-ui-p0', 'adapters', 'filesystem.mjs'), config: { cwd: path.join(root, 'workspace') } },
    { id: 'workspace-controller', config: { documentsDirectory: path.join(root, 'workspace'), documentsLookupTimeoutMs: 1000 } },
    { id: 'session-controller', name: path.join(ROOT, 'runtime', 'dsh-native-ui-p0', 'adapters', 'session.mjs'), config: { nativeOpen: false, listWorkSliceMs: 16 } },
    { insert: [
      workModePreset('synthetic-p0', 'general', 1),
      workModePreset('coding', 'coding', 2),
      workModePreset('research', 'research', 3),
      workModePreset('app-builder', 'app-builder', 4),
      { id: 'ib-native-ui-p0', required: true, name: path.join(ROOT, 'runtime', 'dsh-native-ui-p0', 'host.mjs') },
      { id: 'ib-dsh-startup-screen', required: true, name: path.join(ROOT, 'runtime', 'dsh-startup-screen', 'host.mjs') },
    ] },
  ]);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

async function start() {
  const identity = devServiceContract.identityFromEnvironment(process.env);
  if (identity.mode !== 'synthetic') throw new Error('dsh-p0-synthetic-identity-required');
  const ports = devServiceContract.portsFromEnvironment(process.env);
  const controlPort = ports.dshControl;
  const webPort = ports.dshWeb;
  const devOrigin = identity.webOrigin;
  const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(ROOT, '..', 'DeepSeek-Harness-Mock-PoC'));
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  if (revision !== REVISION) throw new Error('dsh-source-pin-mismatch');
  execFileSync('git', ['diff', '--quiet', REVISION], { cwd: source });
  for (const relative of ['apps/web/dist/index.html', 'packages/api/gateway/lib/index.js', 'packages/client/ui-chat/lib/client.js']) {
    if (!fs.existsSync(path.join(source, relative))) throw new Error('dsh-web-build-required: ' + relative);
  }
  const root = syntheticRoot(process.env.IB_DEV_SANDBOX_ROOT);
  const env = childEnvironment(source, root, process.env);
  for (const dir of [root, env.IB_DSH_P0_WORKSPACE, env.DSH_HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(env.IB_DSH_P0_WORKSPACE, 'README.md'), '# Synthetic Work UI P0\nNo production project or Provider is connected.\n');
  const patch = path.join(root, 'web.patch.json');
  fs.writeFileSync(patch, JSON.stringify(overlay(source, root), null, 2));
  let launchUrl = null;
  let phase = 'starting';
  let child;
  let closing = false;
  const logFile = path.join(root, 'host.log');
  const control = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== devOrigin) { res.writeHead(403); res.end(); return; }
    if (req.method === 'OPTIONS' && origin === devOrigin) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': devOrigin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'X-IB-Dev-Session, X-IB-Dev-Instance', 'Access-Control-Max-Age': '600' });
      res.end(); return;
    }
    if (origin === devOrigin) {
      res.setHeader('Access-Control-Allow-Origin', devOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'X-IB-Dev-Session, X-IB-Dev-Instance');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (!devServiceContract.authorizeRequestIdentity(req, process.env, devOrigin)) {
      res.writeHead(403); res.end('{"ok":false,"error":"environment-identity-mismatch"}'); return;
    }
    if (req.method === 'GET' && req.url === '/status') {
      res.end(JSON.stringify({ ok: true, service: 'InternalBeyond DSH P0', pid: process.pid,
        environment: identity.mode, devInstanceId: identity.instanceId, synthetic: true, revision: REVISION, phase,
        // Only the existing synthetic Dev origin receives the bootstrap capability.
        launchUrl: origin === devOrigin ? launchUrl : undefined,
      })); return;
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      res.end(JSON.stringify({ ok: true, pid: process.pid, environment: identity.mode, devInstanceId: identity.instanceId })); void close(); return;
    }
    res.writeHead(404); res.end('{}');
  });
  async function close() {
    if (closing) return;
    closing = true; phase = 'stopped';
    if (child && child.exitCode === null) child.kill();
    control.close();
    control.closeAllConnections();
  }
  try {
    await listen(control, controlPort);
    child = spawn(process.execPath, [path.join(source, 'apps/cli/lib/bin.js'),
      '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(webPort), '--no-open'],
    { cwd: env.IB_DSH_P0_WORKSPACE, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    const receive = chunk => {
      buffer += String(chunk);
      const urls = buffer.match(new RegExp('http://127\\.0\\.0\\.1:' + webPort + '/[^\\s\\u001b]*', 'g')) || [];
      for (const raw of urls) {
        try { const url = new URL(raw); if (url.searchParams.has('token')) { launchUrl = url.href; phase = 'ready'; } } catch (_) {}
      }
      fs.appendFileSync(logFile, String(chunk).replace(/([?&]token=)[^\s\u001b]+/g, '$1[redacted]'));
      buffer = buffer.slice(-8000);
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.on('error', error => { phase = 'failed'; fs.appendFileSync(logFile, error.message); void close(); });
    child.on('exit', code => { phase = 'stopped'; console.log('DSH P0 host exited: ' + code); void close(); });
    process.once('SIGINT', close); process.once('SIGTERM', close);
    console.log('DSH Synthetic Work UI connected.');
  } catch (error) { await close(); throw error; }
}

if (require.main === module) {
  const action = process.argv[2] || 'start';
  if (action === 'stop') {
    try {
      const identity = devServiceContract.identityFromEnvironment(process.env);
      const ports = devServiceContract.portsFromEnvironment(process.env);
      fetch('http://127.0.0.1:' + ports.dshControl + '/shutdown', { method: 'POST', headers: devServiceContract.identityHeaders(identity) })
        .catch(error => { console.error(error.message); process.exitCode = 1; });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
  else if (action === 'start') start().catch(error => { console.error(error.message); process.exitCode = 1; });
  else { console.error('Usage: node runtime/dsh-native-ui-p0.js [start|stop]'); process.exitCode = 1; }
}
module.exports = { REVISION, syntheticRoot, childEnvironment, overlay };
