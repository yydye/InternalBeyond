'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const vm = require('vm');
const { DatabaseSync } = require('node:sqlite');
const snapshot = require('../runtime/dev-snapshot.js');
const createCredentialVault = require('../active/credential-vault.js');
const createCredentialResolver = require('../active/credential-resolver.js');

const previousLocalAppData = process.env.LOCALAPPDATA;
const previousProdPort = process.env.IB_PROD_WEB_PORT;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-dev-launcher-test-'));
process.env.LOCALAPPDATA = tempRoot;
delete process.env.IB_PROD_WEB_PORT;
const launcher = require('../runtime/ib-dev-launcher.js');

function hash(file) {
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function homeNodeRequest(port, method, route, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: Object.assign(payload ? { 'Content-Type': 'application/json' } : {}, headers || {})
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', part => { raw += part; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw || '{}'); } catch (_) {}
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function spawnDevHomeNode(port, sandbox, credentialDir, dataDir, devIdentity) {
  const syntheticMode = path.basename(path.dirname(sandbox)).toLowerCase() === 'dev-synthetic';
  devIdentity = devIdentity || { instanceId: crypto.randomUUID(), sessionToken: crypto.randomBytes(32).toString('hex') };
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: tempRoot,
    IB_DEV_MODE: '1',
    IB_DEV_SYNTHETIC: syntheticMode ? '1' : '0',
    IB_DEV_INSTANCE_ID: devIdentity.instanceId,
    IB_DEV_SESSION_TOKEN: devIdentity.sessionToken,
    IB_DEV_SANDBOX_ROOT: sandbox,
    IB_ACTIVE_DATA_DIR: path.join(sandbox, 'active'),
    IB_BRIDGE_DATA_DIR: path.join(sandbox, 'bridge'),
    IB_HOME_NODE_HOST: '127.0.0.1',
    IB_HOME_NODE_PORT: String(port),
    IB_ACTIVE_PORT: String(launcher.DEV_PORTS.active),
    IB_BRIDGE_PORT: String(launcher.DEV_PORTS.bridge),
    IB_WEB_PORT: String(launcher.DEV_PORTS.web),
    IB_RESTART_PORT: String(launcher.DEV_PORTS.restart),
    IB_DEV_FAKE_PROVIDER_PORT: String(launcher.DEV_PORTS.fakeProvider),
    IB_ECONOMY_CHANNEL_SOURCE_PORT: String(launcher.DEV_PORTS.activeChannelSource),
    IB_DSH_CONTROL_PORT: String(launcher.DEV_PORTS.dshControl),
    IB_DSH_WEB_PORT: String(launcher.DEV_PORTS.dshWeb),
    IB_HOME_NODE_DATA_DIR: dataDir || path.join(sandbox, 'home-node'),
    IB_CREDENTIAL_DATA_DIR: credentialDir,
    IB_CREDENTIAL_BINDINGS_DIR: credentialDir,
    /* test-all deliberately disables provisioning globally; this fixture is the
       Dev generated-credential path, so opt it back in explicitly and locally. */
    IB_HOME_NODE_TOKEN_AUTOPROVISION: '1'
  });
  delete env.IB_HOME_NODE_TOKEN;
  delete env.IB_HOME_NODE_TOKEN_FILE;
  const child = spawn(process.execPath, ['services/home-node-service.js'], {
    cwd: path.resolve(__dirname, '..'), env,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', chunk => { if (output.length < 12000) output += chunk.toString(); });
  child.stderr.on('data', chunk => { if (output.length < 12000) output += chunk.toString(); });
  return { child, output: () => output };
}

function spawnFormalHomeNode(port, dataDir, credentialDir, token) {
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: tempRoot,
    IB_HOME_NODE_HOST: '127.0.0.1',
    IB_HOME_NODE_PORT: String(port),
    IB_HOME_NODE_DATA_DIR: dataDir,
    IB_CREDENTIAL_DATA_DIR: credentialDir,
    IB_HOME_NODE_TOKEN: token
  });
  delete env.IB_DEV_MODE;
  delete env.IB_DEV_SANDBOX_ROOT;
  const child = spawn(process.execPath, ['services/home-node-service.js'], {
    cwd: path.resolve(__dirname, '..'), env,
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', chunk => { if (output.length < 12000) output += chunk.toString(); });
  child.stderr.on('data', chunk => { if (output.length < 12000) output += chunk.toString(); });
  return { child, output: () => output };
}

async function waitForHomeNode(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const response = await homeNodeRequest(port, 'GET', '/health');
      if (response.status === 200 && response.body && response.body.service === 'internal-beyond-home-node') return response.body;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); child.removeListener('exit', onExit); resolve(value); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function importSnapshotPageFixture(payload, initialRows) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'dev-runtime.js'), 'utf8');
  const imported = {};
  Object.keys(initialRows || {}).forEach(name => { imported[name] = initialRows[name].map(row => Object.assign({}, row)); });
  const modes = [];
  let openCalls = 0;
  const schema = {
    STORE_NAMES: Object.keys(payload.stores || {}),
    keyPathFor: name => name === 'categories' ? 'name' : (name === 'disclosureFacts' ? 'factId' : 'id'),
    open: async () => {
      openCalls++;
      return ({
        objectStoreNames: { contains: name => Object.prototype.hasOwnProperty.call(payload.stores || {}, name) },
        transaction(names, mode) {
          modes.push(mode);
          let pending = 0;
          let readyToComplete = false;
          const completeIfReady = () => {
            if (readyToComplete && pending === 0 && tx.oncomplete) tx.oncomplete();
          };
          const finishRequest = () => { pending--; completeIfReady(); };
          const tx = {
            objectStore(name) {
              const keyPath = schema.keyPathFor(name);
              if (!imported[name]) imported[name] = [];
              return {
                keyPath,
                get(key) {
                  pending++;
                  const request = {};
                  setImmediate(() => {
                    request.result = imported[name].find(row => row && row[keyPath] === key);
                    if (request.onsuccess) request.onsuccess();
                    finishRequest();
                  });
                  return request;
                },
                add(row) {
                  pending++;
                  const request = {};
                  setImmediate(() => {
                    if (imported[name].some(existing => existing && existing[keyPath] === row[keyPath])) {
                      request.error = new Error('duplicate-key');
                      request.error.name = 'ConstraintError';
                      if (request.onerror) request.onerror({ preventDefault() {}, stopPropagation() {} });
                    } else {
                      imported[name].push(Object.assign({}, row));
                      if (request.onsuccess) request.onsuccess();
                    }
                    finishRequest();
                  });
                  return request;
                }
              };
            }
          };
          setImmediate(() => { readyToComplete = true; completeIfReady(); });
          return tx;
        },
        close() {}
      });
    }
  };
  const invoked = [];
  const root = {
    document: {},
    __IB_DEV_MODE__: true,
    IBWebCoreDbSchema: schema,
    indexedDB: {},
    __TAURI__: { core: { invoke: async name => {
      invoked.push(name);
      if (name === 'ib_dev_snapshot_load') return payload;
      return undefined;
    } } }
  };
  vm.runInNewContext(source, { window: root, Promise, Error, console });
  await root.__IB_DEV_BOOTSTRAP_PROMISE__;
  return { imported, modes, invoked, openCalls };
}

