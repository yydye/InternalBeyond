'use strict';
/* ====================================================================
   P22-23 · Economy First-Run / Home Node Provisioning Closure
   --------------------------------------------------------------------
   运行：node tests/test_p22_23_home_node_provisioning.js

   ★ 这一份测试要证明的是**运行时性质**，不是文案。它真实 spawn
     services/home-node-service.js（私有端口 + 私有数据目录），打真实 HTTP。

   覆盖 §9 的六组：
     A · fresh-install simulation —— 无凭据、无 wallet；凭据自动 provision；
         canonical 客户端被接受；配置 seam 可用；wallet **仍未**自动创建；
         用户 bootstrap 之后 wallet 出现
     B · restart —— 不破坏访问、不重复 bootstrap、balance 不变
     C · credential corruption —— mismatch 时 fail closed、不执行 Economy mutation
     D · missing Home Node —— 不被误报成"请配置 token"
     E · security —— secret 不出现在 DOM / console / URL / localStorage /
         diagnostics / logs / exported state
     F · source-level —— 唯一 authority、唯一生成点、无硬编码默认 token

   ★ 进程纪律：每个 spawn 的子进程都记在 children 里，finally 里逐个 kill；
     临时目录用 dropDir 尽力删除（Windows 句柄可能让它失败，那不是测试失败）。
   ==================================================================== */
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = path.join('services', 'home-node-service.js');
const CRED_FILE_NAME = 'desktop-credential.json';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

const children = new Set();
const dirs = [];
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p2223-' + tag + '-'));
  dirs.push(d);
  return d;
}
function dropDir(d) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* Windows 句柄 */ }
}
function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.unref();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* 起一个真实的 Home Node。
   `env` 是**额外**注入；默认刻意**不设** IB_HOME_NODE_TOKEN —— 那正是
   "正常桌面启动"的环境。`autoprovision` 为 undefined 时用产品默认（开）。 */
function startNode(opts) {
  const o = opts || {};
  return freePort().then(port => new Promise(resolve => {
    /* ★ 顺序是刻意的，而且曾经写错过一次：先把继承来的两个键**擦掉**，
       再把调用方显式给的那份覆盖上去。反过来写（先覆盖再删）会把调用方
       的 env 覆盖直接删掉 —— 症状是"显式设了 token 却拿到 401"，一个看
       起来像产品缺陷、其实是测试自己吞掉参数的故障。 */
    const env = Object.assign({}, process.env, {
      IB_HOME_NODE_PORT: String(port),
      IB_HOME_NODE_DATA_DIR: o.dataDir,
      IB_HOME_NODE_HOST: '127.0.0.1'
    });
    delete env.IB_HOME_NODE_TOKEN;
    delete env.IB_HOME_NODE_TOKEN_AUTOPROVISION;
    /* autoprovision 以调用方显式给的 env 为准；只有没给时才用开关决定。
       ★ 父进程可能是带 IB_HOME_NODE_TOKEN_AUTOPROVISION=0 跑的（测试运行器
         就是这样），因此"没给"时的默认必须是**产品默认（开）**，否则这条
         套件会静默地继承运行器的隔离姿态。 */
    if ((o.env || {}).IB_HOME_NODE_TOKEN_AUTOPROVISION === undefined) {
      env.IB_HOME_NODE_TOKEN_AUTOPROVISION = o.autoprovision === false ? '0' : '1';
    }
    Object.assign(env, o.env || {});
    const child = spawn(process.execPath, [SERVICE], {
      cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    children.add(child);
    const svc = { port: port, child: child, out: '', dataDir: o.dataDir };
    svc.output = () => svc.out.slice(-1200);
    child.stdout.on('data', c => { svc.out += String(c); });
    child.stderr.on('data', c => { svc.out += String(c); });
    child.on('exit', () => children.delete(child));
    resolve(svc);
  }));
}
function request(port, method, urlPath, body, headers) {
  return new Promise(resolve => {
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: method, headers: h, timeout: 8000 }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: parsed, raw: raw, headersObj: res.headers });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: null, raw: '', headersObj: {}, error: 'timeout' }); });
    r.on('error', e => resolve({ status: 0, body: null, raw: '', headersObj: {}, error: String(e.code || e.message) }));
    if (data) r.write(data);
    r.end();
  });
}
async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await request(port, 'GET', '/health');
    if (r.status === 200 && r.body && r.body.ok === true) return true;
    await sleep(200);
  }
  return false;
}
async function stopNode(svc) {
  if (!svc) return;
  try { svc.child.kill(); } catch (_) { /* 已退出 */ }
  const deadline = Date.now() + 4000;
  while (children.has(svc.child) && Date.now() < deadline) await sleep(100);
  try { svc.child.kill('SIGKILL'); } catch (_) { /* 已经没了 */ }
}
function readCredentialFile(dataDir) {
  const file = path.join(dataDir, CRED_FILE_NAME);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { __unparsable: true }; }
}
function fingerprintOf(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex').slice(0, 12);
}
/* 唯一的正规取凭据方式：loopback Origin + 交付头。 */
function handshake(port, origin) {
  return request(port, 'POST', '/internal/desktop-credential', {},
    { 'X-IB-Bootstrap': '1', 'Origin': origin === undefined ? 'http://127.0.0.1:23120' : origin });
}
const readFile = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* 源码不变量在 E / F 两节里都要用，因此在这里读一次。 */
const CLIENT_JS = path.join('assets', 'js', 'home-node-client.js');
const HTTP_JS = path.join('services', 'home-node', 'http.js');
const UI_JS = path.join('assets', 'js', 'economy-configuration.js');

