'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const homeNodeService = require('../services/home-node-service.js');

function send(port, pathname, method, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: Object.assign({
        'X-IB-Protocol': '1',
        'X-IB-Test-Host-Identity': 'valid',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      }, headers || {})
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-qq-official-home-node-'));
  const desktopToken = 'mock-home-node-desktop-token';
  const calls = [];
  const official = {
    configure: async input => { calls.push(['configure', input]); return { ok: true, paused: input.paused, accounts: [] }; },
    connect: async input => { calls.push(['connect', input]); return { ok: true, accountId: 'qqofficial_' + input.appId, state: 'connecting' }; },
    disconnect: async appId => { calls.push(['disconnect', appId]); return { ok: true, accountId: 'qqofficial_' + appId, state: 'stopped' }; },
    status: () => ({ ok: true, paused: true, clientActive: false, accounts: [] }),
    heartbeat: () => ({ ok: true, clientActive: true, leaseMs: 12000 }),
    poll: () => ({ ok: true, event: null }),
    progress: input => { calls.push(['progress', input]); return { ok: true, stage: input.stage }; },
    complete: async input => { calls.push(['complete', input]); return { ok: true, replied: false }; },
    close: () => { calls.push(['close']); }
  };
  const runtime = homeNodeService.buildHomeNode({
    dataDir,
    credentialDataDir: dataDir,
    token: desktopToken,
    qqOfficial: official,
    authorizeRequestIdentity: request => request.headers['x-ib-test-host-identity'] === 'valid',
    logger: () => {}
  });
  const server = runtime.server;
  try {
    runtime.open();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const headers = { 'X-IB-Home-Token': desktopToken };

    const denied = await send(port, '/internal/qq-official/v1/status', 'GET');
    assert.equal(denied.status, 401, 'the official adapter does not bypass desktop authentication');
    const deniedIdentity = await send(port, '/internal/qq-official/v1/heartbeat', 'POST', {},
      { 'X-IB-Home-Token': desktopToken, 'X-IB-Test-Host-Identity': 'invalid' });
    assert.equal(deniedIdentity.status, 403, 'official transport writes keep the existing Dev Host identity check');
    assert.equal(deniedIdentity.body.error, 'environment-identity-mismatch');
    const deniedProgressIdentity = await send(port, '/internal/qq-official/v1/progress', 'POST', {
      requestId: 'mock', stage: 'provider-started'
    }, { 'X-IB-Home-Token': desktopToken, 'X-IB-Test-Host-Identity': 'invalid' });
    assert.equal(deniedProgressIdentity.status, 403, 'diagnostic writes keep the existing Dev Host identity check');
    assert.equal(calls.some(row => row[0] === 'progress'), false, 'unauthorized diagnostic writes never reach the manager');

    const status = await send(port, '/internal/qq-official/v1/status', 'GET', undefined, headers);
    assert.equal(status.status, 200);
    assert.equal(status.body.paused, true);

    const configured = await send(port, '/internal/qq-official/v1/config', 'POST', {
      paused: true,
      accounts: [{ appId: 'mock-app', roleId: 'role-a', takeover: false, allowedUserOpenIds: ['open-a'] }]
    }, headers);
    assert.equal(configured.status, 200);
    assert.equal(calls[0][0], 'configure');
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0][1].accounts[0], 'appSecret'), false,
      'Home Node config routes never accept AppSecret');

    const connected = await send(port, '/internal/qq-official/v1/connect', 'POST', { appId: 'mock-app' }, headers);
    assert.equal(connected.status, 200);
    assert.equal(calls[1][0], 'connect');
    assert.deepEqual(calls[1][1], { appId: 'mock-app' }, 'the only connection input is non-secret AppID');

    const polled = await send(port, '/internal/qq-official/v1/poll', 'POST', { waitMs: 0 }, headers);
    assert.equal(polled.status, 200);
    assert.equal(polled.body.event, null);
    const invalidProgress = await send(port, '/internal/qq-official/v1/progress', 'POST', {
      requestId: 'mock', stage: 'provider-started', message: 'must not be accepted'
    }, headers);
    assert.equal(invalidProgress.status, 400, 'progress route rejects arbitrary message data');
    const invalidProgressError = await send(port, '/internal/qq-official/v1/progress', 'POST', {
      requestId: 'mock', stage: 'provider-started', errorCode: 'not allowed here'
    }, headers);
    assert.equal(invalidProgressError.status, 400, 'error codes are accepted only on provider-failed stages');
    const progress = await send(port, '/internal/qq-official/v1/progress', 'POST', {
      requestId: 'mock', stage: 'provider-started'
    }, headers);
    assert.equal(progress.status, 200);
    assert.deepEqual(calls.find(row => row[0] === 'progress')[1], { requestId: 'mock', stage: 'provider-started' });
    const completed = await send(port, '/internal/qq-official/v1/complete', 'POST', { requestId: 'mock', reply: '' }, headers);
    assert.equal(completed.status, 200);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const completedWithImage = await send(port, '/internal/qq-official/v1/complete', 'POST', {
      requestId: 'mock-image', reply: 'caption', images: [{ mime: 'image/png', base64: png.toString('base64') }]
    }, headers);
    assert.equal(completedWithImage.status, 200, 'authorized passive replies can carry a bounded image payload');
    assert.deepEqual(calls.filter(row => row[0] === 'complete').pop()[1], {
      requestId: 'mock-image', reply: 'caption', images: [{ mime: 'image/png', base64: png.toString('base64') }]
    });
    const invalidImageReply = await send(port, '/internal/qq-official/v1/complete', 'POST', {
      requestId: 'mock-image-invalid', reply: 'caption', images: [{ mime: 'image/svg+xml', base64: 'PHN2Zz4=' }]
    }, headers);
    assert.equal(invalidImageReply.status, 400, 'the authenticated media route rejects unapproved image types');
    const disconnected = await send(port, '/internal/qq-official/v1/disconnect', 'POST', { appId: 'mock-app' }, headers);
    assert.equal(disconnected.status, 200);
    assert.equal(calls.some(row => row[0] === 'disconnect' && row[1] === 'mock-app'), true);
  } finally {
    const closed = server.listening ? new Promise(resolve => server.once('close', resolve)) : Promise.resolve();
    runtime.close();
    await closed;
    const resolvedRoot = path.resolve(os.tmpdir()) + path.sep;
    const resolvedDir = path.resolve(dataDir);
    if (resolvedDir.startsWith(resolvedRoot) && path.basename(resolvedDir).startsWith('ib-qq-official-home-node-')) {
      fs.rmSync(resolvedDir, { recursive: true, force: true });
    }
  }
  assert.equal(calls.some(row => row[0] === 'close'), true, 'Home Node teardown closes the official manager');
  console.log('QQ Official Home Node HTTP Mock checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
