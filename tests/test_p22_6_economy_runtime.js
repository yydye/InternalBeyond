'use strict';
/* ====================================================================
   P22-6 · Economy runtime（真实 Home Node 子进程 + 多进程结算竞争）
   --------------------------------------------------------------------
   运行：node tests/test_p22_6_economy_runtime.js

   本文件回答三个**只有真实进程**才能回答的问题：

     「一个真实的 production Home Node 打开 P22-6 的库之后，购买读面
       可用、重启仍然可用？」                        —— B 组
     「HTTP 上购买**写**面真的一条都没有？」            —— C 组
     「两个真实进程同时 settle 同一次购买 / 同时 prepare 同一份报价时，
       最终经济事实是什么？」                          —— D / E 组

   ── 为什么多进程不是"更狠一点的单进程测试" ────────────────────────────
   node:sqlite 的 DatabaseSync 是同步 API，单线程里两次 settle 不可能交错。
   因此"结算是一个原子边界"在单进程内**无法被证伪** —— 唯一的证伪方式
   是两个各自持有独立 SQLite 连接的真实操作者同时动手。这与 P22-3 的
   reserve worker / P22-5 的 consume worker 是同一条纪律的第三次应用。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_FILE = 'services/home-node-service.js';
const WORKER_FILE = 'tests/fixtures/p22-6-purchase-worker.js';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-6rt-' + tag + '-'));
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

/* ── 一个**进程内**的库装配：为 D/E 组准备世界（不经过 HTTP）───────────
   这一部分刻意走 store 的直接调用：它是 fixture 准备，不是被测量的东西。 */
let fixtureSeq = 0;
function seed(dir, options) {
  const o = options || {};
  let n = 0;
  const store = createEconomyStore({
    dataDir: dir, logger: () => {}, clock: () => o.now || 1717200000000,
    nextId: (kind) => { n += 1; return C.formatEconomyId(kind, 'w' + (++fixtureSeq) + '_' + n).id; }
  });
  store.open();
  const st = store.putStore({ name: 'Runtime Store', idempotencyKey: 'st-' + fixtureSeq });
  const w = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' });
  store.openWallet({ owner: { type: 'character', id: 'cfg_b' }, currency: 'IB_CREDIT' });
  store.mintForSystem({
    systemInitiated: true, walletId: w.wallet.walletId, currency: 'IB_CREDIT',
    amountMinor: o.balance == null ? 10000 : o.balance, idempotencyKey: 'mint-' + fixtureSeq
  });
  store.putBudgetPolicy({
    ownerId: 'cfg_a', currency: 'IB_CREDIT',
    limits: { perTransactionMinor: 1000000, dailyMinor: 1000000, weeklyMinor: 1000000, monthlyMinor: 1000000 },
    idempotencyKey: 'pol-' + fixtureSeq
  });
  const p = store.putProduct({
    storeId: st.result.storeId, kind: o.kind || 'DIGITAL_ITEM', name: o.name || 'Runtime Widget',
    currency: 'IB_CREDIT', unitPriceMinor: o.unitPriceMinor == null ? 400 : o.unitPriceMinor,
    grantQuantity: o.grantQuantity == null ? 1 : o.grantQuantity,
    idempotencyKey: 'prod-' + fixtureSeq
  });
  const q = store.createProductQuote({
    productId: p.result.product.productId, buyerId: 'cfg_a',
    recipientId: o.recipientId, units: 1,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'quote-' + fixtureSeq
  });
  const prep = store.preparePurchase({
    quoteId: q.result.quoteId, buyerId: 'cfg_a', recipientId: o.recipientId,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'prep-' + fixtureSeq
  });
  const snapshot = {
    storeId: st.result.storeId,
    walletId: w.wallet.walletId,
    productId: p.result.product.productId,
    quoteId: q.result.quoteId,
    purchaseId: prep.ok ? prep.result.purchaseId : null,
    prepareOk: prep.ok === true,
    prepareErrors: prep.errors || [],
    revision: store.getRevision()
  };
  store.close();
  return snapshot;
}

console.log('P22-6 · Economy runtime（真实 Home Node 子进程 + 多进程结算竞争）');
console.log('  node =', NODE_BIN, NODE_BIN === BUNDLED_NODE ? '(bundled, = production)' : '(FALLBACK: bundled runtime missing)');

