'use strict';
/* ====================================================================
   P22-26 · 多进程竞争用的 worker（fixture，不是测试）
   --------------------------------------------------------------------
   它由 tests/test_p22_26_inventory_consume.js 的 E 组 spawn 若干份，用来证明
   那条新增的消耗缝（`consumeOwnedItem`）在**两个真实进程**同时扣同一行
   库存时不可能把数量扣成负数。

   ── 为什么它不能复用 P22-5 的那个 fixture ─────────────────────────────
   `tests/fixtures/p22-5-consume-worker.js` 调的是 `store.consumeInventory`
   （P22-5 的**底层 primitive**），而 P22-5 的库里的商品是 `DIGITAL_ITEM`
   —— 那是正确的：primitive 对 assetKind 负责，不对"这件东西该不该被消耗"
   负责。P22-26 的缝多了一条判据（只有 `CONSUMABLE` 能被用掉），因此它
   必须有自己的 worker 与自己的 `CONSUMABLE` 商品。
   ★ 把一个夹具改成另一个夹具的调用会静默改变 P22-5 证明了什么，因此这里
   是**新增**一个文件，而不是修改那一个。

   用法（全部经 argv，不读环境变量，避免污染）：
     node p22-26-consume-item-worker.js <dataDir> <ownerId> <productId>
          <quantity> <idempotencyKey> <barrierEpochMs>
   输出：一行 JSON { ok, replayed, denied, reasonCode, errors, quantity,
                     canonicalQuantity, ledgerMutation, walletMutation }
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
     没有它，进程启动快慢会让"同时"退化成"依次"，而依次是单进程测试已经
     证明过的那件事。忙等（不是 sleep 一个模糊的时长）让偏差收敛到毫秒级。 */
  const barrier = Number(barrierRaw);
  if (Number.isFinite(barrier)) {
    while (Date.now() < barrier) { /* 忙等到起跑线 */ }
  }
  /* ★ owner 由**权威上下文**给出（这里就是调用它的测试进程交给 worker 的
     argv），payload 里刻意**没有** ownerId —— 这条缝不读它。 */
  const result = store.consumeOwnedItem({
    productId: productId,
    quantity: Number(quantityRaw),
    idempotencyKey: idempotencyKey
  }, {
    ownerId: ownerId,
    ownerType: 'character'
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
    previousQuantity: result.result ? result.result.previousQuantity : null,
    delta: result.result ? result.result.delta : null,
    ledgerMutation: result.result ? result.result.ledgerMutation === true : null,
    walletMutation: result.result ? result.result.walletMutation === true : null,
    ownerFromAuthorityContext: result.result ? result.result.ownerFromAuthorityContext === true : null,
    /* 独立连接上再读一次 canonical 数量：它必须与写回的结果一致，而且
       永远 ≥ 0。 */
    canonicalQuantity: store.inventoryQuantity(ownerId, productId).quantity
  });
  store.close();
})().catch(error => {
  out({ worker: idempotencyKey, ok: false, crash: String(error && (error.stack || error.message || error)) });
  process.exit(1);
});
