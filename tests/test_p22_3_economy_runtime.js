'use strict';
/* ====================================================================
   P22-3 · Economy runtime 接线（HTTP 只读面 + 真实子进程 + 多进程竞争）
   --------------------------------------------------------------------
   运行：node tests/test_p22_3_economy_runtime.js

   本文件回答的问题与 store 测试**不同**：
     store 测试问"预留这一层的语义对不对"；本文件问
     "**生产进程里它能被看到吗**，以及**两个真实进程同时动手会不会超订**"。

   ── 为什么必须有一个真实子进程组（C/D/E 组）─────────────────────────
   这个仓库被"装配好了但 openAll() 没打开它"咬过**三次**（memory /
   understanding / moments），P22-2 又抓到了第四次形态（store 打开了、
   http 层没拿到实例）。P22-3 没有新增 store，但它**新增了东西要能被
   读到**（reservation 与 operation）—— 因此同一类断言必须重跑一次：
   真的 spawn home-node-service.js、真的打 /economy/reservation*。

   ── 为什么并发必须用**多进程**（P 组）───────────────────────────────
   node:sqlite 的 DatabaseSync 是同步 API：同一线程内两个 reserve 不可能
   交错，因此"并发安全"在单进程内**无法被证伪**。真正有意义的定义是两个
   各自持有独立 SQLite 连接的操作者，于是 P 组 spawn 4 个真实进程，
   让它们在同一个墙钟时刻同时 reserve，再断言
     Σactive reservations ≤ ledger balance
   以及"恰好 ⌊100/40⌋ = 2 个成功"，而不是"很少超订"。

   ── 写能力仍然不上 HTTP ─────────────────────────────────────────────
   B/C 组会逐个 POST 到每一条 reservation 路径，断言 405 且账本一字节不动。
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
const WORKER_FILE = 'tests/fixtures/p22-3-reserve-worker.js';
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('✔ ' + name);
  else {
    failures++;
    console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  }
}
function section(title) { console.log('\n── ' + title); }

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-3rt-' + tag + '-'));
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

/* 一个真实子进程 worker：跑一次 fixture，把它那一行 JSON 拿回来。 */
function runWorker(args) {
  return new Promise(resolve => {
    const child = spawn(NODE_BIN, [WORKER_FILE].concat(args), {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    openChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', c => { stderr += String(c); });
    child.on('exit', code => {
      openChildren.delete(child);
      let parsed = null;
      const line = stdout.split(/\r?\n/).filter(Boolean).pop();
      try { parsed = line ? JSON.parse(line) : null; } catch (_) { parsed = null; }
      resolve({ code: code, result: parsed, stdout: stdout, stderr: stderr });
    });
  });
}

console.log('P22-3 · Economy runtime（HTTP 只读面 + 真实子进程 + 多进程竞争）');
console.log('  node =', NODE_BIN, NODE_BIN === BUNDLED_NODE ? '(bundled, = production)' : '(FALLBACK: bundled runtime missing)');

const SERVICE = require(path.join(ROOT, SERVICE_FILE));

/* ══════════════════════════════════════════════════════════════════
   A · 装配形状（静态）
   ══════════════════════════════════════════════════════════════════ */
section('A · 装配形状');

{
  const src = fs.readFileSync(path.join(ROOT, SERVICE_FILE), 'utf8');
  check('A1 P22-3 没有新增 store 装配点：Economy 的装配仍然只有 economyAssembly 一份',
    (src.match(/function economyAssembly/g) || []).length === 1);
  check('A2 P22-3 的写方法一个都没有进入装配层（装配层只创建/打开 store，不替它决定业务）',
    ['reserveFunds', 'commitReservation', 'releaseReservation', 'expireReservation',
      'failReservation', 'expireDueReservations'].every(name => src.indexOf(name) < 0),
    ['reserveFunds', 'commitReservation', 'releaseReservation', 'expireReservation',
      'failReservation', 'expireDueReservations'].filter(name => src.indexOf(name) >= 0));
  check('A3 生产 store 的 schema 版本是 2（与运行时声明一致，不是第二套水位）',
    Number(SERVICE.economyStore.SCHEMA_VERSION) === 2 &&
    Number(require(path.join(ROOT, 'services', 'home-node', 'economy-store.js')).SCHEMA_VERSION) === 2);
  check('A4 生产 store 上真的有 P22-3 的六个方法（能力存在，只是没有暴露到 HTTP）',
    ['reserveFunds', 'commitReservation', 'releaseReservation', 'expireReservation',
      'failReservation', 'expireDueReservations'].every(name => typeof SERVICE.economyStore[name] === 'function'));
}

/* ══════════════════════════════════════════════════════════════════
   B · HTTP 只读面（真实 server，真实请求）
   ══════════════════════════════════════════════════════════════════ */
section('B · HTTP 面（reservation 只读路由 / 状态码 / 写入口仍然不存在）');

async function httpGroup() {
  const dir = tmpDir('http');
  const app = SERVICE.buildHomeNode({ dataDir: dir, logger: () => { } });
  app.open();
  app.registry.putCharacter('cfg_a', { id: 'cfg_a', nickname: 'A' }, null);
  const port = await freePort();
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));

  /* 预留通过**内部 API** 产生（HTTP 上没有这条路，那正是要证明的事）。 */
  const w = app.economyStore.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' }).wallet;
  app.economyStore.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 1000n, idempotencyKey: 'rt-seed'
  });
  const reserved = app.economyStore.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 300n,
    expiresAt: Date.now() + 600000, idempotencyKey: 'rt-r1'
  });
  check('B1 预留经内部 API 建立（HTTP 面完全没有那条路）',
    reserved.ok === true && reserved.replayed === false, reserved.errors || '');

  const list = await request(port, 'GET', '/economy/reservations?ownerId=cfg_a');
  check('B2 GET /economy/reservations → 200，返回那一笔，金额是**十进制字符串**',
    list.status === 200 && Array.isArray(list.body.reservations) &&
    list.body.reservations.length === 1 &&
    list.body.reservations[0].amountMinor === '300' &&
    typeof list.body.reservations[0].amountMinor === 'string' &&
    list.body.activeReservations === 1 && list.body.scope === 'owner',
    list.status === 200 ? list.body : list.body);
  check('B3 reservation DTO 里带 operation 的两个侧面，且**不带** idempotencyKey（请求标识不广播）',
    list.body.reservations[0].operation &&
    C.isEconomyId('OPERATION', list.body.reservations[0].operation.operationId) &&
    list.body.reservations[0].operation.status === 'RESERVED' &&
    !Object.prototype.hasOwnProperty.call(list.body.reservations[0], 'idempotencyKey'),
    Object.keys(list.body.reservations[0]));

  const one = await request(port, 'GET', '/economy/reservation?reservationId=' + reserved.result.reservationId);
  check('B4 GET /economy/reservation?reservationId= → 200，state=ACTIVE、terminal=false、expiresAt 可读',
    one.status === 200 && one.body.reservation.state === 'ACTIVE' &&
    one.body.reservation.terminal === false &&
    Number.isSafeInteger(Number(one.body.reservation.expiresAt)) &&
    typeof one.body.reservation.expiresAt === 'number',
    one.status === 200 ? one.body.reservation : one.body);
  const byOp = await request(port, 'GET', '/economy/reservation?operationId=' + reserved.result.operationId);
  check('B5 也可以按 operationId 查（一次操作的两个侧面都能被定位）',
    byOp.status === 200 && byOp.body.reservation.reservationId === reserved.result.reservationId);
  check('B6 缺参数 → 400；不存在的 id → 404（"没给"与"没有"是两个回答）',
    (await request(port, 'GET', '/economy/reservation')).status === 400 &&
    (await request(port, 'GET', '/economy/reservation?reservationId=econ_res_nope')).status === 404);

  const walletView = await request(port, 'GET', '/economy/wallet?ownerId=cfg_a&currency=IB_CREDIT');
  check('B7 /economy/wallet 现在同时给出 canonical 与派生两面：ledger 1000 / reserved 300 / available 700',
    walletView.status === 200 &&
    walletView.body.wallet.ledgerBalanceMinor === '1000' &&
    walletView.body.wallet.reservedBalanceMinor === '300' &&
    walletView.body.wallet.reservedBalanceCachedMinor === '300' &&
    walletView.body.wallet.availableBalanceMinor === '700' &&
    walletView.body.wallet.reservedCacheDrifted === false,
    walletView.status === 200 ? walletView.body.wallet : walletView.body);

  /* ── 写入口**不存在**：本阶段最重要的一组 ───────────────────────── */
  const writePaths = ['/economy/reservation', '/economy/reservations', '/economy/reserve',
    '/economy/commit', '/economy/release', '/economy/expire', '/economy/fail',
    '/economy/sweep', '/economy/wallet'];
  const writeResults = [];
  for (const p of writePaths) {
    const r = await request(port, 'POST', p, { amountMinor: '999999', currency: 'IB_CREDIT', reservationId: reserved.result.reservationId });
    writeResults.push({ path: p, status: r.status, error: r.body && r.body.error });
  }
  check('B8 POST 到**每一条** reservation 路径都是 405 economy-is-read-only（HTTP 层根本没有写路径）',
    writeResults.every(r => r.status === 405 && r.error === 'economy-is-read-only'), writeResults);
  check('B9 这些写尝试没有改变任何东西：锁定量、账本、revision、预留状态全部原样',
    (() => {
      const h = app.economyStore.health();
      const row = app.economyStore.getReservation({ reservationId: reserved.result.reservationId }).reservation;
      return h.revision === 3 && h.counts.transactions === 1 && h.counts.entries === 2 &&
        h.counts.reservations === 1 && h.counts.activeReservations === 1 &&
        row.state === 'ACTIVE';
    })(), app.economyStore.health().counts);
  check('B10 未知的 /economy/* GET → 404（与"写被拒"区分：一个是不存在，一个是不允许）',
    (await request(port, 'GET', '/economy/nope')).status === 404);

  const security = await request(port, 'GET', '/security');
  check('B11 /security 的 economyPolicy 仍然 httpVerbs 只有 GET、writesExposed 为空、mintingExposed=false',
    security.status === 200 && security.body.economyPolicy.httpVerbs.join(',') === 'GET' &&
    security.body.economyPolicy.writesExposed.length === 0 &&
    security.body.economyPolicy.mintingExposed === false,
    security.body.economyPolicy);
  check('B12 P22-3 把"预留写能力"也写成了可断言字段：reservationWritesExposed 为空',
    Array.isArray(security.body.economyPolicy.reservationWritesExposed) &&
    security.body.economyPolicy.reservationWritesExposed.length === 0);
  check('B13 unreachable 名单扩到了 reserve / commit / release / expire / fail / sweep',
    ['reserve', 'commit', 'release', 'expire', 'fail', 'sweep'].every(k =>
      security.body.economyPolicy.unreachable.some(p => p.indexOf('/economy/' + k) === 0)),
    security.body.economyPolicy.unreachable);
  check('B14 desktopPaths 声明了新的两条只读路径（声明与实际路由一致）',
    security.body.economyPolicy.desktopPaths.indexOf('/economy/reservations') >= 0 &&
    security.body.economyPolicy.desktopPaths.indexOf('/economy/reservation') >= 0,
    security.body.economyPolicy.desktopPaths);
  check('B15 doesNotExpose 的 payments 一个字都没动；Economy 仍然不给设备',
    security.body.doesNotExpose.indexOf('payments') >= 0 &&
    security.body.economyPolicy.servedToDevices === false &&
    security.body.economyPolicy.deviceVerbs.length === 0);
  check('B16 available 的公式被写成可读字段（而它现在确实是用 canonical 两个数算的）',
    String(security.body.economyPolicy.availableFormula).indexOf('ledgerBalanceMinor') >= 0 &&
    String(security.body.economyPolicy.availableFormula).indexOf('activeReservedBalanceMinor') >= 0);
  check('B17 /security 的凭据铸造面清单没有被 Economy 改动',
    security.body.credentialMintingPaths.paths.indexOf('/pairing/session') >= 0 &&
    security.body.credentialMintingPaths.paths.indexOf('/characters/publish') >= 0);

  /* ── 授权模型：新的 reservation 路径同样是**桌面面** ─────────────── */
  const tokenDir = tmpDir('token');
  const tokened = SERVICE.buildHomeNode({ dataDir: tokenDir, logger: () => { }, token: 'desk-secret' });
  tokened.open();
  const tokenPort = await freePort();
  await new Promise(r => tokened.server.listen(tokenPort, '127.0.0.1', r));
  const noToken = await request(tokenPort, 'GET', '/economy/reservations');
  const withToken = await request(tokenPort, 'GET', '/economy/reservations', undefined, { 'x-ib-home-token': 'desk-secret' });
  const noTokenOne = await request(tokenPort, 'GET', '/economy/reservation?reservationId=econ_res_x');
  check('B18 配了桌面 token 时，两条新路由不带 token → 401（与既有桌面路径同款判定）',
    noToken.status === 401 && noToken.body.error === 'unauthenticated' &&
    noTokenOne.status === 401, { list: noToken.status, one: noTokenOne.status });
  check('B19 带上正确 token → 200（不是"配了 token 就永远打不开"的面）', withToken.status === 200);

  await new Promise(r => tokened.server.close(r));
  tokened.close();
  await new Promise(r => app.server.close(r));
  app.close();
}

