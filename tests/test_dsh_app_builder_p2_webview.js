'use strict';

// Synthetic-only acceptance through the real Tauri WebView2 and pinned DSH UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(__dirname, '../../DeepSeek-Harness-Mock-PoC'));
const { chromium } = createRequire(path.join(source, 'apps/web/package.json'))('playwright');
const devServiceContract = require('../runtime/dev-service-contract.js');
const { createSyntheticFakeProvider } = require('../runtime/dev-synthetic-seed.js');
const output = path.resolve(__dirname, '../.dsh-research/app-builder-p2');
const REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const FIXTURE = Object.freeze({ projectRef: 'dsh_synthetic_workspace', profileRef: 'dsh_synthetic_agent',
  alternateRoleRef: 'dsh_synthetic_agent_alt' });
const APP_TOOLS = ['app_draft.list_files', 'app_draft.read_file', 'app_draft.create_file', 'app_draft.update_file'];

function unzipStoredArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = Object.create(null);
  let offset = 0;
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true), method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true), name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    assert.equal(flags & 0x0800, 0x0800);
    assert.equal(method, 0);
    assert.ok(name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..'), 'ZIP paths are relative and safe');
    const dataStart = offset + 30 + nameLength + extraLength;
    files[name] = decoder.decode(bytes.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, 'ZIP has a central directory');
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, 'ZIP has a valid EOCD record');
  return files;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
  let ownedFakeProvider = null;
  const evidence = { host: 'Synthetic Tauri WebView2', revision: REVISION, errors: [], resourceFailures: [], externalRequests: [], gatewayPrompts: 0 };
  try {
    const page = browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1:23130/InternalBeyond.html'));
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

    await page.goto('http://127.0.0.1:23130/InternalBeyond.html?app-builder-p2=' + Date.now() + '#work-mode', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__IB_DEV_MODE__ === true && window.__IB_DEV_SYNTHETIC__ === true
      && !!window.__TAURI__ && typeof IB?.workMode?.ui?.createRun === 'function'
      && typeof IB?.homeNode?.workRuns?.restoreAppDraftVersion === 'function', null, { timeout: 30000 });
    const serviceIdentity = await page.evaluate(() => {
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      if (!dev || dev.mode !== 'synthetic' || !dev.homeNodeUrl || !dev.sessionToken || !dev.instanceId) {
        throw new Error('synthetic Home Node identity unavailable');
      }
      return { mode: dev.mode, webOrigin: dev.webOrigin, homeNodeUrl: dev.homeNodeUrl,
        fakeProviderUrl: dev.fakeProviderUrl, instanceId: dev.instanceId, sessionToken: dev.sessionToken };
    });
    if (new URL(serviceIdentity.homeNodeUrl).port === '23118') throw new Error('refusing to reach the production Home Node port');
    evidence.hostNode = { environment: serviceIdentity.mode, port: new URL(serviceIdentity.homeNodeUrl).port,
      devInstanceId: serviceIdentity.instanceId };
    const fakeUrl = new URL(serviceIdentity.fakeProviderUrl);
    if (fakeUrl.protocol !== 'http:' || fakeUrl.hostname !== '127.0.0.1' || fakeUrl.port !== '23139'
      || serviceIdentity.mode !== 'synthetic' || !process.env.LOCALAPPDATA) {
      throw new Error('refusing to start or connect outside the Synthetic Fake Provider route');
    }
    const sandboxRoot = path.join(process.env.LOCALAPPDATA, 'InternalBeyond', 'dev-synthetic', 'dev-sandbox');
    const fakeEnvironment = {
      IB_DEV_MODE: '1', IB_DEV_SYNTHETIC: '1', IB_DEV_SANDBOX_ROOT: sandboxRoot,
      IB_DEV_INSTANCE_ID: serviceIdentity.instanceId, IB_DEV_SESSION_TOKEN: serviceIdentity.sessionToken,
      IB_WEB_PORT: new URL(serviceIdentity.webOrigin).port,
      IB_BRIDGE_PORT: '23135', IB_ACTIVE_PORT: '23134', IB_RESTART_PORT: '23136',
      IB_HOME_NODE_PORT: new URL(serviceIdentity.homeNodeUrl).port, IB_DEV_FAKE_PROVIDER_PORT: fakeUrl.port,
      IB_ECONOMY_CHANNEL_SOURCE_PORT: '23137', IB_DSH_CONTROL_PORT: '23140', IB_DSH_WEB_PORT: '23141',
      IB_HOME_NODE_DATA_DIR: path.join(sandboxRoot, 'home-node'),
      IB_BRIDGE_DATA_DIR: path.join(sandboxRoot, 'bridge'), IB_ACTIVE_DATA_DIR: path.join(sandboxRoot, 'active'),
      IB_CREDENTIAL_DATA_DIR: path.join(sandboxRoot, 'credential-vault'),
      IB_CREDENTIAL_BINDINGS_DIR: path.join(sandboxRoot, 'credential-vault')
    };
    const fakeIdentity = devServiceContract.identityFromEnvironment(fakeEnvironment);
    const fakeHeaders = devServiceContract.identityHeaders(fakeIdentity);
    let fakeIsRunning = false;
    try {
      const response = await fetch(fakeUrl.origin + '/__status', { headers: fakeHeaders, cache: 'no-store' });
      if (response.status !== 200) throw new Error('Synthetic Fake Provider identity check failed');
      fakeIsRunning = true;
    } catch (error) {
      if (error && error.message === 'Synthetic Fake Provider identity check failed') throw error;
      if (!error || !error.cause || error.cause.code !== 'ECONNREFUSED') throw error;
    }
    if (!fakeIsRunning) {
      ownedFakeProvider = await createSyntheticFakeProvider({ port: Number(fakeUrl.port), identity: fakeIdentity, environment: fakeEnvironment });
    }
    evidence.fakeProvider = { environment: 'synthetic', port: Number(fakeUrl.port), startedForAcceptance: !!ownedFakeProvider };
    await page.evaluate(async input => {
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      window.__IB_TEST_FAKE_SERVICE__ = { origin: new URL(dev.fakeProviderUrl).origin,
        headers: { 'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId } };
      const host = await (await fetch(dev.dshControlUrl + '/status', { cache: 'no-store', headers: {
        'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId
      } })).json();
      if (host.ok !== true || host.synthetic !== true || host.environment !== 'synthetic'
        || host.phase !== 'ready' || host.revision !== input.revision) throw new Error('pinned Synthetic DSH Host required');
      let workStatus = null;
      const workStoreDeadline = Date.now() + 15000;
      while (Date.now() < workStoreDeadline) {
        try { workStatus = await IB.homeNode.workRuns.dshStatus(); } catch (_) { workStatus = null; }
        if (workStatus && workStatus.ok === true && workStatus.workRuns && workStatus.workRuns.available === true) break;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!workStatus || workStatus.ok !== true || !workStatus.workRuns || workStatus.workRuns.available !== true) {
        throw new Error('Synthetic Home Node Work Run store unavailable: ' + JSON.stringify(workStatus));
      }
      const controller = IB.workMode.ui;
      const prior = await IB.homeNode.workRuns.listActive({ limit: 100 });
      for (const run of prior && prior.runs || []) {
        if (run.projectRef === input.projectRef) {
          const cancelled = await IB.homeNode.workRuns.cancel(run.runId, {
            requestId: 'app-builder-p2-test-cleanup-' + crypto.randomUUID(), expectedVersion: run.version
          });
          if (run.workflowId === 'app.builder' && cancelled && cancelled.run && cancelled.run.status === 'cancelled') {
            await IB.homeNode.workRuns.finishAppDraftRun(run.runId, {
              draftRef: run.appDraftRef, projectRef: run.projectRef, status: 'cancelled'
            });
          }
        }
      }
      let refreshed = null;
      const refreshDeadline = Date.now() + 12000;
      while (Date.now() < refreshDeadline) {
        refreshed = await controller.refresh();
        if (refreshed && refreshed.ok === true && refreshed.activeRuns === 0) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!refreshed || refreshed.ok !== true || refreshed.activeRuns !== 0) {
        throw new Error('fresh Synthetic Work Run Store required: ' + JSON.stringify(refreshed));
      }
      const selected = await controller.setSelectedProject(input.projectRef);
      if (!selected || selected.ok !== true) throw new Error('Synthetic Workspace project selection failed');
      const snapshot = await controller.refreshProjectSnapshot(input.projectRef);
      if (!snapshot || snapshot.ok !== true) throw new Error('Synthetic Workspace snapshot failed');
      const noProjectFiles = await controller.setFileIds([]);
      if (!noProjectFiles || noProjectFiles.ok !== true) throw new Error('App Builder must start without selecting source project files');
      let profiles = [];
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try { await loadApiConfigs(); } catch (_) {}
        profiles = Array.isArray(window.apiConfigs) ? window.apiConfigs : [];
        if (profiles.some(item => item && item.id === input.profileRef)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const syntheticEndpoint = new URL(window.__IB_TEST_FAKE_SERVICE__.origin).origin + '/v1/chat/completions';
      const syntheticRoles = [
        { id: input.profileRef, name: 'Synthetic Role Alpha', model: 'ib-dsh-synthetic-agent',
          systemPrompt: 'IB_SYNTHETIC_PERSONA_ALPHA. You are isolated Synthetic Role Alpha. Speak with concise, methodical confidence.' },
        { id: input.alternateRoleRef, name: 'Synthetic Role Beta', model: 'ib-dsh-synthetic-agent-alt',
          systemPrompt: 'IB_SYNTHETIC_PERSONA_BETA. You are isolated Synthetic Role Beta. Explain decisions with curiosity and distinguish facts from guesses.' }
      ];
      if (typeof window._persistApiConfig !== 'function') throw new Error('Synthetic IndexedDB profile writer unavailable');
      for (let index = 0; index < syntheticRoles.length; index++) {
        const fixture = syntheticRoles[index];
        const existing = (window.apiConfigs || []).find(item => item && item.id === fixture.id) || {};
        const profile = Object.assign({}, existing, { id: fixture.id, name: fixture.name, nickname: fixture.name,
          provider: 'openai', model: fixture.model, endpoint: syntheticEndpoint,
          credentialRef: input.profileRef, apiKey: '', systemPrompt: fixture.systemPrompt,
          isRole: true, roleSelectable: true, archived: false, created: index + 1, sortOrder: index });
        await window._persistApiConfig(profile);
        await loadApiConfigs();
      }
      const persistedProfiles = (window.apiConfigs || []).filter(item => item && syntheticRoles.some(role => role.id === item.id));
      if (persistedProfiles.length !== 2 || !persistedProfiles.some(item => item.systemPrompt.includes('IB_SYNTHETIC_PERSONA_ALPHA'))
        || !persistedProfiles.some(item => item.systemPrompt.includes('IB_SYNTHETIC_PERSONA_BETA'))) {
        throw new Error('Synthetic custom role fixtures are not persisted in the isolated Dev IndexedDB');
      }
      return { projectRef: input.projectRef, profileRef: input.profileRef, alternateRoleRef: input.alternateRoleRef,
        models: persistedProfiles.map(item => item.model) };
    }, Object.assign({ revision: REVISION }, FIXTURE));

    await page.evaluate(() => { if (IB.apps.isOpen()) IB.apps.close(); navTo('work-mode'); });
    await page.locator('#wm-use-dsh').waitFor({ state: 'visible' });
    await page.locator('#wm-use-dsh').click();
    await page.locator('#wm-dsh-reload').click();
    const getFrame = () => page.frames().find(item => item.url().startsWith('http://127.0.0.1:23141/'));
    await page.waitForFunction(() => window.IB?.workMode?.nativeCandidate?.appliedTheme?.() !== null, null, { timeout: 20000 });
    let work = getFrame();
    assert.ok(work, 'the pinned DSH Web UI is embedded inside the real Tauri WebView2');
    const notice = work.getByRole('dialog').filter({ hasText: '预览版说明' });
    const continueNotice = work.getByRole('button', { name: '继续', exact: true });
    await work.waitForTimeout(600);
    if (await continueNotice.count()) await continueNotice.click({ force: true }).catch(() => {});
    await notice.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await work.waitForFunction(() => window.__DSH_STARTUP_API__ && typeof window.__DSH_STARTUP_API__.skip === 'function', null, { timeout: 10000 });
    await work.evaluate(() => window.__DSH_STARTUP_API__.skip());
    await work.waitForFunction(() => !document.querySelector('#dsh-startup-root'), null, { timeout: 5000 });
    let sessionId1 = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    let panel = work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId1 + '"]');
    const newSessionButton = work.getByRole('button', { name: /新建会话|新会话|New session/ }).last();
    await newSessionButton.waitFor();
    await newSessionButton.click();
    await work.waitForFunction(oldSession => {
      const current = document.querySelector('[data-conversation-session]');
      return !!current && current.dataset.conversationSession && current.dataset.conversationSession !== oldSession;
    }, sessionId1, { timeout: 30000 });
    sessionId1 = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    panel = work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId1 + '"]');
    assert.match(sessionId1, /^session-[A-Fa-f0-9-]{36}$/);
    assert.equal(await panel.count(), 0, 'a fresh DSH Session has no central Work Record panel');
    const modeSeat = work.locator('button[aria-haspopup="menu"]').filter({ hasText: /General/ }).first();
    await modeSeat.click();
    await work.getByRole('menuitem', { name: /App Builder/ }).click();
    await work.waitForFunction(id => window.__IB_DSH_AGENT_PRESET__
      && window.__IB_DSH_AGENT_PRESET__.sessionId === id
      && window.__IB_DSH_AGENT_PRESET__.presetId === 'app-builder', sessionId1, { timeout: 15000 });
    const selector = work.locator('[data-executor-selector="true"]');
    await selector.getByRole('button', { name: /选择角色/ }).click({ force: true });
    const roleMenu = work.getByRole('dialog', { name: '选择角色' });
    await roleMenu.getByRole('button', { name: /Synthetic Role Alpha/ }).click();
    await roleMenu.getByRole('button', { name: '应用角色' }).click();
    await page.waitForFunction(input => {
      const state = IB.workMode.ui.getState();
      return state.executor === 'dsh' && state.profileRef === input.profileRef
        && state.executorSelection.roleId === input.profileRef && state.executorSelection.presetId === 'app-builder';
    }, FIXTURE, { timeout: 20000 });
    assert.match(await selector.locator('.ib-executor-role-trigger').innerText(), /Synthetic Role Alpha/);
    assert.match(await selector.locator('.ib-executor-profile-trigger').innerText(), /ib-dsh-synthetic-agent/);
    await selector.getByRole('button', { name: /选择模型 Profile/ }).click({ force: true });
    const modelMenu = work.getByRole('dialog', { name: '选择模型 Profile' });
    assert.doesNotMatch(await modelMenu.innerText(), /Middle Brain/);
    await modelMenu.getByRole('button', { name: /ib-dsh-synthetic-agent.*Synthetic Role Alpha/ }).click();
    await modelMenu.getByRole('button', { name: '应用模型 Profile' }).click();

    const sessionIdOf = async targetPanel => {
      if (await targetPanel.count()) return targetPanel.getAttribute('data-dsh-session-id');
      return work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    };
    const openWorkPanel = async targetPanel => {
      const session = await sessionIdOf(targetPanel);
      const row = work.locator('[data-row-key="session:' + session + '"]');
      if (await row.count()) {
        await row.hover();
        const trigger = row.getByRole('button').first();
        if (await trigger.count()) {
          await trigger.click();
          await work.getByRole('menuitem', { name: '工作记录', exact: true }).click();
        } else await work.evaluate(id => window.dispatchEvent(new CustomEvent('ib-dsh-work-record-open', { detail: { sessionId: id } })), session);
      } else {
        await work.evaluate(id => window.dispatchEvent(new CustomEvent('ib-dsh-work-record-open', { detail: { sessionId: id } })), session);
      }
      await work.locator('.ib-work-run-session[data-dsh-session-id="' + session + '"] [data-work-run-details]').waitFor();
    };
    const reopenPermissionEntry = async targetPanel => {
      await work.locator('#dsh-startup-permission').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
      const deadline = Date.now() + 15000;
      const button = targetPanel.locator('[data-dsh-permission-reopen="true"]');
      while (Date.now() < deadline) {
        await openWorkPanel(targetPanel);
        if (await button.isVisible().catch(() => false)) {
          try { await button.click({ timeout: 1200 }); return; } catch (_) {}
        }
        await page.waitForTimeout(150);
      }
      throw new Error('the queued Session Run did not restore its Permission entry after Host verification returned');
    };
    const createAppRun = async (targetWork, targetPanel, prompt, draftRef, submitMethod) => {
      if (draftRef) {
        await openWorkPanel(targetPanel);
        await targetPanel.locator('[data-app-builder-entry]').waitFor();
      }
      assert.equal(await targetPanel.locator('[data-app-builder-form]').count(), 0,
        'App Builder uses the DSH native composer instead of a second task form');
      if (draftRef) {
        const draftSelect = targetPanel.getByLabel('APP 草稿');
        if (await draftSelect.inputValue() !== draftRef) await draftSelect.selectOption(draftRef);
      }
      const sessionId = await sessionIdOf(targetPanel);
      const editor = targetWork.locator('[data-conversation-session="' + sessionId
        + '"] [data-composer-card] [contenteditable="true"]');
      await editor.fill(prompt);
      if (submitMethod === 'click') {
        await targetWork.locator('[data-conversation-session="' + sessionId
          + '"] [data-composer-card] button[aria-label="发送消息"]').click();
      } else await editor.press('Enter');
      await targetWork.waitForFunction(input => {
        const editor = document.querySelector('[data-conversation-session="' + input.sessionId
          + '"] [data-composer-card] [contenteditable="true"]');
        return !!editor && !String(editor.innerText || editor.textContent || '').trim();
      }, { sessionId: sessionId }, { timeout: 5000 });
      try { await targetWork.locator('[data-work-run-phase="needs-consent"]').waitFor(); }
      catch (_) {
        const status = await targetPanel.getAttribute('data-work-run-phase').catch(() => 'missing');
        const text = await targetPanel.innerText().catch(() => '');
        const current = await page.evaluate(() => {
          const state = IB.workMode.ui.getState();
          return { run: state.run, executor: state.executor, profileRef: state.profileRef,
            selection: state.executorSelection, error: state.error, notice: state.notice };
        });
        throw new Error('App Builder Run did not reach Consent: ' + JSON.stringify({ status, current, text: text.slice(-1200) }));
      }
      const permission = targetWork.locator('#dsh-startup-permission');
      await permission.waitFor();
      assert.match(await permission.innerText(), /模型/);
      assert.match(await permission.innerText(), /操作范围/);
      assert.match(await permission.innerText(), /存储与发送风险/);
      assert.match(await permission.innerText(), /Synthetic Role (Alpha|Beta)/);
      assert.doesNotMatch(await permission.innerText(), /Review Provider ·|Memory Recall ·/);
      return permission;
    };
    const authorizeThroughPermission = async (targetWork, targetPanel, expectedPhase) => {
      let dialog = targetWork.locator('#dsh-startup-permission');
      if (!(await dialog.isVisible().catch(() => false))) {
        await openWorkPanel(targetPanel);
        await targetPanel.locator('[data-dsh-permission-reopen="true"]').click();
        await dialog.waitFor();
      }
      const checks = dialog.locator('input[type="checkbox"]');
      for (let index = 0; index < await checks.count(); index++) await checks.nth(index).check();
      await dialog.getByRole('button', { name: '确认并请求 Host 核验' }).click();
      await targetWork.locator('[data-work-run-phase="' + expectedPhase + '"]').waitFor({ timeout: 90000 });
      if (await dialog.isVisible().catch(() => false)) {
        const back = dialog.getByRole('button', { name: '返回任务界面' });
        if (await back.isVisible().catch(() => false)) await back.click();
      }
      return true;
    };
    const resetFake = async () => page.evaluate(async () => {
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      return (await fetch(fake.origin + '/__control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers),
        body: JSON.stringify({ reset: true }) })).json();
    });
    assert.equal((await resetFake()).ok, true, 'each Synthetic WebView run starts from a clean Fake Provider counter');
    const openArtifactDetails = async targetPanel => {
      const details = targetPanel.locator('[data-app-builder-details]');
      await details.waitFor();
      if (!(await details.evaluate(element => element.open))) await details.getByText('文件、差异、预览与安装', { exact: true }).click();
    };
    const openRunHistory = async targetPanel => {
      const history = targetPanel.locator('[data-work-run-history="true"]');
      await history.waitFor();
      const details = history.locator('details');
      await details.scrollIntoViewIfNeeded();
      if (!(await details.evaluate(element => element.open))) await details.locator(':scope > summary').click();
    };
    let consent = await createAppRun(work, panel, '生成一个轻量待办 APP，支持新增、完成、删除，数据只保存在 APP 本地空间。', '');
    assert.match(await consent.innerText(), /Synthetic Role Alpha/, 'the Permission request shows the frozen first Run persona');
    let sessionId = sessionId1;
    const permission = work.locator('#dsh-startup-permission');
    await permission.waitFor();
    assert.match(await permission.innerText(), /APP 草稿/);
    assert.match(await permission.innerText(), /存储与发送风险/);
    assert.equal(await permission.locator('.dsu-skip').count(), 0, 'Permission mode has no animation-skip control');
    const startupMedia = await work.evaluate(() => ({
      voiceSource: window.__DSH_STARTUP__ && window.__DSH_STARTUP__.voiceSource,
      soundSource: window.__DSH_STARTUP__ && window.__DSH_STARTUP__.sfx,
      startupAudioRequests: performance.getEntriesByType('resource').filter(item => /dsh-startup\/asset|dsh-startup\/.*\.mp3/i.test(item.name)).length
    }));
    assert.equal(startupMedia.voiceSource, 'tts');
    assert.equal(startupMedia.soundSource, 'synth');
    assert.equal(startupMedia.startupAudioRequests, 0, 'the startup plugin makes no request for the removed third-party audio files');
    const originallyDark = await page.evaluate(() => document.body.classList.contains('theme-infernal'));
    await page.evaluate(() => document.body.classList.add('theme-infernal'));
    await work.waitForFunction(() => document.querySelector('#dsh-startup-permission')?.dataset.theme === 'dark', null, { timeout: 5000 });
    await page.evaluate(wasDark => document.body.classList.toggle('theme-infernal', wasDark), originallyDark);
    await work.waitForFunction(expectedDark => document.querySelector('#dsh-startup-permission')?.dataset.theme === (expectedDark ? 'dark' : 'light'),
      originallyDark, { timeout: 5000 });
    evidence.startupPermission = Object.assign({ lightAndDarkTheme: true }, startupMedia);
    const permissionSurvivesIntroSkip = await work.evaluate(() => {
      if (window.__DSH_STARTUP_API__ && typeof window.__DSH_STARTUP_API__.skip === 'function') window.__DSH_STARTUP_API__.skip();
      return !!document.querySelector('#dsh-startup-permission');
    });
    assert.equal(permissionSurvivesIntroSkip, true, 'skipping the startup animation leaves the real task permission request open');
    const readConsentState = async () => page.evaluate(async sessionIdValue => {
      const link = await IB.homeNode.workRuns.getDshSession(sessionIdValue);
      return { ok: link.ok, status: link.run && link.run.status,
        consentId: String(link.binding && link.binding.consentId || link.run && link.run.consentId || '') };
    }, sessionId);
    const stateAfterIntroSkip = await readConsentState();
    assert.equal(stateAfterIntroSkip.status, 'queued');
    assert.equal(stateAfterIntroSkip.consentId, '', 'skipping the intro leaves the Run queued without Consent');
    await permission.getByRole('button', { name: '拒绝', exact: true }).click();
    await permission.getByRole('status').waitFor();
    assert.match(await permission.getByRole('status').innerText(), /已拒绝本次请求/);
    await permission.getByRole('button', { name: '返回任务界面' }).click();
    let permissionState = await readConsentState();
    assert.equal(permissionState.ok, true);
    assert.equal(permissionState.status, 'queued');
    assert.equal(permissionState.consentId, '', 'refusal does not create a Home Node Consent');
    await openWorkPanel(panel);
    await panel.locator('[data-dsh-permission-reopen="true"]').click();
    let permissionRetry = work.locator('#dsh-startup-permission');
    await permissionRetry.waitFor();
    assert.equal(await permissionRetry.getByRole('dialog').getAttribute('data-permission-bridge'), 'ready',
      'the startup Permission mode is connected to this DSH Session Work Run');
    await permissionRetry.getByRole('button', { name: '取消', exact: true }).click();
    assert.match(await permissionRetry.getByRole('status').innerText(), /本次请求已取消/);
    await permissionRetry.getByRole('button', { name: '返回任务界面' }).click();
    permissionState = await readConsentState();
    assert.equal(permissionState.status, 'queued');
    assert.equal(permissionState.consentId, '', 'cancelling does not create a Home Node Consent');
    await openWorkPanel(panel);
    await panel.locator('[data-dsh-permission-reopen="true"]').click();
    permissionRetry = work.locator('#dsh-startup-permission');
    await permissionRetry.waitFor();
    const permissionChecks = permissionRetry.locator('input[type="checkbox"]');
    assert.equal(await permissionChecks.count(), 2, 'App Builder requires separate egress and plaintext storage confirmations');
    await work.evaluate(() => {
      window.__DSH_PERMISSION_EVENTS__ = [];
      window.addEventListener('dsh-startup:permission-status', event => {
        if (event.detail && event.detail.status) window.__DSH_PERMISSION_EVENTS__.push(event.detail.status);
      });
    });
    const bindFailureInjected = await page.evaluate(() => {
      const remote = IB.homeNode.workRuns;
      const original = remote.bindDshSession;
      window.__IB_TEST_ORIGINAL_DSH_BIND__ = original;
      remote.bindDshSession = async () => ({ ok: false, error: 'synthetic-host-verification-rejected' });
      return remote.bindDshSession !== original;
    });
    assert.equal(bindFailureInjected, true, 'the Synthetic Host binding failure is isolated to this test page');
    for (let index = 0; index < await permissionChecks.count(); index++) await permissionChecks.nth(index).check();
    await permissionRetry.getByRole('button', { name: '确认并请求 Host 核验' }).click();
    await work.waitForFunction(() => document.querySelector('#dsh-startup-permission [role=dialog]')?.dataset.permissionPhase === 'failed',
      null, { timeout: 20000 });
    assert.match(await permissionRetry.innerText(), /synthetic-host-verification-rejected/,
      'the Permission mode returns the Host rejection reason to the task interface');
    await permissionRetry.getByRole('button', { name: '返回任务界面' }).click();
    const failedConsentCleanup = await page.evaluate(async sessionIdValue => {
      const remote = IB.homeNode.workRuns;
      if (window.__IB_TEST_ORIGINAL_DSH_BIND__) remote.bindDshSession = window.__IB_TEST_ORIGINAL_DSH_BIND__;
      delete window.__IB_TEST_ORIGINAL_DSH_BIND__;
      const before = IB.workMode.ui.getState();
      const revoked = await IB.workMode.ui.revokeConsent();
      const link = await remote.getDshSession(sessionIdValue);
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      const provider = await (await fetch(fake.origin + '/__status', { cache: 'no-store', headers: fake.headers })).json();
      return { revokeOk: revoked && revoked.ok === true, status: link.run && link.run.status,
        boundConsentId: String(link.binding && link.binding.consentId || ''), providerCalls: provider.calls,
        workRunConsentIdCleared: !IB.workMode.ui.getState().consentId, runId: before.run.runId };
    }, sessionId);
    assert.equal(failedConsentCleanup.revokeOk, true);
    assert.equal(failedConsentCleanup.status, 'queued');
    assert.equal(failedConsentCleanup.boundConsentId, '', 'failed Host binding leaves no Consent attached to the DSH Session');
    assert.equal(failedConsentCleanup.providerCalls, 0, 'Host verification failure does not reach the Fake Provider');
    assert.equal(failedConsentCleanup.workRunConsentIdCleared, true);
    await reopenPermissionEntry(panel);
    permissionRetry = work.locator('#dsh-startup-permission');
    await permissionRetry.waitFor();
    await work.waitForFunction(() => document.querySelector('#dsh-startup-permission [role=dialog]')?.dataset.permissionBridge === 'ready',
      null, { timeout: 10000 });
    evidence.permissionVerificationFailure = { feedback: 'returned-to-task', consent: 'revoked-and-unbound', providerCalls: 0 };
    evidence.selectedExecutor = await page.evaluate(() => {
      const state = IB.workMode.ui.getState();
      return { roleId: state.executorSelection.roleId, profileRef: state.profileRef, presetId: state.executorSelection.presetId };
    });
    const firstRun = await page.evaluate(async sessionIdValue => {
      const link = await IB.homeNode.workRuns.getDshSession(sessionIdValue);
      if (!link || link.ok !== true || !link.found || link.run.workflowId !== 'app.builder' || link.run.status !== 'queued') {
        throw new Error('Home Node did not bind App Builder Session to app.builder Run');
      }
      const selection = link.run.executorSelection;
      const presetTools = ['app_draft.list_files', 'app_draft.read_file', 'app_draft.create_file', 'app_draft.update_file'];
      if (!selection || selection.presetId !== 'app-builder' || selection.roleId !== 'dsh_synthetic_agent'
        || selection.profileRef !== 'dsh_synthetic_agent' || selection.providerScope.model !== 'ib-dsh-synthetic-agent'
        || JSON.stringify(selection.allowedTools) !== JSON.stringify(presetTools) || selection.maxProjectReadCalls !== 0) {
        throw new Error('App Builder Run snapshot did not pin identity, Provider Route, and exact draft tools');
      }
      const preview = await IB.workMode.ui.previewAuthorization();
      if (!preview || preview.ok !== true || preview.files.length !== 0
        || JSON.stringify(preview.providers.map(item => item.destination)) !== JSON.stringify(['agent'])) {
        throw new Error('App Builder Consent must contain only Agent Provider and no Workspace files');
      }
      return { runId: link.run.runId, draftRef: link.run.appDraftRef, selection: selection };
    }, sessionId);
    evidence.firstRun = firstRun;

    assert.equal((await resetFake()).ok, true);
    for (let index = 0; index < await permissionChecks.count(); index++) await permissionChecks.nth(index).check();
    await permissionRetry.getByRole('button', { name: '确认并请求 Host 核验' }).click();
    evidence.permission = { introSkipPreservedRequest: permissionSurvivesIntroSkip,
      refusal: 'queued-without-consent', cancellation: 'queued-without-consent' };
    await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 90000 });
    await work.waitForFunction(() => (window.__DSH_PERMISSION_EVENTS__ || []).includes('running'), null, { timeout: 10000 });
    const permissionStatus = await work.evaluate(() => window.__DSH_PERMISSION_EVENTS__ || []);
    assert.ok(permissionStatus.includes('verifying'), 'the panel reports the pending Host check');
    assert.ok(permissionStatus.includes('failed'), 'the panel reports and returns after a failed Host verification');
    assert.ok(permissionStatus.includes('running'), 'the permission panel closes after the Home Node Run starts');
    evidence.permission.statuses = permissionStatus;
    assert.equal(await permissionRetry.isVisible().catch(() => false), false,
      'the completed Run returns to the native DSH conversation instead of leaving permission mode open');
    await work.getByText('轨迹', { exact: true }).click();
    await work.getByText('Home Node Result', { exact: false }).waitFor({ timeout: 20000 });
    assert.ok((await work.locator('body').innerText()).includes('已生成包含新增、完成、删除和本地数据保存的 Todo App。'),
      'the native DSH Trace shows the persisted Home Node Result summary');
    evidence.nativeCompletionTrace = true;
    await work.getByText('对话', { exact: true }).click();
    await openWorkPanel(panel);
    await panel.locator('[data-app-builder-artifact]').waitFor();
    await openArtifactDetails(panel);
    const preview = work.frameLocator('iframe[title="App Draft preview"]');
    await preview.getByLabel('新待办').fill('买牛奶');
    await preview.getByRole('button', { name: '添加' }).click();
    await preview.locator('#todo-list li').filter({ hasText: '买牛奶' }).waitFor();
    const firstArtifact = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const result = await IB.workMode.runtime.getResult(link.run.runId);
      const draft = await IB.homeNode.workRuns.getAppDraft(link.run.appDraftRef, link.run.projectRef, link.run.runId);
      const events = await IB.homeNode.workRuns.events(link.run.runId, { limit: 100 });
      if (link.run.status !== 'completed' || !result || result.ok !== true || !result.result || !draft || draft.ok !== true) {
        throw new Error('Home Node did not persist App Builder Result and Draft');
      }
      if (!['index.html', 'styles.css', 'app.js'].every(name => typeof draft.draft.files[name] === 'string')) {
        throw new Error('Todo APP is missing one of its three generated files');
      }
      const fakeConfig = window.__IB_TEST_FAKE_SERVICE__;
      const fake = await (await fetch(fakeConfig.origin + '/__status', { cache: 'no-store', headers: fakeConfig.headers })).json();
      if (!fake.appBuilderObserved || !fake.personaObserved || !fake.personaMarkers.alpha
        || !fake.appDraftToolNames.includes('app_draft.create_file')) {
        throw new Error('Synthetic Fake Provider did not observe the role persona or App Builder tool pipeline');
      }
      return { runId: link.run.runId, draftRef: link.run.appDraftRef, status: link.run.status, resultId: result.result.resultId,
        summary: result.result.report.summary, files: Object.keys(draft.draft.files).sort(), version: draft.draft.version,
        executionEvents: events.executionEvents || [], appBuilderObserved: fake.appBuilderObserved, personaObserved: fake.personaObserved,
        personaMarkers: fake.personaMarkers,
        toolNames: fake.appDraftToolNames.slice(), models: fake.models, middleCalls: fake.models['ib-dsh-synthetic-middle'] || 0 };
    }, { sessionId: sessionId });
    assert.deepEqual(firstArtifact.files, ['app.js', 'index.html', 'styles.css']);
    assert.equal(firstArtifact.middleCalls, 0, 'the App Builder Run does not send generated files to Middle Brain or use project Memory');
    assert.ok(firstArtifact.executionEvents.some(item => item.event === 'app-draft-file-written'));
    evidence.firstArtifact = firstArtifact;

    let secondPanel = panel;
    await secondPanel.locator('[data-app-builder-entry]').waitFor();
    assert.equal(await secondPanel.getAttribute('data-dsh-session-id'), sessionId,
      'the next App Builder task remains in the same DSH conversation');
    const nextExecutor = work.locator('[data-executor-selector="true"]');
    const nextExecutorButton = nextExecutor.getByRole('button', { name: /选择角色/ });
    await nextExecutorButton.scrollIntoViewIfNeeded();
    await nextExecutorButton.click();
    const nextRoleMenu = work.getByRole('dialog', { name: '选择角色' });
    await nextRoleMenu.waitFor();
    await nextRoleMenu.getByRole('button', { name: /Synthetic Role Beta/ }).click();
    await nextRoleMenu.getByRole('button', { name: '应用角色' }).click();
    await nextExecutor.getByRole('button', { name: /选择模型 Profile/ }).click();
    const nextModelMenu = work.getByRole('dialog', { name: '选择模型 Profile' });
    await nextModelMenu.getByRole('button', { name: /ib-dsh-synthetic-agent.*Synthetic Role Alpha/ }).click();
    await nextModelMenu.getByRole('button', { name: '应用模型 Profile' }).click();
    await page.waitForFunction(input => {
      const state = IB.workMode.ui.getState();
      return state.run && state.run.status === 'completed' && state.executorSelection.roleId === input.alternateRoleRef
        && state.profileRef === input.profileRef && state.executorSelection.presetId === 'app-builder';
    }, FIXTURE, { timeout: 20000 });
    assert.match(await nextExecutor.locator('.ib-executor-role-trigger').innerText(), /Synthetic Role Beta/,
      'the role and Model Profile remain independently selectable');
    assert.match(await nextExecutor.locator('.ib-executor-profile-trigger').innerText(), /ib-dsh-synthetic-agent/,
      'the separate Model Profile control reports the manually selected model route');
    assert.match(await nextExecutor.locator('.ib-executor-profile-trigger').innerText(), /手动覆盖/);
    consent = await createAppRun(work, secondPanel, '请继续修改这个 APP：增加重要程度标记，以及全部、重要、已完成筛选；保留已保存的待办。', firstArtifact.draftRef, 'click');
    assert.match(await consent.innerText(), /Synthetic Role Beta/, 'the next Permission request reflects the changed executor selection');
    const secondRun = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      if (!link || link.ok !== true || !link.run || link.run.workflowId !== 'app.builder'
        || link.run.appDraftRef !== input.draftRef || !Array.isArray(link.runs) || link.runs.length !== 2
        || link.runs[0].run.runId !== link.run.runId || link.runs[1].run.runId !== input.firstRunId) {
        throw new Error('the follow-up Run was not appended to the same DSH Session and draft history');
      }
      const snapshot = link.run.executorSelection;
      if (!snapshot || snapshot.roleId !== input.alternateRoleRef || snapshot.roleName !== 'Synthetic Role Beta'
        || snapshot.presetId !== 'app-builder' || snapshot.profileRef !== input.profileRef
        || snapshot.providerScope.model !== 'ib-dsh-synthetic-agent'
        || JSON.stringify(snapshot.allowedTools) !== JSON.stringify(['app_draft.list_files', 'app_draft.read_file',
          'app_draft.create_file', 'app_draft.update_file'])) throw new Error('the follow-up Run did not pin its own executor and tool snapshot');
      return { runId: link.run.runId, draftRef: link.run.appDraftRef, runCount: link.runs.length,
        executorSelection: { roleId: snapshot.roleId, roleName: snapshot.roleName, profileRef: snapshot.profileRef, presetId: snapshot.presetId,
          providerModel: snapshot.providerScope.model, allowedTools: snapshot.allowedTools } };
    }, { sessionId: sessionId, draftRef: firstArtifact.draftRef, firstRunId: firstArtifact.runId,
      profileRef: FIXTURE.profileRef, alternateRoleRef: FIXTURE.alternateRoleRef });
    evidence.secondRun = secondRun;
    assert.equal((await resetFake()).ok, true);
    await authorizeThroughPermission(work, secondPanel, 'completed');
    await openWorkPanel(secondPanel);
    await secondPanel.locator('[data-app-builder-artifact]').waitFor();
    await openArtifactDetails(secondPanel);
    const secondArtifact = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const result = await IB.workMode.runtime.getResult(link.run.runId);
      const draft = await IB.homeNode.workRuns.getAppDraft(link.run.appDraftRef, link.run.projectRef, link.run.runId);
      const events = await IB.homeNode.workRuns.events(link.run.runId, { limit: 100 });
      const fakeConfig = window.__IB_TEST_FAKE_SERVICE__;
      const fake = await (await fetch(fakeConfig.origin + '/__status', { cache: 'no-store', headers: fakeConfig.headers })).json();
      const middleCalls = fake.models && fake.models['ib-dsh-synthetic-middle'] || 0;
      if (link.run.status !== 'completed' || !result || result.ok !== true || !draft || draft.ok !== true
        || !Array.isArray(link.runs) || link.runs.length !== 2
        || draft.draft.version <= input.firstVersion || !draft.draft.changes['app.js']
        || !fake.appBuilderObserved || !fake.personaMarkers.beta || middleCalls > 0
        || !fake.appDraftToolNames.includes('app_draft.read_file') || !fake.appDraftToolNames.includes('app_draft.update_file')) {
        throw new Error('the follow-up Run did not modify the existing Home Node draft under App Builder tools');
      }
      return { runId: link.run.runId, draftRef: link.run.appDraftRef, status: link.run.status,
        resultId: result.result.resultId, summary: result.result.report.summary, version: draft.draft.version,
        sessionRunIds: link.runs.map(item => item.run.runId), versionHistory: draft.draft.history,
        changedFiles: Object.keys(draft.draft.changes), toolNames: fake.appDraftToolNames.slice(), middleCalls: middleCalls,
        personaMarkers: fake.personaMarkers,
        executionEvents: events.executionEvents || [] };
    }, { sessionId: sessionId, firstVersion: firstArtifact.version });
    evidence.secondArtifact = secondArtifact;
    await openWorkPanel(secondPanel);
    await openRunHistory(secondPanel);
    await secondPanel.locator('[data-work-run-history="true"]').waitFor();
    assert.equal(await secondPanel.locator('[data-work-run-history="true"] li').count(), 2,
      'the DSH conversation displays both Home Node Work Run results');
    assert.ok(secondArtifact.versionHistory.some(item => item.runId === firstArtifact.runId));
    assert.ok(secondArtifact.versionHistory.some(item => item.runId === secondArtifact.runId));
    const secondPreview = work.frameLocator('iframe[title="App Draft preview"]');
    await secondPreview.locator('#todo-list li').filter({ hasText: '买牛奶' }).waitFor();
    assert.ok(await secondPanel.locator('[data-app-diff="app.js"]').innerText().then(text => text.includes('activeFilter')),
      'follow-up AI edits are shown as a diff while preserving local app data');

    assert.equal((await resetFake()).ok, true);
    consent = await createAppRun(work, secondPanel, '修复待办 APP 中一个小问题，并保留当前版本。', firstArtifact.draftRef);
    const invalidatedRun = await page.evaluate(async sessionIdValue => {
      const state = IB.workMode.ui.getState();
      const preview = await IB.workMode.ui.previewAuthorization();
      if (!preview || preview.ok !== true) throw new Error('App Builder authorization preview unavailable');
      const storage = await IB.workMode.ui.confirmStorageRisk(true);
      const scope = IB.workMode.ui.confirmScope(true);
      if (!storage || storage.ok !== true || !scope || scope.ok !== true) throw new Error('synthetic local consent precondition failed');
      const grant = await IB.workMode.ui.grant(900000, true);
      if (!grant || grant.ok !== true || !grant.consent) throw new Error('synthetic consent grant failed');
      const binding = await IB.homeNode.workRuns.bindDshSession(state.run.runId, {
        sessionId: sessionIdValue, consentId: grant.consent.consentId, expectedVersion: state.run.version
      });
      if (!binding || binding.ok !== true) throw new Error('synthetic DSH binding failed');
      const revoked = await IB.workMode.ui.revokeConsent();
      if (!revoked || revoked.ok !== true) throw new Error('synthetic consent revocation failed');
      const rejected = await IB.homeNode.workRuns.checkConsent(state.run.runId, grant.consent.consentId, {
        projectRef: state.run.projectRef, providerScope: state.run.executorSelection.providerScope,
        fileIds: [], consumer: 'agent', memoryScope: null
      });
      const run = await IB.homeNode.workRuns.get(state.run.runId);
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      const provider = await (await fetch(fake.origin + '/__status', { cache: 'no-store', headers: fake.headers })).json();
      return { runId: state.run.runId, consentId: grant.consent.consentId, revokeOk: revoked.ok,
        rejectedStart: rejected && rejected.ok !== true, startError: rejected && rejected.error,
        status: run.run.status, providerCalls: provider.calls };
    }, sessionId);
    evidence.invalidatedConsent = invalidatedRun;
    assert.equal(invalidatedRun.revokeOk, true);
    assert.equal(invalidatedRun.rejectedStart, true, 'a revoked Consent cannot start the queued Run');
    assert.equal(invalidatedRun.status, 'queued');
    assert.equal(invalidatedRun.providerCalls, 0, 'the revoked Run did not contact the Synthetic Provider');

    await work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId + '"][data-work-run-phase="needs-consent"]')
      .waitFor({ timeout: 12000 });
    assert.equal((await resetFake()).ok, true);
    await authorizeThroughPermission(work, secondPanel, 'running');
    await page.waitForFunction(async sessionIdValue => {
      const link = await IB.homeNode.workRuns.getDshSession(sessionIdValue);
      return !!link && link.ok === true && link.run && link.run.status === 'running';
    }, sessionId, { timeout: 20000 });
    await work.locator('[data-work-run-cancel="true"]').click();
    await work.locator('[data-work-run-phase="cancelled"]').waitFor({ timeout: 30000 });
    const cancelledRun = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const result = await IB.workMode.runtime.getResult(link.run.runId);
      const draft = await IB.homeNode.workRuns.getAppDraft(input.draftRef, input.projectRef, link.run.runId);
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      const provider = await (await fetch(fake.origin + '/__status', { cache: 'no-store', headers: fake.headers })).json();
      return { runId: link.run.runId, status: link.run.status, version: draft.draft.version,
        committedVersion: input.expectedVersion, providerWaiting: provider.waiting, providerCancelled: provider.cancelled,
        providerCalls: provider.calls, runCount: link.runs.length, resultAvailable: result.ok === true,
        draftReadOk: draft && draft.ok === true };
    }, { sessionId: sessionId, draftRef: firstArtifact.draftRef, projectRef: FIXTURE.projectRef,
      expectedVersion: secondArtifact.version });
    evidence.cancelledRun = cancelledRun;
    assert.equal(cancelledRun.status, 'cancelled', JSON.stringify(cancelledRun));
    assert.equal(cancelledRun.resultAvailable, false, JSON.stringify(cancelledRun));
    assert.equal(cancelledRun.draftReadOk, true, JSON.stringify(cancelledRun));
    assert.equal(cancelledRun.providerCalls, 0, 'the cancelled Run was stopped before its next provider request');
    assert.equal(cancelledRun.runCount, 3, 'the cancelled Run is kept in the same Session history');
    assert.equal(cancelledRun.version, secondArtifact.version, 'cancellation discards the uncommitted App Draft candidate');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__IB_DEV_SYNTHETIC__ === true && !!window.IB?.workMode?.ui, null, { timeout: 30000 });
    await page.evaluate(() => { navTo('work-mode'); });
    await page.locator('#wm-use-dsh').click();
    await page.waitForFunction(() => window.IB?.workMode?.nativeCandidate?.appliedTheme?.() !== null, null, { timeout: 20000 });
    work = getFrame();
    await work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId + '"]').waitFor({ timeout: 30000 });
    panel = work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId + '"]');
    await openWorkPanel(panel);
    await panel.locator('[data-app-builder-artifact]').waitFor();
    await openArtifactDetails(panel);
    await openRunHistory(panel);
    await panel.locator('[data-work-run-history="true"] li').nth(0).waitFor();
    assert.equal(await panel.locator('[data-work-run-history="true"] li').count(), 3,
      'a page refresh recovers all Session Run results, including cancellation');
    await page.waitForFunction(input => {
      const state = IB.workMode.ui.getState();
      return !!state.run && state.run.runId === input.runId && state.dshSessionId === input.sessionId
        && ['completed', 'failed', 'cancelled'].includes(state.run.status);
    }, { sessionId: sessionId, runId: cancelledRun.runId }, { timeout: 20000 });
    const restoredSession = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const draft = await IB.homeNode.workRuns.getAppDraft(input.draftRef, input.projectRef, link.run.runId);
      return { runIds: link.runs.map(item => item.run.runId), latest: link.run.runId,
        version: draft.draft.version, history: draft.draft.history.map(item => ({ version: item.version, runId: item.runId })) };
    }, { sessionId: sessionId, draftRef: firstArtifact.draftRef, projectRef: FIXTURE.projectRef });
    evidence.refreshRestore = restoredSession;
    assert.deepEqual(restoredSession.runIds.includes(firstArtifact.runId), true);
    assert.deepEqual(restoredSession.runIds.includes(secondArtifact.runId), true);
    assert.equal(restoredSession.latest, cancelledRun.runId);
    assert.equal(restoredSession.runIds.length, 3);

    const restoreVersionInComposer = async version => {
      await panel.locator('[data-app-restore-version="' + version + '"]').click();
      await panel.locator('[data-app-restore-confirm="' + version + '"]').click();
      await page.waitForFunction(async input => {
        const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
        const draft = await IB.homeNode.workRuns.getAppDraft(input.draftRef, input.projectRef, link.run.runId);
        const latest = draft && draft.draft && draft.draft.history[draft.draft.history.length - 1];
        return !!latest && latest.restoredFrom === input.version;
      }, { sessionId: sessionId, draftRef: firstArtifact.draftRef, projectRef: FIXTURE.projectRef, version: version }, { timeout: 20000 });
      await page.waitForTimeout(400);
    };
    const firstVersion = firstArtifact.version;
    await restoreVersionInComposer(firstVersion);
    const restoredFirst = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const draft = await IB.homeNode.workRuns.getAppDraft(input.draftRef, input.projectRef, link.run.runId);
      return { version: draft.draft.version, restoredFrom: draft.draft.history.at(-1).restoredFrom,
        hasFilterCode: draft.draft.files['app.js'].includes('activeFilter') };
    }, { sessionId: sessionId, draftRef: firstArtifact.draftRef, projectRef: FIXTURE.projectRef });
    assert.equal(restoredFirst.restoredFrom, firstVersion);
    assert.equal(restoredFirst.hasFilterCode, false, 'restore selects the earlier immutable source snapshot');
    await restoreVersionInComposer(secondArtifact.version);
    const restoredSecond = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const draft = await IB.homeNode.workRuns.getAppDraft(input.draftRef, input.projectRef, link.run.runId);
      return { version: draft.draft.version, restoredFrom: draft.draft.history.at(-1).restoredFrom,
        hasFilterCode: draft.draft.files['app.js'].includes('activeFilter') };
    }, { sessionId: sessionId, draftRef: firstArtifact.draftRef, projectRef: FIXTURE.projectRef });
    assert.equal(restoredSecond.restoredFrom, secondArtifact.version);
    assert.equal(restoredSecond.hasFilterCode, true, 'restore is additive and can recover the newer version');
    evidence.versionRestore = { previous: restoredFirst, restored: restoredSecond };

    await openWorkPanel(panel);
    await openArtifactDetails(panel);
    const currentDraftBeforeExport = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const draft = await IB.homeNode.workRuns.getAppDraft(link.run.appDraftRef, link.run.projectRef, link.run.runId);
      const version = await IB.homeNode.workRuns.getAppDraftVersion(link.run.appDraftRef, link.run.projectRef, input.version);
      return { version: draft.draft.version, history: draft.draft.history.map(item => item.version), selected: version.version,
        installed: localStorage.getItem('ib_generated_apps_v1'), enabled: localStorage.getItem('ib_apps_on_v1') };
    }, { sessionId: sessionId, version: firstArtifact.version });
    assert.equal(currentDraftBeforeExport.version, restoredSecond.version);
    assert.equal(currentDraftBeforeExport.selected.version, firstArtifact.version);
    const sourceVersionFiles = currentDraftBeforeExport.selected.files;
    const exportRoot = path.resolve(__dirname, '../.dsh-research/app-builder-p3');
    fs.mkdirSync(exportRoot, { recursive: true });
    const sourceVersionSelect = panel.getByLabel('导出版本');
    await sourceVersionSelect.selectOption(String(firstArtifact.version));
    const [sourceDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }), panel.locator('[data-app-export-source="true"]').click()
    ]);
    const sourceZipPath = path.join(exportRoot, sourceDownload.suggestedFilename());
    await sourceDownload.saveAs(sourceZipPath);
    await panel.locator('[data-app-export-status="true"]').filter({ hasText: '已开始下载' }).waitFor();
    const sourceZip = unzipStoredArchive(await fs.promises.readFile(sourceZipPath));
    assert.deepEqual(Object.keys(sourceZip).sort(), ['README.md', 'app.js', 'index.html', 'standalone.html', 'styles.css']);
    assert.deepEqual({ 'index.html': sourceZip['index.html'], 'styles.css': sourceZip['styles.css'], 'app.js': sourceZip['app.js'] }, sourceVersionFiles,
      'the ZIP contains source files from the selected immutable version');
    assert.match(sourceZip['README.md'], new RegExp('已提交草稿版本：v' + firstArtifact.version));
    assert.match(sourceZip['standalone.html'], /standalone-app-storage-request/);
    assert.doesNotMatch(sourceZip['standalone.html'], /ib-generated-app-storage-request|Home Node|__TAURI__|fetch\(/);

    await sourceVersionSelect.selectOption(String(secondArtifact.version));
    const [webDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }), panel.locator('[data-app-export-web="true"]').click()
    ]);
    const webAppPath = path.join(exportRoot, webDownload.suggestedFilename());
    await webDownload.saveAs(webAppPath);
    await panel.locator('[data-app-export-status="true"]').filter({ hasText: '已开始下载' }).waitFor();
    const webAppHtml = await fs.promises.readFile(webAppPath, 'utf8');
    assert.match(webAppHtml, /standalone-app-storage-request/);
    assert.doesNotMatch(webAppHtml, /ib-generated-app-storage-request|Home Node|__TAURI__|fetch\(/);
    const stateAfterExport = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const draft = await IB.homeNode.workRuns.getAppDraft(link.run.appDraftRef, link.run.projectRef, link.run.runId);
      return { version: draft.draft.version, history: draft.draft.history.map(item => item.version),
        installed: localStorage.getItem('ib_generated_apps_v1'), enabled: localStorage.getItem('ib_apps_on_v1') };
    }, { sessionId: sessionId });
    assert.equal(stateAfterExport.version, currentDraftBeforeExport.version);
    assert.deepEqual(stateAfterExport.history, currentDraftBeforeExport.history);
    assert.equal(stateAfterExport.installed, currentDraftBeforeExport.installed, 'export does not alter installed app packages');
    assert.equal(stateAfterExport.enabled, currentDraftBeforeExport.enabled, 'export does not alter App Store installation state');
    evidence.standaloneExport = { sourceZip: path.basename(sourceZipPath), webApp: path.basename(webAppPath),
      selectedSourceVersion: firstArtifact.version, selectedWebVersion: secondArtifact.version,
      zipFiles: Object.keys(sourceZip).sort(), latestDraftUnchanged: stateAfterExport.version === currentDraftBeforeExport.version,
      historyUnchanged: JSON.stringify(stateAfterExport.history) === JSON.stringify(currentDraftBeforeExport.history), installedStoreUnchanged: true };

    await page.locator('#wm-use-native').click();
    assert.equal(await page.locator('#wm-dsh-frame').isHidden(), true, 'Native Work UI fallback remains reachable before installation');
    await page.locator('#wm-use-dsh').click();
    assert.equal(await page.locator('#wm-dsh-frame').isVisible(), true, 'the DSH candidate can be reopened without losing the draft');
    work = getFrame();
    secondPanel = work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId + '"]');
    await openWorkPanel(secondPanel);
    await secondPanel.locator('[data-app-builder-artifact]').waitFor();
    await openArtifactDetails(secondPanel);
    await secondPanel.getByLabel('我已查看生成文件、差异和隔离预览，确认将此版本安装到归墟 App Store。').check();
    await secondPanel.getByRole('button', { name: '确认安装到 App Store' }).click();
    await page.waitForFunction(() => window.currentPage === 'apps' || location.hash === '#apps', null, { timeout: 20000 });
    const appId = await page.evaluate(draftRef => IB.apps.generatedAppId(draftRef), firstArtifact.draftRef);
    await page.locator('#appstore-grid').locator('[data-open="' + appId + '"]').waitFor();
    await page.locator('#appstore-grid').locator('[data-open="' + appId + '"]').click();
    const installedFrame = page.locator('#ib-app-overlay iframe.ib-generated-app-frame');
    await installedFrame.waitFor();
    let installedApp = page.frameLocator('#ib-app-overlay iframe.ib-generated-app-frame');
    await installedApp.locator('#todo-list li').filter({ hasText: '买牛奶' }).waitFor();
    await page.evaluate(() => location.reload());
    await page.waitForFunction(() => window.__IB_DEV_SYNTHETIC__ === true && !!window.IB?.apps, null, { timeout: 30000 });
    await page.waitForFunction(input => IB.apps.isGeneratedInstalled(input.draftRef), { draftRef: firstArtifact.draftRef }, { timeout: 20000 });
    const restoredAppId = await page.evaluate(draftRef => IB.apps.generatedAppId(draftRef), firstArtifact.draftRef);
    await page.locator('#appstore-grid').locator('[data-open="' + restoredAppId + '"]').waitFor();
    await page.locator('#appstore-grid').locator('[data-open="' + restoredAppId + '"]').click();
    installedApp = page.frameLocator('#ib-app-overlay iframe.ib-generated-app-frame');
    await installedApp.locator('#todo-list li').filter({ hasText: '买牛奶' }).waitFor();
    evidence.install = await page.evaluate(input => ({ appId: IB.apps.generatedAppId(input.draftRef),
      installed: IB.apps.isGeneratedInstalled(input.draftRef), page: window.currentPage || location.hash }), { draftRef: firstArtifact.draftRef });

    await page.evaluate(() => { if (IB.apps.isOpen()) IB.apps.close(); navTo('work-mode'); });
    await page.locator('#wm-use-dsh').click();
    await page.waitForFunction(() => window.IB?.workMode?.nativeCandidate?.appliedTheme?.() !== null, null, { timeout: 20000 });
    work = getFrame();
    const beforeFreshSession = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    await work.getByRole('button', { name: /新建会话|新会话|New session/ }).last().click();
    await work.waitForFunction(previous => {
      const current = document.querySelector('[data-conversation-session]');
      return !!current && current.dataset.conversationSession && current.dataset.conversationSession !== previous;
    }, beforeFreshSession, { timeout: 30000 });
    const freshSessionId = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    assert.notEqual(freshSessionId, beforeFreshSession);
    assert.equal(await work.locator('.ib-work-run-session').count(), 0,
      'a new Session starts with the native welcome and has no previous Work Record panel');
    const preservedHistory = await page.evaluate(async oldSessionId => {
      const link = await IB.homeNode.workRuns.getDshSession(oldSessionId);
      return { found: link.found, runs: link.runs.length, latestStatus: link.run.status };
    }, sessionId);
    assert.deepEqual(preservedHistory, { found: true, runs: 3, latestStatus: 'cancelled' },
      'opening a new Session leaves the previous Home Node Run history intact');
    evidence.newSessionIsolation = { clean: true, preservedRunCount: preservedHistory.runs,
      previousRunStatus: preservedHistory.latestStatus };

    const detachedBrowser = await chromium.launch({ headless: true });
    try {
      const detachedPage = await detachedBrowser.newPage();
      const standaloneRequests = [];
      detachedPage.on('request', request => standaloneRequests.push(request.url()));
      await detachedPage.goto(pathToFileURL(webAppPath).href, { waitUntil: 'load' });
      assert.equal(new URL(detachedPage.url()).protocol, 'file:');
      let standaloneApp = detachedPage.frameLocator('iframe#app');
      await standaloneApp.getByLabel('新待办').fill('脱离归墟后保留');
      await standaloneApp.getByRole('button', { name: '添加' }).click();
      const retainedTodo = standaloneApp.locator('#todo-list li').filter({ hasText: '脱离归墟后保留' });
      await retainedTodo.waitFor();
      await retainedTodo.locator('input[type="checkbox"]').check();
      await standaloneApp.getByLabel('新待办').fill('脱离归墟后删除');
      await standaloneApp.getByRole('button', { name: '添加' }).click();
      const removedTodo = standaloneApp.locator('#todo-list li').filter({ hasText: '脱离归墟后删除' });
      await removedTodo.waitFor();
      await removedTodo.getByRole('button', { name: '删除' }).click();
      await removedTodo.waitFor({ state: 'detached' });
      await detachedPage.reload({ waitUntil: 'load' });
      standaloneApp = detachedPage.frameLocator('iframe#app');
      const restoredTodo = standaloneApp.locator('#todo-list li').filter({ hasText: '脱离归墟后保留' });
      await restoredTodo.waitFor();
      assert.equal(await restoredTodo.getAttribute('data-done'), 'true', 'standalone localStorage preserves edits after file reload');
      assert.equal(await standaloneApp.locator('#todo-list li').filter({ hasText: '脱离归墟后删除' }).count(), 0,
        'standalone localStorage preserves deletion after file reload');
      assert.deepEqual(standaloneRequests.filter(url => /^https?:/i.test(url)), [], 'standalone app makes no network requests');
      const localStorageState = await detachedPage.evaluate(() => ({
        standaloneKeys: Object.keys(localStorage).filter(key => key.startsWith('ib-app-standalone-v1:')).length,
        ibApiAvailable: typeof window.IB !== 'object' && typeof window.__TAURI__ === 'undefined'
      }));
      assert.ok(localStorageState.standaloneKeys > 0);
      assert.equal(localStorageState.ibApiAvailable, true, 'standalone page has no InternalBeyond or Tauri runtime');
      evidence.detachedWebApp = { protocol: 'file:', add: true, edit: true, remove: true, refreshPersistence: true,
        externalRequests: standaloneRequests.filter(url => /^https?:/i.test(url)).length, storageNamespace: 'standalone-app-localStorage' };
    } finally { await detachedBrowser.close(); }

    assert.equal(evidence.gatewayPrompts, 0, 'the DSH Gateway did not bypass the Host tool/model adapters');
    assert.deepEqual(evidence.resourceFailures, []);
    assert.deepEqual(evidence.externalRequests, []);
    assert.deepEqual(evidence.errors, []);
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ pass: true, ...evidence }, null, 2));
    console.log(JSON.stringify({ pass: true, ...evidence }, null, 2));
  } finally {
    try { await page.evaluate(async () => {
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      if (fake) await fetch(fake.origin + '/__control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers),
        body: JSON.stringify({ holdNext: false }) });
    }); } catch (_) {}
    if (ownedFakeProvider) await ownedFakeProvider.close();
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
