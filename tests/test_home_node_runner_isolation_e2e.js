'use strict';

/* Isolated process-level regression for Production/Dev port collisions and
 * borrowed Home Node shutdown. All service data/logs live under temp roots. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const homeNodeIdentity = require('../runtime/home-node-identity.js');
const devServiceContract = require('../runtime/dev-service-contract.js');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'runtime', 'local-services-runner.js');
const HOME_NODE = path.join(ROOT, 'services', 'home-node-service.js');
const children = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function freePort(excluded) {
  for (;;) {
    const server = net.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    if (!excluded || !excluded.has(port)) {
      if (excluded) excluded.add(port);
      return port;
    }
  }
}

function request(port, pathname, method, headers) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: method || 'GET',
      headers: Object.assign({ 'Content-Length': '0' }, headers || {}), timeout: 1500
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(raw); } catch (_) { /* empty or non-JSON */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.on('error', () => resolve({ status: 0, body: null }));
    req.end();
  });
}

async function waitForHealth(port, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(port, '/health');
    if (result.status === 200 && result.body && (!predicate || predicate(result.body))) return result.body;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('health-timeout:' + port);
}

async function runnerPortMap(controlPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await request(controlPort, '/status');
    if (result.status === 200 && result.body && result.body.homeNodePortResolved === true) {
      return result.body.ports;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('runner-status-timeout:' + controlPort);
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

function spawnRunner(env, label) {
  const child = spawn(process.execPath, [RUNNER], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  child.testLabel = label;
  child.testOutput = '';
  child.stdout.on('data', chunk => { child.testOutput = (child.testOutput + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { child.testOutput = (child.testOutput + chunk).slice(-12000); });
  children.push(child);
  return child;
}

async function stopRunner(child, controlPort) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await request(controlPort, '/shutdown', 'POST');
  if (await waitForExit(child, 18000)) return;
  /* This fallback is limited to the test Runner spawned by this file. */
  if (process.platform === 'win32' && child.pid) {
    await new Promise(resolve => execFile('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 8000 }, resolve));
  } else {
    try { child.kill('SIGKILL'); } catch (_) { /* already exited */ }
  }
  await waitForExit(child, 5000);
}

function productionEnv(localAppData, ports, homeNodePort, dataDirectory) {
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: localAppData,
    IB_LOG_DIR: path.join(localAppData, 'logs'),
    IB_DEV_MODE: '0',
    IB_HOME_NODE_PORT: String(homeNodePort),
    IB_BRIDGE_PORT: String(ports.bridge),
    IB_ACTIVE_PORT: String(ports.active),
    IB_RESTART_PORT: String(ports.restart),
    IB_HOME_NODE_DATA_DIR: dataDirectory,
    IB_SHUTDOWN_BUDGET_MS: '15000'
  });
  for (const key of ['IB_DEV_SYNTHETIC', 'IB_DEV_INSTANCE_ID', 'IB_DEV_SESSION_TOKEN', 'IB_DEV_SANDBOX_ROOT', 'IB_DEV_PROJECT_ROOT']) delete env[key];
  return env;
}

async function distinctPorts() {
  const used = new Set();
  return {
    bridge: await freePort(used),
    active: await freePort(used),
    restart: await freePort(used)
  };
}

async function classifyHomeNodeListener(port, localAppData) {
  const ports = await distinctPorts();
  const env = productionEnv(localAppData, ports, port, path.join(localAppData, 'InternalBeyond', 'home-node'));
  const code = [
    'const runner=require(' + JSON.stringify(RUNNER) + ');',
    'runner.classifyPortOwner(' + Number(port) + ',runner.SERVICE_FILES.homeNode)',
    '.then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack||error);process.exitCode=1})'
  ].join(' ');
  return new Promise((resolve, reject) => execFile(process.execPath, ['-e', code], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 12000
  }, (error, stdout, stderr) => {
    if (error) { reject(new Error((stderr || stdout || error.message).trim())); return; }
    try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop())); }
    catch (_) { reject(new Error('invalid port classification result: ' + stdout)); }
  }));
}

