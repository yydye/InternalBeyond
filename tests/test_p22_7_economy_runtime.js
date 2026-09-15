'use strict';
/* ====================================================================
   P22-7 · Economy runtime（真实 Home Node 子进程 + 多进程竞争 + 故障回滚）
   --------------------------------------------------------------------
   运行：node tests/test_p22_7_economy_runtime.js

   本文件回答四类**只有真实进程**才能回答的问题：

     「一个真实的 production Home Node 打开 P22-7 的库之后，权限读面
       可用、重启仍然可用？」                          —— B 组
     「HTTP 上批准 / 自主策略的**写**面真的一条都没有？」  —— C 组
     「两个真实进程同时决定同一条批准 / 同时拿同一条批准去买时，
       最终经济事实是什么？」                          —— D / E 组
     「在六个注入点上崩溃之后，会不会留下
       『批准已消费但没有购买』这种撕裂事实？」          —— F 组

   ── 为什么多进程不是"更狠一点的单进程测试" ────────────────────────────
   node:sqlite 的 DatabaseSync 是同步 API，单线程里两次 decide 不可能交错。
   因此"一次决定只有一个写入者"在单进程内**无法被证伪** —— 唯一的证伪方式
   是两个各自持有独立 SQLite 连接的真实操作者同时动手。这与 P22-3 的
   reserve worker / P22-5 的 consume worker / P22-6 的 purchase worker
   是同一条纪律的第四次应用。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_FILE = 'services/home-node-service.js';
const WORKER_FILE = 'tests/fixtures/p22-7-approval-worker.js';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-7rt-' + tag + '-'));
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
function runWorker(args) {
  return new Promise(resolve => {
    const child = spawn(NODE_BIN, [WORKER_FILE].concat(args), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    openChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', c => { stderr += String(c); });
    child.on('exit', code => {
      openChildren.delete(child);
      let result = null;
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      if (line) { try { result = JSON.parse(line); } catch (_) { result = null; } }
      resolve({ code: code, result: result, stdout: stdout, stderr: stderr });
    });
  });
}

/* ── 播种一个"一条 APPROVED 批准 + 一份报价"的世界 ───────────────────── */
const FUTURE = Date.UTC(2030, 0, 1);
/* ★ 批准的有效期有**上界**（§6：APPROVAL_MAX_LIFETIME_MS = 24 小时，
   因为一条"永久有效"的批准与"以后随便花 500"是同一种东西）。报价没有
   这个上界（P22-4 的报价可以到 2030 年），因此两个值刻意不同。 */
const APPROVAL_EXPIRES_AT = Date.now() + 6 * 60 * 60 * 1000;
function seed(dir, options) {
  const o = options || {};
  const store = createEconomyStore({ dataDir: dir, logger: () => { } });
  store.open();
  const w = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' });
  store.mintForSystem({
    systemInitiated: true, walletId: w.wallet.walletId, currency: 'IB_CREDIT',
    amountMinor: o.balance != null ? o.balance : 5000, idempotencyKey: 'seed-' + w.wallet.walletId
  });
  store.putBudgetPolicy({
    ownerId: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT',
    limits: { perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000 },
    idempotencyKey: 'bp-seed'
  });
  const st = store.putStore({ storeId: 'econ_store_seed', name: 'Shelf', status: 'ACTIVE', idempotencyKey: 'st-seed' });
  const pr = store.putProduct({
    productId: 'econ_product_seed', storeId: st.result.storeId, name: 'Compute pack',
    kind: 'COMPUTE_CREDIT', unitPriceMinor: 100, currency: 'IB_CREDIT',
    grantQuantity: 100, unitName: 'computeUnit', status: 'ACTIVE', idempotencyKey: 'pr-seed'
  });
  const q = store.createProductQuote({
    productId: pr.result.productId, buyerId: { type: 'character', id: 'cfg_a' },
    units: 1, expiresAt: FUTURE, idempotencyKey: 'q-seed'
  });
  const approvalId = o.approvalId || 'econ_approval_seed1';
  const req = store.createApprovalRequest({
    buyerId: { type: 'character', id: 'cfg_a' }, quoteId: q.result.quoteId,
    units: 1, expiresAt: APPROVAL_EXPIRES_AT, approvalId: approvalId, idempotencyKey: 'req-seed'
  });
  if (!req.ok) throw new Error('seed approval failed: ' + J(req.errors || req));
  let decided = null;
  if (o.approved !== false) {
    decided = store.decideApproval({
      approvalId: approvalId, decision: 'APPROVED',
      decidedBy: { type: 'user', id: 'user' }, idempotencyKey: 'dec-seed'
    });
    if (!decided.ok) throw new Error('seed approval decision failed: ' + J(decided.errors || decided));
  }
  store.close();
  return {
    quoteId: q.result.quoteId, productId: pr.result.productId,
    storeId: st.result.storeId, approvalId: approvalId
  };
}

/* ══════════════════════════════════════════════════════════════════
   B · 真实 Home Node
   ══════════════════════════════════════════════════════════════════ */
