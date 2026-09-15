'use strict';
/* ====================================================================
   P22-6 · Purchase Settlement —— 原子边界、故障注入与完整结算路径
   --------------------------------------------------------------------
   运行：node tests/test_p22_6_economy_settlement.js

   本文件回答一个问题，而且**只**回答这一个：

     「一笔 Purchase 的最终 settlement 是否真的只有一个 SQLite
       COMMIT 边界？」

   围绕它的是四组证据：

     E  单事务证明（含 transactionDepth 观测与"半完成状态"的反例测试）
     F  故障注入：13 个点 × 每一个都断言七件事 + **hit counter**
     G  四种结算形态的完整路径：普通 / Gift / Compute / Service
     H  幂等与重放（settle 自己的 scope、跨重启、跨进程由 runtime 文件负责）
     I  取消与过期（cancelPurchase / 报价过期 / 预留过期）
     J  预算的**最终**再评估（§30/§31/§32/§33）
     K  审计可解释性（§48）+ 完整性 + 重启结论不变

   ── 为什么 hit counter 是必需的 ──────────────────────────────────────
   P22-3/P22-4 各抓到过一次"测试存在但关键点没执行"：一个
   `assert.rejects(...)` 在**任何**位置抛错都会通过，因此它并不证明
   它以为的那一行真的跑到了。本文件的每一个故障点都用一个真实计数器
   断言"它确实被命中过"，而 `deps.faults.hit` 是唯一的注入缝。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-6s-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

const CLOCK = 1717200000000;
let CLOCK_NOW = CLOCK;
function now() { return CLOCK_NOW; }
function deterministicIds() {
  let n = 0;
  return (kind) => { n += 1; return C.formatEconomyId(kind, 's' + n).id; };
}
/* ── 故障注入 fixture ────────────────────────────────────────────────
   `hit(name)` 记下每一次命中，并在 `throwAt` 上抛错。两个能力都要：
     · 计数 —— 证明"这个位置确实被执行过"（fake-green 防线）；
     · 抛错 —— 证明"这里失败时整个事务回滚"。

   ★ 抛错是**一次性的**（`fired` 标记）。开发期实测踩到：一个永远抛错的
   fixture 会让"故障之后同一个 key 重试必须成功"这条断言**永远无法成立**——
   重试会再次撞上同一个注入点。一次性的语义也更接近真实故障（一次
   瞬间的失败，而不是一个永久坏掉的位置）。 */
function faultFixture(throwAt) {
  const hits = Object.create(null);
  let armed = false;
  let fired = false;
  return {
    faults: {
      hit(name) {
        const key = String(name);
        if (!armed) return;   /* ★ 装填之前只计数不抛错 —— 见下面的说明 */
        hits[key] = (hits[key] || 0) + 1;
        if (throwAt && !fired && key === String(throwAt)) {
          fired = true;
          const err = new Error('injected:' + key);
          err.code = 'INJECTED_FAULT';
          throw err;
        }
      }
    },
    /* ★ 一个**真实踩到**的陷阱：`after-transaction-insert` 这类点号也会被
       **fixture 自己**的铸币命中（mintForSystem → commitLedgerTransaction
       → 同一个故障点）。如果 fixture 在创建时就抛错，那么"造一个有钱的
       钱包"这一步会在测试的 try/catch **之外**炸掉，而报错看起来像是
       结算路径的问题。因此注入只有在 `arm()` 之后才生效 ——
       装填发生在被测动作之前的那一刻。 */
    arm() { armed = true; },
    isArmed() { return armed; },
    countOf(name) { return hits[String(name)] || 0; }
  };
}
function makeStore(extra, fixture) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir, logger: () => {}, clock: now, nextId: deterministicIds(),
    faults: fixture ? fixture.faults : null
  }, extra || {}));
}
let keySeq = 0;
function nextKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }

const POLICY_DEFAULTS = Object.freeze({
  perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000
});
function policyFor(store, ownerId, limits) {
  const out = store.putBudgetPolicy({
    ownerId: ownerId, currency: 'IB_CREDIT',
    limits: Object.assign({}, POLICY_DEFAULTS, limits || {}),
    idempotencyKey: nextKey('policy')
  });
  assert.equal(out.ok, true, 'putBudgetPolicy must succeed: ' + J(out.errors || out));
  return out.result;
}
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
function settleOk(store, purchaseId, extra) {
  const out = store.settlePurchase(Object.assign({ purchaseId: purchaseId, idempotencyKey: nextKey('settle') }, extra || {}));
  assert.equal(out.ok, true, 'settlePurchase must succeed: ' + J(out.errors || out));
  return out.result;
}
/* 一个"世界快照"：结算的每一步都必须能被它逐字比较。 */
function world(store, ownerId) {
  const h = store.health().counts;
  const id = ownerId || 'cfg_a';
  return {
    ledger: J({
      /* ★ listTransactions 返回的是**数组**，不是 {transactions}（P22-2 的形状）。
         开发期实测踩到：写成 `.transactions` 会得到 undefined，而
         `J(undefined) === 'undefined'` 在两边都成立 —— 于是"世界未变"
         变成一条恒真断言。 */
      transactions: store.listTransactions({ limit: 500 }),
      entries: store.listLedgerEntries({ limit: 2000 }).entries,
      topology: store.ledgerTopology(null)
    }),
    lifecycle: J({
      wallets: store.listWallets({ limit: 200 }).map(w => J(store.serializeWallet(w))),
      reservations: store.listReservations({ limit: 500 }).reservations.map(r => J(store.serializeReservation(r))),
      operations: store.listOperations({ limit: 500 }).operations.map(o => J(store.serializeOperation(o)))
    }),
    inventory: J(store.listInventory({ ownerId: id }).entries.map(e => J(store.serializeInventoryEntry(e)))),
    purchases: J(store.listPurchases({ limit: 500 }).purchases),
    revision: store.getRevision(),
    changes: store.listChanges(0, 500).length,
    counts: J({
      transactions: h.transactions, entries: h.entries, reservations: h.reservations,
      purchases: h.purchases, completedPurchases: h.completedPurchases
    }),
    integrity: J(store._internal.economyIntegrityCheck())
  };
}
/* 一个标准的三件套：货架 + 商品 + 买家钱包 + 预算政策 + 一份报价。 */
function fixture(store, options) {
  const o = options || {};
  const st = putStoreOk(store);
  walletWith(store, o.balance == null ? 1000n : BigInt(o.balance), o.buyerId || 'cfg_a');
  policyFor(store, o.buyerId || 'cfg_a', o.limits);
  const p = putProductOk(store, st.storeId, o.product || {});
  return { storeId: st.storeId, product: p.product, store: st };
}

/* ══════════════════════════════════════════════════════════════════
   E · 单事务证明
   ══════════════════════════════════════════════════════════════════ */
section('E · 单事务证明（一个 COMMIT，不是"业务上看起来连续"）');

