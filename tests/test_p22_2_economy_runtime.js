'use strict';
/* ====================================================================
   P22-2 · Economy runtime 接线（装配两条路径 + HTTP 只读面 + 真实子进程）
   --------------------------------------------------------------------
   运行：node tests/test_p22_2_economy_runtime.js

   本文件回答的问题与 store 测试**不同**：
     store 测试问"账本本身对不对"；本文件问"**生产进程里到底有没有它**"。

   ── 为什么必须有一个真实子进程组（C/D 组）──────────────────────────
   这个仓库已经被同一个缺口咬过**三次**：
     · P11-3X-B  memory      —— store 装配了，openAll() 没开；
     · M1-C.2m   understanding —— 同上，/understanding/* 全 501；
     · P11-3E    moments     —— 同上，而且这次最隐蔽：网关接线了、
                                只差一个 open()，而所有 createXStore() 测试全绿。
   三次的共同形态是：**单元测试与直接 store 测试全绿，真实进程里那一域不可服务。**
   因此本组刻意 ① 真的 spawn `services/home-node-service.js`，
   ② 打真实的 /economy/* HTTP 请求，③ 重启进程再打一次，
   ④ 用真实请求验证 idempotency 跨进程重启仍然有效。
   不 mock store、不复制接线、不直接调用 createEconomyStore 冒充生产验证。

   ── 为什么 B 组要"两条装配路径都真的启动"────────────────────────────
   只 grep 一次 require 证明不了"打开过"。B 组因此对
   buildHomeNode() 与模块级 openAll() **各自**断言 isOpen()，
   并且断言两条路径拿到的是**同一个类**的实例（不是同一个实例 ——
   它们本来就是两个装配）。
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
    console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  }
}
function section(title) { console.log('\n── ' + title); }

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-2rt-' + tag + '-'));
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

/* 生产解释器 = 内置 runtime/node/node.exe（与 runtime/local-services-runner.js
   逐字相同）。缺失时退回 process.execPath 并如实说明。 */
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
  /* 优先走**合作停止面**（Windows 上 SIGTERM 就是 TerminateProcess，
     会跳过 store.close()）。服务端在 /__shutdown 上跑的是同一条拆除梯子。 */
  try { await request(svc.port, 'POST', '/__shutdown', {}); } catch (_) { /* 可能已经退出 */ }
  for (let i = 0; i < 60 && !svc.exited; i++) await sleep(100);
  if (!svc.exited) svc.child.kill('SIGTERM');
  for (let i = 0; i < 30 && !svc.exited; i++) await sleep(100);
}

console.log('P22-2 · Economy runtime（装配 + HTTP + 真实子进程）');
console.log('  node =', NODE_BIN, NODE_BIN === BUNDLED_NODE ? '(bundled, = production)' : '(FALLBACK: bundled runtime missing)');

/* ══════════════════════════════════════════════════════════════════
   A · 装配形状（静态 + 进程级实例）
   ══════════════════════════════════════════════════════════════════ */
section('A · 装配形状');

const SERVICE = require(path.join(ROOT, SERVICE_FILE));

