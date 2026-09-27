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
  unlock: '<rect x="5.5" y="10.6" width="13" height="8.8" rx="2.2"/><path d="M8.7 10.6V8.3a3.3 3.3 0 0 1 6.2-1.3"/><path d="M12 14.2v2"/>',
  /* ── P22-18 · 时间线用的四个线稿（§8：circle / check / clock / arrow）──
     ★ 全部 24×24、currentColor、统一 stroke，因此两套主题自动适配。 */
  clock: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.4v4.8l3.2 2"/>',
  check: '<circle cx="12" cy="12" r="8.2"/><path d="M8.2 12.3l2.6 2.6 5-5.4"/>',
  ask: '<circle cx="12" cy="12" r="8.2"/><path d="M12 16.4v.1"/><path d="M9.6 9.6a2.5 2.5 0 1 1 3.1 2.4c-.5.2-.7.6-.7 1.1v.6"/>',
  arrow: '<path d="M5 12h13.4"/><path d="M14.2 7.8l4.2 4.2-4.2 4.2"/>',
  hold: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.8v4.4l2.8 1.8"/>',
  ledger: '<path d="M6.2 4.6h11.6v14.8H6.2z"/><path d="M9.2 8.4h5.6M9.2 11.6h5.6M9.2 14.8h3.4"/>',
  asset: '<path d="M12 3.8l7 4v8.4l-7 4-7-4V7.8z"/><path d="M5 7.8l7 4 7-4M12 11.8v8.4"/>',
  rule: '<path d="M5.4 6.4h13.2M5.4 12h13.2M5.4 17.6h13.2"/><circle cx="9.4" cy="6.4" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="8" cy="17.6" r="1.6"/>',
  cross: '<circle cx="12" cy="12" r="8.2"/><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6"/>',
  dot: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="2.6"/>'
});

/* ── 语气 → 线稿（§8）───────────────────────────────────────────────
   ★ 映射是封闭的：七个语气各有一张脸，而语气本身来自纯层的 TONE。
     于是"这一条画成什么"没有第二种答案，也不取决于任何经济判定。 */
