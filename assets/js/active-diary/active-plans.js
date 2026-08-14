/* AI 主动计划域 — active-diary.js 机械提取；IIFE 私有作用域 + window 双挂载。 */
(function(NS){
/* ══════════ AI-PLANNED PROACTIVE MESSAGES ══════════
   AI 自主规划：每次正常聊天完成后，由角色模型决定是否/何时/为何再次主动联系。
   程序负责调度、频率限制、免打扰、取消、去重与持久化；模型只产出结构化计划与到期内容。
   本模块 fail-open：任何失败只影响 AI 规划本身，绝不影响普通聊天。 */
const ACTIVE_PLANS_STORE='active_message_plans';
const ACTIVE_AI_PREFS_KEY='ib_active_ai_prefs_v1';
const ACTIVE_PLAN_MIN_DELAY_MS=5*60*1000;              /* 程序端绝对下限：5 分钟 */
const ACTIVE_PLAN_MAX_DELAY_MS=7*24*60*60*1000;        /* 程序端绝对上限：7 天 */
const ACTIVE_PLAN_MAX_LATE_MS=30*60*1000;              /* 错过触发时间的容忍上限：30 分钟 */
const ACTIVE_PLAN_MAX_ATTEMPTS=2;                      /* 单计划最大执行尝试次数（发送失败重试） */
const ACTIVE_PLAN_DEFAULT_DND_START='23:00';
const ACTIVE_PLAN_DEFAULT_DND_END='08:00';
function _activeAiPrefs(){
  const d={enabled:true,mode:'ai',minIntervalMinutes:30,maxPlanHours:168,maxConsecutive:1,dndStart:ACTIVE_PLAN_DEFAULT_DND_START,dndEnd:ACTIVE_PLAN_DEFAULT_DND_END,cancelIfUserReplies:true,allowReschedule:true,showDebug:false};
  try{
    const raw=JSON.parse(localStorage.getItem(ACTIVE_AI_PREFS_KEY)||'null');
    if(!raw||typeof raw!=='object')return d;
    return{
      enabled:raw.enabled!==false,
      mode:['fixed','ai','hybrid'].includes(raw.mode)?raw.mode:'ai',
      minIntervalMinutes:Math.max(5,Math.min(1440,parseInt(raw.minIntervalMinutes,10)||30)),
      maxPlanHours:Math.max(1,Math.min(720,parseInt(raw.maxPlanHours,10)||168)),
      maxConsecutive:Math.max(1,Math.min(5,parseInt(raw.maxConsecutive,10)||1)),
      dndStart:String(raw.dndStart||ACTIVE_PLAN_DEFAULT_DND_START).slice(0,5),
      dndEnd:String(raw.dndEnd||ACTIVE_PLAN_DEFAULT_DND_END).slice(0,5),
      cancelIfUserReplies:raw.cancelIfUserReplies!==false,
      allowReschedule:raw.allowReschedule!==false,
      showDebug:!!raw.showDebug
    }
  }catch(e){return d}
}
function _activeAiPrefsSave(p){
  try{localStorage.setItem(ACTIVE_AI_PREFS_KEY,JSON.stringify(p))}catch(e){}
}
function _activePlanDefaults(partial,prefs){
  const p=partial&&typeof partial==='object'?partial:{};
  const cc=p.cancelConditions&&typeof p.cancelConditions==='object'?p.cancelConditions:{};
  const cs=p.constraints&&typeof p.constraints==='object'?p.constraints:{};
  const prefsC=prefs||_activeAiPrefs();
  return{
    id:String(p.id||('proactive_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8))),
    characterId:String(p.characterId||''),
    type:p.type==='hard_reminder'?'hard_reminder':'proactive_chat',
    status:['scheduled','evaluating','sending','waiting_for_user','completed','cancelled','expired','failed'].includes(p.status)?p.status:'scheduled',
    source:p.source==='user_reminder'?'user_reminder':'ai_planned',
    createdAt:p.createdAt||new Date().toISOString(),
    updatedAt:p.updatedAt||new Date().toISOString(),
    scheduledAt:String(p.scheduledAt||''),
    intent:String(p.intent||'').slice(0,200),
    reason:String(p.reason||'').slice(0,300),
    cancelConditions:{
      cancelIfUserReplies:cc.cancelIfUserReplies!=null?!!cc.cancelIfUserReplies:prefsC.cancelIfUserReplies,
      cancelIfIntentResolved:!!cc.cancelIfIntentResolved,
      cancelIfNewerPlanExists:cc.cancelIfNewerPlanExists!==false,
      respectDoNotDisturb:cc.respectDoNotDisturb!==false
    },
    constraints:{
      maxAttempts:Math.max(1,Math.min(5,parseInt(cs.maxAttempts,10)||ACTIVE_PLAN_MAX_ATTEMPTS)),
      allowReschedule:cs.allowReschedule!=null?!!cs.allowReschedule:prefsC.allowReschedule,
      allowFollowUpPlan:!!cs.allowFollowUpPlan
    },
    attemptCount:Math.max(0,parseInt(p.attemptCount,10)||0),
    executionId:p.executionId||null,
    claimedAt:p.claimedAt||null,
    sourceConversationId:String(p.sourceConversationId||''),
    sourceMessageId:String(p.sourceMessageId||''),
    lastError:p.lastError||null,
    executedAt:p.executedAt||null,
    cancelledAt:p.cancelledAt||null,
    cancelReason:p.cancelReason||null,
    user_id:String(p.user_id||_activeUserId())
  }
}
/* 解析模型输出中的严格 JSON（兼容 ```json 围栏与前后杂文），失败返回 null */
function _activeParsePlanJson(text){
  let s=String(text||'').trim();
  if(!s)return null;
  const fence=s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fence&&fence[1]&&fence[1].trim())s=fence[1].trim();
  const start=s.indexOf('{'),end=s.lastIndexOf('}');
  if(start<0||end<=start)return null;
  try{return JSON.parse(s.slice(start,end+1))}catch(e){return null}
}
/* 白名单校验 + 安全裁剪。返回规范化计划结果，非法输入返回 null（调用方放弃创建，不影响聊天）。 */
function _activeValidatePlanResult(raw,now,prefs){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const action=String(raw.action||'').trim();
  if(!['schedule','none','cancel_existing'].includes(action))return null;
  const out={action:action,reason:String(raw.reason||'').slice(0,300)};
  if(action!=='schedule')return out;
  const t=Date.parse(raw.scheduledAt);
  if(!Number.isFinite(t))return null;
  const nowMs=Number(now)||Date.now();
  const minMs=Math.max(ACTIVE_PLAN_MIN_DELAY_MS,(prefs&&prefs.minIntervalMinutes||30)*60*1000);
  const maxMs=Math.min(ACTIVE_PLAN_MAX_DELAY_MS,(prefs&&prefs.maxPlanHours||168)*3600*1000);
  let delay=t-nowMs;
  if(delay<minMs)return null;                      /* 早于最短延迟 → 拒绝，不裁剪 */
  if(delay>maxMs)delay=maxMs;                      /* 超过最大期限 → 裁剪到上限 */
  out.scheduledAt=new Date(nowMs+delay).toISOString();
  out.intent=String(raw.intent||'').slice(0,200);
  const cc=raw.cancelConditions&&typeof raw.cancelConditions==='object'?raw.cancelConditions:{};
  const pick=(top,inner,fallback)=>top!=null?!!top:(inner!=null?!!inner:!!fallback);
  out.cancelIfUserReplies=pick(raw.cancelIfUserReplies,cc.cancelIfUserReplies,prefs?prefs.cancelIfUserReplies!==false:true);
  out.cancelIfIntentResolved=pick(raw.cancelIfIntentResolved,cc.cancelIfIntentResolved,false);
  out.cancelIfNewerPlanExists=pick(raw.cancelIfNewerPlanExists,cc.cancelIfNewerPlanExists,true);
  out.respectDoNotDisturb=pick(raw.respectDoNotDisturb,cc.respectDoNotDisturb,true);
  out.allowReschedule=pick(raw.allowReschedule,cc.allowReschedule,prefs?prefs.allowReschedule!==false:true);
  out.allowFollowUpPlan=pick(raw.allowFollowUpPlan,cc.allowFollowUpPlan,false);
  return out
}
/* 免打扰判断：返回 true 表示当前处于免打扰时段 */
function _activeIsInDnd(nowMs,prefs){
  const p=prefs||_activeAiPrefs();
  const d=new Date(nowMs||Date.now());
  const hm=d.getHours()*60+d.getMinutes();
  const toMin=t=>{const a=String(t||'23:00').split(':');return(Math.max(0,Math.min(23,parseInt(a[0],10)||0))*60+Math.max(0,Math.min(59,parseInt(a[1],10)||0)))};
  const s=toMin(p.dndStart),e=toMin(p.dndEnd);
  if(s===e)return false;                            /* 起止相同视为不启用 */
  return s<e?hm>=s&&hm<e:hm>=s||hm<e               /* 跨天时段 */
}
/* 返回下一个不在免打扰时段的时刻（ms）；now 已在时段外时返回 now */
function _activeNextDndFree(nowMs,prefs){
  const p=prefs||_activeAiPrefs();
  const now=new Date(nowMs||Date.now());
  let probe=now.getTime();
  for(let i=0;i<96;i++){                            /* 最多向后找 24 小时 */
    if(!_activeIsInDnd(probe,p))return probe;
    probe+=15*60*1000;
  }
  return nowMs+12*60*60*1000
}
function _activePlanLog(step,detail){
  try{if(_activeAiPrefs().showDebug)console.info('[ProactivePlan] '+step,detail||'')}catch(e){}
}
function _activePlanStatusLabel(s){return({scheduled:'已安排',evaluating:'评估中',sending:'发送中',waiting_for_user:'等待回复',completed:'已完成',cancelled:'已取消',expired:'已过期',failed:'失败'})[s]||s}
function _activePlanSourceLabel(s){return s==='user_reminder'?'用户提醒':'AI 规划'}

/* 规划 Prompt：模型只输出结构化 JSON 计划，禁止输出脚本/Cron/内部函数名 */
function buildPlanPrompt(args){
  const character=args.character||{},user=args.user||{},prefs=args.prefs||_activeAiPrefs();
  const characterName=character.nickname||character.model||'AI',userName=user.name||'用户';
  const memories=(args.memories||[]).slice(0,8),recent=(args.recentMessages||[]).slice(-16),proactive=(args.recentProactiveMessages||[]).slice(-10);
  const memoryText=memories.length?memories.map(m=>'- '+(m.title?m.title+'：':'')+(m.content||m.summary)).join('\n'):'（没有可用的相关长期记忆）';
  const chatText=recent.length?recent.map(m=>'- '+(m.role==='user'?userName:characterName)+'：'+String(m.content||'').slice(0,700)).join('\n'):'（还没有最近聊天）';
  const proactiveText=proactive.length?proactive.map((m,i)=>(i+1)+'. '+String(m.content||m).slice(0,650)).join('\n'):'（还没有发送过主动消息）';
  const now=args.currentTime instanceof Date?args.currentTime:new Date(args.currentTime||Date.now());
  const tz=Intl.DateTimeFormat().resolvedOptions().timeZone||'local';
  const activePlans=(args.activePlans||[]).filter(p=>p&&p.status==='scheduled');
  const plansText=activePlans.length?activePlans.map((p,i)=>(i+1)+'. 时间：'+p.scheduledAt+'；意图：'+(p.intent||'未说明')).join('\n'):'（当前没有其他待执行的主动计划）';
  const system=String(character.systemPrompt||'').slice(0,30000)
    +'\n\n你是「'+characterName+'」，正在协助判断是否应该主动联系'+userName+'。你只输出 JSON，不输出任何其他文字。';
  const prompt=[
    '【任务】判断是否值得在之后主动联系对方，并输出严格 JSON。',
    '【当前日期和时间】'+now.toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'})+'（时区 '+tz+'）',
    '【角色姓名】'+characterName,
    '【角色设定摘要】'+(character.systemPrompt||'（无）').slice(0,600),
    '【角色与用户的关系】'+(character.relationship||'尚未单独设定，请依据既有对话自然判断'),
    '【最近聊天摘要】'+String(args.chatSummary||'（暂无摘要）').slice(0,1200),
    '【最近聊天内容】'+chatText,
    '【用户刚发送的消息】'+String(args.userMessage&&(args.userMessage.content||'')||'').slice(0,700),
    '【角色刚生成的回复】'+String(args.assistantMessage&&(args.assistantMessage.content||'')||'').slice(0,1200),
    '【相关长期记忆】'+memoryText,
    '【最近已经发送过的主动消息】'+proactiveText,
    '【当前仍有效的主动计划】'+plansText,
    '【用户是否开启主动消息】'+(prefs.enabled?'已开启':'已关闭'),
    '【用户主动消息频率偏好】最短间隔 '+prefs.minIntervalMinutes+' 分钟；最长规划 '+prefs.maxPlanHours+' 小时；用户未回复时最多连续主动 '+prefs.maxConsecutive+' 条',
    '【免打扰时间】'+prefs.dndStart+' 至 '+prefs.dndEnd,
    '【允许的最短延迟】'+Math.max(ACTIVE_PLAN_MIN_DELAY_MS/60000,prefs.minIntervalMinutes)+' 分钟',
    '【允许的最大延迟】'+Math.min(ACTIVE_PLAN_MAX_DELAY_MS/3600000,prefs.maxPlanHours)+' 小时',
    '【输出格式】只输出一个 JSON 对象，禁止 Markdown 围栏之外的任何文字，禁止脚本、Cron 表达式或内部函数名。',
    '可选 action 与字段：',
    '1. {"action":"schedule","scheduledAt":"ISO8601 带时区时间","intent":"下次联系的目的（≤80字）","reason":"依据（≤100字）","cancelIfUserReplies":true,"cancelIfIntentResolved":false,"allowReschedule":true,"allowFollowUpPlan":false}',
    '2. {"action":"none","reason":"当前没有自然的后续联系理由"}',
    '3. {"action":"cancel_existing","reason":"用户明确表示不希望继续提醒"}',
    '【规划规则】',
    '1. 不要为了展示主动功能而强行安排任务；没有自然理由时必须返回 action:"none"。',
    '2. 普通寒暄结束通常不需要立刻主动联系。',
    '3. 用户明确说“稍后、过一会、明天、到时候提醒我”时，可以安排。',
    '4. 用户说“我要睡了”时，不应安排短时间内的打扰。',
    '5. 用户说“不用了、别提醒、不要主动找我”时，应返回 action:"cancel_existing"。',
    '6. 不得利用负罪感、依赖感或情绪绑架迫使用户回复。',
    '7. 不得连续发送多条主动消息。',
    '8. 不得假装模型在后台一直有意识地等待，不得声称看见用户现实中的行为。',
    '9. scheduledAt 必须结合上述“当前日期和时间”计算，必须是带时区的 ISO 8601，禁止输出“过一会”等模糊时间。',
    '10. scheduledAt 不得早于允许的最短延迟，不得晚于允许的最大延迟。',
    '11. 用户说“我要睡了”等不适合打扰的时段，应把时间安排到合适的时段。',
    '12. allowFollowUpPlan 默认 false：除非用户明确要求持续陪伴，否则不允许本次发送后再自动规划下一条。',
    '13. 已存在“当前仍有效的主动计划”时，若新计划更有价值才返回 schedule（程序会自动替换旧计划），否则返回 none。'
  ];
  return{system:system,messages:[{role:'system',content:system},{role:'user',content:prompt.join('\n')}],prompt:prompt.join('\n')}
}
/* 保存/替换 AI 计划：同角色旧的 scheduled AI 计划被新计划替换；不动 hard_reminder 与其他角色任务 */
async function _activeSaveAiPlan(plan){
  if(!plan||!plan.id||!plan.characterId)return null;
  const prefs=_activeAiPrefs();
  const normalized=_activePlanDefaults(plan,prefs);
  try{
    const all=await dbGetAll(ACTIVE_PLANS_STORE);
    const sameCharacter=all.filter(p=>p&&p.characterId===normalized.characterId);
    for(const old of sameCharacter){
      if(old.id===normalized.id)continue;
      if(old.source==='user_reminder')continue;                    /* 用户手动提醒绝不替换 */
      if(old.status==='scheduled'){                                 /* 替换旧的 AI 规划任务 */
        old.status='cancelled';old.cancelledAt=new Date().toISOString();old.cancelReason='被更新的 AI 计划替换';old.updatedAt=old.cancelledAt;
        _activePlanLog('previous plan cancelled',{planId:old.id,reason:old.cancelReason});
        await dbPut(ACTIVE_PLANS_STORE,old);
        if(_activeCompanionOnline)_activeSyncAiPlan(old).catch(()=>{})
      }
      if(old.status==='waiting_for_user'){                          /* 等待回复中的旧计划：仅当新计划来源同一对话意图时保留 */
        /* 默认保守：新计划存在时取消等待中的旧计划，避免重复打扰 */
        old.status='cancelled';old.cancelledAt=new Date().toISOString();old.cancelReason='被更新的 AI 计划替换';old.updatedAt=old.cancelledAt;
        await dbPut(ACTIVE_PLANS_STORE,old);
        if(_activeCompanionOnline)_activeSyncAiPlan(old).catch(()=>{})
      }
    }
    await dbPut(ACTIVE_PLANS_STORE,normalized);
    _activePlanLog('task scheduled',{planId:normalized.id,characterId:normalized.characterId,scheduledAt:normalized.scheduledAt,intent:normalized.intent});
    if(_activeCompanionOnline)_activeSyncAiPlan(normalized).catch(()=>{})
    if(currentPage==='active')_activeRenderAiPlans();
    return normalized
  }catch(e){_activePlanLog('save failed',{error:String(e&&e.message||e).slice(0,200)});return null}
}
/* 取消某角色全部 AI 规划任务（保留 user_reminder） */
async function _activeCancelAiPlans(characterId,reason){
  if(!characterId)return;
  try{
    const all=await dbGetAll(ACTIVE_PLANS_STORE);
    for(const p of all){
      if(p.characterId!==characterId||p.source==='user_reminder')continue;
      if(p.status==='scheduled'||p.status==='waiting_for_user'){
        p.status='cancelled';p.cancelledAt=new Date().toISOString();p.cancelReason=reason||'用户关闭了 AI 主动联系';p.updatedAt=p.cancelledAt;
        await dbPut(ACTIVE_PLANS_STORE,p);
        if(_activeCompanionOnline)_activeSyncAiPlan(p).catch(()=>{})
      }
    }
    if(currentPage==='active')_activeRenderAiPlans();
  }catch(e){}
}
/* 聊天完成后规划下一次主动联系（fail-open：任何失败都不影响聊天）。由 setTimeout 异步调用。 */
async function planNextProactiveMessage(args){
  try{
    const prefs=_activeAiPrefs();
    if(!prefs.enabled||prefs.mode==='fixed')return null;           /* 功能关闭或固定计划模式 */
    const character=args.character||{};
    if(!character.id||!_ibApiReady(character))return null;
    if((args.conversation||'').toString().startsWith('group_'))return null;   /* 群聊不规划 */
    if(!args.userMessageId&&!args.assistantMessageId)return null;
    _activePlanLog('planning started',{characterId:character.id,conversation:args.conversation||''});
    const contextText=(args.userMessage&&String(args.userMessage.content||'')||'')+(args.assistantMessage&&String(args.assistantMessage.content||'')||'');
    const [memories,recentProactive,about,summaryItem,activePlans]=await Promise.all([
      _activeRecentMemories(character.id,contextText.slice(0,2000)),
      _activeRecentProactiveMessages(character.id),
      dbGet('about','main').catch(()=>null),
      dbGet('chatSummaries','sum_'+character.id).catch(()=>null),
      dbGetAll(ACTIVE_PLANS_STORE).catch(()=>[])
    ]);
    const userName=(about&&about.name)||_cachedUserName||'用户';
    const recent=await _activeRecentMessages(character.id);
    const now=new Date();
    const built=buildPlanPrompt({
      character:character,user:{name:userName},prefs:prefs,memories:memories,
      recentMessages:recent,recentProactiveMessages:recentProactive,currentTime:now,
      chatSummary:String(summaryItem&&summaryItem.summary||'').slice(0,1200),
      userMessage:args.userMessage,assistantMessage:args.assistantMessage,
      activePlans:activePlans.filter(p=>p.characterId===character.id&&p.status==='scheduled')
    });
    let raw='';
    try{
      raw=await callApiChat(character,built.messages,{maxTokens:600,timeoutMs:90000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true});
    }catch(e){
      _activePlanLog('model request failed',{characterId:character.id,error:String(e&&e.message||e).slice(0,200)});
      return null                                                    /* 模型请求失败：不影响聊天 */
    }
    _activePlanLog('model result',{characterId:character.id,raw:String(raw||'').slice(0,400)});
    const parsed=_activeParsePlanJson(raw);
    if(!parsed){_activePlanLog('validation failed',{characterId:character.id,reason:'invalid json'});return null}
    const validated=_activeValidatePlanResult(parsed,Date.now(),prefs);
    if(!validated){_activePlanLog('validation failed',{characterId:character.id,reason:'whitelist rejection',raw:parsed});return null}
    _activePlanLog('validation passed',{characterId:character.id,action:validated.action});
    if(validated.action==='none'){
      _activePlanLog('no plan needed',{characterId:character.id,reason:validated.reason});
      return null
    }
    if(validated.action==='cancel_existing'){
      await _activeCancelAiPlans(character.id,'用户表示不需要继续提醒');
      return null
    }
    const plan=_activePlanDefaults({
      characterId:character.id,
      status:'scheduled',
      scheduledAt:validated.scheduledAt,
      intent:validated.intent||'',
      reason:validated.reason||'',
      cancelConditions:{cancelIfUserReplies:validated.cancelIfUserReplies,cancelIfIntentResolved:validated.cancelIfIntentResolved,cancelIfNewerPlanExists:validated.cancelIfNewerPlanExists,respectDoNotDisturb:validated.respectDoNotDisturb},
      constraints:{allowReschedule:validated.allowReschedule,allowFollowUpPlan:validated.allowFollowUpPlan},
      sourceConversationId:String(args.conversation||''),
      sourceMessageId:String(args.userMessageId||''),
      user_id:_activeUserId()
    },prefs);
    return await _activeSaveAiPlan(plan)
  }catch(e){_activePlanLog('planning failed',{error:String(e&&e.message||e).slice(0,300)});return null}
}
/* 聊天回复完成后的入口：从库中取最新一轮消息，异步规划（fire-and-forget，绝不阻塞聊天） */
function _activeMaybePlanNext(opts){
  try{
    const prefs=_activeAiPrefs();
    if(!prefs.enabled||prefs.mode==='fixed')return;
    const friendId=opts&&opts.friendId;
    if(!friendId||String(friendId).startsWith('group_'))return;
    setTimeout(async()=>{
      try{
        const cfg=apiConfigs.find(a=>a.id===friendId);
        if(!_ibApiReady(cfg))return;
        let msgs=[];try{msgs=await dbGetByIndex('chatMessages','byFriend',friendId)}catch(e){}
        msgs=msgs.filter(m=>!m.threadId).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
        let userMsg=null,assistantMsg=null;
        for(let i=msgs.length-1;i>=0;i--){
          const m=msgs[i];
          if(m.role==='user'&&!m.source&&!userMsg)userMsg=m;
          if(m.role==='assistant'&&!userMsg)continue;
          if(m.role==='assistant'&&userMsg&&!assistantMsg&&m.timestamp>=userMsg.timestamp)assistantMsg=m;
          if(userMsg&&assistantMsg)break
        }
        if(!userMsg||!assistantMsg)return;
        await planNextProactiveMessage({character:cfg,conversation:friendId,userMessage:userMsg,assistantMessage:assistantMsg,userMessageId:userMsg.id,assistantMessageId:assistantMsg.id})
      }catch(e){_activePlanLog('maybe-plan failed',{error:String(e&&e.message||e).slice(0,200)})}
    },600)                                                           /* 延后 600ms，确保回复已完整落库 */
  }catch(e){}
}
/* 用户主动发言后：取消等待/安排中的 AI 计划（尊重 cancelIfUserReplies 与用户设置） */
async function _activeUserReplied(message){
  try{
    if(!message||!message.friendId)return;
    const prefs=_activeAiPrefs();
    const all=await dbGetAll(ACTIVE_PLANS_STORE);
    for(const p of all){
      if(p.characterId!==message.friendId||p.source==='user_reminder')continue;
      const cancelIt=p.status==='waiting_for_user'||(p.status==='scheduled'&&p.cancelConditions&&p.cancelConditions.cancelIfUserReplies);
      if(!cancelIt)continue;
      p.status='cancelled';p.cancelledAt=new Date().toISOString();p.cancelReason='用户已回复，旧计划取消';p.updatedAt=p.cancelledAt;
      await dbPut(ACTIVE_PLANS_STORE,p);
      if(_activeCompanionOnline)_activeSyncAiPlan(p).catch(()=>{})
    }
    if(currentPage==='active')_activeRenderAiPlans();
  }catch(e){}
}

/* 到期二次评估：先程序预检（免打扰/用户回复/开关/角色/API/频率/未读），再由模型决定 send/reschedule/cancel */
async function evaluateProactiveTask(task,latestContext){
  const now=Date.now(),prefs=_activeAiPrefs();
  const result={action:'cancel',reason:''};
  const latest=(latestContext&&latestContext.recentMessages)||[];
  const planCreatedAt=Date.parse(task&&task.createdAt)||0;
  const userRepliedSince=latest.some(m=>m.role==='user'&&!m.source&&Number(m.timestamp)>planCreatedAt);
  /* 程序端硬规则（不依赖模型） */
  if(!task||!task.characterId)return{action:'cancel',reason:'任务数据缺失'};
  if(task.status!=='scheduled'&&task.status!=='evaluating')return{action:'cancel',reason:'任务已不在可执行状态'};
  if(task.cancelledAt)return{action:'cancel',reason:'任务已被取消'};
  if(!prefs.enabled)return{action:'cancel',reason:'用户已关闭主动消息'};
  const cfg=apiConfigs.find(a=>a.id===task.characterId);
  if(!cfg||cfg.archived)return{action:'cancel',reason:'角色已被删除或归档'};
  if(!_ibApiReady(cfg))return{action:'failed',reason:'角色 API 配置不完整'};
  if(task.cancelConditions&&task.cancelConditions.cancelIfUserReplies&&userRepliedSince)return{action:'cancel',reason:'用户已在计划创建后回复'};
  if(task.attemptCount>=Math.max(1,(task.constraints&&task.constraints.maxAttempts)||ACTIVE_PLAN_MAX_ATTEMPTS))return{action:'cancel',reason:'达到最大尝试次数'};
  /* 最近已发送主动消息且用户未回复 → 不再发送（连续主动限制） */
  const recentProactive=await _activeRecentProactiveMessages(task.characterId);
  const lastProactive=recentProactive.length?recentProactive[recentProactive.length-1]:null;
  if(lastProactive){
    const lastUserMsg=latest.filter(m=>m.role==='user'&&!m.source).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0))[0];
    const userRepliedAfter=(lastUserMsg&&lastUserMsg.timestamp||0)>(lastProactive.timestamp||0);
    if(!userRepliedAfter)return{action:'cancel',reason:'用户尚未回复上一条主动消息（连续主动限制）'}
  }
  /* 免打扰 → 延后（程序直接处理，不消耗模型调用） */
  if(task.cancelConditions&&task.cancelConditions.respectDoNotDisturb&&_activeIsInDnd(now,prefs)){
    const freeAt=_activeNextDndFree(now,prefs);
    return{action:'reschedule',scheduledAt:new Date(freeAt).toISOString(),reason:'当前处于免打扰时间'}
  }
  /* 模型二次评估：send / reschedule / cancel */
  if(cfg){
    try{
      const built=buildPlanPrompt(Object.assign({},latestContext||{},{
        character:cfg,prefs:prefs,currentTime:new Date(now),
        userMessage:null,assistantMessage:null,
        activePlans:[],
        chatSummary:(latestContext&&latestContext.chatSummary)||''
      }));
      const evalPrompt=[].concat(built.messages[1].content,['','【本次任务】到期评估。',
        '任务意图：'+(task.intent||'未说明'),
        '任务创建原因：'+(task.reason||'未说明'),
        '任务创建时间：'+(task.createdAt||''),
        '计划发送时间：'+(task.scheduledAt||''),
        '现在时间：'+new Date(now).toLocaleString('zh-CN'),
        '用户是否已在计划创建后回复过：'+(userRepliedSince?'是（此时应优先 cancel）':'否'),
        '【输出格式】只输出 JSON：{"action":"send"} 或 {"action":"reschedule","scheduledAt":"ISO8601","reason":"..."} 或 {"action":"cancel","reason":"..."}',
        '【评估规则】1. 原意图已完成或用户已说明不需要 → cancel。2. 用户已回复且任务仍有意 → 默认 cancel。3. 免打扰程序已处理。4. 没有把握时倾向 cancel，不要为了发送而发送。5. 不得安排超过 '+(prefs.maxPlanHours||168)+' 小时后的时间。']).join('\n');
      const raw=await callApiChat(cfg,[{role:'system',content:built.system},{role:'user',content:evalPrompt}],{maxTokens:300,timeoutMs:60000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true});
      const parsed=_activeParsePlanJson(raw);
      if(parsed&&['send','reschedule','cancel'].includes(String(parsed.action||''))){
        if(parsed.action==='send')return{action:'send',reason:String(parsed.reason||'').slice(0,300)};
        if(parsed.action==='cancel')return{action:'cancel',reason:String(parsed.reason||'模型评估后取消').slice(0,300)};
        const t=Date.parse(parsed.scheduledAt);
        if(Number.isFinite(t)){
          const minMs=Math.max(ACTIVE_PLAN_MIN_DELAY_MS,(prefs.minIntervalMinutes||30)*60*1000);
          const maxMs=Math.min(ACTIVE_PLAN_MAX_DELAY_MS,(prefs.maxPlanHours||168)*3600*1000);
          let delay=t-now;
          if(delay<minMs)delay=minMs;
          if(delay>maxMs)delay=maxMs;
          return{action:'reschedule',scheduledAt:new Date(now+delay).toISOString(),reason:String(parsed.reason||'模型建议延后').slice(0,300)}
        }
        return{action:'cancel',reason:'模型返回了无效的延后时间'}
      }
      return{action:'send',reason:'模型评估输出无法解析，按到期默认发送'}
    }catch(e){return{action:'send',reason:'模型评估失败，按到期默认发送'}}
  }
  return result
}
/* 原子抢占：仅成功把 scheduled → evaluating 的实例能继续执行（IndexedDB 事务保证单执行器） */
function _activeClaimAiPlan(planId,now){
  return new Promise((resolve,reject)=>{
    let claimed=null,tx;
    try{tx=db.transaction([ACTIVE_PLANS_STORE],'readwrite')}catch(e){reject(e);return}
    const store=tx.objectStore(ACTIVE_PLANS_STORE),q=store.get(planId);
    q.onsuccess=function(){
      const p=q.result;
      if(!p){resolve(null);return}
      if(p.status!=='scheduled'){resolve(null);return}
      const updated=Object.assign({},p,{
        status:'evaluating',
        executionId:('exec_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)),
        claimedAt:new Date(now).toISOString(),/* ISO 字符串，与 companion 端一致（防回收判定 Date.parse 失效） */
        updatedAt:new Date(now).toISOString()
      });
      store.put(updated);
      claimed=updated
    };
    q.onerror=function(){try{tx.abort()}catch(e){}};
    tx.oncomplete=()=>resolve(claimed);tx.onerror=()=>reject(tx.error||new Error('AI 计划抢占失败'));tx.onabort=()=>reject(tx.error||new Error('AI 计划抢占中止'))
  })
}
/* 加载计划所需的最新上下文（复用现有上下文加载能力） */
async function _activePlanLatestContext(cfg,plan){
  const ctx=await loadProactiveMessageContext(cfg,Object.assign({},plan,{user_id:plan.user_id||_activeUserId(),message_type:'greeting'}));
  return ctx
}
/* 发送 AI 计划消息：复用现有生成与去重机制 */
async function _activeStoreAiPlanMessage(cfg,plan,out){
  const runAt=Date.now(),msgId='active_msg_'+String(plan.id).replace(/[^\w.-]/g,'_')+'_'+Math.floor(runAt/1000);
  const existing=await dbGet('chatMessages',msgId);if(existing)return existing;
  const msg={id:msgId,role:'assistant',content:out.content,reasoning_content:'',friendId:cfg.id,senderName:cfg.nickname||cfg.model||'AI',timestamp:runAt,source:'active_message',activePlanId:plan.id,activeSettingId:plan.id,scheduledFor:runAt,generatedByFallback:!!out.generatedByFallback,metadata:{config_id:cfg.id,apiConfigId:cfg.id,provider:cfg.provider||'custom',model:cfg.model||'',model_id:cfg.model||'',showThinking:false,source:'active_message',activePlanId:plan.id,generatedByFallback:!!out.generatedByFallback,generationAttempts:Number(out.generationAttempts||1)}};
  await dbPut('chatMessages',msg);
  if(activeFriendId===cfg.id)appendChatBubble('ai',msg.content,msg.senderName,msg.reasoning_content,msg.id,null,null,null,null,cfg);
  else try{_markUnread(cfg.id)}catch(e){}
  try{if(currentPage==='chat')renderChatCalendar()}catch(e){}
  updateChatStorageInfo();_activeNotify(cfg,msg.content);
  _activePlanLog('generated message',{planId:plan.id,messageId:msg.id,generatedByFallback:!!out.generatedByFallback});
  return msg
}
/* 执行 AI 计划状态机：scheduled → evaluating → sending → waiting_for_user / completed / cancelled / expired / failed */
async function _activeExecuteAiPlan(planId){
  let plan=null;
  try{
    plan=await _activeClaimAiPlan(planId,Date.now());
    if(!plan)return{skipped:true,reason:'claim failed（其他执行器已抢占或状态已变化）'};
    /* 双执行器防护：companion 判定离线但计划曾同步过 → 先删除 companion 副本，
       防止实际仍存活的 companion 并行执行（companion 真离线时 DELETE 失败无副作用）。
       DELETE 失败（网络瞬断，companion 可能存活）→ 尝试 PUT evaluating 抢占其副本；
       抢占也失败 → companion 不可达 → 本地执行安全。 */
    if(!_activeCompanionOnline&&plan.companionSynced){
      const delRes=await _activeDeleteCompanionAiPlan(plan.id);
      if(delRes.executed){
        /* companion 副本删除前已执行：本地标记 waiting_for_user（事件随后到达确认），放弃本地执行 */
        const mark=Object.assign({},plan,{status:'waiting_for_user',executedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
        await dbPut(ACTIVE_PLANS_STORE,mark);
        _activePlanLog('companion already executed (delete), plan marked waiting',{planId:plan.id});
        return{skipped:true,reason:'companion 已执行该计划，等待事件确认'}
      }
      if(!delRes.ok){
        let putOk=false,putError=null;
        try{putOk=await _activeSyncAiPlan(plan,true)}catch(e){putError=e}/* force：绕过在线门卫，真实发出 PUT evaluating 抢占 */
        if(putError&&putError.stalePlan){
          const mark=Object.assign({},plan,{status:'waiting_for_user',executedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
          await dbPut(ACTIVE_PLANS_STORE,mark);
          _activePlanLog('companion already executed, plan marked waiting',{planId:plan.id});
          return{skipped:true,reason:'companion 已执行该计划，等待事件确认'}
        }
        if(!putOk){
          plan.companionSynced=false;/* 抢占失败 → companion 不可达 → 本地执行，清除标记 */
          await dbPut(ACTIVE_PLANS_STORE,plan)
        }
      }else{
        plan.companionSynced=false;
        await dbPut(ACTIVE_PLANS_STORE,plan)
      }
    }
    /* 双执行器防护：抢占后立即把 evaluating 状态同步给 companion，避免其 15s tick 并行执行。
       同步失败（网络瞬断）时放弃本地执行并回退 scheduled：若 companion 实际存活会由它执行；
       若 companion 真离线，下个 tick 判定离线后走 DELETE 分支本地执行。 */
    if(_activeCompanionOnline&&plan.companionSynced){
      let syncedOk=false,syncedError=null;
      try{syncedOk=await _activeSyncAiPlan(plan)}catch(e){syncedError=e}
      if(!syncedOk){
        if(syncedError&&syncedError.stalePlan){
          /* companion 已执行该计划：本地先行标记 waiting_for_user（事件随后到达确认），放弃本地执行 */
          const mark=Object.assign({},plan,{status:'waiting_for_user',executedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
          await dbPut(ACTIVE_PLANS_STORE,mark);
          _activePlanLog('companion already executed, plan marked waiting',{planId:plan.id});
          return{skipped:true,reason:'companion 已执行该计划，等待事件确认'}
        }
        const rollback=Object.assign({},plan,{status:'scheduled',updatedAt:new Date().toISOString()});
        await dbPut(ACTIVE_PLANS_STORE,rollback);
        _activePlanLog('companion sync failed, plan rolled back',{planId:plan.id});
        return{skipped:true,reason:'companion 状态同步失败，计划已回退待重试'}
      }
    }
    const prefs=_activeAiPrefs();
    const cfg=apiConfigs.find(a=>a.id===plan.characterId);
    if(!_ibApiReady(cfg)){
      plan.status='failed';plan.lastError='角色 API 配置不完整';plan.updatedAt=new Date().toISOString();
      await dbPut(ACTIVE_PLANS_STORE,plan);if(_activeCompanionOnline)_activeSyncAiPlan(plan).catch(()=>{});
      return{skipped:true,reason:plan.lastError}
    }
    const latest=await _activePlanLatestContext(cfg,plan);
    const evalResult=await evaluateProactiveTask(plan,latest);
    _activePlanLog('evaluation result',{planId:planId,action:evalResult.action,reason:evalResult.reason});
    if(evalResult.action==='cancel'){
      plan=Object.assign({},plan,{status:'cancelled',cancelledAt:new Date().toISOString(),cancelReason:evalResult.reason||'',updatedAt:new Date().toISOString()});
      await dbPut(ACTIVE_PLANS_STORE,plan);if(_activeCompanionOnline)_activeSyncAiPlan(plan).catch(()=>{});
      return{skipped:true,reason:evalResult.reason}
    }
    if(evalResult.action==='reschedule'){
      plan=Object.assign({},plan,{status:'scheduled',scheduledAt:evalResult.scheduledAt||new Date(Date.now()+30*60*1000).toISOString(),updatedAt:new Date().toISOString()});
      await dbPut(ACTIVE_PLANS_STORE,plan);if(_activeCompanionOnline)_activeSyncAiPlan(plan).catch(()=>{});
      return{rescheduled:true,to:plan.scheduledAt,reason:evalResult.reason}
    }
    if(evalResult.action==='failed'){
      plan=Object.assign({},plan,{status:'failed',lastError:evalResult.reason||'',updatedAt:new Date().toISOString()});
      await dbPut(ACTIVE_PLANS_STORE,plan);if(_activeCompanionOnline)_activeSyncAiPlan(plan).catch(()=>{});
      return{skipped:true,reason:evalResult.reason}
    }
    /* send */
    plan=Object.assign({},plan,{status:'sending',updatedAt:new Date().toISOString()});
    await dbPut(ACTIVE_PLANS_STORE,plan);
    if(_chatSendingFor.has(cfg.id)){                       /* 角色正在回复普通消息 → 延后 15 分钟 */
      plan=Object.assign({},plan,{status:'scheduled',scheduledAt:new Date(Date.now()+15*60*1000).toISOString(),updatedAt:new Date().toISOString()});
      await dbPut(ACTIVE_PLANS_STORE,plan);if(_activeCompanionOnline)_activeSyncAiPlan(plan).catch(()=>{});
      return{rescheduled:true,to:plan.scheduledAt,reason:'角色正在回复中'}
    }
    _chatSendingFor.add(cfg.id);
    try{
      const planArgs=Object.assign({},latest,{
        taskId:plan.id,
        planIntent:plan.intent||'',
        planReason:plan.reason||'',
        recentProactiveMessages:latest.recentProactiveMessages||[],
        currentTime:new Date()
      });
      const out=await generateProactiveMessage(planArgs);
      if(!String(out.content||'').trim())throw new Error('模型未返回有效正文');
      /* 双执行器防护：生成期间若 companion 已发送（状态变为 waiting_for_user 等）→ 丢弃本地结果，避免双发 */
      const fresh=await dbGet(ACTIVE_PLANS_STORE,plan.id);
      if(fresh&&fresh.status!=='sending'&&fresh.status!=='evaluating')return{skipped:true,reason:'执行期间计划状态已被其他执行器更新（'+fresh.status+'）'};
      const msg=await _activeStoreAiPlanMessage(cfg,plan,out);
      /* 写入发送历史（与现有历史表兼容） */
      try{
        const histId='active_run_'+String(plan.id).replace(/[^\w.-]/g,'_')+'_'+Math.floor(msg.timestamp/1000);
        await dbPut(ACTIVE_HISTORY_STORE,{id:histId,setting_id:plan.id,plan_id:plan.id,user_id:plan.user_id||_activeUserId(),character_id:cfg.id,character_name:cfg.nickname||cfg.model||'AI',scheduled_for:msg.timestamp,sent_at:msg.timestamp,status:'sent',content:msg.content,reasoning_content:'',message_id:msg.id,source:'ai_planned',generatedByFallback:!!out.generatedByFallback,generationAttempts:Number(out.generationAttempts||1),generation_error:out.generationError||''})
      }catch(e){}
      const sentAt=new Date().toISOString();
      plan=Object.assign({},plan,{
        status:'waiting_for_user',
        executedAt:sentAt,
        attemptCount:(plan.attemptCount||0)+1,
        updatedAt:sentAt,
        lastError:null
      });
      /* 连续主动限制：allowFollowUpPlan 默认 false；即使用户开启，也受全局 maxConsecutive 限制。
         用户未回复时不允许再次规划（waiting_for_user 状态保持，用户回复后由 _activeUserReplied 取消）。 */
      await dbPut(ACTIVE_PLANS_STORE,plan);
      if(_activeCompanionOnline)_activeSyncAiPlan(plan).catch(()=>{});
      _activePlanLog('task completed',{planId:plan.id,status:plan.status,messageId:msg.id});
      return{sent:true,messageId:msg.id}
    }finally{if(_chatSendingFor.has(cfg.id))_chatSendingFor.delete(cfg.id)}
  }catch(e){
    _activePlanLog('execution failed',{planId:planId,error:String(e&&e.message||e).slice(0,300)});
    try{
      if(plan){
        const attemptCount=(plan.attemptCount||0)+1;
        const maxAttempts=Math.max(1,(plan.constraints&&plan.constraints.maxAttempts)||ACTIVE_PLAN_MAX_ATTEMPTS);
        if(attemptCount>=maxAttempts){
          plan=Object.assign({},plan,{status:'failed',attemptCount:attemptCount,lastError:String(e&&e.message||e).slice(0,300),updatedAt:new Date().toISOString()})
        }else{
          plan=Object.assign({},plan,{status:'scheduled',attemptCount:attemptCount,lastError:String(e&&e.message||e).slice(0,300),scheduledAt:new Date(Date.now()+15*60*1000).toISOString(),updatedAt:new Date().toISOString()})
        }
        await dbPut(ACTIVE_PLANS_STORE,plan);
        if(_activeCompanionOnline)_activeSyncAiPlan(plan).catch(()=>{})
      }
    }catch(e2){}
    return{failed:true,error:String(e&&e.message||e).slice(0,200)}
  }
}
/* 扫描到期 AI 计划并执行；同时处理休眠/重启后的过期任务（不批量轰炸，超时任务重新评估） */
async function _activeTickAiPlans(){
  if(!db)return;
  try{
    const prefs=_activeAiPrefs();
    if(!prefs.enabled)return;
    const all=await dbGetAll(ACTIVE_PLANS_STORE);
    if(!all.length)return;
    const now=Date.now();
    for(const p of all){
      if(p.source==='user_reminder')continue;
      if(!['scheduled','waiting_for_user','evaluating','sending'].includes(p.status))continue;
      /* 崩溃恢复：evaluating/sending 停留超过 10 分钟 → 视为执行器崩溃，回收为 scheduled */
      if((p.status==='evaluating'||p.status==='sending')&&p.claimedAt){
        const claimedTs=typeof p.claimedAt==='number'?p.claimedAt:(Date.parse(p.claimedAt)||0);/* 兼容数字与 ISO 两种历史格式 */
        if(claimedTs>0&&now-claimedTs>10*60*1000){
          const maxAttempts=Math.max(1,(p.constraints&&p.constraints.maxAttempts)||ACTIVE_PLAN_MAX_ATTEMPTS);
          const attemptCount=(p.attemptCount||0)+1;
          if(attemptCount>=maxAttempts){
            const patched=Object.assign({},p,{status:'failed',attemptCount:attemptCount,lastError:'执行超时次数达到上限（执行器可能已崩溃）',updatedAt:new Date().toISOString()});
            await dbPut(ACTIVE_PLANS_STORE,patched);
            _activePlanLog('stale execution failed',{planId:p.id});
            if(_activeCompanionOnline)_activeSyncAiPlan(patched).catch(()=>{})
          }else{
            const patched=Object.assign({},p,{status:'scheduled',attemptCount:attemptCount,updatedAt:new Date().toISOString(),lastError:'执行超时（执行器可能已崩溃），已回收'});
            if(Date.parse(patched.scheduledAt)<=now)patched.scheduledAt=new Date(now+15*60*1000).toISOString();
            await dbPut(ACTIVE_PLANS_STORE,patched);
            _activePlanLog('stale execution recovered',{planId:p.id});
            if(_activeCompanionOnline)_activeSyncAiPlan(patched).catch(()=>{})
          }
        }
        continue
      }
      if(p.status==='waiting_for_user')continue;        /* 等待用户回复：由用户发言触发取消，不自动重发 */
      if(p.characterId&&!apiConfigs.some(a=>a.id===p.characterId))continue;
      const due=Date.parse(p.scheduledAt);
      if(!Number.isFinite(due))continue;
      const late=now-due;
      if(late<0)continue;                                /* 未到期 */
      if(late>ACTIVE_PLAN_MAX_LATE_MS){                  /* 错过触发时间过久（休眠/重启恢复） */
        p.status='expired';p.cancelReason='错过触发时间超过 '+Math.round(ACTIVE_PLAN_MAX_LATE_MS/60000)+' 分钟';p.updatedAt=new Date().toISOString();
        await dbPut(ACTIVE_PLANS_STORE,p);
        _activePlanLog('task expired',{planId:p.id,lateMs:late});
        continue
      }
      /* companion 在线且已同步的计划由 companion 独占执行，浏览器跳过（防双执行器重复） */
      if(_activeCompanionOnline&&p.companionSynced)continue;
      if(_chatSendingFor.has(p.characterId))continue;    /* 角色正在回复 → 下个 tick 再评估 */
      await _activeExecuteAiPlan(p.id)
    }
    if(currentPage==='active')_activeRenderAiPlans()
  }catch(e){_activePlanLog('tick failed',{error:String(e&&e.message||e).slice(0,200)})}
}

/* ── companion 同步：AI 计划 PUT/DELETE（companion 在线时由其后台独占执行） ── */
async function _activeSyncAiPlan(plan,force){
  if(!force&&!_activeCompanionOnline)return false;
  if(!plan||!plan.id)return false;
  const cfg=apiConfigs.find(a=>a.id===plan.characterId);
  if(!_ibApiReady(cfg))return false;
  try{
    const ctx=await _activePlanLatestContext(cfg,plan);
    const snapshot={
      plan:plan,
      character:{id:cfg.id,provider:cfg.provider,apiKey:cfg.apiKey,model:cfg.model,endpoint:cfg.endpoint,systemPrompt:cfg.systemPrompt||getDefaultPromptForTheme(),nickname:cfg.nickname||cfg.model||'AI',relationship:cfg.relationship||'',temperature:cfg.temperature,showThinking:_resolveShowThinking(cfg)},
      user:ctx.user,
      recent_memories:ctx.memories,
      recent_messages:ctx.recentMessages,
      recent_proactive_messages:ctx.recentProactiveMessages,
      chat_summary:ctx.chatSummary,
      last_interaction_at:ctx.lastInteractionAt
    };
    await _activeCompanionRequest('/plans/'+encodeURIComponent(plan.id),{method:'PUT',body:snapshot,timeout:5000})
      .then(res=>{
        if(res&&res.stale){
          const err=new Error('plan already executed on companion');err.stalePlan=true;throw err
        }
        return res
      });
    if(!plan.companionSynced){plan.companionSynced=true;await dbPut(ACTIVE_PLANS_STORE,plan)}
    return true
  }catch(e){
    if(e&&e.stalePlan)throw e;/* 特殊错误：companion 已执行，交由调用方决策 */
    _activePlanLog('companion sync failed',{planId:plan.id,error:String(e&&e.message||e).slice(0,200)});_activeSetServiceStatus(false);return false
  }
}
async function _activeDeleteCompanionAiPlan(id){
  /* 不检查 _activeCompanionOnline：调用方可能在判定离线后仍需要删除 companion 残留副本（防双发）。
     返回 {ok, executed}：executed=true 表示删除前 companion 端已执行该计划（浏览器应标记 waiting 放弃本地执行） */
  try{
    const res=await _activeCompanionRequest('/plans/'+encodeURIComponent(id)+'?user_id='+encodeURIComponent(_activeUserId()),{method:'DELETE',timeout:2500});
    return{ok:true,executed:!!(res&&res.executed)}
  }catch(e){return{ok:false,executed:false}}
}
async function _activeSyncAllAiPlans(){
  if(!_activeCompanionOnline)return;
  try{
    const all=await dbGetAll(ACTIVE_PLANS_STORE);
    const synced=new Set();
    for(const p of all){
      if(!['scheduled','waiting_for_user','evaluating','sending'].includes(p.status))continue;
      try{
        if(await _activeSyncAiPlan(p)){
          synced.add(p.id)
        }else{
          /* 同步失败：清除 companionSynced 标记，浏览器本地保留并自行执行；
             companion 端副本由下方 reconcile 删除，两边状态保持一致（不僵尸化） */
          if(p.companionSynced){p.companionSynced=false;await dbPut(ACTIVE_PLANS_STORE,p).catch(()=>{})}
        }
      }catch(e){
        if(e&&e.stalePlan){
          /* companion 已执行该计划：本地标记 waiting_for_user（事件随后到达确认），避免状态卡死 */
          const mark=Object.assign({},p,{status:'waiting_for_user',executedAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
          await dbPut(ACTIVE_PLANS_STORE,mark).catch(()=>{});
          _activePlanLog('companion already executed, plan marked waiting',{planId:p.id})
        }else{
          if(p.companionSynced){p.companionSynced=false;await dbPut(ACTIVE_PLANS_STORE,p).catch(()=>{})}
        }
      }
    }
    /* 只声明 plan_ids：不得携带 task_ids，否则空数组会误删 companion 端全部手动后台计划 */
    try{await _activeCompanionRequest('/reconcile',{method:'POST',body:{user_id:_activeUserId(),plan_ids:[...synced]},timeout:5000})}catch(e){}
  }catch(e){}
}
/* ── AI 规划设置与任务管理 UI ── */
/* 最长规划时间辅助文字：小时 → “约 N 天”（纯展示，不改变存储单位） */
function _activeUpdateMaxHoursHint(){
  try{
    const el=document.getElementById('ai-plan-max-hours'),hint=document.getElementById('ai-plan-max-hours-hint');
    if(!el||!hint)return;
    const h=Math.max(0,parseInt(el.value,10)||0);
    if(h<=0){hint.textContent='';return}
    if(h<24)hint.textContent='约 '+h+' 小时';
    else if(h%24===0)hint.textContent='约 '+(h/24)+' 天';
    else hint.textContent='约 '+(Math.round(h/24*10)/10)+' 天'
  }catch(e){}
}
async function _activeRenderAiPrefs(){
  const p=_activeAiPrefs();
  const set=(id,val)=>{const el=document.getElementById(id);if(el)el.value=val};
  const chk=(id,val)=>{const el=document.getElementById(id);if(el)el.checked=!!val};
  chk('ai-plan-enabled',p.enabled);
  set('ai-plan-mode',p.mode);
  set('ai-plan-min-interval',p.minIntervalMinutes);
  set('ai-plan-max-hours',p.maxPlanHours);
  set('ai-plan-max-consecutive',p.maxConsecutive);
  set('ai-plan-dnd-start',p.dndStart);
  set('ai-plan-dnd-end',p.dndEnd);
  chk('ai-plan-cancel-reply',p.cancelIfUserReplies);
  chk('ai-plan-allow-reschedule',p.allowReschedule);
  chk('ai-plan-debug',p.showDebug);
  _activeUpdateMaxHoursHint()
}
function _activeAiPrefsFromForm(){
  const val=(id,d)=>{const el=document.getElementById(id);return el?el.value:d};
  const chk=(id,d)=>{const el=document.getElementById(id);return el?el.checked:d};
  return{
    enabled:chk('ai-plan-enabled',true),
    mode:['fixed','ai','hybrid'].includes(val('ai-plan-mode','ai'))?val('ai-plan-mode','ai'):'ai',
    minIntervalMinutes:Math.max(5,Math.min(1440,parseInt(val('ai-plan-min-interval','30'),10)||30)),
    maxPlanHours:Math.max(1,Math.min(720,parseInt(val('ai-plan-max-hours','168'),10)||168)),
    maxConsecutive:Math.max(1,Math.min(5,parseInt(val('ai-plan-max-consecutive','1'),10)||1)),
    dndStart:String(val('ai-plan-dnd-start',ACTIVE_PLAN_DEFAULT_DND_START)).slice(0,5),
    dndEnd:String(val('ai-plan-dnd-end',ACTIVE_PLAN_DEFAULT_DND_END)).slice(0,5),
    cancelIfUserReplies:chk('ai-plan-cancel-reply',true),
    allowReschedule:chk('ai-plan-allow-reschedule',true),
    showDebug:chk('ai-plan-debug',false)
  }
}
function _activeSaveAiPrefs(){
  const p=_activeAiPrefsFromForm();
  _activeAiPrefsSave(p);
  if(!p.enabled)_activeCancelAiPlans(null,'用户关闭了 AI 主动联系').then(()=>{_activeRenderAiPlans()});
  if(_activeCompanionOnline)_activeSyncAllAiPlans();
  toast('AI 主动规划设置已保存');
  return false
}
function _activePlanRowAction(id,action){
  (async()=>{
    try{
      const p=await dbGet(ACTIVE_PLANS_STORE,id);if(!p){toast('计划不存在');return}
      if(action==='cancel'){
        p.status='cancelled';p.cancelledAt=new Date().toISOString();p.cancelReason='用户手动取消';p.updatedAt=p.cancelledAt;
        await dbPut(ACTIVE_PLANS_STORE,p);if(_activeCompanionOnline)_activeSyncAiPlan(p).catch(()=>{});toast('计划已取消')
      }else if(action==='run'){
        if(p.status!=='scheduled'){toast('仅 scheduled 状态的计划可立即执行');return}
        toast('正在生成主动消息…');await _activeExecuteAiPlan(id)
      }else if(action==='reschedule'){
        if(p.status!=='scheduled'){toast('仅 scheduled 状态的计划可延后');return}
        p.status='scheduled';p.scheduledAt=new Date(Date.now()+60*60*1000).toISOString();p.updatedAt=new Date().toISOString();
        await dbPut(ACTIVE_PLANS_STORE,p);if(_activeCompanionOnline)_activeSyncAiPlan(p).catch(()=>{});toast('已延后 1 小时')
      }else if(action==='clear'){
        await dbDelete(ACTIVE_PLANS_STORE,id);
        if(_activeCompanionOnline)_activeDeleteCompanionAiPlan(id);
        toast('已清除')
      }
      _activeRenderAiPlans()
    }catch(e){toast('操作失败：'+(e.message||e))}
  })()
}
async function _activeRenderAiPlans(){
  const box=document.getElementById('ai-plan-list');if(!box)return;
  let all=[];try{all=await dbGetAll(ACTIVE_PLANS_STORE)}catch(e){}
  const prefs=_activeAiPrefs();
  all.sort((a,b)=>(Date.parse(b.updatedAt||b.createdAt||0)-Date.parse(a.updatedAt||a.createdAt||0)));
  const countEl=document.getElementById('ai-plan-count');
  const active=all.filter(p=>['scheduled','waiting_for_user','evaluating','sending'].includes(p.status)).length;
  if(countEl)countEl.textContent=all.length+' 个任务 · '+active+' 个进行中';
  box.innerHTML='';
  if(!all.length){box.innerHTML='<div class="active-empty">还没有 AI 规划任务。完成一轮聊天后，角色模型会在后台自动规划下一次主动联系。</div>';return}
  for(const p of all){
    const cfg=apiConfigs.find(a=>a.id===p.characterId)||archivedConfigs.find(a=>a.id===p.characterId);
    const row=document.createElement('div');row.className='active-setting'+(p.status==='cancelled'||p.status==='expired'||p.status==='failed'?' off':'');
    const top=document.createElement('div');top.className='active-setting-top';
    const who=document.createElement('div');who.className='active-setting-who';
    const av=document.createElement('span');av.className='active-avatar';
    const name=cfg?(cfg.nickname||cfg.model||'AI'):'角色已删除';
    if(cfg&&cfg.avatar){const img=document.createElement('img');img.src=cfg.avatar;img.alt='';av.appendChild(img)}else av.textContent=(name||'?').charAt(0);
    const copy=document.createElement('div'),nm=document.createElement('div'),meta=document.createElement('div');
    nm.className='active-setting-name';nm.textContent=name;
    meta.className='active-setting-meta';meta.textContent=_activePlanSourceLabel(p.source)+' · '+_activePlanStatusLabel(p.status);
    copy.append(nm,meta);who.append(av,copy);
    const acts=document.createElement('div');acts.className='active-setting-actions';
    if(['scheduled','waiting_for_user'].includes(p.status)){
      const cBtn=document.createElement('button');cBtn.className='active-mini-btn';cBtn.textContent='取消';cBtn.onclick=()=>_activePlanRowAction(p.id,'cancel');acts.appendChild(cBtn)
    }
    if(p.status==='scheduled'){
      const rBtn=document.createElement('button');rBtn.className='active-mini-btn';rBtn.textContent='立即执行';rBtn.onclick=()=>_activePlanRowAction(p.id,'run');acts.appendChild(rBtn);
      const dBtn=document.createElement('button');dBtn.className='active-mini-btn';dBtn.textContent='延后';dBtn.onclick=()=>_activePlanRowAction(p.id,'reschedule');acts.appendChild(dBtn)
    }
    if(['cancelled','expired','failed','completed'].includes(p.status)){
      const xBtn=document.createElement('button');xBtn.className='active-mini-btn';xBtn.textContent='清除';xBtn.onclick=()=>_activePlanRowAction(p.id,'clear');acts.appendChild(xBtn)
    }
    top.append(who,acts);
    const next=document.createElement('div');next.className='active-next';
    const when=document.createElement('span');
    const due=Date.parse(p.scheduledAt);
    when.textContent=p.status==='scheduled'?(due?_activeFormatWhen(due):'尚未安排'):(p.cancelReason||p.lastError||'');
    const intent=document.createElement('span');intent.className='active-propensity';intent.innerHTML='<i></i>';intent.appendChild(document.createTextNode('意图：'+(p.intent||'未说明')));
    next.append(when,intent);
    if(prefs.showDebug&&(p.reason||p.sourceMessageId)){
      const dbg=document.createElement('div');dbg.className='active-next';
      const dr=document.createElement('span');dr.textContent='依据：'+(p.reason||'')+' · 来源消息：'+(p.sourceMessageId||'');
      dbg.appendChild(dr);row.append(top,next,dbg)
    }else row.append(top,next);
    box.appendChild(row)
  }
}
async function _activeClearFinishedAiPlans(){
  if(!confirm('清除所有已完成/已取消/已过期/失败的 AI 规划任务？'))return;
  try{
    const all=await dbGetAll(ACTIVE_PLANS_STORE);
    for(const p of all){
      if(['completed','cancelled','expired','failed'].includes(p.status)){
        await dbDelete(ACTIVE_PLANS_STORE,p.id);
        if(_activeCompanionOnline)_activeDeleteCompanionAiPlan(p.id)
      }
    }
    await _activeRenderAiPlans();toast('已清除终态任务')
  }catch(e){toast('清除失败：'+(e.message||e))}
}


/* 迁移期双挂载：HTML 与其他脚本仍通过 window 访问。 */
window.ACTIVE_PLANS_STORE=ACTIVE_PLANS_STORE;
window.ACTIVE_AI_PREFS_KEY=ACTIVE_AI_PREFS_KEY;
window.ACTIVE_PLAN_MIN_DELAY_MS=ACTIVE_PLAN_MIN_DELAY_MS;
window.ACTIVE_PLAN_MAX_DELAY_MS=ACTIVE_PLAN_MAX_DELAY_MS;
window.ACTIVE_PLAN_MAX_LATE_MS=ACTIVE_PLAN_MAX_LATE_MS;
window.ACTIVE_PLAN_MAX_ATTEMPTS=ACTIVE_PLAN_MAX_ATTEMPTS;
window.ACTIVE_PLAN_DEFAULT_DND_START=ACTIVE_PLAN_DEFAULT_DND_START;
window.ACTIVE_PLAN_DEFAULT_DND_END=ACTIVE_PLAN_DEFAULT_DND_END;
window._activeAiPrefs=_activeAiPrefs;
window._activeAiPrefsSave=_activeAiPrefsSave;
window._activePlanDefaults=_activePlanDefaults;
window._activeParsePlanJson=_activeParsePlanJson;
window._activeValidatePlanResult=_activeValidatePlanResult;
window._activeIsInDnd=_activeIsInDnd;
window._activeNextDndFree=_activeNextDndFree;
window._activePlanLog=_activePlanLog;
window._activePlanStatusLabel=_activePlanStatusLabel;
window._activePlanSourceLabel=_activePlanSourceLabel;
window.buildPlanPrompt=buildPlanPrompt;
window._activeSaveAiPlan=_activeSaveAiPlan;
window._activeCancelAiPlans=_activeCancelAiPlans;
window.planNextProactiveMessage=planNextProactiveMessage;
window._activeMaybePlanNext=_activeMaybePlanNext;
window._activeUserReplied=_activeUserReplied;
window.evaluateProactiveTask=evaluateProactiveTask;
window._activeClaimAiPlan=_activeClaimAiPlan;
window._activePlanLatestContext=_activePlanLatestContext;
window._activeStoreAiPlanMessage=_activeStoreAiPlanMessage;
window._activeExecuteAiPlan=_activeExecuteAiPlan;
window._activeTickAiPlans=_activeTickAiPlans;
window._activeSyncAiPlan=_activeSyncAiPlan;
window._activeDeleteCompanionAiPlan=_activeDeleteCompanionAiPlan;
window._activeSyncAllAiPlans=_activeSyncAllAiPlans;
window._activeUpdateMaxHoursHint=_activeUpdateMaxHoursHint;
window._activeRenderAiPrefs=_activeRenderAiPrefs;
window._activeAiPrefsFromForm=_activeAiPrefsFromForm;
window._activeSaveAiPrefs=_activeSaveAiPrefs;
window._activePlanRowAction=_activePlanRowAction;
window._activeRenderAiPlans=_activeRenderAiPlans;
window._activeClearFinishedAiPlans=_activeClearFinishedAiPlans;
NS.expose('active.plans', {
  ACTIVE_PLANS_STORE: ACTIVE_PLANS_STORE,
  ACTIVE_AI_PREFS_KEY: ACTIVE_AI_PREFS_KEY,
  ACTIVE_PLAN_MIN_DELAY_MS: ACTIVE_PLAN_MIN_DELAY_MS,
  ACTIVE_PLAN_MAX_DELAY_MS: ACTIVE_PLAN_MAX_DELAY_MS,
  ACTIVE_PLAN_MAX_LATE_MS: ACTIVE_PLAN_MAX_LATE_MS,
  ACTIVE_PLAN_MAX_ATTEMPTS: ACTIVE_PLAN_MAX_ATTEMPTS,
  ACTIVE_PLAN_DEFAULT_DND_START: ACTIVE_PLAN_DEFAULT_DND_START,
  ACTIVE_PLAN_DEFAULT_DND_END: ACTIVE_PLAN_DEFAULT_DND_END,
  _activeAiPrefs: _activeAiPrefs,
  _activeAiPrefsSave: _activeAiPrefsSave,
  _activePlanDefaults: _activePlanDefaults,
  _activeParsePlanJson: _activeParsePlanJson,
  _activeValidatePlanResult: _activeValidatePlanResult,
  _activeIsInDnd: _activeIsInDnd,
  _activeNextDndFree: _activeNextDndFree,
  _activePlanLog: _activePlanLog,
  _activePlanStatusLabel: _activePlanStatusLabel,
  _activePlanSourceLabel: _activePlanSourceLabel,
  buildPlanPrompt: buildPlanPrompt,
  _activeSaveAiPlan: _activeSaveAiPlan,
  _activeCancelAiPlans: _activeCancelAiPlans,
  planNextProactiveMessage: planNextProactiveMessage,
  _activeMaybePlanNext: _activeMaybePlanNext,
  _activeUserReplied: _activeUserReplied,
  evaluateProactiveTask: evaluateProactiveTask,
  _activeClaimAiPlan: _activeClaimAiPlan,
  _activePlanLatestContext: _activePlanLatestContext,
  _activeStoreAiPlanMessage: _activeStoreAiPlanMessage,
  _activeExecuteAiPlan: _activeExecuteAiPlan,
  _activeTickAiPlans: _activeTickAiPlans,
  _activeSyncAiPlan: _activeSyncAiPlan,
  _activeDeleteCompanionAiPlan: _activeDeleteCompanionAiPlan,
  _activeSyncAllAiPlans: _activeSyncAllAiPlans,
  _activeUpdateMaxHoursHint: _activeUpdateMaxHoursHint,
  _activeRenderAiPrefs: _activeRenderAiPrefs,
  _activeAiPrefsFromForm: _activeAiPrefsFromForm,
  _activeSaveAiPrefs: _activeSaveAiPrefs,
  _activePlanRowAction: _activePlanRowAction,
  _activeRenderAiPlans: _activeRenderAiPlans,
  _activeClearFinishedAiPlans: _activeClearFinishedAiPlans
});
})(window.IB || (window.IB = {}));