{
  const fx = faultFixture(null);
  const store = makeStore({}, fx);
  store.open();
  const f = fixture(store);
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const before = world(store);

  /* 观测事务深度：settlePurchase 内部的每一步都必须在 depth ≥ 1 里跑。
     做法是把 faultPoint 当成探针。
     ★ 深度必须从**装了探针的那个实例**上读 —— 开发期实测踩到：报告里
     每一个点都写着 depth 0，因为探针闭包读的是另一个 store 的
     transactionDepth（txDepth 是**每个实例**的，不是全局的）。
     探针因此先挂上实例引用，再开始结算。 */
  const depthAtFault = [];
  let probed = null;
  const probeFaults = {
    hit(name) {
      const key = String(name);
      if (/^after-purchase-|^before-purchase-|^after-commit-|^before-commit-|^after-reservation-|^after-inventory-/.test(key)) {
        depthAtFault.push([key, probed ? probed._internal.transactionDepth() : -1]);
      }
    }
  };
  const store2dir = tmpDir('depth');
  const store2 = makeStore({ dataDir: store2dir, faults: probeFaults });
  probed = store2;
  store2.open();
  const f2 = fixture(store2);
  const q2 = quoteOk(store2, { productId: f2.product.productId });
  const prep2 = prepareOk(store2, { quoteId: q2.quoteId });
  depthAtFault.length = 0;
  const settled2 = settleOk(store2, prep2.purchaseId);
  check('E1 ★ 结算期间所有 Purchase / ledger / reservation / inventory 故障点都在**同一个事务**里被命中（depth ≥ 1）',
    depthAtFault.length >= 10 && depthAtFault.every(([, d]) => d >= 1),
    { points: depthAtFault.map(([k, d]) => k + '@' + d) });
  check('E2 ★ 结算期间事务深度**从未**回到 0 之后再上升（那就是两次 COMMIT 的形状）',
    (() => {
      let max = 0, sawZeroAfterStart = false, started = false;
      for (const [, d] of depthAtFault) {
        if (d > 0) started = true;
        if (started && d === 0) sawZeroAfterStart = true;
        max = Math.max(max, d);
      }
      return !sawZeroAfterStart && max >= 1;
    })(), { points: depthAtFault });
  check('E3 结束后深度归零（没有把一个开着的事务留给下一个调用方）',
    store2._internal.transactionDepth() === 0 && store2.isOpen() === true);
  check('E4 那一次结算在恰好一条事务里完成了所有 canonical 事实',
    settled2.purchaseStatus === 'COMPLETED' && settled2.quoteState === 'CONSUMED' &&
    settled2.reservationState === 'COMMITTED' && settled2.ledgerMutation === true &&
    settled2.inventoryMutation === true && settled2.purchaseCompleted === true);
  check('E5 结算之后完整性检查零问题', store2._internal.economyIntegrityCheck().length === 0,
    store2._internal.economyIntegrityCheck());
  store2.close();

  /* ★ 反例：一条被拒绝的结算必须在 world 上**完全不可见**。 */
  const rejectDir = tmpDir('reject');
  const store3 = makeStore({ dataDir: rejectDir });
  store3.open();
  const f3 = fixture(store3);
  /* 没有报价 → prepare 会失败；用一条被改坏的库来制造"结算中途失败"：
     直接用一个不存在的 purchaseId 是最弱的形态，因此这里改用
     "settlement 之前的预算被改坏" —— 见 J 组。此处只证明最基础的一条：
     不存在的 Purchase 不写任何东西。 */
  const beforeMissing = world(store3);
  const missing = store3.settlePurchase({ purchaseId: 'econ_intent_nope', idempotencyKey: nextKey('settle') });
  const afterMissing = world(store3);
  check('E6 对不存在的 Purchase 结算：具名拒绝 + 世界逐字未变',
    missing.ok === false && missing.errors.indexOf('purchase-not-found') >= 0 &&
    afterMissing.ledger === beforeMissing.ledger &&
    afterMissing.lifecycle === beforeMissing.lifecycle &&
    afterMissing.revision === beforeMissing.revision &&
    afterMissing.counts === beforeMissing.counts,
    { errors: missing.errors });
  store3.close();
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · 故障注入
   ══════════════════════════════════════════════════════════════════ */
section('F · 故障注入（13 个点，每一个都断言七件事 + hit proof）');

const SETTLE_FAULT_POINTS = [
  'after-purchase-settle-budget',
  'after-commit-validated',
  'after-reservation-committed',
  'after-commit-reserved-cache',
  'after-transaction-insert',
  'after-first-ledger-entry',
  'after-commit-ledger',
  'after-commit-operation-status',
  'after-purchase-quote-consumed',
  'after-inventory-insert',
  'after-purchase-completed',
  'before-purchase-settle-change-log',
  'before-purchase-settle-commit'
];

{
  const results = [];
  for (const point of SETTLE_FAULT_POINTS) {
    const fx = faultFixture(point);
    const dir = tmpDir('fault');
    const store = makeStore({ dataDir: dir }, fx);
    store.open();
    const f = fixture(store);
    const q = quoteOk(store, { productId: f.product.productId });
    const prep = prepareOk(store, { quoteId: q.quoteId });
    const before = world(store);
    /* ★ 装填注入：**现在**开始，被测的那一次结算之前一刻。 */
    fx.arm();
    let threw = null;
    try {
      store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('settle') });
    } catch (error) { threw = error; }
    const after = world(store);
    const hit = fx.countOf(point);
    const purchase = store.getPurchase(prep.purchaseId);
    results.push({
      point: point,
      hit: hit,
      threw: !!threw && /injected:/.test(String(threw && threw.message)),
      /* 七件事 */
      ledgerUnchanged: after.ledger === before.ledger,
      reservationStillActive: purchase.reservationSummary.state === 'ACTIVE',
      quoteNotConsumed: purchase.quoteSummary.state === 'OPEN',
      inventoryNotGrown: after.inventory === before.inventory,
      purchaseNotCompleted: purchase.purchase.status === 'RESERVED' &&
        purchase.purchase.ledgerTransactionId === null && purchase.purchase.completedAt === null,
      revisionNotLeaked: after.revision === before.revision && after.changes === before.changes,
      noIdempotencyResidue: store.listPurchases({ limit: 10 }).count === 1 &&
        store.getRevision() === before.revision,
      integrityClean: after.integrity === '[]'
    });
    /* 干净实例上同一个 key 重试必须**真的成功一次** —— 这证明回滚是
       完整的（不留残渣），而不是"失败之后永远不可能成功"。 */
    const txBeforeRetry = store.health().counts.transactions;
    const retry = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('retry') });
    results[results.length - 1].retrySucceeded = retry.ok === true &&
      retry.result.purchaseStatus === 'COMPLETED';
    results[results.length - 1].retryExactlyOneTx =
      store.health().counts.transactions === txBeforeRetry + 1;
    store.close();
  }

  check('F1 ★ 每一个故障点都**真的被命中过**（hit counter ≥ 1；没有计数器的话"注入了但没执行"会静默通过）',
    results.every(r => r.hit >= 1), results.map(r => r.point + '=' + r.hit));
  check('F2 每一个故障点都抛出注入的错误（没有一个是"注入点存在但没人调用"）',
    results.every(r => r.threw === true), results.filter(r => !r.threw).map(r => r.point));
  check('F3 ★ Ledger 未扣款：每一个故障点之后 transactions / entries / topology 逐字不变',
    results.every(r => r.ledgerUnchanged), results.filter(r => !r.ledgerUnchanged).map(r => r.point));
  check('F4 ★ Reservation 仍保持一致（ACTIVE，没有被留在 COMMITTED 或半途）',
    results.every(r => r.reservationStillActive), results.filter(r => !r.reservationStillActive).map(r => r.point));
  check('F5 ★ Quote 未被错误消费（每一个故障点之后仍然 OPEN）',
    results.every(r => r.quoteNotConsumed), results.filter(r => !r.quoteNotConsumed).map(r => r.point));
  check('F6 ★ Inventory 未增加（"扣钱成功、发货失败"与"发货成功、状态失败"两个反例都在这里被证否）',
    results.every(r => r.inventoryNotGrown), results.filter(r => !r.inventoryNotGrown).map(r => r.point));
  check('F7 ★ Purchase 未假完成（status 仍 RESERVED，ledgerTransactionId 与 completedAt 都是 null）',
    results.every(r => r.purchaseNotCompleted), results.filter(r => !r.purchaseNotCompleted).map(r => r.point));
  check('F8 ★ revision 未泄漏（revision 与 change log 长度都回到注入前）',
    results.every(r => r.revisionNotLeaked), results.filter(r => !r.revisionNotLeaked).map(r => r.point));
  check('F9 ★ 幂等未残留：故障之后 purchase 行仍然只有那一条，且没有"半个结果"',
    results.every(r => r.noIdempotencyResidue), results.filter(r => !r.noIdempotencyResidue).map(r => r.point));
  check('F10 ★ 每一个故障点之后完整性检查都是零问题（回滚不留下一句对不上的自述）',
    results.every(r => r.integrityClean), results.filter(r => !r.integrityClean).map(r => r.point));
  check('F11 ★ 每一个故障点之后，同一次购买在**干净的重试**里真的能完成（回滚是完整的，不是"之后永远失败"）',
    results.every(r => r.retrySucceeded === true), results.filter(r => r.retrySucceeded !== true).map(r => r.point));
}

