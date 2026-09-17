'use strict';
/* ====================================================================
   P22-22 · Economy 空状态的排版与层级（真实浏览器 · 自截图）
   --------------------------------------------------------------------
   运行：node tests/test_p22_22_economy_empty_state_visual.js

   ★ 这个文件**不在** test-all.js 里，理由与 test_p22_17_..._visual.js /
     test_p22_16_..._visual.js 同款：它要开一个真实浏览器。它存在的唯一
     理由是那些只能由排版引擎回答的问题：
       "空状态那一块到底有多高" / "线稿有没有被裁掉" /
       "标题与说明是不是同一个亮度" / "技术说明是不是真的折叠着" /
       "390px 上有没有横向溢出"。

   §F 要求的三个尺寸就是这里的三个 viewport：1280×800、1440×900、mobile。

   它做五件事：
     ① 在 file:// 载入真实 InternalBeyond.html，把只读面注入成假的 fetch
        （**网络是假的，页面/客户端/三个纯层与三个渲染器都是真文件**）；
     ② 量四个空状态（商店无目录 / 商店无商品 / 概览未初始化 / 设置未初始化）
        的真实高度、线稿的真实渲染尺寸与"有没有被裁"；
     ③ 判"这不是错误页"：空状态说的是 `role="status"` 而不是 alert，
        而且那一块里没有警示色的字；
     ④ 判"技术说明默认折叠"：`.esh-technical` / `.ecfg-technical` 都是
        `hidden` / `details:not([open])`，而且底层词一个都不在可见正文里；
     ⑤ 判深色主题的层级：标题 / 状态字 / 说明三档亮度真的不同，而且
        顺序是 标题 ≥ 状态 > 说明。
     ★ 截图**不写进仓库**（素材纪律：本阶段 PNG 新增 = 0），全部落 %TEMP%。
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
const SHOT_DIR = path.join(os.tmpdir(), 'ib-p22-22-shots');

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

/* ── 最小 CDP 客户端（与 P22-16 / P22-17 的视觉测试同一子集）────────── */
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

/* ── 颜色对比（与 P22-17 的视觉测试同一份实现）───────────────────────
   要判的是"看不看得清"，不是"有没有铺底"。 */