{
  const src = fs.readFileSync(path.join(ROOT, SERVICE_FILE), 'utf8');
  check('A1 home-node-service 里 Economy 的装配只有**一份定义**（economyAssembly），两条路径共用它',
    (src.match(/function economyAssembly/g) || []).length === 1 &&
    typeof SERVICE.economyAssembly === 'function');
  check('A2 buildHomeNode 与要求 Economy store 是**同一个**装配函数（不是各写一遍）',
    (src.match(/economyAssembly\(\{/g) || []).length >= 2,
    (src.match(/economyAssembly\(\{/g) || []).length);
  check('A3 模块级导出 economyStore（于是"生产侧有没有可用 Economy"是一句可断言的事实）',
    !!SERVICE.economyStore && typeof SERVICE.economyStore.isOpen === 'function' &&
    typeof SERVICE.economyStore.health === 'function');
  check('A4 进程级 store 的 schema 与契约表名与模块导出一致（同一个实现，不是第二份）',
    SERVICE.economyStore.SCHEMA_VERSION === require(path.join(ROOT, 'services', 'home-node', 'economy-store.js')).SCHEMA_VERSION);

  /* 负向守卫：Economy 不得从装配层拿到任何它不该有的东西。 */
  const storeBindings = (src.match(/economyAssembly\(\{[\s\S]*?\}\)/g) || []).join('\n');
  check('A5 装配层只给 Economy 传 dataDir / clock / logger / ownerExists / systemAuthority —— 不传任何凭据或支付依赖',
    storeBindings.indexOf('credential') < 0 && storeBindings.indexOf('pay') < 0 &&
    storeBindings.indexOf('modelPort') < 0 && storeBindings.indexOf('apiKey') < 0,
    storeBindings.slice(0, 400));
}

/* ══════════════════════════════════════════════════════════════════
   B · 两条装配路径都**真的打开** Economy
   ══════════════════════════════════════════════════════════════════ */
section('B · 两条装配路径（buildHomeNode / 生产 openAll）都真的打开 Economy');

{
  /* ── 路径 1：buildHomeNode ─────────────────────────────────────── */
  const dir = tmpDir('build');
  const app = SERVICE.buildHomeNode({ dataDir: dir, logger: () => { } });
  check('B1 buildHomeNode 返回 economyStore，且**打开之前**它是关的（说明 open() 真的做了事）',
    !!app.economyStore && app.economyStore.isOpen() === false);
  app.open();
  check('B2 buildHomeNode().open() 之后 economyStore.isOpen() 为真',
    app.economyStore.isOpen() === true);
  check('B3 打开之后 state 是 READY（不是 COLD / DEGRADED）',
    app.economyStore.health().state === C.WALLET_STATE.READY, app.economyStore.health());
  check('B4 它开的库就在**实例自己的** dataDir 里（测试实例绝不读写生产数据目录）',
    path.resolve(app.economyStore.file) === path.resolve(path.join(dir, SERVICE.economyStore.DB_FILENAME)),
    { file: app.economyStore.file, dir: dir });
  check('B5 装配守卫：ownerExists 谓词存在（角色不存在的钱包会被拒绝，因为注册表里没有它）',
    app.economyStore.openWallet({ owner: { type: 'character', id: 'cfg_nobody' }, currency: 'IB_CREDIT' })
      .errors.indexOf('owner-not-found') >= 0);
  app.close();
  check('B6 buildHomeNode().close() 之后 economyStore 也关了（不留悬挂连接）',
    app.economyStore.isOpen() === false);

  /* ── 路径 2：生产 openAll（模块级）────────────────────────────── */
  /* 这一条刻意**不**用真实子进程 —— 那在 C 组。这里问的是
     "模块级那条 openAll() 有没有把 Economy 算进去"，而它就是
     require.main 分支调用的同一个函数。 */
  const prodDirBefore = SERVICE.economyStore.file;
  check('B7 模块级 economyStore 在 require 时未自动打开（打开只发生在 openAll）',
    SERVICE.economyStore.isOpen() === false, SERVICE.economyStore.health().state);
  const openedResult = SERVICE.openAll();
  check('B8 生产 openAll() 之后模块级 economyStore.isOpen() 为真 —— 这就是第三次漏装配的同一个断言',
    SERVICE.economyStore.isOpen() === true, SERVICE.economyStore.health());
  check('B9 生产 openAll() 之后 state 是 READY，且库在进程级 DATA_DIR 上',
    SERVICE.economyStore.health().state === C.WALLET_STATE.READY &&
    path.resolve(SERVICE.economyStore.file) === path.resolve(path.join(SERVICE.DATA_DIR, SERVICE.economyStore.DB_FILENAME)),
    { file: SERVICE.economyStore.file, dataDir: SERVICE.DATA_DIR, before: prodDirBefore });
  check('B10 生产 openAll() 的返回值仍然是 chat store 的 open 结果（既有契约没被改）',
    !!openedResult && openedResult.ok === true);

  /* 生产 store 的清理：关掉它，避免污染后续（尤其是真实子进程组的
     数据目录无关性）。DATA_DIR 由测试环境变量指向临时目录，
     因此这里关闭的是测试自己的库。 */
  SERVICE.economyStore.close();
  check('B11 关闭之后不再开放（幂等）', SERVICE.economyStore.close().alreadyClosed === true);
}

/* ══════════════════════════════════════════════════════════════════
   C · HTTP 只读面（真实 server，真实请求）
   ══════════════════════════════════════════════════════════════════ */
section('C · HTTP 面（只读 / 状态码 / 不暴露写入口）');

async function httpGroup() {
  const dir = tmpDir('http');
  const app = SERVICE.buildHomeNode({ dataDir: dir, logger: () => { } });
  app.open();
  /* 角色的 canonical owner 是 device registry。先登记一个，否则
     ownerExists 会（正确地）拒绝开钱包。 */
  app.registry.putCharacter('cfg_a', { id: 'cfg_a', nickname: 'A' }, null);
  const port = await freePort();
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));

  const health = await request(port, 'GET', '/economy/health');
  check('C1 GET /economy/health → 200，state=READY，schemaVersion 与运行时一致',
    health.status === 200 && health.body.economy &&
    health.body.economy.state === 'READY' &&
    Number(health.body.economy.schemaVersion) === app.economyStore.SCHEMA_VERSION &&
    health.body.economy.open === true,
    health.status === 200 ? health.body.economy : health.body);
  check('C2 health 自述了"没有"什么（payments / credentials / provider-billing / topup）—— 让"不暴露"成为可断言字段',
    Array.isArray(health.body.economy.doesNotExpose) &&
    ['payments', 'credentials', 'provider-billing', 'topup'].every(k => health.body.economy.doesNotExpose.indexOf(k) >= 0),
    health.body.economy && health.body.economy.doesNotExpose);
  check('C3 health 声明 canonical 是 sqlite-ledger-entries、缓存是派生 —— 而不是反过来',
    health.body.economy.canonical === 'sqlite-ledger-entries' &&
    String(health.body.economy.derived).indexOf('wallet') === 0);

  /* 铸币通过**内部 API**（HTTP 上没有这条路）。 */
  const w = app.economyStore.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' }).wallet;
  const mint = app.economyStore.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 1234, idempotencyKey: 'http-seed'
  });
  check('C4 铸币走的是 store 内部 API（HTTP 面完全没有那条路）', mint.ok === true && mint.replayed === false, mint.errors || '');

  const wallet = await request(port, 'GET', '/economy/wallet?ownerId=cfg_a&currency=IB_CREDIT');
  check('C5 GET /economy/wallet → 200，available/cached 都是**十进制字符串**，state=READY',
    wallet.status === 200 && wallet.body.wallet.state === 'READY' &&
    wallet.body.wallet.availableBalanceMinor === '1234' &&
    wallet.body.wallet.cachedBalanceMinor === '1234' &&
    typeof wallet.body.wallet.availableBalanceMinor === 'string',
    wallet.status === 200 ? wallet.body.wallet : wallet.body);
  check('C6 响应里没有 number 形态的金额（字符串是刻意的：JSON 里的资金数字不允许丢精度）',
    typeof wallet.body.wallet.availableBalanceMinor !== 'number');

  const rebuilt = await request(port, 'GET', '/economy/wallet?ownerId=cfg_a&currency=IB_CREDIT&rebuild=1');
  check('C7 ?rebuild=1 会**从 ledger 重算**再回答（于是"余额可重建"可以被一个真实请求验证）',
    rebuilt.status === 200 && rebuilt.body.wallet.rebuilt === true &&
    rebuilt.body.wallet.availableBalanceMinor === '1234',
    rebuilt.status === 200 ? rebuilt.body.wallet : rebuilt.body);

  const ledger = await request(port, 'GET', '/economy/ledger?accountId=' + w.accountId + '&currency=IB_CREDIT');
  check('C8 GET /economy/ledger → 200，返回 entries 与逐币种 topology（账户维度 scope=account）',
    ledger.status === 200 && Array.isArray(ledger.body.entries) && ledger.body.entries.length === 1 &&
    ledger.body.entries[0].amountMinor === '1234' &&
    ledger.body.scope === 'account' &&
    Array.isArray(ledger.body.topology) && ledger.body.topology.length === 1 &&
    ledger.body.topology[0].debitTotal === '1234',
    ledger.status === 200 ? { n: ledger.body.entries && ledger.body.entries.length, scope: ledger.body.scope, topology: ledger.body.topology } : ledger.body);

  const tx = await request(port, 'GET', '/economy/transaction?transactionId=' + mint.transactionId);
  check('C9 GET /economy/transaction → 200，带两笔 entry（双式记账的两端都可读）',
    tx.status === 200 && tx.body.entries.length === 2 &&
    tx.body.transaction.state === 'COMMITTED' &&
    tx.body.entries.map(e => e.direction).sort().join(',') === 'CREDIT,DEBIT',
    tx.status === 200 ? tx.body.entries.map(e => e.accountId + ':' + e.direction) : tx.body);

  const changes = await request(port, 'GET', '/economy/changes?cursor=0');
  check('C10 GET /economy/changes → 200，revision 单调且 kind 封闭',
    changes.status === 200 && changes.body.changes.length === 2 &&
    changes.body.changes[0].revision === 1 && changes.body.changes[1].revision === 2 &&
    Number(changes.body.revision) === 2,
    changes.status === 200 ? changes.body.changes.map(c => c.revision + ':' + c.kind) : changes.body);

  /* ── 写入口**不存在**：这组是本阶段最重要的一条 ─────────────────── */
  const writePaths = ['/economy/topup', '/economy/purchase', '/economy/payment', '/economy/provider',
    '/economy/mint', '/economy/burn', '/economy/transfer', '/economy/wallet', '/economy/ledger'];
  const writeResults = [];
  for (const p of writePaths) {
    const r = await request(port, 'POST', p, { amountMinor: '999999', currency: 'IB_CREDIT' });
    writeResults.push({ path: p, status: r.status, error: r.body && r.body.error });
  }
  check('C11 POST 到任何 /economy/* 都是 405 economy-is-read-only（HTTP 层根本没有写路径）',
    writeResults.every(r => r.status === 405 && r.error === 'economy-is-read-only'), writeResults);
  check('C12 这些 POST 没有改变账本（写尝试之后 revision 与余额都不动）',
    (() => {
      const h = app.economyStore.health();
      return h.revision === 2 && h.counts.transactions === 1 && h.counts.entries === 2;
    })(), app.economyStore.health().counts);
  check('C13 未知的 /economy/* GET → 404 unknown-economy-path（与"写被拒"区分开：一个是不存在，一个是不允许）',
    (await request(port, 'GET', '/economy/nope')).status === 404);

  const security = await request(port, 'GET', '/security');
  check('C14 /security 的 economyPolicy 可检查：httpVerbs 只有 GET、writesExposed 为空、mintingExposed=false',
    security.status === 200 && security.body.economyPolicy &&
    security.body.economyPolicy.httpVerbs.join(',') === 'GET' &&
    security.body.economyPolicy.writesExposed.length === 0 &&
    security.body.economyPolicy.mintingExposed === false,
    security.body.economyPolicy);
  check('C15 /security 的 unreachable 写出 topup / payment / provider / mint / burn / transfer，并把购买写形态逐条列进去',
    ['topup', 'payment', 'provider', 'mint', 'burn', 'transfer'].every(k =>
      security.body.economyPolicy.unreachable.some(p => p.indexOf('/economy/' + k) === 0)) &&
    /* ★ P22-6 把 `/economy/purchase` 从这份名单里**移走**了（它现在是一条
       真实的只读路由）。一条不再为真的声明，它的正确归宿不是留着，而是
       换成**真正**不可达的那些写形态：prepare / settle / buy / cancel /
       refund。这里同时做**反向**断言，证明它确实被移走了 —— 否则"移走"
       与"忘了留"在测试里长得一模一样。 */
    ['/economy/prepare', '/economy/settle', '/economy/buy', '/economy/cancel', '/economy/refund']
      .every(p => security.body.economyPolicy.unreachable.indexOf(p) >= 0) &&
    security.body.economyPolicy.unreachable.indexOf('/economy/purchase') < 0 &&
    security.body.economyPolicy.desktopPaths.indexOf('/economy/purchase') >= 0,
    security.body.economyPolicy.unreachable);
  check('C16 Economy 仍然声明**不给设备**：servedToDevices=false 且 deviceVerbs 为空',
    security.body.economyPolicy.servedToDevices === false &&
    security.body.economyPolicy.deviceVerbs.length === 0);
  check('C17 doesNotExpose 里的 payments 一个字都没动（Economy 没有把它从预算里挪走）',
    security.body.doesNotExpose.indexOf('payments') >= 0,
    security.body.doesNotExpose);
  check('C18 /security 的凭据铸造面清单没有被 Economy 改动（pairing / devices / characters 仍是那三条）',
    security.body.credentialMintingPaths.paths.indexOf('/pairing/session') >= 0 &&
    security.body.credentialMintingPaths.paths.indexOf('/devices') >= 0 &&
    security.body.credentialMintingPaths.paths.indexOf('/characters/publish') >= 0,
    security.body.credentialMintingPaths && security.body.credentialMintingPaths.paths);

  /* ── 授权模型：/economy/* 是**桌面面** ──────────────────────────── */
  check('C19 /economy/* 被归入 isDesktopOnlyPath（与 /memory/ /understanding/ /moments/ 同一类）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');
      return /isDesktopOnlyPath = [^;]*indexOf\('\/economy\/'\) === 0/.test(src);
    })());
  check('C20 /economy/* **不在** loopbackReadableWithoutToken 清单里（不给它任何额外豁免）',
    security.body.loopbackReadableWithoutToken.every(p => p.indexOf('/economy') < 0),
    security.body.loopbackReadableWithoutToken);

  /* 配置了桌面 token 之后：不带 token 的 /economy/* 必须 401，
     而 /health 仍然按既有规则回答（既有行为不变）。 */
  const tokenDir = tmpDir('token');
  const tokened = SERVICE.buildHomeNode({ dataDir: tokenDir, logger: () => { }, token: 'desk-secret' });
  tokened.open();
  const tokenPort = await freePort();
  await new Promise(r => tokened.server.listen(tokenPort, '127.0.0.1', r));
  const noToken = await request(tokenPort, 'GET', '/economy/health');
  const withToken = await request(tokenPort, 'GET', '/economy/health', undefined, { 'x-ib-home-token': 'desk-secret' });
  const healthNoToken = await request(tokenPort, 'GET', '/health');
  check('C21 配置了桌面 token 时，/economy/health 不带 token → 401（与 /list 等桌面路径同款判定）',
    noToken.status === 401 && noToken.body.error === 'unauthenticated', { status: noToken.status, body: noToken.body });
  check('C22 带上正确 token → 200（Economy 不是"配了 token 就永远打不开"的面）', withToken.status === 200);
  check('C23 /health 的既有 loopback 豁免**没有**被 Economy 的加入影响（仍然 200）', healthNoToken.status === 200);

  await new Promise(r => tokened.server.close(r));
  tokened.close();
  await new Promise(r => app.server.close(r));
  app.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · 真实生产子进程（P22-0 明确要求）
   ══════════════════════════════════════════════════════════════════ */