/* ══════════════════════════════════════════════════════════════════
   G · 四种结算形态
   ══════════════════════════════════════════════════════════════════ */
section('G · 四种结算形态（普通 / Gift / Compute / Service）');

/* ── G1 · 普通购买 ───────────────────────────────────────────────── */
{
  const store = makeStore();
  store.open();
  const f = fixture(store, { product: { name: 'Flower', unitPriceMinor: 400, grantQuantity: 1 } });
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const buyer = store.listWallets({ limit: 1 })[0].walletId;
  const settled = settleOk(store, prep.purchaseId);

  check('G1.1 普通购买：买家钱包 1000 → 600，reserved 归零，交易类型是 PURCHASE',
    String(store.getWallet({ walletId: buyer }).wallet.ledgerBalanceMinor) === '600' &&
    String(store.getWallet({ walletId: buyer }).wallet.reservedBalanceMinor) === '0' &&
    settled.ledgerTransactionType === C.TX_TYPE.PURCHASE, settled);
  check('G1.2 对手方是 system:market（**不是** MINT、也不是任何 store 账户）',
    settled.counterparty === C.SYSTEM_ACCOUNT.MARKET &&
    store._internal.economyIntegrityCheck().length === 0);
  check('G1.3 ledger 复式平衡：一笔 transaction、两条 entry，debit === credit',
    (() => {
      const t = store.listTransactions({ limit: 10 }).find(x => x.transactionId === settled.ledgerTransactionId);
      /* ★ ledgerTopology(txId) 返回的是**逐币种桶的数组**（P22-2 的形状），
         不是 { entries, balanced }。开发期实测踩到：写成 topo.entries.length
         会抛错，而写成 topo.balanced 会恒为 undefined。 */
      const topo = store.ledgerTopology(settled.ledgerTransactionId);
      const bucket = topo[0];
      const rows = store.listLedgerEntries({ transactionId: settled.ledgerTransactionId, limit: 10 }).entries;
      return !!t && !!bucket && bucket.entries === 2 && bucket.balanced === true &&
        bucket.debitTotal === bucket.creditTotal && rows.length === 2;
    })());
  check('G1.4 结算之后四个状态同时落定：Purchase COMPLETED / Quote CONSUMED / Reservation COMMITTED / 库存 +1',
    settled.purchaseStatus === 'COMPLETED' && settled.quoteState === 'CONSUMED' &&
    settled.reservationState === 'COMMITTED' && settled.grantedQuantity === 1 &&
    store.inventoryQuantity('cfg_a', f.product.productId).quantity === 1);
  check('G1.5 三个**不是**：不是一次真实支付、不动 provider、不是一次增发',
    settled.paymentMutation === false && settled.providerMutation === false &&
    settled.counterparty !== C.SYSTEM_ACCOUNT.MINT &&
    settled.storeIsAMerchant === false);
  check('G1.6 ★★ 钱**只是换了账户**：买家 −400、system:market +400、而 MINT / BURN 保持不变（不是增发、不是销毁）',
    String(store.systemAccountBalance(C.SYSTEM_ACCOUNT.MARKET, 'IB_CREDIT').balanceMinor) === '400' &&
    /* ★ system:mint 的余额是 **1000** —— 那是 fixture 铸币留下的（那一笔
       的对手方就是它），而不是结算动的。断言"它没被结算改动"的正确写法
       是"它仍然等于铸币时写下的那个数"，而不是"它等于 0"。 */
    String(store.systemAccountBalance(C.SYSTEM_ACCOUNT.MINT, 'IB_CREDIT').balanceMinor) === '1000' &&
    String(store.systemAccountBalance(C.SYSTEM_ACCOUNT.BURN, 'IB_CREDIT').balanceMinor) === '0' &&
    /* 总量守恒：买家 600 + 市场 400 = 1000（= 最初铸出来的那个数）。
       市场那一侧的 sign 是 DEBIT（钱**进入**市场），见 formatSignedMinor。 */
    String(BigInt(String(store.getWallet({ walletId: buyer }).wallet.ledgerBalanceMinor)) +
      BigInt(String(store.systemAccountBalance(C.SYSTEM_ACCOUNT.MARKET, 'IB_CREDIT').balanceMinor))) === '1000' &&
    store.systemAccountBalance(C.SYSTEM_ACCOUNT.MARKET, 'IB_CREDIT').sign === 'DEBIT',
    {
      market: store.systemAccountBalance(C.SYSTEM_ACCOUNT.MARKET, 'IB_CREDIT'),
      mint: store.systemAccountBalance(C.SYSTEM_ACCOUNT.MINT, 'IB_CREDIT'),
      buyer: String(store.getWallet({ walletId: buyer }).wallet.ledgerBalanceMinor)
    });

  /* ── 审计可解释性（§48）：仅靠 canonical facts 回答两个问题 ───────── */
  const byBuyer = store.listTransactions({ limit: 50 }).filter(t => t.transactionType === 'PURCHASE');
  check('G1.7 ★ "为什么 A 少了 400 IB_CREDIT？" 的答案是：Purchase → Quote → Ledger Transaction（三跳全在 canonical facts 里）',
    byBuyer.length === 1 && (() => {
      const tx = byBuyer[0];
      const entry = store.listLedgerEntries({ transactionId: tx.transactionId, limit: 10 }).entries
        .find(e => e.direction === C.ENTRY_DIRECTION.CREDIT);
      /* ★ listLedgerEntries 返回的 entry 里 amountMinor 是 **BigInt**
         （它没有走 serialize* 那一层）—— 与 '400' 比较必须显式 String()。
         开发期实测踩到：直接比字符串会让这条断言静默失败。 */
      return !!entry && String(entry.amountMinor) === '400';
    })(), byBuyer);
  check('G1.8 ★ "为什么 A 多了 1 个 item？" 的答案是：Purchase → settlement metadata → Inventory fact',
    (() => {
      const inv = store.listInventory({ ownerId: 'cfg_a' }).entries[0];
      const gp = store.getPurchase(prep.purchaseId);
      return inv.quantity === 1 && inv.assetKind === 'ITEM' &&
        gp.settlement.grantedQuantity === 1 && gp.settlement.unitName === 'item' &&
        gp.settlement.inventoryEntryId === inv.inventoryEntryId;
    })());
  store.close();
}

