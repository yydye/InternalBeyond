'use strict';
/* ====================================================================
   P22-11 · Active → Home Node Economy Command Channel（**两个真实进程**）
   --------------------------------------------------------------------
   运行：node tests/test_p22_11_economy_active_bridge.js

   ── 这个文件证明的**只有一件事**，而且它不能由单进程证明 ─────────────
   "23114 上的 Active 真的能跨进程提出一条 Economy Purchase Intent，
   而这条路径的每一个不变量在真实的进程边界上仍然成立。"
   其它不变量（认证、来源、信封、幂等、超时）都在
   test_p22_11_economy_command_channel.js 里用**单进程真实 HTTP** 证明过了
   （§12：能单进程证明的禁止 spawn），本文件不重复它们。

   ── §12 的进程账 ────────────────────────────────────────────────────
   max concurrent child = 2（Home Node + Active）· total spawn = 2 ·
   leftover = 0。没有第三个 child，没有 worker pool，没有 Desktop /
   Electron / 浏览器 / Playwright / DSH。
   ★ 两个 child 都只加载**最小依赖闭包**：
       · home-node-service.js          —— 真实生产启动路径（23118）
       · tests/fixtures/p22-11-active-process.js —— require 真实
         services/active-message-service.js（23114 的装配根），只多一个
         **测试入口路由**把"模型输出"递进去。
   ★ 一对 fixture 的生命周期里跑完全部用例，然后 cleanup —— 不是每个
     case 重新 spawn。

   ── 为什么这里必须真的开两个进程 ────────────────────────────────────
   本阶段第一次出现"进程边界"这件事：来源身份由**谁**发起决定，而
   "两个不同的 Node 进程"正是那条事实的载体。单进程里的两个 socket
   证明不了"23114 这个进程能把话送到 23118"。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const CHANNEL = require(path.join(ROOT, 'services', 'home-node', 'economy-command-channel.js'));

/* 生产解释器 = 内置 runtime/node/node.exe（与 runtime/local-services-runner.js
   逐字相同）。缺失时退回 process.execPath 并如实说明。 */
const BUNDLED_NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const NODE_BIN = fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('\u2714 ' + name);
  else {
    failures++;
    console.error('\u2716 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra, replacer) : ''));
  }
}
function section(title) { console.log('\n\u2500\u2500 ' + title); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

/* 来源身份的唯一合法答案：P22-9 契约里那个有运行时锚点的消费者。
   （消费侧看不到对方的 consumer 字段名，因此这里读的是响应里的 source。） */
function proveSource(source) {
  return source === C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME;
}

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-11b-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}),
      timeout: 12000
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

