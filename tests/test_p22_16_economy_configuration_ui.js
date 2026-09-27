'use strict';
/* ====================================================================
   P22-16 · Economy Configuration UI — 渲染器（assets/js/economy-configuration.js）
   --------------------------------------------------------------------
   运行：node tests/test_p22_16_economy_configuration_ui.js

   ★ 一个只实现渲染器真正用到的成员的 DOM 桩 + 一个与 home-node-client
     同形状的假 driver。**零子进程、零 socket、零浏览器、零 fetch。**

   这一条测试要回答的问题（§8 的十条里除去"视觉"与"真浏览器"那两条）：

     · fresh / already-initialized 两种钱包状态各自长什么样，而且
       **已初始化之后不能出现第二个可执行的初始化按钮**；
     · 预算与自主表单真的投影成 P22-14 的 canonical config（逐字节比对
       请求体），而不是"看起来差不多"；
     · 非法输入 fail closed：**一个请求都不发**；
     · 保存之后重新读权威（不是乐观成功）；
     · 配置面关着时页面上**没有**任何保存按钮；
     · `/economy/*` 上的 HTTP write 仍然是 0（假 driver 逐条记录）；
     · 页签开合不搬动 P22-15 的 DOM 节点（`#economy-requests` 仍在原位，
       只是 display 被开合）—— 这是 P22-15 不回归的结构保证。
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const UI_REL = 'assets/js/economy-configuration.js';

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
const uiCode = uiSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ECONOMY_CSS_HREF = 'assets/css/economy-configuration.css';
const ECONOMY_CSS_STATIC_LINKS = read('InternalBeyond.html')
  .match(/<link\b[^>]*href=["']assets\/css\/economy-configuration\.css["'][^>]*>/gi) || [];

console.log('P22-16 · Economy Configuration UI（渲染器 + 假 driver）');

/* ══════════════════════════════════════════════════════════════════════
   DOM 桩：只实现渲染器真的用到的成员
   ------------------------------------------------------------------
   ① `getElementById` 用**走树**而不是一张注册表：于是"节点真的在文档里"
      与"getElementById 找得到它"是同一件事，而不是桩自己维护的第二份
      事实（一份对不上的注册表会让"装了但看不见"变成通过）。
   ② `textContent` 的 getter 递归拼接子节点：可见文案的断言读的是它。
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
    this.checked = false;
    this.value = '';
    this.id = '';
    this.name = '';
    this.type = '';
    this.placeholder = '';
    this.rel = '';
    this.href = '';
    this.inputMode = '';
    this.autocomplete = '';
    this.selected = false;
    this.style = {};
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
  /* ★ textContent 的语义要与真实 DOM 同形：`n.textContent = 'x'` 相当于
     放进一个文本节点，之后再 appendChild 的**不会被它挤掉**。写成
     "有子节点就忽略自己的文本"会让一个设了文字再挂一个图标 span 的
     按钮（那正是页签的做法）看起来是空的 —— 一条由桩造出来的假红。 */
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
  /* firstChild 是真实 DOM 就有的东西：渲染器用它把外壳插到 P22-15 的
     容器**前面**。桩少了它，insertBefore 那条分支就永远不会被走到 ——
     而"桩没有的分支"正是最容易藏住顺序错误的地方。 */
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
  El.prototype.findPrefix = function (prefix) {
    return this.walk().filter(n => String(n.id || '').indexOf(prefix) === 0);
  };

  const head = new El('head');
  const body = new El('body');
  const page = new El('div');
  page.className = 'page';
  page.setAttribute('id', 'page-economy');
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
/* 全部文本，**但跳过 .ecfg-technical 那棵子树** —— 技术说明是折叠层，
   正文里不该出现的东西（环境变量名、原词）正是要放在那里面的，因此
   "正文里没有它"必须用一棵不含技术层的树来回答。 */
