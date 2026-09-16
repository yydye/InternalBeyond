/* ====================================================================
   IB · Economy Configuration UI — 纯层（P22-16）
   --------------------------------------------------------------------
   这一层回答一个问题：

     「这台节点上的经济配置现在是什么，我要把它改成什么？」

   它**不碰 DOM、不发请求、不认识 window**，因此可以在 Node 里逐条测。
   渲染器（assets/js/economy-configuration.js）只做三件事：
   把这里的视图模型画出来、把用户手势变成这里构造的**信封**、然后重新读。

   ── 它投影的是什么 ──────────────────────────────────────────────────
   唯一的写面是 P22-14 那条 seam：

     POST /internal/economy/configuration
     { command, config, idempotencyKey }        ← 恰好三个顶层键

   而命令词表**封闭三词**：BOOTSTRAP_CREDIT / PUT_BUDGET_POLICY /
   PUT_AUTONOMY_POLICY。本文件里的 COMMANDS 与 CONFIG_KEYS 是那份契约的
   **镜像**，测试会逐字比对 services/home-node/economy-configuration.js
   （与 P22-15 对币种表 / 文案表做的是同一件事：镜像表必须被钉住，
   否则服务端加一个字段而前端少一个键，会静默地少发一个配置）。

   ── 它**不**做的（逐条对着 §3 / §4 / §5）────────────────────────────
   · 不发任何 /economy/* 的写请求，也没有 /economy/* 的写方法名：整个
     模块里没有 'mint' / 'ledger' / 'transfer' / 'settle' / 'reserve' /
     'buy' / 'refund' / 'exchange' 这些命令词，**不是被过滤，是不存在**。
   · 不判定任何经济事实：余额够不够、预算剩多少、自主裁决、
     报价有效性、商品状态 —— 五个都不算。保存成功只说"规则已保存"，
     不说"Agent 现在可以买了"。
   · 不做"乐观成功"：构造请求 → 等回答 → 由调用方**重新读**权威状态。
   · 不发明 canonical 里没有的字段。逐字的一例：§4 要求表达"允许购买的
     商店范围"，而 canonical 契约里**没有** store-scope / store allowlist
     这个字段（autonomy 的作用范围只有 allowedProductKinds 与
     allowedSettlementTypes），因此这里没有它，界面上也不会出现它。
   ==================================================================== */