section('D · 真实子进程（spawn services/home-node-service.js，打真实 HTTP）');

async function childProcessGroup() {
  const dir = tmpDir('prod');
  const prod = await startProduction(dir);
  const up = await waitListening(prod, 25000);
  check('D1 生产入口在私有端口 + 私有数据目录上真的起来了', up === true, prod.output());
  if (!up) return;

  try {
    const health = await request(prod.port, 'GET', '/economy/health');
    check('D2 真实生产进程的 GET /economy/health → 200（这一域在真实进程里真的接上了）',
      health.status === 200, { status: health.status, body: health.body, out: health.status === 200 ? null : prod.output() });
    check('D3 真实生产进程的 Economy state 是 READY（不是 501 / COLD / DEGRADED）',
      health.status === 200 && health.body.economy && health.body.economy.state === 'READY',
      health.body && health.body.economy);
    check('D4 真实生产进程的 Economy 库就在它自己的 IB_HOME_NODE_DATA_DIR 下',
      health.status === 200 &&
      path.resolve(health.body.economy.file) === path.resolve(path.join(dir, 'home-node.db')),
      { file: health.body.economy && health.body.economy.file, dir: dir });
    check('D5 启动日志里有 economy-opened（观测面存在，且没有打印任何金额）',
      /economy-opened/.test(prod.output()), prod.output().slice(-800));

    /* 真实进程上的写路径仍然不存在。 */
    const post = await request(prod.port, 'POST', '/economy/purchase', { amountMinor: '1' });
    check('D6 真实进程上 POST /economy/purchase → 405（生产进程里也没有充值/购买入口）',
      post.status === 405 && post.body.error === 'economy-is-read-only', { status: post.status, body: post.body });
    const probe = await request(prod.port, 'POST', '/economy/mint', { amountMinor: '1' });
    check('D7 真实进程上 POST /economy/mint → 405（铸币没有任何 HTTP 入口）', probe.status === 405);

    /* 让真实进程写一笔经济事实：用**生产装配**里那一个 store 实例
       （它是同进程的模块级实例，因为子进程就是这个文件）。
       这里刻意不用 HTTP —— 因为 HTTP 上没有写路径，而那正是要证明的事。
       办法：直接对这个数据目录再开一个 store 不行（会与子进程抢库），
       因此改用**第二个子进程**在启动时自己铸一笔？那也不是生产行为。
       正确做法：生产进程的 store 只能靠它自己的代码路径写，
       而 P22-2 不给它任何外部写入口。因此 D 组的写入验证改为
       "重启后账本与 revision 原样" —— 用 E 组（同进程 store 与
       真实进程共用同一个库文件）来产生事实。 */
    check('D8 生产进程的 /economy/changes 可读且 revision 从 0 起（新库）',
      (await request(prod.port, 'GET', '/economy/changes?cursor=0')).body.revision === 0);

    /* 干净停机：走合作停止面（Windows 上信号路径到不了 store.close）。 */
    await stopProduction(prod);
    check('D9 生产进程干净退出（合作停止面之后进程真的结束了）', !!prod.exited, prod.exited);
    /* 注意：`shutdown` / `stopped` 这两行走的是 log() 的**纯文本**分支
       （`[info] shutdown {...}`），而 http 层的 record() 走 JSON 分支
       （`{"event":"..."}`）。因此这里按它们的真实形状断言，
       而不是套一个统一的 `"event":` 前缀 —— 否则这条断言会因为
       **日志格式差异**失败，而那与"拆除梯子有没有跑完"无关。 */
    check('D10 停机日志里有 shutdown / stopped，且拆除梯子跑完了五步（说明走到了 store.close，而不是被 TerminateProcess 掐掉）',
      /\bshutdown \{/.test(prod.output()) && /\bstopped \{/.test(prod.output()) &&
      /economy-closed/.test(prod.output()) &&
      /"steps":\s*\[\s*"entering",\s*"stopWork",\s*"stopTimers",\s*"closeStores",\s*"report"\s*\]/.test(prod.output()) &&
      /"errors":\s*null/.test(prod.output()),
      prod.output().slice(-600));

    /* ── E · 重启同一个库：经济事实原样 ────────────────────────────
       在两次启动之间，用**直接 store**（同一个库文件、同一个 schema）
       写入一笔事实。这不是"冒充生产验证"：D 组已经用真实 HTTP 证明了
       生产进程打开并服务 Economy；本组要证的是**持久性** ——
       重启后生产进程读到的就是刚才那份账本。 */
    const direct = SERVICE.economyAssembly({ dataDir: dir, logger: () => { } }).economyStore;
    direct.open();
    check('E1 直接打开同一个库：schema 与生产进程一致（同一个 schema 水位，不是第二套）',
      Number(direct.health().schemaVersion) === direct.SCHEMA_VERSION);
    const w = direct.openWallet({ owner: { type: 'user', id: 'user' }, currency: 'IB_CREDIT' });
    check('E2 在重启前写入一个钱包（user owner 不需要角色目录）', w.ok === true, w.errors || '');
    const mintArgs = {
      systemInitiated: true, walletId: w.wallet.walletId, currency: 'IB_CREDIT',
      amountMinor: 777, idempotencyKey: 'prod-restart-key'
    };
    const mint = direct.mintForSystem(mintArgs);
    check('E3 铸币一笔（777）', mint.ok === true, mint.errors || '');
    const revisionBefore = direct.getRevision();
    direct.close();

    /* 重启生产进程，指向同一个数据目录。 */
    const prod2 = await startProduction(dir);
    const up2 = await waitListening(prod2, 25000);
    check('E4 生产进程用**同一个库**重启成功', up2 === true, prod2.output());
    if (!up2) return;
    try {
      const health2 = await request(prod2.port, 'GET', '/economy/health');
      check('E5 重启后 state 仍是 READY，revision 从原值继续（不回退、不复用）',
        health2.status === 200 && health2.body.economy.state === 'READY' &&
        Number(health2.body.economy.revision) === revisionBefore,
        { after: health2.body.economy && health2.body.economy.revision, before: revisionBefore });
      const wallet2 = await request(prod2.port, 'GET', '/economy/wallet?ownerId=user&currency=IB_CREDIT');
      check('E6 重启后同一个钱包的余额**逐字相同**（777），且它是从 ledger 重建的',
        wallet2.status === 200 && wallet2.body.wallet.availableBalanceMinor === '777',
        wallet2.status === 200 ? wallet2.body.wallet : wallet2.body);
      const rebuilt2 = await request(prod2.port, 'GET', '/economy/wallet?ownerId=user&currency=IB_CREDIT&rebuild=1');
      check('E7 重启后 ?rebuild=1 报告没有漂移（持久化的是 ledger，不是那份派生缓存）',
        rebuilt2.status === 200 && rebuilt2.body.wallet.availableBalanceMinor === '777');
      const tx2 = await request(prod2.port, 'GET', '/economy/transaction?transactionId=' + mint.transactionId);
      check('E8 重启后那笔 transaction 与它的两笔 entry 都还在（ledger 是持久的）',
        tx2.status === 200 && tx2.body.entries.length === 2 && tx2.body.transaction.state === 'COMMITTED');
      const changes2 = await request(prod2.port, 'GET', '/economy/changes?cursor=0');
      check('E9 重启后 change log 逐条还在，revision 序列没有断',
        changes2.status === 200 && Number(changes2.body.revision) === revisionBefore &&
        changes2.body.changes.every((c, i) => c.revision === i + 1),
        changes2.body.changes.map(c => c.revision));
      check('E10 重启后 GET /economy/health 的 counts 与写入时一致（wallet 1 / tx 1 / entries 2）',
        Number(health2.body.economy.counts.wallets) === 1 &&
        Number(health2.body.economy.counts.transactions) === 1 &&
        Number(health2.body.economy.counts.entries) === 2,
        health2.body.economy.counts);
    } finally {
      await stopProduction(prod2);
      check('E11 第二个生产进程也干净退出', !!prod2.exited, prod2.exited);
    }

    /* ── F · 幂等**跨进程重启** ───────────────────────────────────
       这一段是本阶段最核心的一条：同一个 idempotencyKey 在两个不同的
       **进程**里提交，不能造成第二次经济 mutation。
       做法：重启之前用直接 store 提交 key，重启之后用同一个库再提交
       同一个 key（同一个业务），断言 replayed=true 且行数不变。 */
    const direct2 = SERVICE.economyAssembly({ dataDir: dir, logger: () => { } }).economyStore;
    direct2.open();
    const countsBefore = direct2.health().counts;
    const replay = direct2.mintForSystem(mintArgs);
    check('F1 **跨进程重启**重放同一个 idempotencyKey → replayed=true，返回原来那笔 transaction',
      replay.ok === true && replay.replayed === true && replay.transactionId === mint.transactionId,
      { ok: replay.ok, replayed: replay.replayed, got: replay.transactionId, want: mint.transactionId });
    check('F2 跨重启重放之后行数与 revision 都没有变（没有第二次 mutation）',
      JSON.stringify(direct2.health().counts) === JSON.stringify(countsBefore) &&
      direct2.getRevision() === revisionBefore,
      { after: direct2.health().counts, before: countsBefore, revision: direct2.getRevision() });
    check('F3 跨重启重放之后余额仍然是 777（不是 1554）',
      direct2.ledgerBalanceOf(w.wallet.walletId).balanceMinor === '777',
      direct2.ledgerBalanceOf(w.wallet.walletId).balanceMinor);
    const conflict = direct2.mintForSystem(Object.assign({}, mintArgs, { amountMinor: 888 }));
    check('F4 跨重启时同一个 key 换金额 → IDEMPOTENCY_CONFLICT（幂等记录是持久的，不是内存里的）',
      conflict.ok === false && conflict.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0, conflict.errors);
    direct2.close();
  } catch (error) {
    failures++;
    console.error('✖ D/E/F 组异常 — ' + String(error && error.stack || error));
    console.error('  进程输出: ' + prod.output());
  } finally {
    await stopProduction(prod);
  }
}

/* ══════════════════════════════════════════════════════════════════
   G · 未接线时的诚实回答（501，而不是 404）
   ══════════════════════════════════════════════════════════════════ */
section('G · 装配缺口必须说自己"没接线"，而不是伪装成"没这个路径"');

async function unassembledGroup() {
  /* 手工造一个不传 economyStore 的 http 层 —— 这正是装配漏接时的形状。 */
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
  const r = await request(port, 'GET', '/economy/health');
  check('G1 装配没接 Economy 时，/economy/health → 501 economy-not-assembled（不是 404，也不是 200+空对象）',
    r.status === 501 && r.body.error === 'economy-not-assembled', { status: r.status, body: r.body });
  const wallet = await request(port, 'GET', '/economy/wallet?ownerId=user&currency=IB_CREDIT');
  check('G2 装配没接时的钱包读同样是 501（缺接线在所有只读路由上一致地可见）',
    wallet.status === 501 && wallet.body.error === 'economy-not-assembled');
  await new Promise(res => layer.server.close(res));
  chat.close();
}

(async () => {
  await httpGroup();
  await unassembledGroup();
  await childProcessGroup();

  console.log('\n' + '═'.repeat(64));
  if (failures === 0) {
    console.log('P22-2 runtime: 全部通过 ✔');
    process.exitCode = 0;
  } else {
    console.error('P22-2 runtime: ' + failures + ' 项失败 ✘');
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})().catch(error => {
  console.error('P22-2 runtime: 未捕获异常 — ' + String(error && error.stack || error));
  process.exit(1);
});
