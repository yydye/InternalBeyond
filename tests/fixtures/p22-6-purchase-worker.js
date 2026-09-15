'use strict';
/* ====================================================================
   P22-6 · 多进程竞争用的 worker（fixture，不是测试）
   --------------------------------------------------------------------
   它由 tests/test_p22_6_economy_runtime.js 的 D / E 组 spawn 若干份，用来
   证明两件在多进程下**才**可能被证伪的事：

     D · 同一个 Purchase 被两个**真实进程**同时 settle
           → 恰好一笔 COMPLETED Purchase、恰好一笔 Ledger Transaction、
             恰好一次资产发放、恰好一次 Quote 消费；另一个要么是幂等
             回放，要么是终态冲突。**绝不能双扣 / 双发。**
     E · 同一个 Quote 被两个进程同时 prepare
           → 最多一条成功的 Purchase（另一条被唯一约束挡住）。

   为什么必须是真进程（与 P22-3 的 reserve worker / P22-5 的 consume
   worker 逐字同源）：node:sqlite 的 DatabaseSync 是同步 API，单线程里两次
   settle 不可能交错，因此"原子边界"在单进程内无法被证伪。

   模式：
     mode=settle  node p22-6-purchase-worker.js settle  <dir> <purchaseId> <key> <barrierMs>
     mode=prepare node p22-6-purchase-worker.js prepare <dir> <quoteId> <buyerId> <key> <barrierMs>

   输出：一行 JSON。
   ==================================================================== */

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));

const argv = process.argv.slice(2);
const mode = String(argv[0] || '');

function out(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}
function waitUntil(epochMs) {
  const b = Number(epochMs);
  if (!Number.isFinite(b)) return;
  /* 忙等（不是 sleep 一个模糊的时长）：所有 worker 在同一个墙钟时刻之后
     才动手，偏差收敛到毫秒级。 */
  while (Date.now() < b) { /* 起跑线 */ }
}
/* 与真实业务无关的通用读数：任何一条路径返回之前都把它带上，于是"最终
   世界是什么样"由每一个 worker 各自独立读一遍。 */
function worldOf(store, purchaseId) {
  const h = store.health().counts;
  const purchase = purchaseId ? store.getPurchase(purchaseId) : null;
  return {
    transactions: h.transactions,
    entries: h.entries,
    completedPurchases: h.completedPurchases,
    reservedPurchases: h.reservedPurchases,
    purchaseStatus: purchase && purchase.ok ? purchase.purchase.status : null,
    purchaseLedgerTransactionId: purchase && purchase.ok ? purchase.purchase.ledgerTransactionId : null,
    quoteState: purchase && purchase.ok ? purchase.quoteSummary.state : null,
    reservationState: purchase && purchase.ok ? purchase.reservationSummary.state : null,
    inventoryEntries: h.inventoryEntries,
    inventoryTotalQuantity: h.inventoryTotalQuantity,
    integrityProblems: store._internal.economyIntegrityCheck()
  };
}

(async function main() {
  const store = createEconomyStore({ dataDir: argv[1], logger: () => { } });
  store.open();

  if (mode === 'settle') {
    const [, dataDir, purchaseId, key, barrier] = argv;
    waitUntil(barrier);
    const startedAt = Date.now();
    const result = store.settlePurchase({ purchaseId: purchaseId, idempotencyKey: key });
    out({
      worker: key, mode: mode, startedAt: startedAt, finishedAt: Date.now(),
      ok: result.ok === true,
      replayed: result.replayed === true,
      denied: result.denied === true,
      terminal: result.terminal === true,
      reasonCode: result.reasonCode || null,
      errors: result.errors || [],
      ledgerTransactionId: result.result ? result.result.ledgerTransactionId : null,
      world: worldOf(store, purchaseId)
    });
    store.close();
    return;
  }

  if (mode === 'prepare') {
    const [, dataDir, quoteId, buyerId, key, barrier] = argv;
    waitUntil(barrier);
    const startedAt = Date.now();
    const result = store.preparePurchase({
      quoteId: quoteId, buyerId: buyerId,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key
    });
    out({
      worker: key, mode: mode, startedAt: startedAt, finishedAt: Date.now(),
      ok: result.ok === true,
      replayed: result.replayed === true,
      denied: result.denied === true,
      reasonCode: result.reasonCode || null,
      errors: result.errors || [],
      purchaseId: result.result ? result.result.purchaseId : null,
      purchases: store.listPurchases({ limit: 100 }).count,
      world: worldOf(store, result.result ? result.result.purchaseId : null)
    });
    store.close();
    return;
  }

  /* ── world：只读一个库并把世界读出来（对照组用）────────────────── */
  if (mode === 'world') {
    /* ★ 不给 purchaseId 时**从列表里取那一条**（只在恰好一条时才推断）——
       否则 worldOf 会返回一串 null（"这条购买的状态是什么"没有答案），
       而依赖它的断言会在 null 上静默失败。 */
    const list = store.listPurchases({ limit: 100 }).purchases;
    const target = argv[2] || (list.length === 1 ? list[0].purchaseId : null);
    out({ worker: 'world', mode: mode, purchaseCount: list.length, world: worldOf(store, target) });
    store.close();
    return;
  }

  out({ worker: 'unknown', ok: false, error: 'unknown-mode:' + mode });
  store.close();
  process.exit(1);
})().catch(error => {
  out({ worker: argv[argv.length - 2] || 'unknown', mode: mode, ok: false, crash: String(error && (error.stack || error.message || error)) });
  process.exit(1);
});
