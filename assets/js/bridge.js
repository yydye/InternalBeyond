/* ===================== IB Bridge 增强（本地一键后端配套） =====================
   依赖 ib-bridge-service.js（一键 start-bridge-service.cmd）。
   提供：默认桥接地址、表情渲染、点歌播放、上下文进度条、
   心语墙 / 生活看板 / 状态导航面板、/continue 自动续写。
   全部 fail-open：Bridge 没启动时不影响原功能。 */
(function(NS){
'use strict';

function ibBridgeBase(){
  try{ var v=localStorage.getItem('ib_bridge_http'); if(v) return String(v).replace(/\/+$/,''); }catch(e){}
  return 'http://127.0.0.1:23115';
}
window.ibBridgeBase = ibBridgeBase;

/*
 * Bridge REST authentication deliberately reuses the existing IBNET token
 * field.  It remains in browser local storage exactly as it did for the WS
 * hello frame; this wrapper only sends it as a header, never in a URL.  That
 * keeps LAN mode compatible without leaking a token into history or logs.
 */
function ibBridgeToken(){
  try{
    if(typeof IBNET!=='undefined' && IBNET && typeof IBNET.cfg==='function'){
      return String(IBNET.cfg().token||'').trim();
    }
  }catch(e){}
  return '';
}
function ibBridgeFetch(input, options){
  var opt=options?Object.assign({},options):{};
  var token=ibBridgeToken();
  if(token){
    /* `Headers` is available in modern browsers, but keeping a plain-object
       fallback preserves direct-file use in older embedded WebViews. */
    if(typeof Headers==='function'){
      var headers=new Headers(opt.headers||{});
      headers.set('Authorization','Bearer '+token);
      opt.headers=headers;
    }else{
      opt.headers=Object.assign({},opt.headers||{}, {Authorization:'Bearer '+token});
    }
  }
  return fetch(input,opt);
}
function ibBridgeAssetUrl(pathname){
  return ibBridgeBase()+pathname;
}
function ibBridgeLoadImage(img, pathname, fallbackPath){
  if(!img)return;
  /* img/audio HTML elements cannot attach Authorization. Fetching protected
     media into a Blob keeps the token in a request header rather than a URL. */
  ibBridgeFetch(ibBridgeAssetUrl(pathname),{cache:'no-store'}).then(function(r){
    if(!r.ok)throw new Error('asset '+r.status);
    return r.blob();
  }).then(function(blob){
    var objectUrl=URL.createObjectURL(blob);
    img.onload=function(){ setTimeout(function(NS){ try{URL.revokeObjectURL(objectUrl);}catch(e){} },0); };
    img.onerror=function(){ try{URL.revokeObjectURL(objectUrl)}catch(e){} if(fallbackPath)ibBridgeLoadImage(img,fallbackPath);else img.style.display='none'; };
    img.src=objectUrl;
  }).catch(function(NS){
    if(fallbackPath)ibBridgeLoadImage(img,fallbackPath);else img.style.display='none';
  });
}
function ibBridgeLoadAudio(pathname, done, failed){
  var token=ibBridgeToken();
  if(!token){ done(ibBridgeAssetUrl(pathname),false); return; }
  ibBridgeFetch(ibBridgeAssetUrl(pathname),{cache:'no-store'}).then(function(r){
    if(!r.ok)throw new Error('asset '+r.status);
    return r.blob();
  }).then(function(blob){ done(URL.createObjectURL(blob),true); }).catch(function(NS){ if(failed)failed(); });
}
window.ibBridgeFetch=ibBridgeFetch;

var _ibToastEl=null;
function ibToast(m){ try{ if(typeof toast==='function'){toast(m);return;} }catch(e){} var s=String(m||''); try{ console.log(s); }catch(e2){} try{ if(!_ibToastEl){ _ibToastEl=document.createElement('div'); _ibToastEl.id='ib-toast-fallback'; _ibToastEl.style.cssText='position:fixed;bottom:120px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 22px;border-radius:10px;background:rgba(16,22,38,.92);border:1px solid rgba(140,200,255,.35);color:#e0edff;font-size:.82rem;font-family:\"Noto Sans SC\",sans-serif;pointer-events:none;opacity:0;transition:opacity .3s ease;max-width:85vw;text-align:center;word-break:break-word'; document.body.appendChild(_ibToastEl); } _ibToastEl.textContent=s; _ibToastEl.style.opacity='1'; clearTimeout(_ibToastEl._t); _ibToastEl._t=setTimeout(function(NS){ _ibToastEl.style.opacity='0'; },2500); }catch(e){} }
function ibEsc(s){ try{ if(typeof esc==='function')return esc(s); }catch(e){} return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]}) }

/* ---------- 默认桥接地址：为空时自动填入本地地址 ---------- */
function ibNetDefaults(){
  try{
    if(typeof IBNET==='undefined')return;
    var c=IBNET.cfg();
    if(!c.url){ c.url='ws://127.0.0.1:23115'; IBNET.save(c); }
  }catch(e){}
}

/* ---------- 表情 / 点歌标记渲染 ---------- */
function ibRichifyText(tn){
  var text=tn.nodeValue;
  if(!text||text.indexOf('[sticker:')===-1&&text.indexOf('[music:')===-1)return false;
  var re=/\[sticker:([A-Za-z0-9_\-\u4e00-\u9fa5]+)\]|\[music:([A-Za-z0-9]+)(?:\|([^\]]+))?\]/g;
  if(!re.test(text))return false;
  re.lastIndex=0;
  var frag=document.createDocumentFragment(),last=0,m,base=ibBridgeBase();
  while((m=re.exec(text))){
    if(m.index>last)frag.appendChild(document.createTextNode(text.slice(last,m.index)));
    if(m[1]){
      var img=document.createElement('img');
      img.className='ib-sticker';
      var stickerName=m[1];
      img.alt='[sticker:'+stickerName+']';img.title=stickerName;
      ibBridgeLoadImage(img,'/stickers/'+encodeURIComponent(stickerName)+'.png','/stickers/'+encodeURIComponent(stickerName)+'.svg');
      frag.appendChild(img);
    }else if(m[2]){
      var btn=document.createElement('button');
      btn.type='button';btn.className='ib-music-btn';
      btn.textContent='♪ '+(m[3]||('歌曲 '+m[2]));
      btn.title='播放：'+(m[3]||m[2]);
      btn.onclick=function(id,name){return function(){ window.ibMusicPlay(id,name); }}(m[2],m[3]||'');
      frag.appendChild(btn);
    }
    last=re.lastIndex;
  }
  if(last<text.length)frag.appendChild(document.createTextNode(text.slice(last)));
  tn.parentNode.replaceChild(frag,tn);
  return true;
}

function ibRichifyEl(root){
  if(!root||root.nodeType!==1)return;
  var targets;
  if(root.classList&&root.classList.contains('r-text'))targets=[root];
  else if(root.querySelectorAll)targets=Array.prototype.slice.call(root.querySelectorAll('.r-text'));
  targets.forEach(function(el){
    var walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null);
    var tns=[];while(walker.nextNode())tns.push(walker.currentNode);
    tns.forEach(function(tn){ try{ ibRichifyText(tn); }catch(e){} });
  });
}

function ibRichifyAny(root){
  if(!root)return;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null);
  var tns=[];while(walker.nextNode())tns.push(walker.currentNode);
  tns.forEach(function(tn){ try{ ibRichifyText(tn); }catch(e){} });
}

function ibObserve(){
  ['chat-full-messages','chat-messages'].forEach(function(id){
    var el=document.getElementById(id);
    if(!el||el._ibObserved)return;
    el._ibObserved=true;
    try{ ibRichifyEl(el); }catch(e){}
    try{ ibAttachTts(el); }catch(e){}
    var mo=new MutationObserver(function(muts){
      muts.forEach(function(mu){
        mu.addedNodes.forEach(function(n){
          if(n&&n.nodeType===1){
            try{ ibRichifyEl(n); }catch(e){}
            try{ ibAttachTts(n); }catch(e){}
          }
        });
      });
    });
    mo.observe(el,{childList:true,subtree:true});
  });
}

/* ---------- 表情选择按钮 ---------- */
function ibAddStickerButtons(){
  ['chat-input','chat-full-input'].forEach(function(id){
    var inp=document.getElementById(id);
    if(!inp||inp.dataset.ibSticker)return;
    inp.dataset.ibSticker='1';
    var btn=document.createElement('button');
    btn.type='button';btn.className='ib-sticker-btn';btn.textContent='◉';
    btn.title='表情（需 Bridge 已启动）';
    btn.onclick=function(ev){ ev.preventDefault();ev.stopPropagation();ibStickerPop(btn,inp); };
    inp.parentNode.insertBefore(btn,inp);
  });
}

