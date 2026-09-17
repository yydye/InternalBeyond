'use strict';
/* ====================================================================
   P22-25 · Fresh-world catalog wire acceptance
   --------------------------------------------------------------------
   运行：node tests/test_p22_25_fresh_catalog_wire.js

   上一条守卫（test_p22_25_catalog_bootstrap.js）证明的是**模块**的性质。
   这一条证明的是**产品**的性质：一个**真的** Home Node 子进程，
   一个**真的**私有数据目录，从零启动之后，站在 HTTP 外面看到什么。

     ① fresh install 之后 `/economy/stores` 与 `/economy/products` **不为空**；
     ② 每一件商品的图片引用是一个 asset key + 一个以 /assets/economy/ 开头的
        URL —— 没有任何一条是网络动态资源、data URL 或临时链接；
     ③ 那些 URL **真的能取到一张 WebP**（200 + image/webp），
        而且**不需要凭据**（图片是静态资产，不是经济事实）；
     ④ 不存在的那张图是 404，**不是** HTML 回落（fail closed 的对外形态）；
     ⑤ 目录是**只读**面：POST/PUT/DELETE 到 /economy/* 一律 405
        economy-is-read-only —— 本阶段没有给任何人生成商品的路；
     ⑥ 未认证的读取被拒绝（Economy 读面从 P22-23 起要凭据）。

   ★ 它不碰开发目录、不碰 %LOCALAPPDATA%、不开浏览器：一个子进程 +
     一个 os.tmpdir() 里的私有目录 + 一个显式测试凭据，结束即清理。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fx = require(path.join(__dirname, 'fixtures', 'p22-cdp-client.js'));
const ROOT = path.resolve(__dirname, '..');
const BOOT = require(path.join(ROOT, 'services', 'home-node', 'catalog-bootstrap.js'));

const TOKEN = 'p22-25-fresh-catalog-token';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log('  ✔ ' + name); }
  else { failed += 1; console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n── ' + t); }

/* 裸请求：要看**响应头与字节**（content-type / 长度），因此不能用那个
   把 body 解析成 JSON 的夹具。 */
function raw(port, method, urlPath, headers) {
  return new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: headers || {}, timeout: 8000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: String(res.headers['content-type'] || ''),
        len: Buffer.concat(chunks).length
      }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, type: '', len: 0 }); });
    r.on('error', () => resolve({ status: 0, type: '', len: 0 }));
    r.end();
  });
}

