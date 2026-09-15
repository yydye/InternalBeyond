/* ====================================================================
   P22-7 · Approval —— 批准记录生命周期的专项测试

   这一份回答的问题只有一类：**"用户授权某个被冻结的购买意图继续执行"
   这个事实是怎么被创建、决定、过期和消费的**，以及它为什么不能绕过
   任何一条既有规则。

   它**不**碰真实进程与并发（那些在 test_p22_7_economy_runtime.js）。
   它用一个确定性的时钟 + 注入的 id 源 + 临时数据目录。

   七个组：
     A · 自主策略的持久化（写 / 读 / revision / 事件 / 幂等）
     B · §5/§9 Approval 的五态状态机与四条终态不可倒退的边
     C · §6 九元组绑定：批准**不能**被挪给另一笔购买
     D · §8 一次性消费：一个批准最多一笔购买
     E · §7 快照：批准针对 Quote，而不是 mutable Product
     F · §10/§11 与 P22-6 的接入：授权闸门 + 预算不可绕过
     G · §16 审计：仅凭 canonical facts 回答四个问题

   运行：node tests/test_p22_7_economy_approval.js
   ==================================================================== */
'use strict';

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
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-7a-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

/* ── 可推进的时钟：expire 类断言不能靠"等一会儿"。 */
const CLOCK = 1717200000000;
let CLOCK_NOW = CLOCK;
function now() { return CLOCK_NOW; }
function resetClock() { CLOCK_NOW = CLOCK; }

let idSeq = 0;
function deterministicIds() {
  return (kind) => { idSeq += 1; return C.formatEconomyId(kind, 'a' + idSeq).id; };
}
function makeStore(extra) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir, logger: () => {}, clock: now, nextId: deterministicIds()
  }, extra || {}));
}
let keySeq = 0;
function nextKey(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }

const BUYER = Object.freeze({ type: 'character', id: 'cfg_a' });
const GIVER = Object.freeze({ type: 'character', id: 'cfg_b' });
const USER = Object.freeze({ type: 'user', id: 'user' });
const OTHER_USER = Object.freeze({ type: 'user', id: 'user2' });

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

function budgetPolicy(store, ownerId, limits) {
  const out = store.putBudgetPolicy({
    ownerId: { type: 'character', id: ownerId || 'cfg_a' },
    currency: 'IB_CREDIT',
    limits: Object.assign({
      perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000
    }, limits || {}),
    idempotencyKey: nextKey('bp')
  });
  assert.equal(out.ok, true, 'putBudgetPolicy must succeed: ' + J(out.errors || out));
  return out.result;
}

function autonomyPolicy(store, options) {
  const o = options || {};
  const perPurchase = o.perPurchaseLimitMinor != null ? o.perPurchaseLimitMinor : 500;
  const daily = o.dailyAutonomousLimitMinor != null ? o.dailyAutonomousLimitMinor : 1000;
  const out = store.putAutonomyPolicy({
    ownerId: o.ownerId || BUYER,
    enabled: o.enabled != null ? o.enabled : true,
    perPurchaseLimitMinor: perPurchase,
    dailyAutonomousLimitMinor: daily,
    /* ★ 缺省审批线 = 单笔上限：策略必须满足 approvalAbove ≤ perPurchase ≤
       daily 这三条序关系（一条永远不会被触发的审批线比没有更糟），
       因此这里的缺省值不能是一个与 perPurchase 无关的常数。 */
    approvalAboveMinor: o.approvalAboveMinor != null ? o.approvalAboveMinor : perPurchase,
    allowedProductKinds: o.allowedProductKinds || ['COMPUTE_CREDIT'],
    allowedSettlementTypes: o.allowedSettlementTypes || ['COMPUTE_GRANT'],
    allowGift: o.allowGift === true,
    idempotencyKey: o.idempotencyKey || nextKey('ap')
  });
  assert.equal(out.ok, true, 'putAutonomyPolicy must succeed: ' + J(out.errors || out));
  return out.result;
}

let storeSeq = 0;
/* 一个最小可用世界：买家的钱包 + 预算政策 + 一个 COMPUTE 商品 + 一份报价。 */
function world(options) {
  const o = options || {};
  storeSeq += 1;
  resetClock();
  const store = makeStore({ dataDir: o.dataDir || tmpDir('w' + storeSeq) });
  assert.equal(store.open().ok, true);
  walletWith(store, o.balanceMinor != null ? o.balanceMinor : 10000);
  budgetPolicy(store, 'cfg_a', o.budgetLimits);
  const s = store.putStore({
    storeId: C.formatEconomyId('STORE', 's' + storeSeq).id, name: 'Shelf',
    status: 'ACTIVE', idempotencyKey: nextKey('st')
  });
  assert.equal(s.ok, true, J(s.errors || s));
  const p = store.putProduct({
    productId: C.formatEconomyId('PRODUCT', 'p' + storeSeq).id,
    storeId: s.result.storeId, name: 'Compute pack',
    kind: o.productKind || 'COMPUTE_CREDIT',
    unitPriceMinor: o.unitPriceMinor != null ? o.unitPriceMinor : 100,
    currency: 'IB_CREDIT',
    grantQuantity: o.grantQuantity != null ? o.grantQuantity : 100,
    unitName: o.unitName || 'computeUnit',
    status: 'ACTIVE', idempotencyKey: nextKey('pr')
  });
  assert.equal(p.ok, true, J(p.errors || p));
  return { store: store, productId: p.result.productId, storeId: s.result.storeId };
}

function quote(store, productId, options) {
  const o = options || {};
  const q = store.createProductQuote({
    productId: productId,
    buyerId: o.buyerId || BUYER,
    kind: o.kind || 'PURCHASE',
    recipientId: o.recipientId || undefined,
    units: o.units != null ? o.units : 1,
    expiresAt: o.expiresAt != null ? o.expiresAt : (CLOCK + 3600000),
    idempotencyKey: o.idempotencyKey || nextKey('q')
  });
  assert.equal(q.ok, true, 'createProductQuote must succeed: ' + J(q.errors || q));
  return q.result;
}

/* 请求批准（经由授权闸门 —— 那才是生产路径）。 */
function requestApproval(store, quoteId, options) {
  const o = options || {};
  return store.authorizePurchaseIntent({
    buyerId: o.buyerId || BUYER,
    recipientId: o.recipientId || undefined,
    quoteId: quoteId,
    units: o.units != null ? o.units : 1,
    idempotencyKey: o.idempotencyKey || nextKey('auth'),
    approvalExpiresAt: o.approvalExpiresAt != null ? o.approvalExpiresAt : (CLOCK + 600000),
    approvalRecordId: o.approvalRecordId || undefined
  });
}

function approve(store, approvalId, options) {
  const o = options || {};
  return store.decideApproval({
    approvalId: approvalId, decision: 'APPROVED',
    decidedBy: o.decidedBy || USER, idempotencyKey: o.idempotencyKey || nextKey('d')
  });
}
function reject(store, approvalId, options) {
  const o = options || {};
  return store.decideApproval({
    approvalId: approvalId, decision: 'REJECTED',
    decidedBy: o.decidedBy || USER, idempotencyKey: o.idempotencyKey || nextKey('d')
  });
}

function prepareOk(store, quoteId, options) {
  const o = options || {};
  const r = store.preparePurchase(Object.assign({
    buyerId: BUYER, quoteId: quoteId, units: 1,
    expiresAt: CLOCK + 1800000, idempotencyKey: nextKey('p')
  }, o));
  assert.equal(r.ok, true, 'preparePurchase must succeed: ' + J(r.errors || r));
  return r.result;
}

/* ══════════════════════════════════════════════════════════════════
   A · 自主策略的持久化
   ══════════════════════════════════════════════════════════════════ */
section('A · 自主策略：写 / 读 / revision / 事件 / 幂等');

check('A1 putAutonomyPolicy 落下一行，读回来逐字相同（三个额度都是 canonical 十进制字符串）',
  (() => {
    const w = world();
    const before = w.store.getRevision();
    const created = autonomyPolicy(w.store, {
      enabled: true, perPurchaseLimitMinor: 300, dailyAutonomousLimitMinor: 900,
      approvalAboveMinor: 200, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], allowGift: false
    });
    const read = w.store.getAutonomyPolicy({ ownerId: BUYER });
    return read.ok === true && read.policy.enabled === true &&
      read.policy.perPurchaseLimitMinor === 300n &&
      read.policy.dailyAutonomousLimitMinor === 900n &&
      read.policy.approvalAboveMinor === 200n &&
      read.policy.allowedProductKinds.join(',') === 'COMPUTE_CREDIT' &&
      read.policy.allowedSettlementTypes.join(',') === 'COMPUTE_GRANT' &&
      read.policy.allowGift === false && read.policy.unusable === false &&
      created.created === true &&
      /* 一次写入恰好推进一个 revision。 */
      created.revision === before + 1 && w.store.getRevision() === before + 1;
  })());

check('A2 创建写出 AUTONOMY_POLICY_CREATED 与 AUTONOMY_POLICY_UPDATED 两条**不同**的事件'
  + '（"有人改了自主额度"必须能与"有人改了预算额度"分开）',
  (() => {
    const w = world();
    autonomyPolicy(w.store, { perPurchaseLimitMinor: 300, dailyAutonomousLimitMinor: 900 });
    const createdChanges = w.store.listChanges(0, 500).filter(c => c.kind === 'AUTONOMY_POLICY_CREATED');
    autonomyPolicy(w.store, { perPurchaseLimitMinor: 300, dailyAutonomousLimitMinor: 900, approvalAboveMinor: 100 });
    const updatedChanges = w.store.listChanges(0, 500).filter(c => c.kind === 'AUTONOMY_POLICY_UPDATED');
    return createdChanges.length === 1 && updatedChanges.length === 1 &&
      createdChanges[0].payload.grantsBudget === false &&
      createdChanges[0].payload.isADecisionLayer === false &&
      createdChanges[0].payload.providerMutation === false &&
      createdChanges[0].payload.relationshipMutation === false &&
      updatedChanges[0].payload.enabled === true &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'BUDGET_POLICY_UPDATED').length === 0;
  })());