function ibStickerPop(anchor,inp){
  var old=document.getElementById('ib-sticker-pop');if(old)old.remove();
  var pop=document.createElement('div');pop.id='ib-sticker-pop';
  pop.textContent='加载中…';
  var wrap=anchor.parentNode;
  if(!wrap)return;
  if(wrap&&getComputedStyle(wrap).position==='static')wrap.style.position='relative';
  wrap.appendChild(pop);
  ibBridgeFetch(ibBridgeBase()+'/stickers',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
    pop.textContent='';
    var list=(j&&j.stickers)||[];
    if(!list.length){ pop.textContent='暂无表情，可往 '+ibBridgeBase()+' 的 stickers 目录放图。'; return; }
    list.forEach(function(s){
      var img=document.createElement('img');
      img.className='ib-sticker-opt';
      ibBridgeLoadImage(img,'/stickers/'+encodeURIComponent(s.file));
      img.title=s.name;
      img.onclick=function(){ inp.value+='[sticker:'+s.name+'] ';inp.focus();_ibClosePop(); };
      pop.appendChild(img);
    });
  }).catch(function(NS){ pop.textContent='Bridge 未连接，无法加载表情（先运行 start-bridge-service.cmd）。'; });
  /* 修复：统一关闭函数，pop 被移除时同步注销 document 级监听器，避免每次弹窗累积一个常驻监听 */
  function _ibClosePop(){ pop.remove(); document.removeEventListener('click',_ibStickerDismiss,true); }
  function _ibStickerDismiss(ev){ if(!pop.contains(ev.target)){ _ibClosePop(); } }
  setTimeout(function(NS){ document.addEventListener('click',_ibStickerDismiss,true); },0);
}

/* ---------- 点歌播放 ---------- */
window.ibMusicPlay=function(id,title){
  var sid=String(id||'').trim();
  if(!sid){ ibToast('歌曲 ID 无效'); return; }
  var name=String(title||'');
  ibBridgeFetch(ibBridgeBase()+'/api/music/open?id='+encodeURIComponent(sid)+(name?'&name='+encodeURIComponent(name):''),{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
    if(!j||!j.ok){ ibToast('打不开这首歌：'+(j&&j.error||'未知错误')); return; }
    var shown=name||j.name||('歌曲 '+sid);
    if(j.deepLink){
      /* 尝试唤起本机酷狗客户端/App；失败静默，由网页兜底 */
      try{
        var f=document.createElement('iframe');
        f.style.display='none';
        f.src=j.deepLink;
        document.body.appendChild(f);
        setTimeout(function(NS){ try{ f.remove(); }catch(e){} },2000);
      }catch(e){}
    }
    if(j.webUrl){
      try{ window.open(j.webUrl,'_blank'); }catch(e){}
    }
    ibToast('已为你打开'+(j.provider==='netease'?'网易云':'酷狗')+'《'+shown+'》');
  }).catch(function(NS){
    /* Bridge 未启动时也尽量直接打开酷狗网页 */
    try{
      window.open('https://www.kugou.com/song/#hash='+encodeURIComponent(sid),'_blank');
      ibToast('已为你打开酷狗《'+(name||('歌曲 '+sid))+'》');
    }catch(e){ ibToast('Bridge 未连接，且无法打开酷狗'); }
  });
};

/* ---------- 上下文进度条 ---------- */
function ibCtxLocalGet(friend){
  try{
    var m=JSON.parse(localStorage.getItem('ib_ctx_local')||'{}');
    var arr=m[friend]||[];
    var recent=arr.slice(-16).reduce(function(s,r){return s+(r.i||0)+(r.o||0)+(r.cr||0)+(r.cw||0)},0);
    return {recent:recent,arr:arr};
  }catch(e){ return {recent:0,arr:[]}; }
}
function ibCtxLocalAdd(friend,u){
  try{
    var m=JSON.parse(localStorage.getItem('ib_ctx_local')||'{}');
    var arr=m[friend]||[];
    arr.push({t:Date.now(),i:u.input_tokens||0,o:u.output_tokens||0,cr:u.cached_tokens||0,cw:u.cache_creation_tokens||0});
    if(arr.length>200)arr.splice(0,arr.length-200);
    m[friend]=arr;localStorage.setItem('ib_ctx_local',JSON.stringify(m));
  }catch(e){}
}

function ibCtxInit(){
  var host=document.getElementById('chat-full-messages');
  if(!host)return false;
  if(document.getElementById('ib-ctx-bar'))return true;
  var bar=document.createElement('div');bar.id='ib-ctx-bar';
  var fill=document.createElement('div');fill.className='ib-ctx-fill';
  var label=document.createElement('span');label.className='ib-ctx-label';
  bar.appendChild(fill);bar.appendChild(label);
  host.parentNode.insertBefore(bar,host);
  return true;
}

async function ibCtxRefresh(){
  try{
    if(!ibCtxInit())return;
    var friend=(typeof activeFriendId!=='undefined'&&activeFriendId)?activeFriendId:'_default';
    var pct=0,recent=0,budget=200000,online=false;
    try{
      var r=await ibBridgeFetch(ibBridgeBase()+'/api/context?friend='+encodeURIComponent(friend),{cache:'no-store'});
      if(r.ok){ var j=await r.json(); pct=j.pct||0;recent=j.recent||0;budget=j.budget||200000;online=true; }
    }catch(e){}
    if(!online){ var loc=ibCtxLocalGet(friend); recent=loc.recent; pct=Math.min(100,Math.round(recent/budget*1000)/10); }
    var bar=document.getElementById('ib-ctx-bar');
    if(!bar)return;
    var fill=bar.querySelector('.ib-ctx-fill'),label=bar.querySelector('.ib-ctx-label');
    fill.style.width=Math.min(100,pct)+'%';
    fill.style.background=pct>=85?'#ff5f6d':(pct>=70?'#ffa94d':'#5bc0de');
    bar.style.display=(pct>0||online)?'':'none';
    label.textContent='上下文 '+pct.toFixed(1)+'%'+(online?' · 桥':' · 本地')+' ('+Math.round(recent).toLocaleString()+'/'+Math.round(budget).toLocaleString()+')';
  }catch(e){}
}

