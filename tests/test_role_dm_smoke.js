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
/* This smoke exercises Role DM only. Keep the static server's unrelated update route
   offline too, so its background check cannot leave a network socket after the test. */
const NO_NETWORK_UPDATE_CHECK = {
  STATUS_NO_INFORMATION: 'no-information',
  checkShared: async () => ({
    ok: false, status: 'no-information', updateAvailable: false,
    currentVersion: '', latestVersion: '', fromCache: false, transport: '',
    checkedAt: '', error: { kind: 'test-disabled', message: 'network disabled in Role DM smoke' }, update: null
  }),
  summarize: result => result,
  readCache: () => ({ hit: false })
};

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
  window.__dm = { msgs:{}, calls:[], lsmirror:{}, quoteMode:false, cfgs:{ friend_aaa:CFG_A, friend_bbb:CFG_B } };
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
  window._persistApiConfig = function(cfg){window.__dm.cfgs[cfg.id]=cfg;return Promise.resolve({idb:true,backend:'test'});};
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
       替身只回字符串的话，这条生产行为在真实页面里就永远测不到。
       __dm.outputFail = 'truncated' | 'empty' ⇒ 模拟"请求成功但没有正文"
       （Phase 3.1 的输出类失败，两种形态各一个）。 */
    if (window.__dm.outputFail) {
      var _of = window.__dm.outputFail;
      return Promise.resolve((opts && opts.wantMeta) ? { text: '', truncated: _of === 'truncated' } : '');
    }
    var out = '这是' + (cfg.nickname||cfg.id) + '说的第 ' + window.__dm.calls.length + ' 句话。';
    if (window.__dm.quoteMode === true && String(cfg.id) === 'friend_aaa') {
      var rows=Object.keys(window.__dm.msgs).map(function(k){return window.__dm.msgs[k]}).filter(function(m){return m.friendId&&String((m.metadata||{}).senderId||'')==='friend_bbb'}).sort(function(a,b){return Number(a.timestamp)-Number(b.timestamp)});
      var source=rows[rows.length-1];
      if(source)out='[role_dm:speak]\\n我记得你刚才说的。[[quote:Q1.1]]';
    }
     if (window.__dm.expressionMode === true) {
       out = String(cfg.id) === 'friend_aaa'
         ? '[[expression:happy]]太好了，真替你开心。\\n[[ib:message]]\\n[[expression:laugh]]哈哈，这下放心了。'
         : '[[expression:sad]]这听起来真遗憾。';
     }
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

  const webSrv = WEB.createWebServer({ port: 0, root: ROOT, updateCheck: NO_NETWORK_UPDATE_CHECK });
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

    const initiativeSettingsUi = await ev(cdp, `(function(){
      var api=window.IB.roleDm, ui=window.IB.roleDmUI, social=window.IB.roleDmSocial;
      ui.renderReplyInitiative();
      var host=document.getElementById('roledm-reply-initiative-body');
      var row=host&&host.querySelector('[data-char="friend_aaa"]');
      var enabled=row&&row.querySelector('[data-role="enabled"]');
      var supplement=row&&row.querySelector('[data-role="supplement"]');
      var frequency=row&&row.querySelector('[data-role="frequency"]');
      var before=api.replyInitiativePrefs('friend_aaa');
      var socialBefore=social&&social.characterPrefs?JSON.stringify(social.characterPrefs('friend_aaa')):'';
      if(enabled){enabled.checked=true;enabled.dispatchEvent(new Event('change',{bubbles:true}));}
      if(supplement){supplement.checked=false;supplement.dispatchEvent(new Event('change',{bubbles:true}));}
      var saved=api.replyInitiativePrefs('friend_aaa');
      var socialAfter=social&&social.characterPrefs?JSON.stringify(social.characterPrefs('friend_aaa')):'';
      api.setReplyInitiativePrefs('friend_aaa',{enabled:false,frequency:'low',types:{supplement:true,contextLink:true,careNudge:true}});
      ui.renderReplyInitiative();
      return {panel:!!host,row:!!row,defaultOff:!!before&&!before.enabled,low:!!frequency&&frequency.value==='low',
        categories:!!(row&&row.querySelector('[data-role="contextLink"]')&&row.querySelector('[data-role="careNudge"]')),
        saves:!!saved&&saved.enabled===true&&saved.types.supplement===false,
        existingSchedulerUnchanged:!socialBefore||socialBefore===socialAfter,
        restored:api.replyInitiativePrefs('friend_aaa').enabled===false};
    })()`);
    check('2a) 回复内主动表达设置按角色保存，默认关闭，且与现有主动私聊调度隔离',
      initiativeSettingsUi && initiativeSettingsUi.panel && initiativeSettingsUi.row && initiativeSettingsUi.defaultOff
        && initiativeSettingsUi.low && initiativeSettingsUi.categories && initiativeSettingsUi.saves
        && initiativeSettingsUi.existingSchedulerUnchanged && initiativeSettingsUi.restored,
      JSON.stringify(initiativeSettingsUi));

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
      var turnTraces = IBModelCore.turnTraceRecent(10).filter(function(t){return t.consumer==='role_dm'});
      return { ok:r.ok, turns:r.turns, stopReason:r.stopReason, err:r.error||null,
               calls: window.__dm.calls, msgs: Object.keys(window.__dm.msgs).length,
               alloc: (await window.IB.roleDm.listThreads())[0], turnTraces:turnTraces };
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
    check('   手动 Role DM 的实际 provider prompt 包含当前线程连续性规则',
      runRes && runRes.calls.every(function(c){return c.system.indexOf('【Conversation State v1 · 当前 thread】') >= 0
        && c.system.indexOf('不重复询问或机械追问') >= 0 && c.system.indexOf('不复述、回顾或机械总结') >= 0}));
    check('   2 条消息落进既有 chatMessages 存储', runRes && runRes.msgs === 2, runRes && runRes.msgs);
    check('   列表里 thread 的消息条数一致', runRes && runRes.alloc.messageCount === 2, runRes && runRes.alloc.messageCount);
    check('   Turn Trace 覆盖输入、上下文、记忆、工具边界与结果', runRes && runRes.turnTraces.length === 2
      && runRes.turnTraces.every(function(t){var types=t.events.map(function(e){return e.eventType});
        return ['input','memory','middle_brain','context','tool_execution','result'].every(function(type){return types.indexOf(type)>=0})}));

    /* P3.1 · Real Role DM run chooses a request-local source key; persisted metadata
       keeps the canonical source ID, exact text, and verified peer identity. */
    const quoteRun = await ev(cdp, `(async function(){
      var A=window.IB.roleDm,tid=(await A.listThreads())[0].threadId,before=window.__dm.calls.length;
      window.__dm.quoteMode=true;
      var res=await A.start('friend_aaa','friend_bbb',{turns:2,force:true});
      window.__dm.quoteMode=false;
      var d=await A.threadDetail(tid),reply=d.messages.find(function(m){return !!m.replyQuote});
      var source=reply.replyQuote&&d.messages.find(function(m){return m.id===reply.replyQuote.sourceMessageId});
      return {ok:res.ok,turns:res.turns,calls:window.__dm.calls.length-before,reply:reply,source:source||null};
    })()`);
    check('4b) Role DM quote selection adds no model call beyond the existing two-turn run', quoteRun && quoteRun.ok === true
      && quoteRun.turns === 2 && quoteRun.calls === 2 && quoteRun.source
      && quoteRun.reply.replyQuote.sourceMessageId === quoteRun.source.id
      && quoteRun.reply.replyQuote.snippet === quoteRun.source.content
      && quoteRun.reply.replyQuote.sourceSenderKey === 'role:friend_bbb', JSON.stringify(quoteRun));

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

    /* A direct reload can route into Role DM before the async API-config bootstrap
       has populated its live list. Opening the existing thread must refresh that
       canonical list before projecting participants as deleted. */
    const roleConfigRefresh = await ev(cdp, `(async function(){
      var saved=Array.isArray(window.apiConfigs)?window.apiConfigs.slice():[];
      var oldLoader=window.loadApiConfigs,loads=0;
      window.apiConfigs=[];
      window.loadApiConfigs=async function(){loads++;window.apiConfigs=saved;return saved;};
      var thread=(await window.IB.roleDm.listThreads())[0];
      await window.IB.roleDmUI.openThread(thread.threadId);
      var head=document.getElementById('roledm-detail-head');
      var start=document.getElementById('roledm-start-btn');
      var result={loads:loads,hasDeletedLabel:!!(head&&head.textContent.indexOf('角色已删除')>=0),hasSavedNames:!!(head&&saved.slice(0,2).some(function(c){return c.nickname&&head.textContent.indexOf(c.nickname)>=0;})),startEnabled:!!(start&&!start.disabled)};
      window.loadApiConfigs=oldLoader;window.apiConfigs=saved;
      await window.IB.roleDmUI.render();
      return result;
    })()`);
    check('5b) Role DM refreshes API configs before rendering participants as deleted',
      roleConfigRefresh && roleConfigRefresh.loads === 1 && roleConfigRefresh.hasDeletedLabel === false
        && roleConfigRefresh.hasSavedNames === true && roleConfigRefresh.startEnabled === true, JSON.stringify(roleConfigRefresh));

    /* 6) 打开详情：不渲染用户输入框（用户不是 participant） */
    const detailRes = await ev(cdp, `(async function(){
      window.IB.roleDmUI.openThread((await window.IB.roleDm.listThreads())[0].threadId);
      await new Promise(function(r){ setTimeout(r, 300); });
      var body = document.getElementById('roledm-detail-body');
      var quote = body.querySelector('.ib-reply-quote-card[data-quote-target]');
      if (quote) quote.click();
      var sourceRow = quote && body.querySelector('.roledm-msg[data-message-id="'+quote.getAttribute('data-quote-target')+'"]');
      var ctl = document.getElementById('roledm-detail-controls');
      return { bubbles: body.querySelectorAll('.roledm-msg').length,
               quoteCard: !!quote && quote.textContent.indexOf('这是初音未来说的第 2 句话。') >= 0,
               quoteLocatesSource: !!sourceRow && sourceRow.classList.contains('ib-reply-quote-target'),
               hasStart: !!document.getElementById('roledm-start-btn'),
               hasStop: !!document.getElementById('roledm-stop-btn'),
               hasInput: !!document.getElementById('roledm-detail-controls').querySelector('textarea'),
               hasTopic: !!document.getElementById('roledm-topic'),
               hasClear: !!document.getElementById('roledm-clear-btn'),
               hasDelete: !!document.getElementById('roledm-del-btn') };
    })()`);
    check('6) 详情渲染出引用卡并点击定位原角色消息', detailRes && detailRes.bubbles === 4
      && detailRes.quoteCard === true && detailRes.quoteLocatesSource === true, JSON.stringify(detailRes));
    check('   控制条是「让她们聊一会儿 / 停止 / 给话题」而不是用户输入框',
      detailRes && detailRes.hasStart && detailRes.hasStop && detailRes.hasTopic && detailRes.hasInput === false, JSON.stringify(detailRes));
    check('   破坏性动作独立成按钮（清空聊天记录 / 删除这段私聊）',
      detailRes && detailRes.hasClear && detailRes.hasDelete);

    /* Expression Pack selection is a role-config reference; the Role DM message
       stays untouched while its selected image is rendered beside the bubble. */
    const expressionRes = await ev(cdp, `(async function(){
      var Core=window.IBExpressionPackCore,cfg=window.__dm.cfgs.friend_aaa,canvas=document.createElement('canvas');
      canvas.width=canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);
      cfg=Core.addPack(cfg,'dm-expression-pack','DM 表情');
      cfg=Core.addExpression(cfg,'dm-expression-pack',{id:'dm-smile',name:'微笑',dataUrl:canvas.toDataURL('image/webp')});
      cfg=Core.setExpressionDefaults(cfg,{
        neutralExpression:{packId:'dm-expression-pack',expressionId:'dm-smile'},
        greetingExpression:{packId:'dm-expression-pack',expressionId:'dm-smile'},
        typingExpression:{packId:'dm-expression-pack',expressionId:'dm-smile'},
        voiceExpression:{packId:'dm-expression-pack',expressionId:'dm-smile'},
        errorExpression:{packId:'dm-expression-pack',expressionId:'dm-smile'}
      });
      await window._persistApiConfig(cfg);await window.loadApiConfigs();await window.IB.roleDmUI.renderDetail();
      var row=document.querySelector('#roledm-detail-body .roledm-msg.left[data-message-id]');
      var messageId=row&&row.getAttribute('data-message-id'),trigger=row&&row.querySelector('.ib-expression-message-trigger');
      var neutralImage=row&&row.querySelector('.ib-expression-message-image');
      var neutralDefault=Core.defaultExpression(cfg,'neutralExpression');
      var neutral=!!(neutralImage&&neutralDefault&&neutralImage.src===neutralDefault.expression.dataUrl);
      var greeting=!!document.querySelector('#roledm-detail-head .ib-expression-state[data-expression-state="greetingExpression"] img');
      if(trigger)trigger.click();
      var choice=row&&row.querySelector('.ib-expression-choice[aria-label^="显示表情：微笑"]');
      if(choice)choice.click();
      var until=Date.now()+5000;
      while(Date.now()<until){var stored=window.__dm.cfgs.friend_aaa.expressionAssignments||{};if(stored[messageId])break;await new Promise(function(resolve){setTimeout(resolve,40)});}
      await window.IB.roleDmUI.renderDetail();
      var thread=(await window.IB.roleDm.listThreads())[0];
      window.IB.roleDmEmit('delivery',{threadId:thread.threadId,typing:true,speakerId:'friend_aaa',speakerName:'昔涟'});
      var typing=!!document.querySelector('#roledm-detail-note .ib-expression-state[data-expression-state="typingExpression"] img');
      window.IB.roleDmEmit('delivery',{threadId:thread.threadId,typing:false,speakerId:'friend_aaa',speakerName:'昔涟'});
      var finalRow=document.querySelector('#roledm-detail-body .roledm-msg.left[data-message-id="'+messageId+'"]');
      var storedMessage=window.__dm.msgs[messageId],assignment=window.__dm.cfgs.friend_aaa.expressionAssignments[messageId];
      return {packButton:!!document.querySelector('#roledm-detail-head [data-expression-role-id="friend_aaa"]'),
        selected:!!assignment&&assignment.expressionId==='dm-smile',display:!!(finalRow&&finalRow.querySelector('.ib-expression-message-image')),
        neutral:neutral,greeting:greeting,typing:typing,
        messageUnchanged:!!storedMessage&&!storedMessage.expression&&!storedMessage.expressionId&&String(storedMessage.content).indexOf('data:image')<0};
    })()`);
    check('6a) Role DM binds a character pack and displays a manually selected expression',
      expressionRes && expressionRes.packButton && expressionRes.selected && expressionRes.display
        && expressionRes.neutral && expressionRes.greeting && expressionRes.typing, JSON.stringify(expressionRes));
    check('    expression reference stays in role config, not chatMessages', expressionRes && expressionRes.messageUnchanged, JSON.stringify(expressionRes));

    const expressionRuntimeRes = await ev(cdp, `(async function(){
      var Core=window.IBExpressionPackCore,api=window.IB.roleDm,ui=window.IB.roleDmUI;
      var cfgA=window.__dm.cfgs.friend_aaa,cfgB=window.__dm.cfgs.friend_bbb,canvas=document.createElement('canvas');
      canvas.width=canvas.height=16;var ctx=canvas.getContext('2d');ctx.fillStyle='#91c3ee';ctx.fillRect(0,0,16,16);var happy=canvas.toDataURL('image/webp');
      ctx.fillStyle='#e9a9ba';ctx.fillRect(0,0,16,16);var laugh=canvas.toDataURL('image/webp');
      ctx.fillStyle='#a9b4d4';ctx.fillRect(0,0,16,16);var sad=canvas.toDataURL('image/webp');
      cfgA=Core.addExpression(cfgA,'dm-expression-pack',{id:'dm-happy',name:'开心',dataUrl:happy});
      cfgA=Core.addExpression(cfgA,'dm-expression-pack',{id:'dm-laugh',name:'哈哈',dataUrl:laugh});
      cfgA=Core.setSettings(cfgA,{enabled:true,modelTags:true,microMotion:true});
      cfgB=Core.addPack(cfgB,'dm-expression-pack-b','B 表情');
      cfgB=Core.addExpression(cfgB,'dm-expression-pack-b',{id:'dm-sad',name:'难过',dataUrl:sad});
      cfgB=Core.setSettings(cfgB,{enabled:true,modelTags:true,microMotion:true});
      await window._persistApiConfig(cfgA);await window._persistApiConfig(cfgB);await window.loadApiConfigs();
      var before=Object.keys(window.__dm.msgs).length,callsBefore=window.__dm.calls.length,run=null;
      window.__dm.expressionMode=true;
      try{run=await api.start('friend_aaa','friend_bbb',{turns:2,force:true})}finally{window.__dm.expressionMode=false}
      await ui.renderDetail();
      var fresh=Object.keys(window.__dm.msgs).map(function(k){return window.__dm.msgs[k]}).filter(function(m){return m&&m.metadata&&m.metadata.senderId&&['friend_aaa','friend_bbb'].indexOf(m.metadata.senderId)>=0&&String(m.content||'').indexOf('[[expression:')<0})
        .sort(function(a,b){return Number(a.timestamp)-Number(b.timestamp)}).slice(-3);
      function view(message){var row=message&&document.querySelector('.roledm-msg[data-message-id="'+message.id+'"]'),display=row&&row.querySelector('.ib-expression-message-display');return {message:message,source:display&&display.dataset.expressionSource,label:display&&display.querySelector('.ib-expression-message-caption')&&display.querySelector('.ib-expression-message-caption').textContent,src:display&&display.querySelector('img')&&display.querySelector('img').src};}
      var expectedHappy=Core.resolveExpressionTag(cfgA,'happy');
      var a1=view(fresh.find(function(m){return m.metadata.senderId==='friend_aaa'&&String(m.content).indexOf('太好了')===0}));
      var a2=view(fresh.find(function(m){return m.metadata.senderId==='friend_aaa'&&String(m.content).indexOf('哈哈')===0}));
      var b=view(fresh.find(function(m){return m.metadata.senderId==='friend_bbb'&&String(m.content).indexOf('这听起来')===0}));
      var calls=window.__dm.calls.slice(callsBefore);
      return {ok:!!(run&&run.ok),calls:calls.length,hintCalls:calls.filter(function(c){return c.system.indexOf('[[expression:happy]]')>=0}).length,count:fresh.length,a1:a1.source==='model'&&expectedHappy&&a1.src===expectedHappy.expression.dataUrl,a1Label:a1.label,a2:a2.source==='model'&&a2.label==='哈哈',b:b.source==='model'&&b.label==='难过',clean:fresh.length===3&&fresh.every(function(m){return String(m.content).indexOf('[[expression:')<0&&!Object.prototype.hasOwnProperty.call(m,'expressionRef')})};
    })()`);
    check('6a-1) Role DM resolves optional expression markers independently per role and bubble',
      expressionRuntimeRes && expressionRuntimeRes.ok && expressionRuntimeRes.count===3 && expressionRuntimeRes.a1 && expressionRuntimeRes.a2 && expressionRuntimeRes.b,
      JSON.stringify(expressionRuntimeRes));
    check('    optional Expression hints reuse the existing two provider calls', expressionRuntimeRes && expressionRuntimeRes.calls===2 && expressionRuntimeRes.hintCalls===2, JSON.stringify(expressionRuntimeRes));
    check('    marker references stay out of persisted Role DM messages', expressionRuntimeRes && expressionRuntimeRes.clean, JSON.stringify(expressionRuntimeRes));

    const roleDmVoiceRes = await ev(cdp, `(async function(){
      var cfgA=window.__dm.cfgs.friend_aaa,cfgB=window.__dm.cfgs.friend_bbb;
      var oldA=cfgA.voice?JSON.parse(JSON.stringify(cfgA.voice)):null,oldB=cfgB.voice?JSON.parse(JSON.stringify(cfgB.voice)):null;
      var noVoiceBefore=!document.querySelector('.roledm-voice-btn');
      cfgA.voice={enabled:true,source:'edge',provider:'edge',voiceId:'role-a-voice',rate:1,pitch:'+0Hz',autoPlay:false};
      cfgB.voice={enabled:true,source:'voicebox',provider:'voicebox',voiceId:'role-b-profile',model:'voicebox-clone',voiceType:'clone',voiceData:{refAudioId:'role-b-ref'},autoPlay:false};
      await window._persistApiConfig(cfgA);await window._persistApiConfig(cfgB);await window.loadApiConfigs();await window.IB.roleDmUI.renderDetail();
      var rows=Array.prototype.slice.call(document.querySelectorAll('#roledm-detail-body .roledm-msg[data-message-id]'));
      var rowA=null,rowB=null;
      rows.forEach(function(row){var m=window.__dm.msgs[row.getAttribute('data-message-id')];if(!m)return;
        if(m.metadata.senderId==='friend_aaa'&&!rowA)rowA=row;
        if(m.metadata.senderId==='friend_bbb'&&!rowB)rowB=row;});
      var calls=[],statePaths={a:[],b:[]},api=window.IB.bridge,ui=window.IB.roleDmUI,realSpeak=api&&api.speakText,active=null;
      if(api)api.speakText=function(text,voice,host,button,onStatus){var row=host&&host.closest('.roledm-msg'),message=row&&window.__dm.msgs[row.getAttribute('data-message-id')],key=message&&message.metadata.senderId==='friend_aaa'?'a':'b';if(active&&active.onStatus)active.onStatus('interrupted');var current={text:String(text),voice:voice,bubble:host,onStatus:onStatus,key:key};calls.push(current);active=current;onStatus('generating');statePaths[key].push(row&&row.dataset.voiceStatus);onStatus('playing');statePaths[key].push(row&&row.dataset.voiceStatus);return true;};
      try{
        var buttonA=rowA&&rowA.querySelector('.roledm-voice-btn'),buttonB=rowB&&rowB.querySelector('.roledm-voice-btn');
        if(buttonA)buttonA.click();var aStateBeforeB=rowA&&rowA.dataset.voiceStatus,aExprBeforeB=rowA&&rowA.querySelector('.ib-expression-message-display');var speakingExpression=aStateBeforeB==='speaking'&&!!aExprBeforeB&&aExprBeforeB.dataset.expressionState==='voiceExpression';if(buttonB)buttonB.click();
        var aMsg=rowA&&window.__dm.msgs[rowA.getAttribute('data-message-id')],bMsg=rowB&&window.__dm.msgs[rowB.getAttribute('data-message-id')];
        var aExpr=rowA&&rowA.querySelector('.ib-expression-message-display');
        var aVoiceState=rowA&&rowA.querySelector('.roledm-voice-state'),bVoiceState=rowB&&rowB.querySelector('.roledm-voice-state');
        var aStatus=aVoiceState&&aVoiceState.textContent,bStatus=bVoiceState&&bVoiceState.textContent;
        var speakerSwitchIsolated=rowA&&rowA.dataset.voiceStatus==='interrupted'&&rowB&&rowB.dataset.voiceStatus==='speaking';
        if(ui&&typeof ui.stopVoicePlayback==='function')ui.stopVoicePlayback();
        var pageStopRestoresBoth=rowA&&rowA.dataset.voiceStatus==='interrupted'&&rowB&&rowB.dataset.voiceStatus==='interrupted';
        var interruptExpression=rowA&&rowA.querySelector('.ib-expression-message-display');
        var interruptUsesDefault=!!interruptExpression&&interruptExpression.dataset.expressionState==='neutralExpression';
        if(calls[0])calls[0].onStatus('ended');if(calls[1])calls[1].onStatus('ended');
        var restored=rowA&&rowA.querySelector('.ib-expression-message-display');
        return {noVoiceBefore:noVoiceBefore,buttons:!!buttonA&&!!buttonB,isolated:calls.length===2
          && calls[0].voice.voiceId==='role-a-voice'&&calls[1].voice.voiceId==='role-b-profile'
          && calls[0].voice.provider==='edge'&&calls[1].voice.provider==='voicebox',
          statePaths:statePaths,
          speakerSwitchIsolated:speakerSwitchIsolated,
          pageStopRestoresBoth:pageStopRestoresBoth,
          interruptUsesDefault:interruptUsesDefault,
          speakingExpression:speakingExpression,
          restoresDefault:!!restored&&restored.dataset.expressionState==='manual',
          statuses:aStatus==='语音已中断'&&bStatus==='正在播放',
          messageProtocolUnchanged:!!aMsg&&!!bMsg&&!aMsg.voice&&!bMsg.voice
            && calls[0].text===aMsg.content&&calls[1].text===bMsg.content};
      }finally{
        if(api)api.speakText=realSpeak;
        if(oldA)cfgA.voice=oldA;else delete cfgA.voice;
        if(oldB)cfgB.voice=oldB;else delete cfgB.voice;
        await window._persistApiConfig(cfgA);await window._persistApiConfig(cfgB);await window.loadApiConfigs();await window.IB.roleDmUI.renderDetail();
      }
    })()`);
    check('6a-2) Role DM voice playback uses each sender role Voice Profile and follows Expression Runtime states',
      roleDmVoiceRes && roleDmVoiceRes.noVoiceBefore && roleDmVoiceRes.buttons && roleDmVoiceRes.isolated
        && JSON.stringify(roleDmVoiceRes.statePaths)===JSON.stringify({a:['thinking','speaking'],b:['thinking','speaking']})
        && roleDmVoiceRes.speakerSwitchIsolated && roleDmVoiceRes.pageStopRestoresBoth && roleDmVoiceRes.interruptUsesDefault
        && roleDmVoiceRes.speakingExpression && roleDmVoiceRes.restoresDefault && roleDmVoiceRes.statuses
        && roleDmVoiceRes.messageProtocolUnchanged, JSON.stringify(roleDmVoiceRes));

    const roleDmReplayRes = await ev(cdp, `(async function(){
      var ui=window.IB.roleDmUI,api=window.IB.roleDm,bridge=window.IB.bridge;
      var cfgA=window.__dm.cfgs.friend_aaa,cfgB=window.__dm.cfgs.friend_bbb;
      var oldA=JSON.parse(JSON.stringify(cfgA)),oldB=JSON.parse(JSON.stringify(cfgB));
      var realSpeak=bridge.speakText,calls=[];
      function waitFor(test){return new Promise(function(resolve){var until=Date.now()+3500;(function poll(){if(test())return resolve(true);if(Date.now()>until)return resolve(false);setTimeout(poll,15)})()})}
      try{
        cfgA.voice={enabled:true,source:'edge',provider:'edge',voiceId:'replay-a-voice',rate:1,pitch:'+0Hz'};
        cfgB.voice={enabled:true,source:'voicebox',provider:'voicebox',voiceId:'replay-b-profile',model:'voicebox-clone',voiceType:'clone',voiceData:{refAudioId:'replay-b-ref'}};
        var Core=window.IBExpressionPackCore,canvas=document.createElement('canvas');canvas.width=canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);
        cfgB=Core.addPack(cfgB,'replay-expression-pack','回放表情');
        cfgB=Core.addExpression(cfgB,'replay-expression-pack',{id:'replay-face',name:'回放表情',dataUrl:canvas.toDataURL('image/webp')});
        cfgB=Core.setExpressionDefaults(cfgB,{neutralExpression:{packId:'replay-expression-pack',expressionId:'replay-face'},voiceExpression:{packId:'replay-expression-pack',expressionId:'replay-face'}});
        await window._persistApiConfig(cfgA);await window._persistApiConfig(cfgB);await window.loadApiConfigs();
        await ui.renderDetail();
        var tid=ui.activeThreadId(),before=await api.threadDetail(tid);
        var expected=before.messages.filter(function(m){return !!String(m.content||'').trim()}).map(function(m){return {id:m.id,senderId:m.senderId,content:m.content}});
        bridge.speakText=function(text,voice,bubble,button,onStatus,control){calls.push({text:String(text),voice:voice,bubble:bubble,control:control,onStatus:onStatus});onStatus('generating');return true};
        var controls=!!document.getElementById('roledm-replay-start')&&!!document.getElementById('roledm-replay-pause')&&!!document.getElementById('roledm-replay-resume')&&!!document.getElementById('roledm-replay-stop')&&!!document.getElementById('roledm-replay-status');
        var replayStartButton=document.getElementById('roledm-replay-start');if(replayStartButton)replayStartButton.click();
        var gotFirst=await waitFor(function(){return calls.length===1});
        if(gotFirst){
          calls[0].onStatus('playing');
          var firstRow=calls[0].bubble.closest('.roledm-msg'),firstExpression=firstRow&&firstRow.querySelector('.ib-expression-message-display');
          var speaking=!!firstExpression&&firstExpression.dataset.expressionState==='voiceExpression';
          var pauseButton=document.getElementById('roledm-replay-pause'),resumeButton=document.getElementById('roledm-replay-resume');
          if(pauseButton)pauseButton.click();
          var pauseWorks=document.getElementById('roledm-replay-status').dataset.state==='paused'&&pauseButton.disabled===true&&resumeButton.disabled===false;
          if(resumeButton)resumeButton.click();
          var resumeWorks=document.getElementById('roledm-replay-status').dataset.state==='playing'&&pauseButton.disabled===false&&resumeButton.disabled===true;
          calls[0].onStatus('ended');
          for(var i=1;i<expected.length;i++){
            var got=await waitFor(function(){return calls.length>i});if(!got)break;
            calls[i].onStatus('playing');calls[i].onStatus('ended');
          }
          await waitFor(function(){return /回放完成/.test(document.getElementById('roledm-replay-status').textContent)});
          var replayDetail=await api.threadDetail(tid),idsInOrder=calls.map(function(c){var row=c.bubble.closest('.roledm-msg');return row&&row.getAttribute('data-message-id')});
          var voicesIsolated=calls.length===expected.length&&calls.every(function(c,i){return c.text===expected[i].content&&c.voice.voiceId===(expected[i].senderId==='friend_aaa'?'replay-a-voice':'replay-b-profile')});
          var messageUnchanged=JSON.stringify(replayDetail.messages.map(function(m){return {id:m.id,content:m.content}}))===JSON.stringify(before.messages.map(function(m){return {id:m.id,content:m.content}}))
            && replayDetail.messages.every(function(m){var raw=window.__dm.msgs[m.id];return !!raw&&!raw.voice});
          var endedExpression=firstRow&&firstRow.querySelector('.ib-expression-message-display');
          var resetExpression=!!endedExpression&&endedExpression.dataset.expressionState!=='voiceExpression';
        }else{var speaking=false,pauseWorks=false,resumeWorks=false,voicesIsolated=false,messageUnchanged=false,resetExpression=false,idsInOrder=[]}
        calls=[];
        if(replayStartButton)replayStartButton.click();
        var gotStopVoice=await waitFor(function(){return calls.length===1});
        var stopControl=gotStopVoice&&calls[0].control;
        var replayStopButton=document.getElementById('roledm-replay-stop');if(gotStopVoice&&replayStopButton)replayStopButton.click();
        var stopWorks=gotStopVoice&&stopControl&&stopControl.cancelled===true&&!document.querySelector('.roledm-replay-current')
          &&document.getElementById('roledm-replay-status').dataset.state==='stopped';
        await window._persistApiConfig(oldA);await window._persistApiConfig(oldB);await window.loadApiConfigs();await ui.renderDetail();
        calls=[];
        var noVoice=!document.querySelector('.roledm-voice-btn');replayStartButton=document.getElementById('roledm-replay-start');if(replayStartButton)replayStartButton.click();
        var textStarted=await waitFor(function(){return /文字显示/.test(document.getElementById('roledm-replay-status').textContent)});
        var textPauseButton=document.getElementById('roledm-replay-pause'),textResumeButton=document.getElementById('roledm-replay-resume');
        var textPause=!!textPauseButton;if(textPauseButton)textPauseButton.click();var textPaused=document.getElementById('roledm-replay-status').dataset.state==='paused';
        var textResume=!!textResumeButton;if(textResumeButton)textResumeButton.click();var textResumed=document.getElementById('roledm-replay-status').dataset.state==='playing';
        replayStopButton=document.getElementById('roledm-replay-stop');if(replayStopButton)replayStopButton.click();
        return {controls:controls,ordered:voicesIsolated&&JSON.stringify(idsInOrder)===JSON.stringify(expected.map(function(m){return m.id})),
          voicesIsolated:voicesIsolated,speakingExpression:speaking,expressionRestored:resetExpression,pauseWorks:pauseWorks,resumeWorks:resumeWorks,
          stopWorks:stopWorks,textFallback:noVoice&&textStarted&&textPause&&textPaused&&textResume&&textResumed&&calls.length===0,messageUnchanged:messageUnchanged};
      }finally{
        ui.stopReplay();bridge.speakText=realSpeak;
        await window._persistApiConfig(oldA);await window._persistApiConfig(oldB);await window.loadApiConfigs();await ui.renderDetail();
      }
    })()`);
    check('6a-3) Role DM Scene Replay has start/pause/resume/stop controls and plays messages in thread order',
      roleDmReplayRes && roleDmReplayRes.controls && roleDmReplayRes.ordered && roleDmReplayRes.voicesIsolated, JSON.stringify(roleDmReplayRes));
    check('    Replay voice follows expression state and pause/resume/stop controls',
      roleDmReplayRes && roleDmReplayRes.speakingExpression && roleDmReplayRes.expressionRestored
        && roleDmReplayRes.pauseWorks && roleDmReplayRes.resumeWorks && roleDmReplayRes.stopWorks, JSON.stringify(roleDmReplayRes));
    check('    Missing Voice Profile falls back to text replay without modifying messages',
      roleDmReplayRes && roleDmReplayRes.textFallback && roleDmReplayRes.messageUnchanged, JSON.stringify(roleDmReplayRes));

    const roleDmSceneRes = await ev(cdp, `(async function(){
      var ui=window.IB.roleDmUI,api=window.IB.roleDm,bridge=window.IB.bridge,tid=ui.activeThreadId();
      var cfgA=window.__dm.cfgs.friend_aaa,cfgB=window.__dm.cfgs.friend_bbb;
      var oldA=JSON.parse(JSON.stringify(cfgA)),oldB=JSON.parse(JSON.stringify(cfgB)),realSpeak=bridge.speakText,ttsCalls=[];
      function waitFor(test){return new Promise(function(resolve){var until=Date.now()+3000;(function poll(){if(test())return resolve(true);if(Date.now()>until)return resolve(false);setTimeout(poll,15)})()})}
      try{
        cfgA.voice={enabled:true,source:'edge',provider:'edge',voiceId:'scene-a-voice'};
        cfgB.voice={enabled:true,source:'voicebox',provider:'voicebox',voiceId:'scene-b-profile'};
        await window._persistApiConfig(cfgA);await window._persistApiConfig(cfgB);await window.loadApiConfigs();await ui.renderDetail();
        var before=await api.threadDetail(tid),beforeMessages=before.messages.map(function(m){return {id:m.id,content:m.content}});
        var title=document.getElementById('roledm-scene-title'),tags=document.getElementById('roledm-scene-tags-input');
        var voiceMode=document.getElementById('roledm-scene-voice-mode'),pacing=document.getElementById('roledm-scene-text-pacing');
        var save=document.getElementById('roledm-scene-save'),visible=!!document.getElementById('roledm-scene-panel')
          &&!!document.getElementById('roledm-scene-participants')&&!!document.getElementById('roledm-scene-created')
          &&!!title&&!!tags&&!!voiceMode&&!!pacing&&!!save
          &&document.getElementById('roledm-scene-created').textContent.indexOf('创建于')>=0;
        if(title)title.value='海边排练';if(tags)tags.value='周末, 排练, 周末';if(voiceMode)voiceMode.value='text';if(pacing)pacing.value='fast';
        if(save)save.click();
        var saved=await waitFor(function(){return document.getElementById('roledm-scene-save-state').textContent.indexOf('已保存')>=0});
        var after=await api.threadDetail(tid),summary=document.getElementById('roledm-scene-title-display');
        bridge.speakText=function(text,voice,bubble,button,onStatus,control){ttsCalls.push({text:String(text),voice:voice});onStatus('generating');return true};
        var replayStart=document.getElementById('roledm-replay-start');if(replayStart)replayStart.click();
        var textMode=await waitFor(function(){return /文字显示/.test(document.getElementById('roledm-replay-status').textContent)});
        var stop=document.getElementById('roledm-replay-stop');if(stop)stop.click();
        var afterReplay=await api.threadDetail(tid),rawMessages=window.__dm.msgs;
        var messagesUnchanged=JSON.stringify(afterReplay.messages.map(function(m){return {id:m.id,content:m.content}}))===JSON.stringify(beforeMessages)
          &&afterReplay.messages.every(function(m){var raw=rawMessages[m.id];return !!raw&&!raw.scene&&!(raw.metadata&&raw.metadata.scene)});
        return {visible:visible,titleSaved:saved&&after.scene.title==='海边排练'&&summary&&summary.textContent==='海边排练',
          participants:after.scene.participants.map(function(p){return p.id}).join(',')===before.thread.participantIds.join(','),
          tags:after.scene.tags.join(',')==='周末,排练',createdAt:after.scene.createdAt===before.thread.createdAt,
          playbackSaved:after.scene.playback.voiceMode==='text'&&after.scene.playback.textPacing==='fast',
          textModeUsesNoTts:textMode&&ttsCalls.length===0,messagesUnchanged:messagesUnchanged};
      }finally{
        ui.stopReplay();bridge.speakText=realSpeak;
        await window._persistApiConfig(oldA);await window._persistApiConfig(oldB);await window.loadApiConfigs();await ui.renderDetail();
      }
    })()`);
    check('6a-4) Role DM Scene shows title, participants, creation time, tags, and playback settings',
      roleDmSceneRes && roleDmSceneRes.visible && roleDmSceneRes.titleSaved && roleDmSceneRes.participants
        && roleDmSceneRes.tags && roleDmSceneRes.createdAt && roleDmSceneRes.playbackSaved, JSON.stringify(roleDmSceneRes));
    check('    Scene text playback config is used by Replay and Scene data stays out of chat messages',
      roleDmSceneRes && roleDmSceneRes.textModeUsesNoTts && roleDmSceneRes.messagesUnchanged, JSON.stringify(roleDmSceneRes));

    const roleDmGalleryRes = await ev(cdp, `(async function(){
      var ui=window.IB.roleDmUI,api=window.IB.roleDm,threadId=ui.activeThreadId();
      function waitFor(test){return new Promise(function(resolve){var until=Date.now()+3500;(function poll(){if(test())return resolve(true);if(Date.now()>until)return resolve(false);setTimeout(poll,15)})()})}
      ui.backToList();
      await waitFor(function(){return document.getElementById('roledm-view-list').style.display!=='none'});
      var entry=document.getElementById('roledm-gallery-open');if(entry)entry.click();
      var cardLoaded=await waitFor(function(){return !!document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+threadId+'"]')});
      var card=document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+threadId+'"]');
      var cardTitle=card&&card.querySelector('.roledm-gallery-card-head h3'),detailToggle=card&&card.querySelector('.roledm-gallery-details summary');
      var detailVisible=!!card&&!!detailToggle;
      if(detailToggle)detailToggle.click();
      var detailOpened=!!(card&&card.querySelector('.roledm-gallery-details').open);
      var search=document.getElementById('roledm-gallery-search');if(search){search.value='海边排练';search.dispatchEvent(new Event('input',{bubbles:true}))}
      var searchFilters=!!document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+threadId+'"]');
      var tagFilter=document.getElementById('roledm-gallery-tag-filter');if(tagFilter){tagFilter.value='周末';tagFilter.dispatchEvent(new Event('change',{bubbles:true}))}
      var tagFilters=!!document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+threadId+'"]');
      var open=document.querySelector('#roledm-gallery-list [data-gallery-open="'+threadId+'"]');if(open)open.click();
      var openedThread=await waitFor(function(){return ui.activeThreadId()===threadId&&document.getElementById('roledm-view-detail').style.display!=='none'});
      var openedTitle=document.getElementById('roledm-scene-title-display');
      var back=document.querySelector('#roledm-view-detail .roledm-detail-bar button');if(back)back.click();
      var returnedToGallery=await waitFor(function(){return document.getElementById('roledm-view-gallery').style.display!=='none'});
      var cardReadyForReplay=await waitFor(function(){return !!document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+threadId+'"]')});
      var replay=document.querySelector('#roledm-gallery-list [data-gallery-replay="'+threadId+'"]'),replayButtonDisabled=replay&&replay.disabled;if(replay)replay.click();
      var replayStarted=await waitFor(function(){return /文字显示/.test(document.getElementById('roledm-replay-status').textContent)});
      var replayStatusText=(document.getElementById('roledm-replay-status')||{}).textContent||'';
      var stop=document.getElementById('roledm-replay-stop');if(stop)stop.click();
      back=document.querySelector('#roledm-view-detail .roledm-detail-bar button');if(back)back.click();
      var replayReturned=await waitFor(function(){return document.getElementById('roledm-view-gallery').style.display!=='none'});
      var cardReadyForExport=await waitFor(function(){return !!document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+threadId+'"]')});
      var urlApi=window.URL,realCreate=urlApi.createObjectURL,realRevoke=urlApi.revokeObjectURL;
      var anchorProto=window.HTMLAnchorElement.prototype,realAnchorClick=anchorProto.click,captured={blob:null,download:'',clicked:false};
      var exportButton=document.querySelector('#roledm-gallery-list [data-gallery-export="'+threadId+'"]');
      try{
        urlApi.createObjectURL=function(blob){captured.blob=blob;return 'blob:scene-gallery-test'};
        urlApi.revokeObjectURL=function(){};
        anchorProto.click=function(){captured.download=String(this.download||'');captured.clicked=true};
        if(exportButton)exportButton.click();
        var exported=await waitFor(function(){var c=document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+threadId+'"]');return !!(c&&c.querySelector('[data-gallery-export-status]').textContent.indexOf('已导出')>=0)});
        var exportText=captured.blob&&captured.blob.text?await captured.blob.text():'';
        var exportFile=exportText?JSON.parse(exportText):null;
        var noSensitive=!!exportFile&&!/api.?key|credential|token|chatMessages|threadMemorandum|memories|messages/i.test(exportText);
        var importCopy=exportFile?JSON.parse(JSON.stringify(exportFile)):null;
        if(importCopy)importCopy.participants[1].roleId='friend_gallery_missing';
        var fileInput=document.getElementById('roledm-gallery-import-file');
        if(fileInput&&importCopy){var transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify(importCopy)],'scene.json',{type:'application/json'}));fileInput.files=transfer.files;fileInput.dispatchEvent(new Event('change',{bubbles:true}))}
        var importOk=await waitFor(function(){return document.getElementById('roledm-gallery-import-status').textContent.indexOf('Scene 已导入')>=0});
        var galleryRows=await api.listThreads(),importedThread=galleryRows.find(function(t){return t.participantIds.indexOf('friend_gallery_missing')>=0});
        var importedDetail=importedThread&&await api.threadDetail(importedThread.threadId);
        var importRoundTrip=!!importedDetail&&importedDetail.messages.length===0&&importedDetail.scene.title===exportFile.scene.title
          &&JSON.stringify(importedDetail.scene.tags)===JSON.stringify(exportFile.scene.tags)
          &&importedDetail.scene.createdAt===exportFile.scene.createdAt
          &&importedDetail.scene.playback.voiceMode===exportFile.scene.playback.voiceMode
          &&importedDetail.scene.playback.textPacing===exportFile.scene.playback.textPacing
          &&document.getElementById('roledm-gallery-import-status').textContent.indexOf('缺少角色')>=0;
        if(importedThread){await api.deleteThread(importedThread.threadId);await ui.renderGallery()}
        var importedSceneRemoved=!!importedThread&&!document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+importedThread.threadId+'"]');
      }finally{
        urlApi.createObjectURL=realCreate;urlApi.revokeObjectURL=realRevoke;anchorProto.click=realAnchorClick;
      }
      return {entry:!!entry,cardLoaded:cardLoaded,title:cardTitle&&cardTitle.textContent==='海边排练',detailVisible:detailVisible&&detailOpened,
        searchFilters:searchFilters,tagFilters:tagFilters,openedThread:openedThread&&openedTitle&&openedTitle.textContent==='海边排练',
        returnedToGallery:returnedToGallery&&cardReadyForReplay,replayStarted:replayStarted&&replayReturned,
        replayButtonEnabled:replayButtonDisabled===false,noMessagePreview:!document.querySelector('#roledm-gallery-list .roledm-preview'),
        replayStatusText:replayStatusText,exported:exported&&captured.clicked&&!!captured.download&&noSensitive,
        importRoundTrip:importOk&&importRoundTrip,importedSceneRemoved:importedSceneRemoved,
        debug:{cardReadyForExport:cardReadyForExport,exportButton:!!exportButton,
          exportStatus:(document.querySelector('#roledm-gallery-list .roledm-gallery-card[data-scene-thread="'+threadId+'"] [data-gallery-export-status]')||{}).textContent||'',
          blobCaptured:!!captured.blob,download:captured.download,exportText:exportText.slice(0,140),
          importText:(document.getElementById('roledm-gallery-import-status')||{}).textContent||''}};
    })()`);
    check('6a-5) Scene Gallery browses metadata, searches/filters, opens the source thread and starts Replay',
      roleDmGalleryRes && roleDmGalleryRes.entry && roleDmGalleryRes.cardLoaded && roleDmGalleryRes.title
        && roleDmGalleryRes.detailVisible && roleDmGalleryRes.searchFilters && roleDmGalleryRes.tagFilters
        && roleDmGalleryRes.openedThread && roleDmGalleryRes.returnedToGallery && roleDmGalleryRes.replayStarted, JSON.stringify(roleDmGalleryRes));
    check('    Gallery references thread metadata only and does not copy message content',
      roleDmGalleryRes && roleDmGalleryRes.noMessagePreview && roleDmGalleryRes.exported, JSON.stringify(roleDmGalleryRes));
    check('    Exported Scene imports with Replay settings, tolerates a missing role, and cleans up when deleted',
      roleDmGalleryRes && roleDmGalleryRes.importRoundTrip && roleDmGalleryRes.importedSceneRemoved, JSON.stringify(roleDmGalleryRes));

    /* 6b) 输出类失败的用户文案（Phase 3.1）：**在真实页面上**跑一次
       "请求成功但没有正文"，然后看用户到底看到了什么。
       这一条是本轮的收口 —— 内部能识别的事实必须与用户看到的状态一致：
       模型没写出正文，就**不能**说成"模型请求失败 / 去检查密钥"。
       两种形态（被截断 / 未截断的空正文）各跑一次。 */
    const failT = await ev(cdp, `(async function(){
      var A = window.IB.roleDm;
      var tid = (await A.listThreads())[0].threadId, before = window.__dm.calls.length;
      window.__dm.outputFail = 'truncated';
      var res = await A.start('friend_aaa','friend_bbb',{ turns:2, force:true });
      window.__dm.outputFail = null;
      var detail = await A.threadDetail(tid);
      window.IB.roleDmUI.openThread(tid);
      await new Promise(function(r){ setTimeout(r, 300); });
      var note = document.getElementById('roledm-detail-note');
      return { stopReason: res && res.stopReason, err: res && res.error, turns: res && res.turns,
               persisted: detail.stopReason, text: note ? note.textContent : '',
               calls: window.__dm.calls.slice(before).filter(function(c){return c&&c.consumer==='role_dm'}).length,
               errCards: document.querySelectorAll('#ib-err-stack .ib-err-card').length };
    })()`);
    check('6b) 真实页面：请求成功但无正文 → stopReason=output-truncated（不是 provider-failed）',
      failT && failT.stopReason === 'output-truncated' && failT.turns === 0 &&
      failT.stopReason !== 'provider-failed', JSON.stringify(failT));
    check('   这一刻只重试一次：真实页面里的调用数是 2（2048 → 4096 → 停）',
      failT && failT.calls === 2, failT && failT.calls);
    check('   停止原因持久化在 thread 上（重开详情仍读得到）',
      failT && failT.persisted === 'output-truncated', failT && failT.persisted);
    check('   用户看到的文案说的是"没来得及写出正文"，并且**不含**密钥 / API Key / 网络 / 请求失败',
      failT && /没来得及写出正文/.test(failT.text) &&
      !/密钥|API Key|apiKey|网络|请求失败|不可用/.test(failT.text), failT && failT.text);
    check('   真实页面里也没有弹出"检查密钥"错误卡片', failT && failT.errCards === 0, failT && failT.errCards);

    const failE = await ev(cdp, `(async function(){
      var A = window.IB.roleDm;
      var tid = (await A.listThreads())[0].threadId, before = window.__dm.calls.length;
      window.__dm.outputFail = 'empty';
      var res = await A.start('friend_aaa','friend_bbb',{ turns:2, force:true });
      window.__dm.outputFail = null;
      window.IB.roleDmUI.openThread(tid);
      await new Promise(function(r){ setTimeout(r, 300); });
      var note = document.getElementById('roledm-detail-note');
      return { stopReason: res && res.stopReason, turns: res && res.turns, text: note ? note.textContent : '',
               calls: window.__dm.calls.slice(before).filter(function(c){return c&&c.consumer==='role_dm'}).length };
    })()`);
    check('6b-2) 未截断的空正文 → empty-output（与截断分开，同样不是 provider-failed）',
      failE && failE.stopReason === 'empty-output' && failE.stopReason !== 'provider-failed', JSON.stringify(failE));
    check('   同样只花掉 2 次调用，文案同样不指向密钥 / 网络',
      failE && failE.calls === 2 && /没有给出正文/.test(failE.text) &&
      !/密钥|API Key|apiKey|网络|请求失败|不可用/.test(failE.text), JSON.stringify(failE));

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
               hasCurrentThreadGuidance: !!first.system&&first.system.indexOf('【Conversation State v1 · 当前 thread】')>=0,
               histRows: (first.hist || []).length };
    })()`);
    check('7) 第二次 run 的第一条 prompt 带着上一次 run 说过的话（跨 run 最近上下文）',
      crossRes && crossRes.sawOwn === true && crossRes.hasCurrentThreadGuidance === true, JSON.stringify(crossRes));
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

    /* Dev-only quote diagnostics are aggregate counters and must survive the
       per-turn render events without exposing text or prompt data. */
    const quoteDiagUi = await ev(cdp, `(async function(){
      var had=Object.prototype.hasOwnProperty.call(window,'__IB_DEV_MODE__'),old=window.__IB_DEV_MODE__;
      window.__IB_DEV_MODE__=true;
      var thread=(await window.IB.roleDm.listThreads())[0];
      window.IB.roleDmUI.openThread(thread.threadId);
      await new Promise(function(r){setTimeout(r,100)});
      var start=document.getElementById('roledm-start-btn');if(start)start.click();
      var end=Date.now()+15000;
      while(Date.now()<end){
        var note=document.getElementById('roledm-detail-note');
        if(note&&note.textContent.indexOf('引用诊断（仅统计）')>=0)break;
        await new Promise(function(r){setTimeout(r,100)});
      }
      var text=(document.getElementById('roledm-detail-note')||{}).textContent||'';
      if(had)window.__IB_DEV_MODE__=old;else delete window.__IB_DEV_MODE__;
      return {visible:text.indexOf('引用诊断（仅统计）')>=0,hasCandidateCount:text.indexOf('候选 ')>=0,hasParseCounts:text.indexOf('未选择 ')>=0,hasApplicationCount:text.indexOf('成功应用 ')>=0,
        hasDeliveryCounts:text.indexOf('同次生成多消息 ')>=0&&text.indexOf('格式回退 ')>=0,
        leaksText:['messageId','sourceMessageId','snippet','原文片段','apiKey','Bearer '].some(function(k){return text.indexOf(k)>=0})};
    })()`);
    check('9) Dev calibration shows quote and multi-message aggregate counts only',
      quoteDiagUi && quoteDiagUi.visible && quoteDiagUi.hasCandidateCount && quoteDiagUi.hasParseCounts
        && quoteDiagUi.hasApplicationCount && quoteDiagUi.hasDeliveryCounts && quoteDiagUi.leaksText === false, JSON.stringify(quoteDiagUi));

    const galleryEmpty = await ev(cdp, `(async function(){
      var A=window.IB.roleDm,ui=window.IB.roleDmUI;
      await ui.openGallery();
      var threads=await A.listThreads();
      for(var i=0;i<threads.length;i++)await A.deleteThread(threads[i].threadId);
      await ui.renderGallery();
      var empty=document.querySelector('#roledm-gallery-list .roledm-gallery-empty');
      return {emptyState:!!empty&&empty.textContent.indexOf('还没有可浏览的 Scene')>=0,
        cards:document.querySelectorAll('#roledm-gallery-list .roledm-gallery-card').length,
        threadCount:(await A.listThreads()).length};
    })()`);
    check('9a) Scene Gallery shows a normal empty state after all source threads are deleted',
      galleryEmpty && galleryEmpty.emptyState && galleryEmpty.cards === 0 && galleryEmpty.threadCount === 0, JSON.stringify(galleryEmpty));

    /* 10) 全程没有未捕获异常 */
    await new Promise(r => setTimeout(r, 600));
    check('10) 全程无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | '));
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


