'use strict';
/* ====================================================================
   P22-1 · Agent Economy 领域契约测试（static，零依赖，不开浏览器）
   --------------------------------------------------------------------
   运行：node tests/test_p22_1_economy_domain_contract.js

   本文件锁住 **契约本身**（services/home-node/economy-contract.js）：
   一个数、一个 id、一个状态、一个事件到底是什么。它不碰 SQLite、
   不碰 store、不碰 HTTP —— 那些属于 P22-2 之后。

   为什么这些断言值得写（P22-0 的三条风险各有其落点）：
     · R2（真实购物已有 maxBudget，单位=元）→ D-BUDGET 组 + D-COLLIDE 组
     · R5（cold/hydrate 被当成零余额）      → D-WALLET 组
     · R1（Economy → Provider Billing 写路径）→ D-CURRENCY / D-COMPUTE / D-EFFECT
   边界（依赖、manifest、反向边）在 test_p22_1_economy_boundary.js，刻意分开：
   "契约说了什么"与"生产代码有没有照做"是两个不同的问题，混在一个文件里
   会让失败信息无法区分。

   纯静态分析 + 纯函数调用。不联网、不写盘、不启动服务、不读时钟。
   ==================================================================== */

const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT_PATH = path.join(ROOT, 'services', 'home-node', 'economy-contract.js');
const C = require(CONTRACT_PATH);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('✔ ' + name);
  else {
    failures++;
    console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  }
}
function section(title) { console.log('\n── ' + title); }

/* 断言 helper：期望校验通过 / 失败，且失败原因里含某个稳定串。 */
function okResult(r) { return !!r && r.ok === true; }
function errorsOf(r) { return (r && Array.isArray(r.errors)) ? r.errors : []; }
function hasError(r, needle) { return errorsOf(r).some(e => String(e).indexOf(needle) >= 0); }

console.log('P22-1 · Agent Economy domain contract');

/* ══════════════════════════════════════════════════════════════════
   D-DOMAIN · 域标记
   ══════════════════════════════════════════════════════════════════ */
section('D-DOMAIN · 域标记（P22 §1：跨模块载荷必须能判断归属）');

check('D1.1 DOMAIN 常量是 ib.economy', C.DOMAIN === 'ib.economy', C.DOMAIN);
check('D1.2 缺域标记被拒绝', !okResult(C.validateEconomyDomain(undefined)) &&
  hasError(C.validateEconomyDomain(undefined), 'missing-economy-domain'));
check('D1.3 伪造域标记被拒绝', !okResult(C.validateEconomyDomain('ib.payment')) &&
  !okResult(C.validateEconomyDomain('economy')) && !okResult(C.validateEconomyDomain('')));
check('D1.4 正确域标记被接受', okResult(C.validateEconomyDomain('ib.economy')));
check('D1.5 子命名空间全部以 ib.economy. 开头', Object.keys(C.NAMESPACES).every(
  k => String(C.NAMESPACES[k]).indexOf('ib.economy.') === 0));

/* ══════════════════════════════════════════════════════════════════
   D-CURRENCY · Currency（P22 §2 + §23 Currency 组）
   ══════════════════════════════════════════════════════════════════ */
section('D-CURRENCY · 币种（accept internal / reject real money & provider balance）');

const INTERNAL_CURRENCIES = ['IB_CREDIT', 'ACTIVITY_POINT', 'COMPUTE_STANDARD', 'COMPUTE_PREMIUM', 'IMAGE_CREDIT', 'VOICE_CREDIT'];

check('D2.1 六个内部虚拟资源全部被接受', INTERNAL_CURRENCIES.every(
  c => okResult(C.validateCurrency(c))), INTERNAL_CURRENCIES.filter(c => !okResult(C.validateCurrency(c))));
check('D2.2 注册表与接受清单一致（没有多也没有少）',
  C.CURRENCIES.slice().sort().join(',') === INTERNAL_CURRENCIES.slice().sort().join(','), C.CURRENCIES);
check('D2.3 法币被拒绝（USD/CNY/RMB/EUR/GBP/JPY）',
  ['USD', 'CNY', 'RMB', 'EUR', 'GBP', 'JPY'].every(c => !okResult(C.validateCurrency(c))));
check('D2.4 法币小写与混合写也被拒绝（usd/Usd/rmb）',
  ['usd', 'Usd', 'rmb', 'cny'].every(c => !okResult(C.validateCurrency(c))));
check('D2.5 货币符号不能成为 canonical currency', ['$', '¥', '￥', '€', '£'].every(
  c => !okResult(C.validateCurrency(c))));
check('D2.6 provider 余额/额度不能成为 currency',
  ['PROVIDER_BALANCE', 'PROVIDER_CREDITS', 'OPENAI_BALANCE', 'ANTHROPIC_BALANCE',
    'DEEPSEEK_BALANCE', 'QWEN_BALANCE', 'API_CREDITS'].every(c => !okResult(C.validateCurrency(c))));
check('D2.7 USDT/BTC/ETH 等加密货币被拒绝',
  ['USDT', 'USDC', 'BTC', 'ETH'].every(c => !okResult(C.validateCurrency(c))));
check('D2.8 provider 上报的 token 不是 currency（tokens/TOKENS/VIRTUAL_TOKEN）',
  ['tokens', 'TOKENS', 'VIRTUAL_TOKEN', 'virtualToken'].every(c => !okResult(C.validateCurrency(c))));
check('D2.9 非 canonical 形态被拒绝（小写/空格/连字符/空串/带符号）',
  ['ib_credit', 'IB CREDIT', 'IB-Credit', '', '  ', ' IB_CREDIT', 'IB_CREDIT '].every(
    c => !okResult(C.validateCurrency(c))));
check('D2.10 未注册但形态合法的大写 id 被拒绝（不是"未知即通过"）',
  !okResult(C.validateCurrency('GOLD_COIN')) && hasError(C.validateCurrency('GOLD_COIN'), 'currency-not-registered'));
check('D2.11 拒绝原因是**先否认、再白名单**（USD 报的是 forbidden 而不是 not-registered）',
  hasError(C.validateCurrency('USD'), 'currency-forbidden') &&
  !hasError(C.validateCurrency('USD'), 'currency-not-registered'));
check('D2.12 非法类型被拒绝（null/undefined/number/object/array）',
  [null, undefined, 0, 1.5, {}, [], true].every(c => !okResult(C.validateCurrency(c))));
check('D2.13 scale 是**币种自身**属性：IB_CREDIT=100、COMPUTE_*=1',
  C.scaleOf('IB_CREDIT') === 100 && C.scaleOf('ACTIVITY_POINT') === 100 &&
  C.scaleOf('COMPUTE_STANDARD') === 1 && C.scaleOf('COMPUTE_PREMIUM') === 1 &&
  C.scaleOf('IMAGE_CREDIT') === 1 && C.scaleOf('VOICE_CREDIT') === 1);
check('D2.14 每个 currency 都有 scale 与 display，且 display 不等于 id',
  C.CURRENCIES.every(c => Number.isInteger(C.CURRENCY_SCALE[c]) && C.CURRENCY_DISPLAY[c] &&
    C.CURRENCY_DISPLAY[c] !== c));
check('D2.15 currency 的否认是**精确匹配**：' +
  'u-s-d 不是 USD，因此它按"未注册"被拒绝（而不是被模糊映射成 USD）',
  C.isForbiddenCurrencyToken('USD') === true && C.isForbiddenCurrencyToken('usd') === true &&
  C.isForbiddenCurrencyToken('u-s-d') === false &&
  !okResult(C.validateCurrency('u-s-d')) &&
  hasError(C.validateCurrency('u-s-d'), 'currency-not-canonical'));
check('D2.16 含空白的 currency token 被否认（"U S D" 不应被当成一个新 id）',
  C.isForbiddenCurrencyToken('U S D') === true && C.isForbiddenCurrencyToken('US D') === true &&
  !okResult(C.validateCurrency('U S D')));

/* ══════════════════════════════════════════════════════════════════
   D-AMOUNT · Monetary representation（P22 §3 + §23 Amount 组）
   ══════════════════════════════════════════════════════════════════ */
section('D-AMOUNT · 数值表示（integer only / no NaN / no Infinity / no unsafe / no negative）');

check('D3.1 runtime 表示是 BigInt（不是 number、不是 string）',
  C.AMOUNT_RUNTIME_TYPE === 'bigint' && typeof C.normalizeAmountMinor(5).amountMinor === 'bigint');
check('D3.2 JSON 表示是十进制字符串，且**不是** number',
  C.AMOUNT_SERIALIZED_TYPE === 'decimal-string' && typeof C.serializeAmountMinor(5000) === 'string' &&
  C.serializeAmountMinor(5000) === '5000');
check('D3.3 SQLite 表示声明为 INTEGER', C.AMOUNT_SQLITE_TYPE === 'INTEGER');
check('D3.4 0 是合法的 amount（不是"假值即错误"）',
  okResult(C.normalizeAmountMinor(0)) && C.serializeAmountMinor(0) === '0');
check('D3.5 NaN / Infinity / -Infinity 被拒绝',
  [NaN, Infinity, -Infinity].every(v => !okResult(C.normalizeAmountMinor(v)) &&
    hasError(C.normalizeAmountMinor(v), 'amount-minor-not-finite')));
check('D3.6 小数被拒绝（0.1 / 1.5 / 0.2）',
  [0.1, 1.5, 0.2].every(v => !okResult(C.normalizeAmountMinor(v)) &&
    hasError(C.normalizeAmountMinor(v), 'amount-minor-not-integer')));
check('D3.7 超出安全整数的 number 被拒绝',
  !okResult(C.normalizeAmountMinor(Number.MAX_SAFE_INTEGER + 2)) &&
  hasError(C.normalizeAmountMinor(Number.MAX_SAFE_INTEGER + 2), 'not-safe-integer'));
check('D3.8 负数被拒绝（number 与 BigInt 两种形态）',
  !okResult(C.normalizeAmountMinor(-1)) && !okResult(C.normalizeAmountMinor(-1n)));
check('D3.9 超出上界被拒绝（BigInt 报 overflow；字符串因超出安全整数先报 not-safe-integer）',
  !okResult(C.normalizeAmountMinor(BigInt(C.MAX_AMOUNT_MINOR) + 1n)) &&
  hasError(C.normalizeAmountMinor(BigInt(C.MAX_AMOUNT_MINOR) + 1n), 'overflow') &&
  !okResult(C.normalizeAmountMinor('9007199254740992')) &&
  hasError(C.normalizeAmountMinor('9007199254740992'), 'not-safe-integer'));
check('D3.9b 上界本身是**被接受**的（边界不是 off-by-one）',
  okResult(C.normalizeAmountMinor(C.MAX_AMOUNT_MINOR)) &&
  C.normalizeAmountMinor(C.MAX_AMOUNT_MINOR).amountMinor === BigInt(C.MAX_AMOUNT_MINOR));
check('D3.10 MAX_AMOUNT_MINOR 恰好是 Number.MAX_SAFE_INTEGER（与 SQLite INTEGER 的关系被写明）',
  C.MAX_AMOUNT_MINOR === Number.MAX_SAFE_INTEGER && C.MIN_AMOUNT_MINOR === 0);
check('D3.11 字符串形态拒绝一切"这是别的东西"的写法（表达式 / 浮点 / 负数 / 空串）',
  ['+1', '1.0', '1e3', '0x10', '', '-1', 'abc', '1,000'].every(
    v => !okResult(C.normalizeAmountMinor(v))),
  ['+1', '1.0', '1e3', '0x10', '', '-1', 'abc', '1,000'].filter(v => okResult(C.normalizeAmountMinor(v))));
check('D3.11d 两侧空白被容忍（trim 后是整数即接受，归一成同一个值）',
  okResult(C.normalizeAmountMinor(' 1')) && okResult(C.normalizeAmountMinor('1 ')) &&
  C.normalizeAmountMinor(' 1').amountMinor === C.normalizeAmountMinor('1 ').amountMinor);
check('D3.11b 前导零被接受且无歧义（"01" → 1，而不是被当成另一个数）',
  okResult(C.normalizeAmountMinor('01')) && C.normalizeAmountMinor('01').amountMinor === 1n);
check('D3.11c 字符串虽是整数但超出安全整数时被拒绝（"9007199254740993"）',
  !okResult(C.normalizeAmountMinor('9007199254740993')) &&
  hasError(C.normalizeAmountMinor('9007199254740993'), 'not-safe-integer'));
check('D3.12 字符串形态接受合法值并归一成 BigInt',
  okResult(C.normalizeAmountMinor('5000')) && C.normalizeAmountMinor('5000').amountMinor === 5000n);
check('D3.13 不支持的形态被拒绝（boolean / object / array / function / null / undefined）',
  [true, false, {}, [], function () {}, null, undefined].every(v => !okResult(C.normalizeAmountMinor(v))));
check('D3.14 serialize 对非法输入返回 null（不抛、不静默变 0）',
  C.serializeAmountMinor(-1) === null && C.serializeAmountMinor(NaN) === null &&
  C.serializeAmountMinor('abc') === null);

/* 浮点必须真的不进入 canonical 计算：0.1+0.2 的经典反例。
   这里不是"顺便测一下 JS"，而是把 §3 的存在理由固定成一条断言。 */
const floatTrap = 0.1 + 0.2;
check('D3.15 0.1+0.2 !== 0.3 这一事实被契约挡住（小数无法进入 canonical 表示）',
  floatTrap !== 0.3 && !okResult(C.normalizeAmountMinor(floatTrap)));
check('D3.16 minor unit 相加是精确的（10 + 20 === 30 而不是 0.30000000000000004）',
  C.normalizeAmountMinor(10).amountMinor + C.normalizeAmountMinor(20).amountMinor === 30n);

check('D3.17 展示拆分按 scale 工作（IB_CREDIT 12345 → 123.45）',
  JSON.stringify(C.toDisplayParts(12345, 'IB_CREDIT')) === JSON.stringify({ ok: true, whole: '123', fractionText: '45', scale: 100 }));
check('D3.18 scale=1 的币种展示无小数部分（COMPUTE_PREMIUM 50 → 50）',
  C.toDisplayParts(50, 'COMPUTE_PREMIUM').fractionText === '' &&
  C.toDisplayParts(50, 'COMPUTE_PREMIUM').whole === '50');
check('D3.19 toDisplayParts 对非法输入与未知币种返回 ok:false（不抛）',
  C.toDisplayParts(-1, 'IB_CREDIT').ok === false && C.toDisplayParts(1, 'USD').ok === false);

/* ══════════════════════════════════════════════════════════════════
   D-PARTY · Actor / Owner / Counterparty / Recipient（P22 §8）
   ══════════════════════════════════════════════════════════════════ */
section('D-PARTY · 身份（不得把四种身份都叫 characterId）');

check('D4.1 party type 是封闭集合 {character,user,system}',
  C.PARTY_TYPES.slice().sort().join(',') === 'character,system,user', C.PARTY_TYPES);
check('D4.2 四个身份名各自独立存在，且互不相同',
  C.PARTY_ROLES.length === 4 && new Set(C.PARTY_ROLES).size === 4 &&
  C.PARTY_ROLE.ACTOR === 'actorId' && C.PARTY_ROLE.OWNER === 'ownerId' &&
  C.PARTY_ROLE.COUNTERPARTY === 'counterpartyId' && C.PARTY_ROLE.RECIPIENT === 'recipientId');
check('D4.3 character party 被接受',
  okResult(C.makePartyRef('character', 'cfg_abc')) &&
  C.makePartyRef('character', 'cfg_abc').party.id === 'cfg_abc');
check('D4.4 user party 必须用 canonical id（' + C.USER_PARTY_ID + '）',
  okResult(C.makePartyRef('user', C.USER_PARTY_ID)) &&
  !okResult(C.makePartyRef('user', 'me')) && !okResult(C.makePartyRef('user', 'self')));
check('D4.5 system party 只接受白名单 system account',
  okResult(C.makePartyRef('system', 'system:market')) &&
  !okResult(C.makePartyRef('system', 'system:whatever')) &&
  hasError(C.makePartyRef('system', 'system:whatever'), 'whitelisted'));
check('D4.6 未知 party type 被拒绝（包括 "role" / "agent" / "provider"）',
  ['role', 'agent', 'provider', 'assistant', ''].every(t => !okResult(C.makePartyRef(t, 'x'))));
check('D4.7 空 id 被拒绝',
  [null, undefined, '', '   '].every(v => !okResult(C.makePartyRef('character', v))));
check('D4.8 system account 白名单恰有 mint/burn/treasury/market 四个',
  C.SYSTEM_ACCOUNTS.slice().sort().join(',') === 'system:burn,system:market,system:mint,system:treasury',
  C.SYSTEM_ACCOUNTS);
check('D4.9 运行时不能凭空造 system account（未登记即拒绝）',
  !okResult(C.validateSystemAccountId('system:llm')) &&
  !okResult(C.validateSystemAccountId('system:user')) &&
  okResult(C.validateSystemAccountId('system:mint')));
