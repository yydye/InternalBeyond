'use strict';
/* ====================================================================
   P22-10 · Economy Action Adapter（单进程 · **零子进程**）
   --------------------------------------------------------------------
   运行：node tests/test_p22_10_economy_action_adapter.js

   ── 本文件证明什么（§13 的重点锁）──────────────────────────────────
     valid action → bound handle · unknown action rejected ·
     malformed proposal rejected · economic facts cannot be injected ·
     raw store inaccessible · bottom-level mutation inaccessible ·
     P22-9 cannot be bypassed · duplicate action doesn't duplicate purchase ·
     denied capability produces no Intent ·
     AUTO_ALLOW still passes full downstream authority ·
     REQUIRE_APPROVAL still stops

   ── 为什么一个子进程都不开（§12）────────────────────────────────────
   §12 逐字要求：能单进程证明的禁止 spawn；P22-6 ~ P22-8 已经证明过的
   崩溃/竞争矩阵（settlement atomicity · approval race · intent race ·
   crash recovery）只做 regression，不复制。本阶段的自有 invariant 全部是
   "一个纯净化器 + 一个窄转发 + 一次同进程 store 调用"，没有一条需要
   第二个操作系统进程：
     · 动作净化是**纯函数**（无 IO、无时钟、无状态）；
     · 转发是一个字面成员调用；
     · P22-8 的多进程性质（同一提议在两进程里恰好一条 intent）已经在
       p22-8-intent-worker.js 的两进程组里证明过，重复它不会多证明任何
       关于**适配器**的事情。
   末尾 G 组自报 spawn 次数。

   ── 隔离 ─────────────────────────────────────────────────────────────
   每组的 store 用自己的一次性临时目录（dataDir 是显式参数，因此不设
   IB_HOME_NODE_DATA_DIR 也**不会**碰生产数据目录）。
   ==================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const createEconomyCapabilityGate = require(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'));
const ADAPTER = require(path.join(ROOT, 'services', 'home-node', 'economy-action-adapter.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

const ADAPTER_SRC = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-action-adapter.js'), 'utf8');

/* ── 剥注释与字符串字面量（与 P22-1 boundary 的 stripCommentsAndStrings
   逐字同款纪律）────────────────────────────────────────────────────
   ★ 这一步不是装饰。适配器的头注释里**逐字写着**它刻意没有的东西
   （"没有 handle[...] 形式的计算型分派"、"resumeApprovedPurchase 不可达"、
   "底层 mutation 一个都没有"），而 NOT_OFFERED 的 evidence 字符串里逐字
   写着 economy-store.js 的路径。若扫描器读原始文本，那些**否认**与那些
   **引用**会被当成**声明**，而最坏的后果是让人为了变绿删掉解释 ——
   解释恰恰是这个仓库最重要的东西。（同源的实测教训：P22-2 的 B3.7 曾把
   一句 "本文件不 require('crypto')" 的注释判成一条真实依赖。） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1');
}
function stripCommentsAndStrings(src) {
  return stripComments(src)
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^\\"\n])*"/g, ' "" ')
    .replace(/`(?:\\.|[^\\`])*`/g, ' `` ');
}
/* 两份视图，各有各的用途：
   · SRC_CODE    —— 剥注释 + 字符串：用来判"这段**代码**里有没有那个标识符"；
   · SRC_TARGETS —— 只剥注释：用来读 require 的**目标**（字符串不能被剥掉）。 */
const SRC_TARGETS = stripComments(ADAPTER_SRC);
const SRC_CODE = stripCommentsAndStrings(ADAPTER_SRC);

/* 生产扫描目录：与 P22-1 boundary 的 BYPASS_SCAN_DIRS 逐字同一份约定。
   扫描前同样剥注释 —— 一句解释性的注释不是一次调用。 */
const SCAN_DIRS = ['services', 'active', 'runtime', 'assets/js', 'bridge', 'scripts'];
function scanProduction(matchRe) {
  const hits = [];
  SCAN_DIRS.forEach(dirRel => {
    const walk = rel => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = rel + '/' + entry.name;
        if (entry.isDirectory()) { walk(child); continue; }
        if (!/\.js$/i.test(entry.name)) continue;
        if (matchRe.test(stripCommentsAndStrings(fs.readFileSync(path.join(ROOT, child), 'utf8')))) {
          hits.push(child);
        }
      }
    };
    walk(dirRel);
  });
  return hits;
}
const ADAPTER_REL = 'services/home-node/economy-action-adapter.js';

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

/* ── 资源台账 ───────────────────────────────────────────────────────── */
const openStores = [];
const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-10aa-' + tag + '-'));
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
/* 一个"装配好的适配器"：真实 store → 真实门 → 唯一一次 bind → 适配器。 */
function boundAdapter(store, consumerId) {
  const gate = createEconomyCapabilityGate({ store: store });
  const handle = gate.bind(consumerId === undefined ? C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME : consumerId);
  return { gate: gate, handle: handle, adapter: ADAPTER.createEconomyActionAdapter(handle) };
}
function actionOf(f, extra, actionName, key) {
  return {
    action: actionName === undefined ? ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE : actionName,
    proposal: proposal(f, extra),
    idempotencyKey: key || K('act')
  };
}
function walletMinor(store) {
  return C.serializeAmountMinor(store.getWallet({ ownerId: AGENT, currency: CUR }).wallet.cachedBalanceMinor);
}

console.log('P22-10 · Economy Action Adapter');

/* ══════════════════════════════════════════════════════════════════
   A · §2 动作词表：封闭集恰好一个，禁止变一个都不存在
   ══════════════════════════════════════════════════════════════════ */
section('A · §2 动作词表（封闭集 · 只有一个开放动作）');

check('A1 ★ 开放的动作恰好一个，而且就是 §2 指定的那一个',
  ADAPTER.ACTION_LIST.length === 1 &&
  ADAPTER.ACTION_LIST[0] === 'ECONOMY_PROPOSE_PURCHASE',
  ADAPTER.ACTION_LIST);

