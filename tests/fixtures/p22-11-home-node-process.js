'use strict';
/* ====================================================================
   P22-11 · Home Node fixture（真实生产启动路径 + **测试专用**种子面）
   --------------------------------------------------------------------
   它 require 的就是 services/home-node-service.js，并且**按它的正常主模块
   路径启动**（openAll() → server.listen → 同一份 economyAssembly）。
   唯一的额外东西是一个测试专用的种子路由：

     POST /__p22_11/seed  { agentId, currency? }
       → registry.putCharacters 登记角色（网关注册那条既有路径）
       → store.openWallet / mintForSystem / putStore / putProduct /
         putBudgetPolicy / putAutonomyPolicy

   ── 为什么不直接 open 这个进程的 SQLite 文件 ─────────────────────────
   那样"钱真的动了"就变成另一个进程写的、另一个连接读的，而这条测试
   要证明的恰恰是**权威进程自己**完成了一次结算。种子必须由同一个权威
   进程建立 —— 与 P22-6/P22-7/P22-8 既有的多进程测试同款纪律。
   ★ 这些是 store 的**内部 API**，它们不在任何 HTTP 路由上（/economy/*
   全是 GET），因此这条种子面是"测试替身"，不是产品能力：它只在
   `IB_P22_11_SEED=on` 且父进程显式给了端口时存在（否则连一个 listener
   都不会被创建）。

   用法（只被 tests/test_p22_11_economy_active_bridge.js 使用）：
     node tests/fixtures/p22-11-home-node-process.js --seed-port=24941
   ==================================================================== */

const http = require('node:http');

const SEED_PORT = (() => {
  const fromArg = (process.argv.find(a => a.indexOf('--seed-port=') === 0) || '').split('=')[1];
  const n = Number(fromArg);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
})();
const ENABLED = String(process.env.IB_P22_11_SEED || '') === 'on' && SEED_PORT != null;
const PORT = Math.max(1, Math.min(65535, Number(process.env.IB_HOME_NODE_PORT) || 23118));
const SEED_PATH = '/__p22_11/seed';

const service = require('../../services/home-node-service.js');

/* 主模块路径：与 services/home-node-service.js 自己的启动路径逐字相同。 */
service.openAll();
service.installHomeNodeStopRoute(() => service.server.close(() => process.exit(0)));
service.server.listen(PORT, '127.0.0.1', () => {
  console.log('p22-11-home-node-fixture listening on ' + PORT + ' pid=' + process.pid);
});

if (ENABLED) {
  const store = service.economyStore;
  const registry = service.registry;

  function seed(body) {
    const agentId = String((body && body.agentId) || '');
    const currency = String((body && body.currency) || 'IB_CREDIT');
    if (!agentId) return { status: 400, payload: { ok: false, error: 'agentId is required' } };

    /* ① 角色必须真的存在：ownerExists 的 canonical 来源是注册表。
          走 putCharacters（网关注册那条既有 WAL 路径），不绕过它。 */
    const written = registry.putCharacters([{
      id: agentId, dto: { id: agentId, name: 'P22-11 Fixture' }, spec: null
    }], {});
    if (!written || written.ok !== true) return { status: 500, payload: { ok: false, step: 'putCharacters', written: written } };

    /* ② 钱包 + 铸币 + 货架 + 商品 + 预算 + 自主政策（store 的内部 API）。 */
    const wallet = store.openWallet({ owner: { type: 'character', id: agentId }, currency: currency });
    if (!wallet || wallet.ok !== true) return { status: 500, payload: { ok: false, step: 'openWallet', wallet: wallet } };
    const mint = store.mintForSystem({
      systemInitiated: true, walletId: wallet.wallet.walletId, currency: currency,
      amountMinor: 1000000, idempotencyKey: 'p22-11-fixture-mint'
    });
    if (!mint || mint.ok !== true) return { status: 500, payload: { ok: false, step: 'mintForSystem', mint: mint } };

    const storeRow = store.putStore({ name: 'P22-11 Fixture Store', idempotencyKey: 'p22-11-fixture-store' });
    if (!storeRow || storeRow.ok !== true) return { status: 500, payload: { ok: false, step: 'putStore', store: storeRow } };
    const product = store.putProduct({
      storeId: storeRow.result.store.storeId, kind: 'COMPUTE_CREDIT', name: 'Compute x1000', currency: currency,
      unitPriceMinor: 10, grantQuantity: 1000, idempotencyKey: 'p22-11-fixture-product'
    });
    if (!product || product.ok !== true) return { status: 500, payload: { ok: false, step: 'putProduct', product: product } };

    const budget = store.putBudgetPolicy({
      ownerId: agentId, currency: currency,
      limits: { perTransactionMinor: 1000000, dailyMinor: 1000000, weeklyMinor: 1000000, monthlyMinor: 1000000 },
      idempotencyKey: 'p22-11-fixture-budget'
    });
    if (!budget || budget.ok !== true) return { status: 500, payload: { ok: false, step: 'putBudgetPolicy', budget: budget } };

    const autonomy = store.putAutonomyPolicy({
      ownerId: agentId, currency: currency, enabled: true, perPurchaseLimitMinor: 1000000,
      dailyAutonomousLimitMinor: 1000000, approvalAboveMinor: 1000000,
      allowedProductKinds: ['COMPUTE_CREDIT'], allowedSettlementTypes: ['COMPUTE_GRANT'],
      allowGift: false, idempotencyKey: 'p22-11-fixture-autonomy'
    });
    if (!autonomy || autonomy.ok !== true) return { status: 500, payload: { ok: false, step: 'putAutonomyPolicy', autonomy: autonomy } };

    return {
      status: 200,
      payload: {
        ok: true, agentId: agentId, currency: currency,
        productId: product.result.product.productId,
        storeId: storeRow.result.store.storeId,
        walletId: wallet.wallet.walletId
      }
    };
  }

  const seedServer = http.createServer((request, response) => {
    function json(status, payload) {
      const body = JSON.stringify(payload);
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
      response.end(body);
    }
    if (request.method !== 'POST' || String(request.url).split('?')[0] !== SEED_PATH) {
      json(404, { error: 'not-found' });
      return;
    }
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      try {
        const outcome = seed(body);
        json(outcome.status, outcome.payload);
      } catch (error) {
        json(500, { ok: false, error: String(error && error.message || error).slice(0, 300) });
      }
    });
  });
  seedServer.listen(SEED_PORT, '127.0.0.1', () => {
    console.log('p22-11-home-node-fixture seed surface on ' + SEED_PORT);
  });
}
