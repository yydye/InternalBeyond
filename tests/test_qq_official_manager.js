'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createCredentialVault = require('../active/credential-vault.js');
const createCredentialResolver = require('../active/credential-resolver.js');
const createQQOfficialManager = require('../services/home-node/qq-official-manager.js');

class FakeBot extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.started = false;
    this.stopped = false;
    this.sent = [];
    this.startResolve = null;
    this.middlewares = [];
  }

  use(middleware) { this.middlewares.push(middleware); return this; }

  async deliver(message) {
    const context = { message };
    let index = 0;
    const next = async () => {
      const middleware = this.middlewares[index++];
      if (middleware) return middleware(context, next);
      return this.emit('message', context, context.message);
    };
    await next();
  }

  start() {
    this.started = true;
    queueMicrotask(() => this.emit('ready', {}));
    return new Promise(resolve => { this.startResolve = resolve; });
  }

  stop() {
    this.stopped = true;
    if (this.startResolve) this.startResolve();
  }

  async sendText(target, content) {
    this.sent.push({ target: Object.assign({}, target), content: String(content) });
    return { id: 'mock-out-' + this.sent.length };
  }

  async sendImage(target, source, options) {
    this.sent.push({ target: Object.assign({}, target), content: String(options && options.content || ''),
      mime: source.buffer[0] === 137 ? 'image/png' : 'unknown', bytes: source.buffer.length });
    return { id: 'mock-media-out-' + this.sent.length };
  }
}

function account(appId, roleId, allowedUserOpenIds, takeover) {
  return { appId, roleId, allowedUserOpenIds, takeover: takeover === true, combinedIntentConsent: true };
}

