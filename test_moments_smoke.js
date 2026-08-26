'use strict';

/* Moments（AI 朋友圈）浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   覆盖：数据 CRUD / 点赞 / 评论 / 删除 / 可见性 / AI 自主生成（发布+不发布）/
   去重 / AI 评论（含"已评论过"防循环）/ 聊天上下文注入 / UI 渲染 / 调度 tick，
   以及 window 与 IB.moments 双挂载与运行时零异常。 */

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
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let model = '';
        try { model = String(JSON.parse(body || '{}').model || ''); } catch (error) { /* ignore */ }
        let content;
        if (model === 'mom-publish') content = JSON.stringify({ publish: true, content: '今天突然发现，"没事"这个词好像经常不是字面意思。', visibility: 'all', visibleRoleIds: [], reason: '' });
        else if (model === 'mom-decline') content = JSON.stringify({ publish: false, content: '', reason: '今天没有值得分享的事', visibility: 'all', visibleRoleIds: [] });
        else if (model === 'mom-dup') content = JSON.stringify({ publish: true, content: '同一句话重复发布的测试内容。', visibility: 'all', visibleRoleIds: [], reason: '' });
        else if (model === 'mom-role-b') content = JSON.stringify({ publishComment: true, comment: '这句我也认真想过。' });
        else content = JSON.stringify({});
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
      return;
    }
    res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const mock = await startMockApi(); const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-moments-smoke-'));
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
    check('page.ready', await waitFor(cdp, "window.IB&&IB.moments&&typeof dbPut==='function'&&typeof createMoment==='function'", 20000));
    check('dual.moments', await evaluate(cdp, "typeof createMoment==='function'&&typeof IB.moments.createMoment==='function'&&typeof IB.moments.generateRoleMoment==='function'"));
    /* 关闭 AI 评论，避免 20-60s 的自动评论触发干扰断言 */
    check('prefs.saveGet', await evaluate(cdp, "(function(){_momentsPrefsSave({enabled:true,autoPublish:true,frequency:'high',aiComment:false,otherRolesVisible:false});var p=_momentsPrefs();return p.frequency==='high'&&p.aiComment===false&&p.otherRolesVisible===false})()"));
    await evaluate(cdp, "_momentsPrefsSave({frequency:'low',aiComment:false,otherRolesVisible:true})");

    const cfg = (id, model) => "{id:'" + id + "',provider:'openai',model:'" + model + "',endpoint:'http://127.0.0.1:" + mock.port + "/v1',apiKey:'',nickname:'" + id + "',systemPrompt:'你是测试角色'}";
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs'," + cfg('mom_a','mom-publish') + ");await dbPut('apiConfigs'," + cfg('mom_b','mom-role-b') + ");await dbPut('apiConfigs'," + cfg('mom_c','mom-decline') + ");await dbPut('apiConfigs'," + cfg('mom_d','mom-dup') + ");await loadApiConfigs();})()");

    /* 数据层 */
    const created = await evaluate(cdp, "createMoment({roleId:'mom_a',content:'手动发布第一条。',source:'manual',visibility:'all'})");
    check('service.create', created && created.ok === true && /^mom_/.test(created.moment.id), JSON.stringify(created));
    const feed = await evaluate(cdp, "getMoments()");
    check('service.feed', Array.isArray(feed) && feed.length >= 1 && feed[0].content === '手动发布第一条。', JSON.stringify(feed && feed[0]));
    check('service.roleFeed', await evaluate(cdp, "(async function(){return (await getRoleMoments('mom_a')).length>=1&&(await getRoleMoments('mom_c')).length===0})()"));
    const liked = await evaluate(cdp, "(async function(){var m=(await getRoleMoments('mom_a'))[0];var a=await likeMoment(m.id);var b=await likeMoment(m.id);return{first:a,second:b,count:m.id}})()");
    check('service.likeCycle', liked && liked.first.ok && liked.first.liked === true && liked.first.count === 1 && liked.second.ok && liked.second.liked === false && liked.second.count === 0, JSON.stringify(liked));
    const c1 = await evaluate(cdp, "(async function(){var m=(await getRoleMoments('mom_a'))[0];return await addMomentComment(m.id,{authorType:'user',authorId:'local_user',content:'第一条评论'})})()");
    check('service.commentAdd', c1 && c1.ok === true && c1.comment && /^mc_/.test(c1.comment.id), JSON.stringify(c1));
    const c2 = await evaluate(cdp, "(async function(){var m=(await getRoleMoments('mom_a'))[0];var r=await deleteMomentComment(m.id,'" + (c1 && c1.comment ? c1.comment.id : 'none') + "');var after=await getRoleMoments('mom_a');return r.ok&&(after[0].comments||[]).length===0})()");
    check('service.commentDelete', c2 === true, String(c2));

    /* 可见性 */
    const vis = await evaluate(cdp, "(async function(){const r=await createMoment({roleId:'mom_b',content:'仅三个角色可见',visibility:'roles',visibleRoleIds:['mom_c'],source:'manual'});const p=await createMoment({roleId:'mom_a',content:'私密日志',visibility:'private',source:'manual'});const feed2=await getMoments();const roleA=await getRoleMoments('mom_a');return{excluded:!feed2.some(m=>m.content==='仅三个角色可见')&&!feed2.some(m=>m.content==='私密日志'),visibleToC:_momentsVisibleToRole(r.moment,'mom_c'),visibleToA:_momentsVisibleToRole(r.moment,'mom_a'),privateInOwn:roleA.some(m=>m.content==='私密日志')}})()");
    check('visibility.rules', vis && vis.excluded === true && vis.visibleToC === true && vis.visibleToA === false && vis.privateInOwn === true, JSON.stringify(vis));

    /* AI 自主发布 */
    const gen = await evaluate(cdp, "generateRoleMoment('mom_a',{trigger:'manual'})");
    check('ai.generate', gen && gen.ok === true && gen.published === true && gen.moment && gen.moment.content.indexOf('没事') >= 0, JSON.stringify(gen));
    const dec = await evaluate(cdp, "generateRoleMoment('mom_c',{trigger:'manual'})");
    check('ai.decline', dec && dec.ok === true && dec.published === false && dec.reason.indexOf('没有值得分享') >= 0, JSON.stringify(dec));

    /* 去重：同内容二次生成被拦（模拟模型两次都返回相同内容） */
    const d1 = await evaluate(cdp, "generateRoleMoment('mom_d',{trigger:'manual'})");
    const d2 = await evaluate(cdp, "generateRoleMoment('mom_d',{trigger:'manual'})");
    const dupCount = await evaluate(cdp, "(async function(){var all=await dbGetAll(MOMENT_STORE);return all.filter(m=>m.content==='同一句话重复发布的测试内容。').length})()");
    check('ai.dedupe', d1 && d1.ok && d1.published && d2 && d2.ok === false && /相似/.test(d2.error || '') && dupCount === 1, JSON.stringify({ d1, d2, dupCount }));

    /* AI 评论 + 防循环 */
    await evaluate(cdp, "_momentsPrefsSave({aiComment:true})");
    const momAId = await evaluate(cdp, "(async function(){var r=await getRoleMoments('mom_a');return r.find(m=>m.content.indexOf('没事')>=0).id})()");
    const com1 = await evaluate(cdp, "generateRoleComment('mom_b','" + momAId + "')");
    check('ai.comment', com1 && com1.ok === true && com1.published === true && com1.comment && com1.comment.content === '这句我也认真想过。', JSON.stringify(com1));
    const com2 = await evaluate(cdp, "generateRoleComment('mom_b','" + momAId + "')");
    check('ai.commentNoLoop', com2 && com2.ok === false && /已评论过|冷却/.test(com2.error || ''), JSON.stringify(com2));
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false})");

    /* 聊天上下文注入 */
    const ctx = await evaluate(cdp, "getMomentsContext('mom_a',{userMessage:'你昨天朋友圈说想吃苹果？'})");
    check('context.chatInject', typeof ctx === 'string' && ctx.indexOf('朋友圈动态') >= 0 && ctx.indexOf('没事') >= 0, String(ctx).slice(0, 160));

    /* UI 渲染 */
    await evaluate(cdp, "loadMomentsPage()");
    check('ui.feedRender', await waitFor(cdp, "document.querySelectorAll('.mom-card').length>=3"));
    check('ui.roleFilter', await evaluate(cdp, "document.getElementById('mom-role-filter').options.length===5"));
    check('ui.statsText', await evaluate(cdp, "document.getElementById('mom-stats').textContent.indexOf('条')>=0"));

    /* 调度 tick：间隔保护应把到期任务重排而非立即发布 */
    const tick = await evaluate(cdp, "(async function(){_momentsSetState('mom_a',{nextAt:Date.now()-1000,lastPostAt:Date.now()-60000});await _momentsTick();var s=_momentsState()['mom_a'];return s&&s.nextAt>Date.now()})()");
    check('scheduler.reschedule', tick === true, String(tick));

    /* 删除 */
    const del = await evaluate(cdp, "(async function(){var m=(await getRoleMoments('mom_a'))[0];var r=await deleteMoment(m.id);var after=await getRoleMoments('mom_a');return r.ok&&!after.some(x=>x.id===m.id)})()");
    check('service.delete', del === true, String(del));

    await new Promise(r => setTimeout(r, 300));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.join('\n').slice(0, 500));
    console.log(failures ? '\nMoments smoke failed: ' + failures : '\nMoments smoke test passed ✔');
  } finally {
    if (cdp) cdp.close(); try { browser.kill(); } catch (error) {}
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) {}
  }
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
