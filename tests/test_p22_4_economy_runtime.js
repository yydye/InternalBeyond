'use strict';
/* ====================================================================
   P22-4 · Economy runtime 接线（HTTP 只读面 + 真实子进程）
   --------------------------------------------------------------------
   运行：node tests/test_p22_4_economy_runtime.js

   本文件回答的问题与 store 测试**不同**：
     store 测试问"预算规则与报价这一层的语义对不对"；本文件问
     「**生产进程里**这一层能不能被看到，而且它**仍然**不能改任何东西？」

   ── 为什么这一阶段特别需要真实子进程 ─────────────────────────────────
   P22-4 引入了**两类新的东西**：规则（预算政策）与命题（报价）。它们
   都有会改状态的 store 方法，而本阶段一条写路由都不开。这里必须证明的
   不是"我们没写路由"，而是三件更难的事：
     ① 生产进程里 GET /economy/policy · /budget · /quote(s) 真的能读到
        数据（而不是 501 / 404 / 空数组）；
     ② 对这些路径的每一种写动词（POST / PUT / DELETE）都是 405，而且
        **写尝试之后政策、报价、账本、预留一个字节都没变**；
     ③ `/economy/budget` 与 `/economy/quote?evaluate=1` 这两条**会做判断**
        的读路由不改变任何东西 —— 一次评估不是一次预留，更不是一次购买。

   ── 这个仓库的"第五次形态"────────────────────────────────────────────
   memory / understanding / moments / economy-store 各被"装配好了但没接上"
   咬过一次（P22-2 的 §13.2 抓到第四次）。P22-4 **没有新增 store**，但它
   新增了路由要读的对象 —— 因此同一类断言必须重跑：真的 spawn
   services/home-node-service.js、真的打这几条新路径。
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_FILE = 'services/home-node-service.js';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-4rt-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}),
      timeout: 8000
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 400) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const BUNDLED_NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const NODE_BIN = fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;
const openChildren = new Set();
process.on('exit', () => {
  for (const child of openChildren) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});
function startProduction(dir) {
  return freePort().then(port => new Promise(resolve => {
    const child = spawn(NODE_BIN, [SERVICE_FILE], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        IB_HOME_NODE_PORT: String(port),
        IB_HOME_NODE_DATA_DIR: dir
      }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    openChildren.add(child);
    const svc = { port: port, child: child, stdout: '', stderr: '', exited: null };
    svc.output = () => (svc.stdout + svc.stderr).slice(-4000);
    child.stdout.on('data', c => { svc.stdout += String(c); });
    child.stderr.on('data', c => { svc.stderr += String(c); });
    child.on('exit', (code, signal) => { svc.exited = { code: code, signal: signal }; openChildren.delete(child); });
    resolve(svc);
  }));
}
async function waitListening(svc, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (svc.exited) return false;
    try { const r = await request(svc.port, 'GET', '/health'); if (r.status === 200) return true; } catch (_) { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}
async function stopProduction(svc) {
  if (!svc || svc.exited) return;
  try { await request(svc.port, 'POST', '/__shutdown', {}); } catch (_) { /* 可能已经退出 */ }
  for (let i = 0; i < 60 && !svc.exited; i++) await sleep(100);
  if (!svc.exited) svc.child.kill('SIGTERM');
  for (let i = 0; i < 30 && !svc.exited; i++) await sleep(100);
}

console.log('P22-4 · Economy runtime（HTTP 只读面 + 真实子进程）');
console.log('  node =', NODE_BIN, NODE_BIN === BUNDLED_NODE ? '(bundled, = production)' : '(FALLBACK: bundled runtime missing)');

const SERVICE = require(path.join(ROOT, SERVICE_FILE));

/* ══════════════════════════════════════════════════════════════════
   A · 装配形状（静态）
   ══════════════════════════════════════════════════════════════════ */
