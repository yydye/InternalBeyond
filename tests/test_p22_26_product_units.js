'use strict';
/* ====================================================================
   P22-26 · Phase 1 —— Purchase `units` 契约
   --------------------------------------------------------------------
   运行：node tests/test_p22_26_product_units.js

   本文件只证明**一件事**，但它被拆成四层，因为"它成不成立"取决于四件
   互不相同的事：

     「份数是谁的事实？」     —— 权威：报价上那一列，不是请求里的一个数
     「多份买得成吗？」       —— units = 1 / 3 / (grantQuantity=1000, units=3)
     「买多份发生什么？」     —— quote → prepare → settle 黄金路径
     「旧语义还在吗？」       —— units = 1 的行为逐字不变

   ── 修掉的那个算错（逐字）────────────────────────────────────────────
   在 P22-26 之前，`quotes` 表**没有** `units` 列：报价把 units 算进了
   `quantity`（送达量 = units × grantQuantity）与 `amountMinor`，却**没有
   保存 units 自己**。而 `preparePurchase` 从请求里读 units，缺省是 1：

     const units = o.units == null ? 1 : Number(o.units);   // ← 假定 1
     const expectedAmount = C.productQuoteAmountMinor(product, units);
     const expectedQuantity = C.productQuoteQuantity(product, units);
     if (expectedAmount !== quote.amount || quote.quantity !== expectedQuantity)
       → QUOTE_MISMATCH

   于是 `units = 3` 的报价**必然**被它自己的一致性检查拒绝，症状是
   "账目对不上"。全仓没有一处向 preparePurchase 传 units，因此 P22-6 /
   P22-5 的套件全绿，而这条路径从未被走过 —— 直到 `active-plans.js` 的
   `ACTIVE_ECONOMY_PROPOSAL_FIELDS` 里的 `units` 真的让模型提议 3 份。

   ── 组 ──────────────────────────────────────────────────────────────
     A  权威：units 是**报价**的一列（schema + 读面 + 旧行迁移）
     B  黄金路径：units = 1 / 3 / (grantQuantity = 1000, units = 3)
     C  单份语义与旧行为逐字兼容
     D  fail closed：坏 units 一律拒绝，且不猜一个 1
     E  幂等与结算时的一致性
     F  静态边界：权威只有一处
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-26u-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

/* ── 时钟与 id 都是注入的 ──────────────────────────────────────────────
   本文件不需要推进时间（没有一条断言关于过期），但"确定性"本身是有用的：
   失败时读到的 id 每次都一样。

   ★★ 计数器必须是**文件级**的，不能每个 store 各自从 1 开始 —— 否则同一个
   测试文件里的多个世界会生成**同一批 id**（`econ_wallet_u1` 出现在每一个
   世界里），于是 `listWallets({ownerId})` 会查到多行，而症状是一堆看起来
   毫不相关的断言失败（开发期实测踩到过：B1/B3/B5 的余额对不上，真正的
   原因却是"两个世界的钱包 id 相同"）。id 的唯一性是一个**跨 store** 的
   性质，因此生成器也必须是。 */
const CLOCK = 1717200000000;
function now() { return CLOCK; }
let idSeq = 0;
function deterministicIds() {
  return (kind) => { idSeq += 1; return C.formatEconomyId(kind, 'u' + idSeq).id; };
}
function makeStore(extra) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir, logger: () => {}, clock: now, nextId: deterministicIds()
  }, extra || {}));
}
let keySeq = 0;
function nextKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }

/* ── 夹具：一个 owner、一条不限额的预算、一个货架 ────────────────────
   ★ limits 必须写在 `limits` 里（顶层名字会被静默丢掉 —— P22-6 的 helper
   逐字记着这次真实陷阱）。这里的限额刻意给得很大：本文件要证明的是
   **份数**，不是预算闸门，因此绝不能让预算成为失败的原因。 */
