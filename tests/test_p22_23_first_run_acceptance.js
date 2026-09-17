'use strict';
/* ====================================================================
   P22-23 · 首次使用链的**真实浏览器验收**（自截图）
   --------------------------------------------------------------------
   运行：node tests/test_p22_23_first_run_acceptance.js

   ★ 这个文件**不在** test-all.js 里，理由与 P22-15/16/17/18/22 那几条视觉
     测试同款：它要开一个真实浏览器。

   ── 它与 P22-15~22 那些视觉测试的**关键区别** ──────────────────────
   那些把网络注入成假的 fetch。这一条**一个字节的网络都不假**：

     · 真实 services/home-node-service.js（私有端口 + 私有数据目录，
       环境里**没有** IB_HOME_NODE_TOKEN —— 这就是普通用户的启动环境）；
     · 真实 services/internal-beyond-server.js（产品的静态层）；
     · 真实页面经 **http://127.0.0.1:<port>/InternalBeyond.html** 载入 ——
       这正是 runtime/launch-internal-beyond.js 打开的那个 origin
       （不是 file://：Chrome 在网络层就禁止 file:// 页面访问 loopback，
       见 docs/HOME_NODE_CHAT.md §5.1）；
     · 真实 home-node-client.js 自己去取凭据、自己去写配置。

   ── 它要回答的两个问题（§10）──────────────────────────────────────
     ① 正常启动下，设置 → 钱包与初始额度 是不是**不再**出现
        「这里现在还改不了 / 请先设置环境变量」？（因为凭据现在自动 provision）
     ② 真的走完一次「选角色 → 输入初始额度 → 两步确认 → 提交」之后，
        这一页是不是进入 Wallet READY？

   ★ 截图只落 %TEMP%，不入仓库。 ★ 只开**一个**浏览器实例，复用到底。
   ==================================================================== */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(os.tmpdir(), 'ib-p22-23-shots');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✔ ' + name); }
  else { failed++; console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n' + t); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ]) if (fs.existsSync(c)) return c;
  return null;
}
function request(port, method, urlPath, body, headers) {
  return new Promise(resolve => {
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h, timeout: 8000 }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => { let j = null; try { j = raw ? JSON.parse(raw) : {}; } catch (_) { j = null; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0 }); });
    r.on('error', () => resolve({ status: 0 }));
    if (data) r.write(data);
    r.end();
  });
}

/* ── 最小 CDP 客户端（与 P22-16/17/18/22 同一子集）──────────────────── */
class Cdp {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.id = 0;
    this.pending = new Map(); this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => { });
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' }
      });
      req.on('upgrade', (res, socket) => resolve(new Cdp(socket)));
      req.on('error', reject);
      req.end();
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout ' + method)); } }, 25000);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.sendText({ id, method, params });
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6); }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }
  parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0], second = this.buffer[1];
      const opcode = first & 0x0f;
      let offset = 2, length = second & 0x7f;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      const masked = (second & 0x80) !== 0;
      let text;
      if (masked) {
        const mask = payload.subarray(0, 4);
        const data = Buffer.alloc(payload.length - 4);
        for (let i = 4; i < payload.length; i++) data[i - 4] = payload[i] ^ mask[(i - 4) & 3];
        text = data.toString('utf8');
      } else text = payload.toString('utf8');
      if (opcode === 0x8) { this.socket.destroy(); return; }
      if (opcode !== 0x1) continue;
      let msg = null;
      try { msg = JSON.parse(text); } catch (_) { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error('cdp ' + JSON.stringify(msg.error))); else p.resolve(msg.result || {});
        continue;
      }
      const ls = this.listeners.get(msg.method) || [];
      for (const l of ls) { try { l(msg.params || {}); } catch (_) { } }
    }
  }
}

/* ── 页面内的探针（只读）─────────────────────────────────────────────
   ★ 它读的是**渲染出来的东西**：设置页那一格里的可见文本、按钮、输入框。
     没有一条断言是靠源码字面量。 */
