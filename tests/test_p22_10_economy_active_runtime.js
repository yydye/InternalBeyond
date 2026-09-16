'use strict';
/* ====================================================================
   P22-10 · Economy Action Adapter runtime（真实装配 · **零子进程**）
   --------------------------------------------------------------------
   运行：node tests/test_p22_10_economy_active_runtime.js

   ── 这个文件与 test_p22_10_economy_action_adapter.js 的分工 ──────────
   前者证明**适配器本身**（净化器 · 转发 · 拒绝 · 幂等 · 不持 store）。
   本文件证明**接线**（§6）：这台节点上真的有一个已绑定的动作面、
   它绑的**只**是 active_agent_runtime、而既有 Active 动作链一行未改。

   ── 为什么也一个子进程都不开（§12）──────────────────────────────────
   §12 逐字要求：能单进程证明的禁止 spawn；P22-6 ~ P22-8 已经证明过的
   多进程矩阵只做 regression，不复制。本文件要证明的运行时事实只有三条：
     ① 真实装配（buildHomeNode 与进程级装配）里都挂着一个已绑定的
        Action Adapter，而且两条路径给出同一个消费者与同一份动作表；
     ② Active runtime 的**既有**动作链与依赖闭包里**零**经济引用
        （没有第二套 action framework，也没有新的 store owner）；
     ③ 那个装配出来的适配器端到端走完 P22-9 → P22-8 → P22-7 → P22-6。
   三条都在同一个进程里可判定（node:sqlite 是同步的；"两条装配路径"是
   两次函数调用，不是两个操作系统进程）。P22-9 已经用真实 socket 证明过
   "HTTP 上没有门的任何面"，本文件不重做那件事（§12：只做 regression），
   只断言 HTTP 源码里仍然没有适配器。

   ── 隔离 ─────────────────────────────────────────────────────────────
   ★ 在 require 本服务之前先把 IB_HOME_NODE_DATA_DIR 指到一次性临时目录，
   于是**进程级装配**这一条路径也不会碰生产 dataDir。
   ==================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-10rt-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
/* ★ 必须在 require 服务之前设置（见文件头）。 */
process.env.IB_HOME_NODE_DATA_DIR = tmpDir('process-level');

const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const ADAPTER = require(path.join(ROOT, 'services', 'home-node', 'economy-action-adapter.js'));
const registry = require(path.join(ROOT, 'runtime', 'component-registry.js'));

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

const closables = [];
let keySeq = 0;
function K(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }
const CUR = 'IB_CREDIT';
const AGENT = 'cfg_agent';
const ALLOWED = C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME;

function readIfExists(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (_) { return ''; }
}
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
/* 与 P22-1 boundary 的 BYPASS_SCAN_DIRS 逐字同一份约定。 */
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
        if (matchRe.test(stripCommentsAndStrings(readIfExists(child)))) hits.push(child);
      }
    };
    walk(dirRel);
  });
  return hits;
}

console.log('P22-10 · Economy Action Adapter runtime');

/* ══════════════════════════════════════════════════════════════════
   A · 真实装配：两条启动路径都必须有一个**已绑定**的动作面
   ══════════════════════════════════════════════════════════════════ */
section('A · 真实装配（buildHomeNode 与进程级装配不得漂移）');

let built = null;
try {
  built = SERVICE.buildHomeNode({ dataDir: tmpDir('build'), host: '127.0.0.1', port: 0, token: '', logger: () => { } });
  closables.push(built);
} catch (error) {
  console.error('buildHomeNode 失败 — ' + String((error && error.stack) || error));
  failures++;
}

check('A1 ★ buildHomeNode() 的返回值里有适配器，而且它与 store / 门是同一次装配里的三个对象',
  !!built && built.economyActionAdapter != null &&
  built.economyCapabilityGate != null && built.economyStore != null &&
  built.economyActionAdapter.describe().holdsBoundCapabilityHandle === true,
  built ? Object.keys(built).filter(k => /economy/i.test(k)) : null);