(function (NS) {
'use strict';

var CORE_VERSION = 'p22-16-1';

/* ══ DOM 锚点 ═══════════════════════════════════════════════════════
   ★ PAGE 与 REQUESTS 是 P22-15 的既有事实，本阶段**一个字节都不改**：
     InternalBeyond.html 里仍然是
       <div class="page" id="page-economy"><div id="economy-requests"></div></div>
     渲染器把新外壳**插在它前面**，并按页签开合它的 style.display ——
     不搬动那个节点，因此 P22-15 的 DOM 断言与视觉断言继续成立。 */
var ID = Object.freeze({
  PAGE: 'page-economy',
  REQUESTS_HOST: 'economy-requests',
  HOST: 'economy-configuration',
  TABS: 'economy-config-tabs',
  OWNER_BAR: 'economy-config-owner',
  WALLET_PANE: 'economy-config-wallet',
  BUDGET_PANE: 'economy-config-budget',
  AUTONOMY_PANE: 'economy-config-autonomy'
});

/* ══ 唯一的写面 ═════════════════════════════════════════════════════ */
var WRITE_PATH = '/internal/economy/configuration';

/* ══ 只读面：五条既有 GET，本阶段不新增任何读路径 ═══════════════════ */
var READS = Object.freeze({
  WALLET: '/economy/wallet',
  POLICY: '/economy/policy',
  AUTONOMY_POLICY: '/economy/autonomy-policy',
  BUDGET: '/economy/budget',
  SECURITY: '/security'
});

/* ══ 命令词表（封闭三词，镜像 economy-configuration.js:110-117）═════ */
var COMMAND = Object.freeze({
  BOOTSTRAP_CREDIT: 'BOOTSTRAP_CREDIT',
  PUT_BUDGET_POLICY: 'PUT_BUDGET_POLICY',
  PUT_AUTONOMY_POLICY: 'PUT_AUTONOMY_POLICY'
});
var COMMANDS = Object.freeze([COMMAND.BOOTSTRAP_CREDIT, COMMAND.PUT_BUDGET_POLICY, COMMAND.PUT_AUTONOMY_POLICY]);

/* ══ 信封（恰好三个顶层键，镜像 :125）════════════════════════════════ */
var ENVELOPE_KEYS = Object.freeze(['command', 'config', 'idempotencyKey']);

/* ══ 每个命令的 config 键白名单（镜像 :137-147）═══════════════════════ */
var CONFIG_KEYS = Object.freeze({
  BOOTSTRAP_CREDIT: Object.freeze(['ownerId', 'currency', 'amountMinor']),
  PUT_BUDGET_POLICY: Object.freeze(['ownerId', 'currency', 'limits', 'termEndsAt', 'autonomyLevel', 'ifRevision']),
  PUT_AUTONOMY_POLICY: Object.freeze([
    'ownerId', 'enabled', 'perPurchaseLimitMinor', 'dailyAutonomousLimitMinor',
    'approvalAboveMinor', 'allowedProductKinds', 'allowedSettlementTypes',
    'allowGift', 'ifRevision'
  ])
});

/* ══ 币种 ═══════════════════════════════════════════════════════════
   ★ 配置面在初始额度上只收 IB_CREDIT（economy-configuration.js:430），
     而预算的政策币种也用它 —— 这一页配的是 IB Credit 这一个世界。
   展示用 scale 表是 canonical 契约的镜像，测试会逐字比对。 */
var CURRENCY = 'IB_CREDIT';
var CURRENCY_SCALE = Object.freeze({
  IB_CREDIT: 100, ACTIVITY_POINT: 100,
  COMPUTE_STANDARD: 1, COMPUTE_PREMIUM: 1, IMAGE_CREDIT: 1, VOICE_CREDIT: 1
});
var CURRENCY_LABEL = Object.freeze({
  IB_CREDIT: 'IB Credit', ACTIVITY_POINT: 'Activity Point',
  COMPUTE_STANDARD: 'Standard Compute Credit', COMPUTE_PREMIUM: 'Premium Compute Credit',
  IMAGE_CREDIT: 'Image Credit', VOICE_CREDIT: 'Voice Credit'
});
var CURRENCY_LABEL_ZH = Object.freeze({
  IB_CREDIT: 'IB Credit', ACTIVITY_POINT: '活动点',
  COMPUTE_STANDARD: '标准算力额度', COMPUTE_PREMIUM: '高级算力额度',
  IMAGE_CREDIT: '图像额度', VOICE_CREDIT: '语音额度'
});

/* ══ limits 的可配置键（镜像 economy-contract.js:1602-1615）═══════════
   ★ 这张表**不是**"我们支持这些"，而是"契约受理这些"。界面上只暴露
     其中五个（一次限额 / 每日 / 审批线，加高级里的每周 / 每月），
     其余的在界面上不出现 —— 不出现的字段不会被发送，因此不会静默改配置。 */
var LIMIT_KEYS = Object.freeze([
  'availableBalanceMinor', 'perTransactionMinor', 'dailyMinor', 'weeklyMinor',
  'monthlyMinor', 'categoryMinor', 'recipientMinor', 'autonomousSpendMinor',
  'emergencyReserveMinor', 'approvalThresholdMinor'
]);
var COOLDOWN_KEY = 'cooldownMs';

/* 界面暴露的五个（前三个在主区，后两个在高级区）。留空 = 这一档不设。 */
var LIMIT_FIELDS = Object.freeze([
  Object.freeze({ key: 'perTransactionMinor', label: '单次最多可花', hint: '一笔最多到这个数，超过它这笔会被直接拦下。留空表示不设这一档。' }),
  Object.freeze({ key: 'dailyMinor', label: '每日最多可花', hint: '一天之内累计最多到这个数（按 UTC 自然日计）。留空表示不设这一档。' }),
  Object.freeze({ key: 'approvalThresholdMinor', label: '超过多少先问我', hint: '单笔超过这条线会变成一条等你决定的请求，而不是被拦下。留空表示不设这一档。' }),
  Object.freeze({ key: 'weeklyMinor', label: '每周最多可花', hint: '一周之内累计最多到这个数。留空表示不设这一档。' }),
  Object.freeze({ key: 'monthlyMinor', label: '每月最多可花', hint: '一个月之内累计最多到这个数。留空表示不设这一档。' })
]);

/* ══ autonomyLevel（镜像 economy-contract.js:1457-1464）═══════════════
   ★ 它是**总标记**，不是"这一笔能不能买"的规则：契约的预算评估器不读
     它（全仓只有 validateBudgetPolicy 与 normalizeBudgetInput 提到它）。
     因此界面上它带一句实话，而不是一个看起来能放权的旋钮。 */
var AUTONOMY_LEVEL = Object.freeze({ NONE: 'NONE', LIMITED: 'LIMITED', STANDARD: 'STANDARD', ELEVATED: 'ELEVATED' });
var AUTONOMY_LEVELS = Object.freeze(['NONE', 'LIMITED', 'STANDARD', 'ELEVATED']);
var AUTONOMY_LEVEL_LABEL = Object.freeze({
  NONE: '关闭', LIMITED: '有限', STANDARD: '常规', ELEVATED: '放宽'
});

/* ══ 商品类别与交付方式（镜像契约的 PRODUCT_KINDS / FULFILLMENTS）═════ */
var PRODUCT_KINDS = Object.freeze(['DIGITAL_ITEM', 'CONSUMABLE', 'API_QUOTA', 'COMPUTE_CREDIT', 'SERVICE']);
var PRODUCT_KIND_LABEL = Object.freeze({
  DIGITAL_ITEM: '数字内容', CONSUMABLE: '消耗品', API_QUOTA: '接口额度',
  COMPUTE_CREDIT: '算力额度', SERVICE: '服务'
});
var FULFILLMENTS = Object.freeze(['INVENTORY_GRANT', 'COMPUTE_GRANT', 'SERVICE_EXECUTION']);
var FULFILLMENT_LABEL = Object.freeze({
  INVENTORY_GRANT: '拿到一件东西', COMPUTE_GRANT: '补充算力', SERVICE_EXECUTION: '执行一次服务'
});

/* ══ 页签 ═══════════════════════════════════════════════════════════
   ★ 第一个是 P22-15 的页面：它**不是**本模块渲染的，本模块只负责开合
     它的 display。paneId 为 null 的对象就是"那一块不归我画"。 */
var SECTION = Object.freeze({
  REQUESTS: 'requests', WALLET: 'wallet', BUDGET: 'budget', AUTONOMY: 'autonomy'
});
var SECTIONS = Object.freeze([
  Object.freeze({ key: SECTION.REQUESTS, label: '待处理', paneId: null, configuresAnOwner: false }),
  Object.freeze({ key: SECTION.WALLET, label: '钱包与初始额度', paneId: ID.WALLET_PANE, configuresAnOwner: true }),
  Object.freeze({ key: SECTION.BUDGET, label: '预算限制', paneId: ID.BUDGET_PANE, configuresAnOwner: true }),
  Object.freeze({ key: SECTION.AUTONOMY, label: '自主购买', paneId: ID.AUTONOMY_PANE, configuresAnOwner: true })
]);

/* ══ 文案 ═══════════════════════════════════════════════════════════
   ★ 三条硬要求逐字落在这里：
     ① §1 的禁用词一个都不出现（充值 / 提现 / 银行卡 / 支付 / 余额充值 /
        法币符号 / Provider Top-up）；
     ② "已设置"与"可以买"是两件事 —— 成功文案里没有任何一句说后者；
     ③ 配置面关着时**进页面就说**，不留一个点了才报 503 的按钮。 */
var COPY = Object.freeze({
  title: 'Economy',
  subtitle: 'Agent Economy',
  tablistLabel: '经济配置分区',
  ownerLabel: '配置对象',
  ownerHint: '这台节点上，钱与规则都属于某个角色。',
  ownerEmpty: '还没有配置任何角色',
  ownerEmptyBody: 'Economy 的配置对象是角色。先在「API」里添加一位角色，再回到这里。',
  refresh: '重新读取',
  reading: '读取中…',
  saved: '已保存',
  saving: '保存中…',
  save: '保存',
  advanced: '高级设置',
  advancedShow: '展开',
  advancedHide: '收起',
  technical: '技术说明',
  readFailed: '读不到本机节点',
  retry: '再试一次',

  /* 配置面关着（§7：进页面就说清楚，不给假按钮）。 */
  closedTitle: '这里现在还改不了',
  closedBody: '这台设备还没有配置本机节点的访问凭据，因此配置暂时不能保存。聊天与其它功能不受影响。',
  closedTechnical: '在启动本机节点之前设置环境变量 IB_HOME_NODE_TOKEN，然后重启 InternalBeyond。',
  closedUnknown: '读不到本机节点的自述，因此这里不提供保存 —— 我们不知道这把钥匙现在开不开。',

  /* 钱包与初始额度 */
  walletTitle: '钱包与初始额度',
  walletKind: '内部虚拟额度',
  walletAbsent: '还没有 IB Credit 钱包',
  walletAbsentBody: '初始额度只发一次，发过之后不能再加。它决定了这位角色一开始能动用多少内部额度。',
  walletAbsentInput: '初始额度',
  walletAbsentUnit: 'IB Credit',
  walletSet: '设置初始额度',
  walletSetAsk: '确定设置？只能设置一次。',
  walletSetNo: '再想想',
  walletJustSet: '初始额度已设置',
  walletAlreadySet: '初始额度早已设置过，这次没有改动任何东西。',
  walletBootstrapped: '初始额度已设置',
  walletBootstrappedBody: '一次性的初始化已经用掉了，因此这里没有第二个可以设置的额度。',
  walletAvailable: '当前可用',
  walletLedger: '账本余额',
  walletReserved: '已预留',
  walletNotReady: '余额暂时不可信',
  walletNotReadyBody: '账本的引用链没有对齐，因此这里的余额显示为空 —— 空不是零。',

  /* 预算限制 */
  budgetTitle: '预算限制',
  budgetIntro: '这些规则决定这位角色能动用多少。规则由本机节点的权威评估器读，界面不参与判断。',
  budgetAbsent: '还没有预算规则 —— 未配置时，任何支出都需要你确认。',
  budgetMeterTitle: '每日预算',
  budgetMeterUsed: '已使用',
  budgetMeterLimit: '上限',
  budgetMeterUnknown: '暂时读不到今日已用，因此这里只显示额度刻度。',
  budgetMeterScaleOnly: '额度刻度',
  budgetTerm: '有效期到',
  budgetTermHint: '留空表示不设期限。到期之后这条规则就不再生效。',
  budgetLevel: '自主程度标记',
  budgetLevelHint: '这是这台节点对自主程度的**总标记**。真正决定某一笔能否自主购买的是「自主购买」那一页的规则。',
  budgetLevelUnset: '未设置',
  budgetSaved: '预算规则已保存',
  budgetSavedNote: '保存只说明规则写好了。某一件东西能不能买，仍然由余额、预算、商品状态、报价与批准各自回答。',
  budgetUnset: '不设',

  /* 自主购买 */
  autonomyTitle: '自主购买',
  autonomyIntro: '决定这位角色能不能不问你直接买。',
  autonomyAbsent: '还没有自主规则 —— 未配置时，任何购买都会变成等你确认的请求。',
  autonomyEnabled: '允许自主购买',
  autonomyEnabledHint: '关掉之后，每一次购买都会先来问你。',
  autonomyPerPurchase: '单次自主购买上限',
  autonomyDaily: '每日自主购买上限',
  autonomyApproval: '超过多少需要我确认',
  autonomyApprovalHint: '留空表示整段自主额度都需要你先确认。',
  autonomyApprovalUnit: 'IB Credit',
  autonomyKinds: '允许购买的商品范围',
  autonomyKindsHint: '一个都不选时，规则写下了，但不会自主买任何东西。',
  autonomySettlements: '允许的交付方式',
  autonomySettlementsHint: '超出这两种之外的范围，契约里没有对应的字段。',
  autonomyNoStoreScope: '这台节点没有「商店范围」这一项 —— 契约里自主策略的作用范围只有商品类别与交付方式。',
  autonomyGift: '允许送礼',
  autonomyGiftHint: '允许之后，自主购买也可以把东西买给别人。',
  autonomyAuthorityNote: '自主购买仍受 Budget、商品状态、报价与 Approval 等 Economy authority 约束。这份规则不绕过它们中的任何一个。',
  autonomySaved: '自主购买规则已保存',
  autonomySavedNote: '保存只说明规则写好了，不表示现在就可以买 —— 每一笔仍要各自通过余额、预算、商品状态与报价。',
  on: '开启',
  off: '关闭',

  /* 高级区里出现但主区不铺满的一句话 */
  revisionConflict: '这份配置在别处被改过了，因此这次没有保存。重新读取之后再试一次。'
});

/* ══ 形状失败：字段名 + 一句"这一格该怎么填" ═══════════════════════════
   ★ 这一层只回答**输入形状**（空着没有 / 不是一个数 / 太多位小数），
     它不回答任何语义问题 ——「单次不能高于每日」那一条由经济权威回答，
     界面上只负责把权威的原话翻出来（见 REFUSAL_TEXT / ERROR_TOKEN_TEXT）。
     把两者混起来就等于这一页自己判了一遍经济规则，而那会造出第二个答案。 */
var SHAPE_FIELD_LABEL = Object.freeze({
  bootstrapAmount: '初始额度',
  amountMinor: '初始额度',
  ownerId: '配置对象',
  perTransactionMinor: '单次最多可花',
  dailyMinor: '每日最多可花',
  approvalThresholdMinor: '超过多少先问我',
  weeklyMinor: '每周最多可花',
  monthlyMinor: '每月最多可花',
  cooldownMs: '冷却时间',
  termEndsAt: '有效期',
  autonomyLevel: '自主程度标记',
  ifRevision: '配置版本',
  enabled: '允许自主购买',
  perPurchaseLimitMinor: '单次自主购买上限',
  dailyAutonomousLimitMinor: '每日自主购买上限',
  approvalAboveMinor: '超过多少需要我确认',
  allowedProductKinds: '允许购买的商品范围',
  allowedSettlementTypes: '允许的交付方式',
  allowGift: '允许送礼'
});
var SHAPE_CODE_TEXT = Object.freeze({
  required: '这一格必须填。',
  'must-be-positive': '这一格需要大于 0。',
  'not-an-amount': '这一格需要一个金额，最多两位小数。',
  'not-a-whole-number': '这一格需要一个整数。',
  'too-large': '这个数太大了。',
  'not-a-duration': '这一格需要一个整数（毫秒）。',
  'not-a-date': '这一格需要一个日期。',
  'not-in-closed-set': '这一格的值不在允许的选择里。',
  'not-canonical': '这一格的格式不对。',
  'unknown-currency': '这个币种在这里不受理。'
});
function shapeFailureText(code, field) {
  var c = str(code);
  var label = field == null ? null : SHAPE_FIELD_LABEL[str(field)];
  var said = SHAPE_CODE_TEXT[c];
  if (c === 'missing-owner') return '还没有选择配置对象。';
  if (c === 'envelope-not-projected') return '这次改动没有构成一个合法的请求，因此没有发出。';
  if (label != null && said != null) return '「' + label + '」' + said;
  if (said != null) return said;
  return '这次输入没有构成一个合法的配置请求，因此没有发出。';
}

/* ══ 拒绝码 → 一句人话 ═══════════════════════════════════════════════
   ★ 左列**全部**是 services/home-node/economy-configuration.js 与
     economy-store.js 里真实存在的码/词，没有一个是这里发明的。
   ★ 查不到的码**不编句子**：classifyConfigurationResponse 会保留原词，
     交给界面放进技术说明 —— 编一句听起来合理的解释是这一域最坏的
     失败形态（P22-15 的 DECISION_REFUSAL_TEXT 是同一条纪律）。 */
var REFUSAL_TEXT = Object.freeze({
  ECONOMY_CONFIGURATION_NOT_CONFIGURED: '这台节点还没有把经济配置装好。',
  ECONOMY_CONFIGURATION_DESKTOP_TOKEN_NOT_CONFIGURED: '这台设备还没有配置本机节点的访问凭据。',
  ECONOMY_CONFIGURATION_NOT_LOOPBACK: '这个请求不是从本机发出的。',
  ECONOMY_CONFIGURATION_MISSING_DESKTOP_CREDENTIAL: '这次请求没有带上本机节点的访问凭据。',
  ECONOMY_CONFIGURATION_WRONG_DESKTOP_CREDENTIAL: '本机节点不认这把凭证。',
  ECONOMY_CONFIGURATION_MALFORMED_ENVELOPE: '这一次改动没有构造出合法的请求。',
  ECONOMY_CONFIGURATION_NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT: '请求里带了不该由发起方声明的身份字段。',
  ECONOMY_CONFIGURATION_UNEXPECTED_ENVELOPE_KEYS: '请求里有这一层不认识的字段。',
  ECONOMY_CONFIGURATION_MISSING_COMMAND: '请求里没有说明要改什么。',
  ECONOMY_CONFIGURATION_UNKNOWN_COMMAND: '这个改动这一层不受理。',
  ECONOMY_CONFIGURATION_MISSING_CONFIG: '请求里没有带要改的内容。',
  ECONOMY_CONFIGURATION_MALFORMED_CONFIG: '要改的内容不成形。',
  ECONOMY_CONFIGURATION_UNEXPECTED_CONFIG_KEYS: '要改的内容里有这一层不认识的字段。',
  ECONOMY_CONFIGURATION_MISSING_OWNER_ID: '没有说明要配置哪一位角色。',
  ECONOMY_CONFIGURATION_MISSING_IDEMPOTENCY_KEY: '这一次改动没有带上身份，因此没有发出。',
  ECONOMY_CONFIGURATION_REQUEST_ID_CONFLICT: '同一个身份已经用在另一次改动上了。',
  ECONOMY_CONFIGURATION_INITIAL_CREDIT_CURRENCY_MUST_BE_IB_CREDIT: '初始额度只能是 IB Credit。',
  ECONOMY_CONFIGURATION_REFUSED_BY_THE_ECONOMY_STORE: '本机节点的经济权威拒绝了这次改动。',
  INITIAL_CREDIT_ALREADY_BOOTSTRAPPED: '这位角色的初始额度已经设置过了，不能设置第二次。',
  'budget-policy-revision-mismatch': COPY.revisionConflict,
  'autonomy-policy-revision-mismatch': COPY.revisionConflict,
  'owner-not-found': '这台节点里没有这位角色。',
  POLICY_INPUT_NOT_STRUCTURED: '要保存的规则不成形，因此没有被接受。',
  INVALID_CURRENCY: '这个币种在这里不受理。',
  INVALID_AMOUNT: '这个金额不是合法的金额。',
  PARTY_NOT_ALLOWED: '这个对象不能是规则的主人。'
});

/* ══ store 的具名 validation 词 → 一句人话（逐字来自 economy-contract.js
   与 economy-store.js 的 errors[]，因此它比任何兜底句都准确）═══════ */
var ERROR_TOKEN_TEXT = Object.freeze({
  'initial-credit-is-one-shot-per-owner-and-currency': '初始额度每人只能发一次。',
  'system-party-cannot-hold-an-initial-credit': '系统账户不能拥有初始额度。',
  'system-party-cannot-own-a-budget-policy': '系统账户不能拥有预算规则。',
  'system-cannot-own-an-autonomy-policy': '系统账户不能拥有自主规则。',
  'wallet-not-found': '这位角色还没有钱包。',
  'budget-policy-currency-does-not-match': '这条预算规则的币种与要评估的币种不一致。',
  'policy-limits-must-be-a-structured-object': '限额不成形。',
  'policy-limit-key-not-in-closed-set': '限额里有一个契约不认识的档位。',
  'policy-limit-value-must-be-an-amount-minor': '某一个限额不是合法的金额。',
  'policy-cooldown-must-be-non-negative-safe-integer': '冷却时间必须是非负整数毫秒。',
  'policy-term-ends-at-must-be-a-non-negative-safe-integer': '有效期的格式不对。',
  'policy-autonomy-level-not-in-closed-set': '自主程度标记不在允许的四档里。',
  'policy-input-must-be-a-structured-object': '规则不成形。',
  'autonomy-policy-enabled-must-be-a-boolean': '「允许自主购买」只能是开或关。',
  'autonomy-policy-requires-per-purchase-limit-minor': '单次自主购买上限是必填的 —— 没有上限的自主等于随便花。',
  'autonomy-policy-requires-daily-autonomous-limit-minor': '每日自主购买上限是必填的。',
  'autonomy-per-purchase-limit-must-not-exceed-the-daily-autonomous-limit': '单次上限不能高于每日上限。',
  'autonomy-approval-threshold-must-not-exceed-the-per-purchase-limit': '确认线不能高于单次上限 —— 否则它永远不会被触发。',
  'autonomy-allowed-product-kinds-must-be-a-non-empty-array': '商品范围要么留空，要么至少选一项。',
  'autonomy-allowed-product-kind-not-in-closed-set': '商品范围里有一个契约不认识的类别。',
  'autonomy-allowed-settlement-types-must-be-a-non-empty-array': '交付方式要么留空，要么至少选一项。',
  'autonomy-allowed-settlement-type-not-in-closed-set': '交付方式里有一个契约不认识的值。',
  'autonomy-allow-gift-must-be-a-boolean': '「允许送礼」只能是开或关。',
  'autonomy-policy-owner-invalid': '规则的主人不是合法的对象。',
  'autonomy-policy-owner-type-not-in-closed-set': '规则的主人类别不在允许的集合里。',
  'autonomy-policy-id-not-canonical': '规则的编号不是合法编号。',
  'budget-policy-id-not-canonical': '预算规则的编号不是合法编号。'
});

var TRANSPORT_TEXT = Object.freeze({
  'home-node-unreachable': '连接不上本机节点',
  'home-node-transport-error': '与本机节点通信失败',
  timeout: '本机节点没有及时回应',
  'invalid-response': '本机节点返回了无法识别的回答'
});

/* ══════════════════════════════════════════════════════════════════
   小工具（全部是纯的、对坏输入不抛）
   ══════════════════════════════════════════════════════════════════ */
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function str(v) { return v == null ? null : String(v); }
function trimmed(v) {
  var s = str(v);
  if (s == null) return null;
  s = s.trim();
  return s === '' ? null : s;
}
function finiteNumber(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ══════════════════════════════════════════════════════════════════
   金额：minor ↔ 用户输入 / 展示
   ------------------------------------------------------------------
   ★ 三个方向的规矩不同，这是刻意的：
     · **读**（minor → 串）: 只格式化，坏输入返回 null（宁可不显示）；
     · **写**（串 → minor）: 严格解析，任何不确定一律 ok:false，
       因为"猜一个金额"会把用户的意图变成一个他没写过的数。
   ══════════════════════════════════════════════════════════════════ */
function currencyLabel(currency) {
  var c = str(currency);
  if (c == null) return '';
  return CURRENCY_LABEL_ZH[c] || CURRENCY_LABEL[c] || c;
}
function formatMinor(minor, currency) {
  var n = finiteNumber(minor);
  if (n == null) return null;
  var scale = Number(CURRENCY_SCALE[String(currency)]);
  if (!Number.isFinite(scale)) return null;
  if (!Number.isInteger(n) || n < 0) return null;
  var s = String(n);
  if (scale === 1) return s;
  if (scale === 100) {
    var whole = s.length > 2 ? s.slice(0, s.length - 2) : '0';
    var frac = ('00' + s.slice(-2)).slice(-2);
    return whole + '.' + frac;
  }
  return s;
}
function amountText(minor, currency) {
  var a = formatMinor(minor, currency);
  return a == null ? null : (a + ' ' + currencyLabel(currency));
}

/* 用户输入的额度 → minor。**不猜**：
     · 空串  → { ok:true, minor:null }  ← "这一档不设"，由调用方决定是
                省略字段（预算限额）还是拒绝（自主上限是必填的）；
     · 合法  → { ok:true, minor:'<整数串>' }（canonical 序列化形状）
     · 其它  → { ok:false, code } —— 一个字符都不接受 */
function parseMinorInput(text, currency) {
  var raw = str(text);
  if (raw == null) return { ok: true, minor: null };
  var s = raw.trim().replace(/[\s,，]/g, '');
  if (s === '') return { ok: true, minor: null };
  var scale = Number(CURRENCY_SCALE[String(currency)]);
  if (!Number.isFinite(scale)) return { ok: false, code: 'unknown-currency' };
  var digits = scale === 100 ? 2 : 0;
  var re = digits === 0 ? /^\d+$/ : new RegExp('^\\d+(\\.\\d{0,' + digits + '})?$');
  if (!re.test(s)) return { ok: false, code: digits === 0 ? 'not-a-whole-number' : 'not-an-amount' };
  var parts = s.split('.');
  var whole = parts[0];
  var frac = digits === 0 ? '' : (parts[1] || '');
  while (frac.length < digits) frac += '0';
  var minorText = digits === 0 ? whole : (whole + frac);
  /* 去掉前导零但保留至少一位，避免 "007" 这种形状进入 canonical。 */
  minorText = minorText.replace(/^0+(?=\d)/, '');
  var n = Number(minorText);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, code: 'not-an-amount' };
  if (n > Number.MAX_SAFE_INTEGER) return { ok: false, code: 'too-large' };
  return { ok: true, minor: String(minorText), value: n };
}

/* 正的十进制整数字符串（autonomy 的两个必填上限用的是它）。 */
function parsePositiveMinorInput(text, currency) {
  var r = parseMinorInput(text, currency);
  if (!r.ok) return r;
  if (r.minor == null) return { ok: false, code: 'required' };
  if (r.value <= 0) return { ok: false, code: 'must-be-positive' };
  return r;
}

/* ══════════════════════════════════════════════════════════════════
   owner（配置对象）
   ------------------------------------------------------------------
   ★ 谁是 owner 不是这一层发明的：canonical 里预算与自主政策都是按
     **buyer** 查的（economy-store.js:10521），而 intent 的 buyer 就是
     intent.agentId（:11749）—— 也就是角色。因此可选对象是角色，
     而"我"不是其中一项：把政策挂到 user:user 上对 Agent 购买无效，
     那会是一个假象。
   ══════════════════════════════════════════════════════════════════ */
function ownerOptions(activeConfigs, archivedConfigs) {
  var out = [];
  var seen = Object.create(null);
  var lists = [activeConfigs, archivedConfigs];
  for (var i = 0; i < lists.length; i++) {
    var list = Array.isArray(lists[i]) ? lists[i] : [];
    for (var j = 0; j < list.length; j++) {
      var cfg = list[j];
      if (!isObject(cfg)) continue;
      var id = trimmed(cfg.id);
      if (id == null || seen[id]) continue;
      seen[id] = true;
      out.push({
        id: id,
        label: trimmed(cfg.nickname) || trimmed(cfg.model) || id,
        avatar: trimmed(cfg.avatar) || trimmed(cfg.avatarUrl) || '',
        archived: i === 1
      });
    }
  }
  return out;
}
function findOwner(options, ownerId) {
  var id = trimmed(ownerId);
  if (id == null) return null;
  var list = Array.isArray(options) ? options : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && String(list[i].id) === String(id)) return list[i];
  }
  return null;
}
/* 选中项：显式的选择优先，否则第一位；一个都没有时 null。 */
function resolveOwner(options, preferredId) {
  var picked = findOwner(options, preferredId);
  if (picked) return picked;
  var list = Array.isArray(options) ? options : [];
  return list.length ? list[0] : null;
}

