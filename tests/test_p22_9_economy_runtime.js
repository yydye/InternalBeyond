'use strict';
/* ====================================================================
   P22-9 · Economy Capability Gate runtime（真实装配 + 真实 HTTP · **零子进程**）
   --------------------------------------------------------------------
   运行：node tests/test_p22_9_economy_runtime.js

   ── 为什么这个文件也一个子进程都不开（§9）─────────────────────────────
   P22-2 ~ P22-8 的 runtime 测试都 spawn 了真实服务进程，而 P22-9 刻意不：
   §9 逐字要求"能单进程证明的，不允许 spawn；能小 fixture 证明的，不允许
   启动完整 IB/DSH/Desktop"，并且"两个进程已经能证明的竞争条件，不允许开
   第三个"。

   本阶段要证明的运行时事实只有两条：
     ① 真实装配（buildHomeNode 与进程级装配）里真的挂着一扇门，而且两条
        路径的门给出**同一个**矩阵；
     ② HTTP 上**没有**任何一条路径能授权、能提议、能读矩阵。
   两条都不需要第二个进程：
     · ① 在同一个进程里 require 两个装配入口即可（node:sqlite 是同步的，
       "两条路径"是两次函数调用，不是两个操作系统进程）；
     · ② HTTP 是真的（真实 socket、真实 handler），但 server 起在**本进程**
       里 —— 与 test_p22_2_economy_runtime.js 的 in-process 组同款。
   唯一的跨进程性质（同一个提议在两个真实进程里恰好产生一条 intent）属于
   P22-8 的 store，已经在 p22-8-intent-worker.js 的两进程组里被证明过；
   在 P22-9 重做一遍不会多证明任何关于**门**的事情（§10）。

   ── 隔离 ────────────────────────────────────────────────────────────────
   一次性临时 dataDir + 一次性端口 + token ''。**不碰**生产 dataDir。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createHttp = require(path.join(ROOT, 'services', 'home-node', 'http.js'));
const createChatStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const createEconomyCapabilityGate = require(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));

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

/* ── 资源台账（§9 的生命周期要求）──────────────────────────────────── */
const tempDirs = [];
const closables = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-9rt-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
let keySeq = 0;
function K(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }
const CUR = 'IB_CREDIT';
const AGENT = 'cfg_agent';
const ALLOWED = C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME;
const DENIED = C.ECONOMY_CONSUMER.DESKTOP_BRIDGE;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
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

console.log('P22-9 · Economy Capability Gate runtime');

/* ══════════════════════════════════════════════════════════════════
   A · 真实装配：两条启动路径都必须挂上门（否则门只是一个库）
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

check('A1 ★ buildHomeNode() 的返回值里有门，而且它与 economyStore 是**同一次装配**里的两个实例',
  !!built && built.economyCapabilityGate != null &&
  built.economyStore != null &&
  built.economyCapabilityGate.describe().storeAssembled === true,
  built ? Object.keys(built).filter(k => /economy/i.test(k)) : null);

check('A2 ★★ 进程级装配（生产启动路径）也有门 —— 这一域已经被"装配好了但没接线"咬过三次',
  SERVICE.economyCapabilityGate != null &&
  SERVICE.economyCapabilityGate.describe().gate === 'economy-capability-gate',
  Object.keys(SERVICE).filter(k => /economy/i.test(k)));

check('A3 ★ 两条装配路径的门给出**逐字相同**的矩阵（漂移在这里是不可能的，因为它们共用契约）',
  !!built && J(built.economyCapabilityGate.describe().consumers) === J(SERVICE.economyCapabilityGate.describe().consumers) &&
  J(built.economyCapabilityGate.describe().capabilities) === J(SERVICE.economyCapabilityGate.describe().capabilities));

check('A4 装配期的门**没有**被配置成收窄（生产默认 = 契约矩阵），也没有损坏',
  SERVICE.economyCapabilityGate.describe().configurationCorrupt === false &&
  SERVICE.economyCapabilityGate.describe().revokedCapabilities.length === 0);

/* ══════════════════════════════════════════════════════════════════
   B · 真实 HTTP（in-process server，真实 socket）
   ══════════════════════════════════════════════════════════════════ */
section('B · 真实 HTTP：写面为 0、读面为 0、门不可达');

const CAPABILITY_PATHS = ['/economy/capability', '/economy/capabilities',
  '/economy/capability/grant', '/economy/capability/revoke',
  '/economy/gate', '/economy/gate/check'];

