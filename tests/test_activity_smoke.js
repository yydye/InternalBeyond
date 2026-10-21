'use strict';

/* Activity / Favorites / App Store 浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   覆盖：v21 新 store、IB.activity 会话与上下文注入、跨模块收藏层、
   App Store manifest+loader、共读间书架/分页、双挂载与运行时零异常。
   M1（Activity Context 迁移）新增 T1–T8：
     T1 新建 10 个不同 Cinema → chatThreads +0
     T2 新建 Coread → chatThreads +0
     T3 Activity 主聊天发送 → Context 正确注入（真实 mock 请求体取证）
     T4 metadata.activityId user/assistant 一致（新活动消息在主对话）
     T5 普通聊天无 activityId
     T6 同角色多 Activity → current pointer 只选择一个
     T7 pointer 丢失 → lastActiveAt fallback
     T8 finished activity 不注入
   另覆盖 Cinema 留影帧 request-local 视觉链路（activity.send → provider image part，不落库）
   与 legacy：旧 cinema 频道继续注入、发消息继续落旧频道、openChat 仍选旧频道。 */

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
const MOCK_REPLY = '这是活动测试的 mock 回复。';
/* 工具续轮探针：首次请求（不含工具结果）返回带 ws_read 的回复 → 主流程执行工具 →
   续轮请求体含「工具执行结果」→ 返回纯文本收尾。用于验证续轮 assistant 继承 activityId。 */
const TOOL_PROBE = '触发工具续轮';
const TOOL_REPLY = MOCK_REPLY + '<ws_read path="m1_missing_file.txt"/>';
const J = JSON.stringify;

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
  constructor(socket) { this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0; this.pending = new Map(); this.listeners = new Map(); socket.on('data', c => { this.buffer = Buffer.concat([this.buffer, c]); this.parse(); }); socket.on('error', () => {}); }
  static connect(wsUrl) { return new Promise((resolve, reject) => { const url = new URL(wsUrl); const req = http.request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } }); req.on('upgrade', (res, socket) => resolve(new Cdp(socket))); req.on('error', reject); req.end(); }); }
  on(method, listener) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(listener); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.sendText({ id, method, params }); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 15000); }); }
  sendText(m) { const p = Buffer.from(JSON.stringify(m)); const mask = crypto.randomBytes(4); const body = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) body[i] = p[i] ^ mask[i & 3]; let h; if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]); else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); } this.socket.write(Buffer.concat([h, mask, body])); }
  sendFrame(op, payload) { const mask = crypto.randomBytes(4); const body = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i & 3]; const h = payload.length < 126 ? Buffer.from([0x80 | op, 0x80 | payload.length]) : Buffer.alloc(4); if (payload.length >= 126) { h[0] = 0x80 | op; h[1] = 0x80 | 126; h.writeUInt16BE(payload.length, 2); } this.socket.write(Buffer.concat([h, mask, body])); }
  parse() { while (true) { if (this.buffer.length < 2) return; const op = this.buffer[0] & 0x0f; let len = this.buffer[1] & 0x7f; let off = 2; if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); off = 4; } else if (len === 127) { return; } if (this.buffer.length < off + len) return; const payload = this.buffer.slice(off, off + len); this.buffer = this.buffer.slice(off + len); if (op === 1) { try { const msg = JSON.parse(payload.toString('utf8')); if (this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); } if (msg.method && this.listeners.has(msg.method)) for (const l of this.listeners.get(msg.method)) l(msg.params); } catch (e) { /* ignore */ } } } }
  close() { try { this.socket.end(); } catch (e) {} }
}

async function evaluate(cdp, expression) { const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception)); return r.result && r.result.value; }
async function waitFor(cdp, expression, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await evaluate(cdp, expression)) return true; } catch (e) {} await new Promise(r => setTimeout(r, 120)); } return false; }
async function waitNode(fn, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (fn()) return true; } catch (e) {} await new Promise(r => setTimeout(r, 120)); } return false; }
function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); }); }); }

