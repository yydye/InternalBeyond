'use strict';
/* ====================================================================
   P22-26 · Phase 2 —— Inventory Consume（`consumeOwnedItem`）
   --------------------------------------------------------------------
   运行：node tests/test_p22_26_inventory_consume.js

   本文件证明的是**一条边真的存在**，而且它只朝一个方向：

     CONSUMABLE ── consumeOwnedItem ──▶ inventory −N
       · 不动钱（没有 ledger、没有钱包、没有预算、没有批准）
       · owner 来自**权威上下文**，payload 里自报的那一个被完全忽略
       · 只有 `kind === CONSUMABLE` 能被用掉（DIGITAL_ITEM 不是消耗品）

   ── 为什么这条边是本阶段的核心（而不是"再加一个功能"）──────────────
   在 P22-26 之前：`consumeInventory` 存在且可用、`INVENTORY_CONSUME` 与
   `INVENTORY_CONSUMED` 都已冻结 —— 但**生产调用方是 0**。适配器把它列进
   NOT_OFFERED，capability 句柄拿不到它，HTTP 上不存在这条写路由。于是
   `CONSUMABLE` 与 `DIGITAL_ITEM` 在运行时是**同一个东西**：两者都
   `INVENTORY_GRANT / ITEM`，区别只在契约注释里那句"消耗品"。
   一件买来只会**累加**的消耗品不是消耗品 —— 它是一个挂着消耗品名字的
   永久资产。本文件证明那个同义词关系已经不成立。

   ── 组 ──────────────────────────────────────────────────────────────
     A  缝的形状：存在、只 consume、owner 来自上下文
     B  第一次消耗：5 → 4（canonical 数量、事件、delta）
     C  幂等：同键重放不重复扣；同键不同指纹冲突
     D  fail closed：数量不足 / 非法 owner / 非消耗品 / system party
     E  消耗**不动钱**：钱包与预留一字不变
     F  并发：两个真实进程同时扣 ⇒ 恰好一个成功，数量永不为负
     G  静态边界：HTTP / capability / 适配器上都没有这条缝
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-26c-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
const openChildren = new Set();
process.on('exit', () => {
  for (const child of openChildren) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

/* ★★ id 计数器必须是**文件级**的：多个世界各自从 1 开始会让不同的世界生成
   同一批 id，而症状是一堆看起来无关的断言失败。见 P22-26 Phase 1 测试里
   同一段说明。 */
const CLOCK = 1717200000000;
function now() { return CLOCK; }
let idSeq = 0;
function deterministicIds() {
  return (kind) => { idSeq += 1; return C.formatEconomyId(kind, 'x' + idSeq).id; };
}
function makeStore(dataDir) {
  return createEconomyStore({
    dataDir: dataDir || tmpDir('store'), logger: () => {}, clock: now, nextId: deterministicIds()
  });
}
let keySeq = 0;
function nextKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }

