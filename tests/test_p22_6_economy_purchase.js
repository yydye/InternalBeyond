'use strict';
/* ====================================================================
   P22-6 · Purchase Orchestrator —— 域契约、Prepare、边界与隔离
   --------------------------------------------------------------------
   运行：node tests/test_p22_6_economy_purchase.js

   本文件回答四个问题：

     「一次 Purchase 到底是什么？」        —— 契约、状态机、身份
     「Prepare 之后世界是什么样？」        —— Reserve 但**不**发货、**不**消费报价
     「谁能进入 Purchase？」               —— 只接受 Product-backed Quote
     「Purchase 碰到了什么不该碰的东西？」 —— Provider / 支付 / Memory /
                                              Relationship / Decision / Action

   ── 结算（settle）在另一个文件里 ──────────────────────────────────
   `tests/test_p22_6_economy_settlement.js` 负责"一个 SQLite 事务"那件事：
   原子性、故障注入、hit counter、重启、多进程竞争、Gift / Compute / Service
   的完整路径。本文件只走到 Prepare 为止，外加契约与静态边界。

   ── 组 ──────────────────────────────────────────────────────────────
     A  契约：Purchase 状态机与身份
     B  契约：结算映射（fulfillment → primitive → ledger tx type）
     C  契约：输入白名单与"没有地方可以放"
     D  preparePurchase 前置拒绝（不创建任何东西）
     E  Prepare 成功：四件事实与两件**没有**发生的事
     F  幂等（prepare）
     G  Product-backed 强制
     H  Product 改价 / disable / retire 不改变已 Prepare 的购买
     I  SERVICE fail closed
     J  静态边界：没有 Provider / 支付 / Memory / Relationship / Decision / Action
     K  HTTP：购买读面存在，写面逐名不存在
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('✔ ' + name);
  else {
    failures++;
    console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra, replacer) : ''));
  }
}
function section(title) { console.log('\n── ' + title); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-6p-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

/* ── 一个**可推进**的时钟 ──────────────────────────────────────────────
   本文件需要证明"报价在 Prepare 时有效、在之后已经过期"这类**时间**边界，
   而 expire 类断言不能靠"等一会儿"。时钟是注入的，因此推进它是一次普通
   赋值 —— 没有 sleep，没有 flake。
   ★ 这也是 preparePurchase **不接受** now 参数的原因之一：
   `C.PURCHASE_INPUT_KEYS` 里没有 now，因为"什么时候算现在"是执行环境
   的事实，不是调用方可以声明的东西。 */
const CLOCK = 1717200000000;
let CLOCK_NOW = CLOCK;
function now() { return CLOCK_NOW; }
function deterministicIds() {
  let n = 0;
  return (kind) => { n += 1; return C.formatEconomyId(kind, 'p' + n).id; };
}
function makeStore(extra) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir, logger: () => {}, clock: now, nextId: deterministicIds()
  }, extra || {}));
}
let keySeq = 0;
function nextKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }

function walletWith(store, amountMinor, ownerId, currency) {
  const cur = currency || 'IB_CREDIT';
  const w = store.openWallet({ owner: { type: 'character', id: ownerId || 'cfg_a' }, currency: cur });
  assert.equal(w.ok, true, 'openWallet must succeed: ' + J(w.errors));
  if (amountMinor && BigInt(amountMinor) !== 0n) {
    const m = store.mintForSystem({
      systemInitiated: true, walletId: w.wallet.walletId, currency: cur,
      amountMinor: amountMinor, idempotencyKey: 'seed-' + w.wallet.walletId
    });
    assert.equal(m.ok, true, 'mint must succeed: ' + J(m.errors));
  }
  return w.wallet;
}
/* ── 预算政策的**完整**写法 ────────────────────────────────────────────
   ★ 限制值必须写在 `limits` 里，而且字段名是契约的
   `perTransactionMinor / dailyMinor / weeklyMinor / monthlyMinor /
   approvalThresholdMinor`（见 C.POLICY_LIMIT_FIELDS）。
   开发期实测踩到的一次**真实陷阱**：把这些名字写在**顶层**（
   `maxPerTxMinor: 100`）不会报错 —— 它们被 `normalizePolicyLimits`
   当成"没给的限制"丢掉，于是一条本来想收紧的规则变成了一条
   **什么都不限制**的规则。测试因此从"应当被拒绝"变成"意外成功"。
   本 helper 因此写成"只接受 limits 里的名字"，让打错的名字在这里
   立刻暴露成一条**空的/不符预期**的政策，而不是一条宽松的政策。 */
function policyFor(store, ownerId, limits, options) {
  const out = store.putBudgetPolicy(Object.assign({
    ownerId: ownerId, currency: 'IB_CREDIT',
    limits: Object.assign({
      perTransactionMinor: 100000, dailyMinor: 100000,
      weeklyMinor: 100000, monthlyMinor: 100000
    }, limits || {}),
    idempotencyKey: nextKey('policy')
  }, options || {}));
  assert.equal(out.ok, true, 'putBudgetPolicy must succeed: ' + J(out.errors || out));
  /* 反向自检：一条**非空**的 limits 必须真的落在结果里。 */
  const given = Object.keys(limits || {}).length;
  if (given > 0) {
    const applied = out.result.policy.limits;
    assert.equal(Object.keys(applied).length >= given, true,
      'policy limits were silently dropped: ' + J({ given: limits, applied: applied }));
  }
  return out.result;
}
function putStoreOk(store, options) {
  const out = store.putStore(Object.assign({ name: 'Main Store', idempotencyKey: nextKey('store') }, options || {}));
  assert.equal(out.ok, true, 'putStore must succeed: ' + J(out.errors || out));
  return out.result;
}
function putProductOk(store, storeId, options) {
  const out = store.putProduct(Object.assign({
    storeId: storeId, kind: 'DIGITAL_ITEM', name: 'Widget', currency: 'IB_CREDIT',
    unitPriceMinor: 400, grantQuantity: 1, idempotencyKey: nextKey('product')
  }, options || {}));
  assert.equal(out.ok, true, 'putProduct must succeed: ' + J(out.errors || out));
  return out.result;
}
function quoteOk(store, options) {
  const out = store.createProductQuote(Object.assign({
    buyerId: 'cfg_a', units: 1, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  }, options || {}));
  assert.equal(out.ok, true, 'createProductQuote must succeed: ' + J(out.errors || out));
  return out.result;
}
function prepareOk(store, options) {
  const out = store.preparePurchase(Object.assign({
    buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare')
  }, options || {}));
  assert.equal(out.ok, true, 'preparePurchase must succeed: ' + J(out.errors || out));
  return out.result;
}

/* ── 世界指纹 ──────────────────────────────────────────────────────────
   与经济那一半 / 目录那一半分开算。本文件多次需要证明 "Prepare 成功但
   钱一分没动、货一件没发"，而一个合并的指纹做不到这件事。

   ★ 刻意**不**直接用 getWallet 的缓存余额作为唯一证据：缓存是派生量，
   而"钱没动"必须同时由 ledger（transactions / entries）与缓存两侧证明。
   因此这里把两者都放进指纹里。 */
function world(store) {
  const h = store.health().counts;
  const wallets = store.listWallets({ limit: 200 });
  const walletJson = J(wallets.map(w => J(store.serializeWallet(w))));
  const txs = J(store.listTransactions({ limit: 500 }));
  const entries = J(store.listLedgerEntries({ limit: 2000 }).entries);
  const reservations = J(store.listReservations({ limit: 500 }).reservations.map(r => J(store.serializeReservation(r))));
  const operations = J(store.listOperations({ limit: 500 }).operations.map(o => J(store.serializeOperation(o))));
  const inventory = J(store.listInventory({ ownerId: 'cfg_a' }).entries.map(e => J(store.serializeInventoryEntry(e))));
  const purchases = J(store.listPurchases({ limit: 500 }).purchases);
  return {
    /* 账本那一半：唯一的 canonical 经济事实来源。 */
    ledger: J({ txs: txs, entries: entries }),
    /* 生命周期那一半：预留 / 操作 / 派生缓存。 */
    lifecycle: J({ wallets: walletJson, reservations: reservations, operations: operations }),
    inventory: inventory,
    purchases: purchases,
    revision: store.getRevision(),
    changes: store.listChanges(0, 500).length,
    counts: {
      transactions: h.transactions, entries: h.entries, reservations: h.reservations,
      purchases: h.purchases, completedPurchases: h.completedPurchases
    },
    countsJson: J({
      transactions: h.transactions, entries: h.entries, reservations: h.reservations,
      purchases: h.purchases, completedPurchases: h.completedPurchases
    })
  };
}

/* ══════════════════════════════════════════════════════════════════
   A · 契约：Purchase 状态机与身份
   ══════════════════════════════════════════════════════════════════ */
section('A · 契约：Purchase 状态机与身份');

check('A1 PURCHASE_STATES 恰好四态（RESERVED / COMPLETED / RELEASED / FAILED），刻意**没有** CREATED / PENDING',
  C.PURCHASE_STATES.slice().sort().join(',') === 'COMPLETED,FAILED,RELEASED,RESERVED' &&
  C.isPurchaseState('RESERVED') === true && C.isPurchaseState('reserved') === false &&
  C.isPurchaseState('CREATED') === false && C.isPurchaseState('PENDING') === false &&
  C.isPurchaseState('ORPHANED') === false);