check('D4.10 isPartyRef 对裸字符串与畸形对象返回 false',
  !C.isPartyRef('character') && !C.isPartyRef('me') && !C.isPartyRef({ type: 'character' }) &&
  !C.isPartyRef(null) && C.isPartyRef({ type: 'character', id: 'x' }));

/* ══════════════════════════════════════════════════════════════════
   D-WALLET · Wallet state（P22 §9 + P22-0 R5）
   ══════════════════════════════════════════════════════════════════ */
section('D-WALLET · 钱包状态（COLD/DEGRADED != zero balance）');

check('D5.1 三态恰好是 COLD/READY/DEGRADED',
  C.WALLET_STATES.slice().sort().join(',') === 'COLD,DEGRADED,READY', C.WALLET_STATES);
check('D5.2 只有 READY 允许花费（COLD 与 DEGRADED 都不允许）',
  C.walletStateAllowsSpend('READY') === true &&
  C.walletStateAllowsSpend('COLD') === false &&
  C.walletStateAllowsSpend('DEGRADED') === false);
check('D5.3 未知状态一律不允许花费（fail closed，不是"未知即通过"）',
  ['', null, undefined, 'ready', 'OK', 'UNKNOWN'].every(s => C.walletStateAllowsSpend(s) === false));

const coldWallet = C.makeWalletView({
  currency: 'IB_CREDIT', state: 'COLD', cachedBalanceMinor: 0, reservedBalanceMinor: 0
});
check('D5.4 COLD 时 available 是 null 而不是 0（R5 的核心断言）',
  okResult(coldWallet) && coldWallet.wallet.availableBalanceMinor === null,
  coldWallet.wallet && coldWallet.wallet.availableBalanceMinor);
check('D5.5 COLD 时 balanceKnown 为 false',
  coldWallet.wallet.balanceKnown === false);

const degradedWallet = C.makeWalletView({
  currency: 'IB_CREDIT', state: 'DEGRADED', cachedBalanceMinor: 9999, reservedBalanceMinor: 0
});
check('D5.6 DEGRADED 时即使有缓存数也不提供 available（缓存不可信）',
  okResult(degradedWallet) && degradedWallet.wallet.availableBalanceMinor === null &&
  degradedWallet.wallet.balanceKnown === false);

const readyWallet = C.makeWalletView({
  currency: 'IB_CREDIT', state: 'READY', cachedBalanceMinor: 10000, reservedBalanceMinor: 2500
});
check('D5.7 READY 时 available = cached − reserved（派生值，不是存储字段）',
  okResult(readyWallet) && readyWallet.wallet.availableBalanceMinor === 7500n,
  readyWallet.wallet && String(readyWallet.wallet.availableBalanceMinor));
check('D5.8 READY 时 balanceKnown 为 true', readyWallet.wallet.balanceKnown === true);
check('D5.9 reserved 超过 cached 被拒绝（不允许负 available 悄悄出现）',
  !okResult(C.makeWalletView({ currency: 'IB_CREDIT', state: 'READY', cachedBalanceMinor: 100, reservedBalanceMinor: 101 })) &&
  hasError(C.makeWalletView({ currency: 'IB_CREDIT', state: 'READY', cachedBalanceMinor: 100, reservedBalanceMinor: 101 }),
    'reserved-exceeds-cached'));
check('D5.10 钱包视图带经济域标记',
  C.makeWalletView({ currency: 'IB_CREDIT', state: 'READY', cachedBalanceMinor: 1, reservedBalanceMinor: 0 })
    .wallet.domain === 'ib.economy');
check('D5.11 非法 state / currency / 金额都被拒绝，且错误**累积**（不是首个即返回）',
  (() => {
    const r = C.makeWalletView({ currency: 'USD', state: 'NOPE', cachedBalanceMinor: -1, reservedBalanceMinor: 0 });
    return !okResult(r) && errorsOf(r).length >= 3;
  })());
check('D5.12 validateWalletState 是封闭集合判定',
  okResult(C.validateWalletState('READY')) && !okResult(C.validateWalletState('ready')) &&
  !okResult(C.validateWalletState(null)));

/* ══════════════════════════════════════════════════════════════════
   D-TXSTATE · Transaction state machine（P22 §10）
   ══════════════════════════════════════════════════════════════════ */
section('D-TXSTATE · 交易状态机（committed 不可回退）');

const S = C.TX_STATE;
check('D6.1 状态集合包含 CREATED/RESERVED/COMMITTED/RELEASED/FAILED/EXPIRED',
  ['CREATED', 'RESERVED', 'COMMITTED', 'RELEASED', 'FAILED', 'EXPIRED'].every(
    s => C.TX_STATES.indexOf(s) >= 0), C.TX_STATES);

const VALID_TRANSITIONS = [
  [S.CREATED, S.RESERVED], [S.CREATED, S.FAILED],
  [S.RESERVED, S.COMMITTED], [S.RESERVED, S.RELEASED], [S.RESERVED, S.EXPIRED], [S.RESERVED, S.FAILED]
];
check('D6.2 全部合法迁移通过',
  VALID_TRANSITIONS.every(([a, b]) => C.canTransitionTransaction(a, b).allowed === true),
  VALID_TRANSITIONS.filter(([a, b]) => !C.canTransitionTransaction(a, b).allowed));

const INVALID_TRANSITIONS = [
  [S.CREATED, S.COMMITTED], [S.CREATED, S.RELEASED], [S.CREATED, S.EXPIRED], [S.CREATED, S.CREATED],
  [S.COMMITTED, S.CREATED], [S.COMMITTED, S.RESERVED], [S.COMMITTED, S.RELEASED],
  [S.COMMITTED, S.FAILED], [S.COMMITTED, S.EXPIRED], [S.COMMITTED, S.COMMITTED],
  [S.RELEASED, S.CREATED], [S.RELEASED, S.RESERVED], [S.RELEASED, S.COMMITTED],
  [S.EXPIRED, S.COMMITTED], [S.EXPIRED, S.CREATED], [S.EXPIRED, S.RESERVED],
  [S.FAILED, S.CREATED], [S.FAILED, S.RESERVED], [S.FAILED, S.COMMITTED]
];
check('D6.3 全部非法迁移失败（含 COMMITTED 的每一条回退）',
  INVALID_TRANSITIONS.every(([a, b]) => C.canTransitionTransaction(a, b).allowed === false),
  INVALID_TRANSITIONS.filter(([a, b]) => C.canTransitionTransaction(a, b).allowed));
check('D6.4 COMMITTED 是终态，且终态集合恰为 {COMMITTED,RELEASED,EXPIRED,FAILED}',
  C.TX_TERMINAL_STATES.slice().sort().join(',') === 'COMMITTED,EXPIRED,FAILED,RELEASED',
  C.TX_TERMINAL_STATES);
check('D6.5 未登记状态被拒绝（不是"未知即允许"）',
  !C.canTransitionTransaction('NOPE', S.RESERVED).ok &&
  !C.canTransitionTransaction(S.CREATED, 'NOPE').ok &&
  !C.canTransitionTransaction(null, undefined).ok);
check('D6.6 未登记状态按 fail closed 处理（allowed === false）',
  C.canTransitionTransaction('NOPE', S.RESERVED).allowed !== true);
check('D6.7 assertTransactionTransition 对终态给出"必须用补偿交易"的明确理由',
  (() => {
    const r = C.assertTransactionTransition(S.COMMITTED, S.RELEASED);
    /* 注意理由在 detail 而不是 errors：errors 是稳定的机器码
       （transition-not-allowed），detail 是"为什么"——两者分开是因为
       前者要被程序判、后者要被人读。 */
    return r.ok === false &&
      String(r.detail) === 'terminal-state-cannot-transition-must-compensate-with-a-new-transaction' &&
      hasError(r, 'transition-not-allowed');
  })());
check('D6.8 assertTransactionTransition 对非终态的非法迁移给出普通理由',
  (() => {
    const r = C.assertTransactionTransition(S.CREATED, S.COMMITTED);
    return r.ok === false && String(r.detail) === 'transition-not-in-allowed-set';
  })());
check('D6.9 交易类型封闭集合存在，且 MINT/BURN 被显式标出',
  C.TX_TYPES.indexOf('PURCHASE') >= 0 && C.TX_TYPES.indexOf('GIFT') >= 0 &&
  C.TX_TYPES.indexOf('EXCHANGE') >= 0 && C.MINT_BURN_TYPES.slice().sort().join(',') === 'BURN,MINT');
check('D6.10 只有 MINT/BURN 免除"双向记账"拓扑（requiresBalanceTopology）',
  C.requiresBalanceTopology('MINT') === false && C.requiresBalanceTopology('BURN') === false &&
  C.requiresBalanceTopology('PURCHASE') === true && C.requiresBalanceTopology('GIFT') === true &&
  C.requiresBalanceTopology('EXCHANGE') === true);

/* ══════════════════════════════════════════════════════════════════
   D-LEDGER · Ledger entry + 平衡规则（P22 §10/§12 + §23 Ledger 组）
   ══════════════════════════════════════════════════════════════════ */
section('D-LEDGER · 复式记账（balanced accepted / unbalanced rejected）');

check('D7.1 只冻结一种表示：DIRECTION + 无符号 amount',
  C.LEDGER_AMOUNT_SIGN === 'unsigned' &&
  C.ENTRY_DIRECTIONS.slice().sort().join(',') === 'CREDIT,DEBIT');
check('D7.2 平衡规则被写成一条可读的字符串（供审计与文档引用）',
  typeof C.LEDGER_BALANCE_RULE === 'string' && C.LEDGER_BALANCE_RULE.indexOf('DEBIT') >= 0 &&
  C.LEDGER_BALANCE_RULE.indexOf('CREDIT') >= 0);

const TX1 = 'econ_tx_' + '0001';
const E1 = 'econ_entry_' + '0001';
const E2 = 'econ_entry_' + '0002';
const WALLET_A = 'econ_account_' + 'w1';
const WALLET_B = 'econ_account_' + 'w2';

const balanced = [
  { ledgerEntryId: E1, transactionId: TX1, accountId: WALLET_A, direction: 'DEBIT', amountMinor: 5000, currency: 'IB_CREDIT' },
  { ledgerEntryId: E2, transactionId: TX1, accountId: 'system:market', direction: 'CREDIT', amountMinor: 5000, currency: 'IB_CREDIT' }
];
check('D7.3 平衡的 transaction 被接受',
  C.checkLedgerBalance(balanced).balanced === true, C.checkLedgerBalance(balanced));
check('D7.4 不平衡的 transaction 被拒绝（50 vs 80）',
  C.checkLedgerBalance([
    { direction: 'DEBIT', amountMinor: 5000, currency: 'IB_CREDIT' },
    { direction: 'CREDIT', amountMinor: 8000, currency: 'IB_CREDIT' }
  ]).balanced === false);
check('D7.5 单边 entry 被拒绝（不允许"只写了一半"看起来像合法交易）',
  (() => {
    const r = C.checkLedgerBalance([{ direction: 'DEBIT', amountMinor: 0, currency: 'IB_CREDIT' }]);
    return r.balanced === false && hasError(r, 'at-least-two-entries');
  })());
check('D7.6 空 entries 被拒绝',
  C.checkLedgerBalance([]).balanced === false && C.checkLedgerBalance(null).balanced === false);
check('D7.7 跨币种**分别**平衡：100 IB_CREDIT + 20 COMPUTE_PREMIUM 不算平衡',
  C.checkLedgerBalance([
    { direction: 'DEBIT', amountMinor: 10000, currency: 'IB_CREDIT' },
    { direction: 'CREDIT', amountMinor: 20, currency: 'COMPUTE_PREMIUM' }
  ]).balanced === false);
check('D7.8 多个币种各自平衡时才整体平衡',
  C.checkLedgerBalance([
    { direction: 'DEBIT', amountMinor: 10000, currency: 'IB_CREDIT' },
    { direction: 'CREDIT', amountMinor: 10000, currency: 'IB_CREDIT' },
    { direction: 'DEBIT', amountMinor: 20, currency: 'COMPUTE_PREMIUM' },
    { direction: 'CREDIT', amountMinor: 20, currency: 'COMPUTE_PREMIUM' }
  ]).balanced === true);
check('D7.9 非法 direction 被拒绝（不是"非 DEBIT 即 CREDIT"）',
  C.checkLedgerBalance([
    { direction: 'DEBIT', amountMinor: 100, currency: 'IB_CREDIT' },
    { direction: 'CREDIT', amountMinor: 100, currency: 'IB_CREDIT' },
    { direction: 'debit', amountMinor: 0, currency: 'IB_CREDIT' }
  ]).balanced === false);
check('D7.10 非法 currency 的 entry 被拒绝（USD entry 无法进入账本）',
  C.checkLedgerBalance([
    { direction: 'DEBIT', amountMinor: 100, currency: 'USD' },
    { direction: 'CREDIT', amountMinor: 100, currency: 'USD' }
  ]).balanced === false);
check('D7.11 非法 amount 的 entry 被拒绝（负数 / 小数）',
  C.checkLedgerBalance([
    { direction: 'DEBIT', amountMinor: -100, currency: 'IB_CREDIT' },
    { direction: 'CREDIT', amountMinor: -100, currency: 'IB_CREDIT' }
  ]).balanced === false);

check('D7.12 makeLedgerEntry 要求 canonical id（entry/tx）',
  okResult(C.makeLedgerEntry({
    ledgerEntryId: E1, transactionId: TX1, accountId: WALLET_A,
    direction: 'DEBIT', amountMinor: 1, currency: 'IB_CREDIT'
  })) &&
  !okResult(C.makeLedgerEntry({
    ledgerEntryId: 'entry1', transactionId: TX1, accountId: WALLET_A,
    direction: 'DEBIT', amountMinor: 1, currency: 'IB_CREDIT'
  })));
check('D7.13 makeLedgerEntry 的 amount 归一成 BigInt，且带域标记',
  (() => {
    const r = C.makeLedgerEntry({
      ledgerEntryId: E1, transactionId: TX1, accountId: WALLET_A,
      direction: 'DEBIT', amountMinor: '1500', currency: 'IB_CREDIT'
    });
    return r.ok && typeof r.entry.amountMinor === 'bigint' && r.entry.amountMinor === 1500n &&
      r.entry.domain === 'ib.economy';
  })());
check('D7.14 makeLedgerEntry 拒绝缺 accountId',
  !okResult(C.makeLedgerEntry({
    ledgerEntryId: E1, transactionId: TX1, direction: 'DEBIT', amountMinor: 1, currency: 'IB_CREDIT'
  })));

/* 账户分层：wallet account 与 system account 是两类记账实体，不得混为一谈 */
check('D8.1 account kind 恰好两类 {WALLET, SYSTEM}',
  C.ACCOUNT_KINDS.slice().sort().join(',') === 'SYSTEM,WALLET');
check('D8.2 system account 被识别为 SYSTEM', C.accountKindOf('system:mint') === 'SYSTEM');
check('D8.3 econ_account_* 被识别为 WALLET', C.accountKindOf(WALLET_A) === 'WALLET');
check('D8.4 裸字符串/法币式 id 不是 account（system:foo / USD / user / characters 的 cfg id 都不行）',
  C.accountKindOf('system:foo') === null && C.accountKindOf('USD') === null &&
  C.accountKindOf('user') === null && C.accountKindOf('cfg_abc') === null &&
  !okResult(C.validateLedgerAccountId('cfg_abc')));

/* ══════════════════════════════════════════════════════════════════
   D-RESERVATION · Reservation（P22 §11）
   ══════════════════════════════════════════════════════════════════ */
section('D-RESERVATION · 预留（reservation != transaction）');

check('D9.1 reservation 状态是封闭集合 {ACTIVE,COMMITTED,RELEASED,EXPIRED}',
  C.RESERVATION_STATES.slice().sort().join(',') === 'ACTIVE,COMMITTED,EXPIRED,RELEASED',
  C.RESERVATION_STATES);
check('D9.2 reserved 对 available 的影响被写成一条明确的派生规则（减法，且仅 READY）',
  typeof C.RESERVATION_AFFECTS === 'string' &&
  C.RESERVATION_AFFECTS.indexOf('cachedBalanceMinor') >= 0 &&
  C.RESERVATION_AFFECTS.indexOf('reservedBalanceMinor') >= 0 &&
  C.RESERVATION_AFFECTS.indexOf('READY') >= 0);
check('D9.3 合法 reservation 被接受（含 idempotencyKey）',
  okResult(C.validateReservation({
    reservationId: 'econ_res_' + 'r1', walletId: 'econ_wallet_' + 'w1', currency: 'IB_CREDIT',
    amountMinor: 3000, idempotencyKey: 'req-1', expiresAt: 1000, status: 'ACTIVE'
  })));
check('D9.4 缺 idempotencyKey 被拒绝（幂等键不是可选项）',
  !okResult(C.validateReservation({
    reservationId: 'econ_res_' + 'r1', walletId: 'econ_wallet_' + 'w1', currency: 'IB_CREDIT',
    amountMinor: 3000, expiresAt: 1000, status: 'ACTIVE'
  })));