(function(NS){
  var orig=window._tkRecord;
  if(typeof orig!=='function')return;
  window._tkRecord=async function(cfg,u){
    try{ await orig(cfg,u); }catch(e){}
    try{
      var friend=(typeof activeFriendId!=='undefined'&&activeFriendId)?activeFriendId:(cfg&&cfg.id)||'';
      var uu=u||{};
      if(!(uu.i||uu.o||uu.cr||uu.cw))return;
      var body={input_tokens:uu.i||0,output_tokens:uu.o||0,cached_tokens:uu.cr||0,cache_creation_tokens:uu.cw||0};
      ibBridgeFetch(ibBridgeBase()+'/api/context?friend='+encodeURIComponent(friend),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(function(NS){});
      ibCtxLocalAdd(friend,body);
      setTimeout(ibCtxRefresh,300);
    }catch(e){}
  };
  try{ document.documentElement.setAttribute('data-ib-wrapped','1'); }catch(e){}
  window._ibWrappedTk=1;
})();

/* ---------- 多窗口聊天同步：写入聊天后通知其他标签页 ---------- */
(function(NS){
  var orig=window.dbPut;
  if(typeof orig!=='function')return;
  window.dbPut=async function(s,d){
    var r=await orig(s,d);
    try{
      if(s==='chatMessages'&&d&&d.id){
        localStorage.setItem('ib_chat_sync',Date.now()+'|'+(d.friendId||d.senderName||''));
      }
    }catch(e){}
    return r;
  };
  window._ibWrappedDbPut=1;
  try{ document.documentElement.setAttribute('data-ib-wrapped-db','1'); }catch(e){}
})();

var _ibSyncTimer=null;
window.__ibSyncCount=0;
try{
  window.addEventListener('storage',function(ev){
    if(!ev||ev.key!=='ib_chat_sync')return;
    if(_ibSyncTimer)clearTimeout(_ibSyncTimer);
    _ibSyncTimer=setTimeout(function(NS){
      _ibSyncTimer=null;
      try{
        window.__ibSyncCount++;
        if(typeof currentPage!=='undefined'&&currentPage==='chat'&&typeof loadChatMessages==='function'){
          loadChatMessages();
        }
      }catch(e){}
    },300);
  });
}catch(e){}

/* ---------- /continue 自动续写 ---------- */
var _ibContinuePending=0,_ibContinueTimer=null;
function ibScheduleContinue(){
  if(_ibContinuePending>=2)return;
  if(_ibContinueTimer)clearTimeout(_ibContinueTimer);
    _ibContinueTimer=setTimeout(function(NS){
    _ibContinueTimer=null;
    try{
      if(typeof _chatSendingFor!=='undefined'&&_chatSendingFor.size)return;
      var inp=document.getElementById('chat-full-input')||document.getElementById('chat-input');
      if(!inp)return;
      var draft=inp.value;
      var pi=_pendingImages,pf=_pendingFiles;
      _pendingImages=[];_pendingFiles=[];
      inp.value='请继续';
      if(typeof sendChatMessage==='function')sendChatMessage();
      setTimeout(function(NS){
        try{
          if(inp.value===''||inp.value==='请继续')inp.value=draft;
          if(!_pendingImages.length)_pendingImages=pi;
          if(!_pendingFiles.length)_pendingFiles=pf;
          try{ if(typeof renderImagePreviews==='function')renderImagePreviews(); }catch(e){}
          try{ if(typeof renderAttachPreviews==='function')renderAttachPreviews(); }catch(e){}
        }catch(e){}
      },150);
    }catch(e){}
  },900);
}

(function(NS){
  var orig=window._assistantResponseParts;
  if(typeof orig!=='function')return;
  window._assistantResponseParts=function(content,reasoning){
    var r=orig(content,reasoning);
    try{
      if(r&&typeof r.content==='string'){
        var m=r.content.match(/(?:^|[\s，。！？!?,.;；])\/continue\s*$/i);
        if(m&&_ibContinuePending<2){
          r.content=r.content.slice(0,m.index).replace(/\s+$/,'');
          _ibContinuePending++;
          ibScheduleContinue();
        }
      }
    }catch(e){}
    return r;
  };
  window._ibWrappedApr=1;
})();

(function(NS){
  var orig=window.sendChatMessage;
  if(typeof orig!=='function')return;
  window.sendChatMessage=function(){
    _ibContinuePending=0;
    if(_ibContinueTimer){ clearTimeout(_ibContinueTimer); _ibContinueTimer=null; }
    return orig.apply(this,arguments);
  };
  window._ibWrappedSend=1;
})();

/* ---------- Bridge 导航面板：心语墙 / 生活看板 / 状态 ---------- */
function ibPanelInit(){
  if(document.getElementById('ib-bridge-panel'))return;
  var navItem=document.getElementById('ib-bridge-nav');
  if(!navItem)return;
  try{ localStorage.removeItem('ib_bridge_fab_pos'); }catch(e){}
  /* The Bridge panel remains the original feature; only its entry lives in navigation. */
  var panel=document.createElement('div');panel.id='ib-bridge-panel';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');panel.setAttribute('aria-labelledby','ib-panel-title');panel.setAttribute('aria-hidden','true');panel.inert=true;
  panel.innerHTML=
    '<div class="ib-panel-head"><b id="ib-panel-title">Bridge 工具箱</b><span id="ib-panel-conn" class="ib-panel-conn" role="status" aria-live="polite">…</span><button type="button" id="ib-panel-close" aria-label="关闭 Bridge 工具箱" title="关闭">×</button></div>'+
    '<div class="ib-panel-tabs" role="tablist" aria-label="Bridge 页签">'+
      '<button type="button" id="ib-panel-tab-whisper" data-tab="whisper" class="on" role="tab" tabindex="0" aria-selected="true" aria-controls="ib-tab-whisper">心语墙</button>'+
      '<button type="button" id="ib-panel-tab-board" data-tab="board" role="tab" tabindex="-1" aria-selected="false" aria-controls="ib-tab-board">生活看板</button>'+
      '<button type="button" id="ib-panel-tab-ai" data-tab="ai" role="tab" tabindex="-1" aria-selected="false" aria-controls="ib-tab-ai">AI 常驻</button>'+
      '<button type="button" id="ib-panel-tab-status" data-tab="status" role="tab" tabindex="-1" aria-selected="false" aria-controls="ib-tab-status">状态</button>'+
    '</div>'+
    '<div id="ib-tab-whisper" class="ib-tab" role="tabpanel" aria-labelledby="ib-panel-tab-whisper" aria-hidden="false">'+
      '<div id="ib-whisper-list" class="ib-whisper-list"></div>'+
      '<textarea id="ib-whisper-input" rows="2" placeholder="写一句小心情 / 碎碎念…" inputmode="text" maxlength="2000"></textarea>'+
      '<button type="button" id="ib-whisper-send">写下</button>'+
    '</div>'+
    '<div id="ib-tab-board" class="ib-tab" style="display:none;opacity:0;max-height:0;overflow:hidden" role="tabpanel" aria-labelledby="ib-panel-tab-board" aria-hidden="true">'+
      '<div id="ib-board-content" class="ib-board-content">加载中…</div>'+
      '<div class="ib-board-actions">'+
        '<button type="button" id="ib-board-locate">更新定位</button>'+
        '<button type="button" id="ib-board-push">推送测试</button>'+
        '<button type="button" id="ib-board-refresh">刷新</button>'+
      '</div>'+
    '</div>'+
    '<div id="ib-tab-ai" class="ib-tab" style="display:none;opacity:0;max-height:0;overflow:hidden" role="tabpanel" aria-labelledby="ib-panel-tab-ai" aria-hidden="true">'+
      '<div class="ib-ai-top">'+
        '<select id="ib-ai-session" title="常驻会话"></select>'+
        '<button type="button" id="ib-ai-refresh" title="刷新列表" aria-label="刷新会话列表">刷新</button>'+
        '<button type="button" id="ib-ai-edit" title="修改当前会话设定" aria-label="编辑会话设定">编辑</button>'+
        '<button type="button" id="ib-ai-del" title="删除当前会话" aria-label="删除会话">删除</button>'+
      '</div>'+
      '<div class="ib-ai-provider-row">'+
        '<select id="ib-ai-provider" title="用哪个模型创建常驻会话"></select>'+
        '<button type="button" id="ib-ai-new">新建</button>'+
        '<label><input type="checkbox" id="ib-voice-show">Show Voice Button</label>'+
      '</div>'+
      '<div id="ib-ai-msgs" class="ib-ai-msgs" role="log" aria-live="polite"><div class="ib-ai-msg sys">选择或新建一个常驻会话，TA 的记忆会存在服务器上。</div></div>'+
      '<textarea id="ib-ai-input" rows="2" placeholder="跟常驻的 TA 说话…" inputmode="text" maxlength="20000"></textarea>'+
      '<div class="ib-ai-actions">'+
        '<button type="button" id="ib-ai-send">发送</button>'+
        '<button type="button" id="ib-ai-proactive">让TA主动说</button>'+
      '</div>'+
    '</div>'+
    '<div id="ib-tab-status" class="ib-tab" style="display:none;opacity:0;max-height:0;overflow:hidden" role="tabpanel" aria-labelledby="ib-panel-tab-status" aria-hidden="true"><div id="ib-status-content">加载中…</div></div>';
  document.body.appendChild(panel);
  var _ibPanelPosRaf=0;
  function _ibClampPanel(v,min,max){ return Math.max(min,Math.min(max,v)); }
  function _ibPositionPanel(){
    if(!panel||!panel.classList.contains('open'))return;
    var margin=8,gap=10,r=navItem.getBoundingClientRect();
    var pw=panel.offsetWidth,ph=panel.offsetHeight;
    if(!pw||!ph)return;
    var vw=window.innerWidth,vh=window.innerHeight;
    var roomAbove=r.top-margin,roomBelow=vh-margin-r.bottom;
    var left=_ibClampPanel(r.left+(r.width-pw)/2,margin,Math.max(margin,vw-margin-pw));
    var top;
    if(roomBelow>=ph+gap&&(roomBelow>=roomAbove||roomAbove<ph+gap))top=r.bottom+gap;
    else if(roomAbove>=ph+gap)top=r.top-ph-gap;
    else top=_ibClampPanel(r.top+(r.height-ph)/2,margin,Math.max(margin,vh-margin-ph));
    panel.style.left=Math.round(left)+'px';panel.style.top=Math.round(top)+'px';
    panel.style.right='auto';panel.style.bottom='auto';
  }
  function _ibQueuePanelPosition(){
    if(!panel||!panel.classList.contains('open'))return;
    if(_ibPanelPosRaf)cancelAnimationFrame(_ibPanelPosRaf);
    _ibPanelPosRaf=requestAnimationFrame(function(NS){_ibPanelPosRaf=0;_ibPositionPanel();});
  }
  if(typeof ResizeObserver!=='undefined'){
    try{ new ResizeObserver(_ibQueuePanelPosition).observe(panel); }catch(e){}
  }
  window.addEventListener('resize',function(){
    _ibQueuePanelPosition();
  });
  /* 未保存内容检测 */
  function _ibPanelHasUnsaved(){
    try{
      var w=document.getElementById('ib-whisper-input'),a=document.getElementById('ib-ai-input');
      if(w&&w.value.trim())return true;if(a&&a.value.trim())return true;
    }catch(e){} return false;
  }
  function _ibSyncNav(open){
    navItem.classList.toggle('active',open);
    navItem.setAttribute('aria-expanded',open?'true':'false');
    if(open){
      navItem.setAttribute('aria-current','page');
      document.querySelectorAll('.nav-links a').forEach(function(a){ if(a!==navItem){a.classList.remove('active');a.removeAttribute('aria-current');} });
    }else if(typeof currentPage!=='undefined'){
      document.querySelectorAll('.nav-links a').forEach(function(a){
        var active=a.dataset.page===currentPage;
        a.classList.toggle('active',active);
        if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
      });
    }
  }
  function _ibClosePanel(skipConfirm){
    if(!panel.classList.contains('open'))return true;
    if(!skipConfirm&&_ibPanelHasUnsaved()&&!confirm('面板有未保存的内容，确定关闭？'))return false;
    panel.classList.remove('open');
    _ibSyncNav(false);
    if(document.activeElement&&panel.contains(document.activeElement))navItem.focus();
    panel.inert=true;panel.setAttribute('aria-hidden','true');
    return true;
  }
  function _ibTogglePanel(){
    if(panel.classList.contains('open'))return _ibClosePanel(false);
    panel.inert=false;panel.setAttribute('aria-hidden','false');panel.classList.add('open');
    _ibSyncNav(true);
    _ibPositionPanel();
    ibPanelRefreshAll();
    _ibQueuePanelPosition();
    requestAnimationFrame(function(NS){var activeTab=panel.querySelector('.ib-panel-tabs button.on');if(activeTab)activeTab.focus();});
    return true;
  }
  window.ibBridgeClose=_ibClosePanel;
  navItem.onclick=function(ev){ if(ev)ev.preventDefault(); _ibTogglePanel(); };
  navItem.onkeydown=function(ev){ if(ev.key==='Enter'||ev.key===' '){ ev.preventDefault(); _ibTogglePanel(); } };
  document.getElementById('ib-panel-close').onclick=function(){ _ibClosePanel(false); };
  /* Escape follows the same close path and unsaved-content guard. */
  function _ibPanelEscape(ev){ if(ev.key==='Escape'&&panel.classList.contains('open'))_ibClosePanel(false); }
  document.addEventListener('keydown',_ibPanelEscape);
  var tabButtons=Array.prototype.slice.call(panel.querySelectorAll('.ib-panel-tabs button'));
  tabButtons.forEach(function(btn){
    btn.onclick=function(){
      tabButtons.forEach(function(b){b.classList.remove('on');b.setAttribute('aria-selected','false');b.setAttribute('tabindex','-1')});
      btn.classList.add('on');btn.setAttribute('aria-selected','true');btn.setAttribute('tabindex','0');
      var tabId=btn.dataset.tab;
      ['whisper','board','ai','status'].forEach(function(t){
        var el=document.getElementById('ib-tab-'+t);
        if(!el)return;
        var selected=t===tabId;el.setAttribute('aria-hidden',selected?'false':'true');
        if(selected){ el.style.display='';el.style.opacity='';el.style.maxHeight='';el.style.overflow=''; }else{ el.style.display='none';el.style.opacity='0';el.style.maxHeight='0';el.style.overflow='hidden'; }
      });
      if(tabId==='whisper')ibLoadWhispers();
      if(tabId==='board')ibLoadBoard();
      if(tabId==='ai')ibAiOpen();
      if(tabId==='status')ibLoadStatus();
      _ibQueuePanelPosition();
    };
    btn.onkeydown=function(ev){
      var index=tabButtons.indexOf(btn),next=index;
      if(ev.key==='ArrowRight')next=(index+1)%tabButtons.length;
      else if(ev.key==='ArrowLeft')next=(index-1+tabButtons.length)%tabButtons.length;
      else if(ev.key==='Home')next=0;
      else if(ev.key==='End')next=tabButtons.length-1;
      else return;
      ev.preventDefault();tabButtons[next].focus();tabButtons[next].click();
    };
  });
  /* 移动端键盘弹出时滚动输入框到可见区域 */
  ['ib-whisper-input','ib-ai-input'].forEach(function(id){
    var el=document.getElementById(id);if(!el)return;
    el.addEventListener('focus',function(){ setTimeout(function(NS){ try{ el.scrollIntoView({behavior:'smooth',block:'center'}); }catch(e){try{el.scrollIntoView()}catch(e2){}} },300); });
  });
  document.getElementById('ib-whisper-send').onclick=function(){
    var btn=this;if(btn.disabled)return;btn.disabled=true;
    var inp=document.getElementById('ib-whisper-input');
    var text=inp.value.trim();if(!text){ btn.disabled=false; return; }
    ibBridgeFetch(ibBridgeBase()+'/api/whispers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text,author:'你'})}).then(function(r){return r.json()}).then(function(j){
      if(j&&j.ok){ inp.value=''; ibLoadWhispers(); ibToast('已写下心语'); }else ibToast('写入失败：'+(j&&j.error||''));
    }).catch(function(NS){ ibToast('Bridge 未连接'); }).finally(function(NS){ btn.disabled=false; });
  };
  document.getElementById('ib-board-locate').onclick=function(){
    var btn=this;if(btn.disabled)return;btn.disabled=true;
    if(!navigator.geolocation){ ibToast('浏览器不支持定位'); btn.disabled=false; return; }
    navigator.geolocation.getCurrentPosition(function(pos){
      var body={lat:pos.coords.latitude,lng:pos.coords.longitude,accuracy:pos.coords.accuracy,source:'browser'};
      ibBridgeFetch(ibBridgeBase()+'/api/geo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){
        ibToast(j&&j.ok?'定位已更新':'定位更新失败'); ibLoadBoard();
      }).catch(function(NS){ ibToast('Bridge 未连接'); }).finally(function(NS){ btn.disabled=false; });
    },function(){ ibToast('定位失败'); btn.disabled=false; },{enableHighAccuracy:false,timeout:10000});
  };
  document.getElementById('ib-board-push').onclick=function(){
    var btn=this;if(btn.disabled)return;btn.disabled=true;
    ibBridgeFetch(ibBridgeBase()+'/api/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'测试推送',text:'这是一条来自 Bridge 的测试消息。',from:'Sui',bark:false})}).then(function(r){return r.json()}).then(function(j){
      ibToast(j&&j.ok?'已推送':'推送失败');
    }).catch(function(NS){ ibToast('Bridge 未连接'); }).finally(function(NS){ btn.disabled=false; });
  };
  document.getElementById('ib-board-refresh').onclick=ibLoadBoard;
  document.getElementById('ib-ai-refresh').onclick=function(){ var b=this;if(b.disabled)return;ibAiLoadSessions(true); };
  document.getElementById('ib-ai-edit').onclick=ibAiEdit;
  document.getElementById('ib-ai-del').onclick=function(){
    var btn=this;if(btn.disabled)return;btn.disabled=true;
    var sel=document.getElementById('ib-ai-session');
    var key=sel&&sel.value;
    if(!key){ ibToast('没有可删除的会话'); btn.disabled=false; return; }
    if(!confirm('删除常驻会话「'+key+'」？（服务器上的记忆也会删掉）')){ btn.disabled=false; return; }
    ibBridgeFetch(ibBridgeBase()+'/api/ai/sessions/'+encodeURIComponent(key),{method:'DELETE'}).then(function(r){return r.json()}).then(function(NS){
      ibToast('已删除'); ibAiLoadSessions(true);
    }).catch(function(NS){ ibToast('Bridge 未连接'); }).finally(function(NS){ btn.disabled=false; });
  };
  document.getElementById('ib-ai-new').onclick=ibAiNew;
  document.getElementById('ib-ai-send').onclick=ibAiSend;
  document.getElementById('ib-ai-proactive').onclick=ibAiProactive;
  var aiInput=document.getElementById('ib-ai-input');
  if(aiInput)aiInput.addEventListener('keydown',function(ev){ if(ev.key==='Enter'&&!ev.shiftKey){ ev.preventDefault(); ibAiSend(); } });
  var showVoiceBox=document.getElementById('ib-voice-show');
  try{ var _ibVp=JSON.parse(localStorage.getItem('ib_voice_prefs')||'{}');showVoiceBox.checked=_ibVp.showVoiceButton!==false; }catch(e){showVoiceBox.checked=true}
  showVoiceBox.onchange=function(){ try{ var vp=JSON.parse(localStorage.getItem('ib_voice_prefs')||'{}');vp.showVoiceButton=showVoiceBox.checked;localStorage.setItem('ib_voice_prefs',JSON.stringify(vp)); }catch(e){} };
  var sessSel=document.getElementById('ib-ai-session');
  if(sessSel)sessSel.addEventListener('change',function(){ try{ localStorage.setItem('ib_bridge_last_ai',sessSel.value); }catch(e){} });
}

