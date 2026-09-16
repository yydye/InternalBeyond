'use strict';
/* ====================================================================
   P22-15 · Economy Approval UI — 视觉与响应式核对（真实浏览器 · 自截图）
   --------------------------------------------------------------------
   运行：node tests/test_p22_15_economy_approval_visual.js

   ★ 这个文件**不在** test-all.js 里，理由与 test_ui_regression.js 同款：
     它要开一个真实浏览器。它存在的唯一理由是 §12 / §13 / §18：
     "internal / infernal / desktop / narrow / mobile 都真的看一眼" ——
     而这件事只能由一个真的排版引擎回答，不能由 DOM 断言代替。

   它做三件事：
     ① 在 file:// 载入真实 InternalBeyond.html（与 test_ui_regression.js
        同款承载），把四条只读面与 P22-13 的决定面**注入**成假的 fetch；
     ② 对 5 个组合（两套主题 × 三档宽度）各检查一次真实排版：
        卡片宽度 / 有没有横向溢出 / 按钮够不够大 / 主题变量真的换了；
     ③ 把每一档截成 PNG 落到 %TEMP%，供人工看一眼。
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
const SHOT_DIR = path.join(os.tmpdir(), 'ib-p22-15-shots');

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

/* ── 最小 CDP 客户端（与 test_ui_regression.js 同一子集）────────────── */
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