check('A3 一个 owner 恰好一条自主策略（改它就是改那一行，不会长出第二条）',
  (() => {
    const w = world();
    const first = autonomyPolicy(w.store);
    autonomyPolicy(w.store, { perPurchaseLimitMinor: 200, dailyAutonomousLimitMinor: 800 });
    autonomyPolicy(w.store, { perPurchaseLimitMinor: 100, dailyAutonomousLimitMinor: 700 });
    const list = w.store.listAutonomyPolicies({ ownerId: 'cfg_a' });
    const read = w.store.getAutonomyPolicy({ ownerId: BUYER });
    return list.ok === true && list.count === 1 && read.policy.policyId === first.policyId &&
      read.policy.perPurchaseLimitMinor === 100n &&
      w.store.health().counts.autonomyPolicies === 1;
  })());

check('A4 幂等：同一个 key + 同一份内容 ⇒ 回放（replayed），不写第二行、不推进 revision',
  (() => {
    const w = world();
    const key = nextKey('ap-idem');
    const a = w.store.putAutonomyPolicy({
      ownerId: BUYER, enabled: true, perPurchaseLimitMinor: 300, dailyAutonomousLimitMinor: 900,
      approvalAboveMinor: 200, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], idempotencyKey: key
    });
    const rev = w.store.getRevision();
    const b = w.store.putAutonomyPolicy({
      ownerId: BUYER, enabled: true, perPurchaseLimitMinor: 300, dailyAutonomousLimitMinor: 900,
      approvalAboveMinor: 200, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], idempotencyKey: key
    });
    return a.ok === true && b.ok === true && b.replayed === true &&
      b.result.policyId === a.result.policyId && w.store.getRevision() === rev &&
      w.store.health().counts.autonomyPolicies === 1;
  })());

check('A5 同一个 key + **不同**内容 ⇒ 拒绝（幂等冲突），不是静默覆盖',
  (() => {
    const w = world();
    const key = nextKey('ap-conflict');
    const a = w.store.putAutonomyPolicy({
      ownerId: BUYER, enabled: true, perPurchaseLimitMinor: 300, dailyAutonomousLimitMinor: 900,
      approvalAboveMinor: 200, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], idempotencyKey: key
    });
    const b = w.store.putAutonomyPolicy({
      ownerId: BUYER, enabled: true, perPurchaseLimitMinor: 400, dailyAutonomousLimitMinor: 900,
      approvalAboveMinor: 200, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], idempotencyKey: key
    });
    return a.ok === true && b.ok === false && b.denied === false &&
      b.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0 &&
      b.scope === C.OPERATION_SCOPE.AUTONOMY_POLICY &&
      b.idempotencyKey === key &&
      /different request/.test(String(b.detail)) &&
      /* 冲突**不是**一次业务拒绝（denied=false）：它是"这个 key 已经属于
         另一件事"。两者必须可分，否则运维会把它当成一条规则说不。 */
      w.store.health().counts.autonomyPolicies === 1;
  })());

check('A6 ifRevision 是乐观并发：给错的 revision 就拒绝，且拒绝时**不消耗** revision',
  (() => {
    const w = world();
    const first = autonomyPolicy(w.store, { perPurchaseLimitMinor: 300, dailyAutonomousLimitMinor: 900 });
    const rev = w.store.getRevision();
    const stale = w.store.putAutonomyPolicy({
      ownerId: BUYER, enabled: true, perPurchaseLimitMinor: 400, dailyAutonomousLimitMinor: 900,
      approvalAboveMinor: 400, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], ifRevision: first.revision + 99,
      idempotencyKey: nextKey('ap-stale')
    });
    return stale.ok === false && stale.errors.indexOf('autonomy-policy-revision-mismatch') >= 0 &&
      stale.actualRevision === first.revision && w.store.getRevision() === rev;
  })());

check('A7 形状错误一律被拒，且**不落行**（拒绝整体回滚 —— 与 P22-3 reserve 同一条纪律）',
  (() => {
    const w = world();
    const bad = w.store.putAutonomyPolicy({
      ownerId: BUYER, enabled: true, perPurchaseLimitMinor: 900, dailyAutonomousLimitMinor: 100,
      idempotencyKey: nextKey('ap-bad')
    });
    const systemOwner = w.store.putAutonomyPolicy({
      ownerId: { type: 'system', id: 'market' }, enabled: true,
      perPurchaseLimitMinor: 100, dailyAutonomousLimitMinor: 100, idempotencyKey: nextKey('ap-sys')
    });
    return bad.ok === false && bad.denied === true &&
      bad.reasonCode === C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED &&
      systemOwner.ok === false && systemOwner.denied === false &&
      w.store.health().counts.autonomyPolicies === 0 &&
      w.store.getAutonomyPolicy({ ownerId: BUYER }).ok === false;
  })());

check('A8 getAutonomyPolicy / listAutonomyPolicies 在"没有这一条"时给出 POLICY_NOT_FOUND，而不是空对象',
  (() => {
    const w = world();
    const byOwner = w.store.getAutonomyPolicy({ ownerId: BUYER });
    const byId = w.store.getAutonomyPolicy({ policyId: 'econ_policy_nope' });
    const list = w.store.listAutonomyPolicies({ ownerId: 'cfg_a' });
    return byOwner.ok === false && byOwner.reasonCode === C.DENY_REASON.POLICY_NOT_FOUND &&
      byId.ok === false && byId.reasonCode === C.DENY_REASON.POLICY_NOT_FOUND &&
      list.ok === true && list.count === 0 && list.policies.length === 0;
  })());

check('A9 health 把"有几条策略"与"有几台 Agent 真的被允许自主购买"分成**两个**数',
  (() => {
    const w = world();
    autonomyPolicy(w.store, { perPurchaseLimitMinor: 100, dailyAutonomousLimitMinor: 500 });
    const enabledTrue = w.store.health().counts;
    autonomyPolicy(w.store, { enabled: false });
    const enabledFalse = w.store.health().counts;
    return enabledTrue.autonomyPolicies === 1 && enabledTrue.enabledAutonomyPolicies === 1 &&
      enabledFalse.autonomyPolicies === 1 && enabledFalse.enabledAutonomyPolicies === 0;
  })());

check('A10 serializeAutonomyPolicy 逐字写出四条自述（grantBudget / replacesBudget / isADecisionLayer / usable）',
  (() => {
    const w = world();
    autonomyPolicy(w.store);
    const s = w.store.serializeAutonomyPolicy(w.store.getAutonomyPolicy({ ownerId: BUYER }).policy);
    return s.grantsBudget === false && s.replacesBudget === false &&
      s.isADecisionLayer === false && s.usable === true &&
      s.approvalAboveMinor === '500' && s.perPurchaseLimitMinor === '500' &&
      s.ownerId === 'character:cfg_a' && s.kind === 'autonomy' &&
      s.namespace === C.NAMESPACES.BUDGET;
  })());

/* ══════════════════════════════════════════════════════════════════
   B · Approval 的五态状态机
   ══════════════════════════════════════════════════════════════════ */
section('B · Approval：五态状态机与四条终态不可倒退的边');

check('B1 ★★ 没有自主策略时，授权闸门给出 REQUIRE_APPROVAL 并**创建**一条 PENDING 记录',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const read = w.store.getApproval({ approvalId: out.approvalId });
    return out.ok === true && out.autonomyOutcome === C.AP_DECISION.REQUIRE_APPROVAL &&
      out.approvalRequired === true && out.allowed === false &&
      out.proceedToPrepare === false &&
      out.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
      out.approvalCreated === true && out.approvalStatus === C.APPROVAL_STATE.PENDING &&
      read.ok === true && read.approval.status === 'PENDING' &&
      read.approval.terminal === false &&
      /* ★ 一次请求批准**不是**一次购买（§5）。 */
      out.purchaseCreated === false && out.fundsReserved === false &&
      out.ledgerMutation === false && out.inventoryMutation === false &&
      w.store.health().counts.purchases === 0 &&
      w.store.health().counts.pendingApprovals === 1;
  })());

check('B2 ★★ 创建批准写出 APPROVAL_REQUESTED，且它的 payload 逐字否认"这是一次购买"',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const ev = w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_REQUESTED');
    return ev.length === 1 && ev[0].entityId === out.approvalId &&
      ev[0].payload.purchaseCreated === false && ev[0].payload.fundsReserved === false &&
      ev[0].payload.ledgerMutation === false && ev[0].payload.inventoryMutation === false &&
      ev[0].payload.providerMutation === false && ev[0].payload.paymentMutation === false &&
      ev[0].payload.memoryMutation === false && ev[0].payload.relationshipMutation === false &&
      ev[0].payload.approvalStatus === 'PENDING' &&
      ev[0].payload.autonomyOutcome === C.AP_DECISION.REQUIRE_APPROVAL &&
      typeof ev[0].payload.bindingFingerprint === 'string' &&
      ev[0].payload.bindingFingerprint.length > 0;
  })());