async function startDirectDevHomeNode(localAppData, port) {
  const sandbox = path.join(localAppData, '.dev-data', 'development', 'dev-sandbox');
  const homeNodeDir = path.join(sandbox, 'home-node');
  for (const directory of [sandbox, homeNodeDir, path.join(sandbox, 'active'), path.join(sandbox, 'bridge'), path.join(sandbox, 'credential-vault')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const devId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const reserved = new Set([
    ...Object.values(devServiceContract.PRODUCTION_PORTS),
    ...Object.values(devServiceContract.DEV_PORTS), port
  ]);
  const devPorts = {
    web: await freePort(reserved), bridge: await freePort(reserved), active: await freePort(reserved),
    restart: await freePort(reserved), fakeProvider: await freePort(reserved),
    activeChannelSource: await freePort(reserved), dshControl: await freePort(reserved), dshWeb: await freePort(reserved)
  };
  const env = Object.assign({}, process.env, {
    LOCALAPPDATA: localAppData,
    IB_DEV_MODE: '1', IB_DEV_SYNTHETIC: '0',
    IB_DEV_PROJECT_ROOT: localAppData,
    IB_DEV_SANDBOX_ROOT: sandbox,
    IB_DEV_INSTANCE_ID: devId, IB_DEV_SESSION_TOKEN: token,
    IB_WEB_PORT: String(devPorts.web),
    IB_BRIDGE_PORT: String(devPorts.bridge), IB_ACTIVE_PORT: String(devPorts.active),
    IB_RESTART_PORT: String(devPorts.restart), IB_HOME_NODE_PORT: String(port),
    IB_DEV_FAKE_PROVIDER_PORT: String(devPorts.fakeProvider),
    IB_ECONOMY_CHANNEL_SOURCE_PORT: String(devPorts.activeChannelSource),
    IB_DSH_CONTROL_PORT: String(devPorts.dshControl), IB_DSH_WEB_PORT: String(devPorts.dshWeb),
    IB_HOME_NODE_DATA_DIR: homeNodeDir,
    IB_ACTIVE_DATA_DIR: path.join(sandbox, 'active'),
    IB_BRIDGE_DATA_DIR: path.join(sandbox, 'bridge'),
    IB_CREDENTIAL_DATA_DIR: path.join(sandbox, 'credential-vault'),
    IB_CREDENTIAL_BINDINGS_DIR: path.join(sandbox, 'credential-vault'),
    IB_LOG_DIR: path.join(localAppData, 'logs')
  });
  const child = spawn(process.execPath, [HOME_NODE], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  child.testOutput = '';
  child.stdout.on('data', chunk => { child.testOutput = (child.testOutput + chunk).slice(-6000); });
  child.stderr.on('data', chunk => { child.testOutput = (child.testOutput + chunk).slice(-6000); });
  children.push(child);
  const health = await waitForHealth(port, value => value.environment === 'dev' && value.devInstanceId === devId, 15000)
    .catch(error => { throw new Error(String(error.message) + '\n' + child.testOutput); });
  return { child, port, devId, token, sandbox, homeNodeDir, health };
}

async function stopDirectHomeNode(node) {
  if (!node || !node.child || node.child.exitCode !== null || node.child.signalCode !== null) return;
  await request(node.port, '/__shutdown', 'POST', {
    'X-IB-Dev-Session': node.token,
    'X-IB-Dev-Instance': node.devId
  });
  if (await waitForExit(node.child, 7000)) return;
  try { node.child.kill('SIGTERM'); } catch (_) { /* test-owned process */ }
  await waitForExit(node.child, 3000);
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-home-node-runner-isolation-'));
  const crossRoot = path.join(base, 'cross-environment');
  const devLocal = path.join(crossRoot, 'dev-local');
  const prodLocal = path.join(crossRoot, 'prod-local');
  fs.mkdirSync(devLocal, { recursive: true });
  fs.mkdirSync(prodLocal, { recursive: true });
  let devNode = null;
  let crossRunner = null;
  let ownerRunner = null;
  let borrowerRunner = null;
  let crossControlPort = 0;
  let ownerControlPort = 0;
  let borrowerControlPort = 0;
  try {
    /* Cross-environment occupation: a real Dev Home Node owns one temp database.
       The Production Runner must choose another port and start against its own DB. */
    const devHomePort = await freePort();
    devNode = await startDirectDevHomeNode(devLocal, devHomePort);
    const devOwnerClassification = await classifyHomeNodeListener(devHomePort, path.join(base, 'classification-local'));
    assert.strictEqual(devOwnerClassification.owner, 'unowned-component', 'an exact Home Node script path is diagnostic and never becomes current Runner ownership');
    const devPid = devNode.health.pid;
    const prodHomeDir = path.join(prodLocal, 'InternalBeyond', 'home-node');
    const crossPorts = await distinctPorts();
    crossControlPort = crossPorts.restart;
    crossRunner = spawnRunner(productionEnv(prodLocal, crossPorts, devHomePort, prodHomeDir), 'production-cross-env');
    const crossPortMap = await runnerPortMap(crossControlPort, 15000);
    assert.notStrictEqual(crossPortMap.homeNode, devHomePort, 'Production does not reuse the Dev Home Node port');
    const prodHealth = await waitForHealth(crossPortMap.homeNode, value => value.environment === 'production', 20000)
      .catch(error => { throw new Error(error.message + '\n' + crossRunner.testOutput); });
    assert.strictEqual(prodHealth.dataDirectoryId, homeNodeIdentity.dataDirectoryId(prodHomeDir), 'Production Home Node opens only its isolated data directory');
    assert.notStrictEqual(prodHealth.dataDirectoryId, devNode.health.dataDirectoryId, 'the two environments expose different data-directory fingerprints');
    const stillDev = await request(devHomePort, '/health');
    assert.strictEqual(stillDev.status, 200, 'the Dev Home Node stays online during Production startup');
    assert.strictEqual(stillDev.body.pid, devPid, 'Production did not stop or replace the Dev process');
    await stopRunner(crossRunner, crossControlPort);
    assert.strictEqual((await request(devHomePort, '/health')).body.pid, devPid, 'Production shutdown leaves Dev Home Node running');
    await stopDirectHomeNode(devNode);
    devNode = null;

    /* Borrowing: the second same-instance Runner reuses the real Home Node and
       its shutdown must only stop children that second Runner spawned. */
    const borrowLocal = path.join(base, 'borrowed-service');
    fs.mkdirSync(borrowLocal, { recursive: true });
    const sharedHomeDir = path.join(borrowLocal, 'InternalBeyond', 'home-node');
    const ownerPorts = await distinctPorts();
    ownerControlPort = ownerPorts.restart;
    const ownerHomePort = await freePort(new Set(Object.values(ownerPorts)));
    ownerRunner = spawnRunner(productionEnv(borrowLocal, ownerPorts, ownerHomePort, sharedHomeDir), 'home-node-owner');
    const ownerMap = await runnerPortMap(ownerControlPort, 15000);
    const ownerHealth = await waitForHealth(ownerMap.homeNode, value => value.environment === 'production', 20000)
      .catch(error => { throw new Error(error.message + '\n' + ownerRunner.testOutput); });

    const borrowerPorts = await distinctPorts();
    borrowerControlPort = borrowerPorts.restart;
    const borrowerRunnerEnv = productionEnv(borrowLocal, borrowerPorts, ownerMap.homeNode, sharedHomeDir);
    borrowerRunner = spawnRunner(borrowerRunnerEnv, 'home-node-borrower');
    const borrowerMap = await runnerPortMap(borrowerControlPort, 15000);
    assert.strictEqual(borrowerMap.homeNode, ownerMap.homeNode, 'a same-instance Runner borrows the exact Home Node port');
    const borrowerView = await request(borrowerControlPort, '/components');
    const homeRow = borrowerView.body && borrowerView.body.components && borrowerView.body.components.find(row => row.id === 'homeNode');
    const homeService = borrowerView.body && borrowerView.body.services && borrowerView.body.services.find(row => row.componentId === 'homeNode');
    assert.ok(homeRow && homeRow.state === 'healthy' && /reused:/.test(homeRow.note || '') && homeService && homeService.owned === false,
      'borrowed Home Node is healthy but remains unowned by the second Runner');
    await stopRunner(borrowerRunner, borrowerControlPort);
    const afterBorrowerExit = await request(ownerMap.homeNode, '/health');
    assert.strictEqual(afterBorrowerExit.status, 200, 'borrower shutdown leaves the owner Home Node online');
    assert.strictEqual(afterBorrowerExit.body.pid, ownerHealth.pid, 'borrower shutdown does not kill or replace the owner PID');
    assert.strictEqual(afterBorrowerExit.body.dataDirectoryId, homeNodeIdentity.dataDirectoryId(sharedHomeDir));
    await stopRunner(ownerRunner, ownerControlPort);
    ownerRunner = null;
    assert.strictEqual((await request(ownerMap.homeNode, '/health')).status, 0, 'the owning Runner shuts down its own Home Node');

    console.log('Home Node Production/Dev isolation process test passed');
  } finally {
    await stopRunner(borrowerRunner, borrowerControlPort);
    await stopRunner(ownerRunner, ownerControlPort);
    await stopRunner(crossRunner, crossControlPort);
    await stopDirectHomeNode(devNode);
    /* All runner/service children above are test-owned and stopped before their
       disposable data trees are removed. */
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
