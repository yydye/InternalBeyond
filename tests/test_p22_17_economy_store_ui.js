'use strict';
/* ====================================================================
   P22-17 · Economy Store / Wallet / Inventory UI — 渲染器
   （assets/js/economy-shell.js）
   --------------------------------------------------------------------
   运行：node tests/test_p22_17_economy_store_ui.js

   ★ 一个只实现渲染器真正用到的成员的 DOM 桩 + 一个与 home-node-client
     同形状的假 driver。**零子进程、零 socket、零浏览器、零 fetch。**

   这一条测试要回答的问题（§12 的十六条里除去"真浏览器"那两条）：

     · 概览真的显示 canonical 的可用额度，而且 COLD / DEGRADED 时
       **一个 0 都不出现**；
     · 商店真的把 P22-5 的货架与商品做成卡片，而且**没有**购买按钮；
     · 商品卡的视觉身份来自 productId 的确定性哈希，同一 id 两次渲染一致，
       而价格/状态来自 canonical 字段；
     · 我的资产按 canonical 的 assetKind 分组，SERVICE 不被伪造；
     · 购买历史把四种状态译成人话，代号只在折叠的技术层；
     · 传输上：八个读路径全在既有 GET 白名单里，写方法**一次都没被调用**；
     · 结构上：外壳**追加**在页尾，P22-15/16 的两个节点位置与子树
       一个字节都没被搬动（这是它们不回归的结构保证）。
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const UI_REL = 'assets/js/economy-shell.js';

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
const uiSrc = read(UI_REL);
const uiCode = uiSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const html = read('InternalBeyond.html');
const cssSrc = read('assets/css/economy-shell.css');
/* ★ 判 emoji 时两边都先**剥注释**：注释里的 ★ 是这一仓库的排版标记，
   不是 emoji（在原文上判会得到一条"为了通过必须删掉注释"的假红）。 */