/* ══════════════════════════════════════════════════════════════════
   幂等键：一次用户手势 = 一个身份；重试**复用**同一个身份。
   ══════════════════════════════════════════════════════════════════ */
function newIdempotencyKey(seed) {
  var s = str(seed) || '';
  var rand = '';
  try { rand = Math.random().toString(36).slice(2, 10); } catch (e) { rand = '00000000'; }
  var t = '';
  try { t = Date.now().toString(36); } catch (e) { t = '0'; }
  var raw = (s + '-' + t + '-' + rand).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  return ('ui-' + raw).replace(/^-+|-+$/g, '').slice(0, 96);
}

/* ══════════════════════════════════════════════════════════════════
   请求构造：三个命令各一个，**白名单构造**
   ------------------------------------------------------------------
   ★ 三支都只写自己那个命令的 CONFIG_KEYS 成员，因此"顺手塞一个
     amountMinor 到政策里"或"塞一个 ownerId 到别处"在结构上不可能 ——
     不是"记得别传"，是没有那个位置。
   ★ 三支都不接受任何身份参数：调用者身份来自桌面传输（seam §6）。
   ══════════════════════════════════════════════════════════════════ */
function envelope(command, config, idempotencyKey) {
  var body = { command: command, config: config, idempotencyKey: str(idempotencyKey) };
  /* 自检：信封恰好三个键；命令在封闭词表里；config 的每个键都在该命令的
     白名单里，且 ownerId / currency 一定在。
     ★ 这是**本层**的失败，不是权威的失败：它意味着上面某处写错了，
     因此宁可 ok:false（不发请求），也不发一个会被权威拒的信封。 */
  var envelopeKeysOk = COMMANDS.indexOf(str(command)) >= 0 &&
    Object.keys(body).length === ENVELOPE_KEYS.length &&
    ENVELOPE_KEYS.every(function (k) { return Object.prototype.hasOwnProperty.call(body, k); });
  var allowed = CONFIG_KEYS[command] || [];
  /* ownerId 三支都必填（配置目标是必填的）；currency 只有两条政策/额度命令
     有这一位 —— 自主规则的白名单里根本没有它，因此不能在那里要求它。 */
  var requiresCurrency = allowed.indexOf('currency') >= 0;
  var configKeysOk = isObject(config) &&
    Object.keys(config).length > 0 &&
    Object.keys(config).every(function (k) { return allowed.indexOf(k) >= 0; }) &&
    Object.prototype.hasOwnProperty.call(config, 'ownerId') &&
    (!requiresCurrency || Object.prototype.hasOwnProperty.call(config, 'currency'));
  if (!envelopeKeysOk || !configKeysOk) return { ok: false, code: 'envelope-not-projected' };
  return { ok: true, body: body, keys: Object.keys(body), configKeys: Object.keys(config) };
}

