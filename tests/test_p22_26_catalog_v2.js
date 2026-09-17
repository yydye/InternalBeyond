'use strict';
/* ====================================================================
   P22-26 · Phase 3 —— Catalog v2
   --------------------------------------------------------------------
   运行：node tests/test_p22_26_catalog_v2.js

   本文件证明目录 v2 的三件事**同时**成立，而它们各自是一条结构而不是
   一条纪律：

     ① 去掉了 SERVICE —— 因为 `SERVICE_EXECUTION` 的结算原语是 `null`，
        而**一个商店不应该陈列无法结算的商品**；
     ② 每一件商品多了一个 `rarity`，而它**只**用于展示；
     ③ 只有空目录才 seed，因此**已经跑过 v1 的世界一个字都不会被改写**。

   ── 组 ──────────────────────────────────────────────────────────────
     A  版本与幂等键：v1 → v2，入口条件仍然是"目录为空"
     B  去 SERVICE：种子里没有它，而且**放进一件 SERVICE 会让 require 抛**
     C  rarity：封闭集合、只在目录层、不进 DTO、不进 products 表
     D  rarity 的**安全性**：没有任何经济代码读它（可断言，不是注释）
     E  没有第二套词表：种子条目里没有 effect / category / icon / level
     F  每一件商品真的能买：quote → prepare → settle（真库、真结算、真库存）
     G  已有世界不被改写：非空目录一次写都不发
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-26v2-' + tag + '-'));
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
    dataDir: dataDir || tmpDir('store'), logger: () => {},
    clock: () => CLOCK,
    nextId: (kind) => { idSeq += 1; return C.formatEconomyId(kind, 'v' + idSeq).id; }
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
/* 一个"新世界"：开库 + 钱包 + 预算，然后跑一次 catalog bootstrap。 */
function freshWorld(options) {
  const o = options || {};
  const store = makeStore(o.dataDir);
  store.open();
  walletWith(store, o.balance === undefined ? 100000n : o.balance, o.ownerId || 'char_a');
  policyFor(store, o.ownerId || 'char_a');
  const boot = BOOT.apply(store, { logger: () => {} });
  return { store: store, boot: boot, ownerId: o.ownerId || 'char_a' };
}
function inventoryOf(store, ownerId, productId) {
  return Number(store.inventoryQuantity(ownerId, productId).quantity);
}

/* ══════════════════════════════════════════════════════════════════
   A · 版本与幂等键
   ══════════════════════════════════════════════════════════════════ */
section('A · 版本与幂等键：v1 → v2');

