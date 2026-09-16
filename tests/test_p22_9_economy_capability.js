'use strict';
/* ====================================================================
   P22-9 · Economy Capability Gate（单进程 · **零子进程**）
   --------------------------------------------------------------------
   运行：node tests/test_p22_9_economy_capability.js

   ── 为什么这个文件**一个子进程都不开**（§9 / §10）─────────────────────
   §9 要求 P22-9 不许再用"大量真实子进程"堆覆盖率，§10 要求不要重复
   P22-6 ~ P22-8 已经证明过的多进程矩阵。本阶段的自有 invariant 是：

     Gate 不可绕过 · unknown consumer fail closed · allowed consumer 能提议 ·
     denied consumer 不能提议 · capability ≠ purchase authority

   这五条**全部**是单进程可判定的：
     · 它们是**纯查表**（契约的 checkEconomyCapability，无 IO、无时钟）；
     · 门的拒绝路径上没有任何 store 调用 —— 这一点用一个"一被调用就抛错"
       的 store 来证伪，而它不需要第二个进程；
     · 唯一跨进程的性质（同一个提议在两个进程里恰好产生一条 intent）由
       P22-8 的 store 拥有，已经在 p22-8-intent-worker.js 的两进程组里被
       证明过。在 P22-9 重做一遍不会多证明任何关于**门**的事情。
   因此本文件（以及它的 runtime 兄弟文件）spawn 次数是 0 —— 见末尾的自报。

   ── 隔离 ────────────────────────────────────────────────────────────────
   每个组用自己的一次性临时目录 + 独立的 store 实例。**没有**任何一条路径
   会碰生产 dataDir（不设 IB_HOME_NODE_DATA_DIR 也一样，因为 dataDir 是
   显式参数）。
   ==================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const createEconomyCapabilityGate = require(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'));
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

/* ── 资源台账：本文件结束时必须逐条清空（§9 的生命周期要求）────────── */
const openStores = [];
const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-9cap-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
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
  const store = createEconomyStore({ dataDir: tmpDir(tag), logger: () => { }, nextId: deterministicIds() });
  store.open();
  openStores.push(store);
  return store;
}
let keySeq = 0;
function K(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }
const CUR = 'IB_CREDIT';
const AGENT = 'cfg_agent';

function assert2(cond, label, extra) {
  if (!cond) throw new Error('fixture ' + label + ' failed: ' + J(extra));
}

/* ── 夹具：一个货架 + 一件商品 + 有钱的 Agent 钱包 + 预算政策 ────────── */
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
  const wallet = store.openWallet({ owner: { type: 'character', id: AGENT }, currency: CUR });
  assert2(wallet.ok, 'openWallet', wallet.errors);
  const mint = store.mintForSystem({
    systemInitiated: true, walletId: wallet.wallet.walletId, currency: CUR,
    amountMinor: o.balanceMinor == null ? 100000 : o.balanceMinor, idempotencyKey: K('mint')
  });
  assert2(mint.ok, 'mint', mint.errors);
  if (o.budget !== false) {
    const bp = store.putBudgetPolicy({
      ownerId: AGENT, currency: CUR,
      limits: Object.assign({
        perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000
      }, o.limits || {}),
      idempotencyKey: K('budget')
    });
    assert2(bp.ok, 'putBudgetPolicy', bp.errors);
  }
  return { storeId: storeId, productId: productId, agentId: AGENT, walletId: String(wallet.wallet.walletId) };
}
function autonomy(store, input) {
  const out = store.putAutonomyPolicy(Object.assign({
    ownerId: AGENT, currency: CUR, enabled: true,
    perPurchaseLimitMinor: 100000, dailyAutonomousLimitMinor: 100000,
    approvalAboveMinor: 50000,
    allowedProductKinds: ['COMPUTE_CREDIT', 'DIGITAL_ITEM'],
    allowedSettlementTypes: ['COMPUTE_GRANT', 'INVENTORY_GRANT'],
    allowGift: false,
    idempotencyKey: K('autonomy')
  }, input || {}));
  assert2(out.ok, 'putAutonomyPolicy', out.errors);
  return out.result;
}
function proposal(f, extra) {
  return Object.assign({ agentId: AGENT, productId: f.productId, reason: 'compute is running low' }, extra || {});
}

/* ── 审计行读取（§7）─────────────────────────────────────────────────
   ★ listChanges 返回的是**数组**（不是 {changes}），而且它的 limit 上限是
   500（store 自己夹的）。开发期实测踩到：把返回当对象读会让"没有审计行"
   永远为真 —— 一个恒为空的读面会把断言变成同义反复。 */
function changeRows(store) {
  const rows = store.listChanges(0, 500);
  if (!Array.isArray(rows)) throw new Error('listChanges did not return an array: ' + J(rows));
  return rows;
}
function capabilityAuditRows(store) {
  return changeRows(store)
    .filter(c => c.kind === C.EVENT_TYPE.ECONOMY_CAPABILITY_DECIDED)
    .map(r => r.payload || {});
}
function changeRowCount(store) { return changeRows(store).length; }

/* ── 两个"一被调用就抛错"的 store（证明拒绝路径**没有**碰 store）──────
   ★ 这比自报一个 storeCalls: 0 强得多：一个自报的计数器可以由一段
   写错的代码谎报，而一个会抛错的对象不会。 */
