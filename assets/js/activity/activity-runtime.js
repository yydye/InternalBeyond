/* ====================================================================
   IB Activity — 统一「陪伴活动 / Companion Session Runtime」
   --------------------------------------------------------------------
   Coread（共读间）与 Cinema（观影室）共享同一套活动状态机：
     Session / Activity 状态 · 多角色（1:1 roleId）参与 · 位置/进度 ·
     评论/讨论（落进独立话题频道）· 收藏联动 · Memory 回写 ·
     Proactive 联动 · 持久化与备份恢复。
   - 存储：IndexedDB store `activities`（keyPath id）。配套聊天频道放在
     `chatThreads`（每个活动一对（roleId, type, resourceId）一条 `kind` 频道）。
   - 上下文：`getActivityContext(friendId,{threadId})` 由 communication.js 的
     _buildSingleChatContext 注入（与 getMomentsContext 同款），只透露到当前页/进度为止。
   - Memory：`writeMemory` 走 quickCreateMemory（source=coread|cinema）。
   - Proactive：`nudge` 生成一条活动感知的主动消息计划（_activeSaveAiPlan）。
   - 本文件遵循 split 约定：IIFE 私有作用域 + window 双挂载 + IB.activity 注册。
   ==================================================================== */
(function(NS){
  'use strict';
  var ACT_STORE='activities';

  function _now(){return Date.now()}
  function _esc(s){if(!s)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
  function _fmt(sec){
    sec=Math.max(0,Math.floor(sec||0));
    var m=Math.floor(sec/60),s=sec%60,h=Math.floor(m/60);m=m%60;
    return (h?(h+':'+String(m).padStart(2,'0')):String(m))+':'+String(s).padStart(2,'0');
  }
  function _toast(m){try{if(typeof toast==='function')toast(m)}catch(e){}}

  /* ---- 频道创建/复用：一对（roleId, kind, resourceKey）一条 ---- */
  async function _ensureThread(p){
    p=p||{};
    if(typeof dbGetAll!=='function')return null;
    var all=await dbGetAll('chatThreads');
    var key=p.resourceKey||String(p.resourceId||'');
    var found=all.find(function(t){return t&&String(t.friendId)===String(p.roleId)&&t.kind===p.kind&&(t.resourceKey===key||t.filmHash===key)});
    if(found)return found;
    if(typeof dbPut!=='function')return null;
    var thr={id:'thread_'+_now(),friendId:String(p.roleId),name:String(p.name||p.title||'陪伴').slice(0,60),
      memoryEnabled:(p.memory!==false),created:_now(),kind:p.kind||'activity',quiet:(p.quiet!==false),
      resourceKey:key,filmHash:key};
    try{await dbPut('chatThreads',thr)}catch(e){return null}
    return thr;
  }

  /* ---- 创建/恢复活动 ---- */
  async function createActivity(p){
    p=p||{};
    if(typeof dbPut!=='function')return null;
    if(!p.type||!p.roleId||!p.resourceId)return null;
    var id='act_'+_now()+'_'+Math.floor(Math.random()*1000);
    var thr=await _ensureThread(p);
    if(!thr)return null;
    var rec={
      id:id,type:p.type,roleId:String(p.roleId),resourceId:String(p.resourceId),resourceKey:p.resourceKey||String(p.resourceId),
      title:p.title||'',kind:p.kind||p.type,threadId:thr.id,
      progress:p.progress||{},bookmarks:p.bookmarks||[],recap:p.recap||'',config:p.config||{},
      status:'active',createdAt:_now(),updatedAt:_now(),lastActiveAt:_now()
    };
    try{await dbPut(ACT_STORE,rec)}catch(e){return null}
    _emit(rec.id,'activity',rec);
    return rec;
  }
  async function getActivity(id){if(typeof dbGet!=='function')return null;return await dbGet(ACT_STORE,id)}
  async function findActivity(type,roleId,resourceId){
    if(typeof dbGetAll!=='function')return null;
    var all=await dbGetAll(ACT_STORE);
    return all.find(function(a){return a&&a.type===type&&String(a.roleId)===String(roleId)&&String(a.resourceId)===String(resourceId)})||null;
  }
  async function listActivities(opts){
    opts=opts||{};if(typeof dbGetAll!=='function')return[];
    var all=await dbGetAll(ACT_STORE);
    if(opts.type)all=all.filter(function(a){return a.type===opts.type});
    if(opts.roleId)all=all.filter(function(a){return a.roleId===opts.roleId});
    all.sort(function(a,b){return (b.updatedAt||0)-(a.updatedAt||0)});
    return all;
  }
  async function saveActivity(id,patch){
    var rec=await getActivity(id);if(!rec||typeof dbPut!=='function')return null;
    for(var k in patch)rec[k]=patch[k];
    rec.updatedAt=_now();
    try{await dbPut(ACT_STORE,rec);_emit(rec.id,'update',rec)}catch(e){return null}
    return rec;
  }
  async function deleteActivity(id){
    var rec=await getActivity(id);
    if(rec&&rec.threadId&&typeof dbDelete==='function'){try{await dbDelete('chatThreads',rec.threadId)}catch(e){}}
    if(typeof dbDelete==='function'){try{await dbDelete(ACT_STORE,id)}catch(e){return false}}
    return true;
  }
  async function setProgress(id,prog){return await saveActivity(id,{progress:prog,lastActiveAt:_now()})}

  /* ---- 上下文注入（communication.js 钩子调用） ---- */
  function _chapterAt(off,text){
    var idx=text.lastIndexOf('\n#',off);if(idx<0)idx=0;
    var line=text.slice(idx+2,text.indexOf('\n',idx)).trim();
    return line||'';
  }
  async function buildActivityContext(rec,opts){
    opts=opts||{};
    if(!rec)return'';
    var type=rec.type,lines=[];
    lines.push('———— 以下是系统随消息附上的陪伴活动状态，不是对方说的话 ————');
    if(type==='coread'){
      var prog=rec.progress||{},cur=(prog.page||1),total=(prog.total||1);
      var chapter=prog.chapter||'';
      lines.push('【共读】你们正在一起读《'+(rec.title||'')+'》· 第 '+(cur>total?total:cur)+' / '+total+' 页 · 进度 '+Math.round((prog.pct||0))+'%'+(chapter?(' · '+chapter):''));
      if(prog.pageText){lines.push('［对方此刻读到的这一页］\n'+String(prog.pageText).slice(0,2000))}
      if(prog.recap){lines.push('［前文梗概］\n'+String(prog.recap).slice(0,600))}
      lines.push('［说明］以上就是这一轮 TA 读到的全部，后面的页你还没读到，不猜测、不预告，围绕当前页谈。');
    }else if(type==='cinema'){
      var prog2=rec.progress||{},sec=prog2.sec||0;
      lines.push('【观影室】你们正在一起看《'+(rec.title||'')+'》· 进度 '+_fmt(sec)+(prog2.dur?(' / '+_fmt(prog2.dur)):''));
      if(prog2.subs&&prog2.subs.length){lines.push('［播放点之前最近的字幕］\n'+prog2.subs.slice(0,6).map(function(c){return'['+_fmt(c[0])+'] '+String(c[2]).replace(/\n/g,' ')}).join('\n'))}
      if(prog2.recap){lines.push('［前情梗概（到 '+_fmt(prog2.upTo||0)+'）］\n'+String(prog2.recap).slice(0,600))}
      lines.push('［说明］以上是这一轮你知道的全部：只到播放点为止，后面的剧情你不知道，不预告、不猜。');
    }
    lines.push('［系统留白］若你觉得现在不适合继续，可以自然停顿，不必硬聊。');
    return '\n'+lines.join('\n');
  }
  /* communication.js 钩子：给定好友+话题频道，返回活动上下文（无则空串） */
  async function getActivityContext(friendId,opts){
    opts=opts||{};
    var threadId=opts.threadId||null;
    if(!threadId||typeof dbGetAll!=='function')return'';
    var all=await dbGetAll(ACT_STORE);
    var rec=all.find(function(a){return a&&String(a.roleId)===String(friendId)&&a.threadId===threadId&&a.status!=='finished'});
    if(!rec)return'';
    return await buildActivityContext(rec,opts);
  }

  /* ---- 发送：把用户文字投入活动频道 ---- */
  async function send(activityId,text,extra){
    extra=extra||{};
    var rec=await getActivity(activityId);if(!rec)return{ok:false,error:'no_activity'};
    activeFriendId=rec.roleId;activeThreadId=rec.threadId;
    if(extra.progress)await setProgress(activityId,extra.progress);
    if(typeof sendChatMessage!=='function')return{ok:false,error:'no_chat'};
    /* sendChatMessage 从 Chat 输入框读取文本；活动输入框是独立容器，需把文字注入再调用，
       事后恢复原值，避免污染主聊天草稿。 */
    var inp=null;
    try{var mini=document.getElementById('chat-input');var full=document.getElementById('chat-full-input');inp=(typeof currentPage!=='undefined'&&currentPage==='chat'&&full)?full:(mini||full)}catch(e){}
    if(!inp)return{ok:false,error:'no_input'};
    var prev=inp.value;inp.value=String(text||'');
    try{await sendChatMessage.call(window)}catch(e){return{ok:false,error:String(e&&e.message||e)}}
    finally{inp.value=prev}
    return{ok:true};
  }
  /* 把活动频道带到前台 Chat */
  function openChat(activityId){(async function(){var r=await getActivity(activityId);if(!r)return;activeFriendId=r.roleId;activeThreadId=r.threadId;if(typeof selectThread==='function')selectThread(r.roleId,r.threadId);if(typeof navTo==='function')navTo('chat')})();}

  /* ---- Memory 回写：quickCreateMemory（source=type） ---- */
  async function writeMemory(activity,title,content){
    if(!activity||typeof quickCreateMemory!=='function')return false;
    var cfg=(apiConfigs||[]).find(function(a){return a.id===activity.roleId})||{};
    try{
      var data={
        title:title||(activity.type==='coread'?'共读 · '+(activity.title||''):'观影 · '+(activity.title||'')),
        summary:String(content||'').slice(0,300),
        content:String(content||''),
        source:activity.type,sourceId:activity.id,domain:'陪伴',
        tags:[activity.type,(activity.title||'').slice(0,8)],valence:0.6,arousal:0.3,importance:4,resolved:false,
        visibility:'only',visibleTo:[activity.roleId],
        createdBy:activity.roleId,createdByName:(cfg.nickname||cfg.model||'AI'),editedByUser:false
      };
      var id=await quickCreateMemory(data);return !!id;
    }catch(e){return false}
  }

  /* ---- Proactive 联动：生成一条活动感知的主动消息计划（幂等 + 冷却） ---- */
  async function nudge(o){
    o=o||{};
    var rec=o.activityId?(await getActivity(o.activityId)):o.activity;
    if(!rec||rec.status==='finished')return false;
    if(typeof _activeSaveAiPlan!=='function')return false;
    var now=_now();
    /* 冷却：同一活动 8 分钟内只允许一次 nudge，避免高频堆叠 */
    if(rec.lastNudgeAt&&(now-rec.lastNudgeAt)<8*60*1000)return false;
    /* 幂等：该角色 + 该活动频道已有一条待执行/等待中的主动计划则不重复创建 */
    try{
      var all=await dbGetAll('active_message_plans');
      var pending=(all||[]).find(function(p){return p&&p.characterId===rec.roleId&&p.source==='ai_planned'&&(p.status==='scheduled'||p.status==='waiting_for_user')&&String(p.sourceConversationId||'')===String(rec.threadId||'')});
      if(pending)return false;
    }catch(e){}
    var cfg=(apiConfigs||[]).find(function(a){return a.id===rec.roleId});
    if(!cfg)return false;
    var kindText=rec.type==='coread'?'一起读《'+rec.title+'》':'一起看《'+rec.title+'》';
    var plan={
      id:'plan_'+_now(),characterId:rec.roleId,type:'proactive_chat',interaction:'text_message',
      status:'scheduled',source:'ai_planned',
      scheduledAt:o.delayMs?(_now()+o.delayMs):(_now()+5*60*1000),
      intent:'挂念+'+(rec.type==='coread'?'共读':'观影')+'：邀请继续'+kindText,
      reason:'共同活动中断一段时间，邀请对方回到'+kindText+'。',
      cancelConditions:{cancelIfUserReplies:true,cancelIfIntentResolved:true,cancelIfNewerPlanExists:true,respectDoNotDisturb:true},
      constraints:{maxAttempts:2,allowReschedule:false,allowFollowUpPlan:false},
      sourceConversationId:rec.threadId||'',sourceMessageId:'' ,createdAt:now
    };
    try{await saveActivity(rec.id,{lastNudgeAt:now});await _activeSaveAiPlan(plan);return true}catch(e){return false}
  }

  /* ---- 活动标记（开始/结束分隔） ---- */
  async function mark(activityId,phase,label){
    var rec=await getActivity(activityId);if(!rec)return;
    if(typeof dbPut!=='function')return;
    var msg={id:'msg_'+_now()+'_k',role:'user',content:String(label||phase||'').slice(0,400),friendId:rec.roleId,
      timestamp:_now(),threadId:rec.threadId,mark:{app:'activity',kind:rec.type,phase:phase||'mark',label:String(label||'').slice(0,140)}};
    try{await dbPut('chatMessages',msg)}catch(e){}
  }

  /* ---- 事件订阅（给 App 前端） ---- */
  var _ev={};
  function _on(id,ev,fn){(_ev[id]=_ev[id]||{})[ev]=(_ev[id][ev]||[]);(_ev[id][ev]).push(fn)}
  function _off(id,ev,fn){var a=_ev[id]&&_ev[id][ev];if(a&&fn){var i=a.indexOf(fn);if(i>=0)a.splice(i,1)}return true}
  function _emit(id,ev,payload){var a=_ev[id]&&_ev[id][ev];if(a)for(var i=0;i<a.length;i++){try{a[i](payload)}catch(e){}}}

  /* ---- 收藏联动 ---- */
  async function fav(activity,note){
    if(typeof window.IB==='undefined'||!IB.favorites||typeof IB.favorites.add!=='function')return null;
    return await IB.favorites.add({type:'activity',roleId:activity.roleId,sourceId:activity.id,
      title:activity.title||'',body:note||'陪伴活动',meta:{kind:activity.type,threadId:activity.threadId}});
  }

  /* ---- 注册：window + IB.activity ---- */
  var api={createActivity:createActivity,getActivity:getActivity,findActivity:findActivity,listActivities:listActivities,
    saveActivity:saveActivity,deleteActivity:deleteActivity,setProgress:setProgress,
    buildActivityContext:buildActivityContext,getActivityContext:getActivityContext,
    send:send,openChat:openChat,writeMemory:writeMemory,nudge:nudge,mark:mark,fav:fav,
    on:function(id,ev,fn){_on(id,ev,fn)},off:function(id,ev,fn){_off(id,ev,fn)},emit:function(){}};
  NS.activity=api;
  window.IBActivity=api;
  window.getActivityContext=getActivityContext;
  window._activityCreate=createActivity;
})(window.IB || (window.IB = {}));
