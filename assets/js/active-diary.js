/* IB 命名空间迁移：IIFE 私有作用域 + 全量双挂载（window 实时 + IB.active 注册）。 */
(function(NS){
/* ══════════ ACTIVE MESSAGES ══════════ */
const ACTIVE_SETTINGS_STORE='active_message_settings';
const ACTIVE_HISTORY_STORE='active_message_history';
const ACTIVE_COMPANION_URL='http://127.0.0.1:23114';
let _activeTimer=null,_activeTicking=false,_activeCompanionOnline=false,_activeCompanionReady=false,_activeCompanionCheckedAt=0,_activeLastContextSync=0;

async function _activeBackgroundSettings(characterId){
  let rows=[];try{rows=await dbGetAll(ACTIVE_SETTINGS_STORE)}catch(e){return[]}
  return rows.filter(s=>s.background_enabled&&(!characterId||s.character_id===characterId))
}
async function _activeEnsureCompanionForChange(action){
  if(await _activeCheckCompanion(false,true))return true;
  toast((action||'此操作')+'前请先启动本地后台服务并保持页面打开，避免旧计划在下次启动时继续发送');
  return false
}
async function _activePrepareCharacterBackgroundChange(characterId,action){
  const rows=await _activeBackgroundSettings(characterId);if(!rows.length)return true;
  if(!(await _activeEnsureCompanionForChange(action)))return false;
  for(const s of rows){if(!(await _activeDeleteCompanionTask(s.id,true)))return false}
  return true
}
async function _activePrepareAllBackgroundRemoval(action){
  const rows=await _activeBackgroundSettings();if(!rows.length)return true;
  if(!(await _activeEnsureCompanionForChange(action)))return false;
  for(const s of rows){if(!(await _activeDeleteCompanionTask(s.id,true)))return false}
  return true
}
async function _activePrepareSettingBackgroundChange(setting,action){
  if(!setting||!setting.background_enabled)return true;
  if(!(await _activeEnsureCompanionForChange(action)))return false;
  return _activeDeleteCompanionTask(setting.id,true)
}
function _activeQueueHistoryClear(userIds){
  try{const prior=JSON.parse(localStorage.getItem('ib_active_pending_history_clear')||'[]'),all=new Set((Array.isArray(prior)?prior:[]).concat(userIds||[]).map(String));localStorage.setItem('ib_active_pending_history_clear',JSON.stringify([...all]))}catch(e){}
}
async function _activeFlushPendingHistoryClear(extraUserIds){
  let queued=[];try{const raw=JSON.parse(localStorage.getItem('ib_active_pending_history_clear')||'[]');if(Array.isArray(raw))queued=raw}catch(e){}
  const pending=new Set(queued.concat(extraUserIds||[]).map(String));if(!pending.size||!_activeCompanionOnline)return false;
  const failed=[];for(const userId of pending){try{await _activeCompanionRequest('/history?user_id='+encodeURIComponent(userId),{method:'DELETE',timeout:5000})}catch(e){failed.push(userId)}}
  try{if(failed.length)localStorage.setItem('ib_active_pending_history_clear',JSON.stringify(failed));else localStorage.removeItem('ib_active_pending_history_clear')}catch(e){}
  return !failed.length
}

function _activeUserId(){
  try{let id=localStorage.getItem('ib_active_user_id');if(!id){id='local_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);localStorage.setItem('ib_active_user_id',id)}return id}catch(e){return'local_user'}
}
function _activePad(n){return String(n).padStart(2,'0')}
function _activeTimeParts(s){
  const p=String((s.schedule&&s.schedule.time)||'09:00').split(':');
  return{h:Math.max(0,Math.min(23,parseInt(p[0],10)||0)),m:Math.max(0,Math.min(59,parseInt(p[1],10)||0))}
}
function _activeAtTime(base,s){
  const p=_activeTimeParts(s),d=new Date(base);d.setHours(p.h,p.m,0,0);return d
}
function _activeIntervalMs(s){
  const sc=s.schedule||{},v=Math.max(1,parseInt(sc.interval_value,10)||1),u=sc.interval_unit||'hours';
  return v*(u==='days'?86400000:u==='minutes'?60000:3600000)
}
function _activeNextRun(s,fromMs){
  const from=new Date(fromMs==null?Date.now():fromMs),freq=s.frequency||'daily';
  if(freq==='interval'){
    const step=_activeIntervalMs(s);
    if(s.last_sent){let n=Number(s.last_sent)+step;while(n<=from.getTime())n+=step;return n}
    let first=_activeAtTime(from,s).getTime();
    return first>from.getTime()?first:from.getTime()+step
  }
  if(freq==='weekly'){
    const days=(s.schedule&&Array.isArray(s.schedule.days)?s.schedule.days:[]).map(Number);
    const allowed=new Set(days.length?days:[from.getDay()]);
    for(let add=0;add<=7;add++){
      const d=new Date(from);d.setDate(from.getDate()+add);
      const c=_activeAtTime(d,s);
      if(allowed.has(c.getDay())&&c.getTime()>from.getTime()+500)return c.getTime()
    }
  }
  let d=_activeAtTime(from,s);if(d.getTime()<=from.getTime()+500)d.setDate(d.getDate()+1);return d.getTime()
}
function _activeRunId(settingId,scheduledFor){return'active_run_'+String(settingId).replace(/[^\w.-]/g,'_')+'_'+Math.floor(Number(scheduledFor)||0)}
function _activeMessageId(settingId,scheduledFor){return'active_msg_'+String(settingId).replace(/[^\w.-]/g,'_')+'_'+Math.floor(Number(scheduledFor)||0)}
function _activeFrequencyLabel(s){
  if(s.frequency==='weekly'){const names=['日','一','二','三','四','五','六'],days=(s.schedule&&s.schedule.days||[]).map(Number).sort();return'每周 '+days.map(d=>'周'+names[d]).join('、')+' '+((s.schedule&&s.schedule.time)||'09:00')}
  if(s.frequency==='interval'){const sc=s.schedule||{},units={minutes:'分钟',hours:'小时',days:'天'};return'每 '+(sc.interval_value||1)+' '+(units[sc.interval_unit]||'小时')}
  return'每天 '+((s.schedule&&s.schedule.time)||'09:00')
}
function _activeTypeLabel(t){return({greeting:'日常问候',memory:'Memory 话题',time:'时间话题',random:'随机互动'})[t]||'主动消息'}
function _activeFormatWhen(ts){
  if(!ts)return'尚未安排';
  return new Date(ts).toLocaleString('zh-CN',{month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit'})
}
function _activeFrequencyChanged(){
  const f=document.getElementById('active-frequency')?.value||'daily';
  const wr=document.getElementById('active-weekly-row'),ir=document.getElementById('active-interval-row');
  if(wr)wr.style.display=f==='weekly'?'grid':'none';
  if(ir)ir.style.display=f==='interval'?'grid':'none'
}
function _activeIntervalUnitChanged(){
  const input=document.getElementById('active-interval-value'),unit=document.getElementById('active-interval-unit')?.value;
  if(!input)return;input.min=unit==='minutes'?'15':'1';if(Number(input.value)<Number(input.min))input.value=input.min
}
async function _activePopulateCharacters(){
  await loadApiConfigs();
  const sel=document.getElementById('active-character');if(!sel)return;
  const cur=sel.value;sel.innerHTML='';
  apiConfigs.forEach(function(a){const o=document.createElement('option');o.value=a.id;o.textContent=(a.nickname||a.model||'AI')+' · '+(a.model||a.provider||'');sel.appendChild(o)});
  if(cur&&apiConfigs.some(a=>a.id===cur))sel.value=cur;
  if(!apiConfigs.length){const o=document.createElement('option');o.value='';o.textContent='请先在 API 页面添加角色';sel.appendChild(o)}
}
function _activeResetEditor(){
  const id=document.getElementById('active-setting-id');if(id)id.value='';
  const title=document.getElementById('active-editor-title');if(title)title.textContent='新建主动计划';
  const enabled=document.getElementById('active-enabled');if(enabled)enabled.checked=true;
  const bg=document.getElementById('active-background');if(bg)bg.checked=false;
  const adaptive=document.getElementById('active-adaptive');if(adaptive)adaptive.checked=false;
  const fr=document.getElementById('active-frequency');if(fr)fr.value='daily';
  const mt=document.getElementById('active-message-type');if(mt)mt.value='greeting';
  const ci=document.getElementById('active-custom-instruction');if(ci)ci.value='';
  const tm=document.getElementById('active-time');if(tm)tm.value='09:00';
  const iv=document.getElementById('active-interval-value');if(iv)iv.value='24';
  const iu=document.getElementById('active-interval-unit');if(iu)iu.value='hours';
  document.querySelectorAll('#active-weekly-row input[type="checkbox"]').forEach(function(c){c.checked=Number(c.value)===new Date().getDay()});
  _activeFrequencyChanged();_activeIntervalUnitChanged()
}
async function _activeSaveSetting(){
  const characterId=document.getElementById('active-character')?.value||'';
  const cfg=apiConfigs.find(a=>a.id===characterId);
  if(!cfg){toast('请先选择一个有效角色');return}
  if(!_ibApiReady(cfg)){toast('该角色的 API 配置不完整');return}
  const frequency=document.getElementById('active-frequency')?.value||'daily';
  const time=document.getElementById('active-time')?.value||'09:00';
  const days=[...document.querySelectorAll('#active-weekly-row input:checked')].map(c=>Number(c.value));
  if(frequency==='weekly'&&!days.length){toast('请至少选择一个星期日期');return}
  const unit=document.getElementById('active-interval-unit')?.value||'hours';
  let intervalValue=Math.max(unit==='minutes'?15:1,parseInt(document.getElementById('active-interval-value')?.value,10)||1);
  const idEl=document.getElementById('active-setting-id'),editingId=idEl&&idEl.value;
  let old=editingId?await dbGet(ACTIVE_SETTINGS_STORE,editingId):null;
  const now=Date.now(),setting={
    id:(old&&old.id)||('active_'+now.toString(36)+'_'+Math.random().toString(36).slice(2,7)),
    user_id:(old&&old.user_id)||_activeUserId(),
    character_id:characterId,
    enabled:!!document.getElementById('active-enabled')?.checked,
    schedule:{time:time,days:days,interval_value:intervalValue,interval_unit:unit,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'local'},
    frequency:frequency,
    message_type:document.getElementById('active-message-type')?.value||'greeting',
    custom_instruction:String(document.getElementById('active-custom-instruction')?.value||'').trim().slice(0,500),
    background_enabled:!!document.getElementById('active-background')?.checked,
    adaptive_enabled:!!document.getElementById('active-adaptive')?.checked,
    last_sent:(old&&old.last_sent)||null,
    created_at:(old&&old.created_at)||now,
    updated_at:now
  };
  setting.next_run_at=_activeNextRun(setting,now);
  if(old&&old.background_enabled&&!(await _activePrepareSettingBackgroundChange(old,'修改后台主动计划')))return;
  try{
    await dbPut(ACTIVE_SETTINGS_STORE,setting);
    if((setting.background_enabled||(old&&old.background_enabled))&&_activeCompanionOnline)await _activeSyncAllBackground();
    _activeResetEditor();await _activeRenderSettings();await _activeRenderHistory();
    toast(setting.background_enabled&&!_activeCompanionOnline?'计划已保存；启动后台服务后将自动同步':'主动计划已保存')
  }catch(e){console.error(e);toast('计划保存失败：'+(e.message||e))}
}
async function _activeEditSetting(id){
  const s=await dbGet(ACTIVE_SETTINGS_STORE,id);if(!s)return;
  await _activePopulateCharacters();
  document.getElementById('active-setting-id').value=s.id;
  document.getElementById('active-editor-title').textContent='编辑主动计划';
  document.getElementById('active-character').value=s.character_id||'';
  document.getElementById('active-enabled').checked=s.enabled!==false;
  document.getElementById('active-background').checked=!!s.background_enabled;
  document.getElementById('active-adaptive').checked=!!s.adaptive_enabled;
  document.getElementById('active-frequency').value=s.frequency||'daily';
  document.getElementById('active-message-type').value=s.message_type||'greeting';
  document.getElementById('active-custom-instruction').value=s.custom_instruction||s.customInstruction||'';
  document.getElementById('active-time').value=(s.schedule&&s.schedule.time)||'09:00';
  document.getElementById('active-interval-value').value=(s.schedule&&s.schedule.interval_value)||24;
  document.getElementById('active-interval-unit').value=(s.schedule&&s.schedule.interval_unit)||'hours';
  const daySet=new Set((s.schedule&&s.schedule.days||[]).map(Number));
  document.querySelectorAll('#active-weekly-row input[type="checkbox"]').forEach(c=>{c.checked=daySet.has(Number(c.value))});
  _activeFrequencyChanged();_activeIntervalUnitChanged();
  document.getElementById('page-active')?.scrollTo({top:0,behavior:'smooth'})
}
async function _activeDeleteSetting(id){
  if(!confirm('确定删除这个主动消息计划吗？已发送的聊天消息不会被删除。'))return;
  const s=await dbGet(ACTIVE_SETTINGS_STORE,id);if(!s)return;
  if(!(await _activePrepareSettingBackgroundChange(s,'删除后台主动计划')))return;
  await dbDelete(ACTIVE_SETTINGS_STORE,id);
  if(s.background_enabled&&_activeCompanionOnline)await _activeSyncAllBackground();
  if(document.getElementById('active-setting-id')?.value===id)_activeResetEditor();
  await _activeRenderSettings();toast('主动计划已删除')
}
async function _activeToggleSetting(id){
  const s=await dbGet(ACTIVE_SETTINGS_STORE,id);if(!s)return;
  if(!s.enabled&&!apiConfigs.some(a=>a.id===s.character_id&&_ibApiReady(a))){toast('角色已归档、缺失或 API 配置不完整，无法启用该计划');return}
  if(s.enabled&&s.background_enabled&&!(await _activePrepareSettingBackgroundChange(s,'暂停后台主动计划')))return;
  s.enabled=!s.enabled;s.updated_at=Date.now();
  if(s.enabled)s.next_run_at=_activeNextRun(s,Date.now());
  delete s.processing_until;delete s.processing_run_id;
  await dbPut(ACTIVE_SETTINGS_STORE,s);if(s.background_enabled&&_activeCompanionOnline)await _activeSyncAllBackground();
  await _activeRenderSettings()
}
async function _activeInteractionState(characterId){
  let msgs=[];try{msgs=await dbGetByIndex('chatMessages','byFriend',characterId)}catch(e){}
  const userMsgs=msgs.filter(m=>m.role==='user');
  if(!userMsgs.length)return{label:'还没有互动',level:'high'};
  const last=Math.max.apply(null,userMsgs.map(m=>Number(m.timestamp)||0)),hours=(Date.now()-last)/3600000;
  if(hours>=24*7)return{label:'长期未聊天',level:'high'};
  if(hours>=48)return{label:'最近互动较少',level:'mid'};
  return{label:'最近有互动',level:'low'}
}
async function _activeRenderSettings(){
  const box=document.getElementById('active-setting-list');if(!box)return;
  let list=[];try{list=await dbGetAll(ACTIVE_SETTINGS_STORE)}catch(e){}
  list.sort((a,b)=>(a.enabled===b.enabled?((a.next_run_at||Infinity)-(b.next_run_at||Infinity)):(a.enabled?-1:1)));
  const count=document.getElementById('active-plan-count');if(count)count.textContent=list.length+' 个计划 · '+list.filter(s=>s.enabled).length+' 个运行中';
  box.innerHTML='';
  if(!list.length){box.innerHTML='<div class="active-empty">尚未创建主动消息计划。<br>从左侧选择角色与时间即可开始。</div>';return}
  for(const s of list){
    const onlineCfg=apiConfigs.find(a=>a.id===s.character_id),cfg=onlineCfg||archivedConfigs.find(a=>a.id===s.character_id);
    const present=!!onlineCfg,valid=_ibApiReady(onlineCfg),name=cfg?((cfg.nickname||cfg.model||'AI')+(present?'':'（已归档）')):'角色配置已缺失',state=await _activeInteractionState(s.character_id);
    const row=document.createElement('div');row.className='active-setting'+(s.enabled&&valid?'':' off');
    const top=document.createElement('div');top.className='active-setting-top';
    const who=document.createElement('div');who.className='active-setting-who';
    const av=document.createElement('span');av.className='active-avatar';
    if(cfg&&cfg.avatar){const img=document.createElement('img');img.src=cfg.avatar;img.alt='';av.appendChild(img)}else av.textContent=(name||'?').charAt(0);
    const copy=document.createElement('div'),nm=document.createElement('div'),meta=document.createElement('div');
    nm.className='active-setting-name';nm.textContent=name;meta.className='active-setting-meta';meta.textContent=_activeTypeLabel(s.message_type)+' · '+_activeFrequencyLabel(s);
    copy.append(nm,meta);who.append(av,copy);
    const acts=document.createElement('div');acts.className='active-setting-actions';
    const nowBtn=document.createElement('button');nowBtn.className='active-mini-btn';nowBtn.textContent='立即';nowBtn.disabled=!valid;nowBtn.onclick=()=>_activeRunNow(s.id);
    const editBtn=document.createElement('button');editBtn.className='active-mini-btn';editBtn.textContent='编辑';editBtn.onclick=()=>_activeEditSetting(s.id);
    const toggleBtn=document.createElement('button');toggleBtn.className='active-mini-btn';toggleBtn.textContent=s.enabled?'暂停':'启用';toggleBtn.onclick=()=>_activeToggleSetting(s.id);
    const delBtn=document.createElement('button');delBtn.className='active-mini-btn';delBtn.textContent='删除';delBtn.onclick=()=>_activeDeleteSetting(s.id);
    acts.append(nowBtn,editBtn,toggleBtn,delBtn);top.append(who,acts);
    const next=document.createElement('div');next.className='active-next';
    const prop=document.createElement('span');prop.className='active-propensity';prop.innerHTML='<i></i>';prop.appendChild(document.createTextNode(state.label+(s.adaptive_enabled?' · 互动感知':'')));
    const nt=document.createElement('span');nt.textContent=!present?'角色不可用':(!valid?'API 配置不完整':(s.enabled?((s.background_enabled&&!_activeCompanionReady?'等待后台同步 · ':'下次 ')+_activeFormatWhen(s.next_run_at)):'已暂停'));
    next.append(prop,nt);row.append(top,next);box.appendChild(row)
  }
}
async function _activeRenderHistory(){
  const box=document.getElementById('active-history-list');if(!box)return;
  let rows=[];try{rows=await dbGetAll(ACTIVE_HISTORY_STORE)}catch(e){}
  rows=rows.filter(r=>r.status!=='processing').sort((a,b)=>(b.sent_at||b.created_at||0)-(a.sent_at||a.created_at||0)).slice(0,50);
  box.innerHTML='';if(!rows.length){box.innerHTML='<div class="active-empty">还没有主动消息记录。</div>';return}
  rows.forEach(function(h){
    const cfg=apiConfigs.find(a=>a.id===h.character_id)||archivedConfigs.find(a=>a.id===h.character_id);
    const row=document.createElement('div');row.className='active-history-row'+(h.status==='failed'?' failed':'');
    const name=document.createElement('div');name.className='active-history-name';name.textContent=(cfg&&(cfg.nickname||cfg.model))||h.character_name||'AI';
    const content=document.createElement('div');content.className='active-history-content';content.textContent=h.status==='failed'?('发送失败：'+(h.error||'未知错误')):(h.status==='skipped'?('已顺延：'+(h.reason||'最近刚互动过')):(h.content||''));
    const time=document.createElement('div');time.className='active-history-time';time.textContent=new Date(h.sent_at||h.created_at||Date.now()).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    row.append(name,content,time);box.appendChild(row)
  })
}
async function _activeClearHistory(){
  if(!confirm('清除主动消息发送历史？聊天中的消息不会被删除。'))return;
  let settings=[];try{settings=await dbGetAll(ACTIVE_SETTINGS_STORE)}catch(e){}
  const userIds=[...new Set([_activeUserId()].concat(settings.map(s=>s.user_id).filter(Boolean)).map(String))];
  const all=await dbGetAll(ACTIVE_HISTORY_STORE);for(const h of all){if(h.status!=='processing')await dbDelete(ACTIVE_HISTORY_STORE,h.id)}
  if(!_activeCompanionOnline||!(await _activeFlushPendingHistoryClear(userIds)))_activeQueueHistoryClear(userIds);
  await _activeRenderHistory();toast(_activeCompanionOnline?'发送历史已清除':'页面历史已清除；后台记录会在下次连接时同步清理')
}
async function loadActiveMessagePage(){
  await _activePopulateCharacters();
  if(!document.getElementById('active-setting-id')?.value)_activeResetEditor();
  await Promise.all([_activeRenderSettings(),_activeRenderHistory(),_activeRenderAiPrefs(),_activeRenderAiPlans()]);
  _activeCheckCompanion(false)
}

function _activeClaimDue(settingId,now){
  return new Promise((resolve,reject)=>{
    let claimed=null,tx;
    try{tx=db.transaction([ACTIVE_SETTINGS_STORE,ACTIVE_HISTORY_STORE],'readwrite')}catch(e){reject(e);return}
    const ss=tx.objectStore(ACTIVE_SETTINGS_STORE),hs=tx.objectStore(ACTIVE_HISTORY_STORE),q=ss.get(settingId);
    q.onsuccess=function(){
      const s=q.result;if(!s||!s.enabled||!s.next_run_at||Number(s.next_run_at)>now+500)return;
      if(Number(s.processing_until||0)>now)return;
      const scheduledFor=Number(s.next_run_at),runId=_activeRunId(s.id,scheduledFor),hq=hs.get(runId);
      hq.onsuccess=function(){
        const old=hq.result;
        if(old&&old.status==='sent')return;
        if(old&&old.status==='processing'&&Number(s.processing_until||0)>now)return;
        s.processing_until=now+5*60000;s.processing_run_id=runId;
        ss.put(s);
        hs.put(Object.assign({},old||{},{id:runId,setting_id:s.id,user_id:s.user_id,character_id:s.character_id,scheduled_for:scheduledFor,status:'processing',created_at:(old&&old.created_at)||now,attempts:((old&&old.attempts)||0)+1}));
        claimed={setting:s,run_id:runId,scheduled_for:scheduledFor,manual:false}
      };
      hq.onerror=function(){try{tx.abort()}catch(e){}}
    };
    q.onerror=function(){try{tx.abort()}catch(e){}};
    tx.oncomplete=()=>resolve(claimed);tx.onerror=()=>reject(tx.error||new Error('调度锁失败'));tx.onabort=()=>reject(tx.error||new Error('调度锁已中止'))
  })
}
const ACTIVE_PROACTIVE_MAX_ATTEMPTS=3;
const ACTIVE_PROACTIVE_SIMILARITY=0.82;
function _activeProactiveLog(step,detail){
  try{console.info('[ProactiveMessage] '+step,detail||'')}catch(e){}
}
function _activeCustomInstruction(setting){return String((setting&&(setting.custom_instruction!=null?setting.custom_instruction:setting.customInstruction))||'').trim().slice(0,500)}
function _activeModeGuide(mode){return({
  greeting:'从此刻真实情境出发自然开口，不套用“早上好”“在吗”“今天过得怎么样”“记得休息”等固定问候。',
  memory:'从相关长期记忆中选择值得延续的一件事自然提起，不要说自己读取了 Memory。',
  time:'结合当前日期、星期与时段开启此刻才适合的话题，不编造天气、新闻或用户行程。',
  random:'带一点偶发地想起对方的感觉；可以由另一位角色触发联想，但绝不替其他角色发言。'
})[mode]||'自然地发起一段符合当前关系与上下文的交流'}
function _activeElapsedText(lastTimestamp,nowMs){
  const last=Number(lastTimestamp||0),now=Number(nowMs||Date.now());if(!last||last>now)return'没有可用的历史互动时间';
  const minutes=Math.max(1,Math.floor((now-last)/60000));
  if(minutes<60)return minutes+' 分钟';const hours=Math.floor(minutes/60);if(hours<24)return hours+' 小时';
  const days=Math.floor(hours/24);if(days<30)return days+' 天';return Math.floor(days/30)+' 个月'
}
function _activeTextKey(text){return String(text||'').toLowerCase().replace(/<[^>]*>/g,'').replace(/[\s\p{P}\p{S}]+/gu,'')}
function _activeTextSimilarity(a,b){
  const x=_activeTextKey(a),y=_activeTextKey(b);if(!x||!y)return 0;if(x===y)return 1;
  if(x.length<2||y.length<2)return x===y?1:0;
  const grams=s=>{const out=new Set();for(let i=0;i<s.length-1;i++)out.add(s.slice(i,i+2));return out},gx=grams(x),gy=grams(y);
  let overlap=0;gx.forEach(g=>{if(gy.has(g))overlap++});return(2*overlap)/(gx.size+gy.size)
}
function _activeVisibleProactiveReply(content,nativeReasoning){
  const parts=_assistantResponseParts(content,nativeReasoning||'');let text=String(parts.content||'');
  /* 原生 reasoning 字段是主通道；标签清理仅兼容旧模型/中转站。 */
  text=text.replace(/<(?:think|thinking|analysis)\b[^>]*>[\s\S]*?<\/(?:think|thinking|analysis)>/gi,'').replace(/^\s*<\/(?:think|thinking|analysis)>\s*/i,'').trim();
  return text
}
function _activeValidateProactiveReply(content,recentProactive){
  const text=String(content||'').trim();if(!text||!/[\p{L}\p{N}]/u.test(text))return{ok:false,reason:'返回为空或只有标点'};
  if(/<\/?(?:think|thinking|analysis|reasoning)\b/i.test(text)||/^\s*(?:analysis|thinking|reasoning)\s*[:：]/i.test(text))return{ok:false,reason:'返回仍包含思考过程'};
  for(const prior of recentProactive||[]){
    const old=String(prior&&prior.content!=null?prior.content:prior||'');if(!old)continue;
    const sim=_activeTextSimilarity(text,old),a=_activeTextKey(text).slice(0,12),b=_activeTextKey(old).slice(0,12);
    if(sim>=ACTIVE_PROACTIVE_SIMILARITY)return{ok:false,reason:'与最近主动消息相似度过高（'+Math.round(sim*100)+'%）'};
    if(a.length>=8&&a===b)return{ok:false,reason:'与最近主动消息使用了相同开头'}
  }
  return{ok:true,reason:''}
}
function _activeFallbackMessage(character,recentProactive,currentTime){
  const persona=String((character&&character.nickname||'')+' '+(character&&character.systemPrompt||'')).toLowerCase(),hour=new Date(currentTime||Date.now()).getHours(),timeWord=hour<6?'这个安静得过分的时刻':hour<12?'上午这段时间':hour<18?'午后':'今晚';let choices;
  if(/活泼|元气|可爱|开朗|陪伴|音乐|歌/.test(persona))choices=[timeWord+'忽然冒出一个想和你分享的小念头。等你有空时，来告诉我此刻最想听见什么吧。','我刚刚想到你啦——'+timeWord+'有没有哪件小事，让你忍不住想哼两句？'];
  else if(/高傲|研究|理性|冷静|学者|实验/.test(persona))choices=[timeWord+'我想到一个值得观察的问题：最近有什么细节，悄悄改变了你的判断？','我暂时从手边的思绪里分出一点注意力给你。若要记录'+timeWord+'最有价值的一个发现，你会选什么？'];
  else if(/安静|故事|沉默|疏离|温和/.test(persona))choices=[timeWord+'很安静，我便想起了你。若你愿意，可以把今天尚未说完的一小段故事留在这里。','有些话不必急着说完。'+timeWord+'如果你正好想找个人听，我在。'];
  else choices=[timeWord+'我忽然想起了你。等你有空，告诉我最近最值得记住的一件小事吧。','刚才有个念头拐到了你这里。'+timeWord+'你若想聊点什么，我愿意听。'];
  const recent=(recentProactive||[]).map(x=>String(x&&x.content!=null?x.content:x||''));
  const seed=String(character&&character.id||'').split('').reduce((n,c)=>n+c.charCodeAt(0),0)+new Date(currentTime||Date.now()).getMinutes()+recent.length;
  for(let i=0;i<choices.length;i++){const pick=choices[(seed+i)%choices.length];if(!recent.some(x=>_activeTextKey(x)===_activeTextKey(pick)))return pick}
  return choices[seed%choices.length]
}
async function _activeRecentMemories(characterId,contextText){
  let all=[];try{all=await dbGetAll('memories')}catch(e){}
  const keywords=typeof _extractKeywords==='function'?_extractKeywords(contextText||''):[];
  return all.filter(m=>{try{return isMemoryVisibleTo(m,characterId,false,false)}catch(e){return false}})
    .map(m=>({memory:m,relevance:keywords.length&&typeof _calcRelevance==='function'?_calcRelevance(m,keywords):0}))
    .sort((a,b)=>(b.relevance-a.relevance)||((b.memory.updated_at||b.memory.updated||b.memory.created||0)-(a.memory.updated_at||a.memory.updated||a.memory.created||0))).slice(0,8)
    .map(x=>({title:x.memory.title||'',content:String(x.memory.content||'').slice(0,420),summary:String(x.memory.summary||'').slice(0,200),created:x.memory.created||0,relevance:x.relevance||0}))
}
async function _activeRecentMessages(characterId){
  let all=[];try{all=await dbGetByIndex('chatMessages','byFriend',characterId)}catch(e){}
  return all.filter(m=>!m.threadId).sort((a,b)=>(a.timestamp||0)-(b.timestamp||0)).slice(-16)
    .map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'').slice(0,700),timestamp:m.timestamp||0,source:m.source||''}))
}
async function _activeRecentProactiveMessages(characterId){
  let all=[];try{all=await dbGetByIndex('chatMessages','byFriend',characterId)}catch(e){}
  return all.filter(m=>!m.threadId&&m.role==='assistant'&&m.source==='active_message'&&String(m.content||'').trim())
    .sort((a,b)=>(a.timestamp||0)-(b.timestamp||0)).slice(-10).map(m=>({content:String(m.content||'').slice(0,700),timestamp:m.timestamp||0,message_id:m.id||''}))
}
async function loadProactiveMessageContext(cfg,setting,currentTime){
  const recent=await _activeRecentMessages(cfg.id),contextText=recent.slice(-8).map(m=>m.content).join('\n')+'\n'+_activeCustomInstruction(setting);
  const [memories,recentProactive,about,summaryItem]=await Promise.all([
    _activeRecentMemories(cfg.id,contextText),_activeRecentProactiveMessages(cfg.id),dbGet('about','main').catch(()=>null),dbGet('chatSummaries','sum_'+cfg.id).catch(()=>null)
  ]);
  const now=currentTime instanceof Date?currentTime:new Date(currentTime||Date.now()),lastInteractionAt=recent.filter(m=>m.source!=='active_message').reduce((v,m)=>Math.max(v,Number(m.timestamp||0)),0);
  const userName=(about&&about.name)||_cachedUserName||'用户';
  _activeProactiveLog('memories loaded',{taskId:setting.id||'',characterId:cfg.id,count:memories.length});
  return{user:{id:setting.user_id||_activeUserId(),name:userName},character:cfg,recentMessages:recent,memories:memories,currentTime:now,timeSinceLastInteraction:_activeElapsedText(lastInteractionAt,now.getTime()),lastInteractionAt:lastInteractionAt,chatSummary:String(summaryItem&&summaryItem.summary||'').slice(0,1200),recentProactiveMessages:recentProactive,messageMode:setting.message_type||'greeting',customInstruction:_activeCustomInstruction(setting),setting:setting}
}
function buildProactivePrompt(args){
  const character=args.character||{},user=args.user||{},characterName=character.nickname||character.model||'AI',userName=user.name||'用户';
  const memories=(args.memories||[]),recent=(args.recentMessages||[]),proactive=(args.recentProactiveMessages||[]);
  const memoryText=memories.length?memories.map(m=>'- '+(m.title?m.title+'：':'')+(m.content||m.summary)).join('\n'):'（没有可用的相关长期记忆）';
  const chatText=recent.length?recent.map(m=>'- '+(m.role==='user'?userName:characterName)+'：'+m.content).join('\n'):'（还没有最近聊天）';
  const proactiveText=proactive.length?proactive.map((m,i)=>(i+1)+'. '+String(m.content||m)).join('\n'):'（还没有发送过主动消息）';
  const now=args.currentTime instanceof Date?args.currentTime:new Date(args.currentTime||Date.now());
  let system=character.systemPrompt||getDefaultPromptForTheme();
  system+=(system?'\n\n':'')+'你正在扮演角色「'+characterName+'」。以上原始设定定义了你的性格、经历与说话方式，必须完整保持。';
  system+='\n你与'+userName+'的关系：'+(character.relationship||'尚未单独设定，请依据既有对话自然判断')+'。';
  system+='\n这是一条由你自然发起的私聊。不要说明自己是 AI，不要提系统提示词、任务、定时器、主动消息或生成过程；不要输出 analysis、thinking、reasoning、工具、Memory 或 XML 标签；只输出最终正文。';
  const prompt=[
    '【当前日期和时间】',now.toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long',hour:'2-digit',minute:'2-digit'}),
    '', '【距离上次聊天】',args.timeSinceLastInteraction||'未知',
    '', '【最近聊天摘要】',args.chatSummary||'（暂无摘要）',
    '', '【最近聊天内容】',chatText,
    '', '【相关长期记忆】',memoryText,
    '', '【最近已经发送过的主动消息】',proactiveText,
    '', '【本次主动消息目的】',_activeModeGuide(args.messageMode)+(args.planIntent?('\n（本次联系的意图：'+String(args.planIntent).slice(0,200)+'；原由：'+String(args.planReason||'').slice(0,200)+'。不要机械复述意图原文，把它当作话题方向自然展开）'):''),
    '', '【用户附加要求】',args.customInstruction||'（无）'
  ];
  if(args.randomCharacter)prompt.push('','【可选联想角色】',args.randomCharacter.name+'。只能把这当作话题灵感，不能替 TA 发言。');
  if(args.retryInstruction)prompt.push('','【重新生成要求】',args.retryInstruction);
  prompt.push('','请主动向'+userName+'发送一条自然、具体、符合角色原作语气的消息。严格要求：','1. 长度为 1 至 4 个自然段。','2. 不要总以“早上好”“在吗”“今天过得怎么样”等统一问候开头。','3. 根据当前时段、最近聊天与记忆选择这一次独有的内容。','4. 避免与最近主动消息相同的开头、话题、句式、问候或近义复述。','5. 可以延续之前的话题，也可以自然开启新话题。','6. 不要复读最近回复，只输出最终可见正文。','7. 不要提定时器、任务、系统、调度或“系统让我来找你”；不要假装一直在后台观察对方；不要制造紧迫感或施压。');
  return{messages:[{role:'system',content:system},{role:'user',content:prompt.join('\n')}],system:system,prompt:prompt.join('\n')}
}
async function generateProactiveMessage(args){
  const character=args.character||{},recent=args.recentProactiveMessages||[],requestModel=args.requestModel||((cfg,messages,opts)=>callApiChat(cfg,messages,opts));
  let lastError=null,retryInstruction='';
  for(let attempt=1;attempt<=ACTIVE_PROACTIVE_MAX_ATTEMPTS;attempt++){
    const built=buildProactivePrompt(Object.assign({},args,{retryInstruction:retryInstruction})),result={};
    _activeProactiveLog('requesting model',{taskId:args.taskId||'',characterId:character.id||'',provider:character.provider||'custom',model:character.model||'',attempt:attempt});
    try{
      const raw=await requestModel(character,built.messages,{maxTokens:512,timeoutMs:120000,wantThinking:true,result:result,_noWebSearch:true,disableTools:true});
      const content=_activeVisibleProactiveReply(raw,result.reasoning_content||''),check=_activeValidateProactiveReply(content,recent);
      if(check.ok){_activeProactiveLog('generated successfully',{taskId:args.taskId||'',characterId:character.id||'',provider:character.provider||'custom',model:character.model||'',attempt:attempt});return{content:content,reasoning_content:'',generatedByFallback:false,generationAttempts:attempt,provider:character.provider||'custom',model:character.model||'',context:args}}
      lastError=new Error(check.reason);retryInstruction=check.reason+'。请换一个开头、话题和句式，完整重写，不要解释原因。'
    }catch(e){lastError=e;retryInstruction='上一次模型调用失败或没有产生可用正文。请重新生成，只返回最终消息。';console.warn('[ProactiveMessage] model attempt failed',{taskId:args.taskId||'',characterId:character.id||'',provider:character.provider||'custom',model:character.model||'',attempt:attempt,error:String(e&&e.message||e).slice(0,300)})}
    if(attempt<ACTIVE_PROACTIVE_MAX_ATTEMPTS)await new Promise(r=>setTimeout(r,250*attempt))
  }
  const fallback=_activeFallbackMessage(character,recent,args.currentTime);
  console.warn('[ProactiveMessage] using fallback after model attempts failed',{taskId:args.taskId||'',characterId:character.id||'',provider:character.provider||'custom',model:character.model||'',error:String(lastError&&lastError.message||lastError||'unknown').slice(0,300)});
  return{content:fallback,reasoning_content:'',generatedByFallback:true,generationAttempts:ACTIVE_PROACTIVE_MAX_ATTEMPTS,generationError:String(lastError&&lastError.message||lastError||'').slice(0,500),provider:character.provider||'custom',model:character.model||'',context:args}
}
async function _activeBuildPrompt(cfg,setting,currentTime){
  const ctx=await loadProactiveMessageContext(cfg,setting,currentTime),pool=apiConfigs.filter(a=>a.id!==cfg.id),randomCharacter=setting.message_type==='random'&&pool.length?pool[Math.floor(Math.random()*pool.length)]:null;
  const built=buildProactivePrompt(Object.assign({},ctx,{randomCharacter:randomCharacter&&{id:randomCharacter.id,name:randomCharacter.nickname||randomCharacter.model||'另一位角色'}}));
  return Object.assign({},ctx,built,{recent:ctx.recentMessages})
}
async function _activeGenerate(cfg,setting){
  _activeProactiveLog('character loaded',{taskId:setting.id||'',characterId:cfg.id,name:cfg.nickname||cfg.model||'AI'});
  _activeProactiveLog('provider/model selected',{taskId:setting.id||'',characterId:cfg.id,apiConfigId:cfg.id,provider:cfg.provider||'custom',model:cfg.model||''});
  const ctx=await loadProactiveMessageContext(cfg,setting),pool=apiConfigs.filter(a=>a.id!==cfg.id),randomCharacter=setting.message_type==='random'&&pool.length?pool[Math.floor(Math.random()*pool.length)]:null;
  return generateProactiveMessage(Object.assign({},ctx,{taskId:setting.id||'',randomCharacter:randomCharacter&&{id:randomCharacter.id,name:randomCharacter.nickname||randomCharacter.model||'另一位角色'}}))
}
async function _activeStoreMessage(cfg,setting,run,out){
  const msgId=_activeMessageId(setting.id,run.scheduled_for);
  const existing=await dbGet('chatMessages',msgId);if(existing)return existing;
  /* Active messages intentionally persist only the final visible reply. Normal chat keeps its
     existing model-level thinking policy; proactive generation never exposes private reasoning. */
  const msg={id:msgId,role:'assistant',content:out.content,reasoning_content:'',friendId:cfg.id,senderName:cfg.nickname||cfg.model||'AI',timestamp:Date.now(),source:'active_message',activeSettingId:setting.id,scheduledFor:run.scheduled_for,generatedByFallback:!!out.generatedByFallback,metadata:{config_id:cfg.id,apiConfigId:cfg.id,provider:cfg.provider||'custom',model:cfg.provider||'',model_id:cfg.model||'',showThinking:false,source:'active_message',generatedByFallback:!!out.generatedByFallback,generationAttempts:Number(out.generationAttempts||1)}};
  await dbPut('chatMessages',msg);
  if(activeFriendId===cfg.id)appendChatBubble('ai',msg.content,msg.senderName,msg.reasoning_content,msg.id,null,null,null,null,cfg);
  else try{_markUnread(cfg.id)}catch(e){}
  try{if(currentPage==='chat')renderChatCalendar()}catch(e){}
  updateChatStorageInfo();_activeNotify(cfg,msg.content);_activeProactiveLog('message saved',{taskId:setting.id||'',characterId:cfg.id,messageId:msg.id,provider:cfg.provider||'custom',model:cfg.model||'',generatedByFallback:!!out.generatedByFallback});return msg
}
async function _activeFinishRun(run,out,error){
  const now=Date.now(),s=await dbGet(ACTIVE_SETTINGS_STORE,run.setting.id)||run.setting;
  const hist=await dbGet(ACTIVE_HISTORY_STORE,run.run_id)||{id:run.run_id,setting_id:s.id,user_id:s.user_id,character_id:s.character_id,scheduled_for:run.scheduled_for,created_at:now};
  hist.sent_at=now;hist.character_name=run.character_name||'';hist.status=error?'failed':'sent';
  if(error)hist.error=String(error.message||error);else{hist.content=out.content;hist.reasoning_content='';hist.message_id=_activeMessageId(s.id,run.scheduled_for);hist.generatedByFallback=!!out.generatedByFallback;hist.generationAttempts=Number(out.generationAttempts||1);if(out.generationError)hist.generation_error=String(out.generationError).slice(0,500)}
  await dbPut(ACTIVE_HISTORY_STORE,hist);
  if(!run.manual){
    s.last_sent=error?(s.last_sent||null):now;
    s.next_run_at=_activeNextRun(s,now+1000)
  }else if(!error)s.last_sent=now;
  delete s.processing_until;delete s.processing_run_id;s.updated_at=now;
  await dbPut(ACTIVE_SETTINGS_STORE,s);if(s.background_enabled&&_activeCompanionOnline)await _activeSyncAllBackground();
  if(currentPage==='active'){await _activeRenderSettings();await _activeRenderHistory()}
}
async function _activeAdaptiveReason(setting){
  if(!setting.adaptive_enabled)return'';
  let msgs=[];try{msgs=await dbGetByIndex('chatMessages','byFriend',setting.character_id)}catch(e){}
  const users=msgs.filter(m=>m.role==='user'&&!m.threadId).sort((a,b)=>(b.timestamp||0)-(a.timestamp||0));
  if(!users.length)return'';
  const elapsed=Date.now()-Number(users[0].timestamp||0);
  return elapsed>=0&&elapsed<12*3600000?'最近 12 小时内刚互动过，本次计划已顺延':''
}
async function _activeSkipRun(run,reason){
  const now=Date.now(),s=await dbGet(ACTIVE_SETTINGS_STORE,run.setting.id)||run.setting;
  const hist=await dbGet(ACTIVE_HISTORY_STORE,run.run_id)||{id:run.run_id,setting_id:s.id,user_id:s.user_id,character_id:s.character_id,scheduled_for:run.scheduled_for,created_at:now};
  hist.status='skipped';hist.sent_at=now;hist.reason=reason;
  await dbPut(ACTIVE_HISTORY_STORE,hist);
  s.next_run_at=_activeNextRun(s,now+1000);delete s.processing_until;delete s.processing_run_id;s.updated_at=now;
  await dbPut(ACTIVE_SETTINGS_STORE,s);if(s.background_enabled&&_activeCompanionOnline)await _activeSyncAllBackground();
  if(currentPage==='active'){await _activeRenderSettings();await _activeRenderHistory()}
}
async function _activeExecuteRun(run){
  const s=run.setting,cfg=apiConfigs.find(a=>a.id===s.character_id)||archivedConfigs.find(a=>a.id===s.character_id);
  run.character_name=cfg&&(cfg.nickname||cfg.model)||'AI';
  _activeProactiveLog('task triggered',{taskId:s.id||'',characterId:s.character_id||'',scheduledFor:run.scheduled_for,manual:!!run.manual});
  try{
    const recovered=await dbGet('chatMessages',_activeMessageId(s.id,run.scheduled_for));
    if(recovered){await _activeFinishRun(run,{content:recovered.content||'',reasoning_content:'',generatedByFallback:!!(recovered.generatedByFallback||recovered.metadata&&recovered.metadata.generatedByFallback),generationAttempts:Number(recovered.metadata&&recovered.metadata.generationAttempts||1)},null);return}
    if(!run.manual){const adaptiveReason=await _activeAdaptiveReason(s);if(adaptiveReason){await _activeSkipRun(run,adaptiveReason);return}}
    if(!cfg||cfg.archived)throw new Error('角色已归档或不存在');
    if(!_ibApiReady(cfg))throw new Error('角色 API 配置不完整');
    if(_chatSendingFor.has(cfg.id))throw new Error('角色正在回复，已跳过本次主动消息');
    _chatSendingFor.add(cfg.id);
    const out=await _activeGenerate(cfg,s);await _activeStoreMessage(cfg,s,run,out);await _activeFinishRun(run,out,null)
  }catch(e){console.error('[Active Messages]',e);await _activeFinishRun(run,null,e);if(run.manual)toast('主动消息发送失败：'+(e.message||e))}
  finally{if(cfg)_chatSendingFor.delete(cfg.id)}
}
async function _activeRunNow(id){
  const s=await dbGet(ACTIVE_SETTINGS_STORE,id);if(!s)return;
  if(_chatSendingFor.has(s.character_id)){toast('该角色正在回复，请稍后再试');return}
  const scheduled=Date.now(),runId=_activeRunId(s.id,scheduled);
  await dbPut(ACTIVE_HISTORY_STORE,{id:runId,setting_id:s.id,user_id:s.user_id,character_id:s.character_id,scheduled_for:scheduled,status:'processing',created_at:scheduled,attempts:1,manual:true});
  toast('正在生成主动消息…');await _activeExecuteRun({setting:s,run_id:runId,scheduled_for:scheduled,manual:true})
}
async function _activeTick(){
  if(_activeTicking||!db)return;_activeTicking=true;
  try{
    await _activeCheckCompanion(false);
    if(_activeCompanionOnline)await _activePullCompanionEvents();
    const settings=await dbGetAll(ACTIVE_SETTINGS_STORE),now=Date.now();
    for(const s of settings){
      if(!s.enabled||!s.next_run_at||Number(s.next_run_at)>now+500)continue;
      if(!apiConfigs.some(a=>a.id===s.character_id&&_ibApiReady(a)))continue;
      /* 后台计划由 companion 独占执行；离线时保留到期槽，服务恢复后补发，避免浏览器与后台双重调用。 */
      if(s.background_enabled)continue;
      if(_chatSendingFor.has(s.character_id))continue;
      const run=await _activeClaimDue(s.id,now);if(run)await _activeExecuteRun(run)
    }
    if(_activeCompanionOnline&&now-_activeLastContextSync>5*60000)await _activeSyncAllBackground()
    await _activeTickAiPlans();/* AI 自主规划：到期评估与发送（fail-open） */
    await _diaryTick();/* 日记：每周周记 + 每日规划（fail-open） */
    await _momentsTick();/* 朋友圈：角色自主发布调度（fail-open） */
    try{if(typeof window._roleLettersTick==='function')await window._roleLettersTick()}catch(e){console.warn('[RoleLetters] tick '+String(e&&e.message||e).slice(0,120))}/* 角色互相写信（fail-open） */
  }catch(e){console.warn('[Active Messages] scheduler tick failed',e)}
  finally{_activeTicking=false}
}
function _activeNotify(cfg,content){
  try{if(!('Notification'in window)||Notification.permission!=='granted')return;if(document.visibilityState==='visible'&&activeFriendId===cfg.id)return;new Notification(cfg.nickname||cfg.model||'Internal Beyond',{body:String(content||'').slice(0,180),icon:cfg.avatar||'IB-icon.ico',tag:'ib-active-'+cfg.id})}catch(e){}
}
async function _activeRequestNotification(){
  if(!('Notification'in window)){toast('当前浏览器不支持系统通知');return}
  try{const p=await Notification.requestPermission();toast(p==='granted'?'主动消息通知已允许':'未获得通知权限')}catch(e){toast('通知权限请求失败')}
}
async function _activeCompanionRequest(path,opts){
  opts=opts||{};const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),opts.timeout||2500);
  try{
    const headers=Object.assign({'Content-Type':'application/json'},opts.headers||{});
    const res=await fetch(ACTIVE_COMPANION_URL+path,{method:opts.method||'GET',headers:headers,body:opts.body==null?undefined:JSON.stringify(opts.body),signal:ac.signal,cache:'no-store'});
    if(!res.ok)throw new Error('后台服务 '+res.status);const text=await res.text();return text?JSON.parse(text):{}
  }finally{clearTimeout(tm)}
}
function _activeSetServiceStatus(online){
  const changed=_activeCompanionOnline!==!!online;_activeCompanionOnline=!!online;if(!online)_activeCompanionReady=false;const el=document.getElementById('active-service-status');if(!el)return;
  el.classList.toggle('online',!!online);el.textContent=online?(_activeCompanionReady?'已连接 · 已同步':'已连接 · 待同步'):'未连接'
  if(changed&&currentPage==='active')setTimeout(_activeRenderSettings,0)
}
async function _activeCheckCompanion(showToast,force){
  if(Date.now()-_activeCompanionCheckedAt<15000&&!showToast&&!force)return _activeCompanionOnline;
  _activeCompanionCheckedAt=Date.now();
  try{await _activeCompanionRequest('/health',{timeout:1800});_activeSetServiceStatus(true);if(showToast){const synced=await _activeSyncAllBackground();toast(synced?'后台服务连接正常，计划已同步':'后台服务已连接，但计划同步未完成，请重试')}return true}
  catch(e){_activeSetServiceStatus(false);if(showToast)toast('未检测到后台服务，请先运行 start-active-service.cmd');return false}
}
async function _activeBuildSnapshot(setting){
  const cfg=apiConfigs.find(a=>a.id===setting.character_id);if(!cfg)throw new Error('角色配置不存在');
  const ctx=await loadProactiveMessageContext(cfg,setting);
  const randomCharacters=setting.message_type==='random'?apiConfigs.filter(a=>a.id!==cfg.id).map(a=>({id:a.id,name:a.nickname||a.model||'另一位角色'})).slice(0,10):[];
  return{setting:setting,character:{id:cfg.id,provider:cfg.provider,apiKey:cfg.apiKey,model:cfg.model,endpoint:cfg.endpoint,systemPrompt:cfg.systemPrompt||getDefaultPromptForTheme(),nickname:cfg.nickname||cfg.model||'AI',relationship:cfg.relationship||'',temperature:cfg.temperature,showThinking:_resolveShowThinking(cfg)},user:ctx.user,recent_memories:ctx.memories,recent_messages:ctx.recentMessages,recent_proactive_messages:ctx.recentProactiveMessages,chat_summary:ctx.chatSummary,last_interaction_at:ctx.lastInteractionAt,random_characters:randomCharacters}
}
async function _activeSyncSetting(setting){
  if(!setting.background_enabled||!setting.enabled)return false;
  const cfg=apiConfigs.find(a=>a.id===setting.character_id);
  if(!_ibApiReady(cfg))return false;
  if(!_activeCompanionOnline&&!(await _activeCheckCompanion(false)))return false;
  try{const snapshot=await _activeBuildSnapshot(setting);await _activeCompanionRequest('/tasks/'+encodeURIComponent(setting.id),{method:'PUT',body:snapshot,timeout:5000});return true}
  catch(e){console.warn('[Active Messages] companion sync failed',e);_activeSetServiceStatus(false);return false}
}
async function _activeSyncAllBackground(){
  if(!_activeCompanionOnline)return;
  const all=await dbGetAll(ACTIVE_SETTINGS_STORE);
  const background=all.filter(x=>x.background_enabled&&x.enabled&&apiConfigs.some(a=>a.id===x.character_id&&_ibApiReady(a)));
  const synced=new Set();let ok=true;
  for(const s of background){if(await _activeSyncSetting(s))synced.add(s.id);else ok=false}
  const groups=new Map();groups.set(_activeUserId(),[]);
  all.forEach(function(s){const uid=s.user_id||_activeUserId();if(!groups.has(uid))groups.set(uid,[]);if(synced.has(s.id))groups.get(uid).push(s.id)});
  for(const [userId,ids] of groups){
    try{await _activeCompanionRequest('/reconcile',{method:'POST',body:{user_id:userId,task_ids:ids},timeout:5000})}catch(e){ok=false;console.warn('[Active Messages] companion reconcile failed',e)}
  }
  _activeCompanionReady=ok;_activeSetServiceStatus(_activeCompanionOnline);
  await _activeSyncAllAiPlans();/* AI 自主规划任务同步（companion 在线时由后台独占执行） */
  if(ok){_activeLastContextSync=Date.now();await _activeFlushPendingHistoryClear()}return ok
}
async function _activeDeleteCompanionTask(id,required){
  if(!_activeCompanionOnline){if(required)toast('后台服务未连接，操作尚未执行');return false}
  let s=null;try{s=await dbGet(ACTIVE_SETTINGS_STORE,id)}catch(e){}
  const userId=(s&&s.user_id)||_activeUserId();
  try{await _activeCompanionRequest('/tasks/'+encodeURIComponent(id)+'?user_id='+encodeURIComponent(userId),{method:'DELETE'});return true}
  catch(e){_activeSetServiceStatus(false);if(required)toast('无法同步后台计划，请确认服务正在运行后重试');return false}
}
async function _activePullCompanionEvents(){
  let localSettings=[];try{localSettings=await dbGetAll(ACTIVE_SETTINGS_STORE)}catch(e){}
  const userIds=new Set([_activeUserId()]);localSettings.forEach(s=>{if(s.user_id)userIds.add(String(s.user_id))});
  const events=[];
  for(const userId of userIds){
    let payload;try{payload=await _activeCompanionRequest('/events?limit=50&user_id='+encodeURIComponent(userId),{timeout:4000})}catch(e){_activeSetServiceStatus(false);return}
    const rows=Array.isArray(payload.events)?payload.events:[];
    rows.forEach(ev=>{if(!ev.user_id||String(ev.user_id)===userId)events.push({event:ev,user_id:userId})})
  }
  for(const wrapped of events){
    const ev=wrapped.event,eventUserId=wrapped.user_id;
    try{
      const s=await dbGet(ACTIVE_SETTINGS_STORE,ev.setting_id);
      const cfg=apiConfigs.find(a=>a.id===ev.character_id)||archivedConfigs.find(a=>a.id===ev.character_id);
      if(ev.status==='sent'&&ev.content){
        const msgId=ev.message_id||_activeMessageId(ev.setting_id||ev.plan_id,ev.scheduled_for);
        if(!(await dbGet('chatMessages',msgId))){
          const msg={id:msgId,role:'assistant',content:ev.content,reasoning_content:'',friendId:ev.character_id,senderName:ev.character_name||(cfg&&(cfg.nickname||cfg.model))||'AI',timestamp:ev.sent_at||Date.now(),source:'active_message',activeSettingId:ev.setting_id||ev.plan_id||'',activePlanId:ev.plan_id||'',scheduledFor:ev.scheduled_for,generatedByFallback:!!ev.generatedByFallback,metadata:{config_id:ev.character_id,apiConfigId:ev.character_id,provider:ev.provider||'',model:ev.provider||'',model_id:ev.model||'',showThinking:false,source:'active_message',activePlanId:ev.plan_id||'',task_revision:ev.task_revision||0,generatedByFallback:!!ev.generatedByFallback,generationAttempts:Number(ev.generation_attempts||1)}};
          await dbPut('chatMessages',msg);
          if(activeFriendId===ev.character_id)appendChatBubble('ai',msg.content,msg.senderName,msg.reasoning_content,msg.id,null,null,null,null,cfg||msg.metadata);else try{_markUnread(ev.character_id)}catch(e){}
          if(cfg)_activeNotify(cfg,msg.content);_activeProactiveLog('message saved',{taskId:ev.setting_id||'',characterId:ev.character_id||'',messageId:msg.id,provider:ev.provider||'',model:ev.model||'',generatedByFallback:!!ev.generatedByFallback,source:'companion'})
        }
      }
      await dbPut(ACTIVE_HISTORY_STORE,{id:ev.run_id||_activeRunId(ev.setting_id||ev.plan_id,ev.scheduled_for),setting_id:ev.setting_id||ev.plan_id||'',plan_id:ev.plan_id||'',user_id:eventUserId,character_id:ev.character_id,character_name:ev.character_name||'',scheduled_for:ev.scheduled_for,sent_at:ev.sent_at||Date.now(),status:ev.status||'sent',content:ev.content||'',reasoning_content:'',message_id:ev.message_id||'',error:ev.error||'',reason:ev.reason||'',source:ev.plan_id?'ai_planned':'companion',task_revision:ev.task_revision||0,setting_updated_at:ev.setting_updated_at||0,generatedByFallback:!!ev.generatedByFallback,generationAttempts:Number(ev.generation_attempts||1),generation_error:ev.generation_error||''});
      /* AI 计划事件：同步本地计划状态（companion 已发送 → waiting_for_user） */
      if(ev.plan_id){
        try{
          const lp=await dbGet(ACTIVE_PLANS_STORE,ev.plan_id);
          if(lp&&['scheduled','evaluating','sending'].includes(lp.status)&&ev.status==='sent'){
            const nowIso=new Date().toISOString();
            lp.status='waiting_for_user';lp.executedAt=nowIso;lp.updatedAt=nowIso;
            lp.attemptCount=Math.max(lp.attemptCount||0,1);
            await dbPut(ACTIVE_PLANS_STORE,lp)
          }else if(lp&&(ev.status==='canceled'||ev.status==='skipped'||ev.status==='failed')&&['scheduled','evaluating','sending'].includes(lp.status)){
            lp.status=ev.status==='failed'?'failed':(ev.status==='canceled'?'cancelled':'expired');
            lp.cancelReason=ev.reason||ev.error||'';lp.updatedAt=new Date().toISOString();
            if(ev.status==='failed')lp.lastError=String(ev.error||'').slice(0,300);
            await dbPut(ACTIVE_PLANS_STORE,lp)
          }
        }catch(e){}
      }
      if(s){
        if(ev.status==='sent')s.last_sent=Math.max(Number(s.last_sent||0),Number(ev.sent_at||Date.now()));
        const localEditedAfterEvent=Number(ev.setting_updated_at||0)>0&&Number(s.updated_at||0)>Number(ev.setting_updated_at||0);
        if(!localEditedAfterEvent)s.next_run_at=ev.next_run_at||_activeNextRun(s,Date.now()+1000);
        delete s.processing_until;delete s.processing_run_id;await dbPut(ACTIVE_SETTINGS_STORE,s)
      }
      await _activeCompanionRequest('/events/'+encodeURIComponent(ev.id)+'/ack',{method:'POST',body:{user_id:eventUserId}})
    }catch(e){console.warn('[Active Messages] event import failed',e)}
  }
  if(events.length){updateChatStorageInfo();if(currentPage==='active'){await _activeRenderSettings();await _activeRenderHistory()}if(currentPage==='chat')renderChatCalendar()}
}
function initActiveMessages(){
  if(_activeTimer)clearInterval(_activeTimer);
  _activeTimer=setInterval(_activeTick,30000);
  const ls=document.getElementById('active-local-status');if(ls){ls.classList.add('online');ls.textContent='页面调度运行中'}
  window.addEventListener('online',_activeTick);
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')_activeTick();else if(_activeCompanionOnline)_activeSyncAllBackground()});
  setTimeout(_activeTick,2500);
  setTimeout(function(){_activeRenderAiPrefs();_activeRenderAiPlans()},1200)
}