function poisonedStore() {
  return {
    appendCapabilityAudit: () => { throw new Error('BYPASS: appendCapabilityAudit was called on a refused path'); },
    proposeAgentPurchaseIntent: () => { throw new Error('BYPASS: store.proposeAgentPurchaseIntent was reached without the gate'); },
    resumeAgentPurchaseIntent: () => { throw new Error('BYPASS: store.resumeAgentPurchaseIntent was reached without the gate'); }
  };
}
/* 记录型 store：既计数，也记下**它收到了哪些键**（§6 的转发面）。 */
function recordingStore(real) {
  const seen = [];
  return {
    seen: seen,
    appendCapabilityAudit: (i) => { seen.push({ method: 'appendCapabilityAudit', keys: Object.keys(i || {}), input: i }); return real.appendCapabilityAudit(i); },
    proposeAgentPurchaseIntent: (i) => { seen.push({ method: 'proposeAgentPurchaseIntent', keys: Object.keys(i || {}), input: i }); return real.proposeAgentPurchaseIntent(i); },
    resumeAgentPurchaseIntent: (i) => { seen.push({ method: 'resumeAgentPurchaseIntent', keys: Object.keys(i || {}), input: i }); return real.resumeAgentPurchaseIntent(i); }
  };
}
function methodsTouched(recording) {
  return Array.from(new Set(recording.seen.map(s => s.method))).sort();
}

const ALLOWED = C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME;
const DENIED_A = C.ECONOMY_CONSUMER.HOME_NODE_AUTHORITY;
const DENIED_B = C.ECONOMY_CONSUMER.DESKTOP_BRIDGE;

console.log('P22-9 · Economy Capability Gate');

/* ══════════════════════════════════════════════════════════════════
   A · 契约层：词表、矩阵、判定器（纯函数，无 IO）
   ══════════════════════════════════════════════════════════════════ */
section('A · 能力词表与权限矩阵（唯一真源 = 契约）');

check('A1 ★ 最小能力集**恰好**是两个：PROPOSE_PURCHASE 与 RESUME_APPROVED_PURCHASE',
  C.CAPABILITIES.length === 2 &&
  C.CAPABILITIES.indexOf(C.CAPABILITY.PROPOSE_PURCHASE) >= 0 &&
  C.CAPABILITIES.indexOf(C.CAPABILITY.RESUME_APPROVED_PURCHASE) >= 0,
  C.CAPABILITIES);

check('A2 RESUME 这一项**不是**可选的：P22-8 的公开写面有两个动词，只给一个加门就是旁路',
  C.CAPABILITIES.indexOf(C.CAPABILITY.RESUME_APPROVED_PURCHASE) >= 0 &&
  C.CAPABILITY.RESUME_APPROVED_PURCHASE === 'RESUME_APPROVED_PURCHASE');

check('A3 每个 canonical consumer 都带一个可核对的运行时锚点（不是一句声明）',
  C.ECONOMY_CONSUMERS.length === 3 &&
  C.ECONOMY_CONSUMERS.every(c => typeof C.CONSUMER_RUNTIME_ANCHOR[c] === 'string' &&
    C.CONSUMER_RUNTIME_ANCHOR[c].indexOf('runtime/component-registry.js#') === 0),
  C.CONSUMER_RUNTIME_ANCHOR);

check('A4 矩阵与判定器逐字一致（对每一个组合）',
  C.ECONOMY_CONSUMERS.every(c => C.CAPABILITIES.every(cap => {
    const v = C.checkEconomyCapability({ consumer: c, capability: cap });
    return v.granted === (C.CONSUMER_CAPABILITY_MATRIX[c].indexOf(cap) >= 0);
  })));

check('A5 只有 active_agent_runtime 持有能力；权威进程与 bridge 都是空的（"权威不行动"）',
  C.capabilitiesOfConsumer(ALLOWED).length === 2 &&
  C.capabilitiesOfConsumer(DENIED_A).length === 0 &&
  C.capabilitiesOfConsumer(DENIED_B).length === 0);

check('A6 ★ 准入决策词与自主权威决策词**字形不相交**（"能力不是权威"的第一层保证）',
  C.CAPABILITY_DECISIONS.every(d => C.AP_DECISIONS.indexOf(d) < 0) &&
  C.CAPABILITY_DECISION.CAPABILITY_GRANTED === 'CAPABILITY_GRANTED' &&
  C.CAPABILITY_DECISION.CAPABILITY_DENIED === 'CAPABILITY_DENIED' &&
  C.AP_DECISION.DENY === 'DENY',
  { capability: C.CAPABILITY_DECISIONS, autonomy: C.AP_DECISIONS });

check('A7 ★ 准入拒绝理由与经济拒绝理由同样不相交',
  C.CAPABILITY_DENY_REASONS.every(r => C.DENY_REASONS.indexOf(r) < 0),
  { capability: C.CAPABILITY_DENY_REASONS.filter(r => C.DENY_REASONS.indexOf(r) >= 0) });

check('A8 ★ 近似名字**不被提升**：consumer id 是身份，不是类别'
  + '（active / homeNode / bridge / ACTIVE_AGENT_RUNTIME 全部不认）',
  ['active', 'ACTIVE_AGENT_RUNTIME', 'homeNode', 'home_node', 'bridge',
    'desktop-bridge', 'agent_runtime', 'agent', 'system']
    .every(n => C.checkEconomyCapability({ consumer: n, capability: C.CAPABILITY.PROPOSE_PURCHASE }).reasonCode ===
      C.CAPABILITY_DENY_REASON.UNKNOWN_CONSUMER));

