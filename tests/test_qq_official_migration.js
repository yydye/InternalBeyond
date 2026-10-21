'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../assets/js/qq-official.js'), 'utf8');
const SETTINGS_KEY = 'ib_qq_official_settings_v1';

async function drain() {
  for (let index = 0; index < 12; index++) await new Promise(resolve => setImmediate(resolve));
}

function makeHarness(initialState, roles) {
  const stored = new Map();
  if (initialState) stored.set(SETTINGS_KEY, JSON.stringify(initialState));
  const localStorage = {
    getItem: key => stored.has(key) ? stored.get(key) : null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key)
  };
  const listeners = Object.create(null);
  const calls = { configure: [], connect: [], disconnect: [], vault: [] };
  const nodes = {
    status: { textContent: '' },
    preview: { hidden: true, innerHTML: '' },
    clear: { hidden: true },
    confirm: {
      checked: false,
      hasAttribute: name => name === 'data-qq-migration-confirm',
      getAttribute: () => ''
    },
    apply: { disabled: true }
  };
  const mount = {
    innerHTML: '',
    addEventListener(type, handler) { (listeners[type] || (listeners[type] = [])).push(handler); },
    querySelectorAll() { return []; },
    querySelector(selector) {
      if (selector === '[data-migration-status]') return nodes.status;
      if (selector === '[data-migration-preview]') return nodes.preview;
      if (selector === '[data-migration-clear]') return nodes.clear;
      if (selector === '[data-qq-migration-confirm]') return nodes.confirm;
      if (selector === '[data-migration-apply]') return nodes.apply;
      return null;
    }
  };
  let serverPaused = true;
  let serverAccounts = [];
  const remote = {
    configure: async input => {
      calls.configure.push(JSON.parse(JSON.stringify(input)));
      serverPaused = input.paused;
      serverAccounts = input.accounts.map(account => Object.assign({}, account, {
        state: 'stopped', pendingUserOpenIds: [], pendingGroupOpenIds: [],
        groups: (account.groups || []).map(group => ({
          groupOpenId: group.groupOpenId, roleId: group.roleId, takeover: group.takeover,
          adminMemberCount: (group.adminMemberOpenIds || []).length, pendingAdminMemberOpenIds: []
        }))
      }));
      return { ok: true, accounts: serverAccounts, paused: serverPaused };
    },
    status: async () => ({ ok: true, accounts: serverAccounts, paused: serverPaused, clientActive: true }),
    heartbeat: async () => ({ ok: true, clientActive: true }),
    connect: async appId => { calls.connect.push(appId); return { ok: true, state: 'connecting' }; },
    disconnect: async appId => { calls.disconnect.push(appId); return { ok: true }; },
    poll: async () => ({ ok: true, event: null }),
    progress: async () => ({ ok: true }),
    complete: async () => ({ ok: true })
  };
  const roleRows = roles || [
    { id: 'dev-role-main', name: 'Alpha' },
    { id: 'dev-role-private', name: 'Beta' }
  ];
  const roleApi = {
    refreshRoleCatalog: async () => ({ state: 'ready', roles: roleRows }),
    _roleCatalogSnapshot: () => ({ state: 'ready', roles: roleRows }),
    _roleOptions: selected => roleRows.map(role => '<option value="' + role.id + '"'
      + (role.id === selected ? ' selected' : '') + '>' + role.name + '</option>').join(''),
    _roleAvailability: role => ({ available: roleRows.some(item => item.id === role.id), reason: '' }),
    _conversationReset: () => true
  };
  const window = {
    IB: { homeNode: { qqOfficial: remote }, qqOnebot: roleApi },
    _ibWriteVaultCredential: async (ref, config, secret) => { calls.vault.push({ ref, config, secret }); return ref; },
    _ibDeleteVaultCredential: async ref => ({ credentialRef: ref, removed: 1 })
  };
  const document = {
    readyState: 'complete',
    getElementById: id => id === 'qq-official-app' ? mount : null,
    addEventListener() {}
  };
  const context = {
    window, document, localStorage, Promise, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, console
  };
  vm.runInNewContext(SOURCE, context, { filename: 'qq-official.js-migration' });
  return { calls, context, listeners, mount, nodes, stored, ui: window.IB.qqOfficialUI };
}

