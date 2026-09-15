'use strict';

/*
 * 角色私信（Role DM）· 最小浏览器 smoke（headless Chrome / Edge, CDP）。
 *
 * 为什么必须有这一条：单测是在 Node 的 mock 全局里求值两个模块，它证明不了
 * "这三个 <script> 真的按正确顺序进了真实页面、页面里 IB.roleDm 真的可用、
 * 运行时在真实执行器接缝上真的产生了双角色调用"。本 smoke 只验证这四件事：
 *   1. 真实页面里三个模块都加载成功，且角色私信前缀与 chat-core 一致；
 *   2. canonical thread identity 在真实页面里对 A/B 顺序不敏感；
 *   3. 一次真实 run 让**两个角色各自的 cfg** 各自发了一次模型调用，
 *      消息落进既有 chatMessages 存储，consumer=role_dm，A≠B；
 *   4. 导航到角色私信页后 UI 渲染成功、样式表被注入、没有未捕获异常。
 *
 * 隔离纪律（与仓库既有 browser smoke 一致）：
 *   · 不进开发目录数据库：全部写入被 stub 的 window.dbPut 收进内存；
 *   · 不发真实网络请求：callApiChat 被替换成可辨识的假执行器；
 *   · 不碰 Home Node / 不碰真实 IndexedDB。
 *
 * Run: node tests/test_role_dm_smoke.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

/* Repository root — this file lives in tests/, so the root is one level up. */
const ROOT = path.resolve(__dirname, '..');

const WEB = require(path.join(ROOT, 'services', 'internal-beyond-server.js'));

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(c)) return c;
  return null;
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? rej(e) : res(p)); });
  });
}
function httpJson(url, method) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: method || 'GET' }, resp => {
      let d = ''; resp.on('data', c => { d += c; }); resp.on('end', () => { try { res({ ok: resp.statusCode === 200, status: resp.statusCode, json: JSON.parse(d || '{}') }); } catch (e) { res({ ok: false, status: resp.statusCode, json: null }); } });
    });
    r.on('error', rej); r.end();
  });
}

/* ── 最小 CDP 客户端（与 tests/test_boot_smoke.js 同款，含 WebSocket 帧解析）── */
class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname, port: u.port, path: u.pathname + u.search,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (response, socket) => resolve(new Cdp(socket)));
      req.on('error', reject);
      req.end();
    });
  }
  constructor(s) {
    this.s = s; this.b = Buffer.alloc(0); this.id = 0; this.p = new Map(); this.l = new Map();
    s.on('data', d => { this.b = Buffer.concat([this.b, d]); this.parse(); });
    s.on('error', () => { });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.p.set(id, { res, rej }); this.t({ id, method, params: params || {} }); });
  }
  on(method, fn) { if (!this.l.has(method)) this.l.set(method, []); this.l.get(method).push(fn); }
  t(m) {
    const p = Buffer.from(JSON.stringify(m), 'utf8'), mask = crypto.randomBytes(4), b = Buffer.alloc(p.length);
    for (let i = 0; i < p.length; i++) b[i] = p[i] ^ mask[i & 3];
    let h;
    if (p.length < 126) h = Buffer.from([0x81, 0x80 | p.length]);
    else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(p.length, 2); }
    this.s.write(Buffer.concat([h, mask, b]));
  }
  parse() {
    for (;;) {
      if (this.b.length < 2) return;
      const f = this.b[0], sl = this.b[1] & 0x7f;
      let o = 2, len = sl;
      if (sl === 126) { if (this.b.length < 4) return; len = this.b.readUInt16BE(2); o = 4; }
      else if (sl === 127) { if (this.b.length < 10) return; len = this.b.readUInt32BE(6); o = 10; }
      const masked = (this.b[1] & 0x80) !== 0;
      let mask = null;
      if (masked) { if (this.b.length < o + 4) return; mask = this.b.subarray(o, o + 4); o += 4; }
      if (this.b.length < o + len) return;
      let p = this.b.subarray(o, o + len);
      this.b = this.b.subarray(o + len);
      if (mask) { const d = Buffer.alloc(p.length); for (let i = 0; i < p.length; i++) d[i] = p[i] ^ mask[i & 3]; p = d; }
      const op = f & 0xf;
      if (op === 0x8) { try { this.s.destroy(); } catch (e) { } return; }
      if (op === 0x9) continue;
      if (op !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(p.toString('utf8')); } catch (e) { continue; }
      if (msg.id && this.p.has(msg.id)) {
        const q = this.p.get(msg.id); this.p.delete(msg.id);
        if (msg.error) q.rej(new Error(JSON.stringify(msg.error))); else q.res(msg.result || {});
      } else if (msg.method && this.l.has(msg.method)) {
        for (const l of this.l.get(msg.method)) l(msg.params || {});
      }
    }
  }
  close() { try { this.s.destroy(); } catch (e) { } }
}
async function ev(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result && r.result.value;
}
async function wait(cdp, expr, ms) {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) {
    try { if (await ev(cdp, expr)) return true; } catch (e) { }
    await new Promise(r => setTimeout(r, 120));
  }
  return false;
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