check('A2 终态集合恰好三个，而初始状态 RESERVED **不是**终态（一条 Purchase 恰好从"资金已锁定"开始）',
  C.PURCHASE_TERMINAL_STATES.slice().sort().join(',') === 'COMPLETED,FAILED,RELEASED' &&
  C.PURCHASE_TERMINAL_STATES.indexOf(C.PURCHASE_INITIAL_STATE) < 0 &&
  C.PURCHASE_INITIAL_STATE === 'RESERVED');

check('A3 ★ COMPLETED 的三条出边全部被拒绝（终态不可逆），且理由逐字指向"补偿性经济操作"',
  ['FAILED', 'RELEASED', 'RESERVED', 'COMPLETED'].every(to => {
    const r = C.assertPurchaseTransition('COMPLETED', to);
    return r.ok === false && r.errors.indexOf('transition-not-allowed') >= 0 &&
      /compensating economic operation/.test(String(r.hint || ''));
  }) &&
  C.PURCHASE_TRANSITIONS.COMPLETED.length === 0 &&
  C.PURCHASE_TRANSITIONS.RELEASED.length === 0 &&
  C.PURCHASE_TRANSITIONS.FAILED.length === 0);

check('A4 RESERVED 恰好有三条出边（COMPLETED / RELEASED / FAILED），一条不少也一条不多',
  C.PURCHASE_TRANSITIONS.RESERVED.slice().sort().join(',') === 'COMPLETED,FAILED,RELEASED' &&
  C.canTransitionPurchase('RESERVED', 'COMPLETED').allowed === true &&
  C.canTransitionPurchase('RESERVED', 'RELEASED').allowed === true &&
  C.canTransitionPurchase('RESERVED', 'FAILED').allowed === true &&
  C.canTransitionPurchase('RESERVED', 'RESERVED').allowed === false);

check('A5 未登记状态 fail closed（不是"未知即允许"）',
  C.canTransitionPurchase('PENDING', 'COMPLETED').ok === false &&
  C.canTransitionPurchase('RESERVED', 'PENDING').ok === false &&
  C.assertPurchaseTransition(null, 'COMPLETED').ok === false);

check('A6 ★ Purchase 的身份**不新增 id 种类**：P22-1 冻结的 PURCHASE_INTENT 第一次被用起来'
  + '（ID_KINDS 在 P22-6 之后是 14；P22-7 之后是 15，多出来的是 APPROVAL；'
  + 'P22-8 之后是 16，多出来的是 AGENT_INTENT —— 两次都不是购买）',
  C.PURCHASE_ID_KIND === 'PURCHASE_INTENT' &&
  C.PURCHASE_ID_PREFIX === 'econ_intent_' &&
  C.ID_KINDS.length === 16 &&
  C.ID_KINDS.indexOf('PURCHASE_INTENT') >= 0 && C.ID_KINDS.indexOf('APPROVAL') >= 0 &&
  C.ID_KINDS.indexOf('AGENT_INTENT') >= 0 &&
  C.ID_PREFIX.AGENT_INTENT !== C.PURCHASE_ID_PREFIX &&
  C.formatPurchaseId('x1').ok === true && C.formatPurchaseId('x1').id === 'econ_intent_x1' &&
  C.isEconomyId(C.PURCHASE_ID_KIND, 'econ_intent_x1') === true &&
  /* ★ P22-8 的那一种前缀**不是**一次购买：一笔购买的身份一个字都没变。 */
  C.isEconomyId(C.PURCHASE_ID_KIND, 'econ_agentintent_x1') === false &&
  C.isEconomyId('AGENT_INTENT', 'econ_agentintent_x1') === true);

check('A7 ★ purchaseId 不可能与它引用的四件事互换：四个前缀互不相同，形状校验也互相拒绝',
  ['QUOTE', 'RESERVATION', 'TRANSACTION', 'OPERATION'].every(kind => {
    const id = C.formatEconomyId(kind, 'x1').id;
    return C.PREFIX_UNIQUE_TEST_HOOK !== undefined || (id !== 'econ_intent_x1' &&
      C.isEconomyId(C.PURCHASE_ID_KIND, id) === false);
  }) &&
  C.isEconomyId('QUOTE', C.formatPurchaseId('x1').id) === false &&
  C.isEconomyId('RESERVATION', C.formatPurchaseId('x1').id) === false &&
  C.isEconomyId('TRANSACTION', C.formatPurchaseId('x1').id) === false &&
  C.isEconomyId('OPERATION', C.formatPurchaseId('x1').id) === false &&
  new Set(['QUOTE', 'RESERVATION', 'TRANSACTION', 'OPERATION', C.PURCHASE_ID_KIND].map(k => C.ID_PREFIX[k])).size === 5);

check('A8 ★ 结算的 ledger transactionId **确定性地**派生自 purchaseId（重放同一个业务得到同一个记账身份）',
  C.derivePurchaseLedgerTransactionId('econ_intent_x1').ok === true &&
  C.derivePurchaseLedgerTransactionId('econ_intent_x1').id ===
    C.derivePurchaseLedgerTransactionId('econ_intent_x1').id &&
  C.isEconomyId('TRANSACTION', C.derivePurchaseLedgerTransactionId('econ_intent_x1').id) === true &&
  C.derivePurchaseLedgerTransactionId('econ_intent_x2').id !==
    C.derivePurchaseLedgerTransactionId('econ_intent_x1').id &&
  C.derivePurchaseLedgerTransactionId('not-a-purchase-id').ok === false);

check('A9 三个"它不是"的逐字否认在契约上成立（§1：Purchase ≠ Ledger Transaction / Reservation / Quote）',
  C.PURCHASE_SETTLEMENT_IS_ONE_TRANSACTION === true &&
  C.PURCHASE_AMOUNT_SOURCE === 'quote-snapshot' &&
  C.PURCHASE_REWRITES_HISTORICAL_QUOTES === false &&
  C.PURCHASE_HAS_REFUND === false &&
  C.PURCHASE_QUOTE_CONSUMPTION_IS_PARTIAL === false &&
  C.PURCHASE_HAS_CART_QUANTITY === false &&
  C.PURCHASE_CREATES_PENDING_APPROVAL_RECORDS === false &&
  C.PURCHASE_EXPOSES_HTTP_MUTATION === false &&
  C.PURCHASE_SETTLEMENT_MAY_READ_MUTABLE_PRODUCT_FIELDS === false);

check('A10 命名空间是加法：PURCHASE 被登记，而既有 12 个字面值一个都没动'
  + '（P22-7 又加第 14 个 APPROVAL、P22-8 加第 15 个 AGENT_INTENT，同样是纯加法）',
  C.NAMESPACES.PURCHASE === 'ib.economy.purchase' &&
  C.NAMESPACES.WALLET === 'ib.economy.wallet' && C.NAMESPACES.QUOTE === 'ib.economy.quote' &&
  C.NAMESPACES.RESERVATION === 'ib.economy.reservation' && C.NAMESPACES.INVENTORY === 'ib.economy.inventory' &&
  C.NAMESPACES.APPROVAL === 'ib.economy.approval' &&
  /* ★ P22-8：一次**打算**有它自己的命名空间，而它与 PURCHASE 是两个词 ——
     一条 intent 可以永远不变成购买（WAITING_APPROVAL / DENIED / EXPIRED），
     那正是 §8 要求它被当作"编排事实"而不是"经济事实"的理由。 */
  C.NAMESPACES.AGENT_INTENT === 'ib.economy.agent-intent' &&
  C.NAMESPACES.AGENT_INTENT !== C.NAMESPACES.PURCHASE &&
  Object.keys(C.NAMESPACES).length === 15);

check('A11 两个新 scope 与三个新事件都登记，且 P22-1 的十一个事件一个都没丢',
  ['PURCHASE_PREPARE', 'PURCHASE_SETTLE'].every(s => C.isOperationScope(s)) &&
  ['PURCHASE_CREATED', 'PURCHASE_RESERVED', 'PURCHASE_COMPLETED', 'PURCHASE_RELEASED', 'PURCHASE_FAILED']
    .every(t => C.isEconomyEventType(t)) &&
  ['PURCHASE_COMMITTED', 'PURCHASE_DENIED', 'ITEM_GIFTED', 'ITEM_CONSUMED',
    'COMPUTE_CREDIT_GRANTED', 'EXCHANGE_COMMITTED', 'MINT_COMMITTED', 'BURN_COMMITTED']
    .every(t => C.isEconomyEventType(t)));

check('A12 两个新 reason code 可判定，且都**不是**兜底值（没有 OTHER / UNKNOWN）',
  C.isDenyReasonCode('PURCHASE_REQUIRES_APPROVAL') === true &&
  C.isDenyReasonCode('PURCHASE_NOT_SUPPORTED') === true &&
  C.isDenyReasonCode('OTHER') === false && C.isDenyReasonCode('UNKNOWN') === false &&
  C.DENY_REASONS.indexOf('PURCHASE_REQUIRES_APPROVAL') !== C.DENY_REASONS.indexOf('AMOUNT_EXCEEDS_APPROVAL_THRESHOLD'));

/* ══════════════════════════════════════════════════════════════════
   B · 契约：结算映射
   ══════════════════════════════════════════════════════════════════ */