async function main() {
  const source = makeHarness({
    paused: false,
    accounts: [{
      appId: 'dev-bot-001', displayName: '开发测试 Bot', roleId: 'dev-role-main', takeover: true,
      allowedUserOpenIds: ['user-one', 'user-two'],
      privateRoleSelections: [{ userOpenId: 'user-one', roleId: 'dev-role-private', sessionId: 'dev-private-session' }],
      groups: [{ groupOpenId: 'group-one', roleId: 'dev-role-private', takeover: true,
        adminMemberOpenIds: ['member-one'], sessionId: 'dev-group-session' }],
      userNotes: { 'user-one': '小林', 'user-two': '阿南' }, groupNotes: { 'group-one': '测试群' },
      memberNames: { 'group-one|member-one': '群管理员' },
      combinedIntentConsent: true, credentialSaved: true
    }]
  });
  await drain();
  const bundle = source.ui._migrationExportBundle();
  const serialized = JSON.stringify(bundle);
  assert.equal(bundle.schema, 'internalbeyond.qq-official-config');
  assert.equal(bundle.commandProfile, 'qq-official-p2.1-text-v1');
  assert.equal(bundle.accounts[0].displayName, '开发测试 Bot');
  assert.deepEqual(Array.from(bundle.accounts[0].privateRoleSelections, row => row.roleId), ['dev-role-private']);
  assert.deepEqual(Array.from(bundle.accounts[0].groups[0].adminMemberOpenIds), ['member-one']);
  for (const forbidden of ['credentialRef', 'appSecret', 'apiKey', 'dev-private-session', 'dev-group-session', 'combinedIntentConsent']) {
    assert.equal(serialized.includes(forbidden), false, 'export omits ' + forbidden);
  }
  assert.doesNotThrow(() => source.ui._validateMigrationBundle(bundle));
  const contaminated = JSON.parse(serialized);
  contaminated.accounts[0].credentialRef = 'dev-vault-ref';
  assert.throws(() => source.ui._validateMigrationBundle(contaminated), /migration-credential-field-forbidden/,
    'import rejects a Dev credential reference instead of copying it');

  const target = makeHarness(null, [
    { id: 'prod-role-main', name: 'Alpha' },
    { id: 'prod-role-private', name: 'Beta' }
  ]);
  await drain();
  assert.equal(target.mount.innerHTML.includes('Dev → 正式版配置迁移'), true,
    'migration entry is available even when the target has no Bot yet');
  const file = {
    files: [{ size: Buffer.byteLength(serialized), text: async () => serialized }], value: '',
    hasAttribute: name => name === 'data-qq-migration-file', getAttribute: () => null
  };
  target.listeners.change[0]({ target: file });
  await drain();
  assert.equal(target.nodes.preview.hidden, false);
  assert.equal(target.nodes.preview.innerHTML.includes('开发测试 Bot'), true);
  assert.equal(target.nodes.preview.innerHTML.includes('AppSecret'), false);
  assert.equal(target.nodes.apply.disabled, true, 'import remains disabled before the explicit diff confirmation');

  const migrationButton = action => {
    const button = { getAttribute: name => name === 'data-qq-official-action' ? action : null };
    button.closest = selector => selector === '[data-qq-official-action]' ? button : null;
    return button;
  };
  target.listeners.click[0]({ target: migrationButton('migration-apply') });
  await drain();
  assert.equal(target.ui._getState().accounts.length, 0, 'no formal settings are written before confirmation');
  assert.equal(target.calls.configure.at(-1).accounts.length, 0);

  target.nodes.confirm.checked = true;
  target.listeners.change[0]({ target: target.nodes.confirm });
  assert.equal(target.nodes.apply.disabled, false, 'diff confirmation enables the final import action');
  target.listeners.click[0]({ target: migrationButton('migration-apply') });
  await drain();

  const imported = target.ui._getState();
  assert.equal(imported.paused, false, 'global pause state migrates into an empty target');
  assert.equal(imported.accounts.length, 1);
  const account = imported.accounts[0];
  assert.equal(account.appId, 'dev-bot-001');
  assert.equal(account.roleId, 'prod-role-main', 'source role maps by unique role name to the existing target role');
  assert.equal(account.combinedIntentConsent, false, 'official message scope must be confirmed again in the target');
  assert.equal(account.credentialSaved, false, 'Vault credentials are not copied');
  assert.equal(account.sourceDisconnectRequired, true);
  assert.equal(account.sourceDisconnectedConfirmed, false);
  assert.equal(account.takeover, true);
  assert.deepEqual(Array.from(account.allowedUserOpenIds), ['user-one', 'user-two']);
  assert.deepEqual(Array.from(account.privateRoleSelections, row => [row.userOpenId, row.roleId]), [
    ['user-one', 'prod-role-private'], ['user-two', 'prod-role-main']
  ], 'per-user bindings migrate and users without overrides get a fresh default-role session');
  assert.equal(account.privateRoleSelections.every(row => row.sessionId !== 'default'), true);
  assert.equal(account.groups[0].roleId, 'prod-role-private');
  assert.equal(account.groups[0].takeover, true);
  assert.deepEqual(Array.from(account.groups[0].adminMemberOpenIds), ['member-one']);
  assert.equal(account.groups[0].sessionId !== 'dev-group-session', true, 'group context identity is regenerated');
  assert.equal(account.userNotes['user-one'], '小林');
  assert.equal(account.groupNotes['group-one'], '测试群');
  assert.equal(account.memberNames['group-one|member-one'], '群管理员');
  assert.equal(target.calls.connect.length, 0, 'import does not start a QQ Bot');
  assert.equal(target.calls.vault.length, 0, 'import never writes or reads a credential');
  const configured = target.calls.configure.at(-1).accounts[0];
  assert.equal(configured.combinedIntentConsent, false);
  assert.equal(Object.prototype.hasOwnProperty.call(configured, 'credentialRef'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(configured, 'appSecret'), false);

  const connectButton = {
    getAttribute: name => name === 'data-qq-official-action' ? 'connect' : null,
    closest: selector => selector === '[data-qq-official-action]' ? connectButton
      : selector === '.qq-official-account' ? { getAttribute: () => 'dev-bot-001' } : null
  };
  target.listeners.click[0]({ target: connectButton });
  await drain();
  assert.equal(target.calls.connect.length, 0, 'source disconnection and Vault rebind gate connection attempts');

  console.log('QQ Official migration preview, secret boundary, role mapping, and connection guard passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
