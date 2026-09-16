'use strict';
/* ====================================================================
   IB Home Node · Economy Configuration Seam（P22-14 · fresh install 的配置入口）
   --------------------------------------------------------------------
         authenticated desktop configuration caller
                          ↓  POST /internal/economy/configuration
              Economy Configuration Seam              ← 本文件
                          ↓
        ┌─────────────────┼──────────────────────────┐
   ① bootstrapInitialCredit  ② putBudgetPolicy  ③ putAutonomyPolicy
   （**一次性**初始额度）      （版本化更新）      （版本化更新）
                          ↓
                  P22-2 / P22-4 / P22-7 既有权威链

   ── §1 只读审计：这一阶段要补的到底是哪一段 ────────────────────────
   审计结论（全部来自读代码，没有一条来自提示词假设）：

     ① **可复用的 transport 已经存在，而且是同一个**：Home Node 的 HTTP
        seam（services/home-node/http.js）。它已经有 loopback 限制、桌面
        凭据（X-IB-Home-Token / Bearer，恒定时间比较）、`/internal/` 前缀
        的桌面面归类、请求/错误信封、有界 body。
        ⇒ 本文件**不新造** Admin RPC framework、不新造通用 Economy mutation
          API、不新造 `execute(method, args)`（§1 逐字禁止）。它只在这条
          既有 transport 上加**一条**窄路径。

     ② **缺的不是"能不能配置"，而是"能不能不改代码、不碰 SQLite 就把一个
        fresh install 配到可运行"**。逐条审计三个动词在生产代码里的调用方：

          mintForSystem      生产调用方 = 0（只在 tests/ 与 tests/fixtures/）
          putBudgetPolicy    生产调用方 = 0（同上）
          putAutonomyPolicy  生产调用方 = 0（同上）

        这三个数字与 P22-12C 对 decideApproval / resume* 的结论同形：**运行时
        有、生产路径没有**。于是默认部署（AUTONOMY_DEFAULT_WHEN_NO_POLICY =
        REQUIRE_APPROVAL）下，一个全新的库既没有余额、也没有预算政策、也没有
        自主政策，而把它配起来需要人工打开 SQLite —— 本文件补的就是这一段。

     ③ **它必须与 P22-13 的 Approval Decision Seam 分权**（§8）。两条路径
        都是"用户在做一件事"，但它们是**两种权威**：
          · 决定面 = 用户对**一条具体的等待中 intent** 点头/摇头；
          · 配置面 = 用户**预设**这台节点的钱与规则。
        把两者合成一个"万能 user command endpoint"会让"允许 Agent 自主花
        多少钱"与"批准这一笔"在审计里变成同一件事 —— 那是 §2 明令禁止的
        （Bootstrap 是配置权，不是 Agent 权 / 购买权 / 支付权）。
        ⇒ 两条路径各有自己的 path、自己的 consumer 视角、自己的词表，
          而且**互不接受**对方的信封（见 REFUSAL.UNKNOWN_COMMAND 与下面
          §3 的信封键白名单：配置信封里根本没有 approvalId/decision，
          决定信封里也没有 command/config）。

   ── §2/§3 为什么**不能**把 mintForSystem 原样暴露 ────────────────────
   本文件拿到的是**一个恰好三个键的对象**：
     { bootstrapInitialCredit, putBudgetPolicy, putAutonomyPolicy }
   因此 `mintForSystem` / `burnForSystem` / `commitLedgerTransaction` /
   `openWallet` / `reserveFunds` / `settlePurchase` / `grantInventory` /
   `transferBetweenWallets` / `decideApproval` / `resumeAgentPurchaseIntent`
   在这段代码里**一个都不存在** —— 不是"被过滤"，是**没有那个成员名**。
   同样地，本文件里没有 `store[...]`、没有 `handler[action]`、没有
   `executeEconomyAdminAction(...)`：命令词表是**封闭**的（恰好三个），
   未知命令一律 fail closed。

   ── §6 owner identity ───────────────────────────────────────────────
   配置**谁**的钱包 / 预算 / 自主策略，必须由调用方说明（那是"配置目标"），
   但**调用者是谁**不由调用方说明：它由已认证的桌面传输 + loopback 决定。
   因此：
     · 信封里允许出现 `config.ownerId` —— 它唯一的含义是"这次配置的目标"；
     · 信封里**禁止**出现任何身份键（actor / caller / consumer /
       consumerId / role / authority / admin / system / approved / party /
       decidedBy / capability）—— 逐名拒绝，且**不触碰** store；
     · owner 必须存在于 canonical identity registry：这条不是本文件实现的，
       而是 `deps.ownerExists`（装配层注入的注册表谓词）在 store 里的既有
       闸门（`owner-not-found`），本文件**不复制**它、也不绕过它。

   ── §11 三个命令**不是**同一类 ──────────────────────────────────────
     · BOOTSTRAP_CREDIT    —— 一次性（one-shot）。同一个 owner + 币种的第二次
       请求**拒绝**（除非逐字重放），而那个"发过了"是一个**持久**事实
       （economy_meta 行），因此重启之后仍然拒绝。它由 store 的
       bootstrapInitialCredit 持有 —— 本文件不实现那条规则。
     · PUT_BUDGET_POLICY   —— 版本化更新。可以改很多次，revision 累加，
       `ifRevision` 是可选的乐观并发，幂等键走 POLICY scope。
     · PUT_AUTONOMY_POLICY —— 版本化更新，同款，幂等键走 AUTONOMY_POLICY。
   ⇒ 把三个都做成一次性是错的；把它们的"一次性/可更新"写在这里也是错的
     （那是 store 契约的事）。本文件只**透传**它们的答案。

   ── 时间与顺序 ──────────────────────────────────────────────────────
   凭据判定**在** body 解析之前完成（与 P22-11 / P22-13 逐字同源）。
   ==================================================================== */

const crypto = require('node:crypto');

/* 唯一一次 require：那份契约（币种 / 幂等键 / 政策校验的规范全部出自它，
   本文件不复制任何一条经济规则）。 */
