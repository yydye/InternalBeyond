'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const homeNodeService = require('../services/home-node-service.js');
const QQCore = require('../assets/js/qq-onebot-core.js');

function send(port, path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path, method,
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

function sendNapCatEvent(port, callback, event, token, options) {
  options = options || {};
  const payload = Buffer.from(JSON.stringify(event));
  const headers = {
    'Content-Type': 'application/json',
    'x-self-id': options.selfId === undefined ? String(event.self_id) : String(options.selfId)
  };
  if (options.signature !== null) {
    headers['x-signature'] = options.signature === undefined
      ? 'sha1=' + crypto.createHmac('sha1', token).update(payload).digest('hex')
      : String(options.signature);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: callback.pathname + callback.search, method: 'POST', headers }, res => {
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
    req.end(payload);
  });
}

async function main() {
  const desktopToken = 'synthetic-home-node-token';
  const tempRoot = os.tmpdir();
  const dataDir = fs.mkdtempSync(path.join(tempRoot, 'ib-qq-onebot-home-node-'));
  const napcatCalls = [];
  let fakeDownloadStatus = { ok: true, state: 'verified', active: false, receivedBytes: 1024, totalBytes: 1024, speedBytesPerSecond: 0, etaSeconds: null };
  const fakeNapcat = {
    environment: () => ({ ok: true, supported: true, canWrite: true, platform: 'win32', architecture: 'x64', destination: 'available', existingQQScanned: false }),
    latestRelease: async () => ({ ok: true, release: { tag: 'v4.18.38', releaseUrl: 'https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.38', assetName: 'NapCat.Shell.Windows.Node.zip', size: 1024, sha256: 'a'.repeat(64) } }),
    downloadStatus: () => Object.assign({}, fakeDownloadStatus),
    startDownload: async input => { napcatCalls.push(['download', input]); return input && input.confirmed ? { ok: true, started: true } : { ok: false, error: 'download-confirmation-required' }; },
    cancelDownload: () => { napcatCalls.push(['cancel']); return { ok: true, cancelling: true }; },
    openDownloadFolder: async () => { napcatCalls.push(['open']); return { ok: true, opened: true }; },
    removeVerifiedArchive: input => { napcatCalls.push(['remove', input]); return input && input.confirmed ? { ok: true, removed: 'NapCat.Shell.Windows.Node.zip', installedAccountsPreserved: true } : { ok: false, error: 'removal-confirmation-required' }; },
    statusAccount: async accountId => ({ ok: true, accountId, installed: true, running: false, state: 'stopped' }),
    startAccount: async input => { napcatCalls.push(['start-account', input]); return input && input.confirmed ? { ok: true, started: true } : { ok: false, error: 'start-confirmation-required' }; },
    cancelAccountStart: accountId => { napcatCalls.push(['cancel-account', accountId]); return { ok: true, cancelling: true }; },
    stopAccount: accountId => { napcatCalls.push(['stop-account', accountId]); return { ok: true, stopping: true }; },
    openWebUi: async accountId => { napcatCalls.push(['webui', accountId]); return { ok: true, opened: true }; },
    close: () => {}
  };
  const runtime = homeNodeService.buildHomeNode({ dataDir, credentialDataDir: dataDir, token: desktopToken, qqNapcat: fakeNapcat,
    authorizeRequestIdentity: request => request.headers['x-ib-test-host-identity'] === 'valid', logger: () => {} });
  const server = runtime.server;
  try {
    runtime.open();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const homeTokenHeaders = { 'X-IB-Home-Token': desktopToken };
    assert.strictEqual(typeof runtime.qqOnebot.isCallbackToken, 'function');

    const unauthenticated = await send(port, '/internal/qq-onebot/v1/status', 'GET');
    assert.strictEqual(unauthenticated.status, 401);
    const unauthenticatedNapcat = await send(port, '/internal/qq-onebot/v1/napcat/environment', 'GET');
    assert.strictEqual(unauthenticatedNapcat.status, 401, 'installer management inherits desktop-token authentication');
    const unauthenticatedAccount = await send(port, '/internal/qq-onebot/v1/napcat/account/status?accountId=12345678', 'GET');
    assert.strictEqual(unauthenticatedAccount.status, 401, 'runtime controls inherit desktop-token authentication');
    const deniedHostIdentity = await send(port, '/internal/qq-onebot/v1/heartbeat', 'POST', {}, {
      'X-IB-Home-Token': desktopToken, 'X-IB-Test-Host-Identity': 'missing'
    });
    assert.strictEqual(deniedHostIdentity.status, 403, 'Dev service identity remains required for ordinary Home Node writes');
    assert.strictEqual(deniedHostIdentity.body.error, 'environment-identity-mismatch');

    const environment = await send(port, '/internal/qq-onebot/v1/napcat/environment', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(environment.status, 200);
    assert.strictEqual(environment.body.existingQQScanned, false);
    const releaseInfo = await send(port, '/internal/qq-onebot/v1/napcat/release', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(releaseInfo.body.release.tag, 'v4.18.38');
    const packageStatus = await send(port, '/internal/qq-onebot/v1/napcat/download/status', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(packageStatus.body.state, 'verified');
    fakeDownloadStatus = { ok: true, state: 'downloading', active: true, receivedBytes: 512, totalBytes: 1024, speedBytesPerSecond: 128, etaSeconds: 4, resumeAvailable: true };
    const livePackageStatus = await send(port, '/internal/qq-onebot/v1/napcat/download/status', 'GET', undefined, homeTokenHeaders);
    assert.deepStrictEqual({
      state: livePackageStatus.body.state, active: livePackageStatus.body.active,
      receivedBytes: livePackageStatus.body.receivedBytes, totalBytes: livePackageStatus.body.totalBytes,
      speedBytesPerSecond: livePackageStatus.body.speedBytesPerSecond, etaSeconds: livePackageStatus.body.etaSeconds,
      resumeAvailable: livePackageStatus.body.resumeAvailable
    }, { state: 'downloading', active: true, receivedBytes: 512, totalBytes: 1024, speedBytesPerSecond: 128, etaSeconds: 4, resumeAvailable: true });
    const refusedDownload = await send(port, '/internal/qq-onebot/v1/napcat/download', 'POST', { confirmed: false }, homeTokenHeaders);
    assert.strictEqual(refusedDownload.status, 400);
    const startedDownload = await send(port, '/internal/qq-onebot/v1/napcat/download', 'POST', {
      confirmed: true, tag: 'v4.18.38', sha256: 'a'.repeat(64)
    }, homeTokenHeaders);
    assert.strictEqual(startedDownload.status, 200);
    await send(port, '/internal/qq-onebot/v1/napcat/download/cancel', 'POST', {}, homeTokenHeaders);
    await send(port, '/internal/qq-onebot/v1/napcat/open-folder', 'POST', {}, homeTokenHeaders);
    const removeDownload = await send(port, '/internal/qq-onebot/v1/napcat/download/remove', 'POST', { confirmed: true }, homeTokenHeaders);
    assert.strictEqual(removeDownload.body.installedAccountsPreserved, true);
    const runtimeStatus = await send(port, '/internal/qq-onebot/v1/napcat/account/status?accountId=12345678', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(runtimeStatus.body.state, 'stopped');
    const refusedStart = await send(port, '/internal/qq-onebot/v1/napcat/account/start', 'POST', {
      accountId: '12345678', callbackUrl: 'http://127.0.0.1:23118/qq/onebot/v11/12345678?token=synthetic', confirmed: false
    }, homeTokenHeaders);
    assert.strictEqual(refusedStart.status, 400);
    const startedAccount = await send(port, '/internal/qq-onebot/v1/napcat/account/start', 'POST', {
      accountId: '12345678', callbackUrl: 'http://127.0.0.1:23118/qq/onebot/v11/12345678?token=synthetic', confirmed: true
    }, homeTokenHeaders);
    assert.strictEqual(startedAccount.status, 200);
    await send(port, '/internal/qq-onebot/v1/napcat/account/cancel', 'POST', { accountId: '12345678' }, homeTokenHeaders);
    await send(port, '/internal/qq-onebot/v1/napcat/account/stop', 'POST', { accountId: '12345678' }, homeTokenHeaders);
    await send(port, '/internal/qq-onebot/v1/napcat/account/open-webui', 'POST', { accountId: '12345678' }, homeTokenHeaders);
    assert.deepStrictEqual(napcatCalls.map(call => call[0]), ['download', 'download', 'cancel', 'open', 'remove', 'start-account', 'start-account', 'cancel-account', 'stop-account', 'webui']);
    assert.strictEqual(napcatCalls[5][1].confirmed, false);
    assert.strictEqual(napcatCalls[6][1].confirmed, true);
    assert.strictEqual(napcatCalls[0][1].confirmed, false);
    assert.strictEqual(napcatCalls[1][1].confirmed, true);

    const setup = await send(port, '/internal/qq-onebot/v1/setup', 'POST', {
    accountId: '12345678', baseUrl: 'http://127.0.0.1:' + port
  }, homeTokenHeaders);
    assert.strictEqual(setup.status, 200);
    assert.strictEqual(setup.body.ok, true);
    const callback = new URL(setup.body.callbackUrl);

    const configured = await send(port, '/internal/qq-onebot/v1/config', 'POST', {
    paused: false,
    accounts: [{
      accountId: '12345678', roleId: 'role-a', takeover: true,
      allowedPrivateUserIds: ['23456789'], allowedGroupIds: ['34567890']
    }]
  }, homeTokenHeaders);
    assert.strictEqual(configured.status, 200);
    assert.strictEqual(configured.body.ok, true);
    const lease = await send(port, '/internal/qq-onebot/v1/heartbeat', 'POST', {}, homeTokenHeaders);
    assert.strictEqual(lease.status, 200);
    assert.strictEqual(lease.body.clientActive, true);

    const badToken = await send(port, callback.pathname + '?token=wrong', 'POST', {
    self_id: 12345678, post_type: 'message', message_type: 'private', user_id: 23456789,
    message_id: 1, message: 'should not pass'
  });
    assert.strictEqual(badToken.status, 403);
    const badTokenStatus = await send(port, '/internal/qq-onebot/v1/status', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(badTokenStatus.body.accounts[0].callbackAuthError, 'callback-token-invalid');

    const signedEvent = {
      self_id: 12345678, post_type: 'message', message_type: 'private', sub_type: 'friend',
      user_id: 23456789, message_id: 1000, message: [{ type: 'text', data: { text: 'signed event' } }]
    };
    const missingSignature = await sendNapCatEvent(port, callback, signedEvent, callback.searchParams.get('token'), { signature: null });
    assert.strictEqual(missingSignature.status, 403, 'OneBot HTTP events require the standard HMAC header');
    assert.strictEqual(missingSignature.body.error, 'qq-onebot-signature-invalid');
    const missingSignatureStatus = await send(port, '/internal/qq-onebot/v1/status', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(missingSignatureStatus.body.accounts[0].callbackAuthError, 'signature-missing');
    const invalidSignature = await sendNapCatEvent(port, callback, signedEvent, callback.searchParams.get('token'), { signature: 'sha1=' + '0'.repeat(40) });
    assert.strictEqual(invalidSignature.status, 403);
    const wrongSelfId = await sendNapCatEvent(port, callback, signedEvent, callback.searchParams.get('token'), { selfId: '87654321' });
    assert.strictEqual(wrongSelfId.status, 403, 'the signed OneBot self ID is scoped to the account URL');

    const webhookPromise = sendNapCatEvent(port, callback, {
    self_id: 12345678, post_type: 'message', message_type: 'private', sub_type: 'friend',
    user_id: 23456789, message_id: 1001,
    message: [{ type: 'text', data: { text: 'synthetic inbound' } }]
  }, callback.searchParams.get('token'));
    await new Promise(resolve => setTimeout(resolve, 20));
    const poll = await send(port, '/internal/qq-onebot/v1/poll', 'POST', { waitMs: 0 }, homeTokenHeaders);
    assert.strictEqual(poll.status, 200);
    assert.strictEqual(poll.body.event.text, 'synthetic inbound');
    assert.strictEqual(poll.body.event.accountId, '12345678');
    const memoryRequests = [];
    const fakeProvider = QQCore.createConversationAdapter({
    storage: { getItem: () => null, setItem: () => {} },
    getRoleConfig: async roleId => ({ id: roleId, systemPrompt: 'synthetic persona' }),
    buildContext: async (role, event, history) => {
      memoryRequests.push(QQCore.memoryRecallRequest(event, history));
      return { system: role.systemPrompt, tail: 'PUBLIC_MEMORY_CONTEXT' };
    },
    generate: async (_role, messages, options) => {
      assert.strictEqual(options.disableTools, true);
      assert.strictEqual(options._noWebSearch, true);
      assert.strictEqual(messages.some(message => String(message.content).includes('PUBLIC_MEMORY_CONTEXT')), true);
      return 'fake provider reply';
    }
    });
    const generated = await fakeProvider.reply(poll.body.event);
    assert.strictEqual(generated.ok, true);
    assert.strictEqual(memoryRequests[0].isGroup, true, 'QQ contact receives only Memory public-visible context');
    assert.strictEqual(memoryRequests[0].characterId, 'role-a');
    const complete = await send(port, '/internal/qq-onebot/v1/complete', 'POST', {
    requestId: poll.body.event.requestId, reply: generated.reply
  }, homeTokenHeaders);
    assert.strictEqual(complete.body.replied, true);
    fakeProvider.commit(generated);
    const webhook = await webhookPromise;
    assert.strictEqual(webhook.status, 200);
    assert.deepStrictEqual(webhook.body, { reply: 'fake provider reply', auto_escape: true, at_sender: false });
    const authenticatedStatus = await send(port, '/internal/qq-onebot/v1/status', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(authenticatedStatus.body.accounts[0].callbackAuthError, '', 'a valid signed callback clears the authentication error');

    const paused = await send(port, '/internal/qq-onebot/v1/config', 'POST', {
    paused: true,
    accounts: [{
      accountId: '12345678', roleId: 'role-a', takeover: true,
      allowedPrivateUserIds: ['23456789'], allowedGroupIds: ['34567890']
    }]
  }, homeTokenHeaders);
    assert.strictEqual(paused.body.paused, true);
    const beforePausedCallback = await send(port, '/internal/qq-onebot/v1/status', 'GET', undefined, homeTokenHeaders);
    const noReply = await sendNapCatEvent(port, callback, {
    self_id: 12345678, post_type: 'message', message_type: 'private', sub_type: 'friend',
    user_id: 23456789, message_id: 1002, message: 'paused event'
  }, callback.searchParams.get('token'));
    assert.strictEqual(noReply.status, 204);
    const afterPausedCallback = await send(port, '/internal/qq-onebot/v1/status', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(afterPausedCallback.body.accounts[0].lastEventAt, beforePausedCallback.body.accounts[0].lastEventAt,
      'global pause drains the callback without decoding the event body');

    await send(port, '/internal/qq-onebot/v1/config', 'POST', {
      paused: false,
      accounts: [{ accountId: '12345678', roleId: 'role-a', takeover: false,
        allowedPrivateUserIds: [], allowedGroupIds: [] }]
    }, homeTokenHeaders);
    const manualBefore = await send(port, '/internal/qq-onebot/v1/status', 'GET', undefined, homeTokenHeaders);
    const manualCallback = await sendNapCatEvent(port, callback, {
      self_id: 12345678, post_type: 'message', message_type: 'private', sub_type: 'friend',
      user_id: 23456789, message_id: 1003, message: 'manual account event'
    }, callback.searchParams.get('token'));
    const manualAfter = await send(port, '/internal/qq-onebot/v1/status', 'GET', undefined, homeTokenHeaders);
    assert.strictEqual(manualCallback.status, 204);
    assert.strictEqual(manualAfter.body.accounts[0].lastEventAt, manualBefore.body.accounts[0].lastEventAt,
      'manual accounts do not decode posted message events');

    console.log('QQ OneBot Home Node HTTP checks passed');
  } finally {
    const closed = server.listening ? new Promise(resolve => server.once('close', resolve)) : Promise.resolve();
    runtime.close();
    await closed;
    const resolvedRoot = path.resolve(tempRoot) + path.sep;
    const resolvedDir = path.resolve(dataDir);
    if (resolvedDir.startsWith(resolvedRoot) && path.basename(resolvedDir).startsWith('ib-qq-onebot-home-node-')) {
      fs.rmSync(resolvedDir, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
