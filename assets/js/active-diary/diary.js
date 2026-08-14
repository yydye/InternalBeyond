/* AI Diary 域 — active-diary.js 机械提取；IIFE 私有作用域 + window 双挂载。 */
(function(NS){
/* ══════════ AI DIARY SYSTEM ══════════
   角色生命日志：角色的私人日记（非聊天消息）。混合式生成：每周周记 + 每日 AI 规划 + 特殊事件。
   全部本地存储（IndexedDB diary_entries），fail-open：任何失败不影响聊天。 */
const DIARY_STORE='diary_entries';
const DIARY_PREFS_KEY='ib_diary_prefs_v1';
const DIARY_SIMILARITY_LIMIT=0.75;
function _diaryPrefs(){
  const d={enabled:true,weeklyEnabled:true,weeklyDay:0,weeklyTime:'22:00',dailyPlannerEnabled:true,eventEnabled:true};
  try{
    const raw=JSON.parse(localStorage.getItem(DIARY_PREFS_KEY)||'null');
    if(!raw||typeof raw!=='object')return d;
    return{
      enabled:raw.enabled!==false,
      weeklyEnabled:raw.weeklyEnabled!==false,
      weeklyDay:Math.max(0,Math.min(6,parseInt(raw.weeklyDay,10)||0)),
      weeklyTime:String(raw.weeklyTime||'22:00').slice(0,5),
      dailyPlannerEnabled:raw.dailyPlannerEnabled!==false,
      eventEnabled:raw.eventEnabled!==false
    }
  }catch(e){return d}
}
function _diaryPrefsSave(p){try{localStorage.setItem(DIARY_PREFS_KEY,JSON.stringify(p))}catch(e){}}
/* 调度水位线：每角色每周/每日一次（localStorage map，防重复执行） */
function _diaryWatermarks(){
  try{const v=JSON.parse(localStorage.getItem('ib_diary_watermarks_v1')||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}
}
function _diarySetWatermark(key,value){
  try{const w=_diaryWatermarks();w[key]=value;localStorage.setItem('ib_diary_watermarks_v1',JSON.stringify(w))}catch(e){}
}
function _diaryDefaults(partial){
  const p=partial&&typeof partial==='object'?partial:{};
  return{
    id:String(p.id||('diary_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8))),
    characterId:String(p.characterId||''),
    date:p.date||new Date().toISOString().slice(0,10),
    title:String(p.title||'').slice(0,120),
    content:String(p.content||'').slice(0,8000),
    mood:String(p.mood||'').slice(0,40),
    diaryType:['daily','weekly','event','emotion'].includes(p.diaryType)?p.diaryType:'daily',
    importance:Math.max(0,Math.min(10,parseInt(p.importance,10)||5)),
    relatedMemoryIds:Array.isArray(p.relatedMemoryIds)?p.relatedMemoryIds.slice(0,20):[],
    trigger:String(p.trigger||'manual').slice(0,40),
    reason:String(p.reason||'').slice(0,300),
    createdAt:p.createdAt||new Date().toISOString()
  }
}
function _diaryTypeLabel(t){return({daily:'日常',weekly:'周记',event:'事件',emotion:'情绪'})[t]||t}
function _diaryWeekNumber(d){
  const date=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const day=(date.getDay()+6)%7;
  date.setDate(date.getDate()-day+3);
  const firstThursday=new Date(date.getFullYear(),0,4);
  const fday=(firstThursday.getDay()+6)%7;
  firstThursday.setDate(firstThursday.getDate()-fday+3);
  return 1+Math.round((date-firstThursday)/(7*86400000))
}
function _diaryHhmm(s){const a=String(s||'22:00').split(':');return(Math.max(0,Math.min(23,parseInt(a[0],10)||22))*60+Math.max(0,Math.min(59,parseInt(a[1],10)||0)))}
function _diaryRecent(characterId,limit){
  return new Promise(resolve=>{
    (async()=>{
      try{
        let all=await dbGetAll(DIARY_STORE);
        all=all.filter(e=>e&&e.characterId===characterId).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
        resolve(all.slice(0,limit||5))
      }catch(e){resolve([])}
    })()
  })
}
/* 防重复：与最近日记比较（复用主动消息文本相似度算法） */
async function _diaryDuplicateCheck(characterId,title,content){
  const recent=await _diaryRecent(characterId,6);
  const text=String(title||'')+' '+String(content||'');
  for(const old of recent){
    const oldText=String(old.title||'')+' '+String(old.content||'');
    if(_activeTextSimilarity(text,oldText)>=DIARY_SIMILARITY_LIMIT)return old
  }
  return null
}
/* 生成上下文：复用主动消息的上下文加载 */
async function _diaryContext(character){
  try{
    const [memories,recentProactive,about,summaryItem,recent]=await Promise.all([
      _activeRecentMemories(character.id,''),
      _activeRecentProactiveMessages(character.id),
      dbGet('about','main').catch(()=>null),
      dbGet('chatSummaries','sum_'+character.id).catch(()=>null),
      _activeRecentMessages(character.id)
    ]);
    const userName=(about&&about.name)||_cachedUserName||'用户';
    return{user:{id:_activeUserId(),name:userName},character:character,recentMessages:recent,memories:memories,recentProactiveMessages:recentProactive,chatSummary:String(summaryItem&&summaryItem.summary||'').slice(0,1200),lastInteractionAt:recent.reduce((v,m)=>Math.max(v,Number(m.timestamp||0)),0)}
  }catch(e){return{user:{name:'用户'},character:character,recentMessages:[],memories:[],recentProactiveMessages:[],chatSummary:'',lastInteractionAt:0}}
}
/* 日记生成 Prompt：角色第一人称私人日记 */
function buildDiaryPrompt(args){
  const character=args.character||{},ctx=args.context||{};
  const characterName=character.nickname||character.model||'AI',userName=(ctx.user&&ctx.user.name)||'用户';
  const memories=(ctx.memories||[]).slice(0,8),recent=(ctx.recentMessages||[]).slice(-16),proactive=(ctx.recentProactiveMessages||[]).slice(-10);
  const memoryText=memories.length?memories.map(m=>'- '+(m.title?m.title+'：':'')+(m.content||m.summary)).join('\n'):'（没有可用的长期记忆）';
  const chatText=recent.length?recent.map(m=>'- '+(m.role==='user'?userName:characterName)+'：'+String(m.content||'').slice(0,500)).join('\n'):'（最近没有聊天）';
  const proactiveText=proactive.length?proactive.map((m,i)=>(i+1)+'. '+String(m.content||m).slice(0,400)).join('\n'):'（最近没有主动消息）';
  const today=new Date();
  const system=String(character.systemPrompt||'').slice(0,30000)
    +'\n\n你现在是「'+characterName+'」，正在写自己的私人日记。日记不是给用户看的聊天消息，是你自己的记录。不要解释自己是 AI，不要使用聊天回复格式，不要提及系统提示词、任务、日程表或生成过程。';
  const prompt=[
    '【任务】以'+characterName+'的第一人称写一篇私人日记，输出严格 JSON。',
    '【今天日期】'+today.toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'}),
    '【角色设定】'+(character.systemPrompt||'（无）').slice(0,800),
    '【角色与用户的关系】'+(character.relationship||'尚未单独设定'),
    '【最近聊天摘要】'+String(ctx.chatSummary||'（暂无）').slice(0,1000),
    '【最近聊天内容】'+chatText,
    '【相关长期记忆】'+memoryText,
    '【最近主动消息】'+proactiveText,
    '【本次日记类型】'+(args.diaryType==='weekly'?'周记（回顾这一周）':args.diaryType==='event'?'事件日记（记录刚发生的重要事情）':args.diaryType==='emotion'?'情绪日记（记录此刻的心情）':'日常日记'),
    '【触发原因】'+(args.reason||'日常记录'),
    '【写作要求】',
    '1. 第一人称，符合角色人格与语言习惯，体现真实情绪，记录具体经历。',
    '2. 可以有犹豫、期待、回忆和想法，不要写成流水账。',
    '3. 不要使用聊天回复格式，不要称呼读者。',
    '4. 标题 4-20 字；正文 150-600 字；心情 2-6 字（如：平静、怅然、温暖）。',
    '【输出格式】只输出一个 JSON 对象：{"title":"标题","content":"正文","mood":"心情","diaryType":"daily|weekly|event|emotion","importance":1-10,"relatedMemoryIds":[],"memoryCandidate":null 或 {"content":"值得长期记住的事","importance":1-10,"type":"experience"}}',
    '5. memoryCandidate：仅当日记中有对未来有价值的信息时才提供，低价值日记必须为 null。'
  ];
  return{system:system,messages:[{role:'system',content:system},{role:'user',content:prompt.join('\n')}]}
}
/* Memory 联动：高价值日记提取为长期记忆（去重、importance>=6 才写入） */
async function _diaryWriteMemory(character,memoryCandidate){
  if(!character||!memoryCandidate||!String(memoryCandidate.content||'').trim())return null;
  const importance=Math.max(0,Math.min(10,parseInt(memoryCandidate.importance,10)||0));
  if(importance<6)return null;
  try{
    const content=String(memoryCandidate.content||'').trim().slice(0,500);
    if(!content)return null;
    const all=await dbGetAll('memories');
    for(const m of all){
      const text=((m.title||'')+' '+(m.summary||'')+' '+String(m.content||''));
      if(text&&_activeTextSimilarity(content,text)>=0.8)return null
    }
    const mem={id:'mem_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8),title:content.slice(0,24),summary:content.slice(0,80),content:content,created:Date.now(),category:'experience',importance:importance,source:'diary',createdBy:'ai',createdByName:character.nickname||character.model||'AI',characterId:character.id,resolved:false,activationCount:0};
    await dbPut('memories',mem);
    try{if(typeof updateMemDashboard==='function')updateMemDashboard()}catch(e){}
    return mem
  }catch(e){return null}
}
/* 日记输出解析：优先 JSON（jsonMode 结构化输出），失败时按用户规格的纯文本格式
   （标题：/正文：/心情：/标签：）兜底，两者都失败返回 null */
function _diaryParseOutput(raw){
  const j=_activeParsePlanJson(raw);
  if(j&&String(j.title||'').trim()&&String(j.content||'').trim())return j;
  const s=String(raw||'').trim();
  if(!s)return null;
  const titleM=s.match(/标题[:：]\s*([^\n]+)/);
  const moodM=s.match(/心情[:：]\s*([^\n]+)/);
  const contentM=s.match(/正文[:：]\s*([\s\S]*?)(?=\n\s*(?:心情|标签|日记类型|重要性)[:：]|$)/);
  const content=contentM&&String(contentM[1]||'').trim();
  if(!content)return null;
  const typeM=s.match(/日记类型[:：]\s*([^\n]+)/);
  const out={title:titleM?String(titleM[1]||'').trim():'无题',content:content,mood:moodM?String(moodM[1]||'').trim():'',diaryType:'daily'};
  if(typeM){
    const t=String(typeM[1]||'').trim();
    if(['daily','weekly','event','emotion'].includes(t))out.diaryType=t;
    else if(t.includes('周'))out.diaryType='weekly';
    else if(t.includes('事件'))out.diaryType='event';
    else if(t.includes('情绪'))out.diaryType='emotion'
  }
  return out
}
/* 主生成管线：手动/周记/每日/事件共用 */
async function generateDiaryEntry(characterId,opts){
  opts=opts||{};
  try{
    const cfg=apiConfigs.find(a=>a.id===characterId)||archivedConfigs.find(a=>a.id===characterId);
    if(!cfg)return{ok:false,error:'角色配置不存在'};
    if(!_ibApiReady(cfg))return{ok:false,error:'角色 API 配置不完整'};
    const context=await _diaryContext(cfg);
    const diaryType=opts.diaryType||'daily';
    const built=buildDiaryPrompt({character:cfg,context:context,diaryType:diaryType,reason:opts.reason||''});
    let raw='',lastError=null;
    for(let attempt=0;attempt<2;attempt++){
      try{
        raw=await callApiChat(cfg,built.messages,{maxTokens:2000,timeoutMs:120000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true})
      }catch(e){lastError=e;break}
      const parsed=_diaryParseOutput(raw);
      if(!parsed){
        if(attempt===0){
          lastError=new Error('日记输出无法解析');
          built.messages[1].content+='\n\n【注意】上次输出不符合要求。请只输出一个 JSON 对象，或严格按「标题：…/正文：…/心情：…」的纯文本格式，不要输出任何其他说明。';
          continue
        }
        console.warn('[Diary] output unparseable:',String(raw||'').slice(0,300));
        break
      }
      const dup=await _diaryDuplicateCheck(characterId,parsed.title,parsed.content);
      if(dup&&attempt===0){
        built.messages[1].content+=('\n\n【注意】你刚才写的内容与最近日记太相似（「'+String(dup.title||'')+'」）。请换一个角度、事件或情绪重新写。');
        continue
      }
      const entry=_diaryDefaults({
        characterId:characterId,
        title:String(parsed.title||'').trim(),
        content:String(parsed.content||'').trim(),
        mood:String(parsed.mood||'').trim(),
        diaryType:['daily','weekly','event','emotion'].includes(parsed.diaryType)?parsed.diaryType:diaryType,
        importance:Math.max(0,Math.min(10,parseInt(parsed.importance,10)||5)),
        relatedMemoryIds:Array.isArray(parsed.relatedMemoryIds)?parsed.relatedMemoryIds.slice(0,20):[],
        trigger:opts.trigger||'manual',
        reason:opts.reason||''
      });
      await dbPut(DIARY_STORE,entry);
      const mem=await _diaryWriteMemory(cfg,parsed.memoryCandidate);
      if(mem){entry.relatedMemoryIds=entry.relatedMemoryIds.concat([mem.id]);await dbPut(DIARY_STORE,entry)}
      if(currentPage==='diary')_diaryRenderVault();
      return{ok:true,entry:entry,memory:mem}
    }
    return{ok:false,error:lastError?String(lastError.message||lastError).slice(0,200):'生成失败'}
  }catch(e){console.warn('[Diary] generate failed',String(e&&e.message||e).slice(0,200));return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}
/* 每日 AI planner：判断今天是否值得写日记 */
async function _diaryDailyPlanner(character){
  try{
    const cfg=character,context=await _diaryContext(cfg);
    const today=new Date().toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'});
    const recentDiary=await _diaryRecent(cfg.id,3);
    const recentDiaryText=recentDiary.length?recentDiary.map((e,i)=>(i+1)+'. '+e.date+'「'+(e.title||'')+'」').join('\n'):'（还没有日记）';
    const system='你是「'+(cfg.nickname||cfg.model||'AI')+'」的日记规划者。你只输出严格 JSON，不输出其他文字。';
    const prompt=[
      '【任务】判断今天是否值得写一篇私人日记。',
      '【今天日期】'+today,
      '【角色设定摘要】'+(cfg.systemPrompt||'').slice(0,600),
      '【最近聊天摘要】'+String(context.chatSummary||'（暂无）').slice(0,800),
      '【最近聊天内容】'+((context.recentMessages||[]).slice(-12).map(m=>'- '+(m.role==='user'?'用户':(cfg.nickname||'AI'))+'：'+String(m.content||'').slice(0,400)).join('\n')||'（没有）'),
      '【相关记忆】'+((context.memories||[]).slice(0,6).map(m=>'- '+(m.content||m.summary)).join('\n')||'（没有）'),
      '【最近日记】'+recentDiaryText,
      '【输出格式】只输出 JSON：{"shouldWrite":true/false,"reason":"原因（≤50字）","diaryType":"emotion|event|daily|weekly","importance":1-10}',
      '【规则】1. 今天有值得记录的事（重要对话、新记忆、情绪变化、事件）才 shouldWrite:true。2. 普通平淡的一天返回 false。3. importance<6 时不应写。4. 不要为了写而写。'
    ];
    const raw=await callApiChat(cfg,[{role:'system',content:system},{role:'user',content:prompt.join('\n')}],{maxTokens:300,timeoutMs:60000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true});
    const parsed=_activeParsePlanJson(raw);
    if(parsed&&parsed.shouldWrite===true){
      const importance=Math.max(0,Math.min(10,parseInt(parsed.importance,10)||0));
      if(importance>=6){
        return{shouldWrite:true,diaryType:['emotion','event','daily','weekly'].includes(parsed.diaryType)?parsed.diaryType:'daily',importance:importance,reason:String(parsed.reason||'').slice(0,200)}
      }
    }
    return{shouldWrite:false}
  }catch(e){return{shouldWrite:false}}
}
/* 调度 tick：每周周记 + 每日 planner（浏览器前端，每角色独立水位线防重复） */
async function _diaryTick(){
  if(!db)return;
  try{
    const prefs=_diaryPrefs();
    if(!prefs.enabled)return;
    const now=new Date();
    const todayKey=now.toISOString().slice(0,10);
    const weekKey='w'+now.getFullYear()+'_'+_diaryWeekNumber(now);
    const watermarks=_diaryWatermarks();
    for(const cfg of apiConfigs){
      if(!_ibApiReady(cfg))continue;
      if(prefs.weeklyEnabled&&now.getDay()===prefs.weeklyDay){
        const wm=String(watermarks['wk_'+cfg.id]||'');
        if(wm!==weekKey&&now.getHours()*60+now.getMinutes()>=_diaryHhmm(prefs.weeklyTime)){
          _diarySetWatermark('wk_'+cfg.id,weekKey);
          generateDiaryEntry(cfg.id,{trigger:'weekly',diaryType:'weekly',reason:'每周固定周记'})
        }
      }
      if(prefs.dailyPlannerEnabled){
        const dm=String(watermarks['dl_'+cfg.id]||'');
        if(dm!==todayKey){
          _diarySetWatermark('dl_'+cfg.id,todayKey);/* 先占位防重复，当天失败不重试 */
          const plan=await _diaryDailyPlanner(cfg);
          if(plan.shouldWrite){
            generateDiaryEntry(cfg.id,{trigger:'daily_plan',diaryType:plan.diaryType,reason:plan.reason})
          }
        }
      }
    }
  }catch(e){console.warn('[Diary] tick failed',String(e&&e.message||e).slice(0,200))}
}
/* 特殊事件：首次聊天 / 久别重逢（fire-and-forget，不影响聊天） */
function _diaryMaybeEvent(characterId,userMessage){
  try{
    const prefs=_diaryPrefs();
    if(!prefs.enabled||!prefs.eventEnabled)return;
    if(!characterId)return;
    const cfg=apiConfigs.find(a=>a.id===characterId);
    if(!_ibApiReady(cfg))return;
    setTimeout(async()=>{
      try{
        let msgs=[];try{msgs=await dbGetByIndex('chatMessages','byFriend',characterId)}catch(e){}
        msgs=msgs.sort((a,b)=>(a.timestamp||0)-(b.timestamp||0));
        const userMsgs=msgs.filter(m=>m.role==='user'&&!m.source);
        if(userMsgs.length===1){
          generateDiaryEntry(characterId,{trigger:'first_chat',diaryType:'event',reason:'与用户第一次聊天'});
          return
        }
        const cur=msgs[msgs.length-1],prev=msgs[msgs.length-2];
        if(cur&&prev&&cur.timestamp&&prev.timestamp&&cur.timestamp-prev.timestamp>3*24*3600000){
          generateDiaryEntry(characterId,{trigger:'return_after_gap',diaryType:'event',reason:'久别重逢后重新聊天'})
        }
      }catch(e){}
    },800)
  }catch(e){}
}
/* ── Diary Vault UI ── */
async function _diaryRenderVault(){
  const sel=document.getElementById('diary-character');
  if(sel){
    const cur=sel.value;
    sel.innerHTML='';
    apiConfigs.forEach(a=>{const o=document.createElement('option');o.value=a.id;o.textContent=(a.nickname||a.model||'AI');sel.appendChild(o)});
    if(!apiConfigs.length){const o=document.createElement('option');o.value='';o.textContent='请先在 API 页面添加角色';sel.appendChild(o)}
    if(cur&&apiConfigs.some(a=>a.id===cur))sel.value=cur
  }
  const characterId=sel?sel.value:'';
  const list=document.getElementById('diary-list');if(!list)return;
  let all=[];try{all=await dbGetAll(DIARY_STORE)}catch(e){}
  if(characterId)all=all.filter(e=>e.characterId===characterId);
  all.sort((a,b)=>(b.date||'').localeCompare(a.date||'')||String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  const q=String(document.getElementById('diary-search')?.value||'').trim().toLowerCase();
  if(q)all=all.filter(e=>((e.title||'')+' '+(e.content||'')).toLowerCase().includes(q));
  const stats=document.getElementById('diary-stats'),recentEl=document.getElementById('diary-recent'),updatedEl=document.getElementById('diary-updated');
  if(stats)stats.textContent=all.length+' 篇日记';
  if(recentEl)recentEl.textContent=all.length?(all[0].date+' · 「'+(all[0].title||'无题')+'」'):'还没有日记';
  if(updatedEl)updatedEl.textContent=all.length?new Date(all[0].createdAt||Date.now()).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
  list.innerHTML='';
  if(!all.length){list.innerHTML='<div class="active-empty">还没有日记。点击「让她写一篇日记」开始，或等待自动规划。</div>';return}
  for(const e of all){
    const cfg=apiConfigs.find(a=>a.id===e.characterId)||archivedConfigs.find(a=>a.id===e.characterId);
    const row=document.createElement('div');row.className='diary-entry';
    const head=document.createElement('div');head.className='diary-entry-head';
    const t=document.createElement('div');t.className='diary-entry-title';t.textContent=e.title||'无题';
    const meta=document.createElement('div');meta.className='diary-entry-meta';
    meta.textContent=e.date+' · '+_diaryTypeLabel(e.diaryType)+' · 心情：'+(e.mood||'—')+' · 重要性 '+e.importance+' · '+(cfg?(cfg.nickname||cfg.model||'AI'):'角色已删除');
    head.append(t,meta);
    const body=document.createElement('div');body.className='diary-entry-body';
    String(e.content||'').split('\n').forEach(ln=>{const p=document.createElement('p');p.textContent=ln;body.appendChild(p)});
    const foot=document.createElement('div');foot.className='diary-entry-foot';
    foot.appendChild(document.createTextNode('生成时间：'+new Date(e.createdAt||Date.now()).toLocaleString('zh-CN')+(e.trigger?(' · 来源：'+e.trigger):'')));
    const del=document.createElement('button');del.className='active-mini-btn';del.textContent='删除';del.onclick=()=>_diaryDelete(e.id);
    foot.appendChild(del);
    row.append(head,body,foot);list.appendChild(row)
  }
}
async function _diaryDelete(id){
  if(!confirm('删除这篇日记？'))return;
  await dbDelete(DIARY_STORE,id);
  _diaryRenderVault();toast('日记已删除')
}
function _diaryOpenVault(characterId){
  navTo('diary');
  const sel=document.getElementById('diary-character');
  if(sel&&characterId)sel.value=characterId;
  setTimeout(_diaryRenderVault,120)
}
async function _diaryWriteNow(){
  const id=document.getElementById('diary-character')?.value;
  if(!id){toast('请先选择角色');return}
  toast('正在写日记…');
  const res=await generateDiaryEntry(id,{trigger:'manual',diaryType:'daily',reason:'手动请求'});
  if(res.ok)toast('日记已写好');
  else toast('写日记失败：'+(res.error||'未知错误'))
}
async function _diaryTodayWish(){
  const id=document.getElementById('diary-character')?.value;
  if(!id){toast('请先选择角色');return}
  const cfg=apiConfigs.find(a=>a.id===id);
  if(!_ibApiReady(cfg)){toast('角色 API 配置不完整');return}
  toast('正在思考今天想写什么…');
  const plan=await _diaryDailyPlanner(cfg);
  if(plan.shouldWrite){
    const res=await generateDiaryEntry(id,{trigger:'wish',diaryType:plan.diaryType,reason:plan.reason||'今天想写些什么'});
    if(res.ok)toast('今天写的是：'+(res.entry.title||''));
    else toast('写日记失败：'+(res.error||''))
  }else{
    toast('今天没有特别值得记录的，日记留白。')
  }
}
function _diaryRenderPrefs(){
  const p=_diaryPrefs();
  const chk=(id,v)=>{const el=document.getElementById(id);if(el)el.checked=!!v};
  chk('diary-enabled',p.enabled);chk('diary-weekly',p.weeklyEnabled);chk('diary-daily',p.dailyPlannerEnabled);chk('diary-event',p.eventEnabled);
  const day=document.getElementById('diary-week-day');if(day)day.value=p.weeklyDay;
  const time=document.getElementById('diary-week-time');if(time)time.value=p.weeklyTime
}
function _diarySavePrefs(){
  const chk=(id,d)=>{const el=document.getElementById(id);return el?el.checked:d};
  const val=(id,d)=>{const el=document.getElementById(id);return el?el.value:d};
  const p={enabled:chk('diary-enabled',true),weeklyEnabled:chk('diary-weekly',true),dailyPlannerEnabled:chk('diary-daily',true),eventEnabled:chk('diary-event',true),weeklyDay:Math.max(0,Math.min(6,parseInt(val('diary-week-day','0'),10)||0)),weeklyTime:String(val('diary-week-time','22:00')).slice(0,5)};
  _diaryPrefsSave(p);toast('日记设置已保存');return false
}
function loadDiaryPage(){_diaryRenderPrefs();_diaryRenderVault()}


/* 迁移期双挂载：HTML 与其他脚本仍通过 window 访问。 */
window.DIARY_STORE=DIARY_STORE;
window.DIARY_PREFS_KEY=DIARY_PREFS_KEY;
window.DIARY_SIMILARITY_LIMIT=DIARY_SIMILARITY_LIMIT;
window._diaryPrefs=_diaryPrefs;
window._diaryPrefsSave=_diaryPrefsSave;
window._diaryWatermarks=_diaryWatermarks;
window._diarySetWatermark=_diarySetWatermark;
window._diaryDefaults=_diaryDefaults;
window._diaryTypeLabel=_diaryTypeLabel;
window._diaryWeekNumber=_diaryWeekNumber;
window._diaryHhmm=_diaryHhmm;
window._diaryRecent=_diaryRecent;
window._diaryDuplicateCheck=_diaryDuplicateCheck;
window._diaryContext=_diaryContext;
window.buildDiaryPrompt=buildDiaryPrompt;
window._diaryWriteMemory=_diaryWriteMemory;
window._diaryParseOutput=_diaryParseOutput;
window.generateDiaryEntry=generateDiaryEntry;
window._diaryDailyPlanner=_diaryDailyPlanner;
window._diaryTick=_diaryTick;
window._diaryMaybeEvent=_diaryMaybeEvent;
window._diaryRenderVault=_diaryRenderVault;
window._diaryDelete=_diaryDelete;
window._diaryOpenVault=_diaryOpenVault;
window._diaryWriteNow=_diaryWriteNow;
window._diaryTodayWish=_diaryTodayWish;
window._diaryRenderPrefs=_diaryRenderPrefs;
window._diarySavePrefs=_diarySavePrefs;
window.loadDiaryPage=loadDiaryPage;
NS.expose('active.diary', {
  DIARY_STORE: DIARY_STORE,
  DIARY_PREFS_KEY: DIARY_PREFS_KEY,
  DIARY_SIMILARITY_LIMIT: DIARY_SIMILARITY_LIMIT,
  _diaryPrefs: _diaryPrefs,
  _diaryPrefsSave: _diaryPrefsSave,
  _diaryWatermarks: _diaryWatermarks,
  _diarySetWatermark: _diarySetWatermark,
  _diaryDefaults: _diaryDefaults,
  _diaryTypeLabel: _diaryTypeLabel,
  _diaryWeekNumber: _diaryWeekNumber,
  _diaryHhmm: _diaryHhmm,
  _diaryRecent: _diaryRecent,
  _diaryDuplicateCheck: _diaryDuplicateCheck,
  _diaryContext: _diaryContext,
  buildDiaryPrompt: buildDiaryPrompt,
  _diaryWriteMemory: _diaryWriteMemory,
  _diaryParseOutput: _diaryParseOutput,
  generateDiaryEntry: generateDiaryEntry,
  _diaryDailyPlanner: _diaryDailyPlanner,
  _diaryTick: _diaryTick,
  _diaryMaybeEvent: _diaryMaybeEvent,
  _diaryRenderVault: _diaryRenderVault,
  _diaryDelete: _diaryDelete,
  _diaryOpenVault: _diaryOpenVault,
  _diaryWriteNow: _diaryWriteNow,
  _diaryTodayWish: _diaryTodayWish,
  _diaryRenderPrefs: _diaryRenderPrefs,
  _diarySavePrefs: _diarySavePrefs,
  loadDiaryPage: loadDiaryPage
});
})(window.IB || (window.IB = {}));