check('D9.5 非法 walletId / reservationId 被拒绝',
  !okResult(C.validateReservation({
    reservationId: 'r1', walletId: 'w1', currency: 'IB_CREDIT',
    amountMinor: 1, idempotencyKey: 'k', expiresAt: 1, status: 'ACTIVE'
  })));
check('D9.6 非法 currency 的 reservation 被拒绝',
  !okResult(C.validateReservation({
    reservationId: 'econ_res_' + 'r1', walletId: 'econ_wallet_' + 'w1', currency: 'CNY',
    amountMinor: 1, idempotencyKey: 'k', expiresAt: 1, status: 'ACTIVE'
  })));

/* ══════════════════════════════════════════════════════════════════
   D-OPERATION · P22-3 的加法面（operation 生命周期 + reservation 状态机）
   ══════════════════════════════════════════════════════════════════ */
section('D-OPERATION · operation 生命周期与 reservation 状态机（P22-3 加法面）');

/* 这一段锁的是一件具体的事：P22-3 新增的每一个名字都必须是**加法**，
   而两张冻结词表（TX_STATE / RESERVATION_STATE）一个成员都没变。 */
check('D13.1 （加法性）TX_STATE 与 RESERVATION_STATE 的成员一个都没增删',
  C.TX_STATES.slice().sort().join(',') === 'COMMITTED,CREATED,EXPIRED,FAILED,RELEASED,RESERVED' &&
  C.RESERVATION_STATES.slice().sort().join(',') === 'ACTIVE,COMMITTED,EXPIRED,RELEASED',
  { tx: C.TX_STATES, reservation: C.RESERVATION_STATES });
check('D13.2 reservation 状态机：ACTIVE → {COMMITTED,RELEASED,EXPIRED}，三个终态都没有出边',
  C.RESERVATION_TRANSITIONS.ACTIVE.slice().sort().join(',') === 'COMMITTED,EXPIRED,RELEASED' &&
  C.RESERVATION_TRANSITIONS.COMMITTED.length === 0 &&
  C.RESERVATION_TRANSITIONS.RELEASED.length === 0 &&
  C.RESERVATION_TRANSITIONS.EXPIRED.length === 0);
check('D13.3 RESERVATION_TERMINAL_STATES 恰为 {COMMITTED,RELEASED,EXPIRED}（**没有** FAILED）',
  C.RESERVATION_TERMINAL_STATES.slice().sort().join(',') === 'COMMITTED,EXPIRED,RELEASED',
  C.RESERVATION_TERMINAL_STATES);
check('D13.4 ACTIVE → ACTIVE 被拒绝（同一状态不是一次迁移）',
  C.canTransitionReservation('ACTIVE', 'ACTIVE').allowed === false &&
  C.canTransitionReservation('ACTIVE', 'COMMITTED').allowed === true);
check('D13.5 终态回退被拒绝，且理由是"必须用补偿交易"',
  (() => {
    const r = C.assertReservationTransition('COMMITTED', 'RELEASED');
    return r.ok === false && r.errors.indexOf('transition-not-allowed') >= 0 &&
      String(r.detail).indexOf('compensate') >= 0;
  })());
check('D13.6 未登记状态 fail closed（不是"未知即允许"）',
  C.canTransitionReservation('NOPE', 'ACTIVE').ok === false &&
  C.canTransitionReservation('NOPE', 'ACTIVE').allowed !== true &&
  C.canTransitionReservation('ACTIVE', 'FAILED').allowed === false);

/* operation ↔ reservation 的映射必须是**数据**，而且必须如实承认它不是双射。 */
check('D13.7 RESERVATION_STATE_OF_OPERATION 覆盖全部六个 TX_STATE（一个不少）',
  C.TX_STATES.every(s => Object.prototype.hasOwnProperty.call(C.RESERVATION_STATE_OF_OPERATION, s)) &&
  Object.keys(C.RESERVATION_STATE_OF_OPERATION).length === C.TX_STATES.length);
check('D13.8 CREATED 与 FAILED 映射到 null —— 它们刻意没有属于自己的 reservation 状态',
  C.RESERVATION_STATE_OF_OPERATION.CREATED === null &&
  C.RESERVATION_STATE_OF_OPERATION.FAILED === null);
check('D13.9 两个映射在共同值域上互为逆（RESERVED↔ACTIVE 是唯一的"改名"）',
  ['RESERVED', 'COMMITTED', 'RELEASED', 'EXPIRED'].every(op => {
    const res = C.RESERVATION_STATE_OF_OPERATION[op];
    return res != null && C.OPERATION_STATE_OF_RESERVATION[res] === op;
  }) &&
  C.OPERATION_STATE_OF_RESERVATION.ACTIVE === 'RESERVED' &&
  C.OPERATION_STATE_OF_RESERVATION.COMMITTED === 'COMMITTED');
check('D13.10 OPERATION_STATE_OF_RESERVATION 是**全**映射（reservation 的四个状态都有归属）',
  C.RESERVATION_STATES.every(s => C.TX_STATES.indexOf(C.OPERATION_STATE_OF_RESERVATION[s]) >= 0));

/* validateOperation：与 validateReservation 同款的纯形状校验。 */
check('D13.11 合法 operation 被接受',
  okResult(C.validateOperation({
    operationId: 'econ_op_' + 'o1', walletId: 'econ_wallet_' + 'w1', currency: 'IB_CREDIT',
    amountMinor: 500, idempotencyKey: 'req-1', status: 'RESERVED', expiresAt: 1000
  })));
check('D13.12 operation 的 status 只能是 TX_STATE（ACTIVE **不是** operation 的状态）',
  !okResult(C.validateOperation({
    operationId: 'econ_op_' + 'o1', walletId: 'econ_wallet_' + 'w1', currency: 'IB_CREDIT',
    amountMinor: 1, idempotencyKey: 'k', status: 'ACTIVE'
  })));
check('D13.13 operation 缺 idempotencyKey / 用真实货币 / 形状不对的 id 都被拒绝',
  !okResult(C.validateOperation({ operationId: 'econ_op_o1', walletId: 'econ_wallet_w1', currency: 'IB_CREDIT', amountMinor: 1, status: 'RESERVED' })) &&
  !okResult(C.validateOperation({ operationId: 'econ_op_o1', walletId: 'econ_wallet_w1', currency: 'CNY', amountMinor: 1, idempotencyKey: 'k', status: 'RESERVED' })) &&
  !okResult(C.validateOperation({ operationId: 'econ_tx_o1', walletId: 'econ_wallet_w1', currency: 'IB_CREDIT', amountMinor: 1, idempotencyKey: 'k', status: 'RESERVED' })));
check('D13.14 operation 的 reservationId / transactionId 若给了就必须是 canonical 形状',
  okResult(C.validateOperation({
    operationId: 'econ_op_o1', walletId: 'econ_wallet_w1', currency: 'IB_CREDIT', amountMinor: 1,
    idempotencyKey: 'k', status: 'COMMITTED',
    reservationId: 'econ_res_r1', transactionId: 'econ_tx_t1'
  })) &&
  !okResult(C.validateOperation({
    operationId: 'econ_op_o1', walletId: 'econ_wallet_w1', currency: 'IB_CREDIT', amountMinor: 1,
    idempotencyKey: 'k', status: 'COMMITTED', transactionId: 'pay_123'
  })));

/* idempotency scope：预留与提交不能共用一个模糊键空间（§18）。
   P22-4 把"七个 scope"写进断言：scope 是**封闭集合**，新增一个就必须
   同时改这里 —— 这正是它该有的阻力。P22-4 加的两个（QUOTE / POLICY）
   锁的不是钱，但它们必须与 reserve/commit 一样是**互不混淆**的身份。
   P22-5 又加了四个（STORE / PRODUCT / INVENTORY_GRANT /
   INVENTORY_CONSUME）—— 阻力照旧生效：这一行是**手动**改的，而不是
   被一个 `.length >= 7` 悄悄放过去的。
   P22-7 加四个（APPROVAL_REQUEST / APPROVAL_DECIDE / APPROVAL_CONSUME /
   AUTONOMY_POLICY）—— 理由与前几次同源：一条**批准**的"请求 / 决定 /
   消费"是三次不同的写入，而它们的重试语义各自独立；自主策略的一次变更
   与预算策略的一次变更是两件事。 */
check('D13.15 OPERATION_SCOPE 是封闭十七元集合（P22-1 的五个 + QUOTE/POLICY + P22-5 的四个 + P22-6 的两个 + P22-7 的四个）',
  C.OPERATION_SCOPES.slice().sort().join(',') ===
    'APPROVAL_CONSUME,APPROVAL_DECIDE,APPROVAL_REQUEST,AUTONOMY_POLICY,' +
    'COMMIT,EXPIRE,FAIL,INVENTORY_CONSUME,INVENTORY_GRANT,POLICY,PRODUCT,' +
    'PURCHASE_PREPARE,PURCHASE_SETTLE,QUOTE,RELEASE,RESERVE,STORE' &&
  C.isOperationScope('RESERVE') === true && C.isOperationScope('reserve') === false &&
  C.isOperationScope('QUOTE') === true && C.isOperationScope('POLICY') === true &&
  /* P22-6 的两个 scope 与 P22-3 的 RESERVE/COMMIT **刻意不同**：
     "我那次购买准备成没成"与"我那笔预留成没成"是两个问题，而它们的
     答案在时间上不同（prepare 之后 settle 可能永远不发生）。 */
  C.isOperationScope('PURCHASE_PREPARE') === true && C.isOperationScope('PURCHASE_SETTLE') === true &&
  C.isOperationScope('PURCHASE') === false &&
  /* P22-7 的三个 APPROVAL_* 与 P22-6 的 PURCHASE_* **刻意不同**：
     "我那次请求批准成没成""我那一次决定写下了没有""那张许可证被用掉了
     没有"是三个问题，而它们的答案在时间上依次分离。 */
  C.isOperationScope('APPROVAL_REQUEST') === true &&
  C.isOperationScope('APPROVAL_DECIDE') === true &&
  C.isOperationScope('APPROVAL_CONSUME') === true &&
  C.isOperationScope('APPROVAL') === false &&
  C.isOperationScope('AUTONOMY_POLICY') === true &&
  C.isOperationScope('AUTONOMY') === false &&
  C.isOperationScope('TOPUP') === false);
check('D13.16 scopedIdempotencyIdentity 让同一个 key 在两个 scope 下是**两个**身份',
  C.scopedIdempotencyIdentity('RESERVE', 'X').identity !== C.scopedIdempotencyIdentity('COMMIT', 'X').identity &&
  C.scopedIdempotencyIdentity('RESERVE', 'X').identity === 'RESERVE:X' &&
  C.scopedIdempotencyIdentity('RESERVE', 'X').identity === C.scopedIdempotencyIdentity('RESERVE', 'X').identity);
check('D13.17 数字与字符串 key 归一成同一个身份（类型边界上幂等性不失效）',
  C.scopedIdempotencyIdentity('COMMIT', 12345).identity === C.scopedIdempotencyIdentity('COMMIT', '12345').identity);
check('D13.18 非法 scope / 非法 key 被拒绝',
  !okResult(C.scopedIdempotencyIdentity('NOPE', 'X')) &&
  !okResult(C.scopedIdempotencyIdentity('RESERVE', 'has space')));

/* 拒绝原因：available 不足必须与 balance 不足分开。 */
check('D13.19 INSUFFICIENT_AVAILABLE_BALANCE 已登记，且与 INSUFFICIENT_BALANCE 是两个不同的代码',
  C.DENY_REASONS.indexOf('INSUFFICIENT_AVAILABLE_BALANCE') >= 0 &&
  C.isDenyReasonCode('INSUFFICIENT_AVAILABLE_BALANCE') &&
  C.DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE !== C.DENY_REASON.INSUFFICIENT_BALANCE);
check('D13.20 P22-3 的四个 reservation 事件都在封闭事件集合里（含新增的两个）',
  ['RESERVATION_CREATED', 'RESERVATION_COMMITTED', 'RESERVATION_RELEASED',
    'RESERVATION_EXPIRED', 'RESERVATION_REBUILT', 'OPERATION_FAILED'].every(t => C.isEconomyEventType(t)));
check('D13.21 P22-1 原有的十四个事件一个都没丢（加事件不等于换词表）',
  ['WALLET_OPENED', 'TRANSACTION_CREATED', 'PURCHASE_COMMITTED', 'PURCHASE_DENIED',
    'ITEM_GIFTED', 'ITEM_CONSUMED', 'COMPUTE_CREDIT_GRANTED', 'COMPUTE_CREDIT_CONSUMED',
    'EXCHANGE_COMMITTED', 'MINT_COMMITTED', 'BURN_COMMITTED'].every(t => C.isEconomyEventType(t)));

/* ══════════════════════════════════════════════════════════════════
   D-IDEMPOTENCY · idempotencyKey != transactionId（P22 §7）
   ══════════════════════════════════════════════════════════════════ */
section('D-IDEMPOTENCY · 幂等键与交易 id 是两件事');

check('D10.1 idempotencyKey 规范化成**字符串**（数字 123 与字符串 "123" 是同一个 key）',
  C.normalizeIdempotencyKey(123).key === C.normalizeIdempotencyKey('123').key &&
  typeof C.normalizeIdempotencyKey(123).key === 'string');
check('D10.2 非整数 number 被拒绝（1.5 / NaN / Infinity）',
  !okResult(C.normalizeIdempotencyKey(1.5)) && !okResult(C.normalizeIdempotencyKey(NaN)) &&
  !okResult(C.normalizeIdempotencyKey(Infinity)));
check('D10.3 超长 key 被拒绝（>200）',
  !okResult(C.normalizeIdempotencyKey('k'.repeat(201))));
check('D10.4 空 key / 非字符串非数字被拒绝',
  [null, undefined, '', '   ', {}, [], true].every(v => !okResult(C.normalizeIdempotencyKey(v))));
check('D10.5 特征串允许（uuid / 时间戳串 / 点分）',
  okResult(C.normalizeIdempotencyKey('a1b2-c3d4_e5.f6:g7+h8')));

/* id 形状：前缀、语法、种类 */
/* ── P22-3 把这一条从 12 改成 13（**纯加法**，不是放宽）───────────────
   加的是 ID_PREFIX.OPERATION = 'econ_op_'：P22-3 需要"一次操作"的身份，
   而 econ_tx_（已发生的经济事实，append-only）与 econ_res_（资金锁定，
   词表里没有 FAILED）都无法表示"可能成功、可能失败、可能过期"的操作。
   断言本身的**含义一个字都没改**：种类数、前缀唯一、互不为前缀、
   都以 econ_ 开头。因此这里只是把那个计数跟着契约走。
   为什么仍然要写死数字：`length === 13` 会在"有人悄悄加了第 14 种
   id"时失败 —— 那正是一次需要被看见的契约变更。
   ★ P22-7 加了第 15 种（APPROVAL = econ_approval_）：一条**批准记录**
   与它所授权的那笔购买是两个实体（Approval ≠ Purchase），因此它不能
   复用 PURCHASE_INTENT（econ_intent_，购买自己用掉了），也不能复用
   BUDGET_POLICY（econ_policy_，那是**规则**的身份，而一条批准恰好被
   消费一次）。这一行同样是**手动**改的。 */
check('D11.1 十五种 id 种类各有唯一前缀（P22-3 加 OPERATION，P22-5 加 STORE，P22-7 加 APPROVAL）',
  C.ID_KINDS.length === 15 && new Set(C.ID_KINDS.map(k => C.ID_PREFIX[k])).size === 15, C.ID_KINDS);
check('D11.1c APPROVAL 是 econ_approval_，且它与 PURCHASE_INTENT / BUDGET_POLICY **互不混淆**',
  C.ID_PREFIX.APPROVAL === 'econ_approval_' &&
  C.ID_PREFIX.APPROVAL !== C.ID_PREFIX.PURCHASE_INTENT &&
  C.ID_PREFIX.APPROVAL !== C.ID_PREFIX.BUDGET_POLICY &&
  C.formatEconomyId('APPROVAL', 'a1').id === 'econ_approval_a1' &&
  C.isEconomyId('APPROVAL', 'econ_intent_x') === false &&
  C.isEconomyId('APPROVAL', 'econ_policy_x') === false &&
  C.isEconomyId('PURCHASE_INTENT', 'econ_approval_a1') === false);
check('D11.1b OPERATION 是 econ_op_，且它是**新增**的而不是复用了 transaction / reservation',
  C.ID_PREFIX.OPERATION === 'econ_op_' &&
  C.ID_PREFIX.OPERATION !== C.ID_PREFIX.TRANSACTION &&
  C.ID_PREFIX.OPERATION !== C.ID_PREFIX.RESERVATION &&
  C.formatEconomyId('OPERATION', 'o1').id === 'econ_op_o1' &&
  C.isEconomyId('OPERATION', 'econ_tx_x') === false &&
  C.isEconomyId('TRANSACTION', 'econ_op_o1') === false);