async function init(){await openDB();_ibGuardCheck();loadOutputSettings();await migrateLockedPosts();await loadApiConfigs();_refreshCachedUserName();loadPosts();loadCategories();updateBlogStats();loadAboutDisplay();_updateLastActive();_fabSyncHeight();_ibGuardInit();_vmInit();initActiveMessages();setTimeout(function(){_checkWelcomeBack(_presenceStartupLastActive)},2000)}
init();
initChatHeader();
setTimeout(function(){var m=document.getElementById('music-mini');if(m)m.classList.add('visible')},1800);
/* Sui 开关：欢迎页原文案与主页标题文案互换显示（签名行与横线保持不动） */
window.ibModeToggle=function(){
  var sw=document.getElementById('splash-swap');
  if(!sw)return;
  var on=!sw.classList.contains('ib-mode');
  sw.classList.toggle('ib-mode',on);
  var left=sw.closest('.splash-left');
  if(left)left.classList.toggle('ib-on',on);
  var sign=left?left.querySelector('.splash-sign'):null;
  if(sign){
    sign.style.animation='none';
    if(on){
      var ib=document.getElementById('splash-ib');
      var title=ib.querySelector('.home-title');
      var rule=ib.querySelector('.home-rule');
      var gap=Math.min(16,Math.max(9,innerWidth*0.011));
      var tr0=sign.style.transition;
      sign.style.transition='none';sign.style.transform='';
      var rg=document.createRange();rg.selectNodeContents(sign);
      var cr=rg.getBoundingClientRect();
      var sub=ib.querySelector('.home-subtitle');
      var sr=sub.getBoundingClientRect();
      var dy=title.getBoundingClientRect().bottom+gap-cr.top;
      var dx=sr.left-cr.left; /* 左对齐副标题 "A place of waking..." */
      void sign.offsetWidth;
      sign.style.transition=tr0||'';
      sign.style.transform='translate('+dx.toFixed(1)+'px,'+dy.toFixed(1)+'px)';
    }else sign.style.transform='';
  }
  var kids=document.getElementById('splash-ib').querySelectorAll('.home-subtitle,.home-title');
  kids.forEach(function(el,i){
    if(on)setTimeout(function(){el.classList.add('text-entered')},150+i*160);
    else el.classList.remove('text-entered');
  });
};