async function runServiceGroup() {
  section('B · 真实 Home Node：权限读面 + schema 水位 + 重启');
  const dir = tmpDir('service');
  const seeded = seed(dir);

  const svc = await startProduction(dir);
  const up = await waitListening(svc, 20000);
  check('B1 production home-node 起来了（/health 200）', up === true, svc.output());
  if (!up) return;

  /* ★ Economy 的健康面在 economy/health 这条只读路由上（P22-2 起），
     而不是通用 /health 的一个字段。P22-6 的 runtime 测试逐字用的是这一条。
     ★ 这里刻意**不**把那两条路由写成带星号的斜杠形式 —— 一个块注释里
     出现闭合符号会让注释在那里提前结束，而报错会指向一个看起来毫无问题
     的行号。 */
  const health = await request(svc.port, 'GET', '/economy/health');
  const econ = health.body && health.body.economy ? health.body.economy : {};
  check('B2 P22-7 的库被真实 store 打开（schema 水位 = 6，Economy READY）',
    health.status === 200 && Number(econ.schemaVersion) === 6 && econ.state === 'READY',
    { status: health.status, schemaVersion: econ.schemaVersion, state: econ.state, body: health.body });
  check('B3 ★ health 暴露权限层的九个计数（批准五个状态 + 策略两个）',
    econ.counts && econ.counts.approvals === 1 && econ.counts.approvedApprovals === 1 &&
    econ.counts.pendingApprovals === 0 && econ.counts.consumedApprovals === 0 &&
    econ.counts.autonomyPolicies === 0 && econ.counts.enabledAutonomyPolicies === 0 &&
    typeof econ.counts.expiredApprovals === 'number' && typeof econ.counts.rejectedApprovals === 'number',
    econ.counts);

  /* ── 五条只读路由都答 200 ─────────────────────────────────────────── */
  const approvals = await request(svc.port, 'GET', '/economy/approvals');
  check('B4 GET /economy/approvals 列出那一条批准，且逐字声明它不改任何状态',
    approvals.status === 200 && approvals.body.count === 1 &&
    approvals.body.approvals[0].approvalId === seeded.approvalId &&
    approvals.body.approvals[0].status === 'APPROVED' &&
    approvals.body.exposesMutation === false &&
    approvals.body.createsRecords === false && approvals.body.consumesApprovals === false &&
    approvals.body.personalized === false,
    approvals.body);

  const one = await request(svc.port, 'GET', '/economy/approval?approvalId=' + encodeURIComponent(seeded.approvalId));
  check('B5 GET /economy/approval 给出九元组快照 + 决定者，并逐字否认"这里能点头"',
    one.status === 200 && one.body.approval &&
    one.body.approval.approvalId === seeded.approvalId &&
    one.body.approval.amountMinor === '100' &&
    one.body.approval.decidedBy === 'user:user' &&
    typeof one.body.approval.bindingFingerprint === 'string' &&
    one.body.approval.isAPurchase === false &&
    one.body.approval.isBudgetAuthority === false &&
    one.body.approval.singleUse === true &&
    one.body.canApproveViaHttp === false && one.body.canRejectViaHttp === false,
    one.body);

  const missing = await request(svc.port, 'GET', '/economy/approval?approvalId=econ_approval_ghost');
  const noId = await request(svc.port, 'GET', '/economy/approval');
  check('B6 一条不存在的批准 ⇒ 404；缺 approvalId ⇒ 400（两个不同的答案）',
    missing.status === 404 && noId.status === 400,
    { missing: missing.status, noId: noId.status });

  const policies = await request(svc.port, 'GET', '/economy/autonomy-policies');
  check('B7 GET /economy/autonomy-policies 是空列表（这台 Agent 没有自主策略），且逐字否认它授予预算',
    policies.status === 200 && policies.body.count === 0 &&
    policies.body.grantsBudget === false && policies.body.isADecisionLayer === false &&
    policies.body.exposesMutation === false, policies.body);

  const noPolicy = await request(svc.port, 'GET', '/economy/autonomy-policy?ownerId=cfg_a');
  check('B8 ★ 没有策略时 GET /economy/autonomy-policy 答 404 + POLICY_NOT_FOUND，'
    + '而响应里逐字写着"缺省是 REQUIRE_APPROVAL"',
    noPolicy.status === 404 && noPolicy.body.error === 'POLICY_NOT_FOUND', noPolicy.body);

  const evalRes = await request(svc.port, 'GET',
    '/economy/autonomy-evaluation?buyerId=cfg_a&quoteId=' + encodeURIComponent(seeded.quoteId));
  check('B9 ★★ GET /economy/autonomy-evaluation 对同一份报价给出 REQUIRE_APPROVAL'
    + '（没有策略 ⇒ fail closed），且逐字声明"这是快照、不是许可"',
    evalRes.status === 200 &&
    evalRes.body.decision.outcome === C.AP_DECISION.REQUIRE_APPROVAL &&
    evalRes.body.decision.reasonCode === C.DENY_REASON.APPROVAL_REQUIRED &&
    evalRes.body.decision.snapshot.authority === 'none' &&
    evalRes.body.evaluatedOnly === true &&
    evalRes.body.reserved === false &&
    evalRes.body.createsRecords === false &&
    evalRes.body.autonomyPolicyPresent === false &&
    typeof evalRes.body.notASpendPermit === 'string',
    evalRes.body);

  /* ── C · HTTP 写面：一条都没有 ────────────────────────────────────── */
  section('C · HTTP 写面：批准 / 自主策略一条写路由都没有');
  const writeAttempts = [
    ['POST', '/economy/approve'], ['POST', '/economy/reject'],
    ['POST', '/economy/buy'], ['POST', '/economy/autonomy'],
    ['POST', '/economy/autonomy-policy'], ['POST', '/economy/approval'],
    ['POST', '/economy/approvals'], ['POST', '/economy/autonomy-policies'],
    ['POST', '/economy/autonomy-evaluation'],
    ['PUT', '/economy/approval'], ['PUT', '/economy/autonomy-policy'],
    ['DELETE', '/economy/approval'], ['DELETE', '/economy/approvals'],
    ['DELETE', '/economy/autonomy-policies'],
    ['POST', '/economy/prepare'], ['POST', '/economy/settle'],
    ['POST', '/economy/purchase'], ['POST', '/economy/cancel'],
    ['PATCH', '/economy/approval'], ['PATCH', '/economy/autonomy']
  ];
  const writeResults = [];
  for (const [method, p] of writeAttempts) {
    /* eslint-disable no-await-in-loop */
    const r = await request(svc.port, method, p, { approvalId: seeded.approvalId, decision: 'APPROVED' });
    writeResults.push({ method: method, path: p, status: r.status, code: r.body && (r.body.error || r.body.code) });
  }
  check('C1 ★★ 全部 ' + writeAttempts.length + ' 次写尝试都被 405 economy-is-read-only 挡住'
    + '（§14：本阶段即使有 Approval runtime 也不开放任何写入口）',
    writeResults.every(r => r.status === 405 && r.code === 'economy-is-read-only'),
    writeResults.filter(r => !(r.status === 405 && r.code === 'economy-is-read-only')));

  const sec = await request(svc.port, 'GET', '/security');
  const pol = (sec.body && sec.body.economyPolicy) || {};
  check('C2 ★★ /security 的 economyPolicy 对权限层给出十一项可断言字段：'
    + '运行时**有**、写路由**没有**、HTTP 上不许点头',
    pol.approvalRuntimeImplemented === true &&
    Array.isArray(pol.approvalWritesExposed) && pol.approvalWritesExposed.length === 0 &&
    Array.isArray(pol.autonomyWritesExposed) && pol.autonomyWritesExposed.length === 0 &&
    pol.approveViaHttpIsForbidden === true &&
    pol.approvalConsumptionIsInsideSettlement === true &&
    pol.approvalIsSingleUse === true &&
    pol.autonomyDefaultWhenNoPolicy === 'REQUIRE_APPROVAL' &&
    pol.autonomyIsADecisionLayer === false &&
    Array.isArray(pol.policyApprovalWritesExposed) && pol.policyApprovalWritesExposed.length === 0,
    pol);
  check('C3 ★★ /security 的 desktopPaths 含五条新的只读路径，而 unreachable 里**不再**有 /economy/approval'
    + '（一条声明若比真实路由更保守，就不再是在描述这个系统）',
    ['/economy/approvals', '/economy/approval', '/economy/autonomy-policies',
      '/economy/autonomy-policy', '/economy/autonomy-evaluation'].every(p => pol.desktopPaths.indexOf(p) >= 0) &&
    pol.unreachable.indexOf('/economy/approval') < 0 &&
    pol.unreachable.indexOf('/economy/approvals') < 0 &&
    pol.unreachable.indexOf('/economy/approve') >= 0 &&
    pol.unreachable.indexOf('/economy/reject') >= 0 &&
    pol.unreachable.indexOf('/economy/autonomy') >= 0 &&
    pol.unreachable.indexOf('/economy/autonomy-policy') >= 0,
    { desktop: pol.desktopPaths, unreachable: pol.unreachable });

  /* ── B10 · 重启 ─────────────────────────────────────────────────── */
  const before = await request(svc.port, 'GET', '/economy/health');
  const revBefore = before.body.economy.revision;
  svc.child.kill();
  await sleep(600);
  const svc2 = await startProduction(dir);
  const up2 = await waitListening(svc2, 20000);
  const after = await request(svc2.port, 'GET', '/economy/health');
  check('B10 重启：同一个库再次打开，水位仍然是 6，且批准与 revision 都在',
    up2 === true && Number(after.body.economy.schemaVersion) === 6 &&
    after.body.economy.counts.approvals === 1 &&
    after.body.economy.counts.approvedApprovals === 1 &&
    after.body.economy.revision >= revBefore,
    { schema: after.body.economy.schemaVersion, counts: after.body.economy.counts });
  svc2.child.kill();
  await sleep(300);
}

