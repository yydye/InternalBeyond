'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const homeNodeIdentity = require('../runtime/home-node-identity.js');
const devServiceContract = require('../runtime/dev-service-contract.js');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const { execFile } = require('child_process');


const RUNNER = path.join(ROOT, 'runtime', 'local-services-runner.js');
const runIdentity = devServiceContract.identityFromEnvironment(process.env);
const homeNodeInstanceId = homeNodeIdentity.instanceId(runIdentity.mode, ROOT, runIdentity.instanceId);
const homeNodeDataDirectoryId = homeNodeIdentity.dataDirectoryId(
  homeNodeIdentity.homeNodeDataDirectory(process.env, runIdentity));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function distinctFreePort(used) {
  let port = 0;
  do { port = await freePort(); } while (used.has(port));
  used.add(port);
  return port;
}

function healthServer(payload) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}

function runnerStatus(bridgePort, activePort, visionPort, homeNodePort) {
  return new Promise((resolve, reject) => {
    const args = [RUNNER, '--json'];
    if (visionPort) args.push('--vision');
    execFile(process.execPath, args, {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        IB_BRIDGE_PORT: String(bridgePort),
        IB_ACTIVE_PORT: String(activePort),
        IB_VISION_PORT: String(visionPort || 8765),
        IB_HOME_NODE_PORT: String(homeNodePort || 23118)
      }),
      encoding: 'utf8',
      timeout: 10000
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch (parseError) { reject(new Error('Invalid runner JSON: ' + stdout)); }
    });
  });
}

function runnerPrepare(homeNodePort, dataDirectory, extraEnv) {
  const script = [
    'const runner=require(' + JSON.stringify(RUNNER) + ');',
    'runner.prepareHomeNodePort().then(async result=>{const ports=runner.servicePorts();console.log(JSON.stringify({result,ports,env:runner.servicePortEnvironment(),bindable:await runner.portBindable(ports.homeNode)}))})',
    '.catch(error=>{console.error(error.stack||error);process.exitCode=1})'
  ].join(' ');
  const localAppData = path.dirname(path.dirname(dataDirectory));
  return new Promise((resolve, reject) => execFile(process.execPath, ['-e', script], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      LOCALAPPDATA: localAppData,
      IB_LOG_DIR: path.join(localAppData, 'logs'),
      IB_HOME_NODE_DATA_DIR: dataDirectory,
      IB_HOME_NODE_PORT: String(homeNodePort),
      IB_BRIDGE_PORT: String(23115),
      IB_ACTIVE_PORT: String(23114),
      IB_RESTART_PORT: String(23116),
      IB_DEV_MODE: '0'
    }, extraEnv || {}),
    encoding: 'utf8', timeout: 10000
  }, (error, stdout, stderr) => {
    if (error) { reject(new Error((stderr || stdout || error.message).trim())); return; }
    try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop())); }
    catch (parseError) { reject(new Error('Invalid runner prepare response: ' + stdout)); }
  }));
}

