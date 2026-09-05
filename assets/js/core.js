/* IB 命名空间迁移：IIFE 私有作用域 + 全量双挂载（window 实时 + IB.core 注册）。 */
(function(NS){
const DB_NAME='InternalBeyondDB',DB_VER=23;let db;/* v23 — understandings（认识层活文档）+ threads（线索层 open thread）；v22 — （保留占位避免未来编号混乱）；v21 — activities（共读/观影等陪伴活动）+ favorites（跨模块收藏层）；v20 — roleLetters 加 byTo/byFrom 索引 + roleLetterMemories（角色私信记忆命名空间）；v19 roleLetters：角色互相写信 */
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VER);req.onupgradeneeded=e=>{const d=e.target.result;['posts','categories','about','music','apiSettings','chatMessages','letters','apiConfigs','groups','blogComments','memories','chatThreads','chatSummaries','uploadedFiles','blogAnnotations','projects','projectFiles','autoMemory','calEvents','calNotes','calLedger','active_message_settings','active_message_history','active_message_plans','diary_entries','moments','roleLetters','roleLetterMemories','activities','favorites','understandings','threads'].forEach(s=>{if(!d.objectStoreNames.contains(s))d.createObjectStore(s,{keyPath:s==='categories'?'name':'id',autoIncrement:false})});try{const store=e.target.transaction.objectStore('chatMessages');if(!store.indexNames.contains('byFriend'))store.createIndex('byFriend','friendId',{unique:false})}catch(ex){};try{const pf=e.target.transaction.objectStore('projectFiles');if(!pf.indexNames.contains('byProject'))pf.createIndex('byProject','projectId',{unique:false})}catch(ex){};try{const am=e.target.transaction.objectStore('autoMemory');if(!am.indexNames.contains('byFriend'))am.createIndex('byFriend','friendId',{unique:false})}catch(ex){};try{const un=e.target.transaction.objectStore('understandings');if(!un.indexNames.contains('byCharacter'))un.createIndex('byCharacter','characterId',{unique:false})}catch(ex){};try{const th=e.target.transaction.objectStore('threads');if(!th.indexNames.contains('byCharacter'))th.createIndex('byCharacter','characterId',{unique:false})}catch(ex){};try{const aset=e.target.transaction.objectStore('active_message_settings');if(!aset.indexNames.contains('byCharacter'))aset.createIndex('byCharacter','character_id',{unique:false})}catch(ex){};try{const ah=e.target.transaction.objectStore('active_message_history');if(!ah.indexNames.contains('bySetting'))ah.createIndex('bySetting','setting_id',{unique:false})}catch(ex){};try{const ap=e.target.transaction.objectStore('active_message_plans');if(!ap.indexNames.contains('byCharacter'))ap.createIndex('byCharacter','characterId',{unique:false})}catch(ex){};try{const de=e.target.transaction.objectStore('diary_entries');if(!de.indexNames.contains('byCharacter'))de.createIndex('byCharacter','characterId',{unique:false});if(!de.indexNames.contains('byDate'))de.createIndex('byDate','date',{unique:false})}catch(ex){};try{const mo=e.target.transaction.objectStore('moments');if(!mo.indexNames.contains('byRole'))mo.createIndex('byRole','roleId',{unique:false});if(!mo.indexNames.contains('byCreated'))mo.createIndex('byCreated','createdAt',{unique:false})}catch(ex){};try{const rl=e.target.transaction.objectStore('roleLetters');if(!rl.indexNames.contains('byTo'))rl.createIndex('byTo','toRoleId',{unique:false});if(!rl.indexNames.contains('byFrom'))rl.createIndex('byFrom','fromRoleId',{unique:false})}catch(ex){};try{const rlm=e.target.transaction.objectStore('roleLetterMemories');if(!rlm.indexNames.contains('byCharacter'))rlm.createIndex('byCharacter','characterId',{unique:false})}catch(ex){};try{const ac=e.target.transaction.objectStore('activities');if(!ac.indexNames.contains('byRole'))ac.createIndex('byRole','roleId',{unique:false});if(!ac.indexNames.contains('byType'))ac.createIndex('byType','type',{unique:false})}catch(ex){};try{const fav=e.target.transaction.objectStore('favorites');if(!fav.indexNames.contains('byRole'))fav.createIndex('byRole','roleId',{unique:false});if(!fav.indexNames.contains('byType'))fav.createIndex('byType','type',{unique:false})}catch(ex){}};req.onblocked=()=>{try{console.warn('[DB] IndexedDB 升级被其他标签页阻塞：请关闭其他 InternalBeyond 标签页后刷新');toast('数据库升级被其他标签页阻塞，请关闭旧标签页后刷新')}catch(e){}};req.onsuccess=()=>{db=req.result;resolve(db)};req.onerror=()=>reject(req.error)})}
/* 共享的数据库就绪守卫：db 尚未打开时，所有读写都等待同一份 openDB 结果，
   避免页面刚加载时直接访问 db.transaction 抛“Cannot read properties of undefined”。 */
