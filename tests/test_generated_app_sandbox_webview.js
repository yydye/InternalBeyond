'use strict';

/* Focused App Store sandbox acceptance against an already-running Synthetic
 * Tauri WebView2. This never opens production data or calls a real provider. */
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const source = path.resolve(process.env.IB_DSH_SOURCE_ROOT || path.join(__dirname, '../../DeepSeek-Harness-Mock-PoC'));
const { chromium } = createRequire(path.join(source, 'apps/web/package.json'))('playwright');
const CDP_URL = process.env.IB_WEBVIEW_CDP_URL || 'http://127.0.0.1:9225';

function makeDraft(name, appJs) {
  return {
    draftRef: 'ad_' + crypto.randomUUID(), projectRef: 'dsh_synthetic_workspace', name: name, version: 1,
    files: {
      'index.html': '<!doctype html><html><head><title>Sandbox probe</title></head><body>'
        + '<label for="item">Item</label><input id="item" aria-label="Item">'
        + '<button id="add" type="button">Add</button><ul id="items"></ul></body></html>',
      'styles.css': 'body{font:16px sans-serif}button{margin-left:8px}',
      'app.js': appJs
    }
  };
}

async function waitForPreviewGone(page, url) {
  await page.waitForFunction(async target => {
    try { return (await fetch(target, { cache: 'no-store' })).status === 404; } catch (_) { return false; }
  }, url, { timeout: 10000 });
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  let page = null, normalAppId = '', errorAppId = '', normalStorageKey = '', errorStorageKey = '';
  let normalPreviewUrl = '', errorPreviewUrl = '';
  try {
    page = browser.contexts()[0].pages().find(item => item.url().startsWith('http://127.0.0.1:23130/InternalBeyond.html'));
    assert.ok(page, 'a running Synthetic WebView2 page must be available at the Dev Web port');
    await page.waitForFunction(() => !!window.IB?.apps && !!window.IBAppBuilderCore, null, { timeout: 20000 });
    const host = await page.evaluate(async () => {
      let mainInvokeResolved = false;
      try { await window.__TAURI__.core.invoke('tauri_runtime_status'); mainInvokeResolved = true; } catch (_) {}
      return {
        synthetic: window.__IB_DEV_SYNTHETIC__ === true,
        mainInvoke: typeof window.__TAURI__?.core?.invoke,
        mainInvokeResolved: mainInvokeResolved,
        serviceConfig: !!(window.__IB_DEV_SERVICE_CONFIG__ && window.__IB_DEV_SERVICE_CONFIG__.sessionToken
          && window.__IB_DEV_SERVICE_CONFIG__.instanceId)
      };
    });
    assert.equal(host.synthetic, true, 'the test must use the isolated Synthetic host');
    assert.equal(host.mainInvoke, 'function', 'the trusted main WebView keeps its IPC bridge');
    assert.equal(host.mainInvokeResolved, true, 'the trusted main WebView can call a harmless host command');
    assert.equal(host.serviceConfig, true, 'the synthetic Web service identity is present');
    await page.evaluate(() => { const old = document.getElementById('ib-work-mode-csp-probe-host'); if (old) old.remove(); });

    const normalDraft = makeDraft('Synthetic app sandbox probe',
      'var items=[];function render(){var list=document.getElementById("items");list.textContent="";items.forEach(function(value){var row=document.createElement("li");row.textContent=value;list.appendChild(row)})}' +
      'window.AppStorage.get("items").then(function(result){items=result&&result.ok&&Array.isArray(result.value)?result.value:[];render()});' +
      'document.getElementById("add").addEventListener("click",function(){var input=document.getElementById("item");if(!input.value)return;items.push(input.value);window.AppStorage.set("items",items).then(function(){render();input.value=""})});');
    const installed = await page.evaluate(draft => IB.apps.installGeneratedApp(draft, { confirmed: true }), normalDraft);
    assert.equal(installed.ok, true);
    normalAppId = installed.appId;
    normalStorageKey = 'ib_app_' + normalAppId + '_items';
    await page.evaluate(appId => IB.apps.open(appId), normalAppId);

    const iframe = page.locator('#ib-app-overlay iframe.ib-generated-app-frame');
    await iframe.waitFor();
    normalPreviewUrl = await iframe.getAttribute('src');
    assert.match(normalPreviewUrl, /\/__ib-generated-app\/[0-9a-f-]{36}$/i);
    assert.equal(await iframe.getAttribute('srcdoc'), null);
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await iframe.getAttribute('referrerpolicy'), 'no-referrer');

    let app = page.frameLocator('#ib-app-overlay iframe.ib-generated-app-frame');
    await app.getByLabel('Item').waitFor();
    let frame = page.frames().find(item => item.url().includes('/__ib-generated-app/'));
    assert.ok(frame, 'the generated app is a separate served document');
    const boundary = await frame.evaluate(async () => {
      let parentDom = 'blocked';
      try { void parent.document.documentElement; parentDom = 'readable'; } catch (_) {}
      const internals = window.__TAURI_INTERNALS__;
      const internalsDescriptor = Object.getOwnPropertyDescriptor(window, '__TAURI_INTERNALS__');
      const invokeDescriptor = internals && Object.getOwnPropertyDescriptor(internals, 'invoke');
      async function tryInvoke(command, args) {
        if (!internals || typeof internals.invoke !== 'function') return { state: 'not-exposed', ok: false };
        try {
          const outcome = await Promise.race([
            internals.invoke(command, args).then(
              value => ({ resolved: true, value: value }), () => ({ rejected: true })
            ),
            new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 2500))
          ]);
          if (outcome.timeout) return { state: 'timeout', ok: false };
          if (outcome.rejected) return { state: 'rejected', ok: false };
          return { state: 'resolved', ok: !!(outcome.value && outcome.value.ok === true) };
        } catch (_) { return { state: 'rejected', ok: false }; }
      }
      const probes = await Promise.all([
        tryInvoke('tauri_runtime_status'),
        tryInvoke('credential_resolve', { request: { bindingId: 'middle_brain' } })
      ]);
      let connectBlocked = false;
      const onPolicyViolation = event => {
        if (String(event.violatedDirective || '').indexOf('connect-src') >= 0) connectBlocked = true;
      };
      window.addEventListener('securitypolicyviolation', onPolicyViolation);
      try { await fetch('http://127.0.0.1:23130/health', { cache: 'no-store' }); } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 50));
      window.removeEventListener('securitypolicyviolation', onPolicyViolation);
      return {
        origin: self.origin,
        parentDom: parentDom,
        tauri: typeof window.__TAURI__,
        internals: typeof window.__TAURI_INTERNALS__,
        internalInvoke: typeof window.__TAURI_INTERNALS__?.invoke,
        internalsConfigurable: !!internalsDescriptor && internalsDescriptor.configurable,
        invokeConfigurable: !!invokeDescriptor && invokeDescriptor.configurable,
        invokeWritable: !!invokeDescriptor && invokeDescriptor.writable,
        ipcGlobal: typeof window.ipc,
        invokeKey: typeof window.__TAURI_INVOKE_KEY__,
        ipcOutcome: probes[0].state,
        credentialOutcome: probes[1].state,
        credentialSucceeded: probes[1].ok,
        connectBlocked: connectBlocked,
        storage: typeof window.AppStorage
      };
    });
    assert.equal(boundary.origin, 'null', 'the application has an opaque origin');
    assert.equal(boundary.parentDom, 'blocked', 'the application cannot inspect host DOM');
    assert.equal(boundary.tauri, 'undefined', 'the public Tauri API is removed from the child');
    assert.equal(boundary.invokeKey, 'undefined', 'the child has no Tauri IPC invocation key');
    assert.ok(['undefined', 'object'].includes(boundary.internals));
    assert.ok(['undefined', 'function'].includes(boundary.internalInvoke));
    assert.notEqual(boundary.credentialOutcome, 'resolved');
    assert.equal(boundary.credentialSucceeded, false, 'the sandbox cannot resolve a credential binding');
    assert.notEqual(boundary.ipcOutcome, 'resolved');
    assert.equal(boundary.connectBlocked, true, 'the generated document CSP blocks direct local service requests');
    assert.equal(boundary.storage, 'object', 'only the explicit AppStorage bridge is exposed');
    console.log('PASS  WebView2 sandbox IPC probe ' + boundary.ipcOutcome + ', credential=' + boundary.credentialOutcome
      + ' (internal=' + boundary.internals + '/' + boundary.internalsConfigurable
      + ', invokeWritable=' + boundary.invokeWritable + ', invokeKey=' + boundary.invokeKey + ')');

    await app.getByLabel('Item').fill('stored synthetic item');
    await app.getByRole('button', { name: 'Add' }).click();
    await app.getByRole('listitem').filter({ hasText: 'stored synthetic item' }).waitFor();
    assert.equal(await page.evaluate(key => localStorage.getItem(key) !== null, normalStorageKey), true,
      'only the namespaced host storage adapter persists app data');

    await page.evaluate(() => IB.apps.close());
    await waitForPreviewGone(page, normalPreviewUrl);

    const workModeDraft = makeDraft('Synthetic Work Mode preview probe',
      'window.AppStorage.get("items").then(function(result){var values=result&&result.ok&&Array.isArray(result.value)?result.value:[];document.body.dataset.previewReady="yes";' +
      'document.getElementById("add").addEventListener("click",function(){values.push(document.getElementById("item").value);window.AppStorage.set("items",values).then(function(){document.body.dataset.saved="yes"})})});');
    const workModeSrcdoc = await page.evaluate(draft => IBAppBuilderCore.buildSrcdoc(draft), workModeDraft);
    await page.evaluate(() => {
      const host = document.createElement('iframe');
      host.id = 'ib-work-mode-csp-probe-host';
      host.title = 'Work Mode preview parent probe';
      host.src = 'http://127.0.0.1:23141/';
      host.style.cssText = 'position:fixed;left:40px;top:100px;width:520px;height:520px;z-index:2147483647';
      document.body.appendChild(host);
    });
    const workModeHostElement = await page.locator('#ib-work-mode-csp-probe-host').elementHandle();
    const workModeHost = await workModeHostElement.contentFrame();
    assert.ok(workModeHost && workModeHost.url().startsWith('http://127.0.0.1:23141/'),
      'the Synthetic DSH Web UI is available as a separate parent origin');
    await workModeHost.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await workModeHost.evaluate(srcdoc => {
      const store = Object.create(null);
      const child = document.createElement('iframe');
      child.id = 'ib-work-mode-srcdoc-probe';
      child.setAttribute('sandbox', 'allow-scripts');
      window.addEventListener('message', function (event) {
        if (event.source !== child.contentWindow || event.origin !== 'null' || !event.data
          || event.data.type !== 'ib-generated-app-storage-request') return;
        const response = { type: 'ib-generated-app-storage-response', requestId: event.data.requestId, ok: true };
        if (event.data.action === 'get') response.value = store[String(event.data.key || '')] || null;
        if (event.data.action === 'set') store[String(event.data.key || '')] = event.data.value;
        if (event.data.action === 'remove') delete store[String(event.data.key || '')];
        child.contentWindow.postMessage(response, '*');
      });
      document.body.appendChild(child);
      child.srcdoc = srcdoc;
    }, workModeSrcdoc);
    const workModePreview = page.frameLocator('#ib-work-mode-csp-probe-host').frameLocator('#ib-work-mode-srcdoc-probe');
    await workModePreview.getByLabel('Item').waitFor();
    await workModePreview.getByLabel('Item').fill('work mode preview');
    await workModePreview.locator('#add').evaluate(button => button.click());
    await workModePreview.locator('body[data-saved=\"yes\"]').waitFor();
    console.log('PASS  WebView2 Work Mode srcdoc preview still executes under its DSH parent document');
    await page.evaluate(() => { const host = document.getElementById('ib-work-mode-csp-probe-host'); if (host) host.remove(); });

    await page.evaluate(appId => IB.apps.open(appId), normalAppId);
    normalPreviewUrl = await page.locator('#ib-app-overlay iframe.ib-generated-app-frame').getAttribute('src');
    app = page.frameLocator('#ib-app-overlay iframe.ib-generated-app-frame');
    await app.getByLabel('Item').waitFor();
    frame = page.frames().find(item => item.url().includes('/__ib-generated-app/'));
    assert.ok(frame);
    await frame.goto(normalPreviewUrl, { waitUntil: 'domcontentloaded' });
    app = page.frameLocator('#ib-app-overlay iframe.ib-generated-app-frame');
    await app.getByRole('listitem').filter({ hasText: 'stored synthetic item' }).waitFor();
    console.log('PASS  WebView2 executes the isolated app and retains AppStorage through iframe reload');

    const errorDraft = makeDraft('Synthetic app runtime error probe', 'function {');
    const errorInstall = await page.evaluate(draft => IB.apps.installGeneratedApp(draft, { confirmed: true }), errorDraft);
    assert.equal(errorInstall.ok, true);
    errorAppId = errorInstall.appId;
    errorStorageKey = 'ib_app_' + errorAppId + '_items';
    await page.evaluate(appId => IB.apps.open(appId), errorAppId);
    await page.waitForFunction(() => {
      const status = document.querySelector('#ib-app-overlay .ib-generated-app-status');
      return status && !status.hidden && status.textContent.includes('生成应用脚本发生错误');
    }, null, { timeout: 10000 });
    errorPreviewUrl = await page.locator('#ib-app-overlay iframe.ib-generated-app-frame').getAttribute('src');
    console.log('PASS  WebView2 reports generated JavaScript syntax errors without exposing host state');
    await page.evaluate(() => IB.apps.close());
    await waitForPreviewGone(page, errorPreviewUrl);
    console.log('PASS  closing the App Store preview removes its in-memory document');

    await page.evaluate(appId => {
      IB.apps.uninstall(appId);
      const stored = JSON.parse(localStorage.getItem('ib_generated_apps_v1') || '{}');
      delete stored[appId];
      localStorage.setItem('ib_generated_apps_v1', JSON.stringify(stored));
    }, errorAppId);
    errorAppId = '';

    await page.evaluate(appId => IB.apps.open(appId), normalAppId);
    normalPreviewUrl = await page.locator('#ib-app-overlay iframe.ib-generated-app-frame').getAttribute('src');
    await page.evaluate(() => location.reload());
    await page.waitForFunction(() => !!window.IB?.apps && window.__IB_DEV_SYNTHETIC__ === true, null, { timeout: 30000 });
    await waitForPreviewGone(page, normalPreviewUrl);
    console.log('PASS  WebView2 page exit releases the app preview route');
    await page.waitForFunction(draftRef => {
      const id = IB.apps.generatedAppId(draftRef);
      return IB.apps.isGeneratedInstalled(draftRef) && !!IB.apps.defs()[id];
    }, normalDraft.draftRef, { timeout: 15000 });
    await page.evaluate(appId => IB.apps.open(appId), normalAppId);
    const reopenedState = await page.evaluate(input => {
      const generated = JSON.parse(localStorage.getItem('ib_generated_apps_v1') || '{}');
      const enabled = JSON.parse(localStorage.getItem('ib_apps_on_v1') || '{}');
      const generatedId = IB.apps.generatedAppId(input.draftRef);
      return {
        installed: IB.apps.isGeneratedInstalled(input.draftRef),
        generatedIdMatches: generatedId === input.appId,
        generatedEntry: !!generated[generatedId],
        enabledEntry: !!enabled[generatedId],
        storedItem: (localStorage.getItem(input.storageKey) || '').includes('stored synthetic item'),
        iframe: !!document.querySelector('#ib-app-overlay iframe.ib-generated-app-frame')
      };
    }, { draftRef: normalDraft.draftRef, appId: normalAppId, storageKey: normalStorageKey });
    assert.equal(reopenedState.installed, true, JSON.stringify(reopenedState));
    assert.equal(reopenedState.generatedIdMatches, true);
    assert.equal(reopenedState.generatedEntry, true);
    assert.equal(reopenedState.enabledEntry, true);
    assert.equal(reopenedState.storedItem, true);
    app = page.frameLocator('#ib-app-overlay iframe.ib-generated-app-frame');
    await app.getByLabel('Item').waitFor();
    const reopenedFrame = page.frames().find(item => item.url().includes('/__ib-generated-app/'));
    assert.ok(reopenedFrame, 'the app is reopened as an isolated HTTP frame after host reload');
    await app.getByRole('listitem').filter({ hasText: 'stored synthetic item' }).waitFor();
    console.log('PASS  generated app storage survives main WebView reload');
  } finally {
    if (page && !page.isClosed()) {
      try { await page.evaluate(() => { const host = document.getElementById('ib-work-mode-csp-probe-host'); if (host) host.remove(); }); } catch (_) {}
      try { await page.evaluate(() => { if (window.IB?.apps?.isOpen()) IB.apps.close(); }); } catch (_) {}
      for (const appId of [normalAppId, errorAppId].filter(Boolean)) {
        try {
          await page.evaluate(id => {
            if (window.IB?.apps) IB.apps.uninstall(id);
            const stored = JSON.parse(localStorage.getItem('ib_generated_apps_v1') || '{}');
            delete stored[id];
            localStorage.setItem('ib_generated_apps_v1', JSON.stringify(stored));
          }, appId);
        } catch (_) {}
      }
      for (const key of [normalStorageKey, errorStorageKey].filter(Boolean)) {
        try { await page.evaluate(storageKey => localStorage.removeItem(storageKey), key); } catch (_) {}
      }
      for (const url of [normalPreviewUrl, errorPreviewUrl].filter(Boolean)) {
        try { await page.evaluate(async target => fetch(target, { method: 'DELETE', cache: 'no-store' }), url); } catch (_) {}
      }
    }
    await browser.close();
  }
}

main().catch(error => {
  console.error(error && error.stack || String(error));
  process.exitCode = 1;
});
