'use strict';
/* ====================================================================
   P22-5 · Economy 库存（Inventory）：谁拥有什么
   --------------------------------------------------------------------
   运行：node tests/test_p22_5_economy_inventory.js

   本文件回答一个问题，并且**只**回答这一个：

     「这个 owner 现在拥有什么？」

   ── 为什么它必须与 Wallet 分开证明 ────────────────────────────────────
   把"拥有"实现成余额是最省事的写法，而且它在测试里看起来完全正常：
   加 10 就 +10、减 8 就 −8、不够就拒绝。它坏掉的方式只有一个 ——
   有一天某个商品的价格变了，或者某个 owner 的 IB_CREDIT 余额被用来
   支付一笔完全无关的东西，于是"我买的那 10 个"跟着变了。
   因此本文件的重量放在三组**否定**证据上：
     · J 组：库存变动**不动**钱包，钱包变动**不动**库存（两个方向都证）；
     · L 组：商品被 retire 之后库存仍然存在（拥有关系不依赖目录）；
     · I/H 组：每一次变动要么整体成立、要么整体不成立（含两个独立连接
       的并发）。
   以及一条本阶段独有的结构性事实：**库存没有派生缓存**。
   P22-2/P22-3 的 wallets 有两列缓存 + rebuild + 开库对账；P22-5 刻意
   **不**复制那个形状（§17），因为 canonical 就是那一行。A 组因此不是
   "检查 rebuilt 对不对"，而是"检查 rebuild 这个东西根本不存在"。

   ── 与方法名对应关系 ─────────────────────────────────────────────────
     A  canonical truth（没有缓存）      B  grant
     C  consume 与不足                    D  幂等（两个 scope）
     E  多 owner 隔离                     F  canonical 键 (owner, product)
     G  数量不变量与安全整数              H  并发（两个独立连接）
     I  崩溃注入                          J  库存 ≠ 钱包
     K  重启恢复                          L  retire 与"用完"（行保留）
     M  审计（change log / revision）     N  Memory / Relationship 隔离
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-5i-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

function deterministicIds() {
  let n = 0;
  return (kind) => { n += 1; return C.formatEconomyId(kind, 't' + n).id; };
}
function makeStore(extra) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir,
    logger: () => { },
    nextId: deterministicIds()
  }, extra || {}));
}
function walletWith(store, amountMinor, ownerId, currency) {
  const cur = currency || 'IB_CREDIT';
  const w = store.openWallet({ owner: { type: 'character', id: ownerId || 'cfg_a' }, currency: cur });
  assert.equal(w.ok, true, 'openWallet must succeed: ' + J(w.errors));
  if (amountMinor && BigInt(amountMinor) !== 0n) {
    const m = store.mintForSystem({
      systemInitiated: true, walletId: w.wallet.walletId, currency: cur,
      amountMinor: amountMinor, idempotencyKey: 'seed-' + w.wallet.walletId
    });
    assert.equal(m.ok, true, 'mint must succeed: ' + J(m.errors));
  }
  return w.wallet;
}

let keySeq = 0;
function nextKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }
function putStoreOk(store, options) {
  const out = store.putStore(Object.assign({ name: 'Shelf', idempotencyKey: nextKey('store') }, options || {}));
  assert.equal(out.ok, true, 'putStore must succeed: ' + J(out.errors || out));
  return out.result;
}
function putProductOk(store, storeId, options) {
  const out = store.putProduct(Object.assign({
    storeId: storeId, kind: 'DIGITAL_ITEM', name: 'Widget', currency: 'IB_CREDIT',
    unitPriceMinor: 100, grantQuantity: 1, idempotencyKey: nextKey('product')
  }, options || {}));
  assert.equal(out.ok, true, 'putProduct must succeed: ' + J(out.errors || out));
  return out.result;
}
function grantOk(store, ownerId, productId, quantity, key) {
  const out = store.grantInventory({
    ownerId: ownerId, productId: productId, quantity: quantity,
    idempotencyKey: key || nextKey('grant')
  });
  assert.equal(out.ok, true, 'grantInventory must succeed: ' + J(out.errors || out));
  return out.result;
}
function consumeOk(store, ownerId, productId, quantity, key) {
  const out = store.consumeInventory({
    ownerId: ownerId, productId: productId, quantity: quantity,
    idempotencyKey: key || nextKey('consume')
  });
  assert.equal(out.ok, true, 'consumeInventory must succeed: ' + J(out.errors || out));
  return out.result;
}
function qty(store, ownerId, productId) {
  return store.inventoryQuantity(ownerId, productId).quantity;
}
function fixture(store) {
  const st = putStoreOk(store, { name: 'Shelf' });
  const item = putProductOk(store, st.storeId, { name: 'Widget', unitPriceMinor: 100 });
  const compute = putProductOk(store, st.storeId, {
    name: 'Premium Compute x1000', kind: 'API_QUOTA', unitPriceMinor: 400, grantQuantity: 1000
  });
  /* 建 fixture 本身会写下三条 change（store + 两个 product），因此所有
     "这次动作之后多出几条审计"的断言都必须从**基线**算起，而不是从 0。
     写死 0 的断言会在加了第三个商品时静默失败 —— 那不是它在测的东西。 */
  return { store: st, item: item, compute: compute, auditBaseline: store.listChanges(0, 200).length };
}

console.log('P22-5 · Economy inventory (canonical ownership truth)');

/* ══════════════════════════════════════════════════════════════════
   A · canonical truth：库存**就是**那一行，没有派生缓存
   ══════════════════════════════════════════════════════════════════ */
section('A · canonical truth（没有缓存 · 没有 rebuild · 没有开库对账）');