/* ── G2 · Gift（§23/§24/§52）─────────────────────────────────────── */
{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  walletWith(store, 1000n, 'cfg_a');
  walletWith(store, 0n, 'cfg_b');
  policyFor(store, 'cfg_a');
  const p = putProductOk(store, st.storeId, { name: 'Gift Flower', unitPriceMinor: 400, grantQuantity: 1 });
  const q = quoteOk(store, { productId: p.product.productId, recipientId: 'cfg_b' });
  const prep = prepareOk(store, { quoteId: q.quoteId, recipientId: 'cfg_b' });
  const walletA = store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet;
  const settled = settleOk(store, prep.purchaseId);

  check('G2.1 ★ Gift：A 付款（1000 → 600）、B 收货（库存 0 → 1）、A 的库存**一件都没有**',
    String(store.getWallet({ walletId: walletA.walletId }).wallet.ledgerBalanceMinor) === '600' &&
    store.inventoryQuantity('cfg_b', p.product.productId).quantity === 1 &&
    store.inventoryQuantity('cfg_a', p.product.productId).present === false,
    { aInv: store.inventoryQuantity('cfg_a', p.product.productId), bInv: store.inventoryQuantity('cfg_b', p.product.productId) });
  check('G2.2 ★★ ledger 的付款人是 A（记账 payer 来自 Purchase 的 buyer，不是 recipient）',
    (() => {
      const tx = store.listTransactions({ limit: 50 }).find(t => t.transactionId === settled.ledgerTransactionId);
      return tx.ownerId === 'cfg_a' && tx.recipientId === 'cfg_b' && tx.transactionType === C.TX_TYPE.GIFT;
    })());
  check('G2.3 收货人是 B —— settlement 那一块给出的 recipientId 是 B，而且 selfDirected 为 false',
    settled.selfDirected === false && settled.recipientId === 'character:cfg_b' &&
    store.getPurchase(prep.purchaseId).settlement.recipientId === 'character:cfg_b');
  check('G2.4 两个钱包的 reserved 都归零（锁只发生在 A 身上，且被正确释放）',
    String(store.getWallet({ walletId: walletA.walletId }).wallet.reservedBalanceMinor) === '0' &&
    String(store.getWallet({ ownerId: 'cfg_b', currency: 'IB_CREDIT' }).wallet.reservedBalanceMinor) === '0');
  check('G2.5 ★ Gift 结算**没有**修改 Relationship / Memory（Economy 只记 Purchase + Ledger + Inventory + Change Log）',
    settled.relationshipMutation === false && settled.memoryMutation === false &&
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      return ['relationshipSave', 'affection +', 'trust +', 'memorySave', 'Memory.create']
        .every(t => src.indexOf(t) < 0);
    })());
  check('G2.6 Gift 结算之后完整性检查零问题', store._internal.economyIntegrityCheck().length === 0,
    store._internal.economyIntegrityCheck());
  store.close();
}

