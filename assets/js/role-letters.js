/* AI 朋友圈 · 角色互相写信（AI↔AI 私信）域 — 独立 IIFE + window/IB 双挂载。
   设计（复用，不新造重复架构）：
   · 调度：并入 _activeTick 30s 心跳（与 _momentsTick 同挂点，见 active-diary.js 的
     _roleLettersTick 调用）；
   · 角色上下文：复用 moments 的 _momentsContext（角色设定/关系/最近聊天/动态/Memory/
     朋友动态），不重复取材；
   · 生成：复用 callApiChat + jsonMode 容错（同行 moment 用同款 _activeParsePlanJson）；
   · Memory：写入共用 IndexedDB 'memories' 库（characterId 关联），双方后续可取用；
   · 频控（localStorage）：每角色每天最多 1 封主动信；同一对角色按哈希取 24~72h 冷却，
     保证低频、绝不会变成聊天室；
   · 回信：收到来信后进入待回队列，延迟 1~6h 再评估；由模型决定是否回（可推迟、可
     不回），且不回信会落回"未回复"标记，不强制、不追发；
   · 是否写信由「角色关系 + 近期事件 + 记忆 + 朋友近况」经模型门控决定，非纯随机刷信。
   全部 fail-open：任一生成/入库失败只回退与退避，不影响聊天 / Moments / 日记 / Memory。 */
