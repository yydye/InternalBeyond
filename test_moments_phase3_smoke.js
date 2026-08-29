'use strict';

/* Moments 第三阶段：长期运行审计浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   覆盖：
   - Scheduler：tick 不重复发布 / nextAt 前进 / 最短间隔冷却 / 失败退避恢复 /
     多标签 claimUntil 互斥 / stale claim 自愈 / nextAt 脏数据自愈
   - Content：publish:false 正常路径 / 重复内容被拒（只产出一条）/ Prompt 反空泛模板
   - 社交自然度：角色对亲和度稳定且分化（有人常互动、有人潜水）、点赞点名随动态变化
   - Privacy：private 不进聊天上下文 / 不被点赞 / 不被评论 / companion 快照不含他人私密
   - Storage：游标有界扫描 / 聊天注入长度上限 / commentq 裁剪 / Export→Import 不产生重复 ID
   - 运行时零异常 */
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 20000);
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
    if (payload.length >= 126) { header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt32BE(payload.length, 2); }
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
  let chatHits = 0;
  const hitBy = {};
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        chatHits += 1;
        let model = '';
        try { model = String(JSON.parse(body || '{}').model || ''); } catch (error) { /* ignore */ }
        hitBy[model] = (hitBy[model] || 0) + 1;
        let content;
        if (model === 'p3-dec') content = JSON.stringify({ publish: false, reason: '今天没有值得分享的事' });
        else if (model === 'p3-dup') content = JSON.stringify({ publish: true, content: '重复内容测试。', visibility: 'all' });
        else if (model === 'p3-rsn') content = '';/* 推理型模型：maxTokens 全部耗在 reasoning 上，content 为空 */
        else if (model === 'p3-rsnok') content = hitBy[model] === 1 ? '' : JSON.stringify({ publish: true, content: '推理后终于想好了。', visibility: 'all' });
        else if (model === 'p3-mot') content = JSON.stringify({ publish: true, content: hitBy[model] === 1 ? '用户刚才说想去看海，我也有点想去。' : '门口的猫今天蹲了一整天，不知道在想什么。', visibility: 'all', motive: 'interaction' });
        else if (model === 'p3-decmot') content = JSON.stringify({ publish: false, reason: '今天确实没什么好发的', motive: 'none' });
        else if (model === 'p3-dup2') content = JSON.stringify({ publish: true, content: '重复内容测试。', visibility: 'all', motive: 'reflection' });
        else content = JSON.stringify({ publish: true, content: 'p3 动态内容 ' + chatHits + '。', visibility: 'all' });
        const usage = (model === 'p3-rsn' || (model === 'p3-rsnok' && hitBy[model] === 1))
          ? { completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 900 } }
          : { completion_tokens: 120 };
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage }));
      });
      return;
    }
    res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits: () => chatHits, hitsBy: () => hitBy })));
}

