'use strict';

// End-to-end acceptance against the already running Synthetic Tauri WebView2.
// Uses only the isolated DSH Workspace and the local Fake Provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const devServiceContract = require('../runtime/dev-service-contract.js');
const { createSyntheticFakeProvider } = require('../runtime/dev-synthetic-seed.js');
const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(__dirname, '../../DeepSeek-Harness-Mock-PoC'));
const { chromium } = createRequire(path.join(source, 'apps/web/package.json'))('playwright');
const output = path.resolve(__dirname, '../.dsh-research/native-work-p1');
const FIXTURE = Object.freeze({ projectRef: 'dsh_synthetic_workspace', profileRef: 'dsh_synthetic_agent', fileId: 'dsh_synthetic_readme' });

async function openWorkDetails(work) {
  const sessionId = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
  const row = work.locator('[data-row-key="session:' + sessionId + '"]');
  if (await row.count()) {
    await row.hover();
    const trigger = row.getByRole('button').first();
    if (await trigger.count()) {
      await trigger.click();
      await work.getByRole('menuitem', { name: '工作记录', exact: true }).click();
      return;
    }
  }
  {
    await work.evaluate(id => window.dispatchEvent(new CustomEvent('ib-dsh-work-record-open', { detail: { sessionId: id } })), sessionId);
  }
}

async function bindCurrentDshSession(work, sessionId) {
  await work.evaluate(id => parent.postMessage({ type: 'ib-dsh-p1-bind', sessionId: id }, 'http://127.0.0.1:23130'), sessionId);
}

async function skipDshStartup(work) {
  for (let step = 0; step < 8; step++) {
    const splash = work.locator('#dsh-startup-root');
    if (!(await splash.count()) || await work.locator('#dsh-startup-permission').isVisible().catch(() => false)) return;
    const skip = splash.locator('.dsu-skip').last();
    if (await skip.isVisible().catch(() => false)) await work.evaluate(() => {
      const api = window.__DSH_STARTUP_API__;
      if (api && typeof api.skip === 'function') api.skip();
      else document.querySelector('#dsh-startup-root .dsu-skip')?.click();
    });
    else {
      const next = work.getByRole('button', { name: /继续启动|进入工作台|continue startup|open workbench/i }).first();
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click();
    }
    await work.waitForTimeout(350);
  }
  await work.waitForFunction(() => !document.getElementById('dsh-startup-root'), null, { timeout: 15000 });
}