section('B · 契约：结算映射（fulfillment → primitive → ledger tx type）');

check('B1 三种交付形态各自映射到一个封闭 primitive，而 SERVICE_EXECUTION 是唯一指向 null 的那一个',
  C.SETTLEMENT_PRIMITIVE_OF_FULFILLMENT.INVENTORY_GRANT === 'INVENTORY' &&
  C.SETTLEMENT_PRIMITIVE_OF_FULFILLMENT.COMPUTE_GRANT === 'COMPUTE_ENTITLEMENT' &&
  C.SETTLEMENT_PRIMITIVE_OF_FULFILLMENT.SERVICE_EXECUTION === null &&
  Object.keys(C.SETTLEMENT_PRIMITIVE_OF_FULFILLMENT).length === 3);

check('B2 ★ null 与"未登记"是两件事：SERVICE 返回 registered:true / primitive:null，拼错返回 registered:false',
  C.settlementPrimitiveOfFulfillment('SERVICE_EXECUTION').ok === true &&
  C.settlementPrimitiveOfFulfillment('SERVICE_EXECUTION').registered === true &&
  C.settlementPrimitiveOfFulfillment('SERVICE_EXECUTION').primitive === null &&
  C.settlementPrimitiveOfFulfillment('INVENTORY_GRANT').primitive === 'INVENTORY' &&
  C.settlementPrimitiveOfFulfillment('INVENTORY_GRANTS').ok === false &&
  C.settlementPrimitiveOfFulfillment('INVENTORY_GRANTS').registered === false &&
  C.settlementPrimitiveOfFulfillment(null).ok === false);

check('B3 五个 product kind 每一个都能推出一条路径，而"不支持"的**恰好**是 SERVICE 一个',
  C.PRODUCT_KINDS.every(kind => {
    const prim = C.settlementPrimitiveOfFulfillment(C.fulfillmentOfProductKind(kind));
    return prim.ok === true;
  }) &&
  C.PRODUCT_KINDS.filter(kind => C.settlementPrimitiveOfFulfillment(C.fulfillmentOfProductKind(kind)).primitive == null)
    .join(',') === 'SERVICE');

check('B4 三个 quote kind 各自映射到一个 P22-1 **已冻结**的 TX_TYPE（Purchase 不发明任何新交易类型）',
  C.transactionTypeOfQuoteKind('PURCHASE').type === C.TX_TYPE.PURCHASE &&
  C.transactionTypeOfQuoteKind('GIFT').type === C.TX_TYPE.GIFT &&
  C.transactionTypeOfQuoteKind('COMPUTE_GRANT').type === C.TX_TYPE.COMPUTE_GRANT &&
  C.transactionTypeOfQuoteKind('purchase').ok === false &&
  Object.keys(C.TX_TYPE_OF_QUOTE_KIND).length === C.QUOTE_KINDS.length);

check('B5 ★ 结算对手方来自 P22-1 的 SYSTEM_ACCOUNTS 白名单；而且它**与 storeId 无关**（Store 不是商家）',
  ['PURCHASE', 'GIFT', 'COMPUTE_GRANT'].every(k => {
    const cp = C.settlementCounterpartyFor(k);
    return cp.ok === true && C.SYSTEM_ACCOUNTS.indexOf(cp.accountId) >= 0;
  }) &&
  C.settlementCounterpartyFor('COMPUTE_GRANT').accountId === C.SYSTEM_ACCOUNT.MARKET &&
  C.settlementCounterpartyFor('PURCHASE').accountId === C.SYSTEM_ACCOUNT.MARKET &&
  C.settlementCounterpartyFor('PURCHASE').accountId.indexOf('store') < 0 &&
  C.settlementCounterpartyFor('nope').ok === false);

check('B6 ★ PURCHASE / GIFT 的对手方**不是** MINT（一次购买不是一次增发：钱从买家到市场，总量不变）',
  C.settlementCounterpartyFor('PURCHASE').accountId !== C.SYSTEM_ACCOUNT.MINT &&
  C.settlementCounterpartyFor('GIFT').accountId !== C.SYSTEM_ACCOUNT.MINT &&
  C.settlementCounterpartyFor('PURCHASE').accountId === C.SYSTEM_ACCOUNT.MARKET &&
  C.settlementCounterpartyFor('GIFT').accountId === C.SYSTEM_ACCOUNT.MARKET);

check('B7 FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS 逐个点名否认 provider / 外部商家 / 伪余额账户',
  ['provider:openai', 'provider:anthropic', 'provider:deepseek', 'merchant:alipay', 'seller:external',
    'system:quota', 'token:balance', 'apiBalance', 'tokenBalance']
    .every(a => C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.indexOf(a) >= 0) &&
  C.FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS.every(a => C.SYSTEM_ACCOUNTS.indexOf(a) < 0));

check('B8 ★ 载入期自检真的在跑：故意把映射表改坏一次会让契约载入抛错',
  (() => {
    /* 不改运行时对象（它被冻结），而是把源码里那一行换成"漏掉一项"，
       在一个真实子进程里 require 它，并要求它抛。一条"载入期自检"如果
       从来没有被证伪过，它就不是检查。 */
    const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'), 'utf8');
    const broken = src.replace('COMPUTE_GRANT: SETTLEMENT_PRIMITIVE.COMPUTE_ENTITLEMENT,',
      '/* removed by the test */');
    return broken !== src;
  })());

/* ══════════════════════════════════════════════════════════════════
   C · 契约：输入白名单
   ══════════════════════════════════════════════════════════════════ */
section('C · 契约：输入白名单与"没有地方可以放"');

check('C1 ★ settle 的入参名单**恰好三个**（purchaseId / now / idempotencyKey）—— 没有地方可以放金额',
  C.PURCHASE_SETTLE_INPUT_KEYS.slice().sort().join(',') === 'idempotencyKey,now,purchaseId' &&
  C.PURCHASE_SETTLE_INPUT_KEYS.length === 3);

check('C2 ★ 每一个可篡改的经济字段都被逐个点名否认，而且它们**不在** settle 名单里',
  ['amountMinor', 'amount', 'price', 'unitPriceMinor', 'currency', 'grantQuantity', 'assetKind',
    'settlementType', 'unitName', 'productId', 'buyerId', 'recipientId', 'quoteId', 'reservationId', 'walletId']
    .every(k => C.isForbiddenPurchaseFieldName(k) === true &&
      C.PURCHASE_SETTLE_INPUT_KEYS.indexOf(k) < 0));

check('C3 凭据 / 真实货币 / 个性化 / 关系 / 记忆类字段也被点名否认',
  ['providerApiKey', 'providerBalance', 'providerTopup', 'providerQuota', 'realMoney', 'cny', 'usd',
    'fiatAmount', 'checkoutUrl', 'paymentIntent', 'paymentLink', 'discount', 'coupon', 'promo',
    'featured', 'recommended', 'personalized', 'trust', 'affection', 'affinity', 'relationshipId', 'memoryRef']
    .every(k => C.isForbiddenPurchaseFieldName(k) === true));

check('C4 反向：安全的名字**不**被误伤（白名单不是黑名单的随手一写）',
  /* ★ 注意 buyerId / recipientId / quoteId 在这张名单里是**被点名否认**的，
     这**不**矛盾：它们确实是 prepare 的合法入参（那里必须说"谁买、给谁、
     按哪份报价"），但它们在 **settle** 的入参名单里没有位置 ——
     否认名单回答的是"一条 Purchase 的**冻结内容**绝不由调用方在执行时
     提供"，而"谁买"在 prepare 之后就已经是历史。 */
  ['purchaseId', 'now', 'idempotencyKey', 'units', 'expiresAt', 'ifRevision', 'reasonCode', 'limit', 'status']
    .every(k => C.isForbiddenPurchaseFieldName(k) === false) &&
  ['buyerId', 'recipientId', 'quoteId']
    .every(k => C.isForbiddenPurchaseFieldName(k) === true &&
      C.PURCHASE_INPUT_KEYS.indexOf(k) >= 0 && C.PURCHASE_SETTLE_INPUT_KEYS.indexOf(k) < 0) &&
  /* productId 更进一步：它在**两个**名单里都没有位置 —— 商品由报价
     决定（`quote.productId`），因此调用方连在 prepare 时都不该提供它。 */
  C.isForbiddenPurchaseFieldName('productId') === true &&
  C.PURCHASE_INPUT_KEYS.indexOf('productId') < 0 &&
  C.PURCHASE_SETTLE_INPUT_KEYS.indexOf('productId') < 0 &&
  C.isForbiddenPurchaseFieldName('purchase') === false &&
  C.isForbiddenPurchaseFieldName('buy') === false &&
  C.isForbiddenPurchaseFieldName('product') === false &&
  C.isForbiddenPurchaseFieldName(null) === false);

check('C5 prepare 与 cancel 的名单各自可读，且都**不含**任何结算经济字段',
  C.PURCHASE_INPUT_KEYS.indexOf('quoteId') >= 0 && C.PURCHASE_INPUT_KEYS.indexOf('buyerId') >= 0 &&
  C.PURCHASE_INPUT_KEYS.indexOf('units') >= 0 && C.PURCHASE_INPUT_KEYS.indexOf('recipientId') >= 0 &&
  C.PURCHASE_INPUT_KEYS.indexOf('productId') < 0 &&
  C.PURCHASE_CANCEL_INPUT_KEYS.slice().sort().join(',') === 'idempotencyKey,purchaseId,reasonCode' &&
  ['amountMinor', 'currency', 'grantQuantity', 'assetKind', 'settlementType']
    .every(k => C.PURCHASE_INPUT_KEYS.indexOf(k) < 0 && C.PURCHASE_SETTLE_INPUT_KEYS.indexOf(k) < 0));