/* ---- 双挂载：HTML 内联 onclick 与其它文件仍经 window 访问；IB.active 登记全部导出 ---- */
function ibActiveLive(name, getter, setter){
  Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
}
window._activeBackgroundSettings=_activeBackgroundSettings;
window._activeEnsureCompanionForChange=_activeEnsureCompanionForChange;
window._activePrepareCharacterBackgroundChange=_activePrepareCharacterBackgroundChange;
window._activePrepareAllBackgroundRemoval=_activePrepareAllBackgroundRemoval;
window._activePrepareSettingBackgroundChange=_activePrepareSettingBackgroundChange;
window._activeQueueHistoryClear=_activeQueueHistoryClear;
window._activeFlushPendingHistoryClear=_activeFlushPendingHistoryClear;
window._activeUserId=_activeUserId;
window._activePad=_activePad;
window._activeTimeParts=_activeTimeParts;
window._activeAtTime=_activeAtTime;
window._activeIntervalMs=_activeIntervalMs;
window._activeNextRun=_activeNextRun;
window._activeRunId=_activeRunId;
window._activeMessageId=_activeMessageId;
window._activeFrequencyLabel=_activeFrequencyLabel;
window._activeTypeLabel=_activeTypeLabel;
window._activeFormatWhen=_activeFormatWhen;
window._activeFrequencyChanged=_activeFrequencyChanged;
window._activeIntervalUnitChanged=_activeIntervalUnitChanged;
window._activePopulateCharacters=_activePopulateCharacters;
window._activeResetEditor=_activeResetEditor;
window._activeSaveSetting=_activeSaveSetting;
window._activeEditSetting=_activeEditSetting;
window._activeDeleteSetting=_activeDeleteSetting;
window._activeToggleSetting=_activeToggleSetting;
window._activeInteractionState=_activeInteractionState;
window._activeRenderSettings=_activeRenderSettings;
window._activeRenderHistory=_activeRenderHistory;
window._activeClearHistory=_activeClearHistory;
window.loadActiveMessagePage=loadActiveMessagePage;
window._activeClaimDue=_activeClaimDue;
window._activeProactiveLog=_activeProactiveLog;
window._activeCustomInstruction=_activeCustomInstruction;
window._activeModeGuide=_activeModeGuide;
window._activeElapsedText=_activeElapsedText;
window._activeTextKey=_activeTextKey;
window._activeTextSimilarity=_activeTextSimilarity;
window._activeVisibleProactiveReply=_activeVisibleProactiveReply;
window._activeValidateProactiveReply=_activeValidateProactiveReply;
window._activeFallbackMessage=_activeFallbackMessage;
window._activeRecentMemories=_activeRecentMemories;
window._activeRecentMessages=_activeRecentMessages;
window._activeRecentProactiveMessages=_activeRecentProactiveMessages;
window.loadProactiveMessageContext=loadProactiveMessageContext;
window.buildProactivePrompt=buildProactivePrompt;
window.generateProactiveMessage=generateProactiveMessage;
window._activeBuildPrompt=_activeBuildPrompt;
window._activeGenerate=_activeGenerate;
window._activeStoreMessage=_activeStoreMessage;
window._activeFinishRun=_activeFinishRun;
window._activeAdaptiveReason=_activeAdaptiveReason;
window._activeSkipRun=_activeSkipRun;
window._activeExecuteRun=_activeExecuteRun;
window._activeRunNow=_activeRunNow;
window._activeTick=_activeTick;
window._activeNotify=_activeNotify;
window._activeRequestNotification=_activeRequestNotification;
window._activeCompanionRequest=_activeCompanionRequest;
window._activeSetServiceStatus=_activeSetServiceStatus;
window._activeCheckCompanion=_activeCheckCompanion;
window._activeBuildSnapshot=_activeBuildSnapshot;
window._activeSyncSetting=_activeSyncSetting;
window._activeSyncAllBackground=_activeSyncAllBackground;
window._activeDeleteCompanionTask=_activeDeleteCompanionTask;
window._activePullCompanionEvents=_activePullCompanionEvents;
window.initActiveMessages=initActiveMessages;
window.init=init;
window.ACTIVE_SETTINGS_STORE=ACTIVE_SETTINGS_STORE;
window.ACTIVE_HISTORY_STORE=ACTIVE_HISTORY_STORE;
window.ACTIVE_COMPANION_URL=ACTIVE_COMPANION_URL;
window.ACTIVE_PROACTIVE_MAX_ATTEMPTS=ACTIVE_PROACTIVE_MAX_ATTEMPTS;
window.ACTIVE_PROACTIVE_SIMILARITY=ACTIVE_PROACTIVE_SIMILARITY;
ibActiveLive('_activeTimer', function(){return _activeTimer}, function(v){_activeTimer=v});
ibActiveLive('_activeTicking', function(){return _activeTicking}, function(v){_activeTicking=v});
ibActiveLive('_activeCompanionOnline', function(){return _activeCompanionOnline}, function(v){_activeCompanionOnline=v});
ibActiveLive('_activeCompanionReady', function(){return _activeCompanionReady}, function(v){_activeCompanionReady=v});
ibActiveLive('_activeCompanionCheckedAt', function(){return _activeCompanionCheckedAt}, function(v){_activeCompanionCheckedAt=v});
ibActiveLive('_activeLastContextSync', function(){return _activeLastContextSync}, function(v){_activeLastContextSync=v});
NS.expose('active', {
  _activeBackgroundSettings: _activeBackgroundSettings,
  _activeEnsureCompanionForChange: _activeEnsureCompanionForChange,
  _activePrepareCharacterBackgroundChange: _activePrepareCharacterBackgroundChange,
  _activePrepareAllBackgroundRemoval: _activePrepareAllBackgroundRemoval,
  _activePrepareSettingBackgroundChange: _activePrepareSettingBackgroundChange,
  _activeQueueHistoryClear: _activeQueueHistoryClear,
  _activeFlushPendingHistoryClear: _activeFlushPendingHistoryClear,
  _activeUserId: _activeUserId,
  _activePad: _activePad,
  _activeTimeParts: _activeTimeParts,
  _activeAtTime: _activeAtTime,
  _activeIntervalMs: _activeIntervalMs,
  _activeNextRun: _activeNextRun,
  _activeRunId: _activeRunId,
  _activeMessageId: _activeMessageId,
  _activeFrequencyLabel: _activeFrequencyLabel,
  _activeTypeLabel: _activeTypeLabel,
  _activeFormatWhen: _activeFormatWhen,
  _activeFrequencyChanged: _activeFrequencyChanged,
  _activeIntervalUnitChanged: _activeIntervalUnitChanged,
  _activePopulateCharacters: _activePopulateCharacters,
  _activeResetEditor: _activeResetEditor,
  _activeSaveSetting: _activeSaveSetting,
  _activeEditSetting: _activeEditSetting,
  _activeDeleteSetting: _activeDeleteSetting,
  _activeToggleSetting: _activeToggleSetting,
  _activeInteractionState: _activeInteractionState,
  _activeRenderSettings: _activeRenderSettings,
  _activeRenderHistory: _activeRenderHistory,
  _activeClearHistory: _activeClearHistory,
  loadActiveMessagePage: loadActiveMessagePage,
  _activeClaimDue: _activeClaimDue,
  _activeProactiveLog: _activeProactiveLog,
  _activeCustomInstruction: _activeCustomInstruction,
  _activeModeGuide: _activeModeGuide,
  _activeElapsedText: _activeElapsedText,
  _activeTextKey: _activeTextKey,
  _activeTextSimilarity: _activeTextSimilarity,
  _activeVisibleProactiveReply: _activeVisibleProactiveReply,
  _activeValidateProactiveReply: _activeValidateProactiveReply,
  _activeFallbackMessage: _activeFallbackMessage,
  _activeRecentMemories: _activeRecentMemories,
  _activeRecentMessages: _activeRecentMessages,
  _activeRecentProactiveMessages: _activeRecentProactiveMessages,
  loadProactiveMessageContext: loadProactiveMessageContext,
  buildProactivePrompt: buildProactivePrompt,
  generateProactiveMessage: generateProactiveMessage,
  _activeBuildPrompt: _activeBuildPrompt,
  _activeGenerate: _activeGenerate,
  _activeStoreMessage: _activeStoreMessage,
  _activeFinishRun: _activeFinishRun,
  _activeAdaptiveReason: _activeAdaptiveReason,
  _activeSkipRun: _activeSkipRun,
  _activeExecuteRun: _activeExecuteRun,
  _activeRunNow: _activeRunNow,
  _activeTick: _activeTick,
  _activeNotify: _activeNotify,
  _activeRequestNotification: _activeRequestNotification,
  _activeCompanionRequest: _activeCompanionRequest,
  _activeSetServiceStatus: _activeSetServiceStatus,
  _activeCheckCompanion: _activeCheckCompanion,
  _activeBuildSnapshot: _activeBuildSnapshot,
  _activeSyncSetting: _activeSyncSetting,
  _activeSyncAllBackground: _activeSyncAllBackground,
  _activeDeleteCompanionTask: _activeDeleteCompanionTask,
  _activePullCompanionEvents: _activePullCompanionEvents,
  initActiveMessages: initActiveMessages,
  init: init,
  ACTIVE_SETTINGS_STORE: ACTIVE_SETTINGS_STORE,
  ACTIVE_HISTORY_STORE: ACTIVE_HISTORY_STORE,
  ACTIVE_COMPANION_URL: ACTIVE_COMPANION_URL,
  ACTIVE_PROACTIVE_MAX_ATTEMPTS: ACTIVE_PROACTIVE_MAX_ATTEMPTS,
  ACTIVE_PROACTIVE_SIMILARITY: ACTIVE_PROACTIVE_SIMILARITY,
  _activeTimer: _activeTimer,
  _activeTicking: _activeTicking,
  _activeCompanionOnline: _activeCompanionOnline,
  _activeCompanionReady: _activeCompanionReady,
  _activeCompanionCheckedAt: _activeCompanionCheckedAt,
  _activeLastContextSync: _activeLastContextSync,
});
})(window.IB || (window.IB = {}));
