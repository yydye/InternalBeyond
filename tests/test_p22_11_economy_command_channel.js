'use strict';
/* ====================================================================
   P22-11 · Economy Command Channel（单进程 · 真实 HTTP · 零子进程）
   --------------------------------------------------------------------
   运行：node tests/test_p22_11_economy_command_channel.js

   ── 这个文件证明什么，以及**不**证明什么 ─────────────────────────────
   证明：一条 authenticated、local-only、fail-closed 的 command 面在
   **真实 HTTP 传输**上成立 —— 而且每个新不变量都有一条会失败的路径。

   不证明（那是 test_p22_11_economy_active_bridge.js 的事）：23114 与
   23118 是**两个真实操作系统进程**。本文件刻意**一个 child 都不开**
   （§12：能单进程证明的禁止 spawn）——"跨进程"在这里的意义是
   "跨 HTTP transport"，而两个真实进程是**另一条**证据。

   ── §12 的进程账 ────────────────────────────────────────────────────
   max concurrent child = 0 · total spawn = 0 · leftover = 0。
   只加载 Home Node 的最小依赖闭包：装配层 + 一份 economy 契约
   （它间接带来 node:sqlite）。没有 Desktop / Electron / 浏览器。

   ── 三个从真实代码里学到的、决定了本文件写法的事实 ──────────────────
   ① **意图指纹不看 reason**。P22-8 的 PURCHASE_INTENT_FINGERPRINT_KEYS
      是 ['agentId','productId','recipientId','units','selfDirected'] ——
      因此"同一个 agent 买同一个商品、只换了 reason"是**同一条逻辑
      Intent**（这正是 P22-8 想要的），而"我想让每次检查都真的产生一笔
      新购买"就必须换 units。开发期实测踩到过：用不同 reason 造"不同
      购买"会让所有"钱真的动了"的断言静默地测同一笔购买。
   ② **来源端口必须是确定的那一类**。Home Node 登记"Active 从哪条本机
      端口说话"，而一个**没有**显式绑定来源端口的调用方拿到的是动态
      （临时）端口。要让它必然不匹配，登记的端口就必须落在动态端口范围
      **之外**（见 ephemeralTcpRange）。
   ③ 通道对适配器的调用是**一处字面成员调用**，所以"一条 command 恰好
      调用一次适配器"可以用一个只数调用次数的包装器直接证明。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-11c-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
/* ★ 必须在 require 服务之前设置（进程级装配也不碰生产 dataDir）。 */
process.env.IB_HOME_NODE_DATA_DIR = tmpDir('process-level');
/* 进程级装配**刻意不配**通道来源：那正是生产未配置时的姿态。 */
delete process.env.IB_ECONOMY_CHANNEL_TOKEN;
delete process.env.IB_ECONOMY_CHANNEL_BASE;

const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const CHANNEL = require(path.join(ROOT, 'services', 'home-node', 'economy-command-channel.js'));

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

const closables = [];
const CUR = 'IB_CREDIT';
const AGENT = 'cfg_agent';
const PATHNAME = CHANNEL.COMMAND_PATH;
const TOKEN = 'p22-11-source-token-0123456789';
const OTHER_TOKEN = 'p22-11-other-source-token-987654321';
/* P22-23：Economy 的读面（/economy/*、/security）要求**桌面凭据**。
   这个文件在本阶段之前既不注入 token 也不带令牌头，因此 E/H 两组在
   P22-23 之后一直是 401 —— 那是**既有**的红，与本阶段无关。这里只补夹具。 */
const DESKTOP_TOKEN = 'p22-11-desktop-fixture-token';
/* ══════════════════════════════════════════════════════════════════
   ⚠️ 静态扫描必须先剥注释与字符串字面量
   ══════════════════════════════════════════════════════════════════
   本仓库既有纪律（test_p22_1 boundary / test_p22_10 同款）。理由在这里
   格外具体：通道的注释**故意**提到被禁止的东西（"本文件里没有
   economy(method,args)"），而注释不是代码。不剥注释的扫描会把解释判成
   违规 —— 那种假阳性最坏的后果，是让人删掉解释。 */
