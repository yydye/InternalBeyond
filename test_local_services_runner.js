'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const RUNNER = path.join(__dirname, 'local-services-runner.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function healthServer(payload) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}

function runnerStatus(bridgePort, activePort, visionPort) {
  return new Promise((resolve, reject) => {
    const args = [RUNNER, '--json'];
    if (visionPort) args.push('--vision');
    execFile(process.execPath, args, {
      cwd: __dirname,
      env: Object.assign({}, process.env, {
        IB_BRIDGE_PORT: String(bridgePort),
        IB_ACTIVE_PORT: String(activePort),
        IB_VISION_PORT: String(visionPort || 8765)
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

(async () => {
  const fakeBridge = healthServer({ ok: true, service: 'something-else' });
  const realActive = healthServer({ ok: true, service: 'internal-beyond-active-messages', version: 3 });
  const fakeVision = healthServer({ ok: true, model: 'not-internal-beyond' });
  const bridgePort = await listen(fakeBridge);
  const activePort = await listen(realActive);
  const visionPort = await listen(fakeVision);
  try {
    const status = await runnerStatus(bridgePort, activePort, visionPort);
    const bridge = status.services.find(item => item.name === 'Bridge');
    const active = status.services.find(item => item.name === 'Active');
    const vision = status.services.find(item => item.name === 'Vision');
    assert.strictEqual(bridge.online, false, 'unrelated service must not be accepted as Bridge');
    assert.strictEqual(bridge.conflict, true, 'occupied port must be reported as a conflict');
    assert.strictEqual(active.online, true, 'matching Active health response should be accepted');
    assert.strictEqual(active.conflict, false);
    assert.strictEqual(vision.online, false, 'unrelated service must not be accepted as Vision');
    assert.strictEqual(vision.conflict, true, 'occupied Vision port must be reported as a conflict');
    console.log('Local services runner identity test passed ✔');
  } finally {
    await Promise.all([close(fakeBridge), close(realActive), close(fakeVision)]);
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