check('B3 ★★ self-approval 被**结构性**拒绝：买方不能批准自己的购买（PARTY_NOT_ALLOWED + 一个具名标记）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const self = w.store.decideApproval({
      approvalId: out.approvalId, decision: 'APPROVED', decidedBy: BUYER,
      idempotencyKey: nextKey('d')
    });
    const read = w.store.getApproval({ approvalId: out.approvalId });
    return self.ok === false && self.denied === true &&
      self.reasonCode === C.DENY_REASON.PARTY_NOT_ALLOWED &&
      self.selfApprovalRejected === true &&
      read.approval.status === 'PENDING' &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_APPROVED').length === 0;
  })());

check('B3b ★ self-approval 的判据是 (type, id) **二元组**，而不是一个裸字符串 id'
  + '（同一段字符串在两个类型下是两个不同的 party）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    /* ① 'user':id 必须是那个 canonical 的 'user' —— 一个自称 user 却
       带着别 id 的 party 在**规范化**阶段就被拒（它不是一个身份）。 */
    const bogusUser = w.store.decideApproval({
      approvalId: out.approvalId, decision: 'APPROVED',
      decidedBy: { type: 'user', id: 'cfg_a' }, idempotencyKey: nextKey('d')
    });
    /* ② 一段**相同**的字符串在一个不同**类型**下是一个不同的 party：
       character:cfg_c 既不是买家，也不是那个 canonical user。 */
    walletWith(w.store, 0, 'cfg_c');
    const otherCharacter = w.store.decideApproval({
      approvalId: out.approvalId, decision: 'APPROVED',
      decidedBy: { type: 'character', id: 'cfg_c' }, idempotencyKey: nextKey('d')
    });
    const read = w.store.getApproval({ approvalId: out.approvalId }).approval;
    return bogusUser.ok === false &&
      bogusUser.errors.indexOf('party-user-id-must-be-canonical-user') >= 0 &&
      otherCharacter.ok === true && otherCharacter.result.status === 'APPROVED' &&
      otherCharacter.result.decidedBy === 'character:cfg_c' &&
      /* ★ 读面上的决定者是一个**键**（'type:id'），而它同时保留拆开的两半
         —— 于是"谁批的"既能被比较，也能被单独查询。 */
      read.decidedBy === 'character:cfg_c' &&
      read.decidedByRef.type === 'character' && read.decidedByRef.id === 'cfg_c' &&
      read.decidedByRef !== read.buyerRef &&
      /* 买家是 'character:cfg_a' —— 因此 character:cfg_c 不是 self-approval。 */
      read.buyerId === 'character:cfg_a' &&
      /* 而 'character:cfg_a' 自己是 self-approval（见 B3）。 */
      C.PARTY_TYPES.indexOf('user') >= 0 && C.USER_PARTY_ID === 'user';
  })());

check('B4 PENDING → APPROVED：第三个 party 点头，写出 APPROVAL_APPROVED（带 snapshot 与决定者）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const d = approve(w.store, out.approvalId);
    const ev = w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_APPROVED');
    const read = w.store.getApproval({ approvalId: out.approvalId });
    return d.ok === true && d.result.status === 'APPROVED' &&
      d.result.decidedBy === 'user:user' && typeof d.result.decidedAt === 'number' &&
      d.result.consumedByPurchaseId === null &&
      /* ★ 批准了也**不是**购买。 */
      d.result.purchaseCreated === false && d.result.ledgerMutation === false &&
      ev.length === 1 && ev[0].payload.fromStatus === 'PENDING' &&
      ev[0].payload.approvalStatus === 'APPROVED' &&
      ev[0].payload.decidedBy === 'user:user' &&
      typeof ev[0].payload.bindingFingerprint === 'string' &&
      read.approval.status === 'APPROVED' && read.approval.terminal === false;
  })());

check('B5 PENDING → REJECTED：用户摇头，写出 APPROVAL_REJECTED，且**不**创建任何购买',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const d = reject(w.store, out.approvalId);
    const ev = w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_REJECTED');
    return d.ok === true && d.result.status === 'REJECTED' && d.result.terminal === true &&
      ev.length === 1 && ev[0].payload.fromStatus === 'PENDING' &&
      w.store.health().counts.purchases === 0 &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'PURCHASE_CREATED').length === 0;
  })());

check('B6 ★★ §9 的四条禁止的边逐条被拒（REJECTED / EXPIRED / CONSUMED 不可倒退，PENDING 不能直接 CONSUMED）',
  (() => {
    const w = world();
    /* ① REJECTED → APPROVED */
    const q1 = quote(w.store, w.productId);
    const a1 = requestApproval(w.store, q1.quoteId);
    reject(w.store, a1.approvalId);
    const backwards = approve(w.store, a1.approvalId);
    /* ② PENDING → CONSUMED（不是一条合法的转移） */
    const q2 = quote(w.store, w.productId);
    const a2 = requestApproval(w.store, q2.quoteId);
    const skip = w.store.decideApproval({
      approvalId: a2.approvalId, decision: 'CONSUMED', decidedBy: USER,
      idempotencyKey: nextKey('d')
    });
    return backwards.ok === false && backwards.denied === true &&
      backwards.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
      backwards.terminal === true &&
      backwards.approvalStatus === 'REJECTED' &&
      skip.ok === false && skip.denied === true &&
      /* "决定"只接受两个词，第三个词连进来都进不来。 */
      skip.errors.indexOf('a-decision-must-be-approved-or-rejected') >= 0 &&
      w.store.getApproval({ approvalId: a2.approvalId }).approval.status === 'PENDING';
  })());

check('B7 PENDING → EXPIRED（用户在有效期内没有回答）与 APPROVED → EXPIRED（批准了但没被用掉）'
  + '两条边都成立，而终态不会再被 expire 碰到',
  (() => {
    const w = world();
    const q1 = quote(w.store, w.productId);
    const a1 = requestApproval(w.store, q1.quoteId, { approvalExpiresAt: CLOCK + 60000 });
    const q2 = quote(w.store, w.productId);
    const a2 = requestApproval(w.store, q2.quoteId, { approvalExpiresAt: CLOCK + 60000 });
    approve(w.store, a2.approvalId);
    /* 有效期未到 ⇒ 拒绝。 */
    const early = w.store.expireApproval({ approvalId: a1.approvalId });
    CLOCK_NOW = CLOCK + 120000;
    const pendingExpired = w.store.expireApproval({ approvalId: a1.approvalId });
    const approvedExpired = w.store.expireApproval({ approvalId: a2.approvalId });
    const again = w.store.expireApproval({ approvalId: a2.approvalId });
    const s1 = w.store.getApproval({ approvalId: a1.approvalId }).approval;
    const s2 = w.store.getApproval({ approvalId: a2.approvalId }).approval;
    return early.ok === false && early.denied === true &&
      early.errors.indexOf('approval-is-not-past-its-expires-at') >= 0 &&
      pendingExpired.ok === true && pendingExpired.result.fromStatus === 'PENDING' &&
      approvedExpired.ok === true && approvedExpired.result.fromStatus === 'APPROVED' &&
      s1.status === 'EXPIRED' && s2.status === 'EXPIRED' &&
      again.ok === false && again.terminal === true &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_EXPIRED').length === 2;
  })());

check('B8 一条 PENDING 记录**过期后不能再被批准**（写锁里再过一次时间 —— "过期"不能被一次恰好的点击绕过）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId, { approvalExpiresAt: CLOCK + 60000 });
    CLOCK_NOW = CLOCK + 120000;
    const late = approve(w.store, out.approvalId);
    const read = w.store.getApproval({ approvalId: out.approvalId }).approval;
    return late.ok === false && late.denied === true && late.terminal === true &&
      late.reasonCode === C.DENY_REASON.APPROVAL_EXPIRED &&
      late.approvalStatus === 'EXPIRED' &&
      read.status === 'EXPIRED' && read.expiredByTime === false &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_APPROVED').length === 0;
  })());

check('B9 expireDueApprovals 是**扫描**而不是定时器：它只剩该过期的那几条，且报告 isATimer=false',
  (() => {
    const w = world();
    const q1 = quote(w.store, w.productId);
    const q2 = quote(w.store, w.productId);
    const q3 = quote(w.store, w.productId);
    requestApproval(w.store, q1.quoteId, { approvalExpiresAt: CLOCK + 60000 });
    requestApproval(w.store, q2.quoteId, { approvalExpiresAt: CLOCK + 60000 });
    requestApproval(w.store, q3.quoteId, { approvalExpiresAt: CLOCK + 900000 });
    CLOCK_NOW = CLOCK + 120000;
    const sweep = w.store.expireDueApprovals({});
    return sweep.ok === true && sweep.count === 2 && sweep.isATimer === false &&
      w.store.health().counts.expiredApprovals === 2 &&
      w.store.health().counts.pendingApprovals === 1;
  })());

check('B10 决定本身是幂等的：同一个 key 重放回放原来的结果；不同 key 再决定一次会被终态拒绝',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const key = nextKey('d-replay');
    const first = approve(w.store, out.approvalId, { idempotencyKey: key });
    const replay = approve(w.store, out.approvalId, { idempotencyKey: key });
    const second = reject(w.store, out.approvalId);
    const rev = w.store.getRevision();
    const replay2 = approve(w.store, out.approvalId, { idempotencyKey: key });
    /* ★ 第三条的 `terminal` 是 **false**，而这是对的：APPROVED → REJECTED
       不是"终态回退"（APPROVED 仍有出边），它是"你没有从这里走到那里"。
       两条禁止的边因此在返回里也**可区分** —— 这正是 P22-3 的
       assertTransition 区分 terminal 与 illegal 的同一个理由。 */
    return first.ok === true && replay.ok === true && replay.replayed === true &&
      replay.result.status === 'APPROVED' &&
      second.ok === false && second.denied === true &&
      second.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
      second.terminal === false && second.approvalStatus === 'APPROVED' &&
      /* 被拒绝的那次没有写任何东西。 */
      replay2.ok === true && replay2.replayed === true &&
      replay2.result.status === 'APPROVED' &&
      w.store.getRevision() === rev &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_REJECTED').length === 0;
  })());