(async () => {
  const waitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-port-wait-test-'));
  const heldPortServer = healthServer({ ok: true, service: 'test-port-holder' });
  const heldPort = await listen(heldPortServer);
  const availablePort = await freePort();
  try {
    const waitScript = [
      'const runner=require(' + JSON.stringify(RUNNER) + ');',
      'Promise.all([runner.waitPortFree(' + heldPort + ',350),runner.waitPortFree(' + availablePort + ',350)])',
      '.then(([occupied,free])=>console.log(JSON.stringify({occupied,free})))',
      '.catch(error=>{console.error(error.stack||error);process.exitCode=1})'
    ].join(' ');
    const waitResult = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', waitScript], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        LOCALAPPDATA: waitRoot,
        IB_LOG_DIR: path.join(waitRoot, 'logs'),
        IB_DEV_MODE: '0'
      }),
      encoding: 'utf8', timeout: 4000
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || stdout || error.message).trim())); return; }
      try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop())); }
      catch (parseError) { reject(new Error('Invalid waitPortFree response: ' + stdout)); }
    }));
    assert.strictEqual(waitResult.occupied, false, 'an occupied port returns false at the original timeout');
    assert.strictEqual(waitResult.free, true, 'an unoccupied port is reported free immediately');
  } finally {
    await close(heldPortServer);
    fs.rmSync(waitRoot, { recursive: true, force: true });
  }

  const fakeBridge = healthServer({ ok: true, service: 'something-else' });
  const realActive = healthServer({ ok: true, service: 'internal-beyond-active-messages', version: 3 });
  const fakeVision = healthServer({ ok: true, model: 'not-internal-beyond' });
  const degradedHomeNode = healthServer({
    ok: false,
    service: 'internal-beyond-home-node',
    protocolVersion: homeNodeIdentity.HOME_NODE_PROTOCOL_VERSION,
    dataDirectoryId: homeNodeDataDirectoryId,
    environment: runIdentity.mode,
    devInstanceId: runIdentity.instanceId || null,
    instanceId: homeNodeInstanceId,
    role: 'canonical-chat-authority',
    open: false,
    serving: false,
    failure: { category: 'store-closed', message: 'test fixture only' }
  });
  const bridgePort = await listen(fakeBridge);
  const activePort = await listen(realActive);
  const visionPort = await listen(fakeVision);
  const homeNodePort = await listen(degradedHomeNode);
  try {
    const status = await runnerStatus(bridgePort, activePort, visionPort, homeNodePort);
    const bridge = status.services.find(item => item.name === 'Bridge');
    const active = status.services.find(item => item.name === 'Active');
    const vision = status.services.find(item => item.name === 'Vision');
    const homeNode = status.services.find(item => item.name === 'HomeNode');
    const homeNodeReport = (status.components || []).find(item => item.id === 'homeNode');
    assert.strictEqual(bridge.online, false, 'unrelated service must not be accepted as Bridge');
    assert.strictEqual(bridge.conflict, true, 'occupied port must be reported as a conflict');
    assert.strictEqual(active.online, true, 'matching Active health response should be accepted');
    assert.strictEqual(active.conflict, false);
    assert.strictEqual(vision.online, false, 'unrelated service must not be accepted as Vision');
    assert.strictEqual(vision.conflict, true, 'occupied Vision port must be reported as a conflict');
    assert.strictEqual(homeNode.online, false, 'a Home Node with a closed canonical store is not healthy');
    assert.strictEqual(homeNode.identityOk, true, 'ok:false does not erase the responding Home Node identity');
    assert.strictEqual(homeNode.dataDirectoryMatches, true, 'the observed Home Node is bound to the configured data directory');
    assert.strictEqual(homeNode.conflict, false, 'an unhealthy Home Node is not misreported as a foreign port occupant');
    assert.strictEqual(homeNode.unhealthy, true, 'the response distinguishes identity-correct but unhealthy state');
    assert.strictEqual(homeNodeReport.state, 'error', 'the component report preserves the Home Node store failure');
    assert.strictEqual(homeNodeReport.reason.category, 'store-closed');

    const healthyHomeNode = healthServer({
      ok: true,
      service: 'internal-beyond-home-node',
      protocolVersion: homeNodeIdentity.HOME_NODE_PROTOCOL_VERSION,
      dataDirectoryId: homeNodeDataDirectoryId,
      environment: runIdentity.mode,
      devInstanceId: runIdentity.instanceId || null,
      instanceId: homeNodeInstanceId,
      role: 'canonical-chat-authority',
      open: true,
      serving: true,
      revision: 0,
      messages: 0
    });
    const healthyPort = await listen(healthyHomeNode);
    try {
      const healthyStatus = await runnerStatus(bridgePort, activePort, visionPort, healthyPort);
      const healthyRow = healthyStatus.services.find(item => item.name === 'HomeNode');
      assert.strictEqual(healthyRow.online, true, 'a compatible healthy Home Node is reusable');
      assert.strictEqual(healthyRow.owned, false, 'a reused instance remains external to this runner');
    } finally { await close(healthyHomeNode); }

    const foreignListener = healthServer({ ok: true, service: 'unrelated-local-service' });
    const occupiedHomeNodePort = await listen(foreignListener);
    const isolatedDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-home-node-port-test-'));
    const usedPorts = new Set([occupiedHomeNodePort]);
    const bridgePortOverride = await distinctFreePort(usedPorts);
    const activePortOverride = await distinctFreePort(usedPorts);
    const restartPortOverride = await distinctFreePort(usedPorts);
    try {
      const script = [
        'const runner=require(' + JSON.stringify(RUNNER) + ');',
        'runner.prepareHomeNodePort().then(()=>Promise.all([runner.portBindable(runner.servicePorts().homeNode),Promise.resolve(runner.servicePorts()),Promise.resolve(runner.servicePortEnvironment())])).then(([bindable,ports,env])=>console.log(JSON.stringify({bindable,ports,env}))).catch(e=>{console.error(e.stack||e);process.exitCode=1})'
      ].join(' ');
      const result = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: Object.assign({}, process.env, {
          LOCALAPPDATA: isolatedDataRoot,
          IB_LOG_DIR: path.join(isolatedDataRoot, 'logs'),
          IB_HOME_NODE_PORT: String(occupiedHomeNodePort),
          IB_BRIDGE_PORT: String(bridgePortOverride),
          IB_ACTIVE_PORT: String(activePortOverride),
          IB_RESTART_PORT: String(restartPortOverride)
        }),
        encoding: 'utf8', timeout: 10000
      }, (error, stdout, stderr) => error ? reject(new Error((stderr || stdout || error.message).trim())) : resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop()))));
      assert.notStrictEqual(result.ports.homeNode, occupiedHomeNodePort, 'an incompatible Home Node occupant triggers an automatic fallback');
      assert.strictEqual(result.bindable, true, 'the negotiated fallback is free to bind');
      assert.strictEqual(result.env.homeNode, String(result.ports.homeNode));
      assert.strictEqual(result.env.bridge, String(result.ports.homeNode), 'Bridge receives the negotiated Home Node port');
      assert.strictEqual(foreignListener.listening, true, 'the unrelated listener is left untouched');
    } finally {
      await close(foreignListener);
      fs.rmSync(isolatedDataRoot, { recursive: true, force: true });
    }

    const collisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-home-node-identity-collision-'));
    const expectedDataDirectory = path.join(collisionRoot, 'InternalBeyond', 'home-node');
    const expectedDataId = homeNodeIdentity.dataDirectoryId(expectedDataDirectory);
    const otherDataDirectoryId = homeNodeIdentity.dataDirectoryId(path.join(collisionRoot, 'dev-sandbox', 'home-node'));
    const makeForeignHomeNode = payload => {
      const seen = [];
      const server = http.createServer((req, res) => {
        seen.push({ method: req.method, path: req.url });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
      return { server, seen };
    };
    const crossEnvFixture = makeForeignHomeNode({
      ok: true, service: 'internal-beyond-home-node', environment: 'dev',
      devInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', instanceId: 'a'.repeat(64),
      protocolVersion: homeNodeIdentity.HOME_NODE_PROTOCOL_VERSION,
      dataDirectoryId: otherDataDirectoryId, serving: true, pid: process.pid
    });
    const crossEnvPort = await listen(crossEnvFixture.server);
    try {
      const result = await runnerPrepare(crossEnvPort, expectedDataDirectory);
      assert.strictEqual(result.result.reused, false, 'an exact different-environment Home Node is never reused');
      assert.strictEqual(result.result.relocated, true, 'a known distinct Home Node data directory allows port fallback');
      assert.notStrictEqual(result.ports.homeNode, crossEnvPort, 'the Production Runner selects its own loopback port');
      assert.strictEqual(result.bindable, true, 'the fallback port can be bound independently');
      assert.deepStrictEqual(crossEnvFixture.seen, [{ method: 'GET', path: '/health' }], 'the other Home Node receives health inspection only');
    } finally { await close(crossEnvFixture.server); }

    const sameDataFixture = makeForeignHomeNode({
      ok: true, service: 'internal-beyond-home-node', environment: 'dev',
      devInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', instanceId: 'b'.repeat(64),
      protocolVersion: homeNodeIdentity.HOME_NODE_PROTOCOL_VERSION,
      dataDirectoryId: expectedDataId, serving: true, pid: process.pid
    });
    const sameDataPort = await listen(sameDataFixture.server);
    try {
      const result = await runnerPrepare(sameDataPort, expectedDataDirectory);
      assert.strictEqual(result.result.blocked, true, 'same data directory with another instance identity fails closed');
      assert.strictEqual(result.ports.homeNode, sameDataPort, 'no second Home Node is started against the occupied data directory');
      assert.deepStrictEqual(sameDataFixture.seen, [{ method: 'GET', path: '/health' }], 'same-directory conflict is not sent a stop or data request');
    } finally { await close(sameDataFixture.server); }

    const missingIdentityFixture = makeForeignHomeNode({
      ok: true, service: 'internal-beyond-home-node', environment: 'dev',
      protocolVersion: homeNodeIdentity.HOME_NODE_PROTOCOL_VERSION,
      dataDirectoryId: null, serving: true, pid: process.pid
    });
    const missingIdentityPort = await listen(missingIdentityFixture.server);
    try {
      const result = await runnerPrepare(missingIdentityPort, expectedDataDirectory);
      assert.strictEqual(result.result.blocked, true, 'missing data-directory identity cannot be treated as an empty or separate store');
      assert.strictEqual(result.ports.homeNode, missingIdentityPort, 'unknown separation does not start a second database owner');
      assert.deepStrictEqual(missingIdentityFixture.seen, [{ method: 'GET', path: '/health' }], 'missing-identity instance is only health-probed');
    } finally { await close(missingIdentityFixture.server); }
    fs.rmSync(collisionRoot, { recursive: true, force: true });
    console.log('Local services runner identity test passed ✔');
  } finally {
    await Promise.all([close(fakeBridge), close(realActive), close(fakeVision), close(degradedHomeNode)]);
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