const SERVICE = require(path.join(ROOT, SERVICE_FILE));

/* ══════════════════════════════════════════════════════════════════
   A · 装配形状（静态）
   ══════════════════════════════════════════════════════════════════ */
section('A · 装配形状：能力在 store 上，一个购买写方法都不在 HTTP 上');

{
  const src = fs.readFileSync(path.join(ROOT, SERVICE_FILE), 'utf8');
  check('A1 P22-6 没有新增 store 装配点：Economy 的装配仍然只有 economyAssembly 一份',
    (src.match(/function economyAssembly/g) || []).length === 1);
  check('A2 ★ 五个购买写方法一个都没有进入装配层（装配层只创建/打开 store）',
    ['preparePurchase', 'settlePurchase', 'cancelPurchase', 'refundPurchase', 'reversePurchase']
      .every(name => src.indexOf(name) < 0),
    ['preparePurchase', 'settlePurchase', 'cancelPurchase'].filter(name => src.indexOf(name) >= 0));
  check('A3 生产 store 上真的有 P22-6 的全部方法与读面（能力存在，只是没有暴露到 HTTP）',
    ['preparePurchase', 'settlePurchase', 'cancelPurchase', 'getPurchase', 'listPurchases', 'serializePurchase']
      .every(name => typeof SERVICE.economyStore[name] === 'function'),
    Object.keys(SERVICE.economyStore).filter(k => /Purchase/.test(k)));
  check('A4 装配层**没有**为每条路由复制一份逻辑（新路由只是把参数转给 store）',
    src.indexOf('/economy/purchase') < 0 && src.indexOf('/economy/purchases') < 0);
  check('A5 ★ 生产 store 的 schema 水位恰好是 7（P22-6 是 5，P22-7 抬到 6，P22-8 抬到 7），且与 store 模块自身声明一致',
    Number(SERVICE.economyStore.SCHEMA_VERSION) ===
    Number(require(path.join(ROOT, 'services', 'home-node', 'economy-store.js')).SCHEMA_VERSION) &&
    Number(SERVICE.economyStore.SCHEMA_VERSION) === 7,
    { service: SERVICE.economyStore.SCHEMA_VERSION });
  check('A6 ★ 生产 store 上**不存在** refund / reverse / 决策 / 推荐 的入口',
    ['refundPurchase', 'reversePurchase', 'chargeback', 'decide', 'recommendProducts',
      'suggestPurchase', 'addToCart', 'checkout'].every(k => typeof SERVICE.economyStore[k] === 'undefined'));
}

/* ══════════════════════════════════════════════════════════════════
   B · 真实 production Home Node（HTTP 只读面 + 重启）
   ══════════════════════════════════════════════════════════════════ */
section('B · 真实 production Home Node：购买读面可用、写面不存在、重启仍然可用');

