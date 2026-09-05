/* ====================================================================
   IB Favorites — 跨模块统一收藏层
   --------------------------------------------------------------------
   - 存储：IndexedDB store `favorites`（keyPath id）。每条收藏是一个"引用 + 文本快照"，
     不复制二进制（语音/图片在渲染时按 sourceId 回读，原记录删除则降级为纯文本）。
   - 供 Chat / Blog / Letters / Moments / 陪伴活动 等模块共用同一套 add/remove/list 表面。
   - 仅作展示层分组：type 是展示语义（text|voice|image|blog|letter|moment|activity|cal），非 RBAC。
   - 本文件遵循 split 约定：IIFE 私有作用域 + window 双挂载 + IB.favorites 注册。
   ==================================================================== */
(function(NS){
  'use strict';
  var FAV_STORE='favorites';

  function now(){return Date.now()}

  /* ---- 引用解析：从原始来源回读二进制（语音 dataUrl / 图片 thumbnails） ---- */
  async function _resolveSource(fav){
    var src={};
    try{
      if(fav.type==='chat'&&fav.sourceId&&typeof dbGet==='function'){
        var m=await dbGet('chatMessages',fav.sourceId);
        if(m){
          if(m.voice&&m.voice.dataUrl)src.voice={dataUrl:m.voice.dataUrl,mime:m.voice.mime,duration:m.voice.duration,transcript:m.voice.transcript||''};
          if(m.images&&m.images.length)src.images=m.images.slice(0,4);
        }
      }
      if(fav.type==='blog'&&fav.sourceId&&typeof dbGet==='function'){
        var p=await dbGet('posts',fav.sourceId);
        if(p){src.body=p.content||''}
      }
    }catch(e){src={}}
    return src;
  }

  /* ---- 统一 API ---- */
  async function add(item){
    if(!item||!item.sourceId)return null;
    if(!item.type)item.type='chat';
    var id='fav_'+now()+'_'+Math.floor(Math.random()*1000);
    var rec={
      id:id,type:item.type,roleId:item.roleId||'',sourceId:String(item.sourceId),
      title:item.title||'',body:String(item.body||'').slice(0,6000),
      meta:item.meta||{},createdAt:now(),updatedAt:now()
    };
    try{await dbPut(FAV_STORE,rec)}catch(e){return null}
    if(typeof currentPage!=='undefined'&&currentPage==='favorites'&&typeof _favRenderWall==='function'){try{_favRenderWall()}catch(e){}}
    return rec;
  }
  async function remove(id){
    if(!id)return false;
    try{await dbDelete(FAV_STORE,id)}catch(e){return false}
    if(typeof currentPage!=='undefined'&&currentPage==='favorites'&&typeof _favRenderWall==='function'){try{_favRenderWall()}catch(e){}}
    return true;
  }
  async function removeBySource(type,sourceId){
    if(typeof dbGetAll!=='function')return 0;
    var all=await dbGetAll(FAV_STORE);var n=0;
    for(var f of all){if(f&&f.sourceId===String(sourceId)&&(!type||f.type===type)){if(await remove(f.id))n++}}
    return n;
  }
  async function has(sourceId){
    if(typeof dbGetAll!=='function')return false;
    var all=await dbGetAll(FAV_STORE);return all.some(function(f){return f&&f.sourceId===String(sourceId)});
  }
  async function list(opts){
    opts=opts||{};
    var all=await dbGetAll(FAV_STORE);
    if(opts.type)all=all.filter(function(f){return f.type===opts.type});
    if(opts.roleId)all=all.filter(function(f){return f.roleId===opts.roleId});
    all.sort(function(a,b){return (b.updatedAt||0)-(a.updatedAt||0)});
    return all;
  }
  async function count(){var all=await dbGetAll(FAV_STORE);return all.length}

  /* ---- 渲染：收藏墙（page-favorites） ---- */
  function _favEsc(s){if(!s)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
  function _favShort(s){return s.length>160?s.slice(0,160)+'…':s}
  function _favFmt(ts){try{return new Date(ts||Date.now()).toLocaleString('zh-CN',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})}catch(e){return''}}
  function _favTypeLabel(t){
    return ({chat:'消息',voice:'语音',image:'图片',blog:'日志',letter:'信件',moment:'动态',activity:'活动',cal:'日程'}[t])||'收藏';
  }
  async function _favRenderWall(){
    var wall=document.getElementById('fav-wall');
    if(!wall)return;
    var all=await list();
    if(!all.length){wall.innerHTML='<div class="empty-state"><span>☆</span>还没有收藏。聊天、日志、信件、动态里点「收藏」就会收进这里。</div>';return}
    var byType={};
    for(var f of all){var t=f.type||'chat';(byType[t]=byType[t]||[]).push(f)}
    var html='';
    var order=Object.keys(byType).sort();
    for(var k of order){
      html+='<div class="fav-group"><div class="fav-group-head">'+_favTypeLabel(k)+' · '+byType[k].length+'</div>';
      for(var f2 of byType[k]){
        var src=await _resolveSource(f2);
        var body=f2.body||(src.body?src.body.slice(0,6000):'');
        var bubbles='';
        if(src.voice&&src.voice.dataUrl){bubbles+='<button class="fav-voice" data-favid="'+f2.id+'">▶ '+_favEsc(src.voice.transcript||'语音')+'</button>'}
        if(src.images&&src.images.length){
          bubbles+='<div class="fav-imgs">';
          for(var im of src.images){var u=(im&&(im.dataUrl||im.url))||'';if(u)bubbles+='<img class="fav-img" loading="lazy" decoding="async" src="'+u+'">'}
          bubbles+='</div>';
        }
        html+='<div class="fav-paper" data-favid="'+f2.id+'"><div class="fav-paper-head"><span class="fav-tag">'+_favTypeLabel(f2.type)+'</span><span class="fav-title">'+_favEsc(f2.title||_favShort(body))+'</span></div>'+
          '<div class="fav-tx">'+_favEsc(_favShort(body))+'</div>'+
          bubbles+
          '<div class="fav-paper-foot"><span>'+_favFmt(f2.updatedAt)+'</span><span class="fav-paper-acts"><button class="fav-open" data-favopen="'+f2.id+'">打开原内容</button><button class="fav-del" data-favdel="'+f2.id+'">移除</button></span></div>'+
          '</div>';
      }
      html+='</div>';
    }
    wall.innerHTML=html;
    var mk=wall.querySelectorAll('.fav-voice');for(var i=0;i<mk.length;i++)(function(el){el.onclick=function(){_favPlay(el.getAttribute('data-favid'))}})(mk[i]);
    var delk=wall.querySelectorAll('.fav-del');for(var j=0;j<delk.length;j++)(function(el){el.onclick=function(){remove(el.getAttribute('data-favdel'))}})(delk[j]);
    var opk=wall.querySelectorAll('.fav-open');for(var o=0;o<opk.length;o++)(function(el){el.onclick=async function(){await _favOpenItem(el.getAttribute('data-favopen'))}})(opk[o]);
  }
  async function _favPlay(id){
    try{
      if(window._favAu)window._favAu.pause();
      var fav=(await list()).find(function(f){return f.id===id});if(!fav)return;
      var src=await _resolveSource(fav);if(!src.voice||!src.voice.dataUrl){if(typeof toast==='function')toast('这条语音已随原消息删除，只剩文字稿');return}
      var au=new Audio(src.voice.dataUrl);window._favAu=au;au.play().catch(function(){});
    }catch(e){}
  }

  /* ---- 跳回原内容（尽力而为：切到对应页面/频道/日志） ---- */
  async function _favOpenItem(id){
    var fav=(await list()).find(function(f){return f.id===id});if(!fav)return;
    var t=fav.type||'chat',src=fav.sourceId||'';
    try{
      if(t==='chat'){
        var meta=fav.meta||{};
        if(typeof selectThread==='function'&&meta.threadId&&meta.roleId){selectThread(meta.roleId,meta.threadId);if(typeof navTo==='function')navTo('chat');toast('已跳到该消息所在频道');return}
        if(typeof navTo==='function')navTo('chat');toast('已打开聊天（该消息所在的频道在右上角）');return;
      }
      if(t==='blog'){if(typeof navTo==='function')navTo('blog');setTimeout(function(){try{if(typeof viewPost==='function')viewPost(src)}catch(e){}},80);return}
      if(t==='letter'){if(typeof navTo==='function')navTo('letters');toast('已打开信件');return}
      if(t==='moment'){if(typeof navTo==='function')navTo('moments');toast('已打开动态');return}
      if(t==='activity'){if(typeof window.IB!=='undefined'&&IB.activity&&typeof IB.activity.openChat==='function'){IB.activity.openChat(src)}return}
      if(t==='cal'){if(typeof navTo==='function')navTo('cal');toast('已打开日程');return}
    }catch(e){try{if(typeof toast==='function')toast('已打开相关模块')}catch(e2){}}
  }

  /* ---- 可复用收藏切换按钮（供任何模块给"适合收藏的内容"加 ★） ---- */
  var _makeBtnPrefix=0;
  function makeBtn(opts){
    opts=opts||{};
    var b=document.createElement('button');b.className='fav-toggle-btn';b.textContent='☆';b.title='收藏';b.setAttribute('aria-label','收藏');
    function setState(v){b.textContent=v?'★':'☆';b.title=v?'取消收藏':'收藏'}
    try{if(typeof has==='function')has(opts.sourceId).then(setState,function(){})}catch(e){}
    b.onclick=function(ev){ev.stopPropagation();(async function(){
      try{
        var h=await has(opts.sourceId);
        if(h){await removeBySource(opts.type,opts.sourceId);setState(false);try{if(typeof toast==='function')toast('已取消收藏')}catch(e){}}
        else{var rec=await add({type:opts.type,roleId:opts.roleId||'',sourceId:opts.sourceId,title:opts.title||'',body:String(opts.body||'').slice(0,6000),meta:opts.meta||{}});setState(!!rec);try{if(typeof toast==='function')toast(rec?'已收藏':'收藏失败')}catch(e){}}
      }catch(e){}
    })()};
    return b;
  }

  /* ---- 把一枚收藏星粘到既有元素上（供 Blog/Moment/Letter/Cal 列表项复用） ---- */
  function starCard(el,opts){if(!el||typeof makeBtn!=='function')return;var b=makeBtn(opts);b.classList.add('fav-inline');el.appendChild(b);return b}

  /* ---- 供页面装载 ---- */
  async function openPage(){await _favRenderWall();try{if(typeof updateChatStorageInfo==='function')updateChatStorageInfo()}catch(e){}}

  /* ---- 注册：IIFE 私有 + window + IB 双挂载（D6） ---- */
  var api={add:add,remove:remove,removeBySource:removeBySource,has:has,list:list,count:count,
    openPage:openPage,_favRenderWall:_favRenderWall,_favPlay:_favPlay,makeBtn:makeBtn,starCard:starCard,_favOpenItem:_favOpenItem};
  NS.favorites=api;
  window.favAdd=add;window.favRemove=remove;window.favRemoveBySource=removeBySource;window.favList=list;window.favHas=has;
  window._favRenderWall=_favRenderWall;window.favOpenPage=openPage;window.ibFavMakeBtn=makeBtn;
  window.ibFavStarCard=starCard;window._favOpenItem=_favOpenItem;
})(window.IB || (window.IB = {}));
