'use strict';

/* Isolated desktop browser smoke for API/Vault workflows. All API keys and
   provider responses are synthetic; no external provider endpoint is called. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
const { launchBrowser, ev, wait, sleep } = require(path.join(ROOT, 'scripts', 'cdp-lite.js'));

let browser, cdp;
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.error('  FAIL ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

(async function main() {
  const previewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-api-vault-browser-'));
  browser = await launchBrowser({ width: 1440, height: 900, profilePrefix: 'ib-api-vault-' });
  cdp = await browser.open(pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(cdp, "document.readyState!=='loading'&&typeof _persistApiConfig==='function'&&!!document.getElementById('api-editor')", 30000);
  await wait(cdp, "!document.getElementById('preloader')||getComputedStyle(document.getElementById('preloader')).visibility==='hidden'", 30000);
  await ev(cdp, "(function(){try{if(window.IBSetup&&typeof IBSetup.skip==='function'&&document.getElementById('ib-setup')&&document.getElementById('ib-setup').classList.contains('is-open'))IBSetup.skip()}catch(e){}var g=document.getElementById('ib-guard-overlay');if(g){var b=[].filter.call(g.querySelectorAll('button'),function(x){return x.textContent.indexOf('无视')>=0})[0];if(b)b.click()}return true})()");
  await wait(cdp, "!document.getElementById('ib-setup')||!document.getElementById('ib-setup').classList.contains('is-open')", 10000);

  const setup = await ev(cdp, `(async function(){
    await _persistApiConfig({id:'vault_role_a',nickname:'Vault Role A',provider:'openai',model:'chat-origin',endpoint:'https://mock-provider.invalid/v1/chat/completions',credentialRef:'chat_main',temperature:0.7,streaming:true,webSearch:true,memWrite:true,imageGen:true,imageGenModel:'gpt-image-2.5-flare',imageGenProvider:'openai',imageGenEndpoint:'https://mock-image.invalid/v1/images/generations',imageGenCredentialRef:'image_main',imageGenCredentialProvider:'openai'});
    await _persistApiConfig({id:'vault_role_b',nickname:'Vault Role B',provider:'openai',model:'chat-origin-b',endpoint:'https://mock-provider.invalid/v1/chat/completions',credentialRef:'shared_chat'});
    await _persistApiConfig({id:'vault_role_c',nickname:'Vault Role C',provider:'openai',model:'chat-origin-c',endpoint:'https://mock-provider.invalid/v1/chat/completions',credentialRef:'shared_chat'});
    await _persistApiConfig({id:'vault_teamrouter',nickname:'TeamRouter Image Role',provider:'mimo',model:'mimo-chat',endpoint:'https://api.xiaomimimo.com/v1/chat/completions',credentialRef:'mimo_chat',imageGen:true,imageGenModel:'gpt-image-2.5-flare',imageGenProvider:'openai',imageGenEndpoint:'https://api.teamrouter.cn/v1/images/generations',imageGenCredentialRef:''});
    await loadApiConfigs();
    window.__vaultRows=[
      {credentialRef:'chat_main',displayName:'Chat Primary',provider:'openai',endpoint:'https://mock-provider.invalid/v1/chat/completions',model:'chat-origin',updatedAt:1,secretPresent:true,userManaged:false},
      {credentialRef:'shared_chat',displayName:'Shared Chat',provider:'openai',endpoint:'https://mock-provider.invalid/v1/chat/completions',model:'chat-shared',updatedAt:5,secretPresent:true,userManaged:true},
      {credentialRef:'image_main',displayName:'Image Dedicated',provider:'openai',endpoint:'https://mock-image.invalid/v1/images/generations',model:'gpt-image-2.5-flare',updatedAt:2,secretPresent:true,userManaged:true},
      {credentialRef:'voice_main',displayName:'Voice Transcribe',provider:'openai',endpoint:'https://mock-provider.invalid/v1/audio/transcriptions',model:'whisper-1',updatedAt:3,secretPresent:true,userManaged:true},
      {credentialRef:'chat_alt',displayName:'Alternate Chat',provider:'openai',endpoint:'https://mock-alt.invalid/v1/chat/completions',model:'chat-alt',updatedAt:4,secretPresent:true,userManaged:true},
      {credentialRef:'qwen_image_ref',displayName:'Qwen Image Credential',provider:'qwen',endpoint:'https://mock-image.invalid/v1/images/generations',model:'qwen-image',updatedAt:5,secretPresent:true,userManaged:true},
      {credentialRef:'mimo_chat',displayName:'MiMo Chat',provider:'mimo',endpoint:'https://api.xiaomimimo.com/v1/chat/completions',model:'mimo-chat',updatedAt:6,secretPresent:true,userManaged:false}
    ];
    window.__vaultWrites=[];window.__providerRequests=[];window.__providerStatus=200;
    window._activeCompanionRequest=async function(path,options){
      options=options||{};var method=String(options.method||'GET').toUpperCase();
      if(String(path)==='/credentials'&&method==='GET')return {ok:true,credentials:window.__vaultRows.map(function(row){return Object.assign({},row)})};
      if(String(path)==='/credentials'&&method==='POST'){
        var incoming=options.body&&options.body.credentials||[];var refs=[];
        incoming.forEach(function(item){if(!item)return;var ref=String(item.credentialRef||item.characterId||'');var row={credentialRef:ref,displayName:String(item.displayName||''),provider:String(item.provider||''),endpointHost:(function(){try{return new URL(item.endpoint||'').host}catch(e){return ''}})(),endpoint:String(item.endpoint||''),model:String(item.model||''),updatedAt:Date.now(),secretPresent:!!String(item.apiKey||''),userManaged:item.userManaged===true};
          window.__vaultRows=window.__vaultRows.filter(function(old){return old.credentialRef!==ref}).concat([row]);refs.push(ref);window.__vaultWrites.push({credentialRef:ref,secretWasSubmitted:!!String(item.apiKey||''),displayName:row.displayName});
        });
        return {ok:true,stored:refs.length,credentialRef:refs.length===1?refs[0]:null,credentialRefs:refs};
      }
      if(String(path)==='/credentials'&&method==='DELETE'){
        var ids=options.body&&options.body.credentialRefs||[];window.__vaultRows=window.__vaultRows.filter(function(row){return ids.indexOf(row.credentialRef)<0});return {ok:true,removed:ids.length,credentialRefs:ids};
      }
      return {ok:false,error:'mock-route-not-found'};
    };
    var host=Object.assign({},window.IB.host||{});
    host.credentialStatus={query:async function(bindings){return {ok:true,results:(bindings||[]).map(function(binding){var row=window.__vaultRows.find(function(item){return item.credentialRef===binding.bindingId});return {bindingId:binding.bindingId,status:row?'ready':'missing',secretPresent:!!row,sourceClass:'mock-vault'}})}}};
    host.credentialResolver={available:true,resolve:async function(ref){var row=window.__vaultRows.find(function(item){return item.credentialRef===String(ref)});return row?{ok:true,provider:row.provider,apiKey:'synthetic-'+row.credentialRef}:{ok:false,errorCode:'CREDENTIAL_UNAVAILABLE'}}};
    window.IB.host=host;
    var originalFetch=window.fetch;
    window.fetch=async function(url,options){
      var target=String(url),headers=options&&options.headers||{};
      if(target==='https://mock-provider.invalid/v1/models'){
        window.__providerRequests.push({url:target,method:String(options&&options.method||'GET'),authorization:String(headers.Authorization||headers.authorization||''),secretInBody:String(options&&options.body||'').indexOf('synthetic-')>=0});
        return new Response(JSON.stringify({data:[{id:'mock-chat-a'},{id:'mock-chat-b'}]}),{status:Number(window.__providerStatus),headers:{'Content-Type':'application/json'}});
      }
      if(target==='https://mock-image.invalid/v1/images/generations'){
        window.__providerRequests.push({url:target,method:String(options&&options.method||'GET'),authorization:String(headers.Authorization||headers.authorization||''),secretInBody:String(options&&options.body||'').indexOf('synthetic-')>=0});
        return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/oS8AAAAASUVORK5CYII='}]}),{status:200,headers:{'Content-Type':'application/json'}});
      }
      if(target==='https://api.teamrouter.cn/v1/images/generations'){
        window.__providerRequests.push({url:target,method:String(options&&options.method||'GET'),authorization:String(headers.Authorization||headers.authorization||''),secretInBody:String(options&&options.body||'').indexOf('synthetic-')>=0});
        return new Response(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/oS8AAAAASUVORK5CYII='}]}),{status:200,headers:{'Content-Type':'application/json'}});
      }
      if(target.indexOf('https://api.teamrouter.cn/')===0){window.__blockedTeamRouterRequests.push(target);return new Response(JSON.stringify({error:{message:'unexpected TeamRouter mock route'}}),{status:404,headers:{'Content-Type':'application/json'}})}
      return originalFetch.call(this,url,options);
    };
    await _ibRefreshVaultCredentialCatalog(true);await renderApiList();
    return {roles:apiConfigs.map(function(item){return item.id}),catalog:window.__vaultRows.length};
  })()`);
  check('synthetic roles and Vault catalog are available in isolated browser storage', setup && setup.roles.indexOf('vault_role_a') >= 0 && setup.roles.indexOf('vault_teamrouter') >= 0 && setup.catalog === 7, setup);

  await ev(cdp, "navTo('api');editApi('vault_role_a')");
  await wait(cdp, "document.getElementById('api-imagegen-credential').options.length>=3&&document.getElementById('api-credential-ref').options.length>=4", 10000);
  const selectors = await ev(cdp, "(function(){var c=document.getElementById('api-credential-ref'),i=document.getElementById('api-imagegen-credential');return {sharedRefs:[].map.call(c.options,function(x){return x.value}).filter(function(x){return x==='shared_chat'}).length,sharedLabel:[].filter.call(c.options,function(x){return x.value==='shared_chat'})[0].textContent,currentLabel:[].filter.call(c.options,function(x){return x.value==='__current__'})[0].textContent,imageRef:[].some.call(i.options,function(x){return x.value==='image_main'&&x.textContent.indexOf('Image Dedicated')>=0&&x.textContent.indexOf('GPT')>=0}),selectedImage:i.value}})()");
  check('chat picker merges duplicate refs while image picker shows Vault name and Provider', selectors && selectors.sharedRefs === 1 && selectors.sharedLabel.indexOf('Shared Chat') >= 0 && selectors.currentLabel.indexOf('Chat Primary') >= 0 && selectors.imageRef && selectors.selectedImage === 'image_main', selectors);

  await ev(cdp, "document.getElementById('api-vault-manager-open').click()");
  await wait(cdp, "!document.getElementById('ib-vault-manager-backdrop').hidden&&document.getElementById('ib-vault-credential-list').textContent.indexOf('Image Dedicated')>=0", 5000);
  const managerBefore = await ev(cdp, "({text:document.getElementById('ib-vault-credential-list').textContent,deleteDisabled:[].filter.call(document.querySelectorAll('.ib-vault-record'),function(x){return x.textContent.indexOf('Image Dedicated')>=0})[0].querySelector('.api-compact-danger').disabled})");
  check('Vault manager lists provider, endpoint association, and blocks deletion while referenced', managerBefore && managerBefore.text.indexOf('GPT') >= 0 && managerBefore.text.indexOf('图像') >= 0 && managerBefore.deleteDisabled, managerBefore);
  if(process.env.IB_API_VAULT_PREVIEW_DIR){await sleep(2200);fs.mkdirSync(process.env.IB_API_VAULT_PREVIEW_DIR,{recursive:true});const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(process.env.IB_API_VAULT_PREVIEW_DIR,'api-vault-manager-1440.png'),Buffer.from(shot.data,'base64'))}
  await ev(cdp, "document.getElementById('ib-vault-create-details').open=true;document.getElementById('ib-vault-name').value='New Image Key';document.getElementById('ib-vault-provider').value='openai';document.getElementById('ib-vault-endpoint').value='https://new-image.mock.invalid/v1/images/generations';document.getElementById('ib-vault-model').value='gpt-image-1';document.getElementById('ib-vault-key').value='synthetic-new-image-key';window.__saveClicks=0;document.getElementById('ib-vault-save').addEventListener('click',function(){window.__saveClicks++});document.getElementById('ib-vault-save').click()");
  const managerSaved=await wait(cdp, "window.__vaultWrites.length===1&&document.getElementById('ib-vault-credential-list').textContent.indexOf('New Image Key')>=0", 10000);
  const newVault = await ev(cdp, "(async function(){var row=await dbGet('apiConfigs','vault_role_a'),rows=await dbGetAll('apiSettings');return {refCount:window.__vaultRows.length,write:window.__vaultWrites[0]||null,status:document.getElementById('ib-vault-manager-status').textContent,list:document.getElementById('ib-vault-credential-list').textContent,secretInput:document.getElementById('ib-vault-key').value,secretInRole:JSON.stringify(row).indexOf('synthetic-new-image-key')>=0,secretInSettings:JSON.stringify(rows).indexOf('synthetic-new-image-key')>=0}})()");
  check('independent credential is written to Vault only and the UI clears the key', managerSaved && newVault && newVault.write && newVault.write.secretWasSubmitted && newVault.write.displayName === 'New Image Key' && newVault.secretInput === '' && !newVault.secretInRole && !newVault.secretInSettings, newVault);
  if(!managerSaved)throw new Error('Vault manager add failed: '+JSON.stringify(newVault));
  const newCredentialRow=await ev(cdp,"(function(){var row=[].filter.call(document.querySelectorAll('.ib-vault-record'),function(x){return x.textContent.indexOf('New Image Key')>=0})[0];return {found:!!row,deleteDisabled:row&&row.querySelector('.api-compact-danger').disabled}})()");
  check('new independent Vault credentials can be managed while unreferenced',newCredentialRow&&newCredentialRow.found&&!newCredentialRow.deleteDisabled,newCredentialRow);
  await ev(cdp, "_ibCloseVaultCredentialManager();document.getElementById('api-imagegen-endpoint').value='https://new-image.mock.invalid/v1/images/generations';document.getElementById('api-imagegen-endpoint').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('api-imagegen-credential').value=window.__vaultRows.filter(function(x){return x.displayName==='New Image Key'})[0].credentialRef;document.getElementById('api-imagegen-credential').dispatchEvent(new Event('change',{bubbles:true}))");
  check('image credential selection changes image settings without touching chat Provider', await ev(cdp, "document.getElementById('api-credential-ref').value==='__current__'&&document.getElementById('api-provider').value==='openai'&&document.getElementById('api-imagegen-credential').value===window.__vaultRows.filter(function(x){return x.displayName==='New Image Key'})[0].credentialRef"));
  const qwenImageAuth=await ev(cdp,"(async function(){var cfg={id:'synthetic-image-call',provider:'deepseek',model:'deepseek-mock',endpoint:'https://mock-provider.invalid/v1/chat/completions',credentialRef:'chat_main',imageGen:true,imageGenModel:'gpt-image-1',imageGenProvider:'openai',imageGenEndpoint:'https://mock-image.invalid/v1/images/generations',imageGenCredentialRef:'qwen_image_ref',imageGenCredentialProvider:'qwen'};var before=window.__providerRequests.length,ok=await _wsExecImageGen(cfg,'synthetic prompt','1024x1024',{}),hit=window.__providerRequests[window.__providerRequests.length-1];var badCfg=Object.assign({},cfg,{imageGenCredentialProvider:'openai'}),bad=await _wsExecImageGen(badCfg,'synthetic prompt','1024x1024',{});return {ok:ok&&ok.ok===true,wireProvider:cfg.imageGenProvider,auth:hit&&hit.authorization,successRequests:window.__providerRequests.length-before,wrongProviderCode:bad&&bad.code,wrongProviderNoRequest:window.__providerRequests.length===before+1}})()");
  check('image wire Provider stays independent from the Vault credential Provider', qwenImageAuth&&qwenImageAuth.ok&&qwenImageAuth.wireProvider==='openai'&&qwenImageAuth.auth.indexOf('synthetic-qwen_image_ref')>=0&&qwenImageAuth.wrongProviderCode==='CREDENTIAL_UNAVAILABLE'&&qwenImageAuth.wrongProviderNoRequest,qwenImageAuth);
  await ev(cdp, "document.getElementById('api-credential-ref').value='chat_alt';saveCurrentApi(null)");
  await wait(cdp, "(async function(){var c=await dbGet('apiConfigs','vault_role_a');return c&&c.credentialRef==='chat_alt'&&c.imageGenCredentialRef===window.__vaultRows.filter(function(x){return x.displayName==='New Image Key'})[0].credentialRef})()", 10000);
  const afterChatBind = await ev(cdp, "(async function(){var a=await dbGet('apiConfigs','vault_role_a'),b=await dbGet('apiConfigs','vault_role_b');return {chat:a&&a.credentialRef,image:a&&a.imageGenCredentialRef,chatProvider:a&&a.provider,webSearch:a&&a.webSearch,peerChat:b&&b.credentialRef,hasKey:!!(a&&a.apiKey)}})()");
  check('direct chat credential selection stores only the ref and leaves image plus peer profile alone', afterChatBind && afterChatBind.chat === 'chat_alt' && afterChatBind.image === newVault.write.credentialRef && afterChatBind.chatProvider === 'openai' && afterChatBind.webSearch === true && afterChatBind.peerChat === 'shared_chat' && !afterChatBind.hasKey, afterChatBind);

  await ev(cdp, "editApi('vault_role_a');document.getElementById('api-model').value='mock-chat-a';document.getElementById('api-profile-preset-name').value='Chat A';document.getElementById('api-profile-preset-save').click()");
  await wait(cdp, "(async function(){var p=await dbGet('apiSettings','api_profile_presets_v1');return !!(p&&p.configs&&p.configs.vault_role_a&&p.configs.vault_role_a.length)})()", 5000);
  const presetSaved = await ev(cdp, "(async function(){var p=await dbGet('apiSettings','api_profile_presets_v1');return p.configs.vault_role_a[0]})()");
  check('API preset stores provider, endpoint, model, and Vault ref without a key', presetSaved && presetSaved.name === 'Chat A' && presetSaved.model === 'mock-chat-a' && presetSaved.credentialRef === 'chat_alt' && !Object.prototype.hasOwnProperty.call(presetSaved, 'apiKey'), presetSaved);
  await ev(cdp, "(async function(){var c=await dbGet('apiConfigs','vault_role_a');await _persistApiConfig(Object.assign({},c,{model:'manually-changed',endpoint:'https://other.mock.invalid/v1/chat/completions',temperature:1.9,webSearch:false}));await loadApiConfigs();editApi('vault_role_a');document.getElementById('api-profile-preset-select').value='0';document.getElementById('api-profile-preset-apply').click();return true})()");
  await wait(cdp, "(async function(){var c=await dbGet('apiConfigs','vault_role_a');return c&&c.model==='mock-chat-a'&&c.credentialRef==='chat_alt'&&c.temperature===1.9&&c.webSearch===false})()", 10000);
  const afterPresetApply = await ev(cdp, "(async function(){var c=await dbGet('apiConfigs','vault_role_a');return {model:c&&c.model,endpoint:c&&c.endpoint,credentialRef:c&&c.credentialRef,imageRef:c&&c.imageGenCredentialRef,imageEndpoint:c&&c.imageGenEndpoint,temperature:c&&c.temperature,webSearch:c&&c.webSearch}})()");
  check('applying an API preset leaves permissions and independent image configuration unchanged', afterPresetApply && afterPresetApply.model === 'mock-chat-a' && afterPresetApply.credentialRef === 'chat_alt' && afterPresetApply.imageRef === afterChatBind.image && afterPresetApply.imageEndpoint === 'https://new-image.mock.invalid/v1/images/generations' && afterPresetApply.temperature === 1.9 && afterPresetApply.webSearch === false, afterPresetApply);

  await ev(cdp, "window.confirm=function(){return true};document.getElementById('api-fetch-models').click()");
  await wait(cdp, "window.__providerRequests.some(function(x){return x.url==='https://mock-provider.invalid/v1/models'})&&document.querySelectorAll('#api-model-list option').length===2", 10000);
  const modelFetch = await ev(cdp, "({status:document.getElementById('api-model-list-status').textContent,models:[].map.call(document.querySelectorAll('#api-model-list option'),function(x){return x.value}),request:window.__providerRequests.filter(function(x){return x.url==='https://mock-provider.invalid/v1/models'})[0]})");
  check('manual model discovery uses the selected Vault credential through the mock endpoint', modelFetch && modelFetch.models.indexOf('mock-chat-a') >= 0 && modelFetch.request.authorization.indexOf('synthetic-chat_alt') >= 0 && !modelFetch.request.secretInBody, modelFetch);

  await ev(cdp, "window._ibRenderVoiceTransCredentialOptions('','openai');document.getElementById('api-vt-endpoint').value='';document.getElementById('api-vt-model').value='';document.getElementById('api-vt-credential').value='voice_main';document.getElementById('api-vt-credential').dispatchEvent(new Event('change',{bubbles:true}))");
  await wait(cdp, "(async function(){var v=await dbGet('apiSettings','voiceTrans');return v&&v.credentialRef==='voice_main'&&v.provider==='openai'})()", 5000);
  const voiceConfig = await ev(cdp, "(async function(){var v=await dbGet('apiSettings','voiceTrans'),r=await dbGet('apiConfigs','vault_role_a');return {ref:v&&v.credentialRef,provider:v&&v.provider,apiKey:v&&v.apiKey,endpoint:v&&v.endpoint,model:v&&v.model,roleRef:r&&r.credentialRef}})()");
  check('voice transcription reuses a Vault credential without overwriting role API state', voiceConfig && voiceConfig.ref === 'voice_main' && voiceConfig.provider === 'openai' && !voiceConfig.apiKey && voiceConfig.endpoint === 'https://mock-provider.invalid/v1/audio/transcriptions' && voiceConfig.model === 'whisper-1' && voiceConfig.roleRef === 'chat_alt', voiceConfig);

  await ev(cdp, "document.getElementById('api-profile-preset-select').value='0';document.getElementById('api-profile-preset-delete').click()");
  await wait(cdp, "(async function(){var p=await dbGet('apiSettings','api_profile_presets_v1');return !p.configs.vault_role_a.length})()", 5000);
  check('deleting a profile preset does not delete its Vault credential', await ev(cdp, "window.__vaultRows.some(function(x){return x.credentialRef==='chat_alt'})"));

  await ev(cdp, "window.__blockedTeamRouterRequests=[];(async function(){await loadApiConfigs();editApi('vault_teamrouter')})()");
  await wait(cdp, "document.getElementById('api-imagegen-credential').options[0].disabled&&document.getElementById('api-imagegen-credential').options[0].textContent.indexOf('Endpoint')>=0", 10000);
  const mismatchGuard = await ev(cdp, "({followDisabled:document.getElementById('api-imagegen-credential').options[0].disabled,followLabel:document.getElementById('api-imagegen-credential').options[0].textContent,endpoint:document.getElementById('api-imagegen-endpoint').value,chatProvider:document.getElementById('api-provider').value})");
  check('TeamRouter image Endpoint marks the unrelated MiMo chat credential unavailable', mismatchGuard && mismatchGuard.followDisabled && mismatchGuard.followLabel.indexOf('不匹配') >= 0 && mismatchGuard.endpoint === 'https://api.teamrouter.cn/v1/images/generations' && mismatchGuard.chatProvider === 'mimo', mismatchGuard);
  await ev(cdp, "document.getElementById('api-imagegen-credential-add').click()");
  await wait(cdp, "!document.getElementById('ib-vault-manager-backdrop').hidden&&document.getElementById('ib-vault-create-details').open", 5000);
  const contextualAdd = await ev(cdp, "({provider:document.getElementById('ib-vault-provider').value,endpoint:document.getElementById('ib-vault-endpoint').value,model:document.getElementById('ib-vault-model').value,title:document.getElementById('ib-vault-manager-title').textContent})");
  check('image settings opens a contextual Vault form with the TeamRouter Endpoint and image model', contextualAdd && contextualAdd.provider === 'custom' && contextualAdd.endpoint === 'https://api.teamrouter.cn/v1/images/generations' && contextualAdd.model === 'gpt-image-2.5-flare' && contextualAdd.title.indexOf('图片') >= 0, contextualAdd);
  await ev(cdp, "document.getElementById('ib-vault-name').value='TeamRouter Image';document.getElementById('ib-vault-key').value='synthetic-teamrouter-image-key';document.getElementById('ib-vault-save').click()");
  const teamSavedToVault = await wait(cdp, "document.getElementById('ib-vault-manager-backdrop').hidden&&document.getElementById('api-imagegen-credential').value&&document.getElementById('api-imagegen-credential').selectedOptions[0].textContent.indexOf('TeamRouter Image')>=0", 10000);
  const teamVaultRow = await ev(cdp, "(function(){var row=window.__vaultRows.find(function(x){return x.displayName==='TeamRouter Image'});return {ref:row&&row.credentialRef,provider:row&&row.provider,endpoint:row&&row.endpoint,write:window.__vaultWrites[window.__vaultWrites.length-1]||null,selected:document.getElementById('api-imagegen-credential').value,secretInInput:document.getElementById('ib-vault-key').value}})()");
  check('TeamRouter key is saved only in the existing Vault and automatically selected', teamSavedToVault && teamVaultRow && teamVaultRow.provider === 'custom' && teamVaultRow.endpoint === 'https://api.teamrouter.cn/v1/images/generations' && teamVaultRow.selected === teamVaultRow.ref && teamVaultRow.write && teamVaultRow.write.secretWasSubmitted && teamVaultRow.secretInInput === '', teamVaultRow);
  if(!teamSavedToVault)throw new Error('Contextual TeamRouter Vault add did not select the new credential: '+JSON.stringify(teamVaultRow));
  await ev(cdp, "saveCurrentApi(null)");
  await wait(cdp, "(async function(){var c=await dbGet('apiConfigs','vault_teamrouter');return c&&c.imageGenCredentialRef&&c.imageGenCredentialProvider==='custom'&&c.imageGenProvider==='openai'&&c.imageGenEndpoint==='https://api.teamrouter.cn/v1/images/generations'&&c.provider==='mimo'&&c.credentialRef==='mimo_chat'&&!c.imageGenApiKey&&!c.apiKey&&JSON.stringify(c).indexOf('synthetic-teamrouter-image-key')<0})()", 10000);
  await ev(cdp, "(async function(){await loadApiConfigs();editApi('vault_teamrouter')})()");
  await wait(cdp, "document.getElementById('api-imagegen-credential').value&&document.getElementById('api-imagegen-credential').selectedOptions[0].textContent.indexOf('TeamRouter Image')>=0", 10000);
  const teamReload = await ev(cdp, "(async function(){var c=await dbGet('apiConfigs','vault_teamrouter');return {ref:c&&c.imageGenCredentialRef,provider:c&&c.imageGenCredentialProvider,wire:c&&c.imageGenProvider,endpoint:c&&c.imageGenEndpoint,selected:document.getElementById('api-imagegen-credential').value,chatProvider:c&&c.provider,chatRef:c&&c.credentialRef}})()");
  check('TeamRouter image config and Vault reference survive save plus API config reload', teamReload && teamReload.ref === teamVaultRow.ref && teamReload.provider === 'custom' && teamReload.wire === 'openai' && teamReload.endpoint === 'https://api.teamrouter.cn/v1/images/generations' && teamReload.selected === teamVaultRow.ref && teamReload.chatProvider === 'mimo' && teamReload.chatRef === 'mimo_chat', teamReload);
  if(process.env.IB_API_VAULT_PREVIEW_DIR){fs.mkdirSync(process.env.IB_API_VAULT_PREVIEW_DIR,{recursive:true});await ev(cdp,"document.getElementById('api-imagegen-credential').scrollIntoView({block:'center'})");await sleep(1400);const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(process.env.IB_API_VAULT_PREVIEW_DIR,'teamrouter-image-credential-1440.png'),Buffer.from(shot.data,'base64'))}
  const teamRoute = await ev(cdp, "(async function(){var cfg=await dbGet('apiConfigs','vault_teamrouter');await IB.imageRouterConfig.saveRoutes({generation:{enabled:true,apiConfigId:'vault_teamrouter',model:'gpt-image-2.5-flare'}});IB.imageRouter.reset();var r=await IB.imageRouter.routeImageRequest({source:'chat',characterId:'vault_teamrouter',cfg:cfg,prompt:'synthetic TeamRouter image route',size:'1024x1024',userInitiated:true});var hit=window.__providerRequests.filter(function(x){return x.url==='https://api.teamrouter.cn/v1/images/generations'}).slice(-1)[0];return {ok:r&&r.ok===true,routeId:r&&r.route&&r.route.apiConfigId,routeName:r&&r.route&&r.route.routeName,model:r&&r.model,hit:hit||null,unexpected:window.__blockedTeamRouterRequests.slice()}})()");
  check('Image Router sends the saved TeamRouter image request with the matching synthetic Vault credential', teamRoute && teamRoute.ok && teamRoute.routeId === 'vault_teamrouter' && teamRoute.routeName === 'generation' && teamRoute.hit && teamRoute.hit.method === 'POST' && teamRoute.hit.authorization.indexOf('synthetic-'+teamVaultRow.ref) >= 0 && !teamRoute.hit.secretInBody && teamRoute.unexpected.length === 0, teamRoute);
  await ev(cdp, "editApi('vault_role_a');document.getElementById('api-imagegen-endpoint').value='https://mock-alt.invalid/v1/images/generations';document.getElementById('api-imagegen-endpoint').dispatchEvent(new Event('input',{bubbles:true}))");
  const followCompatible = await ev(cdp, "({value:document.getElementById('api-imagegen-credential').options[0].value,disabled:document.getElementById('api-imagegen-credential').options[0].disabled,label:document.getElementById('api-imagegen-credential').options[0].textContent})");
  check('follow-chat credential mode remains selectable when the image Endpoint matches chat credential origin', followCompatible && followCompatible.value === '' && !followCompatible.disabled, followCompatible);

  const editorLayout = await ev(cdp, "(function(){var r=document.getElementById('api-editor').getBoundingClientRect();return {width:r.width,body:document.documentElement.scrollWidth,viewport:innerWidth,top:r.top,bottom:r.bottom,height:innerHeight}})()");
  check('API editor fits a 1440px desktop viewport without horizontal overflow', editorLayout && editorLayout.width > 0 && editorLayout.body <= editorLayout.viewport + 1, editorLayout);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1.25,mobile:false});
  await ev(cdp,"editApi('vault_role_a');document.getElementById('api-vault-manager-open').click()");
  await wait(cdp,"!document.getElementById('ib-vault-manager-backdrop').hidden",5000);
  await sleep(2200);
  const compactDesktop=await ev(cdp,"(function(){var m=document.querySelector('.ib-vault-manager'),r=m.getBoundingClientRect();return {open:!document.getElementById('ib-vault-manager-backdrop').hidden,viewport:innerWidth,body:document.documentElement.scrollWidth,width:r.width,height:r.height,client:m.clientWidth,scroll:m.scrollWidth,bottom:r.bottom,heightLimit:innerHeight}})()");
  check('Vault manager remains usable at 1280x720 with 125% Windows-style DPI scale',compactDesktop&&compactDesktop.open&&compactDesktop.width>500&&compactDesktop.width<=compactDesktop.viewport&&compactDesktop.body<=compactDesktop.viewport+1&&compactDesktop.scroll<=compactDesktop.client+2&&compactDesktop.height<=compactDesktop.heightLimit+1,compactDesktop);
  if(process.env.IB_API_VAULT_PREVIEW_DIR){const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(process.env.IB_API_VAULT_PREVIEW_DIR,'api-vault-manager-1280-dpi125.png'),Buffer.from(shot.data,'base64'))}
  await ev(cdp,"_ibCloseVaultCredentialManager()");
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  if (process.env.IB_API_VAULT_PREVIEW_DIR) {
    fs.mkdirSync(process.env.IB_API_VAULT_PREVIEW_DIR, { recursive: true });
    await ev(cdp,"document.getElementById('api-profile-presets').open=true;document.getElementById('api-profile-presets').scrollIntoView({block:'center'})");
    await sleep(700);
    const editorShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(process.env.IB_API_VAULT_PREVIEW_DIR, 'api-profile-presets-1440.png'), Buffer.from(editorShot.data, 'base64'));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(process.env.IB_API_VAULT_PREVIEW_DIR, 'api-vault-1440.png'), Buffer.from(shot.data, 'base64'));
  }

  console.log('\nAPI/Vault browser smoke: ' + pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.close();
  if (browser) await browser.close();
});

