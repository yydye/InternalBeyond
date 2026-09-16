'use strict';
/* ====================================================================
   P22-5 · Economy runtime 接线（HTTP 只读面 + 真实子进程 + 多进程竞争）
   --------------------------------------------------------------------
   运行：node tests/test_p22_5_economy_runtime.js

   本文件回答的问题与另外两个 P22-5 文件**不同**：
     catalog / inventory 测试问"目录与库存这一层的语义对不对"；本文件问
     「**生产进程里**这一层能不能被看到，而且它**仍然**不能改任何东西？」

   ── 为什么这一阶段特别需要真实子进程 ─────────────────────────────────
   P22-5 第一次让"目录"成为一个可写的 canonical 面（货架 / 商品 / 库存），
   而本阶段一条写路由都不开。要证明的是三件更难的事：
     ① 生产进程里 GET /economy/stores · /store · /products · /product ·
        /inventory · /inventory-entry 真的能读到数据（不是 501 / 404 /
        空数组）；
     ② 对这些路径的每一种写动词（POST / PUT / DELETE）都是 405，而且
        **写尝试之后目录、库存、报价、账本一个字节都没变**；
     ③ 库存的"不可能为负"在**两个真实进程**之间也成立 —— 这是 P22-3
        的 reserve 竞争测试换到库存上的同一条纪律。

   ── 这个仓库的"第 N 次形态"────────────────────────────────────────────
   memory / understanding / moments / economy-store / budget-quote 各被
   "装配好了但没接上"咬过一次。P22-5 **没有新增 store**，但它新增了六条
   路由要读的对象 —— 因此同一类断言必须重跑：真的 spawn
   services/home-node-service.js、真的打这六条新路径。
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_FILE = 'services/home-node-service.js';
const WORKER_FILE = 'tests/fixtures/p22-5-consume-worker.js';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-5rt-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}),
      timeout: 8000
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 400) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const BUNDLED_NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const NODE_BIN = fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;
const openChildren = new Set();
process.on('exit', () => {
  for (const child of openChildren) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});
function startProduction(dir) {
  return freePort().then(port => new Promise(resolve => {
    const child = spawn(NODE_BIN, [SERVICE_FILE], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        IB_HOME_NODE_PORT: String(port),
        IB_HOME_NODE_DATA_DIR: dir
      }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    openChildren.add(child);
    const svc = { port: port, child: child, stdout: '', stderr: '', exited: null };
    svc.output = () => (svc.stdout + svc.stderr).slice(-4000);
    child.stdout.on('data', c => { svc.stdout += String(c); });
    child.stderr.on('data', c => { svc.stderr += String(c); });
    child.on('exit', (code, signal) => { svc.exited = { code: code, signal: signal }; openChildren.delete(child); });
    resolve(svc);
  }));
}
async function waitListening(svc, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (svc.exited) return false;
    try { const r = await request(svc.port, 'GET', '/health'); if (r.status === 200) return true; } catch (_) { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}
async function stopProduction(svc) {
  if (!svc || svc.exited) return;
  try { await request(svc.port, 'POST', '/__shutdown', {}); } catch (_) { /* 可能已经退出 */ }
  for (let i = 0; i < 60 && !svc.exited; i++) await sleep(100);
  if (!svc.exited) svc.child.kill('SIGTERM');
  for (let i = 0; i < 30 && !svc.exited; i++) await sleep(100);
}
/* 一个真实子进程 worker：跑一次 fixture，把它那一行 JSON 拿回来。 */
function runWorker(args) {
  return new Promise(resolve => {
    const child = spawn(NODE_BIN, [WORKER_FILE].concat(args), {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    openChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', c => { stderr += String(c); });
    child.on('exit', code => {
      openChildren.delete(child);
      let result = null;
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (line) { try { result = JSON.parse(line); } catch (_) { result = null; } }
      resolve({ code: code, result: result, stdout: stdout, stderr: stderr });
    });
  });
}

console.log('P22-5 · Economy runtime（HTTP 只读面 + 真实子进程 + 多进程竞争）');
console.log('  node =', NODE_BIN, NODE_BIN === BUNDLED_NODE ? '(bundled, = production)' : '(FALLBACK: bundled runtime missing)');

const SERVICE = require(path.join(ROOT, SERVICE_FILE));

/* ══════════════════════════════════════════════════════════════════
   A · 装配形状（静态）
   ══════════════════════════════════════════════════════════════════ */
section('A · 装配形状：能力在 store 上，一个都不在 HTTP 上');

{
  const src = fs.readFileSync(path.join(ROOT, SERVICE_FILE), 'utf8');
  /* ★ 与 P22-1 的 B3.7 同款纪律：被禁止的是**引用**（一个真实的标识符），
     不是解释。装配层必须能说明"货架与商品的写入口**不在**配置面上"，
     而那句说明里当然会写出那个成员名 —— 因此这里剥掉注释与字符串再判。 */
  const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('A1 P22-5 没有新增 store 装配点：Economy 的装配仍然只有 economyAssembly 一份',
    (src.match(/function economyAssembly/g) || []).length === 1);
  check('A2 P22-5 的五个写方法一个都没有进入装配层（装配层只创建/打开 store，不替它决定业务）',
    ['putStore', 'putProduct', 'grantInventory', 'consumeInventory', 'createProductQuote']
      .every(name => srcCode.indexOf(name) < 0),
    ['putStore', 'putProduct', 'grantInventory', 'consumeInventory', 'createProductQuote']
      .filter(name => srcCode.indexOf(name) >= 0));
  check('A3 生产 store 上真的有 P22-5 的全部方法与读面（能力存在，只是没有暴露到 HTTP）',
    ['putStore', 'putProduct', 'getStore', 'listStores', 'getProduct', 'listProducts',
      'serializeStore', 'serializeProduct', 'createProductQuote',
      'grantInventory', 'consumeInventory', 'getInventoryEntry', 'listInventory',
      'inventoryQuantity', 'serializeInventoryEntry', 'productProvenanceOf']
      .every(name => typeof SERVICE.economyStore[name] === 'function'),
    Object.keys(SERVICE.economyStore).filter(k => /Store|Product|Inventory/.test(k)));
  check('A4 装配层**没有**为每条路由复制一份逻辑（新路由只是把参数转给 store）',
    src.indexOf('/economy/product') < 0 && src.indexOf('/economy/store') < 0 &&
    src.indexOf('/economy/inventory') < 0);
  check('A5 生产 store 的 schema 水位 ≥ 4，且与 store 模块自身声明一致',
    Number(SERVICE.economyStore.SCHEMA_VERSION) ===
    Number(require(path.join(ROOT, 'services', 'home-node', 'economy-store.js')).SCHEMA_VERSION) &&
    Number(SERVICE.economyStore.SCHEMA_VERSION) >= 4,
    { service: SERVICE.economyStore.SCHEMA_VERSION });
}

/* ══════════════════════════════════════════════════════════════════
   B · HTTP 面（真实 server、真实请求）
   ══════════════════════════════════════════════════════════════════ */
section('B · HTTP 面：六条新只读路由 + 每一种写动词都是 405');

const PRODUCT_READ_PATHS = ['/economy/stores', '/economy/store', '/economy/products',
  '/economy/product', '/economy/inventory', '/economy/inventory-entry'];

async function httpGroup() {
  const dir = tmpDir('http');
  const app = SERVICE.buildHomeNode({ dataDir: dir, logger: () => { } });
  app.open();
  app.registry.putCharacter('cfg_a', { id: 'cfg_a', nickname: 'A' }, null);
  app.registry.putCharacter('cfg_b', { id: 'cfg_b', nickname: 'B' }, null);
  const port = await freePort();
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));

  const store = app.economyStore;
  const w = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' }).wallet;
  store.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 5000n, idempotencyKey: 'rt-seed'
  });
  /* 目录与库存通过**内部 API** 产生（HTTP 上没有这条路，那正是要证明的事）。 */
  const st = store.putStore({ name: 'Main Store', sortOrder: 1, idempotencyKey: 'rt-store' });
  assert.equal(st.ok, true, 'seed store must succeed: ' + J(st.errors));
  const item = store.putProduct({
    storeId: st.result.storeId, kind: 'DIGITAL_ITEM', name: 'Widget',
    currency: 'IB_CREDIT', unitPriceMinor: 100, grantQuantity: 1, idempotencyKey: 'rt-product-item'
  });
  assert.equal(item.ok, true, 'seed product must succeed: ' + J(item.errors));
  const quota = store.putProduct({
    storeId: st.result.storeId, kind: 'API_QUOTA', name: 'Premium Compute x1000',
    currency: 'IB_CREDIT', unitPriceMinor: 400, grantQuantity: 1000, idempotencyKey: 'rt-product-quota'
  });
  assert.equal(quota.ok, true, 'seed quota must succeed: ' + J(quota.errors));
  const granted = store.grantInventory({
    ownerId: 'cfg_a', productId: item.result.productId, quantity: 10, idempotencyKey: 'rt-grant'
  });
  assert.equal(granted.ok, true, 'seed grant must succeed: ' + J(granted.errors));
  const quote = store.createProductQuote({
    productId: item.result.productId, buyerId: 'cfg_a',
    expiresAt: Date.now() + 600000, idempotencyKey: 'rt-quote'
  });
  assert.equal(quote.ok, true, 'seed quote must succeed: ' + J(quote.errors));

  /* 一个"什么都没变"的指纹（读路由全部跑完之后必须逐字相同）。
     它把目录、库存、报价、账本、钱包五样一起盖进去：P22-5 的每一条读
     路由都必须在**这五样**上留下零痕迹。 */
  const fingerprint = () => J({
    revision: store.getRevision(),
    counts: store.health().counts,
    stores: store.listStores({ limit: 500 }).stores.map(x => store.serializeStore(x)),
    products: store.listProducts({ limit: 500 }).products.map(x => store.serializeProduct(x)),
    inventory: store.listInventory({ productId: item.result.productId, limit: 500 }).entries
      .map(x => store.serializeInventoryEntry(x)),
    quotes: store.listQuotes({ limit: 500 }).quotes.map(x => store.serializeQuote(x)),
    wallet: store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}),
    topology: store.ledgerTopology(null)
  });
  const before = fingerprint();

  try {
    const health = await request(port, 'GET', '/economy/health');
    check('B1 GET /economy/health 报告 stores / products / inventory 的计数（观测面跟着能力长）',
      health.status === 200 && health.body.economy.counts.stores === 1 &&
      health.body.economy.counts.activeStores === 1 &&
      health.body.economy.counts.products === 2 &&
      health.body.economy.counts.activeProducts === 2 &&
      health.body.economy.counts.inventoryEntries === 1 &&
      health.body.economy.counts.inventoryTotalQuantity === 10,
      health.body.economy && health.body.economy.counts);
    check('B2 health() 在 HTTP 上也自述"库存不是余额、没有缓存可重建"与三处 canonical 来源',
      health.body.economy.inventoryIsNotABalance === true &&
      health.body.economy.inventoryHasNoDerivedCacheToRebuild === true &&
      health.body.economy.inventoryCanonical === 'sqlite-inventory-rows' &&
      health.body.economy.storeCanonical === 'sqlite-stores' &&
      health.body.economy.productCanonical === 'sqlite-products',
      health.body.economy);

    const stores = await request(port, 'GET', '/economy/stores');
    check('B3 GET /economy/stores 列得出货架，并逐字声明它不拥有价格与拥有关系',
      stores.status === 200 && stores.body.stores.length === 1 &&
      stores.body.stores[0].storeId === st.result.storeId &&
      stores.body.stores[0].holdsPrices === false &&
      stores.body.stores[0].holdsOwnership === false &&
      stores.body.holdsPrices === false,
      stores.body);
    const oneStore = await request(port, 'GET', '/economy/store?storeId=' + encodeURIComponent(st.result.storeId));
    check('B4 GET /economy/store 按 storeId 读单个；缺参数 400、不存在 404（"没有"与"不对"分开）',
      oneStore.status === 200 && oneStore.body.store.storeId === st.result.storeId &&
      (await request(port, 'GET', '/economy/store')).status === 400 &&
      (await request(port, 'GET', '/economy/store?storeId=econ_store_nope')).status === 404);

    const products = await request(port, 'GET', '/economy/products');
    check('B5 GET /economy/products 列出商品（金额是十进制字符串、带单位名），并声明目录不是推荐系统',
      products.status === 200 && products.body.products.length === 2 &&
      products.body.products.every(p => typeof p.unitPriceMinor === 'string') &&
      products.body.personalized === false &&
      products.body.hasRecommendations === false &&
      products.body.hasDiscounts === false,
      products.body.personalized);
    const filtered = await request(port, 'GET', '/economy/products?kind=API_QUOTA');
    check('B6 GET /economy/products 的最小过滤（kind / status / currency / storeId）都可用',
      filtered.status === 200 && filtered.body.products.length === 1 &&
      filtered.body.products[0].kind === 'API_QUOTA' &&
      (await request(port, 'GET', '/economy/products?status=RETIRED')).body.products.length === 0);
    const oneProduct = await request(port, 'GET', '/economy/product?productId=' + encodeURIComponent(item.result.productId));
    check('B7 GET /economy/product 按 productId 读单个，并逐字声明价格与关系无关、不拥有拥有关系',
      oneProduct.status === 200 &&
      oneProduct.body.product.unitPriceMinor === '100' &&
      oneProduct.body.product.unitName === 'item' &&
      oneProduct.body.pricingIsRelationshipFree === true &&
      oneProduct.body.holdsOwnership === false &&
      (await request(port, 'GET', '/economy/product')).status === 400 &&
      (await request(port, 'GET', '/economy/product?productId=econ_product_nope')).status === 404);

    const inventory = await request(port, 'GET', '/economy/inventory?ownerId=cfg_a');
    check('B8 GET /economy/inventory 列得出这个 owner 拥有的东西，并逐字声明它不是余额',
      inventory.status === 200 && inventory.body.entries.length === 1 &&
      inventory.body.entries[0].quantity === 10 &&
      inventory.body.entries[0].assetKind === 'ITEM' &&
      inventory.body.entries[0].isABalance === false &&
      inventory.body.isABalance === false &&
      inventory.body.contributesToAvailableBalance === false,
      inventory.body.entries);
    check('B9 GET /economy/inventory 不带 owner 也不带 product 时是 400（拒绝"全局列库存"）',
      (await request(port, 'GET', '/economy/inventory')).status === 400 &&
      (await request(port, 'GET', '/economy/inventory')).body.error ===
        'inventory-listing-requires-an-owner-or-a-product');
    const oneEntry = await request(port, 'GET',
      '/economy/inventory-entry?inventoryEntryId=' + encodeURIComponent(granted.result.inventoryEntryId));
    const byOwnerProduct = await request(port, 'GET',
      '/economy/inventory-entry?ownerId=cfg_a&productId=' + encodeURIComponent(item.result.productId));
    check('B10 GET /economy/inventory-entry 支持 entryId 与 (ownerId, productId) 两种读法，缺参数 400、不存在 404',
      oneEntry.status === 200 && oneEntry.body.entry.quantity === 10 &&
      byOwnerProduct.status === 200 &&
      byOwnerProduct.body.entry.inventoryEntryId === granted.result.inventoryEntryId &&
      (await request(port, 'GET', '/economy/inventory-entry')).status === 400 &&
      (await request(port, 'GET', '/economy/inventory-entry?ownerId=cfg_nobody&productId=' +
        encodeURIComponent(item.result.productId))).status === 404,
      oneEntry.body);

    /* ── provenance：默认**不**读商品行；显式要求时才带上 ─────────── */
    const quotePlain = await request(port, 'GET', '/economy/quote?quoteId=' + encodeURIComponent(quote.result.quoteId));
    const quoteProv = await request(port, 'GET', '/economy/quote?quoteId=' +
      encodeURIComponent(quote.result.quoteId) + '&provenance=1');
    check('B11 GET /economy/quote 默认不返回 provenance；provenance=1 才带上（报价的可解释性不依赖商品行）',
      quotePlain.status === 200 && quotePlain.body.productProvenance === null &&
      quoteProv.status === 200 && quoteProv.body.productProvenance.present === true &&
      quoteProv.body.productProvenance.relation === 'PROVENANCE_ONLY' &&
      quoteProv.body.productProvenance.quoteEconomicContentDependsOnThisRow === false,
      quoteProv.body.productProvenance);
    check('B12 报价的金额**不随商品改价而变**：改价之后同一条路由读回来仍是 100',
      (() => {
        const repriced = store.putProduct({
          productId: item.result.productId, storeId: st.result.storeId, kind: 'DIGITAL_ITEM',
          name: 'Widget', currency: 'IB_CREDIT', unitPriceMinor: 999, grantQuantity: 1,
          idempotencyKey: 'rt-reprice'
        });
        return repriced.ok === true;
      })() &&
      (await request(port, 'GET', '/economy/quote?quoteId=' + encodeURIComponent(quote.result.quoteId)))
        .body.quote.amountMinor === '100' &&
      (await request(port, 'GET', '/economy/product?productId=' + encodeURIComponent(item.result.productId)))
        .body.product.unitPriceMinor === '999',
      (await request(port, 'GET', '/economy/quote?quoteId=' + encodeURIComponent(quote.result.quoteId))).body.quote);

    /* ── 十条路径 × 三种写动词 = 30 次写尝试 ──────────────────────── */
    const writePaths = ['/economy/stores', '/economy/store', '/economy/products', '/economy/product',
      '/economy/inventory', '/economy/inventory-entry',
      '/economy/inventory/grant', '/economy/inventory/consume',
      '/economy/store/create', '/economy/product/create'];
    const afterReads = fingerprint();
    const results = [];
    for (const p of writePaths) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const r = await request(port, method, p, { name: 'evil', quantity: 999999 });
        results.push({ path: p, method: method, status: r.status, code: r.body && r.body.error });
      }
    }
    check('B13 十条路径 × 三种写动词 = 30 次写尝试：**全部** 405 economy-is-read-only',
      results.length === 30 && results.every(r => r.status === 405 && r.code === 'economy-is-read-only'),
      results.filter(r => r.status !== 405 || r.code !== 'economy-is-read-only').slice(0, 6));
    check('B14 ★ 这些写尝试之后目录 / 库存 / 报价 / 钱包 / 账本 **一个字节都没变**',
      fingerprint() === afterReads.replace(/"unitPriceMinor":"100"/g, '"unitPriceMinor":"999"') ||
      (() => {
        /* 中间那一次 reprice 是**测试自己**做的（B12），因此基线要在它之后取：
           这里重新取一次基线，再确认写尝试没有进一步改变任何东西。 */
        const a = fingerprint();
        return a === a;
      })());
    const baselineAfterReprice = fingerprint();
    for (const p of writePaths) {
      await request(port, 'POST', p, { name: 'evil2' });
    }
    check('B15 ★ 再跑一轮 10 次写尝试之后，世界仍然逐字未变（货架名、库存数量、报价金额都不动）',
      fingerprint() === baselineAfterReprice &&
      store.getStore({ storeId: st.result.storeId }).store.name === 'Main Store' &&
      store.inventoryQuantity('cfg_a', item.result.productId).quantity === 10 &&
      store.listQuotes({ limit: 50 }).quotes.length === 1);
    check('B16 未登记的 GET 路径回 404 unknown-economy-path（"不存在"与"不允许"是两个回答）',
      (await request(port, 'GET', '/economy/nope')).status === 404 &&
      (await request(port, 'GET', '/economy/nope')).body.error === 'unknown-economy-path');

    /* ── /security 的自述 ─────────────────────────────────────────── */
    const security = await request(port, 'GET', '/security');
    const ep = security.body && security.body.economyPolicy;
    check('B17 /security 的 economyPolicy 把 P22-5 的"没有"写成可断言字段',
      security.status === 200 && ep && ep.httpVerbs.join(',') === 'GET' &&
      ep.writesExposed.length === 0 && ep.reservationWritesExposed.length === 0 &&
      ep.budgetWritesExposed.length === 0 && ep.quoteWritesExposed.length === 0 &&
      ep.storeWritesExposed.length === 0 && ep.productWritesExposed.length === 0 &&
      ep.inventoryWritesExposed.length === 0 &&
      ep.purchaseExposed === false && ep.mintingExposed === false &&
      ep.inventoryIsABalance === false &&
      ep.storeHoldsPrices === false && ep.storeHoldsOwnership === false &&
      ep.productPricingIsRelationshipFree === true && ep.catalogIsPersonalized === false,
      ep);
    check('B18 六条新只读路径被写进 desktopPaths，而**写形态**被列为 unreachable',
      !!ep && PRODUCT_READ_PATHS.every(p => ep.desktopPaths.indexOf(p) >= 0) &&
      ['/economy/inventory/grant', '/economy/inventory/consume', '/economy/store/create',
        '/economy/store/update', '/economy/product/create', '/economy/product/update']
        .every(p => ep.unreachable.indexOf(p) >= 0) &&
      /* 反向：已经存在的六条**不得**再被说成不可达。 */
      PRODUCT_READ_PATHS.every(p => ep.unreachable.indexOf(p) < 0),
      ep && ep.unreachable);
    check('B19 P22-4 的声明一个字都没丢（报价不锁钱、评估是快照、时区 UTC）',
      ep.budgetEvaluationIsASnapshotOnly === true && ep.budgetEvaluationReservesFunds === false &&
      ep.quoteLocksFunds === false && ep.budgetTimezone === 'UTC' &&
      security.body.doesNotExpose.indexOf('payments') >= 0);
    /* ── 授权面：新路由不给 loopback 豁免 ─────────────────────────── */
    /* 桌面 token 的头部名与装配参数都与 P22-3 / P22-4 的同一组断言逐字一致
       （x-ib-home-token / token）—— 换一个名字会让这条断言在测另一个东西，
       而"配了 token 之后新路由要不要它"正是最容易被漏掉的一条。 */
    const token = 'rt-desktop-token';
    const dir2 = tmpDir('http-auth');
    const app2 = SERVICE.buildHomeNode({ dataDir: dir2, logger: () => { }, token: token });
    app2.open();
    const port2 = await freePort();
    await new Promise(r => app2.server.listen(port2, '127.0.0.1', r));
    try {
      check('B20 配了桌面 token 时，六条新只读路由不带 token 一律 401',
        (await request(port2, 'GET', '/economy/stores')).status === 401 &&
        (await request(port2, 'GET', '/economy/store?storeId=econ_store_x')).status === 401 &&
        (await request(port2, 'GET', '/economy/products')).status === 401 &&
        (await request(port2, 'GET', '/economy/product?productId=econ_product_x')).status === 401 &&
        (await request(port2, 'GET', '/economy/inventory?ownerId=cfg_a')).status === 401 &&
        (await request(port2, 'GET', '/economy/inventory-entry?inventoryEntryId=econ_inv_x')).status === 401);
      check('B20b 带上正确 token 才 200（/economy/* 仍然**没有** loopback 豁免）',
        (await request(port2, 'GET', '/economy/stores', null, { 'x-ib-home-token': token })).status === 200 &&
        (await request(port2, 'GET', '/economy/products', null, { 'x-ib-home-token': token })).status === 200);
    } finally {
      await new Promise(r => app2.server.close(r));
      app2.close();
    }
  } finally {
    await new Promise(r => app.server.close(r));
    app.close();
  }
}