/* 页面内一次性装配：隔离的假存储 + 假执行器 + 两个角色。 */
const SETUP = `(function(){
  var CFG_A = { id:'friend_aaa', nickname:'昔涟', provider:'anthropic', model:'claude-x',
    endpoint:'https://example.invalid/a', apiKey:'k1', systemPrompt:'你是昔涟，安静而固执。', relationship:'挚友' };
  var CFG_B = { id:'friend_bbb', nickname:'初音未来', provider:'qwen', model:'qwen-plus',
    endpoint:'https://example.invalid/b', apiKey:'k2', systemPrompt:'你是初音未来，活泼直接。', relationship:'搭档' };
  window.__dm = { msgs:{}, calls:[], lsmirror:{}, cfgs:{ friend_aaa:CFG_A, friend_bbb:CFG_B } };
  window.apiConfigs.length = 0;
  window.apiConfigs.push(CFG_A, CFG_B);
  /* ── 假存储必须**装着**这两个角色（否则「隔离环境」是自相矛盾的）──────────
     这里曾经只往内存数组里 push，而 dbGetAll('apiConfigs') 恒返回空数组。
     两者的差别在"应用自己什么时候重读一次配置"时才显形：social.js 的
     loadApiConfigs() 第一行就是 all = await dbGetAll('apiConfigs')，然后
     apiConfigs = all.filter(a => !a.archived)（social.js:741 / 760）。
     在隔离 profile 里 IndexedDB 是空的 → 任何一次晚到的重读（social.js:777
     renderApiList、1513、2174，或 active-diary/memory/calendar/communication
     的 init 路径）都会把注入的两个角色**抹成空数组**，run 随即以
     missing-character 停在 cfgOf('friend_aaa')。docs/TROUBLESHOOTING.md:167
     把这个坑写得很清楚（"直接 apiConfigs.push() 的测试配置会被冲掉"），
     正确做法是让假存储与注入一致，而不是让应用别重读。

     实测：这个竞态在 HEAD（18ab94d）上同样偶发（3 次里 1 次红），
     与本阶段改动无关；它伪装成「Role DM 坏了」。 */
  window._ibApiReady = function(){ return true; };
  window._ibApiHasCredential = function(){ return true; };
  /* 语义导入：本 smoke 不允许写任何真实存储（Home Node 权威 / IndexedDB 都不碰）。 */
  window.dbPut = function(store, data){
    if (store === 'chatMessages' && data && data.id) window.__dm.msgs[data.id] = data;
    return Promise.resolve();
  };
  window.dbDelete = function(){ return Promise.resolve(); };
  window.dbGetAll = function(store){
    if (store === 'chatMessages') return Promise.resolve(Object.keys(window.__dm.msgs).map(function(k){return window.__dm.msgs[k]}));
    if (store === 'apiConfigs') return Promise.resolve(Object.keys(window.__dm.cfgs).map(function(k){return window.__dm.cfgs[k]}));
    if (store === 'about') return Promise.resolve([{ id:'main', name:'用户' }]);
    return Promise.resolve([]);
  };
  window.dbGetByIndex = function(store, idx, val){
    if (store === 'chatMessages' && idx === 'byFriend') {
      return Promise.resolve(Object.keys(window.__dm.msgs).map(function(k){return window.__dm.msgs[k]}).filter(function(m){return String(m.friendId)===String(val)}));
    }
    return Promise.resolve([]);
  };
  window.dbGet = function(store, id){
    if (store === 'apiConfigs') return Promise.resolve(window.__dm.cfgs[id] || null);
    return Promise.resolve(store==='about'?{id:'about',name:'用户'}:null);
  };
  /* 假执行器：记录每次调用收到的 cfg 与 messages（"两边各调自己的模型"因此可断言）。 */
  window.quickCreateMemory = function(){ return Promise.resolve(null); };
  window.callApiChat = function(cfg, messages, opts){
    /* hist：本条 prompt 里"真正是对话"的那些行（不含 system）。
       用来在真实页面里断言**跨 run 的最近上下文**确实进了第二次 run ——
       这是 Node 单测（mock 全局）证明不了的那一半。 */
    var hist = (messages || []).filter(function(m){ return m && m.role !== 'system'; })
      .map(function(m){ return m.role + '|' + String(m.content == null ? '' : m.content).slice(0, 80); });
    window.__dm.calls.push({ id:String(cfg.id), provider:String(cfg.provider), model:String(cfg.model), consumer:String(opts&&opts._ibConsumer||''), system:String(messages&&messages[0]&&messages[0].content||''), hist:hist });
    /* 与生产 callApiChat 同款形状：wantMeta ⇒ {text,truncated}。
       role-dm 用 truncated 把"输出上限被思考吃光"与"provider 故障"分开，
       替身只回字符串的话，这条生产行为在真实页面里就永远测不到。 */
    var out = '这是' + (cfg.nickname||cfg.id) + '说的第 ' + window.__dm.calls.length + ' 句话。';
    return Promise.resolve((opts && opts.wantMeta) ? { text: out, truncated: false } : out);
  };
  return true;
})()`;