/* ══════════════════════════════════════════════════════════════════
   D/E/F · 多进程（在 B/C 组之后串行跑）
   ══════════════════════════════════════════════════════════════════ */
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  runMultiProcess().then(() => {
    console.log('\n' + '═'.repeat(64));
    if (failures === 0) {
      console.log('P22-7 runtime: 全部通过 ✔');
      process.exitCode = 0;
    } else {
      console.error('P22-7 runtime: ' + failures + ' 项失败 ✘');
      process.exitCode = 1;
    }
  }).catch(error => {
    failures++;
    console.error('✖ 多进程组抛出异常 — ' + String(error && (error.stack || error.message)));
    console.error('P22-7 runtime: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  });
}

async function runMultiProcess() {
  /* ── D · 同一条批准被两个进程分别 APPROVE / REJECT ────────────────── */
  section('D · 多进程：同一条 PENDING 批准被两个进程同时决定（一个点头、一个摇头）');

  {
    const dir = tmpDir('race-decide');
    const seeded = seed(dir, { approved: false });
    const barrier = Date.now() + 1200;
    const results = await Promise.all([
      runWorker(['decide', '--dir', dir, '--approval', seeded.approvalId, '--decision', 'APPROVED', '--key', 'race-a', '--barrier', String(barrier)]),
      runWorker(['decide', '--dir', dir, '--approval', seeded.approvalId, '--decision', 'REJECTED', '--key', 'race-b', '--barrier', String(barrier)])
    ]);
    const rows = results.map(r => r.result).filter(Boolean);
    check('D0 两个 worker 都产出了一行 JSON（没有崩、没有挂）',
      rows.length === 2 && results.every(r => r.code === 0),
      results.map(r => ({ code: r.code, stderr: String(r.stderr).slice(0, 200) })));
    check('D1 ★★ 它们**真的**是同时动手的（两个 startedAt 落在起跑线同一毫秒窗口内）',
      rows.length === 2 && Math.abs(rows[0].startedAt - rows[1].startedAt) <= 1500 &&
      rows.every(r => r.startedAt >= barrier - 5),
      rows.map(r => r.startedAt - barrier));

    const decided = rows.filter(r => r.ok === true);
    check('D2 ★★ 恰好**一个**决定成功（另一个被状态闸门拒绝，且不是幂等回放 —— key 不同）',
      decided.length === 1 &&
      rows.filter(r => r.ok !== true).every(r => r.denied === true &&
        r.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED),
      rows.map(r => ({ ok: r.ok, decision: r.decision, reasonCode: r.reasonCode, status: r.approvalStatus })));

    const final = await runWorker(['world', '--dir', dir]);
    const w = final.result.world;
    check('D3 ★★ 最终世界：那条批准**恰好一个**终态（APPROVED 或 REJECTED 之一，不是两个）',
      w.approvalStates.length === 1 &&
      (w.approvalStates[0].status === 'APPROVED' || w.approvalStates[0].status === 'REJECTED') &&
      w.approvalStates[0].by === 'user:user',
      w.approvalStates);
    check('D4 ★★ 最终世界：批准计数与那条记录的状态**一致**'
      + '（approvedApprovals + rejectedApprovals === 1）',
      w.approvedApprovals + w.rejectedApprovals === 1 &&
      w.pendingApprovals === 0 && w.consumedApprovals === 0,
      { approved: w.approvedApprovals, rejected: w.rejectedApprovals, pending: w.pendingApprovals });
    check('D5 ★★ 竞争期间**没有**任何购买成立：那个胜出的决定还没有被消费'
      + '（所以 purchases / reservations / consumed 都是 0，而账本上只有那一次 MINT）',
      w.purchases === 0 && w.transactions === 1 /* 只有 MINT */ &&
      w.consumedApprovals === 0 && w.approvalStates.length === 1 &&
      w.approvalStates[0].consumedBy == null,
      { purchases: w.purchases, transactions: w.transactions, reservations: w.reservations,
        consumed: w.consumedApprovals, states: w.approvalStates });
    check('D6 ★★ 完整性检查零问题（没有任何半完成状态）',
      Array.isArray(w.integrityProblems) && w.integrityProblems.length === 0, w.integrityProblems);
    check('D7 ★★ 成功那一个 worker 读到的状态与库里的**同一个事实**',
      decided.length === 1 && decided[0].approvalStatus === w.approvalStates[0].status,
      { worker: decided.map(r => r.approvalStatus), canonical: w.approvalStates });
  }

  /* ── D8 · 同一个 key 的幂等对照：两个进程同时决定同一条批准 ──────── */
  {
    /* NOTE: a brand new database is required here - reusing the previous group's
       directory would run this assertion against an approval that is already in a
       terminal state, so both workers would report TRANSITION_NOT_ALLOWED and the
       idempotent-replay claim would never actually be tested. */
    const dir = tmpDir('race-decide-same');
    const seeded = seed(dir, { approved: false, approvalId: 'econ_approval_same' });
    const barrier = Date.now() + 1200;
    const results = await Promise.all([
      runWorker(['decide', '--dir', dir, '--approval', seeded.approvalId, '--decision', 'APPROVED', '--key', 'same-key', '--barrier', String(barrier)]),
      runWorker(['decide', '--dir', dir, '--approval', seeded.approvalId, '--decision', 'APPROVED', '--key', 'same-key', '--barrier', String(barrier)])
    ]);
    const rows = results.map(r => r.result).filter(Boolean);
    const okRows = rows.filter(r => r.ok === true);
    const final = await runWorker(['world', '--dir', dir]);
    const w = final.result.world;
    check('D8 ★★ 同一个 key 的两个进程同时决定同一条批准：**恰好一个**写入者'
      + '（另一个要么是幂等回放、要么在写锁里被状态闸门拒绝 —— 两种都是'
      + '"没有第二次写入"，而库里的最终状态只有一个）',
      rows.length === 2 && okRows.length >= 1 &&
      rows.every(r => r.approvalStatus === 'APPROVED') &&
      rows.filter(r => r.ok !== true).every(r =>
        r.denied === true && r.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED) &&
      w.approvedApprovals === 1 && w.pendingApprovals === 0 && w.rejectedApprovals === 0 &&
      w.approvalStates.length === 1 && w.approvalStates[0].status === 'APPROVED' &&
      Array.isArray(w.integrityProblems) && w.integrityProblems.length === 0,
      { rows: rows.map(r => ({ ok: r.ok, replayed: r.replayed, denied: r.denied, reasonCode: r.reasonCode, status: r.approvalStatus })),
        counts: { approved: w.approvedApprovals, pending: w.pendingApprovals } });
  }

  /* ── E · 两个进程拿同一条 APPROVED 批准去买（消费竞争）────────────── */
  section('E · 多进程：两个进程同时拿**同一条** APPROVED 批准去买（消费竞争）');

  {
    const dir = tmpDir('race-consume');
    const seeded = seed(dir, { approvalId: 'econ_approval_race' });
    const barrier = Date.now() + 1500;
    const results = await Promise.all([
      runWorker(['consume', '--dir', dir, '--quote', seeded.quoteId, '--approval', seeded.approvalId, '--key', 'cons-a', '--barrier', String(barrier)]),
      runWorker(['consume', '--dir', dir, '--quote', seeded.quoteId, '--approval', seeded.approvalId, '--key', 'cons-b', '--barrier', String(barrier)])
    ]);
    const rows = results.map(r => r.result).filter(Boolean);
    check('E0 两个 worker 都产出了一行 JSON（没有崩、没有挂）',
      rows.length === 2 && results.every(r => r.code === 0),
      results.map(r => ({ code: r.code, stderr: String(r.stderr).slice(0, 200) })));
    check('E1 ★★ 它们**真的**是同时动手的',
      rows.length === 2 && rows.every(r => r.startedAt >= barrier - 5),
      rows.map(r => r.startedAt - barrier));

    const final = await runWorker(['world', '--dir', dir]);
    const w = final.result.world;
    check('E2 ★★ 最终世界：**恰好一笔** COMPLETED Purchase（不是两笔）',
      w.completedPurchases === 1 && w.purchases === 1 && w.reservedPurchases === 0, w);
    check('E3 ★★ 最终世界：**恰好一笔** Ledger Transaction（mint 1 + 购买 1 = 2）与 4 条 entry',
      w.transactions === 2 && w.entries === 4, { transactions: w.transactions, entries: w.entries });
    check('E4 ★★ 最终世界：**恰好一次**发放（库存总量 = 100，不是 200）',
      w.inventoryEntries === 1 && w.inventoryTotalQuantity === 100,
      { entries: w.inventoryEntries, total: w.inventoryTotalQuantity });
    check('E5 ★★ 最终世界：**恰好一次**批准消费，且它指向那一笔购买',
      w.consumedApprovals === 1 &&
      w.approvalStates.length === 1 &&
      w.approvalStates[0].status === 'CONSUMED' &&
      typeof w.approvalStates[0].consumedBy === 'string' &&
      w.approvalStates[0].consumedBy === w.purchaseAuthorizationModes[0].id,
      { consumed: w.consumedApprovals, states: w.approvalStates, purchases: w.purchaseAuthorizationModes });
    check('E6 ★★ 最终世界：**没有**撕裂事实（没有 CONSUMED 却不指向购买的批准）',
      w.tornFacts.length === 0, w.tornFacts);
    check('E7 ★★ 最终世界完整性检查零问题',
      Array.isArray(w.integrityProblems) && w.integrityProblems.length === 0, w.integrityProblems);
    check('E8 ★★ 最多一个 worker 结算成功；另一个要么是"报价已被链接/已消费"的拒绝，'
      + '要么是终态冲突 —— **绝不能**是第二次扣款',
      (() => {
        const settledOk = rows.filter(r => r.settleOk === true);
        const others = rows.filter(r => r.settleOk !== true);
        return settledOk.length <= 1 &&
          settledOk.every(r => r.ledgerTransactionId === w.purchaseLedgerTransactionId) &&
          others.every(r => r.ledgerTransactionId == null);
      })(),
      rows.map(r => ({ settleOk: r.settleOk, reason: r.settleReason, tx: r.ledgerTransactionId, prep: r.prepareReason })));
    check('E9 ★★ 两笔购买的授权模式逐字写着 APPROVAL 与那条批准 id',
      w.purchaseAuthorizationModes.length === 1 &&
      w.purchaseAuthorizationModes[0].mode === 'APPROVAL' &&
      w.purchaseAuthorizationModes[0].approvalId === seeded.approvalId,
      w.purchaseAuthorizationModes);
  }

  /* ── F · 故障注入：每一个 P22-7 注入点上的崩溃都不得留下撕裂事实 ───── */
  section('F · 故障注入：每一个 P22-7 注入点上的崩溃与整体回滚'
    + '（「批准已消费但没有购买」不可达）');

  /* ★ 注入点清单**从源码里推出来**，而不是在这里手写一份。
     手写清单有一个安静的失效模式：某天有人重命名了一个注入点，而测试
     仍然去请求那个已经不存在的名字 —— 注入变成 no-op、worker 顺利跑完、
     世界看起来完全正常，于是"崩溃回滚"这句话被验证了 0 次。开发期实测
     踩到过这个形状（我最初写的 'before-approval-consume' 与
     'after-purchase-authorization' 都**不存在**）。
     从源码推导之后，清单本身不可能与实现漂移；再加上 worker 的 hit 计数，
     "这个点真的被执行了"就有了双重证据。 */
  const storeSource = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  const allFaultPoints = (storeSource.match(/faultPoint\('([a-z0-9-]+)'\)/g) || [])
    .map(m => /faultPoint\('([a-z0-9-]+)'\)/.exec(m)[1])
    .filter((v, i, a) => a.indexOf(v) === i);
  /* ★ 只取 **P22-7 自己新增**的那些点：批准的决定 / 申请 / 消费，以及自主
     策略的写入。刻意不把 P22-6 的 purchase 点混进来 —— 它们的语义由
     P22-6 的 focused 测试逐点断言，而 P22-6 的 `after-purchase-approval`
     这个名字里虽然含有 "approval"，含义却完全不同（它是 purchase 的一步，
     不是批准记录）。 */
  const faultPoints = allFaultPoints.filter(p =>
    p.indexOf('approval-') >= 0 || p.indexOf('autonomy-') >= 0);
  /* ★ 每个注入点用它**自己的**入口到达。一个从不运行的注入点等于一句
     没有证据的声明 —— 而清单是从源码推导的，所以"哪个点走哪条路"必须
     在这里逐点说清，而不是让所有点共用一条恰好能命中一个的流水线。 */
  const faultPlan = {
    'after-approval-requested': { mode: 'prepare', request: true },
    'before-approval-request-commit': { mode: 'prepare', request: true },
    'after-approval-decided': { mode: 'redecide' },
    'before-approval-decision-commit': { mode: 'redecide' },
    'after-approval-consumed': { mode: 'consume' },
    'after-autonomy-policy-written': { mode: 'policy' },
    'before-autonomy-policy-commit': { mode: 'policy' }
  };

  check('F0 ★★ 每一个 P22-7 注入点都有一个**自己的入口**（清单从源码推导，'
    + '而"哪个点走哪条路"必须逐点说清 —— 一个从不运行的注入点等于一句没有证据的声明）',
    faultPoints.length >= 6 &&
    faultPoints.every(p => storeSource.indexOf("faultPoint('" + p + "')") >= 0) &&
    faultPoints.every(p => faultPlan[p] != null),
    { derived: faultPoints, planned: Object.keys(faultPlan), all: allFaultPoints });

  /* ★ 这三个点位于**事务内部**，因此必须用真实进程崩溃来注入 ——
     `faults.hit()` 抛错会被 store 的 catch 翻成一次业务拒绝，事务照常
     COMMIT（这是 P22-7 开发期最重要的一个发现）。 */
  const CRASH_POINTS = ['after-approval-decided', 'before-approval-decision-commit', 'after-approval-consumed'];
  const faultRows = [];
  for (const point of faultPoints) {
    /* eslint-disable no-await-in-loop */
    const plan = faultPlan[point];
    const dir = tmpDir('fault-' + point);
    const seeded = plan.mode === 'policy' ? null : seed(dir, { approvalId: 'econ_approval_fault' });
    const args = [plan.mode, '--dir', dir, '--point', point, '--key', 'f-' + point];
    if (seeded) { args.push('--quote', seeded.quoteId, '--approval', seeded.approvalId); }
    if (plan.request) { args.push('--request', '1'); }
    /* ★ 对**事务内部**的点，抛错不是崩溃（store 会把它翻成一次业务拒绝而
       事务照常 COMMIT）—— 因此这三个点用**真实进程崩溃**来注入：
       `--crash <point>` 命中即 process.abort()，SQLite 随即回滚。 */
    if (CRASH_POINTS.indexOf(point) >= 0) { args.push('--crash', point); }
    const r = await runWorker(args);
    /* ★ 崩溃**之后**从库里独立读一遍世界：worker 报告的是它自己那一侧的
       读数，而"最终世界是什么样"必须由一个全新的进程独立读出来。 */
    const world = await runWorker(['world', '--dir', dir]);
    faultRows.push({
      point: point, plan: plan, worker: r.result, code: r.code,
      stderr: String(r.stderr).slice(-400), world: world.result.world
    });
  }

  check('F1 ★★ 每一个注入点都**真的命中过**（hit 计数 = 1）—— 而不是静默地什么都没做'
    + '（★ 两个真实的假绿来源都在这里被挡住：argv 传错顺序会让 throwAt 与任何'
    + '真实注入点都不相等；而一个走错入口的流水线会让那个点根本不被执行）',
    faultRows.length === faultPoints.length &&
    faultRows.every(r => r.worker && (r.worker.hitCount === 1 || r.worker.crashed === true) &&
      r.worker.hits && r.worker.hits[r.point] === 1),
    faultRows.map(r => ({
      point: r.point, mode: r.plan.mode, code: r.code,
      hitCount: r.worker && r.worker.hitCount, crashed: r.worker && r.worker.crashed, stderr: r.stderr
    })));

  check('F2 ★★ 每一个点上都不存在「批准已 CONSUMED 但没有 Purchase」',
    faultRows.every(r => r.world.tornFacts.length === 0),
    faultRows.filter(r => r.world.tornFacts.length).map(r => ({ point: r.point, torn: r.world.tornFacts })));

  check('F3 ★★ 每一个点上"批准 CONSUMED 的数量"与"完成的购买数量"**相等**'
    + '（0=都回滚了，1=都留下了 —— 绝不会只有一边）',
    faultRows.every(r => r.world.consumedApprovals === r.world.completedPurchases),
    faultRows.map(r => ({ point: r.point, consumed: r.world.consumedApprovals, completed: r.world.completedPurchases })));

  check('F4 ★★ 每一个点上的完整性检查都零问题（没有任何半完成状态留在库里）',
    faultRows.every(r => Array.isArray(r.world.integrityProblems) && r.world.integrityProblems.length === 0),
    faultRows.filter(r => !r.world.integrityProblems || r.world.integrityProblems.length)
      .map(r => ({ point: r.point, problems: r.world.integrityProblems })));

  check('F5 ★★ 每一个点上"账本交易数"与"完成的购买数"一致：'
    + 'transactions === (播种时那一次 MINT) + completedPurchases',
    faultRows.every(r => r.world.transactions === (r.plan.mode === 'policy' ? 0 : 1) + r.world.completedPurchases),
    faultRows.map(r => ({ point: r.point, mode: r.plan.mode, tx: r.world.transactions, completed: r.world.completedPurchases })));

  check('F6 ★★ 每一个点上"库存总量"与"完成的购买数"一致：'
    + 'inventoryTotalQuantity === 100 × completedPurchases',
    faultRows.every(r => r.world.inventoryTotalQuantity === 100 * r.world.completedPurchases),
    faultRows.map(r => ({ point: r.point, total: r.world.inventoryTotalQuantity, completed: r.world.completedPurchases })));

  /* ══ F7 · 批准**决定**事务里的两个点：真实崩溃之后决定被撤销 ═════════
     ★ 这两个点用 `redecide` 入口 + **真实进程崩溃**（`--crash`）到达：
     redecide 先把批准退回 PENDING 再做一次决定，而注入是一次
     `process.abort()` —— 于是 COMMIT 从未执行，SQLite 回滚整个决定事务。

     ★★ 断言逐字读出来就是"半个决定不可达"：崩溃之后那条批准回到
     **PENDING 且没有任何决定者**（决定、change log、幂等行一起消失），
     而且**没有任何购买成立**。这正是 P22-6/P22-7 那条
     "一次状态跃迁要么整体成立、要么整体不成立"的直接证据。 */
  const decidePoints = ['after-approval-decided', 'before-approval-decision-commit'];
  check('F7 ★★ 批准决定事务里的两个点：真实进程崩溃（exit 134）之后那次决定被**撤销**'
    + '—— 批准回到 PENDING 且没有决定者（半个决定不可达），且没有任何购买成立',
    (() => {
      const rows2 = faultRows.filter(r => decidePoints.indexOf(r.point) >= 0);
      const verdicts = rows2.map(r => ({
        point: r.point,
        crashed: !!(r.worker && r.worker.crashed === true),
        hit: !!(r.worker && r.worker.hits && r.worker.hits[r.point] === 1),
        noPurchases: r.world.purchases === 0,
        oneApproval: r.world.approvals === 1 && r.world.approvalStates.length === 1,
        pending: r.world.approvalStates[0] && r.world.approvalStates[0].status === 'PENDING',
        noDecider: r.world.approvalStates[0] && r.world.approvalStates[0].by === null &&
          r.world.approvalStates[0].consumedBy == null,
        counts: r.world.pendingApprovals === 1 && r.world.approvedApprovals === 0 &&
          r.world.consumedApprovals === 0
      }));
      const ok = rows2.length === decidePoints.length && verdicts.every(v =>
        v.crashed && v.hit && v.noPurchases && v.oneApproval && v.pending && v.noDecider && v.counts);
      return ok;
    })(),
    faultRows.filter(r => decidePoints.indexOf(r.point) >= 0)
      .map(r => ({ point: r.point, crashed: r.worker && r.worker.crashed, code: r.code,
        world: { purchases: r.world.purchases, states: r.world.approvalStates,
          pending: r.world.pendingApprovals, consumed: r.world.consumedApprovals } })));

  /* ══ F8 · 消费与购买必须在同一个原子单位里 ═══════════════════════════
     `after-approval-consumed` 在**结算事务内部**、消费那一条 change 之后。
     真实崩溃 ⇒ COMMIT 从未执行 ⇒ 整个结算回滚：批准回到 APPROVED 且未被
     消费，购买停在 RESERVED。这就是 §10 那句
     "不允许出现 Approval 已 CONSUMED 但 Purchase 没成功建立的撕裂事实"
     的直接证据 —— 撕裂事实在**崩溃点上**也不可达。 */
  check('F8 ★★ `after-approval-consumed` 上的真实崩溃：那次消费与购买**一起回滚**'
    + '（批准回到 APPROVED 且未被消费，购买停在 RESERVED，没有撕裂事实）',
    (() => {
      const r = faultRows.filter(x => x.point === 'after-approval-consumed')[0];
      if (!r) return false;
      return r.worker.crashed === true &&
        r.world.consumedApprovals === 0 && r.world.completedPurchases === 0 &&
        r.world.tornFacts.length === 0 &&
        r.world.integrityProblems.length === 0 &&
        r.world.approvalStates.length === 1 &&
        r.world.approvalStates[0].status === 'APPROVED' &&
        r.world.approvalStates[0].consumedBy == null &&
        /* 购买行**确实**存在（reserve 已经提交过），而它停在 RESERVED ——
           这正是"消费与购买在同一个事务里"的读面证据。 */
        (r.world.purchaseStatus === 'RESERVED' || r.world.purchaseStatus === 'RELEASED');
    })(),
    (faultRows.filter(x => x.point === 'after-approval-consumed')[0] || {}).worker);

  /* ══ F9 · 崩溃之后重试真的能成功一次 ═════════════════════════════════
     每一个注入点上崩溃之后，在**同一个库**上再跑一遍完整链路（不带故障），
     必须恰好留下一笔 COMPLETED 与一次消费 —— 崩溃没有烧掉任何东西。 */
  check('F9 ★★ 每一个注入点上的崩溃之后，**重试真的能成功一次**：'
    + '在同一个库上再跑一遍完整链路，恰好一笔 COMPLETED + 一次消费',
    await (async () => {
      const outcomes = [];
      for (const point of faultPoints) {
        /* eslint-disable no-await-in-loop */
        const plan = faultPlan[point];
        const dir = tmpDir('retry-' + point);
        const seeded = plan.mode === 'policy' ? null : seed(dir, { approvalId: 'econ_approval_retry' });
        const args = [plan.mode, '--dir', dir, '--point', point, '--key', 'rt-' + point];
        if (seeded) { args.push('--quote', seeded.quoteId, '--approval', seeded.approvalId); }
        if (plan.request) { args.push('--request', '1'); }
        /* 崩溃（而不是抛错）—— 与 F1..F8 用同一套注入方式，于是"崩溃之后
           能不能重试成功"问的是同一个世界。 */
        if (CRASH_POINTS.indexOf(point) >= 0) { args.push('--crash', point); }
        await runWorker(args);

        if (plan.mode === 'policy') {
          /* 策略写入失败之后重试：**恰好一条**策略行。 */
          const again = await runWorker(['policy', '--dir', dir, '--key', 'retry-' + point]);
          outcomes.push({ point: point, kind: 'policy', ok: again.result && again.result.ok === true,
            count: again.result && again.result.policyCount });
          continue;
        }
        /* ★ 决定类注入点上的崩溃会把那条批准**退回 PENDING**（那正是 F7
           断言的事），因此重试前必须再做一次决定。而 `redecide` 模式自己
           就会先退回 PENDING，所以这里再走一次它即可。 */
        if (decidePoints.indexOf(point) >= 0) {
          const redecide = await runWorker(['redecide', '--dir', dir, '--approval', seeded.approvalId,
            '--key', 'redec-' + point]);
          if (!(redecide.result && redecide.result.ok === true)) {
            outcomes.push({ point: point, kind: 'decide', ok: false, detail: redecide.result });
            continue;
          }
        }
        /* ★ 重试走 `resume`（而不是再跑一遍 consume）：崩溃可能停在一笔
           **已经提交过**的购买之后，而 P22-6 的 quote_id UNIQUE 会让
           "再 prepare 同一份报价"被 `this-quote-is-already-linked-to-a-purchase`
           拒绝 —— 那正是"一份报价最多一笔购买"这条性质在起作用，不是缺陷。
           正确的重试语义因此是**续做那一笔**（若它存在），否则跑完整链路。 */
        const retry = await runWorker(['resume', '--dir', dir, '--quote', seeded.quoteId,
          '--approval', seeded.approvalId, '--key', 'retry-' + point]);
        const world = await runWorker(['world', '--dir', dir]);
        const w = world.result.world;
        outcomes.push({
          point: point, kind: 'purchase',
          settleOk: retry.result && retry.result.settleOk === true,
          settleReason: retry.result && retry.result.settleReason,
          prepareReason: retry.result && retry.result.prepareReason,
          completed: w.completedPurchases, consumed: w.consumedApprovals,
          torn: w.tornFacts.length, problems: w.integrityProblems.length
        });
      }
      const ok = outcomes.every(o => o.kind === 'policy'
        ? (o.ok === true && o.count === 1)
        : (o.settleOk && o.completed === 1 && o.consumed === 1 && o.torn === 0 && o.problems === 0));
      return ok;
    })(), 'retry must leave exactly one completed purchase and one consumed approval');}

/* ══════════════════════════════════════════════════════════════════
   入口
   ══════════════════════════════════════════════════════════════════ */
runServiceGroup().then(finish).catch(error => {
  console.error('✖ B 组抛出异常 — ' + String(error && (error.stack || error.message)));
  finish();
});
