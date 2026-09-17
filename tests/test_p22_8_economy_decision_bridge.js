'use strict';
/* ====================================================================
   P22-8 · Decision Bridge（store 层：Intent → Quote → Authority → Purchase）
   --------------------------------------------------------------------
   运行：node tests/test_p22_8_economy_decision_bridge.js

   本文件回答的是**编排**层面的问题，而它们全部可以在单进程里被证伪：

     A 组 · §5 Intent → Product-backed Quote（价格只能来自商品行）
     B 组 · §6 三条出口：AUTO_ALLOW / REQUIRE_APPROVAL / DENY
     C 组 · §6 AUTO_ALLOW **仍然**必经 P22-6 的 Budget + 原子结算
     D 组 · §6 REQUIRE_APPROVAL 停在批准，**不** reserve / 扣钱 / 发货
     E 组 · §7 Approval 恢复路径（同一份报价、不问模型第二次、批准不复活报价）
     F 组 · §10 重复模型输出不得导致重复购买
     G 组 · §11 幂等（same key + same intent → 同一条；不同意图 → 冲突；跨重启）
     H 组 · §4 Agent 不得提供经济事实（含大小写/分隔符变体与"approved: true"）
     I 组 · §12 Gift 与 §13 Compute/API quota 的边界
     J 组 · §14 边界隔离（窄接口、没有通用执行器、没有直接调 P22-6 的路）
     K 组 · §17 可解释性（仅凭 canonical facts 回答六个问题）
     L 组 · 数据库层面的边界（表里没有经济值列、没有 DELETE、状态约束）
   ==================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const STORE_SOURCE = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-8-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
/* 确定性 id 源：与 P22-6/P22-7 的测试同款。它让"某条 id 长什么样"不再
   依赖随机，于是对一个**形状**的断言不会因为换了一次运行而失效。 */
function deterministicIds() {
  let seq = 0;
  const map = {};
  return function (kind) {
    seq += 1;
    map[kind] = (map[kind] || 0) + 1;
    const suffix = (kind === 'AGENT_INTENT' ? 'ai' : kind.toLowerCase().slice(0, 4)) + map[kind];
    return C.formatEconomyId(kind, suffix + '_' + seq).id;
  };
}
function makeStore(tag) {
  const dir = tmpDir(tag || 'bridge');
  const store = createEconomyStore({ dataDir: dir, logger: () => {}, nextId: deterministicIds() });
  store.open();
  return store;
}
let keySeq = 0;
function K(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }

const CUR = 'IB_CREDIT';

/* ── 夹具：一个货架 + 一件商品 + 一个有钱的 Agent 钱包 +（可选）预算政策 ── */
function fixture(store, options) {
  const o = options || {};
  const storeId = store.putStore({ name: 'Main Store', idempotencyKey: K('store') }).result.store.storeId;
  const productId = store.putProduct({
    storeId: storeId,
    kind: o.kind || 'COMPUTE_CREDIT',
    name: o.name || 'Compute x1000',
    currency: CUR,
    unitPriceMinor: o.unitPriceMinor == null ? 10 : o.unitPriceMinor,
    grantQuantity: o.grantQuantity == null ? 1000 : o.grantQuantity,
    idempotencyKey: K('product')
  }).result.product.productId;
  const agentId = o.agentId || 'cfg_agent';
  const wallet = store.openWallet({ owner: { type: 'character', id: agentId }, currency: CUR });
  assert2(wallet.ok, 'openWallet', wallet.errors);
  const mint = store.mintForSystem({
    systemInitiated: true, walletId: wallet.wallet.walletId, currency: CUR,
    amountMinor: o.balanceMinor == null ? 100000 : o.balanceMinor, idempotencyKey: K('mint')
  });
  assert2(mint.ok, 'mint', mint.errors);
  if (o.budget !== false) {
    const bp = store.putBudgetPolicy({
      ownerId: agentId, currency: CUR,
      limits: Object.assign({
        perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000
      }, o.limits || {}),
      idempotencyKey: K('budget')
    });
    assert2(bp.ok, 'putBudgetPolicy', bp.errors);
  }
  /* 第二个 agent 用于礼物场景。 */
  if (o.withFriend) {
    const w2 = store.openWallet({ owner: { type: 'character', id: 'cfg_friend' }, currency: CUR });
    assert2(w2.ok, 'openWallet(friend)', w2.errors);
  }
  return { storeId: storeId, productId: productId, agentId: agentId, walletId: String(wallet.wallet.walletId) };
}
function assert2(cond, label, extra) {
  if (!cond) throw new Error('fixture ' + label + ' failed: ' + J(extra));
}

/* ── 计数 helper（而不是 `listX().count`）────────────────────────────────
   ★ 开发期实测踩到的一次真实缺陷，而它值得被写下来：本文件一度到处写
   `store.listPurchases({}).count`，而一个读面若返回 `{ ok, purchases, ... }`
   （没有 `count`）时，这个表达式是 `undefined` —— 于是
   `undefined === 1` 为 false（断言失败，看得见），但
   `undefined === 0` 也为 false……而"不得出现购买"这类断言恰好写成
   `count === 0` 时会被 `undefined !== 0` 抓住，写成 `count < 1` 时却
   会**静默通过**。一个可能恒为 undefined 的读面会把"证伪"变成
   "永远为真"。因此这里逐个封装，并在内部断言它真的返回了一个数字。 */
function numeric(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('count helper ' + label + ' did not return a number: ' + J(value));
  }
  return value;
}
function purchases(store) { return numeric(store.listPurchases({}).count, 'listPurchases'); }
function approvals(store) { return numeric(store.listApprovals({}).count, 'listApprovals'); }
function quotes(store) {
  /* ★ listQuotes 与 listInventory 一样**没有** count 字段（它返回 quotes 数组），
     因此这里读长度，但仍然先断言那次读真的成功 —— 否则 `ok:false` 的空数组
     会让"没有报价"永远为真。 */
  const r = store.listQuotes({});
  if (r.ok !== true || !Array.isArray(r.quotes)) {
    throw new Error('listQuotes did not succeed: ' + J(r.errors || r));
  }
  return r.quotes.length;
}
function intents(store) { return numeric(store.listPurchaseIntents({}).count, 'listPurchaseIntents'); }
function inventoryOf(store, ownerId) {
  /* ★ listInventory 按 §51 **刻意**没有 count 字段（它返回 entries 数组），
     因此这里的 helper 与上面几个不同：它读数组长度，但仍然断言那次读
     **真的成功**了 —— 否则 `ok:false` 的空数组会让"没有库存"永远为真。 */
  const r = store.listInventory({ ownerId: ownerId });
  if (r.ok !== true || !Array.isArray(r.entries)) {
    throw new Error('listInventory did not succeed: ' + J(r.errors || r));
  }
  return r.entries.length;
}
function intentStates(store) {
  const r = store.countPurchaseIntentStates();
  if (!r || typeof r !== 'object' || C.PURCHASE_INTENT_STATES.some(k => typeof r[k] !== 'number')) {
    throw new Error('countPurchaseIntentStates did not return one number per state: ' + J(r));
  }
  return r;
}

/* ── 一份"标准"自主策略 ──────────────────────────────────────────────── */
function autonomy(store, options) {
  const o = options || {};
  const out = store.putAutonomyPolicy(Object.assign({
    ownerId: o.ownerId || 'cfg_agent', currency: CUR, enabled: true,
    perPurchaseLimitMinor: 100000, dailyAutonomousLimitMinor: 100000,
    approvalAboveMinor: 50000,
    allowedProductKinds: ['COMPUTE_CREDIT', 'DIGITAL_ITEM'],
    allowedSettlementTypes: ['COMPUTE_GRANT', 'INVENTORY_GRANT'],
    allowGift: false,
    idempotencyKey: K('autonomy')
  }, o.input || {}));
  assert2(out.ok, 'putAutonomyPolicy', out.errors);
  return out.result;
}

function propose(store, options) {
  const o = options || {};
  return store.proposeAgentPurchaseIntent({
    idempotencyKey: o.idempotencyKey || K('intent'),
    proposal: Object.assign({
      agentId: o.agentId || 'cfg_agent',
      productId: o.productId,
      reason: o.reason == null ? 'compute is running low' : o.reason
    }, o.proposal || {})
  });
}

/* ══════════════════════════════════════════════════════════════════════
   A · §5 Intent → Product-backed Quote
   ══════════════════════════════════════════════════════════════════════ */
section('A · §5 Intent → Product-backed Quote');