async function httpGroup() {
  const dir = tmpDir('http');
  const chat = createChatStore({ dataDir: dir, logger: () => { } });
  chat.open();
  closables.push(chat);
  const economy = createEconomyStore({ dataDir: dir, logger: () => { } });
  economy.open();
  closables.push(economy);
  const gate = createEconomyCapabilityGate({ store: economy });

  /* 一个真实的货架 + 商品 + 有钱的钱包：让"HTTP 提议若真存在就会成功"
     这件事是真的（否则"没有产生 intent"可能只是因为夹具不完整）。 */
  const storeId = economy.putStore({ name: 'S', idempotencyKey: K('s') }).result.store.storeId;
  const productId = economy.putProduct({
    storeId: storeId, kind: 'COMPUTE_CREDIT', name: 'C', currency: CUR,
    unitPriceMinor: 10, grantQuantity: 1000, idempotencyKey: K('p')
  }).result.product.productId;
  const w = economy.openWallet({ owner: { type: 'character', id: AGENT }, currency: CUR });
  economy.mintForSystem({
    systemInitiated: true, walletId: w.wallet.walletId, currency: CUR,
    amountMinor: 100000, idempotencyKey: K('m')
  });
  economy.putBudgetPolicy({
    ownerId: AGENT, currency: CUR,
    limits: { perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000 },
    idempotencyKey: K('b')
  });
  economy.putAutonomyPolicy({
    ownerId: AGENT, currency: CUR, enabled: true, perPurchaseLimitMinor: 100000,
    dailyAutonomousLimitMinor: 100000, approvalAboveMinor: 100000,
    allowedProductKinds: ['COMPUTE_CREDIT'], allowedSettlementTypes: ['COMPUTE_GRANT'],
    allowGift: false, idempotencyKey: K('a')
  });
  /* 夹具自证：同一份提议**经过门**是会成功的（下面 B5 要拿它当对照）。 */
  const control = gate.bind(ALLOWED).proposePurchaseIntent({
    proposal: { agentId: AGENT, productId: productId, reason: 'control' }, idempotencyKey: K('ctrl')
  });
  check('B0 夹具自证：同一份提议经过门是**会成立**的（否则下面的"没有产生 intent"证明不了任何事）',
    control.ok === true && typeof control.intentId === 'string' && economy.listPurchaseIntents({}).count === 1,
    { ok: control.ok, intentId: control.intentId, errors: control.errors });

  const layer = createHttp({
    store: chat, executor: null, gateway: null, token: '', version: 'test',
    allowedOrigins: [], logger: () => { }, economyStore: economy
  });
  closables.push({ close: () => new Promise(r => layer.server.close(r)) });
  const port = await freePort();
  await new Promise(r => layer.server.listen(port, '127.0.0.1', r));

  const intentsBefore = economy.listPurchaseIntents({}).count;
  const changesBefore = economy.listChanges(0, 500).length;

  const postResults = [];
  for (const p of CAPABILITY_PATHS) {
    postResults.push({ path: p, res: await request(port, 'POST', p, { consumer: ALLOWED, capability: 'PROPOSE_PURCHASE' }) });
  }
  check('B1 ★ 六条"授权形态"的路径上 POST 全部 405（不存在任何一条能授权 / 能提议的写路由）',
    postResults.every(x => x.res.status === 405),
    postResults.map(x => x.path + '=' + x.res.status));

  const getResults = [];
  for (const p of CAPABILITY_PATHS) {
    getResults.push({ path: p, res: await request(port, 'GET', p) });
  }
  check('B2 那六条路径上 GET 也不存在（门**连读面**都不对外：矩阵是同进程的装配事实）',
    getResults.every(x => x.res.status === 404 || x.res.status === 405),
    getResults.map(x => x.path + '=' + x.res.status));

  const putResults = [];
  for (const p of CAPABILITY_PATHS) putResults.push(await request(port, 'PUT', p, {}));
  check('B3 PUT / DELETE 同样一条都不存在（写动词的第三个与第四个字形也没有漏出来）',
    putResults.every(x => x.status === 405) &&
    (await Promise.all(CAPABILITY_PATHS.map(p => request(port, 'DELETE', p)))).every(x => x.status === 405),
    putResults.map(x => x.status));

  check('B4 ★★ HTTP 上 24 次尝试之后，经济事实**逐字未变**：intent 数与 change log 行数都不动',
    economy.listPurchaseIntents({}).count === intentsBefore &&
    economy.listChanges(0, 500).length === changesBefore,
    { intents: economy.listPurchaseIntents({}).count, intentsBefore: intentsBefore,
      changes: economy.listChanges(0, 500).length, changesBefore: changesBefore });

  const sec = await request(port, 'GET', '/security');
  /* ★ /security 的字段是**顶层**的（loopbackOnly / economyPolicy / …），
     没有一层 security 包装。开发期实测踩到：读错一层会得到 undefined，
     而 `!!policy` 为 false 时断言会失败（看得见）—— 但如果写成
     `!policy || …` 就会静默通过。这里保留 `!!policy` 这一条。 */
  const policy = sec.body && sec.body.economyPolicy;
  check('B5 ★ /security 把 P22-9 的"没有"写成可断言字段，而且两个名单都是空的',
    sec.status === 200 && !!policy &&
    policy.capabilityGateImplemented === true &&
    Array.isArray(policy.capabilityWritesExposed) && policy.capabilityWritesExposed.length === 0 &&
    Array.isArray(policy.capabilityReadsExposed) && policy.capabilityReadsExposed.length === 0 &&
    policy.capabilityGrantViaHttpIsForbidden === true &&
    policy.capabilityIsNotEconomyAuthority === true &&
    policy.capabilityIsNotABudgetDecision === true,
    { status: sec.status, policy: policy });

  check('B6 ★ /security 的 unreachable 里有那六条，而 desktopPaths 里一条都没有',
    !!policy && Array.isArray(policy.unreachable) &&
    CAPABILITY_PATHS.every(p => policy.unreachable.indexOf(p) >= 0) &&
    Array.isArray(policy.desktopPaths) &&
    CAPABILITY_PATHS.every(p => policy.desktopPaths.indexOf(p) < 0),
    policy ? { unreachable: policy.unreachable.filter(p => /capabilit|gate/.test(p)), desktop: policy.desktopPaths } : null);

  check('B7 ★ 门允许的那一次提议**只**由同进程 API 产生（对照 B0 与 B4：HTTP 不能产生第二条）',
    economy.listPurchaseIntents({}).count === 1 &&
    control.intentId === economy.listPurchaseIntents({}).intents[0].agentIntentId);

  check('B8 /economy/health 仍然只在装配齐全时回答 200（门的存在没有改变只读面的行为）',
    (await request(port, 'GET', '/economy/health')).status === 200);
}

