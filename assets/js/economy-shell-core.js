/* ====================================================================
   IB · Economy Shell — 纯层（P22-17 · P22-18 追加解释层）
   --------------------------------------------------------------------
   P22-18 只在这一个文件里**追加**解释层，而不改 P22-17 的任何一条判定：
   把 canonical 的 change log（`/economy/changes`）译成一条时间线，
   把 intent + approval + purchase 按 canonical 自己的键连成"经济活动"，
   并把 Agent 的 reason **原样**摆出来。新增的每一样都是"搬运 / 连接 /
   排版"，没有一样是新的经济事实（见 docs/P22-18 的 §1 审计）。

   这一层回答的是"从既有只读面读回来的 JSON 长成什么样子"，而它
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

var CORE_VERSION = 'p22-18-1';

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
/* ── P22-22 · 每一格的两句话（标题 + 一句"这一格看什么"）───────────────
   ★ 它们是**只读的解释**，不是新的状态：值全部由上面那三张既有模型算出来，
     一个字段都没有新增、一条读面都没有多读。放在这里而不是写在渲染器里，
     是因为下面那段 COPY 才是这一层唯一的文案出处。
   ★ `title` 逐个与页签**同一批词**（概览/商店/我的资产/待处理/设置），
     因此"点了哪个页签"与"下面这一块的标题"永远对得上 —— 这是可访问性
     要求，也是"用户在哪儿"的唯一答案。 */