var TONE_MARK = Object.freeze({
  money: 'ledger',
  hold: 'hold',
  ask: 'ask',
  decision: 'check',
  asset: 'asset',
  rule: 'rule',
  fail: 'cross',
  note: 'dot'
});
function markOfTone(tone) {
  return MARK[TONE_MARK[tone] || 'dot'] || MARK.dot;
}

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
      jobs.push(readJson(CORE.READS.WALLET, { ownerId: oid, currency: 'IB_CREDIT' }));
      jobs.push(readJson(CORE.READS.POLICY, { ownerId: oid }));
      jobs.push(readJson(CORE.READS.BUDGET, { ownerId: oid, currency: 'IB_CREDIT', amountMinor: '0' }));
      jobs.push(readJson(CORE.READS.INVENTORY, { ownerId: oid, limit: CORE.LIMITS.INVENTORY }));
      jobs.push(readJson(CORE.READS.PURCHASES, { buyerId: oid, limit: CORE.LIMITS.PURCHASES }));
      /* ★ 第九条只读面：canonical change log，**按 owner 作用域**读。
         作用域与方向都写在请求上，因此"哪些变化属于这个角色"由 canonical
         回答，而不是由这一层猜。没有选中角色时不读它 —— 而不是退回去读
         全局 change log（那会把别人的活动混进这一格）。 */
      jobs.push(loadChanges(oid));
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
      var changesRes = oid ? r[idx++] : null;
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
        inventory: inventoryRes, purchases: purchasesRes, changes: changesRes,
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

  /* ── 活动记录（§2 的时间线）─────────────────────────────────────────
     ★ ★ P22-19：读法换了，而且换的是**读法本身**，不是参数。

     之前：`/economy/changes` 是全局面，且是**从最早的往新的**一页页给
     （`WHERE revision > cursor ORDER BY revision ASC`），于是要在浏览器里
     做两件它做不到的事 —— ① 判断一条 change 属不属于这个角色；② 走到
     末尾才能拿到"最近"。两件都失败了（docs §2/§3 有逐行实测证据）：
     字段层的逐字比较漏掉 APPROVAL_APPROVED/REJECTED/CONSUMED，而分页层
     的 asc + 截断留下的是**最旧**的一段。

     现在：canonical 按 owner 作用域筛（`?ownerId=`），方向是 `desc`
     （从最新往旧），于是这一层拿到的是**这个角色的、从最近往前的**流。
     少一件事：不再有任何归属判断（`changeBelongsTo` 已删）。
     多一件事：说清楚窗口完不完整（complete / truncated / unknown）。

     ★ 走法仍然有界：每次 500 条（canonical 自己的上限），最多
       CHANGE_MAX_PAGES 页。desc 之下被上限挡住时留下的是**最新**的一段，
       因此 `truncated: true` 在页面上是一句**真话**：
       "这里只显示最近的一部分活动"。 */
  var CHANGE_PAGE = 500;
  var CHANGE_MAX_PAGES = 6;
  function loadChanges(oid) {
    var acc = [];
    var pages = 0;
    var cursor = 0;
    /* 截断的三态由读取器决定，页面照抄：
         complete  —— 某一页短了，走到了这一端；
         truncated —— 配额用完，或中途失败但仍拿到了前面的部分；
         unknown   —— 第一页就没读成（把失败原样交出去，让页面说"读不到"）。 */
    var truncated = null;
    function merged(revision) {
      return {
        ok: true,
        changes: acc,
        revision: revision == null ? null : Number(revision),
        pages: pages,
        /* 显式的三态标记：`buildTimelineModel` 只认 true/false，
           null 会被它读成 unknown。 */
        truncated: truncated === true
      };
    }
    function step() {
      /* owner 作用域与方向都在**请求**上，因此过滤发生在 canonical 的
         query 里，而不是在这一层。 */
      var params = {
        ownerId: oid,
        order: CORE.CHANGE_ORDER,
        cursor: cursor,
        limit: CHANGE_PAGE
      };
      return readJson(CORE.CHANGE_READ, params).then(function (res) {
        pages += 1;
        if (!res || res.ok !== true || !Array.isArray(res.changes)) {
          if (pages === 1) return res;
          truncated = true;
          return merged(null);
        }
        var batch = res.changes;
        /* desc 之下 cursor 是"取 revision 小于它的"，因此下一轮的游标是
           本页**最小**的那个 revision（不是最大的）。 */
        var next = null;
        for (var i = 0; i < batch.length; i += 1) {
          acc.push(batch[i]);
          var rv = Number(batch[i] && batch[i].revision);
          if (Number.isFinite(rv) && (next === null || rv < next)) next = rv;
        }
        /* 短页 = 走到这一端了。 */
        if (batch.length < CHANGE_PAGE) { truncated = false; return merged(res.revision); }
        if (pages >= CHANGE_MAX_PAGES) { truncated = true; return merged(res.revision); }
        cursor = next;
        return step();
      });
    }
    if (oid == null) {
      /* 没有选中的角色 ⇒ 不读。这一层**不**退回去读全局 change log：
         那会把别的角色的活动混进这一格，而这一格的全部意义就是"我的"。 */
      return Promise.resolve({ ok: true, changes: [], revision: null, pages: 0, truncated: false, noOwner: true });
    }
    return step();
  }

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
    /* ★ P22-22：页签之下、归属之上，先写上"这是哪一格、这一格看什么"。
       它跟着当前页签走（`render()` 本来就在切页签时重画），因此页签与
       标题永远同一批词。 */
    host.appendChild(sectionHead());
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

  /* ── P22-22 · 每格的标题与一句说明（§E）──────────────────────────
     ★ 它回答的是"我现在在哪一格、这一格看什么"。此前这一层只有一排页签，
       下面直接是卡片 —— 空状态时整页就只剩一个空盒子，读起来像一页错误。
     ★ 文本**全部**来自纯层的 SECTION_COPY，而且标题与页签同词：这一层
       不建第二份文案表，也不猜一个标题。 */
  function sectionHead() {
    var copy = CORE.sectionCopyOf(tab);
    var box = el('header', 'esh-section');
    box.appendChild(el('h2', 'esh-section-title', copy.title));
    box.appendChild(el('p', 'esh-section-sub', copy.sub));
    return box;
  }

  function paneOf(t) {    var pane = el('div', 'esh-pane');
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
  /* ★ P22-18 起第一行会随数据变化（"changes: 12 条"），因此多了一个显式
     key 参数：折叠状态必须由一个**稳定**的键决定，否则读回来一次就
     "自己合上"了 —— 而那正是这一层最容易被忽略的失效方式。 */
  function technical(lines, stableKey) {
    var key = stableKey == null ? String(lines[0] || 'technical') : String(stableKey);
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
     等宽的数字 + 一句它是什么 + 它属于谁。

     P22-18 在**同一格**里追加解释层（§2 明令"不要再增加页面"）：
       Wallet Summary · 活动时间线 · 经济活动 · 预算 · 支出说明 ·
       Agent 为什么提出 · 我的资产 · 高级信息（默认折叠）
     ★ 顺序不是装饰：先回答"我现在有多少"，再回答"它是怎么变成这样的"，
       最后才是"细节编号"。 */
  function overviewInto(pane) {
    pane.appendChild(walletCard());
    pane.appendChild(timelineCard());
    pane.appendChild(activityCard());
    pane.appendChild(budgetCard());
    pane.appendChild(spendingCard());
    pane.appendChild(whyCard());
    pane.appendChild(recentAssetsCard());
    pane.appendChild(auditCard());
  }

  /* ── 活动时间线（§2）──────────────────────────────────────────────
     每一行都指得回一条 canonical 记录：圆点的语气来自纯层的 TONE，
     时间来自 canonical 的毫秒，金额与数量来自那条 change 自己的 payload。
     ★ 页面**不**把两行合并成"发生了什么故事" —— 那是第二个叙述权威。
       它只把 canonical 已经分开记录的事件按 canonical 的顺序摆出来。 */
  function timelineCard() {
    var tl = view.timeline;
    var c = card('clock', CORE.COPY.timelineTitle, CORE.COPY.timelineSub);
    if (!tl.read) {
      c.appendChild(note(CORE.COPY.timelineUnavailable, 'is-quiet'));
      c.appendChild(timelineTechnical(tl));
      return c;
    }
    if (tl.empty) {
      c.appendChild(emptySurface('history', CORE.COPY.timelineEmpty, CORE.COPY.timelineEmptyBody));
      c.appendChild(timelineTechnical(tl));
      return c;
    }
    var list = el('ol', 'esh-timeline');
    for (var i = 0; i < tl.rows.length; i += 1) list.appendChild(timelineItem(tl.rows[i]));
    c.appendChild(list);
    /* ★ §7 的三态：页面**只**在 truncated 时说"只有最近的一部分"，
       并且**不**在 unknown 时把它说成 complete。两句不同的话。 */
    if (tl.completeness === CORE.COMPLETENESS.TRUNCATED) {
      c.appendChild(note(CORE.COPY.timelineTruncated, 'is-quiet'));
    } else if (tl.completeness === CORE.COMPLETENESS.UNKNOWN) {
      c.appendChild(note(CORE.COPY.timelineUncertain, 'is-quiet'));
    }
    c.appendChild(timelineTechnical(tl));
    return c;
  }
  function timelineItem(r) {
    var li = el('li', 'esh-tl');
    li.setAttribute('data-tone', r.tone || 'note');
    var mark = el('span', 'esh-tl-mark');
    mark.appendChild(svgOf(markOfTone(r.tone), 16, null));
    li.appendChild(mark);
    var body = el('div', 'esh-tl-body');
    var head = el('p', 'esh-tl-head');
    if (r.atText) head.appendChild(el('span', 'esh-tl-time', shortTime(r.atText)));
    head.appendChild(el('span', 'esh-tl-face', r.face));
    body.appendChild(head);
    var bits = [];
    if (r.quantity != null && r.quantity > 0) bits.push('×' + r.quantity);
    if (r.amountText) bits.push(r.amountText);
    if (bits.length) body.appendChild(el('p', 'esh-tl-sub', bits.join(' · ')));
    li.appendChild(body);
    return li;
  }
  /* 时间线上只要"几点几分"：日期在下面那一段里由技术层给出完整值。
     截取只作用于**已经格式化好的**那一串，因此它不改变时间的来源。 */
  function shortTime(text) {
    var s = String(text == null ? '' : text);
    var sp = s.indexOf(' ');
    return sp >= 0 ? s.slice(sp + 1) : s;
  }
  function timelineTechnical(tl) {
    var lines = [
      'changes: ' + tl.fetched + ' 条（本页显示 ' + tl.rows.length + ' 条）',
      /* ★ 归属不再由这一层判断：范围、顺序、完整性都是 canonical 的答案。 */
      '归属：canonical owner 作用域（ownerId=' + (tl.scopeOwnerId || tl.ownerId || '(无)') +
      ' · order=' + (tl.scopeOrder || tl.requestedOrder) + '）',
      '完整性 = ' + tl.completeness +
      (tl.completeness === 'complete' ? '（走到了这一端）'
        : (tl.completeness === 'truncated' ? '（只有最近的一段）' : '（读面没给出可用的窗口）')),
      'change log revision = ' + (tl.revision == null ? '(未读到)' : String(tl.revision)),
      CORE.COPY.canonicalCodes + '（变化）：' + codeList(CORE.CHANGE_KIND_FACE)
    ];
    return technical(lines, 'timeline');
  }

  /* ── 经济活动（§3：购买记录的升级）────────────────────────────────
     ★ canonical 的三张记录（Intent / Approval / Purchase）并排摆开，各自
       带着自己的时间；"来源"是**连出来的**，连不上就不写那一个词。
     ★ 这里没有购买按钮，也没有"再来一次" —— canonical 至今没有人类直接
       购买这条接缝（§11：本阶段不造）。 */
  function activityCard() {
    var a = view.activity;
    var c = card('history', CORE.COPY.activityTitle, CORE.COPY.activitySub);
    if (!a.read) {
      c.appendChild(note(CORE.COPY.readFailed, 'is-quiet'));
      return c;
    }
    if (a.empty) {
      c.appendChild(emptySurface('history', CORE.COPY.purchasesEmpty, CORE.COPY.purchasesEmptyBody));
      return c;
    }
    /* ★ 明细有上限：概览不是无底洞。被截住多少条**说出来**，而更早的那些
       在「活动时间线」那一格里。
       ★ ★ P22-19：这句话只在那一格**真的**读完整时才成立。截断时它换成
       另一句 —— 同一页上两格对完整性给出互相矛盾的说法，比不说还坏。 */
    var shown = Math.min(a.rows.length, CORE.ACTIVITY_KEEP);
    for (var i = 0; i < shown; i += 1) c.appendChild(activityItem(a.rows[i]));
    if (a.rows.length > shown) {
      c.appendChild(note(CORE.COPY.activityMorePrefix + (a.rows.length - shown) +
        (a.timelineIsComplete ? CORE.COPY.activityMoreSuffix : CORE.COPY.activityMoreSuffixPartial),
        'is-quiet'));
    }
    var tech = [CORE.COPY.canonicalCodes + '（购买）：' + codeList(CORE.PURCHASE_STATE_FACE),
      CORE.COPY.canonicalCodes + '（请求）：' + codeList(CORE.INTENT_STATE_FACE),
      CORE.COPY.canonicalCodes + '（决定）：' + codeList(CORE.APPROVAL_STATE_FACE)];
    for (var k = 0; k < a.rows.length && k < 8; k += 1) {
      tech.push((a.rows[k].purchaseId || '(no id)') + ' · ' + (a.rows[k].status || '—') +
        (a.rows[k].mode == null ? ' · approvalMode=null' : (' · ' + a.rows[k].mode)));
    }
    c.appendChild(technical(tech));
    return c;
  }
  function activityItem(r) {
    var box = el('article', 'esh-activity');
    var head = el('header', 'esh-act-head');
    var main = el('div', 'esh-act-main');
    main.appendChild(el('span', 'esh-row-name', r.name));
    if (r.atText) main.appendChild(el('span', 'esh-row-sub', r.atText));
    head.appendChild(main);
    var side = el('div', 'esh-act-side');
    if (r.amountText) side.appendChild(el('span', 'esh-row-amount', r.amountText));
    side.appendChild(el('span', 'esh-status', r.statusFace));
    head.appendChild(side);
    box.appendChild(head);

    /* 来源：每一个词后面都有一条证据（没有证据的词不会出现在这里）。 */
    if (r.source.length) {
      var src = el('div', 'esh-act-sources');
      src.appendChild(el('span', 'esh-act-label', CORE.COPY.sourceTitle));
      for (var s = 0; s < r.source.length; s += 1) {
        src.appendChild(el('span', 'esh-act-src esh-src-' + r.source[s].key, r.source[s].face));
        /* 角色名只在连得上时出现一次，而且它是一个**独立的元素**：
           来源那一列说的是"哪一类来源"，这一句说的是"是谁"。 */
        if (r.source[s].who) src.appendChild(el('span', 'esh-act-who', r.source[s].who));
      }
      box.appendChild(src);
    } else {
      box.appendChild(note(CORE.COPY.sourceUnknown, 'is-quiet'));
    }

    /* 时间线：Intent → Approval → Purchase（三步，各带 canonical 的时间）。 */
    var steps = el('ol', 'esh-steps');
    steps.appendChild(el('span', 'esh-steps-label', CORE.COPY.stepsTitle));
    for (var t = 0; t < r.steps.length; t += 1) steps.appendChild(stepItem(r.steps[t]));
    box.appendChild(steps);
    return box;
  }
  function stepItem(st) {
    var li = el('li', 'esh-step' + (st.present ? ' is-there' : ' is-absent'));
    li.setAttribute('data-step', st.key);
    var mark = el('span', 'esh-step-mark');
    mark.appendChild(svgOf(st.present ? MARK.check : markOfTone('note'), 14, null));
    li.appendChild(mark);
    var body = el('div', 'esh-step-body');
    body.appendChild(el('span', 'esh-step-label', st.label));
    /* ★ "这一步没有发生"的**原因**也要说：三种原因的措辞各不相同，
       统一成一句"无"会把"旧记录"与"自主放行"混成同一个答案。 */
    body.appendChild(el('span', 'esh-step-sub', st.present
      ? ((st.stateFace || '') + (st.atText ? (' · ' + st.atText) : ''))
      : (st.absentText || CORE.COPY.stepNotApplicable)));
    li.appendChild(body);
    return li;
  }

  /* ── 支出说明（§2）────────────────────────────────────────────────
     ★ 合计旁边逐字写着它是**这一页**加出来的，权威的当日累计在「预算」
       那一格（canonical 自己算的）。两个数并排放而不合并，是因为它们的
       出处不同 —— 合并就会造出第二个"花了多少"。 */
  function spendingCard() {
    var sp = view.spending;
    var c = card('credit', CORE.COPY.spendTitle, CORE.COPY.spendSub);
    if (!sp.read) {
      c.appendChild(note(CORE.COPY.readFailed, 'is-quiet'));
      return c;
    }
    if (sp.isEmpty) {
      c.appendChild(note(CORE.COPY.spendNone, 'is-quiet'));
      return c;
    }
    var total = el('div', 'esh-spend-total');
    total.appendChild(el('span', 'esh-spend-l', CORE.COPY.spendTotal));
    total.appendChild(el('span', 'esh-spend-v', sp.totalText == null ? '—' : String(sp.totalText)));
    c.appendChild(total);
    c.appendChild(note(CORE.COPY.spendTotalNote, 'is-quiet'));
    if (sp.saturated) c.appendChild(note(CORE.COPY.spendSaturated, 'is-quiet'));
    if (sp.missingAmountRows > 0) c.appendChild(note(CORE.COPY.spendUnknownAmount, 'is-quiet'));
    var list = el('ul', 'esh-list');
    for (var i = 0; i < sp.rows.length && i < 6; i += 1) {
      var r = sp.rows[i];
      var li = el('li', 'esh-row');
      var main = el('div', 'esh-row-main');
      main.appendChild(el('span', 'esh-row-name', r.name));
      main.appendChild(el('span', 'esh-row-sub', r.atText || '—'));
      li.appendChild(main);
      var side = el('div', 'esh-row-side');
      if (r.amountText) side.appendChild(el('span', 'esh-row-amount', r.amountText));
      li.appendChild(side);
      list.appendChild(li);
    }
    c.appendChild(list);
    c.appendChild(technical([
      'spend rows: ' + sp.count + ' / missing amount: ' + sp.missingAmountRows,
      'totalMinor = ' + String(sp.totalMinor) + '（本页整数相加，未经过浮点）'
    ], 'spending'));
    return c;
  }

  /* ── Agent 为什么提出（§4）────────────────────────────────────────
     ★ 这一格的纪律只有一条：**一个字节都不改**。原因逐字来自 canonical
       的 intent.reason，本页不摘要、不改写、不再让模型解释一次 —— 第二份
       解释就是第二个权威，而两份不一致时用户没有办法判断。 */
  function whyCard() {
    var ex = view.explanations;
    var c = card('ask', CORE.COPY.whyTitle, CORE.COPY.whySub);
    if (!ex.read) {
      c.appendChild(note(CORE.COPY.whyUnavailable, 'is-quiet'));
      return c;
    }
    if (ex.empty) {
      c.appendChild(note(CORE.COPY.whyEmpty, 'is-quiet'));
      return c;
    }
    for (var i = 0; i < ex.rows.length && i < 6; i += 1) {
      var r = ex.rows[i];
      var box = el('article', 'esh-why');
      var head = el('header', 'esh-why-head');
      head.appendChild(el('span', 'esh-row-name', r.name));
      head.appendChild(el('span', 'esh-status', r.stateFace));
      box.appendChild(head);
      var dl = el('dl', 'esh-why-facts');
      dl.appendChild(el('dt', 'esh-why-dt', CORE.COPY.whyReasonLabel));
      /* 理由**原样**：textContent 意味着连换行都不会被解释成结构。 */
      dl.appendChild(el('dd', 'esh-why-dd is-reason', r.reason == null ? CORE.COPY.whyNoReason : r.reason));
      if (r.unitsText != null) {
        dl.appendChild(el('dt', 'esh-why-dt', CORE.COPY.whyUnitsLabel));
        dl.appendChild(el('dd', 'esh-why-dd', r.unitsText));
      }
      box.appendChild(dl);
      box.appendChild(note(CORE.COPY.whyVerbatim, 'is-quiet'));
      if (r.atText) box.appendChild(el('p', 'esh-card-foot', r.atText));
      c.appendChild(box);
    }
    return c;
  }

  /* ── 高级信息（§7）────────────────────────────────────────────────
     ★ 默认折叠，并且里面**只有**四个编号。数据库行、账本内部结构、
       revision、迁移状态一个都不出现（§7 明令）。 */
  var auditOpen = false;
  function auditCard() {
    var a = view.audit;
    var c = el('section', 'esh-card esh-audit');
    var head = el('header', 'esh-card-head');
    head.appendChild(svgOf(MARK.dot, 18, 'esh-mark'));
    var titles = el('div', 'esh-card-titles');
    titles.appendChild(el('h3', 'esh-card-title', CORE.COPY.auditTitle));
    titles.appendChild(el('p', 'esh-card-sub', CORE.COPY.auditSub));
    head.appendChild(titles);
    c.appendChild(head);
    var toggle = el('button', 'esh-audit-toggle', (auditOpen ? CORE.COPY.auditClose : CORE.COPY.auditOpen) + (auditOpen ? ' ▾' : ' ▸'));
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', auditOpen ? 'true' : 'false');
    toggle.addEventListener('click', function () { auditOpen = !auditOpen; render(); });
    var act = el('div', 'esh-actions');
    act.appendChild(toggle);
    c.appendChild(act);
    /* ★ 体内同时带 `esh-technical`：canonical 的编号**按定义**属于"折叠的
       技术层"这一类，而 P22-17 那条"正文里没有原始代号"的纪律正是以这个
       class 为界的（本阶段不放开它，只把这一格放进那一类里）。 */
    var body = el('div', 'esh-technical esh-audit-body');
    body.hidden = !auditOpen;
    if (!a.count) {
      body.appendChild(note(CORE.COPY.auditNone, 'is-quiet'));
    } else {
      var table = el('div', 'esh-audit-table');
      table.appendChild(auditHead());
      for (var i = 0; i < a.rows.length; i += 1) table.appendChild(auditRow(a.rows[i]));
      body.appendChild(table);
    }
    body.appendChild(note(CORE.COPY.auditNote, 'is-quiet'));
    c.appendChild(body);
    return c;
  }
  function auditHead() {
    var row = el('div', 'esh-audit-row is-head');
    row.appendChild(el('span', 'esh-audit-cell', ''));
    row.appendChild(el('span', 'esh-audit-cell', CORE.COPY.auditIntent));
    row.appendChild(el('span', 'esh-audit-cell', CORE.COPY.auditApproval));
    row.appendChild(el('span', 'esh-audit-cell', CORE.COPY.auditPurchase));
    row.appendChild(el('span', 'esh-audit-cell', CORE.COPY.auditQuote));
    return row;
  }
  function auditRow(r) {
    var row = el('div', 'esh-audit-row');
    row.appendChild(el('span', 'esh-audit-cell esh-audit-name', r.name));
    /* ★ 每一格自己带一个**它是什么**：宽屏上表头已经说了，窄屏上四列会
       堆成一列，而没有这个前缀就只剩四个裸编号 —— 而这一格存在的理由正是
       "对着记录排查"。属性由 CSS 的 ::before 显示，DOM 因此没有多一层。 */
    var cols = [
      { key: 'agentIntentId', label: CORE.COPY.auditIntent },
      { key: 'approvalId', label: CORE.COPY.auditApproval },
      { key: 'purchaseId', label: CORE.COPY.auditPurchase },
      { key: 'quoteId', label: CORE.COPY.auditQuote }
    ];
    for (var i = 0; i < cols.length; i += 1) {
      var v = r.refs ? r.refs[cols[i].key] : null;
      var cell = el('span', 'esh-audit-cell esh-audit-id', v == null ? CORE.COPY.auditNone : String(v));
      cell.setAttribute('data-k', cols[i].label);
      row.appendChild(cell);
    }
    return row;
  }

  function walletCard() {
    var w = view.wallet;
    var c = card('credit', CORE.COPY.walletTitle, CORE.COPY.walletKind);
    /* ★ 三种形态各有各的话：
         ① 尚未完成 Initial Bootstrap —— 说清"这是哪一个系统状态"，再给
            两件产品事实（谁创建它、为什么没有创建按钮），最后才是"下一步"；
        ② 账户在、余额不可信（COLD / DEGRADED）—— 画**破折号**而不是 0，
            下面一句解释为什么这里没有数字；
        ③ 余额可信 —— 权威的那个数字。
       ②保留数字格是刻意的：卡片高度不跳，而且"这里本该有一个数字，只是
       现在读不到"比"这一格不存在"更准确。 */
    if (w.absent) {
      c.appendChild(walletBootstrapSurface(w));
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
    /* ── §2 的"最近变化"────────────────────────────────────────────
       ★ 它来自 canonical 的 change log（最近一次真的动了钱的记录），
         **不是**从余额反推出来的。一条都读不到时说的是"暂无记录"，
         而**不是**"0"或"没有变化" —— 前者是事实，后者是一个结论。 */
    c.appendChild(recentChangeLine());
    c.appendChild(assetOwnerLine());
    c.appendChild(walletTechnical(w));
    return c;
  }

  /* ── P22-22 · "尚未完成 Initial Bootstrap" 这一格的形态（§A/§B）────
     ★ 它读起来必须像一个**系统状态**，不是一页错误：一个安静的状态标记
       （`role="status"`，不是 alert），三行短句，然后才是"下一步"。
     ★ 三行各回答一个问题，顺序固定：
         状态 —— 这一格现在是什么（尚未完成 Initial Bootstrap）
         原因 —— 谁创建额度账户 / 为什么没有"创建"按钮 / 为什么只能发一次
         下一步 —— 用户现在能做的那一件事
     ★ **没有**第二个按钮：这一格的动作只有一个（去设置），因为 canonical
       到今天为止没有"人类手工建钱包"这条接缝。 */
  function walletBootstrapSurface(w) {
    var box = el('div', 'esh-bootstrap');
    box.setAttribute('role', 'status');
    var head = el('div', 'esh-bootstrap-head');
    head.appendChild(svgOf(MARK.lock, 16, 'esh-bootstrap-mark'));
    head.appendChild(el('p', 'esh-bootstrap-state', CORE.COPY.walletBootstrapState));
    box.appendChild(head);
    var why = el('div', 'esh-bootstrap-why');
    why.appendChild(el('p', 'esh-bootstrap-line', CORE.COPY.walletAbsentWhy));
    why.appendChild(el('p', 'esh-bootstrap-line', CORE.COPY.walletAbsentNoManual));
    box.appendChild(why);
    var foot = el('div', 'esh-bootstrap-foot');
    var next = el('div', 'esh-bootstrap-next');
    next.appendChild(el('span', 'esh-bootstrap-next-label', CORE.COPY.nextStep));
    next.appendChild(el('p', 'esh-bootstrap-next-text', CORE.COPY.walletAbsentBody));
    foot.appendChild(next);
    var act = el('div', 'esh-actions');
    act.appendChild(goToButton(CORE.COPY.walletAbsentGo, CORE.TAB.SETTINGS));
    foot.appendChild(act);
    box.appendChild(foot);
    box.appendChild(assetOwnerLine());
    box.appendChild(walletTechnical(w));
    return box;
  }
  function recentChangeLine() {
    var box = el('div', 'esh-recent');
    box.appendChild(el('span', 'esh-recent-l', CORE.COPY.recentChange));
    var tl = view.timeline;
    var last = tl ? tl.lastBalanceChange : null;
    if (!tl || !tl.read || last == null) {
      box.appendChild(el('span', 'esh-recent-none', CORE.COPY.recentChangeNone));
      return box;
    }
    var right = el('span', 'esh-recent-v');
    right.appendChild(el('span', 'esh-recent-face', last.face));
    var bits = [];
    if (last.atText) bits.push(last.atText);
    if (last.amountText) bits.push(last.amountText);
    if (bits.length) right.appendChild(el('span', 'esh-recent-when', bits.join(' · ')));
    box.appendChild(right);
    return box;
  }
  function assetOwnerLine() {
    var picked = CORE.resolveOwnerOf(owners, ownerId);
    return el('p', 'esh-card-foot', picked ? picked.label : CORE.COPY.ownerEmpty);
  }
  function walletTechnical(w) {
    return technical(walletTechnicalLines(w), 'wallet');
  }
  /* ── P22-22 · 技术说明的四行（§B）──────────────────────────────────
     ★ 默认折叠，因此它**不占**这一格的高度；展开才看得见。
     ★ 四行各回答一件底层的事，而且是用户自己要不要看才看的：
         Home Node token —— **只说配没配、多长**，绝不写它的值（P5 契约：
                            凭据不进正文、不进导出、不进日志）；
         endpoint        —— 这一页读的是哪一台本机节点（默认 127.0.0.1:23118，
                            可被 localStorage 覆盖，因此读实际的而不是写死的）；
         runtime         —— 浏览器侧的传输形态（协议头与请求模式），
                            以及这一页有没有走 index.html 之外的构建步骤（没有）。
     ★ 取不到就写"（这一层读不到）"，**不猜**一个看起来合理的值。 */
  function walletTechnicalLines(w) {
    var lines = [
      w.state == null ? 'wallet: (未读到)' : ('state = ' + w.state),
      w.currency == null ? 'currency = (未读到)' : ('currency = ' + w.currency),
      CORE.COPY.canonicalCodes + '（钱包）：' + codeList(CORE.WALLET_STATE_FACE),
      CORE.COPY.readPaths + '：' + CORE.readPathList().join(' · '),
      technicalEnvLine(),
      technicalTokenLine(),
      technicalRuntimeLine()
    ];
    return lines;
  }
  function technicalEnvLine() {
    var base = null;
    try { if (typeof NS.ibHomeNodeBase === 'function') base = NS.ibHomeNodeBase(); } catch (e) { base = null; }
    if (!base) return 'endpoint：这一层读不到本机节点地址（传输实现可能没加载）。';
    return 'endpoint：' + String(base);
  }
  /* ★ 令牌本身一个字符都不出现：可读的长度与"配没配"足够排查，
     而值从这里流出去就会进截图、进导出。 */
  function technicalTokenLine() {
    var token = null;
    try { if (typeof NS.ibHomeNodeToken === 'function') token = NS.ibHomeNodeToken(); } catch (e) { token = null; }
    if (token == null) return 'Home Node token：这一层读不到（传输实现可能没加载）。';
    var value = String(token);
    return value
      ? ('Home Node token：已配置（' + value.length + ' 个字符，值不在这里显示）。')
      : 'Home Node token：没有配置（本机节点因此按无凭据对待）。';
  }
  function technicalRuntimeLine() {
    var mode = null;
    try { if (typeof NS.ibHomeNodeMode === 'function') mode = NS.ibHomeNodeMode(); } catch (e) { mode = null; }
    return 'runtime：浏览器页面直接读本机节点（X-IB-Protocol: 1' +
      (mode ? ('，模式 = ' + String(mode)) : '') + '）；这一页没有额外的构建产物。';
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
  /* ── P22-18：原来的「最近购买」卡已被「经济活动」取代（§3）。
     它现在与 intent / approval 并排摆开，并带回"这一步走到哪了"；
     因此这个函数**被删掉而不是留着**，免得下一个人以为页面上有两份购买历史。 */

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
    /* ── P22-26 · 功能说明（§6）─────────────────────────────────────────
       ★ 它是 `fulfillment`（+ kind）的一句人话，由纯层派生 —— 不落库、不进
       DTO、不参与任何判定。
       ★ 它刻意**不**说"你能买"或"要多少钱才够"：那两句的答案在 Economy 规则
       与预算那里，而这一页只显示货架。 */
    if (r.functionFace) {
      var fn = el('p', 'esh-product-function');
      fn.appendChild(el('span', 'esh-product-function-label', CORE.COPY.productFunctionTitle));
      fn.appendChild(el('span', 'esh-product-function-text', r.functionFace));
      body.appendChild(fn);
    }
    /* ── P22-26 · 购买后的结果预览（§6）───────────────────────────────
       ★ 它只说"买完会多什么"，**不**预测金额、余额或可用性。
       ★ 措辞里"会多出 N 件"的部分由 grantQuantity + unitName 派生，因此它
       与 `unitLineOf` 读的是同一份事实（不会互相漂移）。 */
    if (r.resultPreview) {
      var rp = el('p', 'esh-product-result');
      rp.appendChild(el('span', 'esh-product-result-label', CORE.COPY.productResultTitle));
      rp.appendChild(el('span', 'esh-product-result-text', r.resultPreview));
      body.appendChild(rp);
    }
    var facts = el('div', 'esh-product-facts');
    if (r.priceText) facts.appendChild(el('span', 'esh-product-price', r.priceText));
    if (r.unitLine) facts.appendChild(el('span', 'esh-product-unitline', r.unitLine));
    /* ── P22-26 · 已拥有数量（§6）─────────────────────────────────────
       ★ 数字来自 canonical 的 `economy_inventory` 那一行（这一页本来就同时
       读库存，因此**没有**新的网络调用）。读不到库存时 `ownedText` 是 null，
       这一段就不出现 —— "读不到"与"一件都没有"是两件不同的事。
       ★ 它**不**在呈现层再算一遍：那个数字就是那一行的 quantity。 */
    if (r.ownedText) {
      facts.appendChild(el('span', 'esh-product-owned', r.ownedText));
    }
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