check('B11 getApproval / listApprovals：按 status 过滤，未知 status 被拒绝（词表是封闭的）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const pending = w.store.listApprovals({ status: 'PENDING' });
    const approved = w.store.listApprovals({ status: 'APPROVED' });
    const bad = w.store.listApprovals({ status: 'MAYBE' });
    const missing = w.store.getApproval({ approvalId: 'econ_approval_nope' });
    const notId = w.store.getApproval({ approvalId: 'econ_intent_x' });
    return pending.ok === true && pending.count === 1 && pending.approvals[0].approvalId === out.approvalId &&
      approved.ok === true && approved.count === 0 &&
      bad.ok === false && bad.errors.indexOf('approval-status-not-in-closed-set') >= 0 &&
      missing.ok === false && missing.reasonCode === C.DENY_REASON.APPROVAL_NOT_FOUND &&
      notId.ok === false && notId.errors.indexOf('approval-id-not-canonical') >= 0;
  })());

check('B12 ★ 请求批准本身是幂等的：同一个 key 重放**不会**创建第二条批准',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const key = nextKey('auth-replay');
    const a = requestApproval(w.store, q.quoteId, { idempotencyKey: key });
    const b = requestApproval(w.store, q.quoteId, { idempotencyKey: key });
    return a.ok === true && b.ok === true && b.approvalReplayed === true &&
      b.approvalId === a.approvalId && b.approvalCreated === false &&
      w.store.health().counts.approvals === 1;
  })());

/* ══════════════════════════════════════════════════════════════════
   C · §6 九元组绑定
   ══════════════════════════════════════════════════════════════════ */
section('C · §6 九元组绑定：批准不能被挪给另一笔购买');

check('C1 ★★ 一张批准只授权它绑定的那**一份报价**：拿它去买另一份报价 ⇒ APPROVAL_MISMATCH'
  + '（粗筛在事务之前就拒，并逐字给出两张 quote id）',
  (() => {
    const w = world();
    const q1 = quote(w.store, w.productId);
    const q2 = quote(w.store, w.productId);
    const out = requestApproval(w.store, q1.quoteId);
    approve(w.store, out.approvalId);
    const wrong = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q2.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    return wrong.ok === false && wrong.denied === true &&
      wrong.reasonCode === C.DENY_REASON.APPROVAL_MISMATCH &&
      wrong.approvalId === out.approvalId &&
      wrong.approvalQuoteId === q1.quoteId &&
      wrong.purchaseQuoteId === q2.quoteId &&
      wrong.errors.indexOf('this-approval-authorizes-a-different-quote') >= 0 &&
      wrong.oneApprovalCannotBeMovedToAnotherPurchase === true &&
      /* ★ 而这**不是**一次"没有批准"的拒绝：它是一个具名的绑定冲突。 */
      wrong.reasonCode !== C.DENY_REASON.APPROVAL_REQUIRED &&
      w.store.health().counts.purchases === 0;
  })());

check('C2 ★★ 报价的金额与批准的不同 ⇒ 批准失效，而且差异里逐字给出金额'
  + '（"用户批准过 400"不蕴含"用户批准了另一次 400"）',
  (() => {
    const dir = tmpDir('c2');
    const w = world({ dataDir: dir });
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    /* ★ 报价的金额在 P22-4 里是**不可变**的（唯一能改的是 state 与
       expires_at）。因此"报价的金额变了"这句话只可能来自一次**库被外部
       工具改过** —— 而这恰好让九元组比对成为**唯一**会拦下它的那道闸门：
       P22-6 的"金额必须等于报价快照"那一关会让拒绝更早发生。 */
    w.store.close();
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(path.join(dir, 'home-node.db'));
    db.exec("UPDATE economy_quotes SET amount_minor = 150 WHERE quote_id = '" + q.quoteId + "'");
    /* 同时把商品的当前价改成 150：这样 P22-6 的"金额 == 当前价 × 份数"
       那一关**通过**，而拒绝只可能来自九元组比对。这正是这一步要隔离的
       东西 —— 否则这一条会重复验证 P22-6 的报价金额闸门。 */
    db.exec("UPDATE economy_products SET unit_price_minor = 150 WHERE product_id = '" + w.productId + "'");
    db.close();
    const reopened = makeStore({ dataDir: dir });
    assert.equal(reopened.open().ok, true);
    const wrong = reopened.preparePurchase({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    const diff = (wrong.differences || []).filter(d => d.field === 'amountMinor')[0];
    return wrong.ok === false && wrong.denied === true &&
      wrong.reasonCode === C.DENY_REASON.APPROVAL_MISMATCH &&
      wrong.mismatchedFields.indexOf('amountMinor') >= 0 &&
      wrong.mismatchedFields.indexOf('quoteId') < 0 &&
      diff != null && diff.approval === '100' && diff.observed === '150' &&
      wrong.oneApprovalCannotBeMovedToAnotherPurchase === true &&
      reopened.health().counts.purchases === 0 &&
      reopened.health().counts.reservations === 0;
  })());

check('C3 ★ recipient 变了 ⇒ 批准失效（"批准了买给自己"不能被用来送礼）',
  (() => {
    /* ★ 送礼需要一件**可持有**的商品：quote kind 由 (fulfillment, 有无
       recipient) 派生（P22-5 的 productQuoteKindFor），而 COMPUTE_GRANT
       永远派生为 COMPUTE_GRANT 报价 —— 因此这里建一件 DIGITAL_ITEM。 */
    const w = world({ productKind: 'DIGITAL_ITEM', unitPriceMinor: 100, grantQuantity: 1, unitName: 'unit' });
    const q1 = quote(w.store, w.productId);
    const out = requestApproval(w.store, q1.quoteId);
    approve(w.store, out.approvalId);
    /* 一份 GIFT 报价（recipient = cfg_b），买家用同一张批准去准备它。 */
    const giftQuote = w.store.createProductQuote({
      productId: w.productId, buyerId: BUYER, recipientId: GIVER,
      units: 1, expiresAt: CLOCK + 3600000, idempotencyKey: nextKey('q-gift')
    });
    assert.equal(giftQuote.ok, true, J(giftQuote.errors || giftQuote));
    const wrong = w.store.preparePurchase({
      buyerId: BUYER, recipientId: GIVER, quoteId: giftQuote.result.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    /* ★ 那张批准授权的是"买给自己"（recipient=null），而这份报价是送礼。 */
    return wrong.ok === false && wrong.denied === true &&
      wrong.reasonCode === C.DENY_REASON.APPROVAL_MISMATCH &&
      w.store.health().counts.purchases === 0;
  })());

check('C4 ★ 数量（units）是绑定的一个事实：一份 2 units 的报价不被那张 1 unit 的批准授权，'
  + '而且 units 与 grantQuantity 在九元组里是**两个**独立的键',
  (() => {
    const w = world();
    const q1 = quote(w.store, w.productId, { units: 1 });
    const out = requestApproval(w.store, q1.quoteId, { units: 1 });
    approve(w.store, out.approvalId);
    const read = w.store.getApproval({ approvalId: out.approvalId }).approval;
    /* 一份 2 units 的报价：金额、数量、grantQuantity 三者都与那张批准不同。 */
    const q2 = quote(w.store, w.productId, { units: 2 });
    const wrong = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q2.quoteId, units: 2,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    /* ★ 九元组比对的**直接**证据：把批准的两个数量事实改成 2，
       身份就变了 —— 因此"换掉数量之后批准必须失效"是结构性的。 */
    const asBound = C.approvalFingerprint({
      buyerId: read.buyerId, recipientId: read.recipientId, productId: read.productId,
      quoteId: read.quoteId, currency: read.currency, amountMinor: read.amountMinor,
      settlementType: read.settlementType, grantQuantity: read.grantQuantity, units: read.units
    });
    const moreUnits = C.approvalFingerprint({
      buyerId: read.buyerId, recipientId: read.recipientId, productId: read.productId,
      quoteId: read.quoteId, currency: read.currency, amountMinor: read.amountMinor,
      settlementType: read.settlementType, grantQuantity: read.grantQuantity * 2, units: 2
    });
    return wrong.ok === false && wrong.denied === true &&
      wrong.reasonCode === C.DENY_REASON.APPROVAL_MISMATCH &&
      read.grantQuantity === 100 && read.units === 1 &&
      asBound.fingerprint === read.bindingFingerprint &&
      moreUnits.fingerprint !== read.bindingFingerprint &&
      /* ★ 两个数量事实**各自独立**地改变身份：只动 grantQuantity 也够。 */
      C.approvalFingerprint(Object.assign({}, read.binding, { grantQuantity: 200 })).fingerprint !==
        read.bindingFingerprint &&
      C.approvalFingerprint(Object.assign({}, read.binding, { units: 2 })).fingerprint !==
        read.bindingFingerprint &&
      C.APPROVAL_BINDING_KEYS.indexOf('units') >= 0 &&
      C.APPROVAL_BINDING_KEYS.indexOf('grantQuantity') >= 0 &&
      w.store.health().counts.purchases === 0;
  })());

check('C5 买家变了 ⇒ 拒绝（一条批准不可能被另一个 owner 用掉）',
  (() => {
    const w = world();
    walletWith(w.store, 10000, 'cfg_b');
    budgetPolicy(w.store, 'cfg_b');
    const q1 = quote(w.store, w.productId);
    const out = requestApproval(w.store, q1.quoteId);
    approve(w.store, out.approvalId);
    /* cfg_b 是另一个 party：它连这份报价的买方都不是。 */
    const wrong = w.store.preparePurchase({
      buyerId: GIVER, quoteId: q1.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    return wrong.ok === false && wrong.denied === true &&
      wrong.reasonCode === C.DENY_REASON.QUOTE_MISMATCH;
  })());

check('C6 ★★ 批准的九元组身份可以**独立重算**，而重算值与落库值逐字相同（"绑定"因此不是注释）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const read = w.store.getApproval({ approvalId: out.approvalId }).approval;
    const recomputed = C.approvalFingerprint({
      buyerId: read.buyerId, recipientId: read.recipientId, productId: read.productId,
      quoteId: read.quoteId, currency: read.currency, amountMinor: read.amountMinor,
      settlementType: read.settlementType, grantQuantity: read.grantQuantity, units: read.units
    });
    return recomputed.ok === true &&
      recomputed.fingerprint === read.bindingFingerprint &&
      read.binding.buyerId === 'character:cfg_a' &&
      read.binding.quoteId === q.quoteId &&
      read.binding.units === 1 && read.binding.grantQuantity === 100 &&
      Object.isFrozen(read.binding);
  })());

check('C7 ★ 直接改库里的 amount_minor 会让 integrity check 发现"指纹不再描述那些事实"'
  + '（绑定是可验证的，而不是靠写入方自律）',
  (() => {
    const dir = tmpDir('tamper');
    const w = world({ dataDir: dir });
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const clean = w.store._internal.economyIntegrityCheck();
    /* 用一个独立的 sqlite 连接改那一行（模拟"有人手工改过库"）。 */
    const sqlite = require('node:sqlite');
    w.store.close();
    const db = new sqlite.DatabaseSync(path.join(dir, 'home-node.db'));
    db.exec("UPDATE economy_approvals SET amount_minor = 999 WHERE approval_id = '" + out.approvalId + "'");
    db.close();
    const reopened = makeStore({ dataDir: dir });
    reopened.open();
    const problems = reopened._internal.economyIntegrityCheck();
    return clean.length === 0 &&
      problems.some(p => /binding-fingerprint-does-not-describe-the-bound-facts/.test(p)) &&
      problems.length > 0;
  })());

/* ══════════════════════════════════════════════════════════════════
   D · §8 一次性消费
   ══════════════════════════════════════════════════════════════════ */
section('D · §8 一次性消费：一个批准最多一笔购买');

check('D1 ★★ 走完 APPROVED → prepare → settle 之后，批准变成 CONSUMED 并指向那笔购买',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q.quoteId, { approvalId: out.approvalId });
    /* ★ 在 prepare 之后批准**仍然**是 APPROVED —— 消费发生在结算事务里。 */
    const mid = w.store.getApproval({ approvalId: out.approvalId }).approval;
    const settled = w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const after = w.store.getApproval({ approvalId: out.approvalId }).approval;
    /* ★ 成功路径的返回是 `{ok, replayed, idempotencyKey, result}`（P22-6 的
       冻结形状），因此这里读 `settled.result`。 */
    const auth = settled.result && settled.result.authorization;
    return mid.status === 'APPROVED' && mid.consumedByPurchaseId === null &&
      settled.ok === true && settled.replayed === false &&
      settled.result.purchaseStatus === 'COMPLETED' &&
      auth != null &&
      auth.mode === 'APPROVAL' && auth.approvalConsumedHere === true &&
      auth.consumedByPurchaseId === prep.purchaseId &&
      auth.approvalStatusAfter === 'CONSUMED' &&
      auth.approvedBy === 'user:user' &&
      auth.autonomous === false && auth.requiredUserApproval === true &&
      auth.oneApprovalAtMostOnePurchase === true &&
      auth.budgetWasIndependentlyEvaluated === true &&
      auth.approvalBypassedBudget === false &&
      after.status === 'CONSUMED' && after.consumedByPurchaseId === prep.purchaseId &&
      typeof after.consumedAt === 'number' && after.terminal === true &&
      w.store.health().counts.consumedApprovals === 1;
  })());

check('D2 ★★ 一个批准不可能消费两次：同一笔购买重放结算返回**回放**，不会第二次扣款',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q.quoteId, { approvalId: out.approvalId });
    const key = nextKey('s');
    const first = w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: key });
    const balanceAfterFirst = w.store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet.balanceMinor;
    const replay = w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: key });
    const balanceAfterReplay = w.store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).wallet.balanceMinor;
    return first.ok === true && replay.ok === true && replay.replayed === true &&
      replay.result.purchaseId === first.result.purchaseId &&
      String(balanceAfterFirst) === String(balanceAfterReplay) &&
      w.store.health().counts.transactions === 2 /* 只有一次 MINT + 一次购买 */ &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_CONSUMED').length === 1;
  })());

