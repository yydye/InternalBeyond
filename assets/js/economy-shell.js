/* ====================================================================
   IB · Economy Shell — 渲染器（P22-17）
   --------------------------------------------------------------------
   这一页是 Economy 的**门面**：用户真正会长期看的那一页。
   它回答四件事，而答案全部由本机节点的权威给出：

     概览     —— 这个角色现在能动用多少内部额度、预算是什么、最近买了什么
     商店     —— 有哪些货架、货架上有什么、每件多少钱、什么状态
     我的资产 —— 这个角色现在持有什么（物品 / 算力额度）
     待处理   —— 复用 P22-15（本模块只开合它的可见性）
     设置     —— 复用 P22-16（本模块只开合它的可见性）

   ── 它**不是**什么（§5/§8/§9）────────────────────────────────────
   · 不是银行 App：没有充值 / 提现 / 转账 / 银行卡 / 现金 / 账户价值，
     也没有把余额做成一整块霓虹数字。
   · 不是商城：商品卡上**没有**购买按钮。canonical 到今天为止没有
     "人类直接购买"这条接缝，本阶段**不造**（见 docs 的审计）。
   · 不是账本编辑器：整页只读。它不知道自己拥有任何账本、铸币、
     转账或退款能力 —— 那些名字在这个文件里一次都不出现。
   · 不是推荐系统：顺序就是读面给的顺序，没有排序分数、没有亲和度。

   ── DOM 与逻辑的分工（与 P22-15/16 同款）──────────────────────────
   · 视图模型、状态词表、金额格式化、确定性视觉身份全在
     assets/js/economy-shell-core.js（纯层，可在 Node 里测）；
   · 本文件只做四件事：注入样式表、读八条既有只读面、建 DOM、
     把用户手势变成一次重新读取。

   ── 与 P22-15/16 的边界（**结构**事实，不是约定）──────────────────
   · 本文件不建 P22-15 的任何卡片，也不建 P22-16 的任何表单；
     它对这两个模块只调用各自公开的 render() / show()。
   · 本文件不搬动 `#economy-requests` 与 `#economy-configuration`
     两个节点 —— 它们仍在 `#page-economy` 的第 1、2 个位置（P22-16
     的视觉断言逐字依赖这一点）。本模块**追加**自己的节点，并用一个
     页面级 class 决定谁可见。
   ==================================================================== */
