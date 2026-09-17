/* ====================================================================
   IB · Economy Configuration UI — 渲染器（P22-16）
   --------------------------------------------------------------------
   这一页回答三个问题，而它们的答案**全部**由本机节点的权威给出：

     钱包与初始额度 —— 这位角色现在能动用多少内部额度
     预算限制       —— 一次 / 一天 / 一周 / 一个月最多动用多少
     自主购买       —— 这位角色能不能不问我直接买

   它**不是**一个管理后台：没有铸造、没有账本编辑、没有转账、没有
   退款 / 结算 / 预留 / 购买按钮，也没有任何与支付相关的入口。

   ── DOM 与逻辑的分工（与 P22-15 同款）──────────────────────────────
   · 视图模型、文案映射、请求体构造全在
     assets/js/economy-configuration-core.js（纯层，可在 Node 里测）；
   · 本文件只做四件事：注入样式表、读五条既有只读面、建 DOM、
     把用户手势交给 home-node-client 的 economyConfiguration()。

   ── 它**不**做的（逐条对着 §3 / §4 / §5）────────────────────────────
   · 整个文件里没有 fetch()。唯一的写动作是 send() →
     driver.economyConfiguration(...)，而那个方法自己白名单构造恰好三个字段。
   · 不判定任何经济事实：余额够不够、预算剩多少、自主裁决、报价有效性、
     商品状态 —— 五个都不算。保存成功只说"规则已保存"，不说"现在可以买了"。
   · 不做"乐观成功"：保存之后**重新读**五条读面，卡片显示的是读面说的。
   · 不碰 P22-15 的那棵 DOM：`#economy-requests` 一个字节都不改，
     本模块只按页签开合它的 display（见 install() 的说明）。
   ==================================================================== */