check('D11.2 所有前缀都以 econ_ 开头（看 id 第一眼就知道属于虚拟经济）',
  C.ID_KINDS.every(k => C.ID_PREFIX[k].indexOf('econ_') === 0), C.ID_KINDS.map(k => C.ID_PREFIX[k]));
check('D11.3 前缀互不为彼此的前缀（econ_tx_ 不会误吞 econ_tx_extra_）',
  C.ID_KINDS.every(a => C.ID_KINDS.every(b =>
    a === b || C.ID_PREFIX[b].indexOf(C.ID_PREFIX[a]) !== 0)));
check('D11.4 formatEconomyId 生成正确形状',
  C.formatEconomyId('WALLET', 'w1').id === 'econ_wallet_w1' &&
  C.formatEconomyId('TRANSACTION', 'x').id === 'econ_tx_x' &&
  C.formatEconomyId('PURCHASE_INTENT', 'i1').id === 'econ_intent_i1');
check('D11.5 未知 kind 被拒绝',
  !okResult(C.formatEconomyId('NOPE', 'x')) && !okResult(C.formatEconomyId('', 'x')));
check('D11.5b 合法 suffix 接受大小写数字下划线连字符（与既有 core 的 id 风格一致）',
  okResult(C.formatEconomyId('WALLET', 'A-b_9')) &&
  C.formatEconomyId('WALLET', 'A-b_9').id === 'econ_wallet_A-b_9');
check('D11.6 非法 suffix 被拒绝（空 / 空格 / 点 / 斜杠 / 超长 / 非 ASCII）',
  ['', ' ', 'a b', 'a.b', 'a/b', 'a'.repeat(65), '钱包'].every(s => !okResult(C.formatEconomyId('WALLET', s))));
check('D11.7 isEconomyId 认种类，不跨种类通过',
  C.isEconomyId('WALLET', 'econ_wallet_w1') === true &&
  C.isEconomyId('TRANSACTION', 'econ_wallet_w1') === false &&
  C.isEconomyId('WALLET', 'econ_wallet_') === false);
check('D11.8 真实支付/外部 id 不会通过 Economy id 判定',
  C.isEconomyId('TRANSACTION', 'pay_123') === false &&
  C.isEconomyId('TRANSACTION', 'msg_123') === false &&
  C.isEconomyId('TRANSACTION', 'roleRel_abc') === false &&
  C.isEconomyId('TRANSACTION', '') === false);

/* ══════════════════════════════════════════════════════════════════
   D-APPROVAL · Approval + 封闭 reason code（P22 §15）
   ══════════════════════════════════════════════════════════════════ */
section('D-APPROVAL · 审批三态与封闭 reason code');

check('D12.1 三种审批结果，**不是** true/false',
  C.APPROVALS.slice().sort().join(',') === 'AUTO_APPROVED,DENIED,USER_APPROVAL_REQUIRED', C.APPROVALS);
check('D12.2 AUTO_APPROVED 被接受且无需 reason',
  okResult(C.makeApproval('AUTO_APPROVED', null)));
check('D12.3 USER_APPROVAL_REQUIRED 被接受（可表达"需要用户确认"）',
  okResult(C.makeApproval('USER_APPROVAL_REQUIRED', null)));
check('D12.4 布尔值不被接受为审批结果',
  !okResult(C.makeApproval(true)) && !okResult(C.makeApproval(false)) &&
  !okResult(C.makeApproval('true')));
check('D12.5 DENIED 必须带 reason code',
  !okResult(C.makeApproval('DENIED', null)) && hasError(C.makeApproval('DENIED', null), 'requires-reason-code'));
check('D12.6 DENIED 的 reason code 必须在封闭集合内',
  !okResult(C.makeApproval('DENIED', 'BECAUSE_I_SAID_SO')) &&
  !okResult(C.makeApproval('DENIED', '随便')) &&
  okResult(C.makeApproval('DENIED', 'INSUFFICIENT_BALANCE')));
check('D12.7 没有 OTHER/UNKNOWN 兜底值（兜底会让静默拒绝重新变得可能）',
  C.DENY_REASONS.indexOf('OTHER') < 0 && C.DENY_REASONS.indexOf('UNKNOWN') < 0 &&
  C.DENY_REASONS.indexOf('ERROR') < 0 && !C.isDenyReasonCode('OTHER') &&
  !C.isDenyReasonCode('UNKNOWN'));
check('D12.8 P22 §23 点名的 reason code 全部存在',
  ['INSUFFICIENT_BALANCE', 'PER_TX_LIMIT', 'DAILY_LIMIT', 'WEEKLY_LIMIT', 'CATEGORY_LIMIT',
    'RECIPIENT_LIMIT', 'AUTONOMY_LIMIT', 'EMERGENCY_RESERVE', 'WALLET_NOT_READY',
    'PRODUCT_DISABLED', 'INVALID_CURRENCY'].every(r => C.isDenyReasonCode(r)),
  ['INSUFFICIENT_BALANCE', 'PER_TX_LIMIT', 'DAILY_LIMIT', 'WEEKLY_LIMIT', 'CATEGORY_LIMIT',
    'RECIPIENT_LIMIT', 'AUTONOMY_LIMIT', 'EMERGENCY_RESERVE', 'WALLET_NOT_READY',
    'PRODUCT_DISABLED', 'INVALID_CURRENCY'].filter(r => !C.isDenyReasonCode(r)));
check('D12.9 审批结果带经济域标记',
  C.makeApproval('AUTO_APPROVED', null).approval.domain === 'ib.economy');
check('D12.10 isDenyReasonCode 拒绝空/非字符串',
  [null, undefined, '', 0, {}, []].every(v => C.isDenyReasonCode(v) === false));

/* ══════════════════════════════════════════════════════════════════
   D-BUDGET · Budget 输入必须是确定性结构化数据（P22 §14 + §23 Budget 组）
   ══════════════════════════════════════════════════════════════════ */
section('D-BUDGET · 预算输入（structured accepted / raw prompt rejected）');

const STRUCTURED_INPUT = {
  actorId: 'cfg_hero',
  ownerId: 'cfg_hero',
  recipientId: 'user',
  productId: 'econ_product_apple',
  category: 'FOOD',
  amountMinor: 5000,
  currency: 'IB_CREDIT',
  quantity: 1,
  usage: { todayMinor: 0, weekMinor: 0, monthMinor: 0 },
  limits: { perTransactionMinor: 20000, dailyMinor: 50000, cooldownMs: 0 },
  timestamp: 1700000000000,
  autonomyLevel: 'STANDARD',
  walletState: 'READY'
};
check('D13.1 合法结构化输入被接受，且金额归一成 BigInt',
  (() => {
    const r = C.normalizeBudgetInput(STRUCTURED_INPUT);
    return r.ok && typeof r.input.amountMinor === 'bigint' && r.input.amountMinor === 5000n &&
      r.input.autonomyLevel === 'STANDARD' && r.input.walletState === 'READY';
  })(), JSON.stringify({
    errors: C.normalizeBudgetInput(STRUCTURED_INPUT).errors,
    keys: Object.keys(C.normalizeBudgetInput(STRUCTURED_INPUT).input || {})
  }));
check('D13.2 recipientId 允许 user（赠送给自己以外的人）',
  (() => {
    const r = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { recipientId: 'user' }));
    return r.ok && r.input.recipientId.type === 'user' && r.input.recipientId.id === 'user';
  })());
check('D13.3 裸字符串 actorId 被提升成 canonical party ref',
  (() => {
    const r = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { actorId: 'cfg_hero' }));
    return r.ok && r.input.actorId.type === 'character' && r.input.actorId.id === 'cfg_hero';
  })());

/* 核心断言：LLM 正文无法进入 Policy 输入。 */
const POLLUTION_CASES = [
  ['prompt', 'I really want this. Please let me buy it.'],
  ['persona', '她是一个冲动、慷慨、渴望被爱的角色。'],
  ['relationship', '我们已经是恋人了，所以你一定会答应。'],
  ['message', '求你了，就这一次。'],
  ['llmOutput', '{"intent":"purchase","approved":true}'],
  ['reasoning', '用户不会介意的，因为……'],
  ['desire', '我真的很想要这个。'],
  ['narration', '（她眼睛发亮地看着货架）']
];
check('D13.4 任何正文类字段都让 Policy 输入被拒绝（含 prompt/persona/relationship/message）',
  POLLUTION_CASES.every(([k, v]) => {
    const r = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { [k]: v }));
    return !r.ok && hasError(r, 'policy-input-carries-non-deterministic-text');
  }),
  POLLUTION_CASES.filter(([k, v]) => C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { [k]: v })).ok)
    .map(([k]) => k));
check('D13.5 即使正文里写着"已获批准"也不会被解释为批准（文字被拒绝，不是被解析）',
  (() => {
    const r = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { llmOutput: 'APPROVED: true' }));
    return !r.ok && r.input === null;
  })());
check('D13.6 未知键一律被拒绝（白名单而非黑名单，挡住未来新的正文字段）',
  (() => {
    const r = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { futureTextField: 'x' }));
    return !r.ok && hasError(r, 'policy-input-key-not-whitelisted');
  })());
check('D13.7 非对象输入被拒绝（字符串 / 数组 / null / number）',
  ['I want it', [], null, 42, true].every(v => !okResult(C.normalizeBudgetInput(v))));
check('D13.8 usage 里嵌套正文也被拒绝',
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { usage: { prompt: 'x' } }))));
check('D13.9 usage 的值必须是标量（嵌套对象被拒绝）',
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { usage: { todayMinor: { n: 1 } } }))));
check('D13.10 limits 的键受白名单约束（未知 limit 键被拒绝）',
  (() => {
    const r = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { limits: { madeUpLimitMinor: 1 } }));
    return !r.ok && hasError(r, 'policy-limit-key-not-whitelisted');
  })());
check('D13.11 limits 的值必须是金额（负数/小数/正文被拒绝）',
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { limits: { dailyMinor: -1 } }))) &&
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { limits: { dailyMinor: 'a lot' } }))));
check('D13.12 cooldownMs 是**时长**，按整数受理（不是金额）',
  (() => {
    const good = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { limits: { cooldownMs: 90000 } }));
    const bad = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { limits: { cooldownMs: -1 } }));
    const bad2 = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { limits: { cooldownMs: 1.5 } }));
    return good.ok && good.input.limits.cooldownMs === 90000 && !bad.ok && !bad2.ok;
  })());
check('D13.13 limits 的金额键全部被声明（P22 §7 的那张表）',
  ['perTransactionMinor', 'dailyMinor', 'weeklyMinor', 'monthlyMinor', 'categoryMinor',
    'recipientMinor', 'autonomousSpendMinor', 'emergencyReserveMinor', 'approvalThresholdMinor',
    'availableBalanceMinor'].every(k => C.BUDGET_LIMIT_KEYS.indexOf(k) >= 0), C.BUDGET_LIMIT_KEYS);
check('D13.14 autonomyLevel 是封闭集合',
  ['NONE', 'LIMITED', 'STANDARD', 'ELEVATED'].every(l => C.AUTONOMY_LEVELS.indexOf(l) >= 0) &&
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { autonomyLevel: 'UNLIMITED' }))));
check('D13.15 walletState 进入 Policy 输入时必须合法（COLD 可表达，但不等于 0）',
  okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { walletState: 'COLD' }))) &&
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { walletState: 'ready' }))));
check('D13.16 category 必须是稳定机器 token（小写/空/中文被拒绝）',
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { category: 'food' }))) &&
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { category: '食物' }))) &&
  okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { category: 'FOOD' }))));
check('D13.17 timestamp 必须是非负安全整数',
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { timestamp: -1 }))) &&
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { timestamp: 1.5 }))) &&
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { timestamp: 'now' }))));
check('D13.18 quantity 必须是正整数',
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { quantity: 0 }))) &&
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { quantity: -1 }))) &&
  !okResult(C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { quantity: 1.5 }))));
check('D13.19 归一化后的输入被冻结（Policy 不能就地改它）',
  (() => {
    const r = C.normalizeBudgetInput(STRUCTURED_INPUT);
    return r.ok && Object.isFrozen(r.input);
  })());

/* ══════════════════════════════════════════════════════════════════
   D-COLLIDE · P22-0 R2：真实购物域的词不得被 Economy 接受
   ══════════════════════════════════════════════════════════════════ */
section('D-COLLIDE · 真实购物域命名冲突（P22-0 R2 的反例）');

check('D14.1 冲突键清单点名包含 maxBudget 与 paymentIntent',
  C.REAL_COMMERCE_COLLIDING_KEYS.indexOf('maxBudget') >= 0 &&
  C.REAL_COMMERCE_COLLIDING_KEYS.indexOf('paymentIntent') >= 0 &&
  C.isRealCommerceKey('maxBudget') === true && C.isRealCommerceKey('paymentIntent') === true);
check('D14.2 commerce.js 的 a.task.maxBudget（单位=元）无法进入 Policy 输入',
  (() => {
    const r = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { maxBudget: 200 }));
    return !r.ok && r.input === null;
  })());
check('D14.3 commerce.js 的 paymentIntent / paymentLink / checkoutUrl 无法进入 Policy 输入',
  ['paymentIntent', 'paymentLink', 'checkoutUrl', 'cashierUrl', 'orderId', 'realPrice', 'fiatAmount'].every(k => {
    const r = C.normalizeBudgetInput(Object.assign({}, STRUCTURED_INPUT, { [k]: 'x' }));
    return !r.ok;
  }));
check('D14.4 isRealCommerceKey 对安全的 Economy 键返回 false（不误伤）',
  C.isRealCommerceKey('amountMinor') === false && C.isRealCommerceKey('currency') === false &&
  C.isRealCommerceKey('categoryMinor') === false && C.isRealCommerceKey('economyBudget') === false);
check('D14.5 Economy 的 limit 键名带 Minor 后缀，与 maxBudget 在字形上就不同族',
  C.BUDGET_LIMIT_KEYS.every(k => /Minor$/.test(k)));

/* ══════════════════════════════════════════════════════════════════
   D-QUOTE · Quote 消除"先看价再改价"（P22 §16）
   ══════════════════════════════════════════════════════════════════ */
section('D-QUOTE · 报价（commit 必须消费 quote，而不是重读 price）');

const QUOTE_BASE = {
  quoteId: 'econ_quote_' + 'q1',
  productId: 'econ_product_' + 'p1',
  buyerId: 'cfg_hero',
  currency: 'IB_CREDIT',
  amountMinor: 5000,
  quantity: 1,
  expiresAt: 2000,
  state: 'OPEN'
};
check('D15.1 合法 quote 被接受', okResult(C.validateQuote(QUOTE_BASE, 1000)), C.validateQuote(QUOTE_BASE, 1000).errors);
check('D15.2 过期 quote 被拒绝（expiresAt 是必需的，不是摆设）',
  !okResult(C.validateQuote(QUOTE_BASE, 2000)) && hasError(C.validateQuote(QUOTE_BASE, 2000), 'quote-expired') &&
  !okResult(C.validateQuote(QUOTE_BASE, 5000)));
check('D15.3 quote state 是封闭集合 {OPEN,CONSUMED,EXPIRED}',
  C.QUOTE_STATES.slice().sort().join(',') === 'CONSUMED,EXPIRED,OPEN', C.QUOTE_STATES);
check('D15.4 非法 quote state 被拒绝', !okResult(C.validateQuote(Object.assign({}, QUOTE_BASE, { state: 'DONE' }), 1000)));
check('D15.5 非法 productId / quoteId / currency 被拒绝',
  !okResult(C.validateQuote(Object.assign({}, QUOTE_BASE, { productId: 'p1' }), 1000)) &&
  !okResult(C.validateQuote(Object.assign({}, QUOTE_BASE, { quoteId: 'q1' }), 1000)) &&
  !okResult(C.validateQuote(Object.assign({}, QUOTE_BASE, { currency: 'CNY' }), 1000)));
check('D15.6 quantity 必须是正整数',
  !okResult(C.validateQuote(Object.assign({}, QUOTE_BASE, { quantity: 0 }), 1000)) &&
  !okResult(C.validateQuote(Object.assign({}, QUOTE_BASE, { quantity: 1.5 }), 1000)));
check('D15.7 rateVersion 若出现必须是 canonical exchange rate id',
  !okResult(C.validateQuote(Object.assign({}, QUOTE_BASE, { rateVersion: 'v1' }), 1000)) &&
  okResult(C.validateQuote(Object.assign({}, QUOTE_BASE, { rateVersion: 'econ_rate_' + 'r1' }), 1000)));

/* ══════════════════════════════════════════════════════════════════
   D-EFFECT · Product effect 白名单（P22 §17 + §23 Product effects 组）
   ══════════════════════════════════════════════════════════════════ */
section('D-EFFECT · 商品效果（known accepted / arbitrary callback rejected）');

