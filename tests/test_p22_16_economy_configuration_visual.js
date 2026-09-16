'use strict';
/* ====================================================================
   P22-16 · Economy Configuration UI — 视觉与响应式核对（真实浏览器 · 自截图）
   --------------------------------------------------------------------
   运行：node tests/test_p22_16_economy_configuration_visual.js

   ★ 这个文件**不在** test-all.js 里，理由与 test_ui_regression.js /
     test_p22_15_economy_approval_visual.js 同款：它要开一个真实浏览器。
     它存在的唯一理由是那些只能由排版引擎回答的问题：
       "手机端有没有横向溢出" / "两套主题是不是真的换了令牌" /
       "数字能不能一眼扫读" / "按钮在手机上是整行可点的"。
     ★ 一次启动、复用同一个 browser、最后**明确关闭**（Browser.close +
       child.kill），并且不启动 Desktop / Electron / DSH。

   它做四件事：
     ① 在 file:// 载入真实 InternalBeyond.html，把五条只读面与配置 seam
        注入成假的 fetch（**走真实的 home-node-client**，因此 POST 的
        路径与信封是生产代码构造的，不是这一层拼的）；
     ② 对 2 主题 × 3 宽度检查真实排版：外壳宽度 / 横向溢出 / 刻度条真的
        按权威数据算出了百分比 / 主题令牌真的换了 / 数字是等宽数字；
     ③ 走一遍真实交互：切页签、改一个限额、点保存，然后断言**发出去的
        信封**逐字是 canonical 的，并且 `/economy/*` 的 POST 仍然是 0；
     ④ 把关键状态截成 PNG 落到 %TEMP%，供人工看一眼。
        ★ 截图**不写进仓库**（素材纪律：本阶段 PNG 新增 = 0）。

   与生产代码的关系：它不 import 任何生产模块，只操纵真实页面。
   ==================================================================== */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;
const SHOT_DIR = path.join(os.tmpdir(), 'ib-p22-16-shots');

function chromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
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

/* ── 最小 CDP 客户端（与 test_p22_15_..._visual.js 同一子集）────────── */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.parse(); });
    socket.on('error', () => { });
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const url = new URL(wsUrl);
      const req = http.request({
        host: url.hostname, port: url.port, path: url.pathname + url.search,
        headers: {
          Upgrade: 'websocket', Connection: 'Upgrade',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13'
        }
      });
      req.on('upgrade', (response, socket) => resolve(new Cdp(socket)));
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
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); }
      });
      this.sendText({ id, method, params });
    });
  }
  sendText(message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6);
    }
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
      if (opcode === 0x8) { try { this.socket.end(); } catch (e) { } return; }
      if (opcode !== 0x1) continue;
      let message = null;
      try { message = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
      if (message.id && this.pending.has(message.id)) {
        const slot = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) slot.reject(new Error(message.error.message || 'cdp error'));
        else slot.resolve(message.result);
      } else if (message.method && this.listeners.has(message.method)) {
        for (const fn of this.listeners.get(message.method)) fn(message.params);
      }
    }
  }
}

let checks = 0, failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }

/* ── 假的只读面 + 假的配置 seam ──────────────────────────────────────
   ★ 唯一被注入的是**网络**：页面本身、home-node-client、纯层与渲染器
     全是仓库里的真文件。因此"UI 发出去的路径与信封"是生产代码构造的。 */
