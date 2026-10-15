'use strict';

/* Production DSH Work Mode web surface. This process is a UI/session host only:
   actual model and Workspace calls are bound to Home Node ACP Runs. */
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawn: nodeSpawn } = require('node:child_process');
const workModeExecutor = require('../../assets/js/work-mode-executor.js');

const DSH_REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const PRESETS = [
  ['general', 1], ['coding', 2], ['research', 3], ['app-builder', 4]
];
const DISABLED_PLUGINS = [
  'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account',
  'experimental-inspector',
  'session-log-deepseek', 'session-title-llm', 'otel', 'session-telemetry-otel',
  'desktop-product-telemetry', 'product-analytics', 'account-controller', 'ui-settings-account',
  'ui-settings-models', 'ui-settings-agent-loop', 'ui-settings-shell', 'ui-settings-web-search',
  'ui-settings-subagent', 'ui-settings-session-log', 'ui-settings-plugins', 'ui-plugin-manager',
  'tool-plugin-manager', 'plugin-manager', 'plugin-package-inventory-deepseek',
  'directory-picker', 'open-in-app', 'ui-open-in-app', 'terminal-controller',
  'ui-sidebar-terminal', 'ui-sidebar-browser', 'ui-sidebar-files', 'workspace-files',
  'tool-working-directory', 'tool-bash', 'tool-bash-persistent',
  'tool-pwsh', 'tool-pwsh-persistent', 'tool-fs', 'tool-fs-search', 'tool-web',
  'web-search-deepseek', 'web-fetch-http', 'web', 'subagent', 'subagent-spawn-in-process',
  'subagent-fork-in-process', 'tool-subagent', 'tool-subagent-control', 'tool-subagent-list-agents',
  'tool-subagent-fork', 'ptc-runtime', 'workflow-ptc', 'tool-workflow', 'mcp-resources',
  'jobs', 'job-controller', 'schedule', 'tool-schedule', 'ui-schedule', 'ui-jobs',
  'session-persistence-sqlite',
  'preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'
];

function workModePreset(modeId, order) {
  const mode = workModeExecutor.preset(modeId);
  if (!mode) throw new Error('work-mode-preset-unavailable:' + modeId);
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
      id: modeId,
      name: mode.label,
      description: `${mode.strategy} Home Node 可用工具：${tools}。${readLimit}${boundary} Shell 和网络不包含在此模式中。`,
      order,
      plugins: [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
        prefix: `You are using The Lost Beyond ${mode.label} mode. Use only the Home Node tools authorized for this Run. ${mode.strategy} Do not use Shell, network, or unlisted tools.`,
        complete: true,
        includeRuntimeContext: false
      } }]
    }
  };
}

function productionPatch(options) {
  const hostPackage = path.resolve(options.workUiPackageRoot);
  const startupPackage = path.resolve(options.startupScreenRoot);
  return DISABLED_PLUGINS.map(id => ({ id, disabled: true })).concat([
    /* DSH Connection needs credentials only to persist its browser-session
       signing key. Keep that key in a dedicated file; provider adapters and
       their settings remain disabled and provider environment variables are
       never passed to this UI process. */
    { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local', disabled: false,
      config: { path: options.browserAuthCredentialPath, watch: false } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'agent-default-model', config: { provider: 'ib-home-node-run-required', model: 'consent-bound-session-only' } },
    { id: 'agent-preset-registry', config: { default: 'general' } },
    { id: 'permission', config: { presets: {
      'read-only': { sandbox: 'read-only', approval: 'ask', name: '本地工具 · 只读',
        description: 'DSH 本地 Host 工具保持只读；项目工具由 Home Node 按本次 Run Consent 与选中文件范围执行。' }
    }, defaultPreset: 'read-only' } },
    /* Native Web UI needs the Workspace registry for session navigation.
       Its default stays under the private DSH scratch root; project access
       remains owned by Home Node Runs and their Consent snapshots. */
    { id: 'workspace-controller', config: { documentsDirectory: options.workspaceRoot } },
    { id: 'session-controller', name: path.join(hostPackage, 'session.mjs'),
      config: { nativeOpen: false, listWorkSliceMs: 16 } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: options.workspaceRoot } },
    { id: 'ui-settings-appearance', disabled: true },
    { insert: [
      ...PRESETS.map(([id, order]) => workModePreset(id, order)),
      { id: 'ib-native-work-ui-production', required: true, name: path.join(hostPackage, 'host.mjs') },
      { id: 'ib-dsh-startup-screen', required: true, name: path.join(startupPackage, 'host.mjs') }
    ] }
  ]);
}