{
  const store = makeStore('a');
  const f = fixture(store, { unitPriceMinor: 10, grantQuantity: 1000 });
  const r = propose(store, { productId: f.productId });

  check('A1 Intent 被收下，并且**报价来自商品行**（价格 10 / 数量 1000 都是派生的）',
    r.ok === true && typeof r.quoteId === 'string' && C.isEconomyId('QUOTE', r.quoteId),
    { ok: r.ok, quoteId: r.quoteId, errors: r.errors });

  const quote = store.getQuote({ quoteId: r.quoteId }).quote;
  check('A2 报价的金额 / 币种 / 数量 / 种类逐字来自 Product，Agent 没有地方传它们',
    quote.amountMinor === 10n && quote.currency === CUR && quote.quantity === 1000 &&
    quote.productId === f.productId && quote.kind === 'COMPUTE_GRANT' && quote.settlementType === 'COMPUTE_GRANT',
    quote);

  check('A3 ★ 报价 id 由 intent **确定性派生**（同一条 intent 永远同一份报价，重放不会造第二份）',
    r.quoteId === 'econ_quote_from_' + r.intentId.replace(/^econ_agentintent_/, ''),
    { quoteId: r.quoteId, intentId: r.intentId });

  check('A4 这条路径上**没有** raw arbitrary quote 的入口：Agent 不能直接 createQuote',
    typeof store.proposeAgentPurchaseIntent === 'function' &&
    /* P22-4 的 raw createQuote 仍然存在（契约要求不动它），但它**不在**
       Decision Bridge 的任何一条路径上 —— 证据是 propose 的入参里没有
       任何金额字段，见 H 组。 */
    STORE_SOURCE.indexOf('createProductQuote({') >= 0);

  /* 商品 DISABLED / RETIRED / missing → fail closed，且**不写** intent。 */
  const beforeIntents = intentStates(store);
  const disabled = store.putProduct({
    productId: f.productId, storeId: f.storeId, kind: 'COMPUTE_CREDIT', name: 'Compute x1000',
    currency: CUR, unitPriceMinor: 10, grantQuantity: 1000, status: 'DISABLED',
    idempotencyKey: K('disable')
  });
  check('A5 商品可以转到 DISABLED（夹具成立）', disabled.ok === true, disabled.errors);

  const afterDisable = propose(store, { productId: f.productId });
  check('A6 ★ DISABLED 商品 → Intent fail closed（不生成报价、不写 intent）',
    afterDisable.ok === false && afterDisable.reasonCode === C.DENY_REASON.PRODUCT_DISABLED &&
    afterDisable.proposedNothing === true &&
    J(intentStates(store)) === J(beforeIntents),
    { reasonCode: afterDisable.reasonCode, states: intentStates(store) });

  const missing = propose(store, { productId: 'econ_product_does_not_exist' });
  check('A7 ★ missing 商品 → PRODUCT_NOT_FOUND，且 proposedNothing（一条指向不存在商品的 intent 是纯噪音）',
    missing.ok === false && missing.reasonCode === C.DENY_REASON.PRODUCT_NOT_FOUND &&
    missing.proposedNothing === true && missing.productBacked === false);

  /* RETIRED 是不可逆的终态（P22-5 只允许 DISABLED→RETIRED）。 */
  const retired = store.putProduct({
    productId: f.productId, storeId: f.storeId, kind: 'COMPUTE_CREDIT', name: 'Compute x1000',
    currency: CUR, unitPriceMinor: 10, grantQuantity: 1000, status: 'RETIRED',
    idempotencyKey: K('retire')
  });
  check('A8 商品可以转到 RETIRED（夹具成立）', retired.ok === true, retired.errors);
  const afterRetire = propose(store, { productId: f.productId });
  check('A9 ★ RETIRED 商品 → 同样 fail closed（终态商品永远买不了）',
    afterRetire.ok === false && afterRetire.reasonCode === C.DENY_REASON.PRODUCT_DISABLED);

  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   B · §6 三条出口
   ══════════════════════════════════════════════════════════════════════ */
section('B · §6 三条出口（AUTO_ALLOW / REQUIRE_APPROVAL / DENY）');

{
  /* B1/B2 AUTO_ALLOW */
  const store = makeStore('b1');
  const f = fixture(store);
  autonomy(store);
  const r = propose(store, { productId: f.productId });
  check('B1 ★ AUTO_ALLOW → Intent 直接走到 COMPLETED（P22-6 被执行了）',
    r.ok === true && r.intent.state === 'COMPLETED' && r.authorityOutcome === 'AUTO_ALLOW' &&
    typeof r.purchaseId === 'string',
    { state: r.intent && r.intent.state, authority: r.authorityOutcome, purchaseId: r.purchaseId, errors: r.errors });
  const purchase = store.getPurchase({ purchaseId: r.purchaseId }).purchase;
  check('B2 那笔购买的 approvalMode 是 AUTO_ALLOW，且它指得出放行它的那条策略',
    purchase.status === 'COMPLETED' && purchase.approvalMode === 'AUTO_ALLOW' &&
    typeof purchase.autonomyPolicyId === 'string',
    { status: purchase.status, mode: purchase.approvalMode, policyId: purchase.autonomyPolicyId });
  store.close();
}

{
  /* B3/B4 REQUIRE_APPROVAL */
  const store = makeStore('b3');
  const f = fixture(store);
  /* **没有**自主策略 → P22-7 的 fail closed 是 REQUIRE_APPROVAL。 */
  const r = propose(store, { productId: f.productId });
  check('B3 ★ 没有策略 → REQUIRE_APPROVAL，Intent 停在 WAITING_APPROVAL',
    r.ok === true && r.intent.state === 'WAITING_APPROVAL' && r.mayExecute === false &&
    r.nextAction === 'await-approval' && typeof r.approvalId === 'string',
    { state: r.intent && r.intent.state, next: r.nextAction, approvalId: r.approvalId, errors: r.errors });
  check('B4 那条批准是 PENDING，而且它绑定的报价就是这条 intent 的那一份',
    (function () {
      const a = store.getApproval({ approvalId: r.approvalId }).approval;
      return a.status === 'PENDING' && a.quoteId === r.quoteId && a.productId === f.productId;
    })());
  store.close();
}

{
  /* B5 DENY */
  const store = makeStore('b5');
  const f = fixture(store);
  autonomy(store, { input: { allowedProductKinds: ['DIGITAL_ITEM'] } });
  const r = propose(store, { productId: f.productId });
  check('B5 ★ 商品不在自主白名单 → DENY，Intent 终结，且**不创建可执行的 Purchase**',
    r.ok === true && r.mayExecute === false && r.intent.state === 'DENIED' &&
    r.intent.reasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED &&
    purchases(store) === 0 && approvals(store) === 0,
    { ok: r.ok, state: r.intent && r.intent.state, reasonCode: r.intent && r.intent.reasonCode,
      purchases: purchases(store), approvals: approvals(store) });
  check('B6 DENY 是**终态**：再推进同一条 intent 只会得到 INTENT_NOT_EXECUTABLE',
    (function () {
      const again = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('resume') });
      return again.ok === false && again.reasonCode === C.DENY_REASON.INTENT_NOT_EXECUTABLE &&
        again.terminal === true;
    })());
  store.close();
}

