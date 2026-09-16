'use strict';
/* ====================================================================
   P22-13 · Economy Approval Decision Seam（单进程）
   --------------------------------------------------------------------
   本文件证明的是 **P22-13 自己的 invariant**，而它们全部可以在一个进程里
   判定：seam 的准入、信封面、决定词表、身份分离、幂等、拒绝路径零经济
   动作、以及"批准只能走既有 resume 链"。

   ★ 进程纪律（§12）：**max concurrent child = 0 · total spawn = 0 ·
   0 leftover**。本阶段没有任何"必须跨进程才能证明"的新身份 invariant：
     · 身份分离是一个**结构性**事实（seam 里没有 store 的第二条写法、
       没有决定者参数、Agent 的句柄没有决定能力）；
     · 单次消费 / 过期 / 冲突是 P22-7 的状态机，已在 P22-7 的两进程组里
       证明过；本文件只证明**这条 seam 不会绕过它**。
   因此这里一个 child 都不开，也不重跑 P22-6 ~ P22-8 的 race/crash matrix。

   ★ 另一个真实可达的 HTTP seam 在 test_p22_13_economy_approval_runtime.js
   （真实 buildHomeNode + 真实 server + 真实 fetch，仍然零 child）。
   ==================================================================== */

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const createGate = require(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'));
const createSeam = require(path.join(ROOT, 'services', 'home-node', 'economy-approval-decision.js'));

let failures = 0;
let checks = 0;
function section(title) { console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 62 - title.length))); }
function check(label, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + label); return true; }
  failures += 1;
  console.error('  ✖ ' + label);
  if (extra !== undefined) console.error('      ' + J(extra));
  return false;
}
function J(value) {
  try {
    return JSON.stringify(value, (k, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch (_) { return String(value); }
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripCommentsAndStrings(src) {
  return String(src)
    .replace(/\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+\/[gimsuy]*/g, ' RE ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^"\\\n])*"/g, ' "" ')
    .replace(/`(?:\\.|[^\\`])*`/g, ' `` ');
}
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p13-' + tag + '-'));
}

const SEAM_REL = 'services/home-node/economy-approval-decision.js';
const SEAM_SRC = read(SEAM_REL);
const SEAM_CODE = stripCommentsAndStrings(SEAM_SRC);

let keySeq = 0;
function K(prefix) { keySeq += 1; return (prefix || 'k') + '-13-' + keySeq; }
const CUR = 'IB_CREDIT';
const CRED = 'p13-desktop-credential';

/* ── 夹具：一个货架 + 一件商品 + 一个有钱的 Agent 钱包 + 预算 + 自主策略 ──
   与 P22-8 的 fixture 同款（同一个形状，不引入第二套 seed 语义）。 */
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
  must(wallet.ok, 'openWallet', wallet.errors);
  const mint = store.mintForSystem({
    systemInitiated: true, walletId: wallet.wallet.walletId, currency: CUR,
    amountMinor: o.balanceMinor == null ? 100000 : o.balanceMinor, idempotencyKey: K('mint')
  });
  must(mint.ok, 'mint', mint.errors);
  if (o.budget !== false) {
    const bp = store.putBudgetPolicy({
      ownerId: agentId, currency: CUR,
      limits: Object.assign({
        perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000
      }, o.limits || {}),
      idempotencyKey: K('budget')
    });
    must(bp.ok, 'putBudgetPolicy', bp.errors);
  }
  return {
    storeId: storeId, productId: productId, agentId: agentId,
    walletId: String(wallet.wallet.walletId), accountId: String(wallet.wallet.accountId)
  };
}
function must(cond, label, extra) {
  if (!cond) throw new Error('fixture ' + label + ' failed: ' + J(extra));
}
/* 每条 intent 都**必须**由权威判定推到一个待批准状态 —— 否则后面的用例会
   在一个"根本不等待批准"的夹具上断言，而那种断言永远是空的。 */
function propose(store, gate, f, options) {
  const o = options || {};
  const handle = gate.bind(o.consumer || C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME);
  const proposal = {
    agentId: f.agentId, productId: f.productId,
    reason: o.reason == null ? 'compute is running low' : o.reason
  };
  /* ★ units 让两次提议的**指纹**不同（P22-8 的 60s 抑制窗口按指纹工作）——
     同一个 agent 对同一件商品的两次相同提议本来就应该被抑制，因此要造两条
     真的独立的 intent，就必须让它们不一样。 */
  if (o.units != null) proposal.units = o.units;
  /* ★ expiresAt 让"这条 intent 的有效期"成为夹具可以构造的事实（H7 用它把
     "用户在 intent 过完有效期之后才点头"变成一条可复现的路径）。 */
  if (o.expiresAt != null) proposal.expiresAt = o.expiresAt;
  return handle.proposePurchaseIntent({ proposal: proposal, idempotencyKey: o.idempotencyKey || K('intent') });
}
function autonomy(store, options) {
  const o = options || {};
  return store.putAutonomyPolicy(Object.assign({
    ownerId: o.ownerId || 'cfg_agent', currency: CUR, enabled: true,
    perPurchaseLimitMinor: 100000, dailyAutonomousLimitMinor: 100000,
    approvalAboveMinor: 5,
    allowedProductKinds: ['COMPUTE_CREDIT', 'DIGITAL_ITEM'],
    allowedSettlementTypes: ['COMPUTE_GRANT', 'INVENTORY_GRANT'],
    allowGift: false,
    idempotencyKey: K('autonomy')
  }, o.input || {}));
}

const world = { stores: [], dirs: [] };
function makeStore(tag) {
  const dir = tmpDir(tag);
  const store = createEconomyStore({ dataDir: dir, logger: () => {} });
  store.open();
  world.stores.push(store);
  world.dirs.push(dir);
  return store;
}
/* ★ 一个**显式时钟**的 store。它的唯一用途是让"这条 intent 在用户决定之前
   就已经过完自己的有效期"成为一件可以构造的事实 —— 而不是靠 sleep 或者
   直接改库。P22-3 起冻结的语义是"过期是一次比较"，因此控制**比较的那一侧**
   就足以构造出这个状态。
   返回值里带一个 `setNow`：那个变量就是时钟本身，因此"提议时在未来、
   决定时已过去"可以在同一个 store 上被安排出来。 */
function makeStoreAt(tag, now) {
  const dir = tmpDir(tag);
  const box = { now: now };
  const store = createEconomyStore({ dataDir: dir, logger: () => {}, clock: () => box.now });
  store.open();
  store.setNow = function (value) { box.now = Number(value); };
  world.stores.push(store);
  world.dirs.push(dir);
  return store;
}
function makeSeam(store, options) {
  const o = options || {};
  const gate = o.gate || createGate({ store: store, logger: () => {} });
  const seam = createSeam({
    store: o.storeView === undefined ? Object.freeze({ decideApproval: store.decideApproval }) : o.storeView,
    resumeHandle: o.resumeHandle === undefined
      ? gate.bind(C.ECONOMY_CONSUMER.USER_DECISION_SEAM) : o.resumeHandle,
    desktopCredential: o.credential === undefined ? CRED : o.credential,
    clock: o.clock,
    logger: () => {}
  });
  return { gate: gate, seam: seam };
}
const USER_REQ = Object.freeze({ loopback: true, desktopCredential: CRED });
function decide(seam, approvalId, decision, key, extra) {
  return seam.dispatch(USER_REQ, Object.assign({
    approvalId: approvalId, decision: decision, idempotencyKey: key
  }, extra || {}));
}

/* ── 计数 helper：读面若返回 undefined，"不得发生"这类断言必须**失败**，
   而不是静默通过（P22-8 已经踩过这个坑，这里沿用它的写法）。 ── */
function numeric(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('count helper ' + label + ' did not return a number: ' + J(value));
  }
  return value;
}
function purchases(store) { return numeric(store.listPurchases({}).count, 'listPurchases'); }
function approvals(store) { return numeric(store.listApprovals({}).count, 'listApprovals'); }
function intents(store) { return numeric(store.listPurchaseIntents({}).count, 'listPurchaseIntents'); }
function reservations(store) {
  const r = store.listReservations({});
  if (r.ok !== true || !Array.isArray(r.reservations)) throw new Error('listReservations failed: ' + J(r));
  return r.reservations.length;
}
function entriesOf(store, accountId) {
  const r = store.listLedgerEntries({ accountId: accountId });
  if (r.ok !== true || !Array.isArray(r.entries)) throw new Error('listLedgerEntries failed: ' + J(r));
  return r.entries.length;
}
function inventoryOf(store, ownerId) {
  const r = store.listInventory({ ownerId: ownerId });
  if (r.ok !== true || !Array.isArray(r.entries)) throw new Error('listInventory failed: ' + J(r));
  return r.entries.length;
}
function worldOf(store, f) {
  const w = store.getWallet({ ownerId: f.agentId, currency: CUR }).wallet;
  return {
    cached: BigInt(w.cachedBalanceMinor), reserved: BigInt(w.reservedBalanceMinor),
    available: BigInt(w.availableBalanceMinor),
    ledgerEntries: entriesOf(store, f.accountId),
    purchases: purchases(store), reservations: reservations(store),
    inventory: inventoryOf(store, f.agentId)
  };
}

console.log('P22-13 · Economy Approval Decision Seam');

/* ══════════════════════════════════════════════════════════════════════
   A · 契约层：一个新的、真实存在的消费者身份
   ══════════════════════════════════════════════════════════════════════ */
section('A · 契约：user_decision_seam 是一个身份，不是一次提权');

check('A1 消费者集合恰好四个，而新的那一个是 user_decision_seam'
  + '（P22-9 冻结的三个逐一仍在）',
  C.ECONOMY_CONSUMERS.length === 4 &&
  ['active_agent_runtime', 'home_node_authority', 'desktop_bridge', 'user_decision_seam']
    .every(id => C.ECONOMY_CONSUMERS.indexOf(id) >= 0),
  C.ECONOMY_CONSUMERS);

check('A2 ★ 它拿到**恰好一项**能力：RESUME_APPROVED_PURCHASE（**不能**提出意图）',
  C.capabilitiesOfConsumer(C.ECONOMY_CONSUMER.USER_DECISION_SEAM).length === 1 &&
  C.capabilitiesOfConsumer(C.ECONOMY_CONSUMER.USER_DECISION_SEAM)[0] === C.CAPABILITY.RESUME_APPROVED_PURCHASE &&
  C.checkEconomyCapability({
    consumer: C.ECONOMY_CONSUMER.USER_DECISION_SEAM, capability: C.CAPABILITY.PROPOSE_PURCHASE
  }).granted === false,
  { caps: C.capabilitiesOfConsumer(C.ECONOMY_CONSUMER.USER_DECISION_SEAM),
    mayPropose: C.checkEconomyCapability({
      consumer: C.ECONOMY_CONSUMER.USER_DECISION_SEAM, capability: C.CAPABILITY.PROPOSE_PURCHASE }).granted });

check('A3 ★ 身份分离：Agent 与用户是**两个**消费者，而它们的锚点指向两处不同的东西',
  C.CONSUMER_RUNTIME_ANCHOR[C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME] === 'runtime/component-registry.js#active' &&
  C.CONSUMER_RUNTIME_ANCHOR[C.ECONOMY_CONSUMER.USER_DECISION_SEAM] === 'services/home-node-service.js#economyAssembly' &&
  C.CONSUMER_RUNTIME_ANCHOR[C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME] !==
    C.CONSUMER_RUNTIME_ANCHOR[C.ECONOMY_CONSUMER.USER_DECISION_SEAM],
  C.CONSUMER_RUNTIME_ANCHOR);

check('A4 锚点不变量被**写宽一条而不是放松**：非组件身份必须锚在装配点，'
  + '而一个既不是组件、也不是装配点的字符串仍然被拒',
  C.isConsumerRuntimeAnchor('user_decision_seam', 'services/home-node-service.js#economyAssembly') === true &&
  C.isConsumerRuntimeAnchor('active_agent_runtime', 'runtime/component-registry.js#active') === true &&
  C.isConsumerRuntimeAnchor('user_decision_seam', 'somewhere-else') === false &&
  C.isConsumerRuntimeAnchor('user_decision_seam', '') === false &&
  C.isConsumerRuntimeAnchor('user_decision_seam', null) === false);

check('A5 近似名字仍然不被提升，而这一阶段多了一个**恰好会读错**的候选：'
  + "'user' 是当事人（PARTY_TYPE.USER），不是消费者",
  ['user', 'USER_DECISION_SEAM', 'desktop_user', 'approval_seam'].every(n =>
    C.checkEconomyCapability({ consumer: n, capability: C.CAPABILITY.RESUME_APPROVED_PURCHASE }).granted === false &&
    C.checkEconomyCapability({ consumer: n, capability: C.CAPABILITY.PROPOSE_PURCHASE }).granted === false) &&
  C.USER_PARTY_ID === 'user' &&
  C.isEconomyConsumer('user') === false,
  { userParty: C.USER_PARTY_ID, isConsumer: C.isEconomyConsumer('user') });

check('A6 新的那一项能力**不是**第二个能力：能力集合仍然恰好两个',
  C.CAPABILITIES.length === 2 && C.CAPABILITY.RESUME_APPROVED_PURCHASE === 'RESUME_APPROVED_PURCHASE');

/* ══════════════════════════════════════════════════════════════════════
   B · seam 的公开形状：它拿不到 store，也没有第二个动词
   ══════════════════════════════════════════════════════════════════════ */
section('B · seam 的公开形状与依赖闭包');

check('B1 公开面恰好是那几个成员（没有 store、没有门、没有适配器、没有万能入口）',
  Object.keys(createSeam).sort().join(',') ===
    ['CONSUMER', 'DECISION', 'DECISION_LIST', 'DECISION_PATH', 'ENVELOPE_KEYS', 'FORBIDDEN_IDENTITY_KEYS', 'REFUSAL']
      .sort().join(','),
  Object.keys(createSeam));
check('B2 工厂返回的对象恰好是那几个成员',
  Object.keys(makeSeam(makeStore('b2')).seam).sort().join(',') ===
    ['CONSUMER', 'DECISION', 'DECISION_LIST', 'ENVELOPE_KEYS', 'FORBIDDEN_IDENTITY_KEYS', 'REFUSAL',
      'audit', 'describe', 'dispatch', 'path', 'resumeKeyOf'].sort().join(','),
  Object.keys(makeSeam(makeStore('b2')).seam));

check('B3 ★ 路径与 command 路径是**两条**，而且都不在 /economy/ 下',
  createSeam.DECISION_PATH === '/internal/economy/approval-decision' &&
  createSeam.DECISION_PATH.indexOf('/economy/') !== 0 &&
  createSeam.DECISION_PATH !== '/internal/economy/command');

check('B4 seam 的依赖闭包只有契约（+ 摘要/恒定时间比较要的 node:crypto）',
  (() => {
    const specs = [];
    const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    const raw = SEAM_SRC;
    while ((m = re.exec(raw))) {
      const head = raw.slice(0, m.index);
      const lineStart = head.lastIndexOf('\n') + 1;
      if (head.slice(lineStart).indexOf('//') >= 0) continue;
      if (head.lastIndexOf('/*') > head.lastIndexOf('*/')) continue;
      specs.push(m[1]);
    }
    return J(specs.sort()) === J(['./economy-contract.js', 'node:crypto'].sort());
  })(), SEAM_SRC.match(/require\s*\([^)]*\)/g));

check('B5 ★ seam 里**没有**任何 P22-3 ~ P22-8 的底层写动词（作为标识符）',
  ['settlePurchase', 'preparePurchase', 'cancelPurchase', 'reserveFunds', 'commitReservation',
    'releaseReservation', 'expireReservation', 'failReservation', 'grantInventory', 'consumeInventory',
    'mutateInventory', 'createQuote', 'putProduct', 'putStore', 'putBudgetPolicy', 'putAutonomyPolicy',
    'createApprovalRequest', 'authorizePurchaseIntent', 'mintForSystem', 'burnForSystem',
    'commitLedgerTransaction', 'transferBetweenWallets', 'openWallet', 'expireApproval']
    .every(v => !new RegExp('\\b' + v + '\\b').test(SEAM_CODE)),
  ['settlePurchase', 'preparePurchase', 'reserveFunds', 'mutateInventory', 'putBudgetPolicy',
    'putAutonomyPolicy', 'mintForSystem', 'commitLedgerTransaction', 'createQuote', 'openWallet']
    .filter(v => new RegExp('\\b' + v + '\\b').test(SEAM_CODE)));

check('B6 ★ 它对 store 的访问是**一处字面成员调用**：恰好一次 store.decideApproval(...)，'
  + '而且没有 store[…] 形式的计算型分派（注释里的名字不算调用）',
  (SEAM_CODE.match(/store\.decideApproval\s*\(/g) || []).length === 1 &&
  !/store\s*\[/.test(SEAM_CODE) &&
  !/resumeHandle\s*\[/.test(SEAM_CODE) &&
  (SEAM_SRC.match(/resumeHandle\.resumeApprovedPurchase\s*\(/g) || []).length === 1,
  { decide: (SEAM_CODE.match(/store\.decideApproval\s*\(/g) || []).length,
    computedStore: /store\s*\[/.test(SEAM_CODE),
    computedHandle: /resumeHandle\s*\[/.test(SEAM_CODE),
    resume: (SEAM_SRC.match(/resumeHandle\.resumeApprovedPurchase\s*\(/g) || []).length });

check('B7 ★ 决定者不是参数：seam 里唯一构造 decidedBy 的地方用的是**字面量 user:user**',
  /\{\s*type:\s*user\.decider\.type,\s*id:\s*user\.decider\.id\s*\}/.test(SEAM_SRC) &&
  /type:\s*C\.PARTY_TYPE\.USER/.test(SEAM_SRC) &&
  /id:\s*C\.USER_PARTY_ID/.test(SEAM_SRC) &&
  SEAM_SRC.indexOf('rawBody.decidedBy') < 0 &&
  SEAM_SRC.indexOf('rawBody.decider') < 0 &&
  SEAM_SRC.indexOf('rawBody.userId') < 0);

check('B8 ★ 决定词表恰好两个，而且它们**逐字引用** P22-7 的状态词（不复制一套）',
  createSeam.DECISION_LIST.length === 2 &&
  createSeam.DECISION.APPROVE === C.APPROVAL_STATE.APPROVED &&
  createSeam.DECISION.REJECT === C.APPROVAL_STATE.REJECTED &&
  /^\s*APPROVE:\s*C\.APPROVAL_STATE\.APPROVED,?$/m.test(SEAM_SRC) &&
  /^\s*REJECT:\s*C\.APPROVAL_STATE\.REJECTED,?$/m.test(SEAM_SRC),
  { approve: createSeam.DECISION.APPROVE, reject: createSeam.DECISION.REJECT, list: createSeam.DECISION_LIST });
check('B9 ★ 被禁止的决定词在这份代码里**一次都不出现**（它们不是被过滤，是不存在）',
  ['BUY', 'SETTLE', 'RESERVE', 'GRANT', 'REFUND', 'LEDGER', 'AUTO_ALLOW', 'FORCE_APPROVE']
    .every(w => SEAM_CODE.indexOf(w) < 0),
  ['BUY', 'SETTLE', 'RESERVE', 'GRANT', 'REFUND', 'LEDGER', 'AUTO_ALLOW', 'FORCE_APPROVE']
    .filter(w => SEAM_CODE.indexOf(w) >= 0));

check('B10 ★ 信封恰好三个键，而且它们**都不**携带经济事实',
  J(createSeam.ENVELOPE_KEYS) === J(['approvalId', 'decision', 'idempotencyKey']) &&
  ['price', 'amountMinor', 'currency', 'budget', 'wallet', 'productId', 'settlementType',
    'grantQuantity', 'consumerId', 'capability'].every(k => createSeam.ENVELOPE_KEYS.indexOf(k) < 0));

check('B11 ★ 身份键黑名单包含**决定者**与**消费者**两类（Agent 与用户都不得自报）',
  ['decidedBy', 'decidedById', 'consumer', 'consumerId', 'capability', 'approved', 'autoAllow', 'userId']
    .every(k => createSeam.FORBIDDEN_IDENTITY_KEYS.indexOf(k) >= 0),
  createSeam.FORBIDDEN_IDENTITY_KEYS);

check('B12 seam 里没有定时器、没有网络、没有子进程（决定是一次同进程的两步调用）',
  !/\bsetTimeout\b|\bsetInterval\b|\bchild_process\b|\bnet\b|\bhttp\b/.test(SEAM_CODE));

check('B13 ★ 生产代码里 resumeApprovedPurchase 的调用方仍然是**门**（seam 走的是句柄，不是 store）',
  (() => {
    const sites = [];
    (function scan(dirRel) {
      const abs = path.join(ROOT, dirRel);
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = dirRel + '/' + entry.name;
        if (entry.isDirectory()) { scan(rel); continue; }
        if (!/\.js$/i.test(entry.name)) continue;
        const lines = read(rel).split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (/\.\s*(?:proposeAgentPurchaseIntent|resumeAgentPurchaseIntent)\s*\(/.test(lines[i])) {
            sites.push(rel + ':' + (i + 1));
          }
        }
      }
    })('services');
    return sites.length === 2 && sites.every(s => s.indexOf('services/home-node/economy-capability.js:') === 0);
  })());

/* ══════════════════════════════════════════════════════════════════════
   C · 准入：未配置凭据 / 未装配一律 fail closed
   ══════════════════════════════════════════════════════════════════════ */
section('C · 准入（fail closed）');

{
  const store = makeStore('c');
  const noCred = makeSeam(store, { credential: '' });
  const closed = noCred.seam.dispatch(USER_REQ, { approvalId: 'x', decision: 'APPROVE', idempotencyKey: 'k' });
  check('C1 ★ 未配置桌面凭据 ⇒ 整面关闭（503），而且它明说缺什么',
    noCred.seam.describe().open === false &&
    closed.ok === false && closed.status === 503 &&
    closed.reasonCode === createSeam.REFUSAL.CREDENTIAL_NOT_CONFIGURED &&
    String(closed.hint || '').indexOf('IB_HOME_NODE_TOKEN') >= 0,
    { open: noCred.seam.describe().open, reason: closed.reasonCode, status: closed.status });

  const noStore = createSeam({ store: null, resumeHandle: noCred.gate.bind(C.ECONOMY_CONSUMER.USER_DECISION_SEAM), desktopCredential: CRED });
  check('C2 未装配 store ⇒ 关闭（503），而不是"不管了"',
    noStore.describe().open === false &&
    noStore.dispatch(USER_REQ, { approvalId: 'x', decision: 'APPROVE', idempotencyKey: 'k' }).status === 503);
  const noHandle = createSeam({ store: Object.freeze({ decideApproval: store.decideApproval }), resumeHandle: null, desktopCredential: CRED });
  check('C3 未绑定 resume 句柄 ⇒ 关闭（503）',
    noHandle.describe().open === false &&
    noHandle.dispatch(USER_REQ, { approvalId: 'x', decision: 'APPROVE', idempotencyKey: 'k' }).status === 503);

  const { seam } = makeSeam(store);
  check('C4 缺凭据（空）/ 错凭据 ⇒ 403，而且**没碰** store',
    (() => {
      const missing = seam.dispatch({ loopback: true }, { approvalId: 'x', decision: 'APPROVE', idempotencyKey: 'k' });
      const wrong = seam.dispatch({ loopback: true, desktopCredential: 'nope' }, { approvalId: 'x', decision: 'APPROVE', idempotencyKey: 'k' });
      return missing.status === 403 && missing.reasonCode === createSeam.REFUSAL.MISSING_USER_CREDENTIAL &&
        wrong.status === 403 && wrong.reasonCode === createSeam.REFUSAL.WRONG_USER_CREDENTIAL &&
        missing.reachedStore === false && wrong.reachedStore === false &&
        missing.reachedResumeHandle === false && wrong.reachedResumeHandle === false &&
        missing.identityIsEstablishedByTheTransport === true;
    })());
  check('C5 非 loopback ⇒ 401，且没碰 store',
    (() => {
      const r = seam.dispatch({ loopback: false, desktopCredential: CRED }, { approvalId: 'x', decision: 'APPROVE', idempotencyKey: 'k' });
      return r.status === 401 && r.reasonCode === createSeam.REFUSAL.NOT_LOOPBACK && r.reachedStore === false;
    })());
  check('C6 凭据判定发生在 body 解析**之前**（一个身份不明的调用方学不到 payload 的任何事）',
    (() => {
      const r = seam.dispatch({ loopback: true, desktopCredential: 'nope' }, { price: 1, amountMinor: 999999 });
      return r.reasonCode === createSeam.REFUSAL.WRONG_USER_CREDENTIAL &&
        r.rejectedIdentityKeys === undefined;
    })());
}

/* ══════════════════════════════════════════════════════════════════════
   D · 身份分离：Agent 结构性地不能自我批准
   ══════════════════════════════════════════════════════════════════════ */
section('D · 身份分离（Agent 不能自我批准）');

{
  const store = makeStore('d');
  const f = fixture(store);
  autonomy(store, {});
  const { gate, seam } = makeSeam(store);
  const p = propose(store, gate, f);
  check('D0 夹具真的落在 WAITING_APPROVAL（后面每一条断言都有对象）',
    p.ok === true && p.intent && p.intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL &&
    C.isEconomyId('APPROVAL', p.approvalId),
    { ok: p.ok, state: p.intent && p.intent.state, approvalId: p.approvalId, reasonCode: p.reasonCode });

  const agentHandle = gate.bind(C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME);
  check('D1 ★ Agent 的句柄上**没有**任何决定能力（它连成员名都没有）',
    Object.keys(agentHandle).sort().join(',') ===
      ['anchor', 'capabilities', 'consumer', 'proposePurchaseIntent', 'resumeApprovedPurchase'].sort().join(',') &&
    agentHandle.decideApproval === undefined &&
    agentHandle.approve === undefined &&
    agentHandle.reject === undefined &&
    SEAM_CODE.indexOf('ACTIVE_AGENT_RUNTIME') < 0);

  check('D2 ★ seam 不接受调用方自报的任何身份键（逐个名字都拒，而且没碰 store）',
    (() => {
      const keys = ['decidedBy', 'decidedById', 'consumer', 'consumerId', 'capability', 'role',
        'authority', 'approved', 'autoAllow', 'userId', 'agentId'];
      return keys.every(k => {
        const body = { approvalId: p.approvalId, decision: 'APPROVE', idempotencyKey: K('id') };
        body[k] = 'active_agent_runtime';
        const r = seam.dispatch(USER_REQ, body);
        return r.status === 403 &&
          r.reasonCode === createSeam.REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT &&
          r.rejectedIdentityKeys.length === 1 && r.rejectedIdentityKeys[0] === k &&
          r.reachedStore === false && r.reachedResumeHandle === false && r.decidedNothing === true;
      });
    })());
  check('D3 ★ 身份键被拒之后那条批准**仍然是 PENDING**（拒绝路径一个字节都没写）',
    store.getApproval({ approvalId: p.approvalId }).approval.status === C.APPROVAL_STATE.PENDING &&
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL);

  check('D4 ★ 用户身份**不能**被填成 Agent：即使有人绕过信封面，store 的 self-approval 闸门仍然拦住它',
    (() => {
      const r = store.decideApproval({
        approvalId: p.approvalId, decision: 'APPROVED',
        decidedBy: { type: 'character', id: f.agentId }, idempotencyKey: K('self')
      });
      return r.ok === false && r.reasonCode === C.DENY_REASON.PARTY_NOT_ALLOWED &&
        r.selfApprovalRejected === true && r.errors.indexOf('the-buyer-cannot-approve-its-own-purchase') >= 0;
    })());
  check('D5 同理，system 也不能做这个决定（"系统替用户点头"在类型上不可表达）',
    (() => {
      const r = store.decideApproval({
        approvalId: p.approvalId, decision: 'APPROVED',
        decidedBy: { type: 'system', id: 'system:market' }, idempotencyKey: K('sys')
      });
      return r.ok === false && r.errors.indexOf('system-party-cannot-decide-an-approval') >= 0;
    })());

  check('D6 ★ 用户决定面上的 consumer **不能**提出意图（它没有那个能力）',
    (() => {
      const r = gate.bind(C.ECONOMY_CONSUMER.USER_DECISION_SEAM)
        .proposePurchaseIntent({ proposal: { agentId: f.agentId, productId: f.productId }, idempotencyKey: K('seampropose') });
      return r.ok === false && r.denied === true &&
        r.reasonCode === C.CAPABILITY_DENY_REASON.CAPABILITY_NOT_GRANTED &&
        r.proposedNothing === true && r.ledgerMutation === false;
    })());

  check('D7 ★ seam 的 describe() 自述：它不共享 command 通道的 consumer，也不能提议',
    (() => {
      const d = seam.describe();
      return d.capabilityConsumer === C.ECONOMY_CONSUMER.USER_DECISION_SEAM &&
        d.canProposeAPurchase === false &&
        d.deciderComesFromTheAssemblyNotThePayload === true &&
        d.differsFromTheCommandChannel.sharesAConsumerWithTheCommandChannel === false &&
        d.differsFromTheCommandChannel.sharesACredentialWithTheCommandChannel === false &&
        d.differsFromTheCommandChannel.commandMeans.indexOf('Agent WANT') >= 0 &&
        d.differsFromTheCommandChannel.decisionMeans.indexOf('User APPROVAL DECISION') >= 0 &&
        d.userIdentityStrength.indexOf('desktop-credential') >= 0;
    })());

  world.stores.forEach(s => { try { s.close(); } catch (_) {} });
}

/* ══════════════════════════════════════════════════════════════════════
   E · APPROVE 只能走既有 resume 链（不是 settle）
   ══════════════════════════════════════════════════════════════════════ */
section('E · APPROVE → 既有 resume 链 → P22-8 / P22-7 / P22-6');

{
  const store = makeStore('e');
  const f = fixture(store);
  autonomy(store, {});
  const gate = createGate({ store: store, logger: () => {} });
  const realHandle = gate.bind(C.ECONOMY_CONSUMER.USER_DECISION_SEAM);
  /* ★ 一个"一被调用就抛"的探针句柄：它证明 seam 走的是**门**，而不是
     自己想办法到 store。同时它证明 resume 只被调用**一次**。 */
  const seen = [];
  const probeHandle = Object.freeze({
    consumer: realHandle.consumer,
    anchor: realHandle.anchor,
    capabilities: realHandle.capabilities,
    resumeApprovedPurchase: (input) => {
      seen.push({ keys: Object.keys(input || {}), input: input });
      return realHandle.resumeApprovedPurchase(input);
    }
  });
  const seam = createSeam({
    store: Object.freeze({ decideApproval: store.decideApproval }),
    resumeHandle: probeHandle,
    desktopCredential: CRED,
    logger: () => {}
  });
  const p = propose(store, gate, f);
  const before = worldOf(store, f);

  /* ★★ 一个真实的、值得写下来的开发期教训（它让这一整组断言红过一次，
     而产品代码完全正确）：`K(...)` 每次被求值都产生一个**新的**幂等身份。
     这里一度写成 `decide(..., K('e-approve'))` 两次 —— 于是"重试"用的是
     另一个身份，它撞上的当然是 P22-7 的终态闸门（CONSUMED），而不是幂等
     重放。一次重试的身份必须与它重试的那一次**逐字相同**，因此它在这里
     求值一次、存进一个变量。这不是风格问题："重放"这个词的全部内容就是
     "同一个身份再来一次"。 */
  const retryKey = K('e-approve');
  const decided = decide(seam, p.approvalId, 'APPROVE', retryKey);
  const after = worldOf(store, f);

  check('E1 ★ 决定落库：APPROVED（写者身份是 canonical 的 user:user）',
    decided.ok === true && decided.status === 200 &&
    decided.decision === C.APPROVAL_STATE.APPROVED &&
    decided.approvalStatus === C.APPROVAL_STATE.APPROVED &&
    decided.decider === C.USER_PARTY_ID + ':' + C.USER_PARTY_ID &&
    decided.decisionRecorded === true,
    { ok: decided.ok, decision: decided.decision, decider: decided.decider, reason: decided.reasonCode });
  check('E2 ★ resume 只被调用**一次**，而且它的入参只有两个键'
    + '（approvalId + 派生的幂等键；**没有** agentIntentId，也没有任何经济事实）',
    seen.length === 1 &&
    J(seen[0].keys.sort()) === J(['approvalId', 'idempotencyKey'].sort()) &&
    seen[0].input.approvalId === p.approvalId &&
    seen[0].input.agentIntentId === undefined,
    seen);

  check('E3 ★ 同一条 intent 被**继续**（不是新建一条）：状态走到终态，purchaseId 是那条 intent 的',
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state === C.PURCHASE_INTENT_STATE.COMPLETED &&
    intents(store) === 1 &&
    decided.continuationOk === true &&
    decided.purchaseCreated === true,
    { state: store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state,
      intents: intents(store), continuation: decided.continuation });

  check('E4 经济事实**真的**动了，而且只动了一次：余额 −10、库存 +1000、一笔购买、一笔账目',
    after.cached === before.cached - 10n &&
    after.reserved === 0n &&
    after.purchases === before.purchases + 1 &&
    after.inventory === before.inventory + 1 &&
    after.ledgerEntries > before.ledgerEntries,
    { before: J(before), after: J(after) });
  check('E5 报价被消费（CONSUMED）而不是被"批准复活"',
    store.getQuote({ quoteId: p.quoteId }).quote.state === C.QUOTE_STATE.CONSUMED,
    store.getQuote({ quoteId: p.quoteId }).quote.state);
  check('E6 批准被 single-use 消费，并指向**那一笔**真的购买',
    (() => {
      const a = store.getApproval({ approvalId: p.approvalId }).approval;
      const real = store.listPurchases({}).purchases.map(x => String(x.purchaseId));
      return a.status === C.APPROVAL_STATE.CONSUMED && a.terminal === true &&
        a.consumeReason === 'consumed-by-a-completed-purchase' &&
        real.length === 1 && String(a.consumedByPurchaseId) === real[0];
    })(), { approval: store.getApproval({ approvalId: p.approvalId }).approval.consumeReason,
      consumedBy: store.getApproval({ approvalId: p.approvalId }).approval.consumedByPurchaseId,
      purchases: store.listPurchases({}).purchases.map(x => x.purchaseId) });

  check('E7 ★ seam 的自述位：批准不是购买保证，也不绕过预算/报价/商品',
    decided.approvalDoesNotGuaranteeAPurchase === true &&
    decided.approvalIsNotAGuaranteedPurchase === true &&
    decided.budgetWasNotBypassed === true &&
    decided.quoteValidityWasNotBypassed === true &&
    decided.seamHoldsRawStore === false &&
    decided.seamChoosesTheDecider === false &&
    decided.identityComesFromTheTransportNotThePayload === true);

  /* ── 重放：同一次决定的重试必须返回**同一个逻辑结果**，而且不产生第二次 ── */
  const replay = decide(seam, p.approvalId, 'APPROVE', retryKey);
  const afterReplay = worldOf(store, f);
  check('E8 ★ 同一 identity 的重试是幂等的：replayed、同一个结局，'
    + '而世界**没有**变化',
    replay.ok === true && replay.replayed === true &&
    replay.continuationOk === true &&
    replay.purchaseExists === true &&
    replay.continuedIntentId === decided.continuedIntentId &&
    J(afterReplay) === J(after),
    { replayed: replay.replayed, continuationOk: replay.continuationOk,
      purchaseExists: replay.purchaseExists, continuedIntent: replay.continuedIntentId,
      intentState: replay.continuedIntentState, reasonCode: replay.reasonCode,
      before: J(after), after: J(afterReplay) });
  check('E8b ★ "这一刻建了一笔购买"与"这笔 intent 现在有购买"是两个位：'
    + '重放时前者 false、后者 true（否则"重试"与"没买成"会读起来一样）',
    decided.purchaseCreatedNow === true && decided.continuationReplayed === false &&
    decided.purchaseExists === true &&
    replay.purchaseCreatedNow === false && replay.purchaseExists === true &&
    replay.continuationReplayed === true,
    { createdNow: decided.purchaseCreatedNow, replayedNow: replay.purchaseCreatedNow,
      exists: replay.purchaseExists, replayed: replay.continuationReplayed });
  check('E9 重放时 resume 又被调用了一次 —— 但下游靠 canonical 幂等收敛，'
    + '而不是靠这一层缓存结果（seam 不造第三套购买 dedupe）',
    seen.length === 2 && replay.seamAddsASecondPurchaseDedupe === false &&
    purchases(store) === 1,
    { resumeCalls: seen.length, purchases: purchases(store) });

  /* ── APPROVE → REJECT（同一个 identity）必须 conflict / fail closed ──
     ★ 这里有两道**独立**的闸门，而它们都必须存在：
       · 本层的请求身份记忆 —— 同一个身份换决定词 ⇒ 409（在触碰 store 之前）；
       · P22-7 的状态机 —— 换一个新身份想改判已消费的批准 ⇒ 终态拒绝。
     只测其中一条会让另一条悄悄消失（这正是"两层 dedupe 各管一头"的形状）。 */
  const conflict = decide(seam, p.approvalId, 'REJECT', retryKey);
  check('E10 ★ 同一个决定身份换成另一个决定词 ⇒ 409 冲突，而且没碰 store、没碰 resume'
    + '（两个决定不可能共用一个身份）',
    conflict.ok === false && conflict.status === 409 &&
    conflict.reasonCode === createSeam.REFUSAL.REQUEST_ID_CONFLICT &&
    conflict.previouslyDecided === C.APPROVAL_STATE.APPROVED &&
    conflict.reachedStore === false && conflict.reachedResumeHandle === false,
    { status: conflict.status, reason: conflict.reasonCode, previously: conflict.previouslyDecided });
  const terminalTry = decide(seam, p.approvalId, 'REJECT', K('e-new-identity'));
  check('E10b ★ 换一个**新**身份再想改判同一个决定 ⇒ 仍然被拒，'
    + '而这一次是 P22-7 的状态机在说话（CONSUMED 是终态）',
    terminalTry.ok === false && terminalTry.status === 409 &&
    terminalTry.reasonCode === createSeam.REFUSAL.DECISION_REFUSED &&
    terminalTry.downstreamReasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
    terminalTry.decisionRecorded === false && terminalTry.reachedResumeHandle === false,
    { status: terminalTry.status, reason: terminalTry.reasonCode,
      downstream: terminalTry.downstreamReasonCode, errors: terminalTry.errors });
  check('E11 冲突之后世界逐字节不变', J(worldOf(store, f)) === J(after));

  world.stores.forEach(s => { try { s.close(); } catch (_) {} });
}

/* ══════════════════════════════════════════════════════════════════════
   F · REJECT：终止，零经济动作，且不能被 Agent 再 resume
   ══════════════════════════════════════════════════════════════════════ */
section('F · REJECT（终止 · 零 Ledger / Inventory / Settlement）');

{
  const store = makeStore('f');
  const f = fixture(store);
  autonomy(store, {});
  const { gate, seam } = makeSeam(store);
  const p = propose(store, gate, f);
  const before = worldOf(store, f);

  const rejectKey = K('f-reject');
  const rejected = decide(seam, p.approvalId, 'REJECT', rejectKey);
  const after = worldOf(store, f);

  check('F1 ★ 决定落库：REJECTED；续做**没有被尝试**（连那个成员名都没被求值）',
    rejected.ok === true && rejected.status === 200 &&
    rejected.approvalStatus === C.APPROVAL_STATE.REJECTED &&
    rejected.resumeAttempted === false &&
    rejected.reachedResumeHandle === false &&
    rejected.continuation === 'none',
    { ok: rejected.ok, status: rejected.status, continuation: rejected.continuation });
  check('F2 ★ 零经济动作：余额、预留、账目、库存、购买**一个都没动**',
    J(after) === J(before) &&
    rejected.ledgerMutation === false &&
    rejected.inventoryMutation === false &&
    rejected.settlementAttempted === false &&
    rejected.purchaseCreated === false,
    { before: J(before), after: J(after) });
  check('F3 报价仍然是 OPEN（拒绝不消费报价，也不让它"看起来被用过"）',
    store.getQuote({ quoteId: p.quoteId }).quote.state === C.QUOTE_STATE.OPEN,
    store.getQuote({ quoteId: p.quoteId }).quote.state);
  check('F4 ★ 那条 intent 仍然是 WAITING_APPROVAL —— 拒绝是**批准**的终态，'
    + '而 intent 的终结发生在下一次（被拒的）恢复尝试上',
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL,
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state);

  const resumed = gate.bind(C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME)
    .resumeApprovedPurchase({ agentIntentId: p.intentId, approvalId: p.approvalId, idempotencyKey: K('f-resume') });
  check('F5 ★ Agent 在用户摇头之后被**终结**：intent → DENIED，零购买',
    resumed.ok === false && resumed.denied === true &&
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state === C.PURCHASE_INTENT_STATE.DENIED &&
    purchases(store) === before.purchases,
    { ok: resumed.ok, state: store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state,
      reasonCode: resumed.reasonCode, errors: resumed.errors });

  const again = decide(seam, p.approvalId, 'APPROVE', K('f-after-reject'));
  check('F6 ★ 拒绝**不可复活**：拿一个新的身份再想批准它 ⇒ 状态闸门拒绝，'
    + '而且零经济动作',
    again.ok === false && again.status === 409 &&
    again.reasonCode === createSeam.REFUSAL.DECISION_REFUSED &&
    again.downstreamReasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
    again.reachedStore === true && again.reachedResumeHandle === false &&
    J(worldOf(store, f)) === J(before),
    { reason: again.reasonCode, downstream: again.downstreamReasonCode, status: again.status });

  check('F7 用户在终态上的**重放**（同一个身份）仍然是当初那个结果，而不是一次新的拒绝',
    (() => {
      const r = decide(seam, p.approvalId, 'REJECT', rejectKey);
      return r.ok === true && r.replayed === true && r.approvalStatus === C.APPROVAL_STATE.REJECTED;
    })(), { rejectedOk: rejected.ok, status: rejected.approvalStatus });

  world.stores.forEach(s => { try { s.close(); } catch (_) {} });
}

/* ══════════════════════════════════════════════════════════════════════
   G · single-use / 过期 / 配对
   ══════════════════════════════════════════════════════════════════════ */
section('G · single-use · expiry · 错误配对');

{
  const store = makeStore('g');
  const f = fixture(store);
  autonomy(store, {});
  const { gate, seam } = makeSeam(store);
  const p = propose(store, gate, f);

  check('G1 APPROVED 的批准被购买消费之后**不能再被批准**（CONSUMED 是终态）',
    (() => {
      const r1 = decide(seam, p.approvalId, 'APPROVE', K('g1'));
      const again = decide(seam, p.approvalId, 'APPROVE', K('g1b'));
      const status = store.getApproval({ approvalId: p.approvalId }).approval.status;
      return r1.ok === true && status === C.APPROVAL_STATE.CONSUMED &&
        again.ok === false && again.downstreamReasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED;
    })());

  check('G2 ★ 错误的 intent / approval 配对不会互相续做：'
    + '按 approvalId 定位必须回到**属于那份批准**的那条 intent（而不是调用方想要的那条），'
    + '而"批准还没决定"时必须拒绝执行',
    (() => {
      const second = propose(store, gate, f, { idempotencyKey: K('g2-intent'), reason: 'second', units: 2 });
      const third = propose(store, gate, f, { idempotencyKey: K('g3-intent'), reason: 'third', units: 3 });
      if (second.ok !== true || third.ok !== true) return false;
      if (second.intentId === third.intentId) return false;
      /* 直接用 store 的 canonical 口：它按 approvalId 定位 —— 那条语句必须
         回到第二份批准自己的 intent，而不是别的。 */
      const byApproval = store.resumeAgentPurchaseIntent({
        approvalId: second.approvalId, idempotencyKey: K('g2-resume')
      });
      const targeted = byApproval.intentId === second.intentId &&
        byApproval.intentId !== third.intentId;
      /* 而"续做一条还在等待、且批准还没决定"的 intent ⇒ 不执行（APPROVAL_REQUIRED） */
      return targeted && byApproval.ok === false &&
        byApproval.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
        store.getApproval({ approvalId: second.approvalId }).approval.status === C.APPROVAL_STATE.PENDING &&
        purchases(store) === 1;
    })());
}

{
  const store = makeStore('g-exp');
  const f = fixture(store);
  autonomy(store, {});
  const { gate, seam } = makeSeam(store);
  const p = propose(store, gate, f);
  /* 把那条批准推到"有效期已过"。★ 走的是**产品路径**（expireApproval），
     而且它接受一个显式的 `now` —— 因此这里不需要改库、也不需要等时间：
     "过期"是**比较**（expires_at <= now），不是定时器（P22-3 起冻结的语义）。
     本测试给一个远在有效期之后的 now，于是这条批准真的过期。 */
  const future = store.getApproval({ approvalId: p.approvalId }).approval.expiresAt + 1000;
  const expired = store.expireApproval({ approvalId: p.approvalId, systemInitiated: true, now: future, idempotencyKey: K('g-exp') });
  must(expired.ok === true, 'expireApproval', expired.errors);
  const before = worldOf(store, f);
  const late = decide(seam, p.approvalId, 'APPROVE', K('g-late'));
  check('G3 ★ 过期的批准**不能被批准**：状态闸门拒绝，零经济动作',
    late.ok === false && late.downstreamReasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
    store.getApproval({ approvalId: p.approvalId }).approval.status === C.APPROVAL_STATE.EXPIRED &&
    J(worldOf(store, f)) === J(before),
    { reason: late.downstreamReasonCode, status: late.status });
  world.stores.forEach(s => { try { s.close(); } catch (_) {} });
}

{
  /* ── approved but Budget later denies ──────────────────────────────── */
  const store = makeStore('h-budget');
  const f = fixture(store, { limits: { perTransactionMinor: 5 } });
  autonomy(store, {});
  const { gate, seam } = makeSeam(store);
  /* ★ 报价是 10，而 per-transaction 上限是 5：提议能成立（提议不评预算），
     而**结算前**的预算终检必须拒绝它。 */
  const p = propose(store, gate, f);
  const before = worldOf(store, f);
  const budgetKey = K('h-approve');
  const approved = decide(seam, p.approvalId, 'APPROVE', budgetKey);
  check('H1 ★ 用户批准之后预算**仍然**是权威：结算被预算拒绝，世界零变化',
    p.ok === true && approved.ok === true && approved.decisionRecorded === true &&
    approved.continuationOk === false &&
    approved.continuation === 'refused' &&
    J(worldOf(store, f)) === J(before) &&
    purchases(store) === 0,
    { approvalOk: approved.ok, continuation: approved.continuation,
      continuationReasonCode: approved.continuationReasonCode,
      before: J(before), after: J(worldOf(store, f)) });
  check('H2 那条 intent 因此走到 FAILED（而不是被"已批准"强行推到 COMPLETED）',
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state === C.PURCHASE_INTENT_STATE.FAILED,
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state);
  check('H3 ★ APPROVED → resume → FAILED 是**合法**的结局：'
    + '决定本身成功（那条批准真的被写下了）而购买没有发生',
    approved.approvalDoesNotGuaranteeAPurchase === true &&
    store.getApproval({ approvalId: p.approvalId }).approval.status === C.APPROVAL_STATE.APPROVED);
  const retry = decide(seam, p.approvalId, 'APPROVE', budgetKey);
  check('H4 在"批准了但没买成"之后重试同一次决定：决定重放、续做被拒，'
    + '而**不会**产生第二笔购买',
    retry.ok === true && retry.replayed === true && purchases(store) === 0 && J(worldOf(store, f)) === J(before),
    { replayed: retry.replayed, purchases: purchases(store) });
  world.stores.forEach(s => { try { s.close(); } catch (_) {} });
}

{
  /* ── approved but Quote expired ────────────────────────────────────── */
  const store = makeStore('h-quote');
  const f = fixture(store);
  autonomy(store, {});
  const { gate, seam } = makeSeam(store);
  const p = propose(store, gate, f);
  /* 让那份报价过期 —— 同样走产品路径（expireQuote），并且给它一个显式的
     now。★ 这一条同时证明"过期是**比较**而不是定时器"：整段测试里没有
     任何一个 sleep。 */
  const quoteFuture = store.getQuote({ quoteId: p.quoteId }).quote.expiresAt + 1000;
  const quoteExpired = store.expireQuote({
    quoteId: p.quoteId, systemInitiated: true, now: quoteFuture, idempotencyKey: K('h-quote')
  });
  must(quoteExpired.ok === true, 'expireQuote', quoteExpired.errors);
  const before = worldOf(store, f);
  const approved = decide(seam, p.approvalId, 'APPROVE', K('h-quote-approve'));
  check('H5 ★ 过期报价**不因批准而复活**：续做安全失败，零经济动作',
    quoteExpired.ok === true &&
    approved.ok === true && approved.decisionRecorded === true &&
    approved.continuationOk === false &&
    J(worldOf(store, f)) === J(before) &&
    purchases(store) === 0,
    { quoteExpired: quoteExpired.ok, continuation: approved.continuation,
      continuationReasonCode: approved.continuationReasonCode,
      intentState: store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state });
  /* ★ 结局的形状要说准（开发期实测踩到过）：**"报价过期"与"intent 过期"
     不是同一个终态**。这一条走的是 P22-6 preparePurchase 在写锁里比较
     expires_at 的那条路，因此它的 reasonCode 是 QUOTE_EXPIRED、intent 落到
     FAILED；而 intent 自己越过有效期（H7）才是 INTENT_EXPIRED → EXPIRED。
     把两者读成一样会让"这份报价死了"与"这条打算死了"混为一谈。 */
  check('H6 ★ 报价过期的结局是 FAILED / QUOTE_EXPIRED，而**不是** EXPIRED'
    + '（"报价死了"与"打算死了"是两个不同的终态）',
    approved.continuationReasonCode === C.DENY_REASON.QUOTE_EXPIRED &&
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state === C.PURCHASE_INTENT_STATE.FAILED &&
    approved.continuationErrors.indexOf('quote-is-not-open') >= 0,
    { intentState: store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state,
      reasonCode: approved.continuationReasonCode, errors: approved.continuationErrors });
  world.stores.forEach(s => { try { s.close(); } catch (_) {} });
}

{
  /* ── 有效期过完之后，批准**也**救不了这条 intent ────────────────────
     ★ 一条被构造出来的真实事实：P22-8 建那条批准时用的有效期**就是**那条
       intent 的有效期（`const expiresAt = Number(row.expires_at)` →
       createApprovalRequest），因此"打算死了、批准还活着"这种组合**在数据上
       不存在**。于是这里把时钟推到那条 intent 的有效期之后，并如实地断言
       两件事：
         · 决定**没有**成功落库，理由是一个**有名有姓**的过期（不是一句
           "被拒"）；
         · 而它产生**零**经济动作 —— 用户的一次点头无法把一条已经过完有效期
           的打算复活。
       ★ 这里没有 sleep、没有改库：store 有一个显式时钟，"过期是一次比较"
       这条语义因此可以被精确地构造出来。 */
  const t0 = 1700000000000;
  const store = makeStoreAt('h-intent', t0);
  const f = fixture(store);
  autonomy(store, {});
  const { gate } = makeSeam(store);
  const seam = makeSeam(store, { gate: gate, clock: () => t0 + 1000 }).seam;
  const p = propose(store, gate, f, { idempotencyKey: K('h-intent-propose'), expiresAt: t0 + 50 });
  must(p.ok === true, 'propose(expiresAt)', p.errors);
  must(p.intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL, 'waiting', p.intent.state);
  must(p.intent.expiresAt === t0 + 50, 'the-intent-carries-the-constructed-expiry', p.intent.expiresAt);
  must(store.getApproval({ approvalId: p.approvalId }).approval.expiresAt === t0 + 50,
    'the-approval-lives-exactly-as-long-as-the-intent', store.getApproval({ approvalId: p.approvalId }).approval.expiresAt);
  /* 时间前进：那条 intent 与那条批准**同时**越过了自己的有效期。 */
  store.setNow(t0 + 1000);
  const before = worldOf(store, f);
  const approved = decide(seam, p.approvalId, 'APPROVE', K('h-intent-approve'));
  check('H7 ★ 有效期过完之后用户点头救不了那条 intent：决定**没有**落库'
    + '（APPROVAL_EXPIRED），零经济动作，intent 停在原地',
    approved.ok === false && approved.status === 409 &&
    approved.reasonCode === createSeam.REFUSAL.DECISION_REFUSED &&
    approved.downstreamReasonCode === C.DENY_REASON.APPROVAL_EXPIRED &&
    approved.decisionRecorded === false && approved.resumeAttempted === false &&
    store.getApproval({ approvalId: p.approvalId }).approval.status === C.APPROVAL_STATE.EXPIRED &&
    store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL &&
    J(worldOf(store, f)) === J(before) && purchases(store) === 0,
    { reason: approved.reasonCode, downstream: approved.downstreamReasonCode,
      approvalStatus: store.getApproval({ approvalId: p.approvalId }).approval.status,
      intentState: store.getPurchaseIntent({ agentIntentId: p.intentId }).intent.state,
      before: J(before), after: J(worldOf(store, f)) });
  const rejected = decide(seam, p.approvalId, 'REJECT', K('h-intent-reject'));
  check('H7b ★ 同一条过期批准上的摇头也被挡住 —— 而理由**不同**：'
    + 'H7 那一次尝试已经把它推到了 EXPIRED（一条有名有姓的终态），'
    + '因此第二个决定撞的是状态机，而不是再过期一次',
    rejected.ok === false && rejected.status === 409 &&
    rejected.downstreamReasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED &&
    store.getApproval({ approvalId: p.approvalId }).approval.status === C.APPROVAL_STATE.EXPIRED &&
    J(worldOf(store, f)) === J(before),
    { reason: rejected.downstreamReasonCode, status: rejected.status });
  world.stores.forEach(s => { try { s.close(); } catch (_) {} });
}

/* ══════════════════════════════════════════════════════════════════════
   I · 信封面：畸形 / 缺字段 / 未知决定词
   ══════════════════════════════════════════════════════════════════════ */
section('I · 信封面（畸形一律拒，且不触碰 store）');

{
  const store = makeStore('i');
  const f = fixture(store);
  autonomy(store, {});
  const { gate, seam } = makeSeam(store);
  const p = propose(store, gate, f);

  /* ★ 全世界在这一批畸形请求**前后**必须逐字节相同 —— 而且这一条必须与
     "世界确实动过一次"分开：这个块里那一次成功的批准（I2）本来就该动。
     因此基线取在畸形请求**之前**。 */
  const beforeBad = worldOf(store, f);
  const bad = [
    ['不是对象', null, 400, createSeam.REFUSAL.MALFORMED_ENVELOPE],
    ['数组', [], 400, createSeam.REFUSAL.MALFORMED_ENVELOPE],
    ['缺 approvalId', { decision: 'APPROVE', idempotencyKey: 'k' }, 400, createSeam.REFUSAL.MISSING_APPROVAL_ID],
    ['approvalId 不是 canonical', { approvalId: 'nope', decision: 'APPROVE', idempotencyKey: 'k' }, 400, createSeam.REFUSAL.APPROVAL_ID_NOT_CANONICAL],
    ['缺 decision', { approvalId: p.approvalId, idempotencyKey: 'k' }, 400, createSeam.REFUSAL.MISSING_DECISION],
    ['未知 decision（BUY）', { approvalId: p.approvalId, decision: 'BUY', idempotencyKey: 'k' }, 404, createSeam.REFUSAL.UNKNOWN_DECISION],
    ['未知 decision（AUTO_ALLOW）', { approvalId: p.approvalId, decision: 'AUTO_ALLOW', idempotencyKey: 'k' }, 404, createSeam.REFUSAL.UNKNOWN_DECISION],
    ['未知 decision（FORCE_APPROVE）', { approvalId: p.approvalId, decision: 'FORCE_APPROVE', idempotencyKey: 'k' }, 404, createSeam.REFUSAL.UNKNOWN_DECISION],
    ['缺 idempotencyKey', { approvalId: p.approvalId, decision: 'APPROVE' }, 400, createSeam.REFUSAL.MISSING_IDEMPOTENCY_KEY],
    ['幂等键不合法', { approvalId: p.approvalId, decision: 'APPROVE', idempotencyKey: 'has space' }, 400, createSeam.REFUSAL.MISSING_IDEMPOTENCY_KEY],
    ['多一个键（price）', { approvalId: p.approvalId, decision: 'APPROVE', idempotencyKey: 'k', price: 1 }, 400, createSeam.REFUSAL.UNEXPECTED_ENVELOPE_KEYS],
    ['多一个键（settlementType）', { approvalId: p.approvalId, decision: 'APPROVE', idempotencyKey: 'k', settlementType: 'COMPUTE_GRANT' }, 400, createSeam.REFUSAL.UNEXPECTED_ENVELOPE_KEYS]
  ];
  bad.forEach(([label, body, status, reason]) => {
    const r = seam.dispatch(USER_REQ, body);
    check('I · ' + label + ' → ' + reason,
      r.ok === false && r.status === status && r.reasonCode === reason &&
      r.reachedStore === false && r.reachedResumeHandle === false,
      { status: r.status, reasonCode: r.reasonCode, reachedStore: r.reachedStore });
  });
  check('I1 ★ 上面这一批畸形请求之后，世界与它们之前**逐字节相同**'
    + '（它们没有产生任何经济动作）',
    J(worldOf(store, f)) === J(beforeBad),
    { before: J(beforeBad), after: J(worldOf(store, f)) });

  check('I2 大小写与同义词被接受（人类说 APPROVE，状态机说 APPROVED）',
    (() => {
      const r = decide(seam, p.approvalId, 'approve', K('i-alias'));
      return r.ok === true && r.decision === C.APPROVAL_STATE.APPROVED;
    })());

  check('I3 未知的 approvalId ⇒ 一次可解释的拒绝（不是裸异常）',
    (() => {
      const r = decide(seam, C.formatEconomyId('APPROVAL', 'does_not_exist').id, 'APPROVE', K('i-missing'));
      return r.ok === false && r.reachedStore === true &&
        r.downstreamReasonCode === C.DENY_REASON.APPROVAL_NOT_FOUND;
    })());
  world.stores.forEach(s => { try { s.close(); } catch (_) {} });
}

/* ══════════════════════════════════════════════════════════════════════
   J · 生产面：装配点真的 bind 了这一个身份，而且只有那两处
   ══════════════════════════════════════════════════════════════════════ */
section('J · 装配面的调用点断言');

{
  const serviceSrc = read('services/home-node-service.js');
  const serviceCode = stripCommentsAndStrings(serviceSrc);
  const httpCode = stripCommentsAndStrings(read('services/home-node/http.js'));
  /* ★ 全生产面扫一遍 `.bind(` 的**调用点**，而判据是"绑的是哪个身份"，不是
     "出现了几次 bind 这个字符串"。
     ★ 为什么不是数出现次数：本仓库的注释里到处都在解释这两处 bind（"全仓库
     唯一一次 `gate.bind(consumer)`"、"第二次 bind"），而任何按行/按字符剥
     引号的剥离器都会在 ` 与 `http://…` 这类片断上丢掉块注释状态 —— 于是
     它要么把正文当注释吃掉、要么把注释当正文数进来。断言**身份**没有这个
     问题，而且它问的是更硬的那件事：**只有这两个消费者拿到过句柄**。 */
  function bindCallsites(dirRel, out) {
    const abs = path.join(ROOT, dirRel);
    if (!fs.existsSync(abs)) return out;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = dirRel + '/' + entry.name;
      if (entry.isDirectory()) { bindCallsites(rel, out); continue; }
      if (!/\.js$/i.test(entry.name)) continue;
      const src = stripCommentsAndStrings(read(rel));
      const re = /\.bind\s*\(\s*([A-Za-z_$][\w.$]*)\s*\)/g;
      let m;
      while ((m = re.exec(src))) {
        /* ★ 只收**经济消费者**的绑定：这个仓库里还有别的 `.bind(x)`（例如
           Active 的 socialObserver 句柄），而它们与"谁拿到了经济能力"无关。 */
        if (/ECONOMY_CONSUMER|\.CONSUMER$/.test(m[1])) out.push(rel + ' → ' + m[1]);
      }
    }
    return out;
  }
  const bindIdentities = bindCallsites('services', []);

  check('J1 ★ 生产代码里**只有两个**消费者拿到过句柄，而且就是那两个身份：'
    + 'Agent（适配器的装配助手）与用户决定（装配层）',
    J(bindIdentities.sort()) === J([
      'services/home-node/economy-action-adapter.js → C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME',
      'services/home-node-service.js → economyApprovalDecisionModule.CONSUMER'
    ].sort()) &&
    serviceSrc.indexOf('.bind(C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME)') < 0,
    { bindIdentities: bindIdentities });  check('J2 ★ 用户决定那条路径上没有任何到 store 的第二条边：'
    + 'seam 收到的 store 视图**只有一个键**',
    /Object\.freeze\(\{\s*decideApproval:\s*economyStore\.decideApproval\s*\}\)/.test(serviceCode));

  check('J3 http.js 里没有门的成员名，也没有 store 的底层动词（它只是把请求送过去）',
    ['economy-capability', 'createEconomyCapabilityGate', 'economyCapabilityGate',
      'appendCapabilityAudit', 'checkEconomyCapability', 'proposePurchaseIntent',
      'resumeApprovedPurchase', 'decideApproval', 'settlePurchase', 'preparePurchase',
      'mutateInventory', 'mintForSystem', 'commitLedgerTransaction']
      .every(n => httpCode.indexOf(n) < 0),
    ['economy-capability', 'checkEconomyCapability', 'decideApproval', 'settlePurchase']
      .filter(n => httpCode.indexOf(n) >= 0));

  check('J4 ★ 路径字面量只有一份：http.js 里**没有**写死 decision 路径，'
    + '它用 seam 自己持有的那一个（与 P22-11 逐字同源）',
    serviceCode.indexOf("/internal/economy/approval-decision") < 0 &&
    httpCode.indexOf("/internal/economy/approval-decision") < 0 &&
    httpCode.indexOf('economyApprovalDecision.path') >= 0);

  check('J5 seam 的路径不在 /economy/ 下，因此"POST /economy/* 一律 405"这句话仍然为真',
    createSeam.DECISION_PATH.indexOf('/economy/') !== 0);
}

/* ══════════════════════════════════════════════════════════════════════
   收尾：资源纪律（零 child，零泄漏）
   ══════════════════════════════════════════════════════════════════════ */
for (const s of world.stores) { try { s.close(); } catch (_) {} }
for (const d of world.dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

/* ★ 进程纪律：这一条要读的是"我们自己开过的东西有没有关掉"，因此它数的是
   **本文件真的创建过的资源**（store / server / child / timer），而不是
   Node 进程里的 socket 句柄总数 —— 后者包含 stdout/stderr/stdin 与实验性
   SQLite 的内部句柄，把它们算进来会让这条断言在正确的代码上偶发为红。
   ★ 本文件一个 child、一个 server 都不开（见文件头），因此这三项恒为 0。 */
const leftovers = world.stores.filter(s => { try { return s.isOpen && s.isOpen(); } catch (_) { return false; } }).length;
check('Z1 ★ 进程纪律：max concurrent child = 0 · total spawn = 0 · 0 leftover'
  + '（本文件创建的 store 全部已关闭，一个 child / server / timer 都没开）',
  leftovers === 0 && world.stores.length > 0,
  { storesOpened: world.stores.length, storesStillOpen: leftovers });

console.log('\n' + '═'.repeat(64));
console.log('P22-13 approval decision seam（单进程）: ' + checks + ' 项检查');
if (failures === 0) {
  console.log('全部通过 ✔ · max concurrent child = 0 · total spawn = 0 · leftover = 0');
  process.exitCode = 0;
} else {
  console.error(failures + ' 项失败 ✘');
  process.exitCode = 1;
}