const C = require('./economy-contract.js');

/* ══ 路径 ═════════════════════════════════════════════════════════════
   ★ 它刻意**不在** /economy/ 前缀下：/economy/* 上的每一件事都是只读
   （P22-2 起逐名断言），而这是一条**写**路径。把它放进 /economy/ 会让
   "POST /economy/* 一律 405 economy-is-read-only"变成半真。
   ★ 它**不是** /internal/economy/approval-decision：那是用户对一条具体
   intent 的决定，这是用户对这台节点的**配置**；两条路径不共用凭据之外的
   任何东西（见 describe().differsFromTheApprovalDecisionSeam）。 */
const CONFIGURATION_PATH = '/internal/economy/configuration';

/* ══ §7 · 命令词表（封闭集，恰好三个）═══════════════════════════════
   ★ 这里**没有** BUY / SETTLE / RESERVE / GRANT_INVENTORY / APPROVE /
   REJECT / REFUND / EXCHANGE / PROVIDER_TOPUP / REAL_PAYMENT /
   RAW_LEDGER_WRITE，而且它们不是"被过滤掉的"：它们在这份词表里不存在，
   因此只能落到 UNKNOWN_COMMAND（fail closed）。
   ★ 三个词的**顺序**就是它们在 §2 里的顺序，也是它们各自的语义类别：
   一次性（初始额度）、版本化（预算）、版本化（自主）。 */
const COMMAND = Object.freeze({
  BOOTSTRAP_CREDIT: 'BOOTSTRAP_CREDIT',
  PUT_BUDGET_POLICY: 'PUT_BUDGET_POLICY',
  PUT_AUTONOMY_POLICY: 'PUT_AUTONOMY_POLICY'
});
const COMMAND_LIST = Object.freeze([
  COMMAND.BOOTSTRAP_CREDIT, COMMAND.PUT_BUDGET_POLICY, COMMAND.PUT_AUTONOMY_POLICY
]);

/* ══ §7 · 信封（恰好三个顶层键）═════════════════════════════════════
   command        —— 上面那三个词之一
   config         —— 该命令**自己的** canonical 用户可配置字段（见下）
   idempotencyKey —— 这一次配置动作的 canonical 幂等身份
   ★ 只有这三个。amount / price / owner 放在 `config` 里是因为它们**属于
   某个具体命令**（初始额度有 amount，政策没有）；顶层多一个键即拒。 */
const ENVELOPE_KEYS = Object.freeze(['command', 'config', 'idempotencyKey']);

/* ── 每个命令的 config 键白名单 ──────────────────────────────────────
   ★ 这些**全部**是 canonical 用户可配置字段，逐字来自 store 的三个入口
   签名。**没有** currentBalance / spentToday / allow / decision /
   approval / price / ledger state —— 那些由 authority 计算，调用方连
   "填一个值让权威读它"的机会都没有（§4）。
   ★ BOOTSTRAP_CREDIT 的 config 恰好三个键：ownerId（配置目标）、currency
   （只允许 IB_CREDIT）、amountMinor（minor unit）。**没有**
   debitAccountId / creditAccountId / transactionId / ledgerEntryId /
   systemInitiated —— 因此"指定任意账户"、"伪造交易 id"、"写 raw entry"
   在这条路径上**没有输入位**。 */
const CONFIG_KEYS = Object.freeze({
  BOOTSTRAP_CREDIT: Object.freeze(['ownerId', 'currency', 'amountMinor']),
  PUT_BUDGET_POLICY: Object.freeze([
    'ownerId', 'currency', 'limits', 'termEndsAt', 'autonomyLevel', 'ifRevision'
  ]),
  PUT_AUTONOMY_POLICY: Object.freeze([
    'ownerId', 'enabled', 'perPurchaseLimitMinor', 'dailyAutonomousLimitMinor',
    'approvalAboveMinor', 'allowedProductKinds', 'allowedSettlementTypes',
    'allowGift', 'ifRevision'
  ])
});

/* ══ §6 · payload 里**禁止**出现的身份键（逐字来自本阶段要求）═══════
   ★ 这些键在**顶层与 config 里都**被逐名拒绝。它们全都是"调用方在自称
   自己是谁 / 自己有什么权"的形态；而调用者的权威只来自已认证的桌面传输。
   ★ `ownerId` **不在**这份名单里，而且这个例外是有理由的：它是**配置目标**，
   不是调用者身份。它无法提权 —— 它能做的只是"让权威去校验另一个 owner 的
   存在性"，而 unknown owner 在 store 里被拒（owner-not-found）。 */
const FORBIDDEN_IDENTITY_KEYS = Object.freeze([
  'actor', 'caller', 'callerId', 'consumer', 'consumerId', 'capability',
  'role', 'authority', 'admin', 'isAdmin', 'system', 'systemInitiated',
  'approved', 'autoAllow', 'party', 'decidedBy', 'userId', 'agentId',
  'sessionId', 'token', 'desktopToken'
]);

