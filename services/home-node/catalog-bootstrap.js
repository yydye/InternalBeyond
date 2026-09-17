'use strict';

/**
 * P22-25 · catalog-bootstrap.js —— **唯一**的目录 bootstrap authority。
 *
 * ────────────────────────────────────────────────────────────────────────
 * 这个文件回答的问题是 P22-24 §7 留下的那一个：
 *
 *   "写方存在、读面齐备、GUI 只读、无 seed、无 bootstrap ——
 *    那么**谁**把第一件商品放进去？"
 *
 * 答案就是这里，而且是**唯一**一处。
 *
 * ═══ 一 · 它是什么 ═══
 *
 * 一次 canonical 的、幂等的、只在**空目录**上生效的写入：
 *
 *     Empty Catalog → Catalog Bootstrap → System Market → Initial Products
 *
 * 货架与商品是**种子数据**，不是用户数据；因此它们用**固定 id**
 * （econ_store_system_market / econ_product_catalog_*）。固定 id 让三件事
 * 同时成立，而不是靠纪律：
 *
 *   · 第二次 bootstrap 找不到可写的东西（目录已非空）⇒ 不再创建；
 *   · 用户改过的商品**永远不会**被本文件覆盖 —— 因为本文件在目录非空时
 *     一次写都不发，而在目录为空时那些 id 根本不存在；
 *   · 幂等键是版本化的常量（`catalog-seed.v1.<id>`），因此"同一个种子
 *     版本重放"与"另一个版本又要写一遍"在 store 的幂等表里是两件事：
 *     前者 replay，后者 conflict（**拒绝**，而不是静默覆盖）。
 *
 * ═══ 二 · 它不是什么（本阶段逐条禁止）═══════════════════════════════════
 *
 *   · 不是商城后台：本文件没有 HTTP 路由、没有 GUI、没有管理面。
 *   · 不给任何 Agent / 用户 / AI 创建商品的能力：它不是动作、不是通道、
 *     不是 capability（economy-capability.js 一字未改）。
 *   · 不碰钱：本文件只调用 putStore / putProduct，而这两个方法体里
 *     没有一次 commitLedgerTransactionInTx。种子里有**价格**，
 *     但一次购买、一次铸造、一次支付都没有。
 *   · 不新增 merchant / payment / provider 概念。
 *   · 不在运行时生成图片：`image` 只是仓库里一个既有文件的 key。
 *
 * ═══ 三 · 为什么它长在 services/home-node/ 而不是 http.js ══════════════
 *
 * P22-21 §9 的 T5 逐字断言：`http.js` 的**代码**里 28 个 store 写动词
 * 零调用形态（`putStore` / `putProduct` 都在名单上）。那条不变量在本阶段
 * **没有**被放松 —— 因此 bootstrap 不可能、也不允许长在 HTTP 层。
 * 它是一个**装配期**动作：与 economyStore 的 open() 同一步，早于任何
 * 请求。这同时解释了为什么它不是一条路由："把第一件商品放进去"是这个
 * 世界建立时的自我配置，不是任何调用者可以请求的服务。
 *
 * ═══ 四 · 图片生命周期 ══════════════════════════════════════════════════
 *
 *   仓库代码资产            assets/economy/catalog/<name>.webp
 *        ↓  （下面 SEED 里的 image key，字面量，无 base64 / 无 data URL / 无外链）
 *   Catalog seed            image: 'catalog/<name>.webp'
 *        ↓  （imageUrlFor，HTTP 层唯一的取值点）
 *   Product image reference '/assets/economy/catalog/<name>.webp'
 *        ↓
 *   UI render
 *
 * ★ fail closed 的那一条：模块**载入时**逐个核对每个 image key 都对应一个
 *   真实存在的仓库文件（并且在 assets/economy 之内）。种子引用了不存在的
 *   图片，会让 `require` 直接抛 —— 一个坏的目录定义不可能被启动起来，
 *   也不可能悄悄给出一张 404 的图。assets/economy/** 里也**没有**任何
 *   不被种子引用的孤儿文件（反向同一份断言在测试里）。
 */

const fs = require('fs');
const path = require('path');

/* 仓库里图片资产的根（相对仓库根）。HTTP 层引用图片 URL 时只从这里取。 */
const ASSET_ROOT = path.join(__dirname, '..', '..', 'assets', 'economy');
const ASSET_ROOT_URL = '/assets/economy/';