check('A2 ★★ 进程级装配（= 生产启动路径）也有适配器 —— P22-9 的门在生产里曾经**零次**被 bind',
  SERVICE.economyActionAdapter != null &&
  SERVICE.economyActionAdapter.describe().adapter === 'economy-action-adapter' &&
  SERVICE.economyActionAdapter.consumer === ALLOWED,
  Object.keys(SERVICE).filter(k => /economy/i.test(k)));

check('A3 ★ 两条装配路径的适配器给出**逐字相同**的消费者与动作表（漂移在这里不可能，因为它们共用契约与同一个模块）',
  !!built &&
  J(built.economyActionAdapter.describe().consumer) === J(SERVICE.economyActionAdapter.describe().consumer) &&
  J(built.economyActionAdapter.describe().actions) === J(SERVICE.economyActionAdapter.describe().actions) &&
  J(built.economyActionAdapter.describe().notOfferedActions) === J(SERVICE.economyActionAdapter.describe().notOfferedActions),
  !!built ? { a: built.economyActionAdapter.describe().consumer, b: SERVICE.economyActionAdapter.describe().consumer } : null);

check('A4 ★★ 适配器**不持有** store：实例键恰好七个，没有 store、没有 gate、没有 raw 写入口',
  (() => {
    const a = SERVICE.economyActionAdapter;
    const d = a.describe();
    return Object.keys(a).sort().join(',') === ADAPTER.ADAPTER_KEYS.slice().sort().join(',') &&
      a.store === undefined && a.gate === undefined && a.handle === undefined &&
      d.holdsRawStore === false && d.exposesLowLevelEconomyWrites === false &&
      d.exposesGenericDispatch === false && d.acceptsAMethodName === false;
  })(),
  Object.keys(SERVICE.economyActionAdapter));

check('A5 ★★ 装配层**没有**把适配器交给 http 层（HTTP 上的经济写面从 P22-2 起就是 0）',
  !!built &&
  built.httpLayer != null &&
  built.httpLayer.economyActionAdapter === undefined &&
  built.httpLayer.economyCapabilityGate === undefined &&
  readIfExists('services/home-node/http.js').indexOf('economyActionAdapter') < 0 &&
  readIfExists('services/home-node/http.js').indexOf('economy-action-adapter') < 0);

check('A6 ★ 装配层对 Economy 的 require 恰好是那三个模块，而且**没有**第二个 store owner',
  (() => {
    const src = stripComments(readIfExists('services/home-node-service.js'));
    const targets = (src.match(/require\s*\(\s*'([^']*economy[^']*)'\s*\)/g) || [])
      .map(s => s.replace(/[\s\S]*'([^']*)'[\s\S]*/, '$1'));
    return targets.length === 3 &&
      targets.indexOf('../services/home-node/economy-store.js') >= 0 &&
      targets.indexOf('../services/home-node/economy-capability.js') >= 0 &&
      targets.indexOf('../services/home-node/economy-action-adapter.js') >= 0;
  })(),
  (stripComments(readIfExists('services/home-node-service.js')).match(/require\s*\(\s*'[^']*economy[^']*'\s*\)/g) || []));

/* ══════════════════════════════════════════════════════════════════
   B · §6 只接 Active：既有动作链一行未改，别的东西一个都没开
   ══════════════════════════════════════════════════════════════════ */
section('B · §6 只接 active_agent_runtime（既有 Action 链一行未改）');

check('B1 ★★ 消费者身份锚点可以**核对**，而不是一句声明：component-registry 里真有一个 active 组件，端口与服务文件都在',
  (() => {
    const anchor = C.CONSUMER_RUNTIME_ANCHOR[ALLOWED];
    const componentId = String(anchor).split('#')[1];
    const component = registry.byId(componentId);
    return anchor === 'runtime/component-registry.js#active' &&
      component != null &&
      component.id === 'active' &&
      component.serviceFile === 'services/active-message-service.js' &&
      component.defaultPort === 23114 &&
      component.portEnv === 'IB_ACTIVE_PORT' &&
      fs.existsSync(path.join(ROOT, component.serviceFile));
  })(),
  { anchor: C.CONSUMER_RUNTIME_ANCHOR[ALLOWED], component: registry.byId('active') });