(function (NS) {
'use strict';

var CORE = NS.economyConfigurationCore;
if (!CORE) return; /* 纯层没加载：整页不渲染，而不是渲染一个错的页面 */

var DOM = {
  STYLE_ID: 'ib-econ-cfg-style',
  STYLE_HREF: 'assets/css/economy-configuration.css'
};

/* 24×24 · currentColor · 统一 stroke。没有 emoji，也没有任何位图。 */
var MARK = Object.freeze({
  wallet: '<rect x="3.2" y="6.2" width="17.6" height="12.6" rx="3"/><path d="M3.2 10.4h17.6"/><circle cx="16.6" cy="14.6" r="1.15"/>',
  budget: '<path d="M4.2 7.4h15.6"/><path d="M4.2 12h10.4"/><path d="M4.2 16.6h6.6"/><path d="M18.6 15.2l1.9-2.2-1.9-2.2"/>',
  autonomy: '<path d="M4.4 17.4a8 8 0 1 1 15.2 0"/><path d="M12 17.4l4.1-5.1"/><circle cx="12" cy="17.4" r="1.3"/>',
  requests: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6v4.8l3.2 2"/>'
});

/* 空状态：安静的一件轮廓物。线性 · currentColor · 无金币无购物车。 */
var EMPTY_ART = Object.freeze({
  wallet: ['<svg viewBox="0 0 140 108" width="140" height="108" fill="none" stroke="currentColor"',
    ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    '<rect x="26" y="34" width="88" height="56" rx="10"/>',
    '<path d="M26 50h88"/>',
    '<circle cx="98" cy="68" r="4.4"/>',
    '<path d="M54 24h32" opacity=".5"/>',
    '<path d="M46 92h48" opacity=".3"/>',
    '</svg>'].join(''),
  budget: ['<svg viewBox="0 0 140 108" width="140" height="108" fill="none" stroke="currentColor"',
    ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    '<path d="M32 24h64a8 8 0 0 1 8 8v44a8 8 0 0 1-8 8H32a8 8 0 0 1-8-8V32a8 8 0 0 1 8-8z"/>',
    '<path d="M40 46h56"/>',
    '<path d="M40 60h38"/>',
    '<path d="M40 74h20"/>',
    '</svg>'].join(''),
  autonomy: ['<svg viewBox="0 0 140 108" width="140" height="108" fill="none" stroke="currentColor"',
    ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">',
    '<path d="M34 86V46a36 36 0 0 1 72 0v40"/>',
    '<path d="M70 86V52"/>',
    '<path d="M52 44h36" opacity=".34"/>',
    '<path d="M44 66h16" opacity=".24"/>',
    '<path d="M80 66h16" opacity=".24"/>',
    '</svg>'].join('')
});

function boot() {
  if (typeof document === 'undefined' || !document.head) return;

  injectStyle();

  /* ── 状态 ─────────────────────────────────────────────────────── */
  var section = CORE.SECTION.REQUESTS;
  var ownerId = null;
  var stage = 'idle';                /* idle | loading | ready | failed */
  var view = null;
  var failure = null;
  var syncedAt = null;
  var notes = Object.create(null);    /* section → classifyConfigurationResponse */
  var pending = Object.create(null);  /* section → { key, command } */
  var confirmBootstrap = false;
  var owners = [];
  var seq = 0;
  /* 渲染时登记的控件引用。保存路径**只**从这里读值：这样测试的 DOM 桩
     不需要实现任何选择器，而"桩查不到"也不会变成一次少发字段的保存。 */
  var refs = { inputs: Object.create(null), checks: [], segs: Object.create(null), segBoxes: Object.create(null) };
  function resetRefs() {
    refs = { inputs: Object.create(null), checks: [], segs: Object.create(null), segBoxes: Object.create(null) };
  }
  /* ── 草稿 ─────────────────────────────────────────────────────────
     ★ 这一层是**必要的**，不是修饰：一次渲染会重建整个面板，而用户在
     那之前敲进去的字必须活下来。没有它，两步确认的第一步就会把金额清空
     （开发期实测抓到的真实缺陷），保存失败后的重画也会把整张表单清空 ——
     而"点了确认之后金额不见了"会让用户以为系统把他填的数吃掉了。
     ★ 生命周期刻意是**权威刷新就清空**：load() 一开始清掉草稿，因此
       保存成功之后表单显示的是刚读回来的权威值，而不是用户上一次的输入。 */
  var drafts = Object.create(null);
  function draftOf(name, fallback) {
    if (Object.prototype.hasOwnProperty.call(drafts, name)) return drafts[name];
    return fallback == null ? '' : String(fallback);
  }

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
  function injectStyle() {
    if (byId(DOM.STYLE_ID)) return;
    var link = document.createElement('link');
    link.id = DOM.STYLE_ID;
    link.rel = 'stylesheet';
    link.href = DOM.STYLE_HREF;
    document.head.appendChild(link);
  }

  /* ── 传输 ─────────────────────────────────────────────────────────
     ★ 唯一的出口是既有 remote driver。本文件不出现 fetch()，
       因此 §5 那条"浏览器只能走配置 seam"是**结构**事实。
     ★ 测试注入入口：window.__ibEconomyConfigDriver。它只替换 driver
       实例，**不**改变请求体的构造点（那在纯层里）。 */
  function driver() {
    if (NS.__ibEconomyConfigDriver) return NS.__ibEconomyConfigDriver;
    if (typeof NS.createHomeNodeRemote === 'function') return NS.createHomeNodeRemote({});
    return null;
  }
  function readJson(path, query) {
    var d = driver();
    if (!d || typeof d.getJson !== 'function') return Promise.resolve({ ok: false, error: 'transport-not-available' });
    return d.getJson(path, query);
  }

  /* ── 谁可以配置 ───────────────────────────────────────────────────
     ★ apiConfigs 是角色的唯一事实源（P4 契约）—— 这里**不**建第二套
       角色表，只把它读成一组选项；与 P22-15 的名字 / 头像来源同一个。
     ★ 生产里那个名字有**两个**入口，而且两个都是活的（实测）：
         · 裸标识符 —— assets/js/social.js:607 的顶层 `let apiConfigs`，
           经典脚本的顶层 let 落在全局词法环境里，所有脚本都看得见；
         · window.apiConfigs —— social.js:2654 用 ibSocialLive 把它注册成
           一对活的 getter/setter（其它模块大量走这条，例如 role-dm.js）。
       两条都读，**先**裸标识符（它更直接），读不到再走 window。任一条
       单独存在时这一页都能工作；两边都没有时 owners 为空，页面显示的是
       诚实的"还没有配置任何角色"，而不是一个空下拉。
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
  function apiConfigList() {
    return roleList(function () {
      return (typeof apiConfigs !== 'undefined') ? apiConfigs : undefined;
    }, 'apiConfigs');
  }
  function archivedConfigList() {
    return roleList(function () {
      return (typeof archivedConfigs !== 'undefined') ? archivedConfigs : undefined;
    }, 'archivedConfigs');
  }
  function refreshOwners() {
    owners = CORE.ownerOptions(apiConfigList(), archivedConfigList());
    var picked = CORE.resolveOwner(owners, ownerId);
    ownerId = picked ? picked.id : null;
  }

  /* ── 读：五条既有只读面 ─────────────────────────────────────────────
     ★ 没有一条是本阶段新增的。第五条 `/security` 回答的是"配置面现在
       开不开"，而它的判定权在权威那边 —— 这里只搬运。 */
  function load() {
    var my = ++seq;
    /* ★ 权威刷新清空草稿：保存成功之后表单显示的必须是刚读回来的值。 */
    drafts = Object.create(null);
    stage = view ? 'ready' : 'loading';
    if (!view) stage = 'loading';
    failure = null;
    render();
    var queries = [];
    if (ownerId) {
      queries = Promise.all([
        readJson(CORE.READS.WALLET, { ownerId: ownerId, currency: CORE.CURRENCY }),
        readJson(CORE.READS.POLICY, { ownerId: ownerId }),
        readJson(CORE.READS.AUTONOMY_POLICY, { ownerId: ownerId }),
        /* 预算快照：本页只读它的 **spentTodayMinor**（今日已用）。读面要求
           带上一个被评估的金额，这里给最小 canonical 金额 1 —— 那个金额
           的评估结论**不进视图模型**（见 CORE.buildMeterView 的说明），
           因此界面上不会出现任何"能不能买"的判断。 */
        readJson(CORE.READS.BUDGET, { ownerId: ownerId, currency: CORE.CURRENCY, amountMinor: '1' }),
        readJson(CORE.READS.SECURITY, '')
      ]);
    } else {
      queries = Promise.all([readJson(CORE.READS.SECURITY, '')]);
    }
    return queries.then(function (results) {
      if (my !== seq) return null;
      var input = ownerId
        ? { wallet: results[0], policy: results[1], autonomyPolicy: results[2], budgetSnapshot: results[3], security: results[4] }
        : { wallet: null, policy: null, autonomyPolicy: null, budgetSnapshot: null, security: results[0] };
      view = CORE.buildPageView(input);
      stage = 'ready';
      syncedAt = Date.now();
      render();
      return view;
    }, function (error) {
      if (my !== seq) return null;
      stage = 'failed';
      failure = { text: '读取失败', detail: String((error && error.message) || error) };
      render();
      return null;
    });
  }

  /* ── 写：P22-14 seam（唯一一处写）────────────────────────────────── */
  function send(sectionKey, command, built) {
    if (pending[sectionKey]) return Promise.resolve(null);
    if (built != null && built.ok !== true) {
      notes[sectionKey] = {
        outcome: 'not-projected', ok: false,
        /* ★ 这一句只讲**输入形状**（「每日自主购买上限」这一格需要一个金额），
           不讲任何经济语义 —— 语义全部交给权威回答。 */
        text: CORE.shapeFailureText(built.code, built.field),
        detail: built.code ? ('未发出的原因：' + built.code) : null,
        field: built.field || null
      };
      render();
      return Promise.resolve(null);
    }
    var d = driver();
    if (!d || typeof d.economyConfiguration !== 'function') {
      notes[sectionKey] = { outcome: 'transport-error', ok: false, text: '这里还没有可用的本机节点连接' };
      render();
      return Promise.resolve(null);
    }
    pending[sectionKey] = { command: command, key: built.body.idempotencyKey };
    delete notes[sectionKey];
    render();
    return Promise.resolve(d.economyConfiguration(built.body)).then(function (res) {
      delete pending[sectionKey];
      notes[sectionKey] = CORE.classifyConfigurationResponse(res);
      return load();
    }, function (error) {
      delete pending[sectionKey];
      var note = CORE.classifyConfigurationResponse({ ok: false, error: 'home-node-transport-error' });
      note.detail = String((error && error.message) || error);
      notes[sectionKey] = note;
      render();
      return null;
    });
  }

  /* 一次用户手势 = 一个身份。重试**复用**同一个身份：因此"点了两下"
     或者"第一次超时了再点一次"不会变成两次不同的写入。 */
  var gestureKeys = Object.create(null);
  function gestureKey(sectionKey, scope) {
    var k = sectionKey + ':' + String(ownerId) + ':' + String(scope);
    if (!gestureKeys[k]) gestureKeys[k] = CORE.newIdempotencyKey('econ-cfg-' + sectionKey);
    return gestureKeys[k];
  }
  function clearGestureKey(sectionKey, scope) {
    delete gestureKeys[sectionKey + ':' + String(ownerId) + ':' + String(scope)];
  }

  /* ── 外壳：页签 + 配置对象 + 三个面板 ───────────────────────────────
     ★ 三件刻意的事：
       ① 外壳**插在 `#economy-requests` 之前**，不搬动那个节点。P22-15
          的 DOM 一个字节都不改，因此它的 DOM 断言与视觉断言继续成立；
       ② `#economy-requests` 的可见性由本模块开合：默认页签是「待处理」，
          因此页面打开时的样子与 P22-15 交付时**逐字相同**；
       ③ 页签名单来自 CORE.SECTIONS —— 第一个 panel 的 paneId 是 null，
          "那一块不归我画"。 */
  function install() {
    var page = byId(CORE.ID.PAGE);
    if (!page) return null;
    var host = byId(CORE.ID.HOST);
    if (host) return host;
    host = el('section', 'ecfg');
    host.id = CORE.ID.HOST;
    host.setAttribute('aria-label', CORE.COPY.title);
    if (page.firstChild) page.insertBefore(host, page.firstChild);
    else page.appendChild(host);
    return host;
  }

  /* ── 渲染 ───────────────────────────────────────────────────────── */
  function render() {
    var host = install();
    if (!host) return false;
    /* ★ 每次渲染都重读一次角色目录：`apiConfigs` 是角色的唯一事实源
       （P4 契约），而用户可能在另一个页签里刚加了一位角色。这个读是
       内存里的数组读取，不发请求。 */
    refreshOwners();
    resetRefs();
    host.textContent = '';
    host.appendChild(tabbar(host));
    /* ★ P22-22：二级页签之下先说"这一格是什么"（标签 + intro 一句）。
       待处理那一格由外层外壳负责，因此这里不为它画第二个标题 —— 同一页上
       出现两个标题会让"我在哪儿"有两个答案。 */
    var head = sectionHead();
    if (head) host.appendChild(head);
    if (section !== CORE.SECTION.REQUESTS) host.appendChild(ownerbar());
    var pane = el('div', 'ecfg-panes');
    host.appendChild(pane);
    for (var i = 0; i < CORE.SECTIONS.length; i++) {
      var s = CORE.SECTIONS[i];
      if (s.paneId == null) continue;
      pane.appendChild(paneShell(s));
    }
    showSection();
    return true;
  }

  /* 页签开合：待处理那一块是 P22-15 的 DOM，其余三块是本模块的。 */
  function showSection() {
    var requests = byId(CORE.ID.REQUESTS_HOST);
    if (requests) requests.style.display = (section === CORE.SECTION.REQUESTS) ? '' : 'none';
    for (var i = 0; i < CORE.SECTIONS.length; i++) {
      var s = CORE.SECTIONS[i];
      if (s.paneId == null) continue;
      var node = byId(s.paneId);
      if (!node) continue;
      node.hidden = (s.key !== section);
    }
    /* 切到「待处理」时确保 P22-15 的渲染器已经跑过（它的 render 是幂等的：
       第一次会去读，之后只是重画）。 */
    if (section === CORE.SECTION.REQUESTS) {
      try {
        if (NS.economyApprovalUI && typeof NS.economyApprovalUI.render === 'function') NS.economyApprovalUI.render();
      } catch (e) { /* 渲染器不在也不能让这一页崩掉 */ }
    }
  }

  function tabbar(host) {
    var bar = el('div', 'ecfg-tabs');
    bar.id = CORE.ID.TABS;
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', CORE.COPY.tablistLabel);
    for (var i = 0; i < CORE.SECTIONS.length; i++) {
      (function (s) {
        var on = s.key === section;
        var tab = el('button', 'ecfg-tab' + (on ? ' is-active' : ''), s.label);
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.setAttribute('data-section', s.key);
        if (s.paneId != null) tab.setAttribute('aria-controls', s.paneId);
        tab.appendChild(el('span', 'ecfg-tab-rail', ''));
        tab.addEventListener('click', function () {
          if (section === s.key) return;
          section = s.key;
          confirmBootstrap = false;
          render();
          /* 第一次进入配置页签时才去读（不制造无用的后台请求）。 */
          if (s.key !== CORE.SECTION.REQUESTS && stage === 'idle') load();
        });
        bar.appendChild(tab);
      })(CORE.SECTIONS[i]);
    }
    return bar;
  }

  /* ── P22-22 · 二级页签的标题（§E）────────────────────────────────
     ★ 标签与 intro 都来自 SECTIONS（这一层唯一的文案出处），因此页签与
       标题永远同一批词。待处理那一格由外层提供标题，这里返回 null ——
       一个节点都不多加。 */
  function sectionHead() {
    var hit = null;
    for (var i = 0; i < CORE.SECTIONS.length; i++) {
      if (CORE.SECTIONS[i].key === section) { hit = CORE.SECTIONS[i]; break; }
    }
    if (!hit || hit.key === CORE.SECTION.REQUESTS) return null;
    var box = el('div', 'ecfg-section');
    box.appendChild(el('h3', 'ecfg-section-title', hit.label));
    if (hit.intro) box.appendChild(el('p', 'ecfg-section-sub', hit.intro));
    return box;
  }

  function ownerbar() {    var bar = el('div', 'ecfg-ownerbar');
    bar.id = CORE.ID.OWNER_BAR;
    var left = el('div', 'ecfg-owner-left');
    left.appendChild(el('span', 'ecfg-owner-label', CORE.COPY.ownerLabel));
    if (owners.length === 0) {
      left.appendChild(el('span', 'ecfg-owner-hint', CORE.COPY.ownerEmpty));
    } else {
      var sel = document.createElement('select');
      sel.className = 'ecfg-owner-select';
      sel.id = 'economy-owner-select';
      sel.setAttribute('aria-label', CORE.COPY.ownerLabel);
      for (var i = 0; i < owners.length; i++) {
        var o = document.createElement('option');
        o.value = owners[i].id;
        o.textContent = owners[i].label;
        if (String(o.value) === String(ownerId)) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', function () {
        ownerId = String(sel.value);
        notes = Object.create(null);
        pending = Object.create(null);
        gestureKeys = Object.create(null);
        confirmBootstrap = false;
        view = null;
        stage = 'idle';
        load();
      });
      left.appendChild(sel);
      left.appendChild(el('span', 'ecfg-owner-hint', CORE.COPY.ownerHint));
    }
    bar.appendChild(left);

    var right = el('div', 'ecfg-owner-right');
    var sync = el('span', 'ecfg-sync', stage === 'loading' ? CORE.COPY.reading
      : (syncedAt ? ('同步于 ' + relativeTime(syncedAt, Date.now())) : ''));
    sync.setAttribute('aria-live', 'polite');
    right.appendChild(sync);
    var refresh = el('button', 'ecfg-btn ecfg-btn-quiet', CORE.COPY.refresh);
    refresh.type = 'button';
    refresh.disabled = (stage === 'loading') || anyPending();
    refresh.addEventListener('click', function () { load(); });
    right.appendChild(refresh);
    bar.appendChild(right);
    return bar;
  }

  function anyPending() {
    for (var k in pending) { if (pending[k]) return true; }
    return false;
  }
  function relativeTime(atMs, nowMs) {
    var diff = Math.round((nowMs - atMs) / 1000);
    if (diff < 45) return '刚刚';
    if (diff < 3600) return Math.round(diff / 60) + ' 分钟前';
    return Math.round(diff / 3600) + ' 小时前';
  }

  function paneShell(s) {
    var pane = el('div', 'ecfg-pane');
    pane.id = s.paneId;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', CORE.ID.TABS);
    pane.hidden = (s.key !== section);
    if (owners.length === 0) {
      pane.appendChild(noOwnerSurface(s));
      return pane;
    }
    if (stage === 'idle' || stage === 'loading') {
      pane.appendChild(skeleton());
      return pane;
    }
    if (stage === 'failed') {
      pane.appendChild(failedSurface());
      return pane;
    }
    if (!view) {
      pane.appendChild(skeleton());
      return pane;
    }
    if (s.key === CORE.SECTION.WALLET) pane.appendChild(walletCard());
    if (s.key === CORE.SECTION.BUDGET) pane.appendChild(budgetCard());
    if (s.key === CORE.SECTION.AUTONOMY) pane.appendChild(autonomyCard());
    return pane;
  }

  /* ── 通用器件 ───────────────────────────────────────────────────── */
  function card(markKey, title, sub) {
    var c = el('article', 'ecfg-card');
    var head = el('header', 'ecfg-head');
    head.appendChild(svgOf(MARK[markKey] || MARK.budget, 22, 'ecfg-mark'));
    var text = el('div', 'ecfg-head-text');
    text.appendChild(el('h3', 'ecfg-card-title', title));
    if (sub) text.appendChild(el('p', 'ecfg-card-sub', sub));
    head.appendChild(text);
    c.appendChild(head);
    return c;
  }

  /* 配置面关着（§7）：进这个页签就说清楚，**不提供按钮**。 */
  function closedNotice(source) {
    var box = el('div', 'ecfg-gate');
    box.setAttribute('role', 'status');
    box.appendChild(el('span', 'ecfg-gate-dot', ''));
    var body = el('div', 'ecfg-gate-body');
    body.appendChild(el('p', 'ecfg-gate-title', CORE.COPY.closedTitle));
    body.appendChild(el('p', 'ecfg-gate-text', source === 'unknown' ? CORE.COPY.closedUnknown : CORE.COPY.closedBody));
    body.appendChild(technical([source === 'unknown' ? '读不到 /security 的 economyPolicy.configuration' : CORE.COPY.closedTechnical]));
    box.appendChild(body);
    return box;
  }
  function gateSource() {
    if (!view) return 'unknown';
    if (!view.gateKnown) return 'unknown';
    return view.gate && view.gate.open === true ? null : 'closed';
  }

  /* 技术说明：底层词只出现在这个折叠区里（P6 契约）。 */
  function technical(lines) {
    var d = document.createElement('details');
    d.className = 'ecfg-technical';
    var s = document.createElement('summary');
    s.textContent = CORE.COPY.technical;
    d.appendChild(s);
    var ul = el('ul', 'ecfg-technical-list');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] == null) continue;
      ul.appendChild(el('li', null, String(lines[i])));
    }
    d.appendChild(ul);
    return d;
  }

  function figures(rows) {
    var box = el('div', 'ecfg-figures');
    for (var i = 0; i < rows.length; i++) {
      var f = el('div', 'ecfg-figure' + (rows[i].primary ? ' is-primary' : ''));
      f.appendChild(el('span', 'ecfg-figure-k', rows[i].k));
      f.appendChild(el('span', 'ecfg-figure-v' + (rows[i].muted ? ' is-muted' : ''), rows[i].v));
      box.appendChild(f);
    }
    return box;
  }

  function field(label, hint, opts) {
    opts = opts || {};
    var wrap = el('div', 'ecfg-field');
    var id = 'ecfg-f-' + opts.name;
    var lab = document.createElement('label');
    lab.className = 'ecfg-field-label';
    lab.setAttribute('for', id);
    lab.textContent = label;
    wrap.appendChild(lab);
    var row = el('div', 'ecfg-input-wrap');
    var input = document.createElement('input');
    input.className = 'ecfg-input';
    input.id = id;
    input.name = opts.name;
    input.type = opts.type || 'text';
    if (opts.type !== 'date') input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.value = draftOf(opts.name, opts.value);
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.disabled) input.disabled = true;
    input.addEventListener('input', function () { drafts[opts.name] = input.value; });
    row.appendChild(input);
    if (opts.unit) row.appendChild(el('span', 'ecfg-unit', opts.unit));
    wrap.appendChild(row);
    if (hint) wrap.appendChild(el('p', 'ecfg-field-hint', hint));
    refs.inputs[opts.name] = input;
    return wrap;
  }

  /* 输入值一律从 refs 读（渲染时登记的引用），因此保存路径不依赖任何
     选择器引擎 —— 桩做不到的选择器不会变成"少发一个字段"。 */
  function valueOf(name) {
    var node = refs.inputs[name];
    return node && node.value != null ? String(node.value) : '';
  }
  function checked(name) {
    for (var i = 0; i < refs.checks.length; i++) {
      var c = refs.checks[i];
      if (c.name === name && c.input.checked === true) return true;
    }
    return false;
  }
  function checkedValues(prefix) {
    var out = [];
    for (var i = 0; i < refs.checks.length; i++) {
      var c = refs.checks[i];
      if (c.input.checked !== true) continue;
      if (String(c.name).indexOf(prefix) !== 0) continue;
      out.push(String(c.name).slice(prefix.length));
    }
    return out;
  }
  function segValue(name, fallback) {
    var v = refs.segs[name];
    return (v == null || v === '') ? (fallback == null ? '' : fallback) : v;
  }

  function checkbox(name, checked, label, hint) {
    var row = document.createElement('label');
    row.className = 'ecfg-check-row';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'ecfg-check';
    input.name = name;
    input.checked = draftOf(name, checked === true ? 'on' : '') === 'on';
    input.addEventListener('change', function () { drafts[name] = input.checked ? 'on' : ''; });
    row.appendChild(input);
    var text = el('span', 'ecfg-check-text');
    text.appendChild(el('span', 'ecfg-check-label', label));
    if (hint) text.appendChild(el('span', 'ecfg-check-hint', hint));
    row.appendChild(text);
    refs.checks.push({ name: name, input: input });
    return row;
  }

  /* 单选段。★ 选中值存在**本模块的 refs 里**，而不是每次保存时去
     document.querySelectorAll —— 后者要求测试的 DOM 桩实现完整的选择器
     引擎，而一个"桩查不到就返回空数组"的失败会让保存静默地少发一个字段。 */
  function segRow(name, options, current, labels) {
    var box = el('div', 'ecfg-seg');
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('data-seg', name);
    var selected = draftOf(name, current);
    var buttons = [];
    for (var i = 0; i < options.length; i++) {
      (function (value) {
        var on = String(selected == null ? '' : selected) === String(value);
        var b = el('button', 'ecfg-seg-btn' + (on ? ' is-on' : ''), labels[value] || value);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.setAttribute('data-value', value);
        b.addEventListener('click', function () {
          for (var j = 0; j < buttons.length; j++) {
            buttons[j].classList.remove('is-on');
            buttons[j].setAttribute('aria-checked', 'false');
          }
          b.classList.add('is-on');
          b.setAttribute('aria-checked', 'true');
          box.setAttribute('data-value', value);
          refs.segs[name] = value;
          drafts[name] = value;
        });
        buttons.push(b);
        box.appendChild(b);
      })(options[i]);
    }
    box.setAttribute('data-value', selected == null ? '' : String(selected));
    refs.segs[name] = selected == null ? '' : String(selected);
    refs.segBoxes[name] = box;
    return box;
  }

  function advanced(toggleLabel, children) {
    var box = el('div', 'ecfg-advanced');
    var control = el('button', 'ecfg-advanced-toggle', toggleLabel + ' · ' + CORE.COPY.advancedShow);
    control.type = 'button';
    control.setAttribute('aria-expanded', 'false');
    var body = el('div', 'ecfg-advanced-body');
    for (var i = 0; i < children.length; i++) body.appendChild(children[i]);
    body.hidden = true;
    control.addEventListener('click', function () {
      body.hidden = !body.hidden;
      control.textContent = toggleLabel + ' · ' + (body.hidden ? CORE.COPY.advancedShow : CORE.COPY.advancedHide);
      control.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    });
    box.appendChild(control);
    box.appendChild(body);
    return box;
  }

  function paneFeedback(sectionKey) {
    var note = notes[sectionKey];
    if (!note) return null;
    var box = el('div', 'ecfg-feedback' + (note.ok ? ' is-good' : ' is-bad'));
    box.setAttribute('role', 'status');
    var head = el('div', 'ecfg-feedback-head');
    head.appendChild(svgOf(note.ok ? '<path d="M4.6 12.6l4.2 4.2 10-11"/>' : '<path d="M12 5.4v7.2"/><circle cx="12" cy="17.4" r="1.1"/>', 15, 'ecfg-feedback-mark'));
    head.appendChild(el('span', 'ecfg-feedback-text', note.text));
    box.appendChild(head);
    /* ★ 底层词（拒绝码原词 / 字段名 / 本机节点的原话）进折叠的技术说明，
       与 P22-15 的"code 只在 detail 层"同一条纪律：正文只留那句人话。 */
    var extra = [];
    if (note.detail) extra.push(note.detail);
    if (!note.ok && note.errors && note.errors.length) extra.push('本机节点的原话：' + note.errors.join(' · '));
    if (extra.length) box.appendChild(technical(extra));
    return box;
  }

  function actions(children) {
    var box = el('div', 'ecfg-actions');
    for (var i = 0; i < children.length; i++) box.appendChild(children[i]);
    return box;
  }
  function button(label, cls, onClick, disabled) {
    var b = el('button', 'ecfg-btn ' + cls, label);
    b.type = 'button';
    b.disabled = disabled === true;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function skeleton() {
    var box = el('div', 'ecfg-skeleton');
    for (var i = 0; i < 3; i++) box.appendChild(el('div', 'ecfg-sk'));
    var sr = el('p', 'ecfg-sr', CORE.COPY.reading);
    box.appendChild(sr);
    return box;
  }
  function failedSurface() {
    var c = el('article', 'ecfg-card ecfg-card-plain');
    c.appendChild(el('p', 'ecfg-empty-title', CORE.COPY.readFailed));
    if (failure && failure.detail) c.appendChild(el('p', 'ecfg-empty-body', String(failure.detail).slice(0, 200)));
    c.appendChild(actions([button(CORE.COPY.retry, 'ecfg-btn-primary', function () { load(); })]));
    return c;
  }
  function noOwnerSurface(s) {
    var c = el('article', 'ecfg-card ecfg-card-plain');
    var art = el('div', 'ecfg-empty-art');
    art.innerHTML = EMPTY_ART[s.key] || EMPTY_ART.wallet;
    c.appendChild(art);
    c.appendChild(el('p', 'ecfg-empty-title', CORE.COPY.ownerEmpty));
    c.appendChild(el('p', 'ecfg-empty-body', CORE.COPY.ownerEmptyBody));
    return c;
  }
  function emptySurface(key, title, body) {
    var box = el('div', 'ecfg-empty');
    var art = el('div', 'ecfg-empty-art');
    art.innerHTML = EMPTY_ART[key] || EMPTY_ART.wallet;
    box.appendChild(art);
    box.appendChild(el('p', 'ecfg-empty-title', title));
    box.appendChild(el('p', 'ecfg-empty-body', body));
    return box;
  }
  function note(text, cls) { return el('p', 'ecfg-note' + (cls ? ' ' + cls : ''), text); }

  /* ══ ① 钱包与初始额度 ═════════════════════════════════════════════ */
  function walletCard() {
    var w = view.wallet;
    var c = card('wallet', CORE.COPY.walletTitle, CORE.COPY.walletKind);

    if (w.state === 'unknown' || w.state === 'malformed') {
      c.appendChild(note(w.text || CORE.COPY.readFailed, 'is-quiet'));
      if (w.detail) c.appendChild(technical([w.detail]));
      c.appendChild(actions([button(CORE.COPY.retry, 'ecfg-btn-quiet', function () { load(); })]));
      return c;
    }

    if (w.state === 'present') {
      /* ★ 这里说的是"一次性的初始化已经用掉了"，依据是钱包**在**。
         理由：生产里唯一创建 (owner, IB_CREDIT) 钱包的路径就是
         bootstrapInitialCredit 自己（openWallet 全仓只有一个调用方）。
         这条耦合由测试逐字钉住，因此它是被断言的事实，不是"相信"。 */
      var flag = el('div', 'ecfg-flag');
      flag.appendChild(svgOf('<path d="M4.8 12.4l4 4 9.4-10.2"/>', 15, 'ecfg-flag-mark'));
      flag.appendChild(el('span', 'ecfg-flag-text', CORE.COPY.walletBootstrapped));
      c.appendChild(flag);
      c.appendChild(note(CORE.COPY.walletBootstrappedBody, 'is-quiet'));

      var rows = [];
      rows.push({
        k: CORE.COPY.walletAvailable, primary: true,
        v: w.ready ? (CORE.amountText(w.availableMinor, w.currency) || '—') : CORE.COPY.walletNotReady
      });
      rows.push({ k: CORE.COPY.walletLedger, v: w.ready ? (CORE.amountText(w.ledgerMinor, w.currency) || '—') : '—', muted: !w.ready });
      rows.push({ k: CORE.COPY.walletReserved, v: w.ready ? (CORE.amountText(w.reservedMinor, w.currency) || '—') : '—', muted: !w.ready });
      c.appendChild(figures(rows));
      if (!w.ready) c.appendChild(note(CORE.COPY.walletNotReadyBody, 'is-quiet'));
      c.appendChild(technical([
        '钱包状态：' + String(w.walletState),
        '余额可信：' + (w.balanceKnown ? '是' : '否'),
        w.walletId ? ('钱包编号：' + w.walletId) : null
      ]));
      return c;
    }

    /* 尚未完成 Initial Bootstrap = 初始额度还没有发放过（**不是**"钱包丢了"）。
       **这是唯一会出现初始化表单的状态**，因此这台节点上永远只会有一个
       "可执行的初始额度按钮"。 */
    c.appendChild(bootstrapStateSurface());
    var source = gateSource();
    if (source) { c.appendChild(closedNotice(source)); return c; }
    if (!view.canBootstrap) { c.appendChild(closedNotice(view.gateKnown ? 'closed' : 'unknown')); return c; }

    var fb = paneFeedback(CORE.SECTION.WALLET);
    if (fb) c.appendChild(fb);
    var busy = !!pending[CORE.SECTION.WALLET];
    var form = el('div', 'ecfg-form');
    form.appendChild(field(CORE.COPY.walletAbsentInput, CORE.COPY.walletAbsentInputHint, {
      name: 'bootstrapAmount', value: '', unit: CORE.COPY.walletAbsentUnit, placeholder: '1000'
    }));
    c.appendChild(form);
    if (confirmBootstrap) {
      c.appendChild(note(CORE.COPY.walletSetAsk, 'is-warn'));
      c.appendChild(actions([
        button(CORE.COPY.walletSetNo, 'ecfg-btn-quiet', function () { confirmBootstrap = false; render(); }, busy),
        button(busy ? CORE.COPY.saving : CORE.COPY.walletSet, 'ecfg-btn-primary', function () { doBootstrap(); }, busy)
      ]));
    } else {
      c.appendChild(actions([
        /* ★ 第一步点击时把当前输入**存成草稿**：确认这一步会重建整个面板，
           而用户刚敲进去的数不能因为一次重画就消失。input 事件也存草稿，
           但粘贴 / 自动填充 / 程序化赋值不一定触发它 —— 因此点击这一步
           是必须的兜底，不是冗余。 */
        button(CORE.COPY.walletSet, 'ecfg-btn-primary', function () {
          drafts.bootstrapAmount = valueOf('bootstrapAmount');
          confirmBootstrap = true;
          render();
        }, busy)
      ]));
    }
    return c;
  }

  /* ── P22-22 · 空状态说成"系统状态"，而不是一页错误（§A/§C）───────
     ★ 三件的顺序是刻意的：先说这一格现在是什么（一行状态），再说为什么
       没有"创建钱包"这个按钮（谁创建、为什么只有一次），最后才是输入框。
       一个 `role="status"` 的安静标记 + 两行短句 —— 没有警示色、没有感叹号。
     ★ 这里**不**给第二个按钮：界面没有"手工建钱包"这条接缝。 */
  function bootstrapStateSurface() {
    var box = el('div', 'ecfg-state');
    box.setAttribute('role', 'status');
    var head = el('div', 'ecfg-state-head');
    head.appendChild(svgOf('<rect x="4.6" y="9.2" width="14.8" height="10.2" rx="2.6"/><path d="M8.4 9.2V7.4a3.6 3.6 0 0 1 7.2 0v1.8"/>', 16, 'ecfg-state-mark'));
    head.appendChild(el('p', 'ecfg-state-text', CORE.COPY.walletAbsent));
    box.appendChild(head);
    var why = el('div', 'ecfg-state-why');
    why.appendChild(el('p', 'ecfg-state-line', CORE.COPY.walletAbsentBody));
    why.appendChild(el('p', 'ecfg-state-line', CORE.COPY.walletAbsentOnce));
    box.appendChild(why);
    return box;
  }

  function doBootstrap() {
    var built = CORE.buildBootstrapRequest(ownerId, valueOf('bootstrapAmount'), gestureKey(CORE.SECTION.WALLET, 'initial-credit'));
    if (built.ok !== true) return send(CORE.SECTION.WALLET, CORE.COMMAND.BOOTSTRAP_CREDIT, built);
    confirmBootstrap = false;
    return send(CORE.SECTION.WALLET, CORE.COMMAND.BOOTSTRAP_CREDIT, built).then(function () {
      clearGestureKey(CORE.SECTION.WALLET, 'initial-credit');
    });
  }

  /* ══ ② 预算限制 ═══════════════════════════════════════════════════ */
  /* ── P22-18 · §6：两条"体验"解释 ──────────────────────────────────
     ★ 它们都**只是话**：不改任何一条判定、不读任何新的读面、也不新增
       任何输入。放在这里是因为这一页的误解成本最高 —— 把"上限"读成
       "余额"、把"自主"读成"免审"，两者都会让用户对自己的钱做错判断。
     ★ 与既有 `.ecfg-gate` 同一种语言（一个小标记 + 一句话），因此这一页
       没有出现第四种提示样式。 */
  function experienceNotice(mark, title, body) {
    var box = el('div', 'ecfg-experience');
    box.setAttribute('role', 'note');
    box.appendChild(svgOf(mark, 16, 'ecfg-experience-mark'));
    var text = el('div', 'ecfg-experience-body');
    text.appendChild(el('p', 'ecfg-experience-title', title));
    text.appendChild(el('p', 'ecfg-experience-text', body));
    box.appendChild(text);
    return box;
  }
  function limitNotice() {
    return experienceNotice(
      '<path d="M5.2 12h13.6"/><path d="M8.4 8.4v7.2"/><path d="M15.6 8.4v7.2"/>',
      CORE.COPY.budgetIsALimit, CORE.COPY.budgetIsALimitBody);
  }

  function budgetCard() {    var b = view.budget;
    var c = card('budget', CORE.COPY.budgetTitle, CORE.COPY.budgetIntro);

    if (b.state === 'unknown' || b.state === 'malformed') {
      c.appendChild(note(b.text || CORE.COPY.readFailed, 'is-quiet'));
      if (b.detail) c.appendChild(technical([b.detail]));
      c.appendChild(actions([button(CORE.COPY.retry, 'ecfg-btn-quiet', function () { load(); })]));
      return c;
    }

    if (b.state === 'absent') c.appendChild(note(CORE.COPY.budgetAbsent, 'is-quiet'));
    /* ★ P22-18 · §6：一句解释放在**刻度之前**。它要回答的正是这一格最
       容易被误读的那件事 —— 这里的数字是上限，不是余额。 */
    c.appendChild(limitNotice());
    c.appendChild(meterBlock());

    var source = gateSource();
    if (source) { c.appendChild(closedNotice(source)); return c; }
    if (!view.canPutBudget) { c.appendChild(closedNotice(view.gateKnown ? 'closed' : 'unknown')); return c; }

    var fb = paneFeedback(CORE.SECTION.BUDGET);
    if (fb) c.appendChild(fb);
    var busy = !!pending[CORE.SECTION.BUDGET];
    var form = view.budgetForm || {};

    var primary = el('div', 'ecfg-form');
    for (var i = 0; i < CORE.LIMIT_FIELDS.length; i++) {
      var f = CORE.LIMIT_FIELDS[i];
      if (f.key === 'weeklyMinor' || f.key === 'monthlyMinor') continue;
      primary.appendChild(field(f.label, f.hint, {
        name: 'limit-' + f.key, value: form[f.key], unit: CORE.currencyLabel(CORE.CURRENCY)
      }));
    }
    c.appendChild(primary);

    var advChildren = [];
    for (var j = 0; j < CORE.LIMIT_FIELDS.length; j++) {
      var g = CORE.LIMIT_FIELDS[j];
      if (g.key !== 'weeklyMinor' && g.key !== 'monthlyMinor') continue;
      advChildren.push(field(g.label, g.hint, {
        name: 'limit-' + g.key, value: form[g.key], unit: CORE.currencyLabel(CORE.CURRENCY)
      }));
    }
    advChildren.push(field(CORE.COPY.budgetTerm, CORE.COPY.budgetTermHint, {
      name: 'termEndsAt', type: 'date', value: form.termEndsAt
    }));
    advChildren.push(field('冷却时间（毫秒）', '两次支出之间至少间隔多久。留空表示不设。', {
      name: 'cooldownMs', value: form[CORE.COOLDOWN_KEY]
    }));
    var levelBox = el('div', 'ecfg-field');
    levelBox.appendChild(el('span', 'ecfg-field-label', CORE.COPY.budgetLevel));
    levelBox.appendChild(segRow('autonomyLevel', CORE.AUTONOMY_LEVELS, form.autonomyLevel || '', CORE.AUTONOMY_LEVEL_LABEL));
    levelBox.appendChild(el('p', 'ecfg-field-hint', CORE.COPY.budgetLevelHint));
    advChildren.push(levelBox);
    c.appendChild(advanced(CORE.COPY.advanced, advChildren));

    c.appendChild(actions([
      button(busy ? CORE.COPY.saving : CORE.COPY.save, 'ecfg-btn-primary', function () { doBudget(); }, busy)
    ]));
    c.appendChild(note(CORE.COPY.budgetSavedNote, 'is-quiet'));
    return c;
  }

  /* 每日预算刻度。**两个数都直接来自权威读面**：
       · 上限  = GET /economy/policy 的 limits.dailyMinor
       · 已使用 = GET /economy/budget 的快照里的 spentTodayMinor
     ★ 读不到"已使用"时**不编一个进度**：退化成纯额度刻度（只显示上限），
       并把原因写成一句话。 */
  function meterBlock() {
    var m = view.meter;
    var box = el('div', 'ecfg-meter');
    box.appendChild(el('span', 'ecfg-meter-title', CORE.COPY.budgetMeterTitle));
    if (m.limitMinor == null) {
      box.appendChild(note(CORE.COPY.budgetMeterUnknown, 'is-quiet'));
      return box;
    }
    var track = el('div', 'ecfg-meter-track');
    var fill = el('div', 'ecfg-meter-fill');
    if (m.known) {
      fill.style.width = Math.round(m.ratioCapped * 100) + '%';
      if (m.over) fill.classList.add('is-over');
    } else {
      /* 纯额度刻度：没有进度，只有一条刻度线。 */
      fill.classList.add('is-scale');
      fill.style.width = '100%';
    }
    track.appendChild(fill);
    box.appendChild(track);
    var legend = el('div', 'ecfg-meter-legend');
    legend.appendChild(el('span', 'ecfg-meter-k', CORE.COPY.budgetMeterLimit));
    legend.appendChild(el('span', 'ecfg-meter-v', m.limitText || '—'));
    if (m.known) {
      legend.appendChild(el('span', 'ecfg-meter-k', CORE.COPY.budgetMeterUsed));
      legend.appendChild(el('span', 'ecfg-meter-v', m.usedText || '—'));
    }
    box.appendChild(legend);
    if (!m.known) {
      var why = m.reason === 'no-snapshot' ? '这位角色还没有可读的余额事实' : '权威还没有给出今日已用';
      box.appendChild(note(CORE.COPY.budgetMeterUnknown + '（' + why + '）', 'is-quiet'));
    }
    return box;
  }

  function doBudget() {
    var form = {};
    for (var i = 0; i < CORE.LIMIT_FIELDS.length; i++) {
      var k = CORE.LIMIT_FIELDS[i].key;
      form[k] = valueOf('limit-' + k);
    }
    form[CORE.COOLDOWN_KEY] = valueOf('cooldownMs');
    form.termEndsAt = valueOf('termEndsAt');
    form.autonomyLevel = segValue('autonomyLevel', '');
    form.ifRevision = (view && view.budget) ? view.budget.revision : '';
    var built = CORE.buildBudgetRequest(ownerId, form, gestureKey(CORE.SECTION.BUDGET, 'budget'));
    return send(CORE.SECTION.BUDGET, CORE.COMMAND.PUT_BUDGET_POLICY, built).then(function () {
      clearGestureKey(CORE.SECTION.BUDGET, 'budget');
    });
  }

  /* ══ ③ 自主购买 ═══════════════════════════════════════════════════ */
  function autonomyCard() {
    var a = view.autonomy;
    var c = card('autonomy', CORE.COPY.autonomyTitle, CORE.COPY.autonomyIntro);
    /* ★ P22-18 · §6：这条边界放在**表单之前**。等用户把开关拨完再解释
       "这不等于是免审" 就已经晚了 —— 误解是在拨开关的那一刻形成的。 */
    c.appendChild(experienceNotice(
      '<path d="M12 3.6l7 3v6c0 4-3 6.4-7 7.8-4-1.4-7-3.8-7-7.8v-6z"/><path d="M9.4 9.6l5.2 4.8"/>',
      CORE.COPY.autonomyNotBypass, CORE.COPY.autonomyNotBypassBody));

    if (a.state === 'unknown' || a.state === 'malformed') {
      c.appendChild(note(a.text || CORE.COPY.readFailed, 'is-quiet'));
      if (a.detail) c.appendChild(technical([a.detail]));
      c.appendChild(actions([button(CORE.COPY.retry, 'ecfg-btn-quiet', function () { load(); })]));
      return c;
    }
    if (a.state === 'absent') c.appendChild(note(CORE.COPY.autonomyAbsent, 'is-quiet'));

    var source = gateSource();
    if (source) { c.appendChild(closedNotice(source)); return c; }
    if (!view.canPutAutonomy) { c.appendChild(closedNotice(view.gateKnown ? 'closed' : 'unknown')); return c; }

    var fb = paneFeedback(CORE.SECTION.AUTONOMY);
    if (fb) c.appendChild(fb);
    var busy = !!pending[CORE.SECTION.AUTONOMY];
    var form = view.autonomyForm || {};

    var primary = el('div', 'ecfg-form');
    primary.appendChild(checkbox('enabled', form.enabled, CORE.COPY.autonomyEnabled, CORE.COPY.autonomyEnabledHint));
    primary.appendChild(field(CORE.COPY.autonomyPerPurchase, null, {
      name: 'perPurchaseLimitMinor', value: form.perPurchaseLimitMinor, unit: CORE.COPY.autonomyApprovalUnit
    }));
    primary.appendChild(field(CORE.COPY.autonomyDaily, null, {
      name: 'dailyAutonomousLimitMinor', value: form.dailyAutonomousLimitMinor, unit: CORE.COPY.autonomyApprovalUnit
    }));
    primary.appendChild(field(CORE.COPY.autonomyApproval, CORE.COPY.autonomyApprovalHint, {
      name: 'approvalAboveMinor', value: form.approvalAboveMinor, unit: CORE.COPY.autonomyApprovalUnit
    }));
    c.appendChild(primary);

    var kindsBox = el('div', 'ecfg-field');
    kindsBox.appendChild(el('span', 'ecfg-field-label', CORE.COPY.autonomyKinds));
    var kinds = el('div', 'ecfg-checks');
    for (var i = 0; i < CORE.PRODUCT_KINDS.length; i++) {
      var k = CORE.PRODUCT_KINDS[i];
      kinds.appendChild(checkbox('kind-' + k, form.allowedProductKinds && form.allowedProductKinds.indexOf(k) >= 0,
        CORE.PRODUCT_KIND_LABEL[k] || k, null));
    }
    kindsBox.appendChild(kinds);
    kindsBox.appendChild(el('p', 'ecfg-field-hint', CORE.COPY.autonomyKindsHint));
    c.appendChild(kindsBox);

    var settleBox = el('div', 'ecfg-field');
    settleBox.appendChild(el('span', 'ecfg-field-label', CORE.COPY.autonomySettlements));
    var settles = el('div', 'ecfg-checks');
    for (var j = 0; j < CORE.FULFILLMENTS.length; j++) {
      var s = CORE.FULFILLMENTS[j];
      settles.appendChild(checkbox('settle-' + s, form.allowedSettlementTypes && form.allowedSettlementTypes.indexOf(s) >= 0,
        CORE.FULFILLMENT_LABEL[s] || s, null));
    }
    settleBox.appendChild(settles);
    settleBox.appendChild(el('p', 'ecfg-field-hint', CORE.COPY.autonomySettlementsHint));
    /* §4 逐条要求表达"允许购买的商店范围"，而 canonical 契约里没有这个
       字段 —— 这里明说它不存在，而不是画一个不起作用的控件。 */
    settleBox.appendChild(note(CORE.COPY.autonomyNoStoreScope, 'is-quiet'));
    c.appendChild(settleBox);

    c.appendChild(checkbox('allowGift', form.allowGift, CORE.COPY.autonomyGift, CORE.COPY.autonomyGiftHint));

    c.appendChild(actions([
      button(busy ? CORE.COPY.saving : CORE.COPY.save, 'ecfg-btn-primary', function () { doAutonomy(); }, busy)
    ]));
    /* §4 逐字要求把这句话写出来。 */
    var bound = el('div', 'ecfg-bound');
    bound.appendChild(svgOf('<path d="M12 3.6l7 3v6c0 4-3 6.4-7 7.8-4-1.4-7-3.8-7-7.8v-6z"/><path d="M9.2 12.2l2 2 3.6-4"/>', 16, 'ecfg-bound-mark'));
    bound.appendChild(el('span', 'ecfg-bound-text', CORE.COPY.autonomyAuthorityNote));
    c.appendChild(bound);
    c.appendChild(note(CORE.COPY.autonomySavedNote, 'is-quiet'));
    return c;
  }

  function doAutonomy() {
    var form = {
      enabled: checked('enabled'),
      perPurchaseLimitMinor: valueOf('perPurchaseLimitMinor'),
      dailyAutonomousLimitMinor: valueOf('dailyAutonomousLimitMinor'),
      approvalAboveMinor: valueOf('approvalAboveMinor'),
      allowedProductKinds: checkedValues('kind-'),
      allowedSettlementTypes: checkedValues('settle-'),
      allowGift: checked('allowGift'),
      ifRevision: (view && view.autonomy) ? view.autonomy.revision : ''
    };
    var built = CORE.buildAutonomyRequest(ownerId, form, gestureKey(CORE.SECTION.AUTONOMY, 'autonomy'));
    return send(CORE.SECTION.AUTONOMY, CORE.COMMAND.PUT_AUTONOMY_POLICY, built).then(function () {
      clearGestureKey(CORE.SECTION.AUTONOMY, 'autonomy');
    });
  }

  /* ── 接线 ───────────────────────────────────────────────────────── */
  var api = Object.freeze({
    render: function () {
      if (!byId(CORE.ID.PAGE)) return false;
      if (stage === 'idle') { render(); load(); return true; }
      render();
      return true;
    },
    refresh: load,
    /* 给测试与诊断用：状态与视图模型的只读快照。 */
    snapshot: function () {
      return {
        section: section, ownerId: ownerId, owners: owners.slice(),
        stage: stage, syncedAt: syncedAt, failure: failure, notes: notes, view: view
      };
    },
    /* 测试与宿主可显式切页签（不经过 DOM 手势）。 */
    show: function (key) {
      var known = CORE.SECTIONS.filter(function (s) { return s.key === key; });
      if (!known.length) return false;
      section = key;
      confirmBootstrap = false;
      render();
      if (key !== CORE.SECTION.REQUESTS && stage === 'idle') load();
      return true;
    },
    copy: CORE.COPY,
    DOM: DOM,
    CORE: CORE
  });
  NS.economyConfigurationUI = api;

  /* 首次进入页面时 core.js 的 navTo 会调 render()；在此之前不主动读，
     因为绝大多数会话不会打开这一页（不制造无用的后台请求）。 */
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
})(window.IB || (window.IB = {}));
