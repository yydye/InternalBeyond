'use strict';

// End-to-end acceptance against the already running Synthetic Tauri WebView2.
// Uses only the isolated DSH Workspace and the local Fake Provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(__dirname, '../../DeepSeek-Harness-Mock-PoC'));
const { chromium } = createRequire(path.join(source, 'apps/web/package.json'))('playwright');
const output = path.resolve(__dirname, '../.dsh-research/native-work-p2');
const { SYNTHETIC_MEMORY_SENTINEL } = require('../runtime/dev-synthetic-seed.js');
const FIXTURE = Object.freeze({ projectRef: 'dsh_synthetic_workspace', profileRef: 'dsh_synthetic_agent', fileId: 'dsh_synthetic_readme' });

async function cancelPendingPermission(work) {
  const dialog = work.locator('#dsh-startup-permission');
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.getByRole('button', { name: '返回任务界面', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
  const evidence = { host: 'Synthetic Tauri WebView2', revision: 'd743267388641bc76f17c45ce8b4c231aed1d32c', errors: [], resourceFailures: [], externalRequests: [], gatewayPrompts: 0 };
  let fakeProviderOrigin = '';
  try {
    const page = browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1:23130/InternalBeyond.html'));
    assert.ok(page, 'Synthetic Tauri page must already exist');
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => {
      const stackLines = String(error.stack || '').split(/\r?\n/);
      let source = '';
      for (const line of stackLines) {
        const location = line.match(/([^/\\\s()?#]+\.js)(?:\?[^\s):]*)?:(\d+):(\d+)/);
        if (location) { source = location[1] + ':' + location[2]; break; }
      }
      evidence.errors.push({ message: error.message, source: source });
    });
    page.on('websocket', socket => {
      if (!socket.url().startsWith('ws://127.0.0.1:23141/')) return;
      socket.on('framesent', frame => {
        try {
          const value = JSON.parse(typeof frame.payload === 'string' ? frame.payload : '');
          if (value.method === 'session/prompt') evidence.gatewayPrompts++;
        } catch (_) { /* binary and non-RPC frames contain no verification data */ }
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
      } catch (_) { /* Ignore browser-internal URLs. */ }
    });
    page.on('requestfailed', request => {
      try {
        const url = new URL(request.url());
        if (url.origin === fakeProviderOrigin) evidence.fakeRequestFailures = (evidence.fakeRequestFailures || []).concat({
          path: url.pathname, error: request.failure() && request.failure().errorText || ''
        });
      } catch (_) { /* Ignore browser-internal URLs. */ }
    });
    await page.goto('http://127.0.0.1:23130/InternalBeyond.html?dsh-native-work-p2=' + Date.now() + '#work-mode', {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(() => window.__IB_DEV_SYNTHETIC__ === true
      && typeof IB?.homeNode?.workRuns?.getDshSession === 'function', null, { timeout: 30000 });
    fakeProviderOrigin = await page.evaluate(() => new URL(window.__IB_DEV_SERVICE_CONFIG__.fakeProviderUrl).origin);
    await page.evaluate(() => {
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      window.__IB_TEST_FAKE_SERVICE__ = {
        origin: new URL(dev.fakeProviderUrl).origin,
        headers: { 'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId }
      };
    });
    const boot = await page.evaluate(async memorySentinel => {
      if (window.__IB_DEV_MODE__ !== true || window.__IB_DEV_SYNTHETIC__ !== true || !window.__TAURI__) {
        throw new Error('real Synthetic Tauri WebView2 required');
      }
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      if (!dev || !dev.dshControlUrl || !dev.sessionToken || !dev.instanceId) throw new Error('Dev service identity unavailable');
      const host = await (await fetch(dev.dshControlUrl + '/status', { cache: 'no-store', headers: {
        'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId
      } })).json();
      if (host.ok !== true || host.synthetic !== true || host.phase !== 'ready'
        || host.environment !== 'synthetic' || host.devInstanceId !== dev.instanceId
        || host.revision !== 'd743267388641bc76f17c45ce8b4c231aed1d32c') throw new Error('pinned synthetic DSH host required');
      let runs = null;
      const runStoreDeadline = Date.now() + 15000;
      while (Date.now() < runStoreDeadline) {
        try { runs = await IB.homeNode.workRuns.listActive({ limit: 20 }); } catch (_) { runs = null; }
        if (runs && runs.ok === true) break;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      if (!runs || runs.ok !== true) throw new Error('Synthetic Home Node Work Run Store did not become ready');
      if (runs.hasMore || runs.runs.length > 1) throw new Error('at most one Synthetic fixture Run required');
      const controller = IB.workMode.ui;
      if (!controller) throw new Error('Work Mode authority unavailable');
      const workspace = IB.workspace && IB.workspace.files;
      if (!IB.createWorkRunRemote || !workspace || typeof workspace.wsGetWorkModeProjectSnapshot !== 'function'
        || typeof workspace.wsReadWorkModeFile !== 'function') throw new Error('Home Node Workspace bridge prerequisites unavailable');
      if (!IB.homeNode.agentMemory || typeof IB.homeNode.agentMemory.query !== 'function'
        || typeof IB.homeNode.agentMemory.create !== 'function') throw new Error('independent Agent Memory Authority unavailable');
      const memoryQuery = await IB.homeNode.agentMemory.query({ projectRef: 'dsh_synthetic_workspace', type: 'Fact', status: 'active', limit: 20 });
      if (!memoryQuery || memoryQuery.ok !== true || !Array.isArray(memoryQuery.records)) throw new Error('Synthetic project Memory Recall query failed');
      let memory = memoryQuery.records.find(record => record && record.payload && record.payload.statement === memorySentinel);
      if (!memory) {
        const createdMemory = await IB.homeNode.agentMemory.create({
          type: 'Fact', projectRef: 'dsh_synthetic_workspace', payload: { statement: memorySentinel, confidence: 'high', observedAt: Date.now() },
          provenance: { sourceKind: 'user_explicit', sourceRef: 'dsh_p2_synthetic_fixture' }, confirmed: true
        });
        if (!createdMemory || createdMemory.ok !== true || !createdMemory.record) throw new Error('Synthetic project Memory fixture creation failed');
        memory = createdMemory.record;
      }
      const memoryId = String(memory.memoryId || '');
      if (!/^am_[A-Za-z0-9-]{36}$/.test(memoryId) || memory.projectRef !== 'dsh_synthetic_workspace') throw new Error('Synthetic Memory fixture scope is invalid');
      if (runs.runs.length === 0) {
        const refreshed = await controller.refresh();
        if (!refreshed || refreshed.ok !== true || refreshed.activeRuns !== 0) throw new Error('Synthetic Run ledger did not refresh');
        const project = await controller.setSelectedProject('dsh_synthetic_workspace');
        if (!project || project.ok !== true) throw new Error('Synthetic Workspace selection failed');
        const recall = await controller.refreshMemoryRecall('dsh_synthetic_workspace');
        if (!recall || recall.ok !== true || !recall.records.some(record => record.memoryId === memoryId)) throw new Error('Synthetic project Recall did not load');
        const snapshot = await controller.refreshProjectSnapshot('dsh_synthetic_workspace');
        if (!snapshot || snapshot.ok !== true) throw new Error('Synthetic Workspace snapshot failed');
        const files = await controller.setFileIds(['dsh_synthetic_readme']);
        if (!files || files.ok !== true) throw new Error('Synthetic Workspace file selection failed');
        const created = await controller.createRun('dsh_synthetic_workspace');
        if (!created || created.ok !== true || !created.run) throw new Error('Synthetic queued Run creation failed');
        const executor = await controller.setExecutor('dsh');
        const profile = await controller.setProfileRef('dsh_synthetic_agent');
        const preview = await controller.previewAuthorization();
        if (!executor.ok || !profile.ok || !preview.ok) throw new Error('Synthetic Provider scope setup failed');
        return { scenario: 'queued-session', runId: created.run.runId, status: created.run.status, version: created.run.version, memoryId };
      }
      const run = runs.runs[0];
      if (run.status !== 'queued' || run.projectRef !== 'dsh_synthetic_workspace' || run.workflowId !== 'project.audit.readonly') {
        throw new Error('Synthetic fixture Run must remain queued and isolated');
      }
      const selected = await controller.selectRun(run.runId);
      if (!selected || selected.ok !== true) throw new Error('Synthetic Run selection failed');
      const recall = await controller.refreshMemoryRecall('dsh_synthetic_workspace');
      if (!recall || recall.ok !== true || !recall.records.some(record => record.memoryId === memoryId)) throw new Error('Synthetic project Recall did not load');
      const executor = await controller.setExecutor('dsh');
      if (!executor || executor.ok !== true) throw new Error('DSH executor unavailable');
      const profile = await controller.setProfileRef('dsh_synthetic_agent');
      if (!profile || profile.ok !== true) throw new Error('Synthetic Agent route selection failed');
      const files = await controller.setFileIds(['dsh_synthetic_readme']);
      if (!files || files.ok !== true) throw new Error('Synthetic Workspace file selection failed');
      const preview = await controller.previewAuthorization();
      if (!preview || preview.ok !== true) throw new Error('Home Node authorization preview failed');
      if (!preview.providers.some(item => item.destination === 'agent' && item.model === 'ib-dsh-synthetic-agent')
        || !preview.providers.some(item => item.destination === 'middle_brain' && item.model === 'ib-dsh-synthetic-middle')) {
        throw new Error('both normalized synthetic Provider routes must be visible to Consent');
      }
      const state = controller.getState();
      if (state.consentId || state.consent || state.memorySelectedIds.length) throw new Error('fixture must begin without Consent or Memory');
      return { scenario: 'queued-session', runId: run.runId, status: run.status, version: run.version, memoryId,
        fileIds: state.fileIds.slice(), providers: preview.providers.map(item => ({ destination: item.destination, provider: item.provider, model: item.model, endpointLabel: item.endpointLabel })) };
    }, SYNTHETIC_MEMORY_SENTINEL);
    evidence.initialRun = boot;

    await page.evaluate(() => { location.hash = '#work-mode'; });
    await page.locator('#wm-use-dsh').click();
    await page.locator('#wm-dsh-reload').click();
    const getFrame = () => page.frames().find(item => item.url().startsWith('http://127.0.0.1:23141/'));
    await page.waitForFunction(() => window.IB?.workMode?.nativeCandidate?.appliedTheme?.() !== null, null, { timeout: 20000 });
    let work = getFrame();
    assert.ok(work, 'official DSH Web UI frame must be mounted');
    const skipStartup = work.locator('#dsh-startup-root .dsu-skip').last();
    if (await skipStartup.isVisible().catch(() => false)) await skipStartup.click();
    await work.waitForFunction(() => !document.getElementById('dsh-startup-root'), null, { timeout: 15000 });
    const open = work.locator('.ib-work-run-session');
    await open.waitFor();
    const priorSessionId = await open.getAttribute('data-dsh-session-id');
    if (boot.scenario === 'queued-session') {
      const existingBinding = await page.evaluate(async input => {
        const link = await IB.homeNode.workRuns.getDshSession(input.sessionId);
        return { found: !!(link && link.ok === true && link.found === true),
          runId: link && link.binding && link.binding.runId || '' };
      }, { sessionId: priorSessionId, runId: boot.runId });
      if (existingBinding.found && existingBinding.runId !== boot.runId) {
        await cancelPendingPermission(work);
        await work.getByRole('button', { name: '新建会话', exact: true }).last().click();
        await work.waitForFunction(previous => {
          const node = document.querySelector('.ib-work-run-session');
          return !!node && !!node.getAttribute('data-dsh-session-id') && node.getAttribute('data-dsh-session-id') !== previous;
        }, priorSessionId, { timeout: 30000 });
        await work.locator('[data-work-run-phase="needs-binding"]').waitFor();
      }
    }
    const successSessionId = await open.getAttribute('data-dsh-session-id');
    assert.match(successSessionId, /^session-[A-Fa-f0-9-]{36}$/);
    evidence.sessionId = successSessionId;
    if (boot.scenario === 'completed-session') {
      const persisted = await page.evaluate(async sessionId => {
        const link = await IB.homeNode.workRuns.getDshSession(sessionId);
        if (!link || link.ok !== true || link.found !== true || link.run.status !== 'completed'
          || link.run.projectRef !== 'dsh_synthetic_workspace') throw new Error('completed DSH Session/Run mapping unavailable');
        return { runId: link.run.runId, sessionId: link.binding.sessionId, status: link.run.status, consentId: link.binding.consentId };
      }, successSessionId);
      evidence.persistedSessionBinding = persisted;
    }
    let resultView;
    let consent;
    if (boot.scenario === 'queued-session') {
      const initialPhase = await open.getAttribute('data-work-run-phase');
      if (initialPhase === 'needs-binding') {
        await work.getByRole('button', { name: '绑定到当前 Home Node Run' }).click();
        await work.locator('[data-work-run-phase="needs-consent"]').waitFor();
      } else assert.equal(initialPhase, 'needs-consent', 'a pre-existing binding may continue only when its Consent is inactive');
      const unconsentedBinding = await page.evaluate(async sessionId => {
        const link = await IB.homeNode.workRuns.getDshSession(sessionId);
        if (!link || link.ok !== true || link.found !== true) throw new Error('Home Node did not persist Session binding');
        if (link.binding.sessionId !== sessionId) throw new Error('Home Node Session identity mismatch');
        let priorConsentStatus = '';
        if (link.binding.consentId) {
          const prior = await IB.homeNode.workRuns.getConsent(link.run.runId, link.binding.consentId);
          priorConsentStatus = prior.consent && prior.consent.status || '';
          if (priorConsentStatus === 'active') throw new Error('test fixture unexpectedly has an active Consent');
        }
        return { sessionId: link.binding.sessionId, runId: link.run.runId, status: link.run.status,
          consentId: link.binding.consentId, priorConsentStatus };
      }, successSessionId);
      evidence.preConsentBinding = unconsentedBinding;
      assert.equal(unconsentedBinding.runId, boot.runId);
      assert.equal(unconsentedBinding.status, 'queued');

      consent = work.locator('.ib-work-run-consent');
      await consent.waitFor();
      const previewText = await consent.innerText();
      assert.ok(previewText.includes('dsh_synthetic_workspace'));
      assert.ok(previewText.includes('dsh_synthetic_readme') || previewText.includes('synthetic.js'));
      assert.ok(previewText.includes('ib-dsh-synthetic-agent'));
      assert.ok(previewText.includes('ib-dsh-synthetic-middle'));
      const memoryCheckbox = consent.locator('label').filter({ hasText: SYNTHETIC_MEMORY_SENTINEL }).locator('input[type="checkbox"]');
      await memoryCheckbox.check();
      await page.waitForFunction(memoryId => {
        const state = IB.workMode.ui && IB.workMode.ui.getState();
        return !!state && state.memorySelectedIds.includes(memoryId) && !!state.memorySnapshot;
      }, boot.memoryId, { timeout: 20000 });
      await consent.getByText('Memory Recall · 1 条', { exact: false }).waitFor();
      await work.waitForFunction(memoryId => {
        const label = Array.from(document.querySelectorAll('.ib-work-run-consent label'))
          .find(item => item.textContent.includes('Synthetic P2 project Recall'));
        const checkbox = label && label.querySelector('input[type="checkbox"]');
        return !!checkbox && checkbox.checked && document.querySelector('.ib-work-run-consent')
          .textContent.includes('Memory Recall · 1 条');
      }, boot.memoryId, { timeout: 20000 });
      evidence.visibleAuthorizationPreview = { agentModel: 'ib-dsh-synthetic-agent', reviewModel: 'ib-dsh-synthetic-middle', fileId: FIXTURE.fileId,
        projectRecallId: boot.memoryId, projectRecallSelectedInDshUi: true };
      await consent.getByLabel('我已核对项目、两个 Provider 和逐项文件，并授权本次外发。').check();
      await consent.getByLabel('我已阅读并接受 Home Node Result 的本地明文保存与删除残留风险。').check();
      await consent.getByLabel('我单独授权将所选项目 Agent Memory Recall 发送给当前 Agent Provider。').check();
      await consent.getByLabel('我单独授权将可能包含 Memory 衍生内容的证据和报告发送给当前 Middle Brain Review Provider。').check();
      await consent.getByLabel('我单独授权将完整 memory-derived Result 明文保存到 Home Node SQLite。').check();
      await work.waitForFunction(() => {
        const button = document.querySelector('.ib-work-run-consent button');
        return !!button && button.disabled === false;
      }, null, { timeout: 20000 });
      await consent.getByRole('button', { name: '授予此范围的 Consent' }).click();
      await work.locator('[data-work-run-phase="ready"]').waitFor();
      const ready = await page.evaluate(async sessionId => {
        const link = await IB.homeNode.workRuns.getDshSession(sessionId);
        const state = IB.workMode.ui.getState();
        if (link.ok !== true || link.found !== true || !link.binding.consentId || link.run.status !== 'queued') {
          throw new Error('Consent must be bound to the same queued Home Node Run');
        }
        if (!state.consent || state.consent.status !== 'active' || state.consentId !== link.binding.consentId) {
          throw new Error('Work Mode Consent state differs from Home Node binding');
        }
      const savedConsent = await IB.homeNode.workRuns.getConsent(link.run.runId, link.binding.consentId);
      if (!savedConsent || savedConsent.ok !== true || !savedConsent.consent.memoryScope
        || savedConsent.consent.memoryScope.refs.length !== 1
        || savedConsent.consent.memoryDerivedScope.review.confirmed !== true
        || savedConsent.consent.memoryDerivedScope.result.confirmed !== true) throw new Error('Agent, Review and Result Memory scopes were not persisted together');
      if (JSON.stringify(savedConsent.consent).includes('Synthetic P2 project Recall')) throw new Error('Home Node Consent must retain Memory hashes and references, not plaintext');
      return { runId: link.run.runId, version: link.run.version, consentId: link.binding.consentId,
        fileIds: state.consentFileIds.slice(), memoryContextHash: savedConsent.consent.memoryScope.contextHash,
        memoryRef: savedConsent.consent.memoryScope.refs[0].memoryId, memoryDerivedReview: savedConsent.consent.memoryDerivedScope.review.confirmed,
        memoryDerivedResult: savedConsent.consent.memoryDerivedScope.result.confirmed };
      }, successSessionId);
      evidence.authorized = ready;
      const fakeReset = await page.evaluate(async () => {
        const fake = window.__IB_TEST_FAKE_SERVICE__;
        return (await fetch(fake.origin + '/__control', { method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers), body: JSON.stringify({ reset: true }) })).json();
      });
      assert.equal(fakeReset.ok, true);
      await work.getByRole('button', { name: '执行已授权只读审计' }).click();
      await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 90000 });
    } else {
      await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 30000 });
    }
    resultView = await page.evaluate(async sessionId => {
      const binding = await IB.homeNode.workRuns.getDshSession(sessionId);
      const result = await IB.workMode.runtime.getResult(binding.run.runId);
      const events = await IB.homeNode.workRuns.events(binding.run.runId, { limit: 100 });
      const fakeService = window.__IB_TEST_FAKE_SERVICE__;
      const fake = await (await fetch(fakeService.origin + '/__status', { cache: 'no-store', headers: fakeService.headers })).json();
      if (binding.run.status !== 'completed' || result.ok !== true || !result.result || !result.result.report
        || !Array.isArray(result.result.report.findings)) {
        throw new Error('Home Node Result was not persisted');
      }
      if (result.result.memoryDerived !== true || !result.result.memoryContextHash
        || fake.memoryObserved !== true || fake.models['ib-dsh-synthetic-middle'] !== 2
        || fake.models['ib-dsh-synthetic-agent'] < 2) throw new Error('Plan, Agent Memory Recall, Review or derived Result was not observed');
      return { runId: binding.run.runId, status: binding.run.status, version: binding.run.version,
        resultSummary: result.result.report.summary, findingCount: result.result.report.findings.length,
        events: (events.executionEvents || []).map(event => event.event), fakeCalls: fake.calls,
        models: fake.models, memoryObservedByFakeProvider: fake.memoryObserved, memoryDerived: result.result.memoryDerived,
        memoryContextHash: result.result.memoryContextHash, sessionId: binding.binding.sessionId, consentId: binding.binding.consentId };
    }, successSessionId);
    evidence.completed = resultView;
    if (boot.runId) assert.equal(resultView.runId, boot.runId);
    assert.ok(resultView.fakeCalls >= 2, 'Fake Provider must perform the tool-request and result calls');
    assert.ok(resultView.events.includes('project-read'),
      'Home Node event ledger must include the authorized Workspace read');

    await page.evaluate(sessionId => {
      window.__dshP1SessionSignals = [];
      window.addEventListener('message', event => {
        if (event.origin === 'http://127.0.0.1:23141' && event.data?.type === 'ib-dsh-p1-session-open') {
          window.__dshP1SessionSignals.push(String(event.data.sessionId || ''));
        }
      });
      window.__dshP1ExpectedSession = sessionId;
    }, successSessionId);
    await page.locator('#wm-dsh-reload').click();
    await page.waitForFunction(sessionId => window.__dshP1SessionSignals?.includes(sessionId), successSessionId, { timeout: 30000 });
    work = getFrame();
    await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 30000 });
    assert.equal(await work.locator('.ib-work-run-session').getAttribute('data-dsh-session-id'), successSessionId);
    assert.ok((await work.locator('.ib-work-run-result').innerText()).includes('DSH Synthetic Work UI acceptance'));
    evidence.refreshRestoredSameSessionAndResult = true;

    const nextRun = await page.evaluate(async () => {
      const controller = IB.workMode.ui;
      const refreshed = await controller.refresh();
      if (!refreshed || refreshed.ok !== true || refreshed.activeRuns !== 0) throw new Error('completed fixture must leave no active Run');
      const files = await controller.setFileIds(['dsh_synthetic_readme']);
      if (!files || files.ok !== true) throw new Error('cancellation fixture file scope could not be selected');
      const created = await controller.createRun('dsh_synthetic_workspace');
      if (!created || created.ok !== true) throw new Error('second Synthetic cancellation Run could not be created');
      const executor = await controller.setExecutor('dsh');
      const profile = await controller.setProfileRef('dsh_synthetic_agent');
      const preview = await controller.previewAuthorization();
      if (!executor.ok || !profile.ok || !files.ok || !preview.ok) throw new Error('second Synthetic Run scope setup failed');
      return { runId: created.run.runId, status: created.run.status, version: created.run.version };
    });
    evidence.cancelRun = nextRun;
    const control = await page.evaluate(async () => {
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      return (await fetch(fake.origin + '/__control', { method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers),
        body: JSON.stringify({ reset: true, holdNext: true, holdNextModel: 'ib-dsh-synthetic-agent' }) })).json();
    });
    assert.equal(control.ok, true);
    evidence.cancelHold = control;
    await work.getByRole('button', { name: '新建会话', exact: true }).last().click();
    await work.waitForFunction(oldSessionId => {
      const node = document.querySelector('.ib-work-run-session');
      return node && node.getAttribute('data-dsh-session-id') !== oldSessionId;
    }, successSessionId, { timeout: 30000 });
    const cancelSessionId = await work.locator('.ib-work-run-session').getAttribute('data-dsh-session-id');
    assert.match(cancelSessionId, /^session-[A-Fa-f0-9-]{36}$/);
    evidence.cancelSessionId = cancelSessionId;
    await work.locator('[data-work-run-phase="needs-binding"]').waitFor();
    await work.getByRole('button', { name: '绑定到当前 Home Node Run' }).click();
    await work.locator('[data-work-run-phase="needs-consent"]').waitFor();
    consent = work.locator('.ib-work-run-consent');
    await consent.getByLabel('我已核对项目、两个 Provider 和逐项文件，并授权本次外发。').check();
    await consent.getByLabel('我已阅读并接受 Home Node Result 的本地明文保存与删除残留风险。').check();
    await consent.getByRole('button', { name: '授予此范围的 Consent' }).click();
    await work.locator('[data-work-run-phase="ready"]').waitFor();
    await work.getByRole('button', { name: '执行已授权只读审计' }).click();
    var cancelStart = null;
    var cancelDeadline = Date.now() + 30000;
    while (Date.now() < cancelDeadline) {
      cancelStart = await page.evaluate(async runId => {
        const current = await IB.homeNode.workRuns.get(runId);
        const host = await IB.homeNode.workRuns.dshStatus();
        const fakeService = window.__IB_TEST_FAKE_SERVICE__;
        const fake = await (await fetch(fakeService.origin + '/__status', { cache: 'no-store', headers: fakeService.headers })).json();
        return { runStatus: current && current.run && current.run.status,
          hostActive: !!(host && host.host && host.host.activeRunIds.includes(runId)),
          fakeCalls: fake.calls, fakeWaiting: fake.waiting, fakeHoldNext: fake.holdNext };
      }, nextRun.runId);
      if (cancelStart.runStatus === 'running' && cancelStart.hostActive && cancelStart.fakeWaiting >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    evidence.cancelStart = cancelStart;
    assert.ok(cancelStart && cancelStart.runStatus === 'running' && cancelStart.hostActive && cancelStart.fakeWaiting >= 1,
      'Run must reach its held Home Node ModelPort request before cancellation: ' + JSON.stringify(cancelStart));
    await work.locator('[data-work-run-phase="running"]').waitFor();
    await work.getByRole('button', { name: '取消 Home Node Run' }).click();
    await work.locator('[data-work-run-phase="cancelled"]').waitFor({ timeout: 30000 });
    const cancelled = await page.evaluate(async sessionId => {
      const link = await IB.homeNode.workRuns.getDshSession(sessionId);
      const result = await IB.workMode.runtime.getResult(link.run.runId);
      const fakeService = window.__IB_TEST_FAKE_SERVICE__;
      const fake = await (await fetch(fakeService.origin + '/__status', { cache: 'no-store', headers: fakeService.headers })).json();
      if (link.run.status !== 'cancelled' || result.ok === true) throw new Error('cancelled Run must have no persisted Result');
      return { runId: link.run.runId, status: link.run.status, version: link.run.version,
        sessionId: link.binding.sessionId, hasResult: result.ok === true, fakeWaiting: fake.waiting, fakeCancelled: fake.cancelled };
    }, cancelSessionId);
    evidence.cancelled = cancelled;
    assert.equal(cancelled.runId, nextRun.runId);
    assert.equal(cancelled.sessionId, cancelSessionId);
    assert.ok(cancelled.fakeCancelled >= 1, 'aborted Fake Provider request must observe cancellation');
    assert.equal(evidence.gatewayPrompts, 0, 'P1 composer must not send prompts to DSH Gateway');
    assert.deepEqual(evidence.errors, []);
    assert.deepEqual(evidence.resourceFailures, []);
    assert.deepEqual(evidence.externalRequests, []);
    await page.locator('#wm-use-native').click();
    assert.ok(await page.locator('.wm-workspace-grid').isVisible(), 'Native Work UI fallback must remain available');
    evidence.nativeFallback = true;
    evidence.pass = true;
  } finally {
    try { await page.evaluate(async () => {
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      await fetch(fake.origin + '/__control', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers), body: JSON.stringify({ holdNext: false }) });
    }); } catch (_) {}
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
