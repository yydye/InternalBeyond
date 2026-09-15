'use strict';
/* ====================================================================
   P22-7 · 多进程竞争用的 worker（fixture，不是测试）
   --------------------------------------------------------------------
   它由 tests/test_p22_7_economy_runtime.js 的 D / E / F 组 spawn 若干份，
   用来证明三件在多进程下**才**可能被证伪的事：

     D · 同一条 Approval 被两个**真实进程**分别 APPROVE / REJECT
           → 恰好一个成功；另一个要么是幂等回放、要么被状态闸门拒绝。
             **绝不能两次都成功**（那会让"用户批准了"这件事有两个答案）。
     E · 同一条 APPROVED Approval 被两个进程同时用来 prepare
           → 最多一条成功的 Purchase（quote_id 的 UNIQUE + 九元组绑定）。
     F · 故障注入点命中时的事务回滚：
             after-approval-decided     —— 决定被撤销（读回来仍是 PENDING）
             after-purchase-authorized  —— prepare 整体回滚（无 Purchase、无预留）
             before-approval-consume    —— 结算前的断层
             before-approval-decision-commit / before-purchase-settle-commit
           ★ 关键不变量：**绝不出现「批准 CONSUMED 但没有 Purchase」**，
             也绝不对应两次扣款。

   为什么必须是真进程（与 P22-3 的 reserve worker / P22-5 的 consume
   worker / P22-6 的 purchase worker 逐字同源）：node:sqlite 的
   DatabaseSync 是同步 API，单线程里两次 decide 不可能交错，因此
   "并发只有一个成功"在单进程内无法被证伪。

   模式：
     mode=decide   node p22-7-approval-worker.js decide  <dir> <approvalId> <APPROVED|REJECTED> <key> <barrierMs>
     mode=prepare  node p22-7-approval-worker.js prepare <dir> <quoteId> <approvalId> <key> <barrierMs>
     mode=consume  node p22-7-approval-worker.js consume <dir> <quoteId> <approvalId> <key> <barrierMs>
     mode=fault    node p22-7-approval-worker.js fault   <dir> <point> <quoteId> <approvalId> <key>
     mode=world    node p22-7-approval-worker.js world   <dir> [purchaseId]

   输出：一行 JSON。
   ==================================================================== */

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));

const argv = process.argv.slice(2);
const mode = String(argv[0] || '');
/* ── 具名参数（--flag value）──────────────────────────────────────────
   ★ 位置参数在这里是一个**真实缺陷**（开发期实测踩到）：fault 模式的
   调用方传的是 `fault <dir> <point> <quoteId> <approvalId> <key>`，而
   worker 内部却按 `[, dataDir, point, quoteId, approvalId, key]` 解构 ——
   于是 `point` 拿到的是 quoteId，`throwAt` 与任何真实注入点都不相等，
   **每一次注入都是静默的 no-op**，而世界看起来完全正常。
   具名参数让"谁是谁"不再依赖两边各自记住同一个顺序。 */
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
/* 与真实业务无关的通用读数：任何一条路径返回之前都把它带上，于是"最终
   世界是什么样"由每一个 worker 各自独立读一遍。 */
function worldOf(store, purchaseId) {
  const h = store.health().counts;
  const purchase = purchaseId ? store.getPurchase(purchaseId) : null;
  const list = store.listPurchases({ limit: 200 }).purchases;
  const approvals = store.listApprovals({ limit: 200 }).approvals;
  return {
    transactions: h.transactions,
    entries: h.entries,
    completedPurchases: h.completedPurchases,
    reservedPurchases: h.reservedPurchases,
    purchases: h.purchases,
    purchaseStatus: purchase && purchase.ok ? purchase.purchase.status : null,
    purchaseLedgerTransactionId: purchase && purchase.ok ? purchase.purchase.ledgerTransactionId : null,
    quoteState: purchase && purchase.ok ? purchase.quoteSummary.state : null,
    reservationState: purchase && purchase.ok ? purchase.reservationSummary.state : null,
    inventoryEntries: h.inventoryEntries,
    inventoryTotalQuantity: h.inventoryTotalQuantity,
    approvals: h.approvals,
    pendingApprovals: h.pendingApprovals,
    approvedApprovals: h.approvedApprovals,
    rejectedApprovals: h.rejectedApprovals,
    consumedApprovals: h.consumedApprovals,
    expiredApprovals: h.expiredApprovals,
    approvalStates: approvals.map(a => ({ id: a.approvalId, status: a.status, by: a.decidedBy, consumedBy: a.consumedByPurchaseId })),
    purchaseAuthorizationModes: list.map(p => ({ id: p.purchaseId, mode: p.approvalMode, approvalId: p.approvalId, autonomous: p.autonomous, requiredUserApproval: p.requiredUserApproval })),
    /* NOTE: the read-face key is approvalMode (serializePurchase's stable shape),
       not mode. Getting the name wrong makes this reading permanently undefined
       and the assertion fails as "the mode is not APPROVAL" - which looks like a
       business defect instead of a typo. */
    /* ★ 这一条是关键不变量的**独立**读数：任何一条 CONSUMED 的批准都必须
       指向一笔**存在**的购买。它由 integrity check 逐行验证。 */
    integrityProblems: store._internal.economyIntegrityCheck(),
    tornFacts: approvals.filter(a => a.status === 'CONSUMED' && a.consumedByPurchaseId == null)
      .map(a => a.approvalId)
  };
}