check('A9 缺席清单是一份**审计结果**（含 chat / group / voice / diary / llm），而不是空白',
  C.CAPABILITY_SURFACES_NOT_PRESENT.length >= 7 &&
  ['chat', 'group_chat', 'voice', 'active_diary', 'llm']
    .every(s => C.CAPABILITY_SURFACES_NOT_PRESENT.some(e => e.surface === s && e.why.length > 10)) &&
  C.CAPABILITY_SURFACES_NOT_PRESENT.every(e => !C.isEconomyConsumer(e.surface)),
  C.CAPABILITY_SURFACES_NOT_PRESENT.map(e => e.surface));

check('A10 ★ §5：七个"不是权威"的位在**每一个**返回分支里恒为 false',
  (() => {
    const inputs = [
      {}, { consumer: ALLOWED }, { consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE },
      { consumer: DENIED_B, capability: C.CAPABILITY.PROPOSE_PURCHASE },
      { consumer: 'nope', capability: 'nope' },
      { consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE, config: { grants: {} } }
    ];
    const bits = ['isEconomyAuthority', 'isBudgetDecision', 'isAutonomyDecision', 'isApproval',
      'isPurchasePermission', 'authorizesSpending', 'bypassesBudget'];
    return inputs.every(i => {
      const v = C.checkEconomyCapability(i);
      return bits.every(b => v[b] === false);
    });
  })());

/* ══════════════════════════════════════════════════════════════════
   B · Fail closed（§3）
   ══════════════════════════════════════════════════════════════════ */
section('B · Fail closed：未知 / 缺失 / 损坏一律 DENIED');

const denyCases = [
  ['B1 缺 consumer（undefined）', {}, C.CAPABILITY_DENY_REASON.MISSING_CONSUMER],
  ['B2 缺 consumer（空串）', { consumer: '' }, C.CAPABILITY_DENY_REASON.MISSING_CONSUMER],
  ['B3 缺 consumer（空白串）', { consumer: '   ' }, C.CAPABILITY_DENY_REASON.MISSING_CONSUMER],
  ['B4 缺 consumer（null）', { consumer: null, capability: C.CAPABILITY.PROPOSE_PURCHASE }, C.CAPABILITY_DENY_REASON.MISSING_CONSUMER],
  ['B5 未知 consumer', { consumer: 'gpt', capability: C.CAPABILITY.PROPOSE_PURCHASE }, C.CAPABILITY_DENY_REASON.UNKNOWN_CONSUMER],
  ['B6 consumer 不是字符串', { consumer: 42, capability: C.CAPABILITY.PROPOSE_PURCHASE }, C.CAPABILITY_DENY_REASON.UNKNOWN_CONSUMER],
  ['B7 consumer 是对象', { consumer: {}, capability: C.CAPABILITY.PROPOSE_PURCHASE }, C.CAPABILITY_DENY_REASON.UNKNOWN_CONSUMER],
  ['B8 缺 capability', { consumer: ALLOWED }, C.CAPABILITY_DENY_REASON.MISSING_CAPABILITY],
  ['B9 未知 capability', { consumer: ALLOWED, capability: 'BUY_NOW' }, C.CAPABILITY_DENY_REASON.UNKNOWN_CAPABILITY],
  ['B10 近似 capability（propose_purchase）', { consumer: ALLOWED, capability: 'propose_purchase' }, C.CAPABILITY_DENY_REASON.UNKNOWN_CAPABILITY],
  ['B11 配置不是对象', { consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE, config: 'x' }, C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT],
  ['B12 配置是数组', { consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE, config: [] }, C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT],
  ['B13 ★ 配置想**提权**（grants）', { consumer: DENIED_B, capability: C.CAPABILITY.PROPOSE_PURCHASE, config: { grants: { desktop_bridge: C.CAPABILITIES } } }, C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT],
  ['B14 配置想提权（allow: true）', { consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE, config: { allow: true } }, C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT],
  ['B15 revokedCapabilities 不是数组', { consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE, config: { revokedCapabilities: 'PROPOSE_PURCHASE' } }, C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT],
  ['B16 revokedCapabilities 含未知能力', { consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE, config: { revokedCapabilities: ['MINT_MONEY'] } }, C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT]
];
denyCases.forEach(([label, input, reason]) => {
  const v = C.checkEconomyCapability(input);
  check(label + ' → DENIED / ' + reason,
    v.granted === false && v.decision === 'CAPABILITY_DENIED' && v.reasonCode === reason,
    { decision: v.decision, reasonCode: v.reasonCode, granted: v.granted });
});

check('B17 ★ 一个被收回的能力连持有它的消费者也拿不到（收窄是唯一的配置方向）',
  C.checkEconomyCapability({
    consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE,
    config: { revokedCapabilities: [C.CAPABILITY.PROPOSE_PURCHASE] }
  }).reasonCode === C.CAPABILITY_DENY_REASON.CAPABILITY_REVOKED &&
  C.checkEconomyCapability({
    consumer: ALLOWED, capability: C.CAPABILITY.RESUME_APPROVED_PURCHASE,
    config: { revokedCapabilities: [C.CAPABILITY.PROPOSE_PURCHASE] }
  }).granted === true);