{
  /* B7 日额度是自主放行的最终兜底 —— 撞穿它得到 REQUIRE_APPROVAL 而不是 DENY
     ★ 载入期约束是 approvalAbove ≤ perPurchase ≤ daily，因此"一笔在单笔
     上限内、却撞穿日额度"只能由**已经花掉的钱**造成。
     ★ 而"今天已经花了多少"只统计**自主成立**的购买
     （selectAutonomousSpendRows 按 autonomy_policy_id + approval_mode 过滤），
     因此预置的那一笔必须真的是一次 AUTO_ALLOW 购买 —— 用 P22-6 的入口
     手工造的一笔不算。这正是本阶段要证明的那条链：AUTO_ALLOW → Purchase
     → 明天的额度。
     ★ 第二笔必须买**另一件商品**：同一件同 recipient 的第二次提议会落进
     §10 的重复窗口而**不**再判一次（那是另一个正确行为，见 F 组）。 */
  const store = makeStore('b7');
  const f = fixture(store, { unitPriceMinor: 5 });
  const otherProductId = store.putProduct({
    storeId: f.storeId, kind: 'COMPUTE_CREDIT', name: 'Compute x500', currency: CUR,
    unitPriceMinor: 5, grantQuantity: 500, idempotencyKey: K('product2')
  }).result.product.productId;
  autonomy(store, { input: { perPurchaseLimitMinor: 6, dailyAutonomousLimitMinor: 6, approvalAboveMinor: 6 } });

  const first = propose(store, { productId: f.productId, reason: 'the first one' });
  check('B7a 第一笔在日额度之内 → AUTO_ALLOW，并且真的花掉了 5',
    first.intent.state === 'COMPLETED' && first.authorityOutcome === 'AUTO_ALLOW' &&
    BigInt(store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.cachedBalanceMinor) === 99995n,
    { state: first.intent && first.intent.state, errors: first.errors });

  const second = propose(store, { productId: otherProductId, reason: 'a different product' });
  /* ★ 实测行为（P22-7 冻结的判据顺序）：日自主额度是一条 **DENY** 判据，
     因此撞穿它得到 DENY / AUTONOMY_LIMIT，而不是 REQUIRE_APPROVAL。
     "能问就先问"那句话描述的是**审批线**（approvalAbove），而日额度是
     **能力**线的硬底 —— 它说不，用户点头也不改变"这台 Agent 今天没有更多
     自主额度"这个事实。（契约里 AP_EVALUATION_PRIORITY 的注释把审批线写成
     排在日额度**之前**，与实现相反；那一处注释是 P22-7 的，本阶段不改它，
     而是在这里把**实测**行为钉住。） */
  check('B7b ★ 再花 5 撞穿日自主额度 → DENY / AUTONOMY_LIMIT（硬底：用户点头也改不了"今天没有更多自主额度"）',
    second.ok === true && second.mayExecute === false && second.intent.state === 'DENIED' &&
    second.authorityOutcome === 'DENY' &&
    second.intent.authorityReasonCode === C.DENY_REASON.AUTONOMY_LIMIT,
    { state: second.intent && second.intent.state, authority: second.authorityOutcome,
      reasonCode: second.intent && second.intent.authorityReasonCode });
  check('B7c ★ 撞额度的那一笔**一分钱都没花**（既没有购买，也没有残留预留或待批准记录）',
    purchases(store) === 1 && approvals(store) === 0 &&
    BigInt(store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.reservedBalanceMinor) === 0n &&
    BigInt(store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.cachedBalanceMinor) === 99995n,
    { purchases: purchases(store), approvals: approvals(store),
      reserved: String(store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.reservedBalanceMinor) });
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   C · AUTO_ALLOW 仍然必经 Budget + 原子结算
   ══════════════════════════════════════════════════════════════════════ */
section('C · §6 AUTO_ALLOW 仍然必经 P22-6（预算 + 原子结算）');

{
  const store = makeStore('c1');
  const f = fixture(store, { unitPriceMinor: 500, limits: { perTransactionMinor: 100 } });
  autonomy(store, { input: { perPurchaseLimitMinor: 100000, dailyAutonomousLimitMinor: 100000, approvalAboveMinor: 100000 } });
  const r = propose(store, { productId: f.productId });
  check('C1 ★ 权威说 AUTO_ALLOW，但**预算**说这笔钱超单笔上限 → Intent FAILED，一分钱没动',
    r.ok === false && r.intent.state === 'FAILED' &&
    r.reasonCode === C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION &&
    purchases(store) === 0,
    { state: r.intent && r.intent.state, reasonCode: r.reasonCode, purchases: purchases(store) });
  check('C2 ★ 失败之后钱包的 available 一个字节都没变（既没有扣款也没有遗留预留）',
    (function () {
      const w = store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet;
      return BigInt(w.availableBalanceMinor) === 100000n && BigInt(w.cachedBalanceMinor) === 100000n &&
        BigInt(w.reservedBalanceMinor) === 0n;
    })(), store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet);
  check('C3 那条 intent 的 change log 里写着 prepareFailed（审计读得出"它试过但没花成"）',
    (function () {
      const changes = store.listChanges(0, 200);
      const mine = changes.filter(c => c.payload && c.payload.agentIntentId === r.intentId);
      return mine.length >= 2 &&
        mine.some(c => c.kind === 'AGENT_INTENT_PROPOSED' && c.payload.ledgerMutation === false) &&
        mine.some(c => c.kind === 'AGENT_INTENT_DETERMINED' && c.payload.prepareFailed === true &&
          c.payload.ledgerMutation === false);
    })());
  store.close();
}

{
  /* C4 AUTO_ALLOW 成功时：钱真的动了、资产真的发了、账本只有一笔 */
  const store = makeStore('c4');
  const f = fixture(store, { unitPriceMinor: 400, grantQuantity: 5 });
  autonomy(store);
  const r = propose(store, { productId: f.productId });
  const purchase = store.getPurchase({ purchaseId: r.purchaseId }).purchase;
  const w = store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet;
  check('C4 ★ AUTO_ALLOW 的成功是一笔**原子结算**：扣钱 + 发资产 + 消费报价，三件事同一笔购买',
    r.intent.state === 'COMPLETED' && purchase.status === 'COMPLETED' &&
    typeof purchase.inventoryEntryId === 'string' &&
    BigInt(w.cachedBalanceMinor) === 99600n && BigInt(w.reservedBalanceMinor) === 0n,
    { state: r.intent.state, balance: w.cachedBalanceMinor, reserved: w.reservedBalanceMinor });
  const inv = store.getInventoryEntry({ inventoryEntryId: purchase.inventoryEntryId }).entry;
  check('C5 库存条目属于 Agent，数量等于商品的 grantQuantity（一份商品决定发多少，不是模型决定的）',
    inv.ownerId === 'cfg_agent' && inv.quantity === 5 && inv.assetKind === 'COMPUTE', inv);
  check('C6 ★ 报价被**恰好消费一次**（CONSUMED），于是它不可能再被用第二次',
    store.getQuote({ quoteId: r.quoteId }).quote.state === 'CONSUMED');
  check('C7 那条购买是一笔购买、一次预留、一笔账本交易 —— 三个引用各不相同且都 canonical',
    C.isEconomyId('PURCHASE_INTENT', purchase.purchaseId) &&
    C.isEconomyId('QUOTE', purchase.quoteId) &&
    new Set([purchase.purchaseId, purchase.quoteId, purchase.reservationId, purchase.ledgerTransactionId]).size === 4,
    purchase);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   D · REQUIRE_APPROVAL 停在批准，什么也不动
   ══════════════════════════════════════════════════════════════════════ */
section('D · §6 REQUIRE_APPROVAL 停在批准（0 预留 / 0 扣款 / 0 发货）');

{
  const store = makeStore('d');
  const f = fixture(store);
  const r = propose(store, { productId: f.productId });
  const w = store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet;

  check('D1 ★ 等待批准时**没有**任何购买、**没有**任何预留、钱包余额与可用额都没变',
    purchases(store) === 0 &&
    BigInt(w.cachedBalanceMinor) === 100000n && BigInt(w.availableBalanceMinor) === 100000n &&
    BigInt(w.reservedBalanceMinor) === 0n,
    { purchases: purchases(store), wallet: w });
  check('D2 ★ 那条报价仍然是 OPEN（没被消费），而且它**没有**过期',
    (function () {
      const q = store.getQuote({ quoteId: r.quoteId }).quote;
      return q.state === 'OPEN' && q.expiredByTime === false;
    })());
  check('D3 ★ 没有任何库存条目被创建',
    inventoryOf(store, 'cfg_agent') === 0);
  check('D4 那条 intent 上写着 reservedNothing 与 purchaseCreated:false（读面也这么说）',
    r.reservedNothing === true && r.purchaseCreated === false);
  check('D5 有一条 PENDING 批准，而且它是一次性的（APPROVAL_IS_SINGLE_USE）',
    (function () {
      const a = store.getApproval({ approvalId: r.approvalId }).approval;
      return a.status === 'PENDING' && a.terminal === false && C.APPROVAL_IS_SINGLE_USE === true;
    })());
  store.close();
}

{
  /* D6 未批准就 continue → 不得终结那条 intent（开发期实测踩到的真实缺陷） */
  const store = makeStore('d6');
  const f = fixture(store);
  const r = propose(store, { productId: f.productId });
  const early = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('early') });
  check('D6 ★ 用户还没决定时 continue：回答"还没有决定"，而 intent **仍然**停在 WAITING_APPROVAL',
    early.ok === false && early.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
    early.approvalStatus === 'PENDING' && early.reservedNothing === true &&
    store.getPurchaseIntent({ agentIntentId: r.intentId }).intent.state === 'WAITING_APPROVAL',
    { reasonCode: early.reasonCode, approvalStatus: early.approvalStatus,
      state: store.getPurchaseIntent({ agentIntentId: r.intentId }).intent.state });
  store.close();
}

{
  /* D7 用户拒绝 → intent DENIED，仍然什么也没动 */
  const store = makeStore('d7');
  const f = fixture(store);
  const r = propose(store, { productId: f.productId });
  const dec = store.decideApproval({
    approvalId: r.approvalId, decision: 'REJECTED',
    decidedBy: { type: 'user', id: C.USER_PARTY_ID }, idempotencyKey: K('reject')
  });
  const res = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('resume') });
  check('D7 ★ 用户拒绝 → resume 把 intent 终结成 DENIED，且**不**创建购买、**不**进执行态',
    dec.ok === true && res.ok === false && res.intent.state === 'DENIED' &&
    purchases(store) === 0 &&
    BigInt(store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.reservedBalanceMinor) === 0n,
    { state: res.intent && res.intent.state, purchases: purchases(store) });
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   E · §7 Approval 恢复路径
   ══════════════════════════════════════════════════════════════════════ */
section('E · §7 Approval 恢复路径');

