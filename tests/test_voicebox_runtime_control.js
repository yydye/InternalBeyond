'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const createControl = require('../bridge/voicebox-runtime-control.js');
const createRoutes = require('../bridge/routes.js');

class FakeChild extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.exitCode = null; this.signalCode = null; this.killed = false; }
  unref() {}
  kill() {
    if (this.exitCode != null || this.signalCode != null) return false;
    this.killed = true;
    this.signalCode = 'SIGTERM';
    setImmediate(() => { this.exitCode = 0; this.emit('exit', 0, 'SIGTERM'); });
    return true;
  }
  crash(code) { this.exitCode = Number(code); this.emit('exit', this.exitCode, null); }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-voicebox-runtime-control-'));
  try {
    const appPath = path.join(root, 'Voicebox.exe');
    fs.writeFileSync(appPath, 'test executable placeholder');
    if (process.platform !== 'win32') fs.chmodSync(appPath, 0o755);
    let healthy = false, shutdownCalls = 0, spawnCalls = 0, persistCalls = 0, lastSpawn = null;
    let child = null;
    const config = { voicebox: { enabled: true, endpoint: '', executablePath: '' } };
    const voicebox = {
      endpoint: () => 'http://127.0.0.1:17493',
      health: async () => healthy ? { ok: true, status: 'healthy', modelLoaded: false, gpuAvailable: false, gpuType: '' }
        : { ok: false, error: 'Voicebox /health failed (fetch failed)' },
      shutdown: async () => { shutdownCalls++; healthy = false; return { ok: true, status: 200 }; }
    };
    const control = createControl({ config, voicebox, env: {}, platform: process.platform,
      persistConfig: () => { persistCalls++; },
      spawn: (exe, args, options) => { spawnCalls++; lastSpawn = { exe, args, options }; child = new FakeChild(44001); return child; }
    });

    let state = await control.status();
    assert.strictEqual(state.state, 'not-configured', 'no path + refused connection is a normal unconfigured state');
    assert.strictEqual(state.errorCode, 'program-not-located');
    assert.strictEqual(control.configurePath('Voicebox.exe').error, 'path-must-be-absolute');
    assert.strictEqual(control.configurePath(path.join(root, 'not-installed.exe')).error, 'select-voicebox-exe');
    const configured = control.configurePath(appPath);
    assert.strictEqual(configured.ok, true);
    assert.strictEqual(persistCalls, 1, 'path persists through existing Bridge config writer');

    state = await control.status();
    assert.strictEqual(state.state, 'installed-stopped', 'installed but connection-refused is not treated as a Bridge fault');
    const start = await control.start();
    assert.strictEqual(start.state, 'starting');
    assert.strictEqual(spawnCalls, 1);
    assert.strictEqual(lastSpawn.exe, appPath);
    assert.deepStrictEqual(lastSpawn.args, [], 'launch uses no shell or arbitrary command arguments');
    assert.strictEqual(lastSpawn.options.shell, false);
    assert.strictEqual((await control.start()).alreadyRunning, true, 'duplicate Start does not spawn twice');
    assert.strictEqual(spawnCalls, 1);

    healthy = true;
    state = await control.status();
    assert.strictEqual(state.state, 'running');
    assert.strictEqual(state.processOwned, true);
    const stopped = await control.stop();
    assert.strictEqual(stopped.ok, true);
    assert.strictEqual(shutdownCalls, 1, 'Stop uses the existing Voicebox shutdown endpoint');
    assert.strictEqual(child.killed, true, 'Stop only terminates the exact GUI child spawned by IB');
    assert.strictEqual((await control.stop()).alreadyStopped, true, 'duplicate Stop is idempotent');

    const missing = createControl({ config: { voicebox: { endpoint: '', executablePath: path.join(root, 'missing', 'Voicebox.exe') } }, voicebox, env: {}, platform: process.platform });
    assert.strictEqual((await missing.status()).state, 'not-installed', 'stale path is distinguishable from not-yet-located');

    const foreignEndpoint = createControl({ config: { voicebox: { endpoint: 'http://voicebox.example:17493', executablePath: appPath } },
      voicebox: { endpoint: () => 'http://voicebox.example:17493', health: async () => ({ ok: true, status: 'healthy' }), shutdown: async () => { throw new Error('must not stop remote'); } },
      env: {}, platform: process.platform, spawn: () => { throw new Error('must not start for a remote endpoint'); }
    });
    assert.strictEqual((await foreignEndpoint.status()).state, 'remote-running');
    assert.strictEqual((await foreignEndpoint.start()).ok, false, 'IB does not start a remote provider endpoint');
    assert.strictEqual((await foreignEndpoint.stop()).ok, false, 'IB does not stop a remote provider endpoint');

    const failing = createControl({ config: { voicebox: { endpoint: '', executablePath: appPath } }, voicebox, env: {}, platform: process.platform,
      spawn: () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    });
    assert.strictEqual((await failing.start()).state, 'start-failed', 'spawn errors have their own state');

    let crashChild = null;
    const crashControl = createControl({ config: { voicebox: { endpoint: '', executablePath: appPath } }, voicebox: Object.assign({}, voicebox, { health: async () => ({ ok: false, error: 'fetch failed' }) }), env: {}, platform: process.platform,
      spawn: () => { crashChild = new FakeChild(44002); return crashChild; }
    });
    assert.strictEqual((await crashControl.start()).state, 'starting');
    crashChild.crash(23);
    const crashed = await crashControl.status();
    assert.strictEqual(crashed.state, 'start-failed', 'unexpected child exit is not shown as running');
    assert.strictEqual(crashed.errorCode, 'process-exited');

    let liveAfterLaunch = false, orphanedChild = null, orphanSpawnCount = 0;
    const orphanControl = createControl({ config: { voicebox: { endpoint: '', executablePath: appPath } },
      voicebox: { endpoint: () => 'http://127.0.0.1:17493', health: async () => liveAfterLaunch ? { ok: true, status: 'healthy' } : { ok: false, error: 'fetch failed' }, shutdown: async () => ({ ok: true }) },
      env: {}, platform: process.platform, spawn: () => { orphanSpawnCount++; orphanedChild = new FakeChild(44003); return orphanedChild; }
    });
    await orphanControl.start(); liveAfterLaunch = true;
    assert.strictEqual((await orphanControl.status()).state, 'running');
    liveAfterLaunch = false;
    const serviceExited = await orphanControl.status();
    assert.strictEqual(serviceExited.state, 'start-failed', 'a previously healthy service loss is not left in perpetual starting state');
    assert.strictEqual(serviceExited.processOwned, true);
    assert.strictEqual((await orphanControl.start()).errorCode, 'process-still-running', 'Start does not duplicate a still-open GUI process');
    assert.strictEqual(orphanSpawnCount, 1);
    assert.strictEqual((await orphanControl.stop()).state, 'installed-stopped', 'Stop recovers the owned GUI after the sidecar exits');

    const conflict = createControl({ config: { voicebox: { endpoint: '', executablePath: appPath } },
      voicebox: { endpoint: () => 'http://127.0.0.1:17493', health: async () => ({ ok: true, status: '' }) },
      env: {}, platform: process.platform, spawn: () => { throw new Error('must refuse port conflict'); }
    });
    assert.strictEqual((await conflict.status()).state, 'endpoint-conflict');
    assert.strictEqual((await conflict.start()).ok, false, 'unidentified port occupant is not replaced');

    const routeCalls = { status: 0, configure: [], start: 0, stop: 0 };
    const routeConfig = { voicebox: { enabled: true, endpoint: '', executablePath: appPath } };
    const routes = createRoutes({
      config: routeConfig, voiceboxRuntimeControl: {
        status: async () => { routeCalls.status++; return { ok: true, state: 'installed-stopped' }; },
        configurePath: value => { routeCalls.configure.push(value); return { ok: true, executablePath: value }; },
        start: async () => { routeCalls.start++; return { ok: true, state: 'starting' }; },
        stop: async () => { routeCalls.stop++; return { ok: true, state: 'installed-stopped' }; }
      },
      LAN_EXPOSED: false, configInvalid: false, SERVER_NAME: 'IB Bridge', VERSION: 'test', HOST: '127.0.0.1', PORT: 0, BIND_HOST: '127.0.0.1',
      environment: 'production', DATA_DIR: root, STICKER_DIR: root, maxBody: 64 * 1024, wsSockets: new Set(), TOOLS: [],
      listStickers: () => [], getWhispers: () => [], setWhispers: () => {}, healthData: [], getGeoLatest: () => null, setGeoLatest: () => {},
      getLetters: () => [], setLetters: () => {}, sessions: {}, resident: {}, contextStats: {}, pushHistory: [],
      withListLock: async (_key, fn) => fn(), uid: () => 'id', todayStr: () => '2026-10-14', saveList: () => {}, saveGeo: () => {},
      saveSessions: () => {}, saveResident: () => {}, getWeather: async () => ({}), searchMusic: async () => ({}), musicPlayUrl: async () => ({}),
      musicPlayRemote: async () => ({}), searchNetease: async () => ({}), barkPush: async () => ({}), ntfyPush: async () => ({}),
      ttsNormalize: () => ({}), ttsSynthesize: async () => ({}), ttsVoices: {}, ttsSources: () => [], voicebox: {}, asr: {},
      sessionGet: () => null, sessionSave: () => ({}), contextAppend: () => ({}), contextSummary: () => ({}), residentList: () => [],
      residentUpsert: () => ({}), residentSummary: () => ({}), residentChat: async () => ({}), residentProactive: async () => ({}),
      broadcast: () => {}, recordPush: () => {}, lanAddresses: () => [], fileSummary: () => ({}), directoryUsage: () => ({}),
      httpAuthorized: () => true, authRequiredResponse: res => { res.writeHead(401); res.end(); },
      parseQuery: url => Object.fromEntries(url.searchParams), corsOrigin: req => {
        const origin = String(req.headers.origin || '').trim();
        return !origin || origin === 'null' || /^https?:\/\/(tauri\.localhost|localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? origin || null : null;
      }
    });
    const server = http.createServer(routes.handleHttp);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = 'http://127.0.0.1:' + server.address().port;
      const publicConfig = await (await fetch(base + '/api/config')).json();
      assert.strictEqual(publicConfig.config.voicebox.executablePath, '[configured]', 'general config snapshot does not reveal the full local executable path');
      const read = await (await fetch(base + '/api/tts/voicebox/runtime')).json();
      assert.strictEqual(read.state, 'installed-stopped');
      const save = await fetch(base + '/api/tts/voicebox/runtime/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executablePath: appPath }) });
      assert.strictEqual(save.status, 200);
      assert.deepStrictEqual(routeCalls.configure, [appPath]);
      const startRoute = await fetch(base + '/api/tts/voicebox/runtime/start', { method: 'POST' });
      assert.strictEqual(startRoute.status, 202);
      const stopRoute = await fetch(base + '/api/tts/voicebox/runtime/stop', { method: 'POST' });
      assert.strictEqual(stopRoute.status, 200);
      const beforeDenied = routeCalls.start;
      const denied = await fetch(base + '/api/tts/voicebox/runtime/start', { method: 'POST', headers: { Origin: 'https://untrusted.example' } });
      assert.strictEqual(denied.status, 403, 'foreign web origins cannot start local programs');
      assert.strictEqual(routeCalls.start, beforeDenied);
    } finally { await new Promise(resolve => server.close(resolve)); }

    console.log('PASS test_voicebox_runtime_control (state, config, launch, idempotency, shutdown, remote, conflict and Bridge-origin cases)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