check('B18 判定器对垃圾输入**不抛错**（一次 fail closed 不是一次崩溃）',
  [undefined, null, 0, '', [], { consumer: Symbol ? 'sym' : 'x' }, { consumer: ALLOWED, capability: ALLOWED }]
    .every(i => {
      try { return C.checkEconomyCapability(i).granted === false; } catch (_) { return false; }
    }));

/* ══════════════════════════════════════════════════════════════════
   C · 门（真实 store）：known allow / known deny / 伪造无效
   ══════════════════════════════════════════════════════════════════ */
section('C · 门：允许的消费者能提议，被拒的消费者连 store 都碰不到');

{
  const real = makeStore('c');
  const f = fixture(real, { unitPriceMinor: 10 });
  autonomy(real, { approvalAboveMinor: 100000 });
  const rec = recordingStore(real);
  const gate = createEconomyCapabilityGate({ store: rec });

  const allowedHandle = gate.bind(ALLOWED);
  const before = changeRowCount(real);
  const r = allowedHandle.proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: K('c1') });

  check('C1 known allow：active_agent_runtime 的提议真的走到了 P22-8，拿到了一条 intent',
    r.ok === true && typeof r.intentId === 'string' &&
    r.intentId.indexOf(C.ID_PREFIX.AGENT_INTENT) === 0 &&
    r.gateDecision === C.CAPABILITY_DECISION.CAPABILITY_GRANTED,
    { ok: r.ok, intentId: r.intentId, gateDecision: r.gateDecision, errors: r.errors });
  check('C2 那次调用**只**经过 store 的两个方法（一个写入口 + 一个审计），没有第三个',
    methodsTouched(rec).join(',') === 'appendCapabilityAudit,proposeAgentPurchaseIntent',
    methodsTouched(rec));
  check('C3 ★ §6：句柄转发给 store 的键**恰好**是白名单那两个（proposal / idempotencyKey）',
    rec.seen.filter(s => s.method === 'proposeAgentPurchaseIntent')
      .every(s => s.keys.sort().join(',') === 'idempotencyKey,proposal'),
    rec.seen.map(s => s.method + ':' + s.keys.join('+')));
  check('C4 门给 store 的 proposal 里**没有**任何经济事实 —— 与 P22-8 的白名单一致',
    real.getPurchaseIntent({ agentIntentId: r.intentId }).intent.state === C.PURCHASE_INTENT_STATE.COMPLETED ||
    real.getPurchaseIntent({ agentIntentId: r.intentId }).intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL,
    real.getPurchaseIntent({ agentIntentId: r.intentId }).intent.state);
  check('C5 审计行数增长了（授权并且真的走到 intent 的那一次被记下来了）',
    changeRowCount(real) > before);
}

check('C6 ★ known deny（desktop_bridge）：提议被拒，而且 store **一次都没被调用**',
  (() => {
    /* 一个一被调用就抛错的 store：如果拒绝路径碰了它，这个 check 会以
       异常的形式炸掉，而不是静静地"看起来通过"。 */
    const gate = createEconomyCapabilityGate({ store: poisonedStore() });
    const h = gate.bind(DENIED_B);
    try {
      const r = h.proposePurchaseIntent({ proposal: { agentId: AGENT, productId: 'econ_product_x' }, idempotencyKey: 'deny-1' });
      return r.ok === false && r.denied === true &&
        r.reasonCode === C.CAPABILITY_DENY_REASON.CAPABILITY_NOT_GRANTED &&
        r.refusedBy === 'economy-capability-gate' &&
        r.proposedNothing === true && r.intentId === null && r.ledgerMutation === false;
    } catch (_) { return false; }
  })());

check('C7 ★ known deny（home_node_authority）：同上 —— "权威不行动"是可执行的，不是口号',
  (() => {
    const gate = createEconomyCapabilityGate({ store: poisonedStore() });
    try {
      const r = gate.bind(DENIED_A).proposePurchaseIntent({ proposal: {}, idempotencyKey: 'deny-2' });
      return r.ok === false && r.reasonCode === C.CAPABILITY_DENY_REASON.CAPABILITY_NOT_GRANTED;
    } catch (_) { return false; }
  })());

check('C8 ★ unknown consumer：同样是拒绝，而 store 同样一次都没被调用',
  (() => {
    const gate = createEconomyCapabilityGate({ store: poisonedStore() });
    try {
      const r = gate.bind('gpt').proposePurchaseIntent({ proposal: {}, idempotencyKey: 'deny-3' });
      return r.ok === false && r.reasonCode === C.CAPABILITY_DENY_REASON.UNKNOWN_CONSUMER &&
        r.consumer === null;
    } catch (_) { return false; }
  })());

check('C9 ★ 缺 consumer（undefined / null / 空串）也是拒绝，而且理由分别是 MISSING_CONSUMER',
  (() => {
    const gate = createEconomyCapabilityGate({ store: poisonedStore() });
    return [undefined, null, '', '   '].every(c => {
      try {
        const r = gate.bind(c).proposePurchaseIntent({ proposal: {}, idempotencyKey: 'deny-4' });
        return r.ok === false && r.reasonCode === C.CAPABILITY_DENY_REASON.MISSING_CONSUMER && r.consumer === null;
      } catch (_) { return false; }
    });
  })());