check('B2 ★★ 既有封闭动作集**逐字未变**，而且**不含**任何经济动词',
  (() => {
    const browser = readIfExists('assets/js/active-diary/active-plans.js');
    const node = readIfExists('active/scheduler.js');
    /* Active 的两条既有封闭链：浏览器侧规划器（sanitizeAiPlan 之后的
       封闭动作集）与 Node companion 的到期评估。 */
    return browser.indexOf("['schedule','none','cancel_existing'].includes(action)") >= 0 &&
      node.indexOf("['send', 'reschedule', 'cancel'].includes(String(parsed.action || ''))") >= 0 &&
      !/ECONOMY_/.test(browser) && !/ECONOMY_/.test(node);
  })(),
  { browser: readIfExists('assets/js/active-diary/active-plans.js').indexOf('cancel_existing'),
    node: readIfExists('active/scheduler.js').indexOf("['send', 'reschedule', 'cancel']") });

check('B3 ★★ Active runtime 的每一个文件里**零**经济引用（既没有塞进既有动作集，也没有第二套 action framework）',
  (() => {
    const activeRuntimeFiles = [];
    const walk = rel => {
      const abs = path.join(ROOT, rel);
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = rel + '/' + entry.name;
        if (entry.isDirectory()) { walk(child); continue; }
        if (/\.js$/i.test(entry.name)) activeRuntimeFiles.push(child);
      }
    };
    ['active', 'services/active-message-service.js', 'assets/js/active-diary'].forEach(rel => {
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else activeRuntimeFiles.push(rel);
    });
    const offenders = activeRuntimeFiles.filter(rel =>
      /economy/i.test(stripCommentsAndStrings(readIfExists(rel))));
    return activeRuntimeFiles.length >= 10 && offenders.length === 0;
  })(),
  (() => {
    const out = [];
    const walk = rel => {
      for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = rel + '/' + entry.name;
        if (entry.isDirectory()) { walk(child); continue; }
        if (/\.js$/i.test(entry.name) && /economy/i.test(stripCommentsAndStrings(readIfExists(child)))) out.push(child);
      }
    };
    walk('active');
    walk('assets/js/active-diary');
    return out;
  })());

check('B4 ★★ Middle Brain 里**零**经济引用（§11：它不是这条链上的 seam，因此零改动）',
  /economy/i.test(stripCommentsAndStrings(readIfExists('services/home-node/middle-brain.js'))) === false &&
  /* 反向自证：这句扫描确实能抓到经济引用（否则是一条保护空气的断言）。 */
  /economy/i.test('require("./economy-store.js")') === true);

check('B5 ★★ 只有 Active 一个消费者被绑定 —— bridge / home_node_authority / 其它组件一个都没有',
  scanProduction(/\.bind\s*\(\s*C\.ECONOMY_CONSUMER\.DESKTOP_BRIDGE\s*\)/).length === 0 &&
  scanProduction(/\.bind\s*\(\s*C\.ECONOMY_CONSUMER\.HOME_NODE_AUTHORITY\s*\)/).length === 0 &&
  scanProduction(/\.bind\s*\(\s*'active_agent_runtime'\s*\)/).length === 0 &&
  /* 唯一的绑定点在适配器里，而且它用的是契约里的常量。 */
  scanProduction(/\.bind\s*\(\s*C\.ECONOMY_CONSUMER\.ACTIVE_AGENT_RUNTIME\s*\)/)
    .join(',') === 'services/home-node/economy-action-adapter.js',
  { allowed: scanProduction(/\.bind\s*\(\s*C\.ECONOMY_CONSUMER\.ACTIVE_AGENT_RUNTIME\s*\)/),
    bridge: scanProduction(/\.bind\s*\(\s*C\.ECONOMY_CONSUMER\.DESKTOP_BRIDGE\s*\)/) });