/* ══════════════════════════════════════════════════════════════════ */
console.log('P22-23 · Economy first-run / Home Node provisioning closure');

(async () => {
  let svc = null;
  try {
    /* ══ A · fresh-install simulation ══ */
    section('A · fresh install（无凭据、无 wallet、正常启动）');
    const dirA = tmpDir('fresh');
    check('A0 起点真的是空的：数据目录里没有任何凭据文件（这就是"从没被创造过"的样子）',
      readCredentialFile(dirA) === null, fs.readdirSync(dirA));

    svc = await startNode({ dataDir: dirA });
    const upA = await waitHealth(svc.port, 20000);
    check('A1 生产入口起来了（真实 spawn services/home-node-service.js）', upA, svc.output());
    if (!upA) throw new Error('service did not start');

    const credA = readCredentialFile(dirA);
    check('A2 ★★★★★ 凭据被**自动创造**出来了 —— 这就是本阶段修掉的那个缺陷',
      !!credA && typeof credA.token === 'string' && credA.token.length >= 32,
      credA ? { schema: credA.schema, length: String(credA.token || '').length } : null);
    check('A2b 凭据是 cryptographically secure random（base64url、长度 = 32 字节）',
      !!credA && /^[A-Za-z0-9_-]{43}$/.test(String(credA.token || '')),
      credA && String(credA.token || '').length);

    /* A3 · 交付面：四种准入。 */
    const foreign = await handshake(svc.port, 'http://evil.example');
    check('A3 ★★★★ 命名外来 Origin 取不到凭据（403 origin-denied —— 恶意网页的第一个死法）',
      foreign.status === 403 && String(foreign.body && foreign.body.error) === 'origin-denied',
      { status: foreign.status, error: foreign.body && foreign.body.error });

    const nullOrigin = await handshake(svc.port, 'null');
    check('A3b ★★★★ `Origin: null`（file:// / 沙箱 iframe）取不到凭据（第二个死法）',
      nullOrigin.status === 403 && String(nullOrigin.body && nullOrigin.body.error) === 'origin-not-loopback',
      { status: nullOrigin.status, error: nullOrigin.body && nullOrigin.body.error });

    const noOrigin = await handshake(svc.port, '');
    check('A3c ★★★★ 没有 Origin 的请求取不到凭据（本地脚本不该从这条面拿东西）',
      noOrigin.status === 403 && String(noOrigin.body && noOrigin.body.error) === 'origin-not-loopback',
      { status: noOrigin.status, error: noOrigin.body && noOrigin.body.error });

    const noHeader = await request(svc.port, 'POST', '/internal/desktop-credential', {}, { 'Origin': 'http://127.0.0.1:23120' });
    check('A3d 缺少 X-IB-Bootstrap 头 → 400（把这条请求挡在 CORS 简单请求集合之外）',
      noHeader.status === 400 && String(noHeader.body && noHeader.body.error) === 'bootstrap-header-required',
      { status: noHeader.status, error: noHeader.body && noHeader.body.error });

    /* ★ 预检：浏览器会先问"我能不能带 X-IB-Bootstrap 这个头"。
       答错的后果不是 4xx，而是**请求根本不到服务端**（页面侧只看到
       `TypeError: Failed to fetch`），因此这一条必须单独验，而且要在真实
       浏览器里也验一次（test_p22_23_first_run_acceptance.js）。 */
    const preflight = await request(svc.port, 'OPTIONS', '/internal/desktop-credential', null, {
      'Origin': 'http://127.0.0.1:23120',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'x-ib-bootstrap,x-ib-protocol,content-type'
    });
    const allowed = await request(svc.port, 'OPTIONS', '/internal/desktop-credential', null, {
      'Origin': 'http://127.0.0.1:23120'
    });
    check('A3e ★★★★★ 预检允许 X-IB-Bootstrap（否则浏览器在网络层就拦掉交付请求，服务端日志里什么都看不到）',
      preflight.status === 204 &&
      /x-ib-bootstrap/i.test(String(preflight.headersObj && preflight.headersObj['access-control-allow-headers'] || '')),
      { status: preflight.status, allow: preflight.headersObj && preflight.headersObj['access-control-allow-headers'] });
    check('A3f ★★★★ 预检仍然**只**对 loopback Origin 回显（恶意来源拿不到任何放行）',
      allowed.status === 204 &&
      allowed.headersObj && allowed.headersObj['access-control-allow-origin'] === 'http://127.0.0.1:23120', null);
    const preflightForeign = await request(svc.port, 'OPTIONS', '/internal/desktop-credential', null, {
      'Origin': 'http://evil.example',
      'Access-Control-Request-Method': 'POST'
    });
    check('A3g 外来 Origin 的预检**不**回显任何放行头',
      preflightForeign.status === 204 && !preflightForeign.headersObj['access-control-allow-origin'],
      preflightForeign.headersObj);

    const good = await handshake(svc.port);
    const token = good.body && good.body.credential;
    check('A4 ★★★★★ 桌面页面（loopback Origin）拿到了凭据，而且它与磁盘上那份**是同一份**',
      good.status === 200 && typeof token === 'string' && fingerprintOf(token) === fingerprintOf(credA && credA.token),
      { status: good.status, source: good.body && good.body.source, matchesFile: typeof token === 'string' && fingerprintOf(token) === fingerprintOf(credA && credA.token) });

    /* A5 · 交付面可以重复调用（刷新页面必须还能取到）。 */
    const again = await handshake(svc.port);
    check('A4b 交付面**可以**重复调用：刷新页面之后必须还能取到（否则刷新 = 永久 401）',
      again.status === 200 && fingerprintOf(again.body && again.body.credential) === fingerprintOf(token),
      { status: again.status });

    const auth = { 'X-IB-Home-Token': token };

    /* A6 · 无凭据的读面必须 fail closed（不是"匿名可读"）。 */
    const anonSecurity = await request(svc.port, 'GET', '/security');
    const anonEconomy = await request(svc.port, 'GET', '/economy/health');
    check('A5 ★★★★ 凭据一配好，桌面面就不再匿名可读（/security 与 /economy/* 都 401）',
      anonSecurity.status === 401 && anonEconomy.status === 401,
      { security: anonSecurity.status, economy: anonEconomy.status });

    /* A7 · canonical 客户端被接受，配置 seam 可用。 */
    const security = await request(svc.port, 'GET', '/security', null, auth);
    const secBody = security.body || {};
    check('A6 ★★★★★ 拿到凭据的 canonical 客户端被接受，且配置 seam 是**开**的',
      security.status === 200 &&
      secBody.tokenRequired === true &&
      secBody.credentialSource === 'generated' &&
      secBody.credentialConfigured === true &&
      secBody.economyPolicy && secBody.economyPolicy.configuration &&
      secBody.economyPolicy.configuration.open === true,
      { status: security.status, tokenRequired: secBody.tokenRequired, source: secBody.credentialSource,
        open: secBody.economyPolicy && secBody.economyPolicy.configuration && secBody.economyPolicy.configuration.open });

    check('A6b /security 只自述"来源/是否配置"，**绝不**回显凭据本体',
      JSON.stringify(secBody).indexOf(token) < 0 &&
      secBody.bootstrap && secBody.bootstrap.available === true,
      { bootstrap: secBody.bootstrap });

    /* A8 · wallet **仍未**自动创建（§7：系统不自动发钱）。 */
    const registered = await request(svc.port, 'POST', '/characters/publish',
      { characters: [{ id: 'p2223_owner', name: 'P22-23 Owner' }], merge: true }, auth);
    check('A7 owner 登记走既有的 canonical identity 路径（/characters/publish 现在有凭据可用）',
      registered.status === 200 && registered.body && registered.body.ok === true,
      { status: registered.status });

    const walletBefore = await request(svc.port, 'GET', '/economy/wallet?ownerId=p2223_owner&currency=IB_CREDIT', null, auth);
    check('A8 ★★★★★ 凭据自动 provision **没有**顺手创建 wallet（系统不自动发钱 —— 这两件事必须分开）',
      walletBefore.status === 404 && String(walletBefore.body && walletBefore.body.error || '').indexOf('wallet') >= 0,
      { status: walletBefore.status, error: walletBefore.body && walletBefore.body.error });

    const bogus = await request(svc.port, 'POST', '/internal/economy/configuration',
      { command: 'BOOTSTRAP_CREDIT', config: { ownerId: 'p2223_owner', currency: 'IB_CREDIT', amountMinor: 2500 }, idempotencyKey: 'p2223-a1' },
      { 'X-IB-Home-Token': 'wrong-credential-0123456789' });
    check('A9 ★★★★ 错误凭据 → 401，且**没有**执行任何 Economy mutation（reachedStore 不存在于成功路径）',
      bogus.status === 401 && !(bogus.body && bogus.body.creditMinted === true),
      { status: bogus.status, creditMinted: bogus.body && bogus.body.creditMinted });

    /* A10 · 用户显式提交之后 wallet 才出现。 */
    const boot = await request(svc.port, 'POST', '/internal/economy/configuration',
      { command: 'BOOTSTRAP_CREDIT', config: { ownerId: 'p2223_owner', currency: 'IB_CREDIT', amountMinor: 2500 }, idempotencyKey: 'p2223-a2' },
      auth);
    check('A10 ★★★★★ 用户提交 canonical configuration 之后，初始额度**才**被铸出（creditMinted:true）',
      boot.status === 200 && boot.body && boot.body.ok === true && boot.body.creditMinted === true,
      { status: boot.status, reasonCode: boot.body && boot.body.reasonCode, errors: boot.body && boot.body.errors });

    const walletAfter = await request(svc.port, 'GET', '/economy/wallet?ownerId=p2223_owner&currency=IB_CREDIT', null, auth);
    const afterBody = (walletAfter.body && walletAfter.body.wallet) || {};
    check('A11 ★★★★★ wallet 出现了并且是 READY（这就是 §5 那条产品目标链的终点）',
      walletAfter.status === 200 && afterBody.state === 'READY',
      { status: walletAfter.status, state: afterBody.state, balance: afterBody.cachedBalanceMinor });
    const balanceA = String(afterBody.cachedBalanceMinor);

    /* ══ B · restart ══ */
    section('B · restart（已有凭据 + wallet）');
    await stopNode(svc);
    svc = null;
    const credBeforeRestart = readCredentialFile(dirA);
    svc = await startNode({ dataDir: dirA });
    const upB = await waitHealth(svc.port, 20000);
    check('B1 重启后进程照常起来', upB, svc.output());
    if (!upB) throw new Error('restart failed');

    const credAfterRestart = readCredentialFile(dirA);
    check('B2 ★★★★★ 重启**不换**凭据（同一份指纹 —— 否则"重启后页面还活着"就会变成永久 401）',
      fingerprintOf(credBeforeRestart && credBeforeRestart.token) === fingerprintOf(credAfterRestart && credAfterRestart.token),
      { before: fingerprintOf(credBeforeRestart && credBeforeRestart.token), after: fingerprintOf(credAfterRestart && credAfterRestart.token) });

    const authB = { 'X-IB-Home-Token': credAfterRestart.token };
    const bootAgain = await request(svc.port, 'POST', '/internal/economy/configuration',
      { command: 'BOOTSTRAP_CREDIT', config: { ownerId: 'p2223_owner', currency: 'IB_CREDIT', amountMinor: 2500 }, idempotencyKey: 'p2223-b1' },
      authB);
    check('B3 ★★★★★ 重启后重放同一条 bootstrap：权威回答"已经发过了"，**没有**第二次铸币',
      bootAgain.status === 200 && bootAgain.body && bootAgain.body.creditMinted === false,
      { status: bootAgain.status, creditMinted: bootAgain.body && bootAgain.body.creditMinted, reasonCode: bootAgain.body && bootAgain.body.reasonCode });

    const walletAfterRestart = await request(svc.port, 'GET', '/economy/wallet?ownerId=p2223_owner&currency=IB_CREDIT', null, authB);
    const rBody = (walletAfterRestart.body && walletAfterRestart.body.wallet) || {};
    check('B4 ★★★★★ 重启后 wallet 还在、balance 一个字都没变',
      walletAfterRestart.status === 200 && rBody.state === 'READY' && String(rBody.cachedBalanceMinor) === balanceA,
      { state: rBody.state, before: balanceA, after: rBody.cachedBalanceMinor });

    /* ══ C · credential mismatch ══ */
    section('C · credential mismatch（客户端/服务端凭据不一致）');
    const mismatch = await request(svc.port, 'POST', '/internal/economy/configuration',
      { command: 'BOOTSTRAP_CREDIT', config: { ownerId: 'p2223_owner', currency: 'IB_CREDIT', amountMinor: 999999 }, idempotencyKey: 'p2223-c1' },
      { 'X-IB-Home-Token': 'a-different-but-well-formed-credential' });
    check('C1 ★★★★★ mismatch → 401（凭据判定在 seam 之前 fail closed）',
      mismatch.status === 401, { status: mismatch.status, error: mismatch.body && mismatch.body.error });

    const afterMismatch = await request(svc.port, 'GET', '/economy/wallet?ownerId=p2223_owner&currency=IB_CREDIT', null, authB);
    check('C2 ★★★★★ mismatch 之后 balance 与 wallet 状态**没有任何变化**（没有执行 mutation）',
      afterMismatch.status === 200 &&
      String((afterMismatch.body.wallet || {}).cachedBalanceMinor) === balanceA, {
      before: balanceA, after: (afterMismatch.body.wallet || {}).cachedBalanceMinor });

    /* ══ D · missing Home Node ══ */
    section('D · Home Node 不在跑（不是"凭据没配"）');
    await stopNode(svc);
    svc = null;
    /* 这里刻意用一个**没人监听**的端口：这正是"Home Node 没起来"的形状。 */
    const deadPort = await freePort();
    const dead = await request(deadPort, 'GET', '/security');
    check('D1 ★★★★ 端口没人听时是**传输失败**，不是"凭据没配置"的 401/403',
      dead.status === 0 && dead.error !== undefined,
      { status: dead.status, error: dead.error });

    /* 诊断必须可区分：这两种情况在浏览器侧的凭据状态里是两个不同的码。 */
    const clientSrc = readFile(CLIENT_JS);
    check('D2 ★★★★ 客户端把"取不到凭据"与"连不上"分成**两个**不同的码（否则 UI 只能给出同一句话）',
      clientSrc.indexOf("'home-node-credential-unavailable'") >= 0 &&
      clientSrc.indexOf('classified.code') >= 0 &&
      /retryable/.test(clientSrc),
      null);

    /* ══ E · security ══ */
    section('E · secret 不得出现在 DOM / console / URL / localStorage / 日志里');
    const dirE = tmpDir('logs');
    const svcE = await startNode({ dataDir: dirE });
    const upE = await waitHealth(svcE.port, 20000);
    const credE = readCredentialFile(dirE);
    /* 让交付面也被走一次 —— 交付路径的日志同样不得含凭据。 */
    const handedE = await handshake(svcE.port);
    /* 用凭据打一次真实的 /security，再检查响应里有没有回显。 */
    const authE = { 'X-IB-Home-Token': (credE && credE.token) || 'none' };
    const secE = await request(svcE.port, 'GET', '/security', null, authE);
    const logE = String(svcE.out);
    await stopNode(svcE);

    check('E1 ★★★★★ 凭据本体不出现在服务 stdout/stderr 里（redact 纪律仍然承重）',
      upE && credE && logE.indexOf(credE.token) < 0,
      { up: upE, logBytes: logE.length });
    check('E2 启动日志里出现了来源与指纹（可诊断，且不含秘密）',
      logE.indexOf('credentialSource') >= 0 && logE.indexOf('credentialFingerprint') >= 0, null);
    check('E3 ★★★★★ 交付响应本身**只有** credential / source / deliveredAt 三个键（不回显别的）',
      handedE.status === 200 && handedE.body &&
      Object.keys(handedE.body).sort().join(',') === 'credential,deliveredAt,ok,protocolVersion,serverTime,source',
      handedE.body && Object.keys(handedE.body));
    check('E4 ★★★★★ /security 的响应体里**不含**凭据本体（自述面不是凭据面）',
      secE.status === 200 && secE.raw.indexOf(credE.token) < 0,
      { status: secE.status });
    check('E5 凭据不出现在任何 URL 里（交付是一条 POST，没有 query 参数）',
      readFile(HTTP_JS).indexOf('desktop-credential?') < 0 &&
      readFile(HTTP_JS).indexOf('searchParams.set') < 0, null);
    check('E6 ★★★★★ 浏览器侧不把凭据写进任何持久存储（localStorage / sessionStorage 都没有）',
      !/setItem\(\s*['"]ib_home_node_token['"]/.test(clientSrc) &&
      !/sessionStorage\.setItem/.test(clientSrc) &&
      clientSrc.indexOf('_sessionToken') >= 0, null);
    check('E7 Economy UI 的渲染器里没有凭据头、也没有凭据键（渲染器不持有凭据）',
      readFile(path.join('assets', 'js', 'economy-configuration.js')).indexOf('X-IB-Home-Token') < 0 &&
      readFile(path.join('assets', 'js', 'economy-configuration.js')).indexOf('ib_home_node_token') < 0, null);

    /* ══ F · source-level invariants ══ */
    section('F · 源码不变量：唯一 authority / 唯一生成点 / 无硬编码默认值');
    const authority = readFile(path.join('services', 'home-node', 'desktop-credential.js'));
    /* 这个模块里 crypto.randomBytes 出现**两**次，而且两处的角色完全不同，
       因此断言必须分开写，而不是数一个总数就下结论：
         · 一处生成**凭据本体**（SECRET_BYTES = 32）；
         · 一处只给原子写的临时文件名加随机后缀（防止两个进程撞临时文件）。
       把这两处混成一个计数，会让"有人加了第三条生成路径"和"临时名改了一下"
       看起来一模一样 —— 那样这条断言就不再承重了。 */
    check('F1 ★★★★★ 凭据本体只有一个生成点：`crypto.randomBytes(SECRET_BYTES)` 全仓恰好一处',
      (authority.match(/crypto\.randomBytes\(SECRET_BYTES\)/g) || []).length === 1 &&
      (authority.match(/SECRET_BYTES\s*=\s*32\b/g) || []).length === 1,
      { genCalls: (authority.match(/crypto\.randomBytes\(SECRET_BYTES\)/g) || []).length });
    check('F1b 另一处 randomBytes 只用于临时文件名后缀（不是第二条凭据路径）',
      (authority.match(/crypto\.randomBytes\(/g) || []).length === 2 &&
      authority.indexOf("'.tmp'") >= 0,
      (authority.match(/crypto\.randomBytes\(/g) || []).length);
    check('F2 ★★★★★ 没有任何硬编码的默认 token 常量（不许有 fallback secret）',
      !/(?:DEFAULT|FALLBACK)_TOKEN\s*=/.test(authority) &&
      !/=\s*'[A-Za-z0-9_-]{20,}'\s*;\s*\/\*\s*token/i.test(authority),
      null);
    /* 数 env 读取时必须**先去注释**：`IB_HOME_NODE_TOKEN` 在解释性注释里出现
       是好事（那正是"为什么这样设计"的答案），把注释算进去会让这条断言
       变成"谁写了文档谁挨罚"。 */
    const serviceCode = readFile(SERVICE).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('F3 服务端只在**一处**解析桌面凭据（其他可执行代码不得再读 env）',
      (serviceCode.match(/IB_HOME_NODE_TOKEN\b/g) || []).length === 1,
      (serviceCode.match(/IB_HOME_NODE_TOKEN\b/g) || []).length);

    const httpSrc = readFile(HTTP_JS);
    check('F4 ★★★★ 交付路径与请求头各只有一处字面量（契约常量），客户端与服务端逐字一致',
      (httpSrc.match(/'\/internal\/desktop-credential'/g) || []).length === 1 &&
      clientSrc.indexOf("'/internal/desktop-credential'") >= 0 &&
      clientSrc.indexOf("'X-IB-Bootstrap'") >= 0,
      null);

    const visualSrc = readFile(UI_JS);
    check('F6 ★★★★ Economy UI 里没有把凭据写进 DOM 的路径（渲染器不持有凭据）',
      visualSrc.indexOf('X-IB-Home-Token') < 0 &&
      visualSrc.indexOf('ib_home_node_token') < 0,
      null);

    /* ══ G · env 覆盖仍然是既有语义 ══ */
    section('G · env / headless override 语义未变');
    const dirG = tmpDir('env');
    const svcG = await startNode({ dataDir: dirG, env: { IB_HOME_NODE_TOKEN: 'p22-23-env-override-credential' } });
    const upG = await waitHealth(svcG.port, 20000);
    const secG = await request(svcG.port, 'GET', '/security', null, { 'X-IB-Home-Token': 'p22-23-env-override-credential' });
    const bootstrapG = await handshake(svcG.port);
    await stopNode(svcG);
    check('G1 ★★★★ 显式 env 覆盖照常生效（developer / headless / 测试的旋钮一个字没改）',
      upG && secG.status === 200 && secG.body.credentialSource === 'env',
      { status: secG.status, source: secG.body && secG.body.credentialSource });
    check('G2 ★★★★★ env 部署下**整面关闭**交付面：部署方已经决定了凭据，浏览器不该再取一份',
      bootstrapG.status === 503 && String(bootstrapG.body && bootstrapG.body.reason) === 'credential-supplied-by-deployment',
      { status: bootstrapG.status, reason: bootstrapG.body && bootstrapG.body.reason });
    check('G3 env 覆盖时**不**在数据目录里另造一份凭据文件',
      readCredentialFile(dirG) === null, fs.readdirSync(dirG));

    const dirH = tmpDir('off');
    const svcH = await startNode({ dataDir: dirH, autoprovision: false });
    const upH = await waitHealth(svcH.port, 20000);
    const secH = await request(svcH.port, 'GET', '/security');
    const bootstrapH = await handshake(svcH.port);
    await stopNode(svcH);
    check('G4 显式关掉自动 provisioning ⇒ 回到"未配置凭据"的既有形态（匿名读面可用、交付面关闭）',
      upH && secH.status === 200 && secH.body.credentialConfigured === false &&
      bootstrapH.status === 503 && String(bootstrapH.body.reason) === 'no-desktop-credential',
      { security: secH.status, configured: secH.body && secH.body.credentialConfigured, bootstrap: bootstrapH.status });
    check('G5 关掉时数据目录里**一份凭据都不读也不写**（否则"关掉"就不是一个可用来隔离的开关）',
      readCredentialFile(dirH) === null, fs.readdirSync(dirH));
  } catch (error) {
    failed++;
    console.error('P22-23 未捕获异常 — ' + String((error && error.stack) || error));
  } finally {
    for (const c of Array.from(children)) {
      try { c.kill(); } catch (_) { /* 已退出 */ }
      try { c.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
    }
    await sleep(300);
    for (const d of dirs) dropDir(d);
  }

  console.log('\n' + '─'.repeat(72));
  console.log('P22-23 provisioning：' + passed + ' 通过, ' + failed + ' 失败');
  console.log('子进程残留：' + children.size + ' 个 · 临时目录：' + dirs.length + ' 个（已尽力清理）');
  process.exit(failed === 0 ? 0 : 1);
})();