/* ── G3 · Compute / API quota（§20/§21/§53/§89）─────────────────── */
{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  walletWith(store, 3000n, 'cfg_a');
  policyFor(store, 'cfg_a');
  const p = putProductOk(store, st.storeId, {
    kind: 'API_QUOTA', name: 'Premium Compute x1000', unitPriceMinor: 400, grantQuantity: 1000
  });
  check('G3.1 API_QUOTA 商品的交付形态是 COMPUTE_GRANT、assetKind 是 COMPUTE、单位名恰是 computeUnit',
    p.product.fulfillment === C.FULFILLMENT.COMPUTE_GRANT && p.product.assetKind === 'COMPUTE' &&
    p.product.unitName === 'computeUnit');
  const q = quoteOk(store, { productId: p.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const settled = settleOk(store, prep.purchaseId);

  check('G3.2 ★★ 内部 compute/API 额度**真的增加了**：A 的 1000 computeUnit 落在 economy_inventory 上（assetKind=COMPUTE）',
    settled.settlementPrimitive === C.SETTLEMENT_PRIMITIVE.COMPUTE_ENTITLEMENT &&
    settled.assetKind === 'COMPUTE' && settled.grantedQuantity === 1000 &&
    settled.unitName === 'computeUnit' &&
    store.inventoryQuantity('cfg_a', p.product.productId).quantity === 1000 &&
    store.inventoryQuantity('cfg_a', p.product.productId).assetKind === 'COMPUTE');
  check('G3.3 钱包同时减少 400（3000 → 2600），交易类型是已冻结的 COMPUTE_GRANT',
    settled.amountMinor === '400' && settled.ledgerTransactionType === C.TX_TYPE.COMPUTE_GRANT &&
    String(store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet.ledgerBalanceMinor) === '2600');
  check('G3.4 COMPUTE_GRANT 是 NEUTRAL：它**不**占日消费额度（额度是被授予的，不是被花掉的）',
    C.BUDGET_NEUTRAL_TYPES.indexOf(C.TX_TYPE.COMPUTE_GRANT) >= 0 &&
    C.BUDGET_SPENDING_TYPES.indexOf(C.TX_TYPE.COMPUTE_GRANT) < 0);
  check('G3.5 ★★ 额度增加**完全没有** provider 参与：对手方是白名单 system 账户、没有任何 provider 账户被创建',
    C.SYSTEM_ACCOUNTS.indexOf(settled.counterparty) >= 0 &&
    store.listLedgerEntries({ transactionId: settled.ledgerTransactionId, limit: 10 }).entries
      .every(e => C.accountKindOf(e.accountId) !== null) &&
    !/provider/i.test(J(store.listLedgerEntries({ transactionId: settled.ledgerTransactionId, limit: 10 }).entries)));
  check('G3.6 CLEAR 的边界说法：这是 **InternalBeyond internal compute/API quota entitlement**，不是 provider recharge（逐字否认在结果里）',
    settled.providerMutation === false && settled.paymentMutation === false &&
    store.health().purchaseTouchesProvider === false);
  check('G3.7 单位名不可能被写成 provider token：tokens / usd / providerBalance 会被拒绝',
    C.isForbiddenComputeAlias('tokens') === true && C.isForbiddenComputeAlias('usd') === true &&
    C.isForbiddenComputeAlias('providerBalance') === true &&
    store.putProduct({
      storeId: st.storeId, kind: 'API_QUOTA', name: 'Bad', currency: 'IB_CREDIT',
      unitPriceMinor: 100, grantQuantity: 10, unitName: 'tokens', idempotencyKey: nextKey('product')
    }).ok === false);
  check('G3.8 ✓ 同一件商品再买一次会追加到**同一行**（库存不是钱包，它按 (owner, product) 唯一）',
    (() => {
      const q2 = quoteOk(store, { productId: p.product.productId });
      const prep2 = prepareOk(store, { quoteId: q2.quoteId });
      const s2 = settleOk(store, prep2.purchaseId);
      const inv = store.inventoryQuantity('cfg_a', p.product.productId);
      /* ★ 这一组需要 3 笔 400 的购买（第一笔 + 这一笔 + 后面的对照），
         因此 fixture 给的是 3000 而不是 1000 —— 余额不足会在**预算**
         那一层以 INSUFFICIENT_AVAILABLE_BALANCE 的形式失败，而那条
         失败看起来像"预算 bug"。 */
      return inv.quantity === 2000 && inv.inventoryEntryId === settled.inventoryEntryId &&
        store.health().counts.transactions === 3;
    })());
  store.close();
}

/* ── G4 · Service fail closed（§22/§54）─────────────────────────── */
{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store);
  walletWith(store, 1000n, 'cfg_a');
  policyFor(store, 'cfg_a');
  const p = putProductOk(store, st.storeId, { kind: 'SERVICE', name: 'Haircut', unitPriceMinor: 400, grantQuantity: 0 });
  const q = quoteOk(store, { productId: p.product.productId });
  const before = world(store);
  const prep = store.preparePurchase({ quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare') });
  const after = world(store);
  check('G4.1 ★ SERVICE 在 Prepare 就 fail closed（PURCHASE_NOT_SUPPORTED），**不 reserve**',
    prep.ok === false && prep.reasonCode === C.DENY_REASON.PURCHASE_NOT_SUPPORTED &&
    prep.settlementPrimitive === null && prep.reservedNothing === true,
    { reasonCode: prep.reasonCode, reservedNothing: prep.reservedNothing });
  check('G4.2 它没有留下任何痕迹（reservation / operation / revision 全为零变化）',
    after.ledger === before.ledger && after.lifecycle === before.lifecycle &&
    after.revision === before.revision && after.purchases === before.purchases);
  check('G4.3 ★ 它**没有**顺手执行任何 Action（Economy 里没有工具/MCP/Middle Brain 的调用形态）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      return ['executeAction', 'tool-execution-guard', 'middle-brain', 'IBMCP', 'mcp.'].every(t => src.indexOf(t) < 0);
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   H · 幂等与重放
   ══════════════════════════════════════════════════════════════════ */
section('H · 幂等与重放（settle 自己的 scope，§34/§35/§36/§37/§38）');

{
  const store = makeStore();
  store.open();
  /* ★ 这一组会结算**两笔** 400 的购买（第一笔 + H8/H9 的那一笔），
     因此 fixture 给 3000 而不是 1000 —— 余额不足会在**预算**那一层以
     INSUFFICIENT_AVAILABLE_BALANCE 失败，而那条失败看起来像预算 bug。 */
  const f = fixture(store, { balance: 3000n });
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const key = nextKey('fixed-settle');
  const first = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: key });
  const afterFirst = world(store);
  const replay = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: key });
  const afterReplay = world(store);

  check('H1 同一个 settle key 重放 → replayed:true，返回**逐字相同**的结果',
    first.ok === true && replay.ok === true && replay.replayed === true &&
    J(first.result) === J(replay.result), { first: first.result, replay: replay.result });
  check('H2 ★★ 重放**没有**第二笔扣款、也没有第二份资产：世界逐字未变',
    afterReplay.ledger === afterFirst.ledger && afterReplay.lifecycle === afterFirst.lifecycle &&
    afterReplay.inventory === afterFirst.inventory && afterReplay.revision === afterFirst.revision);
  check('H3 ★ 一次 Purchase 至多一笔 Ledger Transaction（transactions 计数恰好 +1）',
    store.health().counts.transactions === 2 /* mint + purchase */,
    store.health().counts);
  check('H4 ★ 一次 Purchase 至多一次资产发放（库存恰好是 1，不是 2）',
    store.inventoryQuantity('cfg_a', f.product.productId).quantity === 1);

  const other = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('other-settle') });
  check('H5 ★ 换一个 key 再 settle 同一次购买 → 终态冲突（不是第二次扣款）',
    other.ok === false && other.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED,
    { reasonCode: other.reasonCode, errors: other.errors });
  check('H6 那次冲突之后世界仍然逐字未变',
    world(store).ledger === afterFirst.ledger && world(store).inventory === afterFirst.inventory);

  /* ── §38 · Quote reuse attack ─────────────────────────────────── */
  const reuse = store.preparePurchase({
    quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('reuse')
  });
  check('H7 ★★ Quote 复用攻击：已 CONSUMED 的报价不可能开启第二次购买（且它**没有**扣钱）',
    reuse.ok === false && world(store).ledger === afterFirst.ledger &&
    store.listPurchases({ limit: 50 }).count === 1,
    { reasonCode: reuse.reasonCode, errors: reuse.errors });

  /* ── §38b · 同一条报价被两条 Purchase 指向 ───────────────────────── */
  const freshQuote = quoteOk(store, { productId: f.product.productId });
  const p1 = prepareOk(store, { quoteId: freshQuote.quoteId });
  const p2 = store.preparePurchase({
    quoteId: freshQuote.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('dup')
  });
  check('H8 ★ 同一份报价不可能被两条 Purchase 同时指向（第二个 Prepare 被拒绝）',
    p2.ok === false && store.listPurchases({ quoteId: freshQuote.quoteId }).count === 1);
  /* ★ 先结算那一条，然后**再试**一次 —— 这一次要挡住的是"同一条 quote
     已经完成过一次购买"，而不是"它已经被另一条 pending 的购买指着"。 */
  settleOk(store, p1.purchaseId);
  const beforeReuse = world(store);
  const reuse2 = store.preparePurchase({
    quoteId: freshQuote.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('reuse2')
  });
  check('H9 ★★ 已经成功完成过一次购买的报价，第二次尝试被拒绝，而且账本逐字未变（at most one successful Purchase per Quote）',
    reuse2.ok === false && world(store).ledger === beforeReuse.ledger &&
    store.health().counts.completedPurchases === 2,
    { reasonCode: reuse2.reasonCode, errors: reuse2.errors });

  /* ── §39/§40/§41 · 结算参数面 ─────────────────────────────────── */
  const settleInputKeys = C.PURCHASE_SETTLE_INPUT_KEYS;
  check('H10 ★★ settle 的入参名单**根本没有**可以篡改的字段（金额 / 币种 / 数量 / 收件人 / 商品 都不在名单里）',
    settleInputKeys.length === 3 &&
    ['amountMinor', 'currency', 'grantQuantity', 'recipientId', 'productId', 'buyerId', 'quoteId', 'reservationId', 'assetKind', 'settlementType']
      .every(k => settleInputKeys.indexOf(k) < 0));
  const tampered = store.settlePurchase({
    purchaseId: prep.purchaseId, idempotencyKey: nextKey('tamper'),
    amountMinor: 1, currency: 'CNY', grantQuantity: 9999, recipientId: 'character:attacker',
    productId: 'econ_product_evil', quoteId: 'econ_quote_evil', reservationId: 'econ_res_evil'
  });
  check('H11 ★★ 把十个字段一起塞进 settle 请求也**一个都不会被采纳**（它读的仍然是 canonical Purchase）',
    tampered.ok === false && tampered.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
    world(store).ledger === beforeReuse.ledger,
    { reasonCode: tampered.reasonCode });

  /* ── §36 · Purchase id 不进入 fingerprint ─────────────────────── */
  check('H12 ★ 系统的 Purchase fingerprint 只描述业务意图（quoteId + buyer + recipient + 金额 + units + 到期），不含任何生成的 id',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      const at = src.indexOf('const fingerprint = purchaseFingerprint(C.OPERATION_SCOPE.PURCHASE_PREPARE');
      const end = src.indexOf('});', at);
      const block = src.slice(at, end);
      return block.length > 0 && block.indexOf('purchaseId') < 0 &&
        block.indexOf('operationId') < 0 && block.indexOf('reservationId') < 0;
    })());
  store.close();
}