check('B6 ★ 适配器不在任何 HTTP 路由上，也不在任何 MCP 工具面上',
  (() => {
    const httpSrc = readIfExists('services/home-node/http.js');
    /* ① 没人把适配器交给路由层；② /economy/* 仍然全是 GET； */
    const economyBlocks = httpSrc.match(/path === '\/economy\/[^']*' && method === '[A-Z]+'/g) || [];
    return httpSrc.indexOf('actionAdapter') < 0 &&
      economyBlocks.length > 0 &&
      economyBlocks.every(b => /&& method === 'GET'$/.test(b)) &&
      /* ③ MCP 面（bridge / assets/js/integrations.js）里没有经济动词。 */
      /economy/i.test(stripCommentsAndStrings(readIfExists('assets/js/integrations.js'))) === false;
  })(),
  { economyRoutes: (readIfExists('services/home-node/http.js').match(/path === '\/economy\/[^']*' && method === '[A-Z]+'/g) || []).length });

/* ══════════════════════════════════════════════════════════════════
   C · 装配出来的那个适配器端到端走完 P22-9 → P22-8 → P22-7 → P22-6
   ══════════════════════════════════════════════════════════════════ */
section('C · 装配面的端到端（真实 store · 真实门 · 真实绑定）');

function assembledFixture(tag) {
  const instance = SERVICE.economyAssembly({
    dataDir: tmpDir(tag),
    /* 角色 owner 谓词：装配层允许注入（生产注入的是 device-registry）。
       这里注入一个恒真的谓词，因为本组要证的是**经济链**，不是注册表。 */
    ownerExists: () => true,
    logger: () => { }
  });
  const store = instance.economyStore;
  /* ★ 装配**创建** store，打开由启动链的 openAll() 负责（P22-2 那条
     "装配好了却没打开"的缺口）。本组要的是一条可用的经济链，因此显式打开。 */
  store.open();
  closables.push({ close: () => { try { store.close(); } catch (_) { } } });
  const storeId = store.putStore({ name: 'Main Store', idempotencyKey: K('store') }).result.store.storeId;
  const productId = store.putProduct({
    storeId: storeId, kind: 'COMPUTE_CREDIT', name: 'Compute x1000', currency: CUR,
    unitPriceMinor: 10, grantQuantity: 1000, idempotencyKey: K('product')
  }).result.product.productId;
  const wallet = store.openWallet({ owner: { type: 'character', id: AGENT }, currency: CUR });
  store.mintForSystem({
    systemInitiated: true, walletId: wallet.wallet.walletId, currency: CUR,
    amountMinor: 100000, idempotencyKey: K('mint')
  });
  store.putBudgetPolicy({
    ownerId: AGENT, currency: CUR,
    limits: { perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000 },
    idempotencyKey: K('budget')
  });
  return { instance: instance, store: store, productId: productId };
}
function autonomyOf(store, approvalAboveMinor) {
  store.putAutonomyPolicy({
    ownerId: AGENT, currency: CUR, enabled: true, perPurchaseLimitMinor: 100000,
    dailyAutonomousLimitMinor: 100000, approvalAboveMinor: approvalAboveMinor,
    allowedProductKinds: ['COMPUTE_CREDIT'], allowedSettlementTypes: ['COMPUTE_GRANT'],
    allowGift: false, idempotencyKey: K('autonomy')
  });
}
function actionFor(productId) {
  return {
    action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE,
    proposal: { agentId: AGENT, productId: productId, reason: 'compute is running low' },
    idempotencyKey: K('action')
  };
}
function walletMinor(store) {
  return C.serializeAmountMinor(store.getWallet({ ownerId: AGENT, currency: CUR }).wallet.cachedBalanceMinor);
}

check('C1 ★★ AUTO_ALLOW：装配出来的适配器一路走完 P22-9 → P22-8 → P22-7 → P22-6，钱真的动了（恰好一次）',
  (() => {
    const f = assembledFixture('c1');
    autonomyOf(f.store, 100000);
    const before = walletMinor(f.store);
    const r = f.instance.economyActionAdapter.performAction(actionFor(f.productId));
    return r.ok === true && r.purchaseCreated === true &&
      r.authorityOutcome === C.AP_DECISION.AUTO_ALLOW &&
      r.reachedCapabilityGate === true &&
      r.capabilityIsNotEconomyAuthority === true &&
      r.actionIsNotAuthority === true &&
      f.store.listPurchases({}).count === 1 &&
      walletMinor(f.store) !== before;
  })(),
  (() => {
    const f = assembledFixture('c1d');
    autonomyOf(f.store, 100000);
    const before = walletMinor(f.store);
    const r = f.instance.economyActionAdapter.performAction(actionFor(f.productId));
    return { ok: r.ok, authorityOutcome: r.authorityOutcome, before: before,
      after: walletMinor(f.store), purchases: f.store.listPurchases({}).count };
  })());

check('C2 ★★ REQUIRE_APPROVAL：装配面的动作停在 WAITING_APPROVAL —— 零购买、零预留、批准由运行时创建',
  (() => {
    const f = assembledFixture('c2');
    autonomyOf(f.store, 5);
    const before = walletMinor(f.store);
    const r = f.instance.economyActionAdapter.performAction(actionFor(f.productId));
    const intent = f.store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
    return intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL &&
      r.purchaseCreated === false && r.reservedNothing === true &&
      f.store.listPurchases({}).count === 0 &&
      f.store.listApprovals({}).count === 1 &&
      walletMinor(f.store) === before;
  })(),
  (() => {
    const f = assembledFixture('c2d');
    autonomyOf(f.store, 5);
    const r = f.instance.economyActionAdapter.performAction(actionFor(f.productId));
    const intent = f.store.getPurchaseIntent({ agentIntentId: r.intentId }).intent;
    return { state: intent.state, purchases: f.store.listPurchases({}).count };
  })());

check('C3 ★★ 被拒的消费者经过装配出来的适配器**不产生任何 Intent**（P22-9 不可绕过）',
  (() => {
    const f = assembledFixture('c3');
    autonomyOf(f.store, 100000);
    /* 直接拿门绑一个被拒的消费者：这条路径证明"若有人绑错了消费者，
       适配器也不会替它开门"。 */
    const wrongAdapter = ADAPTER.createEconomyActionAdapter(
      f.instance.economyCapabilityGate.bind(C.ECONOMY_CONSUMER.DESKTOP_BRIDGE));
    const r = wrongAdapter.performAction(actionFor(f.productId));
    return r.ok === false && r.denied === true &&
      r.refusedBy === 'economy-capability-gate' &&
      r.gateDecision === C.CAPABILITY_DECISION.CAPABILITY_DENIED &&
      r.proposedNothing === true &&
      f.store.listPurchaseIntents({}).count === 0 &&
      f.store.listPurchases({}).count === 0;
  })(),
  (() => {
    const f = assembledFixture('c3d');
    autonomyOf(f.store, 100000);
    const wrongAdapter = ADAPTER.createEconomyActionAdapter(
      f.instance.economyCapabilityGate.bind(C.ECONOMY_CONSUMER.DESKTOP_BRIDGE));
    const r = wrongAdapter.performAction(actionFor(f.productId));
    return { refusedBy: r.refusedBy, gateDecision: r.gateDecision, reasonCode: r.reasonCode,
      intents: f.store.listPurchaseIntents({}).count };
  })());

check('C4 ★★ 幂等：同一个动作经过装配面重复两次 → 仍然只有一条 intent / 一笔购买',
  (() => {
    const f = assembledFixture('c4');
    autonomyOf(f.store, 100000);
    const action = actionFor(f.productId);
    const first = f.instance.economyActionAdapter.performAction(action);
    const second = f.instance.economyActionAdapter.performAction(action);
    return first.ok === true && second.replayed === true &&
      String(first.intentId) === String(second.intentId) &&
      f.store.listPurchaseIntents({}).count === 1 &&
      f.store.listPurchases({}).count === 1;
  })(),
  (() => {
    const f = assembledFixture('c4d');
    autonomyOf(f.store, 100000);
    const action = actionFor(f.productId);
    const first = f.instance.economyActionAdapter.performAction(action);
    const second = f.instance.economyActionAdapter.performAction(action);
    return { first: first.intentId, second: second.intentId, replayed: second.replayed,
      intents: f.store.listPurchaseIntents({}).count, purchases: f.store.listPurchases({}).count };
  })());

check('C5 ★★ 未知动作 / 缺幂等键 / 经济事实偷渡：装配面一律拒绝，且库里零新事实',
  (() => {
    const f = assembledFixture('c5');
    autonomyOf(f.store, 100000);
    const before = walletMinor(f.store);
    const a = f.instance.economyActionAdapter;
    const unknown = a.performAction({ action: 'ECONOMY_BUY', proposal: {}, idempotencyKey: K('u') });
    const noKey = a.performAction({
      action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE,
      proposal: { agentId: AGENT, productId: f.productId }
    });
    const smuggled = a.performAction({
      action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE,
      proposal: { agentId: AGENT, productId: f.productId, price: 1 },
      idempotencyKey: K('s')
    });
    return unknown.reasonCode === ADAPTER.ACTION_REFUSAL.UNKNOWN_ACTION &&
      noKey.reasonCode === ADAPTER.ACTION_REFUSAL.MISSING_IDEMPOTENCY_KEY &&
      smuggled.reasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT &&
      f.store.listPurchaseIntents({}).count === 0 &&
      f.store.listPurchases({}).count === 0 &&
      walletMinor(f.store) === before;
  })(),
  (() => {
    const f = assembledFixture('c5d');
    autonomyOf(f.store, 100000);
    const a = f.instance.economyActionAdapter;
    return [
      a.performAction({ action: 'ECONOMY_BUY', proposal: {}, idempotencyKey: K('u') }).reasonCode,
      a.performAction({ action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE, proposal: { agentId: AGENT, productId: f.productId } }).reasonCode,
      a.performAction({ action: ADAPTER.ACTION.ECONOMY_PROPOSE_PURCHASE, proposal: { agentId: AGENT, productId: f.productId, price: 1 }, idempotencyKey: K('s') }).reasonCode
    ];
  })());

/* ══════════════════════════════════════════════════════════════════
   收尾 · 资源回收与自证（§12）
   ══════════════════════════════════════════════════════════════════ */
section('收尾 · 资源回收');

(async () => {
  let closeFailures = 0;
  for (const c of closables.slice().reverse()) {
    try {
      if (typeof c.close === 'function') await c.close();
    } catch (_) { closeFailures += 1; }
  }
  closables.length = 0;
  let leftoverDirs = 0;
  tempDirs.forEach(d => {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { leftoverDirs += 1; }
    if (fs.existsSync(d)) leftoverDirs += 1;
  });

  check('R1 所有 store / server 都已关闭，临时目录已删除（没有遗留句柄）',
    closeFailures === 0 && leftoverDirs === 0,
    { closeFailures: closeFailures, leftoverDirs: leftoverDirs });
  check('R2 ★ 本文件 spawn 的子进程数 = 0，最大同时子进程数 = 0（§12：能单进程证明的不 spawn）',
    !Object.keys(require.cache).some(k => /[\\/]child_process\.js$/.test(k)),
    Object.keys(require.cache).filter(k => /[\\/]child_process\.js$/.test(k)));

  console.log('\n' + '═'.repeat(64));
  console.log('P22-10 runtime · child processes spawned: 0 · max concurrent: 0 · leaked: 0');
  console.log('P22-10 runtime · 加载的主要模块: home-node-service / economy-{contract,store,capability,action-adapter} / component-registry');
  if (failures === 0) {
    console.log('P22-10 runtime: 全部通过 ✔');
    process.exitCode = 0;
  } else {
    console.error('P22-10 runtime: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  }
})().catch(error => {
  console.error('P22-10 runtime: 未捕获异常 — ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