function ibPanelRefreshAll(){ ibPanelConn(); ibLoadWhispers(); ibLoadBoard(); ibAiLoadSessions(); ibLoadStatus(); }

function ibPanelConn(){
  var el=document.getElementById('ib-panel-conn');if(!el)return;
  ibBridgeFetch(ibBridgeBase()+'/health',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
    el.textContent=(j&&j.ok)?('在线 · v'+j.version):'离线';
    el.style.color=(j&&j.ok)?'var(--status-success)':'var(--status-danger)';
  }).catch(function(NS){ el.textContent='离线'; el.style.color='var(--status-danger)'; });
}

function ibLoadWhispers(){
  var el=document.getElementById('ib-whisper-list');if(!el)return;
  el.innerHTML='加载中…';
  ibBridgeFetch(ibBridgeBase()+'/api/whispers?limit=30',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
    var list=(j&&j.whispers)||[];
    if(!list.length){ el.innerHTML='<div class="ib-empty">心语墙还是空的。</div>'; return; }
    el.innerHTML='';
    list.forEach(function(w){
      var row=document.createElement('div');row.className='ib-whisper-item';
      var who=document.createElement('b');who.textContent=(w.author||'匿名')+' · '+new Date(w.created).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
      var txt=document.createElement('div');txt.textContent=w.text;
      var edit=document.createElement('button');edit.type='button';edit.className='ib-whisper-edit';edit.textContent='✎';edit.title='修改心语';edit.setAttribute('aria-label','修改心语');
      edit.onclick=function(){
        var eb=this;if(eb.disabled)return;eb.disabled=true;
        var v=prompt('修改心语：',w.text);
        if(v===null){ eb.disabled=false; return; }
        v=v.trim();if(!v){ ibToast('内容不能为空'); eb.disabled=false; return; }
        if(v.length>2000){ ibToast('内容超出 2000 字限制'); eb.disabled=false; return; }
        ibBridgeFetch(ibBridgeBase()+'/api/whispers/'+encodeURIComponent(w.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v})}).then(function(r){return r.json()}).then(function(j){
          ibToast(j&&j.ok?'已更新':'更新失败：'+(j&&j.error||'未知错误'));
          ibLoadWhispers();
        }).catch(function(NS){ ibToast('Bridge 未连接'); }).finally(function(NS){ eb.disabled=false; });
      };
      var del=document.createElement('button');del.type='button';del.className='ib-whisper-del';del.textContent='×';del.setAttribute('aria-label','删除心语');
      del.onclick=function(){
        var db=this;if(db.disabled)return;db.disabled=true;
        ibBridgeFetch(ibBridgeBase()+'/api/whispers/'+encodeURIComponent(w.id),{method:'DELETE'}).then(function(r){return r.json()}).then(function(j){
          if(j&&j.ok){ ibToast('已删除心语'); ibLoadWhispers(); }else{ ibToast('删除失败：'+(j&&j.error||'未知错误')); db.disabled=false; }
        }).catch(function(NS){ ibToast('Bridge 未连接'); db.disabled=false; });
      };
      row.appendChild(who);row.appendChild(txt);row.appendChild(edit);row.appendChild(del);
      el.appendChild(row);
    });
  }).catch(function(NS){ el.innerHTML='<div class="ib-empty">Bridge 未连接。</div>'; });
}

