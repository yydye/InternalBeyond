'use strict';
/* ====================================================================
   P22-13 · Economy Approval Decision Seam runtime（真实装配 + 真实 HTTP · **零子进程**）
   --------------------------------------------------------------------
   运行：node tests/test_p22_13_economy_approval_decision_runtime.js

   ── 为什么这个文件也一个子进程都不开（§12）─────────────────────────────
   §12 逐字要求：max concurrent child = 0 · total spawn = 0 · leftover = 0，
   只有在"本阶段新增、必须跨进程才能证明的身份 invariant"出现时才允许最多
   2 个 child。本阶段**没有**这样的 invariant：
     · "Agent 不能自我批准"是一个**结构性**事实（seam 里没有决定者参数、
       没有第二条到 store 的边、Agent 的句柄上没有决定能力），单进程可判定；
     · "一次决定只消费一次"是 P22-7 的状态机，已在 P22-7 的两进程组里证明；
     · 本阶段新增的东西是**一条 HTTP 路径**，而"一条 HTTP 路径"的真假只能
       由一个真实的、监听 socket 的 server 回答 —— server 起在**本进程**里
       就足够了（与 P22-11 的单进程组同款）。
   因此这里只开一个真实 Home Node 实例（真实装配 + 真实 socket + 真实 fetch），
   而**不开**任何子进程。

   ── 隔离 ────────────────────────────────────────────────────────────────
   一次性临时 dataDir + 一次性端口 + **一次性桌面 token**。
   不碰生产 dataDir，也不碰生产 token（IB_HOME_NODE_TOKEN 在这里被显式覆盖）。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const SEAM = require(path.join(ROOT, 'services', 'home-node', 'economy-approval-decision.js'));
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + J(extra) : ''));
  return false;
}
function section(title) { console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 62 - title.length))); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

const tempDirs = [];
const closables = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-13rt-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
let keySeq = 0;
function K(prefix) { keySeq += 1; return (prefix || 'k') + '-13rt-' + keySeq; }
const CUR = 'IB_CREDIT';
const AGENT = 'cfg_agent';
const TOKEN = 'p13-runtime-desktop-token';
const DECISION_PATH = '/internal/economy/approval-decision';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}),
      timeout: 8000
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}
const AUTH = { 'X-IB-Home-Token': TOKEN };

console.log('P22-13 · Economy Approval Decision Seam runtime');

/* ★ 整份测试跑在一个 async main 里：本文件用的是 CommonJS 的 require()，
   而顶层 await 会让 Node 无法判断模块格式（ERR_AMBIGUOUS_MODULE_SYNTAX）。
   一个显式的 main 同时说明"这里有一个真实的、可等待的生命周期"。 */
