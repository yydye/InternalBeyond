/* AUTO MEMORY */
/* IB 命名空间迁移：auto-memory 域（AI 自主档案：写入标签协议 / 注入块 / 审批 UI / 展区 / 条目 CRUD / 按天记录）自 memory.js 机械提取（只动位置，不改逻辑）。 */
(function(NS){
/* ══════════ AUTO MEMORY ══════════
   AI 自主维护的长期用户档案（区别于下方"记忆库"：档案式 vs 碎片式）。
   写入走标签协议（与 ws_ops 同构，全供应商通用、零额外请求）；注入分 system 稳定块 + 尾部语义浮现块，
   稳定块前置以配合提示缓存。分类/写入门槛/质量标准由 Anthropic 客户端 memory 导出样本反推而来。 */
const AM_CATS={work_context:'Work',personal_context:'Personal',top_of_mind:'Top of mind',brief_history:'History',long_term_background:'Background',user_instructions:'Instructions'};
const AM_PRIOS=['always','normal','low'];
/* Understanding 证据独立性：两条记忆 content 的 _activeTextSimilarity ≥ 此阈值即视为同一事实，不重复计数。
   注意：_activeTextSimilarity 是字符 bigram Jaccard，对中文"近字面重复"（score≥0.5）可靠，
   对"完全改写式释义"不敏感（score 可低至 0.2）——阈值 0.5 只拦截近字面重复，不做语义释义判等。 */
const U_EVIDENCE_SIM_THRESHOLD=0.5;
function amEnabled(cfg){return !!(cfg&&cfg.autoMem)}
function _amUserName(){try{return (typeof _cachedUserName==='string'&&_cachedUserName)||'用户'}catch(e){return '用户'}}
function _amNewId(){return 'am_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*46656).toString(36)}
async function amGetEntries(friendId){try{const l=await dbGetByIndex('autoMemory','byFriend',friendId);return l.sort((a,b)=>(a.created||0)-(b.created||0))}catch(e){return[]}}
function _amInstrBlock(cfg){
  const u=_amUserName();
  return '【记忆系统】\n'
  +'你可以维护一份关于'+u+'的长期记忆档案。在回复正文中插入以下标签即可操作（系统会自动拦截执行，标签本身不会显示给对方）：\n'
  +'<mem_create category="分类" priority="优先级">{"content":"记忆内容","confidence":0,"reasons":["原因1","原因2"]}</mem_create>\n'
  +'<mem_update id="条目id">{"content":"修改后的完整内容","confidence":0,"reasons":["为什么应更新"]}</mem_update>\n'
  +'<mem_delete id="条目id">{"confidence":0,"reasons":["为什么应删除"]}</mem_delete>\n'
  +'分类：work_context｜personal_context｜top_of_mind（近期关注，过时即更新）｜brief_history｜long_term_background（仅限反复呈现的模式）｜user_instructions（仅限对方的明确指令）。\n'
  +'优先级：always（核心事实，全档≤3条）｜normal｜low（仅相关时浮现）。\n'
  +'每个标签内部必须是合法 JSON，不要使用 Markdown。confidence 是 0-100 整数；reasons 是最多 3 条简短原因。\n'
  +'判断 confidence 时必须结合：用户是否主动明确表达（最高权重）、信息是否反复出现、是否会影响未来互动，以及是否只是临时事件、玩笑或一时情绪。不要随机给分。\n'
  +'写入原则：提炼而非转录，1~3句独立可读。不写闲聊、不稳定的情绪表态、重复信息。每轮至多3次操作，多数对话无需操作。\n'
  +'档案对'+u+'完全可见且可编辑。遇到过时记忆时自行修正或删除。';}
function _amFmtEntry(e,withId){return '['+(e.category||'personal_context')+']'+(withId?' (id:'+e.id+')':'')+' '+(e.content||'')}
function _amScore(content,keywords){if(!keywords||!keywords.length)return 0;const low=String(content||'').toLowerCase();let s=0;keywords.forEach(k=>{if(k&&low.includes(String(k).toLowerCase()))s++});return s}
/* 注入构建：sys=纯指令格式（会话内稳定，利于缓存前缀命中）；tail=全部条目（always+浮现，挂末条用户消息） */
function _amRecordOnlyBlock(cfg){
  const u=_amUserName();
  return '【记忆系统 · 静默模式】\n'
  +'你可以为'+u+'维护长期记忆档案。当前为静默模式：不注入已有档案。\n'
  +'仅当'+u+'明确要求你记住某事时，才使用以下标签写入（系统拦截执行，对方可见卡片通知）：\n'
  +'<mem_create category="分类" priority="优先级">{"content":"记忆内容","confidence":0,"reasons":["为什么值得长期保存"]}</mem_create>\n'
  +'分类：work_context｜personal_context｜top_of_mind｜brief_history｜long_term_background｜user_instructions\n'
  +'优先级：always｜normal｜low\n'
  +'标签内部必须是合法 JSON。confidence 为 0-100 整数，reasons 最多 3 条；结合主动表达、重复出现、未来影响与一次性特征判断，不要随机给分。\n'
  +'未收到明确指示时不执行任何记忆操作。';
}
async function amBuildInject(cfg,queryText){
  const out={sys:'',tail:''};
  if(!amEnabled(cfg))return out;
  /* 缓存修复：昵称异步加载竞态——打开页面后秒发首条消息时 _cached */
  if(!_cachedUserName){try{const _ab=await dbGet('about','main');if(_ab&&_ab.name)_cachedUserName=_ab.name}catch(e){}}
  if(cfg.amRecordOnly){out.sys=_amRecordOnlyBlock(cfg);return out}
  const entries=await amGetEntries(cfg.id);
  /* sys：仅放指令格式（会话内不变，可被缓存） */
  out.sys=_amInstrBlock(cfg);
  if(!entries.length){out.tail='【记忆档案（共 0 条，勿向对方复述此段）】\n（目前为空）';return out}/* 缓存修复：空档案提示移至 tail——原先拼在 sys 末尾，首条记忆写入时 sys 字节变化会触发一次全量缓存重建 */
  const mode=cfg.autoMemMode||'hybrid';
  const budget=Math.max(300,parseInt(cfg.autoMemBudget)||1200);
  const always=entries.filter(e=>e.priority==='always');
  const rest=entries.filter(e=>e.priority!=='always');
  /* tail：全部条目（always 常驻 + 其余按语义浮现），放在末条用户消息以保持 system 稳定 */
  let tailBlock='【记忆档案（共 '+entries.length+' 条，勿向对方复述此段）】';
  always.forEach(e=>{tailBlock+='\n'+_amFmtEntry(e,true)});
  if(mode==='full'){rest.forEach(e=>{tailBlock+='\n'+_amFmtEntry(e,true)});out.tail=tailBlock;return out}
  let kws=[];try{kws=_extractKeywords(String(queryText||''))}catch(e){}
  const scored=rest.map(e=>({e,s:_amScore((e.content||'')+' '+(e.category||''),kws)}));
  scored.sort((a,b)=>(b.s-a.s)||((b.e.updated||b.e.created||0)-(a.e.updated||a.e.created||0)));
  let used=0;
  for(const it of scored){
    if(it.e.priority==='low'&&it.s<=0)continue;
    if((cfg.autoMemMode||'hybrid')==='retrieval'&&it.s<=0&&used>0)break;
    const line=_amFmtEntry(it.e,true);
    if(used+line.length+1>budget)break;
    tailBlock+=(tailBlock?'\n':'')+line;used+=line.length+1;
  }
  out.tail=tailBlock;
  return out;
}
/* ── 标签解析：从完整回复中截取 mem_* 指令并清除 ── */
function _parseMemOps(text){
  const ops=[];if(!text)return{clean:text,ops};
  const re=/<mem_(create|update|delete)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mem_\1\s*>)/gi;
  const clean=text.replace(re,function(_m,kind,attrStr,body){
    const attrs={};String(attrStr||'').replace(/(\w+)\s*=\s*"([^"]*)"/g,function(__,k,v){attrs[k]=v;return''});
    ops.push({kind:kind.toLowerCase(),attrs,body:String(body||'').trim()});
    return '';
  });
  let c=clean.replace(/\n{3,}/g,'\n\n');
  /* 流中断残缺标签：末尾悬空且无闭合的 <mem_ 片段整段剪除（<900字符防误伤长正文） */
  const _d=c.toLowerCase().lastIndexOf('<mem_');
  if(_d!==-1){const _t=c.slice(_d);if(_t.length<900&&!/<\/mem_(create|update|delete)\s*>/i.test(_t)&&!/^<mem_delete\b[^>]*\/>/i.test(_t)){c=c.slice(0,_d).replace(/\s+$/,'')}}
  return {clean:c,ops};
}
function _memoryJsonObject(text){
  let s=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  try{return JSON.parse(s)}catch(e){}
  const a=s.indexOf('{'),b=s.lastIndexOf('}');
  if(a!==-1&&b>a){try{return JSON.parse(s.slice(a,b+1))}catch(e){}}
  return null;
}
function _memoryReasons(v){
  if(typeof v==='string')v=v.split(/\n|[；;]/);
  if(!Array.isArray(v))return[];
  return v.map(x=>String(x||'').replace(/^[\s✓✔•\-]+/,'').trim()).filter(Boolean).slice(0,3);
}
function _memoryScore(v,fallback){
  const n=parseInt(v,10);return Number.isFinite(n)?Math.max(0,Math.min(100,n)):fallback;
}
function _autoMemCandidatePayload(op){
  const obj=_memoryJsonObject(op&&op.body);
  return{
    content:obj&&typeof obj.content==='string'?obj.content.trim():String(op&&op.body||'').trim(),
    confidence:_memoryScore(obj&&obj.confidence,null),
    reasons:_memoryReasons(obj&&obj.reasons)
  };
}
async function _memoryRepeatCount(content,targetStore,cfg,excludeId){
  try{
    const entries=targetStore==='autoMemory'?await amGetEntries(cfg.id):await dbGetAll('memories');
    const kws=_extractKeywords(String(content||'')).slice(0,90);
    if(!kws.length)return 0;
    const threshold=Math.max(2,Math.ceil(kws.length*.09));
    let count=0;
    entries.forEach(function(e){
      if(!e||e.id===excludeId)return;
      const text=((e.title||'')+' '+(e.summary||'')+' '+(e.content||''));
      if(_amScore(text,kws)>=threshold)count++;
    });
    return Math.min(5,count);
  }catch(e){return 0}
}
/* Understanding 证据独立性：统计 evidenceIds 中语义不同的记忆条数。
   仅信任 memories store；近重复（_activeTextSimilarity ≥ U_EVIDENCE_SIM_THRESHOLD）算同一事实。 */
async function _distinctEvidenceCount(evidenceIds,cfg){
  try{
    if(!Array.isArray(evidenceIds)||!evidenceIds.length)return 0;
    const all=await dbGetAll('memories');
    const kindOf=m=>m&&m.kind;
    const texts=evidenceIds.map(id=>{
      const m=all.find(x=>x&&x.id===id);/* evidence 只能指向 memories */
      return m?String((m.title||'')+' '+(m.content||'')+' '+(m.summary||'')).toLowerCase():'';
    }).filter(Boolean);
    if(!texts.length)return 0;
    const sim=(typeof window._activeTextSimilarity==='function')?window._activeTextSimilarity:(function(a,b){return 0});
    /* 贪心分组：每遇一条与已收组内任何一条 ≥ 阈值 → 归并（同一事实） */
    const groups=[];
    for(const t of texts){
      let merged=false;
      for(const g of groups){if(sim(t,g.text)>=U_EVIDENCE_SIM_THRESHOLD){g.pool.push(t);g.text=t;merged=true;break}}
      if(!merged)groups.push({text:t,pool:[t]});
    }
    return groups.length;
  }catch(e){return Math.max(0,(evidenceIds||[]).length)}
}
/* 文学化自我感慨 / 自我观察 判定（供 create 硬拒 + 存量审计共用）。
   返回 {lyric, personReflect}，供调用方结合 explicit/future/repeats/temporary 决策。 */
function _memoryLyricFlags(text){
  const ev=String(text||'').toLowerCase();
  const lyric=/(珍惜|感悟|感慨|领悟|重新评估|恒久|永恒|静谧|宁静|温柔|治愈|芬芳|夜空|星河|月光|岁月|时光|生命的意义|看透|释怀|释然|欣慰|心绪|思绪|触动|共鸣|仿佛|宛如|像是|或许人生|也许自己|一种特别的|属于我们的)/i.test(ev);
  const personReflect=/(我|自己|彼此|我们)。{0,12}(的|那些|此刻|这般|仿佛)/i.test(ev);
  return {lyric:lyric,personReflect:personReflect};
}
/* 模型判断 + 本地证据校准：不信任随机分值，以主动表达、历史重复、未来影响与一次性特征共同定标。 */
async function _calibrateMemoryCandidate(input){
  const content=String(input.content||''),reasonText=_memoryReasons(input.reasons).join(' ');
  const evidence=(content+' '+reasonText).toLowerCase();
  const explicit=/(主动|明确|亲口|直接表达|反复强调|要求记住|偏好|喜欢|习惯|身份|职业|称呼|i prefer|i like|remember that)/i.test(evidence);
  const future=/(未来|长期|偏好|习惯|身份|职业|称呼|沟通方式|交互|推荐|体验|指令|边界|目标|工作流|workflow|preference|habit|identity)/i.test(evidence);
  const temporary=/(仅这次|一次性|临时|暂时|今天|今晚|刚刚|玩笑|随口|当前情绪|一时|马上|待会|temporary|just this once|joke)/i.test(evidence);
  const correction=/(更正|纠正|已经改变|不再|过时|更新为|应改为|错误|撤回|忘记|删除|obsolete|outdated|incorrect)/i.test(evidence);
  /* Understanding 专属（operation==='understanding'）：人格定性 / 心理类 越界拒止 */
  const _personality=/(她|他|你|TA|它)?\s*(就是|本质上是|天生是|一直是).{0,10}(型人|的人|性格|人格)|(她|他|你|TA).{0,6}是个.{0,8}(焦虑|抑郁|内向|外向|自恋|偏执|依赖型|回避型)|intrinsically|is by nature/i.test(evidence);
  const _psych=/(抑郁|抑郁症|焦虑症|双相|人格障碍|自恋型|边缘型|创伤后应激|ptsd|惊恐障碍)/i.test(evidence);
  const repeats=await _memoryRepeatCount(content,input.targetStore,input.cfg,input.excludeId);
  /* Understanding 前置否决：证据不足(单源) / 人格定性推断 / 心理类推断（仅 user 陈述放行） */
  if(input.operation==='understanding'){
    const basis=_memoryReasons(input.basis)[0]||input.basis||'ai_guess';
    const evidenceIds=Array.isArray(input.evidenceIds)?input.evidenceIds:(input.evidenceIds?[input.evidenceIds]:[]);
    /* 心理类：仅 user_stated / user_corroborated 放行；ai_inference / ai_guess 一律拒 */
    if(_psych&&(basis==='ai_inference'||basis==='ai_guess'))return{confidence:0,reasons:['心理健康类理解仅允许用户自述/旁证，禁止AI推断'],repeatCount:repeats,rejected:'psych-inference'};
    /* 人格定性：ai_inference 且 repeats<2 → 拒（去定性化） */
    if(_personality&&basis==='ai_inference'&&repeats<2)return{confidence:0,reasons:['人格定性推断需≥2次独立证据，当前证据不足'],repeatCount:repeats,rejected:'personality-inference'};
    /* 证据≥2 独立来源校验（非用户自述时强制）：只数语义不同的 evidence，
       近重复（_activeTextSimilarity≥阈值）计为同一事实 → 不凑数。 */
    if(basis!=='user_stated'){
      const distinct=await _distinctEvidenceCount(evidenceIds,input.cfg);
      if(distinct<2)return{confidence:0,reasons:['理解需≥2条语义独立的记忆支撑（近重复证据不重复计数）'],repeatCount:repeats,rejected:'insufficient-evidence',distinctEvidence:distinct};
    }
  }
  /* ── 普通记忆 create 硬拒："文学化自我感慨 / 无未来价值的观察性评论" ──
     understanding 已有同类硬拒止，但 operation==='create'（普通记忆生成）此前只做
     软扣分（temporary），导致 AI 角色持续写出"珍惜平凡清晨""对躺平重新评估"这类
     自我感慨式记忆。此处对 AI 生成（targetStore=memories 且非用户手记）增加硬拒：
     命中文学感慨 / 观察性抒情 且 无 explicit 事实 / 无 future 价值 且 无历史重复
     → 直接 reject，不进入审批弹窗（不污染记忆库 + 不再消耗用户审批注意力）。
     绝不误伤用户手动创建的、以及带明确事实/偏好/身份/目标/重复出现的信息。 */
  /* 文学化自我感慨 / 自我观察 判定（供 create 硬拒 + 存量审计共用）。
     返回 {lyric, personReflect}，供调用方结合 explicit/future/repeats/temporary 决策。 */
  if(input.operation==='create'&&input.targetStore==='memories'&&!(input.createdByUser)){
    const _fl=_memoryLyricFlags(evidence);
    const _selfFulfilling=!explicit&&!future&&repeats<1;
    if(_fl.lyric&&_selfFulfilling&&!temporary){
      return{confidence:0,reasons:['这条记忆属于文学化自我感慨/观察性抒情，缺乏可作为长期事实的明确用户表达、未来价值或重复证据，已拒绝写入'],repeatCount:repeats,rejected:'lyrical-musing'};
    }
    if(_fl.personReflect&&_selfFulfilling){
      return{confidence:0,reasons:['这条记忆更像角色的自我观察而非关于用户的长期事实，已拒绝写入'],repeatCount:repeats,rejected:'self-reflective'};
    }
  }
  let heuristic=35;
  if(explicit)heuristic+=30;
  heuristic+=Math.min(24,repeats*8);
  if(future)heuristic+=18;
  if(input.category==='user_instructions'||input.category==='long_term_background')heuristic+=8;
  if(input.priority==='always')heuristic+=7;
  if(temporary)heuristic-=25;
  if(input.operation==='update')heuristic+=correction?14:-3;
  if(input.operation==='delete')heuristic+=correction?18:-12;
  if(!explicit&&!future&&!repeats)heuristic-=8;
  heuristic=_memoryScore(heuristic,50);
  const model=_memoryScore(input.confidence,null);
  const confidence=model==null?heuristic:Math.round(model*.55+heuristic*.45);
  const reasons=_memoryReasons(input.reasons);
  function addReason(s){if(reasons.length<3&&!reasons.includes(s))reasons.push(s)}
  if(explicit)addReason('用户主动或明确表达了这项信息');
  if(repeats)addReason('相关信息在历史记忆中重复出现 '+repeats+' 次');
  if(future)addReason('这会影响未来的互动或个性化回应');
  if(temporary)addReason('内容可能只适用于当前情境，可靠度已下调');
  if(input.operation==='update'&&correction)addReason('现有记忆可能已经过时，需要校正');
  if(input.operation==='delete'&&correction)addReason('现有记忆可能已失效或被明确撤回');
  if(!reasons.length)addReason(input.operation==='delete'?'AI 认为现有记忆可能不再适用':'AI 认为这项信息具有后续参考价值');
  /* Understanding：conviction 按 basis 上限封顶（user_stated 全高；ai推断/猜测逐级降） */
  let _conv=confidence;
  let _unDistinct=null;/* 仅 understanding：记录语义不同的证据条数（诊断/测试用，放行时为实际值） */
  if(input.operation==='understanding'){
    const basis=_memoryReasons(input.basis)[0]||input.basis||'ai_guess';
    const cap=basis==='user_stated'?100:(basis==='user_corroborated'?85:(basis==='ai_inference'?65:40));
    _conv=Math.min(_conv,cap);
    /* 复用已计算或补算一次 distinctEvidence（放行路径供测试/审计观测） */
    if(input.distinctEvidence!=null)_unDistinct=Number(input.distinctEvidence);
    else if(Array.isArray(input.evidenceIds)){try{_unDistinct=await _distinctEvidenceCount(input.evidenceIds,input.cfg)}catch(e){_unDistinct=input.evidenceIds.length}}
  }
  return{confidence:_memoryScore(_conv,heuristic),reasons:reasons.slice(0,3),repeatCount:repeats,distinctEvidence:_unDistinct};
}
/* ── Memory Approval：所有 AI 发起的长期记忆变更先成为内存候选 ──
   pending 不写入 IndexedDB；刷新页面即自然丢弃。队列保证同一轮最多 3 个操作逐个确认。 */
var _memoryApprovalQueue=[],_memoryApprovalActive=null;
function requestMemoryApproval(candidate){
  candidate=Object.assign({id:'map_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*46656).toString(36),status:'pending',operation:'create',targetStore:'memories',characterName:'AI',content:'',oldContent:'',source:'',confidence:0,reasons:[]},candidate||{});
  candidate.confidence=_memoryScore(candidate.confidence,0);
  candidate.reasons=_memoryReasons(candidate.reasons);
  return new Promise(function(resolve){
    candidate._resolve=resolve;
    _memoryApprovalQueue.push(candidate);
    _showNextMemoryApproval();
  });
}
function _showNextMemoryApproval(){
  if(_memoryApprovalActive||!_memoryApprovalQueue.length)return;
  const c=_memoryApprovalActive=_memoryApprovalQueue.shift();
  const overlay=document.getElementById('mem-approval-overlay');
  if(!overlay){c._resolve({approved:false,ignored:true,status:'ignored',candidate:c});_memoryApprovalActive=null;_showNextMemoryApproval();return}
  const name=String(c.characterName||'AI');
  const titles={create:name+' 想把这件事留在长期记忆里',update:name+' 想修改一段长期记忆',delete:name+' 想忘记一段长期记忆'};
  const copies={create:'确认后，这条候选才会进入长期记忆。',update:'请核对修改前后的内容；确认前，原记忆不会发生变化。',delete:'这是不可逆的长期记忆删除请求；忽略将完整保留原记忆。'};
  const opNames={create:'新增记忆',update:'修改记忆',delete:'删除记忆'};
  const confirmNames={create:'确认记住',update:'确认修改',delete:'确认忘记'};
  const av=document.getElementById('mem-approval-avatar');
  av.innerHTML='';
  if(c.avatar){const img=document.createElement('img');img.src=c.avatar;img.alt='';av.appendChild(img)}
  else av.textContent=(name.trim().charAt(0)||'AI').toUpperCase();
  document.getElementById('mem-approval-kicker').textContent='Memory request'+(_memoryApprovalQueue.length?' · 还有 '+_memoryApprovalQueue.length+' 条候选':'');
  document.getElementById('mem-approval-title').textContent=titles[c.operation]||titles.create;
  const opBadge=document.getElementById('mem-approval-operation');
  opBadge.textContent=opNames[c.operation]||opNames.create;opBadge.classList.toggle('delete',c.operation==='delete');
  document.getElementById('mem-approval-store').textContent=c.targetStore==='autoMemory'?'Auto Memory':'Memory';
  const src=document.getElementById('mem-approval-source');src.textContent=c.source||'';src.style.display=c.source?'':'none';
  document.getElementById('mem-approval-copy').textContent=copies[c.operation]||copies.create;
  const oldBlock=document.getElementById('mem-approval-old-block');
  oldBlock.style.display=(c.operation==='update'||c.operation==='delete')?'':'none';
  document.getElementById('mem-approval-old').textContent=c.oldContent||'（空）';
  const newBlock=document.getElementById('mem-approval-new-block');
  newBlock.style.display=c.operation==='delete'?'none':'';
  document.getElementById('mem-approval-new-label').textContent=c.operation==='update'?'After':'Candidate';
  document.getElementById('mem-approval-new').textContent=c.content||'（空）';
  const reasonList=document.getElementById('mem-approval-reasons');reasonList.innerHTML='';
  (c.reasons.length?c.reasons:['AI 认为这项信息具有后续参考价值']).forEach(function(reason){
    const li=document.createElement('li');li.textContent=reason;reasonList.appendChild(li);
  });
  const confidence=_memoryScore(c.confidence,0);
  const fill=document.getElementById('mem-confidence-fill');
  fill.style.width=confidence+'%';fill.classList.toggle('low',confidence<45);fill.classList.toggle('medium',confidence>=45&&confidence<75);
  document.getElementById('mem-confidence-value').textContent=confidence+'%';
  const ignore=document.getElementById('mem-approval-ignore'),confirm=document.getElementById('mem-approval-confirm');
  ignore.disabled=false;confirm.disabled=false;ignore.textContent='忽略';confirm.textContent=confirmNames[c.operation]||confirmNames.create;
  confirm.classList.toggle('danger',c.operation==='delete');
  overlay.classList.add('show');
}
async function _resolveMemoryApproval(approved){
  const c=_memoryApprovalActive;if(!c)return;
  const overlay=document.getElementById('mem-approval-overlay');
  const ignore=document.getElementById('mem-approval-ignore'),confirm=document.getElementById('mem-approval-confirm');
  ignore.disabled=true;confirm.disabled=true;
  let result;
  if(!approved){
    c.status='ignored';
    result={approved:false,ignored:true,status:'ignored',candidate:c};
  }else{
    confirm.textContent='处理中…';
    try{
      const value=await c.commit();
      c.status='approved';
      result={approved:true,ignored:false,status:'approved',value,candidate:c};
    }catch(e){
      c.status='failed';
      result={approved:false,ignored:false,status:'failed',error:e,candidate:c};
      toast('记忆操作失败：'+String(e&&e.message||e||'未知错误').slice(0,80));
    }
  }
  overlay.classList.remove('show');
  _memoryApprovalActive=null;
  const done=c._resolve;delete c._resolve;if(done)done(result);
  setTimeout(_showNextMemoryApproval,0);
}
async function _execMemOps(ops,cfg,authorName){
  const results=[];const MAXOPS=3;
  if(!amEnabled(cfg))return results;/* 兜底：未开启 Auto Memory 时任何路径都不落库 */
  for(let i=0;i<ops.length;i++){
    const op=ops[i];
    if(i>=MAXOPS){results.push({ok:false,label:'已跳过多余的记忆操作',detail:'每轮最多 3 次（第 '+(i+1)+' 次被忽略）'});continue}
    try{
      if(op.kind==='create'){
        const cat=AM_CATS[op.attrs.category]?op.attrs.category:'personal_context';
        const prio=AM_PRIOS.includes(op.attrs.priority)?op.attrs.priority:'normal';
        const payload=_autoMemCandidatePayload(op);
        const content=(payload.content||'').slice(0,600);
        if(!content){results.push({ok:false,label:'记忆写入失败',detail:'内容为空'});continue}
        if(prio==='always'){const ex=await amGetEntries(cfg.id);if(ex.filter(e=>e.priority==='always').length>=3){results.push({ok:false,label:'记忆写入失败',detail:'always 条目已达 3 条上限'});continue}}
        const entry={id:_amNewId(),friendId:cfg.id,category:cat,priority:prio,content,created:Date.now(),updated:Date.now(),updatedBy:authorName||'AI'};
        const confidence=await _calibrateMemoryCandidate({content,confidence:payload.confidence,reasons:payload.reasons,operation:'create',targetStore:'autoMemory',cfg,category:cat,priority:prio});
        const decision=await requestMemoryApproval({
          operation:'create',targetStore:'autoMemory',characterName:authorName||cfg.nickname||cfg.model||'AI',avatar:cfg.avatar||'',
          content,source:(AM_CATS[cat]||cat)+' · '+prio,confidence:confidence.confidence,reasons:confidence.reasons,
          commit:async function(){
            if(prio==='always'){const latest=await amGetEntries(cfg.id);if(latest.filter(e=>e.priority==='always').length>=3)throw new Error('always 条目已达 3 条上限')}
            await dbPut('autoMemory',entry);return entry;
          }
        });
        if(decision.approved)results.push({ok:true,status:'approved',label:'已写入记忆 · '+(AM_CATS[cat]||cat),detail:content,entry:decision.value});
        else if(decision.ignored)results.push({ok:true,status:'ignored',label:'已忽略记忆候选',detail:content});
        else results.push({ok:false,status:'failed',label:'记忆写入失败',detail:String(decision.error&&decision.error.message||decision.error||'未知错误')});
      }else if(op.kind==='update'){
        const id=op.attrs.id||'';const ex=await dbGet('autoMemory',id).catch(()=>null);
        if(!ex||ex.friendId!==cfg.id){results.push({ok:false,label:'记忆更新失败',detail:'未找到条目 '+id});continue}
        const payload=_autoMemCandidatePayload(op);
        const content=(payload.content||'').slice(0,600);
        if(!content){results.push({ok:false,label:'记忆更新失败',detail:'内容为空'});continue}
        const old=ex.content||'',snapshotUpdated=ex.updated||ex.created||0,snapshotFriend=ex.friendId;
        const confidence=await _calibrateMemoryCandidate({content,confidence:payload.confidence,reasons:payload.reasons,operation:'update',targetStore:'autoMemory',cfg,category:ex.category,priority:ex.priority,excludeId:id});
        const decision=await requestMemoryApproval({
          operation:'update',targetStore:'autoMemory',characterName:authorName||cfg.nickname||cfg.model||'AI',avatar:cfg.avatar||'',
          oldContent:old,content,source:AM_CATS[ex.category]||ex.category||'Personal',confidence:confidence.confidence,reasons:confidence.reasons,
          commit:async function(){
            const fresh=await dbGet('autoMemory',id).catch(()=>null);
            if(!fresh||fresh.friendId!==cfg.id||fresh.friendId!==snapshotFriend)throw new Error('目标记忆已不存在或不属于当前角色');
            if((fresh.updated||fresh.created||0)!==snapshotUpdated||(fresh.content||'')!==old)throw new Error('审批期间该记忆已发生变化，请重新生成候选');
            Object.assign(fresh,{content,updated:Date.now(),updatedBy:authorName||'AI'});
            await dbPut('autoMemory',fresh);return fresh;
          }
        });
        if(decision.approved)results.push({ok:true,status:'approved',label:'已更新记忆 · '+(AM_CATS[ex.category]||ex.category),detail:'原：'+old+'\n新：'+content,entry:decision.value});
        else if(decision.ignored)results.push({ok:true,status:'ignored',label:'已忽略记忆修改',detail:'原：'+old+'\n候选：'+content});
        else results.push({ok:false,status:'failed',label:'记忆更新失败',detail:String(decision.error&&decision.error.message||decision.error||'未知错误')});
      }else if(op.kind==='delete'){
        const id=op.attrs.id||'';const ex=await dbGet('autoMemory',id).catch(()=>null);
        if(!ex||ex.friendId!==cfg.id){results.push({ok:false,label:'记忆删除失败',detail:'未找到条目 '+id});continue}
        const payload=_autoMemCandidatePayload(op);
        const old=ex.content||'',snapshotUpdated=ex.updated||ex.created||0,snapshotFriend=ex.friendId;
        const confidence=await _calibrateMemoryCandidate({content:old,confidence:payload.confidence,reasons:payload.reasons,operation:'delete',targetStore:'autoMemory',cfg,category:ex.category,priority:ex.priority,excludeId:id});
        const decision=await requestMemoryApproval({
          operation:'delete',targetStore:'autoMemory',characterName:authorName||cfg.nickname||cfg.model||'AI',avatar:cfg.avatar||'',
          oldContent:old,source:AM_CATS[ex.category]||ex.category||'Personal',confidence:confidence.confidence,reasons:confidence.reasons,
          commit:async function(){
            const fresh=await dbGet('autoMemory',id).catch(()=>null);
            if(!fresh||fresh.friendId!==cfg.id||fresh.friendId!==snapshotFriend)throw new Error('目标记忆已不存在或不属于当前角色');
            if((fresh.updated||fresh.created||0)!==snapshotUpdated||(fresh.content||'')!==old)throw new Error('审批期间该记忆已发生变化，请重新生成候选');
            await dbDelete('autoMemory',id);return fresh;
          }
        });
        if(decision.approved)results.push({ok:true,status:'approved',label:'已删除记忆 · '+(AM_CATS[ex.category]||ex.category),detail:old,entry:decision.value});
        else if(decision.ignored)results.push({ok:true,status:'ignored',label:'已忽略删除请求',detail:old});
        else results.push({ok:false,status:'failed',label:'记忆删除失败',detail:String(decision.error&&decision.error.message||decision.error||'未知错误')});
      }
    }catch(e){results.push({ok:false,label:'记忆操作异常',detail:String(e&&e.message||e)})}
  }
  try{if(currentPage==='memory')renderAutoMemShowcase()}catch(e){}
  return results;
}
/* ── 附加卡片：搜索过程 + 记忆操作（收尾渲染与历史渲染共用，重开会话仍可见） ── */
function _amBuildSearchCard(s){
  const c=document.createElement('div');c.className='ws-op-card expandable';
  const n=(s.results||[]).length;
  c.innerHTML=WS_ICON.search+'<span class="ws-op-text">已联网搜索'+(s.query?' · <b>'+esc(s.query)+'</b>':'')+esc(' ('+n+' 条结果)')+'</span>'
    +'<svg class="ws-op-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
  const det=document.createElement('div');det.className='ws-op-detail';
  (s.results||[]).forEach(r=>{const a=document.createElement('a');a.href=r.url||'#';a.target='_blank';a.rel='noopener';a.textContent='· '+(r.title||r.url);a.style.cssText='display:block;color:inherit;opacity:0.85;text-decoration:none;padding:1px 0';det.appendChild(a)});
  c.appendChild(det);
  c.onclick=function(ev){if(ev.target&&ev.target.tagName==='A')return;c.classList.toggle('expanded')};
  return c;
}
function _amBuildMemCard(r){
  const c=document.createElement('div');c.className='ws-op-card expandable'+(r.ok?'':' warn');
  c.innerHTML=(r.ok?WS_ICON.mem:WS_ICON.warn)+'<span class="ws-op-text">'+esc(r.label||'记忆操作')+'</span>'
    +'<svg class="ws-op-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>';
  const det=document.createElement('div');det.className='ws-op-detail';det.textContent=r.detail||'';c.appendChild(det);
  c.onclick=function(){c.classList.toggle('expanded')};
  return c;
}
function _amAppendExtraCards(host,searches,memOps){
  try{
    (searches||[]).forEach(s=>host.appendChild(_amBuildSearchCard(s)));
    (memOps||[]).forEach(r=>host.appendChild(_amBuildMemCard(r)));
  }catch(e){}
}
/* ── 直播过滤器：把流中的 <mem_*> 标签原文截下，换成轻量提示卡（最终以收尾渲染为准） ── */
function _mkMemLiveFilter(out,cardFn){
  let buf='',inTag=false,tagName='',pend=[];
  function holdMem(s){const low=s.toLowerCase();for(let l=Math.min(low.length,5);l>0;l--){if('<mem_'.indexOf(low.slice(-l))===0)return l}return 0}
  function open(){if(typeof cardFn!=='function')return;pend=cardFn(function(){const c=document.createElement('div');c.className='ws-op-card pending';c.innerHTML=WS_ICON.mem+'<span class="ws-op-text">正在更新记忆…</span>';return c})||[]}
  function close(){(pend||[]).forEach(c=>{c.classList.remove('pending');const t=c.querySelector('.ws-op-text');if(t)t.textContent='已提交记忆操作'});pend=[]}
  return{
    push(ch){
      buf+=ch;
      for(;;){
        if(!inTag){
          const i=buf.toLowerCase().indexOf('<mem_');
          if(i<0){const h=holdMem(buf);const emit=h?buf.slice(0,buf.length-h):buf;buf=h?buf.slice(buf.length-h):'';if(emit)out(emit);return}
          if(i>0){out(buf.slice(0,i));buf=buf.slice(i)}
          const m=buf.match(/^<mem_(create|update|delete)\b/i);
          if(!m){if(buf.length>14){out(buf.slice(0,1));buf=buf.slice(1);continue}return}
          inTag=true;tagName=m[1].toLowerCase();open();
        }
        if(inTag){
          if(tagName==='delete'){
            const j=buf.indexOf('/>');const k=buf.toLowerCase().indexOf('</mem_delete>');
            if(j<0&&k<0)return;
            const end=(j>=0&&(k<0||j<k))?j+2:k+13;
            buf=buf.slice(end);inTag=false;close();continue;
          }
          const closer='</mem_'+tagName+'>';const k=buf.toLowerCase().indexOf(closer);
          if(k<0)return;
          buf=buf.slice(k+closer.length);inTag=false;close();continue;
        }
      }
    },
    finish(){if(inTag){close();buf=''}else if(buf){if('<mem_'.indexOf(buf.toLowerCase())!==0)out(buf);buf=''}}
  };
}
/* ── Memory 页 · Auto Memory 展区（固定对页 / 轨道环 / «» 滑动切换） ── */
let _amIdx=0,_amExpandPersona=false,_amQuoteFor=null;
var _amArchMode=false;/* Memory 页 AM 归档模式：展区与引言切换为归档好友，条目只读 */
function _amList(){const src=_amArchMode?(archivedConfigs||[]):(apiConfigs||[]);return src.filter(a=>a&&!String(a.id).startsWith('group_'))}
function _amArchToggleUI(){
  const l=document.getElementById('am-switch-label');
  const b=document.getElementById('am-arch-toggle');
  if(l)l.textContent=_amArchMode?'Archived':'Auto Memory';
  if(b){
    if(_amArchMode){b.classList.add('arch-return');b.innerHTML=_ARCH_RETURN_SVG+'Return'}
    else{b.classList.remove('arch-return');b.innerHTML='Archived'+_ARCH_CLOCK_SVG}
  }
}
function toggleAmArchive(){
  _amArchMode=!_amArchMode;
  _amIdx=0;_amExpandPersona=false;
  _amArchToggleUI();
  renderAutoMemShowcase();
}
function _amCoreHtml(cfg){
  const ini=(cfg.nickname||cfg.model||'AI').slice(0,1);
  const ava=cfg.avatar?'<img src="'+esc(cfg.avatar)+'" alt="">':'<span>'+esc(ini)+'</span>';
  return '<div class="am-ava">'+ava+'</div>'
    +'<div class="am-name">'+esc(cfg.nickname||cfg.model||'AI')+'</div>'
    +'<code class="am-model">'+esc(cfg.model||'')+'</code>'
    +'<div class="am-rel">'+esc(String(cfg.relationship||'').trim()||'Yours')+'</div>';
}
function _amTrayHtml(cfg,entries){
  const on=amEnabled(cfg);
  const spFull=String(cfg.systemPrompt||'').trim();
  const spCut=spFull.slice(0,96);
  const spShown=spFull?(_amExpandPersona?spFull:spCut+(spFull.length>96?'\u2026':'')):'None';
  const groups={};entries.forEach(e=>{const k=e.category||'personal_context';(groups[k]=groups[k]||[]).push(e)});
  let entHtml='';
  if(!entries.length){entHtml='<div class="am-empty">'+(_amArchMode?'无 Auto Memory 条目。':(on?'尚无条目——TA 会在对话中自行开始记录。':'此 AI 未开启 Auto Memory。'))+'</div>'}
  else{
    Object.keys(AM_CATS).forEach(cat=>{
      if(!groups[cat])return;
      entHtml+='<div class="am-cat">'+esc(AM_CATS[cat])+'</div>';
      groups[cat].forEach(e=>{
        entHtml+='<div class="am-entry" data-amid="'+esc(e.id)+'">'
          +'<div class="am-entry-text">'+(e.priority==='always'?'<span class="am-flag">always</span>':'')+esc(e.content)+'</div>'
          +(_amArchMode?'':'<span class="am-entry-ops"><button class="am-mini" onclick="amEditEntry(\''+esc(e.id)+'\')" title="Edit">\u270e</button><button class="am-mini" onclick="amDeleteEntry(\''+esc(e.id)+'\')" title="Delete">\u2715</button></span>')
          +'</div>';
      });
    });
  }
  const lastUpd=entries.length?Math.max.apply(null,entries.map(e=>e.updated||e.created||0)):0;
  const mutePill=_amArchMode
    ?'<button type="button" class="am-mute on am-mute-locked" aria-pressed="true" aria-disabled="true" title="归档好友的 AM 始终为静默状态">Mute<span class="am-mute-track"><span class="am-mute-knob"></span></span></button>'
    :'<button type="button" class="am-mute'+(cfg.amRecordOnly?' on':'')+'" aria-pressed="'+(cfg.amRecordOnly?'true':'false')+'" onclick="amRecPillClick(event)" title="静默模式：不注入档案，仅在你明确要求时写入">Mute<span class="am-mute-track"><span class="am-mute-knob"></span></span></button>';
  return '<div class="am-right-head"><span class="am-title">Auto Memory</span>'+mutePill+'</div>'
    +'<div class="am-sp">System Prompt: <span class="am-persona'+(_amExpandPersona?' open':'')+(spFull?'':' none')+'"'+(spFull?' onclick="_amExpandPersona=!_amExpandPersona;renderAutoMemShowcase()"':'')+'>'+esc(spShown)+'</span></div>'
    +'<div class="am-entries">'+entHtml+'</div>'
    +'<div class="am-foot">'+(lastUpd?esc('Updated '+new Date(lastUpd).toLocaleDateString()):'')+'</div>';
}
let _amSeq=0;
async function renderAutoMemShowcase(dir){
  const stage=document.getElementById('am-stage');if(!stage)return;
  const core=document.getElementById('am-core'),tray=document.getElementById('am-tray'),setbtn=document.getElementById('am-setbtn');
  if(!core||!tray)return;
  const under=stage.querySelector('.am-under');if(under)under.style.display=_amArchMode?'none':'';/* 归档模式隐藏 API Settings 入口 */
  const seq=++_amSeq;
  const list=_amList();
  if(!list.length){
    stage.style.display='';stage.classList.add('am-noapi');
    core.style.transition='none';core.style.opacity='1';core.style.transform='none';
    core.innerHTML='<div class="am-vdrop"></div><div class="am-vk">Auto Memory</div>';
    if(_amArchMode){
      tray.innerHTML='<div class="am-right-head"><span class="am-title">Auto Memory</span></div>'
        +'<div class="am-void-t">归档区暂无好友。</div>'
        +'<div class="am-void-w">Archived</div>';
    }else{
      tray.innerHTML='<div class="am-right-head"><span class="am-title">Auto Memory</span></div>'
        +'<div class="am-void-t">尚未配置任何 API。<br>每一位 AI 都可以在这里拥有一份由它自主维护的、关于你的长期记忆档案。</div>'
        +'<div class="am-void-w">Auto Memory</div>';
      if(setbtn){setbtn.textContent='前往 API 设置 \u2197';setbtn.onclick=function(){navTo('api')}}
    }
    requestAnimationFrame(function(){core.style.transition=''});
    _amSyncQuote(null);
    return}
  stage.style.display='';stage.classList.remove('am-noapi');
  if(_amIdx>=list.length)_amIdx=0;if(_amIdx<0)_amIdx=list.length-1;
  const cfg=list[_amIdx];
  _amSyncQuote(cfg);
  const entries=await amGetEntries(cfg.id);
  if(seq!==_amSeq)return;/* 快速连点：只让最后一次请求落地 */
  if(setbtn){setbtn.textContent='API Settings \u2197';setbtn.onclick=function(){amJumpSettings(cfg.id)}}
  const reduce=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const apply=function(stagger){
    core.innerHTML=_amCoreHtml(cfg);tray.innerHTML=_amTrayHtml(cfg,entries);
    if(stagger&&!reduce){
      tray.querySelectorAll('.am-entry-text,.am-empty').forEach(function(el,i){
        el.style.opacity='0';el.style.transform='translateY(12px)';
        setTimeout(function(){if(seq!==_amSeq)return;el.style.opacity='';el.style.transform=''},70+i*90);
      });
    }
  };
  if(dir&&!reduce){
    stage.classList.add('am-pulse');setTimeout(function(){stage.classList.remove('am-pulse')},450);
    core.style.opacity='0';core.style.transform='rotate('+(dir>0?-11:11)+'deg) scale(0.94)';
    setTimeout(function(){
      if(seq!==_amSeq)return;
      apply(true);
      core.style.transition='none';core.style.transform='rotate('+(dir>0?9:-9)+'deg) scale(0.96)';
      requestAnimationFrame(function(){requestAnimationFrame(function(){
        if(seq!==_amSeq)return;
        core.style.transition='';core.style.opacity='1';core.style.transform='none';
      })});
    },300);
  }else{
    apply(false);
    core.style.opacity='1';core.style.transform='none';
  }
  const dots=stage.querySelector('.am-dots');if(dots){dots.innerHTML='';list.forEach((_,i)=>{const s=document.createElement('span');s.className='am-dot'+(i===_amIdx?' on':'');dots.appendChild(s)})}
}
function amStep(d){_amIdx+=d;_amExpandPersona=false;renderAutoMemShowcase(d)}
async function amToggleRecordOnly(v){
  const list=_amList();const cfg=list[_amIdx];if(!cfg)return;
  cfg.amRecordOnly=!!v;
  try{await dbPut('apiConfigs',cfg)}catch(e){toast('保存失败');return}
  const ed=document.getElementById('api-automem-recordonly');
  if(ed&&editingApiId===cfg.id)ed.checked=!!v;
  renderAutoMemShowcase();
  toast(v?'静默模式：已开启':'静默模式：已关闭');
}
function amRecPillClick(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();if(_amArchMode)return;const c=_amList()[_amIdx];if(c)amToggleRecordOnly(!c.amRecordOnly)}
function amJumpSettings(id){try{navTo('api');setTimeout(function(){if(typeof editApi==='function')editApi(id);else if(typeof editApiConfig==='function')editApiConfig(id)},80)}catch(e){navTo('api')}}
async function amEditEntry(id){
  const row=document.querySelector('.am-entry[data-amid="'+id+'"]');if(!row)return;
  const e=await dbGet('autoMemory',id);if(!e)return;
  row.innerHTML='<textarea class="am-edit-ta"></textarea>'
    +'<span class="am-entry-ops"><button class="am-mini" onclick="amSaveEntry(\''+esc(id)+'\',this)" title="Save">✓</button><button class="am-mini" onclick="renderAutoMemShowcase()" title="Cancel">↺</button></span>';
  const ta=row.querySelector('textarea');ta.value=e.content||'';ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);
}
async function amSaveEntry(id,btn){
  const row=btn.closest('.am-entry');const ta=row&&row.querySelector('textarea');if(!ta)return;
  const e=await dbGet('autoMemory',id);if(!e)return;
  const v=ta.value.trim().slice(0,600);if(!v){toast('内容不能为空');return}
  Object.assign(e,{content:v,updated:Date.now(),updatedBy:'user'});
  await dbPut('autoMemory',e);toast('已保存');renderAutoMemShowcase();
}
async function amDeleteEntry(id){
  const row=document.querySelector('.am-entry[data-amid="'+id+'"]');
  if(!row){await dbDelete('autoMemory',id);renderAutoMemShowcase();return}
  if(row.dataset.amconfirm)return;
  row.dataset.amconfirm='1';
  const keep=row.innerHTML;
  row.innerHTML='<div class="am-entry-text am-del-ask">删除这条记忆？此操作不可撤销。</div>'
    +'<span class="am-entry-ops" style="opacity:1"><button class="am-mini am-mini-danger" title="Confirm">\u2713</button><button class="am-mini" title="Cancel">\u21ba</button></span>';
  const bs=row.querySelectorAll('.am-mini');
  bs[0].onclick=async function(){await dbDelete('autoMemory',id);toast('已删除');renderAutoMemShowcase()};
  bs[1].onclick=function(){delete row.dataset.amconfirm;row.innerHTML=keep};
}
/* ── API 编辑器 · 按天聊天记录管理（仅列有记录的日期；导出文件可直接 Import 回导） ── */
function _amDayKey(t){const d=new Date(t);const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())}
async function _amMsgsOfDay(fid,k){let all=[];try{all=await dbGetByIndex('chatMessages','byFriend',fid)}catch(e){}return all.filter(m=>_amDayKey(m.timestamp||m.created||0)===k)}
function apiToggleDays(){const box=document.getElementById('api-daybox');if(!box)return;const open=box.style.display!=='none';box.style.display=open?'none':'block';const c=document.getElementById('api-daycaret');if(c)c.classList.toggle('open',!open);if(!open&&editingApiId)renderApiDayList(editingApiId)}
function toggleSummaryMgmt(){const l=document.getElementById('summary-mgmt-list');if(!l)return;const open=l.style.display!=='none';l.style.display=open?'none':'flex';const c=document.getElementById('summary-mgmt-caret');if(c)c.classList.toggle('open',!open)}
async function renderApiDayList(fid){
  const box=document.getElementById('api-daylist');if(!box)return;
  let msgs=[];try{msgs=await dbGetByIndex('chatMessages','byFriend',fid)}catch(e){}
  if(!msgs.length){box.innerHTML='<div class="api-dayempty">暂无聊天记录</div>';return}
  const days={};msgs.forEach(m=>{const t=m.timestamp||m.created||0;if(!t)return;const k=_amDayKey(t);days[k]=(days[k]||0)+1});
  const keys=Object.keys(days).sort().reverse();
  box.innerHTML=keys.map(k=>'<div class="api-dayrow" data-day="'+k+'"><span class="api-dayd">'+k+'</span><span class="api-dayn">'+days[k]+' \u6761</span><span class="am-entry-ops"><button class="am-mini" title="\u5bfc\u51fa\u8be5\u65e5" onclick="apiExportDay(\''+fid+'\',\''+k+'\')">\u2913</button><button class="am-mini am-mini-danger" title="\u5220\u9664\u8be5\u65e5" onclick="apiDeleteDay(this,\''+fid+'\',\''+k+'\')">\u2715</button></span></div>').join('');
}
async function apiExportDay(fid,k){
  const list=(await _amMsgsOfDay(fid,k)).sort((a,b)=>(a.timestamp||a.created||0)-(b.timestamp||b.created||0));
  if(!list.length){toast('\u8be5\u65e5\u65e0\u8bb0\u5f55');return}
  const cfg=(apiConfigs||[]).find(a=>a.id===fid)||{};
  /* 兼容清理曾由测试版写入的原始流字段；按日导出恢复原版消息结构，避免旧数据继续夹带 SSE。 */
  const cleanList=list.map(function(m){const c=Object.assign({},m);delete c.upstreamRaw;delete c.thinkingSources;return c});
  const payload={type:'ib_chat_day',friendId:fid,name:cfg.nickname||cfg.model||'',day:k,count:cleanList.length,chatMessages:cleanList,exportDate:new Date().toISOString()};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='IB_chat_'+(cfg.nickname||fid)+'_'+k+'.json';document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(a.href)},4000);
  toast('\u5df2\u5bfc\u51fa '+k+' \u00b7 '+list.length+' \u6761');
}
async function apiDeleteDay(btn,fid,k){
  const row=btn.closest('.api-dayrow');if(!row||row.dataset.cf)return;
  row.dataset.cf='1';
  row.innerHTML='<span class="api-dayd am-del-ask">\u5220\u9664 '+k+' \u7684\u5168\u90e8\u804a\u5929\uff08\u542b\u8bdd\u9898\u9891\u9053\uff09\uff1f\u4e0d\u53ef\u64a4\u9500\u3002</span><span class="am-entry-ops" style="opacity:1;margin-left:auto"><button class="am-mini am-mini-danger">\u2713</button><button class="am-mini">\u21ba</button></span>';
  const bs=row.querySelectorAll('.am-mini');
  bs[0].onclick=async function(){const list=await _amMsgsOfDay(fid,k);for(const m of list){try{await dbDelete('chatMessages',m.id)}catch(e){}}toast('\u5df2\u5220\u9664 '+list.length+' \u6761');renderApiDayList(fid);try{updateChatStorageInfo()}catch(e){}try{if(currentPage==='chat')renderChatCalendar()}catch(e){}};
  bs[1].onclick=function(){renderApiDayList(fid)};
}

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.memory.autoMem 登记全部导出 ---- */
window.amEnabled=amEnabled;
window._amUserName=_amUserName;
window._amNewId=_amNewId;
window.amGetEntries=amGetEntries;
window._amInstrBlock=_amInstrBlock;
window._amFmtEntry=_amFmtEntry;
window._amScore=_amScore;
window._amRecordOnlyBlock=_amRecordOnlyBlock;
window.amBuildInject=amBuildInject;
window._parseMemOps=_parseMemOps;
window._memoryJsonObject=_memoryJsonObject;
window._memoryReasons=_memoryReasons;
window._memoryScore=_memoryScore;
window._autoMemCandidatePayload=_autoMemCandidatePayload;
window._memoryRepeatCount=_memoryRepeatCount;
window._memoryLyricFlags=_memoryLyricFlags;
window._distinctEvidenceCount=_distinctEvidenceCount;
window.U_EVIDENCE_SIM_THRESHOLD=U_EVIDENCE_SIM_THRESHOLD;
window._calibrateMemoryCandidate=_calibrateMemoryCandidate;
window.requestMemoryApproval=requestMemoryApproval;
window._showNextMemoryApproval=_showNextMemoryApproval;
window._resolveMemoryApproval=_resolveMemoryApproval;
window._execMemOps=_execMemOps;
window._amBuildSearchCard=_amBuildSearchCard;
window._amBuildMemCard=_amBuildMemCard;
window._amAppendExtraCards=_amAppendExtraCards;
window._mkMemLiveFilter=_mkMemLiveFilter;
window._amList=_amList;
window._amArchToggleUI=_amArchToggleUI;
window.toggleAmArchive=toggleAmArchive;
window._amCoreHtml=_amCoreHtml;
window._amTrayHtml=_amTrayHtml;
window.renderAutoMemShowcase=renderAutoMemShowcase;
window.amStep=amStep;
window.amToggleRecordOnly=amToggleRecordOnly;
window.amRecPillClick=amRecPillClick;
window.amJumpSettings=amJumpSettings;
window.amEditEntry=amEditEntry;
window.amSaveEntry=amSaveEntry;
window.amDeleteEntry=amDeleteEntry;
window._amDayKey=_amDayKey;
window._amMsgsOfDay=_amMsgsOfDay;
window.apiToggleDays=apiToggleDays;
window.toggleSummaryMgmt=toggleSummaryMgmt;
window.renderApiDayList=renderApiDayList;
window.apiExportDay=apiExportDay;
window.apiDeleteDay=apiDeleteDay;
window.AM_CATS=AM_CATS;
window.AM_PRIOS=AM_PRIOS;
function ibAmLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
ibAmLive('_memoryApprovalQueue', function(){return _memoryApprovalQueue}, function(v){_memoryApprovalQueue=v});
ibAmLive('_memoryApprovalActive', function(){return _memoryApprovalActive}, function(v){_memoryApprovalActive=v});
ibAmLive('_amIdx', function(){return _amIdx}, function(v){_amIdx=v});
ibAmLive('_amArchMode', function(){return _amArchMode}, function(v){_amArchMode=v});
ibAmLive('_amSeq', function(){return _amSeq}, function(v){_amSeq=v});
ibAmLive('_amExpandPersona', function(){return _amExpandPersona}, function(v){_amExpandPersona=v});
ibAmLive('_amQuoteFor', function(){return _amQuoteFor}, function(v){_amQuoteFor=v});
NS.expose('memory.autoMem', {
  amEnabled: amEnabled,
  _amUserName: _amUserName,
  _amNewId: _amNewId,
  amGetEntries: amGetEntries,
  _amInstrBlock: _amInstrBlock,
  _amFmtEntry: _amFmtEntry,
  _amScore: _amScore,
  _amRecordOnlyBlock: _amRecordOnlyBlock,
  amBuildInject: amBuildInject,
  _parseMemOps: _parseMemOps,
  _memoryJsonObject: _memoryJsonObject,
  _memoryReasons: _memoryReasons,
  _memoryScore: _memoryScore,
  _autoMemCandidatePayload: _autoMemCandidatePayload,
  _memoryRepeatCount: _memoryRepeatCount,
  _distinctEvidenceCount: _distinctEvidenceCount,
  U_EVIDENCE_SIM_THRESHOLD: U_EVIDENCE_SIM_THRESHOLD,
  _calibrateMemoryCandidate: _calibrateMemoryCandidate,
  requestMemoryApproval: requestMemoryApproval,
  _showNextMemoryApproval: _showNextMemoryApproval,
  _resolveMemoryApproval: _resolveMemoryApproval,
  _execMemOps: _execMemOps,
  _amBuildSearchCard: _amBuildSearchCard,
  _amBuildMemCard: _amBuildMemCard,
  _amAppendExtraCards: _amAppendExtraCards,
  _mkMemLiveFilter: _mkMemLiveFilter,
  _amList: _amList,
  _amArchToggleUI: _amArchToggleUI,
  toggleAmArchive: toggleAmArchive,
  _amCoreHtml: _amCoreHtml,
  _amTrayHtml: _amTrayHtml,
  renderAutoMemShowcase: renderAutoMemShowcase,
  amStep: amStep,
  amToggleRecordOnly: amToggleRecordOnly,
  amRecPillClick: amRecPillClick,
  amJumpSettings: amJumpSettings,
  amEditEntry: amEditEntry,
  amSaveEntry: amSaveEntry,
  amDeleteEntry: amDeleteEntry,
  _amDayKey: _amDayKey,
  _amMsgsOfDay: _amMsgsOfDay,
  apiToggleDays: apiToggleDays,
  toggleSummaryMgmt: toggleSummaryMgmt,
  renderApiDayList: renderApiDayList,
  apiExportDay: apiExportDay,
  apiDeleteDay: apiDeleteDay,
  AM_CATS: AM_CATS,
  AM_PRIOS: AM_PRIOS,
  _memoryApprovalQueue: _memoryApprovalQueue,
  _memoryApprovalActive: _memoryApprovalActive,
  _amIdx: _amIdx,
  _amArchMode: _amArchMode,
  _amSeq: _amSeq,
  _amExpandPersona: _amExpandPersona,
  _amQuoteFor: _amQuoteFor,
});
})(window.IB || (window.IB = {}));