function walletWith(store, amountMinor, ownerId) {
  const w = store.openWallet({ owner: { type: 'character', id: ownerId || 'cfg_a' }, currency: 'IB_CREDIT' });
  assert.equal(w.ok, true, 'openWallet must succeed: ' + J(w.errors));
  if (amountMinor && BigInt(amountMinor) !== 0n) {
    const m = store.mintForSystem({
      systemInitiated: true, walletId: w.wallet.walletId, currency: 'IB_CREDIT',
      amountMinor: amountMinor, idempotencyKey: 'seed-' + w.wallet.walletId
    });
    assert.equal(m.ok, true, 'mint must succeed: ' + J(m.errors));
  }
  return w.wallet;
}
function policyFor(store, ownerId) {
  const out = store.putBudgetPolicy({
    ownerId: ownerId, currency: 'IB_CREDIT',
    limits: { perTransactionMinor: 10000000, dailyMinor: 10000000, weeklyMinor: 10000000, monthlyMinor: 10000000 },
    idempotencyKey: nextKey('policy')
  });
  assert.equal(out.ok, true, 'putBudgetPolicy must succeed: ' + J(out.errors || out));
  return out.result;
}
function putStore(store) {
  const out = store.putStore({ name: 'Main Store', idempotencyKey: nextKey('store') });
  assert.equal(out.ok, true, 'putStore must succeed: ' + J(out.errors || out));
  return out.result;
}
function putProduct(store, storeId, options) {
  const out = store.putProduct(Object.assign({
    storeId: storeId, kind: 'DIGITAL_ITEM', name: 'Widget', currency: 'IB_CREDIT',
    unitPriceMinor: 400, grantQuantity: 1, idempotencyKey: nextKey('product')
  }, options || {}));
  assert.equal(out.ok, true, 'putProduct must succeed: ' + J(out.errors || out));
  return out.result;
}
/* 一个"世界"：开库 + 钱包 + 预算 + 货架。返回一个可复用的装配体。 */
function world(options) {
  const o = options || {};
  const store = makeStore(o.dataDir ? { dataDir: o.dataDir } : undefined);
  store.open();
  walletWith(store, o.balance === undefined ? 100000n : o.balance, o.ownerId || 'cfg_a');
  policyFor(store, o.ownerId || 'cfg_a');
  const st = putStore(store);
  return { store: store, storeId: st.storeId, ownerId: o.ownerId || 'cfg_a' };
}
function quoteOf(w, options) {
  const out = w.store.createProductQuote(Object.assign({
    buyerId: w.ownerId, units: 1, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  }, options || {}));
  assert.equal(out.ok, true, 'createProductQuote must succeed: ' + J(out.errors || out));
  return out.result;
}
function prepareOf(w, options) {
  const out = w.store.preparePurchase(Object.assign({
    buyerId: w.ownerId, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare')
  }, options || {}));
  assert.equal(out.ok, true, 'preparePurchase must succeed: ' + J(out.errors || out));
  /* ★ 返回**整个信封**（`ok` 在它上面，`result` 里没有 ok）。 */
  return out;
}
function settleOf(w, purchaseId) {
  const out = w.store.settlePurchase({ purchaseId: purchaseId, idempotencyKey: nextKey('settle') });
  assert.equal(out.ok, true, 'settlePurchase must succeed: ' + J(out));
  return out;
}
/* 一次完整的买：quote → prepare → settle。返回每一步的读数。
   ★ 读面形状的四条纪律（开发期实测踩到过三条，全部写下来避免再踩）：
     · `createProductQuote` 的结果把 quoteId 放在**顶层**（`result.quoteId`）；
       raw `createQuote` 的结果里额外有一个 `quote` 子对象 —— 两个 primitive
       的返回形状**不同**，因此这里一律读顶层；
     · `settlePurchase` / `preparePurchase` 的 **`ok` 在外层信封上**，而
       `result` 里没有 `ok` —— 于是 `settle.result.ok` 恒为 undefined。这里
       因此把信封的 ok 与 result 一起交出去（`settleOk` / `prepareOk`）；
     · `amountMinor` 是**字符串**（金额的读面形态），而 `grantedQuantity`
       **不在** settle 结果上 —— 要读"发放了多少"必须读 purchase 行；
     · `purchase.units` / `purchase.grantedQuantity` 是**数字**。 */
function buyOnce(w, productId, units) {
  const q = quoteOf(w, { productId: productId, units: units });
  const prep = prepareOf(w, { quoteId: q.quoteId });
  const settled = settleOf(w, prep.result.purchaseId);
  return {
    quote: q, prepare: prep, settle: settled,
    prepareOk: true, settleOk: true,
    purchase: w.store.getPurchase({ purchaseId: prep.purchaseId }).purchase
  };
}
function walletBalance(store, ownerId) {
  /* ★ `listWallets` 直接返回一个**数组**（它没有 ok 信封）—— 与 getWallet
     不同。这里用数组形态，避免把一个"读面形状"的差异写成一次断言失败。 */
  const rows = store.listWallets({ ownerId: ownerId || 'cfg_a' });
  assert.ok(Array.isArray(rows) && rows.length === 1, 'exactly one wallet must exist');
  /* ★ canonical 金额是 BigInt，而读面把它序列化成带 `n` 的字符串
     （`"100000n"`）—— 于是这里必须先去掉那个后缀再转，否则 BigInt() 会抛。
     这不是测试的怪癖：读面刻意用这个形态表达"这是一个整数金额，不是浮点"。 */
  return BigInt(String(rows[0].ledgerBalanceMinor).replace(/n$/, ''));
}
function inventoryOf(store, productId, ownerId) {
  return Number(store.inventoryQuantity(ownerId || 'cfg_a', productId).quantity);
}

/* ══════════════════════════════════════════════════════════════════
   A · 权威：units 是**报价**的一列
   ══════════════════════════════════════════════════════════════════ */
section('A · 权威：`units` 是报价自己的一列（不是请求里的一个数）');

