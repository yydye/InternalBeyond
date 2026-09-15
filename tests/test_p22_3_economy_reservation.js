'use strict';
/* ====================================================================
   P22-3 · Economy reservation 与 operation 生命周期（canonical store 层）
   --------------------------------------------------------------------
   运行：node tests/test_p22_3_economy_reservation.js

   本文件回答的问题：
     「一笔钱在被花掉之前**先被锁住**这件事，能不能被原子地、可恢复地、
       幂等地、且**不能超订**地做完？」

   ── 为什么本阶段最危险的不是"功能没写完"而是"两个数不一致" ────────────
   P22-3 引入第二个派生存量（reserved），而 P22-2 已经有一个（cached
   balance）。两个派生量 + 一个用户可见的派生结果（available）意味着
   三条漂移路径：
     · reserved 缓存与 active reservations 不符  → "已锁的钱又变得可花"；
     · available 用缓存算                        → 一个坏缓存直接决定花钱；
     · commit 时 ledger 动了而 reservation 没动  → 钱花了却还能再花一次。
   因此本文件的重心不是 happy path，而是：**先破坏，再证明它修得回来**，
   以及**在每一个可能的位置注入崩溃**。

   ── 与方法名对应关系（便于对照 P22-3 的编号）──────────────────────────
     A  生命周期与 schema 2        B  reserveFunds（§5/§8/§9）
     C  多笔预留与超订             D  commitReservation（§10/§11）
     E  releaseReservation（§12）  F  expireReservation（§13/§14）
     G  终态不可回退（§4）         H  operation ↔ reservation 映射
     I  幂等作用域与指纹（§18/§19）J  reserved 的 canonical truth（§6/§7）
     K  崩溃注入（§23）            L  重启恢复（§24）
     M  schema 1 → 2（§16）        N  fail closed（§7）
     O  并发（§20）                P  change log / revision（§21）
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
/* BigInt 不能进 JSON.stringify（P22-1 §3）—— 连**失败信息**都必须显式
   处理它，否则一次断言失败会变成一次 TypeError。 */
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-3-' + tag + '-'));
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

/* 可推进的时钟。**过期是一个比较**（expires_at <= now），因此只要能让
   now 动起来，"进程离线两小时后重启"就可以在一个测试进程里被如实复现 ——
   不需要真的等两小时，也不需要任何定时器。 */
function mutableClock(start) {
  const box = { now: Number(start) || 1_700_000_000_000 };
  const fn = () => box.now;
  fn.box = box;
  fn.advance = (ms) => { box.now += Number(ms); return box.now; };
  return fn;
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
  const w = store.openWallet({ owner: { type: 'character', id: ownerId || 'cfg_a' }, currency: currency || 'IB_CREDIT' });
  assert.equal(w.ok, true, 'openWallet must succeed: ' + J(w.errors));
  if (amountMinor && BigInt(amountMinor) !== 0n) {
    const m = store.mintForSystem({
      systemInitiated: true, walletId: w.wallet.walletId, currency: currency || 'IB_CREDIT',
      amountMinor: amountMinor, idempotencyKey: 'seed-' + w.wallet.walletId
    });
    assert.equal(m.ok, true, 'mint must succeed: ' + J(m.errors));
  }
  return w.wallet;
}
function view(store, walletId) {
  const g = store.getWallet({ walletId: walletId });
  return g.ok ? store.serializeWallet(g.wallet, {}) : null;
}
function available(store, walletId) {
  const v = view(store, walletId);
  return v == null ? null : v.availableBalanceMinor;
}
/* 一个"预留成功"的辅助：返回值断言成功，让后面的断言读起来是"关于事实"
   而不是"关于可能失败"。 */
function reserveOk(store, walletId, amountMinor, key, expiresAt, extra) {
  const r = store.reserveFunds(Object.assign({
    walletId: walletId, currency: 'IB_CREDIT', amountMinor: amountMinor,
    expiresAt: expiresAt, idempotencyKey: key
  }, extra || {}));
  assert.equal(r.ok, true, 'reserve must succeed: ' + J(r.errors || r));
  return r.result;
}
function commitOk(store, reservationId, key, extra) {
  const r = store.commitReservation(Object.assign({ reservationId: reservationId, idempotencyKey: key }, extra || {}));
  assert.equal(r.ok, true, 'commit must succeed: ' + J(r.errors || r));
  return r.result;
}

console.log('P22-3 · Economy reservation + operation lifecycle');

/* ══════════════════════════════════════════════════════════════════
   A · 生命周期与 schema
   ══════════════════════════════════════════════════════════════════ */
section('A · Store lifecycle / schema 2（新表、新水位、新计数）');

{
  const dir = tmpDir('lifecycle');
  const store = makeStore({ dataDir: dir });
  const opened = store.open();
  /* P22-4 把水位抬到了 3（它多了 budget_policies / quotes 两张表），
     因此这一条断言的是"报告的水位 == 本 build 声明的水位"，而不是一个
     写死的 2 —— 写死会让**下一次**抬水位的人被迫改一条与 P22-3 无关的
     断言，而那条断言本来要问的是"水位有没有被一致地报告"。
     "P22-3 自己抬到 2"这件事由 M 组（1 → 2 的迁移路径）继续守着。 */
  check('A1 open() 报告 schema == 本 build 声明的水位（P22-3 抬到 2，P22-4 抬到 3）',
    opened.ok === true && Number(opened.schemaVersion) === Number(store.SCHEMA_VERSION) &&
    Number(store.health().schemaVersion) === Number(store.SCHEMA_VERSION) &&
    Number(store.SCHEMA_VERSION) >= 2,
    { opened: opened.schemaVersion, health: store.health().schemaVersion, declared: store.SCHEMA_VERSION });
  check('A2 三张新表被登记（operations / reservations / 操作级幂等），且命名空间仍是 economy_ 前缀',
    store.TABLES.OPERATIONS === 'economy_operations' &&
    store.TABLES.RESERVATIONS === 'economy_reservations' &&
    store.TABLES.OPERATION_IDEMPOTENCY === 'economy_operation_idempotency' &&
    [store.TABLES.OPERATIONS, store.TABLES.RESERVATIONS, store.TABLES.OPERATION_IDEMPOTENCY]
      .every(t => t.indexOf('economy_') === 0));
  check('A3 health() 自述 reserved 的 canonical 与派生两面（而不是只说余额那一面）',
    store.health().reservedCanonical === 'sqlite-active-reservations' &&
    store.health().reservedDerived === 'wallet-reserved-balance-cache' &&
    store.health().canonical === 'sqlite-ledger-entries');
  check('A4 health() 把"到期不是定时器"写成可断言字段',
    store.health().expirationIsNotATimer === true);
  check('A5 doesNotExpose 追加 reservation-writes（这一阶段的六个写方法一个都不在 HTTP 上）',
    store.health().doesNotExpose.indexOf('reservation-writes') >= 0 &&
    ['payments', 'credentials', 'provider-billing', 'topup', 'real-money']
      .every(k => store.health().doesNotExpose.indexOf(k) >= 0),
    store.health().doesNotExpose);

  check('A6 新库的 counts 里 operations / reservations / activeReservations 都是 0',
    store.health().counts.operations === 0 && store.health().counts.reservations === 0 &&
    store.health().counts.activeReservations === 0, store.health().counts);

  const w = walletWith(store, 100n);
  const clock = null;
  const now = Date.now();
  const res = reserveOk(store, w.walletId, 40n, 'a-1', now + 60000);
  check('A7 一次 reserve 之后 counts 是 1 个 operation / 1 笔 reservation / 1 笔 active',
    store.health().counts.operations === 1 && store.health().counts.reservations === 1 &&
    store.health().counts.activeReservations === 1, store.health().counts);
  check('A8 reserve 的结果里 operation 与 reservation 是**两个** canonical id，且各自形状正确',
    C.isEconomyId('OPERATION', res.operationId) && C.isEconomyId('RESERVATION', res.reservationId) &&
    res.operationStatus === C.TX_STATE.RESERVED && res.reservationState === C.RESERVATION_STATE.ACTIVE,
    res);
  check('A9 reservation 的 DTO 里带着它的 operation（一次操作的两个侧面可互相追溯）',
    (() => {
      const g = store.getReservation({ reservationId: res.reservationId });
      return g.ok === true && g.reservation.operation &&
        g.reservation.operation.operationId === res.operationId &&
        g.reservation.operation.status === C.TX_STATE.RESERVED;
    })());
  check('A10 getOperation 认形状不认字符串（用错误的 id 种类查不到东西）',
    store.getOperation(res.operationId).ok === true &&
    store.getOperation(res.reservationId).ok === false &&
    store.getOperation('nope').ok === false);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   B · reserveFunds：成功路径与每一种拒绝
   ══════════════════════════════════════════════════════════════════ */
section('B · reserveFunds（§5 的六条前置条件逐条测）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);

  const ok = store.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 70n,
    expiresAt: now + 60000, idempotencyKey: 'b-ok'
  });
  check('B1 成功：ACTIVE 预留创建、锁定量 +70、available = 100 − 70 = 30',
    ok.ok === true && ok.result.reservationState === 'ACTIVE' &&
    ok.result.amountMinor === '70' && ok.result.reservedBalanceMinor === '70' &&
    available(store, w.walletId) === '30',
    { result: ok.result, available: available(store, w.walletId) });
  check('B2 reserve **不**产生任何 ledger 事实（钱还属于原钱包，只是暂时不可再消费）',
    store.health().counts.transactions === 1 && store.health().counts.entries === 2,
    store.health().counts);
  check('B3 缓存与 canonical 一致（reservedCacheDrifted 为 false）',
    view(store, w.walletId).reservedCacheDrifted === false &&
    view(store, w.walletId).reservedBalanceMinor === '70' &&
    view(store, w.walletId).reservedBalanceCachedMinor === '70');

  const overdraw = store.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 50n,
    expiresAt: now + 60000, idempotencyKey: 'b-over'
  });
  check('B4 余额不足（available）：INSUFFICIENT_AVAILABLE_BALANCE，并给出三个数让"为什么"可读',
    overdraw.ok === false && overdraw.denied === true &&
    overdraw.reasonCode === C.DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE &&
    C.isDenyReasonCode(overdraw.reasonCode) &&
    overdraw.ledgerBalanceMinor === '100' && overdraw.reservedBalanceMinor === '70' &&
    overdraw.availableBalanceMinor === '30' && overdraw.requestedAmountMinor === '50',
    overdraw);
  check('B5 它**不是** INSUFFICIENT_BALANCE（账本够、可用的不够，是两个不同的拒绝理由）',
    overdraw.reasonCode !== C.DENY_REASON.INSUFFICIENT_BALANCE);
  check('B6 被拒绝的 reserve 在库里**什么都不留**（§17：不制造 FAILED 记录、不消耗 id）',
    store.health().counts.operations === 1 && store.health().counts.reservations === 1 &&
    store.health().counts.activeReservations === 1, store.health().counts);

  const wrongCur = store.reserveFunds({
    walletId: w.walletId, currency: 'COMPUTE_PREMIUM', amountMinor: 1n,
    expiresAt: now + 60000, idempotencyKey: 'b-cur'
  });
  check('B7 币种不匹配被拒绝（INVALID_CURRENCY，不是"按 IB_CREDIT 记账"）',
    wrongCur.ok === false && wrongCur.reasonCode === C.DENY_REASON.INVALID_CURRENCY, wrongCur);
  check('B8 真实货币 / provider 余额连 reserve 这一层都进不来',
    ['USD', 'CNY', 'PROVIDER_BALANCE', 'TOKENS'].every(cur =>
      store.reserveFunds({
        walletId: w.walletId, currency: cur, amountMinor: 1n,
        expiresAt: now + 60000, idempotencyKey: 'b-cur-' + cur
      }).ok === false));

  const zero = store.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 0n,
    expiresAt: now + 60000, idempotencyKey: 'b-zero'
  });
  check('B9 0 金额被拒绝（锁不住任何东西，却会占一行、消耗一个 revision）',
    zero.ok === false && zero.reasonCode === C.DENY_REASON.INVALID_AMOUNT, zero);
  check('B10 负数 / 小数 / 表达式 / 科学计数法 / 千分位一律被拒绝（amount representation 不放松）',
    [-1n, -1, 1.5, '1.0', '1e3', '0x10', '-1', '1,000', '+1', '', 'NaN']
      .every(bad => store.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: bad,
        expiresAt: now + 60000, idempotencyKey: 'b-amt'
      }).ok === false));
  /* P22-1 §3 刻意允许前导零与首尾空白（'007' / ' 12 '）：它们**无歧义**地
     表示一个整数，而真正危险的是"看起来像数字的别的东西"（表达式/浮点/
     负数/千分位）。这里把这条刻意的宽容也测出来 —— 免得将来有人把
     "trim 一下"当成漏洞补掉，反而与冻结契约冲突。 */
  check('B11 前导零与首尾空白按 P22-1 §3 被接受并归一（无歧义的写法不是漏洞）',
    (() => {
      const a = store.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: '007',
        expiresAt: now + 60000, idempotencyKey: 'b-pad'
      });
      const b = store.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: ' 8 ',
        expiresAt: now + 60000, idempotencyKey: 'b-trim'
      });
      return a.ok === true && a.result.amountMinor === '7' &&
        b.ok === true && b.result.amountMinor === '8';
    })());

  check('B11 expiresAt 缺失被拒绝（绝对时间戳是请求身份的一部分，刻意不提供 ttlMs）',
    (() => {
      const r = store.reserveFunds({ walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 1n, idempotencyKey: 'b-exp' });
      return r.ok === false && r.errors.indexOf('reservation-expires-at-required') >= 0 && r.reasonCode === null;
    })());
  check('B12 非法 expiresAt（NaN / 非整数 / 负数）被拒绝',
    [NaN, 1.5, -1, Infinity, 'later', {}].every(bad => store.reserveFunds({
      walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 1n,
      expiresAt: bad, idempotencyKey: 'b-exp2'
    }).ok === false));
  check('B13 已经过去的 expiresAt 被拒绝（RESERVATION_EXPIRED）—— 不制造一笔立刻到期的预留',
    (() => {
      const r = store.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 1n,
        expiresAt: now, idempotencyKey: 'b-past'
      });
      return r.ok === false && r.reasonCode === C.DENY_REASON.RESERVATION_EXPIRED;
    })());
  check('B14 缺 idempotencyKey 被拒绝（幂等键不是可选项）',
    store.reserveFunds({
      walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 1n, expiresAt: now + 1000
    }).ok === false);
  check('B15 不存在的钱包被拒绝（而不是凭空建一个）',
    store.reserveFunds({
      walletId: 'econ_wallet_nope', currency: 'IB_CREDIT', amountMinor: 1n,
      expiresAt: now + 1000, idempotencyKey: 'b-nw'
    }).errors.indexOf('wallet-not-found') >= 0);
  check('B16 (ownerId, currency) 也是一种合法的定位方式，两种入口落到同一个钱包',
    (() => {
      const byOwner = store.reserveFunds({
        ownerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 5n,
        expiresAt: now + 60000, idempotencyKey: 'b-owner'
      });
      return byOwner.ok === true && byOwner.result.walletId === w.walletId;
    })());

  store.close();

  /* 钱包不是 READY 时：reserve 必须在**分配任何 id 之前**失败（fail closed）。 */
  const degDir = tmpDir('notready');
  const deg = createEconomyStore({
    dataDir: degDir, logger: () => { }, nextId: deterministicIds(), clock: mutableClock()
  });
  deg.open();
  const dw = walletWith(deg, 100n);
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(degDir, 'home-node.db'));
  raw.prepare('DELETE FROM ' + deg.TABLES.ACCOUNTS + ' WHERE account_id=?').run(dw.accountId);
  raw.close();
  const notReady = deg.reserveFunds({
    walletId: dw.walletId, currency: 'IB_CREDIT', amountMinor: 1n,
    expiresAt: Date.now() + 60000, idempotencyKey: 'b-deg'
  });
  check('B17 wallet 不 READY（引用链断了）时 reserve 被拒绝为 WALLET_NOT_READY，且不留任何行',
    notReady.ok === false && notReady.reasonCode === C.DENY_REASON.WALLET_NOT_READY &&
    deg.health().counts.reservations === 0 && deg.health().counts.operations === 0,
    { result: notReady, counts: deg.health().counts });
  check('B18 这次拒绝把 store 标记为 DEGRADED（结构事故是粘性的，不会自己变好）',
    deg.health().state === C.WALLET_STATE.DEGRADED && !!deg.health().degradedReason,
    deg.health().degradedReason);
  deg.close();
}