/* 与 moments.js 相同的纯函数（用于在 Node 侧预校准断言阈值） */
function h31(s) { let x = 7; const t = String(s || ''); for (let i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) >>> 0; return x; }

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const mock = await startMockApi();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-moments-p3-'));
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
    check('page.ready', await waitFor(cdp, "window.IB&&IB.moments&&typeof _momentsLocalTick==='function'&&typeof _momentsPairAffinity==='function'&&typeof _momentsScanDesc==='function'", 20000));
    check('dual.p3', await evaluate(cdp, "typeof _momentsLocalTick==='function'&&typeof IB.moments._momentsLocalTick==='function'&&typeof IB.moments._momentsPairAffinity==='function'"));
    await evaluate(cdp, "(function(){Object.defineProperty(window,'_activeCompanionOnline',{value:false,writable:true,configurable:true});return true})()");
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false,aiLike:false,frequency:'medium'})");

    const cfg = (id, model, endpoint, extra) => "{id:'" + id + "',provider:'openai',model:'" + model + "',endpoint:'" + endpoint + "',apiKey:'',nickname:'" + id + "',systemPrompt:'你是测试角色'" + (extra || '') + "}";
    const EP = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs'," + cfg('p3a','p3-ok',EP) + ");await dbPut('apiConfigs'," + cfg('p3b','p3-ok',EP) + ");await dbPut('apiConfigs'," + cfg('p3dec','p3-dec',EP) + ");await dbPut('apiConfigs'," + cfg('p3dup','p3-dup',EP) + ");await dbPut('apiConfigs'," + cfg('p3bad','p3-ok','http://127.0.0.1:1/v1/chat/completions') + ");await dbPut('apiConfigs'," + cfg('p3rsn','p3-rsn',EP) + ");await dbPut('apiConfigs'," + cfg('p3rsnok','p3-rsnok',EP) + ");await dbPut('apiConfigs'," + cfg('p3mot','p3-mot',EP) + ");await dbPut('apiConfigs'," + cfg('p3decmot','p3-decmot',EP) + ");await dbPut('apiConfigs'," + cfg('p3dup2','p3-dup2',EP) + ");await loadApiConfigs();})()");
    await evaluate(cdp, "window.__ibP3={set:function(id,patch){var s=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}');s[id]=Object.assign({},s[id]||{},patch);localStorage.setItem('ib_moments_state_v1',JSON.stringify(s));return true},reset:function(){localStorage.removeItem('ib_moments_state_v1');localStorage.removeItem('ib_moments_commentq_v1');localStorage.removeItem('ib_moments_likes_v1');return true},solo:function(id,due){var now=Date.now(),s={},ids=['p3a','p3b','p3dec','p3dup','p3bad'];ids.forEach(function(k){s[k]={nextAt:now+86400000,status:'idle',claimUntil:0,lastPostAt:0}});if(id)s[id]={nextAt:due?now-1000:now+86400000,status:'idle',claimUntil:0,lastPostAt:0};localStorage.setItem('ib_moments_state_v1',JSON.stringify(s));return true}}");

    /* ── Scheduler ── */
    await evaluate(cdp, "__ibP3.solo('p3a',true)");
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    const sched1 = await evaluate(cdp, "(async function(){var own=await getRoleMoments('p3a');var st=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3a||{};return{count:own.filter(function(m){return m.source==='proactive'}).length,nextAt:(st.nextAt||0)-Date.now(),claim:st.claimUntil||0}})()");
    check('sched.publishOnce', sched1 && sched1.count === 1 && sched1.nextAt > 60000 && sched1.claim === 0, JSON.stringify(sched1));
    const hitsAfterFirst = mock.hits();
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    const sched2 = await evaluate(cdp, "(async function(){return (await getRoleMoments('p3a')).filter(function(m){return m.source==='proactive'}).length})()");
    check('sched.tickNoDuplicate', sched2 === 1 && mock.hits() === hitsAfterFirst, 'count=' + sched2 + ' hits=' + mock.hits() + '/' + hitsAfterFirst);

    /* 最短间隔：刚发过（10 分钟前）→ 到期也不发，顺延 30-60min */
    await evaluate(cdp, "__ibP3.solo('p3a',true);__ibP3.set('p3a',{lastPostAt:Date.now()-10*60000})");
    const hitsBeforeCool = mock.hits();
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    const cool = await evaluate(cdp, "(function(){var st=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3a||{};var d=(st.nextAt||0)-Date.now();return{delayMin:d/60000}})()");
    check('sched.minIntervalReschedule', cool && cool.delayMin >= 29 && cool.delayMin <= 61 && mock.hits() === hitsBeforeCool, JSON.stringify(cool));

    /* 失败退避：endpoint 不可达 → 不抛异常、nextAt 顺延（非永久停止/紧密重试） */
    await evaluate(cdp, "__ibP3.reset();__ibP3.solo('p3bad',true)");
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    const backoff = await evaluate(cdp, "(function(){var st=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3bad||{};return{delayMin:((st.nextAt||0)-Date.now())/60000,claim:st.claimUntil||0}})()");
    check('sched.failureBackoff', backoff && backoff.delayMin > 60 && backoff.claim === 0, JSON.stringify(backoff));
    const hitsBeforeRetry = mock.hits();
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    check('sched.failureNoTightRetry', mock.hits() === hitsBeforeRetry);

    /* 多标签互斥：claimUntil 未过期 → 跳过；stale claim → 正常接管 */
    await evaluate(cdp, "__ibP3.reset();__ibP3.solo('p3dup',true);__ibP3.set('p3dup',{claimUntil:Date.now()+60000})");
    const hitsBeforeClaim = mock.hits();
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    const claimed = await evaluate(cdp, "(function(){var st=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3dup||{};return{claimKept:(st.claimUntil||0)>Date.now()}})()");
    check('sched.multiTabLock', claimed && claimed.claimKept === true && mock.hits() === hitsBeforeClaim, JSON.stringify(claimed));
    await evaluate(cdp, "__ibP3.set('p3dup',{claimUntil:Date.now()-1000})");
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    check('sched.staleClaimHeals', mock.hits() === hitsBeforeClaim + 1);

    /* nextAt 脏数据自愈：NaN/垃圾值 → 重置为有限未来值，不执行不崩溃 */
    await evaluate(cdp, "__ibP3.reset();__ibP3.solo('p3a',false);__ibP3.set('p3a',{nextAt:'garbage'})");
    await evaluate(cdp, "_momentsLocalTick(Date.now())");
    const healed = await evaluate(cdp, "(function(){var st=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3a||{};return{finite:isFinite(st.nextAt)&&st.nextAt>Date.now()}})()");
    check('sched.nanNextAtSelfHeal', healed && healed.finite === true, JSON.stringify(healed));

    /* ── Content ── */
    await evaluate(cdp, "__ibP3.reset()");
    const dec = await evaluate(cdp, "generateRoleMoment('p3dec',{trigger:'manual'})");
    const decCount = await evaluate(cdp, "(async function(){return (await getRoleMoments('p3dec')).length})()");
    check('content.publishFalseNormal', dec && dec.ok === true && dec.published === false && decCount === 0, JSON.stringify(dec));
    /* 清理调度段可能留下的同名内容（IndexedDB 不随 localStorage 重置），保证从零开始 */
    await evaluate(cdp, "(async function(){var own=await getRoleMoments('p3dup');for(var i=0;i<own.length;i++)await dbDelete(MOMENT_STORE,own[i].id);return true})()");
    const d1 = await evaluate(cdp, "generateRoleMoment('p3dup',{trigger:'manual'})");
    const d2 = await evaluate(cdp, "generateRoleMoment('p3dup',{trigger:'manual'})");
    const dupCount = await evaluate(cdp, "(async function(){var own=await getRoleMoments('p3dup');return own.filter(function(m){return m.content==='重复内容测试。'}).length})()");
    check('content.duplicateRejected', d1 && d1.ok && d1.published === true && d2 && d2.ok === false && dupCount === 1, JSON.stringify({ d1ok: d1 && d1.ok, d2ok: d2 && d2.ok, dupCount }));
    const promptTxt = await evaluate(cdp, "buildMomentPrompt({character:{id:'x',nickname:'N',systemPrompt:''},context:{},trigger:'schedule'}).messages[1].content");
    check('content.promptAntiGeneric', /拒绝空泛模板/.test(promptTxt) && /今天阳光很好/.test(promptTxt) && /publish:false 是正常输出/.test(promptTxt) && /碎片化/.test(promptTxt));

    /* ── Motive 动机层（Case A–E,G：schema/落库/declineStreak/护栏不被绕过/无内部机制词） ── */
    /* Case E：解析与落库——publish:true + motive:'interaction' → 正文落库并携带 motive */
    await evaluate(cdp, "__ibP3.reset()");
    const mot = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p3mot',{trigger:'manual'});var m=await getMoment(r.moment&&r.moment.id);return{ok:r.ok,published:r.published,motive:r.motive,stored:m&&m.motive,content:m&&m.content}})()");
    check('motive.publishCarries', mot && mot.ok === true && mot.published === true && mot.motive === 'interaction' && mot.stored === 'interaction' && mot.content.indexOf('想去看海') >= 0, JSON.stringify(mot));
    /* Case B：无动机 → publish:false + motive:'none' 是正常结果；declineStreak +1 */
    const decm = await evaluate(cdp, "(async function(){var st0=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3decmot||{};var r=await generateRoleMoment('p3decmot',{trigger:'manual'});var st=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3decmot||{};return{ok:r.ok,published:r.published,motive:r.motive,streak:st.declineStreak||0,count:(await getRoleMoments('p3decmot')).length}})()");
    check('motive.declineNone', decm && decm.ok === true && decm.published === false && decm.motive === 'none' && decm.streak === 1 && decm.count === 0, JSON.stringify(decm));
    /* Case D：连续 declined 不强制发布——再次不发布，无动态，仅 streak 增长 */
    await evaluate(cdp, "(function(){var s=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}');s.p3decmot=Object.assign({},s.p3decmot||{},{declineStreak:1});localStorage.setItem('ib_moments_state_v1',JSON.stringify(s));return true})()");
    const decm2 = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p3decmot',{trigger:'manual'});var st=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3decmot||{};return{published:r.published,motive:r.motive,streak:st.declineStreak||0,count:(await getRoleMoments('p3decmot')).length}})()");
    check('motive.declineNoForce', decm2 && decm2.published === false && decm2.motive === 'none' && decm2.streak === 2 && decm2.count === 0, JSON.stringify(decm2));
    /* Case A/D 续：发布成功 → streak 归零 */
    const motReset = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p3mot',{trigger:'manual'});var st=JSON.parse(localStorage.getItem('ib_moments_state_v1')||'{}').p3mot||{};return{published:r.published,streak:Number(st.declineStreak||0)}})()");
    check('motive.publishResetsStreak', motReset && motReset.published === true && motReset.streak === 0, JSON.stringify(motReset));
    /* Case C：motive 不绕过去重——同内容二次（带 motive 也一样被拒，只产出一条） */
    await evaluate(cdp, "(async function(){var own=await getRoleMoments('p3dup2');for(var i=0;i<own.length;i++)await dbDelete(MOMENT_STORE,own[i].id);return true})()");
    const mDup = await evaluate(cdp, "(async function(){var a=await generateRoleMoment('p3dup2',{trigger:'manual'});var b=await generateRoleMoment('p3dup2',{trigger:'manual'});var own=await getRoleMoments('p3dup2');return{a:a.published,b:!!(b&&b.ok===false&&/相似/.test(b.error||'')),n:own.length}})()");
    check('motive.dedupeNotBypassed', mDup && mDup.a === true && mDup.b === true && mDup.n === 1, JSON.stringify(mDup));
    /* Case F 前置：prompt 带动机段与 declineStreak 上下文；Case G：无内部机制词
       （imagePrompt 是模型要填写的 JSON 字段名，属协议键，不算内部机制泄漏） */
    const motPrompt = await evaluate(cdp, "(function(){var b=buildMomentPrompt({character:{id:'x',nickname:'N',systemPrompt:''},context:{},trigger:'schedule',declineStreak:3,lastPostAt:Date.now()-3*3600000});return{u:b.messages[1].content,s:b.messages[0].content}})()");
    check('motive.promptHasMotiveSection', /发圈动机/.test(motPrompt.u) && /\{"publish":false,"motive":"none"\}/.test(motPrompt.u) && /"motive":"share\|daily_life\|emotion\|reflection\|interaction\|curiosity\|social_response\|none"/.test(motPrompt.u) && /最近连续 3 次你都没有发/.test(motPrompt.u) && /3 小时前/.test(motPrompt.u), motPrompt.u.slice(-260));
    check('motive.noInternalMechanismWords', !/任务|定时|调度|API|模型|prompt|scheduler|timer|task|cron|autonomous|token/i.test((motPrompt.u + '\n' + motPrompt.s).replace(/imagePrompt/g, '')), (motPrompt.s + '\n' + motPrompt.u).slice(0, 400));
    /* Case G：发布正文不含内部机制词（mock 内容本身即验证用例） */
    check('motive.publishedContentClean', mot && mot.published === true && !/定时|任务|调度|AI 自主发文|系统|Prompt|API|模型/.test(String(mot.content || '')), String(mot.content || '').slice(0, 120));

    /* ── 社交自然度（亲和度） ── */
    const aff = await evaluate(cdp, "({a:_momentsPairAffinity('r1','r2'),b:_momentsPairAffinity('r1','r2'),c:_momentsPairAffinity('r2','r1')})");
    check('aff.stableRange', aff && aff.a === aff.b && aff.a >= 40 && aff.a <= 95 && aff.c >= 40 && aff.c <= 95, JSON.stringify(aff));
    const dist = await evaluate(cdp, "(function(){var cands=['c1','c2','c3','c4','c5','c6'],tally={},mid;for(var m=0;m<24;m++){mid='mom_dist_'+m;var cs=cands.map(function(c){return{c:c,r:(function(s){var x=7,i;for(i=0;i<s.length;i++)x=(x*31+s.charCodeAt(i))>>>0;return x})(mid+'\\u0002'+c)%100}}).filter(function(x){return x.r<_momentsPairAffinity(x.c,'authX')}).sort(function(a,b){return a.r-b.r}).map(function(x){return x.c});var hv=(function(s){var x=7,i;for(i=0;i<s.length;i++)x=(x*31+s.charCodeAt(i))>>>0;return x})(mid);var n=Math.min((hv%10)<6?1:(hv%10)<9?2:0,cs.length);for(var k=0;k<n;k++)tally[cs[k]]=(tally[cs[k]]||0)+1}var vs=Object.keys(tally).map(function(k){return tally[k]});return{tally:tally,max:Math.max.apply(null,vs),min:Math.min.apply(null,vs.concat([0]))}})()");
    check('aff.differentiates', dist && dist.max - dist.min >= 5 && dist.max >= 6 && dist.min <= 1, JSON.stringify(dist));
    /* 点赞点名随动态变化：不同动态得到不同点赞者组合 */
    await evaluate(cdp, "_momentsPrefsSave({aiLike:true});localStorage.removeItem('ib_moments_likes_v1')");
    const bySets = await evaluate(cdp, "(async function(){var ids=[];for(var i=0;i<6;i++){var r=await createMoment({roleId:'p3b',content:'点赞点名样本 '+i+'。',source:'manual',visibility:'all'});ids.push(r.moment.id)}var sets=[];for(var j=0;j<ids.length;j++){localStorage.removeItem('ib_moments_likes_v1');var r2=await _momentsApplyLikes(ids[j],{});sets.push((r2.by||[]).join(','))}_momentsPrefsSave({aiLike:false});return sets})()");
    const distinctSets = Array.isArray(bySets) ? new Set(bySets).size : 0;
    check('like.pickVariesByMoment', distinctSets >= 2, JSON.stringify(bySets));
    await evaluate(cdp, "localStorage.removeItem('ib_moments_likes_v1');__ibP3.reset()");

    /* ── Privacy ── */
    const privIds = await evaluate(cdp, "(async function(){var p=await createMoment({roleId:'p3a',content:'P3隐私内容XYZQ。',visibility:'private',source:'manual'});var pub=await createMoment({roleId:'p3a',content:'P3公开内容ABCQ。',visibility:'all',source:'manual'});return{priv:p.moment.id,pub:pub.moment.id}})()");
    const ctxOwn = await evaluate(cdp, "getMomentsContext('p3a')");
    check('privacy.ctxOwnExcludesPrivate', typeof ctxOwn === 'string' && ctxOwn.indexOf('P3公开内容ABCQ') >= 0 && ctxOwn.indexOf('P3隐私内容XYZQ') < 0);
    const ctxOther = await evaluate(cdp, "getMomentsContext('p3b')");
    check('privacy.ctxOtherExcludesPrivate', typeof ctxOther === 'string' && ctxOther.indexOf('P3隐私内容XYZQ') < 0);
    const likePriv = await evaluate(cdp, "(function(){return{priv:_momentsLikeEligible({roleId:'p3a',visibility:'private',likes:[]},'p3b'),user:_momentsLikeEligible({roleId:'p3a',visibility:'user',likes:[]},'p3b')}})()");
    check('privacy.likeIneligible', likePriv && likePriv.priv === false && likePriv.user === false, JSON.stringify(likePriv));
    await evaluate(cdp, "_momentsPrefsSave({aiComment:true})");
    const hitsBeforeComment = mock.hits();
    const cmt = await evaluate(cdp, "generateRoleComment('p3b','" + privIds.priv + "')");
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false})");
    check('privacy.commentRejected', cmt && cmt.ok === false && cmt.error === '不可见' && mock.hits() === hitsBeforeComment, JSON.stringify(cmt));
    const snapClean = await evaluate(cdp, "(async function(){var cb=apiConfigs.find(function(a){return a.id==='p3b'});var s=await _momentsCompanionSnapshot(cb);var bad=(s.other_role_moments||[]).some(function(m){return m.visibility!=='all'||String(m.content||'').indexOf('XYZQ')>=0});return{bad:bad,n:(s.other_role_moments||[]).length}})()");
    check('privacy.companionSnapshotOthersClean', snapClean && snapClean.bad === false, JSON.stringify(snapClean));

    /* ── Storage（长期运行） ── */
    const junk = await evaluate(cdp, "(async function(){var base=Date.now();for(var i=0;i<120;i++){await dbPut(MOMENT_STORE,{id:'mom_junk_'+i,roleId:'junk',content:'历史堆积 '+i,images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date(base-i*1000).toISOString()})}return true})()");
    check('storage.junkSeeded', junk === true);
    const scan = await evaluate(cdp, "(async function(){var total=(await dbGetAll(MOMENT_STORE)).length;var a=await _momentsScanDesc(50);var b=await _momentsScanDesc(500);var sorted=true;for(var i=1;i<a.length;i++){if(String(a[i-1].createdAt)<String(a[i].createdAt))sorted=false}return{total:total,n50:a.length,n500:b.length,sortedDesc:sorted}})()");
    check('storage.scanBounded', scan && scan.n50 === 50 && scan.n500 === Math.min(500, scan.total) && scan.sortedDesc === true && scan.total >= 120, JSON.stringify(scan));
    const ctxLen = await evaluate(cdp, "(async function(){var c=await getMomentsContext('p3a');return c.length})()");
    check('storage.chatCtxCapped', typeof ctxLen === 'number' && ctxLen > 0 && ctxLen <= 900, String(ctxLen));
    const pruned = await evaluate(cdp, "(function(){var now=Date.now();localStorage.setItem('ib_moments_commentq_v1',JSON.stringify({old_key:now-49*3600000,fresh_key:now-60000}));_momentsSetCommentQ('new_key');var q=JSON.parse(localStorage.getItem('ib_moments_commentq_v1')||'{}');return{oldGone:!('old_key'in q),freshKept:'fresh_key'in q,newAdded:'new_key'in q,size:Object.keys(q).length}})()");
    check('storage.commentqPruned', pruned && pruned.oldGone && pruned.freshKept && pruned.newAdded, JSON.stringify(pruned));
    const roundtrip = await evaluate(cdp, "(async function(){var before=await dbGetAll(MOMENT_STORE);var exp=await _ibBuildExportData();if(!Array.isArray(exp.moments)||exp.moments.length!==before.length)return{ok:false,re:'export mismatch'};for(var i=0;i<exp.moments.length;i++)await dbPut('moments',exp.moments[i]);var after=await dbGetAll(MOMENT_STORE);var ids={};var dupe=false;after.forEach(function(m){if(ids[m.id])dupe=true;ids[m.id]=1});return{ok:true,before:before.length,after:after.length,noDupe:!dupe}})()");
    const privKept = await evaluate(cdp, "(async function(){var m=await getMoment('" + privIds.priv + "');return !!m&&m.visibility==='private'&&m.content==='P3隐私内容XYZQ。'})()");
    check('storage.exportImportIdempotent', roundtrip && roundtrip.ok && roundtrip.before === roundtrip.after && roundtrip.noDupe && privKept === true, JSON.stringify(roundtrip) + ' priv=' + privKept);

    /* ── Companion 同步契约（能力预检 / 旧版服务不连发 404 / 升级自动恢复） ── */
    await evaluate(cdp, "(function(){window.__ibReq=[];window.__ibCaps={ok:true,moments:0};window.__ibFailPut=false;window.__ibOrigReq=window._activeCompanionRequest;window._activeCompanionRequest=async function(p,o){window.__ibReq.push((o&&o.method||'GET')+' '+p);if(p==='/health')return window.__ibCaps;if(p.indexOf('/moments/')===0){if(window.__ibFailPut)throw new Error('后台服务 404');return{ok:true}}if(p==='/reconcile')return{ok:true};return{}};Object.defineProperty(window,'_activeCompanionOnline',{value:true,writable:true,configurable:true});__ibP3.solo('p3a',false);__ibP3.solo('p3b',false);return true})()");
    const syncOk = await evaluate(cdp, "_momentsSyncCompanion()");
    const reqStats = await evaluate(cdp, "(function(){var q=window.__ibReq;return{puts:q.filter(function(x){return x.indexOf('PUT /moments/')===0}).length,healths:q.filter(function(x){return x==='GET /health'}).length,reconciles:q.filter(function(x){return x==='POST /reconcile'}).length}})()");
    check('sync.capabilityOkPuts', syncOk === true && reqStats.puts >= 1 && reqStats.healths === 1 && reqStats.reconciles === 1, JSON.stringify({ syncOk, reqStats }));
    /* 旧版 companion（/health 无 moments 字段）：零 PUT，回退本地；窗口内不再探测 */
    await evaluate(cdp, "(function(){window.__ibReq=[];window.__ibCaps={ok:true};_momentsResetSyncForTest();return true})()");
    const legacy = await evaluate(cdp, "_momentsSyncCompanion()");
    const legacyAgain = await evaluate(cdp, "(async function(){var n=window.__ibReq.length;await _momentsSyncCompanion();return window.__ibReq.length-n})()");
    check('sync.legacyZeroPut', legacy === false && legacyAgain === 0 && (await evaluate(cdp, "(function(){return window.__ibReq.filter(function(x){return x.indexOf('PUT /moments/')===0}).length})()")) === 0, JSON.stringify({ legacy, legacyAgain }));
    /* companion 升级（health 带 moments）→ 自动恢复后台同步 */
    await evaluate(cdp, "(function(){window.__ibReq=[];window.__ibCaps={ok:true,moments:2};_momentsResetSyncForTest();return true})()");
    const recovered = await evaluate(cdp, "(async function(){var r=await _momentsSyncCompanion();return{r:r,puts:window.__ibReq.filter(function(x){return x.indexOf('PUT /moments/')===0}).length}})()");
    check('sync.recoversAfterUpgrade', recovered && recovered.r === true && recovered.puts >= 1, JSON.stringify(recovered));
    /* 单角色 PUT 404 → 立即中断本轮（不对其余角色连发），进入回退窗口 */
    await evaluate(cdp, "(function(){window.__ibReq=[];window.__ibFailPut=true;_momentsResetSyncForTest();return true})()");
    const burst = await evaluate(cdp, "(async function(){var r=await _momentsSyncCompanion();return{r:r,attempts:window.__ibReq.filter(function(x){return x.indexOf('PUT /moments/')===0}).length}})()");
    check('sync.burstCutOn404', burst && burst.r === false && burst.attempts === 1, JSON.stringify(burst));
    await evaluate(cdp, "(function(){window._activeCompanionRequest=window.__ibOrigReq;Object.defineProperty(window,'_activeCompanionOnline',{value:false,writable:true,configurable:true});_momentsResetSyncForTest();return true})()");

    /* ── 输出解析矩阵（定位 unparseable：A 合法 / B 围栏 / 前后杂文 / publish:false / 畸形 / 空 / null / schema） ── */
    const pmtx = await evaluate(cdp, "(function(){var P=_momentsParseOutput,D=_momentsDiagnoseOutput;var okJson=JSON.stringify({publish:true,content:'今天出去走了走。'});return{"+
      "valid:!!P(okJson)&&P(okJson).publish===true&&P(okJson).content==='今天出去走了走。',"+
      "fenced:(function(){var r=P('```json\\n'+okJson+'\\n```');return !!r&&r.publish===true})(),"+
      "surrounded:(function(){var r=P('好的，我来发一条：\\n'+okJson+'\\n以上。');return !!r&&r.publish===true})(),"+
      "decline:(function(){var r=P(JSON.stringify({publish:false,reason:'没什么想说的'}));return !!r&&r.publish===false&&r.reason==='没什么想说的'})(),"+
      "malformed:P('{\"publish\":true,\"content\":\"截断')===null,"+
      "empty:P('')===null&&P('   ')===null,"+
      "nullInput:P(null)===null&&P(undefined)===null,"+
      "publishStringType:P('{\"publish\":\"true\",\"content\":\"x\"}')===null,"+
      "noContent:P('{\"publish\":true,\"content\":\"\"}')===null"+
    "}})()");
    check('parse.validJson', pmtx && pmtx.valid === true, JSON.stringify(pmtx));
    check('parse.markdownFence', pmtx && pmtx.fenced === true);
    check('parse.textSurrounded', pmtx && pmtx.surrounded === true);
    check('parse.publishFalse', pmtx && pmtx.decline === true);
    check('parse.malformedNull', pmtx && pmtx.malformed === true && pmtx.empty === true && pmtx.nullInput === true);
    check('parse.schemaStrict', pmtx && pmtx.publishStringType === true && pmtx.noContent === true);
    const diag = await evaluate(cdp, "(function(){var D=_momentsDiagnoseOutput;return{empty:D('').stage,nl:D('今天出去走了走，天气还不错。').stage,trunc:D('{\"publish\":true,\"con').stage,strType:D('{\"publish\":\"true\",\"content\":\"x\"}').stage,type:D(123).outType}})()");
    check('diag.classification', diag && diag.empty === 'empty-output' && diag.nl === 'no-json-object' && diag.trunc === 'json-parse-failed' && diag.strType === 'schema-publish-not-boolean' && diag.type === 'number', JSON.stringify(diag));

    /* ── 复现：reasoning 吃满 maxTokens → empty-output；自适应提额重试可救回 ── */
    const warns = []; cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'warning') { try { warns.push((p.args || []).map(a => a.value != null ? String(a.value) : (a.description || '')).join(' ')); } catch (e) {} } });
    const rsnAlways = await evaluate(cdp, "(async function(){__ibP3.reset();var r=await generateRoleMoment('p3rsn',{trigger:'manual'});return{ok:r.ok,err:r.error}})()");
    const rsnWarns = warns.filter(w => w.indexOf('[Moments] output unparseable') >= 0);
    check('rsn.reproducedEmptyOutput', rsnAlways && rsnAlways.ok === false && /无法解析/.test(rsnAlways.err || ''), JSON.stringify(rsnAlways));
    check('rsn.diagStageEmptyOutput', rsnWarns.length >= 2 && rsnWarns.every(w => w.indexOf('"stage":"empty-output"') >= 0), rsnWarns.join(' | ').slice(0, 300));
    /* 自适应：首次空输出 → 提高生成预算重试 → 推理型模型第二次成功发布 */
    warns.length = 0;
    const rsnOk = await evaluate(cdp, "(async function(){var r=await generateRoleMoment('p3rsnok',{trigger:'manual'});return{ok:r.ok,published:r.published,content:r.moment&&r.moment.content}})()");
    /* console 事件经 CDP 异步送达：固定等待不够稳，改为轮询等 warn 事件（最多 4s） */
    let retryLine = false;
    for (let _w = 0; _w < 40; _w++) { if (warns.some(w => w.indexOf('(retrying)') >= 0 && w.indexOf('"stage":"empty-output"') >= 0)) { retryLine = true; break; } await new Promise(r => setTimeout(r, 100)); }
    check('rsn.adaptiveRetryPublishes', rsnOk && rsnOk.ok === true && rsnOk.published === true && rsnOk.content === '推理后终于想好了。' && retryLine === true, JSON.stringify({ rsnOk, retryLine }));

    await new Promise(r => setTimeout(r, 300));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.join('\n').slice(0, 500));
    console.log(failures ? '\nMoments Phase3 smoke failed: ' + failures : '\nMoments Phase3 smoke test passed ✔');
  } finally {
    if (cdp) cdp.close(); try { browser.kill(); } catch (error) {}
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) {}
  }
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