/* ① 初始额度（一次性）。amountMinor 是**必填且必须为正**：
      canonical 受理 0，但那会把一次性事实用掉而一分钱也没发 ——
      一个不可逆的空操作不该由一个手滑的空输入造成。 */
function buildBootstrapRequest(ownerId, amountTextValue, idempotencyKey) {
  var owner = trimmed(ownerId);
  if (owner == null) return { ok: false, code: 'missing-owner' };
  var amount = parsePositiveMinorInput(amountTextValue, CURRENCY);
  if (!amount.ok) return { ok: false, code: amount.code, field: 'bootstrapAmount' };
  return envelope(COMMAND.BOOTSTRAP_CREDIT, {
    ownerId: owner, currency: CURRENCY, amountMinor: amount.minor
  }, idempotencyKey);
}

/* ② 预算规则。
   ★ `limits` 只包含**用户真的填了**的档位：留空 = 这一档不设（canonical 的
     "未设置 = 该档不启用"），而不是"填 0"。0 是一个有含义的值（一分钱都不许），
     因此它必须由用户显式写出来。
   ★ `ifRevision` 只在调用方给了权威 revision 时才带上：它让"两个窗口同时改"
     变成一次可被拒的冲突，而不是后写覆盖先写。 */
function buildBudgetRequest(ownerId, form, idempotencyKey) {
  var owner = trimmed(ownerId);
  if (owner == null) return { ok: false, code: 'missing-owner' };
  var f = isObject(form) ? form : {};
  var limits = {};
  for (var i = 0; i < LIMIT_FIELDS.length; i++) {
    var key = LIMIT_FIELDS[i].key;
    var parsed = parseMinorInput(f[key], CURRENCY);
    if (!parsed.ok) return { ok: false, code: parsed.code, field: key };
    if (parsed.minor != null) limits[key] = parsed.minor;
  }
  /* 冷却（毫秒）在高级区：它是一个时长，不是金额，因此单独解析。 */
  var cooldownRaw = trimmed(f[COOLDOWN_KEY]);
  if (cooldownRaw != null) {
    if (!/^\d+$/.test(cooldownRaw)) return { ok: false, code: 'not-a-duration', field: COOLDOWN_KEY };
    var cd = Number(cooldownRaw);
    if (!Number.isSafeInteger(cd)) return { ok: false, code: 'too-large', field: COOLDOWN_KEY };
    limits[COOLDOWN_KEY] = cd;
  }
  var config = { ownerId: owner, currency: CURRENCY, limits: limits };

  /* termEndsAt：canonical 要的是毫秒时间戳（非负 safe integer）。界面给的是
     日期输入（YYYY-MM-DD），因此这里把它变成**那一天结束**的时刻 ——
     用户说"到 3 号"，意思是 3 号还能用。 */
  var termRaw = trimmed(f.termEndsAt);
  if (termRaw != null) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(termRaw);
    if (!m) return { ok: false, code: 'not-a-date', field: 'termEndsAt' };
    var end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    if (!Number.isSafeInteger(end) || end < 0) return { ok: false, code: 'not-a-date', field: 'termEndsAt' };
    config.termEndsAt = end;
  }
  var levelRaw = trimmed(f.autonomyLevel);
  if (levelRaw != null) {
    if (AUTONOMY_LEVELS.indexOf(levelRaw) < 0) return { ok: false, code: 'not-in-closed-set', field: 'autonomyLevel' };
    config.autonomyLevel = levelRaw;
  }
  if (f.ifRevision != null && f.ifRevision !== '') {
    var rev = Number(f.ifRevision);
    if (!Number.isSafeInteger(rev) || rev < 0) return { ok: false, code: 'not-canonical', field: 'ifRevision' };
    config.ifRevision = rev;
  }
  return envelope(COMMAND.PUT_BUDGET_POLICY, config, idempotencyKey);
}