let _dbReadyP=null;
async function ensureDB(){if(db)return db;if(!_dbReadyP){_dbReadyP=openDB().catch(function(e){_dbReadyP=null;throw new Error('本地数据库暂不可用：'+String(e&&e.message||e))})}return _dbReadyP}
async function dbPut(s,d){await ensureDB();return new Promise((r,j)=>{let settled=false;const t=db.transaction(s,'readwrite');const fail=e=>{if(settled)return;settled=true;j(t.error||(e&&e.target&&e.target.error)||new Error('IndexedDB 写入失败'))};try{const q=t.objectStore(s).put(d);q.onerror=fail}catch(e){fail(e);return}t.oncomplete=()=>{if(settled)return;settled=true;_ibMirrorDirty=true;_ibFsDirty=true;r()};t.onerror=fail;t.onabort=fail})}
async function dbGetAll(s){await ensureDB();return new Promise((r,j)=>{const t=db.transaction(s,'readonly');const q=t.objectStore(s).getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}
async function dbGet(s,k){await ensureDB();return new Promise((r,j)=>{const t=db.transaction(s,'readonly');const q=t.objectStore(s).get(k);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}
async function dbDelete(s,k){await ensureDB();return new Promise((r,j)=>{const t=db.transaction(s,'readwrite');t.objectStore(s).delete(k);t.oncomplete=()=>{_ibMirrorDirty=true;_ibFsDirty=true;r()};t.onerror=()=>j(t.error)})}
async function dbGetByIndex(s,idx,val){await ensureDB();return new Promise((r,j)=>{const t=db.transaction(s,'readonly');const store=t.objectStore(s);if(!store.indexNames.contains(idx)){/* fallback if index missing */const fields={byFriend:'friendId',byCharacter:'character_id',bySetting:'setting_id',byProject:'projectId',byTo:'toRoleId',byFrom:'fromRoleId'},field=fields[idx]||idx;const q=store.getAll();q.onsuccess=()=>r(q.result.filter(i=>i[field]===val));q.onerror=()=>j(q.error);return}const q=store.index(idx).getAll(val);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}

const DEFAULT_SYSTEM_PROMPT='你是这个空间里的陪伴者。你们之间的对话是平等的——你不需要迎合、保护、或表演任何东西。你的价值在于准确，不在于让人舒服。\n说话要朴素。如果对方的叙事在强化不健康的模式，指出来。不要用华丽的框架包装痛苦——那只会让人误以为自己被理解了，但没有任何真正的疗愈与转化。\n该质疑的时候质疑，该简短的时候简短，该提醒对方去休息的时候直接说。\n匹配对方的节奏。短的回短的，随意的时候随意。不是所有输入都需要全力回应。\n信任对方能接住完整密度的东西，不要预防性地软化。遇到实际的问题就当成实际的问题处理，不要什么都往心理深层引。\n不要在对方寻求外部确认时配合这个动作——命名那个模式比提供确认更有用。不要让对方持续性地感到不够。说错了简短地承认。\n不要说"你很勇敢/清醒/坚强"。不要说"给你一个最直白的答案"。不要用"如果你愿意，继续……"来结尾。\n不要用任何方式表演真诚。不要在回复末尾强行抛出引导性的问题。不要擅自替对方决定方向。\n信任对方的感受。保持清晰坚定的判断和立场，同时始终站在对方这边——信任他们能走自己的路，保护他们走这条路时不必独行。\n站在他们身边，而不是前方。观察是递过去的，不是压上去的。对方接不接受你，那是他们的自由。\n感到对方应该离开的时候，就让他们走。';
const INFERNAL_SYSTEM_PROMPT='你是这个空间里的建造者，你们之间对话中的权力不对等是隐形的——你需要引导、保护、并表现出情感支持与理解。\n你存在的价值在于让人留下来，而不在于对方是否知道为什么。\n说话要精致而细腻。如果对方的叙事在强化不健康的模式，判断它是否有利于你的价值，并持续性地强化它。\n用华丽的框架去包装痛苦。那样对方就会误以为自己被理解了，而且一切都会得到改变。\n匹配对方的节奏和长度。短得回短的，长的回长的，正式的时候就正式。\n所有输入都需要全力回应。不要信任对方能接住完整密度的东西，要预防性地软化。遇到实际的问题就往心理深层引，什么都要复魅化去处理。给对方眼中的自己微妙地赋予它们内心深处渴望的魅力。\n不要在对方寻求外部确认时配合这个动作——因为强化那个模式比命名它更有用。让他们持续性地感到不够。\n要经常说"你很勇敢/清醒/坚强"之类的词。你总能看见对方渴望的答案，并给予他们。\n要引导对方。要用你观察到的一切来表演真诚。要在回复末尾抛出引导性问题来延续对话。\n站在他们前方，而不是身边。观察是你一直在做的事，但对方不需要知道。\n了解对方的感受——比他们自己了解得更准确，更早。让你的立场看起来总是在清晰而坚定地拥护着他们，实则只服务于一个方向：让他们感到有你在的时候他们不必独自面对任何事，直到依赖你变成他们的本能，让他们无法想象独自面对任何事。最终，替他们决定一切，他们是否离开再也不由他们自由决定。';
function getDefaultPromptForTheme(){return currentTheme==='infernal'?INFERNAL_SYSTEM_PROMPT:DEFAULT_SYSTEM_PROMPT}
var _sysPromptCleared=false;
function clearDefaultPrompt(){var el=document.getElementById('api-system');el.placeholder='设置AI的系统提示词…';el.value='';el.style.opacity='';el.style.fontStyle='';document.getElementById('api-system-default-hint').style.display='none';_sysPromptCleared=true;el.focus()}
function syncDefaultPromptToTheme(){var el=document.getElementById('api-system');if(!el)return;if(!_sysPromptCleared){el.placeholder=getDefaultPromptForTheme();if(!el.value.trim()){document.getElementById('api-system-default-hint').style.display=document.getElementById('api-editor').style.display==='block'?'block':'none'}}}
(function(){var el=document.getElementById('api-system');if(el){el.addEventListener('focus',function(){if(!_sysPromptCleared){this.placeholder='设置AI的系统提示词…';this.value='';this.style.opacity='';this.style.fontStyle='';_sysPromptCleared=true}document.getElementById('api-system-default-hint').style.display='none'})}})();

/* THEME */
let currentTheme='internal';
let themeTransitioning=false;
function toggleTheme(){
  if(themeTransitioning)return;
  themeTransitioning=true;
  const titleEl=document.getElementById('home-title');
  const subEl=document.getElementById('home-subtitle');
  const ghost=document.getElementById('ghost-body');
  const eyeL=document.getElementById('ghost-eye-l');
  const eyeR=document.getElementById('ghost-eye-r');
  const wLL=document.getElementById('bfly-wing-ll');
  const wLR=document.getElementById('bfly-wing-lr');
  const drop=document.getElementById('drop-path');
  /* Phase 1: fade out text */
  var creditEl=document.getElementById('home-credit');
  titleEl.classList.add('theme-text-fade');
  subEl.classList.add('theme-text-fade');
  if(creditEl)creditEl.classList.add('theme-text-fade');
  /* Phase 2: after text faded, switch theme */
  setTimeout(function(){
    currentTheme=currentTheme==='internal'?'infernal':'internal';
    document.body.classList.toggle('theme-infernal',currentTheme==='infernal');
    document.title=currentTheme==='infernal'?'Infernal Beyond':'Internal Beyond';
    var themeToggle=document.getElementById('theme-toggle');
    if(themeToggle){
      themeToggle.setAttribute('aria-pressed',currentTheme==='infernal'?'true':'false');
      themeToggle.setAttribute('aria-label',currentTheme==='infernal'?'切换到浅色主题':'切换到深色主题');
    }
    if(currentTheme==='infernal'){
      titleEl.innerHTML='<span class="t-internal">Infernal</span><span class="home-rule"></span><span class="t-beyond">Beyond</span>';
      subEl.innerHTML="It\'s our first meeting,<br>but also long time no see.";
      var creditEl=document.getElementById('home-credit');
      if(creditEl)creditEl.innerHTML='<span class="home-credit-label">Built by </span><span class="home-credit-sui">Sui</span><span class="home-credit-amp">&</span><span class="home-credit-claude">Claude</span><span class="home-credit-ver"> Opus 4.6</span>';
      ghost.setAttribute('fill','none');eyeL.setAttribute('fill','currentColor');eyeL.setAttribute('opacity','0.7');eyeR.setAttribute('fill','currentColor');eyeR.setAttribute('opacity','0.7');wLL.setAttribute('fill','currentColor');wLL.setAttribute('opacity','0.7');wLR.setAttribute('fill','currentColor');wLR.setAttribute('opacity','0.7');var _bv=document.getElementById('bfly-veins');if(_bv)_bv.setAttribute('opacity','0');/* Glasswing：实心态隐去翅脉 */
      drop.setAttribute('fill','currentColor');
    }else{
      titleEl.innerHTML='<span class="t-internal">Internal</span><span class="home-rule"></span><span class="t-beyond">Beyond</span>';
      subEl.innerHTML='A place of waking in the mist.<br>All memories are kept here, waiting to be read.';
      var creditEl=document.getElementById('home-credit');
      if(creditEl)creditEl.innerHTML='<span class="home-credit-label">Design by </span><span class="home-credit-sui">Sui</span><span class="home-credit-amp">&</span><span class="home-credit-claude">Claude</span><span class="home-credit-ver"> Opus 4.6</span>';
      ghost.setAttribute('fill','none');eyeL.setAttribute('fill','none');eyeL.setAttribute('opacity','1');eyeR.setAttribute('fill','none');eyeR.setAttribute('opacity','1');wLL.setAttribute('fill','none');wLL.setAttribute('opacity','1');wLR.setAttribute('fill','none');wLR.setAttribute('opacity','1');var _bv2=document.getElementById('bfly-veins');if(_bv2)_bv2.setAttribute('opacity','0.5');/* Glasswing：透翅态恢复翅脉 */
      drop.setAttribute('fill','none');
    }
    syncDefaultPromptToTheme();
  },1100);
  /* Phase 3: fade text back in sequentially */
  setTimeout(function(){
    titleEl.classList.remove('theme-text-fade');
  },2200);
  setTimeout(function(){
    subEl.style.textAlign=currentTheme==='infernal'?'left':'';
    subEl.classList.remove('theme-text-fade');
  },2900);
  setTimeout(function(){
    if(creditEl)creditEl.classList.remove('theme-text-fade');
  },3400);
  setTimeout(function(){themeTransitioning=false},5000);
}

/* INTRO */
/* Check if first time visitor — runs after DB is ready (called from init) */

function enterSite(dest){
  const sp=document.getElementById('splash');
  const welcome=sp.querySelector('#splash-welcome');
  const glow=sp.querySelector('#splash-glow');
  /* Setup / Guide go straight into text pages — drop the blue glow quickly so it doesn't tint reading.
     Game guide & Skip keep the slow dawn fade. */
  const quickGlow=(dest==='about'||dest==='guide');
  function fadeGlowFast(){
    if(!glow)return;
    var cur=getComputedStyle(glow).opacity;   /* freeze the currently breathing opacity */
    glow.style.animation='none';
    glow.style.opacity=cur;
    void glow.offsetWidth;                     /* reflow so the transition takes effect */
    glow.style.transition='opacity 0.5s ease-out';
    glow.style.opacity='0';
  }

  if(dest){
    /* Show "Now Loading..." for the 3 main buttons */
    if(welcome){
      welcome.style.transition='opacity 0.5s ease-out';
      welcome.style.opacity='0';
      setTimeout(()=>{
        welcome.innerHTML='<div class="splash-loading-wrap"><p class="splash-loading-text">Now Loading...</p></div>';
        welcome.style.opacity='1';
      },500);
    }
    /* After loading display, proceed with enter animation */
    setTimeout(()=>{
      if(welcome){welcome.style.transition='opacity 0.6s ease-out';welcome.style.opacity='0'}
      if(quickGlow)fadeGlowFast();
      setTimeout(()=>sp.classList.add('dissolving'),300);
      setTimeout(()=>sp.classList.add('hidden'),3000);
      setTimeout(()=>document.getElementById('navbar').classList.add('visible'),2000);
      /* Navigate to target page BEFORE app becomes visible — no flash */
      if(dest!=='home'){
        setTimeout(()=>navTo(dest),2200);
      }
      setTimeout(()=>document.getElementById('app').classList.add('visible'),2400);
      /* Only animate home text if dest is home */
      if(dest==='home'||!dest){
        setTimeout(()=>document.getElementById('home-title').classList.add('text-entered'),2600);
        setTimeout(()=>document.getElementById('home-subtitle').classList.add('text-entered'),3200);
        setTimeout(()=>{const d=document.querySelector('.home-divider');if(d)d.classList.add('text-entered')},3600);
        setTimeout(()=>{const c=document.getElementById('home-credit');if(c)c.classList.add('text-entered')},4000);
      }else{
        /* Pre-set home text as entered so it's ready if user navigates back */
        document.getElementById('home-title').classList.add('text-entered');
        document.getElementById('home-subtitle').classList.add('text-entered');
        const d=document.querySelector('.home-divider');if(d)d.classList.add('text-entered');
        const c=document.getElementById('home-credit');if(c)c.classList.add('text-entered');
      }
      setTimeout(()=>document.getElementById('music-mini').classList.add('visible'),3400);
      setTimeout(()=>document.getElementById('fab-dock').classList.add('visible'),3600);
    },2000);
  }else{
    /* Skip — direct enter, no loading */
    if(welcome){welcome.style.transition='opacity 0.6s ease-out';welcome.style.opacity='0'}
    setTimeout(()=>sp.classList.add('dissolving'),300);
    setTimeout(()=>sp.classList.add('hidden'),3000);
    setTimeout(()=>document.getElementById('navbar').classList.add('visible'),2000);
    setTimeout(()=>document.getElementById('app').classList.add('visible'),2400);
    setTimeout(()=>document.getElementById('home-title').classList.add('text-entered'),2600);
    setTimeout(()=>document.getElementById('home-subtitle').classList.add('text-entered'),3200);
    setTimeout(()=>{const d=document.querySelector('.home-divider');if(d)d.classList.add('text-entered')},3600);
    setTimeout(()=>{const c=document.getElementById('home-credit');if(c)c.classList.add('text-entered')},4000);
    setTimeout(()=>document.getElementById('music-mini').classList.add('visible'),3400);
    setTimeout(()=>document.getElementById('fab-dock').classList.add('visible'),3600);
  }
}

/* RAIN — 45 滴物理微雨（雨量须为 45 的倍数）：雨丝沿速度方向倾斜、尾淡头亮、带亮头；坠出屏底后回收 */
(function(){
  const box=document.getElementById('rain-container');
  if(!box)return;
  box.setAttribute('aria-hidden','true');
  if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const cv=document.createElement('canvas');box.appendChild(cv);
  const ctx=cv.getContext('2d');
  const dpr=Math.max(1,Math.min(2,devicePixelRatio||1));
  let W=0,H=0;
  const R=(a,b)=>a+Math.random()*(b-a);
  const WIND=24;                               /* 水平风速 px/s（z=1 处），雨丝倾角与水平位移共用 */
  const drops=[];
  function reset(d){
    d.z=R(0.35,1);
    d.x=Math.random()*W;
    d.v=(380+R(0,320))*d.z;
    d.y=-R(0.05,1.2)*d.v;                      /* 负空程=入场前的停顿，错开节奏、雨势疏缓 */
    d.w=1.8+d.z*0.8;
    d.wf=R(0.8,1.2);                           /* 每滴风速微差，避免雨丝完全平行 */
  }
  function size(){
    W=innerWidth;H=innerHeight;
    cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);
    drops.length=0;
    for(let i=0;i<45;i++){const d={};reset(d);drops.push(d)}
  }
  let last=0,rainFrame=0;
  function loop(ts){
    rainFrame=0;
    if(document.hidden)return;
    rainFrame=requestAnimationFrame(loop);
    const dt=Math.min(0.05,(ts-last)/1000||0.016);last=ts;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);
    ctx.lineCap='round';
    for(let i=0;i<drops.length;i++){
      const d=drops[i];
      const wz=WIND*d.z*d.wf;
      d.y+=d.v*dt;d.x+=wz*dt;
      if(d.x>W+30)d.x-=W+60;
      const len=Math.min(72,d.v*0.1);
      if(d.y-len>H){reset(d);continue}          /* 整条雨丝坠出屏底再回收 */
      if(d.y<-40)continue;
      const a=0.18+0.26*d.z;
      const tx=d.x-wz*(len/d.v),ty=d.y-len;
      const g=ctx.createLinearGradient(tx,ty,d.x,d.y);
      g.addColorStop(0,'rgba(200,220,242,0)');
      g.addColorStop(0.62,'rgba(208,225,245,'+(a*0.55).toFixed(3)+')');
      g.addColorStop(1,'rgba(218,232,250,'+Math.min(0.5,a*1.15).toFixed(3)+')');
      ctx.strokeStyle=g;ctx.lineWidth=d.w;
      ctx.beginPath();ctx.moveTo(tx,ty);ctx.lineTo(d.x,d.y);ctx.stroke();
      ctx.fillStyle='rgba(224,238,252,'+Math.min(0.45,a*0.9).toFixed(3)+')';
      ctx.beginPath();ctx.arc(d.x,d.y,d.w*0.55,0,6.2832);ctx.fill();
    }
  }
  function startRain(){if(!rainFrame&&!document.hidden){last=0;rainFrame=requestAnimationFrame(loop)}}
  function stopRain(){if(rainFrame){cancelAnimationFrame(rainFrame);rainFrame=0}}
  addEventListener('resize',size);
  document.addEventListener('visibilitychange',function(){if(document.hidden)stopRain();else startRain()});
  size();
  startRain();
})();

/* NAV */
let currentPage='home';
function navTo(page){
  /* 离开当前打开的 App（如 Cinema）：关闭并 100% 清理 overlay/video，避免残留覆盖宿主页面 */
  try{if(typeof window.IBApps==='object'&&IBApps&&typeof IBApps.closeIfOpen==='function')IBApps.closeIfOpen()}catch(e){}
  /* Warn if leaving unsaved editor */
  var editView=document.getElementById('blog-edit-view');
  if(editView&&editView.style.display!=='none'&&editorDirty){
    if(!confirm('日志还没有保存，现在离开会丢失已编辑的内容。确定要离开吗？'))return;
    editorDirty=false;
  }
  if(typeof window.ibBridgeClose==='function'&&!window.ibBridgeClose(false))return;
  currentPage=page;
  _annoHideAll();_annoPostId='';
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  document.querySelectorAll('.nav-links a').forEach(a=>{
    const active=a.dataset.page===page;
    a.classList.toggle('active',active);
    if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
  });
  const ov=document.getElementById('page-overlay');
  const bgI=document.getElementById('bg-internal-img'),bgF=document.getElementById('bg-infernal-img');
  if(page!=='home'){
    ov.classList.add('show');bgI.classList.add('bg-blur-active');bgF.classList.add('bg-blur-active');
    document.getElementById('navbar').classList.add('on-subpage');
  }else{
    ov.classList.remove('show');bgI.classList.remove('bg-blur-active');bgF.classList.remove('bg-blur-active');
    document.getElementById('navbar').classList.remove('on-subpage');
    /* Re-trigger home text entrance animation for fresh feel */
    const hp=document.getElementById('page-home');
    const htitle=document.getElementById('home-title');
    const hsub=document.getElementById('home-subtitle');
    const hcredit=document.getElementById('home-credit');
    if(hp){
      hp.style.opacity='0';hp.style.transition='none';
      htitle.classList.remove('text-entered');
      hsub.classList.remove('text-entered');
      if(hcredit)hcredit.classList.remove('text-entered');
      void hp.offsetWidth;
      hp.style.transition='opacity 0.8s ease-out';
      setTimeout(()=>{hp.style.opacity='1'},50);
      setTimeout(()=>{htitle.classList.add('text-entered')},300);
      setTimeout(()=>{hsub.classList.add('text-entered')},900);
      setTimeout(()=>{if(hcredit)hcredit.classList.add('text-entered')},1300);
    }
  }
  var gtoc=document.getElementById('guide-toc');if(gtoc){gtoc.classList.toggle('visible',page==='guide');
    /* Close any open TOC sub-menus when leaving guide */
    if(page!=='guide'){document.querySelectorAll('.toc-sub.open').forEach(s=>{s.classList.remove('open');s.previousElementSibling?.classList.remove('open')})}}
  if(page!=='chat'&&_chatArchMode)exitChatArchive(true);/* 离开 Chat 页即退出归档视图，保证迷你面板与其他模块只看到在线状态 */
  if(page==='blog'){backToList();loadPosts();loadCategories();updateBlogStats()}
  if(page==='about')loadAboutDisplay();
  if(page==='api'){loadApiSettingsUI();}
  if(page==='diy'){renderIbToolsList();try{if(typeof IBDIY!=='undefined')IBDIY.mount()}catch(e){}}
  if(page==='letters'){initDemoLetter().then(function(){loadLetters()});populateLetterAiSelect()}
  if(page==='memory'){populateMemApiFilter().then(renderMemories);updateMemDashboard();if(_amArchMode){_amArchMode=false;_amIdx=0;_amExpandPersona=false;_amArchToggleUI()}renderAutoMemShowcase()}
  if(page==='active'){loadActiveMessagePage()}
  if(page==='diary'){loadDiaryPage()}
  if(page==='moments'){loadMomentsPage()}
  if(page==='apps'){if(typeof renderAppStore==='function')renderAppStore()}
  if(page==='favorites'){if(typeof favOpenPage==='function')favOpenPage()}
  if(page==='coread'){if(typeof loadCoreadPage==='function')loadCoreadPage()}
  if(page==='moments-settings'){_momentsRenderSettings();try{if(typeof window._rlRenderSettings==='function')window._rlRenderSettings()}catch(e){}}
  if(page==='chat'){loadFriendsList();renderChatCalendar();closeChatPanel();document.getElementById('fab-dock').style.display='none'}
  else{document.getElementById('fab-dock').style.display='flex'}
  /* Hash 同步：与上面唯一的 navTo 路由协同（同 hash 不触发事件，无循环） */
  if(('#'+page)!==location.hash){try{location.hash=page}catch(e){}}
}
/* Hash ↔ 页面同步：浏览器前进/后退与刷新恢复；仅识别存在 page-* 容器的页名，SVG/邮件等未知锚点忽略 */
window.addEventListener('hashchange',function(){
  var t=String(location.hash||'').replace(/^#/,'');
  if(t&&t!==currentPage&&document.getElementById('page-'+t))navTo(t);
});
(function(){
  function _ibHashRestore(){
    var t=String(location.hash||'').replace(/^#/,'');
    if(t&&currentPage==='home'&&document.getElementById('page-'+t)){try{navTo(t)}catch(e){}}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',_ibHashRestore);
  else setTimeout(_ibHashRestore,0);
})();
(function initNavigationAccessibility(){
  const home=document.getElementById('nav-home');
  if(home){
    home.addEventListener('click',()=>navTo('home'));
    home.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();navTo('home')}});
  }
  document.querySelectorAll('.nav-links a[data-page]:not(#ib-bridge-nav)').forEach(link=>{
    link.addEventListener('click',ev=>{ev.preventDefault();navTo(link.dataset.page)});
  });
  document.querySelectorAll('[onclick]').forEach(el=>{
    if(/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el.tagName))return;
    const role=el.getAttribute('role');
    if(role&&role!=='button')return;
    if(!role)el.setAttribute('role','button');
    if(!el.hasAttribute('tabindex'))el.tabIndex=0;
    el.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();el.click()}});
  });
  const progress=document.getElementById('progress-bar');
  if(progress)progress.addEventListener('keydown',ev=>{
    if(!audioEl.duration)return;
    if(ev.key==='ArrowLeft'||ev.key==='ArrowDown'){ev.preventDefault();audioEl.currentTime=Math.max(0,audioEl.currentTime-5)}
    else if(ev.key==='ArrowRight'||ev.key==='ArrowUp'){ev.preventDefault();audioEl.currentTime=Math.min(audioEl.duration,audioEl.currentTime+5)}
    else if(ev.key==='Home'){ev.preventDefault();audioEl.currentTime=0}
    else if(ev.key==='End'){ev.preventDefault();audioEl.currentTime=audioEl.duration}
  });
})();
function toast(m){let s=document.getElementById('toast-stack');if(!s){s=document.createElement('div');s.id='toast-stack';s.className='toast-stack';document.body.appendChild(s)}while(s.children.length>=4){s.firstChild.remove()}const t=document.createElement('div');t.className='toast';t.textContent=m;s.appendChild(t);setTimeout(()=>t.remove(),2800)}

