'use strict';

/* Chrome / Edge UI 回归（Node 18+，零依赖）。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const candidate of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(candidate)) return candidate;
  return null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.id = 0;
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

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendText({ id, method, params });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 15000);
    });
  }

  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    }
    this.socket.write(Buffer.concat([header, mask, body]));
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
      const masked = (this.buffer[1] & 0x80) !== 0;
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) {
        const decoded = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) decoded[i] = payload[i] ^ mask[i & 3];
        payload = decoded;
      }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let message;
      try { message = JSON.parse(payload.toString('utf8')); } catch (error) { continue; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      } else if (message.method && this.listeners.has(message.method)) {
        for (const listener of this.listeners.get(message.method)) listener(message.params || {});
      }
    }
  }

  close() {
    try { this.socket.destroy(); } catch (error) { /* ignore */ }
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result && response.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await evaluate(cdp, expression)) return true; } catch (error) { /* page is still loading */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
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

async function main() {
  const chrome = chromePath();
  if (!chrome) throw new Error('未找到 Chrome / Edge；可通过 CHROME_PATH 指定浏览器');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ui-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--allow-file-access-from-files', '--force-color-profile=srgb',
    '--window-size=1440,900', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });
  let failures = 0;
  let cdp;
  const runtimeErrors = [];
  const check = (name, condition, detail = '') => {
    if (condition) console.log('  PASS  ' + name);
    else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  };

  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (response.ok) { ready = true; break; }
      } catch (error) { /* browser is starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check('browser.ready', ready);
    if (!ready) throw new Error('Chrome DevTools 未就绪');

    const tabResponse = await fetch('http://127.0.0.1:' + port + '/json/new?about%3Ablank', { method: 'PUT' });
    const tab = await tabResponse.json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    cdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(event.exceptionDetails && event.exceptionDetails.text || 'Runtime exception'));
    cdp.on('Runtime.consoleAPICalled', event => {
      if (event.type !== 'error') return;
      runtimeErrors.push((event.args || []).map(arg => arg.value || arg.description || '').join(' '));
    });
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: PAGE_URL });
    check('page.ready', await waitFor(cdp, "document.readyState==='complete' && window.__ibBootCount===1", 20000));

    await evaluate(cdp, `(()=>{
      const splash=document.getElementById('splash');if(splash)splash.classList.add('hidden');
      document.getElementById('navbar').classList.add('visible');
      document.getElementById('app').classList.add('visible');
      return true;
    })()`);

    const structure = await evaluate(cdp, `(()=>({
      scripts:[...document.scripts].filter(s=>s.src.startsWith('file:')).length,
      styles:[...document.styleSheets].filter(s=>s.href&&s.href.startsWith('file:')).length,
      nav:document.querySelectorAll('#ib-bridge-nav').length,
      panel:document.querySelectorAll('#ib-bridge-panel').length,
      fab:document.querySelectorAll('#ib-bridge-fab').length,
      background:getComputedStyle(document.getElementById('bg-internal-img')).backgroundImage,
      skip:!!document.querySelector('.skip-link[href="#app"]'),
      main:document.getElementById('app').getAttribute('role'),
      navLinkIssues:[...document.querySelectorAll('.nav-links a')].filter(a=>!a.href||a.tabIndex<0).map(a=>({page:a.dataset.page,href:a.getAttribute('href'),tabIndex:a.tabIndex})),
      unnamedButtons:[...document.querySelectorAll('button')].filter(b=>!(b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim()).map(b=>b.id||b.className||'<button>').slice(0,20),
      unnamedRoleButtons:[...document.querySelectorAll('[role="button"]')].filter(b=>!(b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim()).map(b=>b.id||b.className||b.tagName).slice(0,20)
    }))()`);
    check('assets.externalScriptsLoaded', structure.scripts >= 15, String(structure.scripts));
    check('assets.externalStylesLoaded', structure.styles === 16, String(structure.styles));
    check('assets.backgroundResolved', /bg-internal\.jpg/.test(structure.background), structure.background);
    check('bridge.singleEntry', structure.nav === 1 && structure.panel === 1 && structure.fab === 0, JSON.stringify(structure));
    check('a11y.landmarks', structure.skip && structure.main === 'main' && structure.navLinkIssues.length === 0, JSON.stringify(structure));
    check('a11y.staticButtonsNamed', structure.unnamedButtons.length === 0, JSON.stringify(structure.unnamedButtons));
    check('a11y.customButtonsNamed', structure.unnamedRoleButtons.length === 0, JSON.stringify(structure.unnamedRoleButtons));

    check('vault.panelMounted', await waitFor(cdp, "!!document.getElementById('ib-local-vault-root') && !!document.querySelector('[data-ib-vault-action=\"encrypted-export\"]')", 10000));
    /* 加密导出依赖 IndexedDB；页面 ready 后 db 还要约几百毫秒才打开，必须等它就绪再读写 */
    check('vault.dbReady', await waitFor(cdp, "typeof db !== 'undefined'", 10000));
    const vaultRoundTrip = await evaluate(cdp, `(async()=>{
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const exportButton=document.querySelector('[data-ib-vault-action="encrypted-export"]');
      if(!exportButton||exportButton.disabled||!crypto.subtle||typeof dbPut!=='function')return {skipped:true};
      const id='ui_vault_'+Date.now();
      const post={id,title:'vault smoke',subtitle:'',category:'',locked:false,content:'local vault smoke',created:Date.now(),updated:Date.now()};
      const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL,originalClick=HTMLAnchorElement.prototype.click;
      let captured='';
      try{
        URL.createObjectURL=function(blob){blob.text().then(text=>{captured=text});return 'blob:ib-vault-smoke'};
        URL.revokeObjectURL=function(){};
        HTMLAnchorElement.prototype.click=function(){};
        await dbPut('posts',post);
        exportButton.click();
        for(let i=0;i<40&&!document.getElementById('ib-vault-modal')?.hidden;i++)await sleep(25);
        const modal=document.getElementById('ib-vault-modal');
        if(!modal||modal.hidden)return {error:'export modal did not open'};
        document.getElementById('ib-vault-password').value='vault smoke password';
        document.getElementById('ib-vault-password-confirm').value='vault smoke password';
        document.getElementById('ib-vault-modal-submit').click();
        for(let i=0;i<200&&!captured;i++)await sleep(25);
        if(!captured)return {error:'encrypted download was not produced'};
        const envelope=JSON.parse(captured);
        if(envelope.format!=='InternalBeyondEncryptedBackup'||!envelope.ciphertext)return {error:'unexpected encrypted envelope'};
        await dbDelete('posts',id);
        const input=document.getElementById('importFile'),dt=new DataTransfer();
        dt.items.add(new File([captured],'vault-smoke.ibvault',{type:'application/json'}));
        input.files=dt.files;
        input.dispatchEvent(new Event('change',{bubbles:true}));
        for(let i=0;i<40&&document.getElementById('ib-vault-modal')?.hidden;i++)await sleep(25);
        if(document.getElementById('ib-vault-modal')?.hidden)return {error:'import password modal did not open'};
        document.getElementById('ib-vault-password').value='vault smoke password';
        document.getElementById('ib-vault-modal-submit').click();
        let restored=null;
        for(let i=0;i<240;i++){restored=await dbGet('posts',id);if(restored)break;await sleep(25)}
        await dbDelete('posts',id);
        return {ok:!!restored,format:envelope.format,version:envelope.version};
      }catch(error){return {error:String(error&&error.message||error)}}finally{
        URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;HTMLAnchorElement.prototype.click=originalClick;
        try{await dbDelete('posts',id)}catch(error){}
      }
    })()`);
    check('vault.encryptDecryptRoundTrip', vaultRoundTrip.skipped || (vaultRoundTrip.ok && vaultRoundTrip.format === 'InternalBeyondEncryptedBackup' && vaultRoundTrip.version === 1), JSON.stringify(vaultRoundTrip));

    check('localFirst.panelMounted', await waitFor(cdp, "!!document.getElementById('ib-local-first-root') && document.getElementById('ib-local-first-root').dataset.mounted==='1' && !!document.getElementById('ib-local-first-save')", 10000));
    const localFirst = await evaluate(cdp, `(async()=>{
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const endpoint='http://127.0.0.1:'+(35000+(Date.now()%10000))+'/v1/chat/completions';
      const model='ui-local-no-key-'+Date.now().toString(36);
      const name='本机回归模型';
      const quiet=document.getElementById('ib-local-first-quiet');
      const originalQuiet=!!quiet.checked;
      const originalQuietStorage=localStorage.getItem('ib_quiet_mode');
      let saved=null,cleaned=false,quietOn=false,quietOff=false,result=null;
      const setValue=(id,value)=>{
        const input=document.getElementById(id);
        input.value=value;
        input.dispatchEvent(new Event('input',{bubbles:true}));
        input.dispatchEvent(new Event('change',{bubbles:true}));
      };
      try{
        setValue('ib-local-first-endpoint',endpoint);
        setValue('ib-local-first-model',model);
        setValue('ib-local-first-name',name);
        document.getElementById('ib-local-first-save').click();
        for(let i=0;i<120;i++){
          const configs=await dbGetAll('apiConfigs');
          saved=configs.find(item=>item&&item.localRuntime&&item.localRuntime.endpoint===endpoint)||null;
          if(saved)break;
          await sleep(25);
        }
        quiet.checked=!originalQuiet;
        quiet.dispatchEvent(new Event('change',{bubbles:true}));
        await sleep(20);
        quietOn=document.documentElement.classList.contains('ib-quiet-mode')===(!originalQuiet)
          && localStorage.getItem('ib_quiet_mode')===(!originalQuiet?'1':'0');
        quiet.checked=originalQuiet;
        quiet.dispatchEvent(new Event('change',{bubbles:true}));
        await sleep(20);
        quietOff=document.documentElement.classList.contains('ib-quiet-mode')===originalQuiet
          && localStorage.getItem('ib_quiet_mode')===(originalQuiet?'1':'0');
        result={saved:!!saved,noKey:saved&&saved.apiKey==='',model:saved&&saved.model===model,endpoint:saved&&saved.endpoint===endpoint,localRuntime:saved&&saved.localRuntime&&saved.localRuntime.endpoint===endpoint,promptCacheOff:saved&&saved.promptCache===false,quietOn,quietOff};
      }catch(error){result={error:String(error&&error.message||error),saved:!!saved,noKey:saved&&saved.apiKey===''};}
      finally{
        try{
          if(saved){await dbDelete('apiConfigs',saved.id);if(typeof _apiFallbackRemove==='function')_apiFallbackRemove(saved.id);}
          if(typeof loadApiConfigs==='function')await loadApiConfigs();
          if(typeof renderApiList==='function')await renderApiList();
          cleaned=!saved||!(await dbGetAll('apiConfigs')).some(item=>item&&item.id===saved.id);
        }catch(error){cleaned=false;}
        try{
          quiet.checked=originalQuiet;
          quiet.dispatchEvent(new Event('change',{bubbles:true}));
          if(originalQuietStorage===null)localStorage.removeItem('ib_quiet_mode');
          else localStorage.setItem('ib_quiet_mode',originalQuietStorage);
        }catch(error){}
      }
      return Object.assign({},result||{}, {cleaned});
    })()`);
    check('localFirst.saveLoopbackNoKey', localFirst.saved && localFirst.noKey && localFirst.model && localFirst.endpoint && localFirst.localRuntime && localFirst.promptCacheOff, JSON.stringify(localFirst));
    check('localFirst.quietModeToggleRestore', localFirst.quietOn && localFirst.quietOff, JSON.stringify(localFirst));
    check('localFirst.testConfigCleanup', localFirst.cleaned, JSON.stringify(localFirst));

    const bootBefore = await evaluate(cdp, 'window.__ibBootCount');
    await evaluate(cdp, 'window.__ibBootFn();window.__ibBootFn()');
    const repeat = await evaluate(cdp, `({
      boot:window.__ibBootCount,
      panels:document.querySelectorAll('#ib-bridge-panel').length,
      navs:document.querySelectorAll('#ib-bridge-nav').length
    })`);
    check('bridge.repeatInitGuard', repeat.boot === bootBefore + 2 && repeat.panels === 1 && repeat.navs === 1, JSON.stringify(repeat));

    const light = await evaluate(cdp, `(()=>{
      document.getElementById('ib-bridge-nav').click();
      const p=document.getElementById('ib-bridge-panel'),s=getComputedStyle(p),r=p.getBoundingClientRect();
      return {open:p.classList.contains('open'),inert:p.inert,hidden:p.getAttribute('aria-hidden'),expanded:document.getElementById('ib-bridge-nav').getAttribute('aria-expanded'),current:document.getElementById('ib-bridge-nav').getAttribute('aria-current'),background:s.backgroundColor,color:s.color,left:r.left,top:r.top,right:r.right,bottom:r.bottom,focus:document.activeElement.id};
    })()`);
    await waitFor(cdp, "document.activeElement && document.activeElement.id==='ib-panel-tab-whisper'", 1500);
    light.focus = await evaluate(cdp, 'document.activeElement.id');
    check('bridge.desktopOpen', light.open && !light.inert && light.hidden === 'false' && light.expanded === 'true' && light.current === 'page', JSON.stringify(light));
    check('bridge.desktopWithinViewport', light.left >= 7 && light.top >= 7 && light.right <= 1433 && light.bottom <= 893, JSON.stringify(light));
    check('bridge.openFocus', light.focus === 'ib-panel-tab-whisper', light.focus);

    await evaluate(cdp, 'toggleTheme()');
    check('theme.liveSwitch', await waitFor(cdp, "document.body.classList.contains('theme-infernal')", 3500));
    await new Promise(resolve => setTimeout(resolve, 650));
    const dark = await evaluate(cdp, `(()=>{const p=document.getElementById('ib-bridge-panel'),s=getComputedStyle(p);return{open:p.classList.contains('open'),background:s.backgroundColor,color:s.color,theme:getComputedStyle(document.body).getPropertyValue('--surface-panel').trim(),body:document.body.className}})()`);
    check('theme.bridgeStaysOpen', dark.open);
    check('theme.bridgeStyleChanged', dark.background !== light.background && dark.color !== light.color, JSON.stringify({ light, dark }));

    await evaluate(cdp, "document.getElementById('ib-panel-close').click()");
    await new Promise(resolve => setTimeout(resolve, 50));
    const closed = await evaluate(cdp, `(()=>{const p=document.getElementById('ib-bridge-panel');return{open:p.classList.contains('open'),inert:p.inert,hidden:p.getAttribute('aria-hidden'),expanded:document.getElementById('ib-bridge-nav').getAttribute('aria-expanded'),focus:document.activeElement.id}})()`);
    check('bridge.closeStateAndFocus', !closed.open && closed.inert && closed.hidden === 'true' && closed.expanded === 'false' && closed.focus === 'ib-bridge-nav', JSON.stringify(closed));

    await evaluate(cdp, `(()=>{const n=document.getElementById('ib-bridge-nav');n.focus();n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`);
    check('bridge.keyboardOpen', await waitFor(cdp, "document.getElementById('ib-bridge-panel').classList.contains('open')", 1000));
    await evaluate(cdp, `(()=>{const b=document.getElementById('ib-panel-tab-whisper');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));return true})()`);
    const tabs = await evaluate(cdp, `({
      selected:document.getElementById('ib-panel-tab-board').getAttribute('aria-selected'),
      focus:document.activeElement.id,
      boardHidden:document.getElementById('ib-tab-board').getAttribute('aria-hidden'),
      whisperHidden:document.getElementById('ib-tab-whisper').getAttribute('aria-hidden')
    })`);
    check('a11y.bridgeArrowTabs', tabs.selected === 'true' && tabs.focus === 'ib-panel-tab-board' && tabs.boardHidden === 'false' && tabs.whisperHidden === 'true', JSON.stringify(tabs));

    await evaluate(cdp, "navTo('guide')");
    const routed = await evaluate(cdp, `({
      bridgeOpen:document.getElementById('ib-bridge-panel').classList.contains('open'),
      guideActive:document.querySelector('[data-page="guide"]').classList.contains('active'),
      guideCurrent:document.querySelector('[data-page="guide"]').getAttribute('aria-current'),
      page:document.getElementById('page-guide').classList.contains('active')
    })`);
    check('navigation.routeClosesBridge', !routed.bridgeOpen && routed.guideActive && routed.guideCurrent === 'page' && routed.page, JSON.stringify(routed));

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(cdp, `(()=>{const n=document.getElementById('ib-bridge-nav');n.scrollIntoView({inline:'center',block:'nearest'});n.click();return true})()`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const mobile = await evaluate(cdp, `(()=>{const p=document.getElementById('ib-bridge-panel'),r=p.getBoundingClientRect(),nr=document.getElementById('navbar').getBoundingClientRect();return{open:p.classList.contains('open'),left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewport:[innerWidth,innerHeight],navHeight:nr.height,navCssHeight:getComputedStyle(document.getElementById('navbar')).height,mobileMedia:matchMedia('(max-width:768px)').matches,scrollWidth:document.documentElement.scrollWidth}})()`);
    check('bridge.mobileOpen', mobile.open);
    check('bridge.mobileWithinViewport', mobile.left >= 7 && mobile.top >= 7 && mobile.right <= 383 && mobile.bottom <= 837, JSON.stringify(mobile));
    check('layout.mobileNavbarHeight', mobile.navHeight <= 42, JSON.stringify(mobile));

    const bridgeNames = await evaluate(cdp, `(()=>[...document.querySelectorAll('#ib-bridge-panel button')].filter(b=>{
      const name=(b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim();return !name;
    }).length)()`);
    check('a11y.bridgeControlsNamed', bridgeNames === 0, String(bridgeNames));
    check('runtime.noJsErrors', runtimeErrors.length === 0, runtimeErrors.join(' | '));
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }

  console.log(failures ? `\nUI regression failed: ${failures}` : '\nUI regression passed ✔');
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error('UI regression crashed:', error && error.stack || error);
  process.exit(1);
});
