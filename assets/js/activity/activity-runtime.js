/* ====================================================================
   IB Activity — 统一「陪伴活动 / Companion Session Runtime」
   --------------------------------------------------------------------
   Coread（共读间）与 Cinema（观影室）共享同一套活动状态机：
     Session / Activity 状态 · 多角色（1:1 roleId）参与 · 位置/进度 ·
     评论/讨论 · 收藏联动 · Memory 回写 · Proactive 联动 · 持久化与备份恢复。
   - 存储：IndexedDB store `activities`（keyPath id）。活动是**上下文状态**，
     不是消息容器：新活动不再创建 `chatThreads` 频道；活动消息进入角色当前
     会话并带 `metadata.activityId`。旧数据 `activity.threadId` 指向的
     cinema/coread 频道只读保留、继续显示、继续注入旧频道上下文（legacy 支路）。
   - Current 指针：localStorage `ib_activity_current_v1`，每角色一个 current。
     指针是轻量、可重建的线索，不是 authority；丢失/失效时按
     `status==='active'` + `lastActiveAt` 最新确定性回退。
   - 上下文：`getActivityContext(friendId,{threadId,activityId})` 由
     communication.js 的 _buildSingleChatContext 注入（与 getMomentsContext 同款），
     只透露到当前页/进度为止。
   - Vision：活动上下文与 request-local `visionReference`（Cinema 留影帧）是
     两条正交链路；本文件不捕获、不存储、不转发任何像素数据。
   - Memory：`writeMemory` 走 quickCreateMemory（source=coread|cinema）。
   - Proactive：`nudge` 生成一条活动感知的主动消息计划（_activeSaveAiPlan）。
   - 本文件遵循 split 约定：IIFE 私有作用域 + window 双挂载 + IB.activity 注册。
   ==================================================================== */