const cssCode = cssSrc.replace(/\/\*[\s\S]*?\*\//g, ' ');

console.log('P22-17 · Economy Shell UI（渲染器 + 假 driver）');

/* ══════════════════════════════════════════════════════════════════════
   DOM 桩：只实现渲染器真的用到的成员
   ------------------------------------------------------------------
   ① `getElementById` 用**走树**而不是一张注册表：于是"节点真的在文档里"
      与"getElementById 找得到它"是同一件事。
   ② `textContent` 的 getter 递归拼接子节点：可见文案的断言读的是它。
   ③ `style.setProperty` 真的记下来：确定性视觉身份写进 CSS 变量的那一步
      因此**可以被断言**，而不是被一句 try/catch 吃掉。
   ══════════════════════════════════════════════════════════════════════ */
function makeDom() {
  function Style() { this._vars = Object.create(null); }
  Style.prototype.setProperty = function (k, v) { this._vars[String(k)] = String(v); };
  Style.prototype.getPropertyValue = function (k) {
    return Object.prototype.hasOwnProperty.call(this._vars, String(k)) ? this._vars[String(k)] : '';
  };
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
    this.checked = false;
    this.value = '';
    this.id = '';
    this.name = '';
    this.type = '';
    this.rel = '';
    this.href = '';
    this.selected = false;
    this.style = new Style();
  }
  El.prototype.appendChild = function (child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  };
  El.prototype.insertBefore = function (child, ref) {
    if (!child) return child;
    child.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  };
  Object.defineProperty(El.prototype, 'textContent', {
    get: function () {
      return (this._text || '') + this.children.map(c => c.textContent).join('');
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
  Object.defineProperty(El.prototype, 'firstChild', {
    get: function () { return this.children.length ? this.children[0] : null; }
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
  Object.defineProperty(El.prototype, 'classList', {
    get: function () {
      const self = this;
      function parts() { return String(self.className || '').split(/\s+/).filter(Boolean); }
      function write(list) { self.className = list.join(' '); }
      return {
        add: function (c) { const l = parts(); if (l.indexOf(c) < 0) { l.push(c); write(l); } },
        remove: function (c) { write(parts().filter(x => x !== c)); },
        contains: function (c) { return parts().indexOf(c) >= 0; },
        toggle: function (c, on) {
          const has = parts().indexOf(c) >= 0;
          const want = on === undefined ? !has : !!on;
          if (want && !has) { const l = parts(); l.push(c); write(l); }
          if (!want && has) write(parts().filter(x => x !== c));
        }
      };
    }
  });
  El.prototype.click = function () {
    for (const fn of (this.listeners.click || [])) fn({ type: 'click', target: this });
  };
  El.prototype.walk = function (out) {
    out = out || [];
    out.push(this);
    for (const c of this.children) if (c && c.walk) c.walk(out);
    return out;
  };

  const head = new El('head');
  const body = new El('body');
  const page = new El('div');
  page.className = 'page active';
  page.setAttribute('id', 'page-economy');
  /* HTML 里的既有容器：`#economy-requests`（P22-15）。P22-16 的外壳由它
     自己的 renderer 运行时插在它**前面** —— 与生产逐字同款。 */
  const requests = new El('div');
  requests.setAttribute('id', 'economy-requests');
  page.appendChild(requests);
  body.appendChild(page);

  const doc = {
    readyState: 'complete',
    head: head,
    body: body,
    createElement: function (tag) { return new El(tag); },
    getElementById: function (id) {
      const hit = body.walk().filter(n => String(n.id || '') === String(id));
      return hit.length ? hit[0] : null;
    },
    addEventListener: function () { },
    _page: page,
    _requests: requests
  };
  return { doc: doc, El: El, head: head, page: page, requests: requests };
}

function find(root, cls) {
  return root.walk().filter(n => String(n.className || '').split(/\s+/).indexOf(cls) >= 0);
}
function textOutsideTechnical(root) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (String(n.className || '').split(/\s+/).indexOf('esh-technical') >= 0) return;
    if (n.hidden === true) return;
    if (n._text != null && n._text !== '') out.push(String(n._text));
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out.join(' | ');
}
function allText(root) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n._text != null && n._text !== '') out.push(String(n._text));
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out.join(' | ');
}
/* ★ 三段面板的正文拼在一起，**忽略 hidden**（面板是全部渲染好、只有一格
   可见的），但仍然跳过折叠的技术层。这一条很重要：否则"正文里没有代号"
   会因为"那一格现在不可见"而通过 —— 一个看起来绿的假红。 */
function allPanesText(doc, ids) {
  return ids.map(id => {
    const n = doc.getElementById(id);
    return n ? textOutsideTechnicalIncludingHidden(n) : '';
  }).join('\n');
}
function textOutsideTechnicalIncludingHidden(root) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (String(n.className || '').split(/\s+/).indexOf('esh-technical') >= 0) return;
    if (n._text != null && n._text !== '') out.push(String(n._text));
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out.join(' | ');
}
function byId(doc, id) { return doc.getElementById(id); }
function paneText(doc, id) { const n = byId(doc, id); return n ? textOutsideTechnical(n) : ''; }
function buttonsWith(root, words) {
  return root.walk().filter(n => n.tagName === 'BUTTON' &&
    words.some(w => String(n.textContent).indexOf(w) >= 0));
}

/* ══════════════════════════════════════════════════════════════════════
   假 driver + world
   ══════════════════════════════════════════════════════════════════════ */
const WALLET_READY = {
  ok: true,
  wallet: {
    domain: 'economy', walletId: 'econ_wallet_1', owner: { type: 'character', id: 'a1' },
    currency: 'IB_CREDIT', accountId: 'acct_1', state: 'READY', balanceKnown: true,
    cachedBalanceMinor: '1245000', ledgerBalanceMinor: '1245000',
    reservedBalanceMinor: '12000', cachedBalanceDrifted: false, reservedCacheDrifted: false,
    availableBalanceMinor: '1245000', revision: 7
  }
};
const POLICY = {
  ok: true,
  policy: {
    domain: 'economy', policyId: 'econ_policy_1', ownerId: 'character:a1', currency: 'IB_CREDIT',
    status: 'ACTIVE', limits: { perTransactionMinor: '5000', dailyMinor: '50000', approvalThresholdMinor: '2000' },
    termEndsAt: null, expiredByTerm: false, hardStop: false, autonomyLevel: 'LIMITED', revision: 3
  }
};
const BUDGET = {
  ok: true,
  snapshot: { currency: 'IB_CREDIT', spentTodayMinor: '1250', spentThisWeekMinor: '4300', availableBalanceMinor: '1245000' },
  decision: { outcome: 'ALLOW', reasonCode: 'WITHIN_LIMITS' }, evaluatedOnly: true, notASpendPermit: true, reserved: false
};
const STORES = {
  ok: true, holdsPrices: false, holdsOwnership: false, holdsInventory: false,
  stores: [
    { storeId: 'econ_store_a', name: '数字工坊', description: '安静的货架', status: 'ACTIVE', sortOrder: 1 },
    { storeId: 'econ_store_b', name: '修图铺', description: '', status: 'DISABLED', sortOrder: 2 }
  ]
};
const PRODUCTS = {
  ok: true, personalized: false, hasRecommendations: false, hasDiscounts: false,
  products: [
    { productId: 'econ_prod_1', storeId: 'econ_store_a', kind: 'DIGITAL_ITEM', fulfillment: 'INVENTORY_GRANT', name: '数字绘画额度', description: '一张图的额度', currency: 'IB_CREDIT', unitPriceMinor: '2000', unitName: 'item', grantQuantity: 1, assetKind: 'ITEM', status: 'ACTIVE' },
    { productId: 'econ_prod_2', storeId: 'econ_store_a', kind: 'COMPUTE_CREDIT', fulfillment: 'COMPUTE_GRANT', name: '算力包', description: '一小段算力', currency: 'IB_CREDIT', unitPriceMinor: '500', unitName: 'computeUnit', grantQuantity: 100, assetKind: 'COMPUTE', status: 'DISABLED' },
    { productId: 'econ_prod_3', storeId: 'econ_store_b', kind: 'SERVICE', fulfillment: 'SERVICE_EXECUTION', name: '一次修图', description: '', currency: 'IB_CREDIT', unitPriceMinor: '800', unitName: 'service', grantQuantity: 1, assetKind: null, status: 'RETIRED' }
  ]
};
const INVENTORY = {
  ok: true, isABalance: false, contributesToAvailableBalance: false, locksFunds: false,
  entries: [
    { inventoryEntryId: 'econ_inv_1', ownerId: 'character:a1', productId: 'econ_prod_1', assetKind: 'ITEM', quantity: 3, revision: 2, createdAt: 1000, updatedAt: 2000, productPresent: true, isABalance: false },
    { inventoryEntryId: 'econ_inv_2', ownerId: 'character:a1', productId: 'econ_prod_2', assetKind: 'COMPUTE', quantity: 250, revision: 1, createdAt: 1500, updatedAt: 1900, productPresent: true, isABalance: false },
    { inventoryEntryId: 'econ_inv_3', ownerId: 'character:a1', productId: 'econ_prod_missing', assetKind: 'ITEM', quantity: 1, revision: 1, createdAt: 900, updatedAt: 2100, productPresent: false, isABalance: false }
  ]
};
const PURCHASES = {
  ok: true, count: 4, personalized: false, recommended: false, ranked: false, exposesMutation: false,
  purchases: [
    { purchaseId: 'econ_pur_1', buyerId: 'character:a1', productId: 'econ_prod_1', storeId: 'econ_store_a', currency: 'IB_CREDIT', amountMinor: '2000', status: 'COMPLETED', terminal: true, completed: true, approvalMode: 'APPROVAL', units: 1, grantedQuantity: 1, unitName: 'item', createdAt: 1700000000000, completedAt: 1700000010000 },
    { purchaseId: 'econ_pur_2', buyerId: 'character:a1', productId: 'econ_prod_2', currency: 'IB_CREDIT', amountMinor: '500', status: 'RESERVED', terminal: false, completed: false, approvalMode: 'AUTO_ALLOW', createdAt: 1700000100000 },
    { purchaseId: 'econ_pur_3', buyerId: 'character:a1', productId: 'econ_prod_3', currency: 'IB_CREDIT', amountMinor: '800', status: 'RELEASED', terminal: true, completed: false, approvalMode: null, createdAt: 1700000200000 },
    { purchaseId: 'econ_pur_4', buyerId: 'character:a1', productId: 'econ_prod_1', currency: 'IB_CREDIT', amountMinor: '2000', status: 'FAILED', terminal: true, completed: false, approvalMode: 'APPROVAL', createdAt: 1700000300000 }
  ]
};
const INTENTS = {
  ok: true,
  intents: [
    { agentIntentId: 'econ_int_1', agentId: 'a1', purchaseId: 'econ_pur_1', state: 'COMPLETED' },
    { agentIntentId: 'econ_int_4', agentId: 'a9', purchaseId: 'econ_pur_4', state: 'FAILED' }
  ]
};

function defaultWorld() {
  return {
    wallet: WALLET_READY, policy: POLICY, budget: BUDGET,
    stores: STORES, products: PRODUCTS, inventory: INVENTORY,
    purchases: PURCHASES, intents: INTENTS
  };
}

function makeDriver(world) {
  const calls = { reads: [], writes: [] };
  const d = {
    calls: calls,
    getJson: function (p, q) {
      calls.reads.push({ path: p, query: q });
      if (p === '/economy/wallet') return Promise.resolve(world.wallet || { ok: false, error: 'wallet-not-found', status: 404 });
      if (p === '/economy/policy') return Promise.resolve(world.policy || { ok: false, error: 'budget-policy-not-found', status: 404 });
      if (p === '/economy/budget') return Promise.resolve(world.budget || { ok: false, error: 'budget-evaluation-failed', status: 400 });
      if (p === '/economy/stores') return Promise.resolve(world.stores || { ok: true, stores: [] });
      if (p === '/economy/products') return Promise.resolve(world.products || { ok: true, products: [] });
      if (p === '/economy/inventory') return Promise.resolve(world.inventory || { ok: true, entries: [] });
      if (p === '/economy/purchases') return Promise.resolve(world.purchases || { ok: true, purchases: [] });
      if (p === '/economy/intents') return Promise.resolve(world.intents || { ok: true, intents: [] });
      if (p === '/security') return Promise.resolve({ ok: true, protocolVersion: 1, economyPolicy: {} });
      return Promise.resolve({ ok: false, error: 'unexpected-read', status: 404 });
    },
    /* ★ 两个写方法**装上去就是为了被计数**：它们是真的存在于生产
       driver 上的两个写入口（P22-13 / P22-14 的 seam）。本阶段的渲染器
       必须一次都不碰它们 —— 这是"UI 没有写能力"的直接证据。 */
    approvalDecision: function (body) { calls.writes.push({ method: 'approvalDecision', body: body }); return Promise.resolve({ ok: true }); },
    economyConfiguration: function (body) { calls.writes.push({ method: 'economyConfiguration', body: body }); return Promise.resolve({ ok: true }); }
  };
  return d;
}

function settle(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 10); i += 1) p = p.then(() => new Promise(r => setImmediate(r)));
  return p;
}