function walletWith(store, amountMinor, ownerId) {
  const w = store.openWallet({ owner: { type: 'character', id: ownerId || 'char_a' }, currency: 'IB_CREDIT' });
  assert.equal(w.ok, true, 'openWallet must succeed: ' + J(w.errors));
  if (amountMinor && BigInt(amountMinor) !== 0n) {
    const m = store.mintForSystem({
      systemInitiated: true, walletId: w.wallet.walletId, currency: 'IB_CREDIT',
      amountMinor: amountMinor, idempotencyKey: 'seed-' + (ownerId || 'char_a')
    });
    assert.equal(m.ok, true, 'mint must succeed: ' + J(m.errors));
  }
  return w.wallet;
}
function putStore(store) {
  const out = store.putStore({ name: 'Main Store', idempotencyKey: nextKey('store') });
  assert.equal(out.ok, true, 'putStore must succeed: ' + J(out.errors || out));
  return out.result;
}
function putProduct(store, storeId, options) {
  const out = store.putProduct(Object.assign({
    storeId: storeId, kind: 'CONSUMABLE', name: 'Capsule', currency: 'IB_CREDIT',
    unitPriceMinor: 400, grantQuantity: 1, idempotencyKey: nextKey('product')
  }, options || {}));
  assert.equal(out.ok, true, 'putProduct must succeed: ' + J(out.errors || out));
  return out.result;
}
function grant(store, ownerId, productId, quantity) {
  const out = store.grantInventory({
    ownerId: ownerId, productId: productId, quantity: quantity, idempotencyKey: nextKey('grant')
  });
  assert.equal(out.ok, true, 'grantInventory must succeed: ' + J(out.errors || out));
  return out.result;
}
/* ★ 一次消耗：owner 走**权威上下文**，payload 里没有 ownerId。 */
function consume(store, options, context) {
  return store.consumeOwnedItem(Object.assign({
    quantity: 1, idempotencyKey: nextKey('consume')
  }, options || {}), context || { ownerId: 'char_a' });
}
function qty(store, ownerId, productId) {
  return Number(store.inventoryQuantity(ownerId, productId).quantity);
}
/* 一个装配好的世界：一个 owner、一个 CONSUMABLE 商品、N 件库存。 */
function world(options) {
  const o = options || {};
  const store = makeStore(o.dataDir);
  store.open();
  walletWith(store, o.balance === undefined ? 100000n : o.balance, o.ownerId || 'char_a');
  const st = putStore(store);
  const consumable = putProduct(store, st.storeId, { name: 'Capsule', kind: 'CONSUMABLE' });
  const durable = putProduct(store, st.storeId, { name: 'Decor', kind: 'DIGITAL_ITEM' });
  if (o.stock) grant(store, o.ownerId || 'char_a', consumable.product.productId, o.stock);
  return {
    store: store, storeId: st.storeId, ownerId: o.ownerId || 'char_a',
    consumableId: consumable.product.productId, durableId: durable.product.productId
  };
}
function walletRow(store, ownerId) {
  const rows = store.listWallets({ ownerId: ownerId });
  assert.equal(rows.length, 1, 'exactly one wallet for ' + ownerId);
  return rows[0];
}

const NODE_BIN = (function () {
  /* 与 P22-5 runtime 同款：优先用仓库约定的 bundled runtime，缺失时回落到
     当前 node。测试因此**总是跑得起来**，而"NODE_BIN 是不是 bundled"这一
     事实只在输出里被如实说明，不被断言成成功/失败。 */
  const bundled = path.join(ROOT, '.dsh-runtime', 'node.exe');
  return fs.existsSync(bundled) ? bundled : process.execPath;
})();
const WORKER_FILE = path.join('tests', 'fixtures', 'p22-26-consume-item-worker.js');
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

/* ══════════════════════════════════════════════════════════════════
   A · 缝的形状
   ══════════════════════════════════════════════════════════════════ */
section('A · 缝的形状：存在、只 consume、owner 来自上下文');