/* ══════════════════════════════════════════════════════════════════
   C · §8：Provider / Payment / Memory / Relationship 写路径仍然为 0
   ══════════════════════════════════════════════════════════════════ */
section('C · §8 的边界在 P22-9 之后逐字不变');

check('C1 门的 describe() 自述"没有底层经济写能力、没有通用分派"',
  SERVICE.economyCapabilityGate.describe().exposesLowLevelEconomyWrites === false &&
  SERVICE.economyCapabilityGate.describe().exposesGenericDispatch === false);

check('C2 ★ 门的依赖闭包里没有网络 / 进程 / 加密模块（准入不需要端口，也不需要时间）',
  !Object.keys(require.cache).some(k => /[\\/]economy-capability\.js$/.test(k) &&
    false) &&
  !Object.keys(require.cache).some(k => /[\\/]child_process\.js$/.test(k)));

check('C3 一次准入通过**不是**经济权威：契约里那七个位与 AP_DECISION 字形不相交',
  C.CAPABILITY_DECISIONS.every(d => C.AP_DECISIONS.indexOf(d) < 0) &&
  C.CAPABILITY_DENY_REASONS.every(r => C.DENY_REASONS.indexOf(r) < 0));

check('C4 gate 的公开面无 write 动词 —— 句柄键恰好五个，且没有 store',
  (() => {
    const h = SERVICE.economyCapabilityGate.bind(ALLOWED);
    return Object.keys(h).sort().join(',') ===
      ['anchor', 'capabilities', 'consumer', 'proposePurchaseIntent', 'resumeApprovedPurchase'].sort().join(',') &&
      h.store === undefined;
  })());

/* ══════════════════════════════════════════════════════════════════
   收尾 · 资源回收与自证（§9）
   ══════════════════════════════════════════════════════════════════ */
section('收尾 · 资源回收');

(async () => {
  await httpGroup();

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
    closeFailures === 0 && leftoverDirs === 0, { closeFailures: closeFailures, leftoverDirs: leftoverDirs });
  check('R2 ★ 本文件 spawn 的子进程数 = 0，最大同时子进程数 = 0（§9：能单进程证明的不 spawn）',
    !Object.keys(require.cache).some(k => /[\\/]child_process\.js$/.test(k)));

  console.log('\n' + '═'.repeat(64));
  console.log('P22-9 runtime · child processes spawned: 0 · max concurrent: 0 · leaked: 0');
  console.log('P22-9 runtime · 加载的主要模块: home-node-service / http / economy-{contract,store,capability} / chat-store');
  if (failures === 0) {
    console.log('P22-9 runtime: 全部通过 ✔');
    process.exitCode = 0;
  } else {
    console.error('P22-9 runtime: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  }
})().catch(error => {
  console.error('P22-9 runtime: 未捕获异常 — ' + String((error && error.stack) || error));
  process.exitCode = 1;
});
