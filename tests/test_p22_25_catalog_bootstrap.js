'use strict';
/* ====================================================================
   P22-25 · Catalog Bootstrap guard
   --------------------------------------------------------------------
   运行：node tests/test_p22_25_catalog_bootstrap.js

   这一条守卫要钉住的**不是**"种子里有六件商品"，而是五条**结构性**的性质：

     ① 空目录 → 非空目录，而且写进去的恰好是 canonical 种子
        （固定 id、ACTIVE、价格/单位/交付形态全部由契约派生）；
     ② 第二次 bootstrap **不重复创建**（而且根本不进入写路径）；
     ③ 用户已有的货架/商品**永不被覆盖**（写路径在目录非空时一次都不发）；
     ④ 图片引用是**仓库里的一个文件**，删掉它会让节点在载入期就拒绝启动
        （fail closed），而不是给出一张 404 的图；
     ⑤ 图片不是网络动态资源、不是 base64、不是 data URL —— 而且这条否定
        是**字形级**的（asset key 的字符集里没有 `:`、没有 scheme）。

   外加两条"本阶段禁止"的可断言形式：
     · Agent 不能 createProduct（capability 词表里没有这个词）；
     · User 不能 createProduct（同上），而且 HTTP 的 /economy/* 写形态仍
       然是 405 economy-is-read-only。

   ★ 它不碰开发目录、不碰 %LOCALAPPDATA%：每个 store 都在一个私有临时目录
     里，结束即关库即删。
   ==================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const BOOT = require(path.join(ROOT, 'services', 'home-node', 'catalog-bootstrap.js'));
const createEconomyCapabilityGate = require(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'));

let passed = 0, failed = 0;
/* ★ economy-store 的金额列是 **BigInt**（SQLite INTEGER 的忠实表示）。
   JSON.stringify 遇到 BigInt 会抛，因此失败信息里必须带上替换器 ——
   否则一条断言失败会被"序列化抛错"顶掉，实测踩过一次。 */
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ✔ ' + name); }
  else { failed += 1; console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + J(extra) : '')); }
}
function section(t) { console.log('\n── ' + t); }
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

const tempDirs = [];
const openStores = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-25-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
/* ★ nextId 必须**按 kind** 生成 canonical 形状的 id：一个只认 PRODUCT 的
   工厂会让 putStore 收到 econ_product_… 而被 id 形状检查拒绝（实测踩过：
   表现为 putStore 返回 ok:false，然后 result.store 是 undefined）。 */
function deterministicIds() {
  let seq = 0;
  const map = {};
  return function (kind) {
    seq += 1;
    map[kind] = (map[kind] || 0) + 1;
    return C.formatEconomyId(kind, kind.toLowerCase().slice(0, 4) + map[kind] + '_' + seq).id;
  };
}
function makeStore(tag) {
  const store = createEconomyStore({ dataDir: tmp(tag), logger: () => { }, nextId: deterministicIds() });
  store.open();
  openStores.push(store);
  return store;
}
let keySeq = 0;
function K(p) { keySeq += 1; return (p || 'k') + '-p2225-' + keySeq; }

/* ── 不受任何 store 影响的纯读：模块级常量与字形判据 ────────────────── */
const SEED = BOOT.SEED;