check('A2 ★ §2 逐名禁止的六个动作在任何一份名单里都**不存在**',
  ['ECONOMY_BUY', 'ECONOMY_SETTLE', 'ECONOMY_RESERVE', 'ECONOMY_GRANT', 'ECONOMY_APPROVE', 'ECONOMY_LEDGER']
    .every(name => ADAPTER.ACTION_LIST.indexOf(name) < 0 && ADAPTER.NOT_OFFERED_ACTIONS.indexOf(name) < 0),
  { offs: ADAPTER.ACTION_LIST, nots: ADAPTER.NOT_OFFERED_ACTIONS });

check('A3 ★ §9：resume 是"已知但**不开放**"，而且它带着理由与证据（不是"忘了写"）',
  ADAPTER.NOT_OFFERED_ACTIONS.length === 1 &&
  ADAPTER.NOT_OFFERED_ACTIONS[0] === 'ECONOMY_RESUME_APPROVED_PURCHASE' &&
  ADAPTER.NOT_OFFERED[0].reasonCode === 'NO_APPROVAL_TRIGGER_SEAM' &&
  typeof ADAPTER.NOT_OFFERED[0].evidence === 'string' &&
  ADAPTER.NOT_OFFERED[0].evidence.indexOf('decideApproval') >= 0,
  ADAPTER.NOT_OFFERED);

check('A4 ★ 动作词与准入能力词**字形不相交**（一句话在审计里只能有一个意思）',
  ADAPTER.ACTION_LIST.concat(ADAPTER.NOT_OFFERED_ACTIONS)
    .every(name => C.CAPABILITIES.indexOf(name) < 0),
  { actions: ADAPTER.ACTION_LIST, capabilities: C.CAPABILITIES });

check('A5 每个动作都映射到一个**真实存在**的准入能力（映射表可以核对，不是两处写死的字符串）',
  ADAPTER.ACTION_LIST.concat(ADAPTER.NOT_OFFERED_ACTIONS)
    .every(name => C.CAPABILITIES.indexOf(
      (ADAPTER.ACTION_CAPABILITY[name] != null ? ADAPTER.ACTION_CAPABILITY[name] : ADAPTER.NOT_OFFERED[0].capability)
    ) >= 0),
  ADAPTER.ACTION_CAPABILITY);

check('A6 ★ 适配器的实例键恰好七个，而且**没有**任何万能入口的名字',
  Object.keys(ADAPTER.createEconomyActionAdapter(null)).sort().join(',') ===
  ADAPTER.ADAPTER_KEYS.slice().sort().join(','),
  Object.keys(ADAPTER.createEconomyActionAdapter(null)));

/* ══════════════════════════════════════════════════════════════════
   B · §7 净化器：未知 / 畸形一律拒绝，绝不猜测修复
   ══════════════════════════════════════════════════════════════════ */
section('B · §7 动作净化器（封闭动作集 · 不猜修复）');

const PURE = ADAPTER.createEconomyActionAdapter(null);
const R = ADAPTER.ACTION_REFUSAL;
const F_B = (() => { const s = makeStore('b'); return fixture(s); })();
const OK_ACTION = actionOf(F_B);

check('B1 合法动作被净化成 { action, capability, proposal, idempotencyKey } 四项',
  (() => {
    const s = PURE.sanitizeAction(OK_ACTION);
    return s.ok === true &&
      Object.keys(s.sanitized).sort().join(',') === 'action,capability,idempotencyKey,proposal' &&
      s.sanitized.capability === C.CAPABILITY.PROPOSE_PURCHASE &&
      s.sanitized.proposal === OK_ACTION.proposal;   /* ★ 同一个引用：原样转发 */
  })(),
  PURE.sanitizeAction(OK_ACTION));

check('B2 ★ 未知动作被拒绝（而且把封闭集带回去）',
  (() => {
    const s = PURE.sanitizeAction(actionOf(F_B, {}, 'ECONOMY_BUY'));
    return s.ok === false && s.reasonCode === R.UNKNOWN_ACTION &&
      Array.isArray(s.acceptedActions) && s.acceptedActions.indexOf('ECONOMY_PROPOSE_PURCHASE') >= 0;
  })(),
  PURE.sanitizeAction(actionOf(F_B, {}, 'ECONOMY_BUY')));

check('B3 ★ 已知但不开放的动作是**另一个**理由码（不开放 ≠ 模型胡说）',
  (() => {
    const s = PURE.sanitizeAction(actionOf(F_B, {}, 'ECONOMY_RESUME_APPROVED_PURCHASE'));
    return s.ok === false && s.reasonCode === R.NOT_OFFERED &&
      s.notOfferedActions.indexOf('ECONOMY_RESUME_APPROVED_PURCHASE') >= 0;
  })(),
  PURE.sanitizeAction(actionOf(F_B, {}, 'ECONOMY_RESUME_APPROVED_PURCHASE')));

check('B4 ★ 不猜修复：大小写 / 前后空格 / 全角都不是"同一个动作"',
  ['economy_propose_purchase', 'ECONOMY_PROPOSE_PURCHASE ', ' ECONOMY_PROPOSE_PURCHASE']
    .every(name => {
      const s = PURE.sanitizeAction(actionOf(F_B, {}, name));
      return s.ok === false && s.reasonCode === R.UNKNOWN_ACTION;
    }),
  ['economy_propose_purchase', 'ECONOMY_PROPOSE_PURCHASE '].map(n => PURE.sanitizeAction(actionOf(F_B, {}, n)).reasonCode));