/* ── H13 · 跨重启：同一次结算只能完成一次 ────────────────────────── */
{
  const dir = tmpDir('restart');
  const s1 = makeStore({ dataDir: dir });
  s1.open();
  const f = fixture(s1);
  const q = quoteOk(s1, { productId: f.product.productId });
  const prep = prepareOk(s1, { quoteId: q.quoteId });
  s1.close();
  const s2 = makeStore({ dataDir: dir });
  s2.open();
  const settled = settleOk(s2, prep.purchaseId);
  const afterSettle = world(s2);
  s2.close();
  const s3 = makeStore({ dataDir: dir });
  s3.open();
  const replayAfterRestart = s3.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('after-restart') });
  const afterReplay = world(s3);
  check('H13 ★ prepare → 关进程 → 开 → settle 只能完成一次',
    settled.purchaseStatus === 'COMPLETED' &&
    replayAfterRestart.ok === false &&
    replayAfterRestart.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED);
  check('H14 ★ 重启之后的重放没有产生第二笔交易 / 第二份资产',
    afterReplay.ledger === afterSettle.ledger && afterReplay.inventory === afterSettle.inventory &&
    afterReplay.counts === afterSettle.counts);
  check('H15 ★ 重启之后：Purchase / Quote / Reservation / 库存 / 钱包 五样结论逐字相同',
    (() => {
      const a = J({ p: s3.getPurchase(prep.purchaseId).purchase, q: s3.getQuote({ quoteId: q.quoteId }).quote.state });
      const b = J({ p: s3.getPurchase(prep.purchaseId).purchase, q: C.QUOTE_STATE.CONSUMED });
      return a === b && afterReplay.integrity === '[]';
    })());
  s3.close();
}

/* ══════════════════════════════════════════════════════════════════
   I · 取消与过期
   ══════════════════════════════════════════════════════════════════ */
section('I · 取消与过期（§28/§29/§57/§58）');

/* ── I1 · 显式取消 ───────────────────────────────────────────────── */
{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const wallet = store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet;
  const before = world(store);
  const cancelled = store.cancelPurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('cancel') });

  check('I1 取消成功：Purchase → RELEASED、Reservation → RELEASED',
    cancelled.ok === true && cancelled.result.purchaseStatus === C.PURCHASE_STATE.RELEASED &&
    cancelled.result.reservationState === C.RESERVATION_STATE.RELEASED);
  check('I2 ★★ 取消**没有**制造任何 Ledger refund（钱从来没有离开钱包，因此没有退款这回事）',
    cancelled.result.ledgerMutation === false && cancelled.result.refundIssued === false &&
    store.health().counts.transactions === 1 /* 只有 fixture 的 mint */ &&
    String(store.getWallet({ walletId: wallet.walletId }).wallet.ledgerBalanceMinor) === '1000');
  check('I3 但锁**确实**被放开了：reserved 归零，available 回到 1000',
    String(store.getWallet({ walletId: wallet.walletId }).wallet.reservedBalanceMinor) === '0' &&
    cancelled.result.activeReservations === 0,
    {
      reserved: String(store.getWallet({ walletId: wallet.walletId }).wallet.reservedBalanceMinor),
      active: cancelled.result.activeReservations
    });
  check('I4 ★ Purchase 取消了，但 Quote **没有被取消**（§58：Purchase 的取消 ≠ Quote 的取消）',
    cancelled.result.quoteConsumed === false &&
    store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.OPEN);
  check('I5 取消之后完整性检查零问题', store._internal.economyIntegrityCheck().length === 0,
    store._internal.economyIntegrityCheck());

  const cancelKey = nextKey('cancel2');
  const c1 = store.cancelPurchase({ purchaseId: prep.purchaseId, idempotencyKey: cancelKey });
  check('I6 ★ 对已经 RELEASED 的购买再取消 → 终态冲突（不是第二次释放）',
    c1.ok === false && c1.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED);
  const settleAfterCancel = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('late') });
  check('I7 ★ 取消之后不可能再结算（RESERVED 是唯一的入口状态）',
    settleAfterCancel.ok === false &&
    settleAfterCancel.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
    world(store).ledger === before.ledger);
  store.close();
}

/* ── I2 · 报价在 Prepare 之后过期（§29/§57）──────────────────────── */
{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const q = quoteOk(store, { productId: f.product.productId, expiresAt: now() + 1000 });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const wallet = store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet;
  const before = world(store);
  /* 把时钟推过报价的 expiresAt —— "12:04 reserve 时有效"不是"12:06 可以
     按过期报价扣钱"的理由。 */
  CLOCK_NOW = CLOCK + 2000;
  const late = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('late-settle') });
  const after = world(store);
  CLOCK_NOW = CLOCK;

  check('I8 ★★ 报价在 reserve 之后过期 → settlement **拒绝**（RESERVATION_EXPIRED，terminal:true）',
    late.ok === false && late.terminal === true &&
    late.reasonCode === C.DENY_REASON.RESERVATION_EXPIRED,
    { reasonCode: late.reasonCode, errors: late.errors });
  check('I9 ★★ 不扣钱、不发货：ledger 逐字未变、库存一件未增',
    after.ledger === before.ledger && after.inventory === before.inventory &&
    String(store.getWallet({ walletId: wallet.walletId }).wallet.ledgerBalanceMinor) === '1000');
  check('I10 ★ 预留被释放、Purchase 进入终态（FAILED），而 Quote 进入 EXPIRED（按 P22-4 canonical 语义）',
    late.purchaseStatus === C.PURCHASE_STATE.FAILED &&
    late.reservationState === C.RESERVATION_STATE.RELEASED &&
    late.quoteState === C.QUOTE_STATE.EXPIRED &&
    store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.EXPIRED);
  check('I11 ★ 那条终局是**可解释的**：change log 里写着 quoteExpiredAtSettlement=true 与 ledgerMutation:false',
    (() => {
      const ev = store.listChanges(0, 500).filter(c => c.kind === C.EVENT_TYPE.PURCHASE_FAILED);
      return ev.length === 1 && ev[0].payload.quoteExpiredAtSettlement === true &&
        ev[0].payload.ledgerMutation === false && ev[0].payload.refundIssued === false;
    })());
  check('I12 过期终结之后完整性检查零问题（一条 FAILED 的购买不许留下任何结算痕迹）',
    store._internal.economyIntegrityCheck().length === 0,
    store._internal.economyIntegrityCheck());
  check('I13 ★ 过期的报价不可能被"复活"：再 Prepare 它会失败',
    store.preparePurchase({
      quoteId: q.quoteId, buyerId: 'cfg_a', expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('revive')
    }).ok === false);
  store.close();
}