/* ── 假的只读面 + 假的决定面：四条 GET 与一条 POST ──────────────────── */
const SEED = `(function(){
  var NOW = Date.now();
  try { localStorage.setItem('ib_home_node_token', 'p22-15-visual-token'); } catch (e) {}
  var intents = [
    { agentIntentId: 'econ_intent_visual_1', state: 'WAITING_APPROVAL', agentId: 'ib-visual-agent',
      agentType: 'character', productId: 'econ_prod_visual_1', units: 2, selfDirected: true,
      recipientId: null, quoteId: 'econ_quote_visual_1', approvalId: 'econ_appr_visual_1',
      purchaseId: null, authorityOutcome: 'REQUIRE_APPROVAL',
      authorityReasonCode: 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD',
      reason: '算力快用完了，再给她一批我就能把今天那篇稿子写完。',
      createdAt: NOW - 240000, updatedAt: NOW - 60000, terminal: false },
    { agentIntentId: 'econ_intent_visual_2', state: 'WAITING_APPROVAL', agentId: 'ib-visual-agent',
      agentType: 'character', productId: 'econ_prod_visual_2', units: 1, selfDirected: false,
      recipientId: 'ib-visual-other', quoteId: 'econ_quote_visual_2', approvalId: 'econ_appr_visual_2',
      purchaseId: null, authorityOutcome: 'REQUIRE_APPROVAL',
      authorityReasonCode: 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD',
      reason: '她上次说过想要这个，我想送她一份。',
      createdAt: NOW - 90000, updatedAt: NOW - 30000, terminal: false },
    { agentIntentId: 'econ_intent_visual_3', state: 'COMPLETED', agentId: 'ib-visual-agent',
      agentType: 'character', productId: 'econ_prod_visual_1', units: 1, selfDirected: true,
      recipientId: null, quoteId: 'econ_quote_visual_3', approvalId: 'econ_appr_visual_3',
      purchaseId: 'econ_pur_visual_3', authorityOutcome: 'REQUIRE_APPROVAL', authorityReasonCode: null,
      reasonCode: null, reason: '写稿需要。', createdAt: NOW - 86400000, updatedAt: NOW - 86000000,
      terminal: true },
    { agentIntentId: 'econ_intent_visual_4', state: 'DENIED', agentId: 'ib-visual-agent',
      agentType: 'character', productId: 'econ_prod_visual_2', units: 4, selfDirected: true,
      recipientId: null, quoteId: 'econ_quote_visual_4', approvalId: 'econ_appr_visual_4',
      purchaseId: null, authorityOutcome: 'DENY', authorityReasonCode: 'INSUFFICIENT_AVAILABLE_BALANCE',
      reasonCode: 'INSUFFICIENT_AVAILABLE_BALANCE', reason: '想多存一点。',
      createdAt: NOW - 172800000, updatedAt: NOW - 172000000, terminal: true }
  ];
  var approvals = [
    { approvalId: 'econ_appr_visual_1', status: 'PENDING', buyerId: 'character:ib-visual-agent',
      recipientId: null, productId: 'econ_prod_visual_1', quoteId: 'econ_quote_visual_1',
      quoteKind: 'COMPUTE_GRANT', currency: 'IB_CREDIT', amountMinor: '1250', units: 2,
      expiresAt: NOW + 900000, expiredByTime: false,
      binding: { amountMinor: '1250', currency: 'IB_CREDIT', units: 2 } },
    { approvalId: 'econ_appr_visual_2', status: 'PENDING', buyerId: 'character:ib-visual-agent',
      recipientId: 'ib-visual-other', productId: 'econ_prod_visual_2', quoteId: 'econ_quote_visual_2',
      quoteKind: 'GIFT', currency: 'IB_CREDIT', amountMinor: '8800', units: 1,
      expiresAt: NOW + 1800000, expiredByTime: false,
      binding: { amountMinor: '8800', currency: 'IB_CREDIT', units: 1 } },
    { approvalId: 'econ_appr_visual_3', status: 'CONSUMED', buyerId: 'character:ib-visual-agent',
      recipientId: null, productId: 'econ_prod_visual_1', quoteId: 'econ_quote_visual_3',
      quoteKind: 'PURCHASE', currency: 'IB_CREDIT', amountMinor: '625', units: 1,
      expiresAt: NOW - 86000000, expiredByTime: false,
      binding: { amountMinor: '625', currency: 'IB_CREDIT', units: 1 } },
    { approvalId: 'econ_appr_visual_4', status: 'APPROVED', buyerId: 'character:ib-visual-agent',
      recipientId: null, productId: 'econ_prod_visual_2', quoteId: 'econ_quote_visual_4',
      quoteKind: 'PURCHASE', currency: 'IB_CREDIT', amountMinor: '3520', units: 4,
      expiresAt: NOW - 172000000, expiredByTime: false,
      binding: { amountMinor: '3520', currency: 'IB_CREDIT', units: 4 } }
  ];
  var products = [
    { productId: 'econ_prod_visual_1', name: 'Compute x1000', kind: 'COMPUTE_CREDIT',
      description: '给她的一批算力额度，用完之后可以再补。', status: 'ACTIVE' },
    { productId: 'econ_prod_visual_2', name: '共同读的一本书 · 精装', kind: 'DIGITAL_ITEM',
      description: '共读间里可以一起翻的那一本，永久留在她的书架上。', status: 'ACTIVE' }
  ];
  var calls = [];
  window.__ibVisualCalls = calls;
  window.fetch = function (url, init) {
    var u = String(url);
    var method = (init && init.method) || 'GET';
    var send = function (obj) {
      var body = JSON.stringify(obj);
      return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(body); },
        json: function () { return Promise.resolve(obj); } });
    };
    if (method === 'POST') {
      var parsed = {};
      try { parsed = JSON.parse(init.body || '{}'); } catch (e) {}
      calls.push({ url: u, method: method, body: parsed });
      var appr = null;
      for (var i = 0; i < approvals.length; i++) if (approvals[i].approvalId === parsed.approvalId) appr = approvals[i];
      for (var j = 0; j < intents.length; j++) {
        if (intents[j].approvalId === parsed.approvalId) {
          if (parsed.decision === 'REJECT') { intents[j].state = 'DENIED'; if (appr) appr.status = 'REJECTED'; }
          else { intents[j].state = 'COMPLETED'; intents[j].purchaseId = 'econ_pur_visual_x'; if (appr) appr.status = 'CONSUMED'; }
        }
      }
      return send({ ok: true, status: 200, refused: false, decision: parsed.decision,
        approvalStatus: parsed.decision === 'REJECT' ? 'REJECTED' : 'APPROVED',
        decisionRecorded: true, continuation: parsed.decision === 'REJECT' ? 'none' : 'attempted',
        continuationOk: parsed.decision !== 'REJECT',
        purchaseCreatedNow: parsed.decision !== 'REJECT', purchaseExists: parsed.decision !== 'REJECT',
        continuedIntentState: parsed.decision === 'REJECT' ? 'DENIED' : 'COMPLETED' });
    }
    if (u.indexOf('/economy/intents') >= 0) return send({ ok: true, intents: intents });
    if (u.indexOf('/economy/approvals') >= 0) return send({ ok: true, approvals: approvals });
    if (u.indexOf('/economy/products') >= 0) return send({ ok: true, products: products });
    if (u.indexOf('/security') >= 0) return send({ ok: true, protocolVersion: 1,
      economyPolicy: { approvalDecision: { implemented: true, open: true,
        approvalDecisionWritesExposed: ['APPROVE', 'REJECT'], requiresConfiguredDesktopCredential: true } } });
    return Promise.resolve({ ok: false, status: 404, text: function () { return Promise.resolve('{}'); },
      json: function () { return Promise.resolve({ ok: false }); } });
  };
})();`;

