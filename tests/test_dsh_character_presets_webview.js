'use strict';

// P3 Synthetic acceptance against the real Tauri WebView2, pinned DSH Web UI,
// Home Node Run Store, and loopback Fake Provider only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(__dirname, '../../DeepSeek-Harness-Mock-PoC'));
const { chromium } = createRequire(path.join(source, 'apps/web/package.json'))('playwright');
const output = path.resolve(__dirname, '../.dsh-research/native-work-p3');
const REVISION = 'd743267388641bc76f17c45ce8b4c231aed1d32c';
const FIXTURE = Object.freeze({ projectRef: 'dsh_synthetic_workspace', profileRef: 'dsh_synthetic_agent', fileId: 'dsh_synthetic_readme' });

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
        try {
          const value = JSON.parse(typeof frame.payload === 'string' ? frame.payload : '');
          if (value.method === 'session/prompt') evidence.gatewayPrompts++;
        } catch (_) {}
      });
    });
    page.on('response', response => {
      if (response.url().startsWith('http://127.0.0.1:23141/') && response.status() >= 400) {
        evidence.resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
      }
    });
    page.on('request', request => {
      try {
        const url = new URL(request.url());
        if (!['127.0.0.1', 'localhost', 'ipc.localhost'].includes(url.hostname)) evidence.externalRequests.push(url.origin);
      } catch (_) {}
    });

    await page.goto('http://127.0.0.1:23130/InternalBeyond.html?dsh-character-presets=' + Date.now() + '#work-mode', {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(() => window.__IB_DEV_MODE__ === true && window.__IB_DEV_SYNTHETIC__ === true
      && !!window.__TAURI__ && typeof IB?.workMode?.ui?.createRun === 'function', null, { timeout: 30000 });
    await page.evaluate(() => {
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      window.__IB_TEST_FAKE_SERVICE__ = { origin: new URL(dev.fakeProviderUrl).origin,
        headers: { 'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId } };
    });

    evidence.syntheticWorkspace = await page.evaluate(async input => {
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      const host = await (await fetch(dev.dshControlUrl + '/status', { cache: 'no-store', headers: {
        'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId
      } })).json();
      if (host.ok !== true || host.synthetic !== true || host.phase !== 'ready' || host.environment !== 'synthetic'
        || host.devInstanceId !== dev.instanceId || host.revision !== input.revision) throw new Error('pinned Synthetic DSH Host required');
      const controller = IB.workMode.ui;
      const refreshed = await controller.refresh();
      if (!refreshed || refreshed.ok !== true || refreshed.activeRuns !== 0) throw new Error('fresh Synthetic Run Store required');
      const selectedProject = await controller.setSelectedProject(input.projectRef);
      if (!selectedProject || selectedProject.ok !== true) throw new Error('Synthetic Workspace project selection failed');
      const project = await controller.refreshProjectSnapshot(input.projectRef);
      if (!project || project.ok !== true) throw new Error('Synthetic Workspace snapshot failed');
      const files = await controller.setFileIds([input.fileId]);
      if (!files || files.ok !== true) throw new Error('Synthetic file selection failed');
      let profiles = [];
      const profileDeadline = Date.now() + 20000;
      while (Date.now() < profileDeadline) {
        try { await loadApiConfigs(); } catch (_) {}
        profiles = Array.isArray(window.apiConfigs) ? window.apiConfigs : [];
        if (profiles.some(item => item && item.id === input.profileRef)) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      const agent = (profiles || []).find(item => item && item.id === input.profileRef);
      if (!agent || agent.model !== 'ib-dsh-synthetic-agent' || !agent.systemPrompt) throw new Error('Synthetic character fixture unavailable: '
        + JSON.stringify((profiles || []).map(item => ({ id: item && item.id, model: item && item.model,
          hasSystemPrompt: !!(item && item.systemPrompt), archived: item && item.archived === true }))));
      if (controller.getState().run) throw new Error('the DSH UI must create this Run after executor selection');
      return { projectRef: input.projectRef, fileIds: controller.getState().fileIds.slice(), roleId: agent.id,
        roleName: agent.nickname || agent.name, model: agent.model };
    }, Object.assign({ revision: REVISION }, FIXTURE));

    await page.locator('#wm-use-dsh').click();
    await page.locator('#wm-dsh-reload').click();
    const getFrame = () => page.frames().find(item => item.url().startsWith('http://127.0.0.1:23141/'));
    await page.waitForFunction(() => window.IB?.workMode?.nativeCandidate?.appliedTheme?.() !== null, null, { timeout: 20000 });
    let work = getFrame();
    assert.ok(work, 'pinned official DSH Web UI is embedded in the Tauri WebView2');
    let panel = work.locator('.ib-work-run-session');
    await panel.waitFor();
    const previousSessionId = await panel.getAttribute('data-dsh-session-id');
    const newSessionButton = work.getByRole('button', { name: /新建会话|新会话|New session/ }).last();
    await newSessionButton.waitFor();
    await newSessionButton.click();
    await work.waitForFunction(oldSessionId => {
      const current = document.querySelector('.ib-work-run-session');
      return !!current && current.dataset.dshSessionId && current.dataset.dshSessionId !== oldSessionId;
    }, previousSessionId, { timeout: 30000 });
    panel = work.locator('.ib-work-run-session');
    await panel.waitFor();
    const previewNotice = work.getByRole('dialog').filter({ hasText: '预览版说明' });
    if (await previewNotice.isVisible().catch(() => false)) {
      await previewNotice.getByRole('button', { name: '继续', exact: true }).click();
    }
    const selector = work.locator('[data-executor-selector="true"]');
    await selector.waitFor();
    await selector.getByRole('button', { name: '归墟执行者选择器' }).evaluate(button => button.click());
    const menu = selector.getByRole('dialog', { name: '选择归墟执行者' });
    await menu.waitFor();
    await menu.getByLabel('角色').selectOption(FIXTURE.profileRef);
    await menu.getByLabel('Agent 预设').selectOption('coding');
    await menu.getByRole('button', { name: '应用执行者选择' }).evaluate(button => button.click());
    try {
      await page.waitForFunction(input => {
        const state = IB.workMode.ui.getState();
        return state.executor === 'dsh' && state.profileRef === input.profileRef
          && state.executorSelection.roleId === input.profileRef && state.executorSelection.presetId === 'coding';
      }, FIXTURE, { timeout: 20000 });
    } catch (_) {
      const state = await page.evaluate(() => {
        const current = IB.workMode.ui.getState();
        return { executor: current.executor, profileRef: current.profileRef, executorSelection: current.executorSelection,
          error: current.error, notice: current.notice };
      });
      const selectorText = await selector.innerText().catch(() => '');
      throw new Error('DSH executor selection did not apply: ' + JSON.stringify({ state: state, selector: selectorText }));
    }
    const executorLabel = await selector.locator('.ib-executor-trigger').innerText();
    assert.match(executorLabel, /Synthetic Role Alpha/);
    assert.match(executorLabel, /coding/i);
    evidence.selectedExecutor = await page.evaluate(() => {
      const state = IB.workMode.ui.getState();
      return { roleId: state.executorSelection.roleId, profileRef: state.profileRef, presetId: state.executorSelection.presetId };
    });
    const consentFiles = await page.evaluate(fileId => IB.workMode.ui.setFileIds([fileId]), FIXTURE.fileId);
    if (!consentFiles || consentFiles.ok !== true) throw new Error('Synthetic Consent file scope was not retained after executor selection');

    await work.locator('[data-work-run-phase="needs-run"]').waitFor();
    await panel.getByRole('button', { name: '工作记录' }).click();
    await panel.locator('[data-work-run-details]').waitFor();
    await work.getByRole('button', { name: '创建 Home Node Run 并绑定此 Session' }).click();
    await work.locator('[data-work-run-phase="needs-consent"]').waitFor();
    const sessionId = await work.locator('.ib-work-run-session').getAttribute('data-dsh-session-id');
    assert.match(sessionId, /^session-[A-Fa-f0-9-]{36}$/);
    evidence.pinnedRun = await page.evaluate(async sessionIdValue => {
      const link = await IB.homeNode.workRuns.getDshSession(sessionIdValue);
      if (!link || link.ok !== true || !link.found || link.run.status !== 'queued') throw new Error('Home Node did not bind the new Session to its Run');
      const selection = link.run.executorSelection;
      if (!selection || selection.roleId !== 'dsh_synthetic_agent' || selection.presetId !== 'coding'
        || selection.profileRef !== 'dsh_synthetic_agent' || selection.providerScope.model !== 'ib-dsh-synthetic-agent'
        || selection.maxProjectReadCalls !== 12
        || JSON.stringify(selection.allowedTools) !== JSON.stringify(['project.read_file'])) throw new Error('Run executor snapshot is incomplete');
      const preview = await IB.workMode.ui.previewAuthorization();
      if (!preview || preview.ok !== true) throw new Error('Consent route preview unavailable');
      const agent = preview.providers.find(item => item.destination === 'agent');
      const previewScope = agent.scope || agent;
      if (JSON.stringify(selection.providerScope) !== JSON.stringify({
        destination: 'agent', providerRef: previewScope.providerRef, provider: previewScope.provider,
        model: previewScope.model, routeHash: previewScope.routeHash
      })) throw new Error('pinned Run route and Consent preview differ');
      return { runId: link.run.runId, sessionId: link.binding.sessionId, roleId: selection.roleId,
        roleName: selection.roleName, presetId: selection.presetId, providerRef: selection.providerScope.providerRef,
        provider: selection.providerScope.provider, model: selection.providerScope.model, allowedTools: selection.allowedTools,
        maxProjectReadCalls: selection.maxProjectReadCalls };
    }, sessionId);
    const permission = work.locator('#dsh-startup-permission');
    await permission.waitFor();
    const consentText = await permission.innerText();
    assert.match(consentText, /Synthetic Role Alpha/);
    assert.match(consentText, /Coding/);
    assert.match(consentText, /ib-dsh-synthetic-agent/);
    evidence.consentShowsExecutor = true;

    const fakeReset = await page.evaluate(async () => {
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      return (await fetch(fake.origin + '/__control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers),
        body: JSON.stringify({ reset: true }) })).json();
    });
    assert.equal(fakeReset.ok, true);
    const permissionChecks = permission.locator('input[type="checkbox"]');
    for (let index = 0; index < await permissionChecks.count(); index++) await permissionChecks.nth(index).check();
    await permission.getByRole('button', { name: '确认并请求 Host 核验' }).click();
    await work.locator('[data-work-run-phase="ready"]').waitFor();
    await work.waitForFunction(() => document.querySelector('#dsh-startup-permission [role=dialog]')?.dataset.permissionPhase === 'verified',
      null, { timeout: 20000 });
    await permission.getByRole('button', { name: '返回任务界面' }).click();
    await work.getByRole('button', { name: '执行已授权只读审计' }).click();
    await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 90000 });

    const completed = await page.evaluate(async sessionIdValue => {
      const link = await IB.homeNode.workRuns.getDshSession(sessionIdValue);
      const result = await IB.workMode.runtime.getResult(link.run.runId);
      const events = await IB.homeNode.workRuns.events(link.run.runId, { limit: 100 });
      const fakeConfig = window.__IB_TEST_FAKE_SERVICE__;
      const fake = await (await fetch(fakeConfig.origin + '/__status', { cache: 'no-store', headers: fakeConfig.headers })).json();
      if (link.run.status !== 'completed' || !result || result.ok !== true || !result.result || result.result.status !== 'available') {
        throw new Error('Home Node did not persist the completed Result');
      }
      if (!fake.personaObserved || !fake.codingPresetObserved || fake.models['ib-dsh-synthetic-agent'] < 2
        || fake.models['ib-dsh-synthetic-middle'] !== 2) throw new Error('Fake Provider did not observe the selected identity, preset, and route');
      return { runId: link.run.runId, status: link.run.status, resultId: result.result.resultId,
        summary: result.result.report.summary, executorSelection: link.run.executorSelection,
        memoryDerived: result.result.memoryDerived, executionEvents: events.executionEvents || [], fakeModels: fake.models,
        personaObserved: fake.personaObserved, codingPresetObserved: fake.codingPresetObserved };
    }, sessionId);
    evidence.completedRun = completed;
    assert.ok(completed.executionEvents.some(item => item.event === 'project-read' && item.toolName === 'project.read_file'),
      'the selected Coding preset uses the Home Node Consent-scoped read tool');
    assert.equal(completed.memoryDerived, false, 'the Result contains no memory-derived data');

    await panel.getByRole('button', { name: '工作记录' }).click();
    await panel.locator('[data-work-run-details]').waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__IB_DEV_SYNTHETIC__ === true && !!window.IB?.workMode?.ui, null, { timeout: 30000 });
    await page.locator('#wm-use-dsh').click();
    await page.locator('#wm-dsh-reload').click();
    await page.waitForFunction(() => window.IB?.workMode?.nativeCandidate?.appliedTheme?.() !== null, null, { timeout: 20000 });
    work = getFrame();
    await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 30000 });
    panel = work.locator('.ib-work-run-session[data-dsh-session-id="' + sessionId + '"]');
    assert.equal(await panel.getAttribute('data-dsh-session-id'), sessionId);
    await panel.getByRole('button', { name: '工作记录' }).click();
    await panel.locator('[data-work-run-details]').waitFor();
    assert.ok((await work.getByRole('article').innerText()).includes('DSH Synthetic Work UI acceptance'));
    const restored = await page.evaluate(async sessionIdValue => {
      const link = await IB.homeNode.workRuns.getDshSession(sessionIdValue);
      const result = await IB.workMode.runtime.getResult(link.run.runId);
      return { roleId: link.run.executorSelection.roleId, presetId: link.run.executorSelection.presetId,
        model: link.run.executorSelection.providerScope.model, resultId: result.result.resultId };
    }, sessionId);
    assert.deepEqual(restored, { roleId: 'dsh_synthetic_agent', presetId: 'coding', model: 'ib-dsh-synthetic-agent', resultId: completed.resultId });
    evidence.refreshRestoredSameSessionAndResult = true;

    await page.locator('#wm-use-native').click();
    assert.equal(await page.locator('#wm-dsh-frame').isHidden(), true, 'Native Work UI fallback remains available');
    await page.locator('#wm-use-dsh').click();
    assert.equal(await page.locator('#wm-dsh-frame').isVisible(), true);
    assert.equal(evidence.gatewayPrompts, 0, 'DSH Gateway did not execute an unbound second Agent');
    assert.deepEqual(evidence.resourceFailures, []);
    assert.deepEqual(evidence.externalRequests, []);
    assert.deepEqual(evidence.errors, []);
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ pass: true, ...evidence }, null, 2));
    console.log(JSON.stringify({ pass: true, ...evidence }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