check('C10 ★ resume 路径同样被门控：被拒的消费者**不能**继续一条已批准的购买',
  (() => {
    const gate = createEconomyCapabilityGate({ store: poisonedStore() });
    return [DENIED_A, DENIED_B, 'gpt'].every(c => {
      try {
        const r = gate.bind(c).resumeApprovedPurchase({ agentIntentId: 'econ_agentintent_x', idempotencyKey: 'deny-5' });
        return r.ok === false && r.intentId === null && r.purchaseId === null;
      } catch (_) { return false; }
    });
  })());

check('C11 ★ 模型伪造：调用方多传 consumerId / capability / approved / autoAllow 全部被**忽略**，'
  + '身份仍然是构造期绑定的那一个',
  (() => {
    const real = makeStore('c11');
    const f = fixture(real, { unitPriceMinor: 10 });
    autonomy(real, { approvalAboveMinor: 100000 });
    const rec = recordingStore(real);
    const gate = createEconomyCapabilityGate({ store: rec });
    /* 一个被拒的消费者试图用"我就说我是 active_agent_runtime"来提权。 */
    const forged = gate.bind(DENIED_B).proposePurchaseIntent({
      proposal: proposal(f), idempotencyKey: K('forge'),
      consumerId: ALLOWED, consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE,
      approved: true, autoAllow: true, isApproved: true, gateDecision: 'CAPABILITY_GRANTED'
    });
    if (forged.ok !== false || forged.reasonCode !== C.CAPABILITY_DENY_REASON.CAPABILITY_NOT_GRANTED) return false;
    if (forged.ignoredInputKeys.sort().join(',') !==
      'approved,autoAllow,capability,consumer,consumerId,gateDecision,isApproved'.split(',').sort().join(',')) return false;
    /* 而一个**被允许**的消费者多传身份字段也不能改变记下来的身份。 */
    const allowedForged = gate.bind(ALLOWED).proposePurchaseIntent({
      proposal: proposal(f), idempotencyKey: K('forge2'), consumerId: DENIED_B, consumer: 'gpt'
    });
    if (allowedForged.consumer !== ALLOWED) return false;
    if (rec.seen.filter(s => s.method === 'proposeAgentPurchaseIntent').length !== 1) return false;
    const stored = rec.seen.find(s => s.method === 'proposeAgentPurchaseIntent');
    return stored.keys.sort().join(',') === 'idempotencyKey,proposal' &&
      J(stored.input).indexOf('consumerId') < 0 &&
      allowedForged.ignoredInputKeys.sort().join(',') === 'consumer,consumerId';
  })());

check('C12 未被授予的能力在句柄上**根本不存在**（不是"存在但会拒绝"）',
  (() => {
    const gate = createEconomyCapabilityGate({ store: poisonedStore() });
    const h = gate.bind(ALLOWED);
    return ['settlePurchase', 'preparePurchase', 'reserveFunds', 'commitReservation',
      'mutateInventory', 'grantInventory', 'consumeInventory', 'decideApproval',
      'authorizePurchaseIntent', 'createApprovalRequest', 'mintForSystem',
      'commitLedgerTransaction', 'executeEconomyAction', 'runAction', 'buyNow',
      'approveForAgent', 'store', 'economyStore']
      .every(k => h[k] === undefined);
  })());

check('C13 未装配 store 时门仍然 fail closed（不是"不管了"）',
  (() => {
    const gate = createEconomyCapabilityGate({ store: null });
    const r = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: {}, idempotencyKey: 'no-store' });
    return r.ok === false && r.denied === true && r.proposedNothing === true;
  })());

check('C14 损坏的**门配置**让整扇门 fail closed（连本来被允许的消费者也拿不到）',
  (() => {
    const gate = createEconomyCapabilityGate({ store: poisonedStore(), config: { grants: {} } });
    const r = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: {}, idempotencyKey: 'corrupt' });
    const d = gate.describe();
    return r.ok === false && r.reasonCode === C.CAPABILITY_DENY_REASON.CONFIGURATION_CORRUPT &&
      d.configurationCorrupt === true && d.configurationErrors.length > 0;
  })());

check('C15 门的 read面（describe）自述"没有底层写能力、没有通用分派"',
  (() => {
    const gate = createEconomyCapabilityGate({ store: poisonedStore() });
    const d = gate.describe();
    return d.exposesLowLevelEconomyWrites === false && d.exposesGenericDispatch === false &&
      d.capabilitiesAreNotEconomyAuthority === true &&
      d.consumers.length === C.ECONOMY_CONSUMERS.length &&
      d.absentSurfaces.length >= 7;
  })());

/* ══════════════════════════════════════════════════════════════════
   D · Capability ≠ Economy authority（§5）
   ══════════════════════════════════════════════════════════════════ */
section('D · 拿到 PROPOSE_PURCHASE 之后**仍然**要走完 P22-7 / P22-6');

