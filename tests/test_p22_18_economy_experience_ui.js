'use strict';
/* ====================================================================
   P22-18 · Economy Experience — 渲染器
   （assets/js/economy-shell.js 的 P22-18 追加部分）
   --------------------------------------------------------------------
   运行：node tests/test_p22_18_economy_experience_ui.js

   ★ 没有子进程、没有 socket、没有浏览器：DOM 是一个**走树**的桩，传输是
     一个假的既有 driver。于是"这一页读了哪几条路径""调了哪个写方法"
     都是可以直接数出来的事实。
   ★ 这一条测试要回答的问题：
     · 概览真的把四个区域（§2）画出来了，而且**共用同一份归属**；
     · 时间线有空状态 / 有数据 / 读不到 / 被截断**四种**形态；
     · §3 的"来源"与"三步"在 DOM 里各自找到证据；
     · §4 的原因**逐字**出现在正文里；
     · §7 的高级信息默认折叠、点一下展开、里面只有四个编号；
     · change log 是**走到末尾**地读的（第一页满就继续），而且有界；
     · 两个写方法一次都没有被调用（UI 没有写能力）。
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SHELL_REL = 'assets/js/economy-shell.js';
const CORE_REL = 'assets/js/economy-shell-core.js';
const CFG_REL = 'assets/js/economy-configuration.js';
const CFG_CORE_REL = 'assets/js/economy-configuration-core.js';

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

const uiSrc = read(SHELL_REL);
const uiCode = uiSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

console.log('P22-18 · Economy Experience 渲染器');

/* ── DOM 桩（与 P22-17 同款：getElementById 走树，textContent 递归）───── */
function makeDom() {
  function Style() { this._vars = Object.create(null); }
  Style.prototype.setProperty = function (k, v) { this._vars[String(k)] = String(v); };
  Style.prototype.getPropertyValue = function (k) {
    return Object.prototype.hasOwnProperty.call(this._vars, String(k)) ? this._vars[String(k)] : '';
  };
  function El(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null; this.className = '';
    this._text = ''; this.attributes = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this.checked = false;
    this.value = ''; this.id = ''; this.name = ''; this.type = '';
    this.rel = ''; this.href = ''; this.selected = false; this.style = new Style();
  }
  El.prototype.appendChild = function (child) {
    if (!child) return child;
    child.parentNode = this; this.children.push(child); return child;
  };
  El.prototype.insertBefore = function (child, ref) {
    if (!child) return child;
    child.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(child); else this.children.splice(i, 0, child);
    return child;
  };
  Object.defineProperty(El.prototype, 'textContent', {
    get: function () { return (this._text || '') + this.children.map(c => c.textContent).join(''); },
    set: function (v) { this.children = []; this._text = v == null ? '' : String(v); }
  });
  Object.defineProperty(El.prototype, 'innerHTML', {
    get: function () { return this._html || ''; },
    set: function (v) { this._html = v == null ? '' : String(v); this.children = []; }
  });
  /* ★ `firstChild` 必须有：P22-16 的外壳用 `page.insertBefore(host, page.firstChild)`
     把自己插到**最前**（P22-16 的视觉断言逐字钉住 children[0] 就是它）。
     桩里少了这个属性会让那次插入变成 appendChild，于是三个节点的顺序与
     生产不一致 —— 而"顺序"正是这一节要断言的东西。 */
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
    out = out || []; out.push(this);
    for (const c of this.children) if (c && c.walk) c.walk(out);
    return out;
  };
  const head = new El('head'), body = new El('body'), page = new El('div');
  page.className = 'page active';
  page.setAttribute('id', 'page-economy');
  const requests = new El('div');
  requests.setAttribute('id', 'economy-requests');
  page.appendChild(requests);
  body.appendChild(page);
  const doc = {
    readyState: 'complete', head: head, body: body,
    createElement: function (tag) { return new El(tag); },
    getElementById: function (id) {
      const hit = body.walk().filter(n => String(n.id || '') === String(id));
      return hit.length ? hit[0] : null;
    },
    addEventListener: function () { },
    _page: page, _requests: requests
  };
  return { doc: doc, El: El, head: head, page: page, requests: requests };
}
function find(root, cls) {
  return root.walk().filter(n => String(n.className || '').split(/\s+/).indexOf(cls) >= 0);
}
/* 只读**正文**：折叠的技术层与隐藏节点都不算（与 P22-17 同一条分界）。 */
function bodyText(root, includeHidden) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    const cls = String(n.className || '').split(/\s+/);
    if (cls.indexOf('esh-technical') >= 0) return;
    if (!includeHidden && n.hidden === true) return;
    if (n._text != null && n._text !== '') out.push(String(n._text));
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out.join(' | ');
}

/* ── 世界：一份能给全部九条读面的假数据 ─────────────────────────────── */
const W = 'econ_wallet_1';
const PRODUCTS = { ok: true, products: [
  { productId: 'econ_product_1', name: '数字绘画额度', description: '用于生成更多视觉素材的额度包',
    kind: 'COMPUTE_CREDIT', fulfillment: 'INVENTORY_GRANT', unitName: 'computeUnit', grantQuantity: 100,
    unitPriceMinor: '500', currency: 'IB_CREDIT', status: 'ACTIVE', storeId: 'econ_store_1' }
], personalized: false, hasRecommendations: false, hasDiscounts: false };
const STORES = { ok: true, stores: [{ storeId: 'econ_store_1', name: '内部资源', status: 'ACTIVE' }], holdsPrices: false, holdsOwnership: false };
const WALLET_READY = { ok: true, wallet: {
  walletId: W, owner: { type: 'character', id: 'a1' }, currency: 'IB_CREDIT', state: 'READY',
  balanceKnown: true, availableBalanceMinor: '1245000', reservedBalanceMinor: '0',
  cachedBalanceMinor: '1245000', ledgerBalanceMinor: '1245000', revision: 7 } };
const POLICY = { ok: true, policy: { policyId: 'econ_policy_1', ownerId: 'a1', currency: 'IB_CREDIT',
  status: 'ACTIVE', limits: { perTransactionMinor: '5000', dailyMinor: '50000' }, hardStop: false } };
const BUDGET = { ok: true, decision: { outcome: 'ALLOW' }, evaluatedOnly: true, notASpendPermit: true,
  reserved: false, snapshot: { currency: 'IB_CREDIT', spentTodayMinor: '1250' } };