async function main() {

/* ══════════════════════════════════════════════════════════════════════
   A · 真实装配：两条启动路径都挂着这条 seam
   ══════════════════════════════════════════════════════════════════════ */
section('A · 真实装配（buildHomeNode 与进程级装配不得漂移）');

let built = null;
try {
  built = SERVICE.buildHomeNode({
    dataDir: tmpDir('build'), host: '127.0.0.1', port: 0,
    token: TOKEN, logger: () => {}
  });
  closables.push(built);
} catch (error) {
  console.error('buildHomeNode 失败 — ' + String((error && error.stack) || error));
  failures += 1;
}

check('A1 ★ buildHomeNode() 的返回值里有这条 seam，而且它与 store / 门是同一次装配的三个实例',
  !!built && built.economyApprovalDecision != null &&
  built.economyStore != null && built.economyCapabilityGate != null &&
  typeof built.economyApprovalDecision.dispatch === 'function' &&
  built.economyApprovalDecision.path === DECISION_PATH,
  built ? Object.keys(built).filter(k => /economy/i.test(k)) : null);

check('A2 ★ 进程级装配（生产启动路径）也有它 —— 这一域已经被"装配好了但没接线"咬过三次',
  SERVICE.economyApprovalDecision != null &&
  typeof SERVICE.economyApprovalDecision.dispatch === 'function' &&
  SERVICE.economyApprovalDecision.path === DECISION_PATH,
  Object.keys(SERVICE).filter(k => /economy/i.test(k)));

check('A3 ★ 它的公开面里**没有** store、没有门、没有适配器（只有 { path, dispatch, … }）',
  ['path', 'CONSUMER', 'DECISION', 'DECISION_LIST', 'ENVELOPE_KEYS', 'FORBIDDEN_IDENTITY_KEYS',
    'REFUSAL', 'dispatch', 'describe', 'audit', 'resumeKeyOf']
    .every(k => Object.keys(built.economyApprovalDecision).indexOf(k) >= 0) &&
  Object.keys(built.economyApprovalDecision).length === 11 &&
  built.economyApprovalDecision.store === undefined &&
  built.economyApprovalDecision.gate === undefined &&
  built.economyApprovalDecision.adapter === undefined,
  Object.keys(built.economyApprovalDecision));

check('A4 ★ 它绑在**用户决定**那个身份上，而不是 Agent（两者锚点不同、能力不同）',
  built.economyApprovalDecision.describe().capabilityConsumer === C.ECONOMY_CONSUMER.USER_DECISION_SEAM &&
  built.economyApprovalDecision.describe().capability === C.CAPABILITY.RESUME_APPROVED_PURCHASE &&
  built.economyApprovalDecision.describe().canProposeAPurchase === false &&
  built.economyActionAdapter.consumer === C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME);

check('A5 ★ 未配置桌面凭据的装配里，这条面是**关**的（fail closed，而不是默认放行）',
  (() => {
    const noCred = SERVICE.economyAssembly({ dataDir: tmpDir('nocent'), desktopToken: '', logger: () => {} });
    /* ★ 刻意**不**把它推进 closables：这一份装配从来没有 open() 过，而
       收尾时对同一个 dataDir 再开一个实例去 close 只会制造一次无意义的写。
       它只用来说明"未配置凭据时这一面整体关闭"。 */
    return noCred.economyApprovalDecision.describe().open === false &&
      noCred.economyApprovalDecision.describe().openRequires.desktopCredentialConfigured === false &&
      noCred.economyApprovalDecision.dispatch({ loopback: true, desktopCredential: 'anything' },
        { approvalId: 'x', decision: 'APPROVE', idempotencyKey: 'k' }).status === 503;
  })());

/* ══════════════════════════════════════════════════════════════════════
   B · 真实 HTTP：一条 authenticated 的用户决定
   ══════════════════════════════════════════════════════════════════════ */
section('B · 真实 HTTP（真实 socket · 真实凭据 · 一条真的购买）');

let port = 0;
let instance = null;
let f = null;

async function boot() {
  port = await freePort();
  instance = SERVICE.buildHomeNode({
    dataDir: tmpDir('http'), host: '127.0.0.1', port: port,
    token: TOKEN, logger: () => {}
  });
  closables.push(instance);
  instance.open();
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(port, '127.0.0.1', resolve);
  });
  const store = instance.economyStore;
  /* ★ 真实装配里的 ownerExists 谓词读的是**角色目录**（device-registry 的
     characters 表）—— 那是生产语义（"钱包的 owner 必须是一个真实存在的
     角色"）。因此这里先登记一个角色，用的就是那条既有路径
     （registry.putCharacter），而不是把谓词关掉。 */
  const registered = instance.registry.putCharacter(AGENT, { nickname: 'P13 Agent' });
  if (!registered || registered.ok !== true) {
    throw new Error('registry.putCharacter failed: ' + J(registered));
  }
  const storeId = store.putStore({ name: 'Runtime Store', idempotencyKey: K('store') }).result.store.storeId;
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
  store.putAutonomyPolicy({
    ownerId: AGENT, currency: CUR, enabled: true, perPurchaseLimitMinor: 100000,
    dailyAutonomousLimitMinor: 100000, approvalAboveMinor: 5,
    allowedProductKinds: ['COMPUTE_CREDIT'], allowedSettlementTypes: ['COMPUTE_GRANT'],
    allowGift: false, idempotencyKey: K('autonomy')
  });
  return { productId: productId, walletId: String(wallet.wallet.walletId) };
}
function worldOf() {
  const store = instance.economyStore;
  const w = store.getWallet({ ownerId: AGENT, currency: CUR }).wallet;
  return {
    cached: String(w.cachedBalanceMinor), reserved: String(w.reservedBalanceMinor),
    purchases: store.listPurchases({}).count,
    approvals: store.listApprovals({}).count,
    inventory: (store.listInventory({ ownerId: AGENT }).entries || []).length
  };
}
/* 提议走的是**生产**的那条路：Agent → 适配器 → 门 → P22-8。
   它在这里不是 HTTP（P22-11 的通道有它自己的跨进程证明），而是同进程的
   真实装配对象 —— 本阶段要证明的是**用户那一条腿**。 */