function ibLoadBoard(){
  var el=document.getElementById('ib-board-content');if(!el)return;
  el.innerHTML='加载中…';
  var base=ibBridgeBase();
  Promise.all([
    ibBridgeFetch(base+'/api/geo/latest',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).catch(function(NS){return null}),
    ibBridgeFetch(base+'/api/health?days=7',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).catch(function(NS){return null}),
    ibBridgeFetch(base+'/api/weather',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).catch(function(NS){return null})
  ]).then(function(rs){
    var geo=rs[0]&&rs[0].geo,health=rs[1],weather=rs[2];
    var html='';
    html+='<div class="ib-card"><div class="ib-card-title">位置</div>'+(geo?('<div>'+ibEsc(geo.address||(geo.city||('纬度 '+geo.lat+' 经度 '+geo.lng)))+'</div><div style="opacity:.65">'+(geo.city||'')+' · '+new Date(geo.ts).toLocaleString('zh-CN')+'</div>'):'<div class="ib-empty">还没有位置数据（可用上方按钮更新）</div>')+'</div>';
    html+='<div class="ib-card"><div class="ib-card-title">天气</div>'+(weather&&weather.ok?('<div>'+ibEsc(weather.city||'')+' '+ibEsc(weather.text||'')+' '+ibEsc(weather.temp||'?')+'°C（体感 '+ibEsc(weather.feels||'?')+'°C）</div><div style="opacity:.65">湿度 '+ibEsc(weather.humidity||'?')+'% · 风速 '+ibEsc(weather.wind||'?')+'km/h</div>'):'<div class="ib-empty">天气暂不可用</div>')+'</div>';
    html+='<div class="ib-card"><div class="ib-card-title">健康（近 7 天）</div>'+(health&&health.count?(function(NS){var rows='';health.records.forEach(function(h){var kv=Object.keys(h.metrics||{}).map(function(k){return k+' '+h.metrics[k]}).join(' · ');rows+='<div>'+ibEsc(h.date)+(kv?'：'+ibEsc(kv):'')+'</div>';});return rows;})():'<div class="ib-empty">还没有健康数据（用 iOS 快捷指令 POST 到 /api/health）</div>')+'</div>';
    el.innerHTML=html;
  }).catch(function(NS){ el.innerHTML='<div class="ib-empty">Bridge 未连接。</div>'; });
}

