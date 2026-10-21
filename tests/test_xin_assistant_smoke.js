'use strict';

/* Xin acceptance smoke: isolated Chrome profile + callApiChat mock; never reaches a real Provider. */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const WEB = require(path.join(ROOT, 'services', 'internal-beyond-server.js'));
const bootState = require(path.join(ROOT, 'runtime', 'boot-state.js'));
const { ev, launchBrowser, sleep, wait } = require(path.join(ROOT, 'scripts', 'cdp-lite.js'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function writeLaunchRecord(dir, port) {
  bootState.writeBootState(bootState.buildBootState({
    bootId: bootState.newBootId(Date.now()), now: Date.now(), phase: 'complete', opened: true,
    launcher: { pid: process.pid, startedAt: Date.now() - 3000, finishedAt: Date.now(), root: ROOT,
      platform: process.platform, arch: process.arch, node: { path: process.execPath, version: process.version,
        source: 'bundled', bundled: true, requiredMajor: 18, ok: true },
      serviceManager: { state: 'up', wasRunning: false, started: false, error: null } },
    components: {
      static: { required: true, affectsOverall: true, probed: true, healthy: true, state: 'healthy', port },
      bridge: { required: false, affectsOverall: true, probed: true, healthy: false, state: 'offline' },
      active: { required: false, affectsOverall: true, probed: true, healthy: false, state: 'offline' },
      restart: { required: false, affectsOverall: false, probed: true, healthy: false, state: 'offline' },
      vision: { required: false, affectsOverall: false, probed: false, healthy: false, state: 'not-enabled' }
    }, warnings: []
  }), { dir });
}

let browser, cdp, webServer, bootDir;
(async function main() {
  bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-xin-boot-'));
  process.env.IB_BOOT_STATE_DIR = bootDir;
  webServer = WEB.createWebServer({ port: 0, root: ROOT });
  const port = await new Promise((resolve, reject) => {
    webServer.once('error', reject);
    webServer.listen(0, '127.0.0.1', () => resolve(webServer.address().port));
  });
  writeLaunchRecord(bootDir, port);
  browser = await launchBrowser({ width: 1440, height: 900, profilePrefix: 'ib-xin-chrome-' });
  cdp = await browser.open('http://127.0.0.1:' + port + '/InternalBeyond.html');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', event => pageErrors.push(String((event.exceptionDetails && event.exceptionDetails.text) || 'exception')));
  await wait(cdp, "document.readyState!=='loading' && !!document.querySelector('.splash-action-btn')", 30000);
  await ev(cdp, "(function(){var b=Array.prototype.filter.call(document.querySelectorAll('.splash-action-btn'),function(x){return x.textContent.indexOf('查看说明')!==-1})[0]||document.querySelector('.splash-action-btn');if(b)b.click();return true})()");
  await wait(cdp, "!!window.IBXin && !!document.getElementById('xin-launcher')", 30000);
  await wait(cdp, "!!document.getElementById('app') && document.getElementById('app').classList.contains('visible')", 30000);
  await wait(cdp, "(function(){var s=document.getElementById('splash');if(!s)return true;var cs=getComputedStyle(s);return cs.visibility==='hidden'||Number(cs.opacity)===0})()", 20000);
  await wait(cdp, "getComputedStyle(document.getElementById('preloader')).visibility==='hidden'", 30000);

  async function dismissOverlays() {
    await ev(cdp, "(function(){try{if(window.IBSetup&&typeof IBSetup.skip==='function'&&document.getElementById('ib-setup')&&document.getElementById('ib-setup').classList.contains('is-open'))IBSetup.skip()}catch(e){}var g=document.getElementById('ib-guard-overlay');if(g){var b=Array.prototype.filter.call(g.querySelectorAll('button'),function(x){return x.textContent.indexOf('无视')!==-1})[0];if(b)b.click()}return true})()");
  }
  await dismissOverlays();
  await wait(cdp, "!document.getElementById('splash') || getComputedStyle(document.getElementById('splash')).visibility==='hidden' || Number(getComputedStyle(document.getElementById('splash')).opacity)===0", 30000);

  const seed = await ev(cdp, `(async function(){
    var cfg={id:'xin_smoke_mock',nickname:'Xin Mock',provider:'openai',model:'mock-model',endpoint:'https://mock.provider.invalid/v1/chat/completions',credentialRef:'xin_smoke_mock',temperature:1,streaming:true,thinkingEnabled:false,promptCache:false};
    await window._persistApiConfig(cfg);
    await window.loadApiConfigs();
    window.__xinMockReplies=[];window.__xinMockCalls=[];window.__xinCredentialResolves=[];window.__xinVaultWrites=[];window.__xinStoreWrites=[];
    var originalDbPut=window.dbPut;
    if(typeof originalDbPut==='function')window.dbPut=function(store){var name=String(store||'');if(['chatMessages','chatThreads','memories','autoMemory'].indexOf(name)>=0)window.__xinStoreWrites.push(name);return originalDbPut.apply(this,arguments)};
    var host=Object.assign({},window.IB.host||{});
    host.credentialResolver={available:true,resolve:async function(id){
      id=String(id);window.__xinCredentialResolves.push(id);var provider='openai';
      if(id==='xin_model_v1'){var independent=await dbGet('apiSettings','xinModelConfig');if(independent&&independent.provider)provider=independent.provider}
      else{var role=(window.apiConfigs||[]).filter(function(x){return x&&(x.credentialRef===id||x.id===id)})[0];if(role&&role.provider)provider=role.provider}
      if(window.__xinCredentialFailure)return {ok:false,errorCode:'CREDENTIAL_UNAVAILABLE'};
      return {ok:true,provider:provider,apiKey:'xin-test-only-mock-secret'};
    }};
    window.IB.host=host;
    window._ibWriteVaultCredential=async function(ref,meta,key){window.__xinVaultWrites.push({ref:String(ref),provider:String(meta&&meta.provider||''),endpoint:String(meta&&meta.endpoint||''),model:String(meta&&meta.model||''),keyPassed:!!String(key||'')});return String(ref)};
    window.__xinCredentialFailure=false;window.__xinMockProviderStatus=200;
    var originalFetch=window.fetch;
    window.fetch=async function(url,options){
      if(String(url)==='https://mock.provider.invalid/v1/chat/completions'){
        var body=JSON.parse(String(options&&options.body||'{}'));
        var encoded=String(options&&options.body||'');
        var headers=options&&options.headers||{};
        window.__xinMockCalls.push({url:String(url),model:body.model,authorizationPresent:!!(headers.Authorization||headers.authorization),mockSecretInBody:encoded.indexOf('xin-test-only-mock-secret')>=0,toolsDisabled:!body.tools,webSearchDisabled:!body.web_search_options,chatSentinelIncluded:encoded.indexOf('HIDDEN_CHAT_SENTINEL')>=0});
        if(window.__xinMockProviderStatus!==200)return new Response(JSON.stringify({error:{message:'synthetic unauthorized'}}),{status:Number(window.__xinMockProviderStatus)||401,headers:{'Content-Type':'application/json'}});
        var reply=window.__xinMockReplies.shift()||JSON.stringify({reply:'mock reply',actions:[]});
        return new Response(JSON.stringify({choices:[{message:{content:reply}}],usage:{prompt_tokens:24,completion_tokens:9}}),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return originalFetch.call(this,url,options);
    };
    return {loader:typeof window.loadApiConfigs,roles:(window.apiConfigs||[]).map(function(x){return x.id})};
  })()`);
  check('mock role API is available through the normal config catalog', seed && seed.roles && seed.roles.indexOf('xin_smoke_mock') >= 0, seed);

  await ev(cdp, 'window.IBXin.open()');
  await ev(cdp, "document.getElementById('xin-source').click()");
  await wait(cdp, "Array.prototype.some.call(document.querySelectorAll('.xin-api-option'),function(x){return x.textContent.indexOf('Xin Mock')>=0})", 10000);
  await ev(cdp, "Array.prototype.filter.call(document.querySelectorAll('.xin-api-option'),function(x){return x.textContent.indexOf('Xin Mock')>=0})[0].click()");
  await wait(cdp, "document.getElementById('xin-source').textContent.indexOf('Xin Mock')>=0", 5000);
  check('API picker uses the existing role API without showing a key', await ev(cdp, "document.getElementById('xin-source').textContent.indexOf('Xin Mock')>=0 && !document.getElementById('xin-drawer').textContent.match(/sk-[A-Za-z0-9_-]{8,}/)"));
  if (process.env.XIN_PREVIEW_DIR) {
    fs.mkdirSync(process.env.XIN_PREVIEW_DIR, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(process.env.XIN_PREVIEW_DIR, 'xin-desktop-1440-internal.png'), Buffer.from(shot.data, 'base64'));
  }

  const providerBeforeGuide = await ev(cdp, "({requests:window.__xinMockCalls.length,resolves:window.__xinCredentialResolves.length})");
  await ev(cdp, `window.__xinMockReplies.push(${JSON.stringify(JSON.stringify({ reply: '角色 API 设置在 Characters & API 页面。', actions: [{ type: 'open', page: 'api' }] }))})`);
  await ev(cdp, "window.IBXin.send('角色 API 设置在哪里？')");
  const authEvidence = await ev(cdp, "(function(){var calls=window.__xinMockCalls.slice(" + providerBeforeGuide.requests + "),refs=window.__xinCredentialResolves.slice(" + providerBeforeGuide.resolves + "),c=calls[calls.length-1];return {requestDelta:calls.length,resolveDelta:refs.length,binding:refs[refs.length-1],model:c&&c.model,authorization:c&&c.authorizationPresent,secretInBody:c&&c.mockSecretInBody,toolsDisabled:c&&c.toolsDisabled,webSearchDisabled:c&&c.webSearchDisabled,chatSentinel:c&&c.chatSentinelIncluded}})()");
  check('GUIDE question uses CredentialResolver and the local mock Provider safely', authEvidence && authEvidence.resolveDelta===1 && authEvidence.binding==='xin_smoke_mock' && authEvidence.requestDelta===1 && authEvidence.model==='mock-model' && authEvidence.authorization && !authEvidence.secretInBody && authEvidence.toolsDisabled && authEvidence.webSearchDisabled && !authEvidence.chatSentinel, authEvidence);
  check('page jump appears as a user-clickable action', await ev(cdp, "!!Array.prototype.filter.call(document.querySelectorAll('.xin-jump'),function(x){return x.textContent.indexOf('打开')>=0})[0]"));
  await ev(cdp, "document.querySelector('.xin-jump').click()");
  check('page jump uses navTo and opens the existing API page', await wait(cdp, "document.getElementById('page-api').classList.contains('active')", 5000));

  await ev(cdp, 'window.IBXin.open()');
  await ev(cdp, `window.__xinMockReplies.push(${JSON.stringify(JSON.stringify({ reply: '已把角色 API 的流式回复关闭。', actions: [{ type: 'set_role', roleRef: 'r1', field: 'streaming', value: false }] }))})`);
  await ev(cdp, "window.IBXin.send('把 Xin Mock 的流式回复关闭')");
  check('role-scoped setting changed and old/new values are shown', await ev(cdp, "(async function(){await loadApiConfigs();var c=apiConfigs.filter(function(x){return x.id==='xin_smoke_mock'})[0];return !!c&&!c.streaming&&Array.prototype.some.call(document.querySelectorAll('.xin-action-values'),function(x){return x.textContent.indexOf('开启 → 关闭')>=0})})()"));
  await ev(cdp, "Array.prototype.filter.call(document.querySelectorAll('.xin-undo'),function(x){return !!x})[0].click()");
  await wait(cdp, "(async function(){await loadApiConfigs();var c=apiConfigs.filter(function(x){return x.id==='xin_smoke_mock'})[0];return !!c&&c.streaming===true})()", 10000);
  check('individual role setting can be undone', await wait(cdp, "Array.prototype.some.call(document.querySelectorAll('.xin-undone'),function(x){return x.textContent==='已撤销'})", 5000));

  const settingsCallsBefore = await ev(cdp, 'window.__xinMockCalls.length');
  await ev(cdp, "window.IBXin.send('设置清单')");
  check('settings list is local and includes global and role settings', await wait(cdp, "(function(){var a=document.querySelectorAll('.xin-message.is-assistant');var t=a.length?a[a.length-1].textContent:'';return t.indexOf('现在能直接改的设置')>=0&&t.indexOf('自动续写轮数')>=0&&t.indexOf('流式回复')>=0&&window.__xinMockCalls.length===" + settingsCallsBefore + "})()", 10000));

  await ev(cdp, `window.__xinMockReplies.push(${JSON.stringify(JSON.stringify({ reply: '续写轮数已更新。', actions: [{ type: 'set_global', key: 'output.maxContinues', value: 6 }] }))})`);
  await ev(cdp, "window.IBXin.send('把自动续写轮数改成 6')");
  check('global setting changed through the existing output settings API', await ev(cdp, "(async function(){var r=await dbGet('apiSettings','outputSettings');return Number(r&&r.maxContinues)===6})()"));
  await ev(cdp, "Array.prototype.filter.call(document.querySelectorAll('.xin-undo'),function(x){return !!x})[0].click()");
  await wait(cdp, "(async function(){var r=await dbGet('apiSettings','outputSettings');return Number(r&&r.maxContinues)===3})()", 10000);
  check('global setting can be undone independently', await ev(cdp, "document.querySelectorAll('.xin-undone').length>=2"));

  await ev(cdp, `window.__xinMockReplies.push(${JSON.stringify(JSON.stringify({ reply: '已关闭自动续写。', actions: [{ type: 'set_global', key: 'output.maxContinues', value: 0 }] }))})`);
  await ev(cdp, "window.IBXin.send('把自动续写轮数设为 0')");
  check('documented zero value disables automatic continuation', await ev(cdp, "(async function(){var r=await dbGet('apiSettings','outputSettings');return Number(r&&r.maxContinues)===0})()"));
  await ev(cdp, "Array.prototype.filter.call(document.querySelectorAll('.xin-undo'),function(x){return !!x})[0].click()");
  await wait(cdp, "(async function(){var r=await dbGet('apiSettings','outputSettings');return Number(r&&r.maxContinues)===3})()", 10000);
  check('zero value can be undone', await wait(cdp, "document.querySelectorAll('.xin-undone').length>=3", 5000));

  await ev(cdp, `window.__xinMockReplies.push(${JSON.stringify(JSON.stringify({ reply: '主题已切换。', actions: [{ type: 'set_global', key: 'appearance.theme', value: 'infernal' }] }))})`);
  await ev(cdp, "window.IBXin.send('把显示主题切换到暗色')");
  check('asynchronous global theme switch is confirmed before reporting', await ev(cdp, "document.body.classList.contains('theme-infernal')"));
  await ev(cdp, "Array.prototype.filter.call(document.querySelectorAll('.xin-undo'),function(x){return !!x})[0].click()");
  check('theme change can be undone after the transition completes', await wait(cdp, "!document.body.classList.contains('theme-infernal')&&Array.prototype.some.call(document.querySelectorAll('.xin-undone'),function(x){return x.textContent==='已撤销'})", 7000));

  await ev(cdp, "document.getElementById('xin-source').click()");
  await wait(cdp, "!!document.querySelector('.xin-api-import')", 5000);
  await ev(cdp, "document.querySelector('.xin-api-import').click()");
  await wait(cdp, "!document.getElementById('xin-model-editor').hidden", 5000);
  const imported = await ev(cdp, "(async function(){var row=await dbGet('apiSettings','xinModelConfig');return {source:document.getElementById('xin-source').textContent,row:row,roles:apiConfigs.map(function(x){return x.id})}})()");
  check('import copies only API parameters into independent settings, not a role or role credential', imported && imported.row && imported.row.id==='xinModelConfig' && imported.row.provider==='openai' && imported.row.model==='mock-model' && imported.row.credentialRef==='xin_model_v1' && !Object.prototype.hasOwnProperty.call(imported.row,'apiKey') && imported.roles.indexOf('xinModelConfig')<0, imported);
  await ev(cdp, "document.getElementById('xin-model-key').value='xin-synthetic-key-only'");
  await ev(cdp, "document.getElementById('xin-model-save').click()");
  await wait(cdp, "document.getElementById('xin-model-editor').hidden&&window.__xinVaultWrites.length===1", 10000);
  check('independent key binding uses the existing Vault writer and a Xin-only reference', await ev(cdp, "window.__xinVaultWrites[0].ref==='xin_model_v1'&&window.__xinVaultWrites[0].keyPassed&&window.__xinVaultWrites[0].provider==='openai'"));
  check('synthetic key is absent from persisted Xin model and UI input', await ev(cdp, "(async function(){var row=await dbGet('apiSettings','xinModelConfig');return JSON.stringify(row).indexOf('xin-synthetic-key-only')<0&&document.getElementById('xin-model-key').value===''})()"));

  await ev(cdp, `window.__xinMockReplies.push(${JSON.stringify(JSON.stringify({ reply: '独立 Xin 模型已应答。', actions: [] }))})`);
  await ev(cdp, "window.IBXin.send('独立模式调用测试')");
  check('independent mode calls the local Provider mock with its own Vault ref', await ev(cdp, "window.__xinCredentialResolves[window.__xinCredentialResolves.length-1]==='xin_model_v1'&&window.__xinMockCalls[window.__xinMockCalls.length-1].model==='mock-model'&&window.__xinMockCalls[window.__xinMockCalls.length-1].url==='https://mock.provider.invalid/v1/chat/completions'"));

  const requestsBeforeMissingCredential = await ev(cdp, 'window.__xinMockCalls.length');
  await ev(cdp, 'window.__xinCredentialFailure=true');
  await ev(cdp, "window.IBXin.send('独立 Vault 缺失凭据错误路径测试')");
  check('missing independent Vault credential gives a Xin-specific error without Provider dispatch', await ev(cdp, "window.__xinMockCalls.length===" + requestsBeforeMissingCredential + "&&document.querySelectorAll('.xin-message.is-assistant')[document.querySelectorAll('.xin-message.is-assistant').length-1].textContent.indexOf('Xin 模型设置面板')>=0"));
  await ev(cdp, 'window.__xinCredentialFailure=false;window.__xinMockProviderStatus=401');
  await ev(cdp, "window.IBXin.send('独立 Provider 401 错误路径测试')");
  check('independent Provider 401 gives an actionable auth message', await ev(cdp, "document.querySelectorAll('.xin-message.is-assistant')[document.querySelectorAll('.xin-message.is-assistant').length-1].textContent.indexOf('HTTP 401')>=0&&document.querySelectorAll('.xin-message.is-assistant')[document.querySelectorAll('.xin-message.is-assistant').length-1].textContent.indexOf('Xin 模型设置面板')>=0"));
  await ev(cdp, 'window.__xinMockProviderStatus=200');

  await ev(cdp, "(async function(){var role=apiConfigs.filter(function(x){return x.id==='xin_smoke_mock'})[0];await _persistApiConfig(Object.assign({},role,{provider:'anthropic',endpoint:'https://mock.provider.invalid/v1/messages',model:'role-claude'}));await loadApiConfigs();return true})()");
  await ev(cdp, `window.__xinMockReplies.push(${JSON.stringify(JSON.stringify({ reply: 'Xin 配置仍保持独立。', actions: [] }))})`);
  await ev(cdp, "window.IBXin.send('再次确认 Xin 模型来源')");
  check('changing the role Provider leaves Xin model, endpoint, and Vault ref unchanged', await ev(cdp, "(async function(){var row=await dbGet('apiSettings','xinModelConfig'),role=apiConfigs.filter(function(x){return x.id==='xin_smoke_mock'})[0],call=window.__xinMockCalls[window.__xinMockCalls.length-1],ref=window.__xinCredentialResolves[window.__xinCredentialResolves.length-1];return role.provider==='anthropic'&&row.provider==='openai'&&row.model==='mock-model'&&row.credentialRef==='xin_model_v1'&&call.url==='https://mock.provider.invalid/v1/chat/completions'&&call.model==='mock-model'&&ref==='xin_model_v1'})()"));

  await ev(cdp, "document.getElementById('xin-source').click()");
  await wait(cdp, "Array.prototype.some.call(document.querySelectorAll('.xin-model-mode'),function(b){return b.textContent.indexOf('复用现有配置')>=0})", 5000);
  await ev(cdp, "Array.prototype.filter.call(document.querySelectorAll('.xin-model-mode'),function(b){return b.textContent.indexOf('复用现有配置')>=0})[0].click()");
  await wait(cdp, "document.getElementById('xin-source').textContent.indexOf('复用 Xin Mock')>=0", 5000);
  check('reuse mode remains available after independent setup', await ev(cdp, "document.getElementById('xin-source').textContent.indexOf('复用 Xin Mock')>=0"));
  await ev(cdp, "document.getElementById('xin-source').click()");
  await ev(cdp, "Array.prototype.filter.call(document.querySelectorAll('.xin-model-mode'),function(b){return b.textContent.indexOf('独立配置')>=0})[0].click()");
  await wait(cdp, "document.getElementById('xin-source').textContent.indexOf('mock-model')>=0", 5000);

  const cacheProjection = await ev(cdp, `(function(){
    window._ibCacheDiagLog.length=0;
    var cfg={id:'xin_synthetic_cache_probe',provider:'openai',model:'mock-model',promptCache:true};
    var body={model:'mock-model',messages:[{role:'system',content:'SYNTHETIC_SYSTEM_SENTINEL'},{role:'user',content:'SYNTHETIC_USER_SENTINEL'}],max_tokens:20};
    window._ibCacheAudit(cfg,body,'openai',{consumer:'xin_synthetic_test'});
    window._ibCacheAudit(cfg,body,'openai',{consumer:'xin_synthetic_test'});
    var raw=JSON.stringify(window._ibCacheDiagLog);
    return {count:window._ibCacheDiagLog.length,last:window._ibCacheDiagLog[window._ibCacheDiagLog.length-1],noContent:raw.indexOf('SYNTHETIC_')<0};
  })()`);
  check('cache audit publishes only a safe projection', cacheProjection && cacheProjection.count===2 && cacheProjection.last.state==='stable' && cacheProjection.noContent, cacheProjection);
  const imageProjection = await ev(cdp, `(async function(){
    var cfg={id:'xin_synthetic_image_probe',provider:'openai',model:'mock-model',endpoint:'https://mock.provider.invalid/v1/chat/completions',credentialRef:'xin_synthetic_image_probe',temperature:0.2,streaming:false,promptCache:false,vision:true};
    await callApiChat(cfg,[{role:'user',content:[{type:'text',text:'synthetic image probe'},{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}]}],{maxTokens:64,timeoutMs:10000,disableTools:true,_noWebSearch:true});
    return window._ibImgDiagLog[window._ibImgDiagLog.length-1];
  })()`);
  check('image request probe stores only timestamp, count, status, and outcome', imageProjection && imageProjection.ok===true && imageProjection.n===1 && imageProjection.status===200 && !Object.keys(imageProjection).some(function(k){return /image|content|body|key|secret/i.test(k)}), imageProjection);
  const providerCallsBeforeProbes = await ev(cdp, 'window.__xinMockCalls.length');
  await ev(cdp, "window.IBXin.send('缓存探针')");
  await ev(cdp, "window.IBXin.send('图片探针')");
  check('cache and image probes return local summaries without a Provider call', await ev(cdp, "window.__xinMockCalls.length===" + providerCallsBeforeProbes + " && document.querySelector('.xin-transcript').textContent.indexOf('前缀稳定')>=0 && document.querySelector('.xin-transcript').textContent.indexOf('1 张图')>=0"));

  await ev(cdp, `(function(){IBDiagnostics.status=function(){return {lastCheckAt:Date.now(),services:[{id:'homeNode',status:'attention',detail:'Home Node 未报告 Ready。'},{id:'runner',status:'ok',detail:'Runner 正在运行。'}]}};return true})()`);
  await ev(cdp, "window.IBXin.send('Home Node 为什么又挂了？')");
  check('Home Node reply uses existing diagnostics and promises no automatic restart', await ev(cdp, "document.querySelector('.xin-transcript').textContent.indexOf('Home Node 没有进入 Ready 状态，但 Runner 仍在运行')>=0 && document.querySelector('.xin-transcript').textContent.indexOf('不会自动重启')>=0"));

  check('Xin writes no Chat, Role DM, or Memory stores', await ev(cdp, "window.__xinStoreWrites.length===0"));
  check('Xin session is stored under its own local key', await ev(cdp, "!!localStorage.getItem('ib_xin_session_v1') && !localStorage.getItem('ib_helper_hist')"));

  await ev(cdp, 'window.IBXin.close()');
  await ev(cdp, "localStorage.setItem('ib_xin_prefs_v1',JSON.stringify({version:1,apiId:'xin_smoke_mock'}))");
  const previousTimeOrigin = await ev(cdp, 'performance.timeOrigin');
  await cdp.send('Page.reload', { ignoreCache: true });
  await wait(cdp, "performance.timeOrigin>" + previousTimeOrigin + " && !!window.IBXin && !!document.getElementById('xin-launcher')", 30000);
  await dismissOverlays();
  await ev(cdp, 'window.IBXin.open()');
  check('session and selected API restore after reload', await wait(cdp, "document.querySelector('.xin-transcript').textContent.indexOf('缓存探针')>=0 && document.getElementById('xin-source').textContent.indexOf('Xin Mock')>=0", 10000));
  check('legacy apiId preference migrates to reuse mode without losing its selection', await ev(cdp, "document.getElementById('xin-source').textContent.indexOf('复用 Xin Mock')===0&&JSON.parse(localStorage.getItem('ib_xin_prefs_v1')).apiId==='xin_smoke_mock'"));
  await ev(cdp, "document.getElementById('xin-source').click()");
  await wait(cdp, "Array.prototype.some.call(document.querySelectorAll('.xin-model-mode'),function(b){return b.textContent.indexOf('独立配置')>=0})", 5000);
  await ev(cdp, "Array.prototype.filter.call(document.querySelectorAll('.xin-model-mode'),function(b){return b.textContent.indexOf('独立配置')>=0})[0].click()");
  await wait(cdp, "document.getElementById('xin-source').textContent.indexOf('mock-model')>=0", 5000);
  check('independent configuration survives legacy preference migration', await ev(cdp, "document.getElementById('xin-source').textContent.indexOf('mock-model')>=0"));

  const wasInfernal = await ev(cdp, "document.body.classList.contains('theme-infernal')");
  if (!wasInfernal) await ev(cdp, 'window.toggleTheme()');
  await wait(cdp, "document.body.classList.contains('theme-infernal')", 6000);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  await ev(cdp, 'window.IBXin.open()');
  await wait(cdp, "document.getElementById('xin-drawer').classList.contains('is-open')", 5000);
  await sleep(400);
  const mobile = await ev(cdp, `(function(){var d=document.getElementById('xin-drawer'),r=d.getBoundingClientRect(),q=document.querySelector('.xin-quick');return {width:r.width,right:r.right,left:r.left,drawerScroll:d.scrollWidth,drawerClient:d.clientWidth,pageScroll:document.documentElement.scrollWidth,viewport:innerWidth,quickTarget:Math.min.apply(null,Array.prototype.map.call(q.querySelectorAll('button'),function(b){return b.getBoundingClientRect().height})),theme:document.body.classList.contains('theme-infernal'),background:getComputedStyle(d).backgroundColor}})()`);
  check('390px drawer fits viewport and has no page-level horizontal overflow', mobile && mobile.width <= 390 && mobile.left >= -1 && mobile.right <= 391 && mobile.pageScroll <= mobile.viewport + 1 && mobile.drawerScroll <= mobile.drawerClient + 2, mobile);
  check('390px quick controls remain touch sized in Infernal theme', mobile && mobile.theme && mobile.quickTarget >= 40 && mobile.background && mobile.background !== 'rgba(0, 0, 0, 0)', mobile);

  if (process.env.XIN_PREVIEW_DIR) {
    await ev(cdp, "window.confirm=function(){return true};document.getElementById('xin-clear').click()");
    await wait(cdp, "!!document.querySelector('.xin-welcome')", 5000);
    fs.mkdirSync(process.env.XIN_PREVIEW_DIR, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(process.env.XIN_PREVIEW_DIR, 'xin-mobile-390-infernal.png'), Buffer.from(shot.data, 'base64'));
  }
  await ev(cdp, "document.getElementById('xin-model-edit').click()");
  await wait(cdp, "!document.getElementById('xin-model-editor').hidden", 5000);
  const editorLayout = await ev(cdp, "(function(){var d=document.getElementById('xin-drawer'),e=document.getElementById('xin-model-editor'),r=e.getBoundingClientRect(),inputs=Array.prototype.slice.call(e.querySelectorAll('input,select'));return {page:document.documentElement.scrollWidth,viewport:innerWidth,height:innerHeight,drawer:d.scrollWidth,drawerClient:d.clientWidth,editor:r.width,fields:inputs.map(function(x){return x.getBoundingClientRect().width}),saveBottom:document.getElementById('xin-model-save').getBoundingClientRect().bottom,keyValue:document.getElementById('xin-model-key').value,composerHidden:getComputedStyle(document.querySelector('.xin-composer')).display==='none'}})()");
  check('390px independent model editor fits with its save action visible', editorLayout && editorLayout.page<=editorLayout.viewport+1 && editorLayout.drawer<=editorLayout.drawerClient+2 && editorLayout.editor>0 && editorLayout.fields.every(function(width){return width>0&&width<=editorLayout.editor}) && editorLayout.saveBottom<=editorLayout.height+1 && editorLayout.saveBottom>0 && editorLayout.composerHidden && editorLayout.keyValue==='', editorLayout);
  if (process.env.XIN_PREVIEW_DIR) {
    const editorShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(process.env.XIN_PREVIEW_DIR, 'xin-mobile-390-independent-editor.png'), Buffer.from(editorShot.data, 'base64'));
  }

  check('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 4));
  console.log('\nXin smoke: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.close();
  if (browser) await browser.close();
  if (webServer) await new Promise(resolve => webServer.close(() => resolve()));
  if (bootDir) { try { fs.rmSync(bootDir, { recursive: true, force: true }); } catch (_) { } }
});
