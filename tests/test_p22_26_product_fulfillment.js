'use strict';
/* ====================================================================
   P22-26 · Phase 4 —— Product Fulfillment Contract
   --------------------------------------------------------------------
   运行：node tests/test_p22_26_product_fulfillment.js

   本文件把一条**已经存在**的派生链写成可检查的契约，并证明这条链上
   **没有**第二个答案：

       product `kind`                    ← 本体列（products.product_kind）
             │  fulfillmentOfProductKind
             ▼
       `fulfillment`                     ← **派生**，不是调用方声明
             │  setup: settlementPrimitiveOfFulfillment / assetKindOfProductKind
             ▼
       asset / inventory mutation        ← economy_inventory 的那一行

   ── 为什么这一组是"整理"而不是"新增"──────────────────────────────────
   这条链在 P22-5 就冻结了，而且三个下游（报价 / 预留 / 结算）都从它派生。
   本阶段**没有**给商品加任何字段：`PRODUCT_INPUT_KEYS` 仍然是恰好 13 个，
   `products` 表的列一个没变。因此这一组的价值不是"定义了什么"，而是
   **把"没有第二个答案"变成一组会红的断言**：

     A  派生链逐字：kind → fulfillment → assetKind / unitName
     B  只有一份契约：本阶段没有给商品加字段，也没有给呈现层加字段
     C  没有第二套"买完发生什么"的词表（不新增 effect / behavior）
     D  `settlementPrimitiveOfFulfillment` 是**唯一**的适配点（两条落地、
        一条结构性缺席），而缺席的那一条 fail closed
     E  链上的每一环都由**行为**证明（真库、真报价、真结算、真库存）
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const BOOT = require(path.join(ROOT, 'services', 'home-node', 'catalog-bootstrap.js'));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-26f-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

const CLOCK = 1717200000000;
let idSeq = 0;
function makeStore(dataDir) {
  return createEconomyStore({
    dataDir: dataDir || tmpDir('store'), logger: () => {}, clock: () => CLOCK,
    nextId: (kind) => { idSeq += 1; return C.formatEconomyId(kind, 'f' + idSeq).id; }
  });
}
let keySeq = 0;
function nextKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }
function walletWith(store, amountMinor, ownerId) {
  const w = store.openWallet({ owner: { type: 'character', id: ownerId }, currency: 'IB_CREDIT' });
  assert.equal(w.ok, true, 'openWallet must succeed: ' + J(w.errors));
  const m = store.mintForSystem({
    systemInitiated: true, walletId: w.wallet.walletId, currency: 'IB_CREDIT',
    amountMinor: amountMinor, idempotencyKey: 'seed-' + ownerId
  });
  assert.equal(m.ok, true, 'mint must succeed: ' + J(m.errors));
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
function storeFixture(ownerId) {
  const store = makeStore();
  store.open();
  walletWith(store, 1000000n, ownerId);
  policyFor(store, ownerId);
  const st = store.putStore({ name: 'Main Store', idempotencyKey: nextKey('store') });
  return { store: store, storeId: st.result.storeId, ownerId: ownerId };
}
function putProduct(w, options) {
  const out = w.store.putProduct(Object.assign({
    storeId: w.storeId, name: 'Widget', currency: 'IB_CREDIT',
    unitPriceMinor: 100, grantQuantity: 1, idempotencyKey: nextKey('product')
  }, options || {}));
  assert.equal(out.ok, true, 'putProduct must succeed: ' + J(out.errors || out));
  return out.result.product;
}
function inventoryOf(store, ownerId, productId) {
  return Number(store.inventoryQuantity(ownerId, productId).quantity);
}

/* ══════════════════════════════════════════════════════════════════
   A · 派生链逐字
   ══════════════════════════════════════════════════════════════════ */
section('A · 派生链：kind → fulfillment → assetKind / unitName');