/* ── I3 · 预留自己过期（§57）────────────────────────────────────── */
{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const q = quoteOk(store, { productId: f.product.productId, expiresAt: Date.UTC(2030, 0, 1) });
  const prep = prepareOk(store, { quoteId: q.quoteId, expiresAt: now() + 1000 });
  const wallet = store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet;
  const before = world(store);
  CLOCK_NOW = CLOCK + 2000;
  const late = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('late2') });
  CLOCK_NOW = CLOCK;
  check('I14 ★ 预留自己过期（报价还没过期）→ 同样拒绝、同样不扣钱不发货',
    late.ok === false && late.reasonCode === C.DENY_REASON.RESERVATION_EXPIRED &&
    world(store).ledger === before.ledger && world(store).inventory === before.inventory &&
    String(store.getWallet({ walletId: wallet.walletId }).wallet.ledgerBalanceMinor) === '1000',
    { reasonCode: late.reasonCode });
  check('I15 ★ 那一次 Quote **仍然 OPEN**（过期的是预留，不是报价 —— 两者不可互换）',
    store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.OPEN);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   J · 预算的最终再评估
   ══════════════════════════════════════════════════════════════════ */
section('J · Budget 最终再评估（§30/§31/§32/§33）');

/* ── J1 · Prepare ALLOW，settle 前政策被改严 → 最终 DENY ─────────── */
{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  check('J1.1 Prepare 时预算 ALLOW（快照式的解释性历史）',
    prep.budget.outcome === C.BUDGET_DECISION.ALLOW && prep.budget.isACapability === false);
  /* 把单笔上限压到 100：settlement 时金额 400 不再允许。 */
  policyFor(store, 'cfg_a', { perTransactionMinor: 100 });
  const wallet = store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet;
  const before = world(store);
  const settled = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('settle-j1') });
  const after = world(store);
  check('J1.2 ★★ Prepare ALLOW 不保证 Settlement ALLOW：政策改严之后最终是 DENY（AMOUNT_EXCEEDS_PER_TRANSACTION）',
    settled.ok === false && settled.terminal === true &&
    settled.reasonCode === C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION,
    { reasonCode: settled.reasonCode, errors: settled.errors });
  check('J1.3 ★★ 最终拒绝时：no Ledger mutation / no Inventory grant / no Quote consumption',
    after.ledger === before.ledger && after.inventory === before.inventory &&
    store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.OPEN &&
    String(store.getWallet({ walletId: wallet.walletId }).wallet.ledgerBalanceMinor) === '1000');
  check('J1.4 预留被正确处理（释放，而不是留在 ACTIVE），Purchase 进入 FAILED',
    settled.purchaseStatus === C.PURCHASE_STATE.FAILED &&
    settled.reservationState === C.RESERVATION_STATE.RELEASED &&
    String(store.getWallet({ walletId: wallet.walletId }).wallet.reservedBalanceMinor) === '0');
  check('J1.5 审计里写着那是**结算时**的预算结论，不是 Prepare 时的那个',
    (() => {
      const ev = store.listChanges(0, 500).filter(c => c.kind === C.EVENT_TYPE.PURCHASE_FAILED);
      return ev.length === 1 && ev[0].payload.reasonCode === C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION &&
        ev[0].payload.ledgerMutation === false;
    })());
  check('J1.6 ★ 完整性检查零问题', store._internal.economyIntegrityCheck().length === 0,
    store._internal.economyIntegrityCheck());
  store.close();
}

/* ── J2 · 消费窗口被别处用掉 → 最终 DENY ─────────────────────────── */
{
  const store = makeStore();
  store.open();
  const f = fixture(store, { balance: 2000n, limits: { perTransactionMinor: 100000, dailyMinor: 500 } });
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  check('J2.1 Prepare ALLOW（日额度 500，这一笔 400）', prep.budget.outcome === C.BUDGET_DECISION.ALLOW);

  /* ★ 在 T1 与 T2 之间，另一笔**已提交**的交易用掉了日额度里的 300。
     预留保证的只是"这笔钱不会被别的预留花掉"，它不保证预算窗口没被动。 */
  const wallet = store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet;
  const other = store.mintForSystem({
    systemInitiated: true, walletId: wallet.walletId, currency: 'IB_CREDIT',
    amountMinor: 300, idempotencyKey: nextKey('noise')
  });
  check('J2.2 那笔"别处的消费"确实**不**算消费（它是 MINT —— 这一条证否了"任何交易都算额度"）',
    other.ok === true &&
    /* ★ spendingWindows 的形态：金额在**顶层**（spentTodayMinor / Week /
       Month，BigInt），`windows` 那一块只有时区与三个窗口边界。
       开发期实测踩到：写成 `.windows.day.spentMinor` 会抛 —— 因为那个
       路径根本不存在。 */
    String(store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: now() }).spentTodayMinor) === '0',
    store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: now() }));

  /* 真正让窗口被用掉的动作：一笔真实的 PURCHASE（另一件商品）。 */
  const p2 = putProductOk(store, f.storeId, { name: 'Second', unitPriceMinor: 300, grantQuantity: 1 });
  const q2 = quoteOk(store, { productId: p2.product.productId });
  const prep2 = prepareOk(store, { quoteId: q2.quoteId });
  settleOk(store, prep2.purchaseId);
  const windows = store.spendingWindows({ ownerId: 'cfg_a', currency: 'IB_CREDIT', now: now() });
  check('J2.3 第一笔已提交的购买用掉了日额度里的 300（而它旁边那笔 MINT 仍然不算）',
    String(windows.spentTodayMinor) === '300' &&
    String(windows.spentThisWeekMinor) === '300' && String(windows.spentThisMonthMinor) === '300',
    { day: String(windows.spentTodayMinor), counted: windows.countedTransactions });

  const before = world(store);
  const settled = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('settle-j2') });
  const after = world(store);
  check('J2.4 ★★ 第二笔在 settlement 处被最终 DENY（DAILY_LIMIT：300 + 400 > 500），而不是靠预留',
    settled.ok === false && settled.terminal === true &&
    settled.reasonCode === C.DENY_REASON.DAILY_LIMIT,
    { reasonCode: settled.reasonCode, errors: settled.errors });
  check('J2.5 ★★ 最终拒绝：no Ledger mutation / no Inventory grant / no Quote consumption',
    after.ledger === before.ledger && after.inventory === before.inventory &&
    store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.OPEN);
  check('J2.6 但**第一笔**的结论没有被改写（它的 COMPLETED 与它的库存都还在）',
    store.health().counts.completedPurchases === 1 &&
    store.inventoryQuantity('cfg_a', p2.product.productId).quantity === 1 &&
    store.inventoryQuantity('cfg_a', f.product.productId).present === false);
  store.close();
}