/* ③ 自主规则。
   ★ 两个上限是契约的**必填**项（economy-contract.js:4237/4240），因此这里
     空着就 ok:false —— 不发请求，也不替用户填一个看起来合理的数。
   ★ `allowedProductKinds` / `allowedSettlementTypes` 一个都不选时**省略字段**：
     契约拒绝空数组（:4265/:4274），而省略的 canonical 含义恰好就是"空集 =
     不自主买任何东西"（:4299-4302）。把空选集写成 [] 会被拒，写成"全选"
     则是把用户的"一个都不要"变成"全都要"—— 两个都不能做。 */
function buildAutonomyRequest(ownerId, form, idempotencyKey) {
  var owner = trimmed(ownerId);
  if (owner == null) return { ok: false, code: 'missing-owner' };
  var f = isObject(form) ? form : {};
  var per = parsePositiveMinorInput(f.perPurchaseLimitMinor, CURRENCY);
  if (!per.ok) return { ok: false, code: per.code, field: 'perPurchaseLimitMinor' };
  var daily = parsePositiveMinorInput(f.dailyAutonomousLimitMinor, CURRENCY);
  if (!daily.ok) return { ok: false, code: daily.code, field: 'dailyAutonomousLimitMinor' };
  var config = {
    ownerId: owner,
    enabled: f.enabled === true,
    perPurchaseLimitMinor: per.minor,
    dailyAutonomousLimitMinor: daily.minor
  };
  var above = parseMinorInput(f.approvalAboveMinor, CURRENCY);
  if (!above.ok) return { ok: false, code: above.code, field: 'approvalAboveMinor' };
  if (above.minor != null) config.approvalAboveMinor = above.minor;

  var kinds = pickFromClosedSet(f.allowedProductKinds, PRODUCT_KINDS);
  if (kinds == null) return { ok: false, code: 'not-in-closed-set', field: 'allowedProductKinds' };
  if (kinds.length) config.allowedProductKinds = kinds;
  var settlements = pickFromClosedSet(f.allowedSettlementTypes, FULFILLMENTS);
  if (settlements == null) return { ok: false, code: 'not-in-closed-set', field: 'allowedSettlementTypes' };
  if (settlements.length) config.allowedSettlementTypes = settlements;
  /* ★ 两个布尔位**总是**发出去（缺席按 false 算）。理由：政策的写入是一次
     **全量替换**，而"缺席"与"false"在服务端归结为同一个值 —— 但如果界面上
     用户确实取消了勾选，请求体里写出来的 false 才是"这一次我要的就是它"。
     让请求体逐字等于将要生效的政策，比让读者去服务端源码里推导缺席的含义好。 */
  config.allowGift = f.allowGift === true;
  if (f.ifRevision != null && f.ifRevision !== '') {
    var rev = Number(f.ifRevision);
    if (!Number.isSafeInteger(rev) || rev < 0) return { ok: false, code: 'not-canonical', field: 'ifRevision' };
    config.ifRevision = rev;
  }
  return envelope(COMMAND.PUT_AUTONOMY_POLICY, config, idempotencyKey);
}

