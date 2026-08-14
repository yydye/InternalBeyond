/* CONVERSATION SUMMARY SYSTEM —— 自 communication.js 机械提取（只动位置，不改逻辑；加载于 communication.js 之前）。 */
(function(NS){
/* ===== CONVERSATION SUMMARY SYSTEM ===== */
/* 摘要触发间隔：跟随 AI 读取消息数设置，最少 8 条 */
function _getSummaryTriggerCount(){try{var k=parseInt(document.getElementById('api-read-chat')&&document.getElementById('api-read-chat').value);if(k&&k>=5)return Math.max(8,k);return 10}catch(e){return 10}}
const SUMMARY_TRIGGER_COUNT=10;/* 兜底默认值，实际运行时用 _getSummaryTriggerCount() */
async function getSummarySettings(){
  try{const s=await dbGet('apiSettings','summarySettings');return s||{enabled:false,keepCount:6,welcomeEnabled:false,welcomeInterval:2,musicEnabled:false,summaryApiId:'',summaryWindow:60}}catch(e){return{enabled:false,keepCount:6,welcomeEnabled:false,welcomeInterval:2,musicEnabled:false,summaryApiId:'',summaryWindow:60}}
}
async function saveSummarySettings(){
  const s={id:'summarySettings',
    enabled:!!document.getElementById('api-summary-toggle')?.checked,
    keepCount:parseInt(document.getElementById('api-summary-keep')?.value)||6,
    welcomeEnabled:!!document.getElementById('api-welcome-toggle')?.checked,
    welcomeInterval:parseInt(document.getElementById('api-welcome-interval')?.value)||2,
    musicEnabled:!!document.getElementById('api-music-toggle')?.checked,
    summaryApiId:document.getElementById('api-summary-api')?.value||'',
    summaryWindow:parseInt(document.getElementById('api-summary-window')?.value)||60};
  await dbPut('apiSettings',s);toast('设置已保存');
}
async function loadSummarySettingsUI(){
  const s=await getSummarySettings();
  const t=document.getElementById('api-summary-toggle');if(t)t.checked=!!s.enabled;
  const k=document.getElementById('api-summary-keep');if(k)k.value=String(s.keepCount||6);
  const w=document.getElementById('api-welcome-toggle');if(w)w.checked=!!s.welcomeEnabled;
  const wi=document.getElementById('api-welcome-interval');if(wi)wi.value=String(s.welcomeInterval||2);
  const mu=document.getElementById('api-music-toggle');if(mu)mu.checked=!!s.musicEnabled;
  const sw=document.getElementById('api-summary-window');if(sw)sw.value=String(s.summaryWindow||60);
  /* Populate summary API dropdown */
  const sel=document.getElementById('api-summary-api');
  if(sel){sel.innerHTML='<option value="">跟随对话 API（默认）</option>'+apiConfigs.map(a=>'<option value="'+a.id+'"'+(s.summaryApiId===a.id?' selected':'')+'>'+esc(a.nickname||a.model||'未命名')+'</option>').join('')}
  renderSummaryMgmt();
}
/* --- Summary Management --- */
async function renderSummaryMgmt(){
  const list=document.getElementById('summary-mgmt-list');
  const countEl=document.getElementById('summary-mgmt-count');
  if(!list)return;
  try{
    const all=await dbGetAll('chatSummaries');
    if(countEl)countEl.textContent=all.length?all.length+' 条摘要':'暂无摘要';
    if(!all.length){list.innerHTML='<div class="sum-mgmt-empty">还没有生成过摘要。</div>';return}
    /* 加载群聊列表以识别群聊摘要 */
    let groups=[];try{groups=await loadGroups()}catch(e){}
    list.innerHTML=all.map(s=>{
      let name='';let kind='';
      if(s.friendId&&s.friendId.startsWith('group_')){
        const grp=groups.find(g=>g.id===s.friendId);name=grp?grp.name:'未知群聊';kind='群聊';
      }else{
        const cfg=apiConfigs.find(a=>a.id===s.friendId)||archivedConfigs.find(a=>a.id===s.friendId);name=cfg?((cfg.nickname||cfg.model||'未命名')+(cfg.archived?'（已归档）':'')):'（已删除）';kind='';
      }
      if(s.threadId)kind=kind?kind+' · 频道':'频道';
      const date=s.updated?new Date(s.updated).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
      const charCount=s.summary?s.summary.length:0;
      const author=s.authorName||'未记录';
      return '<div class="glass-card sum-mgmt-card" onclick="toggleSummaryDetail(this)">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;gap:10px">'
        +'<div style="flex:1;min-width:0">'
        +'<div class="sum-mgmt-name">'+esc(name)+(kind?' <span class="sum-mgmt-kind">'+kind+'</span>':'')+'</div>'
        +'<div class="sum-mgmt-meta">'+date+' · '+charCount+' 字 · 撰写: '+esc(author)+'</div>'
        +'</div>'
        +'<span class="sum-mgmt-del" onclick="event.stopPropagation();deleteSingleSummary(\''+s.id+'\')" title="删除此摘要">'
        +'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'
        +'</span></div>'
        +'<div class="summary-detail" style="display:none">'+esc(s.summary||'（空）')+'</div>'
        +'</div>'
    }).join('');
  }catch(e){list.innerHTML=''}
}
function toggleSummaryDetail(el){var d=el.querySelector('.summary-detail');if(d)d.style.display=d.style.display==='none'?'block':'none'}
async function deleteSingleSummary(id){
  if(!confirm('确定删除这条摘要？下次聊天时会自动重新生成。'))return;
  try{await dbDelete('chatSummaries',id);toast('摘要已删除');renderSummaryMgmt()}catch(e){toast('删除失败')}
}
async function getChatSummary(friendId,threadId){
  const key='sum_'+(threadId||friendId);
  try{
    const item=await dbGet('chatSummaries',key);
    if(!item)return null;
    /* 摘要必须与当前封档边界严格一致。旧版本摘要没有 sealTimestamp；
       在存在封档线时一律视为不可信，防止其中夹带封档线之前的内容。 */
    const currentSeal=threadId?0:(await getChatSealTimestamp(friendId));
    const summarySeal=Number(item.sealTimestamp||0);
    if(summarySeal!==Number(currentSeal||0)){
      try{await dbDelete('chatSummaries',key)}catch(e){}
      return null;
    }
    return item;
  }catch(e){return null}
}
async function saveChatSummary(friendId,threadId,summary,coveredUpTo,coveredCount,authorInfo,sealTimestamp){
  const key='sum_'+(threadId||friendId);
  await dbPut('chatSummaries',{id:key,friendId,threadId:threadId||null,summary,coveredUpTo,coveredCount,updated:Date.now(),authorName:authorInfo||'',sealTimestamp:Number(sealTimestamp||0)});
}
async function generateSummary(cfg,prevSummary,newMessages,charLimit,names){
  const SUMMARY_CHAR_LIMIT=charLimit||600;
  const uN=(names&&names.user)||'用户';
  const aN=(names&&names.ai)||'AI';
  const prompt='压缩以下对话为一段摘要。用「'+uN+'」和「'+aN+'」称呼双方。\n'
    +'要求：叙述式，写谁说了什么、事情如何推进。保留关键话题、结论、情感转折、未解决的问题。删除寒暄、重复、已解决的旧话题。\n'
    +'字数上限 '+SUMMARY_CHAR_LIMIT+' 字，必须严格遵守。旧摘要过长时先压缩旧摘要再整合新内容。输出一段完整独立的摘要。\n\n'
    +(prevSummary?'【旧摘要】\n'+prevSummary+'\n\n':'')
    +'【新对话】\n'+newMessages.map(m=>(m.role==='user'?uN:(m.senderName||aN))+'：'+getTextContent(m)).join('\n')+'\n\n直接输出摘要。';
  try{
    const cleanCfg=Object.assign({},cfg,{systemPrompt:''});
    const result=await callApi(cleanCfg,prompt);
    if(!result){toast('摘要生成失败：未收到有效回复');return null}
    let text=result.trim();
    if(text.length>SUMMARY_CHAR_LIMIT+100)text=text.slice(0,SUMMARY_CHAR_LIMIT)+'…';
    return text;
  }catch(e){toast('摘要生成失败：'+(e.message||'API 无法连接'));return null}
}
const SUMMARY_WINDOW_LIMITS={60:600,100:800};/* 窗口 → 摘要字数上限 */
let _summarizing=false;
async function maybeSummarize(cfg,friendId,threadId,allMsgs){
  if(_summarizing)return null;_summarizing=true;
  try{return await _doSummarize(cfg,friendId,threadId,allMsgs)}finally{_summarizing=false}
}
async function _doSummarize(cfg,friendId,threadId,allMsgs){
  const ss=await getSummarySettings();if(!ss.enabled)return null;
  /* 防御性地在摘要函数内部再次应用封档线，避免调用方遗漏过滤。 */
  const summarySealTs=threadId?0:(await getChatSealTimestamp(friendId));
  allMsgs=filterSealed(allMsgs||[],summarySealTs);
  const existing=await getChatSummary(friendId,threadId);
  const keepCount=ss.keepCount||6;
  const maxWindow=ss.summaryWindow||60;
  const charLimit=SUMMARY_WINDOW_LIMITS[maxWindow]||600;
  /* 只关注最近 maxWindow+keepCount 条消息，更早的不再压缩 */
  const windowStart=Math.max(0,allMsgs.length-maxWindow-keepCount);
  const windowMsgs=allMsgs.slice(windowStart);
  /* 用时间戳而非计数来定位已覆盖范围（防止删消息导致错位） */
  let coveredInWindow=0;
  if(existing&&existing.coveredUpTo){
    for(let i=0;i<windowMsgs.length;i++){if(windowMsgs[i].timestamp<=existing.coveredUpTo)coveredInWindow=i+1;else break}
  }
  const uncovered=windowMsgs.length-coveredInWindow;
  if(uncovered<_getSummaryTriggerCount())return existing?existing.summary:null;
  const toSummarize=windowMsgs.slice(coveredInWindow,windowMsgs.length-keepCount);
  if(toSummarize.length<2)return existing?existing.summary:null;
  /* 如果配置了专用摘要 API，优先使用 */
  let sumCfg=cfg;
  if(ss.summaryApiId){const sc=apiConfigs.find(a=>a.id===ss.summaryApiId);if(_ibApiReady(sc))sumCfg=sc}
  toast('正在整理对话记录…');
  /* AI 称呼优先取好友本名（cfg 在好友 API 失效时可能被换成摘要兜底 API，名字会不对） */
  const _sumFriendCfg=(!String(friendId).startsWith('group_')&&typeof apiConfigs!=='undefined')?apiConfigs.find(a=>a.id===friendId):null;
  const _sumAiName=(_sumFriendCfg&&(_sumFriendCfg.nickname||_sumFriendCfg.model))||(cfg&&(cfg.nickname||cfg.model))||'AI';
  /* 摘要分段压缩：如果旧摘要已超过字符上限的 80%，先压缩旧摘要再整合新内容 */
  let _prevSum=existing?existing.summary:null;
  if(_prevSum&&_prevSum.length>charLimit*0.8){
    toast('正在压缩旧摘要…');
    const _compressed=await generateSummary(sumCfg,null,[{role:'user',content:'以下是需要压缩的旧摘要：\n'+_prevSum}],Math.floor(charLimit*0.5),{user:_sumUserName,ai:_sumAiName});
    if(_compressed)_prevSum=_compressed;
  }
  const newSummary=await generateSummary(sumCfg,_prevSum,toSummarize,charLimit,{user:_sumUserName,ai:_sumAiName});
  if(newSummary){
    /* 摘要 API 请求期间若封档线发生变化，结果基于旧窗口，禁止落库。 */
    const latestSealTs=threadId?0:(await getChatSealTimestamp(friendId));
    if(Number(latestSealTs||0)!==Number(summarySealTs||0))return null;
    const authorLabel=(sumCfg.nickname||sumCfg.model||'AI')+(sumCfg.id!==cfg.id?' (摘要专用)':'');
    await saveChatSummary(friendId,threadId,newSummary,toSummarize[toSummarize.length-1].timestamp,allMsgs.length-keepCount,authorLabel,summarySealTs);
    return newSummary;
  }
  return existing?existing.summary:null;
}

/* ===== AUTO SUMMARY ON CHAT OPEN ===== */
/* 打开聊天时自动检查并生成摘要（修复：仅在发送消息后才触发摘要的BUG） */
async function autoSummaryOnOpen(friendId,threadId){
  try{
    const ss=await getSummarySettings();if(!ss.enabled)return;
    /* 加载该好友/话题的所有消息（封档线过滤） */
    const _sumSealTs=threadId?0:(await getChatSealTimestamp(friendId));
    const allMsgs=filterSealed((await dbGetByIndex('chatMessages','byFriend',friendId))
      .filter(m=>threadId?m.threadId===threadId:!m.threadId)
      .sort((a,b)=>a.timestamp-b.timestamp),_sumSealTs);
    if(allMsgs.length<_getSummaryTriggerCount())return;/* 消息太少，不需要摘要 */
    /* 快速预检：是否真的有足够多未覆盖的消息（避免不必要的API调用） */
    const existing=await getChatSummary(friendId,threadId);
    const keepCount=ss.keepCount||6;
    const maxWindow=ss.summaryWindow||60;
    const windowStart=Math.max(0,allMsgs.length-maxWindow-keepCount);
    const windowMsgs=allMsgs.slice(windowStart);
    let coveredInWindow=0;
    if(existing&&existing.coveredUpTo){
      for(let i=0;i<windowMsgs.length;i++){if(windowMsgs[i].timestamp<=existing.coveredUpTo)coveredInWindow=i+1;else break}
    }
    if(windowMsgs.length-coveredInWindow<_getSummaryTriggerCount())return;/* 未覆盖消息不够，跳过 */
    /* 确定 API 配置：1v1用好友API，群聊用第一个成员API */
    let cfg;
    if(friendId.startsWith('group_')){
      const groups=await loadGroups();
      const group=groups.find(g=>g.id===friendId);
      if(group)cfg=pickGroupUtilityCfg(group);/* 静默模式：摘要优先由非静默成员执笔 */
    }else{
      cfg=apiConfigs.find(a=>a.id===friendId);
    }
    /* 如果聊天API无效，尝试用摘要专用API */
    if(!_ibApiReady(cfg)){
      if(ss.summaryApiId){const sc=apiConfigs.find(a=>a.id===ss.summaryApiId);if(_ibApiReady(sc))cfg=sc}
    }
    if(!_ibApiReady(cfg))return;
    await maybeSummarize(cfg,friendId,threadId,allMsgs);
  }catch(e){/* 静默失败，不阻塞聊天加载 */}
}

/* ---- 双挂载：发送路径与 social.js 的运行时调用仍经 window 访问；IB.chat.summary 登记导出 ---- */
function ibSummaryLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._getSummaryTriggerCount=_getSummaryTriggerCount;
window.getSummarySettings=getSummarySettings;
window.saveSummarySettings=saveSummarySettings;
window.loadSummarySettingsUI=loadSummarySettingsUI;
window.renderSummaryMgmt=renderSummaryMgmt;
window.toggleSummaryDetail=toggleSummaryDetail;
window.deleteSingleSummary=deleteSingleSummary;
window.getChatSummary=getChatSummary;
window.saveChatSummary=saveChatSummary;
window.generateSummary=generateSummary;
window.maybeSummarize=maybeSummarize;
window._doSummarize=_doSummarize;
window.autoSummaryOnOpen=autoSummaryOnOpen;
window.SUMMARY_TRIGGER_COUNT=SUMMARY_TRIGGER_COUNT;
window.SUMMARY_WINDOW_LIMITS=SUMMARY_WINDOW_LIMITS;
ibSummaryLive('_summarizing', function(){return _summarizing}, function(v){_summarizing=v});
NS.expose('chat.summary', {
  _getSummaryTriggerCount: _getSummaryTriggerCount,
  getSummarySettings: getSummarySettings,
  saveSummarySettings: saveSummarySettings,
  loadSummarySettingsUI: loadSummarySettingsUI,
  renderSummaryMgmt: renderSummaryMgmt,
  toggleSummaryDetail: toggleSummaryDetail,
  deleteSingleSummary: deleteSingleSummary,
  getChatSummary: getChatSummary,
  saveChatSummary: saveChatSummary,
  generateSummary: generateSummary,
  maybeSummarize: maybeSummarize,
  _doSummarize: _doSummarize,
  autoSummaryOnOpen: autoSummaryOnOpen,
  SUMMARY_TRIGGER_COUNT: SUMMARY_TRIGGER_COUNT,
  SUMMARY_WINDOW_LIMITS: SUMMARY_WINDOW_LIMITS,
  _summarizing: _summarizing,
});
})(window.IB || (window.IB = {}));