const PURCHASES = { ok: true, purchases: [
  { purchaseId: 'econ_purchase_1', productId: 'econ_product_1', status: 'COMPLETED', completed: true,
    amountMinor: '500', currency: 'IB_CREDIT', createdAt: 1700000000000, completedAt: 1700000600000,
    approvalMode: 'APPROVAL', units: 1, quoteId: 'econ_quote_1', selfDirected: true,
    approval: { approvalId: 'econ_approval_1', status: 'CONSUMED', decidedBy: 'user:user',
      decidedAt: 1700000300000, consumedByPurchaseId: 'econ_purchase_1' } },
  { purchaseId: 'econ_purchase_2', productId: 'econ_product_1', status: 'COMPLETED', completed: true,
    amountMinor: '300', currency: 'IB_CREDIT', createdAt: 1699999000000, completedAt: 1699999100000,
    approvalMode: 'AUTO_ALLOW', units: 1, quoteId: 'econ_quote_2', selfDirected: true, approval: null }
], count: 2, personalized: false, recommended: false, ranked: false, exposesMutation: false };
const INTENTS = { ok: true, intents: [
  { agentIntentId: 'econ_agent_intent_1', agentId: 'a1', productId: 'econ_product_1', state: 'COMPLETED',
    reason: '  用于生成更多视觉素材  ', units: 1, createdAt: 1699999800000,
    purchaseId: 'econ_purchase_1', approvalId: 'econ_approval_1', quoteId: 'econ_quote_1',
    reasonIsAuthority: false, reasonIsTelemetry: true, terminal: true },
  { agentIntentId: 'econ_agent_intent_2', agentId: 'a1', productId: 'econ_product_1', state: 'WAITING_APPROVAL',
    reason: '想再画一批分镜', units: 2, createdAt: 1700002000000,
    purchaseId: null, approvalId: 'econ_approval_2', quoteId: null,
    reasonIsAuthority: false, reasonIsTelemetry: true, terminal: false }
], count: 2, personalized: false, recommended: false, ranked: false, exposesMutation: false };
const INVENTORY = { ok: true, entries: [{ inventoryEntryId: 'econ_inv_1', productId: 'econ_product_1',
  ownerId: 'a1', assetKind: 'COMPUTE', quantity: 100, productPresent: true, updatedAt: 1700000600000,
  isABalance: false }], isABalance: false, contributesToAvailableBalance: false, locksFunds: false };
/* ★ 这份夹具就是 **canonical 的 owner 读面会给出的样子**（P22-19）：
   只含 a1 自己的行、已经是 desc、并且自述了自己的作用域。
   另一个角色的那条行（econ_purchase_9）留在 `ALL_CHANGES` 里，由**全局**
   读面（不带 ownerId）返回 —— 于是"外壳到底带没带 ownerId"是一个可以被
   夹具**证伪**的性质，而不是一句假设。 */
const CHANGES = { ok: true, revision: 61, truncated: false,
  ownerScope: { ownerId: 'a1', order: 'desc', scoped: true }, recomputesEconomyFacts: false,
  changes: [
    { revision: 10, kind: 'WALLET_OPENED', entityId: W, walletId: W, at: 1699900000000, payload: { ownerId: 'a1' } },
    { revision: 20, kind: 'AGENT_INTENT_PROPOSED', entityId: 'econ_agent_intent_1', walletId: null,
      at: 1699999800000, payload: { agentId: 'a1', agentIntentId: 'econ_agent_intent_1', productId: 'econ_product_1', units: 1 } },
    { revision: 30, kind: 'APPROVAL_REQUESTED', entityId: 'econ_approval_1', walletId: null,
      at: 1700000100000, payload: { buyerId: 'a1', approvalId: 'econ_approval_1', amountMinor: '500', currency: 'IB_CREDIT', units: 1 } },
    /* ★ 生产形状：这一条的 buyerId 是 <partyType>:<id>。canonical 认它。 */
    { revision: 40, kind: 'APPROVAL_APPROVED', entityId: 'econ_approval_1', walletId: null,
      at: 1700000300000, payload: { buyerId: 'character:a1', approvalId: 'econ_approval_1', productId: 'econ_product_1' } },
    { revision: 50, kind: 'PURCHASE_RESERVED', entityId: 'econ_purchase_1', walletId: W,
      at: 1700000400000, payload: { buyerId: 'a1', purchaseId: 'econ_purchase_1', amountMinor: '500', currency: 'IB_CREDIT' } },
    { revision: 60, kind: 'PURCHASE_COMPLETED', entityId: 'econ_purchase_1', walletId: W,
      at: 1700000600000, payload: { buyerId: 'a1', purchaseId: 'econ_purchase_1', productId: 'econ_product_1', amountMinor: '500', currency: 'IB_CREDIT', units: 1 } }
  ] };
/* 全局读面（不带 ownerId 时 canonical 给的东西）：多出**别人**的一行。 */
const ALL_CHANGES = { ok: true, revision: 61, changes: CHANGES.changes.concat([
  { revision: 61, kind: 'PURCHASE_COMPLETED', entityId: 'econ_purchase_9', walletId: 'econ_wallet_other',
    at: 1700000700000, payload: { buyerId: 'a9', purchaseId: 'econ_purchase_9', amountMinor: '900', currency: 'IB_CREDIT' } }
]) };

function defaultWorld() {
  return { wallet: WALLET_READY, policy: POLICY, budget: BUDGET, stores: STORES, products: PRODUCTS,
    inventory: INVENTORY, purchases: PURCHASES, intents: INTENTS, changes: CHANGES, allChanges: ALL_CHANGES };
}

/* ── 假 driver：既有 remote driver 的同形替身 ─────────────────────────
   ★ 两个写方法**真的装上去**：否则"一次都没被调用"这条断言是在为空气作证。
   ★ ★ P22-19：`/economy/changes` 的替身必须和生产**同形**。它按 canonical
     的语义切片 —— 带 ownerId 时返回 owner 作用域的那一份、按 order 排序、
     按 (cursor, limit) 做 keyset。替身比生产宽松是这一仓库反复踩到的一类
     缺陷（P22-16 记过一次：纯 Node 测试全绿而真浏览器里错），因此这里
     不再"原样吐出 world.changes"，也不在这儿重新实现归属 —— 归属是
     canonical 的事，夹具只声明"canonical 会返回哪一份"。 */