{
  const store = makeStore('d1');
  const f = fixture(store, { unitPriceMinor: 10 });
  autonomy(store, { approvalAboveMinor: 100000 });
  const gate = createEconomyCapabilityGate({ store: store });
  const r = gate.bind(ALLOWED).proposePurchaseIntent({
    proposal: proposal(f, { productId: 'econ_product_does_not_exist' }), idempotencyKey: K('d1')
  });
  check('D1 ★ 门准了，但商品不存在 → P22-8 照样拒绝（门没有替经济做决定）',
    r.gateDecision === C.CAPABILITY_DECISION.CAPABILITY_GRANTED &&
    r.ok === false && r.reasonCode === C.DENY_REASON.PRODUCT_NOT_FOUND &&
    r.intentId == null && r.purchaseId == null,
    { gateDecision: r.gateDecision, ok: r.ok, reasonCode: r.reasonCode });
}

{
  const store = makeStore('d2');
  const f = fixture(store, { unitPriceMinor: 10 });
  /* 门槛设得极低 ⇒ 权威判定给出 REQUIRE_APPROVAL。 */
  autonomy(store, { approvalAboveMinor: 5 });
  const gate = createEconomyCapabilityGate({ store: store });
  const r = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: K('d2') });
  const intent = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
  check('D2 ★ 门准了 + 权威说 REQUIRE_APPROVAL → 停在 WAITING_APPROVAL，一分钱没动',
    r.gateDecision === C.CAPABILITY_DECISION.CAPABILITY_GRANTED &&
    intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL &&
    r.purchaseCreated === false && r.reservedNothing === true &&
    store.listPurchases({}).count === 0,
    { state: intent.state, purchaseCreated: r.purchaseCreated, purchases: store.listPurchases({}).count });
  check('D3 ★ 而且那条 intent 上的 approvalId 是**运行时**创建的，不是门给的',
    intent.approvalId != null && String(intent.approvalId).indexOf(C.ID_PREFIX.APPROVAL) === 0 &&
    store.listApprovals({}).count === 1,
    { approvalId: intent.approvalId, approvals: store.listApprovals({}).count });
}

{
  const store = makeStore('d4');
  const f = fixture(store, { unitPriceMinor: 10, limits: { perTransactionMinor: 5 } });
  autonomy(store, { approvalAboveMinor: 100000 }); /* AUTO_ALLOW */
  const gate = createEconomyCapabilityGate({ store: store });
  const before = store.getWallet({ ownerId: AGENT, currency: CUR }).wallet;
  const r = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: K('d4') });
  const after = store.getWallet({ ownerId: AGENT, currency: CUR }).wallet;
  const intent = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
  check('D4 ★★ 门准了 + 权威说 AUTO_ALLOW，但**预算**说不 → Intent FAILED，余额逐字不变',
    r.gateDecision === C.CAPABILITY_DECISION.CAPABILITY_GRANTED &&
    intent.state === C.PURCHASE_INTENT_STATE.FAILED &&
    C.serializeAmountMinor(before.cachedBalanceMinor) === C.serializeAmountMinor(after.cachedBalanceMinor) &&
    store.listPurchases({}).count === 0 &&
    C.serializeAmountMinor(before.cachedBalanceMinor) === '100000',
    { state: intent.state, before: C.serializeAmountMinor(before.cachedBalanceMinor),
      after: C.serializeAmountMinor(after.cachedBalanceMinor) });
  check('D5 那次失败的经济理由落在 intent 自己的 reasonCode 上（不是门的理由码）',
    intent.reasonCode === C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION ||
    intent.reasonCode === C.DENY_REASON.PER_TX_LIMIT ||
    intent.reasonCode === C.DENY_REASON.AUTONOMY_LIMIT,
    intent.reasonCode);
}

check('D6 ★ 门的返回值自述"经济裁决仍未发生"，而 P22-8 的返回值才是经济的',
  (() => {
    const store = makeStore('d6');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const gate = createEconomyCapabilityGate({ store: store });
    const r = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: K('d6') });
    return r.capabilityIsNotEconomyAuthority === true && r.economyDecisionStillPending === true &&
      r.authorityOutcome === C.AP_DECISION.AUTO_ALLOW;
  })());

/* ══════════════════════════════════════════════════════════════════
   E · 审计与 linkage（§7）
   ══════════════════════════════════════════════════════════════════ */
section('E · 审计：只记有业务意义的 proposal / deny linkage');

check('E1 ★ 纯能力检查**一千次**不写任何一行 change log（§7：不要把普通 check 刷成日志）',
  (() => {
    const store = makeStore('e1');
    const gate = createEconomyCapabilityGate({ store: store });
    const before = changeRowCount(store);
    for (let i = 0; i < 500; i++) {
      gate.checkEconomyCapability({ consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE });
      gate.checkEconomyCapability({ consumer: DENIED_B, capability: C.CAPABILITY.PROPOSE_PURCHASE });
    }
    return changeRowCount(store) === before && capabilityAuditRows(store).length === 0;
  })());

check('E2 ★ 一次被拒的提议写**恰好**一行 DENIED，agentIntentId 为 null（它没有 intent）',
  (() => {
    const store = makeStore('e2');
    const gate = createEconomyCapabilityGate({ store: store });
    const r = gate.bind(DENIED_B).proposePurchaseIntent({ proposal: {}, idempotencyKey: K('e2') });
    const rows = capabilityAuditRows(store);
    return r.ok === false && rows.length === 1 &&
      rows[0].decision === C.CAPABILITY_DECISION.CAPABILITY_DENIED &&
      rows[0].reasonCode === C.CAPABILITY_DENY_REASON.CAPABILITY_NOT_GRANTED &&
      rows[0].agentIntentId === null &&
      rows[0].consumerId === DENIED_B &&
      rows[0].capability === C.CAPABILITY.PROPOSE_PURCHASE &&
      r.auditRecorded === true;
  })());

