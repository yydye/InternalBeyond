'use strict';

/* Narrow DIY workshop smoke against the already-running IB Dev source server.
   Uses a temporary browser profile; no production or Dev Sandbox records are touched. */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const DEV_URL = process.env.IB_DEV_URL || 'http://127.0.0.1:23130/InternalBeyond.html';
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/oS8AAAAASUVORK5CYII=', 'base64');

function browserPath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find(fs.existsSync) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => {});
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const request = http.request({
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13'
        }
      });
      request.on('upgrade', (response, socket) => resolve(new Cdp(socket)));
      request.on('error', reject);
      request.end();
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = Buffer.from(JSON.stringify({ id, method, params }));
      const mask = crypto.randomBytes(4);
      const body = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
      let header;
      if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
      else {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payload.length, 2);
      }
      this.socket.write(Buffer.concat([header, mask, body]));
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 30000);
      timer.unref();
    });
  }
  once(method) {
    return new Promise(resolve => {
      const listeners = this.listeners.get(method) || [];
      listeners.push(resolve);
      this.listeners.set(method, listeners);
    });
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const shortLength = this.buffer[1] & 0x7f;
      let offset = 2;
      let length = shortLength;
      if (shortLength === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (shortLength === 127) {
        if (this.buffer.length < 10) return;
        length = this.buffer.readUInt32BE(6);
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const bytes = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if ((first & 0x0f) !== 0x1) continue;
      let message;
      try { message = JSON.parse(bytes.toString()); } catch (error) { continue; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      } else if (message.method && this.listeners.has(message.method)) {
        const listeners = this.listeners.get(message.method) || [];
        this.listeners.delete(message.method);
        listeners.forEach(listener => listener(message.params || {}));
      }
    }
  }
  close() { try { this.socket.destroy(); } catch (error) {} }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result && result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await evaluate(cdp, expression)) return true; } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return false;
}

async function reloadPage(cdp) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.reload', { ignoreCache: true });
  let timer;
  try {
    await Promise.race([
      loaded,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for Page.loadEventFired.')), 15000);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeRemoveProfile(profile) {
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ib-diy-workshop-smoke-')) {
    throw new Error('Refusing to remove an unexpected browser profile path.');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function captureIfRequested(cdp, envKey) {
  const output = process.env[envKey];
  if (!output) return;
  const resolved = path.resolve(output);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('ib-diy-preview-')) {
    throw new Error('Refusing to write a screenshot outside the expected temporary path.');
  }
  await evaluate(cdp, "(function(){var p=document.getElementById('preloader');if(p)p.remove();var s=document.getElementById('splash');if(s)s.remove();var setup=document.getElementById('ib-setup');if(setup)setup.style.display='none';var app=document.getElementById('app');if(app){app.style.transition='none';app.classList.add('visible');app.style.opacity='1'}return true})()");
  await new Promise(resolve => setTimeout(resolve, 1400));
  const viewport = await evaluate(cdp, "({width:innerWidth,height:innerHeight})");
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.floor(viewport.width * .62), y: viewport.height - 48 });
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(resolved, Buffer.from(result.data, 'base64'));
}

