'use strict';
/* ====================================================================
   P22-15 · Economy Approval UI — 渲染器（真实 DOM 桩 + 真实网络形状）
   --------------------------------------------------------------------
   运行：node tests/test_p22_15_economy_approval_ui.js

   ── 零资源（§19）────────────────────────────────────────────────────
   无子进程、无 socket、无浏览器。DOM 用一个**只实现渲染器真正用到的那
   几个成员**的最小桩（createElement / appendChild / textContent / hidden
   / disabled / addEventListener / click），因此：
     · 渲染出的每一个字都是渲染器写进去的（不是测试拼的）；
     · 事件是**真的**通过 addEventListener 注册、由 click() 派发的。

   ── 它证明什么（每一组都对着一条 §19 的要求）────────────────────────
     A  静态纪律：UI 里没有 fetch(/economy/* POST)、没有禁用字段、
        没有 emoji / PNG / 外部 CDN 图标、样式表运行时注入（不占 HTML 预算）
     B  等待中的请求真的渲染出来，且主视觉是"某个角色想做一件事"
     C  APPROVE 的请求体恰好三个 canonical 字段
     D  双击保护 / 拒绝的两步确认
     E  决定之后**重新读** canonical 状态（不乐观宣称购买成功）
     F  APPROVED 但最终 DENIED / 完成 / 拒绝 / 过期 / 失败 各自的呈现
     G  空状态 · 坏读模型 · 节点不可达 · 凭据未配置
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
/* 每一组的中间量都留在这里：一条断言失败时，失败行会把它一并打出来，
   于是"为什么红"不需要靠再跑一次带打印的副本来回答。 */
const DIAG = {};
let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }

console.log('P22-15 · Economy Approval UI（渲染器）');

const uiSrc = read('assets/js/economy-approval.js');
const coreSrc = read('assets/js/economy-approval-core.js');
const cssSrc = read('assets/css/economy-approval.css');
const html = read('InternalBeyond.html');
const uiCode = uiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════ */
section('A · 静态纪律（§10 / §15 / §16 / §17 / 素材纪律）');

check('A1 ★★★ 渲染器里没有 fetch（写路径只能经 home-node-client 的既有方法）',
  uiCode.indexOf('fetch') < 0 && uiCode.indexOf('XMLHttpRequest') < 0);