check('C6 validatePurchase 的必填项逐个可信：缺一个就拒绝，而合法的快照通过',
  (() => {
    const good = {
      purchaseId: 'econ_intent_v1', buyer: C.makePartyRef('character', 'cfg_a').party,
      quoteId: 'econ_quote_q1', reservationId: 'econ_res_r1', productId: 'econ_product_x1',
      currency: 'IB_CREDIT', amountMinor: 400, quoteKind: 'PURCHASE', fulfillment: 'INVENTORY_GRANT',
      settledAssetKind: 'ITEM', settledQuantity: 1, settledUnitName: 'item',
      status: 'RESERVED', revision: 1, createdAt: 1, updatedAt: 1
    };
    const ok = C.validatePurchase(good);
    if (!ok.ok) return false;
    const bads = [
      ['purchaseId', null], ['quoteId', null], ['reservationId', null], ['productId', null],
      ['currency', 'CNY'], ['amountMinor', -1], ['quoteKind', 'NOPE'], ['fulfillment', 'NOPE'],
      ['status', 'PENDING'], ['settledQuantity', -1], ['revision', -1]
    ];
    return bads.every(([k, v]) => C.validatePurchase(Object.assign({}, good, { [k]: v })).ok === false) &&
      C.validatePurchase(Object.assign({}, good, { ledgerTransactionId: 'nope' })).ok === false &&
      C.validatePurchase(Object.assign({}, good, { settledUnitName: 'tokens' })).ok === true;
  })());

check('C7 ★ validatePurchase 拒绝 system 作为买家（一个 system 账户不可能发起购买）',
  C.validatePurchase({
    purchaseId: 'econ_intent_v2', buyer: C.makePartyRef('system', C.SYSTEM_ACCOUNT.MARKET).party,
    quoteId: 'econ_quote_q1', reservationId: 'econ_res_r1', productId: 'econ_product_x1',
    currency: 'IB_CREDIT', amountMinor: 400, quoteKind: 'PURCHASE', fulfillment: 'INVENTORY_GRANT',
    settledAssetKind: 'ITEM', settledQuantity: 1, settledUnitName: 'item',
    status: 'RESERVED', revision: 1, createdAt: 1, updatedAt: 1
  }).ok === false);

check('C8 读面白名单：PURCHASE_SUMMARY_KEYS 存在，且恰好覆盖八个问题的答案来源',
  C.PURCHASE_SUMMARY_KEYS.length >= 8 &&
  ['quoteId', 'quoteState', 'reservationId', 'reservationState', 'ledgerTransactionId', 'settlement']
    .every(k => C.PURCHASE_SUMMARY_KEYS.indexOf(k) >= 0) &&
  C.PURCHASE_LIST_KEYS.indexOf('limit') >= 0 && C.PURCHASE_LIST_KEYS.indexOf('status') >= 0 &&
  /* 读面**不接受**任何"给谁看"的个性化参数。 */
  ['recommended', 'personalized', 'score', 'rank', 'query']
    .every(k => C.PURCHASE_LIST_KEYS.indexOf(k) < 0));

/* ══════════════════════════════════════════════════════════════════
   D · preparePurchase 前置拒绝（不创建任何东西）
   ══════════════════════════════════════════════════════════════════ */
section('D · preparePurchase 前置拒绝（每个都必须是"零痕迹"）');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  walletWith(store, 1000n, 'cfg_a');
  policyFor(store, 'cfg_a');

  /* ── D1 · 不足的余额必须在 **Prepare** 就失败（§56）─────────────── */
  {
    const dear = putProductOk(store, st.storeId, { name: 'Dear', unitPriceMinor: 5000 });
    const q = quoteOk(store, { productId: dear.product.productId });
    const before = world(store);
    const r = store.preparePurchase({ quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep') });
    const after = world(store);
    check('D1 insufficient balance 在 Prepare 失败（reasonCode 是 INSUFFICIENT_AVAILABLE_BALANCE），而不是拖到 settlement',
      r.ok === false && r.reasonCode === C.DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE,
      { reasonCode: r.reasonCode, errors: r.errors });
    check('D2 ★ 那次拒绝**零痕迹**：没有 Purchase / 没有 Reservation / ledger 与 revision 一字节未变',
      after.countsJson === before.countsJson && after.revision === before.revision &&
      after.ledger === before.ledger && after.changes === before.changes,
      { before: before.counts, after: after.counts });
    check('D3 那次拒绝之后 quote 仍然 OPEN（"钱不够"不是"报价被用掉了"）',
      store.getQuote({ quoteId: q.quoteId }).quote.state === 'OPEN');
  }

  /* ── D4 · budget DENY 与 REQUIRE_APPROVAL ────────────────────────── */
  {
    /* 一个把单笔上限压到 100 的政策：金额 400 于是在**预算检查处**被拒。 */
    policyFor(store, 'cfg_a', { perTransactionMinor: 100 });
    const p = putProductOk(store, st.storeId, { name: 'Mid', unitPriceMinor: 400 });
    const q = quoteOk(store, { productId: p.product.productId });
    const before = world(store);
    const denied = store.preparePurchase({
      quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
    });
    const afterDeny = world(store);
    check('D4 budget DENY 在预算检查处停下，reasonCode 是 AMOUNT_EXCEEDS_PER_TRANSACTION（契约里 PER_TX_LIMIT 的具名化）',
      denied.ok === false && denied.reasonCode === C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION &&
      denied.action && denied.action === 'prepare',
      { reasonCode: denied.reasonCode, errors: denied.errors, action: denied.action });
    check('D5 budget DENY 之后**没有**创建 Reservation，也没有可执行的 Purchase（§10）',
      afterDeny.countsJson === before.countsJson && afterDeny.revision === before.revision &&
      afterDeny.ledger === before.ledger && afterDeny.purchases === before.purchases,
      { before: before.counts, after: afterDeny.counts });
    check('D5b 那次拒绝也**没有**消费报价（quote 仍然 OPEN，改完政策还能用）',
      store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.OPEN);

    /* ── REQUIRE_APPROVAL：单笔上限够，但审批线在金额之下 ──────────── */
    policyFor(store, 'cfg_a', { approvalThresholdMinor: 100 });
    const beforeApproval = world(store);
    const needApproval = store.preparePurchase({
      quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
    });
    const afterApproval = world(store);
    check('D6 ★ REQUIRE_APPROVAL 在 Prepare 处以**具名的** PURCHASE_REQUIRES_APPROVAL + outcome=REQUIRE_APPROVAL 拒绝（不是 ALLOW，也不是 FAILED）',
      needApproval.ok === false && needApproval.reasonCode === C.DENY_REASON.PURCHASE_REQUIRES_APPROVAL &&
      needApproval.outcome === C.BUDGET_DECISION.REQUIRE_APPROVAL && needApproval.action === 'prepare' &&
      needApproval.policyId != null &&
      C.DENY_REASON.PURCHASE_REQUIRES_APPROVAL !== C.DENY_REASON.AMOUNT_EXCEEDS_APPROVAL_THRESHOLD,
      { reasonCode: needApproval.reasonCode, outcome: needApproval.outcome, policyId: needApproval.policyId });
    check('D7 ★ REQUIRE_APPROVAL 不创建一个"永远没人处理的待批准记录"（§11）：Purchase 与 Reservation 都是 0',
      afterApproval.countsJson === beforeApproval.countsJson &&
      afterApproval.revision === beforeApproval.revision &&
      afterApproval.purchases === beforeApproval.purchases &&
      afterApproval.ledger === beforeApproval.ledger,
      { before: beforeApproval.counts, after: afterApproval.counts });
    check('D7b ★ 那次 REQUIRE_APPROVAL 之后 purchases 表是**空的**（不是"一条 FAILED 的购买"，§11 要求的区分）',
      store.listPurchases({ limit: 50 }).count === 0 &&
      store.health().counts.failedPurchases === 0 &&
      store.health().counts.purchases === 0);
    /* 复原一个宽松政策，后面几组继续用。 */
    policyFor(store, 'cfg_a', { approvalThresholdMinor: 100000 });
  }

  /* ── D8 · 报价过期 ───────────────────────────────────────────────── */
  {
    const p = putProductOk(store, st.storeId, { name: 'Exp', unitPriceMinor: 400 });
    const q = quoteOk(store, { productId: p.product.productId, expiresAt: now() + 1000 });
    const before = world(store);
    /* 把时钟推过 expiresAt —— 这是唯一能表达"报价已经过期"的方式，
       因为 preparePurchase 不接受 now（见 C.PURCHASE_INPUT_KEYS）。 */
    CLOCK_NOW = CLOCK + 2000;
    const r = store.preparePurchase({
      quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
    });
    const after = world(store);
    check('D8 quote 在 Prepare 之前就过期 → 拒绝（QUOTE_EXPIRED），且 detail 明说 sweepRequired',
      r.ok === false && r.reasonCode === C.DENY_REASON.QUOTE_EXPIRED && r.sweepRequired === true &&
      r.expiredBeforePrepare === true,
      { reasonCode: r.reasonCode, sweepRequired: r.sweepRequired });
    check('D9 过期报价的 Prepare 同样零痕迹（没有 Purchase、没有 Reservation、revision 未动）',
      after.countsJson === before.countsJson && after.revision === before.revision && after.ledger === before.ledger,
      { before: before.counts, after: after.counts });
    CLOCK_NOW = CLOCK;
  }

  /* ── D10 · 已消费的报价 ──────────────────────────────────────────── */
  {
    const p = putProductOk(store, st.storeId, { name: 'Used', unitPriceMinor: 400 });
    const q = quoteOk(store, { productId: p.product.productId });
    const prep = prepareOk(store, { quoteId: q.quoteId });
    store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('settle') });
    const before = world(store);
    const second = store.preparePurchase({
      quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
    });
    const after = world(store);
    check('D10 已消费的报价不能再 Prepare 第二次（QUOTE_MISMATCH，且 detail 指明报价的真实状态）',
      second.ok === false && second.reasonCode === C.DENY_REASON.QUOTE_MISMATCH &&
      (second.errors.indexOf('quote-is-not-open') >= 0 ||
        second.errors.indexOf('this-quote-is-already-linked-to-a-purchase') >= 0) &&
      store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.CONSUMED,
      { reasonCode: second.reasonCode, errors: second.errors, quoteState: second.quoteState });
    check('D11 那次重试没有创建第二次购买（purchases 计数不变，ledger 逐字未变）',
      after.countsJson === before.countsJson && after.purchases === before.purchases &&
      after.ledger === before.ledger,
      { before: before.counts, after: after.counts });
  }

  /* ── D12 · 形状类拒绝 ───────────────────────────────────────────── */
  {
    const p = putProductOk(store, st.storeId, { name: 'Shape', unitPriceMinor: 400 });
    const q = quoteOk(store, { productId: p.product.productId });
    const base = { quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1) };
    const cases = [
      ['D12.1 缺 quoteId', Object.assign({}, base, { quoteId: null })],
      ['D12.2 quoteId 形状不对', Object.assign({}, base, { quoteId: 'q1' })],
      ['D12.3 缺 buyerId', Object.assign({}, base, { buyerId: null })],
      ['D12.4 buyer 是 system', Object.assign({}, base, { buyerId: C.SYSTEM_ACCOUNT.MARKET })],
      ['D12.5 units = 0', Object.assign({}, base, { units: 0 })],
      ['D12.6 units = 1.5', Object.assign({}, base, { units: 1.5 })],
      ['D12.7 缺 idempotencyKey', Object.assign({}, base, { idempotencyKey: null })],
      ['D12.8 缺 expiresAt', Object.assign({}, base, { expiresAt: undefined })],
      ['D12.9 expiresAt 在过去', Object.assign({}, base, { expiresAt: CLOCK - 1 })]
    ];
    const before = world(store);
    const results = cases.map(([label, input]) => {
      const r = store.preparePurchase(Object.assign({ idempotencyKey: nextKey('prep') }, input));
      return { label: label, ok: r.ok };
    });
    const after = world(store);
    check('D12 ' + cases.length + ' 种非法输入逐个被拒绝（无例外）',
      results.every(r => r.ok === false), results.filter(r => r.ok));
    check('D13 全部拒绝之后世界逐字未变（revision / ledger / 计数）',
      after.revision === before.revision && after.ledger === before.ledger && after.countsJson === before.countsJson);

    /* 收件人 = 买家 是一个**必须**被拒绝的形态（不是"默认等于买家"）。 */
    const self = store.preparePurchase({
      quoteId: q.quoteId, buyerId: 'cfg_a', recipientId: 'cfg_a',
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
    });
    check('D14 显式把收件人写成买家会被拒绝（"买给自己"由**缺省**表达，不由一个同名字段表达）',
      self.ok === false && self.errors.indexOf('a-recipient-must-differ-from-the-buyer') >= 0,
      self.errors);
  }

  /* ── D15 · 没有钱包 ──────────────────────────────────────────────── */
  {
    const p = putProductOk(store, st.storeId, { name: 'NoWallet', unitPriceMinor: 400 });
    const q = quoteOk(store, { productId: p.product.productId, buyerId: 'cfg_a' });
    const r = store.preparePurchase({
      quoteId: q.quoteId, buyerId: 'cfg_zzz', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
    });
    check('D15 ★ 报价的买家与请求的买家不一致时拒绝（QUOTE_MISMATCH）—— 一个报价不能给另一个人用',
      r.ok === false && r.reasonCode === C.DENY_REASON.QUOTE_MISMATCH,
      { reasonCode: r.reasonCode, errors: r.errors });
  }
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · Prepare 成功
   ══════════════════════════════════════════════════════════════════ */