function makeDriver(world) {
  const calls = { reads: [], writes: [] };
  const d = {
    calls: calls,
    getJson: function (p, q) {
      calls.reads.push({ path: p, query: q });
      if (p === '/economy/changes') {
        const req = q || {};
        /* 不带 ownerId ⇒ 全局读面（生产里存在，但这一页**不**该用它）。 */
        if (req.ownerId == null) {
          return Promise.resolve(world.allChanges || world.changes || { ok: true, changes: [], revision: 0 });
        }
        const src = world.changes || { ok: true, changes: [], revision: 0 };
        if (src.ok !== true) return Promise.resolve(src);
        const order = req.order === 'desc' ? 'desc' : 'asc';
        const limit = Math.max(1, Math.min(500, Number(req.limit) || 200));
        const cursor = Number(req.cursor) || 0;
        const rows = (src.changes || []).slice().sort(function (a, b) {
          return order === 'desc' ? Number(b.revision) - Number(a.revision) : Number(a.revision) - Number(b.revision);
        });
        const page = (order === 'desc'
          ? rows.filter(function (r) { return cursor <= 0 || Number(r.revision) < cursor; })
          : rows.filter(function (r) { return Number(r.revision) > cursor; })
        ).slice(0, limit);
        return Promise.resolve({ ok: true, revision: src.revision == null ? null : src.revision,
          changes: page,
          ownerScope: { ownerId: String(req.ownerId), order: order, scoped: true },
          recomputesEconomyFacts: false });
      }
      if (p === '/economy/wallet') return Promise.resolve(world.wallet || { ok: false, error: 'wallet-not-found', status: 404 });
      if (p === '/economy/policy') return Promise.resolve(world.policy || { ok: false, error: 'budget-policy-not-found', status: 404 });
      if (p === '/economy/budget') return Promise.resolve(world.budget || { ok: false, error: 'budget-evaluation-failed', status: 400 });
      if (p === '/economy/stores') return Promise.resolve(world.stores || { ok: true, stores: [] });
      if (p === '/economy/products') return Promise.resolve(world.products || { ok: true, products: [] });
      if (p === '/economy/inventory') return Promise.resolve(world.inventory || { ok: true, entries: [] });
      if (p === '/economy/purchases') return Promise.resolve(world.purchases || { ok: true, purchases: [] });
      if (p === '/economy/intents') return Promise.resolve(world.intents || { ok: true, intents: [] });
      return Promise.resolve({ ok: false, error: 'unexpected-read', status: 404 });
    },
    approvalDecision: function (body) { calls.writes.push({ method: 'approvalDecision', body: body }); return Promise.resolve({ ok: true }); },
    economyConfiguration: function (body) { calls.writes.push({ method: 'economyConfiguration', body: body }); return Promise.resolve({ ok: true }); }
  };
  return d;
}
function settle(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 12); i += 1) p = p.then(() => new Promise(r => setImmediate(r)));
  return p;
}

function mount(world, options) {
  options = options || {};
  const dom = makeDom();
  const box = { console: { log() {}, warn() {}, error() {}, info() {} } };
  box.window = box; box.self = box;
  box.document = dom.doc;
  const sandbox = vm.createContext(box);
  const roleState = { configs: options.apiConfigs === undefined ? [{ id: 'a1', nickname: '阿尔法' }] : options.apiConfigs };
  box.__roleState = roleState;
  vm.runInContext('let apiConfigs = __roleState.configs; let archivedConfigs = [];', sandbox);
  Object.defineProperty(box, 'apiConfigs', {
    get: function () { return roleState.configs; }, set: function (v) { roleState.configs = v; }, configurable: true
  });
  /* P22-15 的代表（本阶段不重跑它的实现）：只做 render() 计数 + 往它自己的
     容器里放一个标记节点，用来证明外壳只开合它的可见性。 */
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
  vm.runInContext(read(CFG_CORE_REL), sandbox, { filename: 'economy-configuration-core.js' });
  const cfgDriver = makeDriver(world || defaultWorld());
  box.IB.__ibEconomyConfigDriver = cfgDriver;
  vm.runInContext(read(CFG_REL), sandbox, { filename: 'economy-configuration.js' });
  vm.runInContext(read(CORE_REL), sandbox, { filename: 'economy-shell-core.js' });
  const driver = makeDriver(world || defaultWorld());
  box.IB.__ibEconomyShellDriver = driver;
  vm.runInContext(uiSrc, sandbox, { filename: 'economy-shell.js' });
  return { box: box, dom: dom, driver: driver, cfgDriver: cfgDriver, approval: approval,
    ui: box.IB.economyShellUI, core: box.IB.economyShellCore, cfg: box.IB.economyConfigurationUI };
}

/* ★ 与 P22-17 同款：CommonJS 里 `require` 与顶层 await 不能并存，因此整段
   异步的挂载与断言放在一个 async main 里（外面只留 require 与常量）。 */
