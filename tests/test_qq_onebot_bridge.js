'use strict';

const assert = require('assert');
const crypto = require('crypto');
const createQQOneBot = require('../services/home-node/qq-onebot.js');

async function main() {
  let now = 1000;
  let serial = 0;
  const bridge = createQQOneBot({
    desktopCredential: 'synthetic-home-node-credential',
    clock: () => now,
    randomId: () => 'request-' + (++serial)
  });
  const setupA = bridge.setup('12345678', 'http://127.0.0.1:23118');
  const setupB = bridge.setup('87654321', 'http://127.0.0.1:23118');
  assert.strictEqual(setupA.ok, true);
  assert.strictEqual(setupB.ok, true);
  assert.notStrictEqual(new URL(setupA.callbackUrl).searchParams.get('token'), new URL(setupB.callbackUrl).searchParams.get('token'));
  assert.strictEqual(bridge.setup('12345678', 'https://outside.example').error, 'loopback-base-required');

  const accountConfig = [
    { accountId: '12345678', roleId: 'role-a', takeover: true,
      allowedPrivateUserIds: ['23456789'], allowedGroupIds: ['34567890'] },
    { accountId: '87654321', roleId: 'role-b', takeover: true,
      allowedPrivateUserIds: ['98765432'], allowedGroupIds: ['76543210'] }
  ];
  const config = bridge.configure({ paused: false, accounts: accountConfig });
  assert.strictEqual(config.ok, true);
  const repeatedConfig = bridge.configure({ paused: false, accounts: accountConfig });
  assert.strictEqual(repeatedConfig.ok, true, 'reapplying the same account setup is idempotent');
  assert.deepStrictEqual(repeatedConfig.accounts.accounts.map(row => row.accountId), ['12345678', '87654321']);

  const tokenA = new URL(setupA.callbackUrl).searchParams.get('token');
  const protocolBody = Buffer.from('{"self_id":12345678,"post_type":"meta_event"}');
  const protocolSignature = 'sha1=' + crypto.createHmac('sha1', tokenA).update(protocolBody).digest('hex');
  assert.strictEqual(bridge.isCallbackSignature('12345678', protocolBody, protocolSignature), true,
    'OneBot 11 X-Signature is HMAC-SHA1 over the exact raw JSON bytes');
  assert.strictEqual(bridge.isCallbackSignature('12345678', protocolBody, 'sha1=' + '0'.repeat(40)), false);
  assert.strictEqual(bridge.isCallbackSignature('87654321', protocolBody, protocolSignature), false,
    'per-account callback signatures cannot cross accounts');
  const rejected = await bridge.receive('12345678', tokenA, {
    self_id: 12345678, post_type: 'message', message_type: 'private', sub_type: 'friend',
    user_id: 11111111, message_id: 1, message: [{ type: 'text', data: { text: 'not allowed' } }]
  });
  assert.deepStrictEqual(rejected, { ok: true, quickOperation: null });
  assert.strictEqual(bridge.poll().event, null, 'unapproved contacts do not enter the processing queue');

  const dmPromise = bridge.receive('12345678', tokenA, {
    self_id: 12345678, post_type: 'message', message_type: 'private', sub_type: 'friend',
    user_id: 23456789, message_id: 22, time: 1000,
    message: [{ type: 'text', data: { text: 'hello' } }]
  });
  const dm = bridge.poll().event;
  assert.strictEqual(dm.roleId, 'role-a');
  assert.strictEqual(dm.friendId, 'qq_12345678_23456789');
  assert.strictEqual(dm.conversationId, 'dm:qq_12345678_23456789');
  assert.strictEqual(dm.text, 'hello');
  assert.strictEqual(bridge.complete({ requestId: dm.requestId, reply: '你好 <CQ:at,qq=all>' }).replied, true);
  const dmResponse = await dmPromise;
  assert.deepStrictEqual(dmResponse.quickOperation, { reply: '你好 <CQ:at,qq=all>', auto_escape: true, at_sender: false });

  const noMentionPromise = bridge.receive('12345678', tokenA, {
    self_id: 12345678, post_type: 'message', message_type: 'group', sub_type: 'normal',
    group_id: 34567890, user_id: 23456789, message_id: 23,
    message: [{ type: 'text', data: { text: 'ordinary group message' } }]
  });
  assert.deepStrictEqual(await noMentionPromise, { ok: true, quickOperation: null });

  const groupPromise = bridge.receive('12345678', tokenA, {
    self_id: 12345678, post_type: 'message', message_type: 'group', sub_type: 'normal',
    group_id: 34567890, user_id: 23456789, message_id: 24,
    message: [
      { type: 'at', data: { qq: '12345678' } },
      { type: 'text', data: { text: ' answer please' } }
    ]
  });
  const group = bridge.poll().event;
  assert.strictEqual(group.friendId, 'group_qq_12345678_34567890');
  assert.strictEqual(group.conversationId, 'group:group_qq_12345678_34567890');
  assert.strictEqual(group.text, 'answer please');
  bridge.complete({ requestId: group.requestId, reply: '回复' });
  assert.strictEqual((await groupPromise).quickOperation.reply, '回复');

  const otherBotPromise = bridge.receive('12345678', tokenA, {
    self_id: 12345678, post_type: 'message', message_type: 'group', sub_type: 'normal',
    group_id: 34567890, user_id: 87654321, message_id: 25,
    message: [{ type: 'at', data: { qq: '12345678' } }, { type: 'text', data: { text: 'bot loop' } }]
  });
  assert.deepStrictEqual(await otherBotPromise, { ok: true, quickOperation: null }, 'managed QQ accounts cannot trigger each other');

  const wrongAccount = await bridge.receive('12345678', tokenA, {
    self_id: 87654321, post_type: 'message', message_type: 'private', user_id: 23456789,
    message_id: 26, message: 'mismatched account'
  });
  assert.deepStrictEqual(wrongAccount, { ok: true, quickOperation: null });
  assert.strictEqual((await bridge.receive('12345678', 'wrong-token', {})).error, 'unauthorized');

  const duplicateRole = bridge.configure({ paused: false, accounts: [
    { accountId: '12345678', roleId: 'same-role', takeover: true },
    { accountId: '87654321', roleId: 'same-role', takeover: true }
  ] });
  assert.strictEqual(duplicateRole.error, 'role-already-bound-to-active-account');

  const heartbeat = await bridge.receive('12345678', tokenA, {
    self_id: 12345678, post_type: 'meta_event', meta_event_type: 'heartbeat',
    status: { online: true }
  });
  assert.strictEqual(heartbeat.quickOperation, null);
  assert.strictEqual(bridge.status().accounts.find(row => row.accountId === '12345678').state, 'online');

  bridge.configure({ paused: true, accounts: accountConfig });
  const paused = await bridge.receive('12345678', tokenA, {
    self_id: 12345678, post_type: 'message', message_type: 'private', sub_type: 'friend',
    user_id: 23456789, message_id: 27, message: 'must stay manual'
  });
  assert.deepStrictEqual(paused, { ok: true, quickOperation: null });
  assert.strictEqual(bridge.poll().event, null);

  now += 180000;
  assert.strictEqual(bridge.status().accounts.find(row => row.accountId === '12345678').state, 'stale');
  assert.strictEqual(bridge.isReceivingEnabled('12345678'), false, 'an expired desktop lease stops event decoding');
  assert.strictEqual(bridge.heartbeat().clientActive, true, 'the desktop worker can renew its lease');
  const reconnected = await bridge.receive('12345678', tokenA, {
    self_id: 12345678, post_type: 'meta_event', meta_event_type: 'heartbeat',
    status: { online: true }
  });
  assert.strictEqual(reconnected.ok, true);
  assert.strictEqual(bridge.status().accounts.find(row => row.accountId === '12345678').state, 'online');
  bridge.close();
  console.log('QQ OneBot boundary checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