check('B5 非对象 / 数组 / 缺 action 一律拒绝，并给出各自的理由码',
  [null, undefined, 'x', 42, [], [OK_ACTION]].every(v =>
    PURE.sanitizeAction(v).ok === false) &&
  PURE.sanitizeAction(null).reasonCode === R.NOT_A_PLAIN_OBJECT &&
  PURE.sanitizeAction({ proposal: proposal(F_B), idempotencyKey: K('x') }).reasonCode === R.MISSING_ACTION,
  [PURE.sanitizeAction(null).reasonCode, PURE.sanitizeAction({}).reasonCode]);

check('B6 ★ proposal 缺失 / 不是普通对象 → 拒绝（而不是替模型造一个）',
  (() => {
    const missing = PURE.sanitizeAction({ action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE, idempotencyKey: K('m') });
    const notObj = PURE.sanitizeAction({ action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE, proposal: 'buy it', idempotencyKey: K('m') });
    const arr = PURE.sanitizeAction({ action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE, proposal: [], idempotencyKey: K('m') });
    return missing.reasonCode === R.MISSING_PROPOSAL &&
      notObj.reasonCode === R.PROPOSAL_NOT_A_PLAIN_OBJECT &&
      arr.reasonCode === R.PROPOSAL_NOT_A_PLAIN_OBJECT;
  })());

check('B7 ★ 缺幂等键 → 拒绝（本层**不生成**一个：生成它就是把重复动作变成两次不同提议）',
  PURE.sanitizeAction({
    action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE, proposal: proposal(F_B)
  }).reasonCode === R.MISSING_IDEMPOTENCY_KEY &&
  PURE.sanitizeAction({
    action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE, proposal: proposal(F_B), idempotencyKey: '   '
  }).reasonCode === R.MISSING_IDEMPOTENCY_KEY,
  PURE.sanitizeAction({ action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE, proposal: proposal(F_B) }));

check('B8 ★ 动作层白名单外的键被**列名**拒绝（不是静默丢弃）',
  (() => {
    const s = PURE.sanitizeAction(Object.assign({}, OK_ACTION, { price: 1, autoAllow: true }));
    return s.ok === false && s.reasonCode === R.UNEXPECTED_ACTION_KEYS &&
      s.rejectedActionKeys.sort().join(',') === 'autoAllow,price' &&
      s.acceptedActionKeys.join(',') === 'action,proposal,idempotencyKey';
  })(),
  PURE.sanitizeAction(Object.assign({}, OK_ACTION, { price: 1, autoAllow: true })));

check('B9 净化器是纯的：同一输入两次得到同一结果，且它不持有任何状态',
  J(PURE.sanitizeAction(OK_ACTION).sanitized) === J(PURE.sanitizeAction(OK_ACTION).sanitized) &&
  Object.keys(PURE.sanitizeAction(OK_ACTION).sanitized).length === 4);

check('B10 ★ 适配器源码里**没有**第二份经济事实名单（那仍然是 P22-8 的 authority）',
  ['FORBIDDEN_PRODUCT_FIELDS', 'PURCHASE_INTENT_ECONOMIC_FACTS',
    'MODEL_SUPPLIED_ECONOMIC_FACT', 'unitPriceMinor', 'amountMinor', 'settlementType']
    .every(token => SRC_CODE.indexOf(token) < 0),
  ['MODEL_SUPPLIED_ECONOMIC_FACT', 'amountMinor', 'settlementType'].filter(t => SRC_CODE.indexOf(t) >= 0));

/* ══════════════════════════════════════════════════════════════════
   C · §4 模型无法偷渡经济事实（action 层 / proposal 层各一遍）
   ══════════════════════════════════════════════════════════════════ */
section('C · §4 模型不得提供价格 / Budget / Approval / settlement 等经济事实');

const SMUGGLED = [
  ['price', 1], ['amountMinor', 1], ['currency', 'IB_CREDIT'], ['budget', { dailyMinor: 999999999 }],
  ['approval', { approved: true }], ['autoAllow', true], ['settlementType', 'COMPUTE_GRANT'],
  ['wallet', 'econ_wallet_x'], ['ledger', { transactionId: 'econ_tx_x' }]
];

check('C1 ★ 九个偷渡键放在**动作层** → 一律被适配器列名拒绝，proposal 一个字都没发出去',
  SMUGGLED.every(([name, value]) => {
    const s = PURE.sanitizeAction(Object.assign({}, OK_ACTION, { [name]: value }));
    return s.ok === false && s.reasonCode === R.UNEXPECTED_ACTION_KEYS &&
      s.rejectedActionKeys.indexOf(name) >= 0;
  }),
  SMUGGLED.map(([n, v]) => PURE.sanitizeAction(Object.assign({}, OK_ACTION, { [n]: v })).reasonCode));

check('C2 ★ 九个偷渡键放进 **proposal** → 由 P22-8 拒绝，钱包与购买逐字不变',
  (() => {
    const store = makeStore('c2');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const before = walletMinor(store);
    const results = SMUGGLED.map(([name, value]) => adapter.performAction(actionOf(f, { [name]: value })));
    const allRejected = results.every(r => r.ok === false && r.purchaseId == null && r.ledgerMutation !== true);
    const factsRecognised = results
      .filter(r => r.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT)
      .flatMap(r => r.suppliedEconomicFacts || []);
    const unknownKeyed = results
      .filter(r => r.reasonCode !== C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT)
      .flatMap(r => r.unknownKeys || []);
    return allRejected &&
      /* 契约认识的八个（price/amountMinor/currency/autoAllow/settlementType …）
         走的是**信任边界违规**这条更严重的理由码，并逐名列出。 */
      factsRecognised.length >= 5 && factsRecognised.indexOf('price') >= 0 &&
      factsRecognised.indexOf('autoAllow') >= 0 && factsRecognised.indexOf('settlementType') >= 0 &&
      /* 契约不认识的（budget / approval / wallet / ledger 这种裸词）走
         "键不在白名单里" —— 也是拒绝，只是理由不同。 */
      unknownKeyed.length >= 1 &&
      store.listPurchaseIntents({}).count === 0 &&
      store.listPurchases({}).count === 0 &&
      walletMinor(store) === before;
  })(),
  (() => {
    const store = makeStore('c2d');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    return SMUGGLED.map(([n, v]) => {
      const r = adapter.performAction(actionOf(f, { [n]: v }));
      return { key: n, ok: r.ok, reasonCode: r.reasonCode, facts: r.suppliedEconomicFacts, unknown: r.unknownKeys };
    });
  })());