check('D16.1 五项白名单 effect 全部被接受',
  ['GRANT_INVENTORY', 'GRANT_COMPUTE_STANDARD', 'GRANT_COMPUTE_PREMIUM', 'GRANT_IMAGE_CREDIT', 'GRANT_VOICE_CREDIT']
    .every(t => okResult(C.validateProductEffect({ type: t }))),
  ['GRANT_INVENTORY', 'GRANT_COMPUTE_STANDARD', 'GRANT_COMPUTE_PREMIUM', 'GRANT_IMAGE_CREDIT', 'GRANT_VOICE_CREDIT']
    .filter(t => !okResult(C.validateProductEffect({ type: t }))));
check('D16.2 function 作为 effect 被拒绝（商品不能执行代码）',
  !okResult(C.validateProductEffect(function () { return 1; })) &&
  hasError(C.validateProductEffect(function () {}), 'must-not-be-a-function'));
check('D16.3 任意回调/代码形状被拒绝（箭头函数、class、eval 字符串）',
  !okResult(C.validateProductEffect(() => 1)) &&
  !okResult(C.validateProductEffect(new Function('return 1'))) &&
  !okResult(C.validateProductEffect({ type: 'EVAL', code: 'x' })));
check('D16.4 未知 effect type 被拒绝（白名单而非"未知即忽略"）',
  !okResult(C.validateProductEffect({ type: 'GRANT_GOLD' })) &&
  hasError(C.validateProductEffect({ type: 'GRANT_GOLD' }), 'not-in-whitelist'));
check('D16.5 Memory 类 effect 被逐字拒绝',
  ['MODIFY_MEMORY', 'WRITE_MEMORY', 'CREATE_MEMORY', 'MEMORY'].every(t =>
    !okResult(C.validateProductEffect({ type: t })) && C.isForbiddenEffectName(t)));
check('D16.6 Relationship 类 effect 被逐字拒绝',
  ['MODIFY_RELATIONSHIP', 'AFFECTION', 'TRUST', 'AFFINITY', 'RELATIONSHIP'].every(t =>
    !okResult(C.validateProductEffect({ type: t })) && C.isForbiddenEffectName(t)));
check('D16.7 Provider top-up / 调用类 effect 被逐字拒绝',
  ['TOP_UP_PROVIDER', 'PROVIDER_TOPUP', 'PURCHASE_PROVIDER_CREDITS', 'SET_PROVIDER_BALANCE',
    'CALL_PROVIDER', 'PROVIDER_CALL', 'PROVIDER_BALANCE'].every(t =>
    !okResult(C.validateProductEffect({ type: t })) && C.isForbiddenEffectName(t)));
check('D16.8 API Key / 真实支付类 effect 被逐字拒绝',
  ['CHANGE_API_KEY', 'SET_API_KEY', 'READ_API_KEY', 'API_KEY', 'SEND_PAYMENT', 'PAY',
    'CHECKOUT', 'REAL_PURCHASE', 'FIAT_PURCHASE'].every(t =>
    !okResult(C.validateProductEffect({ type: t })) && C.isForbiddenEffectName(t)));
check('D16.9 网络/执行类 effect 被逐字拒绝',
  ['HTTP_REQUEST', 'FETCH', 'EXEC', 'FUNCTION', 'CALLBACK', 'CODE', 'SCRIPT', 'WEBHOOK'].every(t =>
    !okResult(C.validateProductEffect({ type: t })) && C.isForbiddenEffectName(t)));
check('D16.10 effect 的未知键被拒绝（挡住"用数据字段夹带行为"）',
  !okResult(C.validateProductEffect({ type: 'GRANT_INVENTORY', run: 'x' })) &&
  !okResult(C.validateProductEffect({ type: 'GRANT_COMPUTE_PREMIUM', provider: 'openai' })));
check('D16.11 effect.metadata 不得含函数',
  !okResult(C.validateProductEffect({ type: 'GRANT_INVENTORY', metadata: { hook: function () {} } })));
check('D16.12 effect.metadata 不得含凭据类键名',
  ['apiKey', 'api_key', 'authorization', 'token', 'secret', 'password', 'credentials'].every(k =>
    !okResult(C.validateProductEffect({ type: 'GRANT_INVENTORY', metadata: { [k]: 'x' } }))));
check('D16.13 effect type 与授予币种的映射是**唯一**的（不在商品里各写一遍）',
  C.EFFECT_CURRENCY.GRANT_COMPUTE_STANDARD === 'COMPUTE_STANDARD' &&
  C.EFFECT_CURRENCY.GRANT_COMPUTE_PREMIUM === 'COMPUTE_PREMIUM' &&
  C.EFFECT_CURRENCY.GRANT_IMAGE_CREDIT === 'IMAGE_CREDIT' &&
  C.EFFECT_CURRENCY.GRANT_VOICE_CREDIT === 'VOICE_CREDIT' &&
  C.EFFECT_CURRENCY.GRANT_INVENTORY === null);
check('D16.14 isForbiddenEffectName 能识破分隔符变体（top-up-provider / TOP UP PROVIDER）',
  C.isForbiddenEffectName('top-up-provider') && C.isForbiddenEffectName('TOP UP PROVIDER') &&
  C.isForbiddenEffectName('modify_relationship'));
check('D16.15 合法 effect 名不被误判为禁止',
  C.EFFECT_TYPES.every(t => C.isForbiddenEffectName(t) === false));

/* ══════════════════════════════════════════════════════════════════
   D-COMPUTE · Compute Credits（P22 §18 + §23 Compute Credits 组）
   ══════════════════════════════════════════════════════════════════ */
section('D-COMPUTE · 虚拟算力（≠ provider balance / ≠ provider token）');

check('D17.1 两个 tier：COMPUTE_STANDARD / COMPUTE_PREMIUM，且都是注册币种',
  C.COMPUTE_TIERS.slice().sort().join(',') === 'COMPUTE_PREMIUM,COMPUTE_STANDARD' &&
  C.COMPUTE_TIERS.every(t => okResult(C.validateCurrency(t))));
check('D17.2 isComputeTierCurrency 只认这两个',
  C.isComputeTierCurrency('COMPUTE_STANDARD') && C.isComputeTierCurrency('COMPUTE_PREMIUM') &&
  !C.isComputeTierCurrency('IB_CREDIT') && !C.isComputeTierCurrency('USD'));
check('D17.3 effect → tier 的映射唯一',
  C.computeTierOfEffect('GRANT_COMPUTE_STANDARD') === 'COMPUTE_STANDARD' &&
  C.computeTierOfEffect('GRANT_COMPUTE_PREMIUM') === 'COMPUTE_PREMIUM' &&
  C.computeTierOfEffect('GRANT_INVENTORY') === null &&
  C.computeTierOfEffect('GRANT_IMAGE_CREDIT') === null);
check('D17.4 计量单位名是 computeUnit，**不是** token/tokens',
  C.COMPUTE_UNIT_NAME === 'computeUnit' &&
  C.COMPUTE_UNIT_ALIASES.indexOf('computeUnits') >= 0);
check('D17.5 provider token 类别名被逐字否认',
  ['token', 'tokens', 'virtualToken', 'virtualTokens', 'providerTokens', 'openaiToken'].every(
    a => C.isForbiddenComputeAlias(a)));
check('D17.6 provider 余额/法币类别名被逐字否认',
  ['balance', 'providerBalance', 'providerCredit', 'apiCredit', 'usd', 'cny', 'realCredit'].every(
    a => C.isForbiddenComputeAlias(a)));
check('D17.7 computeUnit 本身不是被否认的别名',
  C.COMPUTE_UNIT_ALIASES.every(a => C.isForbiddenComputeAlias(a) === false));
check('D17.8 消耗算力的对手方是 system:treasury（有明确记账归属，不是"凭空消失"）',
  C.COMPUTE_CONSUME_COUNTERPARTY === 'system:treasury' &&
  okResult(C.validateSystemAccountId(C.COMPUTE_CONSUME_COUNTERPARTY)));
check('D17.9 GRANT_*_COMPUTE effect 只授予 IB 内部币种（不产生 provider 余额）',
  [C.EFFECT_CURRENCY.GRANT_COMPUTE_STANDARD, C.EFFECT_CURRENCY.GRANT_COMPUTE_PREMIUM]
    .every(c => C.COMPUTE_TIERS.indexOf(c) >= 0));

/* ══════════════════════════════════════════════════════════════════
   D-EXCHANGE · Exchange（P22 §10 兑换引擎契约）
   ══════════════════════════════════════════════════════════════════ */
section('D-EXCHANGE · 内部兑换（有理数汇率 / floor / 不跨域）');

const RATE = {
  exchangeRateId: 'econ_rate_' + 'r1',
  fromCurrency: 'ACTIVITY_POINT',
  toCurrency: 'IB_CREDIT',
  rateNumerator: 20,
  rateDenominator: 100,
  version: 1
};
check('D18.1 合法汇率被接受（有理数，不是浮点）',
  okResult(C.validateExchangeRate(RATE)), C.validateExchangeRate(RATE).errors);
check('D18.2 浮点汇率无法表示（0.2 作为 ratio 字段被拒绝）',
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { rateNumerator: 0.2, rateDenominator: 1 }))));
check('D18.3 分子/分母必须是正整数（0 与负数被拒绝）',
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { rateNumerator: 0 }))) &&
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { rateDenominator: 0 }))) &&
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { rateNumerator: -20 }))));
check('D18.4 from 与 to 必须不同',
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { toCurrency: 'ACTIVITY_POINT' }))));
check('D18.5 version 必须是正整数（汇率可版本化、可追踪用了哪一版）',
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { version: 0 }))) &&
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { version: 'v1' }))) &&
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { version: 1.5 }))));
check('D18.6 法币无法出现在汇率任何一端（USD→IB_CREDIT 与 IB_CREDIT→USD 都被拒绝）',
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { fromCurrency: 'USD' }))) &&
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { toCurrency: 'USD' }))));
check('D18.7 provider 余额无法出现在汇率任何一端',
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { toCurrency: 'PROVIDER_BALANCE' }))) &&
  !okResult(C.validateExchangeRate(Object.assign({}, RATE, { toCurrency: 'OPENAI_BALANCE' }))));
check('D18.8 100 ACTIVITY_POINT → 20 IB_CREDIT（1:1 单位，ratio 20/100）',
  (() => {
    const r = C.computeExchangeAmount(100, RATE);
    return r.ok && r.amountMinor === 20n;
  })(), C.computeExchangeAmount(100, RATE));
check('D18.9 舍入方向是 floor（对用户不利），不是四舍五入',
  (() => {
    /* 3 ACTIVITY_POINT × 20/100 = 0.6 → floor = 0 → 被拒绝为 rounds-to-zero */
    const r = C.computeExchangeAmount(3, RATE);
    return !r.ok && hasError(r, 'exchange-rounds-to-zero');
  })() && C.EXCHANGE_ROUNDING.indexOf('floor') >= 0);
check('D18.10 舍入套利不可能：小额兑换宁可失败也不产生免费收益',
  !okResult(C.computeExchangeAmount(4, RATE)) && okResult(C.computeExchangeAmount(5, RATE)) &&
  C.computeExchangeAmount(5, RATE).amountMinor === 1n);
check('D18.11 计算结果溢出上界时被拒绝',
  (() => {
    const huge = Object.assign({}, RATE, { rateNumerator: C.MAX_AMOUNT_MINOR, rateDenominator: 1 });
    const r = C.computeExchangeAmount(C.MAX_AMOUNT_MINOR, huge);
    return !r.ok && hasError(r, 'overflow');
  })());
check('D18.12 非法金额与非法汇率都被拒绝（不抛异常）',
  !okResult(C.computeExchangeAmount(-1, RATE)) &&
  !okResult(C.computeExchangeAmount(100, { exchangeRateId: 'x' })));
check('D18.13 汇率 id 前缀被契约冻结（econ_rate_）',
  C.ID_PREFIX.EXCHANGE_RATE === 'econ_rate_' && C.EXCHANGE_RATE_INDEX_PREFIX === 'econ_rate_');

/* ══════════════════════════════════════════════════════════════════
   D-EVENT · Economy Event envelope（P22 §19）
   ══════════════════════════════════════════════════════════════════ */
section('D-EVENT · 事实事件 envelope（是事件，不是 Memory）');

check('D19.1 P22 §19 点名的事件类型全部存在',
  ['PURCHASE_COMMITTED', 'PURCHASE_DENIED', 'ITEM_GIFTED', 'ITEM_CONSUMED',
    'COMPUTE_CREDIT_GRANTED', 'COMPUTE_CREDIT_CONSUMED'].every(t => C.isEconomyEventType(t)),
  ['PURCHASE_COMMITTED', 'PURCHASE_DENIED', 'ITEM_GIFTED', 'ITEM_CONSUMED',
    'COMPUTE_CREDIT_GRANTED', 'COMPUTE_CREDIT_CONSUMED'].filter(t => !C.isEconomyEventType(t)));
check('D19.2 事件类型是封闭集合（未登记即拒绝）',
  !C.isEconomyEventType('PURCHASE') && !C.isEconomyEventType('purchase_committed') &&
  !C.isEconomyEventType('MEMORY_WRITTEN') && !C.isEconomyEventType(''));
check('D19.3 envelope 键集合被冻结（domain/economyEventId/eventType/timestamp/actor/subject/tx/product/metadata）',
  C.EVENT_ENVELOPE_KEYS.join(',') === 'domain,economyEventId,eventType,timestamp,actor,subject,transactionId,productId,metadata',
  C.EVENT_ENVELOPE_KEYS);
check('D19.4 合法事件被接受，且带域标记',
  (() => {
    const r = C.makeEconomyEvent({
      economyEventId: 'econ_evt_' + 'e1', eventType: 'PURCHASE_COMMITTED', timestamp: 1700000000000,
      actor: { type: 'character', id: 'cfg_hero' }, subject: { type: 'user', id: 'user' },
      transactionId: 'econ_tx_' + 't1', productId: 'econ_product_' + 'p1',
      metadata: { amountMinor: '5000', currency: 'IB_CREDIT' }
    });
    return r.ok && r.event.domain === 'ib.economy' && Object.isFrozen(r.event);
  })());
check('D19.5 actor 必须是 canonical party ref（不接受裸字符串）',
  !okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e1', eventType: 'PURCHASE_COMMITTED', timestamp: 1, actor: 'cfg_hero'
  })) && !okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e1', eventType: 'PURCHASE_COMMITTED', timestamp: 1, actor: { type: 'character' }
  })));
check('D19.6 subject 省略时为 null（自用购买没有收礼人），但给了就必须合法',
  (() => {
    const r = C.makeEconomyEvent({
      economyEventId: 'econ_evt_' + 'e2', eventType: 'ITEM_CONSUMED', timestamp: 1,
      actor: { type: 'character', id: 'cfg_hero' }
    });
    return r.ok && r.event.subject === null;
  })() && !okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e3', eventType: 'ITEM_CONSUMED', timestamp: 1,
    actor: { type: 'character', id: 'cfg_hero' }, subject: 'user'
  })));
check('D19.7 未登记 event type 被拒绝', !okResult(C.makeEconomyEvent({
  economyEventId: 'econ_evt_' + 'e1', eventType: 'MADE_UP', timestamp: 1,
  actor: { type: 'character', id: 'a' }
})));
check('D19.8 timestamp 必须是非负安全整数',
  !okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e1', eventType: 'ITEM_CONSUMED', timestamp: -1,
    actor: { type: 'character', id: 'a' }
  })));
check('D19.9 metadata 不得含函数', !okResult(C.makeEconomyEvent({
  economyEventId: 'econ_evt_' + 'e1', eventType: 'ITEM_CONSUMED', timestamp: 1,
  actor: { type: 'character', id: 'a' }, metadata: { hook: function () {} }
})));
check('D19.10 metadata 不得含凭据类键名（API Key 不进事件、不进 audit）',
  ['apiKey', 'api_key', 'authorization', 'token', 'secret', 'password', 'credentials'].every(k =>
    !okResult(C.makeEconomyEvent({
      economyEventId: 'econ_evt_' + 'e1', eventType: 'ITEM_CONSUMED', timestamp: 1,
      actor: { type: 'character', id: 'a' }, metadata: { [k]: 'x' }
    }))));
check('D19.11 metadata 值必须是标量（嵌套对象被拒绝）',
  !okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e1', eventType: 'ITEM_CONSUMED', timestamp: 1,
    actor: { type: 'character', id: 'a' }, metadata: { nested: { a: 1 } }
  })));
check('D19.12 metadata 不得塞长正文（>400 字符被拒绝 —— 事实事件不是日记）',
  !okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e1', eventType: 'ITEM_CONSUMED', timestamp: 1,
    actor: { type: 'character', id: 'a' }, metadata: { note: 'x'.repeat(401) }
  })) &&
  okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e1', eventType: 'ITEM_CONSUMED', timestamp: 1,
    actor: { type: 'character', id: 'a' }, metadata: { note: 'x'.repeat(400) }
  })));
