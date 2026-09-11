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
const httpLayer = createHttp({
  store,
  executor,
  token: TOKEN,
  version: productVersion(),
  allowedOrigins: ALLOWED_ORIGINS,
  logger: (level, event, fields) => log(level, event, fields)
});
const server = httpLayer.server;

/* require.main guard：测试可以直接 require 本模块并使用 createStore/createHttp，
   只有真正被当作入口运行时才监听端口。 */
if (require.main === module) {
  let openResult = null;
  try { openResult = store.open(); }
  catch (error) {
    /* SQLite 不可用 / schema 过新 → 明确失败退出。
       浏览器侧会把「Home Node 不在线」判为 degraded 并走兼容回退，
       因此这里失败不会阻塞桌面主 UI（P2 纪律）。 */
    console.error('Home Node failed to open its canonical store: ' + (error && error.message || error));
    process.exit(1);
  }

  server.listen(PORT, HOST, () => {
    log('info', 'listening', { host: HOST, port: PORT, db: store.file, schema: store.schemaVersion, tokenRequired: !!TOKEN });
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
  executor,
  server,
  httpLayer,
  HOST,
  PORT,
  DATA_DIR,
  SERVICE_VERSION,
  productVersion,
  redact
};