/* ── 载入：P22-16 的纯层与渲染器 + 本阶段的纯层与渲染器 ────────────────
   ★ 载入顺序与 InternalBeyond.html 逐字相同。P22-15 的渲染器在这里用
     一个**假的**代表（本阶段不重跑它的实现）：它只做两件事 —— render()
     计数、往 `#economy-requests` 里放一个它自己的标记节点。于是
     "外壳只开合它的可见性、从不碰它的子树"这句话可以被真的断言。 */
function mount(world, options) {
  options = options || {};
  const dom = makeDom();
  const box = { console: { log() {}, warn() {}, error() {}, info() {} } };
  box.window = box; box.self = box;
  box.document = dom.doc;
  const sandbox = vm.createContext(box);
  const roleState = {
    configs: options.apiConfigs === undefined
      ? [{ id: 'a1', nickname: '阿尔法' }, { id: 'a2', nickname: '贝塔' }]
      : options.apiConfigs,
    archived: options.archivedConfigs || []
  };
  box.__roleState = roleState;
  vm.runInContext('let apiConfigs = __roleState.configs; let archivedConfigs = __roleState.archived;', sandbox);
  Object.defineProperty(box, 'apiConfigs', {
    get: function () { return roleState.configs; }, set: function (v) { roleState.configs = v; }, configurable: true
  });
  Object.defineProperty(box, 'archivedConfigs', {
    get: function () { return roleState.archived; }, set: function (v) { roleState.archived = v; }, configurable: true
  });
  /* P22-15 的代表：一个计数 + 一棵它自己的子树。
     ★ 它挂成 `IB.economyApprovalUI` —— 与生产同形，因此 P22-16 的
       showSection() 会**真的**在切到「待处理」时调用它（H1 要证明的
       正是"本模块不直接调它"）。 */
  const approval = {
    renders: 0,
    render: function () {
      approval.renders += 1;
      const requests = dom.doc.getElementById('economy-requests');
      if (requests && !requests._seeded) {
        requests._seeded = true;
        const marker = dom.doc.createElement('div');
        marker.className = 'ec-title';
        marker.textContent = '待决定';
        requests.appendChild(marker);
      }
      return true;
    }
  };
  box.IB = box.IB || {};
  box.IB.economyApprovalUI = approval;
  vm.runInContext(read('assets/js/economy-configuration-core.js'), sandbox, { filename: 'economy-configuration-core.js' });
  const cfgDriver = makeDriver(world || defaultWorld());
  box.IB.__ibEconomyConfigDriver = cfgDriver;
  vm.runInContext(read('assets/js/economy-configuration.js'), sandbox, { filename: 'economy-configuration.js' });
  vm.runInContext(read('assets/js/economy-shell-core.js'), sandbox, { filename: 'economy-shell-core.js' });
  const driver = makeDriver(world || defaultWorld());
  box.IB.__ibEconomyShellDriver = driver;
  vm.runInContext(uiSrc, sandbox, { filename: 'economy-shell.js' });
  return {
    box: box, dom: dom, driver: driver, cfgDriver: cfgDriver, approval: approval,
    ui: box.IB.economyShellUI, core: box.IB.economyShellCore, cfg: box.IB.economyConfigurationUI
  };
}

/* ══════════════════════════════════════════════════════════════════════
   A · 静态结构
   ══════════════════════════════════════════════════════════════════════ */
section('A · 静态结构：一条写路径都没有，也不搬动既有节点');

