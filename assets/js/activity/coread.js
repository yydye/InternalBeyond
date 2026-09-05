/* ====================================================================
   IB Coread — 共读间（builtin 陪伴活动）
   --------------------------------------------------------------------
   一篇日志＝一本书：从 Blog（posts store）现读，分页、书签、进度；
   选一位 AI 一起读，聊天落在「共读 · 书名」话题频道（IB.activity 统一运行时）。
   - 上下文仅透露到当前页 + 前文梗概（getActivityContext 注入）。
   - Memory 回写（IB.activity.writeMemory）与 Proactive 联动（nudge）。
   ==================================================================== */
(function(NS){
  'use strict';
  var _book=null,_pages=[],_pi=0,_aiId='',_bm=[],_charsPerPage=420,_cfg={};
  var SELFS='assets/js/activity/coread.js';

  function _esc(s){if(!s)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
  function _toast(m){try{if(typeof toast==='function')toast(m)}catch(e){}}

  /* ---- 分页：按段落边界切，尽量贴近每页 _charsPerPage ---- */
  function _paginate(text){
    var paras=text.split(/\n+/).filter(function(p){return p.trim()}),
        pages=[],cur='';
    for(var i=0;i<paras.length;i++){
      var p=paras[i];
      if(cur&&(cur.length+p.length+1)>_charsPerPage){pages.push(cur);cur=p}
      else cur=cur?(cur+'\n\n'+p):p;
      if(cur.length>=_charsPerPage*1.6){pages.push(cur);cur=''}
    }
    if(cur)pages.push(cur);
    return pages.length?pages:[text||''];
  }
  function _pct(){return _pages.length?Math.min(100,Math.round(((_pi+1)/_pages.length)*100)):0}
  function _progress(prevText){
    return {
      page:_pi+1,total:_pages.length,pct:_pct(),chapter:_book?(_book.title||''):'',
      pageText:_pages[_pi]||'',recap:prevText||'',upTo:0,dur:0,sec:0,subs:[]
    };
  }

  /* ---- 渲染书架 ---- */
  async function paintShelf(){
    var shelf=document.getElementById('coread-shelf');if(!shelf)return;
    var posts=await dbGetAll('posts');posts=posts.filter(function(p){return p&&!p.locked}).sort(function(a,b){return (b.created||0)-(a.created||0)});
    var acts=await IB.activity.listActivities({type:'coread'});
    var recent=acts.slice(0,5);
    var html='';
    if(recent.length){
      html+='<div class="cr-group"><div class="cr-group-head">最近在读</div>';
      for(var r of recent){var p=posts.find(function(x){return x.id===r.resourceId});html+='<div class="cr-book" onclick="coreadOpen(\''+r.resourceId+'\')"><div class="cr-book-title">'+_esc(r.title||'')+'</div><div class="cr-book-meta">与 '+_esc(r.progress&&r.progress.roleName||'TA')+' · 读到第 '+((r.progress&&r.progress.page)||1)+' 页</div></div>'}
      html+='</div>';
    }
    if(!posts.length){shelf.innerHTML='<div class="empty-state"><span>✎</span>还没有公开日志。先到「Blog」写一篇，就能和 TA 一起读。</div>';return}
    html+='<div class="cr-group"><div class="cr-group-head">书架</div>';
    for(var q of posts){var a=acts.find(function(x){return x.resourceId===q.id});html+='<div class="cr-book" onclick="coreadOpen(\''+q.id+'\')"><div class="cr-book-title">'+_esc(q.title||'无标题')+'</div><div class="cr-book-meta">'+_esc((q.subtitle||'').slice(0,50))+(a?(' · 读到 '+(a.progress&&a.progress.page||1)+' 页'):'')+'</div></div>'}
    html+='</div>';
    shelf.innerHTML=html;
  }

  /* ---- 打开一本书 ---- */
  async function coreadOpen(postId){
    var post=await dbGet('posts',postId);if(!post){_toast('日志不存在');return}
    var cfgs=(apiConfigs||[]).filter(function(c){return c&&!String(c.id).startsWith('group_')});
    if(!cfgs.length){_toast('请先在 API 页添加一个 AI');return}
    if(!_aiId)_aiId=cfgs[0].id;
    /* 分页 */
    _book=post;_pages=_paginate(post.content||'');_pi=0;
    var existing=await IB.activity.findActivity('coread',_aiId,post.id);
    if(existing){_activity=existing;_cfg=existing;_bm=(existing.bookmarks||[]).slice()}
    else{_cfg={};_bm=[]}
    /* 创建/复用活动 + 频道 */
    var act=existing||(await IB.activity.createActivity({type:'coread',roleId:_aiId,resourceId:post.id,resourceKey:post.id,
      title:post.title||'',kind:'coread',name:'共读 · '+(post.title||'').slice(0,24),quiet:true,memory:true,
      progress:_progress(),bookmarks:_bm}));
    if(!act){_toast('创建共读活动失败');return}
    _aiId=act.roleId;_activity=act;
    _renderReader();_renderNotes();_renderAiSel(cfgs);
    /* 切换页面容器 */
    var list=document.getElementById('coread-list-view'),rd=document.getElementById('coread-read-view');
    if(list)list.style.display='none';if(rd)rd.style.display='block';
    await _saveProgress();
  }
  function _renderAiSel(cfgs){
    ['cr-ai','cr-ai-rd'].forEach(function(selId){var sel=document.getElementById(selId);if(!sel)return;
      sel.innerHTML=cfgs.map(function(c){return '<option value="'+c.id+'">'+_esc(c.nickname||c.model||'AI')+'</option>'}).join('');
      sel.value=_aiId;});
  }
  function _renderReader(){
    var host=document.getElementById('cr-page');if(!host)return;
    var t=document.getElementById('cr-title');if(t)t.textContent=_book.title||'';
    var meta=document.getElementById('cr-progress');if(meta)meta.textContent='第 '+(_pi+1)+' / '+_pages.length+' 页 · '+_pct()+'%';
    var prev=_pages.slice(0,_pi).join('\n\n').slice(-600);
    host.innerHTML='<div class="cr-text">'+_pages[_pi].split(/\n+/).map(function(p){return'<p>'+_esc(p)+'</p>'}).join('')+'</div>'
      +(prev?'<div class="cr-recap"><span>前文梗概</span>'+_esc(prev.slice(0,300))+'</div>':'');
    window._ibCoreadHintM=_book.id;
  }
  async function _saveProgress(){
    if(!_book||!_activity)return;
    await IB.activity.setProgress(_activity.id,_progress(_pages.slice(0,_pi).join('\n\n').slice(-600)));
  }
  function _prevPage(){if(_pi>0){_pi--;_renderReader();_saveProgress()}}
  function _nextPage(){if(_pi<_pages.length-1){_pi++;_renderReader();_saveProgress()}}
  function _newPage(){if(_pi<_pages.length-1){_pi++;_renderReader();_saveProgress()}}
  function _toggleBm(){
    if(!_book)return;
    var bm={off:_pi,page:_pi+1,t:'',snip:_pages[_pi].slice(0,80)};
    var i=_bm.findIndex(function(b){return b.page===bm.page});
    if(i>=0)_bm.splice(i,1);else _bm.push(bm);
    if(_activity)IB.activity.saveActivity(_activity.id,{bookmarks:_bm.slice()});
    _toast(i>=0?'已取消书签':'已加书签（第 '+(_pi+1)+' 页）');
  }

  /* ---- 发送到共读频道 ---- */
  async function _coreadSend(){
    var input=document.getElementById('cr-input');if(!input)return;
    var text=input.value.trim();if(!text)return;
    if(!_activity){_toast('请先打开一本书');return}
    input.value='';
    await IB.activity.send(_activity.id,text,{progress:_progress(_pages.slice(0,_pi).join('\n\n').slice(-600))});
    await waitChatThenRender();
  }
  function _waitMs(ms){return new Promise(function(r){setTimeout(r,ms)})}
  async function waitChatThenRender(){await _waitMs(500);_renderNotes()}

  /* ---- 渲染频道最近消息 ---- */
  async function _renderNotes(){
    var host=document.getElementById('cr-notes');if(!host||!_activity)return;
    var all=await dbGetAll('chatMessages');
    var msgs=all.filter(function(m){return m.threadId===_activity.threadId}).sort(function(a,b){return a.timestamp-b.timestamp});
    if(!msgs.length){host.innerHTML='<div class="cr-note-empty">在这里与 TA 聊这一页。</div>';return}
    host.innerHTML=msgs.slice(-40).map(function(m){
      var who=m.role==='user'?'我':(m.senderName||'TA');
      var mine=(m.role==='user');
      return '<div class="cr-note '+(mine?'mine':'ta')+'"><div class="cr-note-who">'+_esc(who)+'</div><div class="cr-note-body">'+_esc(String(m.content||''))+'</div></div>';
    }).join('');
  }

  /* ---- 页面装载 ---- */
  async function loadCoreadPage(){await paintShelf();_renderAiSel((apiConfigs||[]).filter(function(c){return c&&!String(c.id).startsWith('group_')}))}

  /* 绑定按钮 */
  function bind(){
    var prev=document.getElementById('cr-prev'),next=document.getElementById('cr-next');
    var bm=document.getElementById('cr-bm'),send=document.getElementById('cr-send'),mem=document.getElementById('cr-mem'),nudge=document.getElementById('cr-nudge');
    var open=document.getElementById('cr-open-chat');
    if(prev)prev.onclick=_prevPage;if(next)next.onclick=_nextPage;
    if(bm)bm.onclick=_toggleBm;
    if(send)send.onclick=_coreadSend;
    if(mem)mem.onclick=async function(){if(!_activity){_toast('请先打开一本书');return}await IB.activity.writeMemory(_activity,'共读 · '+(_book&&_book.title||''),_pages.slice(0,_pi+1).join('\n\n').slice(0,400));_toast('已把这一段共同阅读写进记忆');};
    if(nudge)nudge.onclick=async function(){if(!_activity){_toast('请先打开一本书');return}await IB.activity.nudge({activityId:_activity.id});_toast('已安排 TA 稍后提醒你继续共读');};
    if(open)open.onclick=function(){if(_activity)IB.activity.openChat(_activity.id)};
    var input=document.getElementById('cr-input');if(input)input.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();_coreadSend()}});
  }
  var _activity=null;

  /* ---- 注册：IB.coread + window ---- */
  function coreadPaintshelf(){var list=document.getElementById('coread-list-view'),rd=document.getElementById('coread-read-view');if(list)list.style.display='block';if(rd)rd.style.display='none';paintShelf()}
  var api={paintShelf:paintShelf,coreadOpen:coreadOpen,loadCoreadPage:loadCoreadPage,bind:bind,coreadPaintshelf:coreadPaintshelf};
  NS.coread=api;
  window.coreadOpen=coreadOpen;window._coreadSend=_coreadSend;window._coreadPrev=_prevPage;window._coreadNext=_nextPage;
  window.loadCoreadPage=loadCoreadPage;window.coreadPaintshelf=coreadPaintshelf;
  if(typeof document!=='undefined'&&document.readyState!=='loading'){try{bind()}catch(e){}}
})(window.IB || (window.IB = {}));
