'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const createQQOfficialManager = require('../services/home-node/qq-official-manager.js');

class FakeBot extends EventEmitter {
  constructor() { super(); this.middlewares = []; this.sent = []; }
  use(fn) { this.middlewares.push(fn); return this; }
  start() { queueMicrotask(() => this.emit('ready', {})); return new Promise(resolve => { this.finish = resolve; }); }
  stop() { if (this.finish) this.finish(); }
  async sendText(target, content) { this.sent.push({ target, content }); return { id: 'sent-' + this.sent.length }; }
  async sendImage() { throw new Error('not used'); }
  async deliver(message) {
    const context = { message };
    let index = 0;
    const next = async () => {
      const middleware = this.middlewares[index++];
      if (middleware) return middleware(context, next);
      this.emit('message', context, message);
    };
    await next();
  }
}

const c2c = (userOpenId, messageId, text) => ({
  kind: 'c2c', senderId: userOpenId, messageId, content: text, attachments: [], senderIsBot: false,
  replyTarget: { scope: 'c2c', targetId: userOpenId, msgId: messageId }
});

const group = (groupOpenId, memberOpenId, messageId, text) => ({
  kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid: groupOpenId,
  senderId: memberOpenId, messageId, content: text, attachments: [], senderIsBot: false,
  mentions: [{ is_you: true }],
  replyTarget: { scope: 'group', targetId: groupOpenId, msgId: messageId }
});

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