section('A · 装配形状：能力在 store 上，一个都不在 HTTP 上');

{
  const src = fs.readFileSync(path.join(ROOT, SERVICE_FILE), 'utf8');
  check('A1 P22-4 没有新增 store 装配点：Economy 的装配仍然只有 economyAssembly 一份',
    (src.match(/function economyAssembly/g) || []).length === 1);
  check('A2 P22-4 的六个写方法一个都没有进入装配层（装配层只创建/打开 store，不替它决定业务）',
    ['putBudgetPolicy', 'expirePolicy', 'expireDuePolicies', 'createQuote', 'expireQuote', 'expireDueQuotes']
      .every(name => src.indexOf(name) < 0),
    ['putBudgetPolicy', 'expirePolicy', 'expireDuePolicies', 'createQuote', 'expireQuote', 'expireDueQuotes']
      .filter(name => src.indexOf(name) >= 0));
  check('A3 生产 store 上真的有 P22-4 的全部方法与读面（能力存在，只是没有暴露到 HTTP）',
    ['putBudgetPolicy', 'expirePolicy', 'expireDuePolicies', 'getBudgetPolicy', 'listBudgetPolicies',
      'serializeBudgetPolicy', 'buildBudgetSnapshot', 'spendingWindows', 'evaluateBudgetFor',
      'serializeBudgetSnapshot', 'createQuote', 'expireQuote', 'expireDueQuotes', 'getQuote',
      'listQuotes', 'serializeQuote', 'evaluateQuote']
      .every(name => typeof SERVICE.economyStore[name] === 'function'));
  check('A4 装配层**没有**为每条路由复制一份逻辑（新路由只是把参数转给 store）',
    src.indexOf('/economy/policy') < 0 && src.indexOf('/economy/budget') < 0 &&
    src.indexOf('/economy/quote') < 0);
  check('A5 生产 store 的 schema 水位 ≥ 3，且与 store 模块自身声明一致',
    Number(SERVICE.economyStore.SCHEMA_VERSION) ===
    Number(require(path.join(ROOT, 'services', 'home-node', 'economy-store.js')).SCHEMA_VERSION) &&
    Number(SERVICE.economyStore.SCHEMA_VERSION) >= 3);
}

/* ══════════════════════════════════════════════════════════════════
   B · HTTP 面（真实 server、真实请求）
   ══════════════════════════════════════════════════════════════════ */
section('B · HTTP 面：五条新只读路由 + 每一种写动词都是 405');

