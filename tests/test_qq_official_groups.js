'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const createQQOfficialManager = require('../services/home-node/qq-official-manager.js');

class FakeBot extends EventEmitter {
  constructor() { super(); this.middlewares = []; this.sent = []; this.started = false; this.stopped = false; }
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
  start() { this.started = true; queueMicrotask(() => this.emit('ready', {})); return new Promise(resolve => { this.resolveStart = resolve; }); }
  stop() { this.stopped = true; if (this.resolveStart) this.resolveStart(); }
  async sendText(target, content) { this.sent.push({ kind: 'text', target: Object.assign({}, target), content }); return { id: 'group-text-' + this.sent.length }; }
  async sendImage(target, source, options) {
    this.sent.push({ kind: 'image', target: Object.assign({}, target), content: String(options && options.content || ''),
      mime: source.buffer[0] === 137 ? 'image/png' : 'unknown', bytes: source.buffer.length });
    return { upload: { file_info: 'mock-file-info' }, message: { id: 'group-image-' + this.sent.length } };
  }
}

function account(groups, takeover) {
  return { appId: 'group-test-app', roleId: 'role-private', allowedUserOpenIds: ['member-c2c'], takeover: takeover !== false,
    combinedIntentConsent: true, groups };
}

function groupMessage(groupOpenId, senderId, messageId, content, extra) {
  return Object.assign({
    kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderIsBot: false,
    groupOpenid: groupOpenId, senderId, senderName: senderId === 'member-a' ? 'Alice' : 'Bob',
    messageId, timestamp: '2026-10-16T12:00:00.000Z', content, attachments: [],
    mentions: [{ is_you: true }],
    replyTarget: { scope: 'group', targetId: groupOpenId, msgId: messageId }
  }, extra || {});
}