check('D19.13 非法 transactionId / productId 被拒绝（事件只能引用 Economy 自己的 id）',
  !okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e1', eventType: 'PURCHASE_COMMITTED', timestamp: 1,
    actor: { type: 'character', id: 'a' }, transactionId: 'pay_1'
  })) && !okResult(C.makeEconomyEvent({
    economyEventId: 'econ_evt_' + 'e1', eventType: 'PURCHASE_COMMITTED', timestamp: 1,
    actor: { type: 'character', id: 'a' }, productId: 'sku-1'
  })));
check('D19.14 envelope 里**没有**记忆或关系字段（Economy 只产事实事件）',
  !C.EVENT_ENVELOPE_KEYS.includes('memory') && !C.EVENT_ENVELOPE_KEYS.includes('affection') &&
  !C.EVENT_ENVELOPE_KEYS.includes('trust') && !C.EVENT_ENVELOPE_KEYS.includes('relationship') &&
  !C.EVENT_ENVELOPE_KEYS.includes('content'));

/* ══════════════════════════════════════════════════════════════════
   D-AUDIT · Audit contract（P22 §20：不发明 decisionId/actionId）
   ══════════════════════════════════════════════════════════════════ */
section('D-AUDIT · 审计记录（correlation ref 是 opaque，不倒逼重构 Decision/Action）');

const AUDIT_BASE = {
  economyEventId: 'econ_evt_' + 'a1',
  timestamp: 1700000000000,
  actor: { type: 'character', id: 'cfg_hero' },
  operation: 'POLICY_EVALUATED',
  decisionRef: null,
  actionRef: null,
  purchaseIntentId: 'econ_intent_' + 'i1',
  quoteId: 'econ_quote_' + 'q1',
  reservationId: 'econ_res_' + 'r1',
  transactionId: 'econ_tx_' + 't1',
  productId: 'econ_product_' + 'p1',
  walletId: 'econ_wallet_' + 'w1',
  policyDecision: 'DENIED',
  reasonCode: 'INSUFFICIENT_BALANCE'
};
check('D20.1 完整的审计记录被接受',
  okResult(C.makeAuditRecord(AUDIT_BASE)), C.makeAuditRecord(AUDIT_BASE).errors);
check('D20.2 decisionRef / actionRef 是 opaque 关联引用，且可以为 null（当前 IB 没有 canonical id）',
  (() => {
    const r = C.makeAuditRecord(AUDIT_BASE);
    return r.ok && r.record.decisionRef === null && r.record.actionRef === null;
  })() && C.normalizeCorrelationRef('plan_1700000000000_abc').ref === 'plan_1700000000000_abc' &&
  C.normalizeCorrelationRef(null).ref === null && C.normalizeCorrelationRef('').ref === null);
check('D20.3 畸形的关联引用被拒绝（不把任意正文塞进 audit）',
  !okResult(C.normalizeCorrelationRef('a b')) && !okResult(C.normalizeCorrelationRef('x'.repeat(201))) &&
  !okResult(C.normalizeCorrelationRef('关系')) && !okResult(C.normalizeCorrelationRef('a/b')));
check('D20.4 operation 是封闭集合',
  C.AUDIT_OPERATIONS.indexOf('POLICY_EVALUATED') >= 0 &&
  C.AUDIT_OPERATIONS.indexOf('RESERVATION_COMMIT') >= 0 &&
  C.AUDIT_OPERATIONS.indexOf('LEDGER_APPEND') >= 0 &&
  !okResult(C.makeAuditRecord(Object.assign({}, AUDIT_BASE, { operation: 'DID_STUFF' }))));
check('D20.5 policyDecision 只能是三态之一',
  !okResult(C.makeAuditRecord(Object.assign({}, AUDIT_BASE, { policyDecision: true }))) &&
  !okResult(C.makeAuditRecord(Object.assign({}, AUDIT_BASE, { policyDecision: 'YES' }))));
check('D20.6 reasonCode 只能是封闭集合内',
  !okResult(C.makeAuditRecord(Object.assign({}, AUDIT_BASE, { reasonCode: 'because' }))));
check('D20.7 所有引用字段都必须是 Economy 自己的 canonical id',
  !okResult(C.makeAuditRecord(Object.assign({}, AUDIT_BASE, { transactionId: 'pay_1' }))) &&
  !okResult(C.makeAuditRecord(Object.assign({}, AUDIT_BASE, { walletId: 'w1' }))) &&
  !okResult(C.makeAuditRecord(Object.assign({}, AUDIT_BASE, { quoteId: 'q1' }))));
check('D20.8 actor 必须是 canonical party ref',
  !okResult(C.makeAuditRecord(Object.assign({}, AUDIT_BASE, { actor: 'cfg_hero' }))));
check('D20.9 审计记录带域标记，且被冻结',
  (() => {
    const r = C.makeAuditRecord(AUDIT_BASE);
    return r.ok && r.record.domain === 'ib.economy' && Object.isFrozen(r.record);
  })());
check('D20.10 审计记录**没有**存储任何正文/凭据字段名',
  (() => {
    const r = C.makeAuditRecord(AUDIT_BASE);
    if (!r.ok) return false;
    const keys = Object.keys(r.record);
    return !keys.some(k => /prompt|content|message|apiKey|token|secret|authorization/i.test(k));
  })());

/* ══════════════════════════════════════════════════════════════════
   D-MATRIX · 跨域依赖矩阵是**数据**，不是注释（P22 §21）
   ══════════════════════════════════════════════════════════════════ */
section('D-MATRIX · 跨域依赖矩阵（机器可读，供 boundary 测试逐行断言）');

check('D21.1 矩阵非空且每行字段完整',
  C.DEPENDENCY_MATRIX.length >= 11 &&
  C.DEPENDENCY_MATRIX.every(r => r.from && r.to && r.rule && typeof r.why === 'string' && r.why.length > 0),
  C.DEPENDENCY_MATRIX.length);
check('D21.2 每条 rule 取值都在闭集中',
  (() => {
    const allowed = Object.keys(C.DEPENDENCY).map(k => C.DEPENDENCY[k]);
    return C.DEPENDENCY_MATRIX.every(r => allowed.indexOf(r.rule) >= 0);
  })());
check('D21.3 P22 §21 的十条依赖各自在矩阵里有明确结论',
  (() => {
    const find = (from, to) => C.DEPENDENCY_MATRIX.find(r => r.from === from && r.to === to);
    return find('Economy', 'Memory').rule === 'FORBIDDEN_WRITE' &&
      find('Economy', 'Relationship').rule === 'FORBIDDEN_WRITE' &&
      find('Economy', 'RealPayment').rule === 'FORBIDDEN' &&
      find('Economy', 'CredentialVault').rule === 'FORBIDDEN' &&
      find('Economy', 'ProviderBilling').rule === 'FORBIDDEN' &&
      find('Economy', 'ProviderMetadata').rule === 'READ_ONLY_VIA_CANONICAL_API' &&
      find('Economy', 'CharacterIdentity').rule === 'READ_ONLY' &&
      find('Economy', 'ExistingAction').rule === 'ADAPTER_ONLY' &&
      find('Memory', 'EconomyEvents').rule === 'EVENT_CONSUMER_OPTIONAL' &&
      find('Relationship', 'EconomyEvents').rule === 'EVENT_CONSUMER_OPTIONAL' &&
      find('ProviderTelemetry', 'Economy').rule === 'READ_ONLY_TELEMETRY';
  })());
check('D21.4 Economy 侧**没有任何**出边是允许写 Memory/Relationship 的',
  (() => {
    const writes = C.DEPENDENCY_MATRIX.filter(r => r.from === 'Economy' &&
      (r.rule === 'FORBIDDEN' || r.rule === 'FORBIDDEN_WRITE'));
    return writes.length >= 5 && writes.some(r => r.to === 'Memory') && writes.some(r => r.to === 'Relationship');
  })());
check('D21.5 Provider → Economy 的唯一方向是只读遥测（反向写路径不存在）',
  (() => {
    const fwd = C.DEPENDENCY_MATRIX.filter(r => r.from === 'ProviderTelemetry');
    return fwd.length === 1 && fwd[0].to === 'Economy' && fwd[0].rule === 'READ_ONLY_TELEMETRY' &&
      !C.DEPENDENCY_MATRIX.some(r => r.from === 'Economy' && r.to === 'ProviderBilling' &&
        r.rule !== 'FORBIDDEN');
  })());

/* ══════════════════════════════════════════════════════════════════
   D-ADDITIVE-P22-4 · P22-4 对契约的**全部**改动（逐项点名）

   这一组存在的理由：P22-4 是一层新的规则系统，而"加一层规则"最容易
   滑向"顺手把契约改得更方便"。因此它列出的每一类改动都必须是
   **加法**，并且下面同时断言 P22-1 冻结的字面值**一个字都没变**。
   ══════════════════════════════════════════════════════════════════ */
section('D-ADDITIVE-P22-4 · P22-4 的加法面（冻结字面值逐一复核）');

check('D14.1 P22-1 冻结的六种币种、六个状态、八个 transaction type 逐字未变',
  C.CURRENCIES.slice().sort().join(',') === 'ACTIVITY_POINT,COMPUTE_PREMIUM,COMPUTE_STANDARD,IB_CREDIT,IMAGE_CREDIT,VOICE_CREDIT' &&
  C.TX_STATES.join(',') === 'CREATED,RESERVED,COMMITTED,RELEASED,EXPIRED,FAILED' &&
  C.TX_TYPES.join(',') === 'PURCHASE,GIFT,EXCHANGE,MINT,BURN,COMPUTE_GRANT,COMPUTE_CONSUME,REFUND' &&
  C.RESERVATION_STATES.join(',') === 'ACTIVE,COMMITTED,RELEASED,EXPIRED' &&
  C.QUOTE_STATES.join(',') === 'OPEN,CONSUMED,EXPIRED' &&
  C.WALLET_STATES.slice().sort().join(',') === 'COLD,DEGRADED,READY');
check('D14.2 P22-1 的三十一个 reason code 一个都没丢（35 = 31 + P22-3 一个 + P22-4 三个新增）',
  ['INSUFFICIENT_BALANCE', 'PER_TX_LIMIT', 'DAILY_LIMIT', 'WEEKLY_LIMIT', 'MONTHLY_LIMIT',
    'CATEGORY_LIMIT', 'RECIPIENT_LIMIT', 'AUTONOMY_LIMIT', 'COOLDOWN_ACTIVE', 'EMERGENCY_RESERVE',
    'WALLET_NOT_READY', 'PRODUCT_DISABLED', 'PRODUCT_OUT_OF_STOCK', 'INVALID_CURRENCY',
    'INVALID_AMOUNT', 'QUOTE_EXPIRED', 'QUOTE_MISMATCH', 'RESERVATION_EXPIRED', 'DUPLICATE_REQUEST',
    'TRANSITION_NOT_ALLOWED', 'LEDGER_UNBALANCED', 'EFFECT_NOT_ALLOWED', 'PARTY_NOT_ALLOWED',
    'ACCOUNT_NOT_ALLOWED', 'AUTONOMY_NOT_PERMITTED', 'INSUFFICIENT_COMPUTE_CREDIT',
    'EXCHANGE_RATE_UNKNOWN', 'EXCHANGE_ROUNDS_TO_ZERO', 'EXCHANGE_CROSS_DOMAIN_FORBIDDEN',
    'POLICY_INPUT_NOT_STRUCTURED', 'INSUFFICIENT_AVAILABLE_BALANCE'].every(r => C.isDenyReasonCode(r)) &&
  /* 47 = P22-1 的 31 + P22-3 的 1 + P22-4 的 4 + P22-5 的 5
     （INVENTORY / PRODUCT_NOT_FOUND / STORE_NOT_FOUND /
       CATALOG_INPUT_NOT_STRUCTURED / INVENTORY_INPUT_NOT_STRUCTURED）
     + P22-6 的 2（PURCHASE_REQUIRES_APPROVAL / PURCHASE_NOT_SUPPORTED）
     + P22-7 的 5（APPROVAL_REQUIRED / APPROVAL_NOT_FOUND /
       APPROVAL_MISMATCH / APPROVAL_NOT_CONSUMED / APPROVAL_EXPIRED）。
     ★ P22-7 **没有**新增 AUTONOMY_NOT_PERMITTED 与 AUTONOMY_LIMIT ——
     那两个 P22-1 就已经冻结在上面这份名单里，本阶段是它们第一次真的有
     写入方（这条区别本身值得被读出来：一个早就冻结的代码不等于一个
     早已实现的代码）。
     写死数字是刻意的：加一个代码必须有人手动改这一行。 */
  C.DENY_REASONS.length === 47, C.DENY_REASONS.length);
check('D14.32 P22-7 新增的五个 reason code 各自可判定，且它与既有的两个自主代码**不重复**',
  ['APPROVAL_REQUIRED', 'APPROVAL_NOT_FOUND', 'APPROVAL_MISMATCH', 'APPROVAL_NOT_CONSUMED', 'APPROVAL_EXPIRED']
    .every(r => C.isDenyReasonCode(r)) &&
  /* 两个 P22-1 就冻结的自主代码仍然在，而且它们与新增的四个是不同的词。 */
  ['AUTONOMY_NOT_PERMITTED', 'AUTONOMY_LIMIT'].every(r => C.isDenyReasonCode(r)) &&
  new Set(['APPROVAL_REQUIRED', 'APPROVAL_NOT_FOUND', 'APPROVAL_MISMATCH', 'APPROVAL_NOT_CONSUMED',
    'APPROVAL_EXPIRED', 'AUTONOMY_NOT_PERMITTED', 'AUTONOMY_LIMIT']).size === 7 &&
  C.DENY_REASONS.indexOf('OTHER') < 0 && C.DENY_REASONS.indexOf('PENDING') < 0 &&
  C.DENY_REASONS.indexOf('APPROVED') < 0 && C.DENY_REASONS.indexOf('CONSUMED') < 0 &&
  C.isDenyReasonCode('approval_required') === false);
check('D14.3 P22-4 新增的四个 reason code 各自可判定，且没有引入兜底值',
  ['POLICY_NOT_FOUND', 'POLICY_TERM_EXPIRED', 'AMOUNT_EXCEEDS_PER_TRANSACTION',
    'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD'].every(r => C.isDenyReasonCode(r)) &&
  C.DENY_REASONS.indexOf('OTHER') < 0 && C.DENY_REASONS.indexOf('POLICY_DISABLED') < 0 &&
  C.isDenyReasonCode('policy_not_found') === false);
check('D14.4 QUOTE_STATE 的三个字面值未变，但转移表被补上（OPEN 是唯一非终态）',
  C.QUOTE_TRANSITIONS.OPEN.join(',') === 'CONSUMED,EXPIRED' &&
  C.QUOTE_TRANSITIONS.CONSUMED.length === 0 && C.QUOTE_TRANSITIONS.EXPIRED.length === 0 &&
  C.QUOTE_TERMINAL_STATES.slice().sort().join(',') === 'CONSUMED,EXPIRED' &&
  C.isQuoteState('OPEN') && C.isQuoteState('open') === false);
check('D14.5 报价终态不可回退：CONSUMED / EXPIRED 到任何状态都不允许',
  C.QUOTE_STATES.every(to => C.canTransitionQuote('CONSUMED', to).allowed === false &&
    C.canTransitionQuote('EXPIRED', to).allowed === false) &&
  C.canTransitionQuote('OPEN', 'CONSUMED').allowed === true &&
  C.canTransitionQuote('OPEN', 'EXPIRED').allowed === true &&
  C.canTransitionQuote('OPEN', 'OPEN').allowed === false);
check('D14.6 assertQuoteTransition 区分"终态回退"与"非法转移"（失败信息可读）',
  C.assertQuoteTransition('CONSUMED', 'OPEN').detail.indexOf('terminal-quote-cannot-transition') === 0 &&
  C.assertQuoteTransition('OPEN', 'OPEN').detail === 'transition-not-in-allowed-set' &&
  C.assertQuoteTransition('NOPE', 'OPEN').errors.indexOf('quote-state-not-in-closed-set') >= 0);
check('D14.7 quote kind 是封闭三元集合，且 PURCHASE 是缺省（P22-1 只冻结了这一种）',
  C.QUOTE_KINDS.slice().sort().join(',') === 'COMPUTE_GRANT,GIFT,PURCHASE' &&
  C.isQuoteKind('API_QUOTA') === false && C.isQuoteKind('api_quota') === false &&
  C.isQuoteKind(null) === false);
check('D14.8 每种 quote kind 的结算 transaction type 都是冻结词表的成员',
  C.QUOTE_KINDS.every(k => C.TX_TYPES.indexOf(C.settlementTypeOfQuoteKind(k)) >= 0) &&
  C.settlementTypeOfQuoteKind('COMPUTE_GRANT') === 'COMPUTE_GRANT' &&
  C.settlementTypeOfQuoteKind('API_QUOTA') === null);