check('D2b 用**另一个** key 再结算同一笔购买 ⇒ 终态拒绝（不是第二次扣款）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q.quoteId, { approvalId: out.approvalId });
    w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const txs = w.store.health().counts.transactions;
    const again = w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    return again.ok === false && again.denied === true && again.terminal === true &&
      again.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
      w.store.health().counts.transactions === txs &&
      w.store.health().counts.completedPurchases === 1;
  })());

check('D3 ★★ 已消费的批准不能再授权任何东西（APPROVAL_NOT_CONSUMED / TRANSITION_NOT_ALLOWED，且不创建购买）',
  (() => {
    const w = world();
    const q1 = quote(w.store, w.productId);
    const out = requestApproval(w.store, q1.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q1.quoteId, { approvalId: out.approvalId });
    w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const purchasesBefore = w.store.health().counts.purchases;
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q1.quoteId, units: 1,
      idempotencyKey: nextKey('auth'), approvalId: out.approvalId
    });
    return gate.ok === false && gate.denied === true && gate.terminal === true &&
      gate.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
      gate.approvalStatus === 'CONSUMED' &&
      gate.approvalId === out.approvalId &&
      w.store.health().counts.purchases === purchasesBefore;
  })());

check('D4 ★ 一条已消费的批准被记进 integrity：那笔已完成的购买必须**恰好**消费了它',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q.quoteId, { approvalId: out.approvalId });
    const beforeSettle = w.store._internal.economyIntegrityCheck();
    w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const afterSettle = w.store._internal.economyIntegrityCheck();
    return beforeSettle.length === 0 && afterSettle.length === 0;
  })());

check('D5 ★★ 直接改库把 CONSUMED 改回 APPROVED 会被 integrity 抓出来'
  + '（"一次性"不只是写入方的自律）',
  (() => {
    const dir = tmpDir('regress');
    const w = world({ dataDir: dir });
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q.quoteId, { approvalId: out.approvalId });
    w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    w.store.close();
    const sqlite = require('node:sqlite');
    const db = new sqlite.DatabaseSync(path.join(dir, 'home-node.db'));
    db.exec("UPDATE economy_approvals SET status = 'APPROVED', consumed_by_purchase_id = NULL, consumed_at = NULL WHERE approval_id = '" + out.approvalId + "'");
    db.close();
    const reopened = makeStore({ dataDir: dir });
    reopened.open();
    const problems = reopened._internal.economyIntegrityCheck();
    return problems.some(p => /completed-purchase-whose-approval-is-not-consumed/.test(p)) ||
      problems.some(p => /completed-approval-authorised-purchase-did-not-consume-its-approval/.test(p)) ||
      problems.some(p => /consumed-approval-has-no-consuming-purchase/.test(p));
  })());

check('D6 APPROVAL_CONSUMED 事件的 payload 逐字写着"一个批准最多一笔购买"与那笔购买的 id',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q.quoteId, { approvalId: out.approvalId });
    w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const ev = w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_CONSUMED');
    return ev.length === 1 && ev[0].entityId === out.approvalId &&
      ev[0].payload.consumedByPurchaseId === prep.purchaseId &&
      ev[0].payload.fromStatus === 'APPROVED' &&
      ev[0].payload.approvalStatus === 'CONSUMED' &&
      ev[0].payload.oneApprovalAtMostOnePurchase === true &&
      ev[0].payload.ledgerMutation === false;
  })());

/* ══════════════════════════════════════════════════════════════════
   E · §7 快照：批准针对 Quote
   ══════════════════════════════════════════════════════════════════ */
section('E · §7 快照：批准针对 Quote，而不是 mutable Product');