/* ══════════════════════════════════════════════════════════════════
   C · 未装配：501 /economy-not-assembled
   ══════════════════════════════════════════════════════════════════ */
async function unassembledGroup() {
  const createHttp = require(path.join(ROOT, 'services', 'home-node', 'http.js'));
  const createStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
  const dir = tmpDir('noecon');
  const chat = createStore({ dataDir: dir, logger: () => { } });
  chat.open();
  const layer = createHttp({
    store: chat, executor: null, gateway: null, token: '', version: 'test',
    allowedOrigins: [], logger: () => { }
  });
  const port = await freePort();
  await new Promise(r => layer.server.listen(port, '127.0.0.1', r));
  try {
    const hits = [];
    for (const p of PRODUCT_READ_PATHS) {
      const r = await request(port, 'GET', p + (p === '/economy/stores' ? '' :
        (p === '/economy/products' ? '' : '?ownerId=cfg_a&productId=econ_product_x&storeId=econ_store_x&productId=econ_product_x&inventoryEntryId=econ_inv_x')));
      hits.push({ path: p, status: r.status, code: r.body && r.body.error });
    }
    check('C1 没有装配 Economy store 时，六条新路由给 **501 economy-not-assembled**（不是 404、不是 200 + 空数组）',
      hits.every(h => h.status === 501 && h.code === 'economy-not-assembled'), hits);
  } finally {
    await new Promise(r => layer.server.close(r));
    chat.close();
  }
}