function c2cMessage(senderId, messageId, text, extra) {
  return Object.assign({
    kind: 'c2c',
    senderId,
    senderIsBot: false,
    messageId,
    timestamp: '2026-10-15T12:00:00.000Z',
    content: text,
    attachments: [],
    replyTarget: { scope: 'c2c', targetId: senderId, msgId: messageId }
  }, extra || {});
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

async function main() {
  const sdkBot = await createQQOfficialManager.createSDKBot({ appId: 'mock-sdk-app', appSecret: 'not-a-real-secret' });
  assert.equal(typeof sdkBot.on, 'function');
  assert.equal(typeof sdkBot.start, 'function');
  assert.equal(typeof sdkBot.sendText, 'function');
  assert.equal(typeof sdkBot.sendImage, 'function', 'the pinned Tencent SDK exposes its official media send API');
  assert.equal(typeof sdkBot.stop, 'function');
  sdkBot.stop();

  const clients = new Map();
  const logged = [];
  const downloadedUrls = [];
  const pngFixture = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let failImageDownload = false;
  let imageDownloadFailure = null;
  const resolver = {
    resolve: ref => /^qqofficial:/.test(String(ref))
      ? { provider: 'qqbot', apiKey: 'mock-app-secret-' + String(ref).split(':')[1] }
      : null
  };
  const manager = createQQOfficialManager({
    dataDir: 'unused-in-mock',
    credentialResolver: resolver,
    randomId: (() => { let n = 0; return () => 'request-' + (++n); })(),
    downloadImage: async attachment => {
      downloadedUrls.push(String(attachment.url || ''));
      if (failImageDownload) throw imageDownloadFailure || Object.assign(new Error('private URL and image detail'), { code: 'image-download-failed' });
      return { buffer: Buffer.from(pngFixture), mime: 'image/png' };
    },
    createBot: async options => {
      const bot = new FakeBot(options);
      clients.set(options.appId, bot);
      return bot;
    },
    logger: (level, event, fields) => logged.push({ level, event, fields })
  });

  const initial = await manager.configure({
    paused: true,
    accounts: [
      account('mock-app-a', 'role-a', ['user-open-a'], false),
      account('mock-app-b', 'role-b', ['user-open-b'], false)
    ]
  });
  assert.equal(initial.ok, true);
  assert.equal(initial.paused, true);
  assert.equal(manager.status().accounts.length, 2, 'multiple official bots have separate account rows');
  assert.equal(manager.status().accounts[0].accountId, 'qqofficial_mock-app-a');
  assert.equal(manager.status().accounts[0].roleId, 'role-a');

  const unconsented = account('mock-unconsented', 'role-a', [], false);
  unconsented.combinedIntentConsent = false;
  await manager.configure({ paused: true, accounts: [
    account('mock-app-a', 'role-a', ['user-open-a'], false),
    account('mock-app-b', 'role-b', ['user-open-b'], false),
    unconsented
  ] });
  assert.deepEqual(await manager.connect({ appId: 'mock-unconsented' }),
    { ok: false, error: 'combined-intent-consent-required' }, 'the SDK combined intent cannot start without explicit consent');
  await manager.configure({ paused: true, accounts: [
    account('mock-app-a', 'role-a', ['user-open-a'], false),
    account('mock-app-b', 'role-b', ['user-open-b'], false)
  ] });

  const missingVault = createQQOfficialManager({
    dataDir: 'unused-in-mock',
    credentialResolver: { resolve: () => null },
    createBot: async () => { throw new Error('must not construct without a Vault secret'); }
  });
  await missingVault.configure({ paused: true, accounts: [account('mock-missing', 'role-a', [], false)] });
  const missingSecret = await missingVault.connect({ appId: 'mock-missing' });
  assert.deepEqual(missingSecret, { ok: false, error: 'credential-vault-unavailable' });
  await missingVault.close();

  assert.equal((await manager.connect({ appId: 'mock-app-a' })).ok, true);
  assert.equal((await manager.connect({ appId: 'mock-app-b' })).ok, true);
  await tick();
  assert.equal(clients.get('mock-app-a').started, true);
  assert.equal(clients.get('mock-app-b').started, true);
  assert.deepEqual(manager.status().accounts.map(row => row.state), ['online', 'online']);
  const connectedLog = logged.find(row => row.event === 'qq-official-stage' && row.fields.stage === 'websocket-connected');
  assert.ok(connectedLog, 'the bounded, redacted log confirms the Gateway handshake after reconnect');
  assert.equal(Object.prototype.hasOwnProperty.call(connectedLog.fields, 'code'), false,
    'successful Gateway stages do not get a misleading request-timeout code');

  clients.get('mock-app-a').emit('disconnected', { code: 1006, willReconnect: true });
  assert.equal(manager.status().accounts[0].state, 'reconnecting', 'official SDK disconnect state is visible');
  clients.get('mock-app-a').emit('resumed', {});
  assert.equal(manager.status().accounts[0].state, 'online', 'official SDK resume returns the account to connected');

  const unauthorizedReads = { content: 0, messageId: 0, attachments: 0 };
  const unauthorized = {
    kind: 'c2c',
    senderId: 'user-not-allowed',
    senderIsBot: false,
    get messageId() { unauthorizedReads.messageId++; return 'untrusted-message'; },
    get content() { unauthorizedReads.content++; return 'untrusted body'; },
    get attachments() { unauthorizedReads.attachments++; return []; }
  };
  await clients.get('mock-app-a').deliver(unauthorized);
  assert.deepEqual(unauthorizedReads, { content: 0, messageId: 0, attachments: 0 },
    'unauthorized C2C events expose only the OpenID needed for explicit consent');
  assert.deepEqual(manager.status().accounts[0].pendingUserOpenIds, ['user-not-allowed']);
  assert.equal(downloadedUrls.length, 0, 'unauthorized image attachments are never downloaded');

  const groupReads = { groupOpenid: 0, senderId: 0, content: 0, attachments: 0 };
  const group = {
    kind: 'group',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    mentions: [],
    senderIsBot: false,
    get groupOpenid() { groupReads.groupOpenid++; return 'group-open-not-mentioned'; },
    get senderId() { groupReads.senderId++; return 'group-user'; },
    get content() { groupReads.content++; return 'group body'; },
    get attachments() { groupReads.attachments++; return []; }
  };
  await clients.get('mock-app-a').deliver(group);
  assert.deepEqual(groupReads, { groupOpenid: 0, senderId: 0, content: 0, attachments: 0 },
    'unmentioned group events are rejected before group, member, body, or attachment access');

  const selfEchoReads = { content: 0 };
  const selfEcho = {
    kind: 'c2c', senderId: 'user-open-a', senderIsBot: true,
    get content() { selfEchoReads.content++; return 'echo'; }
  };
  await clients.get('mock-app-a').deliver(selfEcho);
  assert.equal(selfEchoReads.content, 0, 'bot self-echo never enters the conversation bridge');

  await manager.configure({
    paused: false,
    accounts: [
      account('mock-app-a', 'role-a', ['user-open-a'], false),
      account('mock-app-b', 'role-b', ['user-open-b'], false)
    ]
  });
  const manualReads = { content: 0, messageId: 0 };
  const manual = {
    kind: 'c2c', senderId: 'user-open-a', senderIsBot: false,
    get messageId() { manualReads.messageId++; return 'manual-message'; },
    get content() { manualReads.content++; return 'manual only'; }
  };
  await clients.get('mock-app-a').deliver(manual);
  assert.deepEqual(manualReads, { content: 0, messageId: 0 }, 'manual account connections do not read C2C content');

  await manager.configure({
    paused: false,
    accounts: [
      account('mock-app-a', 'role-a', ['user-open-a'], true),
      account('mock-app-b', 'role-b', ['user-open-b'], true)
    ]
  });
  manager.heartbeat();
  let aMessage = c2cMessage('user-open-a', 'message-a-1', 'hello role A');
  await clients.get('mock-app-a').deliver(aMessage);
  await clients.get('mock-app-a').deliver(aMessage);
  const polledA = manager.poll();
  assert.equal(polledA.event.appId, 'mock-app-a');
  assert.equal(polledA.event.accountId, 'qqofficial_mock-app-a');
  assert.equal(polledA.event.roleId, 'role-a');
  assert.equal(polledA.event.friendId.startsWith('qqofficial_'), true, 'official history uses a platform-specific namespace');
  assert.equal(manager.status().accounts[0].lastStage, 'delivered-to-ui', 'status records the Home Node to UI handoff');
  assert.equal(manager.poll().event, null, 'duplicate event id is suppressed');

  assert.deepEqual(manager.progress({ requestId: polledA.event.requestId, stage: 'provider-ready' }),
    { ok: false, error: 'invalid-stage-transition' }, 'diagnostic stages cannot skip Provider execution');
  assert.deepEqual(manager.progress({ requestId: polledA.event.requestId, stage: 'provider-started' }),
    { ok: true, stage: 'provider-started' });
  assert.deepEqual(manager.progress({ requestId: polledA.event.requestId, stage: 'provider-failed', errorCode: 'arbitrary exception text' }),
    { ok: false, error: 'invalid-request' }, 'diagnostic error text is rejected unless it is an allowlisted code');
  assert.deepEqual(manager.progress({ requestId: polledA.event.requestId, stage: 'provider-ready' }),
    { ok: true, stage: 'provider-ready' });

  const firstSend = await manager.complete({ requestId: polledA.event.requestId, reply: 'reply for role A' });
  assert.equal(firstSend.ok, true);
  assert.equal(manager.status().accounts[0].lastStage, 'send-succeeded', 'successful send API completion is observable');
  assert.deepEqual(manager.status().accounts[0].diagnostics, {
    nonC2cDropped: 0, selfEchoDropped: 1, openIdDenied: 1,
    globalPaused: 0, accountManual: 1, workerInactive: 0,
    groupNoMention: 1, groupNotAllowed: 0, groupManual: 0, groupPaused: 0,
    imageDownloadFailed: 0,
    eventsQueued: 1, eventsDeliveredToUi: 1,
    providerStarted: 1, providerReady: 1, providerFailed: 0,
    sendStarted: 1, sendSucceeded: 1, sendFailed: 0,
    mediaSendStarted: 0, mediaSendSucceeded: 0, mediaSendFailed: 0,
    queueTimeouts: 0, clientTimeouts: 0, providerTimeouts: 0
  }, 'diagnostic counters distinguish filtering, UI delivery, Provider and send stages');
  assert.equal(clients.get('mock-app-a').sent.length, 1);
  assert.equal(clients.get('mock-app-a').sent[0].target.scope, 'c2c');
  assert.equal(clients.get('mock-app-a').sent[0].target.msgId, 'message-a-1');
  assert.equal(clients.get('mock-app-b').sent.length, 0, 'one bot cannot send through another bot identity');

  const imageMessage = c2cMessage('user-open-a', 'message-image-a', 'What is in this photo?', {
    attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/download?token=private-image-token', size: pngFixture.length }]
  });
  await clients.get('mock-app-a').deliver(imageMessage);
  await new Promise(resolve => setTimeout(resolve, 5));
  const imageEvent = manager.poll().event;
  assert.ok(imageEvent, 'an authorized C2C image enters the existing bounded queue');
  assert.equal(imageEvent.text, 'What is in this photo?');
  assert.deepEqual(Array.from(imageEvent.images, image => ({
    mime: image.mime, bytes: Buffer.from(image.base64, 'base64').length
  })), [{ mime: 'image/png', bytes: pngFixture.length }], 'the queued event contains validated bytes, not the signed source URL');
  manager.progress({ requestId: imageEvent.requestId, stage: 'provider-started' });
  manager.progress({ requestId: imageEvent.requestId, stage: 'provider-ready' });
  const imageReply = await manager.complete({ requestId: imageEvent.requestId, reply: 'It is a test image.',
    images: [{ mime: 'image/png', base64: pngFixture.toString('base64') }] });
  assert.deepEqual(imageReply, { ok: true, replied: true });
  assert.deepEqual(clients.get('mock-app-a').sent[1], {
    target: { scope: 'c2c', targetId: 'user-open-a', msgId: 'message-image-a' },
    content: 'It is a test image.', mime: 'image/png', bytes: pngFixture.length
  }, 'the official SDK media method sends an image as a passive C2C reply');
  assert.equal(manager.status().accounts[0].lastStage, 'media-send-succeeded', 'image replies have a distinct success stage');
  assert.equal(manager.status().accounts[0].diagnostics.mediaSendSucceeded, 1);
  assert.equal(downloadedUrls.length, 1);
  assert.equal(JSON.stringify(logged).includes('private-image-token'), false, 'signed attachment URLs never enter logs');
  assert.equal(JSON.stringify(logged).includes(pngFixture.toString('base64')), false, 'image bytes never enter logs');
  failImageDownload = true;
  const failedImage = c2cMessage('user-open-a', 'message-image-download-failed', 'please read this', {
    attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/download?token=failed-private-token' }]
  });
  await clients.get('mock-app-a').deliver(failedImage);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(manager.poll().event, null, 'failed image downloads do not enter the Provider queue');
  assert.equal(manager.status().accounts[0].lastStage, 'image-download-failed');
  assert.equal(manager.status().accounts[0].lastError, 'image-download-failed');
  failImageDownload = false;
  assert.equal(JSON.stringify(logged).includes('failed-private-token'), false, 'failed attachment URLs never enter logs');

  failImageDownload = true;
  imageDownloadFailure = Object.assign(new Error('private response body and URL'), { code: 'image-http-rejected', httpStatus: 403 });
  await clients.get('mock-app-a').deliver(c2cMessage('user-open-a', 'message-image-http-rejected', '', {
    attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/download?token=private-http-token' }]
  }));
  await tick();
  const imageFailureStatus = manager.status().accounts[0];
  assert.equal(imageFailureStatus.lastError, 'image-http-rejected', 'safe image HTTP error category is preserved in status');
  assert.equal(imageFailureStatus.lastImageHttpStatus, 403, 'numeric image-source HTTP status is exposed for UI diagnosis');
  const imageFailureLog = logged.filter(entry => entry.event === 'qq-official-stage'
    && entry.fields.stage === 'image-download-failed').at(-1);
  assert.equal(imageFailureLog.fields.code, 'image-http-rejected');
  assert.equal(imageFailureLog.fields.httpStatus, 403);
  assert.equal(JSON.stringify(imageFailureLog).includes('private-http-token'), false, 'image diagnostics never log signed URLs');
  assert.equal(JSON.stringify(imageFailureLog).includes('private response body'), false, 'image diagnostics never log remote response bodies');
  failImageDownload = false;
  imageDownloadFailure = null;

  const failedProviderMessage = c2cMessage('user-open-a', 'message-provider-failed', 'provider failure fixture');
  await clients.get('mock-app-a').deliver(failedProviderMessage);
  const failedProviderEvent = manager.poll().event;
  assert.ok(failedProviderEvent);
  manager.progress({ requestId: failedProviderEvent.requestId, stage: 'provider-started' });
  assert.equal(manager.progress({ requestId: failedProviderEvent.requestId, stage: 'provider-failed', errorCode: 'provider-failed' }).ok, true);
  await manager.complete({ requestId: failedProviderEvent.requestId, reply: '' });
  assert.equal(manager.status().accounts[0].lastStage, 'provider-failed');
  assert.equal(manager.status().accounts[0].lastError, 'provider-failed');
  assert.equal(clients.get('mock-app-a').sent.length, 2, 'Provider failure does not call QQ send API');

  const failedSendMessage = c2cMessage('user-open-a', 'message-send-failed', 'send failure fixture');
  await clients.get('mock-app-a').deliver(failedSendMessage);
  const failedSendEvent = manager.poll().event;
  assert.ok(failedSendEvent);
  manager.progress({ requestId: failedSendEvent.requestId, stage: 'provider-started' });
  manager.progress({ requestId: failedSendEvent.requestId, stage: 'provider-ready' });
  const originalSend = clients.get('mock-app-a').sendText;
  clients.get('mock-app-a').sendText = async () => { throw Object.assign(new Error('redact this response body'), { httpStatus: 403, bizCode: 12345 }); };
  const sendFailure = await manager.complete({ requestId: failedSendEvent.requestId, reply: 'reply rejected' });
  clients.get('mock-app-a').sendText = originalSend;
  assert.deepEqual(sendFailure, { ok: false, error: 'official-app-not-authorized' }, 'QQ send HTTP status is reduced to a safe error code');
  assert.equal(manager.status().accounts[0].lastStage, 'send-failed');
  assert.equal(manager.status().accounts[0].lastError, 'official-app-not-authorized');
  assert.equal(manager.status().accounts[0].lastApiHttpStatus, 403, 'the SDK HTTP response status is visible');
  assert.equal(manager.status().accounts[0].lastApiBusinessCode, 12345, 'the SDK business code is visible without response text');
  assert.equal(JSON.stringify(logged).includes('"httpStatus":403'), true, 'redacted stage logs include the actual HTTP status');
  assert.equal(JSON.stringify(logged).includes('"businessCode":12345'), true, 'redacted stage logs include the safe numeric QQ business code');
  assert.equal(JSON.stringify(logged).includes('redact this response body'), false, 'send API response text is never logged');
  assert.equal(JSON.stringify(logged).includes('user-open-a'), false, 'OpenID never enters diagnostic logs');
  assert.equal(JSON.stringify(logged).includes('user-not-allowed'), false, 'pending consent OpenIDs never enter diagnostic logs');
  assert.equal(JSON.stringify(logged).includes('hello role A'), false, 'C2C message text never enters diagnostic logs');

  const bMessage = c2cMessage('user-open-b', 'message-b-1', 'hello role B');
  await clients.get('mock-app-b').deliver(bMessage);
  const polledB = manager.poll();
  assert.equal(polledB.event.appId, 'mock-app-b');
  assert.equal(polledB.event.roleId, 'role-b');

  await manager.pause(true);
  const pausedReads = { content: 0, messageId: 0 };
  const paused = {
    kind: 'c2c', senderId: 'user-open-a', senderIsBot: false,
    get messageId() { pausedReads.messageId++; return 'paused-message'; },
    get content() { pausedReads.content++; return 'must stay unread'; }
  };
  await clients.get('mock-app-a').deliver(paused);
  assert.deepEqual(pausedReads, { content: 0, messageId: 0 }, 'global pause rejects before reading message details');
  assert.equal((await manager.complete({ requestId: polledB.event.requestId, reply: 'late reply' })).ok, false,
    'pause cancels outstanding provider replies');
  assert.equal(clients.get('mock-app-b').sent.length, 0);

  await manager.pause(false);
  const pending = c2cMessage('user-open-a', 'stop-message', 'waiting for provider');
  await clients.get('mock-app-a').deliver(pending);
  const polledPending = manager.poll();
  assert.ok(polledPending.event);
  await manager.disconnect('mock-app-a');
  assert.equal(clients.get('mock-app-a').stopped, true);
  assert.equal((await manager.complete({ requestId: polledPending.event.requestId, reply: 'late after stop' })).ok, false,
    'stopping while Provider work is pending prevents a late send');
  assert.equal(clients.get('mock-app-a').sent.length, 2);
  assert.equal(manager.status().accounts[0].state, 'stopped');
  assert.equal(JSON.stringify(logged).includes('mock-app-secret'), false, 'logs do not contain AppSecret');
  assert.equal(JSON.stringify(manager.status()).includes('request-'), false, 'opaque request ids are not exposed in status');

  await manager.configure({ paused: true, accounts: [account('mock-app-b', 'role-b', ['user-open-b'], false)] });
  assert.deepEqual(manager.status().accounts.map(row => row.appId), ['mock-app-b'], 'removing a Bot drops its account status');
  await manager.configure({ paused: true, accounts: [
    account('mock-app-b', 'role-b', ['user-open-b'], false),
    account('mock-app-a', 'role-a', ['user-open-a'], false)
  ] });
  assert.deepEqual(manager.status().accounts[1].pendingUserOpenIds, [], 'removed OpenID consent candidates do not survive re-add');

  const badCredentialManager = createQQOfficialManager({
    dataDir: 'unused-in-mock',
    credentialResolver: resolver,
    createBot: async () => ({
      on() { return this; }, stop() {}, sendText() { return Promise.resolve(); }, sendImage() { return Promise.resolve(); },
      start() { return Promise.reject(Object.assign(new Error('token rejected'), { httpStatus: 401 })); }
    }),
    logger: () => {}
  });
  await badCredentialManager.configure({ paused: true, accounts: [account('mock-bad-secret', 'role-x', [], false)] });
  await badCredentialManager.connect({ appId: 'mock-bad-secret' });
  await tick();
  assert.equal(badCredentialManager.status().accounts[0].lastError, 'official-invalid-credentials');
  await badCredentialManager.close();

  await manager.close();
  assert.deepEqual(manager.status().accounts, []);

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-qq-official-vault-mock-'));
  try {
    const vault = createCredentialVault({ dataDir: vaultDir });
    vault.load();
    assert.equal(vault.upsert('qqofficial:mock-vault-app', {
      provider: 'qqbot', apiKey: 'mock-vault-app-secret', endpoint: '', model: ''
    }), true, 'the existing Credential Vault stores the mock Bot secret');
    const resolvedSecrets = [];
    const vaultManager = createQQOfficialManager({
      dataDir: vaultDir,
      createBot: async options => {
        resolvedSecrets.push(options.appSecret);
        return new FakeBot(options);
      },
      logger: () => {}
    });
    await vaultManager.configure({ paused: true, accounts: [account('mock-vault-app', 'role-vault', [], false)] });
    assert.equal((await vaultManager.connect({ appId: 'mock-vault-app' })).ok, true);
    await tick();
    assert.deepEqual(resolvedSecrets, ['mock-vault-app-secret'], 'Home Node resolves the existing encrypted Vault entry only at connect');
    assert.equal(JSON.stringify(vaultManager.status()).includes('mock-vault-app-secret'), false,
      'the status projection never returns the secret');
    await vaultManager.close();
  } finally {
    const resolvedTemp = path.resolve(os.tmpdir()) + path.sep;
    const resolvedVault = path.resolve(vaultDir);
    if (resolvedVault.startsWith(resolvedTemp) && path.basename(resolvedVault).startsWith('ib-qq-official-vault-mock-')) {
      fs.rmSync(resolvedVault, { recursive: true, force: true });
    }
  }
  console.log('QQ Official manager Mock checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