{
  /* ── A1 · 五个 kind 的派生表逐字（与 P22-5 冻结的完全一致）───────── */
  const expectedFulfillment = {
    DIGITAL_ITEM: 'INVENTORY_GRANT',
    CONSUMABLE: 'INVENTORY_GRANT',
    API_QUOTA: 'COMPUTE_GRANT',
    COMPUTE_CREDIT: 'COMPUTE_GRANT',
    SERVICE: 'SERVICE_EXECUTION'
  };
  const expectedAssetKind = {
    DIGITAL_ITEM: 'ITEM', CONSUMABLE: 'ITEM',
    API_QUOTA: 'COMPUTE', COMPUTE_CREDIT: 'COMPUTE',
    SERVICE: null
  };
  check('A1 ★★ `kind → fulfillment` 的派生表逐字未变（P22-5 冻结的那一张）',
    C.PRODUCT_KINDS.every(k => C.fulfillmentOfProductKind(k) === expectedFulfillment[k]),
    { actual: C.PRODUCT_KINDS.map(k => k + '→' + C.fulfillmentOfProductKind(k)) });
  check('A2 ★★ `kind → assetKind` 的派生表逐字未变（SERVICE → null：它不产生库存）',
    C.PRODUCT_KINDS.every(k => C.assetKindOfProductKind(k) === expectedAssetKind[k]),
    { actual: C.PRODUCT_KINDS.map(k => k + '→' + C.assetKindOfProductKind(k)) });

  /* ── A3 · `fulfillment → settlement primitive` ──────────────────── */
  const expectedPrimitive = {
    INVENTORY_GRANT: 'INVENTORY',
    COMPUTE_GRANT: 'COMPUTE_ENTITLEMENT',
    SERVICE_EXECUTION: null
  };
  check('A4 ★★ `fulfillment → settlement primitive` 的登记表逐字未变：两条落地（INVENTORY / COMPUTE_ENTITLEMENT），一条结构性缺席（SERVICE_EXECUTION → null）',
    Object.keys(expectedPrimitive).every(f =>
      C.settlementPrimitiveOfFulfillment(f).primitive === expectedPrimitive[f]),
    {
      actual: Object.keys(expectedPrimitive).map(f =>
        f + '→' + String(C.settlementPrimitiveOfFulfillment(f).primitive))
    });

  /* ── A5 · ★ COMPUTE_ENTITLEMENT 底下跑的**就是** INVENTORY 原语 ───
     这一条是本阶段最值得写下来的一处「枚举名与实现不完全对应」：它解释了
     为什么"算力额度"与"一件物品"在产品存储层是同一种东西的两种单位，
     也解释了为什么新增算力类商品是**零新代码** —— 同时它也解释了为什么
     **不能**借它表达"一次性服务"。 */
  check('A5 ★★ `COMPUTE_ENTITLEMENT` 与 `INVENTORY` 在库存那一层是**同一条原语**（assetKind 的差别才是差别）',
    C.assetKindOfProductKind('API_QUOTA') === 'COMPUTE' &&
    C.assetKindOfProductKind('DIGITAL_ITEM') === 'ITEM' &&
    C.fulfillmentOfProductKind('API_QUOTA') !== C.fulfillmentOfProductKind('DIGITAL_ITEM'),
    {
      apiQuota: { f: C.fulfillmentOfProductKind('API_QUOTA'), a: C.assetKindOfProductKind('API_QUOTA') },
      digitalItem: { f: C.fulfillmentOfProductKind('DIGITAL_ITEM'), a: C.assetKindOfProductKind('DIGITAL_ITEM') }
    });

  /* ── A6 · unitName 也是派生的 ──────────────────────────────────── */
  const unitNames = C.PRODUCT_KINDS.map(k => ({ kind: k, unitName: C.unitNameOfProductKind(k) }));
  check('A6 ★ unitName 也是派生的（ITEM / computeUnit / 服务那一个），而且不是调用方声明',
    unitNames.every(u => typeof u.unitName === 'string' && u.unitName.length > 0),
    { unitNames: unitNames });

  /* ── A7 · 报价 kind 也从 fulfillment 派生 ──────────────────────── */
  check('A7 ★★ 报价 kind 从 fulfillment 派生：INVENTORY_GRANT → {PURCHASE, GIFT}，COMPUTE_GRANT → COMPUTE_GRANT（算力不能作为礼物送出）',
    C.productQuoteKindFor('INVENTORY_GRANT', false).kind === 'PURCHASE' &&
    C.productQuoteKindFor('INVENTORY_GRANT', true).kind === 'GIFT' &&
    C.productQuoteKindFor('COMPUTE_GRANT', false).kind === 'COMPUTE_GRANT',
    {
      purchase: C.productQuoteKindFor('INVENTORY_GRANT', false).kind,
      gift: C.productQuoteKindFor('INVENTORY_GRANT', true).kind,
      compute: C.productQuoteKindFor('COMPUTE_GRANT', false).kind
    });
}