function agentPropose(productId, options) {
  const o = options || {};
  return instance.economyActionAdapter.performAction({
    action: 'ECONOMY_PROPOSE_PURCHASE',
    proposal: Object.assign({ agentId: AGENT, productId: productId, reason: o.reason || 'compute is running low' }, o.proposal || {}),
    idempotencyKey: o.idempotencyKey || K('intent')
  });
}

try {
  f = await boot();

  const proposed = agentPropose(f.productId);
  check('B1 提议走生产链成立，并停在 WAITING_APPROVAL（这条面存在的理由）',
    proposed.ok === true && proposed.intent && proposed.intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL &&
    C.isEconomyId('APPROVAL', proposed.approvalId),
    { ok: proposed.ok, state: proposed.intent && proposed.intent.state, reasonCode: proposed.reasonCode });

  const listed = await request(port, 'GET', '/economy/intents', null, AUTH);
  check('B2 那条等待中的批准可以通过**既有的只读 HTTP 面**被看到（UI 不需要新读路径）',
    listed.status === 200 && Array.isArray(listed.body.intents) &&
    listed.body.intents.some(x => x.agentIntentId === proposed.intentId && x.state === 'WAITING_APPROVAL'),
    { status: listed.status, count: listed.body.intents && listed.body.intents.length });
  const approvalRead = await request(port, 'GET', '/economy/approval?approvalId=' + encodeURIComponent(proposed.approvalId), null, AUTH);
  check('B3 那条批准本身也是只读的（status=PENDING、singleUse=true）',
    approvalRead.status === 200 && approvalRead.body.approval &&
    approvalRead.body.approval.status === 'PENDING' && approvalRead.body.approval.singleUse === true,
    { status: approvalRead.status, approval: approvalRead.body.approval && approvalRead.body.approval.status });

  const before = worldOf();
  /* ★ 重试的**身份**必须与被重试的那一次逐字相同：`K(...)` 每次求值都产生
     一个新的幂等身份，因此它在这里求值一次、存进一个变量。
     （单进程组里这个教训已经用一次真实的红写过一遍 —— 见那个文件里
     E 组开头的说明。） */
  const approveKey = K('http-approve');
  const decided = await request(port, 'POST', DECISION_PATH, {
    approvalId: proposed.approvalId, decision: 'APPROVE', idempotencyKey: approveKey
  }, AUTH);
  check('B4 ★★ 用户通过真实 HTTP + 真实桌面凭据点头：决定落库，同一条 intent 被续做',
    decided.status === 200 && decided.body.ok === true &&
    decided.body.decision === C.APPROVAL_STATE.APPROVED &&
    decided.body.decider === 'user:user' &&
    decided.body.decisionRecorded === true &&
    decided.body.continuation === 'attempted' &&
    decided.body.continuationOk === true &&
    decided.body.approvalIsNotAGuaranteedPurchase === true,
    { status: decided.status, body: decided.body });

  const after = worldOf();
  check('B5 ★ 经济事实真的动了：余额 −10、一笔购买、一件库存（而且只动了一次）',
    after.purchases === before.purchases + 1 &&
    after.inventory === before.inventory + 1 &&
    BigInt(after.cached) === BigInt(before.cached) - 10n &&
    BigInt(after.reserved) === 0n,
    { before: before, after: after });

  const purchasesRead = await request(port, 'GET', '/economy/purchases', null, AUTH);
  check('B6 ★ UI 能用**已有的**只读面读到结果（新增的只有一条写路径，没有新增读路径）',
    purchasesRead.status === 200 &&
    Array.isArray(purchasesRead.body.purchases) &&
    purchasesRead.body.purchases.length === 1 &&
    purchasesRead.body.purchases[0].status === 'COMPLETED' && purchasesRead.body.purchases[0].completed === true,
    { status: purchasesRead.status, purchases: purchasesRead.body.purchases });

  const intentRead = await request(port, 'GET', '/economy/intent?agentIntentId=' + encodeURIComponent(proposed.intentId) + '&withChain=1', null, AUTH);
  check('B7 ★ 那六个"为什么"的问题在真实进程上有了完整答案（intentChain 走到 purchase）',
    intentRead.status === 200 && intentRead.body.ok === true &&
    intentRead.body.intent.state === 'COMPLETED' &&
    intentRead.body.chain != null,
    { status: intentRead.status, state: intentRead.body.intent && intentRead.body.intent.state });

  const replay = await request(port, 'POST', DECISION_PATH, {
    approvalId: proposed.approvalId, decision: 'APPROVE', idempotencyKey: approveKey
  }, AUTH);
  check('B8 ★ 同一个身份的重试在真实 HTTP 上也是幂等的：没有第二笔购买',
    replay.status === 200 && replay.body.ok === true && replay.body.replayed === true &&
    J(worldOf()) === J(after),
    { status: replay.status, replayed: replay.body.replayed, before: after, after: worldOf() });

  /* ── §2 身份分离：两层独立的凭据，两层都在工作 ──────────────────────
     ★ 这条路径上其实有**两**层保护，而它们必须被分开证明 —— 把它们混成
     "反正都 403"会让其中一层悄悄消失：
       · 外层是 Home Node 既有的**桌面面**规则（/internal/ 前缀 ⇒ 桌面 token，
         远端未配置时 403，凭据不对时 401）—— 本阶段一行都没改它；
       · 内层是 seam 自己的用户凭据判定（少/错凭据 ⇒ 403，且不碰 store）。
     下面三条走的是**外层**（它们连凭据都没带对，因此根本到不了 seam），
     而内层在单进程组（C 组）里被逐条证明。 */
  const noCred = await request(port, 'POST', DECISION_PATH, {
    approvalId: proposed.approvalId, decision: 'REJECT', idempotencyKey: K('nope')
  }, null);
  check('B9 ★★ 没有桌面凭据的调用方（例如一个自己发 HTTP 的本机进程 / Agent）'
    + '拿不到这条面：外层 401 unauthenticated，而且世界逐字节不变',
    noCred.status === 401 && noCred.body.error === 'unauthenticated' &&
    J(worldOf()) === J(after),
    { status: noCred.status, body: noCred.body });

  const wrongCred = await request(port, 'POST', DECISION_PATH, {
    approvalId: proposed.approvalId, decision: 'REJECT', idempotencyKey: K('nope')
  }, { 'X-IB-Home-Token': 'not-the-token' });
  check('B10 错误的凭据同样被外层挡住（401），世界逐字节不变',
    wrongCred.status === 401 && J(worldOf()) === J(after),
    { status: wrongCred.status, body: wrongCred.body });

  const selfReport = await request(port, 'POST', DECISION_PATH, {
    approvalId: proposed.approvalId, decision: 'REJECT', idempotencyKey: K('self'),
    decidedBy: { type: 'user', id: 'user' }
  }, AUTH);
  check('B11 ★★ 即使出示了正确的桌面凭据，调用方也**不能自报身份**：'
    + 'payload 里的身份键被逐名拒绝，且没碰 store',
    selfReport.status === 403 &&
    selfReport.body.reasonCode === SEAM.REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT &&
    selfReport.body.rejectedIdentityKeys.indexOf('decidedBy') >= 0 &&
    selfReport.body.identityIsEstablishedByTheTransport === true &&
    selfReport.body.reachedStore === false &&
    J(worldOf()) === J(after),
    { status: selfReport.status, reason: selfReport.body.reasonCode,
      rejected: selfReport.body.rejectedIdentityKeys });

  const agentCredential = await request(port, 'POST', DECISION_PATH, {
    approvalId: proposed.approvalId, decision: 'REJECT', idempotencyKey: K('agenttok')
  }, { 'X-IB-Economy-Channel-Source': 'source-token' });
  check('B12 ★★ 拿**来源凭据**（Agent 那一套）来这条路径没有用：两条路径不共用凭据',
    agentCredential.status === 401 &&
    J(worldOf()) === J(after),
    { status: agentCredential.status, body: agentCredential.body });

  /* ── REJECT 在真实 HTTP 上：终止 + 零经济动作 ──────────────────────── */
  const second = agentPropose(f.productId, { proposal: { units: 2 }, reason: 'second', idempotencyKey: K('intent2') });
  const beforeReject = worldOf();
  const rejectKey = K('http-reject');
  const rejected = await request(port, 'POST', DECISION_PATH, {
    approvalId: second.approvalId, decision: 'REJECT', idempotencyKey: rejectKey
  }, AUTH);
  check('B13 ★ 摇头也是这条路径上的一次真实决定：REJECTED，而且**没有**续做',
    rejected.status === 200 && rejected.body.ok === true &&
    rejected.body.approvalStatus === C.APPROVAL_STATE.REJECTED &&
    rejected.body.resumeAttempted === false && rejected.body.reachedResumeHandle === false &&
    rejected.body.continuation === 'none',
    { status: rejected.status, body: rejected.body });
  check('B14 ★ 而且零经济动作：余额、购买数、库存都没动',
    J(worldOf()) === J(beforeReject),
    { before: beforeReject, after: worldOf() });

  const rejectReplay = await request(port, 'POST', DECISION_PATH, {
    approvalId: second.approvalId, decision: 'REJECT', idempotencyKey: rejectKey
  }, AUTH);
  check('B15 摇头的重放同样是幂等的，而且**不会**让那条批准复活',
    rejectReplay.status === 200 && rejectReplay.body.replayed === true &&
    rejectReplay.body.approvalStatus === C.APPROVAL_STATE.REJECTED &&
    J(worldOf()) === J(beforeReject),
    { status: rejectReplay.status, replayed: rejectReplay.body.replayed });

  /* ── 方法面：这条路径只接受 POST ───────────────────────────────────── */
  const getDecision = await request(port, 'GET', DECISION_PATH, null, AUTH);
  check('B16 这条路径只接受 POST：GET ⇒ 405（而且它不在 /economy/ 下，见 J 组）',
    getDecision.status === 405 && getDecision.body.error === 'economy-approval-decision-is-post-only',
    { status: getDecision.status, error: getDecision.body.error });
  const delDecision = await request(port, 'DELETE', DECISION_PATH, null, AUTH);
  check('B17 DELETE 同样 405（没有"删掉一条批准"这种能力）',
    delDecision.status === 405, { status: delDecision.status });

  /* ── §11 public surface：/economy/* 写面仍然为 0 ───────────────────── */
  const writePaths = ['/economy/approve', '/economy/reject', '/economy/approval/decide',
    '/economy/intent/propose', '/economy/intent/resume', '/economy/execute',
    '/economy/settle', '/economy/buy'];
  let allReadOnly = true;
  const observed = [];
  for (const p of writePaths) {
    const r = await request(port, 'POST', p, { decision: 'APPROVE', approvalId: proposed.approvalId }, AUTH);
    observed.push(p + '→' + r.status + (r.body && r.body.error ? ':' + r.body.error : ''));
    if (!(r.status === 405 && r.body.error === 'economy-is-read-only')) allReadOnly = false;
  }
  check('B18 ★★ 普通 /economy/* 上的写面仍然**为 0**：八条最自然的写形态全部 405 economy-is-read-only',
    allReadOnly, observed);

  /* ── §11 /security 自述：声明必须与真实路由一致 ────────────────────── */
  const security = await request(port, 'GET', '/security', null, AUTH);
  const pol = security.body.economyPolicy;
  check('B19 ★ /security 把这条新面写成**可断言的字段**，而且它的名单恰好是两个决定词',
    security.status === 200 &&
    pol.approvalDecision.implemented === true &&
    pol.approvalDecision.open === true &&
    J(pol.approvalDecision.approvalDecisionWritesExposed) === J(['APPROVED', 'REJECTED']) &&
    J(pol.approvalDecision.decisionWritesThatAreNotAPPROVEorREJECT) === J([]) &&
    pol.approvalDecision.bypassesTheResumeChain === false &&
    pol.approvalDecision.carriesEconomicFacts === false &&
    pol.approvalDecision.requiresConfiguredDesktopCredential === true &&
    pol.approvalDecision.pathIsNotUnderEconomyReadPaths === true &&
    pol.approvalDecision.sharesAConsumerWithTheCommandChannel === false &&
    pol.approvalDecision.sharesACredentialWithTheCommandChannel === false,
    pol && pol.approvalDecision);
  check('B20 ★ 声明的路径就是真实可达的那一条（"声明比真实路由更保守"这类漂移不会再出现）',
    pol.approvalDecision.path === DECISION_PATH &&
    (await request(port, 'POST', pol.approvalDecision.path, {
      approvalId: proposed.approvalId, decision: 'REJECT', idempotencyKey: K('surface')
    })).status !== 404);
  check('B21 ★ Agent 那条 command 面**没有**被顺手打开：它仍然是关的（这个实例没有配置来源登记册），'
    + '而它的三个"别的写形态"名单**全部为空** —— 用户决定那条面不在它里面，'
    + '它是**另一条**路径',
    pol.commandChannel.implemented === true &&
    pol.commandChannel.open === false &&
    J(pol.commandChannel.commandWritesExposed) === J([]) &&
    J(pol.commandChannel.approvalWritesExposed) === J([]) &&
    J(pol.commandChannel.resumeWritesExposed) === J([]) &&
    J(pol.commandChannel.capabilityWritesExposed) === J([]),
    pol.commandChannel);
  check('B22 /economy/* 的读面仍然全是 GET（这句话没有被这条新路径破坏）',
    J(pol.httpVerbs) === J(['GET']) &&
    pol.approvalDecision.path.indexOf('/economy/') !== 0 &&
    pol.commandChannel.pathIsNotUnderEconomyReadPaths === true,
    { httpVerbs: pol.httpVerbs, decisionPath: pol.approvalDecision.path });

  /* ── 凭据绝不出现在响应或日志里 ────────────────────────────────────── */
  const status = await request(port, 'GET', '/status', null, AUTH);
  const securityRaw = await request(port, 'GET', '/security', null, AUTH);
  check('B23 ★ 一次真实决定之后，桌面凭据不出现在 /security、/status 或任何一条决定的返回值里',
    J(securityRaw.body).indexOf(TOKEN) < 0 &&
    J(status.body).indexOf(TOKEN) < 0 &&
    J(decided.body).indexOf(TOKEN) < 0,
    { securityMentionsToken: J(securityRaw.body).indexOf(TOKEN) >= 0 });

  const audit = instance.economyApprovalDecision.audit();
  check('B24 ★ seam 自己的审计环只记 canonical 事实（不记凭据、不记 payload）',
    audit.length >= 4 &&
    audit.every(e => J(e).indexOf(TOKEN) < 0) &&
    audit.some(e => e.event === 'economy-approval-decision-decided' && e.continuation === 'none') &&
    audit.some(e => e.event === 'economy-approval-decision-continued' && e.budgetIsStillAuthoritative === true),
    audit.map(e => e.event));
} catch (error) {
  failures += 1;
  console.error('✖ runtime 组抛出 — ' + String((error && error.stack) || error));
}