function ibLoadStatus(){
  var el=document.getElementById('ib-status-content');if(!el)return;
  var base=ibBridgeBase();
  Promise.all([
    ibBridgeFetch(base+'/health',{cache:'no-store'}).then(function(r){return r.json()}).catch(function(NS){return null}),
    ibBridgeFetch(base+'/status',{cache:'no-store'}).then(function(r){return r.json()}).catch(function(NS){return null}),
    ibBridgeFetch(base+'/api/config',{cache:'no-store'}).then(function(r){return r.json()}).catch(function(NS){return null}),
    ibBridgeFetch(base+'/api/push/history?limit=5',{cache:'no-store'}).then(function(r){return r.json()}).catch(function(NS){return null}),
    ibBridgeFetch(base+'/api/diagnostics',{cache:'no-store'}).then(function(r){return r.ok?r.json():null}).catch(function(NS){return null})
  ]).then(function(rs){
    var h=rs[0],s=rs[1],c=rs[2],ph=rs[3],diag=rs[4];
    if(!h){ el.innerHTML='<div class="ib-empty">Bridge 未连接。<br>请先双击运行 start-bridge-service.cmd，然后在 DIY → 后端连接 填写 ws://127.0.0.1:23115 并启用。</div>'; return; }
    el.innerHTML=
      '<div class="ib-card"><div class="ib-card-title">服务</div>'+
      '<div>'+ibEsc(h.server||'')+' v'+ibEsc(h.version||'')+' · 运行 '+Math.round(h.uptime/60)+' 分钟</div>'+
      '<div style="opacity:.65">页面连接 '+h.connections+' · 工具 '+h.tools.length+' 个</div></div>'+
      '<div class="ib-card"><div class="ib-card-title">数据</div>'+
      '<div>心语 '+s.whispers+' · 健康 '+s.health+' 条 · 信件 '+s.letters+' · 会话 '+s.sessions+' · 表情 '+s.stickers+'</div>'+
      '<div style="opacity:.65">Bark：'+(s.bark?'已配置':'未配置')+' · ntfy：'+(s.ntfy?'已配置':'未配置')+' · 音乐：'+(s.musicProvider||'kugou')+' · 有定位：'+(s.hasGeo?'是':'否')+'</div></div>'+
      '<div class="ib-card"><div class="ib-card-title">Android / OPPO</div>'+
      '<div>推送：装 <b>ntfy</b> App → config.json 配 ntfy.topic；OPPO 需允许自启动并加入电池白名单。</div>'+
      '<div>定位：HTTP Shortcuts / MacroDroid POST /api/geo，或直接用面板「更新定位」。</div>'+
      '<div>健康：Health Connect → MacroDroid/Tasker → POST /api/health。</div>'+
      '<div>音乐：默认酷狗；会员 Cookie 填 config.json 的 music.kugouCookie。</div></div>'+
      '<div class="ib-card"><div class="ib-card-title">最近推送</div>'+
      ((ph&&ph.history&&ph.history.length)?ph.history.map(function(p){
        var d=new Date(p.ts).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
        var ch=(p.bark?'Bark ':'')+(p.ntfy?'ntfy ':'');
        return '<div>'+ibEsc(d)+' '+(ch?'· '+ch:'')+ibEsc(String(p.text||'').slice(0,60))+'</div>';
      }).join(''):'<div class="ib-empty">暂无推送记录</div>')+'</div>'+
      (diag&&diag.ok?'<div class="ib-card"><div class="ib-card-title">本地诊断</div>'+((function(NS){var u=diag.data&&diag.data.usage||{},kb=Math.round((Number(u.bytes)||0)/1024),lan=diag.service&&diag.service.lan;return '<div>存储 '+kb+' KB · '+(Number(u.files)||0)+' 个文件 · '+(lan?'局域网已开启并要求令牌':'仅本机回环')+'</div><div style="opacity:.65">令牌：'+((diag.service&&diag.service.tokenRequired)?'已启用':'本机免令牌')+(diag.warnings&&diag.warnings.length?' · '+ibEsc(diag.warnings.join('；')):'')+'</div>';})())+'</div>':'')+
      '<div class="ib-card"><div class="ib-card-title">数据目录</div><div style="word-break:break-all;opacity:.7">'+ibEsc(c&&c.dataDir||'')+'</div></div>';
  }).catch(function(NS){ el.innerHTML='<div class="ib-empty">状态读取失败。</div>'; });
}

/* ---------- AI 语音气泡 ---------- */
var _ibTtsAudio=null;
var _ibTtsQueue=[];var _ibTtsQueueBusy=false;
var _ibTtsMaxLen=800;/* 单次 TTS 文本最大字符数 */
/* 统一 wire payload：角色 Voice Profile → /api/tts 请求体的唯一组装点。
   旧五个字段（text/voice/provider/rate/pitch）的取值与回退保持历史行为逐字节一致；
   新增字段（model/voiceType/voiceData/language/style）允许为空值——Bridge 端
   normalizeVoiceProfile 会按 provider capabilities 过滤并补默认值。禁止再出现第二套组装逻辑。 */
function _ibTtsPayload(vc,text){
  var v=(vc&&typeof vc==='object')?vc:{};
  return {
    text:String(text==null?'':text),
    voice:v.voiceId||'',
    provider:v.provider||'edge',
    rate:v.rate||1.0,
    pitch:v.pitch||'+0Hz',
    model:v.model||'',
    voiceType:v.voiceType||'builtin',
    voiceData:v.voiceData||null,
    language:v.language||'',
    style:v.style||''
  };
}
function ibAttachTts(root){
  if(!root||root.nodeType!==1)return;
  /* 全局开关：showVoiceButton 关闭时不显示 Voice 按钮 */
  try{ var _ibVoiceGlobal=JSON.parse(localStorage.getItem('ib_voice_prefs')||'{}'); if(_ibVoiceGlobal.showVoiceButton===false)return; }catch(e){}
  var targets;
  if(root.classList&&root.classList.contains('chat-msg')&&root.classList.contains('ai'))targets=[root];
  else if(root.querySelectorAll)targets=Array.prototype.slice.call(root.querySelectorAll('.chat-msg.ai'));
  targets.forEach(function(bubble){
    if(bubble.dataset.ibTts)return;
    var txt=bubble.querySelector('.r-text');
    if(!txt)return;
    bubble.dataset.ibTts='1';
    /* 读取角色 Voice 配置 */
    var vc=_ibGetCharVoice(bubble);
    if(!vc||!vc.enabled)return;/* 角色未启用 Voice，不显示按钮 */
    var btn=document.createElement('button');
    btn.type='button';btn.className='ib-tts-btn';btn.textContent='Voice';
    btn.onclick=function(ev){ ev.stopPropagation(); ibTtsSpeak(bubble,btn,vc); };
    bubble.appendChild(btn);
    if(vc.autoPlay){
      setTimeout(function(NS){ try{ if(bubble.isConnected&&btn.isConnected)_ibTtsEnqueue(bubble,btn,vc); }catch(e){} },1200);
    }
  });
}

function _ibGetCharVoice(bubble){
  try{
    var sId=bubble.dataset.senderId;
    var cfg=null;
    /* 按 config_id 匹配（精确） */
    if(sId&&sId!=='_user_'){
      cfg=(typeof apiConfigs!=='undefined'?apiConfigs:[]).find(function(a){return a.id===sId})||
          (typeof archivedConfigs!=='undefined'?archivedConfigs:[]).find(function(a){return a.id===sId});
    }
    /* 兜底：按 nickname/model 匹配（兼容旧数据，旧消息的 senderId 存的是 display name） */
    if(!cfg&&sId&&sId!=='_user_'){
      cfg=(typeof apiConfigs!=='undefined'?apiConfigs:[]).find(function(a){return a.nickname===sId||a.model===sId});
    }
    /* 单聊：按 activeFriendId 匹配 */
    if(!cfg&&typeof activeFriendId!=='undefined'&&activeFriendId&&!activeFriendId.startsWith('group_')){
      cfg=(typeof apiConfigs!=='undefined'?apiConfigs:[]).find(function(a){return a.id===activeFriendId});
    }
    return cfg&&cfg.voice||null;
  }catch(e){return null}
}

function ibTtsSpeak(bubble,btn,vc){
  /* 用户手动点击 → 清空队列立即播放 */
  _ibTtsQueue=[];_ibTtsQueueBusy=false;
  _ibTtsSpeakImpl(bubble,btn,vc,null);
}

function _ibTtsEnqueue(bubble,btn,vc){
  _ibTtsQueue.push({bubble:bubble,btn:btn,vc:vc});
  if(!_ibTtsQueueBusy)_ibTtsDequeue();
}

function _ibTtsDequeue(){
  if(_ibTtsQueue.length===0){_ibTtsQueueBusy=false;return}
  _ibTtsQueueBusy=true;
  var item=_ibTtsQueue.shift();
  var bubble=item.bubble,btn=item.btn,vc=item.vc;
  if(!bubble||!bubble.isConnected){_ibTtsDequeue();return}
  _ibTtsSpeakImpl(bubble,btn,vc,function(){
    setTimeout(_ibTtsDequeue,800);
  });
}

function _ibTtsSpeakImpl(bubble,btn,vc,done){
  var txt=bubble.querySelector('.r-text');
  var text=txt?String(txt.innerText||txt.textContent||''):'';
  text=text.replace(/\[(sticker|music):[^\]]+\]/g,'').trim();
  if(!text){ if(done)done(); return; }
  text=text.slice(0,_ibTtsMaxLen);
  var url=bubble.dataset.ibTtsUrl;
  if(url){
    ibBridgeLoadAudio(url,function(audioUrl,revoke){ _ibTtsPlayQ(bubble,btn,audioUrl,done,revoke); },function(){ ibTtsFallback(text,btn);if(done)done(); });
    return;
  }
  if(btn)btn.classList.add('playing');
  var vcSafe=vc||_ibGetCharVoice(bubble)||{};
  ibBridgeFetch(ibBridgeBase()+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(_ibTtsPayload(vcSafe,text))}).then(function(r){return r.json()}).then(function(j){
    if(j&&j.ok){
      bubble.dataset.ibTtsUrl=j.url;
      ibBridgeLoadAudio(j.url,function(audioUrl,revoke){ _ibTtsPlayQ(bubble,btn,audioUrl,done,revoke); },function(){ if(btn)btn.classList.remove('playing');ibTtsFallback(text,btn);if(done)done(); });
    }else{
      if(btn)btn.classList.remove('playing');
      /* 修复：Bridge TTS 失败时按 README 承诺降级到浏览器自带语音（原 ibTtsFallback 定义了却从未被调用） */
      ibTtsFallback(text,btn);
      if(done)done();
    }
  }).catch(function(NS){
    if(btn)btn.classList.remove('playing');
    ibTtsFallback(text,btn);
    if(done)done();
  });
}