function manualExportFixture() {
  return {
    version: 9,
    exportDate: new Date().toISOString(),
    apiConfigs: [{ id: 'role-fixture', credentialRef: 'vault-role-fixture', apiKey: 'must-not-copy', accessToken: 'must-not-copy-either', credential: 'no-plain-credential', endpoint: 'https://api.invalid/chat?key=query-secret&model=test', nested: { authorization: 'nested-secret', privateKey: 'private-key-secret' } }],
    chatMessages: [{ id: 'chat-fixture', content: 'history-row' }],
    memories: [{ id: 'memory-fixture', content: 'memory-row' }],
    chatThreads: [], chatSummaries: [], autoMemory: [], roleLetters: [],
    understandings: [{ id: 'relation-fixture', characterId: 'role-fixture', affinity: 3 }],
    threads: []
  };
}

(async () => {
  let pass = 0;
  const check = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };
  let sourceDb = null;
  let homeNodeChild = null;
  let formalHomeNodeChild = null;
  try {
    console.log('IB Dev Launcher isolation and snapshot checks\n');
    const sandbox = path.join(tempRoot, 'InternalBeyond', 'dev-sandbox');

    await check('Dev Home Node exits before opening a path outside its Sandbox', async () => {
      const outside = path.join(tempRoot, 'formal-fixture', 'rejected-home-node');
      const port = await freePort();
      const rejected = spawnDevHomeNode(port, sandbox, path.join(tempRoot, 'formal-vault-fixture'), outside);
      assert.strictEqual(await waitForExit(rejected.child, 10000), true);
      assert.notStrictEqual(rejected.child.exitCode, 0);
      assert.strictEqual(fs.existsSync(outside), false);
      assert.strictEqual(await waitForHomeNode(port, 300), null);
    });

    await check('Home Node snapshot uses online SQLite backup and preserves the active source DB', async () => {
      const source = path.join(tempRoot, 'formal-fixture', 'home-node.db');
      const target = path.join(sandbox, 'home-node', 'home-node.db');
      fs.mkdirSync(path.dirname(source), { recursive: true });
      sourceDb = new DatabaseSync(source);
      sourceDb.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT NOT NULL);');
      sourceDb.prepare('INSERT INTO messages (id, body) VALUES (?, ?)').run('fixture-1', 'formal-fixture-row');
      /* The SQLite WAL shared-memory lock file is deliberately excluded: a
         read-only SQLite connection may update ephemeral lock bytes there. */
      const before = { main: hash(source), wal: hash(source + '-wal') };
      assert.ok(before.wal, 'fixture must have a live WAL file');
      const result = await snapshot.backupHomeNodeDatabase(source, target);
      assert.strictEqual(result.method, 'sqlite-online-backup');
      assert.ok(result.bytes > 512);
      const copy = new DatabaseSync(target, { readOnly: true });
      try {
        assert.strictEqual(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
        const rows = copy.prepare('SELECT id, body FROM messages').all();
        assert.deepStrictEqual(rows.map(row => ({ id: row.id, body: row.body })), [{ id: 'fixture-1', body: 'formal-fixture-row' }]);
      } finally { copy.close(); }
      assert.deepStrictEqual({ main: hash(source), wal: hash(source + '-wal') }, before);
      assert.ok(!fs.existsSync(path.join(tempRoot, 'InternalBeyond', 'home-node', 'home-node.db')));
    });

    await check('Sandbox manifests can be replaced atomically on restart', async () => {
      const file = path.join(sandbox, 'manifest-fixture.json');
      snapshot.writeJsonAtomic(file, { run: 1 });
      snapshot.writeJsonAtomic(file, { run: 2 });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { run: 2 });
    });

    await check('Tauri Dev environment maps every mutable directory and Vault to the isolated Sandbox', async () => {
      const envForTauri = launcher.tauriEnvironment({
        IB_HOME_NODE_TOKEN: 'synthetic-production-token',
        IB_HOME_NODE_TOKEN_FILE: 'synthetic-production-token-file'
      });
      assert.strictEqual(envForTauri.IB_HOME_NODE_DATA_DIR, path.join(launcher.SANDBOX, 'home-node'));
      assert.strictEqual(envForTauri.CARGO_TARGET_DIR, path.join(launcher.SANDBOX, 'cargo-target'));
      assert.strictEqual(envForTauri.IB_BRIDGE_DATA_DIR, path.join(launcher.SANDBOX, 'bridge'));
      assert.strictEqual(envForTauri.IB_ACTIVE_DATA_DIR, path.join(launcher.SANDBOX, 'active'));
      assert.strictEqual(envForTauri.IB_CREDENTIAL_DATA_DIR, path.join(launcher.SANDBOX, 'credential-vault'));
      assert.strictEqual(envForTauri.IB_HOME_NODE_PORT, String(launcher.DEV_PORTS.homeNode));
      assert.strictEqual(envForTauri.IB_WEB_PORT, String(launcher.DEV_PORTS.web));
      assert.strictEqual(envForTauri.IB_HOME_NODE_TOKEN, undefined);
      assert.strictEqual(envForTauri.IB_HOME_NODE_TOKEN_FILE, undefined);
      assert.strictEqual(envForTauri.IB_HOME_NODE_HOST, '127.0.0.1');
      assert.strictEqual(envForTauri.IB_DEV_DSH_ENABLED, '0');
      assert.strictEqual(envForTauri.IB_DEV_SYNTHETIC, '0');
      assert.strictEqual(launcher.tauriEnvironment({ IB_DEV_DSH_ENABLED: '1' }).IB_DEV_DSH_ENABLED, '1');
      assert.deepStrictEqual(launcher.parseStartOptions([]), { dshEnabled: false, synthetic: false, manualExportPath: undefined });
      assert.deepStrictEqual(launcher.parseStartOptions(['fixture.json', '--dsh']), { dshEnabled: true, synthetic: false, manualExportPath: 'fixture.json' });
      assert.deepStrictEqual(launcher.parseStartOptions(['--synthetic', '--dsh']), { dshEnabled: true, synthetic: true, manualExportPath: undefined });
      assert.deepStrictEqual(launcher.resolveAppDataPaths(path.join(tempRoot, 'roots'), true), {
        appData: path.join(tempRoot, 'roots', 'InternalBeyond', 'dev-synthetic'),
        sandbox: path.join(tempRoot, 'roots', 'InternalBeyond', 'dev-synthetic', 'dev-sandbox'),
        credentialDataDir: path.join(tempRoot, 'roots', 'InternalBeyond', 'dev-synthetic', 'dev-sandbox', 'credential-vault')
      });
    });

    await check('status does not show stale service handles as ready after the Host exits', async () => {
      const hostRecordFile = path.join(launcher.SANDBOX, 'host', 'tauri-service-supervisor.json');
      snapshot.writeJsonAtomic(hostRecordFile, {
        runtimeRoot: launcher.ROOT,
        hostPid: 0,
        hostStartedAtMs: 0,
        status: { staticReady: true, homeNodeReady: true, bridgeReady: true }
      });
      const status = launcher.statusText();
      assert.ok(status.includes('Tauri host: not running'));
      assert.ok(status.includes('Static Web: not ready'));
      assert.ok(status.includes('Home Node: not ready'));
      assert.ok(status.includes('Bridge: not ready'));
    });

    await check('Dev startup initializes the static handle before state and child-process use, then stops normally', async () => {
      const events = [];
      const cleanups = [];
      const lifecycle = await launcher.initializeDevHostLifecycle({
        startStaticServer: async () => { events.push('static-start'); return { pid: 4101, startedAtMs: 10, script: 'static-fixture.js' }; },
        createState: ownedStatic => {
          events.push('state-create');
          assert.strictEqual(ownedStatic.pid, 4101);
          return { childPid: 0, staticPid: ownedStatic.pid, staticStartedAtMs: ownedStatic.startedAtMs };
        },
        saveState: state => { events.push('state-save-' + state.childPid); },
        spawnTauri: () => { events.push('tauri-spawn'); return { pid: 4102, exitCode: null, signalCode: null }; },
        childStartedAtMs: () => 20,
        waitForReady: async (_state, child) => { events.push('ready'); return child.pid === 4102; },
        cleanupOwned: async (handles, reason) => { cleanups.push({ handles, reason }); }
      });
      assert.deepStrictEqual(events, ['static-start', 'state-create', 'state-save-0', 'tauri-spawn', 'state-save-4102', 'ready']);
      assert.strictEqual(lifecycle.staticServer.pid, 4101);
      assert.strictEqual(lifecycle.devChild.pid, 4102);
      assert.strictEqual(cleanups.length, 0);
      await lifecycle.stop();
      assert.strictEqual(cleanups.length, 1);
      assert.strictEqual(cleanups[0].reason, 'normal-exit');
      assert.strictEqual(cleanups[0].handles.staticServer.pid, 4101);
      assert.strictEqual(cleanups[0].handles.devChild.pid, 4102);
    });

    await check('Dev startup failure cleans only handles created before the failing stage', async () => {
      const noHandleCleanup = [];
      await assert.rejects(launcher.initializeDevHostLifecycle({
        startStaticServer: async () => { throw new Error('synthetic-static-start-failure'); },
        createState: () => { throw new Error('state-must-not-be-created'); },
        saveState: async () => {},
        spawnTauri: async () => { throw new Error('tauri-must-not-start'); },
        childStartedAtMs: () => 0,
        waitForReady: async () => false,
        cleanupOwned: async (handles, reason) => { noHandleCleanup.push({ handles, reason }); }
      }), /synthetic-static-start-failure/);
      assert.strictEqual(noHandleCleanup.length, 1);
      assert.strictEqual(noHandleCleanup[0].reason, 'startup-failure');
      assert.deepStrictEqual(noHandleCleanup[0].handles, { staticServer: null, dshHost: null, state: null, devChild: null });

      const partialCleanup = [];
      await assert.rejects(launcher.initializeDevHostLifecycle({
        startStaticServer: async () => ({ pid: 4201, startedAtMs: 11, script: 'static-fixture.js' }),
        createState: ownedStatic => ({ childPid: 0, staticPid: ownedStatic.pid }),
        saveState: async () => {},
        spawnTauri: async () => { throw new Error('synthetic-spawn-failure'); },
        childStartedAtMs: () => 21,
        waitForReady: async () => true,
        cleanupOwned: async (handles, reason) => { partialCleanup.push({ handles, reason }); }
      }), /synthetic-spawn-failure/);
      assert.strictEqual(partialCleanup.length, 1);
      assert.strictEqual(partialCleanup[0].reason, 'startup-failure');
      assert.strictEqual(partialCleanup[0].handles.staticServer.pid, 4201);
      assert.strictEqual(partialCleanup[0].handles.devChild, null);

      const readinessCleanup = [];
      await assert.rejects(launcher.initializeDevHostLifecycle({
        startStaticServer: async () => ({ pid: 4301, startedAtMs: 12, script: 'static-fixture.js' }),
        createState: ownedStatic => ({ childPid: 0, staticPid: ownedStatic.pid }),
        saveState: async () => {},
        spawnTauri: async () => ({ pid: 4302, exitCode: null, signalCode: null }),
        childStartedAtMs: () => 22,
        waitForReady: async () => false,
        cleanupOwned: async (handles, reason) => { readinessCleanup.push({ handles, reason }); }
      }), /dev-host-startup-readiness-failed/);
      assert.strictEqual(readinessCleanup.length, 1);
      assert.strictEqual(readinessCleanup[0].reason, 'startup-failure');
      assert.strictEqual(readinessCleanup[0].handles.staticServer.pid, 4301);
      assert.strictEqual(readinessCleanup[0].handles.devChild.pid, 4302);
    });

    await check('Dev mode suppresses Active scheduling, Home Node bootstrap sync, and automatic backups', async () => {
      const active = fs.readFileSync(path.join(__dirname, '..', 'services', 'active-message-service.js'), 'utf8');
      const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'home-node-bootstrap.js'), 'utf8');
      const core = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'core.js'), 'utf8');
      const html = fs.readFileSync(path.join(__dirname, '..', 'InternalBeyond.html'), 'utf8');
      assert.ok(/if\s*\(!DEV_MODE\)\s*startScheduler\(\)/.test(active));
      assert.ok(/window\.__IB_DEV_MODE__\s*===\s*true/.test(bootstrap));
      assert.ok(/if\(window\.__IB_DEV_MODE__===true\)return/.test(core));
      assert.ok(/window\.__IB_DEV_MODE__\s*===\s*true[\s\S]*?document\.write\([\s\S]*assets\/js\/dev-runtime\.js/.test(core)
        && /<script src="assets\/js\/webcore-db-schema\.js"><\/script>[\s\S]*?<script src="assets\/js\/core\.js"><\/script>/.test(html),
        'Dev snapshot import must load after the schema and only in the Launcher-injected Dev mode');
      assert.strictEqual((html.match(/<script(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script>/gi) || []).length, 0,
        'the production document must not contain inline executable scripts');
    });

    await check('existing Vault resolver reads a synthetic formal Vault without modifying it', async () => {
      const vaultDir = path.join(tempRoot, 'formal-vault-fixture');
      fs.mkdirSync(vaultDir, { recursive: true });
      const vault = createCredentialVault({ dataDir: vaultDir });
      vault.load();
      assert.strictEqual(vault.upsert('role-fixture', { provider: 'openai', apiKey: 'synthetic-only-key-do-not-print', model: 'fixture-model' }), true);
      const keyFile = path.join(vaultDir, 'credential-vault.key');
      const dataFile = path.join(vaultDir, 'credential-vault.json');
      const before = { key: hash(keyFile), data: hash(dataFile) };
      const resolved = createCredentialResolver({ dataDir: vaultDir }).resolve('role-fixture');
      assert.ok(resolved && resolved.provider === 'openai' && resolved.apiKey === 'synthetic-only-key-do-not-print');
      assert.deepStrictEqual({ key: hash(keyFile), data: hash(dataFile) }, before);
    });

    await check('Dev Home Node writes only to its sandbox across API errors, normal stop, crash, and restart', async () => {
      const formalVault = path.join(tempRoot, 'formal-vault-fixture');
      const serviceSandbox = path.join(tempRoot, 'InternalBeyond', 'dev-synthetic', 'dev-sandbox');
      const homeNodeDir = path.join(serviceSandbox, 'home-node');
      const formalDb = path.join(tempRoot, 'formal-fixture', 'home-node.db');
      const formalLiveDir = path.join(tempRoot, 'formal-fixture', 'live-home-node');
      const formalDbHash = hash(formalDb);
      const vaultHashes = {
        key: hash(path.join(formalVault, 'credential-vault.key')),
        data: hash(path.join(formalVault, 'credential-vault.json'))
      };
      const port = await freePort();
      const formalPort = await freePort();
      const formalToken = 'synthetic-formal-home-token-0123456789';
      const devIdentity = { instanceId: crypto.randomUUID(), sessionToken: crypto.randomBytes(32).toString('hex') };
      fs.mkdirSync(homeNodeDir, { recursive: true });
      const headers = () => {
        const authority = JSON.parse(fs.readFileSync(path.join(homeNodeDir, 'desktop-credential.json'), 'utf8'));
        return { 'X-IB-Home-Token': authority.token, Origin: 'http://127.0.0.1:' + launcher.DEV_PORTS.web,
          'X-IB-Dev-Session': devIdentity.sessionToken, 'X-IB-Dev-Instance': devIdentity.instanceId };
      };
      const listMessages = async () => homeNodeRequest(port, 'GET', '/list?conversationId=dm%3Arole-fixture&limit=20', null, headers());
      const startAndWait = async () => {
        homeNodeChild = spawnDevHomeNode(port, serviceSandbox, path.join(serviceSandbox, 'credential-vault'), undefined, devIdentity);
        const health = await waitForHomeNode(port, 20000);
        assert.ok(health && health.service === 'internal-beyond-home-node', homeNodeChild.output().slice(-300));
        assert.ok(fs.existsSync(path.join(homeNodeDir, 'home-node.db')));
        assert.ok(fs.existsSync(path.join(homeNodeDir, 'desktop-credential.json')));
      };
      const gracefulStop = async () => {
        const response = await homeNodeRequest(port, 'POST', '/__shutdown', null, headers());
        assert.strictEqual(response.status, 202);
        assert.strictEqual(await waitForExit(homeNodeChild.child, 10000), true);
        homeNodeChild = null;
      };

      try {
        formalHomeNodeChild = spawnFormalHomeNode(formalPort, formalLiveDir, formalVault, formalToken);
        const formalHealth = await waitForHomeNode(formalPort, 20000);
        assert.ok(formalHealth && formalHealth.service === 'internal-beyond-home-node', 'formal fixture Home Node failed to start');
        const formalSeed = await homeNodeRequest(formalPort, 'POST', '/messages', {
          message: { id: 'msg_formal_fixture_u', role: 'user', content: 'formal-fixture', friendId: 'role-fixture', timestamp: 900 }
        }, { 'X-IB-Home-Token': formalToken });
        assert.strictEqual(formalSeed.status, 200);
        const formalBefore = await homeNodeRequest(formalPort, 'GET', '/health');
        const formalLiveDb = path.join(formalLiveDir, 'home-node.db');
        const formalLiveHashes = { main: hash(formalLiveDb), wal: hash(formalLiveDb + '-wal') };

        await startAndWait();
        const devCredential = headers()['X-IB-Home-Token'];
        assert.notStrictEqual(devCredential, formalToken);
        const blockedByOrigin = await homeNodeRequest(formalPort, 'POST', '/messages', {
          message: { id: 'msg_cross_origin_u', role: 'user', content: 'must-not-land-formally', friendId: 'role-fixture', timestamp: 901 }
        }, { 'X-IB-Home-Token': formalToken, Origin: 'http://127.0.0.1:23130' });
        const blockedByDevCredential = await homeNodeRequest(formalPort, 'POST', '/messages', {
          message: { id: 'msg_cross_host_u', role: 'user', content: 'must-not-land-formally', friendId: 'role-fixture', timestamp: 901 }
        }, { 'X-IB-Home-Token': devCredential });
        const formalAfter = await homeNodeRequest(formalPort, 'GET', '/health');
        assert.strictEqual(blockedByOrigin.status, 403);
        assert.strictEqual(blockedByDevCredential.status, 401);
        assert.strictEqual(formalAfter.body.revision, formalBefore.body.revision);
        assert.deepStrictEqual({ main: hash(formalLiveDb), wal: hash(formalLiveDb + '-wal') }, formalLiveHashes);

        let put = await homeNodeRequest(port, 'POST', '/messages', {
          message: { id: 'msg_dev_1_u', role: 'user', content: 'sandbox-one', friendId: 'role-fixture', timestamp: 1001 }
        }, headers());
        assert.strictEqual(put.status, 200);
        const initial = await listMessages();
        assert.strictEqual(initial.status, 200);
        assert.strictEqual(initial.body.messages.length, 1);

        const beforeError = await homeNodeRequest(port, 'GET', '/health');
        const apiError = await homeNodeRequest(port, 'POST', '/__dev-api-error-fixture', {}, headers());
        const afterError = await homeNodeRequest(port, 'GET', '/health');
        assert.ok(apiError.status >= 400);
        assert.strictEqual(afterError.body.revision, beforeError.body.revision);

        await gracefulStop();
        await startAndWait();
        let afterNormalStop = await listMessages();
        assert.strictEqual(afterNormalStop.body.messages.length, 1);

        put = await homeNodeRequest(port, 'POST', '/messages', {
          message: { id: 'msg_dev_2_u', role: 'user', content: 'sandbox-two', friendId: 'role-fixture', timestamp: 1003 }
        }, headers());
        assert.strictEqual(put.status, 200);
        homeNodeChild.child.kill();
        assert.strictEqual(await waitForExit(homeNodeChild.child, 10000), true);
        homeNodeChild = null;

        await startAndWait();
        const afterCrash = await listMessages();
        assert.strictEqual(afterCrash.body.messages.length, 2);
        assert.deepStrictEqual(hash(formalDb), formalDbHash);
        assert.deepStrictEqual({
          key: hash(path.join(formalVault, 'credential-vault.key')),
          data: hash(path.join(formalVault, 'credential-vault.json'))
        }, vaultHashes);
        assert.ok(fs.existsSync(path.join(homeNodeDir, 'home-node.db')));
      } finally {
        if (homeNodeChild && homeNodeChild.child && homeNodeChild.child.exitCode === null) {
          try { await homeNodeRequest(port, 'POST', '/__shutdown', null, headers()); } catch (_) {}
          if (!(await waitForExit(homeNodeChild.child, 4000))) {
            try { homeNodeChild.child.kill(); } catch (_) {}
            await waitForExit(homeNodeChild.child, 2000);
          }
        if (formalHomeNodeChild && formalHomeNodeChild.child && formalHomeNodeChild.child.exitCode === null) {
          try { await homeNodeRequest(formalPort, 'POST', '/__shutdown'); } catch (_) {}
          if (!(await waitForExit(formalHomeNodeChild.child, 4000))) {
            try { formalHomeNodeChild.child.kill(); } catch (_) {}
            await waitForExit(formalHomeNodeChild.child, 2000);
          }
        }
        }
      }
    });

    await check('manual reset removes only the Dev Sandbox', async () => {
      const formalDb = path.join(tempRoot, 'formal-fixture', 'home-node.db');
      const vaultFile = path.join(tempRoot, 'formal-vault-fixture', 'credential-vault.json');
      await launcher.reset();
      assert.strictEqual(fs.existsSync(launcher.SANDBOX), false);
      assert.strictEqual(fs.existsSync(formalDb), true);
      assert.strictEqual(fs.existsSync(vaultFile), true);
    });

    await check('manual formal export is imported to Sandbox with secrets stripped and source file unchanged', async () => {
      const exportFile = path.join(tempRoot, 'formal-fixture', 'InternalBeyond_backup_fixture.json');
      fs.mkdirSync(path.dirname(exportFile), { recursive: true });
      const exportFixture = manualExportFixture();
      fs.writeFileSync(exportFile, JSON.stringify(exportFixture), 'utf8');
      const sourceHash = hash(exportFile);
      const formalDb = path.join(tempRoot, 'formal-fixture', 'home-node.db');
      const formalDbHashes = { main: hash(formalDb), wal: hash(formalDb + '-wal') };
      const formalVault = path.join(tempRoot, 'formal-vault-fixture');
      const formalVaultHashes = {
        key: hash(path.join(formalVault, 'credential-vault.key')),
        data: hash(path.join(formalVault, 'credential-vault.json'))
      };
      const staged = launcher.stageManualExportFile(exportFile);
      const seedFile = path.join(launcher.SANDBOX, 'seed.json');
      const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      assert.strictEqual(launcher.manualSeedRequired(), false, 'an existing staged seed must be reused instead of exported again');
      assert.strictEqual(staged.sourceExport.version, 9);
      assert.strictEqual(staged.storeCounts.apiConfigs, 1);
      assert.strictEqual(staged.storeCounts.chatMessages, 1);
      assert.strictEqual(staged.storeCounts.memories, 1);
      assert.match(staged.sha256, /^[a-f0-9]{64}$/);
      assert.strictEqual(seed.stores.apiConfigs[0].credentialRef, 'vault-role-fixture');
      assert.strictEqual(Object.prototype.hasOwnProperty.call(seed.stores.apiConfigs[0], 'apiKey'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(seed.stores.apiConfigs[0], 'accessToken'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(seed.stores.apiConfigs[0], 'credential'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(seed.stores.apiConfigs[0].nested, 'authorization'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(seed.stores.apiConfigs[0].nested, 'privateKey'), false);
      assert.strictEqual(seed.stores.apiConfigs[0].endpoint.includes('query-secret'), false);
      assert.strictEqual(seed.stores.chatMessages[0].content, 'history-row');
      assert.strictEqual(seed.stores.memories[0].content, 'memory-row');
      assert.strictEqual(seed.stores.understandings[0].affinity, 3);
      assert.strictEqual(JSON.stringify(seed).includes('must-not-copy'), false);
      assert.strictEqual(JSON.stringify(seed).includes('nested-secret'), false);
      assert.strictEqual(JSON.stringify(seed).includes('private-key-secret'), false);
      assert.strictEqual(JSON.stringify(seed).includes('query-secret'), false);
      assert.strictEqual(hash(exportFile), sourceHash);
      assert.deepStrictEqual({ main: hash(formalDb), wal: hash(formalDb + '-wal') }, formalDbHashes);
      assert.deepStrictEqual({
        key: hash(path.join(formalVault, 'credential-vault.key')),
        data: hash(path.join(formalVault, 'credential-vault.json'))
      }, formalVaultHashes);
      assert.strictEqual(fs.existsSync(path.join(launcher.SANDBOX, path.basename(exportFile))), false);
      assert.strictEqual(fs.existsSync(path.join(launcher.SANDBOX, 'snapshot-manifest.json')), false);
      const imported = await importSnapshotPageFixture(seed);
      assert.strictEqual(imported.imported.apiConfigs[0].id, 'role-fixture');
      assert.strictEqual(imported.imported.chatMessages[0].content, 'history-row');
      assert.strictEqual(imported.imported.memories[0].content, 'memory-row');
      assert.strictEqual(imported.imported.understandings[0].affinity, 3);
    });

    await check('seed retry preserves existing Dev rows and adds missing IDs only', async () => {
      const seed = snapshot.normalizeManualExport(manualExportFixture()).snapshot;
      const existing = {
        chatMessages: [
          { id: 'chat-fixture', content: 'existing-dev-edit' },
          { id: 'dev-only-chat', content: 'keep-this-row' }
        ],
        memories: [{ id: 'memory-fixture', content: 'existing-dev-memory' }]
      };
      const first = await importSnapshotPageFixture(seed, existing);
      assert.strictEqual(first.imported.chatMessages.length, 2);
      assert.strictEqual(first.imported.chatMessages[0].content, 'existing-dev-edit');
      assert.strictEqual(first.imported.chatMessages[1].id, 'dev-only-chat');
      assert.strictEqual(first.imported.memories[0].content, 'existing-dev-memory');
      assert.strictEqual(first.imported.apiConfigs[0].id, 'role-fixture');
      assert.strictEqual(first.imported.understandings[0].id, 'relation-fixture');

      const retry = await importSnapshotPageFixture(seed, first.imported);
      assert.deepStrictEqual(retry.imported.chatMessages, first.imported.chatMessages);
      assert.deepStrictEqual(retry.imported.memories, first.imported.memories);
      assert.strictEqual(retry.imported.apiConfigs.length, 1);
      assert.strictEqual(retry.imported.understandings.length, 1);
    });

    await check('previously imported Sandbox seed is not replayed on restart', async () => {
      const imported = await importSnapshotPageFixture({ state: 'already-imported' });
      assert.strictEqual(imported.openCalls, 0);
      assert.deepStrictEqual(imported.modes, []);
      assert.deepStrictEqual(imported.invoked, ['ib_dev_snapshot_load']);
    });

    await check('manual export contract failures leave no partial Dev seed', async () => {
      await launcher.reset();
      const encryptedFile = path.join(tempRoot, 'formal-fixture', 'InternalBeyond_encrypted_fixture.ibvault');
      fs.writeFileSync(encryptedFile, JSON.stringify({ format: 'InternalBeyondEncryptedBackup', version: 1 }), 'utf8');
      assert.throws(() => launcher.stageManualExportFile(encryptedFile), /manual-export-json-required/);
      assert.strictEqual(fs.existsSync(path.join(launcher.SANDBOX, 'seed.json')), false);
      const invalidFile = path.join(tempRoot, 'formal-fixture', 'invalid-export.json');
      fs.writeFileSync(invalidFile, JSON.stringify({ version: 8, exportDate: new Date().toISOString() }), 'utf8');
      assert.throws(() => launcher.stageManualExportFile(invalidFile), /manual-export-contract-invalid/);
      assert.strictEqual(fs.existsSync(path.join(launcher.SANDBOX, 'seed.json')), false);
      const missingRolesFile = path.join(tempRoot, 'formal-fixture', 'empty-roles.json');
      fs.writeFileSync(missingRolesFile, JSON.stringify({
        version: 9,
        exportDate: new Date().toISOString(),
        apiConfigs: [], chatMessages: [], memories: [], chatThreads: [], chatSummaries: [],
        autoMemory: [], roleLetters: [], understandings: [], threads: []
      }), 'utf8');
      assert.throws(() => launcher.stageManualExportFile(missingRolesFile), /manual-export-roles-empty/);
      assert.strictEqual(fs.existsSync(path.join(launcher.SANDBOX, 'seed.json')), false);
    });

    console.log('\nResult: ' + pass + ' passed');
  } finally {
    if (sourceDb) { try { sourceDb.close(); } catch (_) {} }
    const resolvedTemp = path.resolve(tempRoot);
    if (resolvedTemp !== path.resolve(os.tmpdir()) && path.dirname(resolvedTemp) === path.resolve(os.tmpdir())) {
      try { fs.rmSync(resolvedTemp, { recursive: true, force: true }); }
      catch (error) { console.warn('  ! isolated temp cleanup deferred: ' + String(error && error.code || 'cleanup-failed')); }
    }
    if (previousLocalAppData == null) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousProdPort == null) delete process.env.IB_PROD_WEB_PORT; else process.env.IB_PROD_WEB_PORT = previousProdPort;
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