/* 从闭集里挑：返回去重后的**闭集顺序**数组；出现闭集外的成员时返回 null
   （不静默丢弃 —— 丢弃会把一个坏输入变成一次成功的、内容不同的写入）。 */
function pickFromClosedSet(value, closedSet) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  var out = [];
  for (var i = 0; i < value.length; i++) {
    var v = str(value[i]);
    if (v == null || closedSet.indexOf(v) < 0) return null;
    if (out.indexOf(v) < 0) out.push(v);
  }
  /* 按闭集顺序稳定排序：同一组选择只有一个请求体，因此幂等指纹稳定。 */
  return closedSet.filter(function (k) { return out.indexOf(k) >= 0; });
}

/* ══════════════════════════════════════════════════════════════════
   回答归类
   ------------------------------------------------------------------
   ★ §3 的三条逐字在这里成立：
     · 成功文案只有"规则已保存"，**没有一句**说"现在可以买了"；
     · BOOTSTRAP 的 replayed 与 minted 是两个不同的结论（P22-14 自己把
       initialCreditMintedNow 与 initialCreditBootstrapped 分成两位）；
     · 未知的拒绝码保留原词，不编句子。
   ══════════════════════════════════════════════════════════════════ */
function refusalText(code, errors) {
  /* ① store 的具名 validation 词最准确，优先。 */
  var list = Array.isArray(errors) ? errors : [];
  for (var i = 0; i < list.length; i++) {
    var t = ERROR_TOKEN_TEXT[str(list[i])];
    if (t) return { text: t, from: 'error-token', token: str(list[i]) };
  }
  /* ② 拒绝码。 */
  var byCode = REFUSAL_TEXT[str(code)];
  if (byCode) return { text: byCode, from: 'reason-code', token: str(code) };
  var byTransport = TRANSPORT_TEXT[str(code)];
  if (byTransport) return { text: byTransport, from: 'transport', token: str(code) };
  /* ③ 未登记：**不编**。 */
  return { text: null, from: 'unregistered', token: str(code) };
}

function classifyConfigurationResponse(res) {
  if (!isObject(res)) {
    return { outcome: 'transport-error', ok: false, text: '没有收到本机节点的回答', detail: null, command: null };
  }
  if (res.ok !== true) {
    var code = str(res.error) || str(res.reasonCode);
    var said = refusalText(code, res.errors);
    return {
      outcome: 'refused',
      ok: false,
      command: str(res.command),
      reasonCode: str(res.reasonCode) || code,
      downstreamReasonCode: str(res.downstreamReasonCode),
      status: finiteNumber(res.status),
      text: said.text || '这次改动没有被接受',
      detail: said.text == null ? (said.token ? ('原词：' + said.token) : null) : null,
      unregisteredCode: said.text == null ? said.token : null,
      reachedStore: res.reachedStore === true,
      errors: Array.isArray(res.errors) ? res.errors.slice() : []
    };
  }
  var command = str(res.command);
  var commandKnown = command != null && COMMANDS.indexOf(command) >= 0;
  if (res.configuredAnything !== true) {
    return {
      outcome: 'unexpected', ok: false, command: command, reasonCode: null,
      text: '本机节点回了成功，但没有说改了什么 —— 因此这里不把它当作已保存。',
      detail: null, configuredAnything: false
    };
  }
  if (!commandKnown) {
    return {
      outcome: 'unexpected', ok: false, command: command, reasonCode: null,
      text: '本机节点回了成功，但回执里的命令不是这一页能发出的三个之一。',
      detail: null, configuredAnything: true
    };
  }
  if (command === COMMAND.BOOTSTRAP_CREDIT) {
    /* ★ 两位必须分开读（P22-14 的教训）：这一次调用有没有真的铸出钱，
       与这位角色的初始额度在不在，是两个不同的问题。 */
    if (res.initialCreditBootstrapped !== true) {
      return {
        outcome: 'unexpected', ok: false, command: command, reasonCode: null,
        text: '本机节点回了成功，但没有确认初始额度已经设置。', detail: null
      };
    }
    var mintedNow = res.initialCreditMintedNow === true;
    return {
      outcome: mintedNow ? 'configured' : 'replayed',
      ok: true,
      command: command,
      reasonCode: null,
      text: mintedNow ? COPY.walletJustSet : COPY.walletAlreadySet,
      detail: null,
      mintedNow: mintedNow,
      alreadyBootstrappedBeforeThisRequest: res.alreadyBootstrappedBeforeThisRequest === true,
      walletId: str(res.walletId),
      policyRevision: null
    };
  }
  var replayed = res.replayed === true;
  var wroteBudget = command === COMMAND.PUT_BUDGET_POLICY;
  var wroteAutonomy = command === COMMAND.PUT_AUTONOMY_POLICY;
  var wrote = wroteBudget ? res.budgetPolicyWritten === true : res.autonomyPolicyWritten === true;
  if (!wrote) {
    return {
      outcome: 'unexpected', ok: false, command: command, reasonCode: null,
      text: '本机节点回了成功，但没有确认规则写进去了。', detail: null
    };
  }
  return {
    outcome: replayed ? 'replayed' : 'configured',
    ok: true,
    command: command,
    reasonCode: null,
    text: replayed
      ? (wroteBudget ? '预算规则与上一次完全相同，因此没有重复写入。' : '自主购买规则与上一次完全相同，因此没有重复写入。')
      : (wroteBudget ? COPY.budgetSaved : COPY.autonomySaved),
    detail: null,
    ledgerMutation: res.ledgerMutation === true,
    purchaseMutation: res.purchaseMutation === true,
    approvalMutation: res.approvalMutation === true,
    policyId: str(res.policyId),
    policyRevision: finiteNumber(res.policyRevision),
    replayed: replayed
  };
}