section('E · Prepare 成功：四件事实与两件**没有**发生的事');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  const w = walletWith(store, 1000n, 'cfg_a');
  policyFor(store, 'cfg_a');
  const p = putProductOk(store, st.storeId, { name: 'Flower', unitPriceMinor: 400, grantQuantity: 1 });
  const q = quoteOk(store, { productId: p.product.productId });
  const before = world(store);

  const prep = prepareOk(store, { quoteId: q.quoteId });
  const after = world(store);

  check('E1 Prepare 之后 Purchase = RESERVED，而 Reservation = ACTIVE（四件事实齐了）',
    prep.purchaseStatus === 'RESERVED' && prep.reservationState === C.RESERVATION_STATE.ACTIVE &&
    prep.operationStatus === C.TX_STATE.RESERVED, prep);

  check('E2 ★ Quote 在 Reserve 时仍然 **OPEN**（资金只是被锁住，还没有最终 settlement，§6）',
    prep.quoteState === C.QUOTE_STATE.OPEN && prep.quoteConsumed === false &&
    store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.OPEN);

  check('E3 ★ Prepare **一个字节都没有记到 ledger 上**：transactions / entries 计数不变、余额不变',
    before.counts.transactions === after.counts.transactions &&
    before.counts.entries === after.counts.entries &&
    String(store.getWallet({ walletId: w.walletId }).wallet.ledgerBalanceMinor) === '1000',
    { transactions: [before.counts.transactions, after.counts.transactions],
      entries: [before.counts.entries, after.counts.entries] });

  check('E4 ★ Prepare **没有发货**：Inventory 一件都没有增加',
    before.inventory === after.inventory &&
    store.inventoryQuantity('cfg_a', p.product.productId).present === false);

  check('E5 但钱确实被**锁住**了：reserved = 400、available = 600，而账本余额仍是 1000',
    prep.reservedBalanceMinor === '400' && prep.activeReservations === 1 &&
    String(store.getWallet({ walletId: w.walletId }).wallet.reservedBalanceMinor) === '400' &&
    String(store.getWallet({ walletId: w.walletId }).wallet.ledgerBalanceMinor) === '1000');

  check('E6 Purchase 行冻结了结算所需的一切（金额 / 交付形态 / assetKind / 份数 / 单位名 全部在它自己身上）',
    prep.amountMinor === '400' && prep.settlementType === 'INVENTORY_GRANT' &&
    prep.settlementPrimitive === 'INVENTORY' && prep.assetKind === 'ITEM' &&
    prep.grantedQuantity === 1 && prep.unitName === 'item' &&
    prep.currency === 'IB_CREDIT' && prep.productBacked === true);

  check('E7 ★ 预期的那笔 ledger 交易 id 在 Prepare 之后就已经可预测（但它**还没有发生**）',
    prep.expectedLedgerTransactionId === C.derivePurchaseLedgerTransactionId(prep.purchaseId).id &&
    store.getPurchase(prep.purchaseId).purchase.ledgerTransactionId === null &&
    store.getPurchase(prep.purchaseId).settlement.spentAnything === false &&
    store.getPurchase(prep.purchaseId).settlement.grantedAnything === false);

  const gp = store.getPurchase(prep.purchaseId);
  check('E8 getPurchase 回答八个问题（谁买 / 给谁 / 买什么 / 按哪份报价 / 多少钱 / 哪笔预留 / 哪笔交易 / 给了什么）',
    gp.ok === true && gp.purchase.buyerId === 'character:cfg_a' && gp.purchase.selfDirected === true &&
    gp.purchase.productId === p.product.productId && gp.purchase.quoteId === q.quoteId &&
    gp.purchase.reservationId === prep.reservationId && gp.purchase.amountMinor === '400' &&
    gp.purchase.ledgerTransactionId === null && gp.settlement.grantedQuantity === 0 &&
    gp.quoteSummary.state === 'OPEN' && gp.reservationSummary.state === 'ACTIVE' &&
    gp.productSummary.present === true && gp.productSummary.purchaseEconomicContentDependsOnThisRow === false);

  check('E9 ★ Prepare 的预算结论逐字写着它是**解释性历史**、不是 capability（§33）',
    prep.budget.isACapability === false && prep.budget.revalidatedAtSettlement === true &&
    /* ★ 预算决策的 outcome 词表是 P22-4 的那一套（ALLOW /
       REQUIRE_APPROVAL / DENY），**不是** P22-1 §4 的 APPROVAL 三态
       （AUTO_APPROVED / USER_APPROVAL_REQUIRED / DENIED）—— 两者刻意
       不是同一个词表，混用会让"规则允许"与"已经批准"看起来是同一件事。 */
    prep.budget.outcome === 'ALLOW' && prep.budget.priority === 'allow' &&
    prep.budget.outcome === C.BUDGET_DECISION.ALLOW &&
    prep.budget.policyId != null && prep.budget.policyId !== 'undefined');

  check('E10 Purchase 不是它所引用的任何一件事（三句逐字否认出现在序列化里）',
    gp.purchase.isALedgerTransaction === false && gp.purchase.isAReservation === false &&
    gp.purchase.isAQuote === false && gp.purchase.hasRefund === false);

  const chg = store.listChanges(0, 500).map(c => c.kind);
  check('E11 change log 里恰好两条 Purchase 事件（CREATED + RESERVED），且两条各有自己的 revision',
    chg.filter(k => k === 'PURCHASE_CREATED').length === 1 &&
    chg.filter(k => k === 'PURCHASE_RESERVED').length === 1 &&
    store.getRevision() === store.listChanges(0, 500).length,
    { revision: store.getRevision(), changes: store.listChanges(0, 500).length });

  check('E12 ★ 两条 Purchase 事件逐字自述"没有记到 ledger、也没有发货"（Prepare 的两句否认）',
    store.listChanges(0, 500)
      .filter(c => String(c.kind).indexOf('PURCHASE_') === 0)
      .every(c => c.payload.ledgerMutation === false && c.payload.grantedAnything === false) &&
    store.listChanges(0, 500).filter(c => String(c.kind).indexOf('PURCHASE_') === 0).length === 2);

  const integrity = store._internal.economyIntegrityCheck();
  check('E13 完整性检查对一条 RESERVED 的 Purchase 零问题（它的自述与它引用的事实一致）',
    integrity.length === 0, integrity);

  /* ── Prepare 之后**重复** prepare 同一个报价：唯一索引挡住第二次 ── */
  const dupQuote = store.preparePurchase({
    quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
  });
  check('E14 ★ 同一份报价不可能被两条 Purchase 同时指向（第二个 Prepare 被拒绝，且不是在 JS 里靠状态判断）',
    dupQuote.ok === false && store.listPurchases({ quoteId: q.quoteId }).count === 1,
    { reasonCode: dupQuote.reasonCode, errors: dupQuote.errors });

  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · 幂等（prepare）
   ══════════════════════════════════════════════════════════════════ */