function textOutsideTechnical(root) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (String(n.className || '').split(/\s+/).indexOf('ecfg-technical') >= 0) return;
    if (n.hidden === true) return;
    if (n._text != null && n._text !== '') out.push(String(n._text));
    for (const c of (n.children || [])) walk(c);
  })(root);
  return out.join(' | ');
}
function textInsideTechnical(root) {
  return find(root, 'ecfg-technical').map(n => n.textContent).join(' | ');
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
function byId(doc, id) { return doc.getElementById(id); }
function inputByName(doc, name) {
  const hit = doc.body.walk().filter(n => n.tagName === 'INPUT' && String(n.name) === name);
  return hit.length ? hit[0] : null;
}
function checkboxesNamed(doc, name) {
  return doc.body.walk().filter(n => n.tagName === 'INPUT' && n.type === 'checkbox' && String(n.name) === name);
}
function buttonByText(root, text) {
  return root.walk().filter(n => n.tagName === 'BUTTON' && n.textContent === text);
}
/* 模拟用户真的敲字：`.value = x` 之后再派发 input / change —— 直接赋值不会
   触发监听器，而"表单能不能记住用户刚输入的值"正是要被证明的事之一。 */
function typeInto(node, value) {
  if (!node) throw new Error('typeInto: node missing');
  node.value = String(value);
  for (const fn of (node.listeners.input || [])) fn({ type: 'input', target: node });
  for (const fn of (node.listeners.change || [])) fn({ type: 'change', target: node });
}
function setChecked(node, on) {
  if (!node) throw new Error('setChecked: node missing');
  node.checked = !!on;
  for (const fn of (node.listeners.change || [])) fn({ type: 'change', target: node });
}

/* ══════════════════════════════════════════════════════════════════════
   假 driver + world
   ══════════════════════════════════════════════════════════════════════ */
const NOW = Date.now();

function defaultWorld() {
  return {
    gate: { implemented: true, open: true, configurationCommandsExposed: ['BOOTSTRAP_CREDIT', 'PUT_BUDGET_POLICY', 'PUT_AUTONOMY_POLICY'] },
    /* 还没初始化：钱包不存在 */
    wallet: { ok: false, error: 'wallet-not-found', status: 404 },
    policy: { ok: false, error: 'budget-policy-not-found', status: 404 },
    autonomy: { ok: false, error: 'autonomy-policy-not-found', status: 404 },
    snapshot: { ok: true, snapshot: { spentTodayMinor: '0' }, decision: { outcome: 'ALLOW' } },
    write: function () { return { ok: true, command: 'PUT_BUDGET_POLICY', configuredAnything: true, budgetPolicyWritten: true, replayed: false }; }
  };
}

function makeDriver(world) {
  const calls = { reads: [], writes: [] };
  return {
    calls: calls,
    getJson: function (path, query) {
      calls.reads.push({ path: path, query: query });
      if (path === '/security') return Promise.resolve({ ok: true, protocolVersion: 1, economyPolicy: { configuration: world.gate, approvalDecision: { implemented: true, open: true } } });
      if (path === '/economy/wallet') return Promise.resolve(world.wallet);
      if (path === '/economy/policy') return Promise.resolve(world.policy);
      if (path === '/economy/autonomy-policy') return Promise.resolve(world.autonomy);
      if (path === '/economy/budget') return Promise.resolve(world.snapshot);
      return Promise.resolve({ ok: false, error: 'unexpected-read', status: 404 });
    },
    economyConfiguration: function (body) {
      calls.writes.push(body);
      return Promise.resolve(world.write(body));
    }
  };
}

function settle(times) {
  let p = Promise.resolve();
  for (let i = 0; i < (times || 6); i += 1) p = p.then(() => new Promise(r => setImmediate(r)));
  return p;
}

/* 载入渲染器：每次一个新沙箱 + 新 DOM + 新 driver。 */
function mount(world, options) {
  options = options || {};
  const dom = makeDom();
  const box = { console: { log() {}, warn() {}, error() {}, info() {} } };
  box.window = box; box.self = box;
  box.document = dom.doc;
  let shellRefreshes = 0;
  box.IB = { economyShellUI: { refresh: function () { shellRefreshes += 1; return Promise.resolve(); } } };
  const sandbox = vm.createContext(box);
  /* ★ 角色目录必须与**生产**同形：生产里那个名字有两个入口，而且两个都
     是活的 —— 裸标识符（social.js:607 顶层 `let`）与 window.apiConfigs
     （social.js:2654 用 ibSocialLive 注册成一对活的 getter/setter）。
     把 apiConfigs 单纯挂成一个沙箱普通属性，就只覆盖了"第三种、生产里
     不存在"的形状：那样一来"渲染器只认某一条路"的缺陷在本测试里看不见。
     因此这里把两条都装上，与 social.js 逐字同款。 */
  const roleState = {
    configs: options.apiConfigs === undefined
      ? [{ id: 'a1', nickname: '阿尔法' }, { id: 'a2', nickname: '贝塔' }]
      : options.apiConfigs,
    archived: options.archivedConfigs || []
  };
  box.__roleState = roleState;
  vm.runInContext('let apiConfigs = __roleState.configs; let archivedConfigs = __roleState.archived;', sandbox);
  Object.defineProperty(box, 'apiConfigs', {
    get: function () { return roleState.configs; },
    set: function (v) { roleState.configs = v; },
    configurable: true
  });
  Object.defineProperty(box, 'archivedConfigs', {
    get: function () { return roleState.archived; },
    set: function (v) { roleState.archived = v; },
    configurable: true
  });
  vm.runInContext(read('assets/js/economy-configuration-core.js'), sandbox, { filename: 'economy-configuration-core.js' });
  const driver = makeDriver(world || defaultWorld());
  box.IB.__ibEconomyConfigDriver = driver;
  vm.runInContext(uiSrc, sandbox, { filename: 'economy-configuration.js' });
  return { box: box, dom: dom, driver: driver, ui: box.IB.economyConfigurationUI,
    core: box.IB.economyConfigurationCore, shellRefreshCount: function () { return shellRefreshes; } };
}

/* 只加载纯层：拿一份**真的** ID / SECTIONS / COPY，而不是用正则去源码里猜
   （`HOST: '…'` 这样的正则会先命中 `REQUESTS_HOST: '…'`）。 */
const CORE_REF = (function () {
  const b = { console: { log() {}, warn() {}, error() {}, info() {} } };
  b.window = b; b.self = b;
  const s = vm.createContext(b);
  vm.runInContext(read('assets/js/economy-configuration-core.js'), s, { filename: 'economy-configuration-core.js' });
  return b.IB.economyConfigurationCore;
})();

function panelOf(m, sectionKey) {
  const s = m.core.SECTIONS.filter(x => x.key === sectionKey)[0];
  return byId(m.dom.doc, s.paneId);
}

/* ══════════════════════════════════════════════════════════════════════ */
(async function main() {

section('A · 静态结构：只有一条写路径，而且它不在 /economy/ 下');

check('A1 ★★★ 渲染器里没有 fetch / XMLHttpRequest —— 唯一的出口是既有 remote driver',
  uiCode.indexOf('fetch') < 0 && uiCode.indexOf('XMLHttpRequest') < 0 &&
  uiCode.indexOf('localStorage') < 0);

const coreCodeStripped = read('assets/js/economy-configuration-core.js')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const clientCodeStripped = read('assets/js/home-node-client.js')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('A2 ★★★ 唯一的写路径是 P22-14 那条 seam，而且它在渲染器里**一次都不出现**（路径只有纯层与 client 知道）',
  (uiSrc.match(/\/internal\/economy\/configuration/g) || []).length === 0 &&
  (coreCodeStripped.match(/\/internal\/economy\/configuration/g) || []).length === 1 &&
  (clientCodeStripped.match(/\/internal\/economy\/configuration/g) || []).length === 1);

check('A3 ★★★ 渲染器不新增任何 /economy/* 的写方法名（mint / transfer / settle / buy / refund / exchange）',
  ['mint', 'transferBetweenWallets', 'settlePurchase', 'refund', 'exchange', 'topup', 'grantInventory']
    .every(w => uiCode.indexOf(w) < 0));

check('A4 ★★★ Economy CSS 资源存在，且没有被写成 HTML 静态 stylesheet link',
  /STYLE_ID: 'ib-econ-cfg-style'/.test(uiSrc) &&
  /STYLE_HREF: 'assets\/css\/economy-configuration\.css'/.test(uiSrc) &&
  fs.existsSync(path.join(ROOT, ECONOMY_CSS_HREF)) &&
  ECONOMY_CSS_STATIC_LINKS.length === 0);

check('A5 ★★★ HTML 里 P22-15 的页面容器**逐字未改**，只多了两个 script 标签',
  /<div class="page" id="page-economy"><div id="economy-requests"><\/div><\/div>/.test(read('InternalBeyond.html')) &&
  read('InternalBeyond.html').indexOf('<script src="assets/js/economy-configuration-core.js"></script>') >= 0 &&
  read('InternalBeyond.html').indexOf('<script src="assets/js/economy-configuration.js"></script>') >= 0 &&
  read('InternalBeyond.html').indexOf('economy-configuration-core.js') < read('InternalBeyond.html').indexOf('assets/js/economy-configuration.js'));

check('A6 ★★★ core.js 的路由先装外壳、再渲染 P22-15（后者一行未动）',
  (function () {
    const core = read('assets/js/core.js');
    const shellAt = core.indexOf('IB.economyConfigurationUI.render()');
    const apprAt = core.indexOf('IB.economyApprovalUI.render()');
    return shellAt > 0 && apprAt > shellAt &&
      core.indexOf("if(page==='economy'){try{if(window.IB&&IB.economyApprovalUI&&typeof IB.economyApprovalUI.render==='function')IB.economyApprovalUI.render()}catch(e){}}") >= 0;
  })());

check('A7 ★★★ client seam 只多了一个写方法，而且它的 GET 读取器仍然没有 method 参数（POST 被钉死）',
  (function () {
    const client = read('assets/js/home-node-client.js');
    return (clientCodeStripped.match(/\/internal\/economy\/configuration/g) || []).length === 1 &&
      (clientCodeStripped.match(/economyConfiguration: function/g) || []).length === 1 &&
      /getJson: function \(pathname, query\)/.test(client) &&
      /economyConfiguration: function \(options\)/.test(client);
  })());

section('B · 初始化状态由权威读面回答，不是这一页猜的');

check('B1 ★★★ "钱包在 ⟹ 初始额度发过了"这条耦合被逐字钉在 store 的源码上（openWallet 只有一个调用方）',
  (function () {
    const store = read('services/home-node/economy-store.js');
    const calls = store.match(/openWallet\(\{/g) || [];
    const defs = store.match(/function openWallet\(/g) || [];
    /* 一处定义 + 一处调用（就在 bootstrapInitialCredit 的事务里）。 */
    return defs.length === 1 && calls.length === 1 &&
      store.indexOf('const walletResult = openWallet({ owner: owner.party, currency: cur.currency });') >= 0;
  })());

section('C · ① 初始额度：fresh 时有一个、已初始化后一个都没有');

{
  const firstWorld = defaultWorld();
  const m = mount(firstWorld);
  m.ui.render();
  await settle();

  check('C7 ★★★ 页签开合不搬动 P22-15 的节点：`#economy-requests` 还在原来的父节点下，而且外壳插在它前面',
    m.dom.requests.parentNode === m.dom.page &&
    m.dom.page.children.indexOf(byId(m.dom.doc, m.core.ID.HOST)) === 0 &&
    m.dom.page.children.indexOf(m.dom.requests) === 1,
    { children: m.dom.page.children.map(c => c.id) });

  check('C8 ★★★ 默认页签是「待处理」：`#economy-requests` 可见（display 未被改动），三块配置面板都 hidden',
    m.dom.requests.style.display === '' &&
    m.core.SECTIONS.filter(s => s.paneId != null).every(s => byId(m.dom.doc, s.paneId).hidden === true));

  m.ui.show('wallet');
  await settle();

  const wallet = panelOf(m, 'wallet');
  const text = textOf(wallet);
  /* ★ P22-22：说的是**系统状态**（尚未完成 Initial Bootstrap），不是"没有
     钱包"；并逐字要求"谁创建它"与"为什么只有一次"在场。判定语义没变：
     仍然给一次性初始化输入框，仍然只有一个可执行的初始额度按钮。 */
  check('C1 ★★★ fresh：尚未完成 Initial Bootstrap → 明确说"尚未完成 Initial Bootstrap"' +
    '（不是"没有钱包"）+ 账户由 Economy authority 创建、只发放一次，并给一次性初始化输入',
    text.indexOf('尚未完成 Initial Bootstrap') >= 0 && text.indexOf('没有 IB Credit 钱包') < 0 &&
    text.indexOf('Economy authority') >= 0 && text.indexOf('只能发放一次') >= 0 &&
    !!inputByName(m.dom.doc, 'bootstrapAmount'),
    { text: text.slice(0, 200) });

  check('C2 ★★★ fresh：唯一的初始额度按钮需要**两步确认**（一次点击不发送任何请求）',
    (function () {
      const btn = buttonByText(wallet, m.core.COPY.walletSet);
      if (btn.length !== 1) return false;
      btn[0].click();
      return m.driver.calls.writes.length === 0 &&
        textOf(panelOf(m, 'wallet')).indexOf(m.core.COPY.walletSetAsk) >= 0;
    })(), { writes: m.driver.calls.writes.length });

  check('C3 ★★★ 两步确认的第一步不会把用户刚填的金额弄丢（重画之后输入框里还是它）',
    (function () {
      const input = inputByName(m.dom.doc, 'bootstrapAmount');
      return !!input && input.value === '1000';
    })() && (function () {
      /* 走"再想想"回到第一步，改一个数，再点确认 —— 值必须在重画之后还在。 */
      const keep = buttonByText(panelOf(m, 'wallet'), m.core.COPY.walletSetNo);
      if (keep.length !== 1) return false;
      keep[0].click();
      typeInto(inputByName(m.dom.doc, 'bootstrapAmount'), '1250');
      buttonByText(panelOf(m, 'wallet'), m.core.COPY.walletSet)[0].click();
      const after = inputByName(m.dom.doc, 'bootstrapAmount');
      return !!after && after.value === '1250' && m.driver.calls.writes.length === 0;
    })());

  typeInto(inputByName(m.dom.doc, 'bootstrapAmount'), '1000');
  firstWorld.write = function () {
    firstWorld.wallet = { ok: true, wallet: {
      walletId: 'econ_wallet_bootstrap', currency: 'IB_CREDIT', state: 'READY', balanceKnown: true,
      ledgerBalanceMinor: '100000', reservedBalanceMinor: '0', availableBalanceMinor: '100000'
    } };
    return { ok: true, command: 'BOOTSTRAP_CREDIT', configuredAnything: true,
      initialCreditBootstrapped: true, initialCreditMintedNow: true, walletId: 'econ_wallet_bootstrap' };
  };
  buttonByText(panelOf(m, 'wallet'), m.core.COPY.walletSet)[0].click();
  await settle();
  const w1 = m.driver.calls.writes;
  check('C4 ★★★ 请求真的发出去了，而且它的形状就是 canonical 信封',
    w1.length === 1 &&
    JSON.stringify(Object.keys(w1[0]).sort()) === JSON.stringify(['command', 'config', 'idempotencyKey']) &&
    JSON.stringify(Object.keys(w1[0].config).sort()) === JSON.stringify(['amountMinor', 'currency', 'ownerId']) &&
    w1[0].command === 'BOOTSTRAP_CREDIT' &&
    w1[0].config.ownerId === 'a1' &&
    w1[0].config.currency === 'IB_CREDIT' &&
    w1[0].config.amountMinor === '100000',
    w1[0]);

  check('C5 ★★★ 保存之后**重新读**权威：这一轮里 /economy/wallet 又被读了一次（不是乐观宣称）',
    (function () {
      const w = m.driver.calls.reads.filter(r => r.path === '/economy/wallet');
      return w.length >= 2;
    })(), { reads: m.driver.calls.reads.length });

  check('C5b ★★★ Bootstrap 读回钱包后刷新 Economy 概览，余额与时间线不会停留在旧缓存',
    m.shellRefreshCount() === 1 &&
    m.ui.snapshot().view.wallet.state === 'present',
    { shellRefreshes: m.shellRefreshCount(), wallet: m.ui.snapshot().view.wallet.state });

  const defaultRun = mount(defaultWorld());
  defaultRun.ui.show('wallet');
  await settle();
  buttonByText(panelOf(defaultRun, 'wallet'), defaultRun.core.COPY.walletSet)[0].click();
  buttonByText(panelOf(defaultRun, 'wallet'), defaultRun.core.COPY.walletSet)[0].click();
  await settle();
  check('C5c ★★★ 不改默认值直接二次确认：实际 payload 包含 1000 IB Credit（100000 minor）',
    defaultRun.driver.calls.writes.length === 1 &&
    defaultRun.driver.calls.writes[0].config.amountMinor === '100000',
    defaultRun.driver.calls.writes[0]);

  check('C6 ★★★ `/economy/*` 上的**写**请求仍然是 0：所有的写都落在 /internal/economy/configuration',
    m.driver.calls.reads.every(r => r.path.indexOf('/economy/') === 0 || r.path === '/security') &&
    m.driver.calls.writes.every(b => b.command !== 'MINT' && b.command !== 'BUY') &&
    /* 假 driver 的 economyConfiguration 是唯一的写入口，因此"写了几次"就是
       "发了几次配置请求" —— 而 /economy/* 那次读面里没有任何一条是写。 */
    true);

  check('C9 ★★★ 切到「钱包」：`#economy-requests` 只被 display 关掉（节点本身没有被改动）',
    (function () {
      m.ui.show('wallet');
      return m.dom.requests.style.display === 'none' &&
        byId(m.dom.doc, m.core.ID.WALLET_PANE).hidden === false &&
        m.dom.requests.parentNode === m.dom.page &&
        m.dom.requests.children.length === 0;
    })());

  /* ── 已初始化：一个可执行的初始化按钮都不能有 ────────────────────── */
  const world2 = defaultWorld();
  world2.wallet = {
    ok: true, wallet: {
      walletId: 'econ_wallet_1', currency: 'IB_CREDIT', state: 'READY', balanceKnown: true,
      ledgerBalanceMinor: '100000', reservedBalanceMinor: '0', availableBalanceMinor: '100000'
    }
  };
  world2.policy = { ok: true, policy: { policyId: 'econ_bp_1', currency: 'IB_CREDIT', status: 'ACTIVE', limits: { perTransactionMinor: '5000', dailyMinor: '20000' }, revision: 2, autonomyLevel: 'LIMITED' } };
  world2.snapshot = { ok: true, snapshot: { spentTodayMinor: '5000' }, decision: { outcome: 'ALLOW' } };
  const m2 = mount(world2);
  m2.ui.show('wallet');
  await settle();
  const w2panel = panelOf(m2, 'wallet');
  const w2text = textOf(w2panel);

  check('C10 ★★★ 已初始化：明确显示"初始额度已设置"，并且**没有**初始额度输入框',
    w2text.indexOf('初始额度已设置') >= 0 && !inputByName(m2.dom.doc, 'bootstrapAmount'),
    { text: w2text.slice(0, 200) });

  check('C11 ★★★ 已初始化：整个钱包面板里**一个主按钮都没有** —— 不会出现第二个可执行的初始化',
    find(w2panel, 'ecfg-btn-primary').length === 0 &&
    buttonByText(w2panel, m2.core.COPY.walletSet).length === 0,
    find(w2panel, 'ecfg-btn-primary').map(b => b.textContent));

  check('C12 ★★★ 当前额度读的是权威给的数，主数是"当前可用"',
    w2text.indexOf('1000.00 IB Credit') >= 0 && w2text.indexOf('当前可用') >= 0,
    { text: w2text.slice(0, 200) });

  check('C13 ★★★ 每日刻度：已用与上限都来自读面 → 25% 的真实宽度（不编进度）',
    (function () {
      m2.ui.show('budget');
      const meter = find(panelOf(m2, 'budget'), 'ecfg-meter-fill');
      return meter.length === 1 && meter[0].style.width === '25%' &&
        textOf(panelOf(m2, 'budget')).indexOf('50.00 IB Credit') >= 0;
    })());
}

section('D · ② 预算表单 → canonical config（逐字节比对请求体）');

{
  const world = defaultWorld();
  world.wallet = { ok: true, wallet: { walletId: 'w', currency: 'IB_CREDIT', state: 'READY', balanceKnown: true, ledgerBalanceMinor: '100000', availableBalanceMinor: '100000', reservedBalanceMinor: '0' } };
  world.policy = { ok: true, policy: { policyId: 'econ_bp_1', currency: 'IB_CREDIT', status: 'ACTIVE', limits: { perTransactionMinor: '5000', dailyMinor: '20000' }, revision: 2, autonomyLevel: 'LIMITED' } };
  world.write = function () { return { ok: true, command: 'PUT_BUDGET_POLICY', configuredAnything: true, budgetPolicyWritten: true, replayed: false, policyId: 'econ_bp_1', policyRevision: 3 }; };
  const m = mount(world);
  m.ui.show('budget');
  await settle();

  check('D1 ★★★ 表单初值来自权威读面：现在生效的值就是输入框里的值',
    inputByName(m.dom.doc, 'limit-perTransactionMinor').value === '50.00' &&
    inputByName(m.dom.doc, 'limit-dailyMinor').value === '200.00' &&
    inputByName(m.dom.doc, 'limit-approvalThresholdMinor').value === '');

  check('D2 ★★ 高级设置默认是收起的（不铺满整页）',
    (function () {
      const body = find(panelOf(m, 'budget'), 'ecfg-advanced-body');
      return body.length === 1 && body[0].hidden === true;
    })());

  /* 改两格：单次 80、每日 400、确认线 60，周/月留空 */
  typeInto(inputByName(m.dom.doc, 'limit-perTransactionMinor'), '80');
  typeInto(inputByName(m.dom.doc, 'limit-dailyMinor'), '400');
  typeInto(inputByName(m.dom.doc, 'limit-approvalThresholdMinor'), '60');

  buttonByText(panelOf(m, 'budget'), m.core.COPY.save)[0].click();
  await settle();

  const bw = m.driver.calls.writes;
  check('D3 ★★★ 预算请求体逐字节是 canonical config：command / config / idempotencyKey，且 limits 只有改了的那些',
    bw.length === 1 &&
    JSON.stringify(Object.keys(bw[0]).sort()) === JSON.stringify(['command', 'config', 'idempotencyKey']) &&
    bw[0].command === 'PUT_BUDGET_POLICY' &&
    JSON.stringify(Object.keys(bw[0].config).sort()) === JSON.stringify(['autonomyLevel', 'currency', 'ifRevision', 'limits', 'ownerId']) &&
    bw[0].config.ownerId === 'a1' && bw[0].config.currency === 'IB_CREDIT' && bw[0].config.ifRevision === 2 &&
    /* ★ 没被改动的 autonomyLevel 会**原样带上**：一次全量替换里把它漏掉
       等于顺手把用户没动过的一个字段清空。 */
    bw[0].config.autonomyLevel === 'LIMITED' &&
    JSON.stringify(bw[0].config.limits) === JSON.stringify({ perTransactionMinor: '8000', dailyMinor: '40000', approvalThresholdMinor: '6000' }),
    bw[0]);

  check('D4 ★★★ 幂等键是 canonical 形状，而且就是纯层构造的那一个',
    /^[a-z0-9-]+$/.test(bw[0].idempotencyKey) && bw[0].idempotencyKey.indexOf('ui-') === 0);

  check('D5 ★★★ 保存之后重新读了权威（/economy/policy 被读了第二次）',
    m.driver.calls.reads.filter(r => r.path === '/economy/policy').length >= 2);

  check('D6 ★★★ 成功文案只说"规则已保存"，**没有**任何一句说现在可以买了',
    (function () {
      const text = textOf(panelOf(m, 'budget'));
      return text.indexOf(m.core.COPY.budgetSaved) >= 0 &&
        ['可以买', '现在可以', '已解锁', '放行'].every(w => text.indexOf(w) < 0);
    })(), textOf(panelOf(m, 'budget')).slice(0, 240));
}

section('E · ③ 自主表单 → canonical config；空选集 = 省略');

{
  const world = defaultWorld();
  world.wallet = { ok: true, wallet: { walletId: 'w', currency: 'IB_CREDIT', state: 'READY', balanceKnown: true, ledgerBalanceMinor: '100000', availableBalanceMinor: '100000', reservedBalanceMinor: '0' } };
  world.autonomy = {
    ok: true, policy: {
      policyId: 'econ_bp_2', enabled: true, perPurchaseLimitMinor: '8000', dailyAutonomousLimitMinor: '30000',
      approvalAboveMinor: '4000', allowedProductKinds: ['SERVICE'], allowedSettlementTypes: ['COMPUTE_GRANT'],
      allowGift: false, revision: 5, usable: true
    }
  };
  world.write = function () { return { ok: true, command: 'PUT_AUTONOMY_POLICY', configuredAnything: true, autonomyPolicyWritten: true, replayed: false, policyId: 'econ_bp_2', policyRevision: 6 }; };
  const m = mount(world);
  m.ui.show('autonomy');
  await settle();

  check('E1 ★★★ 表单初值来自读面：开关 / 两个上限 / 确认线 / 类别 / 交付方式都对上了',
    checkboxesNamed(m.dom.doc, 'enabled')[0].checked === true &&
    inputByName(m.dom.doc, 'perPurchaseLimitMinor').value === '80.00' &&
    inputByName(m.dom.doc, 'dailyAutonomousLimitMinor').value === '300.00' &&
    inputByName(m.dom.doc, 'approvalAboveMinor').value === '40.00' &&
    checkboxesNamed(m.dom.doc, 'kind-SERVICE')[0].checked === true &&
    checkboxesNamed(m.dom.doc, 'kind-CONSUMABLE')[0].checked === false &&
    checkboxesNamed(m.dom.doc, 'settle-COMPUTE_GRANT')[0].checked === true &&
    checkboxesNamed(m.dom.doc, 'allowGift')[0].checked === false);

  check('E2 ★★★ §4 要求表达的那几项都在页面上，而且明说 canonical 里没有"商店范围"',
    (function () {
      const text = textOf(panelOf(m, 'autonomy'));
      return ['允许自主购买', '单次自主购买上限', '每日自主购买上限', '超过多少需要我确认',
        '允许购买的商品范围', '允许的交付方式', '允许送礼'].every(w => text.indexOf(w) >= 0) &&
        text.indexOf('没有「商店范围」这一项') >= 0;
    })(), textOf(panelOf(m, 'autonomy')).slice(0, 300));

  check('E3 ★★★ 页面上有那句"仍受 Budget / 报价 / Approval 约束"，而且没有"完全放权"这一类按钮',
    (function () {
      const text = textOf(panelOf(m, 'autonomy'));
      return text.indexOf(m.core.COPY.autonomyAuthorityNote) >= 0 &&
        ['完全放权', '无限自主', '不再询问', '随便花'].every(w => text.indexOf(w) < 0);
    })());

  /* 改：允许送礼、加一个类别、每日改成 500 */
  setChecked(checkboxesNamed(m.dom.doc, 'allowGift')[0], true);
  setChecked(checkboxesNamed(m.dom.doc, 'kind-COMPUTE_CREDIT')[0], true);
  typeInto(inputByName(m.dom.doc, 'dailyAutonomousLimitMinor'), '500');
  buttonByText(panelOf(m, 'autonomy'), m.core.COPY.save)[0].click();
  await settle();

  const aw = m.driver.calls.writes;
  check('E4 ★★★ 自主请求体逐字节是 canonical config（含 ifRevision = 权威给的 revision）',
    aw.length === 1 &&
    aw[0].command === 'PUT_AUTONOMY_POLICY' &&
    JSON.stringify(Object.keys(aw[0].config).sort()) === JSON.stringify([
      'allowGift', 'allowedProductKinds', 'allowedSettlementTypes', 'approvalAboveMinor',
      'dailyAutonomousLimitMinor', 'enabled', 'ifRevision', 'ownerId', 'perPurchaseLimitMinor']) &&
    aw[0].config.ownerId === 'a1' && aw[0].config.ifRevision === 5 &&
    aw[0].config.enabled === true && aw[0].config.allowGift === true &&
    JSON.stringify(aw[0].config.allowedProductKinds) === JSON.stringify(['COMPUTE_CREDIT', 'SERVICE']) &&
    JSON.stringify(aw[0].config.allowedSettlementTypes) === JSON.stringify(['COMPUTE_GRANT']) &&
    aw[0].config.dailyAutonomousLimitMinor === '50000' &&
    aw[0].config.approvalAboveMinor === '4000',
    aw[0]);

  check('E5 ★★★ 自主保存文案同样不说"可以买"，并且提醒仍要逐笔通过余额 / 预算 / 报价',
    (function () {
      const text = textOf(panelOf(m, 'autonomy'));
      return text.indexOf(m.core.COPY.autonomySaved) >= 0 &&
        text.indexOf('不表示现在就可以买') >= 0 &&
        text.indexOf('现在可以买') < 0;
    })());
}

section('F · ④ 非法输入 fail closed：一个请求都不发');

{
  const m = mount(defaultWorld());
  m.ui.show('autonomy');
  await settle();

  check('F1 ★★★ 两个上限空着 → 点保存不发任何请求，而且给出一句人话（不是静默失败）',
    (function () {
      typeInto(inputByName(m.dom.doc, 'perPurchaseLimitMinor'), '');
      typeInto(inputByName(m.dom.doc, 'dailyAutonomousLimitMinor'), '');
      buttonByText(panelOf(m, 'autonomy'), m.core.COPY.save)[0].click();
      return m.driver.calls.writes.length === 0;
    })(), { writes: m.driver.calls.writes.length });

  await settle();
  check('F2 ★★★ fail closed 的反馈出现在页面上，而且指名是哪一格（不是一句笼统的失败）',
    textOf(panelOf(m, 'autonomy')).indexOf('「单次自主购买上限」这一格必须填') >= 0,
    textOf(panelOf(m, 'autonomy')).slice(0, 200));

  check('F3 ★★★ 三个小数位这一类"看起来像金额"的输入同样 fail closed，而且说的是形状而不是经济结论',
    (function () {
      typeInto(inputByName(m.dom.doc, 'perPurchaseLimitMinor'), '1.234');
      typeInto(inputByName(m.dom.doc, 'dailyAutonomousLimitMinor'), '10');
      buttonByText(panelOf(m, 'autonomy'), m.core.COPY.save)[0].click();
      const text = textOf(panelOf(m, 'autonomy'));
      return m.driver.calls.writes.length === 0 &&
        text.indexOf('「单次自主购买上限」这一格需要一个金额') >= 0 &&
        text.indexOf('规则已保存') < 0;
    })(), textOf(panelOf(m, 'autonomy')).slice(0, 200));

  const m3 = mount(defaultWorld());
  m3.ui.show('wallet');
  await settle();
  check('F4 ★★★ 初始额度填 0 或空 → 不发请求（0 会把一次性事实用掉而一分钱也没发）',
    (function () {
      typeInto(inputByName(m3.dom.doc, 'bootstrapAmount'), '0');
      buttonByText(panelOf(m3, 'wallet'), m3.core.COPY.walletSet)[0].click();
      buttonByText(panelOf(m3, 'wallet'), m3.core.COPY.walletSet)[0].click();
      return m3.driver.calls.writes.length === 0;
    })());
  await settle();
}

section('G · 权威拒绝 → 原样呈现，不做乐观成功');

{
  const world = defaultWorld();
  world.wallet = { ok: false, error: 'wallet-not-found', status: 404 };
  world.write = function () {
    return {
      ok: false, refused: true, reachedStore: true, status: 409, command: 'BOOTSTRAP_CREDIT',
      reasonCode: 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED',
      downstreamReasonCode: 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED',
      errors: ['initial-credit-is-one-shot-per-owner-and-currency']
    };
  };
  const m = mount(world);
  m.ui.show('wallet');
  await settle();
  typeInto(inputByName(m.dom.doc, 'bootstrapAmount'), '1000');
  buttonByText(panelOf(m, 'wallet'), m.core.COPY.walletSet)[0].click();
  await settle();
  buttonByText(panelOf(m, 'wallet'), m.core.COPY.walletSet)[0].click();
  await settle();

  check('G1 ★★★ 被拒之后显示的是权威的话（人话），而不是"已保存"',
    (function () {
      const text = textOf(panelOf(m, 'wallet'));
      return text.indexOf('初始额度每人只能发一次') >= 0 && text.indexOf(m.core.COPY.walletJustSet) < 0;
    })(), textOf(panelOf(m, 'wallet')).slice(0, 240));

  check('G2 ★★★ 原词留在技术层里（用户能看到权威到底说了什么），但正文里没有它',
    allText(panelOf(m, 'wallet')).indexOf('initial-credit-is-one-shot-per-owner-and-currency') >= 0 &&
    textOutsideTechnical(panelOf(m, 'wallet')).indexOf('initial-credit-is-one-shot-per-owner-and-currency') < 0);

  const world2 = defaultWorld();
  world2.write = function () {
    return { ok: false, refused: true, reasonCode: 'ECONOMY_CONFIGURATION_BRAND_NEW_CODE', errors: [] };
  };
  const m2b = mount(world2);
  m2b.ui.show('wallet');
  await settle();
  typeInto(inputByName(m2b.dom.doc, 'bootstrapAmount'), '10');
  buttonByText(panelOf(m2b, 'wallet'), m2b.core.COPY.walletSet)[0].click();
  await settle();
  buttonByText(panelOf(m2b, 'wallet'), m2b.core.COPY.walletSet)[0].click();
  await settle();
  check('G3 ★★★ 未登记的拒绝码：兜底句 + 原词进技术层（不编一个听起来合理的解释）',
    textOf(panelOf(m2b, 'wallet')).indexOf('这次改动没有被接受') >= 0 &&
    allText(panelOf(m2b, 'wallet')).indexOf('ECONOMY_CONFIGURATION_BRAND_NEW_CODE') >= 0 &&
    textOutsideTechnical(panelOf(m2b, 'wallet')).indexOf('ECONOMY_CONFIGURATION_BRAND_NEW_CODE') < 0,
    textOf(panelOf(m2b, 'wallet')).slice(0, 200));
}

section('H · ⑤ 配置面关着 / 读不到：进页面就说清楚，**一个假按钮都没有**');

{
  const world = defaultWorld();
  world.gate = { implemented: true, open: false, configurationCommandsExposed: [], requiresConfiguredDesktopCredential: true };
  const m = mount(world);
  m.ui.show('wallet');
  await settle();
  const wallet = panelOf(m, 'wallet');

  check('H1 ★★★ 关着时钱包面板给出不可用状态与原因，而且**没有**初始额度按钮',
    textOf(wallet).indexOf(m.core.COPY.closedTitle) >= 0 &&
    textOf(wallet).indexOf(m.core.COPY.closedBody.slice(0, 12)) >= 0 &&
    find(wallet, 'ecfg-btn-primary').length === 0 &&
    buttonByText(wallet, m.core.COPY.walletSet).length === 0,
    { text: textOf(wallet).slice(0, 200) });

  check('H2 ★★★ 底层词（环境变量名）只在折叠的技术说明里出现，不在正文',
    textOutsideTechnical(wallet).indexOf('IB_HOME_NODE_TOKEN') < 0 &&
    textInsideTechnical(wallet).indexOf('IB_HOME_NODE_TOKEN') >= 0,
    { outside: textOutsideTechnical(wallet).slice(0, 200) });

  m.ui.show('budget');
  await settle();
  check('H3 ★★★ 预算与自主两块同样没有保存按钮',
    find(panelOf(m, 'budget'), 'ecfg-btn-primary').length === 0 &&
    find(panelOf(m, 'autonomy'), 'ecfg-btn-primary').length === 0);

  /* /security 读得到，但它**没有** configuration 那一节 → 回答"不知道"。
     这与"关着"是两件事：不知道的时候不发按钮，但也不宣称它关着。 */
  const world2 = defaultWorld();
  world2.gate = undefined;
  const m2b = mount(world2);
  m2b.ui.show('wallet');
  await settle();
  check('H4 ★★★ /security 里没有 configuration 那一节时，回答的是"不知道"而不是"关着"（两件事）',
    textOf(panelOf(m2b, 'wallet')).indexOf(m2b.core.COPY.closedUnknown) >= 0 &&
    m2b.ui.snapshot().view.gateKnown === false &&
    find(panelOf(m2b, 'wallet'), 'ecfg-btn-primary').length === 0,
    { text: textOf(panelOf(m2b, 'wallet')).slice(0, 200), gateKnown: m2b.ui.snapshot().view.gateKnown });

  const m2c = mount(defaultWorld());
  m2c.ui.show('wallet');
  await settle();
  m2c.box.IB.__ibEconomyConfigDriver = { getJson: () => Promise.resolve({ ok: false, error: 'home-node-unreachable' }) };
  m2c.ui.refresh();
  await settle(20);
  check('H4b ★★★ 连不上本机节点时给的是"读不到 + 再试一次"，同样没有配置按钮',
    textOf(panelOf(m2c, 'wallet')).indexOf('连接不上本机节点') >= 0 &&
    find(panelOf(m2c, 'wallet'), 'ecfg-btn-primary').length === 0);

  const m3 = mount(defaultWorld(), { apiConfigs: [] });
  m3.ui.show('wallet');
  await settle();
  const m3pane = panelOf(m3, 'wallet');
  check('H5 ★★★ 一位角色都没有时：诚实的空状态，没有配置对象、也没有任何按钮',
    textOf(m3pane).indexOf(m3.core.COPY.ownerEmpty) >= 0 &&
    find(m3pane, 'ecfg-btn-primary').length === 0 &&
    m3.driver.calls.writes.length === 0 &&
    !byId(m3.dom.doc, 'economy-owner-select'),
    {
      text: textOf(m3pane).slice(0, 200),
      hasOwnerEmpty: textOf(m3pane).indexOf(m3.core.COPY.ownerEmpty) >= 0,
      ownerEmptyCopy: m3.core.COPY.ownerEmpty,
      primary: find(m3pane, 'ecfg-btn-primary').length,
      writes: m3.driver.calls.writes.length,
      hasSelect: !!byId(m3.dom.doc, 'economy-owner-select')
    });
}

section('I · ⑥ 视觉/文案纪律（渲染出来的字，而不是源码里的字）');

{
  const world = defaultWorld();
  const m = mount(world);
  const texts = [];
  for (const key of ['wallet', 'budget', 'autonomy']) {
    m.ui.show(key);
    await settle();
    texts.push(allText(panelOf(m, key)));
  }
  const blob = texts.join('\n');

  check('I1 ★★★ 渲染出来的全部文字里没有 §1 的禁用词',
    ['充值', '提现', '银行卡', '支付', '余额充值', '法币', '人民币', '美元', '¥', '￥']
      .every(w => blob.indexOf(w) < 0),
    ['充值', '提现', '银行卡', '支付', '余额充值', '法币', '人民币', '美元', '¥', '￥'].filter(w => blob.indexOf(w) >= 0));

  check('I2 ★★★ 渲染出来的文字里没有 emoji',
    !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(blob) &&
    !/[💰🪙💳🛒✨🎉🔒]/u.test(blob));

  check('I3 ★★★ 四个页签都在，而且顺序就是 §2 的信息架构',
    (function () {
      const tabs = find(byId(m.dom.doc, m.core.ID.TABS), 'ecfg-tab');
      return tabs.length === 4 &&
        tabs.map(t => t.textContent).join(',') === '待处理,钱包与初始额度,预算限制,自主购买';
    })(), find(byId(m.dom.doc, m.core.ID.TABS), 'ecfg-tab').map(t => t.textContent));

  check('I4 ★★★ 图标是 inline SVG 的线性图形，页面上没有一个位图、没有 emoji 当图标',
    (function () {
      const marks = find(byId(m.dom.doc, m.core.ID.HOST), 'ecfg-mark');
      const arts = find(byId(m.dom.doc, m.core.ID.HOST), 'ecfg-empty-art');
      return marks.length >= 1 && marks.every(x => x.innerHTML.indexOf('<svg') >= 0) &&
        arts.every(x => x.innerHTML.indexOf('<svg') >= 0) &&
        find(byId(m.dom.doc, m.core.ID.HOST), 'ecfg-card').every(c => allText(c).indexOf('.png') < 0);
    })());

  check('I7 ★★★ 渲染出来的文字里**没有** canonical 的原始代号（IB_CREDIT 这一类）—— 底层词只在折叠的技术层',
    (function () {
      const bad = ['IB_CREDIT', 'perTransactionMinor', 'dailyMinor', 'approvalThresholdMinor',
        'autonomyLevel', 'allowedProductKinds', 'perPurchaseLimitMinor'];
      const hits = bad.filter(w => blob.indexOf(w) >= 0);
      return hits.length === 0;
    })(), ['IB_CREDIT', 'perTransactionMinor', 'dailyMinor', 'approvalThresholdMinor', 'autonomyLevel', 'allowedProductKinds', 'perPurchaseLimitMinor']
      .filter(w => blob.indexOf(w) >= 0));

  check('I8 ★★★ 每一格的单位写的是用户认得的币种名（IB Credit），而不是契约里的代号',
    (function () {
      const units = find(byId(m.dom.doc, m.core.ID.HOST), 'ecfg-unit').map(n => n.textContent);
      return units.length >= 3 && units.every(u => u === 'IB Credit');
    })(), find(byId(m.dom.doc, m.core.ID.HOST), 'ecfg-unit').map(n => n.textContent).slice(0, 6));

  check('I5 ★★★ 配置对象选择器列的是 apiConfigs 里的角色，默认选中第一位',
    (function () {
      const sel = byId(m.dom.doc, 'economy-owner-select');
      return !!sel && sel.children.length === 2 &&
        sel.children.map(o => o.value).join(',') === 'a1,a2' &&
        sel.children[0].selected === true &&
        m.ui.snapshot().ownerId === 'a1';
    })());

  check('I5b ★★★ 角色目录的两条**活**入口在生产里都在（顶层 let + ibSocialLive 的活 getter），而渲染器两条都读',
    (function () {
      const social = read('assets/js/social.js');
      return /^let apiConfigs=/m.test(social) &&
        social.indexOf("ibSocialLive('apiConfigs'") > 0 &&
        uiCode.indexOf('typeof apiConfigs !==') > 0 &&
        uiCode.indexOf('window[name]') > 0;
    })());

  check('I5c ★★★ 只留裸标识符那一条（把 window 那条删掉）时，这一页照样工作 —— 它不依赖任何单独一条',
    (function () {
      const before = m.ui.snapshot().owners.length;
      const hadWindow = Array.isArray(m.box.apiConfigs);
      delete m.box.apiConfigs;
      m.ui.refresh();
      const after = m.ui.snapshot().owners.length;
      Object.defineProperty(m.box, 'apiConfigs', {
        get: function () { return m.box.__roleState.configs; },
        set: function (v) { m.box.__roleState.configs = v; },
        configurable: true
      });
      m.ui.refresh();
      return before === 2 && hadWindow === true && after === 2 && m.ui.snapshot().owners.length === 2;
    })(), { owners: m.ui.snapshot().owners.length });

  check('I6 ★★★ 配置对象里**没有**「我」这一项 —— 把政策挂到 user:user 上对 Agent 购买无效',
    (function () {
      const sel = byId(m.dom.doc, 'economy-owner-select');
      return sel && sel.children.every(o => String(o.value) !== 'user' && String(o.textContent) !== '我');
    })());
}

section('J · ⑦ P22-15 不回归的结构保证');

{
  check('J1 ★★★ 渲染器从不修改 `#economy-requests` 的子树内容（只有 style.display 一处）',
    (function () {
      const hits = uiSrc.match(/REQUESTS_HOST[\s\S]{0,220}/g) || [];
      return hits.every(h => h.indexOf('textContent') < 0 && h.indexOf('appendChild') < 0 && h.indexOf('innerHTML') < 0) &&
        uiCode.indexOf("requests.style.display") >= 0 &&
        (uiSrc.match(/economy-requests/g) || []).length <= 3;
    })());

  check('J2 ★★★ 只有「待处理」页签才去调 P22-15 的渲染器（其余三个页签一次都不碰它）',
    uiCode.indexOf('NS.economyApprovalUI') >= 0 &&
    (function () {
      const i = uiCode.indexOf('if (section === CORE.SECTION.REQUESTS) {');
      if (i < 0) return false;
      const block = uiCode.slice(i, i + 260);
      return block.indexOf('economyApprovalUI') >= 0 && block.indexOf('render()') >= 0;
    })());

  check('J3 ★★★ 三个配置面板的 id 与 P22-15 的容器 id 是**不同**的 id（不会撞车）',
    [CORE_REF.ID.WALLET_PANE, CORE_REF.ID.BUDGET_PANE, CORE_REF.ID.AUTONOMY_PANE]
      .every(id => id.indexOf('economy-config') === 0) &&
    CORE_REF.ID.HOST !== CORE_REF.ID.REQUESTS_HOST &&
    CORE_REF.ID.REQUESTS_HOST === 'economy-requests' &&
    CORE_REF.ID.PAGE === 'page-economy',
    { host: CORE_REF.ID.HOST, requests: CORE_REF.ID.REQUESTS_HOST });

  const cssRelAssignments = uiCode.match(/link\.rel\s*=\s*'stylesheet'/g) || [];
  check('J4 ★★★ Economy CSS 只有一个运行时注入点，且 DOM id guard 防止重复加载',
    cssRelAssignments.length === 1 &&
    /if\s*\(byId\(DOM\.STYLE_ID\)\)\s*return;/.test(uiCode) &&
    /link\.id\s*=\s*DOM\.STYLE_ID;/.test(uiCode) &&
    /link\.href\s*=\s*DOM\.STYLE_HREF;/.test(uiCode) &&
    ECONOMY_CSS_STATIC_LINKS.length === 0);
}

console.log('\n结果: ' + checks + ' 通过, ' + failures + ' 失败');
process.exit(failures ? 1 : 0);
})();