{
  const w = world();
  const p = putProduct(w.store, w.storeId, { name: 'Repriceable', unitPriceMinor: 400, grantQuantity: 1 });
  const q = quoteOf(w, { productId: p.product.productId, units: 3 });

  check('A1 ★ 报价上写着 units = 3，而 quantity = 3（送达量 = units × grantQuantity = 3 × 1）',
    Number(q.quote.units) === 3 && Number(q.quote.quantity) === 3,
    { units: q.quote.units, quantity: q.quote.quantity });

  /* ★ 这一条与上一条**必须分开**：units 与 quantity 在 grantQuantity = 1 时
     恰好相等，因此一个"只存 quantity"的实现能通过上一条。grantQuantity = 1000
     时两者相差 1000 倍，于是"units 确实被单独保存了"只能在这里被证明。 */
  const pBulk = putProduct(w.store, w.storeId, { name: 'Bulk', unitPriceMinor: 2, grantQuantity: 1000 });
  const qBulk = quoteOf(w, { productId: pBulk.product.productId, units: 3 });
  check('A2 ★★ units = 3 而 quantity = 3000 —— units 与 quantity 是**两个**事实（不是同一个数的两个名字）',
    Number(qBulk.quote.units) === 3 && Number(qBulk.quote.quantity) === 3000 &&
    qBulk.quote.amountMinor === '6',
    { units: qBulk.quote.units, quantity: qBulk.quote.quantity, amountMinor: qBulk.quote.amountMinor });

  /* 读面：units 与 quantity 并列出现在报价 DTO 上。 */
  const got = w.store.getQuote({ quoteId: qBulk.quoteId });
  check('A3 报价的读面上 units 与 quantity 并列（于是"这份报价买了几份"可以被重新回答）',
    Number(got.quote.units) === 3 && Number(got.quote.quantity) === 3000,
    { quote: got.quote });

  /* 落库：不是"内存里算出来的一个数"。重开库之后它仍然在 —— 见下面的 A4
     （那里用的是真正的水位 7 的历史库，比"重开一次"更强）。 */

  /* ── A4 · 旧行迁移：一份"水位 7 的库"里的报价拿到 units = 1 ─────────
     这不是理论情况：任何已经跑过 P22-25 的世界，它的历史报价都是在没有
     units 这一列的时候写下的。迁移必须给它们一个答案，而唯一正确的答案
     是 1（那时 quantity 就等于 grantQuantity）。 */
  const legacyDir = tmpDir('legacy');
  const s1 = createEconomyStore({ dataDir: legacyDir, logger: () => {}, clock: now, nextId: deterministicIds() });
  s1.open();
  s1.close();
  const sqlite = require('node:sqlite');
  const raw = new sqlite.DatabaseSync(path.join(legacyDir, 'home-node.db'));
  /* 造一个真正的"水位 7 的库"：删掉 units 列做不到（SQLite 的 DROP COLUMN
     在旧版本上受限），因此这里换一条等价且更强的路子 —— 直接在**同一次**
     连接里把水位改回 7，再把 units 列从表定义里去掉需要重建表。
     更简单也更诚实的做法：验证**迁移那一步本身**对一张没有 units 的
     quotes 表做了什么。 */
  raw.exec('DROP TABLE economy_quotes');
  raw.exec('CREATE TABLE economy_quotes (quote_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, buyer_id TEXT NOT NULL, buyer_type TEXT NOT NULL, recipient_id TEXT, recipient_type TEXT, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL, quantity INTEGER NOT NULL, quote_kind TEXT NOT NULL, service_role TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL, predecessor_quote_id TEXT, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  raw.exec("INSERT INTO economy_quotes VALUES ('econ_quote_legacy', 'econ_product_legacy', 'cfg_a', 'character', NULL, NULL, 'IB_CREDIT', 400, 1, 'PURCHASE', 'PURCHASE', 'OPEN', 4102444800000, NULL, 'legacy-key', 'legacy-fp', 0, 0, 0)");
  raw.exec("UPDATE economy_meta SET value='7' WHERE key='economy_schema'");
  raw.close();
  const s2 = createEconomyStore({ dataDir: legacyDir, logger: () => {}, clock: now, nextId: deterministicIds() });
  const opened = s2.open();
  const legacyQuote = s2.getQuote({ quoteId: 'econ_quote_legacy' });
  check('A4 ★ 水位 7 的库打开后抬到 8，且那一份历史报价读到 units = 1（对旧行唯一正确的答案）',
    opened.ok === true && Number(opened.schemaVersion) === 8 &&
    legacyQuote.ok === true && Number(legacyQuote.quote.units) === 1,
    { opened: opened.schemaVersion, quote: legacyQuote.quote });
  /* 而那一列不是"可空 + 读的时候补 1"：它是 NOT NULL 的一列。 */
  const cols = new sqlite.DatabaseSync(path.join(legacyDir, 'home-node.db'))
    .prepare('PRAGMA table_info(economy_quotes)').all()
    .filter(r => String(r.name) === 'units');
  check('A5 ★★ 迁移加的那一列是 NOT NULL —— "可选 + 读的时候补 1"正是本阶段修掉的那个形态',
    cols.length === 1 && Number(cols[0].notnull) === 1,
    cols);
  s2.close();
  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   B · 黄金路径：quote → prepare → settle
   ══════════════════════════════════════════════════════════════════ */
section('B · 黄金路径：units = 1 / 3 / (grantQuantity = 1000, units = 3)');

{
  /* ── B1 · units = 1 ─────────────────────────────────────────────── */
  const w1 = world({ balance: 100000n });
  const p1 = putProduct(w1.store, w1.storeId, { name: 'Single', unitPriceMinor: 400, grantQuantity: 1 });
  const before1 = walletBalance(w1.store);
  const r1 = buyOnce(w1, p1.product.productId, 1);
  check('B1 units = 1 黄金路径：quote → prepare → settle 全通，钱包 -400，库存 +1',
    r1.settleOk === true && r1.settle.ok === true &&
    before1 - walletBalance(w1.store) === 400n &&
    inventoryOf(w1.store, p1.product.productId) === 1 &&
    Number(w1.store.getQuote({ quoteId: r1.quote.quoteId }).quote.units) === 1,
    { settled: r1.settleOk, balance: String(walletBalance(w1.store)), purchase: r1.purchase });

  /* ── B2 · units = 3（本阶段修掉的那一个）───────────────────────── */
  const w2 = world({ balance: 100000n });
  const p2 = putProduct(w2.store, w2.storeId, { name: 'Triple', unitPriceMinor: 400, grantQuantity: 1 });
  const before2 = walletBalance(w2.store);
  const q2 = quoteOf(w2, { productId: p2.product.productId, units: 3 });
  const prep2 = w2.store.preparePurchase({
    quoteId: q2.quoteId, buyerId: w2.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare')
  });
  check('B2 ★★ units = 3 的报价**可以** prepare（在 P22-26 之前这里恒为 QUOTE_MISMATCH"账目对不上"）',
    prep2.ok === true,
    { ok: prep2.ok, reasonCode: prep2.reasonCode, errors: prep2.errors });
  const settled2 = prep2.ok === true ? settleOf(w2, prep2.result.purchaseId) : null;
  const purchase2 = settled2 !== null ? w2.store.getPurchase({ purchaseId: prep2.result.purchaseId }).purchase : null;
  check('B3 ★★ units = 3 的购买：金额 = 3 × 400 = 1200，发放量 = 3，库存 +3，钱包 -1200',
    settled2 !== null && settled2.ok === true && purchase2 !== null &&
    before2 - walletBalance(w2.store) === 1200n &&
    inventoryOf(w2.store, p2.product.productId) === 3 &&
    Number(purchase2.units) === 3 && Number(purchase2.grantedQuantity) === 3 &&
    purchase2.amountMinor === '1200',
    {
      settled: settled2 && settled2.ok, errors: settled2 && settled2.errors,
      balance: String(walletBalance(w2.store)), inventory: inventoryOf(w2.store, p2.product.productId),
      purchase: purchase2
    });

  /* ── B4 · grantQuantity = 1000 且 units = 3 ────────────────────── */
  const w3 = world({ balance: 100000n });
  const p3 = putProduct(w3.store, w3.storeId, { name: 'BulkBuy', unitPriceMinor: 2, grantQuantity: 1000, unitName: 'computeUnit' });
  const before3 = walletBalance(w3.store);
  const q3 = quoteOf(w3, { productId: p3.product.productId, units: 3 });
  const prep3 = w3.store.preparePurchase({
    quoteId: q3.quoteId, buyerId: w3.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare')
  });
  check('B4 ★★ grantQuantity = 1000、units = 3：报价 amountMinor = 6、quantity = 3000，且 prepare 成功',
    q3.quote.amountMinor === '6' && Number(q3.quote.quantity) === 3000 &&
    prep3.ok === true,
    { amountMinor: q3.quote.amountMinor, quantity: q3.quote.quantity, reasonCode: prep3.reasonCode, errors: prep3.errors });
  const settled3 = prep3.ok === true ? settleOf(w3, prep3.result.purchaseId) : null;
  const purchase3 = settled3 !== null ? w3.store.getPurchase({ purchaseId: prep3.result.purchaseId }).purchase : null;
  const inv3 = inventoryOf(w3.store, p3.product.productId);
  check('B5 ★★ 结算后库存 +3000（= units 3 × grantQuantity 1000），而钱包只 -6（单价 2 × 3 份）',
    settled3 !== null && settled3.ok === true && purchase3 !== null &&
    before3 - walletBalance(w3.store) === 6n && inv3 === 3000 &&
    purchase3.amountMinor === '6' &&
    Number(purchase3.units) === 3 && Number(purchase3.grantedQuantity) === 3000,
    { balance: String(walletBalance(w3.store)), inventory: inv3, purchase: purchase3, errors: settled3 && settled3.errors });

  /* 这一条把"金额与发放量各自从不同的事实派生"钉死：如果哪天有人把
     amountMinor 也从 quantity 派生，B5 的 6 / 3000 会立刻变成别的数。 */
  check('B6 ★ units / quantity / amountMinor 三者在 bulk 情形下互不相同 —— 三个事实，三条派生路径',
    Number(q3.quote.units) === 3 && Number(q3.quote.quantity) === 3000 && q3.quote.amountMinor === '6');

  /* ── B7 · 反证：把旧代码的算法写出来，它必然拒绝 B4 那份报价 ──────
     这不是"复述缺陷"，而是**证明修复是必要的**：用 units = 1 去重算
     amountMinor 得到 2，与报价上的 6 不等 ⇒ 旧算法必拒。 */
  const legacyAmount = C.productQuoteAmountMinor({ unitPriceMinor: '2', grantQuantity: 1000, kind: 'DIGITAL_ITEM' }, 1);
  const legacyQuantity = C.productQuoteQuantity({ unitPriceMinor: '2', grantQuantity: 1000, kind: 'DIGITAL_ITEM' }, 1);
  check('B7 ★ 旧算法（假定 units = 1）对同一份报价算出 2 / 1000，与报价上的 6 / 3000 不等 —— 因此它**必然**拒绝',
    legacyAmount.ok === true && legacyAmount.amountMinor === 2n &&
    legacyQuantity.ok === true && legacyQuantity.quantity === 1000 &&
    legacyAmount.amountMinor !== 6n && legacyQuantity.quantity !== 3000,
    { legacyAmount: String(legacyAmount.amountMinor), legacyQuantity: legacyQuantity.quantity });

  w1.store.close(); w2.store.close(); w3.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   C · 单份语义与旧行为逐字兼容
   ══════════════════════════════════════════════════════════════════ */
section('C · 旧单数量语义保持兼容');

{
  const w = world({ balance: 100000n });
  const p = putProduct(w.store, w.storeId, { name: 'Compat', unitPriceMinor: 400, grantQuantity: 1 });

  /* 不传 units：整数缺省仍然是 1（P22-4 的 raw quote 与 P22-5 的产品报价
     都逐字如此）。 */
  const qDefault = w.store.createProductQuote({
    productId: p.product.productId, buyerId: w.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('C1 不传 units 时仍然是 1 份（P22-4 / P22-5 的缺省逐字不变）',
    qDefault.ok === true && Number(qDefault.result.quote.units) === 1 &&
    Number(qDefault.result.quote.quantity) === 1,
    { quote: qDefault.result.quote });

  /* raw createQuote（P22-4 的 primitive）也拿到 units = 1，而且它的行为
     一个字没变："随手写一个与目录不符的金额"仍然被允许 —— 拒绝发生在
     prepare 那一侧（P22-6 的 G3/G4 逐字冻结）。 */
  const raw = w.store.createQuote({
    buyerId: w.ownerId, currency: 'IB_CREDIT', amountMinor: 1, quantity: 1,
    productId: p.product.productId, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('rawquote')
  });
  check('C2 ★ raw createQuote 仍然可用，且它落下的 units 是 1（P22-4 的行为不变）',
    raw.ok === true && Number(raw.result.quote.units) === 1,
    { quote: raw.result && raw.result.quote });
  const wrongAmount = w.store.preparePurchase({
    quoteId: raw.result.quoteId, buyerId: w.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare')
  });
  check('C3 ★★ raw quote 写下与目录不符的金额 ⇒ prepare 仍然拒绝（QUOTE_MISMATCH"金额必须等于报价快照"）—— 价格快照的权威没有松动',
    wrongAmount.ok === false && wrongAmount.reasonCode === C.DENY_REASON.QUOTE_MISMATCH &&
    wrongAmount.errors.indexOf('purchase-amount-must-equal-the-quote-snapshot') >= 0,
    { reasonCode: wrongAmount.reasonCode, errors: wrongAmount.errors });

  /* 连续买 N 次（每次 units = 1）今天就能工作，而且每一次是一笔**新的**
     购买与一笔新的钱 —— 这证明"可重复购买"与"一次买 N 份"是两件事。 */
  const p2 = putProduct(w.store, w.storeId, { name: 'Repeat', unitPriceMinor: 100, grantQuantity: 1 });
  const before = walletBalance(w.store);
  const buys = [0, 1, 2].map(() => buyOnce(w, p2.product.productId, 1));
  check('C4 ★ 连买 3 次（每次 units = 1）：库存 3、钱包 -300、三笔 purchase 的 ledgerTransactionId 互不相同',
    inventoryOf(w.store, p2.product.productId) === 3 &&
    before - walletBalance(w.store) === 300n &&
    new Set(buys.map(b => b.settle.result.ledgerTransactionId)).size === 3,
    {
      inventory: inventoryOf(w.store, p2.product.productId),
      ids: buys.map(b => b.settle.result.ledgerTransactionId)
    });
  check('C5 ★★ 而这 3 笔购买是**独立**的（3 个不同的 quoteId / purchaseId）—— "买 3 次"不等于"买 1 次共 3 份"',
    new Set(buys.map(b => b.quote.quoteId)).size === 3 &&
    new Set(buys.map(b => b.prepare.result.purchaseId)).size === 3,
    { quotes: buys.map(b => b.quote.quoteId), purchases: buys.map(b => b.prepare.result.purchaseId) });

  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · fail closed：坏 units 一律拒绝，且不猜一个 1
   ══════════════════════════════════════════════════════════════════ */
section('D · fail closed：坏 units 拒绝，绝不猜 1');

{
  const w = world({ balance: 100000n });
  const p = putProduct(w.store, w.storeId, { name: 'Strict', unitPriceMinor: 400, grantQuantity: 1 });

  const bad = [0, -1, 1.5, 'three', null];
  const shaped = bad.map(u => {
    const out = w.store.createProductQuote({
      productId: p.product.productId, buyerId: w.ownerId, units: u,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
    });
    return { units: String(u), ok: out.ok, reasonCode: out.reasonCode, errors: out.errors };
  });
  /* ★ `null` 是**合法**的（= 不传 = 1 份），其余四种必须被拒。 */
  const rejected = shaped.filter(s => s.units !== 'null');
  const nullOne = shaped.filter(s => s.units === 'null')[0];
  check('D1 ★ 非法 units（0 / -1 / 1.5 / "three"）逐个被拒绝，理由是"份数必须是正的安全整数"',
    rejected.every(s => s.ok === false &&
      s.errors.indexOf('units-must-be-a-positive-safe-integer') >= 0),
    shaped);
  check('D2 ★ 而 units = null 是**缺省**（= 1 份），不是非法输入 —— 与 P22-4 起的行为一致',
    nullOne.ok === true, nullOne);

  /* ── D3 · 请求里的 units 是**被忽略**的键 ─────────────────────────
     这是"权威只有一处"的行为证明：把一个非法的 units 递给 prepare，它
     既不报错也不影响结果 —— 因为 prepare 根本不读它。 */
  const q3 = quoteOf(w, { productId: p.product.productId, units: 2 });
  const prepIgnoring = w.store.preparePurchase({
    quoteId: q3.quoteId, buyerId: w.ownerId, units: 0,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare')
  });
  const rowIgnoring = prepIgnoring.ok === true
    ? w.store.getPurchase({ purchaseId: prepIgnoring.result.purchaseId }).purchase : null;
  check('D3 ★★ 递给 prepare 的 units = 0 被**完全忽略**：成交的是报价说的 2 份（权威只有一处）',
    prepIgnoring.ok === true && rowIgnoring !== null && Number(rowIgnoring.units) === 2,
    { ok: prepIgnoring.ok, errors: prepIgnoring.errors, units: rowIgnoring && rowIgnoring.units });

  /* ── D4 · 报价行被手工改坏 ⇒ fail closed，不猜 1 ─────────────────
     `units` 是 NOT NULL CHECK (units >= 1)，因此把一份报价的 units 改成
     NULL 只能绕过列约束 —— 而"读到 NULL"必须是一次**拒绝**，不是一次
     "当作 1"。这正是本阶段修掉的形态：把"不知道"写成"知道"。 */
  const tamperDir = tmpDir('tamper');
  const w2 = world({ balance: 100000n, dataDir: tamperDir });
  const p2 = putProduct(w2.store, w2.storeId, { name: 'Tamper', unitPriceMinor: 400, grantQuantity: 1 });
  const q2 = quoteOf(w2, { productId: p2.product.productId, units: 2 });
  w2.store.close();
  const db = new (require('node:sqlite').DatabaseSync)(path.join(tamperDir, 'home-node.db'));
  /* 用 UPDATE 绕不过 CHECK (units >= 1)，所以这里改成一个**形状合法但关系
     被破坏**的 state：把 quantity 改成与 units × grantQuantity 不等。
     这是 quoteQuantitiesOf 那条载入期不变量唯一能被违反的方式（列约束
     挡住了另一半），也正是它存在的理由。 */
  db.exec("UPDATE economy_quotes SET quantity = 99 WHERE quote_id = '" + q2.quoteId + "'");
  db.close();
  const w3 = world({ balance: 100000n, dataDir: tamperDir });
  const tampered = w3.store.preparePurchase({
    quoteId: q2.quoteId, buyerId: w3.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare')
  });
  check('D4 ★★ 报价的 quantity 与 units × grantQuantity 不符时拒绝（QUOTE_MISMATCH），且**不**按 units 重算一个数',
    tampered.ok === false && tampered.reasonCode === C.DENY_REASON.QUOTE_MISMATCH &&
    tampered.errors.indexOf('quote-quantity-must-equal-units-times-grant-quantity') >= 0,
    { reasonCode: tampered.reasonCode, errors: tampered.errors });
  w3.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · 幂等与结算时的一致性
   ══════════════════════════════════════════════════════════════════ */
section('E · 幂等：units 是购买身份的一部分');

{
  const w = world({ balance: 100000n });
  const p = putProduct(w.store, w.storeId, { name: 'Idem', unitPriceMinor: 100, grantQuantity: 1 });
  const q = quoteOf(w, { productId: p.product.productId, units: 3 });

  const key = nextKey('prep');
  const first = w.store.preparePurchase({
    quoteId: q.quoteId, buyerId: w.ownerId, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key
  });
  const replay = w.store.preparePurchase({
    quoteId: q.quoteId, buyerId: w.ownerId, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key
  });
  check('E1 ★ 同一个幂等键重放同一次 prepare：replayed = true，且是**同一笔** purchase（units 没有让它变成第二笔）',
    first.ok === true && replay.ok === true && replay.replayed === true &&
    replay.result.purchaseId === first.result.purchaseId,
    { first: first.result && first.result.purchaseId, replay: replay.result && replay.result.purchaseId });

  const settled = settleOf(w, first.result.purchaseId);
  const settledRow = w.store.getPurchase({ purchaseId: first.result.purchaseId }).purchase;
  check('E2 ★ 结算后 purchase.units = 3 且 granted_quantity = 3 —— 两列都落库，两列都不为 null',
    settled.ok === true && Number(settledRow.units) === 3 && Number(settledRow.grantedQuantity) === 3 &&
    settledRow.amountMinor === '300',
    { units: settledRow.units, grantedQuantity: settledRow.grantedQuantity, amountMinor: settledRow.amountMinor });

  /* 结算重放：库存**不再增加**。 */
  const invBefore = inventoryOf(w.store, p.product.productId);
  const settleReplay = w.store.settlePurchase({ purchaseId: first.result.purchaseId, idempotencyKey: nextKey('settle') });
  check('E3 ★ 已完成的购买再 settle：终态冲突（terminal = true），库存不再增加',
    settleReplay.ok !== true && settleReplay.terminal === true &&
    inventoryOf(w.store, p.product.productId) === invBefore,
    { terminal: settleReplay.terminal, reasonCode: settleReplay.reasonCode, inventory: inventoryOf(w.store, p.product.productId) });

  /* ── E4 · units 进的是**购买身份** ────────────────────────────────
     preparePurchase 的指纹里有 (quoteId, units, amountMinor, …)，因此
     "换一份份数不同的报价、复用同一个幂等键"必须是两件事。正确的回答是
     **冲突**，而不是"同一件事的另一种说法"。
     ★ 冲突的**形状**是 `errors: ['IDEMPOTENCY_CONFLICT']`，而 reasonCode
     不存在（`undefined`）—— 这正是 P22-2 起冻结的形态：幂等冲突不是一个
     "被拒绝的经济操作"，因此它**不借用**一个 DENY_REASON 的名字。这条
     断言因此读 errors，并且用 `== null` 而不是 `=== null` 去表达"它没有
     一个 reason code"（`undefined` 与 `null` 在这里是同一件事）。 */
  const q2 = quoteOf(w, { productId: p.product.productId, units: 2 });
  const conflict = w.store.preparePurchase({
    quoteId: q2.quoteId, buyerId: w.ownerId, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key
  });
  check('E4 ★ 同一个幂等键换一份 units 不同的报价 ⇒ 冲突拒绝（份数是购买身份的一部分，不是可忽略的元数据）',
    conflict.ok === false && conflict.reasonCode == null &&
    Array.isArray(conflict.errors) && conflict.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0,
    { reasonCode: conflict.reasonCode, errors: conflict.errors });

  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · 静态边界：权威只有一处
   ══════════════════════════════════════════════════════════════════ */
section('F · 静态：`units` 的读取只有一处实现');

{
  const raw = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  /* ★★ 静态检查必须在**剥离注释**之后做，否则它证明的是"注释里没有这句话"
     —— 而本阶段的说明注释里逐字引用着旧代码（`o.units == null ? 1 : …`），
     于是不剥注释的版本会以"红色的假象"失败。这不是猜测：开发期实测踩到过
     （计数 6 而不是 2）。剥离规则与 P22-5 J3 逐字同款。 */
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  /* ── F1 · 三处"从 payload 猜 units"都消失了 ────────────────────
     P22-26 之前，`o.units == null ? 1 : Number(o.units)` 出现在**五**个
     函数里。现在只允许剩下两个：
       · createQuote（P22-4 的 primitive：没有商品行，因而没有 grantQuantity
         概念 —— raw 调用方写下的 quantity 就是送达量）；
       · createProductQuote（产品报价的**创建**方："买一份"是缺省，而这份
         份正是要落库的那一个）。
     而 preparePurchase / createApprovalRequest / authorizePurchaseIntent
     三者**一个都不能有** —— 它们的权威是报价上那一列。 */
  const derivations = (src.match(/o\.units == null \? 1/g) || []).length;
  check('F1 ★★ 剥离注释后全仓只剩**两**处 units 缺省（createQuote 与 createProductQuote），三处下游读取全部改为读报价',
    derivations === 2, { count: derivations });
  /* 缺省必须恰好在那两个函数里（不是"数量对了但位置错了"）。 */
  const ownerOf = (index) => {
    const head = src.slice(0, index);
    const m = head.match(/function\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/g);
    return m ? m[m.length - 1].replace(/function\s+/, '').replace(/\s*\(.*$/, '') : null;
  };
  const derivationOwners = [];
  let cursor = -1;
  while ((cursor = src.indexOf('o.units == null ? 1', cursor + 1)) >= 0) derivationOwners.push(ownerOf(cursor));
  check('F1b ★ 那两处缺省确实分别在 createQuote 与 createProductQuote 里（位置也对了，不只是数量对了）',
    derivationOwners.length === 2 &&
    derivationOwners.indexOf('createQuote') >= 0 &&
    derivationOwners.indexOf('createProductQuote') >= 0,
    { owners: derivationOwners });

  const funcOf = (name) => {
    const at = src.indexOf('function ' + name + '(');
    return at < 0 ? null : src.slice(at, at + 9000);
  };
  const downstream = ['preparePurchase', 'createApprovalRequest', 'authorizePurchaseIntent'];
  const offenders = downstream.filter(name => {
    const body = funcOf(name);
    return body == null || body.indexOf('o.units') >= 0;
  });
  check('F2 ★★ preparePurchase / createApprovalRequest / authorizePurchaseIntent 里**没有一处**读 o.units（连注释也没有，因为注释已剥离）',
    offenders.length === 0, { offenders: offenders });
  check('F3 ★ 而它们三者都通过 quoteQuantitiesOf 读报价上的份数（同一条实现，因此不可能漂移）',
    downstream.every(name => {
      const body = funcOf(name);
      return body != null && body.indexOf('quoteQuantitiesOf(') >= 0;
    }),
    { present: downstream.map(name => { const b = funcOf(name); return { name: name, ok: b != null && b.indexOf('quoteQuantitiesOf(') >= 0 }; }) });
  /* 而全仓只有**一份** quoteQuantitiesOf 实现（它不是被复制了三份）。 */
  check('F3b ★ 全仓只有一个 quoteUnitsOf / quoteQuantitiesOf 定义（三处下游共用同一条读法）',
    (src.match(/function quoteUnitsOf\(/g) || []).length === 1 &&
    (src.match(/function quoteQuantitiesOf\(/g) || []).length === 1);

  /* ── F4 · 报价的唯一状态推进语句的 SET 里没有 units / quantity ── */
  const setQuoteState = raw.match(/setQuoteState:[\s\S]{0,300}?',/);
  check('F4 ★★ 报价的**唯一**状态推进语句的 SET 里没有 units / quantity（两个事实都是不可变的）',
    setQuoteState != null &&
    setQuoteState[0].indexOf('units') < 0 && setQuoteState[0].indexOf('quantity') < 0,
    { stmt: setQuoteState && setQuoteState[0] });

  /* ── F5 · 迁移只加列 ──────────────────────────────────────────── */
  const at78 = src.indexOf('from: 7, to: 8');
  const block = at78 < 0 ? '' : src.slice(at78, at78 + 1200);
  check('F5 ★ 7 → 8 的迁移只加列（ALTER + ADD COLUMN），没有 UPDATE / DELETE / INSERT（不改写任何既有值）',
    block.indexOf('ALTER TABLE') >= 0 && block.indexOf('ADD COLUMN units INTEGER NOT NULL') >= 0 &&
    block.indexOf('UPDATE ') < 0 && block.indexOf('DELETE ') < 0 && block.indexOf('INSERT ') < 0);

  /* ── F6 · 水位 ────────────────────────────────────────────────── */
  check('F6 ★ store 的 schema 水位抬到 8（quotes.units 是一次**既有实体上的新事实**）',
    Number(createEconomyStore.SCHEMA_VERSION) === 8, { version: createEconomyStore.SCHEMA_VERSION });
}

process.on('exit', (code) => {
  if (code === 0 && failures > 0) process.exitCode = 1;
});
console.log('\n' + (failures === 0
  ? '════════════════════════════════════════════════════════════════'
    + '\nP22-26 产品份数契约：全部通过 ✔'
    : '════════════════════════════════════════════════════════════════'
    + '\nP22-26 产品份数契约：' + failures + ' 项失败 ✘'));
if (failures > 0) process.exitCode = 1;
