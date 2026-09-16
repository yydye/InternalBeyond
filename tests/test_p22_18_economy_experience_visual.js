'use strict';
/* ====================================================================
   P22-18 · Economy Experience — 视觉（真实浏览器）
   --------------------------------------------------------------------
   运行：node tests/test_p22_18_economy_experience_visual.js

   ★ 一个 Chrome（复用到底），两个主题 × 四个宽度。
   ★ 只有**网络**是假的（window.fetch 指向一份合成的 canonical 读面）；
     页面、home-node-client、四个纯层、四个渲染器都是仓库里的真文件。
   ★ 这一条测试要回答的问题（§8/§9）：
     · 时间线在真实排版引擎上真的画出了一条轨与每行的圆点（不是 0 高）；
     · 320px 上**没有**横向滚动，而且时间线不折成一坨、数字不换行；
     · 两套主题的身份真的不同，而且说明文字/时间/编号都有真实对比度；
     · 高级信息默认折叠时**真的**不占高度，展开后也不把页面撑宽；
     · §3 的"来源"与三步在窄屏上仍然读得出来；
     · 「待处理」「设置」两格仍然由 P22-15 / P22-16 提供，外壳只开合；
     · 整个过程中 /economy/* 上的写请求 = 0。
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
const SHOT_DIR = path.join(os.tmpdir(), 'ib-p22-18-shots');

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

/* ── 最小 CDP 客户端（与 P22-15/16/17 的视觉测试同一子集）────────────── */
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