(function (NS) {
'use strict';

var CORE = NS.economyShellCore;
if (!CORE) return; /* 纯层没加载：整页不渲染，而不是渲染一个错的页面 */

var DOM = {
  STYLE_ID: 'ib-econ-shell-style',
  STYLE_HREF: 'assets/css/economy-shell.css'
};

/* ── 24×24 · currentColor · 统一 stroke ────────────────────────────────
   没有 emoji，没有位图，没有外部依赖，两套主题自动适配（§10）。
   ★ `open` 与 `lock` 只差锁梁那一笔：一把关着、一把开着 —— 状态不同
     而语言相同，正是这一域要的"安静"。 */
var MARK = Object.freeze({
  credit: '<rect x="3.2" y="6.4" width="17.6" height="11.2" rx="2.6"/><path d="M3.2 10.2h17.6"/><circle cx="16.4" cy="13.9" r="1.05"/>',
  compute: '<rect x="7.8" y="7.8" width="8.4" height="8.4" rx="1.6"/><path d="M10.2 4.6v3.2M13.8 4.6v3.2M10.2 16.2v3.2M13.8 16.2v3.2M4.6 10.2h3.2M4.6 13.8h3.2M16.2 10.2h3.2M16.2 13.8h3.2"/>',
  item: '<path d="M12 3.5l7.2 4.1v8.8L12 20.5 4.8 16.4V7.6z"/><path d="M4.8 7.6L12 11.7l7.2-4.1M12 11.7v8.8"/>',
  service: '<circle cx="12" cy="12" r="3"/><path d="M12 3.8v2.1M12 18.1v2.1M4.8 12h2.1M17.1 12h2.1M7 7l1.5 1.5M15.5 15.5L17 17M17 7l-1.5 1.5M8.5 15.5L7 17"/>',
  store: '<path d="M4.4 9.4l1.3-4.4h12.6l1.3 4.4"/><path d="M4.4 9.4h15.2v9.8H4.4z"/><path d="M9.6 19.2v-4.9h4.8v4.9"/>',
  inventory: '<path d="M3.9 7.6h16.2v3.6H3.9z"/><path d="M5.5 11.2h13v7.9h-13z"/><path d="M9.9 14.9h4.2"/>',
  history: '<path d="M12 6.4v5.6l3.4 2.1"/><path d="M4.9 12a7.1 7.1 0 1 0 2.2-5.1"/><path d="M4.7 4.9v3.2h3.2"/>',
  lock: '<rect x="5.5" y="10.6" width="13" height="8.8" rx="2.2"/><path d="M8.7 10.6V8.3a3.3 3.3 0 0 1 6.6 0v2.3"/><path d="M12 14.2v2"/>',
  unlock: '<rect x="5.5" y="10.6" width="13" height="8.8" rx="2.2"/><path d="M8.7 10.6V8.3a3.3 3.3 0 0 1 6.2-1.3"/><path d="M12 14.2v2"/>'
});

/* ── 商品占位块的 5 张确定性线稿（§4）────────────────────────────────
   ★ 它们**只是**装饰：选哪一张由 productId 的哈希决定，而哈希不进
     价格、不进排序、不进推荐、不进"能不能申请"。 */
var IDENTITY_MARKS = Object.freeze([
  '<circle cx="12" cy="12" r="7.4"/><path d="M12 4.6v14.8"/>',
  '<path d="M4.8 19.2L12 4.8l7.2 14.4z"/>',
  '<path d="M4.8 12h14.4"/><path d="M12 4.8v14.4"/>',
  '<path d="M4.8 4.8h14.4v14.4H4.8z"/><path d="M4.8 15.6l7.2-6.4 7.2 6.4"/>',
  '<path d="M5.6 17.6c3.4-9.6 9.4-9.6 12.8 0"/><path d="M7.6 9.6h8.8"/>'
]);

/* ── 空状态：安静的一件轮廓物（§10：160×120 · 线性 · currentColor）── */
var EMPTY_ART = Object.freeze({
  inventory: ['<svg viewBox="0 0 160 120" width="160" height="120" fill="none" stroke="currentColor"',
    ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    '<path d="M40 44h80v10H40z"/>',
    '<path d="M46 54h68v34H46z"/>',
    '<path d="M70 68h20"/>',
    '<path d="M60 30h40" opacity=".45"/>',
    '<path d="M54 96h52" opacity=".25"/>',
    '</svg>'].join(''),
  catalog: ['<svg viewBox="0 0 160 120" width="160" height="120" fill="none" stroke="currentColor"',
    ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    '<path d="M36 46h88v56H36z"/>',
    '<path d="M44 32h72l8 14H36z"/>',
    '<path d="M66 66h28v14H66z"/>',
    '<path d="M52 24h56" opacity=".4"/>',
    '</svg>'].join(''),
  history: ['<svg viewBox="0 0 160 120" width="160" height="120" fill="none" stroke="currentColor"',
    ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    '<circle cx="80" cy="60" r="30"/>',
    '<path d="M80 42v18l12 7"/>',
    '<path d="M44 34l8 8" opacity=".5"/>',
    '<path d="M116 34l-8 8" opacity=".5"/>',
    '</svg>'].join(''),
  wallet: ['<svg viewBox="0 0 160 120" width="160" height="120" fill="none" stroke="currentColor"',
    ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    '<rect x="36" y="42" width="88" height="52" rx="10"/>',
    '<path d="M36 58h88"/>',
    '<circle cx="108" cy="76" r="4.4"/>',
    '<path d="M64 32h32" opacity=".4"/>',
    '</svg>'].join('')
});

function boot() {
  if (typeof document === 'undefined' || !document.head) return;

  injectStyle();

  /* ── 状态 ─────────────────────────────────────────────────────── */
  var tab = CORE.TAB.OVERVIEW;
  var ownerId = null;
  var stage = 'idle';                 /* idle | loading | ready | failed */
  var view = null;
  var failure = null;
  var syncedAt = null;
  var owners = [];
  var seq = 0;
  /* P22-16 侧最后一次停留的配置分区：从「设置」离开再回来时回到同一格，
     而不是每次都跳回第一格。 */
  var lastConfigSection = 'wallet';
  var storeFilter = null;             /* null = 全部货架 */

  /* ── 最小 DOM 助手 ─────────────────────────────────────────────── */
  function byId(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function svgOf(body, size, cls) {
    var wrap = el('span', cls || null);
    wrap.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true" focusable="false">' + body + '</svg>';
    return wrap;
  }
  function artOf(body, cls) {
    var wrap = el('div', cls || null);
    wrap.innerHTML = body;
    return wrap;
  }
  function injectStyle() {
    if (byId(DOM.STYLE_ID)) return;
    var link = document.createElement('link');
    link.id = DOM.STYLE_ID;
    link.rel = 'stylesheet';
    link.href = DOM.STYLE_HREF;
    document.head.appendChild(link);
  }

  /* ── 传输 ───────────────────────────────────────────────────────
     ★ 唯一的出口是既有 remote driver（与 P22-15/16 同一条接缝）。
       本文件不出现 fetch()，因此"浏览器只能走既有只读面"是**结构**事实。
     ★ 测试注入入口：window.__ibEconomyShellDriver。它只替换 driver 实例，
       不改变任何读路径的构造点（那些写在纯层的 READS 里）。 */
  function driver() {
    if (NS.__ibEconomyShellDriver) return NS.__ibEconomyShellDriver;
    if (typeof NS.createHomeNodeRemote === 'function') return NS.createHomeNodeRemote({});
    return null;
  }
  function readJson(path, query) {
    var d = driver();
    if (!d || typeof d.getJson !== 'function') return Promise.resolve({ ok: false, error: 'transport-not-available' });
    return d.getJson(path, query || {});
  }

  /* ── 角色目录 ───────────────────────────────────────────────────
     ★ apiConfigs 是角色的唯一事实源（P4 契约）。这里**不**建第二套角色表，
       只把它读成一组选项；中文化 / 去重 / 归档标记复用 P22-16 纯层的
       ownerOptions（本阶段不建第二份解析）。
     ★ 生产里那个名字有**两个**入口，而且两个都是活的（实测）：
         · 裸标识符 —— assets/js/social.js:607 的顶层 `let apiConfigs`；
         · window.apiConfigs —— social.js:2654 用 ibSocialLive 注册的活
           getter/setter。
       与 P22-16 逐字同款两条都读：任一条单独存在时这一页都能工作。
       （`typeof 未声明名` 在严格模式与任何上下文里都不抛，因此这层安全。） */
  function roleList(bare, name) {
    try {
      var v = bare();
      if (Array.isArray(v)) return v;
    } catch (e) { /* 那个名字不在作用域里 */ }
    try {
      if (typeof window !== 'undefined' && Array.isArray(window[name])) return window[name];
    } catch (e) { /* 没有 window */ }
    return null;
  }
  function refreshOwners() {
    owners = CORE.ownerOptionsOf(
      roleList(function () { return (typeof apiConfigs !== 'undefined') ? apiConfigs : undefined; }, 'apiConfigs'),
      roleList(function () { return (typeof archivedConfigs !== 'undefined') ? archivedConfigs : undefined; }, 'archivedConfigs')
    );
    var picked = CORE.resolveOwnerOf(owners, ownerId);
    ownerId = picked ? picked.id : null;
  }

  /* ── 读：八条既有只读面，一条新路由都没有 ──────────────────────────
     ★ 钱包 / 政策 / 库存 / 购买都要一个 ownerId（canonical 的归属键）；
       商店与商品目录刻意**不**带 owner —— 目录不是"给谁看"的（§40）。
     ★ /economy/budget 是既有的一次**只读**评估，而这一页只用它带回来的
       snapshot（权威自己算的当日累计）。decision 一个字段都不进模型：
       那是一次裁决，不是这一页要显示的事实（§8）。 */
  function load() {
    var my = ++seq;
    stage = view ? 'ready' : 'loading';
    failure = null;
    render();
    var oid = ownerId;
    var jobs = [
      readJson(CORE.READS.STORES, { status: 'ACTIVE', limit: CORE.LIMITS.STORES }),
      readJson(CORE.READS.PRODUCTS, { limit: CORE.LIMITS.PRODUCTS }),
      readJson(CORE.READS.INTENTS, { limit: CORE.LIMITS.INTENTS })
    ];
    if (oid) {
      jobs.push(readJson(CORE.READS.WALLET, { ownerId: oid }));
      jobs.push(readJson(CORE.READS.POLICY, { ownerId: oid }));
      jobs.push(readJson(CORE.READS.BUDGET, { ownerId: oid, currency: 'IB_CREDIT', amountMinor: '0' }));
      jobs.push(readJson(CORE.READS.INVENTORY, { ownerId: oid, limit: CORE.LIMITS.INVENTORY }));
      jobs.push(readJson(CORE.READS.PURCHASES, { buyerId: oid, limit: CORE.LIMITS.PURCHASES }));
    }
    return Promise.all(jobs).then(function (r) {
      if (my !== seq) return;
      var idx = 0;
      var storesRes = r[idx++], productsRes = r[idx++], intentsRes = r[idx++];
      var walletRes = oid ? r[idx++] : null;
      var policyRes = oid ? r[idx++] : null;
      var budgetRes = oid ? r[idx++] : null;
      var inventoryRes = oid ? r[idx++] : null;
      var purchasesRes = oid ? r[idx++] : null;
      /* 整页不可用只有一个判据：**传输**断了（不是某一条 404）。 */
      if (isTransportDown(walletRes) && isTransportDown(storesRes)) {
        stage = 'failed';
        failure = { code: 'home-node-unreachable' };
        view = null;
        render();
        return;
      }
      view = CORE.buildPageView({
        owner: oid,
        stores: storesRes, products: productsRes, intents: intentsRes,
        wallet: walletRes, policy: policyRes, budgetSnapshot: budgetRes,
        inventory: inventoryRes, purchases: purchasesRes,
        apiConfigs: roleList(function () { return (typeof apiConfigs !== 'undefined') ? apiConfigs : undefined; }, 'apiConfigs'),
        archivedConfigs: roleList(function () { return (typeof archivedConfigs !== 'undefined') ? archivedConfigs : undefined; }, 'archivedConfigs')
      });
      stage = 'ready';
      syncedAt = nowMs();
      render();
    }, function (error) {
      if (my !== seq) return;
      stage = 'failed';
      failure = { code: 'transport-error', detail: String((error && error.message) || error) };
      render();
    });
  }
  function isTransportDown(res) {
    if (!res || res.ok === true) return false;
    var e = String(res.error || '');
    return e === 'transport-not-available' || e === 'home-node-unreachable' ||
      e === 'home-node-transport-error' || res.offline === true;
  }
  function nowMs() { try { return Date.now(); } catch (e) { return 0; } }

  /* ── 外壳 ───────────────────────────────────────────────────────
     ① 外壳**追加**在 `#page-economy` 的最后，不搬动 P22-15/16 的两个
        节点（它们的结构断言逐字依赖原位置）；三者谁可见由**页面级
        class** 决定，而视觉顺序由 CSS 的 order 决定（§9）。
     ② `#economy-requests` 与 `#economy-configuration` 的可见性全部
        委托给 P22-16 自己的 show()：于是"哪一块归谁画"没有第二种状态，
        也不会出现"P22-16 的异步读回来之后把待处理重新显示出来"。 */
  function install() {
    var page = byId(CORE.ID.PAGE);
    if (!page) return null;
    var host = byId(CORE.ID.SHELL);
    if (host) return host;
    host = el('section', 'esh');
    host.id = CORE.ID.SHELL;
    host.setAttribute('aria-label', CORE.COPY.title);
    page.appendChild(host);
    return host;
  }
  function configUI() {
    var api = NS.economyConfigurationUI;
    return (api && typeof api.show === 'function') ? api : null;
  }
  function applyVisibility() {
    var page = byId(CORE.ID.PAGE);
    if (page && page.classList) {
      for (var i = 0; i < CORE.TABS.length; i += 1) {
        var key = CORE.TABS[i].key;
        page.classList.toggle(CORE.ID.TAB_CLASS_PREFIX + key, key === tab);
      }
    }
    /* 自己的三块面板 */
    for (var j = 0; j < CORE.TABS.length; j += 1) {
      var t = CORE.TABS[j];
      if (t.paneId == null) continue;
      var node = byId(t.paneId);
      if (node) node.hidden = (t.key !== tab);
    }
    /* 两个被委托的目标 */
    var config = configUI();
    var wantsConfig = (tab === CORE.TAB.SETTINGS);
    var wantsRequests = (tab === CORE.TAB.REQUESTS);
    if (config) {
      /* 离开「设置」之前记住 P22-16 自己停在哪一格，回来时回到同一格。 */
      if (typeof config.snapshot === 'function') {
        var snap = config.snapshot();
        if (snap && snap.section && String(snap.section) !== 'requests') lastConfigSection = String(snap.section);
      }
      /* ★ 唯一一处把 P22-16 的分区切走/切回：它同时负责 requests 的
         display，于是"待处理那一块谁可见"只有一个状态源。 */
      config.show(wantsRequests ? 'requests' : lastConfigSection);
    } else {
      var requests = byId(CORE.ID.REQUESTS_HOST);
      if (requests) requests.style.display = wantsRequests ? '' : 'none';
    }
    var configHost = byId(CORE.ID.CONFIG_HOST);
    if (configHost) configHost.style.display = wantsConfig ? '' : 'none';
  }

  function render() {
    var host = install();
    if (!host) return false;
    refreshOwners();
    host.textContent = '';
    host.appendChild(tabbar());
    if (tabNeedsOwner()) host.appendChild(ownerbar());
    var panes = el('div', 'esh-panes');
    host.appendChild(panes);
    for (var i = 0; i < CORE.TABS.length; i += 1) {
      var t = CORE.TABS[i];
      if (t.paneId == null) continue;
      panes.appendChild(paneOf(t));
    }
    applyVisibility();
    autoSyncOwner();
    return true;
  }

  /* ── 归属变了就补读一次（"这一页显示的是谁的数据"必须与当前归属一致）──
     ★ 两个真实场景会走到这里：
       ① **fresh profile**：进入这一页时角色目录还空着（apiConfigs 是异步
          填的），页面画的是一句"还没有配置任何角色"；用户随后在「API」里
          加了一位角色再回到 Economy —— navTo 会重新渲染外壳，而**已经读
          回来的那一份数据**属于"没有归属"，因此必须重读。没有这一步，
          用户会停在一句过期的"还没有角色"上，只能靠"重新读取"自救；
       ② 归属被清空（角色被删）—— 同样的不一致，同样的重读。
     ★ 只补一次：闸门是"当前 view 的归属 ≠ 现在的归属"，而重读之后两者必然
       相等；请求过程中 autoSyncing 挡住重入，因此不会形成循环。
     ★ 用户手选归属走的是另一条显式 load()（见 ownerbar）。 */
  var autoSyncing = false;
  function autoSyncOwner() {
    if (autoSyncing || stage === 'loading' || !view) return;
    var mine = view.owner == null ? '' : String(view.owner);
    var want = ownerId == null ? '' : String(ownerId);
    if (mine === want) return;
    autoSyncing = true;
    Promise.resolve(load()).then(function () { autoSyncing = false; }, function () { autoSyncing = false; });
  }

  function tabNeedsOwner() {
    for (var i = 0; i < CORE.TABS.length; i += 1) {
      if (CORE.TABS[i].key === tab) return CORE.TABS[i].needsOwner === true;
    }
    return false;
  }

  function tabbar() {
    var bar = el('nav', 'esh-tabs');
    bar.id = CORE.ID.TABS;
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', CORE.COPY.tablistLabel);
    for (var i = 0; i < CORE.TABS.length; i += 1) {
      (function (t) {
        var on = t.key === tab;
        var b = el('button', 'esh-tab' + (on ? ' is-active' : ''), t.label);
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.setAttribute('data-tab', t.key);
        if (t.paneId != null) b.setAttribute('aria-controls', t.paneId);
        b.appendChild(el('span', 'esh-tab-rail', ''));
        b.addEventListener('click', function () { goTo(t.key); });
        bar.appendChild(b);
      })(CORE.TABS[i]);
    }
    return bar;
  }

  /* 唯一的手势入口：切页签。它**不**改任何经济事实，只改"看哪一块"。 */
  function goTo(key) {
    if (!CORE.isTabKey(key)) return false;
    tab = key;
    render();
    if (stage === 'idle') load();
    return true;
  }

  function ownerbar() {
    var bar = el('div', 'esh-ownerbar');
    var left = el('div', 'esh-owner-left');
    left.appendChild(el('span', 'esh-owner-label', CORE.COPY.ownerLabel));
    if (!owners.length) {
      left.appendChild(el('p', 'esh-owner-empty', CORE.COPY.ownerEmpty));
    } else {
      var sel = el('select', 'esh-owner-select');
      sel.id = CORE.ID.OWNER_SELECT;
      for (var i = 0; i < owners.length; i += 1) {
        var o = el('option', null, owners[i].label);
        o.value = owners[i].id;
        o.selected = (owners[i].id === ownerId);
        sel.appendChild(o);
      }
      sel.addEventListener('change', function () {
        ownerId = sel.value;
        view = null;
        load();
      });
      left.appendChild(sel);
    }
    left.appendChild(el('span', 'esh-owner-hint', CORE.COPY.ownerHint));
    bar.appendChild(left);
    var right = el('div', 'esh-owner-right');
    right.appendChild(el('span', 'esh-sync', stage === 'loading' ? CORE.COPY.reading :
      (CORE.timeText(syncedAt) || '')));
    var again = el('button', 'esh-btn-quiet', CORE.COPY.refresh);
    again.type = 'button';
    again.addEventListener('click', function () { load(); });
    right.appendChild(again);
    bar.appendChild(right);
    return bar;
  }

  function paneOf(t) {
    var pane = el('div', 'esh-pane');
    pane.id = t.paneId;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', CORE.ID.TABS);
    pane.hidden = (t.key !== tab);
    if (stage === 'failed') { pane.appendChild(failedSurface()); return pane; }
    if (stage === 'loading' || !view) { pane.appendChild(skeleton()); return pane; }
    /* 商店与目录不依赖角色：没有角色时只有需要归属的那两格说这句话。 */
    if (!owners.length && t.needsOwner) { pane.appendChild(noOwnerSurface()); return pane; }
    if (t.key === CORE.TAB.OVERVIEW) overviewInto(pane);
    if (t.key === CORE.TAB.STORE) storeInto(pane);
    if (t.key === CORE.TAB.ASSETS) assetsInto(pane);
    return pane;
  }

  /* ── 通用块 ─────────────────────────────────────────────────────── */
  function card(markKey, title, sub) {
    var c = el('section', 'esh-card');
    var head = el('header', 'esh-card-head');
    head.appendChild(svgOf(MARK[markKey] || MARK.credit, 18, 'esh-mark'));
    var box = el('div', 'esh-card-titles');
    box.appendChild(el('h3', 'esh-card-title', title));
    if (sub) box.appendChild(el('p', 'esh-card-sub', sub));
    head.appendChild(box);
    c.appendChild(head);
    return c;
  }
  function note(text, cls) { return el('p', 'esh-note' + (cls ? ' ' + cls : ''), text); }
  function emptySurface(artKey, title, body) {
    var box = el('div', 'esh-empty');
    box.appendChild(artOf(EMPTY_ART[artKey] || EMPTY_ART.catalog, 'esh-empty-art'));
    box.appendChild(el('h4', 'esh-empty-title', title));
    if (body) box.appendChild(el('p', 'esh-empty-body', body));
    return box;
  }
  function figures(rows) {
    var box = el('div', 'esh-figures');
    for (var i = 0; i < rows.length; i += 1) {
      var f = el('div', 'esh-figure' + (rows[i].primary ? ' is-primary' : ''));
      f.appendChild(el('span', 'esh-figure-l', rows[i].label));
      f.appendChild(el('span', 'esh-figure-v', rows[i].value == null ? '—' : String(rows[i].value)));
      if (rows[i].unit) f.appendChild(el('span', 'esh-unit', rows[i].unit));
      box.appendChild(f);
    }
    return box;
  }
  function goToButton(label, target) {
    var b = el('button', 'esh-btn-link', label);
    b.type = 'button';
    b.addEventListener('click', function () { goTo(target); });
    return b;
  }
  /* 折叠的技术层：canonical 的原始代号只出现在这里（§"调试信息可以折叠"）。
     ★ 每一块自己的开合状态按**它的第一行**记住 —— 共用一个开关会让
       点开一处把整页的技术层一起掀开。 */
  var techOpen = Object.create(null);
  function technical(lines) {
    var key = String(lines[0] || 'technical');
    var open = techOpen[key] === true;
    var box = el('div', 'esh-technical-box');
    var b = el('button', 'esh-technical-toggle', CORE.COPY.technical + (open ? ' ▾' : ' ▸'));
    b.type = 'button';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.addEventListener('click', function () { techOpen[key] = !open; render(); });
    box.appendChild(b);
    var body = el('div', 'esh-technical');
    body.hidden = !open;
    for (var i = 0; i < lines.length; i += 1) body.appendChild(el('p', 'esh-technical-line', lines[i]));
    box.appendChild(body);
    return box;
  }
  function codeList(map) {
    var out = [];
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i += 1) out.push(keys[i] + ' → ' + map[keys[i]]);
    return CORE.COPY.canonicalCodes + '：' + out.join(' · ');
  }
  function skeleton() {
    var box = el('div', 'esh-card esh-skeleton');
    box.appendChild(el('p', 'esh-note', CORE.COPY.reading));
    return box;
  }
  function failedSurface() {
    var c = card('unlock', CORE.COPY.readFailed, null);
    c.appendChild(note(CORE.COPY.readFailedBody, 'is-quiet'));
    var b = el('button', 'esh-btn-primary', CORE.COPY.retry);
    b.type = 'button';
    b.addEventListener('click', function () { load(); });
    var act = el('div', 'esh-actions');
    act.appendChild(b);
    c.appendChild(act);
    return c;
  }
  function noOwnerSurface() {
    var c = card('lock', CORE.COPY.ownerEmpty, null);
    c.appendChild(note(CORE.COPY.ownerEmptyBody, 'is-quiet'));
    return c;
  }

  /* ══ 概览 ═════════════════════════════════════════════════════════
     Wallet 是这一页最明显的信息（§3），但它不是一块霓虹数字：一个
     等宽的数字 + 一句它是什么 + 它属于谁。 */
  function overviewInto(pane) {
    pane.appendChild(walletCard());
    pane.appendChild(budgetCard());
    pane.appendChild(purchasesCard());
    pane.appendChild(recentAssetsCard());
  }

  function walletCard() {
    var w = view.wallet;
    var c = card('credit', CORE.COPY.walletTitle, CORE.COPY.walletKind);
    /* ★ 三种形态各有各的话：
         ① 账户不存在 —— 不画数字格，给一句"还没有额度账户" + 去设置；
         ② 账户在、余额不可信（COLD / DEGRADED）—— 画**破折号**而不是 0，
            下面一句解释为什么这里没有数字；
         ③ 余额可信 —— 权威的那个数字。
       ②保留数字格是刻意的：卡片高度不跳，而且"这里本该有一个数字，只是
       现在读不到"比"这一格不存在"更准确。 */
    if (w.absent) {
      c.appendChild(note(w.note || CORE.COPY.walletAbsent, 'is-quiet'));
      var act = el('div', 'esh-actions');
      act.appendChild(goToButton(CORE.COPY.walletAbsentGo, CORE.TAB.SETTINGS));
      c.appendChild(act);
      c.appendChild(assetOwnerLine());
      c.appendChild(walletTechnical(w));
      return c;
    }
    var fig = el('div', 'esh-wallet-figure');
    fig.appendChild(el('span', 'esh-wallet-value', (w.known && w.primary != null) ? String(w.primary) : '—'));
    if (w.currencyFace) fig.appendChild(el('span', 'esh-unit', w.currencyFace));
    c.appendChild(fig);
    if (w.reserved != null) {
      c.appendChild(note(w.reservedLabel + ' ' + w.reserved + (w.currencyFace ? (' ' + w.currencyFace) : ''), 'is-quiet'));
    }
    if (w.note) c.appendChild(note(w.note, 'is-quiet'));
    c.appendChild(assetOwnerLine());
    c.appendChild(walletTechnical(w));
    return c;
  }
  function assetOwnerLine() {
    var picked = CORE.resolveOwnerOf(owners, ownerId);
    return el('p', 'esh-card-foot', picked ? picked.label : CORE.COPY.ownerEmpty);
  }
  function walletTechnical(w) {
    return technical([
      w.state == null ? 'wallet: (未读到)' : ('state = ' + w.state),
      w.currency == null ? 'currency = (未读到)' : ('currency = ' + w.currency),
      CORE.COPY.canonicalCodes + '（钱包）：' + codeList(CORE.WALLET_STATE_FACE),
      CORE.COPY.readPaths + '：' + CORE.readPathList().join(' · ')
    ]);
  }

  function budgetCard() {
    var b = view.budget;
    var c = card('history', CORE.COPY.budgetTitle, null);
    if (!b.present) {
      c.appendChild(note(b.note || CORE.COPY.budgetAbsent, 'is-quiet'));
      c.appendChild(note(CORE.COPY.budgetAbsentBody, 'is-quiet'));
      var act = el('div', 'esh-actions');
      act.appendChild(goToButton(CORE.COPY.budgetGo, CORE.TAB.SETTINGS));
      c.appendChild(act);
      return c;
    }
    var rows = [];
    for (var i = 0; i < b.rows.length; i += 1) {
      rows.push({ label: b.rows[i].label, value: b.rows[i].value, unit: CORE.currencyFace(b.currency) });
    }
    c.appendChild(figures(rows));
    if (b.usage.length) {
      var usage = el('div', 'esh-usage');
      for (var j = 0; j < b.usage.length; j += 1) {
        usage.appendChild(el('span', 'esh-usage-l', b.usage[j].label));
        usage.appendChild(el('span', 'esh-usage-v', b.usage[j].value));
        usage.appendChild(el('span', 'esh-unit', CORE.currencyFace(b.currency)));
      }
      c.appendChild(usage);
    }
    if (b.note) c.appendChild(note(b.note, 'is-quiet'));
    return c;
  }

  function purchasesCard() {
    var p = view.purchases;
    var c = card('history', CORE.COPY.purchasesTitle, null);
    if (p.empty) {
      c.appendChild(emptySurface('history', CORE.COPY.purchasesEmpty, CORE.COPY.purchasesEmptyBody));
      return c;
    }
    var list = el('ul', 'esh-list');
    for (var i = 0; i < p.rows.length; i += 1) {
      var r = p.rows[i];
      var li = el('li', 'esh-row');
      var main = el('div', 'esh-row-main');
      main.appendChild(el('span', 'esh-row-name', r.name));
      var meta = el('div', 'esh-row-meta');
      var bits = [];
      /* 发起者只在 join 成功**且**角色名认得出来时出现 —— 连不上就什么都不说。 */
      if (r.agentLabel) bits.push('由 ' + r.agentLabel + ' 发起');
      if (r.authText) bits.push(r.authText);
      if (r.atText) bits.push(r.atText);
      meta.appendChild(el('span', 'esh-row-sub', bits.join(' · ')));
      main.appendChild(meta);
      li.appendChild(main);
      var side = el('div', 'esh-row-side');
      if (r.amountText) side.appendChild(el('span', 'esh-row-amount', r.amountText));
      side.appendChild(el('span', 'esh-status', r.statusFace));
      li.appendChild(side);
      list.appendChild(li);
    }
    c.appendChild(list);
    var tech = [CORE.COPY.canonicalCodes + '（购买）：' + codeList(CORE.PURCHASE_STATE_FACE)];
    for (var k = 0; k < p.rows.length && k < 8; k += 1) {
      tech.push((p.rows[k].purchaseId || '(no id)') + ' · ' + (p.rows[k].status || '—') +
        (p.rows[k].mode == null ? ' · approvalMode=null' : (' · ' + p.rows[k].mode)));
    }
    c.appendChild(technical(tech));
    return c;
  }

  function recentAssetsCard() {
    var a = view.assets;
    var c = card('inventory', CORE.COPY.assetsTitle, null);
    if (a.empty) {
      c.appendChild(note(CORE.COPY.assetsEmpty, 'is-quiet'));
      c.appendChild(goToAssetsLine());
      return c;
    }
    var list = el('ul', 'esh-list');
    /* 概览只放最近的三条：完整的在「我的资产」那一格。 */
    var flat = [];
    for (var g = 0; g < a.groups.length; g += 1) {
      for (var i = 0; i < a.groups[g].rows.length; i += 1) flat.push(a.groups[g].rows[i]);
    }
    flat.sort(function (x, y) { return (y.updatedAt || 0) - (x.updatedAt || 0); });
    for (var k = 0; k < flat.length && k < 3; k += 1) {
      var r = flat[k];
      var li = el('li', 'esh-row');
      var main = el('div', 'esh-row-main');
      main.appendChild(el('span', 'esh-row-name', r.name));
      main.appendChild(el('span', 'esh-row-sub', CORE.COPY.assetsChangedAt + ' ' + (r.changedText || '—')));
      li.appendChild(main);
      var side = el('div', 'esh-row-side');
      side.appendChild(el('span', 'esh-row-qty', r.quantityText));
      li.appendChild(side);
      list.appendChild(li);
    }
    c.appendChild(list);
    c.appendChild(goToAssetsLine());
    return c;
  }
  function goToAssetsLine() {
    var box = el('div', 'esh-actions');
    box.appendChild(goToButton(CORE.COPY.assetsTitle, CORE.TAB.ASSETS));
    return box;
  }

  /* ══ 商店 ═════════════════════════════════════════════════════════
     §4：货架卡片给 name / description / status / 商品数量；
     商品卡片给 name / description / kind / unitPrice / unitName 与
     grantQuantity / status。**没有**购买按钮 —— canonical 没有这条接缝。 */
  function storeInto(pane) {
    var s = view.stores;
    var st = card('store', CORE.COPY.storesTitle, null);
    if (s.empty) {
      st.appendChild(emptySurface('catalog', CORE.COPY.storesEmpty, CORE.COPY.storesEmptyBody));
    } else if (!s.read) {
      st.appendChild(note(CORE.COPY.readFailed, 'is-quiet'));
    } else {
      var grid = el('div', 'esh-store-grid');
      for (var i = 0; i < s.rows.length; i += 1) {
        var r = s.rows[i];
        var tile = el('article', 'esh-store' + (storeFilter === r.storeId ? ' is-picked' : ''));
        var head = el('div', 'esh-store-head');
        head.appendChild(el('h4', 'esh-store-name', r.name));
        head.appendChild(el('span', 'esh-status', r.statusFace));
        tile.appendChild(head);
        tile.appendChild(el('p', 'esh-store-desc', r.description || CORE.COPY.storeNoDescription));
        if (r.productCountText) tile.appendChild(el('span', 'esh-store-count', r.productCountText));
        tile.appendChild(pickButton(r));
        grid.appendChild(tile);
      }
      st.appendChild(grid);
    }
    pane.appendChild(st);

    var p = view.products;
    var pc = card('item', CORE.COPY.productsTitle, null);
    pc.appendChild(note(CORE.COPY.productsRequestNote, 'is-quiet'));
    if (s.rows.length > 1) {
      var chips = el('div', 'esh-chips');
      chips.appendChild(filterChip(CORE.COPY.productsNoStoreFilter, null));
      for (var j = 0; j < s.rows.length; j += 1) chips.appendChild(filterChip(s.rows[j].name, s.rows[j].storeId));
      pc.appendChild(chips);
    }
    var rows = p.rows.filter(function (x) { return storeFilter == null || x.storeId === storeFilter; });
    if (p.empty || rows.length === 0) {
      pc.appendChild(emptySurface('catalog', CORE.COPY.productsEmpty, CORE.COPY.productsEmptyBody));
    } else {
      var list = el('div', 'esh-product-grid');
      for (var n = 0; n < rows.length; n += 1) list.appendChild(productTile(rows[n]));
      pc.appendChild(list);
    }
    pc.appendChild(technical(productTechnical(p)));
    pane.appendChild(pc);
  }
  /* 「只看这家」不是筛选器而是**一个手势**：它只改这一页看哪一货架，
     不改任何经济事实，也不参与目录顺序。 */
  function pickButton(r) {
    var picked = (storeFilter === r.storeId);
    var b = el('button', 'esh-btn-link esh-store-pick', picked ? CORE.COPY.storePickClear : CORE.COPY.storePick);
    b.type = 'button';
    b.setAttribute('aria-pressed', picked ? 'true' : 'false');
    b.addEventListener('click', function () {
      storeFilter = picked ? null : r.storeId;
      render();
    });
    return b;
  }
  function filterChip(label, value) {
    var on = storeFilter === value;
    var b = el('button', 'esh-chip' + (on ? ' is-active' : ''), label);
    b.type = 'button';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.addEventListener('click', function () {
      storeFilter = value;
      render();
    });
    return b;
  }
  function productTile(r) {
    var tile = el('article', 'esh-product');
    /* ★ 确定性视觉身份：**只有** productId 参与（纯层的函数签名只有一个
       位置参数）。它写进 data 属性与两个 CSS 变量，因此"变化"这件事
       发生在样式表里，而不是在任何一个经济判定里。 */
    tile.setAttribute('data-variant', String(r.identity.variant));
    tile.setAttribute('data-mark', String(r.identity.mark));
    try {
      tile.style.setProperty('--esh-angle', r.identity.angle + 'deg');
      tile.style.setProperty('--esh-variant', String(r.identity.variant));
    } catch (e) { /* 老引擎没有 setProperty 也不影响内容 */ }
    var art = artOf('<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      IDENTITY_MARKS[r.identity.mark % IDENTITY_MARKS.length] + '</svg>', 'esh-product-art');
    tile.appendChild(art);
    var body = el('div', 'esh-product-body');
    var head = el('div', 'esh-product-head');
    head.appendChild(el('h4', 'esh-product-name', r.name));
    head.appendChild(kindMark(r));
    body.appendChild(head);
    if (r.description) body.appendChild(el('p', 'esh-product-desc', r.description));
    var facts = el('div', 'esh-product-facts');
    if (r.priceText) facts.appendChild(el('span', 'esh-product-price', r.priceText));
    if (r.unitLine) facts.appendChild(el('span', 'esh-product-unitline', r.unitLine));
    body.appendChild(facts);
    var foot = el('div', 'esh-product-foot');
    foot.appendChild(el('span', 'esh-status', r.statusFace));
    if (r.kindFace) foot.appendChild(el('span', 'esh-kind', r.kindFace));
    body.appendChild(foot);
    tile.appendChild(body);
    return tile;
  }
  function kindMark(r) {
    var key = r.fulfillmentFace != null && r.fulfillmentFace.indexOf('服务') >= 0 ? 'service'
      : (r.kind === 'API_QUOTA' || r.kind === 'COMPUTE_CREDIT' ? 'compute' : 'item');
    return svgOf(MARK[key], 16, 'esh-kind-mark');
  }
  function productTechnical(p) {
    var lines = [
      'products: ' + p.count + (p.saturated ? '（窗口已满，可能还有更多）' : ''),
      CORE.COPY.canonicalCodes + '（商品）：' + codeList(CORE.PRODUCT_STATUS_FACE),
      CORE.COPY.notPersonalized
    ];
    for (var i = 0; i < p.rows.length && i < 8; i += 1) {
      lines.push(p.rows[i].productId + ' · kind=' + (p.rows[i].kind || '—') + ' · status=' + (p.rows[i].status || '—') +
        ' · visual=' + p.rows[i].identity.variant + '/' + p.rows[i].identity.angle + '/' + p.rows[i].identity.mark);
    }
    return lines;
  }

  /* ══ 我的资产 ═════════════════════════════════════════════════════
     §6：按 canonical 的 assetKind 分组（ITEM / COMPUTE），SERVICE 不
     伪造库存；COMPUTE 必须说清楚它是 IB 内部的算力额度。 */
  function assetsInto(pane) {
    var a = view.assets;
    var c = card('inventory', CORE.COPY.assetsTitle, null);
    if (!a.read) {
      c.appendChild(note(CORE.COPY.readFailed, 'is-quiet'));
      pane.appendChild(c);
      return;
    }
    if (a.empty) {
      c.appendChild(emptySurface('inventory', CORE.COPY.assetsEmpty, CORE.COPY.assetsEmptyBody));
    } else {
      for (var g = 0; g < a.groups.length; g += 1) {
        var grp = a.groups[g];
        var box = el('div', 'esh-group');
        var gh = el('div', 'esh-group-head');
        gh.appendChild(svgOf(grp.assetKind === 'COMPUTE' ? MARK.compute : MARK.item, 16, 'esh-group-mark'));
        gh.appendChild(el('h4', 'esh-group-title', grp.face));
        box.appendChild(gh);
        if (grp.note) box.appendChild(note(grp.note, 'is-quiet'));
        if (grp.empty) {
          box.appendChild(note(grp.emptyText, 'is-quiet'));
        } else {
          var list = el('ul', 'esh-list');
          for (var i = 0; i < grp.rows.length; i += 1) {
            var r = grp.rows[i];
            var li = el('li', 'esh-row');
            var main = el('div', 'esh-row-main');
            main.appendChild(el('span', 'esh-row-name', r.name));
            main.appendChild(el('span', 'esh-row-sub',
              CORE.COPY.assetsChangedAt + ' ' + (r.changedText || '—')));
            li.appendChild(main);
            var side = el('div', 'esh-row-side');
            side.appendChild(el('span', 'esh-row-qty', r.quantityText));
            li.appendChild(side);
            list.appendChild(li);
          }
          box.appendChild(list);
        }
        c.appendChild(box);
      }
      /* SERVICE 的那一句：它**不在**上面的两组里，而这不是遗漏。 */
      c.appendChild(note(a.serviceNote, 'is-quiet'));
    }
    c.appendChild(technical([
      'inventory entries: ' + a.total,
      CORE.COPY.canonicalCodes + '（资产）：' + codeList(CORE.ASSET_KIND_FACE),
      'isABalance = false（库存不是余额，不参与可用余额）'
    ]));
    pane.appendChild(c);
  }

  /* ── 接线 ─────────────────────────────────────────────────────── */
  var api = Object.freeze({
    render: function () {
      if (!byId(CORE.ID.PAGE)) return false;
      var first = (stage === 'idle');
      render();
      if (first) load();
      return true;
    },
    /* 测试与宿主可显式切页签（不经过 DOM 手势）。 */
    show: function (key) { return goTo(key); },
    refresh: load,
    snapshot: function () {
      return {
        tab: tab, ownerId: ownerId, owners: owners.slice(),
        stage: stage, syncedAt: syncedAt, failure: failure,
        storeFilter: storeFilter, lastConfigSection: lastConfigSection,
        view: view
      };
    },
    copy: CORE.COPY,
    DOM: DOM,
    CORE: CORE
  });
  NS.economyShellUI = api;

  /* 首次进入页面时 core.js 的 navTo 会调 render()；在此之前不主动读，
     因为绝大多数会话不会打开这一页（不制造无用的后台请求）。 */
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
})(window.IB || (window.IB = {}));