function _ibTtsPlayQ(bubble,btn,url,done,revokeUrl){
  var old=bubble.querySelector('.ib-tts-bar');
  if(old){ try{if(old._ibObjectUrl)URL.revokeObjectURL(old._ibObjectUrl)}catch(e){} old.remove(); }
  var bar=ibTtsBar(url,'');
  if(revokeUrl)bar._ibObjectUrl=url;
  bar.classList.add('ib-tts-bar');
  if(btn)btn.remove();
  bubble.appendChild(bar);
  var origEnd=bar._au.onended;
  bar._au.onended=function(){
    bar.classList.remove('playing');
    if(origEnd)origEnd();
    if(done)done();
  };
  bar._au.onerror=function(){
    bar.classList.remove('playing');
    if(done)done();
  };
  bar._au.play().then(function(NS){ bar.classList.add('playing'); }).catch(function(NS){ if(done)done(); });
}

function ibTtsBar(url,text){
  var el=document.createElement('div');
  el.className='chat-voice-bar';
  el.style.width='170px';
  el.innerHTML='<span class="vm-arcs"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path class="vm-a1" d="M8.5 9.5a4 4 0 0 1 0 5"/><path class="vm-a2" d="M11.5 7a8 8 0 0 1 0 10"/><path class="vm-a3" d="M14.5 4.5a12.5 12.5 0 0 1 0 15"/></svg></span><span class="vm-dur">…</span>';
  var au=new Audio(url);
  if(_ibTtsAudio){ try{ _ibTtsAudio.pause(); }catch(e){} }
  _ibTtsAudio=au;
  el._au=au;
  au.onloadedmetadata=function(){
    var d=Math.max(1,Math.round(au.duration||1));
    var dur=el.querySelector('.vm-dur');if(dur)dur.textContent=d+'″';
    el.style.width=Math.min(220,86+d*2.2)+'px';
  };
  el.title='点击播放 / 暂停 AI 语音';
  el.onclick=function(ev){
    ev.stopPropagation();
    if(!au.paused){ au.pause(); el.classList.remove('playing'); return; }
    au.currentTime=0;
    au.play().then(function(NS){ el.classList.add('playing'); }).catch(function(NS){ ibToast('播放失败'); });
  };
  au.onended=function(){ el.classList.remove('playing'); };
  au.onerror=function(){ el.classList.remove('playing'); ibToast('语音播放失败'); };
  return el;
}

function ibTtsFallback(text,btn){
  try{
    if(typeof speechSynthesis!=='undefined'&&speechSynthesis){
      speechSynthesis.cancel();
      var u=new SpeechSynthesisUtterance(text);
      u.lang='zh-CN';u.rate=1;
      if(btn){
        btn.classList.add('playing');
        u.onend=function(){ btn.classList.remove('playing'); };
        u.onerror=function(){ btn.classList.remove('playing'); };
      }
      speechSynthesis.speak(u);
      ibToast('Bridge TTS 未配置，已用浏览器语音朗读');
    }else ibToast('TTS 未配置');
  }catch(e){ ibToast('TTS 未配置'); }
}

/* ---------- VoiceClone Reference Audio（第三阶段 B1：文件基础设施） ----------
   上传/删除都由 Voice 编辑器（social.js）发起；这里只提供存在性检查
   与导入后的 dangling reference 检测。Reference Audio 二进制绝不进入 IndexedDB。 */
function ibTtsVoiceHead(id){
  if(!id)return Promise.resolve(false);
  return ibBridgeFetch(ibBridgeBase()+'/api/tts/voices/'+encodeURIComponent(id),{method:'HEAD',cache:'no-store'})
    .then(function(r){return r.ok}).catch(function(){return false});
}
function ibTtsVoiceList(){
  return ibBridgeFetch(ibBridgeBase()+'/api/tts/voices',{cache:'no-store'})
    .then(function(r){return r.json()}).catch(function(NS){return {ok:false,error:'Bridge 未连接'}});
}
/* 导入后检测：voiceType==='clone' 的引用文件在本机 Bridge 是否存在。
   只报告，不伪造存在、不删文件；Bridge 未连接时 fail-open（本地单机场景）。 */
async function ibTtsVoiceCheckImport(configs){
  try{
    var ids=[];
    (Array.isArray(configs)?configs:[]).forEach(function(c){
      var v=c&&c.voice;
      if(v&&v.voiceType==='clone'&&v.voiceData&&v.voiceData.refAudioId&&ids.indexOf(v.voiceData.refAudioId)===-1)ids.push(v.voiceData.refAudioId);
    });
    if(!ids.length)return {ok:true,missing:[]};
    var missing=[];
    for(var i=0;i<ids.length;i++){
      if(!(await ibTtsVoiceHead(ids[i])))missing.push(ids[i]);
    }
    if(missing.length)console.warn('[IB Bridge] Reference Audio dangling reference：'+missing.join(', '));
    return {checked:ids.length,missing:missing};
  }catch(e){return {checked:0,missing:[]}}
}
window.ibTtsVoiceHead=ibTtsVoiceHead;
window.ibTtsVoiceList=ibTtsVoiceList;
window.ibTtsVoiceCheckImport=ibTtsVoiceCheckImport;

/* ---------- AI 常驻 ---------- */
function ibAiOpen(){
  ibAiLoadProviders();
  ibAiLoadSessions();
}

function ibAiLoadProviders(){
  var sel=document.getElementById('ib-ai-provider');if(!sel)return;
  var cfgs=[];
  try{ if(typeof apiConfigs!=='undefined'&&Array.isArray(apiConfigs))cfgs=apiConfigs; }catch(e){}
  var old=sel.value;
  sel.innerHTML='';
  if(!cfgs.length){
    var o=document.createElement('option');o.value='';o.textContent='未找到 API 配置（请先到 API 设置添加）';sel.appendChild(o);
    return;
  }
  cfgs.forEach(function(c,i){
    var o=document.createElement('option');
    o.value=String(i);
    o.textContent=(c.nickname||c.model||('API '+(i+1)))+' · '+(c.model||'');
    sel.appendChild(o);
  });
  if(old)sel.value=old;
}

function ibAiLoadSessions(keepSel, selectKey){
  var sel=document.getElementById('ib-ai-session');if(!sel)return;
  var old=keepSel?sel.value:'';
  ibBridgeFetch(ibBridgeBase()+'/api/ai/sessions',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
    sel.innerHTML='';
    var list=(j&&j.sessions)||[];
    if(!list.length){
      var o=document.createElement('option');o.value='';o.textContent='（还没有常驻会话）';sel.appendChild(o);
      ibAiLoadMsgs();
      return;
    }
    list.forEach(function(s){
      var o=document.createElement('option');
      o.value=s.key;
      o.textContent=s.name+' · '+s.model+' · '+s.messages+' 条';
      sel.appendChild(o);
    });
    var savedKey=null;
    try{ savedKey=localStorage.getItem('ib_bridge_last_ai'); }catch(e){}
    if(selectKey&&list.some(function(s){return s.key===selectKey}))sel.value=selectKey;
    else if(old&&list.some(function(s){return s.key===old}))sel.value=old;
    else if(savedKey&&list.some(function(s){return s.key===savedKey}))sel.value=savedKey;
    try{ if(sel.value)localStorage.setItem('ib_bridge_last_ai',sel.value); }catch(e){}
    ibAiLoadMsgs();
  }).catch(function(NS){
    sel.innerHTML='';
    var o=document.createElement('option');o.value='';o.textContent='Bridge 未连接';sel.appendChild(o);
    ibAiLoadMsgs();
  });
}