/* 本地 mock OpenAI 兼容端点：记录最近一次请求体（用于证明 Activity Context / 帧真的进了请求）。 */
function startMockApi() {
  return new Promise((resolve) => {
    const captured = { lastBody: '', count: 0, vision: false };
    const server = http.createServer((req, res) => {
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key,anthropic-version,x-goog-api-key'
      };
      if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
      if (req.method === 'POST' && req.url.includes('/chat/completions')) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          captured.lastBody = body; captured.count++;
          if (body.indexOf('image_url') !== -1 || body.indexOf('data:image/jpeg') !== -1) captured.vision = true;
          /* 工具续轮探针：首次（无「工具执行结果」）返回带工具标签的回复，续轮返回纯文本 */
          const wantsTool = body.indexOf(TOOL_PROBE) !== -1 && body.indexOf('工具执行结果') === -1;
          const content = wantsTool ? TOOL_REPLY : MOCK_REPLY;
          res.writeHead(200, headers);
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
        });
        return;
      }
      res.writeHead(404, headers);
      res.end(JSON.stringify({ error: 'not found' }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, captured }));
  });
}

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const mock = await startMockApi();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-activity-smoke-'));
  const browser = spawn(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--remote-debugging-address=127.0.0.1','--remote-debugging-port=' + port,'--user-data-dir=' + profile,'about:blank'], { stdio: 'ignore' });
  let failures = 0, cdp;
  const check = (n, ok, d = '') => { if (ok) console.log('  PASS  ' + n); else { failures++; console.error('  FAIL  ' + n + (d ? ' -> ' + d : '')); } };
  try {
    let ready = false; for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready); if (!ready) throw new Error('CDP 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable');
    const exceptions = []; cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {})));
    await evaluate(cdp, "window.confirm=function(){return true;}");
    check('page.ready', await waitFor(cdp, "window.IB&&IB.activity&&typeof dbPut==='function'", 20000));

    /* v21 新 store + 双挂载。
       版本断言按"引入该 store 的版本"而不是把当前 DB_VER 写死：DB_VER 已随 v22/v23
       （understandings / threads）前进，写死 21 只会在每次升版时误报，且不能证明 store 存在。 */
    check('db.stores', await evaluate(cdp, "(async function(){var d=await ensureDB();return DB_VER>=21&&d.objectStoreNames.contains('activities')&&d.objectStoreNames.contains('favorites')})()"));
    check('dual.activity', await evaluate(cdp, "typeof window.IBActivity==='object'&&typeof IB.activity.createActivity==='function'&&typeof IB.activity.resolveActivity==='function'&&typeof IB.activity.setCurrent==='function'&&typeof IB.activity.clearCurrent==='function'"));
    check('dual.favorites', await evaluate(cdp, "typeof window.favAdd==='function'&&typeof IB.favorites.add==='function'"));
    check('dual.appstore', await evaluate(cdp, "typeof IB.apps==='object'&&typeof IB.apps.register==='function'&&typeof IBApps.boot==='function'"));

    const mockEndpoint = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    await evaluate(cdp, "(async function(){var mk=function(id,nick){return{id:id,provider:'custom',model:'m',endpoint:" + J(mockEndpoint) + ",apiKey:'',nickname:nick,relationship:'测试',systemPrompt:'你是测试角色',streaming:false,showThinking:false,created:Date.now()}};await dbPut('apiConfigs',mk('act_a','书友'));await dbPut('apiConfigs',mk('act_plain','洁净'));await dbPut('apiConfigs',mk('act_multi','多活动'));await loadApiConfigs();await dbPut('posts',{id:'post_1',title:'夜航西飞',subtitle:'',content:'第一章 启程\\n\\n我们出发时，海面潋滟。\\n\\n第二章 归途\\n\\n彼时潮声未歇。',created:Date.now()});})()");
    check('configs.ready', await evaluate(cdp, "apiConfigs.length>=3&&apiConfigs.some(function(a){return a.id==='act_a'&&!!a.endpoint})"));

    const countThreads = "(async function(){return (await dbGetAll('chatThreads')).length})()";
    const threadsBefore = await evaluate(cdp, countThreads);

    /* ── T1 新建 10 个不同 Cinema → chatThreads +0 ── */
    const t1 = await evaluate(cdp, "(async function(){var bad=[];for(var i=0;i<10;i++){var a=await IB.activity.createActivity({type:'cinema',roleId:'act_a',resourceId:'cin_'+i,resourceKey:'cin_'+i,title:'片'+i,kind:'cinema',progress:{sec:0}});if(!a||a.threadId)bad.push(i)}return bad.join(',')})()");
    const threadsAfterCinema = await evaluate(cdp, countThreads);
    check('T1.newCinemaNoThread', t1 === '', String(t1));
    check('T1.chatThreadsDelta0', threadsAfterCinema === threadsBefore, threadsBefore + ' -> ' + threadsAfterCinema);

    /* ── T2 新建 Coread → chatThreads +0 ── */
    const bookId = await evaluate(cdp, "IB.activity.createActivity({type:'coread',roleId:'act_a',resourceId:'book_1',resourceKey:'book_1',title:'书一',kind:'coread',progress:{page:1,total:2,pct:50,pageText:'我们出发时，海面潋滟。'}}).then(function(a){return a?a.id:''})");
    const threadsAfterCoread = await evaluate(cdp, countThreads);
    check('T2.coreadNoThread', await evaluate(cdp, "IB.activity.getActivity(" + J(bookId) + ").then(function(a){return !a.threadId})"));
    check('T2.chatThreadsDelta0', threadsAfterCoread === threadsBefore, threadsBefore + ' -> ' + threadsAfterCoread);

    /* 基础契约（create/find/setProgress/legacy 字段形状） */
    const act = await evaluate(cdp, "IB.activity.listActivities({type:'cinema',roleId:'act_a'}).then(function(l){return l.length?{id:l[0].id,roleId:l[0].roleId,threadId:l[0].threadId||null,type:l[0].type}:null})");
    check('activity.create', act && /^act_/.test(act.id) && act.roleId === 'act_a' && act.threadId === null && act.type === 'cinema', JSON.stringify(act));
    check('activity.findActivity', (await evaluate(cdp, "IB.activity.findActivity('coread','act_a','book_1').then(function(a){return!!a})")) === true);
    const prog = await evaluate(cdp, "IB.activity.setProgress(" + J(bookId) + ",{page:2,total:2,pct:100,pageText:'彼时潮声未歇。'}).then(function(a){return a&&a.progress&&a.progress.page})");
    check('activity.setProgress', prog === 2, String(prog));

    /* ── T3 Activity 主聊天发送 → Context 正确注入；── T4 user/assistant metadata.activityId 一致 ── */
    const filmId = await evaluate(cdp, "IB.activity.createActivity({type:'cinema',roleId:'act_a',resourceId:'film_ctx',resourceKey:'film_ctx',title:'测试片A',kind:'cinema',progress:{sec:90,dur:600,subs:[[80,0,'我们出发吧']],recap:''}}).then(function(a){return a.id})");
    await evaluate(cdp, "IB.activity.setCurrent(" + J(filmId) + ")");
    check('T3.pointerResolves', (await evaluate(cdp, "IB.activity.resolveActivity('act_a').then(function(r){return r&&r.id})")) === filmId);
    const cinemaGuide = await evaluate(cdp, "IB.activity.buildActivityContext({type:'cinema',title:'字幕边界测试',progress:{sec:12,dur:30,subs:[[8,10,'角色推开门']],recap:'她正在寻找答案。',upTo:10,subtitlesAvailable:true}})");
    check('Cinema.context自然讨论字幕而非复述', /不逐句复述字幕/.test(cinemaGuide) && /人物动机/.test(cinemaGuide), String(cinemaGuide).slice(-300));
    const cinemaNoSubs = await evaluate(cdp, "IB.activity.buildActivityContext({type:'cinema',title:'无字幕测试',progress:{sec:12,dur:30,subs:[],recap:'',subtitlesAvailable:false}})");
    check('Cinema.noSubtitleHonestFallback', /没有加载可用字幕/.test(cinemaNoSubs) && /不要编造对白/.test(cinemaNoSubs), String(cinemaNoSubs).slice(-300));
    check('Cinema.visualOnlyWhenFrameAttached', /本轮消息实际附带留影图像/.test(cinemaGuide), String(cinemaGuide).slice(-300));
    mock.captured.lastBody = '';
    const sendRes = await evaluate(cdp, "(async function(){return await IB.activity.send(" + J(filmId) + ",'这一幕怎么样？')})()");
    check('T3.sendOk', sendRes && sendRes.ok === true, JSON.stringify(sendRes));
    check('T3.contextInjected', mock.captured.lastBody.indexOf('观影室') >= 0 && mock.captured.lastBody.indexOf('测试片A') >= 0 && mock.captured.lastBody.indexOf('1:30') >= 0, mock.captured.lastBody.slice(-320));
    const meta4 = await evaluate(cdp, "(async function(){var all=await dbGetAll('chatMessages');var u=null,ai=null;all.forEach(function(m){if(m.role==='user'&&m.content==='这一幕怎么样？')u=m;if(m.role==='assistant'&&m.content===" + J(MOCK_REPLY) + ")ai=m});return JSON.stringify({u:u&&u.metadata&&u.metadata.activityId,a:ai&&ai.metadata&&ai.metadata.activityId,thread:(u&&u.threadId)||null})})()");
    const mm = JSON.parse(meta4 || '{}');
    check('T4.userActivityId', mm.u === filmId, meta4);
    check('T4.assistantActivityId', mm.a === filmId, meta4);
    check('T4.mainConversation', mm.thread === null, meta4);

    /* ── Cinema 留影帧（request-local）：activity.send → sentImages → provider vision；不落库 ── */
    mock.captured.vision = false;
    const vres = await evaluate(cdp, "(async function(){var cv=document.createElement('canvas');cv.width=64;cv.height=48;var cx=cv.getContext('2d');cx.fillStyle='#2a6';cx.fillRect(0,0,64,48);cx.fillStyle='#fc0';cx.fillRect(20,10,24,28);var du=cv.toDataURL('image/jpeg',0.8);return await IB.activity.send(" + J(filmId) + ",'留影这一幕，你看到了吗？',{visionReference:{dataUrl:du}})})()");
    check('Vision.sendOk', vres && vres.ok === true, JSON.stringify(vres));
    check('Vision.frameReachesProvider', mock.captured.vision === true, 'captured.vision=' + mock.captured.vision);
    check('Vision.frameNotPersisted', await evaluate(cdp, "(async function(){var all=await dbGetAll('chatMessages');var u=null;all.forEach(function(m){if(m.role==='user'&&m.content==='留影这一幕，你看到了吗？')u=m});return !!u&&!(u.images&&u.images.length)&&String(u.content||'').indexOf('data:image')===-1})()"));

    /* ── T9 工具续轮 assistant 继承同回合 activityId（真实非流式工具续轮链路：
       主回复带 ws_read → 工具执行产生反馈 → _wsToolContinueInner 再落一条 assistant） ── */
    const contSend = await evaluate(cdp, "(async function(){return await IB.activity.send(" + J(filmId) + "," + J(TOOL_PROBE) + ")})()");
    check('T9.continuationSendOk', contSend && contSend.ok === true, JSON.stringify(contSend));
    const contMeta = await evaluate(cdp, "(async function(){var all=await dbGetAll('chatMessages');var c=null;all.forEach(function(m){if(m.role==='assistant'&&m.metadata&&typeof m.metadata.toolRound==='number')c=m});return JSON.stringify({act:(c&&c.metadata&&c.metadata.activityId)||null,round:(c&&c.metadata&&typeof c.metadata.toolRound==='number')?c.metadata.toolRound:null,content:(c&&c.content)||null})})()");
    const cm = JSON.parse(contMeta || '{}');
    check('T9.toolContinueInheritsActivityId', cm.act === filmId && cm.round >= 1 && cm.content === MOCK_REPLY, String(contMeta));

    /* ── T5 普通聊天无 activityId（act_plain 无任何活动） ── */
    await evaluate(cdp, "selectFriend('act_plain')");
    await evaluate(cdp, "(function(){var a=document.getElementById('chat-input'),b=document.getElementById('chat-full-input');if(a)a.value='普通一句';if(b)b.value='普通一句';sendChatMessage()})()");
    check('T5.replyArrived', await waitFor(cdp, "(async function(){var all=await dbGetAll('chatMessages');return all.some(function(m){return m.friendId==='act_plain'&&m.role==='assistant'})})()", 15000));
    const t5 = await evaluate(cdp, "(async function(){var all=await dbGetAll('chatMessages');var u=null,ai=null;all.forEach(function(m){if(m.friendId==='act_plain'&&m.role==='user')u=m;if(m.friendId==='act_plain'&&m.role==='assistant')ai=m});return JSON.stringify({u:!(u&&u.metadata&&u.metadata.activityId),a:!(ai&&ai.metadata&&ai.metadata.activityId)})})()");
    check('T5.noActivityId', t5 === '{"u":true,"a":true}', String(t5));

    /* ── T6 同角色多 Activity → current pointer 只选择一个 ── */
    const multiIds = JSON.parse(await evaluate(cdp, "(async function(){var A=await IB.activity.createActivity({type:'cinema',roleId:'act_multi',resourceId:'m_a',resourceKey:'m_a',title:'甲片',kind:'cinema',progress:{sec:0}});var B=await IB.activity.createActivity({type:'coread',roleId:'act_multi',resourceId:'m_b',resourceKey:'m_b',title:'乙书',kind:'coread',progress:{page:1,total:1}});return JSON.stringify({a:A.id,b:B.id})})()"));
    await evaluate(cdp, "IB.activity.setCurrent(" + J(multiIds.b) + ")");
    check('T6.pointerPicksB', (await evaluate(cdp, "IB.activity.resolveActivity('act_multi').then(function(r){return r&&r.id})")) === multiIds.b);
    await evaluate(cdp, "IB.activity.setCurrent(" + J(multiIds.a) + ")");
    check('T6.pointerPicksA', (await evaluate(cdp, "IB.activity.resolveActivity('act_multi').then(function(r){return r&&r.id})")) === multiIds.a);

    /* ── T7 pointer 丢失 → lastActiveAt fallback ── */
    /* 两个活动显式分时 touch（25ms），保证 lastActiveAt 有确定的大小关系（避免同毫秒并列） */
    await evaluate(cdp, "(async function(){await IB.activity.setProgress(" + J(multiIds.a) + ",{sec:1});await new Promise(function(r){setTimeout(r,25)});await IB.activity.setProgress(" + J(multiIds.b) + ",{page:1,total:2})})()");
    await evaluate(cdp, "localStorage.removeItem('ib_activity_current_v1')");
    const t7r = await evaluate(cdp, "IB.activity.resolveActivity('act_multi').then(function(r){return r?r.id:null})");
    check('T7.pointerLossFallback', t7r === multiIds.b, 'got=' + t7r + ' want=' + multiIds.b);

    /* ── T8 finished activity 不注入 ── */
    await evaluate(cdp, "IB.activity.saveActivity(" + J(multiIds.b) + ",{status:'finished'})");
    check('T8.finishedSkipped', (await evaluate(cdp, "IB.activity.resolveActivity('act_multi').then(function(r){return r&&r.id})")) === multiIds.a);
    await evaluate(cdp, "IB.activity.saveActivity(" + J(multiIds.a) + ",{status:'finished'})");
    check('T8.finishedNoInject', (await evaluate(cdp, "IB.activity.getActivityContext('act_multi',{})")) === '');

    /* ── T10 finished activity：send 明确拒绝，不 fallback 到其他 activity ── */
    const finSend = await evaluate(cdp, "IB.activity.send(" + J(multiIds.a) + ",'不该发出的消息').then(function(r){return JSON.stringify(r)})");
    check('T10.finishedSendRejected', finSend === J({ ok: false, error: 'activity_finished' }), String(finSend));
    check('T10.finishedSendNoMessage', await evaluate(cdp, "(async function(){var all=await dbGetAll('chatMessages');return !all.some(function(m){return m.content==='不该发出的消息'})})()"));

    /* ── Legacy fallback 隔离：主对话不注入 legacy activity；旧频道锚仍正常注入 ── */
    await evaluate(cdp, "(async function(){await dbPut('chatThreads',{id:'thread_lg1',friendId:'act_lg1',name:'观影室 · 旧片二号',kind:'cinema',quiet:true,memoryEnabled:true,created:Date.now()});await dbPut('activities',{id:'act_lg1_1',type:'cinema',roleId:'act_lg1',resourceId:'lg1_key',resourceKey:'lg1_key',title:'旧片二号',kind:'cinema',threadId:'thread_lg1',progress:{sec:42,dur:100,subs:[],recap:''},bookmarks:[],recap:'',config:{},status:'active',createdAt:Date.now(),updatedAt:Date.now(),lastActiveAt:Date.now()})})()");
    check('legacy.mainChatNoInject', (await evaluate(cdp, "IB.activity.getActivityContext('act_lg1',{})")) === '');
    check('legacy.resolveNullInMain', (await evaluate(cdp, "IB.activity.resolveActivity('act_lg1').then(function(r){return r?r.id:null})")) === null);
    check('legacy.threadStillInjects', String(await evaluate(cdp, "IB.activity.getActivityContext('act_lg1',{threadId:'thread_lg1'})")).indexOf('旧片二号') >= 0);
    await evaluate(cdp, "IB.activity.setCurrent('act_lg1_1')");
    check('legacy.pointerDoesNotLeakToMain', (await evaluate(cdp, "IB.activity.getActivityContext('act_lg1',{})")) === '');
    check('legacy.pointerThreadStillInjects', String(await evaluate(cdp, "IB.activity.getActivityContext('act_lg1',{threadId:'thread_lg1'})")).indexOf('旧片二号') >= 0);
    await evaluate(cdp, "IB.activity.clearCurrent('act_lg1')");

    /* 无活动角色不注入（替代旧“普通频道不注入”的平面断言） */
    check('activity.contextNoActivity', (await evaluate(cdp, "IB.activity.getActivityContext('act_plain',{})")) === '');
    check('activity.contextUnknownRole', (await evaluate(cdp, "IB.activity.getActivityContext('nobody',{activityId:" + J(filmId) + "})")) === '');

    /* ── Legacy 兼容：旧 cinema 频道只读保留并可继续工作 ── */
    await evaluate(cdp, "(async function(){await dbPut('chatThreads',{id:'thread_legacy1',friendId:'act_a',name:'观影室 · 旧片',kind:'cinema',quiet:true,memoryEnabled:true,created:Date.now()});await dbPut('activities',{id:'act_legacy1',type:'cinema',roleId:'act_a',resourceId:'legacy_key',resourceKey:'legacy_key',title:'旧片存档',kind:'cinema',threadId:'thread_legacy1',progress:{sec:10,dur:100,subs:[],recap:''},bookmarks:[],recap:'',config:{},status:'active',createdAt:Date.now(),updatedAt:Date.now(),lastActiveAt:Date.now()})})()");
    const legCtx = await evaluate(cdp, "IB.activity.getActivityContext('act_a',{threadId:'thread_legacy1'})");
    check('legacy.contextInject', typeof legCtx === 'string' && legCtx.indexOf('旧片存档') >= 0 && legCtx.indexOf('测试片A') === -1, String(legCtx).slice(0, 160));
    const legSend = await evaluate(cdp, "(async function(){return await IB.activity.send('act_legacy1','旧频道继续聊')})()");
    check('legacy.sendOk', legSend && legSend.ok === true, JSON.stringify(legSend));
    check('legacy.replyInOldThread', await waitFor(cdp, "(async function(){var all=await dbGetAll('chatMessages');return all.some(function(m){return m.role==='assistant'&&m.threadId==='thread_legacy1'})})()", 15000));
    const legStore = await evaluate(cdp, "(async function(){var all=await dbGetAll('chatMessages');var u=null;all.forEach(function(m){if(m.role==='user'&&m.content==='旧频道继续聊')u=m});return JSON.stringify({thread:(u&&u.threadId)||null,act:u&&u.metadata&&u.metadata.activityId})})()");
    check('legacy.userInOldThread', legStore === J({ thread: 'thread_legacy1', act: 'act_legacy1' }), String(legStore));

    /* openChat：新活动 → 主对话 + current；legacy → 旧频道 */
    await evaluate(cdp, "IB.activity.openChat(" + J(filmId) + ")");
    await new Promise(r => setTimeout(r, 200));
    check('openChat.newActivityMain', await evaluate(cdp, "activeFriendId==='act_a'&&!activeThreadId"));
    await evaluate(cdp, "IB.activity.openChat('act_legacy1')");
    await new Promise(r => setTimeout(r, 200));
    check('legacy.openChatSelectsThread', await evaluate(cdp, "activeFriendId==='act_a'&&activeThreadId==='thread_legacy1'"));

    /* 收藏层（跨模块） */
    const fav = await evaluate(cdp, "IB.favorites.add({type:'blog',roleId:'',sourceId:'post_1',title:'夜航西飞',body:'书签一段'});IB.favorites.add({type:'chat',roleId:'act_a',sourceId:'msg_x',body:'一句值得留的话'}).then(function(){return IB.favorites.count()})");
    check('favorites.add', fav === 2, String(fav));
    check('favorites.has', await evaluate(cdp, "IB.favorites.has('post_1').then(function(h){return h===true})"));
    const favList = await evaluate(cdp, "IB.favorites.list({type:'blog'}).then(function(l){return l.length===1&&l[0].type==='blog'&&l[0].sourceId==='post_1'})");
    check('favorites.list', favList === true, String(favList));
    check('favorites.remove', await evaluate(cdp, "(async function(){var l=await IB.favorites.list({type:'blog'});await IB.favorites.remove(l[0].id);return (await IB.favorites.count())===1})()"));

    /* App Store：manifest + loader */
    check('appstore.catalog', await waitFor(cdp, "IB.apps&&IB.apps.catalog&&IB.apps.catalog().length>=2"));
    const cat = await evaluate(cdp, "IB.apps.catalog().map(function(a){return a.id+':'+(a.file||'inline')})");
    check('appstore.catalogShape', /coread:inline/.test(cat || '') && /cinema:ib-app-cinema\.js/.test(cat || ''), String(cat));
    check('appstore.install', await evaluate(cdp, "(function(){IB.apps.install('cinema');return IB.apps.isInstalled('cinema')})()"));
    check('appstore.registerGate', await evaluate(cdp, "IB.apps.register({id:'xx_bad--',name:'x',sdk:3,mount:function(){}})===false&&IB.apps.register({id:'good',name:'g',sdk:2,mount:function(){}})===true"));

    /* 共读间书架渲染（coreadOpen 会为新活动 setCurrent，不影响已有断言） */
    await evaluate(cdp, "loadCoreadPage()");
    check('coread.shelf', await waitFor(cdp, "document.querySelectorAll('.cr-book').length>=1"));
    check('coread.open', await evaluate(cdp, "coreadOpen('post_1').then(function(){return document.getElementById('coread-read-view').style.display==='block'})"));

    /* 收藏页渲染 */
    await evaluate(cdp, "favOpenPage()");
    check('favorites.render', await waitFor(cdp, "document.querySelectorAll('.fav-paper').length>=1"));

    /* Proactive 联动：nudge 应写出一条活动感知的主动计划 */
    check('activity.nudge', await evaluate(cdp, "(async function(){await IB.activity.nudge({activityId:" + J(bookId) + "});var plans=await dbGetAll('active_message_plans');return plans.some(function(p){return p.characterId==='act_a'&&p.source==='ai_planned'&&p.intent&&p.intent.indexOf('共读')>=0})})()"));

    /* Favorites 复用控件：makeBtn / starCard / 跳回原内容 */
    check('fav.controls', await evaluate(cdp, "typeof IB.favorites.makeBtn==='function'&&typeof IB.favorites.starCard==='function'&&typeof window._favOpenItem==='function'"));
    check('fav.starCard', await evaluate(cdp, "(function(){var el=document.createElement('div');var b=IB.favorites.starCard(el,{type:'blog',sourceId:'post_1',title:'t',body:'b'});return el.contains(b)&&b.className.indexOf('fav-toggle-btn')>=0})()"));

    /* Cinema 流式接入：宿主 broadcast → 打开中的 App 经 ctx.on('message'|'turn') 收到；
       M1：payload 新增 activityId 字段，Cinema 小窗据此过滤（此处只证明字段可透传且不破坏旧消费者）。 */
    const streamGot = await evaluate(cdp, "(async function(){var got=[];IB.apps.register({id:'mockapp',name:'mock',sdk:2,mount:async function(h,c){c.on('message',function(m){got.push('m:'+(m&&m.content)+':'+(m&&m.activityId))});c.on('turn',function(t){got.push('turn:'+(t&&t.state))})}});IB.apps.open('mockapp');IB.apps.broadcast('message',{role:'assistant',content:'弹幕内容',activityId:'act_x'});IB.apps.broadcast('turn',{state:'end',activityId:'act_x'});await new Promise(function(r){setTimeout(r,60)});return got.join(',')})()");
    check('appstream.emit', /m:弹幕内容:act_x/.test(streamGot || '') && /turn:end/.test(streamGot || ''), String(streamGot));

    /* ══ M1.5 · Activity Runtime Hardening ══════════════════════════
       a) pointer 生命周期：Cinema unmount 只清自身 current
       b) onTurn 通道过滤 + typing 超时
       c) grabFrame 异常防御（mock SecurityError → 不抛/无帧/如实提示） */
    await evaluate(cdp, "IB.apps.close()");
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs',{id:'act_m15',provider:'custom',model:'m',endpoint:" + J(mockEndpoint) + ",apiKey:'',nickname:'硬化',relationship:'测试',systemPrompt:'x',streaming:false,showThinking:false,vision:true,created:Date.now()});await loadApiConfigs()})()");
    const ptrExpr = "JSON.parse(localStorage.getItem('ib_activity_current_v1')||'{}')";
    const ptrHas = "(function(){try{var p=" + ptrExpr + ";return !!(p.act_m15&&p.act_m15.activityId)}catch(e){return false}})()";
    const ptrOf = "(function(){try{return (" + ptrExpr + ").act_m15?(" + ptrExpr + ").act_m15.activityId:null}catch(e){return null}})()";
    const clickLoad = "(function(url){var u=document.getElementById('ci-url'),b=document.getElementById('ci-url-btn');if(u)u.value=url;if(b)b.click();return true})";

    await evaluate(cdp, "selectFriend('act_m15')");
    await evaluate(cdp, "IB.apps.open('cinema')");
    check('M15.cinemaOpen', await waitFor(cdp, "!!document.getElementById('ci-url')"));
    await evaluate(cdp, clickLoad + "('https://cdn.example.com/m15a.mp4')");
    check('M15.pointerSetOnOpen', await waitFor(cdp, ptrHas, 8000));
    const a1Id = await evaluate(cdp, ptrOf);
    const a1Shape = await evaluate(cdp, "IB.activity.getActivity(" + J(a1Id) + ").then(function(r){return r?r.roleId+'|'+String(r.threadId||''):null})");
    check('M15.pointerIsCinemaActivity', a1Shape === 'act_m15|', String(a1Shape));
    await evaluate(cdp, "IB.apps.close()");
    await new Promise(r => setTimeout(r, 120));
    check('M15.cinemaUnmountClearsSelf', await evaluate(cdp, "(function(){try{return !(" + ptrExpr + ").act_m15}catch(e){return false}})()"));

    /* A/B：unmount A 时 current=B 必须保持 */
    await evaluate(cdp, "IB.apps.open('cinema')");
    await waitFor(cdp, "!!document.getElementById('ci-url')");
    await evaluate(cdp, clickLoad + "('https://cdn.example.com/m15b.mp4')");
    check('M15.pointerSetOnOpenB', await waitFor(cdp, ptrHas, 8000));
    const bId15 = await evaluate(cdp, "IB.activity.createActivity({type:'coread',roleId:'act_m15',resourceId:'m15_b',resourceKey:'m15_b',title:'乙书',kind:'coread',progress:{page:1,total:1}}).then(function(a){return a.id})");
    await evaluate(cdp, "IB.activity.setCurrent(" + J(bId15) + ")");
    await evaluate(cdp, "IB.apps.close()");
    await new Promise(r => setTimeout(r, 120));
    const keepPtr = await evaluate(cdp, ptrOf);
    check('M15.unmountKeepsOtherCurrent', keepPtr === bId15, 'ptr=' + keepPtr + ' want=' + bId15);

    /* onTurn 通道过滤 + 超时 */
    await evaluate(cdp, "IB.apps.open('cinema')");
    await waitFor(cdp, "!!document.getElementById('ci-url')");
    await evaluate(cdp, clickLoad + "('https://cdn.example.com/m15b.mp4')");
    check('M15.ownActivityLoaded', await waitFor(cdp, "!document.getElementById('ci-typing')&&!!document.getElementById('ci-msgs')", 8000));
    await new Promise(r => setTimeout(r, 250));
    const a2Id = await evaluate(cdp, ptrOf);
    const a2Shape = await evaluate(cdp, "IB.activity.getActivity(" + J(a2Id) + ").then(function(r){return r?r.roleId+'|'+r.type:null})");
    check('M15.ownActivityForTurns', a2Shape === 'act_m15|cinema', String(a2Shape));
    const turnProbe = "(function(actId,state){IBApps.broadcast('turn',{state:state,friendId:'act_m15',threadId:null,activityId:actId});return !!document.getElementById('ci-typing')})";
    check('M15.plainTurnIgnored', (await evaluate(cdp, turnProbe + "(undefined,'start')")) === false);
    check('M15.otherActivityIgnored', (await evaluate(cdp, turnProbe + "('act_other_activity','start')")) === false);
    check('M15.ownTurnShowsTyping', (await evaluate(cdp, turnProbe + "(" + J(a2Id) + ",'start')")) === true);
    check('M15.ownTurnEndHidesTyping', (await evaluate(cdp, turnProbe + "(" + J(a2Id) + ",'end')")) === false);
    await evaluate(cdp, "window.__ciTypingTimeoutMs=120");
    check('M15.typingShownForTimeout', (await evaluate(cdp, turnProbe + "(" + J(a2Id) + ",'start')")) === true);
    check('M15.typingStaysSingle', (await evaluate(cdp, turnProbe + "(" + J(a2Id) + ",'start')")) === true && (await evaluate(cdp, "document.querySelectorAll('.ci-typing').length")) === 1, 'count=' + (await evaluate(cdp, "document.querySelectorAll('.ci-typing').length")));
    await new Promise(r => setTimeout(r, 400));
    check('M15.typingTimeoutClears', (await evaluate(cdp, "document.querySelectorAll('.ci-typing').length")) === 0, 'count=' + (await evaluate(cdp, "document.querySelectorAll('.ci-typing').length")));
    await evaluate(cdp, "window.__ciTypingTimeoutMs=0");

    /* grabFrame 异常防御：mock drawImage 抛 SecurityError */
    const gres = await evaluate(cdp, "(function(){try{var p=document.getElementById('ci-player');var v=p?p.querySelector('video'):null;if(!v){v=document.createElement('video');if(p)p.appendChild(v)}Object.defineProperty(v,'videoWidth',{value:640});Object.defineProperty(v,'videoHeight',{value:360});var errs=[];var onerr=function(e){errs.push(String((e&&e.message)||e))};window.addEventListener('error',onerr);var orig=CanvasRenderingContext2D.prototype.drawImage;var snap=document.getElementById('ci-snap');try{CanvasRenderingContext2D.prototype.drawImage=function(){throw new DOMException('Tainted canvases may not be exported.','SecurityError')};if(snap)snap.click();}finally{CanvasRenderingContext2D.prototype.drawImage=orig;window.removeEventListener('error',onerr)}var s2=document.getElementById('ci-snap');return JSON.stringify({frame:!!(s2&&s2.dataset&&s2.dataset.frame),toast:Array.prototype.map.call(document.querySelectorAll('#toast-stack .toast'),function(x){return x.textContent}).join('|'),errs:errs,snapOk:!!snap,dis:snap?!!snap.disabled:null,bodyHas:/无法截取画面/.test(document.body.innerText)})}catch(e){return JSON.stringify({err:String(e&&e.name||e)})}})()");
    const gm = JSON.parse(gres || '{}');
    check('M15.grabFrameNoThrow', !gm.err && !(gm.errs && gm.errs.length), gres);
    check('M15.grabFrameNoFrame', gm.frame === false, gres);
    check('M15.grabFrameFallbackToast', /无法截取画面/.test((gm.toast || '') + '|' + (gm.bodyHas ? '无法截取画面' : '')), String(gres).slice(0, 260));
    await evaluate(cdp, "IB.apps.close()");

    /* 留影端到端：真实按钮 click → grabFrame（成功）→ dataset frame → sendMsg → activity.send
       → sendChatMessage → provider image part。仅 mock 浏览器原语（drawImage/toDataURL），
       production 链路逐环真实；并验证帧仍未落库。 */
    await evaluate(cdp, "IB.apps.open('cinema')");
    await waitFor(cdp, "!!document.getElementById('ci-url')");
    await evaluate(cdp, clickLoad + "('https://cdn.example.com/m15e.mp4')");
    check('M15.e2eActivityReady', await waitFor(cdp, ptrHas, 8000));
    const e2eProbe = "(function(){var v=document.querySelector('#ci-player video');if(!v)return JSON.stringify({err:'no_video'});Object.defineProperty(v,'videoWidth',{value:640});Object.defineProperty(v,'videoHeight',{value:360});var od=CanvasRenderingContext2D.prototype.drawImage,ou=HTMLCanvasElement.prototype.toDataURL;var snap=document.getElementById('ci-snap');try{CanvasRenderingContext2D.prototype.drawImage=function(){};HTMLCanvasElement.prototype.toDataURL=function(){return 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='};snap.click()}finally{CanvasRenderingContext2D.prototype.drawImage=od;HTMLCanvasElement.prototype.toDataURL=ou}return JSON.stringify({frame:!!(snap.dataset&&snap.dataset.frame),disabled:!!snap.disabled})})()";
    const e2eShot = JSON.parse(await evaluate(cdp, e2eProbe) || '{}');
    check('M15.shotCapturedByButton', e2eShot.frame === true && e2eShot.disabled === false, JSON.stringify(e2eShot));
    mock.captured.vision = false; mock.captured.lastBody = '';
    await evaluate(cdp, "(function(){document.getElementById('ci-input').value='这张画面你看到了吗？';document.getElementById('ci-send').click()})()");
    check('M15.shotReachesProvider', await waitNode(() => mock.captured.vision === true, 15000), 'vision=' + mock.captured.vision + ' tail=' + mock.captured.lastBody.slice(-160));
    const e2eStore = await evaluate(cdp, "(async function(){var all=await dbGetAll('chatMessages');var u=null;all.forEach(function(m){if(m.role==='user'&&m.content==='这张画面你看到了吗？')u=m});return JSON.stringify({has:!!u,imgs:(u&&u.images&&u.images.length)||0})})()");
    check('M15.shotNotPersisted', (function(){var s=JSON.parse(e2eStore || '{}');return s.has === true && s.imgs === 0})(), String(e2eStore));
    await evaluate(cdp, "IB.apps.close()");

    /* 多角色隔离：act_m15 的 unmount 不得影响 act_rb 的 current */
    const rbId = await evaluate(cdp, "IB.activity.createActivity({type:'cinema',roleId:'act_rb',resourceId:'rb_1',resourceKey:'rb_1',title:'RB片',kind:'cinema',progress:{sec:0}}).then(function(a){return IB.activity.setCurrent(a.id).then(function(){return a.id})})");
    await evaluate(cdp, "IB.apps.open('cinema')");
    await waitFor(cdp, "!!document.getElementById('ci-url')");
    await evaluate(cdp, clickLoad + "('https://cdn.example.com/m15r.mp4')");
    check('M15.multiRoleSetup', await waitFor(cdp, ptrHas, 8000));
    await evaluate(cdp, "IB.apps.close()");
    await new Promise(r => setTimeout(r, 120));
    const rbPtr = await evaluate(cdp, "(function(){try{return JSON.parse(localStorage.getItem('ib_activity_current_v1')||'{}')['act_rb'].activityId}catch(e){return null}})()");
    check('M15.multiRoleIsolation', rbPtr === rbId, 'rb=' + rbPtr + ' want=' + rbId);

    /* Coread 返回书架：仅清自身 current（角色按"当前指针里属于 post_1 的 coread 活动"定位） */
    await evaluate(cdp, "coreadOpen('post_1')");
    await waitFor(cdp, "(function(){var rd=document.getElementById('coread-read-view');return !!rd&&rd.style.display==='block'})()");
    const crRole = await evaluate(cdp, "(async function(){try{var all=JSON.parse(localStorage.getItem('ib_activity_current_v1')||'{}');var keys=Object.keys(all);for(var i=0;i<keys.length;i++){var r=await IB.activity.getActivity(all[keys[i]].activityId);if(r&&r.type==='coread'&&String(r.resourceId)==='post_1')return keys[i]}return null}catch(e){return null}})()");
    check('M15.coreadSetsCurrent', !!crRole, String(crRole));
    await evaluate(cdp, "coreadPaintshelf()");
    await new Promise(r => setTimeout(r, 120));
    const crAfter = JSON.parse(await evaluate(cdp, "localStorage.getItem('ib_activity_current_v1')||'{}'"));
    check('M15.coreadLeaveClearsSelf', !!crRole && !crAfter[crRole], JSON.stringify(crAfter));

    /* A/B：进共读（A=coread activity）→ setCurrent(B) → 返回书架，B 必须保持 */
    await evaluate(cdp, "coreadOpen('post_1')");
    await waitFor(cdp, "(function(){var rd=document.getElementById('coread-read-view');return !!rd&&rd.style.display==='block'})()");
    const crKeep = await evaluate(cdp, "IB.activity.createActivity({type:'cinema',roleId:" + J(crRole) + ",resourceId:'m15_c',resourceKey:'m15_c',title:'丙片',kind:'cinema',progress:{sec:0}}).then(function(a){return IB.activity.setCurrent(a.id).then(function(){return a.id})})");
    await evaluate(cdp, "coreadPaintshelf()");
    await new Promise(r => setTimeout(r, 120));
    const crKeepAfter = await evaluate(cdp, "(function(){try{return JSON.parse(localStorage.getItem('ib_activity_current_v1')||'{}')[" + J(crRole) + "].activityId}catch(e){return null}})()");
    check('M15.coreadLeaveKeepsOther', crKeepAfter === crKeep, 'ptr=' + crKeepAfter + ' want=' + crKeep);

    await new Promise(r => setTimeout(r, 300));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.join('\n').slice(0, 500));

    console.log(failures ? '\nActivity/Favorites/AppStore smoke failed: ' + failures : '\nActivity/Favorites/AppStore smoke passed ✔');
  } finally {
    if (cdp) cdp.close(); try { browser.kill(); } catch (e) {}
    try { mock.server.close(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  if (failures) process.exitCode = 1;
}
main();