async function httpGroup() {
  const dir = tmpDir('http');
  const app = SERVICE.buildHomeNode({ dataDir: dir, logger: () => { } });
  app.open();
  app.registry.putCharacter('cfg_a', { id: 'cfg_a', nickname: 'A' }, null);
  const port = await freePort();
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));

  const store = app.economyStore;
  const w = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' }).wallet;
  store.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 1000n, idempotencyKey: 'rt-seed'
  });
  /* 政策与报价通过**内部 API** 产生（HTTP 上没有这条路，那正是要证明的事）。 */
  const policy = store.putBudgetPolicy({
    ownerId: 'cfg_a', currency: 'IB_CREDIT', idempotencyKey: 'rt-policy',
    limits: {
      perTransactionMinor: 300, dailyMinor: 500, weeklyMinor: 1000,
      monthlyMinor: 2000, approvalThresholdMinor: 200
    }
  });
  assert.equal(policy.ok, true, 'seed policy must succeed: ' + J(policy.errors));
  const quote = store.createQuote({
    buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 100, productId: 'widget',
    expiresAt: Date.now() + 600000, idempotencyKey: 'rt-quote'
  });
  assert.equal(quote.ok, true, 'seed quote must succeed: ' + J(quote.errors));

  /* 一个"什么都没变"的指纹（读路由全部跑完之后必须逐字相同）。 */
  const fingerprint = () => J({
    revision: store.getRevision(),
    counts: store.health().counts,
    policies: store.listBudgetPolicies({ limit: 500 }).policies.map(p => store.serializeBudgetPolicy(p)),
    quotes: store.listQuotes({ limit: 500 }).quotes.map(q => store.serializeQuote(q)),
    wallet: store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}),
    topology: store.ledgerTopology(null)
  });
  const before = fingerprint();

  try {
    const health = await request(port, 'GET', '/economy/health');
    check('B1 GET /economy/health 报告 policies / quotes 的计数（观测面跟着能力长）',
      health.status === 200 && health.body.economy.counts.budgetPolicies === 1 &&
      health.body.economy.counts.activeBudgetPolicies === 1 &&
      health.body.economy.counts.quotes === 1 && health.body.economy.counts.openQuotes === 1,
      health.body.economy && health.body.economy.counts);
    check('B2 health() 在 HTTP 上也自述"评估不是许可"与"报价不锁钱"',
      health.body.economy.budgetEvaluationIsNotASpendPermit === true &&
      health.body.economy.quoteLocksNothing === true &&
      health.body.economy.budgetTimezone === 'UTC',
      health.body.economy);

    const policies = await request(port, 'GET', '/economy/policies?ownerId=cfg_a');
    check('B3 GET /economy/policies 列得出那条政策，金额是十进制字符串，且**不带** idempotencyKey',
      policies.status === 200 && policies.body.policies.length === 1 &&
      policies.body.policies[0].policyId === policy.result.policyId &&
      policies.body.policies[0].limits.dailyMinor === '500' &&
      !('idempotencyKey' in policies.body.policies[0]) &&
      policies.body.evaluationIsNotASpendPermit === true,
      policies.body);
    const byId = await request(port, 'GET', '/economy/policy?policyId=' + encodeURIComponent(policy.result.policyId));
    check('B4 GET /economy/policy 按 policyId 读单条；缺参数 400、不存在 404（"没有"与"不对"分开）',
      byId.status === 200 && byId.body.policy.policyId === policy.result.policyId &&
      (await request(port, 'GET', '/economy/policy')).status === 400 &&
      (await request(port, 'GET', '/economy/policy?ownerId=cfg_nobody')).status === 404);

    const budget = await request(port, 'GET',
      '/economy/budget?ownerId=cfg_a&currency=IB_CREDIT&amountMinor=100');
    check('B5 GET /economy/budget 做一次快照评估：ALLOW + 三个窗口 + available 全部可读',
      budget.status === 200 && budget.body.decision.outcome === 'ALLOW' &&
      budget.body.decision.reasonCode === 'BUDGET_ALLOWED' &&
      budget.body.snapshot.spentTodayMinor === '0' &&
      budget.body.snapshot.availableBalanceMinor === '1000' &&
      budget.body.snapshot.timezone === 'UTC',
      budget.body);
    check('B6 评估响应逐字写着"这不是许可、也没有锁钱"',
      budget.body.evaluatedOnly === true && budget.body.reserved === false &&
      budget.body.notASpendPermit.length > 0 &&
      budget.body.decision.snapshot.authority === 'none',
      budget.body);
    const approved = await request(port, 'GET',
      '/economy/budget?ownerId=cfg_a&currency=IB_CREDIT&amountMinor=250');
    const denied = await request(port, 'GET',
      '/economy/budget?ownerId=cfg_a&currency=IB_CREDIT&amountMinor=350');
    check('B7 三种结论各自是 200（DENY 是一个**结论**，不是一次 HTTP 失败）',
      approved.status === 200 && approved.body.decision.outcome === 'REQUIRE_APPROVAL' &&
      denied.status === 200 && denied.body.decision.outcome === 'DENY' &&
      denied.body.decision.reasonCode === 'AMOUNT_EXCEEDS_PER_TRANSACTION');
    check('B8 缺 ownerId / amountMinor 是 400（参数不全）；而**非法金额**是 200 + DENY（一个结论）',
      (await request(port, 'GET', '/economy/budget?ownerId=cfg_a')).status === 400 &&
      (await request(port, 'GET', '/economy/budget?amountMinor=100')).status === 400 &&
      /* 非法金额走的是**评估**这一层：它是对"能不能花这么多"的回答，
         因此是 200 + DENY，而不是一次 HTTP 失败。 */
      (await request(port, 'GET', '/economy/budget?ownerId=cfg_a&amountMinor=nope')).status === 200 &&
      (await request(port, 'GET', '/economy/budget?ownerId=cfg_a&amountMinor=nope')).body.decision.outcome === 'DENY' &&
      ['INVALID_AMOUNT', 'POLICY_INPUT_NOT_STRUCTURED'].indexOf(
        (await request(port, 'GET', '/economy/budget?ownerId=cfg_a&amountMinor=nope')).body.decision.reasonCode) >= 0);

    const quotes = await request(port, 'GET', '/economy/quotes?buyerId=cfg_a');
    check('B9 GET /economy/quotes 列得出那份报价，含 kind / settlementType，且声明 locksFunds:false',
      quotes.status === 200 && quotes.body.quotes.length === 1 &&
      quotes.body.quotes[0].quoteId === quote.result.quoteId &&
      quotes.body.quotes[0].kind === 'PURCHASE' &&
      quotes.body.quotes[0].settlementType === 'PURCHASE' &&
      quotes.body.locksFunds === false,
      quotes.body);
    const oneQuote = await request(port, 'GET', '/economy/quote?quoteId=' + encodeURIComponent(quote.result.quoteId));
    check('B10 GET /economy/quote 读单份；缺参数 400、不存在 404',
      oneQuote.status === 200 && oneQuote.body.quote.quoteId === quote.result.quoteId &&
      !('idempotencyKey' in oneQuote.body.quote) &&
      (await request(port, 'GET', '/economy/quote')).status === 400 &&
      (await request(port, 'GET', '/economy/quote?quoteId=econ_quote_nope')).status === 404);

    const evaluated = await request(port, 'GET',
      '/economy/quote?quoteId=' + encodeURIComponent(quote.result.quoteId) + '&evaluate=1');
    check('B11 GET /economy/quote?evaluate=1 带回四样东西，并且**没有**消费那份报价',
      evaluated.status === 200 && evaluated.body.decision.outcome === 'ALLOW' &&
      evaluated.body.walletSnapshot.availableBalanceMinor === '1000' &&
      evaluated.body.budgetSnapshot.spentTodayMinor === '0' &&
      evaluated.body.reserved === false && evaluated.body.consumed === false &&
      evaluated.body.evaluatedOnly === true,
      evaluated.body);
    check('B12 evaluate=1 之后报价仍然是 OPEN（"评估报价"没有偷偷变成"接受报价"）',
      store.getQuote({ quoteId: quote.result.quoteId }).quote.state === 'OPEN');

    /* ── 每一条读路由都跑完之后，世界必须逐字未变 ─────────────────── */
    check('B13 十条只读请求（含两次评估）之后，政策 / 报价 / 钱包 / 账本 / revision **逐字未变**',
      fingerprint() === before,
      { before: before.slice(0, 300), after: fingerprint().slice(0, 300) });

    /* ── 写动词：一条都不存在 ─────────────────────────────────────── */
    const writePaths = [
      '/economy/policy', '/economy/policies', '/economy/budget',
      '/economy/quote', '/economy/quotes',
      '/economy/approve', '/economy/approval', '/economy/evaluate',
      '/economy/inventory', '/economy/store'
    ];
    const results = [];
    for (const p of writePaths) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const r = await request(port, method, p, { anything: true });
        results.push({ path: p, method: method, status: r.status, code: r.body && r.body.error });
      }
    }
    check('B14 十条路径 × 三种写动词 = 30 次写尝试：**全部** 405 economy-is-read-only',
      results.length === 30 && results.every(r => r.status === 405 && r.code === 'economy-is-read-only'),
      results.filter(r => r.status !== 405 || r.code !== 'economy-is-read-only').slice(0, 6));
    check('B15 这些写尝试之后政策 / 报价 / 钱包 / 账本 / revision **一个字节都没变**',
      fingerprint() === before);
    check('B16 未登记的 GET 路径回 404 unknown-economy-path（"不存在"与"不允许"是两个回答）',
      (await request(port, 'GET', '/economy/nope')).status === 404 &&
      (await request(port, 'GET', '/economy/nope')).body.error === 'unknown-economy-path');

    /* ── /security 的自述 ─────────────────────────────────────────── */
    const security = await request(port, 'GET', '/security');
    /* /security 把 economyPolicy 放在**顶层**（与 memoryPolicy 等同级），
       不是嵌在一个叫 security 的对象里。 */
    const ep = security.body && security.body.economyPolicy;
    check('B17 /security 的 economyPolicy 把 P22-4 的"没有"写成可断言字段',
      security.status === 200 && ep && ep.httpVerbs.join(',') === 'GET' &&
      ep.writesExposed.length === 0 && ep.reservationWritesExposed.length === 0 &&
      ep.budgetWritesExposed.length === 0 && ep.quoteWritesExposed.length === 0 &&
      ep.mintingExposed === false && ep.budgetEvaluationIsASnapshotOnly === true &&
      ep.budgetEvaluationReservesFunds === false && ep.quoteLocksFunds === false &&
      ep.budgetTimezone === 'UTC',
      ep);
    check('B18 /security 把新的只读路径写进 desktopPaths，并把 approve / inventory / store / exchange 列为 unreachable',
      !!ep && ['/economy/policies', '/economy/policy', '/economy/budget', '/economy/quotes', '/economy/quote']
        .every(p => ep.desktopPaths.indexOf(p) >= 0) &&
      ['/economy/approve', '/economy/inventory', '/economy/store', '/economy/exchange']
        .every(p => ep.unreachable.indexOf(p) >= 0),
      ep && ep.unreachable);
    check('B19 写路径仍然列在 unreachable 里（/economy/reserve · commit · release · expire · fail · sweep）',
      !!ep && ['/economy/reserve', '/economy/commit', '/economy/release', '/economy/expire', '/economy/fail', '/economy/sweep']
        .every(p => ep.unreachable.indexOf(p) >= 0));
    check('B20 /security 的 doesNotExpose 仍然写着 payments，而且一次都没被改动',
      security.body.doesNotExpose.indexOf('payments') >= 0);

    /* ── 授权面：新路由不给 loopback 豁免 ─────────────────────────── */
    /* 桌面 token 的头部名与装配参数都与 P22-3 的同一组断言逐字一致
       （x-ib-home-token / token）—— 换一个名字会让这条断言在测另一个东西。 */
    const token = 'rt-desktop-token';
    const dir2 = tmpDir('http-auth');
    const app2 = SERVICE.buildHomeNode({ dataDir: dir2, logger: () => { }, token: token });
    app2.open();
    const port2 = await freePort();
    await new Promise(r => app2.server.listen(port2, '127.0.0.1', r));
    try {
      check('B21 配了桌面 token 时，新的只读路由不带 token 一律 401',
        (await request(port2, 'GET', '/economy/policies')).status === 401 &&
        (await request(port2, 'GET', '/economy/policy?ownerId=cfg_a')).status === 401 &&
        (await request(port2, 'GET', '/economy/budget?ownerId=cfg_a&amountMinor=1')).status === 401 &&
        (await request(port2, 'GET', '/economy/quotes')).status === 401 &&
        (await request(port2, 'GET', '/economy/quote?quoteId=econ_quote_x')).status === 401);
      check('B22 带上正确 token 才 200（/economy/* 仍然**没有** loopback 豁免）',
        (await request(port2, 'GET', '/economy/policies', null, { 'x-ib-home-token': token })).status === 200 &&
        (await request(port2, 'GET', '/economy/quotes', null, { 'x-ib-home-token': token })).status === 200);
    } finally {
      await new Promise(r => app2.server.close(r));
      app2.close();
    }
  } finally {
    await new Promise(r => app.server.close(r));
    app.close();
  }
}

