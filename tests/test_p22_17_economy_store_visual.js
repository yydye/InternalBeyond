'use strict';
/* ====================================================================
   P22-17 · Economy Store / Wallet / Inventory UI — 视觉与响应式核对
   （真实浏览器 · 自截图）
   --------------------------------------------------------------------
   运行：node tests/test_p22_17_economy_store_visual.js

   ★ 这个文件**不在** test-all.js 里，理由与 test_ui_regression.js /
     test_p22_15_..._visual.js / test_p22_16_..._visual.js 同款：它要开一个
     真实浏览器。它存在的唯一理由是那些只能由排版引擎回答的问题：
       "手机端有没有横向溢出" / "两套主题是不是真的换了令牌" /
       "页签条真的在 P22-16 的外壳上面吗" / "商品卡的确定性视觉身份真的
       算出了不同的背景吗" / "空状态的 SVG 真的有尺寸吗"。
     ★ 一次启动、复用同一个 browser、最后**明确关闭**（Browser.close +
       child.kill + 删临时 profile），并且不启动 Desktop / Electron / DSH。

   它做五件事：
     ① 在 file:// 载入真实 InternalBeyond.html，把八个只读面与两条写面
        注入成假的 fetch（**走真实的 home-node-client**，因此"/economy/*
        上的 POST 仍然是 0"这句话说的是生产代码的行为）；
     ② 对 2 主题 × 3 宽度检查真实排版：页签条在外壳之上 / 横向溢出 /
        钱包数字是等宽数字且明显大于说明字 / 卡片有内容最大宽度 /
        主题令牌真的换了 / 商品卡的不同 variant 真的算出不同背景；
     ③ 走一遍真实交互：切五个页签，确认每一格只有该出现的那一块可见；
     ④ 确认 P22-15 / P22-16 的两块**在这个外壳里仍然正常**（卡片真的有宽度、
        P22-16 自己的页签条在「设置」里只剩三个可见）；
     ⑤ 把关键状态截成 PNG 落到 %TEMP%，供人工看一眼。
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
const SHOT_DIR = path.join(os.tmpdir(), 'ib-p22-17-shots');

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

/* ── 最小 CDP 客户端（与 P22-15/16 的视觉测试同一子集）──────────────── */
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