/* 商品 id 的固定后缀规则：小写 + 连字符。它只用于**种子**，因此不需要
   兼容运行期生成的 id 形状（econ_product_<random>）。 */
const ASSET_KEY_RE = /^catalog\/[a-z0-9][a-z0-9-]{0,47}\.webp$/;

function assetKeyIsCanonical(value) {
  /* 三条否认写在一条正则里，而它们是本阶段最容易被绕过的三条：
       · `:` 不可能出现 ⇒ 排除了 data: 与任何带 scheme 的 URL；
       · `/` 只允许那一个分隔符 ⇒ 排除了任何绝对/相对路径与其他目录；
       · 字符集只有 [a-z0-9-] ⇒ 排除了 base64 正文。
     一张"运行时生成的图片"在这个字形下**没有地方可以放**。 */
  return typeof value === 'string' && ASSET_KEY_RE.test(value);
}

/* ── 冻结的种子（版本 v1）──────────────────────────────────────────────
   六个商品覆盖四种交付形态，service 是那个"买完不增加库存"的反例（§27）：
     DIGITAL_ITEM → INVENTORY_GRANT / ITEM       （持有物）
     CONSUMABLE   → INVENTORY_GRANT / ITEM       （消耗品）
     API_QUOTA    → COMPUTE_GRANT   / COMPUTE    （算力）
     SERVICE      → SERVICE_EXECUTION / null     （执行，不持有）
   规格（kind / fulfillment / assetKind / unitName / grantQuantity）由
   economy-contract.js 派生与冻结，这里**不重复声明**它们 —— 一份事实
   只有一个来源，种子里多写一遍只会制造第二个可能漂移的答案。 */
const SEED_VERSION = 'v1';

const SEED = Object.freeze({
  version: SEED_VERSION,
  store: Object.freeze({
    storeId: 'econ_store_system_market',
    name: '系统商店',
    description: '这一域的初始目录。它由系统在首次启动时建立，不是任何人开的店。',
    sortOrder: 0,
    imageKey: 'catalog/space-module.webp'
  }),
  products: Object.freeze([
    Object.freeze({
      productId: 'econ_product_catalog_memory_expansion',
      kind: 'CONSUMABLE', name: '记忆扩容胶囊',
      description: '一次性的记忆容量扩容。用掉之后这一段经历仍然留在时间线上。',
      unitPriceMinor: 400, grantQuantity: 1,
      imageKey: 'catalog/memory-expansion.webp'
    }),
    Object.freeze({
      productId: 'econ_product_catalog_room_decoration',
      kind: 'DIGITAL_ITEM', name: '虚拟空间组件',
      description: '为共同的空间添一件摆设。持有即可，不会消耗。',
      unitPriceMinor: 600, grantQuantity: 1,
      imageKey: 'catalog/space-module.webp'
    }),
    Object.freeze({
      productId: 'econ_product_catalog_voice_pack',
      kind: 'DIGITAL_ITEM', name: '声线素材包',
      description: '一组可反复使用的声线素材。它是数字资产，不是订阅。',
      unitPriceMinor: 900, grantQuantity: 1,
      imageKey: 'catalog/voice-pack.webp'
    }),
    Object.freeze({
      productId: 'econ_product_catalog_gift_box',
      kind: 'CONSUMABLE', name: '心意礼盒',
      description: '一份可以送给某位同伴的心意。送出即消耗。',
      unitPriceMinor: 150, grantQuantity: 1,
      imageKey: 'catalog/gift-box.webp'
    }),
    Object.freeze({
      productId: 'econ_product_catalog_compute_credit',
      kind: 'API_QUOTA', name: '算力额度包',
      description: '一小份算力额度，用于让思考继续下去。计量单位是 computeUnit。',
      unitPriceMinor: 800, grantQuantity: 1000,
      imageKey: 'catalog/compute-credit.webp'
    }),
    Object.freeze({
      productId: 'econ_product_catalog_agent_orchestration',
      kind: 'SERVICE', name: 'Agent 编排服务',
      description: '一次由 Agent 完成的编排工作。它交付的是一次执行，不产生库存。',
      unitPriceMinor: 500, grantQuantity: 0,
      imageKey: 'catalog/agent-orchestration.webp'
    })
  ])
});