/* ══════════════════════════════════════════════════════════════════
   C/D/E · 真实生产子进程
   ══════════════════════════════════════════════════════════════════ */
section('C · 真实子进程（spawn services/home-node-service.js，打真实 HTTP）');

async function childProcessGroup() {
  const dir = tmpDir('prod');
  const prod = await startProduction(dir);
  const up = await waitListening(prod, 25000);
  check('C1 生产入口在私有端口 + 私有数据目录上真的起来了', up === true, prod.output());
  if (!up) return;

  try {
    const health = await request(prod.port, 'GET', '/economy/health');
    check('C2 真实生产进程的 schema 是 2，且 reserved 的两面都被自述',
      health.status === 200 && Number(health.body.economy.schemaVersion) === 2 &&
      health.body.economy.expectedSchemaVersion === 2 &&
      health.body.economy.reservedCanonical === 'sqlite-active-reservations' &&
      health.body.economy.reservationStateVocabulary.indexOf('RESERVATION_STATE') >= 0 &&
      health.body.economy.operationStateVocabulary.indexOf('TX_STATE') >= 0,
      health.status === 200 ? health.body.economy : health.body);
    check('C3 counts 里有 operations / reservations / activeReservations（观测面跟着能力长）',
      health.body.economy.counts.operations === 0 &&
      health.body.economy.counts.reservations === 0 &&
      health.body.economy.counts.activeReservations === 0, health.body.economy.counts);
    check('C4 启动日志里有 economy-opened，且它报告了预留对账跑过（reservationsReconciled）',
      /economy-opened/.test(prod.output()) &&
      /"reservationsReconciled":\s*true/.test(prod.output()) &&
      /"activeReservations":\s*0/.test(prod.output()),
      prod.output().slice(-900));
    check('C5 真实进程上的 reservation 写路径不存在（405）',
      (await request(prod.port, 'POST', '/economy/reserve', { amountMinor: '1' })).status === 405 &&
      (await request(prod.port, 'POST', '/economy/commit', { reservationId: 'econ_res_x' })).status === 405);
    check('C6 新库上 GET /economy/reservations → 200 且为空（不是 501、不是 404）',
      (await request(prod.port, 'GET', '/economy/reservations')).status === 200 &&
      (await request(prod.port, 'GET', '/economy/reservations')).body.reservations.length === 0);

    await stopProduction(prod);
    check('C7 生产进程干净退出（合作停止面之后进程真的结束了）', !!prod.exited, prod.exited);
    check('C8 停机日志里有 shutdown / stopped / economy-closed，且拆除梯子跑完五步',
      /\bshutdown \{/.test(prod.output()) && /\bstopped \{/.test(prod.output()) &&
      /economy-closed/.test(prod.output()) &&
      /"steps":\s*\[\s*"entering",\s*"stopWork",\s*"stopTimers",\s*"closeStores",\s*"report"\s*\]/.test(prod.output()) &&
      /"errors":\s*null/.test(prod.output()),
      prod.output().slice(-600));

    /* ── D · 重启同一个库：RESERVED 与 COMMITTED 都原样 ─────────────── */
    const direct = SERVICE.economyAssembly({ dataDir: dir, logger: () => { } }).economyStore;
    direct.open();
    const wUser = direct.openWallet({ owner: { type: 'user', id: 'user' }, currency: 'IB_CREDIT' });
    check('D1 直接打开同一个库（生产进程已停机，不存在抢库）', wUser.ok === true, wUser.errors || '');
    direct.mintForSystem({
      systemInitiated: true, walletId: wUser.wallet.walletId, currency: 'IB_CREDIT',
      amountMinor: 1000n, idempotencyKey: 'prod-mint'
    });
    const keepReserved = direct.reserveFunds({
      walletId: wUser.wallet.walletId, currency: 'IB_CREDIT', amountMinor: 250n,
      expiresAt: Date.now() + 3600000, idempotencyKey: 'prod-reserved'
    });
    const toCommit = direct.reserveFunds({
      walletId: wUser.wallet.walletId, currency: 'IB_CREDIT', amountMinor: 400n,
      expiresAt: Date.now() + 3600000, idempotencyKey: 'prod-tocommit'
    });
    const committed = direct.commitReservation({ reservationId: toCommit.result.reservationId, idempotencyKey: 'prod-commit' });
    check('D2 重启之前：1 笔 ACTIVE + 1 笔 COMMITTED，账本 1000 → 600，锁定量 250',
      keepReserved.ok === true && committed.ok === true &&
      direct.ledgerBalanceOf(wUser.wallet.walletId).balanceMinor === '600' &&
      direct.reservedBalanceOf(wUser.wallet.walletId).reservedBalanceMinor === '250' &&
      availableOf(direct, wUser.wallet.walletId) === '350',
      { ledger: direct.ledgerBalanceOf(wUser.wallet.walletId).balanceMinor, reserved: direct.reservedBalanceOf(wUser.wallet.walletId).reservedBalanceMinor });
    const revisionBefore = direct.getRevision();
    direct.close();

    const prod2 = await startProduction(dir);
    const up2 = await waitListening(prod2, 25000);
    check('D3 生产进程用**同一个库**重启成功', up2 === true, prod2.output());
    if (!up2) return;
    try {
      const health2 = await request(prod2.port, 'GET', '/economy/health');
      check('D4 重启后 schema / revision 从原值继续，且 counts 与写入时一致',
        Number(health2.body.economy.schemaVersion) === 2 &&
        Number(health2.body.economy.revision) === revisionBefore &&
        health2.body.economy.counts.reservations === 2 &&
        health2.body.economy.counts.activeReservations === 1 &&
        health2.body.economy.counts.transactions === 2,
        { health: health2.body.economy.counts, revision: health2.body.economy.revision, before: revisionBefore });

      const list2 = await request(prod2.port, 'GET', '/economy/reservations?ownerId=user');
      check('D5 重启后两笔预留逐字还在：一笔 ACTIVE、一笔 COMMITTED，金额与链接都可读',
        list2.status === 200 && list2.body.reservations.length === 2 &&
        list2.body.reservations.filter(r => r.state === 'ACTIVE').length === 1 &&
        list2.body.reservations.filter(r => r.state === 'COMMITTED').length === 1 &&
        list2.body.reservations.filter(r => r.state === 'COMMITTED')[0].transactionId === committed.result.transactionId,
        list2.status === 200 ? list2.body.reservations.map(r => r.state + ':' + r.amountMinor) : list2.body);

      const one2 = await request(prod2.port, 'GET', '/economy/reservation?reservationId=' + keepReserved.result.reservationId);
      check('D6 重启后按 reservationId 读同一笔：state=ACTIVE、operation=RESERVED、sweepableNow=false',
        one2.status === 200 && one2.body.reservation.state === 'ACTIVE' &&
        one2.body.reservation.operation.status === 'RESERVED' &&
        one2.body.reservation.sweepableNow === false,
        one2.status === 200 ? one2.body.reservation : one2.body);

      const wallet2 = await request(prod2.port, 'GET', '/economy/wallet?ownerId=user&currency=IB_CREDIT');
      check('D7 重启后三个数逐字相同：ledger 600 / reserved 250 / available 350',
        wallet2.body.wallet.ledgerBalanceMinor === '600' &&
        wallet2.body.wallet.reservedBalanceMinor === '250' &&
        wallet2.body.wallet.availableBalanceMinor === '350',
        wallet2.body.wallet);
      const rebuilt2 = await request(prod2.port, 'GET', '/economy/wallet?ownerId=user&currency=IB_CREDIT&rebuild=1');
      check('D8 ?rebuild=1 报告**没有漂移**（持久化的是事实，不是缓存）',
        rebuilt2.body.wallet.reservedCacheDrifted === false &&
        rebuilt2.body.wallet.cachedBalanceDrifted === false &&
        rebuilt2.body.wallet.availableBalanceMinor === '350');
      const changes2 = await request(prod2.port, 'GET', '/economy/changes?cursor=0');
      check('D9 重启后 change log 逐条还在、revision 序列没有断',
        Number(changes2.body.revision) === revisionBefore &&
        changes2.body.changes.every((c, i) => c.revision === i + 1),
        changes2.body.changes.map(c => c.revision));
    } finally {
      await stopProduction(prod2);
      check('D10 第二个生产进程也干净退出', !!prod2.exited, prod2.exited);
    }

    /* ── E · 幂等**跨进程重启**（reserve / commit 各一次）────────────── */
    const direct2 = SERVICE.economyAssembly({ dataDir: dir, logger: () => { } }).economyStore;
    direct2.open();
    const countsBefore = direct2.health().counts;
    const replayReserve = direct2.reserveFunds({
      walletId: keepReserved.result.walletId, currency: 'IB_CREDIT', amountMinor: 250n,
      expiresAt: keepReserved.result.expiresAt, idempotencyKey: 'prod-reserved'
    });
    check('E1 跨进程重启重放同一个 reserve key → replayed=true，返回原来那笔预留',
      replayReserve.ok === true && replayReserve.replayed === true &&
      replayReserve.result.reservationId === keepReserved.result.reservationId,
      { ok: replayReserve.ok, replayed: replayReserve.replayed, got: replayReserve.result && replayReserve.result.reservationId });
    const replayCommit = direct2.commitReservation({ reservationId: toCommit.result.reservationId, idempotencyKey: 'prod-commit' });
    check('E2 跨进程重启重放同一个 commit key → replayed=true，返回原来那笔 transaction',
      replayCommit.ok === true && replayCommit.replayed === true &&
      replayCommit.result.transactionId === committed.result.transactionId,
      replayCommit.result || replayCommit);
    check('E3 两次跨重启重放之后行数、revision、余额、锁定量都没有变（没有第二次经济 mutation）',
      JSON.stringify(direct2.health().counts) === JSON.stringify(countsBefore) &&
      direct2.getRevision() === revisionBefore &&
      direct2.ledgerBalanceOf(keepReserved.result.walletId).balanceMinor === '600' &&
      direct2.reservedBalanceOf(keepReserved.result.walletId).reservedBalanceMinor === '250',
      { after: direct2.health().counts, before: countsBefore });
    const conflict = direct2.reserveFunds({
      walletId: keepReserved.result.walletId, currency: 'IB_CREDIT', amountMinor: 251n,
      expiresAt: keepReserved.result.expiresAt, idempotencyKey: 'prod-reserved'
    });
    check('E4 跨重启时同一个 key 换金额 → IDEMPOTENCY_CONFLICT（幂等记录是持久的，不是内存里的）',
      conflict.ok === false && conflict.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0, conflict.errors);
    direct2.close();
  } catch (error) {
    failures++;
    console.error('✖ C/D/E 组异常 — ' + String(error && error.stack || error));
    console.error('  进程输出: ' + prod.output());
  } finally {
    await stopProduction(prod);
  }
}

function availableOf(store, walletId) {
  const g = store.getWallet({ walletId: walletId });
  return g.ok ? store.serializeWallet(g.wallet, {}).availableBalanceMinor : null;
}

/* ══════════════════════════════════════════════════════════════════
   F · 未接线时的诚实回答（501，而不是 404）
   ══════════════════════════════════════════════════════════════════ */
section('F · 装配缺口必须说自己"没接线"，而不是伪装成"没这个路径"');

async function unassembledGroup() {
  const createHttp = require(path.join(ROOT, 'services', 'home-node', 'http.js'));
  const createStore = require(path.join(ROOT, 'services', 'home-node', 'chat-store.js'));
  const dir = tmpDir('noecon');
  const chat = createStore({ dataDir: dir, logger: () => { } });
  chat.open();
  const layer = createHttp({
    store: chat, executor: null, gateway: null, token: '', version: 'test',
    allowedOrigins: [], logger: () => { }
    /* 刻意不传 economyStore */
  });
  const port = await freePort();
  await new Promise(r => layer.server.listen(port, '127.0.0.1', r));
  const list = await request(port, 'GET', '/economy/reservations');
  const one = await request(port, 'GET', '/economy/reservation?reservationId=econ_res_x');
  check('F1 装配没接 Economy 时，两条 reservation 只读路由都是 501 economy-not-assembled（不是 404，也不是 200 + 空数组）',
    list.status === 501 && list.body.error === 'economy-not-assembled' &&
    one.status === 501 && one.body.error === 'economy-not-assembled',
    { list: { status: list.status, body: list.body }, one: { status: one.status, body: one.body } });
  await new Promise(res => layer.server.close(res));
  chat.close();
}

/* ══════════════════════════════════════════════════════════════════
   P · 多进程竞争（§20 的真正证明）
   ══════════════════════════════════════════════════════════════════ */
section('P · 多进程竞争（4 个真实进程同一时刻 reserve，Σactive ≤ ledger）');

async function multiProcessGroup() {
  const dir = tmpDir('race');
  const app = SERVICE.economyAssembly({ dataDir: dir, logger: () => { } }).economyStore;
  app.open();
  const w = app.openWallet({ owner: { type: 'user', id: 'user' }, currency: 'IB_CREDIT' }).wallet;
  app.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 100n, idempotencyKey: 'race-mint'
  });
  app.close();

  const expiresAt = Date.now() + 3600000;
  /* 起跑线放在"现在 + 2.5 秒"：四个进程要各自启动、require、开库、
     建表，2.5 秒足够全部就位；然后它们在同一个毫秒附近同时动手。 */
  const barrier = Date.now() + 2500;
  const workers = [0, 1, 2, 3].map(i => runWorker([
    dir, w.walletId, '40', String(expiresAt), 'race-' + i, String(barrier)
  ]));
  const settled = await Promise.all(workers);

  const crashed = settled.filter(s => !s.result || s.result.crash);
  check('P1 四个 worker 都跑完了（没有崩溃、没有 SQLITE_BUSY 逃逸）',
    crashed.length === 0 && settled.every(s => s.code === 0),
    settled.map(s => ({ code: s.code, result: s.result, stderr: s.stderr.slice(-200) })));

  const results = settled.map(s => s.result).filter(Boolean);
  const okCount = results.filter(r => r.ok === true && r.replayed !== true).length;
  const denied = results.filter(r => r.ok === false && r.reasonCode === 'INSUFFICIENT_AVAILABLE_BALANCE').length;
  check('P2 四个进程同时要 40（余额 100）：**恰好** 2 个成功、2 个以 INSUFFICIENT_AVAILABLE_BALANCE 被拒',
    okCount === 2 && denied === 2, results.map(r => ({ ok: r.ok, reason: r.reasonCode, errors: r.errors })));
  check('P3 起跑线真的生效了（四个 worker 的动手时刻落在同一个 1.5 秒窗口内，而不是依次）',
    (() => {
      const times = results.map(r => Number(r.startedAt)).filter(Number.isFinite);
      return times.length === 4 && (Math.max.apply(null, times) - Math.min.apply(null, times)) < 1500;
    })(), results.map(r => r.startedAt));

  /* ── 整个不变量：拿一个**独立连接**重新读一遍事实 ─────────────── */
  const verify = SERVICE.economyAssembly({ dataDir: dir, logger: () => { } }).economyStore;
  verify.open();
  const reservedTotal = BigInt(verify.reservedBalanceOf(w.walletId).reservedBalanceMinor);
  const ledgerTotal = BigInt(verify.ledgerBalanceOf(w.walletId).balanceMinor);
  check('P4 Σactive reservations = 80 ≤ ledger 100（超订**不可能**发生，而不是"很少发生"）',
    reservedTotal === 80n && ledgerTotal === 100n && reservedTotal <= ledgerTotal,
    { reserved: reservedTotal.toString(), ledger: ledgerTotal.toString() });
  check('P5 available = 20，且它与那两个数自洽',
    verify.serializeWallet(verify.getWallet({ walletId: w.walletId }).wallet, {}).availableBalanceMinor === '20');
  check('P6 库里恰好 2 笔 ACTIVE 预留（成功的那些各自一笔，失败的一笔都没留）',
    verify.health().counts.reservations === 2 && verify.health().counts.activeReservations === 2 &&
    verify.health().counts.operations === 2, verify.health().counts);
  check('P6b 两个成功进程生成的 id **互不相同** —— 缺省 id 生成器在多进程下不再撞车'
    + '（修复前：4 个进程同毫秒启动，idSeq 都是 1，第二个插入撞 UNIQUE 直接崩溃）',
    (() => {
      const ids = results.filter(r => r.reservationId).map(r => r.reservationId);
      return ids.length === 2 && new Set(ids).size === 2 && ids.every(i => C.isEconomyId('RESERVATION', i));
    })(), results.map(r => r.reservationId));
  check('P7 多进程竞争之后账本仍然逐币种平衡，且没有产生任何 ledger 事实（reserve 不写账本）',
    verify.ledgerTopology(null).every(t => t.balanced === true) &&
    verify.health().counts.transactions === 1 && verify.health().counts.entries === 2);
  check('P8 四个进程的比赛没有破坏 revision 序列（无洞、无重复）',
    verify.listChanges(0, 500).every((c, i) => c.revision === i + 1),
    verify.listChanges(0, 500).map(c => c.revision));
  verify.close();
}

(async () => {
  await httpGroup();
  await unassembledGroup();
  await childProcessGroup();
  await multiProcessGroup();

  console.log('\n' + '═'.repeat(64));
  if (failures === 0) {
    console.log('P22-3 runtime: 全部通过 ✔');
    process.exitCode = 0;
  } else {
    console.error('P22-3 runtime: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})().catch(error => {
  console.error('P22-3 runtime: 未捕获异常 — ' + String(error && error.stack || error));
  process.exit(1);
});