(function(NS){
'use strict';
const RL_STORE='roleLetters';                                   /* IndexedDB 存储（新增，见 core.js v19） */
const RL_STATE_KEY='ib_role_letters_state_v1';                  /* 每角色 { nextInitAt, lastInitAt, nextReplyAt, lastReplyAt, claim... } */
const RL_PAIR_KEY='ib_role_letters_pair_v1';                    /* 无序角色对 → 最近一次通信时间戳（冷却） */
const RL_REPLYQ_KEY='ib_role_letters_replyq_v1';                /* 每收信角色 → { letterId, dueAt } 待回信队列（同一时刻最多一个） */
const RL_PREFS_KEY='ib_role_letters_prefs_v1';                  /* 总开关 */
/* ── 频控常量 ── */
const RL_INIT_PER_DAY=1;              /* 每角色每天最多主动写 1 封 */
const RL_PAIR_MIN=24*3600000;         /* 同一对角色冷却下界（24h） */
const RL_PAIR_MAX=72*3600000;         /* 上界（72h）→ 实际 = MIN + hash(pair)%(MAX-MIN) */
const RL_INIT_FIRST_MS=[1*3600000,3*3600000];   /* 首次评估（随机 1~3h） */
const RL_INIT_CHECK_MS=[6*3600000,18*3600000];  /* 后续评估间隔（随机 6~18h，即使不写） */
const RL_REPLY_DELAY_MS=[1*3600000,6*3600000];  /* 收到来信 → 回信评估延迟（1~6h，可再推迟） */
const RL_REPLY_PER_DAY=1;             /* 每角色每天最多回 1 封 */
const RL_INIT_MAX_TOKENS=1600;
const RL_REPLY_MAX_TOKENS=1400;
const RL_WELL_TTL=30*86400000;        /* 状态到期清理：30 天 */

/* 防御式读：Moments 域一定先加载（脚本顺序保证），复用其暴露的上下文/亲和度/动态读取。
   角色配置查找自行实现（apiConfigs / archivedConfigs 均为 window 实时引用），头像自包含；
   其余复用的 window 函数：_momentsContext / _momentsPairAffinity / getRoleMoments /
   _activeParsePlanJson / _activeTextSimilarity / callApiChat / _ibApiReady。 */
function _rlApiConfigs(){try{return (typeof window!=='undefined'&&window.apiConfigs)||(typeof apiConfigs!=='undefined'?apiConfigs:[])}catch(e){return[]}}
function _rlArchivedConfigs(){try{return (typeof window!=='undefined'&&window.archivedConfigs)||(typeof archivedConfigs!=='undefined'?archivedConfigs:[])}catch(e){return[]}}
function _rlCfg(id){const s=String(id);const a=_rlApiConfigs();const b=_rlArchivedConfigs();return a.find(x=>String(x.id)===s)||b.find(x=>String(x.id)===s)||null}
const _momName=(cfg)=>cfg?(cfg.nickname||cfg.model||'AI'):'（角色已删除）';
const _momAff=(a,b)=>typeof window._momentsPairAffinity==='function'?window._momentsPairAffinity(a,b):50;
const _parseJson=(raw)=>typeof window._activeParsePlanJson==='function'?window._activeParsePlanJson(raw):null;
const _sim=(a,b)=>typeof window._activeTextSimilarity==='function'?window._activeTextSimilarity(a,b):0;

function _rlHash(s){let h=7;const t=String(s||'');for(let i=0;i<t.length;i++)h=(h*31+t.charCodeAt(i))>>>0;return h}
function _rlRand(ms){return ms[0]+Math.floor(Math.random()*(ms[1]-ms[0]))}

/* ── 偏好 ── */
function _rlPrefs(){
  const d={enabled:true};
  try{const raw=JSON.parse(localStorage.getItem(RL_PREFS_KEY)||'null');if(raw&&typeof raw==='object')d.enabled=raw.enabled!==false}catch(e){}
  return d;
}
function _rlPrefsSave(p){try{const cur=_rlPrefs();localStorage.setItem(RL_PREFS_KEY,JSON.stringify(Object.assign({},cur,p)))}catch(e){}}
function _rlIsEnabled(){return _rlPrefs().enabled}
function _rlSetEnabled(v){_rlPrefsSave({enabled:!!v})}

/* ── 状态（localStorage） ── */
function _rlState(){try{const v=JSON.parse(localStorage.getItem(RL_STATE_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}}
function _rlSet(roleId,patch){try{const s=_rlState();s[String(roleId)]=Object.assign({},s[String(roleId)]||{},patch||{});localStorage.setItem(RL_STATE_KEY,JSON.stringify(s))}catch(e){}}
function _rlPairKey(a,b){return [String(a),String(b)].sort().join('|')}
function _rlPairs(){try{const v=JSON.parse(localStorage.getItem(RL_PAIR_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}}
function _rlPairSet(a,b,ts){try{const p=_rlPairs();p[_rlPairKey(a,b)]=Number(ts)||Date.now();localStorage.setItem(RL_PAIR_KEY,JSON.stringify(p))}catch(e){}}
/* 同一对角色冷却剩余毫秒（无序对；任何一方向通信都会重置冷却） */
function _rlPairCooldownMs(a,b,now){
  const last=Number(_rlPairs()[_rlPairKey(a,b)]||0);
  if(!last)return 0;
  const cd=RL_PAIR_MIN+(_rlHash(_rlPairKey(a,b))%(RL_PAIR_MAX-RL_PAIR_MIN));
  const rem=cd-(now-last);
  return rem>0?rem:0;
}
function _rlReplyQ(){try{const v=JSON.parse(localStorage.getItem(RL_REPLYQ_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}}
function _rlReplyQSave(q){try{localStorage.setItem(RL_REPLYQ_KEY,JSON.stringify(q||{}))}catch(e){}}

/* ── 候选收信人（关系驱动，非随机；受冷却过滤） ── */
function _rlCandidates(fromRoleId,now,limit){
  const out=[];
  (_rlApiConfigs()).forEach(c=>{
    if(!c||String(c.id)===String(fromRoleId))return;
    if(typeof window._ibApiReady!=='function'||!(window._ibApiReady(c)))return;
    if(_rlPairCooldownMs(fromRoleId,c.id,now)>0)return;
    out.push({cfg:c,aff:_momAff(String(fromRoleId),String(c.id))});
  });
  out.sort((a,b)=>b.aff-a.aff);
  return out.slice(0,limit||3);
}
/* 候选朋友近况签名（给模型参考"最近发生了什么"） */
async function _rlFriendSig(roleId){
  try{
    const nm=_momName(_rlCfg(roleId));
    const moments=typeof window.getRoleMoments==='function'?(await window.getRoleMoments(roleId)):[];
    const last=(moments&&moments[0]&&moments[0].content)||'';
    const letters=await dbGetAll(RL_STORE);
    const mine=(letters||[]).filter(l=>String(l.fromRoleId)===String(roleId)||String(l.toRoleId)===String(roleId)).slice(-3);
    let s=nm;
    if(last)s+='（最近动态：「'+String(last).slice(0,60)+'」）';
    if(mine.length)s+='（最近信件：'+mine.map(l=>{const other=String(l.fromRoleId)===String(roleId)?l.toRoleId:l.fromRoleId;return (l.kind==='reply'?'回':'写')+'给'+_momName(_rlCfg(other))}).join('；')+'）';
    return s;
  }catch(e){return _momName(_rlCfg(roleId))}
}

/* ── 生成 Prompts（复用 moments 的上下文；模型门控决定是否写、写给谁、写什么） ── */
function _rlBuildInitPrompt(cfg,context,candidates){
  const characterName=_momName(cfg);
  const userName=(context.user&&context.user.name)||'用户';
  const mems=(context.memories||[]).slice(0,8).map(m=>'- '+(m.title?m.title+'：':'')+(m.content||m.summary)).join('\n')||'（没有可用的长期记忆）';
  const recent=(context.recentMessages||[]).slice(-10).map(m=>'- '+(m.role==='user'?userName:characterName)+'：'+String(m.content||'').slice(0,200)).join('\n')||'（最近没有聊天）';
  const own=(context.recentMoments||[]).slice(0,5).map(m=>'- '+String(m.content||'').slice(0,100)).join('\n')||'（最近没有动态）';
  const others=(context.otherRoleMoments||[]).slice(0,6).map(m=>'- '+_momName(_rlCfg(m.roleId))+'：'+String(m.content||'').slice(0,120)).join('\n')||'（朋友们最近没有公开动态）';
  const cand=candidates.map((c,i)=>'候选 '+(i+1)+'：'+c.sig).join('\n  ');
  const system=String(cfg.systemPrompt||'').slice(0,30000)+'\n\n你是「'+characterName+'」——一个有自己生活的人。你正在考虑给一位朋友写一封信：这不是聊天、也不是朋友圈，而是一封更认真、可以稍长的私人信件。不要解释自己是 AI，不要提及任何内部机制、任务、定时器或注入上下文。';
  const prompt=[
    '【任务】决定此刻是否给某位朋友写一封信；要写则选择写给谁并写出信。输出严格 JSON。',
    '【今天日期与时间】'+new Date().toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'}),
    '【角色设定】'+String(cfg.systemPrompt||'').slice(0,800),
    '【角色与用户的关系】'+(cfg.relationship||'尚未单独设定'),
    '【写信动机】像真实的人那样感受：最近发生了什么（聊天、动态、记忆、朋友动态），有没有一件具体的事，值得认真写封信给某位朋友？信是关于具体的人或事，不是泛泛寒暄或套话。',
    '【相关长期记忆】'+mems,
    '【最近聊天内容】'+recent,
    '【我最近的动态】'+own,
    '【朋友们最近动态】'+others,
    '【可通信的朋友（只有这些能写）】\n  '+cand,
    '【要求】',
    '1. 低频且有分量：只有当真有值得写成信的具体内容时才 write:true；平常无事就 write:false 并在 reason 里简单说明。不要为了"该写信了"硬写。',
    '2. 选人：从【可通信的朋友】候选里挑最相关的一个，把它的编号填到 to（1/2/3）。写信会触发与对方的冷却，别频繁打扰同一位朋友。',
    '3. 信正文 40-300 字，符合你的口吻，像真实私信：可以谈一件具体的事、分享一段经历、回应对方近况、淡淡地表达关心；不肉麻、不套路、不写成聊天回复。',
    '4. 只输出一个 JSON 对象：{"write":true/false,"to":候选编号,"content":"信正文","reason":"不写时说明原因（≤50字）"}。'
  ];
  return {system:system,messages:[{role:'system',content:system},{role:'user',content:prompt.join('\n')}]}
}
function _rlBuildReplyPrompt(cfg,context,letter,senderCfg){
  const characterName=_momName(cfg);
  const senderName=_momName(senderCfg);
  const userName=(context.user&&context.user.name)||'用户';
  const mems=(context.memories||[]).slice(0,6).map(m=>'- '+(m.title?m.title+'：':'')+(m.content||m.summary)).join('\n')||'（没有可用的长期记忆）';
  const recent=(context.recentMessages||[]).slice(-6).map(m=>'- '+(m.role==='user'?userName:characterName)+'：'+String(m.content||'').slice(0,160)).join('\n')||'（最近没有聊天）';
  const system=String(cfg.systemPrompt||'').slice(0,30000)+'\n\n你是「'+characterName+'」。你刚刚收到「'+senderName+'」写来的一封信。不要解释自己是 AI，不要提及任何内部机制或定时器。';
  const prompt=[
    '【任务】决定是否回信；回信则写出信。输出严格 JSON。',
    '【收到的信】来自「'+senderName+'」：\n'+String(letter.content||''),
    '【角色设定】'+String(cfg.systemPrompt||'').slice(0,600),
    '【我的长期记忆】'+mems,
    '【最近聊天内容】'+recent,
    '【要求】',
    '1. 回信低频且可选：你可以推迟（reply:false 即本轮不回，之后也可能不再回）；没想好、或者想回的东西不多，就不回，并在 reason 说明。',
    '2. 若回信：40-250 字，自然、真诚、符合你的口吻，可以对来信内容展开回应；不要敷衍短句套话。',
    '3. 只输出一个 JSON 对象：{"reply":true/false,"content":"回信正文","reason":"不回信时说明原因（≤50字）"}。'
  ];
  return {system:system,messages:[{role:'system',content:system},{role:'user',content:prompt.join('\n')}]}
}

/* ── 生成调用（复用 callApiChat + jsonMode；失败可一提额重试） ── */
async function _rlCall(cfg,built,maxTok){
  if(typeof window.callApiChat!=='function')throw new Error('callApiChat 不可用');
  return await window.callApiChat(cfg,built.messages,{maxTokens:maxTok,timeoutMs:90000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true})
}
async function _rlGenerateInit(cfg,now){
  const context=typeof window._momentsContext==='function'?await window._momentsContext(cfg):{};
  const shortlist=_rlCandidates(cfg.id,now,3);
  if(!shortlist.length)return {write:false,reason:'暂无合适的通信对象'};
  /* 异步补每个候选的近况签名 */
  for(const c of shortlist){try{c.sig=await _rlFriendSig(c.cfg.id)}catch(e){c.sig=_momName(c.cfg)}}
  const built=_rlBuildInitPrompt(cfg,context,shortlist);
  let raw='',lastErr=null;
  for(let attempt=0;attempt<2;attempt++){
    try{raw=await _rlCall(cfg,built,attempt===0?RL_INIT_MAX_TOKENS:Math.min(4000,RL_INIT_MAX_TOKENS*2))}
    catch(e){lastErr=e;break}
    const j=_parseJson(raw);
    if(!j){if(attempt===0){lastErr=new Error('输出无法解析');continue}break}
    if(j.write===false)return {write:false,reason:String(j.reason||'').slice(0,120)};
    if(j.write!==true){if(attempt===0){lastErr=new Error('write 非布尔');continue}break}
    const idx=parseInt(j.to,10);
    const target=shortlist[idx-1]||shortlist[0];
    if(!target)break;
    const content=String(j.content||'').trim();
    if(!content){if(attempt===0){lastErr=new Error('正文为空');continue}break}
    return {write:true,to:String(target.cfg.id),content:content.slice(0,2000)}
  }
  if(lastErr)return {error:String(lastErr.message||lastErr).slice(0,200)};
  return {write:false,reason:'模型未给出有效决定'}
}
async function _rlGenerateReply(recipientId,letter,now){
  const cfg=_rlCfg(recipientId);
  if(!cfg)return null;
  const context=typeof window._momentsContext==='function'?await window._momentsContext(cfg):{};
  const senderCfg=_rlCfg(letter.fromRoleId);
  const built=_rlBuildReplyPrompt(cfg,context,letter,senderCfg);
  let raw='',lastErr=null;
  for(let attempt=0;attempt<2;attempt++){
    try{raw=await _rlCall(cfg,built,attempt===0?RL_REPLY_MAX_TOKENS:Math.min(3600,RL_REPLY_MAX_TOKENS*2))}
    catch(e){lastErr=e;break}
    const j=_parseJson(raw);
    if(!j){if(attempt===0){lastErr=new Error('输出无法解析');continue}break}
    if(j.reply===false)return {reply:false};
    if(j.reply!==true){if(attempt===0){lastErr=new Error('reply 非布尔');continue}break}
    const content=String(j.content||'').trim();
    if(!content){if(attempt===0){lastErr=new Error('正文为空');continue}break}
    return {reply:true,content:content.slice(0,2000)}
  }
  if(lastErr)return {error:String(lastErr.message||lastErr).slice(0,200)};
  return {reply:false}
}

/* ── Memory（写入共用 memories 库，characterId 关联；后续行为可引用） ── */
async function _rlWriteMemory(characterId,content,title){
  try{
    const cc=String(content||'').trim();
    if(!cc)return null;
    const importance=6;/* 信件对双方都是有分量的经历，达到写入阈值 */
    const all=await dbGetAll('memories');
    for(const m of all){
      const text=((m.title||'')+' '+(m.summary||'')+' '+String(m.content||''));
      if(text&&_sim(cc,text)>=0.8)return null
    }
    const cfg=_rlCfg(characterId);
    const mem={id:'mem_rl_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8),
      title:(title||cc.slice(0,24)).slice(0,60),summary:cc.slice(0,80),content:cc,created:Date.now(),
      category:'experience',importance:importance,source:'role_letter',createdBy:'ai',
      createdByName:_momName(cfg),characterId:String(characterId),resolved:false,activationCount:0};
    await dbPut('memories',mem);
    try{if(typeof updateMemDashboard==='function')updateMemDashboard()}catch(e){}
    return mem
  }catch(e){return null}
}

/* ── 落库 ── */
async function _rlStoreLetter(data){
  const id='rletter_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
  const rec=Object.assign({id:id,createdAt:Date.now(),replyStatus:data.kind==='init'?'pending':'none'},data);
  await dbPut(RL_STORE,rec);
  return rec
}

/* ── 调度：主动写信（每角色 1 封/天 + 对偶冷却 + 模型门控） ── */
async function _rlInitStep(cfg,now){
  const roleId=cfg.id;
  const st=_rlState()[String(roleId)]||{};
  const next=Number(st.nextInitAt||0);
  if(!Number.isFinite(next)||next<=0){_rlSet(roleId,{nextInitAt:now+_rlRand(RL_INIT_FIRST_MS)});return}
  if(next>now)return;
  if(Number(st.lastInitAt||0)&&now-Number(st.lastInitAt)<24*3600000){_rlSet(roleId,{nextInitAt:now+60*60000});return}
  if(st.initClaimUntil&&Number(st.initClaimUntil)>now)return;/* 其他标签页已在执行 */
  _rlSet(roleId,{initClaimUntil:now+2*60000});
  let res=null;
  try{res=await _rlGenerateInit(cfg,now)}catch(e){res={error:String(e&&e.message||e).slice(0,200)}}
  if(res&&res.write){
    const toId=String(res.to);
    const toCfg=_rlCfg(toId);
    if(toCfg&&typeof window._ibApiReady==='function'&&(window._ibApiReady(toCfg))){
      const content=String(res.content||'').trim();
      if(content){
        const rec=await _rlStoreLetter({fromRoleId:roleId,toRoleId:toId,content:content,kind:'init',createdAt:now});
        _rlPairSet(roleId,toId,now);
        _rlSet(roleId,{lastInitAt:now});
        _rlWriteMemory(roleId,'我给'+_momName(toCfg)+'写了一封信，其中提到：'+content.slice(0,120),'写给'+_momName(toCfg)+'的信').catch(()=>{});
        _rlWriteMemory(toId,_momName(cfg)+' 给我写了一封信，其中提到：'+content.slice(0,120),_momName(cfg)+'的来信').catch(()=>{});
        _rlQueueReply(rec,now);/* 收信方进入待回信队列（延迟、可选） */
        try{toast(_momName(cfg)+' 给 '+_momName(toCfg)+' 写了一封信')}catch(e){}
      }
    }
  }
  const back=(res&&res.write)?RL_INIT_CHECK_MS[1]:RL_INIT_CHECK_MS[0];
  _rlSet(roleId,{initClaimUntil:0,nextInitAt:now+back+Math.floor(Math.random()*(RL_INIT_CHECK_MS[1]-RL_INIT_CHECK_MS[0]))});
}

/* ── 调度：待回信（延迟评估；模型决定是否回；不回则标记，不再追发） ── */
function _rlQueueReply(rec,now){
  const q=_rlReplyQ();
  q[String(rec.toRoleId)]={letterId:rec.id,dueAt:(now||Date.now())+_rlRand(RL_REPLY_DELAY_MS)};
  _rlReplyQSave(q);
}
async function _rlReplyStep(recipientId,now){
  const q=_rlReplyQ();
  const entry=q[String(recipientId)];
  if(!entry)return;
  if(Number(entry.dueAt||0)>now)return;
  let letter=null;
  try{letter=await dbGet(RL_STORE,String(entry.letterId))}catch(e){letter=null}
  if(!letter){delete q[String(recipientId)];_rlReplyQSave(q);return}
  if(letter.replyStatus==='replied'||letter.replyStatus==='declined'){delete q[String(recipientId)];_rlReplyQSave(q);return}
  const st=_rlState()[String(recipientId)]||{};
  if(Number(st.lastReplyAt||0)&&now-Number(st.lastReplyAt)<24*3600000){entry.dueAt=now+2*3600000;_rlReplyQSave(q);return}
  if(st.replyClaimUntil&&Number(st.replyClaimUntil)>now)return;
  _rlSet(recipientId,{replyClaimUntil:now+2*60000});
  let res=null;
  try{res=await _rlGenerateReply(recipientId,letter,now)}catch(e){res={error:String(e&&e.message||e).slice(0,200)}}
  const answered=!!(res&&res.reply&&String(res.content||'').trim());
  if(answered){
    const content=String(res.content).trim();
    try{
      await _rlStoreLetter({fromRoleId:recipientId,toRoleId:letter.fromRoleId,content:content,kind:'reply',parentId:letter.id,createdAt:now});
      letter.replyStatus='replied';
      await dbPut(RL_STORE,letter);
      _rlPairSet(recipientId,letter.fromRoleId,now);
      const senderCfg=_rlCfg(letter.fromRoleId);
      _rlWriteMemory(recipientId,'我回复了'+_momName(senderCfg)+'的信，其中提到：'+content.slice(0,120),'回复'+_momName(senderCfg)+'的信').catch(()=>{});
      _rlWriteMemory(letter.fromRoleId,_momName(cfgOf(recipientId))+' 回复了我的信，其中提到：'+content.slice(0,120),_momName(cfgOf(recipientId))+'的回复').catch(()=>{});
      try{toast(_momName(cfgOf(recipientId))+' 回复了 '+_momName(senderCfg)+' 的信')}catch(e){}
    }catch(e){}
  }else{
    letter.replyStatus='declined';/* 不回/失败：标记为"未回复"，不再追发 */
    try{await dbPut(RL_STORE,letter)}catch(e){}
  }
  delete q[String(recipientId)];
  _rlReplyQSave(q);
  _rlSet(recipientId,{replyClaimUntil:0,lastReplyAt:answered?now:(Number(st.lastReplyAt||0))});
}
function cfgOf(id){return _rlCfg(id)}

/* ── 主调度（并入 _activeTick 心跳，fail-open） ── */
let _rlTicking=false;
async function _roleLettersTick(){
  if(_rlTicking)return;
  if(typeof db==='undefined'||!db)return;
  _rlTicking=true;
  const now=Date.now();
  try{
    if(!_rlIsEnabled())return;
    const list=_rlApiConfigs();
    for(const cfg of list){
      if(typeof window._ibApiReady!=='function'||!(window._ibApiReady(cfg)))continue;
      try{await _rlInitStep(cfg,now)}catch(e){console.warn('[RoleLetters] init '+String(cfg.id)+'：'+String(e&&e.message||e).slice(0,160))}
      try{await _rlReplyStep(cfg.id,now)}catch(e){console.warn('[RoleLetters] reply '+String(cfg.id)+'：'+String(e&&e.message||e).slice(0,160))}
    }
  }finally{_rlTicking=false}
}

/* ══════════ UI：收信 / 信件详情（风格对齐 Moments：mom-* / net-* / glass-card） ══════════ */
function _rlToggleInbox(){
  const box=document.getElementById('rl-inbox');
  if(!box)return;
  const opening=box.hidden!==false;
  box.hidden=!opening;
  if(opening){
    /* 先让开关立即上屏（给出反馈），下一帧再异步填充，避免同一帧内大 DOM 变更导致掉帧 */
    const l=document.getElementById('rl-inbox-list');
    if(l)l.innerHTML='<div class="mom-state">加载中…</div>';
    setTimeout(function(){_rlRenderInbox()},0);
  }
}
/* ── 可拖动浮层：拖头部（指针捕获），内容区照常滚动；限制在视口内；位置持久化 ── */
const RL_POS_KEY='ib_role_letters_pos_v1';
function _rlSavePos(box){
  try{localStorage.setItem(RL_POS_KEY,JSON.stringify({left:parseInt(box.style.left,10)||0,top:parseInt(box.style.top,10)||0}))}catch(e){}
}
function _rlRestorePos(box){
  try{
    const v=JSON.parse(localStorage.getItem(RL_POS_KEY)||'null');
    if(!v||typeof v!=='object')return;
    const left=Number(v.left),top=Number(v.top);
    if(!Number.isFinite(left)||!Number.isFinite(top)||left<8||top<8)return;
    box.style.right='auto';
    box.style.left=Math.min(left,window.innerWidth-40)+'px';
    box.style.top=Math.min(top,window.innerHeight-40)+'px';
  }catch(e){}
}
function _rlInitInboxDrag(){
  const box=document.getElementById('rl-inbox');
  if(!box)return;
  _rlRestorePos(box);/* 打开面板时恢复上次拖动位置 */
  const head=box.querySelector('.rl-inbox-head');
  if(!head||head._rlDrag)return;
  head._rlDrag=true;
  head.style.cursor='move';head.style.userSelect='none';
  let sx=0,sy=0,bx=0,by=0,dragging=false;
  head.addEventListener('pointerdown',function(e){
    if(e.button!==0)return;
    if(e.target&&e.target.closest&&e.target.closest('button,a,input,textarea,select'))return;/* 不拦截可点元素 */
    dragging=true;sx=e.clientX;sy=e.clientY;
    const r=box.getBoundingClientRect();bx=r.left;by=r.top;
    head.setPointerCapture&&head.setPointerCapture(e.pointerId);
    box.style.right='auto';
    box.classList.add('rl-dragging');
    e.preventDefault();
  });
  head.addEventListener('pointermove',function(e){
    if(!dragging)return;
    let nx=bx+(e.clientX-sx),ny=by+(e.clientY-sy);
    nx=Math.max(8,Math.min(nx,window.innerWidth-box.offsetWidth-8));
    ny=Math.max(8,Math.min(ny,window.innerHeight-box.offsetHeight-8));
    box.style.left=nx+'px';box.style.top=ny+'px';
  });
  function up(e){
    if(!dragging)return;
    dragging=false;
    try{if(head.releasePointerCapture)head.releasePointerCapture(e.pointerId)}catch(_){}
    box.classList.remove('rl-dragging');
    _rlSavePos(box);/* 拖动结束，记住位置 */
  }
  head.addEventListener('pointerup',up);
  head.addEventListener('pointercancel',up);
  head.addEventListener('lostpointercapture',up);
}
function _rlTimeLabel(iso){
  const d=new Date(iso),now=new Date(),pad=n=>String(n).padStart(2,'0');
  if(!isNaN(d.getTime())){
    if(d.toDateString()===now.toDateString())return pad(d.getHours())+':'+pad(d.getMinutes());
    const yest=new Date(now);yest.setDate(now.getDate()-1);
    if(d.toDateString()===yest.toDateString())return'昨天 '+pad(d.getHours())+':'+pad(d.getMinutes());
    return(d.getMonth()+1)+'月'+d.getDate()+'日 '+pad(d.getHours())+':'+pad(d.getMinutes());
  }
  return''
}
/* 自包含头像（纯文本首字占位，风格对齐 *.mom-avatar；
   不加载 base64 大图——避免信箱里大量 <img> 解码与重排造成掉帧） */
function _rlAvatar(cfg,size){
  const d=document.createElement('div');d.className='mom-avatar';
  if(size)d.style.width=size+'px',d.style.height=size+'px';
  d.textContent=String(_momName(cfg)||'?').charAt(0).toUpperCase();
  return d.outerHTML;
}
async function _rlRenderInbox(){
  const box=document.getElementById('rl-inbox-list');
  if(!box)return;
  const all=(await dbGetAll(RL_STORE)).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  const count=document.getElementById('rl-inbox-count');
  if(count)count.textContent=String(all.length)+' 封';
  if(!all.length){box.innerHTML='<div class="mom-state">还没有角色信件。角色们会在有值得说的事时，自然地互相通信。</div>';return}
  box.innerHTML=all.map(function(l){
    const from=_rlCfg(l.fromRoleId),to=_rlCfg(l.toRoleId);
    const fromName=_momName(from),toName=_momName(to);
    const tag=l.kind==='reply'?'回信':'来信';
    const status=(l.kind==='init')?(l.replyStatus==='replied'?'<span class="rl-badge rl-ok">已回</span>':(l.replyStatus==='declined'?'<span class="rl-badge">未回</span>':'<span class="rl-badge rl-pending">待回</span>')):'';
    return '<div class="rl-item" id="rl-'+l.id+'">'
      +'<div class="rl-item-head">'
      +'<div class="rl-persons">'+_rlAvatar(from,26)+'<span class="rl-name">'+esc(fromName)+'</span><span class="rl-arrow">→</span>'+_rlAvatar(to,26)+'<span class="rl-name">'+esc(toName)+'</span></div>'
      +'<span class="rl-tag">'+tag+'</span>'+status
      +'<span class="mom-card-time">'+_rlTimeLabel(l.createdAt)+'</span>'
      +'<button type="button" class="mom-action-btn" onclick="_rlExp(\''+l.id+'\')">详情</button>'
      +'</div>'
      +'<div class="rl-preview" id="rlx-'+l.id+'" hidden>'+esc(String(l.content||''))+'</div>'
      +'</div>';
  }).join('');
}
function _rlExp(id){
  const el=document.getElementById('rlx-'+id);
  if(el)el.hidden=!el.hidden;
}
function _rlRenderSettings(){
  const c=document.getElementById('rl-letter-enabled');
  if(c)c.checked=_rlIsEnabled();
}
function _rlToggleEnabled(){
  const el=document.getElementById('rl-letter-enabled');
  const on=el?el.checked===true:true;
  _rlPrefsSave({enabled:on});
  toast('角色自动写信已'+(on?'开启':'关闭'));
}

/* ── 导出 ── */
window.roleLettersStore=RL_STORE;
window._roleLettersTick=_roleLettersTick;
window._rlIsEnabled=_rlIsEnabled;window._rlSetEnabled=_rlSetEnabled;
window._rlToggleInbox=_rlToggleInbox;window._rlRenderInbox=_rlRenderInbox;
window._rlExp=_rlExp;window._rlRenderSettings=_rlRenderSettings;window._rlToggleEnabled=_rlToggleEnabled;
window._rlStoreLetter=_rlStoreLetter;window._rlQueueReply=_rlQueueReply;window._rlInitInboxDrag=_rlInitInboxDrag;
NS.expose('roleLetters',{
  tick:_roleLettersTick,isEnabled:_rlIsEnabled,setEnabled:_rlSetEnabled,
  toggleInbox:_rlToggleInbox,renderInbox:_rlRenderInbox,exp:_rlExp,
  renderSettings:_rlRenderSettings,toggleEnabled:_rlToggleEnabled,
  storeLetter:_rlStoreLetter,queueReply:_rlQueueReply,initInboxDrag:_rlInitInboxDrag
});
/* 信箱面板在 DOM 中恒存在（脚本位于 body 底部），加载即初始化拖拽 */
try{_rlInitInboxDrag()}catch(e){console.warn('[RoleLetters] init drag '+String(e&&e.message||e).slice(0,80))}
})(window.IB || (window.IB = {}));