(function(NS){
  'use strict';
  var ACT_STORE='activities';
  var CUR_KEY='ib_activity_current_v1';

  function _now(){return Date.now()}
  function _esc(s){if(!s)return'';var d=document.createElement('div');d.textContent=String(s);return d.innerHTML}
  function _fmt(sec){
    sec=Math.max(0,Math.floor(sec||0));
    var m=Math.floor(sec/60),s=sec%60,h=Math.floor(m/60);m=m%60;
    return (h?(h+':'+String(m).padStart(2,'0')):String(m))+':'+String(s).padStart(2,'0');
  }
  function _toast(m){try{if(typeof toast==='function')toast(m)}catch(e){}}

  /* ---- legacy 频道创建/复用：一对（roleId, kind, resourceKey）一条。
     M1 起 createActivity 不再调用它；仅保留给历史数据与显式建频道场景。 ---- */
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

  /* ---- Current 指针（每角色一个，轻量可重建；localStorage 不可用时内存兜底） ---- */
  var _memPtr={};
  function _ptrAll(){try{var raw=localStorage.getItem(CUR_KEY);if(!raw)return{};var v=JSON.parse(raw);return(v&&typeof v==='object')?v:{}}catch(e){return _memPtr}}
  function _ptrWrite(all){_memPtr=all;try{localStorage.setItem(CUR_KEY,JSON.stringify(all))}catch(e){}}
  function _ptrGet(roleId){var p=_ptrAll()[String(roleId)];return(p&&p.activityId)?p:null}
  function _ptrSet(roleId,activityId){var all=_ptrAll();all[String(roleId)]={activityId:String(activityId),at:_now()};_ptrWrite(all);return true}
  function _ptrClear(roleId){var all=_ptrAll();if(all[String(roleId)]){delete all[String(roleId)];_ptrWrite(all);return true}return false}
  function _usableFor(rec,roleId){return!!(rec&&String(rec.roleId)===String(roleId)&&rec.status!=='finished')}

  /* ---- P27-2 · activity.created Domain Event（**唯一**接线的事件）----------------
     边界：
       · 顺序：canonical 写入（dbPut）**成功之后**才创建事件；**禁止** event -> createActivity；
       · 失败语义：事件创建/投递失败 **不**回滚 canonical Activity（本函数**永不**抛错）；
       · 所有权：生产者是 IB.activity（不是 Event Core / Cinema / Co-read / Chat）；
       · 载荷：**只**带引用（entityId = activityId），**不带** Activity 正文 / 聊天历史 /
         记忆 / 媒体帧 / 字幕 / 凭证（P26-1 契约会拒绝这些字段）；
       · consumer：**无**（不建 Event Bus / Router / Listener）；只经**既有**本地回调通道广播，
         因此"事件可以存在而没有消费者"；
       · 契约：**复用** P26-1 createDomainEvent（不复制事件契约）；核心未加载时静默跳过。 */
  function _emitActivityCreated(rec){
    try{
      var core=(typeof window!=='undefined')?window.IBDomainEventCore:null;
      if(!core||typeof core.createDomainEvent!=='function'||!rec||!rec.id)return null;
      var res=core.createDomainEvent({
        domain:'activity',type:'created',entityId:String(rec.id),
        actorId:String(rec.roleId||''),origin:'runtime',timestamp:rec.createdAt
      });
      if(!res||res.ok!==true||!res.event)return null;
      _emit(rec.id,'created',res.event);
      return res.event;
    }catch(e){return null}
  }

  /* 创建/恢复活动：只写 `activities`，不创建 chatThreads、不切换任何聊天频道。 */
  async function createActivity(p){
    p=p||{};
    if(typeof dbPut!=='function')return null;
    if(!p.type||!p.roleId||!p.resourceId)return null;
    var id='act_'+_now()+'_'+Math.floor(Math.random()*1000);
    var rec={
      id:id,type:p.type,roleId:String(p.roleId),resourceId:String(p.resourceId),resourceKey:p.resourceKey||String(p.resourceId),
      title:p.title||'',kind:p.kind||p.type,threadId:null,
      progress:p.progress||{},bookmarks:p.bookmarks||[],recap:p.recap||'',config:p.config||{},
      status:'active',createdAt:_now(),updatedAt:_now(),lastActiveAt:_now()
    };
    try{await dbPut(ACT_STORE,rec)}catch(e){return null}
    _emit(rec.id,'activity',rec);
    _emitActivityCreated(rec);/* P27-2：canonical 写入成功后的**唯一**事件（失败不回滚） */
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
    if(rec){try{var _p=_ptrGet(rec.roleId);if(_p&&String(_p.activityId)===String(id))clearCurrent(rec.roleId)}catch(e){}}
    if(typeof dbDelete==='function'){try{await dbDelete(ACT_STORE,id)}catch(e){return false}}
    return true;
  }
  async function setProgress(id,prog){return await saveActivity(id,{progress:prog,lastActiveAt:_now()})}

  /* ---- P27-3 · Activity Observation（P26-2 接线 · **只读**）----------------------
     领域自有的 observation getter（**没有** ObservationManager / Registry / Store）：
       · 语义：对某个 Activity 的**当前 canonical 状态**做一次只读观察（"现在是什么"），
         与"发生了什么"（P27-2 的 activity.created）严格分离；
       · entityId = activityId；valueRef = 'activities/<activityId>'（**引用** canonical 位置；
         progress / page / subtitle 切片都从该位置按需读取，**不复制**状态正文）；
       · 观察**不写任何东西**：零 dbPut / 零 localStorage / 零回调副作用（纯读路径）；
       · 记录不存在 ⇒ availability 'unavailable'（仍是**合法观察**，不是业务失败）；
       · activityId 非法 / 核心缺失 / 契约拒绝 ⇒ 返回 null（不产生观察，**绝不抛错**）；
       · **不发事件**、不产生 Feedback、不唤醒 agent、不建 session / resource。 */
  async function getObservation(activityId,opts){
    try{
      var core=(typeof window!=='undefined')?window.IBObservationCore:null;
      if(!core||typeof core.createObservation!=='function')return null;
      var id=String(activityId==null?'':activityId);
      if(!id)return null;
      var o=(opts&&typeof opts==='object'&&!Array.isArray(opts))?opts:{};
      var observedAt=(typeof o.observedAt==='number'&&isFinite(o.observedAt)&&o.observedAt>0)?o.observedAt:_now();
      var rec=await getActivity(id);
      var res=core.createObservation({
        domain:'activity',entityId:id,source:'activity.state',
        observedAt:observedAt,freshness:'fresh',
        availability:(rec?'available':'unavailable'),
        valueRef:'activities/'+id
      });
      if(!res||res.ok!==true||!res.observation)return null;
      return res.observation;
    }catch(e){return null}
  }

  /* ---- Current 指针显式读写（App 打开活动时调用；UI 经事件总线订阅 'current'） ---- */
  /* ---- P27-4 · Activity Session Projection（P26-3 接线 · **只读投影**）------------
     语义：把一条 canonical Activity 记录**投影**成 P26-3 的 Session（"什么在持续"）。
       · owner = IB.activity；契约 = P26-3（复用 createSession 构造器 + validateSession 校验，
         **不**复制 session/v1、状态词表、参与者校验、身份规则）；
       · **纯读投影**：不创建 Session 持久化、不迁移（**不调用 transitionSession**）、
         不发事件、不产生 Observation / Feedback / Wake、不清理指针；
       · sessionId = activityId（**复用**，不新增持久身份、不做映射表）；
       · participants = [roleId]（**仅角色**：仓库里没有 canonical user participant id，
         唯一的"用户身份"只是显示名 _cachedUserName ⇒ **不发明** 'user'/'self'/'me'）；
       · status 映射：'active'→'active'，'finished'→'ended'（读侧承认的管理态；不新增 finish 命令）；
       · createdAt ← rec.createdAt；updatedAt ← rec.updatedAt（记录最近写入时刻，**非**生命周期迁移时刻，
         见报告 §9）；**endedAt 不提供**（Activity 无 finishedAt，P26-3 中 endedAt 为可选 ⇒ 不发明）；
       · **不需要 current 指针**（可由记录独立派生完整 Session；指针只是导航提示）；
       · 缺失 Activity / 无 roleId / 未知状态 / 契约校验失败 / 核心缺失 ⇒ 返回 null（**绝不抛错**）。 */
  async function getSession(activityId){
    try{
      var core=(typeof window!=='undefined')?window.IBSessionCore:null;
      if(!core||typeof core.createSession!=='function'||typeof core.validateSession!=='function')return null;
      var id=String(activityId==null?'':activityId);
      if(!id)return null;
      var rec=await getActivity(id);
      if(!rec)return null;                                  /* 缺失 ⇒ null（不造占位 Session） */
      var roleId=String(rec.roleId==null?'':rec.roleId);
      if(!roleId)return null;                               /* 无角色 ⇒ fail closed */
      var mapped=(rec.status==='active')?'active':((rec.status==='finished')?'ended':null);
      if(!mapped)return null;                               /* 未知状态 ⇒ fail closed */
      if(core.SESSION_STATUSES&&core.SESSION_STATUSES.indexOf(mapped)<0)return null;/* 词表以 P26-3 为准 */
      var base=core.createSession({sessionId:id,domain:'activity',participants:[roleId],createdAt:rec.createdAt},{createdAt:rec.createdAt});
      if(!base||base.ok!==true||!base.session)return null;  /* 复用构造器：身份 + 参与者规范化 + 校验 */
      var draft={
        sessionId:base.session.sessionId,
        domain:base.session.domain,
        participants:base.session.participants,             /* 已由 P26-3 深冻结并规范化 */
        status:mapped,
        createdAt:base.session.createdAt
      };
      var updatedAt=rec.updatedAt;
      if(typeof updatedAt==='number'&&isFinite(updatedAt)&&updatedAt>0)draft.updatedAt=updatedAt;
      var verdict=core.validateSession(draft);
      if(!verdict||verdict.ok!==true)return null;
      return Object.freeze(draft);
    }catch(e){return null}
  }
  async function setCurrent(activityId){
    var rec=await getActivity(activityId);
    if(!rec||rec.status==='finished')return null;
    var fid=String(rec.roleId);
    _ptrSet(fid,rec.id);
    _emit(fid,'current',{roleId:fid,activityId:rec.id});
    return rec;
  }
  /* M1.5：clearCurrent(roleId, activityId?) —— 第二参可选：仅当指针当前指向该活动时才清除，
     App 退出（Cinema unmount / Coread 返回书架）用它做"只清自己"，不影响其他 Activity。 */
  function clearCurrent(roleId,activityId){
    var fid=String(roleId||'');if(!fid)return false;
    if(activityId){var p=_ptrGet(fid);if(!p||String(p.activityId)!==String(activityId))return false}
    var had=_ptrClear(fid);
    _emit(fid,'current',{roleId:fid,activityId:null});
    return had;
  }

  /* 本轮活动解析（确定性优先级，每回合最多一个）：
       0. opts.activityId 显式（activity.send 携带）
       1. legacy 频道锚：旧活动 threadId 与当前会话线程一致（旧频道隔离优先，
          避免指针把别的活动上下文注入 legacy 频道）
       2. valid current pointer（角色匹配、未 finished，且**非 legacy**）
       3. status==='active' 且**非 legacy**（无 threadId）中 lastActiveAt 最新者
       4. 无 → null
     legacy 活动只在旧 thread 上下文中保持作用，不污染主对话/其他频道。 */
  async function resolveActivity(friendId,opts){
    opts=opts||{};
    var fid=String(friendId||'');if(!fid)return null;
    if(opts.activityId){var r0=await getActivity(opts.activityId);if(_usableFor(r0,fid))return r0}
    if(opts.threadId&&typeof dbGetAll==='function'){
      var all=await dbGetAll(ACT_STORE);
      var leg=all.find(function(a){return a&&String(a.roleId)===fid&&a.threadId&&a.threadId===opts.threadId&&a.status!=='finished'});
      if(leg)return leg;
    }
    var p=_ptrGet(fid);
    if(p){
      var rp=await getActivity(p.activityId);
      if(_usableFor(rp,fid)){if(!rp.threadId)return rp}/* legacy 指针不注入非旧频道上下文；指针本身保留 */
      else _ptrClear(fid);
    }
    if(typeof dbGetAll==='function'){
      var rows=(await dbGetAll(ACT_STORE)).filter(function(a){return a&&String(a.roleId)===fid&&a.status==='active'&&!a.threadId});
      rows.sort(function(a,b){return (b.lastActiveAt||b.updatedAt||0)-(a.lastActiveAt||a.updatedAt||0)});
      if(rows[0])return rows[0];
    }
    return null;
  }

  /* ---- 上下文注入（communication.js 钩子调用） ---- */
  function _chapterAt(off,text){
    var idx=text.lastIndexOf('\n#',off);if(idx<0)idx=0;
    var line=text.slice(idx+2,text.indexOf('\n',idx)).trim();
    return line||'';
  }
  async function buildActivityContext(rec,opts){
    opts=opts||{};
    if(!rec)return'';
    /* P11-3X-C · 两个切片上限仍是生产习惯值（2000 / 600），只有宿主回合的输入
       预算要求收紧时才使用调用方给的更小值（只缩不放：cap 越小，两段都跟着缩）。 */
    var _cap=Number(opts.maxChars);
    var pageCap=2000,recapCap=600;
    if(isFinite(_cap)&&_cap>0&&_cap<2600){pageCap=Math.max(200,Math.min(2000,Math.round(_cap*0.77)));recapCap=Math.max(60,Math.min(600,Math.round(_cap*0.23)))}
    var type=rec.type,lines=[];
    lines.push('———— 以下是系统随消息附上的陪伴活动状态，不是对方说的话 ————');
    if(type==='coread'){
      var prog=rec.progress||{},cur=(prog.page||1),total=(prog.total||1);
      var chapter=prog.chapter||'';
      lines.push('【共读】你们正在一起读《'+(rec.title||'')+'》· 第 '+(cur>total?total:cur)+' / '+total+' 页 · 进度 '+Math.round((prog.pct||0))+'%'+(chapter?(' · '+chapter):''));
      if(prog.pageText){lines.push('［对方此刻读到的这一页］\n'+String(prog.pageText).slice(0,pageCap))}
      if(prog.recap){lines.push('［前文梗概］\n'+String(prog.recap).slice(0,recapCap))}
      lines.push('［说明］以上就是这一轮 TA 读到的全部，后面的页你还没读到，不猜测、不预告，围绕当前页谈。');
    }else if(type==='cinema'){
      var prog2=rec.progress||{},sec=prog2.sec||0;
      if(prog2.noTime){lines.push('【观影室】你们正在一起看《'+(rec.title||'')+'》（此嵌入播放器不提供播放进度）')}
      else{lines.push('【观影室】你们正在一起看《'+(rec.title||'')+'》· 进度 '+_fmt(sec)+(prog2.dur?(' / '+_fmt(prog2.dur)):''))}
      if(prog2.subs&&prog2.subs.length){lines.push('［播放点之前最近的字幕］\n'+prog2.subs.slice(0,6).map(function(c){return'['+_fmt(c[0])+'] '+String(c[2]).replace(/\n/g,' ')}).join('\n'))}
      if(prog2.recap){lines.push('［前情梗概（到 '+_fmt(prog2.upTo||0)+'）］\n'+String(prog2.recap).slice(0,recapCap))}
      lines.push('［说明］以上是这一轮你知道的全部：只到播放点为止，后面的剧情你不知道，不预告、不猜。');
    }
    lines.push('［系统留白］若你觉得现在不适合继续，可以自然停顿，不必硬聊。');
    return '\n'+lines.join('\n');
  }
  /* communication.js 钩子：给定好友 + 可选显式 activityId/threadId，返回活动上下文（无则空串）。
     - `opts.activity` 显式存在时视为"本轮已解析结果"（null = 本轮确认无活动），
       由 sendChatMessage 每轮解析一次后传入，避免同一回合重复读表。 */
  async function getActivityContext(friendId,opts){
    opts=opts||{};
    var rec=Object.prototype.hasOwnProperty.call(opts,'activity')?(opts.activity||null):await resolveActivity(friendId,opts);
    if(!rec)return'';
    return await buildActivityContext(rec,opts);
  }

  /* ---- 发送：把用户文字投入活动所在会话 ----
     新活动：跟随用户当前正常 Chat Thread（绝不新建/切换隐藏频道），并置为 current；
     legacy 活动（threadId 指向仍然存在的旧频道）：消息继续落在旧频道，保持隔离；
     两者都在 sendChatMessage 上携带 activityId；`extra.visionReference` 原样透传
     （Cinema 留影帧，request-local，本层不存储）。 */
  async function send(activityId,text,extra){
    extra=extra||{};
    var rec=await getActivity(activityId);
    if(!rec)return{ok:false,error:'no_activity'};
    if(rec.status==='finished')return{ok:false,error:'activity_finished'};/* 显式目标不可用 → 明确拒绝，不 fallback 到其他 activity */
    if(extra.progress)await setProgress(activityId,extra.progress);
    if(typeof sendChatMessage!=='function')return{ok:false,error:'no_chat'};
    activeFriendId=rec.roleId;
    var thr=null;
    if(rec.threadId&&typeof dbGet==='function'){try{thr=await dbGet('chatThreads',rec.threadId)}catch(e){}}
    if(thr){
      activeThreadId=rec.threadId;
    }else{
      /* 当前频道必须属于本角色，否则回到主对话（不携带跨角色 threadId） */
      if(activeThreadId){try{var cur=await dbGet('chatThreads',activeThreadId);if(!cur||String(cur.friendId)!==String(rec.roleId))activeThreadId=null}catch(e){activeThreadId=null}}
      try{await setCurrent(activityId)}catch(e){}
    }
    /* sendChatMessage 从 Chat 输入框读取文本；活动输入框是独立容器，需把文字注入再调用，
       事后恢复原值，避免污染主聊天草稿。 */
    var inp=null;
    try{var mini=document.getElementById('chat-input');var full=document.getElementById('chat-full-input');inp=(typeof currentPage!=='undefined'&&currentPage==='chat'&&full)?full:(mini||full)}catch(e){}
    if(!inp)return{ok:false,error:'no_input'};
    var prev=inp.value;inp.value=String(text||'');
    var opts={activityId:rec.id};
    if(extra.visionReference)opts.visionReference=extra.visionReference;
    try{await sendChatMessage.call(window,opts)}catch(e){return{ok:false,error:String(e&&e.message||e)}}
    finally{inp.value=prev}
    return{ok:true};
  }
  /* 把活动带到前台 Chat：legacy 频道 → 旧频道；新活动 → 主对话 + 置为 current */
  function openChat(activityId){(async function(){var r=await getActivity(activityId);if(!r)return;activeFriendId=r.roleId;var thr=null;if(r.threadId&&typeof dbGet==='function'){try{thr=await dbGet('chatThreads',r.threadId)}catch(e){}}
    if(thr){activeThreadId=r.threadId;if(typeof selectThread==='function')selectThread(r.roleId,r.threadId)}
    else{activeThreadId=null;try{await setCurrent(r.id)}catch(e){}if(typeof selectFriend==='function')selectFriend(r.roleId)}
    if(typeof navTo==='function')navTo('chat')})();}

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
      timestamp:_now(),mark:{app:'activity',kind:rec.type,phase:phase||'mark',label:String(label||'').slice(0,140)}};
    if(rec.threadId)msg.threadId=rec.threadId;else msg.metadata={activityId:rec.id};
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
      title:activity.title||'',body:note||'陪伴活动',meta:{kind:activity.type,threadId:activity.threadId||''}});
  }

  /* ---- 注册：window + IB.activity ---- */
  var api={createActivity:createActivity,getActivity:getActivity,findActivity:findActivity,listActivities:listActivities,
    saveActivity:saveActivity,deleteActivity:deleteActivity,setProgress:setProgress,getObservation:getObservation,
    getSession:getSession,
    setCurrent:setCurrent,clearCurrent:clearCurrent,resolveActivity:resolveActivity,
    buildActivityContext:buildActivityContext,getActivityContext:getActivityContext,
    send:send,openChat:openChat,writeMemory:writeMemory,nudge:nudge,mark:mark,fav:fav,
    on:function(id,ev,fn){_on(id,ev,fn)},off:function(id,ev,fn){_off(id,ev,fn)},emit:function(){}};
  NS.activity=api;
  window.IBActivity=api;
  window.getActivityContext=getActivityContext;
  window._activityCreate=createActivity;
})(window.IB || (window.IB = {}));