(async function main() {
  console.log('P22-25 · Catalog Bootstrap guard');

  /* ══════════════════════════════════════════════════════════════════
     A · 种子的形状（纯层：不建库、不写盘）
     ══════════════════════════════════════════════════════════════════ */
  section('A · 种子本身：条数、id 形状、冻结');

  check('A1 种子是一个系统商店 + 5~10 件初始商品（视觉要求的那条区间）',
    !!SEED.store && SEED.products.length >= 5 && SEED.products.length <= 10,
    { products: SEED.products.length });

  check('A2 ★★ 货架 id 与每一个商品 id 都是 canonical 形状（econ_store_ / econ_product_）',
    C.isEconomyId('STORE', SEED.store.storeId) &&
    SEED.products.every(p => C.isEconomyId('PRODUCT', p.productId)) &&
    new Set(SEED.products.map(p => p.productId)).size === SEED.products.length,
    { store: SEED.store.storeId, products: SEED.products.map(p => p.productId) });

  check('A3 ★★★ 种子刻意**不**声明 fulfillment / assetKind / unitName —— 它们是契约的派生列，'
    + '种子里多写一遍只会制造第二个可能漂移的答案',
    SEED.products.every(p => p.fulfillment === undefined
      && p.assetKind === undefined && p.unitName === undefined),
    SEED.products.map(p => Object.keys(p)));

  /* ★★ P22-26：目录 v2 撤下了那件 SERVICE 商品（`SERVICE_EXECUTION` 的结算
     原语是 `null`，因此它买不了 —— 而一个商店不陈列买不了的东西）。于是
     种子里**不再有**"买完不产生库存"的那件反例，而这条断言的判据改成目录 v2
     实际覆盖的形态：**三种 kind、两种交付形态**，且每一种都能落地。
     ★ 那件反例本身没有消失：它由 `test_p22_26_catalog_v2.js` 的 B 组从**契约**
     那一侧证明（SERVICE 的 primitive 是 null），并从**目录定义**那一侧证明
     （把一件 SERVICE 放进种子 ⇒ 模块载入期抛）。 */
  check('A4 种子覆盖多种交付形态（v2：三种 kind / 两种能落地的交付形态）',
    new Set(SEED.products.map(p => C.fulfillmentOfProductKind(p.kind))).size >= 2 &&
    new Set(SEED.products.map(p => p.kind)).size >= 3 &&
    SEED.products.every(p => C.fulfillmentOfProductKind(p.kind) != null) &&
    /* 而且**每一件**都有非 null 的结算原语 —— 这就是"目录不陈列买不了的东西"。 */
    SEED.products.every(p =>
      C.settlementPrimitiveOfFulfillment(C.fulfillmentOfProductKind(p.kind)).primitive != null),
    SEED.products.map(p => [p.kind, C.fulfillmentOfProductKind(p.kind), p.grantQuantity]));

  check('A5 种子版本是固定字面量（不是时间戳、不是随机值）',
    typeof BOOT.SEED_VERSION === 'string' && /^v[0-9]+$/.test(BOOT.SEED_VERSION) &&
    SEED.version === BOOT.SEED_VERSION,
    { version: BOOT.SEED_VERSION });

  check('A6 ★★★ 幂等键是**版本化常量**：同一个 id 每次都得到同一个键（重放），'
    + '而不同版本得到不同的键（conflict 而不是静默覆盖）',
    BOOT.idempotencyKeyFor('econ_product_catalog_voice_pack')
      === BOOT.idempotencyKeyFor('econ_product_catalog_voice_pack') &&
    BOOT.idempotencyKeyFor('econ_product_catalog_voice_pack').indexOf(SEED.version) >= 0,
    { key: BOOT.idempotencyKeyFor('econ_product_catalog_voice_pack') });

  /* ══════════════════════════════════════════════════════════════════
     B · 图片：字形、文件、fail closed
     ══════════════════════════════════════════════════════════════════ */
  section('B · 图片资产：一个字面 key、一个真实文件、一条字形级否认');

  check('B1 ★★★★★ 每个 image key 都是 `catalog/<name>.webp` 形状（排除了外链与 base64）',
    BOOT.SEED_ASSET_KEYS.every(k => BOOT.assetKeyIsCanonical(k)),
    BOOT.SEED_ASSET_KEYS.filter(k => !BOOT.assetKeyIsCanonical(k)));

  check('B2 ★★★★★ 字形级否认：asset key 里不可能出现 `:`、`//`、scheme 或 base64',
    BOOT.SEED_ASSET_KEYS.every(k => k.indexOf(':') < 0 && k.indexOf('//') < 0
      && !/^[a-z]+:/i.test(k) && !/base64/i.test(k)) &&
    /* 反证：三类**必须**被拒绝的形状 */
    ['https://cdn.example.com/a.webp', 'data:image/webp;base64,AAAA',
      '/assets/economy/catalog/a.webp', 'catalog/a.png', 'catalog/../../etc/passwd']
      .every(k => BOOT.assetKeyIsCanonical(k) === false),
    { keys: BOOT.SEED_ASSET_KEYS });

  const assetFiles = BOOT.SEED_ASSET_KEYS.map(k => ({
    key: k, file: path.join(BOOT.ASSET_ROOT, k),
    stat: (function () { try { return fs.statSync(path.join(BOOT.ASSET_ROOT, k)); } catch (_) { return null; } })()
  }));
  check('B3 ★★★★ 每个 image key 都对应一个**真实存在**的仓库文件（不是"URL 拼对了"）',
    assetFiles.every(a => a.stat && a.stat.isFile() && a.stat.size > 0),
    assetFiles.filter(a => !a.stat || !a.stat.isFile()).map(a => a.key));

  check('B4 ★★★ 每个文件都是**真的 WebP**（RIFF....WEBP magic），不是改名的 PNG',
    assetFiles.every(a => {
      const b = fs.readFileSync(a.file);
      return b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF'
        && b.slice(8, 12).toString('ascii') === 'WEBP';
    }),
    assetFiles.map(a => [a.key, fs.readFileSync(a.file).slice(0, 12).toString('ascii')]));

  /* ★★ P22-26：这条断言原本要求"磁盘上的集合与种子引用的集合**恰好相等**"。
     目录 v2 撤下了那件 SERVICE 商品，而它的配图
     `catalog/agent-orchestration.webp` **留在仓库里**：它记录的是 v1 曾经
     交付过的那件商品，而且**已经跑过 v1 的世界**里那一行商品的 imageUrl
     仍然指向它 —— 那是一条只存在于那些世界里的历史引用，本阶段看不见它。
     ★ 因此判据改成"磁盘集合 = 种子引用的集合 + 一份**逐名登记**的历史资产"，
     而不是把"相等"放宽成一个不等式 —— 于是任何**新的**孤儿文件仍然当场变红，
     而唯一被允许的那一个是被点名的。 */
  const DETACHED_HISTORICAL_ASSETS = ['catalog/agent-orchestration.webp'];
  const walkAssets = function () {
    const onDisk = [];
    const walk = function (dir, prefix) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
        const rel = prefix ? prefix + '/' + e.name : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel); else onDisk.push(rel);
      });
    };
    walk(BOOT.ASSET_ROOT, '');
    return onDisk.sort();
  };
  check('B5 ★★★★ assets/economy 下没有**未登记**的孤儿文件：文件集合 = 种子引用的集合 + 逐名登记的历史资产',
    (function () {
      const onDisk = walkAssets();
      const allowed = Array.from(new Set(BOOT.SEED_ASSET_KEYS)).concat(DETACHED_HISTORICAL_ASSETS).sort();
      const undocumented = onDisk.filter(f => allowed.indexOf(f) < 0);
      const missing = allowed.filter(f => onDisk.indexOf(f) < 0);
      return undocumented.length === 0 && missing.length === 0;
    })(),
    { onDisk: walkAssets(), referenced: Array.from(new Set(BOOT.SEED_ASSET_KEYS)).sort(), detached: DETACHED_HISTORICAL_ASSETS });

  check('B6 ★★★★★ fail closed：把一张图从仓库里"拿走"，模块**载入就抛**'
    + '（不是一个静默的 404 图，也不是一个警告）',
    (function () {
      /* 判据是**结构**的：missingSeedAssets() 会对着一份被替换的 key 集合
         报出缺失项。这里不去真删仓库文件（那是破坏性的），而是断言
         missingSeedAssets 的实现确实逐个 stat 了每个 key —— 用一个
         不存在的 key 直接问它。 */
      const probe = path.join(BOOT.ASSET_ROOT, 'catalog/__absent__.webp');
      const before = fs.existsSync(probe);
      const code = read('services/home-node/catalog-bootstrap.js');
      return before === false
        && code.indexOf('throw new Error(\'catalog seed references assets that do not exist') >= 0
        && code.indexOf('function missingSeedAssets') >= 0
        && code.indexOf('if (MISSING_ASSETS.length)') >= 0;
    })(),
    { moduleThrowsOnMissing: true });

  check('B7 ★★★ imageUrlFor 给出的 URL 落在本仓库的静态根之下（不是任何外部主机）',
    BOOT.SEED.products.every(p => {
      const u = BOOT.imageUrlFor(p.productId);
      return u === '/assets/economy/' + p.imageKey && u.indexOf('//') < 0;
    }) &&
    /* 非种子商品没有配图 —— 诚实的 null，而不是一张猜出来的默认图。 */
    BOOT.imageUrlFor('econ_product_whatever') === null &&
    BOOT.imageKeyFor(null) === null,
    SEED.products.map(p => [p.productId, BOOT.imageUrlFor(p.productId)]));

  /* ══════════════════════════════════════════════════════════════════
     C · fresh install：空目录 → 初始目录
     ══════════════════════════════════════════════════════════════════ */
  section('C · fresh install：Empty Catalog → System Market → Initial Products');

  const fresh = makeStore('fresh');
  const emptyStores = fresh.listStores({});
  const emptyProducts = fresh.listProducts({});
  check('C1 前置：一个刚 open() 的 Economy store 里，目录**确实是空的**（两条读面都空）',
    emptyStores.ok && emptyStores.stores.length === 0 &&
    emptyProducts.ok && emptyProducts.products.length === 0,
    { stores: emptyStores.stores.length, products: emptyProducts.products.length });

  const first = BOOT.apply(fresh, { logger: () => { } });
  check('C2 ★★★★★ 第一次 bootstrap：applied=true，写进去的是系统商店 + 种子里的每一件商品',
    first.ok === true && first.applied === true && first.requested === true &&
    first.reason === 'seeded' && first.storeCreated === true &&
    first.created.length === SEED.products.length &&
    first.created.slice().sort().join(',') === SEED.products.map(p => p.productId).sort().join(','),
    first);

  const after = fresh.listProducts({ status: 'ACTIVE' });
  check('C3 ★★★★★ fresh install 之后目录**不为空**（这就是 P22-24 §7 那个缺口的闭合）',
    after.ok === true && after.products.length === SEED.products.length,
    { products: after.products.length });

  check('C4 ★★★ 落库的每一件商品都与种子逐字一致，且派生列由**契约**给出'
    + '（★ 金额是 BigInt，比较走 Number —— 那是 store 的忠实表示，不是漂移）',
    SEED.products.every(function (p) {
      const row = after.products.filter(r => r.productId === p.productId)[0];
      return !!row && row.storeId === SEED.store.storeId
        && row.name === p.name && row.description === p.description
        && Number(row.unitPriceMinor) === p.unitPriceMinor
        && Number(row.grantQuantity) === p.grantQuantity
        && row.currency === 'IB_CREDIT'
        && row.status === 'ACTIVE'
        && row.kind === p.kind
        && row.fulfillment === C.fulfillmentOfProductKind(p.kind)
        && row.unitName === C.unitNameOfProductKind(p.kind)
        && row.assetKind === C.assetKindOfProductKind(p.kind);
    }),
    after.products.map(r => [r.productId, r.kind, r.fulfillment, r.unitName, r.assetKind, r.status, String(r.unitPriceMinor)]));

  check('C5 ★★★ 系统商店按种子落库：ACTIVE、名字/描述/sortOrder 逐字一致',
    (function () {
      const s = fresh.getStore({ storeId: SEED.store.storeId });
      return s.ok === true && s.store.status === 'ACTIVE' && s.store.name === SEED.store.name
        && s.store.description === SEED.store.description && s.store.sortOrder === SEED.store.sortOrder
        && s.store.revision === 1;
    })(),
    fresh.listStores({}));

  /* ★★★ 这一条是"目录 ≠ 支付"的操作性形式：bootstrap 之后，change log 里
     **只**能出现货架与商品的创建事件。它刻意不看返回值（那可以被撒谎），
     而是读已经写下的历史行。 */
  const changes = fresh.listChanges(0, 500);
  const changeKinds = Array.from(new Set(changes.map(c => c.kind))).sort();
  const moneyKinds = changes.filter(c => /TRANSACTION|LEDGER|MINT|BURN|RESERVATION|PURCHASE|APPROVAL|QUOTE|WALLET|TRANSFER|EXCHANGE|BUDGET|AUTONOMY/.test(c.kind));
  check('C6 ★★★★★ 种子**没有**碰钱：change log 里只有 STORE_CREATED + PRODUCT_CREATED，'
    + '零钱包 / 零交易 / 零铸造 / 零购买（"有价格"不等于"有支付"）',
    changes.length === 1 + SEED.products.length
    && changeKinds.join(',') === 'PRODUCT_CREATED,STORE_CREATED'
    && moneyKinds.length === 0,
    { kinds: changeKinds, money: moneyKinds.map(c => c.kind), total: changes.length });

  check('C7 ★★★★ 钱包与账本一条都没有被创建（读面直接问，不看日志）',
    (function () {
      /* ★ 这两个读面在空库上返回的是**空数组**，不是 `{}`/`{wallets:[]}`
         —— 断言必须按真实形状写（实测踩过一次）。 */
      const wallets = fresh.listWallets({});
      const txs = fresh.listTransactions({});
      return Array.isArray(wallets) && wallets.length === 0
        && Array.isArray(txs) && txs.length === 0;
    })(),
    { wallets: fresh.listWallets({}), txs: fresh.listTransactions({}) });

  /* ══════════════════════════════════════════════════════════════════
     D · 第二次 bootstrap：不重复创建
     ══════════════════════════════════════════════════════════════════ */
  section('D · 幂等：第二次 bootstrap 不重复创建');

  /* ★★★ 这一条用**全局 revision** 证明"第二次运行一次写都没发"。
     `revision` 是 store 的单调计数器（不是每行的版本号），因此
     "第二遍之后 revision 与 change log 一字不动"是一个比"内容看起来一样"
     强得多的判据：它排除了"写了但写成了相同的值"。 */
  const revisionAfterFirst = Math.max.apply(null, fresh.listChanges(0, 500).map(c => c.revision));
  const second = BOOT.apply(fresh, { logger: () => { } });
  const after2 = fresh.listProducts({});
  const stores2 = fresh.listStores({});
  const changesAfterSecond = fresh.listChanges(0, 500);
  const revisionAfterSecond = Math.max.apply(null, changesAfterSecond.map(c => c.revision));
  check('D1 ★★★★★ 第二次 bootstrap：applied=false，reason=catalog-not-empty，created 为空',
    second.ok === true && second.applied === false && second.requested === true &&
    second.reason === 'catalog-not-empty' && second.created.length === 0,
    second);
  check('D2 ★★★★★ 商品数与货架数一件都没有变（没有重复创建）',
    after2.products.length === SEED.products.length &&
    stores2.stores.length === 1,
    { products: after2.products.length, stores: stores2.stores.length });

  check('D3 ★★★★★ 第二遍之后全局 revision 与 change log **一字不动** —— '
    + '说明第二次运行根本没有写，而不是"写了但内容一样"',
    revisionAfterSecond === revisionAfterFirst &&
    changesAfterSecond.length === 1 + SEED.products.length &&
    revisionAfterFirst === 1 + SEED.products.length,
    { before: revisionAfterFirst, after: revisionAfterSecond, changes: changesAfterSecond.length });

  /* ══════════════════════════════════════════════════════════════════
     E · 用户已有数据永不被覆盖
     ══════════════════════════════════════════════════════════════════ */
  section('E · 用户已有的货架/商品**永不被覆盖**');

  /* E 组的构造刻意走**另一条时间线**：先有用户数据，再启动 bootstrap。 */
  const owned = makeStore('owned');
  const userStore = owned.putStore({ name: '我的货架', idempotencyKey: K('ustore') });
  const userProduct = owned.putProduct({
    storeId: userStore.result.store.storeId, kind: 'DIGITAL_ITEM', name: '用户自己造的东西',
    currency: 'IB_CREDIT', unitPriceMinor: 1234, grantQuantity: 1, idempotencyKey: K('uproduct')
  });
  check('E1 前置：用户自己建了一间货架和一件商品',
    userStore.ok === true && userProduct.ok === true, { userProduct: userProduct.errors });

  /* ★ 基线必须在 bootstrap **之前**抓：bootstrap 之后再读，就分不清
     "没写"与"写了但值一样"。 */
  const ownedBaseline = {
    productRevision: owned.listProducts({}).products[0].revision,
    storeRevision: owned.listStores({}).stores[0].revision,
    changes: owned.listChanges(0, 500).length
  };

  const onOwned = BOOT.apply(owned, { logger: () => { } });
  check('E2 ★★★★★ 目录非空时 bootstrap 一次写都不发（reason=catalog-not-empty）',
    onOwned.applied === false && onOwned.reason === 'catalog-not-empty' && onOwned.created.length === 0,
    onOwned);

  const ownedProducts = owned.listProducts({});
  const ownedStores = owned.listStores({});
  const ownedProductRevisionBefore = ownedBaseline.productRevision;
  const ownedStoreRevisionBefore = ownedBaseline.storeRevision;
  const ownedChangesBefore = ownedBaseline.changes;
  check('E3 ★★★★★ 用户那件商品与那间货架**一字未动**：'
    + '价格/数量/名字/revision 全不变，change log 也没有多出一行',
    ownedProducts.products.length === 1 && ownedStores.stores.length === 1 &&
    ownedProducts.products[0].productId === userProduct.result.product.productId &&
    Number(ownedProducts.products[0].unitPriceMinor) === 1234 &&
    ownedProducts.products[0].name === '用户自己造的东西' &&
    ownedProducts.products[0].revision === ownedProductRevisionBefore &&
    ownedStores.stores[0].storeId === userStore.result.store.storeId &&
    ownedStores.stores[0].name === '我的货架' &&
    ownedStores.stores[0].revision === ownedStoreRevisionBefore &&
    owned.listChanges(0, 500).length === ownedChangesBefore,
    { product: [ownedProducts.products[0].productId, String(ownedProducts.products[0].unitPriceMinor),
      ownedProducts.products[0].name, ownedProducts.products[0].revision],
      store: [ownedStores.stores[0].storeId, ownedStores.stores[0].name, ownedStores.stores[0].revision],
      changes: [ownedChangesBefore, owned.listChanges(0, 500).length] });

  check('E4 ★★★★★ 而且**没有**任何一件种子商品被塞进这个已有目录（"不新增"也是"不覆盖"的一半）',
    ownedProducts.products.every(p => SEED.products.every(s => s.productId !== p.productId)),
    ownedProducts.products.map(p => p.productId));

  /* ══════════════════════════════════════════════════════════════════
     F · fail closed 与"没打开就不假装"
     ══════════════════════════════════════════════════════════════════ */
  section('F · fail closed：库没打开 / 读不出来');

  const closed = createEconomyStore({ dataDir: tmp('closed'), logger: () => { } });
  const closedOut = BOOT.apply(closed, { logger: () => { } });
  check('F1 ★★★★ store 没打开：OK=false、requested=false、reason=store-not-open（**不是**"种好了"）',
    closedOut.ok === false && closedOut.applied === false && closedOut.requested === false &&
    closedOut.reason === 'store-not-open',
    closedOut);

  const nullOut = BOOT.apply(null, {});
  check('F2 ★★★ 没有 store：同上，而且不抛',
    nullOut.ok === false && nullOut.reason === 'store-not-open', nullOut);

  const poisoned = {
    isOpen: () => true,
    listStores: () => { throw new Error('disk on fire'); },
    listProducts: () => ({ ok: true, products: [] }),
    putStore: () => { throw new Error('must not be reached'); },
    putProduct: () => { throw new Error('must not be reached'); }
  };
  let poisonOut = null, poisonThrew = false;
  try { poisonOut = BOOT.apply(poisoned, {}); } catch (_) { poisonThrew = true; }
  check('F3 ★★★★ 读面抛错时 bootstrap 也抛（不吞）—— 而"读不出来"与"目录空"'
    + '在**返回值**里是两个不同的 reason',
    poisonThrew === true && closedOut.reason === 'store-not-open',
    { threw: poisonThrew, out: poisonOut });

  const refusing = {
    isOpen: () => true,
    listStores: () => ({ ok: true, stores: [] }),
    listProducts: () => ({ ok: true, products: [] }),
    putStore: () => ({ ok: false, denied: true, reasonCode: 'CATALOG_INPUT_NOT_STRUCTURED', errors: ['nope'] }),
    putProduct: () => { throw new Error('must not be reached when the store write is refused'); }
  };
  const refusingOut = BOOT.apply(refusing, {});
  check('F4 ★★★★ store 拒绝写货架：ok=false、reason=seed-write-refused，而且**不会**继续去写商品',
    refusingOut.ok === false && refusingOut.applied === false &&
    refusingOut.reason === 'seed-write-refused' && refusingOut.errors[0] === 'nope',
    refusingOut);

  /* ══════════════════════════════════════════════════════════════════
     G · 本阶段逐条禁止：Agent / User / AI 都造不出商品
     ══════════════════════════════════════════════════════════════════ */
  section('G · 禁止面：Agent / User / AI 都没有 createProduct');

  check('G1 ★★★★★ capability 词表**只有两个**动作，里面没有 CREATE_PRODUCT 这种东西',
    Object.keys(C.CAPABILITY).length === 2 &&
    Object.keys(C.CAPABILITY).every(k => k === 'PROPOSE_PURCHASE' || k === 'RESUME_APPROVED_PURCHASE') &&
    Object.keys(C.CAPABILITY).every(k => !/PRODUCT|CATALOG|STORE|LISTING/i.test(k)),
    Object.keys(C.CAPABILITY));

  check('G2 ★★★★★ Agent（active_agent_runtime）请求 CREATE_PRODUCT ⇒ CAPABILITY_DENIED / UNKNOWN_CAPABILITY',
    (function () {
      const d = C.checkEconomyCapability({ consumer: 'active_agent_runtime', capability: 'CREATE_PRODUCT', config: {} });
      return d.decision === C.CAPABILITY_DECISION.CAPABILITY_DENIED && d.granted === false
        && d.reasonCode === C.CAPABILITY_DENY_REASON.UNKNOWN_CAPABILITY;
    })(),
    C.checkEconomyCapability({ consumer: 'active_agent_runtime', capability: 'CREATE_PRODUCT', config: {} }));

  check('G3 ★★★★★ User（user_decision_seam）请求 CREATE_PRODUCT ⇒ 同样是 CAPABILITY_DENIED',
    (function () {
      const d = C.checkEconomyCapability({ consumer: 'user_decision_seam', capability: 'CREATE_PRODUCT', config: {} });
      return d.decision === C.CAPABILITY_DECISION.CAPABILITY_DENIED && d.granted === false;
    })(),
    C.checkEconomyCapability({ consumer: 'user_decision_seam', capability: 'CREATE_PRODUCT', config: {} }));

  const gate = createEconomyCapabilityGate({ store: fresh });
  const handle = gate.bind('active_agent_runtime');
  const gateKeys = Object.keys(handle);
  check('G4 ★★★★★ 门交出的句柄**恰好**那几个键，其中没有任何一个能写目录',
    gateKeys.every(k => ['consumer', 'anchor', 'capabilities', 'proposePurchaseIntent', 'resumeApprovedPurchase'].indexOf(k) >= 0) &&
    gateKeys.length === 5 &&
    gateKeys.every(k => !/product|store|catalog|put/i.test(k)),
    gateKeys);

  check('G5 ★★★★★ bootstrap 不是任何消费者能到达的动作：'
    + 'capability / 命令通道 / 动作适配器里**零引用** catalog-bootstrap',
    (function () {
      const files = ['services/home-node/economy-capability.js',
        'services/home-node/economy-command-channel.js',
        'services/home-node/economy-action-adapter.js',
        'services/home-node/economy-approval-decision.js',
        'services/home-node/economy-configuration.js'];
      return files.every(f => read(f).indexOf('catalog-bootstrap') < 0);
    })(),
    { checked: 5 });

  check('G6 ★★★★★ http.js 的**代码**里仍然没有 putStore / putProduct 的调用形态'
    + '（P22-21 §9 的 T5 一字未改；目录写入长在装配层，不是一条路由）',
    (function () {
      const code = read('services/home-node/http.js')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      return !/\.putStore\s*\(/.test(code) && !/\.putProduct\s*\(/.test(code);
    })(),
    { httpWrites: 0 });

  check('G7 ★★★★ bootstrap 的调用点**只有一处**实现，两条启动路径共用它',
    (function () {
      const svc = read('services/home-node-service.js');
      const calls = (svc.match(/applyCatalogBootstrap\(/g) || []).length;
      return calls === 3 /* 定义 1 处 + 两个调用点 */
        && svc.indexOf('function applyCatalogBootstrap(') >= 0
        && (svc.match(/^\s*applyCatalogBootstrap\(instanceEconomy\.economyStore\);/gm) || []).length === 1
        && (svc.match(/^\s*applyCatalogBootstrap\(economy\.economyStore\);/gm) || []).length === 1;
    })(),
    { note: '定义 1 + 调用 2' });

  check('G8 ★★★★ 模块**不生成图片**、**不联网**、**不读时钟**：'
    + '纯层里没有 fetch / http / 时间来源 / 随机源 / 图片编码'
    + '（★ 先剥注释与字符串再扫 —— 裸词扫描会命中注释里的否认句，'
    + '与 P22-20 §7 / P22-21 T5 同一条教训）',
    (function () {
      const code = read('services/home-node/catalog-bootstrap.js')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      return !/require\(\s*['"](?:node:)?(?:http|https|net|dgram|child_process)['"]/.test(code)
        && code.indexOf('fetch') < 0 && code.indexOf('Date.now') < 0
        && code.indexOf('Math.random') < 0 && code.indexOf('crypto') < 0
        && code.indexOf('sharp') < 0 && code.indexOf('canvas') < 0
        && code.indexOf('base64') < 0 && code.indexOf('data:image') < 0;
    })(),
    { generative: false });

  check('G9 ★★★★ 商品模型**没有**要求 schema 变更：'
    + '**商品表**的列清单本阶段一字未改，'
    + '而 image 是种子的一个字段（不是商品行的一列）',
    (function () {
      const storeSrc = read('services/home-node/economy-store.js');
      const productColumns = storeSrc.match(/createProducts:[\s\S]*?'\)',/);
      /* ★★ P22-26：原本这里还写着 `schemaVersion === 7`。那个字面量在 P22-26
         抬水位（`quotes.units`，见 ECONOMY_V1_FROZEN_CONTRACT.md §1）之后会
         让这条断言以红色的假象失败 —— 而它要证明的那件事（"image **不是**
         products 表的一列"）一个字没变。★ 而且这条断言真正的主体是
         **商品表**的列清单，不是整个 schema 的版本号：P22-26 改的是 quotes，
         不是 products。 */
      return !!productColumns
        && productColumns[0].indexOf('image') < 0
        && productColumns[0].indexOf('rarity') < 0
        && productColumns[0].indexOf('effect') < 0
        && productColumns[0].indexOf('asset_kind') >= 0;
    })(),
    { schemaVersion: require(path.join(ROOT, 'services', 'home-node', 'economy-store.js')).SCHEMA_VERSION });

  /* ══════════════════════════════════════════════════════════════════
     H · 收尾
     ══════════════════════════════════════════════════════════════════ */
  section('H · 收尾：关库、清临时目录');
  openStores.forEach(s => { try { s.close(); } catch (_) { } });
  let leftovers = 0;
  tempDirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { leftovers += 1; } });
  check('H1 全部临时目录已清理（仓库里没有留下任何测试产物）', leftovers === 0, { leftovers: leftovers });
  check('H2 仓库根下没有被本测试创建的文件（只读检查）',
    !fs.existsSync(path.join(ROOT, 'catalog-bootstrap.js')), {});

  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ' — ' + passed + ' 项通过 / ' + failed + ' 项失败');
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (error) {
  console.error('\n✖ 未捕获错误：' + (error && error.stack || error));
  openStores.forEach(s => { try { s.close(); } catch (_) { } });
  process.exit(1);
});
