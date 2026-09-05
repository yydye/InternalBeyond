/* ====================================================================
   IB Apps — 应用商店 + manifest/loader 运行时（App Store）
   --------------------------------------------------------------------
   - 清单：fetch('apps/catalog.json')；file:// 退回 <script src="apps/catalog.js"> → window.IB_APP_CATALOG。
   - 安装/卸载：enable 集合存 localStorage `ib_apps_on_v1`（app id -> 1）。
   - 外部 APP：按需注入 <script src="apps/<file>">（同源 'self'，本地离线运行）。
   - 应用契约（register 校验）：{ id, name, version, sdk<=2, icon, mount(body, ctx), back?, unmount? }。
     遵守宿主安全边界：App 只经 ctx 与主程序对话，不直接触碰底层 db 写入 / 发送函数；隔离是"按接口收窄"，非强制沙箱。
   - 与既有 split 约定一致：IIFE + window 双挂载 + IB.apps 注册。
   ==================================================================== */
(function(NS){
  'use strict';
  var CATALOG_URL='apps/catalog.json';
  var CATALOG_JS='apps/catalog.js';
  var ON_KEY='ib_apps_on_v1';
  var ID_RE=/^[a-z][a-z0-9_-]{1,31}$/;
  var _catalog=null,_defs={},_enabled={},_loaded={},_missing={},_activeShell=null,_activeId=null,_ev={};

  function _toast(m){try{if(typeof toast==='function')toast(m);return}catch(e){}try{console.info('[Apps]',m)}catch(e2){}}
  function _onLoad(key){try{return JSON.parse(localStorage.getItem(key)||'{}')}catch(e){return{}}}
  function _save(key,v){try{localStorage.setItem(key,JSON.stringify(v))}catch(e){}}

  /* ---- 清单加载：fetch → script fallback ---- */
  function _catFromJs(){try{return (window.IB_APP_CATALOG&&window.IB_APP_CATALOG.apps)?window.IB_APP_CATALOG:null}catch(e){return null}}
  function _loadCatalogJs(){return new Promise(function(resolve){
    if(window.IB_APP_CATALOG&&window.IB_APP_CATALOG.apps){resolve(_catFromJs());return}
    var sc=document.createElement('script');sc.src=CATALOG_JS;sc.onload=function(){resolve(_catFromJs())};sc.onerror=function(){resolve(null)};document.head.appendChild(sc);
  });}
  async function _boot(){
    _enabled=_onLoad(ON_KEY);
    var cat=null;
    try{var r=await fetch(CATALOG_URL,{cache:'no-store'});if(r.ok)cat=await r.json()}catch(e){cat=null}
    if(!cat||!cat.apps)cat=await _loadCatalogJs();
    _catalog=(cat&&cat.apps)||[];
    /* 预检已安装的外部 APP 是否已注册；未注册则按需加载 */
    for(var a of _catalog){
      if(a&&a.builtin)continue;
      if(_enabled[a.id]&&a.file&&a.file!=='inline'&&!_defs[a.id])_load(a);
    }
    if(typeof currentPage!=='undefined'&&currentPage==='apps'&&typeof renderAppStore==='function'){try{renderAppStore()}catch(e){}}
    return _catalog;
  }

  /* ---- 外部 APP 脚本注入 ---- */
  function _load(a){
    if(!a||!a.file||a.file==='inline'||_loaded[a.id]||_defs[a.id])return;
    var sc=document.createElement('script');sc.src='apps/'+String(a.file).replace(/^\/+/,'');sc.defer=true;sc.dataset.ibapp=a.id;
    sc.onerror=function(){_missing[a.id]=1;delete _loaded[a.id];try{sc.remove()}catch(e){}if(typeof renderAppStore==='function'){try{renderAppStore()}catch(e){}}};
    sc.onload=function(){if(typeof renderAppStore==='function'){try{renderAppStore()}catch(e){}}};
    _loaded[a.id]=sc;document.head.appendChild(sc);
  }

  /* ---- 注册契约 ---- */
  function register(def){
    if(!def||typeof def.id!=='string'||!ID_RE.test(def.id))return false;
    if(def.sdk&&def.sdk>2)return false;
    if(typeof def.mount!=='function')return false;
    _defs[def.id]=def;return true;
  }

  /* ---- SDK：storage（localStorage 命名空间） ---- */
  function _storage(appId){
    function _k(k){return 'ib_app_'+appId+'_'+k}
    return {
      get:function(k){return _onLoad(_k(k))},
      set:function(k,v){_save(_k(k),v)},
      remove:function(k){try{localStorage.removeItem(_k(k))}catch(e){}},
      list:function(){var out={};for(var i=0;i<localStorage.length;i++){var key=localStorage.key(i);if(key&&key.indexOf('ib_app_'+appId+'_')===0)out[key.slice(('ib_app_'+appId+'_').length)]=_onLoad(key)}return out},
      clear:function(){for(var i=localStorage.length-1;i>=0;i--){var key=localStorage.key(i);if(key&&key.indexOf('ib_app_'+appId+'_')===0)localStorage.removeItem(key)}}
    };
  }

  /* ---- SDK：blog ---- */
  function _blogApi(){
    function _esc(s){if(!s)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
    return {
      render:function(t){return _esc(t).replace(/\n\n+/g,'</p><p>').replace(/\n/g,'<br>')},
      list:async function(){if(typeof dbGetAll!=='function')return[];var all=await dbGetAll('posts');return all.filter(function(p){return p&&!p.locked}).map(function(p){return{id:p.id,title:p.title||'',subtitle:p.subtitle||'',content:p.content||''}})},
      get:async function(pid){if(typeof dbGet!=='function')return null;return await dbGet('posts',pid)}
    };
  }

  /* ---- SDK：chat ---- */
  function _chatApi(def){
    return {
      current:function(){return apiConfigs&&apiConfigs.find(function(a){return a.id===activeFriendId})||(apiConfigs&&apiConfigs[0])||null},
      list:function(){return (apiConfigs||[]).map(function(a){return{id:a.id,nickname:a.nickname||a.model||'AI',model:a.model||'',avatar:a.avatar||''}})},
      open:function(cid){if(typeof selectFriend==='function'){selectFriend(cid)}else{activeFriendId=cid}},
      openThread:async function(cid,o){
        o=o||{};
        if(typeof dbPut==='function'){
          var tid='thread_'+Date.now();
          var thr={id:tid,friendId:String(cid),name:(o.name||'新话题'),memoryEnabled:!!o.memoryEnabled,created:Date.now()};
          await dbPut('chatThreads',thr);
          if(typeof selectThread==='function')selectThread(cid,tid);
          else{activeFriendId=cid;activeThreadId=tid}
          return tid;
        }
        return null;
      },
      recent:async function(n){n=n||30;if(typeof dbGetAll!=='function')return[];var all=await dbGetAll('chatMessages');var list=all.filter(function(m){return m.friendId===String(activeFriendId)}).sort(function(a,b){return a.timestamp-b.timestamp});return list.slice(-n)},
      send:function(text,o){o=o||{};if(o.friendId)activeFriendId=o.friendId;if(o.threadId)activeThreadId=o.threadId;if(typeof sendChatMessage==='function'){sendChatMessage.call(window);if(currentPage==='chat')loadFriendsList()}},
      canSee:function(cid){var c=(apiConfigs||[]).find(function(a){return a.id===cid});return c?_ibModelCanSee(c):false},
      avatars:function(cid){var c=(apiConfigs||[]).find(function(a){return a.id===cid});return c&&c.avatar?c.avatar:''},
      busy:function(){return false},
      deleteThread:function(tid){if(typeof deleteThread==='function')deleteThread(tid)},
      mark:function(){},
      nudge:function(o){o=o||{};if(o.kind&&typeof window.IB!=='undefined'&&IB.activity&&typeof IB.activity.nudge==='function'){try{IB.activity.nudge(o)}catch(e){}}}
    };
  }

  /* ---- SDK：sys（系统常量块，经 window._ibAppSys 交由 activity 上下文读取） ---- */
  function _sysApi(def){
    return {
      set:function(o){o=o||{};try{window._ibAppSys={appId:def.id,text:o.text||'',cfgId:o.cfgId||'',data:o.data||null}}catch(e){}},
      clear:function(){try{window._ibAppSys=null}catch(e){}}
    };
  }

  /* ---- SDK：ai ---- */
  function _aiApi(){
    return {
      call:async function(prompt,o){
        o=o||{};
        var cfg=(apiConfigs||[]).find(function(a){return a.id===o.cfgId})||(apiConfigs||[]).find(function(a){return a.id===activeFriendId})||(apiConfigs||[])[0];
        if(!cfg||typeof callApiChat!=='function')return'';
        var msgs=[{role:'system',content:o.system||cfg.systemPrompt||''},{role:'user',content:prompt}];
        try{return await callApiChat(cfg,msgs,{maxTokens:o.maxTokens||600,wantMeta:false,jsonMode:false,disableTools:true,_noWebSearch:true})}catch(e){return''}
      }
    };
  }

  /* ---- SDK：ui ---- */
  function _uiApi(){
    return {
      toast:function(m){_toast(m)},
      confirm:function(m){try{return confirm(m)}catch(e){return false}},
      theme:function(){return (document.body.classList.contains('theme-infernal'))?'dark':'light'},
      msgEl:function(){return''},
      typingEl:function(){return''},
      close:function(){closeActive()}
    };
  }

  /* ---- 事件订阅（on/off/emit） ---- */
  function _on(id,ev,fn){(_ev[id]=_ev[id]||{})[ev]=(_ev[id][ev]||[]);(_ev[id][ev]).push(fn);return (function(){})()}
  function _off(id,ev,fn){var a=_ev[id]&&_ev[id][ev];if(a&&fn){var i=a.indexOf(fn);if(i>=0)a.splice(i,1);return true}if(a)a.length=0;return true}
  function _emit(id,ev,payload){var a=_ev[id]&&_ev[id][ev];if(a){for(var i=0;i<a.length;i++){try{a[i](payload)}catch(e){}}}}

  function _ctx(def){
    return {
      app:{id:def.id,name:def.name,version:def.version},
      storage:_storage(def.id),
      chat:_chatApi(def),
      blog:_blogApi(),
      sys:_sysApi(def),
      ai:_aiApi(),
      ui:_uiApi(),
      on:function(ev,fn){_on(def.id,ev,fn)},
      off:function(ev,fn){_off(def.id,ev,fn)},
      emit:function(ev,payload){_emit(def.id,ev,payload)}
    };
  }

  /* ---- host page mount / unmount ---- */
  function _ensureShell(){
    var ov=document.getElementById('ib-app-overlay');
    if(ov)return ov;
    ov=document.createElement('div');ov.id='ib-app-overlay';ov.className='ibapp-overlay';
    ov.innerHTML='<div class="ibapp-head"><button class="ibapp-back" type="button">‹ 返回</button><span class="ibapp-title"></span></div><div class="ibap-host"></div>';
    document.body.appendChild(ov);
    ov.querySelector('.ibapp-back').onclick=function(){closeEach()};
    return ov;
  }
  /* 每次都真正卸载并移除 overlay DOM，避免 video/字幕/弹幕残留 */
  function closeEach(){closeActive()}
  async function open(id){
    var def=_defs[id];
    if(!def){
      /* builtin 内联 App（如 coread）不经 register 注册到 _defs；从清单识别并作为页面打开 */
      var cat=(_catalog||[]).find(function(a){return a&&a.id===id&&a.builtin&&a.file==='inline'});
      if(cat&&typeof navTo==='function'){navTo(cat.page||cat.id);return}
      _toast('该应用尚未加载（file 缺失或未注册）：'+id);return
    }
    if(def.builtin&&def.inline&&typeof navTo==='function'){navTo(def.page||'coread');return}
    var shell=_ensureShell();
    var titleEl=shell.querySelector('.ibapp-title');
    var body=shell.querySelector('.ibap-host');
    if(def.headless)shell.classList.add('headless');else shell.classList.remove('headless');
    if(def.wall)shell.classList.add('wall');else shell.classList.remove('wall');
    if(titleEl)titleEl.textContent=def.name||def.id;
    shell.classList.add('show');document.body.classList.add('ibapp-open');
    _activeShell=shell;_activeId=id;
    body.innerHTML='';
    try{
      var ret=def.mount(body,_ctx(def));
      if(ret&&typeof ret.then==='function')await ret;
    }catch(e){_toast('应用启动失败：'+(e&&e.message||e))}
  }
  function closeActive(){
    var def=_defs[_activeId];
    if(def&&typeof def.unmount==='function'){try{def.unmount()}catch(e){}}
    if(_activeShell){try{_activeShell.remove()}catch(e){}_activeShell=null}
    document.body.classList.remove('ibapp-open');
    _activeId=null;
  }
  function isOpen(){return !!_activeId}
  function closeIfOpen(){if(_activeId)closeActive();return true}

  /* ---- 安装 / 卸载 ---- */
  function _onMap(){
    var m={};
    for(var k in _enabled)if(_enabled[k])m[k]=1;
    for(var a of (_catalog||[]))if(a&&a.builtin)m[a.id]=1;
    return m;
  }
  function _setOn(id,on){if(on)_enabled[id]=1;else delete _enabled[id];_save(ON_KEY,_enabled)}
  function install(id){_setOn(id,true);var a=(_catalog||[]).find(function(x){return x&&x.id===id});if(a&&a.file&&a.file!=='inline'&&!_defs[id])_load(a);return true}
  function uninstall(id){
    var a=(_catalog||[]).find(function(x){return x&&x.id===id});
    if(a&&a.builtin)return false;
    _setOn(id,false);
    if(_activeId===id)closeActive();
    return true;
  }
  function isInstalled(id){return !!_onMap()[id]}
  function listEnabled(){return Object.keys(_onMap())}

  /* ---- App Store 页渲染 ---- */
  function _escHtml(s){if(!s)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
  function renderAppStore(){
    var grid=document.getElementById('appstore-grid');if(!grid)return;
    var list=_catalog||[];
    if(!list.length){grid.innerHTML='<div class="empty-state"><span>></span>没有读到 APP 目录（apps/catalog.json）。</div>';return}
    grid.innerHTML=list.map(function(a){
      if(!a||!a.id)return'';
      var on=isInstalled(a.id);
      var icon=a.icon||'';
      var btnOn = a.builtin ? ('<button class="appstore-btn primary" data-open="'+a.id+'" type="button">打开</button>')
        : (on ? ('<button class="appstore-btn primary" data-open="'+a.id+'" type="button">打开</button><button class="appstore-btn" data-off="'+a.id+'" type="button">卸载</button>')
             : ('<button class="appstore-btn" data-on="'+a.id+'" type="button">安装</button>'));
      return '<div class="appstore-card"><svg viewBox="0 0 24 24">'+(icon||'')+'</svg>'+
        '<div class="appstory-name">'+_escHtml(a.name||a.id)+'</div>'+
        '<div class="appstore-desc">'+_escHtml(a.desc||'')+'</div>'+
        '<div class="appstore-actions">'+btnOn+'</div></div>';
    }).join('');
    var opens=grid.querySelectorAll('[data-open]');for(var i=0;i<opens.length;i++)(function(el){el.onclick=function(){open(el.getAttribute('data-open'))}})(opens[i]);
    var ons=grid.querySelectorAll('[data-on]');for(var j=0;j<ons.length;j++)(function(el){el.onclick=function(){install(el.getAttribute('data-on'));renderAppStore()}})(ons[j]);
    var offs=grid.querySelectorAll('[data-off]');for(var k=0;k<offs.length;k++)(function(el){el.onclick=function(){uninstall(el.getAttribute('data-off'));renderAppStore()}})(offs[k]);
  }

  /* 宿主 → 当前打开 App 的事件广播（供 ctx.on('turn'|'delta'|'message') 订阅）。
     幂等：无 App 打开时是 no-op；对未打开的 App 不投递；异常被 try 隔离。 */
  function broadcast(ev,payload){if(!_activeId||!_ev[_activeId]||!_ev[_activeId][ev])return;var a=_ev[_activeId][ev];for(var i=0;i<a.length;i++){try{a[i](payload)}catch(e){}}}

  /* ---- 注册：window + IB.apps ---- */
  var api={boot:_boot,register:register,open:open,close:closeActive,closeEach:closeEach,isOpen:isOpen,closeIfOpen:closeIfOpen,install:install,uninstall:uninstall,
    isInstalled:isInstalled,listEnabled:listEnabled,catalog:function(){return _catalog||[]},defs:function(){return _defs},emit:_emit,broadcast:broadcast};
  NS.apps=api;
  window.IBApps=api;
  window.renderAppStore=renderAppStore;
  if(typeof document!=='undefined'){(function(){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){IB.apps.boot()});else IB.apps.boot()})();}
})(window.IB || (window.IB = {}));