check('E1 ★★ 商品改价之后，**旧报价**逐字未变（P22-5 的冻结性质），'
  + '而 P22-6 目前**不**允许用一份在改价之前创建的报价去结算（已记录的既有缺陷）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const repriced = w.store.putProduct({
      productId: w.productId, storeId: w.storeId, name: 'Compute pack',
      kind: 'COMPUTE_CREDIT', unitPriceMinor: 150, currency: 'IB_CREDIT',
      grantQuantity: 100, unitName: 'computeUnit', status: 'ACTIVE',
      idempotencyKey: nextKey('pr-reprice')
    });
    assert.equal(repriced.ok, true, J(repriced.errors || repriced));
    const oldQuote = w.store.getQuote({ quoteId: q.quoteId }).quote;
    const prep = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    const after = w.store.getApproval({ approvalId: out.approvalId }).approval;
    /* ── 这一段记录的是一个**既有缺陷**，不是本阶段的设计 ────────────────
       P22-5 冻结的性质是"Product 行是 provenance，不是有效性依赖"，
       而且 P22-6 在自己那份 prepare 的注释里逐字写着"一份在商品还 ACTIVE
       时创建的报价，在商品 RETIRED 之后依然可以被买到它那一刻表达的价格
       与交付"。但 P22-6 的实现同时还要求

         productQuoteAmountMinor(当前 Product 行, units) === quote.amount_minor

       于是**任何一次改价**都会让改价之前创建的每一份报价变得无法使用。
       这不是 P22-7 引入的，也不属于本阶段可以单方面改动的面（P22-6 是冻结
       输入），因此这里的断言是**如实记录现状**，而不是把它说成期望行为：
         · Q1 的金额仍然是 100（P22-5 的冻结性质成立）；
         · 用 Q1 去 prepare 目前会被 QUOTE_MISMATCH 拒绝；
         · 那条批准因此**原封不动**（没有被消费、也没有被烧掉）。
       修复它需要改 P22-6 的 prepare（把金额判据从"当前价"改成"报价快照"），
       那是一次对冻结阶段的改动 —— 留给后续阶段决定。 */
    return oldQuote.amountMinor === 100n &&
      String(oldQuote.amountMinor) === '100' &&
      String(w.store.getProduct({ productId: w.productId }).product.unitPriceMinor) === '150' &&
      prep.ok === false && prep.denied === true &&
      prep.reasonCode === C.DENY_REASON.QUOTE_MISMATCH &&
      prep.errors.indexOf('purchase-amount-must-equal-the-quote-snapshot') >= 0 &&
      /* 批准没有被消费，也没有被烧掉：它仍然 APPROVED 且未被指向任何购买。 */
      after.status === 'APPROVED' && after.consumedByPurchaseId === null &&
      w.store.health().counts.purchases === 0 &&
      w.store.health().counts.reservations === 0 &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_CONSUMED').length === 0;
  })());

check('E2 ★★ 重新生成的报价（150）必须重新走授权：那张旧批准对它一律 APPROVAL_MISMATCH',
  (() => {
    const w = world();
    const q1 = quote(w.store, w.productId);
    const out = requestApproval(w.store, q1.quoteId);
    approve(w.store, out.approvalId);
    w.store.putProduct({
      productId: w.productId, storeId: w.storeId, name: 'Compute pack',
      kind: 'COMPUTE_CREDIT', unitPriceMinor: 150, currency: 'IB_CREDIT',
      grantQuantity: 100, unitName: 'computeUnit', status: 'ACTIVE',
      idempotencyKey: nextKey('pr-reprice2')
    });
    const q2 = quote(w.store, w.productId);
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q2.quoteId, units: 1,
      idempotencyKey: nextKey('auth'), approvalId: out.approvalId
    });
    const prep = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q2.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    return gate.ok === false && gate.denied === true &&
      gate.reasonCode === C.DENY_REASON.APPROVAL_MISMATCH &&
      gate.mismatchedFields.indexOf('amountMinor') >= 0 &&
      prep.ok === false && prep.reasonCode === C.DENY_REASON.APPROVAL_MISMATCH &&
      w.store.health().counts.purchases === 0 &&
      /* 那张旧批准一个字都没被改（它的内容不可变）。 */
      w.store.getApproval({ approvalId: out.approvalId }).approval.amountMinor === '100';
  })());

check('E3 批准的金额来自 **Quote 快照**而不是 Product 当前价（"批准的是那一刻的价格"）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const read = w.store.getApproval({ approvalId: out.approvalId }).approval;
    /* 报价 100、商品 100；两者一致，但批准的来源必须是 Quote。 */
    return read.amountMinor === '100' && read.binding.amountMinor === 100n && read.quoteId === q.quoteId &&
      read.productId === w.productId &&
      /* 一条批准**不带**任何"当前价格"字段 —— 它只有一个快照金额。 */
      read.binding.amountMinor === 100n &&
      C.APPROVAL_BINDING_KEYS.indexOf('unitPriceMinor') < 0;
  })());

/* ══════════════════════════════════════════════════════════════════
   F · §10/§11 与 P22-6 的接入
   ══════════════════════════════════════════════════════════════════ */
section('F · §10/§11 授权闸门与"批准不是预算豁免"');

check('F1 ★★ 有效批准 ⇒ 闸门放行（mode=APPROVAL, proceedToPrepare=true），'
  + '而它仍然明写"预算与报价有效性还要各自过一遍"',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      idempotencyKey: nextKey('auth'), approvalId: out.approvalId
    });
    return gate.ok === true && gate.allowed === true && gate.denied === false &&
      gate.mode === C.PURCHASE_APPROVAL_MODE.APPROVAL &&
      gate.approvalMode === C.PURCHASE_APPROVAL_MODE.APPROVAL &&
      gate.proceedToPrepare === true && gate.approvalRequired === false &&
      gate.approvalBypassesBudget === false && gate.approvalBypassesQuoteExpiry === false &&
      typeof gate.note === 'string' && /budget and quote validity/.test(gate.note) &&
      /* 闸门自己不创建购买、不锁钱（§5）。 */
      gate.purchaseCreated === false && gate.fundsReserved === false &&
      w.store.health().counts.purchases === 0;
  })());

check('F2 ★★ §11 批准**不是**预算豁免：批准有效但预算 DENY ⇒ 不扣钱、不发货',
  (() => {
    const w = world({ budgetLimits: { perTransactionMinor: 50 } });
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    const after = w.store.getApproval({ approvalId: out.approvalId }).approval;
    return prep.ok === false && prep.denied === true &&
      prep.reasonCode === C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION &&
      w.store.health().counts.purchases === 0 &&
      w.store.health().counts.transactions === 1 /* 只有 MINT */ &&
      w.store.health().counts.reservations === 0 &&
      /* ★ 批准**原封不动** —— 预算拒绝没有烧掉它（它可以重试）。 */
      after.status === 'APPROVED' && after.consumedByPurchaseId === null;
  })());

check('F3 ★★ 结算时预算变成 DENY ⇒ 整个结算回滚，批准回到 APPROVED（不扣钱、不消费批准）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q.quoteId, { approvalId: out.approvalId });
    /* prepare 之后把预算收紧到这笔钱不允许（模拟"另一个 writer 改了规则"）。 */
    budgetPolicy(w.store, 'cfg_a', { perTransactionMinor: 50 });
    const settled = w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const after = w.store.getApproval({ approvalId: out.approvalId }).approval;
    const purchase = w.store.getPurchase({ purchaseId: prep.purchaseId }).purchase;
    return settled.ok === false && settled.denied === true && settled.terminal === true &&
      settled.reasonCode === C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION &&
      settled.ledgerMutation === false && settled.inventoryMutation === false &&
      purchase.status === 'FAILED' &&
      after.status === 'APPROVED' && after.consumedByPurchaseId === null &&
      w.store.health().counts.transactions === 1 &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_CONSUMED').length === 0;
  })());

check('F4 ★ 已过期的报价不能被一张有效批准救回来（批准不能绕过 Quote expiration）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId, { expiresAt: CLOCK + 60000 });
    const out = requestApproval(w.store, q.quoteId, { approvalExpiresAt: CLOCK + 60000 });
    approve(w.store, out.approvalId);
    CLOCK_NOW = CLOCK + 120000;
    const prep = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    return prep.ok === false && prep.denied === true &&
      prep.reasonCode === C.DENY_REASON.QUOTE_EXPIRED &&
      w.store.health().counts.purchases === 0;
  })());

check('F5 ★ 一条**过期**的批准不能授权购买（APPROVAL_EXPIRED，且闸门给出 sweepRequired）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId, { approvalExpiresAt: CLOCK + 60000 });
    approve(w.store, out.approvalId);
    CLOCK_NOW = CLOCK + 120000;
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      idempotencyKey: nextKey('auth'), approvalId: out.approvalId
    });
    const prep = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    return gate.ok === false && gate.denied === true &&
      gate.reasonCode === C.DENY_REASON.APPROVAL_EXPIRED &&
      gate.sweepRequired === true &&
      prep.ok === false && prep.denied === true &&
      prep.reasonCode === C.DENY_REASON.APPROVAL_EXPIRED &&
      w.store.health().counts.purchases === 0;
  })());

check('F6 ★ 一条**待决定**的批准不能授权购买（APPROVAL_REQUIRED）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      idempotencyKey: nextKey('auth'), approvalId: out.approvalId
    });
    const prep = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: out.approvalId, idempotencyKey: nextKey('p')
    });
    return gate.ok === false && gate.denied === true &&
      gate.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
      gate.approvalStatus === 'PENDING' && gate.approvalRequired === true &&
      prep.ok === false && prep.denied === true &&
      prep.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
      w.store.health().counts.purchases === 0;
  })());

check('F7 一个不存在的 approvalId ⇒ APPROVAL_NOT_FOUND（与"这张批准说的事不对"是两个答案）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      idempotencyKey: nextKey('auth'), approvalId: 'econ_approval_ghost'
    });
    const prep = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: 'econ_approval_ghost', idempotencyKey: nextKey('p')
    });
    const notId = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      expiresAt: CLOCK + 1800000, approvalId: 'econ_intent_ghost', idempotencyKey: nextKey('p')
    });
    return gate.ok === false && gate.reasonCode === C.DENY_REASON.APPROVAL_NOT_FOUND &&
      prep.ok === false && prep.reasonCode === C.DENY_REASON.APPROVAL_NOT_FOUND &&
      notId.ok === false && notId.denied === false &&
      notId.errors.indexOf('approval-id-not-canonical') >= 0;
  })());