const SEED = `(function(){
  var CALLS = { reads: [], posts: [] };
  window.__ibCalls = CALLS;
  window.__ibWorld = {
    gate: { implemented: true, open: true, configurationCommandsExposed: ['BOOTSTRAP_CREDIT','PUT_BUDGET_POLICY','PUT_AUTONOMY_POLICY'] },
    walletPresent: true
  };
  /* ★ 角色目录：生产里那个名字有两条活入口 —— 裸标识符（social.js:607 顶层
     let）与 window.apiConfigs（social.js:2654 的 ibSocialLive 活 accessor）。
     这里两条都写。★ 为什么必须在**每次渲染之前**重写一次：页面自己的
     loadApiConfigs() 是异步的，在这个空 profile 上它随后会把 apiConfigs
     覆盖成 []，而那一页看起来就像"还没有配置任何角色"。 */
  function seedRoles() {
    try { apiConfigs = [{ id: 'agent_a', nickname: '小灰' }]; } catch (e) {}
    try { window.apiConfigs = [{ id: 'agent_a', nickname: '小灰' }]; } catch (e) {}
  }
  window.__ibSeedRoles = seedRoles;
  seedRoles();
  try { localStorage.setItem('ib_home_node_token', 'visual-token'); } catch (e) {}
  function walletBody() {
    if (!window.__ibWorld.walletPresent) return { ok: false, error: 'wallet-not-found', status: 404 };
    return { ok: true, wallet: { domain: 'economy', walletId: 'econ_wallet_vis', owner: { type: 'character', id: 'agent_a' },
      currency: 'IB_CREDIT', state: 'READY', balanceKnown: true,
      cachedBalanceMinor: '98500', ledgerBalanceMinor: '98500', reservedBalanceMinor: '0',
      availableBalanceMinor: '98500', revision: 12 } };
  }
  var send = function (obj, status) {
    var body = JSON.stringify(obj);
    return Promise.resolve({ ok: (status || 200) < 400, status: status || 200, headers: { get: function(){ return 'application/json'; } },
      text: function () { return Promise.resolve(body); }, json: function () { return Promise.resolve(obj); } });
  };
  window.fetch = function (url, init) {
    var u = String(url); var method = String((init && init.method) || 'GET').toUpperCase();
    var pathOnly = u.replace(/^https?:\\/\\/[^/]+/, '');
    if (method === 'POST') {
      var parsed = null;
      try { parsed = JSON.parse((init && init.body) || '{}'); } catch (e) { parsed = null; }
      CALLS.posts.push({ path: pathOnly, body: parsed });
      if (pathOnly === '/internal/economy/configuration') {
        var cmd = parsed && parsed.command;
        if (cmd === 'BOOTSTRAP_CREDIT') {
          window.__ibWorld.walletPresent = true;
          return send({ ok: true, protocolVersion: 1, command: cmd, configuredAnything: true,
            initialCreditMintedNow: true, initialCreditBootstrapped: true,
            alreadyBootstrappedBeforeThisRequest: false, creditMinted: true,
            budgetPolicyWritten: false, autonomyPolicyWritten: false,
            walletId: 'econ_wallet_vis', amountMinor: '100000', currency: 'IB_CREDIT', ownerId: 'agent_a' });
        }
        return send({ ok: true, protocolVersion: 1, command: cmd, configuredAnything: true,
          budgetPolicyWritten: cmd === 'PUT_BUDGET_POLICY', autonomyPolicyWritten: cmd === 'PUT_AUTONOMY_POLICY',
          creditMinted: false, replayed: false, ledgerMutation: false, purchaseMutation: false,
          approvalMutation: false, policyId: 'econ_bp_vis', policyRevision: 8, ownerId: 'agent_a' });
      }
      return send({ ok: false, error: 'not-found' }, 404);
    }
    CALLS.reads.push({ path: pathOnly });
    if (pathOnly.indexOf('/security') === 0) {
      return send({ ok: true, protocolVersion: 1, economyPolicy: {
        configuration: window.__ibWorld.gate,
        approvalDecision: { implemented: true, open: true } } });
    }
    if (pathOnly.indexOf('/economy/wallet') === 0) return send(walletBody());
    if (pathOnly.indexOf('/economy/policy') === 0) {
      return send({ ok: true, policy: { domain: 'economy', namespace: 'budget', policyId: 'econ_bp_vis',
        ownerId: 'agent_a', currency: 'IB_CREDIT', status: 'ACTIVE',
        limits: { perTransactionMinor: '5000', dailyMinor: '40000', approvalThresholdMinor: '3000' },
        termEndsAt: null, expiredByTerm: false, hardStop: false, autonomyLevel: 'LIMITED', revision: 7,
        createdAt: Date.now() - 86400000, updatedAt: Date.now() - 3600000 } });
    }
    if (pathOnly.indexOf('/economy/autonomy-policy') === 0) {
      return send({ ok: true, policy: { domain: 'economy', namespace: 'budget', kind: 'autonomy',
        policyId: 'econ_bp_vis_auto', ownerId: 'agent_a', enabled: true,
        perPurchaseLimitMinor: '8000', dailyAutonomousLimitMinor: '30000', approvalAboveMinor: '4000',
        allowedProductKinds: ['DIGITAL_ITEM','COMPUTE_CREDIT'], allowedSettlementTypes: ['COMPUTE_GRANT'],
        allowGift: false, usable: true, problems: [], revision: 3,
        createdAt: Date.now() - 86400000, updatedAt: Date.now() - 3600000,
        grantsBudget: false, replacesBudget: false, isADecisionLayer: false } });
    }
    if (pathOnly.indexOf('/economy/budget') === 0) {
      return send({ ok: true, decision: { outcome: 'ALLOW' },
        snapshot: { domain: 'economy', ownerId: { type: 'character', id: 'agent_a' }, currency: 'IB_CREDIT',
          walletId: 'econ_wallet_vis', walletState: 'READY', walletStateReason: null,
          ledgerBalanceMinor: '98500', reservedBalanceMinor: '0', availableBalanceMinor: '98500',
          spentTodayMinor: '10000', spentThisWeekMinor: '10000', spentThisMonthMinor: '10000',
          windows: null, countedTransactions: 2, policyId: 'econ_bp_vis', policyStatus: 'ACTIVE',
          policyTermEndsAt: null, amountMinor: '1', now: Date.now(), timezone: 'UTC' },
        evaluatedOnly: true, notASpendPermit: 'snapshot-only', reserved: false });
    }
    if (pathOnly.indexOf('/economy/intents') === 0) return send({ ok: true, intents: [] });
    if (pathOnly.indexOf('/economy/approvals') === 0) return send({ ok: true, approvals: [] });
    if (pathOnly.indexOf('/economy/products') === 0) return send({ ok: true, products: [] });
    return send({ ok: false, error: 'not-found' }, 404);
  };
})();`;

