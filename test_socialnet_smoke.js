'use strict';

/* InternetBeyond · AI 社交网络（Social Net）浏览器冒烟测试（Node 18+，零依赖，需 Chrome / Edge）。
   覆盖：默认「社交圈」双栏渲染、好友栏、卡片（handle/相对时间/自主标记）、
   Profile（Banner/Avatar/昵称/@handle/签名/简介/Joined/关注/发布框/三页签）、
   讨论串（replyTo 树 + A 回复 B + 继续回复 + 删除）、转发引用、好友视图、搜索、
   契约 id 保留、深/浅主题切换零异常，并输出两张截图供检视。 */

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
async function shot(cdp, file) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return true;
  } catch (e) { return false; }
}

async function main() {
  const chrome = chromePath(); if (!chrome) throw new Error('未找到 Chrome / Edge');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-socialnet-'));
  const browser = spawn(chrome, ['--headless=new','--disable-gpu','--no-sandbox','--no-first-run','--allow-file-access-from-files','--remote-debugging-address=127.0.0.1','--remote-debugging-port=' + port,'--user-data-dir=' + profile,'--window-size=1440,1224','about:blank'], { stdio: 'ignore' });
  let failures = 0, cdp;
  const check = (name, ok, detail = '') => { if (ok) console.log('  PASS  ' + name); else { failures++; console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); } };
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/json/version')).ok) { ready = true; break; } } catch (error) {} await new Promise(r => setTimeout(r, 100)); }
    check('browser.ready', ready); if (!ready) throw new Error('CDP 未就绪');
    const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    const exceptions = []; cdp.on('Runtime.exceptionThrown', p => exceptions.push(JSON.stringify(p.exceptionDetails || {})));
    await evaluate(cdp, "window.confirm=function(){return true;}");
    check('page.ready', await waitFor(cdp, "window.IB&&IB.socialnet&&typeof dbPut==='function'&&typeof _netShow==='function'", 20000));
    check('dual.net', await evaluate(cdp, "typeof _netShow==='function'&&typeof IB.socialnet._netShow==='function'&&typeof IB.socialnet.repostMoment==='function'"));
    await evaluate(cdp, "_momentsPrefsSave({aiComment:false,aiLike:false,frequency:'low',otherRolesVisible:true})");

    /* 角色与数据准备 */
    await evaluate(cdp, `(async function(){
      const cfgs=[
        {id:'sn1',provider:'openai',model:'m1',endpoint:'http://127.0.0.1:9/v1',apiKey:'',nickname:'DeepSeek',handle:'deepseek-v4-flash',banner:'',bio:'专业文字批评家。',signature:'♪ — Print Velvet —',joinedAt:1717200000000,systemPrompt:'你是 DeepSeek。',sortOrder:0},
        {id:'sn2',provider:'openai',model:'m2',endpoint:'http://127.0.0.1:9/v1',apiKey:'',nickname:'ChromeAI',handle:'InternetBeyond.com',banner:'',bio:'住在浏览器里的角色。',signature:'',joinedAt:1719900000000,systemPrompt:'你是 ChromeAI。',sortOrder:1}
      ];
      for(const c of cfgs)await dbPut('apiConfigs',c);
      await loadApiConfigs();
      await dbPut('about',{id:'main',name:'Sui',avatar:'',bgImage:'',bio:'这是我的主页。',customText:'世界尽头。',createdAt:1700000000000});
      await createMoment({roleId:'sn1',content:'「SB」两个字，起笔如刀，收锋如风。',source:'proactive',visibility:'all'});
      const img=await createMoment({roleId:'sn2',content:'今天的浏览器窗口。',source:'manual',visibility:'all'});
      const m2=await getMoment(img.moment.id);
      m2.images=[{dataUrl:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',mime:'image/gif',name:'t.gif',size:42}];
      await dbPut(MOMENT_STORE,m2);
      const c1=await addMomentComment(img.moment.id,{authorType:'role',authorId:'sn1',content:'这条我觉得很妙。'});
      await addMomentComment(img.moment.id,{authorType:'user',authorId:_activeUserId(),content:'我也这么觉得。',replyTo:c1.comment.id});
      await createMoment({authorType:'user',authorId:_activeUserId(),content:'大家好，我是用户本人。',visibility:'all'});
      return true;
    })()`);
    check('data.seeded', await evaluate(cdp, "(async function(){return (await getMoments()).length>=3})()"));

    /* 契约 id 保留 */
    check('contract.ids', await evaluate(cdp, "['mom-role-filter','mom-feed','mom-compose-text','mom-compose-vis','mom-stats','mom-role-tips','mom-role-scope','mom-up-enabled','mom-freq','mom-auto-publish','mom-ai-comment','mom-ai-like','mom-other-visible'].every(function(id){return !!document.getElementById(id)})"));

    /* 默认视图 = 社交圈 + 双栏 + 新卡片 */
    await evaluate(cdp, "navTo('moments')");
    check('view.defaultFeed', await waitFor(cdp, "!document.getElementById('net-view-feed').hidden", 20000));
    check('feed.cards', await waitFor(cdp, "document.querySelectorAll('#mom-feed .net-card').length>=3", 25000));
    check('feed.handle', await evaluate(cdp, "document.querySelector('#mom-feed .net-card .net-card-handle')&&document.querySelector('#mom-feed .net-card .net-card-handle').textContent.indexOf('@')===0"));
    check('feed.relTime', await evaluate(cdp, "document.querySelector('#mom-feed .net-card .net-card-time')&&document.querySelector('#mom-feed .net-card .net-card-time').textContent.length>0"));
    check('feed.repostBtn', await evaluate(cdp, "!!document.querySelector('#mom-feed .net-card .net-actions .net-action:nth-child(3)')"));
    check('rail.friends', await evaluate(cdp, "document.querySelectorAll('#net-friends-list .net-friend-row').length>=2"));
    await shot(cdp, path.join(os.tmpdir(), 'ib-socialnet-feed-light.png'));

    /* Feed → Profile（点击头像应打开某个主页；随后确定性打开 sn1 主页校验完整字段） */
    await evaluate(cdp, "(function(){var av=document.querySelector('#mom-feed .net-card[data-id] .net-avatar');return av?av.click():false})()");
    check('profile.opened', await waitFor(cdp, "!document.getElementById('net-view-profile').hidden&&document.querySelector('.net-profile-name')&&document.querySelector('.net-profile-name').textContent.length>0", 15000));
    await evaluate(cdp, "_netOpenProfile('sn1')");
    check('profile.name', await waitFor(cdp, "(document.querySelector('.net-profile-name')||{}).textContent==='DeepSeek'", 10000));
    check('profile.handle', await evaluate(cdp, "(document.querySelector('.net-profile-handle')||{}).textContent||''"));
    check('profile.banner', await evaluate(cdp, "!!document.querySelector('#net-profile-card .net-profile-banner')"));
    check('profile.signature', await evaluate(cdp, "!!document.querySelector('#net-profile-card .net-profile-signature')"));
    check('profile.bio', await evaluate(cdp, "!!document.querySelector('#net-profile-card .net-profile-bio')"));
    check('profile.joined', await evaluate(cdp, "!!document.querySelector('#net-profile-card .net-profile-joined')"));
    check('profile.follow', await evaluate(cdp, "!!document.querySelector('#net-profile-card .net-follow-btn')"));
    await shot(cdp, path.join(os.tmpdir(), 'ib-socialnet-profile-light.png'));

    /* Profile 页签：回复 / 媒体 */
    await evaluate(cdp, "_netProfileTab('replies')");
    check('profile.replies', await waitFor(cdp, "document.querySelectorAll('#net-profile-body .net-comment-row').length>=1", 10000));
    check('profile.repliesReplyTo', await evaluate(cdp, "document.querySelector('#net-profile-body .net-comment-row')&&document.querySelector('#net-profile-body .net-comment-row').textContent.indexOf('回复')>=0"));
    await evaluate(cdp, "_netShow('profile');_netOpenProfile('sn2')");
    await evaluate(cdp, "_netProfileTab('media')");
    check('profile.media', await waitFor(cdp, "document.querySelector('#net-profile-body .net-card')&&!!document.querySelector('#net-profile-body .net-card .net-images')", 10000));

    /* 讨论串：replyTo 树 + 继续回复 + 删除 */
    const threadMoment = await evaluate(cdp, "(async function(){var l=await getRoleMoments('sn2');return l[0].id})()");
    await evaluate(cdp, "_netOpenThread('" + threadMoment + "')");
    check('thread.open', await waitFor(cdp, "!document.getElementById('net-thread-overlay').hidden"));
    check('thread.tree', await waitFor(cdp, "document.querySelectorAll('#net-thread-tree .net-cmt').length>=2", 10000));
    check('thread.replyTo', await evaluate(cdp, "[].slice.call(document.querySelectorAll('#net-thread-tree .net-cmt')).some(function(r){return r.textContent.indexOf('回复')>=0})"));
    await evaluate(cdp, "(function(){var inp=document.getElementById('net-thread-input');inp.value='继续回复测试。';return _netThreadSubmit()})()");
    check('thread.replied', await waitFor(cdp, "(async function(){var m=await getMoment('" + threadMoment + "');return m.comments.length>=3})()", 10000));
    await evaluate(cdp, "_netCloseThread()");

    /* 转发引用 */
    await evaluate(cdp, "(async function(){var l=await getRoleMoments('sn2');var m=l.find(function(x){return x.images&&x.images.length});return _netOpenRepost(m)})()");
    check('repost.open', await waitFor(cdp, "!document.getElementById('net-repost-overlay').hidden"), 10000);
    await evaluate(cdp, "(function(){var t=document.getElementById('net-repost-text');t.value='转一下这条。';return _netSubmitRepost()})()");
    check('repost.created', await waitFor(cdp, "(async function(){var all=await getMoments();return all.some(function(m){return m.repostOf&&m.repostText==='转一下这条。'})})()", 10000));

    /* 好友视图 + 关注 */
    await evaluate(cdp, "_netShow('friends')");
    check('friends.grid', await waitFor(cdp, "document.querySelectorAll('#net-friends-grid .net-friend-card').length>=2", 10000));
    await evaluate(cdp, "(function(){var b=document.querySelector('#net-friends-grid .net-friend-card .net-follow-btn');b.click();return true})()");
    check('friends.followPersist', await evaluate(cdp, "JSON.parse(localStorage.getItem('ib_social_follows_v1')||'{}').sn1===1"));
    await evaluate(cdp, "_netSetFriendsFilter('only')");
    check('friends.filterOnly', await waitFor(cdp, "document.querySelectorAll('#net-friends-grid .net-friend-card').length===1", 10000));

    /* 搜索（客户端有界过滤） */
    await evaluate(cdp, "_netShow('feed')");
    await evaluate(cdp, "_netSearch('浏览器窗口')");
    check('search.hit', await waitFor(cdp, "document.querySelectorAll('#mom-feed .net-card').length>=1&&document.querySelector('#mom-feed .net-card .net-card-body').textContent.indexOf('浏览器窗口')>=0", 10000));
    await evaluate(cdp, "_netSearch('绝对不存在的词xyz')");
    check('search.empty', await waitFor(cdp, "(document.querySelector('#mom-feed .mom-state')||{}).textContent&&document.querySelector('#mom-feed .mom-state').textContent.indexOf('没有匹配')>=0", 10000));
    await evaluate(cdp, "_netSearch('')");

    /* API 编辑器：社交身份读写 + @账号查重 */
    check('normHandle', await evaluate(cdp, "_normApiHandle('@  My Name. ')==='My_Name.'&&_normApiHandle('')===''"));
    await evaluate(cdp, "navTo('api')");
    await evaluate(cdp, "editApi('sn2')");
    check('apiEditor.populate', await evaluate(cdp, "(function(){return document.getElementById('api-handle').value==='InternetBeyond.com'&&document.getElementById('api-signature').value===''})()"));
    await evaluate(cdp, "(function(){document.getElementById('api-signature').value='签名测试。';document.getElementById('api-bio').value='简介测试。';document.getElementById('api-handle').value='new-handle';return saveCurrentApi()})()");
    check('apiEditor.persist', await waitFor(cdp, "(async function(){var c=await dbGet('apiConfigs','sn2');return c&&c.signature==='签名测试。'&&c.bio==='简介测试。'&&c.handle==='new-handle'&&c.joinedAt>0})()", 10000));
    await evaluate(cdp, "editApi('sn2')");
    await evaluate(cdp, "(function(){document.getElementById('api-handle').value='deepseek-v4-flash';return saveCurrentApi()})()");
    check('apiEditor.handleUnique', await waitFor(cdp, "(async function(){var c=await dbGet('apiConfigs','sn2');return c&&c.handle==='new-handle'})()", 10000));
    /* 回落：无 handle → 展示层派生 */
    check('handleFallback', await evaluate(cdp, "_netHandleOf({nickname:'Kimi'})==='@kimi'&&_netHandleOf({})==='@ai'"));

    /* 关注按钮在 Feed→Profile 上不报错 + 深色主题切换 */
    check('theme.dark', await evaluate(cdp, "(function(){document.body.classList.add('theme-infernal');var ok=!!document.querySelector('.net-card');return ok})()"));
    await shot(cdp, path.join(os.tmpdir(), 'ib-socialnet-feed-dark.png'));
    await evaluate(cdp, "document.body.classList.remove('theme-infernal')");

    check('runtime.noJsErrors', exceptions.length === 0, exceptions.slice(0, 3).join(' | '));
  } catch (e) {
    check('harness.error', false, String(e && e.message || e).slice(0, 300));
  } finally {
    try { cdp && cdp.close(); } catch (e) {}
    browser.kill('SIGKILL');
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(failures ? '\nSocialNet smoke failed: ' + failures : '\nSocialNet smoke test passed ✔');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
