'use strict';

/*
 * Internal Beyond — Home Node (canonical chat authority)
 *
 * M1-A：这个进程是 chatMessages 的 canonical authority。
 * The browser still executes its own chat orchestration on the desktop surface;
 * what moves here is **authority over the world's chat records**, not the desktop
 * UI. See docs/HOME_NODE_CHAT.md for the full authority/mirror/fallback model.
 *
 * 与其它本地服务的边界（刻意如此）：
 *   · 只绑 127.0.0.1（IB_HOME_NODE_HOST 可覆盖，但默认值就是 loopback）；
 *   · 不 require bridge/routes.js，因此没有 /api/llm-proxy、没有工具表、没有支付；
 *   · 不是 Mobile Gateway —— 没有设备身份、没有配对、没有 LAN 开关。
 *
 * 存储：%LOCALAPPDATA%\InternalBeyond\home-node\home-node.db（node:sqlite，零 npm 依赖）。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const createStore = require('../services/home-node/chat-store.js');
const createHttp = require('../services/home-node/http.js');
const createExecutor = require('../services/home-node/execution.js');
const createDeviceRegistry = require('../services/home-node/device-registry.js');
const createMobileGateway = require('../services/home-node/mobile-gateway.js');
const createNodeModelPort = require('../active/node-model-port.js');

if (typeof fetch !== 'function') {
  console.error('Internal Beyond Home Node requires Node.js 18 or newer.');
  process.exit(1);
}

const HOST = String(process.env.IB_HOME_NODE_HOST || '127.0.0.1');
const PORT = Math.max(1, Math.min(65535, Number(process.env.IB_HOME_NODE_PORT) || 23118));
const DATA_DIR = process.env.IB_HOME_NODE_DATA_DIR ||
  (process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'InternalBeyond', 'home-node')
    : path.join(os.homedir(), '.internal-beyond', 'home-node'));
const TOKEN = String(process.env.IB_HOME_NODE_TOKEN || '');
const ALLOWED_ORIGINS = String(process.env.IB_HOME_NODE_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
/* Mobile Gateway 的额外出站 Origin 白名单。**不是**安全边界（设备 token 才是），
   只是"哪些浏览器外壳允许读响应"的兼容开关：capacitor://localhost / null /
   loopback 已经内建允许，这里用于未来真的换了壳的情况。 */
const MOBILE_ORIGINS = String(process.env.IB_HOME_NODE_MOBILE_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const SERVICE_VERSION = '1.0.0';

/* 只读探针用的版本号：与产品版本保持一致（VERSION 文件），读不到时退回服务版本。
   绝不因为版本文件缺失而拒绝启动。 */
function productVersion() {
  try { return fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim() || SERVICE_VERSION; }
  catch (_) { return SERVICE_VERSION; }
}

/* ── 日志：与 local-services-runner 的 redact() 同一条纪律 ——
     apiKey / Authorization / token 一律掩码；正文永远不进日志。 ── */
function redact(text) {
  let out = String(text == null ? '' : text);
  out = out.replace(/(\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|bearer|authorization|x-ib-token|x-ib-home-token)\b\s*[:=]\s*)(['"]?)[^\s,'";]{4,}/gi,
    (m, p1, p2) => p1 + (p2 || '') + '***' + (p2 || ''));
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, '****');
  return out;
}
function log(level, event, fields) {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + event +
    (fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '');
  const safe = redact(line);
  if (level === 'error') console.error(safe); else console.log(safe);
}

/* ── 数据目录：先建目录，失败必须**明确报错**而不是静默换路径。 ── */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
catch (error) {
  console.error('Home Node cannot create its data directory: ' + DATA_DIR + ' — ' + (error && error.message || error));
  process.exit(1);
}

const store = createStore({ dataDir: DATA_DIR, logger: (event, fields) => log('info', event, fields) });
const port = createNodeModelPort({});
const executor = createExecutor({
  store,
  port,
  logger: (event, fields) => log('info', event, fields)
});

/* ── 绑定地址判定（Phase 2/20）─────────────────────────────────────────
   **没有设备鉴权就绝不监听 LAN。** 这不是"最好别"的软约束，而是启动前的硬门：
   设备注册表必须成功打开，否则非 loopback 绑定直接拒绝启动。
   绝不静默降级成"先绑上再说" —— 那等于把一个没有身份概念的聊天库
   挂到整个局域网里。 */
function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!value) return false;
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (/^127\./.test(value)) return true;
  /* 其余一律按"非 loopback"处理（含 0.0.0.0 / :: / 具体 LAN 地址 / 主机名）。 */
  return false;
}
const LOOPBACK_BIND = isLoopbackHost(HOST);