/* ══════════════════════════════════════════════════════════════════
   配置面开不开（§7）
   ------------------------------------------------------------------
   ★ 判定**不在这里**：这是 /security 的 economyPolicy.configuration
     这两个字段的只读搬运。读不到就回答 null（= 不知道），而不是猜成
     false —— "不知道"与"关着"在界面上是两件事（与 P22-15 的
     decisionGate 逐字同款）。
   ★ canConfigure 还要看**命令名单**：seam 关着时名单是空的，因此即使
     某个字段被读成了 true，没有名单也不会有按钮。 */
function configurationGate(security) {
  var econ = isObject(security) ? security.economyPolicy : null;
  var seam = isObject(econ) ? econ.configuration : null;
  if (!isObject(seam)) return null;
  return {
    open: seam.open === true,
    implemented: seam.implemented === true,
    commands: Array.isArray(seam.configurationCommandsExposed)
      ? seam.configurationCommandsExposed.map(function (c) { return String(c); }) : []
  };
}
function canConfigure(gate, command) {
  if (!gate || gate.open !== true) return false;
  if (COMMANDS.indexOf(str(command)) < 0) return false;
  return gate.commands.indexOf(String(command)) >= 0;
}

/* ══════════════════════════════════════════════════════════════════
   读面 → 视图模型
   ══════════════════════════════════════════════════════════════════ */

/* 钱包。
   ★ 这张卡要回答的是"初始额度发过了没有"。读面给的是**钱包在不在**，
     而生产里唯一会创建 (owner, IB_CREDIT) 钱包的路径就是
     bootstrapInitialCredit 自己（openWallet 全仓只有一个调用方，
     economy-store.js:3382）—— 这条耦合由测试钉住（ui 测试里有一条
     逐字读 store 源码的断言），因此它不是"相信"，是一个被断言的事实。 */
function buildWalletView(walletResult) {
  if (!isObject(walletResult)) {
    return { state: 'unknown', code: 'no-response', text: COPY.readFailed };
  }
  if (walletResult.ok !== true) {
    var code = str(walletResult.error) || 'read-failed';
    if (code === 'wallet-not-found') return { state: 'absent', code: code };
    var said = TRANSPORT_TEXT[code];
    return { state: 'unknown', code: code, text: said || '读不到钱包', detail: said ? null : code };
  }
  var w = walletResult.wallet;
  if (!isObject(w)) return { state: 'malformed', code: 'wallet-malformed' };
  if (str(w.currency) !== CURRENCY) {
    return { state: 'malformed', code: 'wallet-currency-not-ib-credit', currency: str(w.currency) };
  }
  var ready = w.state === 'READY' && w.balanceKnown === true;
  return {
    state: 'present',
    code: null,
    walletId: str(w.walletId),
    walletState: str(w.state),
    balanceKnown: w.balanceKnown === true,
    ready: ready,
    currency: str(w.currency),
    ledgerMinor: w.ledgerBalanceMinor,
    reservedMinor: w.reservedBalanceMinor,
    availableMinor: ready ? w.availableBalanceMinor : null,
    revision: finiteNumber(w.revision)
  };
}

/* 预算规则。
   ★ policy 可能不存在（404 budget-policy-not-found）—— 那是"未配置"
     这个真实状态，不是读失败。canonical 的默认是 REQUIRE_APPROVAL，
     因此界面上说的是"任何支出都需要你确认"，而不是"禁止"。 */
function buildBudgetView(policyResult) {
  if (!isObject(policyResult)) return { state: 'unknown', code: 'no-response' };
  if (policyResult.ok !== true) {
    var code = str(policyResult.error) || 'read-failed';
    if (code === 'budget-policy-not-found') return { state: 'absent', code: code };
    return { state: 'unknown', code: code, text: TRANSPORT_TEXT[code] || '读不到预算规则', detail: TRANSPORT_TEXT[code] ? null : code };
  }
  var p = policyResult.policy;
  if (!isObject(p)) return { state: 'malformed', code: 'policy-malformed' };
  return {
    state: 'present',
    code: null,
    policyId: str(p.policyId),
    currency: str(p.currency),
    status: str(p.status),
    limits: isObject(p.limits) ? p.limits : {},
    termEndsAt: finiteNumber(p.termEndsAt),
    autonomyLevel: str(p.autonomyLevel),
    revision: finiteNumber(p.revision)
  };
}

/* 自主规则。 */
function buildAutonomyView(policyResult) {
  if (!isObject(policyResult)) return { state: 'unknown', code: 'no-response' };
  if (policyResult.ok !== true) {
    var code = str(policyResult.error) || 'read-failed';
    if (code === 'autonomy-policy-not-found') return { state: 'absent', code: code };
    return { state: 'unknown', code: code, text: TRANSPORT_TEXT[code] || '读不到自主规则', detail: TRANSPORT_TEXT[code] ? null : code };
  }
  var p = policyResult.policy;
  if (!isObject(p)) return { state: 'malformed', code: 'policy-malformed' };
  return {
    state: 'present',
    code: null,
    policyId: str(p.policyId),
    enabled: p.enabled === true,
    perPurchaseLimitMinor: p.perPurchaseLimitMinor == null ? null : str(p.perPurchaseLimitMinor),
    dailyAutonomousLimitMinor: p.dailyAutonomousLimitMinor == null ? null : str(p.dailyAutonomousLimitMinor),
    approvalAboveMinor: p.approvalAboveMinor == null ? null : str(p.approvalAboveMinor),
    allowedProductKinds: Array.isArray(p.allowedProductKinds) ? p.allowedProductKinds.slice() : [],
    allowedSettlementTypes: Array.isArray(p.allowedSettlementTypes) ? p.allowedSettlementTypes.slice() : [],
    allowGift: p.allowGift === true,
    usable: p.usable !== false,
    problems: Array.isArray(p.problems) ? p.problems.slice() : [],
    revision: finiteNumber(p.revision),
    grantsBudget: false,
    replacesBudget: false,
    isADecisionLayer: false
  };
}

/* 预算快照：只**读**已用与上限两个数，不读 decision。
   ★ 决策（ALLOW / DENY / REQUIRE_APPROVAL）刻意不进视图模型 ——
     一旦它进来，界面上迟早会出现一句"现在可以买"。 */
function buildMeterView(limits, snapshotResult) {
  var limitMinor = null;
  if (isObject(limits)) {
    var dl = finiteNumber(limits.dailyMinor);
    if (dl != null) limitMinor = dl;
  }
  var out = {
    known: false,
    limitMinor: limitMinor,
    usedMinor: null,
    usedText: null,
    limitText: limitMinor == null ? null : amountText(limitMinor, CURRENCY),
    ratio: null,
    ratioCapped: null,
    over: false,
    reason: null
  };
  if (limitMinor == null || limitMinor <= 0) { out.reason = 'no-daily-limit'; return out; }
  if (!isObject(snapshotResult) || snapshotResult.ok !== true) { out.reason = 'no-snapshot'; return out; }
  var snapshot = snapshotResult.snapshot;
  if (!isObject(snapshot)) { out.reason = 'no-snapshot'; return out; }
  var used = finiteNumber(snapshot.spentTodayMinor);
  if (used == null || used < 0) { out.reason = 'unknown-usage'; return out; }
  out.known = true;
  out.usedMinor = used;
  out.usedText = amountText(used, CURRENCY);
  out.ratio = used / limitMinor;
  out.ratioCapped = Math.max(0, Math.min(1, out.ratio));
  out.over = used > limitMinor;
  out.reason = null;
  return out;
}