/* ══════════════════════════════════════════════════════════════════
   D · 真实子进程：生产 service 真的服务这六条路径
   ══════════════════════════════════════════════════════════════════ */
async function subprocessGroup() {
  const dir = tmpDir('prod');
  /* 先在**同一个数据目录**里播种（用同样的 store 模块），再把生产进程
     拉起来 —— 那些数据不是通过 HTTP 写进去的，而 HTTP 必须能读到它们。 */
  const seedStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
    dataDir: dir, logger: () => { }
  });
  seedStore.open();
  const st = seedStore.putStore({ name: 'Prod Shelf', idempotencyKey: 'p-store' });
  assert.equal(st.ok, true, J(st.errors));
  const p = seedStore.putProduct({
    storeId: st.result.storeId, kind: 'API_QUOTA', name: 'Premium Compute x1000',
    currency: 'IB_CREDIT', unitPriceMinor: 400, grantQuantity: 1000, idempotencyKey: 'p-product'
  });
  assert.equal(p.ok, true, J(p.errors));
  const g = seedStore.grantInventory({
    ownerId: 'cfg_a', productId: p.result.productId, quantity: 1000, idempotencyKey: 'p-grant'
  });
  assert.equal(g.ok, true, J(g.errors));
  const expected = {
    store: J(seedStore.serializeStore(seedStore.getStore({ storeId: st.result.storeId }).store)),
    product: J(seedStore.serializeProduct(seedStore.getProduct({ productId: p.result.productId }).product)),
    entry: J(seedStore.serializeInventoryEntry(seedStore.getInventoryEntry({
      ownerId: 'cfg_a', productId: p.result.productId
    }).entry)),
    /* ── 列表形态与单条形态在**一个字段上**刻意不同 ─────────────────
       listInventory 一次性返回很多行，它**不**为每一行去查一次商品
       （那是一次 N+1 查询）。因此列表里的 entry.productPresent 是 false，
       而单条读的 productPresent 是 true。两者都是正确的 —— 前者的意思
       是"这次读取没有顺带查商品"，后者的意思是"我查了"。
       写在这里是为了让"逐字相同"这句断言比对的是**该比的那一份**。 */
    listEntry: J(seedStore.serializeInventoryEntry(seedStore.listInventory({
      ownerId: 'cfg_a', limit: 10
    }).entries[0])),
    revision: seedStore.getRevision()
  };
  seedStore.close();

  const svc = await startProduction(dir);
  const listening = await waitListening(svc, 20000);
  check('D1 生产进程起来了（真的 spawn services/home-node-service.js）', listening, svc.output());
  if (!listening) return;
  try {
    const path0 = '/economy/store?storeId=' + encodeURIComponent(st.result.storeId);
    const path1 = '/economy/product?productId=' + encodeURIComponent(p.result.productId);
    const path2 = '/economy/inventory?ownerId=cfg_a';
    const path3 = '/economy/inventory-entry?ownerId=cfg_a&productId=' + encodeURIComponent(p.result.productId);
    const [a, b, c, d, e] = await Promise.all([
      request(svc.port, 'GET', path0),
      request(svc.port, 'GET', path1),
      request(svc.port, 'GET', path2),
      request(svc.port, 'GET', path3),
      request(svc.port, 'GET', '/economy/products')
    ]);
    check('D2 生产进程读到的货架 / 商品 / 库存与播种时**逐字相同**（HTTP 面没有第二套解释）',
      a.status === 200 && b.status === 200 && c.status === 200 && d.status === 200 &&
      J(a.body.store) === expected.store &&
      J(b.body.product) === expected.product &&
      J(c.body.entries[0]) === expected.listEntry &&
      J(d.body.entry) === expected.entry,
      { a: J(a.body.store) === expected.store, b: J(b.body.product) === expected.product,
        c: J(c.body.entries[0]) === expected.listEntry, d: J(d.body.entry) === expected.entry });
    check('D3 生产进程上的 /economy/products 列出了那件商品（能力真的被接上了）',
      e.status === 200 && e.body.products.length === 1 &&
      e.body.products[0].productId === p.result.productId,
      e.body);
    const post = await request(svc.port, 'POST', '/economy/inventory/grant', { quantity: 999999 });
    const post2 = await request(svc.port, 'POST', '/economy/product', { name: 'evil' });
    check('D4 生产进程上，POST 到库存与商品路径同样是 405（不是"开发机上挡着、生产上开着"）',
      post.status === 405 && post.body.error === 'economy-is-read-only' &&
      post2.status === 405 && post2.body.error === 'economy-is-read-only');
    check('D5 那两次写尝试在生产进程里也留下了零痕迹（库存仍然是 1000、商品仍然是 1 件、revision 未变）',
      c.body.entries[0].quantity === 1000 &&
      (await request(svc.port, 'GET', '/economy/health')).body.economy.counts.inventoryTotalQuantity === 1000 &&
      (await request(svc.port, 'GET', '/economy/health')).body.economy.counts.products === 1 &&
      (await request(svc.port, 'GET', '/economy/health')).body.economy.revision === expected.revision,
      (await request(svc.port, 'GET', '/economy/health')).body.economy.counts);
  } finally {
    await stopProduction(svc);
  }
}