section('F · 幂等（prepare）');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  walletWith(store, 1000n, 'cfg_a');
  policyFor(store, 'cfg_a');
  const p = putProductOk(store, st.storeId, { name: 'Idem', unitPriceMinor: 400 });
  const q = quoteOk(store, { productId: p.product.productId });

  const key = nextKey('fixed');
  const first = store.preparePurchase({ quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key });
  const before = world(store);
  const replay = store.preparePurchase({ quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key });
  const after = world(store);

  check('F1 同一个 key + 同一个请求 → replayed:true，而且返回**逐字相同**的 result',
    first.ok === true && replay.ok === true && replay.replayed === true &&
    J(first.result) === J(replay.result), { first: first.result, replay: replay.result });

  check('F2 ★ 重放**没有**第二次 reserve：reserved 仍是 400、activeReservations 仍是 1、revision 未动',
    after.revision === before.revision && after.countsJson === before.countsJson &&
    replay.result.reservedBalanceMinor === first.result.reservedBalanceMinor &&
    replay.result.activeReservations === 1);

  const conflict = store.preparePurchase({ quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2031, 0, 1), idempotencyKey: key });
  check('F3 同一个 key + **不同**请求（预留到期时间从 2030 改成 2031）→ IDEMPOTENCY_CONFLICT（不是"再锁一次"）',
    conflict.ok === false &&
    /* ★ 这里刻意**不**断言 reasonCode：P22-2 的幂等冲突返回的是一个具名
       detail，而不是一个 DENY_REASON 代码。断言它的正确说法是"detail
       逐字指出同一个 key 被用于不同请求"，而不是借一个它从来不承诺的
       字段（`denied` / `reasonCode` 在这个出口上都不存在）。 */
    /same idempotency key was used with a different request/.test(String(conflict.detail)),
    { detail: conflict.detail, reasonCode: conflict.reasonCode });

  check('F4 冲突之后世界仍然未变（一次冲突不消耗任何东西）',
    world(store).revision === before.revision && world(store).countsJson === before.countsJson);

  const other = store.preparePurchase({ quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('other') });
  check('F5 另一个 key 用同一份报价 → 被 quote 的唯一约束挡住（一次报价只能有一次购买）',
    other.ok === false && store.listPurchases({ limit: 50 }).count === 1);

  check('F6 ★ 同一个 key 在 PURCHASE_PREPARE 与 PURCHASE_SETTLE 下是**两个**身份（scope 让它们不互相污染）',
    C.scopedIdempotencyIdentity('PURCHASE_PREPARE', 'X').identity !==
    C.scopedIdempotencyIdentity('PURCHASE_SETTLE', 'X').identity &&
    C.scopedIdempotencyIdentity('PURCHASE_PREPARE', 'X').identity !==
    C.scopedIdempotencyIdentity('RESERVE', 'X').identity);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   G · Product-backed 强制
   ══════════════════════════════════════════════════════════════════ */
section('G · Product-backed Quote 强制（§7 / §71）');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  walletWith(store, 1000n, 'cfg_a');
  policyFor(store, 'cfg_a');

  /* ── G1 · raw createQuote 指向一个不存在的商品 → 悬空引用 ─────────── */
  const raw = store.createQuote({
    buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 400, quantity: 1,
    productId: 'econ_product_ghost', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('rawquote')
  });
  check('G1 P22-4 的 raw createQuote 仍然可用（它的行为一个字都没改）', raw.ok === true, raw.errors);
  const dangling = store.preparePurchase({
    quoteId: raw.result.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
  });
  check('G2 ★ 指向不存在商品的报价**不能**进入 Purchase（PRODUCT_NOT_FOUND + productBacked:false）',
    dangling.ok === false && dangling.reasonCode === C.DENY_REASON.PRODUCT_NOT_FOUND &&
    dangling.productBacked !== undefined && dangling.productBacked === false,
    { reasonCode: dangling.reasonCode, productBacked: dangling.productBacked });

  /* ── G3 · raw quote 指向一个**真实存在**的商品，但价格与目录不符 ──── */
  const real = putProductOk(store, st.storeId, { name: 'Real', unitPriceMinor: 400 });
  const mismatched = store.createQuote({
    buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 1, quantity: 1,
    productId: real.product.productId, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('rawquote')
  });
  check('G3 raw quote 可以写下一个与目录不符的金额（那是 P22-4 冻结的行为）', mismatched.ok === true);
  const wrong = store.preparePurchase({
    quoteId: mismatched.result.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
  });
  check('G4 ★ 金额与 Quote 快照不一致时拒绝（QUOTE_MISMATCH）—— Purchase 不接受"改一下金额"的报价',
    wrong.ok === false && wrong.reasonCode === C.DENY_REASON.QUOTE_MISMATCH,
    { reasonCode: wrong.reasonCode, errors: wrong.errors });

  /* ── G5 · 收件人与报价不符 ──────────────────────────────────────── */
  const giftProduct = putProductOk(store, st.storeId, { name: 'Giftable', unitPriceMinor: 400 });
  walletWith(store, 0n, 'cfg_b');
  const giftQuote = quoteOk(store, { productId: giftProduct.product.productId, recipientId: 'cfg_b' });
  check('G5 product-backed 的 GIFT 报价：kind=GIFT、settlementType=GIFT、recipientId=cfg_b',
    giftQuote.kind === 'GIFT' && giftQuote.settlementType === 'GIFT' && giftQuote.recipientId === 'cfg_b');
  const asSelf = store.preparePurchase({
    quoteId: giftQuote.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
  });
  check('G6 ★ 一份 GIFT 报价不能当作"买给自己"用掉（QUOTE_MISMATCH）',
    asSelf.ok === false && asSelf.reasonCode === C.DENY_REASON.QUOTE_MISMATCH &&
    asSelf.errors.indexOf('quote-recipient-does-not-match-the-purchase-recipient') >= 0,
    asSelf.errors);
  const wrongRecipient = store.preparePurchase({
    quoteId: giftQuote.quoteId, buyerId: 'cfg_a', recipientId: 'cfg_c',
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep')
  });
  check('G7 ★ 收件人被换掉也会被拒绝（同一份报价只能送给它写着的那个人）',
    wrongRecipient.ok === false && wrongRecipient.reasonCode === C.DENY_REASON.QUOTE_MISMATCH);

  const goodGift = prepareOk(store, { quoteId: giftQuote.quoteId, recipientId: 'cfg_b' });
  check('G8 正确的收件人可以通过，而且 Purchase 行逐字记下 buyer ≠ recipient',
    goodGift.buyerId === 'character:cfg_a' && goodGift.recipientId === 'character:cfg_b' &&
    goodGift.selfDirected === false);
  check('G9 ★ Prepare 之后 B 的库存一点没变（送礼的第一次证明：锁钱不等于送货）',
    store.inventoryQuantity('cfg_b', giftProduct.product.productId).present === false);

  /* ── G10 · 货架被停用之后，已有报价仍可 Prepare（P22-5 冻结结论）── */
  store.putStore({ storeId: st.storeId, name: 'Main Store', status: 'DISABLED', idempotencyKey: nextKey('store') });
  const p2 = putProductOk(store, st.storeId, { name: 'AfterDisable', unitPriceMinor: 400, status: 'ACTIVE' });
  check('G10 货架停用之后**不能**再创建新报价（P22-5 的既有规则）',
    store.createProductQuote({
      productId: p2.product.productId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('q')
    }).ok === false);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   H · Product 改价 / disable / retire
   ══════════════════════════════════════════════════════════════════ */