/* 表单初值：**来自权威读面**，因此"打开页面时看到的就是现在生效的"。
   ★ 这里没有默认值兜底：读不到就空着，空着比一个猜的数诚实。 */
function budgetFormFromView(view) {
  var form = {};
  if (!isObject(view) || view.state !== 'present') return form;
  var limits = isObject(view.limits) ? view.limits : {};
  for (var i = 0; i < LIMIT_FIELDS.length; i++) {
    var k = LIMIT_FIELDS[i].key;
    var v = limits[k];
    form[k] = v == null ? '' : (formatMinor(v, CURRENCY) || '');
  }
  form[COOLDOWN_KEY] = limits[COOLDOWN_KEY] == null ? '' : String(limits[COOLDOWN_KEY]);
  form.termEndsAt = view.termEndsAt == null ? '' : dateInputOf(view.termEndsAt);
  form.autonomyLevel = view.autonomyLevel == null ? '' : view.autonomyLevel;
  form.ifRevision = view.revision == null ? '' : String(view.revision);
  return form;
}
function autonomyFormFromView(view) {
  var form = {};
  if (!isObject(view) || view.state !== 'present') return form;
  form.enabled = view.enabled === true;
  form.perPurchaseLimitMinor = view.perPurchaseLimitMinor == null ? '' : (formatMinor(view.perPurchaseLimitMinor, CURRENCY) || '');
  form.dailyAutonomousLimitMinor = view.dailyAutonomousLimitMinor == null ? '' : (formatMinor(view.dailyAutonomousLimitMinor, CURRENCY) || '');
  form.approvalAboveMinor = view.approvalAboveMinor == null ? '' : (formatMinor(view.approvalAboveMinor, CURRENCY) || '');
  form.allowedProductKinds = view.allowedProductKinds.slice();
  form.allowedSettlementTypes = view.allowedSettlementTypes.slice();
  form.allowGift = view.allowGift === true;
  form.ifRevision = view.revision == null ? '' : String(view.revision);
  return form;
}

/* 毫秒 → <input type="date"> 的 YYYY-MM-DD（UTC，与 canonical 的 UTC 一致）。 */
function dateInputOf(atMs) {
  var n = finiteNumber(atMs);
  if (n == null || n < 0) return '';
  var d = new Date(n);
  if (isNaN(d.getTime())) return '';
  function p2(x) { return (x < 10 ? '0' : '') + x; }
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
}
function dateTextOf(atMs, nowMs) {
  var iso = dateInputOf(atMs);
  if (!iso) return null;
  var n = finiteNumber(atMs);
  var now = finiteNumber(nowMs);
  if (n != null && now != null && n <= now) return iso + '（已到期）';
  return iso;
}

/* ══════════════════════════════════════════════════════════════════
   页面状态：把五条读面拼成一个"这一页现在长什么样"的模型。
   ------------------------------------------------------------------
   ★ 它只做搬运与归类，不做任何判断：任何一条读面拿不到就进 degraded
     并且**照样显示**能显示的那几条（§7：不给假按钮，也不因为一条读
     不到就把整页变成一句话）。
   ══════════════════════════════════════════════════════════════════ */
function buildPageView(input) {
  var i = isObject(input) ? input : {};
  var securityUnreadable = i.security == null || i.security.ok !== true;
  var gate = configurationGate(i.security);
  var wallet = buildWalletView(i.wallet);
  var budget = buildBudgetView(i.policy);
  var autonomy = buildAutonomyView(i.autonomyPolicy);
  var meter = buildMeterView(budget.state === 'present' ? budget.limits : null, i.budgetSnapshot);
  var configurable = gate ? canConfigure(gate, COMMAND.BOOTSTRAP_CREDIT) : false;
  return {
    gate: gate,
    gateKnown: gate != null,
    securityUnreadable: securityUnreadable,
    /* 三个命令各自能不能发（名单来自 /security，不是这一页决定的）。 */
    canBootstrap: gate ? canConfigure(gate, COMMAND.BOOTSTRAP_CREDIT) : false,
    canPutBudget: gate ? canConfigure(gate, COMMAND.PUT_BUDGET_POLICY) : false,
    canPutAutonomy: gate ? canConfigure(gate, COMMAND.PUT_AUTONOMY_POLICY) : false,
    configurable: configurable,
    wallet: wallet,
    budget: budget,
    autonomy: autonomy,
    meter: meter,
    budgetForm: budgetFormFromView(budget),
    autonomyForm: autonomyFormFromView(autonomy)
  };
}

NS.economyConfigurationCore = Object.freeze({
  version: CORE_VERSION,
  ID: ID,
  WRITE_PATH: WRITE_PATH,
  READS: READS,
  COMMAND: COMMAND,
  COMMANDS: COMMANDS,
  ENVELOPE_KEYS: ENVELOPE_KEYS,
  CONFIG_KEYS: CONFIG_KEYS,
  CURRENCY: CURRENCY,
  CURRENCY_SCALE: CURRENCY_SCALE,
  CURRENCY_LABEL: CURRENCY_LABEL,
  LIMIT_KEYS: LIMIT_KEYS,
  LIMIT_FIELDS: LIMIT_FIELDS,
  COOLDOWN_KEY: COOLDOWN_KEY,
  AUTONOMY_LEVEL: AUTONOMY_LEVEL,
  AUTONOMY_LEVELS: AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_LABEL: AUTONOMY_LEVEL_LABEL,
  PRODUCT_KINDS: PRODUCT_KINDS,
  PRODUCT_KIND_LABEL: PRODUCT_KIND_LABEL,
  FULFILLMENTS: FULFILLMENTS,
  FULFILLMENT_LABEL: FULFILLMENT_LABEL,
  SECTION: SECTION,
  SECTIONS: SECTIONS,
  COPY: COPY,
  REFUSAL_TEXT: REFUSAL_TEXT,
  ERROR_TOKEN_TEXT: ERROR_TOKEN_TEXT,
  TRANSPORT_TEXT: TRANSPORT_TEXT,

  isObject: isObject,
  str: str,
  trimmed: trimmed,
  finiteNumber: finiteNumber,
  escapeHtml: escapeHtml,
  currencyLabel: currencyLabel,
  formatMinor: formatMinor,
  amountText: amountText,
  parseMinorInput: parseMinorInput,
  parsePositiveMinorInput: parsePositiveMinorInput,
  shapeFailureText: shapeFailureText,
  SHAPE_FIELD_LABEL: SHAPE_FIELD_LABEL,

  ownerOptions: ownerOptions,
  findOwner: findOwner,
  resolveOwner: resolveOwner,
  newIdempotencyKey: newIdempotencyKey,

  buildBootstrapRequest: buildBootstrapRequest,
  buildBudgetRequest: buildBudgetRequest,
  buildAutonomyRequest: buildAutonomyRequest,
  classifyConfigurationResponse: classifyConfigurationResponse,
  refusalText: refusalText,

  configurationGate: configurationGate,
  canConfigure: canConfigure,
  buildWalletView: buildWalletView,
  buildBudgetView: buildBudgetView,
  buildAutonomyView: buildAutonomyView,
  buildMeterView: buildMeterView,
  budgetFormFromView: budgetFormFromView,
  autonomyFormFromView: autonomyFormFromView,
  dateInputOf: dateInputOf,
  dateTextOf: dateTextOf,
  buildPageView: buildPageView
});
})(typeof window !== 'undefined' ? (window.IB || (window.IB = {})) : (typeof globalThis !== 'undefined' ? (globalThis.IB || (globalThis.IB = {})) : {}));