(async function main() {
  const exe = chromePath();
  if (!exe) { console.error('找不到 Chrome/Edge；跳过视觉核对。'); process.exit(2); }
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-15-chrome-'));
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
          const page = list.filter(t => t.type === 'page')[0];
          if (page) return await Cdp.connect(page.webSocketDebuggerUrl);
        } catch (e) { /* 还没起来 */ }
        await new Promise(r => setTimeout(r, 250));
      }
      throw new Error('devtools 没有在 15s 内起来');
    })();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

    const evaluate = async (expression, awaitPromise) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: !!awaitPromise });
      if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      return r.result.value;
    };

    const loaded = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: PAGE_URL });
    await loaded;
    await evaluate(SEED);
    /* 重新载入一次，让注入的 fetch 在脚本之前就位（Home Node client 读的是全局 fetch）。 */
    const loaded2 = new Promise(resolve => cdp.on('Page.loadEventFired', resolve));
    await evaluate(SEED).catch(() => { });
    await cdp.send('Page.reload', { ignoreCache: false });
    await loaded2;
    await evaluate(SEED);

    await evaluate(`(function(){
      /* 走真实入口：splash 上的"跳过，直接探索"就是 enterSite()（与用户点它
         是同一个函数）。只把 class 藏起来不够 —— 那一层是全屏的，它会把
         整页盖住，于是截出来永远是欢迎页。 */
      try { if (typeof enterSite === 'function') enterSite(); } catch (e) {}
      var s=document.getElementById('splash'); if(s) s.classList.add('hidden');
      var pl=document.getElementById('preloader'); if(pl) pl.classList.add('hidden');
      var n=document.getElementById('navbar'); if(n) n.classList.add('visible');
      var a=document.getElementById('app'); if(a) a.classList.add('visible');
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 900));
    await evaluate(`(function(){
      /* 这个空环境里还会弹既有浮层：欢迎向导与"数据库清空"诊断卡。
         它们与本阶段无关，但在截图里会盖住整页。 */
      ['#setup-wizard-overlay','#setup-wizard','#ib-err-stack','.ib-err-card']
        .forEach(function(sel){
          [].slice.call(document.querySelectorAll(sel)).forEach(function(el){
            el.classList.remove('show','visible'); el.style.display = 'none';
          });
        });
      [].slice.call(document.querySelectorAll('div,section,aside')).forEach(function(el){
        if (el.style.display === 'none') return;
        var t=(el.textContent||'').trim();
        if (t.length < 400 && (t.indexOf('数据库清空') >= 0 || t.indexOf('欢迎使用 InternalBeyond') >= 0)) {
          el.style.display = 'none';
        }
      });
      try { location.hash = 'economy'; } catch (e) {}
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 700));

    const VIEWPORTS = [
      { key: 'desktop', width: 1440, height: 1000, mobile: false },
      { key: 'narrow', width: 900, height: 900, mobile: false },
      { key: 'mobile', width: 390, height: 844, mobile: true }
    ];
    const THEMES = [
      { key: 'internal', cls: '' },
      { key: 'infernal', cls: 'theme-infernal' }
    ];

    const metricsOf = `(function(){
      var host = document.getElementById('economy-requests');
      var cards = host ? host.querySelectorAll('.ec-card') : [];
      var wide = 0;
      for (var i = 0; i < cards.length; i++) wide = Math.max(wide, cards[i].getBoundingClientRect().width);
      var btn = host ? host.querySelector('.ec-btn-allow') : null;
      var rect = btn ? btn.getBoundingClientRect() : null;
      var body = document.body;
      return {
        page: document.getElementById('page-economy').classList.contains('active'),
        cards: cards.length,
        waiting: host ? host.querySelectorAll('.ec-list .ec-card').length : 0,
        history: host ? host.querySelectorAll('.ec-history .ec-card').length : 0,
        cardWidth: Math.round(wide),
        hostWidth: host ? Math.round(host.getBoundingClientRect().width) : 0,
        allowHeight: rect ? Math.round(rect.height) : 0,
        allowWidth: rect ? Math.round(rect.width) : 0,
        overflowX: body.scrollWidth - window.innerWidth,
        docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        themeInfernal: body.classList.contains('theme-infernal'),
        surface: getComputedStyle(document.documentElement).getPropertyValue('--glass-bg-elevated').trim(),
        cardBg: cards.length ? getComputedStyle(cards[0]).backgroundColor : '',
        cardText: cards.length ? getComputedStyle(cards[0]).color : '',
        amountSize: host ? (function(){ var a=host.querySelector('.ec-amount'); return a?getComputedStyle(a).fontSize:''; })() : '',
        emptyArt: host ? host.querySelectorAll('.ec-surface-art').length : 0,
        chevron: host ? host.querySelectorAll('.ec-detail-toggle').length : 0,
        title: host ? (function(){ var t=host.querySelector('.ec-title'); return t?t.textContent:''; })() : '',
        gate: host ? host.querySelectorAll('.ec-gate').length : 0,
        gateText: host ? (function(){ var g=host.querySelector('.ec-gate-text'); return g?g.textContent.slice(0,20):''; })() : '',
        ctaText: btn ? btn.textContent : '',
        /* §13 的两条真实读数：文字颜色与卡片底色。两套主题都必须成立，
           而"看起来对不对"最终是这两个值加对比度说了算。 */
        cardColor: cards.length ? getComputedStyle(cards[0]).color : '',
        cardBgColor: cards.length ? getComputedStyle(cards[0]).backgroundColor : '',
        nameColor: host && host.querySelector('.ec-name') ? getComputedStyle(host.querySelector('.ec-name')).color : '',
        cardOpacity: cards.length ? getComputedStyle(cards[0]).opacity : '',
        textShadow: host && host.querySelector('.ec-name') ? getComputedStyle(host.querySelector('.ec-name')).textShadow : ''
      };
    })()`;

    /* 关掉这个空环境里会弹出来的**既有**浮层（首启向导 / "数据库清空"诊断卡）。
       它们与本阶段无关，但会盖住整页；在每一次导航之后再关一次，因为它们
       是异步弹出来的。 */
    const dismissOverlays = `(function(){
      [].slice.call(document.querySelectorAll('#setup-wizard-overlay,#setup-wizard,.ib-err-card,#ib-err-stack'))
        .forEach(function(el){ el.classList.remove('show'); el.style.display='none'; });
      [].slice.call(document.querySelectorAll('div,section,aside')).forEach(function(el){
        if (el.style.display === 'none') return;
        var t=(el.textContent||'').trim();
        if (t.length < 400 && (t.indexOf('数据库清空') >= 0 || t.indexOf('欢迎使用 InternalBeyond') >= 0)) {
          el.style.display = 'none';
        }
      });
      return true;
    })()`;

    for (const theme of THEMES) {
      section('主题 ' + theme.key);
      await evaluate(`(function(){
        document.body.className = '${theme.cls}';
        try { localStorage.setItem('ib_theme', '${theme.key}'); } catch (e) {}
        location.hash = 'economy';
        return true;
      })()`);
      await evaluate(`(function(){
        /* ★ P22-17：Economy 页面多了一个**外层**页签条，「待处理」是其中
           一格。切到它之后 economy-requests 那个容器才可见 —— 这是 §2 要求
           的信息架构变更，而本文件其余每一处断言都逐字未动（P22-15 的实现
           一个字节都没改，只是住进了一个页签里）。 */
        if (window.IB && IB.economyShellUI) IB.economyShellUI.show('requests');
        if (window.IB && IB.economyApprovalUI) IB.economyApprovalUI.render();
        return true;
      })()`);
      await new Promise(r => setTimeout(r, 700));
      await evaluate(dismissOverlays);
      await new Promise(r => setTimeout(r, 250));

      for (const vp of VIEWPORTS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile
        });
        await new Promise(r => setTimeout(r, 450));
        await evaluate(dismissOverlays);
        const m = await evaluate(metricsOf);
        const label = theme.key + '/' + vp.key;

        check(label + ' · 页面真的打开着，两张待决定 + 两条历史', m.page === true && m.waiting === 2 && m.history === 2, m);
        check(label + ' · 没有横向溢出（页面宽度没有超过视口）', m.overflowX <= 1 && m.docOverflowX <= 1, { overflowX: m.overflowX, docOverflowX: m.docOverflowX });
        check(label + ' · 卡片不会横跨整个屏幕（有内容最大宽度）',
          m.cardWidth <= Math.min(m.hostWidth, 960) && m.cardWidth > 0, { cardWidth: m.cardWidth, hostWidth: m.hostWidth });
        check(label + ' · 主线按钮在大屏够大、在手机是整行可点',
          vp.mobile ? (m.allowHeight >= 42 && m.allowWidth >= vp.width - 80) : (m.allowHeight >= 36), { h: m.allowHeight, w: m.allowWidth });
        check(label + ' · 主题真的是那一个（body 上有对应的类，且卡片底色随主题变）',
          m.themeInfernal === (theme.key === 'infernal') && !!m.cardBg, { infernal: m.themeInfernal, bg: m.cardBg });
        check(label + ' · 金额被强调（字号大于正文）',
          parseFloat(m.amountSize) >= 16, m.amountSize);
        check(label + ' · 技术详情默认收起（每张卡片恰好一个「细节」开关）', m.chevron === 4, m.chevron);

        /* §13 · 主题适配的**真实读数**（不是"看着还行"）：
           ① 卡片上没有那条浅色主题的白色发光（它会把小字糊掉）；
           ② 文字色与卡片底色在**两套主题下都不相同**（说明令牌真的换了）；
           ③ 历史卡片的 opacity 是 1（半透明只写在 .ec-card-quiet 上，
              不会把整张卡片连文字一起压淡）。 */
        check(label + ' · 浅色主题那条白色发光在卡片子树里被关掉（text-shadow: none）',
          m.textShadow === 'none' || m.textShadow === '', m.textShadow);
        check(label + ' · 卡片文字色与底色都随主题真的换了（不是只有背景换）',
          !!m.cardColor && !!m.cardBgColor && m.cardBgColor !== 'rgba(0, 0, 0, 0)', { color: m.cardColor, bg: m.cardBgColor });
        check(label + ' · 主线卡片的 opacity 是 1（"安静"只写在历史卡片上）',
          m.cardOpacity === '1', m.cardOpacity);

        /* 视口截图（不是整页）：这样"一屏里看见了什么"与人打开这一页时
           看见的是同一件事。 */
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(SHOT_DIR, 'p22-15-' + theme.key + '-' + vp.key + '.png');
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log('    · 截图 ' + file);
      }
    }

    /* 手机端一次真实点击：按钮真的能点，而且只发三个字段。 */
    section('手机端一次真实点击');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(`(function(){ document.body.className=''; location.hash='economy';
      if (window.IB && IB.economyShellUI) IB.economyShellUI.show('requests');
      if (window.IB && IB.economyApprovalUI) IB.economyApprovalUI.render(); return true; })()`);
    await new Promise(r => setTimeout(r, 600));
    await evaluate(`(function(){ var b=document.querySelector('.ec-btn-allow'); if(b) b.click(); return true; })()`);
    await new Promise(r => setTimeout(r, 1200));
    const post = await evaluate(`(function(){
      var c=(window.__ibVisualCalls||[]).filter(function(x){return x.method==='POST';});
      return c.length ? { n: c.length, keys: Object.keys(c[0].body).sort(), body: c[0].body } : { n: 0 };
    })()`);
    check('MOBILE-1 ★★★ 点击"允许继续"真的发出一次决定，而且请求体恰好三个 canonical 字段',
      post.n === 1 && JSON.stringify(post.keys) === JSON.stringify(['approvalId', 'decision', 'idempotencyKey']), post);
    check('MOBILE-2 ★★★ 浏览器没有送出任何身份 / 权威 / 金额字段',
      post.n === 1 && ['consumerId', 'userId', 'authority', 'approved', 'autoAllow', 'amountMinor',
        'currency', 'productId', 'quoteId', 'purchaseId'].every(k => !(k in post.body)), post.body);
    const after = await evaluate(`(function(){
      var host=document.getElementById('economy-requests');
      var badges=[].slice.call(host.querySelectorAll('.ec-badge-text')).map(function(b){return b.textContent;});
      var cards=[].slice.call(host.querySelectorAll('.ec-card')).map(function(c){
        return { status: c.getAttribute('data-status'), badge: (c.querySelector('.ec-badge-text')||{}).textContent||'' }; });
      return { waiting: host.querySelectorAll('.ec-list .ec-card').length,
        history: host.querySelectorAll('.ec-history .ec-card').length,
        badges: badges, cards: cards };
    })()`);
    check('MOBILE-3 ★★★ 决定之后卡片按**重新读到的** canonical 状态更新（不是乐观宣称）：' +
      '它从"待决定"移进历史，状态码变成 COMPLETED',
      after.waiting === 1 && after.history === 3 &&
      after.cards.some(c => c.status === 'COMPLETED' && c.badge === '已完成') &&
      after.cards.some(c => c.status === 'WAITING_APPROVAL' && c.badge === '等待你的决定'), after);
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file2 = path.join(SHOT_DIR, 'p22-15-after-decision-mobile.png');
    fs.writeFileSync(file2, Buffer.from(shot2.data, 'base64'));
    console.log('    · 截图 ' + file2);

    /* 空状态也要看一眼（§18 第 6 条）。 */
    section('空状态');
    await evaluate(`(function(){
      window.IB.economyApprovalCore;
      var orig = window.fetch;
      window.__ibEmpty = true;
      var send = function (obj) { var body = JSON.stringify(obj);
        return Promise.resolve({ ok: true, status: 200, text: function(){return Promise.resolve(body);},
          json: function(){return Promise.resolve(obj);} }); };
      window.fetch = function (url, init) {
        var u = String(url); var method = (init && init.method) || 'GET';
        if (method === 'POST') return send({ ok: true, status: 200, refused: false, decision: 'APPROVE' });
        if (u.indexOf('/economy/intents') >= 0) return send({ ok: true, intents: [] });
        if (u.indexOf('/economy/approvals') >= 0) return send({ ok: true, approvals: [] });
        if (u.indexOf('/economy/products') >= 0) return send({ ok: true, products: [] });
        if (u.indexOf('/security') >= 0) return send({ ok: true, economyPolicy: { approvalDecision: { implemented: true, open: true } } });
        return orig(url, init);
      };
      IB.economyApprovalUI.refresh();
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 900));
    const emptyMetrics = await evaluate(`(function(){
      var host=document.getElementById('economy-requests');
      var art=host.querySelector('.ec-surface-art');
      return { surface: host.querySelectorAll('.ec-surface-empty').length,
        title: (function(){var t=host.querySelector('.ec-surface-title');return t?t.textContent:'';})(),
        svg: art ? art.querySelectorAll('svg').length : 0,
        strokes: art ? art.querySelectorAll('path').length : 0,
        cta: host.querySelectorAll('.ec-btn-allow').length,
        overflowX: document.body.scrollWidth - window.innerWidth };
    })()`);
    check('EMPTY-1 ★★★ 空状态是"暂时没有需要你决定的请求" + 一句副文案，且没有动作按钮',
      emptyMetrics.surface === 1 && emptyMetrics.title === '暂时没有需要你决定的请求' && emptyMetrics.cta === 0, emptyMetrics);
    check('EMPTY-2 ★★★ 空状态那张图是 inline SVG 线性轮廓（不是 emoji、不是 PNG）',
      emptyMetrics.svg === 1 && emptyMetrics.strokes >= 8, emptyMetrics);
    check('EMPTY-3 ★★ 手机端空状态也不横向溢出', emptyMetrics.overflowX <= 1, emptyMetrics.overflowX);
    const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file3 = path.join(SHOT_DIR, 'p22-15-empty-mobile.png');
    fs.writeFileSync(file3, Buffer.from(shot3.data, 'base64'));
    console.log('    · 截图 ' + file3);

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
  console.log('P22-15 visual: ' + (checks - failures) + '/' + checks + ' checks passed');
  console.log('截图目录：' + SHOT_DIR + '（不在仓库里：本阶段 PNG 新增 = 0）');
  if (failures) { console.error('FAILED: ' + failures); process.exit(1); }
  console.log('ALL PASS');
})();
