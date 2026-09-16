'use strict';
/* ====================================================================
   P22-8 · 多进程竞争与崩溃注入用的 worker（fixture，不是测试）
   --------------------------------------------------------------------
   它由 tests/test_p22_8_economy_runtime.js 的 D / E / F / G / H / I 组
   spawn 若干份，用来证明四件在多进程下**才**可能被证伪的事：

     D · 两个**真实进程**同时提同一份 Agent 提议（不同 key、不同理由）
           → 最多一条 canonical Intent、最多一笔购买、最多一次资金动作。
     E · 两个**真实进程**同时恢复同一条 APPROVED Intent
           → 最多消费一次 Approval、最多一笔购买。
     F · 批准**还没决定**时两个进程同时恢复
           → 两条都回答"还没决定"，而那条 intent **不得**被终结。
     G · 在 §16 点名的六个边界上 `process.abort()`（真实崩溃）
           → 重启后不得重复买、不得假完成、不得丢失等待批准状态。

   为什么必须是真进程（与 P22-3 的 reserve worker / P22-5 的 consume
   worker / P22-6 的 purchase worker / P22-7 的 approval worker 逐字同源）：
   node:sqlite 的 DatabaseSync 是同步 API，单线程里两次 propose 不可能交错，
   因此"重复的模型输出只会买一次"在单进程内**无法被证伪**。

   ── 为什么崩溃用 process.abort() 而不是"注入点抛错" ──────────────────
   P22-7 开发期最重要的一个发现：`faults.hit()` 抛出的异常发生在事务**内部**，
   而 store 的入口会把 ECONOMY_REFUSED 之外的异常原样抛出 —— 但只要有任何
   一层把它翻成一次业务拒绝，事务就会照常 COMMIT，调用方甚至看不到异常。
   实测症状是"结算报 ok:true 而库里已经写下了消费"。
   abort 是同步的、立即的，且**没有** JS catch 能拦住它 —— 于是"崩溃之后
   库里是什么样"变成一个可以被真实读出来的问题。

   模式（**具名参数**，与 P22-7 的同款纪律）：
     propose  --dir D --key K --agent A --product P [--recipient R]
              [--units N] [--reason TEXT] [--barrier MS] [--crash POINT]
     resume   --dir D --intent I [--approval A] [--key K] [--barrier MS]
              [--crash POINT]
     world    --dir D

   ★ 为什么是具名参数而不是位置参数：P22-7 实测踩到过一次真实缺陷 ——
   位置参数下调用方与 worker 各自记住的顺序不一致，于是 `--point` 拿到的是
   另一个值，**每一次注入都是静默的 no-op**，而世界看起来完全正常。
   具名参数让"谁是谁"不再依赖两边各自记住同一个顺序。

   输出：一行 JSON。
   ==================================================================== */

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));

const argv = process.argv.slice(2);
const mode = String(argv[0] || '');
const FLAG = {};
for (let i = 0; i < argv.length; i++) {
  const a = String(argv[i]);
  if (a.slice(0, 2) === '--') { FLAG[a.slice(2)] = argv[i + 1] == null ? '' : String(argv[i + 1]); i += 1; }
}

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

/* ── 与真实业务无关的通用读数 ─────────────────────────────────────────
   任何一条路径返回之前都把它带上，于是"最终世界是什么样"由每一个 worker
   各自**独立**读一遍（两个进程看到同一个答案才算"最终事实"）。
   ★★ 每一条读数都**直接从表里读**，刻意不用 `health().counts` —— 那是
   health 的一次快照，而"两个进程同时看到同一个最终事实"这条断言要的是
   各自**当下**读到的行数。开发期实测（D 组）踩到过：赢家报 COMPLETED、
   输家报 RESERVED，差异不在业务而在读数路径上（一个读了 health 的快照、
   另一个读了表）。读数是证据，因此它必须和被测的那件事用同一个来源。 */