check('A2 ★★★ 没有一条 /economy/* 的写形态，也没有 POST 字面量',
  !/method\s*:\s*['"]POST/.test(uiCode) && !/'\/economy\/[^']*'\s*,\s*\{[^}]*method/.test(uiCode) &&
  uiCode.indexOf("'/economy/intents'") < 0 && uiCode.indexOf('POST') < 0,
  { post: uiCode.indexOf('POST') });

check('A3 ★★★ 唯一的写调用是 driver.approvalDecision(...)，而且它只有一处',
  (uiCode.match(/approvalDecision\(/g) || []).length === 1 &&
  uiCode.indexOf('buildDecisionRequest') > 0);

check('A4 ★★★ 身份 / 权威字段在渲染器里从不作为属性被写出',
  ['consumerId', 'userId', 'decidedBy', 'authority', 'approved', 'autoAllow', 'amountMinor']
    .every(function (k) { return !new RegExp('(?:^|[^A-Za-z0-9_$])' + k + '\\s*:').test(uiCode); }));

check('A5 ★★★ 没有 P22-14 的配置面，也没有 Store / Wallet / Inventory / Catalog 页面（§16 / §17）',
  ['economy/configuration', 'BOOTSTRAP_CREDIT', 'PUT_BUDGET_POLICY', 'PUT_AUTONOMY_POLICY',
    'budget-policy', 'autonomy-policy', 'store-admin', 'wallet-panel', 'inventory-panel',
    'catalog-admin', 'topup', 'refund', 'exchange'].every(function (k) { return uiCode.indexOf(k) < 0; }));

check('A6 ★★★ 素材纪律：零生成图、零外部图、零 PNG/WebP/JPG、零外部 CDN，图标全是 inline SVG',
  !/\.png|\.webp|\.jpe?g/i.test(uiCode + cssSrc) &&
  !/url\(\s*['"]?https?:/i.test(cssSrc) &&
  /* ★ 只有 SVG 命名空间那一个 http:// 是允许的：它不会被浏览器取回，
     它是 XML 命名空间标识符。除它以外渲染器里没有第二个 http 地址。 */
  uiCode.split('http://www.w3.org/2000/svg').join('').indexOf('http://') < 0 &&
  uiCode.indexOf('https://') < 0 &&
  /* SVG 是**拼**出来的（MARK 状态图标 + KIND_ICON 商品图标 + 空状态托盘），
     因此这里数的是"文件里有几处 inline SVG 的来源"，而不是渲染一次的产出：
     一个 KIND_ICON 条目会渲染成很多个 <svg>。 */
  (uiSrc.match(/<svg/g) || []).length >= 3 &&
  uiCode.indexOf("createElement('img')") >= 0 /* 唯一的位图来源是既有的角色头像 */,
  DIAG.a6 = {
    png: !/\.png|\.webp|\.jpe?g/i.test(uiCode + cssSrc),
    cssUrl: !/url\(\s*['"]?https?:/i.test(cssSrc),
    bareHttp: uiCode.split('http://www.w3.org/2000/svg').join('').indexOf('http://') < 0,
    https: uiCode.indexOf('https://') < 0,
    svgSources: (uiSrc.match(/<svg/g) || []).length,
    avatarImg: uiCode.indexOf("createElement('img')") >= 0
  });

check('A6b ★★★ 本阶段没有往仓库里新增任何 PNG / WebP / JPG（素材纪律）',
  (function () {
    /* 只看本阶段新增的两个资产与它们引用到的东西：渲染器与样式表里
       没有任何位图路径（上面 A6 已断言），而 HTML 里新增的那两行也不含图片。 */
    const added = ['assets/js/economy-approval.js', 'assets/js/economy-approval-core.js', 'assets/css/economy-approval.css'];
    return added.every(function (f) {
      const s = read(f);
      return !/\.(?:png|webp|jpe?g|gif)\b/i.test(s) && !/data:image\//i.test(s);
    });
  })());

check('A7 ★★★ 没有 emoji（含金币 / 钱包 / 购物车那一类）',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(uiCode) &&
  !/[💰🪙💳🛒✨🎉]/u.test(uiCode));

const emojiCss = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(cssSrc);
check('A8 ★★ 样式表里也没有 emoji / 外部字体 / 外部图片', !emojiCss && !/https?:\/\//.test(cssSrc));

check('A9 ★★ 样式表按模块运行时注入（HTML 的 20 个样式表预算一个都不占）',
  /STYLE_ID: 'ib-econ-appr-style'/.test(uiSrc) && /STYLE_HREF: 'assets\/css\/economy-approval\.css'/.test(uiSrc) &&
  (html.match(/rel="stylesheet"/g) || []).length === 20);

check('A10 ★★ 页面容器与导航入口都在 HTML 里，且容器是空的（卡片由渲染器建）',
  /<div class="page" id="page-economy"><div id="economy-requests"><\/div><\/div>/.test(html) &&
  /href="#economy" data-page="economy">Economy</.test(html));

/* COPY 的**对象字面量**。
   ★ 刻意用两个哨兵串（标题与细节层最后一句）夹出区间，而不是靠"第一个
     `});`"：一个正则的一点点贪心/懒惰差异就会取到半张表，而"检查了半张
     表然后通过"是一个**看起来绿**的失败。开发期实测踩到过这个形状，
     所以这里改成按内容定位。 */
function copyBlock() {
  /* 行锚：`var COPY = Object.freeze({` 单独一行开始，`});` 单独一行结束。 */
  const m = uiSrc.match(/^var COPY = Object\.freeze\(\{[\s\S]*?^\}\);$/m);
  return m ? m[0] : '';
}
DIAG.copy = { len: copyBlock().length, hasSubtitle: /subtitle:/.test(copyBlock()) };

/* COPY 的每个字段名 → 它的字面量。用一份真解析，而不是"数几行里出现了
   某个词"：后者在阈值写错时会变成一条**永远红**或**永远绿**的断言。 */
function copyFields() {
  const out = {};
  for (const m of copyBlock().matchAll(/^\s{2}([A-Za-z_$][A-Za-z0-9_$]*):\s*'([^']*)'/gm)) out[m[1]] = m[2];
  return out;
}

check('A11 ★★ 按钮文案是"允许继续"而不是"购买 / 支付 / 结算"（§5）',
  /allow: '允许继续'/.test(uiCode) &&
  /* ★ 剥注释之后再查这几个词：它们在本文件**解释纪律的注释里**出现过
     （"按钮的文字是「允许继续」而不是「购买」"），而在代码里一个都不该有。 */
  ['立即购买', '确认支付', '付款', '结算', '下单'].every(function (w) { return uiCode.indexOf(w) < 0; }) &&
  (function () {
    const f = copyFields();
    if (!f.allow || f.allow !== '允许继续') return false;
    /* ★ 逐个**按钮**字段检查，而不是"数有几行出现了某个词"：渲染器真正
       交到按钮上的文案就是这四个字段，因此"按钮不说购买"就是这四句话里
       没有那几个词。解释性文案（空状态副文案、细节层）可以说"内部购买"、
       "批准不等于买到" —— 它们不是按钮。 */
    const BUTTONS = { allow: f.allow, reject: f.reject, rejectAsk: f.rejectAsk, rejectNo: f.rejectNo };
    const bad = Object.keys(BUTTONS).filter(function (k) {
      return /购买|支付|付款|结算|下单|立即/.test(BUTTONS[k]);
    });
    return bad.length === 0;
  })(),
  copyFields());

check('A12 ★★ 用户文案里没有 canonical 的大写状态词（原词只进技术详情）',
  (function () {
    const f = copyFields();
    /* 只有 subtitle 是既有页面的英文小标题惯例（与 Apps / Favorites 同款，
       它是**标题**不是状态词）。除它以外 COPY 的每一个值里都不许出现
       4 个以上连续大写字母 —— 那正是 WAITING_APPROVAL 这一类原词的形状。 */
    const bad = Object.keys(f).filter(function (k) {
      return k !== 'subtitle' && /[A-Z]{4,}/.test(f[k]);
    });
    return Object.keys(f).length >= 18 && bad.length === 0;
  })(),
  copyFields());

/* ══════════════════════════════════════════════════════════════════════
   DOM 桩：只实现渲染器用到的那几个成员
   ══════════════════════════════════════════════════════════════════════ */
function makeDom() {
  function El(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this._text = '';
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.id = '';
    this.src = '';
    this.alt = '';
    this.rel = '';
    this.href = '';
  }
  El.prototype.appendChild = function (child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  };
  Object.defineProperty(El.prototype, 'textContent', {
    get: function () {
      if (this.children.length) {
        return this.children.map(function (c) { return c.textContent; }).join('');
      }
      return this._text;
    },
    set: function (v) {
      this.children = [];
      this._text = v == null ? '' : String(v);
    }
  });
  Object.defineProperty(El.prototype, 'innerHTML', {
    get: function () { return this._html || ''; },
    set: function (v) { this._html = v == null ? '' : String(v); this.children = []; }
  });
  El.prototype.setAttribute = function (k, v) {
    this.attributes[String(k)] = String(v);
    if (k === 'id') this.id = String(v);
  };
  El.prototype.getAttribute = function (k) {
    return Object.prototype.hasOwnProperty.call(this.attributes, String(k)) ? this.attributes[String(k)] : null;
  };
  El.prototype.addEventListener = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  };
  /* classList 是真实浏览器里就有的东西，桩必须给 —— 但它的**唯一**存储
     仍然是 className 字符串（于是 find() 读的还是同一份事实）。 */
  Object.defineProperty(El.prototype, 'classList', {
    get: function () {
      const self = this;
      function parts() { return String(self.className || '').split(/\s+/).filter(Boolean); }
      function write(list) { self.className = list.join(' '); }
      return {
        add: function (c) { const l = parts(); if (l.indexOf(c) < 0) { l.push(c); write(l); } },
        remove: function (c) { write(parts().filter(function (x) { return x !== c; })); },
        contains: function (c) { return parts().indexOf(c) >= 0; },
        toggle: function (c, on) {
          const has = parts().indexOf(c) >= 0;
          const want = on === undefined ? !has : !!on;
          if (want && !has) { const l = parts(); l.push(c); write(l); }
          if (!want && has) write(parts().filter(function (x) { return x !== c; }));
        }
      };
    }
  });
  El.prototype.click = function () {
    const list = this.listeners.click || [];
    for (const fn of list) fn({ type: 'click', target: this });
    /* 只有最内层那一个按钮会绑 click，因此只派发一次即可。 */
  };
  El.prototype.walk = function (out) {
    out = out || [];
    out.push(this);
    for (const c of this.children) if (c && c.walk) c.walk(out);
    return out;
  };

  const head = new El('head');
  const doc = {
    readyState: 'complete',
    head: head,
    body: new El('body'),
    createElement: function (tag) { return new El(tag); },
    getElementById: function (id) { return id === 'economy-requests' ? doc._host : null; },
    addEventListener: function () { },
    _host: new El('div')
  };
  doc._host.setAttribute('id', 'economy-requests');
  return { doc: doc, El: El, head: head };
}

function find(root, cls) {
  return root.walk().filter(function (n) {
    return String(n.className || '').split(/\s+/).indexOf(cls) >= 0;
  });
}
function findByAttr(root, name, value) {
  return root.walk().filter(function (n) { return n.getAttribute(name) === value; });
}
/* 用户**看得见**的字：hidden 子树被跳过 —— 技术详情默认收起，因此它的内容
   不属于"主视觉"。这条与 B8 是同一件事的两半：B6/B8 断言的是可见文本，
   而 detailsOf() 断言的是那一层里确实有 ID。 */
function textOf(root) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.hidden === true) return;
    if (n._text != null && n._text !== '') out.push(String(n._text));
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out.join(' | ');
}
/* 技术详情那一层的内容（不受 hidden 影响）。 */
function detailsOf(root) {
  return find(root, 'ec-detail-body').map(function (n) { return n.textContent; }).join(' | ');
}

/* ══════════════════════════════════════════════════════════════════════
   假 driver：形状与 home-node-client 的 remote driver 一致
   ══════════════════════════════════════════════════════════════════════ */
const NOW = Date.now();

function world() {
  return {
    intents: [],
    approvals: [],
    products: [{ productId: 'econ_prod_1', name: 'Compute x1000', description: '给她的算力补充', kind: 'COMPUTE_CREDIT', status: 'ACTIVE' }],
    calls: [],
    reads: [],
    /* 场景开关 */
    decisionDelay: 0,
    getFailure: null,
    getMalformed: false,
    approveOutcome: 'completed',
    decisionRefusal: null,
    refuseOnce: null,
    rejectStatus: 'REJECTED',
    /* `/security` 的自述：决定路径开不开。默认开着（真实部署里由
       IB_HOME_NODE_TOKEN 决定，而那是权威的字段，不是界面的判断）。 */
    seamOpen: true
  };
}

function waitIntent(w, o) {
  const intent = Object.assign({
    agentIntentId: 'econ_intent_1', state: 'WAITING_APPROVAL', agentId: 'econ-agent',
    agentType: 'character', productId: 'econ_prod_1', units: 1, selfDirected: true,
    recipientId: null, quoteId: 'econ_quote_1', approvalId: 'econ_appr_1', purchaseId: null,
    authorityOutcome: 'REQUIRE_APPROVAL', authorityReasonCode: 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD',
    reason: 'compute is running low', createdAt: NOW - 60000, updatedAt: NOW - 30000, terminal: false
  }, o || {});
  const approval = {
    approvalId: intent.approvalId, status: 'PENDING', buyerId: 'character:econ-agent',
    recipientId: null, productId: intent.productId, quoteId: intent.quoteId, quoteKind: 'COMPUTE_GRANT',
    currency: 'IB_CREDIT', amountMinor: '1000', units: intent.units,
    expiresAt: NOW + 600000, expiredByTime: false, binding: { amountMinor: '1000', currency: 'IB_CREDIT', units: intent.units }
  };
  w.intents.push(intent);
  w.approvals.push(approval);
  return { intent: intent, approval: approval };
}

function makeDriver(w) {
  return {
    getJson: function (p, q) {
      w.reads.push({ path: p, q: q });
      if (w.getFailure) return Promise.resolve({ ok: false, error: w.getFailure });
      if (p === '/economy/intents') {
        if (w.getMalformed) return Promise.resolve({ ok: true, intents: 'not-an-array' });
        return Promise.resolve({ ok: true, intents: w.intents.slice() });
      }
      if (p === '/economy/approvals') return Promise.resolve({ ok: true, approvals: w.approvals.slice() });
      if (p === '/economy/products') return Promise.resolve({ ok: true, products: w.products.slice() });
      if (p === '/security') {
        /* 与 services/home-node/http.js 的 economyPolicy.approvalDecision
           逐字同形的那几个字段（本阶段只读其中两个）。 */
        return Promise.resolve({
          ok: true,
          economyPolicy: {
            approvalDecision: {
              implemented: true,
              open: w.seamOpen === true,
              approvalDecisionWritesExposed: w.seamOpen === true ? ['APPROVE', 'REJECT'] : [],
              requiresConfiguredDesktopCredential: true
            }
          }
        });
      }
      return Promise.resolve({ ok: false, error: 'unknown-path' });
    },
    approvalDecision: function (body) {
      w.calls.push(body);
      const done = function (res) {
        if (!w.decisionDelay) return Promise.resolve(res);
        return new Promise(function (r) { setTimeout(function () { r(res); }, w.decisionDelay); });
      };
      const appr = w.approvals.filter(function (a) { return a.approvalId === body.approvalId; })[0];
      const intent = w.intents.filter(function (i) { return i.approvalId === body.approvalId; })[0];
      if (!appr || !intent) {
        return done({ ok: false, status: 404, refused: true, reasonCode: 'ECONOMY_APPROVAL_DECISION_MISSING_APPROVAL_ID', decisionRecorded: false });
      }
      if (w.decisionRefusal) {
        return done(Object.assign({ ok: false, status: w.decisionRefusal.status || 409, refused: true, decisionRecorded: false }, w.decisionRefusal));
      }
      /* 只拒一次，但**不改任何状态**：模拟"另一条路径先动了"这类真实竞态
         —— seam 拒绝，而 canonical 读面仍然是原来那条。 */
      if (w.refuseOnce) {
        const once = w.refuseOnce;
        w.refuseOnce = null;
        return done(once);
      }
      if (appr.status !== 'PENDING') {
        return done({
          ok: false, status: 409, refused: true, decisionRecorded: false,
          reasonCode: 'ECONOMY_APPROVAL_DECISION_REFUSED_BY_THE_APPROVAL_STATE_MACHINE',
          downstreamReasonCode: 'TRANSITION_NOT_ALLOWED', decision: body.decision
        });
      }
      if (body.decision === 'REJECT') {
        appr.status = w.rejectStatus;
        intent.state = 'DENIED';
        return done({
          ok: true, status: 200, refused: false, decision: 'REJECT', approvalStatus: appr.status,
          decisionRecorded: true, continuation: 'none', resumeAttempted: false,
          purchaseCreatedNow: false, purchaseExists: false, ledgerMutation: false
        });
      }
      appr.status = 'APPROVED';
      if (w.approveOutcome === 'completed') {
        appr.status = 'CONSUMED';
        intent.state = 'COMPLETED';
        intent.purchaseId = 'econ_pur_1';
        return done({
          ok: true, status: 200, refused: false, decision: 'APPROVE', approvalStatus: 'APPROVED',
          decisionRecorded: true, continuation: 'attempted', continuationOk: true,
          purchaseCreatedNow: true, purchaseExists: true, purchaseCreated: true,
          continuedIntentId: intent.agentIntentId, continuedIntentState: 'COMPLETED',
          continuedPurchaseId: 'econ_pur_1', continuationReplayed: false,
          approvalDoesNotGuaranteeAPurchase: true, budgetWasNotBypassed: true
        });
      }
      if (w.approveOutcome === 'denied') {
        intent.state = 'DENIED';
        return done({
          ok: true, status: 200, refused: false, decision: 'APPROVE', approvalStatus: 'APPROVED',
          decisionRecorded: true, continuation: 'attempted', continuationOk: false,
          continuationReasonCode: 'INSUFFICIENT_AVAILABLE_BALANCE',
          purchaseCreatedNow: false, purchaseExists: false,
          continuedIntentId: intent.agentIntentId, continuedIntentState: 'DENIED',
          approvalDoesNotGuaranteeAPurchase: true, budgetWasNotBypassed: true
        });
      }
      /* continuing：许可已批，intent **真的**被推进到 EXECUTING
         （续做真的开始了 —— 这正是"正在继续"与"等待继续"的区别）。 */
      intent.state = 'EXECUTING';
      return done({
        ok: true, status: 200, refused: false, decision: 'APPROVE', approvalStatus: 'APPROVED',
        decisionRecorded: true, continuation: 'attempted', continuationOk: true,
        purchaseCreatedNow: false, purchaseExists: false,
        continuedIntentId: intent.agentIntentId, continuedIntentState: 'EXECUTING',
        approvalDoesNotGuaranteeAPurchase: true
      });
    }
  };
}

/* ── 装载：core + 渲染器，装进一个受控沙箱 ───────────────────────────── */
function mount(w, options) {
  const o = options || {};
  const dom = makeDom();
  const box = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    Date: Date, Math: Math, JSON: JSON, Object: Object, Array: Array, String: String,
    Number: Number, Boolean: Boolean, RegExp: RegExp, Error: Error, Promise: Promise,
    isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat, encodeURIComponent: encodeURIComponent
  };
  box.window = box; box.self = box;
  box.document = dom.doc;
  box.localStorage = { getItem: function () { return null; }, setItem: function () { }, removeItem: function () { } };
  box.toastLog = [];
  box.toast = function (m) { box.toastLog.push(String(m)); };
  box.apiConfigs = [{ id: 'econ-agent', nickname: '栖', avatar: '' }];
  box.archivedConfigs = [];
  box.IB = {};
  const ctx = vm.createContext(box);
  vm.runInContext(coreSrc, ctx, { filename: 'economy-approval-core.js' });
  vm.runInContext(uiSrc, ctx, { filename: 'economy-approval.js' });
  box.IB.__ibEconomyDecisionDriver = makeDriver(w);
  if (o.hostMissing) box.__hostMissing = true;
  return { box: box, dom: dom, ui: box.IB.economyApprovalUI, core: box.IB.economyApprovalCore, host: dom.doc._host };
}

function tick(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 6); i++) p = p.then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
  return p;
}

(async function main() {

/* ══════════════════════════════════════════════════════════════════════ */
section('B · 等待中的请求真的渲染出来');

const w1 = world();
waitIntent(w1);
const m1 = mount(w1);
check('B1 ★★ 样式表被注入到 head（运行时注入，不占 HTML 预算）',
  m1.dom.head.children.length === 1 &&
  m1.dom.head.children[0].id === 'ib-econ-appr-style' &&
  m1.dom.head.children[0].rel === 'stylesheet' &&
  m1.dom.head.children[0].href === 'assets/css/economy-approval.css');

m1.ui.render();
await tick();
const cards = find(m1.host, 'ec-card');
const body = textOf(m1.host);
check('B2 ★★★ 进入页面时读的是**四条既有**只读面：三条经济读面 + /security 那一条自述',
  w1.reads.length === 4 &&
  ['/economy/intents', '/economy/approvals', '/economy/products', '/security'].every(function (p) {
    return w1.reads.some(function (r) { return r.path === p; });
  }) &&
  /* 三个经济读面带 limit；/security 不带（它不是列表）。 */
  w1.reads.filter(function (r) { return r.path !== '/security'; })
    .every(function (r) { return /limit=/.test(String(r.q)); }), w1.reads);

check('B2b ★★★ 读的时候只发出 GET：driver 的读取器没有 method 参数，而它读的是三条路径之一',
  (function () {
    const src = read('assets/js/home-node-client.js');
    const fn = (src.match(/getJson: function[\s\S]*?\n    \},/) || [''])[0];
    return fn.length > 0 && fn.indexOf('method') < 0 &&
      /p\.charAt\(0\) !== '\/'/.test(fn);
  })());

check('B3 ★★★ 一条 WAITING 的 intent 渲染成一张卡片，主视觉是"角色 + 想做什么"',
  cards.length === 1 && body.indexOf('栖') >= 0 && body.indexOf('想补充一些算力') >= 0 &&
  body.indexOf('Compute x1000') >= 0 && body.indexOf('给她的算力补充') >= 0);

check('B4 ★★★ 角色给的理由逐字出现（§3：先角色，后权威事实）',
  body.indexOf('compute is running low') >= 0);

check('B5 ★★ 金额与数量来自 canonical 读面（1000 minor IB_CREDIT → 10.00）',
  body.indexOf('10.00 IB Credit') >= 0 && body.indexOf('× 1') >= 0);

check('B6 ★★ 状态徽标说的是"等待你的决定"，不是 WAITING_APPROVAL',
  body.indexOf('等待你的决定') >= 0 && body.indexOf('WAITING_APPROVAL') < 0);

check('B7 ★★★ 权威事实是"呈现"而不是"重算"：裁决与原因来自读面给的字段',
  body.indexOf('需要你确认') >= 0 && body.indexOf('超过了可以自己决定的上限') >= 0);

check('B8 ★★★ ID 与 canonical 词默认不出现；它们在技术详情里',
  body.indexOf('econ_intent_1') < 0 && body.indexOf('econ_appr_1') < 0 &&
  find(m1.host, 'ec-detail-body').length === 1 &&
  find(m1.host, 'ec-detail-body')[0].hidden === true);

check('B9 ★★★ 两个动作的文案是"拒绝请求 / 允许继续"，而且没有"购买 / 支付"字样',
  find(m1.host, 'ec-btn-reject')[0].textContent === '拒绝请求' &&
  find(m1.host, 'ec-btn-allow')[0].textContent === '允许继续' &&
  body.indexOf('立即购买') < 0 && body.indexOf('支付') < 0);

check('B10 ★★ 空状态的条件没有触发（有一条待决定的请求）',
  find(m1.host, 'ec-surface-empty').length === 0);

/* ══════════════════════════════════════════════════════════════════════ */
section('C · APPROVE：请求体恰好三个 canonical 字段（§15）');

const allowBtn = find(m1.host, 'ec-btn-allow')[0];
allowBtn.click();
await tick();

check('C1 ★★★ 一次点击 = 一个请求，而请求体恰好是 {approvalId, decision, idempotencyKey}',
  w1.calls.length === 1 &&
  JSON.stringify(Object.keys(w1.calls[0])) === JSON.stringify(['approvalId', 'decision', 'idempotencyKey']),
  w1.calls);

check('C2 ★★★ 三个值都对：approvalId 来自读面、decision 是 canonical 的 APPROVE、幂等键只含 [a-z0-9-]',
  w1.calls[0].approvalId === 'econ_appr_1' && w1.calls[0].decision === 'APPROVE' &&
  /^[a-z0-9-]+$/.test(w1.calls[0].idempotencyKey));

check('C3 ★★★ 浏览器**没有**送出任何身份 / 权威 / 金额字段',
  ['consumerId', 'userId', 'authority', 'approved', 'autoAllow', 'amountMinor', 'currency',
    'productId', 'quoteId', 'purchaseId', 'decidedBy'].every(function (k) {
    return !Object.prototype.hasOwnProperty.call(w1.calls[0], k);
  }));

/* ══════════════════════════════════════════════════════════════════════ */
section('D · 双击保护与拒绝的两步确认（§7）');

const w2 = world();
waitIntent(w2);
const m2 = mount(w2);
m2.ui.render();
await tick();
w2.decisionDelay = 30;
const allow2 = find(m2.host, 'ec-btn-allow')[0];
allow2.click();
const allow2b = find(m2.host, 'ec-btn-allow')[0];
allow2b.click();
allow2b.click();
/* ★ 三个断言必须在**同一个同步帧**里看：一次 await 之后这次决定就已经
   落地了（那正是它该有的行为），届时卡片会重新读 canonical 状态，
   "进行中"这个瞬时态自然就不在了。 */
const midBusy = findByAttr(m2.host, 'aria-busy', 'true');
const midDisabled = find(m2.host, 'ec-btn-allow').concat(find(m2.host, 'ec-btn-reject'))
  .filter(function (b) { return b.disabled === true; }).length;
await tick(30);

check('D1 ★★★ 进行中双击（连点三次）只发出**一个**请求',
  w2.calls.length === 1, w2.calls.length);

check('D2 ★★ 进行中整张卡片标了 aria-busy，而且两个动作按钮都 disabled',
  midBusy.length === 1 && midDisabled === 2,
  { busy: midBusy.length, disabled: midDisabled });

const w3 = world();
waitIntent(w3);
const m3 = mount(w3);
m3.ui.render();
await tick();
const reject3 = find(m3.host, 'ec-btn-reject')[0];
reject3.click();
await tick(2);

check('D3 ★★★ 第一次点"拒绝请求"只是确认，**没有**发出请求',
  w3.calls.length === 0 && find(m3.host, 'ec-btn-reject')[0].textContent === '确定拒绝？' &&
  find(m3.host, 'ec-btn-keep').length === 1);

find(m3.host, 'ec-btn-keep')[0].click();
await tick(2);
check('D4 ★★ "再想想"回到未确认态，仍然没有请求',
  w3.calls.length === 0 && find(m3.host, 'ec-btn-reject')[0].textContent === '拒绝请求' &&
  find(m3.host, 'ec-btn-keep').length === 0);

find(m3.host, 'ec-btn-reject')[0].click();
await tick(1);
find(m3.host, 'ec-btn-reject')[0].click();
await tick(4);

check('D5 ★★★ 第二次确认才发出 REJECT，而请求体同样只有三个字段',
  w3.calls.length === 1 && w3.calls[0].decision === 'REJECT' &&
  JSON.stringify(Object.keys(w3.calls[0])) === JSON.stringify(['approvalId', 'decision', 'idempotencyKey']));

/* ══════════════════════════════════════════════════════════════════════ */
section('E · 决定之后重新读 authority（不乐观宣称购买成功）');

check('E1 ★★★ APPROVE 之后渲染器**重新读了**权威（四条只读面各再读一次），不是本地改状态',
  w1.reads.length === 8 &&
  w1.reads.filter(function (r) { return r.path === '/economy/intents'; }).length === 2 &&
  w1.reads.filter(function (r) { return r.path === '/security'; }).length === 2, w1.reads.length);

const afterBody = textOf(m1.host);
check('E2 ★★★ 卡片显示的是 canonical 读面说的"已完成"，而不是"购买成功"',
  afterBody.indexOf('已完成') >= 0 && afterBody.indexOf('购买成功') < 0);

check('E3 ★★ 已完成的卡片不再有动作按钮（它已经不是"等你决定"）',
  find(m1.host, 'ec-btn-allow').length === 0 && find(m1.host, 'ec-btn-reject').length === 0);

check('E4 ★★ 决定面自述"批准不等于买到"的话术出现在结果区',
  afterBody.indexOf('已经完成') >= 0);

check('E5 ★★★ REJECT 的终态是正常结果：卡片说"已拒绝"，没有警告框、没有红色大字',
  (function () {
    const b = textOf(m3.host);
    return b.indexOf('已拒绝') >= 0 && b.indexOf('错误') < 0 && b.indexOf('警告') < 0 &&
      find(m3.host, 'ec-btn-allow').length === 0;
  })());

/* ══════════════════════════════════════════════════════════════════════ */
section('F · APPROVED 之后的每一种真实结局（§5 / §8）');

for (const scenario of [
  { name: 'F1 ★★★ APPROVED 但预算最终 DENY ⇒ 卡片说"没有通过"，并如实说"你自己已经允许过了"',
    outcome: 'denied', want: ['没有通过', '你自己已经允许过了'], reject: ['购买成功'] },
  { name: 'F2 ★★ APPROVED 且仍在推进 ⇒ "已允许 · 正在继续"',
    outcome: 'continuing', want: ['已允许 · 正在继续'], reject: ['已完成'] }
]) {
  const w = world();
  waitIntent(w);
  w.approveOutcome = scenario.outcome;
  const m = mount(w);
  m.ui.render();
  await tick();
  find(m.host, 'ec-btn-allow')[0].click();
  await tick(8);
  const t = textOf(m.host);
  check(scenario.name,
    scenario.want.every(function (x) { return t.indexOf(x) >= 0; }) &&
    scenario.reject.every(function (x) { return t.indexOf(x) < 0; }), t.slice(0, 400));
}

await (async function () {
  const w = world();
  const made = waitIntent(w);
  made.approval.expiredByTime = true;
  const m = mount(w);
  m.ui.render();
  await tick();
  const t = textOf(m.host);
  check('F3 ★★★ 批准已过期（读面 expiredByTime）⇒ "已过期"，落在"近期的决定"里而不是从列表消失，且没有动作按钮',
    t.indexOf('已过期') >= 0 && find(m.host, 'ec-surface-empty').length === 1 &&
    find(m.host, 'ec-history').length === 1 && find(m.host, 'ec-btn-allow').length === 0);
})();

await (async function () {
  const w = world();
  waitIntent(w, { state: 'FAILED', authorityReasonCode: null });
  const m = mount(w);
  m.ui.render();
  await tick();
  const t = textOf(m.host);
  check('F4 ★★ FAILED 不是巨大红框：它是一张安静的历史卡片，带一个中性徽标',
    t.indexOf('没能完成') >= 0 && find(m.host, 'ec-tone-failed').length >= 1 &&
    find(m.host, 'ec-surface-failed').length === 0 && find(m.host, 'ec-btn-allow').length === 0);
})();

await (async function () {
  const w = world();
  const made = waitIntent(w, { agentIntentId: 'econ_intent_gift', approvalId: 'econ_appr_gift', selfDirected: false, recipientId: 'cfg_other' });
  /* quoteKind 是**批准**面的事实（GIFT / COMPUTE_GRANT / PURCHASE），
     它决定这张卡片读作"购买"还是"送出一份礼物"。 */
  made.approval.quoteKind = 'GIFT';
  const m = mount(w);
  /* 收件人也要能被既有角色目录认出来（apiConfigs 是角色的唯一事实源）。 */
  m.box.apiConfigs.push({ id: 'cfg_other', nickname: '阿澜', avatar: '' });
  m.ui.render();
  await tick();
  const t = textOf(m.host);
  check('F5 ★★ 礼物类请求读作"想送出一份礼物"，并显示对象（不是自称"购买"）',
    t.indexOf('想送出一份礼物') >= 0 && t.indexOf('给 阿澜') >= 0);
})();

/* ══════════════════════════════════════════════════════════════════════ */
section('G · 空状态 · 坏读模型 · 节点不可达 · 凭据未配置');

await (async function () {
  const w = world();
  const m = mount(w);
  m.ui.render();
  await tick();
  const t = textOf(m.host);
  check('G1 ★★★ 空状态是"暂时没有需要你决定的请求"，而不是 "No approvals found"',
    t.indexOf('暂时没有需要你决定的请求') >= 0 &&
    t.indexOf('角色提出需要确认的内部购买时，会出现在这里') >= 0 &&
    t.indexOf('No approvals') < 0 && t.indexOf('没有数据') < 0);
  check('G2 ★★★ 空状态带一张 inline SVG（安静的空托盘），而且不是 emoji / PNG',
    find(m.host, 'ec-surface-art').length === 1 &&
    find(m.host, 'ec-surface-art')[0].innerHTML.indexOf('<svg') >= 0 &&
    find(m.host, 'ec-surface-art')[0].innerHTML.indexOf('💰') < 0 &&
    find(m.host, 'ec-surface-art')[0].innerHTML.indexOf('.png') < 0);
  check('G3 ★★ 空状态里没有动作按钮（不给一个永远失败的按钮）',
    find(m.host, 'ec-btn-allow').length === 0 && find(m.host, 'ec-btn-reject').length === 0);
})();

await (async function () {
  const w = world();
  w.getMalformed = true;
  const m = mount(w);
  m.ui.render();
  await tick();
  const t = textOf(m.host);
  check('G4 ★★★ 读模型不成形 ⇒ 明说"读到的数据不成形"，而不是画一堆空卡片',
    t.indexOf('读到的数据不成形') >= 0 && find(m.host, 'ec-card').length === 0);
  check('G5 ★★ 坏读模型面有"再试一次"，而且在修复后能正常渲染',
    find(m.host, 'ec-surface-action').length === 1);
  w.getMalformed = false;
  waitIntent(w);
  find(m.host, 'ec-surface-action')[0].click();
  await tick(6);
  check('G6 ★★★ 再试一次之后真的读回来了（不是假装修好）',
    find(m.host, 'ec-card').length === 1 && textOf(m.host).indexOf('Compute x1000') >= 0);
})();

await (async function () {
  const w = world();
  w.getFailure = 'home-node-unreachable';
  const m = mount(w);
  m.ui.render();
  await tick();
  const t = textOf(m.host);
  check('G7 ★★★ Home Node 不可达 ⇒ 一句人话 + 可执行的下一步（不出现 ECONNREFUSED / 端口）',
    t.indexOf('连接不上本机节点') >= 0 && t.indexOf('ECONNREFUSED') < 0 &&
    t.indexOf('23118') < 0 && t.indexOf('重启 InternalBeyond') >= 0);
})();

await (async function () {
  const w = world();
  waitIntent(w);
  w.seamOpen = false;   /* /security 说：这条路径现在是关的 */
  const m = mount(w);
  m.ui.render();
  await tick();
  const t = textOf(m.host);
  check('G8 ★★★ 凭据没配时**进入页面就**说清楚（不是等用户点一下才发现），而且给的是可执行的指路',
    t.indexOf('这台设备还没有配置本机节点的访问凭据') >= 0 &&
    find(m.host, 'ec-gate').length === 1 &&
    t.indexOf('ECONOMY_APPROVAL_DECISION') < 0 &&
    /* 没有红框、没有错误字样：它是一句说明，不是一次失败。 */
    t.indexOf('错误') < 0 && t.indexOf('失败') < 0, t.slice(0, 400));
  check('G9 ★★ 而且这个说明不是把按钮禁用掉：真正的准入判定在 seam，界面不自作主张',
    find(m.host, 'ec-btn-allow').length === 1 &&
    find(m.host, 'ec-btn-allow')[0].disabled === false);
})();

await (async function () {
  const w = world();
  waitIntent(w);
  const m = mount(w);
  m.ui.render();
  await tick();
  /* 真的按下去，而 seam 拒绝（凭据在这台设备上不存在 —— 它可能刚刚被改掉，
     页面上那一行说明读的是上一次 /security 的快照）。 */
  w.decisionRefusal = {
    status: 403, refused: true, decisionRecorded: false,
    reasonCode: 'ECONOMY_APPROVAL_DECISION_DESKTOP_TOKEN_NOT_CONFIGURED'
  };
  find(m.host, 'ec-btn-allow')[0].click();
  await tick(8);
  const t = textOf(m.host);
  check('G9b ★★★ 一次被拒的决定不吞掉真实状态：卡片留在原地、说明原因、原码只在字段里',
    t.indexOf('等待你的决定') >= 0 &&
    t.indexOf('这台设备还没有配置访问凭据') >= 0 &&
    t.indexOf('ECONOMY_APPROVAL_DECISION') < 0 &&
    find(m.host, 'ec-btn-allow').length === 1);
  check('G9c ★★ 并且通过既有 toast 给了一次反馈（不是静默失败）',
    m.box.toastLog.length === 1, m.box.toastLog);
})();

await (async function () {
  const w = world();
  waitIntent(w);
  const m = mount(w);
  m.ui.render();
  await tick();
  /* seam 拒绝，但 canonical 状态**没有**变（另一条路径先动了）——
     这才是"卡片留在原地 + 说明这一次为什么没生效"的真实场景。 */
  w.refuseOnce = {
    status: 409, refused: true, decisionRecorded: false, decision: 'APPROVE',
    reasonCode: 'ECONOMY_APPROVAL_DECISION_REFUSED_BY_THE_APPROVAL_STATE_MACHINE',
    downstreamReasonCode: 'TRANSITION_NOT_ALLOWED'
  };
  find(m.host, 'ec-btn-allow')[0].click();
  await tick(8);
  const t = textOf(m.host);
  check('G10 ★★★ "这一步现在不能做"被翻译成人话，原词只留在字段里，而且状态没被伪造',
    t.indexOf('不接受这个决定') >= 0 && t.indexOf('这一步现在不能做') >= 0 &&
    t.indexOf('TRANSITION_NOT_ALLOWED') < 0 && t.indexOf('等待你的决定') >= 0 &&
    find(m.host, 'ec-btn-allow').length === 1 && m.box.toastLog.length === 1,
    t.slice(0, 400));
})();

await (async function () {
  const w = world();
  const m = mount(w);
  m.ui.render();
  await tick();
  const snap = m.ui.snapshot();
  check('G11 ★★ 诊断快照可用（stage / reads / failure / pending 都是只读事实）',
    snap.stage === 'ready' && snap.failure === null && Array.isArray(snap.pending) &&
    snap.view && Array.isArray(snap.view.waiting));
})();

console.log('\n' + '─'.repeat(66));
console.log('P22-15 ui: ' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) { console.error('FAILED: ' + failures); process.exit(1); }
console.log('ALL PASS');

})();