/* 正在显示的那一块面板的排版度量。 */
const metricsOf = `(function(){
  function px(v){ return Math.round(v*100)/100; }
  function box(n){ return n ? n.getBoundingClientRect() : null; }
  var page = document.getElementById('page-economy');
  var shell = document.getElementById('economy-configuration');
  var requests = document.getElementById('economy-requests');
  var panes = ['economy-config-wallet','economy-config-budget','economy-config-autonomy'];
  var visible = panes.filter(function(id){ var n=document.getElementById(id); return n && !n.hidden; });
  var pane = visible.length ? document.getElementById(visible[0]) : null;
  var card = pane ? pane.querySelector('.ecfg-card') : null;
  var cb = box(card);
  var meterTrack = pane ? pane.querySelector('.ecfg-meter-track') : null;
  var meterFill = pane ? pane.querySelector('.ecfg-meter-fill') : null;
  var tb = box(meterTrack), fb = box(meterFill);
  var primary = pane ? pane.querySelector('.ecfg-btn-primary') : null;
  var pb = box(primary);
  var title = shell ? shell.querySelector('.ecfg-card-title') : null;
  var figure = pane ? pane.querySelector('.ecfg-figure.is-primary .ecfg-figure-v') : null;
  var input = pane ? pane.querySelector('.ecfg-input') : null;
  return {
    pageOpen: !!(page && page.classList.contains('active')),
    shellPresent: !!shell,
    shellWidth: shell ? Math.round(shell.getBoundingClientRect().width) : 0,
    requestsVisible: !!(requests && requests.style.display !== 'none'),
    visiblePanes: visible,
    tabLabels: shell ? [].slice.call(shell.querySelectorAll('.ecfg-tab')).map(function(t){ return t.textContent.replace(/\\s+/g,''); }) : [],
    activeTab: shell ? (function(){ var t=shell.querySelector('.ecfg-tab.is-active'); return t?t.textContent.replace(/\\s+/g,''):''; })() : '',
    cardWidth: cb ? Math.round(cb.width) : 0,
    cardCount: pane ? pane.querySelectorAll('.ecfg-card').length : 0,
    meterWidth: tb ? Math.round(tb.width) : 0,
    meterFillWidth: fb ? Math.round(fb.width) : 0,
    meterRatio: (tb && fb && tb.width > 0) ? Math.round((fb.width / tb.width) * 100) : -1,
    inputCount: pane ? pane.querySelectorAll('.ecfg-input').length : 0,
    inputFont: input ? getComputedStyle(input).fontVariantNumeric : '',
    inputFontSize: input ? getComputedStyle(input).fontSize : '',
    figureFont: figure ? getComputedStyle(figure).fontSize : '',
    figureNumbers: figure ? getComputedStyle(figure).fontVariantNumeric : '',
    titleColor: title ? getComputedStyle(title).color : '',
    titleShadow: title ? getComputedStyle(title).textShadow : '',
    primaryButtons: pane ? pane.querySelectorAll('.ecfg-btn-primary').length : -1,
    primaryHeight: pb ? Math.round(pb.height) : 0,
    primaryWidth: pb ? Math.round(pb.width) : 0,
    tier1: visible.length ? visible[0] : null,
    overflowX: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
    paneOverflowX: pane ? (pane.scrollWidth - pane.clientWidth) : 0,
    svgCount: shell ? shell.querySelectorAll('svg').length : 0,
    imgCount: shell ? shell.querySelectorAll('img').length : 0,
    technicalCount: shell ? shell.querySelectorAll('.ecfg-technical').length : 0,
    boundText: pane ? (function(){ var b=pane.querySelector('.ecfg-bound-text'); return b?b.textContent:''; })() : '',
    noStoreScope: pane ? (function(){ var n=pane.querySelector('.ecfg-note.is-quiet'); var out=''; var list=pane.querySelectorAll('.ecfg-note.is-quiet'); for (var i=0;i<list.length;i++){ if (list[i].textContent.indexOf('商店范围')>=0) out=list[i].textContent; } return out; })() : '',
    checkCount: pane ? pane.querySelectorAll('.ecfg-check').length : 0,
    ownerOptions: (function(){ var s = document.getElementById('economy-owner-select'); return s ? [].slice.call(s.options).map(function(o){ return o.value; }) : []; })(),
    advancedHidden: pane ? (function(){ var n=pane.querySelector('.ecfg-advanced-body'); return n ? n.hidden : null; })() : null,
    gateCount: pane ? pane.querySelectorAll('.ecfg-gate').length : 0,
    flagText: pane ? (function(){ var f=pane.querySelector('.ecfg-flag-text'); return f?f.textContent:''; })() : '',
    emptyTitle: pane ? (function(){ var t=pane.querySelector('.ecfg-empty-title'); return t?t.textContent:''; })() : '',
    bootstrapInput: !!(pane && pane.querySelector('#ecfg-f-bootstrapAmount')),
    bodyText: pane ? pane.innerText.replace(/\\s+/g,' ').slice(0, 400) : '',
    unitLabels: pane ? [].slice.call(pane.querySelectorAll('.ecfg-unit')).map(function(n){ return n.textContent; }) : [],
    rawCodeHits: (function(){
      if (!pane) return [];
      var t = pane.innerText;
      return ['IB_CREDIT','perTransactionMinor','dailyMinor','approvalThresholdMinor','autonomyLevel',
        'allowedProductKinds','perPurchaseLimitMinor','PUT_BUDGET_POLICY','BOOTSTRAP_CREDIT']
        .filter(function(w){ return t.indexOf(w) >= 0; });
    })()
  };
})()`;