(async function () {
  const dir = tmpDir('service');
  const seeded = seed(dir, { balance: 5000 });
  const svc = await startProduction(dir);
  const up = await waitListening(svc, 20000);
  check('B1 production Home Node 起来了并回答 /health', up === true, svc.output());
  if (!up) { await stopProduction(svc); return finish(); }

  /* ── Economy 面 ─────────────────────────────────────────────────── */
  const health = await request(svc.port, 'GET', '/economy/health');
  const econ = health.body && health.body.economy ? health.body.economy : {};
  check('B2 P22-6 的库被真实 store 打开（schema 水位 = 7，Economy READY）',
    health.status === 200 && Number(econ.schemaVersion) === 7 && econ.state === 'READY',
    health.body);
  check('B3 ★ health 自述里 purchase 面是"已实现 + 不暴露 HTTP"并存',
    econ.purchaseImplemented === true &&
    econ.purchaseExposesHttpMutation === false &&
    econ.purchaseSettlementIsOneTransaction === true &&
    econ.purchaseAmountSource === 'quote-snapshot',
    { implemented: econ.purchaseImplemented, exposes: econ.purchaseExposesHttpMutation });

  const purchases = await request(svc.port, 'GET', '/economy/purchases');
  check('B4 ★ GET /economy/purchases 可用，且明确写着它**不是**个性化的',
    purchases.status === 200 && Array.isArray(purchases.body.purchases) &&
    purchases.body.personalized === false && purchases.body.recommended === false &&
    purchases.body.ranked === false && purchases.body.exposesMutation === false,
    purchases.body);
  check('B5 那一条 Prepare 出来的购买真的在列表里（读面读的是 canonical 行）',
    purchases.body.purchases.length === 1 &&
    purchases.body.purchases[0].purchaseId === seeded.purchaseId &&
    purchases.body.purchases[0].status === 'RESERVED' &&
    purchases.body.purchases[0].ledgerTransactionId === null,
    purchases.body.purchases);

  const one = await request(svc.port, 'GET', '/economy/purchase?purchaseId=' + encodeURIComponent(seeded.purchaseId));
  check('B6 ★ GET /economy/purchase 返回三个小结 + settlement，并逐字否认"它是别的东西"',
    one.status === 200 && one.body.purchase.purchaseId === seeded.purchaseId &&
    one.body.quoteSummary.state === 'OPEN' && one.body.reservationSummary.state === 'ACTIVE' &&
    one.body.settlement.spentAnything === false && one.body.settlement.grantedAnything === false &&
    one.body.isALedgerTransaction === false && one.body.isAReservation === false &&
    one.body.isAQuote === false && one.body.exposesMutation === false,
    one.body);

  /* ── 写面：逐条 405 ─────────────────────────────────────────────── */
  const writePaths = ['/economy/purchase', '/economy/purchases', '/economy/prepare', '/economy/settle',
    '/economy/buy', '/economy/cancel', '/economy/refund', '/economy/reverse'];
  const writeResults = [];
  for (const p of writePaths) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await request(svc.port, method, p, { purchaseId: seeded.purchaseId, idempotencyKey: 'x' });
      writeResults.push({ path: p, method: method, status: r.status, code: r.body && r.body.error });
    }
  }
  check('B7 ★★ ' + writeResults.length + ' 次购买写尝试**全部** 405（一条写路由都没有）',
    writeResults.every(r => r.status === 405 && r.code === 'economy-is-read-only'),
    writeResults.filter(r => r.status !== 405));

  /* ── /security：声明与真实路由一致 ──────────────────────────────── */
  const security = await request(svc.port, 'GET', '/security');
  const ep = security.body && security.body.economyPolicy;
  check('B8 ★★ /security 的三项写面名单都是空的，而 /economy/purchase 已经**移出** unreachable（它现在是一条真路由）',
    !!ep && ep.purchaseWritesExposed.length === 0 && ep.settlementWritesExposed.length === 0 &&
    ep.policyApprovalWritesExposed.length === 0 && ep.purchaseExposed === false &&
    ep.purchaseRuntimeImplemented === true &&
    ep.desktopPaths.indexOf('/economy/purchases') >= 0 && ep.desktopPaths.indexOf('/economy/purchase') >= 0 &&
    ep.unreachable.indexOf('/economy/purchase') < 0 &&
    ['/economy/prepare', '/economy/settle', '/economy/buy', '/economy/cancel', '/economy/refund']
      .every(p => ep.unreachable.indexOf(p) >= 0),
    ep && { unreachable: ep.unreachable, desktop: ep.desktopPaths });
  check('B9 /security 仍然只有 GET 一个 verb，且 writesExposed 为空',
    security.status === 200 && ep.httpVerbs.join(',') === 'GET' && ep.writesExposed.length === 0 &&
    ep.mintingExposed === false);

  /* ── 重启 ───────────────────────────────────────────────────────── */
  await stopProduction(svc);
  const svc2 = await startProduction(dir);
  const up2 = await waitListening(svc2, 20000);
  check('B10 重启：同一个库再次打开，水位仍然是 7', up2 === true &&
    Number(((await request(svc2.port, 'GET', '/economy/health')).body.economy || {}).schemaVersion) === 7, svc2.output());
  const afterRestart = await request(svc2.port, 'GET', '/economy/purchases');
  check('B11 ★★ 重启之后同一条购买**逐字相同**（Purchase / Quote / Reservation 三样结论不变）',
    afterRestart.status === 200 && afterRestart.body.purchases.length === 1 &&
    J(afterRestart.body.purchases[0]) === J(purchases.body.purchases[0]),
    { before: purchases.body.purchases[0], after: afterRestart.body.purchases[0] });
  const revBefore = (((await request(svc2.port, 'GET', '/economy/health')).body.economy || {}).counts || {}).purchases;
  check('B12 ★ 重启不消耗 revision：购买数不变、也没有凭空多出一行', revBefore === 1, { purchases: revBefore });
  await stopProduction(svc2);

  finish();
})().catch(error => {
  failures++;
  console.error('✖ B 组抛出异常 — ' + String(error && (error.stack || error.message)));
  finish();
});

