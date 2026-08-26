'use strict';

/* Moments 第二阶段浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   覆盖：AI 图文 Moment（成功/纯文字/图片失败保留文字/不发布）、图片持久化与读取、
   AI 点赞（服务层/资格/冷却/上限/作者自赞拒绝/不重复）、Private UI（占位锁卡/用户不可见不可互动）、
   companion 事件回传落库（幂等）、Feed 分页、双挂载与运行时零异常。 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const PAGE_URL = pathToFileURL(path.join(__dirname, 'InternalBeyond.html')).href;
const TINY_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

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
    if (req.method === 'POST' && /images\/generations/i.test(req.url || '')) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let model = '';
        try { model = String(JSON.parse(body || '{}').model || ''); } catch (error) { /* ignore */ }
        if (model === 'p2-noim') { res.writeHead(500, headers); res.end(JSON.stringify({ error: { message: 'image engine down' } })); return; }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ data: [{ b64_json: TINY_JPEG }], usage: { prompt_tokens: 10, output_tokens: 20 } }));
      });
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let model = '';
        try { model = String(JSON.parse(body || '{}').model || ''); } catch (error) { /* ignore */ }
        let content;
        if (model === 'p2-img') content = JSON.stringify({ publish: true, content: '今天看到一只很奇怪的猫。', visibility: 'all', includeImage: true, imagePrompt: 'A casual smartphone photo of a strange cat on a street' });
        else if (model === 'p2-tex') content = JSON.stringify({ publish: true, content: '今天突然想起以前的一件事。', visibility: 'all', includeImage: false });
        else if (model === 'p2-noim') content = JSON.stringify({ publish: true, content: '这只猫真的太奇怪了，拍一张留个证据。', visibility: 'all', includeImage: true });
        else if (model === 'p2-dec') content = JSON.stringify({ publish: false, reason: '今天没有值得分享的事' });
        else content = JSON.stringify({ publish: true, content: '默认内容', visibility: 'all' });
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-moments-p2-'));
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
    check('page.ready', await waitFor(cdp, "window.IB&&IB.moments&&typeof _momentsApplyLikes==='function'&&typeof _momentsIngestEvent==='function'", 20000));
    check('dual.p2', await evaluate(cdp, "typeof _momentsApplyLikes==='function'&&typeof IB.moments._momentsApplyLikes==='function'"));
    /* 固定 companion 状态为离线（避免外部 23114 服务干扰本测试的本地路径） */
    await evaluate(cdp, "(function(){Object.defineProperty(window,'_activeCompanionOnline',{value:false,writable:true,configurable:true});return true})()");
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false,aiLike:false,frequency:'low'})");

    const cfg = (id, model, extra) => "{id:'" + id + "',provider:'openai',model:'" + model + "',endpoint:'http://127.0.0.1:" + mock.port + "/v1/chat/completions',apiKey:'',nickname:'" + id + "',systemPrompt:'你是测试角色'" + (extra || '') + "}";
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs'," + cfg('p2a','p2-img',",imageGen:true,imageGenModel:'p2-img'") + ");await dbPut('apiConfigs'," + cfg('p2b','p2-tex',",imageGen:true,imageGenModel:'p2-img'") + ");await dbPut('apiConfigs'," + cfg('p2c','p2-noim',",imageGen:true,imageGenModel:'p2-noim'") + ");await dbPut('apiConfigs'," + cfg('p2d','p2-dec',",imageGen:true,imageGenModel:'p2-img'") + ");await loadApiConfigs();})()");

    /* AI 图文 */
    const img = await evaluate(cdp, "generateRoleMoment('p2a',{trigger:'manual',forceImage:true})");
    check('ai.imgPublish', img && img.ok && img.published && img.moment && img.moment.images.length === 1 && String(img.moment.images[0].dataUrl || '').indexOf('data:image/jpeg') === 0, JSON.stringify(img && { ok: img.ok, published: img.published, images: img.moment && img.moment.images.length }));
    const txt = await evaluate(cdp, "generateRoleMoment('p2b',{trigger:'manual',forceImage:true})");
    check('ai.textOnly', txt && txt.ok && txt.published && txt.moment.images.length === 0, JSON.stringify(txt));
    const failImg = await evaluate(cdp, "generateRoleMoment('p2c',{trigger:'manual',forceImage:true})");
    check('ai.imgFailKeepsText', failImg && failImg.ok && failImg.published && failImg.moment && failImg.moment.images.length === 0 && failImg.moment.content.indexOf('猫') >= 0, JSON.stringify(failImg));
    const dec = await evaluate(cdp, "generateRoleMoment('p2d',{trigger:'manual',forceImage:true})");
    check('ai.declineStillWorks', dec && dec.ok && dec.published === false, JSON.stringify(dec));
    check('image.persisted', await evaluate(cdp, "(async function(){var all=await dbGetAll(MOMENT_STORE);var m=all.find(x=>x.content.indexOf('猫')>=0&&x.images.length>0);return !!m&&String(m.images[0].dataUrl||'').indexOf('data:image/jpeg')===0})()"));
    check('image.readable', await evaluate(cdp, "(async function(){var all=await dbGetAll(MOMENT_STORE);var m=all.find(x=>x.images&&x.images.length>0);var ok=false;if(m){var img=new Image();img.src=m.images[0].dataUrl;ok=await new Promise(function(r){img.onload=function(){r(img.naturalWidth>0)};img.onerror=function(){r(false)};setTimeout(function(){r(false)},3000)})}return ok})()"));

    /* AI 点赞（服务层 + 资格 + 冷却 + 上限 + 作者自赞） */
    await evaluate(cdp, "_momentsPrefsSave({aiLike:true});localStorage.removeItem('ib_moments_likes_v1');localStorage.removeItem('ib_moments_commentq_v1')");
    const m1 = await evaluate(cdp, "createMoment({roleId:'p2d',content:'一张值得点赞的动态。',source:'manual',visibility:'all'})");
    check('like.selfRejected', await evaluate(cdp, "(async function(){var r=await likeMoment('" + m1.moment.id + "','p2d');return r.ok===false})()"));
    const l1 = await evaluate(cdp, "likeMoment('" + m1.moment.id + "','p2b')");
    check('like.roleAdd', l1 && l1.ok && l1.liked === true && l1.count === 1, JSON.stringify(l1));
    const l1b = await evaluate(cdp, "likeMoment('" + m1.moment.id + "','p2b')");
    check('like.roleNoDup', l1b && l1b.ok && l1b.count === 1, JSON.stringify(l1b));
    const u1 = await evaluate(cdp, "likeMoment('" + m1.moment.id + "')");
    const u2 = await evaluate(cdp, "likeMoment('" + m1.moment.id + "')");
    check('like.userToggle', u1.ok && u1.count === 2 && u2.liked === false && u2.count === 1, JSON.stringify({ u1, u2 }));
    check('like.eligible', await evaluate(cdp, "(function(){return _momentsLikeEligible({roleId:'p2d',visibility:'all',likes:[]},'p2a')})()"));
    const vis = await evaluate(cdp, "(function(){return _momentsLikeEligible({roleId:'p2a',visibility:'roles',visibleRoleIds:['p2b'],likes:[]},'p2b')})()");
    check('like.notVisible', vis === false, String(vis));
    const applied = await evaluate(cdp, "(async function(){localStorage.removeItem('ib_moments_likes_v1');var m=await createMoment({roleId:'p2d',content:'点赞上限测试动态。',source:'manual',visibility:'all'});var r=await _momentsApplyLikes(m.moment.id,{force:true,max:2});var r2=await _momentsApplyLikes(m.moment.id,{force:true,max:2});var fresh=await getMoment(m.moment.id);var roleLikes=(fresh.likes||[]).filter(x=>x!==_activeUserId()).length;return{first:r,second:r2,roleLikes:roleLikes}})()");
    check('like.applyBounded', applied && applied.first.ok && applied.first.liked === 2 && applied.second.ok && applied.second.liked <= 1 && applied.roleLikes <= 3, JSON.stringify(applied));
    /* 冷却 + 每小时上限 */
    const cool = await evaluate(cdp, "(async function(){var m=await createMoment({roleId:'p2d',content:'冷却测试动态。',source:'manual',visibility:'all'});_momentsRecordLike('p2b','p2d',Date.now());return _momentsLikeEligible(m.moment,'p2b')})()");
    check('like.cooldown', cool === false, String(cool));
    const cap = await evaluate(cdp, "(function(){localStorage.setItem('ib_moments_likes_v1',JSON.stringify({p2b:{log:[Date.now(),Date.now()-60000,Date.now()-120000,Date.now()-180000],lastAt:Date.now()}}));return _momentsLikeEligible({roleId:'p2d',visibility:'all',likes:[]},'p2b')})()");
    check('like.hourlyCap', cap === false, String(cap));

    /* Private UI：主 Feed 不显示 / 角色页私人日志为锁占位卡 / 不可互动 */
    await evaluate(cdp, "localStorage.removeItem('ib_moments_likes_v1')");
    const priv = await evaluate(cdp, "(async function(){var r=await createMoment({roleId:'p2a',content:'今天用户突然夸我了。',visibility:'private',source:'proactive'});var feed=await getMoments();var own=await getRoleMoments('p2a');return{id:r.moment.id,inPublicFeed:feed.some(m=>m.content==='今天用户突然夸我了。'),inOwn:own.some(m=>m.content==='今天用户突然夸我了。')}})()");
    check('private.model', priv && priv.inPublicFeed === false && priv.inOwn === true, JSON.stringify(priv));
    await evaluate(cdp, "loadMomentsPage()");/* 填充角色筛选下拉（页面初始化路径） */
    await evaluate(cdp, "(async function(){var s=document.getElementById('mom-role-filter');s.value='p2a';var sc=document.getElementById('mom-role-scope');sc.value='public';await _momentsRenderFeed()})()");
    check('private.feedHidden', await evaluate(cdp, "document.querySelectorAll('.mom-private-lock').length===0"));
    await evaluate(cdp, "(async function(){var sc=document.getElementById('mom-role-scope');sc.value='private';await _momentsRenderFeed()})()");
    check('private.lockedCard', await waitFor(cdp, "document.querySelectorAll('.mom-private-lock').length>=1"));
    check('private.noteText', await evaluate(cdp, "(document.querySelector('.mom-private-note')||{}).textContent ? document.querySelector('.mom-private-note').textContent.indexOf('只有')>=0 : false"));
    check('private.noActions', await evaluate(cdp, "document.querySelector('.mom-private-lock') ? document.querySelector('.mom-private-lock').querySelectorAll('.mom-action-btn,.mom-comments').length===0 : false"));
    await evaluate(cdp, "(async function(){var s=document.getElementById('mom-role-scope');s.value='public';await _momentsRenderFeed()})()");

    /* companion 事件回传落库（幂等） */
    const ingest = await evaluate(cdp, "(async function(){var ev={id:'event_mom_p2t',kind:'moment',moment:{id:'mom_ingest_p2',roleId:'p2b',content:'companion 后台生成的动态。',visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date().toISOString()},next_at:Date.now()+3600000,last_post_at:Date.now(),sent_at:Date.now()};var a=await _momentsIngestEvent(ev,_activeUserId());var b=await _momentsIngestEvent(ev,_activeUserId());var ex=await getMoment('mom_ingest_p2');return{a:a,b:b,exists:!!ex}})()");
    check('companion.ingestIdempotent', ingest && ingest.a === true && ingest.b === false && ingest.exists === true, JSON.stringify(ingest));

    /* Feed 分页（>30 条 → 首屏 30，点击加载更多后全量） */
    await evaluate(cdp, "_momentsPrefsSave({aiLike:false,aiComment:false})");
    await evaluate(cdp, "(async function(){for(var i=1;i<=32;i++){await createMoment({roleId:'p2b',content:'分页测试动态 '+i,source:'manual',visibility:'all'})}})()");
    await evaluate(cdp, "(async function(){var s=document.getElementById('mom-role-filter');s.value='';await _momentsRenderFeed()})()");
    check('feed.page30', await waitFor(cdp, "document.querySelectorAll('.mom-card').length===30"));
    check('feed.moreVisible', await evaluate(cdp, "!!document.querySelector('.mom-more button')"));
    await evaluate(cdp, "(function(){var b=document.querySelector('.mom-more button');if(b)b.click();return true})()");
    check('feed.loadMore', await waitFor(cdp, "document.querySelectorAll('.mom-card').length>30"));

    await new Promise(r => setTimeout(r, 300));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.join('\n').slice(0, 500));
    console.log(failures ? '\nMoments Phase2 smoke failed: ' + failures : '\nMoments Phase2 smoke test passed ✔');
  } finally {
    if (cdp) cdp.close(); try { browser.kill(); } catch (error) {}
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) {}
  }
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