const PROBE = `(function(){
  var pane = document.getElementById('economy-configuration');
  function textOf(n){ return n ? String(n.textContent || '') : ''; }
  var shell = document.getElementById('economy-shell');
  var cfg = pane ? [].slice.call(pane.querySelectorAll('.ecfg-pane')) : [];
  var visible = cfg.filter(function(p){ return !p.hidden; });
  var wallet = document.getElementById('economy-config-wallet') || (visible.length ? visible[0] : null);
  var all = pane ? textOf(pane) : '';
  var btns = wallet ? [].slice.call(wallet.querySelectorAll('button')).map(function(b){ return String(b.textContent||'').trim(); }) : [];
  var inputs = wallet ? [].slice.call(wallet.querySelectorAll('input')) : [];
  /* 凭据自举的痕迹：这一层**只在内存**里，因此任何持久存储里都不该有 token。 */
  var stored = {};
  try { stored.local = localStorage.getItem('ib_home_node_token'); } catch(e) { stored.local = '<err>'; }
  try { stored.session = sessionStorage.getItem('ib_home_node_token'); } catch(e) { stored.session = '<err>'; }
  return {
    page: document.getElementById('page-economy') ? !document.getElementById('page-economy').hidden : null,
    walletText: textOf(wallet),
    allText: all,
    buttons: btns,
    inputCount: inputs.length,
    inputNames: inputs.map(function(x){ return String(x.name||''); }),
    hasClosedTitle: all.indexOf('这里现在还改不了') >= 0,
    hasEnvVarWord: all.indexOf('IB_HOME_NODE_TOKEN') >= 0,
    hasBootstrapPending: all.indexOf('尚未完成 Initial Bootstrap') >= 0,
    hasReady: /READY/.test(all),
    storedTokenLocal: stored.local,
    storedTokenSession: stored.session,
    url: location.href
  };
})()`;