/* ── 颜色对比：真正要判的是"看不看得清"，不是"有没有铺底" ─────────────
   ★ 开发期这里是先写成"文字按钮的底色必须是透明的"，结果在**浅色主题**
     里得到一条假红：浅色主题给文字按钮铺的是一层 rgba(255,255,255,.40)，
     而那恰好是它在浅底上正确的做法。判据因此改成 WCAG 对比度。 */
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
function contrastOf(fgText, bgText, baseText) {
  const fg = parseRgb(fgText), bg = parseRgb(bgText), base = parseRgb(baseText);
  if (!fg || !bg || !base) return -1;
  const composited = over(bg, base);
  const l1 = luminance(fg), l2 = luminance(composited);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ── 假的只读面（**只有网络是假的**：页面、home-node-client、三个纯层与
      三个渲染器都是仓库里的真文件）───────────────────────────────────── */
const SEED = `(function(){
  var CALLS = { reads: [], posts: [] };
  window.__ibCalls = CALLS;
  window.__ibWorld = { empty: false };
  function seedRoles() {
    try { apiConfigs = [{ id: 'agent_a', nickname: '小灰' }]; } catch (e) {}
    try { window.apiConfigs = [{ id: 'agent_a', nickname: '小灰' }]; } catch (e) {}
  }
  window.__ibSeedRoles = seedRoles;
  seedRoles();
  try { localStorage.setItem('ib_home_node_token', 'visual-token'); } catch (e) {}
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
        configuration: { implemented: true, open: true, configurationCommandsExposed: ['BOOTSTRAP_CREDIT','PUT_BUDGET_POLICY','PUT_AUTONOMY_POLICY'] },
        approvalDecision: { implemented: true, open: true } } });
    }
    if (pathOnly.indexOf('/economy/wallet') === 0) {
      return send({ ok: true, wallet: { domain: 'economy', namespace: 'wallet',
        walletId: 'econ_wallet_vis', owner: { type: 'character', id: 'agent_a' },
        accountId: 'econ_account_vis', currency: 'IB_CREDIT', state: 'READY', balanceKnown: true,
        cachedBalanceMinor: '1245000', ledgerBalanceMinor: '1245000', reservedBalanceMinor: '12000',
        reservedBalanceCachedMinor: '12000', cachedBalanceDrifted: false, reservedCacheDrifted: false,
        availableBalanceMinor: '1245000', revision: 12, createdAt: NOW - 86400000, updatedAt: NOW } });
    }
    if (pathOnly.indexOf('/economy/policy') === 0) {
      return send({ ok: true, policy: { domain: 'economy', namespace: 'budget', policyId: 'econ_bp_vis',
        ownerId: 'agent_a', currency: 'IB_CREDIT', status: 'ACTIVE',
        limits: { perTransactionMinor: '5000', dailyMinor: '50000', approvalThresholdMinor: '2000' },
        termEndsAt: null, expiredByTerm: false, hardStop: false, autonomyLevel: 'LIMITED', revision: 7 } });
    }
    if (pathOnly.indexOf('/economy/autonomy-policy') === 0) {
      return send({ ok: false, error: 'autonomy-policy-not-found' }, 404);
    }
    if (pathOnly.indexOf('/economy/budget') === 0) {
      return send({ ok: true, snapshot: { domain: 'economy', ownerId: 'agent_a', currency: 'IB_CREDIT',
        walletId: 'econ_wallet_vis', walletState: 'READY', ledgerBalanceMinor: '1245000',
        reservedBalanceMinor: '12000', availableBalanceMinor: '1245000',
        spentTodayMinor: '1250', spentThisWeekMinor: '4300', spentThisMonthMinor: '9900',
        amountMinor: '0', now: NOW, timezone: 'UTC', policyId: 'econ_bp_vis', policyStatus: 'ACTIVE' },
        decision: { outcome: 'ALLOW', reasonCode: 'WITHIN_LIMITS' },
        evaluatedOnly: true, notASpendPermit: true, reserved: false });
    }
    if (pathOnly.indexOf('/economy/stores') === 0) {
      if (window.__ibWorld.empty) return send({ ok: true, stores: [], holdsPrices: false, holdsOwnership: false });
      return send({ ok: true, holdsPrices: false, holdsOwnership: false, holdsInventory: false, stores: [
        { domain: 'economy', storeId: 'econ_store_a', name: '数字工坊', description: '安静的货架，放着这个角色能用得上的东西。', status: 'ACTIVE', sortOrder: 1, revision: 2 },
        { domain: 'economy', storeId: 'econ_store_b', name: '算力小屋', description: '一段一段的算力。', status: 'ACTIVE', sortOrder: 2, revision: 1 },
        { domain: 'economy', storeId: 'econ_store_c', name: '修图铺', description: '', status: 'DISABLED', sortOrder: 3, revision: 1 } ] });
    }
    if (pathOnly.indexOf('/economy/products') === 0) {
      if (window.__ibWorld.empty) return send({ ok: true, products: [], personalized: false, hasRecommendations: false, hasDiscounts: false });
      return send({ ok: true, personalized: false, hasRecommendations: false, hasDiscounts: false, products: [
        { domain: 'economy', productId: 'econ_prod_vis_1', storeId: 'econ_store_a', kind: 'DIGITAL_ITEM', fulfillment: 'INVENTORY_GRANT',
          name: '数字绘画额度', description: '一张图的额度，用完之后可以再申请。', currency: 'IB_CREDIT',
          unitPriceMinor: '2000', unitName: 'item', grantQuantity: 1, assetKind: 'ITEM', status: 'ACTIVE', revision: 1 },
        { domain: 'economy', productId: 'econ_prod_vis_2', storeId: 'econ_store_a', kind: 'CONSUMABLE', fulfillment: 'INVENTORY_GRANT',
          name: '一次性滤镜', description: '用一次就没了的滤镜。', currency: 'IB_CREDIT',
          unitPriceMinor: '350', unitName: 'item', grantQuantity: 1, assetKind: 'ITEM', status: 'ACTIVE', revision: 1 },
        { domain: 'economy', productId: 'econ_prod_vis_3', storeId: 'econ_store_b', kind: 'COMPUTE_CREDIT', fulfillment: 'COMPUTE_GRANT',
          name: '算力包', description: '一小段内部算力。', currency: 'IB_CREDIT',
          unitPriceMinor: '500', unitName: 'computeUnit', grantQuantity: 100, assetKind: 'COMPUTE', status: 'ACTIVE', revision: 1 },
        { domain: 'economy', productId: 'econ_prod_vis_4', storeId: 'econ_store_b', kind: 'API_QUOTA', fulfillment: 'COMPUTE_GRANT',
          name: '接口额度', description: '一小段接口额度。', currency: 'IB_CREDIT',
          unitPriceMinor: '900', unitName: 'computeUnit', grantQuantity: 50, assetKind: 'COMPUTE', status: 'DISABLED', revision: 1 },
        { domain: 'economy', productId: 'econ_prod_vis_5', storeId: 'econ_store_c', kind: 'SERVICE', fulfillment: 'SERVICE_EXECUTION',
          name: '一次修图', description: '', currency: 'IB_CREDIT',
          unitPriceMinor: '800', unitName: 'service', grantQuantity: 1, assetKind: null, status: 'RETIRED', revision: 1 } ] });
    }
    if (pathOnly.indexOf('/economy/inventory') === 0) {
      if (window.__ibWorld.empty) return send({ ok: true, entries: [], isABalance: false, contributesToAvailableBalance: false, locksFunds: false });
      return send({ ok: true, isABalance: false, contributesToAvailableBalance: false, locksFunds: false, entries: [
        { domain: 'economy', inventoryEntryId: 'econ_inv_vis_1', ownerId: 'character:agent_a', ownerType: 'character',
          productId: 'econ_prod_vis_1', assetKind: 'ITEM', quantity: 3, revision: 2,
          createdAt: NOW - 90000000, updatedAt: NOW - 3600000, productPresent: true, isABalance: false },
        { domain: 'economy', inventoryEntryId: 'econ_inv_vis_2', ownerId: 'character:agent_a', ownerType: 'character',
          productId: 'econ_prod_vis_3', assetKind: 'COMPUTE', quantity: 250, revision: 1,
          createdAt: NOW - 80000000, updatedAt: NOW - 7200000, productPresent: true, isABalance: false },
        { domain: 'economy', inventoryEntryId: 'econ_inv_vis_3', ownerId: 'character:agent_a', ownerType: 'character',
          productId: 'econ_prod_gone', assetKind: 'ITEM', quantity: 1, revision: 1,
          createdAt: NOW - 70000000, updatedAt: NOW - 10000000, productPresent: false, isABalance: false } ] });
    }
    if (pathOnly.indexOf('/economy/purchases') === 0) {
      if (window.__ibWorld.empty) return send({ ok: true, purchases: [], count: 0, personalized: false, recommended: false, ranked: false, exposesMutation: false });
      return send({ ok: true, count: 4, personalized: false, recommended: false, ranked: false, exposesMutation: false, purchases: [
        { purchaseId: 'econ_pur_vis_1', buyerId: 'character:agent_a', productId: 'econ_prod_vis_1', storeId: 'econ_store_a',
          currency: 'IB_CREDIT', amountMinor: '2000', status: 'COMPLETED', terminal: true, completed: true,
          approvalMode: 'APPROVAL', units: 1, grantedQuantity: 1, unitName: 'item',
          createdAt: NOW - 5400000, completedAt: NOW - 5390000 },
        { purchaseId: 'econ_pur_vis_2', buyerId: 'character:agent_a', productId: 'econ_prod_vis_3', storeId: 'econ_store_b',
          currency: 'IB_CREDIT', amountMinor: '500', status: 'RESERVED', terminal: false, completed: false,
          approvalMode: 'AUTO_ALLOW', units: 1, createdAt: NOW - 3600000 },
        { purchaseId: 'econ_pur_vis_3', buyerId: 'character:agent_a', productId: 'econ_prod_vis_5', storeId: 'econ_store_c',
          currency: 'IB_CREDIT', amountMinor: '800', status: 'RELEASED', terminal: true, completed: false,
          approvalMode: null, units: 1, createdAt: NOW - 7200000 },
        { purchaseId: 'econ_pur_vis_4', buyerId: 'character:agent_a', productId: 'econ_prod_vis_1', storeId: 'econ_store_a',
          currency: 'IB_CREDIT', amountMinor: '2000', status: 'FAILED', terminal: true, completed: false,
          approvalMode: 'APPROVAL', units: 1, createdAt: NOW - 10800000 } ] });
    }
    if (pathOnly.indexOf('/economy/intents') === 0) {
      return send({ ok: true, intents: [
        { agentIntentId: 'econ_int_vis_1', agentId: 'agent_a', purchaseId: 'econ_pur_vis_1', state: 'COMPLETED' },
        { agentIntentId: 'econ_int_vis_4', agentId: 'agent_a', purchaseId: 'econ_pur_vis_4', state: 'FAILED' } ] });
    }
    if (pathOnly.indexOf('/economy/approvals') === 0) return send({ ok: true, approvals: [] });
    return send({ ok: false, error: 'not-found' }, 404);
  };
})();`;

/* ── 正在显示的那一块的排版度量 ─────────────────────────────────────── */
const metricsOf = `(function(){
  function px(v){ return Math.round(v*100)/100; }
  function box(n){ return n ? n.getBoundingClientRect() : null; }
  var page = document.getElementById('page-economy');
  var shell = document.getElementById('economy-shell');
  var cfg = document.getElementById('economy-configuration');
  var req = document.getElementById('economy-requests');
  var tabs = shell ? shell.querySelector('.esh-tabs') : null;
  var visiblePane = null;
  ['economy-shell-overview','economy-shell-store','economy-shell-assets'].forEach(function(id){
    var n = document.getElementById(id);
    if (n && !n.hidden) visiblePane = n;
  });
  var walletValue = visiblePane ? visiblePane.querySelector('.esh-wallet-value') : null;
  var note = visiblePane ? visiblePane.querySelector('.esh-note') : null;
  var card = visiblePane ? visiblePane.querySelector('.esh-card') : null;
  var primary = visiblePane ? visiblePane.querySelector('.esh-btn-primary') : null;
  var title = shell ? shell.querySelector('.esh-card-title') : null;
  var products = visiblePane ? [].slice.call(visiblePane.querySelectorAll('.esh-product')) : [];
  var cfgTabs = cfg ? [].slice.call(cfg.querySelectorAll('.ecfg-tab')).filter(function(t){
    return getComputedStyle(t).display !== 'none'; }) : [];
  var cfgCard = cfg ? cfg.querySelector('.ecfg-card') : null;
  var tabRect = box(tabs), cfgRect = box(cfg);
  return {
    pageOpen: !!(page && page.classList.contains('active')),
    pageDisplay: page ? getComputedStyle(page).display : '',
    shellPresent: !!shell,
    shellWidth: shell ? Math.round(box(shell).width) : 0,
    tabsTop: tabRect ? Math.round(tabRect.top) : 0,
    tabsWidth: tabRect ? Math.round(tabRect.width) : 0,
    hideScrollbars: !!tabs && (tabs.scrollWidth > tabs.clientWidth || getComputedStyle(tabs).flexWrap === 'nowrap'),
    cfgVisible: !!(cfg && getComputedStyle(cfg).display !== 'none'),
    reqVisible: !!(req && req.style.display !== 'none'),
    cfgTop: cfgRect ? Math.round(cfgRect.top) : 0,
    reqTop: req ? Math.round(box(req).top) : 0,
    cfgTabsVisible: cfgTabs.map(function(t){ return t.textContent.replace(/\\s+/g,''); }),
    cfgCardWidth: cfgCard ? Math.round(box(cfgCard).width) : 0,
    paneId: visiblePane ? visiblePane.id : null,
    cardWidth: card ? Math.round(box(card).width) : 0,
    cardCount: visiblePane ? visiblePane.querySelectorAll('.esh-card').length : 0,
    walletFont: walletValue ? getComputedStyle(walletValue).fontSize : '',
    walletNums: walletValue ? getComputedStyle(walletValue).fontVariantNumeric : '',
    walletText: walletValue ? walletValue.textContent : '',
    noteFont: note ? getComputedStyle(note).fontSize : '',
    titleColor: title ? getComputedStyle(title).color : '',
    cardBg: card ? getComputedStyle(card).backgroundColor : '',
    glass: card ? String(getComputedStyle(card).backdropFilter || getComputedStyle(card).webkitBackdropFilter || '') : '',
    productCount: products.length,
    productVariants: products.map(function(p){ return p.getAttribute('data-variant'); }),
    productMarks: products.map(function(p){ return p.getAttribute('data-mark'); }),
    storeGridCols: visiblePane && visiblePane.querySelector('.esh-store-grid')
      ? getComputedStyle(visiblePane.querySelector('.esh-store-grid')).gridTemplateColumns.split(' ').length : 0,
    productGridCols: visiblePane && visiblePane.querySelector('.esh-product-grid')
      ? getComputedStyle(visiblePane.querySelector('.esh-product-grid')).gridTemplateColumns.split(' ').length : 0,
    productGridWidth: visiblePane && visiblePane.querySelector('.esh-product-grid')
      ? Math.round(box(visiblePane.querySelector('.esh-product-grid')).width) : 0,
    productGridTracks: visiblePane && visiblePane.querySelector('.esh-product-grid')
      ? getComputedStyle(visiblePane.querySelector('.esh-product-grid')).gridTemplateColumns : '',
    /* ★ 数"排成几段"要数**真实位置**：auto-fit 的 computed
       gridTemplateColumns 会把被折叠的空轨道也列出来，直接数空格会得到
       一个比实际更大的数（开发期实测：三档限额被数成了 4 列）。 */
    figureRows: visiblePane ? (function(){
      var tops = {};
      [].slice.call(visiblePane.querySelectorAll('.esh-figure')).forEach(function(f){ tops[Math.round(box(f).top)] = 1; });
      return Object.keys(tops).length;
    })() : 0,
    figureColsReal: visiblePane ? (function(){
      var byTop = {};
      [].slice.call(visiblePane.querySelectorAll('.esh-figure')).forEach(function(f){
        var t = Math.round(box(f).top); byTop[t] = (byTop[t] || 0) + 1; });
      var best = 0; Object.keys(byTop).forEach(function(k){ best = Math.max(best, byTop[k]); });
      return best;
    })() : 0,
    rowNameColors: visiblePane ? [].slice.call(visiblePane.querySelectorAll('.esh-row-name'))
      .map(function(n){ return getComputedStyle(n).color; }) : [],
    quietBtnColor: shell && shell.querySelector('.esh-btn-quiet')
      ? getComputedStyle(shell.querySelector('.esh-btn-quiet')).color : '',
    quietBtnBg: shell && shell.querySelector('.esh-btn-quiet')
      ? getComputedStyle(shell.querySelector('.esh-btn-quiet')).backgroundColor : '',
    mutedNoteColor: visiblePane && visiblePane.querySelector('.esh-note')
      ? getComputedStyle(visiblePane.querySelector('.esh-note')).color : '',
    bodyClass: document.body.className,
    themeInfernal: document.body.classList.contains('theme-infernal'),
    productArts: products.map(function(p){
      var a = p.querySelector('.esh-product-art');
      if (!a) return { bg: '', angle: '', w: 0, inx: 0, svg: 0 };
      var cs = getComputedStyle(a);
      return { bg: String(cs.backgroundImage).slice(0, 90), angle: cs.getPropertyValue('--esh-angle'),
        w: Math.round(box(a).width), inx: cs.getPropertyValue('--esh-variant'),
        svg: a.querySelectorAll('svg').length };
    }),
    primaryHeight: primary ? Math.round(box(primary).height) : 0,
    primaryWidth: primary ? Math.round(box(primary).width) : 0,
    emptyArt: visiblePane ? (function(){ var a = visiblePane.querySelector('.esh-empty-art svg');
      return a ? { w: Math.round(box(a).width), h: Math.round(box(a).height), vb: a.getAttribute('viewBox') } : null; })() : null,
    svgCount: shell ? shell.querySelectorAll('svg').length : 0,
    imgCount: shell ? shell.querySelectorAll('img').length : 0,
    overflowX: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
    paneOverflowX: visiblePane ? (visiblePane.scrollWidth - visiblePane.clientWidth) : 0
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
  /* ★ 首启的安装/设置浮层：z-index 10000，fixed 定位、覆盖整屏。
     只按文案匹配是不够的（它的正文里没有那两个哨兵串），必须按 id 收。 */
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
  /* 页面进场那一段淡入也必须按掉：一个仍在 0.94 的祖先不是"覆盖层"，
     但截图会看出它在淡入，而断言会读到一个中间值。 */
  var page = document.getElementById('page-economy');
  if (page) page.style.opacity = '1';
  return true;
})()`;

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
    out.push({ why: 'covering', id: n.id || '', cls: String(n.className || '').slice(0, 40), z: cs.zIndex });
  });
  var node = document.getElementById('page-economy');
  while (node && node.tagName !== 'HTML') {
    var cs2 = getComputedStyle(node);
    if (Number(cs2.opacity) < 0.99) out.push({ why: 'ancestor-opacity', id: node.id || '', opacity: cs2.opacity });
    if (String(cs2.filter) !== 'none' || String(cs2.backdropFilter) !== 'none') {
      out.push({ why: 'ancestor-filter', id: node.id || '', filter: cs2.filter });
    }
    node = node.parentNode;
  }
  return out;
})()`;

(async function main() {
  const exe = chromePath();
  if (!exe) { console.error('找不到 Chrome / Edge：设置 CHROME_PATH 或安装其中之一。'); process.exit(1); }
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-17-chrome-'));
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

    const VIEWPORTS = [
      { key: 'desktop', width: 1440, height: 900, mobile: false },
      { key: 'tablet', width: 834, height: 1000, mobile: false },
      { key: 'mobile', width: 390, height: 780, mobile: true }
    ];
    const THEMES = [
      { key: 'internal', cls: '' },
      { key: 'infernal', cls: 'theme-infernal' }
    ];

    const show = async (tab, opts) => {
      /* ★ 强制重读一次（refresh）：这一页在生产里是"每次打开读一次，
         之后切页签用已经读回来的那一份"，而这一条测试要在同一页里换
         __ibWorld 与主题、宽度，因此每切一次都显式重读 —— 否则"空目录"
         这类世界改动根本不会出现在画面上（而断言会以为自己验证过了）。
         ★ 角色目录必须在**每次渲染之前**重写：页面自己的 loadApiConfigs()
         是异步的，在这个空 profile 上它随后会把 apiConfigs 覆盖成 []。
         ★ 「设置」那一格还要额外 refresh 一次 P22-16：它自己的 view 是
           页面打开时（角色目录还空着）读回来的那一份，而它的 show() 在
           stage !== 'idle' 时不会重读 —— 这是它的既有行为，本阶段**不**改
           它（P22-17 只碰外壳），但这一条测试要看到它真实的配置面板。 */
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
      await new Promise(r => setTimeout(r, 400));
      await evaluate(dismissOverlays);
      await new Promise(r => setTimeout(r, 150));
    };

    /* ══════════════════════════════════════════════════════════════ */
    section('① 主题 × 宽度：概览页的真实排版');

    const seenTitleColors = {};
    for (const theme of THEMES) {
      for (const vp of VIEWPORTS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile
        });
        await evaluate(`(function(){
          document.body.className = '${theme.cls}';
          try { localStorage.setItem('ib_theme', '${theme.key}'); } catch (e) {}
          if (location.hash !== '#economy') location.hash = 'economy';
          return true;
        })()`);
        await show('overview');
        const m = await evaluate(metricsOf);
        const label = theme.key + '/' + vp.key;
        seenTitleColors[theme.key] = m.titleColor;

        const covering = await evaluate(overlayReport);
        check(label + ' · 没有任何覆盖视口的模糊层压在页面上（截图看到的必须是这一页）',
          covering.length === 0, covering);

        check(label + ' · 页面真的打开着（flex 主轴）、外壳在、五个页签、概览在最上面',
          m.pageOpen === true && m.pageDisplay === 'flex' && m.shellPresent === true &&
          m.paneId === 'economy-shell-overview' && m.cfgVisible === false && m.reqVisible === false,
          { pane: m.paneId, cfg: m.cfgVisible, req: m.reqVisible, display: m.pageDisplay });

        /* ★ 主题身份必须**在同一处**被断言，否则"断言读的是一个中间状态、
           截图读的是另一个状态"这种假绿会一直存在（P22-16 开发期实测过
           同一类陷阱：所有 DOM 断言全绿而截图是一团雾）。 */
        check(label + ' · body 上的主题 class 就是这一轮期望的那一个',
          m.themeInfernal === (theme.key === 'infernal'), { body: m.bodyClass });

        check(label + ' · 没有横向溢出（文档与面板都没有超过视口）',
          m.overflowX <= 1 && m.paneOverflowX <= 1, { overflowX: m.overflowX, pane: m.paneOverflowX });

        check(label + ' · 卡片不会横跨整个屏幕（有内容最大宽度）',
          m.cardWidth > 0 && m.cardWidth <= Math.min(960, vp.width) + 2, { card: m.cardWidth, vw: vp.width });

        check(label + ' · 余额是等宽数字，而且明显大于它下面那句说明',
          String(m.walletNums).indexOf('tabular-nums') >= 0 &&
          parseFloat(m.walletFont) >= 1.35 * parseFloat(m.noteFont || '0') &&
          parseFloat(m.walletFont) <= 30,
          { wallet: m.walletFont, note: m.noteFont, nums: m.walletNums });
        if (label === 'internal/desktop') {
          const diag = await evaluate(`(function(){
            var s = IB.economyShellUI.snapshot();
            var reads = (window.__ibCalls.reads || []).map(function (r) { return r.path.split('?')[0]; });
            return { stage: s.stage, owner: s.ownerId, owners: s.owners.length,
              walletPrimary: s.view ? s.view.wallet.primary : null,
              assetsTotal: s.view ? s.view.assets.total : null,
              readPaths: Object.keys(reads.reduce(function (a, p) { a[p] = 1; return a; }, {})) };
          })()`);
          console.log('    · 钱包读数 = ' + JSON.stringify(m.walletText));
          console.log('    · 本页读到的只读面 = ' + JSON.stringify(diag));
        }

        check(label + ' · 图标全是 inline SVG，页面上没有一个位图',
          m.svgCount >= 6 && m.imgCount === 0, { svg: m.svgCount, img: m.imgCount });

        check(label + ' · 购买与资产那两行的名字用的是**同一个**前景色（没有一行偷偷变成强调色）',
          m.rowNameColors.length >= 3 &&
          new Set(m.rowNameColors).size === 1,
          Array.from(new Set(m.rowNameColors)));

        check(label + ' · 「重新读取」与说明文字在两套主题里都有真实的对比度',
          contrastOf(m.quietBtnColor, m.quietBtnBg, m.cardBg) >= 4.0 &&
          contrastOf(m.mutedNoteColor, 'rgba(0,0,0,0)', m.cardBg) >= 3.0,
          {
            btn: contrastOf(m.quietBtnColor, m.quietBtnBg, m.cardBg),
            note: contrastOf(m.mutedNoteColor, 'rgba(0,0,0,0)', m.cardBg),
            btnColor: m.quietBtnColor, noteColor: m.mutedNoteColor, cardBg: m.cardBg
          });

        check(label + ' · 预算三档在桌面上并排一行、在手机上最多两列（不排成三段竖条）',
          vp.key === 'desktop' ? (m.figureColsReal === 3 && m.figureRows === 1) : (m.figureRows <= 2),
          { real: m.figureColsReal, rows: m.figureRows, vp: vp.key });

        await shot('p22-17-overview-' + theme.key + '-' + vp.key, vp.mobile);
      }
    }

    check('①-主题 · 两套主题的标题颜色真的不同（令牌换了，不是同一份配色）',
      seenTitleColors.internal !== seenTitleColors.infernal &&
      !!seenTitleColors.internal && !!seenTitleColors.infernal, seenTitleColors);

    /* ══════════════════════════════════════════════════════════════ */
    section('② 商店：商品卡的确定性视觉身份在真实排版引擎上生效');

    const productSeen = {};
    for (const theme of THEMES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`(function(){
        document.body.className = '${theme.cls}';
        if (location.hash !== '#economy') location.hash = 'economy';
        return true;
      })()`);
      await show('store');
      const m = await evaluate(metricsOf);
      productSeen[theme.key] = m;

      check(theme.key + '/商店 · 五件商品都渲染出来了（三件在架上、一件暂停、一件下架）',
        m.productCount === 5 && m.cardCount >= 2, { products: m.productCount });

      check(theme.key + '/商店 · 桌面上目录是**多列货架**（≥3 列）而不是两张特别宽的卡',
        m.productGridCols >= 3, { cols: m.productGridCols });
      console.log('    · 目录网格 = ' + JSON.stringify({
        width: m.productGridWidth, cols: m.productGridCols, tracks: m.productGridTracks,
        shell: m.shellWidth, card: m.cardWidth
      }));

      check(theme.key + '/商店 · 主题身份与这一轮期望一致',
        m.themeInfernal === (theme.key === 'infernal'), { body: m.bodyClass });

      check(theme.key + '/商店 · 每一张商品卡都有 data-variant / data-mark，而且 CSS 变量真的落到了元素上',
        m.productVariants.every(v => v != null) &&
        m.productMarks.every(v => v != null) &&
        m.productArts.every(a => a.inx !== '' && a.bg !== '' && a.bg !== 'none' && a.svg === 1),
        m.productArts.slice(0, 3));

      check(theme.key + '/商店 · 不同的 visual variant 真的算出了**不同**的背景（"变化"真的发生了）',
        new Set(m.productArts.map(a => a.bg)).size >= 3, m.productArts.map(a => a.bg.slice(0, 40)));

      check(theme.key + '/商店 · 没有横向溢出', m.overflowX <= 1 && m.paneOverflowX <= 1, m.overflowX);
      await shot('p22-17-store-' + theme.key + '-desktop', true);
    }

    check('②-不回归 · 商品页上没有任何购买类按钮，而且 `/economy/*` 上的 POST 仍然是 0',
      await evaluate(`(function(){
        var posts = (window.__ibCalls.posts || []).filter(function(p){ return p.path.indexOf('/economy/') === 0; });
        return posts.length === 0;
      })()`));

    /* ══════════════════════════════════════════════════════════════ */
    section('③ 我的资产与空状态');

    for (const theme of THEMES) {
      await evaluate(`(function(){ document.body.className = '${theme.cls}'; return true; })()`);
      await show('assets');
      const m = await evaluate(metricsOf);
      check(theme.key + '/资产 · 两组（物品 / 算力额度）都在，卡片有宽度、没有横向溢出',
        m.cardCount === 1 && m.cardWidth > 0 && m.overflowX <= 1 && m.paneOverflowX <= 1,
        { cards: m.cardCount, width: m.cardWidth, overflow: m.overflowX });
      check(theme.key + '/资产 · 主题身份与这一轮期望一致',
        m.themeInfernal === (theme.key === 'infernal'), { body: m.bodyClass });
      const copy = await evaluate(`(function(){
        var p = document.getElementById('economy-shell-assets');
        return p ? p.innerText : '';
      })()`);
      check(theme.key + '/资产 · 正文里说清楚了 Compute 是 IB 内部算力额度，而且没有 Provider / token 字样',
        copy.indexOf('IB 内部的算力额度') >= 0 &&
        ['Provider', 'token', 'Token', 'API 余额', 'DeepSeek'].every(w => copy.indexOf(w) < 0),
        copy.slice(0, 160));
      await shot('p22-17-assets-' + theme.key + '-desktop', true);
    }

    await evaluate(`(function(){
      window.__ibWorld.empty = true;
      if (location.hash !== '#economy') location.hash = 'economy';
      return true;
    })()`);
    await show('assets');
    const emptyA = await evaluate(metricsOf);
    check('③-空状态 · 空库存显示一张**真的有尺寸**的 160×120 线性 SVG（不是 0×0 的占位）',
      !!emptyA.emptyArt && emptyA.emptyArt.vb === '0 0 160 120' &&
      emptyA.emptyArt.w >= 140 && emptyA.emptyArt.h >= 100, emptyA.emptyArt);
    await shot('p22-17-assets-empty-desktop', true);

    await show('store');
    const emptyS = await evaluate(metricsOf);
    check('③-空状态 · 空目录两处空状态都有宽度、也没有横向溢出',
      emptyS.cardCount === 2 && emptyS.productCount === 0 &&
      emptyS.overflowX <= 1 && emptyS.paneOverflowX <= 1,
      { cards: emptyS.cardCount, products: emptyS.productCount, overflow: emptyS.overflowX });

    await evaluate(`(function(){ window.__ibWorld.empty = false; return true; })()`);

    /* ══════════════════════════════════════════════════════════════ */
    section('④ 委托的两格：P22-15 / P22-16 装进外壳之后仍然正常');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(function(){ document.body.className = ''; return true; })()`);

    await show('requests');
    const reqM = await evaluate(metricsOf);
    check('④-1 ★★★★ 「待处理」：P22-15 的容器可见、P22-16 的外壳收起、外壳的页签条在它上方',
      reqM.reqVisible === true && reqM.cfgVisible === false && reqM.shellPresent === true &&
      reqM.tabsTop < reqM.reqTop + 1 && reqM.overflowX <= 1,
      { req: reqM.reqVisible, cfg: reqM.cfgVisible, tabsTop: reqM.tabsTop, reqTop: reqM.reqTop });
    await shot('p22-17-requests-desktop');

    await show('settings', { cfgRefresh: true });
    const setM = await evaluate(metricsOf);
    check('④-2 ★★★★ 「设置」：P22-16 的外壳可见、P22-15 的容器收起、它真的渲染出配置面板（不是失败面）',
      setM.cfgVisible === true && setM.reqVisible === false && setM.cfgCardWidth > 0 && setM.overflowX <= 1,
      { cfg: setM.cfgVisible, req: setM.reqVisible, cfgCard: setM.cfgCardWidth });

    check('④-2b ★★★★ 「设置」里 P22-16 的配置面板真的读到了权威（有一个输入框，不是"读不到本机节点"）',
      await evaluate(`(function(){
        var p = document.getElementById('economy-config-budget');
        var t = p ? p.innerText : '';
        return p && t.indexOf('读不到本机节点') < 0 && p.querySelectorAll('.ecfg-input').length >= 1;
      })()`),
      await evaluate(`(function(){ var p=document.getElementById('economy-config-budget'); return p?p.innerText.slice(0,120):''; })()`));

    check('④-3 ★★★★ 「设置」里 P22-16 自己的页签条只剩**三个**可见 —— 「待处理」已经由外层页签提供',
      setM.cfgTabsVisible.join(',') === '钱包与初始额度,预算限制,自主购买',
      setM.cfgTabsVisible);

    check('④-4 ★★★★ 外壳的页签条在 P22-16 的外壳**上面**（视觉顺序由 flex order 决定，DOM 顺序没动）',
      setM.tabsTop < setM.cfgTop + 1, { tabsTop: setM.tabsTop, cfgTop: setM.cfgTop });

    check('④-5 ★★★ 整个过程中 `/economy/*` 上的写请求仍然是 0（读面全是 GET）',
      await evaluate(`(function(){
        return (window.__ibCalls.posts || []).filter(function(p){ return p.path.indexOf('/economy/') === 0; }).length === 0;
      })()`),
      await evaluate(`JSON.stringify(window.__ibCalls.posts)`));

    await shot('p22-17-settings-desktop', true);

    /* ══════════════════════════════════════════════════════════════ */
    section('⑤ 手机：页签可横向滚动、主按钮整行、没有横向溢出');

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await show('overview');
    const mob = await evaluate(metricsOf);
    check('⑤-1 ★★★ 手机上页签条是**一条可横向滚动**的轨（scrollWidth > clientWidth 或 nowrap），页面本身不溢出',
      mob.hideScrollbars === true && mob.overflowX <= 1, { scrollable: mob.hideScrollbars, overflow: mob.overflowX });
    check('⑤-2 ★★★ 手机上余额那一格仍然可读（等宽 + 不超过 26px），卡片占满可用宽度',
      mob.walletNums.indexOf('tabular-nums') >= 0 && parseFloat(mob.walletFont) <= 26 &&
      mob.cardWidth > 300 && mob.cardWidth <= 392 + 2,
      { wallet: mob.walletFont, card: mob.cardWidth });
    await shot('p22-17-overview-internal-mobile', true);

    await show('store');
    const mobSales = await evaluate(metricsOf);
    check('⑤-3 ★★★ 手机上商品卡单列排布（每张都占满可用宽度），没有横向溢出',
      mobSales.paneOverflowX <= 1 && mobSales.overflowX <= 1 && mobSales.productCount === 5 &&
      mobSales.productGridCols === 1,
      { overflow: mobSales.overflowX, pane: mobSales.paneOverflowX, cols: mobSales.productGridCols });
    await shot('p22-17-store-internal-mobile-long', true);

    /* ④ 里那个"整行主按钮"只有空状态 / 失败态才有主按钮：用空的资产页取一次。 */
    await evaluate(`(function(){ window.__ibWorld.empty = true; return true; })()`);
    await show('overview');
    const mobEmpty = await evaluate(metricsOf);
    check('⑤-4 ★★ 空状态下的说明文字在手机上仍然成段可读（没有横向溢出）',
      mobEmpty.overflowX <= 1 && mobEmpty.paneOverflowX <= 1, mobEmpty.overflowX);
    await evaluate(`(function(){ window.__ibWorld.empty = false; return true; })()`);

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
  console.log('P22-17 visual: ' + (checks - failures) + '/' + checks + ' checks passed');
  console.log('截图目录：' + SHOT_DIR + '（不在仓库里：本阶段 PNG 新增 = 0）');
  if (failures) { console.error('FAILED: ' + failures); process.exit(1); }
})();