function worldOf(store) {
  const intents = store.listPurchaseIntents({ limit: 200 }).intents;
  const purchases = store.listPurchases({ limit: 200 }).purchases;
  const approvals = store.listApprovals({ limit: 200 }).approvals;
  const wallet = store.getWallet({ ownerId: 'cfg_agent', currency: 'IB_CREDIT' });
  const changes = store.listChanges(0, 500);
  const inventory = store.listInventory({ ownerId: 'cfg_agent' });
  const inventoryEntries = inventory.ok === true ? inventory.entries : [];
  return {
    /* ★ 购买：从**表**里数，而不是从 health 的快照里数。 */
    purchases: purchases.length,
    completedPurchases: purchases.filter(p => p.status === 'COMPLETED').length,
    reservedPurchases: purchases.filter(p => p.status === 'RESERVED').length,
    /* ★ 库存：同上。 */
    inventoryEntries: inventoryEntries.length,
    inventoryTotalQuantity: inventoryEntries.reduce((a, e) => a + Number(e.quantity || 0), 0),
    /* ★ 批准：同上。 */
    approvals: approvals.length,
    pendingApprovals: approvals.filter(a => a.status === 'PENDING').length,
    approvedApprovals: approvals.filter(a => a.status === 'APPROVED').length,
    consumedApprovals: approvals.filter(a => a.status === 'CONSUMED').length,
    /* ★ Intent：同上（`countPurchaseIntentStates` 本身就是即时查询）。 */
    intents: intents.length,
    intentStates: store.countPurchaseIntentStates(),
    intentRows: intents.map(i => ({
      id: i.agentIntentId, state: i.state, quoteId: i.quoteId,
      approvalId: i.approvalId, purchaseId: i.purchaseId, authorityOutcome: i.authorityOutcome
    })),
    agentBalanceMinor: wallet.ok === true ? String(wallet.wallet.cachedBalanceMinor) : null,
    reservedBalanceMinor: wallet.ok === true ? String(wallet.wallet.reservedBalanceMinor) : null,
    ledgerBalanceMinor: wallet.ok === true ? String(wallet.wallet.ledgerBalanceMinor) : null,
    purchaseAuthorizationModes: purchases.map(p => ({
      id: p.purchaseId, mode: p.approvalMode, approvalId: p.approvalId, status: p.status
    })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    approvalStates: approvals.map(a => ({
      id: a.approvalId, status: a.status, consumedBy: a.consumedByPurchaseId
    })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    /* ★ 一次购买对应**两次**记账步骤（RESERVE + GRANT），因此这里数的是
       change log 里那两类事件的条数 —— 与 health 的 transactions 同一个
       语义，但读的是表。 */
    purchaseLedgerSteps: changes.filter(c =>
      c.kind === 'PURCHASE_RESERVED' || c.kind === 'PURCHASE_COMPLETED').length,
    /* ★ 关键不变量的**独立**读数：任何一条 CONSUMED 的批准都必须指向一笔
       **存在**的购买。它由 integrity check 逐行验证。 */
    integrityProblems: store._internal.economyIntegrityCheck(),
    tornFacts: approvals.filter(a => a.status === 'CONSUMED' && a.consumedByPurchaseId == null)
      .map(a => a.approvalId),
    /* ── 隔离的三个读数（由 change log 自己说）──────────────────────────
       它们数的是"有多少条 change log **声称**动过 provider / payment"，
       以及 payload 里出现了多少次凭据类键名。两者都必须是 0。 */
    providerMutations: changes.filter(c => c.payload && c.payload.providerMutation === true).length,
    paymentMutations: changes.filter(c => c.payload && c.payload.paymentMutation === true).length,
    credentialMentions: (JSON.stringify(changes).match(/api[_-]?key|authorization|bearer|credential|providerBalance/gi) || []).length
  };
}

(async function main() {
  /* ── 注入点必须在**开库之前**交给 store ──────────────────────────────
     ★ deps.faults 的形状是 { hit(name) }，而不是一个布尔字典。这一点值得
     写下来 —— P22-7 实测踩到：传 { 'point': true } 时
     `typeof faults.hit !== 'function'`，于是**每一次注入都是静默的
     no-op**，worker 顺利跑完、世界看起来完全正常，而测试以为它验证了崩溃。
     ★★ 而 `--crash` 走的是 process.abort()：命中那个点时进程立刻消失，
     于是 SQLite 回滚、没有 COMMIT。崩之前先把"我确实崩在这一点上"写出去
     （stdout 是行缓冲的）—— 没有那一行，外面只能看到"进程非零退出"，
     无法区分"崩在了目标点"与"崩在了别处"。 */
  const hits = {};
  const crashAt = String(FLAG.crash || '');
  const faults = {
    hit(name) {
      const key = String(name);
      hits[key] = (hits[key] || 0) + 1;
      if (crashAt && key === crashAt && hits[key] === 1) {
        try {
          process.stdout.write(JSON.stringify({
            worker: FLAG.key, mode: mode, point: key, crashed: true, hits: hits
          }) + '\n');
        } catch (_) { /* 无关紧要 */ }
        process.abort();
      }
    }
  };
  const store = createEconomyStore({ dataDir: FLAG.dir, logger: () => {}, faults: faults });
  store.open();

  /* ── propose：说出一次打算（D / G / H / I 组）─────────────────────── */
  if (mode === 'propose') {
    waitUntil(FLAG.barrier);
    const startedAt = Date.now();
    const proposal = { agentId: FLAG.agent, productId: FLAG.product, reason: FLAG.reason || 'a model said so' };
    if (FLAG.recipient) proposal.recipientId = FLAG.recipient;
    if (FLAG.units) proposal.units = Number(FLAG.units);
    const result = store.proposeAgentPurchaseIntent({
      idempotencyKey: FLAG.key, proposal: proposal
    });
    const purchase = result.purchaseId ? store.getPurchase({ purchaseId: result.purchaseId }) : null;
    out({
      worker: FLAG.key, mode: mode, startedAt: startedAt, finishedAt: Date.now(),
      ok: result.ok === true,
      created: result.created === true,
      replayed: result.replayed === true,
      suppressed: result.suppressed === true,
      suppressReason: result.suppressReason || null,
      intentId: result.intentId || (result.intent && result.intent.agentIntentId) || null,
      intentState: result.intent ? result.intent.state : null,
      authorityOutcome: result.authorityOutcome || (result.intent && result.intent.authorityOutcome) || null,
      quoteId: result.quoteId || null,
      approvalId: result.approvalId || null,
      purchaseId: result.purchaseId || null,
      mayExecute: result.mayExecute === true,
      reservedNothing: result.reservedNothing === true,
      reasonCode: result.reasonCode || null,
      errors: result.errors || [],
      suppliedEconomicFacts: result.suppliedEconomicFacts || [],
      settlementPrimitive: purchase && purchase.ok === true
        ? purchase.purchase.settlementPrimitive : null,
      hits: hits,
      hitCount: hits[crashAt] || 0,
      world: worldOf(store)
    });
    store.close();
    return;
  }

  /* ── resume：在用户决定之后继续**同一条**打算（E / F 组）──────────── */
  if (mode === 'resume') {
    waitUntil(FLAG.barrier);
    const startedAt = Date.now();
    const args = { idempotencyKey: FLAG.key };
    if (FLAG.intent) args.agentIntentId = FLAG.intent;
    if (FLAG.approval) args.approvalId = FLAG.approval;
    const result = store.resumeAgentPurchaseIntent(args);
    out({
      worker: FLAG.key, mode: mode, startedAt: startedAt, finishedAt: Date.now(),
      ok: result.ok === true,
      replayed: result.replayed === true,
      alreadyCompleted: result.alreadyCompleted === true,
      terminal: result.terminal === true,
      intentId: result.intentId || (result.intent && result.intent.agentIntentId) || null,
      intentState: result.intent ? result.intent.state : null,
      purchaseId: result.purchaseId || null,
      quoteId: result.quoteId || null,
      reservedNothing: result.reservedNothing === true,
      purchaseCreated: result.purchaseCreated === true,
      approvalStatus: result.approvalStatus || null,
      reasonCode: result.reasonCode || null,
      errors: result.errors || [],
      world: worldOf(store)
    });
    store.close();
    return;
  }

  /* ── world：只读一个库并把世界读出来（对照组用）────────────────────── */
  if (mode === 'world') {
    out({ worker: 'world', mode: mode, world: worldOf(store) });
    store.close();
    return;
  }

  out({ worker: 'unknown', mode: mode, ok: false, error: 'unknown-mode:' + mode });
  store.close();
  process.exit(1);
})().catch(error => {
  out({
    worker: FLAG.key || 'unknown', mode: mode,
    /* 崩溃注入时 abort 不会走到这里（它是同步的、不可捕获的），因此这一支
       只可能是真正的错误。 */
    crash: String(error && (error.stack || error.message || error))
  });
  process.exit(1);
});




