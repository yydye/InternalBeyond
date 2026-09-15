'use strict';
/* ====================================================================
   P22-5 · 多进程竞争用的 worker（fixture，不是测试）
   --------------------------------------------------------------------
   它由 tests/test_p22_5_economy_runtime.js 的 E 组 spawn 若干份，用来证明
   "两个**真实进程**同时 consume 不可能把库存扣成负数"。

   为什么必须是真的多进程（与 P22-3 的 reserve worker 逐字同源）：
   node:sqlite 的 DatabaseSync 是同步 API，同一线程里两次 consume 不可能
   交错。因此"并发安全"在单进程内**无法被证伪**，只能在多个真实进程之间
   证 —— 而这也正是它在 P22-5 §16 里唯一有意义的定义：两个各自持有独立
   SQLite 连接的操作者，同时试图扣同一行库存。

   用法（全部经 argv，不读环境变量，避免污染）：
     node p22-5-consume-worker.js <dataDir> <ownerId> <productId> <quantity>
          <idempotencyKey> <barrierEpochMs>
   输出：一行 JSON { ok, replayed, reasonCode, errors, quantity, ... }
   ==================================================================== */

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));

const [dataDir, ownerId, productId, quantityRaw, idempotencyKey, barrierRaw] = process.argv.slice(2);

function out(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

(async function main() {
  const store = createEconomyStore({ dataDir: dataDir, logger: () => { } });
  store.open();
  /* ── 起跑线：所有 worker 在同一个墙钟时刻之后才动手 ───────────────
     没有它，进程启动快慢会让"同时"退化成"依次"，而依次是单进程测试
     已经证明过的那件事。忙等（不是 sleep 一个模糊的时长）让偏差收敛到
     毫秒级。 */
  const barrier = Number(barrierRaw);
  if (Number.isFinite(barrier)) {
    while (Date.now() < barrier) { /* 忙等到起跑线 */ }
  }
  const result = store.consumeInventory({
    ownerId: ownerId,
    productId: productId,
    quantity: Number(quantityRaw),
    idempotencyKey: idempotencyKey
  });
  out({
    worker: idempotencyKey,
    startedAt: Date.now(),
    ok: result.ok === true,
    replayed: result.replayed === true,
    denied: result.denied === true,
    reasonCode: result.reasonCode || null,
    errors: result.errors || [],
    quantity: result.result ? result.result.quantity : null,
    available: result.available === undefined ? null : result.available,
    /* 独立连接上再读一次 canonical 数量：它必须与写回的结果一致，而且
       永远 ≥ 0。 */
    canonicalQuantity: store.inventoryQuantity(ownerId, productId).quantity
  });
  store.close();
})().catch(error => {
  out({ worker: idempotencyKey, ok: false, crash: String(error && (error.stack || error.message || error)) });
  process.exit(1);
});
