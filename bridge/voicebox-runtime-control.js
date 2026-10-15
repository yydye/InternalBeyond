'use strict';

/* Narrow process control for the separately installed Voicebox desktop app.
 * The synthesizer remains owned by Voicebox; this module only locates/starts
 * the official app executable and requests its documented loopback shutdown. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

function createVoiceboxRuntimeControl(deps) {
  const d = deps || {};
  const config = d.config || {};
  const voicebox = d.voicebox || null;
  const persistConfig = typeof d.persistConfig === 'function' ? d.persistConfig : function () {};
  const platform = d.platform || process.platform;
  const env = d.env || process.env;
  const fsApi = d.fs || fs;
  const spawn = typeof d.spawn === 'function' ? d.spawn : childProcess.spawn;
  let child = null;
  let childExit = null;
  let startError = null;
  let lastHealthyAt = 0;
  let stopping = null;

  function section() {
    if (!config.voicebox || typeof config.voicebox !== 'object' || Array.isArray(config.voicebox)) config.voicebox = {};
    return config.voicebox;
  }

  function pathApi() { return platform === 'win32' ? path.win32 : path; }

  function normalizedPath(value) {
    let text = String(value == null ? '' : value).trim();
    if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') text = text.slice(1, -1).trim();
    if (!text) return { ok: true, path: '' };
    if (text.length > 2048 || /[\u0000-\u001f\u007f]/.test(text)) return { ok: false, error: 'path-invalid' };
    const api = pathApi();
    if (!api.isAbsolute(text)) return { ok: false, error: 'path-must-be-absolute' };
    if (platform === 'win32' && /^\\\\/.test(text)) return { ok: false, error: 'network-path-not-supported' };
    const ext = platform === 'win32' ? api.basename(text).toLowerCase() : api.basename(text);
    if (platform === 'win32' && ext !== 'voicebox.exe') return { ok: false, error: 'select-voicebox-exe' };
    if (platform === 'darwin' && !/\.app$/i.test(text)) return { ok: false, error: 'select-voicebox-app' };
    if (platform === 'linux' && !/^voicebox(?:[-.]|$)/i.test(ext)) return { ok: false, error: 'select-voicebox-program' };
    return { ok: true, path: api.normalize(text) };
  }

  function targetExists(target) {
    if (!target) return false;
    try {
      const stat = fsApi.statSync(target);
      if (platform === 'darwin') return stat.isDirectory();
      if (!stat.isFile()) return false;
      if (platform === 'linux') return (Number(stat.mode) & 0o111) !== 0;
      return true;
    } catch (_) { return false; }
  }

  function defaultCandidates() {
    if (platform === 'win32') {
      const rows = [];
      if (env.ProgramFiles) rows.push(path.win32.join(env.ProgramFiles, 'Voicebox', 'voicebox.exe'));
      if (env['ProgramFiles(x86)']) rows.push(path.win32.join(env['ProgramFiles(x86)'], 'Voicebox', 'voicebox.exe'));
      if (env.LOCALAPPDATA) rows.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Voicebox', 'voicebox.exe'));
      return rows;
    }
    if (platform === 'darwin') return ['/Applications/Voicebox.app', path.join(os.homedir(), 'Applications', 'Voicebox.app')];
    if (platform === 'linux') return ['/opt/voicebox/voicebox.AppImage', '/usr/bin/voicebox', path.join(os.homedir(), 'Applications', 'voicebox.AppImage')];
    return [];
  }

  function resolveProgram() {
    const saved = String(section().executablePath || '').trim();
    if (saved) {
      const normalized = normalizedPath(saved);
      if (!normalized.ok) return { path: saved, exists: false, source: 'configured', pathError: normalized.error };
      return { path: normalized.path, exists: targetExists(normalized.path), source: 'configured', pathError: '' };
    }
    const found = defaultCandidates().find(targetExists) || '';
    return { path: found, exists: !!found, source: found ? 'auto-detected' : 'none', pathError: '' };
  }

  function localEndpoint() {
    try {
      const value = new URL(String(voicebox && typeof voicebox.endpoint === 'function' ? voicebox.endpoint() : ''));
      return value.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value.hostname.toLowerCase());
    } catch (_) { return false; }
  }

  function healthyVoicebox(health) {
    return !!(health && health.ok === true && typeof health.status === 'string' && health.status.trim());
  }

  function connectionRefused(result) {
    const message = String(result && (result.error || result.message) || '').toLowerCase();
    return /econnrefused|connection refused|fetch failed|failed to fetch|networkerror|econnreset|timeout|aborterror/.test(message);
  }

  function childAlive() { return !!(child && child.exitCode == null && child.signalCode == null); }

  async function status() {
    const program = resolveProgram();
    const local = localEndpoint();
    let health = null;
    try { health = voicebox && typeof voicebox.health === 'function' ? await voicebox.health() : null; }
    catch (error) { health = { ok: false, error: String(error && error.message || error) }; }
    const healthStatus = Number(health && health.status) || 0;
    const healthError = String(health && health.error || '');
    const refused = connectionRefused(health);

    if (healthyVoicebox(health)) {
      lastHealthyAt = Date.now();
      return {
        ok: true, state: local ? 'running' : 'remote-running', installed: program.exists,
        configured: !!String(section().executablePath || ''), executablePath: program.path || '',
        pathSource: program.source, processOwned: childAlive(), pid: childAlive() ? Number(child.pid) || null : null,
        endpointLocal: local, runtimeStatus: health.status, modelLoaded: !!health.modelLoaded,
        gpuAvailable: !!health.gpuAvailable, gpuType: String(health.gpuType || ''), errorCode: '',
        message: local ? (childAlive() ? 'Voicebox 服务可用，由 IB 启动。' : 'Voicebox 服务可用。') : '当前 Voicebox endpoint 为远端；IB 不会启动或停止远端程序。'
      };
    }

    if (local && health && ((healthStatus === 404) || (health.ok === true && !String(health.status || '').trim()))) {
      return {
        ok: true, state: 'endpoint-conflict', installed: program.exists,
        configured: !!String(section().executablePath || ''), executablePath: program.path || '',
        pathSource: program.source, processOwned: childAlive(), pid: childAlive() ? Number(child.pid) || null : null,
        endpointLocal: true, runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '', errorCode: 'endpoint-identity-mismatch',
        message: '本地端口有响应，但无法确认是 Voicebox；为避免重复启动，已停止自动启动。'
      };
    }
    if (local && !refused && (healthStatus >= 400 || (health && health.ok === false && healthError))) {
      return {
        ok: true, state: 'endpoint-error', installed: program.exists,
        configured: !!String(section().executablePath || ''), executablePath: program.path || '',
        pathSource: program.source, processOwned: childAlive(), pid: childAlive() ? Number(child.pid) || null : null,
        endpointLocal: true, runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '', errorCode: 'health-check-failed',
        message: '本地 Voicebox 服务返回异常；IB 保留现状，没有重复启动或结束其他进程。'
      };
    }

    if (!local) {
      return {
        ok: true, state: 'remote-unavailable', installed: program.exists,
        configured: !!String(section().executablePath || ''), executablePath: program.path || '',
        pathSource: program.source, processOwned: childAlive(), pid: childAlive() ? Number(child.pid) || null : null,
        endpointLocal: false, runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '',
        errorCode: 'remote-endpoint', message: 'Voicebox endpoint 不是本机地址；本地启停控制已停用。'
      };
    }

    if (childAlive()) {
      const disconnected = lastHealthyAt > 0 && !stopping;
      return {
        ok: true, state: stopping ? 'stopping' : disconnected ? 'start-failed' : 'starting', installed: program.exists,
        configured: !!String(section().executablePath || ''), executablePath: program.path || '',
        pathSource: program.source, processOwned: true, pid: Number(child.pid) || null,
        endpointLocal: true, runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '',
        errorCode: disconnected ? 'runtime-disconnected' : '', message: stopping ? '正在停止 Voicebox…'
          : disconnected ? 'Voicebox 程序仍开着，但服务连接中断；先停止再重新启动。' : '程序已启动，等待本地 Voicebox 服务就绪。'
      };
    }

    if (startError) {
      return {
        ok: true, state: 'start-failed', installed: program.exists,
        configured: !!String(section().executablePath || ''), executablePath: program.path || '',
        pathSource: program.source, processOwned: false, pid: null, endpointLocal: true,
        runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '',
        errorCode: String(startError.code || 'process-start-failed'), message: startError.message
      };
    }

    if (program.pathError) {
      return {
        ok: true, state: 'not-configured', installed: false,
        configured: !!String(section().executablePath || ''), executablePath: program.path,
        pathSource: program.source, processOwned: false, pid: null, endpointLocal: true,
        runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '', errorCode: program.pathError,
        message: 'Voicebox 程序路径格式无效，请重新定位 Voicebox 程序。'
      };
    }

    if (program.path && !program.exists) {
      return {
        ok: true, state: 'not-installed', installed: false,
        configured: !!String(section().executablePath || ''), executablePath: program.path,
        pathSource: program.source, processOwned: false, pid: null, endpointLocal: true,
        runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '', errorCode: 'program-not-found',
        message: '配置的 Voicebox 程序不存在；请检查路径或重新安装。'
      };
    }

    if (program.exists) {
      return {
        ok: true, state: 'installed-stopped', installed: true,
        configured: !!String(section().executablePath || ''), executablePath: program.path,
        pathSource: program.source, processOwned: false, pid: null, endpointLocal: true,
        runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '', errorCode: '',
        message: connectionRefused(health) ? 'Voicebox 已安装但尚未启动。' : 'Voicebox 已定位；等待本地服务连接。'
      };
    }

    return {
      ok: true, state: 'not-configured', installed: false, configured: false,
      executablePath: '', pathSource: 'none', processOwned: false, pid: null, endpointLocal: true,
      runtimeStatus: '', modelLoaded: false, gpuAvailable: false, gpuType: '', errorCode: 'program-not-located',
      message: '尚未定位 Voicebox；如已安装，请填写 Voicebox.exe 路径，否则可从官方发布页安装。'
    };
  }

  function configurePath(value) {
    const normalized = normalizedPath(value);
    if (!normalized.ok) return { ok: false, status: 400, error: normalized.error };
    section().executablePath = normalized.path;
    try { persistConfig(); } catch (_) { return { ok: false, status: 500, error: 'voicebox-path-save-failed' }; }
    startError = null;
    return { ok: true, executablePath: normalized.path, pathSource: normalized.path ? 'configured' : 'none' };
  }

  function launchSpec(target) {
    if (platform === 'darwin' && /\.app$/i.test(target)) return { command: 'open', args: ['-a', target] };
    return { command: target, args: [] };
  }

  async function start() {
    const current = await status();
    if (current.state === 'running') return Object.assign({}, current, { alreadyRunning: true });
    if (current.state === 'remote-running' || current.state === 'remote-unavailable') return Object.assign({}, current, { ok: false });
    if (current.state === 'endpoint-conflict' || current.state === 'endpoint-error') return Object.assign({}, current, { ok: false });
    if (current.state === 'starting' || current.state === 'stopping') return Object.assign({}, current, { alreadyRunning: true });
    if (childAlive()) return Object.assign({}, current, { ok: false, errorCode: 'process-still-running', message: 'Voicebox 程序仍在运行；请先停止它，再重新启动。' });
    if (current.state === 'start-failed') startError = null;
    const program = resolveProgram();
    if (!program.path || program.pathError) return Object.assign({}, current, { ok: false, state: 'not-configured' });
    if (!program.exists) return Object.assign({}, current, { ok: false, state: 'not-installed' });
    if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
      return Object.assign({}, current, { ok: false, state: 'start-failed', errorCode: 'platform-unsupported', message: '当前平台暂不支持从 IB 启动 Voicebox。' });
    }
    if (program.source === 'auto-detected' && !section().executablePath) {
      section().executablePath = program.path;
      try { persistConfig(); } catch (_) { return Object.assign({}, current, { ok: false, state: 'start-failed', errorCode: 'voicebox-path-save-failed', message: '无法保存 Voicebox 路径。' }); }
    }
    const spec = launchSpec(program.path);
    try {
      childExit = null;
      startError = null;
      lastHealthyAt = 0;
      const spawnedChild = spawn(spec.command, spec.args, {
        cwd: platform === 'darwin' && /\.app$/i.test(program.path) ? path.dirname(program.path) : pathApi().dirname(program.path),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        shell: false
      });
      child = spawnedChild;
      spawnedChild.once('error', function (error) {
        startError = { code: String(error && error.code || 'process-start-failed'), message: '无法启动 Voicebox 程序 (' + String(error && error.code || 'process-start-failed') + ')。' };
        childExit = { code: null, signal: null, at: Date.now() };
        if (child === spawnedChild) child = null;
      });
      spawnedChild.once('exit', function (code, signal) {
        childExit = { code: code == null ? null : Number(code), signal: signal ? String(signal) : '', at: Date.now() };
        if (code != null && Number(code) !== 0) startError = { code: 'process-exited', message: 'Voicebox 程序异常退出 (code ' + String(code) + ')。' };
        if (child === spawnedChild) child = null;
      });
      if (spawnedChild && typeof spawnedChild.unref === 'function') spawnedChild.unref();
      return Object.assign({}, current, { ok: true, state: 'starting', installed: true, configured: true, executablePath: program.path, pathSource: 'configured', processOwned: true, pid: Number(spawnedChild && spawnedChild.pid) || null, errorCode: '', message: 'Voicebox 已启动，等待本地服务就绪。' });
    } catch (error) {
      child = null;
      startError = { code: String(error && error.code || 'process-start-failed'), message: '无法启动 Voicebox 程序 (' + String(error && error.code || 'process-start-failed') + ')。' };
      return Object.assign({}, current, { ok: false, state: 'start-failed', installed: true, configured: true, executablePath: program.path, processOwned: false, pid: null, errorCode: startError.code, message: startError.message });
    }
  }

  async function waitForChildExit(childRef, timeoutMs) {
    if (!childRef || childRef.exitCode != null || childRef.signalCode != null) return true;
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); childRef.removeListener('exit', onExit); resolve(value); };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      childRef.once('exit', onExit);
    });
  }

  async function waitForRuntimeStop(timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      let health = null;
      try { health = voicebox && typeof voicebox.health === 'function' ? await voicebox.health() : null; } catch (_) { health = null; }
      if (!healthyVoicebox(health)) return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }

  async function stopInternal() {
    const current = await status();
    if (current.state === 'remote-running' || current.state === 'remote-unavailable') return Object.assign({}, current, { ok: false });
    if (current.state !== 'running' && !childAlive()) {
      return Object.assign({}, current, { ok: true, alreadyStopped: true });
    }

    let shutdown = { ok: false, error: 'shutdown-not-requested' };
    if (current.state === 'running' && localEndpoint() && voicebox && typeof voicebox.shutdown === 'function') {
      try { shutdown = await voicebox.shutdown(); }
      catch (error) { shutdown = { ok: false, error: String(error && error.message || error) }; }
    }

    const owned = child;
    if (childAlive() && owned && typeof owned.kill === 'function') {
      try { owned.kill(); } catch (_) { /* status below reports whether the service actually stopped */ }
      await waitForChildExit(owned, 3000);
    }
    if (!shutdown.ok && owned && localEndpoint() && voicebox && typeof voicebox.health === 'function' && typeof voicebox.shutdown === 'function') {
      try {
        const lateHealth = await voicebox.health();
        if (healthyVoicebox(lateHealth)) shutdown = await voicebox.shutdown();
      } catch (_) { /* the launched process may exit before the backend binds */ }
    }
    const stopped = await waitForRuntimeStop(shutdown.ok ? 5000 : 1000);
    const after = await status();
    if (!stopped && after.state === 'running') {
      return Object.assign({}, after, { ok: false, state: 'stop-failed', errorCode: 'voicebox-still-running', message: 'Voicebox 服务仍可连接；请在 Voicebox 本身确认退出状态。' });
    }
    if (!shutdown.ok && !owned && current.state === 'running') {
      return Object.assign({}, after, { ok: false, state: 'stop-failed', errorCode: 'shutdown-not-accepted', message: '当前 Voicebox 不接受停止请求；请从 Voicebox 窗口退出。' });
    }
    return Object.assign({}, after, { ok: true, alreadyStopped: false, message: 'Voicebox 服务已停止。' });
  }

  function stop() {
    if (stopping) return stopping;
    stopping = stopInternal().finally(function () { stopping = null; });
    return stopping;
  }

  return Object.freeze({ status, configurePath, start, stop, resolveProgram });
}

module.exports = createVoiceboxRuntimeControl;
