/* ====================================================================
   IB · Economy Shell — 纯层（P22-17）
   --------------------------------------------------------------------
   这一层回答的是"从五条既有只读面读回来的 JSON 长成什么样子"，而它
   **一行业务事实都不算**：

     · 余额够不够        —— 不算（那是 canonical 的 availableBalanceMinor）
     · 一次能不能买      —— 不算（那是 P22-7 / P22-8 的裁决）
     · 库存算不算钱      —— 不算（canonical 逐字说 isABalance === false）
     · 商品排第几        —— 不算（顺序就是读面给的顺序）
     · 这笔为什么没问用户 —— 不算（那是冻结在 Purchase 行上的 approvalMode）

   它做的事只有三类：
     ① **搬运**：canonical 的字段 → 人话（状态词、单位、金额、时间）；
     ② **连接**：把两条读面按 canonical 自己的键连起来
        （inventory.productId ↔ product.productId，
          purchase.productId  ↔ product.productId，
          intent.purchaseId  ↔ purchase.purchaseId）；
     ③ **视觉身份**：productId 的确定性哈希 → CSS 变量。
        它只影响颜色/角度/线稿，**不**参与价格、排序、推荐、可否购买，
        也不把 buyerId / 关系 / 亲和度放进哈希（§4）。

   ── 谁拥有什么（本阶段不复制任何既有实现）────────────────────────────
     · 币种 scale / 展示名、商品类别与交付方式的中文、角色目录解析、
       金额格式化 —— 全部**复用** assets/js/economy-configuration-core.js
       的那一份镜像（P4 契约：元数据只有一个出处）。本文件不建第二张表，
       因此下一个人改币种名时只有一处要改。
     · 「待处理」那一块是 P22-15 的，「设置」那一块是 P22-16 的；
       本文件连它们的 DOM 都不认，只认页签顺序（见 TABS 的 delegate）。

   加载顺序与 P22-16 的纯层同款：所有判断都写成函数，模块顶层只做
   常量与冻结表的构造（可在没有 document / fetch / location 的沙箱里跑）。
   ==================================================================== */