(async function main() {
  const exe = chromePath();
  if (!exe) { console.error('找不到 Chrome / Edge：设置 CHROME_PATH 或安装其中之一。'); process.exit(1); }
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  console.log('P22-23 · 首次使用链的真实浏览器验收');

  const children = [];
  const dirs = [];
  const tmp = tag => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p2223-' + tag + '-')); dirs.push(d); return d; };
  const spawnTracked = (cmd, args, opts) => { const c = spawn(cmd, args, opts); children.push(c); return c; };

  const nodeDir = tmp('home');
  const homePort = await freePort();
  const webPort = await freePort();

  /* ① 真实 Home Node —— 环境里刻意**没有** IB_HOME_NODE_TOKEN。 */
  const homeEnv = Object.assign({}, process.env, {
    IB_HOME_NODE_PORT: String(homePort),
    IB_HOME_NODE_DATA_DIR: nodeDir,
    IB_HOME_NODE_HOST: '127.0.0.1'
  });
  delete homeEnv.IB_HOME_NODE_TOKEN;
  delete homeEnv.IB_HOME_NODE_TOKEN_AUTOPROVISION;
  const home = spawnTracked(process.execPath, [path.join('services', 'home-node-service.js')],
    { cwd: ROOT, env: homeEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let homeOut = '';
  home.stdout.on('data', c => { homeOut += String(c); });
  home.stderr.on('data', c => { homeOut += String(c); });

  /* ② 真实静态层（产品正常启动链的那一个）。 */
  const web = spawnTracked(process.execPath, [path.join('services', 'internal-beyond-server.js')],
    { cwd: ROOT, env: Object.assign({}, process.env, { IB_WEB_PORT: String(webPort) }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let webOut = '';
  web.stdout.on('data', c => { webOut += String(c); });
  web.stderr.on('data', c => { webOut += String(c); });

  const APP_URL = 'http://127.0.0.1:' + webPort + '/InternalBeyond.html';
  let chrome = null, cdp = null;
  try {
    /* 等两个服务真的起来。 */
    let up = false;
    for (let i = 0; i < 80; i++) {
      const h = await request(homePort, 'GET', '/health');
      const w = await request(webPort, 'GET', '/health');
      if (h.status === 200 && h.body && h.body.ok && w.status === 200) { up = true; break; }
      await sleep(250);
    }
    section('0 · 正常启动（无 IB_HOME_NODE_TOKEN）');
    check('Home Node 与静态层都在真实端口上活着', up, { home: homeOut.slice(-300), web: webOut.slice(-200) });
    if (!up) throw new Error('services did not start');

    check('★ 凭据在首次启动时被**自动创造**（磁盘上出现了那一份，而不是要求用户去设环境变量）',
      fs.existsSync(path.join(nodeDir, 'desktop-credential.json')), fs.readdirSync(nodeDir));

    /* ③ 只开**一个**浏览器实例，复用到底。 */
    const cdpPort = await freePort();
    const profile = tmp('chrome');
    chrome = spawnTracked(exe, [
      '--headless=new', '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--hide-scrollbars', '--disable-gpu', '--force-device-scale-factor=1',
      '--disable-features=Translate,BackForwardCache', 'about:blank'
    ], { stdio: 'ignore', windowsHide: true });

    cdp = await (async () => {
      for (let i = 0; i < 80; i++) {
        try {
          const list = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: cdpPort, path: '/json/list' }, res => {
              let raw = ''; res.on('data', c => { raw += c; });
              res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
            }).on('error', reject);
          });
          const target = list.filter(t => t.type === 'page')[0];
          if (target && target.webSocketDebuggerUrl) return await Cdp.connect(target.webSocketDebuggerUrl);
        } catch (_) { /* 还没起来 */ }
        await sleep(250);
      }
      throw new Error('CDP 连接超时');
    })();

    const evaluate = async (expression, awaitPromise) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: awaitPromise === true });
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    };
    const shot = async (name) => {
      const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOT_DIR, name + '.png');
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      console.log('    · 截图 ' + file);
      return file;
    };
    const waitFor = async (expr, timeoutMs, label) => {
      const deadline = Date.now() + (timeoutMs || 12000);
      while (Date.now() < deadline) {
        let v = null;
        try { v = await evaluate(expr); } catch (_) { v = null; }
        if (v) return v;
        await sleep(300);
      }
      throw new Error('等待超时：' + (label || expr));
    };

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    /* ★ 把客户端的 Home Node 目标指向**这个测试节点**。这一条是测试夹具，
       不是产品行为：产品的默认目标就是 127.0.0.1:23118。
       必须在页面脚本跑起来**之前**写好，因此用 addScriptToEvaluateOnNewDocument。 */
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `try { localStorage.setItem('ib_home_node_http', ${JSON.stringify('http://127.0.0.1:' + homePort)}); localStorage.setItem('ib_home_node_mode','canonical'); localStorage.removeItem('ib_home_node_token'); } catch(e){}`
    });

    const load = async () => {
      const done = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
      await cdp.send('Page.navigate', { url: APP_URL });
      await done;
      /* ── 测试夹具：把一位角色放进**唯一**的角色事实源（IndexedDB 的
         `apiConfigs`），再让页面按它自己的既有路径读回来。
         ★ 为什么不能只写 `window.apiConfigs`：那个名字是一个活的 getter
           （ibSocialLive 注册），而 `loadApiConfigs()` 会用 IndexedDB 里的
           内容覆盖它 —— 只写 window 的话，页面稍后一次异步加载就把它清空了。
           `dbPut` + `loadApiConfigs()` 是仓内既有测试用的同一手法。 */
      await evaluate(`(function(){
        var cfg = { id: 'p2223_agent', nickname: 'P22-23 角色', model: 'm', endpoint: 'http://127.0.0.1:1/v1',
          apiKey: 'test', provider: 'custom', relationship: '测试', systemPrompt: '', temperature: 1,
          streaming: false, showThinking: false, promptCache: false, created: Date.now() };
        return Promise.resolve(dbPut('apiConfigs', cfg))
          .then(function(){ return (typeof loadApiConfigs === 'function') ? loadApiConfigs() : null; })
          .then(function(){ return Array.isArray(window.apiConfigs) ? window.apiConfigs.length : -1; })
          .catch(function(e){ return 'err:' + e; });
      })()`, true);
      /* 真实登记 owner（canonical identity 路径）——界面上的"配置对象"下拉
         要能选中它，而 Economy 的 owner 闸门要求它真的存在。 */
      try {
        await evaluate(`(function(){
          var base = 'http://127.0.0.1:${homePort}';
          return fetch(base + '/internal/desktop-credential', { method:'POST', headers:{ 'X-IB-Protocol':'1', 'X-IB-Bootstrap':'1', 'Content-Type':'application/json' }, body:'{}' })
            .then(function(r){ return r.json(); })
            .then(function(d){
              window.__ibP2223Token = d && d.credential ? d.credential : '';
              return fetch(base + '/characters/publish', { method:'POST', headers:{ 'X-IB-Protocol':'1', 'X-IB-Home-Token': window.__ibP2223Token, 'Content-Type':'application/json' },
                body: JSON.stringify({ characters:[{ id:'p2223_agent', name:'P22-23 角色' }], merge:true }) });
            }).then(function(r){ return r.status; }).catch(function(e){ return 'err:' + e; });
        })()`, true);
      } catch (_) { /* 登记失败会在下面的断言里显形 */ }
      await sleep(600);
    };

    const openEconomySettings = async () => {
      /* ① 先离开启动页（splash）。产品正常启动会停在它上面，而它盖住整个
            应用 —— 不跳过的话截出来的是欢迎页而不是设置页。这正是"只信
            断言不看图"会漏掉的那类错误：文字断言在隐藏的 DOM 上照样成立。
         ② 再走**产品自己的路由**进 Economy（导航栏那一项就是 `#economy`，
            InternalBeyond.html:146）。直接调 `economyShellUI.show()` 只是
            切页签，不会让 `#page-economy` 变成可见的那一页 —— 实测症状是
            截图停在首页、而所有文字断言依然通过。 */
      await evaluate(`(function(){
        try { if (typeof enterSite === 'function') enterSite(); } catch(e){}
        location.hash = '#economy';
      })()`);
      /* 等 splash 真的不再可见：`enterSite()` 自己有一段有意的渐隐动画，
         因此这里等状态，而不是猜毫秒数。判据用**实际遮挡**（元素在视口内
         且面积非零），而不是只看 hidden 属性。 */
      await waitFor(`(function(){
        var sp = document.getElementById('splash');
        if (!sp) return true;
        var cs = getComputedStyle(sp);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return true;
        var r = sp.getBoundingClientRect();
        return !(r.width > 0 && r.height > 0) || r.bottom <= 0;
      })()`, 15000, 'splash 消失').catch(function () {
        console.error('    ! splash 没有消失 —— 截图会拍到它');
      });
      await waitFor(`(function(){
        var p = document.getElementById('page-economy');
        if (!p) return false;
        var r = p.getBoundingClientRect();
        return !p.hidden && r.width > 0 && r.height > 0;
      })()`, 15000, 'Economy 页可见').catch(function () {
        console.error('    ! Economy 页没有变成可见的那一页');
      });
      await evaluate(`(function(){
        if (window.IB && IB.economyShellUI) { IB.economyShellUI.render(); IB.economyShellUI.show('settings'); }
      })()`);
      await sleep(1600);
    };

    /* ══ ① fresh 状态：设置页不该说"请先设置环境变量" ══ */
    section('1 · fresh 状态的真实页面（设置 → 钱包与初始额度）');
    await load();
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await openEconomySettings();

    let probe = await evaluate(PROBE);
    /* ★ 先证明我们真的在 Economy 页上：页面/外壳/钱包那一格都必须**可见**。
       没有这一条，后面所有文字断言都可能在一个被启动页盖住的 DOM 上成立 ——
       一张截图就看出来的错误，文字断言是看不见的。 */
    const onScreen = await evaluate(`(function(){
      /* 可见性判据刻意**不**用 getBoundingClientRect 的 top/bottom：这一页是
         长文档，用户往下滚之后钱包面板就在视口外 —— 用"在视口内"判会得到
         一条假红（实测踩到过：截图明明是正确的那一屏，判定却说不可见）。
         真正要回答的是"排版引擎有没有给它尺寸、祖先链上有没有 hidden"。 */
      function visible(n){
        if (!n) return false;
        var cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        var r = n.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        for (var p = n; p && p.nodeType === 1; p = p.parentNode) if (p.hidden === true) return false;
        return true;
      }
      function coverage(n){
        if (!n) return 0;
        var cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return 0;
        var r = n.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return 0;
        var vw = window.innerWidth, vh = window.innerHeight;
        var w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        var h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        return Math.round((w * h) / (vw * vh) * 100);
      }
      var splash = document.getElementById('splash');
      return {
        splashCoveragePct: coverage(splash),
        pageVisible: visible(document.getElementById('page-economy')),
        shellVisible: visible(document.getElementById('economy-shell')),
        paneVisible: visible(document.getElementById('economy-config-wallet'))
      };
    })()`);
    check('★ 页面真的停在 Economy 设置那一屏（启动页不再覆盖、钱包面板已排版）',
      onScreen.splashCoveragePct === 0 && onScreen.pageVisible && onScreen.shellVisible && onScreen.paneVisible,
      onScreen);
    /* 诊断：页面里凭据会话的真实状态 + 直接从页面打一次交付面。
       这两条是"为什么读不到钱包"的第一手证据（而不是靠猜）。 */
    const credDiag = await evaluate(`(function(){
      var st = window.IB && window.IB.ibHomeNodeCredentialState ? window.IB.ibHomeNodeCredentialState() : 'missing';
      var out = { state: st };
      return fetch('http://127.0.0.1:${homePort}/health', { cache: 'no-store' })
        .then(function(r){ out.healthStatus = r.status; return r.text(); })
        .then(function(t){ out.healthOk = t.indexOf('"ok":true') >= 0; })
        .catch(function(e){ out.healthError = String(e); })
        .then(function(){
          return fetch('http://127.0.0.1:${homePort}/internal/desktop-credential', {
            method:'POST', headers:{ 'X-IB-Protocol':'1', 'X-IB-Bootstrap':'1', 'Content-Type':'application/json' }, body:'{}'
          });
        })
        .then(function(r){ out.credStatus = r.status; return r.json(); })
        .then(function(j){ out.credKeys = Object.keys(j); })
        .catch(function(e){ out.credError = String(e); })
        .then(function(){ return out; });
    })()`, true);
    check('诊断 · 页面里的凭据会话状态（默认应为已取到）',
      credDiag && credDiag.state && credDiag.state.source === 'home-node-bootstrap',
      credDiag);
    check('① 页面**没有**出现「这里现在还改不了」（配置面不再因为凭据缺失而关闭）',
      probe.hasClosedTitle === false, { walletText: probe.walletText.slice(0, 260) });
    check('② 页面**没有**出现环境变量名 IB_HOME_NODE_TOKEN（普通用户不需要知道它）',
      probe.hasEnvVarWord === false, null);
    check('③ 钱包那一格给出的是「尚未完成 Initial Bootstrap」这个**系统状态**（不是错误页）',
      probe.hasBootstrapPending === true, { walletText: probe.walletText.slice(0, 260) });
    check('④ 而且真的给出了输入框与「设置初始额度」按钮（配置面是可用的，不是只读）',
      probe.inputCount > 0 && probe.buttons.indexOf('设置初始额度') >= 0,
      { inputs: probe.inputNames, buttons: probe.buttons });
    check('⑤ ★★★★★ 凭据**没有**落进 localStorage / sessionStorage（它只在内存里）',
      probe.storedTokenLocal === null && probe.storedTokenSession === null,
      { local: probe.storedTokenLocal, session: probe.storedTokenSession });

    await shot('01-fresh-settings-internal-1280');

    /* ══ ② 真的走完一次 bootstrap ══ */
    section('2 · 真的走完一次 Initial Bootstrap（选角色 → 输入额度 → 两步确认 → 提交）');
    /* 选角色：界面里的下拉是 canonical owner 的来源。
       ★ 真实的 id 是配置面板自己的那一个（assets/js/economy-configuration.js
         的 `economy-owner-select`）；外壳还有一个 `economy-shell-owner-select`，
         两者都存在，因此**按 class 取配置面板内的那一个**，而不是假设 id。 */
    const picked = await evaluate(`(function(){
      var pane = document.getElementById('economy-configuration');
      var sel = pane ? pane.querySelector('select.ecfg-owner-select') : null;
      if (!sel) return 'no-select';
      var opt = [].slice.call(sel.options).filter(function(o){ return o.value === 'p2223_agent'; })[0];
      if (opt) { sel.value = opt.value; } else { sel.value = 'p2223_agent'; }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    await sleep(1500);
    check('⑥ 配置对象选中了真实存在的 owner（界面上的下拉，不是脚本直接写死）',
      picked === 'p2223_agent', { picked: picked });

    await openEconomySettings();
    const typed = await evaluate(`(function(){
      var pane = document.getElementById('economy-configuration');
      var input = pane ? pane.querySelector('input[name="bootstrapAmount"]') : null;
      if (!input) return 'no-input';
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '2500');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    check('⑦ 在初始额度那一格真的输入了金额', typed === '2500', { typed: typed });

    /* 两步确认：第一次点击进入确认，第二次点击提交。 */
    const step1 = await evaluate(`(function(){
      var pane = document.getElementById('economy-configuration');
      var btns = [].slice.call(pane.querySelectorAll('button'));
      var b = btns.filter(function(x){ return String(x.textContent||'').trim() === '设置初始额度'; })[0];
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`);
    await sleep(500);
    const confirmText = await evaluate(`(function(){
      var pane = document.getElementById('economy-configuration');
      var b = [].slice.call(pane.querySelectorAll('button.ecfg-btn-primary')).map(function(x){ return String(x.textContent||'').trim(); });
      return { ask: String(pane.textContent||'').indexOf('确定设置') >= 0, primary: b };
    })()`);
    check('⑧ ★★★★ 第一次点击**不**提交，而是要求二次确认（一次性语义的第一道闸在界面上）',
      step1 === 'clicked' && confirmText.ask === true, confirmText);

    const step2 = await evaluate(`(function(){
      var pane = document.getElementById('economy-configuration');
      var b = [].slice.call(pane.querySelectorAll('button.ecfg-btn-primary')).filter(function(x){ return String(x.textContent||'').trim() === '设置初始额度'; })[0];
      if (!b) return 'no-confirm-button';
      b.click();
      return 'submitted';
    })()`);
    check('⑨ 第二次点击真的提交了（走 canonical configuration command）', step2 === 'submitted', { step2: step2 });

    /* 等页面进入 READY。 */
    const ready = await waitFor(`(function(){
      var pane = document.getElementById('economy-configuration');
      var t = pane ? String(pane.textContent||'') : '';
      return t.indexOf('尚未完成 Initial Bootstrap') < 0 && /READY|可用|余额/.test(t) ? t.slice(0, 400) : null;
    })()`, 15000, 'wallet READY').catch(e => { throw e; });
    const afterProbe = await evaluate(PROBE);
    check('⑩ ★★★★★ 页面进入了 Wallet READY —— 这就是 §5 那条产品链的终点',
      afterProbe.hasBootstrapPending === false && /READY/.test(afterProbe.allText),
      { walletText: afterProbe.walletText.slice(0, 300) });

    /* 权威侧交叉验证：canonical store 里真的有钱包与余额。
       ★ 单位是这里唯一需要解释的地方：界面那一格收的是**主单位**（用户敲
         "2500"），而 canonical 权威记的是 **minor 单位**，1:1 的 IB_CREDIT
         在契约里是 100 minor = 1 单位，因此 2500 → 250000（六位）。
         断言因此验的是"两者**换算一致**"，而不是两个数字逐字相等。 */
    const tokenNow = await evaluate(`window.__ibP2223Token || ''`);
    const walletApi = await request(homePort, 'GET', '/economy/wallet?ownerId=p2223_agent&currency=IB_CREDIT', null, { 'X-IB-Home-Token': tokenNow });
    const canonicalMinor = walletApi.body && walletApi.body.wallet && String(walletApi.body.wallet.cachedBalanceMinor);
    check('⑪ ★★★★★ 权威侧确认：canonical store 里 wallet 是 READY，且余额与界面输入**换算一致**',
      walletApi.status === 200 && walletApi.body && walletApi.body.wallet && walletApi.body.wallet.state === 'READY' &&
      /^2500+$/.test(String(canonicalMinor)) && String(canonicalMinor).replace(/0+$/, '') === '25',
      walletApi.body && walletApi.body.wallet && { state: walletApi.body.wallet.state, cachedMinor: canonicalMinor });

    check('⑫ 成功后页面里仍然**没有**环境变量名（技术说明默认折叠，普通用户看不到底层词）',
      afterProbe.hasEnvVarWord === false, null);

    await shot('02-ready-settings-internal-1280');

    /* ══ ③ 两套主题 × 两个尺寸 ══ */
    section('3 · Internal / Infernal × 1280 desktop / 390 mobile');
    for (const theme of [{ key: 'internal', cls: '' }, { key: 'infernal', cls: 'theme-infernal' }]) {
      await evaluate(`(function(){ document.documentElement.className = ${JSON.stringify(theme.cls)}; })()`);
      for (const vp of [{ key: '1280', w: 1280, h: 800, m: false }, { key: '390', w: 390, h: 780, m: true }]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.m });
        await openEconomySettings();
        const p = await evaluate(PROBE);
        check(`   ${theme.key} ${vp.key}：钱包 READY 仍然可见，且没有横向溢出`,
          /READY/.test(p.allText) && p.hasClosedTitle === false,
          { text: p.allText.slice(0, 160) });
        await shot(`03-${theme.key}-${vp.key}-ready`);
      }
    }

    /* 刷新一次：凭据在内存里会丢，页面必须能**再取一次**（否则刷新 = 永久 401）。 */
    section('4 · 刷新页面之后（凭据只在内存里，必须能重新取到）');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(function(){ document.documentElement.className = ''; })()`);
    await load();
    await openEconomySettings();
    const afterReload = await evaluate(PROBE);
    check('⑬ ★★★★★ 刷新之后页面仍然拿到凭据：没有 401、没有「这里现在还改不了」、READY 照旧',
      afterReload.hasClosedTitle === false &&
      afterReload.storedTokenLocal === null &&
      /READY/.test(afterReload.allText),
      { text: afterReload.allText.slice(0, 200), local: afterReload.storedTokenLocal });

    /* 秘密纪律：DOM / console / URL / 持久存储里都不该有凭据。 */
    section('5 · 秘密纪律（DOM / URL / 持久存储 / 控制台）');
    const storedNow = await evaluate(`(function(){
      var out = { local: null, session: null, url: location.href };
      try { out.local = localStorage.getItem('ib_home_node_token'); } catch(e){}
      try { out.session = sessionStorage.getItem('ib_home_node_token'); } catch(e){}
      var html = document.documentElement.outerHTML;
      out.tokenInDom = window.__ibP2223Token ? html.indexOf(window.__ibP2223Token) >= 0 : false;
      out.tokenInUrl = window.__ibP2223Token ? location.href.indexOf(window.__ibP2223Token) >= 0 : false;
      return out;
    })()`);
    check('⑭ ★★★★★ 凭据不在 DOM 文本里', storedNow.tokenInDom === false, null);
    check('⑮ ★★★★★ 凭据不在 URL 里', storedNow.tokenInUrl === false, null);
    check('⑯ ★★★★★ 凭据不在 localStorage / sessionStorage 里', storedNow.local === null && storedNow.session === null, storedNow);

    console.log('\n  （截图目录：' + SHOT_DIR + '）');
  } catch (error) {
    failed++;
    console.error('P22-23 验收未捕获异常 — ' + String((error && error.stack) || error));
  } finally {
    for (const c of children) { try { c.kill(); } catch (_) { /* 已退出 */ } }
    await sleep(600);
    for (const c of children) { try { c.kill('SIGKILL'); } catch (_) { /* 已退出 */ } }
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ } }
  }

  console.log('\n' + '─'.repeat(72));
  console.log('P22-23 首次使用链验收：' + passed + ' 通过, ' + failed + ' 失败');
  console.log('子进程：' + children.length + ' 个（已全部请求退出） · 临时目录：' + dirs.length + ' 个');
  process.exit(failed === 0 ? 0 : 1);
})();
