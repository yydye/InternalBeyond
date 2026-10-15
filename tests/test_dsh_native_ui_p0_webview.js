'use strict';

// Historical P0 direct-Fake dialogue acceptance. P1 intentionally disables
// this path; use test_dsh_native_work_ui_p1_webview.js for current acceptance.

// Explicit acceptance against the already running Synthetic Tauri WebView2.
// It does not start/stop/reload the parent or operate Native Work Run controls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(__dirname, '../../DeepSeek-Harness-Mock-PoC'));
const { chromium } = createRequire(path.join(source, 'apps/web/package.json'))('playwright');
const output = path.resolve(__dirname, '../.dsh-research/native-work-p0');
const marker = 'P0_WEBVIEW_ACCEPTANCE_' + Date.now();

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9225');
  const evidence = { host: 'Tauri WebView2', marker, errors: [], resourceFailures: [], externalRequests: [], websocket: { opened: 0, sent: 0, received: 0 } };
  try {
    const page = browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1:23130/InternalBeyond.html'));
    assert.ok(page, 'Synthetic Tauri page must already exist');
    page.setDefaultTimeout(12000);
    const before = await page.evaluate(async () => {
      if (window.__IB_DEV_MODE__ !== true || window.__IB_DEV_SYNTHETIC__ !== true || !window.__TAURI__) throw new Error('real Synthetic Tauri required');
      const active = await IB.homeNode.workRuns.listActive({ limit: 100 });
      if (!active.ok || active.hasMore) throw new Error('active Run inventory unavailable');
      return { ua: navigator.userAgent, runs: active.runs.map(item => ({ runId: item.runId, status: item.status, version: item.version })) };
    });
    evidence.userAgent = before.ua;
    evidence.nativeRunsBefore = before.runs;
    page.on('pageerror', error => evidence.errors.push(error.message));
    page.on('websocket', socket => {
      if (!socket.url().startsWith('ws://127.0.0.1:23141/')) return;
      assert.ok(socket.url().includes('/api/remote.mux'));
      evidence.websocket.opened++;
      socket.on('framesent', () => evidence.websocket.sent++);
      socket.on('framereceived', () => evidence.websocket.received++);
    });
    page.on('response', response => {
      if (response.url().startsWith('http://127.0.0.1:23141/') && response.status() >= 400) {
        evidence.resourceFailures.push({ path: new URL(response.url()).pathname, status: response.status() });
      }
    });
    page.on('request', request => {
      try {
        if (request.frame().url().startsWith('http://127.0.0.1:23141/') && !/^https?:\/\/127\.0\.0\.1[:/]/.test(request.url())) {
          evidence.externalRequests.push(new URL(request.url()).origin);
        }
      } catch (_) { /* Worker requests have no frame. */ }
    });
    await page.evaluate(async () => {
      // Hot-mount only this candidate. The existing Native Work controller and
      // its queued/running state remain mounted throughout the acceptance.
      if (IB.workMode.nativeCandidate?.dispose) IB.workMode.nativeCandidate.dispose();
      else {
        document.querySelector('.wm-native-switch')?.remove();
        document.getElementById('wm-native-candidate')?.remove();
        const main = document.querySelector('#page-work-mode .wm-page');
        main.hidden = false; main.classList.remove('wm-native-mounted');
      }
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = 'assets/css/work-mode-native-ui.css?acceptance=' + Date.now();
      document.head.append(link);
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'assets/js/work-mode-native-ui.js?acceptance=' + Date.now();
        script.onload = resolve; script.onerror = reject; document.body.append(script);
      });
    });
    await page.locator('#wm-use-dsh').click();
    const frame = () => page.frames().find(item => item.url().startsWith('http://127.0.0.1:23141/'));
    await page.waitForFunction(() => IB.workMode.nativeCandidate.appliedTheme() !== null);
    await page.waitForFunction(() => typeof themeTransitioning === 'undefined' || themeTransitioning === false);
    if (await page.evaluate(() => document.body.classList.contains('theme-infernal'))) {
      await page.locator('#theme-toggle').click();
      await page.waitForFunction(() => IB.workMode.nativeCandidate.appliedTheme() === 'light');
      await page.waitForFunction(() => typeof themeTransitioning === 'undefined' || themeTransitioning === false);
    }
    let work = frame();
    assert.ok(work);
    const continueButton = work.getByRole('button', { name: '继续', exact: true });
    if (await continueButton.isVisible()) await continueButton.click();
    await work.getByRole('button', { name: '新建会话', exact: true }).last().click();
    await work.locator('[data-composer-input][contenteditable="true"]').fill(marker + ' Call the synthetic echo tool and report the result.');
    await work.getByRole('button', { name: '发送消息', exact: true }).click();
    await work.getByText('P0_DIALOGUE_OK', { exact: false }).first().waitFor({ timeout: 20000 });
    evidence.conversation = true;
    await work.getByText('轨迹', { exact: true }).click();
    await work.getByText('synthetic_echo', { exact: false }).first().waitFor();
    evidence.toolTrajectory = (await work.locator('body').innerText()).includes('P0_TOOL_OK');
    assert.ok(evidence.toolTrajectory, 'official trajectory must contain the actual tool result');
    await work.getByText('对话', { exact: true }).click();
    await page.screenshot({ path: path.join(output, 'webview-light.png') });

    await page.locator('#theme-toggle').click();
    await page.waitForFunction(() => IB.workMode.nativeCandidate.appliedTheme() === 'dark');
    assert.ok(await work.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme')));
    evidence.darkTheme = true;
    await page.waitForFunction(() => typeof themeTransitioning === 'undefined' || themeTransitioning === false);
    await page.screenshot({ path: path.join(output, 'webview-dark.png') });
    await page.locator('#theme-toggle').click();
    await page.waitForFunction(() => IB.workMode.nativeCandidate.appliedTheme() === 'light');
    assert.equal(await work.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme')), false);
    evidence.lightTheme = true;

    await page.locator('#wm-dsh-reload').click();
    await page.waitForTimeout(2500);
    work = frame();
    const sessionName = marker.slice(0, 30);
    if (!(await work.getByText('P0_DIALOGUE_OK', { exact: false }).first().isVisible())) {
      await work.getByText(sessionName, { exact: false }).first().click();
    }
    await work.getByText('P0_DIALOGUE_OK', { exact: false }).first().waitFor();
    evidence.iframeRefreshAndHistory = true;
    assert.ok(evidence.websocket.opened >= 2 && evidence.websocket.sent > 0 && evidence.websocket.received > 0);

    // Denial uses the official Gateway and synthetic sentinel paths only.
    evidence.outsideWorkspaceDenied = await work.evaluate(async () => {
      const body = { type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/create', payload: { args: { request: { cwd: 'Z:\\IB-P0-DENIED-NONEXISTENT' } } } };
      const result = await (await fetch('/api/session/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      return result.result?.ok === false;
    });
    assert.ok(evidence.outsideWorkspaceDenied);
    await page.locator('#wm-use-native').click();
    assert.ok(await page.locator('.wm-workspace-grid').isVisible());
    assert.equal(await page.locator('#wm-dsh-frame').isVisible(), false);
    evidence.nativeFallback = true;
    await page.locator('#wm-use-dsh').click();
    evidence.nativeRunsAfter = await page.evaluate(async () => {
      const active = await IB.homeNode.workRuns.listActive({ limit: 100 });
      return active.runs.map(item => ({ runId: item.runId, status: item.status, version: item.version }));
    });
    assert.deepEqual(evidence.nativeRunsAfter, evidence.nativeRunsBefore);
    assert.deepEqual(evidence.errors, []);
    assert.deepEqual(evidence.resourceFailures, []);
    assert.deepEqual(evidence.externalRequests, []);
    evidence.pass = true;
    evidence.metrics = await (await fetch('http://127.0.0.1:23140/status')).json();
  } finally {
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(evidence, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
