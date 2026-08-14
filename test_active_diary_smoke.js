'use strict';

/* Active Plans + Diary 浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   在拆分 active-diary.js 前锁定浏览器端计划持久化/UI、用户回复取消、
   Diary 解析/生成/去重/渲染/删除、window 与 IB 双挂载及运行时异常。 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;

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