/* ── WCAG 对比度：判"看不看得清"，不判"有没有铺底" ─────────────────── */
function parseRgb(value) {
  const m = String(value).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(',').map(x => parseFloat(x));
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}
function over(fg, bg) {
  const a = fg.a == null ? 1 : fg.a;
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

/* ── 合成世界：一份**完整的 canonical 读面**（只有网络是假的）──────── */
const SEED = `(function(){
  var CALLS = { reads: [], posts: [] };
  window.__ibCalls = CALLS;
  window.__ibWorld = { empty: false, truncated: false };
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
  var W = 'econ_wallet_vis';
  /* ★ change log 按 canonical 的语义给：从最早的往新的一页一页发。
     这里一次给完（短页 ⇒ 外壳只发一次请求）。 */
  function push(arr, row) { arr.push(row); return arr; }
  function changes(query) {
    if (window.__ibWorld.empty) return { ok: true, revision: 0, changes: [] };
    /* ★ 满页：每页恰好 500 条（canonical 自己的上限），revision 严格递增——
       于是外壳只有走到第 6 页才会发现自己被挡住了。canonical 的响应里
       **没有** truncated 字段，因此"被截断"这条路径只有这样才走得出来。 */
    if (window.__ibWorld.truncated) {
      var mm = /cursor=(\d+)/.exec(String(query || ""));
      var from = mm ? Number(mm[1]) : 0;
      var page = [];
      for (var i = 1; i <= 500; i += 1) {
        push(page, { revision: from + i, kind: "RESERVATION_CREATED", entityId: "econ_res_full_" + (from + i),
          walletId: W, at: NOW - 90000000 + (from + i) * 1000,
          payload: { domain: "economy", ownerId: "agent_a", amountMinor: "100", currency: "IB_CREDIT" } });
      }
      return { ok: true, revision: from + 500, changes: page };
    }
    var rows = [
      { revision: 10, kind: 'WALLET_OPENED', entityId: W, walletId: W, at: NOW - 90000000,
        payload: { domain: 'economy', ownerId: 'agent_a' } },
      { revision: 20, kind: 'ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED', entityId: W, walletId: W, at: NOW - 89000000,
        payload: { domain: 'economy', ownerId: 'agent_a', amountMinor: '2000000', currency: 'IB_CREDIT' } },
      { revision: 30, kind: 'AGENT_INTENT_PROPOSED', entityId: 'econ_int_vis_1', walletId: null, at: NOW - 5500000,
        payload: { domain: 'economy', agentId: 'agent_a', agentIntentId: 'econ_int_vis_1',
          productId: 'econ_prod_vis_1', units: 1, reason: '用于生成更多视觉素材，这一批分镜需要 1 份。' } },
      { revision: 40, kind: 'APPROVAL_REQUESTED', entityId: 'econ_apr_vis_1', walletId: null, at: NOW - 5480000,
        payload: { domain: 'economy', buyerId: 'agent_a', approvalId: 'econ_apr_vis_1',
          productId: 'econ_prod_vis_1', amountMinor: '2000', currency: 'IB_CREDIT', units: 1 } },
      { revision: 50, kind: 'APPROVAL_APPROVED', entityId: 'econ_apr_vis_1', walletId: null, at: NOW - 5450000,
        payload: { domain: 'economy', buyerId: 'agent_a', approvalId: 'econ_apr_vis_1',
          productId: 'econ_prod_vis_1', amountMinor: '2000', currency: 'IB_CREDIT' } },
      { revision: 60, kind: 'PURCHASE_RESERVED', entityId: 'econ_pur_vis_1', walletId: W, at: NOW - 5420000,
        payload: { domain: 'economy', buyerId: 'agent_a', purchaseId: 'econ_pur_vis_1',
          productId: 'econ_prod_vis_1', amountMinor: '2000', currency: 'IB_CREDIT' } },
      { revision: 70, kind: 'PURCHASE_COMPLETED', entityId: 'econ_pur_vis_1', walletId: W, at: NOW - 5390000,
        payload: { domain: 'economy', buyerId: 'agent_a', purchaseId: 'econ_pur_vis_1',
          productId: 'econ_prod_vis_1', amountMinor: '2000', currency: 'IB_CREDIT', units: 1 } },
      { revision: 80, kind: 'QUOTE_EXPIRED', entityId: 'econ_quote_vis_9', walletId: null, at: NOW - 4000000,
        payload: { domain: 'economy', buyerId: 'agent_a', quoteId: 'econ_quote_vis_9',
          productId: 'econ_prod_vis_5', amountMinor: '800', currency: 'IB_CREDIT' } },
      { revision: 90, kind: 'AGENT_INTENT_AWAITING_APPROVAL', entityId: 'econ_int_vis_9', walletId: null, at: NOW - 605000,
        payload: { domain: 'economy', agentId: 'agent_a', agentIntentId: 'econ_int_vis_9',
          productId: 'econ_prod_vis_3', units: 2, approvalId: 'econ_apr_vis_9' } },
      { revision: 100, kind: 'AGENT_INTENT_PROPOSED', entityId: 'econ_int_vis_9', walletId: null, at: NOW - 610000,
        payload: { domain: 'economy', agentId: 'agent_a', agentIntentId: 'econ_int_vis_9',
          productId: 'econ_prod_vis_3', units: 2, approvalId: 'econ_apr_vis_9',
          reason: '想把这一段内部的算力留一点给下一次长任务用；如果这一次不够，就等下一轮再说。' } },
      { revision: 101, kind: 'PURCHASE_COMPLETED', entityId: 'econ_pur_other', walletId: 'econ_wallet_other',
        at: NOW - 500000, payload: { domain: 'economy', buyerId: 'agent_zzz',
          purchaseId: 'econ_pur_other', amountMinor: '999900', currency: 'IB_CREDIT' } }
    ];
    return { ok: true, revision: 101, changes: rows };
  }
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
        configuration: { implemented: true, open: true },
        approvalDecision: { implemented: true, open: true } } });
    }
    if (pathOnly.indexOf('/economy/changes') === 0) return send(changes(pathOnly));
    if (pathOnly.indexOf('/economy/wallet') === 0) {
      return send({ ok: true, wallet: { domain: 'economy', namespace: 'wallet',
        walletId: W, owner: { type: 'character', id: 'agent_a' },
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
        walletId: W, walletState: 'READY', ledgerBalanceMinor: '1245000',
        reservedBalanceMinor: '12000', availableBalanceMinor: '1245000',
        spentTodayMinor: '1250', spentThisWeekMinor: '4300', spentThisMonthMinor: '9900',
        amountMinor: '0', now: NOW, timezone: 'UTC', policyId: 'econ_bp_vis', policyStatus: 'ACTIVE' },
        decision: { outcome: 'ALLOW', reasonCode: 'WITHIN_LIMITS' },
        evaluatedOnly: true, notASpendPermit: true, reserved: false });
    }
    if (pathOnly.indexOf('/economy/stores') === 0) {
      return send({ ok: true, holdsPrices: false, holdsOwnership: false, stores: [
        { domain: 'economy', storeId: 'econ_store_a', name: '数字工坊', description: '安静的货架。', status: 'ACTIVE', sortOrder: 1, revision: 2 } ] });
    }
    if (pathOnly.indexOf('/economy/products') === 0) {
      return send({ ok: true, personalized: false, hasRecommendations: false, hasDiscounts: false, products: [
        { domain: 'economy', productId: 'econ_prod_vis_1', storeId: 'econ_store_a', kind: 'DIGITAL_ITEM',
          fulfillment: 'INVENTORY_GRANT', name: '数字绘画额度', description: '一张图的额度。',
          currency: 'IB_CREDIT', unitPriceMinor: '2000', unitName: 'item', grantQuantity: 1,
          assetKind: 'ITEM', status: 'ACTIVE', revision: 1 },
        { domain: 'economy', productId: 'econ_prod_vis_3', storeId: 'econ_store_a', kind: 'COMPUTE_CREDIT',
          fulfillment: 'COMPUTE_GRANT', name: '算力包', description: '一小段内部算力。',
          currency: 'IB_CREDIT', unitPriceMinor: '500', unitName: 'computeUnit', grantQuantity: 100,
          assetKind: 'COMPUTE', status: 'ACTIVE', revision: 1 } ] });
    }
    if (pathOnly.indexOf('/economy/inventory') === 0) {
      if (window.__ibWorld.empty) return send({ ok: true, entries: [], isABalance: false, locksFunds: false });
      return send({ ok: true, isABalance: false, contributesToAvailableBalance: false, locksFunds: false, entries: [
        { domain: 'economy', inventoryEntryId: 'econ_inv_vis_1', ownerId: 'character:agent_a', ownerType: 'character',
          productId: 'econ_prod_vis_1', assetKind: 'ITEM', quantity: 3, revision: 2,
          createdAt: NOW - 90000000, updatedAt: NOW - 3600000, productPresent: true, isABalance: false },
        { domain: 'economy', inventoryEntryId: 'econ_inv_vis_2', ownerId: 'character:agent_a', ownerType: 'character',
          productId: 'econ_prod_vis_3', assetKind: 'COMPUTE', quantity: 250, revision: 1,
          createdAt: NOW - 80000000, updatedAt: NOW - 7200000, productPresent: true, isABalance: false } ] });
    }
    if (pathOnly.indexOf('/economy/purchases') === 0) {
      if (window.__ibWorld.empty) return send({ ok: true, purchases: [], count: 0, personalized: false, recommended: false, ranked: false, exposesMutation: false });
      return send({ ok: true, count: 3, personalized: false, recommended: false, ranked: false, exposesMutation: false, purchases: [
        { purchaseId: 'econ_pur_vis_1', buyerId: 'character:agent_a', recipientId: null, selfDirected: true,
          productId: 'econ_prod_vis_1', storeId: 'econ_store_a', quoteId: 'econ_quote_vis_1',
          currency: 'IB_CREDIT', amountMinor: '2000', quoteKind: 'PURCHASE', settlementType: 'INVENTORY_GRANT',
          assetKind: 'ITEM', grantedQuantity: 1, unitName: 'item', status: 'COMPLETED', terminal: true, completed: true,
          approvalMode: 'APPROVAL', approvalId: 'econ_apr_vis_1', units: 1,
          approval: { approvalId: 'econ_apr_vis_1', status: 'CONSUMED', decidedBy: 'user:user',
            decidedAt: NOW - 5450000, consumedByPurchaseId: 'econ_pur_vis_1' },
          createdAt: NOW - 5400000, completedAt: NOW - 5390000 },
        { purchaseId: 'econ_pur_vis_2', buyerId: 'character:agent_a', recipientId: null, selfDirected: true,
          productId: 'econ_prod_vis_3', storeId: 'econ_store_a', quoteId: 'econ_quote_vis_2',
          currency: 'IB_CREDIT', amountMinor: '500', quoteKind: 'PURCHASE', settlementType: 'COMPUTE_GRANT',
          assetKind: 'COMPUTE', grantedQuantity: 100, unitName: 'computeUnit', status: 'COMPLETED', terminal: true,
          completed: true, approvalMode: 'AUTO_ALLOW', approvalId: null, units: 1,
          createdAt: NOW - 3600000, completedAt: NOW - 3590000 },
        { purchaseId: 'econ_pur_vis_3', buyerId: 'character:agent_a', recipientId: null, selfDirected: true,
          productId: 'econ_prod_vis_5', storeId: 'econ_store_c', quoteId: 'econ_quote_vis_3',
          currency: 'IB_CREDIT', amountMinor: '800', quoteKind: 'PURCHASE', settlementType: 'SERVICE_EXECUTION',
          assetKind: null, grantedQuantity: 1, unitName: 'service', status: 'RELEASED', terminal: true,
          completed: false, approvalMode: null, approvalId: null, units: null,
          createdAt: NOW - 7200000, completedAt: null } ] });
    }
    if (pathOnly.indexOf('/economy/intents') === 0) {
      if (window.__ibWorld.empty) return send({ ok: true, intents: [], count: 0 });
      return send({ ok: true, count: 3, personalized: false, recommended: false, ranked: false, exposesMutation: false, intents: [
        { agentIntentId: 'econ_int_vis_1', agentId: 'agent_a', agentType: 'character', productId: 'econ_prod_vis_1',
          state: 'COMPLETED', terminal: true, units: 1, reason: '用于生成更多视觉素材，这一批分镜需要 1 份。',
          reasonIsAuthority: false, reasonIsTelemetry: true, quoteId: 'econ_quote_vis_1',
          approvalId: 'econ_apr_vis_1', purchaseId: 'econ_pur_vis_1',
          createdAt: NOW - 5500000, updatedAt: NOW - 5390000, expiresAt: NOW + 100000 },
        { agentIntentId: 'econ_int_vis_9', agentId: 'agent_a', agentType: 'character', productId: 'econ_prod_vis_3',
          state: 'WAITING_APPROVAL', terminal: false, units: 2,
          reason: '想把这一段内部的算力留一点给下一次长任务用；如果这一次不够，就等下一轮再说。',
          reasonIsAuthority: false, reasonIsTelemetry: true, quoteId: null,
          approvalId: 'econ_apr_vis_9', purchaseId: null,
          createdAt: NOW - 610000, updatedAt: NOW - 600000, expiresAt: NOW + 100000 },
        { agentIntentId: 'econ_int_vis_no_reason', agentId: 'agent_a', agentType: 'character',
          productId: 'econ_prod_vis_3', state: 'PROPOSED', terminal: false, units: 1, reason: null,
          reasonIsAuthority: false, reasonIsTelemetry: true, quoteId: null,
          approvalId: null, purchaseId: null, createdAt: NOW - 300000, updatedAt: NOW - 300000,
          expiresAt: NOW + 200000 } ] });
    }
    if (pathOnly.indexOf('/economy/approvals') === 0) return send({ ok: true, approvals: [], count: 0 });
    return send({ ok: false, error: 'not-found' }, 404);
  };
})();`;

/* ── 排版度量 ───────────────────────────────────────────────────────── */
const metricsOf = `(function(){
  function px(v){ return Math.round(v*100)/100; }
  function box(n){ return n ? n.getBoundingClientRect() : null; }
  var shell = document.getElementById('economy-shell');
  var overview = document.getElementById('economy-shell-overview');
  if (!shell || !overview) return { missing: true };
  var tl = overview.querySelector('.esh-timeline');
  var items = [].slice.call(overview.querySelectorAll('.esh-tl'));
  var marks = [].slice.call(overview.querySelectorAll('.esh-tl-mark'));
  var acts = [].slice.call(overview.querySelectorAll('.esh-activity'));
  var steps = [].slice.call(overview.querySelectorAll('.esh-step'));
  var chips = [].slice.call(overview.querySelectorAll('.esh-act-src'));
  var whys = [].slice.call(overview.querySelectorAll('.esh-why'));
  var whyDd = [].slice.call(overview.querySelectorAll('.esh-why-dd'));
  var spendV = overview.querySelector('.esh-spend-v');
  var auditBody = overview.querySelector('.esh-audit-body');
  var auditToggle = overview.querySelector('.esh-audit-toggle');
  var recent = overview.querySelector('.esh-recent');
  var title = shell.querySelector('.esh-card-title');
  var card = overview.querySelector('.esh-card');
  var note = overview.querySelector('.esh-note');
  /* 轨：圆点列上的 ::after 那根线。它存在、有宽度、而且不是 0 高。 */
  var railW = 0, railH = 0, railContent = 'none', railBg = '', railAlpha = 0;
  if (marks.length) {
    var after = getComputedStyle(marks[0], '::after');
    railW = parseFloat(after.width) || 0;
    railH = parseFloat(after.height) || 0;
    railContent = String(after.content || 'none');
    railBg = String(after.backgroundColor || '');
    railAlpha = (function(){ var m = /rgba?\(([^)]+)\)/.exec(railBg); if (!m) return 0;
      var q = m[1].split(',').map(parseFloat); return q.length > 3 ? q[3] : 1; })();
  }
  var markTops = marks.map(function(m){ return Math.round(box(m).top); });
  var stepRows = (function(){
    var byTop = {};
    steps.forEach(function(s){ var t = Math.round(box(s).top); byTop[t] = (byTop[t] || 0) + 1; });
    return Object.keys(byTop).length;
  })();
  return {
    missing: false,
    pageActive: document.getElementById('page-economy').classList.contains('active'),
    pageDisplay: getComputedStyle(document.getElementById('page-economy')).display,
    overviewHidden: overview.hidden,
    shellDisplay: getComputedStyle(shell).display,
    walletText: (overview.querySelector('.esh-wallet-value') || {}).textContent || '',
    walletNums: overview.querySelector('.esh-wallet-value')
      ? getComputedStyle(overview.querySelector('.esh-wallet-value')).fontVariantNumeric : '',
    recentText: recent ? recent.textContent : '',
    recentHasNone: recent ? recent.textContent.indexOf('暂无记录') >= 0 : false,
    timelineItems: items.length,
    timelineTones: items.map(function(n){ return n.getAttribute('data-tone'); }),
    timelineFontSizes: items.map(function(n){
      var f = n.querySelector('.esh-tl-face'); return f ? px(parseFloat(getComputedStyle(f).fontSize)) : 0; }),
    timelineHeights: items.map(function(n){ return Math.round(box(n).height); }),
    timelineWidths: items.map(function(n){ return Math.round(box(n).width); }),
    timelineRowCount: Object.keys(markTops.reduce(function(a,t){ a[t]=1; return a; }, {})).length,
    railWidth: px(railW), railHeight: Math.round(railH), railContent: railContent, railBg: railBg, railAlpha: railAlpha,
    timelineSvgCount: tl ? tl.querySelectorAll('svg').length : 0,
    activityCount: acts.length,
    activitySources: acts.map(function(a){
      return [].slice.call(a.querySelectorAll('.esh-act-src')).map(function(c){ return c.textContent; }); }),
    activityWho: acts.map(function(a){
      return [].slice.call(a.querySelectorAll('.esh-act-who')).map(function(c){ return c.textContent; }); }),
    activityStepKeys: acts.map(function(a){
      return [].slice.call(a.querySelectorAll('.esh-step')).map(function(s){ return s.getAttribute('data-step'); }); }),
    activityStepTexts: acts.map(function(a){
      return [].slice.call(a.querySelectorAll('.esh-step-sub')).map(function(s){ return s.textContent; }); }),
    stepRows: stepRows,
    chipFontSize: chips.length ? px(parseFloat(getComputedStyle(chips[0]).fontSize)) : 0,
    chipColor: chips.length ? getComputedStyle(chips[0]).color : '',
    chipBg: chips.length ? getComputedStyle(chips[0]).backgroundColor : '',
    whyCount: whys.length,
    whyTexts: whyDd.map(function(d){ return d.textContent; }),
    whyReasonVerbatim: whyDd.length ? whyDd[0].textContent : '',
    whyWidths: whyDd.map(function(d){ return Math.round(box(d).width); }),
    spendTotal: spendV ? spendV.textContent : '',
    spendTotalNums: spendV ? getComputedStyle(spendV).fontVariantNumeric : '',
    spendFont: spendV ? px(parseFloat(getComputedStyle(spendV).fontSize)) : 0,
    auditCollapsed: auditBody ? auditBody.getBoundingClientRect().height : -1,
    auditHidden: auditBody ? auditBody.hidden : null,
    auditToggleText: auditToggle ? auditToggle.textContent : '',
    titleColor: title ? getComputedStyle(title).color : '',
    cardBg: card ? getComputedStyle(card).backgroundColor : '',
    noteColor: note ? getComputedStyle(note).color : '',
    tlFaceColor: items.length && items[0].querySelector('.esh-tl-face')
      ? getComputedStyle(items[0].querySelector('.esh-tl-face')).color : '',
    tlTimeColor: items.length && items[0].querySelector('.esh-tl-time')
      ? getComputedStyle(items[0].querySelector('.esh-tl-time')).color : '',
    bodyClass: document.body.className,
    themeInfernal: document.body.classList.contains('theme-infernal'),
    svgCount: shell.querySelectorAll('svg').length,
    imgCount: shell.querySelectorAll('img').length,
    overflowX: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
    paneOverflowX: overview.scrollWidth - overview.clientWidth,
    auditOpenOverflowX: 0
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
  if (page) page.style.opacity = '1';
  return true;
})()`;

(async function main() {
  const exe = chromePath();
  if (!exe) { console.error('找不到 Chrome / Edge：设置 CHROME_PATH 或安装其中之一。'); process.exit(1); }
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-18-chrome-'));
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

    const applyWorld = async (opts) => {
      await evaluate(`(function(){
        /* ★ 走一遍**真实用户的动作**：点进 Economy 那一页（生产里就是
           core.js 的 navTo，同样是它换掉 .page 的 active）。少了这一步，
           getBoundingClientRect 全是 0，而 DOM 断言仍然会"全绿" —— 那正是
           P22-16 开发期踩过的同一类陷阱（断言读的是一个不可见的状态）。
           ★ 这一步要等它自己的进场过渡（~2.4s）走完，因此下面多等了一段。 */
        try { if (typeof navTo === 'function') navTo('economy'); } catch (e) {}
        window.__ibSeedRoles();
        if (window.IB && IB.economyShellUI) {
          IB.economyShellUI.render();
          IB.economyShellUI.show('overview');
          IB.economyShellUI.refresh();
        }
        if (${opts && opts.cfgRefresh ? 'true' : 'false'} && window.IB && IB.economyConfigurationUI) {
          IB.economyConfigurationUI.refresh();
        }
        return true;
      })()`);
      await new Promise(r => setTimeout(r, 900));
      await evaluate(dismissOverlays);
      await new Promise(r => setTimeout(r, 400));
      await evaluate(dismissOverlays);
      await new Promise(r => setTimeout(r, 150));
    };
    const metrics = () => evaluate(metricsOf);

    /* ══════════════════════════════════════════════════════════════ */
    section('① 主题 × 宽度：概览上四个区域的真实排版');

    const VIEWPORTS = [
      { key: 'desktop', width: 1440, height: 900, mobile: false },
      { key: 'tablet', width: 834, height: 1000, mobile: false },
      { key: 'narrow320', width: 320, height: 720, mobile: true },
      { key: 'mobile', width: 390, height: 780, mobile: true }
    ];
    const THEMES = [
      { key: 'internal', cls: '' },
      { key: 'infernal', cls: 'theme-infernal' }
    ];
    const titleColors = {};
    const seen = {};

    for (const theme of THEMES) {
      for (const vp of VIEWPORTS) {
        const label = theme.key + '/' + vp.key;
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile
        });
        await evaluate(`(function(){
          document.body.className = document.body.className.replace(/\\s*theme-infernal/g,'')${theme.cls ? " + ' theme-infernal'" : ''};
          return true; })()`);
        await applyWorld({});
        const m = await metrics();
        seen[label] = m;
        titleColors[label] = m.titleColor;

        check(label + ' · 页面真的打开着、外壳在、五个页签、概览在最上面',
          !m.missing && m.timelineItems > 0);

        check(label + ' · body 上的主题 class 就是这一轮期望的那一个',
          m.themeInfernal === (theme.key === 'infernal'), m.bodyClass);

        check(label + ' · ★★★★ 时间线画出来了：每一条都有自己的行高、圆点列上有一根**真的**轨',
          m.timelineItems === 10 && m.timelineRowCount === 10 &&
          m.railWidth > 0 && m.railContent !== 'none' && m.railContent !== 'normal' &&
          /* ★ 1px 的线在缩略图里看不见，因此"看得见"必须由**读数**兜住：
             它真的被画了（content 不是 none）、而且有真实的 alpha。 */
          m.railAlpha >= 0.15 && m.railBg !== m.cardBg,
          m.timelineHeights.every(h => h > 12) &&
          m.timelineSvgCount === 10,
          { items: m.timelineItems, rail: [m.railWidth, m.railHeight], heights: m.timelineHeights.slice(0, 4) });

        /* ★ 最新的一条**不一定是**动了钱的那条：这一份 fixture 里最近发生的是
           "Agent 提出请求"，钱在下面几条才动。因此这里判的是"语气落了类、而且
           真的分类了"，不是"第一条必须是钱"。 */
        check(label + ' · ★★★★ 时间线的语气是**多种**的（不是一整列同一个圆点）',
          new Set(m.timelineTones).size >= 4 &&
          m.timelineTones.every(t => ['money', 'hold', 'ask', 'decision', 'asset', 'rule', 'fail', 'note'].indexOf(t) >= 0) &&
          m.timelineTones.indexOf('money') >= 0 && m.timelineTones.indexOf('fail') >= 0,
          m.timelineTones);

        check(label + ' · ★★★ 时间线的字在窄屏上没有被压到读不出来（≥ 11px）',
          m.timelineFontSizes.every(f => f >= 11), m.timelineFontSizes);

        check(label + ' · ★★★ 没有横向溢出（文档与面板都没有超过视口）',
          m.overflowX <= 1 && m.paneOverflowX <= 1, { doc: m.overflowX, pane: m.paneOverflowX });

        check(label + ' · ★★★★ 「经济活动」三条都在，来源与三步各自成列',
          m.activityCount === 3 &&
          m.activityStepKeys.every(k => k.join(',') === 'intent,approval,purchase') &&
          m.activitySources[0].join(' / ') === '按自主规则放行 / 系统完成' &&
          m.activitySources[1].join(' / ') === 'Agent 提议 / 用户批准 / 系统完成' &&
          m.activitySources[2].length === 0,
          { acts: m.activityCount, sources: m.activitySources });

        check(label + ' · ★★★★★ 自主放行那条的"决定"这一步说得出来为什么没有它',
          m.activityStepTexts[0][1].indexOf('按自主规则直接放行') >= 0 &&
          m.activityStepTexts[2][1].indexOf('早于授权层') >= 0,
          m.activityStepTexts.map(x => x[1]));

        check(label + ' · ★★★ 角色名是**名字**不是 id（连得上才出现）',
          m.activityWho[1].join('') === '由 小灰 发起' &&
          JSON.stringify(m.activityWho).indexOf('agent_a') < 0,
          m.activityWho);

        check(label + ' · ★★★★★ §4 的理由**逐字**在页面上（没有摘要、没有改写）',
          m.whyTexts.indexOf('用于生成更多视觉素材，这一批分镜需要 1 份。') >= 0 &&
          m.whyTexts.indexOf('想把这一段内部的算力留一点给下一次长任务用；如果这一次不够，就等下一轮再说。') >= 0 &&
          m.whyTexts.indexOf('这次请求没有写下原因') >= 0,
          m.whyTexts);

        check(label + ' · ★★★ 理由那一格占满可用宽度、而且没有溢出（长中文会折行不撑宽）',
          m.whyWidths.every(w => w > 60) && m.whyWidths.every(w => w <= vp.width) &&
          m.whyWidths.every(w => w <= m.timelineWidths[0] + 60),
          { why: m.whyWidths, item: m.timelineWidths[0] });

        check(label + ' · ★★★ 支出合计是等宽数字，而且不比说明文字小',
          m.spendTotalNums.indexOf('tabular-nums') >= 0 && m.spendFont > 0 &&
          m.spendTotal.indexOf('25.00') >= 0, { total: m.spendTotal, font: m.spendFont });

        check(label + ' · ★★★★ 钱包那格的"最近变化"写的是真的有过的变化，不是"暂无记录"',
          m.recentText.indexOf('购买完成') >= 0 && m.recentHasNone === false, m.recentText);

        check(label + ' · ★★★★ 高级信息**默认折叠**（真的不占高度）',
          m.auditHidden === true && m.auditCollapsed === 0 && m.auditToggleText.indexOf('展开') >= 0,
          { hidden: m.auditHidden, h: m.auditCollapsed, text: m.auditToggleText });

        check(label + ' · ★★★ 图标全是 inline SVG，页面上没有一个位图',
          m.svgCount >= 14 && m.imgCount === 0, { svg: m.svgCount, img: m.imgCount });

        check(label + ' · ★★★ 说明文字与时间那一列在这个主题里都有真实的对比度',
          contrastOf(m.noteColor, 'rgba(0,0,0,0)', m.cardBg) >= 3.0 &&
          contrastOf(m.tlTimeColor, 'rgba(0,0,0,0)', m.cardBg) >= 3.0,
          { note: contrastOf(m.noteColor, 'rgba(0,0,0,0)', m.cardBg),
            time: contrastOf(m.tlTimeColor, 'rgba(0,0,0,0)', m.cardBg) });

        check(label + ' · ★★★ 来源胶囊在这个主题里有边框可见（不是一团糊掉的底色）',
          contrastOf(m.chipColor, m.chipBg, m.cardBg) >= 3.2 &&
          m.chipFontSize >= 10.5,
          { c: contrastOf(m.chipColor, m.chipBg, m.cardBg), f: m.chipFontSize });

        if (vp.key === 'desktop' || vp.key === 'narrow320') {
          await shot('p22-18-overview-' + theme.key + '-' + vp.key, true);
        }
      }
    }

    check('②-主题 · 两套主题的标题颜色真的不同（令牌换了，不是同一份配色）',
      titleColors['internal/desktop'] !== titleColors['infernal/desktop'],
      { internal: titleColors['internal/desktop'], infernal: titleColors['infernal/desktop'] });

    check('②-主题 · 深色主题的背景与浅色主题真的不同',
      seen['internal/desktop'].cardBg !== seen['infernal/desktop'].cardBg,
      { internal: seen['internal/desktop'].cardBg, infernal: seen['infernal/desktop'].cardBg });

    /* ══════════════════════════════════════════════════════════════ */
    section('③ 320px：没有横向滚动、时间线不折成一坨、编号不许撑宽');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320, height: 720, deviceScaleFactor: 1, mobile: true
    });
    await evaluate(`(function(){ document.body.className = document.body.className.replace(/\\s*theme-infernal/g,''); return true; })()`);
    await applyWorld({});
    const n320 = await metrics();

    check('③-1 ★★★★★ 320px 没有横向滚动',
      n320.overflowX <= 1 && n320.paneOverflowX <= 1,
      { doc: n320.overflowX, pane: n320.paneOverflowX });

    check('③-2 ★★★★ 320px 时间线仍然是"一条一条"的（10 行），没有被折成一坨',
      n320.timelineRowCount === 10 && n320.timelineItems === 10 &&
      n320.timelineWidths.every(w => w > 120));

    check('③-3 ★★★★ 320px 三步**一步都没少**（窄屏只是把它们竖过来，不是藏掉）',
      n320.activityStepKeys.every(k => k.length === 3) && n320.stepRows >= 9,
      { steps: n320.stepRows });

    check('③-4 ★★★★ 320px 明细没有撑爆卡片：每一条的宽度都不超过可用宽度',
      n320.timelineWidths.every(w => w <= 320) && n320.whyWidths.every(w => w <= 320),
      { tl: n320.timelineWidths.slice(0, 3), why: n320.whyWidths });

    /* ── 展开高级信息：不许把页面撑宽 ───────────────────────────── */
    const opened = await evaluate(`(function(){
      var t = document.querySelector('#economy-shell-overview .esh-audit-toggle');
      if (t) t.click();
      var b = document.querySelector('#economy-shell-overview .esh-audit-body');
      var rows = [].slice.call(document.querySelectorAll('#economy-shell-overview .esh-audit-row'))
        .filter(function(r){ return !r.classList.contains('is-head'); });
      var cells = rows.map(function(r){ return [].slice.call(r.querySelectorAll('.esh-audit-cell'))
        .map(function(c){ return c.textContent; }); });
      var labels = [].slice.call(document.querySelectorAll('#economy-shell-overview .esh-audit-cell[data-k]'))
        .map(function(c){ return String(getComputedStyle(c, '::before').content); });
      return { hidden: b ? b.hidden : null, h: b ? Math.round(b.getBoundingClientRect().height) : -1,
        rows: rows.length, cells: cells, labels: labels,
        overflowX: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth,
        bodyText: b ? b.textContent : '',
        toggle: t ? t.textContent : '' };
    })()`);
    await new Promise(r => setTimeout(r, 250));
    const afterOpen = await evaluate(`(function(){
      return { overflowX: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth }; })()`);

    check('③-5 ★★★★★ 展开之后真的有高度、每一行恰好五格、四个编号都指得回 canonical',
      opened.hidden === false && opened.h > 0 && opened.rows >= 4 &&
      opened.cells.every(c => c.length === 5) &&
      opened.cells.join('|').indexOf('econ_int_vis_1') >= 0 &&
      opened.cells.join('|').indexOf('econ_apr_vis_1') >= 0 &&
      opened.cells.join('|').indexOf('econ_pur_vis_1') >= 0 &&
      opened.cells.join('|').indexOf('econ_quote_vis_1') >= 0 &&
      /* 没有 Purchase 的那条 intent 也在里面（它的两格就是「—」）。 */
      opened.cells.join('|').indexOf('econ_int_vis_9') >= 0,
      { h: opened.h, rows: opened.rows, first: opened.cells[0] });

    /* ★ 窄屏上表头藏起来了，因此"这一格是什么"必须由每一格自己的前缀
       提供 —— 只有裸编号的"高级信息"是没法用来排查的。 */
    check('③-5b ★★★★★ 320px 上每一个编号都带着**它是哪一种编号**（不是四个裸 id）',
      opened.labels.length >= 4 &&
      opened.labels.some(L => L.indexOf('请求编号') >= 0) &&
      opened.labels.some(L => L.indexOf('决定编号') >= 0) &&
      opened.labels.some(L => L.indexOf('购买编号') >= 0) &&
      opened.labels.some(L => L.indexOf('报价编号') >= 0),
      opened.labels.slice(0, 4));

    check('③-6 ★★★★★ 320px 展开编号之后**仍然**没有横向滚动（长 id 必须折行）',
      afterOpen.overflowX <= 1, afterOpen.overflowX);

    check('③-7 ★★★★★ 编号只出现在这一格里：折叠区以外的正文没有它们',
      (function () {
        const t = n320 ? seen['internal/narrow320'] : null;
        return opened.bodyText.indexOf('econ_apr_vis_1') >= 0;
      })());

    await shot('p22-18-audit-open-narrow320', true);

    /* ══════════════════════════════════════════════════════════════ */
    section('④ 被截断 / 空 / 两格委托');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await evaluate('window.__ibWorld.truncated = true;');
    await applyWorld({});
    const trunc = await evaluate(`(function(){
      var o = document.getElementById('economy-shell-overview');
      return { text: o.textContent, items: o.querySelectorAll('.esh-tl').length }; })()`);
    const truncatedCalls = await evaluate('(window.__ibCalls.reads || []).filter(function(r){ return r.path.indexOf("/economy/changes") === 0; }).length');
    check('④-1 ★★★★★ 被截断时页面**明说**它不是全部（"最近什么都没发生"是最危险的假信息）',
      trunc.text.indexOf('这台设备的活动记录比这一页读出来的多') >= 0 &&
      trunc.items === 24 && truncatedCalls >= 7,
      { items: trunc.items, changeReads: truncatedCalls });
    await shot('p22-18-truncated-desktop', true);

    await evaluate('window.__ibWorld.truncated = false; window.__ibWorld.empty = true;');
    await applyWorld({});
    const empty = await evaluate(`(function(){
      var o = document.getElementById('economy-shell-overview');
      return { text: o.textContent, items: o.querySelectorAll('.esh-tl').length,
        overflowX: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) - window.innerWidth }; })()`);
    check('④-2 ★★★ 空世界：时间线说"还没有任何记录"、钱包说"暂无记录"，而且不溢出',
      empty.items === 0 && empty.text.indexOf('还没有任何记录') >= 0 &&
      empty.text.indexOf('暂无记录') >= 0 && empty.overflowX <= 1,
      empty.items);
    await shot('p22-18-empty-desktop', true);

    await evaluate('window.__ibWorld.empty = false;');
    await applyWorld({});

    const delegate = await evaluate(`(function(){
      var page = document.getElementById('page-economy');
      var ids = [].slice.call(page.children).map(function(c){ return c.id; });
      IB.economyShellUI.show('requests');
      var req = document.getElementById('economy-requests');
      var cfg = document.getElementById('economy-configuration');
      var requestsState = { reqDisplay: req ? getComputedStyle(req).display : '', cfgDisplay: cfg ? getComputedStyle(cfg).display : '' };
      IB.economyShellUI.show('settings');
      var settingsState = { reqDisplay: req ? getComputedStyle(req).display : '',
        cfgDisplay: cfg ? getComputedStyle(cfg).display : '',
        cfgTabs: cfg ? [].slice.call(cfg.querySelectorAll('.ecfg-tab')).filter(function(t){
          return getComputedStyle(t).display !== 'none'; }).map(function(t){ return t.textContent.replace(/\\s+/g,''); }) : [] };
      IB.economyShellUI.show('overview');
      return { ids: ids, requestsState: requestsState, settingsState: settingsState };
    })()`);

    check('④-3 ★★★★★ 三个节点的顺序逐字没变（P22-16 的外壳 / P22-15 的容器 / 本阶段的外壳）',
      delegate.ids.join(',') === 'economy-configuration,economy-requests,economy-shell',
      delegate.ids);

    check('④-4 ★★★★★ 「待处理」：P22-15 的容器可见、P22-16 的外壳收起',
      delegate.requestsState.reqDisplay !== 'none' && delegate.requestsState.cfgDisplay === 'none',
      delegate.requestsState);

    check('④-5 ★★★★ 「设置」：P22-16 的外壳可见、它自己的页签只剩三个（「待处理」由外层提供）',
      delegate.settingsState.cfgDisplay !== 'none' && delegate.settingsState.reqDisplay === 'none' &&
      delegate.settingsState.cfgTabs.length === 3, delegate.settingsState);

    check('④-6 ★★★★★ 整个过程中 `/economy/*` 上的**写请求**仍然是 0',
      (await evaluate('(window.__ibCalls.posts || []).filter(function(p){ return p.path.indexOf("/economy/") === 0; }).length')) === 0,
      await evaluate('window.__ibCalls.posts'));

    const readPaths = await evaluate(`(function(){
      var paths = {}; (window.__ibCalls.reads || []).forEach(function(r){
        var q = r.path.split('?')[0]; paths[q] = 1; });
      return Object.keys(paths).sort(); })()`);
    const declared = ['/economy/wallet', '/economy/policy', '/economy/budget', '/economy/stores',
      '/economy/products', '/economy/inventory', '/economy/purchases', '/economy/intents',
      '/economy/changes'];
    check('④-7 ★★★★★ 外壳自己声明的九条读面都真的被请求过（含 canonical 的 change log）',
      declared.every(q => readPaths.indexOf(q) >= 0), readPaths);
    /* ★ 另外那几条（/security · /health · /api/context · /economy/approvals）是
       宿主与 P22-15 自己发的，不是这一页多读的 —— 因此这一条判的是
       "外壳没有读任何**未声明**的经济路径"。 */
    check('④-7b ★★★★★ 经济路径里没有一条在外壳的声明之外（P22-15 的 approvals 除外）',
      readPaths.filter(q => q.indexOf('/economy/') === 0)
        .every(q => declared.indexOf(q) >= 0 || q === '/economy/approvals'),
      readPaths.filter(q => q.indexOf('/economy/') === 0));

    check('④-8 ★★★ 页面上没有一位图、没有一个 emoji',
      (await evaluate(`(function(){
        var s = document.getElementById('economy-shell');
        return { img: s.querySelectorAll('img').length,
          emoji: /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]/u.test(s.textContent) }; })()`)).img === 0 &&
      (await evaluate(`/[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]/u.test(document.getElementById('economy-shell').textContent)`)) === false);

    /* ══════════════════════════════════════════════════════════════ */
    section('⑤ 资源：一个 Chrome、用完关掉');

    console.log('    · 本轮的 Chrome 进程数 = 1（复用到底，没有第二次 spawn）');
    check('⑤-1 ★★★★ 整个过程只启动了一个浏览器实例（child.pid 就是那一个）',
      typeof child.pid === 'number' && child.pid > 0);
  } finally {
    try { if (cdp) { await cdp.send('Browser.close'); } } catch (e) { /* 关不掉也要收尾 */ }
    try { child.kill(); } catch (e) { /* 已经退了 */ }
    await new Promise(r => setTimeout(r, 500));
    /* ★ 临时 profile 必须**真的**删掉（资源报告里"遗留浏览器进程 = 0、
       临时 profile = 0"是一条要交出去的读数）。Chrome 退出时文件句柄还开着，
       因此这里重试几次 —— 一次 rmSync 失败就放弃会在 %TEMP% 里留下一个
       几十 MB 的目录（开发期实测过）。 */
    for (let i = 0; i < 8; i += 1) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 还在被占用 */ }
      if (!fs.existsSync(profile)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    if (fs.existsSync(profile)) console.log('    ! 临时 profile 没有删掉：' + profile);
  }

  console.log('\n──────────────────────────────────────────────────────────────────');
  console.log('P22-18 visual: ' + (checks - failures) + '/' + checks + ' checks passed');
  console.log('截图目录：' + SHOT_DIR + '（不在仓库里：本阶段 PNG 新增 = 0）');
  if (failures) process.exit(1);
})();
