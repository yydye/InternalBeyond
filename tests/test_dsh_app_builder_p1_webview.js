'use strict';

// Synthetic-only acceptance through the real Tauri WebView2 and pinned DSH UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(__dirname, '../../DeepSeek-Harness-Mock-PoC'));
const { chromium } = createRequire(path.join(source, 'apps/web/package.json'))('playwright');
const output = path.resolve(__dirname, '../.dsh-research/app-builder-p1');
const REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const FIXTURE = Object.freeze({ projectRef: 'dsh_synthetic_workspace', profileRef: 'dsh_synthetic_agent' });
const APP_TOOLS = ['app_draft.list_files', 'app_draft.read_file', 'app_draft.create_file', 'app_draft.update_file'];

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
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

    await page.goto('http://127.0.0.1:23130/InternalBeyond.html?app-builder-p1=' + Date.now() + '#work-mode', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__IB_DEV_MODE__ === true && window.__IB_DEV_SYNTHETIC__ === true
      && !!window.__TAURI__ && typeof IB?.workMode?.ui?.createRun === 'function', null, { timeout: 30000 });
    await page.evaluate(async input => {
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      window.__IB_TEST_FAKE_SERVICE__ = { origin: new URL(dev.fakeProviderUrl).origin,
        headers: { 'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId } };
      const host = await (await fetch(dev.dshControlUrl + '/status', { cache: 'no-store', headers: {
        'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId
      } })).json();
      if (host.ok !== true || host.synthetic !== true || host.environment !== 'synthetic'
        || host.phase !== 'ready' || host.revision !== input.revision) throw new Error('pinned Synthetic DSH Host required');
      const controller = IB.workMode.ui;
      const prior = await IB.homeNode.workRuns.listActive({ limit: 100 });
      for (const run of prior && prior.runs || []) {
        if (run.workflowId === 'app.builder' && run.projectRef === input.projectRef) {
          await IB.homeNode.workRuns.cancel(run.runId, { requestId: 'app-builder-test-cleanup-' + crypto.randomUUID(), expectedVersion: run.version });
        }
      }
      const refreshed = await controller.refresh();
      if (!refreshed || refreshed.ok !== true || refreshed.activeRuns !== 0) throw new Error('fresh Synthetic Work Run Store required');
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
      const agent = profiles.find(item => item && item.id === input.profileRef);
      if (!agent || agent.model !== 'ib-dsh-synthetic-agent' || !agent.systemPrompt) throw new Error('Synthetic role fixture unavailable');
      return { projectRef: input.projectRef, profileRef: input.profileRef, model: agent.model };
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
    let panel = work.locator('.ib-work-run-session');
    await panel.waitFor();
    let sessionId1 = await panel.getAttribute('data-dsh-session-id');
    const newSessionButton = work.getByRole('button', { name: /新建会话|新会话|New session/ }).last();
    await newSessionButton.waitFor();
    await newSessionButton.click();
    await work.waitForFunction(oldSession => {
      const current = document.querySelector('.ib-work-run-session');
      return !!current && current.dataset.dshSessionId && current.dataset.dshSessionId !== oldSession;
    }, sessionId1, { timeout: 30000 });
    panel = work.locator('.ib-work-run-session');
    sessionId1 = await panel.getAttribute('data-dsh-session-id');
    assert.match(sessionId1, /^session-[A-Fa-f0-9-]{36}$/);
    const selector = panel.locator('[data-executor-selector="true"]');
    await selector.getByRole('button', { name: '归墟执行者选择器' }).click({ force: true });
    const menu = selector.getByRole('dialog', { name: '选择归墟执行者' });
    await menu.getByLabel('角色').selectOption(FIXTURE.profileRef);
    await menu.getByLabel('Agent 预设').selectOption('app-builder');
    await menu.getByRole('button', { name: '应用执行者选择' }).click();
    await page.waitForFunction(input => {
      const state = IB.workMode.ui.getState();
      return state.executor === 'dsh' && state.profileRef === input.profileRef
        && state.executorSelection.roleId === input.profileRef && state.executorSelection.presetId === 'app-builder';
    }, FIXTURE, { timeout: 20000 });
    assert.match(await selector.locator('.ib-executor-trigger').innerText(), /Synthetic 大黑塔/);
    assert.match(await selector.locator('.ib-executor-trigger').innerText(), /App Builder/);

    const createAppRun = async (targetWork, targetPanel, prompt, draftRef) => {
      await targetPanel.locator('[data-app-builder-form]').waitFor();
      if (draftRef) await targetPanel.getByLabel('App Draft').selectOption(draftRef);
      else await targetPanel.getByLabel('App Draft').selectOption('');
      await targetPanel.getByLabel('App Builder 自然语言需求').fill(prompt);
      await targetPanel.getByRole('button', { name: draftRef ? '创建 Run 并修改草稿' : '创建 Run 并生成 Todo App' }).click();
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
      const consent = targetPanel.locator('[data-app-builder-consent="true"]');
      await consent.waitFor();
      assert.match(await consent.innerText(), /模型/);
      assert.match(await consent.innerText(), /不会读取 Workspace/);
      assert.doesNotMatch(await consent.innerText(), /Review Provider ·|Memory Recall ·/);
      return consent;
    };
    let consent = await createAppRun(work, panel, '生成一个轻量待办 APP，支持新增、完成、删除，数据只保存在 APP 本地空间。', '');
    let sessionId = sessionId1;
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

    const resetFake = async () => page.evaluate(async () => {
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      return (await fetch(fake.origin + '/__control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers),
        body: JSON.stringify({ reset: true }) })).json();
    });
    assert.equal((await resetFake()).ok, true);
    await consent.getByLabel('确认将需求、角色提示词和草稿文件发送给此模型。').check();
    await consent.getByLabel('接受上述明文存储风险。').check();
    await consent.getByRole('button', { name: '确认并开始本次 Run' }).click();
    await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 90000 });
    await panel.locator('[data-app-builder-artifact]').waitFor();
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
      if (!fake.appBuilderObserved || !fake.personaObserved || !fake.appDraftToolNames.includes('app_draft.create_file')) {
        throw new Error('Synthetic Fake Provider did not observe the role persona or App Builder tool pipeline');
      }
      return { runId: link.run.runId, draftRef: link.run.appDraftRef, status: link.run.status, resultId: result.result.resultId,
        summary: result.result.report.summary, files: Object.keys(draft.draft.files).sort(), version: draft.draft.version,
        executionEvents: events.executionEvents || [], appBuilderObserved: fake.appBuilderObserved, personaObserved: fake.personaObserved,
        toolNames: fake.appDraftToolNames.slice(), models: fake.models, middleCalls: fake.models['ib-dsh-synthetic-middle'] || 0 };
    }, { sessionId: sessionId });
    assert.deepEqual(firstArtifact.files, ['app.js', 'index.html', 'styles.css']);
    assert.equal(firstArtifact.middleCalls, 0, 'the App Builder Run does not send generated files to Middle Brain or use project Memory');
    assert.ok(firstArtifact.executionEvents.some(item => item.event === 'app-draft-file-written'));
    evidence.firstArtifact = firstArtifact;

    const nextSessionButton = work.getByRole('button', { name: /新建会话|新会话|New session/ }).last();
    await nextSessionButton.click();
    await work.waitForFunction(oldSession => {
      const current = document.querySelector('.ib-work-run-session');
      return !!current && current.dataset.dshSessionId && current.dataset.dshSessionId !== oldSession;
    }, sessionId, { timeout: 30000 });
    work = getFrame();
    const secondPanel = work.locator('.ib-work-run-session');
    sessionId = await secondPanel.getAttribute('data-dsh-session-id');
    await secondPanel.locator('[data-executor-selector="true"]').waitFor();
    consent = await createAppRun(work, secondPanel, '请继续修改这个 APP：增加重要程度标记，以及全部、重要、已完成筛选；保留已保存的待办。', firstArtifact.draftRef);
    const secondRun = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      if (!link || link.ok !== true || !link.run || link.run.workflowId !== 'app.builder'
        || link.run.appDraftRef !== input.draftRef) throw new Error('the follow-up Run was not pinned to the selected existing draft');
      return { runId: link.run.runId, draftRef: link.run.appDraftRef };
    }, { sessionId: sessionId, draftRef: firstArtifact.draftRef });
    evidence.secondRun = secondRun;
    assert.equal((await resetFake()).ok, true);
    await consent.getByLabel('确认将需求、角色提示词和草稿文件发送给此模型。').check();
    await consent.getByLabel('接受上述明文存储风险。').check();
    await consent.getByRole('button', { name: '确认并开始本次 Run' }).click();
    await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 90000 });
    await secondPanel.locator('[data-app-builder-artifact]').waitFor();
    const secondArtifact = await page.evaluate(async input => {
      const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
      const result = await IB.workMode.runtime.getResult(link.run.runId);
      const draft = await IB.homeNode.workRuns.getAppDraft(link.run.appDraftRef, link.run.projectRef, link.run.runId);
      const events = await IB.homeNode.workRuns.events(link.run.runId, { limit: 100 });
      const fakeConfig = window.__IB_TEST_FAKE_SERVICE__;
      const fake = await (await fetch(fakeConfig.origin + '/__status', { cache: 'no-store', headers: fakeConfig.headers })).json();
      const middleCalls = fake.models && fake.models['ib-dsh-synthetic-middle'] || 0;
      if (link.run.status !== 'completed' || !result || result.ok !== true || !draft || draft.ok !== true
        || draft.draft.version <= input.firstVersion || !draft.draft.changes['app.js']
        || !fake.appBuilderObserved || middleCalls > 0
        || !fake.appDraftToolNames.includes('app_draft.read_file') || !fake.appDraftToolNames.includes('app_draft.update_file')) {
        throw new Error('the follow-up Run did not modify the existing Home Node draft under App Builder tools');
      }
      return { runId: link.run.runId, draftRef: link.run.appDraftRef, status: link.run.status,
        resultId: result.result.resultId, summary: result.result.report.summary, version: draft.draft.version,
        changedFiles: Object.keys(draft.draft.changes), toolNames: fake.appDraftToolNames.slice(), middleCalls: middleCalls,
        executionEvents: events.executionEvents || [] };
    }, { sessionId: sessionId, firstVersion: firstArtifact.version });
    evidence.secondArtifact = secondArtifact;
    const secondPreview = work.frameLocator('iframe[title="App Draft preview"]');
    await secondPreview.locator('#todo-list li').filter({ hasText: '买牛奶' }).waitFor();
    assert.ok(await secondPanel.locator('[data-app-diff="app.js"]').innerText().then(text => text.includes('activeFilter')),
      'follow-up AI edits are shown as a diff while preserving local app data');
    await page.locator('#wm-use-native').click();
    assert.equal(await page.locator('#wm-dsh-frame').isHidden(), true, 'Native Work UI fallback remains reachable before installation');
    await page.locator('#wm-use-dsh').click();
    assert.equal(await page.locator('#wm-dsh-frame').isVisible(), true, 'the DSH candidate can be reopened without losing the draft');
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

    assert.equal(evidence.gatewayPrompts, 0, 'the DSH Gateway did not bypass the Host tool/model adapters');
    assert.deepEqual(evidence.resourceFailures, []);
    assert.deepEqual(evidence.externalRequests, []);
    assert.deepEqual(evidence.errors, []);
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ pass: true, ...evidence }, null, 2));
    console.log(JSON.stringify({ pass: true, ...evidence }, null, 2));
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