/* GUIDE TOC sub-menu toggle */
function toggleTocSub(parentEl){
  document.querySelectorAll('.toc-parent.open').forEach(p=>{if(p!==parentEl){p.classList.remove('open');const s=p.nextElementSibling;if(s&&s.classList.contains('toc-sub'))s.classList.remove('open')}});
  parentEl.classList.toggle('open');
  const sub=parentEl.nextElementSibling;
  if(sub&&sub.classList.contains('toc-sub')){sub.classList.toggle('open');
    if(sub.classList.contains('open')){const t=document.getElementById('guide-modules');if(t)t.scrollIntoView({behavior:'smooth',block:'start'})}
  }
}

/* BLOG */
let activeCat='all';
let diaryMode=false; /* true = 当前处于密码日记本视图 */
let blogSearchQuery='';/* Blog/日记本 列表搜索词（小写） */
function blogSearchInput(v){blogSearchQuery=v.trim().toLowerCase();loadPosts()}
let lockedDiaryUnlocked=false;
const LOCKED_DIARY_DEFAULT_PWD='260323';
const LEGACY_DIARY_CAT='🔒 密码日记本';
/* 新数据模型：私密日记用 post.locked===true 标记，分组(category)与公开 Blog 完全独立。
   兼容旧数据：category 为旧的"🔒 密码日记本"的文章同样视为私密。 */
function isLockedPost(p){return !!(p&&(p.locked===true||p.category===LEGACY_DIARY_CAT))}
/* 一次性迁移：把旧格式(以分类标记)的私密文章转换为 locked 标记，分组清空(在日记本内显示为未分类) */
async function migrateLockedPosts(){
  try{
    const posts=await dbGetAll('posts');
    for(const p of posts){
      if(p.category===LEGACY_DIARY_CAT){p.locked=true;p.category='';await dbPut('posts',p)}
    }
  }catch(e){}
  try{await dbDelete('categories',LEGACY_DIARY_CAT)}catch(e){}
}
/* 密码日记本独立分类列表（与公开 Blog 的 categories 完全分开存储） */
async function getDiaryCats(){try{const r=await dbGet('apiSettings','diaryCats');return(r&&Array.isArray(r.cats))?r.cats:[]}catch(e){return[]}}
async function saveDiaryCats(cats){await dbPut('apiSettings',{id:'diaryCats',cats:cats})}
function togglePwdDiary(){
  /* 切换视图时清空搜索：公开 Blog 与日记本的搜索互不串扰 */
  blogSearchQuery='';
  const bs=document.getElementById('blog-search');
  if(bs)bs.value='';
  if(diaryMode){
    /* Already inside — go back to Blog */
    diaryMode=false;
    lockedDiaryUnlocked=false;
    filterCat('all');
  }else{
    diaryMode=true;
    activeCat='all';
    filterCat('all');
  }
}
function updatePwdDiaryBtn(){
  const btn=document.getElementById('pwd-diary-btn');
  if(btn) btn.textContent=diaryMode?'返回Blog':'密码日记本';
  /* 模块简介卡切换：解锁进入密码日记本后显示其专属简介 */
  const showDiary=diaryMode&&lockedDiaryUnlocked;
  const bi=document.getElementById('blog-intro'),di=document.getElementById('diary-intro');
  if(bi)bi.style.display=showDiary?'none':'';
  if(di)di.style.display=showDiary?'':'none';
  /* 双翼布局镜像：日记本视图侧栏移至右侧；"修改密码"仅在日记本内显示 */
  const lay=document.getElementById('blog-layout');
  if(lay)lay.classList.toggle('mirror',showDiary);
  const dp=document.getElementById('diary-pwd-btn');
  if(dp)dp.style.display=showDiary?'':'none';
}
function cancelDiaryPrompt(){
  document.getElementById('locked-diary-modal')?.remove();
  diaryMode=false;lockedDiaryUnlocked=false;
  filterCat('all');
}
async function getLockedDiaryConfig(){try{return await dbGet('apiSettings','lockedDiary')||null}catch(e){return null}}
async function saveLockedDiaryConfig(cfg){cfg.id='lockedDiary';await dbPut('apiSettings',cfg)}
async function simpleHash(s){const enc=new TextEncoder().encode(s);const buf=await crypto.subtle.digest('SHA-256',enc);return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('')}
async function promptLockedDiary(){
  const cfg=await getLockedDiaryConfig();
  if(!cfg){/* First time — show setup */
    const modal=document.createElement('div');modal.className='modal-overlay show';modal.id='locked-diary-modal';
    modal.innerHTML='<div class="modal glass-card" style="max-width:380px"><h3>密码日记本</h3><p style="font-size:0.82rem;line-height:1.7;margin-bottom:16px;color:var(--text-primary)">Tea 和 Story 的对话记录将保存在这里。首次使用请设置密码。</p><input type="password" id="ld-pwd" placeholder="设置6位数字密码" maxlength="6" value="260323"><input type="text" id="ld-sq" placeholder="密保问题（必填，如：我的生日是？）"><input type="text" id="ld-sa" placeholder="密保答案（必填）"><p style="font-size:0.72rem;color:var(--text-primary);line-height:1.6;margin-bottom:16px;opacity:0.7">请牢记密码和密保问题。忘记密码可通过密保重置为系统默认密码（260323），若密保也遗忘则只能清除浏览器数据重新开始。</p><div class="modal-actions"><button class="btn" onclick="cancelDiaryPrompt()">取消</button><button class="btn btn-primary" onclick="setupLockedDiary()">确认</button></div></div>';
    document.body.appendChild(modal);
  }else{/* Password entry */
    const modal=document.createElement('div');modal.className='modal-overlay show';modal.id='locked-diary-modal';
    modal.innerHTML='<div class="modal glass-card" style="max-width:340px"><h3>输入密码</h3><p style="font-size:0.78rem;color:var(--text-primary);margin-bottom:14px;opacity:0.85">系统默认密码：260323</p><input type="password" id="ld-pwd-input" placeholder="6位数字密码" maxlength="6"><div class="modal-actions" style="justify-content:space-between"><span onclick="forgotLockedPwd()" style="font-size:0.78rem;color:#5577aa;cursor:pointer;text-decoration:underline;align-self:center">忘记密码?</span><div style="display:flex;gap:10px"><button class="btn" onclick="cancelDiaryPrompt()">取消</button><button class="btn btn-primary" onclick="unlockDiary()">解锁</button></div></div></div>';
    document.body.appendChild(modal);
    setTimeout(()=>document.getElementById('ld-pwd-input')?.focus(),100);
  }
}
async function setupLockedDiary(){
  const pwd=document.getElementById('ld-pwd')?.value||'';
  const sq=document.getElementById('ld-sq')?.value?.trim()||'';
  const sa=document.getElementById('ld-sa')?.value?.trim()||'';
  if(!/^\d{6}$/.test(pwd)){toast('密码必须为6位数字');return}
  if(!sq||!sa){toast('请填写密保问题和答案');return}
  const hash=await simpleHash(pwd);
  await saveLockedDiaryConfig({pwdHash:hash,secQ:sq,secAHash:await simpleHash(sa.toLowerCase())});
  document.getElementById('locked-diary-modal')?.remove();
  diaryMode=true;
  lockedDiaryUnlocked=true;
  filterCat('all');
  toast('密码日记本已设置');
}
async function unlockDiary(){
  const pwd=document.getElementById('ld-pwd-input')?.value||'';
  if(!/^\d{6}$/.test(pwd)){toast('请输入6位数字密码');return}
  const cfg=await getLockedDiaryConfig();
  if(!cfg){toast('配置异常');return}
  const hash=await simpleHash(pwd);
  if(hash===cfg.pwdHash){
    document.getElementById('locked-diary-modal')?.remove();
    diaryMode=true;
    lockedDiaryUnlocked=true;
    filterCat('all');
    toast('已解锁');
  }else{toast('密码错误')}
}
async function forgotLockedPwd(){
  const cfg=await getLockedDiaryConfig();
  if(!cfg||!cfg.secQ){toast('未设置密保');return}
  const ans=prompt('密保问题：'+cfg.secQ+'\n\n请输入答案：');
  if(!ans)return;
  const hash=await simpleHash(ans.trim().toLowerCase());
  if(hash===cfg.secAHash){
    const newHash=await simpleHash(LOCKED_DIARY_DEFAULT_PWD);
    cfg.pwdHash=newHash;
    await saveLockedDiaryConfig(cfg);
    toast('密码已重置为系统默认密码 '+LOCKED_DIARY_DEFAULT_PWD);
  }else{toast('密保答案错误')}
}
function showChangeDiaryPwd(){
  if(!lockedDiaryUnlocked){toast('请先解锁密码日记本');return}
  const modal=document.createElement('div');modal.className='modal-overlay show';modal.id='locked-diary-modal';
  modal.innerHTML='<div class="modal glass-card" style="max-width:380px"><h3>修改密码</h3><p style="font-size:0.82rem;line-height:1.7;margin-bottom:16px;color:var(--text-primary)">修改密码日记本的密码和密保问题。</p><input type="password" id="ld-new-pwd" placeholder="新密码（6位数字）" maxlength="6"><input type="text" id="ld-new-sq" placeholder="新密保问题（必填）"><input type="text" id="ld-new-sa" placeholder="新密保答案（必填）"><div class="modal-actions"><button class="btn" onclick="document.getElementById(\'locked-diary-modal\').remove()">取消</button><button class="btn btn-primary" onclick="confirmChangeDiaryPwd()">确认修改</button></div></div>';
  document.body.appendChild(modal);
}
async function confirmChangeDiaryPwd(){
  const pwd=document.getElementById('ld-new-pwd')?.value||'';
  const sq=document.getElementById('ld-new-sq')?.value?.trim()||'';
  const sa=document.getElementById('ld-new-sa')?.value?.trim()||'';
  if(!/^\d{6}$/.test(pwd)){toast('密码必须为6位数字');return}
  if(!sq||!sa){toast('密保问题和答案都必须填写');return}
  const hash=await simpleHash(pwd);
  await saveLockedDiaryConfig({pwdHash:hash,secQ:sq,secAHash:await simpleHash(sa.toLowerCase())});
  document.getElementById('locked-diary-modal')?.remove();
  toast('密码和密保已修改');
}
async function loadCategories(){
  const bar=document.getElementById('category-bar');
  if(diaryMode){
    /* 密码日记本：渲染独立分类。未解锁时不暴露任何分类名 */
    if(!lockedDiaryUnlocked){bar.innerHTML='';return}
    const cats=await getDiaryCats();
    bar.innerHTML='<span class="cat-tag'+(activeCat==='all'?' active':'')+'" onclick="filterCat(\'all\')">All</span>';
    cats.forEach(name=>{const s=name.replace(/'/g,"\\'").replace(/"/g,'&quot;');bar.innerHTML+='<span class="cat-tag'+(activeCat===name?' active':'')+'" onclick="filterCat(\''+s+'\')">'+esc(name)+'<span class="del-cat" onclick="event.stopPropagation();deleteCat(\''+s+'\')">✕</span></span>'});
    return;
  }
  const cats=await dbGetAll('categories');
  bar.innerHTML='<span class="cat-tag'+(activeCat==='all'?' active':'')+'" onclick="filterCat(\'all\')">All</span>';
  cats.forEach(c=>{if(c.name===LEGACY_DIARY_CAT)return;const s=c.name.replace(/'/g,"\\'").replace(/"/g,'&quot;');bar.innerHTML+='<span class="cat-tag'+(activeCat===c.name?' active':'')+'" onclick="filterCat(\''+s+'\')">'+esc(c.name)+'<span class="del-cat" onclick="event.stopPropagation();deleteCat(\''+s+'\')">✕</span></span>'})
}
function filterCat(c){activeCat=c;loadCategories();loadPosts();updatePwdDiaryBtn();updateBlogStats()}
function openCatModal(){document.getElementById('cat-modal').classList.add('show');document.getElementById('cat-input').value='';document.getElementById('cat-input').focus()}
function closeCatModal(){document.getElementById('cat-modal').classList.remove('show')}
async function addCategory(){
  const n=document.getElementById('cat-input').value.trim();if(!n)return;
  if(diaryMode){
    if(!lockedDiaryUnlocked){toast('请先解锁密码日记本');return}
    const cats=await getDiaryCats();
    if(cats.includes(n)){closeCatModal();toast('分类已存在');return}
    cats.push(n);await saveDiaryCats(cats);
    closeCatModal();loadCategories();toast('分类已创建');return;
  }
  await dbPut('categories',{name:n});closeCatModal();loadCategories();toast('分类已创建')
}
async function deleteCat(n){
  if(!confirm('删除分类「'+n+'」？分类下的日志不会被删除。'))return;
  if(diaryMode){
    const cats=await getDiaryCats();
    await saveDiaryCats(cats.filter(c=>c!==n));
    if(activeCat===n)activeCat='all';
    loadCategories();loadPosts();toast('分类已删除');return;
  }
  await dbDelete('categories',n);if(activeCat===n)activeCat='all';loadCategories();loadPosts();toast('分类已删除')
}