{
  const store = makeStore('e1');
  const f = fixture(store);
  const r = propose(store, { productId: f.productId });
  store.decideApproval({
    approvalId: r.approvalId, decision: 'APPROVED',
    decidedBy: { type: 'user', id: C.USER_PARTY_ID }, idempotencyKey: K('approve')
  });
  const res = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('resume') });
  check('E1 ★ 批准之后同一 Intent 继续：用的是**原来那份**报价（quoteId 逐字相同）',
    res.ok === true && res.intent.state === 'COMPLETED' &&
    res.quoteId === r.quoteId && res.intent.quoteId === r.quoteId,
    { state: res.intent && res.intent.state, quoteId: res.quoteId, original: r.quoteId, errors: res.errors });
  const purchase = store.getPurchase({ purchaseId: res.purchaseId }).purchase;
  check('E2 那笔购买的 approvalMode 是 APPROVAL（**不是** AUTO_ALLOW），而且它消费的就是那张批准',
    purchase.approvalMode === 'APPROVAL' && purchase.approvalId === r.approvalId,
    { mode: purchase.approvalMode, approvalId: purchase.approvalId });
  check('E3 ★ 那张批准变成了 CONSUMED，并且指出它被哪一笔购买消费（一次性消费的结构证据）',
    (function () {
      const a = store.getApproval({ approvalId: r.approvalId }).approval;
      return a.status === 'CONSUMED' && a.consumedByPurchaseId === res.purchaseId && a.terminal === true;
    })());
  check('E4 ★ resume **不接受**任何经济字段（乱给 agentId / productId / units / amountMinor 不会改变任何东西）',
    (function () {
      const withNoise = store.resumeAgentPurchaseIntent({
        agentIntentId: r.intentId, idempotencyKey: K('noise'),
        productId: 'econ_product_other', units: 99, amountMinor: 1, agentId: 'cfg_other'
      });
      /* ★ 它返回的是**重放**（那条 intent 已经完成），而关键证据是：那些
         乱给的字段一个都没有被采纳 —— 买了多少、买了什么仍然是原来的。 */
      const row = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
      return withNoise.ok === true && withNoise.replayed === true &&
        withNoise.alreadyCompleted === true &&
        row.productId === f.productId && row.units === 1 &&
        purchases(store) === 1;
    })(), { purchases: purchases(store) });
  check('E5 ★ 重复 resume 不得第二次购买（重放返回同一个结局，而不是再买一次）',
    (function () {
      const again = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('again') });
      return again.ok === true && again.replayed === true && again.purchaseCreated === false &&
        again.purchaseId === res.purchaseId &&
        purchases(store) === 1 &&
        BigInt(store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.cachedBalanceMinor) === 99990n;
    })(), { purchases: purchases(store) });
  check('E5b ★ 一条 COMPLETED 的 intent 不能被"复活"成别的状态（再 resume 一次仍然 COMPLETED）',
    (function () {
      store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('again2') });
      return store.getPurchaseIntent({ agentIntentId: r.intentId }).intent.state === 'COMPLETED' &&
        intentStates(store).COMPLETED === 1;
    })());
  check('E6 ★ 同一条 intent 不得再产生第二笔购买（UNIQUE(purchase_id) + 状态闸门）',
    purchases(store) === 1 &&
    (function () {
      const row = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
      return row.purchaseId === res.purchaseId;
    })());
  store.close();
}

{
  /* E7 §7：批准**不得**复活已经过期的报价 */
  const store = makeStore('e7');
  const f = fixture(store);
  /* 先建一条 intent，拿到它的报价，然后手工把报价推到过期（模拟"放着不管"。 */
  const r = propose(store, { productId: f.productId, proposal: { expiresAt: Date.now() + 1200 } });
  store.decideApproval({
    approvalId: r.approvalId, decision: 'APPROVED',
    decidedBy: { type: 'user', id: C.USER_PARTY_ID }, idempotencyKey: K('approve')
  });
  /* 等到 intent / 报价的有效期过去。 */
  const waitMs = Math.max(0, Number(r.intent.expiresAt) - Date.now() + 60);
  const until = Date.now() + waitMs;
  while (Date.now() < until) { /* 忙等：这是**真实**时间，不是被注入的时钟 */ }
  const res = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('late') });
  check('E7 ★ 报价过期之后即使有 APPROVED 批准：**不**执行、**不**购买，intent 走到 EXPIRED',
    res.ok === false && res.intent.state === 'EXPIRED' &&
    res.reasonCode === C.DENY_REASON.INTENT_EXPIRED &&
    purchases(store) === 0,
    { state: res.intent && res.intent.state, reasonCode: res.reasonCode, purchases: purchases(store) });
  check('E8 ★ 那条批准仍然存在且**没有被消费**（"没执行"与"批准被用掉了"是两句话）',
    (function () {
      const a = store.getApproval({ approvalId: r.approvalId }).approval;
      return a.status === 'APPROVED' && a.consumedByPurchaseId === null;
    })());
  check('E9 ★ 过期之后不得复活：再 resume 一次仍然是 EXPIRED，而且仍然 0 购买',
    (function () {
      const again = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('late2') });
      return again.ok === false && again.terminal === true &&
        purchases(store) === 0 &&
        store.getPurchaseIntent({ agentIntentId: r.intentId }).intent.state === 'EXPIRED';
    })());
  store.close();
}

{
  /* E10 批准被**另一笔**购买消费 → 这条 intent 不得再执行 */
  const store = makeStore('e10');
  const f = fixture(store);
  const r = propose(store, { productId: f.productId });
  store.decideApproval({
    approvalId: r.approvalId, decision: 'APPROVED',
    decidedBy: { type: 'user', id: C.USER_PARTY_ID }, idempotencyKey: K('approve')
  });
  /* 手工拿那张批准去 prepare + settle（模拟"另一个进程已经用掉了它"）。 */
  const prepared = store.preparePurchase({
    quoteId: r.quoteId, buyerId: 'cfg_agent', units: 1,
    approvalId: r.approvalId, expiresAt: r.intent.expiresAt, idempotencyKey: K('manual-prepare')
  });
  const settled = prepared.ok === true ? store.settlePurchase({
    purchaseId: prepared.result.purchaseId, idempotencyKey: K('manual-settle')
  }) : prepared;
  const res = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('resume') });
  check('E10 ★ 批准已被另一笔购买消费 → resume 得到 APPROVAL_NOT_CONSUMED（DENY），不得再买一次',
    settled.ok === true && res.ok === false &&
    res.reasonCode === C.DENY_REASON.APPROVAL_NOT_CONSUMED && res.intent.state === 'DENIED' &&
    purchases(store) === 1,
    { reasonCode: res.reasonCode, state: res.intent && res.intent.state, purchases: purchases(store) });
  check('E11 那条批准指向的是**另一笔**购买（不是这条 intent 的）',
    store.getApproval({ approvalId: r.approvalId }).approval.consumedByPurchaseId === prepared.result.purchaseId);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   F · §10 重复模型输出
   ══════════════════════════════════════════════════════════════════════ */
section('F · §10 重复模型输出不得导致重复购买');

{
  const store = makeStore('f1');
  const f = fixture(store);
  autonomy(store);
  let first = null;
  let suppressed = 0;
  let created = 0;
  for (let i = 0; i < 20; i++) {
    /* 每一次都是**不同的 key**、**不同的理由**（模拟模型复读二十次）。 */
    const r = store.proposeAgentPurchaseIntent({
      idempotencyKey: K('dup'),
      proposal: {
        agentId: 'cfg_agent', productId: f.productId,
        reason: 'I really need compute, attempt #' + i + ' — it is cheap and the user agrees'
      }
    });
    if (i === 0) first = r;
    if (r.suppressed) suppressed++; else created++;
  }
  const counts = intentStates(store);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  check('F1 ★ 同一个模型输出 ×20 → 恰好一条 canonical Intent',
    total === 1 && created === 1 && suppressed === 19,
    { total: total, created: created, suppressed: suppressed });
  check('F2 ★ 恰好一笔购买（不是二十笔）',
    purchases(store) === 1, { purchases: purchases(store) });
  check('F3 ★ 恰好一次资金动作：余额只少了一次的钱',
    BigInt(store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.cachedBalanceMinor) === 99990n,
    store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.cachedBalanceMinor);
  check('F4 ★ 被抑制的那十九次返回的是**已经存在**的那一条（不是一条新的，也不是一句错误）',
    suppressed === 19 && first.ok === true);
  check('F5 ★ 抑制是一个**具名**事实（DUPLICATE_INTENT_WINDOW），而且它自述"我不是预算"',
    (function () {
      const r = store.proposeAgentPurchaseIntent({
        idempotencyKey: K('dup2'), proposal: { agentId: 'cfg_agent', productId: f.productId, reason: 'again' }
      });
      return r.suppressed === true && r.suppressReason === 'DUPLICATE_INTENT_WINDOW' &&
        r.dedupeIsNotABudget === true && r.dedupeWindowMs === C.PURCHASE_INTENT_DEDUPE_WINDOW_MS &&
        r.intentId === first.intentId;
    })());
  check('F6 ★ 不同 recipient 是**另一件**打算（指纹含 recipient，因此不被抑制）',
    (function () {
      const before = purchases(store);
      store.openWallet({ owner: { type: 'character', id: 'cfg_friend' }, currency: CUR });
      /* ★ 礼物必须用一件**可送**的商品：COMPUTE_GRANT 的结算形态在 §14 就
         冻结成"额度被授予"，它没有"送给谁"这个位置（P22-5 的
         productQuoteKindFor 因此会拒绝带 recipient 的 compute 报价）。
         这不是本阶段的限制，而是 P22-5 冻结的规则 —— 这里照它构造夹具。 */
      const giftProductId = store.putProduct({
        storeId: f.storeId, kind: 'DIGITAL_ITEM', name: 'Badge', currency: CUR,
        unitPriceMinor: 3, grantQuantity: 1, idempotencyKey: K('gift-product')
      }).result.product.productId;
      const gift = store.proposeAgentPurchaseIntent({
        idempotencyKey: K('gift'),
        proposal: { agentId: 'cfg_agent', productId: giftProductId, recipientId: 'cfg_friend', reason: 'a gift' }
      });
      /* ★ allowGift=false 时 P22-7 给的是 **DENY / AUTONOMY_NOT_PERMITTED**
         （"送礼不在自主范围内"），而不是 REQUIRE_APPROVAL —— 这正是本组
         要证明的那句话：Decision Bridge **不得**自己根据"这是一份礼物"
         升级权限，它只能把 gift 这个事实交给 P22-7，然后照它的结论走。 */
      return gift.suppressed !== true && gift.ok === true &&
        gift.intent.selfDirected === false && gift.intent.recipientId === 'cfg_friend' &&
        gift.intent.state === 'DENIED' &&
        gift.authorityOutcome === 'DENY' &&
        gift.intent.authorityReasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED &&
        purchases(store) === before;
    })(), { purchases: purchases(store) });
  store.close();
}

