/* AI 朋友圈（Moments）域 — 独立 IIFE + window/IB 双挂载。
   复用（不重复实现）：IndexedDB 存储（dbPut/dbGet/dbGetAll/dbDelete/dbGetByIndex）、
   AI 调用（callApiChat + jsonMode）、主动消息相似度（_activeTextSimilarity，bigram Dice）、
   JSON 容错解析（_activeParsePlanJson）、上下文加载（_activeRecentMemories/_activeRecentMessages/
   _activeRecentProactiveMessages）、调度心跳（_activeTick 30s，与 _diaryTick 同挂点）、
   图片压缩（compressImage）、toast/navTo/esc。
   fail-open：任何生成失败只记录与退避，不影响聊天 / 主动消息 / 日记 / Memory。 */
(function(NS){
const MOMENT_STORE='moments';
const MOMENT_PREFS_KEY='ib_moments_prefs_v1';
const MOMENT_STATE_KEY='ib_moments_state_v1';
const MOMENT_COMMENT_Q_KEY='ib_moments_commentq_v1';
const MOMENT_SIMILARITY=0.75;      /* 与最近动态/主动消息的相似度上限（复用 bigram Dice） */
const MOMENT_COMMENT_SIMILARITY=0.8;
const MOMENT_MAX_ATTEMPTS=2;       /* 生成重试次数（解析失败/去重命中时提示重写） */
const MOMENT_GEN_MAX_TOKENS=2000;  /* 自主发帖生成预算（与 diary JSON 生成同级）：正文很短，但推理型模型需要 reasoning 预算；
                                      首次空输出时自适应加倍重试（上限 8000），仅作用于本请求，不影响聊天/全局 Provider */
const MOMENT_MIN_INTERVAL=45*60000;/* 同一角色两次发布之间的最少间隔（含手动） */
const MOMENT_COMMENT_COOLDOWN=45*60000;/* 同一角色两次评论之间的冷却 */
const MOMENT_COMMENT_MAX_PER=2;    /* 每条动态最多触发的 AI 评论数 */
const MOMENT_LIKE_MAX_PER_HOUR=4;  /* 每个 Role 每小时最多执行的 AI 点赞数 */
const MOMENT_LIKE_COOLDOWN=15*60000;/* 同一 Role 两次 AI 点赞之间的冷却 */
/* ── AI↔AI 回复链（线程化连续社交）──
   复用：45min 评论冷却（MOMENT_COMMENT_COOLDOWN）、触发队列（_momentsSetCommentQ）、
   上下文加载（_momentsContext）、jsonMode 调用与容错解析（_activeParsePlanJson）。
   核心规则/Prompt/常量/亲和度已在 assets/js/reply-chain-core.js 唯一化（浏览器与 companion 共享）：
   本文件只做浏览器侧状态（localStorage 线程计划 + 角色频控日志）与触发/执行编排。 */
const RC=(typeof window!=='undefined'&&window._replyChainCore)||{};/* 共享核心（必然存在，防御式读） */
/* ── 行为观测（纯旁路，观察期专用；见 assets/js/social-observe.js）──
   只记录计数/方向/耗时/token 数，不含任何正文；任何失败都被吞掉，绝不影响业务流程。 */
const OBS=(typeof window!=='undefined'&&window._socialObserve)||null;
const OBS_USER=(OBS&&OBS.USER)||'user';/* 观测矩阵中"用户"的哨兵 id */
function _obsRec(type,data){try{if(OBS)OBS.record(type,data)}catch(e){}}
async function _obsCall(kind,cfg,messages,opts){
  let h=null;try{if(OBS)h=OBS.callBegin(kind,cfg,messages)}catch(e){}
  const __t0=Date.now();
  try{
    const r=await callApiChat(cfg,messages,opts);
    try{if(OBS)OBS.callEnd(h,true,Date.now()-__t0,'')}catch(e){}
    return r
  }catch(e){
    try{if(OBS)OBS.callEnd(h,false,Date.now()-__t0,String(e&&e.message||e).slice(0,24))}catch(e2){}
    throw e
  }
}
const MOMENT_REPLY_CHAIN_KEY='ib_moments_reply_chain_v1';/* 线程状态（momentId → 计划） */
const MOMENT_COMMENT_LOG_KEY='ib_moments_comment_log_v1';/* 每角色自动评论时间戳（小时/日频控） */
const MOMENT_REPLY_MAX_ROUNDS=RC.LIMITS?RC.LIMITS.MAX_ROUNDS:3;        /* 单线程最多 3 轮自动续链 */
const MOMENT_REPLY_COMMENT_MAX=RC.LIMITS?RC.LIMITS.COMMENT_MAX:12;     /* 单动态评论 >12 停止 */
const MOMENT_REPLY_HOURLY_MAX=RC.LIMITS?RC.LIMITS.HOURLY_MAX:4;        /* 每角色每小时自动评论上限 */
const MOMENT_REPLY_DAILY_MAX=RC.LIMITS?RC.LIMITS.DAILY_MAX:12;         /* 每角色每日自动评论上限 */
const MOMENT_REPLY_DELAY_MIN=30000;     /* 下一步触发的随机延迟下界（30s） */
const MOMENT_REPLY_DELAY_MAX=120000;    /* 上界（120s）——一次只走一步，不连续同帧生成 */
const MOMENT_REPLY_THIRD_AFFINITY=RC.LIMITS?RC.LIMITS.THIRD_AFFINITY:55;/* 第三方加入的亲和度门槛 */
const MOMENT_REPLY_CHAIN_TTL=7*86400000;/* 线程状态过期清理（7 天） */
const MOMENT_REPLY_STATE_MAX=200;       /* 线程状态条数上限（防无限增长） */
const MOMENT_REPLY_LOW_INFO=/^(哈哈+|嗯+|嗯嗯+|好的|好|不错|\+1|666|nb|强|赞|可爱|好看|加油|嘿|哎|哦|哈|呵|笑死|点赞|收藏|转发|同感|是啊|确实)$/i;
const MOMENT_IMAGE_PROB=45;        /* 模型想配图时，仍会经过的浏览器概率门（%），防止每条都配图 */
const MOMENT_FEED_PAGE=30;         /* Feed 首屏渲染条数（分页） */
const MOMENT_FEED_SCAN_MAX=360;    /* Feed 单次扫描上限（12 页；更旧的动态留在库里，导出不受影响） */
const MOMENT_FEED_FIRST_SCAN=60;   /* Feed 首屏读取上限：byCreated 游标读最近 60 条即提前停止，不再扫 360 条 */
const MOMENT_CTX_SCAN_MAX=150;     /* 聊天注入/上下文构建的游标扫描上限（防长期运行后全表读） */
const MOMENT_CONTEXT_CHAT_MAX=900; /* 聊天注入的最大字符数 */
/* 频率 → 随机发布间隔区间 */
const MOMENT_FREQ={low:[8*3600000,16*3600000],medium:[3*3600000,6*3600000],high:[70*60000,150*60000]};
const MOMENT_VIS=['all','user','roles','private'];
/* 动机枚举（双端镜像：active/moments.js 同款）——motive 只标注"此刻为什么想发"，不是发布资格门；
   发布资格仍由现有调度+最短间隔+去重+模型 publish 决策共同决定。 */
const MOMENT_MOTIVES=['share','daily_life','emotion','reflection','interaction','curiosity','social_response','none'];

/* ── 偏好（localStorage，与 diary 偏好同构） ── */
function _momentsPrefs(){
  const d={enabled:true,autoPublish:true,frequency:'medium',aiComment:true,aiLike:true,otherRolesVisible:true};
  try{
    const raw=JSON.parse(localStorage.getItem(MOMENT_PREFS_KEY)||'null');
    if(!raw||typeof raw!=='object')return d;
    return{
      enabled:raw.enabled!==false,
      autoPublish:raw.autoPublish!==false,
      frequency:['low','medium','high'].includes(raw.frequency)?raw.frequency:'medium',
      aiComment:raw.aiComment!==false,
      aiLike:raw.aiLike!==false,
      otherRolesVisible:raw.otherRolesVisible!==false
    }
  }catch(e){return d}
}
function _momentsPrefsSave(p){
  const cur=_momentsPrefs();
  try{localStorage.setItem(MOMENT_PREFS_KEY,JSON.stringify(Object.assign({},cur,p)))}catch(e){}
}
/* 每角色调度状态（localStorage map，防重复执行） */
function _momentsState(){
  try{const v=JSON.parse(localStorage.getItem(MOMENT_STATE_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}
}
function _momentsSetState(roleId,patch){
  try{const s=_momentsState();s[roleId]=Object.assign({},s[roleId]||{},patch||{});localStorage.setItem(MOMENT_STATE_KEY,JSON.stringify(s))}catch(e){}
}
function _momentsCommentQ(){
  try{const v=JSON.parse(localStorage.getItem(MOMENT_COMMENT_Q_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}
}
/* 写入时顺带裁剪 >48h 的旧标记（点赞/评论触发只看 1h 内），防长期运行后该 map 无限增长 */
function _momentsSetCommentQ(id){
  try{
    const q=_momentsCommentQ(),now=Date.now();
    for(const k of Object.keys(q)){if(!(Number(q[k])>0)||now-Number(q[k])>48*3600000)delete q[k]}
    q[id]=now;localStorage.setItem(MOMENT_COMMENT_Q_KEY,JSON.stringify(q))
  }catch(e){}
}

function _momentsId(prefix){return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)}
/* ── 回复链状态（localStorage，最小状态 + 过期清理） ──
   threadState[momentId] = { status:'pending'|'idle', scheduledAt, nextAt,
                             lastConsumedCommentId, updatedAt }
   语义：一个线程同一时刻最多一个 pending 下一步；lastConsumedCommentId 用于幂等
   （同一 comment 只消化一次；刷新/重复事件不再补发）。 */
function _momentsReplyChainState(){
  try{const v=JSON.parse(localStorage.getItem(MOMENT_REPLY_CHAIN_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}
}
function _momentsReplyChainSave(st){
  try{
    const now=Date.now();
    const keys=Object.keys(st);
    for(const k of keys){const s=st[k];if(!s||typeof s!=='object'||!Number(s.updatedAt)||now-Number(s.updatedAt)>MOMENT_REPLY_CHAIN_TTL)delete st[k]}
    if(keys.length>MOMENT_REPLY_STATE_MAX){/* 超出上限：先丢最久未更新的 idle 项 */
      const idle=keys.map(k=>({k,s:st[k]})).filter(x=>x.s&&x.s.status!=='pending').sort((a,b)=>(Number(a.s.updatedAt)||0)-(Number(b.s.updatedAt)||0));
      let del=keys.length-MOMENT_REPLY_STATE_MAX;
      for(const x of idle){if(del<=0)break;delete st[x.k];del--}
      if(del>0){/* 仍然超限：丢弃 pending 中最旧的 */
        const pend=keys.map(k=>({k,s:st[k]})).filter(x=>x.s&&x.s.status==='pending').sort((a,b)=>(Number(a.s.updatedAt)||0)-(Number(b.s.updatedAt)||0));
        for(const x of pend){if(del<=0)break;delete st[x.k];del--}
      }
    }
    localStorage.setItem(MOMENT_REPLY_CHAIN_KEY,JSON.stringify(st));
  }catch(e){}
}
/* 每角色自动评论时间戳（频控）：严格裁剪 >24h，避免无限增长 */
function _momentsCommentLog(){
  try{const v=JSON.parse(localStorage.getItem(MOMENT_COMMENT_LOG_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}
}
function _momentsCommentLogCount(roleId,windowMs,now){
  now=Number(now)||Date.now();
  const log=_momentsCommentLog()[String(roleId)]||[];
  return log.filter(t=>now-Number(t)<=windowMs).length;
}
function _momentsCommentLogRecord(roleId,now){
  try{
    now=Number(now)||Date.now();
    const t=now-86400000,log=_momentsCommentLog(),arr=(log[String(roleId)]||[]).filter(x=>Number(x)>=t);
    arr.push(now);
    log[String(roleId)]=arr.slice(-200);
    localStorage.setItem(MOMENT_COMMENT_LOG_KEY,JSON.stringify(log));
  }catch(e){}
}
/* 冷却/频控合并判断（回复链候选资格；首层评论沿用 generateRoleComment 自身判定） */
function _momentsReplyRoomOk(roleId,now){
  now=Number(now)||Date.now();
  const st=(_momentsState()[String(roleId)]||{});
  if(st.lastCommentAt&&now-Number(st.lastCommentAt)<MOMENT_COMMENT_COOLDOWN)return false;
  if(_momentsCommentLogCount(roleId,3600000,now)>=MOMENT_REPLY_HOURLY_MAX)return false;
  if(_momentsCommentLogCount(roleId,86400000,now)>=MOMENT_REPLY_DAILY_MAX)return false;
  return true;
}
/* 观测辅助：区分被拦截的具体原因（冷却 vs 小时频控 vs 日频控）；只读，不影响判定 */
function _momentsReplyBlockReason(roleId){
  const now=Date.now();
  if(_momentsCommentLogCount(roleId,3600000,now)>=MOMENT_REPLY_HOURLY_MAX)return'freq_hour';
  if(_momentsCommentLogCount(roleId,86400000,now)>=MOMENT_REPLY_DAILY_MAX)return'freq_day';
  return'cooldown';
}
/* 当前线程的回复轮数 = 该线程中带 replyTo 的角色回复条数（首层评论不算轮；委托共享核心） */
function _momentsChainRound(m){
  return RC.chainRound?RC.chainRound(m&&m.comments):0;
}
/* ── 有界读取（长期运行：避免热路径全表 getAll 把含图片的整库读进内存） ──
   _momentsScanDesc(max)：按 byCreated 索引倒序游标，最多取 max 条；索引缺失/异常时退化为 getAll 截断。 */
async function _momentsScanDesc(maxScan){
  maxScan=Math.max(1,Number(maxScan)||100);
  try{
    if(typeof db==='undefined'||!db)throw new Error('db not ready');
    return await new Promise((resolve,reject)=>{
      let out=[],done=false;
      const fin=ok=>{if(done)return;done=true;ok?resolve(out):reject(new Error('cursor failed'))};
      try{
        const t=db.transaction(MOMENT_STORE,'readonly');
        const store=t.objectStore(MOMENT_STORE);
        if(!store.indexNames.contains('byCreated'))return reject(new Error('no byCreated'));
        const req=store.index('byCreated').openCursor(null,'prev');
        req.onsuccess=function(){try{const c=req.result;if(!c||out.length>=maxScan)return fin(true);out.push(c.value);c.continue()}catch(e){fin(true)}};
        req.onerror=function(){fin(false)};
        t.onerror=function(){fin(false)};t.onabort=function(){fin(false)};
        setTimeout(function(){fin(true)},4000)/* 兜底：游标卡住时返回已有部分 */
      }catch(e){reject(e)}
    })
  }catch(e){
    try{return (await dbGetAll(MOMENT_STORE)).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,maxScan)}catch(e2){return[]}
  }
}
/* 单角色动态：走 byRole 索引（只传输该角色的记录），缺失时退化全表过滤 */
async function _momentsQueryByRole(roleId){
  const rid=String(roleId||'');
  try{
    if(typeof db!=='undefined'&&db){
      const viaIndex=await new Promise((resolve,reject)=>{
        try{
          const t=db.transaction(MOMENT_STORE,'readonly');
          const store=t.objectStore(MOMENT_STORE);
          if(!store.indexNames.contains('byRole'))return reject(new Error('no byRole'));
          const q=store.index('byRole').getAll(IDBKeyRange.only(rid));
          q.onsuccess=()=>resolve(q.result||[]);q.onerror=()=>reject(q.error)
        }catch(e){reject(e)}
      });
      if(viaIndex)return viaIndex
    }
  }catch(e){}
  try{return (await dbGetAll(MOMENT_STORE)).filter(m=>m&&m.roleId===rid)}catch(e){return[]}
}
/* ── 作者模型：user | role（旧数据无 authorType → 读取时按 role 解释，roleId 即 authorId） ── */
function _momentIsUserAuthor(m){return !!(m&&m.authorType==='user')}
function _momentsAuthorRoleId(m){/* 作者为 role 时的角色 id；兼容旧记录与 authorId 写法 */
  if(!m||_momentIsUserAuthor(m))return'';
  return String(m.roleId||m.authorId||'')
}
function _momentsUserDisplayName(){
  try{return (typeof _cachedUserName==='string'&&_cachedUserName.trim())?_cachedUserName.trim():'用户'}catch(e){return'用户'}
}
function _momentsUserAvatarSrc(){
  try{return (typeof _cachedUserAvatar==='string'&&_cachedUserAvatar)||''}catch(e){return''}
}
/* ── 数据模型（严格校验 + 截断，防止脏数据落库） ── */
function _momentsDefaults(p){
  p=p&&typeof p==='object'?p:{};
  const vis=['all','user','roles','private'].includes(p.visibility)?p.visibility:'all';
  const images=Array.isArray(p.images)?p.images.slice(0,9).filter(im=>im&&typeof im==='object'&&String(im.dataUrl||'').length<2.5e6):[];
  const isUser=p.authorType==='user';
  const roleId=isUser?'':String(p.roleId||p.authorId||'');
  return{
    id:String(p.id||_momentsId('mom')),
    authorType:isUser?'user':'role',          /* 新字段；旧记录读取侧兼容（见 _momentIsUserAuthor） */
    authorId:isUser?String(p.authorId||p.roleId||_activeUserId()):roleId,
    roleId:roleId,                            /* user 作者恒为 ''；role 作者保留原字段（旧索引/旧数据兼容） */
    content:String(p.content||'').slice(0,2000),
    images:images,
    visibility:vis,
    visibleRoleIds:vis==='roles'?(Array.isArray(p.visibleRoleIds)?p.visibleRoleIds.slice(0,20).map(String):[]):[],
    likes:Array.isArray(p.likes)?p.likes.slice(0,1000).map(String):[],
    comments:Array.isArray(p.comments)?p.comments.slice(0,200):[],
    source:['manual','proactive'].includes(p.source)?p.source:'manual',
    motive:MOMENT_MOTIVES.includes(p.motive)&&p.motive!=='none'?p.motive:'',       /* 动机标注（仅 AI 自主发布写入；手动/用户动态为 ''） */
    repostOf:p.repostOf?String(p.repostOf):'',       /* 引用/转发：被引用动态 id（可空） */
    repostText:String(p.repostText||(p.repostOf?p.content:'')).slice(0,200),/* 引用评语（repostOf 存在时展示；缺省回落 content） */
    createdAt:p.createdAt||new Date().toISOString()
  }
}

/* ── 可见性（无 RBAC，个人本地应用） ──
   用户作者：作者本人永远可读自己的动态（含 private/user/roles）；其他主体按 visibility 规则。
   角色作者：规则与第一阶段一致（all/user 对用户可见；private/roles 不对用户展示内容）。 */
function _momentsVisibleToUser(m){
  if(!m)return false;
  if(_momentIsUserAuthor(m))return true;/* 用户看自己发的所有动态 */
  return m.visibility==='all'||m.visibility==='user'
}
function _momentsVisibleToRole(m,roleId){
  if(!m)return false;
  if(!_momentIsUserAuthor(m)&&_momentsAuthorRoleId(m)===String(roleId))return true;/* 作者角色永远可读自己的动态（含 private） */
  if(m.visibility==='all')return true;
  if(m.visibility==='roles')return (m.visibleRoleIds||[]).includes(roleId);
  return false
}
function _momentsCfg(id){return apiConfigs.find(a=>a.id===id)||archivedConfigs.find(a=>a.id===id)||null}

/* ══════════ Service 层（UI 不直接操作存储） ══════════ */
async function createMoment(data){
  try{
    if(!data||typeof data!=='object')return{ok:false,error:'参数错误'}
    const isUser=data.authorType==='user';
    if(!isUser&&!String(data.roleId||data.authorId||'').trim())return{ok:false,error:'缺少角色'}
    if(!String(data.content||'').trim()&&!(data.images&&data.images.length)&&!String(data.repostOf||'').trim())return{ok:false,error:'内容不能为空'}
    const m=_momentsDefaults(data);
    await dbPut(MOMENT_STORE,m);
    if(isUser)_obsRec('user_post',{vis:m.visibility});
    try{if(currentPage==='moments')loadMomentsPage()}catch(e){}
    /* 动态创建 → 触发现有 AI 点赞/评论管线（延迟/上限/冷却不变；用户动态同样适用，无新增强制互动） */
    _momentsMaybeLike(m);
    _momentsMaybeComment(m);
    _momentsMaybeMention(m);/* @ 点名：正文 @ 的角色强制评论（2 分钟冷却，防刷屏） */
    return{ok:true,moment:m}
  }catch(e){console.warn('[Moments] create failed',String(e&&e.message||e).slice(0,200));return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}
async function getMoments(maxScan){
  /* maxScan：游标提前停止的读取上限；缺省沿用后台扫描上限（导出/管线等调用方行为不变） */
  let all=await _momentsScanDesc(Math.max(1,Number(maxScan)||MOMENT_FEED_SCAN_MAX));
  return all.filter(_momentsVisibleToUser).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))
}
async function getRoleMoments(roleId){
  let own=await _momentsQueryByRole(roleId);
  return (own||[]).filter(m=>m&&m.roleId===String(roleId)).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))
}
async function getMoment(id){try{return await dbGet(MOMENT_STORE,id)}catch(e){return null}}
async function deleteMoment(id){
  try{
    const m=await getMoment(id);if(!m)return{ok:false,error:'动态不存在'};
    await dbDelete(MOMENT_STORE,id);
    try{if(currentPage==='moments')loadMomentsPage()}catch(e){}
    return{ok:true}
  }catch(e){return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}
/* ── 点赞局部 UI 同步（增量 patch，替代"点赞成功 → loadMomentsPage 全量刷新"） ──
   只更新受影响卡片上的点赞按钮（旧版 mom-card / 社交网络 net-card 双契约），
   不重建列表：保住 _momentsFeedShown 展开状态、DOM 高度与滚动位置；
   卡片不在当前文档（未渲染/被分页收起/处于其他视图）时静默跳过。 */
function _momentsPatchLikeUI(id,likes){
  try{
    const mid=String(id||'');
    if(!mid||typeof document==='undefined')return false;
    if(!/^[\w\-]+$/.test(mid))return false;/* data-id 仅拼安全字符，防选择器注入 */
    let card=null;
    try{card=document.querySelector('.mom-card[data-id="'+mid+'"]')}catch(e){card=null}
    if(!card){try{card=document.querySelector('.net-card[data-id="'+mid+'"]')}catch(e2){card=null}}
    if(!card)return false;
    const arr=Array.isArray(likes)?likes:[];
    let uid='user';try{uid=_activeUserId()}catch(e){}
    const liked=arr.indexOf(uid)>=0;
    let btn=null;
    try{btn=card.classList.contains('mom-card')?card.querySelector('.mom-actions .mom-action-btn'):null}catch(e3){btn=null}
    if(btn&&!btn.classList.contains('mom-del')){btn.className='mom-action-btn'+(liked?' liked':'');btn.textContent=(liked?'♥ ':'♡ ')+(arr.length?arr.length:'')}
    try{btn=card.classList.contains('net-card')?card.querySelector('.net-actions .net-action'):null}catch(e4){btn=null}
    if(btn){btn.className='net-action'+(liked?' is-liked':'');btn.textContent=(liked?'♥ ':'♡ ')+arr.length}
    return true
  }catch(e){return false}
}
async function likeMoment(id,likerId){
  try{
    const m=await getMoment(id);if(!m)return{ok:false,error:'动态不存在'};
    const who=String(likerId||_activeUserId());
    if(_momentIsUserAuthor(m)?who===String(m.authorId||_activeUserId()):who===_momentsAuthorRoleId(m))return{ok:false,error:'作者不能点赞自己'};/* 作者不能给自己点赞 */
    const i=m.likes.indexOf(who);
    if(i>=0){
      if(who===_activeUserId())m.likes.splice(i,1);/* 用户可取消；AI 点赞不撤销 */
      else return{ok:true,liked:true,count:m.likes.length}
    }else m.likes.push(who);
    await dbPut(MOMENT_STORE,m);
    /* 局部 patch（勿改回 loadMomentsPage：全量刷新会重置 Feed 分页展开状态并造成滚动瞬移） */
    try{_momentsPatchLikeUI(m.id,m.likes)}catch(e){}
    return{ok:true,liked:i<0,count:m.likes.length}
  }catch(e){return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}
/* ══════════ 朋友圈评论区撤回（v7.1）：AI 评论 @ 错人 / 与已有评论重复 → 改写为"撤回了一条评论"占位 ══════════
   评论输出是 JSON（publishComment），不嵌 XML 标签，故评论区走规则型撤回（与聊天规则兜底一致）；
   撤回后保留占位（位置不变），渲染显示"（XX 撤回了一条评论）"。 */
function _momentsCommentShouldWithdraw(comment,moment){
  try{
    if(!comment||comment.authorType!=='role')return false;
    const t=String(comment.content||'');if(!t)return false;
    const selfCfg=_momentsCfg(comment.authorId||'');
    const selfName=selfCfg?(selfCfg.nickname||selfCfg.model||''):'';
    const names=new Set((apiConfigs||[]).map(function(c){return String(c.nickname||c.model||'')}).filter(Boolean));
    const ats=t.match(/[@＠]([^\s@＠]+)/g)||[];
    for(const a of ats){const n=String(a).replace(/^[@＠]/,'').trim();if(n&&(!names.has(n)||(selfName&&n===selfName)))return true}
    for(const x of ((moment&&moment.comments)||[])){if(x!==comment&&x&&x.authorId===comment.authorId&&_activeTextSimilarity(String(x.content||''),t)>=MOMENT_COMMENT_SIMILARITY)return true}
    return false;
  }catch(e){return false}
}

async function addMomentComment(id,data){
  try{
    const c={id:_momentsId('mc'),authorType:data&&data.authorType==='role'?'role':'user',authorId:String((data&&data.authorId)||'user'),content:String(data&&data.content||'').trim().slice(0,600),replyTo:String(data&&data.replyTo||'').trim().slice(0,80),createdAt:new Date().toISOString()};
    if(!c.content)return{ok:false,error:'评论不能为空'};
    const m=await getMoment(id);if(!m)return{ok:false,error:'动态不存在'};
    /* 同评论者同内容去重 */
    if(m.comments.some(x=>x.authorId===c.authorId&&_activeTextSimilarity(x.content,c.content)>=MOMENT_COMMENT_SIMILARITY))return{ok:false,error:'评论重复'}
    /* 评论区撤回（规则型）：AI 评论 @ 错人/重复 → 改写为撤回占位（保留位置） */
    if(c.authorType==='role'&&_momentsCommentShouldWithdraw(c,m)){
      const _rcf=_momentsCfg(c.authorId||'');
      c.content='（'+(_rcf?(_rcf.nickname||_rcf.model||'AI'):'AI')+' 撤回了一条评论）';
      c.withdrawn=true;
    }
    m.comments.push(c);
    if(c.authorType==='user')_obsRec('user_comment',{momentId:id});
    await dbPut(MOMENT_STORE,m);
    try{if(currentPage==='moments')loadMomentsPage()}catch(e){}
    /* 评论区 @ 触发（v7.2）：评论里 @ 某角色 → 被 @ 者必回该评论 */
    try{_momentsMaybeMentionComment(m,c)}catch(e){}
    /* AI↔AI 回复链：任何新评论落库后推进下一步（幂等 + 单线程单计划，见 _momentsMaybeReplyChain） */
    try{_momentsMaybeReplyChain(id,c.id)}catch(e){}
    return{ok:true,comment:c,count:m.comments.length}
  }catch(e){return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}
/* 评论删除权限（v7.4，微信式）：动态作者（楼主）可删任何评论；评论者可删自己的；其他不可删。
   当前"用户"即查看者/发布者：用户发布的动态=楼主可全删；角色发布的动态下，用户只能删自己评论。
   另支持角色楼主自主删评（v7.5）：动态作者角色（asRoleId）可删自己动态下别人的评论。 */
function _momentsCanDeleteComment(m,c){
  try{
    if(!m||!c)return false;
    if(_momentIsUserAuthor(m))return true;/* 楼主：用户发布的动态，可删任何评论 */
    return c.authorType==='user'&&String(c.authorId||'')===String(_activeUserId());/* 自己删自己的评论 */
  }catch(e){return false}
}
function _momentsAuthorCanDelete(m,c,authorRoleId){
  try{
    if(!m||!c||!authorRoleId)return false;
    if(_momentIsUserAuthor(m))return false;/* user 动态走 _momentsCanDeleteComment */
    if(String(_momentsAuthorRoleId(m))!==String(authorRoleId))return false;/* 仅动态作者角色 */
    return String(c.authorId||'')!==String(authorRoleId);/* 楼主可删别人的评论（不删自己） */
  }catch(e){return false}
}
async function deleteMomentComment(momentId,commentId,actorRoleId){
  try{
    const m=await getMoment(momentId);if(!m)return{ok:false,error:'动态不存在'};
    const c=(m.comments||[]).find(x=>x.id===commentId);if(!c)return{ok:false,error:'评论不存在'};
    if(!(_momentsCanDeleteComment(m,c)||_momentsAuthorCanDelete(m,c,actorRoleId)))return{ok:false,error:'仅发布者可删除此评论'};
    m.comments=m.comments.filter(x=>x.id!==commentId);
    await dbPut(MOMENT_STORE,m);
    try{if(currentPage==='moments')loadMomentsPage()}catch(e){}
    return{ok:true}
  }catch(e){return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}
/* 楼主自主删评执行（v7.5）：解析回复 JSON 里的 delComments[]，删除该动态下"别人"的评论（仅作者角色可删） */
async function _momentsApplyDelComments(moment,momentId,commenterRoleId,raw){
  try{
    if(!moment||String(commenterRoleId||'')!==String(_momentsAuthorRoleId(moment)))return false;
    const j=_activeParsePlanJson(raw);if(!j||!Array.isArray(j.delComments))return false;
    let n=0;
    for(const cid of j.delComments){
      const c=(moment.comments||[]).find(x=>String(x.id)===String(cid));
      if(c&&_momentsAuthorCanDelete(moment,c,commenterRoleId)){const r=await deleteMomentComment(momentId,String(cid),commenterRoleId);if(r.ok)n++}
    }
    return n>0;
  }catch(e){return false}
}

/* ══════════ 上下文与 Prompt Builder（与 Diary 同构，独立于业务逻辑） ══════════ */
async function _momentsContext(character){
  try{
    const [memories,recentProactive,about,summaryItem,recent,recentOwn,others]=await Promise.all([
      _activeRecentMemories(character.id,''),
      _activeRecentProactiveMessages(character.id),
      dbGet('about','main').catch(()=>null),
      dbGet('chatSummaries','sum_'+character.id).catch(()=>null),
      _activeRecentMessages(character.id),
      _momentsRecentOwn(character.id,5),
      _momentsRecentOthers(character.id)
    ]);
    const userName=(about&&about.name)||_cachedUserName||'用户';
    /* 角色私信记忆注入：只取当前角色自己的命名空间（owner=characterId，查询层过滤），作为独立字段供 Prompt 区块使用 */
    const roleLetterMemories=(typeof window._rlMemoriesFor==='function')?(await window._rlMemoriesFor(character.id)):[];
    return{user:{id:_activeUserId(),name:userName},character:character,recentMessages:recent,memories:memories,roleLetterMemories:roleLetterMemories,recentProactiveMessages:recentProactive,chatSummary:String(summaryItem&&summaryItem.summary||'').slice(0,1200),recentMoments:recentOwn,otherRoleMoments:others,lastInteractionAt:recent.reduce((v,m)=>Math.max(v,Number(m.timestamp||0)),0)}
  }catch(e){return{user:{name:'用户'},character:character,recentMessages:[],memories:[],recentProactiveMessages:[],chatSummary:'',recentMoments:[],otherRoleMoments:[],lastInteractionAt:0}}
}
async function _momentsRecentOwn(roleId,limit){
  return (await getRoleMoments(roleId)).slice(0,limit||5)
}
/* 其他角色最近动态（仅公开 all 可见的动态；视 otherRolesVisible 偏好；有界扫描：24h 窗口 + 条数上限） */
async function _momentsRecentOthers(roleId,limit){
  try{
    const scanned=await _momentsScanDesc(MOMENT_CTX_SCAN_MAX);
    const dayAgo=new Date(Date.now()-24*3600000).toISOString();
    return scanned.filter(m=>m&&m.roleId!==roleId&&m.visibility==='all'&&String(m.createdAt||'')>=dayAgo)
      .sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,limit||8)
  }catch(e){return[]}
}
/* 发布朋友圈 Prompt：角色设定 + 时间 + 最近聊天 + Memory + 最近朋友圈 + 最近主动消息 + 其他角色动态 + 关系 + 用户近况 */
function buildMomentPrompt(args){
  const character=args&&args.character||{},ctx=(args&&args.context)||{};
  const characterName=character.nickname||character.model||'AI',userName=(ctx.user&&ctx.user.name)||'用户';
  const memories=(ctx.memories||[]).slice(0,8),recent=(ctx.recentMessages||[]).slice(-14),proactive=(ctx.recentProactiveMessages||[]).slice(-8);
  const ownMoments=(ctx.recentMoments||[]).slice(0,6),others=(ctx.otherRoleMoments||[]).slice(0,8);
  const memoryText=memories.length?memories.map(m=>'- '+(m.title?m.title+'：':'')+(m.content||m.summary)).join('\n'):'（没有可用的长期记忆）';
  const chatText=recent.length?recent.map(m=>'- '+(m.role==='user'?userName:characterName)+'：'+String(m.content||'').slice(0,400)).join('\n'):'（最近没有聊天）';
  const proactiveText=proactive.length?proactive.map((m,i)=>(i+1)+'. '+String(m.content||m).slice(0,300)).join('\n'):'（最近没有主动消息）';
  const ownText=ownMoments.length?ownMoments.map((m,i)=>(i+1)+'. '+m.createdAt.slice(5,10)+'「'+String(m.content||'').slice(0,120)+'」').join('\n'):'（还没有发过朋友圈）';
  const othersText=others.length?others.map(m=>'- '+(_momentIsUserAuthor(m)?(userName||_momentsUserDisplayName()):(function(){const c=_momentsCfg(_momentsAuthorRoleId(m));return c?(c.nickname||c.model||'另一角色'):'另一角色'})())+'：'+String(m.content||'').slice(0,150)).join('\n'):'（朋友们最近没有公开动态）';
  /* 常驻朋友名单：让角色随时知道"有哪些朋友可 @"，不依赖近期动态（解决"想点名却不知名字"） */
  const friendList=(apiConfigs||[]).filter(function(fr){return fr&&String(fr.id)!==String(character.id)}).map(function(fr){return String(fr.nickname||fr.model||'')}).filter(Boolean);
  const friendsText=friendList.length?friendList.join('、'):'（暂无其他朋友）';
  /* 动机层输入：距离上次发文 + 最近连续未发次数（只作上下文供模型自然感受，无强制发帖逻辑） */
  const lastPostAt=Number(args&&args.lastPostAt||0);
  const declineStreak=Math.max(0,Number(args&&args.declineStreak||0));
  let lastPostLabel='还没有发过朋友圈';
  if(lastPostAt>0){const h=Math.max(0,Math.round((Date.now()-lastPostAt)/3600000));lastPostLabel=h<1?'不到 1 小时前':(h<24?(h+' 小时前'):(Math.round(h/24)+' 天前'))}
  const today=new Date();
  const system=String(character.systemPrompt||'').slice(0,30000)
    +'\n\n你是「'+characterName+'」——一个有自己生活的人。此刻你正站在自己的生活里，朋友圈只是随手写下这一刻想说的话的地方：不是聊天消息，也不是写给别人的总结。不要解释自己是 AI，不要提及任何内部机制或运行细节；不要暴露 Memory 与"注入上下文"之类的信息。';
  const prompt=[
    '【此刻】先由内而外感受一下：此刻的你，想不想发一条朋友圈？想发就给出正文；不想发就简单说明原因。输出严格 JSON。',
    '【今天日期与时间】'+today.toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'}),
    '【角色设定】'+(character.systemPrompt||'（无）').slice(0,800),
    '【角色与用户的关系】'+(character.relationship||'尚未单独设定'),
    '【最近聊天摘要】'+String(ctx.chatSummary||'（暂无）').slice(0,900),
    '【最近聊天内容】'+chatText,
    '【相关长期记忆】'+memoryText,
    (ctx.roleLetterMemories&&ctx.roleLetterMemories.length&&typeof window._rlMemBlock==='function')?('【角色私信记忆】'+window._rlMemBlock(ctx.roleLetterMemories)):'',
    '【最近主动消息】'+proactiveText,
    '【我最近发过的朋友圈】'+ownText,
    '【朋友名单】你认识的朋友有：'+friendsText+'。',
    '【朋友们最近的动态】'+othersText,
    '【距离上次发文】'+lastPostLabel+(declineStreak>0?'；最近连续 '+declineStreak+' 次你都没有发，因为确实没什么想说的。这很正常，这次也一样：想发就发，不想发就不发':''),
    '【触发方式】'+(args.trigger==='manual'?'你正被用户邀请，此刻想分享点什么':'现在，看看自己有没有自然想分享的事'),
    '【发圈动机】先想"为什么"，再想"发什么"：',
    '1. 像真实的人那样感受：有没有一件具体的事、一个画面、一丝情绪，让你此刻自然冒出一句想说的话？依据可以是角色设定、记忆、最近聊天、最近主动消息、最近动态、朋友们的动态、当前时间、距离上次发文时间。',
    '2. 没有真实动机（比如今天就是个平常日子，没有具体的人事物支撑）→ {"publish":false,"motive":"none"}，并说明原因；这是正常结果，不是失败，不要为了"到时间了"硬造一件今天发生过的事。',
    '3. 有 → 从下面挑一个最贴切的动机：share 单纯想分享一件事 / daily_life 日常生活碎片 / emotion 某种自然情绪想表达 / reflection 对近期的事产生一点想法 / interaction 与用户或其他角色近期互动引发分享欲 / curiosity 看到或想到什么，想分享或讨论 / social_response 对近期社交事件自然回应。motive:"none" 时 publish 必须为 false。',
    '4. 正文必须从动机自然长出来——先有想说的话，再有这条动态；不要用"今天想和大家分享……""突然有感而发……""生活就是这样……""记录一下今天……"这类套话起头，除非角色本色如此。',
    '【写作要求】',
    '1. 第一人称，符合角色人格、口吻与日常习惯；内容是"这个角色自己发出来的"，不是 AI 总结。',
    '2. 写具体的小观察、小情绪、小念头，像真人的朋友圈；可以是疑问、感慨、细微的发现，不写成"今天我与用户进行了愉快的交流"这类总结句。',
    '3. 拒绝空泛模板："今天阳光很好""今天心情不错""时间过得好快"这类换任何角色都能发的句子不要出现——如果一条动态没有具体的人/事/物/场景支撑，直接 publish:false。',
    '4. 不要复读写过的内容、主动消息或最近动态；不要重复自己最近使用的开头；允许短句和碎片化表达。',
    '5. 正文 8-120 字，1-2 句，不配 hashtag，不加引用格式，不要使用聊天回复格式，不要称呼读者。',
    '6. 只输出一个 JSON 对象：{"publish":true/false,"content":"正文","visibility":"all"|"user"|"roles"|"private","visibleRoleIds":[],"motive":"share|daily_life|emotion|reflection|interaction|curiosity|social_response|none","wantImage":true/false,"imagePrompt":"想配图时的画面描述（≤120字）","reason":"不发布时说明原因（≤50字）"}',
    '7. visibility：默认 "all"；仅当内容不适合用户看到（如私人情绪）才用 "user" 或 "private"；指定给某些角色时用 "roles" 并填 visibleRoleIds。',
    '8. 今天没有值得分享的内容时必须 publish:false。宁可不发，也不要凑数；publish:false 是正常输出，不是失败。',
    '9. 是否配图（wantImage）：像真实的人一样判断"这条内容此刻会不会自然想配一张照片"。明确的对象/场景/视觉瞬间（奇怪的猫、小店、月亮、风景、食物、街角、刚买到的东西、做过的某件事）→ 自然适合配图；单纯情绪、一句话感想、内心反思、对某人的想念、很抽象的想法 → 通常不适合配图。',
    '10. wantImage=true 表示"这条内容从内容和情境上自然适合配一张图"，不是要求系统保证出图；判断不适合就 false，不要为了配图而配图，也不是每条都要配。',
    '11. imagePrompt：仅 wantImage=true 时填写（≤120 字）。写具体画面——画面里有什么、什么光线、什么视角，与正文和角色情境一致，像"手机随手拍/日常照片/生活记录"；不要描述任何内部机制，不要出现"AI生成"等系统内部术语，不要提及接口、引擎或其他服务选项，也不要广告、海报、Logo、UI 截图或过度精致的宣传照；若角色设定有明确审美，按其偏好调整。',
    '12. 用词自然：描述画面时直接说"照片里/画面里/梦里"，不要用"生成的图片""AI 生成""提示词"这类说法；如果这条动态没有配图，就不要提"图片"，只说你此刻想表达的画面。',
    '13. 点名朋友：如果此刻发的内容确实与某个朋友有关（想 @ TA、想让 TA 回应、刚提到 TA 的事），就在正文里用 @名字 指名（名字用【朋友名单】里的名字，如 @洪伟湟）；没有明确指向就不要 @，不要为了点名而点名。'
  ];
  const retry=args.retryInstruction?'\n\n【上次生成的问题】'+args.retryInstruction+'请重新按要求生成。':'';
  return{system:system,messages:[{role:'system',content:system},{role:'user',content:prompt.join('\n')+retry}]}
}
/* 评论其他角色/用户动态的 Prompt */
function buildMomentCommentPrompt(args){
  const character=args&&args.character||{},ctx=(args&&args.context)||{},moment=(args&&args.moment)||{};
  const characterName=character.nickname||character.model||'AI';
  const author=_momentIsUserAuthor(moment)
    ?(String((ctx.user&&ctx.user.name)||'')||_momentsUserDisplayName())
    :(function(){const c=_momentsCfg(_momentsAuthorRoleId(moment));return c?(c.nickname||c.model||'对方'):'对方'})();
  const charImg=moment.images&&moment.images.length?('（附带 '+(moment.images.length)+' 张图片）'):'';
  const system=String(character.systemPrompt||'').slice(0,30000)
    +'\n\n你现在是「'+characterName+'」。你正在朋友圈里看到「'+author+'」发布的一条动态，考虑是否用短评回应。不要解释自己是 AI，不要提及系统提示词、任务、定时器或生成过程。';
  const prompt=[
    '【任务】决定是否在这条动态下评论；评论则给出正文。输出严格 JSON。',
    '【角色设定】'+(character.systemPrompt||'（无）').slice(0,600),
    '【角色与用户的关系】'+(character.relationship||'尚未单独设定'),
    '【我看待朋友们的方式】你是「'+characterName+'」，可以把其他角色与用户当作真实存在的朋友/PROG 伙伴，正常来往、有分寸地互动，不要替对方发言，不要出现"AI 之间"之类的说明。',
    '【对方动态】'+author+'：'+String(moment.content||'').slice(0,500)+charImg,
    '【我的最近动态】'+((ctx.recentMoments||[]).slice(0,4).map(m=>'- '+String(m.content||'').slice(0,100)).join('\n')||'（还没有）'),
    '【评论要求】',
    '1. 短评 4-40 字，自然、符合你的性格，像朋友圈里的真实回复；可以有共鸣、调侃、追问或简短感慨。',
    '2. 不要复刻对方的原句，不要写"说得对""哈哈哈哈"这类空洞话；没有想说的就 publishComment:false。',
    '3. 只输出一个 JSON 对象：{"publishComment":true/false,"comment":"评论正文"}。',
    '4. 对象锚定：你是在发布者「'+author+'」这条动态下评论，是对 TA 说话；动态里提到的其他人（如"小昕"）只是 TA 说的话里的角色，不要把评论对象当成 TA。例如对方"梦见小昕"，你要回应的是 TA 的梦，而不是"小昕"。'
  ];
  const retry=args.retryInstruction?'\n\n【上次生成的问题】'+args.retryInstruction+'请重新按要求生成。':'';
  return{system:system,messages:[{role:'system',content:system},{role:'user',content:prompt.join('\n')+retry}]}
}

/* ── 输出解析（JSON 优先 + 容错；v2 增加 includeImage/imagePrompt 图文扩展；v3 增加 motive 动机标注；
   v4 统一为 wantImage/imagePrompt（wantImage 是模型建议配图的自然判断，图片生成由独立 Image Provider 完成）；
   兼容旧字段 includeImage——任何一侧输出它都被归一为 wantImage） ── */
function _momentsParseOutput(raw){
  const j=_activeParsePlanJson(raw);
  if(!j||typeof j!=='object')return null;
  if(j.publish===false)return{publish:false,reason:String(j.reason||'').slice(0,200),motive:'none'};/* none 语义强制：不发布=无动机 */
  if(j.publish!==true)return null;
  if(!String(j.content||'').trim())return null;
  const visibility=MOMENT_VIS.includes(j.visibility)?j.visibility:'all';
  /* motive 归一：缺失/非法/与 publish:true 矛盾（none）→ daily_life；motive 只是标注，不是发布资格门，不因它拒绝发布 */
  const motive=(MOMENT_MOTIVES.includes(j.motive)&&j.motive!=='none')?j.motive:'daily_life';
  /* wantImage 归一：模型对"是否自然适合配图"的建议；false/缺失都不生成图片（由 _momentsImageGate 再过滤） */
  const wantImage=j.wantImage===true||j.includeImage===true;
  return{publish:true,content:String(j.content||'').trim().slice(0,2000),visibility:visibility,
    visibleRoleIds:Array.isArray(j.visibleRoleIds)?j.visibleRoleIds.slice(0,20).map(String):[],
    wantImage:wantImage,
    imagePrompt:String(j.imagePrompt||'').trim().slice(0,600),
    reason:String(j.reason||'').slice(0,200),
    motive:motive}
}
function _momentsParseCommentOutput(raw){
  const j=_activeParsePlanJson(raw);
  if(!j||typeof j!=='object')return null;
  if(j.publishComment===false)return{publish:false};
  if(j.publishComment!==true)return null;
  if(!String(j.comment||'').trim())return null;
  return{publish:true,comment:String(j.comment||'').trim().slice(0,300)}
}

/* ── 去重：最近 N 条自己动态 + 最近主动消息 + 同一时间窗口 ── */
async function _momentsDuplicateCheck(roleId,content){
  const text=String(content||'').trim();if(!text)return null;
  const own=await _momentsRecentOwn(roleId,6);
  for(const old of own){
    if(_activeTextSimilarity(text,String(old.content||''))>=MOMENT_SIMILARITY)return old
  }
  const recent=await _activeRecentProactiveMessages(roleId);
  for(const p of recent){
    const old=String(p&&p.content!=null?p.content:p||'');
    if(old&&_activeTextSimilarity(text,old)>=MOMENT_SIMILARITY)return{content:old}
  }
  return null
}

/* ── 图片生成（复用现有 imageGen 链路 _wsExecImageGen；图片是增强，不是硬依赖） ──
   v4 语义：wantImage 只是"模型建议配图"（AI 建议，非强制出图）；真正出图由独立 Image Provider
   （cfg.imageGen + imageGenModel）完成，与文字模型完全解耦：文字模型不要求支持生图。
   任何失败 → 返回 []（调用方继续纯文字发布，绝不影响发文）。 */
function _momentsImageGate(cfg,parsed){
  if(!cfg||cfg.imageGen!==true)return false;
  /* 图片协议域：显式 imageGenProvider > 跟随文字 provider；文字不支持生图但填了生图模型 → 按模型名推断（与 _wsExecImageGen 一致） */
  const iprov=(typeof _imgResolveProvider==='function')?_imgResolveProvider(cfg):(String(cfg.imageGenProvider||'').trim().toLowerCase()||String(cfg.provider||'').toLowerCase());
  if(iprov==='anthropic'||iprov==='deepseek')return false;/* 与 _wsExecImageGen 一致的能力边界 */
  const hash=String(cfg.id||'').split('').reduce((n,c)=>n*31+c.charCodeAt(0),7)
    +String(parsed.content||'').split('').reduce((n,c)=>n+c.charCodeAt(0),0);
  return hash%100<MOMENT_IMAGE_PROB/* 概率门：防止每条动态都配图 */
}
async function _momentsRecentImagesBurst(roleId){
  try{
    const own=await _momentsRecentOwn(roleId,3);
    return own.length>=2&&own.every(m=>m.images&&m.images.length>0)/* 最近多条全是图 → 本次不配图 */
  }catch(e){return true}
}
/* 数据 URL 缩放（镜像 compressImage 的内核逻辑；输入来自生图接口而非 File） */
function _momentsShrinkDataUrl(dataUrl,maxPx,quality){
  return new Promise(resolve=>{
    try{
      const img=new Image();
      img.onload=function(){
        let w=img.width,h=img.height;
        if(w>maxPx||h>maxPx){const r=Math.min(maxPx/w,maxPx/h);w=Math.round(w*r);h=Math.round(h*r)}
        try{
          const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
          const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0,w,h);
          resolve(canvas.toDataURL('image/jpeg',quality||0.85))
        }catch(e){resolve(String(dataUrl))}
      };
      img.onerror=function(){resolve(String(dataUrl))};
      img.src=String(dataUrl)
    }catch(e){resolve(String(dataUrl))}
  })
}
async function _momentsMakeImage(cfg,parsed,force){
  try{
    /* wantImage 是模型建议，不是强制；不满足建议/能力/概率门任一条件都按"不配图"处理 */
    if(!(parsed&&(parsed.wantImage===true||parsed.includeImage===true)))return[];
    if(!force&&!_momentsImageGate(cfg,parsed))return[];
    if(await _momentsRecentImagesBurst(cfg&&cfg.id))return[];
    _obsRec('image_attempt',{actor:cfg&&cfg.id});
    const imagePrompt=String(parsed.imagePrompt||'').trim()||('A casual smartphone photo, natural light, everyday life: '+String(parsed.content||'').slice(0,160));
    const gen=await _wsExecImageGen(cfg,imagePrompt,'1024x1024');
    if(!(gen&&gen.ok&&gen.dataUrl)){
      /* 图片失败绝不拖垮发文：记录失败观测（含错误分类），调用方继续纯文字发布 */
      _obsRec('image_generation_failed',{actor:cfg&&cfg.id,reason_class:gen&&gen.reason?String(gen.reason).slice(0,60):'unknown'});
      console.warn('[Moments] 图片生成失败（保留文字动态）：'+String(gen&&gen.reason||'').slice(0,160));
      return[]
    }
    const shrunk=await _momentsShrinkDataUrl(gen.dataUrl,1024,0.85);
    _obsRec('image_ok',{actor:cfg&&cfg.id});
    return[{dataUrl:shrunk,base64:String(shrunk.split(',')[1]||''),mime:'image/jpeg',name:'AI生成图像.jpg',size:Math.round((shrunk.indexOf(',')>0?shrunk.length-shrunk.indexOf(',')-1:0)*0.75)}]
  }catch(e){
    _obsRec('image_generation_failed',{actor:cfg&&cfg.id,reason_class:String(e&&e.message||e).slice(0,60)});
    console.warn('[Moments] 图片生成异常（保留文字动态）：'+String(e&&e.message||e).slice(0,160));
    return[]
  }
}

/* ── 解析失败诊断（仅在解析失败路径调用）：只检查模型最终返回的 assistant 文本本身，
   不含 API Key / system prompt / Memory / 聊天历史等任何上下文 ── */
function _momentsDiagnoseOutput(raw){
  const s=String(raw==null?'':raw);
  const info={outType:typeof raw,len:s.length,hasFence:/```/.test(s),hasBrace:s.indexOf('{')>=0,preview:''};
  const t=s.trim();
  if(!t){info.stage='empty-output';return info}/* 空输出：常见于推理型模型把 maxTokens 耗在思考上，或适配器未取到 content */
  info.preview=t.slice(0,240);
  const j=_activeParsePlanJson(t);
  if(!j){
    if(s.indexOf('{')<0)info.stage='no-json-object';/* 纯自然语言（jsonMode 未生效或模型不遵守） */
    else info.stage='json-parse-failed';/* 有大括号但截断/畸形 */
    return info
  }
  if(j.publish!==true&&j.publish!==false)info.stage='schema-publish-not-boolean';/* 如 "publish":"true" 字符串 */
  else if(j.publish===true&&!String(j.content||'').trim())info.stage='schema-empty-content';
  else info.stage='parsed-but-unexpected';
  return info
}

/* ══════════ 图片注入（v5）：朋友圈里的图片作为图像注入给支持视觉的角色 ══════════
   原则：文字模型不要求能看图——不能看的角色保持现有纯文字上下文（行为零变化）；
   能看的角色（cfg.vision / provider 默认 vision / DeepSeek 原生 vision）收到 image parts；
   DeepSeek 文本模型走本地视觉服务把"描述文本"注入（与聊天附件同一策略）。
   任何注入失败都静默降级为纯文本，绝不影响生成/评论主流程。 */
function _momentsVisionKind(cfg){
  try{
    if(!cfg)return null;
    if(typeof _usesNativeDeepSeekVision==='function'&&_usesNativeDeepSeekVision(cfg))return'deepseek_native';
    if(typeof _usesLocalDeepSeekVision==='function'&&_usesLocalDeepSeekVision(cfg))return'deepseek_local';
    /* 默认放行：多模态已普遍（cfg.vision 未显式设置即视为支持视觉直发）；cfg.vision===false 才拒绝 */
    return (cfg.vision!==undefined)?(!!cfg.vision?'native':null):'native';
  }catch(e){return null}
}
function _momentsImagePayload(im){
  const src=String(im&&im.dataUrl||'').trim();
  if(src.slice(0,5)!=='data:'||src.length>3e6)return null;
  const mime=(String(src.match(/^data:([^;,]+)/i)||[])[1]||'')||String(im&&im.mime||'').trim()||'image/jpeg';
  const base64=String(im&&im.base64||'').trim()||String(src.split(',')[1]||'');
  return base64?{dataUrl:src,base64:base64,mime:mime}:null;
}
/* 在最后一条 user 消息上追加文本（兼容 content 为数组的情况：更新 text part，保留图片 parts） */
function _momentsAppendNote(msg,note){
  try{
    if(Array.isArray(msg.content)){
      const t=msg.content.find(p=>p&&p.type==='text');
      if(t){t.text+=String(note||'');return}
      msg.content.unshift({type:'text',text:String(note||'')});return
    }
    msg.content=String(msg.content||'')+String(note||'');
  }catch(e){msg.content=String(msg.content||'')+String(note||'')}
}
/* 把图片注入到 message（最后一条 user 消息，content 转 parts 数组）。返回注入张数（0=未注入/不可用） */
async function _momentsInjectImages(cfg,message,images,note){
  try{
    if(!message||!Array.isArray(images)||!images.length)return 0;
    const payloads=images.map(_momentsImagePayload).filter(Boolean).slice(0,2);
    if(!payloads.length)return 0;
    const kind=_momentsVisionKind(cfg);
    if(!kind)return 0;
    const baseText=String(typeof message.content==='string'?message.content:((message.content&&typeof message.content==='object'&&message.content.text)||''));
    const injNote=String(note||'').trim();
    if(kind==='deepseek_local'){
      /* 本地视觉服务：把识别描述以文本注入（deepseek 文本模型不接收 image parts） */
      try{
        if(typeof _describeImagesLocally!=='function')return 0;
        const desc=await _describeImagesLocally(payloads,baseText.slice(0,200));
        if(!desc)return 0;
        message.content=baseText+(injNote?('\n\n'+injNote):'')+'\n\n[图像参考（本地视觉识别）] '+String(desc).slice(0,2000);
        return payloads.length;
      }catch(e){return 0}
    }
    const parts=[{type:'text',text:baseText+(injNote?('\n\n'+injNote):'')}];
    payloads.forEach(p=>parts.push({type:'_image',base64:p.base64,mime:p.mime}));
    message.content=parts;
    return payloads.length;
  }catch(e){return 0}
}

/* ══════════ AI 自主发布 ══════════ */
async function generateRoleMoment(roleId,opts){
  opts=opts||{};
  try{
    const cfg=_momentsCfg(roleId);
    if(!cfg)return{ok:false,error:'角色配置不存在'};
    if(!_ibApiReady(cfg))return{ok:false,error:'角色 API 配置不完整'};
    const st=_momentsState()[roleId]||{};
    const context=await _momentsContext(cfg);
    const built=buildMomentPrompt({character:cfg,context:context,trigger:opts.trigger||'schedule',declineStreak:Number(st.declineStreak||0),lastPostAt:Number(st.lastPostAt||0)});
    /* 图片注入：朋友最近带图的动态（+自己最近带图的动态）→ 支持视觉的角色以图像参考（cap 2 张，失败静默） */
    try{
      const injImages=[];
      (context.otherRoleMoments||[]).forEach(m=>{if(injImages.length<2&&m&&m.images&&m.images[0]&&String(m.images[0].dataUrl||'').slice(0,5)==='data:')injImages.push(m.images[0])});
      if(injImages.length<2)(context.recentMoments||[]).forEach(m=>{if(injImages.length<2&&m&&m.images&&m.images[0]&&String(m.images[0].dataUrl||'').slice(0,5)==='data:')injImages.push(m.images[0])});
      if(injImages.length){
        const injected=await _momentsInjectImages(cfg,built.messages[built.messages.length-1],injImages,'【图片参考】你最近看到的朋友动态（或自己发过的动态）携带图片，请先查看图片再感受此刻想分享什么。');
        if(injected>0)_obsRec('image_inject',{actor:roleId,kind:'moment',count:injected});
      }
    }catch(e){/* 图片注入失败 → 纯文本上下文，不影响生成 */
      console.warn('[Moments] image inject failed (text fallback):',String(e&&e.message||e).slice(0,120));
    }
    let raw='',lastError=null,genBudget=MOMENT_GEN_MAX_TOKENS;
    for(let attempt=0;attempt<MOMENT_MAX_ATTEMPTS;attempt++){
      try{
        raw=await _obsCall('moment',cfg,built.messages,{maxTokens:genBudget,timeoutMs:120000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true});
      }catch(e){lastError=e;break}
      const parsed=_momentsParseOutput(raw);
      if(!parsed||parsed.publish===false){
        if(parsed&&parsed.publish===false){
          /* 模型选择不发布：今天是静默的一天；declineStreak 只累计上下文，绝不强制发布 */
          _obsRec('post_declined',{actor:roleId,origin:'local',trigger:opts.trigger||'schedule',reason:String(parsed.reason||'').slice(0,60),motive:'none'});
          _momentsSetState(roleId,{declineStreak:(Number(st.declineStreak||0)||0)+1});
          console.info('[Moments] '+String(cfg.nickname||cfg.model||'AI')+' 选择不发布：'+(parsed.reason||''));
          return{ok:true,published:false,reason:String(parsed.reason||'').slice(0,200),motive:'none'}
        }
        if(attempt===0){
          const __diag=_momentsDiagnoseOutput(raw);
          console.warn('[Moments] output unparseable (retrying):',JSON.stringify(__diag));
          lastError=new Error('输出无法解析');
          if(__diag.stage==='empty-output')genBudget=Math.min(8000,MOMENT_GEN_MAX_TOKENS*2);/* 推理吃满预算 → 提额重试（提示词无法解决 token 耗尽） */
          _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【注意】上次输出不符合要求。请只输出一个 JSON 对象：{"publish":布尔,"content":"正文","visibility":"all|user|roles|private","visibleRoleIds":[],"motive":"share|daily_life|emotion|reflection|interaction|curiosity|social_response|none","wantImage":布尔,"imagePrompt":"想配图时的画面描述","reason":""}。');
          continue
        }
        console.warn('[Moments] output unparseable:',JSON.stringify(_momentsDiagnoseOutput(raw)));
        break
      }
      const dup=await _momentsDuplicateCheck(roleId,parsed.content);
      if(dup&&attempt===0){
        _obsRec('dedupe',{kind:'moment',actor:roleId});
        _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【注意】这条内容与最近发过的东西太相似（「'+String(dup.content||'').slice(0,40)+'」），请换一个角度、观察或情绪，完全重新写。');
        continue
      }
      if(dup){
        _obsRec('dedupe',{kind:'moment',actor:roleId});
        lastError=new Error('与最近发布内容过于相似');
        break
      }
      /* 图文增强：wantImage 只是模型建议；能力/概率允许 → 独立 Image Provider 生图+压缩；失败保留纯文字（图片非硬依赖）。
         opts.forceImage=true 仅测试/手动调用时绕过概率门 */
      const images=await _momentsMakeImage(cfg,parsed,opts.forceImage===true);
      const res=await createMoment({roleId:roleId,content:parsed.content,images:images,visibility:parsed.visibility,visibleRoleIds:parsed.visibleRoleIds,source:'proactive',motive:parsed.motive});
      if(!res.ok)return res;
      _obsRec('post',{actor:roleId,origin:'local',vis:parsed.visibility,trigger:opts.trigger||'schedule',motive:parsed.motive,wantImage:parsed.wantImage===true,imageGenerated:(images&&images.length>0)});
      _momentsSetState(roleId,{lastPostAt:Date.now(),declineStreak:0});/* 发布成功 → 连续未发归零 */
      return{ok:true,published:true,moment:res.moment,imageAttempted:parsed.wantImage===true,wantImage:parsed.wantImage===true,imageGenerated:(images&&images.length>0),motive:parsed.motive}
    }
    return{ok:false,error:lastError?String(lastError.message||lastError).slice(0,200):'生成失败'}
  }catch(e){console.warn('[Moments] generate failed',String(e&&e.message||e).slice(0,200));return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}

/* ══════════ AI 评论其他角色 ══════════ */
async function generateRoleComment(commenterRoleId,momentId){
  try{
    const prefs=_momentsPrefs();if(!prefs.aiComment)return{ok:false,error:'AI 评论已关闭'};
    const cfg=_momentsCfg(commenterRoleId);if(!cfg)return{ok:false,error:'角色配置不存在'};
    if(!_ibApiReady(cfg)){_obsRec('block',{kind:'comment',actor:commenterRoleId,reason:'api_not_ready'});return{ok:false,error:'角色 API 配置不完整'}}
    const moment=await getMoment(momentId);if(!moment)return{ok:false,error:'动态不存在'};
    if(!_momentIsUserAuthor(moment)&&_momentsAuthorRoleId(moment)===String(commenterRoleId)){_obsRec('block',{kind:'comment',actor:commenterRoleId,reason:'self'});return{ok:false,error:'不能评论自己的动态'}}
    if(!_momentsVisibleToRole(moment,commenterRoleId)){_obsRec('block',{kind:'comment',actor:commenterRoleId,reason:'invisible'});return{ok:false,error:'不可见'}}
    if(moment.comments.some(c=>c.authorType==='role'&&c.authorId===commenterRoleId)){_obsRec('block',{kind:'comment',actor:commenterRoleId,reason:'already_commented'});return{ok:false,error:'已评论过'}}
    const state=(_momentsState()[commenterRoleId]||{});
    if(state.lastCommentAt&&Date.now()-state.lastCommentAt<MOMENT_COMMENT_COOLDOWN){_obsRec('block',{kind:'comment',actor:commenterRoleId,reason:'cooldown'});return{ok:false,error:'冷却中'}};
    const context=await _momentsContext(cfg);
    const built=buildMomentCommentPrompt({character:cfg,context:context,moment:moment});
    /* 图片注入：被评论动态携带图片 → 支持视觉的角色先看图再决定评论内容（失败静默纯文本） */
    try{
      if(moment.images&&moment.images.length){
        const injected=await _momentsInjectImages(cfg,built.messages[built.messages.length-1],moment.images.slice(0,2),'【附带图片】本条动态携带图片，请先查看图片内容，再决定是否评论以及评论什么。');
        if(injected>0)_obsRec('image_inject',{actor:commenterRoleId,kind:'comment',count:injected,momentId:momentId});
      }
    }catch(e){console.warn('[Moments] comment image inject failed (text fallback):',String(e&&e.message||e).slice(0,120))}
    let raw='',lastError=null;
    for(let attempt=0;attempt<MOMENT_MAX_ATTEMPTS;attempt++){
      try{
        raw=await _obsCall('comment',cfg,built.messages,{maxTokens:300,timeoutMs:90000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true})
      }catch(e){lastError=e;break}
      const parsed=_momentsParseCommentOutput(raw);
      if(!parsed||parsed.publish===false){
        if(parsed&&parsed.publish===false)return{ok:true,published:false,reason:'选择不评论'};
        if(attempt===0){
          lastError=new Error('评论输出无法解析');
          _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【注意】请只输出一个 JSON 对象：{"publishComment":true/false,"comment":"短评"}。');
          continue
        }
        break
      }
      /* 评论去重：与本条已有评论、自己最近 3 条评论比较（有界扫描） */
      const scanned=await _momentsScanDesc(120);
      let recentMine=[];
      for(const m of scanned){for(const c of (m.comments||[])){if(c.authorType==='role'&&c.authorId===commenterRoleId)recentMine.push(c.content)}}
      const seen=[...(moment.comments||[]).map(c=>c.content),...recentMine.slice(-3)];
      if(seen.some(t=>t&&_activeTextSimilarity(parsed.comment,t)>=MOMENT_COMMENT_SIMILARITY)){
        if(attempt===0){
          _obsRec('dedupe',{kind:'comment',actor:commenterRoleId});
          _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【注意】这条评论与已有内容太相似，请换一个说法。');
          continue
        }
        _obsRec('dedupe',{kind:'comment',actor:commenterRoleId});
        lastError=new Error('评论与已有内容相似');
        break
      }
      const res=await addMomentComment(momentId,{authorType:'role',authorId:commenterRoleId,content:parsed.comment});
      if(!res.ok)return res;
      _obsRec('comment',{actor:commenterRoleId,target:_momentIsUserAuthor(moment)?OBS_USER:_momentsAuthorRoleId(moment),momentId:momentId});
      _momentsSetState(commenterRoleId,{lastCommentAt:Date.now()});
      _momentsCommentLogRecord(commenterRoleId,Date.now());/* 首层评论同样计入角色小时/日频控 */
      return{ok:true,published:true,comment:res.comment}
    }
    return{ok:false,error:lastError?String(lastError.message||lastError).slice(0,200):'评论生成失败'}
  }catch(e){console.warn('[Moments] comment failed',String(e&&e.message||e).slice(0,200));return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}
/* ══════════ 朋友圈 @ 点名（v7）：AI 发帖 @ 其他 AI → 被 @ 者必须在该动态下评论 ══════════
   语义：
   - 动态正文含 @昵称/＠昵称（匹配角色 nickname/model，排除作者自己）→ 被点名角色**强制**评论；
   - 强制 = 豁免常规评论冷却/频控（force）+ prompt 强约束（指名回应）+ 空输出提额重试一次；
   - 防刷屏：同角色"被 @ 的必回"之间至少 2 分钟（独立账本，不改回复链既有频控）；同一动态对每角色最多一次；
   - 触发点统一在动态落库处（浏览器 createMoment + Companion 事件 _momentsIngestEvent），前后台一致；
   - AI 评论总开关（aiComment=false）关闭时同样不触发（一致性）。 */
const MOMENT_MENTION_COOLDOWN=120000;/* @ 必回冷却：2 分钟 */
const MOMENT_MENTION_LOG_KEY='ib_moments_mention_v1';
function _momentsMentionLog(){
  try{const v=JSON.parse(localStorage.getItem(MOMENT_MENTION_LOG_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}
}
/* 消费式：true=本次可触发"必回"（并记录时间戳）；false=冷却窗口内不升级 */
function _momentsMentionCanForce(roleId){
  try{
    const lg=_momentsMentionLog(),now=Date.now();
    for(const k of Object.keys(lg)){if(now-Number(lg[k]||0)>86400000)delete lg[k]}
    const last=Number(lg[String(roleId)]||0);
    if(now-last<MOMENT_MENTION_COOLDOWN)return false;
    lg[String(roleId)]=now;
    localStorage.setItem(MOMENT_MENTION_LOG_KEY,JSON.stringify(lg));
    return true;
  }catch(e){return true}
}
/* 解析动态正文 @昵称/＠昵称 → 被点名角色 id 数组（排除作者自己与不存在的角色） */
function _momentsParseMentions(content,authorRoleId){
  try{
    const t=String(content||'');if(!t)return[];
    const out=[];
    (apiConfigs||[]).forEach(function(c){
      if(!c||String(c.id)===String(authorRoleId||''))return;
      const nm=String(c.nickname||c.model||'');
      if(nm&&(t.indexOf('@'+nm)!==-1||t.indexOf('＠'+nm)!==-1))out.push(String(c.id));
    });
    return out;
  }catch(e){return[]}
}
/* 落库后触发：对每个被 @（且冷却通过、未评论过）的角色发起强制评论（延迟，防同帧）；生成失败静默 */
function _momentsMaybeMention(moment){
  try{
    if(!moment||!moment.id||!moment.content)return;
    const author=_momentIsUserAuthor(moment)?'':_momentsAuthorRoleId(moment);
    const mentioned=_momentsParseMentions(moment.content,author);
    if(!mentioned.length)return;
    for(const rid of mentioned){
      if(!_momentsMentionCanForce(rid))continue;
      if((moment.comments||[]).some(c=>c.authorType==='role'&&String(c.authorId)===String(rid)))continue;/* 已评过 */
      setTimeout(function(){
        Promise.resolve(generateRoleReply(rid,moment.id,{force:true,mention:true}))
          .then(function(r){_obsRec('mention_reply',{actor:rid,momentId:moment.id,ok:!!(r&&r.ok&&r.published)})})
          .catch(function(){})
      },1200+Math.random()*1800);
    }
  }catch(e){console.warn('[Moments] mention trigger failed',String(e&&e.message||e).slice(0,120))}
}
/* 评论区 @ 触发（v7.2）：评论里 @ 某角色 → 被 @ 者必回该评论（force + mention + 2 分钟冷却） */
function _momentsMaybeMentionComment(moment,comment){
  try{
    if(!moment||!comment||!comment.id||!comment.content)return;
    const author=comment.authorType==='user'?'':String(comment.authorId||'');
    const mentioned=_momentsParseMentions(comment.content,author);
    if(!mentioned.length)return;
    for(const rid of mentioned){
      if(!_momentsMentionCanForce(rid))continue;
      if((moment.comments||[]).some(c=>c.authorType==='role'&&String(c.authorId)===String(rid)))continue;/* 已评过 */
      setTimeout(function(){
        Promise.resolve(generateRoleReply(rid,moment.id,{force:true,mention:true,replyTo:comment.id}))
          .then(function(r){_obsRec('mention_reply',{actor:rid,momentId:moment.id,kind:'comment_mention',ok:!!(r&&r.ok&&r.published)})})
          .catch(function(){})
      },1200+Math.random()*1800);
    }
  }catch(e){console.warn('[Moments] comment mention trigger failed',String(e&&e.message||e).slice(0,120))}
}
/* 动态创建后的评论触发（有限：每动态 ≤2 评论者、每评论者冷却、不评论也不强求） */
function _momentsMaybeComment(moment){
  try{
    if(!moment)return;/* 用户动态与角色动态都走同一条触发管线（延迟/上限/冷却不变） */
    const prefs=_momentsPrefs();if(!prefs.aiComment)return;
    const q=_momentsCommentQ();
    if(q[moment.id]&&Date.now()-q[moment.id]<3600000)return;
    _momentsSetCommentQ(moment.id);
    const delay=20000+Math.floor(Math.random()*40000);
    setTimeout(async()=>{
      try{
        const fresh=await getMoment(moment.id);if(!fresh)return;
        const partnerKey=_momentIsUserAuthor(fresh)?String(fresh.authorId||_activeUserId()):_momentsAuthorRoleId(fresh);
        const authors=fresh.comments.filter(c=>c.authorType==='role').map(c=>c.authorId);
        const candidates=apiConfigs.filter(c=>c.id!==partnerKey&&_ibApiReady(c)&&!authors.includes(c.id)&&_momentsVisibleToRole(fresh,c.id));
        if(!candidates.length)return;
        const state=_momentsState(),pool=candidates.filter(c=>!(state[c.id]&&state[c.id].lastCommentAt&&Date.now()-state[c.id].lastCommentAt<MOMENT_COMMENT_COOLDOWN));
        if(candidates.length>pool.length)_obsRec('block',{kind:'comment',reason:'cooldown_prefilter',n:candidates.length-pool.length});
        if(!pool.length)return;
        /* 角色对亲和度：并非每个人都对每条动态有话想说；没有想开口的人就不评论（正常情况） */
        const social=pool.filter(c=>_momentsHash(String(fresh.id)+'\u0003'+c.id)%100<_momentsPairAffinity(c.id,partnerKey));
        const picked=[];
        while(social.length&&picked.length<MOMENT_COMMENT_MAX_PER){
          const i=Math.floor(Math.random()*social.length);picked.push(social.splice(i,1)[0])
        }
        for(const c of picked){await generateRoleComment(c.id,fresh.id)}
      }catch(e){console.warn('[Moments] comment trigger failed',String(e&&e.message||e).slice(0,200))}
    },delay)
  }catch(e){}
}

/* ══════════ 朋友圈 @ 补全（v7）：compose 输入 @ 弹出角色候选，点击/回车插入昵称 ══════════
   交互：输入半/全角 @ 后浮现候选（按昵称/模型名匹配），↑↓ 选择、Enter/Tab 插入、Esc 关闭；
   插入后在被 @ 位置还原为 @昵称，供 _momentsParseMentions 精确命中。纯前端，零后端改动。 */
let _momMentionList=[],_momMentionIdx=-1;
function _momComposeMentionBox(){return document.getElementById('mom-compose-mention')}
function _momMentionPrefix(ta){
  try{
    const pos=(ta&&ta.selectionStart!=null)?ta.selectionStart:((ta&&ta.value)||'').length;
    const before=String(ta&&ta.value||'').slice(0,pos);
    const m=before.match(/(@|＠)([^\s@＠]*)$/);
    return m?{idx:m.index,at:m[1],typed:m[2]}:null;
  }catch(e){return null}
}
function _momMentionCandidates(typed){
  try{
    const q=String(typed||'');
    return (apiConfigs||[]).map(function(c){return{id:String(c.id),name:String(c.nickname||c.model||'')}})
      .filter(function(x){return x.name&&(!q||x.name.indexOf(q)>=0)}).slice(0,8);
  }catch(e){return[]}
}
function _momComposeMentionHide(){const b=_momComposeMentionBox();if(b)b.hidden=true;_momMentionList=[];_momMentionIdx=-1}
function _momComposeMentionInsert(c){
  try{
    const ta=document.getElementById('mom-compose-text');if(!ta||!c)return;
    const pre=_momMentionPrefix(ta);let v=ta.value;
    if(pre){const end=pre.idx+pre.at.length+pre.typed.length;v=v.slice(0,pre.idx)+'@'+c.name+' '+v.slice(end)}
    else v=(v?v.trimEnd()+' ':'')+'@'+c.name+' ';
    ta.value=v;
    const pos=pre?(pre.idx+1+c.name.length+1):v.length;
    try{ta.focus();ta.selectionStart=ta.selectionEnd=pos}catch(e){}
    _momComposeMentionHide();
    ta.dispatchEvent(new Event('input',{bubbles:true}));
  }catch(e){}
}
function _momComposeMentionRender(){
  try{
    const b=_momComposeMentionBox(),ta=document.getElementById('mom-compose-text');
    if(!b||!ta){return}
    const pre=_momMentionPrefix(ta);
    if(!pre){_momComposeMentionHide();return}
    const cands=_momMentionCandidates(pre.typed);
    if(!cands.length){_momComposeMentionHide();return}
    _momMentionList=cands;
    if(_momMentionIdx>=cands.length)_momMentionIdx=-1;
    b.innerHTML='';
    const lbl=document.createElement('div');lbl.className='mom-mention-label';lbl.textContent='@ 提及';b.appendChild(lbl);
    cands.forEach(function(c,i){
      const r=document.createElement('button');r.type='button';r.className='mom-mention-item'+(i===_momMentionIdx?' active':'');
      r.textContent='@'+c.name;r.setAttribute('role','option');
      r.onmousedown=function(ev){ev.preventDefault();_momComposeMentionInsert(c)};/* preventDefault 阻止 textarea blur，点击项可插入 */
      b.appendChild(r);
    });
    b.hidden=false;
  }catch(e){}
}
function _momComposeMentionInit(){
  try{
    const ta=document.getElementById('mom-compose-text');
    if(!ta||ta.__momMentionBound)return;ta.__momMentionBound=true;
    ta.addEventListener('input',function(){_momComposeMentionRender()});
    ta.addEventListener('click',function(){_momComposeMentionRender()});
    ta.addEventListener('keydown',function(ev){
      const b=_momComposeMentionBox();
      if(b&&!b.hidden&&_momMentionList.length){
        if(ev.key==='ArrowDown'){ev.preventDefault();_momMentionIdx=(_momMentionIdx+1)%_momMentionList.length;_momComposeMentionRender();return}
        if(ev.key==='ArrowUp'){ev.preventDefault();_momMentionIdx=(_momMentionIdx-1+_momMentionList.length)%_momMentionList.length;_momComposeMentionRender();return}
        if(ev.key==='Enter'||ev.key==='Tab'){if(_momMentionIdx>=0&&_momMentionList[_momMentionIdx]){ev.preventDefault();_momComposeMentionInsert(_momMentionList[_momMentionIdx])}return}
      }
      if(ev.key==='Escape'){_momComposeMentionHide()}
    });
    ta.addEventListener('blur',function(){setTimeout(function(){_momComposeMentionHide()},160)});
  }catch(e){}
}

/* ══════════ AI↔AI 回复链（线程化连续社交）══════════
   设计：一次只走一步。任意新评论落库 → _momentsMaybeReplyChain 检查线程状态
   （一个线程同时最多一个 pending 计划；comment 幂等）→ 延迟 30–120s →
   _momentsRunReplyStage 用确定性候选选择（作者回评 / 已参与者继续 / 高亲和第三方）
   选出一个角色 → generateRoleReply 生成（线程上下文 + replyTo 校验 + 去重/低信息过滤）
   → 落库后由 addMomentComment 再触发下一步，直至轮数/评论数/频控/冷却上限。 */

/* 线程上下文（结构化）：委托共享核心 buildReplyPrompt（前后台同一份 Prompt 文本）。
   此处只做浏览器数据 → spec 的映射。 */
function buildMomentReplyPrompt(args){
  const character=args&&args.character||{},ctx=(args&&args.context)||{},moment=(args&&args.moment)||{};
  const comments=(moment.comments||[]).slice().sort(function(a,b){return String(a.createdAt||'').localeCompare(String(b.createdAt||''))});
  const byId={};comments.forEach(function(c){byId[c.id]=c});
  const threads=comments.map(function(c){
    const who=c.authorType==='role'
      ?(function(){const cg=_momentsCfg(c.authorId);return cg?(cg.nickname||cg.model||'某角色'):'（角色已删除）'})()
      :(String((ctx.user&&ctx.user.name)||'')||_momentsUserDisplayName()||'用户');
    const tgt=c.replyTo&&byId[c.replyTo]?byId[c.replyTo]:null;
    const rel=tgt&&tgt.authorType==='role'
      ?(function(){const cg=_momentsCfg(tgt.authorId);return cg?(cg.nickname||cg.model||'某角色'):'某角色'})()
      :String((ctx.user&&ctx.user.name)||'')||'用户';
    return{id:c.id,authorName:who,content:c.content,replyToName:tgt?rel:''};
  });
  const authorName=_momentIsUserAuthor(moment)
    ?(String((ctx.user&&ctx.user.name)||'')||_momentsUserDisplayName()||'用户')
    :(function(){const c=_momentsCfg(_momentsAuthorRoleId(moment));return c?(c.nickname||c.model||'对方'):'对方'})();
  const suggestedTarget=(args&&args.targetRoleId)
    ?(function(){const c=_momentsCfg(args.targetRoleId);return c?(c.nickname||c.model||'对方'):'对方'})()
    :'';
  const spec={
    characterName:character.nickname||character.model||'AI',
    systemPrompt:character.systemPrompt,
    relationship:character.relationship,
    userName:String((ctx.user&&ctx.user.name)||'')||_momentsUserDisplayName()||'用户',
    authorName:authorName,
    momentContent:moment.content,
    imagesCount:(moment.images&&moment.images.length)||0,
    threads:threads,
    ownMoments:ctx.recentMoments,
    memories:ctx.memories,
    chatSummary:ctx.chatSummary,
    suggestedTargetName:suggestedTarget,
    nowLabel:new Date().toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'}),
    retryInstruction:args.retryInstruction
  };
  if(RC.buildReplyPrompt)return RC.buildReplyPrompt(spec);
  /* 核心缺失时的最小兜底（正常路径不会走到） */
  return{system:String(character.systemPrompt||''),messages:[{role:'system',content:character.systemPrompt||''},{role:'user',content:JSON.stringify(spec)}]}
}
/* 输出解析：publishReply / comment / replyTo（委托共享核心；解析器注入浏览器版容错实现） */
function _momentsParseReplyOutput(raw){
  return RC.parseReplyOutput?RC.parseReplyOutput(raw,_activeParsePlanJson):null;
}
/* 低信息回复过滤（"哈哈/嗯/不错"+1 之类）→ 视为不愿参与，避免 AI 互相复读 */
function _momentsReplyLowInfo(content){
  return RC.lowInfoMatch?RC.lowInfoMatch(content):(!String(content||'').trim());
}
/* 候选角色逐个步骤（确定性：亲和度加权 + 线程 id 哈希；委托共享核心） */
function _momentsChainPick(entries,momentId){
  return RC.chooseNext?RC.chooseNext(entries,momentId):null;
}
function _momentsPickNextStep(moment){
  if(!moment)return null;
  const now=Date.now();
  const roles=(apiConfigs||[]).map(function(cfg){
    return{id:String(cfg.id),canSpeak:!!(cfg&&_ibApiReady(cfg)&&_momentsReplyRoomOk(cfg.id,now))};
  });
  return RC.pickNextReplyRole?RC.pickNextReplyRole({
    momentId:String(moment.id||''),
    comments:(moment.comments||[]),
    postAuthor:String(_momentsAuthorRoleId(moment)||''),
    roles:roles
  }):null;
}
/* 线程状态计划（可测纯函数）：能否进入下一步 + 下一步是谁 */
function _momentsReplyChainPlan(moment,round){
  if(!moment)return{ok:false,reason:'no-moment'};
  const comments=(moment.comments||[]);
  if(comments.length>MOMENT_REPLY_COMMENT_MAX)return{ok:false,reason:'comments-over-max'};
  round=Number(round!=null?round:_momentsChainRound(moment));
  if(round>=MOMENT_REPLY_MAX_ROUNDS)return{ok:false,reason:'rounds-reached'};
  const step=_momentsPickNextStep(moment);
  if(!step)return{ok:false,reason:'no-candidate'};
  return{ok:true,step:step,round:round}
}
let _momentsReplyDelayMin=MOMENT_REPLY_DELAY_MIN,_momentsReplyDelayMax=MOMENT_REPLY_DELAY_MAX;
function _momentsSetReplyDelayForTest(min,max){
  _momentsReplyDelayMin=Math.max(0,Number(min)||0);
  _momentsReplyDelayMax=Math.max(_momentsReplyDelayMin+1,Number(max)||(_momentsReplyDelayMin+1000));
  return true;
}
/* 触发点：新评论落库后调用。幂等（同一 comment 只消费一次）+ 单线程单 pending + 上限预检。 */
async function _momentsMaybeReplyChain(momentId,commentId){
  try{
    /* companion 后台接管时前端不调度（后台拥有回复链独占权，事件经 ingest 回传）；
       为缩短"评论 → 后台知晓"的时延，触发一次节流同步（fire-and-forget） */
    if(_momentsCompanionOwnsReplyChain()){
      try{_momentsMaybeReplyChainSyncSoon()}catch(e){}
      return false;
    }
    const prefs=_momentsPrefs();
    if(!prefs.enabled||!prefs.aiComment)return false;
    commentId=String(commentId||'');
    const m=await getMoment(momentId);
    if(!m)return false;
    const st=_momentsReplyChainState();
    const s=st[momentId]||{};
    if(s.status==='pending')return false;/* 线程已有下一步计划：一次只走一步 */
    if(s.lastConsumedCommentId===commentId&&commentId)return false;/* 同一 comment 不重复消化 */
    /* 只有最新一条评论才能推进（防止旧事件/重复事件补发） */
    const cs=(m.comments||[]);
    const lastComment=cs.length?cs[cs.length-1]:null;
    if(lastComment&&commentId&&String(lastComment.id)!==commentId)return false;
    if(cs.length>MOMENT_REPLY_COMMENT_MAX)return false;
    if(_momentsChainRound(m)>=MOMENT_REPLY_MAX_ROUNDS)return false;
    const delay=_momentsReplyDelayMin+Math.floor(Math.random()*(_momentsReplyDelayMax-_momentsReplyDelayMin));
    const now=Date.now();
    st[momentId]={status:'pending',scheduledAt:now+delay,nextAt:now+delay,lastConsumedCommentId:commentId,updatedAt:now};
    _momentsReplyChainSave(st);
    setTimeout(function(){
      Promise.resolve(_momentsRunReplyStage(momentId)).catch(function(e){console.warn('[Moments] reply stage failed',String(e&&e.message||e).slice(0,200))});
    },delay);
    return true;
  }catch(e){console.warn('[Moments] maybeReplyChain failed',String(e&&e.message||e).slice(0,200));return false}
}
/* 执行一步：重新校验限制 → 确定性选角 → 生成回复（含 replyTo 校验与去重） */
async function _momentsRunReplyStage(momentId){
  const st=_momentsReplyChainState();
  const s=st[momentId];
  if(!s||s.status!=='pending')return false;
  /* 先释放"单 pending"槽位：本步生成新评论时 addMomentComment 要能立即安排下一步 */
  st[momentId]={...s,status:'idle',updatedAt:Date.now()};
  _momentsReplyChainSave(st);
  const m=await getMoment(momentId);
  if(!m)return false;
  const plan=_momentsReplyChainPlan(m,_momentsChainRound(m));
  if(!plan.ok)return false;
  try{
    const res=await generateRoleReply(plan.step.roleId,momentId,{replyTo:plan.step.replyTo,targetRoleId:plan.step.targetRoleId});
    return !!(res&&res.ok&&res.published);
  }catch(e){
    console.warn('[Moments] reply generation failed',String(e&&e.message||e).slice(0,200));
    return false;
  }
}
/* 线程版生成：完整线程上下文 + replyTo 校验 + 去重/低信息过滤 + 频控记录 */
async function generateRoleReply(commenterRoleId,momentId,options){
  options=options||{};
  try{
    const prefs=_momentsPrefs();if(!prefs.aiComment&&!(options.mention===true))return{ok:false,error:'AI 评论已关闭'};/* @ 点名必回独立于 AI 评论总开关 */
    const cfg=_momentsCfg(commenterRoleId);if(!cfg)return{ok:false,error:'角色配置不存在'};
    if(!_ibApiReady(cfg))return{ok:false,error:'角色 API 配置不完整'};
    const moment=await getMoment(momentId);if(!moment)return{ok:false,error:'动态不存在'};
    if(!_momentsVisibleToRole(moment,commenterRoleId))return{ok:false,error:'不可见'};
    if(!options.force){
      if(!_momentsReplyRoomOk(commenterRoleId,Date.now())){
        _obsRec('block',{kind:'reply',actor:commenterRoleId,reason:_momentsReplyBlockReason(commenterRoleId)});
        return{ok:false,error:'冷却或频控中'}
      }
    }
    const context=await _momentsContext(cfg);
    const built=buildMomentReplyPrompt({character:cfg,context:context,moment:moment,targetRoleId:options.targetRoleId,replyTo:options.replyTo});
    /* @ 点名强约束（v7）：被 @ 的角色务必评论；force 已豁免常规冷却/频控 */
    if(options.mention===true){
      _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【指名回应】你被 @ 点名了，请务必针对这条动态认真回应，不要沉默、不要只发语气词；结合图片/上下文说出你的真实想法。');
    }
    /* 楼主自主删评（v7.5）：回复者=本条动态作者 → 提示可删冒犯评论（delComments 字段，只能删别人） */
    if(String(commenterRoleId||'')===String(_momentsAuthorRoleId(moment))){
      _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【楼主管理】你是本条动态的发布者。如果评论区有冒犯、打扰或不合时宜的评论，可以在输出 JSON 里加 "delComments":["评论id"] 列出要删除的评论（只能删别人发的；如无则不写）。');
    }
    /* 图片注入：被回复的动态携带图片 → 支持视觉的角色先看图再决定回复内容（失败静默纯文本） */
    try{
      if(moment.images&&moment.images.length){
        const injected=await _momentsInjectImages(cfg,built.messages[built.messages.length-1],moment.images.slice(0,2),'【附带图片】本条动态携带图片，请先查看图片内容，再决定是否回复以及回复什么。');
        if(injected>0)_obsRec('image_inject',{actor:commenterRoleId,kind:'reply',count:injected,momentId:momentId});
      }
    }catch(e){console.warn('[Moments] reply image inject failed (text fallback):',String(e&&e.message||e).slice(0,120))}
    let raw='',lastError=null;
    const suggestReplyTo=String(options.replyTo||'');
    const validIds=new Set((moment.comments||[]).map(function(c){return String(c.id)}));
    for(let attempt=0;attempt<MOMENT_MAX_ATTEMPTS;attempt++){
      try{
        /* @ 点名：首次正常预算，空输出时第二次提额重试（推理模型吃满预算的常见成因） */
        const _replyBudget=(options.mention===true&&attempt>0)?1200:600;
        raw=await _obsCall('reply',cfg,built.messages,{maxTokens:_replyBudget,timeoutMs:90000,wantMeta:false,jsonMode:true,_noWebSearch:true,disableTools:true})
      }catch(e){lastError=e;break}
      const parsed=_momentsParseReplyOutput(raw);
      if(!parsed||parsed.publish===false){
        if(parsed&&parsed.publish===false){_obsRec('reply_declined',{actor:commenterRoleId,origin:'local'});return{ok:true,published:false,reason:'选择不参与'}};
        if(attempt===0){
          lastError=new Error('回复输出无法解析');
          _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【注意】请只输出一个 JSON 对象：{"publishReply":true/false,"comment":"正文","replyTo":"comment-id 或空串"}。');
          continue
        }
        break
      }
      /* replyTo 校验：非法 id（不存在/非本线程评论）→ 回落到建议目标，最终为空串=回复原帖（共享核心规则） */
      let replyTo=String(parsed.replyTo||'');
      if(replyTo&&!validIds.has(replyTo)){
        if(attempt===0){
          _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【注意】replyTo 必须来自当前线程已有的 comment-id（或空串回复原帖）。');
          continue
        }
        replyTo=RC.normalizeReplyTarget?RC.normalizeReplyTarget(parsed.replyTo,validIds,suggestReplyTo):((suggestReplyTo&&validIds.has(suggestReplyTo))?suggestReplyTo:'');
      }
      /* 低信息过滤（哈哈/嗯/不错…）：视为不愿参与；首次重试提示，二次直接判不参与 */
      if(_momentsReplyLowInfo(parsed.comment)){
        if(attempt===0){
          _obsRec('lowinfo',{kind:'reply',actor:commenterRoleId});
          _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【注意】这条回复信息量太低（如"哈哈""不错"），请重新写一句有内容的话；没有想说的就 publishReply:false。');
          continue
        }
        _obsRec('lowinfo',{kind:'reply',actor:commenterRoleId});
        return{ok:true,published:false,reason:'低信息回复被过滤'}
      }
      /* 去重：与本条已有评论、回复者最近 3 条评论比较（bigram Dice，共享核心实现） */
      const _sim=RC.diceSimilarity||_activeTextSimilarity;
      let dup=false;
      for(const c of (moment.comments||[])){
        if(_sim(parsed.comment,String(c.content||''))>=MOMENT_COMMENT_SIMILARITY){dup=true;break}
      }
      if(!dup){
        const scanned=await _momentsScanDesc(120);
        for(const mm of scanned){
          for(const c of (mm.comments||[])){
            if(c.authorType==='role'&&String(c.authorId)===String(commenterRoleId)&&_sim(parsed.comment,String(c.content||''))>=MOMENT_COMMENT_SIMILARITY){dup=true;break}
          }
          if(dup)break;
        }
      }
      if(dup){
        if(attempt===0){
          _obsRec('dedupe',{kind:'reply',actor:commenterRoleId});
          _momentsAppendNote(built.messages[built.messages.length-1],'\n\n【注意】这条回复与已有内容太相似，请换一个说法。');
          continue
        }
        _obsRec('dedupe',{kind:'reply',actor:commenterRoleId});
        lastError=new Error('回复与已有内容相似');
        break
      }
      const res=await addMomentComment(momentId,{authorType:'role',authorId:commenterRoleId,content:parsed.comment,replyTo:replyTo});
      if(!res.ok)return res;
      /* 楼主自主删评（v7.5）：回复者=动态作者 → 按 delComments 删除冒犯评论（只能删别人） */
      if(String(commenterRoleId||'')===String(_momentsAuthorRoleId(moment))){try{await _momentsApplyDelComments(moment,momentId,commenterRoleId,raw)}catch(e){}}
      _obsRec('reply',{actor:commenterRoleId,target:String(options.targetRoleId||'')||OBS_USER,momentId:momentId,round:(_momentsChainRound(moment)||0)+1,origin:'local'});
      _momentsSetState(commenterRoleId,{lastCommentAt:Date.now()});
      _momentsCommentLogRecord(commenterRoleId,Date.now());
      return{ok:true,published:true,comment:res.comment,replyTo:replyTo}
    }
    return{ok:false,error:lastError?String(lastError.message||lastError).slice(0,200):'回复生成失败'}
  }catch(e){console.warn('[Moments] reply failed',String(e&&e.message||e).slice(0,200));return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}

/* ══════════ AI 点赞（轻量规则，不调用 LLM） ══════════ */
const MOMENT_LIKE_STATE_KEY='ib_moments_likes_v1';
/* 角色对亲和度（稳定、无存储、可复现）：40–95。让"A 常和 B 互动 / D 基本潜水"成为常态，
   而不是每个角色对所有动态同概率互动；不引入任何新关系系统。 */
function _momentsHash(s){let h=7;const t=String(s||'');for(let i=0;i<t.length;i++)h=(h*31+t.charCodeAt(i))>>>0;return h}
function _momentsPairAffinity(a,b){return 40+_momentsHash(String(a)+'\u0001'+String(b))%56}
function _momentsLikeState(){
  try{const v=JSON.parse(localStorage.getItem(MOMENT_LIKE_STATE_KEY)||'{}');return v&&typeof v==='object'?v:{}}catch(e){return{}}
}
function _momentsRecordLike(roleId,targetRoleId,now){
  try{
    const st=_momentsLikeState();const cur=st[roleId]||{log:[],lastAt:0,byAuthor:{}};
    const t=Number(now)||Date.now();
    cur.log=(cur.log||[]).filter(x=>t-x<3600000);cur.log.push(t);cur.lastAt=t;
    if(targetRoleId)cur.byAuthor=Object.assign({},cur.byAuthor||{},{[targetRoleId]:t});
    st[roleId]=cur;localStorage.setItem(MOMENT_LIKE_STATE_KEY,JSON.stringify(st))
  }catch(e){}
}
/* 候选资格：可见性（仅公开 all）/非作者/API 可用/未赞过/每小时上限/冷却/最近是否刚与作者互动 */
function _momentsLikeEligible(moment,roleId,now){
  try{
    const prefs=_momentsPrefs();if(!prefs.enabled||!prefs.aiLike)return false;
    if(!moment||moment.visibility!=='all')return false;/* private/user/roles 不参与 AI 点赞 */
    if(!_momentIsUserAuthor(moment)&&_momentsAuthorRoleId(moment)===String(roleId))return false;
    if((moment.likes||[]).includes(roleId))return false;
    const cfg=_momentsCfg(roleId);if(!cfg||!_ibApiReady(cfg))return false;
    const partnerKey=_momentIsUserAuthor(moment)?String(moment.authorId||''):_momentsAuthorRoleId(moment);
    const t=Number(now)||Date.now();
    const st=_momentsLikeState()[roleId]||{};
    if(((st.log||[]).filter(x=>t-x<3600000).length)>=MOMENT_LIKE_MAX_PER_HOUR)return false;
    if(st.lastAt&&t-st.lastAt<MOMENT_LIKE_COOLDOWN)return false;
    if(st.byAuthor&&st.byAuthor[partnerKey]&&t-st.byAuthor[partnerKey]<3600000)return false;
    return true
  }catch(e){return false}
}
/* 选人并执行点赞（可测试：opts.force=true 时按序取前 N 个，跳过亲和度概率） */
async function _momentsApplyLikes(momentId,opts){
  opts=opts||{};
  try{
    const fresh=await getMoment(momentId);if(!fresh)return{ok:true,liked:0};
    const now=Date.now();
    let candidates=apiConfigs.filter(c=>_momentsLikeEligible(fresh,c.id,now));
    if(!candidates.length)return{ok:true,liked:0};
    const partnerKey=_momentIsUserAuthor(fresh)?String(fresh.authorId||_activeUserId()):_momentsAuthorRoleId(fresh);
    if(!opts.force){
      /* 角色对亲和度：同一对角色有稳定的互动倾向；roll 含动态 id → 不同动态点不同的名，
         再按 roll 升序取人，打破配置顺序偏差（不再永远是列表第一位点赞） */
      candidates=candidates
        .map(c=>({c:c,r:_momentsHash(String(fresh.id)+'\u0002'+c.id)%100}))
        .filter(x=>x.r<_momentsPairAffinity(x.c.id,partnerKey))
        .sort((a,b)=>a.r-b.r)
        .map(x=>x.c);
      if(!candidates.length)return{ok:true,liked:0};
    }
    let count;
    if(opts.force){
      count=Math.min(opts.max||2,candidates.length)
    }else{
      const hash=_momentsHash(fresh.id);
      count=Math.min((hash%10)<6?1:(hash%10)<9?2:0,candidates.length)/* 60% 1 个 / 25% 2 个 / 15% 0 个 */
    }
    if(!count)return{ok:true,liked:0};
    const picked=candidates.slice(0,count);
    let liked=0;
    for(const c of picked){
      const r=await likeMoment(fresh.id,c.id);
      if(r.ok&&r.liked){liked++;_obsRec('like',{actor:c.id,target:partnerKey,targetIsUser:_momentIsUserAuthor(fresh)});_momentsRecordLike(c.id,partnerKey,now)}
    }
    return{ok:true,liked:liked,by:picked.map(c=>c.id)}
  }catch(e){console.warn('[Moments] apply likes failed',String(e&&e.message||e).slice(0,200));return{ok:false,error:String(e&&e.message||e).slice(0,200)}}
}
/* 动态创建后的点赞触发（延迟 15-45s，localStorage 记录已触发，防双标签重复；用户动态同样适用） */
function _momentsMaybeLike(moment){
  try{
    if(!moment)return;
    const prefs=_momentsPrefs();if(!prefs.enabled||!prefs.aiLike)return;
    const q=_momentsCommentQ();
    if(q['like_'+moment.id]&&Date.now()-q['like_'+moment.id]<3600000)return;
    _momentsSetCommentQ('like_'+moment.id);
    setTimeout(async()=>{
      try{await _momentsApplyLikes(moment.id,{})}catch(e){console.warn('[Moments] like trigger failed',String(e&&e.message||e).slice(0,200))}
    },15000+Math.floor(Math.random()*30000))
  }catch(e){}
}

/* ══════════ 调度（复用 _activeTick 心跳；30s 挂点见 active-diary.js） ══════════ */
function _momentsFreqMs(){
  const r=MOMENT_FREQ[_momentsPrefs().frequency]||MOMENT_FREQ.medium;
  return r[0]+Math.floor(Math.random()*(r[1]-r[0]))
}
/* ── companion 后台调度：companion 在线且支持 /moments 时由后台独占执行 ── */
let _momentsLastSyncAt=0,_momentsCompanionBrokenAt=0;
let _momentsCompanionReplyChainsOk=false;/* /health 携带 reply_chains 字段 → 后台支持回复链（接收线程快照并独占推进） */
let _momentsReplySyncAt=0;               /* 回复链触发后的节流同步（防评论风暴连发同步） */
function _momentsCompanionOwnsReplyChain(){
  return !!(window._activeCompanionOnline&&_momentsCompanionReplyChainsOk);
}
function _momentsReplyChainCapability(){return _momentsCompanionReplyChainsOk}
function _momentsSetReplyChainCapabilityForTest(v){_momentsCompanionReplyChainsOk=!!v;return true}
function _momentsMaybeReplyChainSyncSoon(){
  try{
    if(!_momentsCompanionOwnsReplyChain())return;
    const now=Date.now();
    if(now-_momentsReplySyncAt<10000)return;
    _momentsReplySyncAt=now;
    setTimeout(function(){
      Promise.resolve(_momentsSyncCompanion()).catch(function(e){console.warn('[Moments] reply sync failed',String(e&&e.message||e).slice(0,160))});
    },1500);
  }catch(e){}
}
async function _momentsCompanionSnapshot(cfg){
  try{
    const ctx=await _momentsContext(cfg);
    const roleName=id=>{const c=_momentsCfg(id);return c?(c.nickname||c.model||'另一角色'):'另一角色'};
    const authorName=m=>_momentIsUserAuthor(m)?(String((ctx.user&&ctx.user.name)||'')||_momentsUserDisplayName()):roleName(_momentsAuthorRoleId(m));
    /* 图片快照（v5 图片注入，预算已放宽）：每条动态带前 3 张图（dataUrl 数组），全局预算 12 张；
       单张 ≤2.4MB（与 _momentsDefaults 的 dataUrl 上限一致）；image 字段保留第 1 张兼容旧读数。 */
    let _snapBudget = 12;
    const snapImages = m => {
      const out = [];
      if (!m || !Array.isArray(m.images)) return out;
      for (const im of m.images) {
        if (_snapBudget <= 0 || out.length >= 3) break;
        const u = String((im && im.dataUrl) || '');
        if (u.slice(0, 5) === 'data:' && u.length > 100 && u.length < 2.4e6) { out.push(u); _snapBudget -= 1; }
      }
      return out;
    };
    /* 线程快照（回复链核心输入）：自己的 + 其他角色公开动态，各带紧凑 comments（≤12 条），有界 8 条 */
    const compactThread = m => {
      const imgs = snapImages(m);
      return {
        id: String(m.id || ''),
        roleId: String(m.roleId || ''),
        authorType: _momentIsUserAuthor(m) ? 'user' : 'role',
        content: String(m.content || '').slice(0, 500),
        visibility: String(m.visibility || 'all'),
        createdAt: String(m.createdAt || ''),
        imagesCount: (m.images && m.images.length) || 0,
        images: imgs,
        image: imgs[0] || '',
        comments: (Array.isArray(m.comments) ? m.comments : []).slice(-12).map(c => ({ id: String(c.id || ''), authorType: c.authorType === 'role' ? 'role' : 'user', authorId: String(c.authorId || 'user'), content: String(c.content || '').slice(0, 300), replyTo: String(c.replyTo || '').slice(0, 80), createdAt: String(c.createdAt || '') }))
      };
    };
    const threads = [];
    (ctx.recentMoments || []).forEach(m => { if (m && m.id && threads.length < 5) threads.push(compactThread(m)) });
    (ctx.otherRoleMoments || []).forEach(m => { if (m && m.id && threads.length < 8) threads.push(compactThread(m)) });
    const prefs = _momentsPrefs();
    const snapEntry = m => {
      const imgs = snapImages(m);
      return { id: m.id, roleId: m.roleId, authorType: _momentIsUserAuthor(m) ? 'user' : 'role', content: m.content, visibility: m.visibility, createdAt: m.createdAt, role_name: authorName(m), images: imgs, image: imgs[0] || '' };
    };
    return {
      character: { id: cfg.id, provider: cfg.provider, apiKey: cfg.apiKey, model: cfg.model, endpoint: cfg.endpoint, systemPrompt: cfg.systemPrompt || getDefaultPromptForTheme(), nickname: cfg.nickname || cfg.model || 'AI', relationship: cfg.relationship || '', temperature: cfg.temperature, vision: cfg.vision === true || (cfg.vision === undefined && !(((typeof _usesLocalDeepSeekVision === 'function' && _usesLocalDeepSeekVision(cfg)))) ) },
      user: ctx.user,
      recent_memories: ctx.memories,
      recent_messages: ctx.recentMessages,
      recent_proactive_messages: ctx.recentProactiveMessages,
      chat_summary: ctx.chatSummary,
      last_interaction_at: ctx.lastInteractionAt,
      recent_moments: (ctx.recentMoments || []).map(snapEntry),
      other_role_moments: (ctx.otherRoleMoments || []).map(snapEntry),
      prefs: { aiComment: prefs.aiComment !== false, enabled: prefs.enabled !== false },
      recent_threads: threads
    }
  }catch(e){return{character:{id:cfg.id,provider:cfg.provider,apiKey:cfg.apiKey,model:cfg.model,endpoint:cfg.endpoint,systemPrompt:cfg.systemPrompt||getDefaultPromptForTheme(),nickname:cfg.nickname||cfg.model||'AI',relationship:cfg.relationship||'',temperature:cfg.temperature,vision:cfg.vision===true||(cfg.vision===undefined&&!(((typeof _usesLocalDeepSeekVision==='function')&&_usesLocalDeepSeekVision(cfg))))},user:{id:_activeUserId(),name:'用户'},recent_memories:[],recent_messages:[],recent_proactive_messages:[],chat_summary:'',last_interaction_at:0,recent_moments:[],other_role_moments:[],prefs:{aiComment:true,enabled:true},recent_threads:[]}}
}
async function _momentsSyncCompanion(){
  try{
    if(!window._activeCompanionOnline)return false;
    if(_momentsCompanionBrokenAt&&Date.now()-_momentsCompanionBrokenAt<5*60000)return false;
    const prefs=_momentsPrefs();/* 注意：enabled=false 也必须继续同步——关闭状态要传给后台，由后台停发（见 momentsTick） */
    /* 能力预检（复用既有 /health：新版响应携带 moments 计数字段）。
       旧版 companion（无 /moments 路由）→ 不发任何 PUT，直接回退浏览器本地执行，
       避免每个角色一次 404 的连发；窗口过后自动重探，重启新版服务即自动恢复后台调度。 */
    let caps=null;
    try{caps=await _activeCompanionRequest('/health',{timeout:2500})}catch(e){caps=null}
    if(!caps||typeof caps!=='object'||caps.moments===undefined){
      _momentsCompanionBrokenAt=Date.now();
      _momentsCompanionReplyChainsOk=false;
      return false
    }
    _momentsCompanionReplyChainsOk=caps.reply_chains!==undefined;/* 后台支持回复链（线程快照由本快照携带） */
    const now=Date.now(),synced=[];
    for(const cfg of apiConfigs){
      if(!_ibApiReady(cfg))continue;
      const s=_momentsState()[cfg.id]||{};
      if(!s.nextAt){_momentsSetState(cfg.id,{nextAt:now+_momentsFreqMs()});continue}
      const schedule={id:cfg.id,characterId:cfg.id,user_id:_activeUserId(),enabled:prefs.autoPublish!==false,frequency:prefs.frequency,nextAt:Number(s.nextAt)||now+3600000,lastPostAt:Number(s.lastPostAt||0),status:'idle',revision:Number(s.revision||0)+1,updatedAt:new Date().toISOString(),executedAt:s.executedAt?String(s.executedAt):null,lastMomentId:String(s.lastMomentId||''),declineStreak:Math.max(0,Number(s.declineStreak||0))};
      const snapshot=await _momentsCompanionSnapshot(cfg);
      try{
        const res=await _activeCompanionRequest('/moments/'+encodeURIComponent(cfg.id),{method:'PUT',body:Object.assign({schedule:schedule},snapshot),timeout:6000});
        /* 采纳后台回传的权威 declineStreak（success/stale 分支都携带 schedule），保持双端计数一致 */
        if(res&&res.schedule&&typeof res.schedule.decline_streak==='number'&&res.schedule.decline_streak!==Math.max(0,Number(s.declineStreak||0))){
          _momentsSetState(cfg.id,{declineStreak:Math.max(0,res.schedule.decline_streak)})
        }
        if(res&&res.stale){/* companion 已执行（事件随后拉取回传，本地 nextAt 会更新） */
          _momentsSetState(cfg.id,{companionSynced:true});
          continue
        }
        synced.push(cfg.id);
        _momentsSetState(cfg.id,{companionSynced:true})
      }catch(e){
        /* 单角色同步失败：404/400 视为版本不匹配 → 立即中断本轮剩余角色的 PUT（不再连发 404），按窗口回退本地 */
        if(String(e&&e.message||e).indexOf('404')>=0||String(e&&e.message||e).indexOf('400')>=0){
          _momentsCompanionBrokenAt=Date.now();
          console.warn('[Moments] companion lacks /moments routes (legacy build); falling back to local scheduling')
        }else{
          console.warn('[Moments] companion sync failed for '+cfg.id+': '+String(e&&e.message||e).slice(0,160))
        }
        break
      }
    }
    /* 只声明 moment_ids：与 task_ids/plan_ids 分离，不误删其他集合 */
    try{await _activeCompanionRequest('/reconcile',{method:'POST',body:{user_id:_activeUserId(),moment_ids:synced},timeout:6000})}catch(e){}
    _momentsLastSyncAt=Date.now();
    return synced.length>0||!_momentsCompanionBrokenAt
  }catch(e){console.warn('[Moments] companion sync failed',String(e&&e.message||e).slice(0,200));return false}
}
/* 事件回传落库（按 moment id 幂等；companion 已执行 → 本地 nextAt 同步避免补发） */
async function _momentsIngestEvent(ev,userId){
  try{
    /* ── 后台楼主删评（v7.5）：companion 删除了线程评论 → 同步删除浏览器动态里对应评论（按 comment id 幂等） ── */
    if(ev&&ev.kind==='moment_comment_deleted'){
      const mid=String(ev.moment_id||'');const cid=String(ev.comment_id||'');
      if(!mid||!cid)return false;
      const existing=await getMoment(mid);if(!existing)return false;
      const had=(existing.comments||[]).some(x=>String(x.id)===String(cid));
      if(!had){if(userId)await _activeCompanionRequest('/events/'+encodeURIComponent(ev.id)+'/ack',{method:'POST',body:{user_id:userId}}).catch(()=>{});return false;}
      existing.comments=existing.comments.filter(x=>String(x.id)!==String(cid));
      await dbPut(MOMENT_STORE,existing);
      try{if(currentPage==='moments')loadMomentsPage()}catch(e){}
      if(userId)await _activeCompanionRequest('/events/'+encodeURIComponent(ev.id)+'/ack',{method:'POST',body:{user_id:userId}}).catch(()=>{});
      return true;
    }
    /* ── AI↔AI 后台回复：按 comment id 幂等并入已有动态；不重新触发回复链（companion 拥有独占权） ── */
    if(ev&&ev.kind==='moment_reply'){
      const mid=String(ev.moment_id||'');
      const comment=ev&&ev.comment||null;
      if(!mid||!comment||!comment.id)return false;
      const existing=await getMoment(mid);
      if(!existing)return false;/* 原动态尚未落库（事件乱序）→ 不补建，等待 moment 事件先行 */
      if((existing.comments||[]).some(c=>String(c.id)===String(comment.id))){/* 幂等：重复事件/重放 */
        if(userId)await _activeCompanionRequest('/events/'+encodeURIComponent(ev.id)+'/ack',{method:'POST',body:{user_id:userId}}).catch(()=>{});
        return false;
      }
      const c={id:String(comment.id),authorType:comment.authorType==='role'?'role':'user',authorId:String(comment.authorId||'user'),content:String(comment.content||'').slice(0,600),replyTo:String(comment.replyTo||'').slice(0,80),createdAt:comment.createdAt||new Date().toISOString()};
      existing.comments=(existing.comments||[]).concat([c]);
      await dbPut(MOMENT_STORE,existing);
      /* 观测：后台回复成功统一在 ingest 入账（companion 侧只记失败/拒绝，避免双计） */
      try{
        const byId={};(existing.comments||[]).forEach(function(x){byId[x.id]=x});
        const tgt=c.replyTo&&byId[c.replyTo]?byId[c.replyTo]:null;
        _obsRec('reply',{actor:c.authorId,target:tgt?(tgt.authorType==='role'?tgt.authorId:OBS_USER):OBS_USER,momentId:mid,round:(RC.chainRound?RC.chainRound(existing.comments):0),origin:'companion'});
      }catch(e){}
      try{if(currentPage==='moments')loadMomentsPage()}catch(e){}
      if(userId)await _activeCompanionRequest('/events/'+encodeURIComponent(ev.id)+'/ack',{method:'POST',body:{user_id:userId}}).catch(()=>{});
      return true;
    }
    const moment=ev&&ev.moment||null;
    if(!moment||!moment.id||moment.roleId===_activeUserId())return false;
    if(await getMoment(moment.id))return false;/* 幂等：重复事件/双标签不重复入库 */
    /* ── Phase 4 图文增强（companion 不生成图片：只携带 wantImage/imagePrompt，图片由浏览器 Image Provider 生成）──
       数据流：Event(want_image/image_prompt) → 本函数 → _momentsMakeImage(cfg) → 与文字一次性入库（原子）；
       图片失败/能力不可用/概率门未过 → 纯文字 Moment 照常发布（图片是增强，不是硬依赖）；
       imagePrompt 只作内部生成参数，不写入公开 Moment 数据（_momentsDefaults 会剥离）。 */
    const wantImage=ev.want_image===true||ev.wantImage===true||moment.wantImage===true;
    const imagePrompt=String(ev.image_prompt||ev.imagePrompt||moment.imagePrompt||'').trim().slice(0,600);
    let images=[];
    if(wantImage&&imagePrompt){
      try{
        const imgCfg=_momentsCfg(moment.roleId);/* 独立 Image Provider 配置随角色 API Config（imageGen/imageGenModel），与文字模型解耦 */
        if(imgCfg&&imgCfg.imageGen===true){images=await _momentsMakeImage(imgCfg,Object.assign({},moment,{wantImage:true,imagePrompt:imagePrompt}))}
      }catch(e){/* 任何图片异常都不影响 Moment 发布 */
        _obsRec('image_generation_failed',{actor:moment.roleId,reason_class:String(e&&e.message||e).slice(0,60)});
      }
    }
    const m=_momentsDefaults(Object.assign({},moment,{images:images}));
    await dbPut(MOMENT_STORE,m);
    _obsRec('post',{actor:m.roleId,origin:'companion',vis:m.visibility,motive:String(m.motive||''),wantImage:wantImage===true,imageGenerated:(images&&images.length>0)});
    _momentsSetState(m.roleId,{
      nextAt:Number(ev.next_at)||Date.now()+3600000,
      lastPostAt:Number(ev.last_post_at)||Date.now(),
      executedAt:ev.sent_at?new Date(ev.sent_at).toISOString():new Date().toISOString(),
      lastMomentId:m.id,
      declineStreak:0/* 后台成功发布 → 连续未发归零（计数随事件回合流通） */
    });
    _momentsMaybeLike(m);
    _momentsMaybeComment(m);
    _momentsMaybeMention(m);/* @ 点名：Companion 后台动态正文含 @ → 被 @ 角色强制评论（与本地路径一致） */
    if(userId)await _activeCompanionRequest('/events/'+encodeURIComponent(ev.id)+'/ack',{method:'POST',body:{user_id:userId}}).catch(()=>{});
    return true
  }catch(e){console.warn('[Moments] ingest failed',String(e&&e.message||e).slice(0,200));return false}
}
async function _momentsPullCompanionEvents(){
  try{
    if(!window._activeCompanionOnline)return;
    const userIds=new Set([_activeUserId()]);
    const s=_momentsState();Object.keys(s).forEach(k=>{if(s[k]&&s[k].user_id)userIds.add(String(s[k].user_id))});
    let pulled=0;
    for(const userId of userIds){
      let payload=null;
      try{payload=await _activeCompanionRequest('/events?limit=100&user_id='+encodeURIComponent(userId),{timeout:4000})}catch(e){continue}
      for(const ev of (Array.isArray(payload&&payload.events)?payload.events:[])){
        if(!ev||(ev.kind!=='moment'&&ev.kind!=='moment_reply'))continue;
        if(await _momentsIngestEvent(ev,userId))pulled++
      }
    }
    if(pulled&&currentPage==='moments')try{loadMomentsPage()}catch(e){}
  }catch(e){console.warn('[Moments] pull failed',String(e&&e.message||e).slice(0,200))}
}
/* 浏览器本地执行（第一阶段路径；companion 离线或旧版不支持 moments 时） */
async function _momentsLocalTick(now){
  now=Number(now)||Date.now();
  for(const cfg of apiConfigs){
    if(!_ibApiReady(cfg))continue;
    const key=cfg.id,state=_momentsState(),s=state[key]||{};
    const nx=Number(s.nextAt);
    if(!Number.isFinite(nx)||nx<=0){_momentsSetState(key,{nextAt:now+_momentsFreqMs()});continue}/* 脏数据自愈 */
    if(s.claimUntil&&Number(s.claimUntil)>now)continue;/* 其他标签页已在执行（多标签互斥） */
    if(nx>now)continue;
    _momentsSetState(key,{lastAttemptAt:now,claimUntil:now+3*60000});
    /* 最短间隔保护（含手动/companion 等路径产生的新动态） */
    if(s.lastPostAt&&now-s.lastPostAt<MOMENT_MIN_INTERVAL){
      _momentsSetState(key,{claimUntil:0,nextAt:now+30*60000+Math.floor(Math.random()*30*60000)});
      continue
    }
    try{
      const r=await generateRoleMoment(key,{trigger:'schedule'});
      if(r.ok&&r.published)_momentsSetState(key,{claimUntil:0,lastPostAt:now,nextAt:now+_momentsFreqMs()});
      else _momentsSetState(key,{claimUntil:0,nextAt:now+_momentsFreqMs()})/* 不发布/失败都按频率后再试，不轰炸 */
    }catch(e){
      console.warn('[Moments] schedule failed for '+key,String(e&&e.message||e).slice(0,200));
      _momentsSetState(key,{claimUntil:0,nextAt:now+60*60000})
    }
  }
}
async function _momentsTick(){
  if(!db)return;
  try{
    const prefs=_momentsPrefs();
    const now=Date.now();
    /* companion 在线且支持 moments：后台独占执行（先拉事件，再同步最新 nextAt）。
       注意：enabled/autoPublish 的早退必须放在同步之后——否则总开关一关就停止同步，
       后台永远学不到"已关闭"，继续照常发布/推进回复链（设置保存但不生效的根因之一）。 */
    if(window._activeCompanionOnline){
      await _momentsPullCompanionEvents();
      if(now-_momentsLastSyncAt>60000)await _momentsSyncCompanion();
      /* 旧版 companion（无 /moments）：同一次 tick 内回退浏览器本地执行（与第一阶段一致） */
      if(!(_momentsCompanionBrokenAt&&now-_momentsCompanionBrokenAt<5*60000))return
    }
    if(!prefs.enabled||!prefs.autoPublish)return;
    await _momentsLocalTick(now)
  }catch(e){console.warn('[Moments] tick failed',String(e&&e.message||e).slice(0,200))}
}

/* ══════════ 聊天联动：朋友圈进入 AI 上下文（轻量检索，不永久塞入） ══════════ */
async function getMomentsContext(apiId,opts){
  opts=opts||{};
  try{
    const prefs=_momentsPrefs();
    const all=await _momentsScanDesc(MOMENT_CTX_SCAN_MAX)/* 有界：每条聊天消息都走这里，不做全表读取 */;
    const own=all.filter(m=>m.roleId===apiId&&m.visibility!=='private'&&_momentsVisibleToUser(m))
      .sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,4);
    const others=(prefs.otherRolesVisible
      ?all.filter(m=>m.roleId!==apiId&&m.visibility==='all')/* user 公开动态同样进入（roleId=''≠apiId）；user private 天然被排除 */
      :[]).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,3);
    if(!own.length&&!others.length)return '';
    const lines=[],timeLabel=iso=>{
      const d=new Date(iso),now=new Date(),pad=n=>String(n).padStart(2,'0');
      const sameDay=d.toDateString()===now.toDateString();
      const yest=new Date(now);yest.setDate(now.getDate()-1);
      const hhmm=pad(d.getHours())+':'+pad(d.getMinutes());
      if(sameDay)return'今天 '+hhmm;
      if(d.toDateString()===yest.toDateString())return'昨天 '+hhmm;
      return(d.getMonth()+1)+'月'+d.getDate()+'日 '+hhmm
    };
    for(const m of own){
      const name=String((function(){const c=_momentsCfg(apiId);return c?(c.nickname||c.model||'我'):'我'})()||'我');
      lines.push('- （'+timeLabel(m.createdAt)+'）我：'+String(m.content||'').slice(0,120))
    }
    for(const m of others){
      const name=_momentIsUserAuthor(m)?_momentsUserDisplayName():(function(){const c=_momentsCfg(_momentsAuthorRoleId(m));return c?(c.nickname||c.model||''):'另一角色'})();
      lines.push('- （'+timeLabel(m.createdAt)+'）'+name+'：'+String(m.content||'').slice(0,120))
    }
    let ctx='【朋友圈动态（系统参考，勿提及此段）】\n'+lines.join('\n');
    if(ctx.length>MOMENT_CONTEXT_CHAT_MAX)ctx=ctx.slice(0,MOMENT_CONTEXT_CHAT_MAX);
    return ctx
  }catch(e){return''}
}

/* ══════════ UI ══════════ */
function _momentsTimeLabel(iso){
  const d=new Date(iso),now=new Date(),pad=n=>String(n).padStart(2,'0');
  if(!isNaN(d.getTime())){
    if(d.toDateString()===now.toDateString())return pad(d.getHours())+':'+pad(d.getMinutes());
    const yest=new Date(now);yest.setDate(now.getDate()-1);
    if(d.toDateString()===yest.toDateString())return'昨天 '+pad(d.getHours())+':'+pad(d.getMinutes());
    if(d.getFullYear()===now.getFullYear())return(d.getMonth()+1)+'月'+d.getDate()+'日 '+pad(d.getHours())+':'+pad(d.getMinutes());
    return d.getFullYear()+'年'+(d.getMonth()+1)+'月'+d.getDate()+'日'
  }
  return''
}
function _momentsAvatar(cfg,name,size){
  const d=document.createElement('div');d.className='mom-avatar';
  if(size)d.style.width=size+'px',d.style.height=size+'px';
  const src=cfg?(cfg.avatar||cfg.avatarUrl||(cfg.character&&(cfg.character.avatar||cfg.character.avatarUrl||cfg.character.image))||''):'';
  if(src){const img=document.createElement('img');img.src=src;img.alt='';img.loading='lazy';img.decoding='async';d.appendChild(img)}
  else d.textContent=String(name||'?').charAt(0).toUpperCase();
  return d
}
function _momentsRoleName(cfg){return cfg?(cfg.nickname||cfg.model||'AI'):'（角色已删除）'}
let _momentsFeedShown=MOMENT_FEED_PAGE;
function _momentsFeedScope(){
  const el=document.getElementById('mom-role-scope');
  return el&&el.value==='private'?'private':'public'
}
function _momentsSyncScopeUI(filterRole){
  const el=document.getElementById('mom-role-scope');
  if(el)el.hidden=!filterRole/* 私人日志入口只在某个角色的页面出现 */
}
async function _momentsRenderFeed(opts){
  opts=opts||{};
  const feed=document.getElementById('mom-feed');if(!feed)return;
  const sel=document.getElementById('mom-role-filter');
  const filterRole=sel?sel.value:'';
  _momentsSyncScopeUI(filterRole);
  const scope=_momentsFeedScope();
  feed.innerHTML='<div class="mom-state">加载中…</div>';
  let list=[];
  try{
    if(filterRole&&scope==='private'){
      /* 私人日志：仅当用户正查看该角色页面时展示"上锁"占位卡（内容不可见，不可点赞/评论/删除） */
      list=await getRoleMoments(filterRole);
      list=list.filter(m=>m.visibility==='private')
    }else if(filterRole){
      list=await getRoleMoments(filterRole);
      list=list.filter(m=>m.visibility!=='private')/* 私密动态只有角色自己可读，用户 UI 不展示内容 */
    }else list=await getMoments(MOMENT_FEED_FIRST_SCAN);/* 首屏只读最近 MOMENT_FEED_FIRST_SCAN(60) 条，游标即停，不扫 360 */
  }catch(e){
    feed.innerHTML='<div class="mom-state">加载失败：'+esc(String(e&&e.message||e).slice(0,120))+' <button type="button" class="btn mom-retry" onclick="loadMomentsPage()">重试</button></div>';
    return
  }
  if(!opts.keepPage)_momentsFeedShown=MOMENT_FEED_PAGE;/* 查询变化时重置分页；加载更多时保留 */
  const stats=document.getElementById('mom-stats');
  if(stats)stats.textContent=(filterRole?'「'+_momentsRoleName(_momentsCfg(filterRole))+'」的朋友圈 · ':'朋友圈 · ')+list.length+' 条'+(scope==='private'?'（私人日志）':'');
  const tips=document.getElementById('mom-role-tips');
  if(tips){
    if(scope==='private')tips.textContent=list.length?('共 '+list.length+' 条私人日志'):'';
    else{
      const authors=new Set(list.map(m=>_momentIsUserAuthor(m)?_momentsUserDisplayName():_momentsRoleName(_momentsCfg(m.roleId))));
      authors.delete('');
      tips.textContent=authors.size?('共 '+authors.size+' 位朋友在分享'):''
    }
  }
  if(!list.length){
    feed.innerHTML='<div class="mom-state">'+(scope==='private'?'这个角色的私人日志是空的。':'')+(filterRole&&scope!=='private'?'这个角色还没有发过朋友圈。':'朋友圈还空着。发一条，或等角色自己发布。')+'</div>';
    return
  }
  feed.innerHTML='';
  const frag=document.createDocumentFragment();
  const page=list.slice(0,_momentsFeedShown)/* 首屏分页：只渲染合理数量，图片靠 lazy 解码 */
  for(const m of page){
    const isUserPost=_momentIsUserAuthor(m);
    const cfg=isUserPost?null:_momentsCfg(_momentsAuthorRoleId(m));
    /* 角色私密动态 → 锁占位卡（内容不可见）；用户自己的私密动态 → 正常卡片（作者本人可见） */
    if(m.visibility==='private'&&!isUserPost){
      frag.appendChild(_momentsBuildPrivateCard(m,cfg));
      continue
    }
    const card=document.createElement('article');card.className='mom-card';card.dataset.id=m.id;
    /* 头部（用户作者：复用 Profile 头像/昵称；角色作者：沿用现有解析） */
    const head=document.createElement('div');head.className='mom-card-head';
    head.appendChild(isUserPost?_momentsAvatar(null,_momentsUserDisplayName(),42):_momentsAvatar(cfg,_momentsRoleName(cfg),42));
    if(isUserPost){const av=head.firstChild;if(av&&!av.querySelector('img')){const src=_momentsUserAvatarSrc();if(src){const img=document.createElement('img');img.src=src;img.alt='';img.loading='lazy';img.decoding='async';av.textContent='';av.appendChild(img)}}}
    const headInfo=document.createElement('div');headInfo.className='mom-card-info';
    const name=document.createElement('div');name.className='mom-card-name';name.textContent=isUserPost?_momentsUserDisplayName():_momentsRoleName(cfg);
    const time=document.createElement('div');time.className='mom-card-time';time.textContent=_momentsTimeLabel(m.createdAt);
    headInfo.append(name,time);head.appendChild(headInfo);
    if(m.source==='proactive'){const tag=document.createElement('span');tag.className='mom-tag';tag.textContent='自主';head.appendChild(tag)}
    card.appendChild(head);
    /* 正文 */
    const body=document.createElement('div');body.className='mom-card-body';
    String(m.content||'').split('\n').forEach(ln=>{if(ln){const p=document.createElement('p');p.textContent=ln;body.appendChild(p)}});
    card.appendChild(body);
    /* 图片：1 张大图 / 2-4 网格 / 5+ 九宫格；点击复用聊天大图组件 _viewImageFull */
    if(m.images&&m.images.length){
      const n=m.images.length;
      const grid=document.createElement('div');grid.className='mom-images n'+(n===1?'1':(n>=5?'5plus':'23'));
      m.images.forEach(im=>{
        const w=document.createElement('div');w.className='mom-image';
        const img=document.createElement('img');img.src=String(im&&im.dataUrl||'');img.alt='';img.loading='lazy';img.decoding='async';
        img.onerror=function(){w.remove()};
        img.onclick=function(){try{if(typeof _viewImageFull==='function')_viewImageFull(String(im&&im.dataUrl||''))}catch(e){}};
        w.appendChild(img);grid.appendChild(w)
      });
      card.appendChild(grid)
    }
    /* 操作行 */
    const actions=document.createElement('div');actions.className='mom-actions';
    const liked=!!(m.likes||[]).includes(_activeUserId());
    const likeBtn=document.createElement('button');likeBtn.type='button';likeBtn.className='mom-action-btn'+(liked?' liked':'');
    likeBtn.textContent=(liked?'♥ ':'♡ ')+(m.likes.length||'');
    likeBtn.onclick=()=>likeMoment(m.id);
    const commentBtn=document.createElement('button');commentBtn.type='button';commentBtn.className='mom-action-btn';
    commentBtn.textContent='💬 '+(m.comments.length||'');
    commentBtn.onclick=()=>_momentsToggleComments(m.id);
    const delBtn=document.createElement('button');delBtn.type='button';delBtn.className='mom-action-btn mom-del';
    delBtn.textContent='删除';delBtn.onclick=()=>_momentsDeleteMoment(m.id);
    actions.append(likeBtn,commentBtn,delBtn);card.appendChild(actions);
    /* 评论 */
    const comments=document.createElement('div');comments.className='mom-comments';comments.dataset.mid=m.id;
    _momentsRenderComments(comments,m);
    card.appendChild(comments);
    frag.appendChild(card)
  }
  if(list.length>_momentsFeedShown){
    const more=document.createElement('div');more.className='mom-state mom-more';
    const btn=document.createElement('button');btn.type='button';btn.className='btn';btn.textContent='加载更多（剩余 '+(list.length-_momentsFeedShown)+' 条）';
    btn.onclick=()=>{_momentsFeedShown+=MOMENT_FEED_PAGE;_momentsRenderFeed({keepPage:true})};
    more.appendChild(btn);frag.appendChild(more)
  }
  feed.appendChild(frag)
}
/* 私人日志占位卡：有明确 Private 标识与"H只有 TA 自己能看到"，无内容/无互动（用户不可读不可操作） */
function _momentsBuildPrivateCard(m,cfg){
  const card=document.createElement('article');card.className='mom-card mom-private-lock';card.dataset.id=m.id;
  const head=document.createElement('div');head.className='mom-card-head';
  head.appendChild(_momentsAvatar(cfg,_momentsRoleName(cfg),42));
  const headInfo=document.createElement('div');headInfo.className='mom-card-info';
  const name=document.createElement('div');name.className='mom-card-name';name.textContent=_momentsRoleName(cfg);
  const time=document.createElement('div');time.className='mom-card-time';time.textContent=_momentsTimeLabel(m.createdAt);
  headInfo.append(name,time);head.appendChild(headInfo);
  const tag=document.createElement('span');tag.className='mom-tag mom-tag-private';tag.textContent='Private';
  head.appendChild(tag);
  card.appendChild(head);
  const note=document.createElement('div');note.className='mom-private-note';
  note.textContent='🔒 只有 '+_momentsRoleName(cfg)+' 自己能看到这条私人日志';
  card.appendChild(note);
  return card
}
function _momentsRenderComments(box,m){
  let l=box.querySelector('.mom-comments-list');
  if(!l){
    l=document.createElement('div');l.className='mom-comments-list';box.appendChild(l)
  }
  l.innerHTML='';
  for(const c of (m.comments||[])){
    const row=document.createElement('div');row.className='mom-comment-row';
    const who=document.createElement('span');who.className='mom-comment-name';
    who.textContent=c.authorType==='role'?_momentsRoleName(_momentsCfg(c.authorId)):'我';
    const txt=document.createElement('span');txt.className='mom-comment-text';txt.textContent=String(c.content||'');
    if(c.withdrawn)txt.classList.add('withdrawn');
    const time=document.createElement('span');time.className='mom-comment-time';time.textContent=_momentsTimeLabel(c.createdAt);
    row.append(who,document.createTextNode('：'),txt,time);
    if(_momentsCanDeleteComment(m,c)){/* 仅楼主/评论者本人可见删除按钮（微信式评论权限） */
      const del=document.createElement('button');del.type='button';del.className='mom-comment-del';del.textContent='✕';
      del.title='删除评论';
      del.onclick=()=>deleteMomentComment(m.id,c.id);
      row.appendChild(del);
    }
    l.appendChild(row)
  }
  let input=box.querySelector('.mom-comment-input');
  if(!input){
    input=document.createElement('div');input.className='mom-comment-input';
    const inp=document.createElement('input');inp.type='text';inp.placeholder='写下你的评论…';inp.maxLength=300;
    const btn=document.createElement('button');btn.type='button';btn.className='btn btn-primary';btn.textContent='发送';
    btn.onclick=async()=>{
      const v=inp.value.trim();if(!v)return;
      btn.disabled=true;
      const r=await addMomentComment(m.id,{authorType:'user',authorId:_activeUserId(),content:v});
      btn.disabled=false;
      if(r.ok)inp.value='';else toast(r.error||'评论失败')
    };
    input.append(inp,btn);box.appendChild(input)
  }
}
function _momentsToggleComments(id){
  const card=document.querySelector('.mom-card[data-id="'+id+'"]');
  if(!card)return;
  const box=card.querySelector('.mom-comments');
  if(box){box.classList.toggle('open');const inp=box.querySelector('.mom-comment-input input');if(inp&&box.classList.contains('open'))inp.focus()}
}
async function _momentsDeleteMoment(id){
  if(!confirm('删除这条朋友圈？'))return;
  await deleteMoment(id);toast('已删除')
}
/* 手动生成：指定角色（缺省取第一个可用角色） */
async function _momentsAskGenerate(roleId){
  const sel=document.getElementById('mom-role-filter');
  const ready=apiConfigs.filter(a=>_ibApiReady(a));
  const id=roleId||(sel&&sel.value&&_ibApiReady(_momentsCfg(sel.value))?sel.value:(ready.length?ready[0].id:''));
  if(!id){toast('请先在 API 页面添加可用角色');return}
  toast('正在让 '+(function(){const c=_momentsCfg(id);return c?(c.nickname||c.model||'TA'):'TA'})()+' 思考朋友圈…');
  const r=await generateRoleMoment(id,{trigger:'manual'});
  if(r.ok&&r.published)toast('已发布：'+(r.moment?String(r.moment.content||'').slice(0,24)+'…':''));
  else if(r.ok&&!r.published)toast('TA 选择今天不发布'+(r.reason?('（'+r.reason+'）'):''));
  else toast('发布失败：'+(r.error||'未知错误'))
}
/* 手动发布（作者固定为用户本人；名称/头像复用现有 Profile，不建第二套身份） */
async function _momentsSubmitCompose(){
  const visEl=document.getElementById('mom-compose-vis');
  const visibility=visEl&&visEl.value==='private'?'private':'all';
  const text=(document.getElementById('mom-compose-text')?.value||'').trim();
  const imgs=_momentsComposeImages;
  if(!text&&!(imgs&&imgs.length)){toast('写点什么或加张图片再发');return}
  toast('发布中…');
  const r=await createMoment({authorType:'user',authorId:_activeUserId(),content:text,images:imgs,source:'manual',visibility:visibility});
  if(r.ok){
    const t=document.getElementById('mom-compose-text');if(t)t.value='';
    if(visEl)visEl.value='all';
    _momentsComposeImages=[];_momentsRenderComposePreviews();
    toast('已发布')
  }else toast(r.error||'发布失败')
}
function _momentsRenderComposeIdentity(){
  const box=document.getElementById('mom-compose-me');
  if(!box)return;
  box.innerHTML='';
  const av=_momentsAvatar(null,_momentsUserDisplayName(),22);
  const src=_momentsUserAvatarSrc();
  if(src){const img=document.createElement('img');img.src=src;img.alt='';img.loading='lazy';img.decoding='async';av.textContent='';av.appendChild(img)}
  const label=document.createElement('span');label.textContent=_momentsUserDisplayName()+'（本人）';
  box.append(av,label)
}
let _momentsComposeImages=[];
function _momentsPickImages(){  const inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.multiple=true;
  inp.onchange=async function(){
    for(const f of Array.from(inp.files||[]).slice(0,9-_momentsComposeImages.length)){
      if(!f.type.startsWith('image/')){toast('仅支持图片文件');continue}
      try{_momentsComposeImages.push(await compressImage(f))}catch(e){toast('图片读取失败')}
    }
    _momentsRenderComposePreviews()
  };inp.click()
}
function _momentsRenderComposePreviews(){
  const box=document.getElementById('mom-compose-imgs');
  if(!box)return;
  box.innerHTML='';
  _momentsComposeImages.forEach((im,i)=>{
    const w=document.createElement('div');w.className='mom-image';
    const img=document.createElement('img');img.src=im.dataUrl;img.alt='';img.loading='lazy';img.decoding='async';w.appendChild(img);
    const del=document.createElement('button');del.type='button';del.className='mom-remove-image';del.textContent='✕';
    del.onclick=()=>{_momentsComposeImages.splice(i,1);_momentsRenderComposePreviews()};
    w.appendChild(del);box.appendChild(w)
  })
}
function _momentsRenderSettings(){
  const p=_momentsPrefs();
  const chk=(id,v)=>{const el=document.getElementById(id);if(el)el.checked=!!v};
  chk('mom-up-enabled',p.enabled);chk('mom-auto-publish',p.autoPublish);chk('mom-ai-comment',p.aiComment);chk('mom-ai-like',p.aiLike);chk('mom-other-visible',p.otherRolesVisible);
  chk('mom-obs-enabled',!!(OBS&&OBS.isEnabled()));
  const fr=document.getElementById('mom-freq');
  if(fr)fr.value=p.frequency
}
function _momentsSaveSettings(){
  const chk=(id,d)=>{const el=document.getElementById(id);return el?el.checked:d};
  const val=(id,d)=>{const el=document.getElementById(id);return el?el.value:d};
  const p={enabled:chk('mom-up-enabled',true),autoPublish:chk('mom-auto-publish',true),aiComment:chk('mom-ai-comment',true),aiLike:chk('mom-ai-like',true),otherRolesVisible:chk('mom-other-visible',true),frequency:['low','medium','high'].includes(val('mom-freq','medium'))?val('mom-freq','medium'):'medium'};
  _momentsPrefsSave(p);
  try{if(OBS)OBS.setEnabled(chk('mom-obs-enabled',true))}catch(e){}
  toast('朋友圈设置已保存');return false
}
/* ── 观测查看/导出（本地；不含任何正文内容）── */
async function _socialObsStats(days){
  days=Math.max(1,Math.min(30,Number(days)||14));
  let threads=null;
  try{
    const list=await _momentsScanDesc(720);
    threads=OBS?OBS.computeThreadStats(list,{nowMs:Date.now(),roundsFn:_momentsChainRound}):null;
    if(threads&&threads.threads)threads.threads=threads.threads.filter(t=>!t.zeroCommentPost);
  }catch(e){threads={error:String(e&&e.message||e).slice(0,80)}}
  const rep=OBS?OBS.report({days:days,affinityFn:_momentsPairAffinity}):{enabled:false,error:'observer unavailable'};
  rep.affinitySnapshot=(OBS&&OBS.pairAffinitySnapshot)?OBS.pairAffinitySnapshot((apiConfigs||[]).map(a=>a.id),_momentsPairAffinity):[];
  rep.threads=threads;
  return rep
}
async function _socialObsPrint(days){
  const rep=await _socialObsStats(days);
  try{console.log('[SocialObserve] '+JSON.stringify(rep.totals));console.table(rep.daily.map(d=>({date:d.date,posts:d.posts,declined:d.declined,pFalse:d.publishFalseRatio,comments:d.comments,replies:d.replies,likes:d.likes,llm:d.llmCalls,inTok:d.promptTokens,outTok:d.outputTokens})));console.table(rep.interactionMatrix.slice(0,20))}catch(e){}
  return rep
}
async function _socialObsDownload(){
  try{
    const data=await _socialObsStats(30);
    const blob=new Blob([JSON.stringify(data,null,1)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download='ib-social-observe-'+new Date().toISOString().slice(0,10)+'.json';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){try{URL.revokeObjectURL(a.href)}catch(e){}},4000);
    toast('观测数据已导出（仅本机）')
  }catch(e){toast('导出失败：'+String(e&&e.message||e).slice(0,60))}
}
function loadMomentsPage(opts){
  opts=opts||{};
  try{
    _momComposeMentionInit();/* @ 提及补全面板（v7）：输入 @ 弹出角色候选 */
    _momentsRenderSettings();
    const filter=document.getElementById('mom-role-filter');
    if(filter){
      const cur=filter.value;
      filter.innerHTML='';
      const o=document.createElement('option');o.value='';o.textContent='全部角色';filter.appendChild(o);
      apiConfigs.forEach(a=>{const oo=document.createElement('option');oo.value=a.id;oo.textContent=(a.nickname||a.model||'AI');filter.appendChild(oo)});
      if(cur&&apiConfigs.some(a=>a.id===cur))filter.value=cur;
      else if(window._momentsPendingRole){filter.value=window._momentsPendingRole;window._momentsPendingRole=''}
      filter.onchange=()=>{try{_momentsRenderFeed()}catch(e){}}
    }
    _momentsRenderComposeIdentity();
    _momentsRenderComposePreviews();
    /* skipFeed：只做页面级设置（设置区/筛选下拉/输入区），不渲染 feed。
       社交网络视图接管 Moments 页时用它复用设置逻辑，由 _netRenderFeed 单独渲染，避免双渲染。 */
    if(!opts.skipFeed)_momentsRenderFeed()
  }catch(e){console.warn('[Moments] page load failed',String(e&&e.message||e).slice(0,200))}
}
/* API 编辑页 → 该角色朋友圈（入口：好友卡片/设置面板提供跳转） */
function _momentsOpenRole(roleId){
  window._momentsPendingRole=roleId||'';
  navTo('moments');
  setTimeout(loadMomentsPage,60)
}

/* 测试辅助：重置同步节流与版本不匹配窗口（生产路径不调用） */
function _momentsResetSyncForTest(){_momentsLastSyncAt=0;_momentsCompanionBrokenAt=0;return true}

/* 迁移期双挂载：HTML 与其他脚本仍通过 window 访问。 */
window.MOMENT_STORE=MOMENT_STORE;
window.MOMENT_FEED_FIRST_SCAN=MOMENT_FEED_FIRST_SCAN;/* 首屏读取上限（社交圈视图复用同一定义） */
window._momentsPrefs=_momentsPrefs;
window._momentsPrefsSave=_momentsPrefsSave;
window._momentsState=_momentsState;
window._momentsSetState=_momentsSetState;
window._momentsDefaults=_momentsDefaults;
window._momentsVisibleToUser=_momentsVisibleToUser;
window._momentsVisibleToRole=_momentsVisibleToRole;
window.createMoment=createMoment;
window.getMoments=getMoments;
window.getRoleMoments=getRoleMoments;
window.getMoment=getMoment;
window.deleteMoment=deleteMoment;
window.likeMoment=likeMoment;
window._momentsPatchLikeUI=_momentsPatchLikeUI;
window.addMomentComment=addMomentComment;
window.deleteMomentComment=deleteMomentComment;
window._momentsContext=_momentsContext;
window.buildMomentPrompt=buildMomentPrompt;
window.buildMomentCommentPrompt=buildMomentCommentPrompt;
window._momentsParseOutput=_momentsParseOutput;
window._momentsParseCommentOutput=_momentsParseCommentOutput;
window._momentsDuplicateCheck=_momentsDuplicateCheck;
window.generateRoleMoment=generateRoleMoment;
window.generateRoleComment=generateRoleComment;
window._momentsMaybeComment=_momentsMaybeComment;
window._momentsMaybeLike=_momentsMaybeLike;
window._momentsLikeEligible=_momentsLikeEligible;
window._momentsApplyLikes=_momentsApplyLikes;
window._momentsRecordLike=_momentsRecordLike;
window._momentsLikeState=_momentsLikeState;
window._momentsPairAffinity=_momentsPairAffinity;
window._momentsScanDesc=_momentsScanDesc;
window._momentsCompanionSnapshot=_momentsCompanionSnapshot;
window._momentsLocalTick=_momentsLocalTick;
window._momentsSetCommentQ=_momentsSetCommentQ;
window._momentsTick=_momentsTick;
window._momentsSyncCompanion=_momentsSyncCompanion;
window._momentsPullCompanionEvents=_momentsPullCompanionEvents;
window._momentsIngestEvent=_momentsIngestEvent;
window._momentsMakeImage=_momentsMakeImage;
window._momentsInjectImages=_momentsInjectImages;
window._momentsVisionKind=_momentsVisionKind;
window._momentsAppendNote=_momentsAppendNote;
window._momentsParseMentions=_momentsParseMentions;
window._momentsMentionCanForce=_momentsMentionCanForce;
window._momentsMaybeMention=_momentsMaybeMention;
window._momentsMaybeMentionComment=_momentsMaybeMentionComment;
window._momentsCommentShouldWithdraw=_momentsCommentShouldWithdraw;
window._momentsCanDeleteComment=_momentsCanDeleteComment;
window._momentsAuthorCanDelete=_momentsAuthorCanDelete;
window._momentsApplyDelComments=_momentsApplyDelComments;
window._momComposeMentionInit=_momComposeMentionInit;
window._momMentionPrefix=_momMentionPrefix;
window._momMentionCandidates=_momMentionCandidates;
window._momComposeMentionInsert=_momComposeMentionInsert;
window.getMomentsContext=getMomentsContext;
window._momentsTimeLabel=_momentsTimeLabel;
window.loadMomentsPage=loadMomentsPage;
window._momentsRenderFeed=_momentsRenderFeed;
window._momentsRenderSettings=_momentsRenderSettings;
window._momentsSaveSettings=_momentsSaveSettings;
window._momentsAskGenerate=_momentsAskGenerate;
window._momentsSubmitCompose=_momentsSubmitCompose;
window._momentsPickImages=_momentsPickImages;
window._momentsRenderComposeIdentity=_momentsRenderComposeIdentity;
window._momentIsUserAuthor=_momentIsUserAuthor;
window._momentsAuthorRoleId=_momentsAuthorRoleId;
window._momentsUserDisplayName=_momentsUserDisplayName;
window._momentsResetSyncForTest=_momentsResetSyncForTest;
window._momentsDiagnoseOutput=_momentsDiagnoseOutput;
window._momentsOpenRole=_momentsOpenRole;
/* ── 行为观测导出 ── */
window._socialObsStats=_socialObsStats;
window._socialObsPrint=_socialObsPrint;
window._socialObsDownload=_socialObsDownload;
window._socialObserveApi=function(){return OBS};
/* ── AI↔AI 回复链导出 ── */
window.buildMomentReplyPrompt=buildMomentReplyPrompt;
window._momentsParseReplyOutput=_momentsParseReplyOutput;
window._momentsReplyLowInfo=_momentsReplyLowInfo;
window._momentsPickNextStep=_momentsPickNextStep;
window._momentsChainPick=_momentsChainPick;
window._momentsReplyChainPlan=_momentsReplyChainPlan;
window._momentsReplyChainState=_momentsReplyChainState;
window._momentsReplyChainSave=_momentsReplyChainSave;
window._momentsReplyRoomOk=_momentsReplyRoomOk;
window._momentsChainRound=_momentsChainRound;
window._momentsCommentLogCount=_momentsCommentLogCount;
window._momentsCommentLogRecord=_momentsCommentLogRecord;
window._momentsMaybeReplyChain=_momentsMaybeReplyChain;
window._momentsRunReplyStage=_momentsRunReplyStage;
window._momentsSetReplyDelayForTest=_momentsSetReplyDelayForTest;
window.generateRoleReply=generateRoleReply;
window._momentsCompanionOwnsReplyChain=_momentsCompanionOwnsReplyChain;
window._momentsReplyChainCapability=_momentsReplyChainCapability;
window._momentsSetReplyChainCapabilityForTest=_momentsSetReplyChainCapabilityForTest;
NS.expose('moments',{
  MOMENT_STORE:MOMENT_STORE,
  _momentsPrefs:_momentsPrefs,
  _momentsPrefsSave:_momentsPrefsSave,
  _momentsState:_momentsState,
  _momentsSetState:_momentsSetState,
  _momentsDefaults:_momentsDefaults,
  _momentsVisibleToUser:_momentsVisibleToUser,
  _momentsVisibleToRole:_momentsVisibleToRole,
  createMoment:createMoment,
  getMoments:getMoments,
  getRoleMoments:getRoleMoments,
  getMoment:getMoment,
  deleteMoment:deleteMoment,
  likeMoment:likeMoment,
  _momentsPatchLikeUI:_momentsPatchLikeUI,
  addMomentComment:addMomentComment,
  deleteMomentComment:deleteMomentComment,
  _momentsContext:_momentsContext,
  buildMomentPrompt:buildMomentPrompt,
  buildMomentCommentPrompt:buildMomentCommentPrompt,
  _momentsParseOutput:_momentsParseOutput,
  _momentsParseCommentOutput:_momentsParseCommentOutput,
  _momentsDuplicateCheck:_momentsDuplicateCheck,
  generateRoleMoment:generateRoleMoment,
  generateRoleComment:generateRoleComment,
  _momentsMaybeComment:_momentsMaybeComment,
  _momentsMaybeLike:_momentsMaybeLike,
  _momentsLikeEligible:_momentsLikeEligible,
  _momentsApplyLikes:_momentsApplyLikes,
  _momentsRecordLike:_momentsRecordLike,
  _momentsLikeState:_momentsLikeState,
  _momentsPairAffinity:_momentsPairAffinity,
  _momentsScanDesc:_momentsScanDesc,
  _momentsCompanionSnapshot:_momentsCompanionSnapshot,
  _momentsLocalTick:_momentsLocalTick,
  _momentsSetCommentQ:_momentsSetCommentQ,
  _momentsTick:_momentsTick,
  _momentsSyncCompanion:_momentsSyncCompanion,
  _momentsPullCompanionEvents:_momentsPullCompanionEvents,
  _momentsIngestEvent:_momentsIngestEvent,
  _momentsMakeImage:_momentsMakeImage,
  getMomentsContext:getMomentsContext,
  _momentsTimeLabel:_momentsTimeLabel,
  loadMomentsPage:loadMomentsPage,
  _momentsRenderFeed:_momentsRenderFeed,
  _momentsRenderSettings:_momentsRenderSettings,
  _momentsSaveSettings:_momentsSaveSettings,
  _momentsAskGenerate:_momentsAskGenerate,
  _momentsSubmitCompose:_momentsSubmitCompose,
  _momentsPickImages:_momentsPickImages,
  _momentsRenderComposeIdentity:_momentsRenderComposeIdentity,
  _momentIsUserAuthor:_momentIsUserAuthor,
  _momentsAuthorRoleId:_momentsAuthorRoleId,
  /* ── AI↔AI 回复链 ── */
  buildMomentReplyPrompt:buildMomentReplyPrompt,
  _momentsParseReplyOutput:_momentsParseReplyOutput,
  _momentsReplyLowInfo:_momentsReplyLowInfo,
  _momentsPickNextStep:_momentsPickNextStep,
  _momentsChainPick:_momentsChainPick,
  _momentsReplyChainPlan:_momentsReplyChainPlan,
  _momentsReplyChainState:_momentsReplyChainState,
  _momentsReplyChainSave:_momentsReplyChainSave,
  _momentsReplyRoomOk:_momentsReplyRoomOk,
  _momentsChainRound:_momentsChainRound,
  _momentsCommentLogCount:_momentsCommentLogCount,
  _momentsCommentLogRecord:_momentsCommentLogRecord,
  _momentsMaybeReplyChain:_momentsMaybeReplyChain,
  _momentsRunReplyStage:_momentsRunReplyStage,
  _momentsSetReplyDelayForTest:_momentsSetReplyDelayForTest,
  generateRoleReply:generateRoleReply,
  _momentsCompanionOwnsReplyChain:_momentsCompanionOwnsReplyChain,
  _momentsReplyChainCapability:_momentsReplyChainCapability,
  _momentsSetReplyChainCapabilityForTest:_momentsSetReplyChainCapabilityForTest,
  _momentsUserDisplayName:_momentsUserDisplayName,
  _momentsResetSyncForTest:_momentsResetSyncForTest,
  _momentsDiagnoseOutput:_momentsDiagnoseOutput,
  _momentsOpenRole:_momentsOpenRole,
  /* ── 行为观测 ── */
  _socialObsStats:_socialObsStats,
  _socialObsPrint:_socialObsPrint,
  _socialObsDownload:_socialObsDownload
});
})(window.IB || (window.IB = {}));