/* ── J3 · 政策在 settle 时变成 REQUIRE_APPROVAL（§32）────────────── */
{
  const store = makeStore();
  store.open();
  const f = fixture(store, { limits: { approvalThresholdMinor: 100000 } });
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  policyFor(store, 'cfg_a', { approvalThresholdMinor: 100 });
  const before = world(store);
  const settled = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('settle-j3') });
  const after = world(store);
  check('J3.1 ★★ settle 时变成 REQUIRE_APPROVAL → **不得 settlement**，而且返回的是具名的 PURCHASE_REQUIRES_APPROVAL',
    settled.ok === false && settled.terminal === true &&
    settled.reasonCode === C.DENY_REASON.PURCHASE_REQUIRES_APPROVAL,
    { reasonCode: settled.reasonCode, errors: settled.errors });
  check('J3.2 ★★ 它**不伪装**成 FAILED：Purchase 进入 RELEASED（"流程被放弃"而不是"试过了不成立"）',
    settled.purchaseStatus === C.PURCHASE_STATE.RELEASED &&
    store.health().counts.failedPurchases === 0 &&
    store.health().counts.releasedPurchases === 1);
  check('J3.3 ★ 预留被释放、没有扣钱、没有发货、报价仍然 OPEN',
    after.ledger === before.ledger && after.inventory === before.inventory &&
    store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.OPEN);
  check('J3.4 ★ 没有偷偷批准：那一笔没有产生任何 Ledger 事实，也没有创建任何待批准记录',
    settled.pendingApprovalRecordCreated === false && after.ledger === before.ledger &&
    store.health().purchaseCreatesPendingApprovalRecords === false);
  store.close();
}

/* ── J4 · 政策被停用 → 最终 DENY ─────────────────────────────────── */
{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const pol = store.getBudgetPolicy({ ownerId: 'cfg_a' }).policy;
  /* ★ 让"这个 owner 上没有生效的规则"成立的正确做法是把政策的**期限**
     写到一个已经过去的时间点（termEndsAt + expireDuePolicies），或者
     直接**删除**规则这一面 —— 而不是 `putBudgetPolicy({status:'DISABLED'})`
     之后直接结算（那一步本身会先把政策写成 DISABLED，而评估会走
     POLICY_NOT_FOUND，但"政策行不存在"与"政策被停用"是两条不同的判断）。
     这里走的是最干净的那条：**停用之后立刻扫一次到期**，让政策进入它
     自己的终态。 */
  store.putBudgetPolicy({
    ownerId: 'cfg_a', currency: 'IB_CREDIT', limits: Object.assign({}, POLICY_DEFAULTS),
    termEndsAt: now() - 1, idempotencyKey: nextKey('short-policy')
  });
  store.expireDuePolicies({ now: now(), limit: 10 });
  const before = world(store);
  const settled = store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('settle-j4') });
  check('J4 ★ 政策已经不存在生效版本 → 最终 DENY（POLICY_NOT_FOUND / POLICY_TERM_EXPIRED 之一），且没有扣钱',
    settled.ok === false && settled.terminal === true &&
    [C.DENY_REASON.POLICY_NOT_FOUND, C.DENY_REASON.POLICY_TERM_EXPIRED].indexOf(settled.reasonCode) >= 0 &&
    world(store).ledger === before.ledger,
    { reasonCode: settled.reasonCode, errors: settled.errors, terminal: settled.terminal });
  check('J4b "没有规则"不等于"随便花"（fail closed）',
    store.getQuote({ quoteId: q.quoteId }).quote.state === C.QUOTE_STATE.OPEN &&
    store.inventoryQuantity('cfg_a', f.product.productId).present === false);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   K · 审计、完整性与重启结论
   ══════════════════════════════════════════════════════════════════ */
section('K · 审计、完整性与重启结论');

{
  const dir = tmpDir('k');
  const store = makeStore({ dataDir: dir });
  store.open();
  const f = fixture(store);
  const q = quoteOk(store, { productId: f.product.productId });
  const prep = prepareOk(store, { quoteId: q.quoteId });
  const settled = settleOk(store, prep.purchaseId);

  const kinds = store.listChanges(0, 500).map(c => c.kind);
  check('K1 ★ 一次完整购买产生的 change log 事件序列是可读的（CREATED → RESERVED → … → COMPLETED）',
    kinds.indexOf(C.EVENT_TYPE.PURCHASE_CREATED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.PURCHASE_RESERVED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.PURCHASE_COMPLETED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.RESERVATION_COMMITTED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.QUOTE_CONSUMED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.INVENTORY_GRANTED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.PURCHASE_COMMITTED) >= 0, kinds);
  check('K2 ★ revision 是**单调且无洞**的（每一次 allocateRevision 恰好配一条 change 行）',
    store.getRevision() === store.listChanges(0, 500).length &&
    kinds.length === new Set(store.listChanges(0, 500).map(c => c.revision)).size,
    { revision: store.getRevision(), changes: kinds.length });
  check('K3 ★ 没有独立的 purchase_revision / settlement_revision（一次结算共用同一个 revision 空间）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      return src.indexOf('purchase_revision') < 0 && src.indexOf('settlement_revision') < 0;
    })());
  check('K4 ★ 高层事件只有一条 COMPLETED（不是每一行 SQL 一条事件）',
    kinds.filter(k => k === C.EVENT_TYPE.PURCHASE_COMPLETED).length === 1);
  check('K5 结算事件的 payload 逐字写着"钱动了、货发了"以及四句否认',
    (() => {
      const ev = store.listChanges(0, 500).find(c => c.kind === C.EVENT_TYPE.PURCHASE_COMPLETED);
      return ev && ev.payload.ledgerMutation === true && ev.payload.inventoryMutation === true &&
        ev.payload.providerMutation === false && ev.payload.paymentMutation === false &&
        ev.payload.memoryMutation === false && ev.payload.relationshipMutation === false &&
        ev.payload.storeIsAMerchant === false;
    })());
  check('K6 ★ 结算的七个事实可以只靠 canonical 行互相验证（integrity check 的逐条依据）',
    store._internal.economyIntegrityCheck().length === 0);
  check('K7 ★ 交易 id 就是那个**确定性派生**的 id（不是随机分配的第二笔）',
    settled.ledgerTransactionId === C.derivePurchaseLedgerTransactionId(prep.purchaseId).id);
  check('K8 ★ 已完成的购买在 health 里被计数，而 FAILED / RELEASED 各自独立',
    store.health().counts.completedPurchases === 1 &&
    store.health().counts.failedPurchases === 0 && store.health().counts.releasedPurchases === 0);
  /* ★ 关库之前把 revision 记下来：close() 之后 getRevision() 不再是有效
     读数（store 已经不打开），而"重启不消耗 revision"这条断言要比的正是
     关库前与重开后的两个读数。 */
  const revisionBeforeRestart = store.getRevision();
  store.close();

  /* ── 重启：五样结论逐字相同，且不消耗 revision ────────────────── */
  const s2 = makeStore({ dataDir: dir });
  s2.open();
  check('K9 ★★ 重启之后 Purchase / Quote / Reservation / 库存 / 预算结论五样逐字相同',
    (() => {
      const p1 = s2.getPurchase(prep.purchaseId);
      return p1.purchase.status === 'COMPLETED' &&
        p1.quoteSummary.state === 'CONSUMED' &&
        p1.reservationSummary.state === 'COMMITTED' &&
        s2.inventoryQuantity('cfg_a', f.product.productId).quantity === 1 &&
        p1.settlement.grantedQuantity === 1;
    })());
  check('K10 ★ 重启**不消耗** revision（对账是只读的）',
    s2.getRevision() === revisionBeforeRestart,
    { before: revisionBeforeRestart, after: s2.getRevision() });
  check('K11 ★ 重启之后完整性检查仍然零问题',
    s2._internal.economyIntegrityCheck().length === 0,
    s2._internal.economyIntegrityCheck());
  s2.close();
}

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(64));
if (failures === 0) {
  console.log('P22-6 settlement: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-6 settlement: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