/* ══════════════════════════════════════════════════════════════════
   C · 真实生产进程：新路由在生产启动路径上真的被接线
   ══════════════════════════════════════════════════════════════════ */
section('C · 真实子进程：生产启动路径上真的接线（而不是 501 / 404 / 空数组）');

async function productionGroup() {
  const dir = tmpDir('prod');
  const prod = await startProduction(dir);
  try {
    const up = await waitListening(prod, 25000);
    check('C1 生产进程在私有端口 + 私有数据目录上起来了', up === true, prod.output());

    const health = await request(prod.port, 'GET', '/economy/health');
    check('C2 生产进程的 health 报告 schema ≥ 3，并把 P22-4 的两面都自述出来',
      health.status === 200 && Number(health.body.economy.schemaVersion) >= 3 &&
      health.body.economy.quoteCanonical === 'sqlite-quotes' &&
      health.body.economy.budgetCanonical.indexOf('sqlite-budget-policies') >= 0 &&
      J(health.body.economy.budgetSpendingTypes) === J(C.BUDGET_SPENDING_TYPES),
      health.body.economy);

    /* 空库上：三条读路由都必须 200（不是 501、不是 404）。 */
    check('C3 空库上 GET /economy/policies → 200 且为空（不是 501、不是 404）',
      (await request(prod.port, 'GET', '/economy/policies')).status === 200 &&
      (await request(prod.port, 'GET', '/economy/policies')).body.policies.length === 0);
    check('C4 空库上 GET /economy/quotes → 200 且为空',
      (await request(prod.port, 'GET', '/economy/quotes')).status === 200 &&
      (await request(prod.port, 'GET', '/economy/quotes')).body.quotes.length === 0);
    const noWallet = await request(prod.port, 'GET', '/economy/budget?ownerId=nobody&amountMinor=100');
    check('C5 空库上 GET /economy/budget → 200 + DENY（"这个 owner 没有钱包"是一个**业务**结论，不是 500）',
      /* 刻意不写死具体 reasonCode：这一层的协议是"三态决策 + 稳定
         reasonCode"，而"没有钱包"该用哪一个代码属于实现细节；被钉住的
         是**形状**：200、DENY、有 reasonCode、且**不是** systemFailure
         （那是系统故障的位置，而这是一个正常的业务回答）。 */
      noWallet.status === 200 && noWallet.body.decision.outcome === 'DENY' &&
      typeof noWallet.body.decision.reasonCode === 'string' &&
      noWallet.body.decision.reasonCode.length > 0 &&
      noWallet.body.decision.systemFailure !== true &&
      noWallet.body.reserved === false,
      noWallet.body.decision);
    check('C6 生产进程上 POST 到每一条新路径仍然是 405（写能力在路由表上不存在）',
      (await request(prod.port, 'POST', '/economy/policy', { x: 1 })).status === 405 &&
      (await request(prod.port, 'POST', '/economy/budget', { x: 1 })).status === 405 &&
      (await request(prod.port, 'POST', '/economy/quote', { x: 1 })).status === 405 &&
      (await request(prod.port, 'PUT', '/economy/quotes', { x: 1 })).status === 405);

    await stopProduction(prod);
    check('C7 生产进程干净退出（合作停止面之后进程真的结束了）', !!prod.exited, prod.exited);
    check('C8 停机日志里有 economy-closed，且拆除梯子跑完五步',
      /economy-closed/.test(prod.output()) &&
      /"steps":\s*\[\s*"entering",\s*"stopWork",\s*"stopTimers",\s*"closeStores",\s*"report"\s*\]/.test(prod.output()) &&
      /"errors":\s*null/.test(prod.output()),
      prod.output().slice(-600));
  } finally {
    await stopProduction(prod);
  }

  /* ── D · 直接打开同一个库：政策与报价跨进程持久 ─────────────────── */
  const direct = SERVICE.economyAssembly({ dataDir: dir, logger: () => { } }).economyStore;
  direct.open();
  const wUser = direct.openWallet({ owner: { type: 'user', id: 'user' }, currency: 'IB_CREDIT' });
  check('D1 直接打开同一个库（生产进程已停机，不存在抢库）', wUser.ok === true, wUser.errors || '');
  direct.mintForSystem({
    systemInitiated: true, walletId: wUser.wallet.walletId, currency: 'IB_CREDIT',
    amountMinor: 1000n, idempotencyKey: 'prod-mint'
  });
  const policy = direct.putBudgetPolicy({
    ownerId: 'user', currency: 'IB_CREDIT', idempotencyKey: 'prod-policy',
    limits: { perTransactionMinor: 300, dailyMinor: 500, weeklyMinor: 1000, monthlyMinor: 2000, approvalThresholdMinor: 200 }
  });
  const quote = direct.createQuote({
    buyerId: 'user', currency: 'IB_CREDIT', amountMinor: 100, productId: 'widget',
    expiresAt: Date.now() + 600000, idempotencyKey: 'prod-quote'
  });
  check('D2 在同一个库上建政策与报价都成功', policy.ok === true && quote.ok === true,
    (policy.errors || []).concat(quote.errors || []));
  const revisionBefore = direct.getRevision();
  direct.close();

  /* ── E · 重启生产进程：新路由读到写进去的东西 ───────────────────── */
  const prod2 = await startProduction(dir);
  try {
    const up = await waitListening(prod2, 25000);
    check('E1 同一数据目录再起一个生产进程', up === true, prod2.output());
    const policies = await request(prod2.port, 'GET', '/economy/policies?ownerId=user');
    const quotes = await request(prod2.port, 'GET', '/economy/quotes?buyerId=user');
    check('E2 重启之后 GET /economy/policies 逐字读回那条政策（含五个限额）',
      policies.status === 200 && policies.body.policies.length === 1 &&
      policies.body.policies[0].policyId === policy.result.policyId &&
      policies.body.policies[0].limits.perTransactionMinor === '300' &&
      policies.body.policies[0].limits.approvalThresholdMinor === '200',
      policies.body);
    check('E3 重启之后 GET /economy/quotes 逐字读回那份报价（含 kind / settlementType / expiresAt）',
      quotes.status === 200 && quotes.body.quotes.length === 1 &&
      quotes.body.quotes[0].quoteId === quote.result.quoteId &&
      quotes.body.quotes[0].amountMinor === '100' &&
      quotes.body.quotes[0].expiresAt === quote.result.expiresAt &&
      quotes.body.quotes[0].state === 'OPEN',
      quotes.body);
    const budget = await request(prod2.port, 'GET', '/economy/budget?ownerId=user&amountMinor=100');
    check('E4 重启之后预算评估给出与写入时相同的结论（窗口从 committed 事实重算，不是存下来的）',
      budget.status === 200 && budget.body.decision.outcome === 'ALLOW' &&
      budget.body.snapshot.spentTodayMinor === '0' &&
      budget.body.snapshot.availableBalanceMinor === '1000',
      budget.body);
    const health = await request(prod2.port, 'GET', '/economy/health');
    check('E5 重启**不**消耗 revision（一致性正常 ⇒ 什么都不写）',
      Number(health.body.economy.revision) === revisionBefore,
      { revision: health.body.economy.revision, before: revisionBefore });
    const second = await request(prod2.port, 'GET', '/economy/budget?ownerId=user&amountMinor=100');
    check('E6 重启之后同一份预算评估的结论逐字相同（确定性在进程边界上成立）',
      /* 比的是**结论性**字段：outcome / reasonCode / priority / 三个窗口。
         刻意不比整个对象 —— 它带着 evaluatedAt（那是"现在"），而
         "同一个输入得到同一个结论"说的是结论，不是那次调用的时刻。 */
      second.status === 200 &&
      second.body.decision.outcome === budget.body.decision.outcome &&
      second.body.decision.reasonCode === budget.body.decision.reasonCode &&
      second.body.decision.priority === budget.body.decision.priority &&
      second.body.snapshot.spentTodayMinor === budget.body.snapshot.spentTodayMinor &&
      second.body.snapshot.availableBalanceMinor === budget.body.snapshot.availableBalanceMinor,
      { first: budget.body.decision.reasonCode, second: second.body.decision.reasonCode });
    const third = await request(prod2.port, 'GET',
      '/economy/budget?ownerId=user&amountMinor=100&now=' + (Date.now() + 86400000));
    check('E6b 同一个库上换一个 now：窗口边界跟着变，而结论仍然确定（时间是一个**输入**，不是环境）',
      third.status === 200 &&
      third.body.snapshot.windows.dayStartsAt !== budget.body.snapshot.windows.dayStartsAt &&
      third.body.decision.outcome === 'ALLOW',
      { day: budget.body.snapshot.windows.dayStartsAt, other: third.body.snapshot.windows.dayStartsAt });
    await stopProduction(prod2);
    check('E7 第二个生产进程也干净退出', !!prod2.exited, prod2.exited);
  } finally {
    await stopProduction(prod2);
  }
}

