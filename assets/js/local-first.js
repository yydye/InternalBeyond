﻿/* Local-first controls: local model presets, offline readiness, and quiet mode. */
(function(NS){
  'use strict';

  var ROOT_ID='ib-local-first-root';
  var QUIET_KEY='ib_quiet_mode';
  var MODEL_KEY='ib_local_model_draft_v1';
  var presets={
    ollama:{label:'Ollama',endpoint:'http://127.0.0.1:11434/v1/chat/completions',modelsEndpoint:'http://127.0.0.1:11434/api/tags',model:'qwen2.5:7b-instruct'},
    lmstudio:{label:'LM Studio',endpoint:'http://127.0.0.1:1234/v1/chat/completions',modelsEndpoint:'http://127.0.0.1:1234/v1/models',model:'local-model'},
    vllm:{label:'vLLM / OpenAI 兼容',endpoint:'http://127.0.0.1:8000/v1/chat/completions',modelsEndpoint:'http://127.0.0.1:8000/v1/models',model:'local-model'}
  };

  function byId(id){return document.getElementById(id)}
  function say(message){try{if(typeof toast==='function'){toast(message);return}}catch(e){}try{console.info('[Local First]',message)}catch(e2){}}
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]})}
  function localGet(key,fallback){try{var value=localStorage.getItem(key);return value==null?fallback:value}catch(e){return fallback}}
  function localSet(key,value){try{localStorage.setItem(key,value);return true}catch(e){return false}}
  function isLocalUrl(value){try{var u=new URL(String(value||'')),host=String(u.hostname||'').toLowerCase();return (u.protocol==='http:'||u.protocol==='https:')&&(host==='127.0.0.1'||host==='localhost'||host==='::1'||host==='[::1]')}catch(e){return false}}
  function storageText(value){try{return new Blob([JSON.stringify(value)]).size}catch(e){return 0}}
  function formatBytes(value){var n=Number(value)||0,units=['B','KB','MB'],i=0;while(n>=1024&&i<units.length-1){n/=1024;i++}return(i? n.toFixed(n>=10?1:2):Math.round(n))+' '+units[i]}

  function setQuietMode(enabled){
    document.documentElement.classList.toggle('ib-quiet-mode',!!enabled);
    localSet(QUIET_KEY,enabled?'1':'0');
    var toggle=byId('ib-local-first-quiet');if(toggle)toggle.checked=!!enabled;
  }

  function createRoot(){
    var root=byId(ROOT_ID);if(!root||root.dataset.mounted)return root;
    root.dataset.mounted='1';
    root.innerHTML=''
      +'<section class="ib-local-first" aria-labelledby="ib-local-first-title">'
      +'<div class="ib-local-first__intro"><span class="ib-local-first__intro-icon" aria-hidden="true">⌂</span><div><h3 id="ib-local-first-title">本地优先中心</h3><p>管理浏览器本地缓存、本机 OpenAI 兼容模型与低打扰显示。所有探测只请求 <code>127.0.0.1</code>，不会上传数据。</p></div></div>'
      +'<section class="ib-local-first__section" aria-labelledby="ib-local-res-title"><div class="ib-local-first__section-head"><div><h4 id="ib-local-res-title">离线就绪度</h4><p class="ib-local-first__hint">已缓存的文件解析库可离线使用；Python 运行时仍需你自行放置本地副本后才会完全离线。</p></div><button type="button" class="ib-local-first__button" id="ib-local-first-refresh">刷新状态</button></div><div id="ib-local-first-resources" class="ib-local-first__resource-list" aria-live="polite"></div><div class="ib-local-first__toolbar"><button type="button" class="ib-local-first__button" id="ib-local-first-open-diy">打开文件解析库</button><button type="button" class="ib-local-first__button ib-local-first__button--danger" id="ib-local-first-clear-libs">清除解析库缓存</button></div></section>'
      +'<section class="ib-local-first__section" aria-labelledby="ib-local-model-title"><div class="ib-local-first__section-head"><div><h4 id="ib-local-model-title">本机模型 <span class="ib-local-first__local-badge">OpenAI 兼容</span></h4><p class="ib-local-first__hint">可把 Ollama、LM Studio 或 vLLM 保存为真正的 API 配置。空 API Key 对本机服务有效。</p></div></div><div class="ib-local-first__model-form"><label for="ib-local-first-preset">运行时</label><select id="ib-local-first-preset"><option value="ollama">Ollama · 11434</option><option value="lmstudio">LM Studio · 1234</option><option value="vllm">vLLM · 8000</option></select><label for="ib-local-first-endpoint">聊天端点</label><input id="ib-local-first-endpoint" autocomplete="off" spellcheck="false"><label for="ib-local-first-model">模型名称</label><input id="ib-local-first-model" autocomplete="off" spellcheck="false"><label for="ib-local-first-name">显示名称</label><input id="ib-local-first-name" value="本机模型" autocomplete="off" maxlength="40"></div><div class="ib-local-first__form-actions"><button type="button" class="ib-local-first__button" id="ib-local-first-probe">探测服务</button><button type="button" class="ib-local-first__button ib-local-first__button--primary" id="ib-local-first-save">保存到 API</button></div><p id="ib-local-first-model-status" class="ib-local-first__status" aria-live="polite">尚未探测。</p></section>'
      +'<section class="ib-local-first__section" aria-labelledby="ib-local-quiet-title"><div class="ib-local-first__section-head"><div><h4 id="ib-local-quiet-title">静谧模式</h4><p class="ib-local-first__hint">关闭背景动效、玻璃模糊和长过渡，适合省电、低性能设备或专注写作。</p></div></div><div class="ib-local-first__quiet"><label for="ib-local-first-quiet"><input type="checkbox" id="ib-local-first-quiet"> 使用静谧模式</label><span id="ib-local-first-quiet-state" class="ib-local-first__status"></span></div></section>'
      +'</section>';
    bind(root);renderResources();restoreDraft();setQuietMode(localGet(QUIET_KEY,'0')==='1');
    return root;
  }

  function cachedLibraryStatus(){
    return new Promise(function(resolve){
      if(typeof indexedDB==='undefined'){resolve({available:false,count:0,bytes:0});return}
      var req=indexedDB.open('IB_LibCache');
      req.onerror=function(){resolve({available:false,count:0,bytes:0})};
      req.onsuccess=function(){
        var database=req.result;
        if(!database.objectStoreNames.contains('libs')){database.close();resolve({available:true,count:0,bytes:0});return}
        try{
          var tx=database.transaction('libs','readonly'),store=tx.objectStore('libs'),all=store.getAll();
          all.onsuccess=function(){var values=all.result||[];database.close();resolve({available:true,count:values.length,bytes:values.reduce(function(total,item){return total+storageText(item)},0)})};
          all.onerror=function(){database.close();resolve({available:false,count:0,bytes:0})};
        }catch(e){try{database.close()}catch(ignore){}resolve({available:false,count:0,bytes:0})}
      };
    });
  }

  async function renderResources(){
    var box=byId('ib-local-first-resources');if(!box)return;
    box.innerHTML='<div class="ib-local-first__resource"><strong>正在检查…</strong><span>读取浏览器本地缓存</span></div>';
    var libs=await cachedLibraryStatus();
    var browserCached=navigator.onLine===false?'离线中':'按浏览器缓存策略';
    var pyLocal=false;
    try{pyLocal=typeof window._WS_PY_LOCAL_BASE==='string'&&isLocalUrl(window._WS_PY_LOCAL_BASE)}catch(e){}
    box.innerHTML=''
      +'<div class="ib-local-first__resource"><strong>文件解析库</strong><span>'+(libs.available?(libs.count?'已缓存 '+libs.count+' 项 · '+formatBytes(libs.bytes):'尚未缓存'):'当前浏览器不可读取')+'</span></div>'
      +'<div class="ib-local-first__resource"><strong>界面资源</strong><span>'+browserCached+'；字体使用系统回退，不阻塞离线打开</span></div>'
      +'<div class="ib-local-first__resource"><strong>Python 沙箱</strong><span>'+(pyLocal?'已指向本机运行时':'默认按需获取 Pyodide；未完整离线化')+'</span></div>';
  }

  function draft(){
    return {preset:byId('ib-local-first-preset').value,endpoint:byId('ib-local-first-endpoint').value.trim(),model:byId('ib-local-first-model').value.trim(),name:byId('ib-local-first-name').value.trim()};
  }
  function persistDraft(){localSet(MODEL_KEY,JSON.stringify(draft()))}
  function applyPreset(name){
    var preset=presets[name]||presets.ollama;
    byId('ib-local-first-preset').value=name in presets?name:'ollama';
    byId('ib-local-first-endpoint').value=preset.endpoint;
    byId('ib-local-first-model').value=preset.model;
    var status=byId('ib-local-first-model-status');if(status)status.textContent='已填入 '+preset.label+' 默认端点；可按你的本机模型名称修改。';
    persistDraft();
  }
  function restoreDraft(){
    var value=null;try{value=JSON.parse(localGet(MODEL_KEY,'null'))}catch(e){}
    if(value&&presets[value.preset]){
      byId('ib-local-first-preset').value=value.preset;
      byId('ib-local-first-endpoint').value=value.endpoint||presets[value.preset].endpoint;
      byId('ib-local-first-model').value=value.model||presets[value.preset].model;
      byId('ib-local-first-name').value=value.name||'本机模型';
    }else applyPreset('ollama');
  }
  function endpointToModels(endpoint,preset){
    var item=presets[preset];
    if(item&&endpoint===item.endpoint)return item.modelsEndpoint;
    try{var url=new URL(endpoint);url.pathname=url.pathname.replace(/\/v1\/chat\/completions?$/,'/v1/models');url.search='';return url.toString()}catch(e){return item?item.modelsEndpoint:''}
  }
  function modelsFromPayload(payload,preset){
    if(payload&&Array.isArray(payload.models))return payload.models.map(function(item){return typeof item==='string'?item:(item.name||item.model||item.id||'')}).filter(Boolean);
    if(payload&&Array.isArray(payload.data))return payload.data.map(function(item){return item&&item.id}).filter(Boolean);
    return [];
  }
  async function probeModel(){
    var state=byId('ib-local-first-model-status'),button=byId('ib-local-first-probe'),info=draft();
    if(!isLocalUrl(info.endpoint)){state.textContent='为避免误把数据发到外部，探测仅允许 localhost / 127.0.0.1 端点。';return}
    var modelsUrl=endpointToModels(info.endpoint,info.preset);
    button.disabled=true;button.textContent='探测中…';state.textContent='正在连接 '+modelsUrl+' …';
    try{
      var controller=new AbortController(),timer=setTimeout(function(NS){controller.abort()},4000);
      var response=await fetch(modelsUrl,{cache:'no-store',signal:controller.signal});clearTimeout(timer);
      if(!response.ok)throw new Error('HTTP '+response.status);
      var payload=await response.json(),models=modelsFromPayload(payload,info.preset);
      if(models.length){byId('ib-local-first-model').value=models[0];persistDraft();state.textContent='服务可用，发现 '+models.length+' 个模型；已选 '+models[0]+'。'}
      else state.textContent='服务可用，但未返回模型列表；请手动填写模型名称。';
    }catch(error){state.textContent='未能连接本机模型：'+(error&&error.name==='AbortError'?'超时':String(error&&error.message||error))+'。请确认服务已启动且允许浏览器访问。'}
    finally{button.disabled=false;button.textContent='探测服务'}
  }
  async function saveModel(){
    var state=byId('ib-local-first-model-status'),button=byId('ib-local-first-save'),info=draft();
    if(!isLocalUrl(info.endpoint)){state.textContent='仅允许保存 localhost / 127.0.0.1 本机模型端点。';return}
    if(!info.model){state.textContent='请填写模型名称。';return}
    if(typeof window._persistApiConfig!=='function'||typeof window.dbGetAll!=='function'){state.textContent='数据库仍在初始化，请稍后重试。';return}
    button.disabled=true;button.textContent='保存中…';
    try{
      var all=await window.dbGetAll('apiConfigs'),existing=all.find(function(item){return item&&item.localRuntime&&item.localRuntime.endpoint===info.endpoint})||null;
      if(!existing&&all.filter(function(item){return item&&!item.archived}).length>=10){throw new Error('API 配置已达到 10 个上限；请先归档或删除一个配置')}
      var cfg=Object.assign({},existing||{}, {id:existing?existing.id:'local_'+Date.now().toString(36),provider:'custom',apiKey:'',model:info.model,endpoint:info.endpoint,systemPrompt:existing&&existing.systemPrompt||'',nickname:info.name||info.model,relationship:existing&&existing.relationship||'',temperature:existing&&existing.temperature!=null?existing.temperature:0.8,vision:existing&&existing.vision!==undefined?!!existing.vision:true,streaming:true,promptCache:false,created:existing&&existing.created||Date.now(),localRuntime:{name:(presets[info.preset]||{}).label||info.preset,endpoint:info.endpoint,configuredAt:Date.now()}});
      await window._persistApiConfig(cfg);
      if(typeof window.loadApiConfigs==='function')await window.loadApiConfigs();
      if(typeof window.renderApiList==='function')await window.renderApiList();
      persistDraft();state.textContent='已保存为 API「'+cfg.nickname+'」；本机服务不需要填写 API Key。';say('本机模型已保存到 API 配置');
    }catch(error){state.textContent='保存失败：'+String(error&&error.message||error)}
    finally{button.disabled=false;button.textContent='保存到 API'}
  }
  async function clearLibraries(){
    if(typeof window._ibLibClear!=='function'){say('解析库缓存尚未初始化。');return}
    try{await window._ibLibClear();if(typeof window._ibRichLibsRefreshCard==='function')await window._ibRichLibsRefreshCard();await renderResources();say('已清除本地解析库缓存。')}catch(e){say('清除缓存失败。')}
  }
  function openDiy(){try{if(typeof navTo==='function')navTo('diy');window.setTimeout(function(NS){var card=byId('ib-richlib-card');if(card)card.scrollIntoView({behavior:'smooth',block:'start'})},80)}catch(e){}}
  function bind(root){
    byId('ib-local-first-refresh').addEventListener('click',renderResources);
    byId('ib-local-first-open-diy').addEventListener('click',openDiy);
    byId('ib-local-first-clear-libs').addEventListener('click',clearLibraries);
    byId('ib-local-first-preset').addEventListener('change',function(){applyPreset(this.value)});
    ['ib-local-first-endpoint','ib-local-first-model','ib-local-first-name'].forEach(function(id){byId(id).addEventListener('change',persistDraft)});
    byId('ib-local-first-probe').addEventListener('click',probeModel);
    byId('ib-local-first-save').addEventListener('click',saveModel);
    byId('ib-local-first-quiet').addEventListener('change',function(){setQuietMode(this.checked);var state=byId('ib-local-first-quiet-state');if(state)state.textContent=this.checked?'已减少动效与 GPU 负担':'使用完整视觉效果';});
  }
  function boot(){createRoot();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();

/* ---- window.IB 命名空间迁移：登记导出（纯自包含模块，无外部调用方） ---- */
NS.expose('localfirst', { setQuietMode: setQuietMode, isLocalUrl: isLocalUrl, cachedLibraryStatus: cachedLibraryStatus });
})(window.IB || (window.IB = {}));