{
  check('A1 ★ 种子版本是 v2（P22-25 是 v1）',
    BOOT.SEED_VERSION === 'v2' && BOOT.SEED.version === 'v2',
    { version: BOOT.SEED_VERSION });

  /* 幂等键是**版本化常量**：v2 的键与 v1 的键是两把不同的键，因此
     "另一个版本又要写一遍"在 store 的幂等表里是一次 conflict。 */
  const key = BOOT.idempotencyKeyFor('econ_product_catalog_gift_box');
  check('A2 ★★ 幂等键的前缀逐字是 `catalog-seed.v2.` —— 版本进键，因此"另一个版本想再写一遍"会被幂等表拒绝',
    key === 'catalog-seed.v2.econ_product_catalog_gift_box', { key: key });

  /* ── A3 · 空目录 ⇒ seed 五件 ────────────────────────────────────── */
  const w = freshWorld();
  check('A3 ★★ 空目录上 apply：applied = true、reason = "seeded"、created 恰好是 v2 的五件',
    w.boot.ok === true && w.boot.applied === true && w.boot.reason === 'seeded' &&
    w.boot.created.length === 5 && w.boot.seedVersion === 'v2',
    { boot: w.boot });

  const products = w.store.listProducts({ limit: 50 }).products;
  check('A4 ★ 目录里的商品恰好五件，且 id 与 v1 逐字相同（不制造第二套目录）',
    products.length === 5 &&
    products.map(p => p.productId).sort().join(',') === [
      'econ_product_catalog_compute_credit',
      'econ_product_catalog_gift_box',
      'econ_product_catalog_memory_expansion',
      'econ_product_catalog_room_decoration',
      'econ_product_catalog_voice_pack'
    ].join(','),
    { products: products.map(p => p.productId) });

  /* ── A5 · 第二遍 apply：一次写都不发 ────────────────────────────── */
  const before = {
    revision: w.store.getRevision(),
    changes: w.store.listChanges(0, 500).length,
    products: w.store.listProducts({ limit: 50 }).products.length,
    stores: w.store.listStores({ limit: 50 }).stores.length
  };
  const second = BOOT.apply(w.store, { logger: () => {} });
  const after = {
    revision: w.store.getRevision(),
    changes: w.store.listChanges(0, 500).length,
    products: w.store.listProducts({ limit: 50 }).products.length,
    stores: w.store.listStores({ limit: 50 }).stores.length
  };
  check('A6 ★★ 第二遍 apply：applied = false、reason = "catalog-not-empty"，而且 revision / change log / 商品数 / 货架数**逐字不变**（证明"根本没写"，不是"写了但值一样"）',
    second.ok === true && second.applied === false && second.reason === 'catalog-not-empty' &&
    J(before) === J(after),
    { second: second, before: before, after: after });

  /* ── A7 · 关闭的 store ⇒ requested = false（与"目录非空"是两件事）── */
  const closed = makeStore();
  const notOpen = BOOT.apply(closed, { logger: () => {} });
  check('A7 ★ store 没打开 ⇒ ok = false / requested = false / reason = "store-not-open"（"因为库坏了"与"因为目录已有东西"必须看起来不一样）',
    notOpen.ok === false && notOpen.requested === false && notOpen.reason === 'store-not-open',
    notOpen);

  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   B · 去 SERVICE
   ══════════════════════════════════════════════════════════════════ */
section('B · 去 SERVICE：不发布买不了的商品');

{
  const bootPath = path.join(ROOT, 'services', 'home-node', 'catalog-bootstrap.js');
  /* ── B1 · 种子里没有 SERVICE，也没有那件 orchestration 商品 ─────── */
  check('B1 ★★ 种子里**一件 SERVICE 都没有**（v1 里那件 `agent_orchestration` 已经不在了）',
    BOOT.SEED.products.every(p => p.kind !== 'SERVICE') &&
    BOOT.SEED.products.every(p => p.productId.indexOf('agent_orchestration') < 0),
    { kinds: BOOT.SEED.products.map(p => p.kind) });

  /* ── B2 · `SERVICE` 仍然在 PRODUCT_KIND 里（冻结的五个成员没动）─── */
  check('B2 ★★ `SERVICE` 仍然在冻结的 PRODUCT_KIND 里 —— 本阶段只是**不发布**它，不是把它删掉',
    C.PRODUCT_KINDS.indexOf('SERVICE') >= 0 && C.PRODUCT_KINDS.length === 5);

  /* ── B3 · 判据本身：一件 SERVICE 会被报成"买不了" ───────────────── */
  const serviceProbe = BOOT.unfulfillableSeedProducts();
  check('B3 ★★ 种子的判据跑一遍是**空**的（五件商品全部有非 null 的结算原语）',
    Array.isArray(serviceProbe) && serviceProbe.length === 0, { problems: serviceProbe });

  /* ── ★★ B4 · 判据对一件 SERVICE 商品的答案必须是"买不了" ─────────
     这只是判据本身，而它用的是**契约自己的**派生链 —— 因此它证明的是
     "SERVICE 的结算原语是 null"，也就是那件商品买不了的原因。 */
  const serviceFulfillment = C.fulfillmentOfProductKind('SERVICE');
  const servicePrimitive = C.settlementPrimitiveOfFulfillment(serviceFulfillment);
  check('B4 ★★ 一件 SERVICE 商品走派生链得到 SERVICE_EXECUTION，而它的结算原语是 **null** —— "买不了"这件事在契约层是真的',
    serviceFulfillment === 'SERVICE_EXECUTION' &&
    servicePrimitive.ok === true && servicePrimitive.primitive === null,
    { fulfillment: serviceFulfillment, primitive: servicePrimitive });

  /* ── ★★ B6 · 真的把一件 SERVICE 放进种子，再让模块**真的载入一次** ──
     ★ 为什么不能在本进程里 require 一份改过的模块：种子是
     `Object.freeze` 的，而且那条载入期断言就在模块体里 —— 一旦它命中，
     整个模块图都会失败，本进程后面每一组都会跟着死。

     因此这里做的是**三段各自都真实**的拼装：
       ① 取**真实的**模块源码（不是手抄一份）；
       ② 在种子数组的**最后一件商品之后**逐字插入一件 SERVICE（而不是改
          判据、也不是改契约）—— 插入点就是数组结束的 `])` 之前的最后
          一个 `})`；
       ③ 在一个受控上下文里载入那份源码，并以**真实模块路径**
          （`services/home-node/catalog-bootstrap.js`）执行它。
     第 ③ 步的关键：用真实路径执行有两个好处，而且两个都是必需的 ——
       · `require('./economy-contract.js')` 照常解析到真实契约（不需要
         任何注入，因此 B6 不依赖"我们的拦截器写对了"）；
       · `__dirname` 是真实的 `services/home-node`，于是图片资产核对指向
         真实的 `assets/economy`（否则它会去找一个不存在的目录，并且以
         "图片缺失"为由抛 —— 那会是一条**红色的假象**，正是 B6b 要排除的）。
     ★ 断言的是"它抛了"**且**"抛出的那句说的是买不了（而不是图片缺失）"
     **且**"它点的是那件被插入的 SERVICE" —— 缺任何一半都不算证明。 */
  const realSrc = fs.readFileSync(bootPath, 'utf8');
  const seedArrayEnd = realSrc.indexOf('  ])');
  const injectedSrc = seedArrayEnd < 0 ? null : (function () {
    const before = realSrc.slice(0, seedArrayEnd);
    const lastBrace = before.lastIndexOf('})');
    if (lastBrace < 0) return null;
    const serviceEntry = [
      '    }),',
      '    /* ★ 临时插入的一件 SERVICE：它**买不了**（结算原语为 null），',
      '       因此载入期核对必须让整个模块抛。 */',
      '    Object.freeze({',
      "      productId: 'econ_product_catalog_agent_orchestration',",
      "      kind: 'SERVICE', name: 'Agent 编排服务', rarity: 'COMMON',",
      '      unitPriceMinor: 500, grantQuantity: 0,',
      "      imageKey: 'catalog/memory-expansion.webp'",
      '    })'
    ].join('\n');
    return before.slice(0, lastBrace) + serviceEntry + realSrc.slice(seedArrayEnd);
  })();

  const vm = require('node:vm');
  /* 用一个**独立的模块对象**执行真实的源码，但以真实路径与真实 __dirname
     执行 —— 见上面第 ③ 步的两条理由。 */
  function runCatalogSource(source) {
    const mod = { exports: {} };
    const filename = bootPath;
    const context = vm.createContext({
      module: mod, exports: mod.exports,
      require: (request) => (request.charAt(0) === '.'
        ? require(path.resolve(path.dirname(bootPath), request))
        : require(request)),
      __filename: filename, __dirname: path.dirname(bootPath),
      process: process, console: { log: () => {}, warn: () => {}, error: () => {} },
      Buffer: Buffer, setTimeout: setTimeout, clearTimeout: clearTimeout
    });
    vm.runInContext(source, context, { filename: filename });
    return mod.exports;
  }

  let vmThrew = null;
  let vmExports = null;
  if (injectedSrc == null) {
    vmThrew = new Error('could not locate the seed array in the real module source');
  } else {
    try { vmExports = runCatalogSource(injectedSrc); } catch (error) { vmThrew = error; }
  }
  check('B6 ★★ 把一件 SERVICE 放进种子 ⇒ 模块**载入期真的抛**，而且那句抛出逐字说的是"买不了"、点的是那件 SERVICE（不是图片缺失）',
    vmExports == null && vmThrew != null &&
    vmThrew.message.indexOf('cannot be purchased') >= 0 &&
    vmThrew.message.indexOf('agent_orchestration') >= 0 &&
    vmThrew.message.indexOf('do not exist') < 0,
    { message: vmThrew && vmThrew.message });

  /* ── B6b · 反向对照：同一段载入方式、种子**不变**时一次都不抛 ────
     没有这一条，B6 可能只是因为"那段 vm 载入方式本身就是坏的"（例如
     __dirname 不对导致图片核对失败）而通过。 */
  let cleanThrew = null;
  let cleanExports = null;
  try { cleanExports = runCatalogSource(realSrc); } catch (error) { cleanThrew = error; }
  check('B6b ★★ 反向对照：同一段载入方式、种子**不变**时一次都不抛，导出的五件商品都在（否则 B6 可能只是因为载入方式坏了）',
    cleanThrew == null && cleanExports != null &&
    Array.isArray(cleanExports.SEED.products) && cleanExports.SEED.products.length === 5 &&
    cleanExports.SEED_VERSION === 'v2' && cleanExports.unfulfillableSeedProducts().length === 0,
    {
      threw: cleanThrew && cleanThrew.message,
      products: cleanExports && cleanExports.SEED && cleanExports.SEED.products.length,
      version: cleanExports && cleanExports.SEED_VERSION
    });

  const bootSrc = fs.readFileSync(bootPath, 'utf8');
  check('B7 ★★ 那条判据**在载入期真的被调用**，且命中就 throw（不是 console.warn）',
    /const UNFULFILLABLE = unfulfillableSeedProducts\(\);/.test(bootSrc) &&
    /if \(UNFULFILLABLE\.length\) \{[\s\S]{0,400}?throw new Error\('catalog seed would publish products that cannot be purchased/.test(bootSrc));
  check('B8 ★ 那条抛出的措辞逐字点明"一个商店不得陈列它结算不了的东西"',
    bootSrc.indexOf('a store must not display what it cannot settle') >= 0);

  /* ── B7 · 而 SERVICE 在 prepare 那一侧仍然是 fail closed ─────────
     目录不发布它，不代表它变得可买 —— 那两条是各自独立的。 */
  const w = freshWorld();
  const svc = w.store.putProduct({
    storeId: 'econ_store_system_market', kind: 'SERVICE', name: 'Handmade Service',
    currency: 'IB_CREDIT', unitPriceMinor: 500, grantQuantity: 0, idempotencyKey: nextKey('svc')
  });
  const q = w.store.createProductQuote({
    productId: svc.result.product.productId, buyerId: w.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('svcq')
  });
  const prep = w.store.preparePurchase({
    quoteId: q.result.quoteId, buyerId: w.ownerId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('svcp')
  });
  check('B7 ★★ 一件手工塞进来的 SERVICE 仍然买不了：prepare 拒绝 PURCHASE_NOT_SUPPORTED，而且 reservedNothing = true（钱一分没锁）',
    prep.ok === false && prep.reasonCode === C.DENY_REASON.PURCHASE_NOT_SUPPORTED &&
    prep.reservedNothing === true,
    { reasonCode: prep.reasonCode, reservedNothing: prep.reservedNothing, errors: prep.errors });
  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   C · rarity
   ══════════════════════════════════════════════════════════════════ */
section('C · rarity：封闭集合、只在目录层');

{
  check('C1 ★★ rarity 的词表恰好三个成员（COMMON / NOTABLE / RARE）—— 封闭集合，不是自由文本',
    J(BOOT.RARITIES) === J(['COMMON', 'NOTABLE', 'RARE']), { rarities: BOOT.RARITIES });
  check('C2 ★★ 每一件种子商品都有 rarity，而且取值全在集合里',
    BOOT.SEED.products.length === 5 &&
    BOOT.SEED.products.every(p => BOOT.RARITIES.indexOf(p.rarity) >= 0),
    { rarities: BOOT.SEED.products.map(p => p.rarity) });
  check('C3 ★ rarityFor 是目录层的唯一取值点：种子商品的答案与种子一致、非种子商品是 null',
    BOOT.SEED.products.every(p => BOOT.rarityFor(p.productId) === p.rarity) &&
    BOOT.rarityFor('econ_product_not_a_seed') === null,
    { sample: BOOT.rarityFor('econ_product_catalog_voice_pack') });

  /* ── C4 · rarity **不在 products 表里** ──────────────────────────── */
  check('C4 ★★ rarity **不是** products 表的一列（它长在目录层，不长在会被经济代码读的那张表上）',
    C.PRODUCT_INPUT_KEYS.indexOf('rarity') < 0, { keys: C.PRODUCT_INPUT_KEYS });

  const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  const schemaBlock = storeSrc.slice(storeSrc.indexOf('createProducts:'), storeSrc.indexOf('createProductsByStore:'));
  check('C5 ★★ 而 products 的 DDL 里也没有 rarity 列（本阶段没有改工商表的形状）',
    schemaBlock.indexOf('rarity') < 0, { ddl: schemaBlock.slice(0, 200) });

  /* ── C6 · putProduct 拒绝 rarity（白名单是硬的）────────────────── */
  const w = freshWorld();
  const withRarity = w.store.putProduct({
    storeId: 'econ_store_system_market', kind: 'DIGITAL_ITEM', name: 'Rarity Probe',
    currency: 'IB_CREDIT', unitPriceMinor: 100, grantQuantity: 1, rarity: 'RARE',
    idempotencyKey: nextKey('rarity')
  });
  check('C6 ★★ 往 putProduct 传 rarity 会被**白名单**拒绝（product-input-key-not-whitelisted）—— rarity 不可能成为一个商品字段',
    withRarity.ok === false &&
    withRarity.errors.indexOf('product-input-key-not-whitelisted:rarity') >= 0,
    { errors: withRarity.errors });

  /* ── C7 · 而 DTO 上也没有 rarity ────────────────────────────────── */
  const dto = w.store.listProducts({ limit: 50 }).products[0];
  check('C7 ★★ 商品的 DTO 里**没有** rarity（呈现层的唯一新增字段仍然是 P22-25 的 image / imageUrl 两个）',
    dto != null && !('rarity' in dto),
    { keys: dto ? Object.keys(dto) : null });

  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · rarity 的安全性：没有任何经济代码读它
   ══════════════════════════════════════════════════════════════════ */
section('D · rarity 的安全性：没有任何经济代码读它（可断言，不是注释）');

{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  /* ── D1 · economy-store.js 里 **零** 命中 ─────────────────────────
     ★ 这是"rarity 不影响价格 / 审批 / 能力"的可断言形式：定价
     （productQuoteAmountMinor）与可用性（productAvailabilityForQuote）都在
     这个文件里，而它们连 rarity 这个词都读不到。 */
  const storeSrc = strip(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8'));
  check('D1 ★★ economy-store.js（含定价与可用性判定）里 `rarity` **零命中** —— 它不参与价格、审批、能力或可用性',
    storeSrc.indexOf('rarity') < 0, { hits: (storeSrc.match(/rarity/g) || []).length });

  const contractSrc = strip(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'), 'utf8'));
  check('D2 ★★ economy-contract.js 里 `rarity` 零命中（它不是契约的一个概念）',
    contractSrc.indexOf('rarity') < 0, { hits: (contractSrc.match(/rarity/g) || []).length });

  /* ── D3 · 定价与可用性函数的源码里零命中（逐名）───────────────────
     ★ 这三个函数**不在同一个文件里**：定价那两个（`productQuoteAmountMinor`
     / `productQuoteQuantity`）在契约里，而可用性那一个
     （`productAvailabilityForQuote`）在 store 里。把它们一起扫需要一个
     "在哪个文件里找"的答案 —— 而那份答案本身就是本组要证明的东西的一半。
     因此逐个点名它的文件，找不到就算失败（`found: false` 是失败，不是跳过）。 */
  const fnBody = (src, name) => {
    const at = src.indexOf('function ' + name + '(');
    return at < 0 ? null : src.slice(at, at + 3000);
  };
  const priced = [
    { name: 'productQuoteAmountMinor', src: contractSrc },
    { name: 'productQuoteQuantity', src: contractSrc },
    { name: 'productAvailabilityForQuote', src: storeSrc }
  ].map(p => ({ name: p.name, body: fnBody(p.src, p.name) }));
  check('D3 ★★ 定价（契约里那两个）与可用性（store 里那一个）的函数体里 `rarity` 零命中（D1 的逐名版本）',
    priced.every(p => p.body != null && p.body.indexOf('rarity') < 0),
    { scanned: priced.map(p => ({ name: p.name, found: p.body != null })) });

  /* ── D4 · rarity 的读取点只在目录层与呈现层 ─────────────────────── */
  const prodDir = path.join(ROOT, 'services', 'home-node');
  const readers = fs.readdirSync(prodDir).filter(f => f.endsWith('.js')).filter(f => {
    const body = strip(fs.readFileSync(path.join(prodDir, f), 'utf8'));
    return body.indexOf('rarity') >= 0;
  });
  check('D4 ★★ services/home-node/ 下**只有** catalog-bootstrap.js 提到 rarity（唯一读它的地方就是目录层自己）',
    J(readers.sort()) === J(['catalog-bootstrap.js']), { readers: readers });

  /* ── D5 · 而 HTTP 层也没有把它送到 DTO 上 ───────────────────────── */
  const httpSrc = strip(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8'));
  check('D5 ★★ http.js 里 `rarity` 零命中 —— 它没有被接上任何 HTTP 读面（呈现层要用它必须显式接，而那不是本阶段）',
    httpSrc.indexOf('rarity') < 0, { hits: (httpSrc.match(/rarity/g) || []).length });
}

/* ══════════════════════════════════════════════════════════════════
   E · 没有第二套词表
   ══════════════════════════════════════════════════════════════════ */
section('E · 没有第二套词表：种子不携带 effect / category / icon');

{
  const FORBIDDEN = BOOT.FORBIDDEN_SEED_PRODUCT_KEYS;
  check('E1 ★★ 种子条目里**没有** `effect`（契约里已经有一套 EFFECT_TYPE，本阶段绝不造第三套）',
    BOOT.SEED.products.every(p => !('effect' in p)) &&
    FORBIDDEN.indexOf('effect') >= 0);
  check('E2 ★★ 也没有 `category`（语义落点就是 kind —— 两个答案回答同一个问题）',
    BOOT.SEED.products.every(p => !('category' in p)));
  check('E3 ★★ 也没有 `icon`（图片的既有名字是 image / imageUrl —— 不给图片第二个名字）',
    BOOT.SEED.products.every(p => !('icon' in p)) &&
    BOOT.SEED.products.every(p => typeof p.imageKey === 'string'));
  check('E4 ★ 也没有 level / tier / attack / equipSlot（本域没有等级、属性、掉落）',
    BOOT.SEED.products.every(p => !('level' in p) && !('tier' in p) &&
      !('attack' in p) && !('equipSlot' in p)));

  /* ── E5 · 载入期核对真的会拦住它们 ─────────────────────────────── */
  const bootSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'catalog-bootstrap.js'), 'utf8');
  check('E5 ★★ 载入期核对确实逐键拦这些名字，命中就 throw',
    /if \(SEED_KEY_VIOLATIONS\.length\) \{[\s\S]{0,300}?throw new Error\('catalog seed carries keys that would create a second vocabulary/.test(bootSrc));
  check('E6 ★ 而 `imageKey` 是**目录层**的字段名（它不等于 products 的 image 列，也不进 DTO）',
    C.PRODUCT_INPUT_KEYS.indexOf('imageKey') < 0 && C.PRODUCT_INPUT_KEYS.indexOf('image') < 0,
    { keys: C.PRODUCT_INPUT_KEYS });
}

/* ══════════════════════════════════════════════════════════════════
   F · 每一件商品真的能买
   ══════════════════════════════════════════════════════════════════ */
section('F · 每一件商品真的能买：quote → prepare → settle（真库、真结算、真库存）');

{
  const w = freshWorld({ balance: 100000n });
  const results = BOOT.SEED.products.map(function (p) {
    const before = inventoryOf(w.store, w.ownerId, p.productId);
    const q = w.store.createProductQuote({
      productId: p.productId, buyerId: w.ownerId, units: 1,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('q')
    });
    if (q.ok !== true) return { productId: p.productId, stage: 'quote', ok: false, errors: q.errors, reasonCode: q.reasonCode };
    const prep = w.store.preparePurchase({
      quoteId: q.result.quoteId, buyerId: w.ownerId,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('p')
    });
    if (prep.ok !== true) return { productId: p.productId, stage: 'prepare', ok: false, errors: prep.errors, reasonCode: prep.reasonCode };
    const settled = w.store.settlePurchase({ purchaseId: prep.result.purchaseId, idempotencyKey: nextKey('s') });
    const purchase = w.store.getPurchase({ purchaseId: prep.result.purchaseId }).purchase;
    const after = inventoryOf(w.store, w.ownerId, p.productId);
    return {
      productId: p.productId, kind: p.kind, stage: 'settle', ok: settled.ok === true,
      purchase: purchase, grantedDelta: after - before, errors: settled.errors
    };
  });

  const allOk = results.every(r => r.ok === true);
  check('F1 ★★ 目录 v2 的**每一件**商品都走通了 quote → prepare → settle（六件里有五件是 v1 的事实，五件里有五件是本阶段的事实）',
    allOk && results.length === 5,
    results.map(r => ({ productId: r.productId, stage: r.stage, ok: r.ok, reasonCode: r.reasonCode, errors: r.errors })));

  check('F2 ★★ 每一件的库存增量逐字等于它的 grantQuantity（400 → 1 件 / 800 → 1000 computeUnit）',
    results.every(r => r.ok === true &&
      r.grantedDelta === BOOT.SEED.products.filter(p => p.productId === r.productId)[0].grantQuantity),
    results.map(r => ({ productId: r.productId, delta: r.grantedDelta })));

  check('F3 ★★ 每一件的 assetKind 与 kind 的**派生**一致（DIGITAL_ITEM / CONSUMABLE → ITEM，API_QUOTA → COMPUTE）',
    results.every(r => r.ok === true &&
      r.purchase.assetKind === C.assetKindOfProductKind(r.kind)),
    results.map(r => ({ kind: r.kind, assetKind: r.purchase && r.purchase.assetKind })));

  check('F4 ★ 每一件都真的花了钱、真的发了货：金额等于单价、quote 已消费、purchase 已 COMPLETED 且带 inventoryEntryId',
    results.every(r => r.ok === true &&
      r.purchase.status === 'COMPLETED' &&
      r.purchase.amountMinor === String(BOOT.SEED.products.filter(p => p.productId === r.productId)[0].unitPriceMinor) &&
      r.purchase.inventoryEntryId != null),
    results.map(r => ({
      id: r.productId, status: r.purchase && r.purchase.status,
      amount: r.purchase && r.purchase.amountMinor, entry: r.purchase && r.purchase.inventoryEntryId
    })));

  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   G · 已有世界不被改写
   ══════════════════════════════════════════════════════════════════ */
section('G · 已有世界不被改写：非空目录一次写都不发');

{
  /* ── G1 · 一个用户自己开过店的世界 ─────────────────────────────── */
  const store = makeStore();
  store.open();
  walletWith(store, 1000n, 'char_a');
  const ownStore = store.putStore({ name: '我的店', storeId: 'econ_store_mine', idempotencyKey: nextKey('own') });
  const ownProduct = store.putProduct({
    storeId: 'econ_store_mine', kind: 'DIGITAL_ITEM', name: '我的商品',
    currency: 'IB_CREDIT', unitPriceMinor: 250, grantQuantity: 1, idempotencyKey: nextKey('ownp')
  });
  const snapshot = {
    revision: store.getRevision(),
    stores: J(store.listStores({ limit: 50 }).stores),
    products: J(store.listProducts({ limit: 50 }).products)
  };
  const boot = BOOT.apply(store, { logger: () => {} });
  check('G1 ★★ 一个用户自己开过店的世界：bootstrap 一次写都不发（applied = false，revision / 货架 / 商品逐字节不变）',
    boot.ok === true && boot.applied === false && boot.reason === 'catalog-not-empty' &&
    store.getRevision() === snapshot.revision &&
    J(store.listStores({ limit: 50 }).stores) === snapshot.stores &&
    J(store.listProducts({ limit: 50 }).products) === snapshot.products,
    { boot: boot, revision: store.getRevision(), before: snapshot.revision });
  check('G2 ★★ 而那个世界里的商店与商品一件都没被种子的 id 顶替（用户的店还在，系统商店没有被建出来）',
    store.getStore({ storeId: 'econ_store_mine' }).ok === true &&
    store.getStore({ storeId: 'econ_store_system_market' }).ok === false,
    {
      mine: store.getStore({ storeId: 'econ_store_mine' }).ok,
      systemMarket: store.getStore({ storeId: 'econ_store_system_market' }).ok
    });
  store.close();

  /* ── G3 · 一个"跑过 v1 的世界"：目录非空 ⇒ v2 不改写它 ───────────
     ★ 这不是理论情况：任何一个已经跑过 P22-25 的世界都是这样。v2 的入口
     条件仍然是"目录为空"，因此它需要一条**独立的、显式的**目录升级动作 ——
     那属于本阶段之外。 */
  const v1Dir = tmpDir('v1world');
  const s1 = makeStore(v1Dir);
  s1.open();
  walletWith(s1, 1000n, 'char_a');
  s1.putStore({ storeId: 'econ_store_system_market', name: '系统商店', status: 'ACTIVE', idempotencyKey: 'catalog-seed.v1.econ_store_system_market' });
  const v1ProductIds = [
    'econ_product_catalog_memory_expansion', 'econ_product_catalog_room_decoration',
    'econ_product_catalog_voice_pack', 'econ_product_catalog_gift_box',
    'econ_product_catalog_compute_credit', 'econ_product_catalog_agent_orchestration'
  ];
  v1ProductIds.forEach(function (id) {
    s1.putProduct({
      productId: id, storeId: 'econ_store_system_market',
      kind: id.indexOf('agent_orchestration') >= 0 ? 'SERVICE' : 'DIGITAL_ITEM',
      name: id, currency: 'IB_CREDIT', unitPriceMinor: 100,
      grantQuantity: id.indexOf('agent_orchestration') >= 0 ? 0 : 1,
      status: 'ACTIVE', idempotencyKey: 'catalog-seed.v1.' + id
    });
  });
  const v1Snapshot = { revision: s1.getRevision(), products: J(s1.listProducts({ limit: 50 }).products) };
  s1.close();

  const s2 = makeStore(v1Dir);
  s2.open();
  const v2Boot = BOOT.apply(s2, { logger: () => {} });
  check('G3 ★★ 一个跑过 v1 的世界（目录非空，含那件 SERVICE 商品）：v2 一次写都不发 —— 它不会"顺手"把 SERVICE 撤掉或补上 rarity',
    v2Boot.ok === true && v2Boot.applied === false && v2Boot.reason === 'catalog-not-empty' &&
    s2.getRevision() === v1Snapshot.revision &&
    J(s2.listProducts({ limit: 50 }).products) === v1Snapshot.products,
    { boot: v2Boot, revision: s2.getRevision(), before: v1Snapshot.revision });
  check('G4 ★★ 而那件 v1 的 SERVICE 商品**仍然在**（v2 的定义不追溯改写历史 —— 撤下它需要一个显式的目录升级动作）',
    s2.getProduct({ productId: 'econ_product_catalog_agent_orchestration' }).ok === true &&
    s2.listProducts({ limit: 50 }).products.every(p => !('rarity' in p)),
    {
      orchestration: s2.getProduct({ productId: 'econ_product_catalog_agent_orchestration' }).ok,
      products: s2.listProducts({ limit: 50 }).products.length
    });
  s2.close();
}

process.on('exit', (code) => {
  if (code === 0 && failures > 0) process.exitCode = 1;
});
console.log('\n' + (failures === 0
  ? '════════════════════════════════════════════════════════════════'
    + '\nP22-26 Catalog v2：全部通过 ✔'
  : '════════════════════════════════════════════════════════════════'
    + '\nP22-26 Catalog v2：' + failures + ' 项失败 ✘'));
if (failures > 0) process.exitCode = 1;
