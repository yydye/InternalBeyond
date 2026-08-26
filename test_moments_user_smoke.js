'use strict';

/* Moments · User 作者身份浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   覆盖：用户发布（服务层 + Compose UI，作者固定本人）、旧 roleId-only 数据读取兼容、
   User/Role 混合 Feed 与排序、三种评论方向、用户/角色点赞与去重、用户 Private 隔离、
   用户公开动态进入 AI Context（带 Profile 昵称）、Export/Import 字段保持、零异常。 */
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
  const server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-API-Key' };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, headers);
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ publishComment: true, comment: '这条动态很有生活气息。' }) } }] }));
      });
      return;
    }
    res.writeHead(404, headers); res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const mock = await startMockApi();
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-moments-user-'));
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
    check('page.ready', await waitFor(cdp, "window.IB&&IB.moments&&typeof _momentIsUserAuthor==='function'&&typeof _momentsRenderComposeIdentity==='function'", 20000));

    /* 环境固定：companion 离线；互动触发关闭（按需临时开启）；Profile 名称来自现有 about 存储 */
    await evaluate(cdp, "(function(){Object.defineProperty(window,'_activeCompanionOnline',{value:false,writable:true,configurable:true});return true})()");
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false,aiLike:false,frequency:'low'})");
    await evaluate(cdp, "(async function(){await dbPut('about',{id:'main',name:'测试用户'});window._cachedUserName='测试用户';return true})()");
    const EP = 'http://127.0.0.1:' + mock.port + '/v1/chat/completions';
    await evaluate(cdp, "(async function(){await dbPut('apiConfigs',{id:'u_a',provider:'openai',model:'u-cmt',endpoint:'" + EP + "',apiKey:'',nickname:'甲',systemPrompt:'你是测试角色甲'});await dbPut('apiConfigs',{id:'u_b',provider:'openai',model:'u-b',endpoint:'" + EP + "',apiKey:'',nickname:'乙',systemPrompt:'你是测试角色乙'});await loadApiConfigs();return true})()");

    /* ── 发布：服务层 ── */
    const um = await evaluate(cdp, "(async function(){var r=await createMoment({authorType:'user',content:'今天终于把功能做完了。',source:'manual',visibility:'all'});var s=await getMoment(r.moment.id);return{ok:r.ok,id:r.moment.id,authorType:s.authorType,authorId:s.authorId,roleId:s.roleId,uid:_activeUserId()}})()");
    check('create.userMoment', um && um.ok && um.authorType === 'user' && um.authorId === um.uid && um.roleId === '', JSON.stringify(um));

    /* 发布：Compose UI（无角色选择；身份固定本人） */
    await evaluate(cdp, "loadMomentsPage()");
    check('compose.identityShown', await evaluate(cdp, "(document.getElementById('mom-compose-me').textContent||'').indexOf('本人')>=0"));
    check('compose.noRoleSelect', await evaluate(cdp, "document.getElementById('mom-compose-role')===null"));
    await evaluate(cdp, "(async function(){document.getElementById('mom-compose-text').value='UI 发布的动态。';await _momentsSubmitCompose();return true})()");
    check('compose.postsAsUser', await waitFor(cdp, "(function(){var n=document.querySelector('#mom-feed .mom-card .mom-card-name');return n&&n.textContent==='测试用户'})()"));

    /* ── 旧数据兼容：无 author 字段的 roleId-only 记录 ── */
    const legacy = await evaluate(cdp, "(async function(){var old={id:'mom_legacy_u1',roleId:'u_a',content:'旧数据动态。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date(Date.now()-60000).toISOString()};await dbPut(MOMENT_STORE,old);var m=await getMoment('mom_legacy_u1');return{isUser:_momentIsUserAuthor(m),roleId:_momentsAuthorRoleId(m),visibleToAuthor:_momentsVisibleToRole(m,'u_a')}})()");
    check('legacy.roleAuthorCompat', legacy && legacy.isUser === false && legacy.roleId === 'u_a' && legacy.visibleToAuthor === true, JSON.stringify(legacy));
    const stamped = await evaluate(cdp, "(function(){var r=_momentsDefaults({roleId:'x1'});var u=_momentsDefaults({authorType:'user'});return{rat:r.authorType,raid:r.authorId,uat:u.authorType,urole:u.roleId,uisMe:u.authorId===_activeUserId()}})()");
    check('legacy.defaultsStamp', stamped && stamped.rat === 'role' && stamped.raid === 'x1' && stamped.uat === 'user' && stamped.urole === '' && stamped.uisMe === true, JSON.stringify(stamped));

    /* ── Feed 混合与排序（createdAt DESC） ── */
    const order = await evaluate(cdp, "(async function(){var base=Date.now()-120000;await dbPut(MOMENT_STORE,{id:'mix_r1',authorType:'role',authorId:'u_b',roleId:'u_b',content:'乙的动态。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date(base).toISOString()});await dbPut(MOMENT_STORE,{id:'mix_r2',roleId:'u_a',content:'甲的动态。',images:[],visibility:'all',visibleRoleIds:[],likes:[],comments:[],source:'proactive',createdAt:new Date(base+30000).toISOString()});var feed=await getMoments();var ids=feed.map(function(m){return m.id});var roleNameOf=function(m){var c=apiConfigs.find(function(a){return a.id===m.roleId});return c?(c.nickname||c.model||'AI'):'（角色已删除）'};var ui=ids.indexOf('mix_r1'),ai=ids.indexOf('mix_r2'),uu=ids.indexOf('" + um.id + "');return{order:[uu,ai,ui].join(','),names:feed.slice(0,3).map(function(m){return _momentIsUserAuthor(m)?_momentsUserDisplayName():roleNameOf(m)})}})()");
    const orderOk = order && order.order.split(',').map(Number).every((v, i2, a) => i2 === 0 || v > a[i2 - 1]) && order.order.length > 0;
    check('feed.mixedOrderDesc', orderOk && order.names.indexOf('测试用户') >= 0 && order.names.indexOf('甲') >= 0, JSON.stringify(order));
    await evaluate(cdp, "_momentsRenderFeed()");
    check('feed.mixedNames', await waitFor(cdp, "(function(){var ns=[].slice.call(document.querySelectorAll('#mom-feed .mom-card .mom-card-name')).map(function(n){return n.textContent});return ns.indexOf('测试用户')>=0&&ns.indexOf('甲')>=0&&ns.indexOf('乙')>=0})()"));

    /* ── 评论三方向 ── */
    await evaluate(cdp, "localStorage.removeItem('ib_moments_commentq_v1')");
    const cm1 = await evaluate(cdp, "(async function(){_momentsPrefsSave({aiComment:true});var r=await generateRoleComment('u_a','" + um.id + "');_momentsPrefsSave({aiComment:false});var m=await getMoment('" + um.id + "');return{ok:r.ok,published:r.published,c:(m.comments||[])[0]}})()");
    check('comment.roleToUser', cm1 && cm1.ok && cm1.published === true && cm1.c && cm1.c.authorType === 'role' && cm1.c.authorId === 'u_a', JSON.stringify(cm1));
    const cm2 = await evaluate(cdp, "(async function(){var r=await addMomentComment('" + um.id + "',{authorType:'user',content:'我自己补一句。'});return r})()");
    check('comment.userToUser', cm2 && cm2.ok && cm2.comment.authorType === 'user', JSON.stringify(cm2));
    const cm3 = await evaluate(cdp, "(async function(){var r=await addMomentComment('mix_r2',{authorType:'user',content:'给甲的评论。'});return r})()");
    check('comment.userToRole', cm3 && cm3.ok && cm3.comment.authorType === 'user', JSON.stringify(cm3));
    const cmDup = await evaluate(cdp, "(async function(){var r=await addMomentComment('mix_r2',{authorType:'user',content:'给甲的评论。'});return r.ok===false})()");
    check('comment.dupeRejected', cmDup === true);

    /* ── 点赞 ── */
    const lk1 = await evaluate(cdp, "(async function(){var a=await likeMoment('mix_r1');var b=await likeMoment('mix_r1');var m=await getMoment('mix_r1');return{a:a,b:b,hasUser:m.likes.includes(_activeUserId())}})()");
    check('like.userToggle', lk1 && lk1.a.ok && lk1.a.liked === true && lk1.b.liked === false && lk1.hasUser === false, JSON.stringify(lk1));
    await evaluate(cdp, "(async function(){await likeMoment('mix_r1');return true})()");
    const lk2 = await evaluate(cdp, "(async function(){var r=await likeMoment('" + um.id + "','u_b');var r2=await likeMoment('" + um.id + "','u_b');var m=await getMoment('" + um.id + "');return{first:r,count1:r.count,dup:r2.count,m:m.likes.length,mine:m.likes.filter(function(x){return x==='u_b'}).length}})()");
    check('like.roleOnceOnUserPost', lk2 && lk2.first.ok && lk2.count1 === 1 && lk2.dup === 1 && lk2.mine === 1, JSON.stringify(lk2));
    const lk3 = await evaluate(cdp, "(async function(){var mine=await getMoment('" + um.id + "');var r=await likeMoment('" + um.id + "');return{blocked:r.ok===false&&r.error==='作者不能点赞自己'}})()");
    check('like.userSelfRejected', lk3 && lk3.blocked === true, JSON.stringify(lk3));

    /* ── Private（用户私密：仅本人可见） ── */
    const priv = await evaluate(cdp, "(async function(){var r=await createMoment({authorType:'user',content:'U私密内容PQ。',visibility:'private',source:'manual'});var feed=await getMoments();return{id:r.moment.id,inOwnFeed:feed.some(function(m){return m.content==='U私密内容PQ。'}),visToRole:_momentsVisibleToRole(await getMoment(r.moment.id),'u_a'),likeOk:_momentsLikeEligible({roleId:'',authorType:'user',visibility:'private',likes:[]},'u_a')}})()");
    check('private.userVisibleToSelf', priv && priv.inOwnFeed === true, JSON.stringify(priv));
    check('private.userHiddenFromRoles', priv && priv.visToRole === false && priv.likeOk === false, JSON.stringify(priv));
    await evaluate(cdp, "_momentsPrefsSave({aiComment:true})");
    const privCmt = await evaluate(cdp, "(async function(){var r=await generateRoleComment('u_a','" + priv.id + "');_momentsPrefsSave({aiComment:false});return r})()");
    check('private.userNoAiComment', privCmt && privCmt.ok === false && privCmt.error === '不可见', JSON.stringify(privCmt));
    await evaluate(cdp, "(async function(){await createMoment({authorType:'user',content:'U公开内容GK。',visibility:'all',source:'manual'});return true})()");
    const ctx = await evaluate(cdp, "(async function(){return await getMomentsContext('u_a')})()");
    check('ctx.userPublicIn', typeof ctx === 'string' && ctx.indexOf('U公开内容GK') >= 0 && ctx.indexOf('测试用户') >= 0, String(ctx).slice(0, 200));
    check('ctx.userPrivateOut', ctx.indexOf('U私密内容PQ') < 0);

    /* ── Export / Import 保持作者字段 ── */
    const rt = await evaluate(cdp, "(async function(){var exp=await _ibBuildExportData();var target=(exp.moments||[]).find(function(m){return m.id==='" + um.id + "'});if(!target||target.authorType!=='user')return{ok:false};for(var i=0;i<exp.moments.length;i++)await dbPut('moments',exp.moments[i]);var after=await getMoment('" + um.id + "');var all=await dbGetAll(MOMENT_STORE);return{ok:true,authorType:after.authorType,authorId:after.authorId,total:all.length}})()");
    check('exportImport.authorPreserved', rt && rt.ok && rt.authorType === 'user' && rt.authorId === um.uid, JSON.stringify(rt));

    await new Promise(r => setTimeout(r, 300));
    check('runtime.noExceptions', exceptions.length === 0, exceptions.join('\n').slice(0, 500));
    console.log(failures ? '\nMoments User-author smoke failed: ' + failures : '\nMoments User-author smoke test passed ✔');
  } finally {
    if (cdp) cdp.close(); try { browser.kill(); } catch (error) {}
    await new Promise(r => mock.server.close(r));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) {}
  }
  if (failures) process.exitCode = 1;
}

main().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