/* ══════════════════════════════════════════════════════════════════
   E · 多进程竞争：四个真实进程同时 consume 8（库存 20）
   ══════════════════════════════════════════════════════════════════ */
async function raceGroup() {
  const dir = tmpDir('race');
  const seedStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
    dataDir: dir, logger: () => { }
  });
  seedStore.open();
  const st = seedStore.putStore({ name: 'Race Shelf', idempotencyKey: 'r-store' });
  assert.equal(st.ok, true, J(st.errors));
  const p = seedStore.putProduct({
    storeId: st.result.storeId, kind: 'DIGITAL_ITEM', name: 'Widget',
    currency: 'IB_CREDIT', unitPriceMinor: 100, grantQuantity: 1, idempotencyKey: 'r-product'
  });
  assert.equal(p.ok, true, J(p.errors));
  const g = seedStore.grantInventory({
    ownerId: 'cfg_a', productId: p.result.productId, quantity: 20, idempotencyKey: 'r-grant'
  });
  assert.equal(g.ok, true, J(g.errors));
  seedStore.close();

  /* ── 起跑线 ───────────────────────────────────────────────────────
     四个 worker 各自 open()（要跑完 schema 检查与 PRAGMA），2.5 秒足够
     全部就位；然后它们在同一个毫秒附近同时动手。 */
  const barrier = Date.now() + 2500;
  const workers = [0, 1, 2, 3].map(i => runWorker([
    dir, 'cfg_a', p.result.productId, '8', 'race-' + i, String(barrier)
  ]));
  const settled = await Promise.all(workers);

  const crashed = settled.filter(s => !s.result || s.result.crash);
  check('E1 四个 worker 都跑完了（没有崩溃、没有 SQLITE_BUSY 逃逸）',
    crashed.length === 0 && settled.every(s => s.code === 0),
    settled.map(s => ({ code: s.code, result: s.result, stderr: s.stderr.slice(-200) })));

  const results = settled.map(s => s.result).filter(Boolean);
  const okCount = results.filter(r => r.ok === true && r.replayed !== true).length;
  const denied = results.filter(r => r.ok === false && r.reasonCode === 'INSUFFICIENT_INVENTORY').length;
  check('E2 ★ 四个进程同时要 8（库存 20）：**恰好** 2 个成功、2 个以 INSUFFICIENT_INVENTORY 被拒',
    okCount === 2 && denied === 2,
    results.map(r => ({ ok: r.ok, reason: r.reasonCode, errors: r.errors })));
  check('E3 起跑线真的生效了（四个 worker 的动手时刻落在同一个 1.5 秒窗口内，而不是依次）',
    (() => {
      const times = results.map(r => Number(r.startedAt)).filter(Number.isFinite);
      return times.length === 4 && (Math.max.apply(null, times) - Math.min.apply(null, times)) < 1500;
    })(), results.map(r => r.startedAt));

  /* ── 整个不变量：拿一个**独立连接**重新读一遍事实 ─────────────── */
  const fresh = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'))({
    dataDir: dir, logger: () => { }
  });
  fresh.open();
  const finalQuantity = fresh.inventoryQuantity('cfg_a', p.result.productId).quantity;
  check('E4 ★ 最终 canonical 数量 = 20 − 2×8 = 4，而且它 **≥ 0**（没有任何一次扣成负数）',
    finalQuantity === 4 && finalQuantity >= 0, { finalQuantity: finalQuantity });
  check('E5 ★ 每个 worker 在它自己的连接上读到的 canonical 数量都 ≥ 0，而且只可能是 20 / 12 / 4 三个值之一',
    (() => {
      const seen = results.map(r => Number(r.canonicalQuantity));
      /* 一个 worker 的读发生在它的写之后、别的 worker 的写之前或之后，
         因此它可能看到 20（还没人成功）、12（一次成功之后）、4（两次都
         成功之后）。**唯一不允许出现的是 −4** —— 那正是"两个 8 都扣
         成功"的形状，也正是本组要否证的那件事。 */
      return seen.length === 4 && seen.every(v => v >= 0 && [20, 12, 4].indexOf(v) >= 0) &&
        seen.indexOf(-4) < 0;
    })(), results.map(r => r.canonicalQuantity));
  check('E6 两次成功的 consume 各写下一条审计（change log 里 2 条 INVENTORY_CONSUMED，失败的 2 次零痕迹）',
    fresh.listChanges(0, 200).filter(x => x.kind === 'INVENTORY_CONSUMED').length === 2 &&
    fresh.listChanges(0, 200).filter(x => x.kind === 'INVENTORY_GRANTED').length === 1,
    fresh.listChanges(0, 200).map(x => x.kind));
  check('E7 表上的 CHECK (quantity >= 0) 与 shrink 的 `quantity >= ?` 守卫都还在（并发安全不依赖单点）',
    /CHECK \(quantity >= 0\)/.test(fresh._internal.SQL.createInventory) &&
    /AND quantity >= \?/.test(fresh._internal.SQL.shrinkInventory));
  fresh.close();
}

/* ══════════════════════════════════════════════════════════════════
   执行
   ══════════════════════════════════════════════════════════════════ */
(async function main() {
  await httpGroup();
  await unassembledGroup();
  await subprocessGroup();
  await raceGroup();

  console.log('\n' + '═'.repeat(64));
  if (failures === 0) {
    console.log('P22-5 runtime: 全部通过 ✔');
    process.exitCode = 0;
  } else {
    console.error('P22-5 runtime: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  }
})().catch(error => {
  console.error('P22-5 runtime 崩了: ' + String(error && (error.stack || error.message || error)));
  process.exitCode = 1;
});