function ibAiNew(){
  var btn=document.getElementById('ib-ai-new');if(btn.disabled)return;btn.disabled=true;
  var provSel=document.getElementById('ib-ai-provider');
  var idx=Number(provSel&&provSel.value);
  var cfgs=[];
  try{ if(typeof apiConfigs!=='undefined'&&Array.isArray(apiConfigs))cfgs=apiConfigs; }catch(e){}
  var cfg=cfgs[idx];
  if(!cfg){ ibToast('请先在 API 设置里添加一个模型'); btn.disabled=false; return; }
  var fmt='openai';
  try{
    if(cfg.format)fmt=cfg.format;
    else if(typeof PROVIDERS!=='undefined'&&PROVIDERS[cfg.provider]&&PROVIDERS[cfg.provider].format)fmt=PROVIDERS[cfg.provider].format;
  }catch(e){}
  var key='resident_'+Date.now().toString(36);
  var body={
    key:key,
    name:cfg.nickname||cfg.model||'AI',
    provider:{
      endpoint:cfg.endpoint||'',
      apiKey:cfg.apiKey||'',
      model:cfg.model||'',
      format:fmt
    },
    system:cfg.systemPrompt||'',
    relationship:cfg.relationship||'',
    intervalMin:0
  };
  if(!body.provider.endpoint||!body.provider.model){ ibToast('该 API 配置缺少 endpoint / model'); btn.disabled=false; return; }
  ibBridgeFetch(ibBridgeBase()+'/api/ai/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){
    if(j&&j.ok){
      ibToast('常驻会话已创建：'+(j.session.name||key));
      ibAiLoadSessions(false,key);
    }else ibToast('创建失败：'+(j&&j.error||'未知错误'));
  }).catch(function(NS){ ibToast('Bridge 未连接'); }).finally(function(NS){ btn.disabled=false; });
}

function ibAiEdit(){
  var btn=document.getElementById('ib-ai-edit');if(btn.disabled)return;btn.disabled=true;
  var sel=document.getElementById('ib-ai-session');
  var key=sel&&sel.value;
  if(!key){ ibToast('没有可编辑的会话'); btn.disabled=false; return; }
  ibBridgeFetch(ibBridgeBase()+'/api/ai/sessions/'+encodeURIComponent(key),{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
    if(!j||!j.ok){ ibToast('读取会话失败'); btn.disabled=false; return; }
    var v=prompt('修改这个角色的人设（system prompt）：',j.session.system||'');
    if(v===null){ btn.disabled=false; return; }
    if(v.length>8000){ ibToast('人设超出 8000 字限制'); btn.disabled=false; return; }
    ibBridgeFetch(ibBridgeBase()+'/api/ai/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key,system:v})}).then(function(r){return r.json()}).then(function(k){
      ibToast(k&&k.ok?'人设已更新':'更新失败：'+(k&&k.error||'未知错误'));
      ibAiLoadSessions(true);
    }).catch(function(NS){ ibToast('Bridge 未连接'); }).finally(function(NS){ btn.disabled=false; });
  }).catch(function(NS){ ibToast('Bridge 未连接'); btn.disabled=false; });
}

function ibAiMsgsEl(){ return document.getElementById('ib-ai-msgs'); }
var _ibAiBusy=false;

function ibAiLoadMsgs(){
  var el=ibAiMsgsEl();var sel=document.getElementById('ib-ai-session');
  if(!el||!sel)return;
  var key=sel.value;
  if(!key){ el.innerHTML='<div class="ib-ai-msg sys">选择或新建一个常驻会话，TA 的记忆会存在服务器上。</div>'; return; }
  el.innerHTML='<div class="ib-ai-msg sys">加载中…</div>';
  ibBridgeFetch(ibBridgeBase()+'/api/ai/sessions/'+encodeURIComponent(key),{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){
    if(!j||!j.ok){ el.innerHTML='<div class="ib-ai-msg sys">读取失败。</div>'; return; }
    var h=(j.session&&j.session.history)||[];
    el.innerHTML='';
    if(!h.length)el.innerHTML='<div class="ib-ai-msg sys">这个会话还没有对话，说句话开始吧。</div>';
    h.forEach(function(m){
      var div=document.createElement('div');
      div.className='ib-ai-msg '+(m.role==='assistant'?'ai':'user');
      div.textContent=m.content;
      el.appendChild(div);
    });
    try{ ibRichifyAny(el); }catch(e){}
    el.scrollTop=el.scrollHeight;
  }).catch(function(NS){ el.innerHTML='<div class="ib-ai-msg sys">Bridge 未连接。</div>'; });
}

function ibAiSend(){
  var sel=document.getElementById('ib-ai-session');
  var inp=document.getElementById('ib-ai-input');
  var el=ibAiMsgsEl();
  if(!sel||!inp||!el)return;
  var key=sel.value,text=inp.value.trim();
  if(!key){ ibToast('请先新建常驻会话'); return; }
  if(!text){ ibToast('消息不能为空'); return; }
  if(_ibAiBusy){ ibToast('正在生成中，请稍候'); return; }
  inp.value='';
  var u=document.createElement('div');u.className='ib-ai-msg user';u.textContent=text;el.appendChild(u);
  var t=document.createElement('div');t.className='ib-ai-msg ai';t.textContent='…';el.appendChild(t);
  el.scrollTop=el.scrollHeight;
  _ibAiBusy=true;
  var sendBtn=document.getElementById('ib-ai-send'),proBtn=document.getElementById('ib-ai-proactive');
  if(sendBtn)sendBtn.disabled=true;if(proBtn)proBtn.disabled=true;
  var done=function(){ _ibAiBusy=false; if(sendBtn)sendBtn.disabled=false; if(proBtn)proBtn.disabled=false; };
  ibBridgeFetch(ibBridgeBase()+'/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:key,message:text,maxContinues:2})}).then(function(r){return r.json()}).then(function(j){
    if(j&&j.ok){
      t.textContent=j.reply||'（空回复）';
      if(j.continued)t.textContent+='\n\n[已自动续写 '+j.continued+' 次]';
      try{ ibRichifyAny(t); }catch(e){}
      el.scrollTop=el.scrollHeight;
      ibAiLoadSessions(true);
    }else{
      t.textContent='[错误] '+(j&&j.error||'未知错误');
    }
    done();
  }).catch(function(NS){ t.textContent='[错误] Bridge 未连接'; done(); });
}

function ibAiProactive(){
  var sel=document.getElementById('ib-ai-session');
  if(!sel||!sel.value){ ibToast('请先新建常驻会话'); return; }
  if(_ibAiBusy){ ibToast('正在生成中，请稍候'); return; }
  _ibAiBusy=true;
  var sendBtn=document.getElementById('ib-ai-send'),proBtn=document.getElementById('ib-ai-proactive');
  if(sendBtn)sendBtn.disabled=true;if(proBtn)proBtn.disabled=true;
  var done=function(){ _ibAiBusy=false; if(sendBtn)sendBtn.disabled=false; if(proBtn)proBtn.disabled=false; };
  ibBridgeFetch(ibBridgeBase()+'/api/ai/proactive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:sel.value})}).then(function(r){return r.json()}).then(function(j){
    ibToast(j&&j.ok?('TA 主动说：'+String(j.text||'').slice(0,40)):('主动消息失败：'+(j&&j.error||'')));
    ibAiLoadMsgs();
    ibAiLoadSessions(true);
    done();
  }).catch(function(NS){ ibToast('Bridge 未连接'); done(); });
}

/* ---------- 初始化 ---------- */
function ibBoot(){
  window.__ibBootCount=(window.__ibBootCount||0)+1;
  if(window.__ibBootCount>1)return;   /* 重复初始化保护：只绑定一次事件与定时器 */
  try{ ibNetDefaults(); }catch(e){}
  try{ ibPanelInit(); }catch(e){}
  try{ ibCtxInit(); }catch(e){}
  try{ ibObserve(); }catch(e){}
  try{ ibAddStickerButtons(); }catch(e){}
  try{ ibPanelConn(); }catch(e){}
  try{ ibCtxRefresh(); }catch(e){}
  setInterval(function(NS){ if(document.hidden)return;try{ ibCtxRefresh(); }catch(e){} },8000);
  setInterval(function(NS){ if(document.hidden)return;try{ ibPanelConn(); }catch(e){} },15000);
  try{
    document.addEventListener('ib-net-message',function(){ try{ ibPanelConn(); }catch(e){} });
    document.addEventListener('ib-net-push',function(){ try{ ibPanelConn(); }catch(e){} });
    document.addEventListener('visibilitychange',function(){if(!document.hidden){try{ibCtxRefresh();ibPanelConn()}catch(e){}}});
  }catch(e){}
}
window.__ibBootFn=ibBoot;

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ibBoot);
else setTimeout(ibBoot,0);


/* ---- window.IB 命名空间迁移：所有权标记 ---- */
NS.expose('bridge', {
  mounted: true,
  ttsPayload: _ibTtsPayload,
  ttsVoiceHead: ibTtsVoiceHead,
  ttsVoiceList: ibTtsVoiceList,
  ttsVoiceCheckImport: ibTtsVoiceCheckImport
});
})(window.IB || (window.IB = {}));
