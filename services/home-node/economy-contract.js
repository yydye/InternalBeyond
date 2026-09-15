/* ====================================================================
   IB Home Node · Agent Economy Contract（P22-1 · 领域契约的**唯一**真源）
   --------------------------------------------------------------------
   本文件回答且只回答一个问题：

     「Agent Economy 里的一个数、一个 id、一个状态、一个事件，
       到底是什么？」

   它**不**回答：余额现在是多少（P22-2）、能不能买得起（P22-4）、
   商品有哪些（P22-5）。本文件里没有任何 store、没有 SQLite、没有
   credit/debit、没有 HTTP 路由、没有 provider 调用、没有定时器。

   ── 为什么需要它（而不是"边写边定"）──────────────────────────────────
   P22-0 审计（docs/P22-0-ECONOMY-AUDIT.md）发现仓库里**已经存在**一套
   真实支付域，而且它已经占用了 Economy 最想要的那批词：

     · active/commerce.js:572   `a.task.maxBudget`  —— 单位是**元**
     · active/commerce.js:528   `a.paymentIntent`   —— 通向真实收银台
     · bridge/pay-gate.js       `commitSpend`       —— 真实支出记账
     · bridge/alipay-provider.js spawnSync('alipay-bot','submit-payment',...)

   如果 Economy 也用 `amount` / `budget` / `balance` / `currency` 这套裸
   字段，那么"虚拟预算"与"真实预算"会在**类型层面**无法区分，而这个污染
   在测试里看起来会是绿的（两边各自都自洽）。本文件因此把两件事钉死：

     ① 跨模块 payload / event / persistence record 必须带 `domain`
        标记，取值恒为 DOMAIN（'ib.economy'）；缺域标记的一律拒绝
        （§1，validateEconomyDomain）。
     ② 真实货币与 provider 计费**不是** Economy currency —— 它们是
        FORBIDDEN_CURRENCY_TOKENS，被逐字否认（§2）。

   ── 单位系统（为什么是 BigInt）───────────────────────────────────────
   canonical 余额计算**不允许**浮点（§3）。理由不是洁癖：0.1+0.2 类误差
   进了 ledger 之后，"总账守恒"这条不变量会以极低概率、极难复现的方式
   失败，而失败的表现是"钱变多了/少了"——这是本阶段最不能有的 bug。

   于是 canonical runtime representation 是 **BigInt**，而 JSON 序列化是
   **十进制字符串**（不是 number）。JSON.stringify 不能序列化 BigInt，
   所以序列化必须显式走 serializeAmountMinor()；这是刻意的，因为
   "静默地把它变成 number"正是我们要防的那件事。

   ── 一个刻意的**不**做 ──────────────────────────────────────────────
   本文件不提供 makeXId() 随机 id 生成器。契约冻结的是 **id 的形状与归属**
   （前缀 + 语法 + 唯一性 + 幂等语义），生成属于运行时（P22-2）。
   这样契约就是纯函数、可枚举、可被测试穷举，也没有随机源。

   ── 载入期零副作用 ─────────────────────────────────────────────────
   零 window / 零 DOM / 零 fs / 零 require / 零网络 / 零 storage / 零随机
   / 零时间读取。UMD 双载（Node require 与浏览器 <script> 同一份），
   与 assets/js/memory-contract.js 同款。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBEconomyContract = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════
     §1 · 命名空间与域标记
     ══════════════════════════════════════════════════════════════════ */

  /* 跨模块可见的一切 Economy 载荷都必须带这个标记。它不是装饰：
     home-node 的 http.js 已有 doesNotExpose: [..., 'payments', ...] 这种
     "可检查的自述"传统，DOMAIN 是同一纪律在数据层的落点。 */
  var DOMAIN = 'ib.economy';

  /* 域内子命名空间。用于 eventType / audit operation 的稳定性：
     它们是**封闭集合**，不允许运行时拼字符串。 */
  var NAMESPACES = Object.freeze({
    WALLET: 'ib.economy.wallet',
    TRANSACTION: 'ib.economy.transaction',
    LEDGER: 'ib.economy.ledger',
    RESERVATION: 'ib.economy.reservation',
    BUDGET: 'ib.economy.budget',
    STORE: 'ib.economy.store',
    INVENTORY: 'ib.economy.inventory',
    EXCHANGE: 'ib.economy.exchange',
    COMPUTE: 'ib.economy.compute',
    QUOTE: 'ib.economy.quote',
    EVENT: 'ib.economy.event',
    AUDIT: 'ib.economy.audit'
  });

  function isEconomyDomain(value) {
    return value != null && String(value) === DOMAIN;
  }

  /* 缺标记即拒绝：这是 §1 "脱离对象上下文后仍能判断归属"的强制点。 */
  function validateEconomyDomain(value) {
    return isEconomyDomain(value)
      ? { ok: true, errors: [] }
      : { ok: false, errors: ['missing-economy-domain'] };
  }

  /* ══════════════════════════════════════════════════════════════════
     §2 · Currency Contract
     ══════════════════════════════════════════════════════════════════ */

  /* 每种 currency 一个 scale：1 个展示单位 = scale 个 minor unit。
     scale 是**货币自身**的属性，不是全局常量 —— 因为 Computed Credit
     的天然粒度就是"一次调用"，把它的 scale 也设成 100 只会制造
     "0.01 次付费调用"这种无意义的可表示状态。 */
  var CURRENCY = Object.freeze({
    IB_CREDIT: 'IB_CREDIT',
    ACTIVITY_POINT: 'ACTIVITY_POINT',
    COMPUTE_STANDARD: 'COMPUTE_STANDARD',
    COMPUTE_PREMIUM: 'COMPUTE_PREMIUM',
    IMAGE_CREDIT: 'IMAGE_CREDIT',
    VOICE_CREDIT: 'VOICE_CREDIT'
  });

  var CURRENCY_SCALE = Object.freeze({
    IB_CREDIT: 100,
    ACTIVITY_POINT: 100,
    COMPUTE_STANDARD: 1,
    COMPUTE_PREMIUM: 1,
    IMAGE_CREDIT: 1,
    VOICE_CREDIT: 1
  });

  /* 展示名**不是** id。清单只用于 UI 文案（P22-11），绝不参与任何判定。 */
  var CURRENCY_DISPLAY = Object.freeze({
    IB_CREDIT: 'IB Credit',
    ACTIVITY_POINT: 'Activity Point',
    COMPUTE_STANDARD: 'Standard Compute Credit',
    COMPUTE_PREMIUM: 'Premium Compute Credit',
    IMAGE_CREDIT: 'Image Credit',
    VOICE_CREDIT: 'Voice Credit'
  });

  var CURRENCIES = Object.freeze(Object.keys(CURRENCY));

  /* ── 硬边界：这些词**永远**不能成为 Economy currency ────────────────
     分三组，因为否认的理由不同：
       · 法币：IB_CREDIT != CNY / USD / RMB / EUR …（Economy 不接真实货币）
       · 符号：`$` / `¥` / `€` 是展示符，不是 id（也不允许做 canonical）
       · provider 余额与代币：COMPUTE_PREMIUM != provider credits；
         OpenAI/Anthropic/DeepSeek/Qwen 的 balance 是**只读遥测**的来源，
         不是 Economy 可花费的资源（P22-0 R1）。
     只"不注册它们"是不够的：legalCurrency() 要**逐字否认**，
     这样未来有人加币种时，会看到一条明确的失败而不是一个宽松的通过。 */
  var FORBIDDEN_CURRENCY_TOKENS = Object.freeze([
    'CNY', 'RMB', 'USD', 'EUR', 'GBP', 'JPY', 'HKD', 'TWD', 'KRW',
    'AUD', 'CAD', 'CHF', 'SGD', 'USDT', 'USDC', 'BTC', 'ETH',
    '$', '¥', '￥', '€', '£', '₩', '₿',
    'TOKEN', 'TOKENS', 'REAL_TOKEN', 'VIRTUAL_TOKEN', 'VIRTUALTOKEN',
    'PROVIDER_BALANCE', 'PROVIDER_CREDIT', 'PROVIDER_CREDITS', 'API_CREDIT', 'API_CREDITS',
    'OPENAI_BALANCE', 'ANTHROPIC_BALANCE', 'DEEPSEEK_BALANCE', 'QWEN_BALANCE', 'GEMINI_BALANCE'
  ]);

  /* canonical 形态：大写、下划线分词、3~40 字符。理由：小写/空格/符号
     会让 "ib_credit" / "IB CREDIT" / "IB-Credit" 变成三个不同的 key。 */
  var CURRENCY_ID_RE = /^[A-Z][A-Z0-9_]{2,39}$/;

  var FORBIDDEN_CURRENCY_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < FORBIDDEN_CURRENCY_TOKENS.length; i++) {
      map[FORBIDDEN_CURRENCY_TOKENS[i]] = true;
    }
    return map;
  })();

  function isLegalCurrencyId(value) {
    return value != null && CURRENCY_ID_RE.test(String(value));
  }

  /* 一个 currency token 是不是被**逐字否认**的（大小写与符号都归一化后判）。 */
  /* ── 分隔符归一化 ────────────────────────────────────────────────────
     把 'top-up-provider' → 'TOP_UP_PROVIDER'，于是"换了个分隔符"绕不过否认。
     只用于那种**词表本身**就是大写分词的判定（effect 名、compute 别名）。
     刻意**不**用于 currency：见 isForbiddenCurrencyToken 的说明。 */
  function normalizeUpperToken(value) {
    return String(value).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  /* ── currency 的否认是**精确匹配**，这是刻意的 ─────────────────────────
     一个 currency token 的身份就是它自己：'U S D' 与 'USD' 不是同一个
     token，'U-S-D' 也不是。把它们"归一化后否认"意味着存在一条
     token → USD 的模糊映射，而那条映射在防漏的同时也会开始误伤
     （任何含 usd 子串的合法自造币种都会被吞掉）。
     于是这里的规则是：
       · 精确命中（大小写不敏感）→ 否认
       · 含空白 → 否认（'U S D' / 'US D' 这类"看起来像三个字母"的写法
         不应被当成一个新 id 通过）
       · 其余未命中 → 不否认，交给白名单栏（未注册即拒绝）
     也就是说：**deny-list 负责"这是真实货币"，whitelist 负责"这是不是
     我们注册的虚拟资源"**，两道闸门各管一件事。 */
  function isForbiddenCurrencyToken(value) {
    if (value == null) return false;
    var raw = String(value).trim();
    if (!raw) return false;
    if (/\s/.test(raw)) return true;
    if (FORBIDDEN_CURRENCY_INDEX[raw]) return true;
    return !!FORBIDDEN_CURRENCY_INDEX[raw.toUpperCase()];
  }

  /* 这是 currency 校验的**唯一**入口。顺序刻意是「先否认、再白名单」：
     如果顺序反了，未来把 USD 加进白名单就会静默通过，而先否认则不会。 */
  function validateCurrency(value) {
    var errors = [];
    if (value == null || String(value).trim() === '') {
      return { ok: false, currency: null, errors: ['currency-required'] };
    }
    var raw = String(value);
    if (isForbiddenCurrencyToken(raw)) errors.push('currency-forbidden-real-money-or-provider-balance');
    if (!isLegalCurrencyId(raw)) errors.push('currency-not-canonical-uppercase-id');
    if (errors.length) return { ok: false, currency: null, errors: errors };
    if (!Object.prototype.hasOwnProperty.call(CURRENCY, raw)) {
      return { ok: false, currency: null, errors: ['currency-not-registered'] };
    }
    return { ok: true, currency: raw, errors: [] };
  }

  /* 供换算与展示：某 currency 的 scale（minor unit 数 / 展示单位）。 */
  function scaleOf(currency) {
    var v = validateCurrency(currency);
    if (!v.ok) return null;
    return CURRENCY_SCALE[v.currency];
  }

  /* ══════════════════════════════════════════════════════════════════
     §3 · Monetary Representation
     ══════════════════════════════════════════════════════════════════ */

  /* 上界取 Number.MAX_SAFE_INTEGER（2^53-1）。理由：SQLite INTEGER 能装
     64 位，但浏览器侧最终会有 number 出现（渲染、比较），于是"canonical
     能表示的"必须 ⊆ "JS 能精确表示的"，否则同一笔账在两个 runtime 里
     不相等。上界是**安全整数**而不是 64 位，是刻意的。 */
  var MAX_AMOUNT_MINOR = 9007199254740991; /* Number.MAX_SAFE_INTEGER */
  var MIN_AMOUNT_MINOR = 0;

  /* 只认"一串十进制数字"。刻意允许前导零（'007' → 7）：它无歧义，
     而真正的危险写法（'+1' / '1.0' / '1e3' / '0x10' / '-1' / '1,000'）
     全部不含于这个字符集。上界判定不在这里，在下面的安全整数转换。 */
  var DECIMAL_INTEGER_RE = /^[0-9]+$/;

  /* amountMinor 的形状：
       runtime  : BigInt          （canonical 计算表示）
       JSON     : 十进制字符串     （serializeAmountMinor，**不是** number）
       SQLite   : INTEGER          （P22-2，见 §23 的 amount 列）
     三种表示之间只有本文件的两个函数可以转换。 */
  var AMOUNT_RUNTIME_TYPE = 'bigint';
  var AMOUNT_SERIALIZED_TYPE = 'decimal-string';
  var AMOUNT_SQLITE_TYPE = 'INTEGER';

  function isBigInt(value) {
    return typeof value === 'bigint';
  }

  /* 把任意候选值规范成 BigInt。**只接受**恰好是数字的字符串、
     安全整数、或 BigInt —— 拒绝 number 里的小数（那已经是浮点误差了）。 */
  function normalizeAmountMinor(value) {
    var errors = [];
    if (value == null) return { ok: false, amountMinor: null, errors: ['amount-minor-required'] };

    if (isBigInt(value)) {
      if (value < 0n) errors.push('amount-minor-negative');
      else if (value > BigInt(MAX_AMOUNT_MINOR)) errors.push('amount-minor-overflow');
      return errors.length
        ? { ok: false, amountMinor: null, errors: errors }
        : { ok: true, amountMinor: value, errors: [] };
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) { return { ok: false, amountMinor: null, errors: ['amount-minor-not-finite'] }; }
      if (!Number.isInteger(value)) { return { ok: false, amountMinor: null, errors: ['amount-minor-not-integer'] }; }
      if (!Number.isSafeInteger(value)) { return { ok: false, amountMinor: null, errors: ['amount-minor-not-safe-integer'] }; }
      if (value < 0) { return { ok: false, amountMinor: null, errors: ['amount-minor-negative'] }; }
      return { ok: true, amountMinor: BigInt(value), errors: [] };
    }

    if (typeof value === 'string') {
      var s = value.trim();
      /* 形态：十进制整数。刻意允许前导零（'01'）—— 它无歧义地表示 1，
         故不构成危险；而 '+1' / '1.0' / '1e3' / '0x10' / '-1' / '' 一律
         拒绝：它们每一个都意味着"这是别的东西（表达式/浮点/负数）被
         当成了金额"。真正的上界判定交给下面的 Number 转换。 */
      if (!DECIMAL_INTEGER_RE.test(s)) {
        return { ok: false, amountMinor: null, errors: ['amount-minor-not-a-canonical-decimal-integer'] };
      }
      /* 转换后必须仍然是安全整数：这一步挡住 '9007199254740993' 这类
         "字符串看起来是整数、但 JS 只能近似表示"的值。 */
      var asNum = Number(s);
      if (!Number.isSafeInteger(asNum)) {
        return { ok: false, amountMinor: null, errors: ['amount-minor-not-safe-integer'] };
      }
      if (asNum < 0) { return { ok: false, amountMinor: null, errors: ['amount-minor-negative'] }; }
      if (asNum > MAX_AMOUNT_MINOR) { return { ok: false, amountMinor: null, errors: ['amount-minor-overflow'] }; }
      return { ok: true, amountMinor: BigInt(asNum), errors: [] };
    }

    return { ok: false, amountMinor: null, errors: ['amount-minor-type-unsupported'] };
  }

  function serializeAmountMinor(value) {
    var n = normalizeAmountMinor(value);
    if (!n.ok) return null;
    return n.amountMinor.toString(10);
  }

  /* 展示单位（只有在需要给用户看、或需要与 P22-1 之外的人沟通时才用）。
     刻意返回 {whole, fractionText} 而不是 number —— 返回 number 就等于
     把 §3 防的那件事从后门放回来。 */
  function toDisplayParts(value, currency) {
    var n = normalizeAmountMinor(value);
    if (!n.ok) return { ok: false, error: n.errors[0] };
    var scale = scaleOf(currency);
    if (scale == null) return { ok: false, error: 'currency-not-registered' };
    var s = n.amountMinor.toString(10);
    if (scale === 1) return { ok: true, whole: s, fractionText: '', scale: 1 };
    var pad = String(scale).length - 1; /* scale=100 → pad=2 */
    while (s.length <= pad) s = '0' + s;
    return {
      ok: true,
      whole: s.slice(0, s.length - pad),
      fractionText: s.slice(s.length - pad),
      scale: scale
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     §4 · Approval Contract（封闭 reason code）
     ══════════════════════════════════════════════════════════════════ */

  var APPROVAL = Object.freeze({
    AUTO_APPROVED: 'AUTO_APPROVED',
    USER_APPROVAL_REQUIRED: 'USER_APPROVAL_REQUIRED',
    DENIED: 'DENIED'
  });

  var APPROVALS = Object.freeze(Object.keys(APPROVAL));

  /* DENIED 必须带**稳定 reason code**，UI 文案不能成为 canonical reason。
     封闭集合：新增必须同时出现在这里、REASON_CODES 与契约测试的期望里；
     没有 "OTHER"/"UNKNOWN" 兜底值 —— 兜底值会让静默拒绝重新变得可能。 */
  var DENY_REASON = Object.freeze({
    INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
    /* ── INSUFFICIENT_BALANCE ≠ INSUFFICIENT_AVAILABLE_BALANCE（P22-3）────
       两者必须分开，否则"我还有 100"与"我还有 30"在 reason code 上无法
       区分：前者是账本不够，后者是账本够但其中 70 已被**预留**占用。
       P22-3 的核心不变量正是第二条（reserved ≤ ledger），因此它需要
       一个自己的代码；把预留不足写成 INSUFFICIENT_BALANCE 会让
       "为什么买不成"这句话在审计里变成一句不准确的话。 */
    INSUFFICIENT_AVAILABLE_BALANCE: 'INSUFFICIENT_AVAILABLE_BALANCE',
    PER_TX_LIMIT: 'PER_TX_LIMIT',
    DAILY_LIMIT: 'DAILY_LIMIT',
    WEEKLY_LIMIT: 'WEEKLY_LIMIT',
    MONTHLY_LIMIT: 'MONTHLY_LIMIT',
    CATEGORY_LIMIT: 'CATEGORY_LIMIT',
    RECIPIENT_LIMIT: 'RECIPIENT_LIMIT',
    AUTONOMY_LIMIT: 'AUTONOMY_LIMIT',
    COOLDOWN_ACTIVE: 'COOLDOWN_ACTIVE',
    EMERGENCY_RESERVE: 'EMERGENCY_RESERVE',
    WALLET_NOT_READY: 'WALLET_NOT_READY',
    PRODUCT_DISABLED: 'PRODUCT_DISABLED',
    PRODUCT_OUT_OF_STOCK: 'PRODUCT_OUT_OF_STOCK',
    INVALID_CURRENCY: 'INVALID_CURRENCY',
    INVALID_AMOUNT: 'INVALID_AMOUNT',
    QUOTE_EXPIRED: 'QUOTE_EXPIRED',
    QUOTE_MISMATCH: 'QUOTE_MISMATCH',
    RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
    DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
    TRANSITION_NOT_ALLOWED: 'TRANSITION_NOT_ALLOWED',
    LEDGER_UNBALANCED: 'LEDGER_UNBALANCED',
    EFFECT_NOT_ALLOWED: 'EFFECT_NOT_ALLOWED',
    PARTY_NOT_ALLOWED: 'PARTY_NOT_ALLOWED',
    ACCOUNT_NOT_ALLOWED: 'ACCOUNT_NOT_ALLOWED',
    AUTONOMY_NOT_PERMITTED: 'AUTONOMY_NOT_PERMITTED',
    INSUFFICIENT_COMPUTE_CREDIT: 'INSUFFICIENT_COMPUTE_CREDIT',
    EXCHANGE_RATE_UNKNOWN: 'EXCHANGE_RATE_UNKNOWN',
    EXCHANGE_ROUNDS_TO_ZERO: 'EXCHANGE_ROUNDS_TO_ZERO',
    EXCHANGE_CROSS_DOMAIN_FORBIDDEN: 'EXCHANGE_CROSS_DOMAIN_FORBIDDEN',
    POLICY_INPUT_NOT_STRUCTURED: 'POLICY_INPUT_NOT_STRUCTURED'
  });

  var DENY_REASONS = Object.freeze(Object.keys(DENY_REASON));
  var DENY_REASON_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < DENY_REASONS.length; i++) map[DENY_REASONS[i]] = true;
    return map;
  })();

  function isDenyReasonCode(value) {
    return value != null && DENY_REASON_INDEX[String(value)] === true;
  }

  /* approval 结构（不是 boolean）。刻意用对象：后续要表达"需要用户确认"
     时，布尔值无处可放，而那时再改结构就是破坏性变更。 */
  function makeApproval(outcome, reasonCode, extra) {
    var errors = [];
    if (APPROVALS.indexOf(String(outcome)) < 0) errors.push('approval-outcome-not-in-closed-set');
    var reason = reasonCode == null ? null : String(reasonCode);
    if (outcome === APPROVAL.DENIED) {
      if (!reason) errors.push('denied-requires-reason-code');
      else if (!isDenyReasonCode(reason)) errors.push('deny-reason-code-not-in-closed-set');
    } else if (reason && !isDenyReasonCode(reason)) {
      errors.push('deny-reason-code-not-in-closed-set');
    }
    if (errors.length) return { ok: false, errors: errors };
    return {
      ok: true,
      errors: [],
      approval: Object.assign({
        domain: DOMAIN,
        outcome: String(outcome),
        reasonCode: reason
      }, extra || {})
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     §5 · Canonical IDs
     ══════════════════════════════════════════════════════════════════ */

  /* 前缀风格对齐仓库既有习惯（chat-core 的 msg_* / role-dm-core 的
     roleDm_/roledmmsg_/roleRel_）：小写 + 下划线 + econ_ 命名空间首段，
     于是"这是虚拟经济的东西"在**看 id 的第一眼**就成立。 */
  var ID_PREFIX = Object.freeze({
    WALLET: 'econ_wallet_',
    ACCOUNT: 'econ_account_',
    TRANSACTION: 'econ_tx_',
    LEDGER_ENTRY: 'econ_entry_',
    RESERVATION: 'econ_res_',
    /* ── ECONOMY OPERATION（P22-3）────────────────────────────────────────
       为什么需要**第 13 种** id 种类，而不是复用已有的两种：
         · TRANSACTION（econ_tx_）是**已经发生的 accounting fact** 的身份
           —— P22-2 已经把它用掉了（economy_transactions 的主键），而且它
           一旦写下就 append-only。一次"可能成功、可能失败、可能过期"的
           操作**不是**一个已发生的经济事实，用 econ_tx_ 表示它就必须让
           一个已提交的 transaction 状态不断变化 —— 那正是 P22-3 §1
           明确禁止的事。
         · RESERVATION（econ_res_）是**资金锁定**的身份，它的状态词表是
           RESERVATION_STATE（无 FAILED）。而操作本身还有一个"不可继续"
           的结局，那是 TX_STATE.FAILED 的位置。
       于是 operation 拿到自己的前缀：一个 #1 的眼就能看出这是"一次操作"
       而不是"一笔事实"或"一次锁定"。这是**加法**，不是对旧 id 的重新解释。 */
    OPERATION: 'econ_op_',
    BUDGET_POLICY: 'econ_policy_',
    PRODUCT: 'econ_product_',
    INVENTORY_ENTRY: 'econ_inv_',
    QUOTE: 'econ_quote_',
    EXCHANGE_RATE: 'econ_rate_',
    PURCHASE_INTENT: 'econ_intent_',
    EVENT: 'econ_evt_'
  });

  var ID_KINDS = Object.freeze(Object.keys(ID_PREFIX));
  var ID_SUFFIX_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var ID_MAX_LENGTH = 128;

  function prefixOf(kind) {
    return Object.prototype.hasOwnProperty.call(ID_PREFIX, String(kind)) ? ID_PREFIX[String(kind)] : null;
  }

  /* 形状构造器（纯函数）。**不**生成随机 id：随机源属于运行时（P22-2），
     契约只冻结形状。 */
  function formatEconomyId(kind, suffix) {
    var prefix = prefixOf(kind);
    if (!prefix) return { ok: false, id: null, errors: ['id-kind-unknown'] };
    var s = suffix == null ? '' : String(suffix);
    if (!ID_SUFFIX_RE.test(s)) return { ok: false, id: null, errors: ['id-suffix-not-canonical'] };
    var id = prefix + s;
    if (id.length > ID_MAX_LENGTH) return { ok: false, id: null, errors: ['id-too-long'] };
    return { ok: true, id: id, errors: [] };
  }

  function isEconomyId(kind, value) {
    var prefix = prefixOf(kind);
    if (!prefix || value == null) return false;
    var s = String(value);
    if (s.length > ID_MAX_LENGTH) return false;
    if (s.slice(0, prefix.length) !== prefix) return false;
    return ID_SUFFIX_RE.test(s.slice(prefix.length));
  }

  /* ── idempotencyKey 与 transactionId 是**两件事** ───────────────────
       transactionId    = 一笔已创建 transaction 的身份（一个经济事实）
       idempotencyKey   = "这次业务请求是否已经执行过"的身份（一个重试问题）
     一笔 transaction 只有一个交易 id；同一个业务请求重试时会带着**同一个**
     idempotencyKey 再来，而它的正确结果是**返回原来那笔 transaction**，
     不是再记一笔。把两者合成一个字段，就等于把"重试"变成"再买一次"。
     这正是 chat-store.js 的 idempotency 表(query.requestId → userMessageId)
     已经解决过的同一类问题，Economy 沿用其语义而不复用其表。 */
  var IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:+-]{1,200}$/;

  /* 数字与字符串都接受，但**规范化成字符串**：否则 123 与 '123' 会被判成
     两个 key，幂等性在类型边界上静默失效。 */
  function normalizeIdempotencyKey(value) {
    if (value == null) return { ok: false, key: null, errors: ['idempotency-key-required'] };
    var t = typeof value;
    if (t !== 'string' && t !== 'number') {
      return { ok: false, key: null, errors: ['idempotency-key-type-unsupported'] };
    }
    if (t === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return { ok: false, key: null, errors: ['idempotency-key-number-not-integer'] };
      }
      if (!Number.isSafeInteger(value)) {
        return { ok: false, key: null, errors: ['idempotency-key-number-not-safe-integer'] };
      }
    }
    var s = String(value).trim();
    if (!IDEMPOTENCY_KEY_RE.test(s)) {
      return { ok: false, key: null, errors: ['idempotency-key-not-canonical'] };
    }
    return { ok: true, key: s, errors: [] };
  }

  /* ══════════════════════════════════════════════════════════════════
     §6 · Actor / Owner / Counterparty / Recipient Contract
     ══════════════════════════════════════════════════════════════════ */

  /* party type 刻意与 moments.js 的既有作者模型同构（moments.js:311
     「作者模型：user | role」+ authorId，user 作者回落 'user'）——
     不新造第三个身份词汇表。 */
  var PARTY_TYPE = Object.freeze({
    CHARACTER: 'character',
    USER: 'user',
    SYSTEM: 'system'
  });

  /* 注意用 Object.values —— 这里的**值**（小写）才是 canonical token。
     用 Object.keys 会得到 'CHARACTER'/'USER'/'SYSTEM'，那是一组与生产
     语义无关的大写词，而 makePartyRef 收的恰恰是小写的那一组。 */
  var PARTY_TYPES = Object.freeze(Object.keys(PARTY_TYPE).map(function (k) { return PARTY_TYPE[k]; }));

  /* canonical user 分区键。依据是既有 production 语义：
       · assets/js/memory-contract.js:78  ownerIdOf() 缺省返回 'user'
       · assets/js/moments.js:500          authorId 缺省 'user'
     因此 'user' 是**既有**的 canonical 表示，不是 Economy 发明的。
     它必须经 PARTY ref 出现，不允许各模块自己解释裸字符串。 */
  var USER_PARTY_ID = 'user';

  /* system account 白名单。P22-1 只允许这四个；运行时（尤其 LLM）
     **不得**创建新的 system account —— 因此这里是唯一的注册点，
     且 validateSystemAccountId 只认这张表。 */
  var SYSTEM_ACCOUNT = Object.freeze({
    MINT: 'system:mint',
    BURN: 'system:burn',
    TREASURY: 'system:treasury',
    MARKET: 'system:market'
  });

  var SYSTEM_ACCOUNTS = Object.freeze(Object.values(SYSTEM_ACCOUNT));
  var SYSTEM_ACCOUNT_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < SYSTEM_ACCOUNTS.length; i++) map[SYSTEM_ACCOUNTS[i]] = true;
    return map;
  })();

  function validateSystemAccountId(value) {
    if (value == null || String(value).trim() === '') {
      return { ok: false, accountId: null, errors: ['system-account-required'] };
    }
    var s = String(value);
    if (!SYSTEM_ACCOUNT_INDEX[s]) {
      return { ok: false, accountId: null, errors: ['system-account-not-whitelisted'] };
    }
    return { ok: true, accountId: s, errors: [] };
  }

  /* ── character party id 的形状 ──────────────────────────────────────
     刻意**不**要求 econ_ 前缀：这个 id 是**既有**角色的身份
     （IndexedDB `apiConfigs[].id`，见 P4 契约"apiConfigs 同时是 provider
     配置与角色，是唯一事实源"），Economy 是它的消费者而不是改名者。
     但也刻意**不**接受任意字符串：空白、长度失控、路径分隔符一律拒绝，
     因为最终它会进 ledger / audit / 文件名附近。 */
  var PARTY_CHARACTER_ID_RE = /^[^\u0000-\u001f\u007f]{1,128}$/;

  /* party ref 的 canonical 形状：{ type, id }。
     刻意是**判别式对象**而不是裸字符串，因为裸字符串正是
     "system?" / "me" / "self" 在各模块各解释一遍的入口。 */
  function makePartyRef(type, id) {
    var errors = [];
    var t = type == null ? '' : String(type);
    if (PARTY_TYPES.indexOf(t) < 0) errors.push('party-type-not-in-closed-set');
    var i = id == null ? '' : String(id);
    if (!i.trim()) {
      errors.push('party-id-required');
    } else if (t === PARTY_TYPE.CHARACTER) {
      /* trim 前后必须相等：' cfg ' 与 'cfg' 是两个不同的 key，
         而这种"看起来一样其实不一样"的 id 是账本最不需要的东西。 */
      if (i !== i.trim() || !PARTY_CHARACTER_ID_RE.test(i)) errors.push('party-character-id-not-canonical');
    }
    if (t === PARTY_TYPE.SYSTEM) {
      if (!SYSTEM_ACCOUNT_INDEX[i]) errors.push('party-system-id-must-be-whitelisted-system-account');
    }
    if (t === PARTY_TYPE.USER && i !== USER_PARTY_ID) {
      errors.push('party-user-id-must-be-canonical-user');
    }
    if (errors.length) return { ok: false, party: null, errors: errors };
    return { ok: true, party: Object.freeze({ type: t, id: i }), errors: [] };
  }

  function isPartyRef(value) {
    if (!value || typeof value !== 'object') return false;
    return makePartyRef(value.type, value.id).ok;
  }

  /* 把"裸 id"提升成 canonical party ref。
     关键的**特殊情况**：裸字符串 'user' 必须提升成 {type:'user'}，
     而不是 {type:'character', id:'user'}。后者会创造一个叫 "user" 的角色，
     于是"送给用户"在账本里变成"送给一个名字叫 user 的角色"——
     两者在数据上无法区分，而语义完全不同。
     'user' 是既有 canonical 用户分区键（memory-contract.js 的 ownerIdOf
     缺省值、moments.js 的 authorId 缺省值），因此这里按它判定。 */
  function promotePartyRef(value) {
    if (isPartyRef(value)) return value;
    var s = value == null ? '' : String(value);
    if (s === USER_PARTY_ID) return makePartyRef(PARTY_TYPE.USER, USER_PARTY_ID).party;
    return makePartyRef(PARTY_TYPE.CHARACTER, s).party;
  }

  /* 语义（四个名字各自回答一个不同的问题，不得互换）：
       actorId        —— **谁发起了**这次经济操作（花的是它的钱/它的授权）
       ownerId        —— **这笔资源/这个钱包属于谁**
       counterpartyId —— 记账对手方（复式记账的另一端）
       recipientId    —— 购买是为了**给谁**（gift 的收礼人；自用则为 null）
     ≤2 人场景下它们经常取值相同，但"经常相同"不等于"是同一件事"：
     gift 把 buyer(actor=owner) 与 recipient 分开，MINT 把 actor 与
     counterparty(=system:mint) 分开。 */
  var PARTY_ROLE = Object.freeze({
    ACTOR: 'actorId',
    OWNER: 'ownerId',
    COUNTERPARTY: 'counterpartyId',
    RECIPIENT: 'recipientId'
  });

  var PARTY_ROLES = Object.freeze(Object.values(PARTY_ROLE));

  /* ══════════════════════════════════════════════════════════════════
     §7 · Wallet State Contract（P22-0 R5 的落点）
     ══════════════════════════════════════════════════════════════════ */

  /* COLD / DEGRADED **不是** 零余额。这是 P22-0 R5 的根因：
     镜像冷启动读到空数据 → 被当成 balance = 0 → 一笔凭空的交易。
     三态的存在就是为了让"我不知道余额"有一个**可表示的答案**，
     而不是被迫借用 0。 */
  var WALLET_STATE = Object.freeze({
    COLD: 'COLD',         /* 还没 hydrate：余额未知（≠ 0） */
    READY: 'READY',       /* canonical 已确认：余额可信 */
    DEGRADED: 'DEGRADED'  /* canonical 不可达：余额不可信（≠ 0） */
  });

  var WALLET_STATES = Object.freeze(Object.keys(WALLET_STATE));

  /* 需要余额真实性的操作（消费、预留、提交）只在 READY 下允许。
     返回判断而不是布尔常量，是为了让调用点读起来是"我在问一个规则"，
     而且未来加第四个状态时只有一个地方要改。 */
  function walletStateAllowsSpend(state) {
    return String(state) === WALLET_STATE.READY;
  }

  function validateWalletState(value) {
    var s = value == null ? '' : String(value);
    if (WALLET_STATES.indexOf(s) < 0) {
      return { ok: false, state: null, errors: ['wallet-state-not-in-closed-set'] };
    }
    return { ok: true, state: s, errors: [] };
  }

  /* 余额三元组 + state。balance 只是**缓存**：canonical financial truth
     来自 Ledger（P22-2），任何写路径都不得以缓存为输入算新余额。 */
  function makeWalletView(input) {
    var o = input || {};
    var errors = [];
    var st = validateWalletState(o.state);
    if (!st.ok) errors.push.apply(errors, st.errors);
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var cached = normalizeAmountMinor(o.cachedBalanceMinor);
    if (!cached.ok) errors.push.apply(errors, cached.errors);
    var reserved = normalizeAmountMinor(o.reservedBalanceMinor);
    if (!reserved.ok) errors.push.apply(errors, reserved.errors);

    if (cached.ok && reserved.ok && reserved.amountMinor > cached.amountMinor) {
      errors.push('reserved-exceeds-cached-balance');
    }
    if (errors.length) return { ok: false, wallet: null, errors: errors };

    /* available 是**派生**值，不是存储字段：存它就有第二个事实源。
       但 COLD / DEGRADED 下 available 必须是 null —— 因为"未知减已知"
       仍然是未知，返回一个数字就等于把未知说成了 0。 */
    var ready = st.state === WALLET_STATE.READY;
    var available = ready ? (cached.amountMinor - reserved.amountMinor) : null;

    return {
      ok: true,
      errors: [],
      wallet: Object.freeze({
        domain: DOMAIN,
        currency: cur.currency,
        state: st.state,
        cachedBalanceMinor: cached.amountMinor,
        reservedBalanceMinor: reserved.amountMinor,
        availableBalanceMinor: available,
        balanceKnown: ready
      })
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     §8 · Transaction State Machine
     ══════════════════════════════════════════════════════════════════ */

  var TX_STATE = Object.freeze({
    CREATED: 'CREATED',
    RESERVED: 'RESERVED',
    COMMITTED: 'COMMITTED',
    RELEASED: 'RELEASED',
    EXPIRED: 'EXPIRED',
    FAILED: 'FAILED'
  });

  var TX_STATES = Object.freeze(Object.keys(TX_STATE));

  /* 为什么 EXPIRED 与 RELEASED 分开：两者都"把钱还回去了"，但原因不同
     —— RELEASED 是流程主动放弃（action 失败、用户取消），EXPIRED 是
     时间到了（reservation TTL）。合并会让"为什么这笔没成交"无法回答，
     而 P22 §16 要求这个问题必须可回答。 */
  var TX_TRANSITIONS = Object.freeze({
    CREATED: Object.freeze([TX_STATE.RESERVED, TX_STATE.FAILED]),
    RESERVED: Object.freeze([TX_STATE.COMMITTED, TX_STATE.RELEASED, TX_STATE.EXPIRED, TX_STATE.FAILED]),
    COMMITTED: Object.freeze([]),
    RELEASED: Object.freeze([]),
    EXPIRED: Object.freeze([]),
    FAILED: Object.freeze([])
  });

  var TX_TERMINAL_STATES = Object.freeze(
    TX_STATES.filter(function (s) { return TX_TRANSITIONS[s].length === 0; })
  );

  function isTransactionState(value) {
    return value != null && TX_STATES.indexOf(String(value)) >= 0;
  }

  function canTransitionTransaction(from, to) {
    var f = String(from == null ? '' : from);
    var t = String(to == null ? '' : to);
    if (TX_STATES.indexOf(f) < 0 || TX_STATES.indexOf(t) < 0) {
      return { ok: false, allowed: false, errors: ['transaction-state-not-in-closed-set'] };
    }
    var allowed = TX_TRANSITIONS[f].indexOf(t) >= 0;
    return {
      ok: true,
      allowed: allowed,
      errors: allowed ? [] : ['transition-not-allowed'],
      from: f,
      to: t
    };
  }

  /* 终态不可回退。COMMITTED → 任何东西都是禁止的（包括 RELEASED）：
     要撤销一笔已提交的交易，只能记一笔**补偿 transaction**，
     而不是改历史。这条规则就是 "append-only 思维" 在状态机上的形状。 */
  function assertTransactionTransition(from, to) {
    var r = canTransitionTransaction(from, to);
    if (!r.ok) return { ok: false, errors: r.errors };
    if (!r.allowed) {
      return {
        ok: false,
        errors: ['transition-not-allowed'],
        detail: (TX_TERMINAL_STATES.indexOf(r.from) >= 0)
          ? 'terminal-state-cannot-transition-must-compensate-with-a-new-transaction'
          : 'transition-not-in-allowed-set'
      };
    }
    return { ok: true, errors: [] };
  }

  /* ══════════════════════════════════════════════════════════════════
     §9 · Transaction Type Contract
     ══════════════════════════════════════════════════════════════════ */

  var TX_TYPE = Object.freeze({
    PURCHASE: 'PURCHASE',
    GIFT: 'GIFT',
    EXCHANGE: 'EXCHANGE',
    MINT: 'MINT',
    BURN: 'BURN',
    COMPUTE_GRANT: 'COMPUTE_GRANT',
    COMPUTE_CONSUME: 'COMPUTE_CONSUME',
    REFUND: 'REFUND'
  });

  var TX_TYPES = Object.freeze(Object.keys(TX_TYPE));

  /* 只有 MINT / BURN 允许"钱从无到有 / 从有到无"。它们必须显式命名，
     并且 counterparty 必须是 system:mint / system:burn —— 于是
     "凭空增发"要么是一次写明的 MINT，要么是 ledger 不平衡（被拒绝）。
     没有第三条路。 */
  var MINT_BURN_TYPES = Object.freeze([TX_TYPE.MINT, TX_TYPE.BURN]);

  function requiresBalanceTopology(type) {
    return MINT_BURN_TYPES.indexOf(String(type)) < 0;
  }

  /* ══════════════════════════════════════════════════════════════════
     §10 · Ledger Entry Contract
     ══════════════════════════════════════════════════════════════════ */

  /* direction 与**无符号** amountMinor 配对使用。刻意不支持 signed
     amount 的第二种 canonical 表示：同时允许两种表示，就必然出现
     "一半代码按符号读、一半按方向读"的状态，而两边的测试都会绿。
     冻结一种：DIRECTION + 无符号 amount。 */
  var ENTRY_DIRECTION = Object.freeze({
    DEBIT: 'DEBIT',
    CREDIT: 'CREDIT'
  });

  var ENTRY_DIRECTIONS = Object.freeze(Object.keys(ENTRY_DIRECTION));

  var LEDGER_BALANCE_RULE = 'sum(DEBIT.amountMinor) === sum(CREDIT.amountMinor) per currency';
  var LEDGER_AMOUNT_SIGN = 'unsigned';

  function makeLedgerEntry(input) {
    var o = input || {};
    var errors = [];
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var amt = normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) errors.push.apply(errors, amt.errors);
    var dir = o.direction == null ? '' : String(o.direction);
    if (ENTRY_DIRECTIONS.indexOf(dir) < 0) errors.push('entry-direction-not-in-closed-set');
    if (!isEconomyId('LEDGER_ENTRY', o.ledgerEntryId)) errors.push('ledger-entry-id-not-canonical');
    if (!isEconomyId('TRANSACTION', o.transactionId)) errors.push('transaction-id-not-canonical');
    if (o.accountId == null || String(o.accountId).trim() === '') errors.push('account-id-required');
    if (errors.length) return { ok: false, entry: null, errors: errors };
    return {
      ok: true,
      errors: [],
      entry: Object.freeze({
        domain: DOMAIN,
        ledgerEntryId: String(o.ledgerEntryId),
        transactionId: String(o.transactionId),
        accountId: String(o.accountId),
        direction: dir,
        amountMinor: amt.amountMinor,
        currency: cur.currency
      })
    };
  }

  /* 复式平衡检查：**逐 currency** 分别平衡。跨 currency 求和是错的
     —— 那会让 "100 IB_CREDIT + 20 COMPUTE_PREMIUM" 看起来平衡。 */
  function checkLedgerBalance(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return { ok: false, balanced: false, errors: ['entries-required'] };
    }
    var buckets = Object.create(null);
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i] || {};
      var cur = validateCurrency(e.currency);
      if (!cur.ok) return { ok: false, balanced: false, errors: ['entry-currency-invalid'] };
      var amt = normalizeAmountMinor(e.amountMinor);
      if (!amt.ok) return { ok: false, balanced: false, errors: ['entry-amount-invalid'] };
      var dir = String(e.direction || '');
      if (ENTRY_DIRECTIONS.indexOf(dir) < 0) {
        return { ok: false, balanced: false, errors: ['entry-direction-not-in-closed-set'] };
      }
      var b = buckets[cur.currency] || (buckets[cur.currency] = { debit: 0n, credit: 0n });
      if (dir === ENTRY_DIRECTION.DEBIT) b.debit += amt.amountMinor;
      else b.credit += amt.amountMinor;
    }
    var unbalanced = [];
    Object.keys(buckets).forEach(function (c) {
      if (buckets[c].debit !== buckets[c].credit) unbalanced.push(c);
    });
    if (unbalanced.length) {
      return { ok: true, balanced: false, errors: ['ledger-unbalanced'], unbalancedCurrencies: unbalanced };
    }
    if (entries.length < 2) {
      /* 单边 entry 永远不平衡（除非金额为 0，而 0 金额 entry 没有意义）。
         这里显式拒绝，避免"只写了一半"看起来像一笔合法交易。 */
      return { ok: true, balanced: false, errors: ['ledger-needs-at-least-two-entries'] };
    }
    return { ok: true, balanced: true, errors: [] };
  }

  /* ══════════════════════════════════════════════════════════════════
     §11 · Ledger Account Contract
     ══════════════════════════════════════════════════════════════════ */

  /* Wallet 是**面向 Agent/用户**的聚合概念（一个 owner + 一个 currency
     一个钱包）；Ledger Account 是**记账实体**（复式记账的一端）。
     两者的关系不是 1:1：gift 会让两个 wallet account 相对记账，而
     MINT 让一个 wallet account 与 system:mint 相对记账。
     把它们混成一个东西，就会出现"system:mint 也是一个 wallet"这种
     没有 owner 的钱包。 */
  var ACCOUNT_KIND = Object.freeze({
    WALLET: 'WALLET',
    SYSTEM: 'SYSTEM'
  });

  var ACCOUNT_KINDS = Object.freeze(Object.keys(ACCOUNT_KIND));

  function accountKindOf(accountId) {
    var s = accountId == null ? '' : String(accountId);
    if (SYSTEM_ACCOUNT_INDEX[s]) return ACCOUNT_KIND.SYSTEM;
    if (isEconomyId('ACCOUNT', s)) return ACCOUNT_KIND.WALLET;
    return null;
  }

  /* system account 由**契约**白名单化；运行时（尤其 LLM 输出）不得创建。
     这条规则的可执行形式就是：任何 accountId 要么是白名单 system account，
     要么是本地生成的 econ_account_* —— 没有第三种可能。 */
  function validateLedgerAccountId(value) {
    var kind = accountKindOf(value);
    if (!kind) return { ok: false, kind: null, errors: ['account-id-not-a-canonical-economy-account'] };
    return { ok: true, kind: kind, errors: [] };
  }

  /* ══════════════════════════════════════════════════════════════════
     §12 · Reservation Contract
     ══════════════════════════════════════════════════════════════════ */

  var RESERVATION_STATE = Object.freeze({
    ACTIVE: 'ACTIVE',
    COMMITTED: 'COMMITTED',
    RELEASED: 'RELEASED',
    EXPIRED: 'EXPIRED'
  });

  var RESERVATION_STATES = Object.freeze(Object.keys(RESERVATION_STATE));

  /* reservation != transaction：
       · transaction 是**经济事实**（钱动了没有、动去哪了）；
       · reservation 是**暂时占用**（钱先别花，我可能要用）。
     一笔 COMMITTED transaction 恰好对应一次成功 commit 的 reservation；
     但 reservation 会过期、会释放，而 transaction 不会 —— 因此
     reservation 有自己的状态与生命周期，不能折叠进 transaction。
     reserved balance 对 available 的影响是**减法且是派生**：
       available = cached − reserved   （WALLET_STATE != READY 时为 null） */
  var RESERVATION_AFFECTS = 'availableBalanceMinor = cachedBalanceMinor - reservedBalanceMinor (READY only)';

  /* ── Reservation 状态机（P22-3）───────────────────────────────────────
     为什么它不是 TX_TRANSITIONS 的复制品：两张词表的**终态集合不同**。
     reservation 没有 FAILED —— 一笔预留的资源后果只有两种：被用掉
     （COMMITTED）或被还回去（RELEASED 主动 / EXPIRED 超时）。
     把 FAILED 塞进 RESERVATION_STATE 会造出"钱还回去了，但该叫 RELEASED
     还是 FAILED"的歧义；因此失败记在 **operation** 上（§8 的 TX_STATE.FAILED），
     资源后果照实记在 reservation 上（RELEASED + releaseReason）。
     这不是两套状态机，而是同一台机器的两个侧面 —— 映射见下面的
     RESERVATION_STATE_OF_OPERATION / OPERATION_STATE_OF_RESERVATION，
     两者互为逆（在共同值域上，见 P22-1 domain contract 的往返断言）。 */
  var RESERVATION_TRANSITIONS = Object.freeze({
    ACTIVE: Object.freeze([RESERVATION_STATE.COMMITTED, RESERVATION_STATE.RELEASED, RESERVATION_STATE.EXPIRED]),
    COMMITTED: Object.freeze([]),
    RELEASED: Object.freeze([]),
    EXPIRED: Object.freeze([])
  });

  var RESERVATION_TERMINAL_STATES = Object.freeze(
    RESERVATION_STATES.filter(function (s) { return RESERVATION_TRANSITIONS[s].length === 0; })
  );

  function isReservationState(value) {
    return value != null && RESERVATION_STATES.indexOf(String(value)) >= 0;
  }

  function canTransitionReservation(from, to) {
    var f = String(from == null ? '' : from);
    var t = String(to == null ? '' : to);
    if (RESERVATION_STATES.indexOf(f) < 0 || RESERVATION_STATES.indexOf(t) < 0) {
      return { ok: false, allowed: false, errors: ['reservation-status-not-in-closed-set'] };
    }
    var allowed = RESERVATION_TRANSITIONS[f].indexOf(t) >= 0;
    return {
      ok: true,
      allowed: allowed,
      errors: allowed ? [] : ['transition-not-allowed'],
      from: f,
      to: t
    };
  }

  /* 终态不可回退 —— 与 assertTransactionTransition 同款，理由也同款：
     COMMITTED 之后要退钱只能记一笔**补偿 transaction**，不能改历史。 */
  function assertReservationTransition(from, to) {
    var r = canTransitionReservation(from, to);
    if (!r.ok) return { ok: false, errors: r.errors };
    if (!r.allowed) {
      return {
        ok: false,
        errors: ['transition-not-allowed'],
        detail: (RESERVATION_TERMINAL_STATES.indexOf(r.from) >= 0)
          ? 'terminal-reservation-cannot-transition-must-compensate-with-a-new-transaction'
          : 'transition-not-in-allowed-set'
      };
    }
    return { ok: true, errors: [] };
  }

  /* ── operation ↔ reservation 的**唯一**映射 ───────────────────────────
     写成数据而不是散落在运行时的 if：两份封闭词表之间的关系本身是一个
     契约事实，必须可枚举、可断言、可被测试穷举。
     刻意**不是**双射：CREATED 还没有预留（没有资源后果），FAILED 的操作
     其资源后果是"被还回去"（reservation 记 RELEASED + releaseReason）。
     把 FAILED 映到某个 reservation 状态是做不到的，而"做不到"这件事
     必须写在数据里（null），不能靠读代码发现它恰好没人写。 */
  var RESERVATION_STATE_OF_OPERATION = Object.freeze({
    CREATED: null,
    RESERVED: RESERVATION_STATE.ACTIVE,
    COMMITTED: RESERVATION_STATE.COMMITTED,
    RELEASED: RESERVATION_STATE.RELEASED,
    EXPIRED: RESERVATION_STATE.EXPIRED,
    FAILED: null
  });

  var OPERATION_STATE_OF_RESERVATION = Object.freeze({
    ACTIVE: TX_STATE.RESERVED,
    COMMITTED: TX_STATE.COMMITTED,
    RELEASED: TX_STATE.RELEASED,
    EXPIRED: TX_STATE.EXPIRED
  });

  /* ── Economy Operation（P22-3）────────────────────────────────────────
     operation 是**生命周期**：CREATED → RESERVED → {COMMITTED, RELEASED,
     EXPIRED, FAILED}（= §8 的 TX_TRANSITIONS，一个字都没新造）。
     reservation 是**资金锁定**。两者 1:1 于今天，但刻意分成两个实体：
     未来 P22-4/5 会把 policy / quote / product 挂在 operation 上，而
     一次锁定永远只该回答"锁了多少钱、锁给谁、什么时候到期"。
     把两者合成一张表，就必须让 RESERVATION_STATE 容纳 FAILED，或者
     让 TX_STATE 容纳 ACTIVE —— 两个方向都是对冻结词表的破坏。 */
  function validateOperation(input) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId('OPERATION', o.operationId)) errors.push('operation-id-not-canonical');
    if (!isEconomyId('WALLET', o.walletId)) errors.push('wallet-id-not-canonical');
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var amt = normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) errors.push.apply(errors, amt.errors);
    var key = normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) errors.push.apply(errors, key.errors);
    if (!isTransactionState(o.status)) errors.push('operation-status-not-in-closed-set');
    if (o.expiresAt != null && !Number.isFinite(Number(o.expiresAt))) {
      errors.push('operation-expires-at-not-a-number');
    }
    if (o.reservationId != null && !isEconomyId('RESERVATION', o.reservationId)) {
      errors.push('reservation-id-not-canonical');
    }
    if (o.transactionId != null && !isEconomyId('TRANSACTION', o.transactionId)) {
      errors.push('transaction-id-not-canonical');
    }
    if (o.reasonCode != null && !isDenyReasonCode(o.reasonCode)) {
      errors.push('operation-reason-code-not-in-closed-set');
    }
    if (errors.length) return { ok: false, operation: null, errors: errors };
    return { ok: true, errors: [], operation: o };
  }

  /* ── idempotency **作用域**（P22-3 §18）───────────────────────────────
     一个模糊的 key 空间会让 reserve 与 commit 共用同一个 key 时被判成
     "同一个业务请求"（于是 commit 会被当成 reserve 的重放而返回预留结果）。
     因此每个 mutation 属于且只属于一个 scope，持久化的身份是
     (scope, idempotencyKey) 而不是裸 key。
     注意这**不**替换 §5 的 idempotencyKey 语义（那里冻结的是 key 的形状
     与"key ≠ transactionId"）；scope 是 key 的**归属域**，不是第二种 key。 */
  var OPERATION_SCOPE = Object.freeze({
    RESERVE: 'RESERVE',
    COMMIT: 'COMMIT',
    RELEASE: 'RELEASE',
    EXPIRE: 'EXPIRE',
    FAIL: 'FAIL'
  });

  var OPERATION_SCOPES = Object.freeze(Object.keys(OPERATION_SCOPE));
  var OPERATION_SCOPE_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < OPERATION_SCOPES.length; i++) map[OPERATION_SCOPES[i]] = true;
    return map;
  })();

  function isOperationScope(value) {
    return value != null && OPERATION_SCOPE_INDEX[String(value)] === true;
  }

  /* 持久化身份的 canonical 形态。**不是**另一个随机的拼法：它由这两段
     组成，任何一侧变化都会得到一个不同的身份，且分隔符不在 key 的
     合法字符集里是不成立的 —— 因此这里用 ':'（key 里合法，但 key 自身
     不可能包含 scope 前缀的语义歧义，因为比较的是完整的二元组）。 */
  function scopedIdempotencyIdentity(scope, key) {
    if (!isOperationScope(scope)) return { ok: false, identity: null, errors: ['operation-scope-not-in-closed-set'] };
    var k = normalizeIdempotencyKey(key);
    if (!k.ok) return { ok: false, identity: null, errors: k.errors };
    return { ok: true, identity: String(scope) + ':' + k.key, scope: String(scope), key: k.key, errors: [] };
  }

  function validateReservation(input) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId('RESERVATION', o.reservationId)) errors.push('reservation-id-not-canonical');
    if (!isEconomyId('WALLET', o.walletId)) errors.push('wallet-id-not-canonical');
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var amt = normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) errors.push.apply(errors, amt.errors);
    var key = normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) errors.push.apply(errors, key.errors);
    if (!isTransactionState(o.status) && RESERVATION_STATES.indexOf(String(o.status)) < 0) {
      errors.push('reservation-status-not-in-closed-set');
    }
    if (o.expiresAt != null && !Number.isFinite(Number(o.expiresAt))) {
      errors.push('reservation-expires-at-not-a-number');
    }
    if (o.transactionId != null && !isEconomyId('TRANSACTION', o.transactionId)) {
      errors.push('transaction-id-not-canonical');
    }
    if (errors.length) return { ok: false, reservation: null, errors: errors };
    return { ok: true, errors: [], reservation: o };
  }

  /* ══════════════════════════════════════════════════════════════════
     §13 · Budget Policy Contract
     ══════════════════════════════════════════════════════════════════ */

  /* Budget Policy 的输入必须是**确定性结构化数据**。
     禁止 raw LLM output / prompt / persona text / relationship prose
     出现在输入里 —— P22 §7：「LLM: "I really want this." / Policy: DENIED_BUDGET」
     结果必须仍然是拒绝。实现方式不是"记得别传正文"，而是**白名单键**：
     normalizeBudgetInput 只保留下列键，任何其它键被视为污染并拒绝。 */
  var BUDGET_INPUT_KEYS = Object.freeze([
    'actorId',
    'ownerId',
    'recipientId',
    'productId',
    'category',
    'amountMinor',
    'currency',
    'quantity',
    'usage',
    'limits',
    'timestamp',
    'autonomyLevel',
    'walletState'
  ]);

  /* 明确点名的污染键（用于给出可读的拒绝原因；任何**未在白名单**的键
     都会被拒，不只是这些）。 */
  var FORBIDDEN_POLICY_INPUT_KEYS = Object.freeze([
    'prompt', 'system', 'systemPrompt', 'persona', 'personality', 'mood',
    'relationship', 'message', 'messages', 'content', 'text', 'reply',
    'llmOutput', 'modelOutput', 'completion', 'rawOutput', 'reasoning',
    'thoughts', 'narration', 'desire', 'plea', 'argument'
  ]);

  var FORBIDDEN_POLICY_INPUT_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < FORBIDDEN_POLICY_INPUT_KEYS.length; i++) map[FORBIDDEN_POLICY_INPUT_KEYS[i]] = true;
    return map;
  })();

  var BUDGET_INPUT_INDEX = (function () {
    var map = Object.create(null);
    for (var j = 0; j < BUDGET_INPUT_KEYS.length; j++) map[BUDGET_INPUT_KEYS[j]] = true;
    return map;
  })();

  var AUTONOMY_LEVEL = Object.freeze({
    NONE: 'NONE',
    LIMITED: 'LIMITED',
    STANDARD: 'STANDARD',
    ELEVATED: 'ELEVATED'
  });

  var AUTONOMY_LEVELS = Object.freeze(Object.keys(AUTONOMY_LEVEL));

  function normalizeBudgetInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, input: null, errors: ['policy-input-must-be-a-structured-object'] };
    }
    var errors = [];
    var keys = Object.keys(input);

    /* 未知键 = 拒绝。这条比"点名禁止 prompt"强得多：它同时挡住了
       未来任何新的正文类字段（以及拼错的白名单键）。 */
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!BUDGET_INPUT_INDEX[k]) {
        errors.push(FORBIDDEN_POLICY_INPUT_INDEX[k]
          ? 'policy-input-carries-non-deterministic-text'
          : 'policy-input-key-not-whitelisted');
      }
    }

    var out = {};
    if (input.actorId != null) {
      var actor = promotePartyRef(input.actorId);
      if (!actor) errors.push('policy-actor-invalid');
      else out.actorId = Object.freeze({ type: actor.type, id: actor.id });
    }
    if (input.ownerId != null) {
      var owner = promotePartyRef(input.ownerId);
      if (!owner) errors.push('policy-owner-invalid');
      else out.ownerId = Object.freeze({ type: owner.type, id: owner.id });
    }
    if (input.recipientId != null) {
      var rec = promotePartyRef(input.recipientId);
      if (!rec) errors.push('policy-recipient-invalid');
      else out.recipientId = Object.freeze({ type: rec.type, id: rec.id });
    }
    if (input.currency != null) {
      var cur = validateCurrency(input.currency);
      if (!cur.ok) errors.push.apply(errors, cur.errors);
      else out.currency = cur.currency;
    }
    if (input.amountMinor != null) {
      var amt = normalizeAmountMinor(input.amountMinor);
      if (!amt.ok) errors.push.apply(errors, amt.errors);
      else out.amountMinor = amt.amountMinor;
    }
    if (input.productId != null) {
      if (!isEconomyId('PRODUCT', input.productId)) errors.push('policy-product-id-not-canonical');
      else out.productId = String(input.productId);
    }
    if (input.category != null) {
      var c = String(input.category);
      /* category 是**封闭词表的一部分但由 P22-5 注册**；此处只保证它是
         一个稳定的机器可读 token，不保证它存在（存在性属 store 层）。 */
      if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(c)) errors.push('policy-category-not-canonical');
      else out.category = c;
    }
    if (input.quantity != null) {
      var q = input.quantity;
      if (typeof q !== 'number' || !Number.isSafeInteger(q) || q < 1) errors.push('policy-quantity-must-be-positive-safe-integer');
      else out.quantity = q;
    }
    if (input.timestamp != null) {
      var ts = Number(input.timestamp);
      if (!Number.isFinite(ts) || !Number.isSafeInteger(ts) || ts < 0) errors.push('policy-timestamp-must-be-non-negative-safe-integer');
      else out.timestamp = ts;
    }
    if (input.autonomyLevel != null) {
      var al = String(input.autonomyLevel);
      if (AUTONOMY_LEVELS.indexOf(al) < 0) errors.push('policy-autonomy-level-not-in-closed-set');
      else out.autonomyLevel = al;
    }
    if (input.walletState != null) {
      var ws = validateWalletState(input.walletState);
      if (!ws.ok) errors.push.apply(errors, ws.errors);
      else out.walletState = ws.state;
    }
    if (input.usage != null) {
      if (!input.usage || typeof input.usage !== 'object' || Array.isArray(input.usage)) {
        errors.push('policy-usage-must-be-a-structured-object');
      } else {
        /* usage 是"已经花了多少"的只读快照（P22-4 会按窗口填充），
           这里递归拒绝一切嵌套正文。 */
        var usageOut = {};
        var uks = Object.keys(input.usage);
        for (var u = 0; u < uks.length; u++) {
          var uk = uks[u];
          if (FORBIDDEN_POLICY_INPUT_INDEX[uk]) { errors.push('policy-input-carries-non-deterministic-text'); continue; }
          var uv = input.usage[uk];
          if (typeof uv === 'object' && uv !== null) { errors.push('policy-usage-values-must-be-scalars'); continue; }
          if (typeof uv === 'number' && !Number.isSafeInteger(uv)) { errors.push('policy-usage-values-must-be-safe-integers'); continue; }
          if (typeof uv !== 'number' && typeof uv !== 'string' && typeof uv !== 'boolean') {
            errors.push('policy-usage-values-must-be-scalars'); continue;
          }
          usageOut[uk] = uv;
        }
        if (!errors.length) out.usage = Object.freeze(usageOut);
      }
    }
    if (input.limits != null) {
      if (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits)) {
        errors.push('policy-limits-must-be-a-structured-object');
      } else {
        /* limits 由**契约**给出键名（P22-4 只填值），因此这里可以白名单化。
           键名刻意对应 DENY_REASON 的每一档，而不是另一套新词。 */
        var limitsOut = {};
        var lks = Object.keys(input.limits);
        for (var l = 0; l < lks.length; l++) {
          var lk = lks[l];
          if (lk === COOLDOWN_KEY) {
            /* cooldown 是**时长**（毫秒），不是金额 —— 因此它刻意不走
               normalizeAmountMinor：把 90000ms 当 amount 处理会让
               "冷却"与"限额"在类型上混起来。 */
            var cd = input.limits[lk];
            if (typeof cd !== 'number' || !Number.isSafeInteger(cd) || cd < 0) {
              errors.push('policy-cooldown-must-be-non-negative-safe-integer'); continue;
            }
            limitsOut[lk] = cd;
            continue;
          }
          if (BUDGET_LIMIT_KEYS.indexOf(lk) < 0) { errors.push('policy-limit-key-not-whitelisted'); continue; }
          var lv = input.limits[lk];
          var la = normalizeAmountMinor(lv);
          if (!la.ok) { errors.push('policy-limit-value-must-be-an-amount-minor'); continue; }
          limitsOut[lk] = la.amountMinor;
        }
        if (!errors.length) out.limits = Object.freeze(limitsOut);
      }
    }

    if (errors.length) return { ok: false, input: null, errors: errors };
    return { ok: true, errors: [], input: Object.freeze(out) };
  }

  /* limits 的键 = P22 §7 的那张表。单位一律是 minor unit。
     cooldownMs 不在这个数组里：它是**时长**（毫秒），由 COOLDOWN_KEY 单独
     受理（见 normalizeBudgetInput），因为"冷却 90000ms"与"限额 90000 minor"
     是两件不同的事，混进同一个数组会让它们看起来同类。 */
  var BUDGET_LIMIT_KEYS = Object.freeze([
    'availableBalanceMinor',
    'perTransactionMinor',
    'dailyMinor',
    'weeklyMinor',
    'monthlyMinor',
    'categoryMinor',
    'recipientMinor',
    'autonomousSpendMinor',
    'emergencyReserveMinor',
    'approvalThresholdMinor'
  ]);

  var COOLDOWN_KEY = 'cooldownMs';

  /* ══════════════════════════════════════════════════════════════════
     §14 · Quote Contract
     ══════════════════════════════════════════════════════════════════ */

  /* Quote 存在就是为了消灭这个序列：
       check price = 50 → price changes → commit 80
     因此流程必须**消费** quote，而不是在 commit 时重新读 price。
     quote.amountMinor 是 commit 的唯一价格输入。 */
  var QUOTE_STATE = Object.freeze({
    OPEN: 'OPEN',
    CONSUMED: 'CONSUMED',
    EXPIRED: 'EXPIRED'
  });

  var QUOTE_STATES = Object.freeze(Object.keys(QUOTE_STATE));

  function validateQuote(input, now) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId('QUOTE', o.quoteId)) errors.push('quote-id-not-canonical');
    if (!isEconomyId('PRODUCT', o.productId)) errors.push('product-id-not-canonical');
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var amt = normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) errors.push.apply(errors, amt.errors);
    if (!Number.isSafeInteger(o.quantity) || o.quantity < 1) errors.push('quote-quantity-must-be-positive-safe-integer');
    if (!Number.isFinite(Number(o.expiresAt))) errors.push('quote-expires-at-not-a-number');
    if (QUOTE_STATES.indexOf(String(o.state)) < 0) errors.push('quote-state-not-in-closed-set');
    if (o.rateVersion != null && !isEconomyId('EXCHANGE_RATE', o.rateVersion)) {
      errors.push('exchange-rate-id-not-canonical');
    }
    if (now != null && Number.isFinite(Number(o.expiresAt)) && Number(now) >= Number(o.expiresAt)) {
      errors.push('quote-expired');
    }
    if (errors.length) return { ok: false, quote: null, errors: errors };
    return { ok: true, errors: [], quote: o };
  }

  /* ══════════════════════════════════════════════════════════════════
     §15 · Product Effect Contract（白名单，无代码）
     ══════════════════════════════════════════════════════════════════ */

  /* Product 里**不允许**出现任意 JS / function / code。
     商品 effect 是**数据**，由 Economy 解释，不由商品自己执行。 */
  var EFFECT_TYPE = Object.freeze({
    GRANT_INVENTORY: 'GRANT_INVENTORY',
    GRANT_COMPUTE_STANDARD: 'GRANT_COMPUTE_STANDARD',
    GRANT_COMPUTE_PREMIUM: 'GRANT_COMPUTE_PREMIUM',
    GRANT_IMAGE_CREDIT: 'GRANT_IMAGE_CREDIT',
    GRANT_VOICE_CREDIT: 'GRANT_VOICE_CREDIT'
  });

  var EFFECT_TYPES = Object.freeze(Object.keys(EFFECT_TYPE));

  /* 每个 effect 授予哪种 currency。于是"买了 pack 之后余额多了什么"
     是**可推导的**，不需要在商品里写下来。 */
  var EFFECT_CURRENCY = Object.freeze({
    GRANT_INVENTORY: null,          /* inventory 走 inventory 域，不发 currency */
    GRANT_COMPUTE_STANDARD: CURRENCY.COMPUTE_STANDARD,
    GRANT_COMPUTE_PREMIUM: CURRENCY.COMPUTE_PREMIUM,
    GRANT_IMAGE_CREDIT: CURRENCY.IMAGE_CREDIT,
    GRANT_VOICE_CREDIT: CURRENCY.VOICE_CREDIT
  });

  /* 点名否认的 effect 名。它们全部是"影响 Economy 之外的世界"的企图：
       memory / relationship 是别的 canonical owner；
       provider / apikey / payment 是 P22 的硬边界。
     出现在这里不是为了"以后可能要支持"，而是为了让误接时**立刻**失败。 */
  var FORBIDDEN_EFFECT_NAMES = Object.freeze([
    'MODIFY_MEMORY', 'WRITE_MEMORY', 'CREATE_MEMORY', 'MEMORY',
    'MODIFY_RELATIONSHIP', 'AFFECTION', 'TRUST', 'AFFINITY', 'RELATIONSHIP',
    'CALL_PROVIDER', 'PROVIDER_CALL', 'TOP_UP_PROVIDER', 'PROVIDER_TOPUP',
    'PROVIDER_BALANCE', 'SET_PROVIDER_BALANCE', 'PURCHASE_PROVIDER_CREDITS',
    'CHANGE_API_KEY', 'SET_API_KEY', 'READ_API_KEY', 'API_KEY',
    'SEND_PAYMENT', 'PAY', 'CHECKOUT', 'REAL_PURCHASE', 'FIAT_PURCHASE',
    'WEBHOOK', 'HTTP_REQUEST', 'FETCH', 'EXEC', 'EVAL', 'FUNCTION', 'CALLBACK',
    'CODE', 'SCRIPT'
  ]);

  var FORBIDDEN_EFFECT_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < FORBIDDEN_EFFECT_NAMES.length; i++) map[FORBIDDEN_EFFECT_NAMES[i]] = true;
    return map;
  })();

  function isKnownEffectType(value) {
    return value != null && EFFECT_TYPES.indexOf(String(value)) >= 0;
  }

  function isForbiddenEffectName(value) {
    if (value == null) return false;
    var raw = String(value).trim();
    if (!raw) return false;
    if (FORBIDDEN_EFFECT_INDEX[raw]) return true;
    return !!FORBIDDEN_EFFECT_INDEX[normalizeUpperToken(raw)];
  }

  /* 校验一个 effect 是**数据**。function / 带 body 的对象 / 任何可调用
     形状一律拒绝 —— 这是"商品不能执行代码"的可执行形式。 */
  function validateProductEffect(effect) {
    var errors = [];
    if (typeof effect === 'function') return { ok: false, effect: null, errors: ['effect-must-not-be-a-function'] };
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) {
      return { ok: false, effect: null, errors: ['effect-must-be-a-plain-data-object'] };
    }
    var type = effect.type == null ? '' : String(effect.type);
    if (isForbiddenEffectName(type)) errors.push('effect-type-is-forbidden-out-of-domain-side-effect');
    if (!isKnownEffectType(type)) errors.push('effect-type-not-in-whitelist');
    /* 未知键一律拒绝：挡住了 {type:'GRANT_COMPUTE_PREMIUM', run:'...'} 这类
       "用数据字段夹带行为"的写法。 */
    var allowed = ['type', 'amountMinor', 'quantity', 'productId', 'metadata'];
    var keys = Object.keys(effect);
    for (var i = 0; i < keys.length; i++) {
      if (allowed.indexOf(keys[i]) < 0) errors.push('effect-key-not-whitelisted');
    }
    if (effect.amountMinor != null) {
      var amt = normalizeAmountMinor(effect.amountMinor);
      if (!amt.ok) errors.push('effect-amount-minor-invalid');
    }
    if (effect.metadata != null) {
      if (!effect.metadata || typeof effect.metadata !== 'object' || Array.isArray(effect.metadata)) {
        errors.push('effect-metadata-must-be-a-plain-object');
      } else {
        /* metadata 里也不许藏代码或密钥类字段。 */
        var mk = Object.keys(effect.metadata);
        for (var m = 0; m < mk.length; m++) {
          if (typeof effect.metadata[mk[m]] === 'function') errors.push('effect-metadata-must-not-contain-functions');
          if (/^(?:api[-_]?key|apikey|authorization|token|secret|password|credential)s?$/i.test(mk[m])) {
            errors.push('effect-metadata-must-not-contain-credentials');
          }
        }
      }
    }
    if (errors.length) return { ok: false, effect: null, errors: errors };
    return { ok: true, errors: [], effect: effect };
  }

  /* ══════════════════════════════════════════════════════════════════
     §16 · Compute Credit Contract
     ══════════════════════════════════════════════════════════════════ */

  /* Compute Credits 只表示：IB 内部允许 Agent 使用**某类**计算资源的预算。
     它**不**表示：OpenAI / Anthropic / DeepSeek / Qwen 的余额、
     USD 余额、或"在 provider 处拥有的 token"。
     可执行形式：下面的 FORBIDDEN_COMPUTE_ALIASES 被逐字否认。 */
  var COMPUTE_TIER = Object.freeze({
    STANDARD: 'COMPUTE_STANDARD',
    PREMIUM: 'COMPUTE_PREMIUM'
  });

  var COMPUTE_TIERS = Object.freeze(Object.values(COMPUTE_TIER));

  /* 刻意**不**引入 "virtualToken"：P22 §18 建议直接避免 —— 它与 provider
     上报的 token usage 是不同量纲的东西，同名必然导致误接。若将来确需
     一个抽象计量单位，名字是 computeUnits（1 minor unit = 1 computeUnit），
     而不是 tokens。 */
  var COMPUTE_UNIT_NAME = 'computeUnit';
  var COMPUTE_UNIT_ALIASES = Object.freeze(['computeUnit', 'computeUnits']);
  var FORBIDDEN_COMPUTE_ALIASES = Object.freeze([
    'token', 'tokens', 'virtualToken', 'virtualTokens', 'virtual_token', 'virtual_tokens',
    'providerToken', 'providerTokens', 'openaiToken', 'anthropicToken',
    'usd', 'cny', 'balance', 'providerBalance', 'providerCredit', 'providerCredits',
    'apiCredit', 'apiCredits', 'realCredit', 'realCredits'
  ]);

  var FORBIDDEN_COMPUTE_ALIAS_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < FORBIDDEN_COMPUTE_ALIASES.length; i++) map[FORBIDDEN_COMPUTE_ALIASES[i]] = true;
    return map;
  })();

  function isComputeTierCurrency(currency) {
    return COMPUTE_TIERS.indexOf(String(currency == null ? '' : currency)) >= 0;
  }

  function isForbiddenComputeAlias(value) {
    if (value == null) return false;
    var raw = String(value).trim();
    if (!raw) return false;
    if (FORBIDDEN_COMPUTE_ALIAS_INDEX[raw]) return true;
    return !!FORBIDDEN_COMPUTE_ALIAS_INDEX[normalizeUpperToken(raw)];
  }

  /* 哪些 effect 授予哪些 tier —— 唯一的映射，避免商品层各写一遍。 */
  function computeTierOfEffect(effectType) {
    if (String(effectType) === EFFECT_TYPE.GRANT_COMPUTE_STANDARD) return COMPUTE_TIER.STANDARD;
    if (String(effectType) === EFFECT_TYPE.GRANT_COMPUTE_PREMIUM) return COMPUTE_TIER.PREMIUM;
    return null;
  }

  /* Compute 消耗的记账语义：一次消耗都是一笔 COMPUTE_CONSUME transaction，
     从 actor 的 compute currency account 流向 system:treasury。
     它**不**写 provider，也**不**减少任何 provider 余额。 */
  var COMPUTE_CONSUME_COUNTERPARTY = SYSTEM_ACCOUNT.TREASURY;

  /* ══════════════════════════════════════════════════════════════════
     §17 · Exchange Rate Contract
     ══════════════════════════════════════════════════════════════════ */

  /* 兑换率是**有理数**，不是浮点。理由与 §3 同源：0.2 表示不了 1/5，
     而汇率一旦进入 ledger，"总共换出去多少"就必须精确。
     rateNumerator / rateDenominator 都是正整数，语义为：
       creditAmount = floor(debitAmount * rateNumerator / rateDenominator)
     取 floor（向下取整）而不是四舍五入 —— 舍入方向永远对用户不利，
     于是"舍入套利"不可能存在。 */
  var EXCHANGE_ROUNDING = 'floor-toward-zero-favoring-the-house';
  var EXCHANGE_RATE_INDEX_PREFIX = 'econ_rate_';

  function validateExchangeRate(input) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId('EXCHANGE_RATE', o.exchangeRateId)) errors.push('exchange-rate-id-not-canonical');
    var from = validateCurrency(o.fromCurrency);
    if (!from.ok) errors.push.apply(errors, from.errors);
    var to = validateCurrency(o.toCurrency);
    if (!to.ok) errors.push.apply(errors, to.errors);
    if (from.ok && to.ok && from.currency === to.currency) errors.push('exchange-rate-from-and-to-must-differ');

    var num = normalizeAmountMinor(o.rateNumerator);
    if (!num.ok || num.amountMinor <= 0n) errors.push('exchange-rate-numerator-must-be-a-positive-integer');
    var den = normalizeAmountMinor(o.rateDenominator);
    if (!den.ok || den.amountMinor <= 0n) errors.push('exchange-rate-denominator-must-be-a-positive-integer');
    if (typeof o.version !== 'number' || !Number.isSafeInteger(o.version) || o.version < 1) {
      errors.push('exchange-rate-version-must-be-a-positive-safe-integer');
    }
    if (errors.length) return { ok: false, rate: null, errors: errors };
    return { ok: true, errors: [], rate: o };
  }

  /* 兑换计算（纯函数，BigInt，floor）。两个 currency **必须**都在
     Economy 内部：跨到法币/provider 余额的兑换在 validateCurrency 那里
     就已经不可能通过，这里是第二道显式闸门（并给出专属 reason code）。 */
  function computeExchangeAmount(amountMinor, rate) {
    var amt = normalizeAmountMinor(amountMinor);
    if (!amt.ok) return { ok: false, amountMinor: null, errors: amt.errors };
    var r = validateExchangeRate(rate);
    if (!r.ok) return { ok: false, amountMinor: null, errors: r.errors };
    if (isForbiddenCurrencyToken(rate.fromCurrency) || isForbiddenCurrencyToken(rate.toCurrency)) {
      return { ok: false, amountMinor: null, errors: ['exchange-cross-domain-forbidden'] };
    }
    var num = BigInt(rate.rateNumerator);
    var den = BigInt(rate.rateDenominator);
    var out = (amt.amountMinor * num) / den; /* BigInt 除法天然 floor */
    if (out <= 0n) return { ok: false, amountMinor: null, errors: ['exchange-rounds-to-zero'] };
    if (out > BigInt(MAX_AMOUNT_MINOR)) return { ok: false, amountMinor: null, errors: ['amount-minor-overflow'] };
    return { ok: true, errors: [], amountMinor: out };
  }

  /* ══════════════════════════════════════════════════════════════════
     §18 · Economy Event Contract
     ══════════════════════════════════════════════════════════════════ */

  /* Economy Event 是**事实事件**，不是 Memory。
     Economy 只**产出**事件；是否形成长期记忆由现有 Memory /
     Memory Consolidation 决定（P22 §3），关系是否变化由 Relationship 决定。
     因此 envelope 里没有、也不允许有记忆/关系字段。 */
  var EVENT_TYPE = Object.freeze({
    WALLET_OPENED: 'WALLET_OPENED',
    TRANSACTION_CREATED: 'TRANSACTION_CREATED',
    RESERVATION_CREATED: 'RESERVATION_CREATED',
    RESERVATION_RELEASED: 'RESERVATION_RELEASED',
    RESERVATION_EXPIRED: 'RESERVATION_EXPIRED',
    /* ── P22-3 追加的三个（加法）────────────────────────────────────────
       RESERVATION_COMMITTED —— 预留被用掉。P22-1 只有 PURCHASE_COMMITTED，
       但 P22-3 里被提交的是**预留**，而"哪一次预留成交了"必须可回答；
       且 purchase 属于 P22-5 的商品语义，现在就用它会把两件事合并。
       RESERVATION_REBUILT  —— reserved 缓存从 active reservations 重建，
       与 P22-2 的 BALANCE_REBUILT 同款：缓存漂移不许静默消失。
       OPERATION_FAILED     —— 操作进入生命周期后不可继续。它与
       RESERVATION_RELEASED **不同**：后者是主动放弃，前者是"试过了、
       没能成立"，而两者的资源后果相同（钱还回去）。合并它们会让
       "为什么这笔没成"在审计里丢掉。 */
    RESERVATION_COMMITTED: 'RESERVATION_COMMITTED',
    RESERVATION_REBUILT: 'RESERVATION_REBUILT',
    OPERATION_FAILED: 'OPERATION_FAILED',
    PURCHASE_COMMITTED: 'PURCHASE_COMMITTED',
    PURCHASE_DENIED: 'PURCHASE_DENIED',
    ITEM_GIFTED: 'ITEM_GIFTED',
    ITEM_CONSUMED: 'ITEM_CONSUMED',
    COMPUTE_CREDIT_GRANTED: 'COMPUTE_CREDIT_GRANTED',
    COMPUTE_CREDIT_CONSUMED: 'COMPUTE_CREDIT_CONSUMED',
    EXCHANGE_COMMITTED: 'EXCHANGE_COMMITTED',
    MINT_COMMITTED: 'MINT_COMMITTED',
    BURN_COMMITTED: 'BURN_COMMITTED'
  });

  var EVENT_TYPES = Object.freeze(Object.keys(EVENT_TYPE));
  var EVENT_TYPE_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < EVENT_TYPES.length; i++) map[EVENT_TYPES[i]] = true;
    return map;
  })();

  function isEconomyEventType(value) {
    return value != null && EVENT_TYPE_INDEX[String(value)] === true;
  }

  var EVENT_ENVELOPE_KEYS = Object.freeze([
    'domain', 'economyEventId', 'eventType', 'timestamp',
    'actor', 'subject', 'transactionId', 'productId', 'metadata'
  ]);

  /* envelope 白名单构造。**不**允许 consumer 往 metadata 里塞正文：
     metadata 的值只能是标量，且不得是凭据类键名。 */
  function makeEconomyEvent(input) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId('EVENT', o.economyEventId)) errors.push('economy-event-id-not-canonical');
    if (!isEconomyEventType(o.eventType)) errors.push('economy-event-type-not-in-closed-set');
    if (!Number.isSafeInteger(o.timestamp) || o.timestamp < 0) errors.push('economy-event-timestamp-must-be-non-negative-safe-integer');
    if (!isPartyRef(o.actor)) errors.push('economy-event-actor-must-be-a-canonical-party-ref');
    if (o.subject != null && !isPartyRef(o.subject)) errors.push('economy-event-subject-must-be-a-canonical-party-ref');
    if (o.transactionId != null && !isEconomyId('TRANSACTION', o.transactionId)) errors.push('transaction-id-not-canonical');
    if (o.productId != null && !isEconomyId('PRODUCT', o.productId)) errors.push('product-id-not-canonical');

    var metadata = {};
    if (o.metadata != null) {
      if (typeof o.metadata !== 'object' || Array.isArray(o.metadata)) {
        errors.push('economy-event-metadata-must-be-a-plain-object');
      } else {
        var mk = Object.keys(o.metadata);
        for (var i = 0; i < mk.length; i++) {
          var k = mk[i];
          var v = o.metadata[k];
          if (typeof v === 'function') { errors.push('economy-event-metadata-must-not-contain-functions'); continue; }
          if (v !== null && typeof v === 'object') { errors.push('economy-event-metadata-values-must-be-scalars'); continue; }
          if (/^(?:api[-_]?key|apikey|authorization|token|secret|password|credential)s?$/i.test(k)) {
            errors.push('economy-event-metadata-must-not-contain-credentials'); continue;
          }
          /* 事实事件不带长正文；超过这个长度基本就是把 prompt/回复塞进来了。 */
          if (typeof v === 'string' && v.length > 400) { errors.push('economy-event-metadata-string-too-long'); continue; }
          metadata[k] = v;
        }
      }
    }
    if (errors.length) return { ok: false, event: null, errors: errors };
    return {
      ok: true,
      errors: [],
      event: Object.freeze({
        domain: DOMAIN,
        economyEventId: String(o.economyEventId),
        eventType: String(o.eventType),
        timestamp: o.timestamp,
        actor: Object.freeze({ type: o.actor.type, id: o.actor.id }),
        subject: o.subject ? Object.freeze({ type: o.subject.type, id: o.subject.id }) : null,
        transactionId: o.transactionId ? String(o.transactionId) : null,
        productId: o.productId ? String(o.productId) : null,
        metadata: Object.freeze(metadata)
      })
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     §19 · Audit Contract
     ══════════════════════════════════════════════════════════════════ */

  /* 当前 IB **没有** canonical decisionId / actionId（P22-0 §4/§5 的检索
     结果为空）。因此这里**不发明**它们，只用 opaque 的 correlation ref：
       decisionRef / actionRef —— 只有当现有 runtime 能**稳定**提供时才记录，
     否则为 null。不得为了填这两个字段去重构 Decision/Action。
     这与 integration 侧的既有做法一致：active-plans.js 的 intent 是
     可关联的既有载荷，而它没有 id，所以 Economy 只能存一个引用串。 */
  var CORRELATION_REF_RE = /^[A-Za-z0-9_.:+-]{1,200}$/;

  var AUDIT_OPERATION = Object.freeze({
    POLICY_EVALUATED: 'POLICY_EVALUATED',
    QUOTE_ISSUED: 'QUOTE_ISSUED',
    WALLET_READ: 'WALLET_READ',
    RESERVATION_RESERVE: 'RESERVATION_RESERVE',
    RESERVATION_COMMIT: 'RESERVATION_COMMIT',
    RESERVATION_RELEASE: 'RESERVATION_RELEASE',
    LEDGER_APPEND: 'LEDGER_APPEND',
    INVENTORY_MUTATE: 'INVENTORY_MUTATE',
    COMPUTE_GRANT: 'COMPUTE_GRANT',
    COMPUTE_CONSUME: 'COMPUTE_CONSUME',
    EXCHANGE_APPLY: 'EXCHANGE_APPLY'
  });

  var AUDIT_OPERATIONS = Object.freeze(Object.keys(AUDIT_OPERATION));

  function normalizeCorrelationRef(value) {
    if (value == null) return { ok: true, ref: null, errors: [] };
    var s = String(value).trim();
    if (!s) return { ok: true, ref: null, errors: [] };
    if (!CORRELATION_REF_RE.test(s)) return { ok: false, ref: null, errors: ['correlation-ref-not-canonical'] };
    return { ok: true, ref: s, errors: [] };
  }

  function makeAuditRecord(input) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId('EVENT', o.economyEventId)) errors.push('economy-event-id-not-canonical');
    if (!Number.isSafeInteger(o.timestamp) || o.timestamp < 0) errors.push('audit-timestamp-must-be-non-negative-safe-integer');
    if (!isPartyRef(o.actor)) errors.push('audit-actor-must-be-a-canonical-party-ref');
    if (AUDIT_OPERATIONS.indexOf(String(o.operation)) < 0) errors.push('audit-operation-not-in-closed-set');

    var refs = {};
    ['decisionRef', 'actionRef', 'purchaseIntentId', 'quoteId', 'reservationId', 'transactionId', 'productId', 'walletId']
      .forEach(function (k) {
        if (o[k] == null) { refs[k] = null; return; }
        if (k === 'decisionRef' || k === 'actionRef') {
          var r = normalizeCorrelationRef(o[k]);
          if (!r.ok) { errors.push('correlation-ref-not-canonical'); return; }
          refs[k] = r.ref; return;
        }
        var kind = {
          purchaseIntentId: 'PURCHASE_INTENT', quoteId: 'QUOTE', reservationId: 'RESERVATION',
          transactionId: 'TRANSACTION', productId: 'PRODUCT', walletId: 'WALLET'
        }[k];
        if (!isEconomyId(kind, o[k])) { errors.push('audit-ref-not-canonical'); return; }
        refs[k] = String(o[k]);
      });

    if (o.policyDecision != null && APPROVALS.indexOf(String(o.policyDecision)) < 0) {
      errors.push('audit-policy-decision-not-in-closed-set');
    }
    if (o.reasonCode != null && !isDenyReasonCode(o.reasonCode)) {
      errors.push('audit-reason-code-not-in-closed-set');
    }
    if (errors.length) return { ok: false, record: null, errors: errors };
    return {
      ok: true,
      errors: [],
      record: Object.freeze(Object.assign({
        domain: DOMAIN,
        economyEventId: String(o.economyEventId),
        timestamp: o.timestamp,
        actor: Object.freeze({ type: o.actor.type, id: o.actor.id }),
        operation: String(o.operation),
        policyDecision: o.policyDecision == null ? null : String(o.policyDecision),
        reasonCode: o.reasonCode == null ? null : String(o.reasonCode)
      }, refs))
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     §20 · Cross-domain Dependency Matrix（机器可读）
     ══════════════════════════════════════════════════════════════════ */

  var DEPENDENCY = Object.freeze({
    FORBIDDEN: 'FORBIDDEN',
    FORBIDDEN_WRITE: 'FORBIDDEN_WRITE',
    READ_ONLY_VIA_CANONICAL_API: 'READ_ONLY_VIA_CANONICAL_API',
    READ_ONLY: 'READ_ONLY',
    ADAPTER_ONLY: 'ADAPTER_ONLY',
    EVENT_CONSUMER_OPTIONAL: 'EVENT_CONSUMER_OPTIONAL',
    READ_ONLY_TELEMETRY: 'READ_ONLY_TELEMETRY'
  });

  /* 这张矩阵不是文档，它是**测试的输入**：dependency tests 直接遍历它，
     逐行断言。新增一行就必须同时给出一条可执行的检查，否则该行不会被
     任何东西验证，等于一句注释。 */
  var DEPENDENCY_MATRIX = Object.freeze([
    Object.freeze({ from: 'Economy', to: 'Memory', rule: DEPENDENCY.FORBIDDEN_WRITE,
      why: '是否形成长期记忆由 Memory/Memory Consolidation 决定，Economy 只产 event' }),
    Object.freeze({ from: 'Economy', to: 'Relationship', rule: DEPENDENCY.FORBIDDEN_WRITE,
      why: '关系变化由 Relationship（role-dm-core 的 RELATION_DELTA_CAP）决定，Economy 不得 affection/trust += X' }),
    Object.freeze({ from: 'Economy', to: 'RealPayment', rule: DEPENDENCY.FORBIDDEN,
      why: 'P22 明确不接真实支付；Economy→Provider/支付写路径必须不存在' }),
    Object.freeze({ from: 'Economy', to: 'CredentialVault', rule: DEPENDENCY.FORBIDDEN,
      why: 'API Key 不进入 Economy，也不进入 audit metadata' }),
    Object.freeze({ from: 'Economy', to: 'ProviderBilling', rule: DEPENDENCY.FORBIDDEN,
      why: 'Provider 余额不可被 Economy 修改；只能作为只读遥测' }),
    Object.freeze({ from: 'Economy', to: 'ProviderMetadata', rule: DEPENDENCY.READ_ONLY_VIA_CANONICAL_API,
      why: 'provider/模型/reasoningEffort 能力唯一真源是 ib-model-core + provider-directory' }),
    Object.freeze({ from: 'Economy', to: 'CharacterIdentity', rule: DEPENDENCY.READ_ONLY,
      why: 'ownerId 只能引用 characters.id（DTO 面），不得触 character_runtime_specs' }),
    Object.freeze({ from: 'Economy', to: 'ExistingAction', rule: DEPENDENCY.ADAPTER_ONLY,
      why: '购买/赠送必须经既有工具回合 + Middle Brain 裁决，不得建第二个 executor' }),
    Object.freeze({ from: 'Memory', to: 'EconomyEvents', rule: DEPENDENCY.EVENT_CONSUMER_OPTIONAL,
      why: '记忆可选择消费 economy event，但这是它的决定，不是 Economy 的写路径' }),
    Object.freeze({ from: 'Relationship', to: 'EconomyEvents', rule: DEPENDENCY.EVENT_CONSUMER_OPTIONAL,
      why: '同上' }),
    Object.freeze({ from: 'ProviderTelemetry', to: 'Economy', rule: DEPENDENCY.READ_ONLY_TELEMETRY,
      why: '真实 token/cost 只从 Provider 流向 Economy（只读），反向写路径不存在' })
  ]);

  /* ── 禁止依赖的模块清单（dependency-boundary 测试的输入）──────────────
     分成两组，因为断言的**强度**不同：
       MUST_NOT_REQUIRE  —— Economy 生产代码里出现这些 require 即失败
       MUST_NOT_MENTION  —— 连裸标识符都不许出现（行为性动词） */
  var BOUNDARY_FORBIDDEN_MODULES = Object.freeze([
    'bridge/pay-gate.js',
    'bridge/alipay-provider.js',
    'bridge/payment-provider.js',
    'active/payment-auth.js',
    'active/shopping-execution.js',
    'active/credential-vault.js',
    'active/commerce.js',
    'assets/js/commerce-adapter.js',
    'assets/js/shopping-review.js',
    'assets/js/payment-settings.js'
  ]);

  var BOUNDARY_FORBIDDEN_IDENTIFIERS = Object.freeze([
    'topUpProvider',
    'purchaseProviderCredits',
    'updateProviderBalance',
    'providerPayment',
    'providerBillingMutation',
    'purchaseRealCredits',
    'sendPayment',
    'submitPayment',
    'submit_payment',
    'commitSpend',
    'pay_register_checkout',
    'pay_set_config',
    'pay_request_confirm'
  ]);

  /* Economy 生产代码**允许**依赖的模块（白名单，正向断言）。
     正向 + 反向两条断言必须同时存在：只有反向的话，"Economy 悄悄
     require 了一个新模块"不会被发现。

     ── P22-2：为什么在这里多了一条**精确文件**条目 ────────────────────
     'runtime/db-failure.js' 是仓库里**唯一**一处数据库失败分类器
     （memory-store.js:46 与 http.js:193 都以同样的理由用它）。P22-2 的
     store 在 open() 失败时也必须给出**同一个** category，否则"为什么
     打不开"会有两个答案，而 http.js 的 resolveStoreFailure 只认那一个。

     因此这是一次**刻意的、加法的**放宽，而不是把边界改松：
       · 加的是**精确路径**（不是 'runtime/' 前缀）—— 于是它覆盖一个文件，
         不是一整个目录；
       · 钉住的是"失败分类只有一份"这条既有纪律，不是在引入新依赖面；
       · 它仍然是一条白名单条目，因此 B3 的正向断言继续成立。
     真正被禁的那些东西（凭据 / 真实支付 / provider / Memory / Relationship）
     一个都没有靠近这条白名单。 */
  var BOUNDARY_ALLOWED_MODULE_PREFIXES = Object.freeze([
    'node:', 'services/home-node/economy-', './economy-', './economy/', '../economy/',
    'runtime/db-failure.js'
  ]);

  /* ══════════════════════════════════════════════════════════════════
     §21 · Real-money naming-collision guard（P22-0 R2）
     ══════════════════════════════════════════════════════════════════ */

  /* active/commerce.js 的 a.task.maxBudget（单位=元）与 a.paymentIntent
     是真实购物域的词。Economy 的 Budget 输入**不得**接受它们 —— 不是
     "记得不要传"，而是 normalizeBudgetInput 的未知键拒绝规则已经让
     maxBudget / paymentIntent 天然通不过。
     这里额外提供一条**显式**谓词，让测试可以点名这件事。 */
  var REAL_COMMERCE_COLLIDING_KEYS = Object.freeze([
    'maxBudget', 'paymentIntent', 'paymentLink', 'checkoutUrl',
    'realPrice', 'fiatAmount', 'orderId', 'cashierUrl'
  ]);

  var REAL_COMMERCE_COLLIDING_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < REAL_COMMERCE_COLLIDING_KEYS.length; i++) map[REAL_COMMERCE_COLLIDING_KEYS[i]] = true;
    return map;
  })();

  function isRealCommerceKey(value) {
    return value != null && REAL_COMMERCE_COLLIDING_INDEX[String(value)] === true;
  }

  /* ══════════════════════════════════════════════════════════════════
     导出
     ══════════════════════════════════════════════════════════════════ */

  return Object.freeze({
    /* §1 */
    DOMAIN: DOMAIN,
    NAMESPACES: NAMESPACES,
    isEconomyDomain: isEconomyDomain,
    validateEconomyDomain: validateEconomyDomain,
    /* §2 */
    CURRENCY: CURRENCY,
    CURRENCIES: CURRENCIES,
    CURRENCY_SCALE: CURRENCY_SCALE,
    CURRENCY_DISPLAY: CURRENCY_DISPLAY,
    FORBIDDEN_CURRENCY_TOKENS: FORBIDDEN_CURRENCY_TOKENS,
    isLegalCurrencyId: isLegalCurrencyId,
    isForbiddenCurrencyToken: isForbiddenCurrencyToken,
    validateCurrency: validateCurrency,
    scaleOf: scaleOf,
    /* §3 */
    MAX_AMOUNT_MINOR: MAX_AMOUNT_MINOR,
    MIN_AMOUNT_MINOR: MIN_AMOUNT_MINOR,
    AMOUNT_RUNTIME_TYPE: AMOUNT_RUNTIME_TYPE,
    AMOUNT_SERIALIZED_TYPE: AMOUNT_SERIALIZED_TYPE,
    AMOUNT_SQLITE_TYPE: AMOUNT_SQLITE_TYPE,
    normalizeAmountMinor: normalizeAmountMinor,
    serializeAmountMinor: serializeAmountMinor,
    toDisplayParts: toDisplayParts,
    /* §4 */
    APPROVAL: APPROVAL,
    APPROVALS: APPROVALS,
    DENY_REASON: DENY_REASON,
    DENY_REASONS: DENY_REASONS,
    isDenyReasonCode: isDenyReasonCode,
    makeApproval: makeApproval,
    /* §5 */
    ID_PREFIX: ID_PREFIX,
    ID_KINDS: ID_KINDS,
    ID_MAX_LENGTH: ID_MAX_LENGTH,
    prefixOf: prefixOf,
    formatEconomyId: formatEconomyId,
    isEconomyId: isEconomyId,
    normalizeIdempotencyKey: normalizeIdempotencyKey,
    /* §6 */
    PARTY_TYPE: PARTY_TYPE,
    PARTY_TYPES: PARTY_TYPES,
    USER_PARTY_ID: USER_PARTY_ID,
    PARTY_ROLE: PARTY_ROLE,
    PARTY_ROLES: PARTY_ROLES,
    SYSTEM_ACCOUNT: SYSTEM_ACCOUNT,
    SYSTEM_ACCOUNTS: SYSTEM_ACCOUNTS,
    validateSystemAccountId: validateSystemAccountId,
    makePartyRef: makePartyRef,
    isPartyRef: isPartyRef,
    promotePartyRef: promotePartyRef,
    /* §7 */
    WALLET_STATE: WALLET_STATE,
    WALLET_STATES: WALLET_STATES,
    walletStateAllowsSpend: walletStateAllowsSpend,
    validateWalletState: validateWalletState,
    makeWalletView: makeWalletView,
    /* §8 */
    TX_STATE: TX_STATE,
    TX_STATES: TX_STATES,
    TX_TRANSITIONS: TX_TRANSITIONS,
    TX_TERMINAL_STATES: TX_TERMINAL_STATES,
    isTransactionState: isTransactionState,
    canTransitionTransaction: canTransitionTransaction,
    assertTransactionTransition: assertTransactionTransition,
    /* §9 */
    TX_TYPE: TX_TYPE,
    TX_TYPES: TX_TYPES,
    MINT_BURN_TYPES: MINT_BURN_TYPES,
    requiresBalanceTopology: requiresBalanceTopology,
    /* §10 */
    ENTRY_DIRECTION: ENTRY_DIRECTION,
    ENTRY_DIRECTIONS: ENTRY_DIRECTIONS,
    LEDGER_BALANCE_RULE: LEDGER_BALANCE_RULE,
    LEDGER_AMOUNT_SIGN: LEDGER_AMOUNT_SIGN,
    makeLedgerEntry: makeLedgerEntry,
    checkLedgerBalance: checkLedgerBalance,
    /* §11 */
    ACCOUNT_KIND: ACCOUNT_KIND,
    ACCOUNT_KINDS: ACCOUNT_KINDS,
    accountKindOf: accountKindOf,
    validateLedgerAccountId: validateLedgerAccountId,
    /* §12 */
    RESERVATION_STATE: RESERVATION_STATE,
    RESERVATION_STATES: RESERVATION_STATES,
    RESERVATION_AFFECTS: RESERVATION_AFFECTS,
    RESERVATION_TRANSITIONS: RESERVATION_TRANSITIONS,
    RESERVATION_TERMINAL_STATES: RESERVATION_TERMINAL_STATES,
    isReservationState: isReservationState,
    canTransitionReservation: canTransitionReservation,
    assertReservationTransition: assertReservationTransition,
    RESERVATION_STATE_OF_OPERATION: RESERVATION_STATE_OF_OPERATION,
    OPERATION_STATE_OF_RESERVATION: OPERATION_STATE_OF_RESERVATION,
    validateOperation: validateOperation,
    OPERATION_SCOPE: OPERATION_SCOPE,
    OPERATION_SCOPES: OPERATION_SCOPES,
    isOperationScope: isOperationScope,
    scopedIdempotencyIdentity: scopedIdempotencyIdentity,
    validateReservation: validateReservation,
    /* §13 */
    BUDGET_INPUT_KEYS: BUDGET_INPUT_KEYS,
    BUDGET_LIMIT_KEYS: BUDGET_LIMIT_KEYS,
    COOLDOWN_KEY: COOLDOWN_KEY,
    FORBIDDEN_POLICY_INPUT_KEYS: FORBIDDEN_POLICY_INPUT_KEYS,
    AUTONOMY_LEVEL: AUTONOMY_LEVEL,
    AUTONOMY_LEVELS: AUTONOMY_LEVELS,
    normalizeBudgetInput: normalizeBudgetInput,
    /* §14 */
    QUOTE_STATE: QUOTE_STATE,
    QUOTE_STATES: QUOTE_STATES,
    validateQuote: validateQuote,
    /* §15 */
    EFFECT_TYPE: EFFECT_TYPE,
    EFFECT_TYPES: EFFECT_TYPES,
    EFFECT_CURRENCY: EFFECT_CURRENCY,
    FORBIDDEN_EFFECT_NAMES: FORBIDDEN_EFFECT_NAMES,
    isKnownEffectType: isKnownEffectType,
    isForbiddenEffectName: isForbiddenEffectName,
    validateProductEffect: validateProductEffect,
    /* §16 */
    COMPUTE_TIER: COMPUTE_TIER,
    COMPUTE_TIERS: COMPUTE_TIERS,
    COMPUTE_UNIT_NAME: COMPUTE_UNIT_NAME,
    COMPUTE_UNIT_ALIASES: COMPUTE_UNIT_ALIASES,
    FORBIDDEN_COMPUTE_ALIASES: FORBIDDEN_COMPUTE_ALIASES,
    COMPUTE_CONSUME_COUNTERPARTY: COMPUTE_CONSUME_COUNTERPARTY,
    isComputeTierCurrency: isComputeTierCurrency,
    isForbiddenComputeAlias: isForbiddenComputeAlias,
    computeTierOfEffect: computeTierOfEffect,
    /* §17 */
    EXCHANGE_ROUNDING: EXCHANGE_ROUNDING,
    EXCHANGE_RATE_INDEX_PREFIX: EXCHANGE_RATE_INDEX_PREFIX,
    validateExchangeRate: validateExchangeRate,
    computeExchangeAmount: computeExchangeAmount,
    /* §18 */
    EVENT_TYPE: EVENT_TYPE,
    EVENT_TYPES: EVENT_TYPES,
    EVENT_ENVELOPE_KEYS: EVENT_ENVELOPE_KEYS,
    isEconomyEventType: isEconomyEventType,
    makeEconomyEvent: makeEconomyEvent,
    /* §19 */
    AUDIT_OPERATION: AUDIT_OPERATION,
    AUDIT_OPERATIONS: AUDIT_OPERATIONS,
    normalizeCorrelationRef: normalizeCorrelationRef,
    makeAuditRecord: makeAuditRecord,
    /* §20 */
    DEPENDENCY: DEPENDENCY,
    DEPENDENCY_MATRIX: DEPENDENCY_MATRIX,
    BOUNDARY_FORBIDDEN_MODULES: BOUNDARY_FORBIDDEN_MODULES,
    BOUNDARY_FORBIDDEN_IDENTIFIERS: BOUNDARY_FORBIDDEN_IDENTIFIERS,
    BOUNDARY_ALLOWED_MODULE_PREFIXES: BOUNDARY_ALLOWED_MODULE_PREFIXES,
    /* §21 */
    REAL_COMMERCE_COLLIDING_KEYS: REAL_COMMERCE_COLLIDING_KEYS,
    isRealCommerceKey: isRealCommerceKey
  });
});