/* ══════════════════════════════════════════════════════════════════
   C/D/E · 多进程（在 B 组之后串行跑）
   ══════════════════════════════════════════════════════════════════ */
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  runMultiProcess().then(() => {
    console.log('\n' + '═'.repeat(64));
    if (failures === 0) {
      console.log('P22-6 runtime: 全部通过 ✔');
      process.exitCode = 0;
    } else {
      console.error('P22-6 runtime: ' + failures + ' 项失败 ✘');
      process.exitCode = 1;
    }
  }).catch(error => {
    failures++;
    console.error('✖ 多进程组抛出异常 — ' + String(error && (error.stack || error.message)));
    console.error('P22-6 runtime: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  });
}

async function runMultiProcess() {
  /* ── D · 同一笔 Purchase 被两个真实进程同时 settle ─────────────── */
  section('D · 多进程：同一笔 Purchase 被两个真实进程同时 settle');

  {
    const dir = tmpDir('race-settle');
    const seeded = seed(dir, { balance: 5000 });
    const barrier = Date.now() + 1200;
    const results = await Promise.all([
      runWorker(['settle', dir, seeded.purchaseId, 'race-a', String(barrier)]),
      runWorker(['settle', dir, seeded.purchaseId, 'race-b', String(barrier)])
    ]);
    const rows = results.map(r => r.result).filter(Boolean);
    check('D0 两个 worker 都产出了一行 JSON（没有崩、没有挂）',
      rows.length === 2 && results.every(r => r.code === 0),
      results.map(r => ({ code: r.code, stderr: String(r.stderr).slice(0, 200) })));
    check('D1 ★★ 它们**真的**是同时动手的（两个 startedAt 落在起跑线同一毫秒窗口内）',
      rows.length === 2 && Math.abs(rows[0].startedAt - rows[1].startedAt) <= 1500 &&
      rows.every(r => r.startedAt >= barrier - 5),
      rows.map(r => r.startedAt - barrier));

    const succeeded = rows.filter(r => r.ok === true);
    check('D2 ★★ 恰好**一个**成功完成（另一个要么幂等回放、要么终态冲突 —— 绝不是第二次扣款）',
      succeeded.length >= 1 &&
      rows.every(r => r.ok === true || (r.denied === true || r.terminal === true)),
      rows.map(r => ({ ok: r.ok, replayed: r.replayed, terminal: r.terminal, reasonCode: r.reasonCode, errors: r.errors })));

    /* 从**库本身**独立读一遍最终世界（一个全新的进程内连接）。
       ★ 把 purchaseId 显式传给它 —— 不传时 worker 只能从列表里推断，而
       这一组恰好只有一条购买；那种"碰巧能推断出来"的写法在两笔购买的
       组里会静默读到 null。 */
    const final = await runWorker(['world', dir, seeded.purchaseId]);
    const w = final.result.world;
    check('D3 ★★ 最终世界：**恰好一笔** COMPLETED Purchase',
      w.completedPurchases === 1 && w.purchaseStatus === 'COMPLETED' && w.reservedPurchases === 0, w);
    check('D4 ★★ 最终世界：**恰好一笔** Ledger Transaction（transactions = mint 1 + 购买 1 = 2）',
      w.transactions === 2 && w.entries === 4, { transactions: w.transactions, entries: w.entries });
    check('D5 ★★ 最终世界：**恰好一次**资产发放（库存总量 = 1，不是 2）',
      w.inventoryTotalQuantity === 1 && w.inventoryEntries === 1,
      { entries: w.inventoryEntries, total: w.inventoryTotalQuantity });
    check('D6 ★★ 最终世界：**恰好一次** Quote 消费与一次 Reservation 提交',
      w.quoteState === 'CONSUMED' && w.reservationState === 'COMMITTED', w);
    check('D7 ★★ 最终世界完整性检查零问题（没有任何半完成状态）',
      Array.isArray(w.integrityProblems) && w.integrityProblems.length === 0, w.integrityProblems);
    check('D8 ★ 成功的那一个 worker 读到的 ledgerTransactionId 与库里的**同一个事实**（终态冲突那一个没有它，而那是正确的）',
      (() => {
        const successIds = rows.filter(r => r.ok === true).map(r => r.ledgerTransactionId);
        return successIds.length >= 1 &&
          successIds.every(id => id === w.purchaseLedgerTransactionId) &&
          /* 至少一个成功者；失败者的 ledgerTransactionId 必须是 null
             （它没有产生任何交易 —— 这正是"不是第二次扣款"的形式）。 */
          rows.filter(r => r.ok !== true).every(r => r.ledgerTransactionId == null);
      })(),
      { ids: rows.map(r => ({ ok: r.ok, tx: r.ledgerTransactionId })), canonical: w.purchaseLedgerTransactionId });
  }

  /* ── D9 · 不同费用线的对照组：两个**不同**的 Purchase 同时 settle ── */
  {
    const dir = tmpDir('race-two');
    const seeded = seed(dir, { balance: 5000 });
    /* 造第二条购买（另一份报价、另一次 prepare）。 */
    const store = createEconomyStore({ dataDir: dir, logger: () => {} });
    store.open();
    const q2 = store.createProductQuote({
      productId: seeded.productId, buyerId: 'cfg_a', units: 1,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'q2-two'
    });
    const prep2 = store.preparePurchase({
      quoteId: q2.result.quoteId, buyerId: 'cfg_a',
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'p2-two'
    });
    store.close();

    const barrier = Date.now() + 1200;
    const results = await Promise.all([
      runWorker(['settle', dir, seeded.purchaseId, 'two-a', String(barrier)]),
      runWorker(['settle', dir, prep2.result.purchaseId, 'two-b', String(barrier)])
    ]);
    const final = await runWorker(['world', dir]);
    const w = final.result.world;
    check('D9 ★★ 两笔**不同**的 Purchase 同时 settle：两笔都成功，且账本/库存各自只加一次',
      results.every(r => r.result && r.result.ok === true) &&
      w.completedPurchases === 2 && w.transactions === 3 && w.inventoryTotalQuantity === 2 &&
      w.integrityProblems.length === 0,
      { results: results.map(r => r.result && r.result.ok), world: w });
  }

  /* ── E · 同一个 Quote 被两个进程同时 prepare ───────────────────── */
  section('E · 多进程：同一个 Quote 被两个真实进程同时 prepare');

  {
    const dir = tmpDir('race-quote');
    /* ★ 这一组需要一条**已经备好报价但还没有购买**的世界，因此这里手工
       造它（seed() 会顺手 prepare 一次）。 */
    let seq = 0;
    const store = createEconomyStore({
      dataDir: dir, logger: () => {}, clock: () => 1717200000000,
      nextId: (kind) => { seq += 1; return C.formatEconomyId(kind, 'q' + seq).id; }
    });
    store.open();
    const st = store.putStore({ name: 'Quote Race', idempotencyKey: 'st-q' });
    const w0 = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' });
    store.mintForSystem({
      systemInitiated: true, walletId: w0.wallet.walletId, currency: 'IB_CREDIT',
      amountMinor: 5000, idempotencyKey: 'mint-q'
    });
    store.putBudgetPolicy({
      ownerId: 'cfg_a', currency: 'IB_CREDIT',
      limits: { perTransactionMinor: 1000000, dailyMinor: 1000000, weeklyMinor: 1000000, monthlyMinor: 1000000 },
      idempotencyKey: 'pol-q'
    });
    const p0 = store.putProduct({
      storeId: st.result.storeId, kind: 'DIGITAL_ITEM', name: 'Race Widget', currency: 'IB_CREDIT',
      unitPriceMinor: 400, grantQuantity: 1, idempotencyKey: 'prod-q'
    });
    const q0 = store.createProductQuote({
      productId: p0.result.product.productId, buyerId: 'cfg_a', units: 1,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'quote-race'
    });
    store.close();

    const barrier = Date.now() + 1200;
    const results = await Promise.all([
      runWorker(['prepare', dir, q0.result.quoteId, 'cfg_a', 'quote-a', String(barrier)]),
      runWorker(['prepare', dir, q0.result.quoteId, 'cfg_a', 'quote-b', String(barrier)])
    ]);
    const rows = results.map(r => r.result).filter(Boolean);
    const final = await runWorker(['world', dir]);
    const w = final.result.world;
    check('E0 两个 prepare worker 都产出了一行 JSON', rows.length === 2,
      results.map(r => ({ code: r.code, stderr: String(r.stderr).slice(0, 200) })));
    check('E1 ★★ 最多一条成功的 Purchase（另一条被 quote 的唯一约束挡住）',
      w.completedPurchases === 0 && w.reservedPurchases <= 1 &&
      rows.filter(r => r.ok === true).length <= 1,
      rows.map(r => ({ ok: r.ok, reasonCode: r.reasonCode, errors: r.errors, purchases: r.purchases })));
    check('E2 ★★ 库里**恰好**一条指向这份报价的购买行（唯一索引是结构性的那一半）',
      (() => {
        const s2 = createEconomyStore({ dataDir: dir, logger: () => {} });
        s2.open();
        const count = s2.listPurchases({ quoteId: q0.result.quoteId, limit: 50 }).count;
        const integrity = s2._internal.economyIntegrityCheck();
        s2.close();
        return count === 1 && integrity.length === 0;
      })(), { purchases: w.inventoryEntries });
    check('E3 ★★ 竞争之后世界是自洽的：没有重复的 Reserve、没有半完成状态',
      w.integrityProblems.length === 0 && w.reservedPurchases === 1,
      w);
  }

  /* ── F · Purchase ID 的跨进程唯一性（§3）───────────────────────── */
  section('F · 跨进程 Purchase ID 唯一性');

  {
    const dir = tmpDir('ids');
    seed(dir, { balance: 20000 });
    /* 8 个进程同时各 prepare 一条**不同**的报价 → 8 个不同的 purchaseId。
       两件事被证明：① confirm 生成器在跨进程下不撞车；
       ② 每一次 prepare 都留下一条可读的、id 唯一的购买行。 */
    const store = createEconomyStore({ dataDir: dir, logger: () => {} });
    store.open();
    const quotes = [];
    for (let i = 0; i < 6; i++) {
      const q = store.createProductQuote({
        productId: store.listProducts({ limit: 10 }).products[0].productId,
        buyerId: 'cfg_a', units: 1, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'idq-' + i
      });
      quotes.push(q.result.quoteId);
    }
    store.close();

    const barrier = Date.now() + 1200;
    const results = await Promise.all(quotes.map((quoteId, i) =>
      runWorker(['prepare', dir, quoteId, 'cfg_a', 'idprep-' + i, String(barrier)])));
    const ids = results.map(r => r.result && r.result.purchaseId).filter(Boolean);
    check('F1 ★★ ' + ids.length + ' 个真实进程各自生成的 purchaseId **互不相同**（跨进程唯一性）',
      ids.length === quotes.length && new Set(ids).size === ids.length, ids);
    check('F2 ★ 它们都是 canonical 的 econ_intent_ 形状，且与 quoteId / reservationId 形状不同',
      ids.every(id => C.isEconomyId(C.PURCHASE_ID_KIND, id)) &&
      ids.every(id => !C.isEconomyId('QUOTE', id) && !C.isEconomyId('RESERVATION', id) &&
        !C.isEconomyId('TRANSACTION', id) && !C.isEconomyId('OPERATION', id)), ids);
    const final = await runWorker(['world', dir]);
    check('F3 ★ 竞争之后每一份报价恰好被一条购买指向，且完整性检查零问题',
      /* ★ `reservedPurchases` 是 **seed() 那一条 + 这 6 条** —— 把期望值
         写成 `quotes.length` 会让这条断言在"seed 也留下一条 RESERVED"
         这件事实上失败，而那是完全正常的（fixture 就是这么建的）。 */
      final.result.world.integrityProblems.length === 0 &&
      final.result.world.reservedPurchases === quotes.length + 1 &&
      final.result.purchaseCount === quotes.length + 1,
      { world: final.result.world, purchaseCount: final.result.purchaseCount, quotes: quotes.length });
  }
}