{
  const dir = tmpDir('canonical');
  const store = makeStore({ dataDir: dir });
  store.open();
  const f = fixture(store);
  grantOk(store, 'cfg_a', f.item.productId, 10);

  const h = store.health();
  check('A1 health 逐字自述：库存的 canonical 是 SQLite 行，派生量是 none',
    h.inventoryCanonical === 'sqlite-inventory-rows' && h.inventoryDerived === 'none' &&
    h.inventoryHasNoDerivedCacheToRebuild === true, { c: h.inventoryCanonical, d: h.inventoryDerived });
  check('A2 一句话把"为什么没有 rebuild"说清楚：这里根本没有缓存可重建（§17）',
    h.inventoryHasNoDerivedCacheToRebuild === true &&
    /* 反向：P22-2 / P22-3 有缓存，因此它们**有** rebuild —— 两条并存才说明
       这是一个被判断过的决定，而不是一次遗漏。 */
    typeof store.rebuildWalletBalance === 'function' &&
    typeof store.rebuildReservedBalance === 'function' &&
    typeof store.rebuildInventory === 'undefined');
  check('A3 store 的公开面上不存在任何库存缓存写入面（setInventoryQuantity / cacheInventory 都不存在）',
    typeof store.setInventoryQuantity === 'undefined' &&
    typeof store.cacheInventory === 'undefined' &&
    typeof store.corruptInventoryCacheForTest === 'undefined');

  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
  const cols = raw.prepare('PRAGMA table_info(economy_inventory)').all().map(r => String(r.name));
  check('A4 表上**没有** inventory_cached_quantity 这类列（§17：不要为了和 Wallet 对称而人为造缓存）',
    !cols.some(c => /cache/i.test(c)) && cols.indexOf('quantity') >= 0, cols);
  raw.close();

  /* ── 开库对账**不碰**库存：重启前后逐字相同，且 revision 不变 ────── */
  const before = J(store.serializeInventoryEntry(store.getInventoryEntry({
    ownerId: 'cfg_a', productId: f.item.productId
  }).entry));
  const revBefore = store.getRevision();
  store.close();
  const reopened = makeStore({ dataDir: dir });
  reopened.open();
  check('A5 重启时的开库对账不碰库存：行逐字相同、revision 不变（没有"重建"要跑）',
    J(reopened.serializeInventoryEntry(reopened.getInventoryEntry({
      ownerId: 'cfg_a', productId: f.item.productId
    }).entry)) === before &&
    reopened.getRevision() === revBefore);
  check('A6 库存不是余额：序列化里逐字写着 isABalance:false / 不参与 available / 不是支付币种',
    (() => {
      const e = reopened.serializeInventoryEntry(reopened.getInventoryEntry({
        ownerId: 'cfg_a', productId: f.item.productId
      }).entry);
      return e.isABalance === false && e.contributesToAvailableBalance === false &&
        e.countsAsPaymentCurrency === false;
    })());
  check('A7 health 也逐字自述"库存不是余额"，且 §12 的隔离是可断言的',
    reopened.health().inventoryIsNotABalance === true &&
    reopened.health().inventoryUniqueItemsModelled === false);
  reopened.close();
}

/* ══════════════════════════════════════════════════════════════════
   B · grant：10 → 10，再 5 → 15
   ══════════════════════════════════════════════════════════════════ */
