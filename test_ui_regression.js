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
    check('assets.externalStylesLoaded', structure.styles === 20, String(structure.styles));
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

    const roleGroups = await evaluate(cdp, `(async()=>{
      const ids=Array.from({length:12},(_,i)=>'role_group_smoke_'+i);
      const now=Date.now();
      const configs=ids.map((id,i)=>({id,nickname:'Role '+i,provider:'custom',apiKey:'key-'+i,model:'model-'+i,endpoint:'http://127.0.0.1:1/v1/chat/completions',systemPrompt:'prompt-'+i,relationship:'relation-'+i,autoMem:i%2===0,voice:{enabled:true,voiceId:'voice-'+i,rate:1+i/10},activeMessage:{interval:i+1},avatar:'avatar-'+i,created:now+i}));
      const memories=ids.map((id,i)=>({id:'role_group_memory_'+i,friendId:id,content:'memory-'+i,created:now+i}));
      const groupIds=[];
      const putGroup=(id,members)=>{groupIds.push(id);return dbPut('groups',{id,name:id,members:members.map(characterId=>({characterId,status:'active',joinedAt:now})),memoryEnabled:true,created:now})};
      try{
        for(const cfg of configs)await dbPut('apiConfigs',cfg);
        for(const memory of memories)await dbPut('autoMemory',memory);
        await loadApiConfigs();
        const before=await dbGetAll('apiConfigs');
        const beforeMemory=await dbGetAll('autoMemory');
        const independent=before.filter(x=>ids.includes(x.id)).length===12
          &&before.filter(x=>ids.includes(x.id)).every(x=>{const i=Number(x.id.slice('role_group_smoke_'.length));return x.systemPrompt==='prompt-'+i&&x.voice.voiceId==='voice-'+i&&x.model==='model-'+i&&x.relationship==='relation-'+i&&x.avatar==='avatar-'+i})
          &&beforeMemory.filter(x=>ids.includes(x.friendId)).length===12
          &&beforeMemory.every(x=>!ids.includes(x.friendId)||x.content==='memory-'+Number(x.friendId.slice('role_group_smoke_'.length)));
        createGroup();
        const items=Array.from(document.querySelectorAll('#group-api-list .group-api-item'));
        items.slice(0,10).forEach(item=>item.click());
        const pickedBefore=window._groupSelectOrder.length;
        if(items[10])items[10].click();
        const pickedAfter=window._groupSelectOrder.length;
        document.getElementById('group-name-input').value='Role group one';
        await confirmCreateGroup();
        const created=(await dbGetAll('groups')).filter(g=>g.name==='Role group one').pop();
        if(created)groupIds.push(created.id);
        const groupOneCount=created&&created.members.length;
        const groupOneRefsOnly=created&&created.members.every(m=>Object.keys(m).every(k=>['characterId','status','joinedAt'].includes(k)));
        const secondId='role_group_smoke_second';
        await putGroup(secondId,[ids[0],ids[10]]);
        const added=await addGroupMember(secondId,ids[11]);
        const rejected=created&&await addGroupMember(created.id,ids[10]);
        createGroup();
        filterGroupRolePicker('Role 11');
        const searchMatches=Array.from(document.querySelectorAll('#group-api-list .group-api-item')).map(x=>x.textContent.trim());
        closeGroupDialog();
        const groups=await dbGetAll('groups');
        const deleted=await _hardDeleteApiConfig(ids[0]);
        const afterGroups=await dbGetAll('groups');
        const afterMemory=await dbGetAll('autoMemory');
        return {roleCount:before.filter(x=>ids.includes(x.id)).length,independent,pickedBefore,pickedAfter,groupOneCount,groupOneRefsOnly,added:!!(added&&added.ok),differentGroup:groups.some(g=>g.id===secondId&&g.members.some(m=>m.characterId===ids[0])),maxRejected:!!(rejected&&!rejected.ok),searchMatches,deleted,deletedRef:afterGroups.every(g=>!g.members.some(m=>m.characterId===ids[0])),deletedMemory:!afterMemory.some(x=>x.friendId===ids[0])};
      }finally{
        for(const gid of groupIds){try{await dbDelete('groups',gid);for(const m of await dbGetByIndex('chatMessages','byFriend',gid))await dbDelete('chatMessages',m.id)}catch(e){}}
        for(const cfg of configs.slice(1)){try{await dbDelete('apiConfigs',cfg.id);if(typeof _apiFallbackRemove==='function')_apiFallbackRemove(cfg.id)}catch(e){}}
        for(const memory of memories.slice(1)){try{await dbDelete('autoMemory',memory.id)}catch(e){}}
        await loadApiConfigs();
      }
    })()`);
    check('roles.largeLibrary', roleGroups.roleCount === 12 && roleGroups.independent, JSON.stringify(roleGroups));
    check('groups.keepExistingMemberLimit', roleGroups.pickedBefore === 10 && roleGroups.pickedAfter === 10 && roleGroups.groupOneCount === 10 && roleGroups.maxRejected, JSON.stringify(roleGroups));
    check('groups.independentCombinationsAndSharedRoles', roleGroups.added && roleGroups.differentGroup, JSON.stringify(roleGroups));
    check('groups.searchRolePicker', roleGroups.searchMatches.length === 1 && roleGroups.searchMatches[0].includes('Role 11'), JSON.stringify(roleGroups));
    check('roles.deleteRemovesGroupReferences', roleGroups.deleted && roleGroups.deletedRef && roleGroups.deletedMemory, JSON.stringify(roleGroups));

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

    /* ── VoiceClone Reference Audio UI（第三阶段 B1）：真实 Bridge + 编辑器上传 / 保存 / 回归 ── */
    const voiceBridgePort = await freePort();
    const voiceDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-voice-ui-'));
    const voiceBridge = spawn(process.execPath, [path.join(__dirname, 'ib-bridge-service.js')], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { IB_BRIDGE_PORT: String(voiceBridgePort), IB_BRIDGE_HOST: '127.0.0.1', IB_BRIDGE_DATA_DIR: voiceDataDir }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    voiceBridge.stdout.on('data', () => {});
    voiceBridge.stderr.on('data', () => {});
    let voiceBridgeReady = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch('http://127.0.0.1:' + voiceBridgePort + '/health')).ok) { voiceBridgeReady = true; break; } } catch (error) { /* 启动中 */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    check('voiceBridge.ready', voiceBridgeReady);
    const voiceSavedOldBridge = await evaluate(cdp, 'localStorage.getItem("ib_bridge_http")');
    if (voiceBridgeReady) {
      await evaluate(cdp, 'localStorage.setItem("ib_bridge_http", ' + JSON.stringify('http://127.0.0.1:' + voiceBridgePort) + ')');
      const voiceUi = await evaluate(cdp, `(async()=>{
        const sleep=ms=>new Promise(r=>setTimeout(r,ms));
        const appFetch=(code,opt)=>window.ibBridgeFetch('http://127.0.0.1:${voiceBridgePort}'+code,opt).then(r=>r.json());
        const out={};
        const cleanup=async()=>{
          try{await dbDelete('apiConfigs',out._id);if(typeof _apiFallbackRemove==='function')_apiFallbackRemove(out._id);}catch(e){}
          try{await loadApiConfigs();if(typeof renderApiList==='function')await renderApiList();}catch(e){}
          try{cancelApiEdit();}catch(e){}
        };
        try{
          const id='voice_ui_role_'+Date.now().toString(36);
          out._id=id;
          /* 种子：builtin 音色 + 携带未来字段的 voiceData（兼容铁律测试预置） */
          const seeded={id,nickname:'VoiceClone UI 角色',provider:'custom',apiKey:'k-voice-ui',model:'m-voice-ui',endpoint:'http://127.0.0.1:1/v1/chat/completions',systemPrompt:'p',relationship:'朋友',voice:{enabled:true,provider:'edge',voiceId:'zh-CN-XiaoxiaoNeural',rate:1.0,pitch:'+0Hz',voiceType:'builtin',voiceData:{refAudioId:'abc',futureField:'keep-me'}},created:Date.now()};
          await dbPut('apiConfigs',seeded);
          await loadApiConfigs();
          editApi(id);
          await sleep(120);
          out.editorOpen=!!document.getElementById('api-editor')&&document.getElementById('api-editor').style.display==='block';
          out.builtinRadio=document.getElementById('api-voice-type-builtin').checked;
          /* 打开编辑器（builtin）→ 修改普通字段 → 保存：voiceData.futureField 必须保留 */
          document.getElementById('api-system').value='保存普通字段前修改';
          await saveCurrentApi(null);
          await sleep(120);
          let saved=await dbGet('apiConfigs',id);
          out.plainSaveKeepsFuture=(saved&&saved.voice&&saved.voice.voiceData&&saved.voice.voiceData.futureField==='keep-me')&&saved.voice.voiceType==='builtin';
          /* 切换到 Voice Clone */
          document.getElementById('api-voice-type-clone').checked=true;
          _voiceTypeChange();
          await sleep(80);
          out.clonePanelVisible=document.getElementById('api-voice-clone-panel').style.display!=='none';
          /* B2：builtin-fields 保持可见（由 capability sync 按类型显隐）；此时 provider 行应被隐藏、clone model 下拉显示、Test 不再禁用 */
          out.providerRowHidden=document.getElementById('api-voice-provider-wrap').style.display==='none';
          out.modelShowsClone=document.getElementById('api-voice-model').value==='mimo-v2.5-tts-voiceclone';
          out.testEnabled=!!document.getElementById('api-voice-test-btn')&&!document.getElementById('api-voice-test-btn').disabled;
          /* 真实上传：文件输入（DataTransfer）+ change 事件 → 上传 → 自动绑定 */
          const mp3Bytes=new Uint8Array([0x49,0x44,0x33,0x04,0,0,0,0,0,0,0x01,0x02,0x03,0x04,0x55]);
          const dt=new DataTransfer();dt.items.add(new File([mp3Bytes],'voice-ui.mp3',{type:'audio/mpeg'}));
          const fileInput=document.getElementById('api-voice-clone-file');
          fileInput.files=dt.files;
          fileInput.dispatchEvent(new Event('change',{bubbles:true}));
          let sel=null;
          for(let i=0;i<120;i++){sel=_voiceCloneSelectionGet();if(sel&&sel.refAudioId)break;await sleep(30);}
          out.uploaded=!!(sel&&sel.refAudioId);
          out.uploadName=sel&&sel.name;
          out.uploadSize=sel&&sel.size;
          out.currentLabel=(document.getElementById('api-voice-clone-current')||{}).textContent||'';
          /* 保存 clone → 读回：voiceData 含 refAudioId 且 futureField 保留，无任何二进制字段 */
          await saveCurrentApi(null);
          await sleep(150);
          saved=await dbGet('apiConfigs',id);
          out.savedType=saved&&saved.voice&&saved.voice.voiceType;
          out.savedProv=saved&&saved.voice&&saved.voice.provider;
          out.savedRefId=saved&&saved.voice&&saved.voice.voiceData&&saved.voice.voiceData.refAudioId;
          out.savedMime=saved&&saved.voice&&saved.voice.voiceData&&saved.voice.voiceData.mime;
          out.savedName=saved&&saved.voice&&saved.voice.voiceData&&saved.voice.voiceData.name;
          out.savedSize=saved&&saved.voice&&saved.voice.voiceData&&saved.voice.voiceData.size;
          out.futureField=saved&&saved.voice&&saved.voice.voiceData&&saved.voice.voiceData.futureField;
          const savedJson=JSON.stringify(saved&&saved.voice||{});
          const vd=Object.keys(saved&&saved.voice&&saved.voice.voiceData||{}).sort();
          out.vdKeys=vd.join(',');
          out.noBinaryInConfig=vd.join(',').indexOf('data')===-1&&vd.join(',').indexOf('base64')===-1&&!(/data:|base64/.test(savedJson));
          /* 导出语义：apiConfigs 直出 JSON 即导出，同样无二进制（导出不含音频本体的断言） */
          out.exportJsonNoBinary=!(/data:|base64/.test(savedJson));
          /* 文件确实在 Bridge 上可读（HEAD + 完整字节对比） */
          const refId=out.savedRefId;
          if(refId){
            const headRes=await fetch('http://127.0.0.1:${voiceBridgePort}/api/tts/voices/'+encodeURIComponent(refId),{method:'HEAD'});
            out.headOk=headRes.status===200&&String(headRes.headers.get('content-type')||'').indexOf('audio/mpeg')!==-1;
            const got=await fetch('http://127.0.0.1:${voiceBridgePort}/api/tts/voices/'+encodeURIComponent(refId));
            const gotBuf=new Uint8Array(await got.arrayBuffer());
            out.bytesMatch=got.status===200&&gotBuf.length===mp3Bytes.length&&gotBuf.every((v,i)=>v===mp3Bytes[i]);
          }
          /* 重新打开编辑器：Voice Type 恢复 + 引用展示 */
          editApi(id);
          await sleep(120);
          out.reopenClone=document.getElementById('api-voice-type-clone').checked;
          out.reopenLabel=(document.getElementById('api-voice-clone-current')||{}).textContent||'';
          /* 仍被角色引用 → DELETE 必须被拒绝（服务端引用校验） */
          try{
            const refsReferenced=_ibReferencedRefAudioIds(refId);
            const delRef=await appFetch('/api/tts/voices/'+encodeURIComponent(refId),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({referencedIds:refsReferenced})});
            out.deleteReferencedRejected=delRef&&delRef.ok===false&&/引用/.test(delRef.error||'');
          }catch(e){out.deleteReferencedRejected=false;}
          /* 导入后的 dangling reference 检测：引用不存在文件时必须给出明确状态 */
          try{
            const importCheck=await ibTtsVoiceCheckImport([{id:'x1',voice:{voiceType:'clone',voiceData:{refAudioId:'nonexistent12345'}}},{id:'x2',voice:{voiceType:'builtin',voiceData:{refAudioId:refId}}}]);
            out.danglingDetected=importCheck&&Array.isArray(importCheck.missing)&&importCheck.missing.length===1&&importCheck.missing[0]==='nonexistent12345';
          }catch(e){out.danglingDetected=false;}
          /* 切回 Built-in 并保存（解除引用）→ 删除成功 → HEAD 404 */
          document.getElementById('api-voice-type-builtin').checked=true;
          _voiceTypeChange();
          out.unboundModel=document.getElementById('api-voice-model').value;
          out.unboundProv=document.getElementById('api-voice-provider').value;
          await saveCurrentApi(null);
          await sleep(150);
          saved=await dbGet('apiConfigs',id);
          out.unboundType=saved&&saved.voice&&saved.voice.voiceType;
          out.unboundSavedModel=saved&&saved.voice&&saved.voice.model;
          out.unboundSavedProv=saved&&saved.voice&&saved.voice.provider;
          out.futureFieldAfterUnbound=saved&&saved.voice&&saved.voice.voiceData&&saved.voice.voiceData.futureField;
          try{
            const delFree=await appFetch('/api/tts/voices/'+encodeURIComponent(refId),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({referencedIds:_ibReferencedRefAudioIds()})});
            out.deleteUnboundOk=delFree&&delFree.ok===true;
            const headAfter=await fetch('http://127.0.0.1:${voiceBridgePort}/api/tts/voices/'+encodeURIComponent(refId),{method:'HEAD'});
            out.headAfterDelete=headAfter.status===404;
          }catch(e){out.deleteUnboundOk=false;}
        }catch(error){out.error=String(error&&error.message||error);}
        await cleanup();
        return out;
      })()`);
      check('voiceClone.editorOpenAndBuiltin', voiceUi.editorOpen && voiceUi.builtinRadio, JSON.stringify(voiceUi));
      check('voiceClone.plainSaveKeepsFuture', voiceUi.plainSaveKeepsFuture === true, JSON.stringify(voiceUi));
      check('voiceClone.panelShowsOnSelect', voiceUi.clonePanelVisible && voiceUi.providerRowHidden && voiceUi.modelShowsClone && voiceUi.testEnabled, JSON.stringify(voiceUi));
      check('voiceClone.uploadReal', voiceUi.uploaded && voiceUi.uploadName === 'voice-ui.mp3' && voiceUi.uploadSize === 15, JSON.stringify(voiceUi));
      check('voiceClone.currentLabelShows', /voice-ui\.mp3/.test(voiceUi.currentLabel), voiceUi.currentLabel);
      check('voiceClone.savePersistsRef', voiceUi.savedType === 'clone' && voiceUi.savedRefId && voiceUi.savedMime === 'audio/mpeg' && voiceUi.savedName === 'voice-ui.mp3' && voiceUi.savedSize === 15, JSON.stringify(voiceUi));
      check('voiceClone.futureFieldPreserved', voiceUi.futureField === 'keep-me', JSON.stringify(voiceUi));
      check('voiceClone.noBinaryInConfig', voiceUi.vdKeys === 'futureField,mime,name,refAudioId,size' && voiceUi.noBinaryInConfig && voiceUi.exportJsonNoBinary, JSON.stringify(voiceUi));
      check('voiceClone.bridgeServesBytes', voiceUi.headOk && voiceUi.bytesMatch, JSON.stringify(voiceUi));
      check('voiceClone.reopenRestoresState', voiceUi.reopenClone && /voice-ui\.mp3/.test(voiceUi.reopenLabel || ''), JSON.stringify(voiceUi));
      check('voiceClone.deleteReferencedRejected', voiceUi.deleteReferencedRejected === true, JSON.stringify(voiceUi));
      check('voiceClone.importDanglingDetected', voiceUi.danglingDetected === true, JSON.stringify(voiceUi));
      check('voiceClone.unbindThenDelete', voiceUi.unboundType === 'builtin' && voiceUi.futureFieldAfterUnbound === 'keep-me' && voiceUi.deleteUnboundOk && voiceUi.headAfterDelete, JSON.stringify(voiceUi));
      check('voiceClone.unbindNoDirtyModel', (voiceUi.unboundModel === '' || voiceUi.unboundModel === 'mimo-v2.5-tts') && voiceUi.unboundSavedModel !== 'mimo-v2.5-tts-voiceclone' && voiceUi.unboundSavedModel !== 'mimo-v2.5-tts-voicedesign', JSON.stringify(voiceUi));
      /* 保存为 Clone 后重开编辑器再切回 Built-in：provider 保持与已保存配置一致（clone 保存时已合法写为 mimo），
         不产生额外漂移；模型不得残留专用 model（in-session 强制恢复由 voiceTypeChange 记忆机制保证，见独立验收）。 */
      check('voiceClone.unbindProviderConsistent', voiceUi.unboundSavedProv === voiceUi.savedProv && voiceUi.savedProv === 'mimo', JSON.stringify(voiceUi));
    }
    /* 恢复桥接地址（无论 Bridge 是否就绪） */
    await evaluate(cdp, voiceSavedOldBridge === null
      ? 'localStorage.removeItem("ib_bridge_http")'
      : 'localStorage.setItem("ib_bridge_http", ' + JSON.stringify(voiceSavedOldBridge) + ')');
    voiceBridge.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(voiceDataDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }

    /* ── MiMo VoiceClone UI（第三阶段 B2）：真实 Bridge + mock VoiceClone 端点 ── */
    let cloneReq = null;
    const mockClone = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        cloneReq = { method: req.method, url: req.url, headers: { apiKey: req.headers['api-key'] || '', auth: req.headers.authorization || '' }, body: JSON.parse(body || '{}') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from('VCLONE_AUDIO').toString('base64'), id: 'vid1' } } }] }));
      });
    });
    const mockPort = await new Promise(r => { mockClone.listen(0, '127.0.0.1', () => r(mockClone.address().port)); });
    const cloneDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-clone-ui-'));
    const cloneBridgePort = await freePort();
    fs.writeFileSync(path.join(cloneDataDir, 'config.json'), JSON.stringify({ ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:' + mockPort + '/v1/chat/completions', apiKey: 'vc-key', voice: '' } }), 'utf8');
    const cloneBridge = spawn(process.execPath, [path.join(__dirname, 'ib-bridge-service.js')], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { IB_BRIDGE_PORT: String(cloneBridgePort), IB_BRIDGE_HOST: '127.0.0.1', IB_BRIDGE_DATA_DIR: cloneDataDir }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    cloneBridge.stdout.on('data', () => {});
    cloneBridge.stderr.on('data', () => {});
    let cloneReady = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch('http://127.0.0.1:' + cloneBridgePort + '/health')).ok) { cloneReady = true; break; } } catch (error) { /* 启动中 */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    check('voiceCloneBridge.ready', cloneReady);
    if (cloneReady) {
      await evaluate(cdp, 'localStorage.setItem("ib_bridge_http", ' + JSON.stringify('http://127.0.0.1:' + cloneBridgePort) + ')');
      const cloneUi = await evaluate(cdp, `(async()=>{
        const sleep=ms=>new Promise(r=>setTimeout(r,ms));
        const out={};
        try{
          addNewApi();
          await sleep(100);
          document.getElementById('api-voice-toggle').checked=true; _voiceToggleDetail();
          document.getElementById('api-voice-provider').value='mimo'; _voiceToggleDetail();
          document.getElementById('api-voice-type-clone').checked=true; _voiceTypeChange();
          await sleep(80);
          out.clonePanel=document.getElementById('api-voice-clone-panel').style.display!=='none';
          out.modelClone=document.getElementById('api-voice-model').value;
          out.providerForcedMimo=document.getElementById('api-voice-provider').value;
          const bytes=new Uint8Array([0x49,0x44,0x33,0x04,0,0,0,0,0,0,0x01,0x02,0x03,0x04,0x55]);
          const dt=new DataTransfer();dt.items.add(new File([bytes],'vc-ui.mp3',{type:'audio/mpeg'}));
          const fi=document.getElementById('api-voice-clone-file');fi.files=dt.files;fi.dispatchEvent(new Event('change',{bubbles:true}));
          let sel=null;for(let i=0;i<120;i++){sel=_voiceCloneSelectionGet();if(sel&&sel.refAudioId)break;await sleep(30);}
          out.refAudioId=sel&&sel.refAudioId;
          document.getElementById('api-voice-test-btn').click();
          out.clickedTest=true;
          const vc={provider:'mimo',voiceId:'',rate:1.0,pitch:'+0Hz',model:document.getElementById('api-voice-model').value,language:'',style:'',voiceType:'clone',voiceData:sel};
          const j=await fetch('http://127.0.0.1:${cloneBridgePort}/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(IB.bridge.ttsPayload(vc,'你好，我是克隆音色。'))}).then(r=>r.json()).catch(e=>({error:String(e&&e.message||e)}));
          out.ttsOk=!!(j&&j.ok)&&typeof j.url==='string';
          out.ttsUrl=!!(j&&j.url);
        }catch(error){out.error=String(error&&error.message||error);}
        try{cancelApiEdit();}catch(e){}
        return out;
      })()`);
      check('voiceCloneUi.panelAndModel', cloneUi.clonePanel && cloneUi.modelClone === 'mimo-v2.5-tts-voiceclone' && cloneUi.providerForcedMimo === 'mimo', JSON.stringify(cloneUi));
      check('voiceCloneUi.upload', !!cloneUi.refAudioId, JSON.stringify(cloneUi));
      check('voiceCloneUi.ttsRequestOk', cloneUi.ttsOk && cloneUi.ttsUrl, JSON.stringify(cloneUi));
      const shapeOk = cloneReq && cloneReq.method === 'POST' && cloneReq.url.indexOf('/v1/chat/completions') > -1
        && cloneReq.body.model === 'mimo-v2.5-tts-voiceclone'
        && cloneReq.body.audio && cloneReq.body.audio.format === 'mp3'
        && typeof cloneReq.body.audio.voice === 'string' && cloneReq.body.audio.voice.indexOf('data:audio/mpeg;base64,') === 0
        && Array.isArray(cloneReq.body.messages) && cloneReq.body.messages.filter(m => m.role === 'assistant').some(m => m.content === '你好，我是克隆音色。')
        && cloneReq.headers.apiKey === 'vc-key';
      check('voiceCloneUi.mockRequestShape', shapeOk, JSON.stringify(cloneReq && cloneReq.body));
    } else {
      await evaluate(cdp, voiceSavedOldBridge === null ? 'localStorage.removeItem("ib_bridge_http")' : 'localStorage.setItem("ib_bridge_http", ' + JSON.stringify(voiceSavedOldBridge) + ')');
    }
    cloneBridge.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(cloneDataDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
    await new Promise(r => mockClone.close(r));

    /* ── MiMo Voice Design UI（第三阶段 C）：真实 Bridge + mock Voice Design 端点 ── */
    let designReq = null;
    const mockDesign = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        designReq = { method: req.method, url: req.url, headers: { apiKey: req.headers['api-key'] || '', auth: req.headers.authorization || '' }, body: JSON.parse(body || '{}') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from('VDESIGN_AUDIO').toString('base64'), id: 'vid9' } } }] }));
      });
    });
    const designMockPort = await new Promise(r => { mockDesign.listen(0, '127.0.0.1', () => r(mockDesign.address().port)); });
    const designDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-design-ui-'));
    const designBridgePort = await freePort();
    fs.writeFileSync(path.join(designDataDir, 'config.json'), JSON.stringify({ ttsMimo: { enabled: true, endpoint: 'http://127.0.0.1:' + designMockPort + '/v1/chat/completions', apiKey: 'vd-key', voice: '' } }), 'utf8');
    const designBridge = spawn(process.execPath, [path.join(__dirname, 'ib-bridge-service.js')], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { IB_BRIDGE_PORT: String(designBridgePort), IB_BRIDGE_HOST: '127.0.0.1', IB_BRIDGE_DATA_DIR: designDataDir }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    designBridge.stdout.on('data', () => {});
    designBridge.stderr.on('data', () => {});
    let designReady = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch('http://127.0.0.1:' + designBridgePort + '/health')).ok) { designReady = true; break; } } catch (error) { /* 启动中 */ }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    check('voiceDesignBridge.ready', designReady);
    if (designReady) {
      await evaluate(cdp, 'localStorage.setItem("ib_bridge_http", ' + JSON.stringify('http://127.0.0.1:' + designBridgePort) + ')');
      const designUi = await evaluate(cdp, `(async()=>{
        const sleep=ms=>new Promise(r=>setTimeout(r,ms));
        const out={};
        const cleanup=async()=>{try{await dbDelete('apiConfigs',out._id);if(typeof _apiFallbackRemove==='function')_apiFallbackRemove(out._id);}catch(e){}try{await loadApiConfigs();if(typeof renderApiList==='function')await renderApiList();}catch(e){}try{cancelApiEdit();}catch(e){}};
        try{
          /* 开新角色 → 直接切到 Design */
          addNewApi();
          await sleep(100);
          out._id=editingApiId;
          document.getElementById('api-voice-toggle').checked=true; _voiceToggleDetail();
          document.getElementById('api-voice-type-design').checked=true; _voiceTypeChange();
          await sleep(80);
          out.providerForcedMimo=document.getElementById('api-voice-provider').value;
          out.modelDesign=document.getElementById('api-voice-model').value;
          out.providerRowHidden=document.getElementById('api-voice-provider-wrap').style.display==='none';
          out.builtinVoiceHidden=document.getElementById('api-voice-select-wrap').style.display==='none' && document.getElementById('api-voice-id-wrap').style.display==='none';
          out.clonePanelHidden=document.getElementById('api-voice-clone-panel').style.display==='none';
          const styleLabel=document.querySelector('#api-voice-style-wrap .ibv-label');
          out.styleLabel=(styleLabel&&styleLabel.textContent)||'';
          out.testEnabled=!document.getElementById('api-voice-test-btn').disabled;
          /* 填入音色描述并保存 */
          const desc='一位年迈的先生，嗓音略带沙哑与沧桑感，语速缓慢而沉稳。';
          document.getElementById('api-voice-style').value=desc;
          document.getElementById('api-ai-name').value='设计音色角色';
          await saveCurrentApi(null);
          await sleep(150);
          let saved=await dbGet('apiConfigs',out._id);
          out.savedType=saved&&saved.voice&&saved.voice.voiceType;
          out.savedStyle=saved&&saved.voice&&saved.voice.style;
          out.savedModel=saved&&saved.voice&&saved.voice.model;
          /* 重开编辑器：Design 恢复 + 描述回填 */
          editApi(out._id);
          await sleep(120);
          out.reopenDesign=document.getElementById('api-voice-type-design').checked;
          out.reopenDesc=document.getElementById('api-voice-style').value;
          /* Test Voice：真实 /api/tts → mock 捕获 design shape */
          out.clicksTest=(function(){try{document.getElementById('api-voice-test-btn').click();return true;}catch(e){return false;}})();
          /* 直接 fetch 同一 payload 拿到确定结果 */
          const vc={provider:'mimo',voiceId:'',rate:1.0,pitch:'+0Hz',model:document.getElementById('api-voice-model').value,language:'',style:desc,voiceType:'design',voiceData:null};
          const j=await fetch('http://127.0.0.1:${designBridgePort}/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(IB.bridge.ttsPayload(vc,'你好，设计音色朗读测试。'))}).then(r=>r.json()).catch(e=>({error:String(e&&e.message||e)}));
          out.ttsOk=!!(j&&j.ok)&&typeof j.url==='string';
        }catch(error){out.error=String(error&&error.message||error);}
        await cleanup();
        return out;
      })()`);
      check('voiceDesignUi.vtypeModelProvider', designUi.providerForcedMimo === 'mimo' && designUi.modelDesign === 'mimo-v2.5-tts-voicedesign' && designUi.providerRowHidden && designUi.builtinVoiceHidden && designUi.clonePanelHidden, JSON.stringify(designUi));
      check('voiceDesignUi.styleLabel', /Voice Design 描述/.test(designUi.styleLabel || ''), designUi.styleLabel);
      check('voiceDesignUi.testEnabled', designUi.testEnabled === true, JSON.stringify(designUi));
      check('voiceDesignUi.saveRestores', designUi.savedType === 'design' && designUi.savedStyle === '一位年迈的先生，嗓音略带沙哑与沧桑感，语速缓慢而沉稳。' && designUi.savedModel === 'mimo-v2.5-tts-voicedesign', JSON.stringify(designUi));
      check('voiceDesignUi.reopen', designUi.reopenDesign && /沙哑与沧桑感/.test(designUi.reopenDesc || ''), JSON.stringify(designUi));
      check('voiceDesignUi.ttsRequestOk', designUi.ttsOk, JSON.stringify(designUi));
      const dShapeOk = designReq && designReq.method === 'POST' && designReq.url.indexOf('/v1/chat/completions') > -1
        && designReq.body.model === 'mimo-v2.5-tts-voicedesign'
        && designReq.body.audio && designReq.body.audio.format === 'mp3' && typeof designReq.body.audio.voice === 'undefined'
        && Array.isArray(designReq.body.messages) && designReq.body.messages[0].role === 'user' && designReq.body.messages[0].content === '一位年迈的先生，嗓音略带沙哑与沧桑感，语速缓慢而沉稳。'
        && designReq.body.messages[1] && designReq.body.messages[1].role === 'assistant' && designReq.body.messages[1].content === '你好，设计音色朗读测试。'
        && designReq.headers.apiKey === 'vd-key';
      check('voiceDesignUi.mockRequestShape', dShapeOk, JSON.stringify(designReq && designReq.body));
    } else {
      await evaluate(cdp, voiceSavedOldBridge === null ? 'localStorage.removeItem("ib_bridge_http")' : 'localStorage.setItem("ib_bridge_http", ' + JSON.stringify(voiceSavedOldBridge) + ')');
    }
    designBridge.kill();
    await new Promise(resolve => setTimeout(resolve, 300));
    try { fs.rmSync(designDataDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
    await new Promise(r => mockDesign.close(r));

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