var SECTION_COPY = Object.freeze({
  overview: Object.freeze({
    title: '概览',
    sub: '这位角色现在有多少额度，以及它是怎么变成这样的。'
  }),
  store: Object.freeze({
    title: '商店',
    sub: '这个域里现有的货架与商品目录 —— 能不能买由规则、预算与批准各自回答。'
  }),
  assets: Object.freeze({
    title: '我的资产',
    sub: '这位角色已经拿到的东西：物品与算力额度。'
  }),
  requests: Object.freeze({
    title: '待处理',
    sub: '在等你决定的购买请求。'
  }),
  settings: Object.freeze({
    title: '设置',
    sub: '钱包与初始额度、预算限制、自主购买 —— 这三块决定这位角色能动用多少。'
  })
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
/* 未知键**不编一句**：回退到"概览"那一组，而不是留一个空标题
   （页签与标题不一致是这一格最容易被忽略的失效方式）。 */
function sectionCopyOf(key) {
  var hit = SECTION_COPY[String(key)];
  return hit || SECTION_COPY.overview;
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

/* ══ P22-18 · 第九条只读面：canonical change log ═════════════════════
   ★ 为什么它**不在** `READS` 里：P22-17 的 A4 逐字钉住"八条读面"，那是
     P22-17 那一阶段的冻结事实。本阶段要的东西多一条，于是把它**另立**为
     `CHANGE_READ` —— 两个集合各自可被读出，而不是把 8 偷偷改成 9 让上一
     阶段的断言换一个含义。`readPathList()` 仍是 P22-17 的那八条。
   ★ 为什么用 change log 而不是自己从三张表拼：§2 逐字要求"如果已有
     change log：复用"。它**已经有**（P22-1 起就存在，`/economy/changes`
     是 P22-1 就交付的只读面），而且它比拼接强：它同时装着"锁了一笔额度"
     "报价失效""账本记了一笔"这些**没有自己一张表**的事件。自己拼会把这些
     全部丢掉，于是"为什么这里多了一笔变化"就答不上来。
   ★ 它**不是**新的事件系统：本阶段一条新路由都没有，也没有新表。 */
var CHANGE_READ = '/economy/changes';
/* 窗口与 canonical 自己的上限（`listChanges` 把 limit 夹在 1..500）一致。
   截断时时间线**说**它被截断了，而不是把 200 条当成全部历史。 */
var CHANGE_LIMIT = 200;
/* 时间线在页面上最多显示多少条：§2 要的是"最近发生了什么"。 */
var TIMELINE_KEEP = 24;
/* 「经济活动」在概览上最多铺几条：明细是有上限的（不是无底洞），
   剩下多少条会**说出来**，而完整的历史在时间线里。 */
var ACTIVITY_KEEP = 6;

/* ══ 时间线的"语气"（§8）═══════════════════════════════════════════
   ★ 它不是状态、不是判定，只决定那个圆点长什么样、那一行左边有没有
     竖线。七个成员是封闭集合 —— 于是"这一条该画成什么"没有第四种答案。 */
var TONE = Object.freeze({
  MONEY: 'money',       /* 钱真的动了 */
  HOLD: 'hold',         /* 钱被锁住 / 放回，但账本没动 */
  ASK: 'ask',           /* 在等一个决定 */
  DECISION: 'decision', /* 有一个决定了 */
  ASSET: 'asset',       /* 持有物变了 */
  RULE: 'rule',         /* 规则变了 */
  FAIL: 'fail',         /* 没有成立 */
  NOTE: 'note'          /* 记账系统自身的维护事实 */
});

/* ══ canonical 事件类型 → 一句人话（§2）════════════════════════════
   ★ 键逐字来自契约的 `EVENT_TYPE`（封闭集合，54 个）加上 store 里三处
     写成字面量的事件（BALANCE_REBUILT / ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED
     / <TX_TYPE>_COMMITTED）。本表**覆盖全部**能够被写进 change log 的 kind：
     P22-18 的测试从契约与 store 的源码里把 kind 名单**抽出来**，然后逐个
     断言这里有答案 —— 于是"某个 kind 在页面上没有话"这件事会当场变红，
     而不是悄悄退化成一句"未知变化"。
   ★ 值为对象 `{ face, tone }`：face 是人话，tone 只喂样式。
   ★ 这一层**不解释**一个事件"意味着什么后果"（那要读经济事实），只说明
     "发生了什么"。这就是解释层与权威层的分界。 */
var CHANGE_KIND_FACE = Object.freeze({
  WALLET_OPENED: { face: '额度账户建立', tone: TONE.NOTE },
  TRANSACTION_CREATED: { face: '账本上开了一笔', tone: TONE.NOTE },

  RESERVATION_CREATED: { face: '先为你锁住一笔额度', tone: TONE.HOLD },
  RESERVATION_RELEASED: { face: '锁住的额度放回去了', tone: TONE.HOLD },
  RESERVATION_EXPIRED: { face: '锁住的额度自己过期了', tone: TONE.HOLD },
  RESERVATION_COMMITTED: { face: '锁住的额度用掉了', tone: TONE.MONEY },
  RESERVATION_REBUILT: { face: '已锁额度按账本重算了一次', tone: TONE.NOTE },
  OPERATION_FAILED: { face: '一次操作没有成立', tone: TONE.FAIL },

  BUDGET_POLICY_CREATED: { face: '预算规则建立', tone: TONE.RULE },
  BUDGET_POLICY_UPDATED: { face: '预算规则被改过', tone: TONE.RULE },
  BUDGET_POLICY_DISABLED: { face: '预算规则被停用', tone: TONE.RULE },
  BUDGET_POLICY_EXPIRED: { face: '预算规则到期', tone: TONE.RULE },

  QUOTE_CREATED: { face: '生成了一次报价', tone: TONE.ASK },
  QUOTE_EXPIRED: { face: '报价失效', tone: TONE.FAIL },
  QUOTE_CONSUMED: { face: '报价被用掉了', tone: TONE.MONEY },
  QUOTE_CANCELLED: { face: '报价被作废', tone: TONE.NOTE },

  PURCHASE_CREATED: { face: '开始准备这次购买', tone: TONE.ASK },
  PURCHASE_RESERVED: { face: '为这次购买锁住额度', tone: TONE.HOLD },
  PURCHASE_COMPLETED: { face: '购买完成', tone: TONE.MONEY },
  PURCHASE_RELEASED: { face: '这次购买退回去了，额度放回', tone: TONE.HOLD },
  PURCHASE_FAILED: { face: '这次购买没有完成', tone: TONE.FAIL },
  PURCHASE_DENIED: { face: '这次购买被拒绝', tone: TONE.FAIL },
  PURCHASE_COMMITTED: { face: '这笔购买记进了账本', tone: TONE.MONEY },
  PURCHASE_AUTHORIZED: { face: '这次购买拿到了授权', tone: TONE.DECISION },

  AUTONOMY_POLICY_CREATED: { face: '自主规则建立', tone: TONE.RULE },
  AUTONOMY_POLICY_UPDATED: { face: '自主规则被改过', tone: TONE.RULE },
  AUTONOMY_PURCHASE_AUTO_ALLOWED: { face: '按自主规则直接放行', tone: TONE.DECISION },
  AUTONOMY_PURCHASE_REQUIRES_APPROVAL: { face: '自主规则要求先问你', tone: TONE.ASK },

  APPROVAL_REQUESTED: { face: '有一个决定在等你', tone: TONE.ASK },
  APPROVAL_APPROVED: { face: '你允许继续', tone: TONE.DECISION },
  APPROVAL_REJECTED: { face: '你拒绝了', tone: TONE.DECISION },
  APPROVAL_EXPIRED: { face: '这个决定过期了', tone: TONE.FAIL },
  APPROVAL_CONSUMED: { face: '这份许可被这次购买用掉了', tone: TONE.DECISION },

  AGENT_INTENT_PROPOSED: { face: 'Agent 提出购买请求', tone: TONE.ASK },
  AGENT_INTENT_AWAITING_APPROVAL: { face: 'Agent 的请求在等你', tone: TONE.ASK },
  AGENT_INTENT_DETERMINED: { face: 'Agent 的请求有结果了', tone: TONE.DECISION },

  ITEM_GIFTED: { face: '物品送出', tone: TONE.ASSET },
  ITEM_CONSUMED: { face: '物品被用掉', tone: TONE.ASSET },
  COMPUTE_CREDIT_GRANTED: { face: '算力额度到账', tone: TONE.ASSET },
  COMPUTE_CREDIT_CONSUMED: { face: '算力额度被用掉', tone: TONE.ASSET },
  INVENTORY_GRANTED: { face: '资产到账', tone: TONE.ASSET },
  INVENTORY_CONSUMED: { face: '资产被用掉', tone: TONE.ASSET },

  STORE_CREATED: { face: '货架建立', tone: TONE.RULE },
  STORE_UPDATED: { face: '货架被改过', tone: TONE.RULE },
  PRODUCT_CREATED: { face: '商品上架', tone: TONE.RULE },
  PRODUCT_UPDATED: { face: '商品被改过', tone: TONE.RULE },
  PRODUCT_DISABLED: { face: '商品暂停提供', tone: TONE.RULE },
  PRODUCT_RETIRED: { face: '商品下架', tone: TONE.RULE },

  ECONOMY_CAPABILITY_DECIDED: { face: '一次准入判定被记下', tone: TONE.NOTE },

  /* ── 三处**不在**契约封闭集合里、但 store 真的会写的事件 ─────────── */
  BALANCE_REBUILT: { face: '余额按账本重算了一次', tone: TONE.NOTE },
  ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED: { face: '初始额度已设置', tone: TONE.NOTE }
});
var CHANGE_KIND_KEYS = Object.freeze(Object.keys(CHANGE_KIND_FACE));

/* 动态事件族：store 会写 `String(txType) + '_COMMITTED'`（出处是它的
   commitLedgerTransaction）。★ 这一类**不逐个登记**：它们的共同含义恰好
   只有一句 —— "有一笔账本交易成交了"，而具体是哪一类属于**技术层**的内容。
   把每一种交易类型都写成一句中文，等于在这一层复述契约里那张交易类型表，
   而那张表的成员超出了本阶段要解释的范围（§11）。
   ★ 这里**只提函数名、不提文件名**：B7.13 那条边界判的是"浏览器侧的经济
   文件有没有引用后端生产模块"，而它读的是**原文**（注释也算）—— 一句出处
   引用会把它判红。这条纪律与本层的真实形状一致：那个名字在这一层只出现在
   这句注释里，一次都没有被调用。 */
function isLedgerCommitKind(kind) {
  return /_COMMITTED$/.test(kind);
}
function changeKindFace(kind) {
  var k = kind == null ? '' : String(kind);
  var hit = CHANGE_KIND_FACE[k];
  if (hit) return { face: hit.face, tone: hit.tone, known: true, kind: k };
  if (isLedgerCommitKind(k)) {
    return { face: COPY.changeLedger, tone: TONE.MONEY, known: true, kind: k };
  }
  /* 未来新增的 kind（本阶段之后的事）**不编一个解释**：说一句诚实的
     "记下了一项变化"，并由 `known:false` 让渲染器把代号放到技术层。 */
  return { face: COPY.changeUnknown, tone: TONE.NOTE, known: false, kind: k };
}

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
/* ── P22-18 · 两个新的封闭集合（§2/§4）─────────────────────────────
   ★ 键逐字来自契约：PURCHASE_INTENT_STATE（7 个）与 APPROVAL_STATE（5 个）。
     与上面那三张表同一条纪律 —— **右边只能是人话**，代号只进技术层。 */
var INTENT_STATE_FACE = Object.freeze({
  PROPOSED: '刚刚提出',
  WAITING_APPROVAL: '在等你决定',
  EXECUTING: '正在执行',
  COMPLETED: '已经完成',
  DENIED: '被拒绝了',
  EXPIRED: '已经过期',
  FAILED: '没有成功'
});
var APPROVAL_STATE_FACE = Object.freeze({
  PENDING: '还在等你',
  APPROVED: '你允许继续',
  REJECTED: '你拒绝了',
  EXPIRED: '过期了',
  CONSUMED: '已经用掉了'
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
  /* ── P22-22 · 未初始化**不是**"没有钱包" ──────────────────────────
     ★ 三句话各回答一件事，顺序就是用户读到的顺序（状态 → 原因 → 下一步）：
         walletAbsent     它现在处在哪一个系统状态（尚未完成 Initial Bootstrap）
         walletAbsentWhy  为什么会这样 / 谁创建它 / 为什么没有创建按钮
         walletAbsentGo   用户现在能做的那一件事
     ★ 刻意**不**写"这个角色还没有额度账户"：那句话读起来像一次失败或一个
       缺失的对象，而真相是这台节点还没走过一次性的初始化。也刻意**不**给
       "手工创建钱包"的按钮 —— 界面没有这条接缝（P22-14 只有 bootstrap）。 */
  walletBootstrapState: '尚未完成 Initial Bootstrap',
  walletAbsent: '尚未完成 Initial Bootstrap',
  walletAbsentWhy: '额度账户由 Economy authority 创建：走过一次初始额度发放，账户才会出现。',
  walletAbsentNoManual: '这个账户不能手动新建 —— 界面上没有「创建钱包」这一步，只有一次性发放初始额度。',
  walletAbsentOnce: '初始额度只发放一次，发放之后不能再补、不能再改。',
  walletAbsentBody: '在「设置 → 钱包与初始额度」里发放这次初始额度，只能发放一次。',
  walletAbsentGo: '去设置',
  nextStep: '下一步',

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
  notPersonalized: '目录不是个性化的：读面自己说 personalized = false、没有推荐、没有排序分数。',

  /* ── P22-18 · 解释层（§2/§3/§4/§7）───────────────────────────────
     ★ 三条硬约束逐字落在这里：
      ① Timeline 是**解释层**：它的每一行都能指回一条 canonical 记录，
         所以「为什么这里多了一笔变化」有一个可核对的答案；
      ② Agent 的理由**原样**展示 —— 这一层不做摘要、不做改写、不再调模型
         （第二份解释就是第二个权威）。`reasonVerbatim` 那几个字就是这个
         承诺在界面上的形状；
      ③ 钱的去向只写"花在什么上、多少"，不写收益率 / 增长率 / 资产价值。 */
  timelineTitle: '活动时间线',
  timelineSub: '这里按时间列出这个角色身上发生过的事，从最近一次往前。',
  timelineEmpty: '还没有任何记录',
  timelineEmptyBody: '额度、购买、Agent 的请求与你的决定一旦发生，就会出现在这里。',
  /* ★ §7 逐字：截断**不能**静默，而且这三句话互不相同 ——
     `timelineTruncated` 说的是"这里只有**最近**的一部分"（在 desc 之下
     这句话是真的：截掉的另一端是更早的），`timelineUncertain` 说的是
     "这一页不知道完不完整"。两句说成同一句，用户就没法区分"看少了"
     与"不知道看了多少"。 */
  timelineTruncated: '这里只显示最近的一部分活动，更早的记录没有读出来。',
  timelineUncertain: '这一页拿到了活动记录，但没法确定它是不是完整的。',
  timelineUnavailable: '读不到活动记录，因此这一格现在是空的。',
  recentChange: '最近变化',
  recentChangeNone: '暂无记录',
  changeLedger: '账本上记了一笔变化',
  changeUnknown: '记下了一项变化',

  activityTitle: '经济活动',
  activitySub: '每一次购买，连同它是怎么来的、走到了哪一步。',
  activityMorePrefix: '还有 ',
  /* ★ P22-19：这句话只在时间线**真的**读完整时才成立。截断时它必须换一句 ——
     否则同一页上会有两格互相矛盾的完整性声明（一格说"只有最近的一部分"，
     另一格说"更早的仍然在那一格里"），而用户无法判断哪句是真的。 */
  activityMoreSuffix: ' 次更早的购买没有铺在这里 —— 它们仍然在「活动时间线」里。',
  activityMoreSuffixPartial: ' 次更早的购买没有铺在这里；这一格与「活动时间线」读到的都是最近的一部分。',
  sourceTitle: '来源',
  stepsTitle: '时间线',
  sourceAgent: 'Agent 提议',
  sourceUser: '用户批准',
  sourceSystem: '系统完成',
  sourceUnknown: '来源还不能确定',
  sourceAuto: '按自主规则放行',
  /* ★ P22-17 的 H3 性质逐字保留：说出来的是**角色名**而不是 id。
     `{name}` 由这一层替换，而替换的值只可能来自角色目录（`apiConfigs`）。 */
  sourceAgentWho: '由 {name} 发起',
  stepIntent: 'Agent 提出请求',
  stepApproval: '等你决定',
  stepApprovalApproved: '你允许继续',
  stepApprovalRejected: '你拒绝了',
  stepPurchase: '系统完成购买',
  stepPending: '还没走到这一步',
  stepNotApplicable: '这一步没有发生',
  stepAbsent: '没有对应的记录',
  stepAutoNoRecord: '按自主规则直接放行，因此没有产生一条决定记录',
  stepBeforeAuth: '这条记录早于授权层',

  spendTitle: '支出说明',
  spendSub: '钱花到哪儿去了 —— 每一行都对应一次已完成的购买。',
  spendNone: '这个角色还没有花掉过额度。',
  spendTotal: '已完成合计',
  spendTotalNote: '这个合计是这一页把列表里的金额加起来的，只是为了让数目读得出来；权威的当日累计在「预算」那一格。',
  spendSaturated: '购买窗口已满，因此这里的合计**不是**全部历史。',
  spendUnknownAmount: '这次购买的金额读不到，因此没有计入合计。',

  whyTitle: 'Agent 为什么提出请求',
  whySub: '理由由提出请求的 Agent 写下，这里一个字节都没有改。',
  whyReasonLabel: '原因',
  whyNoReason: '这次请求没有写下原因',
  whyUnitsLabel: '数量',
  whyTargetLabel: '想要的东西',
  whyStateLabel: '现在到哪一步',
  whyVerbatim: '原样展示：没有摘写、没有改写、也没有再让模型解释一次 —— 理由不是权限，它是提出者留下的一句话。',
  whyEmpty: '现在没有 Agent 的购买请求。',
  whyUnavailable: '读不到 Agent 的请求记录。',

  auditTitle: '高级信息',
  auditSub: '调试用。普通使用不需要看这里。',
  auditOpen: '展开',
  auditClose: '收起',
  auditIntent: '请求编号',
  auditApproval: '决定编号',
  auditPurchase: '购买编号',
  auditQuote: '报价编号',
  auditNone: '—',
  auditNote: '这里只有四个编号，方便对着记录排查。数据库行、账本内部结构、版本号与迁移状态不在这里。'
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

/* ══ ① 概览 · 钱包（§3）═══════════════════════════════════════════   ★ 三态是**三句话**，不是一个 0：
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

/* ══════════════════════════════════════════════════════════════════
   P22-18 · 解释层（§2 / §3 / §4 / §7）

   ★ 这一整节的定位只有一句话：**让用户理解 Economy 现在发生了什么。**
     它不产生任何经济事实，也不回答任何"能不能"的问题。

   ★ 三个"不"（本阶段的三条硬边界）：
     ① 不新增事件系统 —— 时间线读的是 canonical change log（P22-1 起就有）；
     ② 不做第二个解释权威 —— Agent 的 reason **原样**带出，不摘要、不改写、
        不再调模型；
     ③ 不编造事实 —— 连不上的地方**什么都不说**（宁可少一行，也不写一个
        看起来像答案的猜测）。
   ══════════════════════════════════════════════════════════════════ */

/* ── P22-19 · 归属：**这一层不再自己判断** ────────────────────────────
   ★ P22-18 曾在这里实现过一个 `changeBelongsTo(change, ownerId, walletId)`：
     逐字比较 change 的 `walletId` 列与 payload 里的
     `ownerId` / `buyerId` / `agentId` / `wallets[].walletId`。
     它在**生产数据上漏记录**，而且漏的恰好是最该被看见的那几条 —— 这是
     实测出来的（docs §2.3 有逐行证据），不是推测：

       · `APPROVAL_APPROVED` / `APPROVAL_REJECTED` / `APPROVAL_CONSUMED`
         的 `payload.buyerId` 是 `<partyType>:<id>` 形态
         （store 用的是 `partyKeyOf`），而其它 kind 用的是裸 id。
         逐字比较于是**必然**判 false —— "用户点过头的证据"从时间线上消失。
       · `APPROVAL_EXPIRED` 的 payload **一个 owner 字段都没有**，只有
         `approvalId`。它的 owner 权威在 approvals 行上，而浏览器没有那张表，
         因此它在这条规则下**永远**无法归属。

   ★ 所以本阶段把归属**上移到 canonical**：`GET /economy/changes?ownerId=…`
     由 store 的 `listChangesForOwner` 在 SQL 里筛（四处证据的析取，见
     docs §6）。这一层因此**不**再持有那套规则，`changeBelongsTo` 被删除 ——
     而这不是"少了一个函数"，是"这条规则从两个实现变成一个"。测试断言它
     **不存在**（tests/test_p22_19_economy_read_contract.js 的 D 组）：
     一个仍然留在这里的旧判据会在 canonical 已经正确放行的行上再筛一次，
     于是把拼写差异重新变成丢记录 —— 那正是要修的东西。

   ★ 这一层仍然知道的两件事（都是**契约常量**，不是判断）：
     `CHANGE_ORDER` —— 从哪一端进入（§7：方向是 newest first）；
     `COMPLETENESS` —— 这一页读到的窗口完不完整（§7：complete / truncated
     / unknown 三态，绝不允许把 truncated 当 complete 展示）。 */

/* ══ §7 · 方向：**从最新的一端进入** ════════════════════════════════
   ★ canonical 的 change 读面按 `revision` 排序，而 keyset 分页有两个方向：
     asc 从最早往新走，desc 从最新往旧走。本层选 desc，理由是一个**已证明
     的**性质而不是偏好：全局 change log 上的 asc + 截断留下的是**最旧**的
     一段（docs §3.2 的对抗性反证），那时把页面叫作"最近活动"就是错的。
     desc 之下截断留下的是**最新**的一段，于是"这里只显示最近的一部分活动"
     这句话是真的。 */
var CHANGE_ORDER = 'desc';

/* ══ §7 · 完整性的三态 ══════════════════════════════════════════════
   ★ 三态而不是一个布尔：`unknown` 与 `truncated` 是两种不同的情况，
     说成同一句会让"读失败"看起来像"读到了但被截断"，而后者至少还知道
     自己看到的是真的。 */
var COMPLETENESS = Object.freeze({
  COMPLETE: 'complete',   /* 走到了这一端：窗口里就是这个 owner 的全部 */
  TRUNCATED: 'truncated', /* 被读面窗口挡住：这里只有**最近**的一段 */
  UNKNOWN: 'unknown'      /* 读面本身没给出可用的结果 */
});
var COMPLETENESS_LIST = Object.freeze(['complete', 'truncated', 'unknown']);

/* ══ 从一条 change 的 payload 里取出**可显示的事实** ─────────────────
   ★ 只取这几样，而且都做了类型检查：金额原样（canonical 的十进制字符串）、
     数量、商品、以及四个编号（给 §7 的折叠区用）。取了 payload 里没有的
     东西就是编 —— 因此这里没有 `|| 0` 这种兜底。 */
function changeAmountOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.amountMinor == null ? null : String(payload.amountMinor);
}
function changeRefsOf(change) {
  var p = (change && change.payload && typeof change.payload === 'object') ? change.payload : {};
  function s(v) { return v == null ? null : String(v); }
  return {
    agentIntentId: s(p.agentIntentId),
    approvalId: s(p.approvalId),
    purchaseId: s(p.purchaseId),
    quoteId: s(p.quoteId),
    reservationId: s(p.reservationId),
    productId: s(p.productId),
    agentId: s(p.agentId),
    transactionId: s(change && change.transactionId) || s(p.transactionId)
  };
}

/* ══ ② 概览 · 活动时间线（§2）═════════════════════════════════════
   目标逐字是 §2 那一句：让用户知道"为什么这里多了一笔变化"。

   ★ 每一条都**指得回去**：`revision` 是 canonical 的序列号，`refs` 是那条
     记录自己带的编号。于是"这一行是从哪来的"有一个可核对的答案。
   ★ 顺序按 canonical 的 **revision 倒序**（不是按毫秒）：同一毫秒里发生的
     两件事也有确定的先后，而时间只用于**显示**。canonical 的 owner 读面
     已经按 revision 给了（desc），这里的排序是对**窗口内**顺序的再次确认
     —— 窗口跨页时它是唯一的保证。
   ★ ★ P22-19：**这一层不再筛归属**。传进来的 `changesRes` 已经是
     canonical 按 owner 作用域给出来的。这一层只做三件事：取字段、排序、
     说清楚这个窗口完不完整。
   ★ `completeness` 是 §7 要求的三态，且**不**允许退化成两态：
       complete  —— 走到了这一端，窗口里就是这个 owner 的全部；
       truncated —— 被读面窗口挡住，页面必须说"这里只是最近的一部分"；
       unknown   —— 读面没给出可用结果（整格说读不到，而不是说"没有记录"）。
     ★ 三种情况在页面上是三句**不同**的话。把 unknown 说成空、把
       truncated 说成 complete，都会让用户以为"最近什么都没发生"。 */
function buildTimelineModel(changesRes, options) {
  options = options || {};
  var all = listOf(changesRes, 'changes');
  var scope = (changesRes && changesRes.ownerScope && typeof changesRes.ownerScope === 'object')
    ? changesRes.ownerScope : null;
  var declared = changesRes && changesRes.completeness != null ? String(changesRes.completeness) : null;
  var out = {
    read: all != null,
    error: failureOf(changesRes),
    /* 作用域：canonical 在响应里自述的那一条（`ownerScope.ownerId`），
       以及这一层**要求**的那一条（options.ownerId）。两个都带出来，于是
       "这一页读的是不是这个角色"是一个可断言的等式，而不是一个假设。 */
    ownerId: options.ownerId == null ? null : String(options.ownerId),
    scopeOwnerId: scope && scope.ownerId != null ? String(scope.ownerId) : null,
    scopeOrder: scope && scope.order != null ? String(scope.order) : null,
    requestedOrder: CHANGE_ORDER,
    revision: (changesRes && changesRes.revision != null) ? Number(changesRes.revision) : null,
    completeness: COMPLETENESS.UNKNOWN,
    fetched: all == null ? 0 : all.length,
    /* ★ 窗口内**顺序不成立**的条数（revision 缺失或重复）。
       它不是"归属不到"——归属已经由 canonical 决定了；它说的是"这一页
       拿到的行里，有几行没法被确定地排序"。>0 时窗口的可信度下降，
       页面据此不说"这是最近的一部分"。 */
    unorderable: 0,
    rows: [],
    empty: false,
    /* 余额那一格要的"最近变化"：最近一次**真的动了钱**的那一条。 */
    lastBalanceChange: null
  };
  if (all == null) {
    /* 读面没给出数组 ⇒ unknown，而不是"没有记录"。 */
    out.completeness = COMPLETENESS.UNKNOWN;
    out.error = out.error || 'changes-read-returned-no-list';
    return out;
  }
  var scoped = all.slice();
  /* revision 倒序：新的在前。revision 缺失时退回用时间排，但仍然确定性。 */
  var seenRevision = Object.create(null);
  scoped.sort(function (a, b) {
    var ra = Number(a && a.revision), rb = Number(b && b.revision);
    if (Number.isFinite(ra) && Number.isFinite(rb) && ra !== rb) return rb - ra;
    return Number(b && b.at || 0) - Number(a && a.at || 0);
  });
  for (var j = 0; j < scoped.length; j += 1) {
    var ch = scoped[j];
    var rev = Number(ch && ch.revision);
    if (!Number.isFinite(rev) || rev <= 0) out.unorderable += 1;
    else if (seenRevision[rev] === true) out.unorderable += 1;
    else seenRevision[rev] = true;
    var face = changeKindFace(ch && ch.kind);
    var refs = changeRefsOf(ch);
    var row = {
      revision: rev,
      kind: face.kind,
      face: face.face,
      tone: face.tone,
      knownKind: face.known,
      at: (ch && ch.at != null) ? Number(ch.at) : null,
      atText: timeText(ch && ch.at),
      amountMinor: changeAmountOf(ch && ch.payload),
      amountText: null,
      quantity: null,
      refs: refs
    };
    var p = (ch && ch.payload && typeof ch.payload === 'object') ? ch.payload : {};
    var currency = p.currency == null ? null : String(p.currency);
    if (row.amountMinor != null) row.amountText = groupedMoney(row.amountMinor, currency);
    var q = Number(p.units != null ? p.units : p.grantedQuantity);
    if (Number.isFinite(q)) row.quantity = q;
    out.rows.push(row);
  }
  /* ── §7 完整性：窗口的**读数**，不是窗口的猜测 ─────────────────────
     三种证据，按可信度递减：
       ① canonical 自述的 `completeness`（若将来有）；
       ② 读取器自己说的截断标记 `truncated`（false = 走到了这一端）；
       ③ 都没有 —— **unknown**，而不是 complete。一个没说过自己走完的
          窗口不能被当成走完了的窗口；把它默认成 complete 正是 §7 逐字
          禁止的"truncated → 当 complete 展示"。
     ★ 排序不可信（unorderable > 0）时**降级**为 unknown：一个顺序都不
       成立的窗口，说它"完整"没有意义。 */
  if (declared != null && COMPLETENESS_LIST.indexOf(declared) >= 0) {
    out.completeness = declared;
  } else if (changesRes && changesRes.truncated === true) {
    out.completeness = COMPLETENESS.TRUNCATED;
  } else if (changesRes && changesRes.truncated === false) {
    out.completeness = COMPLETENESS.COMPLETE;
  }
  if (out.unorderable > 0) out.completeness = COMPLETENESS.UNKNOWN;
  /* 只保留最近的一段（§2 要的是"最近发生了什么"，不是全部历史）。
     ★ 这一条是**显示**的上限，与上面那个**读取窗口**的上限是两件事：
     前者说本页铺几条，后者说读到了多少。页面把两个数分开说。 */
  var keep = Number(options.keep) > 0 ? Number(options.keep) : TIMELINE_KEEP;
  if (out.rows.length > keep) out.rows = out.rows.slice(0, keep);
  for (var k = 0; k < out.rows.length; k += 1) {
    var tone = out.rows[k].tone;
    if (tone === TONE.MONEY || tone === TONE.HOLD) { out.lastBalanceChange = out.rows[k]; break; }
  }
  out.empty = out.rows.length === 0;
  return out;
}

/* ══ ③ 概览 · 经济活动（§3：购买记录的升级）══════════════════════════
   每条记录四样东西，逐字对应 §3 那张图：

     商品 / 金额 / 状态      ← canonical Purchase 行
     来源                    ← Agent 提议 + 用户批准 + 系统完成（**各有证据**）
     时间线                  ← Intent → Approval → Purchase（各有 canonical 时间）

   ★ "来源"是**连出来的**，不是写死的三行：这一层对每一个来源都要求一条
     证据，没有证据就不写那一个词。于是"系统完成"这件事不会出现在一次
     没完成的购买上。
   ★ 一次购买**不是**一次批准、也**不是**一条 intent（canonical 逐字这么说），
     所以这一节把它们并排放，而不是把它们合成一个对象。
   ★ 顺序按 canonical 的 `createdAt` **倒序**：canonical 的列表是
     `ORDER BY created_at ASC`，也就是说它先给**最早**的；而这一格要的是
     "最近发生了什么"。这个反转发生在这一层，并且只按 canonical 的时间。 */
function buildActivityModel(purchasesRes, intentsRes, productsRes, timeline, options) {
  options = options || {};
  var purchases = listOf(purchasesRes, 'purchases');
  var intents = listOf(intentsRes, 'intents');
  var products = listOf(productsRes, 'products');
  var names = Object.create(null);
  if (products) {
    for (var i = 0; i < products.length; i += 1) {
      var p = products[i];
      if (p && p.productId != null && p.name != null) names[String(p.productId)] = String(p.name);
    }
  }
  /* 角色名：唯一出处仍是 apiConfigs（P4 契约），解析复用 P22-16 纯层那一份。 */
  var owners = ownerOptionsOf(options.apiConfigs || [], options.archivedConfigs || []);
  var labelOf = Object.create(null);
  for (var m = 0; m < owners.length; m += 1) labelOf[String(owners[m].id)] = owners[m].label;
  /* intent 按 canonical 自己的键建索引：purchaseId ↔ agentIntentId。
     方向是"从购买找 intent"（§3 的时间线要从 Purchase 往回走）。 */
  var intentByPurchase = Object.create(null);
  var intentRows = (intents || []).slice();
  for (var j = 0; j < intentRows.length; j += 1) {
    var it = intentRows[j];
    if (!it) continue;
    if (it.purchaseId != null) intentByPurchase[String(it.purchaseId)] = it;
  }
  /* 决定事件按 approvalId 索引（来自时间线，也就是 canonical change log）：     它给得出**什么时候**被决定的，而 Purchase 行上的 approval 小结只有
     "决定过、结果是什么"。两者互补，都不猜。 */
  var decideAtByApproval = Object.create(null);
  if (timeline && Array.isArray(timeline.rows)) {
    for (var t = 0; t < timeline.rows.length; t += 1) {
      var tr = timeline.rows[t];
      var aid = tr.refs && tr.refs.approvalId;
      if (aid == null) continue;
      if (tr.kind === 'APPROVAL_APPROVED' || tr.kind === 'APPROVAL_REJECTED') {
        if (decideAtByApproval[aid] == null) decideAtByApproval[aid] = tr;
      }
    }
  }
  var rows = (purchases || []).map(function (pu) {
    var purchaseId = (pu && pu.purchaseId != null) ? String(pu.purchaseId) : null;
    var pid = (pu && pu.productId != null) ? String(pu.productId) : '';
    var status = (pu && pu.status != null) ? String(pu.status) : null;
    var mode = (pu && pu.approvalMode != null) ? String(pu.approvalMode) : null;
    var intent = (purchaseId != null) ? (intentByPurchase[purchaseId] || null) : null;
    var appr = (pu && pu.approval && typeof pu.approval === 'object') ? pu.approval : null;
    var completed = !!(pu && pu.completed === true);

    /* ── 来源：每一个词都要一条证据 ───────────────────────────── */
    var source = [];
    if (intent && intent.agentId != null) {
      /* ★ P22-17 的 H3 性质逐字保留：能连上**并且**角色名认得出来时，
         说出来的是**角色名**；连不上就什么都不说（绝不把 id 摆出来）。 */
      var agentLabel = labelOf[String(intent.agentId)] || null;
      source.push({
        key: 'agent', face: COPY.sourceAgent,
        who: agentLabel == null ? null : COPY.sourceAgentWho.replace('{name}', agentLabel)
      });
    }
    if (mode === 'AUTO_ALLOW') source.push({ key: 'auto', face: COPY.sourceAuto });
    /* ★ APPROVED 与 CONSUMED 都算"你允许过"：CONSUMED 的语义恰好是
       "这份许可已经被这次购买用掉了"，它是允许**之后**的状态。只认
       APPROVED 会一次都不显示"用户批准"（真实路径几乎总是走到 CONSUMED）。 */
    else if (appr && (String(appr.status) === 'APPROVED' || String(appr.status) === 'CONSUMED') &&
      appr.decidedBy != null && String(appr.decidedBy).indexOf('user:') === 0) {
      source.push({ key: 'user', face: COPY.sourceUser });
    }
    if (completed) source.push({ key: 'system', face: COPY.sourceSystem });

    /* ── 时间线：三步，各有 canonical 的时间与状态 ─────────────── */
    var steps = [];
    steps.push({
      key: 'intent',
      label: COPY.stepIntent,
      present: !!intent,
      at: intent ? Number(intent.createdAt) : null,
      atText: intent ? timeText(intent.createdAt) : null,
      state: intent ? String(intent.state) : null,
      stateFace: intent ? (INTENT_STATE_FACE[String(intent.state)] || '状态未知') : null,
      absentText: intent ? null : COPY.stepAbsent,
      refId: intent ? String(intent.agentIntentId) : null
    });
    var apprEvent = (appr && appr.approvalId != null) ? decideAtByApproval[String(appr.approvalId)] : null;
    var apprState = appr ? String(appr.status) : null;
    steps.push({
      key: 'approval',
      label: (apprState === 'REJECTED') ? COPY.stepApprovalRejected
        : ((apprState === 'APPROVED' || apprState === 'CONSUMED') ? COPY.stepApprovalApproved : COPY.stepApproval),
      present: !!appr,
      at: appr ? Number(appr.decidedAt != null ? appr.decidedAt
        : (apprEvent ? apprEvent.at : null)) : null,
      atText: appr ? timeText(appr.decidedAt != null ? appr.decidedAt : (apprEvent ? apprEvent.at : null)) : null,
      state: apprState,
      stateFace: apprState == null ? null : (APPROVAL_STATE_FACE[apprState] || '状态未知'),
      /* ★ 三步都"没有发生"的三种原因**各不相同**，所以三句话也不同：
           早于授权层的旧记录 / 自主规则直接放行 / 读不到。 */
      absentText: appr ? null
        : (mode === 'AUTO_ALLOW' ? COPY.stepAutoNoRecord
          : (mode == null ? COPY.stepBeforeAuth : COPY.stepAbsent)),
      refId: appr && appr.approvalId != null ? String(appr.approvalId) : null
    });
    steps.push({
      key: 'purchase',
      label: COPY.stepPurchase,
      present: true,
      at: (pu && pu.completedAt != null) ? Number(pu.completedAt) : ((pu && pu.createdAt != null) ? Number(pu.createdAt) : null),
      atText: timeText((pu && pu.completedAt != null) ? pu.completedAt : (pu && pu.createdAt)),
      state: status,
      stateFace: PURCHASE_STATE_FACE[status] || '状态未知',
      absentText: null,
      refId: purchaseId
    });

    return {
      purchaseId: purchaseId,
      productId: pid,
      name: names[pid] || COPY.productGone,
      productKnown: Object.prototype.hasOwnProperty.call(names, pid),
      amountText: groupedMoney(pu && pu.amountMinor, pu && pu.currency),
      /* canonical 的十进制金额**原样**留一份：合计只用它，不用格式化过的那
         一串（"5.00 IB Credit" 不是一个可以相加的数）。 */
      amountMinor: (pu && pu.amountMinor != null) ? String(pu.amountMinor) : null,
      currency: (pu && pu.currency != null) ? String(pu.currency) : null,
      status: status,
      statusFace: PURCHASE_STATE_FACE[status] || '状态未知',
      completed: completed,
      at: (pu && pu.createdAt != null) ? Number(pu.createdAt) : null,
      atText: timeText(pu && pu.createdAt),
      mode: mode,
      authText: mode == null ? COPY.stepBeforeAuth : (AUTH_MODE_FACE[mode] || null),
      /* 数量：canonical 的 units（P22-7 起才有这个事实；旧行是 null）。 */
      units: (pu && pu.units != null) ? Number(pu.units) : null,
      unitsText: (pu && pu.units != null) ? (Number(pu.units) + ' ×') : null,
      /* 送给谁：canonical 明确把"给自己"与"送别人"分成两个键。 */
      selfDirected: !!(pu && pu.selfDirected === true),
      recipientId: (pu && pu.recipientId != null) ? String(pu.recipientId) : null,
      source: source,
      steps: steps,
      refs: {
        agentIntentId: intent ? String(intent.agentIntentId) : null,
        approvalId: steps[1].refId,
        purchaseId: purchaseId,
        quoteId: (pu && pu.quoteId != null) ? String(pu.quoteId) : null
      }
    };
  });
  rows.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  var saturated = !!(purchases && purchases.length >= LIMITS.PURCHASES);
  return {
    read: purchases != null,
    error: failureOf(purchasesRes),
    rows: rows,
    count: rows.length,
    /* ★ 窗口满时说**满**：`限 50 条而 canonical 是按最早排的`这件事让
       "合计"在窗口满时**必然**不是全部，因此这里是 saturated 而不是
       "可能还有"。 */
    saturated: saturated,
    empty: purchases != null && rows.length === 0,
    /* ★ P22-19：这一格说"更早的仍然在「活动时间线」里"之前，必须先知道
       那一格**有没有**读完整 —— 于是这里把它的完整性原样带出来，措辞由
       渲染器按它选。两个格子对同一件事的说法不许互相矛盾。 */
    timelineCompleteness: timeline && timeline.completeness != null
      ? String(timeline.completeness) : null,
    timelineIsComplete: !!(timeline && timeline.completeness === COMPLETENESS.COMPLETE)
  };
}

/* ══ ④ 概览 · 支出说明（§2 的"Spending explanation"）═══════════════
   ★ 只回答一个问题的**前半句**："钱花到哪儿去了"。后半句"还剩多少"
     属于钱包那一格（canonical 的 availableBalanceMinor）。
   ★ 合计是**这一页加出来的**，因此模型里逐字写着 `computedByThisPage: true`
     并带一句免责 —— 权威的当日累计在「预算」那一格（canonical 算的）。
     把两者混起来会造出第二个"花了多少"的答案，而其中一个迟早会漂。
   ★ 读不到的金额**不计入合计**（宁可合计小一点，也不要一个编出来的数），
     并且这一行为此单独有一个计数。 */
function buildSpendingModel(activity, options) {
  options = options || {};
  var rows = [];
  var total = 0;
  var any = false;
  var missing = 0;
  if (activity && Array.isArray(activity.rows)) {
    for (var i = 0; i < activity.rows.length; i += 1) {
      var r = activity.rows[i];
      if (!r.completed) continue;
      any = true;
      if (r.amountMinor == null) { missing += 1; continue; }
      /* 合计用的是 canonical 的**最小单位整数**（`amountMinor` 就是它），
         因此这里是整数加法，不经过浮点。读不出整数的行**不进合计**。 */
      var units = minorUnitsOf(r.amountMinor);
      if (units == null) { missing += 1; continue; }
      rows.push(r);
      total += units;
    }
  }
  return {
    read: !!(activity && activity.read),
    error: activity ? activity.error : null,
    rows: rows,
    count: rows.length,
    anyCompleted: any,
    missingAmountRows: missing,
    totalMinor: total,
    totalText: rows.length ? groupedMoney(String(total), rows[0].currency) : null,
    /* 逐字的两个自述：这个合计是本页算的，而且窗口满时它不是全部。 */
    computedByThisPage: true,
    complete: !(activity && activity.saturated === true),
    saturated: !!(activity && activity.saturated === true),
    isEmpty: !any
  };
}
/* canonical 的金额串 → 整数最小单位。`serializeAmountMinor` 的产物就是
   一个十进制整数字符串（例如 "1245000" 表示 12,450.00），因此这里**不**
   做任何 scale 换算 —— 换算过一次就多加了一个"这一层自己算的汇率"。
   非法输入返回 null（于是它不会被当成 0 混进合计）。 */
function minorUnitsOf(text) {
  if (text == null) return null;
  var s = String(text);
  if (!/^-?\d+$/.test(s)) return null;
  var n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/* ══ ⑤ 概览 · Agent 为什么提出（§4）════════════════════════════════
   ★ 这一节的全部价值在于**一句都不改**：reason 由提出请求的 Agent 写下，
     本层逐字搬运。于是 `reasonVerbatim: true` 与 `reasonSummarizedByAi: false`
     是这个模型的形状，而不是文档里的一句话 —— 一次摘要会让页面上出现
     第二份解释，而两份解释不一致时用户没有任何办法判断哪一份是真的。
   ★ 数量、目标、现在的状态全部来自 canonical 的 Intent 行与目录 join。 */
function buildIntentExplanationModel(intentsRes, productsRes, options) {
  options = options || {};
  var intents = listOf(intentsRes, 'intents');
  var products = listOf(productsRes, 'products');
  var names = Object.create(null);
  if (products) {
    for (var i = 0; i < products.length; i += 1) {
      var p = products[i];
      if (p && p.productId != null && p.name != null) names[String(p.productId)] = String(p.name);
    }
  }
  var rows = (intents || []).map(function (it) {
    var pid = (it && it.productId != null) ? String(it.productId) : '';
    var state = (it && it.state != null) ? String(it.state) : null;
    var reason = (it && it.reason != null && String(it.reason) !== '') ? String(it.reason) : null;
    var units = (it && it.units != null) ? Number(it.units) : null;
    return {
      agentIntentId: (it && it.agentIntentId != null) ? String(it.agentIntentId) : null,
      agentId: (it && it.agentId != null) ? String(it.agentId) : null,
      productId: pid,
      name: names[pid] || COPY.productGone,
      productKnown: Object.prototype.hasOwnProperty.call(names, pid),
      state: state,
      stateFace: INTENT_STATE_FACE[state] || '状态未知',
      terminal: !!(it && it.terminal === true),
      /* ★ 原样。没有 trim 之外的任何处理。 */
      reason: reason,
      reasonVerbatim: true,
      reasonSummarizedByAi: false,
      reasonIsAuthority: false,
      units: units,
      unitsText: units == null ? null : String(units),
      at: (it && it.createdAt != null) ? Number(it.createdAt) : null,
      atText: timeText(it && it.createdAt),
      expiresAt: (it && it.expiresAt != null) ? Number(it.expiresAt) : null,
      expiredByTime: !!(it && it.expiredByTime === true),
      refs: {
        agentIntentId: (it && it.agentIntentId != null) ? String(it.agentIntentId) : null,
        approvalId: (it && it.approvalId != null) ? String(it.approvalId) : null,
        purchaseId: (it && it.purchaseId != null) ? String(it.purchaseId) : null,
        quoteId: (it && it.quoteId != null) ? String(it.quoteId) : null
      }
    };
  });
  rows.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  return {
    read: intents != null,
    error: failureOf(intentsRes),
    rows: rows,
    count: rows.length,
    empty: intents != null && rows.length === 0,
    /* 三句结构性的自述：理由不是权限，而且这一层不对它做任何加工。 */
    reasonIsAuthority: false,
    reasonIsTelemetry: true,
    reasonSummarizedByAi: false
  };
}

/* ══ ⑥ 概览 · 高级信息（§7）═════════════════════════════════════════
   ★ 里面**只有**四个编号：Intent / Approval / Purchase / Quote。它们都是
     canonical 自己的 id，逐字搬运。
   ★ 刻意**不**放的（§7 明令）：数据库行、账本内部结构、revision、迁移状态。
     这一层连读都不读它们 —— `revision` 只在技术说明的折叠层里出现一次
     （它是 change log 的序列号，用于说明"这一页按什么顺序排"）。
   ★ 默认折叠：`open: false` 是模型的初值，渲染器照它画。 */
function buildAuditModel(activity, explanations, options) {
  options = options || {};
  var rows = [];
  var activityRows = (activity && Array.isArray(activity.rows)) ? activity.rows : [];
  for (var i = 0; i < activityRows.length; i += 1) {
    var r = activityRows[i];
    if (r.refs == null) continue;
    rows.push({ key: r.purchaseId || ('row-' + i), name: r.name, refs: r.refs });
  }
  /* intent 里有、但还没有对应 Purchase 的那些（在等决定的、被拒的）也要
     能查 —— 否则"这个请求的编号是什么"在最需要它的时刻读不到。 */
  var seen = Object.create(null);
  for (var s = 0; s < rows.length; s += 1) {
    if (rows[s].refs.agentIntentId != null) seen[rows[s].refs.agentIntentId] = true;
  }
  var expRows = (explanations && Array.isArray(explanations.rows)) ? explanations.rows : [];
  for (var j = 0; j < expRows.length; j += 1) {
    var e = expRows[j];
    if (e.refs == null || e.agentIntentId == null) continue;
    if (seen[e.agentIntentId] === true) continue;
    seen[e.agentIntentId] = true;
    rows.push({ key: e.agentIntentId, name: e.name, refs: e.refs });
  }
  return {
    open: false,
    rows: rows,
    count: rows.length,
    /* 逐字的边界：这一格不含数据库行 / 账本内部 / 版本号 / 迁移状态。 */
    showsDatabaseRows: false,
    showsLedgerInternals: false,
    showsRevision: false,
    showsMigrationState: false
  };
}

/* ══ ⑦ 组装整页模型 ═══════════════════════════════════════════════
   一个纯函数把六份读面结果拼成三个面板要用的东西。渲染器因此不需要
   认识任何 canonical 字段名。 */
function buildPageView(sources) {
  sources = sources || {};
  var wallet = buildWalletModel(sources.wallet, { ownerId: sources.owner });
  var intentModel = buildIntentExplanationModel(sources.intents, sources.products, {});
  var timeline = buildTimelineModel(sources.changes, { ownerId: sources.owner });
  var activity = buildActivityModel(sources.purchases, sources.intents, sources.products, timeline, sources);
  return {
    owner: sources.owner || null,
    wallet: wallet,
    budget: buildBudgetModel(sources.policy, sources.budgetSnapshot, { ownerId: sources.owner }),
    purchases: buildPurchaseModel(sources.purchases, sources.products, sources.intents, sources),
    stores: buildStoreModel(sources.stores, sources.products),
    products: buildProductModel(sources.products, {}),
    assets: buildAssetsModel(sources.inventory, sources.products, { ownerId: sources.owner }),
    /* ── P22-18 的四个新面（都是解释层，没有一个是新的经济事实）────── */
    timeline: timeline,
    activity: activity,
    explanations: intentModel,
    spending: buildSpendingModel(activity, {}),
    audit: buildAuditModel(activity, intentModel, {})
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
  SECTION_COPY: SECTION_COPY,
  sectionCopyOf: sectionCopyOf,
  READS: READS,
  LIMITS: LIMITS,
  COPY: COPY,

  /* ── P22-18 · 第九条只读面与解释层 ─────────────────────────────── */
  CHANGE_READ: CHANGE_READ,
  CHANGE_LIMIT: CHANGE_LIMIT,
  /* ── P22-19 · 方向与完整性三态（归属已上移到 canonical）────────── */
  CHANGE_ORDER: CHANGE_ORDER,
  COMPLETENESS: COMPLETENESS,
  COMPLETENESS_LIST: COMPLETENESS_LIST,
  TIMELINE_KEEP: TIMELINE_KEEP,
  ACTIVITY_KEEP: ACTIVITY_KEEP,
  TONE: TONE,
  CHANGE_KIND_FACE: CHANGE_KIND_FACE,
  CHANGE_KIND_KEYS: CHANGE_KIND_KEYS,
  changeKindFace: changeKindFace,
  isLedgerCommitKind: isLedgerCommitKind,
  minorUnitsOf: minorUnitsOf,

  STORE_STATUS_FACE: STORE_STATUS_FACE,
  PRODUCT_STATUS_FACE: PRODUCT_STATUS_FACE,
  PURCHASE_STATE_FACE: PURCHASE_STATE_FACE,
  ASSET_KIND_FACE: ASSET_KIND_FACE,
  AUTH_MODE_FACE: AUTH_MODE_FACE,
  WALLET_STATE_FACE: WALLET_STATE_FACE,
  INTENT_STATE_FACE: INTENT_STATE_FACE,
  APPROVAL_STATE_FACE: APPROVAL_STATE_FACE,
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
  buildTimelineModel: buildTimelineModel,
  buildActivityModel: buildActivityModel,
  buildSpendingModel: buildSpendingModel,
  buildIntentExplanationModel: buildIntentExplanationModel,
  buildAuditModel: buildAuditModel,
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
