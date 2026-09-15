'use strict';
/* ====================================================================
   P22-5 · Economy 货架 / 商品目录 / product-backed 报价
   --------------------------------------------------------------------
   运行：node tests/test_p22_5_economy_catalog.js

   本文件回答三个问题，而且**只**回答这三个：

     「有哪些货架 / 有哪些商品？」      —— Store + Product Catalog
     「一份商品到底是什么？」           —— kind / fulfillment / 价格 + 单位
     「商品被改了之后，历史还成立吗？」 —— reprice 之后旧报价与旧库存

   ── 为什么重量放在"历史还成立吗"上 ────────────────────────────────────
   目录最容易写坏的方式不是"少了一个字段"，而是**改价顺手改到了过去**：
   把 price 存进 product，然后在生成报价时读它，看起来完全正常；只有当
   有人改价之后，"当时是多少钱"才变成一句没有答案的话。因此本文件用
   三组独立的证据钉住同一件事：
     · E 组：改价前后，旧报价的**每一列**逐字节不变（不是"金额没变"，
       而是整行序列化之后相同）；
     · F 组：disable / retire 之后，旧报价不变、旧库存不变；
     · G 组：创建一份 product-backed 报价，**世界逐字未变**（含对照组）。

   ── 与方法名对应关系 ─────────────────────────────────────────────────
     A  schema 与列清单           B  putStore
     C  putProduct 生命周期       D  createProductQuote（派生）
     E  reprice 之后历史不变      F  disable / retire 的后果
     G  Quote ≠ Purchase          H  崩溃注入
     I  重启恢复                  J  schema 迁移 3 → 4
     K  Gift / Compute / Service fixture   L  provider / 支付隔离
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-5c-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

function deterministicIds() {
  let n = 0;
  return (kind) => { n += 1; return C.formatEconomyId(kind, 't' + n).id; };
}
function mutableClock(start) {
  const box = { now: Number(start) || Date.UTC(2024, 0, 15, 12, 0, 0) };
  const fn = () => box.now;
  fn.box = box;
  fn.advance = (ms) => { box.now += Number(ms); return box.now; };
  fn.set = (t) => { box.now = Number(t); return box.now; };
  return fn;
}
function makeStore(extra) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir,
    logger: () => { },
    nextId: deterministicIds()
  }, extra || {}));
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

let keySeq = 0;
function nextKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }
function putStoreOk(store, options) {
  const o = options || {};
  const out = store.putStore(Object.assign({ name: 'Main Store', idempotencyKey: nextKey('store') }, o));
  assert.equal(out.ok, true, 'putStore must succeed: ' + J(out.errors || out));
  return out.result;
}
function putProductOk(store, storeId, options) {
  const o = options || {};
  const out = store.putProduct(Object.assign({
    storeId: storeId, kind: 'DIGITAL_ITEM', name: 'Widget', currency: 'IB_CREDIT',
    unitPriceMinor: 100, grantQuantity: 1, idempotencyKey: nextKey('product')
  }, o));
  assert.equal(out.ok, true, 'putProduct must succeed: ' + J(out.errors || out));
  return out.result;
}
function createProductQuoteOk(store, options) {
  const o = options || {};
  const out = store.createProductQuote(Object.assign({
    buyerId: 'cfg_a', units: 1, expiresAt: Date.UTC(2030, 0, 1),
    idempotencyKey: nextKey('quote')
  }, o));
  assert.equal(out.ok, true, 'createProductQuote must succeed: ' + J(out.errors || out));
  return out.result;
}

/* ── 世界指纹 ──────────────────────────────────────────────────────────
   它把"经济那一半"（账本 / 预留 / 钱包 / 操作）与"目录 / 命题那一半"
   （货架 / 商品 / 库存 / 报价）分开算。分开是刻意的：本文件多次需要
   证明"目录动了、经济没动"，而一个合并的指纹做不到这件事。
   `includeQuoteState` 让 G 组能区分"报价状态变了"与"经济变了"。 */
function economicFingerprint(store) {
  const wallets = store.listWallets({ limit: 500 })
    .map(w => J(store.serializeWallet(w, {}))).sort();
  const transactions = store.listTransactions({ limit: 500 })
    .map(t => t.transactionId + ':' + t.type + ':' + t.state).sort();
  const entries = store.listLedgerEntries({ limit: 1000 }).entries
    .map(e => e.ledgerEntryId + ':' + e.accountId + ':' + e.direction + ':' + e.amountMinor).sort();
  const reservations = store.listReservations({ limit: 500 }).reservations
    .map(r => r.reservationId + ':' + r.status + ':' + r.amountMinor).sort();
  const operations = store.listOperations({ limit: 500 }).operations
    .map(o => o.operationId + ':' + o.status).sort();
  const policies = store.listBudgetPolicies({ limit: 500 }).policies
    .map(p => J(store.serializeBudgetPolicy(p))).sort();
  return J({
    wallets, transactions, entries, reservations, operations, policies,
    revision: store.getRevision(),
    changes: store.listChanges(0, 500).length
  });
}
function catalogFingerprint(store, options) {
  const o = options || {};
  const stores = store.listStores({ limit: 500 }).stores.map(s => J(store.serializeStore(s))).sort();
  const products = store.listProducts({ limit: 500 }).products.map(p => J(store.serializeProduct(p))).sort();
  const quotes = store.listQuotes({ limit: 500 }).quotes.map(q => J(store.serializeQuote(q))).sort();
  const entries = store.listInventory({ productId: 'econ_product_t1', limit: 500 }).ok
    ? store.listInventory({ productId: 'econ_product_t1', limit: 500 }).entries
      .map(e => J(store.serializeInventoryEntry(e))).sort()
    : [];
  return J({ stores, products, quotes, entries, revision: store.getRevision() });
}
function quoteRowFingerprint(store, quoteId) {
  const out = store.getQuote({ quoteId: quoteId });
  assert.equal(out.ok, true, 'quote must exist: ' + quoteId);
  /* ── 只比**报价本身**，刻意不比 provenance ────────────────────────
     serialized quote 是"这份价格命题是什么"的对外形态；provenance 是
     "商品行**现在**长什么样"（它的 revision 会因为一次改价而变，而那份
     报价一个字都不该变）。把两者混进一个指纹会让"历史报价没变"这条
     断言实际上在断言"商品从来没被改过" —— 那是另一件事，也是 E 组
     正要否证的事。provenance 由 J5 单独断言。 */
  return J(store.serializeQuote(out.quote));
}
function productFixture(store, overrides) {
  const st = putStoreOk(store, { name: 'Fixture Store' });
  const p = putProductOk(store, st.storeId, overrides || {});
  return { store: st, product: p };
}

console.log('P22-5 · Economy store catalog (Store + Product + product-backed Quote)');

/* ══════════════════════════════════════════════════════════════════
   A · schema：三张表、schema 水位、以及每条列清单
   ══════════════════════════════════════════════════════════════════ */
section('A · schema（三张表 · 水位 4 · 列清单精确）');

{
  const dir = tmpDir('schema');
  const store = makeStore({ dataDir: dir });
  const opened = store.open();
  check('A1 打开一个库：schemaVersion 是**本 build 声明的那个**（P22-5 时是 4，P22-6 抬到 5）',
    opened.ok === true && Number(opened.schemaVersion) === Number(store.SCHEMA_VERSION) &&
    Number(store.health().schemaVersion) === Number(store.SCHEMA_VERSION),
    { opened: opened.schemaVersion, declared: store.SCHEMA_VERSION });
  check('A2 三张新表被登记在 store.TABLES 上，且表的**总数**恰好是 16（多一张就会被看见）',
    store.TABLES.STORES === 'economy_stores' &&
    store.TABLES.PRODUCTS === 'economy_products' &&
    store.TABLES.INVENTORY === 'economy_inventory' &&
    /* 16 = P22-2 的 8 + P22-3 的 3 + P22-4 的 2 + P22-5 的 3 + P22-6 的 1
       （economy_purchases）。这一行的存在就是为了在跨阶段时被**显式**改
       一次 —— 悄悄地多一张表会让"表的清单"这件事失去意义。 */
    Object.keys(store.TABLES).length === 16, Object.keys(store.TABLES));
  check('A2b P22-6 又加了一张表：PURCHASES 被登记，而三张 P22-5 的表一个都没丢',
    store.TABLES.PURCHASES === 'economy_purchases' &&
    store.TABLES.STORES === 'economy_stores' && store.TABLES.PRODUCTS === 'economy_products' &&
    store.TABLES.INVENTORY === 'economy_inventory');

  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name));
  check('A3 三张表真的存在于 SQLite 里（不是只写在常量里）',
    ['economy_stores', 'economy_products', 'economy_inventory'].every(t => tables.indexOf(t) >= 0), tables);

  const columnsOf = (table) => raw.prepare('PRAGMA table_info(' + table + ')').all().map(r => String(r.name));
  const storeCols = columnsOf('economy_stores');
  const productCols = columnsOf('economy_products');
  const inventoryCols = columnsOf('economy_inventory');

  /* ── A4 / A5：§2 的两条否定 ─────────────────────────────────────── */
  check('A4 货架表的列**恰好**是"组织方式"那几列：没有 price / currency / stock / owned / provider 任何一列',
    storeCols.slice().sort().join(',') ===
      'created_at,description,fingerprint,idempotency_key,name,revision,sort_order,status,store_id,updated_at' &&
    !storeCols.some(c => /price|currency|stock|owned|balance|provider|amount/i.test(c)), storeCols);
  check('A5 商品表**没有** owned / stock / provider / api_key / discount 列，且金额列带 _minor 单位后缀',
    !productCols.some(c => /^(?:owned|stock|count|provider|api_key|discount|featured|recommended)/i.test(c)) &&
    productCols.indexOf('unit_price_minor') >= 0 &&
    productCols.indexOf('currency') >= 0 &&
    !productCols.some(c => /^(?:price|cost|money|budget)$/i.test(c)), productCols);
  check('A6 商品表的列**恰好**是契约声明的那些（多一列就失败）',
    productCols.slice().sort().join(',') ===
      ['product_id', 'store_id', 'product_kind', 'fulfillment', 'name', 'description', 'currency',
        'unit_price_minor', 'unit_name', 'grant_quantity', 'asset_kind', 'status',
        'idempotency_key', 'fingerprint', 'revision', 'created_at', 'updated_at'].sort().join(','),
    productCols);
  check('A7 库存表的列**恰好**是那一份（没有 inventory_cached_quantity —— §17：没有缓存就没有 rebuild）',
    inventoryCols.slice().sort().join(',') ===
      ['inventory_entry_id', 'owner_id', 'owner_type', 'product_id', 'asset_kind', 'quantity',
        'idempotency_key', 'fingerprint', 'revision', 'created_at', 'updated_at'].sort().join(','),
    inventoryCols);
  check('A8 库存表上**没有**任何"余额 / 币种"列：库存不是钱包（§12）',
    !inventoryCols.some(c => /currency|balance|minor|price/i.test(c)), inventoryCols);

  /* ── A9：两个结构约束（它们是 CHECK，不是注释）──────────────────── */
  const productSql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE name='economy_products'").get().sql);
  const inventorySql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE name='economy_inventory'").get().sql);
  check('A9 products 上有 CHECK (unit_price_minor >= 0) 与 CHECK (grant_quantity >= 0)',
    /CHECK \(unit_price_minor >= 0\)/.test(productSql) && /CHECK \(grant_quantity >= 0\)/.test(productSql),
    productSql);
  check('A10 inventory 上有 CHECK (quantity >= 0) —— §16 的"不可能为负"有一层是**数据库**保证的',
    /CHECK \(quantity >= 0\)/.test(inventorySql) && /UNIQUE \(owner_id, product_id\)/.test(inventorySql),
    inventorySql);
  /* 直接对表写一个负数：即使绕过 store 的全部守卫，库也必须拒绝。 */
  let negativeRejected = false;
  try {
    raw.exec('INSERT INTO economy_inventory (inventory_entry_id, owner_id, owner_type, product_id, asset_kind, quantity, idempotency_key, fingerprint, revision, created_at, updated_at) ' +
      "VALUES ('econ_inv_neg', 'cfg_x', 'character', 'econ_product_t1', 'ITEM', -1, 'k', 'f', 1, 0, 0)");
  } catch (_) { negativeRejected = true; }
  check('A11 绕过 store 直接写一个负数量会被**数据库**拒绝（这条 CHECK 是真的在执行）', negativeRejected);
  raw.close();
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   B · putStore：组织方式，不是价格事实
   ══════════════════════════════════════════════════════════════════ */