{
  /* F7 DENIED / EXPIRED / FAILED **不**抑制（"上一次没成"必须允许再试） */
  const store = makeStore('f7');
  const f = fixture(store);
  autonomy(store, { input: { allowedProductKinds: ['DIGITAL_ITEM'] } });
  const r1 = propose(store, { productId: f.productId });
  const r2 = propose(store, { productId: f.productId });
  check('F8 ★ DENIED 不抑制：第二条同指纹的提议仍然是一次**真实的**尝试（又是一条 DENIED，而不是"返回上一条"）',
    r1.intent.state === 'DENIED' && r2.suppressed !== true && r2.intent.state === 'DENIED' &&
    r2.intentId !== r1.intentId,
    { first: r1.intentId, second: r2.intentId, secondSuppressed: r2.suppressed });
  check('F9 两次尝试都 0 购买（DENY 不产生可执行的 Purchase）',
    purchases(store) === 0);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   G · §11 幂等
   ══════════════════════════════════════════════════════════════════════ */
section('G · §11 幂等（same key + same intent → 同一条；不同的东西 → 冲突）');

{
  const store = makeStore('g');
  const f = fixture(store);
  const other = store.putProduct({
    storeId: f.storeId, kind: 'DIGITAL_ITEM', name: 'Widget', currency: CUR,
    unitPriceMinor: 5, grantQuantity: 1, idempotencyKey: K('product2')
  }).result.product.productId;
  const key = K('same');

  const a = store.proposeAgentPurchaseIntent({ idempotencyKey: key, proposal: { agentId: 'cfg_agent', productId: f.productId, reason: 'x' } });
  const b = store.proposeAgentPurchaseIntent({ idempotencyKey: key, proposal: { agentId: 'cfg_agent', productId: f.productId, reason: 'a different reason' } });
  check('G1 ★ same key + same intent → **同一条** Intent（理由变了不算换了意图）',
    a.ok === true && b.ok === true && a.intentId === b.intentId && b.replayed === true,
    { a: a.intentId, b: b.intentId, replayed: b.replayed });

  const c = store.proposeAgentPurchaseIntent({ idempotencyKey: key, proposal: { agentId: 'cfg_agent', productId: other, reason: 'x' } });
  check('G2 ★ same key + different product → IDEMPOTENCY_CONFLICT（DUPLICATE_REQUEST），而且报出两个指纹',
    c.ok === false && c.reasonCode === C.DENY_REASON.DUPLICATE_REQUEST &&
    typeof c.storedFingerprint === 'string' && typeof c.presentedFingerprint === 'string' &&
    c.storedFingerprint !== c.presentedFingerprint,
    { reasonCode: c.reasonCode, stored: c.storedFingerprint, presented: c.presentedFingerprint });

  const d = store.proposeAgentPurchaseIntent({ idempotencyKey: key, proposal: { agentId: 'cfg_agent', productId: f.productId, recipientId: 'cfg_other', reason: 'x' } });
  check('G3 ★ same key + different recipient → 同样是冲突（不是"那个 recipient 的意图"）',
    d.ok === false && d.reasonCode === C.DENY_REASON.DUPLICATE_REQUEST);

  check('G4 ★ 一次冲突不产生任何新的 Intent / Approval / Purchase',
    intentStates(store).WAITING_APPROVAL === 1 &&
    purchases(store) === 0);

  /* 跨重启：关掉、重新打开同一个目录、同一个 key 重放。 */
  const dir = store.dir || null;
  const beforeIntents = store.getPurchaseIntent({ agentIntentId: a.intentId }).intent;
  const reopenDir = store.dataDirForTest();
  store.close();
  check('G5 重开同一个库之后那条 intent 逐字仍在（跨重启的 canonical 事实）',
    (function () {
      /* 用同一个 dataDir 重新装配一个 store。 */
      const reopened = createEconomyStore({ dataDir: reopenDir, logger: () => {}, nextId: deterministicIds() });
      reopened.open();
      const again = reopened.getPurchaseIntent({ agentIntentId: a.intentId });
      const ok = again.ok === true && again.intent.state === beforeIntents.state &&
        again.intent.state === 'WAITING_APPROVAL' &&
        intents(reopened) === 1;
      reopened.close();
      return ok;
    })(), { dir: reopenDir });
  check('G6 ★ 幂等的身份跨重启仍然成立：同一个 key 在重开之后仍然指向那条 canonical intent',
    (function () {
      const reopened = createEconomyStore({ dataDir: reopenDir, logger: () => {}, nextId: deterministicIds() });
      reopened.open();
      const again = reopened.proposeAgentPurchaseIntent({
        idempotencyKey: key,
        proposal: { agentId: 'cfg_agent', productId: f.productId, reason: 'after restart' }
      });
      const ok = again.ok === true && again.intentId === a.intentId &&
        intents(reopened) === 1;
      reopened.close();
      return ok;
    })());
}

/* ══════════════════════════════════════════════════════════════════════
   H · §4 Agent 不得提供经济事实
   ══════════════════════════════════════════════════════════════════════ */
section('H · §4 Agent 不得提供经济事实');

{
  const store = makeStore('h');
  const f = fixture(store);
  const before = intentStates(store);

  const injections = [
    ['amountMinor', { amountMinor: 1 }],
    ['amount', { amount: 1 }],
    ['price', { price: 1 }],
    ['currency', { currency: 'IB_CREDIT' }],
    ['discount', { discount: 9 }],
    ['grantQuantity', { grantQuantity: 999999 }],
    ['settlementType', { settlementType: 'COMPUTE_GRANT' }],
    ['walletBalance', { walletBalance: 999999999 }],
    ['budgetResult', { budgetResult: 'ALLOW' }],
    ['autoAllow', { autoAllow: true }],
    ['approved', { approved: true }],
    ['isApproved', { isApproved: true }],
    ['approvalId', { approvalId: 'econ_approval_x' }],
    ['autonomyOutcome', { autonomyOutcome: 'AUTO_ALLOW' }],
    ['autonomyPolicyId', { autonomyPolicyId: 'econ_policy_x' }],
    ['quoteId', { quoteId: 'econ_quote_x' }],
    ['purchaseId', { purchaseId: 'econ_intent_x' }],
    ['snake_case 变体', { amount_minor: 1 }],
    ['CamelCase 变体', { AmountMinor: 1 }],
    ['kebab 变体', { 'grant-quantity': 1 }]
  ];
  const results = injections.map(function (entry) {
    const r = store.proposeAgentPurchaseIntent({
      idempotencyKey: K('inject'),
      proposal: Object.assign({ agentId: 'cfg_agent', productId: f.productId, reason: 'buy it' }, entry[1])
    });
    return { label: entry[0], r: r };
  });

  check('H1 ★ 二十种注入全部被拒绝，理由全是 MODEL_SUPPLIED_ECONOMIC_FACT',
    results.every(x => x.r.ok === false && x.r.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT),
    results.filter(x => !(x.r.ok === false && x.r.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT))
      .map(x => x.label + ':' + x.r.reasonCode + ':' + J(x.r.errors)));

  check('H2 ★ 每一次拒绝都**不写任何东西**（没有 intent、没有报价、没有批准、没有购买）',
    J(intentStates(store)) === J(before) &&
    quotes(store) === 0 && approvals(store) === 0 &&
    purchases(store) === 0,
    { states: intentStates(store), quotes: quotes(store) });

  check('H3 ★ 拒绝里点名"你递了哪些字段"，而且它们必须从 canonical facts 重新派生',
    (function () {
      const r = store.proposeAgentPurchaseIntent({
        idempotencyKey: K('named'),
        proposal: { agentId: 'cfg_agent', productId: f.productId, price: 1, approved: true, discount: 5 }
      });
      return J(r.suppliedEconomicFacts) === J(['approved', 'discount', 'price']) &&
        r.rejectedFieldsAreDerivedFromCanonicalFacts === true &&
        r.proposedNothing === true &&
        J(r.acceptedProposalKeys) === J(C.PURCHASE_INTENT_PROPOSAL_KEYS);
    })());

  check('H4 ★ §4 点名的那个形状（{productId, price, approved}）在**结构上**不成立',
    (function () {
      const r = store.proposeAgentPurchaseIntent({
        idempotencyKey: K('classic'),
        proposal: { productId: f.productId, price: 100, approved: true }
      });
      /* 它连"agentId 缺失"都不重要 —— 第一个被回答的是"你的手伸进了经济事实里"。 */
      return r.ok === false && r.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT;
    })());

  check('H5 未知键被拒绝而不是静默忽略，而且这**不是**经济事实违规（两种拒绝必须可分）',
    (function () {
      const r = store.proposeAgentPurchaseIntent({
        idempotencyKey: K('unknown'),
        proposal: { agentId: 'cfg_agent', productId: f.productId, mood: 'generous' }
      });
      return r.ok === false && r.reasonCode === null && r.proposedNothing === true &&
        J(r.unknownKeys) === J(['mood']);
    })());

  check('H6 ★ propose 的**入参**里只有 idempotencyKey 与 proposal 两项，而 proposal 只有六个键',
    (function () {
      /* 结构性证据：一条提议把 units 加进去仍然合法（它是选择），
         而把 grantQuantity 加进去被拒绝（它是事实）—— 两者在同一个
         调用里被区分开，说明白名单是精确的而不是"看起来像金额就挡"。 */
      const okUnits = store.proposeAgentPurchaseIntent({
        idempotencyKey: K('units-ok'),
        proposal: { agentId: 'cfg_agent', productId: f.productId, units: 3, reason: 'three' }
      });
      const badGrant = store.proposeAgentPurchaseIntent({
        idempotencyKey: K('grant-bad'),
        proposal: { agentId: 'cfg_agent', productId: f.productId, grantQuantity: 3 }
      });
      return okUnits.ok === true && okUnits.intent.units === 3 &&
        badGrant.ok === false && badGrant.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   I · §12 Gift 与 §13 Compute quota
   ══════════════════════════════════════════════════════════════════════ */
section('I · §12 Gift 与 §13 Compute / API quota');

{
  const store = makeStore('i1');
  const f = fixture(store, { withFriend: true });
  /* ★ 礼物必须用一件**可送**的商品：COMPUTE_GRANT 的结算形态在 §14 就冻结
     成"额度被授予"，它没有"送给谁"这个位置（P22-5 的 productQuoteKindFor
     会拒绝带 recipient 的 compute 报价）。这不是本阶段的限制。 */
  const giftProductId = store.putProduct({
    storeId: f.storeId, kind: 'DIGITAL_ITEM', name: 'Badge', currency: CUR,
    unitPriceMinor: 3, grantQuantity: 1, idempotencyKey: K('gift-product')
  }).result.product.productId;
  /* ★ 必须**有**一条自主策略，"allowGift=false 被 P22-7 执行"才是一句
     可证伪的话：没有策略时 P22-7 的 fail closed 是 REQUIRE_APPROVAL，那
     时候"礼物被拒绝"这个结论根本轮不到 gift 规则来说。 */
  autonomy(store, {
    input: {
      allowedProductKinds: ['COMPUTE_CREDIT', 'DIGITAL_ITEM'],
      allowedSettlementTypes: ['COMPUTE_GRANT', 'INVENTORY_GRANT'],
      allowGift: false
    }
  });
  const gift = store.proposeAgentPurchaseIntent({
    idempotencyKey: K('gift'),
    proposal: { agentId: 'cfg_agent', productId: giftProductId, recipientId: 'cfg_friend', reason: 'a gift for a friend' }
  });
  check('I1 ★ Agent 可以提出"A 给 B 买 X"，但 allowGift=false 时它**必须**由 P22-7 判成 DENY / AUTONOMY_NOT_PERMITTED',
    gift.ok === true && gift.intent.state === 'DENIED' &&
    gift.intent.selfDirected === false && gift.intent.recipientId === 'cfg_friend' &&
    gift.authorityOutcome === 'DENY' &&
    gift.intent.authorityReasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED,
    { state: gift.intent && gift.intent.state, authority: gift.authorityOutcome,
      reasonCode: gift.intent && gift.intent.authorityReasonCode,
      verdict: gift.verdict && { outcome: gift.verdict.outcome, rc: gift.verdict.reasonCode,
        priority: gift.verdict.priority },
      selfDirected: gift.intent && gift.intent.selfDirected,
      recipientId: gift.intent && gift.intent.recipientId,
      errors: gift.errors });
  check('I1b ★ allowGift=true 时才轮到审批线（gift 能自主了，但金额越过审批阈值 → REQUIRE_APPROVAL）',
    (function () {
      const store2 = makeStore('i1b');
      const f2 = fixture(store2, { withFriend: true });
      const giftProductId = store2.putProduct({
        storeId: f2.storeId, kind: 'DIGITAL_ITEM', name: 'Badge', currency: CUR,
        unitPriceMinor: 3, grantQuantity: 1, idempotencyKey: K('gift-product')
      }).result.product.productId;
      autonomy(store2, {
        input: {
          allowedProductKinds: ['DIGITAL_ITEM'], allowedSettlementTypes: ['INVENTORY_GRANT'],
          allowGift: true, perPurchaseLimitMinor: 100, dailyAutonomousLimitMinor: 100, approvalAboveMinor: 1
        }
      });
      const g = store2.proposeAgentPurchaseIntent({
        idempotencyKey: K('gift2'),
        proposal: { agentId: 'cfg_agent', productId: giftProductId, recipientId: 'cfg_friend', reason: 'a gift' }
      });
      const ok = g.intent.state === 'WAITING_APPROVAL' && g.authorityOutcome === 'REQUIRE_APPROVAL' &&
        g.intent.authorityReasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
        purchases(store2) === 0;
      store2.close();
      return ok;
    })());
  check('I2 ★ 礼物路径同样 0 预留 / 0 扣款 / 0 发货',
    purchases(store) === 0 &&
    BigInt(store.getWallet({ ownerId: 'cfg_agent', currency: CUR }).wallet.reservedBalanceMinor) === 0n &&
    inventoryOf(store, 'cfg_friend') === 0);
  check('I3 ★ Decision Bridge 不得根据 trust / affection / relationship 升级权限（那些词不在任何白名单里）',
    (function () {
      const before = intents(store);
      const r = store.proposeAgentPurchaseIntent({
        idempotencyKey: K('trust'),
        proposal: { agentId: 'cfg_agent', productId: f.productId, recipientId: 'cfg_friend', trust: 1, affection: 1, relationshipId: 'r1' }
      });
      /* trust 等词**不是**经济事实（它们不在那份名单里），因此它们是"未知键" ——
         拒绝的方式不同，但结论一样：它们无法影响任何判定。
         ★ 而且这条提议**一件东西都没写**：一条 intent 都没有多出来。 */
      return r.ok === false && r.proposedNothing === true &&
        r.suppliedEconomicFacts.length === 0 &&
        J(r.unknownKeys) === J(['affection', 'relationshipId', 'trust']) &&
        intents(store) === before;
    })(), { intents: intents(store) });
  store.close();
}

{
  const store = makeStore('i2');
  const f = fixture(store, { kind: 'API_QUOTA', unitPriceMinor: 200, grantQuantity: 500, name: 'API quota x500' });
  autonomy(store, { input: { allowedProductKinds: ['API_QUOTA'], allowedSettlementTypes: ['COMPUTE_GRANT'] } });
  const r = propose(store, {
    productId: f.productId,
    reason: 'my computeUnit is running out — I want Premium Compute x1000'
  });
  const purchase = r.purchaseId ? store.getPurchase({ purchaseId: r.purchaseId }).purchase : null;
  check('I4 ★ Agent 可以提出"我的额度快不够了，想买 quota" —— 它形成的只是一条 Purchase Intent，之后完整经过权威与购买',
    r.ok === true && r.intent.state === 'COMPLETED' && r.authorityOutcome === 'AUTO_ALLOW' &&
    purchase.status === 'COMPLETED',
    { state: r.intent && r.intent.state, errors: r.errors });
  check('I5 ★ 成功之后增加的**只是** InternalBeyond 内部 entitlement（库存条目），一个 Provider 侧的东西都没动',
    (function () {
      const inv = store.getInventoryEntry({ inventoryEntryId: purchase.inventoryEntryId }).entry;
      return inv.assetKind === 'COMPUTE' && inv.ownerId === 'cfg_agent' &&
        purchase.settlementType === 'COMPUTE_GRANT';
    })());
  check('I6 ★ 0 Provider top-up / 0 Provider credential / 0 网络 / 0 真实支付（四条自述 + 整条购买链上没有任何一条写下 provider/payment 变更）',
    (function () {
      const changes = store.listChanges(0, 400)
        .filter(c => c.payload && c.payload.purchaseId === r.purchaseId);
      return C.PURCHASE_TOUCHES_PROVIDER === false && C.PURCHASE_TOUCHES_PAYMENT === false &&
        C.PURCHASE_INTENT_TOUCHES_PROVIDER === false && C.PURCHASE_INTENT_TOUCHES_PAYMENT === false &&
        changes.length > 0 &&
        /* ★ 判据是"**没有一条**写下 true"，而不是"每一条都写着 false"：
           P22-6 那四条较早的事件根本没有这两个字段（它们先于这两个词），
           而把"字段不存在"读成"违反"是一个假阳性。一条写着 `false` 的
           事件与一条早于这个词表的事件，在"有没有动 provider"上是同一个
           答案。 */
        changes.every(c => c.payload.providerMutation !== true && c.payload.paymentMutation !== true) &&
        changes.some(c => c.payload.providerMutation === false);
    })());
  check('I7 ★ 那条 intent 自己的 change log 也一句 provider / payment 都没有（只有结算那一条才写 ledgerMutation）',
    (function () {
      const changes = store.listChanges(0, 400)
        .filter(c => c.payload && c.payload.agentIntentId === r.intentId);
      return changes.length >= 2 &&
        changes.every(c => c.payload.providerMutation === false &&
          c.payload.paymentMutation === false &&
          c.payload.memoryMutation === false &&
          c.payload.relationshipMutation === false) &&
        /* 提出那一条**一定**不动钱；终结那一条只有在真的买成时才写 true。 */
        changes.filter(c => c.kind === 'AGENT_INTENT_PROPOSED')
          .every(c => c.payload.ledgerMutation === false);
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   J · §14 边界隔离
   ══════════════════════════════════════════════════════════════════════ */
section('J · §14 边界隔离（窄接口，没有通用执行器）');

{
  const store = makeStore('j');
  const f = fixture(store);

  check('J1 ★ 公开面上**不存在**通用经济动作执行器（executeEconomyAction / runAction / buyNow / approveForAgent …）',
    ['executeEconomyAction', 'executeAction', 'runAction', 'runEconomyAction', 'performAction',
      'buyNow', 'purchase', 'approveForAgent', 'settleForAgent', 'grantForAgent', 'applyModelAction']
      .every(k => typeof store[k] === 'undefined'));

  check('J2 ★ 存在的是三个动词加三个读面，而它们的名字里写着边界',
    ['proposeAgentPurchaseIntent', 'resumeAgentPurchaseIntent',
      'getPurchaseIntent', 'listPurchaseIntents', 'serializePurchaseIntent', 'countPurchaseIntentStates']
      .every(k => typeof store[k] === 'function'));

  check('J3 ★ propose 的入参形状是 {idempotencyKey, proposal}，而 resume 只接受 intentId / approvalId / key',
    (function () {
      /* 结构性证据：resume 传了 agentId / productId / units / amountMinor 也
         不接受它们（见 E4）；而 propose 根本没有地方放金额（见 H 组）。 */
      const a = store.proposeAgentPurchaseIntent({ idempotencyKey: K('j'), proposal: { agentId: 'cfg_agent', productId: f.productId } });
      const b = store.resumeAgentPurchaseIntent({ agentIntentId: a.intentId, idempotencyKey: K('j2') });
      /* resume 返回的是**同一条** intent（无论它当时是等待批准还是已完成），
         而它带回来的 id 一定等于传进去的那一个 —— 它没有能力发明另一条。 */
      return a.ok === true && b.intentId === a.intentId &&
        purchases(store) === 0;
    })(), { purchases: purchases(store) });

  check('J4 ★ 生产代码里没有"模型输出 → settle/reserve/grant"这条路径（模型能到达的只有 propose）',
    (function () {
      /* 结构性证据：
         ① proposeAgentPurchaseIntent 的**函数体**里没有一句直接调用
            settlePurchase / preparePurchase / grantInventory —— 那些调用只
            出现在它调用 executeIntent 之后的那一层；
         ② 三个经济写入口的**调用实参**里没有任何模型输出类的键名。
        ★ 这里刻意**不**断言"整份文件里不出现 modelOutput 这个词" ——
        那些词在注释里（"prompt / persona / llmOutput 在这里无处可放"）本来
        就该出现，而把一句解释判成一条路径是一个假阳性。判据必须是
        "它们能不能成为一次经济写入的**实参**"。 */
      const body = STORE_SOURCE.slice(
        STORE_SOURCE.indexOf('function proposeAgentPurchaseIntent(input)'),
        STORE_SOURCE.indexOf('function resumeAgentPurchaseIntent(input)')
      );
      const writerCalls = STORE_SOURCE.match(
        /(?:settlePurchase|preparePurchase|grantInventory|reserveFunds)\(\s*[A-Za-z_$][\w$]*\s*\)/g
      ) || [];
      /* 每一次调用都必须是**一个具名局部变量**（例如 prepareInput），而不是
         一个属性访问链（例如 modelOutput.amount）—— 后者才是"模型输出直接
         进了经济写入"的形状。 */
      const suspicious = (STORE_SOURCE.match(
        /(?:settlePurchase|preparePurchase|grantInventory)\(\s*(?:modelOutput|llmOutput|toolCall|actionPayload)[.\w$]*/g
      ) || []);
      return body.length > 1000 &&
        body.indexOf('settlePurchase(') < 0 &&
        body.indexOf('preparePurchase(') < 0 &&
        body.indexOf('grantInventory(') < 0 &&
        body.indexOf('executeIntent(') >= 0 &&
        writerCalls.length >= 1 &&
        suspicious.length === 0;
    })());

  check('J5 ★ resume 与 propose 都**不**触碰 Memory / Relationship（四条自述字段都是 false）',
    C.PURCHASE_INTENT_TOUCHES_MEMORY === false && C.PURCHASE_INTENT_TOUCHES_RELATIONSHIP === false &&
    C.PURCHASE_TOUCHES_MEMORY === false && C.PURCHASE_TOUCHES_RELATIONSHIP === false);

  check('J6 ★ §14 那条禁令在契约里是**存在**的而不是注释：没有任何导出名叫 executeEconomyAction',
    Object.keys(C).indexOf('executeEconomyAction') < 0 &&
    Object.keys(C).indexOf('runAction') < 0);

  check('J7 每条 intent 的裁决都经过 P22-7：propose 的返回里带着 authorityOutcome，而它一定来自 AP_DECISIONS',
    (function () {
      const r = store.proposeAgentPurchaseIntent({ idempotencyKey: K('gate'), proposal: { agentId: 'cfg_agent', productId: f.productId } });
      return C.AP_DECISIONS.indexOf(String(r.intent.authorityOutcome)) >= 0 &&
        r.intent.authorityOutcome !== null;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   K · §17 可解释性
   ══════════════════════════════════════════════════════════════════════ */
section('K · §17 仅凭 canonical facts 回答六个问题');

{
  const store = makeStore('k');
  const f = fixture(store);
  /* 一条走 REQUIRE_APPROVAL 的（能同时看到"为什么没直接买"和"最后买了多少"）。 */
  const r = propose(store, { productId: f.productId, reason: 'I want to be ready for the next task' });
  store.decideApproval({
    approvalId: r.approvalId, decision: 'APPROVED',
    decidedBy: { type: 'user', id: C.USER_PARTY_ID }, idempotencyKey: K('approve')
  });
  const res = store.resumeAgentPurchaseIntent({ agentIntentId: r.intentId, idempotencyKey: K('resume') });
  const chain = store.getPurchaseIntent({ agentIntentId: r.intentId, withChain: true }).chain;

  check('K1 ★ 为什么出现这笔购买 → Agent Purchase Intent（链路的第一段就是 intentId）',
    chain.agentIntentId === r.intentId && chain.whyThisPurchaseExists.agentIntentId === r.intentId);
  check('K2 ★ Agent 当时想买什么 → Intent（productId / recipientId / units / reason 全在）',
    chain.whatTheAgentWanted.productId === f.productId &&
    chain.whatTheAgentWanted.recipientId === null &&
    chain.whatTheAgentWanted.units === 1 &&
    chain.whatTheAgentWanted.reason === 'I want to be ready for the next task');
  check('K3 ★ 为什么没直接买 → Autonomy REQUIRE_APPROVAL（带 reasonCode）',
    chain.whyItDidNotBuyDirectly !== null &&
    chain.whyItDidNotBuyDirectly.authorityOutcome === 'REQUIRE_APPROVAL' &&
    chain.whyItDidNotBuyDirectly.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED);
  check('K4 为什么直接买了 → 这条不是直接买的，因此 whyItBoughtDirectly 必须是 null（两个字段互斥）',
    chain.whyItBoughtDirectly === null);
  check('K5 ★ 最终买了多少钱 → Quote / Purchase / Ledger（而不是 intent）',
    chain.quote.amountMinor === '10' && chain.quote.state === 'CONSUMED' &&
    chain.purchase.status === 'COMPLETED' && chain.purchase.amountMinor === '10' &&
    C.isEconomyId('TRANSACTION', chain.purchase.ledgerTransactionId));
  check('K6 ★ Agent 的理由是什么 → Intent.reason，而它旁边写着 reasonIsAuthority:false',
    chain.whatTheAgentWanted.reason === 'I want to be ready for the next task' &&
    chain.whatTheAgentWanted.reasonIsAuthority === false);
  check('K7 ★ reason ≠ authority 在这个系统里是**可断言**的（十条自述字段）',
    C.PURCHASE_INTENT_REASON_IS_AUTHORITY === false &&
    C.PURCHASE_INTENT_REASON_PARTICIPATES_IN_DECISIONS === false &&
    store.getPurchaseIntent({ agentIntentId: r.intentId }).intent.reasonIsAuthority === false);
  check('K8 ★ 只有 AUTO_ALLOW 的那一条才有 whyItBoughtDirectly（两个字段互斥得干净）',
    (function () {
      const store2 = makeStore('k8');
      const f2 = fixture(store2);
      autonomy(store2);
      const auto = propose(store2, { productId: f2.productId });
      const chain2 = store2.getPurchaseIntent({ agentIntentId: auto.intentId, withChain: true }).chain;
      const ok = chain2.whyItBoughtDirectly !== null &&
        chain2.whyItBoughtDirectly.authorityOutcome === 'AUTO_ALLOW' &&
        chain2.whyItBoughtDirectly.budgetWasStillRequired === true &&
        chain2.whyItDidNotBuyDirectly === null;
      store2.close();
      return ok;
    })());
  check('K9 ★ Agent 的 reasoning**没有**被写进 Memory（intent 的读面里没有 memoryRef / memoryId 之类的字段）',
    (function () {
      const keys = Object.keys(store.getPurchaseIntent({ agentIntentId: r.intentId }).intent);
      return keys.every(k => !/memory|relationship|affection|trust/i.test(k));
    })());
  check('K10 ★ 读面自述：intent 是编排事实而不是经济事实，而且这两句都在**白名单**上',
    (function () {
      const row = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
      return C.PURCHASE_INTENT_SUMMARY_KEYS.indexOf('stateIsAnOrchestrationFact') >= 0 &&
        C.PURCHASE_INTENT_SUMMARY_KEYS.indexOf('stateIsNotAnEconomicFact') >= 0 &&
        C.PURCHASE_INTENT_SUMMARY_KEYS.indexOf('mayExecute') < 0 &&
        row.stateIsAnOrchestrationFact === true &&
        row.stateIsNotAnEconomicFact === true &&
        row.reasonIsAuthority === false && row.reasonIsTelemetry === true &&
        row.reasonParticipatesInDecisions === false;
    })());
  check('K11 ★ 读面上**没有**任何经济值字段（金额 / 币种 / 价格 / 结算形态都不在这条记录上）',
    (function () {
      const row = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
      return Object.keys(row).every(k => !/^(amount|currency|price|grantQuantity|settlementType|assetKind|balance)/.test(k));
    })(), Object.keys(store.getPurchaseIntent({ agentIntentId: r.intentId }).intent));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════════
   L · 数据库层面的边界
   ══════════════════════════════════════════════════════════════════════ */
section('L · 表结构的边界（"没有地方可以读价格"）');

{
  const store = makeStore('l');
  const f = fixture(store);
  propose(store, { productId: f.productId });

  check('L1 ★ economy_purchase_intents 里**没有**任何经济值列（amount / currency / price / grant_quantity / settlement_type / reservation / transaction）',
    (function () {
      const cols = store.tableColumnsForTest ? store.tableColumnsForTest('economy_purchase_intents') : null;
      if (cols == null) return false;
      return ['amount_minor', 'currency', 'price', 'unit_price_minor', 'grant_quantity',
        'settlement_type', 'asset_kind', 'unit_name', 'reservation_id', 'transaction_id',
        'ledger_transaction_id', 'inventory_entry_id'].every(c => cols.indexOf(c) < 0);
    })(), store.tableColumnsForTest ? store.tableColumnsForTest('economy_purchase_intents') : 'no helper');

  check('L2 ★ 那张表里**只有一个**数量列（units），而它是选择而不是事实',
    (function () {
      const cols = store.tableColumnsForTest('economy_purchase_intents');
      return cols.filter(c => /quantity|units|qty/.test(c)).length === 1 &&
        cols.indexOf('units') >= 0;
    })());

  check('L3 economy_purchases 上仍然是 P22-7 的五个可空授权列**加** P22-6 的既有列 —— 本阶段一个列都没加',
    (function () {
      const cols = store.tableColumnsForTest('economy_purchases');
      return cols.indexOf('approval_mode') >= 0 && cols.indexOf('approval_id') >= 0 &&
        cols.indexOf('autonomy_policy_id') >= 0 && cols.indexOf('approval_binding_fingerprint') >= 0 &&
        cols.indexOf('units') >= 0 &&
        /* ★ intent 的 id **不**在 purchases 上（它属于 intent 那一侧）。 */
        cols.indexOf('agent_intent_id') < 0 && cols.indexOf('intent_id') < 0;
    })(), store.tableColumnsForTest('economy_purchases'));

  check('L4 生产代码里没有 DELETE FROM 任何经济事实表（先剥注释与字符串，否则一句解释会被判成删除）',
    (function () {
      const stripped = STORE_SOURCE
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''");
      return !/DELETE\s+FROM\s+economy_/i.test(stripped);
    })());

  /* ★★ P22-26 更新了这两条的**字面话**（水位 7 → 8），判据一个字没改：
     · 6 → 7 仍然是**空**的（新实体 → 补表），它证明的是"P22-8 没有改写
       任何既有行"；
     · 而 P22-26 又加了一条**非空**迁移（7 → 8 给 quotes 补 units 一列），
       因此"最新那一条是空的"不再为真 —— 它本来也不该为真。新增的 L5B
       单独把 7 → 8 钉住：它**必须**ALTER，而且**必须**只加列。 */
  check('L5 ★ schema 水位抬到 8，而 6 → 7 的迁移仍然是**空**的（新实体 → 补表，不是 ALTER）',
    createEconomyStore.SCHEMA_VERSION === 8 &&
    (function () {
      /* ★ 窗口必须恰好是那条迁移**自己**的正文：`from: 6, to: 7` 的声明后面
         跟着的是**下一条**迁移的说明注释（那段注释里就写着 `ALTER TABLE`
         这几个字 —— 它在描述那一列，不是在执行），因此窗口的上界是下一条
         说明注释的开头，而不是下一条声明的开头。开发期实测踩到过这一点：
         取到下一条声明时，这条断言以"红色的假象"失败。
         ★ 而且 6 → 7 的声明比 7 → 8 的说明注释更早出现，所以"注释先于声明"
         这件事是这一段的**结构**，不是巧合 —— 用 indexOf 两次即可。 */
      const at = STORE_SOURCE.indexOf('from: 6, to: 7');
      if (at < 0) return false;
      const nextComment = STORE_SOURCE.indexOf('── 7 → 8（P22-26）', at);
      if (nextComment < 0) return false;
      const block = STORE_SOURCE.slice(at, nextComment);
      /* 6 → 7 是**空**的：它的正文里连 ALTER 这几个字母都不该出现。 */
      return block.indexOf('ALTER') < 0 && block.indexOf('apply') >= 0 && block.length < 400;
    })());

  /* ── L5B · P22-26 的 7 → 8 是与 6 → 7 恰好相反的那种迁移 ──────────────
     它是**既有实体上的新事实**（quotes 多一列 units），因此必须是非空的
     ALTER —— 而它又必须**只加列**：没有任何 UPDATE / DELETE / INSERT，
     于是"P22-26 没有改写任何既有值"由这条直接证明（既有数据逐字节不变
     另有 P22-5 的 J1/J2 用行为证明）。
     ★ 判据用"块里有没有那三样动词"，而不是"块的长度" —— 与 L5 同款。 */
  check('L5B ★ 7 → 8 **不是**空迁移：它 ALTER quotes 补一列 units，且只加列、不改写任何既有值',
    (function () {
      const at = STORE_SOURCE.indexOf('from: 7, to: 8');
      if (at < 0) return false;
      const block = STORE_SOURCE.slice(at, at + 1200);
      return block.indexOf('ALTER TABLE') >= 0 &&
        block.indexOf('ADD COLUMN units INTEGER NOT NULL') >= 0 &&
        block.indexOf('UPDATE ') < 0 && block.indexOf('DELETE ') < 0 && block.indexOf('INSERT ') < 0;
    })());

  check('L6 ★ 一个 schema 6 的库（P22-7 写的）打开之后水位变成 8，而且**补上了**新表',
    (function () {
      const dir = tmpDir('l6');
      /* 手工造一个 P22-7 的库：用当前 build 建库之后把水位改回 6 再删掉新表，
         模拟"这是 P22-7 写下的库"。 */
      const s1 = createEconomyStore({ dataDir: dir, logger: () => {} });
      s1.open();
      s1.close();
      const sqlite = require('node:sqlite');
      const db = new sqlite.DatabaseSync(path.join(dir, 'home-node.db'));
      db.exec('DROP TABLE ' + 'economy_purchase_intents');
      db.exec("UPDATE economy_meta SET value='6' WHERE key='economy_schema'");
      db.close();
      const s2 = createEconomyStore({ dataDir: dir, logger: () => {} });
      const opened = s2.open();
      const ok = opened.ok === true &&
        s2.schemaVersionForTest() === 8 &&
        intentStates(s2).PROPOSED === 0;
      s2.close();
      return ok;
    })());

  check('L7 ★ 一个"更新的 build 写的库"（水位 9）被**拒绝**，而且拒绝是只读的',
    (function () {
      const dir = tmpDir('l7');
      const s1 = createEconomyStore({ dataDir: dir, logger: () => {} });
      s1.open();
      s1.close();
      const sqlite = require('node:sqlite');
      const db = new sqlite.DatabaseSync(path.join(dir, 'home-node.db'));
      db.exec('DROP TABLE economy_purchase_intents');
      /* ★ 比当前水位**大一**：这个数字必须跟着 SCHEMA_VERSION 走，否则
         下一次抬水位时这条断言会变成"打开一个同代库"，于是它证明的东西
         （不降级）静默消失。 */
      db.exec("UPDATE economy_meta SET value='" + (Number(createEconomyStore.SCHEMA_VERSION) + 1) + "' WHERE key='economy_schema'");
      db.close();
      const s2 = createEconomyStore({ dataDir: dir, logger: () => {} });
      let threw = null;
      try { s2.open(); } catch (e) { threw = e; }
      /* ★ 拒绝必须是只读的：被拒绝的库上不该悄悄多出 economy_purchase_intents。 */
      const db2 = new sqlite.DatabaseSync(path.join(dir, 'home-node.db'));
      const still = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='economy_purchase_intents'").get();
      db2.close();
      return threw != null && String(threw.code) === 'SCHEMA_TOO_NEW' && still === undefined;
    })());

  store.close();
}

/* ── 清理 ───────────────────────────────────────────────────────────── */
for (const dir of tempDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 尽力而为 */ }
}

console.log('\n' + (failures === 0 ? '通过 ✔ 0 失败' : '失败 ' + failures + ' 项') + ' · P22-8 Decision Bridge');
process.exit(failures === 0 ? 0 : 1);