function createDshWebHost(options) {
  options = options || {};
  const enabled = options.enabled === true;
  const spawn = options.spawn || nodeSpawn;
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const nodeExe = String(options.nodeExe || '');
  const tsxLoader = String(options.tsxLoader || '');
  const binScript = String(options.binScript || '');
  const runtimeRoot = path.resolve(String(options.runtimeRoot || ''));
  const dataRoot = path.resolve(String(options.dataRoot || ''));
  const workspaceRoot = path.join(dataRoot, 'workspace');
  const profileRoot = path.join(dataRoot, 'dsh-home');
  const browserAuthCredentialPath = path.join(profileRoot, 'work-mode-web-credentials.yaml');
  const patchRoot = path.join(dataRoot, 'runtime-cache');
  const userRoot = path.join(dataRoot, 'user');
  const tempRoot = path.join(dataRoot, 'temp');
  const agentsRoot = path.join(dataRoot, 'agents');
  const roamingRoot = path.join(userRoot, 'AppData', 'Roaming');
  const profilePatch = path.join(patchRoot, 'work-mode-production.patch.json');
  const hostPackage = path.resolve(String(options.workUiPackageRoot || ''));
  const startupScreenRoot = path.resolve(String(options.startupScreenRoot || ''));
  const runtimeInstalled = typeof options.runtimeInstalled === 'function' ? options.runtimeInstalled : () => true;
  const runtimeInstallationStatus = typeof options.runtimeInstallationStatus === 'function'
    ? options.runtimeInstallationStatus : () => ({ phase: 'idle' });
  let phase = enabled ? 'stopped' : 'disabled';
  let child = null;
  let launchUrl = '';
  let webOrigin = '';
  let failureCode = '';
  let outputBuffer = '';
  let startPromise = null;
  let shuttingDown = false;

  function assertNoReparsePoints(anchor, target) {
    const relative = path.relative(path.resolve(anchor), path.resolve(target));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('dsh-data-root-outside-local-app-data');
    }
    const paths = [path.resolve(anchor)];
    let current = path.resolve(anchor);
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      paths.push(current);
    }
    for (const candidate of paths) {
      try { if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('dsh-data-reparse-point-denied'); }
      catch (error) { if (error && error.code !== 'ENOENT') throw error; }
    }
  }

  function ensurePrivateRoot() {
    const localAppData = process.env.LOCALAPPDATA || '';
    const expected = path.resolve(localAppData, 'InternalBeyond', 'dsh-work-mode');
    if (!localAppData || dataRoot.toLowerCase() !== expected.toLowerCase()) throw new Error('dsh-data-root-invalid');
    assertNoReparsePoints(localAppData, dataRoot);
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(profileRoot, { recursive: true });
    fs.mkdirSync(patchRoot, { recursive: true });
    fs.mkdirSync(userRoot, { recursive: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.mkdirSync(agentsRoot, { recursive: true });
    fs.mkdirSync(roamingRoot, { recursive: true });
    assertNoReparsePoints(localAppData, dataRoot);
    assertNoReparsePoints(dataRoot, workspaceRoot);
    assertNoReparsePoints(dataRoot, profileRoot);
    assertNoReparsePoints(dataRoot, patchRoot);
    assertNoReparsePoints(dataRoot, userRoot);
    assertNoReparsePoints(dataRoot, tempRoot);
    assertNoReparsePoints(dataRoot, agentsRoot);
    assertNoReparsePoints(dataRoot, roamingRoot);
    let loaderPath = String(tsxLoader || '');
    try {
      const loaderUrl = new URL(loaderPath);
      if (loaderUrl.protocol === 'file:') loaderPath = fileURLToPath(loaderUrl);
    } catch (_) { /* an absolute filesystem path is also accepted */ }
    const missing = [];
    if (!fs.existsSync(nodeExe)) missing.push('node');
    if (!fs.existsSync(loaderPath)) missing.push('tsx-loader');
    if (!fs.existsSync(binScript)) missing.push('dsh-entry');
    if (!fs.existsSync(path.join(hostPackage, 'host.mjs'))) missing.push('work-ui-host');
    if (!fs.existsSync(path.join(startupScreenRoot, 'host.mjs'))) missing.push('startup-screen-host');
    if (missing.length) throw new Error('dsh-web-runtime-incomplete:' + missing.join(','));
    const patch = productionPatch({ runtimeRoot, workspaceRoot, workUiPackageRoot: hostPackage,
      startupScreenRoot, browserAuthCredentialPath });
    fs.writeFileSync(profilePatch, JSON.stringify(patch, null, 2));
  }

  function childEnvironment() {
    const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const env = {};
    for (const name of ['PATH', 'Path', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    env.SystemRoot = root;
    env.WINDIR = root;
    env.ComSpec = process.env.ComSpec || path.join(root, 'System32', 'cmd.exe');
    env.LOCALAPPDATA = process.env.LOCALAPPDATA || '';
    env.APPDATA = roamingRoot;
    env.USERPROFILE = userRoot;
    env.HOME = env.USERPROFILE;
    env.TEMP = tempRoot;
    env.TMP = env.TEMP;
    env.DSH_HOME = profileRoot;
    env.DSH_AGENTS_HOME = agentsRoot;
    env.DSH_TELEMETRY_DISABLED = '1';
    env.TSX_TSCONFIG_PATH = path.join(runtimeRoot, 'tsconfig.json');
    env.IB_DSH_NATIVE_MODE = 'production';
    env.IB_DSH_EMBEDDED_TAURI = '1';
    env.IB_DSH_RUNTIME_ROOT = runtimeRoot;
    env.IB_DSH_WORKSPACE_ROOT = workspaceRoot;
    env.IB_TAURI_HOST_INSTANCE_ID = String(process.env.IB_TAURI_HOST_INSTANCE_ID || '');
    return env;
  }

  function recordOutput(chunk) {
    const text = String(chunk);
    outputBuffer = (outputBuffer + text).slice(-8192);
    const urls = outputBuffer.match(/https?:\/\/127\.0\.0\.1:\d+\/[^\s\u001b]*/g) || [];
    for (const rawValue of urls) {
      const raw = rawValue.replace(/[)\],;]+$/, '');
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/' || !parsed.searchParams.has('token')) continue;
        launchUrl = parsed.href;
        webOrigin = parsed.origin;
        phase = 'ready';
        failureCode = '';
      } catch (_) { /* ignore non-URL console text */ }
    }
    const safe = text.replace(/([?&]token=)[^\s\u001b]+/g, '$1[redacted]').slice(0, 500);
    if (safe.trim()) logger('info', 'dsh-web-ui-output', { line: safe });
  }

  function status() {
    let installed = false;
    let installation = { phase: 'idle' };
    try { installed = runtimeInstalled() === true; } catch (_) {}
    try { installation = runtimeInstallationStatus() || installation; } catch (_) {}
    return { enabled: enabled && installed, configured: enabled, installed: installed, runtimeInstalled: installed,
      runtimeInstallation: installation, mode: enabled ? 'production' : 'disabled', synthetic: false,
      revision: DSH_REVISION, phase: enabled && !installed ? 'uninstalled' : phase,
      ready: installed && phase === 'ready', ...(failureCode ? { error: failureCode } : {}) };
  }

  function bootstrap(parentOrigin) {
    if (phase !== 'ready' || !launchUrl || !webOrigin) return null;
    const parent = String(parentOrigin || '');
    if (parent !== 'http://tauri.localhost' && parent !== 'tauri://localhost') return null;
    const url = new URL(launchUrl);
    url.searchParams.set('ib_parent_origin', parent);
    return { mode: 'production', synthetic: false, ready: true, revision: DSH_REVISION,
      origin: webOrigin, launchUrl: url.href };
  }

  async function stopChild() {
    const current = child;
    child = null;
    if (!current || current.exitCode !== null) return;
    try { current.kill('SIGTERM'); } catch (_) { return; }
    await Promise.race([
      new Promise(resolve => current.once('close', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
    if (current.exitCode === null) { try { current.kill('SIGKILL'); } catch (_) {} }
    await Promise.race([new Promise(resolve => current.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
  }

  async function launch() {
    try {
      ensurePrivateRoot();
      phase = 'starting';
      failureCode = '';
      const args = ['--import', tsxLoader, binScript, '--profile', 'web', '--patch', profilePatch,
        '--host', '127.0.0.1', '--port', '0', '--no-open'];
      child = spawn(nodeExe, args, { cwd: workspaceRoot, env: childEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const current = child;
      current.stdout.on('data', recordOutput);
      current.stderr.on('data', recordOutput);
      current.once('error', error => {
        if (child !== current || shuttingDown) return;
        phase = 'failed'; failureCode = String(error && error.code || 'dsh-web-spawn-failed').slice(0, 80);
        logger('error', 'dsh-web-ui-spawn-failed', { code: failureCode });
      });
      current.once('close', (code, signal) => {
        if (child !== current || shuttingDown) return;
        child = null; launchUrl = ''; webOrigin = '';
        phase = 'failed'; failureCode = 'dsh-web-exited-' + String(code == null ? 'unknown' : code);
        logger('error', 'dsh-web-ui-exited', { code: code == null ? 'unknown' : code, signal: String(signal || '') });
      });
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline && !shuttingDown) {
        if (phase === 'ready' && launchUrl) {
          const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(3000) }).catch(() => null);
          if (response && response.status >= 200 && response.status < 400) return { ok: true, ui: bootstrap() };
          launchUrl = ''; webOrigin = ''; phase = 'starting';
        }
        if (phase === 'failed' || !child || child.exitCode !== null) throw new Error(failureCode || 'dsh-web-start-failed');
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      throw new Error(shuttingDown ? 'dsh-web-shutdown' : 'dsh-web-start-timeout');
    } catch (error) {
      failureCode = String(error && error.message || 'dsh-web-start-failed').slice(0, 80);
      phase = 'failed';
      launchUrl = ''; webOrigin = '';
      logger('error', 'dsh-web-ui-start-failed', { code: failureCode });
      await stopChild();
      return { ok: false, error: failureCode };
    }
  }

  function start() {
    if (!enabled) return Promise.resolve({ ok: false, error: 'dsh-web-disabled' });
    if (shuttingDown) return Promise.resolve({ ok: false, error: 'dsh-web-shutting-down' });
    let installed = false;
    try { installed = runtimeInstalled() === true; } catch (_) {}
    if (!installed) { phase = 'uninstalled'; failureCode = ''; return Promise.resolve({ ok: false, error: 'dsh-runtime-not-installed' }); }
    if (phase === 'uninstalled') phase = 'stopped';
    if (phase === 'ready') return Promise.resolve({ ok: true, ui: bootstrap() });
    if (startPromise) return startPromise;
    startPromise = launch().finally(() => { startPromise = null; });
    return startPromise;
  }

  async function close() {
    shuttingDown = true;
    phase = 'stopping';
    await stopChild();
    launchUrl = ''; webOrigin = '';
    phase = 'stopped';
  }

  async function pauseForRuntimeUpgrade() {
    if (shuttingDown) return { ok: false, error: 'dsh-web-shutting-down' };
    phase = 'stopping';
    await stopChild();
    launchUrl = ''; webOrigin = '';
    phase = runtimeInstalled() ? 'stopped' : 'uninstalled';
    failureCode = '';
    return { ok: true };
  }

  return Object.freeze({ start, close, pauseForRuntimeUpgrade, describe: status, bootstrap });
}

module.exports = createDshWebHost;
module.exports.createDshWebHost = createDshWebHost;
module.exports.productionPatch = productionPatch;