/* ── LAN 主机名（配对载荷用）──────────────────────────────────────────
   只在真的绑到 LAN 时才有意义；绑 loopback 时返回空串，配对载荷会如实
   声明 lanReachable:false，而不是给一个手机永远连不上的地址。 */
function lanAddress() {
  if (LOOPBACK_BIND) return '';
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const entry of interfaces[name] || []) {
        const family = String(entry.family);
        if ((family === 'IPv4' || family === '4') && !entry.internal) return String(entry.address);
      }
    }
  } catch (_) { /* 拿不到就返回空串，绝不猜 */ }
  return '';
}

/* ── 组装一个完整的 Home Node 实例（不监听）──────────────────────────
   这是**唯一**一处把 chat store / 设备注册表 / executor / gateway / HTTP
   接起来的代码。服务入口用它（然后 listen），每个 HTTP 测试进程也用它
   （然后在临时端口上 listen）。

   为什么必须是同一处：网关的协议语义只能在真实服务上验证（真实 token 校验、
   真实体积上限、真实 SSE 连接），而 Windows 上不能开 unix domain socket
   （实测 EACCES），所以"每个测试一条隔离连接"的唯一可行方式就是
   **每个测试一个真实端口**。如果测试自己复制一遍接线，它验证的就不再是
   生产装配（这正是"测试与产品漂移"最典型的来源）。 */
function buildHomeNode(options) {
  options = options || {};
  const dataDir = options.dataDir || DATA_DIR;
  const serviceLog = options.logger || ((level, event, fields) => log(level, event, fields));
  const instanceStore = options.store || createStore({ dataDir: dataDir, logger: (e, f) => serviceLog('info', e, f) });
  const instanceRegistry = options.registry || createDeviceRegistry({ dataDir: dataDir, logger: (e, f) => serviceLog('info', e, f) });
  const instanceExecutor = options.executor || createExecutor({
    store: instanceStore,
    port: options.port || createNodeModelPort({}),
    logger: (e, f) => serviceLog('info', e, f)
  });
  const host = options.host || HOST;
  const loopbackBind = isLoopbackHost(host);
  const instanceGateway = options.gateway || createMobileGateway({
    store: instanceStore,
    registry: instanceRegistry,
    executor: instanceExecutor,
    version: options.version || productVersion(),
    allowedOrigins: options.mobileOrigins || MOBILE_ORIGINS,
    lanMode: !loopbackBind,
    lanHost: options.lanAddress || lanAddress,
    port: options.listenPort || PORT,
    logger: serviceLog
  });
  const instanceHttp = createHttp({
    store: instanceStore,
    executor: instanceExecutor,
    gateway: instanceGateway,
    token: options.token === undefined ? TOKEN : options.token,
    version: options.version || productVersion(),
    allowedOrigins: options.allowedOrigins || ALLOWED_ORIGINS,
    logger: serviceLog
  });
  /* 打开顺序有语义：chat store 先开（它负责损坏隔离 —— 会给坏库改名），
     设备表与它同库，必须等隔离完成之后再连。 */
  function open() {
    const openedStore = instanceStore.open();
    instanceRegistry.open();
    return openedStore;
  }
  function close() {
    try { instanceGateway.stop(); } catch (_) { /* 已停止 */ }
    /* 关掉监听并**主动断开**所有还在的 keep-alive 连接。
       只调 server.close() 是不够的：它只是停止接受新连接，已建立的空闲
       keep-alive socket 会让事件循环一直活着（测试进程表现为"跑完不退出"，
       实测在 gateway HTTP 测试里就是这个症状）。
       server.closeAllConnections() 是 Node 18.2+ 的正式 API，正是为这种
       "优雅关闭但不想等空闲连接" 的场景提供的。 */
    try { instanceHttp.server.close(); } catch (_) { /* 未监听 */ }
    try {
      if (typeof instanceHttp.server.closeAllConnections === 'function') instanceHttp.server.closeAllConnections();
    } catch (_) { /* 尽力而为 */ }
    try { instanceRegistry.close(); } catch (_) { /* 已关闭 */ }
    try { instanceStore.close(); } catch (_) { /* 已关闭 */ }
  }
  return {
    store: instanceStore,
    registry: instanceRegistry,
    gateway: instanceGateway,
    executor: instanceExecutor,
    httpLayer: instanceHttp,
    server: instanceHttp.server,
    open: open,
    close: close,
    loopbackBind: loopbackBind
  };
}

/* ── 设备注册表 + Mobile Gateway ─────────────────────────────────────
   进程级实例：非 require.main 时被测试复用（见 tests/test_home_node_service.js
   与 tests/test_mobile_gateway_http.js —— 后者用 buildHomeNode 自己建隔离实例）。 */