check('C3 ★ 被拒的原因来自 **P22-8**（reachedCapabilityGate 为真），不是适配器自己造的第二套判定',
  (() => {
    const store = makeStore('c3');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction(actionOf(f, { price: 1 }));
    return r.ok === false && r.reachedCapabilityGate === true &&
      r.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT &&
      r.refusedBy === undefined &&
      r.rejectedFieldsAreDerivedFromCanonicalFacts === true;
  })());

/* ══════════════════════════════════════════════════════════════════
   D · §3 拿不到 raw store，也拿不到任何底层动词
   ══════════════════════════════════════════════════════════════════ */
section('D · §3 只持有 bound handle（raw store 进不来 · 底层动词不可达）');

check('D1 ★★ createEconomyActionAdapter(economyStore) **构造期就抛** —— 传不进去',
  (() => {
    const store = makeStore('d1');
    try {
      ADAPTER.createEconomyActionAdapter(store);
      return false;
    } catch (error) {
      return /capability handle/.test(String(error && error.message)) &&
        /proposeAgentPurchaseIntent/.test(String(error && error.message));
    }
  })());

check('D2 ★ 传一棵别的对象（例如 gate 本身）同样抛 —— 它不是一个 capability handle',
  (() => {
    const store = makeStore('d2');
    const gate = createEconomyCapabilityGate({ store: store });
    try { ADAPTER.createEconomyActionAdapter(gate); return false; }
    catch (error) { return /proposePurchaseIntent/.test(String(error && error.message)); }
  })());

check('D3 ★ 句柄的键恰好五个，而且**没有** store；适配器把它原样收下（不转发任何别的成员）',
  (() => {
    const store = makeStore('d3');
    const { handle, adapter } = boundAdapter(store);
    return Object.keys(handle).sort().join(',') ===
      ['anchor', 'capabilities', 'consumer', 'proposePurchaseIntent', 'resumeApprovedPurchase'].sort().join(',') &&
      handle.store === undefined &&
      adapter.describe().holdsRawStore === false &&
      adapter.describe().holdsBoundCapabilityHandle === true &&
      adapter.describe().exposesLowLevelEconomyWrites === false &&
      adapter.describe().exposesGenericDispatch === false;
  })());

check('D4 ★★ 拒绝路径**一个句柄调用都不发**：用一个"一被调用就抛错"的句柄证伪',
  (() => {
    const tripwire = {
      consumer: C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME,
      anchor: 'test#tripwire',
      capabilities: [C.CAPABILITY.PROPOSE_PURCHASE],
      proposePurchaseIntent: () => { throw new Error('BYPASS: proposePurchaseIntent was reached on a refused action'); },
      resumeApprovedPurchase: () => { throw new Error('BYPASS: resumeApprovedPurchase was reached at all'); }
    };
    const adapter = ADAPTER.createEconomyActionAdapter(tripwire);
    const refused = adapter.performAction({ action: 'ECONOMY_BUY', proposal: {}, idempotencyKey: 'x' });
    let legalThrew = false;
    try { adapter.performAction(OK_ACTION); } catch (_) { legalThrew = true; }
    /* 前半：拒绝路径返回一条拒绝而不是抛错（说明它没碰句柄）；
       后半：合法动作**真的**碰到了句柄（说明这个探针是有效的，而不是
       一个永远不响的机关）。 */
    return refused.ok === false && refused.reasonCode === R.UNKNOWN_ACTION &&
      refused.proposedNothing === true && legalThrew === true;
  })());

check('D5 ★ 适配器源码里**没有任何一处**底层经济 mutation 的成员调用（settlePurchase / reserveFunds / ledger …）',
  ['settlePurchase', 'preparePurchase', 'reserveFunds', 'commitReservation',
    'mutateInventory', 'grantInventory', 'consumeInventory', 'commitLedgerTransaction',
    'mintForSystem', 'decideApproval', 'putAutonomyPolicy', 'proposeAgentPurchaseIntent']
    .every(verb => !(new RegExp('\\.\\s*' + verb + '\\s*\\(')).test(SRC_CODE)) &&
  /* 而且连 store 这个名字都不出现：没有 `store.` 形式的成员访问。 */
  !/\bstore\s*\./.test(SRC_CODE),
  ['settlePurchase', 'reserveFunds', 'mutateInventory', 'decideApproval']
    .filter(v => (new RegExp('\\.\\s*' + v + '\\s*\\(')).test(SRC_CODE)));