(async () => {
  const watchdog = setTimeout(() => {
    console.error('\nWATCHDOG: role-dm smoke exceeded 120s — unreleased resources: ' +
      (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join(',') : 'n/a'));
    process.exit(1);
  }, 120000);
  watchdog.unref();

  console.log('角色私信 · 最小浏览器 smoke\n');

  const chrome = chromePath();
  if (!chrome) {
    console.log('  ⊘ skipped: no Chrome / Edge found');
    clearTimeout(watchdog);
    process.exitCode = 0;
    return;
  }

  const webSrv = WEB.createWebServer({ port: 0, root: ROOT });
  const webPort = await new Promise((res, rej) => {
    webSrv.once('error', rej);
    webSrv.listen(0, '127.0.0.1', () => res(webSrv.address().port));
  });
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-roledm-chrome-'));
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--force-color-profile=srgb', '--window-size=1200,800',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  const pageErrors = [];
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { const r = await httpJson('http://127.0.0.1:' + cdpPort + '/json/version'); if (r.ok) { ready = true; break; } } catch (e) { }
      await new Promise(r => setTimeout(r, 100));
    }
    check('browser ready', ready);
    if (!ready) throw new Error('Chrome DevTools did not become ready');

    const url = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';
    const tab = (await httpJson('http://127.0.0.1:' + cdpPort + '/json/new?' + encodeURIComponent(url), 'PUT')).json;
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    cdp.on('Runtime.exceptionThrown', p => pageErrors.push(String(p.exceptionDetails && p.exceptionDetails.text || 'exception')));

    check('页面加载完成', await wait(cdp, "document.readyState==='complete' && !!document.getElementById('app')", 25000));

    /* 1) 三个模块都进了真实页面，且前缀与 chat-core 一致 */
    check('1) IBRoleDmCore / IB.roleDm / IB.roleDmUI 都可用',
      await ev(cdp, "!!window.IBRoleDmCore && !!(window.IB&&window.IB.roleDm) && !!(window.IB&&window.IB.roleDmUI)"));
    check('   role-dm 前缀与 chat-core 按值镜像一致',
      await ev(cdp, "window.IBRoleDmCore.ROLE_DM_FRIEND_PREFIX === window.IBChatCore.ROLE_DM_PREFIX && window.IBChatCore.ROLE_DM_PREFIX === 'roledm_'"));
    check('   chat-core 提供 isRoleDmFriendId 判据',
      await ev(cdp, "typeof window.IBChatCore.isRoleDmFriendId==='function' && window.IBChatCore.isRoleDmFriendId('roledm_x')===true && window.IBChatCore.isRoleDmFriendId('friend_aaa')===false"));
    check('   页面容器与导航项存在',
      await ev(cdp, "!!document.getElementById('page-roledm') && !!document.querySelector('a[data-page=\"roledm\"]')"));

    /* 装配隔离环境 */
    check('2) 隔离环境装配成功', await ev(cdp, SETUP));

    /* 3) canonical thread identity：顺序不敏感 */
    const idRes = await ev(cdp, `(async function(){
      var A = window.IB.roleDm;
      var t1 = await A.resolveThread('friend_aaa','friend_bbb');
      var t2 = await A.resolveThread('friend_bbb','friend_aaa');
      var list = await A.listThreads();
      return { same: t1.thread.threadId === t2.thread.threadId, created2: t2.created, n: list.length, fid: t1.thread.threadId,
               parts: t1.thread.participantIds };
    })()`);
    check('3) A/B 与 B/A 解析到同一个 thread', idRes && idRes.same === true, JSON.stringify(idRes));
    check('   第二次不重复创建，索引里只有一条', idRes && idRes.created2 === false && idRes.n === 1, JSON.stringify(idRes));
    check('   participantIds 已 canonicalize', idRes && idRes.parts.join(',') === 'friend_aaa,friend_bbb', JSON.stringify(idRes));
    check('   friendId 是 roledm_ 前缀', idRes && String(idRes.fid).indexOf('roledm_') === 0, idRes && idRes.fid);

    /* 4) 一次真实 run：两个角色各自的模型各被调用 */
    const runRes = await ev(cdp, `(async function(){
      var r = await window.IB.roleDm.start('friend_aaa','friend_bbb',{ turns: 2 });
      var d = await window.IB.roleDm.threadDetail(r.thread.threadId);
      return { ok:r.ok, turns:r.turns, stopReason:r.stopReason, err:r.error||null,
               calls: window.__dm.calls, msgs: Object.keys(window.__dm.msgs).length,
               alloc: (await window.IB.roleDm.listThreads())[0] };
    })()`);
    check('4) run 完成并产生 2 轮', runRes && runRes.ok === true && runRes.turns === 2,
      JSON.stringify(runRes && (runRes.err || runRes.stopReason)));
    check('   恰好两次模型调用', runRes && runRes.calls.length === 2, runRes && runRes.calls.length);
    check('   第一次是 A 的模型、第二次是 B 的模型（不是同一个模型演两个人）',
      runRes && runRes.calls[0].id === 'friend_aaa' && runRes.calls[1].id === 'friend_bbb',
      runRes && JSON.stringify(runRes.calls.map(c => c.id)));
    check('   provider 各自独立（anthropic → qwen）',
      runRes && runRes.calls[0].provider === 'anthropic' && runRes.calls[1].provider === 'qwen',
      runRes && JSON.stringify(runRes.calls.map(c => c.provider)));
    check('   两次都声明 consumer=role_dm',
      runRes && runRes.calls.every(c => c.consumer === 'role_dm'));
    check('   A 侧 prompt 含 A 的人格、不含 B 的人格',
      runRes && runRes.calls[0].system.indexOf('你是昔涟') >= 0 && runRes.calls[0].system.indexOf('你是初音未来') < 0);
    check('   B 侧 prompt 含 B 的人格、不含 A 的人格',
      runRes && runRes.calls[1].system.indexOf('你是初音未来') >= 0 && runRes.calls[1].system.indexOf('你是昔涟') < 0);
    check('   2 条消息落进既有 chatMessages 存储', runRes && runRes.msgs === 2, runRes && runRes.msgs);
    check('   列表里 thread 的消息条数一致', runRes && runRes.alloc.messageCount === 2, runRes && runRes.alloc.messageCount);

    /* 5) UI：导航到角色私信页后渲染成功 + 样式表运行时注入 */
    const uiRes = await ev(cdp, `(async function(){
      location.hash = 'roledm';
      await new Promise(function(r){ setTimeout(r, 400); });
      var page = document.getElementById('page-roledm');
      var list = document.getElementById('roledm-list');
      var link = document.getElementById('ib-role-dm-style');
      return { active: page.classList.contains('active'), rendered: list.innerHTML.indexOf('roledm-item') >= 0,
               items: list.querySelectorAll('.roledm-item').length,
               cssInjected: !!link, cssHref: link ? link.getAttribute('href') : '' };
    })()`);
    check('5) 角色私信页可导航并渲染出会话列表', uiRes && uiRes.active === true && uiRes.items >= 1, JSON.stringify(uiRes));
    check('   样式表运行时注入（不占用 HTML 样式表预算）',
      uiRes && uiRes.cssInjected === true && uiRes.cssHref === 'assets/css/core/role-dm.css', JSON.stringify(uiRes));

    /* 6) 打开详情：不渲染用户输入框（用户不是 participant） */
    const detailRes = await ev(cdp, `(async function(){
      window.IB.roleDmUI.openThread((await window.IB.roleDm.listThreads())[0].threadId);
      await new Promise(function(r){ setTimeout(r, 300); });
      var body = document.getElementById('roledm-detail-body');
      var ctl = document.getElementById('roledm-detail-controls');
      return { bubbles: body.querySelectorAll('.roledm-msg').length,
               hasStart: !!document.getElementById('roledm-start-btn'),
               hasStop: !!document.getElementById('roledm-stop-btn'),
               hasInput: !!document.getElementById('roledm-detail-controls').querySelector('textarea'),
               hasTopic: !!document.getElementById('roledm-topic'),
               hasClear: !!document.getElementById('roledm-clear-btn'),
               hasDelete: !!document.getElementById('roledm-del-btn') };
    })()`);
    check('6) 详情渲染出 2 条消息气泡', detailRes && detailRes.bubbles === 2, JSON.stringify(detailRes));
    check('   控制条是「让她们聊一会儿 / 停止 / 给话题」而不是用户输入框',
      detailRes && detailRes.hasStart && detailRes.hasStop && detailRes.hasTopic && detailRes.hasInput === false, JSON.stringify(detailRes));
    check('   破坏性动作独立成按钮（清空聊天记录 / 删除这段私聊）',
      detailRes && detailRes.hasClear && detailRes.hasDelete);

    /* 7) 跨 run 的最近上下文 + 层④ 的 thread memorandum（真实页面链路）─────
       第一条断言专门回答 Phase 1 报告里那个 "new run → history = 0" 的说法：
       在**真实页面**上再跑一次 run，它的第一条 prompt 必须已经带着上一次
       run 说过的话。第二条验证层④：攒够窗口外的旧消息后，备忘产生、A 与 B
       读到**同一份**、且它不进 system 的规则区、也不带来任何额外模型调用。 */
    const crossRes = await ev(cdp, `(async function(){
      var A = window.IB.roleDm, C = window.IBRoleDmCore;
      var before = window.__dm.calls.length;
      /* 冷却用 force 绕过：这里要测的是跨 run 读取，不是冷却。 */
      var r2 = await A.start('friend_aaa','friend_bbb',{ turns: 2, force: true });
      var newCalls = window.__dm.calls.slice(before);
      var first = newCalls[0] || { hist: [] };
      var joined = (first.hist || []).join(' \\u0001 ');
      return { ok: r2.ok, turns: r2.turns, n: newCalls.length,
               sawOwn: joined.indexOf('这是昔涟说的第 1 句话。') >= 0,
               sawPeer: joined.indexOf('这是初音未来说的第 2 句话。') >= 0,
               histRows: (first.hist || []).length };
    })()`);
    check('7) 第二次 run 的第一条 prompt 带着上一次 run 说过的话（跨 run 最近上下文）',
      crossRes && crossRes.sawOwn === true, JSON.stringify(crossRes));
    check('   对方说过的话也在（以「名字」对你说 的形式）', crossRes && crossRes.sawPeer === true);
    check('   两次 run 共 4 条消息，各 2 轮', crossRes && crossRes.n === 2 && crossRes.turns === 2, JSON.stringify(crossRes));

    const memoRes = await ev(cdp, `(async function(){
      var A = window.IB.roleDm, C = window.IBRoleDmCore;
      var fid = C.roleDmFriendId('friend_aaa','friend_bbb');
      var t = await A.resolveThread('friend_aaa','friend_bbb');
      /* 直接用 canonical 构造器把"更早的历史"落进假存储（不经过模型）。 */
      var base = 1700000000000;
      for (var i = 0; i < 24; i++) {
        var sender = i % 2 === 0 ? 'friend_aaa' : 'friend_bbb';
        var m = C.buildRoleDmMessage({ senderId: sender, recipientId: (sender === 'friend_aaa' ? 'friend_bbb' : 'friend_aaa'),
          senderName: (sender === 'friend_aaa' ? '昔涟' : '初音未来'), content: '共同历史第' + i + '条', timestamp: base + i * 1000 });
        window.__dm.msgs[m.id] = m;
      }
      var callsBefore = window.__dm.calls.length;
      var up = await A._updateMemorandum(t.thread);
      var sa = await A._composeSide('friend_aaa','friend_bbb', t.thread, { history: [] });
      var sb = await A._composeSide('friend_bbb','friend_aaa', t.thread, { history: [] });
      var pick = function(b){
        var s = b.messages.map(function(m){ return String(m.content); }).join('\\n');
        var i = s.indexOf('【你们之前的共同经历');
        return i < 0 ? '' : s.slice(i, i + 600);
      };
      return { updated: up.updated, reason: up.reason, covered: up.coveredMessages, summaryCalls: up.summaryCalls,
               extraCalls: window.__dm.calls.length - callsBefore,
               memoA: pick(sa), memoB: pick(sb),
               inSystem: sa.system.indexOf('【你们之前的共同经历') >= 0,
               hasOld: pick(sa).indexOf('共同历史第0条') >= 0,
               leaksRecent: pick(sa).indexOf('共同历史第23条') >= 0 };
    })()`);
    check('8) 攒够窗口外的旧消息后产生 thread memorandum（fold）',
      memoRes && memoRes.updated === true && memoRes.reason === 'fold', JSON.stringify(memoRes && memoRes.reason));
    check('   备忘覆盖了窗口外的旧消息，且**不含**最近窗口的原文',
      memoRes && memoRes.hasOld === true && memoRes.leaksRecent === false, JSON.stringify(memoRes && { hasOld: memoRes.hasOld, leaksRecent: memoRes.leaksRecent }));
    check('   A 与 B 读到的共同经历块**逐字相同**（同一份，无方向性）',
      memoRes && memoRes.memoA !== '' && memoRes.memoA === memoRes.memoB, JSON.stringify(memoRes && { a: memoRes.memoA.length, b: memoRes.memoB.length }));
    check('   备忘不进 system 的规则区（authority 更低）', memoRes && memoRes.inSystem === false);
    check('   备忘不带来任何额外模型调用（producer=deterministic）',
      memoRes && memoRes.extraCalls === 0 && memoRes.summaryCalls === 0, JSON.stringify(memoRes && { extra: memoRes.extraCalls, s: memoRes.summaryCalls }));

    /* 9) 全程没有未捕获异常 */
    await new Promise(r => setTimeout(r, 600));
    check('9) 全程无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    if (cdp) cdp.close();
    try { browser.kill(); } catch (e) { }
    await new Promise(r => {
      if (!browser || browser.exitCode !== null || browser.signalCode) return r();
      const fallback = setTimeout(r, 5000);
      browser.once('exit', () => { clearTimeout(fallback); r(); });
    });
    await new Promise(r => { const fallback = setTimeout(r, 2000); webSrv.close(() => { clearTimeout(fallback); r(); }); });
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.log('  (note) temp dir left behind (not a failure): ' + profile); }
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => {
    console.error('\nLEAK: event loop still alive 5s after the smoke finished — unreleased resources: ' +
      (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join(',') : 'n/a'));
    process.exit(2);
  }, 5000).unref();
})().catch(e => {
  console.error('UNEXPECTED FAILURE: ' + (e && e.stack || e));
  process.exitCode = 1;
});