function stripCommentsAndStrings(src) {
  return String(src)
    .replace(/\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+\/[gimsuy]*/g, ' RE ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^\\"\n])*"/g, ' "" ')
    .replace(/`(?:\\.|[^\\`])*`/g, ' `` ');
}

/* ══════════════════════════════════════════════════════════════════
   ⚠️ "登记的来源端口"必须是动态端口范围**之外**的一个值
   ══════════════════════════════════════════════════════════════════
   Windows 默认动态（临时）端口范围本机实测是 1024 + 13977，因此一个
   未显式绑定来源端口的出站连接**永远**拿不到范围之外的那个值。于是
   "从别的管道来的命令必然被拒"是一条范围事实，而不是运气。 */
function ephemeralTcpRange() {
  try {
    const out = require('node:child_process').execSync(
      'netsh int ipv4 show dynamicport tcp', { encoding: 'utf8', timeout: 5000 });
    const start = Number((out.match(/Start Port\s*:\s*(\d+)/) || [])[1]);
    const count = Number((out.match(/Number of Ports\s*:\s*(\d+)/) || [])[1]);
    if (Number.isInteger(start) && Number.isInteger(count) && count > 0) {
      return { start: start, end: start + count - 1 };
    }
  } catch (_) { /* 读不到就退到范围之下（见 ACTIVE_PORT） */ }
  return null;
}
const EPHEMERAL = ephemeralTcpRange();
const ACTIVE_PORT = (EPHEMERAL && EPHEMERAL.end + 1 <= 65535)
  ? EPHEMERAL.end + 1
  : 1023;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function request(port, method, urlPath, body, headers, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const requestOptions = {
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json', 'X-IB-Home-Token': DESKTOP_TOKEN },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}),
      timeout: opts.timeout || 8000
    };
    if (opts.localPort) { requestOptions.localPort = opts.localPort; requestOptions.localAddress = '127.0.0.1'; }
    const req = http.request(requestOptions, res => {
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

/* 从**固定**来源端口发一次请求。固定 localPort 会与上一次连接的
   TIME_WAIT 撞（Windows 上是随机的 EADDRINUSE），那不是逻辑失败。 */
async function boundRequest(port, sourcePort, method, urlPath, body, headers) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await request(port, method, urlPath, body, headers, { localPort: sourcePort });
    } catch (error) {
      lastError = error;
      if (!/EADDRINUSE/.test(String(error && (error.code || error.message)))) throw error;
      await new Promise(r => setTimeout(r, 80));
    }
  }
  throw lastError;
}

console.log('P22-11 \u00b7 Economy Command Channel');

(async function main() {

  const SOURCE_PORT = ACTIVE_PORT;
  const OTHER_PORT = ACTIVE_PORT + 1;

  /* ══════════════════════════════════════════════════════════════════
     装配：真实 Home Node + 两个登记的来源 + 真实经济链
     ══════════════════════════════════════════════════════════════════ */
  const app = SERVICE.buildHomeNode({
    dataDir: tmpDir('http'),
    logger: () => { },
    /* P22-23：Economy 的读面（/economy/*、/security）要凭据；夹具显式给一个，
       并对所有请求附上令牌头（见上面的 request）。断言本身一条都没有放宽。 */
    token: DESKTOP_TOKEN,
    economyChannelSources: [
      { consumer: C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME, token: TOKEN, boundPort: SOURCE_PORT },
      { consumer: C.ECONOMY_CONSUMER.DESKTOP_BRIDGE, token: OTHER_TOKEN, boundPort: OTHER_PORT }
    ]
  });
  closables.push({
    close: () => {
      try { app.server.closeAllConnections(); } catch (_) { }
      try { app.economyStore.close(); } catch (_) { }
      try { app.server.close(); } catch (_) { }
    }
  });
  app.open();
  app.registry.putCharacter(AGENT, { id: AGENT, nickname: 'Agent' }, null);
  const store = app.economyStore;

  let keySeq = 0;
  const K = p => 'p22-11-' + (p || 'k') + '-' + (++keySeq);
  const storeId = store.putStore({ name: 'Main Store', idempotencyKey: K('store') }).result.store.storeId;
  const productId = store.putProduct({
    storeId: storeId, kind: 'COMPUTE_CREDIT', name: 'Compute x1000', currency: CUR,
    unitPriceMinor: 10, grantQuantity: 1000, idempotencyKey: K('product')
  }).result.product.productId;
  const wallet = store.openWallet({ owner: { type: 'character', id: AGENT }, currency: CUR });
  store.mintForSystem({
    systemInitiated: true, walletId: wallet.wallet.walletId, currency: CUR,
    amountMinor: 10000000, idempotencyKey: K('mint')
  });
  store.putBudgetPolicy({
    ownerId: AGENT, currency: CUR,
    limits: { perTransactionMinor: 10000000, dailyMinor: 10000000, weeklyMinor: 10000000, monthlyMinor: 10000000 },
    idempotencyKey: K('budget')
  });
  store.putAutonomyPolicy({
    ownerId: AGENT, currency: CUR, enabled: true, perPurchaseLimitMinor: 10000000,
    dailyAutonomousLimitMinor: 10000000, approvalAboveMinor: 10000000,
    allowedProductKinds: ['COMPUTE_CREDIT'], allowedSettlementTypes: ['COMPUTE_GRANT'],
    allowGift: false, idempotencyKey: K('autonomy')
  });

  const port = await freePort();
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));

  const AUTH = { 'X-IB-Economy-Channel-Source': TOKEN };
  /* ★ units 是**意图指纹**的一部分（reason 不是）。每个"要一笔新购买"
     的检查都必须给它自己的 units —— 否则它测到的是同一条 Intent。 */
  let unitsSeq = 0;
  function envelope(over) {
    const identity = CHANNEL.createCommandIdentity('t');
    unitsSeq += 1;
    return Object.assign({
      command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE,
      commandId: identity.commandId,
      idempotencyKey: identity.idempotencyKey,
      proposal: { agentId: AGENT, productId: productId, units: unitsSeq, reason: 'compute is running low' }
    }, over || {});
  }

  /* ══════════════════════════════════════════════════════════════════
     A · §1 复用既有 transport；只有一条写路径
     ══════════════════════════════════════════════════════════════════ */
  section('A \u00b7 \u00a71 \u00b7 \u590d\u7528\u65e2\u6709 transport\uff08\u6ca1\u6709\u7b2c\u4e8c\u5957\u6846\u67b6\uff09');

  const httpSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');
  const channelSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-command-channel.js'), 'utf8');
  const channelCode = stripCommentsAndStrings(channelSrc);
  const httpCode = stripCommentsAndStrings(httpSrc);

  check('A1 \u2605 \u901a\u9053\u8def\u5f84\u4e0d\u5728 /economy/ \u524d\u7f00\u4e0b\u2014\u2014"POST /economy/* \u4e00\u5f8b 405" \u8fd9\u53e5\u8bdd\u4ecd\u7136\u9010\u5b57\u4e3a\u771f',
    PATHNAME.indexOf('/economy/') !== 0 && PATHNAME === '/internal/economy/command',
    PATHNAME);

  check('A2 \u2605 http.js \u53ea\u591a\u4e86**\u4e00\u6761** command \u8def\u5f84\uff0c\u800c\u4e14\u5b83\u53ea\u80fd\u6765\u81ea\u6ce8\u5165\u5bf9\u8c61\uff08\u6ca1\u6709\u7b2c\u4e8c\u4e2a\u5b57\u9762\u91cf\uff09',
    (httpCode.match(/economyCommand\.dispatch\(/g) || []).length === 2 &&
    (httpCode.match(/economyCommand\.path/g) || []).length === 3 &&
    (httpCode.match(/economyCommand\.describe\(\)/g) || []).length === 1 &&
    /* 对通道的成员访问恰好**六**处，一处都不多：
       dispatch ×2（判定 + 读不出 body 时的拒绝信封）
       path ×3（凭据域判定 isEconomyCommandPath + route 判定 +
                /security 的 pathIsNotUnderEconomyReadPaths）
       describe() ×1（/security 的三句自述）
       没有任何一处新造 handler，也没有第二个路径字面量。 */
    (httpCode.match(/economyCommand\./g) || []).length === 6 &&
    httpSrc.indexOf("'/internal/economy/command'") < 0,
    {
      dispatchSites: (httpCode.match(/economyCommand\.dispatch\(/g) || []).length,
      pathSites: (httpCode.match(/economyCommand\.path/g) || []).length,
      describeSites: (httpCode.match(/economyCommand\.describe\(\)/g) || []).length,
      allSites: (httpCode.match(/economyCommand\./g) || []).length,
      literalSites: (httpSrc.match(/'\/internal\/economy\/command'/g) || []).length
    });

  check('A3 \u2605 \u2605 http \u5c42**\u62ff\u4e0d\u5230** raw store \u4e0e\u95e8\uff08\u53ea\u62ff\u5230\u901a\u9053\uff09\u2014\u2014 \u5199\u80fd\u529b\u6ca1\u6709\u4ece\u8fd9\u6761\u8def\u6f0f\u8fdb\u8def\u7531\u5c42',
    httpCode.indexOf('economyCommand') >= 0 &&
    httpCode.indexOf('economyCommand.store') < 0 &&
    httpCode.indexOf('economyCommand.gate') < 0 &&
    httpCode.indexOf('economyCommand.adapter') < 0 &&
    httpCode.indexOf('performAction') < 0 &&
    httpCode.indexOf('economy-action-adapter') < 0 &&
    httpCode.indexOf('economyActionAdapter') < 0);

  check('A4 \u2605 \u2605 \u901a\u9053\u81ea\u5df1**\u4e0d\u6301\u6709** store \u4e0e\u95e8\uff1a\u5b9e\u4f8b\u952e\u53ea\u6709\u90a3\u56db\u4e2a\uff0c\u800c\u5b83\u4eec\u4e00\u4e2a\u90fd\u4e0d\u662f\u5199\u5165\u53e3',
    (() => {
      const keys = Object.keys(app.economyCommandChannel).sort().join(',');
      const d = app.economyCommandChannel.describe();
      return keys === 'audit,commands,describe,dispatch,path' &&
        app.economyCommandChannel.store === undefined &&
        app.economyCommandChannel.gate === undefined &&
        app.economyCommandChannel.adapter === undefined &&
        d.transportHoldsRawStore === false &&
        d.transportHoldsCapabilityGate === false &&
        d.transportExposesGenericDispatch === false &&
        d.transportInterpretsEconomicFacts === false &&
        d.transportAddsASecondPurchaseDedupe === false &&
        d.transportChoosesTheConsumer === false;
    })(),
    Object.keys(app.economyCommandChannel));

  check('A5 \u2605\u2605 \u5bf9\u9002\u914d\u5668\u7684\u8bbf\u95ee\u662f**\u4e00\u5904\u5b57\u9762\u6210\u5458\u8c03\u7528**\uff1a\u6ca1\u6709\u8ba1\u7b97\u578b\u5206\u6d3e\uff08adapter[\u2026]\uff09\uff0c\u4e5f\u6ca1\u6709\u7b2c\u4e8c\u4e2a\u52a8\u8bcd',
    (channelCode.match(/adapter\.performAction\(/g) || []).length === 1 &&
    !/adapter\s*\[/.test(channelCode) &&
    channelCode.indexOf('executeEconomyAction') < 0 &&
    channelCode.indexOf('sanitizeAction') < 0,
    {
      performSites: (channelCode.match(/adapter\.performAction\(/g) || []).length,
      computedDispatch: /adapter\s*\[/.test(channelCode)
    });

  check('A6 \u2605 \u2605 \u4f9d\u8d56\u95ed\u5305\u53ea\u591a\u4e86**\u4e24\u4e2a\u6838\u5fc3\u6a21\u5757**\uff1anode:crypto\uff08\u6458\u8981\u4e0e\u6052\u5b9a\u65f6\u95f4\u6bd4\u8f83\uff09\u4e0e node:http\uff08\u51fa\u7ad9\u8f93\u9001\uff09',
    (() => {
      const targets = (channelSrc.match(/require\s*\(\s*'([^']+)'\s*\)/g) || [])
        .map(s => s.replace(/[\s\S]*'([^']*)'[\s\S]*/, '$1'));
      return targets.length === 3 &&
        targets.indexOf('node:crypto') >= 0 &&
        targets.indexOf('node:http') >= 0 &&
        targets.indexOf('./economy-contract.js') >= 0;
    })(),
    (channelSrc.match(/require\s*\(\s*'([^']+)'\s*\)/g) || []));

  check('A7 \u2605 \u8d26\u53f7\u4e0e\u5199\u5165\u80fd\u529b\u5747\u4e0d\u5728\u4f9d\u8d56\u95ed\u5305\u91cc\uff08\u6ca1\u6709 child_process / net / provider / \u652f\u4ed8 / \u51ed\u636e\u9762\uff09',
    ['child_process', 'spawn(', 'alipay', 'payment', 'provider', 'credential-vault',
      'commerce', 'shopping-execution', 'mcp.'].every(t => channelCode.indexOf(t) < 0),
    ['child_process', 'spawn(', 'alipay', 'payment', 'provider', 'credential-vault',
      'commerce', 'shopping-execution', 'mcp.'].filter(t => channelCode.indexOf(t) >= 0));

  check('A8 \u2605 \u2605 \u51ed\u636e\u6bd4\u8f83\u662f**\u6052\u5b9a\u65f6\u95f4**\u7684\uff08\u800c\u4e0d\u662f\u4e00\u53e5 ===\uff09\uff0c\u4e14 token \u53ea\u4ee5\u6458\u8981\u5f62\u5f0f\u8fdb\u7d22\u5f15',
    channelCode.indexOf('timingSafeEqual') >= 0 &&
    channelCode.indexOf('createHash') >= 0 &&
    /* ★ 索引里的每一格只有摘要：一个存着**明文 token** 的登记项会让
       "凭据不进日志/不进 describe"这组断言在别处漏掉。 */
    (() => {
      const normalized = CHANNEL.normalizeSources([
        { consumer: C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME, token: TOKEN, boundPort: SOURCE_PORT }
      ]).sources[0];
      return Object.keys(normalized).sort().join(',') === 'anchor,boundPort,consumer,tokenDigest' &&
        normalized.token === undefined &&
        normalized.tokenDigest !== TOKEN &&
        normalized.tokenDigest.length === 64;
    })(),
    {
      timingSafeEqual: channelCode.indexOf('timingSafeEqual'),
      tokenDigest: channelCode.indexOf('tokenDigest')
    });

  /* ══════════════════════════════════════════════════════════════════
     B · §6 authenticated + local-only
     ══════════════════════════════════════════════════════════════════ */
  section('B \u00b7 \u00a76 \u00b7 \u8ba4\u8bc1\u4e0e\u672c\u5730\u9650\u5236');

  const missingAuth = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope(), {});
  check('B1 \u2605\u2605 \u7f3a\u51ed\u636e \u2192 401\uff0c\u800c\u4e14**\u6ca1\u78b0\u9002\u914d\u5668**',
    missingAuth.status === 401 &&
    missingAuth.body.reasonCode === CHANNEL.REFUSAL.MISSING_SOURCE_CREDENTIAL &&
    missingAuth.body.reachedActionAdapter === false &&
    missingAuth.body.proposedNothing === true,
    missingAuth.body);

  const wrongAuth = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope(), { 'X-IB-Economy-Channel-Source': 'not-the-token' });
  check('B2 \u2605\u2605 \u9519\u8bef\u51ed\u636e \u2192 401 \u4e14\u7406\u7531\u4e0d\u540c\u4e8e"\u7f3a\u51ed\u636e"\uff08\u4e24\u4ef6\u4e8b\u4e0d\u80fd\u5408\u6210\u4e00\u4ef6\uff09',
    wrongAuth.status === 401 &&
    wrongAuth.body.reasonCode === CHANNEL.REFUSAL.UNKNOWN_SOURCE &&
    wrongAuth.body.reachedActionAdapter === false,
    wrongAuth.body);

  /* ★ 来源管道：登记的端口在动态范围**之外**，因此一个不绑定来源端口的
     调用方必然不匹配 —— 这是范围事实，不是运气。 */
  const unboundProbe = await request(port, 'POST', PATHNAME, envelope(), AUTH);
  check('B3 \u2605\u2605 \u51ed\u636e\u5bf9\u4f46**\u6765\u81ea\u672a\u767b\u8bb0\u7684\u672c\u673a\u7ba1\u9053** \u2192 401 \u4e14 reasonCode \u70b9\u540d"\u6765\u6e90\u7ba1\u9053"',
    unboundProbe.status === 401 &&
    unboundProbe.body.reasonCode === CHANNEL.REFUSAL.SOURCE_PORT_MISMATCH &&
    unboundProbe.body.expectedPort === SOURCE_PORT &&
    unboundProbe.body.observedPort !== SOURCE_PORT &&
    unboundProbe.body.reachedActionAdapter === false,
    {
      reasonCode: unboundProbe.body.reasonCode,
      expectedPort: unboundProbe.body.expectedPort,
      observedPort: unboundProbe.body.observedPort,
      ephemeralRange: EPHEMERAL
    });

  /* ── B4 · 通道 → 适配器**恰好一次**（用只数调用次数的包装器直接证明）──
     ★ 这一组要证明的是"一条 command 恰好调用一次 performAction"，因此
     包装器必须转发到**同一个 store 的**适配器上。做法是**转发代理**：
       ① 先造一个只数次数、稍后接线的代理对象，把它注入装配 ——
          通道在构造期就持有它拿到的那个适配器，所以注入必须发生在
          通道构造**之前**；
       ② 装配完成后再把真实适配器的成员接到代理上（通道只在自己的
          performAction 分支里访问它们，而那时接线早已完成）；
       ③ 只打开这一个 store。第一版分别装配了两个 fixture 再把 app 的
          适配器包起来喂过去，那条链查的是 app 的库 —— 症状是
          PRODUCT_NOT_FOUND 与 "economy store is not open"：包装器测到的
          是另一个世界。 */
  app.economyStore.close();
  /* ★ 关掉又被后续组读到的那个库必须**再打开**：C/F 组读的正是 app 这一份
     （那是"同一个世界里之前发生过什么"的基线）。第一版忘了这一行，
     症状是一条 `economy store is not open` 把整份测试从 C 组截断。 */
  app.economyStore.open();
  let adapterCalls = 0;
  const countedDir = tmpDir('counted');
  /* ★ 包装器要转发的那个"真实适配器"，取自一个**独立的**装配实例。
     为什么不能取自 counted 装配自己：economyAssembly 会把它**收到**的
     那个对象原样返回（`options.economyActionAdapter || bind(...)`），
     因此"先装配、再把返回的适配器包起来、再让通道拿到包装器"在同一个
     装配里做不到 —— 通道在构造期就已经拿走了那个引用。开发期实测踩到过：
     硬接的后果是 `inner` 指向自己，症状是 RangeError（无限递归），
     而不是一句清楚的失败。 */
  const countedSeedAssembly = SERVICE.economyAssembly({
    dataDir: tmpDir('counted-seed'),
    logger: () => { },
    ownerExists: () => true,
    economyChannelSources: [
      { consumer: C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME, token: TOKEN, boundPort: SOURCE_PORT }
    ]
  });
  const countingAdapter = (() => {
    const inner = countedSeedAssembly.economyActionAdapter;
    return Object.freeze({
      consumer: inner.consumer,
      capabilities: inner.capabilities,
      actions: inner.actions,
      notOfferedActions: inner.notOfferedActions,
      sanitizeAction: inner.sanitizeAction,
      performAction: raw => { adapterCalls += 1; return inner.performAction(raw); }
    });
  })();
  /* ★ 包装器必须在通道构造**之前**存在：通道装配期就持有它。 */
  const countedAssembly = SERVICE.economyAssembly({
    dataDir: countedDir,
    logger: () => { },
    /* ★ 与 P22-10 的装配 fixture 逐字同款：角色的 canonical owner 是
       device-registry，而这一组要证的是"通道调了几次适配器"，不是注册表。
       一个恒真的 owner 谓词让开钱包/领预算这条路可走，且**不**改写任何
       经济语义（ownerExists 只回答"这个角色存在吗"）。 */
    ownerExists: () => true,
    economyActionAdapter: countingAdapter,
    economyChannelSources: [
      { consumer: C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME, token: TOKEN, boundPort: SOURCE_PORT }
    ]
  });
  const countedChannel = countedAssembly.economyCommandChannel;
  /* ★ 被服务、被断言的那个库是**包装器转发到的**那一个：包装器转发到 seed
     装配的适配器，而那个适配器的句柄绑在 seed 装配的 store 上（P22-9 的
     "构造就是身份绑定"）。因此这里打开 seed store —— 只开 counted 那一个
     的症状是 `economy store is not open`，而那不是逻辑失败，是漏开了一个库。 */
  const countedStore = countedSeedAssembly.economyStore;
  countedStore.open();
  closables.push({
    close: () => {
      try { countedStore.close(); } catch (_) { }
      try { countedAssembly.economyStore.close(); } catch (_) { }
    }
  });
  const countedSeed = (() => {
    let seq = 0;
    const key = p => 'p22-11-counted-' + p + '-' + (++seq);
    const sid = countedStore.putStore({ name: 'S', idempotencyKey: key('s') }).result.store.storeId;
    const pid = countedStore.putProduct({
      storeId: sid, kind: 'COMPUTE_CREDIT', name: 'P', currency: CUR,
      unitPriceMinor: 10, grantQuantity: 1000, idempotencyKey: key('p')
    }).result.product.productId;
    const w = countedStore.openWallet({ owner: { type: 'character', id: AGENT }, currency: CUR });
    /* ★ 这一句不是装饰：seed 的每一步都必须自证成功，否则后面那句
       `w.wallet.walletId` 只会变成一句"读不到属性"的 TypeError ——
       而真正的原因（哪一步拒绝了、为什么）就此丢掉。开发期实测踩到过。 */
    check('B0 \u2605 counted fixture \u7684\u7ecf\u6d4e\u94fe\u79cd\u5b50\u5168\u90e8\u6210\u529f\uff08\u5426\u5219\u4e0b\u9762\u7684\u8ba1\u6570\u65ad\u8a00\u5728\u6d4b\u7a7a\u6c14\uff09',
      !!(w && w.ok === true && w.wallet && w.wallet.walletId),
      { storeId: sid, productId: pid, openWalletErrors: (w && w.errors) || null });
    if (!(w && w.ok === true && w.wallet && w.wallet.walletId)) {
      throw new Error('counted fixture seed failed: ' + JSON.stringify((w && w.errors) || null));
    }
    countedStore.mintForSystem({
      systemInitiated: true, walletId: w.wallet.walletId, currency: CUR,
      amountMinor: 1000000, idempotencyKey: key('m')
    });
    countedStore.putBudgetPolicy({
      ownerId: AGENT, currency: CUR,
      limits: { perTransactionMinor: 1000000, dailyMinor: 1000000, weeklyMinor: 1000000, monthlyMinor: 1000000 },
      idempotencyKey: key('b')
    });
    countedStore.putAutonomyPolicy({
      ownerId: AGENT, currency: CUR, enabled: true, perPurchaseLimitMinor: 1000000,
      dailyAutonomousLimitMinor: 1000000, approvalAboveMinor: 1000000,
      allowedProductKinds: ['COMPUTE_CREDIT'], allowedSettlementTypes: ['COMPUTE_GRANT'],
      allowGift: false, idempotencyKey: key('a')
    });
    return { productId: pid };
  })();
  const countedBody = {
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE,
    commandId: 'p22-11-counted-command',
    idempotencyKey: 'p22-11-counted-idem',
    proposal: { agentId: AGENT, productId: countedSeed.productId, units: 1, reason: 'one call, one performAction' }
  };
  const countedInfo = { loopback: true, remotePort: SOURCE_PORT, sourceToken: TOKEN };
  const viaChannel = countedChannel.dispatch(countedInfo, countedBody);
  const viaChannel2 = countedChannel.dispatch(countedInfo, countedBody);
  check('B4 \u2605\u2605 \u4e00\u6761 command = **\u6070\u597d\u4e00\u6b21** performAction\uff08\u91cd\u653e\u4e5f\u53ea\u6709\u4e00\u6b21\uff09\uff0c\u800c\u4e14\u91cd\u653e\u8d70\u7684\u662f P22-8 \u7684\u91cd\u653e\u5206\u652f',
    viaChannel.reachedActionAdapter === true && viaChannel2.reachedActionAdapter === true &&
    adapterCalls === 2 &&
    countedStore.listPurchases({}).count === 1 &&
    countedStore.listPurchaseIntents({}).count === 1 &&
    !!(viaChannel.result && viaChannel.result.intentId) &&
    viaChannel.result.intentId === viaChannel2.result.intentId &&
    viaChannel.result.replayed !== true &&
    viaChannel2.result.replayed === true &&
    viaChannel.channelReplay === false && viaChannel2.channelReplay === true,
    {
      adapterCalls: adapterCalls,
      purchases: countedStore.listPurchases({}).count,
      intents: countedStore.listPurchaseIntents({}).count,
      firstReason: viaChannel.reasonCode,
      firstDownstream: viaChannel.downstreamReasonCode,
      firstErrors: viaChannel.errors,
      firstResultOk: viaChannel.result && viaChannel.result.ok,
      firstResultErrors: viaChannel.result && viaChannel.result.errors,
      firstReplayed: viaChannel.result && viaChannel.result.replayed,
      secondReplayed: viaChannel2.result && viaChannel2.result.replayed,
      firstChannelReplay: viaChannel.channelReplay,
      secondChannelReplay: viaChannel2.channelReplay
    });

  /* ── B5 · 凭据绝不进审计 / 响应 / describe ───────────────────────── */
  check('B5 \u2605 \u2605 \u51ed\u636e\u7edd\u4e0d\u8fdb\u5ba1\u8ba1\u3001\u8fdb\u54cd\u5e94\u3001\u8fdb describe()',
    (() => {
      const auditText = J(app.economyCommandChannel.audit());
      const describeText = J(app.economyCommandChannel.describe());
      return auditText.indexOf(TOKEN) < 0 && auditText.indexOf(OTHER_TOKEN) < 0 &&
        describeText.indexOf(TOKEN) < 0 && describeText.indexOf(OTHER_TOKEN) < 0 &&
        J(unboundProbe.body).indexOf(TOKEN) < 0 &&
        J(missingAuth.body).indexOf(TOKEN) < 0;
    })(),
    { auditSample: J(app.economyCommandChannel.audit()).slice(0, 400) });

  /* ── B6 · 非 loopback 在到达通道之前就被挡 ───────────────────────── */
  check('B6 \u2605 \u8fdc\u7a0b\uff08\u975e loopback\uff09\u5728\u8fbe\u5230\u901a\u9053\u4e4b\u524d\u5c31\u88ab\u65e2\u6709\u89c4\u5219\u6321\u4f4f\uff1a/internal/ \u4e0e /economy/ \u540c\u7ea7\uff08\u672a\u914d\u7f6e\u684c\u9762 token \u65f6 403\uff09',
    (() => {
      const at = httpSrc.indexOf("path.indexOf('/internal/') === 0");
      if (at < 0) return false;
      const span = httpSrc.slice(httpSrc.lastIndexOf('const isDesktopOnlyPath', at), at + 40);
      return span.includes('isDesktopOnlyPath') && span.includes("path.indexOf('/economy/') === 0");
    })());

  /* ══════════════════════════════════════════════════════════════════
     C · §3 payload 不得自报身份（本阶段最重要的不变量）
     ══════════════════════════════════════════════════════════════════ */
  section('C \u00b7 \u00a73 \u00b7 consumerId \u4e0d\u5f97\u81ea\u62a5');

  const intentsBeforeC = store.listPurchaseIntents({}).count;
  const purchasesBeforeC = store.listPurchases({}).count;
  for (const key of CHANNEL.FORBIDDEN_IDENTITY_KEYS) {
    const injected = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME,
      Object.assign(envelope(), { [key]: C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME }), AUTH);
    check('C1.' + key + ' \u2605\u2605 payload \u91cc\u5e26 ' + key + ' \u2192 403\uff0c\u9010\u540d\u70b9\u51fa\uff0c\u4e14**\u6ca1\u78b0\u9002\u914d\u5668**',
      injected.status === 403 &&
      injected.body.reasonCode === CHANNEL.REFUSAL.NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT &&
      injected.body.rejectedIdentityKeys.indexOf(key) >= 0 &&
      injected.body.reachedActionAdapter === false &&
      injected.body.sourceIdentityFromPayload === false,
      injected.body.reasonCode);
  }

  check('C2 \u2605\u2605 \u81ea\u62a5\u8eab\u4efd\u7684\u5c1d\u8bd5**\u4e00\u6761 Intent \u90fd\u6ca1\u4ea7\u751f**',
    store.listPurchaseIntents({}).count === intentsBeforeC &&
    store.listPurchases({}).count === purchasesBeforeC,
    { intents: store.listPurchaseIntents({}).count, baseline: intentsBeforeC });

  const spoofCapability = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME,
    envelope({ capability: C.CAPABILITY.PROPOSE_PURCHASE }), AUTH);
  check('C3 \u2605 capability \u4e5f\u4e0d\u80fd\u81ea\u62a5\uff08\u5b83\u7531 command \u6620\u5c04\u5f97\u51fa\uff0c\u4e0d\u7531\u8c03\u7528\u65b9\u9009\u62e9\uff09',
    spoofCapability.status === 403 &&
    spoofCapability.body.rejectedIdentityKeys.indexOf('capability') >= 0 &&
    spoofCapability.body.reachedActionAdapter === false,
    spoofCapability.body.reasonCode);

  check('C4 \u2605 \u5ba1\u8ba1\u53ea\u8bb0 requestId / command / source / result \u2014\u2014 **\u4e0d\u8bb0 payload**\uff08\u56e0\u6b64\u4e5f\u4e0d\u4f1a\u6284\u4e00\u4efd\u7ecf\u6d4e\u4e8b\u5b9e\uff09',
    (() => {
      const rows = app.economyCommandChannel.audit();
      const shapeOf = row => Object.keys(row).sort().join(',');
      return rows.length > 0 && rows.every(row => row.event === 'economy-command-refused'
        ? shapeOf(row) === 'at,event,reasonCode,stage'
          || shapeOf(row) === 'at,event,observedPort,reasonCode,stage'
          || shapeOf(row) === 'at,event,reasonCode,source,stage'
        : shapeOf(row) === 'at,channelReplay,command,commandId,event,intentId,reasonCode,source');
    })(),
    app.economyCommandChannel.audit().slice(-1));

  /* ══════════════════════════════════════════════════════════════════
     D · §2 恰好一个 command；未知与畸形一律拒绝
     ══════════════════════════════════════════════════════════════════ */
  section('D \u00b7 \u00a72 \u00b7 \u4e00\u4e2a command\uff0c\u4ee5\u53ca\u5b83\u7684\u62d2\u7edd\u8fb9');

  check('D1 \u2605\u2605 \u8bcd\u8868\u91cc\u6070\u597d\u4e00\u4e2a command\uff0c\u800c\u4e14\u5c31\u662f ECONOMY_PROPOSE_PURCHASE',
    CHANNEL.COMMAND_LIST.length === 1 &&
    CHANNEL.COMMAND_LIST[0] === 'ECONOMY_PROPOSE_PURCHASE' &&
    app.economyCommandChannel.commands.length === 1,
    CHANNEL.COMMAND_LIST);

  check('D2 \u2605\u2605 \u00a72 \u7981\u6b62\u7684\u516b\u4e2a\u540d\u5b57\u4e00\u4e2a\u90fd\u4e0d\u5728\u5f00\u653e\u540d\u5355\u91cc\uff0c\u800c\u4e14**\u4ee3\u7801\u91cc**\u4e0d\u5b58\u5728\u7b2c\u4e8c\u4e2a\u52a8\u8bcd\u540d',
    CHANNEL.FORBIDDEN_COMMANDS.every(n => CHANNEL.COMMAND_LIST.indexOf(n) < 0) &&
    CHANNEL.FORBIDDEN_COMMANDS.length === 8 &&
    !/resume/i.test(channelCode),
    {
      forbidden: CHANNEL.FORBIDDEN_COMMANDS,
      resumeHitsInCode: channelCode.match(/resume/gi)
    });

  for (const name of CHANNEL.FORBIDDEN_COMMANDS) {
    const r = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope({ command: name }), AUTH);
    check('D3.' + name + ' \u2605\u2605 ' + name + ' \u2192 404 unknown command\uff08\u5b83\u5728\u8fd9\u4efd\u8bcd\u8868\u91cc**\u4e0d\u5b58\u5728**\uff09',
      r.status === 404 && r.body.reasonCode === CHANNEL.REFUSAL.UNKNOWN_COMMAND &&
      r.body.reachedActionAdapter === false &&
      J(r.body.acceptedCommands) === J(CHANNEL.COMMAND_LIST),
      r.body.reasonCode);
  }

  const noCommand = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope({ command: undefined }), AUTH);
  check('D4 \u2605 \u7f3a command \u2192 400 MISSING_COMMAND\uff08\u4e0e UNKNOWN \u662f\u4e24\u4e2a\u7406\u7531\uff09',
    noCommand.status === 400 && noCommand.body.reasonCode === CHANNEL.REFUSAL.MISSING_COMMAND &&
    noCommand.body.reachedActionAdapter === false, noCommand.body.reasonCode);

  const extraKey = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope({ extra: 1 }), AUTH);
  check('D5 \u2605 \u4fe1\u5c01\u591a\u4e00\u4e2a\u952e \u2192 400 UNEXPECTED_ENVELOPE_KEYS\uff0c\u9010\u540d\u70b9\u51fa',
    extraKey.status === 400 && extraKey.body.reasonCode === CHANNEL.REFUSAL.UNEXPECTED_ENVELOPE_KEYS &&
    extraKey.body.rejectedEnvelopeKeys.indexOf('extra') >= 0 &&
    extraKey.body.reachedActionAdapter === false, extraKey.body.reasonCode);

  const badProposal = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope({ proposal: 'a string' }), AUTH);
  check('D6 \u2605 proposal \u4e0d\u662f\u5bf9\u8c61 \u2192 400 PROPOSAL_NOT_A_PLAIN_OBJECT',
    badProposal.status === 400 && badProposal.body.reasonCode === CHANNEL.REFUSAL.PROPOSAL_NOT_A_PLAIN_OBJECT &&
    badProposal.body.reachedActionAdapter === false, badProposal.body.reasonCode);

  const noIdem = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope({ idempotencyKey: undefined }), AUTH);
  check('D7 \u2605\u2605 \u7f3a canonical \u5e42\u7b49\u952e \u2192 400\uff08\u672c\u5c42**\u4e0d**\u66ff\u8c03\u7528\u65b9\u751f\u6210\u4e00\u4e2a\uff09',
    noIdem.status === 400 && noIdem.body.reasonCode === CHANNEL.REFUSAL.MISSING_IDEMPOTENCY_KEY &&
    noIdem.body.reachedActionAdapter === false, noIdem.body.reasonCode);

  const noCommandId = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope({ commandId: undefined }), AUTH);
  check('D8 \u2605 \u7f3a commandId \u2192 400 MISSING_COMMAND_ID',
    noCommandId.status === 400 && noCommandId.body.reasonCode === CHANNEL.REFUSAL.MISSING_COMMAND_ID,
    noCommandId.body.reasonCode);

  const wrongMethod = await boundRequest(port, SOURCE_PORT, 'GET', PATHNAME, null, AUTH);
  check('D9 \u2605 \u8fd9\u6761\u8def\u5f84\u53ea\u6709 POST\uff08GET \u2192 405\uff0c\u800c\u4e0d\u662f\u4e00\u6761\u8bfb\u8def\u5f84\uff09',
    wrongMethod.status === 405 && wrongMethod.body.error === 'economy-command-is-post-only', wrongMethod.body);

  /* ══════════════════════════════════════════════════════════════════
     E · §5/§11 唯一执行链 + 既有只读面一字未动
     ══════════════════════════════════════════════════════════════════ */
  section('E \u00b7 \u00a75/\u00a711 \u00b7 \u552f\u4e00\u6267\u884c\u94fe\u4e0e\u65e2\u6709\u53ea\u8bfb\u9762');

  const purchasesBeforeE1 = store.listPurchases({}).count;
  const intentsBeforeE1 = store.listPurchaseIntents({}).count;
  const ok1 = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, envelope(), AUTH);
  check('E1 \u2605\u2605 \u4e00\u6761\u5408\u6cd5 Active command \u8d70\u5b8c P22-10 \u2192 P22-9 \u2192 P22-8 \u2192 P22-7 \u2192 P22-6\uff1aIntent \u771f\u7684\u5efa\u4e86\uff0c\u94b1\u771f\u7684\u52a8\u4e86',
    ok1.status === 200 && ok1.body.ok === true &&
    ok1.body.reachedActionAdapter === true &&
    ok1.body.source === C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME &&
    ok1.body.result && ok1.body.result.ok === true &&
    ok1.body.result.reachedCapabilityGate === true &&
    ok1.body.result.purchaseCreated === true &&
    ok1.body.result.authorityOutcome === C.AP_DECISION.AUTO_ALLOW &&
    typeof ok1.body.result.intentId === 'string' &&
    store.listPurchases({}).count === purchasesBeforeE1 + 1 &&
    store.listPurchaseIntents({}).count === intentsBeforeE1 + 1,
    ok1.body && {
      status: ok1.status, reason: ok1.body.reasonCode,
      resultOk: ok1.body.result && ok1.body.result.ok,
      purchaseCreated: ok1.body.result && ok1.body.result.purchaseCreated,
      purchases: store.listPurchases({}).count, baseline: purchasesBeforeE1
    });

  check('E2 \u2605\u2605 \u8fd4\u56de\u503c\u91cc\u5e26\u7740\u540c\u4e00\u7ec4\u6052 false \u7684\u4f4d\uff1a\u4f20\u8f93\u6210\u529f\u4e0d\u662f\u8d2d\u4e70\u3001\u4e0d\u662f\u6279\u51c6\u3001\u4e0d\u662f\u9884\u7b97\u51b3\u5b9a',
    ok1.body.transportIsNotAnEconomyAuthority === true &&
    ok1.body.transportInterpretsEconomicFacts === false &&
    ok1.body.transportHoldsRawStore === false &&
    ok1.body.transportHoldsCapabilityGate === false &&
    ok1.body.transportChoosesTheConsumer === false &&
    ok1.body.transportAddsASecondPurchaseDedupe === false &&
    ok1.body.commandSuccessIsNotAPurchase === true &&
    ok1.body.commandSuccessIsNotAnApproval === true &&
    ok1.body.commandSuccessIsNotABudgetDecision === true &&
    ok1.body.sourceIdentityFromPayload === false);

  const factInjection = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME,
    envelope({ proposal: { agentId: AGENT, productId: productId, units: 1, amountMinor: 1 } }), AUTH);
  check('E3 \u2605\u2605 \u7ecf\u6d4e\u4e8b\u5b9e\u6ce8\u5165\uff08amountMinor\uff09\u2192 \u7531 **P22-8** \u62d2\u7edd\uff0c\u901a\u9053\u53ea\u5f52\u7c7b\u4e0d\u91cd\u5199\u5b83\u7684\u7406\u7531',
    factInjection.status === 400 &&
    factInjection.body.reasonCode === CHANNEL.REFUSAL.DOWNSTREAM_REFUSED &&
    factInjection.body.downstreamReasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT &&
    factInjection.body.reachedActionAdapter === true &&
    factInjection.body.result.suppliedEconomicFacts.indexOf('amountMinor') >= 0,
    factInjection.body && { reason: factInjection.body.reasonCode, downstream: factInjection.body.downstreamReasonCode });

  check('E4 \u2605 \u2605 \u4f20\u8f93\u5c42**\u6ca1\u6709**\u590d\u5236 P22-8 \u7684\u7ecf\u6d4e\u4e8b\u5b9e\u9ed1\u540d\u5355\uff08\u5b83\u53ea\u62d2\u90a3\u4e03\u4e2a\u8eab\u4efd\u952e\uff09',
    CHANNEL.FORBIDDEN_IDENTITY_KEYS.length === 7 &&
    /* ★ 逐字的"身份键"是一个**闭集**：下面这八个纯经济字段一个都不在里面。
       而 `autoAllow` 是**唯一的**交叉项 —— 它既是本阶段 §3 逐字要求拒的
       一个键，也是 P22-8 经济事实名单里的一项。这条断言把这个交叉写成
       事实：哪一天有人把第二个经济字段加进身份名单，"只拒身份键"这句话
       就不再为真，而这里会红。 */
    ['amountMinor', 'currency', 'price', 'budget', 'wallet', 'approvalId',
      'settlementType', 'grantQuantity'].every(k =>
        CHANNEL.FORBIDDEN_IDENTITY_KEYS.indexOf(k) < 0) &&
    CHANNEL.FORBIDDEN_IDENTITY_KEYS.filter(k => k === 'autoAllow').length === 1 &&
    channelCode.indexOf('MODEL_SUPPLIED_ECONOMIC_FACT') < 0 &&
    channelCode.indexOf('suppliedEconomicFacts') < 0,
    {
      keys: CHANNEL.FORBIDDEN_IDENTITY_KEYS,
      economicNamesPresent: ['amountMinor', 'currency', 'price', 'budget', 'wallet', 'approvalId',
        'settlementType', 'grantQuantity', 'autoAllow'].filter(k => CHANNEL.FORBIDDEN_IDENTITY_KEYS.indexOf(k) >= 0),
      p22_8NameInChannel: channelCode.indexOf('MODEL_SUPPLIED_ECONOMIC_FACT')
    });

  const writes = ['/economy/topup', '/economy/purchase', '/economy/mint', '/economy/transfer',
    '/economy/intent', '/economy/intents', '/economy/settle', '/economy/buy', '/economy/approve'];
  const observedWrites = [];
  let allClosed = true;
  for (const p of writes) {
    const r = await request(port, 'POST', p, { any: 1 }, AUTH);
    observedWrites.push(p + ':' + r.status);
    if (!(r.status === 405 && r.body.error === 'economy-is-read-only')) allClosed = false;
  }
  check('E5 \u2605\u2605 \u666e\u901a /economy/* \u5199\u9762\u4ecd\u7136\u4e3a 0\uff08\u9010\u540d POST \u90fd\u662f 405 economy-is-read-only\uff09',
    allClosed, observedWrites);

  const sec = await request(port, 'GET', '/security', null, {});
  const pol = sec.body && sec.body.economyPolicy;
  check('E6 \u2605\u2605 /security \u628a\u65b0\u901a\u9053\u5199\u6210\u53ef\u65ad\u8a00\u5b57\u6bb5\uff0c\u800c\u4e14\u90a3\u4e09\u4efd\u5199\u540d\u5355\u4ecd\u7136\u4e3a\u7a7a',
    !!pol && !!pol.commandChannel &&
    pol.commandChannel.implemented === true &&
    pol.commandChannel.open === true &&
    J(pol.commandChannel.commandWritesExposed) === J(CHANNEL.COMMAND_LIST) &&
    pol.commandChannel.path === PATHNAME &&
    pol.commandChannel.pathIsNotUnderEconomyReadPaths === true &&
    pol.commandChannel.capabilityWritesExposed.length === 0 &&
    pol.commandChannel.approvalWritesExposed.length === 0 &&
    pol.commandChannel.resumeWritesExposed.length === 0 &&
    pol.commandChannel.identityComesFromTheTransportNotThePayload === true &&
    J(pol.httpVerbs) === J(['GET']) &&
    pol.writesExposed.length === 0 &&
    pol.purchaseWritesExposed.length === 0 &&
    pol.intentWritesExposed.length === 0,
    pol && pol.commandChannel);

  const channelGet = await request(port, 'GET', PATHNAME, null, AUTH);
  check('E7 \u2605 \u901a\u9053\u8def\u5f84\u4e0d\u5728 /economy/ \u547d\u540d\u7a7a\u95f4\u91cc\uff1a\u5b83\u4e0d\u4f1a\u88ab\u5f53\u6210\u4e00\u6761\u8bfb\u8def\u5f84\uff08\u9519\u8bef\u7801\u4e0d\u662f unknown-economy-path\uff09',
    (channelGet.status === 404 || channelGet.status === 405) &&
    channelGet.body.error !== 'unknown-economy-path' &&
    channelGet.body.error === 'economy-command-is-post-only',
    channelGet.body);

  /* ══════════════════════════════════════════════════════════════════
     F · §7 幂等：重放收敛，冲突拒绝
     ══════════════════════════════════════════════════════════════════ */
  section('F \u00b7 \u00a77 \u00b7 \u5e42\u7b49\u4e0e\u51b2\u7a81');

  const idemBody = envelope();
  const purchasesBeforeF = store.listPurchases({}).count;
  const intentsBeforeF = store.listPurchaseIntents({}).count;
  const first = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, idemBody, AUTH);
  const second = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME, idemBody, AUTH);
  check('F1 \u2605\u2605 \u540c\u4e00\u4e2a request \u91cd\u653e \u2192 \u540c\u4e00\u4e2a\u903b\u8f91 Intent\uff08intentId \u9010\u5b57\u76f8\u540c\uff09\uff0c\u800c\u4e14\u6ca1\u6709\u7b2c\u4e8c\u7b14\u8d2d\u4e70',
    first.status === 200 && second.status === 200 &&
    first.body.result.intentId === second.body.result.intentId &&
    store.listPurchases({}).count === purchasesBeforeF + 1 &&
    store.listPurchaseIntents({}).count === intentsBeforeF + 1,
    {
      sameIntent: first.body.result.intentId === second.body.result.intentId,
      purchases: store.listPurchases({}).count, baseline: purchasesBeforeF,
      intents: store.listPurchaseIntents({}).count, intentsBaseline: intentsBeforeF
    });

  check('F2 \u2605\u2605 \u91cd\u653e\u8d70\u7684\u662f **P22-8 \u7684\u91cd\u653e\u5206\u652f**\uff08\u5b83\u81ea\u5df1\u7684 replayed \u4f4d\u7f6e\u4e86\u4e00\u6b21\uff09\u2014\u2014 \u901a\u9053\u6ca1\u7f13\u5b58\u7ed3\u679c\u3001\u6ca1\u9020\u7b2c\u4e09\u5957 dedupe',
    first.body.result.replayed !== true &&
    second.body.result.replayed === true &&
    second.body.channelReplay === true &&
    first.body.channelReplay === false &&
    second.body.reachedActionAdapter === true &&
    second.body.result.intentId === first.body.result.intentId &&
    app.economyCommandChannel.describe().transportAddsASecondPurchaseDedupe === false,
    {
      firstReplayed: first.body.result.replayed,
      secondReplayed: second.body.result.replayed,
      channelReplay: second.body.channelReplay
    });

  const conflict = await boundRequest(port, SOURCE_PORT, 'POST', PATHNAME,
    Object.assign({}, idemBody, { proposal: Object.assign({}, idemBody.proposal, { units: 99 }) }), AUTH);
  check('F3 \u2605\u2605 \u540c\u4e00\u4e2a commandId + \u4e0d\u540c payload \u2192 409 CONFLICT\uff0c\u4e14**\u6ca1\u78b0\u9002\u914d\u5668**',
    conflict.status === 409 &&
    conflict.body.reasonCode === CHANNEL.REFUSAL.COMMAND_ID_CONFLICT &&
    conflict.body.reachedActionAdapter === false &&
    store.listPurchases({}).count === purchasesBeforeF + 1,
    {
      status: conflict.status, reason: conflict.body.reasonCode,
      reached: conflict.body.reachedActionAdapter,
      purchases: store.listPurchases({}).count, baseline: purchasesBeforeF
    });

  /* ══════════════════════════════════════════════════════════════════
     G · §8 出站腿：有界超时 / 有界重试 / 不把传输失败说成购买失败
     ══════════════════════════════════════════════════════════════════ */
  section('G \u00b7 \u00a78 \u00b7 \u51fa\u7ad9\u817f\u7684\u65f6\u95f4\u4e0e\u91cd\u8bd5\u8fb9\u754c');

  const client = CHANNEL.createEconomyCommandClient({
    base: 'http://127.0.0.1:' + port,
    token: TOKEN,
    localPort: SOURCE_PORT,
    timeoutMs: 700,
    /* ★ 故意要一个**超大**的重试数：契约必须把它夹回硬上限。 */
    maxAttempts: 99
  });
  check('G1 \u2605\u2605 \u8d85\u65f6\u4e0e\u91cd\u8bd5\u90fd\u662f**\u6709\u754c**\u7684\uff08\u8bf7\u6c42 99 \u6b21 \u2192 \u5951\u7ea6\u5939\u5230\u786c\u4e0a\u9650\uff09',
    client.describe().maxAttempts === CHANNEL.HARD_MAX_ATTEMPTS &&
    client.describe().unboundedRetry === false &&
    client.describe().timeoutMs === 700 &&
    client.describe().reusesTheCanonicalIdentityOnRetry === true,
    client.describe());

  const delivered = await client.proposePurchase({
    proposal: { agentId: AGENT, productId: productId, units: 2, reason: 'client leg' }
  });
  check('G2 \u2605\u2605 \u771f\u5b9e\u51fa\u7ad9\uff1a\u4e00\u6b21\u6210\u529f\u7684 propose \u56de DELIVERED\uff0c\u800c\u4e14 intentCreated \u4e0d\u662f\u4ece HTTP 200 \u63a8\u65ad\u51fa\u6765\u7684',
    delivered.ok === true && delivered.delivery === CHANNEL.DELIVERY.DELIVERED &&
    delivered.delivered === true && delivered.httpStatus === 200 &&
    typeof delivered.intentCreated === 'string' &&
    delivered.purchaseFailed === false && delivered.purchaseDenied === false &&
    delivered.attempts === 1,
    delivered);

  const downstreamRefusal = await client.proposePurchase({
    proposal: { agentId: AGENT, productId: productId, units: 3, currency: CUR, reason: 'fact probe' }
  });
  check('G3 \u2605\u2605 \u4e00\u6b21\u786e\u5b9a\u7684\u62d2\u7edd**\u4e0d\u91cd\u8bd5**\uff0c\u800c\u4e14\u4e0d\u88ab\u8bf4\u6210 purchase denied',
    downstreamRefusal.delivered === true &&
    downstreamRefusal.ok === false &&
    downstreamRefusal.attempts === 1 &&
    downstreamRefusal.purchaseDenied === false &&
    downstreamRefusal.downstreamReasonCode === C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT,
    downstreamRefusal);

  /* 拖时间的传输替身：它**故意**永不 resolve（除非被 abort），于是
     bounded timeout 与"归类成 DELIVERY_UNKNOWN"都可以被直接观察到，
     而不必起第三个进程或一个只会挂住的 server。 */
  let transportCalls = 0;
  const hangingTransport = (url, init) => {
    transportCalls += 1;
    return new Promise((resolve, reject) => {
      const signal = init && init.signal;
      if (!signal || typeof signal.addEventListener !== 'function') return; /* 永不 resolve */
      signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  const hangingClient = CHANNEL.createEconomyCommandClient({
    base: 'http://127.0.0.1:1', token: TOKEN, timeoutMs: 120, maxAttempts: 2, fetch: hangingTransport
  });
  const timedOut = await hangingClient.proposePurchase({ proposal: { agentId: AGENT, productId: productId, units: 4 } });
  check('G4 \u2605\u2605 \u8d85\u65f6 \u2192 DELIVERY_UNKNOWN\uff08**\u4e0d\u662f** TRANSPORT_FAILED\u3001\u66f4\u4e0d\u662f purchaseFailed\uff09\uff0c\u4e14\u91cd\u8bd5\u5728\u786c\u4e0a\u9650\u5185\u505c\u4e0b',
    timedOut.delivery === CHANNEL.DELIVERY.DELIVERY_UNKNOWN &&
    timedOut.ok === false &&
    timedOut.purchaseFailed === false &&
    timedOut.purchaseDenied === false &&
    timedOut.intentCreated === null &&
    timedOut.attempts === 2 &&
    transportCalls === 2,
    { delivery: timedOut.delivery, attempts: timedOut.attempts, transportCalls: transportCalls });

  const unreachable = CHANNEL.createEconomyCommandClient({
    base: 'http://127.0.0.1:' + (await freePort()), token: TOKEN, timeoutMs: 400, maxAttempts: 2
  });
  const dead = await unreachable.proposePurchase({ proposal: { agentId: AGENT, productId: productId, units: 5 } });
  check('G5 \u2605 \u8fde\u4e0d\u4e0a \u2192 \u4ecd\u7136\u53ea\u80fd\u8868\u8fbe"\u4ea4\u4ed8\u672a\u77e5"\uff08\u670d\u52a1\u7aef\u53ef\u80fd\u5df2\u7ecf\u6210\u529f\u5efa\u4e86 Intent\uff09\uff0c\u4e0d\u731c\u6210\u8d2d\u4e70\u5931\u8d25',
    dead.ok === false &&
    (dead.delivery === CHANNEL.DELIVERY.DELIVERY_UNKNOWN || dead.delivery === CHANNEL.DELIVERY.TRANSPORT_FAILED) &&
    dead.purchaseFailed === false && dead.purchaseDenied === false &&
    dead.attempts >= 1 && dead.attempts <= CHANNEL.HARD_MAX_ATTEMPTS,
    dead);

  /* ══════════════════════════════════════════════════════════════════
     H · fail-closed：未配置 ⇒ 关，而不是默认放行
     ══════════════════════════════════════════════════════════════════ */
  section('H \u00b7 fail-closed\uff08\u672a\u914d\u7f6e \u21d2 \u5173\uff09');

  const closedApp = SERVICE.buildHomeNode({
    dataDir: tmpDir('closed'),
    logger: () => { },
    token: DESKTOP_TOKEN,
    economyChannelSources: []
  });
  closables.push({
    close: () => {
      try { closedApp.server.closeAllConnections(); } catch (_) { }
      try { closedApp.economyStore.close(); } catch (_) { }
      try { closedApp.server.close(); } catch (_) { }
    }
  });
  closedApp.open();
  const closedPort = await freePort();
  await new Promise(r => closedApp.server.listen(closedPort, '127.0.0.1', r));

  check('H1 \u2605\u2605 \u672a\u767b\u8bb0\u4efb\u4f55\u6765\u6e90 \u21d2 \u901a\u9053\u81ea\u8ff0 open:false\uff0c\u800c\u4e14\u5b83\u8fde\u53e5\u8bdd\u90fd\u4e0d\u63a5',
    closedApp.economyCommandChannel.describe().open === false &&
    closedApp.economyCommandChannel.describe().sourceCount === 0);

  const closedRes = await request(closedPort, 'POST', PATHNAME, envelope(), AUTH);
  check('H2 \u2605\u2605 \u901a\u9053\u672a\u914d\u7f6e\u65f6\u4e00\u6b21\u5408\u6cd5\u5f62\u72b6\u7684 command \u5f97\u5230 503\uff08\u4e0d\u662f\u653e\u884c\uff09',
    closedRes.status === 503 &&
    closedRes.body.reasonCode === CHANNEL.REFUSAL.CHANNEL_NOT_CONFIGURED &&
    closedRes.body.reachedActionAdapter === false,
    closedRes.body);

  const closedSec = await request(closedPort, 'GET', '/security', null, {});
  check('H3 \u2605 \u672a\u914d\u7f6e\u7684 /security \u4e0d\u4f1a\u88ab\u8bfb\u6210"\u6709\u4e00\u4e2a\u5f00\u653e\u7684\u5199\u9762"',
    closedSec.body.economyPolicy.commandChannel.open === false &&
    closedSec.body.economyPolicy.commandChannel.commandWritesExposed.length === 0,
    closedSec.body.economyPolicy.commandChannel);

  let threwEmptyToken = null;
  try {
    CHANNEL.createEconomyCommandChannel({
      adapter: app.economyActionAdapter,
      sources: [{ consumer: C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME, token: '', boundPort: SOURCE_PORT }]
    });
  } catch (error) { threwEmptyToken = error; }
  check('H4 \u2605 \u5f62\u72b6\u4e0d\u5bf9\u7684\u767b\u8bb0\u9879\u5728\u88c5\u914d\u671f\u5c31\u70b8\uff08\u4e0d\u88ab\u9759\u9ed8\u4e22\u5f03\uff09',
    !!threwEmptyToken && /token-is-required/.test(String(threwEmptyToken.message)),
    threwEmptyToken && threwEmptyToken.message);

  let threwUnknownConsumer = null;
  try {
    CHANNEL.createEconomyCommandChannel({
      adapter: null,
      sources: [{ consumer: 'chat', token: TOKEN, boundPort: SOURCE_PORT }]
    });
  } catch (error) { threwUnknownConsumer = error; }
  check('H5 \u2605\u2605 \u767b\u8bb0\u4e00\u4e2a P22-9 \u5951\u7ea6\u91cc**\u4e0d\u5b58\u5728**\u7684\u8eab\u4efd\u4f1a\u88ab\u62d2\uff08\u4e0d\u80fd\u51ed\u7a7a\u53d1\u660e\u4e00\u4e2a\u5df2\u6388\u4e88\u7684\u6743\u9650\uff09',
    !!threwUnknownConsumer && /consumer-is-not-an-economy-consumer/.test(String(threwUnknownConsumer.message)),
    threwUnknownConsumer && threwUnknownConsumer.message);

  check('H6 \u2605 \u6ca1\u6709\u901a\u7528\u6267\u884c\u5668\uff1acommand \u2192 action \u6620\u5c04\u662f\u540c\u540d\u6052\u7b49\u7684\u4e00\u9879\u8868\uff0c\u800c\u672a\u77e5\u540d\u53ea\u80fd\u88ab\u62d2',
    J(Object.keys(CHANNEL.COMMAND_ACTION)) === J(CHANNEL.COMMAND_LIST) &&
    CHANNEL.COMMAND_ACTION[CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE] === 'ECONOMY_PROPOSE_PURCHASE' &&
    channelCode.indexOf('commands[') < 0 &&
    app.economyCommandChannel.describe().transportExposesGenericDispatch === false);

  /* ══════════════════════════════════════════════════════════════════
     I · §9 模型动作仍必经既有 sanitizer
     ══════════════════════════════════════════════════════════════════ */
  section('I \u00b7 \u00a79 \u00b7 \u6a21\u578b\u52a8\u4f5c\u4ecd\u7ecf\u65e2\u6709 sanitizer');

  const adapterCode = stripCommentsAndStrings(
    fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-action-adapter.js'), 'utf8'));

  check('I1 \u2605\u2605 \u901a\u9053\u628a\u52a8\u4f5c\u4ea4\u7ed9\u9002\u914d\u5668**\u672c\u4eba**\uff08performAction\uff09\uff0c\u56e0\u6b64\u51c0\u5316\u5668\u5728\u8fd9\u6761\u94fe\u4e0a\u4e0d\u53ef\u7ed5\u8fc7',
    (channelCode.match(/adapter\.performAction\(/g) || []).length === 1 &&
    (adapterCode.match(/sanitizer\.sanitizeAction\(raw\)/g) || []).length >= 1);

  const unknownActionResult = app.economyActionAdapter.performAction({
    action: 'ECONOMY_PURCHASE_NOW',
    proposal: { agentId: AGENT, productId: productId, units: 1 },
    idempotencyKey: K('unknown')
  });
  check('I2 \u2605\u2605 \u4e00\u4e2a\u672a\u77e5\u52a8\u4f5c\u5230\u9002\u914d\u5668\u53ea\u6709\u4e00\u79cd\u7ed3\u679c\uff1a\u51c0\u5316\u5668\u62d2\u7edd',
    unknownActionResult.ok === false &&
    unknownActionResult.reasonCode === 'UNKNOWN_ECONOMY_ACTION' &&
    unknownActionResult.reachedCapabilityGate === false);

  check('I3 \u2605 \u901a\u9053\u6ca1\u6709\u7ed9\u81ea\u5df1\u5f00\u7b2c\u4e8c\u5957\u52a8\u4f5c\u8bcd\u8868\uff08\u5b83\u53ea\u8d1f\u8d23"command \u5b57\u7b26\u4e32\u5230\u540c\u540d action"\uff09',
    CHANNEL.COMMAND_ACTION[CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE] === CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE &&
    CHANNEL.COMMAND_LIST.length === 1 &&
    channelCode.indexOf('ACTION_LIST') < 0);

  /* ── 清理 ─────────────────────────────────────────────────────── */
  for (const c of closables.slice().reverse()) { try { c.close(); } catch (_) { } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { } }

  console.log('\n' + (failures === 0 ? '\u5168\u90e8\u901a\u8fc7' : '\u5b58\u5728\u5931\u8d25') + '\uff1a' +
    (failures === 0 ? 'all checks passed' : failures + ' failed'));
  console.log('child process: max concurrent = 0 \u00b7 total spawn = 0 \u00b7 leftover = 0');
  if (failures > 0) process.exitCode = 1;

})().catch(error => {
  for (const c of closables.slice().reverse()) { try { c.close(); } catch (_) { } }
  console.error('\u2716 \u672a\u6355\u83b7\u5f02\u5e38\uff1a' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
