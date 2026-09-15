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
    /* P22-6：Purchase 是它自己的命名空间。加一项是加法 —— 既有 12 个
       字面值一个都没动，而"一次购买属于哪个域"必须有一个名字，
       否则读面只能借用 QUOTE 或 RESERVATION 的命名空间，
       那会让"这是报价还是购买"在第一眼就含糊。 */
    PURCHASE: 'ib.economy.purchase',
    /* P22-7：与 PURCHASE 同一条理由的第三次应用。"一条批准记录属于哪个
       域"必须有一个名字 —— 借用 PURCHASE 的命名空间会让 §5 那句
       "Approval ≠ Purchase"在读面上第一眼就含糊。 */
    APPROVAL: 'ib.economy.approval',
    /* 自主策略复用 BUDGET 的命名空间是**刻意**的：它与预算政策共用同一种
       记录形状与同一条"规则不是许可"语义（§3）。它需要自己的**事件**名
       （AUTONOMY_POLICY_*），但不需要第二个命名空间 —— 加一个只会在
       "这条规则属于哪一层"上制造第二种答案。 */
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
    POLICY_INPUT_NOT_STRUCTURED: 'POLICY_INPUT_NOT_STRUCTURED',
    /* ── P22-4 追加的四个（加法）──────────────────────────────────────────
       为什么这四个不能复用已有的代码：

       POLICY_NOT_FOUND —— 既有的 PRODUCT_DISABLED / QUOTE_MISMATCH 说的是
       "某个商品 / 某份报价不对"，而这里缺的是**规则本身**：这个 owner 在
       这个币种上根本没有启用的预算政策。"没有规则"与"规则说不"必须能分开，
       否则运维看到一千条 DENIED 时无法回答"是大家都超预算了，还是策略
       根本没配"。ownerId / currency 不匹配、政策被禁用、政策未创建、
       政策期限已结束 —— 四种情况共用这一个代码，因为它们对调用方的
       含义完全相同：**这个作用域上没有生效的规则**。

       POLICY_TERM_EXPIRED —— 与上面刻意分开：政策**存在**、也曾经生效，
       只是它的期限走完了。合并会让"政策到期"看起来像"政策没配"，而前者
       是一个应该在时间线上可见的事件。

       AMOUNT_EXCEEDS_PER_TRANSACTION —— PER_TX_LIMIT 的具名化。为什么
       要两分：PER_TX_LIMIT 表达的是"这次金额超出了单笔上限"，而
       DAILY/WEEKLY/MONTHLY_LIMIT 表达的是"累积额度不够了"。前者的
       正确反应是"拆单或换商品"，后者的正确反应是"等窗口滚动"。把两者
       压成同一个代码会让上层的反应变成猜。

       AMOUNT_EXCEEDS_APPROVAL_THRESHOLD —— 这一条**不**出现在任何
       DENY 路径上：它是 REQUIRE_APPROVAL 的 reasonCode。放进这个封闭
       集合是因为 makeApproval() 要求 reasonCode ∈ DENY_REASON（那里冻结
       的规则是"reason code 是封闭集合"，而不是"只有拒绝才有 reason"）。
       名字如实地写着"超过了审批线"，而不是"被拒绝了"。 */
    POLICY_NOT_FOUND: 'POLICY_NOT_FOUND',
    POLICY_TERM_EXPIRED: 'POLICY_TERM_EXPIRED',
    AMOUNT_EXCEEDS_PER_TRANSACTION: 'AMOUNT_EXCEEDS_PER_TRANSACTION',
    AMOUNT_EXCEEDS_APPROVAL_THRESHOLD: 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD',
    /* ── P22-5 追加的三个（加法）──────────────────────────────────────────
       INVENTORY 不是 BALANCE（P22-5 §12）。"我还剩 3 个"与"我还有 300
       元"是两种完全不同的不足，而它们的正确反应也不同（前者是"别用
       了"，后者是"去挣"）。因此它必须有自己的代码，而不是借用
       INSUFFICIENT_BALANCE。这条与 P22-3 分出
       INSUFFICIENT_AVAILABLE_BALANCE 的理由逐字同源。

       PRODUCT_NOT_FOUND / STORE_NOT_FOUND —— P22-4 的 createQuote 把
       "商品不存在"也写成 PRODUCT_DISABLED（那时没有目录，无法区分）。
       P22-5 第一次真的能区分了，于是"这件商品不存在"与"它存在但不能卖"
       各有一个代码：前者的正确反应是"你的 id 错了"，后者是"换一件商品"。
       P22-4 的 raw primitive 行为**不被改写**（它仍然报
       PRODUCT_DISABLED），只有 product-backed 路径用这两个新代码。 */
    INSUFFICIENT_INVENTORY: 'INSUFFICIENT_INVENTORY',
    PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',
    STORE_NOT_FOUND: 'STORE_NOT_FOUND',
    /* ── 两个"输入形状"代码 ─────────────────────────────────────────────
       P22-4 有一个 POLICY_INPUT_NOT_STRUCTURED，它说的是**政策**的输入。
       目录（货架 / 商品）与库存原语各自也需要一个，而且刻意**不**复用
       政策那一个：审计里"有人把政策写坏了"与"有人把商品写坏了"是两个
       不同的运维问题，共用代码会让它们无法区分。
       为什么不是更泛的 INPUT_NOT_STRUCTURED：一个泛化的兜底名字正是
       §4 明确禁止的兜底值（"没有 OTHER/UNKNOWN 兜底"）。这两个名字各自
       指向一个具体的域。 */
    CATALOG_INPUT_NOT_STRUCTURED: 'CATALOG_INPUT_NOT_STRUCTURED',
    INVENTORY_INPUT_NOT_STRUCTURED: 'INVENTORY_INPUT_NOT_STRUCTURED',
    /* ── P22-6 追加的两个（加法）──────────────────────────────────────────
       PURCHASE_REQUIRES_APPROVAL —— 这是 §4 的第三条路径。P22-4 的
       AMOUNT_EXCEEDS_APPROVAL_THRESHOLD 说的是"金额越过了审批线"，它
       是**预算评价**的 outcome 的 reasonCode；而 P22-6 需要的名字是
       "一次购买因为需要批准而**没有发生**"。两者不是同义：
         · 前者描述规则被触发的那条线（一个金额事实）；
         · 后者描述一次购买的结局（一件事没有做成）。
       把后者写成前者会让"这笔采购为什么没成"的答案变成"因为金额超过
       了 500"，而真实答案可能是"因为 autonomy_level 要求人工点头"。
       本阶段 Approval workflow **不存在**，因此它只表示"停在这里"，
       绝不表示"稍后会有人批准"。它**不伪装**成 FAILED（§11）。

       PURCHASE_NOT_SUPPORTED —— SERVICE_EXECUTION 在本阶段没有可原子
       执行的结算原语（Action 层未接入）。它必须是一个具名代码而不是
       复用 EFFECT_NOT_ALLOWED：后者说的是"这个 effect 不被允许"，而
       这里的真相是"这个 effect 还没有实现"。审计里"被规则拒绝"与
       "这一刻还做不到"必须可分 —— 与 P22-5 分出 PRODUCT_NOT_FOUND 的
       理由逐字同源。 */
    PURCHASE_REQUIRES_APPROVAL: 'PURCHASE_REQUIRES_APPROVAL',
    PURCHASE_NOT_SUPPORTED: 'PURCHASE_NOT_SUPPORTED',
    /* ── P22-7 追加的四个（加法）──────────────────────────────────────────
       P22-1 §4 冻结的 APPROVAL 词表（AUTO_APPROVED / USER_APPROVAL_REQUIRED /
       DENIED）是**一次购买结局的三种词**；P22-7 需要的是"一个批准记录处在
       哪个状态"（APPROVAL_STATE，五个词）与"这次授权判定为什么是这个
       结局"（下面四个代码）。两件事分属两层，因此刻意**不**把新状态塞进
       APPROVAL —— 那会让"这笔购买被自动批准了"与"这条批准记录已被消费"
       共用同一个词。

       ★ AUTONOMY_NOT_PERMITTED 与 AUTONOMY_LIMIT 这两个代码 P22-1 就已经
       冻结在**上面**（§22 的自主额度语义），因此本阶段新增的是四个而不是
       六个。P22-7 是它们第一次真的有写入方：
         · AUTONOMY_LIMIT         —— 触碰了 perPurchaseLimitMinor /
                                     dailyAutonomousLimitMinor 这两条**额度**；
         · AUTONOMY_NOT_PERMITTED —— 这件商品 / 这次结算形态不在自主范围内，
                                     或者这台 Agent 根本没有开启自主购买。

       APPROVAL_REQUIRED 与 PURCHASE_REQUIRES_APPROVAL 的差别是**阶段**：
       后者是 P22-6 结算时预算翻转的产物（"流程被放弃"），前者是 P22-7
       授权闸门的产物（"停下来，去创建一条待批准记录"）。合并它们会让
       "这笔为什么没成"在两个完全不同的时刻给出同一个答案。

       APPROVAL_NOT_FOUND   —— 那条批准记录不存在。刻意不复用
       POLICY_NOT_FOUND：purchase / quote / policy 都有各自的 not-found
       代码，而一条**记录**的缺席与一条**规则**的缺席在运维上是两件事。
       APPROVAL_MISMATCH    —— 批准绑定的是另一个 Quote / 金额 / recipient /
       数量 / 结算形态。这是 §6 的核心拒绝：一张批准不能被挪给另一笔购买。
       APPROVAL_NOT_CONSUMED —— 结算时授权模式声称"这笔购买是被某条批准
       授权的"，而那条批准并没有被消费过。它是 P22-6 与 P22-7 两块事实
       之间的一致性检查，不是任何业务规则。 */
    APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
    APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
    APPROVAL_MISMATCH: 'APPROVAL_MISMATCH',
    APPROVAL_NOT_CONSUMED: 'APPROVAL_NOT_CONSUMED',
    /* ★ APPROVAL_EXPIRED 是第五个，而它的缺席曾经是一个**真实缺陷**
       （开发期实测）：store 层在三条路径上写 `C.DENY_REASON.APPROVAL_EXPIRED`，
       而这个成员**不在**这个封闭集合里 —— 于是 `String(undefined)` 让返回
       里的 reasonCode 变成字面量字符串 "undefined"。症状与前两次同源
       （P22-6 的 `policyRow.policy_id`、budgetRefusalOf 的 `.detail`）：
       拒绝发生了，但**为什么**被拒绝消失了。
       为什么它不能复用别的代码：
         · PURCHASE_REQUIRES_APPROVAL —— "需要有人点头"；
         · TRANSITION_NOT_ALLOWED  —— "这条批准已经不是待决定状态了"；
         · APPROVAL_MISMATCH        —— "这条批准说的是另一件事"。
       而这里是第四句话："这条批准**已经过期**，请重新申请一条"。它与
       QUOTE_EXPIRED / RESERVATION_EXPIRED 是同一种事实（时间到了），
       而"时间到了"在审计里必须能与"规则说不"分开。
       ★ 封闭集合因此从 46 变成 47。 */
    APPROVAL_EXPIRED: 'APPROVAL_EXPIRED'
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
    /* ── P22-5 追加的一种（加法）─────────────────────────────────────────
       STORE（econ_store_）是"货架"的身份。product 与 inventory 的前缀
       P22-1 就已经冻结在这里了 —— 那时候它们还没有表，只有形状；P22-5
       才第一次真的写下一行。这正是"先冻结形状、后实现"要得到的效果：
       实现时不需要发明任何新的 id 形状。 */
    STORE: 'econ_store_',
    PRODUCT: 'econ_product_',
    INVENTORY_ENTRY: 'econ_inv_',
    QUOTE: 'econ_quote_',
    EXCHANGE_RATE: 'econ_rate_',
    PURCHASE_INTENT: 'econ_intent_',
    /* ── P22-7 追加的一种（加法）─────────────────────────────────────────
       APPROVAL（econ_approval_）是"一条批准记录"的身份。为什么它不能复用
       已有的两种 id：
         · PURCHASE_INTENT（econ_intent_）是**一次打算买什么**的身份 ——
           它由 P22-6 用掉了（economy_purchases 的主键），而一条批准记录
           与它所授权的那笔购买是**两个**实体（§5：Approval ≠ Purchase）。
           共用一个前缀会让"这条 id 指向批准还是购买"永远需要看第二个字段；
         · BUDGET_POLICY（econ_policy_）是**规则**的身份。一条批准记录不是
           规则：规则可以被反复求值，而一条批准恰好被消费一次（§8）。
       因此批准拿到自己的前缀，这也让它与自主政策（复用 BUDGET_POLICY /
       econ_policy_ 的同一种记录形状，见 §3）在字形上就不会被混淆。 */
    APPROVAL: 'econ_approval_',
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
    FAIL: 'FAIL',
    /* ── P22-4 追加的两个（加法）──────────────────────────────────────────
       QUOTE / POLICY 与上面五个共用同一张幂等表与同一套 (scope, key) 语义，
       但它们锁的不是钱：createQuote 锁的是一次报价，putBudgetPolicy 锁的是
       一次规则变更。放进同一个 scope 空间是刻意的 —— "同一个 key 在
       RESERVE 与 COMMIT 下是两件事"这条已经冻结的纪律，对
       "同一个 key 在 QUOTE 与 POLICY 下也是两件事"逐字成立。 */
    QUOTE: 'QUOTE',
    POLICY: 'POLICY',
    /* ── P22-5 追加的四个（加法）──────────────────────────────────────────
       STORE / PRODUCT 是"配置数据"的两次写入；INVENTORY_GRANT /
       INVENTORY_CONSUME 是库存原语的两次写入。
       为什么配置数据也要幂等：一次 store/product 写入同样会消耗一个
       revision、写一条 change log、并在崩溃后留下**部分**状态 —— 它
       与一次 reserve 面对的是同一个重试问题（"这次请求做过没有"）。
       把它们排除在幂等之外，等于让"配置数据"成为唯一一种崩溃后必须靠
       人工判断的写。
       INVENTORY_GRANT 与 INVENTORY_CONSUME 刻意是**两个** scope，而不是
       一个 INVENTORY：同一个 key 分别用于一次 grant 与一次 consume 是
       两件不同的事，把两者压成一个 scope 会让"我那次发放到底成没成"
       收到一个关于消耗的答案。 */
    STORE: 'STORE',
    PRODUCT: 'PRODUCT',
    INVENTORY_GRANT: 'INVENTORY_GRANT',
    INVENTORY_CONSUME: 'INVENTORY_CONSUME',
    /* ── P22-6 追加的两个（加法）──────────────────────────────────────────
       PURCHASE_PREPARE / PURCHASE_SETTLE 是一条**高层**流程的两个阶段。
       为什么它们不能共用 P22-3 已有的 RESERVE / COMMIT：
         · 同一个 HTTP/内部请求里的 key 会被 prepare 与 settle 各用一次，
           而 RESERVE/COMMIT 的语义是"锁钱 / 把锁变成事实"——那是
           Purchase **内部**的两步，不是调用方看到的两步。压成同一个
           scope 会让"我那次购买准备成没成"与"我那笔预留成没成"变成
           同一个问题，而它们的答案在时间上不同（prepare 之后 settle
           可能永远不发生）。
         · P22-3 的 RESERVE/COMMIT 继续为**独立的** reserve/commit 用法
           服务（P22-5 的库存、P22-3 自己的测试），一个字不改。
       scope 增加是加法：既有的 11 个 (scope, key) 身份逐字不变。 */
    PURCHASE_PREPARE: 'PURCHASE_PREPARE',
    PURCHASE_SETTLE: 'PURCHASE_SETTLE',
    /* ── P22-7 追加的四个（加法）──────────────────────────────────────────
       为什么一条**批准**需要三个 scope 而不是一个 APPROVAL：
         · APPROVAL_REQUEST —— 一次"请求批准"。重试同一个 key 必须返回
           同一条批准记录，而不是创建第二条（"我那次请求批准成没成"）；
         · APPROVAL_DECIDE  —— 一次**决定**。它与 request 是两件事：请求
           由 Agent 发起，决定只可能来自**第三方**（买方不能批准自己的购买，
           这条由 store 层结构性拒绝），而两者的重试语义不同（一次决定成功
           后不可能再被"重放成另一个决定"）；
         · APPROVAL_CONSUME —— 一次"把批准用掉"。它是**授权转变**的一部分，
           因此它与 PURCHASE_PREPARE 在同一个事务里，但它的 (scope, key)
           身份必须独立：同一个 key 在"准备购买"与"消费批准"下是两件事。
       AUTONOMY_POLICY 与 POLICY 的分开同源：一次预算规则变更与一次自主
       规则变更是两件事，而它们的重试问题各自独立。
       ★ scope 增加是加法：既有的 13 个 (scope, key) 身份逐字不变。 */
    APPROVAL_REQUEST: 'APPROVAL_REQUEST',
    APPROVAL_DECIDE: 'APPROVAL_DECIDE',
    APPROVAL_CONSUME: 'APPROVAL_CONSUME',
    AUTONOMY_POLICY: 'AUTONOMY_POLICY'
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
  var QUOTE_STATE_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < QUOTE_STATES.length; i++) map[QUOTE_STATES[i]] = true;
    return map;
  })();

  /* ── Quote 状态机（P22-4）──────────────────────────────────────────────
     P22-1 §14 冻结了三个状态与"必须消费 quote"这条纪律，但**没有**写下
     转移表。P22-4 需要它，因为"已消费的报价不能回到 OPEN"必须是一条
     被**执行**的规则，而不是一句注释。于是这里补上转移表 —— 这是加法：
     QUOTE_STATE / QUOTE_STATES 的字面值一个字都没动。

     OPEN 是唯一的非终态：一份报价要么被用掉、要么过期，两者都不可逆。
     刻意**没有** CANCELLED：P22-4 §8 提到过它，但契约里没有这个字，而
     "作废一份还没被接受的报价"完全可以由**过期**表达（把 expiresAt 设到
     过去是调用方的决定，不是一个新的状态）。加一个契约里没有的状态是
     破坏性变更，不是实现它。 */
  var QUOTE_TRANSITIONS = Object.freeze({
    OPEN: Object.freeze([QUOTE_STATE.CONSUMED, QUOTE_STATE.EXPIRED]),
    CONSUMED: Object.freeze([]),
    EXPIRED: Object.freeze([])
  });

  var QUOTE_TERMINAL_STATES = Object.freeze(
    QUOTE_STATES.filter(function (s) { return QUOTE_TRANSITIONS[s].length === 0; })
  );

  function isQuoteState(value) {
    return value != null && QUOTE_STATE_INDEX[String(value)] === true;
  }

  function canTransitionQuote(from, to) {
    var f = String(from == null ? '' : from);
    var t = String(to == null ? '' : to);
    if (!QUOTE_STATE_INDEX[f] || !QUOTE_STATE_INDEX[t]) {
      return { ok: false, allowed: false, errors: ['quote-state-not-in-closed-set'] };
    }
    var allowed = QUOTE_TRANSITIONS[f].indexOf(t) >= 0;
    return { ok: true, allowed: allowed, errors: allowed ? [] : ['transition-not-allowed'], from: f, to: t };
  }

  function assertQuoteTransition(from, to) {
    var r = canTransitionQuote(from, to);
    if (!r.ok) return { ok: false, errors: r.errors };
    if (!r.allowed) {
      return {
        ok: false,
        errors: ['transition-not-allowed'],
        detail: (QUOTE_TERMINAL_STATES.indexOf(r.from) >= 0)
          ? 'terminal-quote-cannot-transition-must-create-a-new-quote'
          : 'transition-not-in-allowed-set'
      };
    }
    return { ok: true, errors: [] };
  }

  /* ── Quote 的种类（P22-4 §29）──────────────────────────────────────────
     为什么需要它：P22-1 §14 的 quote 形状把"买什么"表达成 productId +
     currency + quantity。这对普通商品够了，但 P22 §19 要求模型**未来**
     能表达 API_QUOTA / COMPUTE_CREDIT 这类"买算力额度"的报价，而它与
     "买一件商品"在结算形态上不是一回事：
        · PURCHASE     —— 钱从钱包流向 system:market（P22-3 §10 允许的
                          两个对手方之一）；
        · GIFT         —— 同上，但 recipientId 有值（买给谁）；
        · COMPUTE_GRANT —— 额度从 system:treasury 流向钱包（不花钱买，
                          而是被授予）；API_QUOTA 报价的结算形态就是它。
     因此 kind 必须存在，且必须是**封闭集合**：一个自由字符串会让
     "这份报价将来该怎么结算"变成一次运行时猜测。
     注意 kind 不携带任何金额语义 —— 金额仍然只有 amountMinor 一个来源。 */
  var QUOTE_KIND = Object.freeze({
    PURCHASE: 'PURCHASE',
    GIFT: 'GIFT',
    COMPUTE_GRANT: 'COMPUTE_GRANT'
  });

  var QUOTE_KINDS = Object.freeze(Object.keys(QUOTE_KIND));
  var QUOTE_KIND_INDEX = (function () {
    var map = Object.create(null);
    for (var q = 0; q < QUOTE_KINDS.length; q++) map[QUOTE_KINDS[q]] = true;
    return map;
  })();

  function isQuoteKind(value) {
    return value != null && QUOTE_KIND_INDEX[String(value)] === true;
  }

  /* kind → 结算时的 ledger transaction type。这是一张**数据**表，不是
     散落的条件分支；它的每个值都必须是冻结的 TX_TYPE 成员（下面有一条
     自检，任何拼错都会在契约载入期就失败）。
     为什么 API_QUOTA 落在这里：一份 API 额度报价的结算就是"额度被授予"，
     而冻结词表里表达它的正是 COMPUTE_GRANT —— 不需要新造 transaction
     type，也不需要碰 provider（P22-4 §24：Economy→Provider 写路径仍然
     结构性不存在）。 */
  var QUOTE_SETTLEMENT_TYPE = Object.freeze({
    PURCHASE: 'PURCHASE',
    GIFT: 'GIFT',
    COMPUTE_GRANT: 'COMPUTE_GRANT'
  });

  function settlementTypeOfQuoteKind(kind) {
    if (!isQuoteKind(kind)) return null;
    return QUOTE_SETTLEMENT_TYPE[String(kind)];
  }

  function validateQuote(input, now) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId('QUOTE', o.quoteId)) errors.push('quote-id-not-canonical');
    if (!isEconomyId('PRODUCT', o.productId)) errors.push('product-id-not-canonical');
    /* kind 是**可选**的加法：缺省是 PURCHASE（P22-1 冻结的那一种）。
       给了就必须在封闭集合里 —— 一个未登记的种类会让"将来怎么结算"
       无法回答。 */
    if (o.kind != null && !isQuoteKind(o.kind)) errors.push('quote-kind-not-in-closed-set');
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var amt = normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) errors.push.apply(errors, amt.errors);
    if (!Number.isSafeInteger(o.quantity) || o.quantity < 1) errors.push('quote-quantity-must-be-positive-safe-integer');
    if (!Number.isFinite(Number(o.expiresAt))) errors.push('quote-expires-at-not-a-number');
    if (!isQuoteState(o.state)) errors.push('quote-state-not-in-closed-set');
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
     §14b · Budget Evaluation Contract（P22-4）

     这一节回答的核心问题：

         「这项经济行为在当前预算规则下**是否允许**？」

     而**不是**：

         「Agent 想不想买？」（Decision 的事）
         「钱够不够？」（Wallet 的事，虽然它是本评估的一项输入）
         「要不要用户批准？」（Approval 的事 —— 本层只**分类**，不执行）
         「是否真的执行？」（Action 的事）

     五个问题的边界必须清楚，因为把它们混起来的最常见后果是：
     LLM 说"我很想买"→ 某个 if 分支把它读成"预算允许"。
     本节的实现方式不是"记得别读正文"，而是让**那段文字没有地方可以放**。
     ══════════════════════════════════════════════════════════════════ */

  /* ── 什么算"花掉了"────────────────────────────────────────────────────
     P22-4 §14 明确禁止用 `amount < 0` 去猜。理由是可以验证的：ledger 的
     canonical amount 是**无符号**的（§10），方向在 direction 列上，因此
     "金额是负数"这件事在数据里根本不存在 —— 靠它判断消费的代码会在
     真实数据上永远得到 0，而测试如果也只喂正数就会是绿的。
     因此这里把"哪些 transaction 是消费"写成一张**数据**表，逐 type 回答。

     三种取值，刻意互不相同：
       'SPEND'   钱从这个 owner 的账上真的出去了，计入窗口累计。
       'NEUTRAL' 钱动了，但不是消费（增发 / 销毁 / 补偿退款 / 与系统账户
                 的额度授予），不计入任何窗口。
       null      这个 type **不在冻结词表里** ⇒ 调用方必须 fail closed。

     为什么 EXCHANGE 是 NEUTRAL 而不是 SPEND：兑换是**同一 owner 内部**
     的币种搬移（P22-6 的语义），本阶段的政策按 (owner, currency) 作用域，
     而兑换在源币种上的 debit 与目标币种上的 credit 属于两个不同的政策。
     把它记成"消费"会让一次换钱永久吃掉某个币种的日额度 —— 那是一条
     没人要求过的规则。而 API 额度授予（COMPUTE_GRANT）同理：额度是
     **被授予**的，它不花这个 owner 的预算。

     这张表是**封闭**的：BUDGET_SPEND_CLASSES 的键必须与 TX_TYPES 逐字
     相等，下面有一条载入期自检。于是"新增一个 transaction type 却忘了
     说它算不算消费"会在契约载入时就失败，而不是在某个窗口的求和里
     静默地少算一笔。 */
  var BUDGET_SPEND_CLASS = Object.freeze({
    PURCHASE: 'SPEND',
    GIFT: 'SPEND',
    COMPUTE_CONSUME: 'SPEND',
    EXCHANGE: 'NEUTRAL',
    COMPUTE_GRANT: 'NEUTRAL',
    REFUND: 'NEUTRAL',
    MINT: 'NEUTRAL',
    BURN: 'NEUTRAL'
  });

  /* 窗口累计只统计这些 type。顺序固定，便于审计与测试逐条断言。 */
  var BUDGET_SPENDING_TYPES = Object.freeze(
    TX_TYPES.filter(function (t) { return BUDGET_SPEND_CLASS[t] === 'SPEND'; })
  );

  var BUDGET_NEUTRAL_TYPES = Object.freeze(
    TX_TYPES.filter(function (t) { return BUDGET_SPEND_CLASS[t] === 'NEUTRAL'; })
  );

  function spendClassOfTransactionType(type) {
    var t = type == null ? '' : String(type);
    if (TX_TYPES.indexOf(t) < 0) return null;
    return BUDGET_SPEND_CLASS[t];
  }

  function isSpendingTransactionType(type) {
    return spendClassOfTransactionType(type) === 'SPEND';
  }

  /* ── 消费窗口：UTC，显式，无 locale ───────────────────────────────────
     P22-4 §13 要求边界明确、不得隐式使用系统 locale。因此：
       day    = floor(now / 86400000) * 86400000            （UTC 日）
       week   = 该 UTC 日所属的**周一** 00:00Z               （ISO 周起点）
       month  = 该 UTC 月的 1 日 00:00Z
     日与周是**纯算术**（UTC 没有夏令时，因此不存在"某一天有 23 小时"
     这种事）。月必须读日历（月份长度不一），但读的是 `Date.UTC(...)` 的
     纯数值结果，**不读**时区、不读 locale、不读环境变量。
     三个函数都是纯的：同一个 now 永远得到同一个边界。 */
  var MS_PER_DAY = 86400000;

  function utcDayStart(now) {
    var n = Number(now);
    if (!Number.isFinite(n)) return null;
    var day = Math.floor(n / MS_PER_DAY);
    if (!Number.isSafeInteger(day)) return null;
    return day * MS_PER_DAY;
  }

  function utcWeekStart(now) {
    var day = utcDayStart(now);
    if (day === null) return null;
    /* 1970-01-01 是**周四**。周起点定在周一 ⇒ 对齐时刻是 1969-12-29
       （= -3 天）。用常数而不是 `getUTCDay()`，是为了让这条规则在
       代码里就是一个可读的算式，而不是一次库调用。 */
    var MONDAY_ALIGNED_EPOCH = -3 * MS_PER_DAY;
    return MONDAY_ALIGNED_EPOCH + Math.floor((day - MONDAY_ALIGNED_EPOCH) / (7 * MS_PER_DAY)) * (7 * MS_PER_DAY);
  }

  /* 月边界必须读日历（月份长度不一），但读的是**纯整数日期算法**：
       · 先把毫秒化成"距 1970-01-01 的天数"，
       · 再用 Howard Hinnant 的 civil-from-days 换算成 (y, m, d)，
       · 然后取该月 1 日 00:00Z。
     刻意**不用** `new Date(...)` / `getUTCMonth()`：契约的载入期纪律是
     "零时钟、零 locale、零平台日历"（boundary B1.5 逐字断言），而上面
     这个算法对任意有限的 now 都返回同一个整数 —— 它不依赖时区数据库、
     夏令时规则或运行时的区域设置。UTC 没有夏令时，因此"某个月有几天"
     是纯粹的历法事实。 */
  function daysFromCivilDaysSinceEpoch(dayNumber) {
    /* dayNumber 是"距 1970-01-01 的天数"，可能为负（1970 之前）。 */
    var z = dayNumber + 719468;
    var era = Math.floor(z / 146097);
    var doe = z - era * 146097;                                        /* [0, 146096] */
    var yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    var y = yoe + era * 400;
    var doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    var mp = Math.floor((5 * doy + 2) / 153);
    var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    var m = mp + (mp < 10 ? 3 : -9);
    return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
  }

  function utcMonthStart(now) {
    var n = Number(now);
    if (!Number.isFinite(n)) return null;
    if (!Number.isSafeInteger(Math.floor(n))) return null;
    var dayNumber = Math.floor(n / MS_PER_DAY);
    var civil = daysFromCivilDaysSinceEpoch(dayNumber);
    /* 该月的第 0 天（= 上个月最后一天）也能被同一算法表达，于是这里
       用"把天数倒回本月 1 日"来得到月起点，而不是再写一遍年月换算。 */
    var back = civil.day - 1;
    if (back !== 0 && !Number.isSafeInteger(dayNumber - back)) return null;
    return (dayNumber - back) * MS_PER_DAY;
  }

  var BUDGET_WINDOW = Object.freeze({ DAY: 'DAY', WEEK: 'WEEK', MONTH: 'MONTH' });
  var BUDGET_WINDOWS = Object.freeze(Object.keys(BUDGET_WINDOW));
  var BUDGET_TIMEZONE = 'UTC';

  var WINDOW_START_OF = Object.freeze({
    DAY: utcDayStart,
    WEEK: utcWeekStart,
    MONTH: utcMonthStart
  });

  function budgetWindowStart(window, now) {
    var fn = WINDOW_START_OF[String(window == null ? '' : window)];
    if (!fn) return null;
    return fn(now);
  }

  /* ── 政策词表（P22-4 §3，全部是**加法**）────────────────────────────
     P22-1 §13 冻结了 budget **输入**（BUDGET_INPUT_KEYS / BUDGET_LIMIT_KEYS）
     与 AUTONOMY_LEVEL，但刻意没有冻结"政策记录长什么样"—— 那时还没有
     持久化。P22-4 需要它，于是这里补上，且单位全部显式带 `Minor` 后缀
     （§4：Economy 不得出现裸的 budget / price / amount）。

     status 用二元词表而不是 enabled 布尔：布尔值在数据里无法表达第三个
     状态（"暂停"与"从未启用"是两件事），而 policy 的读取面必须是
     可枚举的。 */
  var POLICY_STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    DISABLED: 'DISABLED'
  });

  var POLICY_STATUSES = Object.freeze(Object.keys(POLICY_STATUS));

  /* 期限终止的原因。与 status 分开：政策"结束"可以是到点了，也可以是
     被显式停用，而这两者在审计里是不同的事件（§21）。 */
  var POLICY_TERM = Object.freeze({
    NONE: 'NONE',
    EXPIRED: 'EXPIRED',
    DISABLED: 'DISABLED'
  });

  var POLICY_TERMS = Object.freeze(Object.keys(POLICY_TERM));

  /* 只有这些 status 允许出现在政策读取面上。一个未登记的状态意味着
     "这条政策是不是生效的"无法回答 ⇒ 必须 fail closed（§17）。 */
  function isPolicyStatus(value) {
    return value != null && POLICY_STATUSES.indexOf(String(value)) >= 0;
  }

  /* 政策是否在**这个** now 上生效。纯函数：同一个 (policy, now) 永远
     得到同一个答案，因此"政策到期了没有"不需要任何定时器，与
     reservation / quote 的到期判定是同一条纪律（§10/§13）。 */
  function policyIsEffectiveAt(policy, now) {
    /* policy == null 是"这个作用域上没有规则"—— 一个真实、可回答的情形
       （调用方查了，没查到）。它与"规则本身形状不对"是两件事，因此这里
       返回 ok:true + effective:false + POLICY_NOT_FOUND，而不是结构化失败。
       把两者混起来会让运维无法区分"这个 owner 根本没配预算"与"预算这
       一面坏了"，而那正是 §17 要求分开的两个答案。 */
    if (policy == null) {
      return { ok: true, effective: false, reason: 'POLICY_NOT_FOUND', errors: [] };
    }
    if (typeof policy !== 'object' || Array.isArray(policy)) {
      return { ok: false, effective: false, reason: 'POLICY_NOT_FOUND', errors: ['policy-must-be-an-object'] };
    }
    if (!isPolicyStatus(policy.status)) return { ok: false, effective: false, reason: 'POLICY_NOT_FOUND', errors: ['policy-status-not-in-closed-set'] };
    if (String(policy.status) !== POLICY_STATUS.ACTIVE) {
      return { ok: true, effective: false, reason: 'POLICY_NOT_FOUND', errors: [] };
    }
    if (policy.termEndsAt != null) {
      var end = Number(policy.termEndsAt);
      if (!Number.isFinite(end) || !Number.isSafeInteger(end) || end < 0) {
        return { ok: false, effective: false, reason: 'POLICY_NOT_FOUND', errors: ['policy-term-ends-at-not-a-non-negative-safe-integer'] };
      }
      if (!Number.isFinite(Number(now))) {
        return { ok: false, effective: false, reason: 'POLICY_NOT_FOUND', errors: ['policy-term-comparison-needs-a-finite-now'] };
      }
      if (end <= Number(now)) {
        return { ok: true, effective: false, reason: 'POLICY_TERM_EXPIRED', errors: [] };
      }
    }
    return { ok: true, effective: true, reason: null, errors: [] };
  }

  /* ── 政策的 limits（与 §13 的 BUDGET_LIMIT_KEYS 同一套词）─────────────
     一张**可枚举**的表：name = 冻结的 limit 键，field = 持久化列，
     reason = 违规时的 DENY_REASON，window = 它对照哪个消费窗口（null 表示
     它不是窗口累计类）。
     把这张表写出来的理由与 §7 的转移表相同：一张数据表可以被穷举断言，
     而散落的 if 只能被读。 */
  var POLICY_LIMIT_TABLE = Object.freeze([
    Object.freeze({ name: 'perTransactionMinor', field: 'max_per_tx_minor', reason: 'AMOUNT_EXCEEDS_PER_TRANSACTION', window: null }),
    Object.freeze({ name: 'dailyMinor', field: 'max_per_day_minor', reason: 'DAILY_LIMIT', window: 'DAY' }),
    Object.freeze({ name: 'weeklyMinor', field: 'max_per_week_minor', reason: 'WEEKLY_LIMIT', window: 'WEEK' }),
    Object.freeze({ name: 'monthlyMinor', field: 'max_per_month_minor', reason: 'MONTHLY_LIMIT', window: 'MONTH' })
  ]);

  var POLICY_LIMIT_NAMES = Object.freeze(POLICY_LIMIT_TABLE.map(function (r) { return r.name; }));

  /* 窗口累计规则：**顺序即优先级**（P22-4 §15 的 7/8/9 三条）。
     顺序写死在数组里，因此"同一输入只可能得到一个 reasonCode"这件事
     是可穷举验证的，而不是"取决于对象键的枚举顺序"。 */
  var BUDGET_WINDOW_RULES = Object.freeze([
    Object.freeze({ limit: 'dailyMinor', usage: 'spentTodayMinor', reason: 'DAILY_LIMIT', window: 'DAY' }),
    Object.freeze({ limit: 'weeklyMinor', usage: 'spentThisWeekMinor', reason: 'WEEKLY_LIMIT', window: 'WEEK' }),
    Object.freeze({ limit: 'monthlyMinor', usage: 'spentThisMonthMinor', reason: 'MONTHLY_LIMIT', window: 'MONTH' })
  ]);

  var BUDGET_USAGE_WINDOW_KEYS = Object.freeze(BUDGET_WINDOW_RULES.map(function (r) { return r.usage; }));

  var BUDGET_DECISION = Object.freeze({
    ALLOW: 'ALLOW',
    DENY: 'DENY',
    REQUIRE_APPROVAL: 'REQUIRE_APPROVAL'
  });

  var BUDGET_DECISIONS = Object.freeze(Object.keys(BUDGET_DECISION));

  /* 评估顺序是**编号的常量**，不是注释：结果里会带回 `priority`，
     于是"为什么是这个 reasonCode 而不是另一个"可以从输出直接读出来，
     测试也能逐条断言优先级（§30：同一输入只能得到一个 reasonCode）。 */
  var BUDGET_EVALUATION_PRIORITY = Object.freeze([
    'policy-effective',          /* 1  规则在这个作用域与这个时刻存在且生效 */
    'wallet-ready',              /* 2  canonical 余额是否可信（不是"够不够"）*/
    'policy-scope',              /* 3  ownerId / currency 是否就是政策的作用域 */
    'amount-valid',              /* 4  金额是否是 canonical 量（> 0）*/
    'available-balance',         /* 5  wallet affordability：available >= amount */
    'per-transaction',           /* 6  单笔上限 */
    'daily',                     /* 7  日额度 */
    'weekly',                    /* 8  周额度 */
    'monthly',                   /* 9  月额度 */
    'approval-threshold',        /* 10 超过审批线 ⇒ REQUIRE_APPROVAL（不是 DENY）*/
    'allow'                      /* 11 */
  ]);

  /* 结果形状。三个 outcome 各自**恒有**一个 reasonCode：
     ALLOW → 'BUDGET_ALLOWED'、REQUIRE_APPROVAL → AMOUNT_EXCEEDS_APPROVAL_THRESHOLD、
     DENY → 封闭集合里的一个具名原因（绝不自由文本）。
     快照语义写在 `snapshot` 块里（见下面的 budgetDecision）。 */
  var BUDGET_ALLOWED_REASON = 'BUDGET_ALLOWED';

  function budgetDecision(outcome, reasonCode, extra) {
    return Object.assign({
      domain: DOMAIN,
      namespace: NAMESPACES.BUDGET,
      outcome: String(outcome),
      allowed: String(outcome) === BUDGET_DECISION.ALLOW,
      requiresApproval: String(outcome) === BUDGET_DECISION.REQUIRE_APPROVAL,
      denied: String(outcome) === BUDGET_DECISION.DENY,
      reasonCode: reasonCode == null ? null : String(reasonCode),
      /* 快照语义写成一个**嵌套的、可断言的声明块**，而不是一个裸布尔。
         两个理由：
           ① 它要回答的问题有三个侧面 —— 这是什么（快照）、它不是
              什么（不是一张可以拿去执行的许可）、它是关于哪个时刻的 ——
              而一个 boolean 只能回答第一个；
           ② 一个叫 `approval` 的顶层字段会与本文件的凭据边界
              （boundary B6.3：Economy 不读 HTTP 的 Approval 头）
              在文本上撞车。撞车的后果不是编译错误，而是那条安全断言
              不得不为一个**正确的**新字段开一个例外 —— 而给安全断言
              开例外正是它最容易失效的方式。因此这里换一个词，让那条
              断言继续逐字成立。 */
      snapshot: Object.freeze({
        kind: 'evaluation',
        authority: 'none',
        at: extra && extra.evaluatedAt != null ? Number(extra.evaluatedAt) : null
      }),
      timezone: BUDGET_TIMEZONE
    }, extra || {});
  }

  /* ── limits 归一（暴露出来是为了让 store 与测试用**同一个**规则）───── */
  function normalizePolicyLimits(raw) {
    if (raw == null) return { ok: true, limits: Object.freeze({}), errors: [] };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, limits: null, errors: ['policy-limits-must-be-a-structured-object'] };
    }
    var errors = [];
    var out = {};
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (raw[k] == null) continue;                       /* 未设置 = 该档不启用 */
      if (k === COOLDOWN_KEY) {
        /* 与 §13 的 normalizeBudgetInput 逐字同款：cooldown 是**时长**，
           不是金额，因此不走 normalizeAmountMinor。 */
        var cd = raw[k];
        if (typeof cd !== 'number' || !Number.isSafeInteger(cd) || cd < 0) {
          errors.push('policy-cooldown-must-be-non-negative-safe-integer');
          continue;
        }
        out[k] = cd;
        continue;
      }
      if (BUDGET_LIMIT_KEYS.indexOf(k) < 0) {
        errors.push('policy-limit-key-not-in-closed-set');
        continue;
      }
      var amt = normalizeAmountMinor(raw[k]);
      if (!amt.ok) { errors.push('policy-limit-value-must-be-an-amount-minor'); continue; }
      out[k] = amt.amountMinor;
    }
    if (errors.length) return { ok: false, limits: null, errors: errors };
    return { ok: true, limits: Object.freeze(out), errors: [] };
  }

  function validateBudgetPolicy(input) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId('BUDGET_POLICY', o.policyId)) errors.push('budget-policy-id-not-canonical');
    var owner = promotePartyRef(o.ownerId);
    if (!owner) errors.push('policy-owner-invalid');
    else if (owner.type === PARTY_TYPE.SYSTEM) errors.push('system-party-cannot-own-a-budget-policy');
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var limits = normalizePolicyLimits(o.limits);
    if (!limits.ok) errors.push.apply(errors, limits.errors);
    if (o.status != null && !isPolicyStatus(o.status)) errors.push('policy-status-not-in-closed-set');
    if (o.termEndsAt != null) {
      var end = Number(o.termEndsAt);
      if (!Number.isSafeInteger(end) || end < 0) errors.push('policy-term-ends-at-must-be-a-non-negative-safe-integer');
    }
    if (o.autonomyLevel != null && AUTONOMY_LEVELS.indexOf(String(o.autonomyLevel)) < 0) {
      errors.push('policy-autonomy-level-not-in-closed-set');
    }
    if (errors.length) return { ok: false, policy: null, errors: errors };
    return {
      ok: true,
      errors: [],
      policy: Object.assign({}, o, {
        ownerId: Object.freeze({ type: owner.type, id: owner.id }),
        currency: cur.currency,
        limits: limits.limits
      })
    };
  }

  /* ── 确定性评估器（P22-4 §2/§15/§16/§17）─────────────────────────────
     签名刻意是一对 (policy, context) —— 两个**数据**参数，没有 store、
     没有时钟、没有随机、没有任何 I/O。于是：

       same policy + same context  ⇒  same result

     是**结构性**成立，而不是"我们小心地没有引入不确定性"。这一点可以被
     真的证伪：把同一个调用跑一千次、把键的顺序打乱、把对象深拷贝 ——
     结果必须逐字节相同（P22-4 测试的 B 组）。

     context 的键**必须**来自 §13 的白名单（normalizeBudgetInput 是唯一
     入口），因此 prompt / persona / relationship / llmOutput 这类键
     在这里是**无处可放**的：它们会被判成 policy-input-key-not-whitelisted
     或 policy-input-carries-non-deterministic-text。 */
  function evaluateBudget(policy, context) {
    var reason = BUDGET_ALLOWED_REASON;

    /* ── 1 规则存在且生效（在**事务之前**就做完，因为它不依赖任何事实） */
    var effective = policyIsEffectiveAt(policy, context && context.timestamp);
    if (!effective.ok) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, {
        errors: effective.errors, priority: BUDGET_EVALUATION_PRIORITY[0], systemFailure: false
      });
    }
    if (!effective.effective) {
      return budgetDecision(BUDGET_DECISION.DENY, effective.reason, {
        errors: ['no-effective-budget-policy-in-this-scope'],
        priority: BUDGET_EVALUATION_PRIORITY[0],
        policyStatus: policy ? String(policy.status) : null,
        policyTermEndsAt: (policy && policy.termEndsAt != null) ? Number(policy.termEndsAt) : null
      });
    }

    /* context 必须先是结构化确定性数据 —— 在任何其它判断之前。 */
    var norm = normalizeBudgetInput(context);
    if (!norm.ok) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, {
        errors: norm.errors, priority: BUDGET_EVALUATION_PRIORITY[0]
      });
    }
    var ctx = norm.input;
    var limits = normalizePolicyLimits(policy.limits);
    if (!limits.ok) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, {
        errors: limits.errors, priority: BUDGET_EVALUATION_PRIORITY[0]
      });
    }
    /* availableBalanceMinor 不是政策的**限额**，而是 wallet 的事实。
       把它放进 limits 是 §13 冻结的形状（BUDGET_LIMIT_KEYS 里有它），
       因为评估器只允许从一个地方读"钱有多少"。 */
    var caps = Object.assign({}, limits.limits);
    if (caps.availableBalanceMinor == null && ctx.limits && ctx.limits.availableBalanceMinor != null) {
      caps.availableBalanceMinor = ctx.limits.availableBalanceMinor;
    }
    /* 三个窗口累计值必须**都在**且都是 canonical 量。缺一个就意味着
       "某个额度用掉了多少"未知，而未知不能被当成 0 —— 那会让一次评估
       在一个不完整的快照上得出 ALLOW，正是 §17 要挡的形状。 */
    var usage = {};
    for (var w = 0; w < BUDGET_USAGE_WINDOW_KEYS.length; w++) {
      var usageKey = BUDGET_USAGE_WINDOW_KEYS[w];
      if (ctx.usage == null || ctx.usage[usageKey] == null) {
        return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, {
          errors: ['budget-context-must-carry-' + usageKey],
          priority: BUDGET_EVALUATION_PRIORITY[0]
        });
      }
      var usageAmt = normalizeAmountMinor(ctx.usage[usageKey]);
      if (!usageAmt.ok) {
        return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, {
          errors: ['budget-context-usage-value-is-not-canonical:' + usageKey],
          priority: BUDGET_EVALUATION_PRIORITY[0]
        });
      }
      usage[usageKey] = usageAmt.amountMinor;
    }

    /* ── 2 canonical 余额是否可信。注意这一条问的不是"够不够"，而是
          "我们知不知道有多少" —— COLD / DEGRADED 的诚实回答是"不知道"，
          而"不知道"必须 fail closed。 */
    if (ctx.walletState == null || ctx.walletState !== WALLET_STATE.READY) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.WALLET_NOT_READY, {
        errors: ['wallet-state-does-not-allow-spend'],
        priority: BUDGET_EVALUATION_PRIORITY[1],
        walletState: ctx.walletState == null ? null : String(ctx.walletState),
        /* 这条拒绝的成因在**系统侧**（数据库关了 / 引用链断了），
           不在业务侧。系统故障与业务拒绝必须可区分（§17）。 */
        systemFailure: true
      });
    }

    /* ── 3 作用域：owner 与 currency 必须就是这条政策的作用域。
          刻意**不**做任何汇率换算：政策按 (owner, currency) 冻结，
          把 100 COMPUTE_PREMIUM 拿去比对 IB_CREDIT 的额度需要一条汇率，
          而汇率属于 P22-6。 */
    if (!partyRefEquals(ctx.ownerId, policy.ownerId)) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.POLICY_NOT_FOUND, {
        errors: ['budget-policy-owner-does-not-match-the-evaluated-owner'],
        priority: BUDGET_EVALUATION_PRIORITY[2]
      });
    }
    if (String(ctx.currency) !== String(policy.currency)) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.INVALID_CURRENCY, {
        errors: ['budget-policy-currency-does-not-match-the-evaluated-currency'],
        priority: BUDGET_EVALUATION_PRIORITY[2],
        policyCurrency: String(policy.currency),
        contextCurrency: String(ctx.currency)
      });
    }

    /* ── 4 金额。0 金额在契约里是合法的（§3 下界就是 0），但在预算评估里
          它既不该被允许也不该被拒绝 —— 它根本没有经济内容。判成
          INVALID_AMOUNT 与 reserve 拒绝 0 金额是同一条纪律。
          `== null`（而不是 `=== 0n`）也覆盖"没给金额"：一个缺席的值与一个
          写着 0 的值在这里是同一件事（没有经济内容），而把它们分别判成
          "结构错误"与"金额非法"会让同一个业务问题有两个代码。 */
    if (ctx.amountMinor == null || ctx.amountMinor === 0n) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.INVALID_AMOUNT, {
        errors: ['budget-evaluation-amount-must-be-positive'],
        priority: BUDGET_EVALUATION_PRIORITY[3]
      });
    }
    var amount = ctx.amountMinor;

    /* ── 5 wallet affordability。available 必须**存在**：COLD/DEGRADED 时
          它是 null，而"未知"绝不能被兜成 0（那会把系统故障伪装成
          "余额不足"，正是 §17 点名禁止的形状）。 */
    if (caps.availableBalanceMinor == null) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.WALLET_NOT_READY, {
        errors: ['budget-context-carries-no-available-balance'],
        priority: BUDGET_EVALUATION_PRIORITY[4],
        systemFailure: true
      });
    }
    var availableAmt = normalizeAmountMinor(caps.availableBalanceMinor);
    if (!availableAmt.ok) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, {
        errors: ['budget-context-available-balance-is-not-canonical'], priority: BUDGET_EVALUATION_PRIORITY[4]
      });
    }
    if (availableAmt.amountMinor < amount) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE, {
        errors: ['insufficient-available-balance'],
        priority: BUDGET_EVALUATION_PRIORITY[4],
        walletState: String(ctx.walletState),
        availableBalanceMinor: serializeAmountMinor(availableAmt.amountMinor),
        amountMinor: serializeAmountMinor(amount),
        currency: String(ctx.currency)
      });
    }

    /* ── 6 单笔上限 */
    var perTx = caps.perTransactionMinor == null ? null : normalizeAmountMinor(caps.perTransactionMinor);
    if (perTx && perTx.ok && perTx.amountMinor < amount) {
      return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION, {
        errors: ['amount-exceeds-the-per-transaction-limit'],
        priority: BUDGET_EVALUATION_PRIORITY[5],
        limitKey: 'perTransactionMinor',
        limitMinor: serializeAmountMinor(perTx.amountMinor),
        amountMinor: serializeAmountMinor(amount)
      });
    }

    /* ── 7/8/9 窗口累计。顺序由 BUDGET_WINDOW_RULES 固定。
          `spent + amount > cap`（而不是 >=）：额度是"最多能花这么多"，
          恰好花完是允许的。 */
    for (var r = 0; r < BUDGET_WINDOW_RULES.length; r++) {
      var rule = BUDGET_WINDOW_RULES[r];
      var cap = caps[rule.limit];
      if (cap == null) continue;
      var capAmt = normalizeAmountMinor(cap);
      if (!capAmt.ok) continue;                       /* 已在 policy 校验阶段拒绝过 */
      var spentAmt = usage[rule.usage];
      if (spentAmt + amount > capAmt.amountMinor) {
        return budgetDecision(BUDGET_DECISION.DENY, DENY_REASON[rule.reason], {
          errors: ['the-' + rule.window.toLowerCase() + '-budget-would-be-exceeded'],
          priority: BUDGET_EVALUATION_PRIORITY[5 + r + 1],
          window: rule.window,
          windowStartsAt: budgetWindowStart(rule.window, ctx.timestamp),
          limitKey: rule.limit,
          limitMinor: serializeAmountMinor(capAmt.amountMinor),
          spentMinor: serializeAmountMinor(spentAmt),
          amountMinor: serializeAmountMinor(amount),
          remainingMinor: serializeAmountMinor(capAmt.amountMinor - spentAmt)
        });
      }
    }

    /* ── 10 审批线。到这里为止所有硬规则都通过了，因此"超过审批线"
          是 REQUIRE_APPROVAL 而**不是** DENY（§16）：它表达的是
          "这件事可以做，但需要用户点头"，而本层只负责分类，
          不创建 Approval、不执行 workflow。 */
    var threshold = caps.approvalThresholdMinor == null ? null : normalizeAmountMinor(caps.approvalThresholdMinor);
    if (threshold && threshold.ok && amount > threshold.amountMinor) {
      return budgetDecision(BUDGET_DECISION.REQUIRE_APPROVAL, DENY_REASON.AMOUNT_EXCEEDS_APPROVAL_THRESHOLD, {
        priority: BUDGET_EVALUATION_PRIORITY[9],
        approvalThresholdMinor: serializeAmountMinor(threshold.amountMinor),
        amountMinor: serializeAmountMinor(amount)
      });
    }

    reason = BUDGET_ALLOWED_REASON;
    return budgetDecision(BUDGET_DECISION.ALLOW, reason, {
      priority: BUDGET_EVALUATION_PRIORITY[10],
      amountMinor: serializeAmountMinor(amount),
      currency: String(ctx.currency),
      /* 把快照的三个窗口值一并回带：调用方与审计都该看得到"这个决定是
         在什么数字上做出的"，而不是只看到一个 ALLOW。 */
      spentTodayMinor: serializeAmountMinor(usage.spentTodayMinor),
      spentThisWeekMinor: serializeAmountMinor(usage.spentThisWeekMinor),
      spentThisMonthMinor: serializeAmountMinor(usage.spentThisMonthMinor),
      availableBalanceMinor: serializeAmountMinor(availableAmt.amountMinor),
      evaluatedAt: ctx.timestamp == null ? null : Number(ctx.timestamp)
    });
  }

  /* party ref 相等：必须是 (type, id) 的**双**相等。只比 id 会让
     {type:'user', id:'user'} 与一个名叫 "user" 的**角色**被判成同一个
     owner —— 那正是 §6.1 用 promotePartyRef 挡掉的混淆。 */
  function partyRefEquals(a, b) {
    var x = promotePartyRef(a);
    var y = promotePartyRef(b);
    if (!x || !y) return false;
    return x.type === y.type && x.id === y.id;
  }

  /* ── 载入期自检：上面每一张"数据表"都必须与冻结词表逐字一致 ─────────
     这一段的失败方式是**立刻抛错**，而不是返回一个错误对象 —— 它是
     模块自身的一致性，不是一个可以被调用方处理的情况。 */
  (function selfCheckBudgetTables() {
    var missing = TX_TYPES.filter(function (t) { return !Object.prototype.hasOwnProperty.call(BUDGET_SPEND_CLASS, t); });
    var extra = Object.keys(BUDGET_SPEND_CLASS).filter(function (t) { return TX_TYPES.indexOf(t) < 0; });
    if (missing.length || extra.length) {
      throw new Error('P22-4 budget spend-class table must cover TX_TYPES exactly; missing=[' + missing.join(',') + '] extra=[' + extra.join(',') + ']');
    }
    var unknownSettlement = Object.keys(QUOTE_SETTLEMENT_TYPE).filter(function (k) {
      return QUOTE_KINDS.indexOf(k) < 0 || TX_TYPES.indexOf(QUOTE_SETTLEMENT_TYPE[k]) < 0;
    });
    if (unknownSettlement.length) {
      throw new Error('P22-4 quote settlement types must be TYPES of QUOTE_KINDS and members of TX_TYPE: [' + unknownSettlement.join(',') + ']');
    }
    if (BUDGET_WINDOW_RULES.length !== BUDGET_WINDOWS.length) {
      throw new Error('P22-4 budget window rules must cover every budget window exactly once');
    }
    var limitNamesOk = POLICY_LIMIT_NAMES.every(function (n) { return BUDGET_LIMIT_KEYS.indexOf(n) >= 0; });
    if (!limitNamesOk) {
      throw new Error('P22-4 policy limit table must only name keys frozen in BUDGET_LIMIT_KEYS');
    }
    var decisionReasons = [BUDGET_ALLOWED_REASON].concat(DENY_REASONS);
    /* 评估器可能返回的每一个 reasonCode 都必须落在这个并集里。 */
    var used = [DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, DENY_REASON.POLICY_NOT_FOUND, DENY_REASON.POLICY_TERM_EXPIRED,
      DENY_REASON.WALLET_NOT_READY, DENY_REASON.INVALID_CURRENCY, DENY_REASON.INVALID_AMOUNT,
      DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE, DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION,
      DENY_REASON.DAILY_LIMIT, DENY_REASON.WEEKLY_LIMIT, DENY_REASON.MONTHLY_LIMIT,
      DENY_REASON.AMOUNT_EXCEEDS_APPROVAL_THRESHOLD, BUDGET_ALLOWED_REASON];
    var badReasons = used.filter(function (c) {
      return c !== BUDGET_ALLOWED_REASON && decisionReasons.indexOf(c) < 0;
    });
    if (badReasons.length) {
      throw new Error('P22-4 budget evaluator returns reason codes outside the closed set: [' + badReasons.join(',') + ']');
    }
  })();

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
    /* ── P22-4 追加的八个（加法）────────────────────────────────────────
       政策面四个：创建 / 修改 / 停用 / 到期限。
       报价面四个：创建 / 过期 / 被消费 / 被作废。

       为什么"修改政策"必须有自己的一条事件，而不复用 CREATED：政策是
       规则，而规则的**变化**是审计里最需要被回答的问题之一
       （"这笔为什么被拒？因为有人在上周二把日额度从 500 改成了 100"）。
       合并它们会让 policy 的历史变成一串无法分辨的 same-kind 事件。

       为什么 QUOTE_CONSUMED / QUOTE_CANCELLED 现在就登记（P22-4 只写
       QUOTE_CREATED / QUOTE_EXPIRED）：它们是 quote 状态机的另外两个
       终态，而"词表先于写入方冻结"是 P22-1 §18 的既有做法 —— 集合是
       封闭的，因此少登记一个的代价是未来某个阶段被迫改契约。 */
    BUDGET_POLICY_CREATED: 'BUDGET_POLICY_CREATED',
    BUDGET_POLICY_UPDATED: 'BUDGET_POLICY_UPDATED',
    BUDGET_POLICY_DISABLED: 'BUDGET_POLICY_DISABLED',
    BUDGET_POLICY_EXPIRED: 'BUDGET_POLICY_EXPIRED',
    QUOTE_CREATED: 'QUOTE_CREATED',
    QUOTE_EXPIRED: 'QUOTE_EXPIRED',
    QUOTE_CONSUMED: 'QUOTE_CONSUMED',
    QUOTE_CANCELLED: 'QUOTE_CANCELLED',
    PURCHASE_COMMITTED: 'PURCHASE_COMMITTED',
    PURCHASE_DENIED: 'PURCHASE_DENIED',
    /* ── P22-6 追加的四个（加法）──────────────────────────────────────────
       P22-1 §18 冻结的十四个事件里已经有 PURCHASE_COMMITTED 与
       PURCHASE_DENIED —— 那时候没有 purchase 表，只有**词表**。P22-6 是
       第一个真的会写 purchase 事件的阶段，而它需要的名字比这两个多：
       一次购买会**先被预留**（还没有成交），而"预留住了"与"成交了"是
       两件在审计里必须能分开的事（前者可能永远不成交）。

       为什么还需要 CREATED：一次 prepare 在**预留之前**就已经写下了
       Purchase 行（它在同一个事务里）。因此"购买被创建"是一个真实的
       状态跃迁，不是"预留"的同义词。

       为什么需要 RELEASED / FAILED：两者都是 RESERVED 之后的终局，而
       它们的区别是**为什么**结束（主动放弃 / 规则或时间不允许继续）。
       这与 P22-3 分出 RESERVATION_RELEASED 与 OPERATION_FAILED 的理由
       逐字同源。

       刻意**不**新增 Settlement 类事件：一次成功结算的 canonical 事实
       已经由 ledger 的 `<TYPE>_COMMITTED`、RESERVATION_COMMITTED、
       QUOTE_CONSUMED 与 INVENTORY_GRANTED 四条分别写下（§47：不为
       "日志详细"重复表达同一事实）。 */
    PURCHASE_CREATED: 'PURCHASE_CREATED',
    PURCHASE_RESERVED: 'PURCHASE_RESERVED',
    PURCHASE_COMPLETED: 'PURCHASE_COMPLETED',
    PURCHASE_RELEASED: 'PURCHASE_RELEASED',
    PURCHASE_FAILED: 'PURCHASE_FAILED',
    /* ── P22-7 追加的十个（加法）──────────────────────────────────────────
       §16 要求"仅凭 canonical Economy 事实"回答四个问题，而这十个事件
       恰好是那四个问题的证据：

         "为什么这笔购买没问用户？"
           → AUTONOMY_PURCHASE_AUTO_ALLOWED（带 autonomyDecision 与 policyId）
         "为什么这笔要求批准？"
           → APPROVAL_REQUESTED（带 autonomyOutcome 与它命中的那条规则）
             必要时再加 AUTONOMY_PURCHASE_REQUIRES_APPROVAL（授权闸门停下）
         "是谁批准的什么？"
           → APPROVAL_APPROVED / APPROVAL_REJECTED（带 approvalSnapshot）
         "这个批准最终被哪笔 Purchase 消费？"
           → APPROVAL_CONSUMED（带 consumedByPurchaseId）+
             PURCHASE_AUTHORIZED（带 approvalId 与 purchaseId 的链接）

       为什么政策两个事件不叫 BUDGET_POLICY_*：自主政策复用同一种**记录
       形状**，但它是一条独立的规则（§3），而"有人把自主额度从 500 改成
       100"必须在审计里能与"有人改了预算额度"分开 —— 这正是 P22-4 分出
       CREATED / UPDATED 的同一条理由用在另一层上。 */
    AUTONOMY_POLICY_CREATED: 'AUTONOMY_POLICY_CREATED',
    AUTONOMY_POLICY_UPDATED: 'AUTONOMY_POLICY_UPDATED',
    APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
    APPROVAL_APPROVED: 'APPROVAL_APPROVED',
    APPROVAL_REJECTED: 'APPROVAL_REJECTED',
    APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
    APPROVAL_CONSUMED: 'APPROVAL_CONSUMED',
    PURCHASE_AUTHORIZED: 'PURCHASE_AUTHORIZED',
    AUTONOMY_PURCHASE_AUTO_ALLOWED: 'AUTONOMY_PURCHASE_AUTO_ALLOWED',
    AUTONOMY_PURCHASE_REQUIRES_APPROVAL: 'AUTONOMY_PURCHASE_REQUIRES_APPROVAL',
    ITEM_GIFTED: 'ITEM_GIFTED',
    ITEM_CONSUMED: 'ITEM_CONSUMED',
    COMPUTE_CREDIT_GRANTED: 'COMPUTE_CREDIT_GRANTED',
    COMPUTE_CREDIT_CONSUMED: 'COMPUTE_CREDIT_CONSUMED',
    EXCHANGE_COMMITTED: 'EXCHANGE_COMMITTED',
    MINT_COMMITTED: 'MINT_COMMITTED',
    BURN_COMMITTED: 'BURN_COMMITTED',
    /* ── P22-5 追加的八个（加法）─────────────────────────────────────────
       目录面四个：货架创建 / 货架修改 / 商品创建 / 商品修改。
       商品生命周期两个终局：DISABLED / RETIRED（它们各自一条事件，理由与
       P22-4 的"改价必须有自己的事件"逐字相同 —— "这件商品为什么买不了"
       的答案必须能读出**是被停用还是已经退役**，而合并成一条
       PRODUCT_UPDATED 会让这个区别消失在 payload 里）。
       库存面两个：GRANTED / CONSUMED。
       全部写 `ledgerMutation: false` —— 目录与库存 primitive 都不动钱
       （P22-5 §14）。真正的 Purchase 会在**同一个事务**里同时写
       ledger 与 inventory，但那不是本阶段。

       注意 PRODUCT_DISABLED / PRODUCT_RETIRED 与既有的**拒绝码**
       PRODUCT_DISABLED 同名但不是同一个东西：一个是事件类型（发生了什么），
       一个是拒绝原因（为什么没成）。同名是有意的：它们描述的是同一件事
       的两个视角。 */
    STORE_CREATED: 'STORE_CREATED',
    STORE_UPDATED: 'STORE_UPDATED',
    PRODUCT_CREATED: 'PRODUCT_CREATED',
    PRODUCT_UPDATED: 'PRODUCT_UPDATED',
    PRODUCT_DISABLED: 'PRODUCT_DISABLED',
    PRODUCT_RETIRED: 'PRODUCT_RETIRED',
    INVENTORY_GRANTED: 'INVENTORY_GRANTED',
    INVENTORY_CONSUMED: 'INVENTORY_CONSUMED'
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
     §22 · Store / Product / Inventory Contract（P22-5）
     ══════════════════════════════════════════════════════════════════ */

  /* 这一节回答三个新问题：

       「有哪些商品？」（Store + Product）
       「一份商品到底是什么？」（kind / fulfillment / unitPriceMinor）
       「谁拥有什么？」（Inventory）

     它**不**回答「Agent 应该买什么」（那是 Decision），也不执行
     「买」（那是 future Purchase）。§15 早就把这条线画好了：
     "Product 里不允许出现任意 JS / function / code；商品 effect 是
     **数据**，由 Economy 解释，不由商品自己执行。" 本节沿用那条纪律。

     ── 为什么必须把 Store / Product / Inventory 分成三个概念 ────────────
     它们各自的**变化频率**与**所有者**完全不同：
       · Store    —— 组织方式（哪个货架）。改它不该动价格。
       · Product  —— 价格与交付形态。改它**不得**重写历史报价。
       · Inventory—— 已发生的拥有事实。改它不该动价格，也不该动余额。
     合并其中任意两个都会立刻产生一个"改一个字段同时改变两件事"的操作，
     而那种操作在审计里无法解释。P22-5 §1 把这条写成了六条不等式。

     ── 本节的加法（逐项）────────────────────────────────────────────────
       · ID_PREFIX.STORE          —— 新的一种 id 形状（econ_store_）
       · OPERATION_SCOPE ×4       —— STORE / PRODUCT / INVENTORY_GRANT /
                                     INVENTORY_CONSUME
       · EVENT_TYPE ×8            —— 见 §18
       · DENY_REASON ×3           —— PRODUCT_NOT_FOUND / STORE_NOT_FOUND /
                                     INSUFFICIENT_INVENTORY
       · 本节自己的五个封闭词表  —— STORE_STATUS / PRODUCT_STATUS /
                                     PRODUCT_KIND / FULFILLMENT / ASSET_KIND
     没有任何既有字面值被修改或删除。 */

  /* ── Store 的状态 ────────────────────────────────────────────────────
     刻意**不复用** POLICY_STATUS：两者今天恰好都有 ACTIVE / DISABLED，
     但它们回答的问题不同（"这条规则生效吗" vs "这个货架开着吗"），而
     共用一套词表意味着将来给其中一个加成员会**静默地**改写另一个的语义。
     两个字母相同的封闭集合不是重复，是两个不同的域在说同一句短话。 */
  var STORE_STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    DISABLED: 'DISABLED'
  });

  var STORE_STATUSES = Object.freeze(Object.keys(STORE_STATUS));
  var STORE_STATUS_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < STORE_STATUSES.length; i++) map[STORE_STATUSES[i]] = true;
    return map;
  })();

  function isStoreStatus(value) {
    return value != null && STORE_STATUS_INDEX[String(value)] === true;
  }

  /* ── Product 的状态（P22-5 §9）───────────────────────────────────────
     RETIRED 与 DISABLED 刻意分开：
       · DISABLED —— 暂时不卖了。可以再打开（这是 ACTIVE 的往返边）。
       · RETIRED  —— 这件商品的**生命结束了**，永不再卖。终态。
     两者的共同后果只有一个：**不能创建新报价**。它们**不**修改任何一份
     已存在的报价 —— 报价的有效性只由它自己的 state 与 expiresAt 决定
     （§14 冻结的那两列），否则一次 Product mutation 就会偷偷重写历史
     报价，而"当时是多少钱"这个问题将不再有答案。 */
  var PRODUCT_STATUS = Object.freeze({
    ACTIVE: 'ACTIVE',
    DISABLED: 'DISABLED',
    RETIRED: 'RETIRED'
  });

  var PRODUCT_STATUSES = Object.freeze(Object.keys(PRODUCT_STATUS));
  var PRODUCT_STATUS_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < PRODUCT_STATUSES.length; i++) map[PRODUCT_STATUSES[i]] = true;
    return map;
  })();

  function isProductStatus(value) {
    return value != null && PRODUCT_STATUS_INDEX[String(value)] === true;
  }

  var PRODUCT_STATUS_TRANSITIONS = Object.freeze({
    ACTIVE: Object.freeze([PRODUCT_STATUS.DISABLED, PRODUCT_STATUS.RETIRED]),
    DISABLED: Object.freeze([PRODUCT_STATUS.ACTIVE, PRODUCT_STATUS.RETIRED]),
    /* RETIRED 是终态。一个"退役后又上架"的商品不是同一件商品，
       而允许它回来会让"这件商品已经结束"这句话变得不可信。 */
    RETIRED: Object.freeze([])
  });

  var PRODUCT_TERMINAL_STATUSES = Object.freeze(
    PRODUCT_STATUSES.filter(function (s) { return PRODUCT_STATUS_TRANSITIONS[s].length === 0; })
  );

  function canTransitionProductStatus(from, to) {
    var f = String(from == null ? '' : from);
    var t = String(to == null ? '' : to);
    if (!PRODUCT_STATUS_INDEX[f] || !PRODUCT_STATUS_INDEX[t]) {
      return { ok: false, allowed: false, errors: ['product-status-not-in-closed-set'] };
    }
    var allowed = PRODUCT_STATUS_TRANSITIONS[f].indexOf(t) >= 0;
    return { ok: true, allowed: allowed, errors: allowed ? [] : ['product-status-transition-not-allowed'], from: f, to: t };
  }

  function assertProductStatusTransition(from, to) {
    var r = canTransitionProductStatus(from, to);
    if (!r.ok) return { ok: false, errors: r.errors };
    if (!r.allowed) {
      return {
        ok: false,
        errors: ['product-status-transition-not-allowed'],
        detail: (PRODUCT_TERMINAL_STATUSES.indexOf(r.from) >= 0)
          ? 'a-retired-product-is-terminal-and-must-not-be-relisted'
          : 'product-status-transition-not-in-allowed-set'
      };
    }
    return { ok: true, errors: [] };
  }

  /* ── Product kind（P22-5 §4/§28）─────────────────────────────────────
     五个成员，而且**每一个都映射到 §15 已经冻结的语义**：kind 只决定
     "交付什么形态"，不新造任何 ledger / transaction / currency 词汇。
     这正是 §4 要求的"先审计已冻结的词表，再决定要不要新增枚举"的结果：
     五个名字里没有一个是新的经济概念，它们只是把 §15 的 EFFECT_TYPE 与
     §16 的 compute tier 组织成"货架上的分类"。 */
  var PRODUCT_KIND = Object.freeze({
    DIGITAL_ITEM: 'DIGITAL_ITEM',
    CONSUMABLE: 'CONSUMABLE',
    API_QUOTA: 'API_QUOTA',
    COMPUTE_CREDIT: 'COMPUTE_CREDIT',
    SERVICE: 'SERVICE'
  });

  var PRODUCT_KINDS = Object.freeze(Object.keys(PRODUCT_KIND));
  var PRODUCT_KIND_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < PRODUCT_KINDS.length; i++) map[PRODUCT_KINDS[i]] = true;
    return map;
  })();

  function isProductKind(value) {
    return value != null && PRODUCT_KIND_INDEX[String(value)] === true;
  }

  /* ── 交付形态（settlement strategy）──────────────────────────────────
     P22-5 §27 的要求：**不要**把模型设计成"每个商品购买后都必须增加
     inventory"。SERVICE 商品就是那个反例 —— 它购买后发生的是一次
     服务执行，没有永久库存。因此把"买完发生什么"提升为一个显式的、
     封闭的、创建时冻结的字段，而不是让下游按 kind 猜。 */
  var FULFILLMENT = Object.freeze({
    INVENTORY_GRANT: 'INVENTORY_GRANT',
    COMPUTE_GRANT: 'COMPUTE_GRANT',
    SERVICE_EXECUTION: 'SERVICE_EXECUTION'
  });

  var FULFILLMENTS = Object.freeze(Object.keys(FULFILLMENT));
  var FULFILLMENT_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < FULFILLMENTS.length; i++) map[FULFILLMENTS[i]] = true;
    return map;
  })();

  function isFulfillment(value) {
    return value != null && FULFILLMENT_INDEX[String(value)] === true;
  }

  /* kind → 交付形态。这是一张**数据**表（与 §14 的 QUOTE_SETTLEMENT_TYPE
     同款），不是散落的条件分支：把它写成数据，下面的载入期自检才能证明
     每个 kind 都有一个答案，而不是"碰巧代码里覆盖到了"。 */
  var FULFILLMENT_OF_PRODUCT_KIND = Object.freeze({
    DIGITAL_ITEM: FULFILLMENT.INVENTORY_GRANT,
    CONSUMABLE: FULFILLMENT.INVENTORY_GRANT,
    API_QUOTA: FULFILLMENT.COMPUTE_GRANT,
    COMPUTE_CREDIT: FULFILLMENT.COMPUTE_GRANT,
    SERVICE: FULFILLMENT.SERVICE_EXECUTION
  });

  function fulfillmentOfProductKind(kind) {
    if (!isProductKind(kind)) return null;
    return FULFILLMENT_OF_PRODUCT_KIND[String(kind)];
  }

  /* ── Inventory 的资产形态 ────────────────────────────────────────────
     只有两个成员，而且**刻意没有** UNIQUE_ITEM：
     P22-5 §10 说"如果资产必须区分可堆叠/唯一物品：设计明确；不要提前做
     复杂 RPG inventory"。答案是：本阶段的 canonical key 是
     (ownerId, productId) 且数量是一个非负整数，因此**唯一物品不可表示**。
     这不是"忘了"，而是一条被写下来的边界 —— 它由一个封闭集合 + 一条
     显式的否认（UNIQUE_ITEMS_NOT_MODELLED）共同表达，并有测试钉住。
     SERVICE 的 assetKind 是 **null**：交付形态是执行，不是持有。 */
  var ASSET_KIND = Object.freeze({
    ITEM: 'ITEM',
    COMPUTE: 'COMPUTE'
  });

  var ASSET_KINDS = Object.freeze(Object.keys(ASSET_KIND));
  var ASSET_KIND_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < ASSET_KINDS.length; i++) map[ASSET_KINDS[i]] = true;
    return map;
  })();

  function isAssetKind(value) {
    return value != null && ASSET_KIND_INDEX[String(value)] === true;
  }

  var ASSET_KIND_OF_PRODUCT_KIND = Object.freeze({
    DIGITAL_ITEM: ASSET_KIND.ITEM,
    CONSUMABLE: ASSET_KIND.ITEM,
    API_QUOTA: ASSET_KIND.COMPUTE,
    COMPUTE_CREDIT: ASSET_KIND.COMPUTE,
    SERVICE: null
  });

  function assetKindOfProductKind(kind) {
    if (!isProductKind(kind)) return null;
    return ASSET_KIND_OF_PRODUCT_KIND[String(kind)];
  }

  /* 库存的 canonical 键。**数据**，不是注释 —— 测试与 store 都读它，
     于是"按 (owner, product) 唯一"这件事只有一处定义。 */
  var INVENTORY_CANONICAL_KEY = Object.freeze(['ownerId', 'productId']);

  /* 库存数量永远不可表示唯一物品。这是一条**可断言的否认**。 */
  var INVENTORY_UNIQUE_ITEMS_MODELLED = false;

  /* ── 单位名（unitName）────────────────────────────────────────────────
     金额必须有单位（§3：禁止 price / budget / money / cost 这类没有单位
     的字段）。unitName 是**计量单位**的名字，不是货币。它的缺省值由 kind
     决定，而对 compute 两类它必须是 §16 冻结的 computeUnit —— 于是
     "这家店卖的是 provider token"这句话在字形上就不可能成立
     （isForbiddenComputeAlias 逐字否认 tokens / usd / providerBalance）。 */
  var PRODUCT_UNIT_NAME = Object.freeze({
    DIGITAL_ITEM: 'item',
    CONSUMABLE: 'item',
    API_QUOTA: COMPUTE_UNIT_NAME,
    COMPUTE_CREDIT: COMPUTE_UNIT_NAME,
    SERVICE: 'service'
  });

  function unitNameOfProductKind(kind) {
    if (!isProductKind(kind)) return null;
    return PRODUCT_UNIT_NAME[String(kind)];
  }

  /* ── Product 的字段白名单 ────────────────────────────────────────────
     §3 明确禁止"没有单位的金额字段"。这里把那条纪律变成一张**精确**名单：
     store 收到的键必须全部在名单里，多一个就拒绝。它同时挡住两类东西：
       · 真实购物域的键（maxBudget / paymentIntent / checkoutUrl …）；
       · 任何"看起来像价格但没有单位"的键（price / cost / money）。
     与 P22-4 的 BUDGET_INPUT_KEYS 同款：让越界的输入**没有地方可以放**。 */
  var PRODUCT_INPUT_KEYS = Object.freeze([
    'productId', 'storeId', 'kind', 'fulfillment', 'name', 'description',
    'currency', 'unitPriceMinor', 'unitName', 'grantQuantity', 'status',
    'ifRevision', 'idempotencyKey'
  ]);

  var STORE_INPUT_KEYS = Object.freeze([
    'storeId', 'name', 'description', 'status', 'sortOrder', 'ifRevision', 'idempotencyKey'
  ]);

  /* 逐个点名否认的商品字段名。它们全部是"影响 Economy 之外的世界"或
     "让价格依赖于关系/推荐"的企图：
       · provider*  —— P22 的硬边界（§5/§43）；
       · real* / cny / usd / fiat —— 真实货币（§42）；
       · discount / promo / coupon / featured / recommended —— 个性化定价与
         推荐（§40/§41）。未来若真需要折扣，必须设计独立的
         Discount/Promotion contract，而不是偷偷塞进 Product getter。 */
  var FORBIDDEN_PRODUCT_FIELDS = Object.freeze([
    'price', 'cost', 'money', 'budget', 'amount', 'value', 'stock', 'owned', 'onHand',
    'inventoryCount', 'providerApiKey', 'providerAccount', 'providerBalance', 'providerTopup',
    'providerQuota', 'checkoutUrl', 'paymentIntent', 'paymentLink', 'realMoney', 'realPrice',
    'cny', 'usd', 'fiatAmount', 'discount', 'discountRate', 'promo', 'promotion', 'coupon',
    'featured', 'recommended', 'recommendation', 'personalized', 'trust', 'affection',
    'affinity', 'familiarity', 'relationshipId', 'memoryRef', 'prompt', 'llmOutput'
  ]);

  var FORBIDDEN_PRODUCT_FIELD_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < FORBIDDEN_PRODUCT_FIELDS.length; i++) map[FORBIDDEN_PRODUCT_FIELDS[i]] = true;
    return map;
  })();

  function isForbiddenProductFieldName(value) {
    if (value == null) return false;
    var raw = String(value).trim();
    if (!raw) return false;
    if (FORBIDDEN_PRODUCT_FIELD_INDEX[raw]) return true;
    return !!FORBIDDEN_PRODUCT_FIELD_INDEX[raw.replace(/[^A-Za-z0-9]/g, '')];
  }

  /* 定价与关系无关，是一条**可断言的自述**（§41）。同一个 Product 的
     canonical unitPriceMinor 不得依赖任何关系/记忆/推荐输入；下面这张
     清单是"哪些输入会让定价变成个性化"的封闭答案，而 validateProduct
     因为白名单而**根本没有地方**接收它们。 */
  var PRICING_IS_RELATIONSHIP_FREE = true;

  /* name / description 的长度上界。存在理由与 §19 的 correlationRef 同款：
     一个无上界的文本字段是一条把任意正文塞进经济记录的通道，而
     "商品名里带着一整段 prompt"在审计里与"商品名"无法区分。 */
  var PRODUCT_NAME_MAX = 120;
  var PRODUCT_DESCRIPTION_MAX = 500;
  var STORE_NAME_MAX = 120;
  var STORE_DESCRIPTION_MAX = 500;
  var UNIT_NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

  /* unitName 的形状判定 —— P22-6 把它从 validateProduct 里提取成**一份**
     实现。提取的理由不是"复用好看"，而是"两个写入方必须用同一条规则"：
     P22-5 的商品行与 P22-6 的结算交付量名，如果各自实现一遍正则，它们会
     漂移，而漂移的症状是"结算写下的单位名不合法"只在很久以后被一次完整性
     检查发现。函数声明提升使它可以在上面的 unitNameOfProductKind 旁边被
     引用，而正则本身仍在原处。 */
  function isUnitName(value) {
    return value != null && UNIT_NAME_RE.test(String(value));
  }
  /* sortOrder 的界：它只影响展示顺序，取一个足够大又不会溢出的范围。 */  var SORT_ORDER_MAX = 1000000;

  function validateStore(input) {
    var o = input || {};
    var errors = [];
    if (o.storeId != null && !isEconomyId('STORE', o.storeId)) errors.push('store-id-not-canonical');
    var name = o.name == null ? '' : String(o.name).trim();
    if (!name) errors.push('store-name-required');
    else if (name.length > STORE_NAME_MAX) errors.push('store-name-too-long');
    if (o.description != null && String(o.description).length > STORE_DESCRIPTION_MAX) {
      errors.push('store-description-too-long');
    }
    if (o.status != null && !isStoreStatus(o.status)) errors.push('store-status-not-in-closed-set');
    if (o.sortOrder != null) {
      if (!Number.isSafeInteger(Number(o.sortOrder)) || Math.abs(Number(o.sortOrder)) > SORT_ORDER_MAX) {
        errors.push('store-sort-order-not-a-bounded-safe-integer');
      }
    }
    var keys = Object.keys(o);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (STORE_INPUT_KEYS.indexOf(k) >= 0) continue;
      if (isForbiddenProductFieldName(k)) { errors.push('store-input-key-is-forbidden:' + k); continue; }
      errors.push('store-input-key-not-whitelisted:' + k);
    }
    if (errors.length) return { ok: false, store: null, errors: errors };
    return { ok: true, errors: [], store: o };
  }

  /* Product 的**结构化**校验。要点逐条：
       · unitPriceMinor 必填、可以是 **0**（免费商品是合法产品，见 §34：
         "0 必须是显式合法值"）—— 因此这里用的是 `o.unitPriceMinor == null`
         而不是 `!o.unitPriceMinor`；用后者会让 "免费" 与 "忘了写价格"
         变成同一种失败；
       · grantQuantity 的取值由交付形态**约束**，不是自由数字：
         INVENTORY_GRANT / COMPUTE_GRANT 必须 ≥ 1（"花 400 得到 1000 个
         computeUnit"里的 1000 就是它），SERVICE_EXECUTION 必须 = 0
         （服务不产生库存，§54）；
       · unitName 缺省由 kind 决定，且对 compute 两类必须恰是 computeUnit。 */
  function validateProduct(input) {
    var o = input || {};
    var errors = [];
    if (o.productId != null && !isEconomyId('PRODUCT', o.productId)) errors.push('product-id-not-canonical');
    if (!isEconomyId('STORE', o.storeId)) errors.push('store-id-not-canonical');
    if (!isProductKind(o.kind)) errors.push('product-kind-not-in-closed-set');

    var kind = isProductKind(o.kind) ? String(o.kind) : null;
    var expectedFulfillment = kind == null ? null : FULFILLMENT_OF_PRODUCT_KIND[kind];
    if (expectedFulfillment == null) errors.push('product-kind-has-no-fulfillment');
    if (o.fulfillment != null && String(o.fulfillment) !== String(expectedFulfillment)) {
      /* 交付形态是**派生**的：它不是一个可以被调用方声明的偏好，否则
         "这件商品买完给库存还是给算力"会有两个答案。 */
      errors.push('product-fulfillment-does-not-match-the-product-kind');
    }

    var name = o.name == null ? '' : String(o.name).trim();
    if (!name) errors.push('product-name-required');
    else if (name.length > PRODUCT_NAME_MAX) errors.push('product-name-too-long');
    if (o.description != null && String(o.description).length > PRODUCT_DESCRIPTION_MAX) {
      errors.push('product-description-too-long');
    }

    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);

    if (o.unitPriceMinor == null) {
      errors.push('product-unit-price-minor-required');
    } else {
      /* normalizeAmountMinor 已经同时保证了三件事：非负、整数、不溢出
         （它自己拒绝 'amount-minor-negative' / 'amount-minor-overflow'）。
         这里**刻意不再写一遍** —— 两条独立的规则会让"负价格被谁拒绝的"
         有两个可能答案，而重复的那一条永远不会被执行到。 */
      var amt = normalizeAmountMinor(o.unitPriceMinor);
      if (!amt.ok) errors.push.apply(errors, amt.errors);
    }

    var qty = o.grantQuantity == null ? null : Number(o.grantQuantity);
    if (qty != null && !Number.isSafeInteger(qty)) {
      errors.push('product-grant-quantity-not-a-safe-integer');
    } else if (expectedFulfillment === FULFILLMENT.SERVICE_EXECUTION) {
      /* 服务商品不交付库存。**不是**"允许它是 0"，而是"它必须是 0"：
         一个 SERVICE 带着 grantQuantity = 5 意味着某个下游会去加库存，
         而那正是 §54 要让 schema 拒绝的建模错误。 */
      if (qty == null) errors.push('product-grant-quantity-required-even-when-it-is-zero');
      else if (qty !== 0) errors.push('a-service-product-must-not-grant-inventory-quantity');
    } else if (expectedFulfillment != null) {
      if (qty == null) errors.push('product-grant-quantity-required');
      else if (qty < 1) errors.push('product-grant-quantity-must-be-positive');
    }

    var unitName = o.unitName == null ? (kind == null ? null : PRODUCT_UNIT_NAME[kind]) : String(o.unitName);
    if (unitName == null || !UNIT_NAME_RE.test(String(unitName))) {
      errors.push('product-unit-name-not-canonical');
    } else if (isForbiddenComputeAlias(unitName)) {
      /* 'tokens' / 'usd' / 'providerBalance' 这类词在这一层就被拒绝。 */
      errors.push('product-unit-name-is-a-forbidden-compute-alias');
    } else if (expectedFulfillment === FULFILLMENT.COMPUTE_GRANT && String(unitName) !== COMPUTE_UNIT_NAME) {
      errors.push('a-compute-product-must-use-the-frozen-compute-unit-name');
    }

    if (o.status != null && !isProductStatus(o.status)) errors.push('product-status-not-in-closed-set');

    var keys = Object.keys(o);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (PRODUCT_INPUT_KEYS.indexOf(k) >= 0) continue;
      if (isForbiddenProductFieldName(k)) { errors.push('product-input-key-is-forbidden:' + k); continue; }
      errors.push('product-input-key-not-whitelisted:' + k);
    }
    if (errors.length) return { ok: false, product: null, errors: errors };
    return { ok: true, errors: [], product: o, fulfillment: expectedFulfillment, assetKind: ASSET_KIND_OF_PRODUCT_KIND[kind] };
  }

  /* ── Product → Quote 的派生（P22-5 §6）───────────────────────────────
     "不要允许调用者同时传 productId = A 与 amountMinor = arbitrary B，
     然后相信调用者。Product 是报价生成时的价格来源。"
     因此这三条纯函数就是报价生成的**全部**价格逻辑，而且它们只读 Product：
     没有时钟、没有 store、没有随机、没有任何关系/记忆输入。 */
  function productQuoteKindFor(fulfillment, hasRecipient) {
    if (!isFulfillment(fulfillment)) return { ok: false, kind: null, errors: ['fulfillment-not-in-closed-set'] };
    var f = String(fulfillment);
    /* compute 额度报价的结算形态在 §14 就冻结成 COMPUTE_GRANT（= 额度被
       授予）。它不是一个"买给自己还是买给别人"的问题，因此 recipient
       在这里没有位置 —— 调用方给了 recipient 会被 §14 的规则拒绝
       （recipient 要求 GIFT，而这里不是 GIFT）。 */
    if (f === FULFILLMENT.COMPUTE_GRANT) {
      return { ok: true, kind: QUOTE_KIND.COMPUTE_GRANT, errors: [] };
    }
    return { ok: true, kind: hasRecipient ? QUOTE_KIND.GIFT : QUOTE_KIND.PURCHASE, errors: [] };
  }

  /* 报价数量 = 这次买几份 × 一份交付多少。
     ── 为什么 SERVICE 要取 max(grantQuantity, 1)
     §14 要求 quote.quantity ≥ 1（"一份不描述任何数量的报价不是报价"），
     而服务商品的 grantQuantity 由上面的校验**必须**是 0。于是服务商品的
     quantity 只能表达"这份服务执行几次" —— 那正是它唯一有意义的数量。
     对交付型商品，quantity 是**送达量**（units × grantQuantity），
     于是 API_QUOTA ×1000 的报价上写着 1000 computeUnit。 */
  function productQuoteQuantity(product, units) {
    var p = product || {};
    var form = fulfillmentOfProductKind(p.kind);
    if (form == null) return { ok: false, quantity: null, errors: ['product-kind-not-in-closed-set'] };
    var u = Number(units == null ? 1 : units);
    if (!Number.isSafeInteger(u) || u < 1) return { ok: false, quantity: null, errors: ['units-must-be-a-positive-safe-integer'] };
    var grant = Number(p.grantQuantity == null ? 0 : p.grantQuantity);
    if (!Number.isSafeInteger(grant) || grant < 0) {
      return { ok: false, quantity: null, errors: ['product-grant-quantity-not-a-non-negative-safe-integer'] };
    }
    var perUnit = grant >= 1 ? grant : 1;
    var quantity = u * perUnit;
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return { ok: false, quantity: null, errors: ['product-quote-quantity-exceeds-the-safe-integer-range'] };
    }
    return { ok: true, quantity: quantity, errors: [], deliveredPerUnit: perUnit };
  }

  /* 报价金额 = 单价 × 份数。canonical 表示是 BigInt（§3），上界是
     MAX_AMOUNT_MINOR；溢出**拒绝**，不静默变形。 */
  function productQuoteAmountMinor(product, units) {
    var p = product || {};
    var amt = normalizeAmountMinor(p.unitPriceMinor);
    if (!amt.ok) return { ok: false, amountMinor: null, errors: amt.errors };
    var u = Number(units == null ? 1 : units);
    if (!Number.isSafeInteger(u) || u < 1) {
      return { ok: false, amountMinor: null, errors: ['units-must-be-a-positive-safe-integer'] };
    }
    var total = amt.amountMinor * BigInt(u);
    if (total > BigInt(MAX_AMOUNT_MINOR)) {
      return { ok: false, amountMinor: null, errors: ['product-quote-amount-exceeds-the-canonical-maximum'] };
    }
    return { ok: true, amountMinor: total, errors: [] };
  }

  /* ── Quote 与 Product 的关系（P22-5 §22）─────────────────────────────
     二选一，这里明确选第二个：**Product 行是 provenance，不是报价当前
     有效性的依赖**。

     为什么：报价的全部经济内容（币种 / 金额 / 数量 / 种类 / 结算形态 /
     买家 / 受赠人 / 到期）都已经在**报价自己的列**里，因此即使 Product
     行消失了，历史报价仍然是一句完整的话（"谁、在什么时候、以什么价格、
     买什么、到期时间"）。反过来选"报价依赖 Product 存在"会让一次货架
     清理把历史价格命题变成不可解释的东西 —— 而它是不可重建的。

     代价必须同时说清楚：Product 缺失/损坏**仍然是一次完整性失败**，
     只是它失败在"目录这一面"，不在"报价这一面"。因此：
       · getQuote 照常返回完整报价，并附 productProvenance.present = false；
       · economyIntegrityCheck 把它报成一条 problem。
     两句话同时成立，而不是含糊地二选一。 */
  var QUOTE_PRODUCT_RELATION = Object.freeze({
    PROVENANCE_ONLY: 'PROVENANCE_ONLY',
    DEPENDENCY: 'DEPENDENCY'
  });

  var PRODUCT_IS_PROVENANCE_FOR_QUOTES = true;

  /* ── 载入期自检（与 §14 同款）────────────────────────────────────────
     一个封闭映射表如果在实现里漏了一项，症状是"某个 kind 的商品永远
     无法报价"，而那种失败会在很久以后才被发现。因此这里在**载入期**
     就把三条性质查一遍：
       ① 每个 kind 都有交付形态；
       ② 每个 kind 都有单位名；
       ③ 交付形态必须是封闭集合的成员（拼错即抛）。
     自检失败 ⇒ 契约载入即抛错，而不是带着一个洞继续跑。 */
  (function selfCheck() {
    for (var i = 0; i < PRODUCT_KINDS.length; i++) {
      var kind = PRODUCT_KINDS[i];
      if (!isFulfillment(FULFILLMENT_OF_PRODUCT_KIND[kind])) {
        throw new Error('economy-contract: product kind without a fulfillment: ' + kind);
      }
      if (PRODUCT_UNIT_NAME[kind] == null) {
        throw new Error('economy-contract: product kind without a unit name: ' + kind);
      }
      if (!Object.prototype.hasOwnProperty.call(ASSET_KIND_OF_PRODUCT_KIND, kind)) {
        throw new Error('economy-contract: product kind without an asset-kind mapping: ' + kind);
      }
    }
    /* 交付形态的**每一类**都必须至少有一个 kind 映射到它 —— 否则
       "SERVICE_EXECUTION 这一支从来没被走过"这件事不会被任何人发现。 */
    for (var f = 0; f < FULFILLMENTS.length; f++) {
      var hit = PRODUCT_KINDS.filter(function (k) { return FULFILLMENT_OF_PRODUCT_KIND[k] === FULFILLMENTS[f]; });
      if (!hit.length) throw new Error('economy-contract: fulfillment without any product kind: ' + FULFILLMENTS[f]);
    }
  })();

  /* ══════════════════════════════════════════════════════════════════
     导出
     ══════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════
     §22 · P22-6 · Purchase Orchestrator + Atomic Settlement
     ══════════════════════════════════════════════════════════════════

     Purchase 是**把既有事实组织成一个高层生命周期**的那一层。它不是
     新的经济事实，因此本节的每一条都在回答"它引用谁"，而不是"它自己
     是什么"：

       Product              商品定义（可变的只有 status 与 unit_price_minor）
       Quote                某一时刻的价格命题（写下即不可变）
       Budget Evaluation    当前规则允不允许（每一次执行时重新算）
       Reservation          对 Wallet 可用资源的临时锁定
       Ledger Transaction   已经发生的 accounting fact
       Inventory/Entitlement settlement 产生的资产事实
       Purchase             以上六者的**组织方式**

     严格禁止的等同（§1）：Purchase ≠ Ledger Transaction / Reservation /
     Quote。它们各有自己的 id 前缀、自己的表、自己的状态机。 */

  /* ── Purchase 状态机 ──────────────────────────────────────────────────
     最小四态。它要回答的问题只有四个：
       尚未 settlement     → RESERVED
       settlement 已完成    → COMPLETED
       流程终止但未消费资金  → RELEASED（主动放弃）/ FAILED（规则或时间
                              不允许继续）
     刻意**不**在这里区分"报价过期了"与"预算不给过了"：两者的资源后果
     完全相同，而**为什么**结束由 change log 的 reasonCode 如实记下
     （与 P22-3 分出 releaseReason 的做法同款：状态词表保持最小，
     原因留在 payload 里）。

     终态不可逆是**被执行**的规则，不是注释：三个终态的出边都是空数组，
     而 assertPurchaseTransition 会被运行路径真的调用一次。 */
  var PURCHASE_STATE = Object.freeze({
    RESERVED: 'RESERVED',
    COMPLETED: 'COMPLETED',
    RELEASED: 'RELEASED',
    FAILED: 'FAILED'
  });

  var PURCHASE_STATES = Object.freeze(Object.keys(PURCHASE_STATE));

  var PURCHASE_TRANSITIONS = Object.freeze({
    RESERVED: Object.freeze([PURCHASE_STATE.COMPLETED, PURCHASE_STATE.RELEASED, PURCHASE_STATE.FAILED]),
    COMPLETED: Object.freeze([]),
    RELEASED: Object.freeze([]),
    FAILED: Object.freeze([])
  });

  var PURCHASE_TERMINAL_STATES = Object.freeze(
    PURCHASE_STATES.filter(function (s) { return PURCHASE_TRANSITIONS[s].length === 0; })
  );

  /* 一条 Purchase 的**唯一**入口状态：prepare 要么把它留在 RESERVED，
     要么根本不写这一行。因为没有 CREATED 这个持久状态，
     "尚未 settlement"与"还没有 Purchase"不会互相伪装。 */
  var PURCHASE_INITIAL_STATE = PURCHASE_STATE.RESERVED;

  var PURCHASE_STATE_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < PURCHASE_STATES.length; i++) map[PURCHASE_STATES[i]] = true;
    return map;
  })();

  function isPurchaseState(value) {
    return value != null && PURCHASE_STATE_INDEX[String(value)] === true;
  }

  function canTransitionPurchase(from, to) {
    var f = String(from == null ? '' : from);
    var t = String(to == null ? '' : to);
    if (!PURCHASE_STATE_INDEX[f] || !PURCHASE_STATE_INDEX[t]) {
      return { ok: false, allowed: false, errors: ['purchase-state-not-in-closed-set'] };
    }
    var allowed = PURCHASE_TRANSITIONS[f].indexOf(t) >= 0;
    return { ok: true, allowed: allowed, errors: allowed ? [] : ['transition-not-allowed'], from: f, to: t };
  }

  function assertPurchaseTransition(from, to) {
    var r = canTransitionPurchase(from, to);
    if (!r.ok) return { ok: false, errors: r.errors };
    if (!r.allowed) {
      return {
        ok: false,
        errors: ['transition-not-allowed'],
        from: r.from, to: r.to,
        hint: 'a terminal purchase is immutable; a refund must be a new compensating economic operation'
      };
    }
    return { ok: true, errors: [], from: r.from, to: r.to };
  }

  /* ── Purchase 身份 ────────────────────────────────────────────────────
     ★ 刻意**不**新增第 15 种 id 种类。

     P22-1 §5 冻结的 ID_PREFIX 里已经有 `PURCHASE_INTENT: 'econ_intent_'`，
     而它从冻结那天起**没有任何写入方**（P22-2/3/4/5 都没有用过它）——
     它是"先冻结形状、后实现"留下的那个空槽，语义正是"一次购买"。
     P22-6 把它用起来，而不是新造一个 `econ_purchase_`：

       · 加第 15 种前缀会让两个语义相同的前缀同时存在，此后每一次审计
         都要先回答"intent 与 purchase 差在哪"，而它们没有差；
       · 仓库存量 id 一个都不受影响（这个前缀此前从未被写过），
         因此这是**零迁移**的加法。

     Purchase identity 仍然与它引用的四件事完全分离：
       quoteId / reservationId / ledgerTransactionId / operationId 各自
       有自己的前缀，purchaseId 不得复用其中任何一个（§3）。 */
  var PURCHASE_ID_KIND = 'PURCHASE_INTENT';
  var PURCHASE_ID_PREFIX = ID_PREFIX.PURCHASE_INTENT;

  function formatPurchaseId(suffix) {
    return formatEconomyId(PURCHASE_ID_KIND, suffix);
  }

  /* ── 输入白名单（§40/§41）────────────────────────────────────────────
     与 P22-4 的 BUDGET_INPUT_KEYS / P22-5 的 PRODUCT_INPUT_KEYS 同款：
     让越界的输入**没有地方可以放**。

     settle 的名单是本阶段最重要的一条安全性质：它**恰好三个**键，而
     amount / currency / grantQuantity / recipientId / assetKind /
     settlementType / price / productId / buyerId 全部不在里面。于是
     "settle 时把金额改成 1"这句话在**结构上**不成立 —— 不是被校验
     拒绝，而是没有字段可以承载它。这些值一律从 canonical Purchase /
     Quote 快照读。 */
  var PURCHASE_INPUT_KEYS = Object.freeze([
    'purchaseId', 'buyerId', 'recipientId', 'quoteId',
    'expiresAt', 'units', 'ifRevision', 'idempotencyKey',
    /* ── P22-7 追加的三个（加法）─────────────────────────────────────────
       ★ 为什么恰好是这三个、而不是一个 `approvalMode`：
       授权模式**不是**调用方可以声明的东西 —— 它由"有没有一张有效批准"
       唯一决定。允许调用方自己写 mode 会让"我声称我是 AUTO_ALLOW"成为
       一条绕过批准的路。
       因此这里接受的是**两份证据**，而模式由它们推导：
         · approvalId              —— 一张批准的 id。有它 ⇒ 模式是 APPROVAL，
                                      而这张批准必须真的有效、且绑定这一笔。
         · approvalBindingFingerprint —— 自主闸门在 AUTO_ALLOW 那一刻算出的
                                      九元组身份。有它（且没有 approvalId）
                                      ⇒ 模式是 AUTO_ALLOW，而它必须**重算
                                      一致**（见 store 的
                                      validateAutonomousApprovalInTx）。
         · autonomyPolicyId        —— 那份策略的 id。可追溯"为什么没问用户"。
       两个都没有 ⇒ 模式是 NULL，也就是"这次购买没有走 P22-7 闸门"。
       这三个都不能承载任何经济内容（金额 / 数量 / recipient / settlement
       仍然只从 Quote 快照读），因此 PURCHASE_FORBIDDEN_FIELDS 里**没有**
       它们，而 §6 那条"批准不能被挪给另一笔购买"由九元组比对保证。 */
    'approvalId', 'approvalBindingFingerprint', 'autonomyPolicyId'
  ]);

  var PURCHASE_SETTLE_INPUT_KEYS = Object.freeze([
    'purchaseId', 'now', 'idempotencyKey'
  ]);

  var PURCHASE_CANCEL_INPUT_KEYS = Object.freeze([
    'purchaseId', 'reasonCode', 'idempotencyKey'
  ]);

  /* 逐个点名否认的 Purchase 字段名。它们全是"把结算面变成可篡改面"或
     "影响 Economy 之外的世界"的企图：
       · amount / currency / price / grantQuantity … —— 结算输入篡改；
       · provider* / real* / cny / usd —— P22 的硬边界；
       · discount / coupon / recommended —— 个性化定价；
       · trust / affection / memoryRef —— Relationship / Memory 写入。 */
  var PURCHASE_FORBIDDEN_FIELDS = Object.freeze([
    'amountMinor', 'amount', 'price', 'unitPriceMinor', 'cost', 'money',
    'currency', 'grantQuantity', 'assetKind', 'settlementType', 'unitName',
    'productId', 'buyerId', 'recipientId', 'quoteId', 'reservationId',
    'walletId', 'stock', 'owned', 'providerApiKey', 'providerAccount',
    'providerBalance', 'providerTopup', 'providerQuota', 'realMoney', 'realPrice',
    'cny', 'usd', 'fiatAmount', 'checkoutUrl', 'paymentIntent', 'paymentLink',
    'discount', 'promo', 'coupon', 'featured', 'recommended', 'personalized',
    'trust', 'affection', 'affinity', 'relationshipId', 'memoryRef'
  ]);

  var PURCHASE_FORBIDDEN_FIELD_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < PURCHASE_FORBIDDEN_FIELDS.length; i++) map[PURCHASE_FORBIDDEN_FIELDS[i]] = true;
    return map;
  })();

  function isForbiddenPurchaseFieldName(value) {
    return value != null && PURCHASE_FORBIDDEN_FIELD_INDEX[String(value)] === true;
  }

  /* 读面允许出现的键（白名单构造，§79）。它同时挡住"顺手把整个 ledger
     历史嵌进来"——那是一棵无界对象，而不是一个 canonical entity。 */
  var PURCHASE_SUMMARY_KEYS = Object.freeze([
    'quoteId', 'quoteState', 'quoteAmountMinor', 'quoteCurrency',
    'productId', 'productBacked', 'settlementType',
    'reservationId', 'reservationState', 'reservationAmountMinor',
    'ledgerTransactionId', 'settlement'
  ]);

  var PURCHASE_LIST_KEYS = Object.freeze([
    'buyerId', 'recipientId', 'status', 'productId', 'quoteId', 'limit'
  ]);

  /* ── 结算形态 → canonical in-tx primitive（§72）──────────────────────
     封闭映射，**不是** switch(product.name)。三行恰好覆盖三种交付形态，
     而第四种（Service 的执行）刻意指向 null：本阶段没有可原子执行的
     原语，它必须在 Ledger commit **之前**被拒绝（§73 fail closed）。

     null 与"没登记"是两件事：null 是"这一刻还做不到"（有代码
     SERVICE_EXECUTION 回答"为什么"），没登记是"我不知道这是什么"
     （拼错即抛）。因此下面用 hasOwnProperty 而不是真值判断。 */
  var SETTLEMENT_PRIMITIVE = Object.freeze({
    INVENTORY: 'INVENTORY',
    COMPUTE_ENTITLEMENT: 'COMPUTE_ENTITLEMENT',
    SERVICE_EXECUTION: 'SERVICE_EXECUTION'
  });

  var SETTLEMENT_PRIMITIVES = Object.freeze(Object.keys(SETTLEMENT_PRIMITIVE));

  var SETTLEMENT_PRIMITIVE_OF_FULFILLMENT = Object.freeze({
    INVENTORY_GRANT: SETTLEMENT_PRIMITIVE.INVENTORY,
    COMPUTE_GRANT: SETTLEMENT_PRIMITIVE.COMPUTE_ENTITLEMENT,
    SERVICE_EXECUTION: null
  });

  function settlementPrimitiveOfFulfillment(fulfillment) {
    if (fulfillment == null) return { ok: false, registered: false, primitive: null, errors: ['fulfillment-required'] };
    var f = String(fulfillment);
    if (!Object.prototype.hasOwnProperty.call(SETTLEMENT_PRIMITIVE_OF_FULFILLMENT, f)) {
      return { ok: false, registered: false, primitive: null, errors: ['fulfillment-not-in-closed-set'], fulfillment: f };
    }
    return { ok: true, registered: true, primitive: SETTLEMENT_PRIMITIVE_OF_FULFILLMENT[f], fulfillment: f };
  }

  /* Purchase 的 settlementType **就是** FULFILLMENT 的词表成员。
     为什么不另起一套名字（例如 SETTLEMENT_TYPE.INVENTORY_GRANT_AT_SETTLEMENT）：
     同一个概念有两个词表，此后每一次跨模块对话都要做一次翻译，而
     "翻译错了"的症状是路由到错误的原语。 */

  /* ── 结算的 ledger transaction type ───────────────────────────────────
     ★ 它来自 **Quote 快照**（quotes.service_role 在报价创建时就冻结），
     而不是结算时重新推导。三个 kind 各自映射到一个 P22-1 已冻结的
     TX_TYPE，因此 Purchase 不需要发明任何新的交易类型：
       PURCHASE      → PURCHASE        （商品换 IB Credit）
       GIFT          → GIFT            （别人付款、别人收货）
       COMPUTE_GRANT → COMPUTE_GRANT   （额度被授予；NEUTRAL，占日额度 = 否） */
  var TX_TYPE_OF_QUOTE_KIND = Object.freeze({
    PURCHASE: TX_TYPE.PURCHASE,
    GIFT: TX_TYPE.GIFT,
    COMPUTE_GRANT: TX_TYPE.COMPUTE_GRANT
  });

  function transactionTypeOfQuoteKind(kind) {
    if (!isQuoteKind(kind)) return { ok: false, type: null, errors: ['quote-kind-not-in-closed-set'] };
    var k = String(kind);
    if (!Object.prototype.hasOwnProperty.call(TX_TYPE_OF_QUOTE_KIND, k)) {
      return { ok: false, type: null, errors: ['quote-kind-has-no-ledger-transaction-type'], kind: k };
    }
    return { ok: true, type: TX_TYPE_OF_QUOTE_KIND[k], errors: [], kind: k };
  }

  /* ── 结算对手方（§17/§18）─────────────────────────────────────────────
     普通购买：buyer wallet → SYSTEM_ACCOUNT.MARKET。
     ★ Store **不是**商家：它没有价格、没有拥有关系（P22-5 §2），因此
     它不可能是一个 accounting account。把 storeId 当账户会让一次目录
     变更（新建一个货架）变成一次记账拓扑变更。

     ★★ COMPUTE_GRANT 的对手方**也是** MARKET，不是 MINT。
     这里曾经写过 MINT（理由是"额度是被授予的、没有第二方"），而那条路
     走不通 —— 而且走不通是**对的**：P22-2 的 assertBalanced 有一条硬
     规则"system:mint / system:burn 只允许出现在 MINT / BURN 里"，它的
     存在理由是"否则写一笔 PURCHASE 而把对手方写成 system:mint 就能绕过
     增发的显式命名要求"。为了 cos 破那条规则等于把那条防线拆掉。

     真实语义也比 MINT 更准确：一次 compute 额度购买**不是**一次增发
     （IB Credit 的总量没有从无到有）—— 买家付了 IB Credit，对手方收到
     了它，而"额度"是这次交易**交付的东西**，不是一种货币。MINT / BURN
     留给真正改变总量的那两次操作（P22-2 的 mintForSystem / burnForSystem）。 */
  function settlementCounterpartyFor(quoteKind) {
    if (!isQuoteKind(quoteKind)) return { ok: false, accountId: null, errors: ['quote-kind-not-in-closed-set'] };
    return { ok: true, accountId: SYSTEM_ACCOUNT.MARKET, errors: [] };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-7 §1 · APPROVAL_STATE —— 一条批准记录的状态机
     ══════════════════════════════════════════════════════════════════

     一条 Approval 表达的是**一句话**：

       "用户授权这个被冻结的购买意图继续执行。"

     它与 Purchase 是**两个**实体（§5），因此它有自己的状态机：

       PENDING ──▶ APPROVED ──▶ CONSUMED
          │  │         │
          │  │         └────▶ EXPIRED      （批准了但一直没被用掉）
          │  └────▶ REJECTED                （用户说不）
          └───────▶ EXPIRED                （用户一直没回答）

     四条终态（REJECTED / EXPIRED / CONSUMED）的出边**全部为空**，因此
     "REJECTED → APPROVED"、"EXPIRED → APPROVED"、"CONSUMED → APPROVED"
     三句话在结构上不成立 —— 需要重新批准时创建一条**新的** Approval
     （这正是"批准是一次性事实，不是可复活的状态"的落点）。

     ★ 为什么 APPROVED 不是终态：一个还没被用掉的批准可以在有效期过后
     失去效力（APPROVED → EXPIRED）。把它设成终态会让"一份批准永远不会
     过期"成为结构性的结论，而 §9 明确要求它可过期。 */
  var APPROVAL_STATE = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    EXPIRED: 'EXPIRED',
    CONSUMED: 'CONSUMED'
  });

  var APPROVAL_STATES = Object.freeze(Object.keys(APPROVAL_STATE));

  var APPROVAL_TRANSITIONS = Object.freeze({
    PENDING: Object.freeze([APPROVAL_STATE.APPROVED, APPROVAL_STATE.REJECTED, APPROVAL_STATE.EXPIRED]),
    APPROVED: Object.freeze([APPROVAL_STATE.CONSUMED, APPROVAL_STATE.EXPIRED]),
    REJECTED: Object.freeze([]),
    EXPIRED: Object.freeze([]),
    CONSUMED: Object.freeze([])
  });

  var APPROVAL_TERMINAL_STATES = Object.freeze(
    APPROVAL_STATES.filter(function (s) { return APPROVAL_TRANSITIONS[s].length === 0; })
  );

  var APPROVAL_INITIAL_STATE = APPROVAL_STATE.PENDING;

  var APPROVAL_STATE_INDEX = (function () {
    var map = Object.create(null);
    for (var i = 0; i < APPROVAL_STATES.length; i++) map[APPROVAL_STATES[i]] = true;
    return map;
  })();

  function isApprovalState(value) {
    return value != null && APPROVAL_STATE_INDEX[String(value)] === true;
  }

  function isApprovalTerminalState(value) {
    return APPROVAL_TERMINAL_STATES.indexOf(String(value)) >= 0;
  }

  function canTransitionApproval(from, to) {
    var f = String(from == null ? '' : from);
    var t = String(to == null ? '' : to);
    if (!APPROVAL_STATE_INDEX[f] || !APPROVAL_STATE_INDEX[t]) {
      return { allowed: false, from: f, to: t, errors: ['approval-state-not-in-closed-set'] };
    }
    if (APPROVAL_TRANSITIONS[f].indexOf(t) >= 0) return { allowed: true, from: f, to: t, errors: [] };
    /* 终态回退与"非法转移"是两句不同的话：前者是"这件事已经定局，不要再
       试了"，后者是"你没有从这里走到那里"。审计里它们必须可分，而
       `terminal` 让调用方一眼看出该不该重试 —— 与 P22-3/P22-6 的
       assertPurchaseTransition 逐字同源。 */
    return {
      allowed: false, from: f, to: t,
      terminal: APPROVAL_TRANSITIONS[f].length === 0,
      errors: ['transition-not-allowed']
    };
  }

  function assertApprovalTransition(from, to) {
    var r = canTransitionApproval(from, to);
    if (r.allowed) return r;
    if (r.errors.indexOf('approval-state-not-in-closed-set') >= 0) {
      return Object.assign({}, r, { hint: 'both approval states must come from APPROVAL_STATE' });
    }
    if (r.terminal) {
      return Object.assign({}, r, {
        hint: 'an approval in a terminal state cannot move again; request a new approval instead of reviving this one'
      });
    }
    return Object.assign({}, r, {
      hint: 'a pending approval can only be approved, rejected or expired; an approved approval can only be consumed or expired'
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-7 §2 · AUTONOMOUS PURCHASE POLICY（确定性纯策略）
     ══════════════════════════════════════════════════════════════════

     ★ §3 的边界，逐字写进类型里：这不是 Budget 的改造，而是**另一层**。
       Budget        = 经济上最多允许花多少        （P22-4，冻结）
       Autonomy      = Agent 是否有权不问用户直接花 （P22-7）

     两者相乘，而不是互相替代：

       Budget ALLOW  AND  (Autonomy AUTO_ALLOW OR a valid APPROVAL)

     于是下面两句话都成立，而且各自有一条测试：
       Budget: ALLOW 400 · Autonomy: REQUIRE_APPROVAL  →  仍然必须问用户
       Autonomy: AUTO_ALLOW · Budget: DENY             →  绝对不能买

     AP_DECISION 是这一层的三个词。它与 BUDGET_DECISION **共享**两个词
     （DENY 与 REQUIRE_APPROVAL 在两层上的含义逐字一样），但"允许"那个
     词刻意不同族：

       Budget   ALLOW        = 这笔钱在经济上花得起
       Autonomy AUTO_ALLOW   = 这台 Agent 有权不问用户直接花

     若两层都叫 ALLOW，"这笔为什么买成了"在审计里就会有两个同名的答案。
     这一条是**载入期不变量**，不是注释。 */
  var AP_DECISION = Object.freeze({
    AUTO_ALLOW: 'AUTO_ALLOW',
    REQUIRE_APPROVAL: 'REQUIRE_APPROVAL',
    DENY: 'DENY'
  });

  var AP_DECISIONS = Object.freeze(Object.keys(AP_DECISION));

  /* 评估顺序被冻结成 10 步，与 P22-4 的 BUDGET_EVALUATION_PRIORITY 同款：
     结果里带回 priority，于是"先被哪一条拦下"可以被机器断言，而不必
     从 rule 的文案里猜。

     ★ 这一条顺序是**算过的**，而它的关键判断在最后两位：
       · 三条 DENY 判据里，"作用域 / 结算形态"与"单笔上限"排在审批线
         **之前** —— 一件被规则排除的商品、或一笔越过了单笔上限的钱，
         永远得到 DENY，而不会看起来像一件"等人点头"的事（那时候没有人
         该去点头：规则已经说不，用户点头也没有意义）；
       · **日自主额度刻意排在审批线之后**。理由是一个真实的选择：一笔在
         单笔上限之内、但会撞穿日额度的钱，应该得到 REQUIRE_APPROVAL
         （"这件事需要人点头"），而不是直接 DENY。额度是**能力**线，
         审批线是**许可**线 —— 能问就先问，因为用户点头之后仍有别的
         规则（预算、单笔上限）继续约束它。
       两条一起构成"日额度是自主放行的最终兜底"：它只在"规则允许 + 金额
       在单笔上限内 + 不需要问人"之后才被检查。 */
  var AP_EVALUATION_PRIORITY = Object.freeze([
    'policy-present-and-effective',
    'input-structured',
    'scope-matches',
    'autonomy-enabled',
    'currency-matches',
    'product-kind-allowed',
    'settlement-type-supported',
    'autonomy-max-per-purchase',
    'autonomy-purchase-approval-threshold',
    'autonomy-daily-limit'
  ]);

  /* §4 的白名单。**任何**未列出的键都被拒绝，包括 prompt / persona /
     relationship / llmOutput —— 与 P22-4 的 BUDGET_INPUT_KEYS 同一条纪律：
     策略输入里"无处可放"比"记得别传"强得多。 */
  var AUTONOMY_POLICY_INPUT_KEYS = Object.freeze([
    'ownerId',
    'buyerId',
    'recipientId',
    'productId',
    'productKind',
    'settlementType',
    'currency',
    'amountMinor',
    'gift',
    'selfDirected',
    'spentTodayMinor',
    'timestamp'
  ]);

  /* §4 的策略记录键。金额字段**全部**带 Minor 后缀（§4：不得出现裸的
     budget / limit），而 `enabled` 只有这一个布尔 —— 它是"这台 Agent
     有没有被允许自主购买"的那个开关，缺省 false。 */
  var AUTONOMY_POLICY_KEYS = Object.freeze([
    'policyId',
    'ownerId',
    'enabled',
    'perPurchaseLimitMinor',
    'dailyAutonomousLimitMinor',
    'approvalAboveMinor',
    'allowedProductKinds',
    'allowedSettlementTypes',
    'allowGift'
  ]);

  /* §6 的绑定元组。一张批准**必须**绑定这九个经济事实（或其 canonical
     fingerprint）：
       buyer / recipient / productId / quoteId / currency / amountMinor /
       settlementType / grantQuantity / units
     批准之后换掉其中任何一个，批准即失效 —— 因为"用户批准过 400"这句话
     从不蕴含"用户批准了另一次 400"。 */
  var APPROVAL_BINDING_KEYS = Object.freeze([
    'buyerId', 'recipientId', 'productId', 'quoteId',
    'currency', 'amountMinor', 'settlementType', 'grantQuantity', 'units'
  ]);

  /* 一次批准的有效期上界。一条"永久有效"的批准与"以后随便花 500"是同一种
     东西，而 §6 明确禁止后者。上界是 24 小时：它比任何一次真实购买需要
     的决策时间长得多，又不至于让一条批准在下个月还能被用掉。 */
  var APPROVAL_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

  /* 授权模式。它被**冻结在 Purchase 行上**，因此结算时"这笔购买当初凭
     什么成立"不需要重新推断（见 store 的 approval_mode 列）。 */
  var PURCHASE_APPROVAL_MODE = Object.freeze({
    AUTO_ALLOW: 'AUTO_ALLOW',
    APPROVAL: 'APPROVAL'
  });

  var PURCHASE_APPROVAL_MODES = Object.freeze(Object.keys(PURCHASE_APPROVAL_MODE));

  function isPurchaseApprovalMode(value) {
    return value != null && PURCHASE_APPROVAL_MODES.indexOf(String(value)) >= 0;
  }

  /* §2/§3 的八句自述。它们是**可断言**的字段，而不是文档里的句子 ——
     "自主不是决策"必须是这个系统自己说出来的话。 */
  var AUTONOMY_POLICY_IS_A_DECISION_LAYER = false;
  var AUTONOMY_POLICY_READS_LLM_OUTPUT = false;
  var AUTONOMY_POLICY_READS_MEMORY = false;
  var AUTONOMY_POLICY_READS_RELATIONSHIP = false;
  var AUTONOMY_POLICY_GRANTS_BUDGET = false;
  var AUTONOMY_REPLACES_BUDGET = false;
  var APPROVAL_BYPASSES_BUDGET = false;
  var APPROVAL_BYPASSES_QUOTE_EXPIRY = false;
  var APPROVAL_IS_SINGLE_USE = true;
  var APPROVAL_IS_BOUND_TO_A_QUOTE = true;
  var AUTONOMY_DEFAULT_WHEN_NO_POLICY = AP_DECISION.REQUIRE_APPROVAL;

  var AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS = Object.freeze([
    'prompt', 'system', 'systemPrompt', 'persona', 'personality', 'mood',
    'relationship', 'relationshipId', 'affection', 'trust', 'affinity',
    'memory', 'memoryRef', 'memories',
    'message', 'messages',
    'content', 'text', 'reply', 'llmOutput', 'modelOutput', 'completion',
    'rawOutput', 'reasoning', 'thoughts', 'narration', 'desire', 'plea',
    'argument', 'feelsLikeBuying', 'agentDecided', 'importance', 'urgency',
    'walletBalance', 'availableBalanceMinor', 'maxBudget', 'budget'
  ]);

  var AUTONOMY_FORBIDDEN_INDEX = (function () {
    var map = Object.create(null);
    for (var j = 0; j < AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS.length; j++) {
      map[AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS[j]] = true;
    }
    return map;
  })();

  var AUTONOMY_INPUT_INDEX = (function () {
    var map = Object.create(null);
    for (var k = 0; k < AUTONOMY_POLICY_INPUT_KEYS.length; k++) {
      map[AUTONOMY_POLICY_INPUT_KEYS[k]] = true;
    }
    return map;
  })();

  /* 自主策略允许出现的商品种类。**就是** P22-5 冻结的 PRODUCT_KINDS，
     刻意不再造一套同义词：一件商品的自主范围与它的目录语义必须是同一个
     词表，否则"自主允许买 COMPUTE_CREDIT 但目录里叫 COMPUTE_GRANT"会
     变成一个静默的空集。 */
  function normalizeAutonomyPolicyInput(input) {
    if (input == null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, input: null, errors: ['autonomy-input-must-be-a-structured-object'] };
    }
    var errors = [];
    var keys = Object.keys(input);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!AUTONOMY_INPUT_INDEX[k]) {
        errors.push(AUTONOMY_FORBIDDEN_INDEX[k]
          ? 'autonomy-input-carries-non-deterministic-text'
          : 'autonomy-input-key-not-whitelisted');
      }
    }
    var out = {};
    var scope = promotePartyRef(input.ownerId != null ? input.ownerId : input.buyerId);
    if (input.ownerId != null || input.buyerId != null) {
      if (!scope) errors.push('autonomy-owner-invalid');
      else out.ownerId = Object.freeze({ type: scope.type, id: scope.id });
    }
    if (input.recipientId != null) {
      var rec = promotePartyRef(input.recipientId);
      if (!rec) errors.push('autonomy-recipient-invalid');
      else out.recipientId = Object.freeze({ type: rec.type, id: rec.id });
    }
    if (input.productId != null) {
      if (!isEconomyId('PRODUCT', input.productId)) errors.push('autonomy-product-id-not-canonical');
      else out.productId = String(input.productId);
    }
    if (input.productKind != null) {
      if (!isProductKind(input.productKind)) errors.push('autonomy-product-kind-not-in-closed-set');
      else out.productKind = String(input.productKind);
    }
    if (input.settlementType != null) {
      if (!isFulfillment(input.settlementType)) errors.push('autonomy-settlement-type-not-in-closed-set');
      else out.settlementType = String(input.settlementType);
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
    if (input.spentTodayMinor != null) {
      var spent = normalizeAmountMinor(input.spentTodayMinor);
      if (!spent.ok) errors.push.apply(errors, spent.errors);
      else out.spentTodayMinor = spent.amountMinor;
    }
    if (input.gift != null) {
      if (typeof input.gift !== 'boolean') errors.push('autonomy-gift-must-be-a-boolean');
      else out.gift = input.gift;
    }
    if (input.selfDirected != null) {
      if (typeof input.selfDirected !== 'boolean') errors.push('autonomy-self-directed-must-be-a-boolean');
      else out.selfDirected = input.selfDirected;
    }
    if (input.timestamp != null) {
      var ts = Number(input.timestamp);
      if (!Number.isSafeInteger(ts) || ts < 0) errors.push('autonomy-timestamp-must-be-non-negative-safe-integer');
      else out.timestamp = ts;
    }
    if (errors.length) return { ok: false, input: null, errors: errors };
    return { ok: true, input: Object.freeze(out), errors: [] };
  }

  /* ── 策略记录的形状校验（纯函数）────────────────────────────────────
     ★ §4 的 fail closed 在这里的落点有两层，都必须成立：
       ① 没有策略      → REQUIRE_APPROVAL（**不是** AUTO_ALLOW）
       ② 策略存在但形状不可信 → DENY（不是"既然读不懂就随便吧"）
     ② 比 ① 更严格是对的：一台**配过**自主策略的 Agent 如果那条策略坏了，
     那说明有人正在改规则而改到一半 —— 这时放行比拒绝危险得多。 */
  function validateAutonomyPolicy(input) {
    var o = input || {};
    var errors = [];
    var policyId = o.policyId == null ? null : String(o.policyId);
    if (!isEconomyId('BUDGET_POLICY', policyId)) errors.push('autonomy-policy-id-not-canonical');
    var owner = promotePartyRef(o.ownerId);
    if (!owner) errors.push('autonomy-policy-owner-invalid');
    else if (String(owner.type) === PARTY_TYPE.SYSTEM) errors.push('system-cannot-own-an-autonomy-policy');
    /* ★ 一个**未知**的 owner 类型也必须被拒。`promotePartyRef` 接受三种
       party type（character / user / system），而上面只挡了 system ——
       那意味着一个拼错的类型会在 promotePartyRef 里就失败（好），但一个
       未来新增的类型会静默地成为合法的策略主人。这一条把它钉住：
       §3 的权限层只对"一个具体的人 / 一个具体的角色"成立。 */
    else if (PARTY_TYPES.indexOf(String(owner.type)) < 0) errors.push('autonomy-policy-owner-type-not-in-closed-set');
    if (typeof o.enabled !== 'boolean') errors.push('autonomy-policy-enabled-must-be-a-boolean');

    /* ★ 两条额度**必须**存在。一个"enabled 但没有上限"的自主策略等于
       "以后随便花"，而 §6 逐字禁止那句话。这里刻意不用 0 当缺省：0 是
       "一分钱都不许自主花"，与"没写"是两个不同的结论，而其中的差别决定
       了这台 Agent 是"只能问用户"还是"可以被配置成只能问用户"。 */
    var perPurchase = o.perPurchaseLimitMinor == null ? null : normalizeAmountMinor(o.perPurchaseLimitMinor);
    if (perPurchase == null) errors.push('autonomy-policy-requires-per-purchase-limit-minor');
    else if (!perPurchase.ok) errors.push.apply(errors, perPurchase.errors);
    var daily = o.dailyAutonomousLimitMinor == null ? null : normalizeAmountMinor(o.dailyAutonomousLimitMinor);
    if (daily == null) errors.push('autonomy-policy-requires-daily-autonomous-limit-minor');
    else if (!daily.ok) errors.push.apply(errors, daily.errors);
    if (perPurchase && perPurchase.ok && daily && daily.ok && perPurchase.amountMinor > daily.amountMinor) {
      errors.push('autonomy-per-purchase-limit-must-not-exceed-the-daily-autonomous-limit');
    }

    /* ── approvalAboveMinor：可选的**许可线**。它存在的理由是一个真实
       情形：一笔 150 的购买完全在额度之内（perPurchase 500 / daily 1000），
       但用户仍然希望"超过 100 就问我"。若把它设得**高于** per-purchase
       上限，那条线永远不会被触发 —— 一条永远不生效的规则比没有规则更糟，
       因为它看起来像一条保证。因此这里拒绝它，而不是静默忽略。
       缺省值逐字是 perPurchaseLimitMinor：**整段自主额度都需要批准**，
       这比"缺省就完全不需要批准"安全得多（§4 fail closed）。 */
    var threshold = null;
    if (o.approvalAboveMinor != null) {
      var thr = normalizeAmountMinor(o.approvalAboveMinor);
      if (!thr.ok) errors.push.apply(errors, thr.errors);
      else threshold = thr.amountMinor;
    }
    if (threshold != null && perPurchase && perPurchase.ok && threshold > perPurchase.amountMinor) {
      errors.push('autonomy-approval-threshold-must-not-exceed-the-per-purchase-limit');
    }

    var kinds = o.allowedProductKinds;
    if (kinds != null) {
      if (!Array.isArray(kinds) || kinds.length === 0) errors.push('autonomy-allowed-product-kinds-must-be-a-non-empty-array');
      else {
        for (var i = 0; i < kinds.length; i++) {
          if (!isProductKind(kinds[i])) errors.push('autonomy-allowed-product-kind-not-in-closed-set');
        }
      }
    }
    var settlements = o.allowedSettlementTypes;
    if (settlements != null) {
      if (!Array.isArray(settlements) || settlements.length === 0) errors.push('autonomy-allowed-settlement-types-must-be-a-non-empty-array');
      else {
        for (var j = 0; j < settlements.length; j++) {
          if (!isFulfillment(settlements[j])) errors.push('autonomy-allowed-settlement-type-not-in-closed-set');
        }
      }
    }
    if (o.allowGift != null && typeof o.allowGift !== 'boolean') {
      errors.push('autonomy-allow-gift-must-be-a-boolean');
    }

    if (errors.length) return { ok: false, policy: null, errors: errors };
    return {
      ok: true,
      errors: [],
      policy: Object.freeze({
        domain: DOMAIN,
        namespace: NAMESPACES.BUDGET,
        kind: 'autonomy',
        policyId: policyId,
        ownerId: Object.freeze({ type: owner.type, id: owner.id }),
        enabled: o.enabled === true,
        perPurchaseLimitMinor: perPurchase.amountMinor,
        dailyAutonomousLimitMinor: daily.amountMinor,
        approvalAboveMinor: threshold == null ? perPurchase.amountMinor : threshold,
        /* 缺省是**空集**，不是"全允许"：一份没写 allowedProductKinds 的策略
           不自主买任何东西。fail closed 在字段级也成立。 */
        allowedProductKinds: Object.freeze(kinds == null ? [] : kinds.map(function (x) { return String(x); })),
        allowedSettlementTypes: Object.freeze(settlements == null ? [] : settlements.map(function (x) { return String(x); })),
        allowGift: o.allowGift === true
      })
    };
  }

  /* ── §2 的确定性评估器 ───────────────────────────────────────────────
     签名是一对 (policy, context) —— 两个**数据**参数。没有 store、没有
     时钟、没有随机、没有任何 I/O，因此

       same policy + same context  ⇒  same decision

     是结构性成立的（P22-7 的 autonomous 测试组会真的证伪它：跑一千次、
     打乱键序、深拷贝，结果必须逐字节相同）。

     policy == null 是**一个真实且可回答的情形**：这台 Agent 没有自主策略。
     它返回 REQUIRE_APPROVAL（§4 的默认 fail closed），而不是 DENY ——
     "没配"不等于"禁止"，它等于"回到默认，也就是问用户"。 */
  function evaluateAutonomousPurchase(policy, context) {
    var reasons = [];
    var prio = function (i) { return AP_EVALUATION_PRIORITY[i]; };
    var deny = function (code, i, extra) {
      return apDecision(AP_DECISION.DENY, code, Object.assign({
        priority: prio(i), priorityRule: prio(i), errors: [], reasons: reasons,
        /* ★ 三句自述在**三种结论上都出现**（不只是 AUTO_ALLOW）：一个 DENY
           同样只回答"有没有权"，同样不是预算判断，同样什么也不授予。
           只把它们写在成功路径上会让"这条结论是什么"变成一个"字段存不
           存在"的问题 —— 而 read 侧要么写 `=== false`（对缺字段为 false
           ⇒ 断言无声失败），要么写 `!== true`（对任何缺失都为 true ⇒
           断言永不失败）。两种写法都不会失败得**有意义**。 */
        answers: 'may-this-agent-spend-without-asking-the-user',
        notABudgetDecision: true,
        grantsBudget: AUTONOMY_POLICY_GRANTS_BUDGET
      }, extra || {}));
    };
    var needApproval = function (code, i, extra) {
      return apDecision(AP_DECISION.REQUIRE_APPROVAL, code, Object.assign({
        priority: prio(i), priorityRule: prio(i), errors: [], reasons: reasons,
        answers: 'may-this-agent-spend-without-asking-the-user',
        notABudgetDecision: true,
        grantsBudget: AUTONOMY_POLICY_GRANTS_BUDGET
      }, extra || {}));
    };

    /* ── ① 没有策略 ⇒ REQUIRE_APPROVAL（§4）─────────────────────────── */
    if (policy == null) {
      return needApproval(DENY_REASON.APPROVAL_REQUIRED, 0, {
        policyPresent: false,
        defaultedToRequireApproval: true,
        rule: 'no-autonomy-policy-defaults-to-require-approval'
      });
    }

    /* ── ② 策略必须是一份形状可信的**记录**。这里只检查"是不是一个对象"
          与"它自己有没有说自己是坏的"：真正的形状校验在 validateAutonomyPolicy
          里（store 层落库前跑一次），而这里再确认一次是刻意的 —— 一条被
          外部工具改坏的策略行不能因为"它当初校验过"就被放行。 */
    if (typeof policy !== 'object' || Array.isArray(policy)) {
      return deny(DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, 1, { errors: ['autonomy-policy-must-be-a-structured-object'] });
    }
    if (policy.unusable === true) {
      return deny(DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, 1, {
        errors: policy.unusableErrors || ['autonomy-policy-row-is-not-trustworthy'],
        systemFailure: false
      });
    }

    var norm = normalizeAutonomyPolicyInput(context);
    if (!norm.ok) {
      return deny(DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, 1, { errors: norm.errors });
    }
    var ctx = norm.input;

    /* ── ③ 作用域：策略属于谁，它就只能替谁判定 ─────────────────────── */
    if (!partyRefEquals(ctx.ownerId, policy.ownerId)) {
      return deny(DENY_REASON.POLICY_NOT_FOUND, 2, {
        errors: ['autonomy-policy-owner-does-not-match-the-evaluated-owner']
      });
    }
    if (ctx.currency != null && String(ctx.currency) !== String(policy.currency == null ? ctx.currency : policy.currency)) {
      return deny(DENY_REASON.INVALID_CURRENCY, 4, {
        errors: ['autonomy-policy-currency-does-not-match-the-evaluated-currency'],
        policyCurrency: policy.currency == null ? null : String(policy.currency),
        contextCurrency: String(ctx.currency)
      });
    }

    /* ── ④ §4 的开关。enabled=false 是"这台 Agent 不许自主购买"，它与
           "没有策略"是两件事：前者是有人**明确关掉了**它。 */
    if (policy.enabled !== true) {
      return deny(DENY_REASON.AUTONOMY_NOT_PERMITTED, 3, {
        policyEnabled: false,
        rule: 'autonomy-is-disabled-by-policy'
      });
    }

    /* ── ⑤ 商品种类白名单（缺省空集 ⇒ 什么都不自主买）───────────────── */
    var kinds = policy.allowedProductKinds || [];
    if (ctx.productKind == null || kinds.indexOf(String(ctx.productKind)) < 0) {
      return deny(DENY_REASON.AUTONOMY_NOT_PERMITTED, 5, {
        productKind: ctx.productKind == null ? null : String(ctx.productKind),
        allowedProductKinds: kinds.slice(),
        rule: 'product-kind-is-not-in-the-autonomy-scope'
      });
    }

    /* ── ⑥ 结算形态白名单。★ 这里同时要求"这种形态**有**可原子执行的
           原语"：自主策略对 SERVICE_EXECUTION 说"可以"是没有意义的，
           因为 P22-6 §22/§54 会在预留之前就拒绝它。让授权层说出一个
           结算层永远不接受的决定，会把"为什么没成"变成两句话。 */
    var settlements = policy.allowedSettlementTypes || [];
    if (ctx.settlementType == null || settlements.indexOf(String(ctx.settlementType)) < 0) {
      return deny(DENY_REASON.AUTONOMY_NOT_PERMITTED, 6, {
        settlementType: ctx.settlementType == null ? null : String(ctx.settlementType),
        allowedSettlementTypes: settlements.slice(),
        rule: 'settlement-type-is-not-in-the-autonomy-scope'
      });
    }
    var prim = settlementPrimitiveOfFulfillment(ctx.settlementType);
    if (!prim.ok || prim.primitive == null) {
      return deny(DENY_REASON.AUTONOMY_NOT_PERMITTED, 6, {
        settlementType: String(ctx.settlementType),
        settlementPrimitive: null,
        rule: 'this-settlement-type-has-no-atomic-primitive-and-can-never-be-autonomous'
      });
    }

    /* ── ⑦ 金额必须存在且为正。0 金额没有经济内容 —— 与 P22-4 同判。 */
    if (ctx.amountMinor == null || ctx.amountMinor === 0n) {
      return deny(DENY_REASON.INVALID_AMOUNT, 7, { errors: ['autonomy-evaluation-amount-must-be-positive'] });
    }
    var amount = ctx.amountMinor;

    /* ── ⑧ §12 Gift：默认**不**允许自主送礼。★ 刻意排在金额判据之前：
           一次送礼是否是"被允许的行为"与金额无关，而"Relationship 高所以
           自动允许送礼"这句话在这里连一个字段都找不到（关系/好感不在
           输入白名单里）。 */
    var isGift = ctx.gift === true || (ctx.selfDirected === false && ctx.recipientId != null);
    if (isGift && policy.allowGift !== true) {
      return deny(DENY_REASON.AUTONOMY_NOT_PERMITTED, 5, {
        gift: true, allowGift: false,
        rule: 'gifting-someone-else-is-not-autonomous-by-default'
      });
    }

    /* ── ⑨ per-purchase 额度（DENY，不是 REQUIRE_APPROVAL）──────────── */
    var perPurchaseLimit = policy.perPurchaseLimitMinor;
    if (perPurchaseLimit == null) {
      return deny(DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, 7, { errors: ['autonomy-policy-carries-no-per-purchase-limit'] });
    }
    if (amount > perPurchaseLimit) {
      return deny(DENY_REASON.AUTONOMY_LIMIT, 7, {
        amountMinor: serializeAmountMinor(amount),
        perPurchaseLimitMinor: serializeAmountMinor(perPurchaseLimit),
        rule: 'amount-exceeds-the-autonomy-per-purchase-limit'
      });
    }

    /* ── ⑩ 日自主额度。spentTodayMinor 缺省**不**当成 0：一个不知道
           "今天已经自主花了多少"的评估不能得出 AUTO_ALLOW —— 那正是
           P22-4 §17 点名禁止的形状（未知被兜成 0）。
           ★ 排队顺序上：金额没到 per-purchase 上限、且今天没有超日额度，
           才需要看审批线；因此下面两条 REQUIRE_APPROVAL 判据排在所有
           DENY 判据之后。 */
    if (ctx.spentTodayMinor == null) {
      return deny(DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, 9, {
        errors: ['autonomy-context-must-carry-spent-today-minor']
      });
    }
    var dailyLimit = policy.dailyAutonomousLimitMinor;
    if (dailyLimit == null) {
      return deny(DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, 9, { errors: ['autonomy-policy-carries-no-daily-limit'] });
    }
    if (ctx.spentTodayMinor + amount > dailyLimit) {
      return deny(DENY_REASON.AUTONOMY_LIMIT, 9, {
        amountMinor: serializeAmountMinor(amount),
        spentTodayMinor: serializeAmountMinor(ctx.spentTodayMinor),
        dailyAutonomousLimitMinor: serializeAmountMinor(dailyLimit),
        rule: 'this-purchase-would-exceed-the-daily-autonomous-limit'
      });
    }

    /* ── ⑪ 到这里只说明"额度允许"。§5 的审批线是**许可线**，不是额度线：
           它表达的是"金额本身经济上没问题，但它需要人点头"。 */
    var threshold = policy.approvalAboveMinor;
    if (threshold != null && amount > threshold) {
      return needApproval(DENY_REASON.APPROVAL_REQUIRED, 8, {
        amountMinor: serializeAmountMinor(amount),
        approvalAboveMinor: serializeAmountMinor(threshold),
        rule: 'amount-exceeds-the-autonomy-approval-threshold'
      });
    }

    reasons.push('autonomy-allowed-by-policy');
    return apDecision(AP_DECISION.AUTO_ALLOW, BUDGET_ALLOWED_REASON, {
      priority: null, priorityRule: null, errors: [], reasons: reasons,
      amountMinor: serializeAmountMinor(amount),
      perPurchaseLimitMinor: serializeAmountMinor(perPurchaseLimit),
      spentTodayMinor: serializeAmountMinor(ctx.spentTodayMinor),
      dailyAutonomousLimitMinor: serializeAmountMinor(dailyLimit),
      /* ★ 逐字：这条结论**只**回答"Agent 有没有权不问用户直接花"。
         它没有说"这笔钱花得起"，也没有说"这份报价还有效"。 */
      answers: 'may-this-agent-spend-without-asking-the-user',
      notABudgetDecision: true,
      grantsBudget: AUTONOMY_POLICY_GRANTS_BUDGET
    });
  }
  function apDecision(outcome, reasonCode, extra) {
    var o = String(outcome);
    if (AP_DECISIONS.indexOf(o) < 0) {
      return { ok: false, errors: ['autonomy-decision-not-in-closed-set'] };
    }
    var reason = reasonCode == null ? null : String(reasonCode);
    if (o === AP_DECISION.DENY) {
      if (!reason) return { ok: false, errors: ['autonomy-deny-requires-a-reason-code'] };
      if (!isDenyReasonCode(reason)) return { ok: false, errors: ['deny-reason-code-not-in-closed-set'] };
    } else if (reason != null && reason !== BUDGET_ALLOWED_REASON && !isDenyReasonCode(reason)) {
      return { ok: false, errors: ['deny-reason-code-not-in-closed-set'] };
    }
    var detail = Object.assign({}, extra || {});
    var atValue = detail.timestamp != null ? detail.timestamp : (detail.at != null ? detail.at : null);
    var state = {
      domain: DOMAIN,
      namespace: NAMESPACES.BUDGET,
      kind: 'autonomy-evaluation',
      authority: 'none',
      at: atValue == null ? null : Number(atValue)
    };
    return Object.freeze(Object.assign({
      domain: DOMAIN,
      namespace: NAMESPACES.BUDGET,
      outcome: o,
      reasonCode: reason,
      autoAllowed: o === AP_DECISION.AUTO_ALLOW,
      requiresApproval: o === AP_DECISION.REQUIRE_APPROVAL,
      denied: o === AP_DECISION.DENY,
      evaluatedOnly: true,
      snapshot: Object.freeze(state)
    }, detail));
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-7 §3 · Approval 记录的 canonical 指纹
     ══════════════════════════════════════════════════════════════════

     纯函数：把九个绑定事实变成一个稳定的字符串身份。它**不含**任何
     生成的 id，因此"批准的是哪一件事"与"批准记录叫什么名字"是两回事
     —— 前者可以被独立重算，后者只是这条记录的主键。

     ★ 它刻意**不**把 units 与 grantQuantity 合并成一个：两者是不同的
     事实（"买 3 份"与"收到 30 个 computeUnit"），而 §6 要求换掉"数量"
     之后批准必须失效 —— 换掉哪一个都算。 */
  function approvalFingerprint(binding) {
    var o = binding || {};
    var parts = [];
    var keys = APPROVAL_BINDING_KEYS;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = o[k];
      if (v == null) parts.push(k + '=');
      else if (k === 'amountMinor') {
        var amt = normalizeAmountMinor(v);
        if (!amt.ok) return { ok: false, fingerprint: null, errors: ['approval-binding-amount-is-not-canonical'] };
        parts.push(k + '=' + serializeAmountMinor(amt.amountMinor));
      } else parts.push(k + '=' + String(v));
    }
    return { ok: true, fingerprint: parts.join('\u0001'), errors: [] };
  }

  /* 一次批准必须是"针对一份具体报价快照"的授权（§7）。因此这份记录在
     落库前必须通过形状校验：九个绑定事实齐全、五个时间字段各自可判定。 */
  function validateApproval(input) {
    var o = input || {};
    var errors = [];
    var approvalId = o.approvalId == null ? null : String(o.approvalId);
    if (!isEconomyId('APPROVAL', approvalId)) errors.push('approval-id-not-canonical');
    var buyer = promotePartyRef(o.buyerId);
    if (!buyer) errors.push('approval-buyer-must-be-a-canonical-party-ref');
    else if (String(buyer.type) === PARTY_TYPE.SYSTEM) errors.push('system-party-cannot-buy');
    if (o.recipientId != null && !promotePartyRef(o.recipientId)) {
      errors.push('approval-recipient-must-be-a-canonical-party-ref');
    }
    if (!isEconomyId('PRODUCT', o.productId)) errors.push('approval-product-id-not-canonical');
    if (!isEconomyId('QUOTE', o.quoteId)) errors.push('approval-quote-id-not-canonical');
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var amt = normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) errors.push.apply(errors, amt.errors);
    if (!isFulfillment(o.settlementType)) errors.push('approval-settlement-type-not-in-closed-set');
    if (!isQuoteKind(o.quoteKind)) errors.push('approval-quote-kind-not-in-closed-set');
    if (!Number.isSafeInteger(o.grantQuantity) || o.grantQuantity < 0) {
      errors.push('approval-grant-quantity-must-be-a-non-negative-safe-integer');
    }
    if (!Number.isSafeInteger(o.units) || o.units < 1) {
      errors.push('approval-units-must-be-a-positive-safe-integer');
    }
    if (!isApprovalState(o.status)) errors.push('approval-status-not-in-closed-set');
    if (!isPurchaseApprovalMode(o.approvalMode)) errors.push('approval-approval-mode-not-in-closed-set');
    if (o.expiresAt == null || !Number.isSafeInteger(Number(o.expiresAt)) || Number(o.expiresAt) < 0) {
      errors.push('approval-expires-at-must-be-a-non-negative-safe-integer');
    }
    if (errors.length) return { ok: false, approval: null, errors: errors };
    return {
      ok: true,
      errors: [],
      approval: Object.freeze({
        domain: DOMAIN,
        namespace: NAMESPACES.APPROVAL,
        approvalId: approvalId,
        buyerId: Object.freeze({ type: buyer.type, id: buyer.id }),
        recipientId: o.recipientId == null ? null : (function () {
          var r = promotePartyRef(o.recipientId);
          return Object.freeze({ type: r.type, id: r.id });
        })(),
        productId: String(o.productId),
        quoteId: String(o.quoteId),
        quoteKind: String(o.quoteKind),
        currency: cur.currency,
        amountMinor: amt.amountMinor,
        settlementType: String(o.settlementType),
        grantQuantity: Number(o.grantQuantity),
        units: Number(o.units),
        status: String(o.status),
        approvalMode: String(o.approvalMode),
        expiresAt: Number(o.expiresAt)
      })
    };
  }

  /* 一份 Purchase 的 ledger transaction id **确定性地**派生自 purchaseId。
     与 P22-3 的 deriveCommitTransactionId(reservationId) 同一手法，理由
     也相同：重放同一个业务必须得到同一个记账身份，而**第二次提交**会
     撞上同一个 transactionId —— 于是"一次购买最多一笔交易"由
     ledger 自己的 UNIQUE 主键兜底，不靠代码自律。 */
  function derivePurchaseLedgerTransactionId(purchaseId) {
    if (!isEconomyId(PURCHASE_ID_KIND, purchaseId)) {
      return { ok: false, transactionId: null, errors: ['purchase-id-not-canonical'] };
    }
    var encoded = String(purchaseId).split('').map(function (ch) {
      var code = ch.charCodeAt(0);
      return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ? ch : '_';
    }).join('');
    return formatEconomyId('TRANSACTION', 'purchase_' + encoded);
  }

  /* 刻意**没有**：refundPurchase / reversePurchase / chargeback（§59）、
     购物车 quantity（§75，Product 一次购买固定 grantQuantity）、
     部分消费（一份 Quote 恰好被消费一次）。
     ★ P22-7 更正了最后一项：pending approval 记录**现在存在**了
     （APPROVAL_STATE 五态 + economy_approvals 一张表）。P22-6 冻结的
     `PURCHASE_CREATES_PENDING_APPROVAL_RECORDS = false` 说的是"P22-6 的
     preparePurchase / settlePurchase 自己不创建它"，那句话**逐字仍然成立**
     —— 创建它的是 P22-7 的 authorizePurchaseIntent。两条事实分开表达，
     因为把 false 改成 true 会让"P22-6 的结算路径会凭空多写一张表"成为
     一个看起来为真的陈述。 */
  var PURCHASE_AMOUNT_SOURCE = 'quote-snapshot';
  var PURCHASE_QUOTE_RELATION = 'CANONICAL_LINKAGE';
  var PURCHASE_PREPARE_REQUIRES_BUDGET_ALLOW = true;
  var PURCHASE_SETTLE_REVALIDATES_BUDGET = true;
  var PURCHASE_REWRITES_HISTORICAL_QUOTES = false;
  var PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND = false;
  var PURCHASE_CANCEL_CANCELS_THE_QUOTE = false;
  var PURCHASE_SETTLEMENT_IS_ONE_TRANSACTION = true;
  var PURCHASE_HAS_REFUND = false;
  var PURCHASE_QUOTE_CONSUMPTION_IS_PARTIAL = false;
  var PURCHASE_HAS_CART_QUANTITY = false;
  var PURCHASE_CREATES_PENDING_APPROVAL_RECORDS = false;
  var PURCHASE_EXPOSES_HTTP_MUTATION = false;
  var PURCHASE_SETTLEMENT_MAY_READ_MUTABLE_PRODUCT_FIELDS = false;
  var PURCHASE_TOUCHES_PROVIDER = false;
  var PURCHASE_TOUCHES_PAYMENT = false;
  var PURCHASE_TOUCHES_MEMORY = false;
  var PURCHASE_TOUCHES_RELATIONSHIP = false;

  /* 结算路径**不允许**触碰的 ledger 账户名（§17：不得临时创建任意
     system account，必须来自白名单）。MINT/BURN 在这里被点名否认：
     一次购买不是一次增发或销毁 —— 钱从买家到对手方，总量不变。
     （COMPUTE_GRANT 的 MINT 对手方是 §17 允许的那一种：额度是被**授予**
     的，它没有第二方。见 settlementCounterpartyFor。） */
  var FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS = Object.freeze([
    'provider:openai', 'provider:anthropic', 'provider:deepseek',
    'provider:gemini', 'provider:openrouter', 'provider:teamrouter',
    'provider:zenmux', 'merchant:alipay', 'merchant:external', 'seller:external',
    'bank:external', 'system:provider', 'system:bank', 'system:balance',
    'system:quota', 'token:balance', 'apiBalance', 'tokenBalance'
  ]);

  /* ── 形状校验（纯函数）────────────────────────────────────────────────
     它校验的是**一条已经冻结的 Purchase 快照**：所有 id 都必须是
     canonical，金额必须能被范式化，四个引用（quote/reservation/product/
     ledger）各自形状正确。它**不**查询任何东西 —— 存在性属于运行层。 */
  function validatePurchase(input) {
    var o = input || {};
    var errors = [];
    if (!isEconomyId(PURCHASE_ID_KIND, o.purchaseId)) errors.push('purchase-id-not-canonical');
    if (!isPartyRef(o.buyer)) errors.push('purchase-buyer-must-be-a-canonical-party-ref');
    else if (String(o.buyer.type) === PARTY_TYPE.SYSTEM) errors.push('system-party-cannot-buy');
    if (o.recipient != null && !isPartyRef(o.recipient)) errors.push('purchase-recipient-must-be-a-canonical-party-ref');
    if (!isEconomyId('QUOTE', o.quoteId)) errors.push('quote-id-not-canonical');
    if (!isEconomyId('RESERVATION', o.reservationId)) errors.push('reservation-id-not-canonical');
    if (!isEconomyId('PRODUCT', o.productId)) errors.push('product-id-not-canonical');
    if (o.ledgerTransactionId != null && !isEconomyId('TRANSACTION', o.ledgerTransactionId)) {
      errors.push('transaction-id-not-canonical');
    }
    var cur = validateCurrency(o.currency);
    if (!cur.ok) errors.push.apply(errors, cur.errors);
    var amt = normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) errors.push.apply(errors, amt.errors);
    if (!isQuoteKind(o.quoteKind)) errors.push('quote-kind-not-in-closed-set');
    var tx = transactionTypeOfQuoteKind(o.quoteKind);
    if (!tx.ok) errors.push.apply(errors, tx.errors);
    if (!isFulfillment(o.fulfillment)) errors.push('fulfillment-not-in-closed-set');
    var prim = settlementPrimitiveOfFulfillment(o.fulfillment);
    if (!prim.ok) errors.push.apply(errors, prim.errors);
    if (o.settledAssetKind != null && !isAssetKind(o.settledAssetKind)) errors.push('asset-kind-not-in-closed-set');
    if (!Number.isSafeInteger(o.settledQuantity) || o.settledQuantity < 0) {
      errors.push('purchase-settled-quantity-must-be-a-non-negative-safe-integer');
    }
    if (o.settledUnitName != null && !isUnitName(o.settledUnitName)) errors.push('unit-name-not-in-closed-set');
    if (!isPurchaseState(o.status)) errors.push('purchase-status-not-in-closed-set');
    if (!Number.isSafeInteger(o.revision) || o.revision < 0) errors.push('purchase-revision-must-be-a-non-negative-safe-integer');
    if (!Number.isSafeInteger(o.createdAt) || o.createdAt < 0) errors.push('purchase-created-at-must-be-a-non-negative-safe-integer');
    if (!Number.isSafeInteger(o.updatedAt) || o.updatedAt < 0) errors.push('purchase-updated-at-must-be-a-non-negative-safe-integer');
    if (o.completedAt != null && (!Number.isSafeInteger(o.completedAt) || o.completedAt < 0)) {
      errors.push('purchase-completed-at-must-be-a-non-negative-safe-integer');
    }
    if (errors.length) return { ok: false, errors: errors };
    var snapshot = {
      domain: DOMAIN,
      namespace: NAMESPACES.QUOTE && o.namespace ? o.namespace : o.namespace,
      purchaseId: String(o.purchaseId),
      buyer: Object.freeze({ type: String(o.buyer.type), id: String(o.buyer.id) }),
      recipient: o.recipient == null ? null : Object.freeze({ type: String(o.recipient.type), id: String(o.recipient.id) }),
      quoteId: String(o.quoteId),
      reservationId: String(o.reservationId),
      productId: String(o.productId),
      currency: cur.currency,
      amountMinor: amt.amountMinor,
      quoteKind: String(o.quoteKind),
      transactionType: tx.type,
      fulfillment: String(o.fulfillment),
      settlementPrimitive: prim.primitive,
      settledAssetKind: o.settledAssetKind == null ? null : String(o.settledAssetKind),
      settledQuantity: o.settledQuantity,
      settledUnitName: o.settledUnitName == null ? null : String(o.settledUnitName),
      ledgerTransactionId: o.ledgerTransactionId == null ? null : String(o.ledgerTransactionId),
      status: String(o.status),
      revision: o.revision,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      completedAt: o.completedAt == null ? null : o.completedAt,
      amountSource: PURCHASE_AMOUNT_SOURCE,
      settlementIsOneTransaction: PURCHASE_SETTLEMENT_IS_ONE_TRANSACTION,
      rewritesHistoricalQuotes: PURCHASE_REWRITES_HISTORICAL_QUOTES,
      hasRefund: PURCHASE_HAS_REFUND
    };
    return { ok: true, errors: [], snapshot: snapshot };
  }

  /* ── 载入期自检 ───────────────────────────────────────────────────────
     这一节的映射表如果漏了一项，症状是"某种商品永远买不成"，而那会在
     很久以后才被发现。因此载入即查（与 §21 的目录自检同款）。 */
  (function () {
    function die(msg) { throw new Error('P22-6 purchase contract ' + msg); }
    for (var i = 0; i < FULFILLMENTS.length; i++) {
      var f = FULFILLMENTS[i];
      if (!Object.prototype.hasOwnProperty.call(SETTLEMENT_PRIMITIVE_OF_FULFILLMENT, f)) {
        die('settlement primitive table must cover every fulfillment; missing=[' + f + ']');
      }
      var got = SETTLEMENT_PRIMITIVE_OF_FULFILLMENT[f];
      if (got != null && SETTLEMENT_PRIMITIVES.indexOf(got) < 0) {
        die('settlement primitive must be null or a registered primitive: ' + f + ' -> ' + String(got));
      }
    }
    /* 每个 product kind 都必须有一条可推导的路径。SERVICE 是唯一一条
       指向 null 的路径，而且它必须**恰好**是 null（"还做不到"），不是
       未登记（"不知道"）。 */
    var unsupported = [];
    for (var k = 0; k < PRODUCT_KINDS.length; k++) {
      var kind = PRODUCT_KINDS[k];
      var ff = fulfillmentOfProductKind(kind);
      if (!isFulfillment(ff)) die('product kind has no fulfillment: ' + kind);
      var p = settlementPrimitiveOfFulfillment(ff);
      if (!p.ok) die('product kind fulfillment has no settlement primitive: ' + kind + ' -> ' + String(ff));
      if (p.primitive == null) unsupported.push(kind);
      if (unitNameOfProductKind(kind) == null) die('product kind has no unit name: ' + kind);
      if (!Object.prototype.hasOwnProperty.call(FULFILLMENT_OF_PRODUCT_KIND, kind)) {
        die('product kind is missing from the fulfillment table: ' + kind);
      }
    }
    if (unsupported.length !== 1 || unsupported[0] !== PRODUCT_KIND.SERVICE) {
      die('exactly one product kind must be unsupported at settlement and it must be SERVICE; got=[' + unsupported.join(',') + ']');
    }
    /* 三个 quote kind 必须各自映射到一个 frozen TX_TYPE，且映射表里
       不能出现任何未登记的 kind。 */
    for (var q = 0; q < QUOTE_KINDS.length; q++) {
      var qk = QUOTE_KINDS[q];
      if (!Object.prototype.hasOwnProperty.call(TX_TYPE_OF_QUOTE_KIND, qk)) {
        die('quote kind has no ledger transaction type: ' + qk);
      }
      if (TX_TYPES.indexOf(TX_TYPE_OF_QUOTE_KIND[qk]) < 0) {
        die('quote kind maps to a transaction type outside the frozen set: ' + qk);
      }
      var cp = settlementCounterpartyFor(qk);
      if (!cp.ok || SYSTEM_ACCOUNTS.indexOf(cp.accountId) < 0) {
        die('quote kind has no whitelisted settlement counterparty: ' + qk);
      }
    }
    /* 终态集合必须**恰好**是三个，且 RESERVED 不是其中之一。少一个
       意味着某个终局无法表达，多一个意味着某个终态有出边。 */
    if (PURCHASE_TERMINAL_STATES.length !== 3 || isPurchaseState(PURCHASE_INITIAL_STATE) !== true) {
      die('purchase terminal states must be exactly three and the initial state must be registered');
    }
    if (PURCHASE_TERMINAL_STATES.indexOf(PURCHASE_INITIAL_STATE) >= 0) {
      die('the initial purchase state must not be terminal');
    }
    /* settle 的输入名单里**不得**出现任何可篡改的经济字段（§40/§41）。 */
    for (var s = 0; s < PURCHASE_SETTLE_INPUT_KEYS.length; s++) {
      if (isForbiddenPurchaseFieldName(PURCHASE_SETTLE_INPUT_KEYS[s])) {
        die('settle input keys must not contain a tamperable economic field: ' + PURCHASE_SETTLE_INPUT_KEYS[s]);
      }
    }
    /* ── P22-7 的载入期不变量 ────────────────────────────────────────────
       ① APPROVAL_STATE 的终态必须**恰好**是三个（REJECTED / EXPIRED /
          CONSUMED），且 PENDING 与 APPROVED 都不是终态。少一个意味着某个
          终局无法表达；多一个意味着"一个批准还能再动"在结构上成立。
       ② 自主策略的三个结论与预算决策的三个词必须**各自独立**：它们的
          字面值恰好相同是刻意设计的（语义同形），但两个数组不能是同一个
          对象 —— 那会让"改一个就改了另一个"。
       ③ 自主策略的默认结论必须是 REQUIRE_APPROVAL。一条把"没有策略"
          读成 AUTO_ALLOW 的系统，会在配置丢失的那一刻变成"什么都能自己买"。 */
    if (APPROVAL_TERMINAL_STATES.length !== 3) {
      die('approval terminal states must be exactly three; got=[' + APPROVAL_TERMINAL_STATES.join(',') + ']');
    }
    if (isApprovalTerminalState(APPROVAL_STATE.PENDING) || isApprovalTerminalState(APPROVAL_STATE.APPROVED)) {
      die('PENDING and APPROVED must not be terminal approval states');
    }
    if (AP_DECISIONS.length !== 3 || AP_DECISIONS === BUDGET_DECISIONS) {
      die('the autonomy decision set must be its own closed set of exactly three words');
    }
    /* ★ 两个词表**刻意不是**逐字相同的，而这一条正是它们的差别所在：
       Budget 说 ALLOW（"这笔钱花得起"），Autonomy 说 AUTO_ALLOW
       （"这台 Agent 有权不问用户直接花"）。它们共享 DENY 与
       REQUIRE_APPROVAL 两个词（那两句话在两层上的含义逐字一样），
       但"允许"那个词必须不同族 —— 若两层都叫 ALLOW，审计里
       "为什么这笔购买了" 就会有两个都叫 ALLOW 的答案。 */
    for (var ad = 0; ad < AP_DECISIONS.length; ad++) {
      var word = AP_DECISIONS[ad];
      if (word === AP_DECISION.AUTO_ALLOW) {
        if (BUDGET_DECISIONS.indexOf(word) >= 0) {
          die('the autonomous allowance must not reuse the budget allowance word: ' + word);
        }
        continue;
      }
      if (BUDGET_DECISIONS.indexOf(word) < 0) {
        die('autonomy decisions must share the budget words for deny and require-approval: ' + word);
      }
    }
    if (AP_DECISION.DENY !== BUDGET_DECISION.DENY || AP_DECISION.REQUIRE_APPROVAL !== BUDGET_DECISION.REQUIRE_APPROVAL) {
      die('DENY and REQUIRE_APPROVAL must be the same word in both decision sets');
    }
    if (AUTONOMY_DEFAULT_WHEN_NO_POLICY !== AP_DECISION.REQUIRE_APPROVAL) {
      die('a missing autonomy policy must default to REQUIRE_APPROVAL, never to AUTO_ALLOW');
    }
    if (APPROVAL_IS_SINGLE_USE !== true || APPROVAL_BYPASSES_BUDGET !== false ||
      APPROVAL_BYPASSES_QUOTE_EXPIRY !== false) {
      die('an approval must be single-use and must never bypass budget or quote expiry');
    }
    if (AUTONOMY_POLICY_IS_A_DECISION_LAYER !== false || AUTONOMY_POLICY_GRANTS_BUDGET !== false) {
      die('the autonomy policy is a permission layer, not a decision layer, and it never grants budget');
    }
    /* 自主策略的输入白名单里**不得**出现任何正文 / 关系 / 模型输出类键
       （§2 的"禁止输入"清单）。这一条放在载入期，于是"某天有人加了
       relationship 字段"会在 require 的那一刻就炸，而不是等到审计时。 */
    for (var ak = 0; ak < AUTONOMY_POLICY_INPUT_KEYS.length; ak++) {
      if (AUTONOMY_FORBIDDEN_INDEX[AUTONOMY_POLICY_INPUT_KEYS[ak]] === true) {
        die('autonomy input keys must not carry non-deterministic text: ' + AUTONOMY_POLICY_INPUT_KEYS[ak]);
      }
    }
    /* 九条绑定事实必须**恰好**覆盖 §6 点名的那九个，一条不少也一条不多。 */
    if (APPROVAL_BINDING_KEYS.length !== 9) {
      die('an approval must bind exactly nine economic facts; got=' + APPROVAL_BINDING_KEYS.length);
    }
  })();

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
    QUOTE_STATE_INDEX: QUOTE_STATE_INDEX,
    QUOTE_TRANSITIONS: QUOTE_TRANSITIONS,
    QUOTE_TERMINAL_STATES: QUOTE_TERMINAL_STATES,
    isQuoteState: isQuoteState,
    canTransitionQuote: canTransitionQuote,
    assertQuoteTransition: assertQuoteTransition,
    QUOTE_KIND: QUOTE_KIND,
    QUOTE_KINDS: QUOTE_KINDS,
    isQuoteKind: isQuoteKind,
    QUOTE_SETTLEMENT_TYPE: QUOTE_SETTLEMENT_TYPE,
    settlementTypeOfQuoteKind: settlementTypeOfQuoteKind,
    validateQuote: validateQuote,
    /* §14b（P22-4）：确定性预算评估 */
    BUDGET_SPEND_CLASS: BUDGET_SPEND_CLASS,
    BUDGET_SPENDING_TYPES: BUDGET_SPENDING_TYPES,
    BUDGET_NEUTRAL_TYPES: BUDGET_NEUTRAL_TYPES,
    spendClassOfTransactionType: spendClassOfTransactionType,
    isSpendingTransactionType: isSpendingTransactionType,
    BUDGET_WINDOW: BUDGET_WINDOW,
    BUDGET_WINDOWS: BUDGET_WINDOWS,
    BUDGET_TIMEZONE: BUDGET_TIMEZONE,
    MS_PER_DAY: MS_PER_DAY,
    utcDayStart: utcDayStart,
    utcWeekStart: utcWeekStart,
    utcMonthStart: utcMonthStart,
    budgetWindowStart: budgetWindowStart,
    POLICY_STATUS: POLICY_STATUS,
    POLICY_STATUSES: POLICY_STATUSES,
    POLICY_TERM: POLICY_TERM,
    POLICY_TERMS: POLICY_TERMS,
    isPolicyStatus: isPolicyStatus,
    policyIsEffectiveAt: policyIsEffectiveAt,
    POLICY_LIMIT_TABLE: POLICY_LIMIT_TABLE,
    POLICY_LIMIT_NAMES: POLICY_LIMIT_NAMES,
    BUDGET_WINDOW_RULES: BUDGET_WINDOW_RULES,
    BUDGET_USAGE_WINDOW_KEYS: BUDGET_USAGE_WINDOW_KEYS,
    BUDGET_DECISION: BUDGET_DECISION,
    BUDGET_DECISIONS: BUDGET_DECISIONS,
    BUDGET_ALLOWED_REASON: BUDGET_ALLOWED_REASON,
    BUDGET_EVALUATION_PRIORITY: BUDGET_EVALUATION_PRIORITY,
    normalizePolicyLimits: normalizePolicyLimits,
    validateBudgetPolicy: validateBudgetPolicy,
    partyRefEquals: partyRefEquals,
    evaluateBudget: evaluateBudget,
    budgetDecision: budgetDecision,
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
    isRealCommerceKey: isRealCommerceKey,
    /* §22（P22-5）：Store / Product / Inventory */
    STORE_STATUS: STORE_STATUS,
    STORE_STATUSES: STORE_STATUSES,
    isStoreStatus: isStoreStatus,
    PRODUCT_STATUS: PRODUCT_STATUS,
    PRODUCT_STATUSES: PRODUCT_STATUSES,
    PRODUCT_STATUS_TRANSITIONS: PRODUCT_STATUS_TRANSITIONS,
    PRODUCT_TERMINAL_STATUSES: PRODUCT_TERMINAL_STATUSES,
    isProductStatus: isProductStatus,
    canTransitionProductStatus: canTransitionProductStatus,
    assertProductStatusTransition: assertProductStatusTransition,
    PRODUCT_KIND: PRODUCT_KIND,
    PRODUCT_KINDS: PRODUCT_KINDS,
    isProductKind: isProductKind,
    FULFILLMENT: FULFILLMENT,
    FULFILLMENTS: FULFILLMENTS,
    isFulfillment: isFulfillment,
    FULFILLMENT_OF_PRODUCT_KIND: FULFILLMENT_OF_PRODUCT_KIND,
    fulfillmentOfProductKind: fulfillmentOfProductKind,
    ASSET_KIND: ASSET_KIND,
    ASSET_KINDS: ASSET_KINDS,
    ASSET_KIND_OF_PRODUCT_KIND: ASSET_KIND_OF_PRODUCT_KIND,
    assetKindOfProductKind: assetKindOfProductKind,
    INVENTORY_CANONICAL_KEY: INVENTORY_CANONICAL_KEY,
    INVENTORY_UNIQUE_ITEMS_MODELLED: INVENTORY_UNIQUE_ITEMS_MODELLED,
    isAssetKind: isAssetKind,
    isUnitName: isUnitName,
    PRODUCT_UNIT_NAME: PRODUCT_UNIT_NAME,
    unitNameOfProductKind: unitNameOfProductKind,
    PRODUCT_INPUT_KEYS: PRODUCT_INPUT_KEYS,
    STORE_INPUT_KEYS: STORE_INPUT_KEYS,
    FORBIDDEN_PRODUCT_FIELDS: FORBIDDEN_PRODUCT_FIELDS,
    isForbiddenProductFieldName: isForbiddenProductFieldName,
    PRICING_IS_RELATIONSHIP_FREE: PRICING_IS_RELATIONSHIP_FREE,
    PRODUCT_NAME_MAX: PRODUCT_NAME_MAX,
    PRODUCT_DESCRIPTION_MAX: PRODUCT_DESCRIPTION_MAX,
    STORE_NAME_MAX: STORE_NAME_MAX,
    STORE_DESCRIPTION_MAX: STORE_DESCRIPTION_MAX,
    validateStore: validateStore,
    validateProduct: validateProduct,
    productQuoteKindFor: productQuoteKindFor,
    productQuoteQuantity: productQuoteQuantity,
    productQuoteAmountMinor: productQuoteAmountMinor,
    QUOTE_PRODUCT_RELATION: QUOTE_PRODUCT_RELATION,
    PRODUCT_IS_PROVENANCE_FOR_QUOTES: PRODUCT_IS_PROVENANCE_FOR_QUOTES,

    /* ── P22-6 · Purchase Orchestrator + Atomic Settlement ─────────────── */
    PURCHASE_STATE: PURCHASE_STATE,
    PURCHASE_STATES: PURCHASE_STATES,
    PURCHASE_TRANSITIONS: PURCHASE_TRANSITIONS,
    PURCHASE_TERMINAL_STATES: PURCHASE_TERMINAL_STATES,
    isPurchaseState: isPurchaseState,
    canTransitionPurchase: canTransitionPurchase,
    assertPurchaseTransition: assertPurchaseTransition,
    PURCHASE_INITIAL_STATE: PURCHASE_INITIAL_STATE,
    PURCHASE_ID_KIND: PURCHASE_ID_KIND,
    PURCHASE_ID_PREFIX: PURCHASE_ID_PREFIX,
    PURCHASE_INPUT_KEYS: PURCHASE_INPUT_KEYS,
    PURCHASE_SETTLE_INPUT_KEYS: PURCHASE_SETTLE_INPUT_KEYS,
    PURCHASE_CANCEL_INPUT_KEYS: PURCHASE_CANCEL_INPUT_KEYS,
    PURCHASE_FORBIDDEN_FIELDS: PURCHASE_FORBIDDEN_FIELDS,
    isForbiddenPurchaseFieldName: isForbiddenPurchaseFieldName,
    PURCHASE_SUMMARY_KEYS: PURCHASE_SUMMARY_KEYS,
    PURCHASE_LIST_KEYS: PURCHASE_LIST_KEYS,
    SETTLEMENT_PRIMITIVE: SETTLEMENT_PRIMITIVE,
    SETTLEMENT_PRIMITIVES: SETTLEMENT_PRIMITIVES,
    SETTLEMENT_PRIMITIVE_OF_FULFILLMENT: SETTLEMENT_PRIMITIVE_OF_FULFILLMENT,
    settlementPrimitiveOfFulfillment: settlementPrimitiveOfFulfillment,
    TX_TYPE_OF_QUOTE_KIND: TX_TYPE_OF_QUOTE_KIND,
    transactionTypeOfQuoteKind: transactionTypeOfQuoteKind,
    PURCHASE_AMOUNT_SOURCE: PURCHASE_AMOUNT_SOURCE,
    PURCHASE_QUOTE_RELATION: PURCHASE_QUOTE_RELATION,
    PURCHASE_PREPARE_REQUIRES_BUDGET_ALLOW: PURCHASE_PREPARE_REQUIRES_BUDGET_ALLOW,
    PURCHASE_SETTLE_REVALIDATES_BUDGET: PURCHASE_SETTLE_REVALIDATES_BUDGET,
    PURCHASE_REWRITES_HISTORICAL_QUOTES: PURCHASE_REWRITES_HISTORICAL_QUOTES,
    PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND: PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND,
    PURCHASE_CANCEL_CANCELS_THE_QUOTE: PURCHASE_CANCEL_CANCELS_THE_QUOTE,
    PURCHASE_SETTLEMENT_IS_ONE_TRANSACTION: PURCHASE_SETTLEMENT_IS_ONE_TRANSACTION,
    PURCHASE_HAS_REFUND: PURCHASE_HAS_REFUND,
    PURCHASE_QUOTE_CONSUMPTION_IS_PARTIAL: PURCHASE_QUOTE_CONSUMPTION_IS_PARTIAL,
    PURCHASE_HAS_CART_QUANTITY: PURCHASE_HAS_CART_QUANTITY,
    PURCHASE_CREATES_PENDING_APPROVAL_RECORDS: PURCHASE_CREATES_PENDING_APPROVAL_RECORDS,
    PURCHASE_EXPOSES_HTTP_MUTATION: PURCHASE_EXPOSES_HTTP_MUTATION,
    PURCHASE_SETTLEMENT_MAY_READ_MUTABLE_PRODUCT_FIELDS: PURCHASE_SETTLEMENT_MAY_READ_MUTABLE_PRODUCT_FIELDS,
    PURCHASE_TOUCHES_PROVIDER: PURCHASE_TOUCHES_PROVIDER,
    PURCHASE_TOUCHES_PAYMENT: PURCHASE_TOUCHES_PAYMENT,
    PURCHASE_TOUCHES_MEMORY: PURCHASE_TOUCHES_MEMORY,
    PURCHASE_TOUCHES_RELATIONSHIP: PURCHASE_TOUCHES_RELATIONSHIP,
    FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS: FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS,
    validatePurchase: validatePurchase,
    settlementCounterpartyFor: settlementCounterpartyFor,
    derivePurchaseLedgerTransactionId: derivePurchaseLedgerTransactionId,
    /* ══ P22-7 §23 · Approval + Autonomous Purchase Policy ══════════════ */
    APPROVAL_STATE: APPROVAL_STATE,
    APPROVAL_STATES: APPROVAL_STATES,
    APPROVAL_TRANSITIONS: APPROVAL_TRANSITIONS,
    APPROVAL_TERMINAL_STATES: APPROVAL_TERMINAL_STATES,
    APPROVAL_INITIAL_STATE: APPROVAL_INITIAL_STATE,
    isApprovalState: isApprovalState,
    isApprovalTerminalState: isApprovalTerminalState,
    canTransitionApproval: canTransitionApproval,
    assertApprovalTransition: assertApprovalTransition,
    AP_DECISION: AP_DECISION,
    AP_DECISIONS: AP_DECISIONS,
    AP_EVALUATION_PRIORITY: AP_EVALUATION_PRIORITY,
    AUTONOMY_POLICY_INPUT_KEYS: AUTONOMY_POLICY_INPUT_KEYS,
    AUTONOMY_POLICY_KEYS: AUTONOMY_POLICY_KEYS,
    AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS: AUTONOMY_POLICY_FORBIDDEN_INPUT_KEYS,
    APPROVAL_BINDING_KEYS: APPROVAL_BINDING_KEYS,
    APPROVAL_MAX_LIFETIME_MS: APPROVAL_MAX_LIFETIME_MS,
    normalizeAutonomyPolicyInput: normalizeAutonomyPolicyInput,
    validateAutonomyPolicy: validateAutonomyPolicy,
    evaluateAutonomousPurchase: evaluateAutonomousPurchase,
    apDecision: apDecision,
    approvalFingerprint: approvalFingerprint,
    validateApproval: validateApproval,
    PURCHASE_APPROVAL_MODE: PURCHASE_APPROVAL_MODE,
    PURCHASE_APPROVAL_MODES: PURCHASE_APPROVAL_MODES,
    isPurchaseApprovalMode: isPurchaseApprovalMode,
    AUTONOMY_POLICY_IS_A_DECISION_LAYER: AUTONOMY_POLICY_IS_A_DECISION_LAYER,
    AUTONOMY_POLICY_READS_LLM_OUTPUT: AUTONOMY_POLICY_READS_LLM_OUTPUT,
    AUTONOMY_POLICY_READS_MEMORY: AUTONOMY_POLICY_READS_MEMORY,
    AUTONOMY_POLICY_READS_RELATIONSHIP: AUTONOMY_POLICY_READS_RELATIONSHIP,
    AUTONOMY_POLICY_GRANTS_BUDGET: AUTONOMY_POLICY_GRANTS_BUDGET,
    AUTONOMY_REPLACES_BUDGET: AUTONOMY_REPLACES_BUDGET,
    APPROVAL_BYPASSES_BUDGET: APPROVAL_BYPASSES_BUDGET,
    APPROVAL_BYPASSES_QUOTE_EXPIRY: APPROVAL_BYPASSES_QUOTE_EXPIRY,
    APPROVAL_IS_SINGLE_USE: APPROVAL_IS_SINGLE_USE,
    APPROVAL_IS_BOUND_TO_A_QUOTE: APPROVAL_IS_BOUND_TO_A_QUOTE,
    AUTONOMY_DEFAULT_WHEN_NO_POLICY: AUTONOMY_DEFAULT_WHEN_NO_POLICY,
    formatPurchaseId: formatPurchaseId
  });
});