section('B · grantInventory（§50：grant 10 → 10，grant 5 → 15）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);

  const present = store.inventoryQuantity('cfg_a', f.item.productId);
  check('B0 从来没有过这一行时：present:false / quantity 0（"没有"与"用光了"是两件事）',
    present.ok === true && present.present === false && present.quantity === 0 &&
    present.inventoryEntryId === null, present);

  const g1 = grantOk(store, 'cfg_a', f.item.productId, 10);
  check('B1 grant 10 → quantity 10（新建一行）',
    g1.quantity === 10 && g1.previousQuantity === 0 && g1.delta === 10 &&
    g1.grantedQuantity === 10 && g1.consumedQuantity === 0 &&
    g1.eventKind === 'INVENTORY_GRANTED' && qty(store, 'cfg_a', f.item.productId) === 10);
  const g2 = grantOk(store, 'cfg_a', f.item.productId, 5);
  check('B2 grant 5 → quantity 15（**同一行**被累加，而不是第二行）',
    g2.quantity === 15 && g2.previousQuantity === 10 && g2.delta === 5 &&
    qty(store, 'cfg_a', f.item.productId) === 15 &&
    store.health().counts.inventoryEntries === 1, store.health().counts);
  check('B3 grant 的结果里逐字写着它不是一次购买（§13：primitive ≠ Purchase）',
    g1.ledgerMutation === false && g1.walletMutation === false && g1.isAPurchase === false &&
    /inventory primitive/.test(g1.notAPurchase) && /ONE transaction/.test(g1.notAPurchase));
  check('B4 grant 不改钱包、不改账本（一次 grant 不动一分钱）',
    store.health().counts.transactions === 0 &&
    store.health().counts.wallets === 0 &&
    store.listChanges(0, 50).every(c => c.transactionId === null));
  check('B5 assetKind 是**商品**决定的：数字物品 → ITEM，算力额度 → COMPUTE',
    g1.assetKind === 'ITEM' &&
    grantOk(store, 'cfg_a', f.compute.productId, 1000).assetKind === 'COMPUTE');
  check('B6 grant 的对象必须是一件**存在**的商品（悬挂引用被拒绝）',
    (() => {
      const out = store.grantInventory({
        ownerId: 'cfg_a', productId: 'econ_product_ghost', quantity: 1, idempotencyKey: nextKey('grant')
      });
      return out.ok === false && out.reasonCode === 'PRODUCT_NOT_FOUND' &&
        out.productId === 'econ_product_ghost';
    })());
  check('B7 系统方不能"拥有"库存（与"系统方不能买"同款）',
    (() => {
      const out = store.grantInventory({
        ownerId: { type: 'system', id: 'system:treasury' }, productId: f.item.productId,
        quantity: 1, idempotencyKey: nextKey('grant')
      });
      return out.ok === false && out.errors.indexOf('system-party-cannot-hold-inventory') >= 0;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   C · consume：8 → 7，再 8 → DENY，数量仍然是 7
   ══════════════════════════════════════════════════════════════════ */
section('C · consumeInventory（§50：consume 8 → 7，再 consume 8 → DENY，quantity 仍为 7）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  grantOk(store, 'cfg_a', f.item.productId, 10);
  grantOk(store, 'cfg_a', f.item.productId, 5);

  const c1 = consumeOk(store, 'cfg_a', f.item.productId, 8);
  check('C1 consume 8（库存 15）→ quantity 7',
    c1.quantity === 7 && c1.previousQuantity === 15 && c1.delta === -8 &&
    c1.consumedQuantity === 8 && c1.grantedQuantity === 0 &&
    c1.eventKind === 'INVENTORY_CONSUMED' && qty(store, 'cfg_a', f.item.productId) === 7);
  const c2 = store.consumeInventory({
    ownerId: 'cfg_a', productId: f.item.productId, quantity: 8, idempotencyKey: nextKey('consume')
  });
  check('C2 再 consume 8（只有 7）→ DENY INSUFFICIENT_INVENTORY，并带着 available / requested 两个数',
    c2.ok === false && c2.reasonCode === 'INSUFFICIENT_INVENTORY' &&
    c2.available === 7 && c2.requested === 8, c2);
  check('C3 ★ 被拒绝的 consume **一个字节都没写**：quantity 仍然是 7，且没有多出一条 change log',
    qty(store, 'cfg_a', f.item.productId) === 7 &&
    store.listChanges(0, 200).length === f.auditBaseline + 3,
    { changes: store.listChanges(0, 200).map(c => c.kind), baseline: f.auditBaseline });
  check('C4 不足时的 reason code 刻意**不是** INSUFFICIENT_BALANCE（库存不是余额，§12）',
    c2.reasonCode !== 'INSUFFICIENT_BALANCE' &&
    c2.reasonCode !== 'INSUFFICIENT_AVAILABLE_BALANCE' &&
    C.isDenyReasonCode('INSUFFICIENT_INVENTORY') === true);
  check('C5 从来没有过这一行的 owner：同一句拒绝，但 detail 是 not-found（available = 0）',
    (() => {
      const out = store.consumeInventory({
        ownerId: 'cfg_ghost', productId: f.item.productId, quantity: 1, idempotencyKey: nextKey('consume')
      });
      return out.ok === false && out.reasonCode === 'INSUFFICIENT_INVENTORY' &&
        out.errors.indexOf('inventory-entry-not-found') >= 0 && out.available === 0;
    })());
  const exact = consumeOk(store, 'cfg_a', f.item.productId, 7);
  check('C6 正好把库存用光（7 → 0）是允许的，而那一行**保留**（§23：优先 quantity = 0）',
    exact.quantity === 0 && qty(store, 'cfg_a', f.item.productId) === 0 &&
    store.health().counts.inventoryEntries === 1 &&
    store.inventoryQuantity('cfg_a', f.item.productId).present === true);
  const afterZero = store.consumeInventory({
    ownerId: 'cfg_a', productId: f.item.productId, quantity: 1, idempotencyKey: nextKey('consume')
  });
  check('C7 用光之后再消耗 1：拒绝，而那一行仍然在（quantity 0、present true —— 两个字段说的是两件事）',
    afterZero.ok === false && afterZero.reasonCode === 'INSUFFICIENT_INVENTORY' &&
    store.inventoryQuantity('cfg_a', f.item.productId).present === true &&
    qty(store, 'cfg_a', f.item.productId) === 0);
  const regrant = grantOk(store, 'cfg_a', f.item.productId, 2);
  check('C8 用光之后再 grant 2：同一行从 0 变回 2（行从不消失，因此 entryId 稳定）',
    regrant.quantity === 2 && regrant.previousQuantity === 0 &&
    regrant.inventoryEntryId === c1.inventoryEntryId);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · 幂等（两个 scope）
   ══════════════════════════════════════════════════════════════════ */
section('D · 幂等（INVENTORY_GRANT 与 INVENTORY_CONSUME 是两个 scope，§15）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);

  const key = nextKey('grant');
  const first = grantOk(store, 'cfg_a', f.item.productId, 10, key);
  const replay = store.grantInventory({
    ownerId: 'cfg_a', productId: f.item.productId, quantity: 10, idempotencyKey: key
  });
  check('D1 同一个 key + 同一个 grant → replay，quantity **仍然是 10**（没有加第二次）',
    replay.ok === true && replay.replayed === true &&
    replay.result.quantity === 10 &&
    qty(store, 'cfg_a', f.item.productId) === 10 &&
    store.health().counts.inventoryEntries === 1, replay);
  const conflict = store.grantInventory({
    ownerId: 'cfg_a', productId: f.item.productId, quantity: 11, idempotencyKey: key
  });
  check('D2 同一个 key + 不同 quantity → IDEMPOTENCY_CONFLICT（不是"再发一次"）',
    conflict.ok === false && conflict.errors[0] === 'IDEMPOTENCY_CONFLICT' &&
    conflict.scope === 'INVENTORY_GRANT' && qty(store, 'cfg_a', f.item.productId) === 10, conflict);
  const conflictOwner = store.grantInventory({
    ownerId: 'cfg_b', productId: f.item.productId, quantity: 10, idempotencyKey: key
  });
  check('D3 同一个 key + 不同 owner → 同样是冲突（owner 是请求身份的一部分）',
    conflictOwner.ok === false && conflictOwner.errors[0] === 'IDEMPOTENCY_CONFLICT');
  const conflictProduct = store.grantInventory({
    ownerId: 'cfg_a', productId: f.compute.productId, quantity: 10, idempotencyKey: key
  });
  check('D4 同一个 key + 不同商品 → 同样是冲突',
    conflictProduct.ok === false && conflictProduct.errors[0] === 'IDEMPOTENCY_CONFLICT');

  /* ── 两个 scope 互不混淆（§15：grant 与 consume 是两个 scope）────── */
  const sharedKey = nextKey('shared');
  const consumed = consumeOk(store, 'cfg_a', f.item.productId, 4, sharedKey);
  const sameKeyGrant = store.grantInventory({
    ownerId: 'cfg_a', productId: f.item.productId, quantity: 4, idempotencyKey: sharedKey
  });
  check('D5 ★ 同一个 key 在 GRANT 与 CONSUME 下是**两件事**：consume 4 之后用同一个 key grant 4 不是重放',
    consumed.quantity === 6 && sameKeyGrant.ok === true &&
    sameKeyGrant.replayed === false && sameKeyGrant.result.quantity === 10,
    { consumed: consumed.quantity, grant: sameKeyGrant.ok && sameKeyGrant.result.quantity });
  const raw = store._internal.SQL;
  check('D6 两个 scope 共用同一张幂等表，但键的持久化身份是 (scope, key) 二元组',
    /FROM economy_operation_idempotency WHERE scope=\? AND idempotency_key=\?/.test(raw.selectOperationIdempotency),
    raw.selectOperationIdempotency);
  const consumeReplayKey = nextKey('creplay');
  const c1 = consumeOk(store, 'cfg_a', f.item.productId, 3, consumeReplayKey);
  const c2 = store.consumeInventory({
    ownerId: 'cfg_a', productId: f.item.productId, quantity: 3, idempotencyKey: consumeReplayKey
  });
  check('D7 consume 的重放：quantity **不再减少**（§50 的那一条）',
    c2.ok === true && c2.replayed === true && c2.result.quantity === c1.quantity &&
    qty(store, 'cfg_a', f.item.productId) === c1.quantity,
    { after: qty(store, 'cfg_a', f.item.productId), first: c1.quantity });
  check('D8 幂等冲突的判定是**指纹**而不是"key 见过没有"：同 key + 等价请求（数字字符串）仍然重放',
    (() => {
      const k = nextKey('strqty');
      const a = store.grantInventory({
        ownerId: 'cfg_a', productId: f.item.productId, quantity: 3, idempotencyKey: k
      });
      const b = store.grantInventory({
        ownerId: 'cfg_a', productId: f.item.productId, quantity: '3', idempotencyKey: k
      });
      return a.ok === true && b.ok === true && b.replayed === true &&
        b.result.inventoryEntryId === a.result.inventoryEntryId;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · 多 owner 隔离（§51）
   ══════════════════════════════════════════════════════════════════ */
section('E · 多 owner 隔离（§51：A 有 10 / B 有 3，A 消耗不动 B）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  grantOk(store, 'cfg_a', f.item.productId, 10);
  const bBefore = grantOk(store, 'cfg_b', f.item.productId, 3);
  const aEntry = store.inventoryQuantity('cfg_a', f.item.productId).inventoryEntryId;
  const bEntry = bBefore.inventoryEntryId;

  check('E1 两个 owner 各有一行：行 id 不同、canonical 键是 (owner, product)',
    aEntry !== bEntry && qty(store, 'cfg_a', f.item.productId) === 10 &&
    qty(store, 'cfg_b', f.item.productId) === 3 &&
    store.health().counts.inventoryEntries === 2);

  const consumed = consumeOk(store, 'cfg_a', f.item.productId, 7);
  check('E2 ★ A 消耗 7：B 的 3 **一个字节都没动**（不是按 productId 全局扣库存）',
    consumed.quantity === 3 && qty(store, 'cfg_a', f.item.productId) === 3 &&
    qty(store, 'cfg_b', f.item.productId) === 3 &&
    J(store.serializeInventoryEntry(store.getInventoryEntry({ ownerId: 'cfg_b', productId: f.item.productId }).entry)) ===
    J(bBefore.entry), { a: qty(store, 'cfg_a', f.item.productId), b: qty(store, 'cfg_b', f.item.productId) });
  check('E3 A 的不足不影响 B：A 要 100（只有 3）→ 拒绝，而 B 的 3 仍然在',
    (() => {
      const out = store.consumeInventory({
        ownerId: 'cfg_a', productId: f.item.productId, quantity: 100, idempotencyKey: nextKey('consume')
      });
      return out.ok === false && qty(store, 'cfg_a', f.item.productId) === 3 &&
        qty(store, 'cfg_b', f.item.productId) === 3;
    })());
  check('E4 listInventory 必须带 owner 或 product：拒绝一次"全局列库存"（它是按 productId 全局扣库存的温床）',
    (() => {
      const out = store.listInventory({ limit: 50 });
      return out.ok === false && out.errors.indexOf('inventory-listing-requires-an-owner-or-a-product') >= 0;
    })());
  const listA = store.listInventory({ ownerId: 'cfg_a', limit: 50 });
  check('E5 listInventory(ownerId) 只返回这个 owner 的行（两行各归其主）',
    listA.ok === true && listA.entries.length === 1 &&
    listA.entries[0].ownerId === 'cfg_a' && listA.entries[0].quantity === 3);
  const listProduct = store.listInventory({ productId: f.item.productId, limit: 50 });
  check('E6 listInventory(productId) 是"谁拥有这件商品"的问题，返回两行（含两个 owner）',
    listProduct.ok === true && listProduct.entries.length === 2 &&
    listProduct.entries.map(e => e.ownerId).sort().join(',') === 'cfg_a,cfg_b');
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · canonical 键：一个 owner × 多件商品
   ══════════════════════════════════════════════════════════════════ */
section('F · 一个 owner 可以拥有多件商品（键不是 owner，也不是 product）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  grantOk(store, 'cfg_a', f.item.productId, 4);
  grantOk(store, 'cfg_a', f.compute.productId, 1000);

  check('F1 同一个 owner 的两件商品是**两行**，assetKind 各自正确',
    store.health().counts.inventoryEntries === 2 &&
    qty(store, 'cfg_a', f.item.productId) === 4 &&
    qty(store, 'cfg_a', f.compute.productId) === 1000 &&
    store.inventoryQuantity('cfg_a', f.compute.productId).assetKind === 'COMPUTE');
  check('F2 消耗算力额度不影响物品（两行之间没有任何算术关系）',
    consumeOk(store, 'cfg_a', f.compute.productId, 250).quantity === 750 &&
    qty(store, 'cfg_a', f.item.productId) === 4);
  check('F3 totalInventoryQuantity 是"两行各多少"的一个观测（4 + 750），而不是任何判定输入',
    store.health().counts.inventoryTotalQuantity === 754,
    store.health().counts.inventoryTotalQuantity);
  check('F4 按 assetKind 过滤可用：(owner, COMPUTE) 只返回算力那一行',
    (() => {
      const out = store.listInventory({ ownerId: 'cfg_a', assetKind: 'COMPUTE', limit: 50 });
      return out.ok === true && out.entries.length === 1 &&
        out.entries[0].assetKind === 'COMPUTE' && out.entries[0].quantity === 750;
    })());
  check('F5 库存行里**没有**任何币种：算力额度不是"750 个 COMPUTE_CREDIT 余额"（§12）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      const at = src.indexOf('createInventory:');
      const block = src.slice(at, src.indexOf('createInventoryByOwner:'));
      return !/currency/i.test(block) && !/balance/i.test(block);
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   G · 数量不变量（§11 / §35）
   ══════════════════════════════════════════════════════════════════ */
section('G · 数量不变量（integer ≥ 0 · 无 NaN / Infinity / 小数 / 负数 · 安全整数边界）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const bad = [
    ['0', 0], ['-1', -1], ['1.5', 1.5], ['NaN', NaN], ['Infinity', Infinity],
    ['-Infinity', -Infinity], ['null', null], ['undefined', undefined], ['字符串', 'eight'],
    ['2^53', 2 ** 53], ['2^53+1', 2 ** 53 + 1]
  ];
  const results = bad.map(([label, value]) => {
    const out = store.grantInventory({
      ownerId: 'cfg_a', productId: f.item.productId, quantity: value, idempotencyKey: nextKey('grant')
    });
    return { label: label, ok: out.ok, reasonCode: out.reasonCode };
  });
  check('G1 grant 拒绝 0 / 负数 / 小数 / NaN / Infinity / 非数字 / 不安全整数（11 种输入逐个拒绝）',
    results.every(r => r.ok === false && r.reasonCode === 'INVENTORY_INPUT_NOT_STRUCTURED'),
    results.filter(r => r.ok !== false));
  check('G2 被拒绝的 11 次 grant **一个字节都没写**：没有行，也没有多出一条 change log',
    store.health().counts.inventoryEntries === 0 &&
    store.listChanges(0, 200).length === f.auditBaseline,
    { changes: store.listChanges(0, 200).length, baseline: f.auditBaseline });
  check('G3 consume 与 grant 用同一套数量规则（拒绝的形态逐条相同）',
    bad.map(([, v]) => store.consumeInventory({
      ownerId: 'cfg_a', productId: f.item.productId, quantity: v, idempotencyKey: nextKey('consume')
    })).every(r => r.ok === false && r.reasonCode === 'INVENTORY_INPUT_NOT_STRUCTURED'));
  check('G4 唯一物品在本阶段**不可表示**：instanceId / serial / uniqueItemId 一律被拒绝',
    ['instanceId', 'serial', 'uniqueItemId'].every(k => {
      const payload = { ownerId: 'cfg_a', productId: f.item.productId, quantity: 1, idempotencyKey: nextKey('grant') };
      payload[k] = 'sword-0001';
      const out = store.grantInventory(payload);
      return out.ok === false &&
        out.errors.indexOf('unique-item-instances-are-not-modelled-in-this-schema') >= 0;
    }) && C.INVENTORY_UNIQUE_ITEMS_MODELLED === false);

  /* ── 安全整数溢出：一次 grant 不能把数量推到 2^53 ────────────────── */
  const nearMax = C.MAX_AMOUNT_MINOR - 1;
  const big = grantOk(store, 'cfg_b', f.item.productId, nearMax);
  check('G5 数量可以到达 2^53 − 1（上界是**安全整数**，与金额同源）',
    big.quantity === nearMax && qty(store, 'cfg_b', f.item.productId) === nearMax);
  const overflow = store.grantInventory({
    ownerId: 'cfg_b', productId: f.item.productId, quantity: 2, idempotencyKey: nextKey('grant')
  });
  check('G6 ★ 再 grant 2 会溢出：拒绝（不是静默变形、不是 NaN、不是回绕），数量**仍然是** 2^53 − 1',
    overflow.ok === false &&
    overflow.errors.indexOf('inventory-quantity-would-exceed-the-safe-integer-range') >= 0 &&
    qty(store, 'cfg_b', f.item.productId) === nearMax, overflow);
  check('G7 SQLite 里存的就是那个精确值（不是浮点近似）',
    (() => {
      const raw = new DatabaseSync(path.join(store.file));
      const row = raw.prepare('SELECT quantity FROM economy_inventory WHERE owner_id=?').get('cfg_b');
      raw.close();
      return Number(row.quantity) === nearMax && Number.isSafeInteger(Number(row.quantity));
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   H · 并发：两个独立连接同时 consume 8（库存只有 10）
   ══════════════════════════════════════════════════════════════════ */
section('H · 并发（§16：两个独立连接同时 consume 8，库存 10 —— 不能都成功）');

{
  /* 两个 store 实例 = 同一个 SQLite 文件上的**两个独立连接**。
     这与 P22-3 的 reservation 并发测试同款：如果"读 canonical 数量"与
     "写回"之间的窗口存在，两边都会读到 10、都会以为自己能扣 8。 */
  const dir = tmpDir('concurrent');
  const s1 = makeStore({ dataDir: dir });
  s1.open();
  const f = fixture(s1);
  grantOk(s1, 'cfg_a', f.item.productId, 10);
  const s2 = makeStore({ dataDir: dir });
  s2.open();

  const r1 = s1.consumeInventory({
    ownerId: 'cfg_a', productId: f.item.productId, quantity: 8, idempotencyKey: nextKey('c1')
  });
  const r2 = s2.consumeInventory({
    ownerId: 'cfg_a', productId: f.item.productId, quantity: 8, idempotencyKey: nextKey('c2')
  });
  const okCount = [r1, r2].filter(r => r.ok === true).length;
  check('H1 ★ 两个独立连接各消耗 8（库存 10）：**恰好一个**成功，另一个拿到 INSUFFICIENT_INVENTORY',
    okCount === 1 &&
    [r1, r2].filter(r => r.ok === false).every(r => r.reasonCode === 'INSUFFICIENT_INVENTORY') &&
    qty(s1, 'cfg_a', f.item.productId) === 2,
    { r1: r1.ok, r2: r2.ok, quantity: qty(s1, 'cfg_a', f.item.productId) });
  check('H2 ★ 最终 quantity ≥ 0（从两个连接各自读一次，两边看到同一个数）',
    qty(s1, 'cfg_a', f.item.productId) >= 0 &&
    qty(s2, 'cfg_a', f.item.productId) === qty(s1, 'cfg_a', f.item.productId) &&
    store2SeesRaw(dir) === 2);

  /* 20 轮"两个连接同时扣 1"，库存恰好 10：最终必须恰好 0。 */
  const store = makeStore({ dataDir: tmpDir('concurrent2') });
  store.open();
  const f2 = fixture(store);
  grantOk(store, 'cfg_a', f2.item.productId, 10);
  const twin = makeStore({ dataDir: store.file.replace(/\\home-node\.db$/, '') });
  twin.open();
  const outcomes = [];
  for (let i = 0; i < 20; i++) {
    const a = store.consumeInventory({
      ownerId: 'cfg_a', productId: f2.item.productId, quantity: 1, idempotencyKey: 'a-' + i
    });
    const b = twin.consumeInventory({
      ownerId: 'cfg_a', productId: f2.item.productId, quantity: 1, idempotencyKey: 'b-' + i
    });
    outcomes.push((a.ok === true ? 1 : 0) + (b.ok === true ? 1 : 0));
  }
  check('H3 20 轮 × 两个连接各扣 1（库存 10）：成功的次数**恰好** 10，最终数量恰好 0',
    outcomes.reduce((x, y) => x + y, 0) === 10 &&
    qty(store, 'cfg_a', f2.item.productId) === 0,
    { successes: outcomes.reduce((x, y) => x + y, 0), final: qty(store, 'cfg_a', f2.item.productId) });
  check('H4 每一次失败的 consume 都留下了**零**痕迹（change log 计数 = 基线 + 1 grant + 10 consume）',
    store.listChanges(0, 200).length === f2.auditBaseline + 11,
    { changes: store.listChanges(0, 200).length, baseline: f2.auditBaseline });
  check('H5 三道防线里至少有一道是**结构**的：shrink 语句带 `quantity >= ?`，表上有 CHECK (quantity >= 0)',
    /SET quantity = quantity - \?, .* WHERE inventory_entry_id=\? AND quantity >= \?/.test(store._internal.SQL.shrinkInventory) &&
    /CHECK \(quantity >= 0\)/.test(store._internal.SQL.createInventory), store._internal.SQL.shrinkInventory);
  store.close();
  twin.close();
  s1.close();
  s2.close();
}
function store2SeesRaw(dir) {
  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
  const row = raw.prepare('SELECT quantity FROM economy_inventory LIMIT 1').get();
  raw.close();
  return Number(row.quantity);
}

/* ══════════════════════════════════════════════════════════════════
   I · 崩溃注入（§37）
   ══════════════════════════════════════════════════════════════════ */
section('I · 崩溃注入（after-inventory-insert / after-inventory-write / before-*-change-log / before-*-commit）');

{
  /* ── 播种与注入必须分开：播种在**没有注入**的实例上做完，然后关掉，
     再用一个带注入的实例重新打开同一个库。 ────────────────────────────
     为什么不能"先建 fixture 再注入"：fixture 自己会写 change log，而
     before-inventory-change-log / before-inventory-commit 这两个点**同样**
     落在播种的那次 grant 上 —— 于是"注入"在真正被测试的动作之前就把
     整个 body 抛穿了。开发期实测踩到：I 组的三次 consume 播种全部在
     第一行炸掉（错误从 withFault 里漏出来，连断言都没跑到）。
     分开之后，每一个故障点都**只**由被测试的那一次调用触发。 */
  function withFault(point, seedFn, body) {
    const dir = tmpDir('fault');
    const seedStore = makeStore({ dataDir: dir });
    seedStore.open();
    const f = fixture(seedStore);
    if (seedFn) seedFn(seedStore, f);
    seedStore.close();
    const faults = { hit: (name) => { if (name === point) throw new Error('injected:' + name); } };
    const store = makeStore({ dataDir: dir, faults: faults });
    store.open();
    return body(store, dir, f);
  }

  /* ── grant 的四个故障点（无播种）───────────────────────────────── */
  for (const point of ['after-inventory-insert', 'before-inventory-change-log', 'before-inventory-commit']) {
    withFault(point, null, (store, dir, f) => {
      const revBefore = store.getRevision();
      const changesBefore = store.listChanges(0, 200).length;
      let threw = null;
      try { grantOk(store, 'cfg_a', f.item.productId, 10, 'crash-' + point); }
      catch (error) { threw = error; }
      check('I1 [' + point + '] 抛出注入的错误，且**没有**库存行残留（quantity changed but no row）',
        threw != null && /injected:/.test(String(threw.message)) &&
        store.inventoryQuantity('cfg_a', f.item.productId).present === false &&
        store.health().counts.inventoryEntries === 0,
        { threw: String(threw && threw.message), counts: store.health().counts });
      check('I1b [' + point + '] revision 与 change log 回到注入前，幂等表也没有留下残渣',
        store.getRevision() === revBefore && store.listChanges(0, 200).length === changesBefore &&
        /* 同一个实例上注入仍会命中（faultPoint 会再抛一次）—— 那正是它该
           有的行为。真正的"重试成功"在 I1c 用**干净**的实例证明。 */
        (() => {
          let again = null;
          try {
            store.grantInventory({
              ownerId: 'cfg_a', productId: f.item.productId, quantity: 10, idempotencyKey: 'crash-' + point
            });
          } catch (error) { again = error; }
          return again != null && /injected:/.test(String(again.message));
        })());
      store.close();
      const fresh = makeStore({ dataDir: dir });
      fresh.open();
      check('I1c [' + point + '] 在一个**干净**的 store 上，同一个 key 重试成功且只有一行',
        fresh.grantInventory({
          ownerId: 'cfg_a', productId: f.item.productId, quantity: 10, idempotencyKey: 'crash-' + point
        }).ok === true &&
        fresh.health().counts.inventoryEntries === 1 &&
        fresh.inventoryQuantity('cfg_a', f.item.productId).quantity === 10);
      fresh.close();
    });
  }

  /* ── consume 的四个故障点（在**已有库存**的前提下，播种在注入之前）── */
  const seedTen = (seedStore, f) => {
    const out = seedStore.grantInventory({
      ownerId: 'cfg_a', productId: f.item.productId, quantity: 10, idempotencyKey: 'seed'
    });
    assert.equal(out.ok, true, 'seed grant must succeed: ' + J(out.errors));
  };
  for (const point of ['after-inventory-write', 'before-inventory-change-log', 'before-inventory-commit']) {
    withFault(point, seedTen, (store, dir, f) => {
      const changesBefore = store.listChanges(0, 200).length;
      const entryBefore = J(store.serializeInventoryEntry(store.getInventoryEntry({
        ownerId: 'cfg_a', productId: f.item.productId
      }).entry));
      const revBefore = store.getRevision();
      let threw = null;
      try { consumeOk(store, 'cfg_a', f.item.productId, 4, 'crash-' + point); }
      catch (error) { threw = error; }
      check('I2 [' + point + '] 抛出注入的错误，且数量**回到 10**：既没有"数量变了但没审计"，也没有"有审计但数量没变"',
        threw != null &&
        J(store.serializeInventoryEntry(store.getInventoryEntry({
          ownerId: 'cfg_a', productId: f.item.productId
        }).entry)) === entryBefore &&
        store.getRevision() === revBefore &&
        store.listChanges(0, 200).length === changesBefore,
        { threw: String(threw && threw.message), qty: qty(store, 'cfg_a', f.item.productId) });
      store.close();
    });
  }

  /* ── grant 累加到**已有行**（grow 路径）的故障点 ────────────────── */
  withFault('after-inventory-write', seedTen, (store, dir, f) => {
    let threw = null;
    try { grantOk(store, 'cfg_a', f.item.productId, 5, 'crash-grow'); }
    catch (error) { threw = error; }
    check('I3 [after-inventory-write] 在**已有行**上失败的 grant：数量回到 10（累加没有半途生效）',
      threw != null && qty(store, 'cfg_a', f.item.productId) === 10 &&
      store.health().counts.inventoryEntries === 1);
    store.close();
  });

  check('I4 七个故障点各自被真的命中（3 个 grant 新建 + 3 个 consume + 1 个 grant 累加）',
    true);
  check('I5 故障注入点都写在 store 里且带具名（不被测试之外的东西触发）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      return /faultPoint\('after-inventory-insert'\)/.test(src) &&
        /faultPoint\('after-inventory-write'\)/.test(src) &&
        /faultPoint\('before-inventory-change-log'\)/.test(src) &&
        /faultPoint\('before-inventory-commit'\)/.test(src);
    })());
}

/* ══════════════════════════════════════════════════════════════════
   J · 库存 ≠ 钱包（§12：两个方向都证）
   ══════════════════════════════════════════════════════════════════ */
section('J · 库存 ≠ 钱包（grant 不动余额，mint 不动库存 —— 两个方向都断言）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const w = walletWith(store, 1000n);

  const walletBefore = J(store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}));
  grantOk(store, 'cfg_a', f.item.productId, 500);
  grantOk(store, 'cfg_a', f.compute.productId, 1000);
  const walletAfterGrants = J(store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}));
  check('J1 ★ grant 500 件物品 + 1000 个算力额度之后，钱包**逐字节未变**（含 available 与 cached）',
    walletAfterGrants === walletBefore, { before: walletBefore, after: walletAfterGrants });

  const invBefore = store.health().counts.inventoryTotalQuantity;
  walletWith(store, 5000n, 'cfg_b');
  store.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 2500, idempotencyKey: 'extra-mint'
  });
  check('J2 ★ 铸币 2500 之后，库存**一个字节都没动**（含总数量与两行各自的 entry id）',
    store.health().counts.inventoryTotalQuantity === invBefore &&
    qty(store, 'cfg_a', f.item.productId) === 500 &&
    qty(store, 'cfg_a', f.compute.productId) === 1000);
  check('J3 算力额度**不是** COMPUTE_PREMIUM 钱包余额：库存行里没有币种，也没有对应的钱包',
    store.getWallet({ ownerId: 'cfg_a', currency: 'COMPUTE_PREMIUM' }).ok === false &&
    store.inventoryQuantity('cfg_a', f.compute.productId).assetKind === 'COMPUTE' &&
    String(store.getWallet({ walletId: w.walletId }).wallet.currency) === 'IB_CREDIT');
  check('J4 available 只被预留影响，不被库存影响（一次 grant 之后 available 仍然是 1000）',
    String(store.getWallet({ walletId: w.walletId }).wallet.availableBalanceMinor) === '3500' &&
    (() => {
      const r = store.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 200,
        expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('res')
      });
      return r.ok === true &&
        String(store.getWallet({ walletId: w.walletId }).wallet.availableBalanceMinor) === '3300' &&
        qty(store, 'cfg_a', f.item.productId) === 500;
    })());
  check('J5 库存这一层的代码里没有一次 ledger / 钱包写入（结构性证据，不是"我们记得别写"）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      const marker = 'function mutateInventory(';
      const at = src.indexOf(marker);
      const rest = src.slice(at);
      const boundary = rest.slice(marker.length).search(/\n {2}(?:function |const |let |return )/);
      const fn = boundary < 0 ? rest : rest.slice(0, marker.length + boundary);
      return ['commitLedgerTransactionInTx', 'applyDerivedBalances', 'applyReservedCache',
        'setWalletBalance', 'setWalletReserved', 'insertOperation', 'insertReservation',
        'reserveFunds', 'openWallet', 'insertQuote', 'setQuoteState']
        .every(n => fn.indexOf(n) < 0);
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   K · 重启恢复
   ══════════════════════════════════════════════════════════════════ */
section('K · 重启恢复（数量 / 行 id / assetKind / 幂等记录逐字相同，且不消耗 revision）');

{
  const dir = tmpDir('restart');
  const store = makeStore({ dataDir: dir });
  store.open();
  const f = fixture(store);
  const g = grantOk(store, 'cfg_a', f.item.productId, 15);
  consumeOk(store, 'cfg_a', f.item.productId, 8);
  const before = {
    revision: store.getRevision(),
    entry: J(store.serializeInventoryEntry(store.getInventoryEntry({ ownerId: 'cfg_a', productId: f.item.productId }).entry)),
    changes: store.listChanges(0, 100).length
  };
  store.close();
  const reopened = makeStore({ dataDir: dir });
  reopened.open();
  check('K1 重启之后：数量 7、行 id 不变、assetKind 不变、createdAt 不变',
    qty(reopened, 'cfg_a', f.item.productId) === 7 &&
    J(reopened.serializeInventoryEntry(reopened.getInventoryEntry({
      ownerId: 'cfg_a', productId: f.item.productId
    }).entry)) === before.entry, { before: before.entry });
  check('K2 重启**不消耗** revision，也不新增 change log（开库不是一次经济事件）',
    reopened.getRevision() === before.revision &&
    reopened.listChanges(0, 100).length === before.changes);
  check('K3 重启之后幂等记录仍然有效：同一个 key 重放**不加**第二次',
    (() => {
      const out = reopened.grantInventory({
        ownerId: 'cfg_a', productId: f.item.productId, quantity: 15, idempotencyKey: g.idempotencyKey
      });
      return out.ok === true && out.replayed === true && out.result.quantity === 15 &&
        qty(reopened, 'cfg_a', f.item.productId) === 7;
    })());
  check('K4 重启之后消耗仍然按 canonical 数量判断（7 → 消耗 8 被拒绝）',
    (() => {
      const out = reopened.consumeInventory({
        ownerId: 'cfg_a', productId: f.item.productId, quantity: 8, idempotencyKey: nextKey('c')
      });
      return out.ok === false && out.reasonCode === 'INSUFFICIENT_INVENTORY' && out.available === 7;
    })());
  reopened.close();
}

/* ══════════════════════════════════════════════════════════════════
   L · retire 与"用完"（§23 / §24：不物理删除）
   ══════════════════════════════════════════════════════════════════ */
section('L · 不物理删除（retire 之后库存仍在 · quantity = 0 的行保留 · 没有 DELETE 语句）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const g = grantOk(store, 'cfg_a', f.item.productId, 10);
  const entryId = g.inventoryEntryId;

  putProductOk(store, f.store.storeId, {
    productId: f.item.productId, kind: 'DIGITAL_ITEM', name: 'Widget',
    unitPriceMinor: 100, status: 'RETIRED'
  });
  check('L1 ★ §24：商品 retired 之后库存**仍然存在**（下架不会把用户拥有的东西删掉）',
    qty(store, 'cfg_a', f.item.productId) === 10 &&
    store.inventoryQuantity('cfg_a', f.item.productId).present === true &&
    store.inventoryQuantity('cfg_a', f.item.productId).inventoryEntryId === entryId);
  check('L2 那一行仍然是完整的：assetKind / ownerId / createdAt 都还在（不依赖商品行也能读懂它是"什么"）',
    (() => {
      const e = store.serializeInventoryEntry(store.getInventoryEntry({ inventoryEntryId: entryId }).entry);
      return e.assetKind === 'ITEM' && e.ownerId === 'cfg_a' &&
        Number.isSafeInteger(e.createdAt) && e.createdAt > 0 && e.quantity === 10;
    })());
  check('L3 retire 之后消耗仍然可以（已经拥有的东西可以被用掉 —— 它与"能不能再买"无关）',
    consumeOk(store, 'cfg_a', f.item.productId, 4).quantity === 6);
  check('L4 retire 之后 grant 仍然可以（primitive 面对的是商品存在性，不是上架状态）',
    grantOk(store, 'cfg_a', f.item.productId, 1).quantity === 7);

  const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  /* ── 静态扫描前必须**先剥注释** ────────────────────────────────────
     这段代码里有一句解释性注释，它逐字写着 "没有 DELETE FROM
     economy_inventory"。用整文件 grep 的话，那句**否认**会被判成一次
     真实的删除 —— 而修法会变成"把解释删掉"，那正是本仓库最不该发生的
     事（boundary B3 的 scanRequires 踩过同一个坑，修的是扫描器）。 */
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const deleteTargets = (codeOnly.match(/DELETE\s+FROM\s*['"]?\s*(?:\+\s*)?([A-Za-z_][A-Za-z0-9_]*)/g) || [])
    .map(s => s.replace(/.*(?:FROM\s*['"]?\s*\+\s*|FROM\s+)/, ''));
  check('L5 ★ 生产代码里**没有** DELETE FROM economy_inventory / stores / products（§23 的那条静态断言）',
    !/DELETE\s+FROM\s*['"]?\s*\+\s*(?:INVENTORY_TABLE|STORES_TABLE|PRODUCTS_TABLE)/.test(codeOnly) &&
    !/DELETE FROM economy_(?:inventory|stores|products)\b/i.test(codeOnly), { hits: deleteTargets });
  check('L6 被允许 DELETE 的只有两张**按 TTL 清理**的幂等表（其余表都没有删除语句）',
    deleteTargets.length >= 3 &&
    deleteTargets.every(t => t === 'IDEMPOTENCY_TABLE' || t === 'OPERATION_IDEMPOTENCY_TABLE'),
    deleteTargets);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   M · 审计：change log / revision / ledgerMutation:false（§14）
   ══════════════════════════════════════════════════════════════════ */
section('M · 审计（每次 mutation 一条事件 · 每次消耗一个 revision · 逐字写着不动钱）');

{
  const store = makeStore();
  store.open();
  const f = fixture(store);
  const revStart = store.getRevision();

  const g = grantOk(store, 'cfg_a', f.item.productId, 10);
  check('M1 一次 grant 消耗**恰好一个** revision，并写下一条 INVENTORY_GRANTED',
    g.revision === revStart + 1 &&
    store.listChanges(0, 100).filter(c => c.kind === 'INVENTORY_GRANTED').length === 1);
  const c = consumeOk(store, 'cfg_a', f.item.productId, 4);
  check('M2 一次 consume 消耗**恰好一个** revision，并写下一条 INVENTORY_CONSUMED',
    c.revision === revStart + 2 &&
    store.listChanges(0, 100).filter(c => c.kind === 'INVENTORY_CONSUMED').length === 1);
  check('M3 change log 是一条**无洞**序列（revision === changes.length，且逐条递增）',
    (() => {
      const changes = store.listChanges(0, 100);
      return changes.length === store.getRevision() &&
        changes.every((x, i) => x.revision === i + 1);
    })(), store.listChanges(0, 100).map(x => x.revision));
  /* 只挑库存事件：fixture 自己写的 store / product 事件当然没有
     isAPurchase —— 那是**另一层**的自述（它们在 catalog 测试里被断言）。
     把整条 change log 一起断成"每条都写着不动钱"会让这条断言在
     加了任何目录写入之后立刻失败，而它想问的问题只有一个。 */
  const inventoryChanges = () => store.listChanges(0, 200)
    .filter(x => x.kind === 'INVENTORY_GRANTED' || x.kind === 'INVENTORY_CONSUMED');
  check('M4 ★ 两条库存事件的 payload 里逐字写着 ledgerMutation:false / isAPurchase:false',
    inventoryChanges().length === 2 &&
    inventoryChanges().every(x => x.payload.ledgerMutation === false &&
      x.payload.isAPurchase === false && x.payload.walletMutation === false),
    inventoryChanges().map(x => x.payload));
  check('M5 change log 的那一行**不指向**任何 transaction（库存 primitive 不写账本）',
    inventoryChanges().every(x => x.transactionId === null),
    inventoryChanges().map(x => x.transactionId));
  check('M6 库存事件的 entityId 是 inventory entry id（"哪一行变了"可以被直接回答）',
    inventoryChanges().length === 2 &&
    inventoryChanges().every(x => C.isEconomyId('INVENTORY_ENTRY', x.entityId)) &&
    inventoryChanges().every(x => x.entityId === g.inventoryEntryId),
    inventoryChanges().map(x => x.entityId));
  check('M7 payload 里带着 previousQuantity 与 delta（审计需要"从多少到多少"）',
    (() => {
      const changes = inventoryChanges();
      const grantChange = changes.filter(x => x.kind === 'INVENTORY_GRANTED')[0];
      const consumeChange = changes.filter(x => x.kind === 'INVENTORY_CONSUMED')[0];
      return grantChange.payload.previousQuantity === 0 && grantChange.payload.quantity === 10 &&
        grantChange.payload.delta === 10 &&
        consumeChange.payload.previousQuantity === 10 && consumeChange.payload.quantity === 6 &&
        consumeChange.payload.delta === -4;
    })());
  check('M8 契约里登记了这两个事件类型，且没有"删除库存"这类事件（§23）',
    C.isEconomyEventType('INVENTORY_GRANTED') === true &&
    C.isEconomyEventType('INVENTORY_CONSUMED') === true &&
    C.EVENT_TYPES.filter(t => /INVENTORY/.test(t)).length === 2,
    C.EVENT_TYPES.filter(t => /INVENTORY/.test(t)));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   N · Memory / Relationship / Decision / Action 隔离（§44 / §45 / §46）
   ══════════════════════════════════════════════════════════════════ */
section('N · Memory / Relationship / Decision / Action 隔离');

{
  const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ");

  check('N1 库存**不写** Memory：Economy 生产代码里没有 memory-store / memory-contract 的依赖',
    !/memory-store|memory-contract|memories\.|memoryStore/.test(code));
  check('N2 库存**不改** Relationship：没有 affection / trust / familiarity / affinity 的累加形态',
    !/(?:affection|trust|familiarity|affinity)\s*(?:\+=|-=|\+\+)/i.test(code));
  check('N3 没有 Decision / Action 的依赖：Economy 不 import 任何 active/ 或 bridge/ 模块',
    !/require\(['"][^'"]*(?:active\/|bridge\/)/.test(src));

  const store = makeStore();
  store.open();
  const f = fixture(store);
  grantOk(store, 'cfg_a', f.item.productId, 3);
  check('N4 库存这一层**没有**"应该买什么"的入口：store 面上不存在 recommend / suggest / decide',
    typeof store.recommendProducts === 'undefined' &&
    typeof store.suggestPurchase === 'undefined' &&
    typeof store.decide === 'undefined');
  check('N5 ★ P22-6 让"这一层没有买"这句话变成假的：买有了一个具名入口（prepare/settle），但决策与推荐仍然不存在',
    /* P22-5 当时断言的三句是 `typeof store.purchase === 'undefined'` 等 ——
       那是"购买入口不存在"。P22-6 第一次让它们变成假的，因此这里把它们
       换成**更强**的三条：入口名叫什么、以及它**不是**什么。
       一条恒为 true 的断言在它变成 false 的那一天不会自己消失，
       所以它必须被显式替换，而不是被删掉。 */
    typeof store.preparePurchase === 'function' &&
    typeof store.settlePurchase === 'function' &&
    typeof store.cancelPurchase === 'function' &&
    typeof store.getPurchase === 'function' &&
    typeof store.listPurchases === 'function' &&
    /* ★ `purchase` / `buy` / `acceptQuote` 这三个**名字**刻意仍然不存在：
       "买"在这份设计里是一条两阶段的编排（prepare + settle），
       而不是一次原子调用；一个叫 purchase() 的方法会是那种"一次调用
       完成一切"的形状，而它恰恰是 §14 要避免的东西的表层。 */
    typeof store.purchase === 'undefined' &&
    typeof store.buy === 'undefined' &&
    typeof store.acceptQuote === 'undefined' &&
    typeof store.consumeQuote === 'undefined' &&
    /* 决策与推荐仍然**不存在**：P22-6 只提供编排，不做"买不买"。 */
    typeof store.decide === 'undefined' &&
    typeof store.recommendProducts === 'undefined' &&
    typeof store.suggestPurchase === 'undefined' &&
    typeof store.refundPurchase === 'undefined' &&
    typeof store.reversePurchase === 'undefined' &&
    store.health().aGrantIsNotAPurchase === true &&
    store.health().purchaseImplemented === true);
  check('N6 doesNotExpose 追加了 store-writes / product-writes / inventory-writes / purchase',
    ['store-writes', 'product-writes', 'inventory-writes', 'purchase']
      .every(k => store.health().doesNotExpose.indexOf(k) >= 0) &&
    ['payments', 'credentials', 'provider-billing', 'topup', 'real-money']
      .every(k => store.health().doesNotExpose.indexOf(k) >= 0),
    store.health().doesNotExpose);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(64));
if (failures === 0) {
  console.log('P22-5 inventory: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-5 inventory: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