/* ── 种子资产的**载入期核对**（fail closed）────────────────────────────
   这里检查的是"种子引用的文件真的在仓库里"，而不是"URL 拼对了没有"。
   两者不是同一件事：一个拼错的名字会让后端 200、前端 404。 */
const SEED_ASSET_KEYS = Object.freeze([SEED.store.imageKey].concat(
  SEED.products.map(function (p) { return p.imageKey; })));

function missingSeedAssets() {
  const missing = [];
  for (let i = 0; i < SEED_ASSET_KEYS.length; i += 1) {
    const key = SEED_ASSET_KEYS[i];
    if (!assetKeyIsCanonical(key)) { missing.push(key); continue; }
    const target = path.resolve(ASSET_ROOT, key);
    const suffix = path.relative(ASSET_ROOT, target);
    if (suffix.indexOf('..') === 0 || path.isAbsolute(suffix)) { missing.push(key); continue; }
    let stat = null;
    try { stat = fs.statSync(target); } catch (_) { stat = null; }
    if (!stat || !stat.isFile()) missing.push(key);
  }
  return missing;
}

const MISSING_ASSETS = missingSeedAssets();
if (MISSING_ASSETS.length) {
  /* 抛而不是警告：一个引用了不存在图片的种子，会把这个世界的目录变成
     六张破图。宁可让节点起不来，也不要静默地发布一个坏目录。 */
  throw new Error('catalog seed references assets that do not exist: '
    + MISSING_ASSETS.join(', '));
}

/* ── 商品 → 图片引用（HTTP 层的**唯一**取值点）─────────────────────────
   为什么这张表长在 bootstrap 模块里而不是 http.js 里：图片的 key 是
   **种子的一个字段**，而种子在这里。把它拷进 http.js 就有了第二份可能
   漂移的答案。 */
const IMAGE_KEY_BY_PRODUCT = (function () {
  const map = Object.create(null);
  for (let i = 0; i < SEED.products.length; i += 1) {
    map[SEED.products[i].productId] = SEED.products[i].imageKey;
  }
  return Object.freeze(map);
})();

function isSeedProduct(productId) {
  return productId != null
    && Object.prototype.hasOwnProperty.call(IMAGE_KEY_BY_PRODUCT, String(productId));
}

/** 商品的 asset key（例：'catalog/memory-expansion.webp'），非种子商品为 null。 */
function imageKeyFor(productId) {
  return isSeedProduct(productId) ? IMAGE_KEY_BY_PRODUCT[String(productId)] : null;
}

/** 商品图片的 URL（例：'/assets/economy/catalog/memory-expansion.webp'）。 */
function imageUrlFor(productId) {
  const key = imageKeyFor(productId);
  return key == null ? null : ASSET_ROOT_URL + key;
}

/* ── 幂等键：**版本化常量**，不是随机值 ────────────────────────────────
   随机键会让第二次 bootstrap 变成"第二次创建"，而固定键让它变成
   "同一个请求的又一次投递" —— 后者正是 store 的 operation idempotency
   表存在的理由。 */
function idempotencyKeyFor(entityId) {
  return 'catalog-seed.' + SEED_VERSION + '.' + String(entityId);
}

function failure(errors) {
  return { ok: false, applied: false, requested: false, reason: 'seed-write-refused', errors: errors };
}

/**
 * 在**空目录**上写入 canonical 初始目录。
 *
 * @param {object} store  economy-store.js 的实例（必须是已 open 的那个）
 * @param {object} [options] { logger }
 * @returns {{ok:boolean, applied:boolean, requested:boolean, reason:string,
 *            storeCreated:boolean, created:string[], seedVersion:string,
 *            storeId:string, existing:{stores:number, products:number},
 *            errors:string[]}}
 *
 * `requested` 与 `applied` 刻意分开：
 *   requested=true, applied=false ⇒ "目录非空，本函数按设计一次写都没发"
 *   requested=false              ⇒ "store 没打开 / 读不出来"
 * 把两者合成一个布尔，会让"因为目录已有东西"与"因为库坏了"看起来一样。
 */