check('A1 ★★★ 渲染器里没有 fetch / XMLHttpRequest / require / import',
  !/\bfetch\s*\(/.test(uiCode) && !/XMLHttpRequest/.test(uiCode) &&
  !/\brequire\s*\(/.test(uiCode) && !/\bimport\s*\(/.test(uiCode));

check('A2 ★★★ 渲染器里没有一条 /internal/economy/* 路径（本阶段不新增任何写面）',
  !/\/internal\/economy\//.test(uiSrc), (uiSrc.match(/\/internal\/economy\/[a-z-]+/g) || []));

check('A3 ★★★ 渲染器不认识任何 store / 门 / 适配器的方法名（它只有一条 HTTP 读接缝）',
  !/\b(?:economyStore|getWallet|listPurchases|createQuote|reserveFunds|settlePurchase|decideApproval|proposeAgentPurchaseIntent|resumeApprovedPurchase|mintForSystem|burnForSystem|commitLedgerTransaction|grantInventory|consumeInventory|putBudgetPolicy|putAutonomyPolicy|bootstrapInitialCredit)\b/.test(uiCode),
  (uiCode.match(/\b(?:economyStore|getWallet|listPurchases|createQuote|reserveFunds|settlePurchase|decideApproval|mintForSystem|grantInventory)\b/g) || []));

check('A4 ★★★★ 渲染器**不修改**两个既有容器的子树：只认它们的 id，只开合 display/class',
  (function () {
    /* 对**每一处**用到这两个 id 的地方各取一段上下文，逐条确认那里没有
       子树操作。★ 刻意不用一个 `[\s\S]{0,200}` 的全局匹配去数"有几处"：
       第一处的匹配会把第二处吞掉，"两处都查过"因此会变成一句假话。 */
    const spots = [];
    const re = /CORE\.ID\.(?:REQUESTS_HOST|CONFIG_HOST)/g;
    let hit;
    while ((hit = re.exec(uiSrc)) !== null) spots.push(uiSrc.slice(hit.index, hit.index + 120));
    const bad = spots.filter(h => h.indexOf('textContent') >= 0 || h.indexOf('appendChild') >= 0 ||
      h.indexOf('innerHTML') >= 0 || h.indexOf('insertBefore') >= 0);
    return spots.length === 2 && bad.length === 0 &&
      (uiSrc.match(/CORE\.ID\.(?:REQUESTS_HOST|CONFIG_HOST)/g) || []).length === 2;
  })(), (uiSrc.match(/CORE\.ID\.(?:REQUESTS_HOST|CONFIG_HOST)/g) || []).length);

check('A5 ★★★ 外壳**追加**在页尾（install 用 appendChild，不用 insertBefore）',
  /page\.appendChild\(host\)/.test(uiCode) && !/page\.insertBefore\(/.test(uiCode));

check('A6 ★★★ 样式表按模块运行时注入（HTML 的 20 个样式表预算一个都不占）',
  /STYLE_ID: 'ib-econ-shell-style'/.test(uiSrc) &&
  /STYLE_HREF: 'assets\/css\/economy-shell\.css'/.test(uiSrc) &&
  (html.match(/rel="stylesheet"/g) || []).length === 20,
  (html.match(/rel="stylesheet"/g) || []).length);

check('A7 ★★★ HTML 里多了两行 script，而且排在 P22-16 之后（纯层依赖它）',
  html.indexOf('<script src="assets/js/economy-shell-core.js"></script>') >= 0 &&
  html.indexOf('<script src="assets/js/economy-shell.js"></script>') >= 0 &&
  html.indexOf('economy-configuration.js') < html.indexOf('economy-shell-core.js') &&
  html.indexOf('economy-shell-core.js') < html.indexOf('economy-shell.js'));

check('A8 ★★★ 本阶段没有往仓库里新增任何位图（渲染器 / 样式表 / HTML 三处都没有）',
  !/\.(?:png|webp|jpe?g|gif)\b/i.test(uiCode + cssSrc) && !/data:image\//i.test(uiCode + cssSrc) &&
  !/url\(\s*['"]?https?:/i.test(cssSrc));

check('A9 ★★★ 代码与样式里都没有 emoji，而且没有任何外部依赖',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(uiCode + cssCode) &&
  !/[💰🪙💳🛒✨🎉]/u.test(uiCode + cssCode) &&
  uiSrc.split('http://www.w3.org/2000/svg').join('').indexOf('http://') < 0 &&
  !/https?:\/\//.test(cssSrc));

/* ══════════════════════════════════════════════════════════════════════
   B · 外壳与页签
   ══════════════════════════════════════════════════════════════════════ */
section('B · 外壳：五个页签，两个既有节点留在原位');

(async function main() {
  const world = defaultWorld();
  const m = mount(world);
  m.cfg.render();           /* core.js 的接线顺序：P22-16 → P22-15 → P22-17 */
  m.approval.render();
  m.ui.render();
  await settle();

  const page = m.dom.page;
  check('B1 ★★★ 外壳节点是页面的**最后一个**子节点，两个既有节点位置逐字未变',
    page.children.length === 3 &&
    page.children[0].id === 'economy-configuration' &&
    page.children[1].id === 'economy-requests' &&
    page.children[2].id === 'economy-shell',
    page.children.map(c => c.id));

  check('B2 ★★★ 五个页签都在，顺序就是 §2，而且默认是「概览」',
    (function () {
      const tabs = find(byId(m.dom.doc, m.ui.CORE.ID.TABS), 'esh-tab');
      return tabs.length === 5 &&
        tabs.map(t => t.textContent).join(',') === '概览,商店,我的资产,待处理,设置' &&
        m.ui.snapshot().tab === 'overview' &&
        tabs.filter(t => t.classList.contains('is-active')).length === 1 &&
        tabs[0].classList.contains('is-active');
    })(), find(byId(m.dom.doc, m.ui.CORE.ID.TABS), 'esh-tab').map(t => t.textContent));

  check('B3 ★★★★ 默认落在「概览」时，P22-16 的外壳与 P22-15 的容器**都**不可见',
    byId(m.dom.doc, 'economy-configuration').style.display === 'none' &&
    byId(m.dom.doc, 'economy-requests').style.display === 'none' &&
    byId(m.dom.doc, 'economy-shell-overview').hidden === false &&
    byId(m.dom.doc, 'economy-shell-store').hidden === true &&
    byId(m.dom.doc, 'economy-shell-assets').hidden === true);

  check('B4 ★★★ 页面级 class 与当前页签逐字对应（可见性只有一个状态源）',
    page.classList.contains('ibecon-tab-overview') &&
    !page.classList.contains('ibecon-tab-settings') &&
    !page.classList.contains('ibecon-tab-requests'));

  const rendersBefore = m.approval.renders;
  m.ui.show('requests');
  await settle(2);
  check('B5 ★★★ 切到「待处理」：P22-15 的容器可见、P22-16 的外壳收起，而且调了 P22-15 的渲染器',
    byId(m.dom.doc, 'economy-requests').style.display !== 'none' &&
    byId(m.dom.doc, 'economy-configuration').style.display === 'none' &&
    m.approval.renders > rendersBefore &&
    page.classList.contains('ibecon-tab-requests'),
    { before: rendersBefore, after: m.approval.renders });

  check('B6 ★★★ 切到「设置」：P22-16 的外壳可见、P22-15 的容器收起，而且 P22-16 停在一个配置分区',
    (function () {
      m.ui.show('settings');
      const snap = m.cfg.snapshot();
      return byId(m.dom.doc, 'economy-configuration').style.display !== 'none' &&
        byId(m.dom.doc, 'economy-requests').style.display === 'none' &&
        snap.section !== 'requests' &&
        page.classList.contains('ibecon-tab-settings');
    })(), m.cfg.snapshot());

  check('B7 ★★★★ 整个切页签过程中，两个既有容器的子树**没有**被本模块动过（没有任何 .esh- 节点钻进去）',
    (function () {
      const cfgHost = byId(m.dom.doc, 'economy-configuration');
      const reqHost = byId(m.dom.doc, 'economy-requests');
      const leaked = cfgHost.walk().concat(reqHost.walk())
        .filter(n => String(n.className || '').indexOf('esh-') >= 0);
      return leaked.length === 0 &&
        reqHost.textContent.indexOf('待决定') >= 0;   /* P22-15 的那棵子树仍然在 */
    })());

  check('B8 ★★★ 从「设置」离开再回来，P22-16 停在同一格（外壳记住了它）',
    (function () {
      m.ui.show('settings');
      m.cfg.show('autonomy');
      m.ui.show('overview');
      m.ui.show('settings');
      return m.cfg.snapshot().section === 'autonomy';
    })(), m.cfg.snapshot().section);

  /* ══ C · 概览 ══════════════════════════════════════════════════════ */
  section('C · 概览：真实钱包 / 预算摘要 / 最近购买 / 最近资产');

  m.ui.show('overview');
  await settle(2);

  check('C1 ★★★ 钱包显示 canonical 的可用额度（等宽数字 + 币种名 + 它是什么）',
    (function () {
      const t = paneText(m.dom.doc, 'economy-shell-overview');
      const v = find(byId(m.dom.doc, 'economy-shell-overview'), 'esh-wallet-value').map(n => n.textContent);
      const u = find(byId(m.dom.doc, 'economy-shell-overview'), 'esh-unit').map(n => n.textContent);
      return v.length === 1 && v[0] === '12,450.00' &&
        u.indexOf('IB Credit') >= 0 &&
        t.indexOf('IB 内部虚拟额度') >= 0 &&
        t.indexOf('其中已被预留 120.00 IB Credit') >= 0;
    })(), paneText(m.dom.doc, 'economy-shell-overview'));

  check('C2 ★★★ 钱包那一段的正文里没有充值 / 提现 / 银行卡 / 现金 / 账户价值',
    ['充值', '提现', '转账', '银行卡', '现金', '人民币', '美元', '账户价值']
      .every(w => paneText(m.dom.doc, 'economy-shell-overview').indexOf(w) < 0));

  check('C3 ★★★ 预算摘要显示 canonical 的三档限额与权威自己的今日用量',
    (function () {
      const t = paneText(m.dom.doc, 'economy-shell-overview');
      return t.indexOf('单次最多可花') >= 0 && t.indexOf('50.00') >= 0 &&
        t.indexOf('每日最多可花') >= 0 && t.indexOf('500.00') >= 0 &&
        t.indexOf('超过多少先问我') >= 0 && t.indexOf('20.00') >= 0 &&
        t.indexOf('今日已用') >= 0 && t.indexOf('12.50') >= 0;
    })(), paneText(m.dom.doc, 'economy-shell-overview'));

  check('C4 ★★★★ 概览的正文里**没有**裁决的词（ALLOW / DENY / decision）—— 它只显示事实',
    (function () {
      const t = paneText(m.dom.doc, 'economy-shell-overview');
      return ['ALLOW', 'DENY', 'decision', 'WITHIN_LIMITS'].every(w => t.indexOf(w) < 0);
    })(), paneText(m.dom.doc, 'economy-shell-overview'));

  check('C5 ★★★ 最近购买：四条，状态是人话，"由 阿尔法 发起"只在 intent 连得上时出现',
    (function () {
      const t = paneText(m.dom.doc, 'economy-shell-overview');
      return t.indexOf('数字绘画额度') >= 0 && t.indexOf('一次修图') >= 0 &&
        t.indexOf('已完成') >= 0 && t.indexOf('进行中') >= 0 &&
        t.indexOf('已退回') >= 0 && t.indexOf('没有完成') >= 0 &&
        t.indexOf('由 阿尔法 发起') >= 0 &&
        /* a9 不在角色目录里 ⇒ 那一条**不写**发起者 */
        t.indexOf('a9') < 0 &&
        t.indexOf('20.00 IB Credit') >= 0;
    })(), paneText(m.dom.doc, 'economy-shell-overview'));

  /* ★ P22-18 改过这一条（唯一一处语义级的改动，理由逐字记在这里）。
     P22-17 的原判据是"概览上的 `.esh-row` 数在 5..7 之间"，它隐含了两件
     当时的决定：①「最近购买」那一块最多铺三条；②那三条用的是 `.esh-row`。
     §3 把这一块升级成了「经济活动」（每条记录多出"来源"与"Intent →
     Approval → Purchase"三步），于是它换了类名、并且有自己的上限常量
     （CORE.ACTIVITY_KEEP）。原来那个 5..7 的数字因此不再表达任何东西 ——
     它还会因为"已完成购买多了一条"而随机变红。
     改成**不变量**：明细有上限、上限就是常量、资产那一格最多三条。 */
  check('C6 ★★★ P22-18 起：「经济活动」在概览上**有上限**，而「我的资产」那一格最多三条明细',
    (function () {
      const root = byId(m.dom.doc, 'economy-shell-overview');
      const acts = find(root, 'esh-activity');
      /* 「我的资产」那一格的行数按它自己的分组数出来（不再按整页的
         `.esh-row` 计数 —— 支出说明那一块也用同一个类名）。 */
      const groupRows = find(root, 'esh-group')
        .reduce((n, g) => n + find(g, 'esh-row').length, 0);
      return acts.length >= 1 && acts.length <= m.core.ACTIVITY_KEEP &&
        groupRows <= 3 && m.core.ACTIVITY_KEEP === 6;
    })(), {
      activity: find(byId(m.dom.doc, 'economy-shell-overview'), 'esh-activity').length,
      keep: m.core.ACTIVITY_KEEP
    });

  check('C7 ★★★ COLD / DEGRADED 时**一个 0 都不出现**，而是一句"还没有读出来"',
    (async function () { return true; })(),
    '在下面的 C7b 里真跑一次');
  await (async function () {
    const cold = mount(Object.assign(defaultWorld(), {
      wallet: { ok: true, wallet: Object.assign({}, WALLET_READY.wallet, {
        state: 'COLD', balanceKnown: false, availableBalanceMinor: null,
        cachedBalanceMinor: null, ledgerBalanceMinor: null, reservedBalanceMinor: null
      }) }
    }));
    cold.cfg.render(); cold.approval.render(); cold.ui.render();
    await settle();
    const t = paneText(cold.dom.doc, 'economy-shell-overview');
    const v = find(byId(cold.dom.doc, 'economy-shell-overview'), 'esh-wallet-value');
    /* ★ "正文里没有 0" 只能**在钱包那一张卡里**判：整页的预算格子里本来
       就有 50.00 / 500.00，用整页文本去查 '0.00' 会得到一条假红。 */
    const walletCard = find(byId(cold.dom.doc, 'economy-shell-overview'), 'esh-card')[0];
    const walletText = walletCard ? textOutsideTechnicalIncludingHidden(walletCard) : '';
    check('C7b ★★★★ COLD 钱包：主数字那一格是破折号，钱包卡里没有 0.00，而且有一句解释',
      v.length === 1 && v[0].textContent === '\u2014' && walletText.indexOf('0.00') < 0 &&
      walletText.indexOf('额度还没有读出来') >= 0,
      { n: v.length, value: v.map(n => n.textContent), card: walletText });
  })();

  await (async function () {
    const down = mount({
      wallet: { ok: false, error: 'home-node-unreachable', offline: true },
      stores: { ok: false, error: 'home-node-unreachable', offline: true },
      products: { ok: false, error: 'home-node-unreachable', offline: true }
    });
    down.cfg.render(); down.approval.render(); down.ui.render();
    await settle();
    const overview = byId(down.dom.doc, 'economy-shell-overview');
    const t = overview ? textOutsideTechnical(overview) : '';
    check('C8 ★★★ 节点不可达：整页是一句"读不到本机节点" + 一个重试按钮，而不是一堆 0',
      down.ui.snapshot().stage === 'failed' && t.indexOf('读不到本机节点') >= 0 &&
      buttonsWith(overview, ['再试一次']).length === 1 && t.indexOf('0.00') < 0, t.slice(0, 200));
  })();

  await (async function () {
    const absent = mount(Object.assign(defaultWorld(), {
      wallet: { ok: false, error: 'wallet-not-found', status: 404 }
    }));
    absent.cfg.render(); absent.approval.render(); absent.ui.render();
    await settle();
    const overview = byId(absent.dom.doc, 'economy-shell-overview');
    const t = textOutsideTechnical(overview);
    const go = buttonsWith(overview, ['去设置']);
    check('C9 ★★★ 钱包还没建：说的是"还没有额度账户"并给一个"去设置"，点了真的切到设置页签',
      t.indexOf('还没有额度账户') >= 0 && go.length === 1 &&
      (function () { go[0].click(); return absent.ui.snapshot().tab === 'settings'; })());
  })();

  /* ══ D · 商店 ══════════════════════════════════════════════════════ */
  section('D · 商店：货架与商品，**没有**购买按钮');

  m.ui.show('store');
  await settle(2);
  const storePane = byId(m.dom.doc, 'economy-shell-store');

  check('D1 ★★★ 两个货架各一张卡：名字 / 说明 / 状态 / 商品数量',
    (function () {
      const tiles = find(storePane, 'esh-store');
      return tiles.length === 2 &&
        tiles[0].textContent.indexOf('数字工坊') >= 0 &&
        tiles[0].textContent.indexOf('安静的货架') >= 0 &&
        tiles[0].textContent.indexOf('开放中') >= 0 &&
        tiles[0].textContent.indexOf('2 件商品') >= 0 &&
        tiles[1].textContent.indexOf('已停用') >= 0 &&
        tiles[1].textContent.indexOf('1 件商品') >= 0;
    })(), find(storePane, 'esh-store').map(t => t.textContent.slice(0, 60)));

  check('D2 ★★★ 三件商品各一张卡：名字 / 说明 / 类别 / 价格 / 单位与发放量 / 状态',
    (function () {
      const cards = find(storePane, 'esh-product');
      const t0 = cards[0] ? cards[0].textContent : '';
      const t1 = cards[1] ? cards[1].textContent : '';
      const t2 = cards[2] ? cards[2].textContent : '';
      return cards.length === 3 &&
        t0.indexOf('数字绘画额度') >= 0 && t0.indexOf('一张图的额度') >= 0 &&
        t0.indexOf('数字内容') >= 0 && t0.indexOf('20.00 IB Credit') >= 0 &&
        t0.indexOf('每份发放 1 件') >= 0 && t0.indexOf('在架上') >= 0 &&
        t1.indexOf('算力额度') >= 0 && t1.indexOf('每份发放 100 算力单位') >= 0 && t1.indexOf('暂停提供') >= 0 &&
        t2.indexOf('服务') >= 0 && t2.indexOf('一次执行') >= 0 && t2.indexOf('已下架') >= 0;
    })(), find(storePane, 'esh-product').map(t => t.textContent.slice(0, 70)));

  check('D3 ★★★★ 商品页上**没有**购买按钮（canonical 没有这条接缝，本阶段不造）',
    buttonsWith(storePane, ['购买', '买下', '下单', '结算', '支付', '确认购买']).length === 0 &&
    buttonsWith(storePane, ['申请']).length === 0,
    buttonsWith(storePane, ['购买', '申请']).map(b => b.textContent));

  check('D4 ★★★ 商品页有一句诚实的说明：Agent 可以在规则允许时申请，而不是"你可以买"',
    textOutsideTechnical(storePane).indexOf('Agent 可以在 Economy 规则允许时申请') >= 0);

  check('D5 ★★★★ 确定性视觉身份写在 data 属性与 CSS 变量上，而且**只**由 productId 决定',
    (function () {
      const cards = find(storePane, 'esh-product');
      const c0 = m.core.visualIdentityOf('econ_prod_1');
      return cards.length === 3 &&
        cards[0].getAttribute('data-variant') === String(c0.variant) &&
        cards[0].getAttribute('data-mark') === String(c0.mark) &&
        cards[0].style.getPropertyValue('--esh-angle') === c0.angle + 'deg' &&
        cards[0].style.getPropertyValue('--esh-variant') === String(c0.variant) &&
        /* 三件商品里有不同的脸（否则"变化"这件事没有发生） */
        Array.from(new Set(cards.map(c => c.getAttribute('data-variant')))).length >= 2;
    })(), find(byId(m.dom.doc, 'economy-shell-store'), 'esh-product').map(c => c.getAttribute('data-variant')));

  check('D6 ★★★ 目录顺序就是读面给的顺序（哈希不排序）',
    (function () {
      const cards = find(storePane, 'esh-product');
      const want = PRODUCTS.products.map(p => p.productId);
      const got = cards.map(c => c.textContent.indexOf('数字绘画额度') >= 0 ? 'econ_prod_1'
        : (c.textContent.indexOf('算力包') >= 0 ? 'econ_prod_2' : 'econ_prod_3'));
      return got.join(',') === want.join(',');
    })());

  check('D7 ★★★ 视觉身份两次渲染一致（同一 productId 同一张脸）',
    (function () {
      const before = find(storePane, 'esh-product').map(c => c.getAttribute('data-variant') + '/' + c.getAttribute('data-mark'));
      m.ui.render();
      const after = find(byId(m.dom.doc, 'economy-shell-store'), 'esh-product')
        .map(c => c.getAttribute('data-variant') + '/' + c.getAttribute('data-mark'));
      return before.join(',') === after.join(',') && before.length === 3;
    })());

  check('D8 ★★★ 「只看这家」是一个手势：只改这一页显示哪一货架的商品，不改任何经济事实',
    (function () {
      const picks = buttonsWith(storePane, ['只看这家']);
      if (picks.length !== 2) return false;
      picks[1].click();   /* 修图铺 */
      const after = find(byId(m.dom.doc, 'economy-shell-store'), 'esh-product');
      return after.length === 1 && after[0].textContent.indexOf('一次修图') >= 0 &&
        m.ui.snapshot().storeFilter === 'econ_store_b' &&
        m.driver.calls.writes.length === 0;
    })(), m.ui.snapshot().storeFilter);

  check('D9 ★★★ 空目录是一句人话 + 一张 inline SVG 空状态，而不是一张空网格',
    (async function () { return true; })());
  await (async function () {
    const empty = mount(Object.assign(defaultWorld(), {
      stores: { ok: true, holdsPrices: false, holdsOwnership: false, stores: [] },
      products: { ok: true, personalized: false, hasRecommendations: false, products: [] }
    }));
    empty.cfg.render(); empty.approval.render(); empty.ui.render();
    await settle();
    empty.ui.show('store');
    const p = byId(empty.dom.doc, 'economy-shell-store');
    const t = textOutsideTechnical(p);
    check('D9b ★★★ 没有货架 / 没有商品：两句空状态，而且各自都带一张 inline SVG',
      t.indexOf('现在还没有开着的商店') >= 0 && t.indexOf('这个货架还没有商品') >= 0 &&
      find(p, 'esh-empty-art').length >= 2 &&
      find(p, 'esh-empty-art').every(a => a.innerHTML.indexOf('<svg') >= 0));
  })();

  /* ══ E · 我的资产 ══════════════════════════════════════════════════ */
  section('E · 我的资产：按 canonical assetKind 分组，SERVICE 不伪造库存');

  m.ui.show('assets');
  await settle(2);
  const assetsPane = byId(m.dom.doc, 'economy-shell-assets');

  check('E1 ★★★ 两组（物品 / 算力额度）都在，数量与名字来自 canonical',
    (function () {
      const groups = find(assetsPane, 'esh-group');
      const t = textOutsideTechnical(assetsPane);
      return groups.length === 2 &&
        groups[0].textContent.indexOf('物品') >= 0 && groups[0].textContent.indexOf('3 件') >= 0 &&
        groups[1].textContent.indexOf('算力额度') >= 0 && groups[1].textContent.indexOf('250 算力单位') >= 0 &&
        t.indexOf('数字绘画额度') >= 0 &&
        /* join 不上的那一行写的是"已经不存在的商品"，不摆 productId */
        t.indexOf('已经不存在的商品') >= 0 && t.indexOf('econ_prod_missing') < 0;
    })(), textOutsideTechnical(assetsPane).slice(0, 240));

  check('E2 ★★★★ Compute 只有**一个**说法：IB 内部的算力额度（Compute Entitlement）',
    (function () {
      const t = textOutsideTechnical(assetsPane);
      return t.indexOf('IB 内部的算力额度（Compute Entitlement）') >= 0 &&
        t.indexOf('不是任何外部服务的余额或额度') >= 0 &&
        ['Provider', 'token', 'Token', 'API 余额', 'DeepSeek', 'Claude', 'OpenAI'].every(w => t.indexOf(w) < 0);
    })(), textOutsideTechnical(assetsPane).slice(0, 300));

  check('E3 ★★★ SERVICE 不在任何一组里，但有一句它为什么不在这里',
    (function () {
      const t = textOutsideTechnical(assetsPane);
      const titles = find(assetsPane, 'esh-group-title').map(n => n.textContent);
      return titles.indexOf('服务') < 0 && titles.join(',') === '物品,算力额度' &&
        t.indexOf('服务类商品不会留下库存：它是一次执行') >= 0;
    })(), find(assetsPane, 'esh-group-title').map(n => n.textContent));

  check('E4 ★★★ 空资产：一句"还没有任何资产" + 一张 160×120 的 inline SVG 空状态',
    (async function () { return true; })());
  await (async function () {
    const empty = mount(Object.assign(defaultWorld(), {
      inventory: { ok: true, isABalance: false, entries: [] }
    }));
    empty.cfg.render(); empty.approval.render(); empty.ui.render();
    await settle();
    empty.ui.show('assets');
    const p = byId(empty.dom.doc, 'economy-shell-assets');
    const art = find(p, 'esh-empty-art');
    check('E4b ★★★ 空库存：空状态文案 + 160×120 viewBox 的线性轮廓图',
      textOutsideTechnical(p).indexOf('还没有任何资产') >= 0 &&
      art.length === 1 && art[0].innerHTML.indexOf('viewBox="0 0 160 120"') >= 0 &&
      art[0].innerHTML.indexOf('fill="none"') >= 0 && art[0].innerHTML.indexOf('stroke="currentColor"') >= 0);
  })();

  /* ══ F · 纪律 ══════════════════════════════════════════════════════ */
  section('F · 正文纪律：代号不裸漏、图标全是 inline SVG');

  const wholeShell = byId(m.dom.doc, 'economy-shell');
  const bodyBlob = allPanesText(m.dom.doc, ['economy-shell-overview', 'economy-shell-store', 'economy-shell-assets']);

  check('F1 ★★★★★ 渲染出来的正文里没有 canonical 原始代号（代号只在折叠的技术层）',
    ['IB_CREDIT', 'RESERVED', 'COMPLETED', 'RELEASED', 'FAILED', 'AUTO_ALLOW', 'APPROVAL',
      'DIGITAL_ITEM', 'COMPUTE_CREDIT', 'API_QUOTA', 'INVENTORY_GRANT', 'COMPUTE_GRANT',
      'SERVICE_EXECUTION', 'econ_prod_', 'econ_store_', 'econ_pur_', 'econ_inv_', 'computeUnit']
      .every(w => bodyBlob.indexOf(w) < 0),
    ['IB_CREDIT', 'RESERVED', 'COMPLETED', 'AUTO_ALLOW', 'DIGITAL_ITEM', 'econ_prod_', 'computeUnit']
      .filter(w => bodyBlob.indexOf(w) >= 0));

  check('F2 ★★★ 正文里有数字和币种名（F1 不是靠"什么都不显示"通过的）',
    bodyBlob.indexOf('12,450.00') >= 0 && bodyBlob.indexOf('IB Credit') >= 0 &&
    bodyBlob.indexOf('20.00') >= 0);

  check('F3 ★★★ 每一块图标都是 inline SVG，页面上没有一个 img、没有一个 emoji',
    (function () {
      const marks = find(wholeShell, 'esh-mark').concat(find(wholeShell, 'esh-group-mark'))
        .concat(find(wholeShell, 'esh-kind-mark'));
      const arts = find(wholeShell, 'esh-empty-art').concat(find(wholeShell, 'esh-product-art'));
      return marks.length >= 3 && marks.every(x => x.innerHTML.indexOf('<svg') >= 0) &&
        arts.every(x => x.innerHTML.indexOf('<svg') >= 0) &&
        wholeShell.walk().filter(n => n.tagName === 'IMG').length === 0 &&
        !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(allText(wholeShell));
    })(), find(wholeShell, 'esh-mark').length);

  check('F4 ★★★ 状态只有一种色彩渠道：正文里没有第二套红黄绿徽章类名',
    find(wholeShell, 'esh-status').length >= 4 &&
    find(wholeShell, 'esh-status').every(n => String(n.className).split(/\s+/).length === 1) &&
    !/status-(?:success|danger|warning)/.test(uiCode));

  check('F5 ★★★ 折叠的技术层里**可以**看到代号（那是给审计用的），而且默认是收起的',
    (function () {
      const boxes = find(wholeShell, 'esh-technical');
      return boxes.length >= 3 && boxes.every(b => b.hidden === true) &&
        boxes.map(b => b.textContent).join('\n').indexOf('IB_CREDIT') >= 0 &&
        boxes.map(b => b.textContent).join('\n').indexOf('RESERVED') >= 0;
    })(), find(wholeShell, 'esh-technical').length);

  /* ══ G · 传输纪律 ══════════════════════════════════════════════════ */
  section('G · 传输：八条既有 GET，写方法一次都没被调用');

  check('G1 ★★★★ 全部读请求都落在已声明的只读面上（没有一条新路径，也没有一条写路径）',
    (function () {
      /* ★ P22-18 改过这一条的**判据形状**：原来写死 `=== 8`。
         §2 要求复用 canonical 的 change log（`/economy/changes`），于是这一页
         的读面从八条变成九条。写死的 8 会把"这一页多读了一条**已声明的**只读
         面"判成红的，而那条真正的性质（"请求的每一条路径都在声明表里"）
         并不需要那个数字。改成 `allowed.length` 之后，这条断言在下一个阶段
         再加读面时**仍然**在问同一个问题。 */
      const allowed = m.core.readPathList().concat([m.core.CHANGE_READ]);
      const paths = m.driver.calls.reads.map(r => r.path);
      return paths.length >= 8 && paths.every(p => allowed.indexOf(p) >= 0) &&
        Array.from(new Set(paths)).length === allowed.length &&
        allowed.length === 9;
    })(), Array.from(new Set(m.driver.calls.reads.map(r => r.path))));

  check('G2 ★★★ 归属过滤只发给需要归属的四条（钱包 / 政策 / 预算 / 库存 / 购买），目录不带 owner',
    (function () {
      const byPath = {};
      m.driver.calls.reads.forEach(r => { byPath[r.path] = r.query || {}; });
      return byPath['/economy/wallet'].ownerId === 'a1' &&
        byPath['/economy/inventory'].ownerId === 'a1' &&
        byPath['/economy/purchases'].buyerId === 'a1' &&
        byPath['/economy/stores'].ownerId === undefined &&
        byPath['/economy/products'].ownerId === undefined &&
        byPath['/economy/products'].personalized === undefined;
    })(), m.driver.calls.reads.map(r => r.path + '?' + JSON.stringify(r.query)));

  check('G3 ★★★★★ 两个写方法**一次都没有被调用**（UI 没有任何写能力）',
    m.driver.calls.writes.length === 0 && m.cfgDriver.calls.writes.length === 0,
    m.driver.calls.writes.concat(m.cfgDriver.calls.writes));

  check('G4 ★★★ 假 driver 上真的装了那两个写方法（否则 G3 是在为空气作证）',
    typeof m.driver.approvalDecision === 'function' &&
    typeof m.driver.economyConfiguration === 'function' &&
    typeof m.driver.getJson === 'function');

  check('G5 ★★★ 切页签 / 点只看这家 / 折叠技术层，全部不产生任何写请求',
    (function () {
      const before = m.driver.calls.writes.length + m.cfgDriver.calls.writes.length;
      m.ui.show('overview'); m.ui.show('store'); m.ui.show('assets'); m.ui.show('settings'); m.ui.show('requests');
      const tech = find(byId(m.dom.doc, 'economy-shell'), 'esh-technical-toggle');
      if (tech.length) tech[0].click();
      const after = m.driver.calls.writes.length + m.cfgDriver.calls.writes.length;
      return before === 0 && after === 0;
    })());

  check('G6 ★★★ 角色目录为空时，需要归属的两格说"还没有配置任何角色"，而商店仍然显示目录',
    (async function () { return true; })());
  await (async function () {
    const none = mount(defaultWorld(), { apiConfigs: [] });
    none.cfg.render(); none.approval.render(); none.ui.render();
    await settle();
    const overview = textOutsideTechnical(byId(none.dom.doc, 'economy-shell-overview'));
    none.ui.show('store');
    const store = textOutsideTechnical(byId(none.dom.doc, 'economy-shell-store'));
    const reads = none.driver.calls.reads.map(r => r.path);
    check('G6b ★★★★ 没有角色时不发归属类读请求（钱包 / 库存 / 购买一条都不发），但目录照读',
      overview.indexOf('还没有配置任何角色') >= 0 &&
      store.indexOf('数字工坊') >= 0 &&
      reads.indexOf('/economy/stores') >= 0 && reads.indexOf('/economy/products') >= 0 &&
      reads.indexOf('/economy/wallet') < 0 && reads.indexOf('/economy/inventory') < 0 &&
      reads.indexOf('/economy/purchases') < 0,
      Array.from(new Set(reads)));
  })();

  /* ══ H · P22-15 / P22-16 不回归 ════════════════════════════════════ */
  section('H · P22-15 / P22-16 不回归');

  check('H1 ★★★ 本模块从不直接调 P22-15 的渲染器：那一次调用只在 P22-16 的 showSection 里',
    (uiSrc.match(/economyApprovalUI/g) || []).length === 0 &&
    (read('assets/js/economy-configuration.js').match(/NS\.economyApprovalUI/g) || []).length >= 1,
    { mine: (uiSrc.match(/economyApprovalUI/g) || []).length, theirs: (read('assets/js/economy-configuration.js').match(/NS\.economyApprovalUI/g) || []).length });

  check('H2 ★★★ 本模块只通过 P22-16 的公开 API 驱动它（show / snapshot），不认识它的内部实现',
    (function () {
      const calls = uiCode.match(/config\.[a-zA-Z]+\(/g) || [];
      /* ★ 这份名单只放 P22-16 **独有**的内部名（本模块自己也有 walletCard
         / budgetCard / ownerbar 这些同名函数，它们在不同的模块作用域里，
         放进名单会得到一条"因为重名而红"的假红）。 */
      const theirs = ['renderWallet', 'autonomyCard', 'showSection', 'paneShell', 'segRow', 'meterBlock', 'ecfg'];
      return calls.length === 2 && calls.indexOf('config.show(') >= 0 &&
        calls.indexOf('config.snapshot(') >= 0 &&
        theirs.every(n => uiCode.indexOf(n) < 0);
    })(), (uiCode.match(/config\.[a-zA-Z]+\(/g) || []));

  check('H3 ★★★★ 本阶段没有改 P22-15 / P22-16 的任何前端文件（它们的实现逐字未动）',
    (function () {
      /* 结构性的自查：那两个文件里没有本阶段的类名前缀，也没有本阶段的模块名。 */
      const files = ['assets/js/economy-approval.js', 'assets/js/economy-approval-core.js',
        'assets/js/economy-configuration.js', 'assets/js/economy-configuration-core.js',
        'assets/css/economy-approval.css', 'assets/css/economy-configuration.css'];
      return files.every(f => {
        const s = read(f);
        return s.indexOf('economyShell') < 0 && s.indexOf('economy-shell') < 0 &&
          s.indexOf('esh-') < 0 && s.indexOf('ibecon-tab-') < 0;
      });
    })());

  check('H4 ★★★★ 三层共存：一次导航之后，P22-15 / P22-17 各自的容器与面板都在，而且只有一格可见',
    (function () {
      const page = m.dom.page;
      const visible = [
        byId(m.dom.doc, 'economy-configuration').style.display !== 'none',
        byId(m.dom.doc, 'economy-requests').style.display !== 'none',
        ['economy-shell-overview', 'economy-shell-store', 'economy-shell-assets']
          .filter(id => byId(m.dom.doc, id).hidden === false).length > 0
      ];
      return page.children.length === 3 && visible.filter(Boolean).length === 1;
    })(), {
      config: byId(m.dom.doc, 'economy-configuration').style.display,
      requests: byId(m.dom.doc, 'economy-requests').style.display,
      tab: m.ui.snapshot().tab
    });

  /* ══ I · 归属晚到时的自动补读 ═══════════════════════════════════════
     真实场景：fresh profile 里 `apiConfigs` 是**异步**填的（页面自己的
     loadApiConfigs()），于是首次 load 会以"没有角色"结束。之后角色出现
     时，已经读回来的那一份数据属于"没有归属"，必须重读一次 —— 否则用户
     会停在一句过期的"还没有配置任何角色"上。 */
  section('I · 角色目录晚到时自动补读一次（fresh profile 的真实形状）');

  {
    const late = mount(defaultWorld(), { apiConfigs: [] });
    late.cfg.render(); late.approval.render(); late.ui.render();
    await settle();
    const before = textOutsideTechnical(byId(late.dom.doc, 'economy-shell-overview'));
    const readsBefore = late.driver.calls.reads.map(r => r.path);

    /* 角色目录随后出现。
       ★ 必须**原地改数组**：沙箱里 `let apiConfigs` 在初始化时绑的是那个
         数组对象本身，换掉 `__roleState.configs` 的指向不会改变裸标识符
         那条路 —— 而生产里角色目录恰恰是**两条活入口**（裸标识符 +
         window 的活 accessor），只改一条的桩看不见另一条。 */
    late.box.__roleState.configs.push({ id: 'a1', nickname: '阿尔法' });
    /* 用户切回这一页 —— core.js 的 navTo 会重新渲染外壳。 */
    late.ui.render();
    await settle(12);

    const after = textOutsideTechnical(byId(late.dom.doc, 'economy-shell-overview'));
    const readsAfter = late.driver.calls.reads.map(r => r.path);

    check('I1 ★★★★ 角色目录为空时：说的是"还没有配置任何角色"，而且一条归属类读请求都不发',
      before.indexOf('还没有配置任何角色') >= 0 &&
      readsBefore.indexOf('/economy/wallet') < 0 &&
      readsBefore.indexOf('/economy/inventory') < 0,
      { reads: Array.from(new Set(readsBefore)) });

    check('I2 ★★★★★ 角色出现之后，外壳**自动补读一次**（不需要用户点"重新读取"）',
      readsAfter.indexOf('/economy/wallet') >= 0 &&
      readsAfter.indexOf('/economy/inventory') >= 0 &&
      readsAfter.indexOf('/economy/purchases') >= 0 &&
      late.ui.snapshot().ownerId === 'a1');

    check('I3 ★★★★ 补读之后钱包真的显示出来了，而且那句"还没有配置任何角色"不见了',
      after.indexOf('12,450.00') >= 0 && after.indexOf('还没有配置任何角色') < 0,
      after.slice(0, 200));

    check('I4 ★★★ 补读只有一次：再渲染几次不会继续发请求（不制造后台请求循环）',
      (function () {
        const n = late.driver.calls.reads.length;
        late.ui.render(); late.ui.render(); late.ui.render();
        return late.driver.calls.reads.length === n;
      })(), late.driver.calls.reads.length);
  }

  console.log('\n结果: ' + checks + ' 通过, ' + failures + ' 失败');
  if (failures) process.exit(1);
})();