check('F8 ★★ DENY 的自主结论**不创建任何记录**（"被规则排除"不该被伪装成"等待中"）',
  (() => {
    const w = world();
    /* ★ 策略的形状不变量：approvalAbove ≤ perPurchase ≤ daily。
       因此这笔 100 的购买同时越过单笔上限（50）与日上限（80）⇒ 额度 DENY。 */
    autonomyPolicy(w.store, { perPurchaseLimitMinor: 50, dailyAutonomousLimitMinor: 80, approvalAboveMinor: 50 });
    const q = quote(w.store, w.productId);
    const out = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      idempotencyKey: nextKey('auth'), approvalExpiresAt: CLOCK + 600000
    });
    const gate2 = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q.quoteId, units: 1,
      idempotencyKey: nextKey('auth'), approvalExpiresAt: CLOCK + 600000
    });
    return out.ok === false && out.denied === true && out.terminal === false &&
      out.reasonCode === C.DENY_REASON.AUTONOMY_LIMIT &&
      out.approvalCreated === false && out.approvalId === null &&
      out.proceedToPrepare === false &&
      w.store.health().counts.approvals === 0 &&
      w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_REQUESTED').length === 0 &&
      gate2.reasonCode === C.DENY_REASON.AUTONOMY_LIMIT;
  })());

check('F9 ★★ AUTO_ALLOW 的自主购买可以被 P22-6 记录：把闸门给的三个值交给 prepare，'
  + '购买行上逐字写着"自主放行"与是哪条策略',
  (() => {
    const w = world();
    const policy = autonomyPolicy(w.store, {
      perPurchaseLimitMinor: 500, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 500
    });
    const q = quote(w.store, w.productId);
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q.quoteId, units: 1, idempotencyKey: nextKey('auth')
    });
    assert.equal(gate.ok, true, 'the gate must allow: ' + J(gate));
    const prep = prepareOk(w.store, q.quoteId, Object.assign({}, gate.prepareInput));
    const settled = w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const read = w.store.getPurchase({ purchaseId: prep.purchaseId }).purchase;
    return gate.mode === C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW &&
      gate.proceedToPrepare === true && gate.approvalId === null &&
      typeof gate.approvalBindingFingerprint === 'string' &&
      prep.authorization.mode === 'AUTO_ALLOW' &&
      prep.authorization.autonomyPolicyId === policy.policyId &&
      settled.ok === true &&
      settled.result.authorization.mode === 'AUTO_ALLOW' &&
      settled.result.authorization.autonomous === true &&
      settled.result.authorization.requiredUserApproval === false &&
      settled.result.authorization.approvalConsumedHere === false &&
      read.autonomous === true && read.requiredUserApproval === false &&
      read.approvalId === null && read.autonomyPolicyId === policy.policyId &&
      read.approval === null &&
      /* 自主购买**不**消费任何批准。 */
      w.store.health().counts.approvals === 0 &&
      w.store.health().counts.consumedApprovals === 0;
  })());

check('F10 ★★ 自主放行的凭据也**不可挪用**：把 A 笔的指纹交给 B 笔 ⇒ APPROVAL_MISMATCH',
  (() => {
    const w = world();
    autonomyPolicy(w.store, {
      perPurchaseLimitMinor: 500, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 500
    });
    const q1 = quote(w.store, w.productId);
    const q2 = quote(w.store, w.productId);
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q1.quoteId, units: 1, idempotencyKey: nextKey('auth')
    });
    const wrong = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q2.quoteId, units: 1, expiresAt: CLOCK + 1800000,
      approvalBindingFingerprint: gate.approvalBindingFingerprint,
      autonomyPolicyId: gate.autonomyPolicyId, idempotencyKey: nextKey('p')
    });
    const okOne = w.store.preparePurchase(Object.assign({
      buyerId: BUYER, quoteId: q1.quoteId, units: 1, expiresAt: CLOCK + 1800000,
      idempotencyKey: nextKey('p')
    }, gate.prepareInput));
    return wrong.ok === false && wrong.denied === true &&
      wrong.reasonCode === C.DENY_REASON.APPROVAL_MISMATCH &&
      /autonomous-approval-fingerprint/.test(wrong.errors[0]) &&
      okOne.ok === true;
  })());

check('F11 ★ 两种授权证据**互斥**：同时给 approvalId 与自主指纹 ⇒ 拒绝（一次不能回答的声明）',
  (() => {
    const w = world();
    autonomyPolicy(w.store);
    const q1 = quote(w.store, w.productId);
    const gate = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q1.quoteId, units: 1, idempotencyKey: nextKey('auth')
    });
    /* ★ 闸门在 AUTO_ALLOW 那条路上**不创建**批准（§10：那条路上没有人需要
       点头 —— F8 逐字断言过那件事）。因此这里显式地创建一条**属于同一份
       报价**的批准，好让两种证据同时存在。否则 `gate.approvalId` 是 null，
       而"两项都给了"这句话根本不成立 —— 那样这一条会退化成一条
       **永远通过**的断言（一个 null 的 approvalId 会被当成"没给批准"）。 */
    const req = w.store.createApprovalRequest({
      buyerId: BUYER, quoteId: q1.quoteId, units: 1,
      expiresAt: CLOCK + 600000, idempotencyKey: nextKey('req')
    });
    assert.equal(req.ok, true, 'createApprovalRequest must succeed: ' + J(req.errors || req));
    approve(w.store, req.result.approvalId);
    const both = w.store.preparePurchase({
      buyerId: BUYER, quoteId: q1.quoteId, units: 1, expiresAt: CLOCK + 1800000,
      /* ★ 两种证据都指**同一份报价**：这正是"我既说这张批准可以，又说我是
         自主放行的"那种声明。互斥检查排在所有其它校验之前，因此它不能被
         "这张批准说的事不对"或"这份报价已经用掉了"抢先 —— 那会让一次
         **无法回答的声明**被伪装成一条更具体的拒绝。 */
      approvalId: req.result.approvalId,
      approvalBindingFingerprint: gate.approvalBindingFingerprint,
      autonomyPolicyId: gate.autonomyPolicyId, idempotencyKey: nextKey('p')
    });
    return both.ok === false && both.denied === true &&
      both.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
      both.errors.indexOf('an-autonomous-fingerprint-and-an-approval-are-mutually-exclusive') >= 0 &&
      /* 拒绝之后什么都没发生：没有购买、没有预留。 */
      w.store.health().counts.purchases === 0 &&
      w.store.health().counts.reservations === 0 &&
      /* 而那条被拒的批准仍然 APPROVED —— 这次拒绝没有动它。 */
      w.store.getApproval({ approvalId: req.result.approvalId }).approval.status === 'APPROVED';
  })());

check('F12 ★ 自主政策在 prepare 与 settle 之间被关掉，**已经准备**的自主购买仍然可以结算'
  + '（授权事实在 prepare 时被冻在购买行上，逐字记录"当初凭什么成立"）',
  (() => {
    const w = world();
    const policy = autonomyPolicy(w.store, { perPurchaseLimitMinor: 500, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 500 });
    const q = quote(w.store, w.productId);
    const gate = w.store.authorizePurchaseIntent({ buyerId: BUYER, quoteId: q.quoteId, units: 1, idempotencyKey: nextKey('auth') });
    const prep = prepareOk(w.store, q.quoteId, Object.assign({}, gate.prepareInput));
    /* 关掉策略 —— 这一笔**已经**拿到了自主授权（钱也锁住了）。 */
    autonomyPolicy(w.store, { enabled: false });
    const afterPolicyChange = w.store.authorizePurchaseIntent({ buyerId: BUYER, quoteId: q.quoteId, units: 1, idempotencyKey: nextKey('auth') });
    const settled = w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const read = w.store.getPurchase({ purchaseId: prep.purchaseId }).purchase;
    return settled.ok === true && settled.result.purchaseStatus === 'COMPLETED' &&
      read.autonomyPolicyId === policy.policyId && read.autonomous === true &&
      /* ★ 但**新的**请求立刻被拒 —— 关掉策略对之后的判定立刻生效。 */
      afterPolicyChange.ok === false && afterPolicyChange.denied === true &&
      afterPolicyChange.reasonCode === C.DENY_REASON.AUTONOMY_NOT_PERMITTED;
  })());

/* ══════════════════════════════════════════════════════════════════
   G · §16 审计
   ══════════════════════════════════════════════════════════════════ */
section('G · §16 审计：仅凭 canonical facts 回答四个问题');

check('G1 ★★ 问："为什么这笔购买没问用户？" ⇒ 答：`purchases.autonomy_policy_id` 指向那条 AUTO_ALLOW 的策略',
  (() => {
    const w = world();
    const policy = autonomyPolicy(w.store, { perPurchaseLimitMinor: 500, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 500 });
    const q = quote(w.store, w.productId);
    const gate = w.store.authorizePurchaseIntent({ buyerId: BUYER, quoteId: q.quoteId, units: 1, idempotencyKey: nextKey('auth') });
    const prep = prepareOk(w.store, q.quoteId, Object.assign({}, gate.prepareInput));
    w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const summary = w.store.getPurchase({ purchaseId: prep.purchaseId }).authorizationSummary;
    const policyRead = w.store.getAutonomyPolicy({ policyId: summary.autonomyPolicyId });
    return summary.mode === 'AUTO_ALLOW' && summary.autonomous === true &&
      summary.gatedByP22_7 === true && summary.approvalId === null &&
      policyRead.ok === true && policyRead.policy.policyId === policy.policyId &&
      policyRead.policy.enabled === true &&
      policyRead.policy.perPurchaseLimitMinor === 500n &&
      policyRead.policy.allowedProductKinds.indexOf('COMPUTE_CREDIT') >= 0;
  })());