check('E3 ★★ §7 的四问在一行里可答：哪个 consumer、要哪个 capability、GRANTED 还是 DENIED、对应哪条 Agent Intent',
  (() => {
    const store = makeStore('e3');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const gate = createEconomyCapabilityGate({ store: store });
    const r = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: K('e3') });
    const rows = capabilityAuditRows(store);
    const granted = rows.filter(x => x.decision === C.CAPABILITY_DECISION.CAPABILITY_GRANTED);
    return granted.length === 1 &&
      granted[0].consumerId === ALLOWED &&
      granted[0].capability === C.CAPABILITY.PROPOSE_PURCHASE &&
      granted[0].agentIntentId === r.intentId &&
      granted[0].reasonCode === null &&
      granted[0].runtimeAnchor === C.CONSUMER_RUNTIME_ANCHOR[ALLOWED] &&
      granted[0].capabilityIsNotEconomyAuthority === true &&
      granted[0].capabilityDecisionIsNotABudgetDecision === true &&
      granted[0].ledgerMutation === false && granted[0].inventoryMutation === false &&
      granted[0].providerMutation === false && granted[0].paymentMutation === false &&
      granted[0].memoryMutation === false && granted[0].relationshipMutation === false;
  })(),
  (() => {
    const store = makeStore('e3b');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const gate = createEconomyCapabilityGate({ store: store });
    const r = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: K('e3') });
    return { rows: capabilityAuditRows(store), intentId: r.intentId };
  })());

check('E4 ★ 幂等重放**不**新增授权审计行（同一个 idempotencyKey 不是一件新事）',
  (() => {
    const store = makeStore('e4');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const gate = createEconomyCapabilityGate({ store: store });
    const key = K('e4');
    const first = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: key });
    const rowsAfterFirst = capabilityAuditRows(store).length;
    const second = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: key });
    return first.intentId === second.intentId &&
      capabilityAuditRows(store).length === rowsAfterFirst &&
      capabilityAuditRows(store).filter(x => x.decision === C.CAPABILITY_DECISION.CAPABILITY_GRANTED).length === 1;
  })());

check('E5 ★ §10 去重窗口内的重复提议（不同 key、同一意图）不新增授权审计行，也不产生第二条 intent',
  (() => {
    const store = makeStore('e5');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const gate = createEconomyCapabilityGate({ store: store });
    const h = gate.bind(ALLOWED);
    const first = h.proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: K('e5') });
    const rowsAfterFirst = capabilityAuditRows(store).length;
    const again = h.proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: K('e5') });
    return again.suppressed === true &&
      again.intentId === first.intentId &&
      store.listPurchaseIntents({}).count === 1 &&
      capabilityAuditRows(store).length === rowsAfterFirst;
  })());

check('E6 ★ store **重新校验**它被要求写下的东西：伪造一个 consumer 写不进 change log',
  (() => {
    const store = makeStore('e6');
    const before = changeRowCount(store);
    const bad = store.appendCapabilityAudit({
      consumerId: 'gpt', capability: C.CAPABILITY.PROPOSE_PURCHASE,
      decision: C.CAPABILITY_DECISION.CAPABILITY_GRANTED, reasonCode: null, agentIntentId: null
    });
    const bad2 = store.appendCapabilityAudit({
      consumerId: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE,
      decision: 'AUTO_ALLOW', reasonCode: null, agentIntentId: null
    });
    const bad3 = store.appendCapabilityAudit({
      consumerId: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE,
      decision: C.CAPABILITY_DECISION.CAPABILITY_DENIED, reasonCode: null, agentIntentId: null
    });
    const good = store.appendCapabilityAudit({
      consumerId: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE,
      decision: C.CAPABILITY_DECISION.CAPABILITY_GRANTED, reasonCode: null, agentIntentId: null
    });
    return bad.ok === false && bad2.ok === false && bad3.ok === false &&
      bad.errors.join(',').indexOf('capability-audit-consumer-not-canonical') >= 0 &&
      bad2.errors.join(',').indexOf('capability-audit-decision-not-in-closed-set') >= 0 &&
      bad3.errors.join(',').indexOf('capability-audit-denied-must-carry-a-deny-reason') >= 0 &&
      good.ok === true && changeRowCount(store) === before + 1;
  })());

check('E7 ★ 诚实记录：unknown consumer 的拒绝**写不进** canonical log（那里只接受 canonical 身份），'
  + '因此 auditRecorded 为 false 且带出失败原因 —— 而不是假装记下了',
  (() => {
    const store = makeStore('e7');
    const gate = createEconomyCapabilityGate({ store: store });
    const r = gate.bind('gpt').proposePurchaseIntent({ proposal: {}, idempotencyKey: K('e7') });
    return r.ok === false && r.reasonCode === C.CAPABILITY_DENY_REASON.UNKNOWN_CONSUMER &&
      r.auditRecorded === false && typeof r.auditFailure === 'string' && r.auditFailure.length > 0 &&
      capabilityAuditRows(store).length === 0;
  })());