async function main() {
  const client = new FakeBot();
  const diagnosticLogs = [];
  const base = {
    appId: 'command-manager-app', roleId: 'role-default', takeover: true,
    allowedUserOpenIds: ['user-a', 'user-b'], combinedIntentConsent: true,
    privateRoleSelections: [
      { userOpenId: 'user-a', roleId: 'role-alpha', sessionId: 'session-alpha' },
      { userOpenId: 'user-b', roleId: 'role-beta', sessionId: 'session-beta' }
    ],
    groups: [
      { groupOpenId: 'group-a', roleId: 'role-group-a', takeover: true,
        adminMemberOpenIds: ['member-admin-a'], sessionId: 'session-group-a' },
      { groupOpenId: 'group-b', roleId: 'role-group-b', takeover: true,
        adminMemberOpenIds: [], sessionId: 'session-group-b' }
    ]
  };
  const manager = createQQOfficialManager({
    dataDir: 'unused-qq-commands-manager',
    credentialResolver: { resolve: () => ({ provider: 'qqbot', apiKey: 'fake-only' }) },
    createBot: async () => client,
    randomId: (() => { let value = 0; return () => 'command-request-' + (++value); })(),
    logger: (level, event, fields) => diagnosticLogs.push({ level, event, fields })
  });
  assert.equal((await manager.configure({ paused: false, accounts: [base] })).ok, true);
  manager.heartbeat();
  assert.equal((await manager.connect({ appId: base.appId })).ok, true);
  await tick();

  await Promise.all([
    client.deliver(c2c('user-a', 'private-a', 'hello')),
    client.deliver(c2c('user-b', 'private-b', 'hello')),
    client.deliver(group('group-a', 'member-admin-a', 'group-a-admin', '/who')),
    client.deliver(group('group-a', 'member-ordinary', 'group-a-member', '/who')),
    client.deliver(group('group-b', 'member-admin-a', 'group-b-admin', '/who'))
  ]);
  const events = [];
  for (let index = 0; index < 5; index++) events.push(manager.poll().event);
  assert.equal(events.every(Boolean), true);
  const privateA = events.find(event => event.messageId === 'private-a');
  const privateB = events.find(event => event.messageId === 'private-b');
  assert.equal(privateA.roleId, 'role-alpha');
  assert.equal(privateA.sessionId, 'session-alpha');
  assert.equal(privateB.roleId, 'role-beta');
  assert.equal(privateB.sessionId, 'session-beta');
  const groupAdmin = events.find(event => event.messageId === 'group-a-admin');
  const groupMember = events.find(event => event.messageId === 'group-a-member');
  const groupB = events.find(event => event.messageId === 'group-b-admin');
  assert.equal(groupAdmin.canManageConversation, true, 'IB explicitly listed group member can manage the shared conversation');
  assert.equal(groupMember.canManageConversation, false, 'ordinary member can query but receives no management capability');
  assert.equal(groupB.canManageConversation, false, 'same member is not an admin in another group');
  assert.equal(groupB.sessionId, 'session-group-b');
  assert.deepEqual(manager.status().accounts[0].groups[0].pendingAdminMemberOpenIds, ['member-ordinary'],
    'only authorized, mentioned group members can be explicitly offered for IB admin consent');
  const groupShapeLogs = diagnosticLogs.filter(row => row.event === 'qq-official-stage'
    && row.fields && row.fields.stage === 'group-event-shape');
  assert.equal(groupShapeLogs.find(row => row.fields.groupAdminMatch === true).fields.groupAdminCount, 1,
    'diagnostics report only the configured group admin count and whether this sender matched');
  assert.equal(groupShapeLogs.find(row => row.fields.groupAdminCount === 0).fields.groupAdminMatch, false,
    'an unconfigured group member is reported as a boolean mismatch');
  assert.equal(JSON.stringify(groupShapeLogs).includes('member-admin-a'), false,
    'group admin diagnostics never include member OpenIDs');

  await manager.complete({ requestId: groupAdmin.requestId, reply: 'who' });
  await manager.complete({ requestId: groupMember.requestId, reply: 'who' });
  await manager.complete({ requestId: groupB.requestId, reply: 'who' });

  await Promise.all([
    client.deliver(c2c('user-a', 'pending-a', 'old role request')),
    client.deliver(c2c('user-b', 'pending-b', 'other user request'))
  ]);
  const pendingA = manager.poll().event;
  const pendingB = manager.poll().event;
  assert.equal(pendingA.messageId, 'pending-a');
  assert.equal(pendingB.messageId, 'pending-b');
  const changedPrivate = Object.assign({}, base, {
    privateRoleSelections: [
      { userOpenId: 'user-a', roleId: 'role-new', sessionId: 'session-new' },
      { userOpenId: 'user-b', roleId: 'role-beta', sessionId: 'session-beta' }
    ]
  });
  assert.equal((await manager.configure({ paused: false, accounts: [changedPrivate] })).ok, true);
  const stalePrivate = await manager.complete({ requestId: pendingA.requestId, reply: 'must be suppressed' });
  assert.deepEqual(stalePrivate, { ok: false, error: 'request-not-pending' },
    'switching one private user invalidates their old Provider request');
  assert.deepEqual(await manager.complete({ requestId: pendingB.requestId, reply: 'user B stays active' }),
    { ok: true, replied: true }, 'one private user role switch does not cancel another user session');
  assert.equal(client.sent.some(row => row.target.msgId === 'pending-a'), false);

  await Promise.all([
    client.deliver(group('group-a', 'member-admin-a', 'pending-group-a', 'old group role request')),
    client.deliver(group('group-b', 'member-admin-a', 'pending-group-b', 'other group request'))
  ]);
  const pendingGroupA = manager.poll().event;
  const pendingGroupB = manager.poll().event;
  const changedGroups = changedPrivate.groups.map(row => row.groupOpenId === 'group-a'
    ? Object.assign({}, row, { roleId: 'role-group-a2', sessionId: 'session-group-a2' }) : row);
  assert.equal((await manager.configure({ paused: false, accounts: [Object.assign({}, changedPrivate, { groups: changedGroups })] })).ok, true);
  assert.deepEqual(await manager.complete({ requestId: pendingGroupA.requestId, reply: 'stale group A' }),
    { ok: false, error: 'request-not-pending' }, 'group role switch suppresses only that group pending reply');
  assert.deepEqual(await manager.complete({ requestId: pendingGroupB.requestId, reply: 'group B stays active' }),
    { ok: true, replied: true });
  assert.equal(client.sent.some(row => row.target.msgId === 'pending-group-a'), false);

  await manager.close();
  console.log('QQ Official per-user/group role-session and explicit command-admin checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