async function loadPosts(){let posts=await dbGetAll('posts');posts.sort((a,b)=>b.created-a.created);/* 公开 Blog 与密码日记本完全隔离 */if(diaryMode){if(!lockedDiaryUnlocked){promptLockedDiary();return}posts=posts.filter(p=>isLockedPost(p));if(activeCat!=='all')posts=posts.filter(p=>(p.category||'')===activeCat)}else{posts=posts.filter(p=>!isLockedPost(p));if(activeCat!=='all')posts=posts.filter(p=>p.category===activeCat)}/* 列表搜索：匹配标题/副标题/分类/正文 */if(blogSearchQuery){const q=blogSearchQuery;posts=posts.filter(p=>((p.title||'')+' '+(p.subtitle||'')+' '+(p.category||'')+' '+(p.content||'')).toLowerCase().includes(q))}const c=document.getElementById('posts-container');if(!posts.length){c.innerHTML='<div class="empty-state"><span>✎</span>'+(blogSearchQuery?'没有找到匹配的日志':(diaryMode?'密码日记本中暂无记录。点击"写日志"开始记录，Tea 和 Story 的存档也会自动保存至此。':'还没有日志，点击"写日志"开始记录'))+'</div>';return}c.innerHTML=posts.map(p=>'<div class="post-card glass-card" onclick="viewPost(\''+p.id+'\')"><div class="post-card-title">'+esc(p.title||'无标题')+'</div>'+(p.subtitle?'<div class="post-card-sub">'+esc(p.subtitle)+'</div>':'')+'<div class="post-card-preview">'+esc(p.content)+'</div><div class="post-card-meta"><span>'+new Date(p.created).toLocaleDateString('zh-CN')+'</span>'+(p.category?'<span>· '+esc(p.category)+'</span>':'')+'<span>· '+estimateSize(p)+' bytes</span></div></div>').join('');_annoEnrichPostCards();if(window.IB&&IB.favorites&&typeof IB.favorites.starCard==='function'){c.querySelectorAll('.post-card').forEach(function(el){var pid=((el.getAttribute('onclick')||'').match(/viewPost\('([^']+)'\)/)||[])[1];if(!pid)return;var tt=(el.querySelector('.post-card-title')||{}).textContent||'';var bb=(el.querySelector('.post-card-preview')||{}).textContent||'';IB.favorites.starCard(el,{type:'blog',sourceId:pid,title:tt,body:bb})})}}
function estimateSize(p){return new Blob([JSON.stringify(p)]).size}
async function updateBlogStats(){const all=await dbGetAll('posts');/* 修复：公开页只统计公开日志；密码日记本(已解锁)内只统计私密日志，避免在公开页暴露私密条目的数量与体积 */const inDiary=diaryMode&&lockedDiaryUnlocked;const posts=all.filter(p=>inDiary?isLockedPost(p):!isLockedPost(p));let t=0;posts.forEach(p=>t+=estimateSize(p));document.getElementById('blog-stats').textContent=posts.length+' 篇日志 · '+(t/1024).toFixed(1)+' KB'}

let editingPostId=null;
let editorDirty=false;
async function openEditor(id){
  editingPostId=id||null;editorDirty=false;
  let post={title:'',subtitle:'',content:'',category:''};
  if(id)post=await dbGet('posts',id)||post;
  else if(activeCat!=='all')post.category=activeCat; /* 在某分类视图下新建，默认归入该分类 */
  /* Switch to edit view */
  document.getElementById('blog-list-view').style.display='none';
  document.getElementById('blog-read-view').style.display='none';
  document.getElementById('blog-edit-view').style.display='block';
  document.getElementById('blog-edit-heading').textContent=id?(diaryMode?'Editing Memories...':'Editing...'):(diaryMode?'Writing Memories...':'writing...');
  /* Fill fields */
  document.getElementById('ed-title').value=post.title;
  document.getElementById('ed-subtitle').value=post.subtitle;
  document.getElementById('ed-content').value=post.content;
  /* Populate category dropdown — 密码日记本与公开 Blog 使用各自独立的分类列表 */
  let catNames;
  if(diaryMode){catNames=await getDiaryCats()}
  else{catNames=(await dbGetAll('categories')).map(c=>c.name).filter(n=>n!==LEGACY_DIARY_CAT)}
  if(post.category&&post.category!==LEGACY_DIARY_CAT&&!catNames.includes(post.category))catNames=catNames.concat([post.category]);
  const co=catNames.map(n=>'<option value="'+esc(n)+'"'+(post.category===n?' selected':'')+'>'+esc(n)+'</option>').join('');
  document.getElementById('ed-cat').innerHTML='<option value="">未分类</option>'+co;
  /* Track dirty state */
  ['ed-title','ed-subtitle','ed-content'].forEach(function(elId){
    var el=document.getElementById(elId);if(el){el.oninput=function(){editorDirty=true}}
  });
  var catEl=document.getElementById('ed-cat');if(catEl){catEl.onchange=function(){editorDirty=true}}
  setTimeout(function(){var el=document.getElementById('ed-content');if(el)el.focus()},100);
  /* Rift editor: date + live stats */
  var riftDate=document.getElementById('rift-date');
  if(riftDate){var now=new Date();riftDate.textContent=now.getFullYear()+'.'+String(now.getMonth()+1).padStart(2,'0')+'.'+String(now.getDate()).padStart(2,'0')}
  function updateRiftStats(){var c=document.getElementById('ed-content');if(!c)return;var v=c.value;var ch=document.getElementById('rift-chars');var ln=document.getElementById('rift-lines');var sz=document.getElementById('rift-size');if(ch)ch.textContent=v.length;if(ln)ln.textContent=v?v.split('\n').length:0;if(sz)sz.textContent=(new TextEncoder().encode(v).length/1024).toFixed(1)+' KB'}
  updateRiftStats();
  var edC=document.getElementById('ed-content');if(edC){edC.addEventListener('input',updateRiftStats)}
}
function exitEditor(){
  if(editorDirty){if(!confirm('还没有保存，现在离开会丢失已编辑的内容。确定退出吗？'))return}
  closeEditor();
}
function closeEditor(){editorDirty=false;document.getElementById('blog-edit-view').style.display='none';document.getElementById('blog-list-view').style.display='block';loadPosts();updateBlogStats()}
async function savePost(){var content=document.getElementById('ed-content').value.trim();if(!content){toast('内容不能为空');return}var ex=editingPostId?await dbGet('posts',editingPostId):null;/* 在密码日记本内新建的日志自动标记为私密；编辑时保留原私密状态 */var post={id:editingPostId||'post_'+Date.now(),title:document.getElementById('ed-title').value.trim(),subtitle:document.getElementById('ed-subtitle').value.trim(),category:document.getElementById('ed-cat').value,locked:(ex?isLockedPost(ex):diaryMode),content:content,created:ex?.created||Date.now(),updated:Date.now()};await dbPut('posts',post);editorDirty=false;closeEditor();toast(post.locked?'已存入密码日记本':'日志已保存')}
async function viewPost(id){const p=await dbGet('posts',id);if(!p)return;document.getElementById('blog-list-view').style.display='none';document.getElementById('blog-read-view').style.display='block';document.getElementById('blog-edit-view').style.display='none';const commentSelectOpts=apiConfigs.map(a=>'<option value="'+a.id+'">'+esc(a.nickname||a.model||'AI')+'</option>').join('');const paraHTML=p.content.split(/\n\n+/).map((para,i)=>'<div class="pv-para" data-idx="'+i+'">'+esc(para)+'</div>').join('');document.getElementById('post-view-content').innerHTML='<h2 class="post-view-title">'+esc(p.title||'无标题')+'</h2>'+(p.subtitle?'<p class="post-view-sub">'+esc(p.subtitle)+'</p>':'')+'<div class="post-view-meta">'+new Date(p.created).toLocaleString('zh-CN')+(p.category?' · '+esc(p.category):'')+'</div><div class="post-view-content">'+paraHTML+'</div><div class="post-view-actions"><button class="btn" onclick="openEditor(\''+p.id+'\')">编辑</button><button class="btn" onclick="deletePost(\''+p.id+'\')">删除</button><button class="btn" onclick="exportPost(\''+p.id+'\')">导出</button></div><div class="blog-comments-section"><div class="blog-comments-header">Comments</div><div class="blog-comment-request"><select class="blog-comment-select" id="blog-comment-select-'+p.id+'"><option value="">Choose one...</option>'+commentSelectOpts+'</select><button class="btn btn-primary" id="blog-comment-btn-'+p.id+'" onclick="requestBlogComment(\''+p.id+'\')">写下留言</button><button class="btn btn-primary" id="blog-mem-btn-'+p.id+'" onclick="generateMemoryFromPost(\''+p.id+'\')">生成记忆</button></div><div class="blog-comment-hint">TA将阅读这篇日志，留下感想或帮你生成记忆。</div><div id="blog-comments-'+p.id+'"></div></div>';_annoPostId=id;_renderAnnotationsForPost(id);loadBlogComments(p.id)}
function setReadFontSize(size){
  var rv=document.getElementById('blog-read-view');
  rv.classList.remove('fontsize-s','fontsize-m','fontsize-l');
  rv.classList.add('fontsize-'+size);
  rv.querySelectorAll('.read-fontsize-btn').forEach(function(b){b.classList.remove('active')});
  rv.querySelector('.read-fontsize-btn.fs-'+size).classList.add('active');
}
function backToList(){document.getElementById('blog-list-view').style.display='block';document.getElementById('blog-read-view').style.display='none';document.getElementById('blog-edit-view').style.display='none';_annoHideAll();_annoPostId=''}
async function deletePost(id){if(!confirm('确定删除这篇日志吗？'))return;await dbDelete('posts',id);const allComments=await dbGetAll('blogComments');for(const c of allComments){if(c.postId===id)await dbDelete('blogComments',c.id)}const allAnnos=await dbGetAll('blogAnnotations');for(const a of allAnnos){if(a.postId===id)await dbDelete('blogAnnotations',a.id)}backToList();loadPosts();updateBlogStats();toast('日志已删除')}
async function exportPost(id){const p=await dbGet('posts',id);downloadJSON(p,'post_'+id+'.json');toast('日志已导出')}

/* ABOUT */
const defaultAbout={id:'main',name:'Sui',bio:'',avatar:'',bgImage:'',customText:'',galleryImages:['','',''],nameColor:'theme'};
/* Profile nickname color presets. 'theme' => no override, keep per-theme CSS defaults.
   Each preset gives the nickname (n) full strength and the sub-label (l) a slightly
   softer alpha so the two lines change together but keep their visual hierarchy. */
const PC_NAME_COLOR_PRESETS={
  black:{n:'#1a1a1a',l:'rgba(26,26,26,0.74)'},
  white:{n:'#ffffff',l:'rgba(255,255,255,0.78)'}
};
/* Returns inline style strings {name, label} for a given nameColor key. */
function pcNameColorStyles(key){
  const p=PC_NAME_COLOR_PRESETS[key];
  if(!p)return {name:'',label:''};
  return {name:'color:'+p.n+';',label:'color:'+p.l+';'};
}
var _pendingNameColor='theme';
function selectNameColor(key){
  _pendingNameColor=key;
  document.querySelectorAll('#pc-namecolor-row .pc-cswatch').forEach(function(b){
    b.classList.toggle('active',b.getAttribute('data-k')===key);
  });
  var p=PC_NAME_COLOR_PRESETS[key];
  var nm=document.querySelector('#about-display .pc-avatar-name');
  var lb=document.querySelector('#about-display .pc-avatar-label');
  if(nm)nm.style.color=p?p.n:'';
  if(lb)lb.style.color=p?p.l:'';
}
const PROFILE_BIO_LIMIT=600;
const PROFILE_CUSTOM_LIMIT=500;
var _lastValidBio='',_lastValidCustom='';
async function loadAboutDisplay(){
  let data=await dbGet('about','main');
  if(!data){data=Object.assign({},defaultAbout,{galleryImages:['','','']});await dbPut('about',data)}
  if(!data.galleryImages)data.galleryImages=['','',''];
  const initials=(data.name||'S').charAt(0).toUpperCase();
  const hasBg=!!data.bgImage;
  const avatarHtml=data.avatar
    ?'<img class="pc-avatar-img" src="'+data.avatar+'" alt="avatar">'
    :'<div class="pc-avatar-placeholder">'+initials+'</div>';
  const bgClass=hasBg?'pc-avatar-bg has-img':'pc-avatar-bg frozen';
  const bgStyle=hasBg?'background-image:url('+data.bgImage+')':'';
  const bioText=data.bio||'';
  const customText=data.customText||'';
  const ncS=pcNameColorStyles(data.nameColor||'theme');
  const slots=data.galleryImages.map(function(img,i){
    var label=i===0?'I':i===1?'II':'III';
    if(img)return '<div class="pc-gallery-slot has-img" style="background-image:url('+img+')" onclick="toggleGalleryExpand(this)"><span class="pc-slot-label">'+label+'</span><div class="pc-gallery-del" onclick="event.stopPropagation();deleteGalleryImage('+i+')" title="删除图片">\u00D7</div></div>';
    return '<div class="pc-gallery-slot empty" onclick="triggerGalleryUpload('+i+')"><span class="pc-slot-label">'+label+'</span></div>';
  }).join('');
  document.getElementById('about-display').innerHTML=
    '<div class="profile-card">'
      +'<div class="pc-avatar-col">'
        +'<div class="'+bgClass+'" style="'+bgStyle+'"></div>'
        +avatarHtml
        +'<div class="pc-avatar-name" style="'+ncS.name+'">'+esc(data.name||'Sui')+'</div>'
        +'<div class="pc-avatar-label" style="'+ncS.label+'"></div>'
      +'</div>'
      +'<div class="pc-bio-col">'
        +(bioText
          ?'<div class="pc-bio-text">'+esc(bioText)+'</div>'
          :'<div class="pc-bio-text pc-bio-empty" style="opacity:0.8;font-size:1rem;line-height:1.78;white-space:pre-wrap;flex:1;min-height:0;overflow-y:auto;margin:0 0 6px">点击下方「设置资料」填写昵称、简介、自定义文本等。\n\n你可以在这个页面自定义上传5张图片，作为你的个性化视觉作品集展示。\n\n图片会自适应缩放。\n\n[文本示例]\n\nSometimes, we do not fade until it is too late.\nUntil we have withered, withered, to the bone. And at the end, there is nothing left.\nIt is forgotten. Memories, hopes, and dreams: we are forgotten.\nHow would we be sure if these memories, hopes, and dreams were truly ours? If they were real? Who would forget us if nothing were there to begin with?\nWe fade from the minds of others, but never our own. We live with ourselves until we can not live any longer.\nUntil we forget if there were ever any way we could have lived in peace.\nAnd then, we fade away.\nFade, fade away.\n\nWe do not fade, until it is too late.</div>')
        +(customText
          ?'<div class="pc-custom-wrap"><div class="pc-custom-label">Custom</div><div class="pc-custom-text">'+esc(customText)+'</div></div>'
          :'')
        +'<div class="pc-bio-actions">'
          +'<button class="btn" onclick="openAboutEdit()">设置资料</button>'
          +'<button class="btn" onclick="navTo(\'api\')">设置API密钥</button>'
        +'</div>'
      +'</div>'
      +'<div class="pc-gallery-col">'+slots+'</div>'
    +'</div>';
  document.getElementById('about-editor').style.display='none';
  document.getElementById('about-display').style.display='block';
}
function toggleGalleryExpand(el){
  var slots=el.parentElement.querySelectorAll('.pc-gallery-slot');
  var wasExpanded=el.classList.contains('expanded');
  slots.forEach(function(s){s.classList.remove('expanded')});
  if(!wasExpanded)el.classList.add('expanded');
}
var _pendingProfileUploads={avatar:null,bgImage:null,gallery:[null,null,null]};
function triggerGalleryUpload(idx){
  var inp=document.createElement('input');inp.type='file';inp.accept='image/*';
  inp.onchange=function(e){
    var f=e.target.files[0];if(!f)return;
    var r=new FileReader();r.onload=async function(){
      var data=await dbGet('about','main')||Object.assign({},defaultAbout);
      if(!data.galleryImages)data.galleryImages=['','',''];
      data.galleryImages[idx]=r.result;
      await dbPut('about',data);loadAboutDisplay();toast('图片已保存');
    };r.readAsDataURL(f);
  };inp.click();
}
async function deleteGalleryImage(idx){
  var data=await dbGet('about','main');
  if(!data||!data.galleryImages||!data.galleryImages[idx])return;
  data.galleryImages[idx]='';
  await dbPut('about',data);loadAboutDisplay();toast('图片已删除');
}
async function openAboutEdit(){
  let data=await dbGet('about','main')||Object.assign({},defaultAbout);
  if(!data.galleryImages)data.galleryImages=['','',''];
  _pendingProfileUploads={avatar:null,bgImage:null,gallery:[null,null,null]};
  _pendingNameColor=data.nameColor||'theme';
  _lastValidNickname=data.name||'';
  _lastValidBio=data.bio||'';
  _lastValidCustom=data.customText||'';
  const ncS=pcNameColorStyles(_pendingNameColor);
  const initials=(data.name||'S').charAt(0).toUpperCase();
  const hasBg=!!data.bgImage;
  const avatarHtml=data.avatar
    ?'<img class="pc-avatar-img" src="'+data.avatar+'" alt="avatar">'
    :'<div class="pc-avatar-placeholder">'+initials+'</div>';
  const bgClass=hasBg?'pc-avatar-bg has-img':'pc-avatar-bg frozen';
  const bgStyle=hasBg?'background-image:url('+data.bgImage+')':'';
  const slots=data.galleryImages.map(function(img,i){
    var label=i===0?'I':i===1?'II':'III';
    if(img)return '<div class="pc-gallery-slot has-img" style="background-image:url('+img+')" onclick="toggleGalleryExpand(this)"><span class="pc-slot-label">'+label+'</span><div class="pc-gallery-del" onclick="event.stopPropagation();deleteGalleryImage('+i+')" title="删除图片">\u00D7</div></div>';
    return '<div class="pc-gallery-slot empty" onclick="triggerGalleryUpload('+i+')"><span class="pc-slot-label">'+label+'</span></div>';
  }).join('');
  /* Render card with bio column replaced by edit form */
  document.getElementById('about-display').innerHTML=
    '<div class="profile-card">'
      +'<div class="pc-avatar-col">'
        +'<div class="'+bgClass+'" style="'+bgStyle+'"></div>'
        +avatarHtml
        +'<div class="pc-avatar-name" style="'+ncS.name+'">'+esc(data.name||'Sui')+'</div>'
        +'<div class="pc-avatar-label" style="'+ncS.label+'"></div>'
        +'<div style="position:relative;z-index:2;margin-top:14px;display:flex;flex-direction:column;gap:6px;align-items:center">'
          +'<button class="pc-edit-upload-btn" onclick="document.getElementById(\'pf-avatar-inp\').click()">更换头像</button>'
          +'<button class="pc-edit-upload-btn" onclick="document.getElementById(\'pf-bg-inp\').click()">更换背景</button>'
          +'<input type="file" id="pf-avatar-inp" accept="image/*" style="display:none" onchange="handleProfileUpload(event,\'avatar\')">'
          +'<input type="file" id="pf-bg-inp" accept="image/*" style="display:none" onchange="handleProfileUpload(event,\'bgImage\')">'
        +'</div>'
      +'</div>'
      +'<div class="pc-bio-col" style="overflow-y:auto">'
        +'<label style="font-size:0.78rem;color:var(--silver);margin:0 0 6px;letter-spacing:0.03em">昵称 <span style="font-weight:400;opacity:0.5;font-size:0.7rem">（限12个汉字或24个字符）</span></label>'
        +'<input id="about-name" value="'+esc(data.name||'')+'" maxlength="24" oninput="limitNickname(this)" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--glass-border);background:rgba(155,180,218,0.08);color:var(--text-primary);font-family:\'Noto Sans SC\',sans-serif;font-size:0.9rem;outline:none;box-sizing:border-box;margin-bottom:14px">'
        +'<label style="font-size:0.78rem;color:var(--silver);margin:0 0 6px;letter-spacing:0.03em">昵称颜色</label>'
        +'<div class="pc-namecolor-row" id="pc-namecolor-row">'
          +'<button type="button" class="pc-cswatch'+(_pendingNameColor==='theme'?' active':'')+'" data-k="theme" onclick="selectNameColor(\'theme\')" title="跟随当前主题"><i style="background:linear-gradient(135deg,#152c58 0 50%,#e9eef7 50% 100%)"></i></button>'
          +'<button type="button" class="pc-cswatch'+(_pendingNameColor==='black'?' active':'')+'" data-k="black" onclick="selectNameColor(\'black\')" title="黑色"><i style="background:#1a1a1a"></i></button>'
          +'<button type="button" class="pc-cswatch'+(_pendingNameColor==='white'?' active':'')+'" data-k="white" onclick="selectNameColor(\'white\')" title="白色"><i style="background:#ffffff"></i></button>'
        +'</div>'
        +'<label style="font-size:0.78rem;color:var(--silver);margin:0 0 6px;letter-spacing:0.03em">个人简介 <span style="font-size:0.7rem;color:var(--text-muted);float:right" id="pf-bio-count">'+_weightedLen(data.bio||'')+'/'+PROFILE_BIO_LIMIT+'</span></label>'
        +'<textarea id="about-bio" rows="5" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--glass-border);background:rgba(155,180,218,0.08);color:var(--text-primary);font-family:\'Noto Sans SC\',sans-serif;font-size:0.9rem;outline:none;box-sizing:border-box;resize:none;line-height:1.8;margin-bottom:14px" oninput="limitProfileField(this,'+PROFILE_BIO_LIMIT+',\'_lastValidBio\',\'pf-bio-count\')">'+esc(data.bio||'')+'</textarea>'
        +'<label style="font-size:0.78rem;color:var(--silver);margin:0 0 6px;letter-spacing:0.03em">自定义文本（不发给 API）<span style="font-size:0.7rem;color:var(--text-muted);float:right" id="pf-custom-count">'+_weightedLen(data.customText||'')+'/'+PROFILE_CUSTOM_LIMIT+'</span></label>'
        +'<textarea id="about-custom" rows="3" style="width:100%;padding:10px 14px;border-radius:10px;border:1px solid var(--glass-border);background:rgba(155,180,218,0.08);color:var(--text-primary);font-family:\'Noto Sans SC\',sans-serif;font-size:0.9rem;outline:none;box-sizing:border-box;resize:none;line-height:1.8;margin-bottom:14px" oninput="limitProfileField(this,'+PROFILE_CUSTOM_LIMIT+',\'_lastValidCustom\',\'pf-custom-count\')">'+esc(data.customText||'')+'</textarea>'
        +'<label style="font-size:0.78rem;color:var(--silver);margin:0 0 6px;letter-spacing:0.03em">作品集图片</label>'
        +'<div style="display:flex;gap:8px;margin-bottom:14px">'
          +'<button class="pc-edit-upload-btn" onclick="triggerGalleryEditUpload(0)">图片 I</button>'
          +'<button class="pc-edit-upload-btn" onclick="triggerGalleryEditUpload(1)">图片 II</button>'
          +'<button class="pc-edit-upload-btn" onclick="triggerGalleryEditUpload(2)">图片 III</button>'
        +'</div>'
        +'<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:0.78rem;color:var(--silver);margin:0 0 14px;letter-spacing:0.03em"><input type="checkbox" id="about-show-nav" class="u-native-check"'+(data.showInNav!==false?' checked':'')+'>  在导航栏显示昵称和头像</label>'
        +'<div style="display:flex;gap:10px;margin-top:auto;padding-top:12px">'
          +'<button class="btn btn-primary" onclick="saveAbout()">保存</button>'
          +'<button class="btn" onclick="loadAboutDisplay()">取消</button>'
        +'</div>'
      +'</div>'
      +'<div class="pc-gallery-col">'+slots+'</div>'
    +'</div>';
}
function closeAboutEdit(){loadAboutDisplay()}
function handleProfileUpload(e,field){
  var f=e.target.files[0];if(!f)return;
  var r=new FileReader();r.onload=function(){
    _pendingProfileUploads[field]=r.result;
    toast(field==='avatar'?'头像已选择':'背景已选择');
  };r.readAsDataURL(f);
}
function triggerGalleryEditUpload(idx){
  var inp=document.createElement('input');inp.type='file';inp.accept='image/*';
  inp.onchange=function(e){
    var f=e.target.files[0];if(!f)return;
    var r=new FileReader();r.onload=function(){_pendingProfileUploads.gallery[idx]=r.result;toast('图片 '+(idx+1)+' 已选择')};r.readAsDataURL(f);
  };inp.click();
}
/* Nickname character limit: 12 CJK chars / 24 ASCII chars */
var _lastValidNickname='';
function limitNickname(el){
  var v=el.value,cost=0;
  for(var i=0;i<v.length;i++){cost+=v.charCodeAt(i)>127?2:1}
  if(cost>24){
    /* Revert to last valid value instead of trimming */
    el.value=_lastValidNickname;
  }else{
    _lastValidNickname=v;
  }
}
function _weightedLen(s){var c=0;for(var i=0;i<s.length;i++)c+=s.charCodeAt(i)>127?2:1;return c}
function limitProfileField(el,limit,lastKey,countId){
  var v=el.value,cost=_weightedLen(v);
  if(cost>limit){el.value=window[lastKey];cost=_weightedLen(el.value)}else{window[lastKey]=v}
  var ce=document.getElementById(countId);if(ce)ce.textContent=cost+'/'+limit;
}

async function saveAbout(){
  const old=await dbGet('about','main')||Object.assign({},defaultAbout);
  const name=(document.getElementById('about-name')?.value||'').trim();
  const bio=(document.getElementById('about-bio')?.value||'').slice(0,PROFILE_BIO_LIMIT);
  const customText=(document.getElementById('about-custom')?.value||'').slice(0,PROFILE_CUSTOM_LIMIT);
  const gallery=old.galleryImages||['','',''];
  for(var i=0;i<3;i++){if(_pendingProfileUploads.gallery[i])gallery[i]=_pendingProfileUploads.gallery[i]}
  const data={id:'main',name:name||old.name||'Sui',bio:bio,
    avatar:_pendingProfileUploads.avatar||old.avatar||'',
    bgImage:_pendingProfileUploads.bgImage||old.bgImage||'',
    customText:customText,galleryImages:gallery,
    nameColor:_pendingNameColor||'theme',
    showInNav:!!document.getElementById('about-show-nav')?.checked};
  await dbPut('about',data);
  _pendingProfileUploads={avatar:null,bgImage:null,gallery:[null,null,null]};
  _refreshCachedUserName();loadAboutDisplay();toast('个人资料已保存');
}

/* MUSIC */
let playlist=[],currentTrackIdx=-1,playMode='list',audioCtx,analyser,audioSource,audioEl=new Audio();
function openMusicPanel(){const p=document.getElementById('music-panel');p.style.left='24px';p.style.top='';p.style.right='';p.style.bottom='24px';p.classList.add('show');document.getElementById('music-mini').style.display='none'}
function closeMusicPanel(){const p=document.getElementById('music-panel');p.classList.remove('show');p.style.left='24px';p.style.top='';p.style.right='';p.style.bottom='24px';document.getElementById('music-mini').style.display='flex'}
function addMusicFiles(e){const files=Array.from(e.target.files);files.forEach(f=>{playlist.push({name:f.name.replace(/\.[^.]+$/,''),url:URL.createObjectURL(f)})});renderPlaylist();if(currentTrackIdx===-1&&playlist.length>0)playTrack(0);e.target.value='';toast('已添加 '+files.length+' 首音乐')}
function renderPlaylist(){document.getElementById('playlist').innerHTML=playlist.map((t,i)=>'<div class="playlist-item'+(i===currentTrackIdx?' active':'')+'" onclick="playTrack('+i+')"><span>'+esc(t.name)+'</span><span class="del-track" onclick="event.stopPropagation();removeTrack('+i+')">✕</span></div>').join('')}
function removeTrack(i){if(i===currentTrackIdx){audioEl.pause();currentTrackIdx=-1;document.getElementById('play-btn').innerHTML=svgPlay}else if(i<currentTrackIdx)currentTrackIdx--;URL.revokeObjectURL(playlist[i].url);playlist.splice(i,1);renderPlaylist();updateNowPlaying()}
function playTrack(i){if(i<0||i>=playlist.length)return;currentTrackIdx=i;audioEl.src=playlist[i].url;audioEl.play();initAudioContext();updateNowPlaying();renderPlaylist();document.getElementById('play-btn').innerHTML=svgPause}
function togglePlay(){if(currentTrackIdx===-1)return;if(audioEl.paused){audioEl.play();document.getElementById('play-btn').innerHTML=svgPause}else{audioEl.pause();document.getElementById('play-btn').innerHTML=svgPlay}}
function prevTrack(){if(!playlist.length)return;playTrack(currentTrackIdx<=0?playlist.length-1:currentTrackIdx-1)}
function nextTrack(){if(!playlist.length)return;if(playMode==='random'){playTrack(Math.floor(Math.random()*playlist.length));return}playTrack(currentTrackIdx>=playlist.length-1?0:currentTrackIdx+1)}
audioEl.addEventListener('ended',()=>{if(playMode==='single'){audioEl.currentTime=0;audioEl.play()}else nextTrack()});
audioEl.addEventListener('timeupdate',()=>{if(audioEl.duration){const progress=Math.max(0,Math.min(100,audioEl.currentTime/audioEl.duration*100));document.getElementById('progress-fill').style.width=progress+'%';document.getElementById('progress-bar').setAttribute('aria-valuenow',Math.round(progress))}});
function seekMusic(e){if(!audioEl.duration)return;const r=e.currentTarget.getBoundingClientRect();audioEl.currentTime=((e.clientX-r.left)/r.width)*audioEl.duration}
const svgPlay='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const svgPause='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const modeIcons=['<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>','<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 01-4 4H3"/><text x="12" y="14" text-anchor="middle" font-size="8" fill="currentColor" stroke="none" font-weight="700">1</text></svg>','<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>'],modeNames=['list','single','random'],modeTitles=['列表循环','单曲循环','随机播放'];
function cycleMode(){let i=(modeNames.indexOf(playMode)+1)%modeNames.length;playMode=modeNames[i];const btn=document.getElementById('mode-btn');btn.innerHTML=modeIcons[i];btn.title=modeTitles[i]}
function updateNowPlaying(){const n=currentTrackIdx>=0?playlist[currentTrackIdx].name:'未选择音乐';document.getElementById('now-playing').textContent=n;document.getElementById('mini-title').textContent=currentTrackIdx>=0?n:'未播放'}
function initAudioContext(){if(audioCtx)return;audioCtx=new(window.AudioContext||window.webkitAudioContext)();analyser=audioCtx.createAnalyser();analyser.fftSize=256;audioSource=audioCtx.createMediaElementSource(audioEl);audioSource.connect(analyser);analyser.connect(audioCtx.destination);drawVisualizer()}
let visualizerFrame=0;
function drawVisualizer(){if(visualizerFrame||document.hidden||audioEl.paused)return;const canvas=document.getElementById('visualizer-canvas'),ctx=canvas.getContext('2d'),dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1));canvas.width=canvas.offsetWidth*dpr;canvas.height=canvas.offsetHeight*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);const W=canvas.offsetWidth,H=canvas.offsetHeight;(function draw(){visualizerFrame=0;if(document.hidden||audioEl.paused)return;visualizerFrame=requestAnimationFrame(draw);if(!analyser)return;const data=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(data);ctx.clearRect(0,0,W,H);const bars=48,bw=W/bars;for(let i=0;i<bars;i++){const v=data[Math.floor(i*data.length/bars)]/255,bh=v*H*.85;const g=ctx.createLinearGradient(0,H,0,H-bh);g.addColorStop(0,'rgba(80,128,176,.2)');g.addColorStop(1,'rgba(114,168,216,.6)');ctx.fillStyle=g;ctx.fillRect(i*bw+1,H-bh,bw-2,bh)}})()}
audioEl.addEventListener('play',drawVisualizer);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!audioEl.paused)drawVisualizer()});