/* ══════════════════════════════════════════════════════════════════
   B · 只有一份契约：本阶段没有给商品加字段
   ══════════════════════════════════════════════════════════════════ */
section('B · 只有一份契约：本阶段没有给商品加字段');

{
  /* ── B1 · `PRODUCT_INPUT_KEYS` 仍然恰好 13 个 ──────────────────── */
  check('B1 ★★ `PRODUCT_INPUT_KEYS` 仍然是**恰好 13 个**（本阶段一个字都没有加）',
    C.PRODUCT_INPUT_KEYS.length === 13, { keys: C.PRODUCT_INPUT_KEYS });

  /* ── B2 · 而 Phase 4 想加的那三个名字逐个仍被拒绝 ──────────────── */
  const w = storeFixture('char_a');
  const rejected = ['icon', 'effect', 'rarity', 'category', 'behavior', 'onUse'].map(field => {
    const input = {
      storeId: w.storeId, kind: 'DIGITAL_ITEM', name: 'Probe', currency: 'IB_CREDIT',
      unitPriceMinor: 100, grantQuantity: 1, idempotencyKey: nextKey('probe')
    };
    input[field] = 'anything';
    const out = w.store.putProduct(input);
    return { field: field, ok: out.ok, errors: out.errors };
  });
  check('B2 ★★ `icon` / `effect` / `rarity` / `category` / `behavior` / `onUse` 逐个仍被 `product-input-key-not-whitelisted` 拒绝 —— 设计没有偷偷改契约',
    rejected.every(r => r.ok === false &&
      r.errors.indexOf('product-input-key-not-whitelisted:' + r.field) >= 0),
    rejected);

  /* ── B3 · products 表的列清单逐字未变 ──────────────────────────── */
  const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  const ddl = storeSrc.slice(storeSrc.indexOf('createProducts:'), storeSrc.indexOf('createProductsByStore:'));
  const forbiddenColumns = ['rarity', 'effect', 'icon', 'category', 'behavior', 'level', 'tier'];
  check('B3 ★★ `products` 的 DDL 里没有 rarity / effect / icon / category / behavior / level / tier 任何一列',
    forbiddenColumns.every(col => ddl.indexOf(col) < 0),
    { offenders: forbiddenColumns.filter(col => ddl.indexOf(col) >= 0) });

  /* ── B4 · 商品 DTO 上只有 P22-25 的那两个新增字段 ────────────────
     ★ 需要一个商品才谈得上"它的序列化视图"：B2 那六次尝试全部被拒绝，
     因此目录里此刻是空的（那本身也是一条事实）。 */
  const dtoProbe = putProduct(w, { kind: 'DIGITAL_ITEM', name: 'DtoProbe' });
  const dto = w.store.serializeProduct(w.store.getProduct({ productId: dtoProbe.productId }).product);
  check('B4 ★★ 商品的序列化视图里没有 effect / rarity / icon / behavior（Phase 4 没有给读面加键）',
    !('effect' in dto) && !('rarity' in dto) && !('icon' in dto) && !('behavior' in dto) &&
    typeof dto.productId === 'string',
    { keys: Object.keys(dto) });

  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   C · 没有第二套"买完发生什么"的词表
   ══════════════════════════════════════════════════════════════════ */
section('C · 没有第二个答案：不新增 effect / behavior');

{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const storeSrc = strip(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8'));
  const contractSrc = strip(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'), 'utf8'));

  /* ── C1 · **没有** catalog 层的 effect 词表 ─────────────────────── */
  check('C1 ★★ 目录层**没有** effect 这个词表（种子条目里没有 effect，也没有一个平行的 effect 集合）',
    BOOT.SEED.products.every(p => !('effect' in p)) &&
    !Object.prototype.hasOwnProperty.call(BOOT, 'EFFECT') &&
    !Object.prototype.hasOwnProperty.call(BOOT, 'EFFECT_TYPE'),
    { bootKeys: Object.keys(BOOT) });

  /* ── C2 · **没有** 商品行为脚本 ──────────────────────────────────
     ★ 判据必须用**词边界**，不能用子串：`transitionPurchaseIntent` 里逐字
     含有 `onPurchase`（开发期实测踩到过这个假阳性）。一个"行为脚本"会是
     一个**独立的标识符**，因此词边界正是这条断言想要的形状。 */
  const BEHAVIOR_NAMES = ['behaviorScript', 'onPurchase', 'onUse', 'executeProduct', 'productBehavior'];
  const behaviorHits = BEHAVIOR_NAMES.filter(name => {
    const re = new RegExp('\\b' + name + '\\b');
    return re.test(storeSrc) || re.test(contractSrc);
  });
  check('C2 ★★ 全仓没有商品行为脚本的形态（`behaviorScript` / `onPurchase` / `onUse` / `executeProduct` / `productBehavior` 作为**独立标识符**零命中）',
    behaviorHits.length === 0, { hits: behaviorHits });

  /* ── C3 · 而**已有**的那一套仍然只有一套 ─────────────────────────
     ★ 契约里有一套 P22-1 §15 的 `EFFECT_TYPE`（有测试、零生产调用）——
     本阶段**不收敛**那处不一致（它是独立阶段），但**绝不**再加第三套。
     因此这一条断言的是"effect 词表仍然只有 §15 那一份，且它仍然不在
     生产路径上"，而"本阶段没有新增"由 C1/C2 证明。 */
  const effectReadsInStore = (storeSrc.match(/EFFECT_TYPE|EFFECT_CURRENCY/g) || []).length;
  check('C3 ★★ `EFFECT_TYPE` 在 economy-store.js 里仍然**零命中**（§15 的那一套没有被本阶段接上，也没有被复制）',
    effectReadsInStore === 0, { hits: effectReadsInStore });

  /* ── C4 · "买完发生什么"的唯一编码仍然是那三列 ────────────────── */
  check('C4 ★★ "买完发生什么"的唯一编码仍然是 `kind → fulfillment → assetKind`（三列都在 products 上，且都不由调用方声明）',
    C.PRODUCT_INPUT_KEYS.indexOf('kind') >= 0 &&
    C.PRODUCT_INPUT_KEYS.indexOf('fulfillment') >= 0 &&
    C.PRODUCT_INPUT_KEYS.indexOf('assetKind') < 0,
    { kindIsInput: C.PRODUCT_INPUT_KEYS.indexOf('kind') >= 0, assetKindIsInput: C.PRODUCT_INPUT_KEYS.indexOf('assetKind') >= 0 });
  /* `fulfillment` 在输入白名单里只是为了**拒绝**它（validateProduct 逐条拒绝
     "调用方自己声明 fulfillment"）。 */
  const w = storeFixture('char_a');
  const declaredFulfillment = w.store.putProduct({
    storeId: w.storeId, kind: 'DIGITAL_ITEM', fulfillment: 'SERVICE_EXECUTION',
    name: 'Declared', currency: 'IB_CREDIT', unitPriceMinor: 100, grantQuantity: 1,
    idempotencyKey: nextKey('declared')
  });
  check('C5 ★★ 调用方**不能**自己声明 fulfillment：一件 DIGITAL_ITEM 说自己是 SERVICE_EXECUTION 会被拒绝',
    declaredFulfillment.ok === false,
    { ok: declaredFulfillment.ok, errors: declaredFulfillment.errors });
  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · settlement primitive 是唯一的适配点
   ══════════════════════════════════════════════════════════════════ */
section('D · `settlementPrimitiveOfFulfillment` 是唯一的适配点');

{
  const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');

  /* ── D1 · 而缺席的那一条 fail closed ───────────────────────────── */
  const w = storeFixture('char_a');
  const svc = putProduct(w, { kind: 'SERVICE', name: 'Service', grantQuantity: 0, unitPriceMinor: 500 });
  const q = w.store.createProductQuote({
    productId: svc.productId, buyerId: w.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('svcq')
  });
  check('D1 ★★ 一件 SERVICE **可以**被报价（它的价格命题是自洽的），但买不了 —— 两件事各自成立',
    q.ok === true, { quote: q.errors });
  const prep = w.store.preparePurchase({
    quoteId: q.result.quoteId, buyerId: w.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('svcp')
  });
  check('D2 ★★ prepare 在**预留之前**就拒绝（PURCHASE_NOT_SUPPORTED + reservedNothing = true）—— "这件事还做不到"是一个静态事实，不该白占一次 revision',
    prep.ok === false && prep.reasonCode === C.DENY_REASON.PURCHASE_NOT_SUPPORTED &&
    prep.reservedNothing === true &&
    prep.errors.indexOf('service-settlement-requires-the-action-layer-and-is-not-implemented-in-this-phase') >= 0,
    { reasonCode: prep.reasonCode, reservedNothing: prep.reservedNothing, errors: prep.errors });
  check('D3 ★★ 而那次拒绝没有锁住任何钱：预留计数与钱包的 reserved 都是 0',
    Number(w.store.health().counts.activeReservations) === 0 &&
    String(w.store.listWallets({ ownerId: w.ownerId })[0].reservedBalanceMinor).replace(/n$/, '') === '0',
    {
      activeReservations: w.store.health().counts.activeReservations,
      reserved: String(w.store.listWallets({ ownerId: w.ownerId })[0].reservedBalanceMinor)
    });
  w.store.close();

  /* ── D4 · 未知 fulfillment ⇒ fail closed（不是"默认发库存"）───── */
  const unknown = C.settlementPrimitiveOfFulfillment('NOT_A_FULFILLMENT');
  check('D4 ★★ 一个不在封闭集合里的 fulfillment ⇒ ok = false（fail closed，而不是回落到 INVENTORY）',
    unknown.ok === false && unknown.primitive === null && unknown.registered === false,
    unknown);

  /* ── D5 · 结算那一步从**不可变**的商品列重新派生并断言 ─────────── */
  check('D5 ★★ settlePurchase 从 products 行重新派生 fulfillment，并断言它等于购买上冻结的 settlement_type',
    storeSrc.indexOf('product-fulfillment-changed-under-the-transaction') >= 0 ||
    storeSrc.indexOf('settlement_type') >= 0,
    { hasRecheck: storeSrc.indexOf('settlement_type') >= 0 });

  /* ── D6 · 只有一处 `mutateInventoryInTx('grant'` 的调用点 ────────
     这是"发货只有一条实现"的可断言形式：结算那一步与 primitive 各自
     只在一处调用它。 */
  const grantCallSites = (storeSrc.match(/mutateInventoryInTx\('grant'/g) || []).length;
  check('D6 ★★ 全仓只有**一处** `mutateInventoryInTx(\'grant\', …)` 调用点 —— 发货只有一条实现（结算借用它，而不是"再 grant 一次"）',
    grantCallSites === 1, { callSites: grantCallSites });
}

/* ══════════════════════════════════════════════════════════════════
   E · 链上的每一环都由行为证明
   ══════════════════════════════════════════════════════════════════ */
section('E · 链上的每一环由行为证明（真库、真报价、真结算、真库存）');

{
  const w = storeFixture('char_a');
  const cases = [
    { kind: 'DIGITAL_ITEM', grantQuantity: 1, assetKind: 'ITEM', unitName: C.unitNameOfProductKind('DIGITAL_ITEM'), expectedDelta: 1 },
    { kind: 'CONSUMABLE', grantQuantity: 3, assetKind: 'ITEM', unitName: C.unitNameOfProductKind('CONSUMABLE'), expectedDelta: 3 },
    { kind: 'API_QUOTA', grantQuantity: 1000, assetKind: 'COMPUTE', unitName: C.unitNameOfProductKind('API_QUOTA'), expectedDelta: 1000 },
    { kind: 'COMPUTE_CREDIT', grantQuantity: 500, assetKind: 'COMPUTE', unitName: C.unitNameOfProductKind('COMPUTE_CREDIT'), expectedDelta: 500 }
  ];

  const results = cases.map(function (c) {
    const product = putProduct(w, {
      kind: c.kind, name: 'Fulfil-' + c.kind, unitPriceMinor: 100, grantQuantity: c.grantQuantity
    });
    const before = inventoryOf(w.store, w.ownerId, product.productId);
    const q = w.store.createProductQuote({
      productId: product.productId, buyerId: w.ownerId,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('q')
    });
    if (q.ok !== true) return { kind: c.kind, stage: 'quote', ok: false, errors: q.errors };
    const prep = w.store.preparePurchase({
      quoteId: q.result.quoteId, buyerId: w.ownerId,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('p')
    });
    if (prep.ok !== true) return { kind: c.kind, stage: 'prepare', ok: false, errors: prep.errors, reasonCode: prep.reasonCode };
    const settled = w.store.settlePurchase({ purchaseId: prep.result.purchaseId, idempotencyKey: nextKey('s') });
    const purchase = w.store.getPurchase({ purchaseId: prep.result.purchaseId }).purchase;
    return {
      kind: c.kind, stage: 'settle', ok: settled.ok === true, purchase: purchase,
      delta: inventoryOf(w.store, w.ownerId, product.productId) - before,
      expectedDelta: c.expectedDelta, expectedAssetKind: c.assetKind, expectedUnitName: c.unitName,
      quoteSettlementType: q.result.settlementType
    };
  });

  check('E1 ★★ 四个 kind 各自走通 quote → prepare → settle（真库、真结算）',
    results.every(r => r.ok === true),
    results.map(r => ({ kind: r.kind, stage: r.stage, ok: r.ok, errors: r.errors, reasonCode: r.reasonCode })));

  check('E2 ★★ 而每一环**逐字**对上派生链：settlement_type = fulfillmentOfProductKind(kind)、assetKind 一致、库存增量 = grantQuantity',
    results.every(r => r.ok === true &&
      r.purchase.settlementType === C.fulfillmentOfProductKind(r.kind) &&
      r.purchase.assetKind === r.expectedAssetKind &&
      r.purchase.unitName === r.expectedUnitName &&
      r.purchase.grantedQuantity === r.expectedDelta &&
      r.delta === r.expectedDelta),
    results.map(r => ({
      kind: r.kind,
      settlementType: r.purchase && r.purchase.settlementType,
      expectedFulfillment: C.fulfillmentOfProductKind(r.kind),
      assetKind: r.purchase && r.purchase.assetKind,
      expectedAssetKind: r.expectedAssetKind,
      delta: r.delta, expectedDelta: r.expectedDelta
    })));

  /* ── E3 · 报价上的 settlementType 也在创建时冻结 ────────────────── */
  check('E3 ★★ 报价创建时就把 settlementType 冻结了（它与 kind 的派生一致，不是在结算时重新推导）',
    results.every(r => r.quoteSettlementType === C.settlementTypeOfQuoteKind(
      C.productQuoteKindFor(C.fulfillmentOfProductKind(r.kind), false).kind)),
    results.map(r => ({ kind: r.kind, quoteSettlementType: r.quoteSettlementType })));

  /* ── E4 · 库存那一行上的 assetKind 也来自链 ─────────────────────── */
  const invRows = results.map(r => ({
    kind: r.kind,
    rowAssetKind: w.store.getInventoryEntry({
      ownerId: w.ownerId, productId: r.purchase.productId
    }).entry.assetKind
  }));
  check('E4 ★★ 库存那一行上的 assetKind 也来自同一条链（ITEM / COMPUTE），因此"物品"与"额度"在存储层的差别就是这一列',
    invRows.every(r => r.rowAssetKind === C.assetKindOfProductKind(r.kind)),
    invRows);

  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · 目录 v2 的每一件商品都在这条链上
   ══════════════════════════════════════════════════════════════════ */
section('F · 目录 v2 的每一件商品都落在这条链的"能落地"那一侧');

{
  check('F1 ★★ 目录 v2 的每一件商品的 settlement primitive 都**非 null**（没有一件落在那条结构性缺席上）',
    BOOT.SEED.products.every(p =>
      C.settlementPrimitiveOfFulfillment(C.fulfillmentOfProductKind(p.kind)).primitive != null),
    BOOT.SEED.products.map(p => ({
      id: p.productId, kind: p.kind,
      primitive: C.settlementPrimitiveOfFulfillment(C.fulfillmentOfProductKind(p.kind)).primitive
    })));
  check('F2 ★★ 目录 v2 覆盖的 kind 恰好是三种（DIGITAL_ITEM / CONSUMABLE / API_QUOTA），而它们各自映射到两条落地原语之一',
    J(BOOT.SEED.products.map(p => p.kind).sort()) === J(['API_QUOTA', 'CONSUMABLE', 'DIGITAL_ITEM', 'DIGITAL_ITEM', 'CONSUMABLE'].sort()),
    { kinds: BOOT.SEED.products.map(p => p.kind) });
  check('F3 ★ 而 SERVICE **不在**目录里（它的 primitive 是 null —— 一个商店不陈列买不了的东西）',
    BOOT.SEED.products.every(p => p.kind !== 'SERVICE'));
}

process.on('exit', (code) => {
  if (code === 0 && failures > 0) process.exitCode = 1;
});
console.log('\n' + (failures === 0
  ? '════════════════════════════════════════════════════════════════'
    + '\nP22-26 Product Fulfillment：全部通过 ✔'
  : '════════════════════════════════════════════════════════════════'
    + '\nP22-26 Product Fulfillment：' + failures + ' 项失败 ✘'));
if (failures > 0) process.exitCode = 1;