(function (NS) {
'use strict';

/* ── P22-16 纯层是**依赖**，不是可选项 ────────────────────────────────
   币种与商品类别的中文只在那一个地方。若它没加载，本层**不**回退到
   自己的一张表：那会让"币种名"有两份，其中一份迟早会漂。
   available=false 时整页显示一句诚实的失败，而不是显示 canonical 代号
   （§"canonical code 不裸漏给普通用户"）。 */
var CFG = NS.economyConfigurationCore || null;

var CORE_VERSION = 'p22-17-1';

/* ══ DOM 锚点 ═══════════════════════════════════════════════════════
   ★ 三个既有事实一个字节都不改：
       PAGE          —— Economy 页面本身（HTML 里就有）
       REQUESTS_HOST —— P22-15 的容器（HTML 里就是空的）
       CONFIG_HOST   —— P22-16 的外壳（它自己运行时插进去的）
     本模块只**追加**自己的一个节点，并用一个页面级 class 表示当前
     外层的页签。三者的 DOM 位置因此逐字不变（P22-15/16 的结构断言
     继续成立），可见性由这个 class + 各自的 display 决定。 */
var ID = Object.freeze({
  PAGE: 'page-economy',
  SHELL: 'economy-shell',
  TABS: 'economy-shell-tabs',
  OWNER_BAR: 'economy-shell-owner',
  OWNER_SELECT: 'economy-shell-owner-select',
  OVERVIEW_PANE: 'economy-shell-overview',
  STORE_PANE: 'economy-shell-store',
  ASSETS_PANE: 'economy-shell-assets',
  REQUESTS_HOST: 'economy-requests',
  CONFIG_HOST: 'economy-configuration',
  /* 页面级 class 前缀：`ibecon-tab-<key>` 逐字对应当前外层页签。 */
  TAB_CLASS_PREFIX: 'ibecon-tab-'
});

/* ══ 外层页签（**五**个，§2）═══════════════════════════════════════
   ★ delegate 说的是"这一格的可见性由谁负责"：
       null       —— 本模块自己画（paneId 是它的面板 id）；
       'approval' —— P22-15 的容器，本模块只按页签开合；
       'config'   —— P22-16 的外壳，本模块只按页签开合。
     于是"不复制 P22-15/16 的实现"是**结构**事实：本文件里既没有
     approval 的卡片，也没有 config 的表单。 */
var TAB = Object.freeze({
  OVERVIEW: 'overview', STORE: 'store', ASSETS: 'assets',
  REQUESTS: 'requests', SETTINGS: 'settings'
});
var TABS = Object.freeze([
  Object.freeze({ key: TAB.OVERVIEW, label: '概览', paneId: ID.OVERVIEW_PANE, delegate: null, needsOwner: true }),
  Object.freeze({ key: TAB.STORE, label: '商店', paneId: ID.STORE_PANE, delegate: null, needsOwner: false }),
  Object.freeze({ key: TAB.ASSETS, label: '我的资产', paneId: ID.ASSETS_PANE, delegate: null, needsOwner: true }),
  Object.freeze({ key: TAB.REQUESTS, label: '待处理', paneId: null, delegate: 'approval', needsOwner: false }),
  Object.freeze({ key: TAB.SETTINGS, label: '设置', paneId: null, delegate: 'config', needsOwner: false })
]);
var TAB_KEYS = Object.freeze(TABS.map(function (t) { return t.key; }));
function isTabKey(key) {
  return key != null && TAB_KEYS.indexOf(String(key)) >= 0;
}

/* ══ 只读面：**八**条既有 GET，本阶段一条新路由都不加 ═══════════════
   ★ 每一条都是 P22-2 ~ P22-8 已经交付并被测试钉住的读面。本阶段对
     services/ 与 runtime/ 的改动是 **0**。 */
var READS = Object.freeze({
  WALLET: '/economy/wallet',
  STORES: '/economy/stores',
  PRODUCTS: '/economy/products',
  INVENTORY: '/economy/inventory',
  PURCHASES: '/economy/purchases',
  INTENTS: '/economy/intents',
  POLICY: '/economy/policy',
  BUDGET: '/economy/budget'
});

/* ══ 读面窗口 ═══════════════════════════════════════════════════════
   ★ 刻意写成常量并**在模型里带出** saturated：一个被截断的窗口不能
     被当成"全部"。商品数量、历史条数都会因此退回"不显示数字"，而不是
     显示一个看起来精确的错数。 */
var LIMITS = Object.freeze({
  STORES: 100, PRODUCTS: 200, INVENTORY: 200, PURCHASES: 50, INTENTS: 200
});

/* ══ 状态词表（canonical 封闭集合 → 人话）═══════════════════════════
   ★ 每一个键都逐字来自契约的封闭集合，而且测试会逐字比对：
       STORE_STATUS         ACTIVE / DISABLED
       PRODUCT_STATUS       ACTIVE / DISABLED / RETIRED
       PURCHASE_STATE       RESERVED / COMPLETED / RELEASED / FAILED
       ASSET_KIND           ITEM / COMPUTE（SERVICE 的 assetKind 是 null）
       PURCHASE_APPROVAL_MODE  AUTO_ALLOW / APPROVAL（外加"早于授权层"的 null）
       WALLET_STATE         COLD / READY / DEGRADED
   普通用户看到的**只有**右边那一列；代号本身只在折叠的技术层里。 */
var STORE_STATUS_FACE = Object.freeze({
  ACTIVE: '开放中',
  DISABLED: '已停用'
});
var PRODUCT_STATUS_FACE = Object.freeze({
  /* ★ 说的是**目录状态**，不是"你能买"：能不能申请由 Economy 规则与预算
     决定，本页不替它们回答（§5）。 */
  ACTIVE: '在架上',
  DISABLED: '暂停提供',
  RETIRED: '已下架'
});
var PURCHASE_STATE_FACE = Object.freeze({
  RESERVED: '进行中',
  COMPLETED: '已完成',
  RELEASED: '已退回',
  FAILED: '没有完成'
});
var ASSET_KIND_FACE = Object.freeze({
  ITEM: '物品',
  COMPUTE: '算力额度'
});
var AUTH_MODE_FACE = Object.freeze({
  AUTO_ALLOW: '按自主规则完成，没有打扰你',
  APPROVAL: '你同意之后完成'
});
var WALLET_STATE_FACE = Object.freeze({
  COLD: '这个角色的额度还没有读出来。',
  READY: '',
  DEGRADED: '暂时读不到权威额度，因此这里不显示数字。'
});
/* canonical 的 unitName 只有三个成员（契约 PRODUCT_UNIT_NAME）。 */
var UNIT_FACE = Object.freeze({
  item: '件',
  computeUnit: '算力单位',
  service: '次'
});

/* ══ 文案 ═══════════════════════════════════════════════════════════
   ★ 三条硬要求逐字落在这里：
     ① §3 的禁用词一个都不出现（充值 / 提现 / 转账 / 银行卡 / 现金 /
        人民币 / 美元 / 账户价值）；
     ② Compute 只有**一个**说法：IB 内部的算力额度 —— 它不是 API 余额、
        不是 Token 余额、不是任何 Provider 的额度；
     ③ 商品页**没有**购买动作：这里只能说"Agent 可以申请"，因为 canonical
        到今天为止**没有**人类直接购买这条接缝（本阶段不造，见 docs）。 */
var COPY = Object.freeze({
  title: 'Economy',
  subtitle: '内部资源',
  tablistLabel: 'Economy 分区',
  ownerLabel: '这是谁的',
  ownerHint: '额度与资产都属于某个角色。',
  ownerEmpty: '还没有配置任何角色',
  ownerEmptyBody: 'Economy 里的额度与资产都属于角色。先在「API」里添加一位角色，再回到这里。',
  refresh: '重新读取',
  retry: '再试一次',
  reading: '读取中…',
  readFailed: '读不到本机节点',
  readFailedBody: '这台设备还没连上本机节点，因此这一页现在没有真实数据可显示。',
  coreMissing: '经济模块没有加载',
  coreMissingBody: '这一页需要的展示层缺失，因此这里不显示任何数字 —— 我们宁可空着，也不显示一个可能是错的数。',

  walletTitle: 'IB Credit',
  walletKind: 'IB 内部虚拟额度',
  walletReserved: '其中已被预留',
  walletAbsent: '这个角色还没有额度账户',
  walletAbsentBody: '额度账户由「设置」里的初始额度建立，一次就好。',
  walletAbsentGo: '去设置',

  budgetTitle: '预算',
  budgetAbsent: '还没有为这个角色设过预算',
  budgetAbsentBody: '没有预算政策时，等待决定的请求仍然会问你，但"一天最多花多少"这类规则不存在。',
  budgetGo: '去设置',
  usageToday: '今日已用',

  purchasesTitle: '最近购买',
  purchasesEmpty: '还没有购买记录',
  purchasesEmptyBody: 'Agent 申请并被允许的购买会出现在这里。',
  historyNotInitiator: '这次没有可核对的发起记录',

  storesTitle: '商店',
  storesEmpty: '现在还没有开着的商店',
  storesEmptyBody: '商店由这一域的目录层维护；这里只显示已经存在的货架。',
  storeProductCount: '件商品',
  storeProductCountUnknown: '商品',
  storeNoDescription: '这个货架还没有写说明',
  storePick: '只看这家',
  storePickClear: '看全部',

  productsTitle: '商品',
  productsEmpty: '这个货架还没有商品',
  productsEmptyBody: '目录建立之后，商品会出现在这里。',
  productsNoStoreFilter: '全部',
  productsRequestNote: 'Agent 可以在 Economy 规则允许时申请这里的商品。能不能申请、要不要先问你，由规则与预算决定 —— 这一页只显示货架。',
  productUnitGrant: '每份发放',
  productUnitService: '一次执行',
  productGone: '已经不存在的商品',

  assetsTitle: '我的资产',
  assetsEmpty: '还没有任何资产',
  assetsEmptyBody: '被允许的购买会在这里留下属于这个角色的东西。',
  assetsComputeNote: 'IB 内部的算力额度（Compute Entitlement），不是任何外部服务的余额或额度。',
  assetsServiceNote: '服务类商品不会留下库存：它是一次执行。',
  assetsItemNone: '还没有物品',
  assetsComputeNone: '还没有算力额度',
  assetsChangedAt: '最近变化',

  technical: '技术说明',
  canonicalCodes: 'canonical 状态词',
  readPaths: '本页读到的只读面',
  notPersonalized: '目录不是个性化的：读面自己说 personalized = false、没有推荐、没有排序分数。'
});

/* ══ 确定性视觉身份（§4）═══════════════════════════════════════════
   ★ 输入**只有** productId。函数签名只有一个位置参数 —— 因此
     buyerId / 关系 / 亲和度在**结构上**进不来（测试断言 arity === 1）。
   ★ 输出只喂给 CSS 变量与一个 data 属性：颜色族、渐变角度、线稿编号。
     它不进价格、不进排序、不进推荐、不进"能不能买"。
   ★ 哈希用 FNV-1a 32 位：确定性、无依赖、同一 productId 永远同一张脸。 */
var VISUAL_VARIANTS = 6;
var VISUAL_ANGLES = Object.freeze([0, 45, 90, 135]);
var VISUAL_MARKS = 5;

function hashProductId(productId) {
  var s = productId == null ? '' : String(productId);
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    /* × 16777619，用移位相加写，避免 32 位乘法在旧引擎上的精度问题。 */
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function visualIdentityOf(productId) {
  var h = hashProductId(productId);
  return {
    variant: h % VISUAL_VARIANTS,
    angle: VISUAL_ANGLES[h % VISUAL_ANGLES.length],
    mark: h % VISUAL_MARKS
  };
}

/* ══ 小额格式化：**复用** P22-16 纯层那一份 ═════════════════════════ */
function moneyText(minor, currency) {
  if (!CFG) return null;
  var c = currency == null ? 'IB_CREDIT' : String(currency);
  return CFG.amountText(minor, c);
}
function currencyFace(currency) {
  if (!CFG) return null;
  return CFG.currencyLabel(currency == null ? 'IB_CREDIT' : String(currency));
}
/* 千分位只作用于整数部分，且**只用于展示**：canonical 的十进制字符串
   仍然是权威。没有它，五位数的额度要靠数位数才读得出来。 */
function groupDigits(text) {
  if (text == null) return null;
  var s = String(text);
  var dot = s.indexOf('.');
  var head = dot < 0 ? s : s.slice(0, dot);
  var tail = dot < 0 ? '' : s.slice(dot);
  var out = '';
  for (var i = 0; i < head.length; i += 1) {
    var fromEnd = head.length - i;
    if (i > 0 && fromEnd % 3 === 0) out += ',';
    out += head.charAt(i);
  }
  return out + tail;
}
function groupedMoney(minor, currency) {
  return groupDigits(moneyText(minor, currency));
}
/* 只要数字（带千分位），**不带**币种名：页面上币种是另一格（`.esh-unit`），
   而"12,450.00"与"IB Credit"分开之后，数字那一格才能用等宽对齐。 */
function groupedNumber(minor, currency) {
  if (!CFG) return null;
  var a = CFG.formatMinor(minor, currency == null ? 'IB_CREDIT' : String(currency));
  return a == null ? null : groupDigits(a);
}

/* ══ 时间：只有一个来源（canonical 的毫秒），只做本地化排版 ═════════ */
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function timeText(atMs) {
  var n = Number(atMs);
  if (!Number.isFinite(n) || n <= 0) return null;
  var d = new Date(n);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ══ 通用读取形状 ═══════════════════════════════════════════════════
   读面的三种形状必须分开，因为它们对用户的含义不同：
     · 读到了（ok === true）
     · 读不到（ok !== true）—— 可能是 404（"没有"）也可能是不可达
   ★ 刻意不把失败折成空数组：一个空的商店列表与一个没读到的商店列表
     在页面上是两句话，混起来就是一次静默的假信息。 */
function isOk(res) { return !!(res && res.ok === true); }
function listOf(res, key) {
  if (!isOk(res)) return null;
  var v = res[key];
  return Array.isArray(v) ? v : null;
}
function failureOf(res) {
  if (isOk(res)) return null;
  var e = res && res.error;
  return e == null ? 'unreadable' : String(e);
}

/* ══ ① 概览 · 钱包（§3）═══════════════════════════════════════════
   ★ 三态是**三句话**，不是一个 0：
       COLD / DEGRADED → primary 是 null，页面不显示数字。
     这是 P22-0 R5 的根因所在（把"不知道"折成 0），因此这一层用
     "primary === null" 让那种折叠在类型上不可能。 */
function buildWalletModel(res, options) {
  options = options || {};
  var out = {
    read: isOk(res),
    error: failureOf(res),
    present: false,
    known: false,
    state: null,
    currency: null,
    currencyFace: null,
    primary: null,
    kind: COPY.walletKind,
    reserved: null,
    reservedLabel: COPY.walletReserved,
    /* 钱包不存在（而不是"读不到"）：页面上要说的是"去设置里建一个"。 */
    absent: false,
    note: null
  };
  if (!out.read) {
    out.note = options.ownerId ? COPY.walletAbsent : COPY.ownerEmpty;
    out.absent = true;
    return out;
  }
  var w = res.wallet;
  if (!w || typeof w !== 'object' || w.walletId == null) {
    out.note = COPY.walletAbsent;
    out.absent = true;
    return out;
  }
  out.present = true;
  out.state = w.state == null ? null : String(w.state);
  out.currency = w.currency == null ? null : String(w.currency);
  out.currencyFace = currencyFace(out.currency);
  var ready = out.state === 'READY' && w.balanceKnown === true;
  if (!ready) {
    out.note = WALLET_STATE_FACE[out.state] || WALLET_STATE_FACE.DEGRADED;
    return out;
  }
  out.known = true;
  /* ★ 主数字只是数字：币种名由渲染器放在相邻的一格里（`.esh-unit`），
     于是"等宽数字 + 小字单位"是排版事实，而不是靠字符串拼出来。 */
  out.primary = groupedNumber(w.availableBalanceMinor, out.currency);
  var reservedMinor = Number(w.reservedBalanceMinor);
  /* 预留只在真的 > 0 时出现，而且**不**从可用里扣过再显示 ——
     available 是权威算好的那一个数，这里只补一行"其中多少被预留"。 */
  out.reserved = (Number.isFinite(reservedMinor) && reservedMinor > 0)
    ? groupedNumber(w.reservedBalanceMinor, out.currency) : null;
  return out;
}

/* ══ ② 概览 · 预算摘要（§2/§3）════════════════════════════════════
   ★ limits 的**每一个**数字都来自 canonical 政策；usage 的**每一个**
     数字都来自 canonical 的预算快照（spentTodayMinor 是权威自己算出来的
     当日累计 —— 本层**不**从 ledger 重算任何东西，§8）。
   ★ decision 一个字段都不进模型：那是一次裁决，不是这一页要显示的事实。 */
var BUDGET_ROWS = Object.freeze([
  Object.freeze({ key: 'perTransactionMinor', label: '单次最多可花' }),
  Object.freeze({ key: 'dailyMinor', label: '每日最多可花' }),
  Object.freeze({ key: 'approvalThresholdMinor', label: '超过多少先问我' }),
  Object.freeze({ key: 'weeklyMinor', label: '每周最多可花' }),
  Object.freeze({ key: 'monthlyMinor', label: '每月最多可花' })
]);

function buildBudgetModel(policyRes, snapshotRes, options) {
  options = options || {};
  var out = {
    read: isOk(policyRes),
    error: failureOf(policyRes),
    present: false,
    currency: null,
    rows: [],
    usage: [],
    note: null
  };
  if (out.read && policyRes.policy && typeof policyRes.policy === 'object' &&
    policyRes.policy.policyId != null) {
    var p = policyRes.policy;
    out.present = true;
    out.currency = p.currency == null ? null : String(p.currency);
    var limits = (p.limits && typeof p.limits === 'object') ? p.limits : {};
    for (var i = 0; i < BUDGET_ROWS.length; i += 1) {
      var spec = BUDGET_ROWS[i];
      var v = limits[spec.key];
      if (v == null) continue;              /* 没设的那一档不出现 */
      var text = moneyText(v, out.currency);
      if (text == null) continue;
      out.rows.push({ key: spec.key, label: spec.label, value: groupedNumber(v, out.currency), text: text });
    }
    if (p.hardStop === true) out.note = '这个角色的预算现在是停住的。';
  } else {
    out.note = COPY.budgetAbsent;
  }
  /* 用量：只有权威的快照里真的有 spentTodayMinor 才显示。 */
  var snap = isOk(snapshotRes) ? snapshotRes.snapshot : null;
  if (snap && typeof snap === 'object' && snap.spentTodayMinor != null) {
    var cur = snap.currency == null ? out.currency : String(snap.currency);
    var today = moneyText(snap.spentTodayMinor, cur);
    if (today != null) {
      out.usage.push({
        key: 'spentTodayMinor',
        label: COPY.usageToday,
        value: groupedNumber(snap.spentTodayMinor, cur),
        text: today
      });
    }
  }
  return out;
}

/* ══ ③ 商店与商品目录（§4）════════════════════════════════════════
   ★ 顺序就是读面给的顺序（canonical 按 sortOrder / created_at 排）。
     本层**没有** sort()，也不按 visualIdentityOf 排 —— 后者只画出脸。
   ★ 商品数量是从 canonical 商品列表里**数**出来的，而且窗口被截断时
     退回 null（不显示数字），而不是显示一个看起来精确的错数。 */
function buildStoreModel(storesRes, productsRes) {
  var stores = listOf(storesRes, 'stores');
  var products = listOf(productsRes, 'products');
  var saturated = !!(products && products.length >= LIMITS.PRODUCTS);
  var countsExact = !!products && !saturated;
  var counts = Object.create(null);
  if (products) {
    for (var i = 0; i < products.length; i += 1) {
      var sid = products[i] && products[i].storeId;
      if (sid == null) continue;
      var k = String(sid);
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return {
    read: stores != null,
    error: failureOf(storesRes),
    countsExact: countsExact,
    holdsPrices: !!(storesRes && storesRes.holdsPrices === false),
    holdsOwnership: !!(storesRes && storesRes.holdsOwnership === false),
    rows: (stores || []).map(function (s) {
      var id = s && s.storeId != null ? String(s.storeId) : null;
      var count = (id != null && countsExact) ? (counts[id] || 0) : null;
      return {
        storeId: id,
        name: (s && s.name != null && String(s.name) !== '') ? String(s.name) : COPY.storeNoDescription,
        description: (s && s.description != null) ? String(s.description) : '',
        status: (s && s.status != null) ? String(s.status) : null,
        statusFace: STORE_STATUS_FACE[(s && s.status != null) ? String(s.status) : ''] || '状态未知',
        productCount: count,
        productCountText: count == null ? null : (count + ' ' + COPY.storeProductCount)
      };
    }),
    empty: stores != null && stores.length === 0
  };
}

function unitLineOf(product) {
  var fulfillment = product && product.fulfillment != null ? String(product.fulfillment) : null;
  var qty = product && product.grantQuantity != null ? Number(product.grantQuantity) : null;
  if (fulfillment === 'SERVICE_EXECUTION') return COPY.productUnitService;
  var unit = product && product.unitName != null ? UNIT_FACE[String(product.unitName)] : null;
  if (unit == null) return null;             /* 未知单位 ⇒ 不编一个出来 */
  var n = Number.isFinite(qty) && qty > 0 ? qty : null;
  return COPY.productUnitGrant + ' ' + (n == null ? '' : (n + ' ')) + unit;
}

function buildProductModel(productsRes, options) {
  options = options || {};
  var products = listOf(productsRes, 'products');
  var rows = (products || []).map(function (p) {
    var pid = p && p.productId != null ? String(p.productId) : '';
    var status = (p && p.status != null) ? String(p.status) : null;
    return {
      productId: pid,
      storeId: (p && p.storeId != null) ? String(p.storeId) : null,
      name: (p && p.name != null && String(p.name) !== '') ? String(p.name) : COPY.productGone,
      description: (p && p.description != null) ? String(p.description) : '',
      kind: (p && p.kind != null) ? String(p.kind) : null,
      /* 类别与交付方式的中文来自 P22-16 纯层那一份镜像。 */
      kindFace: (CFG && p && p.kind != null) ? (CFG.PRODUCT_KIND_LABEL[String(p.kind)] || null) : null,
      fulfillmentFace: (CFG && p && p.fulfillment != null) ? (CFG.FULFILLMENT_LABEL[String(p.fulfillment)] || null) : null,
      unitLine: unitLineOf(p),
      priceText: groupedMoney(p && p.unitPriceMinor, p && p.currency),
      currency: (p && p.currency != null) ? String(p.currency) : null,
      status: status,
      statusFace: PRODUCT_STATUS_FACE[status] || '状态未知',
      requestable: status === 'ACTIVE',
      identity: visualIdentityOf(pid)
    };
  });
  return {
    read: products != null,
    error: failureOf(productsRes),
    rows: rows,
    count: rows.length,
    saturated: !!(products && products.length >= LIMITS.PRODUCTS),
    notPersonalized: !!(productsRes && productsRes.personalized === false &&
      productsRes.hasRecommendations === false),
    empty: products != null && rows.length === 0
  };
}

/* ══ ④ 我的资产（§6）═══════════════════════════════════════════════
   ★ 分组用的是 canonical 自己的 assetKind（只有 ITEM 与 COMPUTE）。
     SERVICE 的 assetKind 是 **null**（交付形态是执行，不是持有）——
     因此这里**不**伪造"服务库存"，只写一句它为什么不在这里。
   ★ 名字能 join 就 join：inventory 行只带 productId，而 canonical 的
     `productPresent` 恰好告诉我们那件商品还在不在。 */
function buildAssetsModel(inventoryRes, productsRes, options) {
  options = options || {};
  var entries = listOf(inventoryRes, 'entries');
  var products = listOf(productsRes, 'products');
  var names = Object.create(null);
  if (products) {
    for (var i = 0; i < products.length; i += 1) {
      var p = products[i];
      if (!p || p.productId == null) continue;
      var key = String(p.productId);
      names[key] = {
        name: (p.name != null && String(p.name) !== '') ? String(p.name) : null,
        unitName: p.unitName == null ? null : String(p.unitName)
      };
    }
  }
  var buckets = Object.create(null);
  var order = [];
  var rows = (entries || []).map(function (e) {
    var pid = (e && e.productId != null) ? String(e.productId) : '';
    var joined = names[pid] || null;
    var kind = (e && e.assetKind != null) ? String(e.assetKind) : null;
    var unitName = joined && joined.unitName != null ? joined.unitName : null;
    var qty = (e && e.quantity != null) ? Number(e.quantity) : null;
    var unit = unitName == null ? null : UNIT_FACE[unitName];
    return {
      inventoryEntryId: (e && e.inventoryEntryId != null) ? String(e.inventoryEntryId) : null,
      productId: pid,
      assetKind: kind,
      /* 名字能 join 就 join；join 不上、或 canonical 说这行商品已经不在了，
         都用同一句"已经不存在的商品"，而**不**把 productId 摆到脸上。 */
      name: (joined && joined.name) ? joined.name : COPY.productGone,
      productPresent: !!(e && e.productPresent === true),
      quantity: Number.isFinite(qty) ? qty : null,
      unit: unit,
      quantityText: (Number.isFinite(qty) ? String(qty) : '—') + (unit == null ? '' : (' ' + unit)),
      updatedAt: (e && e.updatedAt != null) ? Number(e.updatedAt) : null,
      changedText: timeText(e && e.updatedAt),
      isABalance: !!(e && e.isABalance === true)
    };
  });
  /* 分组顺序与 canonical 的 ASSET_KINDS 一致（ITEM 先）。 */
  var KIND_ORDER = ['ITEM', 'COMPUTE'];
  for (var k = 0; k < KIND_ORDER.length; k += 1) {
    var kindKey = KIND_ORDER[k];
    var bucket = rows.filter(function (r) { return r.assetKind === kindKey; });
    /* 最近变化在最上面：更新的时间戳排前面。**只**按 canonical 的时间排。 */
    bucket.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    buckets[kindKey] = bucket;
    order.push(kindKey);
  }
  var unknown = rows.filter(function (r) { return KIND_ORDER.indexOf(r.assetKind) < 0; });
  return {
    read: entries != null,
    error: failureOf(inventoryRes),
    kinds: order,
    groups: order.map(function (kindKey) {
      return {
        assetKind: kindKey,
        face: ASSET_KIND_FACE[kindKey] || kindKey,
        note: kindKey === 'COMPUTE' ? COPY.assetsComputeNote : null,
        emptyText: kindKey === 'COMPUTE' ? COPY.assetsComputeNone : COPY.assetsItemNone,
        rows: buckets[kindKey],
        empty: buckets[kindKey].length === 0
      };
    }),
    unknownRows: unknown,
    serviceNote: COPY.assetsServiceNote,
    isNotABalance: !!(inventoryRes && inventoryRes.isABalance === false),
    empty: entries != null && rows.length === 0,
    total: rows.length
  };
}

/* ══ ⑤ 购买历史（§7）═══════════════════════════════════════════════
   ★ 状态词来自 canonical 的 PURCHASE_STATE，**不**把 RESERVED 这类代号
     裸扔给用户；代号只进折叠的技术层。
   ★ "由谁发起"是**连出来的**，不是编出来的：
       canonical 的 Purchase 行上**没有**发起者字段，
       但 GET /economy/intents 的每条 intent 带 agentId 与 purchaseId ——
       于是"这次购买对应哪条 intent、那条 intent 是哪个 Agent 提的"有一个
       可核对的答案。连不上时**什么都不说**（绝不写一个猜的发起者）。
   ★ 同理，`approvalMode === null` 逐字表示"这条记录早于授权层"，
     而不是 AUTO_ALLOW —— 这句话也必须能被读出来。 */
function buildPurchaseModel(purchasesRes, productsRes, intentsRes, options) {
  options = options || {};
  var purchases = listOf(purchasesRes, 'purchases');
  var products = listOf(productsRes, 'products');
  var intents = listOf(intentsRes, 'intents');
  var names = Object.create(null);
  if (products) {
    for (var i = 0; i < products.length; i += 1) {
      var p = products[i];
      if (p && p.productId != null && p.name != null) names[String(p.productId)] = String(p.name);
    }
  }
  /* purchaseId → agentId：只在 intent 真的带这两个字段且 purchaseId 命中时建立。 */
  var byPurchase = Object.create(null);
  if (intents) {
    for (var j = 0; j < intents.length; j += 1) {
      var it = intents[j];
      if (!it || it.purchaseId == null || it.agentId == null) continue;
      byPurchase[String(it.purchaseId)] = String(it.agentId);
    }
  }
  var owners = (CFG && typeof CFG.ownerOptions === 'function')
    ? CFG.ownerOptions(options.apiConfigs || [], options.archivedConfigs || []) : [];
  var labelOf = Object.create(null);
  for (var m = 0; m < owners.length; m += 1) labelOf[String(owners[m].id)] = owners[m].label;

  var rows = (purchases || []).map(function (pu) {
    var pid = (pu && pu.productId != null) ? String(pu.productId) : '';
    var status = (pu && pu.status != null) ? String(pu.status) : null;
    var mode = (pu && pu.approvalMode != null) ? String(pu.approvalMode) : null;
    var agentId = (pu && pu.purchaseId != null) ? (byPurchase[String(pu.purchaseId)] || null) : null;
    return {
      purchaseId: (pu && pu.purchaseId != null) ? String(pu.purchaseId) : null,
      productId: pid,
      name: names[pid] || COPY.productGone,
      productKnown: Object.prototype.hasOwnProperty.call(names, pid),
      amountText: groupedMoney(pu && pu.amountMinor, pu && pu.currency),
      currency: (pu && pu.currency != null) ? String(pu.currency) : null,
      status: status,
      statusFace: PURCHASE_STATE_FACE[status] || '状态未知',
      terminal: !!(pu && pu.terminal === true),
      completed: !!(pu && pu.completed === true),
      at: (pu && pu.createdAt != null) ? Number(pu.createdAt) : null,
      atText: timeText(pu && pu.createdAt),
      doneText: timeText(pu && pu.completedAt),
      mode: mode,
      authText: mode == null ? '这条记录早于授权层' : (AUTH_MODE_FACE[mode] || null),
      /* 只有 join 成功**且**角色名认得出来时才写发起者。 */
      agentId: agentId,
      agentLabel: agentId == null ? null : (labelOf[agentId] || null),
      units: (pu && pu.units != null) ? Number(pu.units) : null,
      grantedQuantity: (pu && pu.grantedQuantity != null) ? Number(pu.grantedQuantity) : null,
      unitFace: (pu && pu.unitName != null) ? (UNIT_FACE[String(pu.unitName)] || null) : null
    };
  });
  var saturated = !!(purchases && purchases.length >= LIMITS.PURCHASES);
  return {
    read: purchases != null,
    error: failureOf(purchasesRes),
    rows: rows,
    count: rows.length,
    saturated: saturated,
    /* 读面自己的三句否认：这个列表不是个性化的、没有推荐、没有排序分数。 */
    notPersonalized: !!(purchasesRes && purchasesRes.personalized === false &&
      purchasesRes.recommended === false && purchasesRes.ranked === false &&
      purchasesRes.exposesMutation === false),
    empty: purchases != null && rows.length === 0
  };
}

/* ══ ⑥ 组装整页模型 ═══════════════════════════════════════════════
   一个纯函数把六份读面结果拼成三个面板要用的东西。渲染器因此不需要
   认识任何 canonical 字段名。 */
function buildPageView(sources) {
  sources = sources || {};
  return {
    owner: sources.owner || null,
    wallet: buildWalletModel(sources.wallet, { ownerId: sources.owner }),
    budget: buildBudgetModel(sources.policy, sources.budgetSnapshot, { ownerId: sources.owner }),
    purchases: buildPurchaseModel(sources.purchases, sources.products, sources.intents, sources),
    stores: buildStoreModel(sources.stores, sources.products),
    products: buildProductModel(sources.products, {}),
    assets: buildAssetsModel(sources.inventory, sources.products, { ownerId: sources.owner })
  };
}

/* ══ 角色目录（复用 P22-16 纯层的解析，不建第二套）══════════════════ */
function ownerOptionsOf(activeConfigs, archivedConfigs) {
  if (!CFG || typeof CFG.ownerOptions !== 'function') return [];
  return CFG.ownerOptions(activeConfigs || [], archivedConfigs || []);
}
function resolveOwnerOf(options, preferredId) {
  if (!CFG || typeof CFG.resolveOwner !== 'function') return null;
  return CFG.resolveOwner(options || [], preferredId);
}

/* ══ 读不到时的**一句人话** ════════════════════════════════════════
   读面失败在页面上的三种落点：整页不可用 / 某一格空 / 某一格说读不到。
   本函数只提供措辞，判定仍在各个模型里。 */
function readFailureText(code) {
  var c = code == null ? '' : String(code);
  if (c === 'transport-not-available') return COPY.readFailed;
  if (c === 'home-node-unreachable' || c === 'home-node-transport-error') return COPY.readFailed;
  return COPY.readFailed;
}

/* ══ 读数：这一页读到的**全是**既有只读面（给技术层用）══════════════ */
function readPathList() {
  return [READS.WALLET, READS.POLICY, READS.BUDGET, READS.STORES, READS.PRODUCTS,
    READS.INVENTORY, READS.PURCHASES, READS.INTENTS];
}

NS.economyShellCore = Object.freeze({
  version: CORE_VERSION,
  ID: ID,
  TAB: TAB,
  TABS: TABS,
  TAB_KEYS: TAB_KEYS,
  isTabKey: isTabKey,
  READS: READS,
  LIMITS: LIMITS,
  COPY: COPY,

  STORE_STATUS_FACE: STORE_STATUS_FACE,
  PRODUCT_STATUS_FACE: PRODUCT_STATUS_FACE,
  PURCHASE_STATE_FACE: PURCHASE_STATE_FACE,
  ASSET_KIND_FACE: ASSET_KIND_FACE,
  AUTH_MODE_FACE: AUTH_MODE_FACE,
  WALLET_STATE_FACE: WALLET_STATE_FACE,
  UNIT_FACE: UNIT_FACE,
  BUDGET_ROWS: BUDGET_ROWS,
  BUDGET_ROW_KEYS: Object.freeze(BUDGET_ROWS.map(function (r) { return r.key; })),

  VISUAL_VARIANTS: VISUAL_VARIANTS,
  VISUAL_ANGLES: VISUAL_ANGLES,
  VISUAL_MARKS: VISUAL_MARKS,
  hashProductId: hashProductId,
  visualIdentityOf: visualIdentityOf,

  moneyText: moneyText,
  groupedMoney: groupedMoney,
  groupedNumber: groupedNumber,
  groupDigits: groupDigits,
  currencyFace: currencyFace,
  timeText: timeText,

  ownerOptionsOf: ownerOptionsOf,
  resolveOwnerOf: resolveOwnerOf,
  readFailureText: readFailureText,
  readPathList: readPathList,

  buildWalletModel: buildWalletModel,
  buildBudgetModel: buildBudgetModel,
  buildStoreModel: buildStoreModel,
  buildProductModel: buildProductModel,
  buildAssetsModel: buildAssetsModel,
  buildPurchaseModel: buildPurchaseModel,
  buildPageView: buildPageView,

  /* 依赖自述：币种 / 类别 / 角色目录三张镜像表的**唯一**出处是 P22-16 纯层。
     false 时整页显示一句诚实的失败，而不是显示 canonical 代号。 */
  dependencies: Object.freeze({
    configurationCore: !!CFG,
    version: CFG ? CFG.version : null
  })
});
})(typeof window !== 'undefined'
  ? (window.IB || (window.IB = {}))
  : (typeof globalThis !== 'undefined' ? (globalThis.IB || (globalThis.IB = {})) : {}));