const registry = createDeviceRegistry({
  dataDir: DATA_DIR,
  logger: (event, fields) => log('info', event, fields)
});
const gateway = createMobileGateway({
  store,
  registry,
  executor,
  version: productVersion(),
  allowedOrigins: MOBILE_ORIGINS,
  lanMode: !LOOPBACK_BIND,
  lanHost: lanAddress,
  port: PORT,
  logger: (level, event, fields) => log(level, event, fields)
});
const httpLayer = createHttp({
  store,
  executor,
  gateway,
  token: TOKEN,
  version: productVersion(),
  allowedOrigins: ALLOWED_ORIGINS,
  logger: (level, event, fields) => log(level, event, fields)
});
const server = httpLayer.server;

/* 让调用方（测试与诊断）能构建一个"已打开 + 已接好网关"的完整实例。 */
function openAll() {
  const opened = store.open();
  registry.open();
  return opened;
}

/* require.main guard：测试可以直接 require 本模块并使用 createStore/createHttp，
   只有真正被当作入口运行时才监听端口。 */
if (require.main === module) {
  let openResult = null;
  try { openResult = openAll(); }
  catch (error) {
    /* SQLite 不可用 / schema 过新 / 设备注册表打不开 → 明确失败退出。
       浏览器侧会把「Home Node 不在线」判为 degraded 并走兼容回退，
       因此这里失败不会阻塞桌面主 UI（P2 纪律）。

       **但非 loopback 绑定时理由必须说清楚**：数据目录问题导致的启动失败
       与"我们不让你在没有设备鉴权的情况下监听 LAN"是两回事，用户看到的
       应当是后者那条可执行的规则（改绑 127.0.0.1 或修数据目录），
       而不是一句笼统的"打不开库"。 */
    if (!LOOPBACK_BIND) {
      console.error('Home Node refuses to listen on ' + HOST + ': its device registry could not be opened, ' +
        'so LAN clients could not be authenticated. Bind 127.0.0.1 or fix the data directory. — ' +
        String((error && error.message) || error));
      process.exit(1);
    }
    console.error('Home Node failed to open its canonical store: ' + (error && error.message || error));
    process.exit(1);
  }

  /* **硬门**：非 loopback 绑定要求设备鉴权子系统已经就绪。
     走到这里注册表已经 open 成功（否则上面的 catch 已经退出），
     但再做一次显式断言 —— 因为这条规则的代价是"静默暴露整个聊天库"，
     值得在启动日志里留下一条可核对的事实。 */
  if (!LOOPBACK_BIND) {
    if (!registry.isOpen()) {
      console.error('Home Node refuses to listen on ' + HOST + ': the device registry is not available, ' +
        'so LAN clients could not be authenticated. Bind 127.0.0.1 or fix the data directory.');
      process.exit(1);
    }
    log('info', 'lan-bind-enabled', {
      host: HOST, port: PORT, deviceAuth: 'required', lanAddress: lanAddress() || null
    });
  }

  server.listen(PORT, HOST, () => {
    log('info', 'listening', {
      host: HOST, port: PORT, db: store.file, schema: store.schemaVersion,
      tokenRequired: !!TOKEN, loopbackOnly: LOOPBACK_BIND,
      mobileGateway: '/mobile/v1', deviceAuth: LOOPBACK_BIND ? 'per-device (LAN disabled)' : 'per-device (LAN enabled)'
    });
  });

  server.on('error', error => {
    console.error('Home Node could not listen on ' + HOST + ':' + PORT + ' — ' + (error && error.message || error));
    process.exit(1);
  });

  let shuttingDown = false;
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutdown', { reason: String(reason || 'signal'), revision: store.getRevision() });
    try { server.close(); } catch (_) { /* 已关闭 */ }
    /* 先停网关（它会清掉事件泵与订阅者），再关两个数据库连接。
       顺序反过来会让事件泵在一个已关闭的连接上查询。 */
    try { gateway.stop(); } catch (_) { /* 已停止 */ }
    try { registry.close(); } catch (_) { /* 已关闭 */ }
    try { store.close(); } catch (_) { /* 已关闭 */ }
    setTimeout(() => process.exit(0), 20);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', error => {
    log('error', 'uncaught-exception', { error: String((error && error.stack) || error).slice(0, 800) });
  });
  process.on('unhandledRejection', reason => {
    log('error', 'unhandled-rejection', { error: String((reason && reason.stack) || reason).slice(0, 800) });
  });
}

module.exports = {
  store,
  registry,
  gateway,
  executor,
  server,
  httpLayer,
  buildHomeNode,
  openAll,
  lanAddress,
  isLoopbackHost,
  HOST,
  PORT,
  DATA_DIR,
  LOOPBACK_BIND,
  MOBILE_ORIGINS,
  SERVICE_VERSION,
  productVersion,
  redact
};