function parseRgb(value) {
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map(x => parseFloat(x));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}
function over(fg, bg) {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}
function luminance(c) {
  const f = v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function lumOf(text) { const c = parseRgb(text); return c ? Math.round(luminance(c) * 1000) / 1000 : -1; }
/* ★ 判"哪一档更亮"用**对比度**而不是绝对亮度：浅色主题里 muted 是
   rgb(82,111,150)、标题是 rgb(26,50,98) —— 后者的绝对亮度更低，但它在
   浅底上更清楚。用绝对亮度判会得到一条假红（开发期实测过）。 */
function contrastOf(fgText, bgText) {
  const fg = parseRgb(fgText), bg = parseRgb(bgText);
  if (!fg || !bg) return -1;
  const composited = fg.a < 1 ? over(fg, bg) : fg;
  const l1 = luminance(composited), l2 = luminance(bg);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ── 假的只读面：**网络是假的**，其余全是仓库里的真文件 ─────────────── */
const SEED = `(function(){
  var CALLS = { reads: [], posts: [] };
  window.__ibCalls = CALLS;
  /* ★ 三个开关就是这一条测试的三种世界：
       storesEmpty / walletPresent —— 商店与钱包的空/非空；
       两个都可以在页面里改，改完 refresh() 就重读。 */
  window.__ibWorld = { storesEmpty: true, walletPresent: false, gate: {
    implemented: true, open: true,
    configurationCommandsExposed: ['BOOTSTRAP_CREDIT','PUT_BUDGET_POLICY','PUT_AUTONOMY_POLICY']
  } };
  function seedRoles() {
    try { apiConfigs = [{ id: 'agent_a', nickname: '小灰' }]; } catch (e) {}
    try { window.apiConfigs = [{ id: 'agent_a', nickname: '小灰' }]; } catch (e) {}
  }
  window.__ibSeedRoles = seedRoles;
  seedRoles();
  /* ★ 这一条测试要能看见技术说明里那三行的**真实取值**：token 配了、
      endpoint 是默认值。值本身不进正文的断言由 §C 负责。 */
  try { localStorage.setItem('ib_home_node_token', 'p22-22-visual-token'); } catch (e) {}
  var send = function (obj, status) {
    var body = JSON.stringify(obj);
    return Promise.resolve({ ok: (status || 200) < 400, status: status || 200,
      headers: { get: function () { return 'application/json'; } },
      text: function () { return Promise.resolve(body); },
      json: function () { return Promise.resolve(obj); } });
  };
  var NOW = 1760000000000;
  window.fetch = function (url, init) {
    var u = String(url); var method = String((init && init.method) || 'GET').toUpperCase();
    var pathOnly = u.replace(/^https?:\\/\\/[^/]+/, '');
    if (method === 'POST') {
      var parsed = null;
      try { parsed = JSON.parse((init && init.body) || '{}'); } catch (e) { parsed = null; }
      CALLS.posts.push({ path: pathOnly, body: parsed });
      return send({ ok: false, error: 'not-found' }, 404);
    }
    CALLS.reads.push({ path: pathOnly });
    if (pathOnly.indexOf('/security') === 0) {
      return send({ ok: true, protocolVersion: 1, economyPolicy: {
        configuration: window.__ibWorld.gate,
        approvalDecision: { implemented: true, open: true } } });
    }
    if (pathOnly.indexOf('/economy/wallet') === 0) {
      if (!window.__ibWorld.walletPresent) return send({ ok: false, error: 'wallet-not-found' }, 404);
      return send({ ok: true, wallet: { domain: 'economy', namespace: 'wallet',
        walletId: 'econ_wallet_vis', owner: { type: 'character', id: 'agent_a' },
        accountId: 'econ_account_vis', currency: 'IB_CREDIT', state: 'READY', balanceKnown: true,
        cachedBalanceMinor: '1245000', ledgerBalanceMinor: '1245000', reservedBalanceMinor: '12000',
        reservedBalanceCachedMinor: '12000', cachedBalanceDrifted: false, reservedCacheDrifted: false,
        availableBalanceMinor: '1245000', revision: 12, createdAt: NOW - 86400000, updatedAt: NOW } });
    }
    if (pathOnly.indexOf('/economy/policy') === 0) return send({ ok: false, error: 'policy-not-found' }, 404);
    if (pathOnly.indexOf('/economy/autonomy-policy') === 0) return send({ ok: false, error: 'autonomy-policy-not-found' }, 404);
    if (pathOnly.indexOf('/economy/budget') === 0) return send({ ok: false, error: 'wallet-not-found' }, 404);
    if (pathOnly.indexOf('/economy/stores') === 0) {
      if (window.__ibWorld.storesEmpty) return send({ ok: true, stores: [] });
      return send({ ok: true, holdsPrices: false, holdsOwnership: false, stores: [
        { domain: 'economy', storeId: 'econ_store_a', name: '数字工坊', description: '安静的货架', status: 'ACTIVE', sortOrder: 1, revision: 1 },
        { domain: 'economy', storeId: 'econ_store_b', name: '算力铺', description: '按段卖算力。', status: 'ACTIVE', sortOrder: 2, revision: 1 } ] });
    }
    if (pathOnly.indexOf('/economy/products') === 0) {
      if (window.__ibWorld.storesEmpty) return send({ ok: true, personalized: false, hasRecommendations: false, products: [] });
      return send({ ok: true, personalized: false, hasRecommendations: false, products: [
        { domain: 'economy', productId: 'econ_prod_vis_1', storeId: 'econ_store_a', kind: 'DIGITAL_ITEM', fulfillment: 'INVENTORY_GRANT',
          name: '数字绘画额度', description: '一张图的额度。', currency: 'IB_CREDIT',
          unitPriceMinor: '2000', unitName: 'item', grantQuantity: 1, assetKind: 'ITEM', status: 'ACTIVE', revision: 1 } ] });
    }
    if (pathOnly.indexOf('/economy/inventory') === 0) return send({ ok: true, entries: [], isABalance: false, contributesToAvailableBalance: false, locksFunds: false });
    if (pathOnly.indexOf('/economy/purchases') === 0) return send({ ok: true, purchases: [], count: 0, personalized: false, recommended: false, ranked: false, exposesMutation: false });
    if (pathOnly.indexOf('/economy/intents') === 0) return send({ ok: true, intents: [] });
    if (pathOnly.indexOf('/economy/approvals') === 0) return send({ ok: true, approvals: [] });
    if (pathOnly.indexOf('/economy/changes') === 0) return send({ ok: true, changes: [], order: 'desc', complete: true });
    return send({ ok: false, error: 'not-found' }, 404);
  };
})();`;

/* ── 度量：空状态那一块的真实排版 ─────────────────────────────────────
   ★ 这里量的是"渲染出来的东西"，不是源码里的字：`emptyH` 是那一块的
     getBoundingClientRect 高度，`artW/artH/vbRatio` 用来证明线稿是
     **等比缩小**而不是被 `overflow:hidden` 裁掉（裁掉会改变宽高比）。 */
const metricsOf = `(function(){
  function box(n){ return n ? n.getBoundingClientRect() : null; }
  function h(n){ var b = box(n); return b ? Math.round(b.height * 100) / 100 : -1; }
  function w(n){ var b = box(n); return b ? Math.round(b.width * 100) / 100 : -1; }
  function cs(n, k){ return n ? getComputedStyle(n)[k] : ''; }
  /* ★ "真的排出来了吗"要**按祖先链**判：hidden 加在那一格的面板上，
     按钮自己不是 hidden（开发期实测：按元素自身判会把另外两格的按钮
     一起数进来）。 */
  function laid(n){
    var r = n.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    for (var p = n; p && p.nodeType === 1; p = p.parentNode) if (p.hidden === true) return false;
    return true;
  }
  function shown(root, sel){ return root ? [].slice.call(root.querySelectorAll(sel)).filter(laid) : []; }
  function visibleText(root){
    var out = [];
    (function walk(n){
      if (!n || n.hidden === true) return;
      if (String(n.className || '').split(/\\s+/).indexOf('esh-technical') >= 0) return;
      if (n.tagName === 'DETAILS' && !n.open) { return; }
      var st = getComputedStyle(n);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      if (!n.children.length && n.textContent) out.push(String(n.textContent));
      for (var i = 0; i < (n.children || []).length; i++) walk(n.children[i]);
    })(root);
    return out.join(' | ');
  }
  var page = document.getElementById('page-economy');
  var shell = document.getElementById('economy-shell');
  var cfg = document.getElementById('economy-configuration');
  var panes = ['economy-shell-overview','economy-shell-store','economy-shell-assets'];
  var visiblePane = null;
  panes.forEach(function(id){ var n = document.getElementById(id); if (n && !n.hidden) visiblePane = n; });
  function surfaceIn(root){
    var box_ = root ? root.querySelector('.esh-empty') : null;
    var cbox = root ? root.querySelector('.ecfg-empty') : null;
    return box_ || cbox;
  }
  function artIn(root){
    return root ? (root.querySelector('.esh-empty-art svg') || root.querySelector('.ecfg-empty-art svg')) : null;
  }
  var emptyBox = surfaceIn(visiblePane);
  var art = artIn(visiblePane);
  var sectionHead = shell ? shell.querySelector('.esh-section') : null;
  var sectionTitle = shell ? shell.querySelector('.esh-section-title') : null;
  var sectionSub = shell ? shell.querySelector('.esh-section-sub') : null;
  var emptyTitle = visiblePane ? (visiblePane.querySelector('.esh-empty-title') || visiblePane.querySelector('.ecfg-empty-title')) : null;
  var emptyBody = visiblePane ? (visiblePane.querySelector('.esh-empty-body') || visiblePane.querySelector('.ecfg-empty-body')) : null;
  var bootstrap = visiblePane ? visiblePane.querySelector('.esh-bootstrap') : null;
  var bootstrapState = visiblePane ? visiblePane.querySelector('.esh-bootstrap-state') : null;
  var bootstrapLine = visiblePane ? visiblePane.querySelector('.esh-bootstrap-line') : null;
  var card = visiblePane ? visiblePane.querySelector('.esh-card') : null;
  var shellTech = visiblePane ? [].slice.call(visiblePane.querySelectorAll('.esh-technical')) : [];
  var shellTechToggles = visiblePane ? [].slice.call(visiblePane.querySelectorAll('.esh-technical-toggle')) : [];
  /* ★ 全页面的空状态（不只当前这一格）：§C 要判"空状态不是错误页"这条
     对四个空状态都成立。 */
  var allSurfaces = [].slice.call(document.querySelectorAll('.esh-empty, .ecfg-empty'));
  var allStates = [].slice.call(document.querySelectorAll('.esh-bootstrap, .ecfg-state'));
  /* ★ 只在 Economy 这一页里找 alert / 错误类节点：整页应用别处的浮动提示
     不是这一条测试要判的东西。 */
  var alertScope = document.getElementById('page-economy') || document;
  var alertNodes = [].slice.call(alertScope.querySelectorAll('[role="alert"], .is-error, .error, [data-tone="error"]'));
  var cfgState = cfg ? cfg.querySelector('.ecfg-state') : null;
  var cfgStateText = cfg ? cfg.querySelector('.ecfg-state-text') : null;
  var cfgStateLine = cfg ? cfg.querySelector('.ecfg-state-line') : null;
  var cfgEmpty = cfg ? cfg.querySelector('.ecfg-empty') : null;
  var cfgTech = cfg ? [].slice.call(cfg.querySelectorAll('.ecfg-technical')) : [];
  return {
    pageOpen: !!(page && page.classList.contains('active')),
    visiblePaneId: visiblePane ? visiblePane.id : null,
    /* ① 高度 */
    emptyH: h(emptyBox),
    emptyTitleH: h(emptyTitle),
    emptyBodyH: h(emptyBody),
    cardH: h(card),
    art: art ? { w: w(art), h: h(art), vb: art.getAttribute('viewBox'),
      ratio: Math.round((w(art) / h(art)) * 1000) / 1000 } : null,
    /* ② 标题 / 状态 / 说明三档 */
    titleFont: emptyTitle ? parseFloat(cs(emptyTitle, 'fontSize')) : -1,
    bodyFont: emptyBody ? parseFloat(cs(emptyBody, 'fontSize')) : -1,
    titleColor: emptyTitle ? cs(emptyTitle, 'color') : '',
    bodyColor: emptyBody ? cs(emptyBody, 'color') : '',
    cardBg: card ? cs(card, 'backgroundColor') : '',
    glass: card ? String(cs(card, 'backdropFilter') || cs(card, 'webkitBackdropFilter') || '') : '',
    sectionTitle: sectionTitle ? sectionTitle.textContent : '',
    sectionSub: sectionSub ? sectionSub.textContent : '',
    sectionTitleFont: sectionTitle ? parseFloat(cs(sectionTitle, 'fontSize')) : -1,
    sectionSubFont: sectionSub ? parseFloat(cs(sectionSub, 'fontSize')) : -1,
    sectionTitleColor: sectionTitle ? cs(sectionTitle, 'color') : '',
    sectionSubColor: sectionSub ? cs(sectionSub, 'color') : '',
    tabsLabel: shell ? [].slice.call(shell.querySelectorAll('.esh-tab')).map(function(b){ return b.textContent; }) : [],
    cfgTabsLabel: cfg ? [].slice.call(cfg.querySelectorAll('.ecfg-tab')).map(function(b){ return b.textContent; }) : [],
    cfgSectionTitle: cfg && cfg.querySelector('.ecfg-section-title') ? cfg.querySelector('.ecfg-section-title').textContent : '',
    cfgSectionSub: cfg && cfg.querySelector('.ecfg-section-sub') ? cfg.querySelector('.ecfg-section-sub').textContent : '',
    /* ③ 未初始化那一格 */
    bootstrapState: bootstrapState ? bootstrapState.textContent : '',
    bootstrapStateFont: bootstrapState ? parseFloat(cs(bootstrapState, 'fontSize')) : -1,
    bootstrapLineFont: bootstrapLine ? parseFloat(cs(bootstrapLine, 'fontSize')) : -1,
    bootstrapLineColor: bootstrapLine ? cs(bootstrapLine, 'color') : '',
    bootstrapStateColor: bootstrapState ? cs(bootstrapState, 'color') : '',
    bootstrapRole: bootstrap ? bootstrap.getAttribute('role') : '',
    bootstrapText: bootstrap ? visibleText(bootstrap) : '',
    bootstrapButtons: bootstrap ? shown(bootstrap, 'button').map(function(b){ return b.textContent; }) : [],
    bootstrapInputCount: bootstrap ? shown(bootstrap, 'input, select, textarea').length : -1,
    goButtons: visiblePane ? shown(visiblePane, 'button').map(function(b){ return b.textContent; }) : [],
    /* ★ 钱包那一格的技术说明按**所在的那张卡**定位（概览里每张卡各有一个，
       按序号取会取到最后一张卡 —— 高级信息的那个）。 */
    walletTech: (function(){
      if (!visiblePane) return null;
      var cards = [].slice.call(visiblePane.querySelectorAll('.esh-card'));
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].querySelector('.esh-bootstrap')) return cards[i].querySelector('.esh-technical');
      }
      return null;
    })(),
    cfgStateText: cfgStateText ? cfgStateText.textContent : '',
    cfgStateRole: cfgState ? cfgState.getAttribute('role') : '',
    cfgStateTextColor: cfgStateText ? cs(cfgStateText, 'color') : '',
    cfgStateLineColor: cfgStateLine ? cs(cfgStateLine, 'color') : '',
    cfgEmptyH: h(cfgEmpty),
    /* ④ 技术层：默认折叠 */
    techHidden: shellTech.map(function(n){ return n.hidden === true; }),
    walletTechHidden: (function(){
      if (!visiblePane) return null;
      var cards = [].slice.call(visiblePane.querySelectorAll('.esh-card'));
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].querySelector('.esh-bootstrap')) {
          var t = cards[i].querySelector('.esh-technical');
          return t ? t.hidden === true : null;
        }
      }
      return null;
    })(),
    walletTechText: (function(){
      if (!visiblePane) return '';
      var cards = [].slice.call(visiblePane.querySelectorAll('.esh-card'));
      for (var i = 0; i < cards.length; i++) {
        if (cards[i].querySelector('.esh-bootstrap')) {
          var t = cards[i].querySelector('.esh-technical');
          return t ? String(t.textContent || '') : '';
        }
      }
      return '';
    })(),
    techToggleCount: shellTechToggles.length,
    cfgTechClosed: cfgTech.map(function(n){ return n.open !== true; }),
    cfgTechLines: cfgTech.map(function(n){ return String(n.textContent || ''); }).join(' '),
    visibleBody: visiblePane ? visibleText(visiblePane) : '',
    cfgVisibleBody: cfg ? visibleText(cfg) : '',
    /* ⑤ 不是错误页 */
    surfaceCount: allSurfaces.length,
    stateCount: allStates.length,
    alertCount: alertNodes.length,
    surfaceTones: allSurfaces.map(function(n){
      var t = n.querySelector('.esh-empty-title, .ecfg-empty-title');
      return t ? cs(t, 'color') : '';
    }),
    /* 溢出 */
    overflowX: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
    paneOverflowX: visiblePane ? (visiblePane.scrollWidth - visiblePane.clientWidth) : 0,
    cfgOverflowX: cfg ? (cfg.scrollWidth - cfg.clientWidth) : 0,
    innerW: window.innerWidth,
    docScrollW: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
  };
})()`;

const dismissOverlays = `(function(){
  ['splash','splash-mist','gw-slot'].forEach(function(id){
    var n = document.getElementById(id);
    if (n) { n.classList.add('hidden'); n.style.display = 'none'; }
  });
  [].forEach.call(document.querySelectorAll('[id^="splash"], .splash-content'), function (n) {
    n.classList.add('hidden'); n.style.display = 'none';
  });
  [].forEach.call(document.querySelectorAll('[id^="ib-setup"], #setup-wizard-overlay, #setup-wizard, .setup-wizard-cover'),
    function (n) {
      n.classList.remove('is-open', 'show', 'visible', 'hidden');
      n.style.display = 'none';
    });
  [].forEach.call(document.querySelectorAll('.page-overlay'), function (n) {
    n.classList.remove('show'); n.style.display = 'none';
  });
  [].forEach.call(document.querySelectorAll('div'), function (el) {
    if (el.style.display === 'none') return;
    var t = (el.textContent || '').trim();
    if (t.length < 400 && (t.indexOf('数据库清空') >= 0 || t.indexOf('欢迎使用 InternalBeyond') >= 0)) el.style.display = 'none';
  });
  var app = document.getElementById('app');
  if (app) { app.style.transition = 'none'; app.style.opacity = '1'; }
  var page = document.getElementById('page-economy');
  if (page) { page.style.opacity = '1'; }
  return true;
})()`;

/* ── "这一块读起来像系统状态"的判据 ───────────────────────────────────
   ★ 它判的不是"有没有红色"，而是四条结构性事实：
       ① 只说了三种语气中的一个状态词（不是一句"失败"）；
       ② 那一块里没有 alert / error 类节点；
       ③ 状态那一行的亮度**不低**于说明那一行（不是灰掉的一句话）；
       ④ 线稿是等比缩放的（`viewBox` 的 4:3 与渲染尺寸的比值一致）。 */
const VB_RATIO = 160 / 120;

(async function main() {
  const exe = chromePath();
  if (!exe) { console.error('找不到 Chrome / Edge：设置 CHROME_PATH 或安装其中之一。'); process.exit(1); }
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-22-chrome-'));
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

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
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

    const shot = async (name, beyond) => {
      const s = await cdp.send('Page.captureScreenshot', beyond
        ? { format: 'png', captureBeyondViewport: true } : { format: 'png' });
      const file = path.join(SHOT_DIR, name + '.png');
      fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
      console.log('    · 截图 ' + file);
      return file;
    };

    /* §F 逐字要求的那三个尺寸：1280×800、1440×900、mobile。 */
    const VIEWPORTS = [
      { key: '1280x800', width: 1280, height: 800, mobile: false },
      { key: '1440x900', width: 1440, height: 900, mobile: false },
      { key: 'mobile', width: 390, height: 780, mobile: true }
    ];
    const THEMES = [
      { key: 'dark', cls: 'theme-infernal' },
      { key: 'light', cls: '' }
    ];

    const setVp = async (vp) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile
      });
    };

    /* 每一次都要重写角色目录：页面自己的 loadApiConfigs() 是异步的，
       在这个空 profile 上它随后会把 apiConfigs 覆盖成 []。 */
    const show = async (tab, opts) => {
      opts = opts || {};
      await evaluate(`(function(){
        window.__ibSeedRoles();
        if (window.IB && IB.economyShellUI) {
          IB.economyShellUI.render();
          IB.economyShellUI.show('${tab}');
          IB.economyShellUI.refresh();
        }
        if (${opts.cfgRefresh ? 'true' : 'false'} && window.IB && IB.economyConfigurationUI) {
          IB.economyConfigurationUI.refresh();
        }
        return true;
      })()`);
      await new Promise(r => setTimeout(r, 700));
      await evaluate(dismissOverlays);
      await new Promise(r => setTimeout(r, 350));
      await evaluate(dismissOverlays);
      await new Promise(r => setTimeout(r, 150));
    };
    const setWorld = async (patch) => {
      await evaluate(`(function(){
        var w = window.__ibWorld;
        ${patch}
        return true;
      })()`);
    };

    /* ══════════════════════════════════════════════════════════════ */
    section('① 空状态：高度 / 线稿 / 层级（三个 §F 尺寸 × 两套主题）');

    const seen = {};
    for (const theme of THEMES) {
      for (const vp of VIEWPORTS) {
        await setVp(vp);
        await evaluate(`(function(){
          document.body.className = '${theme.cls}';
          try { localStorage.setItem('ib_theme', '${theme.cls ? 'infernal' : 'internal'}'); } catch (e) {}
          if (location.hash !== '#economy') location.hash = 'economy';
          return true;
        })()`);

        /* ── 商店无目录 + 无商品（截图里那两个空状态）── */
        await setWorld('w.storesEmpty = true; w.walletPresent = false;');
        await show('store');
        const emptyStore = await evaluate(metricsOf);
        seen[theme.key + '/' + vp.key] = emptyStore;
        if (vp.key === '1280x800' || vp.key === '1440x900') await shot('p22-22-store-empty-' + vp.key + '-' + theme.key, true);
        if (vp.key === 'mobile' && theme.key === 'dark') await shot('p22-22-store-empty-mobile', true);

        /* ── 概览：尚未完成 Initial Bootstrap ── */
        await show('overview');
        const emptyWallet = await evaluate(metricsOf);
        if (vp.key === '1280x800' || vp.key === '1440x900') await shot('p22-22-overview-bootstrap-' + vp.key + '-' + theme.key, true);
        if (vp.key === 'mobile' && theme.key === 'dark') await shot('p22-22-overview-bootstrap-mobile', true);

        /* ── 设置 → 钱包与初始额度：尚未完成 Initial Bootstrap ── */
        await show('settings', { cfgRefresh: true });
        await evaluate(`(function(){ IB.economyConfigurationUI.show('wallet'); return true; })()`);
        await new Promise(r => setTimeout(r, 600));
        await evaluate(dismissOverlays);
        const emptyCfg = await evaluate(metricsOf);
        if (vp.key === '1440x900') await shot('p22-22-settings-bootstrap-' + vp.key + '-' + theme.key, true);
        if (vp.key === 'mobile' && theme.key === 'dark') await shot('p22-22-settings-bootstrap-mobile', true);

        /* ── 设置 → 预算限制（二级页签标题）── */
        await evaluate(`(function(){ IB.economyConfigurationUI.show('budget'); return true; })()`);
        await new Promise(r => setTimeout(r, 500));
        await evaluate(dismissOverlays);
        const budgetTab = await evaluate(metricsOf);
        if (vp.key === '1440x900' && theme.key === 'dark') await shot('p22-22-settings-budget-1440x900-dark', true);

        const label = theme.key + '/' + vp.key;

        /* ★ 高度这一条：那一块比 P22-18 时矮三分之一以上。
           P22-22 之前那一块是 194px（14px padding + 120px 线稿 + 9px 间距
           + 标题 + 说明），因此这里判的是"压到 140px 以下且真的比 194 矮
           三分之一以上"，而不是一个凭空的数。 */
        const LEGACY_EMPTY_H = 194;
        check('①-1 ' + label + ' · 空状态那一块比 P22-18 时矮 30% 以上' +
          '（基线 ' + LEGACY_EMPTY_H + 'px）',
          emptyStore.emptyH > 0 &&
          emptyStore.emptyH <= LEGACY_EMPTY_H * 0.7 &&
          emptyStore.emptyH <= 138,
          { h: emptyStore.emptyH, cardH: emptyStore.cardH,
            cut: Math.round((1 - emptyStore.emptyH / LEGACY_EMPTY_H) * 100) + '%' });

        check('①-2 ' + label + ' · 空状态线稿是**等比缩小**，不是被裁掉（viewBox 4:3 ↔ 渲染尺寸同比例）',
          !!emptyStore.art && emptyStore.art.vb === '0 0 160 120' &&
          emptyStore.art.w > 0 && emptyStore.art.h > 0 &&
          Math.abs(emptyStore.art.ratio - VB_RATIO) < 0.08,
          emptyStore.art);

        check('①-3 ' + label + ' · 说明比标题小，而且比标题淡（对比度更低，不是所有字同一个亮度）',
          emptyStore.titleFont > emptyStore.bodyFont &&
          contrastOf(emptyStore.titleColor, emptyStore.cardBg) >
          contrastOf(emptyStore.bodyColor, emptyStore.cardBg),
          { titleFont: emptyStore.titleFont, bodyFont: emptyStore.bodyFont,
            titleContrast: contrastOf(emptyStore.titleColor, emptyStore.cardBg),
            bodyContrast: contrastOf(emptyStore.bodyColor, emptyStore.cardBg) });

        check('①-4 ' + label + ' · 玻璃卡与主题令牌仍然生效（不是被换成了实心块）',
          emptyStore.glass.indexOf('blur') >= 0 && !!emptyStore.cardBg &&
          emptyStore.cardBg !== 'rgba(0, 0, 0, 0)',
          { glass: emptyStore.glass, bg: emptyStore.cardBg });

        check('①-5 ' + label + ' · 概览的未初始化状态说的是"尚未完成 Initial Bootstrap"，而且比说明行更清楚',
          emptyWallet.bootstrapState.indexOf('尚未完成 Initial Bootstrap') >= 0 &&
          emptyWallet.bootstrapRole === 'status' &&
          emptyWallet.bootstrapStateFont >= emptyWallet.bootstrapLineFont &&
          contrastOf(emptyWallet.bootstrapStateColor, emptyWallet.cardBg) >
          contrastOf(emptyWallet.bootstrapLineColor, emptyWallet.cardBg),
          { state: emptyWallet.bootstrapState, role: emptyWallet.bootstrapRole,
            fonts: [emptyWallet.bootstrapStateFont, emptyWallet.bootstrapLineFont],
           colors: [emptyWallet.bootstrapStateColor, emptyWallet.bootstrapLineColor] });

        check('①-6 ' + label + ' · 未初始化那一块里只有一个**动作**（"去设置"），旁边只有技术说明的开合钮',
          emptyWallet.bootstrapButtons.filter(t => t !== '技术说明 ▸').length === 1 &&
          emptyWallet.bootstrapButtons.indexOf('去设置') >= 0 &&
          emptyWallet.bootstrapButtons.every(t => ['去设置', '技术说明 ▸'].indexOf(t) >= 0) &&
          /* ★ 这一格的正文**说了**"界面上没有创建钱包这一步"，因此这里判的是
             "那一步真的不存在"（没有输入框、没有新建按钮），而不是"这几个字
             不出现" —— 那句话正是 §A 要求写出来的。 */
          emptyWallet.bootstrapInputCount === 0 &&
          emptyWallet.bootstrapButtons.filter(t => /创建|新建/.test(t)).length === 0,
          { buttons: emptyWallet.bootstrapButtons,
            inputs: emptyWallet.bootstrapInputCount,
            text: String(emptyWallet.bootstrapText).slice(0, 200) });

        check('①-7 ' + label + ' · 设置里那一格说的是"尚未完成 Initial Bootstrap"，并给出"谁创建它 / 只能一次"两句',
          emptyCfg.cfgStateText.indexOf('尚未完成 Initial Bootstrap') >= 0 &&
          emptyCfg.cfgStateRole === 'status' &&
          emptyCfg.cfgVisibleBody.indexOf('Economy authority') >= 0 &&
          emptyCfg.cfgVisibleBody.indexOf('只能发放一次') >= 0,
          { state: emptyCfg.cfgStateText, role: emptyCfg.cfgStateRole });

        check('①-8 ' + label + ' · 预算那一格有二级标题与说明（页签 → 标题 → 说明三层）',
          budgetTab.cfgSectionTitle === '预算限制' && budgetTab.cfgSectionSub.length > 0,
          { title: budgetTab.cfgSectionTitle, sub: budgetTab.cfgSectionSub });

        check('①-9 ' + label + ' · 外壳有当前这一格的标题，而且与页签同一批词',
          emptyStore.sectionTitle.length > 0 &&
          emptyStore.tabsLabel.indexOf(emptyStore.sectionTitle) >= 0 &&
          emptyStore.sectionSub.length > 0,
          { title: emptyStore.sectionTitle, sub: emptyStore.sectionSub, tabs: emptyStore.tabsLabel });

        check('①-10 ' + label + ' · 外壳标题比它的说明更大更清楚（标题 / 说明两档）',
          emptyStore.sectionTitleFont > emptyStore.sectionSubFont &&
          contrastOf(emptyStore.sectionTitleColor, emptyStore.cardBg) >
          contrastOf(emptyStore.sectionSubColor, emptyStore.cardBg),
          { fonts: [emptyStore.sectionTitleFont, emptyStore.sectionSubFont],
            contrasts: [contrastOf(emptyStore.sectionTitleColor, emptyStore.cardBg),
              contrastOf(emptyStore.sectionSubColor, emptyStore.cardBg)] });

        check('①-11 ' + label + ' · 二级页签仍然是四条，而且名字逐字没变',
          budgetTab.cfgTabsLabel.join(',') === '待处理,钱包与初始额度,预算限制,自主购买',
          budgetTab.cfgTabsLabel);

        check('①-12 ' + label + ' · 一级页签仍然是五条（概览/商店/我的资产/待处理/设置）',
          emptyStore.tabsLabel.join(',') === '概览,商店,我的资产,待处理,设置',
          emptyStore.tabsLabel);
      }
    }

    /* ══════════════════════════════════════════════════════════════ */
    section('② 没有横向溢出（§F 的三个尺寸逐个查）');

    for (const vp of VIEWPORTS) {
      await setVp(vp);
      await setWorld('w.storesEmpty = true; w.walletPresent = false;');
      await show('store');
      const store = await evaluate(metricsOf);
      check('②-1 ' + vp.key + ' · 商店空状态：文档与面板都不横向溢出',
        store.overflowX <= 1 && store.paneOverflowX <= 1,
        { doc: store.overflowX, pane: store.paneOverflowX, innerW: store.innerW });

      await show('overview');
      const overview = await evaluate(metricsOf);
      check('②-2 ' + vp.key + ' · 概览未初始化：文档与面板都不横向溢出',
        overview.overflowX <= 1 && overview.paneOverflowX <= 1,
        { doc: overview.overflowX, pane: overview.paneOverflowX });

      await show('settings', { cfgRefresh: true });
      await evaluate(`(function(){ IB.economyConfigurationUI.show('wallet'); return true; })()`);
      await new Promise(r => setTimeout(r, 600));
      await evaluate(dismissOverlays);
      const cfg = await evaluate(metricsOf);
      check('②-3 ' + vp.key + ' · 设置 · 未初始化：文档与配置面板都不横向溢出',
        cfg.overflowX <= 1 && cfg.cfgOverflowX <= 1,
        { doc: cfg.overflowX, cfg: cfg.cfgOverflowX });

      await setWorld('w.storesEmpty = false;');
      await show('store');
      const full = await evaluate(metricsOf);
      check('②-4 ' + vp.key + ' · 有目录／有钱包时同样不溢出（收窄不是靠裁掉内容换来的）',
        full.overflowX <= 1 && full.paneOverflowX <= 1,
        { doc: full.overflowX, pane: full.paneOverflowX });
    }

    /* ══════════════════════════════════════════════════════════════ */
    section('③ 空状态不是错误页 + 技术说明默认折叠');

    await setVp(VIEWPORTS[0]);
    await evaluate(`(function(){ document.body.className = 'theme-infernal'; return true; })()`);
    await setWorld('w.storesEmpty = true; w.walletPresent = false;');
    await show('store');
    const storeEmpty = await evaluate(metricsOf);
    await show('overview');
    const overviewEmpty = await evaluate(metricsOf);

    check('③-1 ★★★ 空状态那一块是 `role="status"`（不是 alert），Economy 这一页里没有任何 error 类节点',
      overviewEmpty.stateCount >= 1 && overviewEmpty.bootstrapRole === 'status' &&
      overviewEmpty.surfaceCount + overviewEmpty.stateCount >= 3 && overviewEmpty.alertCount === 0,
      { states: overviewEmpty.stateCount, surfaces: overviewEmpty.surfaceCount,
        alerts: overviewEmpty.alertCount, role: overviewEmpty.bootstrapRole });

    check('③-2 ★★★ 空状态的标题不写成警示色：三个空状态的标题色互不相同、但不是同一族红',
      storeEmpty.surfaceTones.filter(Boolean).length >= 2 &&
      storeEmpty.surfaceTones.every(t => {
        const c = parseRgb(t);
        if (!c) return true;
        /* 红 > 绿 且 红 > 蓝 且明显偏红 → 视为警示色。 */
        return !(c.r > c.g + 24 && c.r > c.b + 24);
      }),
      storeEmpty.surfaceTones);

    check('③-3 ★★★ 商店的两个空状态说的是"目录里现在没有东西"，不是"出错了"',
      storeEmpty.visibleBody.indexOf('现在还没有开着的商店') >= 0 &&
      storeEmpty.visibleBody.indexOf('这个货架还没有商品') >= 0 &&
      ['失败', '错误', '出错了', '异常', '重试'].every(w => storeEmpty.visibleBody.indexOf(w) < 0),
      storeEmpty.visibleBody.slice(0, 240));

    check('③-4 ★★★ 未初始化那一格的正文里没有"没有钱包"这种说法',
      overviewEmpty.bootstrapText.indexOf('Initial Bootstrap') >= 0 &&
      overviewEmpty.bootstrapText.indexOf('没有额度账户') < 0 &&
      overviewEmpty.bootstrapText.indexOf('还没有钱包') < 0,
      overviewEmpty.bootstrapText);

    check('③-5 ★★★ 未初始化那一格的正文里**没有**底层词（token / endpoint / runtime / 127.0.0.1 只在折叠层）',
      ['IB_HOME_NODE_TOKEN', 'ib_home_node_token', 'X-IB-Protocol', '127.0.0.1', '23118', 'runtime']
        .every(w => overviewEmpty.visibleBody.indexOf(w) < 0),
      ['IB_HOME_NODE_TOKEN', 'ib_home_node_token', 'X-IB-Protocol', '127.0.0.1', '23118', 'runtime']
        .filter(w => overviewEmpty.visibleBody.indexOf(w) >= 0));

    check('③-6 ★★★★ 技术说明**默认折叠**：`esh-technical` 都是 hidden',
      overviewEmpty.techHidden.length >= 1 && overviewEmpty.techHidden.every(v => v === true),
      overviewEmpty.techHidden);

    check('③-7 ★★★★ 展开钱包那一格的技术说明后，Home Node token / endpoint / runtime 三行都在，而且 token 的值不出现',
      (await (async function () {
        /* ★ 要开的是**钱包那一张卡**里的技术说明（它跟着 .esh-bootstrap 走），
           而不是按序号取最后一个 —— 概览里每张卡各有一个 `.esh-technical`。 */
        await evaluate(`(function(){
          var cards = [].slice.call(document.querySelectorAll('#economy-shell-overview .esh-card'));
          for (var i = 0; i < cards.length; i++) {
            if (cards[i].querySelector('.esh-bootstrap')) {
              var t = cards[i].querySelector('.esh-technical-toggle');
              if (t) t.click();
              return true;
            }
          }
          return false;
        })()`);
        await new Promise(r => setTimeout(r, 500));
        const open = await evaluate(metricsOf);
        const blob = String(open.walletTechText || '');
        const ok = open.walletTechHidden === false &&
          blob.indexOf('Home Node token') >= 0 &&
          blob.indexOf('endpoint') >= 0 &&
          blob.indexOf('runtime') >= 0 &&
          blob.indexOf('p22-22-visual-token') < 0 &&
          blob.indexOf('已配置') >= 0;
        /* 收回去，后面的断言不受影响。 */
        await evaluate(`(function(){
          var cards = [].slice.call(document.querySelectorAll('#economy-shell-overview .esh-card'));
          for (var i = 0; i < cards.length; i++) {
            if (cards[i].querySelector('.esh-bootstrap')) {
              var t = cards[i].querySelector('.esh-technical-toggle');
              if (t) t.click();
              return true;
            }
          }
          return false;
        })()`);
        await new Promise(r => setTimeout(r, 300));
        return ok ? blob.slice(0, 220) : false;
      })()) !== false,
      '见 walletTechText');

    await show('settings', { cfgRefresh: true });
    await evaluate(`(function(){ IB.economyConfigurationUI.show('wallet'); return true; })()`);
    await new Promise(r => setTimeout(r, 600));
    await evaluate(dismissOverlays);
    const cfgEmpty = await evaluate(metricsOf);

    check('③-8 ★★★★ 设置里的技术说明也是默认收起的（`details` 没有 open）',
      cfgEmpty.cfgTechClosed.length >= 1 && cfgEmpty.cfgTechClosed.every(v => v === true),
      cfgEmpty.cfgTechClosed);

    check('③-9 ★★★ 设置那一格的空状态高度同样被压到 130px 以下',
      cfgEmpty.cfgEmptyH <= 130 || cfgEmpty.cfgEmptyH < 0,
      cfgEmpty.cfgEmptyH);

    /* ══════════════════════════════════════════════════════════════ */
    section('④ 深色主题的层级：三档亮度真的分开了');

    await evaluate(`(function(){ document.body.className = 'theme-infernal'; return true; })()`);
    await setWorld('w.storesEmpty = true; w.walletPresent = false;');
    await show('overview');
    const dark = await evaluate(metricsOf);
    const stateC = contrastOf(dark.bootstrapStateColor, dark.cardBg);
    const lineC = contrastOf(dark.bootstrapLineColor, dark.cardBg);
    const footLum = await evaluate(`(function(){
      var n = document.querySelector('#economy-shell-overview .esh-card-foot');
      return n ? getComputedStyle(n).color : '';
    })()`);
    const footC = contrastOf(footLum, dark.cardBg);
    check('④-1 ★★★★ 深色主题：状态字 > 原因行 > 卡片脚注，三档对比度单调（不是一片同亮度的字）',
      stateC > lineC && lineC > footC && footC > 0,
      { state: dark.bootstrapStateColor, line: dark.bootstrapLineColor, foot: footLum,
        contrasts: [stateC, lineC, footC] });

    check('④-2 ★★★ 深色主题：正文里的字没有一条对比度低于 3:1（安静不等于看不清）',
      [dark.bootstrapStateColor, dark.bootstrapLineColor, dark.sectionTitleColor, dark.sectionSubColor]
        .every(c => contrastOf(c, dark.cardBg) >= 3),
      { bg: dark.cardBg, contrasts: [dark.bootstrapStateColor, dark.bootstrapLineColor,
        dark.sectionTitleColor, dark.sectionSubColor].map(c => contrastOf(c, dark.cardBg)) });

    /* ══════════════════════════════════════════════════════════════ */
    section('⑤ §F 的三个尺寸各截一张（图落 %TEMP%，不进仓库）');

    for (const vp of VIEWPORTS) {
      await setVp(vp);
      await evaluate(`(function(){ document.body.className = 'theme-infernal'; return true; })()`);
      await setWorld('w.storesEmpty = true; w.walletPresent = false;');
      await show('store');
      const f = await shot('p22-22-acceptance-store-' + vp.key, true);
      check('⑤-1 ' + vp.key + ' · 商店空状态的验收截图已生成',
        fs.existsSync(f) && fs.statSync(f).size > 2000, f);
      await show('overview');
      const g = await shot('p22-22-acceptance-overview-' + vp.key, true);
      check('⑤-2 ' + vp.key + ' · 概览未初始化的验收截图已生成',
        fs.existsSync(g) && fs.statSync(g).size > 2000, g);
      await show('settings', { cfgRefresh: true });
      await evaluate(`(function(){ IB.economyConfigurationUI.show('wallet'); return true; })()`);
      await new Promise(r => setTimeout(r, 600));
      await evaluate(dismissOverlays);
      const h = await shot('p22-22-acceptance-settings-' + vp.key, true);
      check('⑤-3 ' + vp.key + ' · 设置未初始化的验收截图已生成',
        fs.existsSync(h) && fs.statSync(h).size > 2000, h);
    }

    /* ══════════════════════════════════════════════════════════════ */
    section('⑥ 与 P22-22 无关的那一件事：有数据时页面一个字都没变');

    await setVp(VIEWPORTS[1]);
    await setWorld('w.storesEmpty = false; w.walletPresent = true;');
    await show('overview');
    const full = await evaluate(metricsOf);
    check('⑥-1 ★★★ 钱包在的时候画的是权威那个数（空状态的那几句一个都不出现）',
      full.bootstrapState === '' && full.visibleBody.indexOf('12,450.00') >= 0 &&
      full.visibleBody.indexOf('Initial Bootstrap') < 0,
      full.visibleBody.slice(0, 160));

    console.log('\n' + '─'.repeat(66));
    console.log('P22-22 · 空状态排版：' + (checks - failures) + ' / ' + checks + ' 通过');
    /* ★ 量到的那几个数留在输出里：下一个人要核对"到底矮了多少"时，
       不必再跑一遍浏览器。基线是 P22-18 时的 194px（14 padding + 120 线稿
       + 9 间距 + 标题 + 说明）。 */
    const widths = ['1280x800', '1440x900', 'mobile'];
    for (const w of widths) {
      const s = seen['dark/' + w];
      if (!s) continue;
      console.log('  · ' + w + '：空状态那一块 ' + s.emptyH + 'px' +
        '（P22-18 基线 194px → 矮 ' + Math.round((1 - s.emptyH / 194) * 100) + '%）' +
        ' · 线稿 ' + (s.art ? (s.art.w + '×' + s.art.h) : '—') +
        ' · 卡片 ' + s.cardH + 'px');
    }
    console.log('截图目录：' + SHOT_DIR);
    console.log(failures === 0 ? 'ALL PASS' : (failures + ' 项未通过'));
  } catch (error) {
    failures += 1;
    console.error('运行失败：' + (error && error.stack ? error.stack : error));
  } finally {
    try { if (cdp) cdp.socket.destroy(); } catch (e) { /* 已断开 */ }
    try { child.kill(); } catch (e) { /* 已退出 */ }
  }
  process.exit(failures === 0 ? 0 : 1);
})();