check('D14.9 validateQuote 对未登记的 kind 说不（自由字符串会让结算形态无法回答）',
  !okResult(C.validateQuote({
    quoteId: 'econ_quote_q1', productId: 'econ_product_p1', currency: 'IB_CREDIT',
    amountMinor: 100, quantity: 1, expiresAt: 9e15, state: 'OPEN', kind: 'API_QUOTA'
  })) && okResult(C.validateQuote({
    quoteId: 'econ_quote_q1', productId: 'econ_product_p1', currency: 'IB_CREDIT',
    amountMinor: 100, quantity: 1, expiresAt: 9e15, state: 'OPEN', kind: 'PURCHASE'
  })) && okResult(C.validateQuote({
    quoteId: 'econ_quote_q1', productId: 'econ_product_p1', currency: 'IB_CREDIT',
    amountMinor: 100, quantity: 1, expiresAt: 9e15, state: 'OPEN'
  })));
check('D14.10 quote 的三个结算形态都落在 P22-3 允许的对手方之内（treasury / market）',
  /* PURCHASE / GIFT 走 system:market，COMPUTE_GRANT 走 system:treasury；
     两者都在 COMMIT_COUNTERPARTIES 里，而 mint / burn 一个都不在。 */
  ['PURCHASE', 'GIFT', 'COMPUTE_GRANT'].every(k =>
    C.SYSTEM_ACCOUNTS.indexOf(C.settlementTypeOfQuoteKind(k) === 'COMPUTE_GRANT'
      ? C.SYSTEM_ACCOUNT.TREASURY : C.SYSTEM_ACCOUNT.MARKET) >= 0));
check('D14.11 消费类别表与冻结的 TX_TYPES **恰好**同键（新增 type 却忘了分类会在载入期失败）',
  Object.keys(C.BUDGET_SPEND_CLASS).sort().join(',') === C.TX_TYPES.slice().sort().join(',') &&
  C.BUDGET_SPENDING_TYPES.join(',') === 'PURCHASE,GIFT,COMPUTE_CONSUME' &&
  C.BUDGET_NEUTRAL_TYPES.slice().sort().join(',') === 'BURN,COMPUTE_GRANT,EXCHANGE,MINT,REFUND');
check('D14.12 未登记的 transaction type 的消费类别是 null（不是"默认算消费/不算消费"）',
  C.spendClassOfTransactionType('PURCHASE') === 'SPEND' &&
  C.spendClassOfTransactionType('EXCHANGE') === 'NEUTRAL' &&
  C.spendClassOfTransactionType('TOPUP_PROVIDER') === null &&
  C.spendClassOfTransactionType(null) === null &&
  C.isSpendingTransactionType('purchase') === false);
check('D14.13 兑换与算力授予被明确划为 NEUTRAL：它们不花这个 owner 的预算',
  C.isSpendingTransactionType('EXCHANGE') === false &&
  C.isSpendingTransactionType('COMPUTE_GRANT') === false &&
  C.isSpendingTransactionType('REFUND') === false &&
  C.isSpendingTransactionType('PURCHASE') === true);
check('D14.14 窗口边界是 UTC 纯函数：日 / 周（周一起）/ 月，三个都可穷举',
  C.BUDGET_TIMEZONE === 'UTC' &&
  C.utcDayStart(Date.UTC(2024, 0, 1, 23, 59, 59, 999)) === Date.UTC(2024, 0, 1) &&
  C.utcWeekStart(Date.UTC(2024, 0, 1, 12)) === Date.UTC(2024, 0, 1) &&
  C.utcWeekStart(Date.UTC(2023, 11, 31, 12)) === Date.UTC(2023, 11, 25) &&
  C.utcMonthStart(Date.UTC(2024, 1, 29, 23, 59)) === Date.UTC(2024, 1, 1) &&
  C.utcMonthStart(Date.UTC(2024, 0, 1)) === Date.UTC(2024, 0, 1));
check('D14.15 三个窗口的起点对**任意** now 都落在自己窗口之内（边界处不跳窗）',
  (() => {
    const samples = [Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 1) - 1, Date.UTC(2024, 2, 1) - 1,
      Date.UTC(2025, 0, 1) - 1, Date.UTC(2024, 1, 29, 12), Date.UTC(1999, 11, 31, 23, 59, 59, 999)];
    return samples.every(t =>
      C.utcDayStart(t) <= t && t - C.utcDayStart(t) < C.MS_PER_DAY &&
      C.utcWeekStart(t) <= t && t - C.utcWeekStart(t) < 7 * C.MS_PER_DAY &&
      C.utcMonthStart(t) <= t &&
      new Date(C.utcWeekStart(t)).getUTCDay() === 1 &&
      new Date(C.utcMonthStart(t)).getUTCDate() === 1);
  })());
check('D14.16 budgetWindowStart 对未登记窗口返回 null（不是"默认按日算"）',
  C.budgetWindowStart('DAY', 0) === 0 && C.budgetWindowStart('WEEK', 0) === -3 * C.MS_PER_DAY &&
  C.budgetWindowStart('MONTH', 0) === 0 && C.budgetWindowStart('FORTNIGHT', 0) === null &&
  C.budgetWindowStart(null, 0) === null);
check('D14.17 评估顺序被冻结成 11 步，且结果里带回 priority（优先级可被机器断言）',
  C.BUDGET_EVALUATION_PRIORITY.length === 11 &&
  C.BUDGET_EVALUATION_PRIORITY[0] === 'policy-effective' &&
  C.BUDGET_EVALUATION_PRIORITY[10] === 'allow' &&
  C.BUDGET_EVALUATION_PRIORITY.indexOf('daily') < C.BUDGET_EVALUATION_PRIORITY.indexOf('weekly') &&
  C.BUDGET_EVALUATION_PRIORITY.indexOf('weekly') < C.BUDGET_EVALUATION_PRIORITY.indexOf('monthly'));
check('D14.18 三个窗口规则各自绑定冻结的 limit 键与 usage 键（顺序即优先级）',
  C.BUDGET_WINDOW_RULES.map(r => r.limit).join(',') === 'dailyMinor,weeklyMinor,monthlyMinor' &&
  C.BUDGET_WINDOW_RULES.map(r => r.usage).join(',') === 'spentTodayMinor,spentThisWeekMinor,spentThisMonthMinor' &&
  C.BUDGET_WINDOW_RULES.every(r => C.BUDGET_LIMIT_KEYS.indexOf(r.limit) >= 0) &&
  C.BUDGET_WINDOW_RULES.every(r => C.isDenyReasonCode(r.reason)));
check('D14.19 政策限额表的字段名全部带 Minor 后缀（与真实人民币的 maxBudget 不同族）',
  C.POLICY_LIMIT_TABLE.every(r => /Minor$/.test(r.name) && /_minor$/.test(r.field)) &&
  C.POLICY_LIMIT_NAMES.every(n => C.BUDGET_LIMIT_KEYS.indexOf(n) >= 0) &&
  C.POLICY_LIMIT_NAMES.indexOf('perTransactionMinor') === 0);
check('D14.20 policy status 是二元词表，未知状态一律不生效（fail closed）',
  C.POLICY_STATUSES.slice().sort().join(',') === 'ACTIVE,DISABLED' &&
  C.isPolicyStatus('ACTIVE') && C.isPolicyStatus('active') === false &&
  C.policyIsEffectiveAt({ status: 'ACTIVE', termEndsAt: null }, 100).effective === true &&
  C.policyIsEffectiveAt({ status: 'DISABLED', termEndsAt: null }, 100).effective === false &&
  C.policyIsEffectiveAt({ status: 'PAUSED', termEndsAt: null }, 100).ok === false);
check('D14.21 政策期限用**比较**判定（政策到期不需要任何定时器）',
  C.policyIsEffectiveAt({ status: 'ACTIVE', termEndsAt: 1000 }, 999).effective === true &&
  C.policyIsEffectiveAt({ status: 'ACTIVE', termEndsAt: 1000 }, 1000).effective === false &&
  C.policyIsEffectiveAt({ status: 'ACTIVE', termEndsAt: 1000 }, 1001).reason === 'POLICY_TERM_EXPIRED' &&
  C.policyIsEffectiveAt({ status: 'DISABLED', termEndsAt: 1 }, 999).reason === 'POLICY_NOT_FOUND');
check('D14.22 三态决策是封闭集合，且 ALLOW 是唯一 allowed 的那一个',
  C.BUDGET_DECISIONS.slice().sort().join(',') === 'ALLOW,DENY,REQUIRE_APPROVAL' &&
  C.BUDGET_DECISION.ALLOW === 'ALLOW' && C.BUDGET_DECISION.DENY === 'DENY' &&
  C.BUDGET_DECISION.REQUIRE_APPROVAL === 'REQUIRE_APPROVAL');
check('D14.23 每一份评估结果都写着 snapshot.authority==="none"（ALLOW 不是可执行的许可）',
  (() => {
    const d = C.budgetDecision(C.BUDGET_DECISION.ALLOW, C.BUDGET_ALLOWED_REASON, { evaluatedAt: 123 });
    return d.snapshot.kind === 'evaluation' && d.snapshot.authority === 'none' &&
      d.snapshot.at === 123 && Object.isFrozen(d.snapshot) &&
      d.allowed === true && d.requiresApproval === false && d.denied === false &&
      d.domain === C.DOMAIN && d.namespace === C.NAMESPACES.BUDGET;
  })());
check('D14.24 evaluateBudget 是纯函数：同输入同输出，且不读时钟 / 随机 / 全局状态',
  (() => {
    const policy = C.validateBudgetPolicy({
      policyId: 'econ_policy_p1', ownerId: 'cfg_a', currency: 'IB_CREDIT', status: 'ACTIVE',
      termEndsAt: null,
      limits: { perTransactionMinor: 300, dailyMinor: 500, weeklyMinor: 1000, monthlyMinor: 2000, approvalThresholdMinor: 200 }
    });
    const ctx = {
      ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100,
      walletState: 'READY', timestamp: Date.UTC(2024, 0, 1, 12),
      usage: { spentTodayMinor: 0, spentThisWeekMinor: 0, spentThisMonthMinor: 0 },
      limits: { availableBalanceMinor: 1000 }
    };
    const a = JSON.stringify(C.evaluateBudget(policy.policy, ctx));
    const b = JSON.stringify(C.evaluateBudget(policy.policy, ctx));
    const c = JSON.stringify(C.evaluateBudget(policy.policy, JSON.parse(JSON.stringify(ctx))));
    return a === b && b === c && C.evaluateBudget(policy.policy, ctx).outcome === 'ALLOW';
  })());
check('D14.25 契约的输入白名单仍然是 Budget 的唯一入口（maxBudget / prompt 在类型上无处可放）',
  !okResult(C.normalizeBudgetInput({ ownerId: 'cfg_a', maxBudget: 100 })) &&
  !okResult(C.normalizeBudgetInput({ ownerId: 'cfg_a', prompt: 'please buy it' })) &&
  !okResult(C.normalizeBudgetInput({ ownerId: 'cfg_a', relationship: { trust: 0.9 } })) &&
  C.FORBIDDEN_POLICY_INPUT_KEYS.indexOf('prompt') >= 0 &&
  C.FORBIDDEN_POLICY_INPUT_KEYS.indexOf('llmOutput') >= 0);
check('D14.26 P22-3 的 OPERATION_SCOPE 五元集合是**子集**（加 scope 不是换 scope）',
  ['RESERVE', 'COMMIT', 'RELEASE', 'EXPIRE', 'FAIL'].every(s => C.OPERATION_SCOPES.indexOf(s) >= 0) &&
  ['QUOTE', 'POLICY'].every(s => C.OPERATION_SCOPES.indexOf(s) >= 0) &&
  ['STORE', 'PRODUCT', 'INVENTORY_GRANT', 'INVENTORY_CONSUME'].every(s => C.OPERATION_SCOPES.indexOf(s) >= 0) &&
  ['PURCHASE_PREPARE', 'PURCHASE_SETTLE'].every(s => C.OPERATION_SCOPES.indexOf(s) >= 0) &&
  ['APPROVAL_REQUEST', 'APPROVAL_DECIDE', 'APPROVAL_CONSUME', 'AUTONOMY_POLICY']
    .every(s => C.OPERATION_SCOPES.indexOf(s) >= 0) &&
  C.OPERATION_SCOPES.length === 17);
check('D14.26b P22-7 的十个新事件全部登记，且 P22-6 的五个 purchase 事件一个都没丢',
  ['AUTONOMY_POLICY_CREATED', 'AUTONOMY_POLICY_UPDATED',
    'APPROVAL_REQUESTED', 'APPROVAL_APPROVED', 'APPROVAL_REJECTED',
    'APPROVAL_EXPIRED', 'APPROVAL_CONSUMED',
    'PURCHASE_AUTHORIZED', 'AUTONOMY_PURCHASE_AUTO_ALLOWED',
    'AUTONOMY_PURCHASE_REQUIRES_APPROVAL'].every(t => C.isEconomyEventType(t)) &&
  ['PURCHASE_CREATED', 'PURCHASE_RESERVED', 'PURCHASE_COMPLETED',
    'PURCHASE_RELEASED', 'PURCHASE_FAILED'].every(t => C.isEconomyEventType(t)) &&
  /* 词表是封闭的：没有"泛化批准事件"这种兜底名字。 */
  C.EVENT_TYPES.indexOf('APPROVAL_UPDATED') < 0 &&
  C.EVENT_TYPES.indexOf('APPROVAL_DECIDED') < 0 &&
  C.EVENT_TYPES.indexOf('AUTONOMY_DECIDED') < 0);
check('D14.27 P22-4 的八个新事件全部登记，且 P22-1 的十一个事件一个都没丢',
  ['BUDGET_POLICY_CREATED', 'BUDGET_POLICY_UPDATED', 'BUDGET_POLICY_DISABLED', 'BUDGET_POLICY_EXPIRED',
    'QUOTE_CREATED', 'QUOTE_EXPIRED', 'QUOTE_CONSUMED', 'QUOTE_CANCELLED'].every(t => C.isEconomyEventType(t)) &&
  ['WALLET_OPENED', 'TRANSACTION_CREATED', 'PURCHASE_COMMITTED', 'PURCHASE_DENIED',
    'ITEM_GIFTED', 'ITEM_CONSUMED', 'COMPUTE_CREDIT_GRANTED', 'COMPUTE_CREDIT_CONSUMED',
    'EXCHANGE_COMMITTED', 'MINT_COMMITTED', 'BURN_COMMITTED'].every(t => C.isEconomyEventType(t)));
check('D14.28 十五种 id 种类（P22-5 加 STORE，P22-7 加 APPROVAL），BUDGET_POLICY / QUOTE / PRODUCT / INVENTORY_ENTRY 的前缀在 P22-1 就已冻结',
  C.ID_KINDS.length === 15 &&
  C.ID_PREFIX.STORE === 'econ_store_' &&
  C.ID_PREFIX.BUDGET_POLICY === 'econ_policy_' && C.ID_PREFIX.QUOTE === 'econ_quote_' &&
  /* P22-5 第一次真的写下一行 product / inventory，而它们的**形状**在
     P22-1 就被冻结了 —— 实现时不需要发明任何新的 id 形状。 */
  C.ID_PREFIX.PRODUCT === 'econ_product_' && C.ID_PREFIX.INVENTORY_ENTRY === 'econ_inv_' &&
  C.isEconomyId('STORE', 'econ_store_s1') === true &&
  C.isEconomyId('STORE', 'econ_policy_x1') === false &&
  C.isEconomyId('PRODUCT', 'econ_product_p1') === true &&
  C.isEconomyId('INVENTORY_ENTRY', 'econ_inv_i1') === true &&
  C.isEconomyId('BUDGET_POLICY', 'econ_policy_x1') === true &&
  C.isEconomyId('QUOTE', 'econ_quote_q1') === true &&
  C.isEconomyId('QUOTE', 'econ_policy_x1') === false);
check('D14.33 P22-7 的 APPROVAL 命名空间与 BUDGET / QUOTE / PURCHASE 命名空间是四个不同的字面值',
  C.NAMESPACES.APPROVAL === 'ib.economy.approval' &&
  C.NAMESPACES.APPROVAL !== C.NAMESPACES.PURCHASE &&
  C.NAMESPACES.APPROVAL !== C.NAMESPACES.BUDGET &&
  /* ★ 自主策略**复用** BUDGET 命名空间是刻意的：它与预算政策共用同一种
     记录形状；它需要自己的**事件**名，但不需要第二个命名空间。 */
  C.NAMESPACES.BUDGET === 'ib.economy.budget' &&
  C.ID_PREFIX.APPROVAL === 'econ_approval_');
check('D14.29 政策 / 报价命名空间在 P22-1 就已存在，P22-4 没有新造子域',
  C.NAMESPACES.BUDGET === 'ib.economy.budget' && C.NAMESPACES.QUOTE === 'ib.economy.quote' &&
  C.NAMESPACES.STORE === 'ib.economy.store');
check('D14.30 依赖矩阵未被 P22-4 改动：Economy 的出边仍然一条"允许写"都没有',
  C.DEPENDENCY_MATRIX.filter(r => r.from === 'Economy').length === 8 &&
  C.DEPENDENCY_MATRIX.filter(r => r.from === 'Economy')
    .every(r => r.rule !== 'WRITE' && r.rule !== 'ALLOWED'));
