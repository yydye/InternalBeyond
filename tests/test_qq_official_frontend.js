'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function drain() {
  for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve));
}

async function main() {
  const stored = new Map();
  const storage = {
    getItem: key => stored.has(key) ? stored.get(key) : null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key),
    key: index => Array.from(stored.keys())[index] || null,
    get length() { return stored.size; }
  };
  const calls = { vault: [], config: [], connect: [], progress: [], complete: [], reset: [], status: 0, provider: 0, providerEvents: [], commit: 0 };
  let throwProvider = false;
  let deferredProviderResolve = null;
  let serverAccounts = [];
  let connectedAppIds = Object.create(null);
  let serverPaused = true;
  let failConfigOnce = false;
  let failStatusCount = 0;
  let failPollCount = 0;
  let heldStatus = null;
  const listeners = Object.create(null);
  let renderCount = 0;
  const migrationElements = {
    status: { textContent: '' },
    clear: { hidden: true },
    apply: { disabled: true },
    confirm: {
      checked: false,
      hasAttribute: name => name === 'data-qq-migration-confirm',
      getAttribute: () => ''
    },
    preview: {
      hidden: true,
      _html: '',
      get innerHTML() { return this._html; },
      set innerHTML(value) {
        this._html = String(value || '');
        migrationElements.confirm.checked = /data-qq-migration-confirm checked/.test(this._html);
      }
    }
  };
  let mount = {
    _innerHTML: '',
    get innerHTML() { return this._innerHTML; },
    set innerHTML(value) { this._innerHTML = String(value || ''); renderCount++; },
    __listeners: listeners,
    addEventListener: (type, handler) => { (listeners[type] || (listeners[type] = [])).push(handler); },
    querySelectorAll: () => [],
    querySelector: selector => ({
      '[data-migration-status]': migrationElements.status,
      '[data-migration-preview]': migrationElements.preview,
      '[data-migration-clear]': migrationElements.clear,
      '[data-migration-apply]': migrationElements.apply,
      '[data-qq-migration-confirm]': migrationElements.confirm
    })[selector] || null
  };
  const remote = {
    configure: async input => {
      calls.config.push(input);
      if (failConfigOnce) {
        failConfigOnce = false;
        return { ok: false, error: 'qq-official-closed' };
      }
      serverPaused = input.paused;
      serverAccounts = input.accounts.map(row => Object.assign({}, row, {
        state: connectedAppIds[row.appId] ? 'online' : 'stopped',
        groups: Array.isArray(row.groups) ? row.groups.map(group => ({
          groupOpenId: group.groupOpenId,
          roleId: group.roleId,
          takeover: group.takeover === true,
          adminMemberCount: Array.isArray(group.adminMemberOpenIds) ? group.adminMemberOpenIds.length : 0,
          pendingAdminMemberOpenIds: []
        })) : []
      }));
      return { ok: true, accounts: serverAccounts, paused: serverPaused };
    },
    status: async () => {
      calls.status++;
      if (failStatusCount > 0) {
        failStatusCount--;
        return { ok: false, error: 'home-node-unreachable' };
      }
      if (heldStatus) return heldStatus;
      return { ok: true, paused: serverPaused, clientActive: true, accounts: serverAccounts.map(row => Object.assign({}, row)) };
    },
    heartbeat: async () => ({ ok: true, clientActive: true }),
    connect: async appId => {
      calls.connect.push(appId);
      connectedAppIds[appId] = true;
      serverAccounts = serverAccounts.map(row => row.appId === appId ? Object.assign({}, row, { state: 'online' }) : row);
      return { ok: true, state: 'connecting' };
    },
    disconnect: async appId => {
      delete connectedAppIds[appId];
      serverAccounts = serverAccounts.map(row => row.appId === appId ? Object.assign({}, row, { state: 'stopped' }) : row);
      return { ok: true };
    },
    poll: async () => {
      if (failPollCount > 0) {
        failPollCount--;
        throw new Error('transient poll timeout');
      }
      return { ok: true, event: null };
    },
    progress: async (requestId, stage, errorCode) => {
      calls.progress.push({ requestId, stage, errorCode });
      return { ok: true, stage };
    },
    complete: async (requestId, reply) => {
      calls.complete.push({ requestId, reply });
      return { ok: true, replied: !!reply };
    }
  };
  const roles = {
    refreshRoleCatalog: async () => ({ state: 'ready', roles: [
      { id: 'role-existing', name: 'Role' }, { id: 'role-group-existing', name: 'Group Role' }, { id: 'role-alt', name: 'Alt Role' }
    ] }),
    _roleCatalogSnapshot: () => ({ state: 'ready', roles: [
      { id: 'role-existing', name: 'Role' }, { id: 'role-group-existing', name: 'Group Role' }, { id: 'role-alt', name: 'Alt Role' }
    ], error: '' }),
    _roleOptions: selected => '<option value="role-existing"' + (selected === 'role-existing' ? ' selected' : '') + '>Role</option>'
      + '<option value="role-group-existing"' + (selected === 'role-group-existing' ? ' selected' : '') + '>Group Role</option>'
      + '<option value="role-alt"' + (selected === 'role-alt' ? ' selected' : '') + '>Alt Role</option>',
    _roleAvailability: role => ({ available: ['role-existing', 'role-group-existing', 'role-alt'].includes(role.id), reason: 'role-unavailable' }),
    _conversationReply: async event => {
      calls.provider++;
      calls.providerEvents.push(Object.assign({}, event));
      if (event.text === 'delayed old reply') return new Promise(resolve => { deferredProviderResolve = resolve; });
      if (throwProvider) throw new Error('untrusted provider detail');
      return { ok: true, reply: 'mock reply' };
    },
    _conversationCommit: () => { calls.commit++; return true; },
    _conversationReset: event => { calls.reset.push(event); return true; }
  };
  const window = {
    IB: { homeNode: { qqOfficial: remote }, qqOnebot: roles },
    _ibWriteVaultCredential: async (ref, config, secret) => {
      calls.vault.push({ ref, config, secret });
      return ref;
    },
    _ibDeleteVaultCredential: async ref => ({ credentialRef: ref, removed: 1 }),
    confirm: () => true
  };
  const document = {
    readyState: 'complete',
    getElementById: id => id === 'qq-official-app' ? mount : null,
    addEventListener() {}
  };
  const context = {
    window,
    document,
    localStorage: storage,
    Promise,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8'), context, {
    filename: 'qq-official.js'
  });
  await drain();
  assert.equal(typeof window.IB.qqOfficialUI._getState, 'function');
  assert.equal(window.IB.qqOfficialUI._getState().paused, true, 'first load is takeover-paused');
  assert.equal(mount.innerHTML.includes('回复引用图片后 @（需腾讯事件携带引用附件）'), true,
    'the UI explains how to bring an earlier untagged image into an authorized group @ event');
  assert.equal(mount.innerHTML.includes('未 @ 的消息不会缓存'), true,
    'the UI discloses that ordinary group messages are not collected for later context');

  const secret = 'mock-secret-do-not-persist';
  const appSecretInput = { value: secret };
  const form = {
    id: 'qq-official-add-form',
    elements: {
      appId: { value: 'mock-app-frontend' },
      appSecret: appSecretInput,
      roleId: { value: 'role-existing' },
      allowedUserOpenIds: { value: 'open-id-test' },
      combinedIntentConsent: { checked: false }
    }
  };
  const submit = listeners.submit && listeners.submit[0];
  assert.equal(typeof submit, 'function');
  submit({ target: form, preventDefault() {} });
  await drain();
  assert.equal(calls.vault.length, 0, 'AppSecret is not saved before the combined-intent boundary is acknowledged');
  assert.equal(window.IB.qqOfficialUI._getState().accounts.length, 0);

  form.elements.combinedIntentConsent.checked = true;
  submit({ target: form, preventDefault() {} });
  await drain();

  const state = window.IB.qqOfficialUI._getState();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].takeover, false, 'account creation does not grant AI takeover');
  assert.equal(state.accounts[0].combinedIntentConsent, true);
  assert.equal(state.accounts[0].roleId, 'role-existing');
  assert.deepEqual(Array.from(state.accounts[0].allowedUserOpenIds), ['open-id-test']);
  assert.equal(calls.vault.length, 1, 'AppSecret is written through the existing Vault helper');
  assert.equal(calls.vault[0].secret, secret);
  const savedConfig = calls.config.find(item => item.accounts.length === 1);
  assert.ok(savedConfig);
  assert.equal(Object.prototype.hasOwnProperty.call(savedConfig.accounts[0], 'appSecret'), false,
    'Home Node config receives no AppSecret');
  assert.equal(savedConfig.accounts[0].combinedIntentConsent, true,
    'the explicit C2C/group intent acknowledgment is carried to Home Node');
  assert.deepEqual(Array.from(calls.connect), ['mock-app-frontend'], 'connection is an explicit add-form action');
  assert.equal(stored.get('ib_qq_official_settings_v1').includes(secret), false,
    'AppSecret never enters localStorage');
  assert.equal(mount.innerHTML.includes(secret), false, 'AppSecret is not echoed into UI markup');
  assert.equal(appSecretInput.value, '', 'password input is cleared after Vault write');

  const testGroupOpenId = 'group-frontend-test';
  const accountNode = { getAttribute: name => name === 'data-app-id' ? 'mock-app-frontend' : null };
  const pendingGroupCard = { querySelector: selector => selector === '[data-qq-pending-role]' ? { value: '' } : null };
  const authorizeGroupButton = {
    getAttribute: name => name === 'data-qq-official-action' ? 'approve-group'
      : (name === 'data-group-openid' ? testGroupOpenId : null),
    closest: selector => selector === '[data-qq-official-action]' ? authorizeGroupButton
      : selector === '[data-pending-group-card]' ? pendingGroupCard
        : selector === '.qq-official-account' ? accountNode : null
  };
  listeners.click[0]({ target: authorizeGroupButton });
  await drain();
  const authorizedGroup = window.IB.qqOfficialUI._getState().accounts[0].groups[0];
  assert.equal(authorizedGroup.groupOpenId, testGroupOpenId);
  assert.equal(authorizedGroup.roleId, '');
  assert.equal(authorizedGroup.takeover, false, 'authorizing a group adds a separate binding that remains in manual mode');

  const groupNode = { getAttribute: name => name === 'data-group-openid' ? testGroupOpenId : null };
  const setGroupField = (field, value) => listeners.change[0]({ target: {
    value, checked: value, hasAttribute: () => false,
    getAttribute: name => name === 'data-qq-group-field' ? field : null,
    closest: selector => selector === '.qq-official-group-row' ? groupNode
      : selector === '.qq-official-account' ? accountNode : null
  } });
  setGroupField('roleId', 'role-group-existing');
  await drain();
  setGroupField('takeover', true);
  await drain();
  assert.equal(mount.innerHTML.includes('可切换角色或重置会话的成员 OpenID'), true,
    'group command admin OpenIDs are configured explicitly in IB');
  const groupConfig = calls.config.at(-1).accounts[0];
  assert.equal(groupConfig.roleId, 'role-existing', 'group binding does not replace the account C2C role');
  assert.deepEqual(Array.from(groupConfig.groups, group => [group.groupOpenId, group.roleId, group.takeover]), [
    [testGroupOpenId, 'role-group-existing', true]
  ], 'group role and takeover are sent independently from C2C account settings');

  const adminButton = {
    getAttribute: name => name === 'data-qq-official-action' ? 'authorize-group-admin'
      : (name === 'data-member-open-id' ? 'member-open-id' : null),
    closest: selector => selector === '[data-qq-official-action]' ? adminButton
      : (selector === '.qq-official-group-row' ? groupNode
        : (selector === '.qq-official-account' ? accountNode : null))
  };
  listeners.click[0]({ target: adminButton });
  await drain();
  assert.deepEqual(Array.from(window.IB.qqOfficialUI._getState().accounts[0].groups[0].adminMemberOpenIds), ['member-open-id']);
  assert.equal(serverAccounts[0].groups[0].adminMemberCount, 1,
    'the UI confirms a group command admin only after Home Node reports the matching configured count');
  assert.equal(mount.innerHTML.includes('该群成员已加入 IB 指令管理者名单。'), true);

  failConfigOnce = true;
  const failedAdminButton = {
    getAttribute: name => name === 'data-qq-official-action' ? 'authorize-group-admin'
      : (name === 'data-member-open-id' ? 'member-open-id-2' : null),
    closest: selector => selector === '[data-qq-official-action]' ? failedAdminButton
      : (selector === '.qq-official-group-row' ? groupNode
        : (selector === '.qq-official-account' ? accountNode : null))
  };
  listeners.click[0]({ target: failedAdminButton });
  await drain();
  assert.deepEqual(Array.from(window.IB.qqOfficialUI._getState().accounts[0].groups[0].adminMemberOpenIds), ['member-open-id'],
    'a rejected Home Node config is rolled back so an unauthorized member is not shown as authorized');
  assert.equal(mount.innerHTML.includes('本地服务未确认该群指令管理员授权'), true,
    'a rejected group-admin sync shows an explicit error instead of a false success');
  failConfigOnce = false;

  stored.set('ib_qq_official_settings_v1', JSON.stringify({
    paused: false,
    accounts: [{ appId: 'mock-app-frontend', roleId: 'role-existing', takeover: true,
      allowedUserOpenIds: ['open-id-test'], groups: [{ groupOpenId: testGroupOpenId,
        roleId: 'role-group-existing', takeover: true, adminMemberOpenIds: ['member-open-id'], sessionId: 'default' }], combinedIntentConsent: true, credentialSaved: true }]
  }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8'), context, {
    filename: 'qq-official.js-diagnostic-reload'
  });
  await drain();
  const event = { requestId: 'opaque-request-1', appId: 'mock-app-frontend', messageType: 'private',
    roleId: 'role-existing', sessionId: 'default', canManageConversation: true,
    senderId: 'open-id-test', peerId: 'open-id-test', text: 'hello' };
  await window.IB.qqOfficialUI._processEvent(event);
  assert.deepEqual(calls.progress.slice(-2).map(row => row.stage), ['provider-started', 'provider-ready'],
    'the desktop reports Provider start and completion stages');
  assert.deepEqual(calls.complete[calls.complete.length - 1], { requestId: 'opaque-request-1', reply: 'mock reply' });

  throwProvider = true;
  await window.IB.qqOfficialUI._processEvent(Object.assign({}, event, { requestId: 'opaque-request-2' }));
  assert.deepEqual(calls.progress.slice(-2).map(row => row.stage), ['provider-started', 'provider-failed'],
    'Provider exceptions become a visible safe failure stage');
  assert.equal(calls.progress[calls.progress.length - 1].errorCode, 'provider-failed',
    'Provider exception text is replaced by an allowlisted code');
  assert.deepEqual(calls.complete[calls.complete.length - 1], { requestId: 'opaque-request-2', reply: '' });
  assert.equal(JSON.stringify(calls.progress).includes('untrusted provider detail'), false,
    'Provider exception messages are never reported to Home Node');

  throwProvider = false;
  stored.set('ib_qq_official_settings_v1', JSON.stringify({
    paused: false,
    accounts: [{ appId: 'mock-app-frontend', roleId: 'role-existing', takeover: false,
      allowedUserOpenIds: ['open-id-test'], groups: [{ groupOpenId: testGroupOpenId,
        roleId: 'role-group-existing', takeover: true, adminMemberOpenIds: ['member-open-id'], sessionId: 'default' }], combinedIntentConsent: true, credentialSaved: true }]
  }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8'), context, {
    filename: 'qq-official.js-group-only-reload'
  });
  await drain();
  assert.equal(window.IB.qqOfficialUI._getState().accounts[0].takeover, false,
    'C2C takeover can be disabled while a specific group remains enabled');
  assert.equal(window.IB.qqOfficialUI._getState().accounts[0].groups[0].takeover, true);
  const groupProviderEvent = {
    requestId: 'opaque-group-request', appId: 'mock-app-frontend', roleId: 'role-group-existing',
    messageType: 'group', groupOpenId: testGroupOpenId, peerId: testGroupOpenId,
    sessionId: 'default', senderId: 'member-open-id', senderRef: 'member-abcdef123456', text: 'group prompt'
  };
  await window.IB.qqOfficialUI._processEvent(groupProviderEvent);
  assert.equal(calls.provider, 3, 'group messages use the group-bound Provider when the account C2C switch is off');
  assert.equal(calls.complete.at(-1).reply, 'mock reply');
  await window.IB.qqOfficialUI._processEvent(Object.assign({}, groupProviderEvent, {
    requestId: 'opaque-unauthorized-group', groupOpenId: 'other-group', peerId: 'other-group'
  }));
  assert.equal(calls.provider, 3, 'an unconfigured group cannot call Provider through the desktop consumer');
  assert.equal(calls.config.at(-1).accounts[0].takeover, false);

  connectedAppIds = Object.create(null);
  serverAccounts = [];
  failConfigOnce = true;
  assert.equal(await window.IB.qqOfficialUI._refreshStatus(), false,
    'a failed config restoration is visible while the Home Node is still closing');
  assert.equal(mount.innerHTML.includes('本地服务已恢复，但 QQ 设置尚未同步'), true,
    'the recovery failure is shown while it is current');
  assert.equal(await window.IB.qqOfficialUI._refreshStatus(), true,
    'the next status poll retries configuration after the Home Node has recovered');
  assert.equal(calls.connect.length, 2, 'a connected account is restored after Home Node loses its in-memory manager state');
  assert.equal(serverAccounts[0].state, 'online', 'the existing account reconnects through the normal Home Node connect route');
  assert.deepEqual(Array.from(serverAccounts[0].allowedUserOpenIds), ['open-id-test'], 'OpenID authorization survives Home Node recovery');
  assert.equal(serverAccounts[0].roleId, 'role-existing', 'the bound role survives Home Node recovery');
  assert.equal(serverAccounts[0].takeover, false, 'the existing C2C takeover setting survives Home Node recovery');
  assert.equal(serverAccounts[0].groups[0].takeover, true, 'the group takeover setting survives Home Node recovery');
  assert.equal(mount.innerHTML.includes('本地服务已恢复，但 QQ 设置尚未同步'), false,
    'a later successful recovery clears the stale transient failure notice');

  const ui = window.IB.qqOfficialUI;
  assert.equal(ui._getConnectionState(), 'connected');
  failPollCount = 1;
  await ui._pollOnce();
  assert.equal(ui._getConnectionState(), 'connected',
    'one failed message poll must not mark healthy Home Node services as disconnected');

  const statusCallsBeforeOverlap = calls.status;
  let releaseHeldStatus;
  heldStatus = new Promise(resolve => { releaseHeldStatus = resolve; });
  const overlappingStatusOne = ui._refreshStatus();
  const overlappingStatusTwo = ui._refreshStatus();
  await drain();
  assert.equal(calls.status - statusCallsBeforeOverlap, 1,
    'simultaneous refresh triggers share one in-flight Home Node status read');
  releaseHeldStatus({ ok: true, paused: serverPaused, clientActive: true,
    accounts: serverAccounts.map(row => Object.assign({}, row)) });
  heldStatus = null;
  assert.equal(await overlappingStatusOne, true);
  assert.equal(await overlappingStatusTwo, true);

  failStatusCount = 1;
  assert.equal(await ui._refreshStatus(), false);
  assert.equal(ui._getConnectionState(), 'connected',
    'a single status timeout after a successful response is treated as transient');
  failStatusCount = 1;
  assert.equal(await ui._refreshStatus(), false);
  assert.equal(ui._getConnectionState(), 'unavailable',
    'two consecutive failed status reads expose a real local-service outage');
  assert.equal(await ui._refreshStatus(), true);
  assert.equal(ui._getConnectionState(), 'connected', 'a successful status response clears the outage state');

  const providerCallsBeforeCommands = calls.provider;
  const groupWho = Object.assign({}, groupProviderEvent, {
    requestId: 'group-command-who', roleId: 'role-group-existing', sessionId: 'default',
    canManageConversation: false, text: '/who'
  });
  await window.IB.qqOfficialUI._processEvent(groupWho);
  assert.equal(calls.provider, providerCallsBeforeCommands, 'commands are replied to without a Provider call');
  assert.equal(calls.complete.at(-1).reply.includes('Group Role'), true, 'ordinary group members may query the shared role');
  const deniedGroupSwitch = Object.assign({}, groupWho, {
    requestId: 'group-command-denied', senderId: 'ordinary-member', senderRef: 'member-abcdef123457', text: '/role Role'
  });
  await window.IB.qqOfficialUI._processEvent(deniedGroupSwitch);
  assert.equal(calls.provider, providerCallsBeforeCommands);
  assert.equal(calls.complete.at(-1).reply.includes('IB 群设置'), true,
    'ordinary group members cannot switch the shared role');

  const adminGroupSwitch = Object.assign({}, groupWho, {
    requestId: 'group-command-switch', canManageConversation: true, text: '/role Role'
  });
  await window.IB.qqOfficialUI._processEvent(adminGroupSwitch);
  let currentGroup = window.IB.qqOfficialUI._getState().accounts[0].groups[0];
  assert.equal(currentGroup.roleId, 'role-existing', 'an explicitly authorized IB group admin can switch the shared group role');
  assert.notEqual(currentGroup.sessionId, 'default', 'group role switching creates a new session identity');
  assert.equal(calls.reset.at(-1).sessionId, 'default', 'the previous group context is cleared only for that group session');
  const oldGroupSession = currentGroup.sessionId;
  await window.IB.qqOfficialUI._processEvent(Object.assign({}, adminGroupSwitch, {
    requestId: 'group-command-reset', roleId: 'role-existing', sessionId: oldGroupSession, text: '/reset'
  }));
  currentGroup = window.IB.qqOfficialUI._getState().accounts[0].groups[0];
  assert.equal(currentGroup.roleId, 'role-existing', 'reset retains the active group role');
  assert.notEqual(currentGroup.sessionId, oldGroupSession, 'reset opens a new shared group session');
  assert.equal(calls.provider, providerCallsBeforeCommands, 'group query, switch, and reset commands never reach the model');

  stored.set('ib_qq_official_settings_v1', JSON.stringify({
    paused: false,
    accounts: [{ appId: 'mock-app-frontend', roleId: 'role-existing', takeover: true,
      allowedUserOpenIds: ['open-id-test', 'open-id-other'], groups: [{ groupOpenId: testGroupOpenId,
        roleId: currentGroup.roleId, takeover: true, adminMemberOpenIds: ['member-open-id'], sessionId: currentGroup.sessionId }],
      combinedIntentConsent: true, credentialSaved: true }]
  }));
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8'), context, {
    filename: 'qq-official.js-multi-private-command-roles'
  });
  await drain();
  const privateCommand = (requestId, senderId, text, roleId, sessionId) => ({
    requestId, appId: 'mock-app-frontend', accountId: 'qqofficial_mock-app-frontend',
    messageType: 'private', senderId, peerId: senderId, roleId, sessionId,
    canManageConversation: true, text, conversationId: 'qq-official:mock-app-frontend:c2c:' + senderId
  });
  await window.IB.qqOfficialUI._processEvent(privateCommand('private-role-a', 'open-id-test', '/role Group Role', 'role-existing', 'default'));
  await window.IB.qqOfficialUI._processEvent(privateCommand('private-role-b', 'open-id-other', '/role Alt Role', 'role-existing', 'default'));
  let commandState = window.IB.qqOfficialUI._getState().accounts[0];
  assert.deepEqual(Array.from(commandState.privateRoleSelections, row => [row.userOpenId, row.roleId]), [
    ['open-id-test', 'role-group-existing'], ['open-id-other', 'role-alt']
  ], 'C2C role selection is stored independently for each authorized user');
  const sessionByUser = Object.fromEntries(commandState.privateRoleSelections.map(row => [row.userOpenId, row.sessionId]));
  assert.notEqual(sessionByUser['open-id-test'], sessionByUser['open-id-other']);
  const persistedCommandState = JSON.parse(stored.get('ib_qq_official_settings_v1'));
  assert.equal(persistedCommandState.accounts[0].privateRoleSelections.length, 2,
    'private role selections persist in existing QQ Official settings across reload');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8'), context, {
    filename: 'qq-official.js-command-restart-restore'
  });
  await drain();
  commandState = window.IB.qqOfficialUI._getState().accounts[0];
  assert.deepEqual(Array.from(commandState.privateRoleSelections, row => row.roleId), ['role-group-existing', 'role-alt'],
    'per-user roles restore after UI/Dev restart');

  let panelReply = '';
  const panelQuery = privateCommand('panel-command', 'open-id-test', '', 'role-group-existing', sessionByUser['open-id-test']);
  await window.IB.qqOfficialUI._dispatchCommand(panelQuery, { name: 'who', args: '' }, reply => { panelReply = reply; return { ok: true, replied: true }; });
  assert.equal(panelReply.includes('Group Role'), true,
    'future official command-panel actions can enter through the same unified command router');

  const slowEvent = privateCommand('stale-provider-request', 'open-id-test', 'delayed old reply',
    'role-group-existing', sessionByUser['open-id-test']);
  const commitCountBeforeStale = calls.commit;
  const slowTask = window.IB.qqOfficialUI._processEvent(slowEvent);
  await drain();
  assert.equal(typeof deferredProviderResolve, 'function', 'the fake Provider request is in flight before switching');
  const beforeStaleReply = calls.complete.length;
  await window.IB.qqOfficialUI._processEvent(privateCommand('switch-during-provider', 'open-id-test', '/role Role',
    'role-group-existing', sessionByUser['open-id-test']));
  deferredProviderResolve({ ok: true, reply: 'late reply from old session' });
  await slowTask;
  assert.equal(calls.complete.slice(beforeStaleReply).some(row => row.requestId === 'stale-provider-request'
    && row.reply === 'late reply from old session'), false,
  'an old Provider completion cannot send after a role switch');
  assert.equal(calls.commit, commitCountBeforeStale, 'an old Provider result is not committed into the new session');

  /* Dev → formal confirmation is a local checkbox, distinct from the formal
     Bot's own Home Node state. A checkbox event must persist a boolean without
     rebuilding the page, then unblock the existing connect action. */
  const importedAppId = 'mock-app-formal-import';
  stored.set('ib_qq_official_settings_v1', JSON.stringify({
    paused: true,
    accounts: [{ appId: importedAppId, displayName: 'Imported Bot', roleId: 'role-existing', takeover: false,
      allowedUserOpenIds: ['open-id-test'], privateRoleSelections: [], groups: [], userNotes: {}, groupNotes: {}, memberNames: {},
      combinedIntentConsent: true, credentialSaved: true, sourceDisconnectRequired: true, sourceDisconnectedConfirmed: false }]
  }));
  Object.keys(listeners).forEach(key => { delete listeners[key]; });
  mount.__qqOfficialBound = false;
  migrationElements.preview.hidden = true;
  migrationElements.preview.innerHTML = '';
  migrationElements.confirm.checked = false;
  migrationElements.apply.disabled = true;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8'), context, {
    filename: 'qq-official.js-source-disconnect-confirmation'
  });
  await drain();
  let formalAccount = window.IB.qqOfficialUI._getState().accounts[0];
  assert.equal(formalAccount.sourceDisconnectRequired, true);
  assert.equal(formalAccount.sourceDisconnectedConfirmed, false);
  assert.equal(serverAccounts.find(row => row.appId === importedAppId).state, 'stopped',
    'the formal Bot runtime state is independent from the Dev disconnect confirmation');
  assert.equal(mount.innerHTML.includes('这是对 Dev 环境的手动确认'), true,
    'the UI explains that Dev state is manually confirmed while formal status is shown separately');
  assert.equal(mount.innerHTML.includes('展开高级设置确认 Dev 已断开'), true,
    'the disabled connection action points to the manual confirmation control');

  const formalAccountRow = { getAttribute: name => name === 'data-app-id' ? importedAppId : '' };
  const actionButton = action => ({
    getAttribute: name => name === 'data-qq-official-action' ? action : '',
    closest: selector => selector === '[data-qq-official-action]' ? actionButtonRef
      : (selector === '.qq-official-account' ? formalAccountRow : null)
  });
  let actionButtonRef = null;
  actionButtonRef = actionButton('connect');
  const connectCountBeforeConfirmation = calls.connect.length;
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  assert.equal(calls.connect.length, connectCountBeforeConfirmation,
    'the formal Bot cannot connect before Dev has been manually confirmed disconnected');

  const confirmationInput = {
    checked: true,
    getAttribute: name => name === 'data-qq-official-field' ? 'sourceDisconnectedConfirmed' : '',
    hasAttribute: () => false,
    closest: selector => selector === '.qq-official-account' ? formalAccountRow : null
  };
  const formalConfigWritesBeforeConfirmation = calls.config.length;
  const renderCountBeforeConfirmation = renderCount;
  listeners.change[0]({ target: confirmationInput });
  await drain();
  formalAccount = window.IB.qqOfficialUI._getState().accounts[0];
  assert.equal(formalAccount.sourceDisconnectedConfirmed, true,
    'the checkbox checked property is persisted as a boolean');
  assert.equal(JSON.parse(stored.get('ib_qq_official_settings_v1')).accounts[0].sourceDisconnectedConfirmed, true,
    'the confirmation survives a page reload from the existing local settings store');
  assert.equal(renderCount, renderCountBeforeConfirmation,
    'saving the local-only confirmation does not rebuild or close the settings page');
  assert.equal(calls.config.length, formalConfigWritesBeforeConfirmation,
    'the Dev-only manual confirmation is not sent to the formal Home Node');
  assert.equal(serverAccounts.find(row => row.appId === importedAppId).state, 'stopped',
    'confirming Dev disconnection does not falsely mark the formal Bot connected');

  actionButtonRef = actionButton('connect');
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  assert.equal(calls.connect.slice(connectCountBeforeConfirmation).includes(importedAppId), true,
    'the existing formal connection flow proceeds after Dev disconnect confirmation');
  assert.equal(window.IB.qqOfficialUI._getState().accounts[0].sourceDisconnectedConfirmed, true,
    'a connection status re-render does not discard the persisted Dev confirmation');
  Object.keys(listeners).forEach(key => { delete listeners[key]; });
  mount.__qqOfficialBound = false;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8'), context, {
    filename: 'qq-official.js-source-disconnect-reload'
  });
  await drain();
  assert.equal(window.IB.qqOfficialUI._getState().accounts[0].sourceDisconnectedConfirmed, true,
    'the Dev confirmation is restored after a module/page reload from local settings');
  assert.equal(serverAccounts.find(row => row.appId === importedAppId).state, 'online',
    'the formal Bot runtime status remains separately reported after reload');

  /* A settings re-render must rehydrate an in-memory migration preview and its
     confirmation. Changing the role diff invalidates that confirmation. */
  const migrationBundle = window.IB.qqOfficialUI._migrationExportBundle();
  migrationBundle.accounts[0].appId = 'mock-app-source-bundle';
  const migrationText = JSON.stringify(migrationBundle);
  const fileInput = {
    value: 'dev-config.json',
    files: [{ size: Buffer.byteLength(migrationText, 'utf8'), text: async () => migrationText }],
    hasAttribute: name => name === 'data-qq-migration-file',
    getAttribute: () => ''
  };
  listeners.change[0]({ target: fileInput });
  await drain();
  assert.equal(migrationElements.preview.hidden, false, 'selecting the bundle opens the migration diff preview');
  assert.equal(migrationElements.apply.disabled, true, 'import remains blocked before reviewing and confirming the diff');
  migrationElements.confirm.checked = true;
  listeners.change[0]({ target: migrationElements.confirm });
  assert.equal(migrationElements.apply.disabled, false, 'the existing migration confirmation enables the additive import');

  actionButtonRef = actionButton('pause');
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  assert.equal(migrationElements.preview.hidden, false, 'an ordinary settings re-render keeps the selected migration preview visible');
  assert.equal(migrationElements.confirm.checked, true, 'an unchanged migration confirmation survives ordinary re-rendering');
  assert.equal(migrationElements.apply.disabled, false, 'the unchanged diff remains actionable after re-rendering');
  const roleRef = migrationElements.preview.innerHTML.match(/data-qq-migration-role-map="([^"]+)"/);
  assert.ok(roleRef, 'the migration preview includes its role mapping controls');
  if (roleRef) {
    const roleMapInput = {
      value: 'role-alt',
      hasAttribute: name => name === 'data-qq-migration-role-map',
      getAttribute: name => name === 'data-qq-migration-role-map' ? roleRef[1] : ''
    };
    listeners.change[0]({ target: roleMapInput });
    assert.equal(migrationElements.confirm.checked, false, 'changing the reviewed role mapping clears its stale confirmation');
    assert.equal(migrationElements.apply.disabled, true, 'a changed migration diff needs the same existing confirmation again');
  }

  actionButtonRef = actionButton('disconnect');
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  assert.equal(mount.innerHTML.includes('官方 Bot 已断开；角色、白名单和 Vault 密钥仍保留。'), true,
    'a confirmed disconnect replaces the temporary disconnecting notice with its terminal state');
  assert.equal(mount.innerHTML.includes('正在断开官方 Bot…'), false);

  actionButtonRef = actionButton('connect');
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  assert.equal(mount.innerHTML.includes('正在连接 QQ 官方服务'), false,
    'an online status clears the temporary connecting notice');

  const originalConnect = remote.connect;
  remote.connect = async appId => {
    calls.connect.push(appId);
    return { ok: true, state: 'connecting' };
  };
  serverAccounts = serverAccounts.map(row => row.appId === importedAppId
    ? Object.assign({}, row, { state: 'reconnecting' }) : row);
  actionButtonRef = actionButton('connect');
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  assert.equal(mount.innerHTML.includes('QQ 官方服务正在重连…'), true,
    'a reconnecting Gateway updates the temporary notice instead of leaving stale connecting text');
  serverAccounts = serverAccounts.map(row => row.appId === importedAppId
    ? Object.assign({}, row, { state: 'online' }) : row);
  await window.IB.qqOfficialUI._refreshStatus();
  assert.equal(mount.innerHTML.includes('QQ 官方服务正在重连…'), false,
    'a recovered Gateway clears the reconnecting notice');

  remote.connect = async appId => {
    calls.connect.push(appId);
    return { ok: false, error: 'official-start-failed' };
  };
  serverAccounts = serverAccounts.map(row => row.appId === importedAppId
    ? Object.assign({}, row, { state: 'stopped' }) : row);
  actionButtonRef = actionButton('connect');
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  assert.equal(mount.innerHTML.includes('QQ Bot 连接失败；请检查凭据和本机网络。'), true,
    'a rejected connect request replaces connecting text with the failure notice');
  assert.equal(mount.innerHTML.includes('正在连接 QQ 官方服务'), false);

  let resolveOldConnect;
  remote.connect = appId => {
    calls.connect.push(appId);
    return new Promise(resolve => { resolveOldConnect = resolve; });
  };
  actionButtonRef = actionButton('connect');
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  const staleConnectResponse = resolveOldConnect;
  remote.connect = async appId => {
    calls.connect.push(appId);
    connectedAppIds[appId] = true;
    serverAccounts = serverAccounts.map(row => row.appId === appId ? Object.assign({}, row, { state: 'online' }) : row);
    return { ok: true, state: 'connecting' };
  };
  actionButtonRef = actionButton('connect');
  listeners.click[0]({ target: actionButtonRef });
  await drain();
  assert.equal(mount.innerHTML.includes('正在连接 QQ 官方服务'), false,
    'the latest successful connect state clears its pending notice');
  staleConnectResponse({ ok: false, error: 'official-start-failed' });
  await drain();
  assert.equal(mount.innerHTML.includes('QQ Bot 连接失败；请检查凭据和本机网络。'), false,
    'a late failure from an older connect attempt cannot overwrite the newer online state');
  remote.connect = originalConnect;

  console.log('QQ Official frontend secret and default-permission checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