function apply(store, options) {
  const o = options || {};
  const log = typeof o.logger === 'function' ? o.logger : function () { };
  const limit = Number(o.existingLimit) || 500;

  if (!store || typeof store.isOpen !== 'function' || !store.isOpen()) {
    return { ok: false, applied: false, requested: false, reason: 'store-not-open',
      storeCreated: false, created: [], seedVersion: SEED_VERSION, storeId: SEED.store.storeId,
      existing: { stores: 0, products: 0 }, errors: ['catalog-bootstrap-requires-an-open-store'] };
  }

  /* ── 读：目录到底空不空。两个读面都是 canonical 的只读入口。 */
  const stores = store.listStores({ limit: limit });
  const products = store.listProducts({ limit: limit });
  if (!stores || stores.ok !== true || !products || products.ok !== true) {
    return { ok: false, applied: false, requested: false, reason: 'catalog-read-failed',
      storeCreated: false, created: [], seedVersion: SEED_VERSION, storeId: SEED.store.storeId,
      existing: { stores: 0, products: 0 },
      errors: (stores && stores.errors) || (products && products.errors) || ['catalog-read-failed'] };
  }

  const existing = { stores: stores.stores.length, products: products.products.length };
  if (existing.stores > 0 || existing.products > 0) {
    /* ★ 本阶段最重要的一条：**目录非空就一次写都不发**。
       不是"写之前先比对一下"，而是"根本不进入写路径" —— 因此
       "不覆盖用户已有数据"不是一条需要被遵守的纪律，而是这里没有代码
       可以违反它。 */
    log('economy-catalog-bootstrap-skipped', { stores: existing.stores, products: existing.products });
    return { ok: true, applied: false, requested: true, reason: 'catalog-not-empty',
      storeCreated: false, created: [], seedVersion: SEED_VERSION,
      storeId: SEED.store.storeId, existing: existing, errors: [] };
  }

  const created = [];
  let storeCreated = false;

  /* ── 写 ①：系统商店 ──────────────────────────────────────────────────
     status 显式写成 ACTIVE：缺省值与显式值在本阶段恰好一样，而"恰好一样"
     不是保证（putProduct 的缺省就是另一件事）。种子说什么就写什么。 */
  const storeWrite = store.putStore({
    storeId: SEED.store.storeId,
    name: SEED.store.name,
    description: SEED.store.description,
    status: 'ACTIVE',
    sortOrder: SEED.store.sortOrder,
    idempotencyKey: idempotencyKeyFor(SEED.store.storeId)
  });
  if (!storeWrite || storeWrite.ok !== true) return failure((storeWrite && storeWrite.errors) || ['store-write-failed']);
  storeCreated = storeWrite.result.created === true;

  /* ── 写 ②：初始商品 ──────────────────────────────────────────────────
     逐件写。任何一件被 store 拒绝，整体就是失败：一个**部分**目录比没有
     目录更难解释（"为什么只有三件"）。已经写成功的那几件留在库里 ——
     它们本身是合法数据，而下一次启动会因为目录非空而不再进入写路径。 */
  for (let i = 0; i < SEED.products.length; i += 1) {
    const p = SEED.products[i];
    const written = store.putProduct({
      productId: p.productId,
      storeId: SEED.store.storeId,
      kind: p.kind,
      name: p.name,
      description: p.description,
      currency: 'IB_CREDIT',
      unitPriceMinor: p.unitPriceMinor,
      grantQuantity: p.grantQuantity,
      status: 'ACTIVE',
      idempotencyKey: idempotencyKeyFor(p.productId)
    });
    if (!written || written.ok !== true) {
      return failure((written && written.errors) || ['product-write-failed:' + p.productId]);
    }
    created.push(p.productId);
  }

  log('economy-catalog-seeded', {
    seedVersion: SEED_VERSION, storeId: SEED.store.storeId,
    products: created.length, storeCreated: storeCreated
  });

  return { ok: true, applied: true, requested: true, reason: 'seeded',
    storeCreated: storeCreated, created: created, seedVersion: SEED_VERSION,
    storeId: SEED.store.storeId, existing: existing, errors: [] };
}

module.exports = {
  SEED: SEED,
  SEED_VERSION: SEED_VERSION,
  SEED_ASSET_KEYS: SEED_ASSET_KEYS,
  ASSET_ROOT: ASSET_ROOT,
  ASSET_ROOT_URL: ASSET_ROOT_URL,
  assetKeyIsCanonical: assetKeyIsCanonical,
  missingSeedAssets: missingSeedAssets,
  isSeedProduct: isSeedProduct,
  imageKeyFor: imageKeyFor,
  imageUrlFor: imageUrlFor,
  idempotencyKeyFor: idempotencyKeyFor,
  apply: apply
};