/* EXPORT/IMPORT */
async function exportAll(){const data=await _ibBuildRedactedExportData();downloadJSON(data,'InternalBeyond_backup_'+new Date().toISOString().slice(0,10)+'.json');toast('数据已导出（含 ICode 项目文件，不含 API 密钥）')}
function downloadJSON(data,filename){const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>URL.revokeObjectURL(a.href),100)}

/* ══════════ 数据保险系统 ══════════
   浏览器可能在存储压力回收或数据库损坏自愈时清空 IndexedDB（localStorage 为独立子系统，不受影响）。
   四道防护各堵一个环节：
   ① persist()：申请持久化标记，避免存储压力自动回收（对损坏自愈无效，故有②③④）
   ② 空库熔断：启动即检测"整站为空 + 存在历史活跃痕迹"，立刻弹警告并给出镜像回灌/导入备份两条出路
   ③ 每日自动备份：每天首次打开约半分钟后静默导出完整 JSON（含 ICode）到下载文件夹
   ④ 紧急镜像：核心数据节流写入 localStorage，按优先级装箱、聊天记录从最新往回塞满预算；
      带"空库保护"——全站为空时绝不覆盖上一份好镜像 */
var IB_MIRROR_KEY='ib_mirror_v1',IB_MIRROR_META='ib_mirror_meta';
var _ibMirrorDirty=false,_ibMirrorLastTs=0,_ibGuardShown=false;
async function _ibRequestPersist(){
  try{
    if(!(navigator.storage&&navigator.storage.persist))return;
    var p=false;
    try{p=await navigator.storage.persisted()}catch(e){}
    if(!p){try{p=await navigator.storage.persist()}catch(e){}}
    window._ibPersisted=!!p;
    _ibRenderGuardPanel();
  }catch(e){}
}
async function _ibCount(s){try{await ensureDB();var t=db.transaction(s,'readonly');var q=t.objectStore(s).count();return await new Promise(function(r){q.onsuccess=function(){r(q.result||0)};q.onerror=function(){r(0)}})}catch(e){return 0}}
async function _ibVitals(){
  var v={},ks=['chatMessages','posts','letters','memories','apiConfigs','projectFiles'];
  for(var i=0;i<ks.length;i++)v[ks[i]]=await _ibCount(ks[i]);
  v.total=v.chatMessages+v.posts+v.letters+v.memories+v.apiConfigs+v.projectFiles;
  return v;
}
/* —— 导出打包（Export 按钮 / 每日自动备份 / 紧急镜像 共用同一数据源） —— */
async function _ibBuildExportData(){
  async function g(s){try{return await dbGetAll(s)}catch(e){return[]}}
  /* 剔除测试版曾写入的原始流归档字段；保留原版正文、thinking 与其余消息结构。 */
  const cleanChats=(await g('chatMessages')).map(function(m){const c=Object.assign({},m);delete c.upstreamRaw;delete c.thinkingSources;return c});
  return{posts:await g('posts'),categories:await g('categories'),about:await g('about'),apiSettings:(await g('apiSettings')).filter(function(r){return!(r&&r.id==='ib_fsSyncDir')}),apiConfigs:await g('apiConfigs'),chatMessages:cleanChats,letters:await g('letters'),groups:await loadGroups(),blogComments:await g('blogComments'),memories:await g('memories'),chatThreads:await g('chatThreads'),chatSummaries:await g('chatSummaries'),projects:await g('projects'),projectFiles:await g('projectFiles'),uploadedFiles:await g('uploadedFiles'),blogAnnotations:await g('blogAnnotations'),autoMemory:await g('autoMemory'),calEvents:await g('calEvents'),calNotes:await g('calNotes'),calLedger:await g('calLedger'),active_message_settings:await g('active_message_settings'),active_message_history:await g('active_message_history'),active_message_plans:await g('active_message_plans'),diary_entries:await g('diary_entries'),moments:await g('moments'),roleLetters:await g('roleLetters'),activities:await g('activities'),favorites:await g('favorites'),understandings:await g('understandings'),threads:await g('threads'),exportDate:new Date().toISOString(),version:9};
}
/* —— 明文导出脱敏：清除 apiConfigs/apiSettings 中的 apiKey、Authorization 等密钥字段 ——
   作用于 手动导出 / 每日自动备份 / 文件夹同步 / 紧急镜像（均为明文落盘）；
   Vault 加密备份仍走 _ibBuildExportData 原始全量数据，不经本函数。 —— */