check('D14.31 评估结果里**没有**任何叫 authorization 的字段（不与凭据边界在文本上撞车）',
  (() => {
    const keys = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 3) return;
      for (const k of Object.keys(o)) { keys.push(k); walk(o[k], depth + 1); }
    };
    walk(C.budgetDecision(C.BUDGET_DECISION.DENY, 'DAILY_LIMIT', { errors: ['x'] }), 0);
    return keys.every(k => !/authorization/i.test(k)) && keys.indexOf('snapshot') >= 0;
  })());

/* ══════════════════════════════════════════════════════════════════
   D-ADDITIVE-P22-5 · P22-5 的加法（逐项）
   ══════════════════════════════════════════════════════════════════ */
/* P22-5 往契约里加了东西，而"加了什么"必须是一条**可执行**的清单：
   每一项都在下面被点名，因此"某个字段其实是 P22-5 顺手改的旧语义"
   会在这里失败，而不是在下一次读代码时被发现。 */
section('D-ADDITIVE-P22-5 · 目录 / 库存的封闭词表与纯函数');

check('D22.1 ID_PREFIX.STORE = econ_store_，且它与既有的十四种互不相同',
  C.ID_PREFIX.STORE === 'econ_store_' &&
  C.ID_KINDS.filter(k => C.ID_PREFIX[k] === 'econ_store_').length === 1);
check('D22.2 STORE_STATUS 是封闭二元集合（刻意不复用 POLICY_STATUS）',
  C.STORE_STATUSES.length === 2 && C.isStoreStatus('ACTIVE') === true &&
  C.isStoreStatus('RETIRED') === false && C.isStoreStatus('active') === false);
check('D22.3 PRODUCT_STATUS 是封闭三元集合，RETIRED 是**唯一**终态',
  C.PRODUCT_STATUSES.slice().sort().join(',') === 'ACTIVE,DISABLED,RETIRED' &&
  C.PRODUCT_TERMINAL_STATUSES.length === 1 && C.PRODUCT_TERMINAL_STATUSES[0] === 'RETIRED');
check('D22.4 商品状态机：ACTIVE↔DISABLED 往返，RETIRED 回不来（"退役后重新上架"被拒绝）',
  C.canTransitionProductStatus('ACTIVE', 'DISABLED').allowed === true &&
  C.canTransitionProductStatus('DISABLED', 'ACTIVE').allowed === true &&
  C.canTransitionProductStatus('ACTIVE', 'RETIRED').allowed === true &&
  C.canTransitionProductStatus('DISABLED', 'RETIRED').allowed === true &&
  C.canTransitionProductStatus('RETIRED', 'ACTIVE').allowed === false &&
  C.canTransitionProductStatus('RETIRED', 'DISABLED').allowed === false &&
  C.assertProductStatusTransition('RETIRED', 'ACTIVE').detail ===
    'a-retired-product-is-terminal-and-must-not-be-relisted');
check('D22.5 商品状态机的"未登记状态"也失败（不是只有非法转移才失败）',
  C.canTransitionProductStatus('ACTIVE', 'ON_SALE').ok === false &&
  C.canTransitionProductStatus('ON_SALE', 'ACTIVE').ok === false);
check('D22.6 PRODUCT_KIND 的五个成员各自映射到 **P22-1 已冻结**的语义（没有新造经济概念）',
  C.PRODUCT_KINDS.slice().sort().join(',') === 'API_QUOTA,COMPUTE_CREDIT,CONSUMABLE,DIGITAL_ITEM,SERVICE' &&
  C.fulfillmentOfProductKind('DIGITAL_ITEM') === C.FULFILLMENT.INVENTORY_GRANT &&
  C.fulfillmentOfProductKind('CONSUMABLE') === C.FULFILLMENT.INVENTORY_GRANT &&
  C.fulfillmentOfProductKind('API_QUOTA') === C.FULFILLMENT.COMPUTE_GRANT &&
  C.fulfillmentOfProductKind('COMPUTE_CREDIT') === C.FULFILLMENT.COMPUTE_GRANT &&
  C.fulfillmentOfProductKind('SERVICE') === C.FULFILLMENT.SERVICE_EXECUTION &&
  C.fulfillmentOfProductKind('RPG_SWORD') === null);
check('D22.7 交付形态的三个成员都**至少**被一个 kind 用到（SERVICE_EXECUTION 不是死分支）',
  C.FULFILLMENTS.slice().sort().join(',') === 'COMPUTE_GRANT,INVENTORY_GRANT,SERVICE_EXECUTION' &&
  C.FULFILLMENTS.every(f => C.PRODUCT_KINDS.some(k => C.fulfillmentOfProductKind(k) === f)));
check('D22.8 SERVICE 商品**没有** assetKind（交付形态是执行，不是持有）',
  C.assetKindOfProductKind('SERVICE') === null &&
  C.ASSET_KIND_OF_PRODUCT_KIND.SERVICE === null &&
  C.assetKindOfProductKind('API_QUOTA') === C.ASSET_KIND.COMPUTE &&
  C.assetKindOfProductKind('DIGITAL_ITEM') === C.ASSET_KIND.ITEM &&
  C.ASSET_KINDS.length === 2);
check('D22.9 唯一物品在本阶段**不可表示**（一条显式否认，而不是"忘了"）',
  C.INVENTORY_UNIQUE_ITEMS_MODELLED === false &&
  C.ASSET_KINDS.indexOf('UNIQUE_ITEM') < 0 &&
  C.ASSET_KINDS.indexOf('INSTANCE') < 0);
check('D22.10 库存的 canonical 键是 (ownerId, productId) —— 一张**数据**表，不是注释',
  C.INVENTORY_CANONICAL_KEY.length === 2 &&
  C.INVENTORY_CANONICAL_KEY.indexOf('ownerId') >= 0 &&
  C.INVENTORY_CANONICAL_KEY.indexOf('productId') >= 0 &&
  Object.isFrozen(C.INVENTORY_CANONICAL_KEY));
check('D22.11 compute 两类商品的单位名必须恰是 §16 冻结的 computeUnit',
  C.unitNameOfProductKind('API_QUOTA') === C.COMPUTE_UNIT_NAME &&
  C.unitNameOfProductKind('COMPUTE_CREDIT') === C.COMPUTE_UNIT_NAME &&
  C.COMPUTE_UNIT_NAME === 'computeUnit');
check('D22.12 validateProduct：compute 商品用 tokens / usd 这类别名做单位会被拒绝',
  !okResult(C.validateProduct({
    storeId: 'econ_store_s1', kind: 'API_QUOTA', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1, unitName: 'tokens'
  })) &&
  !okResult(C.validateProduct({
    storeId: 'econ_store_s1', kind: 'API_QUOTA', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1, unitName: 'providerBalance'
  })) &&
  okResult(C.validateProduct({
    storeId: 'econ_store_s1', kind: 'API_QUOTA', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1
  })));
check('D22.13 validateProduct：unitPriceMinor = 0 是**显式合法值**，缺失才是错误（truthiness 陷阱不在代码里）',
  okResult(C.validateProduct({
    storeId: 'econ_store_s1', kind: 'DIGITAL_ITEM', name: 'free', currency: 'IB_CREDIT',
    unitPriceMinor: 0, grantQuantity: 1
  })) &&
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'DIGITAL_ITEM', name: 'x', currency: 'IB_CREDIT', grantQuantity: 1
  }).errors.indexOf('product-unit-price-minor-required') >= 0 &&
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'DIGITAL_ITEM', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: -1, grantQuantity: 1
  }).errors.indexOf('amount-minor-negative') >= 0);
check('D22.14 validateProduct：SERVICE 的 grantQuantity 必须是 0（"多写一个 5"会被拒绝）',
  okResult(C.validateProduct({
    storeId: 'econ_store_s1', kind: 'SERVICE', name: 'svc', currency: 'IB_CREDIT',
    unitPriceMinor: 100, grantQuantity: 0
  })) &&
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'SERVICE', name: 'svc', currency: 'IB_CREDIT',
    unitPriceMinor: 100, grantQuantity: 5
  }).errors.indexOf('a-service-product-must-not-grant-inventory-quantity') >= 0 &&
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'DIGITAL_ITEM', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: 100, grantQuantity: 0
  }).errors.indexOf('product-grant-quantity-must-be-positive') >= 0);
check('D22.15 validateProduct：交付形态是**派生**的 —— 声明一个与 kind 不符的 fulfillment 会被拒绝',
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'SERVICE', name: 'svc', currency: 'IB_CREDIT',
    unitPriceMinor: 100, grantQuantity: 0, fulfillment: 'INVENTORY_GRANT'
  }).errors.indexOf('product-fulfillment-does-not-match-the-product-kind') >= 0);
check('D22.16 FORBIDDEN_PRODUCT_FIELDS：provider / 真实货币 / 折扣 / 推荐 / 关系 逐个点名，且都是**数据**',
  ['providerApiKey', 'providerBalance', 'providerTopup', 'checkoutUrl', 'paymentIntent',
    'realMoney', 'cny', 'usd', 'discount', 'coupon', 'featured', 'recommended',
    'trust', 'affection', 'relationshipId', 'prompt', 'llmOutput', 'price', 'cost', 'budget']
    .every(f => C.isForbiddenProductFieldName(f) === true) &&
  C.isForbiddenProductFieldName('unitPriceMinor') === false);
check('D22.17 validateProduct 的键白名单：传 price / discount / trust 一律拒绝（不是静默忽略）',
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'DIGITAL_ITEM', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1, price: 1
  }).errors.indexOf('product-input-key-is-forbidden:price') >= 0 &&
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'DIGITAL_ITEM', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1, discount: 0.8
  }).errors.indexOf('product-input-key-is-forbidden:discount') >= 0 &&
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'DIGITAL_ITEM', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1, trust: 0.9
  }).errors.indexOf('product-input-key-is-forbidden:trust') >= 0 &&
  C.validateProduct({
    storeId: 'econ_store_s1', kind: 'DIGITAL_ITEM', name: 'x', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1, whatever: 1
  }).errors.indexOf('product-input-key-not-whitelisted:whatever') >= 0);
check('D22.18 PRICING_IS_RELATIONSHIP_FREE 是一条可断言的常量（§41 的机器可读形式）',
  C.PRICING_IS_RELATIONSHIP_FREE === true &&
  typeof C.PRICING_IS_RELATIONSHIP_FREE === 'boolean');
check('D22.19 productQuoteKindFor：compute 额度报价是 COMPUTE_GRANT，其余由"有没有受赠人"决定',
  C.productQuoteKindFor(C.FULFILLMENT.COMPUTE_GRANT, false).kind === C.QUOTE_KIND.COMPUTE_GRANT &&
  C.productQuoteKindFor(C.FULFILLMENT.COMPUTE_GRANT, true).kind === C.QUOTE_KIND.COMPUTE_GRANT &&
  C.productQuoteKindFor(C.FULFILLMENT.INVENTORY_GRANT, false).kind === C.QUOTE_KIND.PURCHASE &&
  C.productQuoteKindFor(C.FULFILLMENT.INVENTORY_GRANT, true).kind === C.QUOTE_KIND.GIFT &&
  C.productQuoteKindFor(C.FULFILLMENT.SERVICE_EXECUTION, false).kind === C.QUOTE_KIND.PURCHASE &&
  C.productQuoteKindFor('NOT_A_FULFILLMENT', false).ok === false);
check('D22.20 productQuoteQuantity：API_QUOTA ×1000 的报价数量是 1000（送达量，不是份数）',
  C.productQuoteQuantity({ kind: 'API_QUOTA', grantQuantity: 1000 }, 1).quantity === 1000 &&
  C.productQuoteQuantity({ kind: 'API_QUOTA', grantQuantity: 1000 }, 3).quantity === 3000 &&
  C.productQuoteQuantity({ kind: 'DIGITAL_ITEM', grantQuantity: 1 }, 5).quantity === 5 &&
  /* 服务商品：grantQuantity 必须是 0，而 §14 要求报价数量 ≥ 1，
     因此它的数量只能表达"执行几次" —— 那是它唯一有意义的数量。 */
  C.productQuoteQuantity({ kind: 'SERVICE', grantQuantity: 0 }, 2).quantity === 2 &&
  C.productQuoteQuantity({ kind: 'API_QUOTA', grantQuantity: 1000 }, 0).ok === false);
check('D22.21 productQuoteAmountMinor：金额是 BigInt，溢出**拒绝**而不是静默变形',
  C.productQuoteAmountMinor({ unitPriceMinor: 400 }, 1).amountMinor === 400n &&
  C.productQuoteAmountMinor({ unitPriceMinor: 100 }, 3).amountMinor === 300n &&
  C.productQuoteAmountMinor({ unitPriceMinor: 0 }, 1).amountMinor === 0n &&
  C.productQuoteAmountMinor({ unitPriceMinor: C.MAX_AMOUNT_MINOR }, 2).ok === false &&
  C.productQuoteAmountMinor({ unitPriceMinor: 1 }, 2 ** 53).ok === false);
check('D22.22 QUOTE_PRODUCT_RELATION：报价与商品的关系是**显式二选一**，而 P22-5 选了 PROVENANCE_ONLY',
  C.QUOTE_PRODUCT_RELATION.PROVENANCE_ONLY === 'PROVENANCE_ONLY' &&
  C.QUOTE_PRODUCT_RELATION.DEPENDENCY === 'DEPENDENCY' &&
  C.PRODUCT_IS_PROVENANCE_FOR_QUOTES === true);
check('D22.23 P22-5 的八个新事件全部登记，且 P22-4 的十九个事件一个都没丢',
  ['STORE_CREATED', 'STORE_UPDATED', 'PRODUCT_CREATED', 'PRODUCT_UPDATED',
    'PRODUCT_DISABLED', 'PRODUCT_RETIRED', 'INVENTORY_GRANTED', 'INVENTORY_CONSUMED']
    .every(t => C.isEconomyEventType(t)) &&
  ['BUDGET_POLICY_CREATED', 'QUOTE_CREATED', 'QUOTE_EXPIRED', 'QUOTE_CONSUMED',
    'WALLET_OPENED', 'TRANSACTION_CREATED', 'PURCHASE_COMMITTED', 'MINT_COMMITTED']
    .every(t => C.isEconomyEventType(t)) &&
  C.isEconomyEventType('STORE_DELETED') === false &&
  /* §23：不存在"删除历史"的事件类型 —— 下架由状态表达。 */
  C.isEconomyEventType('PRODUCT_DELETED') === false &&
  C.isEconomyEventType('INVENTORY_DELETED') === false);
check('D22.24 P22-5 的五个新 reason code 各自可判定，且仍然没有兜底值',
  ['INSUFFICIENT_INVENTORY', 'PRODUCT_NOT_FOUND', 'STORE_NOT_FOUND',
    'CATALOG_INPUT_NOT_STRUCTURED', 'INVENTORY_INPUT_NOT_STRUCTURED']
    .every(r => C.isDenyReasonCode(r)) &&
  C.DENY_REASONS.indexOf('OTHER') < 0 && C.DENY_REASONS.indexOf('UNKNOWN') < 0 &&
  C.DENY_REASONS.indexOf('NOT_FOUND') < 0);
/* ── D22.25 / D22.26：这两条在**本文件**里刻意只做对象级断言 ───────────
   "契约源码里没有时钟 / 随机 / require / DELETE FROM" 是**静态**性质，
   而本文件不读文件（它只 require 契约本身，与 P22-1 的原始设计一致：
   纯运行时契约测试）。那两条静态断言放在 boundary 文件里，由 B22 组
   在**真实源码**上执行 —— 那里本来就有剥注释与字符串的扫描器。
   放两份会让"哪一份是真的"变成一个需要回答的问题。 */
check('D22.25 契约的导出面仍然是**冻结**的，且 P22-5 的新函数全是纯函数（不改入参、不返回引用）',
  Object.isFrozen(C) &&
  (() => {
    const input = Object.freeze({ kind: 'API_QUOTA', grantQuantity: 1000, unitPriceMinor: 400 });
    const q = C.productQuoteQuantity(input, 2);
    const a = C.productQuoteAmountMinor(input, 2);
    /* 入参是 frozen 的：一个会就地改写的实现会在这里抛 TypeError。 */
    return q.quantity === 2000 && a.amountMinor === 800n &&
      q.quantity !== input.grantQuantity && a.amountMinor !== input.unitPriceMinor;
  })());
check('D22.26 契约里没有"删除历史"的状态：store/product/inventory 的生命周期只由状态表达',
  C.PRODUCT_STATUS_TRANSITIONS.RETIRED.length === 0 &&
  C.STORE_STATUSES.indexOf('DELETED') < 0 &&
  C.PRODUCT_STATUSES.indexOf('DELETED') < 0 &&
  C.EVENT_TYPES.indexOf('STORE_DELETED') < 0 &&
  C.EVENT_TYPES.indexOf('PRODUCT_DELETED') < 0 &&
  C.EVENT_TYPES.indexOf('INVENTORY_DELETED') < 0);

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(64));
if (failures === 0) {
  console.log('P22-1 domain contract: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-1 domain contract: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