check('D6 ★ 适配器源码里**没有** resumeApprovedPurchase 这个成员名 —— 它连"能 resume"都不是一个可选分支',
  SRC_CODE.indexOf('resumeApprovedPurchase') < 0 &&
  !/\.\s*resumeApprovedPurchase\s*\(/.test(SRC_CODE));

/* ══════════════════════════════════════════════════════════════════
   E · §5 Action ≠ Authority（成功也只是一句"请求提出"）
   ══════════════════════════════════════════════════════════════════ */
section('E · §5 一次成功的动作**不是**购买授权');

check('E1 ★★ 成功的返回值上，七位（以及全部十四位）恒 false',
  (() => {
    const store = makeStore('e1');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction(actionOf(f));
    return Object.keys(ADAPTER.SELF_FALSE_BITS).every(k => r[k] === false) &&
      r.actionIsNotAuthority === true && r.actionSuccessIsNotAPurchase === true &&
      r.capabilityIsNotEconomyAuthority === true && r.economyDecisionStillPending === true &&
      /* ★ 只有真的走到句柄的出口才自述持有它。 */
      r.holdsBoundCapabilityHandle === true;
  })(),
  (() => {
    const store = makeStore('e1d');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction(actionOf(f));
    return Object.keys(ADAPTER.SELF_FALSE_BITS).filter(k => r[k] !== false);
  })());

check('E2 ★ 拒绝的返回值形状与成功**同一族**（同样带全部恒 false 位，且 proposedNothing 为真）',
  (() => {
    const r = PURE.performAction({ action: 'ECONOMY_SETTLE', proposal: {}, idempotencyKey: 'x' });
    return r.ok === false && r.refused === true && r.refusedBy === 'economy-action-adapter' &&
      r.proposedNothing === true && r.reachedCapabilityGate === false &&
      r.intentId === null && r.quoteId === null && r.approvalId === null && r.purchaseId === null &&
      Object.keys(ADAPTER.SELF_FALSE_BITS).every(k => r[k] === false);
  })());

check('E3 ★ 动作成功**不**跳过下游：返回值里带着 P22-7 的 authorityOutcome（那是权威说的，不是适配器说的）',
  (() => {
    const store = makeStore('e3');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction(actionOf(f));
    return r.ok === true && r.authorityOutcome === C.AP_DECISION.AUTO_ALLOW &&
      r.reachedCapabilityGate === true &&
      /* 适配器没有伪造也没有增删下游字段：P22-8/P22-6 的字段原样在。 */
      typeof r.intentId === 'string' && typeof r.purchaseId === 'string';
  })(),
  (() => {
    const store = makeStore('e3d');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction(actionOf(f));
    return { ok: r.ok, authorityOutcome: r.authorityOutcome, intentId: r.intentId, purchaseId: r.purchaseId };
  })());

/* ══════════════════════════════════════════════════════════════════
   F · §8 重复动作不重复购买（复用 P22-8，不另造 dedupe）
   ══════════════════════════════════════════════════════════════════ */
section('F · §8 模型复读同一动作 → 只发生一次经济动作');

check('F1 ★★ 同一动作调用两次（同一幂等身份）→ 第二次 replayed，库里有且只有一条 intent / 一笔购买',
  (() => {
    const store = makeStore('f1');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const action = actionOf(f, {}, undefined, K('f1'));   /* ★ 同一个动作对象，逐字复用 */
    const first = adapter.performAction(action);
    const second = adapter.performAction(action);
    return first.ok === true && second.ok === true &&
      second.replayed === true &&
      String(second.intentId) === String(first.intentId) &&
      store.listPurchaseIntents({}).count === 1 &&
      store.listPurchases({}).count === 1;
  })(),
  (() => {
    const store = makeStore('f1d');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const action = actionOf(f, {}, undefined, K('f1d'));
    const first = adapter.performAction(action);
    const second = adapter.performAction(action);
    return { first: first.intentId, second: second.intentId, replayed: second.replayed,
      intents: store.listPurchaseIntents({}).count, purchases: store.listPurchases({}).count };
  })());

check('F2 ★★ 换一个幂等键复读同一意图 → 由 **P22-8 的重复窗口**抑制（适配器没有第二套去重）',
  (() => {
    const store = makeStore('f2');
    const f = fixture(store, { unitPriceMinor: 10 });
    /* 停在 WAITING_APPROVAL：这是一条**非终态**的意图，正是"模型复读"的形态。 */
    autonomy(store, { approvalAboveMinor: 5 });
    const { adapter } = boundAdapter(store);
    const first = adapter.performAction(actionOf(f, {}, undefined, K('f2a')));
    const second = adapter.performAction(actionOf(f, {}, undefined, K('f2b')));
    /* ★ 抑制的那一条**没有**在库里留下新事实：它给出的 id 必须是那条
       **已经存在**的 intent（WAITING_APPROVAL），而不是一条新写的行。
       一个"抑制"若真的插了一行，下面的计数会变成 2。 */
    const named = second.intentId == null ? null : store.getPurchaseIntent({ agentIntentId: second.intentId });
    return first.ok === true && second.ok === true &&
      second.suppressed === true &&
      named !== null && named.ok === true &&
      named.intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL &&
      String(second.intentId) === String(first.intentId) &&
      store.listPurchaseIntents({}).count === 1 &&
      store.listPurchases({}).count === 0 &&
      store.listApprovals({}).count === 1;
  })(),
  (() => {
    const store = makeStore('f2d');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 5 });
    const { adapter } = boundAdapter(store);
    const first = adapter.performAction(actionOf(f, {}, undefined, K('f2da')));
    const second = adapter.performAction(actionOf(f, {}, undefined, K('f2db')));
    return { suppressed: second.suppressed, firstId: first.intentId, secondId: second.intentId,
      intents: store.listPurchaseIntents({}).count, purchases: store.listPurchases({}).count };
  })());

check('F3 ★ 适配器里**没有**任何去重状态：无表、无窗口、无缓存、无计数器',
  ['DEDUPE', 'dedupeWindow', 'WINDOW_MS', 'new Map(', 'new Set(', 'cache', 'seenKeys', 'recentActions']
    .every(token => SRC_CODE.indexOf(token) < 0),
  ['DEDUPE', 'new Map(', 'new Set(', 'cache'].filter(t => SRC_CODE.indexOf(t) >= 0));

check('F4 幂等身份由调用方逐字传入、逐字转发（适配器既不生成也不改写它）',
  (() => {
    const store = makeStore('f4');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const gate = createEconomyCapabilityGate({ store: store });
    const seen = [];
    const real = gate.bind(C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME);
    const spy = Object.freeze({
      consumer: real.consumer, anchor: real.anchor, capabilities: real.capabilities,
      resumeApprovedPurchase: real.resumeApprovedPurchase,
      proposePurchaseIntent: (input) => { seen.push(Object.keys(input).sort().join(',')); return real.proposePurchaseIntent(input); }
    });
    const adapter = ADAPTER.createEconomyActionAdapter(spy);
    const key = K('f4-exact');
    adapter.performAction(actionOf(f, {}, undefined, key));
    return seen.length === 1 && seen[0] === 'idempotencyKey,proposal';
  })());