(async function main() {
  /* ── fault：注入点必须在**开库之前**交给 store ────────────────────────
     ★ deps.faults 的形状是 { hit(name) }（P22 §17 的唯一注入缝），而不是
     一个布尔字典。这一点值得写下来 —— 开发期实测踩到：传
     { 'after-approval-decided': true } 时 `typeof faults.hit !== 'function'`，
     于是**每一次注入都是静默的 no-op**：worker 顺利跑完、世界看起来完全
     正常，而测试以为它验证了崩溃回滚。这正是"断言必须能失败得有意义"
     要挡的假绿形状：故障没有命中，而失败无处可寻。
     ★★ 而 `hit()` 抛错**不是**一次崩溃，这一点是 P22-7 开发期最重要的
     一个发现（实测：注入 after-approval-consumed 之后结算仍然报 ok:true，
     而库里已经写下了消费）。原因是结构性的：这个缝**在事务内部**，而
     `withTransaction` 的 catch 在 store 的入口函数里被翻成一次业务拒绝 ——
     于是事务照常 COMMIT，调用方甚至看不到异常。
     真正的"崩溃"（进程消失 ⇒ 没有 COMMIT ⇒ SQLite 回滚）需要进程真的
     死掉，因此这里用 `--crash <point>`：命中那个点时直接 `process.abort()`。
     abort 是同步的、立即的，且**没有** JS catch 能拦住它 —— 于是"崩溃
     之后库里是什么样"变成了一个可以被真实读出来的问题，而不是一句推断。
     刻意只在显式要求时 abort：`world` 模式永远不崩溃。 */
  const hits = {};
  const throwAt = mode === 'fault' ? String(FLAG.point || '') : '';
  /* ★ 崩溃注入**不限于** fault 模式：`after-approval-decided` 与
     `before-approval-decision-commit` 只有 `redecide` 模式才到得了，而
     `after-approval-consumed` 在 `consume` 模式里。把 crash 绑到某一个
     模式上，会让另外两个模式里的 `--crash` 变成一次静默的 no-op ——
     而那是这一节里第三次遇到的同一种假绿（传错形状 / 传错顺序 /
     传对了但被模式挡掉）。 */
  const crashAt = String(FLAG.crash || '');
  const faults = {
    hit(name) {
      const key = String(name);
      hits[key] = (hits[key] || 0) + 1;
      if (crashAt && key === crashAt && hits[key] === 1) {
        /* 崩之前把"我确实崩在这一点上"写出去：stdout 是行缓冲的，而
           process.abort() 立刻终止进程 —— 没有这一行，外面只能看到
           "进程非零退出"，无法区分"崩在了目标点"与"崩在了别处"。 */
        try {
          process.stdout.write(JSON.stringify({
            worker: FLAG.key, mode: mode, point: key, crashed: true, hits: hits
          }) + '\n');
        } catch (_) { /* 无关紧要 */ }
        process.abort();
      }
      if (throwAt && key === throwAt && hits[key] === 1) {
        throw new Error('injected:' + key);
      }
    }
  };
  const store = createEconomyStore({ dataDir: FLAG.dir || argv[1], logger: () => { }, faults: faults });
  store.open();

  if (mode === 'decide') {
    const approvalId = FLAG.approval, decision = FLAG.decision, key = FLAG.key, barrier = FLAG.barrier;
    waitUntil(barrier);
    const startedAt = Date.now();
    const result = store.decideApproval({
      approvalId: approvalId, decision: decision,
      decidedBy: { type: 'user', id: 'user' }, idempotencyKey: key
    });
    out({
      worker: key, mode: mode, decision: decision, startedAt: startedAt, finishedAt: Date.now(),
      ok: result.ok === true,
      replayed: result.replayed === true,
      denied: result.denied === true,
      terminal: result.terminal === true,
      reasonCode: result.reasonCode || null,
      errors: result.errors || [],
      approvalStatus: result.ok === true ? result.result.status : (result.approvalStatus || null),
      world: worldOf(store, null)
    });
    store.close();
    return;
  }

  if (mode === 'prepare') {
    const quoteId = FLAG.quote, approvalId = FLAG.approval, key = FLAG.key, barrier = FLAG.barrier;
    waitUntil(barrier);
    const startedAt = Date.now();
    /* ── 可选的"先做一次决定" ────────────────────────────────────────────
       ★ 批准**决定**事务里的注入点（after-approval-decided /
       before-approval-decision-commit）只有在真的调用 decideApproval 时
       才会被命中。而 seed 已经把批准推到 APPROVED —— 于是这里必须把它
       退回 PENDING 才可能再做一次决定。用一次 expiresAt 已过的
       decideApproval 做不到这件事（它只会过期），因此这一路走的是
       "把批准重新置回 PENDING"的**测试专用**写法：直接改库。
       这不是产品路径，而是让"决定事务的原子性"可被证伪所必需的夹具。 */
    let decideResult = null;
    if (FLAG.decide === '1') {
      const sqlite = require('node:sqlite');
      const side = new sqlite.DatabaseSync(require('path').join(FLAG.dir, 'home-node.db'));
      side.exec("UPDATE economy_approvals SET status='PENDING', decided_by_id=NULL, decided_by_type=NULL, decided_at=NULL WHERE approval_id='" + String(approvalId).replace(/'/g, "''") + "'");
      side.close();
      decideResult = store.decideApproval({
        approvalId: approvalId, decision: 'APPROVED',
        decidedBy: { type: 'user', id: 'user' }, idempotencyKey: key + '-dec'
      });
    }
    let requestResult = null;
    if (FLAG.request === '1') {
      /* ★ `after-approval-requested` 与 `before-approval-request-commit`
         两个注入点**只**在 createApprovalRequest 里。而 seed 已经写下一条
         批准（APPROVED），因此这里必须真的**再请求一条**（用另一个 id）
         —— 否则那两个点在本组里永远不会被执行，而"它们也整体回滚"这句话
         就没有任何证据。 */
      requestResult = store.createApprovalRequest({
        buyerId: { type: 'character', id: 'cfg_a' }, quoteId: quoteId,
        units: 1, expiresAt: Date.now() + 6 * 60 * 60 * 1000,
        approvalId: FLAG.requestId || 'econ_approval_requested',
        idempotencyKey: key + '-req'
      });
    }
    const result = store.preparePurchase({
      quoteId: quoteId, buyerId: { type: 'character', id: 'cfg_a' },
      approvalId: approvalId,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key
    });
    out({
      worker: key, mode: mode, startedAt: startedAt, finishedAt: Date.now(),
      ok: result.ok === true,
      replayed: result.replayed === true,
      denied: result.denied === true,
      reasonCode: result.reasonCode || null,
      errors: result.errors || [],
      hits: hits,
      /* ★ 报**全部**命中点的计数，而不是只报那一个：只报一个的话，
         当那个点因为某种原因没被命中时，读数是 0 而看不出流程走到哪里。 */
      allHits: Object.keys(hits).length,
      hitCount: hits[String(FLAG.point || '')] || 0,
      decideOk: decideResult ? decideResult.ok === true : null,
      decideReason: decideResult ? (decideResult.reasonCode || null) : null,
      requestOk: requestResult ? requestResult.ok === true : null,
      requestReason: requestResult ? (requestResult.reasonCode || null) : null,
      purchaseId: result.result ? result.result.purchaseId : null,
      world: worldOf(store, result.result ? result.result.purchaseId : null)
    });
    store.close();
    return;
  }

  /* ── consume：一步走完 prepare + settle（两个进程抢同一条批准）──────── */
  if (mode === 'consume') {
    const quoteId = FLAG.quote, approvalId = FLAG.approval, key = FLAG.key, barrier = FLAG.barrier;
    waitUntil(barrier);
    const startedAt = Date.now();
    const prep = store.preparePurchase({
      quoteId: quoteId, buyerId: { type: 'character', id: 'cfg_a' },
      approvalId: approvalId,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key + '-p'
    });
    let settled = null;
    if (prep.ok === true) {
      settled = store.settlePurchase({ purchaseId: prep.result.purchaseId, idempotencyKey: key + '-s' });
    }
    out({
      worker: key, mode: mode, startedAt: startedAt, finishedAt: Date.now(),
      prepareOk: prep.ok === true,
      prepareReason: prep.reasonCode || null,
      prepareErrors: prep.errors || [],
      purchaseId: prep.result ? prep.result.purchaseId : null,
      settleOk: settled ? settled.ok === true : false,
      settleReason: settled ? (settled.reasonCode || null) : null,
      hits: hits,
      allHits: Object.keys(hits).length,
      hitCount: hits[String(FLAG.point || '')] || 0,
      ledgerTransactionId: settled && settled.result ? settled.result.ledgerTransactionId : null,
      world: worldOf(store, prep.result ? prep.result.purchaseId : null)
    });
    store.close();
    return;
  }

  /* ── fault：命中一个注入点，看世界是否整体回滚 ──────────────────────── */
  if (mode === 'fault') {
    const point = FLAG.point, quoteId = FLAG.quote, approvalId = FLAG.approval, key = FLAG.key;
    const prep = store.preparePurchase({
      quoteId: quoteId, buyerId: { type: 'character', id: 'cfg_a' },
      approvalId: approvalId,
      expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key + '-p'
    });
    let settled = null;
    if (prep.ok === true) {
      settled = store.settlePurchase({ purchaseId: prep.result.purchaseId, idempotencyKey: key + '-s' });
    }
    out({
      worker: key, mode: mode, point: point,
      /* ★ hit proof：这个注入点**真的**被命中过几次。1 = 它被执行了，
         0 = 那个点根本不存在（而那时整段"崩溃回滚"的结论都是假的）。 */
      hits: hits,
      hitCount: hits[point] || 0,
      prepareOk: prep.ok === true,
      prepareReason: prep.reasonCode || null,
      prepareErrors: prep.errors || [],
      purchaseId: prep.result ? prep.result.purchaseId : null,
      settleOk: settled ? settled.ok === true : false,
      settleReason: settled ? (settled.reasonCode || null) : null,
      world: worldOf(store, prep.result ? prep.result.purchaseId : null)
    });
    store.close();
    return;
  }

  /* ── redecide：把那条批准退回 PENDING 再做一次决定 ────────────────────
     批准**决定**事务里的两个注入点（after-approval-decided /
     before-approval-decision-commit）只有在真的调用 decideApproval 时才会
     被命中，而 seed 已经把批准推到 APPROVED。这里用它**自己的**入口把它
     退回 PENDING 再决定一次 —— 于是"决定事务的原子性"可以被真实地证伪。
     "退回 PENDING" 走的是直接改库（不是产品路径）：产品里没有"把一条
     批准复活"的操作，那正是 §9 要禁止的事。 */
  if (mode === 'redecide') {
    const approvalId = FLAG.approval, key = FLAG.key;
    const sqlite = require('node:sqlite');
    const side = new sqlite.DatabaseSync(path.join(FLAG.dir, 'home-node.db'));
    side.exec("UPDATE economy_approvals SET status='PENDING', decided_by_id=NULL, decided_by_type=NULL, decided_at=NULL WHERE approval_id='" + String(approvalId).replace(/'/g, "''") + "'");
    side.close();
    const result = store.decideApproval({
      approvalId: approvalId, decision: 'APPROVED',
      decidedBy: { type: 'user', id: 'user' }, idempotencyKey: key + '-dec'
    });
    out({
      worker: key, mode: mode, point: String(FLAG.point || ''),
      hits: hits,
      allHits: Object.keys(hits).length,
      hitCount: hits[String(FLAG.point || '')] || 0,
      ok: result.ok === true,
      reasonCode: result.reasonCode || null,
      errors: result.errors || [],
      world: worldOf(store, null)
    });
    store.close();
    return;
  }

  /* ── policy：写一条自主策略 ─────────────────────────────────────────
     `after-autonomy-policy-written` 与 `before-autonomy-policy-commit`
     这两个注入点**只**在这里可达 —— 而"注入点清单从源码推导"意味着
     它们会出现在测试的清单里。一个从不运行的注入点等于一句没有证据的
     声明，因此这一路必须有它自己的入口。 */
  if (mode === 'policy') {
    const key = FLAG.key;
    const result = store.putAutonomyPolicy({
      ownerId: { type: 'character', id: 'cfg_a' },
      enabled: true,
      perPurchaseLimitMinor: 500,
      dailyAutonomousLimitMinor: 1000,
      approvalAboveMinor: 500,
      allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'],
      allowGift: false,
      idempotencyKey: key
    });
    out({
      worker: key, mode: mode, point: String(FLAG.point || ''),
      hits: hits,
      allHits: Object.keys(hits).length,
      hitCount: hits[String(FLAG.point || '')] || 0,
      ok: result.ok === true,
      reasonCode: result.reasonCode || null,
      errors: result.errors || [],
      policyCount: store.listAutonomyPolicies({}).count,
      world: worldOf(store, null)
    });
    store.close();
    return;
  }

  /* ── resume：崩溃之后的**重试**（不新建购买，续做那一笔）─────────────
     ★ 一个真实的发现（F9 实测）：崩溃发生在一个**已经提交过**的购买之后时，
     重试**不能**再 prepare 同一份报价 —— P22-6 的 quote_id UNIQUE 会以
     `this-quote-is-already-linked-to-a-purchase` 拒绝（那正是"一份报价
     最多一笔购买"这条性质在起作用，不是缺陷）。
     正确的重试语义因此是两段的：
       ① 这份报价已经有一笔 RESERVED 的购买 → **续做它**（settle）；
       ② 没有 → prepare + settle（完整链路）。
     这也正是"崩溃之后可以安全重试"这句话该有的样子：崩溃留下的是一笔
     RESERVED 的购买与一条仍然 APPROVED 的批准，而重试把它们推到终点。 */
  if (mode === 'resume') {
    const quoteId = FLAG.quote, key = FLAG.key;
    const existing = store.listPurchases({ quoteId: quoteId, limit: 10 }).purchases;
    const reserved = existing.filter(p => p.status === 'RESERVED')[0] || null;
    if (reserved) {
      const settled = store.settlePurchase({ purchaseId: reserved.purchaseId, idempotencyKey: key + '-s' });
      out({
        worker: key, mode: mode, resumed: true, purchaseId: reserved.purchaseId,
        settleOk: settled.ok === true,
        settleReason: settled.reasonCode || null,
        settleErrors: settled.errors || [],
        ledgerTransactionId: settled.result ? settled.result.ledgerTransactionId : null,
        world: worldOf(store, reserved.purchaseId)
      });
      store.close();
      return;
    }
    const prep = store.preparePurchase({
      quoteId: quoteId, buyerId: { type: 'character', id: 'cfg_a' },
      approvalId: FLAG.approval, expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: key + '-p'
    });
    let settled2 = null;
    if (prep.ok === true) {
      settled2 = store.settlePurchase({ purchaseId: prep.result.purchaseId, idempotencyKey: key + '-s' });
    }
    out({
      worker: key, mode: mode, resumed: false,
      prepareOk: prep.ok === true,
      prepareReason: prep.reasonCode || null,
      prepareErrors: prep.errors || [],
      purchaseId: prep.result ? prep.result.purchaseId : null,
      settleOk: settled2 ? settled2.ok === true : false,
      settleReason: settled2 ? (settled2.reasonCode || null) : null,
      ledgerTransactionId: settled2 && settled2.result ? settled2.result.ledgerTransactionId : null,
      world: worldOf(store, prep.result ? prep.result.purchaseId : null)
    });
    store.close();
    return;
  }

  /* ── world：只读一个库并把世界读出来（对照组用）────────────────────── */
  if (mode === 'world') {
    const list = store.listPurchases({ limit: 200 }).purchases;
    const target = FLAG.purchase || (list.length === 1 ? list[0].purchaseId : null);
    out({ worker: 'world', mode: mode, purchaseCount: list.length, world: worldOf(store, target) });
    store.close();
    return;
  }

  out({ worker: 'unknown', ok: false, error: 'unknown-mode:' + mode });
  store.close();
  process.exit(1);
})().catch(error => {
  out({
    worker: argv[argv.length - 2] || 'unknown', mode: mode,
    crash: String(error && (error.stack || error.message || error))
  });
  process.exit(1);
});
