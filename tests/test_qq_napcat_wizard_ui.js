'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const QQCore = require('../assets/js/qq-onebot-core.js');
const providerDirectory = require('../assets/js/provider-directory.js');

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

async function main() {
  const values = new Map();
  const accountSettings = {
    paused: true,
    accounts: [
      { accountId: '12345678', roleId: 'role-a', takeover: false, allowedPrivateUserIds: [], allowedGroupIds: [] },
      { accountId: '87654321', roleId: 'role-b', takeover: false, allowedPrivateUserIds: [], allowedGroupIds: [] }
    ]
  };
  values.set('ib_qq_onebot_settings_v1', JSON.stringify(accountSettings));
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value)
  };
  const clickListeners = [];
  const changeListeners = [];
  const submitListeners = [];
  const scheduledTimeouts = [];
  const intervalCallbacks = [];
  const calls = { release: 0, download: [], downloadCancels: 0, config: [], starts: [] };
  const roleConfigs = {
    'role-a': { id: 'role-a', nickname: 'Role A', provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-v4-flash', credentialRef: 'role-a' },
    'role-b': { id: 'role-b', nickname: 'Role B', provider: 'qwen', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: '', credentialRef: 'role-b' },
    'role-c': { id: 'role-c', nickname: 'Role C', provider: 'removed-provider', endpoint: 'https://api.invalid/v1/chat/completions', model: 'model-c', credentialRef: 'role-c' },
    'role-d': { id: 'role-d', nickname: 'Role D', provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-v4-flash', credentialRef: '' }
  };
  let currentRoles = [];
  let hideRoles = false;
  let forceRoleUnavailable = false;
  let roleLoadCount = 0;
  let bundleVerified = false;
  let failNextDownloadStatus = false;
  let downloadStatusState = { ok: true, state: 'idle', active: false, receivedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, etaSeconds: null, error: '' };
  let confirmRuntimeStart = false;
  let providerFailure = false;
  let remoteStatusRows = [];
  const runningAccounts = Object.create(null);
  const accountPhases = Object.create(null);
  const windowListeners = Object.create(null);
  const accountRows = Object.create(null);
  function fakeAccountRow(accountId) {
    const selectors = [
      '[data-account-state]', '[data-qq-account-error]', '.qq-onebot-connection span',
      '[data-napcat-account-state]', '[data-napcat-error]', '[data-napcat-signature-warning]',
      '[data-napcat-diagnostic]', '[data-napcat-diagnostic-text]', '[data-napcat-account-progress]',
      '[data-qq-action="napcat-start"]', '[data-qq-action="napcat-open"]',
      '[data-qq-action="napcat-stop"]', '[data-qq-action="napcat-cancel"]'
    ];
    const nodes = Object.create(null);
    selectors.forEach(selector => { nodes[selector] = { textContent: '', hidden: true, disabled: false, value: 0 }; });
    return { getAttribute: name => name === 'data-account' ? accountId : '', querySelector: selector => nodes[selector] || null, nodes };
  }
  ['12345678', '87654321'].forEach(id => { accountRows[id] = fakeAccountRow(id); });
  const host = {
    innerHTML: '',
    __qqOnebotDelegatesInstalled: false,
    addEventListener: (name, callback) => {
      if (name === 'click') clickListeners.push(callback);
      if (name === 'change') changeListeners.push(callback);
    },
    querySelectorAll: selector => selector === '.qq-onebot-account' ? Object.keys(accountRows).map(id => accountRows[id]) : []
  };
  const wizard = { innerHTML: '' };
  const statusNode = { textContent: '', dataset: {} };
  const addForm = {
    elements: { accountId: { value: '44556677' }, roleId: { value: 'role-a' } },
    addEventListener: (name, callback) => { if (name === 'submit') submitListeners.push(callback); },
    reset: () => {}
  };
  const document = {
    readyState: 'complete',
    getElementById: id => ({
      'qq-onebot-app': host,
      'qq-napcat-wizard': wizard,
      'qq-onebot-status': statusNode,
      'qq-onebot-add-form': addForm
    })[id] || null,
    querySelector: selector => {
      const match = String(selector || '').match(/data-account="(\d{5,12})"/);
      return match ? accountRows[match[1]] || null : null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  const release = {
    tag: 'v4.18.38',
    releaseUrl: 'https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.38',
    assetName: 'NapCat.Shell.Windows.Node.zip',
    size: 2 * 1024 * 1024,
    sha256: 'a'.repeat(64)
  };
  const remote = {
    configure: async input => { calls.config.push(input); return { ok: true }; },
    status: async () => ({ ok: true, clientActive: true, accounts: remoteStatusRows }),
    complete: async () => ({ ok: true }),
    heartbeat: async () => ({ ok: true }),
    poll: async () => ({ ok: true, event: null }),
    napcatEnvironment: async () => ({ ok: true, supported: true, canWrite: true, platform: 'win32', architecture: 'x64', destination: bundleVerified ? 'downloaded' : 'available', installDirectory: 'C:\\IB-test\\components\\qq-napcat-node-p1-2', existingQQScanned: false }),
    napcatDownloadStatus: async () => {
      if (failNextDownloadStatus) { failNextDownloadStatus = false; throw new Error('temporary-status-read-failure'); }
      return Object.assign({}, downloadStatusState);
    },
    napcatLatestRelease: async () => { calls.release++; return { ok: true, release }; },
    napcatStartDownload: async confirmation => {
      calls.download.push(confirmation);
      bundleVerified = false;
      const resumeBytes = downloadStatusState.resumeAvailable ? Number(downloadStatusState.receivedBytes) || 0 : 0;
      downloadStatusState = { ok: true, state: 'downloading', active: true, receivedBytes: resumeBytes, totalBytes: release.size, speedBytesPerSecond: 0, etaSeconds: null, error: '' };
      return { ok: true, started: true };
    },
    napcatCancelDownload: async () => {
      calls.downloadCancels++;
      downloadStatusState = Object.assign({}, downloadStatusState, { state: 'failed', active: false, totalBytes: release.size,
        resumeAvailable: true, error: 'download-cancelled' });
      return { ok: true, cancelling: true };
    },
    napcatOpenFolder: async () => ({ ok: true }),
    napcatRemoveDownload: async () => ({ ok: true, installDataPreserved: true }),
    setup: async accountId => ({ ok: true, callbackUrl: 'http://127.0.0.1:23118/qq/onebot/v11/' + accountId + '?token=synthetic-' + accountId }),
    napcatAccountStatus: async accountId => Object.assign({
      ok: true, accountId, installed: !!runningAccounts[accountId], running: !!runningAccounts[accountId], state: runningAccounts[accountId] ? 'running' : 'not-installed'
    }, accountPhases[accountId] || {}),
    napcatStartAccount: async input => { calls.starts.push(input); runningAccounts[input.accountId] = true; return { ok: true, started: true }; },
    napcatCancelAccountStart: async () => ({ ok: true }),
    napcatStopAccount: async accountId => { runningAccounts[accountId] = false; return { ok: true } },
    napcatOpenWebUi: async () => ({ ok: true })
  };
  const window = {
    IBQQOneBotCore: QQCore,
    PROVIDERS_DIR: providerDirectory,
    addEventListener: (name, callback) => { windowListeners[name] = callback; },
    confirm: () => confirmRuntimeStart,
    _messageApiConfig: input => roleConfigs[input && input.friendId] || null,
    _ibApiHasCredential: config => !!String(config && (Object.prototype.hasOwnProperty.call(config, 'credentialRef') ? config.credentialRef : config.id) || '').trim(),
    _ibApiReady: config => !forceRoleUnavailable && !!(config && config.endpoint && config.model && window._ibApiHasCredential(config)),
    _ibIsLoopbackEndpoint: endpoint => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::|\/|$)/i.test(String(endpoint || '')),
    loadApiConfigs: async () => {
      roleLoadCount++;
      await Promise.resolve();
      currentRoles = hideRoles ? [] : Object.keys(roleConfigs).map(id => {
        const config = roleConfigs[id];
        return { id, name: config.nickname, provider: config.provider, model: config.model, ready: window._ibApiReady(config) };
      });
    },
    IB: {
      roleDm: { listCharacters: () => currentRoles },
      homeNode: { qqOnebot: remote, runtime: {} },
      chat: { callExternalReply: async () => { if (providerFailure) throw new Error('synthetic-provider-failure'); return 'reply'; } }
    }
  };
  const context = {
    window, document, localStorage: storage, console, Promise, URL,
    setTimeout: (callback, delay) => { const timer = { callback, delay, cleared: false }; scheduledTimeouts.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; }, setInterval: callback => { intervalCallbacks.push(callback); return intervalCallbacks.length; },
    navigator: {}
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets/js/qq-onebot.js'), 'utf8');
  assert.match(source, /OneBot 鉴权失败/);
  assert.match(source, /已暂停接管/);
  assert.match(source, /Provider 错误/);
  assert.match(source, /callbackAuthError/);
  vm.runInNewContext(source, context, { filename: 'qq-onebot.js' });
  assert.match(host.innerHTML, /正在读取现有角色/);
  await flush();

  assert.equal(window.IB.qqOnebot._getState().paused, true, 'fresh onboarding starts with global takeover paused');
  assert.equal(roleLoadCount, 1, 'QQ loads the existing API role catalog before rendering selector choices');
  assert.match(host.innerHTML, /Role A/);
  assert.match(host.innerHTML, /角色配置不可用：缺少模型/);
  assert.match(host.innerHTML, /Provider 不可用：当前 Provider 目录不包含/);
  assert.match(host.innerHTML, /未绑定 Credential Vault/);
  assert.match(host.innerHTML, /Credential Vault 不读取密钥，只在回复请求时按绑定解析/);
  assert.match(host.innerHTML, /value="role-b" selected disabled/);
  assert.match(wizard.innerHTML, /GUIDED SETUP/);
  assert.match(wizard.innerHTML, /官方发布/);
  assert.match(wizard.innerHTML, /已有 QQ 安装和登录资料不会被复用、读取或清理/);
  assert.match(wizard.innerHTML, /限制商业用途/);

  remoteStatusRows = [{ accountId: '12345678', state: 'waiting', paused: false, callbackAuthError: 'signature-missing' }];
  intervalCallbacks[0]();
  await flush();
  assert.equal(accountRows['12345678'].nodes['[data-account-state]'].textContent, '已暂停接管',
    'the takeover pause remains visible while the account explains its callback failure');
  assert.match(accountRows['12345678'].nodes['[data-qq-account-error]'].textContent, /缺少 HMAC 签名/);
  await window.IB.qqOnebot.resume();
  intervalCallbacks[0]();
  await flush();
  assert.equal(accountRows['12345678'].nodes['[data-account-state]'].textContent, 'OneBot 鉴权失败');

  remoteStatusRows = [{ accountId: '12345678', state: 'waiting', paused: false, callbackAuthError: '' }];
  intervalCallbacks[0]();
  values.set('ib_qq_onebot_settings_v1', JSON.stringify({ paused: false, accounts: [
    { accountId: '12345678', roleId: 'role-a', takeover: true, allowedPrivateUserIds: ['23456789'], allowedGroupIds: [] },
    { accountId: '87654321', roleId: 'role-b', takeover: false, allowedPrivateUserIds: [], allowedGroupIds: [] }
  ] }));
  windowListeners.storage({ key: 'ib_qq_onebot_settings_v1' });
  await flush();
  providerFailure = true;
  const providerResult = await window.IB.qqOnebot._processEvent({
    requestId: 'provider-ui-failure', accountId: '12345678', roleId: 'role-a', messageType: 'private',
    peerId: '23456789', friendId: 'qq_12345678_23456789', conversationId: 'dm:qq_12345678_23456789', text: 'synthetic'
  });
  assert.equal(providerResult.error, 'provider-failed');
  assert.equal(accountRows['12345678'].nodes['[data-account-state]'].textContent, 'Provider 错误');
  assert.match(accountRows['12345678'].nodes['[data-qq-account-error]'].textContent, /Provider 请求失败/);
  providerFailure = false;
  await window.IB.qqOnebot._processEvent({
    requestId: 'provider-ui-recovered', accountId: '12345678', roleId: 'role-a', messageType: 'private',
    peerId: '23456789', friendId: 'qq_12345678_23456789', conversationId: 'dm:qq_12345678_23456789', text: 'synthetic'
  });
  await window.IB.qqOnebot.pause();
  values.set('ib_qq_onebot_settings_v1', JSON.stringify(accountSettings));
  windowListeners.storage({ key: 'ib_qq_onebot_settings_v1' });
  await flush();

  hideRoles = true;
  await window.IB.qqOnebot.refreshRoleCatalog();
  assert.match(host.innerHTML, /尚未添加角色/);
  assert.doesNotMatch(host.innerHTML, /没有可用角色/);
  hideRoles = false;
  await window.IB.qqOnebot.refreshRoleCatalog();
  assert.match(host.innerHTML, /Role A/);
  forceRoleUnavailable = true;
  await window.IB.qqOnebot.refreshRoleCatalog();
  assert.match(host.innerHTML, /已发现 4 个角色，但没有可接入角色/);
  assert.match(host.innerHTML, /角色配置不可用：现有 API 就绪检查未通过/);
  forceRoleUnavailable = false;
  await window.IB.qqOnebot.refreshRoleCatalog();

  accountPhases['12345678'] = { state: 'installing', phase: 'extracting', installed: false, running: false, progressBytes: 512, totalBytes: 1024 };
  windowListeners.storage({ key: 'ib_qq_onebot_settings_v1' });
  await flush();
  windowListeners.storage({ key: 'ib_qq_onebot_settings_v1' });
  assert.match(host.innerHTML, /正在安全解压账号副本/);
  accountPhases['12345678'] = { state: 'starting', phase: 'launching', installed: true, running: true,
    callbackSignatureConfigured: false, callbackRestartRequired: true };
  windowListeners.storage({ key: 'ib_qq_onebot_settings_v1' });
  await flush();
  windowListeners.storage({ key: 'ib_qq_onebot_settings_v1' });
  assert.match(host.innerHTML, /正在启动 NapCat/);
  assert.match(host.innerHTML, /尚未加载 OneBot HMAC 签名配置/);
  accountPhases['12345678'] = { state: 'failed', phase: 'exited', installed: true, running: false,
    error: 'napcat-exit-0', diagnostic: '[stderr] node.exe: bad option: --no-sandbox' };
  windowListeners.storage({ key: 'ib_qq_onebot_settings_v1' });
  await flush();
  windowListeners.storage({ key: 'ib_qq_onebot_settings_v1' });
  assert.match(host.innerHTML, /启动失败/);
  assert.match(host.innerHTML, /NapCat 子进程启动后自行退出/);
  assert.match(host.innerHTML, /查看启动诊断/);
  assert.match(host.innerHTML, /node\.exe: bad option: --no-sandbox/);

  const settingsCenter = require('../assets/js/settings-center.js');
  let categoryClick = null;
  const servicesButton = {
    getAttribute: name => name === 'data-settings-category' ? 'services' : '',
    setAttribute: () => {}, removeAttribute: () => {},
    classList: { toggle: () => {} },
    addEventListener: (_name, callback) => { categoryClick = callback; }
  };
  const servicesPanel = { hidden: true, getAttribute: () => 'services' };
  const nav = { querySelectorAll: () => [servicesButton] };
  const content = { querySelectorAll: () => [servicesPanel] };
  const settingsPage = {
    __ibSettingsCenterMounted: false,
    querySelector: selector => selector === '.settings-center-nav' ? nav : (selector === '.settings-center-content' ? content : null),
    getAttribute: () => 'general', setAttribute: () => {},
    classList: { contains: () => true }
  };
  const settingsDocument = {
    getElementById: id => id === 'page-settings' ? settingsPage : (id === 'settings-category-services' ? servicesPanel : null),
    addEventListener: () => {}, body: null
  };
  const mountedSettings = settingsCenter.mount(settingsDocument, window);
  const loadsBeforeServices = roleLoadCount;
  mountedSettings.setCategory('services');
  await flush();
  assert.equal(roleLoadCount, loadsBeforeServices + 1, 'opening Services reloads the Role DM catalog after Settings hydrates API configs');
  assert.ok(categoryClick, 'the visible Services category remains wired to the existing Settings Center');

  const click = target => clickListeners.forEach(callback => callback({ target }));
  const runScheduledPoll = async delay => {
    const timer = scheduledTimeouts.slice().reverse().find(item => !item.cleared && item.delay === delay);
    assert.ok(timer, 'expected download status poll at ' + delay + 'ms');
    timer.cleared = true;
    timer.callback();
    await flush();
  };
  const action = name => ({
    closest: selector => selector === '[data-qq-napcat-action]' ? action(name) : null,
    getAttribute: key => key === 'data-qq-napcat-action' ? name : ''
  });
  click(action('release'));
  await flush();
  assert.equal(calls.release, 1);
  assert.match(wizard.innerHTML, /v4\.18\.38/);

  click(action('download'));
  await flush();
  assert.equal(calls.download.length, 0, 'download is blocked until the displayed consent checkbox is checked');
  changeListeners.forEach(callback => callback({ target: {
    hasAttribute: name => name === 'data-napcat-confirm', checked: true
  } }));
  assert.match(wizard.innerHTML, /checked/);
  click(action('download'));
  await flush();
  assert.equal(calls.download.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.download[0])), { confirmed: true, tag: 'v4.18.38', sha256: 'a'.repeat(64) });
  downloadStatusState = Object.assign({}, downloadStatusState, { receivedBytes: 1024 * 1024, speedBytesPerSecond: 512 * 1024, etaSeconds: 2 });
  await runScheduledPoll(650);
  assert.match(wizard.innerHTML, /50%/);
  assert.match(wizard.innerHTML, /1\.0 MB \/ 2\.0 MB/);
  assert.match(wizard.innerHTML, /512 KB\/s/);
  assert.match(wizard.innerHTML, /剩余约 2 秒/);
  assert.match(wizard.innerHTML, /<progress max="100" value="50"><\/progress>/);

  downloadStatusState = Object.assign({}, downloadStatusState, { receivedBytes: 128 * 1024, totalBytes: 0, etaSeconds: null });
  await runScheduledPoll(650);
  assert.match(wizard.innerHTML, /总大小未知/);
  assert.match(wizard.innerHTML, /<progress max="100"><\/progress>/, 'unknown totals use the native indeterminate progress state');

  failNextDownloadStatus = true;
  await runScheduledPoll(650);
  assert.match(wizard.innerHTML, /正在重试读取进度/);
  assert.ok(scheduledTimeouts.some(timer => !timer.cleared && timer.delay === 1500), 'a transient poll failure schedules a retry');

  click(action('cancel'));
  await flush();
  assert.equal(calls.downloadCancels, 1);
  assert.match(wizard.innerHTML, /下载已取消/);
  assert.match(wizard.innerHTML, /安全分段已保留/);
  assert.match(wizard.innerHTML, /继续下载/);
  assert.match(wizard.innerHTML, /data-qq-napcat-action="retry"/);

  click(action('retry'));
  await flush();
  assert.equal(calls.release, 2);
  changeListeners.forEach(callback => callback({ target: {
    hasAttribute: name => name === 'data-napcat-confirm', checked: true
  } }));
  click(action('download'));
  await flush();
  assert.equal(calls.download.length, 2, 'cancelled downloads can be explicitly retried');
  assert.match(wizard.innerHTML, /6%/);
  downloadStatusState = Object.assign({}, downloadStatusState, { state: 'verifying', active: true, totalBytes: release.size, receivedBytes: release.size });
  await runScheduledPoll(650);
  assert.match(wizard.innerHTML, /正在校验 SHA-256/);
  assert.match(wizard.innerHTML, /<progress max="100"><\/progress>/);
  downloadStatusState = { ok: true, state: 'verified', active: false, receivedBytes: release.size, totalBytes: release.size, speedBytesPerSecond: 0, etaSeconds: null, error: '' };
  bundleVerified = true;
  click(action('environment'));
  await flush();
  assert.match(wizard.innerHTML, /下载完成并通过 SHA-256 校验/);
  assert.equal(window.IB.qqOnebot._getState().paused, true, 'downloading the component does not enable AI takeover');
  assert.equal(window.IB.qqOnebot._getState().accounts.every(account => account.takeover === false), true, 'accounts remain manual until individually enabled');

  const accountAction = (accountId, actionName) => {
    const row = { getAttribute: name => name === 'data-account' ? accountId : '' };
    const button = {
      getAttribute: name => name === 'data-qq-action' ? actionName : '',
      closest: selector => selector === '[data-qq-action]' ? button : (selector === '.qq-onebot-account' ? row : null)
    };
    return button;
  };
  click(accountAction('12345678', 'napcat-start'));
  await flush();
  assert.equal(calls.starts.length, 0, 'declining the per-account launch prompt prevents process start');
  confirmRuntimeStart = true;
  click(accountAction('12345678', 'napcat-start'));
  await flush();
  click(accountAction('87654321', 'napcat-start'));
  await flush();
  assert.equal(calls.starts.length, 2, 'each account starts only after its own visible confirmation');
  assert.equal(calls.starts[0].callbackUrl.includes('12345678'), true);
  assert.equal(calls.starts[1].callbackUrl.includes('87654321'), true);
  assert.equal(window.IB.qqOnebot._getState().paused, true, 'starting NapCat does not enable AI takeover');

  const disconnectedRow = { getAttribute: name => name === 'data-account' ? '12345678' : '' };
  const disconnectButton = {
    getAttribute: name => name === 'data-qq-action' ? 'remove' : '',
    closest: selector => selector === '[data-qq-action]' ? disconnectButton : (selector === '.qq-onebot-account' ? disconnectedRow : null)
  };
  click(disconnectButton);
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(window.IB.qqOnebot._getState().accounts.map(account => account.accountId))), ['87654321'], 'disconnect removes only the selected account binding');
  assert.equal(calls.config[calls.config.length - 1].accounts[0].accountId, '87654321', 'other QQ accounts remain independently configured');

  const add = submitListeners[submitListeners.length - 1];
  assert.equal(typeof add, 'function');
  add({ preventDefault: () => {} });
  await flush();
  const added = window.IB.qqOnebot._getState().accounts.find(account => account.accountId === '44556677');
  assert.equal(added.roleId, 'role-a', 'a role from the existing Role DM catalog can be bound to a new QQ account');
  assert.equal(added.takeover, false, 'binding a role keeps the QQ account in manual mode');
  assert.ok(calls.config[calls.config.length - 1].accounts.some(account => account.accountId === '44556677' && account.roleId === 'role-a'));

  console.log('QQ NapCat wizard UI checks passed');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
