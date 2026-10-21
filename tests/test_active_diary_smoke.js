'use strict';

/* Active Plans + Diary 浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   在拆分 active-diary.js 前锁定浏览器端计划持久化/UI、用户回复取消、
   Diary 解析/生成/去重/渲染/删除、window 与 IB 双挂载及运行时异常。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');


const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find(fs.existsSync) || null;
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0;
    this.pending = new Map(); this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => {});
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: {
        Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
      }});
      req.on('upgrade', (res, socket) => resolve(new Cdp(socket)));
      req.on('error', reject); req.end();
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000);
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message)); const mask = crypto.randomBytes(4);
    const body = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4); const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3];
    const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length]) : Buffer.alloc(4);
    if (payload.length >= 126) { header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    this.socket.write(Buffer.concat([header, mask, body]));
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0], short = this.buffer[1] & 0x7f; let off = 2, len = short;
      if (short === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; }
      else if (short === 127) { if (this.buffer.length < 10) return; len = this.buffer.readUInt32BE(6); off = 10; }
      const masked = (this.buffer[1] & 0x80) !== 0; let mask = null;
      if (masked) { if (this.buffer.length < off + 4) return; mask = this.buffer.subarray(off, off + 4); off += 4; }
      if (this.buffer.length < off + len) return;
      let payload = this.buffer.subarray(off, off + len); this.buffer = this.buffer.subarray(off + len);
      if (mask) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3]; payload = out; }
      const opcode = first & 0x0f;
      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) { this.sendFrame(0xA, payload); continue; }
      if (opcode !== 0x1) continue;
      let msg; try { msg = JSON.parse(payload.toString()); } catch (error) { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result || {});
      } else if (msg.method && this.listeners.has(msg.method)) {
        for (const listener of this.listeners.get(msg.method)) listener(msg.params || {});
      }
    }
  }
  close() { try { this.socket.destroy(); } catch (error) { /* ignore */ } }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result && r.result.value;
}
async function waitFor(cdp, expression, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (error) {} await new Promise(r => setTimeout(r, 120)); }
  return false;
}
function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); });
}
function startMockApi() {
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'POST') {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        title: '雨夜的小事', content: '今晚的雨很轻。我想起那段安静的对话，也记住了被认真倾听时的温度。',
        mood: '温暖', diaryType: 'daily', importance: 5, relatedMemoryIds: [], memoryCandidate: null
      }) } }] })); return;
    }
    res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const mock = await startMockApi(); const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-active-diary-smoke-'));
  const browser = spawn(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--remote-debugging-address=127.0.0.1','--remote-debugging-port=' + port,'--user-data-dir=' + profile,'about:blank'], { stdio: 'ignore' });
  let failures = 0, cdp;
  const check = (name, ok, detail = '') => { if (ok) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (error) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready); if (!ready) throw new Error('CDP 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    const exceptions = []; cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {})));
    await evaluate(cdp, "window.confirm=function(){return true;}");
    check('page.ready', await waitFor(cdp, "window.IB&&IB.active&&typeof dbPut==='function'&&typeof generateDiaryEntry==='function'", 20000));
    check('dual.active', await evaluate(cdp, "typeof _activeSaveAiPlan==='function'&&typeof IB.active.plans._activeSaveAiPlan==='function'"));
    check('dual.diary', await evaluate(cdp, "typeof _diaryParseOutput==='function'&&typeof IB.active.diary._diaryParseOutput==='function'"));

    await evaluate(cdp, "(async function(){await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:true,welcomeInterval:4,presenceGreetingEnabled:false,musicEnabled:false,summaryApiId:'',summaryWindow:60});await loadSummarySettingsUI()})()");
    check('presence.ui.legacyConfigIsSilentOnly', await evaluate(cdp, "document.getElementById('api-welcome-toggle').checked&&document.getElementById('api-welcome-interval').value==='4'&&!document.getElementById('api-presence-greeting-toggle').checked"));
    const uiValues=await evaluate(cdp, "(function(){var old=currentPage;IBSettingsCenter.open('general');document.body.classList.add('theme-infernal');var r=document.getElementById('api-presence-settings').getBoundingClientRect();var ok=!!document.getElementById('api-welcome-toggle')&&!!document.getElementById('api-presence-greeting-toggle')&&r.width>0;document.body.classList.remove('theme-infernal');if(old!=='settings')navTo(old);return ok})()");
    check('presence.ui.controlsRenderInInfernalTheme', uiValues===true);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
    const mobilePresence=await evaluate(cdp, "(function(){IBSettingsCenter.open('general');var p=document.getElementById('api-presence-settings').getBoundingClientRect(),s=document.querySelector('#page-settings .settings-center-content').getBoundingClientRect();return p.width>0&&p.left>=s.left-1&&p.right<=s.right+1&&p.right<=window.innerWidth+1})()");
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    check('presence.ui.fitsMobileSettingsSurface', mobilePresence===true);
    await evaluate(cdp, "(async function(){document.getElementById('api-presence-greeting-toggle').checked=true;await saveSummarySettings();document.getElementById('api-presence-greeting-toggle').checked=false;await saveSummarySettings()})()");
    check('presence.ui.greetingPersistsAndCanBeDisabled', await evaluate(cdp, "(async function(){var s=await getSummarySettings();return s.welcomeEnabled===true&&s.welcomeInterval===4&&s.presenceGreetingEnabled===false})()"));
    const promptPresence=await evaluate(cdp, "(function(){var p=buildProactivePrompt({character:{id:'active_smoke',nickname:'测试角色',systemPrompt:'保持克制。'},user:{name:'用户'},currentTime:new Date(),recentMessages:[{role:'user',content:'上次聊到窗边的植物。'}],recentProactiveMessages:[],presenceEvent:{id:'presence_test',durationMs:5*3600000}});return p.prompt})()");
    check('presence.prompt.AllowsNaturalSilence', promptPresence.includes('NO_PRESENCE_MESSAGE')&&promptPresence.includes('不要求你主动发消息')&&promptPresence.includes('5 小时'));
    const silentResult=await evaluate(cdp, "(async function(){return await generateProactiveMessage({character:{id:'active_smoke',nickname:'测试角色',systemPrompt:'保持克制。'},user:{name:'用户'},recentMessages:[],recentProactiveMessages:[],memories:[],currentTime:new Date(),presenceEvent:{id:'presence_silent',durationMs:5*3600000},requestModel:async function(){return '\"[[NO_PRESENCE_MESSAGE]]\"'}})})()");
    check('presence.modelCanChooseSilence', silentResult&&silentResult.silenced===true&&silentResult.content==='');
    const failedGeneration=await evaluate(cdp, "(async function(){return await generateProactiveMessage({character:{id:'active_smoke',nickname:'测试角色',systemPrompt:'保持克制。'},user:{name:'用户'},recentMessages:[],recentProactiveMessages:[],memories:[],currentTime:new Date(),presenceEvent:{id:'presence_fail',durationMs:5*3600000},requestModel:async function(){throw new Error('synthetic-provider-failure')}})})()");
    check('presence.providerFailureDoesNotUseGreetingFallback', failedGeneration&&failedGeneration.silenced===true&&failedGeneration.failed===true&&failedGeneration.content==='');
    const contextOnce=await evaluate(cdp, "(async function(){var now=Date.now(),s={version:2,departedAt:0,lastEventId:'presence_context',lastReturnEvent:null,pendingEvent:{id:'presence_context',departedAt:now-5*3600000,returnedAt:now,durationMs:5*3600000},contextClaim:null,contextConsumedEventId:'',greetingClaim:null,lastGreetingAt:0};localStorage.setItem('ib_presence_v2_state',JSON.stringify(s));var a=await IBPresenceRuntime.takeChatContext('active_smoke',false),b=await IBPresenceRuntime.takeChatContext('active_smoke',false),released=IBPresenceRuntime.finishChatContext('active_smoke',false),retry=await IBPresenceRuntime.takeChatContext('active_smoke',false),completed=IBPresenceRuntime.finishChatContext('active_smoke',true),after=JSON.parse(localStorage.getItem('ib_presence_v2_state'));return{a:a,b:b,released:released,retry:retry,completed:completed,pending:after.pendingEvent}})()");
    check('presence.contextRetriesAfterFailedTurnAndConsumesAfterReply', contextOnce.a.includes('约 5 小时')&&contextOnce.a.includes('不要求你提及')&&!contextOnce.b&&contextOnce.released===true&&contextOnce.retry.includes('约 5 小时')&&contextOnce.completed===true&&!contextOnce.pending);
    const restartResult=await evaluate(cdp, "(async function(){var now=Date.now(),left=now-5*3600000,s={version:2,departedAt:left,lastEventId:'',lastReturnEvent:null,pendingEvent:null,contextClaim:null,contextConsumedEventId:'',greetingClaim:null,lastGreetingAt:0};localStorage.setItem('ib_presence_v2_state',JSON.stringify(s));await window._checkWelcomeBack(0,{source:'startup'});var a=JSON.parse(localStorage.getItem('ib_presence_v2_state'));var first=a.lastEventId;await window._checkWelcomeBack(left,{source:'startup'});var b=JSON.parse(localStorage.getItem('ib_presence_v2_state'));return{first:first,again:b.lastEventId,pending:b.pendingEvent&&b.pendingEvent.id}})()");
    check('presence.restartAndDuplicateEventAreIdempotent', restartResult.first.indexOf('presence_')===0&&restartResult.again===restartResult.first&&restartResult.pending===restartResult.first);
    const shortAway=await evaluate(cdp, "(async function(){var now=Date.now(),s=JSON.parse(localStorage.getItem('ib_presence_v2_state'));s.departedAt=now-30*60000;localStorage.setItem('ib_presence_v2_state',JSON.stringify(s));var prior=s.lastEventId;await window._checkWelcomeBack(0,{source:'startup'});var next=JSON.parse(localStorage.getItem('ib_presence_v2_state'));return prior===next.lastEventId})()");
    check('presence.shortDepartureSuppressed', shortAway===true);
    const peerWindow=await evaluate(cdp, "(async function(){var now=Date.now(),key='ib_presence_tab_synthetic_peer',s=JSON.parse(localStorage.getItem('ib_presence_v2_state'));s.departedAt=now-5*3600000;s.lastEventId='peer-before';localStorage.setItem('ib_presence_v2_state',JSON.stringify(s));localStorage.setItem(key,JSON.stringify({visible:true,seenAt:now}));try{await window._checkWelcomeBack(0,{source:'startup'});var out=JSON.parse(localStorage.getItem('ib_presence_v2_state'));return out.lastEventId==='peer-before'&&out.departedAt===0}finally{localStorage.removeItem(key)}})()");
    check('presence.secondVisibleWindowPreventsFalseReturn', peerWindow===true);
    const roleClaim=await evaluate(cdp, "(function(){var r=IBPresenceRuntime,e='presence_multi_role_'+Date.now(),a=r.claimGreeting(e,'role_a'),b=r.claimGreeting(e,'role_b');r.finishGreeting(e,'silent');var again=r.claimGreeting(e,'role_a');return{a:a,b:b,again:again}})()");
    check('presence.oneRolePerEventAndNoRepeat', roleClaim.a===true&&roleClaim.b===false&&roleClaim.again===false);
    const disabledReturn=await evaluate(cdp, "(async function(){await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:false,welcomeInterval:4,presenceGreetingEnabled:false,musicEnabled:false,summaryApiId:'',summaryWindow:60});var now=Date.now(),s=JSON.parse(localStorage.getItem('ib_presence_v2_state'));s.departedAt=now-5*3600000;s.lastEventId='before-off';s.pendingEvent=null;localStorage.setItem('ib_presence_v2_state',JSON.stringify(s));await window._checkWelcomeBack(0,{source:'startup'});var out=JSON.parse(localStorage.getItem('ib_presence_v2_state'));return{changed:out.lastEventId!=='before-off',pending:out.pendingEvent}})()");
    check('presence.bothFeaturesOffCreatesNoContext', disabledReturn.changed===true&&disabledReturn.pending===null);
    const recovery=await evaluate(cdp, "(async function(){var core=window.IBPresenceCore,original=core.buildReturnEvent;try{core.buildReturnEvent=function(){throw new Error('synthetic-presence-failure')};var now=Date.now(),s=JSON.parse(localStorage.getItem('ib_presence_v2_state'));s.departedAt=now-5*3600000;s.lastEventId='recovery-before';localStorage.setItem('ib_presence_v2_state',JSON.stringify(s));var r=await window._checkWelcomeBack(0,{source:'startup'});var out=JSON.parse(localStorage.getItem('ib_presence_v2_state'));return r===false&&out.departedAt===s.departedAt}finally{core.buildReturnEvent=original}})()");
    check('presence.eventProcessingFailureKeepsDepartureForRecovery', recovery===true);

    check('plan.prefs', await evaluate(cdp, "(function(){_activeAiPrefsSave({enabled:true,mode:'hybrid',minIntervalMinutes:45,maxPlanHours:72,maxConsecutive:2,dndStart:'22:30',dndEnd:'07:15',cancelIfUserReplies:true,allowReschedule:false,showDebug:true});var p=_activeAiPrefs();return p.mode==='hybrid'&&p.minIntervalMinutes===45&&p.allowReschedule===false})()"));
    check('plan.parse', await evaluate(cdp, "_activeParsePlanJson('```json\\n{\"action\":\"none\",\"reason\":\"ok\"}\\n```').action==='none'"));
    check('plan.validate', await evaluate(cdp, "(function(){var n=Date.now();var v=_activeValidatePlanResult({action:'schedule',scheduledAt:new Date(n+3600000).toISOString(),intent:'问候'},n,_activeAiPrefs());return !!v&&v.intent==='问候'})()"));
    await evaluate(cdp, "(async function(){await dbPut(ACTIVE_PLANS_STORE,_activePlanDefaults({id:'plan_old',characterId:'active_smoke',scheduledAt:new Date(Date.now()+7200000).toISOString(),intent:'旧计划'}));await _activeSaveAiPlan(_activePlanDefaults({id:'plan_new',characterId:'active_smoke',scheduledAt:new Date(Date.now()+10800000).toISOString(),intent:'新计划'}));})()");
    check('plan.replace', await evaluate(cdp, "(async function(){var a=await dbGet(ACTIVE_PLANS_STORE,'plan_old'),b=await dbGet(ACTIVE_PLANS_STORE,'plan_new');return a.status==='cancelled'&&b.status==='scheduled'})()"));
    await evaluate(cdp, "_activeRenderAiPlans()");
    check('plan.render', await evaluate(cdp, "document.getElementById('ai-plan-list').textContent.indexOf('新计划')>=0"));
    await evaluate(cdp, "_activeUserReplied({friendId:'active_smoke'})");
    check('plan.replyCancel', await evaluate(cdp, "(async function(){return (await dbGet(ACTIVE_PLANS_STORE,'plan_new')).status==='cancelled'})()"));

    check('diary.prefs', await evaluate(cdp, "(function(){_diaryPrefsSave({enabled:true,weeklyEnabled:false,weeklyDay:3,weeklyTime:'21:10',dailyPlannerEnabled:false,eventEnabled:true});var p=_diaryPrefs();return p.weeklyEnabled===false&&p.weeklyDay===3&&p.weeklyTime==='21:10'})()"));
    check('diary.parseJson', await evaluate(cdp, "_diaryParseOutput('{\"title\":\"标题\",\"content\":\"正文\",\"mood\":\"平静\"}').title==='标题'"));
    check('diary.parseText', await evaluate(cdp, "_diaryParseOutput('标题：旧梦\\n正文：今晚想起一件小事。\\n心情：怀念').mood==='怀念'"));
    const cfg = "{id:'active_smoke',provider:'openai',model:'mock',endpoint:'http://127.0.0.1:" + mock.port + "/v1',apiKey:'',nickname:'测试角色',systemPrompt:'你是测试角色'}";
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs'," + cfg + ");await loadApiConfigs();})()");
    const chatContext=await evaluate(cdp, "(async function(){var now=Date.now(),cfg=apiConfigs.find(function(c){return c.id==='active_smoke'}),thread={id:'presence_context_thread',friendId:'active_smoke',memoryEnabled:false},s={version:2,v2Ready:true,departedAt:0,lastEventId:'presence_chat_context',lastReturnEvent:null,pendingEvent:{id:'presence_chat_context',departedAt:now-3*3600000,returnedAt:now,durationMs:3*3600000},contextClaim:null,contextConsumedEventId:'',greetingClaim:null,lastGreetingAt:0};try{await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:true,welcomeInterval:2,presenceGreetingEnabled:false,musicEnabled:false,summaryApiId:'',summaryWindow:60});localStorage.setItem('ib_presence_v2_state',JSON.stringify(s));await dbPut('chatThreads',thread);var out=await IB.chat.buildChatContext(cfg,{friendId:'active_smoke',threadId:thread.id,userMessage:'继续上次的话题。',history:[],dialogueHistory:[],conversationId:'chat:active_smoke',turnId:'presence_context_turn'});var injected=out&&out.system&&out.system.indexOf('约 3 小时')>=0,completed=IBPresenceRuntime.finishChatContext('active_smoke',true),state=JSON.parse(localStorage.getItem('ib_presence_v2_state'));return injected&&completed===true&&!state.pendingEvent}catch(e){return false}finally{await dbDelete('chatThreads',thread.id)}})()");
    check('presence.chatContextInjectsAndCompletesThroughSingleChatBuilder', chatContext===true);
    const greetGates=await evaluate(cdp, "(async function(){var oldPage=currentPage,oldFriend=activeFriendId,oldCalls=window._chatCallStates,input=document.getElementById('chat-full-input'),event={id:'presence_gate_'+Date.now(),returnedAt:Date.now(),durationMs:5*3600000};try{await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:true,welcomeInterval:4,presenceGreetingEnabled:true,musicEnabled:false,summaryApiId:'',summaryWindow:60});IBPresenceRuntime.configure(await getSummarySettings());currentPage='chat';activeFriendId='active_smoke';if(!_ibApiReady(apiConfigs.find(function(c){return c.id==='active_smoke'})))return false;input.value='这是一段尚未发送的草稿';var draftResult=await window._presenceTryWelcome(event);input.value='';var nextCalls=Object.assign({},oldCalls,{active_smoke:{ac:{}}});window._chatCallStates=nextCalls;var busyResult=await window._presenceTryWelcome(event);window._chatCallStates=oldCalls;IBPresenceRuntime.markChatActivity(Date.now(),true);var otherWindowActivity=await window._presenceTryWelcome(event);var noMessage=!(await dbGetAll('chatMessages')).some(function(m){return m&&m.source==='active_message'&&m.activeSettingId==='presence_'+event.id});return draftResult===false&&busyResult===false&&otherWindowActivity===false&&noMessage}finally{window._chatCallStates=oldCalls;localStorage.removeItem('ib_presence_chat_activity');input.value='';currentPage=oldPage;activeFriendId=oldFriend;await dbPut('apiSettings',{id:'summarySettings',enabled:false,keepCount:6,welcomeEnabled:true,welcomeInterval:4,presenceGreetingEnabled:false,musicEnabled:false,summaryApiId:'',summaryWindow:60});IBPresenceRuntime.configure(await getSummarySettings())}})()");
    check('presence.greetingDoesNotInterruptDraftActiveChatOrOtherWindowActivity', greetGates===true);
    const generated = await evaluate(cdp, "generateDiaryEntry('active_smoke',{trigger:'manual',diaryType:'daily',reason:'冒烟测试'})");
    check('diary.generate', generated && generated.ok === true && generated.entry && generated.entry.title === '雨夜的小事', JSON.stringify(generated));
    check('diary.persist', await evaluate(cdp, "(async function(){var a=await dbGetAll(DIARY_STORE);return a.some(e=>e.title==='雨夜的小事')})()"));
    check('diary.duplicate', await evaluate(cdp, "(async function(){return !!(await _diaryDuplicateCheck('active_smoke','雨夜的小事','今晚的雨很轻。我想起那段安静的对话，也记住了被认真倾听时的温度。'))})()"));
    await evaluate(cdp, "(function(){document.getElementById('diary-character').value='active_smoke';return _diaryRenderVault()})()");
    check('diary.render', await evaluate(cdp, "document.getElementById('diary-list').textContent.indexOf('雨夜的小事')>=0"));
    await evaluate(cdp, "(async function(){var a=await dbGetAll(DIARY_STORE);var e=a.find(x=>x.title==='雨夜的小事');if(e)await _diaryDelete(e.id)})()");
    check('diary.delete', await evaluate(cdp, "(async function(){var a=await dbGetAll(DIARY_STORE);return !a.some(e=>e.title==='雨夜的小事')})()"));

    await new Promise(r => setTimeout(r, 300));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.join('\n').slice(0, 500));
    console.log(failures ? '\nActive/Diary smoke failed: ' + failures : '\nActive/Diary smoke test passed ✔');
  } finally {
    if (cdp) cdp.close(); try { browser.kill(); } catch (error) {}
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) {}
  }
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