function c2cMessage(senderId, messageId) {
  return { kind: 'c2c', senderIsBot: false, senderId, messageId, timestamp: '2026-10-16T12:00:00.000Z',
    content: 'private message', attachments: [],
    replyTarget: { scope: 'c2c', targetId: senderId, msgId: messageId } };
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

async function replyWithText(manager, event, reply) {
  manager.progress({ requestId: event.requestId, stage: 'provider-started' });
  manager.progress({ requestId: event.requestId, stage: 'provider-ready' });
  return manager.complete({ requestId: event.requestId, reply });
}

async function main() {
  const groupA = 'group-open-a';
  const groupB = 'group-open-b';
  const groupManual = 'group-open-manual';
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const logged = [];
  const downloaded = [];
  const client = new FakeBot();
  const manager = createQQOfficialManager({
    dataDir: 'unused-group-mock',
    credentialResolver: { resolve: ref => ref === 'qqofficial:group-test-app' ? { provider: 'qqbot', apiKey: 'test-secret' } : null },
    createBot: async () => client,
    downloadImage: async attachment => { downloaded.push(attachment.url); return { buffer: Buffer.from(png), mime: 'image/png' }; },
    randomId: (() => { let id = 0; return () => 'group-request-' + (++id); })(),
    logger: (level, event, fields) => logged.push({ level, event, fields })
  });
  const bindings = [
    { groupOpenId: groupA, roleId: 'role-group-a', takeover: true },
    { groupOpenId: groupB, roleId: 'role-group-b', takeover: true },
    { groupOpenId: groupManual, roleId: '', takeover: false }
  ];
  const explicitlyAddedBindings = bindings.concat([{ groupOpenId: 'group-open-unauthorized', roleId: '', takeover: false }]);
  assert.equal((await manager.configure({ paused: false, accounts: [account(bindings)] })).ok, true);
  manager.heartbeat();
  assert.equal((await manager.connect({ appId: 'group-test-app' })).ok, true);
  await tick();
  assert.equal(client.started, true);

  const unmentionedReads = { group: 0, sender: 0, id: 0, content: 0, attachments: 0, msgElements: 0 };
  await client.deliver({
    kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', senderIsBot: false, mentions: [],
    get groupOpenid() { unmentionedReads.group++; return groupA; },
    get senderId() { unmentionedReads.sender++; return 'member-a'; },
    get messageId() { unmentionedReads.id++; return 'not-mentioned'; },
    get content() { unmentionedReads.content++; return 'ordinary group text'; },
    get attachments() { unmentionedReads.attachments++; return []; },
    get msgElements() { unmentionedReads.msgElements++; return []; }
  });
  assert.deepEqual(unmentionedReads, { group: 0, sender: 0, id: 0, content: 0, attachments: 0, msgElements: 0 },
    'ordinary non-@ group messages are dropped before reading group/member/message fields');
  assert.equal(manager.poll().event, null);

  const unapprovedReads = { sender: 0, id: 0, content: 0, attachments: 0, msgElements: 0 };
  const unauthorizedGroup = groupMessage('group-open-unauthorized', 'member-c2c', 'unauthorized-group-message', 'do not read');
  Object.defineProperties(unauthorizedGroup, {
    senderId: { get() { unapprovedReads.sender++; return 'member-c2c'; } },
    messageId: { get() { unapprovedReads.id++; return 'unauthorized-group-message'; } },
    content: { get() { unapprovedReads.content++; return 'do not read'; } },
    attachments: { get() { unapprovedReads.attachments++; return [{ url: 'https://private.invalid/image.png' }]; } },
    msgElements: { get() { unapprovedReads.msgElements++; return [{ attachments: [{ url: 'https://private.invalid/quoted.png' }] }]; } }
  });
  await client.deliver(unauthorizedGroup);
  assert.deepEqual(unapprovedReads, { sender: 0, id: 0, content: 0, attachments: 0, msgElements: 0 },
    'an unauthorized @ group only contributes its group OpenID for explicit authorization');
  assert.deepEqual(manager.status().accounts[0].pendingGroupOpenIds, ['group-open-unauthorized']);
  assert.deepEqual(manager.status().accounts[0].pendingUserOpenIds, [], 'group OpenID never enters the member allowlist');
  const unauthorizedGroupStage = logged.filter(row => row.event === 'qq-official-stage'
    && row.fields.stage === 'group-not-allowed').at(-1);
  assert.equal(unauthorizedGroupStage.fields.configuredGroupCount, bindings.length,
    'redacted diagnostics distinguish an empty group list from an OpenID mismatch');
  assert.equal(unauthorizedGroupStage.fields.pendingGroupCount, 1);

  const manualReads = { sender: 0, content: 0, attachments: 0, msgElements: 0 };
  const manualGroup = groupMessage(groupManual, 'member-a', 'manual-group', 'must remain unread');
  Object.defineProperties(manualGroup, {
    senderId: { get() { manualReads.sender++; return 'member-a'; } },
    content: { get() { manualReads.content++; return 'must remain unread'; } },
    attachments: { get() { manualReads.attachments++; return []; } },
    msgElements: { get() { manualReads.msgElements++; return []; } }
  });
  await client.deliver(manualGroup);
  assert.deepEqual(manualReads, { sender: 0, content: 0, attachments: 0, msgElements: 0 }, 'a listed manual group is not read for AI');
  assert.equal(manager.status().accounts[0].lastStage, 'group-manual');

  let invalidConfig = await manager.configure({ paused: false, accounts: [account([
    { groupOpenId: groupA, roleId: 'role-group-a', takeover: true },
    { groupOpenId: groupA, roleId: 'role-group-b', takeover: true }
  ])] });
  assert.deepEqual(invalidConfig, { ok: false, error: 'duplicate-group-openid' }, 'group bindings reject duplicate group identities');
  invalidConfig = await manager.configure({ paused: false, accounts: [account([
    { groupOpenId: groupA, roleId: '', takeover: true }
  ])] });
  assert.deepEqual(invalidConfig, { ok: false, error: 'group-role-required' }, 'group takeover cannot start without a role');

  assert.equal((await manager.configure({ paused: false, accounts: [account(explicitlyAddedBindings)] })).ok, true);
  manager.heartbeat();
  assert.deepEqual(manager.status().accounts[0].groups.map(row => row.roleId), ['role-group-a', 'role-group-b', '', '']);
  assert.equal(manager.status().accounts[0].pendingGroupOpenIds.includes('group-open-unauthorized'), false,
    'explicitly adding that exact group removes it from pending authorization');

  const selfEcho = groupMessage(groupA, 'robot-member', 'bot-self-echo', 'never read', { senderIsBot: true });
  Object.defineProperty(selfEcho, 'content', { get() { throw new Error('self echo content must not be read'); } });
  await client.deliver(selfEcho);
  assert.equal(manager.poll().event, null, 'bot-authored group events are dropped');

  const wrongPrivateTarget = groupMessage(groupA, 'member-a', 'wrong-scope', 'reply target must remain group', {
    replyTarget: { scope: 'c2c', targetId: 'member-a', msgId: 'wrong-scope' }
  });
  await client.deliver(wrongPrivateTarget);
  assert.equal(manager.poll().event, null, 'group messages cannot be redirected to a member C2C target');
  assert.equal(manager.status().accounts[0].lastStage, 'invalid-reply-target');

  const sharedMessageId = 'same-platform-message-id';
  await Promise.all([
    client.deliver(groupMessage(groupA, 'member-a', sharedMessageId, 'hello group A')),
    client.deliver(groupMessage(groupB, 'member-b', sharedMessageId, 'hello group B')),
    client.deliver(c2cMessage('member-c2c', sharedMessageId))
  ]);
  const concurrentEvents = [manager.poll().event, manager.poll().event, manager.poll().event];
  assert.equal(concurrentEvents.every(Boolean), true, 'two group messages and C2C can queue with the same message id');
  const eventA = concurrentEvents.find(event => event.groupOpenId === groupA);
  const eventB = concurrentEvents.find(event => event.groupOpenId === groupB);
  const eventC2c = concurrentEvents.find(event => event.messageType === 'private');
  assert.equal(eventA.roleId, 'role-group-a');
  assert.equal(eventB.roleId, 'role-group-b');
  assert.equal(eventA.peerId, groupA);
  assert.equal(eventB.peerId, groupB);
  assert.equal(eventA.senderId, 'member-a', 'member_openid stays the message sender identity');
  assert.equal(eventA.senderRef, eventA.senderRef.match(/^member-[a-f0-9]{12}$/) ? eventA.senderRef : '',
    'group speaker has a stable scoped identity without exposing a raw OpenID to the Provider');
  assert.equal(eventA.senderRef === eventB.senderRef, false, 'the same member is scoped independently per group');
  assert.equal(eventA.conversationId.includes(groupA), false, 'group conversation identifier does not reveal group OpenID');
  assert.notEqual(eventA.conversationId, eventB.conversationId, 'group conversation contexts are isolated');
  assert.notEqual(eventA.conversationId, eventC2c.conversationId, 'group and C2C contexts are isolated');
  assert.equal(eventA.peerId === eventA.senderId, false, 'group OpenID and member OpenID remain distinct');
  assert.deepEqual(await replyWithText(manager, eventA, 'reply A'), { ok: true, replied: true });
  assert.deepEqual(await replyWithText(manager, eventB, 'reply B'), { ok: true, replied: true });
  assert.deepEqual(await replyWithText(manager, eventC2c, 'private reply'), { ok: true, replied: true });
  assert.deepEqual(client.sent.slice(-3).map(row => row.target), [
    { scope: 'group', targetId: groupA, msgId: sharedMessageId },
    { scope: 'group', targetId: groupB, msgId: sharedMessageId },
    { scope: 'c2c', targetId: 'member-c2c', msgId: sharedMessageId }
  ], 'reply targets preserve each group and the separate C2C peer');
  const echoedMessage = groupMessage(groupA, 'bot-member-openid', 'group-text-1', 'bot echo');
  Object.defineProperty(echoedMessage, 'content', { get() { throw new Error('bot echo body must not be read'); } });
  await client.deliver(echoedMessage);
  assert.equal(manager.poll().event, null, 'a sent group message id is suppressed even without senderIsBot metadata');
  assert.equal(manager.status().accounts[0].lastStage, 'self-echo-dropped');

  await client.deliver(groupMessage(groupA, 'member-a', 'duplicate-group-message', 'once'));
  const duplicate = manager.poll().event;
  assert.ok(duplicate);
  manager.progress({ requestId: duplicate.requestId, stage: 'provider-started' });
  manager.progress({ requestId: duplicate.requestId, stage: 'provider-ready' });
  await manager.complete({ requestId: duplicate.requestId, reply: 'done' });
  await client.deliver(groupMessage(groupA, 'member-a', 'duplicate-group-message', 'repeat'));
  assert.equal(manager.poll().event, null, 'duplicate group message ids are ignored within the group scope');

  const image = groupMessage(groupA, 'member-a', 'group-image', 'What is in this picture?', {
    attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/group-image?token=secret-test', size: png.length }]
  });
  await client.deliver(image);
  await new Promise(resolve => setTimeout(resolve, 5));
  const imageEvent = manager.poll().event;
  assert.ok(imageEvent);
  assert.equal(imageEvent.messageType, 'group');
  assert.equal(imageEvent.text, 'What is in this picture?');
  assert.equal(Buffer.from(imageEvent.images[0].base64, 'base64').length, png.length, 'group image uses the P1 validated media loader');
  manager.progress({ requestId: imageEvent.requestId, stage: 'provider-started' });
  manager.progress({ requestId: imageEvent.requestId, stage: 'provider-ready' });
  await manager.complete({ requestId: imageEvent.requestId, reply: 'I see a test image.',
    images: [{ mime: 'image/png', base64: png.toString('base64') }] });
  const groupImageEchoId = 'group-image-' + client.sent.length;
  assert.deepEqual(client.sent.at(-1), {
    kind: 'image', target: { scope: 'group', targetId: groupA, msgId: 'group-image' },
    content: 'I see a test image.', mime: 'image/png', bytes: png.length
  }, 'the official SDK group reply target supports text-plus-image media replies');
  const quotedImageUrl = 'https://multimedia.nt.qq.com.cn/quoted-group-image?token=private-quoted-token';
  const quotedImage = groupMessage(groupA, 'member-a', 'group-quoted-image', 'What is in the image?', {
    refMsgIdx: 'quoted-group-image-ref', msgType: 103,
    msgElements: [{ msg_idx: 'quoted-group-image-ref', attachments: [
      { content_type: 'image/png', url: quotedImageUrl, size: png.length },
      { content_type: 'image/png', url: quotedImageUrl, size: png.length }
    ] }]
  });
  await client.deliver(quotedImage);
  await new Promise(resolve => setTimeout(resolve, 5));
  const quotedImageEvent = manager.poll().event;
  assert.ok(quotedImageEvent && quotedImageEvent.images.length === 1,
    'a mentioned reply can use the official SDK quoted image attachment when the original image message was not ingested');
  assert.equal(quotedImageEvent.text, 'What is in the image?');
  const quotedShape = logged.filter(row => row.event === 'qq-official-stage'
    && row.fields.stage === 'group-event-shape').at(-1).fields;
  assert.deepEqual({ direct: quotedShape.directAttachmentCount, elements: quotedShape.elementCount,
    nested: quotedShape.elementAttachmentCount, selected: quotedShape.selectedAttachmentCount,
    quoteReference: quotedShape.quoteReference, messageType: quotedShape.messageType }, {
    direct: 0, elements: 1, nested: 2, selected: 1, quoteReference: true, messageType: 103
  }, 'safe group diagnostics report attachment field counts without message text or identifiers');
  manager.progress({ requestId: quotedImageEvent.requestId, stage: 'provider-started' });
  manager.progress({ requestId: quotedImageEvent.requestId, stage: 'provider-ready' });
  await manager.complete({ requestId: quotedImageEvent.requestId, reply: 'The quoted image contains a test pattern.' });
  assert.equal(downloaded.filter(url => url === quotedImageUrl).length, 1,
    'quoted attachments are deduplicated before download without recording the signed URL');
  await client.deliver(groupMessage(groupA, 'bot-member-openid', groupImageEchoId, 'image bot echo'));
  assert.equal(manager.poll().event, null, 'group image replies are also tracked to suppress bot self echoes');
  assert.equal(downloaded.length, 2, 'only the direct @ image and explicitly quoted @ image are downloaded');

  const c2cUsingGroupOpenId = c2cMessage(groupA, 'identity-isolation-private');
  await client.deliver(c2cUsingGroupOpenId);
  assert.equal(manager.poll().event, null, 'a group OpenID does not authorize that identity as a C2C member');
  const groupUsingPrivateOpenId = groupMessage('group-open-untrusted', 'member-c2c', 'identity-isolation-group', 'not authorized');
  await client.deliver(groupUsingPrivateOpenId);
  assert.equal(manager.poll().event, null, 'a C2C member OpenID does not authorize a group');

  await manager.pause(true);
  const pausedReads = { sender: 0, message: 0, content: 0, attachments: 0, msgElements: 0 };
  const pausedGroup = groupMessage(groupA, 'member-a', 'paused-group', 'must not be read');
  Object.defineProperties(pausedGroup, {
    senderId: { get() { pausedReads.sender++; return 'member-a'; } },
    messageId: { get() { pausedReads.message++; return 'paused-group'; } },
    content: { get() { pausedReads.content++; return 'must not be read'; } },
    attachments: { get() { pausedReads.attachments++; return []; } },
    msgElements: { get() { pausedReads.msgElements++; return []; } }
  });
  await client.deliver(pausedGroup);
  assert.deepEqual(pausedReads, { sender: 0, message: 0, content: 0, attachments: 0, msgElements: 0 }, 'global pause rejects group messages before member or body access');
  assert.equal(manager.poll().event, null);
  await manager.pause(false);

  await client.deliver(groupMessage(groupA, 'member-a', 'stop-group-pending', 'wait'));
  const pending = manager.poll().event;
  assert.ok(pending);
  await manager.disconnect('group-test-app');
  const lateReply = await manager.complete({ requestId: pending.requestId, reply: 'late' });
  assert.equal(lateReply.ok, false, 'stopping the official account blocks late group replies');
  assert.equal(client.sent.some(row => row.target.msgId === 'stop-group-pending'), false);
  assert.equal(JSON.stringify(logged).includes('group-open-unauthorized'), false, 'group identifiers never enter diagnostic logs');
  assert.equal(JSON.stringify(logged).includes('private message'), false, 'message content never enters diagnostic logs');
  assert.equal(JSON.stringify(logged).includes('secret-test'), false, 'signed image URLs never enter diagnostic logs');
  assert.equal(JSON.stringify(logged).includes('private-quoted-token'), false, 'quoted signed image URLs never enter diagnostic logs');
  await manager.close();
  console.log('QQ Official group authorization, @ gating, isolation, images, and stop checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