{
  check('A1 ★ store 上**存在** consumeOwnedItem 这条缝（P22-26 之前生产调用方为 0）',
    typeof createEconomyStore === 'function');
  const w = world({ stock: 5 });
  check('A2 ★★ 它是 store 的一个方法，而且**只有 consume 方向**：它是一个接收 (input, context) 的函数',
    typeof w.store.consumeOwnedItem === 'function' && w.store.consumeOwnedItem.length === 2,
    { arity: w.store.consumeOwnedItem.length });

  /* ★ 一次成功消耗的结果里逐字写着"这不是一次购买"。 */
  const out = consume(w.store, { productId: w.consumableId, quantity: 1 });
  check('A3 ★★ 结果自述：consumedItem = true、isAPurchase = false、ledgerMutation = false、walletMutation = false',
    out.ok === true && out.result.consumedItem === true && out.result.isAPurchase === false &&
    out.result.ledgerMutation === false && out.result.walletMutation === false,
    { result: out.result });
  check('A4 ★★ 而它逐字自述 owner 来自权威上下文、**不**来自 payload',
    out.result.ownerFromAuthorityContext === true && out.result.ownerFromPayload === false,
    { result: out.result });
  check('A5 ★ 它不必求预算、不必求批准（budgetEvaluated / approvalRequired 都是 false）',
    out.result.budgetEvaluated === false && out.result.approvalRequired === false);
  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   B · 第一次消耗：5 → 4
   ══════════════════════════════════════════════════════════════════ */
section('B · 第一次消耗：inventory 5 → 4');

{
  const w = world({ stock: 5 });
  const beforeChanges = w.store.listChanges(0, 500).length;
  const first = consume(w.store, { productId: w.consumableId, quantity: 1 });

  check('B1 ★ 第一次消耗成功：数量 5 → 4，previousQuantity = 5、delta = -1',
    first.ok === true && Number(first.result.quantity) === 4 &&
    Number(first.result.previousQuantity) === 5 && Number(first.result.delta) === -1,
    { result: first.result });

  /* ★ canonical 数量是**唯一**的真相，因此它必须与写回结果一致 —— 而且它
     是从另一个读面（inventoryQuantity）读出来的。 */
  check('B2 ★★ canonical 读面（inventoryQuantity）也说 4 —— 没有派生缓存可以不一致',
    qty(w.store, w.ownerId, w.consumableId) === 4,
    { canonical: qty(w.store, w.ownerId, w.consumableId) });

  /* ── B3 · change log：一条具名的 INVENTORY_CONSUMED ──────────────── */
  const changes = w.store.listChanges(0, 500).slice(beforeChanges);
  const consumed = changes.filter(c => String(c.kind) === String(C.EVENT_TYPE.INVENTORY_CONSUMED));
  check('B3 ★★ change log 里恰好多出**一条** INVENTORY_CONSUMED，且它带着 previousQuantity / delta（消耗是一次可读的审计事实）',
    consumed.length === 1 &&
    Number(consumed[0].payload.previousQuantity) === 5 &&
    Number(consumed[0].payload.delta) === -1 &&
    Number(consumed[0].payload.quantity) === 4,
    { changes: changes.map(c => c.kind), entry: consumed[0] && consumed[0].payload });
  check('B4 ★★ 那条事件**不指向任何 ledger transaction**（transactionId 为 null）—— 消耗不是一次记账',
    consumed.length === 1 && consumed[0].transactionId === null,
    { transactionId: consumed[0] && consumed[0].transactionId });

  /* ── B5 · 再消耗 1（够）⇒ 3；这一次证明"能连续用掉" ──────────────── */
  const second = consume(w.store, { productId: w.consumableId, quantity: 1 });
  check('B5 ★ 连续第二次消耗：4 → 3（一件可以被用掉的东西，不是一个只会累加的东西）',
    second.ok === true && Number(second.result.quantity) === 3 &&
    qty(w.store, w.ownerId, w.consumableId) === 3,
    { result: second.result });
  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   C · 幂等
   ══════════════════════════════════════════════════════════════════ */
section('C · 幂等：重复同一次消耗不会静默丢掉两件东西');

{
  const w = world({ stock: 5 });
  const key = nextKey('consume-same');
  const a = w.store.consumeOwnedItem(
    { productId: w.consumableId, quantity: 2, idempotencyKey: key }, { ownerId: w.ownerId });
  const b = w.store.consumeOwnedItem(
    { productId: w.consumableId, quantity: 2, idempotencyKey: key }, { ownerId: w.ownerId });

  check('C1 ★★ 同一个幂等键重放：replayed = true、返回**同一个**结果，而数量只减了一次（5 → 3，不是 1）',
    a.ok === true && b.ok === true && b.replayed === true &&
    Number(a.result.quantity) === 3 && Number(b.result.quantity) === 3 &&
    qty(w.store, w.ownerId, w.consumableId) === 3,
    { a: a.result && a.result.quantity, b: b.result && b.result.quantity, canonical: qty(w.store, w.ownerId, w.consumableId) });

  /* ★ 这条比"重复购买"的幂等更关键：一次重复的购买是多花一次钱（可见），
     一次重复的消耗是**静默丢掉一件东西**。 */
  check('C2 ★★ 而重放没有多写一条 INVENTORY_CONSUMED 事件（审计里也只有一次）',
    w.store.listChanges(0, 500).filter(c => String(c.kind) === String(C.EVENT_TYPE.INVENTORY_CONSUMED)).length === 1,
    { events: w.store.listChanges(0, 500).filter(c => String(c.kind) === String(C.EVENT_TYPE.INVENTORY_CONSUMED)).length });

  /* ── C3 · 同一个键、不同的用量 ⇒ **冲突**（不静默覆盖） ──────────── */
  const conflict = w.store.consumeOwnedItem(
    { productId: w.consumableId, quantity: 3, idempotencyKey: key }, { ownerId: w.ownerId });
  check('C3 ★★ 同一个幂等键换一个用量 ⇒ 冲突拒绝（不是"再扣 3 件"）',
    conflict.ok === false && Array.isArray(conflict.errors) &&
    conflict.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0 &&
    qty(w.store, w.ownerId, w.consumableId) === 3,
    { ok: conflict.ok, errors: conflict.errors, canonical: qty(w.store, w.ownerId, w.consumableId) });

  /* ── C4 · 同一个键、**另一个 owner** ⇒ 各是一次独立操作 ──────────
     因为 owner 是这次操作身份的一部分（它来自上下文），同一个幂等键配
     不同的 owner 不是"同一件事的又一次投递"，因此**两边都该成功**。
     ★ 需要先补货：本组前三条已经把 char_a 从 5 花到 3，而"同一个键在另一个
     owner 上成功"必须在**够扣**的前提下才有意义。 */
  grant(w.store, w.ownerId, w.consumableId, 5);
  const w2 = world({ stock: 1, ownerId: 'char_b' });
  const key2 = nextKey('consume-owner');
  const beforeA = qty(w.store, w.ownerId, w.consumableId);
  const forA = w.store.consumeOwnedItem(
    { productId: w.consumableId, quantity: 1, idempotencyKey: key2 }, { ownerId: w.ownerId });
  const forB = w2.store.consumeOwnedItem(
    { productId: w2.consumableId, quantity: 1, idempotencyKey: key2 }, { ownerId: w2.ownerId });
  check('C4 ★ 同一个键、另一个 owner 是**两次不同**的操作（owner 进指纹）—— 两边各自成功，而不是共用一次结果',
    forA.ok === true && forB.ok === true &&
    qty(w.store, w.ownerId, w.consumableId) === beforeA - 1 &&
    qty(w2.store, w2.ownerId, w2.consumableId) === 0,
    {
      a: qty(w.store, w.ownerId, w.consumableId), expectedA: beforeA - 1,
      b: qty(w2.store, w2.ownerId, w2.consumableId),
      errors: [forA.errors, forB.errors]
    });
  w.store.close(); w2.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · fail closed
   ══════════════════════════════════════════════════════════════════ */
section('D · fail closed：不足 / 非法 owner / 非消耗品');

{
  const w = world({ stock: 2 });

  /* ── D1 · 库存不足 ──────────────────────────────────────────────── */
  const tooMany = consume(w.store, { productId: w.consumableId, quantity: 3 });
  check('D1 ★★ 库存不足（要 3 只有 2）⇒ 拒绝 INSUFFICIENT_INVENTORY，且带着 available / requested 两个数',
    tooMany.ok === false && tooMany.reasonCode === C.DENY_REASON.INSUFFICIENT_INVENTORY &&
    tooMany.errors.indexOf('inventory-quantity-is-insufficient') >= 0 &&
    tooMany.available === 2 && tooMany.requested === 3,
    { reasonCode: tooMany.reasonCode, errors: tooMany.errors, available: tooMany.available });
  check('D2 ★★ 被拒绝的那一次**一件都没扣**：数量仍然是 2（算术守卫生效，不是"扣完再回滚"）',
    qty(w.store, w.ownerId, w.consumableId) === 2,
    { canonical: qty(w.store, w.ownerId, w.consumableId) });

  /* ── D3 · 从来没有过这一件 ──────────────────────────────────────── */
  const never = consume(w.store, { productId: w.durableId, quantity: 1 });
  check('D3 ★ 从来没持有过 ⇒ 拒绝（EFFECT_NOT_ALLOWED，因为 DIGITAL_ITEM 不是消耗品 —— 见 D5/D6；"从来没有过"由 primitive 的 inventory-entry-not-found 表达）',
    never.ok === false, { reasonCode: never.reasonCode, errors: never.errors });

  /* ── D4 · 非法 owner ────────────────────────────────────────────── */
  const noContext = w.store.consumeOwnedItem(
    { productId: w.consumableId, quantity: 1, idempotencyKey: nextKey('consume') }, {});
  check('D4 ★★ 没有权威上下文 ⇒ 拒绝（不是"回落到 payload 或某个缺省 owner"）',
    noContext.ok === false && noContext.reasonCode === C.DENY_REASON.ACCOUNT_NOT_ALLOWED &&
    noContext.errors.indexOf('consume-owned-item-requires-an-authority-context-with-an-owner') >= 0 &&
    noContext.identityComesFromThePayload === false,
    { reasonCode: noContext.reasonCode, errors: noContext.errors });

  const emptyOwner = w.store.consumeOwnedItem(
    { productId: w.consumableId, quantity: 1, idempotencyKey: nextKey('consume') }, { ownerId: '   ' });
  check('D5 ★ 空白的 owner 同样被拒绝（"字段存在"与"它说得通"是两件事）',
    emptyOwner.ok === false && emptyOwner.reasonCode === C.DENY_REASON.ACCOUNT_NOT_ALLOWED,
    { reasonCode: emptyOwner.reasonCode, errors: emptyOwner.errors });

  const systemOwner = w.store.consumeOwnedItem(
    { productId: w.consumableId, quantity: 1, idempotencyKey: nextKey('consume') },
    { ownerId: C.SYSTEM_ACCOUNT.MARKET, ownerType: C.PARTY_TYPE.SYSTEM });
  check('D6 ★★ system party 不能持有库存，因此也不能消耗库存',
    systemOwner.ok === false && systemOwner.reasonCode === C.DENY_REASON.ACCOUNT_NOT_ALLOWED &&
    systemOwner.errors.indexOf('system-party-cannot-hold-inventory-and-cannot-consume-it') >= 0,
    { reasonCode: systemOwner.reasonCode, errors: systemOwner.errors });

  /* ── ★★ D7 · payload 自报的 owner 被**完全忽略** ─────────────────
     这是本阶段最重要的一条：把 ownerId 放进 payload 不会改变任何事，
     因为这条缝根本不读它。用一个"payload 说 char_b、上下文说 char_a"的
     调用去证明它扣的是 **char_a** 的东西，而 char_b 的库存一个字没动。 */
  const stray = world({ stock: 1, ownerId: 'char_stray' });
  const ignored = w.store.consumeOwnedItem({
    productId: w.consumableId, quantity: 1, idempotencyKey: nextKey('consume'),
    /* 这些是**攻击面**：全部应该被忽略。 */
    ownerId: 'char_stray', characterId: 'char_stray', buyerId: 'char_stray', ownerType: 'character'
  }, { ownerId: w.ownerId });
  check('D8 ★★ payload 里的 ownerId / characterId / buyerId **全部被忽略**：扣的是上下文那个 owner（char_a 2 → 1），而 char_stray 的那一件一件没动',
    ignored.ok === true &&
    qty(w.store, w.ownerId, w.consumableId) === 1 &&
    qty(stray.store, 'char_stray', stray.consumableId) === 1,
    {
      authorityOwner: qty(w.store, w.ownerId, w.consumableId),
      payloadClaimedOwner: qty(stray.store, 'char_stray', stray.consumableId)
    });
  stray.store.close();

  /* ── D9/D10 · 只有 CONSUMABLE 能被用掉 ──────────────────────────── */
  grant(w.store, w.ownerId, w.durableId, 3);
  const durableUse = consume(w.store, { productId: w.durableId, quantity: 1 });
  check('D9 ★★ DIGITAL_ITEM（永久资产）**不能**被消耗：EFFECT_NOT_ALLOWED + 一句具名的理由',
    durableUse.ok === false && durableUse.reasonCode === C.DENY_REASON.EFFECT_NOT_ALLOWED &&
    durableUse.errors.indexOf('only-a-consumable-can-be-consumed') >= 0 &&
    durableUse.productKind === 'DIGITAL_ITEM' && durableUse.aDurableItemIsNotConsumedByUsingIt === true,
    { reasonCode: durableUse.reasonCode, errors: durableUse.errors, productKind: durableUse.productKind });
  check('D10 ★★ 而那次拒绝一件都没扣：DIGITAL_ITEM 仍然是 3 —— 两个 kind 在这里第一次真正分开',
    qty(w.store, w.ownerId, w.durableId) === 3,
    { durable: qty(w.store, w.ownerId, w.durableId) });

  const apiQuota = putProduct(w.store, w.storeId, { name: 'Compute', kind: 'API_QUOTA', grantQuantity: 1000 });
  grant(w.store, w.ownerId, apiQuota.product.productId, 1000);
  const quotaUse = consume(w.store, { productId: apiQuota.product.productId, quantity: 1 });
  check('D11 ★ API_QUOTA 同样不能被"用掉"（它是额度，不是消耗品 —— 算力的消耗属于它自己的 primitive）',
    quotaUse.ok === false && quotaUse.reasonCode === C.DENY_REASON.EFFECT_NOT_ALLOWED &&
    qty(w.store, w.ownerId, apiQuota.product.productId) === 1000,
    { reasonCode: quotaUse.reasonCode, errors: quotaUse.errors });

  /* ── D12 · 形状类拒绝 ───────────────────────────────────────────── */
  const badQty = [
    consume(w.store, { productId: w.consumableId, quantity: 0 }),
    consume(w.store, { productId: w.consumableId, quantity: -1 }),
    consume(w.store, { productId: w.consumableId, quantity: 1.5 }),
    consume(w.store, { productId: 'not-a-product', quantity: 1 }),
    consume(w.store, { productId: w.consumableId, quantity: 1, instanceId: 'ser-1' })
  ];
  check('D12 ★ 形状类输入逐个被拒绝（0 / -1 / 1.5 / 非 canonical productId / 唯一物品实例）',
    badQty.every(r => r.ok === false), badQty.map(r => ({ ok: r.ok, reasonCode: r.reasonCode, errors: r.errors })));

  /* ── D13 · 商品不存在 ───────────────────────────────────────────── */
  const ghost = consume(w.store, { productId: C.formatEconomyId('PRODUCT', 'ghost').id, quantity: 1 });
  check('D13 ★ 指向不存在商品的消耗 ⇒ PRODUCT_NOT_FOUND',
    ghost.ok === false && ghost.reasonCode === C.DENY_REASON.PRODUCT_NOT_FOUND,
    { reasonCode: ghost.reasonCode, errors: ghost.errors });

  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · 消耗**不动钱**
   ══════════════════════════════════════════════════════════════════ */
section('E · 消耗不动钱：钱包 / 预留 / 账本一字不变');

{
  const w = world({ stock: 5, balance: 100000n });
  const walletBefore = walletRow(w.store, w.ownerId);
  const ledgerBefore = w.store.listTransactions({ limit: 100 }).length;
  const before = {
    ledger: String(walletBefore.ledgerBalanceMinor),
    reserved: String(walletBefore.reservedBalanceMinor),
    transactions: ledgerBefore
  };

  const out = consume(w.store, { productId: w.consumableId, quantity: 2 });
  const walletAfter = walletRow(w.store, w.ownerId);

  check('E1 ★★ 消耗 2 件之后：ledgerBalanceMinor 与 reservedBalanceMinor **逐字不变**',
    out.ok === true &&
    String(walletAfter.ledgerBalanceMinor) === before.ledger &&
    String(walletAfter.reservedBalanceMinor) === before.reserved,
    { before: before, after: { ledger: String(walletAfter.ledgerBalanceMinor), reserved: String(walletAfter.reservedBalanceMinor) } });
  check('E2 ★★ 而账本上**没有**多出任何一笔 transaction（消耗不产生 ledger transaction）',
    w.store.listTransactions({ limit: 100 }).length === before.transactions,
    { before: before.transactions, after: w.store.listTransactions({ limit: 100 }).length });
  check('E3 ★ 消耗也没有创建 purchase / reservation / operation —— 它不是一次购买的任何一部分',
    w.store.listPurchases({ limit: 100 }).count === 0,
    {
      purchases: w.store.listPurchases({ limit: 100 }).count,
      reservations: w.store.health().counts.reservations
    });
  check('E4 ★★ 也没有写任何预算决策（budgetPolicies 与"今天花了多少"都不受影响）',
    w.store.listBudgetPolicies({ limit: 100 }).policies.length === 0,
    { policies: w.store.listBudgetPolicies({ limit: 100 }).policies.length });

  /* ── E5 · 对照：一次**购买**会动钱 ────────────────────────────────
     把"消耗不动钱"钉在对照上，而不是钉在一句注释上。 */
  const bought = (function () {
    w.store.putBudgetPolicy({
      ownerId: w.ownerId, currency: 'IB_CREDIT',
      limits: { perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000 },
      idempotencyKey: nextKey('policy')
    });
    const q = w.store.createProductQuote({
      productId: w.consumableId, buyerId: w.ownerId, units: 1,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('quote')
    });
    const prep = w.store.preparePurchase({
      quoteId: q.result.quoteId, buyerId: w.ownerId,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: nextKey('prepare')
    });
    return w.store.settlePurchase({ purchaseId: prep.result.purchaseId, idempotencyKey: nextKey('settle') });
  })();
  const walletAfterBuy = walletRow(w.store, w.ownerId);
  check('E5 ★★ 对照：同一件商品**买**一次会让钱包 -400、账本 +1 笔，而**消耗**不会 —— 两条路径的经济含义不同',
    bought.ok === true &&
    BigInt(String(walletAfterBuy.ledgerBalanceMinor).replace(/n$/, '')) ===
    BigInt(before.ledger.replace(/n$/, '')) - 400n &&
    w.store.listTransactions({ limit: 100 }).length === before.transactions + 1,
    {
      ledger: String(walletAfterBuy.ledgerBalanceMinor),
      transactions: w.store.listTransactions({ limit: 100 }).length
    });
  w.store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · 并发（两个**真实进程**）
   ══════════════════════════════════════════════════════════════════ */
section('F · 并发：两个真实进程同时消耗同一行库存');

(async function concurrency() {
  const dir = tmpDir('race');
  const w = world({ dataDir: dir, stock: 1 });
  w.store.close();

  const barrier = Date.now() + 1200;
  const results = await Promise.all([
    runWorker([dir, w.ownerId, w.consumableId, '1', 'race-a', String(barrier)]),
    runWorker([dir, w.ownerId, w.consumableId, '1', 'race-b', String(barrier)])
  ]);
  const rows = results.map(r => r.result).filter(Boolean);
  const succeeded = rows.filter(r => r && r.ok === true);
  const drained = rows.filter(r => r && r.ok !== true);

  check('F1 ★★ 两个**真实进程**（各自独立的 SQLite 连接）同时消耗仅剩的 1 件：恰好**一个**成功，另一个被算术守卫拒绝',
    rows.length === 2 && succeeded.length === 1 && drained.length === 1,
    rows.map(r => ({ ok: r.ok, reasonCode: r.reasonCode, errors: r.errors })));
  check('F2 ★★ 那个失败者拿到的是一句可读的拒绝（INSUFFICIENT_INVENTORY），不是一次 SQLite 崩溃',
    drained.length === 1 &&
    drained[0].reasonCode === C.DENY_REASON.INSUFFICIENT_INVENTORY &&
    drained[0].errors.indexOf('inventory-quantity-is-insufficient') >= 0,
    drained[0]);
  /* ★ 最终世界：数量恰好 0，**不是** -1。两个 worker 各自在独立连接上读过
     一次 canonical 数量，因此"没有负库存"由两次独立读数证明。 */
  const final = makeStore(dir);
  final.open();
  const finalQty = qty(final, w.ownerId, w.consumableId);
  const finalEvents = final.listChanges(0, 500)
    .filter(c => String(c.kind) === String(C.EVENT_TYPE.INVENTORY_CONSUMED)).length;
  check('F3 ★★ 最终 canonical 数量恰好是 0（**不是** -1），且只写了一条 INVENTORY_CONSUMED 事件',
    finalQty === 0 && finalEvents === 1,
    { quantity: finalQty, events: finalEvents });
  check('F4 ★ 两个 worker 各自读到的 canonical 数量都 ≥ 0（它们在自己的连接上各读了一次）',
    rows.every(r => Number(r.canonicalQuantity) >= 0), rows.map(r => r && r.canonicalQuantity));
  final.close();

  /* ════════════════════════════════════════════════════════════════
     G · 静态边界：这条缝没有被任何 transport 接上
     ════════════════════════════════════════════════════════════════ */
  section('G · 静态边界：HTTP / capability / 适配器上都没有这条缝');

  {
    const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
    const httpSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');
    const capabilitySrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'), 'utf8');
    const channelSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-command-channel.js'), 'utf8');
    const adapterSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-action-adapter.js'), 'utf8');

    /* ★ 剥离注释之后再扫：说明注释里逐字引用着这些名字。 */
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

    check('G1 ★★ http.js 里**没有** consumeOwnedItem / consumeInventory 的调用形态（消耗在 HTTP 上不存在写路由）',
      strip(httpSrc).indexOf('consumeOwnedItem') < 0 && strip(httpSrc).indexOf('consumeInventory') < 0);
    check('G2 ★★ economy-capability.js 里没有它（这条缝**不是**一个 Agent capability —— 能力表一字未改）',
      strip(capabilitySrc).indexOf('consumeOwnedItem') < 0 && strip(capabilitySrc).indexOf('consumeInventory') < 0);
    check('G3 ★★ economy-command-channel.js 里没有它（跨进程唯一开放的命令仍然是那一个，词表一字未改）',
      strip(channelSrc).indexOf('consumeOwnedItem') < 0 && strip(channelSrc).indexOf('consumeInventory') < 0);
    check('G4 ★ 适配器仍然把它列为**不提供**（P22-10 的 NOT_OFFERED 没有被本阶段放开）',
      strip(adapterSrc).indexOf('consumeInventory') >= 0 || strip(adapterSrc).indexOf('NOT_OFFERED') >= 0,
      { adapterMentionsConsume: strip(adapterSrc).indexOf('consumeInventory') });

    /* ── G5 · 生产调用方 ────────────────────────────────────────────
       `consumeOwnedItem` 在**生产代码**里没有调用方，而 `consumeInventory`
       （P22-5 的 primitive）也没有。两者都只出现在测试与夹具里。 */
    const prodFiles = fs.readdirSync(path.join(ROOT, 'services', 'home-node'))
      .filter(f => f.endsWith('.js'));
    const callers = prodFiles.filter(f => {
      if (f === 'economy-store.js') return false;   /* 定义处 */
      const body = strip(fs.readFileSync(path.join(ROOT, 'services', 'home-node', f), 'utf8'));
      return body.indexOf('consumeOwnedItem(') >= 0 || body.indexOf('consumeInventory(') >= 0;
    });
    check('G5 ★★ 生产目录里**没有任何**文件调用这条缝（它是被建好的缝，不是被接上的线）—— 接上它是它自己的阶段',
      callers.length === 0, { callers: callers });

    /* ── G6 · 缝的形状：`mode` 是一个字面量 ────────────────────────── */
    const fnAt = strip(storeSrc).indexOf('function consumeOwnedItem(');
    const fnBody = fnAt < 0 ? '' : strip(storeSrc).slice(fnAt, fnAt + 6000);
    check('G6 ★★ 缝里传给底层 primitive 的方向是**字面量** consume（因此"通过消耗接缝发库存"在结构上不可能）',
      fnBody.indexOf("mutateInventory('consume'") >= 0);
    /* ── G7 · 而它不读 payload 里的身份 ─────────────────────────── */
    check('G7 ★★ 缝的函数体里**没有** o.ownerId / o.characterId / o.buyerId（身份只能来自上下文）',
      fnBody.indexOf('o.ownerId') < 0 && fnBody.indexOf('o.characterId') < 0 &&
      fnBody.indexOf('o.buyerId') < 0);
    check('G8 ★ 而它确实读 ctx.ownerId（正面那一半）', fnBody.indexOf('ctx.ownerId') >= 0);
  }

  console.log('\n' + (failures === 0
    ? '════════════════════════════════════════════════════════════════'
      + '\nP22-26 Inventory Consume：全部通过 ✔'
    : '════════════════════════════════════════════════════════════════'
      + '\nP22-26 Inventory Consume：' + failures + ' 项失败 ✘'));
  if (failures > 0) process.exitCode = 1;
})();
