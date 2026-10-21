'use strict';

// Synthetic-only Coding acceptance in the already running Tauri WebView2.
// Uses the Work Mode Consent ledger, Workspace IndexedDB and loopback Fake Provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(__dirname, '../../DeepSeek-Harness-Mock-PoC'));
const { chromium } = createRequire(path.join(source, 'apps/web/package.json'))('playwright');
const devServiceContract = require('../runtime/dev-service-contract.js');
const { createSyntheticFakeProvider } = require('../runtime/dev-synthetic-seed.js');
const output = path.resolve(__dirname, '../.dsh-research/the-lost-beyond-coding-p3');
const REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const FIXTURE = Object.freeze({ projectRef: 'dsh_synthetic_workspace', profileRef: 'dsh_synthetic_agent',
  alternateRoleRef: 'dsh_synthetic_agent_alt', fileId: 'dsh_synthetic_readme', filePath: 'src/synthetic.js' });
const CODING_TOOLS = ['project.read_file', 'project.create_file', 'project.update_file'];
const AVATAR_ALPHA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAABHElEQVR4nO3RwQ3CMAyF4S7DgSsMgcQKTMFArMAejMAADMCpR1CRIqKSJo7zbCc0kXxrnP9Th6Gf79nsjy/KWHf+HGp4dZDT+cIK92faYRKOiPcRKhD3EDJ+jhCDSMaLI/zFWgAYQiteBDFfZgFgI0KLrADZiKUlloAsRNMAy3gIInbZ+g8kAanLNQCiiKYBlIu1AIKI1QCet6tY/LS7AygAyTEDbHcHcmTs2/4HOqB2gCQip6EDmgZIIHLf/z+AJQISzwEgEJw3FwHaCHg8F8BBcN9JAriI+2P8TCrcfScWnwNwMaUDB1AQqHgqIis+hkCHUyCs+BBCOj6EKIr3EVrxPgISPx3teDdNx8MQTQOs44sQ1tHFCOvg1QDepNnAetb78VwAAAAASUVORK5CYII=';
const AVATAR_BETA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAABG0lEQVR4nO3RMQ7CMAyF4V6HDTGzMXAeLsFREMfgFqzMzN1BRYqISpo4zrOd0ETy1jj/pw5DP9+z3x5elLHu/DnU8Oogp/OFFe7PtMMkHBHvI1Qg7iFk/BwhBpGMF0f4i7UAMIRWvAhivswCwEaEFlkBshFLSywBWYimAZbxEETssvUfSAJSl2sARBFNAygXawEEEasBPG9XsfhpdwdQAJJjBtjsjuTI2Lf9D3RA7QBJRE5DBzQNkEDkvv9/AEsEJJ4DQCA4by4CtBHweC6Ag+C+kwRwEY/7+JlUuPtOLD4H4GJKBw6gIFDxVERWfAyBDqdAWPEhhHR8CFEU7yO04n0EJH462vFumo6HIZoGWMcXIayjixHWwasBvAEEIS6xBBPjqAAAAABJRU5ErkJggg==';

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
  let ownedFakeProvider = null;
  let page = null;
  let originalFileRecord = null;
  let originalProjectRecord = null;
  let createdFileId = '';
  const evidence = { host: 'Synthetic Tauri WebView2', revision: REVISION, errors: [],
    resourceFailures: [], externalRequests: [], gatewayPrompts: 0, runs: [] };
  try {
    page = browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1:23130/InternalBeyond.html'));
    assert.ok(page, 'a real Synthetic Tauri page must already be running');
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => evidence.errors.push(String(error.message || 'page-error')));
    page.on('websocket', socket => {
      if (!socket.url().startsWith('ws://127.0.0.1:23141/')) return;
      socket.on('framesent', frame => {
        try { const value = JSON.parse(typeof frame.payload === 'string' ? frame.payload : ''); if (value.method === 'session/prompt') evidence.gatewayPrompts++; } catch (_) {}
      });
    });
    page.on('response', response => {
      if (response.url().startsWith('http://127.0.0.1:23141/') && response.status() >= 400) {
        evidence.resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
      }
    });
    page.on('request', request => {
      try { const url = new URL(request.url()); if (!['127.0.0.1', 'localhost', 'ipc.localhost'].includes(url.hostname)) evidence.externalRequests.push(url.origin); } catch (_) {}
    });

    await page.goto('http://127.0.0.1:23130/InternalBeyond.html?coding-p3=' + Date.now() + '#work-mode', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__IB_DEV_MODE__ === true && window.__IB_DEV_SYNTHETIC__ === true
      && !!window.__TAURI__ && typeof IB?.workMode?.ui?.createRun === 'function', null, { timeout: 30000 });
    const identity = await page.evaluate(() => {
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      if (!dev || dev.mode !== 'synthetic' || !dev.homeNodeUrl || !dev.sessionToken || !dev.instanceId) throw new Error('Synthetic service identity unavailable');
      return { webOrigin: dev.webOrigin, homeNodeUrl: dev.homeNodeUrl, fakeProviderUrl: dev.fakeProviderUrl,
        instanceId: dev.instanceId, sessionToken: dev.sessionToken };
    });
    assert.notEqual(new URL(identity.homeNodeUrl).port, '23118', 'formal Home Node must not be contacted');
    const fakeUrl = new URL(identity.fakeProviderUrl);
    assert.equal(fakeUrl.protocol, 'http:'); assert.equal(fakeUrl.hostname, '127.0.0.1'); assert.equal(fakeUrl.port, '23139');
    const projectRoot = path.resolve(__dirname, '..');
    const sandboxRoot = process.env.IB_DEV_SANDBOX_ROOT || path.join(projectRoot, '.dev-data', 'synthetic', 'dev-sandbox');
    const fakeEnv = {
      LOCALAPPDATA: path.join(sandboxRoot, 'local-app-data'), APPDATA: path.join(sandboxRoot, 'roaming-app-data'),
      TEMP: path.join(sandboxRoot, 'temp'), TMP: path.join(sandboxRoot, 'temp'), IB_LOG_DIR: path.join(sandboxRoot, 'logs'),
      IB_DEV_MODE: '1', IB_DEV_SYNTHETIC: '1', IB_DEV_PROJECT_ROOT: projectRoot, IB_DEV_SANDBOX_ROOT: sandboxRoot,
      IB_DEV_INSTANCE_ID: identity.instanceId, IB_DEV_SESSION_TOKEN: identity.sessionToken,
      IB_WEB_PORT: new URL(identity.webOrigin).port, IB_BRIDGE_PORT: '23135', IB_ACTIVE_PORT: '23134',
      IB_RESTART_PORT: '23136', IB_HOME_NODE_PORT: new URL(identity.homeNodeUrl).port, IB_DEV_FAKE_PROVIDER_PORT: fakeUrl.port,
      IB_ECONOMY_CHANNEL_SOURCE_PORT: '23137', IB_DSH_CONTROL_PORT: '23140', IB_DSH_WEB_PORT: '23141',
      IB_HOME_NODE_DATA_DIR: path.join(sandboxRoot, 'home-node'), IB_BRIDGE_DATA_DIR: path.join(sandboxRoot, 'bridge'),
      IB_ACTIVE_DATA_DIR: path.join(sandboxRoot, 'active'), IB_CREDENTIAL_DATA_DIR: path.join(sandboxRoot, 'credential-vault'),
      IB_CREDENTIAL_BINDINGS_DIR: path.join(sandboxRoot, 'credential-vault')
    };
    const fakeIdentity = devServiceContract.identityFromEnvironment(fakeEnv);
    const fakeHeaders = devServiceContract.identityHeaders(fakeIdentity);
    let fakeRunning = false;
    try {
      const response = await fetch(fakeUrl.origin + '/__status', { headers: fakeHeaders, cache: 'no-store' });
      if (response.status !== 200) throw new Error('Synthetic Fake Provider identity failed');
      fakeRunning = true;
    } catch (error) {
      if (error && error.message === 'Synthetic Fake Provider identity failed') throw error;
      if (!error || !error.cause || error.cause.code !== 'ECONNREFUSED') throw error;
    }
    if (!fakeRunning) ownedFakeProvider = await createSyntheticFakeProvider({ port: Number(fakeUrl.port), identity: fakeIdentity, environment: fakeEnv });
    await page.evaluate(input => {
      window.__IB_TEST_FAKE_SERVICE__ = { origin: new URL(window.__IB_DEV_SERVICE_CONFIG__.fakeProviderUrl).origin,
        headers: { 'X-IB-Dev-Session': window.__IB_DEV_SERVICE_CONFIG__.sessionToken,
          'X-IB-Dev-Instance': window.__IB_DEV_SERVICE_CONFIG__.instanceId } };
      window.__IB_TEST_CODING_FIXTURE__ = input;
    }, FIXTURE);

    await page.evaluate(() => { if (IB.apps.isOpen()) IB.apps.close(); navTo('work-mode'); });
    await page.locator('#wm-use-dsh').waitFor({ state: 'visible' });
    await page.locator('#wm-use-dsh').click();
    await page.locator('#wm-dsh-reload').click();
    const getFrame = () => page.frames().find(item => item.url().startsWith('http://127.0.0.1:23141/'));
    await page.waitForFunction(() => window.IB?.workMode?.nativeCandidate?.appliedTheme?.() !== null, null, { timeout: 20000 });
    let work = getFrame();
    assert.ok(work, 'the pinned DSH UI is in the real Tauri WebView2');
    const notice = work.getByRole('dialog').filter({ hasText: '预览版说明' });
    const continueNotice = work.getByRole('button', { name: '继续', exact: true });
    await work.waitForTimeout(300);
    if (await continueNotice.count()) await continueNotice.click({ force: true }).catch(() => {});
    await notice.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await work.waitForFunction(() => window.__DSH_STARTUP_API__ && typeof window.__DSH_STARTUP_API__.skip === 'function', null, { timeout: 10000 });
    await work.evaluate(() => window.__DSH_STARTUP_API__.skip());
    await work.waitForFunction(() => !document.querySelector('#dsh-startup-root'), null, { timeout: 5000 });
    await work.evaluate(() => {
      const permission = window.__DSH_STARTUP_PERMISSION__;
      if (permission && typeof permission.closePermission === 'function') permission.closePermission();
    });
    const previousSessionId = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    await work.getByRole('button', { name: /新会话|新建会话|New session/ }).last().click();
    await work.waitForFunction(previous => {
      const node = document.querySelector('[data-conversation-session]');
      return node && node.getAttribute('data-conversation-session') !== previous;
    }, previousSessionId, { timeout: 30000 });
    const initialSessionId = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    assert.match(initialSessionId, /^session-[A-Fa-f0-9-]{36}$/);
    assert.equal(await work.locator('.ib-work-run-session').count(), 0, 'welcome view has no central Work Record panel');
    assert.equal(await work.locator('[data-work-mode-open]').count(), 0, 'the central Work Record button is absent');
    assert.match(await work.locator('.ib-dsh-brand-name').innerText(), /归墟/);
    assert.doesNotMatch(await work.locator('aside').innerText().catch(() => ''), /DeepSeek Harness|DEEPSEEK HARNESS/);
    await page.screenshot({ path: path.join(output, 'welcome.png') });

    const setup = await page.evaluate(async input => {
      const controller = IB.workMode.ui;
      let status = await IB.homeNode.workRuns.dshStatus();
      if (!status || status.ok !== true || status.environment === 'production') throw new Error('Synthetic Home Node required');
      const active = await IB.homeNode.workRuns.listActive({ limit: 100 });
      for (const run of active && active.runs || []) {
        if (run.projectRef === input.projectRef) await IB.homeNode.workRuns.cancel(run.runId, {
          requestId: 'coding-p3-cleanup-' + crypto.randomUUID(), expectedVersion: run.version
        });
      }
      let refreshed = await controller.refresh();
      const deadline = Date.now() + 15000;
      while ((!refreshed || refreshed.ok !== true || refreshed.activeRuns !== 0) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 200)); refreshed = await controller.refresh();
      }
      if (!refreshed || refreshed.ok !== true || refreshed.activeRuns !== 0) throw new Error('Synthetic Work Run store was not cleanly queued');
      const project = await controller.setSelectedProject(input.projectRef);
      if (!project || project.ok !== true) throw new Error('Synthetic project selection failed');
      const snapshot = await controller.refreshProjectSnapshot(input.projectRef);
      if (!snapshot || snapshot.ok !== true) throw new Error('Synthetic Workspace snapshot failed');
      const file = snapshot.snapshot.files.find(item => item.fileId === input.fileId);
      if (!file) throw new Error('Synthetic selected file missing');
      const workspace = IB.workspace && IB.workspace.files;
      const contents = await workspace.wsReadWorkModeFile(input.projectRef, input.fileId);
      if (!contents || contents.ok !== true) throw new Error('Synthetic file baseline unreadable');
      const selected = await controller.setFileIds([input.fileId]);
      if (!selected || selected.ok !== true) throw new Error('Synthetic exact file selection failed');
      const base = new URL(window.__IB_TEST_FAKE_SERVICE__.origin).origin + '/v1/chat/completions';
      const roles = [
        { id: input.profileRef, name: 'Synthetic Role Alpha', nickname: 'Synthetic Role Alpha', model: 'ib-dsh-synthetic-agent',
          avatar: input.avatarAlpha, systemPrompt: 'IB_SYNTHETIC_PERSONA_ALPHA. You are isolated Synthetic Role Alpha.' },
        { id: input.alternateRoleRef, name: 'Synthetic Role Beta', nickname: 'Synthetic Role Beta', model: 'ib-dsh-synthetic-agent-alt',
          avatar: input.avatarBeta, systemPrompt: 'IB_SYNTHETIC_PERSONA_BETA. You are isolated Synthetic Role Beta.' }
      ];
      for (let index = 0; index < roles.length; index++) {
        const role = roles[index];
        const existing = (window.apiConfigs || []).find(item => item && item.id === role.id) || {};
        await window._persistApiConfig(Object.assign({}, existing, role, { provider: 'openai', endpoint: base,
          credentialRef: input.profileRef, apiKey: '', isRole: true, roleSelectable: true, archived: false, created: index + 1 }));
      }
      await loadApiConfigs();
      const originalFileRecord = await dbGet('projectFiles', input.fileId);
      const originalProjectRecord = await dbGet('projects', input.projectRef);
      return { projectRef: input.projectRef, fileId: input.fileId, path: file.path,
        originalFileRecord, originalProjectRecord,
        profiles: (window.apiConfigs || []).filter(item => roles.some(role => role.id === item.id)).map(item => ({ id: item.id, avatar: item.avatar })) };
    }, Object.assign({}, FIXTURE, { avatarAlpha: AVATAR_ALPHA, avatarBeta: AVATAR_BETA }));
    originalFileRecord = setup.originalFileRecord;
    originalProjectRecord = setup.originalProjectRecord;
    assert.equal(setup.profiles.length, 2);
    assert.ok(setup.profiles.every(item => String(item.avatar || '').startsWith('data:image/png;base64,')));

    const modeSeat = work.locator('button[aria-haspopup="menu"]').filter({ hasText: /General|Coding|Research|App Builder/ }).first();
    const nativeModes = [
      { nativeId: 'synthetic-p0', presetId: 'general', label: 'General' },
      { nativeId: 'coding', presetId: 'coding', label: 'Coding' },
      { nativeId: 'research', presetId: 'research', label: 'Research' },
      { nativeId: 'app-builder', presetId: 'app-builder', label: 'App Builder' },
    ];
    for (const mode of nativeModes) {
      await modeSeat.click();
      await work.getByRole('menuitem', { name: new RegExp(mode.label) }).click();
      await work.waitForFunction(input => window.__IB_DSH_AGENT_PRESET__
        && window.__IB_DSH_AGENT_PRESET__.sessionId === input.sessionId
        && window.__IB_DSH_AGENT_PRESET__.nativePresetId === input.nativeId
        && window.__IB_DSH_AGENT_PRESET__.presetId === input.presetId, { sessionId: initialSessionId, ...mode }, { timeout: 15000 });
    }
    await modeSeat.click();
    await work.getByRole('menuitem', { name: /Coding/ }).click();
    await work.waitForFunction(id => window.__IB_DSH_AGENT_PRESET__
      && window.__IB_DSH_AGENT_PRESET__.sessionId === id
      && window.__IB_DSH_AGENT_PRESET__.nativePresetId === 'coding'
      && window.__IB_DSH_AGENT_PRESET__.presetId === 'coding', initialSessionId, { timeout: 15000 });
    evidence.selectedNativePreset = await work.evaluate(() => window.__IB_DSH_AGENT_PRESET__);
    await work.getByRole('button', { name: /设置/ }).click();
    await work.getByRole('button', { name: 'Agent 预设', exact: true }).click();
    const presetRows = work.locator('[data-agent-preset-id]');
    assert.equal(await presetRows.count(), 4, 'the native DSH roster contains the four Home Node Work modes');
    const presetSettingsText = await presetRows.allInnerTexts();
    const presetNames = await presetRows.locator('button[aria-pressed]').evaluateAll(buttons =>
      buttons.map(button => String(button.getAttribute('aria-label') || '').replace(/^[^:]+:\s*/, '').trim()));
    assert.deepEqual(presetNames.sort(), ['App Builder', 'Coding', 'General', 'Research']);
    assert.ok(presetSettingsText.every(text => !text.includes('暂无描述。')),
      'each native preset has user-facing capability details');
    for (const label of ['General', 'Coding', 'Research', 'App Builder']) assert.ok(presetSettingsText.some(text => text.includes(label)));
    assert.ok(presetSettingsText.some(text => text.includes('project.create_file') && text.includes('Home Node')),
      'Coding settings describe the real Consent-scoped Host tools');
    assert.ok(presetSettingsText.some(text => text.includes('app_draft.create_file')),
      'App Builder settings describe the actual App Draft tools');
    await page.screenshot({ path: path.join(output, 'agent-presets.png') });
    await work.getByRole('button', { name: '通用设置', exact: true }).click();
    await work.locator('[data-ib-theme-follows="true"]').waitFor();
    assert.equal(await work.getByRole('button', { name: '浅色', exact: true }).count(), 0,
      'DSH does not expose a separate Light preference inside Work Mode settings');
    assert.equal(await work.getByRole('button', { name: '深色', exact: true }).count(), 0,
      'DSH does not expose a separate Dark preference inside Work Mode settings');
    const originalThemeClass = await page.evaluate(() => document.body.className);
    const settingSurface = async expected => work.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const detail = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.innerText.trim() === '详细');
      return { dark: document.body.hasAttribute('data-ds-dark-theme'),
        scheme: getComputedStyle(document.documentElement).colorScheme,
        dialogColor: dialog && getComputedStyle(dialog).color,
        dialogBackground: dialog && getComputedStyle(dialog).backgroundColor,
        controlColor: detail && getComputedStyle(detail).color,
        controlBackground: detail && getComputedStyle(detail).backgroundColor,
        themeLabel: (document.body.innerText || '').includes('此界面跟随归墟 Light / Dark 主题') };
    }).then(actual => {
      assert.equal(actual.dark, expected === 'dark');
      assert.equal(actual.scheme, expected);
      assert.equal(actual.themeLabel, true);
      assert.ok(actual.dialogColor && actual.dialogBackground && actual.dialogColor !== actual.dialogBackground);
      assert.ok(actual.controlColor && actual.controlBackground && actual.controlColor !== actual.controlBackground);
      return actual;
    });
    try {
      await page.evaluate(() => document.body.classList.remove('theme-infernal'));
      await work.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'), null, { timeout: 10000 });
      evidence.settingsLight = await settingSurface('light');
      await page.screenshot({ path: path.join(output, 'settings-theme-light.png') });
      await page.evaluate(() => document.body.classList.add('theme-infernal'));
      await work.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'), null, { timeout: 10000 });
      evidence.settingsDark = await settingSurface('dark');
      await page.screenshot({ path: path.join(output, 'settings-theme-dark.png') });
    } finally {
      await page.evaluate(original => { document.body.className = original; }, originalThemeClass);
      await work.waitForFunction(expected => document.documentElement.style.colorScheme === expected,
        originalThemeClass.includes('theme-infernal') ? 'dark' : 'light', { timeout: 10000 });
    }
    await work.getByRole('button', { name: '关闭', exact: true }).click();
    evidence.nativePresets = nativeModes.map(mode => ({ id: mode.nativeId, mode: mode.presetId }));

    await work.evaluate(id => parent.postMessage({ type: 'ib-dsh-p3-catalog-request', sessionId: id }, 'http://127.0.0.1:23130'), initialSessionId);
    await page.waitForTimeout(300);
    const selector = work.locator('[data-executor-selector="true"]');
    const selectorButton = selector.getByRole('button', { name: /选择角色/ });
    await selectorButton.click({ force: true });
    const roleMenu = work.getByRole('dialog', { name: '选择角色' });
    assert.doesNotMatch(await roleMenu.innerText(), /Middle Brain/);
    await roleMenu.getByRole('button', { name: /Synthetic Role Beta/ }).click();
    await roleMenu.getByRole('button', { name: '应用角色' }).click();
    const profileButton = selector.getByRole('button', { name: /选择模型 Profile/ });
    await profileButton.click({ force: true });
    const profileMenu = work.getByRole('dialog', { name: '选择模型 Profile' });
    assert.doesNotMatch(await profileMenu.innerText(), /Middle Brain/);
    assert.doesNotMatch(await profileMenu.innerText(), /Agent 预设|Coding|Research|App Builder/);
    await profileMenu.getByRole('button', { name: /ib-dsh-synthetic-agent.*Synthetic Role Alpha/ }).click();
    await profileMenu.getByRole('button', { name: '应用模型 Profile' }).click();
    await selector.locator('.ib-executor-role-trigger img').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await selector.locator('.ib-executor-role-trigger').innerText(), /Synthetic Role Beta/);
    assert.match(await selector.locator('.ib-executor-profile-trigger').innerText(), /ib-dsh-synthetic-agent/);
    assert.match(await selector.locator('.ib-executor-profile-trigger').innerText(), /手动覆盖/);
    assert.match(await selector.locator('.ib-executor-role-trigger img').getAttribute('src'), /^data:image\/png;base64,/);
    await page.waitForFunction(input => {
      const value = IB.workMode.ui.getState();
      return value.executor === 'dsh' && value.profileRef === input.profileRef
        && value.executorSelection.roleId === input.alternateRoleRef && value.executorSelection.presetId === 'coding';
    }, FIXTURE, { timeout: 20000 });
    const triggerBox = await selector.boundingBox();
    assert.ok(triggerBox && triggerBox.width <= 270, 'executor selector stays compact in the composer');
    evidence.executor = { roleId: FIXTURE.alternateRoleRef, modelOverride: FIXTURE.profileRef,
      presetId: 'coding', modeSource: 'DSH Agent Preset Seat', avatar: true, triggerWidth: triggerBox.width };
    await page.screenshot({ path: path.join(output, 'executor-selection.png') });

    const resetFake = async () => page.evaluate(async () => {
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      return (await fetch(fake.origin + '/__control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers),
        body: JSON.stringify({ reset: true }) })).json();
    });
    const currentSessionId = async () => work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    const submitTask = async prompt => {
      const sessionId = await currentSessionId();
      const editor = work.locator('[data-conversation-session="' + sessionId + '"] [data-composer-card] [contenteditable="true"]');
      await editor.fill(prompt);
      await work.locator('[data-conversation-session="' + sessionId + '"] [data-composer-card] button[aria-label="发送消息"]').click();
      await work.waitForFunction(id => {
        const node = document.querySelector('.ib-work-run-session');
        return !!node && node.dataset.dshSessionId === id && node.dataset.workRunPhase === 'needs-consent';
      }, sessionId, { timeout: 30000 });
      return sessionId;
    };
    const openRecord = async sessionId => {
      const row = work.locator('[data-row-key="session:' + sessionId + '"]');
      await row.waitFor({ state: 'visible', timeout: 15000 });
      await row.hover();
      await row.getByRole('button').first().click();
      await work.getByRole('menuitem', { name: '工作记录', exact: true }).click();
      await work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId + '"] [data-work-run-details]').waitFor();
    };
    const authorize = async (sessionId, options = {}) => {
      const permission = work.locator('#dsh-startup-permission');
      await permission.waitFor({ timeout: 15000 });
      const text = await permission.innerText();
      assert.match(text, /Coding Run 权限请求/);
      assert.match(text, /src\/synthetic\.js/);
      assert.match(text, /新建文本文件仅限/);
      assert.match(text, /不开放 Shell、网络/);
      if (options.captureConsent) await page.screenshot({ path: path.join(output, 'coding-consent.png') });
      const preConsent = await page.evaluate(async id => {
        const link = await IB.homeNode.workRuns.getDshSession(id);
        const fake = window.__IB_TEST_FAKE_SERVICE__;
        const provider = await (await fetch(fake.origin + '/__status', { headers: fake.headers, cache: 'no-store' })).json();
        return { linkedConsent: link.binding && link.binding.consentId || '', status: link.run.status,
          executorSelection: link.run.executorSelection, providerCalls: provider.calls };
      }, sessionId);
      assert.equal(preConsent.linkedConsent, '', 'task creation does not grant Home Node Consent');
      assert.equal(preConsent.providerCalls, 0, 'Fake Provider remains untouched before permission acknowledgement');
      assert.equal(preConsent.status, 'queued');
      assert.deepEqual(preConsent.executorSelection.allowedTools, CODING_TOOLS,
        'the queued Run snapshots Coding tools while remaining non-executable until Consent');
      assert.match(await work.getByRole('button', { name: /访问模式/ }).innerText(), /本地工具 · 只读/,
        'the native DSH selector labels only the local Host permission; Workspace writes stay Home Node-bound');
      await permission.locator('[data-dsu-ack="egress"]').check();
      await permission.locator('[data-dsu-ack="storage"]').check();
      await permission.locator('[data-dsu-ack="workspaceWrite"]').check();
      await permission.getByRole('button', { name: '确认并请求 Host 核验' }).click();
      await work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId + '"][data-work-run-phase="running"],'
        + '.ib-work-run-session[data-dsh-session-id="' + sessionId + '"][data-work-run-phase="completed"]').first().waitFor({ timeout: 45000 });
      if (options.waitTerminal !== false) await work.waitForFunction(id => {
        const node = document.querySelector('.ib-work-run-session[data-dsh-session-id="' + id + '"]');
        return !!node && ['completed', 'failed', 'cancelled'].includes(node.dataset.workRunPhase);
      }, sessionId, { timeout: 90000 });
    };
    const resultFor = async sessionId => page.evaluate(async id => {
      const link = await IB.homeNode.workRuns.getDshSession(id);
      const result = await IB.workMode.runtime.getResult(link.run.runId);
      const consent = link.binding.consentId ? await IB.homeNode.workRuns.getConsent(link.run.runId, link.binding.consentId) : null;
      const events = await IB.homeNode.workRuns.events(link.run.runId, { limit: 100 });
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      const provider = await (await fetch(fake.origin + '/__status', { headers: fake.headers, cache: 'no-store' })).json();
      if (!link || link.ok !== true || !link.found) throw new Error('Home Node Coding binding missing');
      return { runId: link.run.runId, status: link.run.status, workflowId: link.run.workflowId,
        selection: link.run.executorSelection, consent: consent && consent.consent,
        report: result && result.ok === true && result.result ? result.result.report : null,
        events: events.executionEvents || [], provider };
    }, sessionId);

    await resetFake();
    const featurePath = 'src/coding-p3-' + Date.now().toString(36) + '.ts';
    const sessionId = await submitTask('在 src/synthetic.js 中添加 syntheticCodeEnabled 常量，并新建同目录 ' + featurePath + '。');
    await authorize(sessionId, { captureConsent: true });
    let success = await resultFor(sessionId);
    assert.equal(success.status, 'completed', JSON.stringify(success.events.filter(item => ['tool-denied', 'project-file-write', 'project-file-rollback'].includes(item.event))));
    assert.equal(success.workflowId, 'coding.workspace');
    assert.equal(success.consent.workspaceWriteConfirmed, true);
    assert.deepEqual(success.selection.allowedTools, CODING_TOOLS, 'the Run pins only selected-file read/create/update tools');
    assert.equal(success.selection.presetId, 'coding');
    assert.equal(success.consent.providerScopes.length, 1, 'Coding Consent sends to the Agent route only');
    assert.ok(success.provider.codingObserved);
    assert.ok(success.provider.projectWriteToolNames.includes('project.update_file'));
    assert.ok(success.provider.projectWriteToolNames.includes('project.create_file'));
    const finalFiles = await page.evaluate(input => IB.workspace.files.wsGetWorkModeProjectSnapshot(input.projectRef), FIXTURE);
    const updatedFile = await page.evaluate(input => IB.workspace.files.wsReadWorkModeFile(input.projectRef, input.fileId), FIXTURE);
    const featureFile = finalFiles.files.find(item => item.path === featurePath);
    assert.ok(featureFile, 'Coding created the new file inside the selected directory');
    createdFileId = featureFile.fileId;
    assert.match(updatedFile.content, /updated by consented coding/);
    evidence.runs.push({ runId: success.runId, status: success.status, workflowId: success.workflowId,
      tools: success.provider.projectWriteToolNames, selectedFileId: FIXTURE.fileId, createdFileId });
    evidence.permissionConsistency = { dshLocalHost: 'read-only', workspaceWriteConsent: success.consent.workspaceWriteConfirmed,
      runSnapshotTools: success.selection.allowedTools, hostObservedTools: success.provider.projectWriteToolNames };

    await work.getByText('对话', { exact: true }).click();
    await openRecord(sessionId);
    assert.equal(await work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId + '"]').getAttribute('data-work-details-open'), 'true');
    await work.getByText('轨迹', { exact: true }).click();
    await work.getByText('project.update_file', { exact: false }).first().waitFor({ timeout: 30000 });
    await work.getByText('project.create_file', { exact: false }).first().waitFor({ timeout: 30000 });
    await work.getByText('updated by consented coding', { exact: false }).first().waitFor({ timeout: 30000 });
    const traceBody = await work.locator('body').innerText();
    assert.match(traceBody, /project\.read_file/);
    assert.match(traceBody, /project\.update_file/);
    assert.match(traceBody, /project\.create_file/);
    assert.match(traceBody, /\+ export const dshSyntheticFeature/);
    const diffLine = work.getByText('+ export const dshSyntheticFeature', { exact: false }).first();
    await diffLine.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(output, 'coding-trajectory.png') });
    evidence.nativeTraceDiff = { toolCalls: true, diffVisible: true };

    await page.locator('#wm-dsh-reload').click();
    await work.waitForFunction(session => {
      const current = document.querySelector('.ib-work-run-session');
      return current && current.dataset.dshSessionId === session && current.dataset.workRunPhase === 'completed';
    }, sessionId, { timeout: 45000 });
    work = getFrame();
    await work.getByText('轨迹', { exact: true }).click();
    await work.getByText('project.update_file', { exact: false }).first().waitFor({ timeout: 30000 });
    assert.match(await work.locator('body').innerText(), /\+ export const dshSyntheticFeature/,
      'native DSH Trajectory and its diff are restored after WebView refresh');
    evidence.refreshRecovery = { sameSessionId: await work.locator('.ib-work-run-session').getAttribute('data-dsh-session-id'),
      resultStatus: 'completed', diffRestored: true };

    async function prepareNextRun() {
      await work.getByText('对话', { exact: true }).click();
      await page.waitForFunction(() => !IB.workMode.ui.getState().busy, null, { timeout: 15000 });
      await page.waitForTimeout(900);
      const state = await page.evaluate(async input => {
        const ui = IB.workMode.ui;
        await ui.refresh();
        if (ui.getState().activeRuns.length) throw new Error('previous Synthetic run remains active');
        const snap = await ui.refreshProjectSnapshot(input.projectRef);
        if (!snap || snap.ok !== true) throw new Error('workspace refresh failed');
        const selected = await ui.setFileIds([input.fileId]);
        if (!selected || selected.ok !== true) throw new Error('file range could not be reselected');
        return ui.getState();
      }, FIXTURE);
      assert.equal(state.executorSelection.presetId, 'coding');
    }

    await prepareNextRun();
    await resetFake();
    const deniedSession = await submitTask('IB_SYNTHETIC_CODING_UNSELECTED_FILE 请求修改未选中的文件。');
    assert.equal(deniedSession, sessionId, 'continuous Coding Runs stay attached to the same DSH Session');
    await authorize(deniedSession);
    const denied = await resultFor(deniedSession);
    assert.equal(denied.status, 'failed');
    const deniedEvent = denied.events.find(item => item.event === 'tool-denied' && item.toolName === 'project.update_file');
    assert.ok(deniedEvent, 'Home Node rejected an update outside the selected file IDs');
    assert.match(String(deniedEvent.code || ''), /scope-denied|project-read-required/);
    const stillUpdated = await page.evaluate(input => IB.workspace.files.wsReadWorkModeFile(input.projectRef, input.fileId), FIXTURE);
    assert.match(stillUpdated.content, /updated by consented coding/, 'scope denial left the selected file unchanged');
    evidence.runs.push({ runId: denied.runId, status: denied.status, denied: deniedEvent.code, filesUnchanged: true });

    async function setFakeControl(body) {
      return page.evaluate(async input => {
        const fake = window.__IB_TEST_FAKE_SERVICE__;
        return (await fetch(fake.origin + '/__control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers),
          body: JSON.stringify(input) })).json();
      }, body);
    }
    await prepareNextRun();
    await setFakeControl({ reset: true });
    const cancelSession = await submitTask('IB_SYNTHETIC_CODING_HOLD_AFTER_WRITE 修改后等待取消。');
    assert.equal(cancelSession, sessionId);
    await authorize(cancelSession, { waitTerminal: false });
    await page.waitForFunction(async input => {
      const file = await IB.workspace.files.wsReadWorkModeFile(input.projectRef, input.fileId);
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      const status = await (await fetch(fake.origin + '/__status', { cache: 'no-store', headers: fake.headers })).json();
      return file && file.ok === true && file.content.includes('updated by consented coding') && status.waiting > 0;
    }, FIXTURE, { timeout: 45000 });
    const cancelButton = work.locator('.ib-work-run-session[data-dsh-session-id="' + cancelSession + '"] [data-work-run-cancel]');
    await cancelButton.click();
    await page.waitForFunction(async input => {
      const file = await IB.workspace.files.wsReadWorkModeFile(input.projectRef, input.fileId);
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      return file && file.ok === true && file.content === input.before
        && link && link.ok === true && link.run.status === 'cancelled';
    }, { ...FIXTURE, sessionId: cancelSession, before: updatedFile.content }, { timeout: 45000 });
    const afterCancel = await page.evaluate(input => IB.workspace.files.wsReadWorkModeFile(input.projectRef, input.fileId), FIXTURE);
    assert.equal(afterCancel.content, updatedFile.content, 'cancellation rolls the in-flight Workspace modification back');
    evidence.runs.push({ status: 'cancelled', rollback: 'restored selected file content' });

    await prepareNextRun();
    await setFakeControl({ reset: true });
    const failSession = await submitTask('IB_SYNTHETIC_CODING_FAIL_AFTER_WRITE 让 Provider 在写入后失败。');
    assert.equal(failSession, sessionId);
    await authorize(failSession, { waitTerminal: false });
    await page.waitForFunction(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      return link && link.ok === true && link.run.status === 'failed';
    }, { sessionId: failSession }, { timeout: 60000 });
    const afterFailure = await page.evaluate(input => IB.workspace.files.wsReadWorkModeFile(input.projectRef, input.fileId), FIXTURE);
    assert.equal(afterFailure.content, updatedFile.content, 'provider failure rolls the in-flight Workspace modification back');
    evidence.runs.push({ status: 'failed', rollback: 'restored selected file content' });

    await page.screenshot({ path: path.join(output, 'coding-chat.png') });
    evidence.syntheticProvider = { successfulRunCalls: success.provider.calls,
      models: success.provider.models, codingObserved: success.provider.codingObserved,
      toolNames: success.provider.projectWriteToolNames, endpoint: '127.0.0.1:23139' };
    assert.equal(evidence.gatewayPrompts, 0, 'all execution used the Home Node Host adapter');
    assert.deepEqual(evidence.resourceFailures, []);
    assert.deepEqual(evidence.externalRequests, []);
    assert.deepEqual(evidence.errors, []);
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ pass: true, ...evidence }, null, 2));
    console.log(JSON.stringify({ pass: true, ...evidence }, null, 2));
  } finally {
    if (page) {
      try {
        if (createdFileId) await page.evaluate(async input => {
          try { await IB.workspace.files.wsDeleteFile(input.createdFileId); } catch (_) {}
        }, { createdFileId });
        if (originalFileRecord && originalProjectRecord) await page.evaluate(async records => {
          await dbPut('projectFiles', records.file);
          await dbPut('projects', records.project);
        }, { file: originalFileRecord, project: originalProjectRecord });
        const fake = await page.evaluate(() => window.__IB_TEST_FAKE_SERVICE__);
        if (fake) await page.evaluate(async service => fetch(service.origin + '/__control', { method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, service.headers), body: JSON.stringify({ holdNext: false }) }), fake);
      } catch (_) {}
    }
    if (ownedFakeProvider) await ownedFakeProvider.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