/* ══════════════════════════════════════════════════════════════════
   F · 装配缺口必须给 501（不是 404、不是 200 + 空数组）
   ══════════════════════════════════════════════════════════════════ */
section('F · 装配缺口：没接线时给 501，而不是"这个路径不存在"');

async function assemblyGapGroup() {
  const dir = tmpDir('gap');
  const app = SERVICE.buildHomeNode({ dataDir: dir, logger: () => { } });
  app.open();
  const port = await freePort();
  /* 一个**不传** economyStore 的 http 层：手动造出来。 */
  const createHttp = require(path.join(ROOT, 'services', 'home-node', 'http.js'));
  const bare = createHttp({ logger: () => { }, registry: app.registry });
  await new Promise(r => bare.server.listen(port, '127.0.0.1', r));
  try {
    const paths = ['/economy/policies', '/economy/policy?ownerId=x', '/economy/budget?ownerId=x&amountMinor=1',
      '/economy/quotes', '/economy/quote?quoteId=econ_quote_x'];
    const results = [];
    for (const p of paths) results.push(await request(port, 'GET', p));
    check('F1 没接线时五条新路由回 501 economy-not-assembled（不是 404、不是 200 + 空数组）',
      results.every(r => r.status === 501 && r.body.error === 'economy-not-assembled'),
      results.map(r => r.status + ':' + (r.body && r.body.error)));
    check('F2 而写到这些路径上仍然是 405（"没接线"与"不允许写"是两个不同的回答）',
      (await request(port, 'POST', '/economy/policy', {})).status === 405);
  } finally {
    await new Promise(r => bare.server.close(r));
    await new Promise(r => app.server.close(r));
    app.close();
  }
}

(async () => {
  await httpGroup();
  await productionGroup();
  await assemblyGapGroup();

  console.log('\n' + '═'.repeat(64));
  if (failures === 0) {
    console.log('P22-4 runtime: 全部通过 ✔');
    process.exitCode = 0;
  } else {
    console.error('P22-4 runtime: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  }
})();