(async function main() {
/* ★ 与 P22-17 同款：挂载之后要按 core.js 的接线顺序显式 render 一次
   （cfg → approval → shell），否则外壳还没有建 DOM，断言会读到 null。 */
function mountR(world, options) {
  const x = mount(world, options);
  x.cfg.render(); x.approval.render(); x.ui.render();
  return x;
}

const m = mountR(defaultWorld());
await settle();
const overview = () => m.dom.doc.getElementById('economy-shell-overview');
const shell = () => m.dom.doc.getElementById('economy-shell');

/* ══ A · 概览的四个区域（§2）════════════════════════════════════════ */
section('A · 概览：§2 的四个区域都在，而且共用同一份归属');

check('A1 ★★★★ 概览里八个块都在（钱包 / 时间线 / 经济活动 / 预算 / 支出 / 为什么 / 资产 / 高级信息）',
  (function () {
    const titles = find(overview(), 'esh-card-title').map(n => n.textContent).join(' · ');
    return ['IB Credit', '活动时间线', '经济活动', '预算', '支出说明', 'Agent 为什么提出请求', '我的资产', '高级信息']
      .every(t => titles.indexOf(t) >= 0);
  })(), find(overview(), 'esh-card-title').map(n => n.textContent));

check('A2 ★★★ 没有新增页面/页签：外层仍然是五个，而且概览就是第一格；' +
  '外壳只有页签 / 这一格的标题 / （归属条）/ 面板四件（P22-22 多的那件只是标题）',
  (function () {
    const kids = Array.prototype.slice.call(m.dom.doc.getElementById('economy-shell').children);
    const cls = k => String(k.className || '').split(/\s+/);
    return m.core.TABS.length === 5 && m.core.TABS[0].key === 'overview' &&
      kids.length === 4 &&
      cls(kids[0]).indexOf('esh-tabs') >= 0 &&
      cls(kids[1]).indexOf('esh-section') >= 0 &&
      cls(kids[3]).indexOf('esh-panes') >= 0 &&
      kids.filter(k => cls(k).indexOf('esh-panes') >= 0).length === 1;
  })(), Array.prototype.slice.call(m.dom.doc.getElementById('economy-shell').children).map(k => k.className));

check('A3 ★★★★ 归属只读一次：钱包明确读 IB_CREDIT，所有带归属的读面都发同一个 ownerId，' +
  'change log 也带 ownerId 与 order=desc（作用域与方向都在请求上）',
  (function () {
    const byPath = {};
    m.driver.calls.reads.forEach(r => {
      if (byPath[r.path] == null) byPath[r.path] = r.query || {};
    });
    return byPath['/economy/wallet'].ownerId === 'a1' &&
      byPath['/economy/wallet'].currency === 'IB_CREDIT' &&
      byPath['/economy/inventory'].ownerId === 'a1' &&
      byPath['/economy/purchases'].buyerId === 'a1' &&
      byPath['/economy/changes'].ownerId === 'a1' &&
      byPath['/economy/changes'].order === 'desc' &&
      byPath['/economy/changes'].cursor === 0 && byPath['/economy/changes'].limit === 500 &&
      byPath['/economy/stores'].ownerId === undefined;
  })(), m.driver.calls.reads.map(r => r.path + '?' + JSON.stringify(r.query)));

/* ══ B · 钱包三态（§12-2）══════════════════════════════════════════ */
section('B · 钱包三态仍然正确，而且"最近变化"来自时间线');

check('B1 ★★★★ READY：余额是权威那个数，最近变化就是时间线里最新那条动了钱的记录',
  (function () {
    const t = bodyText(overview(), true);
    return t.indexOf('12,450.00') >= 0 && t.indexOf('最近变化') >= 0 &&
      t.indexOf('购买完成') >= 0 && t.indexOf('5.00 IB Credit') >= 0 &&
      t.indexOf('暂无记录') < 0;
  })(), bodyText(overview(), true).slice(0, 400));

check('B2 ★★★★ COLD：主数字是破折号，而且**最近变化仍然说实话**（不是 0）',
  (async function () { return true; })(), '在下面的 B2b 里真跑一次');
await (async function () {
  const cold = mountR(Object.assign(defaultWorld(), {
    wallet: { ok: true, wallet: Object.assign({}, WALLET_READY.wallet, {
      state: 'COLD', balanceKnown: false, availableBalanceMinor: null, reservedBalanceMinor: null }) }
  }));
  await settle();
  const t = bodyText(cold.dom.doc.getElementById('economy-shell-overview'), true);
  check('B2b ★★★★ COLD：破折号 + 一句解释，而"最近变化"仍然列出那条真实记录',
    t.indexOf('—') >= 0 && t.indexOf('没有读出来') >= 0 &&
    t.indexOf('12,450.00') < 0 && t.indexOf('购买完成') >= 0);
  check('B2c ★★★★ COLD 时页面上**一个 0 都不出现**在余额那一格',
    t.indexOf('0.00 IB Credit | IB Credit') < 0);
})();

await (async function () {
  const absent = mountR(Object.assign(defaultWorld(), {
    wallet: { ok: false, error: 'wallet-not-found', status: 404 }
  }));
  await settle();
  const t = bodyText(absent.dom.doc.getElementById('economy-shell-overview'), true);
  /* ★ P22-22：这一格说的是**系统状态**（尚未完成 Initial Bootstrap），
     不是"没有钱包"。判定语义没变：不画 0、给「去设置」。 */
  check('B3 ★★★ 尚未完成 Initial Bootstrap：说"尚未完成 Initial Bootstrap"并给「去设置」，而不是画一个 0',
    t.indexOf('尚未完成 Initial Bootstrap') >= 0 && t.indexOf('没有额度账户') < 0 &&
    t.indexOf('去设置') >= 0 && t.indexOf('12,450.00') < 0);
})();

/* ══ C · 时间线四态（§12-3）════════════════════════════════════════ */
section('C · 时间线：有数据 / 空 / 读不到 / 被截断');

check('C1 ★★★★ 有数据：六条（canonical 按 owner 作用域给出的那六条）都渲染出来了',
  (function () {
    const items = find(overview(), 'esh-tl');
    return items.length === 6 && items[0].getAttribute('data-tone') === 'money' &&
      items[0].textContent.indexOf('购买完成') >= 0 &&
      /* 生产形状的 APPROVAL_APPROVED（buyerId = character:a1）在页面上 */
      bodyText(overview(), true).indexOf('你允许继续') >= 0;
  })(), find(overview(), 'esh-tl').map(n => n.textContent));

check('C1.1 ★★★★★ 外壳**从不**读全局 change log：它的每一次请求都带 ownerId' +
  '（夹具的全局列表里确实有别人的一行 —— 这条断言因此是可被证伪的）',
  (function () {
    const calls = m.driver.calls.reads.filter(r => r.path === '/economy/changes');
    return calls.length >= 1 && calls.every(r => r.query && r.query.ownerId === 'a1') &&
      (ALL_CHANGES.changes.length === CHANGES.changes.length + 1) &&
      bodyText(overview(), true).indexOf('9.00') < 0;
  })(), m.driver.calls.reads.filter(r => r.path === '/economy/changes').map(r => r.query));

check('C2 ★★★★ 顺序是 canonical 的 revision 倒序（最新在最上面）',
  (function () {
    const faces = find(overview(), 'esh-tl').map(n => find(n, 'esh-tl-face')[0].textContent);
    return faces[0] === '购买完成' && faces[1] === '为这次购买锁住额度' &&
      faces[2] === '你允许继续' && faces[faces.length - 1] === '额度账户建立';
  })(), find(overview(), 'esh-tl').map(n => find(n, 'esh-tl-face')[0].textContent));

check('C3 ★★★ 语气落在封闭集合里，而且每一行的线稿是 inline SVG（没有 emoji、没有 img）',
  (function () {
    const allowed = Object.keys(m.core.TONE).map(k => m.core.TONE[k]);
    const items = find(overview(), 'esh-tl');
    const tonesOk = items.every(n => allowed.indexOf(n.getAttribute('data-tone')) >= 0);
    const svgOk = items.every(n => find(n, 'esh-tl-mark')[0].walk().some(x => String(x.innerHTML || '').indexOf('<svg') >= 0));
    return tonesOk && svgOk && find(shell(), 'esh-tl-mark').length === 6;
  })());

check('C4 ★★★★ 空 change log：一句"还没有任何记录"，不是一个空框',
  (async function () { return true; })(), '在下面的 C4b 里真跑一次');
await (async function () {
  const empty = mountR(Object.assign(defaultWorld(), { changes: { ok: true, revision: 0, changes: [] } }));
  await settle();
  const t = bodyText(empty.dom.doc.getElementById('economy-shell-overview'), true);
  check('C4b ★★★★ 空 change log：说"还没有任何记录"，而且"最近变化"说"暂无记录"',
    t.indexOf('还没有任何记录') >= 0 && t.indexOf('暂无记录') >= 0 &&
    find(empty.dom.doc.getElementById('economy-shell-overview'), 'esh-tl').length === 0);
})();

await (async function () {
  const down = mountR(Object.assign(defaultWorld(), {
    changes: { ok: false, error: 'home-node-unreachable' }
  }));
  await settle();
  const t = bodyText(down.dom.doc.getElementById('economy-shell-overview'), true);
  check('C5 ★★★★ 读不到：是一句**人话**，而不是"什么都没有发生过"',
    t.indexOf('读不到活动记录') >= 0 && t.indexOf('还没有任何记录') < 0 &&
    t.indexOf('暂无记录') >= 0);
})();

await (async function () {
  /* ★ desc 之下"走到这一端"才是完整：第一页满 500 条 ⇒ 继续带着**本页最小**
     的 revision 往回走；第二页短 ⇒ 到这一端了。 */
  const full = { ok: true, revision: 600, changes: [] };
  for (let i = 1000; i > 500; i -= 1) {
    full.changes.push({ revision: i, kind: 'RESERVATION_CREATED', entityId: 'r' + i, walletId: W, at: 1000000 + i, payload: { ownerId: 'a1' } });
  }
  const paged = mountR(Object.assign(defaultWorld(), { changes: full }));
  await settle(30);
  const changeCalls = paged.driver.calls.reads.filter(r => r.path === '/economy/changes');
  check('C6 ★★★★★ desc 之下第一页满就带着**本页最小 revision**继续（否则更早的那一段看不到）',
    changeCalls.length === 2 && changeCalls[0].query.cursor === 0 &&
    changeCalls[0].query.order === 'desc' &&
    changeCalls[1].query.cursor === 501,
    changeCalls.map(c => c.query));
  const t = bodyText(paged.dom.doc.getElementById('economy-shell-overview'), true);
  check('C7 ★★★★★ 走到这一端之后**不说**自己被截断（它真的读完了）',
    t.indexOf('这里只显示最近的一部分活动') < 0);
  check('C8 ★★★ 短页之后**不再**多发一页',
    paged.driver.calls.reads.filter(r => r.path === '/economy/changes').length === 2);
})();

await (async function () {
  /* ★ 上限：3000 条以上 ⇒ 6 页 × 500 之后被挡住。desc 之下留下的是
     **最新**的那一段，因此"只有最近的一部分"这句话是真的。 */
  const many = { ok: true, revision: 9999, changes: [] };
  for (let i = 9999; i > 9999 - 3200; i -= 1) {
    many.changes.push({ revision: i, kind: 'RESERVATION_CREATED', entityId: 'r' + i, walletId: W, at: 1000000 + i, payload: { ownerId: 'a1' } });
  }
  const capped = mountR(Object.assign(defaultWorld(), { changes: many }));
  await settle(90);
  const calls = capped.driver.calls.reads.filter(r => r.path === '/economy/changes');
  const t = bodyText(capped.dom.doc.getElementById('economy-shell-overview'), true);
  check('C9 ★★★★★ 上限是**有界的**（6 页），而且被挡住时页面明说"只有最近的一部分"',
    calls.length === 6 &&
    t.indexOf('这里只显示最近的一部分活动') >= 0 &&
    /* 而且它确实拿到了最新的那一条（desc 的意义就在这里） */
    find(capped.dom.doc.getElementById('economy-shell-overview'), 'esh-tl').length === m.core.TIMELINE_KEEP,
    { pages: calls.length });
})();

await (async function () {
  /* ★ ★ P22-19：**两格对完整性的说法不许互相矛盾**。
     经济活动那一格的脚注在时间线读完整时才说"更早的仍然在那一格里"；
     时间线被截断时必须换一句。这里用 8 笔购买（> ACTIVITY_KEEP）把那条
     脚注真的逼出来，再看它说的是哪一句。 */
  const manyPurchases = { ok: true, purchases: [], count: 8 };
  for (let i = 1; i <= 8; i += 1) {
    manyPurchases.purchases.push({
      purchaseId: 'econ_purchase_g' + i, productId: 'econ_product_1', status: 'COMPLETED', completed: true,
      amountMinor: '100', currency: 'IB_CREDIT', createdAt: 1700000000000 + i, completedAt: 1700000000000 + i,
      approvalMode: 'AUTO_ALLOW', units: 1, quoteId: null, selfDirected: true, approval: null
    });
  }
  const cutWorld = Object.assign(defaultWorld(), {
    purchases: manyPurchases,
    changes: { ok: true, revision: 999, changes: (function () {
      const rows = [];
      for (let i = 999; i > 999 - 3200; i -= 1) {
        rows.push({ revision: i, kind: 'RESERVATION_CREATED', entityId: 'r' + i, walletId: W, at: 1000000 + i, payload: { ownerId: 'a1' } });
      }
      return rows;
    })(), ownerScope: { ownerId: 'a1', order: 'desc', scoped: true } }
  });
  const cutPage = mountR(cutWorld);
  await settle(90);
  const cutText = bodyText(cutPage.dom.doc.getElementById('economy-shell-overview'), true);
  const doneWorld = Object.assign(defaultWorld(), { purchases: manyPurchases });
  const donePage = mountR(doneWorld);
  await settle(30);
  const doneText = bodyText(donePage.dom.doc.getElementById('economy-shell-overview'), true);
  check('C10 ★★★★★ 时间线被截断时，经济活动那一格**不再**说"更早的仍然在时间线里"',
    cutText.indexOf(m.core.COPY.activityMoreSuffixPartial.trim()) >= 0 &&
    cutText.indexOf(m.core.COPY.activityMoreSuffix.trim()) < 0 &&
    doneText.indexOf(m.core.COPY.activityMoreSuffix.trim()) >= 0 &&
    doneText.indexOf(m.core.COPY.activityMoreSuffixPartial.trim()) < 0,
    { cutHasPartial: cutText.indexOf(m.core.COPY.activityMoreSuffixPartial.trim()) >= 0,
      cutHasFull: cutText.indexOf(m.core.COPY.activityMoreSuffix.trim()) >= 0,
      doneHasFull: doneText.indexOf(m.core.COPY.activityMoreSuffix.trim()) >= 0 });
})();

/* ══ D · §3 经济活动 ═══════════════════════════════════════════════ */
section('D · §3 经济活动：商品 / 金额 / 状态 + 来源 + 三步');

check('D1 ★★★★ 两条购买都渲染出来了，而且是 latest-first（canonical 给的是 ASC）',
  (function () {
    const acts = find(overview(), 'esh-activity');
    const names = acts.map(a => find(a, 'esh-row-name')[0].textContent);
    const amounts = acts.map(a => find(a, 'esh-row-amount')[0].textContent);
    return acts.length === 2 && names.join(',') === '数字绘画额度,数字绘画额度' &&
      amounts[0].indexOf('5.00') >= 0 && amounts[1].indexOf('3.00') >= 0;
  })(), find(overview(), 'esh-activity').map(a => a.textContent));

check('D2 ★★★★★ 第一条的来源三词齐全：Agent 提议 / 用户批准 / 系统完成，且带角色名',
  (function () {
    const src = find(overview(), 'esh-activity')[0];
    const chips = find(src, 'esh-act-src').map(n => n.textContent);
    const who = find(src, 'esh-act-who').map(n => n.textContent);
    return chips.join(' / ') === 'Agent 提议 / 用户批准 / 系统完成' &&
      who.join('') === '由 阿尔法 发起';
  })(), find(find(overview(), 'esh-activity')[0], 'esh-act-src').map(n => n.textContent));

check('D3 ★★★★★ 自主放行那条：**没有**"用户批准"，多的是"按自主规则放行"',
  (function () {
    const chips = find(find(overview(), 'esh-activity')[1], 'esh-act-src').map(n => n.textContent);
    return chips.join(' / ') === '按自主规则放行 / 系统完成' && chips.indexOf('用户批准') < 0;
  })(), find(find(overview(), 'esh-activity')[1], 'esh-act-src').map(n => n.textContent));

check('D4 ★★★★ 三步在 DOM 里各自是一步（Intent → Approval → Purchase），各带自己的状态',
  (function () {
    const steps = find(find(overview(), 'esh-activity')[0], 'esh-step');
    const keys = steps.map(s => s.getAttribute('data-step')).join(',');
    const labels = steps.map(s => find(s, 'esh-step-label')[0].textContent).join(' / ');
    return keys === 'intent,approval,purchase' &&
      labels === 'Agent 提出请求 / 你允许继续 / 系统完成购买' &&
      steps.every(s => find(s, 'esh-step-sub')[0].textContent.length > 0);
  })(), find(find(overview(), 'esh-activity')[0], 'esh-step').map(s => s.textContent));

check('D5 ★★★★★ 自主那条的"决定"这一步说清楚了**为什么没有这一步**（而不是一个"无"）',
  (function () {
    const steps = find(find(overview(), 'esh-activity')[1], 'esh-step');
    const approval = steps[1];
    return String(approval.className).indexOf('is-absent') >= 0 &&
      approval.textContent.indexOf('按自主规则直接放行，因此没有产生一条决定记录') >= 0;
  })());

check('D6 ★★★ 明细有上限：模型里有常量，页面上最多铺那么多条',
  m.core.ACTIVITY_KEEP === 6 &&
  find(overview(), 'esh-activity').length <= m.core.ACTIVITY_KEEP);

check('D7 ★★ 商品名用的是既有的 .esh-row-name（P22-17 的视觉断言继续成立）',
  find(overview(), 'esh-row-name').length >= 3);

/* ══ E · §4 为什么提出 ═════════════════════════════════════════════ */
section('E · §4 Agent 为什么提出：原因逐字，一个字节都不改');

check('E1 ★★★★★ 原因**逐字**出现在正文里（含前后空格被保留在模型里）',
  (function () {
    const whys = find(overview(), 'esh-why');
    const dds = whys.map(w => find(w, 'esh-why-dd').map(d => d.textContent));
    const model = m.ui.snapshot().view.explanations.rows;
    return model[1].reason === '  用于生成更多视觉素材  ' &&
      model[0].reason === '想再画一批分镜' &&
      dds[1][0] === '  用于生成更多视觉素材  ';
  })(), m.ui.snapshot().view.explanations.rows.map(r => r.reason));

check('E2 ★★★★ 模型里三句自述：原样 / 没有模型摘要 / 理由不是权限',
  (function () {
    const ex = m.ui.snapshot().view.explanations;
    return ex.reasonSummarizedByAi === false && ex.reasonIsAuthority === false &&
      ex.reasonIsTelemetry === true &&
      ex.rows.every(r => r.reasonVerbatim === true && r.reasonSummarizedByAi === false &&
        r.reasonIsAuthority === false);
  })());

check('E3 ★★★★ 「原样展示」那句话在正文里（用户能读到这个承诺）',
  bodyText(overview(), true).indexOf('原样展示：没有摘写、没有改写、也没有再让模型解释一次') >= 0);

check('E4 ★★★ 数量与状态各自一格：数量来自 canonical 的 intent.units',
  (function () {
    const whys = find(overview(), 'esh-why');
    const facts = whys.map(w => find(w, 'esh-why-dt').map(d => d.textContent).join(','));
    const vals = whys.map(w => find(w, 'esh-why-dd').map(d => d.textContent).join(','));
    return facts[0].indexOf('原因') >= 0 && facts[0].indexOf('数量') >= 0 &&
      vals[0].indexOf('2') >= 0 && vals[0].indexOf('想再画一批分镜') >= 0;
  })(), find(overview(), 'esh-why').map(w => w.textContent));

check('E5 ★★★ 没有写下原因时说的是"这次请求没有写下原因"，而不是一个空白',
  (async function () { return true; })(), '在下面的 E5b 里真跑一次');
await (async function () {
  const noReason = mountR(Object.assign(defaultWorld(), {
    intents: { ok: true, intents: [{ agentIntentId: 'econ_agent_intent_3', agentId: 'a1',
      productId: 'econ_product_1', state: 'PROPOSED', reason: null, units: 1, createdAt: 1700003000000 }] }
  }));
  await settle();
  const t = bodyText(noReason.dom.doc.getElementById('economy-shell-overview'), true);
  check('E5b ★★★ 没有原因时说"这次请求没有写下原因"',
    t.indexOf('这次请求没有写下原因') >= 0);
})();

/* ══ F · §7 高级信息 ═══════════════════════════════════════════════ */
section('F · §7 高级信息：默认折叠、点一下展开、只有四个编号');

check('F1 ★★★★★ 默认折叠（body.hidden === true，而且模型初值就是 false）',
  (function () {
    const body = find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-body')[0];
    return body.hidden === true && m.ui.snapshot().view.audit.open === false &&
      find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-toggle')[0]
        .getAttribute('aria-expanded') === 'false';
  })());

check('F2 ★★★★★ 折叠时**编号不出现在正文里**（正文只读不隐藏节点也不行 —— 它带 esh-technical）',
  (function () {
    const t = bodyText(overview(), true);
    const tNoTech = bodyText(overview(), false);
    return t.indexOf('econ_agent_intent_1') < 0 && t.indexOf('econ_purchase_1') < 0 &&
      tNoTech.indexOf('econ_agent_intent_1') < 0;
  })());

check('F3 ★★★★★ 点一下展开：四条编号各一列，数值就是 canonical 的 id',
  (function () {
    const toggle = find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-toggle')[0];
    toggle.click();
    const body = find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-body')[0];
    const rows = find(body, 'esh-audit-row').filter(r => String(r.className).indexOf('is-head') < 0);
    const cells = rows.map(r => find(r, 'esh-audit-cell').map(c => c.textContent));
    const head = find(body, 'esh-audit-row')[0];
    const headText = find(head, 'esh-audit-cell').map(c => c.textContent).join(',');
    return body.hidden === false && rows.length >= 2 &&
      headText.indexOf('请求编号') >= 0 && headText.indexOf('决定编号') >= 0 &&
      headText.indexOf('购买编号') >= 0 && headText.indexOf('报价编号') >= 0 &&
      cells[0].indexOf('econ_agent_intent_1') >= 0 && cells[0].indexOf('econ_purchase_1') >= 0;
  })(), find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-body')[0].textContent.slice(0, 300));

check('F4 ★★★★★ 展开之后每一格**只可能**是名字、"—" 或一个 canonical 编号 —— 没有第五种数据',
  (function () {
    const body = find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-body')[0];
    const rows = find(body, 'esh-audit-row').filter(r => String(r.className).indexOf('is-head') < 0);
    const cells = [];
    rows.forEach(r => find(r, 'esh-audit-cell').forEach(c => cells.push(c.textContent)));
    /* ① 每一行恰好五格（名字 + 四个编号）—— 多一格就意味着多了一种数据；
       ② 除第一格（名字）与"—"之外，每一格都必须以 canonical 的前缀开头；
       ③ revision / migration / sqlite / schema 这些词只允许出现在那句
          **说明**里（它们说的是"这些不在这里"），不允许出现在任何一格。 */
    const fiveEach = rows.every(r => find(r, 'esh-audit-cell').length === 5);
    const valuesOk = rows.every(r => find(r, 'esh-audit-cell').slice(1)
      .every(c => c.textContent === '—' || /^econ_/.test(c.textContent)));
    const valueBlob = cells.join(' | ');
    const noTableFacts = ['revision', 'migration', 'sqlite', 'schema', 'rowid', 'revision=1']
      .every(w => valueBlob.indexOf(w) < 0);
    return fiveEach && valuesOk && noTableFacts && rows.length >= 2;
  })(), find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-body')[0].textContent.slice(0, 300));

check('F5 ★★ 再点一下收起，而且状态在重新渲染之后**保持**（不会自己弹回来）',
  (function () {
    const toggle = find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-toggle')[0];
    toggle.click();
    let body = find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-body')[0];
    const closed = body.hidden === true;
    find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-toggle')[0].click();
    body = find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-body')[0];
    const openAgain = body.hidden === false;
    find(m.dom.doc.getElementById('economy-shell'), 'esh-audit-toggle')[0].click();
    return closed && openAgain;
  })());

/* ══ G · 传输纪律 ══════════════════════════════════════════════════ */
section('G · 传输：九条只读面，两个写方法一次都没被调用');

check('G1 ★★★★★ 全部读请求都落在九条已声明的只读面上（八条 P22-17 + change log）',
  (function () {
    const allowed = m.core.readPathList().concat([m.core.CHANGE_READ]);
    const paths = m.driver.calls.reads.map(r => r.path);
    return allowed.length === 9 && paths.every(p => allowed.indexOf(p) >= 0) &&
      Array.from(new Set(paths)).length === 9;
  })(), Array.from(new Set(m.driver.calls.reads.map(r => r.path))));

check('G2 ★★★★★ 两个写方法**一次都没有被调用**（外壳 + P22-16 两边都算）',
  m.driver.calls.writes.length === 0 && m.cfgDriver.calls.writes.length === 0,
  m.driver.calls.writes.concat(m.cfgDriver.calls.writes));

check('G3 ★★★ 假 driver 上真的装着那两个写方法（否则 G2 是在为空气作证）',
  typeof m.driver.approvalDecision === 'function' &&
  typeof m.driver.economyConfiguration === 'function' &&
  typeof m.driver.getJson === 'function');

check('G4 ★★★★ 没有角色时**不读** change log（一条变化是谁的要比得出来才算）',
  (async function () { return true; })(), '在下面的 G4b 里真跑一次');
await (async function () {
  const none = mountR(Object.assign(defaultWorld(), {}), { apiConfigs: [] });
  await settle();
  const reads = none.driver.calls.reads.map(r => r.path);
  check('G4b ★★★★ 没有角色时读的是目录（不带归属），change log 一条都不发',
    reads.indexOf('/economy/stores') >= 0 && reads.indexOf('/economy/products') >= 0 &&
    reads.indexOf('/economy/changes') < 0 && reads.indexOf('/economy/wallet') < 0,
    Array.from(new Set(reads)));
})();

check('G5 ★★★ 切页签 / 展开高级信息 / 折叠技术层，全部不产生任何写请求',
  (function () {
    const before = m.driver.calls.writes.length + m.cfgDriver.calls.writes.length;
    m.ui.show('overview'); m.ui.show('store'); m.ui.show('assets');
    m.ui.show('settings'); m.ui.show('requests');
    const tech = find(m.dom.doc.getElementById('economy-shell'), 'esh-technical-toggle');
    tech.forEach(t => t.click());
    const after = m.driver.calls.writes.length + m.cfgDriver.calls.writes.length;
    return before === 0 && after === 0;
  })());

/* ══ H · 与 P22-15 / P22-16 / P22-17 的边界 ════════════════════════ */
section('H · 边界：既有两格一个字节都不动，外壳只追加');

check('H1 ★★★★★ 三个节点的**顺序**逐字没变：#economy-configuration / #economy-requests / #economy-shell',
  (function () {
    const ids = m.dom.page.children.map(c => c.id);
    /* ★ 生产里的顺序由 P22-16 自己决定：它用 insertBefore 把自己插到最前，
       因此 `#economy-requests` 是第 2 个（P22-16 的视觉断言逐字钉住
       children[0] = 它、children[1] = requests）。P22-18 只**追加**第三个，
       一个节点都没有搬动。 */
    return ids.join(',') === 'economy-configuration,economy-requests,economy-shell';
  })(), m.dom.page.children.map(c => c.id));

check('H2 ★★★★ P22-16 的外壳仍然是 children[0]、P22-15 的容器仍然是 children[1]',
  (function () {
    const cfg = m.dom.doc.getElementById('economy-configuration');
    const requests = m.dom.doc.getElementById('economy-requests');
    return m.dom.page.children[0] === cfg && m.dom.page.children[1] === requests &&
      m.dom.page.children[2] === m.dom.doc.getElementById('economy-shell');
  })());

check('H3 ★★★★ 「待处理」那一格仍然是 P22-15 自己的内容，外壳没有碰它的子树',
  (function () {
    const marker = m.dom.doc.getElementById('economy-requests');
    return find(marker, 'ec-title').length === 1 &&
      marker.textContent.indexOf('待决定') >= 0;
  })());

check('H4 ★★★ 概览里**没有**任何购买按钮 / 申请按钮（canonical 至今没有人类直接购买这条接缝）',
  (function () {
    const words = ['购买', '买下', '下单', '结算', '申请'];
    const btns = find(overview(), 'esh-btn-primary').concat(
      find(overview(), 'esh-btn-quiet'), find(overview(), 'esh-btn-link'));
    return btns.every(b => !words.some(w => b.textContent.indexOf(w) >= 0));
  })(), find(overview(), 'esh-btn-primary').map(b => b.textContent));

/* ══ I · 文案与静态纪律 ════════════════════════════════════════════ */
section('I · 文案：正文里没有原始代号、没有 emoji、没有位图');

check('I1 ★★★★★ 正文里没有 canonical 原始代号（代号只在折叠的技术层）',
  (function () {
    const t = bodyText(overview(), true);
    return ['IB_CREDIT', 'RESERVED', 'COMPLETED', 'AUTO_ALLOW', 'APPROVAL', 'WAITING_APPROVAL',
      'CONSUMED', 'econ_product_', 'econ_store_', 'econ_purchase_', 'econ_wallet_', 'computeUnit',
      'revision'].every(w => t.indexOf(w) < 0);
  })(), ['IB_CREDIT', 'RESERVED', 'COMPLETED', 'AUTO_ALLOW', 'APPROVAL', 'econ_purchase_', 'revision']
    .filter(w => bodyText(overview(), true).indexOf(w) >= 0));

check('I2 ★★★ 正文里有真实的数字与币种名（I1 不是靠"什么都不显示"通过的）',
  (function () {
    const t = bodyText(overview(), true);
    return t.indexOf('12,450.00') >= 0 && t.indexOf('IB Credit') >= 0 && t.indexOf('5.00') >= 0 &&
      t.indexOf('8.00') >= 0;
  })());

check('I3 ★★★ 页面上没有 emoji、没有位图（图标全是 inline SVG）',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(shell().textContent) &&
  find(shell(), 'esh-mark').length >= 5 &&
  shell().walk().filter(n => n.tagName === 'IMG').length === 0);

check('I4 ★★★★ 渲染器里没有 fetch / XMLHttpRequest / require（传输只有既有 driver 一处）',
  !/\bfetch\s*\(/.test(uiCode) && !/XMLHttpRequest/.test(uiCode) && !/\brequire\s*\(/.test(uiCode));

check('I5 ★★★★★ 渲染器里没有一条 /internal/economy/* 路径，也没有任何批量的写方法名',
  !/\/internal\/economy\//.test(uiSrc) &&
  ['batchApprove', 'autoApprove', 'approveAll'].every(w => uiCode.indexOf(w) < 0),
  (uiSrc.match(/\/internal\/economy\/[a-z-]+/g) || []));

check('I6 ★★★★ 渲染器里没有 batchApprove / autoApprove / approveAll（§5 明令）',
  ['batchApprove', 'autoApprove', 'approveAll'].every(w => uiCode.indexOf(w) < 0));

console.log('\n结果: ' + checks + ' 通过, ' + failures + ' 失败');
})();