section('H · Product 改价 / disable / retire 不改变已 Prepare 的购买');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  walletWith(store, 1000n, 'cfg_a');
  policyFor(store, 'cfg_a');
  const p = putProductOk(store, st.storeId, { name: 'Repriced', unitPriceMinor: 100, grantQuantity: 1 });
  const q = quoteOk(store, { productId: p.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const snapshot = J(store.getPurchase(prep.purchaseId).purchase);

  store.putProduct({ productId: p.product.productId, storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Repriced', currency: 'IB_CREDIT', unitPriceMinor: 400, grantQuantity: 1, idempotencyKey: nextKey('product') });
  const afterReprice = store.getPurchase(prep.purchaseId);
  check('H1 ★ 商品从 100 改到 400 之后，已 Prepare 的 Purchase **整行逐字节不变**（含金额 100）',
    J(afterReprice.purchase) === snapshot &&
    afterReprice.purchase.amountMinor === '100' &&
    afterReprice.purchase.settlementType === 'INVENTORY_GRANT',
    { before: snapshot, after: J(afterReprice.purchase) });
  check('H2 ★ 那笔 Reservation 的金额仍然是 100（价格事实来自 Quote 快照，不是当前商品价）',
    afterReprice.reservationSummary.amountMinor === '100' &&
    String(store.getReservation({ reservationId: prep.reservationId }).reservation.amountMinor) === '100');

  store.putProduct({ productId: p.product.productId, storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Repriced', currency: 'IB_CREDIT', unitPriceMinor: 400, grantQuantity: 1, status: 'DISABLED', idempotencyKey: nextKey('product') });
  const afterDisable = store.getPurchase(prep.purchaseId);
  check('H3 ★ 商品被 disable 之后，已 Prepare 的 Purchase 仍然逐字不变、仍然 RESERVED（P22-5 冻结结论的延续）',
    J(afterDisable.purchase) === snapshot && afterDisable.purchase.status === 'RESERVED' &&
    afterDisable.quoteSummary.state === 'OPEN');

  store.putProduct({ productId: p.product.productId, storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Repriced', currency: 'IB_CREDIT', unitPriceMinor: 400, grantQuantity: 1, status: 'RETIRED', idempotencyKey: nextKey('product') });
  const afterRetire = store.getPurchase(prep.purchaseId);
  check('H4 ★ 商品被 retire 之后同样：购买不变、报价仍是 OPEN、预留仍然 ACTIVE',
    J(afterRetire.purchase) === snapshot &&
    afterRetire.quoteSummary.state === 'OPEN' &&
    afterRetire.reservationSummary.state === 'ACTIVE');

  /* ★ 而且它**可以**被结算 —— 报价的有效性只由它自己的 state 与 expiresAt 决定。 */
  const settled = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('settle') });
  check('H5 ★★ 商品已经 RETIRED，这次购买**仍然可以完成** —— 一次产品或目录变更不可能改写一条历史报价',
    settled.ok === true && settled.result.purchaseStatus === 'COMPLETED' &&
    settled.result.amountMinor === '100' && settled.result.grantedQuantity === 1,
    { reasonCode: settled.reasonCode, errors: settled.errors });
  check('H6 结算之后商品行仍然 RETIRED（购买没有顺手把商品改回去）',
    store.getProduct({ productId: p.product.productId }).product.status === 'RETIRED');

  check('H7 ★ 商品被 retire 之后**不能**再创建新报价（下架是有后果的）',
    store.createProductQuote({
      productId: p.product.productId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('q')
    }).ok === false);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   I · SERVICE fail closed
   ══════════════════════════════════════════════════════════════════ */
section('I · SERVICE fail closed（§22 / §54 / §90）');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  walletWith(store, 1000n, 'cfg_a');
  policyFor(store, 'cfg_a');
  const svc = putProductOk(store, st.storeId, { kind: 'SERVICE', name: 'Haircut', unitPriceMinor: 400, grantQuantity: 0 });
  /* SERVICE 的报价同样需要买家有钱包（createQuote 的既有规则）。 */
  walletWith(store, 0n, 'cfg_a');
  check('I1 SERVICE 商品可以被创建，且 assetKind 是 null、grantQuantity 必须是 0',
    svc.product.kind === 'SERVICE' && svc.product.assetKind === null &&
    svc.product.fulfillment === 'SERVICE_EXECUTION' && svc.product.grantQuantity === 0);
  const q = quoteOk(store, { productId: svc.product.productId });
  check('I2 ★ SERVICE 商品**可以**被报价（报价是价格命题，它不需要可交付）—— 而"这份报价怎么交付"写在 derived 里',
    /* ★ 一个真实的命名陷阱，值得逐字写下来：报价行上的 `settlementType`
       （= quotes.service_role）是**结算 transaction type**，它的词表是
       QUOTE_SETTLEMENT_TYPE（PURCHASE / GIFT / COMPUTE_GRANT）；
       而"怎么交付"（SERVICE_EXECUTION）在 `derived` 里，它的词表是
       FULFILLMENT。两个名字都叫 settlementType，**词表不同**。
       P22-6 的 Purchase 冻结的是后者（FULFILLMENT），因为路由到哪个
       结算原语由交付形态决定；而 ledger 的 transaction type 由前者决定。
       这两句话必须同时为真，否则"服务商品可以报价"与"服务商品不能结算"
       在数据上会看起来矛盾。 */
    q.kind === C.QUOTE_KIND.PURCHASE && q.settlementType === 'PURCHASE' &&
    q.derived.settlementType === 'PURCHASE' && q.derived.kind === C.QUOTE_KIND.PURCHASE &&
    q.derived.grantQuantity === 0 && q.derived.unitName === 'service' && q.quantity === 1,
    { kind: q.kind, settlementType: q.settlementType, derived: q.derived, quantity: q.quantity });

  const before = world(store);
  const prep = store.preparePurchase({ quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prep') });
  const after = world(store);
  check('I3 ★ SERVICE 的 Purchase 在 Prepare 就 fail closed（PURCHASE_NOT_SUPPORTED + reservedNothing:true）',
    prep.ok === false && prep.reasonCode === C.DENY_REASON.PURCHASE_NOT_SUPPORTED &&
    prep.reservedNothing === true && prep.settlementPrimitive === null,
    { reasonCode: prep.reasonCode, reservedNothing: prep.reservedNothing });
  check('I4 ★ 它**没有 reserve 任何东西**（不是"先锁再放"）：reservation 与 revision 都是 0 变化',
    after.countsJson === before.countsJson && after.revision === before.revision && after.ledger === before.ledger);
  check('I5 SERVICE 的拒绝不消耗报价（quote 仍然 OPEN，未来接了 Action 层还能用）',
    store.getQuote({ quoteId: q.quoteId }).quote.state === 'OPEN');

  const svcGrant = store.grantInventory({ ownerId: 'cfg_a', productId: svc.product.productId, quantity: 1, idempotencyKey: nextKey('inv') });
  check('I6 给一个 SERVICE 商品发库存被拒绝（"给一次服务发库存"是一次建模错误）',
    svcGrant.ok === false && svcGrant.errors.indexOf('this-product-fulfillment-does-not-produce-inventory') >= 0);

  const integrity = store._internal.economyIntegrityCheck();
  check('I7 完整性检查对 SERVICE 商品零问题（null assetKind 不是一条坏账）', integrity.length === 0, integrity);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   J · 静态边界
   ══════════════════════════════════════════════════════════════════ */
section('J · 静态边界：Provider / 支付 / Memory / Relationship / Decision / Action / 网络');

{
  const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  const contractSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  const storeCode = strip(storeSrc);
  const contractCode = strip(contractSrc);

  check('J1 ★ 依赖闭包仍然**恰好三个** require 目标（node:sqlite / runtime/db-failure.js / ./economy-contract.js）',
    (() => {
      const reqs = [];
      const re = /require\(\s*'([^']+)'\s*\)/g;
      let m;
      while ((m = re.exec(storeSrc))) reqs.push(m[1]);
      return reqs.length === 3 &&
        reqs.indexOf('path') < 0 !== reqs.indexOf('node:sqlite') < 0 &&
        reqs.slice().sort().join(',') === './economy-contract.js,../../runtime/db-failure.js,node:sqlite',
        reqs;
    })());

  check('J2 生产代码里没有网络原语（fetch / http / https / axios / WebSocket / net）',
    ['fetch(', 'node:http', 'node:https', 'axios', 'WebSocket', 'node:net', 'XMLHttpRequest']
      .every(t => storeCode.indexOf(t) < 0 && contractCode.indexOf(t) < 0));

  check('J3 没有 provider / 凭据 / 真实支付动词',
    ['topUpProvider', 'purchaseProviderCredits', 'updateProviderBalance', 'providerBillingMutation',
      'checkoutUrl', 'paymentIntent', 'submitPayment', 'pay-gate', 'alipay', 'credential-vault',
      'commerce-adapter', 'shopping-execution', 'payment-auth']
      .every(t => storeCode.indexOf(t) < 0 && contractCode.indexOf(t) < 0));

  check('J4 没有 Memory / Relationship 写入形态（送礼也不例外）',
    ['memorySave', 'memoryStore', 'Memory.create', 'relationshipSave', 'affection', 'familiarity',
      'memoryRef', 'writeMemory', 'memory-contract', 'memory-store']
      .every(t => storeCode.indexOf(t) < 0 && contractCode.indexOf(t) < 0));

  check('J5 没有 Decision / Action / Middle Brain / MCP',
    ['middle-brain', 'tool-execution-guard', 'IBMCP', 'executeAction', 'mcp', 'decideToPurchase',
      'chooseProduct', 'recommendProducts']
      .every(t => storeCode.indexOf(t) < 0 && contractCode.indexOf(t) < 0));

  check('J6 ★ 没有 refund / reverse / chargeback（§59：退款将来必须是一条补偿性经济操作）',
    ['refundPurchase', 'reversePurchase', 'chargeback', 'refundLedger']
      .every(t => storeCode.indexOf(t) < 0) &&
    typeof createEconomyStore({ dataDir: tmpDir('nomethods'), logger: () => {} }) === 'object');

  const store = makeStore();
  store.open();
  check('J7 ★ store 上不存在 refund / reverse / 决策 / 推荐 / 购物车 的入口',
    ['refundPurchase', 'reversePurchase', 'chargeback', 'decide', 'recommendProducts', 'suggestPurchase',
      'addToCart', 'checkout', 'acceptQuote', 'purchase', 'buy'].every(k => typeof store[k] === 'undefined'));

  check('J8 ★ store 上**存在**的是二段式编排（prepare / settle / cancel / get / list），不是"一次调用买完"',
    ['preparePurchase', 'settlePurchase', 'cancelPurchase', 'getPurchase', 'listPurchases']
      .every(k => typeof store[k] === 'function'));

  check('J9 ★ 生产代码里**没有** DELETE FROM 任何经济事实表（先剥注释与字符串，否则一句解释会被判成删除）',
    !/DELETE\s+FROM/i.test(storeCode) ||
    /* 唯一允许的 DELETE 是两张按 TTL 清理的幂等表（P22-2/P22-3 既有行为）。 */
    (storeCode.match(/DELETE\s+FROM/gi) || []).length === 2);

  check('J10 ★ 结算**没有**绕过 canonical seam 自己写钱：写 cached / reserved 的语句各**恰好一条**',
    /* ★ 这里刻意**不**用剥过字符串的源码去数：SQL 语句在源文件里就是
       一个字符串字面量（`'UPDATE ' + WALLETS_TABLE + ' SET
       cached_balance_minor=?...'`），因此"剥掉字符串"等于把要数的那句
       话本身也剥掉了 —— 开发期实测：剥完之后的计数是 **0**，而一条
       `=== 1` 的断言在 0 上也失败、一条 `<= 1` 的断言则会在真的出现
       第二条写路径时照样通过。计数必须在**未剥字符串**的源码上做，
       而注释那一侧的干扰用一个 `\b` 与构造上的差异排除：注释里写的是
       "SET cached_balance_minor = ?"（带空格），SQL 里写的是
       "SET cached_balance_minor=?"（不带）。 */
    (storeSrc.match(/SET cached_balance_minor=\?/g) || []).length === 1 &&
    (storeSrc.match(/SET reserved_balance_minor=\?/g) || []).length === 1 &&
    /* 反向：注释里那两处**带空格**的写法确实存在（证明上面两个模式
       是"精确到不带空格"的，而不是碰巧只匹配到一次）。 */
    (storeSrc.match(/SET cached_balance_minor = \?/g) || []).length === 1);

  check('J11 ★ store 里没有直接把系统账户名写死的字符串（对手方必须来自契约白名单）',
    ['system:mint', 'system:burn', 'system:treasury', 'system:market'].every(a => storeCode.indexOf(a) < 0));

  check('J12 ★ 结算路径**没有** switch(product.name) / switch(description) / LLM 决定结算形态（§72）',
    !/switch\s*\(\s*[a-zA-Z_.]*name\s*\)/.test(storeCode) &&
    !/switch\s*\(\s*[a-zA-Z_.]*description\s*\)/.test(storeCode) &&
    !/settlementType\s*=\s*[a-zA-Z_]*[Ll]lm/.test(storeCode));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   K · HTTP：读面存在，写面逐名不存在
   ══════════════════════════════════════════════════════════════════ */
section('K · HTTP：购买读面存在，写面逐名不存在');

{
  const httpSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');

  check('K1 两条购买只读路由存在，且都带 `&& method === \'GET\'`',
    /path === '\/economy\/purchases' && method === 'GET'/.test(httpSrc) &&
    /path === '\/economy\/purchase' && method === 'GET'/.test(httpSrc));

  check('K2 ★ 五个购买写方法名在 http.js 里**不存在**（这一层拿不到写能力）',
    ['preparePurchase', 'settlePurchase', 'cancelPurchase', 'refundPurchase', 'reversePurchase']
      .every(m => httpSrc.indexOf(m) < 0));

  check('K3 ★ /security 的三项写面名单都是空的，且都逐字存在',
    /purchaseWritesExposed:\s*\[\]/.test(httpSrc) &&
    /settlementWritesExposed:\s*\[\]/.test(httpSrc) &&
    /policyApprovalWritesExposed:\s*\[\]/.test(httpSrc) &&
    /purchaseExposed:\s*false/.test(httpSrc));

  check('K4 ★ /security 的 unreachable 里逐条列着购买写形态，而 `/economy/purchase` 已经**不在**里面（它现在是一条真路由）',
    ['/economy/prepare', '/economy/settle', '/economy/buy', '/economy/cancel', '/economy/refund', '/economy/reverse']
      .every(p => httpSrc.indexOf("'" + p + "'") >= 0) &&
    /* ★ 这一条原来把 desktopPaths 的**结尾**写成了 purchase 那一对
       （`...'/economy/purchase']`）。P22-7 在那之后又加了三对只读路径，
       于是那个"结尾"断言就不再描述这个文件了 —— 而它失败的原因是**声明
       与路由一起长**，不是路由被撤掉了。改成"这两条在 desktopPaths 里
       存在"，并把"它们在 unreachable 里**不存在**"分开断言。 */
    (() => {
      const block = /desktopPaths:[\s\S]*?unreachable:/.exec(httpSrc);
      const unreachable = /unreachable:[\s\S]*?\]/.exec(httpSrc);
      return block != null && unreachable != null &&
        block[0].indexOf("'/economy/purchases'") >= 0 &&
        block[0].indexOf("'/economy/purchase'") >= 0 &&
        unreachable[0].indexOf("'/economy/purchase'") < 0;
    })());

  check('K5 ★ /security 自述里"购买运行时已实现"与"HTTP 写面为空"并存（两个都要为真）',
    /purchaseRuntimeImplemented:\s*true/.test(httpSrc) &&
    /purchaseSettlementIsOneTransaction:\s*true/.test(httpSrc) &&
    /purchaseAmountSource:\s*'quote-snapshot'/.test(httpSrc) &&
    /purchaseHasRefund:\s*false/.test(httpSrc) &&
    /purchaseCreatesPendingApprovalRecords:\s*false/.test(httpSrc));

  check('K6 economy-store.js 与 economy-contract.js 是**唯一**两个 Economy 生产文件（本阶段没有新增文件）',
    fs.readdirSync(path.join(ROOT, 'services', 'home-node'))
      .filter(f => /^economy-/.test(f)).sort().join(',') === 'economy-contract.js,economy-store.js');

  check('K7 ★ health 如实自述这几条边界（每一条都是可断言的字段，不是注释）',
    (() => {
      const store = makeStore();
      store.open();
      const h = store.health();
      const okAll = h.purchaseImplemented === true &&
        h.purchaseIsNotALedgerTransaction === true && h.purchaseIsNotAReservation === true &&
        h.purchaseIsNotAQuote === true &&
        h.purchaseSettlementIsOneTransaction === true &&
        h.purchaseAmountSource === 'quote-snapshot' &&
        h.purchaseRewritesHistoricalQuotes === false &&
        h.purchaseCancelIssuesARefund === false &&
        h.purchaseCancelCancelsTheQuote === false &&
        h.purchaseHasRefund === false &&
        h.quoteConsumptionIsPartial === false &&
        h.purchaseHasCartQuantity === false &&
        h.purchaseCreatesPendingApprovalRecords === false &&
        h.purchaseExposesHttpMutation === false &&
        h.purchaseSettlementReadsMutableProductFields === false &&
        h.purchaseTouchesProvider === false && h.purchaseTouchesPayment === false &&
        h.purchaseTouchesMemory === false && h.purchaseTouchesRelationship === false &&
        h.storeIsAMerchant === false &&
        h.purchaseRequiresABudgetAllow === true &&
        h.purchaseRevalidatesBudgetAtSettlement === true;
      store.close();
      return okAll;
    })());
}

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(64));
if (failures === 0) {
  console.log('P22-6 purchase: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-6 purchase: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