/* ══ 拒绝码（封闭集）════════════════════════════════════════════════ */
const REFUSAL = Object.freeze({
  /* 装配面 */
  SEAM_NOT_CONFIGURED: 'ECONOMY_CONFIGURATION_NOT_CONFIGURED',
  CREDENTIAL_NOT_CONFIGURED: 'ECONOMY_CONFIGURATION_DESKTOP_TOKEN_NOT_CONFIGURED',
  /* 传输面 */
  NOT_LOOPBACK: 'ECONOMY_CONFIGURATION_NOT_LOOPBACK',
  MISSING_CONFIGURATION_CREDENTIAL: 'ECONOMY_CONFIGURATION_MISSING_DESKTOP_CREDENTIAL',
  WRONG_CONFIGURATION_CREDENTIAL: 'ECONOMY_CONFIGURATION_WRONG_DESKTOP_CREDENTIAL',
  /* 信封面 */
  MALFORMED_ENVELOPE: 'ECONOMY_CONFIGURATION_MALFORMED_ENVELOPE',
  NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT: 'ECONOMY_CONFIGURATION_NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT',
  UNEXPECTED_ENVELOPE_KEYS: 'ECONOMY_CONFIGURATION_UNEXPECTED_ENVELOPE_KEYS',
  MISSING_COMMAND: 'ECONOMY_CONFIGURATION_MISSING_COMMAND',
  UNKNOWN_COMMAND: 'ECONOMY_CONFIGURATION_UNKNOWN_COMMAND',
  MISSING_CONFIG: 'ECONOMY_CONFIGURATION_MISSING_CONFIG',
  MALFORMED_CONFIG: 'ECONOMY_CONFIGURATION_MALFORMED_CONFIG',
  UNEXPECTED_CONFIG_KEYS: 'ECONOMY_CONFIGURATION_UNEXPECTED_CONFIG_KEYS',
  MISSING_OWNER_ID: 'ECONOMY_CONFIGURATION_MISSING_OWNER_ID',
  MISSING_IDEMPOTENCY_KEY: 'ECONOMY_CONFIGURATION_MISSING_IDEMPOTENCY_KEY',
  REQUEST_ID_CONFLICT: 'ECONOMY_CONFIGURATION_REQUEST_ID_CONFLICT',
  /* ★ §3 逐字："只允许 IB_CREDIT"。
     ★ 为什么这一条必须**在配置面**上，而不是"store 已经收窄了"：store 的
     币种集合是 **6** 个（P22-1 的 registry：IB_CREDIT / ACTIVITY_POINT /
     COMPUTE_STANDARD / COMPUTE_PREMIUM / IMAGE_CREDIT / VOICE_CREDIT），
     它们是**合法的 Economy 币种**。而"初始额度"这件事的规范含义只有一种：
     它是 IB Credit。把 ACTIVITY_POINT 的初始额度也放进来，会让"初始额度"
     变成一个通用发币入口 —— 正是 §3 要防的那种顺手扩大。
     这一层因此把它收窄到**恰好一个**币种，而且拒绝理由明说原因。 */
  INITIAL_CREDIT_CURRENCY_MUST_BE_IB_CREDIT: 'ECONOMY_CONFIGURATION_INITIAL_CREDIT_CURRENCY_MUST_BE_IB_CREDIT',
  /* 下游（store）拒绝：**原样透出**它的 reasonCode（若有），这一条只是归类。 */
  CONFIGURATION_REFUSED: 'ECONOMY_CONFIGURATION_REFUSED_BY_THE_ECONOMY_STORE'
});
const REFUSAL_CODES = Object.freeze(Object.keys(REFUSAL).map(k => REFUSAL[k]));

/* ══ 自述位（每一个返回值上都带着）═════════════════════════════════ */
const SELF_BITS = Object.freeze({
  seam: 'economy-configuration-seam',
  configurationAuthorityIsNotAgentAuthority: true,
  configurationAuthorityIsNotPurchaseAuthority: true,
  configurationAuthorityIsNotPaymentAuthority: true,
  seamInterpretsEconomicFacts: false,
  seamHoldsRawStore: false,
  seamExposesGenericDispatch: false,
  seamEvaluatesBudget: false,
  seamEvaluatesAutonomy: false,
  seamOpensWallets: false,
  seamMintsDirectly: false,
  seamChoosesTheOwner: false,
  /* ★ 这三句在**每一个**返回值上（成功与拒绝都有），因为"这条面能不能批准 /
     续做 / 结算"是一个关于**结构**的问题，而不是关于这次调用成没成。 */
  canApproveOrReject: false,
  canResumeAnIntent: false,
  canSettleAPurchase: false,
  identityComesFromTheTransportNotThePayload: true,
  transportIsNotAnEconomyAuthority: true
});

const MAX_ID_LENGTH = 200;

/* ══ 小工具（与 P22-13 同款，逐字同源）═════════════════════════════ */
function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
function constantTimeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a == null ? '' : a), 'utf8').digest();
  const y = crypto.createHash('sha256').update(String(b == null ? '' : b), 'utf8').digest();
  return crypto.timingSafeEqual(x, y);
}
function unexpectedKeysOf(input, allowed) {
  return Object.keys(input).filter(key => allowed.indexOf(key) < 0);
}
function nonEmptyString(value, max) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  return s !== '' && s.length <= max;
}

/* ══════════════════════════════════════════════════════════════════
   工厂
   ══════════════════════════════════════════════════════════════════
   deps:
     · store              —— **唯一**的 store 触碰点。它的键**恰好三个**：
                              bootstrapInitialCredit / putBudgetPolicy /
                              putAutonomyPolicy。没有第四个，也没有
                              mintForSystem / burnForSystem / openWallet /
                              commitLedgerTransaction / settlePurchase /
                              grantInventory / decideApproval。
     · desktopCredential  —— 已配置的桌面 token。**空串 ⇒ 本面整体关闭**
                              （fail closed，503 且明说缺什么），与 P22-13
                              的凭据要求逐字同源。
     · clock / logger     —— 与其它 seam 同款。 */