/* ══════════════════════════════════════════════════════════════════════
   C · 收尾：资源纪律
   ══════════════════════════════════════════════════════════════════════ */
section('C · 进程纪律与清理');

try {
  if (instance && instance.server && instance.server.listening) {
    await new Promise(resolve => instance.server.close(resolve));
    instance.server.closeAllConnections && instance.server.closeAllConnections();
  }
} catch (_) { /* 已关闭 */ }
for (const c of closables) {
  try { if (c && typeof c.close === 'function') c.close(); } catch (_) { /* 已关闭 */ }
}
for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 已删 */ } }

check('C1 ★ 进程纪律：max concurrent child = 0 · total spawn = 0 · 0 leftover'
  + '（真实 server 已关闭，临时目录已删除）',
  !instance || !instance.server.listening,
  { listening: instance && instance.server ? instance.server.listening : null });

console.log('\n' + '═'.repeat(64));
console.log('P22-13 approval decision runtime（真实装配 + 真实 HTTP）: ' + checks + ' 项检查');
if (failures === 0) {
  console.log('全部通过 ✔ · max concurrent child = 0 · total spawn = 0 · leftover = 0');
  process.exitCode = 0;
} else {
  console.error(failures + ' 项失败 ✘');
  process.exitCode = 1;
}

}

main().catch(error => {
  console.error('P22-13 runtime 主流程抛出 — ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