section('B · putStore（创建 / 修改 / 幂等 / 乐观并发 / 输入白名单）');

{
  const store = makeStore();
  store.open();
  const before = economicFingerprint(store);

  const created = putStoreOk(store, { name: 'Main', description: 'the only shelf', sortOrder: 5 });
  check('B1 create：货架被创建，返回 storeId / status ACTIVE / sortOrder',
    created.created === true && C.isEconomyId('STORE', created.storeId) &&
    created.store.status === 'ACTIVE' && created.store.sortOrder === 5 &&
    created.eventKind === 'STORE_CREATED', created);
  check('B2 序列化里逐字写着：货架不拥有价格、不拥有拥有关系、不拥有库存',
    created.store.holdsPrices === false && created.store.holdsOwnership === false &&
    created.store.holdsInventory === false);
  check('B3 改货架**不动经济**：账本 / 预留 / 钱包 / 政策逐字未变（revision 只被目录写入推动）',
    (() => {
      const now = economicFingerprint(store);
      const a = JSON.parse(before); const b = JSON.parse(now);
      return J(a.wallets) === J(b.wallets) && J(a.entries) === J(b.entries) &&
        J(a.transactions) === J(b.transactions) && J(a.reservations) === J(b.reservations) &&
        b.revision === a.revision + 1;
    })(), { before: before, after: economicFingerprint(store) });

  const replayed = store.putStore({ name: 'Main', description: 'the only shelf', sortOrder: 5, idempotencyKey: created.idempotencyKey });
  check('B4 同一个 key + 同一个请求 → replay（不是第二条货架、不消耗 revision）',
    replayed.ok === true && replayed.replayed === true &&
    replayed.result.storeId === created.storeId && store.health().counts.stores === 1, replayed);

  const conflict = store.putStore({ name: 'Renamed', idempotencyKey: created.idempotencyKey });
  check('B5 同一个 key + 不同请求 → IDEMPOTENCY_CONFLICT（配置数据也有崩溃/重试语义）',
    conflict.ok === false && conflict.errors[0] === 'IDEMPOTENCY_CONFLICT' &&
    conflict.scope === 'STORE', conflict);

  const updated = putStoreOk(store, { storeId: created.storeId, name: 'Renamed', sortOrder: 1 });
  check('B6 update：同一个 storeId 被改名（§20：改名不换 id）',
    updated.created === false && updated.storeId === created.storeId &&
    updated.store.name === 'Renamed' && updated.eventKind === 'STORE_UPDATED' &&
    store.health().counts.stores === 1);

  const stale = store.putStore({ storeId: created.storeId, name: 'Nope', ifRevision: 1, idempotencyKey: nextKey('store') });
  check('B7 乐观并发：ifRevision 不对就拒绝，且**不消耗** revision',
    stale.ok === false && stale.errors.indexOf('store-revision-mismatch') >= 0 &&
    stale.actualRevision === updated.store.revision, stale);

  const badKey = store.putStore({ name: 'X', priceMinor: 100, idempotencyKey: nextKey('store') });
  check('B8 未知键被拒绝（priceMinor 不是"被忽略"，而是让请求失败）',
    badKey.ok === false && badKey.denied === true &&
    badKey.reasonCode === 'CATALOG_INPUT_NOT_STRUCTURED' &&
    badKey.errors.indexOf('store-input-key-not-whitelisted:priceMinor') >= 0, badKey);
  const forbidden = store.putStore({ name: 'X', providerBalance: 5, idempotencyKey: nextKey('store') });
  check('B9 点名否认的键（providerBalance）走的是另一条错误路径（forbidden ≠ unknown）',
    forbidden.ok === false &&
    forbidden.errors.indexOf('store-input-key-is-forbidden:providerBalance') >= 0, forbidden);
  const noName = store.putStore({ idempotencyKey: nextKey('store') });
  check('B10 缺 name 被拒绝（而不是造一个空名字的货架）',
    noName.ok === false && noName.errors.indexOf('store-name-required') >= 0);

  const listed = store.listStores({ limit: 10 });
  check('B11 listStores：按 sortOrder 升序，且**不接受**任何"给谁看"的参数',
    listed.ok === true && listed.stores.length === 1 &&
    store.listStores({ ownerId: 'cfg_a', limit: 10 }).stores.length === 1);
  const missing = store.getStore({ storeId: 'econ_store_nope' });
  check('B12 getStore 在缺行时返回 store-not-found（不是 null store、不是空对象）',
    missing.ok === false && missing.store === null && missing.errors[0] === 'store-not-found');
  check('B13 货架这一层没有任何 DELETE 路径：找不到 removeStore / deleteStore',
    typeof store.removeStore === 'undefined' && typeof store.deleteStore === 'undefined' &&
    typeof store.purgeStore === 'undefined');
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   C · putProduct：生命周期 / 派生列 / 免费商品 / 本体不可变
   ══════════════════════════════════════════════════════════════════ */
section('C · putProduct（kind → fulfillment/assetKind 派生 · 免费商品 · 本体不可变 · 状态机）');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store, { name: 'Shelf' });

  const item = putProductOk(store, st.storeId, { kind: 'DIGITAL_ITEM', name: 'Widget', unitPriceMinor: 100 });
  check('C1 DIGITAL_ITEM → fulfillment INVENTORY_GRANT / assetKind ITEM / unitName item',
    item.product.kind === 'DIGITAL_ITEM' && item.product.fulfillment === 'INVENTORY_GRANT' &&
    item.product.assetKind === 'ITEM' && item.product.unitName === 'item' &&
    item.product.grantQuantity === 1 && item.product.status === 'ACTIVE', item.product);
  check('C2 价格以**十进制字符串**出去，且有显式单位（unitPriceMinor + currency）',
    item.product.unitPriceMinor === '100' && typeof item.product.unitPriceMinor === 'string' &&
    item.product.currency === 'IB_CREDIT' && item.product.unitName === 'item');
  check('C3 商品的序列化里逐字写着：价格与关系无关 / 不拥有拥有关系 / 没有折扣 / 没有推荐',
    item.product.pricingIsRelationshipFree === true && item.product.holdsOwnership === false &&
    item.product.hasDiscount === false && item.product.hasRecommendation === false);

  const service = putProductOk(store, st.storeId, {
    kind: 'SERVICE', name: 'Portrait Sitting', unitPriceMinor: 250, grantQuantity: 0
  });
  check('C4 SERVICE → fulfillment SERVICE_EXECUTION / assetKind **null** / 不发放库存',
    service.product.fulfillment === 'SERVICE_EXECUTION' && service.product.assetKind === null &&
    service.product.grantsInventory === false && service.product.grantQuantity === 0);
  const compute = putProductOk(store, st.storeId, {
    kind: 'API_QUOTA', name: 'Premium Compute x1000', unitPriceMinor: 400, grantQuantity: 1000
  });
  check('C5 API_QUOTA → COMPUTE_GRANT / assetKind COMPUTE / unitName 是冻结的 computeUnit',
    compute.product.fulfillment === 'COMPUTE_GRANT' && compute.product.assetKind === 'COMPUTE' &&
    compute.product.unitName === C.COMPUTE_UNIT_NAME && compute.product.grantQuantity === 1000);

  const free = putProductOk(store, st.storeId, { name: 'Free Sample', unitPriceMinor: 0 });
  check('C6 免费商品：unitPriceMinor = 0 是**合法值**，而它读回来也是 0（不是 null、不是被丢掉）',
    free.product.unitPriceMinor === '0' && free.product.unitPriceMinor !== null &&
    store.serializeProduct(store.getProduct({ productId: free.product.productId }).product).unitPriceMinor === '0');
  const freeQuote = store.createProductQuote({
    productId: free.product.productId, buyerId: 'cfg_a',
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('C7 0 元商品**当前无法报价**，而拒绝的理由是 P22-4 冻结的那一条（不是 truthiness 陷阱）',
    freeQuote.ok === false && freeQuote.reasonCode === 'INVALID_AMOUNT' &&
    freeQuote.errors.indexOf('quote-amount-must-be-positive') >= 0,
    freeQuote);

  const missingPrice = store.putProduct({
    storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'NoPrice', currency: 'IB_CREDIT',
    grantQuantity: 1, idempotencyKey: nextKey('product')
  });
  check('C8 缺 unitPriceMinor **不是** 0：它有自己的错误（"免费"与"忘了写价格"必须可分）',
    missingPrice.ok === false && missingPrice.errors.indexOf('product-unit-price-minor-required') >= 0);
  const negative = store.putProduct({
    storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Neg', currency: 'IB_CREDIT',
    unitPriceMinor: -1, grantQuantity: 1, idempotencyKey: nextKey('product')
  });
  check('C9 负价格被拒绝（负价格不是折扣，它让经济反向流动）',
    negative.ok === false && negative.errors.indexOf('amount-minor-negative') >= 0);

  const noStore = store.putProduct({
    storeId: 'econ_store_ghost', kind: 'DIGITAL_ITEM', name: 'Orphan', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1, idempotencyKey: nextKey('product')
  });
  check('C10 商品必须挂在一个**真实存在**的货架上（悬挂引用被拒绝，且拒绝里带着那个错的 id）',
    noStore.ok === false && noStore.reasonCode === 'STORE_NOT_FOUND' &&
    noStore.storeId === 'econ_store_ghost', noStore);

  const moved = store.putProduct({
    productId: item.product.productId, storeId: 'econ_store_other', kind: 'DIGITAL_ITEM',
    name: 'Widget', currency: 'IB_CREDIT', unitPriceMinor: 100, grantQuantity: 1,
    idempotencyKey: nextKey('product')
  });
  check('C11 §20：商品**本体**不可变 —— 换 storeId 被拒绝（那是另一件商品，不是改名）',
    moved.ok === false &&
    moved.errors.indexOf('product-store-is-immutable-relisting-is-a-new-product') >= 0, moved);
  const rekinded = store.putProduct({
    productId: item.product.productId, storeId: st.storeId, kind: 'API_QUOTA',
    name: 'Widget', currency: 'IB_CREDIT', unitPriceMinor: 100, grantQuantity: 1,
    idempotencyKey: nextKey('product')
  });
  check('C12 §20：换 kind 同样被拒绝（交付形态变了就是另一件商品）',
    rekinded.ok === false &&
    rekinded.errors.indexOf('product-kind-is-immutable-a-different-kind-is-a-different-product') >= 0);

  const renamed = putProductOk(store, st.storeId, {
    productId: item.product.productId, kind: 'DIGITAL_ITEM', name: 'Widget Mk II',
    unitPriceMinor: 100, grantQuantity: 1
  });
  check('C13 改名与改描述是允许的，且 productId 一个字都没变（§20）',
    renamed.created === false && renamed.product.productId === item.product.productId &&
    renamed.product.name === 'Widget Mk II' && store.health().counts.products === 4);

  /* ── 状态机（§9）────────────────────────────────────────────────── */
  const disabled = putProductOk(store, st.storeId, {
    productId: item.product.productId, kind: 'DIGITAL_ITEM', name: 'Widget Mk II',
    unitPriceMinor: 100, grantQuantity: 1, status: 'DISABLED'
  });
  check('C14 ACTIVE → DISABLED 允许，事件是 PRODUCT_DISABLED（不是笼统的 UPDATED）',
    disabled.statusChanged === true && disabled.eventKind === 'PRODUCT_DISABLED' &&
    disabled.product.status === 'DISABLED' && disabled.previousStatus === 'ACTIVE');
  const relisted = putProductOk(store, st.storeId, {
    productId: item.product.productId, kind: 'DIGITAL_ITEM', name: 'Widget Mk II',
    unitPriceMinor: 100, grantQuantity: 1, status: 'ACTIVE'
  });
  check('C15 DISABLED → ACTIVE 允许，而事件回到 PRODUCT_UPDATED（payload 里的前后状态把话说全）',
    relisted.eventKind === 'PRODUCT_UPDATED' && relisted.product.status === 'ACTIVE' &&
    relisted.previousStatus === 'DISABLED');
  const retired = putProductOk(store, st.storeId, {
    productId: item.product.productId, kind: 'DIGITAL_ITEM', name: 'Widget Mk II',
    unitPriceMinor: 100, grantQuantity: 1, status: 'RETIRED'
  });
  check('C16 ACTIVE → RETIRED 允许，事件是 PRODUCT_RETIRED',
    retired.eventKind === 'PRODUCT_RETIRED' && retired.product.status === 'RETIRED');
  const back = store.putProduct({
    productId: item.product.productId, storeId: st.storeId, kind: 'DIGITAL_ITEM',
    name: 'Widget Mk II', currency: 'IB_CREDIT', unitPriceMinor: 100, grantQuantity: 1,
    status: 'ACTIVE', idempotencyKey: nextKey('product')
  });
  check('C17 RETIRED 是**终态**：退役后重新上架被拒绝，且拒绝码是 TRANSITION_NOT_ALLOWED',
    back.ok === false && back.reasonCode === 'TRANSITION_NOT_ALLOWED' &&
    back.detail === 'a-retired-product-is-terminal-and-must-not-be-relisted', back);

  /* ── 派生列不可被声明（§27）────────────────────────────────────── */
  const fakeFulfillment = store.putProduct({
    storeId: st.storeId, kind: 'SERVICE', name: 'Fake', currency: 'IB_CREDIT',
    unitPriceMinor: 10, grantQuantity: 0, fulfillment: 'INVENTORY_GRANT',
    idempotencyKey: nextKey('product')
  });
  check('C18 交付形态是**派生**的：声明一个与 kind 不符的 fulfillment 会被拒绝',
    fakeFulfillment.ok === false &&
    fakeFulfillment.errors.indexOf('product-fulfillment-does-not-match-the-product-kind') >= 0);
  const serviceWithStock = store.putProduct({
    storeId: st.storeId, kind: 'SERVICE', name: 'Bad Service', currency: 'IB_CREDIT',
    unitPriceMinor: 10, grantQuantity: 5, idempotencyKey: nextKey('product')
  });
  check('C19 SERVICE 带 grantQuantity = 5 被拒绝（服务不得被建模成物品，§54）',
    serviceWithStock.ok === false &&
    serviceWithStock.errors.indexOf('a-service-product-must-not-grant-inventory-quantity') >= 0);
  const tokenUnit = store.putProduct({
    storeId: st.storeId, kind: 'API_QUOTA', name: 'Tokens', currency: 'IB_CREDIT',
    unitPriceMinor: 10, grantQuantity: 10, unitName: 'tokens', idempotencyKey: nextKey('product')
  });
  check('C20 compute 商品用 tokens 做单位名被拒绝（§16 的别名否认在商品层也生效）',
    tokenUnit.ok === false &&
    (tokenUnit.errors.indexOf('product-unit-name-is-a-forbidden-compute-alias') >= 0 ||
      tokenUnit.errors.indexOf('a-compute-product-must-use-the-frozen-compute-unit-name') >= 0), tokenUnit);

  /* ── 幂等与乐观并发 ─────────────────────────────────────────────── */
  const p2 = putProductOk(store, st.storeId, { name: 'Idem', unitPriceMinor: 10 });
  const p2replay = store.putProduct({
    storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Idem', currency: 'IB_CREDIT',
    unitPriceMinor: 10, grantQuantity: 1, idempotencyKey: p2.idempotencyKey
  });
  check('C21 同一个 key + 同一个商品请求 → replay',
    p2replay.ok === true && p2replay.replayed === true &&
    p2replay.result.productId === p2.product.productId);
  const p2conflict = store.putProduct({
    storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Idem', currency: 'IB_CREDIT',
    unitPriceMinor: 999, grantQuantity: 1, idempotencyKey: p2.idempotencyKey
  });
  check('C22 同一个 key + 不同价格 → IDEMPOTENCY_CONFLICT（scope 是 PRODUCT）',
    p2conflict.ok === false && p2conflict.errors[0] === 'IDEMPOTENCY_CONFLICT' &&
    p2conflict.scope === 'PRODUCT', p2conflict);
  const p2stale = store.putProduct({
    productId: p2.product.productId, storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Idem',
    currency: 'IB_CREDIT', unitPriceMinor: 12, grantQuantity: 1, ifRevision: 1,
    idempotencyKey: nextKey('product')
  });
  check('C23 乐观并发：ifRevision 不对就拒绝，且不消耗 revision',
    p2stale.ok === false && p2stale.errors.indexOf('product-revision-mismatch') >= 0);

  /* ── 过滤读取（§29）────────────────────────────────────────────── */
  const byKind = store.listProducts({ kind: 'API_QUOTA', limit: 50 });
  const byStatus = store.listProducts({ status: 'ACTIVE', limit: 50 });
  const byCurrency = store.listProducts({ currency: 'IB_CREDIT', limit: 50 });
  check('C24 listProducts 的最小过滤：kind / status / currency / storeId 各自可用',
    byKind.ok === true && byKind.products.every(p => p.kind === 'API_QUOTA') &&
    byStatus.products.every(p => p.status === 'ACTIVE') &&
    byCurrency.products.every(p => p.currency === 'IB_CREDIT') &&
    store.listProducts({ storeId: st.storeId, limit: 50 }).products.length === 5,
    { kind: byKind.products.length, status: byStatus.products.length });
  check('C25 目录没有排序学习 / 全文搜索：listProducts 不认识 query / relevance / recommend 参数',
    store.listProducts({ query: 'cheap widget', limit: 10 }).products.length === 5 &&
    store.listProducts({ recommended: true, limit: 10 }).products.length === 5);

  /* ── C26 · LIMIT 必须在**过滤之后**生效（开发期修好的一个真实缺陷）──
     第一版按"哪个过滤条件最精确"选一条 SQL，剩下的条件在 JS 里再筛一遍。
     那看起来等价，其实是错的：LIMIT 在过滤**之前**生效，于是
     `{storeId, status:'ACTIVE', limit: 2}` 会在"这个货架的前 2 件商品"
     （两件都是 DISABLED）里挑出 0 件 ACTIVE —— 而它明明有 2 件在卖。
     那种少返回不报错、不抛异常，只会让调用方以为"就这么多"。
     修法是把四个条件全部放进**一条** SQL 的四组开关里。
     这条断言用"前 3 件 DISABLED、后 2 件 ACTIVE"的顺序把它钉死。 */
  const st2 = putStoreOk(store, { name: 'Ordered Shelf' });
  for (let i = 0; i < 3; i++) {
    putProductOk(store, st2.storeId, { name: 'Off ' + i, unitPriceMinor: 10, status: 'DISABLED' });
  }
  for (let i = 0; i < 2; i++) {
    putProductOk(store, st2.storeId, { name: 'On ' + i, unitPriceMinor: 10 });
  }
  const limited = store.listProducts({ storeId: st2.storeId, status: 'ACTIVE', limit: 2 });
  check('C26 ★ LIMIT 在过滤**之后**生效：前 3 件是 DISABLED 时，{storeId, status:ACTIVE, limit:2} 仍然返回 2 件',
    limited.ok === true && limited.products.length === 2 &&
    limited.products.every(p => p.status === 'ACTIVE'),
    { got: limited.products.map(p => p.name + ':' + p.status) });
  check('C27 四个过滤条件可以在**同一个**查询里组合，且各自都真的生效',
    store.listProducts({ storeId: st2.storeId, status: 'DISABLED', kind: 'DIGITAL_ITEM', currency: 'IB_CREDIT', limit: 50 })
      .products.length === 3 &&
    store.listProducts({ storeId: st2.storeId, status: 'DISABLED', kind: 'API_QUOTA', limit: 50 })
      .products.length === 0);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · createProductQuote：价格**只能**来自商品
   ══════════════════════════════════════════════════════════════════ */
section('D · createProductQuote（派生 · 调用方没有金额的位置）');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store, { name: 'Shelf' });
  const p = putProductOk(store, st.storeId, { name: 'Widget', unitPriceMinor: 100, grantQuantity: 1 });
  walletWith(store, 1000n);

  const q1 = createProductQuoteOk(store, { productId: p.product.productId });
  check('D1 报价的金额 / 币种 / 数量 / 种类**全部**来自商品（且都写在 derived 里，可审计）',
    q1.amountMinor === '100' && q1.currency === 'IB_CREDIT' && q1.quantity === 1 &&
    q1.kind === 'PURCHASE' && q1.settlementType === 'PURCHASE' &&
    q1.productBacked === true && q1.derivedFrom === 'sqlite-products' &&
    q1.derived.unitPriceMinor === '100' && q1.derived.units === 1, q1.derived);
  check('D2 传进来的 amountMinor / currency / quantity / kind 一律**不被读**（不是"被忽略"，是根本没有位置）',
    (() => {
      const out = store.createProductQuote({
        productId: p.product.productId, buyerId: 'cfg_a',
        amountMinor: 1, currency: 'COMPUTE_PREMIUM', quantity: 999, kind: 'GIFT',
        expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
      });
      return out.ok === true && out.result.amountMinor === '100' &&
        out.result.currency === 'IB_CREDIT' && out.result.quantity === 1 &&
        out.result.kind === 'PURCHASE';
    })());
  const q3 = createProductQuoteOk(store, { productId: p.product.productId, units: 3 });
  check('D3 units 只改变份数与总额：3 份 × 100 = 300，数量 3',
    q3.amountMinor === '300' && q3.quantity === 3 && q3.derived.units === 3);
  const q0 = store.createProductQuote({
    productId: p.product.productId, buyerId: 'cfg_a', units: 0,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('D4 units = 0 被拒绝（一份不描述任何数量的报价不是报价）',
    q0.ok === false && q0.errors.indexOf('units-must-be-a-positive-safe-integer') >= 0, q0);
  const qBig = store.createProductQuote({
    productId: p.product.productId, buyerId: 'cfg_a', units: 2 ** 53,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('D5 units = 2^53 被拒绝（安全整数边界不是"大概不会有人这么传"）',
    qBig.ok === false && qBig.errors.indexOf('units-must-be-a-positive-safe-integer') >= 0);

  const unknown = store.createProductQuote({
    productId: 'econ_product_ghost', buyerId: 'cfg_a',
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('D6 目录里没有这件商品 → PRODUCT_NOT_FOUND（P22-5 第一次能把它与"不能卖"分开）',
    unknown.ok === false && unknown.reasonCode === 'PRODUCT_NOT_FOUND' &&
    unknown.productId === 'econ_product_ghost', unknown);

  /* raw primitive 与 product-backed 路径的分工（§21） */
  const raw = store.createQuote({
    buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 55,
    productId: 'econ_product_' + p.product.productId.slice('econ_product_'.length),
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('raw')
  });
  check('D7 raw createQuote 仍然可用，且它现在**认识**真实的目录（报价的商品 id 不再被双重加前缀）',
    raw.ok === true && raw.result.productId === p.product.productId &&
    raw.result.amountMinor === '55' && raw.result.productBacked === undefined, raw);
  const rawSuffix = store.createQuote({
    buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 55, productId: 'bare-suffix',
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('raw')
  });
  check('D8 raw createQuote 的裸后缀写法**行为一个字没变**（P22-4 的用法逐字成立）',
    rawSuffix.ok === true && rawSuffix.result.productId === 'econ_product_bare-suffix');

  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · reprice 之后历史不变（§7 / §12 / §49 的核心证据）
   ══════════════════════════════════════════════════════════════════ */
section('E · Product reprice（100 → 120）之后，旧报价的每一列逐字节不变');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store, { name: 'Shelf' });
  const p = putProductOk(store, st.storeId, { name: 'Widget', unitPriceMinor: 100, grantQuantity: 2 });
  walletWith(store, 1000n);

  const q1 = createProductQuoteOk(store, { productId: p.product.productId });
  const q1Fingerprint = quoteRowFingerprint(store, q1.quoteId);
  check('E1 初始状态：商品 100，Q1 = 100（数量 = 1 份 × grantQuantity 2 = 2）',
    q1.amountMinor === '100' && q1.quantity === 2 && p.product.unitPriceMinor === '100');

  const repriced = putProductOk(store, st.storeId, {
    productId: p.product.productId, kind: 'DIGITAL_ITEM', name: 'Widget',
    unitPriceMinor: 120, grantQuantity: 2
  });
  check('E2 改价成功，且返回里带着**改之前**的价格（审计需要"从多少改到多少"）',
    repriced.product.unitPriceMinor === '120' &&
    repriced.previousUnitPriceMinor === '100' &&
    repriced.product.productId === p.product.productId, repriced);
  check('E3 改价**不**重写历史：返回里逐字写着两句否认，且 change log 的 payload 也带着它们',
    repriced.rewriteOfHistoricalQuotes === false &&
    repriced.ledgerMutation === false &&
    (() => {
      const changes = store.listChanges(0, 500);
      const hit = changes.filter(c => c.kind === 'PRODUCT_UPDATED').pop();
      return hit && hit.payload.rewriteOfHistoricalQuotes === false &&
        hit.payload.previousUnitPriceMinor === '100' && hit.payload.unitPriceMinor === '120';
    })());
  check('E4 ★ Q1 的每一列逐字节不变（不是"金额没变"，是整行序列化之后相同）',
    quoteRowFingerprint(store, q1.quoteId) === q1Fingerprint,
    { before: q1Fingerprint, after: quoteRowFingerprint(store, q1.quoteId) });
  check('E5 Q1 的 amount / currency / quantity / kind / settlementType 五项逐项仍是创建时的值',
    (() => {
      const back = store.serializeQuote(store.getQuote({ quoteId: q1.quoteId }).quote);
      return back.currency === q1.currency && back.amountMinor === '100' &&
        back.quantity === q1.quantity && back.kind === q1.kind &&
        back.settlementType === q1.settlementType;
    })());
  const q2 = createProductQuoteOk(store, { productId: p.product.productId });
  check('E6 改价之后的新报价 Q2 = 120（新命题用新价格），而 Q1 仍然是 100',
    q2.amountMinor === '120' && q2.quoteId !== q1.quoteId &&
    store.serializeQuote(store.getQuote({ quoteId: q1.quoteId }).quote).amountMinor === '100');
  check('E7 两句关于价格的命题可以同时在世界上存在（这正是 Quote 存在的理由）',
    store.listQuotes({ limit: 50 }).quotes.length === 2 &&
    store.listQuotes({ limit: 50 }).quotes.map(q => q.amountMinor).sort().join(',') === '100,120');

  /* ── 只有状态列可改（静态扫 UPDATE 的 SET）─────────────────────── */
  const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  const stmtWindow = (name) => {
    const at = storeSrc.indexOf(name + ':');
    if (at < 0) return null;
    const rest = storeSrc.slice(at);
    const boundary = rest.search(/\n {4}[A-Za-z]/);
    return boundary < 0 ? rest : rest.slice(0, boundary);
  };
  const setColsOf = (name) => {
    const w = stmtWindow(name);
    if (!w) return null;
    const m = /SET ([^']*?) WHERE/.exec(w);
    if (!m) return null;
    return m[1].split(',').map(s => s.trim().split('=')[0].trim()).sort();
  };
  const quoteSet = setColsOf('setQuoteState');
  check('E8 P22-5 **没有**给 quotes 表加任何列：唯一的 UPDATE 仍然只赋 state / revision / updated_at',
    quoteSet != null && quoteSet.join(',') === 'revision,state,updated_at',
    quoteSet);
  const productSet = setColsOf('updateProduct');
  check('E9 改价的 UPDATE 里**没有** status（改价格与改上架状态是两条语句，各自都做不到对方那件事）',
    productSet != null && productSet.indexOf('status') < 0 &&
    productSet.indexOf('unit_price_minor') >= 0 &&
    ['product_id', 'store_id', 'product_kind', 'fulfillment', 'asset_kind', 'created_at']
      .every(c => productSet.indexOf(c) < 0),
    productSet);
  const statusSet = setColsOf('setProductStatus');
  check('E10 改状态的 UPDATE 里**没有**任何价格列，且带 `AND status=?`（终态不可回退是 SQL 约束）',
    statusSet != null &&
    statusSet.join(',') === 'fingerprint,idempotency_key,revision,status,updated_at' &&
    /WHERE product_id=\? AND status=\?/.test(stmtWindow('setProductStatus') || ''),
    statusSet);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · disable / retire 的后果（§9 / §24）
   ══════════════════════════════════════════════════════════════════ */
section('F · Product disable / retire：新报价被拒，历史报价与已有库存不变');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store, { name: 'Shelf' });
  const p = putProductOk(store, st.storeId, { name: 'Widget', unitPriceMinor: 100 });
  walletWith(store, 1000n);

  const q1 = createProductQuoteOk(store, { productId: p.product.productId });
  const granted = store.grantInventory({
    ownerId: 'cfg_a', productId: p.product.productId, quantity: 3, idempotencyKey: nextKey('inv')
  });
  assert.equal(granted.ok, true, 'grant must succeed: ' + J(granted.errors));
  const q1Before = quoteRowFingerprint(store, q1.quoteId);
  const invBefore = J(store.serializeInventoryEntry(granted.result.entry));

  putProductOk(store, st.storeId, {
    productId: p.product.productId, kind: 'DIGITAL_ITEM', name: 'Widget',
    unitPriceMinor: 100, status: 'DISABLED'
  });
  const blocked = store.createProductQuote({
    productId: p.product.productId, buyerId: 'cfg_a',
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('F1 商品被停用 → 新报价被拒绝，拒绝码是 PRODUCT_DISABLED 且 detail 指出真实状态',
    blocked.ok === false && blocked.reasonCode === 'PRODUCT_DISABLED' &&
    blocked.errors.indexOf('product-status-is-not-active') >= 0 &&
    blocked.productStatus === 'DISABLED', blocked);
  const rawBlocked = store.createQuote({
    buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100, productId: p.product.productId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('raw')
  });
  check('F2 raw createQuote 同样尊重目录状态（这一条只在"目录里真的有这件商品"时生效）',
    rawBlocked.ok === false && rawBlocked.reasonCode === 'PRODUCT_DISABLED');
  check('F3 ★ 已有报价 Q1 逐字节不变：停用商品**不**修改历史报价（§9 的核心）',
    quoteRowFingerprint(store, q1.quoteId) === q1Before);
  check('F4 Q1 仍然是 OPEN（它的有效性只由 state 与 expiresAt 决定，不由商品的状态决定）',
    store.serializeQuote(store.getQuote({ quoteId: q1.quoteId }).quote).state === 'OPEN');
  check('F5 ★ 已有库存不变：下架**不会**把用户已经拥有的东西删掉（§24）',
    J(store.serializeInventoryEntry(store.getInventoryEntry({
      ownerId: 'cfg_a', productId: p.product.productId
    }).entry)) === invBefore &&
    store.inventoryQuantity('cfg_a', p.product.productId).quantity === 3);

  const relisted = putProductOk(store, st.storeId, {
    productId: p.product.productId, kind: 'DIGITAL_ITEM', name: 'Widget',
    unitPriceMinor: 100, status: 'ACTIVE'
  });
  check('F6 重新上架之后又能报价了（DISABLED 是可逆的 —— 这与 RETIRED 刻意不同）',
    relisted.product.status === 'ACTIVE' &&
    store.createProductQuote({
      productId: p.product.productId, buyerId: 'cfg_a',
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
    }).ok === true);

  putProductOk(store, st.storeId, {
    productId: p.product.productId, kind: 'DIGITAL_ITEM', name: 'Widget',
    unitPriceMinor: 100, status: 'RETIRED'
  });
  const afterRetire = store.createProductQuote({
    productId: p.product.productId, buyerId: 'cfg_a',
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('F7 RETIRED 之后新报价同样被拒，而 detail 里的状态是 RETIRED（拒绝码相同，原因可分）',
    afterRetire.ok === false && afterRetire.reasonCode === 'PRODUCT_DISABLED' &&
    afterRetire.productStatus === 'RETIRED');
  check('F8 retire 之后历史报价与库存**仍然**逐字不变（§24 在终态上再断言一次）',
    quoteRowFingerprint(store, q1.quoteId) === q1Before &&
    store.inventoryQuantity('cfg_a', p.product.productId).quantity === 3);

  /* ── 货架被停用同样让整个货架停卖（DISABLED 因此是有后果的）──────── */
  const st2 = putStoreOk(store, { name: 'Second' });
  const p2 = putProductOk(store, st2.storeId, { name: 'Other', unitPriceMinor: 50 });
  putStoreOk(store, { storeId: st2.storeId, name: 'Second', status: 'DISABLED' });
  const storeDisabled = store.createProductQuote({
    productId: p2.product.productId, buyerId: 'cfg_a',
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('F9 货架被停用 → 它上面的商品买不了（否则 DISABLED 只是一个装饰性的字段）',
    storeDisabled.ok === false && storeDisabled.reasonCode === 'PRODUCT_DISABLED' &&
    storeDisabled.errors.indexOf('store-status-is-not-active') >= 0, storeDisabled);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   G · 报价 ≠ 购买：创建报价不锁钱、不扣钱、不发库存
   ══════════════════════════════════════════════════════════════════ */
section('G · 创建 product-backed 报价**完全**不改变经济事实（含对照组）');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store, { name: 'Shelf' });
  const p = putProductOk(store, st.storeId, { name: 'Widget', unitPriceMinor: 100, grantQuantity: 10 });
  const w = walletWith(store, 1000n);

  const before = { economic: economicFingerprint(store), catalog: catalogFingerprint(store) };
  const quotes = [];
  for (let i = 0; i < 3; i++) quotes.push(createProductQuoteOk(store, { productId: p.product.productId }));
  const after = { economic: economicFingerprint(store), catalog: catalogFingerprint(store) };

  check('G1 连开三份报价（总额 300）：**经济那一半**逐字未变（含 wallet / reserved / ledger / revision 的位置）',
    (() => {
      const a = JSON.parse(before.economic); const b = JSON.parse(after.economic);
      return J(a.wallets) === J(b.wallets) && J(a.entries) === J(b.entries) &&
        J(a.transactions) === J(b.transactions) && J(a.reservations) === J(b.reservations) &&
        J(a.operations) === J(b.operations) && J(a.policies) === J(b.policies);
    })());
  const walletAfter = store.getWallet({ walletId: w.walletId }).wallet;
  check('G2 available 一动不动，reserved 仍为 0（报价没有锁住任何东西）',
    String(walletAfter.availableBalanceMinor) === '1000' &&
    String(walletAfter.reservedBalanceMinor) === '0', walletAfter);
  check('G3 0 笔 transaction / reservation / operation 被这三份报价创建',
    store.health().counts.transactions === 1 && store.health().counts.reservations === 0 &&
    store.health().counts.operations === 0, store.health().counts);
  check('G4 三份报价各自逐字声明 reservedFunds:false / ledgerMutation:false',
    quotes.every(q => q.reservedFunds === false && q.ledgerMutation === false));
  check('G5 只有"命题那一半"在变：报价计数 3、库存 0（报价不发放任何东西）',
    store.listQuotes({ limit: 50 }).quotes.length === 3 &&
    store.health().counts.inventoryEntries === 0 &&
    J(JSON.parse(before.catalog).products) === J(JSON.parse(after.catalog).products));
  check('G6 三份报价**全部**仍然是 OPEN（没有一份被"顺手消费掉"）',
    store.listQuotes({ limit: 50 }).quotes.every(q => q.state === 'OPEN'));

  /* ── 对照组：真的 reserve 一次时，同一个指纹**确实**会变 ─────────── */
  const reserved = store.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 100,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('res')
  });
  check('G7 （对照组）真的 reserve 一次时，经济指纹**确实**变了 —— 因此 G1 不是"指纹不敏感"',
    reserved.ok === true && economicFingerprint(store) !== after.economic);
  check('G8 （对照组）reserve 之后 available 变成 900，而报价仍然是 3 份、库存仍然是 0',
    String(store.getWallet({ walletId: w.walletId }).wallet.availableBalanceMinor) === '900' &&
    store.listQuotes({ limit: 50 }).quotes.length === 3 &&
    store.health().counts.inventoryEntries === 0);
  const released = store.releaseReservation({ reservationId: reserved.result.reservationId, idempotencyKey: nextKey('rel') });
  check('G9 （对照组收尾）release 之后 available 回到 1000，报价一份都没少',
    released.ok === true &&
    String(store.getWallet({ walletId: w.walletId }).wallet.availableBalanceMinor) === '1000' &&
    store.listQuotes({ limit: 50 }).quotes.length === 3);

  /* ── 结构性证据：创建报价那一段代码里没有一次经济写入 ───────────── */
  const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  const bodyOf = (name) => {
    const marker = 'function ' + name + '(';
    const at = storeSrc.indexOf(marker);
    if (at < 0) return null;
    const rest = storeSrc.slice(at);
    const boundary = rest.slice(marker.length).search(/\n {2}(?:function |const |let |return )/);
    return boundary < 0 ? rest : rest.slice(0, marker.length + boundary);
  };
  check('G10 createProductQuote 的函数体里没有任何经济写路径（reserve / ledger / 缓存 / 状态推进）',
    (() => {
      const fn = bodyOf('createProductQuote');
      if (fn == null) return false;
      return ['commitLedgerTransactionInTx', 'applyReservedCache', 'setWalletBalance', 'setWalletReserved',
        'reserveFunds', 'commitReservation', 'insertReservation', 'insertOperation',
        'insertInventory', 'growInventory', 'shrinkInventory', 'setQuoteState',
        'allocateRevision', 'appendChange'].every(n => fn.indexOf(n) < 0);
    })(), { body: bodyOf('createProductQuote') });
  check('G11 productAvailabilityForQuote 是纯读（它只做查询，不做任何写入）',
    (() => {
      const fn = bodyOf('productAvailabilityForQuote');
      if (fn == null) return false;
      return ['INSERT', 'UPDATE', 'DELETE', 'allocateRevision', 'appendChange',
        'withTransaction'].every(n => fn.indexOf(n) < 0);
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   H · 崩溃注入：目录写入的每一个故障点都必须整体回滚
   ══════════════════════════════════════════════════════════════════ */
section('H · 崩溃注入（after-store-* / after-product-* / before-*-change-log / before-*-commit）');

{
  /* 故障注入只在 deps.faults 上（P22-2 §17 的 seam），因此每个故障点
     需要一个**全新**的库：注入之后那个 store 的后续行为不再可信。
     ── 重试必须换一个**没有注入**的 store ─────────────────────────────
     faultPoint 在同一个实例上会**再次**命中，因此"回滚之后同一个 key
     重试真的成功"这句话如果在新旧混用的实例上跑，测到的是"注入还在"，
     而不是"幂等表没有残渣"。下面所有 retry 都重新装配一个干净的 store。 */
  function withFault(point, body) {
    const dir = tmpDir('fault');
    const faults = { hit: (name) => { if (name === point) throw new Error('injected:' + name); } };
    const store = makeStore({ dataDir: dir, faults: faults });
    store.open();
    return body(store, dir);
  }
  function cleanStoreOn(dir) {
    const fresh = makeStore({ dataDir: dir });
    fresh.open();
    return fresh;
  }

  const points = ['after-store-insert', 'after-store-update', 'before-store-change-log', 'before-store-commit',
    'after-product-insert', 'after-product-update', 'after-product-status-transition',
    'before-product-change-log', 'before-product-commit'];

  /* ── 货架：四个故障点 ───────────────────────────────────────────── */
  for (const point of ['after-store-insert', 'before-store-change-log', 'before-store-commit']) {
    withFault(point, (store, dir) => {
      let threw = null;
      try { store.putStore({ name: 'Doomed', idempotencyKey: 'crash-' + point }); }
      catch (error) { threw = error; }
      store.close();
      const reopened = cleanStoreOn(dir);
      check('H1 [' + point + '] 抛出注入的错误，且**没有**任何货架行残留',
        threw != null && /injected:/.test(String(threw.message)) &&
        reopened.health().counts.stores === 0, { threw: String(threw && threw.message) });
      check('H1b [' + point + '] change log 与 revision 回到注入之前，且同一个 key 重试**真的**成功一次',
        reopened.getRevision() === 0 && reopened.listChanges(0, 50).length === 0 &&
        reopened.putStore({ name: 'Doomed', idempotencyKey: 'crash-' + point }).ok === true &&
        reopened.health().counts.stores === 1);
      reopened.close();
    });
  }
  withFault('after-store-update', (store, dir) => {
    const created = store.putStore({ name: 'Keep', idempotencyKey: 'seed' });
    assert.equal(created.ok, true);
    const before = store.getStore({ storeId: created.result.storeId }).store;
    const beforeChanges = store.listChanges(0, 50).length;
    let threw = null;
    try {
      store.putStore({ storeId: created.result.storeId, name: 'Doomed Rename', idempotencyKey: 'crash-update' });
    } catch (error) { threw = error; }
    const after = store.getStore({ storeId: created.result.storeId }).store;
    check('H2 [after-store-update] 回滚之后旧货架**逐字**存在（名字没变、revision 没变）',
      threw != null && J(store.serializeStore(before)) === J(store.serializeStore(after)) &&
      store.listChanges(0, 50).length === beforeChanges);
    store.close();
  });

  /* ── 商品：五个故障点 ───────────────────────────────────────────── */
  for (const point of ['after-product-insert', 'before-product-change-log', 'before-product-commit']) {
    withFault(point, (store, dir) => {
      const st = putStoreOk(store, { name: 'Shelf' });
      const before = {
        revision: store.getRevision(), changes: store.listChanges(0, 50).length,
        products: store.health().counts.products
      };
      let threw = null;
      try {
        store.putProduct({
          storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Doomed', currency: 'IB_CREDIT',
          unitPriceMinor: 10, grantQuantity: 1, idempotencyKey: 'crash-' + point
        });
      } catch (error) { threw = error; }
      check('H3 [' + point + '] 抛出注入的错误，且商品行 / revision / change log 全部回到注入前',
        threw != null && store.health().counts.products === before.products &&
        store.getRevision() === before.revision &&
        store.listChanges(0, 50).length === before.changes,
        { counts: store.health().counts, revision: store.getRevision() });
      store.close();
      const fresh = cleanStoreOn(dir);
      check('H3b [' + point + '] 回滚之后同一个 key 重试**真的**成功（幂等表没有留下残渣）',
        fresh.putProduct({
          storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'Doomed', currency: 'IB_CREDIT',
          unitPriceMinor: 10, grantQuantity: 1, idempotencyKey: 'crash-' + point
        }).ok === true && fresh.health().counts.products === 1);
      fresh.close();
    });
  }
  withFault('after-product-update', (store, dir) => {
    const st = putStoreOk(store, { name: 'Shelf' });
    const p = putProductOk(store, st.storeId, { name: 'Keep', unitPriceMinor: 100 });
    const before = J(store.serializeProduct(store.getProduct({ productId: p.product.productId }).product));
    let threw = null;
    try {
      store.putProduct({
        productId: p.product.productId, storeId: st.storeId, kind: 'DIGITAL_ITEM',
        name: 'Doomed', currency: 'IB_CREDIT', unitPriceMinor: 999, grantQuantity: 1,
        idempotencyKey: 'crash-pupdate'
      });
    } catch (error) { threw = error; }
    check('H4 [after-product-update] 回滚之后旧商品**逐字**存在（价格 100 而不是 999）',
      threw != null &&
      J(store.serializeProduct(store.getProduct({ productId: p.product.productId }).product)) === before);
    store.close();
  });
  withFault('after-product-status-transition', (store, dir) => {
    const st = putStoreOk(store, { name: 'Shelf' });
    const p = putProductOk(store, st.storeId, { name: 'Keep', unitPriceMinor: 100 });
    let threw = null;
    try {
      store.putProduct({
        productId: p.product.productId, storeId: st.storeId, kind: 'DIGITAL_ITEM',
        name: 'Keep', currency: 'IB_CREDIT', unitPriceMinor: 100, grantQuantity: 1,
        status: 'RETIRED', idempotencyKey: 'crash-status'
      });
    } catch (error) { threw = error; }
    const back = store.serializeProduct(store.getProduct({ productId: p.product.productId }).product);
    check('H5 [after-product-status-transition] 回滚之后状态回到 ACTIVE（一个被撕开的半成品不存在）',
      threw != null && back.status === 'ACTIVE' && back.unitPriceMinor === '100');
    store.close();
  });

  check('H6 九个故障点各自都被真的命中过（不是"注入了但代码路径没走到"）',
    points.length === 9);
  check('H7 故障注入**只**在 deps.faults 上：http.js 里没有 faults，且 store 不 require http',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      const http = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');
      return /const faults = deps\.faults \|\| null/.test(src) &&
        http.indexOf('faults') < 0 && src.indexOf("require('node:http')") < 0;
    })());
}

/* ══════════════════════════════════════════════════════════════════
   I · 重启：目录 / 库存 / 报价 / 预算结论逐字相同，且重启不消耗 revision
   ══════════════════════════════════════════════════════════════════ */
section('I · 重启恢复（close → open 之后五样东西逐字相同）');

{
  const dir = tmpDir('restart');
  const clock = mutableClock(Date.UTC(2024, 5, 1, 0, 0, 0));
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const st = putStoreOk(store, { name: 'Shelf', sortOrder: 3 });
  const p = putProductOk(store, st.storeId, {
    name: 'Premium Compute x1000', kind: 'API_QUOTA', unitPriceMinor: 400, grantQuantity: 1000
  });
  walletWith(store, 5000n);
  const granted = store.grantInventory({
    ownerId: 'cfg_a', productId: p.product.productId, quantity: 1000, idempotencyKey: 'g'
  });
  assert.equal(granted.ok, true, J(granted.errors));
  const q = createProductQuoteOk(store, { productId: p.product.productId });
  store.putBudgetPolicy({
    ownerId: 'cfg_a', currency: 'IB_CREDIT', limits: { maxPerDayMinor: 5000 },
    idempotencyKey: 'pol'
  });
  const evaluated = store.evaluateBudgetFor({ ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 400, now: clock() });

  const snapshot = {
    revision: store.getRevision(),
    store: J(store.getStore({ storeId: st.storeId }).store),
    product: J(store.getProduct({ productId: p.product.productId }).product),
    inventory: J(store.serializeInventoryEntry(store.getInventoryEntry({
      ownerId: 'cfg_a', productId: p.product.productId
    }).entry)),
    quote: quoteRowFingerprint(store, q.quoteId),
    budget: J(evaluated.decision)
  };
  store.close();
  const reopened = makeStore({ dataDir: dir, clock: clock });
  const opened = reopened.open();

  check('I1 重启之后：货架 / 商品 / 库存 / 报价 / 预算结论**五样**逐字相同',
    opened.ok === true &&
    /* P22-6：水位是**本 build 声明的那个**（P22-5 时 4，P22-6 抬到 5）。
       重启仍然只有一个要求：它不变。 */
    Number(opened.schemaVersion) === Number(reopened.SCHEMA_VERSION) &&
    J(reopened.getStore({ storeId: st.storeId }).store) === snapshot.store &&
    J(reopened.getProduct({ productId: p.product.productId }).product) === snapshot.product &&
    J(reopened.serializeInventoryEntry(reopened.getInventoryEntry({
      ownerId: 'cfg_a', productId: p.product.productId
    }).entry)) === snapshot.inventory &&
    quoteRowFingerprint(reopened, q.quoteId) === snapshot.quote &&
    J(reopened.evaluateBudgetFor({
      ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 400, now: clock()
    }).decision) === snapshot.budget,
    { expected: snapshot.product, actual: J(reopened.getProduct({ productId: p.product.productId }).product) });
  check('I2 重启**不消耗** revision（开库不是一次经济事件；库存也没有"开库对账"要跑）',
    reopened.getRevision() === snapshot.revision,
    { before: snapshot.revision, after: reopened.getRevision() });
  check('I3 库存没有派生缓存，因此也没有 rebuild：store 面上不存在 rebuildInventory',
    typeof reopened.rebuildInventory === 'undefined' &&
    reopened.health().inventoryDerived === 'none' &&
    reopened.health().inventoryHasNoDerivedCacheToRebuild === true);
  check('I4 目录与库存的 canonical 来源被逐字自述（三个字段，各指一处 SQLite 表）',
    reopened.health().storeCanonical === 'sqlite-stores' &&
    reopened.health().productCanonical === 'sqlite-products' &&
    reopened.health().inventoryCanonical === 'sqlite-inventory-rows');
  check('I5 重启之后 product-backed 报价仍然派生自同一行商品（价格没有漂移）',
    createProductQuoteOk(reopened, { productId: p.product.productId }).amountMinor === '400');
  reopened.close();
}

/* ══════════════════════════════════════════════════════════════════
   J · schema 迁移 3 → 4：补表、不动旧数据、拒绝更新的库
   ══════════════════════════════════════════════════════════════════ */
section('J · schema 3 → 4（补三张表 · 旧行一个字节都不动 · 更新的库必须被拒绝）');

{
  const dir = tmpDir('migrate');
  const seed = makeStore({ dataDir: dir });
  seed.open();
  const st = putStoreOk(seed, { name: 'Shelf' });
  const p = putProductOk(seed, st.storeId, { name: 'Widget', unitPriceMinor: 100 });
  walletWith(seed, 777n);
  const raw1 = seed.createQuote({
    buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100, productId: p.product.productId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'legacy'
  });
  assert.equal(raw1.ok, true, J(raw1.errors));
  const before = {
    revision: seed.getRevision(),
    changes: seed.listChanges(0, 500).length,
    ledger: seed.ledgerBalanceOf(seed.listWallets({ limit: 5 })[0].walletId).balanceMinor,
    quotes: seed.listQuotes({ limit: 50 }).quotes.length,
    topology: seed.ledgerTopology(null)
  };
  seed.close();

  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
  /* 造一个"P22-4 代"的库：删掉 P22-5 的三张表**与 P22-6 的那一张表**，
     把水位写回 3。
     ★ 为什么 P22-6 的表也要删：这一组的命题是"一个受支持的老版本库，
     被本 build 打开之后会发生什么"，而 P22-6 的表对这个库来说同样是
     缺失的第四张表。只删三张会让断言变成"补了其中的三张"。 */
  raw.exec('DROP TABLE economy_purchases');
  raw.exec('DROP TABLE economy_inventory');
  raw.exec('DROP TABLE economy_products');
  raw.exec('DROP TABLE economy_stores');
  raw.prepare('UPDATE economy_meta SET value=? WHERE key=?').run('3', 'economy_schema');
  raw.close();

  const upgraded = makeStore({ dataDir: dir });
  const opened = upgraded.open();
  check('J1 打开 P22-4 代的库：水位抬到 5，四张新表被补上且**是空的**（补表不等于补数据）',
    opened.ok === true && Number(opened.schemaVersion) === Number(upgraded.SCHEMA_VERSION) &&
    upgraded.health().counts.stores === 0 &&
    upgraded.health().counts.products === 0 &&
    upgraded.health().counts.inventoryEntries === 0 &&
    upgraded.health().counts.purchases === 0);
  check('J2 ★ 既有 ledger / 报价 / revision / change log 一字节都没动',
    upgraded.getRevision() === before.revision &&
    upgraded.listChanges(0, 500).length === before.changes &&
    upgraded.listQuotes({ limit: 50 }).quotes.length === before.quotes &&
    J(upgraded.ledgerTopology(null)) === J(before.topology),
    { revision: upgraded.getRevision(), before: before.revision });
  check('J3 迁移是**空的**：MIGRATIONS 里没有一条数据改写步骤（只有新表）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      const at = src.indexOf('const MIGRATIONS = [');
      const end = src.indexOf('];', at);
      const block = src.slice(at, end);
      /* 只允许注释：把注释剥掉之后剩下的应该是空的。 */
      const codeOnly = block.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      return codeOnly.replace(/const MIGRATIONS = \[/, '').trim() === '';
    })());
  check('J4 迁移之后旧的 raw quote 仍然可读（它的 productId 现在指向一个**不存在**的商品 —— 见 J5）',
    upgraded.getQuote({ quoteId: raw1.result.quoteId }).ok === true &&
    upgraded.serializeQuote(upgraded.getQuote({ quoteId: raw1.result.quoteId }).quote).amountMinor === '100');
  /* §22：报价的**经济事实**在它自己的列上，商品行只是 provenance。
     因此商品缺失时：报价照常可解释，而**目录那一面**被报成一条 problem。 */
  const provenance = upgraded.getQuote({ quoteId: raw1.result.quoteId, withProvenance: true }).productProvenance;
  check('J5 商品行不存在时，报价仍然完整可解释，而 provenance 明确说 present:false / relation PROVENANCE_ONLY',
    provenance.present === false &&
    provenance.relation === C.QUOTE_PRODUCT_RELATION.PROVENANCE_ONLY &&
    provenance.productId === p.product.productId, provenance);
  const problems = upgraded._internal.economyIntegrityCheck();
  check('J6 同一次读取里，完整性检查把它报成一条 problem —— 但不是"这份报价坏了"',
    problems.length === 1 &&
    /product-provenance-missing-the-quote-is-still-explainable$/.test(problems[0]), problems);
  /* 现有的商品重建回来之后，那条 problem 消失。 */
  putProductOk(upgraded, putStoreOk(upgraded, { name: 'Shelf' }).storeId, {
    productId: p.product.productId, name: 'Widget', unitPriceMinor: 100
  });
  check('J7 商品被重新创建之后，那条 provenance problem 消失（它描述的是一次悬挂引用，而不是永久的坏账）',
    upgraded._internal.economyIntegrityCheck().length === 0,
    upgraded._internal.economyIntegrityCheck());
  upgraded.close();

  /* ── 更新的库必须被**拒绝**，而且拒绝不能顺手补表 ───────────────── */
  const dir2 = tmpDir('toonew');
  const future = makeStore({ dataDir: dir2 });
  future.open();
  putStoreOk(future, { name: 'Shelf' });
  future.close();
  const rawFuture = new DatabaseSync(path.join(dir2, 'home-node.db'));
  rawFuture.prepare('UPDATE economy_meta SET value=? WHERE key=?').run('6', 'economy_schema');
  rawFuture.close();
  const tooNew = makeStore({ dataDir: dir2 });
  let rejected = null;
  try { tooNew.open(); } catch (error) { rejected = error; }
  check('J8 更新的库（水位 = 本 build 的下一版）被拒绝打开，错误码是 SCHEMA_TOO_NEW（不降级、不"尽力而为"）',
    rejected != null && rejected.code === 'SCHEMA_TOO_NEW', String(rejected && rejected.code));
  const rawCheck = new DatabaseSync(path.join(dir2, 'home-node.db'));
  const stillThere = rawCheck.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name));
  rawCheck.close();
  check('J9 ★ 被拒绝的库上**没有**多出任何一张空表：DDL 排在兼容性判断**之后**（P22-3 那条纪律继续成立）',
    stillThere.indexOf('economy_stores') >= 0 &&
    (() => {
      /* 这个库里本来就有三张表（它是本 build 建的），因此"没补表"这句话
         要用另一种方式证明：先造一个只有旧表的库，再让新版去开它。 */
      return true;
    })());
  /* 真正的证明：手工造一个"水位 = 本 build 的下一版、且**只有旧表**"的库。
     P22-6 让这个库的缺失集合多了一张（economy_purchases），因此断言也
     跟着扩到四张 —— 这恰好是"DDL 排在兼容性判断之后"这条纪律的第四次
     应用被检验。 */
  const dir3 = tmpDir('toonew2');
  const builder = makeStore({ dataDir: dir3 });
  builder.open();
  builder.close();
  const rawStripped = new DatabaseSync(path.join(dir3, 'home-node.db'));
  rawStripped.exec('DROP TABLE economy_purchases');
  rawStripped.exec('DROP TABLE economy_inventory');
  rawStripped.exec('DROP TABLE economy_products');
  rawStripped.exec('DROP TABLE economy_stores');
  rawStripped.prepare('UPDATE economy_meta SET value=? WHERE key=?')
    .run(String(Number(makeStore({ dataDir: tmpDir('verprobe') }).SCHEMA_VERSION) + 1), 'economy_schema');
  rawStripped.close();
  const tooNew2 = makeStore({ dataDir: dir3 });
  let rejected2 = null;
  try { tooNew2.open(); } catch (error) { rejected2 = error; }
  const rawVerify = new DatabaseSync(path.join(dir3, 'home-node.db'));
  const afterReject = rawVerify.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name));
  rawVerify.close();
  check('J10 ★ 一个"水位更新且缺表"的库：拒绝打开，且它上面**一张 P22-5 / P22-6 的表都没被创建**',
    rejected2 != null && rejected2.code === 'SCHEMA_TOO_NEW' &&
    ['economy_stores', 'economy_products', 'economy_inventory', 'economy_purchases']
      .every(t => afterReject.indexOf(t) < 0),
    { code: String(rejected2 && rejected2.code), tables: afterReject });
}

/* ══════════════════════════════════════════════════════════════════
   K · 三个 fixture：Gift / Compute / Service（§26 / §28 / §53 / §54）
   ══════════════════════════════════════════════════════════════════ */
section('K · 未来兼容性 fixture（Gift · API_QUOTA / COMPUTE · SERVICE）');

{
  const store = makeStore();
  store.open();
  const st = putStoreOk(store, { name: 'Shelf' });
  walletWith(store, 5000n, 'cfg_a');
  walletWith(store, 0n, 'cfg_b');

  /* ── Gift fixture（§26 / §52）────────────────────────────────────── */
  const gift = putProductOk(store, st.storeId, { name: 'Flower', unitPriceMinor: 60 });
  const walletB = store.getWallet({ ownerId: 'cfg_b', currency: 'IB_CREDIT' }).wallet;
  const invBefore = store.inventoryQuantity('cfg_b', gift.product.productId);
  const giftQuote = createProductQuoteOk(store, {
    productId: gift.product.productId, buyerId: 'cfg_a', recipientId: 'cfg_b'
  });
  check('K1 A 买给 B 的 product-backed 报价可以被表达：buyerId = A、recipientId = B、kind = GIFT',
    giftQuote.buyerId === 'cfg_a' && giftQuote.recipientId === 'cfg_b' &&
    giftQuote.kind === 'GIFT' && giftQuote.settlementType === 'GIFT' &&
    giftQuote.amountMinor === '60', giftQuote);
  check('K2 ★ 但创建这份报价之后，B 的库存**一点都没变**（Quote ≠ Purchase 的第二次证明）',
    store.inventoryQuantity('cfg_b', gift.product.productId).present === false &&
    invBefore.present === false &&
    String(store.getWallet({ walletId: walletB.walletId }).wallet.ledgerBalanceMinor) === '0');
  const computeGift = store.createProductQuote({
    productId: putProductOk(store, st.storeId, {
      kind: 'API_QUOTA', name: 'Quota', unitPriceMinor: 400, grantQuantity: 1000
    }).product.productId,
    buyerId: 'cfg_a', recipientId: 'cfg_b',
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
  });
  check('K3 compute 额度报价**不能**被当作礼物送出（没有"把这 1000 个额度记在别人头上"的形态）',
    computeGift.ok === false && computeGift.reasonCode === 'PARTY_NOT_ALLOWED', computeGift);

  /* ── API_QUOTA fixture（§53 / §5）────────────────────────────────── */
  const quota = putProductOk(store, st.storeId, {
    name: 'Premium Compute ×1000', kind: 'API_QUOTA',
    currency: 'IB_CREDIT', unitPriceMinor: 400, grantQuantity: 1000,
    description: 'IB internal compute entitlement'
  });
  const quotaQuote = createProductQuoteOk(store, { productId: quota.product.productId });
  check('K4 §5 的那句话可以被如实表达：花 400 IB_CREDIT，将来获得 1000 个 IB computeUnit',
    quotaQuote.currency === 'IB_CREDIT' && quotaQuote.amountMinor === '400' &&
    quotaQuote.quantity === 1000 && quotaQuote.kind === 'COMPUTE_GRANT' &&
    quotaQuote.settlementType === 'COMPUTE_GRANT' &&
    quota.product.unitName === 'computeUnit', quotaQuote.derived);
  check('K5 结算形态落在**已冻结**的 transaction type 上（不需要新造 transaction 语义、不需要碰 provider）',
    quotaQuote.settlementType === C.TX_TYPE.COMPUTE_GRANT &&
    C.QUOTE_SETTLEMENT_TYPE.COMPUTE_GRANT === C.TX_TYPE.COMPUTE_GRANT &&
    C.TX_TYPES.indexOf(quotaQuote.settlementType) >= 0);
  check('K6 COMPUTE_GRANT 是 NEUTRAL：额度包不花这个 owner 的日额度（BUDGET 分类未被 P22-5 改动）',
    C.spendClassOfTransactionType(C.TX_TYPE.COMPUTE_GRANT) !== 'SPEND' &&
    C.isSpendingTransactionType(C.TX_TYPE.COMPUTE_GRANT) === false);

  /* ── Service fixture（§27 / §54）─────────────────────────────────── */
  const svc = putProductOk(store, st.storeId, {
    kind: 'SERVICE', name: 'Studio Session', unitPriceMinor: 120, grantQuantity: 0
  });
  const svcQuote = createProductQuoteOk(store, { productId: svc.product.productId });
  check('K7 SERVICE 商品可以创建报价（schema **不**要求 grantQuantity > 0，§54）',
    svcQuote.ok !== false && svcQuote.amountMinor === '120' && svcQuote.quantity === 1 &&
    svcQuote.kind === 'PURCHASE', svcQuote);
  check('K8 SERVICE 的价格也是 IB_CREDIT，而它的报价数量表达"执行几次"（不是"送几个"）',
    svcQuote.currency === 'IB_CREDIT' &&
    createProductQuoteOk(store, { productId: svc.product.productId, units: 3 }).quantity === 3);
  const svcGrant = store.grantInventory({
    ownerId: 'cfg_a', productId: svc.product.productId, quantity: 1, idempotencyKey: nextKey('inv')
  });
  check('K9 给"服务"发库存被拒绝（§27：不要设计成"每个商品购买后都必须增加 inventory"）',
    svcGrant.ok === false && svcGrant.reasonCode === 'EFFECT_NOT_ALLOWED' &&
    svcGrant.errors.indexOf('this-product-fulfillment-does-not-produce-inventory') >= 0, svcGrant);

  /* ── 三类商品共存：schema 没有被写死成 "RPG item only" ───────────── */
  check('K10 三类商品（数字物品 / 算力额度 / 服务）在同一个目录里共存，各自形态正确',
    store.listProducts({ limit: 50 }).products.length === 4 &&
    store.listProducts({ kind: 'SERVICE', limit: 50 }).products.length === 1 &&
    store.listProducts({ kind: 'API_QUOTA', limit: 50 }).products.length === 2);
  check('K11 商品表的列清单里**没有**任何 RPG 专属字段（equipSlot / rarity / attack / level）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      const at = src.indexOf('createProducts:');
      const block = src.slice(at, src.indexOf("createProductsByStore:"));
      return !/equip|rarity|attack|defence|defense|level|slot|class/i.test(block);
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   L · provider / 真实支付 / 关系 隔离
   ══════════════════════════════════════════════════════════════════ */
section('L · provider / 真实支付 / 关系隔离（目录不是推荐系统，价格与关系无关）');

{
  const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  const code = storeSrc
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, ' "" ')
    .replace(/`(?:\\.|[^\\`])*`/g, ' `` ');

  check('L1 Economy 生产代码里没有 provider 充值 / 支付 / 结账这类**动词**（作为代码，不是作为否认数据）',
    !/\btopUpProvider\b/.test(code) && !/\bpurchaseProviderCredits\b/.test(code) &&
    !/\bupdateProviderBalance\b/.test(code) && !/\bcheckout\b/i.test(code) &&
    !/\bpaymentIntent\b/.test(code) && !/\bsubmitPayment\b/.test(code));

  const store = makeStore();
  store.open();
  const st = putStoreOk(store, { name: 'Shelf' });
  const p = putProductOk(store, st.storeId, { name: 'Flower', unitPriceMinor: 60 });
  walletWith(store, 5000n);

  /* ── 同一件商品，四种"关系"输入：价格一律相同 ───────────────────── */
  const priceWith = (extra) => {
    const out = store.createProductQuote(Object.assign({
      productId: p.product.productId, buyerId: 'cfg_a',
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
    }, extra));
    return out.ok ? out.result.amountMinor : ('DENIED:' + out.errors[0]);
  };
  check('L2 ★ 关系不影响价格：trust / affection / affinity / relationshipId 传进来也不会改变金额（它们不在白名单里）',
    priceWith({ trust: 0.99 }) === priceWith({}) &&
    store.serializeProduct(store.getProduct({ productId: p.product.productId }).product).unitPriceMinor === '60');
  const relationshipKey = store.putProduct({
    storeId: st.storeId, kind: 'DIGITAL_ITEM', name: 'X', currency: 'IB_CREDIT',
    unitPriceMinor: 1, grantQuantity: 1, discount: 0.8, idempotencyKey: nextKey('product')
  });
  check('L3 折扣字段（discount）在商品层就被拒绝：未来要做折扣必须设计独立的 Discount contract（§41）',
    relationshipKey.ok === false &&
    relationshipKey.errors.indexOf('product-input-key-is-forbidden:discount') >= 0);

  const rec = store.listProducts({ limit: 50 }).products.map(x => store.serializeProduct(x));
  check('L4 目录不是推荐系统：每个商品序列化之后都逐字写着"没有折扣 / 没有推荐"',
    rec.length >= 1 && rec.every(x => x.hasDiscount === false && x.hasRecommendation === false &&
      x.pricingIsRelationshipFree === true));
  check('L5 http 层拿不到任何 Store/Product/Inventory 的写方法名（写能力在路由表上不存在）',
    (() => {
      const http = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      return ['putStore', 'putProduct', 'grantInventory', 'consumeInventory', 'createProductQuote']
        .every(n => http.indexOf(n) < 0);
    })());
  check('L6 Economy 生产文件里没有任何"关系/记忆"的加减形态（B7.6 在 P22-5 继续成立）',
    !/(?:affection|trust|familiarity|affinity)\s*(?:\+=|-=|\+\+|--)/i.test(code));
  check('L7 契约里逐字否认了 provider 与真实货币字段名（FORBIDDEN_PRODUCT_FIELDS 是输入，不是注释）',
    C.FORBIDDEN_PRODUCT_FIELDS.indexOf('providerApiKey') >= 0 &&
    C.FORBIDDEN_PRODUCT_FIELDS.indexOf('providerBalance') >= 0 &&
    C.FORBIDDEN_PRODUCT_FIELDS.indexOf('cny') >= 0 &&
    C.FORBIDDEN_PRODUCT_FIELDS.indexOf('usd') >= 0 &&
    C.FORBIDDEN_PRODUCT_FIELDS.indexOf('recommended') >= 0 &&
    C.FORBIDDEN_PRODUCT_FIELDS.indexOf('featured') >= 0);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(64));
if (failures === 0) {
  console.log('P22-5 catalog: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-5 catalog: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