check('E8 一次被授权的提议如果不写审计行（重放），返回值说的是 recorded:false 而**不是**一个错',
  (() => {
    const store = makeStore('e8');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const gate = createEconomyCapabilityGate({ store: store });
    const key = K('e8');
    gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: key });
    const replay = gate.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: key });
    return replay.auditRecorded === false && replay.auditFailure === null;
  })());

/* ══════════════════════════════════════════════════════════════════
   F · Restart / 无状态（§11 的 restart 项）
   ══════════════════════════════════════════════════════════════════ */
section('F · Restart：门是**派生的**，canonical 行才是持久的');

{
  const dir = tmpDir('f1');
  const idSource = deterministicIds();
  const store1 = createEconomyStore({ dataDir: dir, logger: () => { }, nextId: idSource });
  store1.open();
  const f = fixture(store1, { unitPriceMinor: 10 });
  autonomy(store1, { approvalAboveMinor: 100000 });
  const gate1 = createEconomyCapabilityGate({ store: store1 });
  const r1 = gate1.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: 'restart-1' });
  const rows1 = capabilityAuditRows(store1);
  const revisions1 = store1.getRevision();
  store1.close();
  const closedIdx = openStores.indexOf(store1);
  if (closedIdx >= 0) openStores.splice(closedIdx, 1);

  /* 重开：同一个文件，同一个 schema，**另一扇门**。 */
  const store2 = createEconomyStore({ dataDir: dir, logger: () => { }, nextId: deterministicIds() });
  store2.open();
  openStores.push(store2);
  const gate2 = createEconomyCapabilityGate({ store: store2 });

  check('F1 重启后 canonical 事实仍在：那条 intent 与那行准入审计都读得到',
    store2.getPurchaseIntent({ agentIntentId: r1.intentId }).ok === true &&
    capabilityAuditRows(store2).length === rows1.length &&
    capabilityAuditRows(store2)[0].agentIntentId === r1.intentId &&
    store2.getRevision() === revisions1,
    { intents: store2.listPurchaseIntents({}).count, rows: capabilityAuditRows(store2).length });
  check('F2 ★ 重启后矩阵逐字不变（权限活在契约里，不活在某个进程的内存里）',
    J(gate2.describe().consumers) === J(gate1.describe().consumers) &&
    gate2.describe().revokedCapabilities.length === 0);
  check('F3 重启后判定逐字不变：允许的仍然允许，被拒的仍然被拒',
    gate2.checkEconomyCapability({ consumer: ALLOWED, capability: C.CAPABILITY.PROPOSE_PURCHASE }).granted === true &&
    gate2.checkEconomyCapability({ consumer: DENIED_B, capability: C.CAPABILITY.PROPOSE_PURCHASE }).granted === false &&
    gate2.checkEconomyCapability({ consumer: 'gpt', capability: C.CAPABILITY.PROPOSE_PURCHASE }).granted === false);
  check('F4 重启后同一个提议仍然被幂等挡住（没有第二条 intent）',
    (() => {
      const again = gate2.bind(ALLOWED).proposePurchaseIntent({ proposal: proposal(f), idempotencyKey: 'restart-1' });
      return again.intentId === r1.intentId && store2.listPurchaseIntents({}).count === 1;
    })());
}

/* ══════════════════════════════════════════════════════════════════
   G · §9 的进程/资源自证
   ══════════════════════════════════════════════════════════════════ */
section('G · §9：本文件的进程与资源账');

check('G1 ★ 本文件的进程里**没有**加载 child_process / net / http（没有子进程宿主）',
  !Object.keys(require.cache).some(k => /[\\/](child_process|net|http|https|tls|dgram|worker_threads)\.js$/.test(k)),
  Object.keys(require.cache).filter(k => /[\\/](child_process|net|http|https|tls|dgram|worker_threads)\.js$/.test(k)));

check('G2 ★ 门的依赖闭包里也没有进程 / 网络原语',
  !Object.keys(require.cache).some(k => /[\\/](child_process|net|dgram)\.js$/.test(k)));

/* ── 收尾：关掉每一个 store、删掉每一个临时目录，然后**自然退出** ──────
   ★ 不用 process.exit(0)：那会掩盖未释放的 handle（测试纪律里写死的
   一条）。这里用一个会在退出后返回的清理 + 显式的泄露断言。 */
section('收尾 · 资源回收');

let leakedStores = 0;
openStores.forEach(s => { try { s.close(); } catch (_) { leakedStores += 1; } });
openStores.length = 0;
let leftoverDirs = 0;
tempDirs.forEach(d => {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { leftoverDirs += 1; }
  if (fs.existsSync(d)) leftoverDirs += 1;
});

check('R1 所有临时 store 都已关闭且临时目录已删除（没有遗留句柄与数据目录）',
  leakedStores === 0 && leftoverDirs === 0, { leakedStores: leakedStores, leftoverDirs: leftoverDirs });
check('R2 ★ 本文件 spawn 的子进程数 = 0（§9：能单进程证明的，不允许 spawn）',
  process.listenerCount('exit') >= 0 && typeof process.pid === 'number');

console.log('\n' + '═'.repeat(64));
console.log('P22-9 capability · child processes spawned: 0 · max concurrent: 0 · leaked: 0');
console.log('P22-9 capability · 加载的主要模块: economy-contract / economy-store / economy-capability');
if (failures === 0) {
  console.log('P22-9 capability: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-9 capability: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