(async function main() {
  const exe = chromePath();
  if (!exe) { console.error('找不到 Chrome/Edge；跳过视觉核对。'); process.exit(2); }
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-16-chrome-'));
  const child = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', '--disable-gpu', '--force-device-scale-factor=1',
    '--allow-file-access-from-files', 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  try {
    cdp = await (async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const list = await new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: port, path: '/json/list' }, res => {
              let raw = '';
              res.on('data', c => { raw += c; });
              res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
            }).on('error', reject);
          });
          const target = list.filter(t => t.type === 'page')[0];
          if (target && target.webSocketDebuggerUrl) return await Cdp.connect(target.webSocketDebuggerUrl);
        } catch (e) { /* 还没起来 */ }
        await new Promise(r => setTimeout(r, 250));
      }
      throw new Error('CDP 连接超时');
    })();

    const evaluate = async (expression, awaitPromise) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
      if (r.exceptionDetails) throw new Error('evaluate: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    };

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: PAGE_URL });
    await loaded;
    await evaluate(SEED);
    const loaded2 = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.reload', { ignoreCache: false });
    await loaded2;
    await evaluate(SEED);
    await new Promise(r => setTimeout(r, 400));

    /* 把向导 / 欢迎层收起来（它们会盖住页面）。
       ★ 首启的欢迎屏是 `#splash`：`position:fixed; inset:0; z-index:9999`，
         与 `#app` 是**兄弟**节点，因此把它收起来不会动到任何一页。
         一条只按文案匹配的收场是不够的（P22-16 开发期实测：截图里全是
         蝴蝶欢迎页，而所有断言都通过了 —— 断言读的是 `#page-economy`
         的 class，截图读的是像素，两者看到的不是同一件事）。 */
    const dismissOverlays = `(function(){
      /* ① 首启欢迎屏（#splash：position:fixed;inset:0;z-index:9999，与 #app 平级）。 */
      ['splash', 'splash-mist', 'gw-slot'].forEach(function (id) {
        var n = document.getElementById(id);
        if (n) { n.classList.add('hidden'); n.style.display = 'none'; }
      });
      [].forEach.call(document.querySelectorAll('[id^="splash"], .splash-content'), function (n) {
        n.style.display = 'none';
      });
      /* ② 首启设置向导（setup-wizard.js 建的覆盖层，z-index 10000）。 */
      var setup = document.getElementById('ib-setup');
      if (setup) { setup.classList.remove('is-open'); setup.style.display = 'none'; }
      /* ③ 页面过渡用的整屏玻璃（widgets.css 的 .page-overlay.show：inset:0 +
         backdrop-filter:blur(14px)）。它停在 show 状态时整页会糊成一团雾，
         而**所有 DOM 断言仍然全绿** —— 截图与断言看到的不是同一件事。 */
      var cover = document.getElementById('page-overlay');
      if (cover) { cover.classList.remove('show'); cover.style.display = 'none'; }
      [].forEach.call(document.querySelectorAll('.page-overlay'), function (n) {
        n.classList.remove('show'); n.style.display = 'none';
      });
      [].forEach.call(document.querySelectorAll('div'), function (el) {
        if (el.style.display === 'none') return;
        var t = (el.textContent || '').trim();
        if (t.length < 400 && (t.indexOf('数据库清空') >= 0 || t.indexOf('欢迎使用 InternalBeyond') >= 0)) el.style.display = 'none';
      });
      /* ④ 主应用容器。★ 这一条是**必须**的：首启的进场时间线会在欢迎屏
         退场之后才把 #app 从 opacity:0 淡入；强行收起欢迎屏会让那条
         时间线永远不完成，于是整页停在"完全透明 + 底下只有一张模糊背景"。
         实测症状与"有一层模糊盖住了页面"一模一样（截图是一团雾），但
         它既没有覆盖层也没有 filter —— 只是一个 opacity:0 的祖先。 */
      var app = document.getElementById('app');
      if (app) { app.style.transition = 'none'; app.style.opacity = '1'; }
      return true;
    })()`;

    /* 谁在盖住页面？两个判据，缺一不可：
       ① **压在上面**的整屏模糊层（z-index ≥ 2 + 覆盖 ≥90% 视口 + 有模糊）；
       ② 主容器自己的可见性（`#app` 的 opacity 与祖先链上的 filter）。
       ★ 判据 ① 的 z ≥ 2 是刻意的：`#bg-internal-img` 那层的 blur(22px) 是
       页面自己的背景（z-index:0，在内容底下），而 `.ecfg-card` 的
       backdrop-filter 正是本阶段要的玻璃 —— 把它们算进来会得到一条
       "为了通过必须删掉一个正确实现"的假红。 */
    const overlayReport = `(function(){
      var W = window.innerWidth, H = window.innerHeight;
      var out = [];
      [].forEach.call(document.querySelectorAll('body *'), function (n) {
        var cs = getComputedStyle(n);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
        var z = Number(cs.zIndex);
        if (!(z >= 2)) return;
        var r = n.getBoundingClientRect();
        if (r.width < W * 0.9 || r.height < H * 0.9) return;
        var bf = String(cs.backdropFilter || cs.webkitBackdropFilter || '');
        var f = String(cs.filter || '');
        if (bf === 'none' && f === 'none') return;
        out.push({ why: 'covering', id: n.id || '', cls: String(n.className || '').slice(0, 40), z: cs.zIndex, bf: bf, filter: f });
      });
      var node = document.getElementById('page-economy');
      while (node && node.tagName !== 'HTML') {
        var cs2 = getComputedStyle(node);
        if (Number(cs2.opacity) < 0.99) {
          out.push({ why: 'ancestor-opacity', id: node.id || '', cls: String(node.className || '').slice(0, 40), opacity: cs2.opacity });
        }
        if (String(cs2.filter) !== 'none' || String(cs2.backdropFilter) !== 'none') {
          out.push({ why: 'ancestor-filter', id: node.id || '', cls: String(node.className || '').slice(0, 40), filter: cs2.filter, bf: cs2.backdropFilter });
        }
        node = node.parentNode;
      }
      return out;
    })()`;

    const VIEWPORTS = [
      { key: 'desktop', width: 1440, height: 900, mobile: false },
      { key: 'tablet', width: 834, height: 1000, mobile: false },
      { key: 'mobile', width: 390, height: 780, mobile: true }
    ];
    const THEMES = [
      { key: 'internal', cls: '' },
      { key: 'infernal', cls: 'theme-infernal' }
    ];

    const shot = async (name, beyond) => {
      const s = await cdp.send('Page.captureScreenshot', beyond
        ? { format: 'png', captureBeyondViewport: true } : { format: 'png' });
      const file = path.join(SHOT_DIR, name + '.png');
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      console.log('    · 截图 ' + file);
      return file;
    };

    /* ══════════════════════════════════════════════════════════════ */
    section('① 主题 × 宽度：预算页的真实排版');

    const seenTitleColors = {};
    for (const theme of THEMES) {
      for (const vp of VIEWPORTS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile
        });
        await evaluate(`(function(){
          document.body.className = '${theme.cls}';
          try { localStorage.setItem('ib_theme', '${theme.key}'); } catch (e) {}
          window.__ibSeedRoles();
          if (location.hash !== '#economy') location.hash = 'economy';
          if (window.IB && IB.economyConfigurationUI) { IB.economyConfigurationUI.render(); IB.economyConfigurationUI.show('budget'); }
          return true;
        })()`);
        await new Promise(r => setTimeout(r, 700));
        await evaluate(dismissOverlays);
        await new Promise(r => setTimeout(r, 300));
        const m = await evaluate(metricsOf);
        const label2 = theme.key + '/' + vp.key;
        const covering = await evaluate(overlayReport);
        if (label2 === 'internal/desktop') {
          console.log('    · 祖先链：' + JSON.stringify(await evaluate(`(function(){
            var out = []; var n = document.getElementById('page-economy');
            while (n && n !== document.documentElement.parentNode) {
              var cs = getComputedStyle(n);
              out.push({ t: n.tagName + (n.id ? ('#' + n.id) : '') + (n.className ? ('.' + String(n.className).split(/\\s+/).join('.')) : ''),
                filter: cs.filter, bf: cs.backdropFilter, op: cs.opacity, z: cs.zIndex, disp: cs.display, pos: cs.position });
              n = n.parentNode;
            }
            return out;
          })()`)));
        }
        check(label2 + ' · 没有任何覆盖视口的模糊层压在页面上（截图看到的必须是这一页）',
          covering.length === 0, covering);
        const label = theme.key + '/' + vp.key;
        seenTitleColors[theme.key] = m.titleColor;
        if (label === 'internal/desktop') console.log('    · 角色目录读到了 ' + JSON.stringify(m.ownerOptions));

        check(label + ' · 页面真的打开着，外壳在，四个页签就是 §2 的信息架构',
          m.pageOpen === true && m.shellPresent === true && m.activeTab === '预算限制' &&
          m.tabLabels.join(',') === '待处理,钱包与初始额度,预算限制,自主购买', m);
        check(label + ' · 没有横向溢出（文档与面板都没有超过视口）',
          m.overflowX <= 1 && m.paneOverflowX <= 1, { overflowX: m.overflowX, pane: m.paneOverflowX });
        check(label + ' · 卡片不会横跨整个屏幕（有内容最大宽度）',
          m.cardWidth > 0 && m.cardWidth <= Math.min(m.shellWidth + 1, 941), { card: m.cardWidth, shell: m.shellWidth });
        check(label + ' · 刻度条真的按权威数据算出了 25%（10000 / 40000）',
          m.meterWidth > 0 && m.meterRatio === 25, { ratio: m.meterRatio, w: m.meterWidth, fill: m.meterFillWidth });
        check(label + ' · 输入框用等宽数字排版（额度能一眼扫读）',
          String(m.inputFont).indexOf('tabular-nums') >= 0, { input: m.inputFont, figure: m.figureNumbers });
        check(label + ' · 图标与空状态都是 inline SVG，页面上没有一个位图',
          m.svgCount >= 3 && m.imgCount === 0, { svg: m.svgCount, img: m.imgCount });
        check(label + ' · 高级设置默认收起（不铺满整页）',
          m.advancedHidden === true, m.advancedHidden);
        check(label + ' · 正文里没有 canonical 的原始代号（IB_CREDIT 这一类只在输入框右边写成 IB Credit）',
          m.rawCodeHits.length === 0 && m.unitLabels.length >= 3 &&
          m.unitLabels.every(u => u === 'IB Credit'),
          { hits: m.rawCodeHits, units: m.unitLabels });
        if (vp.mobile) {
          check(label + ' · 手机上主按钮是整行可点（≥42px 高、占满面板宽度）',
            m.primaryHeight >= 42 && m.primaryWidth >= m.cardWidth - 40,
            { h: m.primaryHeight, w: m.primaryWidth, card: m.cardWidth });
        } else {
          check(label + ' · 桌面上主按钮高度正常（≥34px）', m.primaryHeight >= 34, m.primaryHeight);
        }
        await evaluate(dismissOverlays);
        await shot('p22-16-budget-' + theme.key + '-' + vp.key, vp.mobile);
      }
    }

    check('★★★ 两套主题真的换了令牌（标题颜色不同），而且浅色主题关掉了那层会糊掉小字的白色发光',
      seenTitleColors.internal && seenTitleColors.infernal &&
      seenTitleColors.internal !== seenTitleColors.infernal,
      seenTitleColors);

    /* ══════════════════════════════════════════════════════════════ */
    section('② 三个配置页签 × 手机宽度：都不横向溢出');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await evaluate(`(function(){ document.body.className = ''; return true; })()`);
    for (const key of ['wallet', 'budget', 'autonomy']) {
      await evaluate(`(function(){ IB.economyConfigurationUI.show('${key}'); return true; })()`);
      await new Promise(r => setTimeout(r, 500));
      await evaluate(dismissOverlays);
      const m = await evaluate(metricsOf);
      check('mobile/' + key + ' · 没有横向溢出，而且待处理那一块被 display 关掉了',
        m.overflowX <= 1 && m.paneOverflowX <= 1 && m.requestsVisible === false, m);
      check('mobile/' + key + ' · 面板真的出现了一张卡片', m.cardCount === 1, m.cardCount);
      await shot('p22-16-mobile-' + key, true);
    }

    /* ══════════════════════════════════════════════════════════════ */
    section('③ 钱包：已初始化 / 未初始化两种状态');

    /* ★ 显式设置视口：否则这一张 `-desktop` 的截图会带着上一步的手机宽度，
       而文件名就在说谎。 */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(function(){
      document.body.className = '';
      window.__ibSeedRoles();
      window.__ibWorld.walletPresent = true;
      window.__ibSeedRoles();
      IB.economyConfigurationUI.show('wallet');
      IB.economyConfigurationUI.refresh();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 800));
    await evaluate(dismissOverlays);
    const wInit = await evaluate(metricsOf);
    check('③-1 ★★★ 已初始化：说"初始额度已设置"，而且**没有**初始化输入框、没有主按钮',
      wInit.flagText === '初始额度已设置' && wInit.bootstrapInput === false && wInit.primaryButtons === 0, wInit);
    check('③-2 ★★★ 已初始化的钱包显示权威给的当前可用额度，而且主数是等宽数字、字号明显大于输入框',
      wInit.bodyText.indexOf('985.00 IB Credit') >= 0 &&
      String(wInit.figureNumbers).indexOf('tabular-nums') >= 0 &&
      parseFloat(wInit.figureFont) > parseFloat(wInit.inputFontSize || '0'),
      { text: wInit.bodyText, figure: wInit.figureFont, figureNums: wInit.figureNumbers, inputFont: wInit.inputFontSize });
    await shot('p22-16-wallet-initialized-desktop');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await evaluate(`(function(){
      document.body.className = '';
      window.__ibWorld.walletPresent = false;
      window.__ibSeedRoles();
      IB.economyConfigurationUI.refresh();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 800));
    await evaluate(dismissOverlays);
    const wFresh = await evaluate(metricsOf);
    check('③-3 ★★★ 未初始化：只有一个初始额度输入框 + 一个主按钮，页面说"还没有 IB Credit 钱包"',
      wFresh.bootstrapInput === true && wFresh.primaryButtons === 1 &&
      wFresh.bodyText.indexOf('还没有 IB Credit 钱包') >= 0, wFresh);
    check('③-4 ★★ 手机上未初始化的钱包也不横向溢出', wFresh.overflowX <= 1, wFresh.overflowX);
    await shot('p22-16-wallet-fresh-mobile', true);

    /* ══════════════════════════════════════════════════════════════ */
    section('④ 真实交互：改一个限额 → 保存 → 检查发出去的信封与后续重新读');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(function(){ document.body.className = ''; window.__ibSeedRoles(); IB.economyConfigurationUI.show('budget'); return true; })()`);
    await new Promise(r => setTimeout(r, 700));
    const postResult = await evaluate(`(function(){
      window.__ibCalls.posts.length = 0;
      window.__ibCalls.reads.length = 0;
      var input = document.getElementById('ecfg-f-limit-dailyMinor');
      input.value = '600';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      var pane = document.getElementById('economy-config-budget');
      var btn = pane.querySelector('.ecfg-btn-primary');
      btn.click();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 900));
    const afterSave = await evaluate(`(function(){
      var posts = window.__ibCalls.posts;
      var reads = window.__ibCalls.reads;
      var post = posts.length ? posts[0] : null;
      var body = post && post.body;
      var pane = document.getElementById('economy-config-budget');
      var fb = pane.querySelector('.ecfg-feedback-text');
      return {
        postCount: posts.length,
        economyPostCount: posts.filter(function(p){ return p.path.indexOf('/economy/') === 0; }).length,
        paths: posts.map(function(p){ return p.path; }),
        body: body,
        bodyKeys: body ? Object.keys(body).sort() : [],
        configKeys: body && body.config ? Object.keys(body.config).sort() : [],
        limits: body && body.config ? body.config.limits : null,
        feedback: fb ? fb.textContent : '',
        policyRereads: reads.filter(function(r){ return r.path.indexOf('/economy/policy') === 0; }).length,
        readPaths: reads.map(function(r){ return r.path; }),
        meterRatio: (function(){
          var t = pane.querySelector('.ecfg-meter-track'), f = pane.querySelector('.ecfg-meter-fill');
          return (t && f && t.getBoundingClientRect().width > 0) ? Math.round((f.getBoundingClientRect().width / t.getBoundingClientRect().width) * 100) : -1;
        })()
      };
    })()`);

    check('④-1 ★★★ 保存只发了**一**个请求，而且它落在 /internal/economy/configuration 上（/economy/* 的 POST 仍是 0）',
      afterSave.postCount === 1 && afterSave.economyPostCount === 0 &&
      afterSave.paths.join(',') === '/internal/economy/configuration', afterSave.paths);
    check('④-2 ★★★ 信封恰好三个键，config 的键逐一落在 canonical 白名单里，币种钉死 IB Credit',
      afterSave.bodyKeys.join(',') === 'command,config,idempotencyKey' &&
      afterSave.body.command === 'PUT_BUDGET_POLICY' &&
      afterSave.body.config.ownerId === 'agent_a' && afterSave.body.config.currency === 'IB_CREDIT' &&
      afterSave.configKeys.every(k => ['ownerId', 'currency', 'limits', 'termEndsAt', 'autonomyLevel', 'ifRevision'].indexOf(k) >= 0), afterSave);
    check('④-3 ★★★ 改的那一格按 scale 变成 60000 minor，没改的两格原样带上（不是被清空）',
      JSON.stringify(afterSave.limits) === JSON.stringify({
        perTransactionMinor: '5000', dailyMinor: '60000', approvalThresholdMinor: '3000'
      }), afterSave.limits);
    check('④-4 ★★★ 保存之后**重新读**了整组权威读面（不是乐观宣称）—— 五条里每一条都被再读了一次',
      afterSave.policyRereads >= 1 && afterSave.readPaths.length >= 4 &&
      ['/economy/policy', '/economy/wallet', '/economy/budget', '/security'].every(function (p) {
        return afterSave.readPaths.filter(function (x) { return x.indexOf(p) === 0; }).length >= 1;
      }), afterSave.readPaths);
    check('④-5 ★★★ 成功文案只说"预算规则已保存"，没有一个字说现在可以买',
      afterSave.feedback === '预算规则已保存' &&
      ['可以买', '现在可以', '已解锁'].every(w => afterSave.feedback.indexOf(w) < 0), afterSave.feedback);
    check('④-6 ★★ 刻度条仍然按权威的两个数画（10000 / 40000 = 25%）',
      afterSave.meterRatio === 25, afterSave.meterRatio);
    await evaluate(dismissOverlays);
    await shot('p22-16-budget-after-save-desktop');

    /* ══════════════════════════════════════════════════════════════ */
    section('⑤ 自主购买页：那句话与那些控件真的在，没有"完全放权"类按钮');

    await evaluate(`(function(){ window.__ibSeedRoles(); IB.economyConfigurationUI.show('autonomy'); return true; })()`);
    await new Promise(r => setTimeout(r, 600));
    await evaluate(dismissOverlays);
    const auto = await evaluate(metricsOf);
    check('⑤-1 ★★★ 页面上有"仍受 Budget / 报价 / Approval 约束"那句事实行',
      auto.boundText.indexOf('自主购买仍受') === 0 && auto.boundText.indexOf('Approval') > 0, auto.boundText);
    check('⑤-2 ★★★ 商品范围与交付方式是真的勾选框（1 开关 + 5 类别 + 3 交付 + 1 送礼 = 10），并且没有"商店范围"这个不存在的控件',
      auto.checkCount === 10 && auto.noStoreScope.indexOf('没有「商店范围」这一项') >= 0,
      { checks: auto.checkCount, note: auto.noStoreScope });
    check('⑤-3 ★★ 手机上自主购买页也不横向溢出', auto.overflowX <= 1, auto.overflowX);
    await shot('p22-16-autonomy-mobile', true);

    /* ══════════════════════════════════════════════════════════════ */
    section('⑥ 配置面关着：进页面就说清楚，一个假按钮都没有');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(function(){
      document.body.className = '';
      window.__ibWorld.gate = { implemented: true, open: false, configurationCommandsExposed: [] };
      window.__ibSeedRoles();
      IB.economyConfigurationUI.show('budget');
      IB.economyConfigurationUI.refresh();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 800));
    await evaluate(dismissOverlays);
    const closed = await evaluate(metricsOf);
    check('⑥-1 ★★★ 配置面关着时给出不可用状态与原因，而且**没有**保存按钮、没有输入框',
      closed.gateCount === 1 && closed.primaryButtons === 0 && closed.inputCount === 0, closed);
    check('⑥-2 ★★ 关着时也不横向溢出', closed.overflowX <= 1, closed.overflowX);
    await shot('p22-16-closed-desktop');

    /* ══════════════════════════════════════════════════════════════ */
    section('⑦ P22-15 的「待处理」不回归');

    await evaluate(`(function(){
      window.__ibWorld.gate = { implemented: true, open: true, configurationCommandsExposed: ['BOOTSTRAP_CREDIT','PUT_BUDGET_POLICY','PUT_AUTONOMY_POLICY'] };
      window.__ibSeedRoles();
      IB.economyConfigurationUI.show('requests');
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 700));
    await evaluate(dismissOverlays);
    const requests = await evaluate(`(function(){
      var host = document.getElementById('economy-requests');
      var shell = document.getElementById('economy-configuration');
      var panes = ['economy-config-wallet','economy-config-budget','economy-config-autonomy'];
      return {
        requestsVisible: host.style.display !== 'none',
        requestsParentIsPage: host.parentNode === document.getElementById('page-economy'),
        requestsIsSecondChild: document.getElementById('page-economy').children[1] === host,
        shellIsFirstChild: document.getElementById('page-economy').children[0] === shell,
        paneHidden: panes.map(function(id){ return document.getElementById(id).hidden; }),
        title: (function(){ var t=host.querySelector('.ec-title'); return t?t.textContent:''; })(),
        emptySurface: host.querySelectorAll('.ec-surface-empty').length,
        overflowX: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth
      };
    })()`);
    check('⑦-1 ★★★ 「待处理」仍然可见、仍然在原位（外壳插在它前面，它的节点没有被搬动）',
      requests.requestsVisible === true && requests.requestsParentIsPage === true &&
      requests.requestsIsSecondChild === true && requests.shellIsFirstChild === true, requests);
    check('⑦-2 ★★★ 切到「待处理」时三块配置面板全部收起，P22-15 的空状态照旧渲染',
      requests.paneHidden.join(',') === 'true,true,true' && requests.title === '待决定' &&
      requests.emptySurface === 1, requests);
    check('⑦-3 ★★ 待处理页在桌面宽度也不横向溢出', requests.overflowX <= 1, requests.overflowX);
    await shot('p22-16-requests-desktop');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await new Promise(r => setTimeout(r, 500));
    await evaluate(dismissOverlays);
    const requestsMobile = await evaluate(metricsOf);
    check('⑦-4 ★★ 待处理页在手机宽度也不横向溢出', requestsMobile.overflowX <= 1, requestsMobile.overflowX);
    await shot('p22-16-requests-mobile', true);

  } catch (error) {
    failures += 1;
    console.error('  ✖ 视觉核对失败 — ' + String((error && error.stack) || error));
  } finally {
    try { if (cdp) await cdp.send('Browser.close'); } catch (e) { }
    try { child.kill(); } catch (e) { }
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { }
  }

  console.log('\n' + '─'.repeat(66));
  console.log('P22-16 visual: ' + (checks - failures) + '/' + checks + ' checks passed');
  console.log('截图目录：' + SHOT_DIR + '（不在仓库里：本阶段 PNG 新增 = 0）');
  if (failures) { console.error('FAILED: ' + failures); process.exit(1); }
})();
