'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const createQQOfficialManager = require('../services/home-node/qq-official-manager.js');
const QQ = require('../assets/js/qq-onebot-core.js');

class FakeBot extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.middlewares = [];
    this.sent = [];
    this.startResolve = null;
  }
  use(middleware) { this.middlewares.push(middleware); return this; }
  start() {
    queueMicrotask(() => this.emit('ready', {}));
    return new Promise(resolve => { this.startResolve = resolve; });
  }
  stop() { if (this.startResolve) this.startResolve(); }
  async sendText(target, content) {
    this.sent.push({ target: Object.assign({}, target), content: String(content) });
    return { id: 'fake-qq-response', timestamp: Date.now() };
  }
  async sendImage(target, source, options) {
    this.sent.push({ target: Object.assign({}, target), content: String(options && options.content || ''),
      mime: source.buffer[0] === 137 ? 'image/png' : 'unknown', bytes: source.buffer.length });
    return { id: 'fake-qq-media-response', timestamp: Date.now() };
  }
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
}

function storageMock() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    key: index => Array.from(values.keys())[index] || null,
    get length() { return values.size; }
  };
}

async function drain() {
  for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve));
}

async function main() {
  const localStorage = storageMock();
  const testGroupOpenId = 'fake-group-openid';
  const secondGroupOpenId = 'fake-second-group-openid';
  localStorage.setItem('ib_qq_official_settings_v1', JSON.stringify({
    paused: false,
    accounts: [{ appId: 'fake-app-e2e', roleId: 'role-e2e', takeover: true,
      allowedUserOpenIds: ['fake-authorized-openid', 'fake-second-user'], groups: [
        { groupOpenId: testGroupOpenId, roleId: 'role-group-e2e', takeover: true,
          adminMemberOpenIds: ['fake-member-openid'], sessionId: 'default' },
        { groupOpenId: secondGroupOpenId, roleId: 'role-alt-e2e', takeover: true,
          adminMemberOpenIds: ['second-group-admin'], sessionId: 'default' }
      ], combinedIntentConsent: true, credentialSaved: true }]
  }));

  const bots = new Map();
  const pngFixture = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const manager = createQQOfficialManager({
    dataDir: 'unused-fake-provider-e2e',
    credentialResolver: { resolve: () => ({ provider: 'qqbot', apiKey: 'fake-only-not-a-real-secret' }) },
    randomId: () => 'fake-e2e-request-id',
    downloadImage: async () => ({ buffer: Buffer.from(pngFixture), mime: 'image/png' }),
    createBot: async options => {
      const bot = new FakeBot(options);
      bots.set(options.appId, bot);
      return bot;
    },
    logger: () => {}
  });
  await manager.configure({ paused: false, accounts: [{
    appId: 'fake-app-e2e', roleId: 'role-e2e', takeover: true,
    allowedUserOpenIds: ['fake-authorized-openid', 'fake-second-user'],
    groups: [
      { groupOpenId: testGroupOpenId, roleId: 'role-group-e2e', takeover: true,
        adminMemberOpenIds: ['fake-member-openid'], sessionId: 'default' },
      { groupOpenId: secondGroupOpenId, roleId: 'role-alt-e2e', takeover: true,
        adminMemberOpenIds: ['second-group-admin'], sessionId: 'default' }
    ],
    combinedIntentConsent: true
  }] });
  assert.equal((await manager.connect({ appId: 'fake-app-e2e' })).ok, true);
  await drain();

  const providerCalls = [];
  let deferredProviderResolve = null;
  const conversation = QQ.createConversationAdapter({
    storage: localStorage,
    getRoleConfig: async id => ({ id, systemPrompt: 'fake role system' }),
    buildContext: async config => ({ system: config.systemPrompt, tail: '' }),
    generate: async (config, messages, options, event) => {
      const current = messages[messages.length - 1];
      const parts = Array.isArray(current && current.content) ? current.content : [];
      providerCalls.push({ config, messages: JSON.parse(JSON.stringify(messages)), options,
        conversationId: event.conversationId, inputImageCount: parts.filter(part => part && part.type === '_image').length });
      if (event.text === 'slow pending text') return new Promise(resolve => { deferredProviderResolve = resolve; });
      if (event.images && event.images.length) return { text: 'I can see the sample image.', images: [{
        mime: 'image/png', base64: pngFixture.toString('base64')
      }] };
      return 'fixed fake reply';
    },
    now: () => 5000
  });
  let pollCalls = 0;
  const remote = {
    configure: input => manager.configure(input),
    status: async () => manager.status(),
    heartbeat: async () => manager.heartbeat(),
    poll: async () => { pollCalls++; return manager.poll(); },
    progress: async (requestId, stage, errorCode) => manager.progress({ requestId, stage, errorCode }),
    complete: async (requestId, reply, images) => manager.complete({ requestId, reply, images })
  };
  const uiListeners = Object.create(null);
  const roles = {
    refreshRoleCatalog: async () => ({ state: 'ready', roles: [
      { id: 'role-e2e', name: 'Private role' },
      { id: 'role-group-e2e', name: 'Group role' },
      { id: 'role-alt-e2e', name: 'Second group role' }
    ] }),
    _roleCatalogSnapshot: () => ({ state: 'ready', roles: [
      { id: 'role-e2e', name: 'Private role' },
      { id: 'role-group-e2e', name: 'Group role' },
      { id: 'role-alt-e2e', name: 'Second group role' }
    ], error: '' }),
    _roleOptions: selected => '<option value="role-e2e"' + (selected === 'role-e2e' ? ' selected' : '') + '>Fake role</option>'
      + '<option value="role-group-e2e"' + (selected === 'role-group-e2e' ? ' selected' : '') + '>Fake group role</option>'
      + '<option value="role-alt-e2e"' + (selected === 'role-alt-e2e' ? ' selected' : '') + '>Second group role</option>',
    _roleAvailability: role => ({ available: ['role-e2e', 'role-group-e2e', 'role-alt-e2e'].includes(role.id), reason: 'role-unavailable' }),
    _conversationReply: event => conversation.reply(event),
    _conversationCommit: result => conversation.commit(result),
    _conversationReset: event => conversation.reset(event)
  };

  const timerJobs = new Map();
  let nextTimerId = 0;
  const mount = { innerHTML: '', addEventListener(type, handler) { uiListeners[type] = handler; }, querySelectorAll() { return []; } };
  const window = { IB: { homeNode: { qqOfficial: remote }, qqOnebot: roles } };
  const document = {
    readyState: 'complete',
    visibilityState: 'hidden',
    getElementById: id => id === 'qq-official-app' ? mount : null,
    addEventListener() {}
  };
  const context = {
    window, document, localStorage, Promise, console,
    setTimeout(callback) { const id = ++nextTimerId; timerJobs.set(id, callback); return id; },
    clearTimeout(id) { timerJobs.delete(id); },
    setInterval() { return 0; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8'), context, {
    filename: 'qq-official.js-fake-e2e'
  });
  await drain();
  assert.equal(window.IB.qqOfficialUI._getState().paused, false);
  assert.equal(document.visibilityState, 'hidden');

  await bots.get('fake-app-e2e').deliver({
    kind: 'c2c', senderId: 'fake-authorized-openid', senderIsBot: false,
    messageId: 'fake-c2c-message', timestamp: '2026-10-15T12:00:00.000Z',
    content: 'trigger fixed fake response', attachments: [],
    replyTarget: { scope: 'c2c', targetId: 'fake-authorized-openid', msgId: 'fake-c2c-message' }
  });

  const firstPoll = timerJobs.entries().next().value;
  assert.ok(firstPoll, 'the always-loaded consumer schedules a queue poll while the document is hidden');
  timerJobs.delete(firstPoll[0]);
  firstPoll[1]();
  await drain();

  assert.equal(pollCalls, 1, 'the hidden-page consumer reads the Home Node queue');
  assert.equal(providerCalls.length, 1, 'one authorized C2C event calls the bound Fake Provider exactly once');
  assert.equal(providerCalls[0].config.id, 'role-e2e');
  assert.equal(providerCalls[0].options.disableTools, true);
  assert.equal(providerCalls[0].options._noWebSearch, true);
  assert.equal(providerCalls[0].options._ibThreadId, 'qq-official:fake-app-e2e:c2c:fake-authorized-openid');
  assert.deepEqual(bots.get('fake-app-e2e').sent, [{
    target: { scope: 'c2c', targetId: 'fake-authorized-openid', msgId: 'fake-c2c-message' },
    content: 'fixed fake reply'
  }]);

  await bots.get('fake-app-e2e').deliver({
    kind: 'c2c', senderId: 'fake-authorized-openid', senderIsBot: false,
    messageId: 'fake-c2c-image-message', timestamp: '2026-10-15T12:01:00.000Z',
    content: 'Please describe this image.',
    attachments: [{ content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/download?token=fake-signed-image' }],
    replyTarget: { scope: 'c2c', targetId: 'fake-authorized-openid', msgId: 'fake-c2c-image-message' }
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const imagePoll = timerJobs.entries().next().value;
  assert.ok(imagePoll, 'image messages use the same hidden-page consumer');
  timerJobs.delete(imagePoll[0]);
  imagePoll[1]();
  await drain();
  assert.equal(providerCalls.length, 2, 'one image message calls the bound Fake Provider once');
  assert.equal(providerCalls[1].inputImageCount, 1, 'the existing Provider adapter receives an image part');
  assert.equal(providerCalls[1].messages[providerCalls[1].messages.length - 1].content[0].text, 'Please describe this image.',
    'mixed C2C text remains beside the image part in the same Provider turn');
  assert.equal(providerCalls[1].messages[providerCalls[1].messages.length - 1].content[1].base64, pngFixture.toString('base64'));
  assert.equal(bots.get('fake-app-e2e').sent.length, 2);
  assert.deepEqual(bots.get('fake-app-e2e').sent[1], {
    target: { scope: 'c2c', targetId: 'fake-authorized-openid', msgId: 'fake-c2c-image-message' },
    content: 'I can see the sample image.', mime: 'image/png', bytes: pngFixture.length
  }, 'the SDK media API sends the Provider image as a passive reply');
  const storedValues = Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index))).join('\n');
  assert.equal(storedValues.includes(pngFixture.toString('base64')), false,
    'image bytes are not persisted in the QQ conversation history');
  assert.equal(storedValues.includes('fake-signed-image'), false,
    'temporary Tencent attachment URLs are not persisted');

  const accountRow = { getAttribute: name => name === 'data-app-id' ? 'fake-app-e2e' : null };
  uiListeners.change({ target: {
    checked: false,
    getAttribute: name => name === 'data-qq-official-field' ? 'takeover' : null,
    hasAttribute: () => false,
    closest: selector => selector === '.qq-official-account' ? accountRow : null
  } });
  await drain();
  assert.equal(window.IB.qqOfficialUI._getState().accounts[0].takeover, false,
    'the C2C takeover switch can be off while an individually configured group remains active');

  const groupMessage = (messageId, content, attachments) => ({
    kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderIsBot: false,
    groupOpenid: testGroupOpenId, senderId: 'fake-member-openid', senderName: 'Alice',
    messageId, timestamp: '2026-10-15T12:02:00.000Z', content, attachments: attachments || [],
    mentions: [{ is_you: true }],
    replyTarget: { scope: 'group', targetId: testGroupOpenId, msgId: messageId }
  });
  await bots.get('fake-app-e2e').deliver(groupMessage('fake-group-text', 'describe this for the group'));
  const groupTextEvent = manager.poll().event;
  assert.ok(groupTextEvent);
  assert.equal(groupTextEvent.roleId, 'role-group-e2e');
  assert.equal(groupTextEvent.messageType, 'group');
  assert.equal(groupTextEvent.senderId, 'fake-member-openid');
  assert.match(groupTextEvent.senderRef, /^member-[a-f0-9]{12}$/);
  await window.IB.qqOfficialUI._processEvent(groupTextEvent);
  await drain();
  assert.equal(providerCalls.length, 3, 'group @ message calls its bound Fake Provider with C2C takeover off');
  assert.equal(providerCalls[2].config.id, 'role-group-e2e');
  assert.equal(providerCalls[2].messages.at(-1).content.includes('Alice · ' + groupTextEvent.senderRef), true,
    'the group Provider prompt preserves the speaker identity');
  assert.equal(manager.status().accounts[0].lastStage, 'send-succeeded');
  assert.deepEqual(bots.get('fake-app-e2e').sent[2], {
    target: { scope: 'group', targetId: testGroupOpenId, msgId: 'fake-group-text' }, content: 'fixed fake reply'
  });

  await bots.get('fake-app-e2e').deliver(groupMessage('fake-group-image', 'What is in this group image?', [
    { content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/group-image?token=fake-group-token' }
  ]));
  await new Promise(resolve => setTimeout(resolve, 5));
  const groupImageEvent = manager.poll().event;
  assert.ok(groupImageEvent && groupImageEvent.images.length === 1);
  await window.IB.qqOfficialUI._processEvent(groupImageEvent);
  await drain();
  assert.equal(providerCalls.length, 4, 'a group image calls the visual Fake Provider once');
  assert.equal(providerCalls[3].inputImageCount, 1);
  assert.equal(providerCalls[3].messages.at(-1).content[0].text.includes('Alice · ' + groupImageEvent.senderRef), true);
  assert.equal(bots.get('fake-app-e2e').sent.length, 4);
  assert.deepEqual(bots.get('fake-app-e2e').sent[3], {
    target: { scope: 'group', targetId: testGroupOpenId, msgId: 'fake-group-image' },
    content: 'I can see the sample image.', mime: 'image/png', bytes: pngFixture.length
  }, 'the official SDK media API sends a passive group image reply');

  const quotedGroupMessage = groupMessage('fake-group-quoted-image', 'What is in the quoted image?', []);
  quotedGroupMessage.refMsgIdx = 'fake-quoted-image-ref';
  quotedGroupMessage.msgType = 103;
  quotedGroupMessage.msgElements = [{ msg_idx: 'fake-quoted-image-ref', attachments: [
    { content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/quoted-image?token=fake-quoted-token' }
  ] }];
  await bots.get('fake-app-e2e').deliver(quotedGroupMessage);
  await new Promise(resolve => setTimeout(resolve, 5));
  const quotedGroupImageEvent = manager.poll().event;
  assert.ok(quotedGroupImageEvent && quotedGroupImageEvent.images.length === 1,
    'quoted QQ group image is attached to the later @ message without ingesting the original unmentioned message');
  await window.IB.qqOfficialUI._processEvent(quotedGroupImageEvent);
  await drain();
  assert.equal(providerCalls.length, 5);
  assert.equal(providerCalls[4].inputImageCount, 1,
    'the bound group role receives quoted image pixels through the existing visual Provider path');
  assert.equal(bots.get('fake-app-e2e').sent.at(-1).target.msgId, 'fake-group-quoted-image');

  const account = manager.status().accounts[0];
  assert.equal(account.lastStage, 'media-send-succeeded');
  assert.equal(account.diagnostics.eventsQueued, 5);
  assert.equal(account.diagnostics.eventsDeliveredToUi, 5);
  assert.equal(account.diagnostics.providerStarted, 5);
  assert.equal(account.diagnostics.providerReady, 5);
  assert.equal(account.diagnostics.sendSucceeded, 5);
  assert.equal(account.diagnostics.mediaSendStarted, 3);
  assert.equal(account.diagnostics.mediaSendSucceeded, 3);

  uiListeners.change({ target: {
    checked: true,
    getAttribute: name => name === 'data-qq-official-field' ? 'takeover' : null,
    hasAttribute: () => false,
    closest: selector => selector === '.qq-official-account' ? accountRow : null
  } });
  await drain();

  const callsBeforeCommands = providerCalls.length;
  const privateCommand = async (messageId, userOpenId, content) => {
    await bots.get('fake-app-e2e').deliver({
      kind: 'c2c', senderId: userOpenId, senderIsBot: false, messageId,
      timestamp: '2026-10-15T12:03:00.000Z', content, attachments: [],
      replyTarget: { scope: 'c2c', targetId: userOpenId, msgId: messageId }
    });
    return manager.poll().event;
  };
  const privateWho = await privateCommand('private-who', 'fake-authorized-openid', '/who');
  assert.equal(privateWho.roleId, 'role-e2e');
  await window.IB.qqOfficialUI._processEvent(privateWho);
  assert.equal(bots.get('fake-app-e2e').sent.at(-1).content.includes('Private role'), true);
  const privateRoleList = await privateCommand('private-role-list', 'fake-authorized-openid', '/role');
  await window.IB.qqOfficialUI._processEvent(privateRoleList);
  assert.equal(bots.get('fake-app-e2e').sent.at(-1).content.includes('Second group role'), true,
    '/role lists existing available IB roles without calling the Provider');
  const unknownSlash = await privateCommand('private-unknown-command', 'fake-authorized-openid', '/help');
  await window.IB.qqOfficialUI._processEvent(unknownSlash);
  assert.equal(bots.get('fake-app-e2e').sent.at(-1).content.includes('/reset'), true,
    'unknown slash commands return command help instead of being passed to the model');
  const privateSwitchA = await privateCommand('private-switch-a', 'fake-authorized-openid', '/role Group role');
  await window.IB.qqOfficialUI._processEvent(privateSwitchA);
  const privateSwitchB = await privateCommand('private-switch-b', 'fake-second-user', '/role Second group role');
  await window.IB.qqOfficialUI._processEvent(privateSwitchB);
  assert.equal(providerCalls.length, callsBeforeCommands, 'all text commands bypass the Provider');
  const privateSelections = window.IB.qqOfficialUI._getState().accounts[0].privateRoleSelections;
  assert.deepEqual(Array.from(privateSelections, row => [row.userOpenId, row.roleId]), [
    ['fake-authorized-openid', 'role-group-e2e'], ['fake-second-user', 'role-alt-e2e']
  ], 'two C2C users persist independent role choices');
  const privateSessionByUser = Object.fromEntries(Array.from(privateSelections, row => [row.userOpenId, row.sessionId]));
  assert.notEqual(privateSessionByUser['fake-authorized-openid'], privateSessionByUser['fake-second-user']);

  const privateTurnA = await privateCommand('private-turn-a', 'fake-authorized-openid', 'message for A');
  const privateTurnB = await privateCommand('private-turn-b', 'fake-second-user', 'message for B');
  assert.equal(privateTurnA.roleId, 'role-group-e2e');
  assert.equal(privateTurnB.roleId, 'role-alt-e2e');
  assert.equal(privateTurnA.sessionId, privateSessionByUser['fake-authorized-openid']);
  assert.equal(privateTurnB.sessionId, privateSessionByUser['fake-second-user']);
  await window.IB.qqOfficialUI._processEvent(privateTurnA);
  await window.IB.qqOfficialUI._processEvent(privateTurnB);
  assert.equal(providerCalls.at(-2).config.id, 'role-group-e2e');
  assert.equal(providerCalls.at(-1).config.id, 'role-alt-e2e');
  const persistedSelections = JSON.parse(localStorage.getItem('ib_qq_official_settings_v1')).accounts[0].privateRoleSelections;
  assert.deepEqual(persistedSelections.map(row => row.roleId), ['role-group-e2e', 'role-alt-e2e'],
    'per-user roles survive a fresh UI initialization from the same Dev settings');

  const groupWhoMessage = groupMessage('group-command-who', '/who', []);
  groupWhoMessage.senderId = 'ordinary-group-member';
  groupWhoMessage.senderName = 'Guest';
  groupWhoMessage.senderRef = 'member-abcdefabcdef';
  await bots.get('fake-app-e2e').deliver(groupWhoMessage);
  const groupWhoEvent = manager.poll().event;
  assert.equal(groupWhoEvent.canManageConversation, false);
  const providersBeforeGroupCommands = providerCalls.length;
  await window.IB.qqOfficialUI._processEvent(groupWhoEvent);
  assert.equal(providerCalls.length, providersBeforeGroupCommands);
  assert.equal(bots.get('fake-app-e2e').sent.at(-1).content.includes('Group role'), true,
    'ordinary group members can query the shared role without invoking the model');
  const ordinarySwitch = groupMessage('ordinary-group-switch', '/role Private role', []);
  ordinarySwitch.senderId = 'ordinary-group-member';
  ordinarySwitch.senderName = 'Guest';
  ordinarySwitch.senderRef = 'member-abcdefabcdef';
  await bots.get('fake-app-e2e').deliver(ordinarySwitch);
  const ordinarySwitchEvent = manager.poll().event;
  await window.IB.qqOfficialUI._processEvent(ordinarySwitchEvent);
  assert.equal(bots.get('fake-app-e2e').sent.at(-1).content.includes('指令管理者'), true,
    'ordinary group members cannot switch the group role');
  assert.equal(providerCalls.length, providersBeforeGroupCommands);

  const groupSwitch = groupMessage('admin-group-switch', '/role Private role', []);
  await bots.get('fake-app-e2e').deliver(groupSwitch);
  const groupSwitchEvent = manager.poll().event;
  assert.equal(groupSwitchEvent.canManageConversation, true,
    'the group command-admin permission comes from the IB OpenID list, not QQ member role fields');
  const priorGroupRole = groupSwitchEvent.roleId;
  await window.IB.qqOfficialUI._processEvent(groupSwitchEvent);
  const switchedGroup = window.IB.qqOfficialUI._getState().accounts[0].groups.find(row => row.groupOpenId === testGroupOpenId);
  assert.equal(switchedGroup.roleId, 'role-e2e');
  assert.notEqual(switchedGroup.sessionId, 'default');
  const secondGroup = window.IB.qqOfficialUI._getState().accounts[0].groups.find(row => row.groupOpenId === secondGroupOpenId);
  assert.equal(secondGroup.roleId, 'role-alt-e2e', 'switching one group does not modify another group role');

  const staleGroupText = 'slow pending text';
  const staleGroupMessage = groupMessage('stale-provider-before-switch', staleGroupText, []);
  staleGroupMessage.senderId = 'fake-member-openid';
  staleGroupMessage.senderName = 'Alice';
  await bots.get('fake-app-e2e').deliver(staleGroupMessage);
  const staleGroupEvent = manager.poll().event;
  const staleSessionHistoryKey = QQ.conversationStorageKey(staleGroupEvent);
  const staleTask = window.IB.qqOfficialUI._processEvent(staleGroupEvent);
  await drain();
  assert.equal(typeof deferredProviderResolve, 'function', 'a group Provider request is pending before the switch');
  const switchBackMessage = groupMessage('switch-during-provider', '/role Group role', []);
  await bots.get('fake-app-e2e').deliver(switchBackMessage);
  const switchBackEvent = manager.poll().event;
  await window.IB.qqOfficialUI._processEvent(switchBackEvent);
  deferredProviderResolve('late group reply');
  await staleTask;
  assert.equal(bots.get('fake-app-e2e').sent.some(row => row.target.msgId === 'stale-provider-before-switch'
    && row.content === 'late group reply'), false, 'an old group Provider result cannot reply after a role switch');
  assert.equal(localStorage.getItem(staleSessionHistoryKey), null,
    'the stale Provider result cannot recreate the cleared prior group conversation');

  assert.equal(manager.status().accounts[0].pendingCount, 0,
    'all command and stale Provider requests are completed or cancelled before shutdown');
  await manager.close();
  console.log('QQ Official hidden-page Fake Provider end-to-end checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