function createEconomyConfigurationSeam(options) {
  options = options || {};
  const store = options.store || null;
  const desktopCredential = String(options.desktopCredential == null ? '' : options.desktopCredential);
  const logger = typeof options.logger === 'function' ? options.logger : function () { };
  const clock = typeof options.clock === 'function' ? options.clock : (() => Date.now());

  const auditRing = [];
  const requestMemory = new Map();
  const AUDIT_RING_LIMIT = 100;
  const REQUEST_ID_MEMORY_LIMIT = 256;

  const credentialConfigured = desktopCredential.trim() !== '';
  const storeCanBootstrap = !!store && typeof store.bootstrapInitialCredit === 'function';
  const storeCanPutBudgetPolicy = !!store && typeof store.putBudgetPolicy === 'function';
  const storeCanPutAutonomyPolicy = !!store && typeof store.putAutonomyPolicy === 'function';

  /* ★ 三个能力**全部**就绪才算开放：一个只装配了一半的配置面会让
     "fresh install 能配完"变成"能配一部分"，而那种半开状态最难被发现。 */
  const open = credentialConfigured && storeCanBootstrap &&
    storeCanPutBudgetPolicy && storeCanPutAutonomyPolicy;

  function record(event, fields) {
    const entry = Object.assign({ at: clock(), event: event }, fields || {});
    auditRing.push(entry);
    while (auditRing.length > AUDIT_RING_LIMIT) auditRing.shift();
    try { logger('info', event, fields || {}); } catch (_) { /* 日志失败不得影响配置 */ }
    return entry;
  }

  /* ── 仓库视图的自述（describe 用它证明"没有第四个成员"）─────────────
     ★ 它不是从 store 上"取键"得来的（那会把 store 的完整成员名带进
     返回值），而是一份**写死的**名单 —— 本文件对 store 的全部访问就是
     这三个名字，写死它才是诚实的。 */
  const STORE_VIEW_KEYS = Object.freeze([
    'bootstrapInitialCredit', 'putBudgetPolicy', 'putAutonomyPolicy'
  ]);

  /* ── 拒绝的完整形状 ────────────────────────────────────────────────
     ★ `reachedStore` 是这一层最重要的位：身份 / 信封面被拒时它**必须**是
     false，因为那条路径上什么都没碰过。 */
  function refusal(status, reasonCode, extra) {
    return Object.assign({
      ok: false,
      status: status,
      refused: true,
      refusedBy: 'economy-configuration-seam',
      reasonCode: reasonCode,
      errors: [],
      command: null,
      refusals: [],
      callerIdentityFromPayload: false,
      reachedStore: false,
      configuredAnything: false,
      creditMinted: false,
      budgetPolicyWritten: false,
      autonomyPolicyWritten: false,
      ledgerMutation: false,
      inventoryMutation: false,
      purchaseMutation: false,
      approvalMutation: false,
      providerMutation: false,
      paymentMutation: false,
      result: null
    }, SELF_BITS, extra || {});
  }

  /* ── §6 · 调用者身份：桌面凭据（恒定时间）───────────────────────────
     ★ 与 P22-13 的 resolveUser 逐字同源，但**用的是另一份凭据事实**：
     这里要回答的是"你是不是这台节点的**配置**调用者"。它同样是桌面 token
     —— 因为在这个仓库里，桌面 token 就是"这台机器的用户"的唯一既有凭据，
     而 §1 要求优先复用既有认证。Agent 的来源凭据（P22-11 的
     IB_ECONOMY_CHANNEL_TOKEN，按端口登记）在这条路径上**根本不被读**：
     本函数只看桌面头，因此 Agent 凭据换不到配置权威（§12）。 */
  function resolveConfigurationCaller(requestInfo) {
    const info = requestInfo || {};
    if (info.loopback !== true) {
      return { ok: false, reasonCode: REFUSAL.NOT_LOOPBACK };
    }
    if (!credentialConfigured) {
      return { ok: false, reasonCode: REFUSAL.CREDENTIAL_NOT_CONFIGURED };
    }
    const supplied = String(info.desktopCredential == null ? '' : info.desktopCredential);
    if (supplied.trim() === '' || supplied.length > 512) {
      return { ok: false, reasonCode: REFUSAL.MISSING_CONFIGURATION_CREDENTIAL };
    }
    if (!constantTimeEqual(supplied, desktopCredential)) {
      return { ok: false, reasonCode: REFUSAL.WRONG_CONFIGURATION_CREDENTIAL };
    }
    return { ok: true };
  }

  function rememberRequest(requestId, commandWord) {
    const known = requestMemory.get(requestId);
    requestMemory.set(requestId, commandWord);
    while (requestMemory.size > REQUEST_ID_MEMORY_LIMIT) {
      const oldest = requestMemory.keys().next();
      if (oldest.done) break;
      requestMemory.delete(oldest.value);
    }
    return known;
  }

  /* ── 共同的入参整理：每一个命令走的都是"收窄 → 交给 store → 透传"──
     ★ 这里**没有**经济判断：没有金额比较、没有政策大小关系、没有
     "自动修正"。一个坏配置在 store 的 canonical 校验里被拒，本文件把它
     的拒绝原样透出（§4：坏配置 fail closed，不允许被"修正"成另一个策略）。 */
  /* ── 下游拒绝 → HTTP 状态。**按理由分类，而不是"被拒绝就 409"**────────
     ★ 这是一个真实的语义缺陷（开发期实测）：第一版写成
       `outcome.denied === true ? 409 : 400`，而 store 把"你这份配置根本不成形"
       也标成 denied（`C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED`）——
       于是一个**畸形请求**回答 409 Conflict。那是错的：409 的语义是
       "你的请求没问题，是当前状态不允许"（例如"初始额度已经发过了"），
       而 400 的语义是"你的请求本身不成形"。接口说错话会把调用方引向
       错误的修法：它应该改 payload，却被暗示去重读状态。
     ★ 名单逐字取自 store 自己的拒绝码（不在这里另立一套判断）：
       · 已经发生的终态        → 409（这是真的冲突）
       · 配置本身不成形        → 400（改 payload）
       · 找不到被引用的策略    → 404（改 id）
       · 其它状态机式的拒绝    → 409
     ★ 没有落到任何一条的未知拒绝码**保守地**给 400（"我不认识这个理由"
       不该被说成一个冲突）。 */
  const CONFLICTING_DENIALS = Object.freeze([
    'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED',
    C.DENY_REASON.TRANSITION_NOT_ALLOWED,
    C.DENY_REASON.APPROVAL_EXPIRED,
    C.DENY_REASON.AUTONOMY_NOT_PERMITTED
  ]);
  const MALFORMED_DENIALS = Object.freeze([
    C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED,
    C.DENY_REASON.INVALID_CURRENCY,
    C.DENY_REASON.INVALID_AMOUNT,
    C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED
  ]);
  const NOT_FOUND_DENIALS = Object.freeze([
    C.DENY_REASON.POLICY_NOT_FOUND,
    C.DENY_REASON.PRODUCT_NOT_FOUND
  ]);
  function statusForRefusal(outcome) {
    const code = outcome && outcome.reasonCode != null ? String(outcome.reasonCode) : null;
    if (code == null) return 400;
    if (NOT_FOUND_DENIALS.indexOf(code) >= 0) return 404;
    if (MALFORMED_DENIALS.indexOf(code) >= 0) return 400;
    if (CONFLICTING_DENIALS.indexOf(code) >= 0) return 409;
    /* 未登记的拒绝码：denied 说"这是一次拒绝"，但它没有资格被说成冲突。 */
    return 400;
  }

  function storeRefusal(commandWord, outcome, extra) {
    const downstreamReasonCode = outcome && outcome.reasonCode != null
      ? String(outcome.reasonCode) : null;
    /* ★ 下游自己给了 reasonCode（例如 INITIAL_CREDIT_ALREADY_BOOTSTRAPPED）
       就**原样透出**它：那是比本层任何归类都更准确的答案。 */
    return {
      ok: false,
      status: statusForRefusal(outcome),
      refused: true,
      refusedBy: 'economy-configuration-seam',
      reasonCode: downstreamReasonCode || REFUSAL.CONFIGURATION_REFUSED,
      errors: (outcome && outcome.errors) || [],
      command: commandWord,
      reachedStore: true,
      downstreamReasonCode: downstreamReasonCode,
      result: outcome || null
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     命令执行：恰好三支，每一支对 store 的访问是**一处字面成员调用**
     ══════════════════════════════════════════════════════════════════
     ★ 没有 `store[command]`、没有 `store[method]`、没有 switch 之外的
     第二处分派。未知命令在到达这里**之前**就已经被拒（UNKNOWN_COMMAND）。 */
  function runBootstrapCredit(config, idempotencyKey) {
    /* ★ §3 逐字：初始额度**只能**是 IB_CREDIT。契约的币种 register 有六个
       成员（它们都是合法的 Economy 币种），因此这一条**不是**"store 已经
       管了"—— 它是本阶段对"初始额度"这个词的定义。 */
    if (String(config.currency) !== C.CURRENCY.IB_CREDIT) {
      return refusal(400, REFUSAL.INITIAL_CREDIT_CURRENCY_MUST_BE_IB_CREDIT, {
        command: COMMAND.BOOTSTRAP_CREDIT,
        currency: config.currency == null ? null : String(config.currency),
        acceptedCurrency: C.CURRENCY.IB_CREDIT,
        errors: ['the-initial-credit-is-ib-credit-and-nothing-else']
      });
    }
    const outcome = store.bootstrapInitialCredit({
      /* ★ owner 传**裸 id**，而不是这里拼一个 {type,id}：party 类型的提升
         规则（'user' → user:user，其余 → character:<id>）在契约的
         makePartyRef 里只有一个实现，本文件抄一份就等于造了第二个答案。
         于是"配置目标是谁"由 canonical 身份规则决定，而不是由这里的一个
         if 决定。 */
      owner: config.ownerId,
      currency: config.currency,
      amountMinor: config.amountMinor,
      idempotencyKey: idempotencyKey
    });
    if (!outcome || outcome.ok !== true) return storeRefusal(COMMAND.BOOTSTRAP_CREDIT, outcome);
    return Object.assign({
      ok: true,
      status: 200,
      refused: false,
      refusedBy: null,
      reasonCode: null,
      errors: [],
      command: COMMAND.BOOTSTRAP_CREDIT,
      reachedStore: true,
      configuredAnything: true,
      creditMinted: outcome.replayed !== true,
      replayOfTheInitialCredit: outcome.replayed === true,
      budgetPolicyWritten: false,
      autonomyPolicyWritten: false,
      ledgerMutation: outcome.replayed !== true,
      inventoryMutation: false,
      purchaseMutation: false,
      approvalMutation: false,
      providerMutation: false,
      paymentMutation: false,
      /* ★ 两条**必须分开**的位（与 P22-13 的 purchaseCreatedNow /
         purchaseExists 同源的教训）：这一次调用有没有真的铸出钱，
         与这个 owner 的初始额度**在不在**，是两个不同的问题。 */
      initialCreditMintedNow: outcome.replayed !== true,
      initialCreditBootstrapped: true,
      alreadyBootstrappedBeforeThisRequest: outcome.bootstrapAlreadyConsumed === true,
      walletId: outcome.walletId == null ? null : String(outcome.walletId),
      transactionId: outcome.transactionId == null ? null : String(outcome.transactionId),
      amountMinor: outcome.amountMinor == null ? null : String(outcome.amountMinor),
      currency: outcome.currency == null ? null : String(outcome.currency),
      ownerId: config.ownerId,
      isProviderQuota: false,
      isRealCurrency: false,
      result: outcome
    }, SELF_BITS);
  }

  function runPutBudgetPolicy(config, idempotencyKey) {
    const outcome = store.putBudgetPolicy({
      ownerId: config.ownerId,
      currency: config.currency,
      limits: config.limits,
      termEndsAt: config.termEndsAt,
      autonomyLevel: config.autonomyLevel,
      ifRevision: config.ifRevision,
      idempotencyKey: idempotencyKey
    });
    if (!outcome || outcome.ok !== true) return storeRefusal(COMMAND.PUT_BUDGET_POLICY, outcome);
    return Object.assign({
      ok: true,
      status: 200,
      refused: false,
      refusedBy: null,
      reasonCode: null,
      errors: [],
      command: COMMAND.PUT_BUDGET_POLICY,
      reachedStore: true,
      configuredAnything: true,
      creditMinted: false,
      budgetPolicyWritten: true,
      autonomyPolicyWritten: false,
      /* 政策写入不是经济运动（P22-4 逐字）：这一位恒 false，而且它是真的。 */
      ledgerMutation: false,
      inventoryMutation: false,
      purchaseMutation: false,
      approvalMutation: false,
      providerMutation: false,
      paymentMutation: false,
      replayed: outcome.replayed === true,
      policyId: outcome.result && outcome.result.policyId ? String(outcome.result.policyId) : null,
      policyRevision: outcome.result && outcome.result.revision != null ? Number(outcome.result.revision) : null,
      ownerId: config.ownerId,
      result: outcome
    }, SELF_BITS);
  }

  function runPutAutonomyPolicy(config, idempotencyKey) {
    const outcome = store.putAutonomyPolicy({
      ownerId: config.ownerId,
      enabled: config.enabled,
      perPurchaseLimitMinor: config.perPurchaseLimitMinor,
      dailyAutonomousLimitMinor: config.dailyAutonomousLimitMinor,
      approvalAboveMinor: config.approvalAboveMinor,
      allowedProductKinds: config.allowedProductKinds,
      allowedSettlementTypes: config.allowedSettlementTypes,
      allowGift: config.allowGift,
      ifRevision: config.ifRevision,
      idempotencyKey: idempotencyKey
    });
    if (!outcome || outcome.ok !== true) return storeRefusal(COMMAND.PUT_AUTONOMY_POLICY, outcome);
    return Object.assign({
      ok: true,
      status: 200,
      refused: false,
      refusedBy: null,
      reasonCode: null,
      errors: [],
      command: COMMAND.PUT_AUTONOMY_POLICY,
      reachedStore: true,
      configuredAnything: true,
      creditMinted: false,
      budgetPolicyWritten: false,
      autonomyPolicyWritten: true,
      ledgerMutation: false,
      inventoryMutation: false,
      purchaseMutation: false,
      approvalMutation: false,
      providerMutation: false,
      paymentMutation: false,
      replayed: outcome.replayed === true,
      policyId: outcome.result && outcome.result.policyId ? String(outcome.result.policyId) : null,
      policyRevision: outcome.result && outcome.result.revision != null ? Number(outcome.result.revision) : null,
      ownerId: config.ownerId,
      /* ★ 自主策略是**权限**，不是决策层（P22-7 的三条自述原样透出）。 */
      grantsBudget: false,
      replacesBudget: false,
      isADecisionLayer: false,
      result: outcome
    }, SELF_BITS);
  }

  /* ── 命令 → 执行的**唯一**映射。它是封闭的：三个键，没有 fallback。 */
  const RUNNERS = Object.freeze({
    BOOTSTRAP_CREDIT: runBootstrapCredit,
    PUT_BUDGET_POLICY: runPutBudgetPolicy,
    PUT_AUTONOMY_POLICY: runPutAutonomyPolicy
  });

  /* ── 每个命令的 config 归一。**只**做形状与身份收窄，不做经济判断。 */
  function normalizeConfig(commandWord, rawConfig) {
    const allowed = CONFIG_KEYS[commandWord];
    const rejectedIdentity = FORBIDDEN_IDENTITY_KEYS.filter(key =>
      Object.prototype.hasOwnProperty.call(rawConfig, key));
    if (rejectedIdentity.length) {
      return { ok: false, reasonCode: REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT, rejectedIdentityKeys: rejectedIdentity };
    }
    const rejectedKeys = unexpectedKeysOf(rawConfig, allowed);
    if (rejectedKeys.length) {
      return {
        ok: false, reasonCode: REFUSAL.UNEXPECTED_CONFIG_KEYS,
        rejectedConfigKeys: rejectedKeys, acceptedConfigKeys: allowed
      };
    }
    if (!nonEmptyString(rawConfig.ownerId, MAX_ID_LENGTH)) {
      return { ok: false, reasonCode: REFUSAL.MISSING_OWNER_ID };
    }
    const config = { ownerId: rawConfig.ownerId.trim() };
    /* ★ 顶层允许的另外两个键按命令各自取用；**不做类型转换** ——
       "1" 与 1 是不是同一个金额是契约的问题，不是这一层的问题
       （P22-4 已经为这件事写过一条真实的缺陷）。 */
    for (const key of allowed) {
      if (key === 'ownerId') continue;
      if (Object.prototype.hasOwnProperty.call(rawConfig, key)) config[key] = rawConfig[key];
    }
    return { ok: true, config: config };
  }

  /* ══════════════════════════════════════════════════════════════════
     唯一执行链
     ══════════════════════════════════════════════════════════════════ */
  function dispatch(requestInfo, rawBody) {
    if (!open) {
      record('economy-configuration-closed', {
        credentialConfigured: credentialConfigured,
        storeCanBootstrap: storeCanBootstrap,
        storeCanPutBudgetPolicy: storeCanPutBudgetPolicy,
        storeCanPutAutonomyPolicy: storeCanPutAutonomyPolicy
      });
      return refusal(503, credentialConfigured ? REFUSAL.SEAM_NOT_CONFIGURED : REFUSAL.CREDENTIAL_NOT_CONFIGURED, {
        credentialConfigured: credentialConfigured,
        storeCanBootstrap: storeCanBootstrap,
        storeCanPutBudgetPolicy: storeCanPutBudgetPolicy,
        storeCanPutAutonomyPolicy: storeCanPutAutonomyPolicy,
        hint: !credentialConfigured
          ? 'set IB_HOME_NODE_TOKEN to enable the economy configuration path'
          : 'the economy configuration seam is not fully assembled'
      });
    }

    const caller = resolveConfigurationCaller(requestInfo);
    if (caller.ok !== true) {
      record('economy-configuration-refused', { stage: 'identity', reasonCode: caller.reasonCode });
      return refusal(caller.reasonCode === REFUSAL.NOT_LOOPBACK ? 401 : 403, caller.reasonCode, {
        identityIsEstablishedByTheTransport: true,
        acceptedCredentialHeaders: ['X-IB-Home-Token', 'Authorization: Bearer …'],
        hint: caller.reasonCode === REFUSAL.CREDENTIAL_NOT_CONFIGURED
          ? 'set IB_HOME_NODE_TOKEN to enable the economy configuration path'
          : 'send the configured desktop credential'
      });
    }

    if (!isPlainObject(rawBody)) {
      record('economy-configuration-refused', { stage: 'envelope', reasonCode: REFUSAL.MALFORMED_ENVELOPE });
      return refusal(400, REFUSAL.MALFORMED_ENVELOPE, {
        errors: ['configuration-body-must-be-a-plain-object']
      });
    }

    /* ── §6 · 调用者自报身份：顶层键逐名拒绝，**不触碰** store ─────── */
    const selfReported = FORBIDDEN_IDENTITY_KEYS.filter(key =>
      Object.prototype.hasOwnProperty.call(rawBody, key));
    if (selfReported.length) {
      record('economy-configuration-refused', {
        stage: 'identity', reasonCode: REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT
      });
      return refusal(403, REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT, {
        rejectedIdentityKeys: selfReported,
        forbiddenIdentityKeys: FORBIDDEN_IDENTITY_KEYS,
        identityIsEstablishedByTheTransport: true,
        errors: selfReported.map(key => 'configuration-may-not-carry:' + key)
      });
    }

    const rejectedEnvelopeKeys = unexpectedKeysOf(rawBody, ENVELOPE_KEYS);
    if (rejectedEnvelopeKeys.length) {
      record('economy-configuration-refused', { stage: 'envelope', reasonCode: REFUSAL.UNEXPECTED_ENVELOPE_KEYS });
      return refusal(400, REFUSAL.UNEXPECTED_ENVELOPE_KEYS, {
        rejectedEnvelopeKeys: rejectedEnvelopeKeys,
        acceptedEnvelopeKeys: ENVELOPE_KEYS,
        errors: rejectedEnvelopeKeys.map(key => 'configuration-envelope-key-not-whitelisted:' + key)
      });
    }

    const rawCommand = nonEmptyString(rawBody.command, 100) ? rawBody.command.trim() : '';
    if (rawCommand === '') {
      record('economy-configuration-refused', { stage: 'command', reasonCode: REFUSAL.MISSING_COMMAND });
      return refusal(400, REFUSAL.MISSING_COMMAND, {
        errors: ['configuration-requires-a-command'],
        acceptedCommands: COMMAND_LIST
      });
    }
    /* ★ 只折大小写（与 P22-13 的决定词同款），不折别的：'bootstrap_credit'
       与 'BOOTSTRAP_CREDIT' 是同一个命令，而 'MINT' / 'APPROVE' / 'BUY'
       不在这份词表里，因此只能落到 UNKNOWN_COMMAND（404，fail closed）。 */
    const commandWord = rawCommand.toUpperCase();
    if (COMMAND_LIST.indexOf(commandWord) < 0) {
      record('economy-configuration-refused', {
        stage: 'command', reasonCode: REFUSAL.UNKNOWN_COMMAND, command: rawCommand
      });
      return refusal(404, REFUSAL.UNKNOWN_COMMAND, {
        command: rawCommand,
        acceptedCommands: COMMAND_LIST,
        errors: ['the-only-commands-are-bootstrap-credit-and-the-two-policy-writes']
      });
    }

    if (!isPlainObject(rawBody.config)) {
      record('economy-configuration-refused', { stage: 'config', reasonCode: REFUSAL.MISSING_CONFIG, command: commandWord });
      return refusal(400, REFUSAL.MISSING_CONFIG, {
        command: commandWord,
        errors: ['configuration-requires-a-config-object'],
        acceptedConfigKeys: CONFIG_KEYS[commandWord]
      });
    }
    const normalized = normalizeConfig(commandWord, rawBody.config);
    if (normalized.ok !== true) {
      record('economy-configuration-refused', {
        stage: 'config', reasonCode: normalized.reasonCode, command: commandWord
      });
      return refusal(400, normalized.reasonCode, {
        command: commandWord,
        rejectedConfigKeys: normalized.rejectedConfigKeys || [],
        rejectedIdentityKeys: normalized.rejectedIdentityKeys || [],
        acceptedConfigKeys: CONFIG_KEYS[commandWord],
        errors: ['configuration-config-was-refused']
      });
    }
    const config = normalized.config;

    if (!nonEmptyString(rawBody.idempotencyKey, MAX_ID_LENGTH)) {
      /* ★ 缺 canonical 幂等键 ⇒ **拒绝**，而不是这里生成一个。生成一个等于
         把同一次配置意图变成两次逻辑动作，而这正是"UI retry"要收敛掉的。 */
      record('economy-configuration-refused', { stage: 'envelope', reasonCode: REFUSAL.MISSING_IDEMPOTENCY_KEY, command: commandWord });
      return refusal(400, REFUSAL.MISSING_IDEMPOTENCY_KEY, {
        command: commandWord,
        errors: ['configuration-requires-a-canonical-idempotency-key']
      });
    }
    const idempotencyKey = rawBody.idempotencyKey.trim();
    const keyCheck = C.normalizeIdempotencyKey(idempotencyKey);
    if (keyCheck.ok !== true) {
      record('economy-configuration-refused', { stage: 'envelope', reasonCode: REFUSAL.MISSING_IDEMPOTENCY_KEY, command: commandWord });
      return refusal(400, REFUSAL.MISSING_IDEMPOTENCY_KEY, {
        command: commandWord,
        errors: keyCheck.errors
      });
    }

    /* ── §11 · 请求身份：同一个 idempotencyKey 换了命令 ⇒ 冲突 ────────
       ★ store 的指纹（各 scope 各自包含请求内容）也会判这件事，这一层
       只让它在**触碰 store 之前**被回答，并且不缓存任何结果。 */
    const knownCommand = rememberRequest(keyCheck.key, commandWord);
    if (knownCommand !== undefined && knownCommand !== commandWord) {
      record('economy-configuration-refused', {
        stage: 'idempotency', reasonCode: REFUSAL.REQUEST_ID_CONFLICT, command: commandWord
      });
      return refusal(409, REFUSAL.REQUEST_ID_CONFLICT, {
        command: commandWord,
        previouslyUsedFor: knownCommand,
        errors: ['the-same-configuration-identity-was-used-for-a-different-command']
      });
    }

    /* ── 唯一执行：封闭映射里的一支 ──────────────────────────────────── */
    const runner = RUNNERS[commandWord];
    const outcome = runner(config, keyCheck.key);
    record(outcome.ok === true ? 'economy-configuration-applied' : 'economy-configuration-refused', {
      command: commandWord,
      ownerId: config.ownerId,
      outcome: outcome.ok === true ? 'accepted' : String(outcome.reasonCode || 'refused'),
      reachedStore: outcome.reachedStore === true,
      creditMinted: outcome.creditMinted === true,
      transportIsNotAnEconomyAuthority: true
    });
    return Object.assign({ idempotencyKey: keyCheck.key, callerIdentityFromPayload: false }, outcome);
  }

  function describe() {
    return Object.freeze({
      seam: 'economy-configuration-seam',
      path: CONFIGURATION_PATH,
      open: open,
      implemented: true,
      openRequires: Object.freeze({
        desktopCredentialConfigured: credentialConfigured,
        storeCanBootstrapInitialCredit: storeCanBootstrap,
        storeCanPutBudgetPolicy: storeCanPutBudgetPolicy,
        storeCanPutAutonomyPolicy: storeCanPutAutonomyPolicy
      }),
      commands: COMMAND_LIST,
      /* ★ 封闭词表：这三个是**全部**。下面两份名单是"没有"的可断言形式。 */
      envelopeKeys: ENVELOPE_KEYS,
      configKeys: Object.freeze({
        BOOTSTRAP_CREDIT: CONFIG_KEYS.BOOTSTRAP_CREDIT,
        PUT_BUDGET_POLICY: CONFIG_KEYS.PUT_BUDGET_POLICY,
        PUT_AUTONOMY_POLICY: CONFIG_KEYS.PUT_AUTONOMY_POLICY
      }),
      forbiddenIdentityKeys: FORBIDDEN_IDENTITY_KEYS,
      refusalCodes: REFUSAL_CODES,
      storeViewKeys: STORE_VIEW_KEYS,
      storeViewKeyCount: STORE_VIEW_KEYS.length,
      credential: 'desktop-token (X-IB-Home-Token / Authorization: Bearer; constant-time compare)',
      credentialProvisioning: 'deployment-environment (never in payload, never in logs, never in this description)',
      callerIdentityStrength: 'authenticated-desktop-credential + loopback',
      /* ── §2 · 这一面**不是**什么（逐条点名，全部是可断言的字段）────── */
      isAnAgentAuthority: false,
      isAPurchaseAuthority: false,
      isAPaymentAuthority: false,
      isABudgetEvaluator: false,
      isAnAutonomyEvaluator: false,
      canProposeAPurchase: false,
      canApproveOrReject: false,
      canResumeAnIntent: false,
      canSettleAPurchase: false,
      canReserveFunds: false,
      canGrantInventory: false,
      canRefund: false,
      canExchange: false,
      canTopUpAProvider: false,
      canWriteRawLedgerEntries: false,
      canForgeATransactionId: false,
      canChooseLedgerAccounts: false,
      exposesMintForSystem: false,
      exposesGenericDispatch: false,
      /* ── §11 · 三个命令**不是**同一类 ─────────────────────────────── */
      initialCreditIsOneShot: true,
      initialCreditOneShotLivesInTheCanonicalStore: true,
      budgetPolicyIsAVersionedUpdate: true,
      autonomyPolicyIsAVersionedUpdate: true,
      /* ── §8 · 与 P22-13 的分权 ────────────────────────────────────── */
      differsFromTheApprovalDecisionSeam: Object.freeze({
        approvalDecisionPath: '/internal/economy/approval-decision',
        approvalDecisionMeans: 'User APPROVE / REJECT of ONE waiting Agent intent',
        configurationMeans: 'User CONFIGURES the node (initial credit / budget / autonomy)',
        sharesACommandWithTheApprovalDecisionSeam: false,
        sharesAnEnvelopeWithTheApprovalDecisionSeam: false,
        configurationCannotDecideAnApproval: true,
        approvalDecisionCannotConfigure: true
      }),
      differsFromTheCommandChannel: Object.freeze({
        commandPath: '/internal/economy/command',
        commandMeans: 'Agent WANT (ECONOMY_PROPOSE_PURCHASE)',
        sharesACredentialWithTheCommandChannel: false
      }),
      auditRingLimit: AUDIT_RING_LIMIT,
      requestIdMemoryLimit: REQUEST_ID_MEMORY_LIMIT
    });
  }

  function audit() {
    return Object.freeze(auditRing.slice());
  }

  return Object.freeze({
    path: CONFIGURATION_PATH,
    COMMAND: COMMAND,
    COMMAND_LIST: COMMAND_LIST,
    ENVELOPE_KEYS: ENVELOPE_KEYS,
    CONFIG_KEYS: CONFIG_KEYS,
    FORBIDDEN_IDENTITY_KEYS: FORBIDDEN_IDENTITY_KEYS,
    REFUSAL: REFUSAL,
    dispatch: dispatch,
    describe: describe,
    audit: audit
  });
}

module.exports = createEconomyConfigurationSeam;
module.exports.CONFIGURATION_PATH = CONFIGURATION_PATH;
module.exports.COMMAND = COMMAND;
module.exports.COMMAND_LIST = COMMAND_LIST;
module.exports.ENVELOPE_KEYS = ENVELOPE_KEYS;
module.exports.CONFIG_KEYS = CONFIG_KEYS;
module.exports.FORBIDDEN_IDENTITY_KEYS = FORBIDDEN_IDENTITY_KEYS;
module.exports.REFUSAL = REFUSAL;