(async function main() {
  const browserExe = browserPath();
  if (!browserExe) throw new Error('Chrome / Edge was not found.');
  const response = await fetch(DEV_URL);
  if (!response.ok) throw new Error('IB Dev source server is unavailable: ' + DEV_URL);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-diy-workshop-smoke-'));
  const port = await freePort();
  const browser = spawn(browserExe, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });
  let cdp = null;
  let failures = 0;
  const check = (name, ok, detail) => {
    if (ok) console.log('  PASS  ' + name);
    else { failures++; console.error('  FAIL  ' + name + (detail ? ' -> ' + detail : '')); }
  };

  try {
    let browserReady = false;
    for (let i = 0; i < 160; i++) {
      try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { browserReady = true; break; } } catch (error) {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('browser.ready', browserReady);
    if (!browserReady) throw new Error('CDP did not start.');

    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(DEV_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: [23120, 23114, 23115, 23116, 23118, 23135, 23134, 23136, 23138, 23139, 23137, 23140, 23141].map(port => 'http://127.0.0.1:' + port + '/*').concat(['http://localhost:23120/*', 'http://localhost:23118/*']) });
    check('page.workshopModuleLoaded', await waitFor(cdp, '!!(window.IBDIYWorkshop && window.IBDIYWorkshopCore && document.querySelector("#ib-diy-workshop [data-tab=appearance]"))'));

    await evaluate(cdp, "navTo('diy')");
    check('ui.fiveWorkAreas', await evaluate(cdp, "document.querySelectorAll('#ib-diy-workshop [role=tab]').length===5"));
    await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-visual-section=text]').click()");
    check('ui.visualSectionsSwitch', await evaluate(cdp, "!document.querySelector('[data-visual-panel=text]').hidden&&document.querySelector('[data-visual-panel=main]').hidden"));
    await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-visual-section=main]').click()");
    check('ui.advancedSpecsCollapsed', await evaluate(cdp, "!!document.querySelector('#ib-diy-workshop .diy-advanced')&&!document.querySelector('#ib-diy-workshop .diy-advanced').open"));
    if (process.env.IB_DIY_CAPTURE_DESKTOP || process.env.IB_DIY_CAPTURE_NARROW) {
      await waitFor(cdp, "(function(){var p=document.getElementById('preloader');return !p||getComputedStyle(p).visibility==='hidden'||getComputedStyle(p).opacity==='0'})()", 10000);
      await evaluate(cdp, "(function(){var setup=document.getElementById('ib-setup');if(setup)setup.style.display='none';return true})()");
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    check('layout.desktopFits', await evaluate(cdp, "document.querySelector('#ib-diy-workshop').scrollWidth<=document.querySelector('#ib-diy-workshop').clientWidth+1"));
    for (const [width, height] of [[1280, 800], [1440, 900], [390, 844]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-tab=portrait]').click()");
      const portraitLayout = await evaluate(cdp, "(function(){var grid=document.querySelector('.diy-portrait-grid'),panel=grid&&grid.closest('.diy-tab-panel'),form=grid&&grid.querySelector('.diy-form-stack'),column=grid&&grid.querySelector('.diy-preview-column'),scene=grid&&grid.querySelector('.diy-room-preview'),img=grid&&grid.querySelector('#diy-room-portrait-img'),placeholder=grid&&grid.querySelector('#diy-portrait-placeholder');if(!grid||!panel||!form||!column||!scene||!img||!placeholder)return null;var gr=grid.getBoundingClientRect(),pr=panel.getBoundingClientRect(),fr=form.getBoundingClientRect(),cr=column.getBoundingClientRect(),sr=scene.getBoundingClientRect();return{gridWidth:gr.width,gridScrollWidth:grid.scrollWidth,panelRight:pr.right,gridRight:gr.right,formBottom:fr.bottom,columnTop:cr.top,columnLeft:cr.left,columnRight:cr.right,sceneLeft:sr.left,sceneRight:sr.right,sceneWidth:sr.width,sceneHeight:sr.height,columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,portraitEmpty:img.hidden&&!img.hasAttribute('src')&&img.currentSrc===''&&!placeholder.hidden&&placeholder.getClientRects().length>0}})()");
      const mobile = width <= 800;
      const portraitFits = !!(portraitLayout
        && portraitLayout.gridScrollWidth <= portraitLayout.gridWidth + 1
        && portraitLayout.gridRight <= portraitLayout.panelRight + 1
        && portraitLayout.sceneLeft >= portraitLayout.columnLeft - 1
        && portraitLayout.sceneRight <= portraitLayout.columnRight + 1
        && Math.abs(portraitLayout.sceneWidth / portraitLayout.sceneHeight - 16 / 9) < .03
        && portraitLayout.columns === (mobile ? 1 : 2)
        && (!mobile || portraitLayout.columnTop >= portraitLayout.formBottom - 1));
      check('layout.portrait.' + width + '.fitsParentAndKeepsSceneRatio', portraitFits, JSON.stringify(portraitLayout));
      if (width === 1280) check('layout.portrait.emptyStateHasNoBrokenImage', !!(portraitLayout && portraitLayout.portraitEmpty), JSON.stringify(portraitLayout));
      const portraitCaptureKey = 'IB_DIY_CAPTURE_PORTRAIT_' + width;
      if (process.env[portraitCaptureKey]) {
        await evaluate(cdp, "document.querySelector('.diy-portrait-grid').scrollIntoView({block:'start'});true");
        await captureIfRequested(cdp, portraitCaptureKey);
      }
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-tab=appearance]').click()");
    const visualSchemeLayout = await evaluate(cdp, "(function(){var r=document.querySelector('#diy-visual-scheme-grid .uvt-row'),o=r&&r.querySelector('.uvt-ops'),b=o&&o.querySelector('button');return r&&o&&b?{row:r.getBoundingClientRect().width,ops:o.getBoundingClientRect().width,button:b.getBoundingClientRect().width}:null})()");
    check('layout.visualSchemeButtonsUsable', !!(visualSchemeLayout&&visualSchemeLayout.row>700&&visualSchemeLayout.ops>200&&visualSchemeLayout.button>=52), JSON.stringify(visualSchemeLayout));
    await captureIfRequested(cdp, 'IB_DIY_CAPTURE_DESKTOP');
    await evaluate(cdp, "document.querySelector('#diy-visual-scheme-grid').scrollIntoView({block:'start'});true");
    await captureIfRequested(cdp, 'IB_DIY_CAPTURE_VISUAL_SCHEMES_DESKTOP');
    await evaluate(cdp, "window.scrollTo(0,0);true");
    await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-tab=bubble]').click();document.querySelector('[data-bubble-page=lab]').click();true");
    await evaluate(cdp, "document.documentElement.style.scrollBehavior='auto';document.querySelector('#ib-diy-workshop .blx-shell').scrollIntoView({block:'end'});true");
    const desktopBubbleGeometry = await evaluate(cdp, "(function(){var shell=document.querySelector('#ib-diy-workshop .blx-shell'),scroll=document.querySelector('#ib-diy-workshop .blx-lab-scroll'),log=document.querySelector('#diy-bubble-log'),input=document.querySelector('#ib-diy-workshop .blx-in'),tabs=document.querySelector('#ib-diy-workshop .blx-tabs'),sr=shell.getBoundingClientRect(),lr=log.getBoundingClientRect(),ir=input.getBoundingClientRect(),tr=tabs.getBoundingClientRect();return{height:sr.height,logHeight:lr.height,logOverflow:getComputedStyle(log).overflowY,contentOverflow:getComputedStyle(scroll).overflowY,contentBottom:scroll.getBoundingClientRect().bottom,inputTop:ir.top,tabsBottom:tr.bottom,viewport:innerHeight}})()");
    check('layout.desktop.bubbleShellUsesAvailableHeight', !!(desktopBubbleGeometry&&desktopBubbleGeometry.height>=640&&desktopBubbleGeometry.height<=750&&desktopBubbleGeometry.tabsBottom<=desktopBubbleGeometry.viewport), JSON.stringify(desktopBubbleGeometry));
    check('layout.desktop.bubbleConversationOwnsScroll', !!(desktopBubbleGeometry&&desktopBubbleGeometry.logHeight>=120&&desktopBubbleGeometry.logOverflow==='auto'&&desktopBubbleGeometry.contentOverflow==='hidden'&&desktopBubbleGeometry.contentBottom<=desktopBubbleGeometry.inputTop+1), JSON.stringify(desktopBubbleGeometry));
    const desktopBubbleDock = await evaluate(cdp, "(function(){var e=document.querySelector('#ib-diy-workshop .blx-tabs'),r=e&&e.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:r.height}:null})()");
    check('layout.desktop.bubbleDockVisible', !!(desktopBubbleDock&&desktopBubbleDock.height>=44&&desktopBubbleDock.top>=0&&desktopBubbleDock.bottom<=800), JSON.stringify(desktopBubbleDock));
    check('layout.desktop.bubbleComposerClear', await evaluate(cdp, "(function(){var p=document.querySelector('[data-bubble-page-panel=lab]'),s=p&&p.querySelector('.blx-lab-scroll'),i=p&&p.querySelector(':scope > .blx-in'),sr=s&&s.getBoundingClientRect(),ir=i&&i.getBoundingClientRect();return !!(s&&i&&s.parentElement===p&&i.parentElement===p&&sr&&ir&&sr.bottom<=ir.top+1)})()"));
    await captureIfRequested(cdp, 'IB_DIY_CAPTURE_BUBBLE_DESKTOP');
    await evaluate(cdp, "document.documentElement.style.scrollBehavior='auto';document.querySelector('[data-bubble-page=schemes]').click();var p=document.querySelector('[data-bubble-page-panel=schemes]'),slot=document.querySelector('#diy-bubble-slots .blx-slot:last-child');p.scrollTop+=slot.getBoundingClientRect().top-p.getBoundingClientRect().top;true");
    const desktopSchemeVisibility = await evaluate(cdp, "(function(){var page=document.querySelector('[data-bubble-page-panel=schemes]'),slot=document.querySelector('#diy-bubble-slots .blx-slot:last-child'),tabs=document.querySelector('#ib-diy-workshop .blx-tabs'),pr=page.getBoundingClientRect(),sr=slot.getBoundingClientRect(),tr=tabs.getBoundingClientRect();return{slotVisible:sr.top>=pr.top&&sr.bottom<=pr.bottom+1,tabsBottom:tr.bottom,viewport:innerHeight}})()");
    check('layout.desktop.schemeListAndDockStayVisible', !!(desktopSchemeVisibility&&desktopSchemeVisibility.slotVisible&&desktopSchemeVisibility.tabsBottom<=desktopSchemeVisibility.viewport), JSON.stringify(desktopSchemeVisibility));
    await captureIfRequested(cdp, 'IB_DIY_CAPTURE_SCHEMES_DESKTOP');
    await evaluate(cdp, "document.querySelector('[data-bubble-page=lab]').click();document.querySelector('#ib-diy-workshop [data-tab=appearance]').click();true");
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate(cdp, "(function(){var toggle=document.getElementById('ib-navigation-collapse');if(toggle&&toggle.getAttribute('aria-expanded')==='true')toggle.click();return true})()");
    check('layout.narrowNavCollapsed', await waitFor(cdp, "document.getElementById('navbar').getBoundingClientRect().width<90", 2000));
    check('layout.narrowCalendarYields', await evaluate(cdp, "getComputedStyle(document.getElementById('cal-widget')).visibility==='hidden'"));
    check('layout.narrowFits', await evaluate(cdp, "document.querySelector('#ib-diy-workshop').scrollWidth<=document.querySelector('#ib-diy-workshop').clientWidth+1"));
    check('layout.narrow.workshopTabsStaySingleLine', await evaluate(cdp, "getComputedStyle(document.querySelector('#ib-diy-workshop [data-tab=bubble]')).whiteSpace==='nowrap'"));
    await captureIfRequested(cdp, 'IB_DIY_CAPTURE_NARROW');
    await evaluate(cdp, "document.querySelector('#diy-visual-scheme-grid').scrollIntoView({block:'start'});true");
    await captureIfRequested(cdp, 'IB_DIY_CAPTURE_VISUAL_SCHEMES_NARROW');
    await evaluate(cdp, "window.scrollTo(0,0);true");
    for (const tab of ['portrait', 'scene', 'materials', 'bubble']) {
      await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-tab=" + tab + "]').click()");
      check('layout.narrow.' + tab, await evaluate(cdp, "document.querySelector('#ib-diy-workshop').scrollWidth<=document.querySelector('#ib-diy-workshop').clientWidth+1"));
      if (tab === 'bubble') {
        await evaluate(cdp, "document.documentElement.style.scrollBehavior='auto';document.querySelector('#ib-diy-workshop .blx-shell').scrollIntoView({block:'end'});true");
        await captureIfRequested(cdp, 'IB_DIY_CAPTURE_BUBBLE_NARROW');
      }
    }
    await evaluate(cdp, "document.documentElement.style.scrollBehavior='auto';document.querySelector('#ib-diy-workshop .blx-shell').scrollIntoView({block:'end'});document.querySelector('[data-bubble-page=schemes]').click();var p=document.querySelector('[data-bubble-page-panel=schemes]'),slot=document.querySelector('#diy-bubble-slots .blx-slot:last-child');p.scrollTop+=slot.getBoundingClientRect().top-p.getBoundingClientRect().top;true");
    const narrowSchemeVisibility = await evaluate(cdp, "(function(){var page=document.querySelector('[data-bubble-page-panel=schemes]'),slot=document.querySelector('#diy-bubble-slots .blx-slot:last-child'),tabs=document.querySelector('#ib-diy-workshop .blx-tabs'),shell=document.querySelector('#ib-diy-workshop .blx-shell'),pr=page.getBoundingClientRect(),sr=slot.getBoundingClientRect(),tr=tabs.getBoundingClientRect(),hr=shell.getBoundingClientRect();return{slotVisible:sr.top>=pr.top-1&&sr.bottom<=pr.bottom+1,slotTop:sr.top,slotBottom:sr.bottom,pageTop:pr.top,pageBottom:pr.bottom,pageScrollTop:page.scrollTop,pageScrollHeight:page.scrollHeight,pageClientHeight:page.clientHeight,tabsBottom:tr.bottom,shellBottom:hr.bottom}})()");
    check('layout.narrow.schemeListAndDockStayVisible', !!(narrowSchemeVisibility&&narrowSchemeVisibility.slotVisible&&narrowSchemeVisibility.tabsBottom<=narrowSchemeVisibility.shellBottom+1), JSON.stringify(narrowSchemeVisibility));
    await captureIfRequested(cdp, 'IB_DIY_CAPTURE_SCHEMES_NARROW');
    await evaluate(cdp, "document.querySelector('[data-bubble-page=lab]').click();true");
    await evaluate(cdp, "document.documentElement.style.scrollBehavior='auto';document.querySelector('#ib-diy-workshop .blx-shell').scrollIntoView({block:'end'});true");
    const bubbleDock = await evaluate(cdp, "(function(){var e=document.querySelector('#ib-diy-workshop .blx-tabs'),r=e&&e.getBoundingClientRect(),shell=e&&e.closest('.blx-shell'),s=shell&&shell.getBoundingClientRect();return r?{top:r.top,bottom:r.bottom,height:r.height,viewport:innerHeight,shellBottom:s&&s.bottom,directChild:!!(e.parentElement&&e.parentElement.classList.contains('blx-shell'))}:null})()");
    check('layout.narrow.bubbleDockVisible', !!(bubbleDock&&bubbleDock.height>=44&&bubbleDock.top>=0&&bubbleDock.bottom<=845&&bubbleDock.directChild&&bubbleDock.bottom<=bubbleDock.shellBottom+1), JSON.stringify(bubbleDock));
    const narrowBubbleShell = await evaluate(cdp, "(function(){var e=document.querySelector('#ib-diy-workshop .blx-shell'),r=e&&e.getBoundingClientRect();return r?{height:r.height,bottom:r.bottom}:null})()");
    check('layout.narrow.bubbleShellUsesAvailableHeight', !!(narrowBubbleShell&&narrowBubbleShell.height>=500&&narrowBubbleShell.height<=560&&narrowBubbleShell.bottom<=845), JSON.stringify(narrowBubbleShell));
    check('layout.narrow.bubbleUsesOneScrollRegion', await evaluate(cdp, "getComputedStyle(document.querySelector('.blx-lab-scroll')).overflowY==='auto'&&getComputedStyle(document.querySelector('#diy-bubble-log')).overflowY==='visible'"));
    check('layout.narrow.bubbleComposerClear', await evaluate(cdp, "(function(){var p=document.querySelector('[data-bubble-page-panel=lab]'),s=p&&p.querySelector('.blx-lab-scroll'),i=p&&p.querySelector(':scope > .blx-in'),sr=s&&s.getBoundingClientRect(),ir=i&&i.getBoundingClientRect();return !!(s&&i&&s.parentElement===p&&i.parentElement===p&&sr&&ir&&sr.bottom<=ir.top+1)})()"));
    await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-tab=appearance]').click()");
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    await evaluate(cdp, "(async function(){await dbPut('apiConfigs',{id:'diy_role_smoke',provider:'openai',model:'diy-smoke-model',credentialRef:'vault:diy_role_smoke',nickname:'DIY Smoke'});return true})()");
    await reloadPage(cdp);
    await waitFor(cdp, '!!window.IBDIYWorkshop');
    check('role.listLoaded', await waitFor(cdp, "!!(document.querySelector('#diy-role-select option[value=diy_role_smoke]'))"));
    await evaluate(cdp, "window.customPortraitSrc=function(){return '/__missing_diy_portrait_smoke__.png'};document.querySelector('#ib-diy-workshop [data-tab=portrait]').click();var s=document.getElementById('diy-role-select');s.value='diy_role_smoke';s.dispatchEvent(new Event('change',{bubbles:true}))");
    check('portrait.missingLegacyImageShowsEmptyState', await waitFor(cdp, "(function(){var img=document.getElementById('diy-room-portrait-img'),empty=document.getElementById('diy-portrait-placeholder');return !!(img&&empty&&img.hidden&&!img.hasAttribute('src')&&img.currentSrc===''&&empty.hidden===false&&img.getClientRects().length===0)})()", 5000));
    await evaluate(cdp, "window.__diyApiCalls=0;window.__diyApiShouldFail=false;window.__diyApiResponse=JSON.stringify({name:'安全星雾',user:{stops:['#527fd1','#c3b7f2'],angle:135,opacity:.92,borderColor:'#dce8ff',borderWidth:1.5,borderStyle:'solid',decoration:'spark'},assistant:{stops:['#eff5fb','#c3d7ee'],borderColor:'#8da7c8',borderWidth:1,decoration:'corner'}});window.callApiChat=async function(config,messages,options){window.__diyApiCalls++;window.__diyApiOptions={config:config,messages:messages,options:options};if(window.__diyApiShouldFail)throw new Error('CREDENTIAL_UNAVAILABLE');return window.__diyApiResponse};");
    await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-tab=bubble]').click();var api=document.getElementById('diy-bubble-api');api.value='diy_role_smoke';api.dispatchEvent(new Event('change',{bubbles:true}));var prompt=document.getElementById('diy-bubble-prompt');prompt.value='蓝白渐变，细边框和角落星光';document.querySelector('[data-action=bubble-generate]').click()");
    check('bubble.aiRequestIsExplicitAndToolFree', await waitFor(cdp, "window.__diyApiCalls===1&&document.querySelector('#diy-bubble-log').textContent.includes('已生成方案「安全星雾」')&&!!document.querySelector('.blx-live-preview [data-bubble-side=user].ib-diy-bubble-custom')"));
    check('bubble.selectedRoleAndVaultRefReachChatApi', await evaluate(cdp, "window.__diyApiOptions.config.id==='diy_role_smoke'&&window.__diyApiOptions.config.credentialRef==='vault:diy_role_smoke'&&window.__diyApiOptions.options._ibConsumer==='diy_bubble_lab'"));
    check('bubble.systemPromptAndToolsDisabled', await evaluate(cdp, "window.__diyApiOptions.options.disableTools===true&&window.__diyApiOptions.options._noWebSearch===true&&window.__diyApiOptions.messages[0].role==='system'"));
    check('bubble.multicolorBorderDecorationPreview', await evaluate(cdp, "document.querySelector('.blx-live-preview [data-bubble-side=user]').style.getPropertyValue('--ib-diy-bubble-background').includes('linear-gradient')&&document.querySelector('.blx-live-preview [data-bubble-side=user]').classList.contains('ib-diy-deco-spark')"));
    await evaluate(cdp, "window.__diyApiResponse=JSON.stringify({name:'轻透星雾',user:{opacity:.56},assistant:{opacity:.74}});var p=document.getElementById('diy-bubble-prompt');p.value='再淡一点';document.querySelector('[data-action=bubble-generate]').click()");
    check('bubble.secondTurnUsesPreviousSchemeAndHistory', await waitFor(cdp, "window.__diyApiCalls===2&&window.__diyApiOptions.messages[0].content.includes('当前方案')&&window.__diyApiOptions.messages[0].content.includes('\\\"name\\\":\\\"安全星雾\\\"')&&window.__diyApiOptions.messages.some(function(m){return m.role==='user'&&m.content==='蓝白渐变，细边框和角落星光'})&&window.__diyApiOptions.messages.some(function(m){return m.role==='assistant'&&m.content.indexOf('已生成方案「安全星雾」')>=0})&&document.querySelector('#diy-bubble-log').textContent.includes('已生成方案「轻透星雾」')"));
    await evaluate(cdp, "document.querySelector('[data-bubble-theme-select=infernal]').click()");
    check('bubble.themePreviewSwitches', await evaluate(cdp, "document.querySelector('[data-bubble-theme-select=infernal]').classList.contains('cur')&&document.querySelector('[data-bubble-theme-status=infernal]').textContent.includes('当前主题')"));
    await evaluate(cdp, "document.querySelector('[data-bubble-theme-select=internal]').click();document.querySelector('[data-bubble-page=schemes]').click()");
    check('bubble.labAndSchemePagesSwitch', await evaluate(cdp, "document.querySelector('[data-bubble-page-panel=schemes]').hidden===false&&document.querySelector('[data-bubble-page-panel=lab]').hidden"));
    await evaluate(cdp, "document.querySelector('[data-bubble-page=lab]').click()");
    await evaluate(cdp, "window.__diyApiResponse='<svg onload=alert(1)>';var p=document.getElementById('diy-bubble-prompt');p.value='继续';document.querySelector('[data-action=bubble-generate]').click()");
    check('bubble.rejectsUntrustedSvg', await waitFor(cdp, "window.__diyApiCalls===3&&document.querySelector('#diy-bubble-log').textContent.includes('方案未应用')&&!document.querySelector('#diy-bubble-log svg, .blx-pv svg')"));
    await evaluate(cdp, "window.__diyApiShouldFail=true;var p=document.getElementById('diy-bubble-prompt');p.value='无法连接时不生成';document.querySelector('[data-action=bubble-generate]').click()");
    check('bubble.providerFailureDoesNotClaimSuccess', await waitFor(cdp, "(function(){var log=document.getElementById('diy-bubble-log'),last=log&&log.lastElementChild;return window.__diyApiCalls===4&&last&&last.textContent.includes('生成失败，方案未应用')&&!last.textContent.includes('已生成方案')})()"));
    for (const [width, height, mobile] of [[1280, 800, false], [390, 844, true]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate(cdp, "document.documentElement.style.scrollBehavior='auto';document.querySelector('#ib-diy-workshop .blx-shell').scrollIntoView({block:'end'});true");
      await evaluate(cdp, mobile
        ? "(function(){var last=document.querySelector('#diy-bubble-log').lastElementChild;if(last)last.scrollIntoView({block:'end'});return true})()"
        : "(function(){var log=document.getElementById('diy-bubble-log');log.scrollTop=log.scrollHeight;return true})()");
      const bubbleVisibility = await evaluate(cdp, "(function(){var mobileLayout=" + mobile + ",log=document.getElementById('diy-bubble-log'),lab=document.querySelector('.blx-lab-scroll'),input=document.querySelector('.blx-in'),tabs=document.querySelector('.blx-tabs'),shell=document.querySelector('.blx-shell'),last=log.lastElementChild,scroll=mobileLayout?lab:log,sr=scroll.getBoundingClientRect(),lr=last.getBoundingClientRect(),labRect=lab.getBoundingClientRect(),ir=input.getBoundingClientRect(),tr=tabs.getBoundingClientRect(),hr=shell.getBoundingClientRect();return{lastVisible:lr.top>=sr.top-1&&lr.bottom<=sr.bottom+1,scrollBottom:labRect.bottom,inputTop:ir.top,inputBottom:ir.bottom,tabsTop:tr.top,tabsBottom:tr.bottom,shellBottom:hr.bottom}})()");
      check('layout.' + (mobile ? 'narrow' : 'desktop') + '.lastMessageInputAndDockVisible', !!(bubbleVisibility&&bubbleVisibility.lastVisible&&bubbleVisibility.scrollBottom<=bubbleVisibility.inputTop+1&&bubbleVisibility.inputBottom<=bubbleVisibility.tabsTop+1&&bubbleVisibility.tabsBottom<=bubbleVisibility.shellBottom+1), JSON.stringify(bubbleVisibility));
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(cdp, "document.getElementById('diy-bubble-save-slot').value='0';document.getElementById('diy-bubble-save-slot').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-action=bubble-save-slot]').click();document.querySelector('[data-action=bubble-set-global]').click();var role=document.getElementById('diy-bubble-role');role.value='diy_role_smoke';role.dispatchEvent(new Event('change',{bubbles:true}));var binding=document.getElementById('diy-bubble-binding-slot');binding.value='0';binding.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-action=bubble-bind]').click();");
    await evaluate(cdp, "navTo('diy');var s=document.getElementById('diy-role-select');s.value='diy_role_smoke';s.dispatchEvent(new Event('change',{bubbles:true}));var c=document.getElementById('diy-accent');c.value='#d8f2ff';c.dispatchEvent(new Event('input',{bubbles:true}));var zone=document.querySelector('[data-section-color=home]');zone.value='#aa6677';zone.dispatchEvent(new Event('input',{bubbles:true}));var fs=document.getElementById('diy-font-scale');fs.value='110';fs.dispatchEvent(new Event('input',{bubbles:true}));var font=document.getElementById('diy-font-family');font.value='serif';font.dispatchEvent(new Event('change',{bubbles:true}));var chat=document.getElementById('diy-chat-font');chat.value='serif';chat.dispatchEvent(new Event('change',{bubbles:true}));var shadow=document.getElementById('diy-card-shadow');shadow.checked=false;shadow.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-visual-setting=widgetStyle][data-v=ink]').click();var deco=document.getElementById('diy-decorations');deco.checked=false;deco.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-action=save-visual-slot][data-slot=\"0\"]').click();");

    const pngBase64 = TINY_PNG.toString('base64');
    await evaluate(cdp, "(function(){var raw=atob('" + pngBase64 + "'),bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);var transfer=new DataTransfer();transfer.items.add(new File([bytes],'portrait.png',{type:'image/png'}));var input=document.getElementById('diy-portrait-file');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
    check('draft.imageIsPreviewed', await waitFor(cdp, "(function(){var img=document.getElementById('diy-room-portrait-img'),empty=document.getElementById('diy-portrait-placeholder');return !!(window.IBDIYWorkshop.isDirty()&&img&&!img.hidden&&img.complete&&img.naturalWidth>0&&img.src.indexOf('data:image/png;base64,')===0&&empty.hidden)})()"));
    check('draft.notWrittenBeforeApply', await evaluate(cdp, "(async function(){return await dbGet('apiSettings','ibDiyWorkshopV1')===undefined&&document.documentElement.style.getPropertyValue('--accent')===''})()"));

    await evaluate(cdp, "document.querySelector('[data-action=apply-visual-slot][data-slot=\"0\"]').click()");
    check('apply.savedInUserSettings', await waitFor(cdp, "(async function(){var c=await dbGet('apiSettings','ibDiyWorkshopV1');return !!(c&&c.portraits&&c.portraits.diy_role_smoke&&c.portraits.diy_role_smoke.src.indexOf('data:image/png;base64,')===0&&c.sectionColors.home==='#aa6677'&&c.accent&&c.apiKey===undefined&&c.fontScale===1.1&&c.fontFamily==='serif'&&c.chatFont==='serif'&&c.cardShadow===false&&c.widgetStyle==='ink'&&c.decorations===false&&c.visualSchemes[0].snapshot.accent===c.accent&&c.bubbleSchemes[0].user.stops.length===2&&c.bubbleActive.internal==='0'&&c.bubbleBindings.diy_role_smoke.internal==='0'&&document.documentElement.style.fontSize==='110%'&&document.body.dataset.ibDiyChatFont==='serif'&&document.body.dataset.ibDiyWidgetStyle==='ink'&&document.body.classList.contains('ib-diy-no-decorations')&&document.getElementById('page-home').classList.contains('ib-diy-zone-home'))})()"));
    check('bubble.roleBindingReachesChatRenderer', await evaluate(cdp, "(function(){var u=window._buildMsgEl({role:'user',content:'我的消息',friendId:'diy_role_smoke'},false,false,[]).querySelector('.chat-msg.user');var a=window._buildMsgEl({role:'assistant',content:'TA 的消息',friendId:'diy_role_smoke',metadata:{config_id:'diy_role_smoke'}},false,false,[]).querySelector('.chat-msg.ai');return !!(u&&a&&u.dataset.diyRoleId==='diy_role_smoke'&&a.dataset.diyRoleId==='diy_role_smoke'&&u.style.getPropertyValue('--ib-diy-bubble-background').includes('linear-gradient')&&a.style.getPropertyValue('--ib-diy-bubble-background').includes('linear-gradient'))})()"));

    await reloadPage(cdp);
    check('reload.configRestored', await waitFor(cdp, "(async function(){var c=await dbGet('apiSettings','ibDiyWorkshopV1');return !!(window.IBDIYWorkshop&&c&&window.IBDIYWorkshop.getAppliedConfig().portraits.diy_role_smoke&&window.IBDIYWorkshop.getAppliedConfig().bubbleBindings.diy_role_smoke.internal==='0'&&window.IBDIYWorkshop.getAppliedConfig().fontScale===1.1&&document.documentElement.style.fontSize==='110%'&&document.body.dataset.ibDiyWidgetStyle==='ink')})()"));
    await evaluate(cdp, "window.IBDIYWorkshop.ready.then(function(){return true})");
    await evaluate(cdp, "window.IBDIYWorkshop.resetDraft()");
    const resetDraft = await evaluate(cdp, "(function(){var c=window.IBDIYWorkshop.getDraftConfig();return{dirty:window.IBDIYWorkshop.isDirty(),accent:c.accent,sections:Object.keys(c.sectionColors),assets:Object.keys(c.assets),portraits:Object.keys(c.portraits),style:c.tarotFaceStyle}})()");
    await evaluate(cdp, "document.querySelector('#ib-diy-workshop [data-action=apply]').click()");
    const resetRemoved = await waitFor(cdp, "(async function(){return await dbGet('apiSettings','ibDiyWorkshopV1')===undefined&&document.documentElement.style.getPropertyValue('--accent')===''&&document.documentElement.style.fontSize===''&&!document.body.classList.contains('ib-diy-no-decorations')&&document.body.dataset.ibDiyWidgetStyle==='default'&&!document.getElementById('page-home').classList.contains('ib-diy-zone-home')})()", 5000);
    const resetRecord = await evaluate(cdp, "(async function(){var c=await dbGet('apiSettings','ibDiyWorkshopV1');return c?{accent:c.accent,sections:Object.keys(c.sectionColors||{}),assets:Object.keys(c.assets||{}),portraits:Object.keys(c.portraits||{}),style:c.tarotFaceStyle}:null})()");
    check('reset.removesCustomConfig', resetRemoved, JSON.stringify({ draft: resetDraft, record: resetRecord }));
    await reloadPage(cdp);
    check('reset.survivesReload', await waitFor(cdp, "!!(window.IBDIYWorkshop&&window.IBDIYWorkshop.getAppliedConfig().tarotFaceStyle==='veil')"));
    if (failures) process.exitCode = 1;
  } finally {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch (error) {}
      cdp.close();
    }
    try { browser.kill(); } catch (error) {}
    if (browser.exitCode === null) {
      await Promise.race([
        new Promise(resolve => browser.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2500))
      ]);
    }
    try { safeRemoveProfile(profile); } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
})();