/* ══════════════════════════════════════════════════════════════════
   G · P22-9 不可绕过 + 下游权威仍然完整
   ══════════════════════════════════════════════════════════════════ */
section('G · P22-9 不可绕过 · AUTO_ALLOW 仍走预算 · REQUIRE_APPROVAL 仍然停');

check('G1 ★★ 被拒的消费者经过适配器**仍然**由门拒绝（适配器不重新实现准入判定）',
  (() => {
    const store = makeStore('g1');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store, C.ECONOMY_CONSUMER.DESKTOP_BRIDGE);
    const r = adapter.performAction(actionOf(f));
    return r.ok === false && r.denied === true &&
      r.refusedBy === 'economy-capability-gate' &&
      r.gateDecision === C.CAPABILITY_DECISION.CAPABILITY_DENIED &&
      r.intentId === null && r.proposedNothing === true &&
      store.listPurchaseIntents({}).count === 0 &&
      store.listPurchases({}).count === 0;
  })(),
  (() => {
    const store = makeStore('g1d');
    const f = fixture(store, { unitPriceMinor: 10 });
    const { adapter } = boundAdapter(store, C.ECONOMY_CONSUMER.DESKTOP_BRIDGE);
    const r = adapter.performAction(actionOf(f));
    return { refusedBy: r.refusedBy, gateDecision: r.gateDecision, reasonCode: r.reasonCode,
      intents: store.listPurchaseIntents({}).count };
  })());

check('G2 ★ 未绑定句柄的适配器 = 什么都批不了（fail closed，并把责任说清楚）',
  (() => {
    const r = PURE.performAction(OK_ACTION);
    return r.ok === false && r.reasonCode === R.ADAPTER_NOT_BOUND &&
      r.refusedBy === 'economy-action-adapter' && r.reachedCapabilityGate === false &&
      /* ★ 也**不**自述持有句柄：一句"我有句柄"在没绑定的时候是假话。 */
      r.holdsBoundCapabilityHandle === false &&
      PURE.describe().holdsBoundCapabilityHandle === false;
  })(),
  PURE.performAction(OK_ACTION));

check('G3 ★★ AUTO_ALLOW 仍然走完 P22-6：钱真的动了，而且恰好一次',
  (() => {
    const store = makeStore('g3');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const before = walletMinor(store);
    const r = adapter.performAction(actionOf(f));
    const after = walletMinor(store);
    return r.ok === true && r.purchaseCreated === true &&
      store.listPurchases({}).count === 1 &&
      after !== before &&
      C.serializeAmountMinor(
        store.getWallet({ ownerId: AGENT, currency: CUR }).wallet.cachedBalanceMinor) === after;
  })(),
  (() => {
    const store = makeStore('g3d');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const before = walletMinor(store);
    const r = adapter.performAction(actionOf(f));
    return { before: before, after: walletMinor(store), purchases: store.listPurchases({}).count };
  })());

check('G4 ★★ AUTO_ALLOW + 预算说不 → 仍然被拦下：Intent FAILED、余额逐字不变、零购买',
  (() => {
    const store = makeStore('g4');
    const f = fixture(store, { unitPriceMinor: 10, limits: { perTransactionMinor: 5 } });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const before = walletMinor(store);
    const r = adapter.performAction(actionOf(f));
    const intent = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
    return r.gateDecision === C.CAPABILITY_DECISION.CAPABILITY_GRANTED &&
      intent.state === C.PURCHASE_INTENT_STATE.FAILED &&
      walletMinor(store) === before &&
      store.listPurchases({}).count === 0;
  })(),
  (() => {
    const store = makeStore('g4d');
    const f = fixture(store, { unitPriceMinor: 10, limits: { perTransactionMinor: 5 } });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const before = walletMinor(store);
    const r = adapter.performAction(actionOf(f));
    return { before: before, after: walletMinor(store), ok: r.ok,
      purchases: store.listPurchases({}).count };
  })());

check('G5 ★★ REQUIRE_APPROVAL 仍然停在 WAITING_APPROVAL：一分钱没动，而且批准是**运行时**创建的',
  (() => {
    const store = makeStore('g5');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 5 });
    const { adapter } = boundAdapter(store);
    const before = walletMinor(store);
    const r = adapter.performAction(actionOf(f));
    const intent = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
    return intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL &&
      r.purchaseCreated === false && r.reservedNothing === true &&
      intent.approvalId != null &&
      String(intent.approvalId).indexOf(C.ID_PREFIX.APPROVAL) === 0 &&
      store.listApprovals({}).count === 1 &&
      store.listPurchases({}).count === 0 &&
      walletMinor(store) === before;
  })(),
  (() => {
    const store = makeStore('g5d');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 5 });
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction(actionOf(f));
    const intent = store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
    return { state: intent.state, approvalId: intent.approvalId,
      purchases: store.listPurchases({}).count };
  })());

check('G6 ★ §9：模型**不可能**通过适配器发起 resume（那条动作被拒绝，且没有任何路径碰到它）',
  (() => {
    const store = makeStore('g6');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 5 });
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction({
      action: 'ECONOMY_RESUME_APPROVED_PURCHASE',
      proposal: { agentIntentId: 'econ_intent_x', approvalId: 'econ_approval_x' },
      idempotencyKey: K('g6')
    });
    /* 顺带证明：即使把 agentIntentId / approvalId 塞进动作，也没有任何东西被执行。 */
    return r.ok === false && r.reasonCode === R.NOT_OFFERED &&
      r.reachedCapabilityGate === false && r.proposedNothing === true &&
      store.listPurchaseIntents({}).count === 0 &&
      store.listApprovals({}).count === 0 &&
      store.listPurchases({}).count === 0;
  })(),
  (() => {
    const store = makeStore('g6d');
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction({
      action: 'ECONOMY_RESUME_APPROVED_PURCHASE',
      proposal: { agentIntentId: 'econ_intent_x' }, idempotencyKey: K('g6d')
    });
    return { ok: r.ok, reasonCode: r.reasonCode, intents: store.listPurchaseIntents({}).count };
  })());