async function cancelPendingPermission(work) {
  const dialog = work.locator('#dsh-startup-permission');
  if (!(await dialog.isVisible().catch(() => false))) return;
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  if (await cancel.isVisible().catch(() => false)) await cancel.click();
  const back = dialog.getByRole('button', { name: '返回任务界面', exact: true });
  if (await back.isVisible().catch(() => false)) await back.click();
  await dialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
  let ownedFakeProvider = null;
  const evidence = { host: 'Synthetic Tauri WebView2', revision: 'd743267388641bc76f17c45ce8b4c231aed1d32c',
    errors: [], resourceFailures: [], traceRequests: [], externalRequests: [], gatewayPrompts: 0 };
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
      if (response.url().includes('/api/ib/work-mode/trace')) {
        let item = evidence.traceRequests.findLast(entry => entry.status === undefined);
        if (!item) { item = {}; evidence.traceRequests.push(item); }
        item.status = response.status();
        void response.json().then(body => {
          item.reply = { ok: body && body.ok === true, imported: Number(body && body.imported || 0), terminal: body && body.terminal === true };
        }).catch(() => {});
      }
      if (response.url().startsWith('http://127.0.0.1:23141/') && response.status() >= 400) {
        evidence.resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
      }
    });
    page.on('request', request => {
      try {
        const url = new URL(request.url());
        if (url.pathname === '/api/ib/work-mode/trace') {
          const body = JSON.parse(request.postData() || '{}');
          evidence.traceRequests.push({ phase: String(body.phase || ''), runId: String(body.runId || ''),
            eventCount: Array.isArray(body.events) ? body.events.length : 0,
            eventTypes: Array.isArray(body.events) ? body.events.map(item => item.dshEvent && item.dshEvent.type).filter(Boolean) : [] });
        }
        if (!['127.0.0.1', 'localhost', 'ipc.localhost'].includes(url.hostname)) evidence.externalRequests.push(url.origin);
      } catch (_) { /* Ignore browser-internal URLs. */ }
    });
    await page.goto('http://127.0.0.1:23130/InternalBeyond.html?dsh-native-work-p1=' + Date.now() + '#work-mode', {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(() => window.__IB_DEV_SYNTHETIC__ === true
      && typeof IB?.homeNode?.workRuns?.getDshSession === 'function', null, { timeout: 30000 });
    const dev = await page.evaluate(() => window.__IB_DEV_SERVICE_CONFIG__);
    const fakeUrl = new URL(dev.fakeProviderUrl);
    if (dev.mode !== 'synthetic' || fakeUrl.protocol !== 'http:' || fakeUrl.hostname !== '127.0.0.1'
      || fakeUrl.port !== '23139' || !process.env.LOCALAPPDATA) throw new Error('Synthetic Fake Provider route required');
    const sandboxRoot = path.join(process.env.LOCALAPPDATA, 'InternalBeyond', 'dev-synthetic', 'dev-sandbox');
    const fakeEnvironment = {
      IB_DEV_MODE: '1', IB_DEV_SYNTHETIC: '1', IB_DEV_SANDBOX_ROOT: sandboxRoot,
      IB_DEV_INSTANCE_ID: dev.instanceId, IB_DEV_SESSION_TOKEN: dev.sessionToken,
      IB_WEB_PORT: new URL(dev.webOrigin).port, IB_BRIDGE_PORT: '23135', IB_ACTIVE_PORT: '23134',
      IB_RESTART_PORT: '23136', IB_HOME_NODE_PORT: new URL(dev.homeNodeUrl).port, IB_DEV_FAKE_PROVIDER_PORT: fakeUrl.port,
      IB_ECONOMY_CHANNEL_SOURCE_PORT: '23137', IB_DSH_CONTROL_PORT: '23140', IB_DSH_WEB_PORT: '23141',
      IB_HOME_NODE_DATA_DIR: path.join(sandboxRoot, 'home-node'), IB_BRIDGE_DATA_DIR: path.join(sandboxRoot, 'bridge'),
      IB_ACTIVE_DATA_DIR: path.join(sandboxRoot, 'active'), IB_CREDENTIAL_DATA_DIR: path.join(sandboxRoot, 'credential-vault'),
      IB_CREDENTIAL_BINDINGS_DIR: path.join(sandboxRoot, 'credential-vault')
    };
    const fakeIdentity = devServiceContract.identityFromEnvironment(fakeEnvironment);
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
    if (!fakeRunning) ownedFakeProvider = await createSyntheticFakeProvider({ port: Number(fakeUrl.port), identity: fakeIdentity, environment: fakeEnvironment });
    await page.evaluate(() => {
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      window.__IB_TEST_FAKE_SERVICE__ = {
        origin: new URL(dev.fakeProviderUrl).origin,
        headers: { 'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId }
      };
    });
    const boot = await page.evaluate(async () => {
      if (window.__IB_DEV_MODE__ !== true || window.__IB_DEV_SYNTHETIC__ !== true || !window.__TAURI__) {
        throw new Error('real Synthetic Tauri WebView2 required');
      }
      const dev = window.__IB_DEV_SERVICE_CONFIG__;
      const host = await (await fetch(dev.dshControlUrl + '/status', { cache: 'no-store', headers: {
        'X-IB-Dev-Session': dev.sessionToken, 'X-IB-Dev-Instance': dev.instanceId
      } })).json();
      if (host.ok !== true || host.synthetic !== true || host.phase !== 'ready'
        || host.environment !== 'synthetic' || host.devInstanceId !== dev.instanceId
        || host.revision !== 'd743267388641bc76f17c45ce8b4c231aed1d32c') throw new Error('pinned synthetic DSH host required');
      const runs = await IB.homeNode.workRuns.listActive({ limit: 20 });
      if (runs.ok !== true || runs.hasMore || runs.runs.length > 1) throw new Error('at most one Synthetic fixture Run required');
      const controller = IB.workMode.ui;
      if (!controller) throw new Error('Work Mode authority unavailable');
      const workspace = IB.workspace && IB.workspace.files;
      if (!IB.createWorkRunRemote || !workspace || typeof workspace.wsGetWorkModeProjectSnapshot !== 'function'
        || typeof workspace.wsReadWorkModeFile !== 'function') throw new Error('Home Node Workspace bridge prerequisites unavailable');
      if (runs.runs.length === 0) {
        const refreshed = await controller.refresh();
        if (!refreshed || refreshed.ok !== true || refreshed.activeRuns !== 0) throw new Error('Synthetic Run ledger did not refresh');
        const project = await controller.setSelectedProject('dsh_synthetic_workspace');
        if (!project || project.ok !== true) throw new Error('Synthetic Workspace selection failed');
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
        return { scenario: 'queued-session', runId: created.run.runId, status: created.run.status, version: created.run.version };
      }
      const run = runs.runs[0];
      if (run.status !== 'queued' || run.projectRef !== 'dsh_synthetic_workspace' || run.workflowId !== 'project.audit.readonly') {
        throw new Error('Synthetic fixture Run must remain queued and isolated');
      }
      const selected = await controller.selectRun(run.runId);
      if (!selected || selected.ok !== true) throw new Error('Synthetic Run selection failed');
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
      return { scenario: 'queued-session', runId: run.runId, status: run.status, version: run.version,
        fileIds: state.fileIds.slice(), providers: preview.providers.map(item => ({ destination: item.destination, provider: item.provider, model: item.model, endpointLabel: item.endpointLabel })) };
    });
    evidence.initialRun = boot;

    await page.evaluate(() => { location.hash = '#work-mode'; });
    await page.locator('#wm-use-dsh').click();
    await page.locator('#wm-dsh-reload').click();
    const getFrame = () => page.frames().find(item => item.url().startsWith('http://127.0.0.1:23141/'));
    await page.waitForFunction(() => window.IB?.workMode?.nativeCandidate?.appliedTheme?.() !== null, null, { timeout: 20000 });
    let work = getFrame();
    assert.ok(work, 'official DSH Web UI frame must be mounted');
    await skipDshStartup(work);
    const priorSessionId = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
    let successSessionId = priorSessionId;
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
      const priorBinding = await page.evaluate(async sessionId => {
        const link = await IB.homeNode.workRuns.getDshSession(sessionId);
        return link && link.ok === true && link.found === true && link.binding && link.run
          ? { found: true, runId: link.run.runId, status: link.run.status } : { found: false };
      }, successSessionId);
      if (priorBinding.found && priorBinding.runId !== boot.runId) {
        assert.ok(['completed', 'failed', 'cancelled'].includes(priorBinding.status),
          'an active DSH Session/Run binding must be resolved before selecting another Session');
        await cancelPendingPermission(work);
        await skipDshStartup(work);
        await work.getByRole('button', { name: '新建会话', exact: true }).last().click();
        await work.waitForFunction(previous => {
          const node = document.querySelector('[data-conversation-session]');
          return !!node && node.getAttribute('data-conversation-session') !== previous;
        }, successSessionId, { timeout: 30000 });
        successSessionId = await work.locator('[data-conversation-session]').last().getAttribute('data-conversation-session');
        evidence.sessionId = successSessionId;
      }
      await bindCurrentDshSession(work, successSessionId);
      await work.locator('.ib-work-run-session[data-work-run-phase="needs-consent"]').waitFor({ timeout: 30000 });
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

      consent = work.locator('#dsh-startup-permission');
      await consent.waitFor();
      await consent.locator('details summary').click();
      const previewText = await consent.innerText();
      assert.ok(previewText.includes('dsh_synthetic_workspace'));
      assert.ok(previewText.includes('dsh_synthetic_readme') || previewText.includes('synthetic.js'));
      assert.ok(previewText.includes('ib-dsh-synthetic-agent'));
      assert.ok(previewText.includes('ib-dsh-synthetic-middle'));
      evidence.visibleAuthorizationPreview = { agentModel: 'ib-dsh-synthetic-agent', reviewModel: 'ib-dsh-synthetic-middle', fileId: FIXTURE.fileId };
      const fakeReset = await page.evaluate(async () => {
        const fake = window.__IB_TEST_FAKE_SERVICE__;
        return (await fetch(fake.origin + '/__control', { method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers), body: JSON.stringify({ reset: true }) })).json();
      });
      assert.equal(fakeReset.ok, true);
      await consent.locator('input[type="checkbox"]').nth(0).check();
      await consent.locator('input[type="checkbox"]').nth(1).check();
      await consent.getByRole('button', { name: '确认并请求 Host 核验' }).click();
      await skipDshStartup(work);
      await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 90000 });
      const authorized = await page.evaluate(async sessionId => {
        const link = await IB.homeNode.workRuns.getDshSession(sessionId);
        const consent = await IB.homeNode.workRuns.getConsent(link.run.runId, link.binding.consentId);
        if (link.ok !== true || link.found !== true || !link.binding.consentId || link.run.status !== 'completed'
          || !consent || consent.ok !== true || !consent.consent) throw new Error('Home Node did not retain the confirmed Consent binding');
        return { runId: link.run.runId, status: link.run.status, version: link.run.version,
          consentId: link.binding.consentId, consentStatus: consent.consent.status, fileIds: consent.consent.fileIds.slice() };
      }, successSessionId);
      evidence.authorized = authorized;
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
      return { runId: binding.run.runId, status: binding.run.status, version: binding.run.version,
        resultSummary: result.result.report.summary, findingCount: result.result.report.findings.length,
        events: (events.executionEvents || []).map(event => event.event), fakeCalls: fake.calls,
        sessionId: binding.binding.sessionId, consentId: binding.binding.consentId };
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
    await skipDshStartup(work);
    await work.locator('[data-work-run-phase="completed"]').waitFor({ timeout: 30000 });
    await openWorkDetails(work);
    assert.equal(await work.locator('.ib-work-run-session').getAttribute('data-dsh-session-id'), successSessionId);
    assert.ok((await work.locator('.ib-work-run-result').innerText()).includes('DSH Synthetic Work UI acceptance'));
    evidence.refreshRestoredSameSessionAndResult = true;

    await work.getByText('轨迹', { exact: true }).click();
    await work.getByText('project.read_file', { exact: false }).first().waitFor({ timeout: 20000 });
    const restoredTraceText = await work.locator('body').innerText();
    assert.ok(restoredTraceText.includes('DSH Synthetic Work UI acceptance'),
      'the native DSH Trajectory must project the Home Node Result summary after refresh');
    evidence.nativeTrajectoryRestored = { hasToolCall: restoredTraceText.includes('project.read_file'),
      hasResult: restoredTraceText.includes('DSH Synthetic Work UI acceptance') };
    await work.getByText('对话', { exact: true }).click();

    const nextRun = await page.evaluate(async sessionId => {
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
      const binding = await IB.homeNode.workRuns.bindDshSession(created.run.runId, {
        sessionId, consentId: '', expectedVersion: created.run.version
      });
      if (!binding || binding.ok !== true) throw new Error('second Run did not bind to the same DSH Session');
      const local = controller.bindDshSession(sessionId);
      if (!local || local.ok !== true) throw new Error('local DSH Session binding failed');
      return { runId: created.run.runId, status: created.run.status, version: created.run.version,
        sessionId: binding.binding.sessionId };
    }, successSessionId);
    evidence.cancelRun = nextRun;
    assert.equal(nextRun.sessionId, successSessionId);
    const control = await page.evaluate(async () => {
      const fake = window.__IB_TEST_FAKE_SERVICE__;
      return (await fetch(fake.origin + '/__control', { method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, fake.headers), body: JSON.stringify({ reset: true, holdNext: true }) })).json();
    });
    assert.equal(control.ok, true);
    evidence.cancelHold = control;
    const cancelSessionId = await work.locator('.ib-work-run-session').getAttribute('data-dsh-session-id');
    assert.match(cancelSessionId, /^session-[A-Fa-f0-9-]{36}$/);
    assert.equal(cancelSessionId, successSessionId, 'the follow-up Run must remain in the same DSH Session');
    evidence.cancelSessionId = cancelSessionId;
    await page.waitForTimeout(1100);
    await work.evaluate(sessionId => parent.postMessage({ type: 'ib-dsh-p1-session-status', sessionId,
      timestamp: Date.now() }, 'http://127.0.0.1:23130'), cancelSessionId);
    await work.locator('[data-work-run-phase="needs-consent"]').waitFor();
    consent = work.locator('#dsh-startup-permission');
    await consent.waitFor();
    await consent.locator('input[type="checkbox"]').nth(0).check();
    await consent.locator('input[type="checkbox"]').nth(1).check();
    await consent.getByRole('button', { name: '确认并请求 Host 核验' }).click();
    var cancelStart = null;
    var cancelDeadline = Date.now() + 30000;
    while (Date.now() < cancelDeadline) {
      cancelStart = await page.evaluate(async runId => {
        const current = await IB.homeNode.workRuns.get(runId);
        const host = await IB.homeNode.workRuns.dshStatus();
        const fakeService = window.__IB_TEST_FAKE_SERVICE__;
        const fake = await (await fetch(fakeService.origin + '/__status', { cache: 'no-store', headers: fakeService.headers })).json();
        return { runStatus: current && current.run && current.run.status,
          hostActive: !!(host && host.host && (host.host.activeRunIds || []).includes(runId)),
          hostActiveCount: Number(host && host.host && host.host.activeRuns || 0),
          fakeCalls: fake.calls, fakeWaiting: fake.waiting, fakeHoldNext: fake.holdNext };
      }, nextRun.runId);
      if (cancelStart.runStatus === 'running' && cancelStart.fakeWaiting >= 1) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    evidence.cancelStart = cancelStart;
    assert.ok(cancelStart && cancelStart.runStatus === 'running' && cancelStart.fakeWaiting >= 1,
      'Run must reach its held Fake Provider request through Home Node before cancellation: ' + JSON.stringify(cancelStart));
    await work.locator('[data-work-run-phase="running"]').waitFor();
    await work.getByText('轨迹', { exact: true }).click();
    const liveTimeline = work.getByLabel('轨迹时间线');
    await liveTimeline.waitFor();
    await page.waitForTimeout(1000);
    await work.getByText('Home Node Run running', { exact: false }).last().waitFor({ timeout: 15000 });
    const liveTrace = await work.locator('body').innerText();
    assert.ok(liveTrace.includes('Home Node Run running'), 'the native DSH Trace receives Home Node Run state while the Run is still running');
    assert.ok(liveTrace.includes('ib-dsh-synthetic-agent'), 'the live Home Node Trace includes the authorized model route');
    evidence.nativeLiveTrajectory = { runStatus: 'running', modelVisible: true, homeNodeStatusVisible: true };
    await work.getByText('对话', { exact: true }).click();
    await work.locator('[data-work-run-cancel="true"]').click();
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
    const sameSessionRuns = await page.evaluate(async sessionId => {
      const link = await IB.homeNode.workRuns.getDshSession(sessionId);
      if (!link || link.ok !== true || link.found !== true || !Array.isArray(link.runs)) throw new Error('same-Session Run history is unavailable');
      return link.runs.map(item => ({ runId: item.run.runId, status: item.run.status, sessionId: item.binding.sessionId }));
    }, successSessionId);
    assert.ok(sameSessionRuns.some(item => item.runId === resultView.runId && item.status === 'completed'));
    assert.ok(sameSessionRuns.some(item => item.runId === nextRun.runId && item.status === 'cancelled'));
    assert.ok(sameSessionRuns.every(item => item.sessionId === successSessionId));
    evidence.continuousSessionRuns = sameSessionRuns;
    await work.getByText('轨迹', { exact: true }).click();
    await work.getByText('Home Node Run cancelled', { exact: false }).waitFor({ timeout: 20000 });
    await page.locator('#wm-dsh-reload').click();
    await page.waitForTimeout(1800);
    work = getFrame();
    await skipDshStartup(work);
    await work.locator('[data-work-run-phase="cancelled"]').waitFor({ timeout: 30000 });
    await work.getByText('轨迹', { exact: true }).click();
    await work.getByText('Home Node Run cancelled', { exact: false }).waitFor({ timeout: 20000 });
    evidence.nativeTrajectoryCancelAndRefresh = true;
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
    if (ownedFakeProvider) await ownedFakeProvider.close();
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