/* ── §12 的进程账：这一份是**被测**的事实，不是一句声明 ───────────── */
const spawned = [];
let concurrentNow = 0;
let maxConcurrent = 0;
let totalSpawn = 0;
process.on('exit', () => {
  for (const svc of spawned) { try { svc.child.kill(); } catch (_) { /* 已退出 */ } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

function startChild(tag, args, env) {
  const child = spawn(NODE_BIN, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const svc = { tag: tag, child: child, stdout: '', stderr: '', exited: null };
  /* ★ 登记的是 **svc 包装对象**，不是裸的 ChildProcess —— 第一版推的是
     `child`，于是退出账（F1）读的是一批没有 `exited` 字段的对象：每一步
     都看起来"还活着"，而真正的原因是这个数组里根本不是我们记账的那些
     东西。一个测不到的残留恰恰会让"没有残留"这句话变成假绿。 */
  spawned.push(svc);
  totalSpawn += 1;
  concurrentNow += 1;
  maxConcurrent = Math.max(maxConcurrent, concurrentNow);
  svc.output = () => (svc.stdout + svc.stderr).slice(-6000);
  child.stdout.on('data', c => { svc.stdout += String(c); });
  child.stderr.on('data', c => { svc.stderr += String(c); });
  child.on('exit', (code, signal) => {
    svc.exited = { code: code, signal: signal };
    concurrentNow -= 1;
  });
  return svc;
}

async function waitListening(svc, port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (svc.exited) return false;
    try { const r = await request(port, 'GET', '/health'); if (r.status === 200) return true; } catch (_) { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}

/* 优先走**合作停止面**（Windows 上 SIGTERM 就是 TerminateProcess，
   会跳过 store.close()）。两个服务端的 /__shutdown 跑的是同一条拆除梯子。 */
async function stopChild(svc, port) {
  if (!svc || svc.exited) return;
  let stopResponse = null;
  try { stopResponse = await request(port, 'POST', '/__shutdown', {}); } catch (error) { stopResponse = { error: String(error && error.message) }; }
  for (let i = 0; i < 80 && !svc.exited; i++) await sleep(100);
  if (!svc.exited) svc.child.kill('SIGTERM');
  for (let i = 0; i < 40 && !svc.exited; i++) await sleep(100);
  svc.stopProbe = {
    stopStatus: stopResponse && stopResponse.status != null ? stopResponse.status : (stopResponse && stopResponse.error ? 'threw' : 'none'),
    stopError: stopResponse && stopResponse.body && stopResponse.body.error ? String(stopResponse.body.error) : null,
    exitedCode: svc.child.exitCode,
    signalCode: svc.child.signalCode,
    stillAlive: (() => { try { process.kill(svc.child.pid, 0); return true; } catch (_) { return false; } })()
  };
}

console.log('P22-11 \u00b7 Active \u2192 Home Node Economy Command Channel\uff08\u4e24\u4e2a\u771f\u5b9e\u8fdb\u7a0b\uff09');console.log('  node =', NODE_BIN, NODE_BIN === BUNDLED_NODE ? '(bundled, = production)' : '(FALLBACK: bundled runtime missing)');

(async function main() {

  const TOKEN = 'p22-11-bridge-source-token-0123456789';
  const AGENT = 'cfg_agent';
  const CUR = 'IB_CREDIT';

  const homeNodePort = await freePort();
  const activePort = await freePort();
  /* ★ 来源端口是**第三条**端口，而且没有任何人监听它 —— 见
     active/economy-channel-client.js 里 ENV.SOURCE_PORT 的说明（Windows 上
     客户端 socket 绑不到一个已被监听的端口，实测一直 EADDRINUSE）。
     它确定、被登记、不被监听，这正是"来源管道"这条登记要的三件事。 */
  const sourcePort = await freePort();
  const seedPort = await freePort();
  const homeNodeDir = tmpDir('home');
  const activeDir = tmpDir('active');
  /* ★ 所有对 Home Node 的 HTTP 请求都带上桌面 token：本 fixture 显式配置了
     IB_HOME_NODE_TOKEN，因此 /characters/publish 与 /economy/* 都必须出示它
     —— 会话携带凭据正是这个仓库既有的姿态（P11-3A），本测试不绕过它。 */
  const ADMIN = 'p22-11-bridge-admin-token-0123456789';
  const ADMIN_HEADERS = { 'X-IB-Home-Token': ADMIN };

  /* ══════════════════════════════════════════════════════════════════
     启动两个真实进程（**同时最多 2 个**）
     ══════════════════════════════════════════════════════════════════ */
  const home = startChild('home-node',
    [path.join('tests', 'fixtures', 'p22-11-home-node-process.js'), '--seed-port=' + seedPort], {
    IB_HOME_NODE_PORT: String(homeNodePort),
    IB_HOME_NODE_DATA_DIR: homeNodeDir,
    IB_HOME_NODE_TOKEN: ADMIN,
    IB_P22_11_SEED: 'on',
    /* ★ 来源登记册与凭据：通道的凭据模型要求**显式**配置，
       而不是继承 loopback 的零门槛（这是一条写路径）。 */
    IB_ECONOMY_CHANNEL_TOKEN: TOKEN,
    /* 来源管道 = 那条**专用**端口（与 Active 的监听端口分开，见上）。 */
    IB_ECONOMY_CHANNEL_SOURCE_PORT: String(sourcePort),
    IB_ACTIVE_PORT: String(activePort)
  });
  const active = startChild('active', [path.join('tests', 'fixtures', 'p22-11-active-process.js'), '--port=' + activePort], {
    IB_ACTIVE_PORT: String(activePort),
    IB_ACTIVE_DATA_DIR: activeDir,
    IB_ECONOMY_CHANNEL_TOKEN: TOKEN,
    IB_ECONOMY_CHANNEL_SOURCE_PORT: String(sourcePort),
    IB_ECONOMY_CHANNEL_BASE: 'http://127.0.0.1:' + homeNodePort,
    /* Home Node 自己的端口也一并给出去：Active 侧不需要它，但这样
       两个进程的配置形状就是同一份（部署时它们来自同一处）。 */
    IB_HOME_NODE_PORT: String(homeNodePort)
  });

  const homeUp = await waitListening(home, homeNodePort, 25000);
  const activeUp = await waitListening(active, activePort, 25000);
  check('A1 \u2605\u2605 \u4e24\u4e2a\u771f\u5b9e\u8fdb\u7a0b\u90fd\u8d77\u6765\u4e86\uff0823118 \u7684\u751f\u4ea7\u542f\u52a8\u8def\u5f84 + 23114 \u7684\u7ec4\u5408\u6839\uff09',
    homeUp && activeUp,
    { home: { up: homeUp, pid: home.child.pid, exited: home.exited }, active: { up: activeUp, pid: active.child.pid, exited: active.exited } });

  try {
    if (!homeUp || !activeUp) {
      console.error('home output: \u2014 ' + home.output());
      console.error('active output: \u2014 ' + active.output());
      throw new Error('one of the two fixture processes did not come up');
    }

    /* ════════════════════════════════════════════════════════════════
       B · 经济链的种子（**通过 Home Node 自己的进程**，不碰它的库文件）
       ════════════════════════════════════════════════════════════════
       ★ 这一段刻意不直接 open 它的 SQLite 文件：那会让"钱真的动了"变成
         另一个进程写的、另一个连接读的。种子必须由**同一个权威进程**
         建立，这与 P22-6/P22-7 的既有做法一致 —— 先登记角色，再由它
       自己的 store 走内部 API 铸币与发预算。 */
    section('B \u00b7 \u79cd\u5b50\uff08\u7531 Home Node \u81ea\u5df1\u90a3\u4e2a\u8fdb\u7a0b\u5efa\u7acb\uff09');

    const seeded = await request(seedPort, 'POST', '/__p22_11/seed', { agentId: AGENT, currency: CUR });
    check('B1 \u2605 \u6743\u5a01\u8fdb\u7a0b\u81ea\u5df1\u5efa\u597d\u4e86\u94b1\u5305 / \u5546\u54c1 / \u9884\u7b97 / \u81ea\u4e3b\u653f\u7b56',
      seeded.status === 200 && seeded.body.ok === true && typeof seeded.body.productId === 'string',
      seeded.body);
    if (!(seeded.status === 200 && seeded.body.ok === true)) {
      throw new Error('seed failed: ' + J(seeded.body));
    }
    const seed = { productId: seeded.body.productId };

    const noToken = await request(homeNodePort, 'GET', '/economy/purchases');
    check('B2 \u2605\u2605 \u914d\u7f6e\u4e86\u684c\u9762 token \u4e4b\u540e\uff0c\u4e0d\u5e26 token \u7684 /economy/* \u662f 401\uff08\u672c\u6d4b\u8bd5\u4e0d\u7ed5\u8fc7\u65e2\u6709\u8ba4\u8bc1\uff09',
      noToken.status === 401, { status: noToken.status, body: noToken.body });

    /* ════════════════════════════════════════════════════════════════
       C · 跨进程：Authenticated Active command \u2192 \u771f\u5b9e Intent
       ════════════════════════════════════════════════════════════════ */
    section('C \u00b7 \u8de8\u8fdb\u7a0b command\uff0823114 \u2192 23118\uff09');

    const channelInfo = await request(activePort, 'GET', '/channel');
    check('C1 \u2605\u2605 Active \u8fdb\u7a0b\u91cc\u7684\u901a\u9053\u5ba2\u6237\u7aef**\u5df2\u914d\u7f6e**\uff0c\u800c\u4e14\u5b83\u77e5\u9053\u7684\u8def\u5f84\u4e0e\u5951\u7ea6\u4e00\u6a21\u4e00\u6837',
      channelInfo.status === 200 &&
      channelInfo.body.configured === true &&
      channelInfo.body.commandPath === CHANNEL.COMMAND_PATH &&
      channelInfo.body.describe.path === CHANNEL.COMMAND_PATH &&
      channelInfo.body.describe.unboundedRetry === false &&
      channelInfo.body.describe.maxAttempts <= CHANNEL.HARD_MAX_ATTEMPTS &&
      channelInfo.body.describe.credentialNeverInPayload === true &&
      channelInfo.body.actionName === 'economy_propose_purchase',
      channelInfo.body && channelInfo.body.describe);

    /* ★ 真实的一次跨进程提议。产品与钱包由 Home Node 侧预先准备好 ——
       为了让这条测试只证明"通道"，Home Node 用测试环境变量打开了一个
       可铸币的装配（systemMintingEnabled 由装配层注入），并通过
       **同进程的内部 API** 完成种子。 */
    const propose = await request(activePort, 'POST', '/__p22_11/propose', {
      proposal: { agentId: AGENT, productId: seed.productId, units: 1, reason: 'compute is running low' },
      idempotencyKey: 'p22-11-bridge-idem-1',
      commandId: 'p22-11-bridge-command-1'
    });
    check('C2 \u2605\u2605 23114 上的 Active \u63d0\u51fa\u4e86\u4e00\u6761\u8de8\u8fdb\u7a0b Economy \u8d2d\u4e70\u610f\u56fe\uff0c\u800c 23118 \u771f\u7684\u5efa\u4e86\u8fd9\u6761 Intent',
      propose.status === 200 && propose.body.ok === true &&
      propose.body.delivery === CHANNEL.DELIVERY.DELIVERED &&
      proveSource(propose.body.source),
      propose.body);

    /* 幂等：同一条 command 再发一次（同 commandId + 同 idempotencyKey） */
    const replay = await request(activePort, 'POST', '/__p22_11/propose', {
      proposal: { agentId: AGENT, productId: seed.productId, units: 1, reason: 'compute is running low' },
      idempotencyKey: 'p22-11-bridge-idem-1',
      commandId: 'p22-11-bridge-command-1'
    });
    check('C3 \u2605\u2605 \u8de8\u8fdb\u7a0b\u91cd\u653e\u6536\u655b\u5230\u540c\u4e00\u4e2a\u903b\u8f91 Intent\uff08\u540c\u4e00 intentId\uff0c\u4e14\u91cd\u653e\u4f4d\u7f6e\u4e86\u4e00\u6b21\uff09',
      replay.status === 200 &&
      replay.body.intentCreated === propose.body.intentCreated &&
      replay.body.channelReplay === true,
      { first: propose.body.intentCreated, second: replay.body.intentCreated, channelReplay: replay.body.channelReplay });

    check('C4 \u2605\u2605 \u4f20\u8f93\u6210\u529f\u4e0d\u88ab\u8bf4\u6210"\u8d2d\u4e70\u6210\u529f/\u6279\u51c6"\uff1aActive \u8fd9\u4e00\u4fa7\u7684\u8fd4\u56de\u503c\u91cc\u4e24\u4e2a\u6052 false \u4f4d\u90fd\u5728',
      propose.body.purchaseFailed === false && propose.body.purchaseDenied === false &&
      replay.body.purchaseFailed === false && replay.body.purchaseDenied === false);

    /* ── C5 · 身份不可自报：提案里带 consumerId 在**净化器**就被挡 ────── */
    const selfReported = await request(activePort, 'POST', '/__p22_11/propose', {
      proposal: { agentId: AGENT, productId: seed.productId, units: 2, consumerId: 'active_agent_runtime' },
      idempotencyKey: 'p22-11-bridge-idem-2'
    });
    check('C5 \u2605\u2605 payload \u91cc\u81ea\u62a5 consumerId \u2192 \u5728 Active \u8fd9\u4e00\u4fa7\u5c31\u88ab\u62d2\uff0c\u800c\u4e14**\u6839\u672c\u6ca1\u53d1\u51fa\u53bb**\uff08\u6ca1\u78b0\u4f20\u8f93\uff09',
      selfReported.status === 400 &&
      selfReported.body.sanitized === false &&
      selfReported.body.reachedTransport === false,
      selfReported.body);

    /* ── C6 · 缺 canonical 幂等键同样在净化器就被挡 ─────────────────── */
    const noKey = await request(activePort, 'POST', '/__p22_11/propose', {
      proposal: { agentId: AGENT, productId: seed.productId, units: 3 }
    });
    check('C6 \u2605 \u7f3a\u5e42\u7b49\u952e \u2192 \u51c0\u5316\u5668\u62d2\u7edd\uff08fail closed\uff09',
      noKey.status === 400 && noKey.body.reachedTransport === false, noKey.body);

    /* ── C7 · 未知 command 跨进程被拒（由 Active 那一侧真的发出去）──────
       ★ 生产路径 proposePurchase 的命令名是**写死的**，因此"只开放一个
         command"在客户端是结构性的。这一条走的是显式命名的测试入口，
         证明的是**服务端**会拒绝一个未知名字（fail closed），而不是
         客户端会放行 —— 两者是不同的断言，缺一不可。 */
    const unknownAction = await request(activePort, 'POST', '/__p22_11/propose', {
      command: 'ECONOMY_BUY',
      proposal: { agentId: AGENT, productId: seed.productId, units: 4 },
      idempotencyKey: 'p22-11-bridge-idem-unknown',
      commandId: 'p22-11-bridge-command-unknown'
    });
    const c7 = {
      http200: unknownAction.status === 200,
      delivered: unknownAction.body.delivered === true,
      notOk: unknownAction.body.ok === false,
      http404: unknownAction.body.httpStatus === 404,
      unknownCommand: unknownAction.body.reasonCode === CHANNEL.REFUSAL.UNKNOWN_COMMAND,
      noAdapterResult: unknownAction.body.adapterResultPresent === false,
      adapterNotReached: unknownAction.body.channelReachedAdapter === false,
      noIntent: unknownAction.body.intentCreated === null,
      rightSource: unknownAction.body.source === C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME
    };
    check('C7 \u2605\u2605 \u8de8\u8fdb\u7a0b\u53ea\u5f00\u653e\u4e00\u4e2a command\uff1aECONOMY_BUY \u4ece 23114 \u53d1\u51fa\u53bb\uff0c\u5728 23118 \u88ab\u62d2\uff08\u5b83\u5728\u8fd9\u4efd\u8bcd\u8868\u91cc\u4e0d\u5b58\u5728\uff09',
      Object.keys(c7).every(k => c7[k] === true),
      Object.assign({ failed: Object.keys(c7).filter(k => c7[k] !== true) }, unknownAction.body));

    /* ── C8 · 普通 /economy/* 写面仍然为 0（在**真实进程**上）────────── */
    const writeProbe = await request(homeNodePort, 'POST', '/economy/purchase', { any: 1 },
      ADMIN_HEADERS);
    check('C8 \u2605\u2605 \u771f\u5b9e\u8fdb\u7a0b\u4e0a POST /economy/purchase \u2192 405 economy-is-read-only',
      writeProbe.status === 405 && writeProbe.body.error === 'economy-is-read-only',
      writeProbe.body);

    /* ── C9 · 已发生的事实：恰好一笔购买，且凭据不进任何输出 ─────────── */
    const purchases = await request(homeNodePort, 'GET', '/economy/purchases?buyerId=' + encodeURIComponent(AGENT),
      null, ADMIN_HEADERS);
    check('C9 \u2605\u2605 \u7ecf\u8fc7\u8de8\u8fdb\u7a0b\u901a\u9053\u540e\uff0c\u771f\u5b9e\u8fdb\u7a0b\u91cc\u6070\u597d\u6709\u4e00\u7b14\u8d2d\u4e70\uff08\u91cd\u653e\u6ca1\u6709\u4ea7\u751f\u7b2c\u4e8c\u7b14\uff09',
      purchases.status === 200 && purchases.body.count === 1,
      purchases.body && { count: purchases.body.count });

    const intents = await request(homeNodePort, 'GET', '/economy/intents?agentId=' + encodeURIComponent(AGENT),
      null, ADMIN_HEADERS);
    check('C10 \u2605 \u2605 \u4e5f\u53ea\u6709\u4e00\u6761 Intent\uff0c\u800c\u4e14\u5b83\u7684 agentId \u662f\u90a3\u4e2a\u771f\u5b9e\u89d2\u8272',
      intents.status === 200 && intents.body.count === 1 &&
      intents.body.intents[0].agentId === AGENT,
      intents.body && { count: intents.body.count });

    /* ════════════════════════════════════════════════════════════════
       D · 凭据与审计：两个进程的输出里都没有那个 token
       ════════════════════════════════════════════════════════════════ */
    section('D \u00b7 \u51ed\u636e\u4e0d\u8fdb\u8f93\u51fa\uff08\u4e24\u4e2a\u8fdb\u7a0b\u7684 stdout+stderr\uff09');

    const homeOutput = home.output();
    const activeOutput = active.output();
    check('D1 \u2605\u2605 \u4e24\u4e2a\u8fdb\u7a0b\u7684\u8f93\u51fa\u91cc\u90fd**\u6ca1\u6709**\u90a3\u4e2a\u6765\u6e90\u51ed\u636e',
      homeOutput.indexOf(TOKEN) < 0 && activeOutput.indexOf(TOKEN) < 0,
      {
        tokenInHomeOutput: homeOutput.indexOf(TOKEN) >= 0,
        tokenInActiveOutput: activeOutput.indexOf(TOKEN) >= 0
      });

    const sec = await request(homeNodePort, 'GET', '/security', null, ADMIN_HEADERS);
    const pol = sec.body && sec.body.economyPolicy;
    check('D2 \u2605\u2605 \u771f\u5b9e\u8fdb\u7a0b\u7684 /security \u628a\u901a\u9053\u62a5\u6210 open\uff0c\u800c\u4e14\u90a3\u4e09\u4efd\u5199\u540d\u5355\u4ecd\u7136\u4e3a\u7a7a',
      !!pol && pol.commandChannel.open === true &&
      J(pol.commandChannel.commandWritesExposed) === J(CHANNEL.COMMAND_LIST) &&
      pol.commandChannel.capabilityWritesExposed.length === 0 &&
      pol.commandChannel.approvalWritesExposed.length === 0 &&
      pol.commandChannel.resumeWritesExposed.length === 0 &&
      pol.writesExposed.length === 0,
      pol && pol.commandChannel);

    /* ════════════════════════════════════════════════════════════════
       E · 传输失败**不**被说成经济裁决（Active 侧的分类）
       ════════════════════════════════════════════════════════════════ */
    section('E \u00b7 \u00a78 \u00b7 \u4f20\u8f93\u5931\u8d25\u4e0d\u662f\u8d2d\u4e70\u5931\u8d25');

    /* 打一个 Active 侧配置以外、但**存在**的地址是做不到的（配置是启动期
       固定的），因此这一条用"跨进程可达性"的镜像来证明：杀掉 Home Node
       之后再发一次，Active 侧的答案只能是 DELIVERY_UNKNOWN /
       TRANSPORT_FAILED，而绝不是 purchaseFailed / purchaseDenied。 */
    await stopChild(home, homeNodePort);
    const afterShutdown = await request(activePort, 'POST', '/__p22_11/propose', {
      proposal: { agentId: AGENT, productId: seed.productId, units: 5, reason: 'after the authority is gone' },
      idempotencyKey: 'p22-11-bridge-idem-3'
    });
    check('E1 \u2605\u2605 Home Node \u4e0d\u5728\u4e86\u4e4b\u540e\uff0cActive \u53ea\u80fd\u8bf4"\u4ea4\u4ed8\u672a\u77e5/\u4f20\u8f93\u5931\u8d25"\uff0c\u4e0d\u80fd\u8bf4"\u8d2d\u4e70\u5931\u8d25/\u88ab\u62d2\u7edd"',
      afterShutdown.status === 200 &&
      afterShutdown.body.ok === false &&
      (afterShutdown.body.delivery === CHANNEL.DELIVERY.DELIVERY_UNKNOWN ||
        afterShutdown.body.delivery === CHANNEL.DELIVERY.TRANSPORT_FAILED) &&
      afterShutdown.body.purchaseFailed === false &&
      afterShutdown.body.purchaseDenied === false &&
      afterShutdown.body.intentCreated === null &&
      afterShutdown.body.attempts <= CHANNEL.HARD_MAX_ATTEMPTS,
      afterShutdown.body);

  } finally {
    /* ── cleanup：两个 child 都必须**等到真的退出** ─────────────────── */
    await stopChild(active, activePort);
    await stopChild(home, homeNodePort);
  }

  /* ══════════════════════════════════════════════════════════════════
     F · §12 的进程账（**被测**的事实，不是一句声明）
     ══════════════════════════════════════════════════════════════════ */
  section('F \u00b7 \u00a712 \u00b7 \u8fdb\u7a0b\u8d26');

  const leftovers = spawned.filter(c => !c.exited);
  check('F1 \u2605\u2605 \u6700\u5927\u540c\u65f6 child = 2\u3001\u603b spawn = 2\u3001\u6b8b\u7559 = 0',
    maxConcurrent <= 2 && totalSpawn === 2 && leftovers.length === 0,
    {
      maxConcurrent: maxConcurrent,
      totalSpawn: totalSpawn,
      leftover: leftovers.length,
      stop: spawned.map(c => ({ tag: c.tag, exited: c.exited, stopProbe: c.stopProbe }))
    });

  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }

  console.log('\n' + (failures === 0 ? '\u5168\u90e8\u901a\u8fc7' : '\u5b58\u5728\u5931\u8d25') + '\uff1a' +
    (failures === 0 ? 'all checks passed' : failures + ' failed'));
  console.log('child process: max concurrent = ' + maxConcurrent + ' \u00b7 total spawn = ' + totalSpawn +
    ' \u00b7 leftover = ' + leftovers.length);
  if (failures > 0) process.exitCode = 1;

})().catch(error => {
  for (const child of spawned) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  console.error('\u2716 \u672a\u6355\u83b7\u5f02\u5e38\uff1a' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