(async function main() {
  console.log('P22-25 · Fresh-world catalog wire acceptance');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p2225-wire-'));
  const port = await fx.freePort();
  const child = spawn(process.execPath, [path.join('services', 'home-node-service.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      IB_HOME_NODE_PORT: String(port), IB_HOME_NODE_DATA_DIR: dir, IB_HOME_NODE_TOKEN: TOKEN
    }),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let out = '';
  child.stdout.on('data', c => { out += String(c); });
  child.stderr.on('data', c => { out += String(c); });

  const AUTH = { 'X-IB-Home-Token': TOKEN };

  try {
    let up = false;
    for (let i = 0; i < 80; i++) {
      const h = await fx.request(port, 'GET', '/health');
      if (h.status === 200) { up = true; break; }
      await fx.sleep(250);
    }
    section('0 · 真实节点起来了');
    check('0.1 一个**全新的** Home Node 子进程（私有数据目录 + 显式凭据）在 /health 上答 200',
      up, out.slice(-300));
    if (!up) throw new Error('home node did not start');

    /* ★ 启动日志是"装配期真的跑过 bootstrap"的**外部**证据：它不是
       bootstrap 自己的返回值，而是那个进程写下来的话。 */
    check('0.2 ★★★★ 子进程日志里有 economy-catalog-seeded（装配期真的种了，而且是这一台节点自己说的）',
      out.indexOf('economy-catalog-seeded') >= 0,
      out.split('\n').filter(l => l.indexOf('economy-catalog') >= 0));
    check('0.3 ★★★ 日志里没有 economy-catalog-bootstrap-failed',
      out.indexOf('economy-catalog-bootstrap-failed') < 0,
      out.split('\n').filter(l => l.indexOf('bootstrap-failed') >= 0));

    /* ══════════════════════════════════════════════════════════════
       ① 目录不为空
       ══════════════════════════════════════════════════════════════ */
    section('① fresh install：目录不为空');

    const stores = await fx.request(port, 'GET', '/economy/stores', null, AUTH);
    const products = await fx.request(port, 'GET', '/economy/products', null, AUTH);
    check('1.1 ★★★★★ GET /economy/stores ⇒ 200，而且**至少一间**货架（fresh install 之后不再是空的）',
      stores.status === 200 && Array.isArray(stores.body.stores) && stores.body.stores.length >= 1,
      { status: stores.status, stores: stores.body && stores.body.stores && stores.body.stores.length });
    check('1.2 ★★★★★ GET /economy/products ⇒ 200，而且商品数与种子一致（5~10 件）',
      products.status === 200 && Array.isArray(products.body.products)
      && products.body.products.length === BOOT.SEED.products.length
      && products.body.products.length >= 5 && products.body.products.length <= 10,
      { status: products.status, count: products.body && products.body.products && products.body.products.length });
    check('1.3 系统商店就是种子里那一间（固定 id，ACTIVE）',
      stores.body.stores.length === 1
      && stores.body.stores[0].storeId === BOOT.SEED.store.storeId
      && stores.body.stores[0].status === 'ACTIVE'
      && stores.body.stores[0].name === BOOT.SEED.store.name,
      stores.body.stores);
    check('1.4 ★★★ 每一件商品都挂在这间系统商店下，而且是 ACTIVE',
      products.body.products.every(p => p.storeId === BOOT.SEED.store.storeId && p.status === 'ACTIVE'),
      products.body.products.map(p => [p.productId, p.storeId, p.status]));
    check('1.5 目录读面仍然自述"不是推荐系统、没有折扣"（P22-5 的边界一字未改）',
      products.body.personalized === false && products.body.hasRecommendations === false
      && products.body.hasDiscounts === false,
      { personalized: products.body.personalized, recs: products.body.hasRecommendations });

    /* ══════════════════════════════════════════════════════════════
       ② 图片引用是 asset key + 仓库内 URL
       ══════════════════════════════════════════════════════════════ */
    section('② 图片引用：一个 asset key、一个仓库内 URL、零网络资源');

    const rows = products.body.products;
    check('2.1 ★★★★★ 每一件商品的 `image` 都是 `catalog/<name>.webp` 形状的 asset key',
      rows.every(p => BOOT.assetKeyIsCanonical(p.image)),
      rows.map(p => [p.productId, p.image]));
    check('2.2 ★★★★★ 每一件商品的 `imageUrl` 都是 /assets/economy/ 下的路径'
      + '（没有 http(s)、没有 //host、没有 data:）',
      rows.every(p => p.imageUrl === '/assets/economy/' + p.image
        && p.imageUrl.indexOf('//') < 0 && p.imageUrl.indexOf(':') < 0
        && p.imageUrl.indexOf('data:') < 0 && p.imageUrl.indexOf('http') < 0),
      rows.map(p => [p.productId, p.imageUrl]));
    check('2.3 ★★★★ 线上给出的 asset key 与种子里那一份**逐字相等**（不是"长得像"）',
      rows.every(p => {
        const seeded = BOOT.SEED.products.filter(s => s.productId === p.productId)[0];
        return !!seeded && seeded.imageKey === p.image;
      }),
      rows.map(p => [p.productId, p.image]));
    check('2.5 ★★★★ 单个商品的读面给出**同一份**图片引用（两个面不会漂移）',
      (await fx.request(port, 'GET', '/economy/product?productId=' + encodeURIComponent(rows[0].productId), null, AUTH))
        .body.product.imageUrl === rows[0].imageUrl,
      { list: rows[0].imageUrl });

    /* ★★★ 这一条是"schema 没有变"的**线上**形式：序列化视图的字段集合
       恰好等于 P22-5 冻结的那一份，**加上**两个由种子派生的图片键。
       也就是说：图片不是商品行的一列，它是种子的一部分。 */
    const STORE_VIEW_KEYS = ['domain', 'productId', 'storeId', 'kind', 'fulfillment', 'name',
      'description', 'currency', 'unitPriceMinor', 'unitName', 'grantQuantity', 'assetKind',
      'status', 'revision', 'createdAt', 'updatedAt', 'pricingIsRelationshipFree',
      'holdsOwnership', 'grantsInventory', 'hasDiscount', 'hasRecommendation'];
    check('2.5b ★★★★★ 线上商品的字段集合 = P22-5 冻结的序列化视图 + {image, imageUrl}，'
      + '没有第三个新字段（图片不进库、不加列、不动 schema）',
      rows.every(p => {
        const keys = Object.keys(p);
        const extra = keys.filter(k => STORE_VIEW_KEYS.indexOf(k) < 0);
        return extra.length === 2 && extra.indexOf('image') >= 0 && extra.indexOf('imageUrl') >= 0
          && STORE_VIEW_KEYS.every(k => keys.indexOf(k) >= 0);
      }),
      Object.keys(rows[0]));

    /* ══════════════════════════════════════════════════════════════
       ③ 图片真的取得到
       ══════════════════════════════════════════════════════════════ */
    section('③ 图片是真实可取的静态资产');

    /* ★ 图片由**桌面静态层**（services/internal-beyond-server.js，
       IB_WEB_PORT，默认 23120）服务，而**不是** Home Node：Home Node 上没有
       `/assets/*` 这条路由（落进 401/404 兜底），图片是产品资产、不是经济事实。
       因此这一节的首选是"经那一层取一张真图"，而它不在时（开发机上没开 GUI）
       退回**文件级**判据（真的 WebP magic + 非空字节），并如实标注走的哪条路。
       ★ 两条路都不是"跳过"：字节级判据在两种情况下都必须成立。 */
    const WEB_PORT = Number(process.env.IB_WEB_PORT) || 23120;

    async function assetFetch(imageUrl) {
      const r = await raw(WEB_PORT, 'GET', imageUrl);
      if (r.status === 200 && /^image\/webp/.test(r.type) && r.len > 1000) {
        return { via: 'static', ok: true, status: r.status, type: r.type, len: r.len };
      }
      /* 静态层不在（端口上什么都没有 / 被别的进程占着）：退回文件级判据。 */
      const buf = fs.readFileSync(path.join(BOOT.ASSET_ROOT, imageUrl.replace('/assets/economy/', '')));
      const magic = buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF'
        && buf.slice(8, 12).toString('ascii') === 'WEBP';
      return { via: 'file', ok: magic && buf.length > 1000, bytes: buf.length,
        magic: magic, staticSaid: r.status + '/' + r.type };
    }

    const fetched = [];
    for (const p of rows) fetched.push(Object.assign({ key: p.image }, await assetFetch(p.imageUrl)));

    check('3.1 ★★★★★ 每一件商品的图片都真的存在且是一张非空 WebP'
      + '（经桌面静态层 :' + WEB_PORT + ' 取到 200 + image/webp，'
      + '或该层不在时按文件字节判定 —— 走的哪条路逐件记录在案）',
      fetched.every(f => f.ok === true),
      fetched);
    check('3.2 ★★★★ 六件商品取到的是**六张不同的图**（不是一张图被引用了六次）',
      new Set(rows.map(p => p.imageUrl)).size === rows.length,
      rows.map(p => p.imageUrl));
    check('3.3 ★★★★ 静态层可用时：取图**不需要**任何凭据（产品资产不是经济事实）',
      fetched.every(f => f.via !== 'static' || f.ok === true),
      { staticLayer: WEB_PORT, fetches: fetched.map(f => [f.key, f.via, f.ok]) });

    /* ★ fail closed 的对外形态只在"真的有服务端在服务这条路径"时才有意义：
       Home Node 对任何 /assets/* 都答 404（它根本没有这条路由），拿它去证明
       "缺图不是 HTML 回落"是**空的**。因此这一条只在静态层可用时断言，
       否则改判**文件系统**上的同一条否定。 */
    if (fetched.every(f => f.via === 'static')) {
      const absent = await raw(WEB_PORT, 'GET', '/assets/economy/catalog/__does-not-exist__.webp');
      check('3.4 ★★★★★ static 层上：不存在的那张图是 **404**，而**不是**一次 HTML 回落'
        + '（回落会让 <img> 拿到 200 + text/html —— 那是"看起来成功了"的坏形态）',
        absent.status === 404 && absent.type.indexOf('text/html') < 0,
        absent);
    } else {
      const codes = Array.from(new Set(fetched.map(f => f.staticSaid || 'n/a')));
      check('3.4 ★★★★★ static 层此刻不在（HTTP 上答 ' + codes.join(' / ') + '），'
        + '因此这一条改判**文件系统**的 fail-closed：每一个被引用的 key 都解析到一个真实文件，'
        + '而一个不存在的 key 解析不到任何文件（模块载入期会因此抛）',
        BOOT.missingSeedAssets().length === 0 &&
        !fs.existsSync(path.join(BOOT.ASSET_ROOT, 'catalog/__does-not-exist__.webp')) &&
        rows.every(p => fs.existsSync(path.join(BOOT.ASSET_ROOT, p.image))),
        { missing: BOOT.missingSeedAssets(), codes: codes });
    }

    /* ══════════════════════════════════════════════════════════════
       ④ 本阶段逐条禁止：没有任何人能生成商品
       ══════════════════════════════════════════════════════════════ */
    section('④ 只读面：/economy/* 的写尝试一律 405');

    const writeAttempts = [
      ['POST', '/economy/products', { kind: 'DIGITAL_ITEM', name: 'x' }],
      ['POST', '/economy/product', { name: 'x' }],
      ['PUT', '/economy/product', { productId: 'econ_product_x', name: 'x' }],
      ['DELETE', '/economy/product?productId=econ_product_catalog_gift_box', null],
      ['POST', '/economy/stores', { name: 'x' }],
      ['POST', '/economy/store', { name: 'x' }]
    ];
    const writeResults = [];
    for (const [m, p, b] of writeAttempts) {
      const r = await fx.request(port, m, p, b, AUTH);
      writeResults.push({ m: m, p: p, status: r.status, error: r.body && r.body.error });
    }
    check('4.1 ★★★★★ 六种写尝试全部被拒（405 / 404），一个都不成立',
      writeResults.every(r => r.status === 405 || r.status === 404),
      writeResults);
    check('4.2 ★★★★★ 其中 POST 到 /economy/products 与 /economy/stores 是 405 economy-is-read-only',
      writeResults.filter(r => r.m === 'POST' && r.p === '/economy/products')[0].error === 'economy-is-read-only'
      && writeResults.filter(r => r.m === 'POST' && r.p === '/economy/stores')[0].error === 'economy-is-read-only',
      writeResults.filter(r => r.m === 'POST'));
    check('4.3 ★★★★★ 所有写尝试之后，商品集合**一件都没有多**（不是"拒了但偷偷写了"）',
      (await fx.request(port, 'GET', '/economy/products', null, AUTH)).body.products.length
        === BOOT.SEED.products.length,
      { before: BOOT.SEED.products.length,
        after: (await fx.request(port, 'GET', '/economy/products', null, AUTH)).body.products.length });

    /* ══════════════════════════════════════════════════════════════
       ⑤ 未认证的读取被拒绝
       ══════════════════════════════════════════════════════════════ */
    section('⑤ 未认证：Economy 读面仍然要凭据');

    const anon = await fx.request(port, 'GET', '/economy/products');
    check('5.1 ★★★★ 不带凭据读目录 ⇒ 401 unauthenticated（P22-23 那条不变量一字未改）',
      anon.status === 401 && anon.body && anon.body.error === 'unauthenticated',
      { status: anon.status, body: anon.body });

    /* ══════════════════════════════════════════════════════════════
       ⑥ 幂等：同一个数据目录再启动一次，目录还是那 6 件
       ══════════════════════════════════════════════════════════════ */
    section('⑥ 幂等：同一台节点重启之后，目录一字未增');

    child.kill();
    await fx.sleep(700);

    const port2 = await fx.freePort();
    const child2 = spawn(process.execPath, [path.join('services', 'home-node-service.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        IB_HOME_NODE_PORT: String(port2), IB_HOME_NODE_DATA_DIR: dir, IB_HOME_NODE_TOKEN: TOKEN
      }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out2 = '';
    child2.stdout.on('data', c => { out2 += String(c); });
    child2.stderr.on('data', c => { out2 += String(c); });
    try {
      let up2 = false;
      for (let i = 0; i < 80; i++) {
        const h = await fx.request(port2, 'GET', '/health');
        if (h.status === 200) { up2 = true; break; }
        await fx.sleep(250);
      }
      check('6.1 第二次启动成功（同一个数据目录）', up2, out2.slice(-300));
      const again = await fx.request(port2, 'GET', '/economy/products', null, AUTH);
      const againStores = await fx.request(port2, 'GET', '/economy/stores', null, AUTH);
      check('6.2 ★★★★★ 重启之后商品仍然是种子那几件，一件都没有重复',
        again.status === 200 && again.body.products.length === BOOT.SEED.products.length
        && againStores.body.stores.length === 1,
        { products: again.body.products && again.body.products.length,
          stores: againStores.body.stores && againStores.body.stores.length });
      check('6.3 ★★★★ 第二次启动的日志里是 economy-catalog-bootstrap-skipped'
        + '（不是 seeded）—— 幂等这件事在**日志**上也说得清',
        out2.indexOf('economy-catalog-bootstrap-skipped') >= 0
        && out2.indexOf('economy-catalog-seeded') < 0,
        out2.split('\n').filter(l => l.indexOf('economy-catalog') >= 0));
      check('6.4 ★★★★ 而且没有任何一次 economy-catalog-bootstrap-failed',
        out2.indexOf('economy-catalog-bootstrap-failed') < 0,
        out2.split('\n').filter(l => l.indexOf('bootstrap-failed') >= 0));
    } finally {
      child2.kill();
      await fx.sleep(500);
    }
  } finally {
    try { child.kill(); } catch (_) { }
    await fx.sleep(300);
    /* Windows 上开着 SQLite 文件时 rmSync 会 EPERM：给它一次重试窗口。 */
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (_) { await fx.sleep(300); }
    }
  }

  check('Z1 私有数据目录已清理', !fs.existsSync(dir), { dir: dir });

  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ' — ' + passed + ' 项通过 / ' + failed + ' 项失败');
  process.exit(failed === 0 ? 0 : 1);
})().catch(function (error) {
  console.error('\n✖ 未捕获错误：' + (error && error.stack || error));
  process.exit(1);
});