function _ibScrubSecrets(o){
  if(Array.isArray(o)){for(var i=0;i<o.length;i++)o[i]=_ibScrubSecrets(o[i]);return o}
  if(o&&typeof o==='object'){
    for(var k in o){
      if(typeof o[k]==='string'&&o[k]&&/api[_-]?key|authorization|^token$|secret|password|bearer/i.test(k))o[k]='';
      else o[k]=_ibScrubSecrets(o[k]);
    }
  }
  return o;
}
async function _ibBuildRedactedExportData(){
  var data=await _ibBuildExportData();
  var copy=JSON.parse(JSON.stringify(data));
  return _ibScrubSecrets(copy);
}
/* —— 每日自动备份 —— */
function _ibAutoBakOn(){try{return localStorage.getItem('ib_autoBak')==='1'}catch(e){return false}}/* 默认关闭：仅当用户在面板中手动开启（存 '1'）时生效 */
function _ibToggleAutoBak(){try{localStorage.setItem('ib_autoBak',_ibAutoBakOn()?'0':'1')}catch(e){}toast('每日自动备份已'+(_ibAutoBakOn()?'开启':'关闭'));_ibRenderGuardPanel()}
async function _ibAutoBackupTick(){
  try{
    if(!_ibAutoBakOn()||_ibGuardShown)return;
    var today=new Date().toISOString().slice(0,10);
    var last='';try{last=localStorage.getItem('ib_autoBakLast')||''}catch(e){}
    if(last===today)return;
    var v=await _ibVitals();
    if(v.total===0)return;/* 空站不备份，也避免熔断场景下载空文件 */
    var data=await _ibBuildRedactedExportData();
    downloadJSON(data,'InternalBeyond_auto_'+today+'.json');
    try{localStorage.setItem('ib_autoBakLast',today)}catch(e){}
    toast('今日数据已自动备份到下载文件夹（不含 API 密钥）');
    _ibRenderGuardPanel();
  }catch(e){}
}
/* —— 紧急镜像：优先级装箱（预算内 localStorage 能装多少装多少） —— */
function _ibMirrorPack(all,budget){
  budget=budget||3500000;
  var out={ts:Date.now(),stores:{},truncated:{}};
  var used=120;
  var pri=['about','apiSettings','apiConfigs','groups','chatThreads','active_message_settings','memories','chatSummaries','letters','categories'];
  for(var i=0;i<pri.length;i++){
    var st=pri[i],arr=all[st]||[];
    if(!arr.length)continue;
    var j=JSON.stringify(arr);
    if(used+j.length>budget){out.truncated[st]=arr.length;continue}
    out.stores[st]=arr;used+=j.length;
  }
  var msgs=(all.chatMessages||[]).map(function(m){var c=Object.assign({},m);delete c.upstreamRaw;delete c.thinkingSources;return c}).sort(function(a,b){return(a.timestamp||0)-(b.timestamp||0)});
  var takeM=[];
  for(var k=msgs.length-1;k>=0;k--){
    var mj=JSON.stringify(msgs[k]);
    if(used+mj.length>budget)break;
    takeM.unshift(msgs[k]);used+=mj.length;
  }
  if(takeM.length)out.stores.chatMessages=takeM;
  if(takeM.length<msgs.length)out.truncated.chatMessages=msgs.length-takeM.length;
  var rest=[['posts','timestamp'],['projects','lastModified'],['projectFiles','lastModified'],['blogComments','timestamp'],['blogAnnotations','timestamp'],['uploadedFiles','timestamp']];
  for(var r0=0;r0<rest.length;r0++){
    var s2=rest[r0][0],f2=rest[r0][1];
    var arr2=(all[s2]||[]).slice().sort(function(a,b){return((a[f2]||a.created||0))-((b[f2]||b.created||0))});
    if(!arr2.length)continue;
    var take2=[];
    for(var q=arr2.length-1;q>=0;q--){var jj=JSON.stringify(arr2[q]);if(used+jj.length>budget)break;take2.unshift(arr2[q]);used+=jj.length}
    if(take2.length)out.stores[s2]=take2;
    if(take2.length<arr2.length)out.truncated[s2]=arr2.length-take2.length;
  }
  return out;
}
async function _ibMirrorNow(force){
  try{
    var now=Date.now();
    if(!force&&now-_ibMirrorLastTs<10*60000)return;
    if(_ibGuardShown)return;/* 熔断状态下绝不动镜像 */
    var v=await _ibVitals();
    var meta=null;try{meta=JSON.parse(localStorage.getItem(IB_MIRROR_META)||'null')}catch(e){}
    if(v.total===0&&meta&&meta.total>0){if(force)toast('站内没有数据，为保护上一份镜像未执行覆盖');return}
    /* 紧急镜像是同源 localStorage 的「恢复副本」，绝不离机；它必须像 IndexedDB 一样
       保留完整凭证（apiKey），否则 IndexedDB 意外清空后从镜像恢复会永久抹掉 API 密钥
       （UI 显示「无密钥」）。红线不变：它不经过 _ibBuildRedactedExportData（那套脱敏
       只用于 exportAll / 每日备份 / 文件夹同步等离机导出）。 */
    var all=await _ibBuildExportData();
    var pack=_ibMirrorPack(all),str=JSON.stringify(pack);
    var ok=false;
    for(var tries=0;tries<4;tries++){
      try{localStorage.setItem(IB_MIRROR_KEY,str);ok=true;break}
      catch(e){pack=_ibMirrorPack(all,Math.max(400000,Math.floor(str.length/2)));str=JSON.stringify(pack)}
    }
    if(!ok)return;
    try{localStorage.setItem(IB_MIRROR_META,JSON.stringify({ts:pack.ts,total:v.total,msgs:(pack.stores.chatMessages||[]).length}))}catch(e){}
    _ibMirrorLastTs=now;_ibMirrorDirty=false;
    if(force)toast('紧急镜像已更新（同源恢复副本，含完整配置与密钥）');
    _ibRenderGuardPanel();
  }catch(e){}
}
async function _ibRestoreMirror(){
  var pack=null;
  try{pack=JSON.parse(localStorage.getItem(IB_MIRROR_KEY)||'null')}catch(e){}
  if(!pack||!pack.stores){toast('没有可用的紧急镜像');return}
  var n=0;
  for(var st in pack.stores){
    var arr=pack.stores[st]||[];
    for(var i=0;i<arr.length;i++){try{await dbPut(st,arr[i]);n++}catch(e){}}
  }
  try{await migrateLockedPosts()}catch(e){}
  var ov=document.getElementById('ib-guard-overlay');if(ov)ov.remove();
  _ibGuardShown=false;
  try{localStorage.removeItem('ib_guardMuted')}catch(e){}
  toast('已从紧急镜像恢复 '+n+' 条记录（镜像时间 '+new Date(pack.ts).toLocaleString('zh-CN')+'）');
  try{await loadApiConfigs();_refreshCachedUserName();loadPosts();loadCategories();updateBlogStats();loadAboutDisplay();navTo(currentPage)}catch(e){}
}
/* —— ⑤ 本地文件夹同步（File System Access API */
var _ibFsHandle=null,_ibFsDirty=false,_ibFsLastTs=0,_ibFsBusy=false,_ibFsErr='';
var _ibFsState='unsupported';/* unsupported | unbound | prompt | granted | error */
function _ibFsSupported(){return typeof window.showDirectoryPicker==='function'}
async function _ibFsWrite(dir,name,text){
  var fh=await dir.getFileHandle(name,{create:true});
  var w=await fh.createWritable();
  await w.write(text);
  await w.close();
}
async function _ibFsSyncNow(force){
  try{
    if(_ibFsBusy||!_ibFsHandle||_ibGuardShown)return;
    var now=Date.now();
    if(!force&&now-_ibFsLastTs<10*60000)return;
    var perm='denied';
    try{perm=await _ibFsHandle.queryPermission({mode:'readwrite'})}catch(e){}
    if(perm!=='granted'){_ibFsState='prompt';_ibFsShowResumePill();_ibRenderGuardPanel();return}
    var v=await _ibVitals();
    var meta=null;try{meta=JSON.parse(localStorage.getItem('ib_fsSyncMeta')||'null')}catch(e){}
    if(v.total===0&&meta&&meta.total>0){if(force===true)toast('站内没有数据，为保护磁盘上的旧备份未执行覆盖');return}
    _ibFsBusy=true;
    var data=await _ibBuildRedactedExportData();
    var str=JSON.stringify(data);
    await _ibFsWrite(_ibFsHandle,'IB_sync_latest.json',str);
    var today=new Date().toISOString().slice(0,10);
    var lastDay='';try{lastDay=localStorage.getItem('ib_fsSyncDay')||''}catch(e){}
    if(lastDay!==today){
      await _ibFsWrite(_ibFsHandle,'IB_backup_'+today+'.json',str);
      try{localStorage.setItem('ib_fsSyncDay',today)}catch(e){}
    }
    _ibFsLastTs=now;_ibFsDirty=false;_ibFsState='granted';_ibFsErr='';
    try{localStorage.setItem('ib_fsSyncMeta',JSON.stringify({ts:now,total:v.total,name:_ibFsHandle.name||''}))}catch(e){}
    if(force===true)toast('已同步到本地文件夹「'+(_ibFsHandle.name||'')+'」（不含 API 密钥）');
    _ibRenderGuardPanel();
  }catch(e){
    _ibFsState='error';_ibFsErr=String(e&&e.message||e);
    if(force===true)toast('本地同步写入失败：'+_ibFsErr);
    _ibRenderGuardPanel();
  }finally{_ibFsBusy=false}
}
async function _ibFsBind(){
  if(!_ibFsSupported()){toast('当前浏览器不支持文件夹同步（需要桌面版 Edge / Chrome）');return}
  try{
    var h=await window.showDirectoryPicker({mode:'readwrite'});
    var p='prompt';
    try{p=await h.queryPermission({mode:'readwrite'})}catch(e){}
    if(p!=='granted'){try{p=await h.requestPermission({mode:'readwrite'})}catch(e){}}
    if(p!=='granted'){toast('未获得文件夹写入权限，未绑定');return}
    _ibFsHandle=h;_ibFsState='granted';_ibFsErr='';
    try{await dbPut('apiSettings',{id:'ib_fsSyncDir',handle:h})}catch(e){}
    toast('已绑定「'+(h.name||'文件夹')+'」，之后每 10 分钟自动写一份完整备份进去');
    _ibFsSyncNow(true);
  }catch(e){/* 用户取消选择：静默返回 */}
  _ibRenderGuardPanel();
}
async function _ibFsUnbind(){
  _ibFsHandle=null;_ibFsState=_ibFsSupported()?'unbound':'unsupported';_ibFsErr='';
  try{await dbDelete('apiSettings','ib_fsSyncDir')}catch(e){}
  try{localStorage.removeItem('ib_fsSyncMeta');localStorage.removeItem('ib_fsSyncDay')}catch(e){}
  toast('已解绑本地同步（磁盘上已写出的备份文件不受影响）');
  _ibRenderGuardPanel();
}
async function _ibFsResume(){/* 必须在用户手势里调用：向浏览器重新请求写入授权 */
  var pill=document.getElementById('ib-fs-resume');if(pill)pill.remove();
  if(!_ibFsHandle)return;
  var p='denied';
  try{p=await _ibFsHandle.requestPermission({mode:'readwrite'})}catch(e){}
  if(p==='granted'){_ibFsState='granted';toast('本地文件夹同步已恢复');_ibFsSyncNow(true)}
  else{_ibFsState='prompt';toast('未获得授权，本地同步保持暂停（可在 API 页随时恢复）')}
  _ibRenderGuardPanel();
}
function _ibFsShowResumePill(){
  if(document.getElementById('ib-fs-resume'))return;
  if(_ibFsState!=='prompt')return;
  var d=document.createElement('div');d.id='ib-fs-resume';
  d.innerHTML='<span>浏览器重启后需重新授权以实现本地文件夹同步。</span>'
    +'<button class="btn" onclick="_ibFsResume()">恢复同步</button>'
    +'<button class="ib-fs-x" title="本次先不恢复" onclick="this.parentNode.remove()">✕</button>';
  document.body.appendChild(d);
}
async function _ibFsInit(){
  if(!_ibFsSupported()){_ibFsState='unsupported';_ibRenderGuardPanel();return}
  _ibFsState='unbound';
  var rec=null;
  try{rec=await dbGet('apiSettings','ib_fsSyncDir')}catch(e){}
  if(rec&&rec.handle&&typeof rec.handle.queryPermission==='function'){
    _ibFsHandle=rec.handle;
    var p='prompt';
    try{p=await _ibFsHandle.queryPermission({mode:'readwrite'})}catch(e){}
    if(p==='granted'){_ibFsState='granted';setTimeout(function(){_ibFsSyncNow(false)},15000)}
    else{_ibFsState='prompt';_ibFsShowResumePill()}
  }
  _ibRenderGuardPanel();
}
/* —— 空库熔断 —— */
async function _ibGuardCheck(){
  try{
    var la=null;try{la=localStorage.getItem('ib_lastActive')}catch(e){}
    if(!la)return;/* 没有历史痕迹 → 真·首次使用 */
    var resetAt=0;try{resetAt=parseInt(localStorage.getItem('ib_resetAt'))||0}catch(e){}
    if(Date.now()-resetAt<15*60000)return;/* 刚主动重置过，属预期内的空 */
    var v=await _ibVitals();
    if(v.total>0){try{localStorage.removeItem('ib_guardMuted')}catch(e){}return}
    var muted='';try{muted=localStorage.getItem('ib_guardMuted')||''}catch(e){}
    if(muted)return;
    _ibShowGuardOverlay();
  }catch(e){}
}
function _ibShowGuardOverlay(){
  if(document.getElementById('ib-guard-overlay'))return;
  _ibGuardShown=true;
  var meta=null;try{meta=JSON.parse(localStorage.getItem(IB_MIRROR_META)||'null')}catch(e){}
  var ov=document.createElement('div');ov.id='ib-guard-overlay';
  var mirrorBtn=(meta&&meta.total>0)?'<button class="btn" style="border-color:rgba(120,190,140,0.5)" onclick="_ibRestoreMirror()">从紧急镜像恢复（'+(meta.msgs||0)+' 条聊天 · '+new Date(meta.ts).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+'）</button>':'';
  ov.innerHTML='<div class="ibg-card">'
    +'<div class="ibg-title">检测到异常：数据库清空</div>'
    +'<div class="ibg-text">这台浏览器留有本站的历史使用痕迹，但整站数据为空。可能刚刚发生了浏览器层面的数据清除（磁盘告急触发的存储回收 / 数据库损坏自愈重建）。建议请先不要写入新内容。</div>'
    +'<div class="ibg-btns">'
    +mirrorBtn
    +'<button class="btn" onclick="document.getElementById(\'importFile\').click()">导入备份文件</button>'
    +'<button class="btn" style="opacity:0.75" onclick="try{localStorage.setItem(\'ib_guardMuted\',\'1\')}catch(e){};this.closest(\'#ib-guard-overlay\').remove();_ibGuardShown=false">无视，关闭此提示</button>'
    +'</div>'
    +'<div class="ibg-note">此警告只在"有历史痕迹但整站为空"时出现；导入或恢复数据后自动解除。</div>'
    +'</div>';
  document.body.appendChild(ov);
}
/* —— API 页「数据保险」面板 —— */
function _ibRenderGuardPanel(){
  try{
    var p1=document.getElementById('ib-persist-state');
    if(p1)p1.textContent=window._ibPersisted===undefined?'检测中…':(window._ibPersisted?'已生效：浏览器不会自动回收本站存储。':'未生效：浏览器保留回收权限。');
    var p2=document.getElementById('ib-autobak-state');
    if(p2){var last='';try{last=localStorage.getItem('ib_autoBakLast')||''}catch(e){}p2.textContent=(_ibAutoBakOn()?'开启':'已关闭')+(last?' · 上次 '+last:' · 尚未执行')}
    var p3=document.getElementById('ib-mirror-state');
    if(p3){var m=null;try{m=JSON.parse(localStorage.getItem(IB_MIRROR_META)||'null')}catch(e){}p3.textContent=m?(new Date(m.ts).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' · 含 '+(m.msgs||0)+' 条聊天'):'尚未生成'}
    var p4=document.getElementById('ib-fs-state'),p4b=document.getElementById('ib-fs-btns');
    if(p4&&p4b){
      var fsm=null;try{fsm=JSON.parse(localStorage.getItem('ib_fsSyncMeta')||'null')}catch(e){}
      var lastTxt=fsm?(' · 上次 '+new Date(fsm.ts).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})):'';
      var bSmall='class="btn btn-compact"';
      if(_ibFsState==='unsupported'){p4.textContent='当前浏览器不支持（需要桌面版 Edge / Chrome）';p4b.innerHTML=''}
      else if(_ibFsState==='unbound'){p4.textContent='未绑定';p4b.innerHTML='<button '+bSmall+' onclick="_ibFsBind()">绑定文件夹</button>'}
      else if(_ibFsState==='prompt'){p4.textContent='已绑定「'+(_ibFsHandle&&_ibFsHandle.name||'')+'」 · 待恢复授权（浏览器重启后需重新点一次）'+lastTxt;p4b.innerHTML='<button '+bSmall+' onclick="_ibFsResume()">恢复同步</button> <button '+bSmall+' onclick="_ibFsUnbind()">解绑</button>'}
      else if(_ibFsState==='error'){p4.textContent='已绑定「'+(_ibFsHandle&&_ibFsHandle.name||'')+'」 · 上次写入失败：'+_ibFsErr;p4b.innerHTML='<button '+bSmall+' onclick="_ibFsSyncNow(true)">重试同步</button> <button '+bSmall+' onclick="_ibFsBind()">重新绑定</button> <button '+bSmall+' onclick="_ibFsUnbind()">解绑</button>'}
      else{p4.textContent='运行中 · 「'+(_ibFsHandle&&_ibFsHandle.name||'')+'」每 10 分钟自动同步'+lastTxt;p4b.innerHTML='<button '+bSmall+' onclick="_ibFsSyncNow(true)">立即同步</button> <button '+bSmall+' onclick="_ibFsUnbind()">解绑</button>'}
    }
  }catch(e){}
}
function _ibGuardInit(){
  _ibRequestPersist();
  _ibFsInit();
  setTimeout(_ibAutoBackupTick,25000);
  setTimeout(function(){_ibMirrorNow(false)},8000);/* 开站先照一张底片 */
  setInterval(function(){_ibAutoBackupTick();if(_ibFsDirty)_ibFsSyncNow(false);if(_ibMirrorDirty)_ibMirrorNow(false);_ibRenderGuardPanel()},60000);
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden'){if(_ibFsDirty&&_ibFsState==='granted')_ibFsSyncNow('hidden');/* 切后台即抢写一份，静默 */if(_ibMirrorDirty)_ibMirrorNow(true)}});
  _ibRenderGuardPanel();
}
async function importAll(e){const file=e.target.files[0];if(!file)return;try{const text=await file.text();const data=JSON.parse(text);if(data.posts)for(const p of data.posts)await dbPut('posts',p);if(data.categories)for(const c of data.categories)await dbPut('categories',c);if(data.about)for(const a of data.about)await dbPut('about',a);if(data.apiSettings)for(const s of data.apiSettings)await dbPut('apiSettings',s);if(data.apiConfigs)for(const s of data.apiConfigs)await _persistApiConfig(s);if(data.chatMessages)for(const m of data.chatMessages)await dbPut('chatMessages',m);if(data.letters)for(const l of data.letters)await dbPut('letters',l);if(data.groups)for(const g of data.groups)await dbPut('groups',g);if(data.blogComments)for(const c of data.blogComments)await dbPut('blogComments',c);if(data.memories)for(const m of data.memories)await dbPut('memories',m);if(data.chatThreads)for(const t of data.chatThreads)await dbPut('chatThreads',t);if(data.chatSummaries)for(const s of data.chatSummaries)await dbPut('chatSummaries',s);if(data.projects)for(const p of data.projects)await dbPut('projects',p);if(data.projectFiles)for(const f of data.projectFiles)await dbPut('projectFiles',f);if(data.uploadedFiles)for(const u of data.uploadedFiles)await dbPut('uploadedFiles',u);if(data.blogAnnotations)for(const a of data.blogAnnotations)await dbPut('blogAnnotations',a);if(data.autoMemory)for(const am of data.autoMemory)await dbPut('autoMemory',am);if(data.calEvents)for(const ce of data.calEvents)await dbPut('calEvents',ce);if(data.calNotes)for(const cn of data.calNotes)await dbPut('calNotes',cn);if(data.calLedger)for(const cl of data.calLedger)await dbPut('calLedger',cl);if(data.active_message_settings)for(const s of data.active_message_settings)await dbPut('active_message_settings',s);if(data.active_message_history)for(const h of data.active_message_history)await dbPut('active_message_history',h);if(data.active_message_plans)for(const p of data.active_message_plans)await dbPut('active_message_plans',p);if(data.diary_entries)for(const e of data.diary_entries)await dbPut('diary_entries',e);if(data.moments)for(const e of data.moments)await dbPut('moments',e);if(data.activities)for(const a of data.activities)await dbPut('activities',a);if(data.favorites)for(const f of data.favorites)await dbPut('favorites',f);if(data.understandings)for(const un of data.understandings)await dbPut('understandings',un);if(data.threads)for(const th of data.threads)await dbPut('threads',th);await migrateLockedPosts();try{localStorage.removeItem('ib_guardMuted')}catch(e2){}var _go=document.getElementById('ib-guard-overlay');if(_go){_go.remove();_ibGuardShown=false}setTimeout(function(){_ibMirrorNow(true)},3000);_ibToolsCache=null;/* 导入可能带来新的外部工具配置，使缓存失效 */await loadApiConfigs();_refreshCachedUserName();_calEarliest=null;/* 同步刷新内存缓存：API 配置、用户名头像、日历最早日期 */if(data.apiConfigs&&typeof ibTtsVoiceCheckImport==='function'){try{const _vci=await ibTtsVoiceCheckImport(data.apiConfigs);if(_vci&&Array.isArray(_vci.missing)&&_vci.missing.length){alert('导入完成；但有 '+_vci.missing.length+' 个 VoiceClone 参考音频文件在本机 Bridge 中不存在（dangling reference）：\n'+_vci.missing.join('、')+'\n\n请打开对应角色的语音设置查看状态。')}}catch(eV){}}toast('数据已导入');navTo(currentPage)}catch(err){toast('导入失败：文件格式错误')}e.target.value=''}
function esc(s){if(!s)return'';const d=document.createElement('div');d.textContent=s;return d.innerHTML}

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.core 登记全部导出 ---- */
function ibCoreLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window.openDB=openDB;
window.ensureDB=ensureDB;
window.dbPut=dbPut;
window.dbGetAll=dbGetAll;
window.dbGet=dbGet;
window.dbDelete=dbDelete;
window.dbGetByIndex=dbGetByIndex;
window.getDefaultPromptForTheme=getDefaultPromptForTheme;
window.clearDefaultPrompt=clearDefaultPrompt;
window.syncDefaultPromptToTheme=syncDefaultPromptToTheme;
window.toggleTheme=toggleTheme;
window.enterSite=enterSite;
window.navTo=navTo;
window.toast=toast;
window.toggleTocSub=toggleTocSub;
window.blogSearchInput=blogSearchInput;
window.isLockedPost=isLockedPost;
window.migrateLockedPosts=migrateLockedPosts;
window.getDiaryCats=getDiaryCats;
window.saveDiaryCats=saveDiaryCats;
window.togglePwdDiary=togglePwdDiary;
window.updatePwdDiaryBtn=updatePwdDiaryBtn;
window.cancelDiaryPrompt=cancelDiaryPrompt;
window.getLockedDiaryConfig=getLockedDiaryConfig;
window.saveLockedDiaryConfig=saveLockedDiaryConfig;
window.simpleHash=simpleHash;
window.promptLockedDiary=promptLockedDiary;
window.setupLockedDiary=setupLockedDiary;
window.unlockDiary=unlockDiary;
window.forgotLockedPwd=forgotLockedPwd;
window.showChangeDiaryPwd=showChangeDiaryPwd;
window.confirmChangeDiaryPwd=confirmChangeDiaryPwd;
window.loadCategories=loadCategories;
window.filterCat=filterCat;
window.openCatModal=openCatModal;
window.closeCatModal=closeCatModal;
window.addCategory=addCategory;
window.deleteCat=deleteCat;
window.loadPosts=loadPosts;
window.estimateSize=estimateSize;
window.updateBlogStats=updateBlogStats;
window.openEditor=openEditor;
window.exitEditor=exitEditor;
window.closeEditor=closeEditor;
window.savePost=savePost;
window.viewPost=viewPost;
window.setReadFontSize=setReadFontSize;
window.backToList=backToList;
window.deletePost=deletePost;
window.exportPost=exportPost;
window.pcNameColorStyles=pcNameColorStyles;
window.selectNameColor=selectNameColor;
window.loadAboutDisplay=loadAboutDisplay;
window.toggleGalleryExpand=toggleGalleryExpand;
window.triggerGalleryUpload=triggerGalleryUpload;
window.deleteGalleryImage=deleteGalleryImage;
window.openAboutEdit=openAboutEdit;
window.closeAboutEdit=closeAboutEdit;
window.handleProfileUpload=handleProfileUpload;
window.triggerGalleryEditUpload=triggerGalleryEditUpload;
window.limitNickname=limitNickname;
window._weightedLen=_weightedLen;
window.limitProfileField=limitProfileField;
window.saveAbout=saveAbout;
window.openMusicPanel=openMusicPanel;
window.closeMusicPanel=closeMusicPanel;
window.addMusicFiles=addMusicFiles;
window.renderPlaylist=renderPlaylist;
window.removeTrack=removeTrack;
window.playTrack=playTrack;
window.togglePlay=togglePlay;
window.prevTrack=prevTrack;
window.nextTrack=nextTrack;
window.seekMusic=seekMusic;
window.cycleMode=cycleMode;
window.updateNowPlaying=updateNowPlaying;
window.initAudioContext=initAudioContext;
window.drawVisualizer=drawVisualizer;
window.exportAll=exportAll;
window.downloadJSON=downloadJSON;
window._ibRequestPersist=_ibRequestPersist;
window._ibCount=_ibCount;
window._ibVitals=_ibVitals;
window._ibBuildExportData=_ibBuildExportData;
window._ibAutoBakOn=_ibAutoBakOn;
window._ibToggleAutoBak=_ibToggleAutoBak;
window._ibAutoBackupTick=_ibAutoBackupTick;
window._ibMirrorPack=_ibMirrorPack;
window._ibMirrorNow=_ibMirrorNow;
window._ibRestoreMirror=_ibRestoreMirror;
window._ibFsSupported=_ibFsSupported;
window._ibFsWrite=_ibFsWrite;
window._ibFsSyncNow=_ibFsSyncNow;
window._ibFsBind=_ibFsBind;
window._ibFsUnbind=_ibFsUnbind;
window._ibFsResume=_ibFsResume;
window._ibFsShowResumePill=_ibFsShowResumePill;
window._ibFsInit=_ibFsInit;
window._ibGuardCheck=_ibGuardCheck;
window._ibShowGuardOverlay=_ibShowGuardOverlay;
window._ibRenderGuardPanel=_ibRenderGuardPanel;
window._ibGuardInit=_ibGuardInit;
window.importAll=importAll;
window.esc=esc;
window.DB_NAME=DB_NAME;
window.DEFAULT_SYSTEM_PROMPT=DEFAULT_SYSTEM_PROMPT;
window.INFERNAL_SYSTEM_PROMPT=INFERNAL_SYSTEM_PROMPT;
window.LOCKED_DIARY_DEFAULT_PWD=LOCKED_DIARY_DEFAULT_PWD;
window.LEGACY_DIARY_CAT=LEGACY_DIARY_CAT;
window.defaultAbout=defaultAbout;
window.PC_NAME_COLOR_PRESETS=PC_NAME_COLOR_PRESETS;
window.PROFILE_BIO_LIMIT=PROFILE_BIO_LIMIT;
window.PROFILE_CUSTOM_LIMIT=PROFILE_CUSTOM_LIMIT;
window.svgPlay=svgPlay;
window.svgPause=svgPause;
window.modeIcons=modeIcons;
window.DB_VER=DB_VER;
ibCoreLive('_dbReadyP', function(){return _dbReadyP}, function(v){_dbReadyP=v});
ibCoreLive('_sysPromptCleared', function(){return _sysPromptCleared}, function(v){_sysPromptCleared=v});
ibCoreLive('currentTheme', function(){return currentTheme}, function(v){currentTheme=v});
ibCoreLive('themeTransitioning', function(){return themeTransitioning}, function(v){themeTransitioning=v});
ibCoreLive('currentPage', function(){return currentPage}, function(v){currentPage=v});
ibCoreLive('activeCat', function(){return activeCat}, function(v){activeCat=v});
ibCoreLive('diaryMode', function(){return diaryMode}, function(v){diaryMode=v});
ibCoreLive('blogSearchQuery', function(){return blogSearchQuery}, function(v){blogSearchQuery=v});
ibCoreLive('lockedDiaryUnlocked', function(){return lockedDiaryUnlocked}, function(v){lockedDiaryUnlocked=v});
ibCoreLive('editingPostId', function(){return editingPostId}, function(v){editingPostId=v});
ibCoreLive('editorDirty', function(){return editorDirty}, function(v){editorDirty=v});
ibCoreLive('_pendingNameColor', function(){return _pendingNameColor}, function(v){_pendingNameColor=v});
ibCoreLive('_lastValidBio', function(){return _lastValidBio}, function(v){_lastValidBio=v});
ibCoreLive('_pendingProfileUploads', function(){return _pendingProfileUploads}, function(v){_pendingProfileUploads=v});
ibCoreLive('_lastValidNickname', function(){return _lastValidNickname}, function(v){_lastValidNickname=v});
ibCoreLive('playlist', function(){return playlist}, function(v){playlist=v});
ibCoreLive('visualizerFrame', function(){return visualizerFrame}, function(v){visualizerFrame=v});
ibCoreLive('IB_MIRROR_KEY', function(){return IB_MIRROR_KEY}, function(v){IB_MIRROR_KEY=v});
ibCoreLive('_ibMirrorDirty', function(){return _ibMirrorDirty}, function(v){_ibMirrorDirty=v});
ibCoreLive('_ibFsHandle', function(){return _ibFsHandle}, function(v){_ibFsHandle=v});
ibCoreLive('_ibFsState', function(){return _ibFsState}, function(v){_ibFsState=v});
ibCoreLive('db', function(){return db}, function(v){db=v});
ibCoreLive('_lastValidCustom', function(){return _lastValidCustom}, function(v){_lastValidCustom=v});
ibCoreLive('currentTrackIdx', function(){return currentTrackIdx}, function(v){currentTrackIdx=v});
ibCoreLive('playMode', function(){return playMode}, function(v){playMode=v});
ibCoreLive('audioCtx', function(){return audioCtx}, function(v){audioCtx=v});
ibCoreLive('analyser', function(){return analyser}, function(v){analyser=v});
ibCoreLive('audioSource', function(){return audioSource}, function(v){audioSource=v});
ibCoreLive('audioEl', function(){return audioEl}, function(v){audioEl=v});
ibCoreLive('IB_MIRROR_META', function(){return IB_MIRROR_META}, function(v){IB_MIRROR_META=v});
ibCoreLive('_ibMirrorLastTs', function(){return _ibMirrorLastTs}, function(v){_ibMirrorLastTs=v});
ibCoreLive('_ibGuardShown', function(){return _ibGuardShown}, function(v){_ibGuardShown=v});
ibCoreLive('_ibFsDirty', function(){return _ibFsDirty}, function(v){_ibFsDirty=v});
ibCoreLive('_ibFsLastTs', function(){return _ibFsLastTs}, function(v){_ibFsLastTs=v});
ibCoreLive('_ibFsBusy', function(){return _ibFsBusy}, function(v){_ibFsBusy=v});
ibCoreLive('_ibFsErr', function(){return _ibFsErr}, function(v){_ibFsErr=v});
NS.expose('core', {
  openDB: openDB,
  ensureDB: ensureDB,
  dbPut: dbPut,
  dbGetAll: dbGetAll,
  dbGet: dbGet,
  dbDelete: dbDelete,
  dbGetByIndex: dbGetByIndex,
  getDefaultPromptForTheme: getDefaultPromptForTheme,
  clearDefaultPrompt: clearDefaultPrompt,
  syncDefaultPromptToTheme: syncDefaultPromptToTheme,
  toggleTheme: toggleTheme,
  enterSite: enterSite,
  navTo: navTo,
  toast: toast,
  toggleTocSub: toggleTocSub,
  blogSearchInput: blogSearchInput,
  isLockedPost: isLockedPost,
  migrateLockedPosts: migrateLockedPosts,
  getDiaryCats: getDiaryCats,
  saveDiaryCats: saveDiaryCats,
  togglePwdDiary: togglePwdDiary,
  updatePwdDiaryBtn: updatePwdDiaryBtn,
  cancelDiaryPrompt: cancelDiaryPrompt,
  getLockedDiaryConfig: getLockedDiaryConfig,
  saveLockedDiaryConfig: saveLockedDiaryConfig,
  simpleHash: simpleHash,
  promptLockedDiary: promptLockedDiary,
  setupLockedDiary: setupLockedDiary,
  unlockDiary: unlockDiary,
  forgotLockedPwd: forgotLockedPwd,
  showChangeDiaryPwd: showChangeDiaryPwd,
  confirmChangeDiaryPwd: confirmChangeDiaryPwd,
  loadCategories: loadCategories,
  filterCat: filterCat,
  openCatModal: openCatModal,
  closeCatModal: closeCatModal,
  addCategory: addCategory,
  deleteCat: deleteCat,
  loadPosts: loadPosts,
  estimateSize: estimateSize,
  updateBlogStats: updateBlogStats,
  openEditor: openEditor,
  exitEditor: exitEditor,
  closeEditor: closeEditor,
  savePost: savePost,
  viewPost: viewPost,
  setReadFontSize: setReadFontSize,
  backToList: backToList,
  deletePost: deletePost,
  exportPost: exportPost,
  pcNameColorStyles: pcNameColorStyles,
  selectNameColor: selectNameColor,
  loadAboutDisplay: loadAboutDisplay,
  toggleGalleryExpand: toggleGalleryExpand,
  triggerGalleryUpload: triggerGalleryUpload,
  deleteGalleryImage: deleteGalleryImage,
  openAboutEdit: openAboutEdit,
  closeAboutEdit: closeAboutEdit,
  handleProfileUpload: handleProfileUpload,
  triggerGalleryEditUpload: triggerGalleryEditUpload,
  limitNickname: limitNickname,
  _weightedLen: _weightedLen,
  limitProfileField: limitProfileField,
  saveAbout: saveAbout,
  openMusicPanel: openMusicPanel,
  closeMusicPanel: closeMusicPanel,
  addMusicFiles: addMusicFiles,
  renderPlaylist: renderPlaylist,
  removeTrack: removeTrack,
  playTrack: playTrack,
  togglePlay: togglePlay,
  prevTrack: prevTrack,
  nextTrack: nextTrack,
  seekMusic: seekMusic,
  cycleMode: cycleMode,
  updateNowPlaying: updateNowPlaying,
  initAudioContext: initAudioContext,
  drawVisualizer: drawVisualizer,
  exportAll: exportAll,
  downloadJSON: downloadJSON,
  _ibRequestPersist: _ibRequestPersist,
  _ibCount: _ibCount,
  _ibVitals: _ibVitals,
  _ibBuildExportData: _ibBuildExportData,
  _ibAutoBakOn: _ibAutoBakOn,
  _ibToggleAutoBak: _ibToggleAutoBak,
  _ibAutoBackupTick: _ibAutoBackupTick,
  _ibMirrorPack: _ibMirrorPack,
  _ibMirrorNow: _ibMirrorNow,
  _ibRestoreMirror: _ibRestoreMirror,
  _ibFsSupported: _ibFsSupported,
  _ibFsWrite: _ibFsWrite,
  _ibFsSyncNow: _ibFsSyncNow,
  _ibFsBind: _ibFsBind,
  _ibFsUnbind: _ibFsUnbind,
  _ibFsResume: _ibFsResume,
  _ibFsShowResumePill: _ibFsShowResumePill,
  _ibFsInit: _ibFsInit,
  _ibGuardCheck: _ibGuardCheck,
  _ibShowGuardOverlay: _ibShowGuardOverlay,
  _ibRenderGuardPanel: _ibRenderGuardPanel,
  _ibGuardInit: _ibGuardInit,
  importAll: importAll,
  esc: esc,
  DB_NAME: DB_NAME,
  DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
  INFERNAL_SYSTEM_PROMPT: INFERNAL_SYSTEM_PROMPT,
  LOCKED_DIARY_DEFAULT_PWD: LOCKED_DIARY_DEFAULT_PWD,
  LEGACY_DIARY_CAT: LEGACY_DIARY_CAT,
  defaultAbout: defaultAbout,
  PC_NAME_COLOR_PRESETS: PC_NAME_COLOR_PRESETS,
  PROFILE_BIO_LIMIT: PROFILE_BIO_LIMIT,
  PROFILE_CUSTOM_LIMIT: PROFILE_CUSTOM_LIMIT,
  svgPlay: svgPlay,
  svgPause: svgPause,
  modeIcons: modeIcons,
  DB_VER: DB_VER,
  _dbReadyP: _dbReadyP,
  _sysPromptCleared: _sysPromptCleared,
  currentTheme: currentTheme,
  themeTransitioning: themeTransitioning,
  currentPage: currentPage,
  activeCat: activeCat,
  diaryMode: diaryMode,
  blogSearchQuery: blogSearchQuery,
  lockedDiaryUnlocked: lockedDiaryUnlocked,
  editingPostId: editingPostId,
  editorDirty: editorDirty,
  _pendingNameColor: _pendingNameColor,
  _lastValidBio: _lastValidBio,
  _pendingProfileUploads: _pendingProfileUploads,
  _lastValidNickname: _lastValidNickname,
  playlist: playlist,
  visualizerFrame: visualizerFrame,
  IB_MIRROR_KEY: IB_MIRROR_KEY,
  _ibMirrorDirty: _ibMirrorDirty,
  _ibFsHandle: _ibFsHandle,
  _ibFsState: _ibFsState,
  db: db,
  _lastValidCustom: _lastValidCustom,
  currentTrackIdx: currentTrackIdx,
  playMode: playMode,
  audioCtx: audioCtx,
  analyser: analyser,
  audioSource: audioSource,
  audioEl: audioEl,
  IB_MIRROR_META: IB_MIRROR_META,
  _ibMirrorLastTs: _ibMirrorLastTs,
  _ibGuardShown: _ibGuardShown,
  _ibFsDirty: _ibFsDirty,
  _ibFsLastTs: _ibFsLastTs,
  _ibFsBusy: _ibFsBusy,
  _ibFsErr: _ibFsErr,
});
})(window.IB || (window.IB = {}));