check('G2 ★★ 问："为什么这笔要求批准？" ⇒ 答：批准记录的 `autonomyOutcome` + `autonomyReasonCode` + 该策略的形状',
  (() => {
    const w = world();
    /* 审批线 100，金额 100（恰好不越过），而金额 101 会越线 —— 用 200。 */
    autonomyPolicy(w.store, {
      perPurchaseLimitMinor: 500, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 100
    });
    const q = quote(w.store, w.productId, { units: 2 });
    const out = w.store.authorizePurchaseIntent({
      buyerId: BUYER, quoteId: q.quoteId, units: 2,
      idempotencyKey: nextKey('auth'), approvalExpiresAt: CLOCK + 600000
    });
    const read = w.store.getApproval({ approvalId: out.approvalId }).approval;
    const ev = w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_REQUESTED')[0];
    return out.autonomyOutcome === C.AP_DECISION.REQUIRE_APPROVAL &&
      out.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
      out.autonomyRule === 'amount-exceeds-the-autonomy-approval-threshold' &&
      read.autonomyOutcome === 'REQUIRE_APPROVAL' &&
      read.autonomyReasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
      read.autonomyPolicyId === out.autonomyPolicyId &&
      /* 理由链完整：策略存在 → 它的审批线是 100 → 金额 200 越线。 */
      w.store.getAutonomyPolicy({ policyId: out.autonomyPolicyId }).policy.approvalAboveMinor === 100n &&
      read.amountMinor === '200' &&
      ev.payload.autonomyOutcome === 'REQUIRE_APPROVAL' &&
      ev.payload.autonomyPolicyId === out.autonomyPolicyId;
  })());

check('G3 ★★ 问："是谁批准的什么？" ⇒ 答：批准行上的 **snapshot**（九元组 + 决定者 + 时间）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const read = w.store.getApproval({ approvalId: out.approvalId }).approval;
    const ev = w.store.listChanges(0, 500).filter(c => c.kind === 'APPROVAL_APPROVED')[0];
    return read.decidedBy === 'user:user' && read.decidedByRef.type === 'user' &&
      typeof read.decidedAt === 'number' && read.status === 'APPROVED' &&
      read.buyerId === 'character:cfg_a' && read.recipientId === null &&
      read.productId === w.productId && read.quoteId === q.quoteId &&
      read.currency === 'IB_CREDIT' && read.amountMinor === '100' &&
      read.settlementType === 'COMPUTE_GRANT' && read.grantQuantity === 100 && read.units === 1 &&
      read.bindingFingerprint.length > 0 &&
      ev.payload.decidedBy === 'user:user' &&
      typeof ev.payload.bindingFingerprint === 'string';
  })());

check('G4 ★★ 问："这个批准最终被哪笔 Purchase 消费？" ⇒ 答：批准行 ↔ 购买行的**双向**链接',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q.quoteId, { approvalId: out.approvalId });
    w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const approvalSide = w.store.getApproval({ approvalId: out.approvalId }).approval;
    const summary = w.store.getPurchase({ purchaseId: prep.purchaseId }).authorizationSummary;
    const purchaseSide = w.store.getPurchase({ purchaseId: prep.purchaseId }).purchase;
    return approvalSide.consumedByPurchaseId === prep.purchaseId &&
      summary.approvalId === out.approvalId &&
      summary.approvalConsumedByThisPurchase === true &&
      summary.approvedBy === 'user:user' &&
      summary.approvalBindingFingerprint === approvalSide.bindingFingerprint &&
      purchaseSide.approvalId === out.approvalId &&
      purchaseSide.requiredUserApproval === true &&
      purchaseSide.approval.status === 'CONSUMED' &&
      purchaseSide.approval.consumedByPurchaseId === prep.purchaseId &&
      /* 两句话逐字写在读面上：购买不是批准，批准也不是购买、不是预算豁免。 */
      purchaseSide.isAnApproval === false && purchaseSide.grantsAutonomy === false &&
      purchaseSide.grantsBudget === false &&
      approvalSide.isAPurchase === false && approvalSide.isBudgetAuthority === false &&
      approvalSide.singleUse === true && approvalSide.bypassesBudget === false &&
      approvalSide.bypassesQuoteExpiry === false &&
      summary.approvalBypassesBudget === false && summary.budgetSeparatelyEvaluated === true &&
      summary.oneApprovalAtMostOnePurchase === true;
  })());

check('G5 ★ change log 里四类事件都在（policy created/updated、requested、approved、consumed），'
  + '而**没有**任何一条写着 memory / relationship / provider 的改动',
  (() => {
    const w = world();
    /* ★ 这个世界的购买额是 100（报价 = 单价 × 1），因此"这条策略要批准"
       意味着审批线必须**低于** 100 —— 三条序关系
       （approvalAbove ≤ perPurchase ≤ daily）在**每一次**写入上都成立。
       第一次写入故意给一条宽松的规则（500/1000/500），第二次把它收紧成
       "100 以上要问人"：于是同一条策略经历了 CREATE 与 UPDATE 两次事件。 */
    autonomyPolicy(w.store, {
      perPurchaseLimitMinor: 500, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 500
    });
    /* ★ 两次写入必须用**不同**的幂等键：同一个 key + 不同内容会被判成幂等
       冲突（A5 逐字断言了那件事），而这里要的是**真的改了一次规则**。 */
    autonomyPolicy(w.store, {
      perPurchaseLimitMinor: 150, dailyAutonomousLimitMinor: 1000, approvalAboveMinor: 99,
      idempotencyKey: nextKey('ap-update')
    });
    const q1 = quote(w.store, w.productId);
    const out = requestApproval(w.store, q1.quoteId);
    assert.equal(out.autonomyOutcome, C.AP_DECISION.REQUIRE_APPROVAL,
      '这条 100 的购买必须落在收紧之后的审批线之外: ' + J(out));
    approve(w.store, out.approvalId);
    const prep = prepareOk(w.store, q1.quoteId, { approvalId: out.approvalId });
    w.store.settlePurchase({ purchaseId: prep.purchaseId, idempotencyKey: nextKey('s') });
    const kinds = w.store.listChanges(0, 500).map(c => c.kind);
    const authChanges = w.store.listChanges(0, 500).filter(c =>
      /APPROVAL|AUTONOMY|PURCHASE/.test(c.kind));
    return kinds.indexOf('AUTONOMY_POLICY_CREATED') >= 0 &&
      kinds.indexOf('AUTONOMY_POLICY_UPDATED') >= 0 &&
      kinds.indexOf('APPROVAL_REQUESTED') >= 0 &&
      kinds.indexOf('APPROVAL_APPROVED') >= 0 &&
      kinds.indexOf('APPROVAL_CONSUMED') >= 0 &&
      kinds.indexOf('PURCHASE_AUTHORIZED') < 0 /* 词表里没有它：授权由 APPROVAL_* 与 PURCHASE_CREATED 分别表达 */ &&
      authChanges.length >= 5 &&
      /* ★ 这一条刻意**只**对 P22-7 的事件断言那四句否认。P22-6 的
         PURCHASE_CREATED / PURCHASE_RESERVED **不带** providerMutation /
         paymentMutation / memoryMutation / relationshipMutation 四个字段，
         而"缺字段"与"字段为 false"在读侧必须可分：对它们写
         `p.memoryMutation !== true` 是一条**永远通过**的断言（undefined
         !== true），写 `=== false` 则会让这一条去断言 P22-6 的形状。
         两种写法都不会失败得有意义，因此这里把范围收紧到本阶段的事件。 */
      (() => {
        const p22_7 = authChanges.filter(c =>
          c.kind.indexOf('APPROVAL_') === 0 || c.kind.indexOf('AUTONOMY_') === 0);
        return p22_7.length >= 4 && p22_7.every(c =>
          c.payload.providerMutation === false && c.payload.paymentMutation === false &&
          c.payload.memoryMutation === false && c.payload.relationshipMutation === false);
      })() &&
      /* 所有事件都带 domain，且**没有**正文类字段。 */
      authChanges.every(c => c.payload.domain === C.DOMAIN) &&
      authChanges.every(c => {
        /* ★ 逐字比对**键名**，而不是对拼起来的字符串跑正则：
           'AUTONOMY_POLICY_CREATED' 里含有子串 "approval"？不 —— 但它含有
           "autonomy"，而一个粗糙的 /approval|memory|trust/ 会误判。
           键名比对没有这个问题。 */
        const keys = Object.keys(c.payload);
        return keys.every(k => !/^(prompt|persona|personality|relationship|affection|affinity|trust|memory|memoryRef|llmOutput|content|text|message|messages)$/i.test(k));
      });
  })());

check('G6 ★ 一条**没有被决定**的批准不留下任何"决定"痕迹（审计不能凭空多出一个批准人）',
  (() => {
    const w = world();
    const q = quote(w.store, w.productId);
    const out = requestApproval(w.store, q.quoteId);
    const read = w.store.getApproval({ approvalId: out.approvalId }).approval;
    const ev = w.store.listChanges(0, 500);
    return read.decidedBy === null && read.decidedAt === null &&
      read.consumedByPurchaseId === null && read.consumedAt === null &&
      ev.filter(c => /APPROVAL_APPROVED|APPROVAL_REJECTED|APPROVAL_EXPIRED|APPROVAL_CONSUMED/.test(c.kind)).length === 0;
  })());

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('');
if (failures === 0) console.log('P22-7 approval: 全部通过 ✔');
else console.error('P22-7 approval: ' + failures + ' 项失败 ✘');
process.exitCode = failures === 0 ? 0 : 1;