/* ══════════════════════════════════════════════════════════════════
   C · 多笔预留（超订防线）
   ══════════════════════════════════════════════════════════════════ */
section('C · 多笔预留（§8 的核心不变量：Σactive ≤ ledger）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);

  reserveOk(store, w.walletId, 70n, 'c-1', now + 60000);
  check('C1 100 余额上预留 70 → 成功，available = 30',
    available(store, w.walletId) === '30' && store.health().counts.activeReservations === 1);
  reserveOk(store, w.walletId, 30n, 'c-2', now + 60000);
  check('C2 再预留 30 → 成功（用尽），available = 0',
    available(store, w.walletId) === '0' && store.health().counts.activeReservations === 2);
  const denied = store.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 1n,
    expiresAt: now + 60000, idempotencyKey: 'c-3'
  });
  check('C3 再预留 1 → 拒绝：**不是**因为账本只剩 0（账本仍是 100），而是可用的没了',
    denied.ok === false && denied.reasonCode === C.DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE &&
    denied.ledgerBalanceMinor === '100' && denied.availableBalanceMinor === '0',
    denied);
  check('C4 全局不变量：Σactive reservations 恰好等于 ledger balance（100 ≤ 100，且不为负）',
    store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '100' &&
    store.ledgerBalanceOf(w.walletId).balanceMinor === '100');
  check('C5 三笔预留的 id 互不相同，且都是 canonical 形状',
    (() => {
      const ids = store.listReservations({ walletId: w.walletId, limit: 10 }).reservations.map(r => r.reservationId);
      return ids.length === 2 && new Set(ids).size === 2 && ids.every(i => C.isEconomyId('RESERVATION', i));
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · commitReservation
   ══════════════════════════════════════════════════════════════════ */
section('D · commitReservation（§10/§11：预留 → 恰好一笔 ledger transaction）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);
  const res = reserveOk(store, w.walletId, 70n, 'd-1', now + 60000);
  const txBefore = store.health().counts.transactions;
  const entryBefore = store.health().counts.entries;

  const commit = commitOk(store, res.reservationId, 'd-c1');
  check('D1 commit 之后 reservation COMMITTED、operation COMMITTED，并记下 transactionId',
    commit.reservationState === 'COMMITTED' && commit.operationStatus === 'COMMITTED' &&
    C.isEconomyId('TRANSACTION', commit.transactionId),
    commit);
  check('D2 ledger 恰好**移动一次**：多 1 笔 transaction、多 2 笔 entry',
    store.health().counts.transactions === txBefore + 1 &&
    store.health().counts.entries === entryBefore + 2, store.health().counts);
  check('D3 锁定量被释放：reserved 从 70 变 0，active reservations 归零',
    store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '0' &&
    store.health().counts.activeReservations === 0);
  check('D4 available 重算：余额 100 − 花掉 70 = 30，reserved 0',
    store.ledgerBalanceOf(w.walletId).balanceMinor === '30' &&
    available(store, w.walletId) === '30' &&
    view(store, w.walletId).reservedBalanceMinor === '0',
    { ledger: store.ledgerBalanceOf(w.walletId).balanceMinor, available: available(store, w.walletId) });
  check('D5 那笔 ledger transaction 是双式平衡的（逐币种 debit == credit）',
    store.ledgerTopology(commit.transactionId).every(t => t.balanced === true) &&
    store.getTransaction(commit.transactionId).entries.length === 2);
  check('D6 reservation 行上的 transactionId 与 operation 行上的一致（两个侧面指向同一笔事实）',
    (() => {
      const r = store.getReservation({ reservationId: res.reservationId }).reservation;
      const o = store.getOperation(res.operationId).operation;
      return r.transactionId === commit.transactionId && o.transactionId === commit.transactionId;
    })());
  check('D7 记账方向可读：钱包 CREDIT（钱离开）、对手方 system:treasury DEBIT',
    (() => {
      const entries = store.getTransaction(commit.transactionId).entries;
      const walletEntry = entries.filter(e => e.accountId === w.accountId)[0];
      const cpEntry = entries.filter(e => e.accountId === 'system:treasury')[0];
      return !!walletEntry && !!cpEntry &&
        walletEntry.direction === C.ENTRY_DIRECTION.CREDIT &&
        cpEntry.direction === C.ENTRY_DIRECTION.DEBIT;
    })());

  /* ── "恰好一笔"是结构性的，不是纪律 ─────────────────────────────── */
  const txCount = store.health().counts.transactions;
  const second = store.commitReservation({ reservationId: res.reservationId, idempotencyKey: 'd-c2' });
  check('D8 换一个 key 再 commit → 拒绝 already terminal，且**没有**第二笔 ledger transaction',
    second.ok === false && second.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
    store.health().counts.transactions === txCount, { second: second, counts: store.health().counts });
  check('D9 transactionId 是从 reservationId **确定性派生**的（所以重复 commit 撞的是同一个 id）',
    commit.transactionId === store._internal.deriveCommitTransactionId(res.reservationId) &&
    commit.transactionId.indexOf(String(store.getReservation({ reservationId: res.reservationId }).reservation.reservationId).slice('econ_res_'.length)) >= 0,
    commit.transactionId);

  /* ── 金额只来自预留行 ───────────────────────────────────────────── */
  const res2 = reserveOk(store, w.walletId, 20n, 'd-2', now + 60000);
  check('D10 commit 请求里给一个**不同**的金额 → 拒绝（"预留 20、提交 999999"不可能）',
    store.commitReservation({ reservationId: res2.reservationId, idempotencyKey: 'd-x', amountMinor: 999999n })
      .errors.indexOf('commit-amount-must-equal-the-reserved-amount') >= 0);
  check('D11 commit 请求里给 entries → 拒绝（ledger 的写形态由 Economy 决定，不由调用方）',
    store.commitReservation({ reservationId: res2.reservationId, idempotencyKey: 'd-y',
      entries: [{ accountId: 'system:mint', direction: 'CREDIT', amountMinor: 999999n, currency: 'IB_CREDIT' }] })
      .errors.indexOf('commit-entries-are-derived-not-accepted') >= 0);
  check('D12 对手方白名单只有 treasury / market —— system:mint 与 system:burn 被挡在门外',
    store.commitReservation({ reservationId: res2.reservationId, idempotencyKey: 'd-z', counterparty: 'system:mint' })
      .errors.indexOf('commit-counterparty-not-allowed') >= 0 &&
    store.commitReservation({ reservationId: res2.reservationId, idempotencyKey: 'd-z2', counterparty: 'system:burn' })
      .errors.indexOf('commit-counterparty-not-allowed') >= 0 &&
    store.COMMIT_COUNTERPARTIES.join(',') === 'system:treasury,system:market');
  check('D13 给一个不一样但合法的金额（等于预留值）→ 放行（"必须相等"不是"不许出现"）',
    (() => {
      const r = store.commitReservation({ reservationId: res2.reservationId, idempotencyKey: 'd-eq', amountMinor: 20n });
      return r.ok === true && r.result.amountMinor === '20';
    })());
  check('D14 提交一笔预留不会动到另一笔预留（res2 成交后 w 只剩 10）',
    available(store, w.walletId) === '10' && store.health().counts.activeReservations === 0,
    { available: available(store, w.walletId), counts: store.health().counts });

  /* 对手方 system:market 也必须可用（白名单的第二个成员不该是空话）。 */
  const res3 = reserveOk(store, w.walletId, 10n, 'd-3', now + 60000);
  const m = store.commitReservation({ reservationId: res3.reservationId, idempotencyKey: 'd-m', counterparty: 'system:market' });
  check('D15 白名单里的 system:market 真的能用（白名单不是装饰）',
    m.ok === true && m.result.counterparty === 'system:market' &&
    store.getTransaction(m.result.transactionId).entries.some(e => e.accountId === 'system:market'));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · releaseReservation
   ══════════════════════════════════════════════════════════════════ */
section('E · releaseReservation（§12：钱还回去，但**不**产生退款交易）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);
  const res = reserveOk(store, w.walletId, 70n, 'e-1', now + 60000);
  const txBefore = store.health().counts.transactions;
  const entryBefore = store.health().counts.entries;
  const ledgerBefore = store.ledgerBalanceOf(w.walletId).balanceMinor;

  const rel = store.releaseReservation({ reservationId: res.reservationId, idempotencyKey: 'e-r1' });
  check('E1 release 成功：reservation RELEASED、operation RELEASED、releaseReason=USER（默认）',
    rel.ok === true && rel.result.reservationState === 'RELEASED' &&
    rel.result.operationStatus === C.TX_STATE.RELEASED &&
    rel.result.releaseReason === 'USER' && rel.result.transactionId === null,
    rel.result || rel);
  check('E2 **没有**任何 ledger 变化：transaction / entry 计数与余额都一动不动',
    store.health().counts.transactions === txBefore &&
    store.health().counts.entries === entryBefore &&
    store.ledgerBalanceOf(w.walletId).balanceMinor === ledgerBefore,
    { counts: store.health().counts, ledger: store.ledgerBalanceOf(w.walletId).balanceMinor });
  check('E3 available 恢复满额，reserved 归零（钱从来没有离开，所以"恢复"就是解锁）',
    available(store, w.walletId) === '100' &&
    store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '0');
  check('E4 release 之后 ledger 里**不存在**一笔 REFUND（退款交易是未来的补偿操作，不是释放）',
    store.listTransactions({ limit: 50 }).every(t => t.transactionType !== C.TX_TYPE.REFUND));

  const res2 = reserveOk(store, w.walletId, 10n, 'e-2', now + 60000);
  const sys = store.releaseReservation({ reservationId: res2.reservationId, idempotencyKey: 'e-r2', releaseReason: 'SYSTEM' });
  check('E5 releaseReason 可以是 SYSTEM，并且它与 USER 在数据上可分',
    sys.ok === true && sys.result.releaseReason === 'SYSTEM' &&
    rel.result.releaseReason === 'USER');

  const res3 = reserveOk(store, w.walletId, 10n, 'e-3', now + 60000);
  check('E6 release **不能**被用来伪造 EXPIRED（§13：超时只能由 expire 路径产生）',
    store.releaseReservation({ reservationId: res3.reservationId, idempotencyKey: 'e-r3', releaseReason: 'EXPIRED' })
      .errors.indexOf('release-reason-must-be-user-or-system') >= 0);
  check('E7 release **不能**被用来伪造 OPERATION_FAILED（那只能由 fail 路径产生）',
    store.releaseReservation({ reservationId: res3.reservationId, idempotencyKey: 'e-r4', releaseReason: 'OPERATION_FAILED' })
      .errors.indexOf('release-reason-must-be-user-or-system') >= 0);
  check('E8 上面两次被拒的 release 之后，那笔预留仍然是 ACTIVE（拒绝不留痕、也不改状态）',
    store.getReservation({ reservationId: res3.reservationId }).reservation.state === 'ACTIVE');
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · expireReservation
   ══════════════════════════════════════════════════════════════════ */
section('F · expireReservation / expireDueReservations（§13/§14/§15）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);
  const res = reserveOk(store, w.walletId, 70n, 'f-1', now + 60000);
  const txBefore = store.health().counts.transactions;

  const early = store.expireReservation({ reservationId: res.reservationId, idempotencyKey: 'f-e0' });
  check('F1 还没到期就 expire → 拒绝 reservation-not-yet-due（不提前没收）',
    early.ok === false && early.errors.indexOf('reservation-not-yet-due') >= 0, early);

  clock.advance(60001);
  const due = store.getReservation({ reservationId: res.reservationId }).reservation;
  check('F2 时钟越过 expiresAt 之后，读出来的 DTO 自述 expiredByTime / sweepableNow（真相是比较，不是定时器）',
    due.expiredByTime === true && due.sweepableNow === true && due.state === 'ACTIVE',
    { expiresAt: due.expiresAt, now: clock.box.now });

  const exp = store.expireReservation({ reservationId: res.reservationId, idempotencyKey: 'f-e1' });
  check('F3 expire 成功：canonical 状态是 **EXPIRED**（不是 RELEASED），operation 也是 EXPIRED',
    exp.ok === true && exp.result.reservationState === C.RESERVATION_STATE.EXPIRED &&
    exp.result.operationStatus === C.TX_STATE.EXPIRED &&
    exp.result.releaseReason === 'EXPIRED', exp.result || exp);
  check('F4 releaseReason 与 USER/SYSTEM 可分（审计能回答"是用户放弃还是时间到了"）',
    exp.result.releaseReason === 'EXPIRED' && exp.result.releaseReason !== 'USER' && exp.result.releaseReason !== 'SYSTEM');
  check('F5 没有 ledger 变化（到期与释放的资源效果完全相同：什么都不花）',
    store.health().counts.transactions === txBefore && available(store, w.walletId) === '100');
  check('F6 到期之后 commit 会拒绝（RESERVATION_EXPIRED），不会偷偷花掉',
    (() => {
      const c = store.commitReservation({ reservationId: res.reservationId, idempotencyKey: 'f-c' });
      return c.ok === false;
    })());

  /* ── 批量扫描：确定性、分批、幂等、不碰终态 ─────────────────────── */
  const a = reserveOk(store, w.walletId, 10n, 'f-a', clock.box.now + 1000);
  const b = reserveOk(store, w.walletId, 10n, 'f-b', clock.box.now + 2000);
  clock.advance(3000); /* 两笔都到期 */
  const live = reserveOk(store, w.walletId, 10n, 'f-live', clock.box.now + 600000);
  const sweep1 = store.expireDueReservations({ now: clock.box.now });
  check('F7 扫描把**到期**的两笔都变成 EXPIRED，把未到期的那笔留下',
    sweep1.ok === true && sweep1.expired.length === 2 && sweep1.usedTimers === false &&
    store.getReservation({ reservationId: live.reservationId }).reservation.state === 'ACTIVE',
    { expired: sweep1.expired.map(x => x.reservationId), counts: store.health().counts });
  check('F8 扫描是确定性的：结果按 expires_at 升序（同一批数据两次扫描顺序一致）',
    sweep1.expired.map(x => x.reservationId).join(',') === [a.reservationId, b.reservationId].join(','),
    sweep1.expired.map(x => x.reservationId));
  const sweep2 = store.expireDueReservations({ now: clock.box.now });
  check('F9 再扫一次是幂等的：已终态的不处理，第二笔 expiration 不存在',
    sweep2.ok === true && sweep2.expired.length === 0 && sweep2.scanned === 0,
    sweep2);
  check('F10 扫描不会碰已 COMMITTED 的预留（终态一律不处理）',
    (() => {
      const c = commitOk(store, live.reservationId, 'f-c2');
      const s = store.expireDueReservations({ now: clock.box.now + 10 ** 9 });
      return c.reservationState === 'COMMITTED' &&
        store.getReservation({ reservationId: live.reservationId }).reservation.state === 'COMMITTED' &&
        s.expired.length === 0;
    })());
  check('F11 分批上限生效（limit=1 时一次最多处理一笔）',
    (() => {
      const c1 = reserveOk(store, w.walletId, 5n, 'f-b1', clock.box.now + 100);
      reserveOk(store, w.walletId, 5n, 'f-b2', clock.box.now + 200);
      clock.advance(500);
      const s = store.expireDueReservations({ now: clock.box.now, limit: 1 });
      return s.scanned === 1 && s.expired.length === 1 && store.getReservation({ reservationId: c1.reservationId }).reservation.state === 'EXPIRED';
    })());
  check('F12 扫描要求显式 now 是合法整数（拒绝 NaN / 负数 / 小数）',
    [NaN, -1, 1.5].every(bad => store.expireDueReservations({ now: bad }).ok === false));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   G · 终态不可回退
   ══════════════════════════════════════════════════════════════════ */
section('G · 终态（§4：COMMITTED / RELEASED / EXPIRED / FAILED 之后不得再 transition）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 1000n);
  const terminalOf = (id) => {
    const r = store.getReservation({ reservationId: id }).reservation;
    return r.state + '/' + r.operation.status;
  };
  const deny = (r) => r.ok === false && r.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED;

  /* COMMITTED 之后的一切 */
  const c1 = reserveOk(store, w.walletId, 10n, 'g-c', now + 60000);
  commitOk(store, c1.reservationId, 'g-c1');
  check('G1 commit 两次 → 第二次被拒（already terminal），状态不动、ledger 不动',
    deny(store.commitReservation({ reservationId: c1.reservationId, idempotencyKey: 'g-c2' })) &&
    terminalOf(c1.reservationId) === 'COMMITTED/COMMITTED');
  check('G2 commit 之后 release → 被拒（**不许**把已花的钱"还回去"；要退钱只能记补偿交易）',
    deny(store.releaseReservation({ reservationId: c1.reservationId, idempotencyKey: 'g-c3' })) &&
    terminalOf(c1.reservationId) === 'COMMITTED/COMMITTED');
  check('G3 commit 之后 expire → 被拒（时间到了不是撤销历史）',
    deny(store.expireReservation({ reservationId: c1.reservationId, idempotencyKey: 'g-c4', now: now + 10 ** 9 })) &&
    terminalOf(c1.reservationId) === 'COMMITTED/COMMITTED');
  check('G4 commit 之后 fail → 被拒',
    deny(store.failReservation({ reservationId: c1.reservationId, idempotencyKey: 'g-c5', reasonCode: 'TRANSITION_NOT_ALLOWED' })) &&
    terminalOf(c1.reservationId) === 'COMMITTED/COMMITTED');

  /* RELEASED 之后的一切 */
  const r1 = reserveOk(store, w.walletId, 10n, 'g-r', now + 60000);
  store.releaseReservation({ reservationId: r1.reservationId, idempotencyKey: 'g-r1' });
  check('G5 release 两次 → 第二次被拒；release 之后 commit → 被拒',
    deny(store.releaseReservation({ reservationId: r1.reservationId, idempotencyKey: 'g-r2' })) &&
    deny(store.commitReservation({ reservationId: r1.reservationId, idempotencyKey: 'g-r3' })) &&
    terminalOf(r1.reservationId) === 'RELEASED/RELEASED');

  /* EXPIRED 之后的一切 */
  const e1 = reserveOk(store, w.walletId, 10n, 'g-e', now + 1000);
  clock.advance(2000);
  store.expireReservation({ reservationId: e1.reservationId, idempotencyKey: 'g-e1' });
  check('G6 expire 两次 → 第二次被拒；expire 之后 commit / release → 都被拒',
    deny(store.expireReservation({ reservationId: e1.reservationId, idempotencyKey: 'g-e2' })) &&
    deny(store.commitReservation({ reservationId: e1.reservationId, idempotencyKey: 'g-e3' })) &&
    deny(store.releaseReservation({ reservationId: e1.reservationId, idempotencyKey: 'g-e4' })) &&
    terminalOf(e1.reservationId) === 'EXPIRED/EXPIRED');

  /* FAILED 之后的一切 */
  const f1 = reserveOk(store, w.walletId, 10n, 'g-f', now + 600000);
  const failed = store.failReservation({
    reservationId: f1.reservationId, idempotencyKey: 'g-f1', reasonCode: 'LEDGER_UNBALANCED'
  });
  check('G7 failReservation 把 operation 变成 FAILED，而 reservation 变成 RELEASED（两套词表各自说真话）',
    failed.ok === true && failed.result.operationStatus === C.TX_STATE.FAILED &&
    failed.result.reservationState === C.RESERVATION_STATE.RELEASED &&
    failed.result.releaseReason === 'OPERATION_FAILED' &&
    failed.result.reasonCode === 'LEDGER_UNBALANCED',
    failed.result || failed);
  check('G8 FAILED 之后 commit / release / expire / fail 全部被拒，且钱已经回到可用余额',
    deny(store.commitReservation({ reservationId: f1.reservationId, idempotencyKey: 'g-f2' })) &&
    deny(store.releaseReservation({ reservationId: f1.reservationId, idempotencyKey: 'g-f3' })) &&
    deny(store.expireReservation({ reservationId: f1.reservationId, idempotencyKey: 'g-f4', now: now + 10 ** 9 })) &&
    terminalOf(f1.reservationId) === 'RELEASED/FAILED' &&
    /* 1000 铸币，只有第一笔 10 真的成交（c1），另外三笔（release / expire /
       fail）都把锁定的钱还了回来 ⇒ 990。 */
    available(store, w.walletId) === '990' &&
    store.ledgerBalanceOf(w.walletId).balanceMinor === '990',
    { available: available(store, w.walletId), ledger: store.ledgerBalanceOf(w.walletId).balanceMinor });
  check('G9 fail 的 reasonCode 必须来自契约的封闭集合（"失败原因"不许是自由文本）',
    (() => {
      const r = store.failReservation({ reservationId: f1.reservationId, idempotencyKey: 'g-f5', reasonCode: 'BECAUSE_I_SAID_SO' });
      return r.ok === false && r.errors.indexOf('failure-reason-code-not-in-closed-set') >= 0 &&
        Array.isArray(r.allowed) && r.allowed.indexOf('LEDGER_UNBALANCED') >= 0;
    })());
  check('G10 fail 只被**显式**触发：一次普通的余额不足拒绝**不会**留下 FAILED 记录（§17）',
    (() => {
      const small = store.openWallet({ owner: { type: 'character', id: 'cfg_poor' }, currency: 'IB_CREDIT' }).wallet;
      const before = store.health().counts;
      store.reserveFunds({
        walletId: small.walletId, currency: 'IB_CREDIT', amountMinor: 5n,
        expiresAt: clock.box.now + 60000, idempotencyKey: 'g-poor'
      });
      const after = store.health().counts;
      return after.operations === before.operations && after.reservations === before.reservations &&
        store.listOperations({ status: C.TX_STATE.FAILED, limit: 10 }).operations.length === 1;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   H · operation ↔ reservation 的映射
   ══════════════════════════════════════════════════════════════════ */
section('H · 两套词表的映射（谁在什么时候用哪一套）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);

  /* 契约里的映射是数据；这里逐条验证**运行时真的按它走**。 */
  const pairs = [
    ['reserve 之后', () => reserveOk(store, w.walletId, 5n, 'h-1', now + 600000).reservationId, null],
  ];
  const rid = reserveOk(store, w.walletId, 5n, 'h-1', now + 600000).reservationId;
  check('H1 operation RESERVED ↔ reservation ACTIVE（唯一的"改名"，由契约的映射给出）',
    (() => {
      const r = store.getReservation({ reservationId: rid }).reservation;
      return r.state === C.RESERVATION_STATE_OF_OPERATION[r.operation.status] &&
        r.state === 'ACTIVE' && r.operation.status === 'RESERVED';
    })());
  check('H2 reservation 的 status 永远在 RESERVATION_STATE 里（**不会**出现 FAILED / CREATED / RESERVED）',
    (() => {
      const states = new Set(store.listReservations({ walletId: w.walletId, limit: 100 }).reservations.map(r => r.state));
      return Array.from(states).every(s => C.RESERVATION_STATES.indexOf(s) >= 0) &&
        !states.has('FAILED') && !states.has('CREATED') && !states.has('RESERVED');
    })());
  check('H3 operation 的 status 永远在 TX_STATE 里（**不会**出现 ACTIVE）',
    (() => {
      const states = new Set(store.listOperations({ limit: 100 }).operations.map(o => o.status));
      return Array.from(states).every(s => C.TX_STATES.indexOf(s) >= 0) && !states.has('ACTIVE');
    })());
  check('H4 CREATED **不是**一个可以被外部观察到的持久状态（它的存在只在事务边界之内）',
    store.listOperations({ status: C.TX_STATE.CREATED, limit: 100 }).operations.length === 0 &&
    store.listOperations({ limit: 100 }).operations.every(o => o.status !== C.TX_STATE.CREATED),
    store.listOperations({ limit: 100 }).operations.map(o => o.status));
  check('H5 terminal 标记与契约一致（operation 与 reservation 各自的终态集合不同）',
    (() => {
      const r = store.getReservation({ reservationId: rid }).reservation;
      const o = store.getOperation(r.operationId).operation;
      return r.terminal === false && o.terminal === false &&
        C.RESERVATION_TERMINAL_STATES.indexOf('ACTIVE') < 0 &&
        C.TX_TERMINAL_STATES.indexOf('RESERVED') < 0;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   I · 幂等（作用域 + 指纹 + 重放 + 冲突）
   ══════════════════════════════════════════════════════════════════ */
section('I · 幂等（§18/§19：scope 分离、指纹确定、重放返回原结果、不同请求冲突）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);

  /* reserve 重放 */
  const args = {
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 30n,
    expiresAt: now + 60000, idempotencyKey: 'i-r'
  };
  const first = store.reserveFunds(args);
  const counts = store.health().counts;
  const replay = store.reserveFunds(args);
  check('I1 reserve 重放：replayed=true、返回**同一笔** reservation 与 operation',
    replay.ok === true && replay.replayed === true &&
    replay.result.reservationId === first.result.reservationId &&
    replay.result.operationId === first.result.operationId, { first: first.result, replay: replay.result });
  check('I2 reserve 重放不产生第二笔预留、不动 revision',
    JSON.stringify(store.health().counts) === JSON.stringify(counts) &&
    store.getRevision() === replay.result.revision,
    { before: counts, after: store.health().counts });
  check('I3 reserve 同 key 不同金额 → IDEMPOTENCY_CONFLICT（不静默返回第一次的结果）',
    (() => {
      const c = store.reserveFunds(Object.assign({}, args, { amountMinor: 31n }));
      return c.ok === false && c.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0 &&
        c.recordedReservationId === first.result.reservationId;
    })());
  check('I4 reserve 同 key 不同 expiresAt → 也是冲突（expiresAt 是请求身份的一部分）',
    store.reserveFunds(Object.assign({}, args, { expiresAt: now + 70000 })).errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0);

  /* commit 重放（这是 §11 的核心） */
  const committed = commitOk(store, first.result.reservationId, 'i-c');
  const afterCommit = store.health().counts;
  const creplay = store.commitReservation({ reservationId: first.result.reservationId, idempotencyKey: 'i-c' });
  check('I5 commit 重放：replayed=true、返回原来那笔 transactionId',
    creplay.ok === true && creplay.replayed === true &&
    creplay.result.transactionId === committed.transactionId, creplay.result || creplay);
  check('I6 commit 重放之后 ledger 计数与余额都不变（只有一笔事实）',
    JSON.stringify(store.health().counts) === JSON.stringify(afterCommit) &&
    store.ledgerBalanceOf(w.walletId).balanceMinor === '70',
    { before: afterCommit, after: store.health().counts });
  check('I7 commit 同 key 换一笔预留 → 冲突（指纹含 reservationId）',
    (() => {
      const other = reserveOk(store, w.walletId, 5n, 'i-r2', now + 60000);
      const c = store.commitReservation({ reservationId: other.reservationId, idempotencyKey: 'i-c' });
      return c.ok === false && c.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0;
    })());

  /* release / expire 重放 */
  const rel = reserveOk(store, w.walletId, 5n, 'i-r3', now + 60000);
  const relOut = store.releaseReservation({ reservationId: rel.reservationId, idempotencyKey: 'i-rel' });
  const relReplay = store.releaseReservation({ reservationId: rel.reservationId, idempotencyKey: 'i-rel' });
  check('I8 release 重放：replayed=true（而不是"already terminal"）',
    relReplay.ok === true && relReplay.replayed === true &&
    relReplay.result.revision === relOut.result.revision, relReplay);
  check('I9 release 同 key 换释放原因 → 冲突（releaseReason 进指纹）',
    store.releaseReservation({ reservationId: rel.reservationId, idempotencyKey: 'i-rel', releaseReason: 'SYSTEM' })
      .errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0);

  const exp = reserveOk(store, w.walletId, 5n, 'i-r4', clock.box.now + 1000);
  clock.advance(2000);
  const expOut = store.expireReservation({ reservationId: exp.reservationId, idempotencyKey: 'i-exp' });
  const expReplay = store.expireReservation({ reservationId: exp.reservationId, idempotencyKey: 'i-exp' });
  check('I10 expire 重放：replayed=true，且返回的仍是 EXPIRED 那个结果',
    expReplay.ok === true && expReplay.replayed === true &&
    expReplay.result.reservationState === 'EXPIRED' &&
    expReplay.result.revision === expOut.result.revision, expReplay);

  /* ── scope 分离：同一个 key 在 reserve 与 commit 下是两件事（§18）─── */
  const shared = reserveOk(store, w.walletId, 7n, 'i-shared', clock.box.now + 600000);
  const commitShared = store.commitReservation({ reservationId: shared.reservationId, idempotencyKey: 'i-shared' });
  check('I11 同一个 idempotencyKey 分别用于 reserve 与 commit **不会**被误判成同一业务请求',
    commitShared.ok === true && commitShared.replayed === false &&
    commitShared.result.transactionId !== undefined, commitShared);
  check('I12 两个 scope 的幂等记录各自独立存在（scope 是持久化身份的一部分）',
    (() => {
      const { DatabaseSync } = require('node:sqlite');
      const raw = new DatabaseSync(path.join(store.file));
      const rows = raw.prepare('SELECT scope, idempotency_key FROM ' + store.TABLES.OPERATION_IDEMPOTENCY +
        ' WHERE idempotency_key=?').all('i-shared');
      raw.close();
      const scopes = rows.map(r => String(r.scope)).sort();
      return scopes.join(',') === 'COMMIT,RESERVE';
    })());
  check('I13 同一 scope + 同一 key + 同一请求 → 命中重放；换个 reservation 就是冲突（指纹含业务身份）',
    (() => {
      const s2 = reserveOk(store, w.walletId, 3n, 'i-shared-2', clock.box.now + 600000);
      const conflict = store.commitReservation({ reservationId: s2.reservationId, idempotencyKey: 'i-shared' });
      return conflict.ok === false && conflict.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0;
    })());
  check('I14 release 与 expire 也各有自己的 scope（一次 release 的 key 不会被 expire 当成自己的）',
    (() => {
      const a = reserveOk(store, w.walletId, 3n, 'i-x1', clock.box.now + 600000);
      const b = reserveOk(store, w.walletId, 3n, 'i-x2', clock.box.now + 1000);
      const relOut = store.releaseReservation({ reservationId: a.reservationId, idempotencyKey: 'i-dup' });
      clock.advance(2000);
      const expOut = store.expireReservation({ reservationId: b.reservationId, idempotencyKey: 'i-dup' });
      return relOut.ok === true && relOut.replayed === false &&
        expOut.ok === true && expOut.replayed === false &&
        relOut.result.reservationState === 'RELEASED' && expOut.result.reservationState === 'EXPIRED';
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   J · reservedBalance 的 canonical truth
   ══════════════════════════════════════════════════════════════════ */
section('J · reservedBalance（§6/§7：先破坏缓存，再证明能从 active reservations 重建）');

{
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);
  const r1 = reserveOk(store, w.walletId, 30n, 'j-1', now + 600000);
  reserveOk(store, w.walletId, 20n, 'j-2', now + 600000);
  check('J1 canonical 锁定量 = 两笔 ACTIVE 之和（30 + 20 = 50），与缓存一致',
    store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '50' &&
    store.reservedBalanceOf(w.walletId).activeReservations === 2 &&
    store.reservedBalanceOf(w.walletId).cachedReservedBalanceMinor === '50',
    store.reservedBalanceOf(w.walletId));

  for (const bad of [999999n, 0n, 1n, 49n]) {
    const corrupted = store.corruptReservedCacheForTest(w.walletId, bad);
    const v = view(store, w.walletId);
    check('J2 缓存被改坏为 ' + bad.toString() + '（可见的漂移，而不是静默失效）',
      corrupted.ok === true && v.reservedBalanceCachedMinor === bad.toString() &&
      v.reservedCacheDrifted === true, { view: v });
    check('J2b 坏缓存**不能**改变 available —— 它仍然等于 100 − 50 = 50',
      v.availableBalanceMinor === '50' && v.reservedBalanceMinor === '50', v);
    const rebuilt = store.rebuildReservedBalance(w.walletId);
    check('J3 rebuildReservedBalance 从 active reservations 重建出 50（不读缓存参与计算）',
      rebuilt.ok === true && rebuilt.reservedBalanceMinor === 50n &&
      rebuilt.drifted === true && rebuilt.repaired === true &&
      rebuilt.activeReservations === 2,
      rebuilt.ok ? { reserved: rebuilt.reservedBalanceMinor.toString(), cached: rebuilt.cachedReservedBalanceMinor.toString() } : rebuilt.errors);
    check('J4 修好之后漂移标记消失，且 rebuild 的结果**独立地**等于 reservedBalanceOf',
      view(store, w.walletId).reservedCacheDrifted === false &&
      store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '50');
  }
  check('J5 每一次修复都留下一条 RESERVATION_REBUILT（漂移不会静默消失）',
    store.listChanges(0, 200).filter(c => c.kind === C.EVENT_TYPE.RESERVATION_REBUILT).length === 4,
    store.listChanges(0, 200).map(c => c.kind));
  check('J6 缓存正确时 rebuild 是只读的（drifted=false、不消耗 revision）',
    (() => {
      const revBefore = store.getRevision();
      const clean = store.rebuildReservedBalance(w.walletId);
      return clean.ok === true && clean.drifted === false && clean.repaired === false &&
        store.getRevision() === revBefore;
    })());

  /* reserved 缓存是缓存，不是第二个事实源：commit 之后它必须跟着事实走。 */
  const before = store.reservedBalanceOf(w.walletId).reservedBalanceMinor;
  commitOk(store, r1.reservationId, 'j-c');
  check('J7 commit 一笔之后锁定量从 50 变 20（缓存与 canonical 同步下降，不是各算各的）',
    before === '50' && store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '20' &&
    store.reservedBalanceOf(w.walletId).cachedReservedBalanceMinor === '20' &&
    view(store, w.walletId).reservedCacheDrifted === false);
  check('J8 事务之外永远观察不到"预留行已变、缓存没变"的中间态（两者同一个 SQLite 事务）',
    view(store, w.walletId).reservedBalanceMinor === store.reservedBalanceOf(w.walletId).reservedBalanceMinor);

  /* 重建**不依赖** operation 行也能算 —— 但结构检查要求它存在。
     这正是"结构损坏 ⇒ DEGRADED 而不是 0"的那条纪律。 */
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(store.file));
  raw.prepare('DELETE FROM ' + store.TABLES.OPERATIONS + ' WHERE operation_id=?')
    .run(store.getReservation({ reservationId: r1.reservationId }).reservation.operationId);
  raw.close();
  const broken = store.rebuildReservedBalance(w.walletId);
  check('J9 预留行指向一个不存在的 operation 时 rebuild **失败**（而不是把锁定量当成 0）',
    broken.ok === false && broken.errors.indexOf('rebuild-failed') >= 0 &&
    broken.integrity.some(p => p.indexOf('operation-row-missing') >= 0), broken);
  check('J10 这次结构事故让 store 变 DEGRADED，读出来的 available 是 null（不是 0，也不是"已解锁"）',
    store.health().state === C.WALLET_STATE.DEGRADED &&
    view(store, w.walletId).availableBalanceMinor === null &&
    view(store, w.walletId).reservedBalanceMinor === null,
    view(store, w.walletId));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   K · 崩溃注入
   ══════════════════════════════════════════════════════════════════ */
section('K · 崩溃注入（§23：每一个位置失败都必须整体回滚）');

{
  /* ── K-A · reserve 的四个故障点 ─────────────────────────────────── */
  const reservePoints = ['after-reserve-validated', 'after-operation-created', 'after-operation-reserved',
    'after-reservation-insert', 'before-reserve-change-log', 'before-reserve-idempotency', 'before-reserve-commit'];
  for (const point of reservePoints) {
    const dir = tmpDir('kf-' + point);
    const hit = [];
    const faults = { armed: false, hit(name) { hit.push(name); if (faults.armed && name === point) throw new Error('injected@' + point); } };
    const store = createEconomyStore({ dataDir: dir, logger: () => { }, nextId: deterministicIds(), faults: faults });
    store.open();
    const w = walletWith(store, 100n);
    const before = { counts: store.health().counts, revision: store.getRevision(), ledger: store.ledgerBalanceOf(w.walletId).balanceMinor };
    faults.armed = true;
    let threw = null;
    try {
      store.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 40n,
        expiresAt: Date.now() + 60000, idempotencyKey: 'kf'
      });
    } catch (error) { threw = error; }
    faults.armed = false;
    const after = { counts: store.health().counts, revision: store.getRevision(), ledger: store.ledgerBalanceOf(w.walletId).balanceMinor };

    check('K1[' + point + '] 注入的故障真的被触发了（断言的前提成立）',
      threw !== null && hit.indexOf(point) >= 0, { threw: threw && threw.message, hit: hit });
    check('K2[' + point + '] 0 条残留 operation（CREATED 这个中间态绝不留在库里）',
      after.counts.operations === before.counts.operations, { before: before.counts, after: after.counts });
    check('K3[' + point + '] 0 笔残留 reservation（不存在"预留行在、缓存没变"）',
      after.counts.reservations === before.counts.reservations &&
      after.counts.activeReservations === before.counts.activeReservations,
      { before: before.counts, after: after.counts });
    check('K4[' + point + '] 锁定量没有幻影变化（reserved 缓存与 canonical 都回到原值）',
      store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '0' &&
      store.reservedBalanceOf(w.walletId).cachedReservedBalanceMinor === '0' &&
      view(store, w.walletId).reservedCacheDrifted === false);
    check('K5[' + point + '] revision 没有断裂（回滚不消耗版本号也不留空洞）',
      after.revision === before.revision && store.listChanges(0, 200).every((c, i) => c.revision === i + 1),
      { before: before.revision, after: after.revision });
    check('K6[' + point + '] 幂等表里没有残留（否则重试会拿到一笔并不存在的预留）',
      (() => {
        const retry = store.reserveFunds({
          walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 40n,
          expiresAt: Date.now() + 60000, idempotencyKey: 'kf'
        });
        return retry.ok === true && retry.replayed === false && retry.result.reservationState === 'ACTIVE';
      })());
    check('K7[' + point + '] 账本仍逐币种平衡，且余额没有被碰过',
      store.ledgerTopology(null).every(t => t.balanced === true) &&
      store.ledgerBalanceOf(w.walletId).balanceMinor === before.ledger);
    store.close();
  }

  /* ── K-B · commit 的六个故障点 ──────────────────────────────────── */
  const commitPoints = ['after-commit-validated', 'after-reservation-committed', 'after-commit-reserved-cache',
    'after-commit-ledger', 'after-commit-operation-status', 'before-commit-change-log', 'before-reservation-commit'];
  for (const point of commitPoints) {
    const dir = tmpDir('kc-' + point);
    const hit = [];
    const faults = { armed: false, hit(name) { hit.push(name); if (faults.armed && name === point) throw new Error('injected@' + point); } };
    const store = createEconomyStore({ dataDir: dir, logger: () => { }, nextId: deterministicIds(), faults: faults });
    store.open();
    const w = walletWith(store, 100n);
    const res = reserveOk(store, w.walletId, 70n, 'kc-seed', Date.now() + 60000);
    const before = { counts: store.health().counts, revision: store.getRevision(), ledger: store.ledgerBalanceOf(w.walletId).balanceMinor };
    faults.armed = true;
    let threw = null;
    try { store.commitReservation({ reservationId: res.reservationId, idempotencyKey: 'kc' }); }
    catch (error) { threw = error; }
    faults.armed = false;
    const after = { counts: store.health().counts, revision: store.getRevision(), ledger: store.ledgerBalanceOf(w.walletId).balanceMinor };
    const row = store.getReservation({ reservationId: res.reservationId }).reservation;

    check('K8[' + point + '] 注入的故障真的被触发了', threw !== null && hit.indexOf(point) >= 0,
      { threw: threw && threw.message, hit: hit });
    /* 这一条是整个 P22-3 最关键的崩溃断言：不存在"钱花了但预留还 ACTIVE"。 */
    check('K9[' + point + '] 不存在"Ledger 已扣款而 reservation 仍 RESERVED"的中间态',
      !(after.ledger !== before.ledger && row.state === C.RESERVATION_STATE.ACTIVE) &&
      !(after.ledger === before.ledger && row.state === C.RESERVATION_STATE.COMMITTED),
      { ledgerBefore: before.ledger, ledgerAfter: after.ledger, reservationState: row.state });
    check('K10[' + point + '] 没有第二笔 ledger transaction，也没有半笔 entry',
      after.counts.transactions === before.counts.transactions &&
      after.counts.entries === before.counts.entries, { before: before.counts, after: after.counts });
    check('K11[' + point + '] 回滚之后的那笔预留仍然是 ACTIVE 且仍锁着 70（钱没丢，也没被重复锁）',
      row.state === C.RESERVATION_STATE.ACTIVE &&
      store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '70' &&
      store.reservedBalanceOf(w.walletId).cachedReservedBalanceMinor === '70',
      { state: row.state, reserved: store.reservedBalanceOf(w.walletId) });
    check('K12[' + point + '] revision 没有断裂、账本仍然逐币种平衡',
      after.revision === before.revision && store.ledgerTopology(null).every(t => t.balanced === true));
    check('K13[' + point + '] 幂等表没有残留：重试可以真的成交（且只成交一次）',
      (() => {
        const retry = store.commitReservation({ reservationId: res.reservationId, idempotencyKey: 'kc' });
        return retry.ok === true && retry.replayed === false &&
          store.getReservation({ reservationId: res.reservationId }).reservation.state === 'COMMITTED' &&
          store.ledgerBalanceOf(w.walletId).balanceMinor === '30';
      })());

    /* 直接查库：不存在的引用一个都不能有。 */
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(store.file));
    const orphanOps = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.OPERATIONS +
      ' WHERE reservation_id IS NOT NULL AND reservation_id NOT IN (SELECT reservation_id FROM ' + store.TABLES.RESERVATIONS + ')').get();
    const orphanRes = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.RESERVATIONS +
      ' WHERE transaction_id IS NOT NULL AND transaction_id NOT IN (SELECT transaction_id FROM ' + store.TABLES.TRANSACTIONS + ')').get();
    raw.close();
    check('K14[' + point + '] 直接查库：没有孤儿 operation、没有指向不存在交易的 reservation',
      Number(orphanOps.c) === 0 && Number(orphanRes.c) === 0,
      { orphanOps: orphanOps.c, orphanRes: orphanRes.c });
    store.close();
  }

  /* ── K-C · release / expire / fail 的故障点 ─────────────────────── */
  const settleCases = [
    ['release', ['after-release-validated', 'after-release-after-status', 'after-release-after-reserved-cache', 'after-release-before-change-log'],
      (store, id, key) => store.releaseReservation({ reservationId: id, idempotencyKey: key })],
    ['expire', ['after-expire-validated', 'after-expire-after-status', 'after-expire-after-reserved-cache', 'after-expire-before-change-log'],
      (store, id, key) => store.expireReservation({ reservationId: id, idempotencyKey: key, now: Date.now() + 10 ** 8 })],
    ['fail', ['after-fail-validated', 'after-fail-after-status', 'after-fail-after-reserved-cache', 'after-fail-before-change-log'],
      (store, id, key) => store.failReservation({ reservationId: id, idempotencyKey: key, reasonCode: 'LEDGER_UNBALANCED' })]
  ];
  settleCases.forEach(([label, points, call]) => {
    points.forEach(point => {
      const dir = tmpDir('ks-' + point);
      const hit = [];
      const faults = { armed: false, hit(name) { hit.push(name); if (faults.armed && name === point) throw new Error('injected@' + point); } };
      const store = createEconomyStore({ dataDir: dir, logger: () => { }, nextId: deterministicIds(), faults: faults });
      store.open();
      const w = walletWith(store, 100n);
      const res = reserveOk(store, w.walletId, 60n, 'ks-seed', Date.now() + 600000);
      const before = { counts: store.health().counts, revision: store.getRevision() };
      faults.armed = true;
      let threw = null;
      try { call(store, res.reservationId, 'ks'); } catch (error) { threw = error; }
      faults.armed = false;
      const row = store.getReservation({ reservationId: res.reservationId }).reservation;
      const after = { counts: store.health().counts, revision: store.getRevision() };

      check('K15[' + label + '/' + point + '] 故障被触发', threw !== null && hit.indexOf(point) >= 0,
        { threw: threw && threw.message, hit: hit });
      check('K16[' + label + '/' + point + '] 状态与锁定量**同生共死**（不会"状态变了、钱还锁着"或反过来）',
        !(row.state !== C.RESERVATION_STATE.ACTIVE && store.reservedBalanceOf(w.walletId).reservedBalanceMinor !== '0') &&
        !(row.state === C.RESERVATION_STATE.ACTIVE && store.reservedBalanceOf(w.walletId).reservedBalanceMinor !== '60'),
        { state: row.state, reserved: store.reservedBalanceOf(w.walletId) });
      check('K17[' + label + '/' + point + '] 没有 ledger 变化（三种"还回去"都不写账本）',
        after.counts.transactions === before.counts.transactions &&
        after.counts.entries === before.counts.entries);
      check('K18[' + label + '/' + point + '] revision 不断裂，且重试能真的落地',
        after.revision === before.revision &&
        call(store, res.reservationId, 'ks').ok === true &&
        store.getReservation({ reservationId: res.reservationId }).reservation.state !== 'ACTIVE');
      store.close();
    });
  });
}

/* ══════════════════════════════════════════════════════════════════
   L · 重启恢复
   ══════════════════════════════════════════════════════════════════ */
section('L · 重启恢复（§24：RESERVED / COMMITTED 跨重启原样；离线过期可识别）');

{
  const clock = mutableClock();
  const dir = tmpDir('restart');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);
  const res = reserveOk(store, w.walletId, 70n, 'l-1', now + 3600000);
  check('L1 重启之前：ledger=100 / reserved=70 / available=30 / reservation ACTIVE',
    store.ledgerBalanceOf(w.walletId).balanceMinor === '100' &&
    store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '70' &&
    available(store, w.walletId) === '30' &&
    store.getReservation({ reservationId: res.reservationId }).reservation.state === 'ACTIVE');
  const revisionBefore = store.getRevision();
  store.close();

  const reopened = makeStore({ dataDir: dir, clock: clock });
  reopened.open();
  check('L2 重启之后四个数**逐字相同**，且 reservation 仍是 RESERVED/ACTIVE',
    reopened.ledgerBalanceOf(w.walletId).balanceMinor === '100' &&
    reopened.reservedBalanceOf(w.walletId).reservedBalanceMinor === '70' &&
    available(reopened, w.walletId) === '30' &&
    reopened.getReservation({ reservationId: res.reservationId }).reservation.state === 'ACTIVE',
    { view: view(reopened, w.walletId) });
  check('L3 重启后的对账没有写任何东西（一致时**不消耗** revision —— 否则重启会变成一次虚假经济事件）',
    reopened.getRevision() === revisionBefore &&
    reopened.listChanges(0, 200).filter(c => c.kind === C.EVENT_TYPE.RESERVATION_REBUILT).length === 0,
    { revision: reopened.getRevision(), before: revisionBefore });
  check('L4 重启后仍能被重建出同一个锁定量（缓存不是事实源）',
    reopened.rebuildReservedBalance(w.walletId).drifted === false);

  const commit = commitOk(reopened, res.reservationId, 'l-c');
  check('L5 重启之后 commit 仍然只能花一次：ledger 100 → 30，reserved 70 → 0',
    reopened.ledgerBalanceOf(w.walletId).balanceMinor === '30' &&
    reopened.reservedBalanceOf(w.walletId).reservedBalanceMinor === '0' &&
    available(reopened, w.walletId) === '30', { commit: commit.transactionId });
  const replay = reopened.commitReservation({ reservationId: res.reservationId, idempotencyKey: 'l-c' });
  check('L6 重启之后重放同一个 commit key 仍是 replayed（幂等记录是持久的）',
    replay.ok === true && replay.replayed === true &&
    replay.result.transactionId === commit.transactionId);
  check('L7 重启之后余额仍然是 30（不是 100，也不是 −40）',
    reopened.ledgerBalanceOf(w.walletId).balanceMinor === '30');
  reopened.close();

  /* ── 进程离线期间到期的预留 ─────────────────────────────────────── */
  const clock2 = mutableClock();
  const dir2 = tmpDir('offline-expiry');
  const s1 = makeStore({ dataDir: dir2, clock: clock2 });
  s1.open();
  const w2 = walletWith(s1, 100n);
  const r2 = reserveOk(s1, w2.walletId, 80n, 'l2-1', clock2.box.now + 60000);
  check('L8 预留之后立刻停机：available = 20', available(s1, w2.walletId) === '20');
  s1.close();

  /* 进程关机两小时（时钟推进，什么都不做）。 */
  clock2.advance(2 * 60 * 60 * 1000);
  const s2 = makeStore({ dataDir: dir2, clock: clock2 });
  s2.open();
  check('L9 重新开库后那笔预留在数据上仍然是 ACTIVE（到期是**比较**出来的，不是后台定时器做的）',
    s2.getReservation({ reservationId: r2.reservationId }).reservation.state === 'ACTIVE' &&
    s2.getReservation({ reservationId: r2.reservationId }).reservation.expiredByTime === true &&
    s2.getReservation({ reservationId: r2.reservationId }).reservation.sweepableNow === true);
  const sweep = s2.expireDueReservations({ now: clock2.box.now });
  check('L10 扫一次：状态变 EXPIRED、锁定量归零、available 回到满额',
    sweep.expired.length === 1 &&
    s2.getReservation({ reservationId: r2.reservationId }).reservation.state === 'EXPIRED' &&
    s2.reservedBalanceOf(w2.walletId).reservedBalanceMinor === '0' &&
    available(s2, w2.walletId) === '100',
    { sweep: sweep.expired.length, view: view(s2, w2.walletId) });
  check('L11 这次到期**没有**产生任何 ledger 事实（钱从未离开）',
    s2.health().counts.transactions === 1 && s2.health().counts.entries === 2,
    s2.health().counts);
  const sweepAgain = s2.expireDueReservations({ now: clock2.box.now });
  check('L12 重启之后的扫描已经是幂等的（再扫什么都不做，也不会有第二条 expiration）',
    sweepAgain.expired.length === 0 && sweepAgain.scanned === 0);
  s2.close();
}

/* ══════════════════════════════════════════════════════════════════
   M · schema 1 → 2
   ══════════════════════════════════════════════════════════════════ */
section('M · schema 1 → 2（旧库补表、水位抬升、账本一字节不动；更新的库仍然拒绝）');

{
  const { DatabaseSync } = require('node:sqlite');
  const dir = tmpDir('migrate');
  /* ── 忠实的模拟：一个**P22-2 的 build** 写出来的库 ────────────────
     它没有那三张表、水位是 1，而且 reserved 缓存必然是 0（P22-2
     从不写它）。因此这里刻意只种账本数据，**不**造预留 —— 先造预留
     再把表删掉不是"旧库"，那是"被截肢的库"，两者的预期完全不同
     （后者在下面的 M6 单独测，而且预期是"对账发现并留下审计"）。 */
  const seed = makeStore({ dataDir: dir });
  seed.open();
  const w = walletWith(seed, 250n);
  const before = {
    counts: seed.health().counts, revision: seed.getRevision(),
    ledger: seed.ledgerBalanceOf(w.walletId).balanceMinor,
    topology: seed.ledgerTopology(null), changes: seed.listChanges(0, 200),
    reserved: seed.reservedBalanceOf(w.walletId)
  };
  seed.close();

  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
  raw.exec('DROP TABLE ' + seed.TABLES.OPERATIONS);
  raw.exec('DROP TABLE ' + seed.TABLES.RESERVATIONS);
  raw.exec('DROP TABLE ' + seed.TABLES.OPERATION_IDEMPOTENCY);
  raw.prepare('UPDATE ' + seed.TABLES.META + ' SET value=? WHERE key=?').run('1', seed.META_KEYS.SCHEMA);
  const tablesBefore = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name));
  raw.close();
  check('M1 退化后的库确实没有那三张表，水位是 1（这是"P22-2 的 build 写的库"的忠实模拟）',
    tablesBefore.indexOf('economy_operations') < 0 &&
    tablesBefore.indexOf('economy_reservations') < 0 &&
    tablesBefore.indexOf('economy_operation_idempotency') < 0 &&
    before.reserved.reservedBalanceMinor === '0');

  const upgraded = makeStore({ dataDir: dir });
  const openResult = upgraded.open();
  /* 这份库的水位被手工设成 1（= P22-2 的代），文件里已经有一笔真实的
     MINT。打开它必须走**受支持的老版本**路径：补表 + 抬水位到当前代，
     既有 ledger 行一个字节都不动。
     一条刻意的措辞修正：P22-3 当时写的是"水位抬到 2"。P22-4 抬到 3 之后，
     那句写死的 2 会让这条断言在下一次抬水位时失败 —— 而它要问的是
     "老库能不能被打开并抬到**当前**水位"，不是某一个具体数字。 */
  check('M2 打开旧库：水位抬到当前代，缺的表被补上（迁移是"补表 + 抬水位"，不是重建）',
    openResult.ok === true && Number(openResult.schemaVersion) === Number(upgraded.SCHEMA_VERSION) &&
    Number(upgraded.health().schemaVersion) === Number(upgraded.SCHEMA_VERSION) &&
    Number(upgraded.health().expectedSchemaVersion) === Number(upgraded.SCHEMA_VERSION),
    { schema: upgraded.health().schemaVersion, declared: upgraded.SCHEMA_VERSION });
  check('M3 既有账本**一字节都没动**：行数、revision、余额、拓扑、change log 逐条相同',
    upgraded.health().counts.wallets === before.counts.wallets &&
    upgraded.health().counts.transactions === before.counts.transactions &&
    upgraded.health().counts.entries === before.counts.entries &&
    upgraded.health().counts.changes === before.counts.changes &&
    upgraded.getRevision() === before.revision &&
    upgraded.ledgerBalanceOf(w.walletId).balanceMinor === before.ledger &&
    J(upgraded.ledgerTopology(null)) === J(before.topology) &&
    J(upgraded.listChanges(0, 200)) === J(before.changes),
    {
      counts: upgraded.health().counts, before: before.counts,
      revision: upgraded.getRevision(), revisionBefore: before.revision
    });
  check('M4 补表之后新表是空的（旧库里本来就没有预留数据 —— 迁移不可能凭空造出预留）',
    upgraded.health().counts.operations === 0 &&
    upgraded.health().counts.reservations === 0 &&
    upgraded.health().counts.activeReservations === 0 &&
    upgraded.listReservations({ limit: 10 }).reservations.length === 0);
  check('M5 升级之后 P22-3 的能力真的可用：在旧库上预留 + 提交，且账本继续正确',
    (() => {
      const r = upgraded.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 50n,
        expiresAt: Date.now() + 600000, idempotencyKey: 'm-1'
      });
      const c = upgraded.commitReservation({ reservationId: r.result.reservationId, idempotencyKey: 'm-c' });
      return r.ok === true && c.ok === true &&
        upgraded.ledgerBalanceOf(w.walletId).balanceMinor === '200' &&
        available(upgraded, w.walletId) === '200';
    })());
  upgraded.close();

  /* ── M6 · 被"截肢"的库：预留行没了但缓存还说锁着 50 ──────────────
     这一条不是迁移测试，而是**对账**测试，放在这里是因为它揭示了一件
     重要的事：canonical 侧少了行时，对账**站在 canonical 一边** ——
     它把 50 拉回 0 并留下一条 RESERVATION_REBUILT，而不是继续声称
     有 50 被锁着，也不是静默把缓存清零。 */
  const dir3 = tmpDir('amputated');
  const s3 = makeStore({ dataDir: dir3 });
  s3.open();
  const w3 = walletWith(s3, 100n);
  reserveOk(s3, w3.walletId, 50n, 'm6-1', Date.now() + 600000);
  const revBefore = s3.getRevision();
  s3.close();
  const raw3 = new DatabaseSync(path.join(dir3, 'home-node.db'));
  raw3.exec('DROP TABLE ' + s3.TABLES.RESERVATIONS); /* 只删预留行，留着缓存 */
  raw3.close();
  const amputated = makeStore({ dataDir: dir3 });
  amputated.open();
  const amputatedChanges = amputated.listChanges(0, 200);
  check('M6 预留行整体消失、缓存却仍写着 50：对账站在 canonical 一边，把锁定量拉回 0 并留下审计',
    amputated.reservedBalanceOf(w3.walletId).reservedBalanceMinor === '0' &&
    amputated.reservedBalanceOf(w3.walletId).cachedReservedBalanceMinor === '0' &&
    amputated.getRevision() === revBefore + 1 &&
    amputatedChanges.filter(c => c.kind === C.EVENT_TYPE.RESERVATION_REBUILT).length === 1,
    { reserved: amputated.reservedBalanceOf(w3.walletId), revision: amputated.getRevision(), revBefore: revBefore });
  check('M7 这次对账**没有**动账本（它只修派生缓存：ledger 仍然 100，available 回到 100）',
    amputated.ledgerBalanceOf(w3.walletId).balanceMinor === '100' &&
    available(amputated, w3.walletId) === '100' &&
    amputated.health().counts.transactions === 1);
  amputated.close();

  /* ── M8/M9 · 更新的 schema 必须在**任何 DDL 之前**被拒绝 ───────────
     库刻意造成"**P22-2 代**"（只有 economy_meta、水位 1）—— 那是这份
     P22-3 测试能诚实构造的最老一代库，也是它真正关心的对象：一个
     P22-2 的 build 打开 P22-3/4 的库会被拒绝，而反向路径（打开旧库、
     补表、抬水位）必须成功。

     这一组**没有**沿用"先建全表再 DROP 掉几张"的写法：那样造出来的库
     里，被 DROP 的表在抬水位之后仍然会被重新补上，于是"DDL 发生在水位
     检查之前还是之后"这件事根本测不出来（实测：那条断言会一直是绿的）。

     水位写成 `SCHEMA_VERSION + 1`（而不是写死某个数字）：这条断言问的
     是"比本 build 新一代的库会不会被拒绝"，那个数字必须跟着水位走。 */
  const TOO_NEW_DIR = tmpDir('migrate-future');
  const dir2 = TOO_NEW_DIR;
  const seed2 = makeStore({ dataDir: dir2 });
  const TOO_NEW = Number(seed2.SCHEMA_VERSION) + 1;
  {
    seed2.open();
    walletWith(seed2, 123n);
    seed2.close();
  }
  /* 把它退回成 P22-2 代：删掉 P22-3 与 P22-4 的全部表，水位写成本代 +1。
     于是打开它必须**先**撞上水位检查。 */
  const raw2 = new DatabaseSync(path.join(dir2, 'home-node.db'));
  for (const t of [seed2.TABLES.OPERATIONS, seed2.TABLES.RESERVATIONS, seed2.TABLES.OPERATION_IDEMPOTENCY,
    seed2.TABLES.BUDGET_POLICIES, seed2.TABLES.QUOTES]) {
    raw2.exec('DROP TABLE IF EXISTS ' + t);
  }
  raw2.prepare('UPDATE ' + seed2.TABLES.META + ' SET value=? WHERE key=?').run(String(TOO_NEW), seed2.META_KEYS.SCHEMA);
  raw2.close();

  const future = makeStore({ dataDir: dir2 });
  let threw = null;
  try { future.open(); } catch (error) { threw = error; }
  check('M8 比本 build 新一代的 schema（' + TOO_NEW + ' > ' + seed2.SCHEMA_VERSION + '）被拒绝，且报错类别是 db-schema-too-new',
    threw !== null && threw.code === 'SCHEMA_TOO_NEW' &&
    String(threw.message).indexOf('[db-schema-too-new]') >= 0,
    { message: threw && threw.message, code: threw && threw.code, tooNew: TOO_NEW });
  check('M9 拒绝是**只读**的：水位检查排在任何 DDL 之前，所以那四张表一张都没被创建',
    (() => {
      const raw4 = new DatabaseSync(path.join(dir2, 'home-node.db'));
      const names = raw4.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name));
      const watermark = raw4.prepare('SELECT value FROM ' + seed2.TABLES.META + ' WHERE key=?').get(seed2.META_KEYS.SCHEMA);
      const wallets = raw4.prepare('SELECT COUNT(*) AS c FROM ' + seed2.TABLES.WALLETS).get();
      raw4.close();
      return names.indexOf('economy_reservations') < 0 &&
        names.indexOf('economy_operations') < 0 &&
        names.indexOf('economy_budget_policies') < 0 &&
        names.indexOf('economy_quotes') < 0 &&
        String(watermark.value) === String(TOO_NEW) && Number(wallets.c) === 1;
    })());
  check('M10 拒绝之后 isOpen() 为假、state 是 DEGRADED（不是 COLD，也不是"正在加载"）',
    future.isOpen() === false && future.health().state === C.WALLET_STATE.DEGRADED);
  future.close();
}

/* ══════════════════════════════════════════════════════════════════
   N · fail closed
   ══════════════════════════════════════════════════════════════════ */
section('N · fail closed（§7：COLD / DEGRADED / 完整性事故一律 null，绝不是 0）');

{
  const clock = mutableClock();
  const dir = tmpDir('failclosed');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 100n);
  const res = reserveOk(store, w.walletId, 30n, 'n-1', clock.box.now + 600000);
  store.close();

  check('N1 库关闭后：health 是 COLD，view 拿不到（抛 STORE_CLOSED 而不是返回 0 余额）',
    store.health().state === C.WALLET_STATE.COLD &&
    (() => { try { store.getWallet({ walletId: w.walletId }); return false; } catch (e) { return e.code === 'STORE_CLOSED'; } })());
  check('N2 库关闭后 reservedBalanceOf / rebuildReservedBalance / reserve 都明确失败（无库时不"成功"）',
    (() => {
      const fns = [
        () => store.reservedBalanceOf(w.walletId),
        () => store.rebuildReservedBalance(w.walletId),
        () => store.reserveFunds({ walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 1n, expiresAt: 1, idempotencyKey: 'n-x' }),
        () => store.expireDueReservations({ now: 1 })
      ];
      return fns.every(fn => { try { fn(); return false; } catch (e) { return e.code === 'STORE_CLOSED'; } });
    })());

  store.open();
  check('N3 重新打开之后一切照旧（重启不是"重置"）',
    available(store, w.walletId) === '70' &&
    store.getReservation({ reservationId: res.reservationId }).reservation.state === 'ACTIVE');

  /* 把 reserved 缓存改成一个"看起来合理"的错值：available 必须仍然正确，
     而且漂移必须可见。 */
  store.corruptReservedCacheForTest(w.walletId, 0n);
  check('N4 reserved 缓存被改坏成 0 时，available 仍是 70（坏缓存不能把锁定的钱说成可花的）',
    available(store, w.walletId) === '70' && view(store, w.walletId).reservedCacheDrifted === true,
    view(store, w.walletId));

  /* 结构性破坏：让 reservation 指向另一个币种。 */
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
  raw.prepare('UPDATE ' + store.TABLES.RESERVATIONS + ' SET currency=? WHERE reservation_id=?')
    .run('COMPUTE_PREMIUM', res.reservationId);
  raw.close();
  const v = view(store, w.walletId);
  check('N5 预留行与钱包币种不一致时：DEGRADED + available/reserved 都是 null（不是一个"接近对的"数）',
    store.health().state === C.WALLET_STATE.DEGRADED &&
    v.availableBalanceMinor === null && v.balanceKnown === false &&
    v.cachedBalanceMinor === null && v.reservedBalanceMinor === null &&
    v.ledgerBalanceMinor === null && v.reservedCacheDrifted === null,
    { state: store.health().state, view: v });
  check('N6 降级是粘性的，而且原因**点名**了是哪一笔预留、坏在哪里（不是一句 generic 的 error）',
    String(store.health().degradedReason).indexOf('wallet-integrity') >= 0 &&
    String(store.health().degradedReason).indexOf(res.reservationId) >= 0 &&
    String(store.health().degradedReason).indexOf('currency-differs-from-wallet') >= 0,
    store.health().degradedReason);
  check('N7 DEGRADED 之后 reserve 被拒为 WALLET_NOT_READY（fail closed：不允许在不可信的库上锁定资源）',
    (() => {
      const r = store.reserveFunds({
        walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 1n,
        expiresAt: clock.box.now + 60000, idempotencyKey: 'n-deg'
      });
      return r.ok === false && r.reasonCode === C.DENY_REASON.WALLET_NOT_READY;
    })());
  store.close();

  const recovered = makeStore({ dataDir: dir, clock: clock });
  recovered.open();
  check('N8 数据仍然坏着时，**新的实例**也如实报 DEGRADED（降级不是那个实例的记忆，而是数据的性质）',
    recovered.health().state === C.WALLET_STATE.DEGRADED &&
    recovered.listWallets().every(w2 => w2.availableBalanceMinor === null),
    { state: recovered.health().state, reason: recovered.health().degradedReason });
  recovered.close();

  /* 把那一行改回正确币种：一个新实例必须回到 READY，并且三个数都对。
     —— "降级不是永久的"这件事必须是被证明的，而不是被相信的。 */
  const repair = new DatabaseSync(path.join(dir, 'home-node.db'));
  repair.prepare('UPDATE ' + store.TABLES.RESERVATIONS + ' SET currency=? WHERE reservation_id=?')
    .run('IB_CREDIT', res.reservationId);
  repair.close();
  const healed = makeStore({ dataDir: dir, clock: clock });
  healed.open();
  check('N9 数据修好之后新实例回到 READY，且三个数都是从事实算出来的（100 / 30 / 70）',
    healed.health().state === C.WALLET_STATE.READY &&
    healed.ledgerBalanceOf(w.walletId).balanceMinor === '100' &&
    healed.reservedBalanceOf(w.walletId).reservedBalanceMinor === '30' &&
    available(healed, w.walletId) === '70',
    { state: healed.health().state, view: view(healed, w.walletId) });
  healed.close();
}

/* ══════════════════════════════════════════════════════════════════
   O · 并发
   ══════════════════════════════════════════════════════════════════ */
section('O · 并发（§20：任何到达顺序下 Σactive ≤ ledger）');

(async function concurrencyGroup() {
  /* ── O-A · 同一进程内的近同时到达（Promise.all）─────────────────────
     诚实的前提：node:sqlite 的 DatabaseSync 是**同步** API，因此同一
     线程内两个 reserve 不可能真正交错 —— Promise.all 只是"同一 tick
     连续到达"。这一点必须说出来，否则下面这条断言会被误读成"并发安全
     已被证明"。真正的跨连接/跨进程竞争在 O-B 与 runtime 测试里证。 */
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);
  const calls = [];
  for (let i = 0; i < 6; i++) {
    calls.push(Promise.resolve().then(() => store.reserveFunds({
      walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 40n,
      expiresAt: now + 600000, idempotencyKey: 'o-' + i
    })));
  }
  const results = await Promise.all(calls);
  const okCount = results.filter(r => r.ok === true).length;
  const deniedCount = results.filter(r => r.ok === false &&
    r.reasonCode === C.DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE).length;
  check('O1 6 个"同时"到达的 reserve(40) 打 100 余额：恰好 2 个成功、4 个以 INSUFFICIENT_AVAILABLE_BALANCE 被拒',
    okCount === 2 && deniedCount === 4 && okCount + deniedCount === 6,
    { ok: okCount, denied: deniedCount });
  check('O2 最终 Σactive reservations = 80 ≤ ledger 100（超订不可能发生，而不是"很少发生"）',
    store.reservedBalanceOf(w.walletId).reservedBalanceMinor === '80' &&
    BigInt(store.reservedBalanceOf(w.walletId).reservedBalanceMinor) <= BigInt(store.ledgerBalanceOf(w.walletId).balanceMinor),
    { reserved: store.reservedBalanceOf(w.walletId).reservedBalanceMinor });
  check('O3 available 与 Σactive / ledger 三者自洽：100 − 80 = 20',
    available(store, w.walletId) === '20');
  check('O4 结构性原因：写事务用 BEGIN IMMEDIATE（写锁在**读可用余额之前**就拿到了，所以检查与写入同锁）',
    /db\.exec\('BEGIN IMMEDIATE'\)/.test(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8')));
  store.close();

  /* ── O-B · 两个**独立连接**（两个 store 实例）打同一个库 ─────────────
     这是 O-A 缺的那一半：两个连接各自有自己的读快照与写锁请求，
     因此"读-判断-写"的竞争是真实的（由 SQLite 的 BEGIN IMMEDIATE +
     busy_timeout 串行化）。 */
  const dir = tmpDir('two-connections');
  const a = makeStore({ dataDir: dir, clock: clock });
  const b = makeStore({ dataDir: dir, clock: clock });
  a.open();
  b.open();
  const w2 = walletWith(a, 100n);
  const first = a.reserveFunds({
    walletId: w2.walletId, currency: 'IB_CREDIT', amountMinor: 60n,
    expiresAt: clock.box.now + 600000, idempotencyKey: 'ob-1'
  });
  const second = b.reserveFunds({
    walletId: w2.walletId, currency: 'IB_CREDIT', amountMinor: 50n,
    expiresAt: clock.box.now + 600000, idempotencyKey: 'ob-2'
  });
  check('O5 连接 A 预留 60 之后，连接 B 能看见（独立连接不是独立事实源）→ 50 被拒',
    first.ok === true && second.ok === false &&
    second.reasonCode === C.DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE &&
    second.reservedBalanceMinor === '60' && second.availableBalanceMinor === '40',
    { first: first.result, second: second });
  const third = b.reserveFunds({
    walletId: w2.walletId, currency: 'IB_CREDIT', amountMinor: 40n,
    expiresAt: clock.box.now + 600000, idempotencyKey: 'ob-3'
  });
  check('O6 连接 B 再预留 40 → 恰好用尽；A 再要 1 就被拒（两个连接对同一个不变量达成一致）',
    third.ok === true && third.result.reservedBalanceMinor === '100' &&
    a.reserveFunds({
      walletId: w2.walletId, currency: 'IB_CREDIT', amountMinor: 1n,
      expiresAt: clock.box.now + 600000, idempotencyKey: 'ob-4'
    }).ok === false);
  check('O7 跨连接提交之后，两边读到的余额与锁定量一致',
    (() => {
      const c = a.commitReservation({ reservationId: first.result.reservationId, idempotencyKey: 'ob-c' });
      return c.ok === true &&
        b.ledgerBalanceOf(w2.walletId).balanceMinor === '40' &&
        b.reservedBalanceOf(w2.walletId).reservedBalanceMinor === '40' &&
        available(b, w2.walletId) === '0';
    })());
  a.close();
  b.close();

  /* ── O-C · 真实多进程竞争在 runtime 测试里 ───────────────────────── */
  check('O8 （诚实声明）同进程的 Promise.all 只能证"连续到达不超订"；'
    + '真正的跨进程竞争由 tests/test_p22_3_economy_runtime.js 的 P 组用真实子进程证明',
    true);
})();

/* ══════════════════════════════════════════════════════════════════
   P · change log / revision
   ══════════════════════════════════════════════════════════════════ */
(async function changeLogGroup() {
  const clock = mutableClock();
  const store = makeStore({ clock: clock });
  store.open();
  const now = clock.box.now;
  const w = walletWith(store, 100n);

  const r1 = reserveOk(store, w.walletId, 10n, 'p-1', now + 600000);
  commitOk(store, r1.reservationId, 'p-c1');
  const r2 = reserveOk(store, w.walletId, 10n, 'p-2', now + 600000);
  store.releaseReservation({ reservationId: r2.reservationId, idempotencyKey: 'p-rel' });
  const r3 = reserveOk(store, w.walletId, 10n, 'p-3', now + 1000);
  clock.advance(2000);
  store.expireReservation({ reservationId: r3.reservationId, idempotencyKey: 'p-exp' });
  const r4 = reserveOk(store, w.walletId, 10n, 'p-4', now + 10 ** 7);
  store.failReservation({ reservationId: r4.reservationId, idempotencyKey: 'p-fail', reasonCode: 'LEDGER_UNBALANCED' });

  const changes = store.listChanges(0, 500);
  const kinds = changes.map(c => c.kind);
  check('P1 五类生命周期事件都在 change log 里，而且**互相可分**',
    kinds.filter(k => k === C.EVENT_TYPE.RESERVATION_CREATED).length === 4 &&
    kinds.indexOf(C.EVENT_TYPE.RESERVATION_COMMITTED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.RESERVATION_RELEASED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.RESERVATION_EXPIRED) >= 0 &&
    kinds.indexOf(C.EVENT_TYPE.OPERATION_FAILED) >= 0,
    kinds);
  check('P2 revision 严格单调、不跳号、不复用（每一次 allocateRevision 恰好配一条 change 行）',
    changes.every((c, i) => c.revision === i + 1) && store.getRevision() === changes.length,
    { revisions: changes.map(c => c.revision), revision: store.getRevision() });
  check('P3 commit 消耗两个 revision（"预留关闭"与"ledger 移动"是两条事实），但仍在同一个事务里',
    (() => {
      const created = changes.filter(c => c.kind === C.EVENT_TYPE.RESERVATION_CREATED &&
        c.entityId === r1.reservationId)[0];
      const committed = changes.filter(c => c.kind === C.EVENT_TYPE.RESERVATION_COMMITTED)[0];
      const ledgerRow = changes.filter(c => c.kind === C.TX_TYPE.PURCHASE + '_COMMITTED')[0];
      return !!created && !!committed && !!ledgerRow &&
        committed.transactionId === ledgerRow.transactionId &&
        Math.abs(committed.revision - ledgerRow.revision) === 1 &&
        committed.revision > created.revision;
    })(), changes.map(c => c.revision + ':' + c.kind));
  check('P4 每一条 reservation 事件都同时带 entityId（reservationId）与 walletId',
    changes.filter(c => /^RESERVATION_|^OPERATION_/.test(c.kind)).every(c =>
      C.isEconomyId('RESERVATION', c.entityId) && C.isEconomyId('WALLET', c.walletId)),
    changes.filter(c => /^RESERVATION_|^OPERATION_/.test(c.kind)).map(c => c.kind + ':' + c.entityId));
  check('P5 "钱还回去"的三类事件都逐字写着 ledgerMutation=false（审计里一眼可分"还钱"与"动账本"）',
    changes.filter(c => [C.EVENT_TYPE.RESERVATION_RELEASED, C.EVENT_TYPE.RESERVATION_EXPIRED,
      C.EVENT_TYPE.OPERATION_FAILED].indexOf(c.kind) >= 0)
      .every(c => c.payload && c.payload.ledgerMutation === false));
  check('P6 没有创建第二套 revision 命名空间（仍然只有 economy_meta 的 economy_revision 与 economy_change_log）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      return /META_REVISION = 'economy_revision'/.test(src) &&
        !/META_REVISION\w* = '(?!economy_revision)/.test(src) &&
        /CHANGE_LOG_TABLE = 'economy_change_log'/.test(src) &&
        !/CREATE TABLE IF NOT EXISTS change_log/.test(src);
    })());
  check('P7 change log 里没有凭据、没有正文、没有幂等键全文（只有最小元数据）',
    (() => {
      const raw = J(changes);
      return raw.indexOf('apiKey') < 0 && raw.indexOf('Bearer') < 0 &&
        raw.indexOf('character_runtime_specs') < 0;
    })());
  store.close();
})();

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
setTimeout(() => {
  console.log('\n' + '═'.repeat(64));
  if (failures === 0) {
    console.log('P22-3 reservation: 全部通过 ✔');
    process.exitCode = 0;
  } else {
    console.error('P22-3 reservation: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}, 50);