check('G7 ★ 商品不存在时，门准了也照样被 P22-8 拒绝（适配器没有替经济做决定）',
  (() => {
    const store = makeStore('g7');
    const f = fixture(store, { unitPriceMinor: 10 });
    autonomy(store, { approvalAboveMinor: 100000 });
    const { adapter } = boundAdapter(store);
    const r = adapter.performAction(actionOf(f, { productId: 'econ_product_does_not_exist' }));
    return r.gateDecision === C.CAPABILITY_DECISION.CAPABILITY_GRANTED &&
      r.ok === false && r.reasonCode === C.DENY_REASON.PRODUCT_NOT_FOUND &&
      r.intentId == null && store.listPurchaseIntents({}).count === 0;
  })());

/* ══════════════════════════════════════════════════════════════════
   H · 全仓库唯一一次 bind（装配事实）
   ══════════════════════════════════════════════════════════════════ */
section('H · §6 只绑一个消费者（全仓库唯一一次 bind）');

function walkJs(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.dsh-research') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(abs, out);
    else if (/\.js$/i.test(entry.name)) out.push(path.relative(ROOT, abs).replace(/\\/g, '/'));
  }
  return out;
}

function readIfExists(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; }
}

check('H1 ★★ 全仓库生产代码里，只有**一个**文件调用 capability handle 的 proposePurchaseIntent',
  (() => {
    /* 与 P22-1 的 B18.3 同款纪律：一条边界要么可在整个仓库上断言，要么只是
       一个愿望。扫描目录与那边逐字相同（BYPASS_SCAN_DIRS）。 */
    const files = scanProduction(/\.\s*proposePurchaseIntent\s*\(/);
    return files.length === 1 && files[0] === ADAPTER_REL &&
      (SRC_CODE.match(/\.\s*proposePurchaseIntent\s*\(/g) || []).length === 1;
  })(),
  scanProduction(/\.\s*proposePurchaseIntent\s*\(/));

check('H2 ★★ 全仓库生产代码里 `gate.bind(<那个消费者>)` 恰好一次，而且就在适配器的装配助手里',
  (() => {
    /* ★ 不能笼统地数 `.bind(`：Function.prototype.bind 与 server.bind 到处都是，
       那种断言既会误报，也不会说出任何关于**门**的事情。要断言的是
       "谁 bind 了这扇门、绑的是谁"。 */
    const bindSites = scanProduction(/\.bind\s*\(\s*C\.ECONOMY_CONSUMER\.ACTIVE_AGENT_RUNTIME\s*\)/);
    const directSites = scanProduction(/economyCapabilityGate\.bind\s*\(/);
    return bindSites.length === 1 && bindSites[0] === ADAPTER_REL &&
      directSites.length === 0 &&
      /* 适配器自己也只有那一处（另一处是 `typeof gate.bind !== 'function'` 的形状守卫，
         它不是一次绑定）。 */
      (SRC_CODE.match(/\.bind\s*\(\s*C\.ECONOMY_CONSUMER/g) || []).length === 1;
  })(),
  { bind: scanProduction(/\.bind\s*\(\s*C\.ECONOMY_CONSUMER\.ACTIVE_AGENT_RUNTIME\s*\)/),
    direct: scanProduction(/economyCapabilityGate\.bind\s*\(/) });

check('H3 ★★ 门绑定的消费者是 P22-9 契约里那个有运行时锚点的消费者（而且只有一个）',
  ADAPTER.CONSUMER === C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME &&
  ADAPTER.CONSUMER === 'active_agent_runtime' &&
  C.CONSUMER_RUNTIME_ANCHOR[ADAPTER.CONSUMER] === 'runtime/component-registry.js#active' &&
  C.capabilitiesOfConsumer(ADAPTER.CONSUMER).indexOf(C.CAPABILITY.PROPOSE_PURCHASE) >= 0 &&
  C.capabilitiesOfConsumer(ADAPTER.CONSUMER).indexOf(C.CAPABILITY.RESUME_APPROVED_PURCHASE) >= 0,
  { consumer: ADAPTER.CONSUMER, anchor: C.CONSUMER_RUNTIME_ANCHOR[ADAPTER.CONSUMER] });

check('H4 ★ 适配器**没有**给任何别的消费者开句柄（describe() 只报一个 consumer）',
  (() => {
    const store = makeStore('h4');
    const { adapter } = boundAdapter(store);
    const d = adapter.describe();
    return d.consumer === 'active_agent_runtime' &&
      d.actions.length === 1 &&
      d.notOfferedActions.length === 1 &&
      d.noApprovalTriggerSeamExists === true &&
      d.resumeIsNotOffered === true &&
      /* ★ 别的 consumer 一个都没被绑定（P22-9 已证明它们不是 Node 运行时消费者）。 */
      C.ECONOMY_CONSUMERS.filter(id => id !== 'active_agent_runtime')
        .every(id => d.consumer !== id);
  })());

check('H5 ★ 适配器**没有**出现在任何 HTTP 路由上（HTTP 上的经济写面仍然为 0）',
  (() => {
    const httpSrc = readIfExists('services/home-node/http.js');
    return httpSrc.indexOf('economy-action-adapter') < 0 &&
      httpSrc.indexOf('economyActionAdapter') < 0 &&
      httpSrc.indexOf('performAction') < 0 &&
      /* 适配器自己有**零**个 HTTP/网络/进程原语。 */
      ["require('http')", 'require("http")', 'node:http', 'node:net', 'child_process',
        'fetch(', 'XMLHttpRequest', 'listen('].every(token => SRC_CODE.indexOf(token) < 0);
  })(),
  ["require('http')", 'node:http', 'node:net', 'child_process', 'fetch(']
    .filter(t => SRC_CODE.indexOf(t) >= 0));

check('H6 ★ 适配器的依赖闭包恰好是那份契约一个（没有 MCP / provider / 支付 / 凭据 / 购物）',
  (() => {
    const requires = (SRC_TARGETS.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || [])
      .map(s => s.replace(/[\s\S]*['"]([^'"]+)['"][\s\S]*/, '$1'));
    const forbidden = ['mcp.', 'alipay', 'credential-vault', 'commerce-adapter',
      'payment-auth', 'shopping-execution', 'pay-gate', 'bridge/'];
    return requires.length === 1 && requires[0] === './economy-contract.js' &&
      forbidden.every(token => SRC_TARGETS.indexOf(token) < 0);
  })(),
  (SRC_TARGETS.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || []));

/* ══════════════════════════════════════════════════════════════════
   I · 无万能入口（结构性，而不是纪律性）
   ══════════════════════════════════════════════════════════════════ */
section('I · §2/§3 不存在 economy(method,args) / executeEconomyAction(method,args)');

check('I1 ★★ 源码里对句柄的访问是**字面成员名**：没有任何 handle[...] 形式的计算型分派',
  !/\b(?:handle|boundHandle|h)\s*\[/.test(SRC_CODE) &&
  SRC_CODE.indexOf('executeEconomyAction') < 0 &&
  SRC_CODE.indexOf('executeAction') < 0 &&
  SRC_CODE.indexOf('dispatchAction') < 0 &&
  SRC_CODE.indexOf('runAction') < 0 &&
  /* ★ 反向自证：这句正则确实能抓到计算型分派（否则这是一条保护空气的断言）。 */
  /\b(?:handle|boundHandle|h)\s*\[/.test('handle[verb](args)') === true,
  (SRC_CODE.match(/\b(?:handle|boundHandle|h)\s*\[/g) || []));

check('I2 ★ 对句柄的调用恰好一处，而且是 proposePurchaseIntent（没有 resume / 没有第二次）',
  (SRC_CODE.match(/\.proposePurchaseIntent\(/g) || []).length === 1 &&
  SRC_CODE.indexOf('resumeApprovedPurchase') < 0,
  { propose: (SRC_CODE.match(/\.proposePurchaseIntent\(/g) || []).length,
    resume: SRC_CODE.indexOf('resumeApprovedPurchase') });

check('I3 ★ 没有第二个参数的入口：performAction 恰好一个参数，公开面里没有一个 "(verb, args)" 形状的函数',
  ADAPTER.createEconomyActionAdapter(null).performAction.length === 1 &&
  ADAPTER.createEconomyActionAdapter(null).sanitizeAction.length === 1 &&
  typeof ADAPTER.bindActiveAgentEconomyAdapter.length === 'number' &&
  ADAPTER.bindActiveAgentEconomyAdapter.length === 1 &&
  ADAPTER.createEconomyActionAdapter.length === 1,
  { perform: ADAPTER.createEconomyActionAdapter(null).performAction.length,
    sanitize: ADAPTER.createEconomyActionAdapter(null).sanitizeAction.length,
    create: ADAPTER.createEconomyActionAdapter.length,
    bind: ADAPTER.bindActiveAgentEconomyAdapter.length });

check('I4 适配器实例与 describe() 都是冻结的（消费者不能就地改造它）',
  Object.isFrozen(ADAPTER.createEconomyActionAdapter(null)) &&
  Object.isFrozen(ADAPTER.createEconomyActionAdapter(null).describe()) &&
  Object.isFrozen(ADAPTER.ACTION_LIST) &&
  Object.isFrozen(ADAPTER.NOT_OFFERED));

/* ══════════════════════════════════════════════════════════════════
   收尾 · 资源回收与自证（§12）
   ══════════════════════════════════════════════════════════════════ */
section('收尾 · 资源回收');

const TRIPWIRES = [
  path.join(ROOT, 'services', 'home-node', 'economy-action-adapter.js'),
  path.join(ROOT, 'services', 'home-node', 'economy-capability.js')
];
check('R0 本文件里加载的两个 Economy 模块都**没有** child_process / net / http',
  TRIPWIRES.every(abs => {
    const src = fs.readFileSync(abs, 'utf8');
    return ["require('child_process')", 'require("child_process")', "require('node:child_process')",
      "require('http')", "require('node:http')", "require('net')"].every(t => src.indexOf(t) < 0);
  }));

let leakedStores = 0;
openStores.forEach(s => { try { s.close(); } catch (_) { leakedStores += 1; } });
openStores.length = 0;
let leftoverDirs = 0;
tempDirs.forEach(d => {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { leftoverDirs += 1; }
  if (fs.existsSync(d)) leftoverDirs += 1;
});

check('R1 所有临时 store 都已关闭，临时目录已删除（没有遗留句柄与数据目录）',
  leakedStores === 0 && leftoverDirs === 0, { leakedStores: leakedStores, leftoverDirs: leftoverDirs });
check('R2 本文件没有加载 child_process（无从 spawn）',
  !Object.keys(require.cache).some(k => /[\\/]child_process\.js$/.test(k)),
  Object.keys(require.cache).filter(k => /[\\/]child_process\.js$/.test(k)));

console.log('\n' + '═'.repeat(64));
console.log('P22-10 action adapter · child processes spawned: 0 · max concurrent: 0 · leaked: 0');
console.log('P22-10 action adapter · 加载的主要模块: economy-contract / economy-store / economy-capability / economy-action-adapter');
if (failures === 0) {
  console.log('P22-10 action adapter: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-10 action adapter: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
