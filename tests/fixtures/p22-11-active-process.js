'use strict';
/* ====================================================================
   P22-11 · Active 侧 fixture：**真实的 Active companion 进程**
   --------------------------------------------------------------------
   这不是一个 mock：它 require 的就是 services/active-message-service.js
   （生产装配根），因此它加载的是同一个 HTTP 层、同一个 economy channel
   client、同一份净化器。唯一多出来的东西是**一个测试用的入口路由**
   （POST /__p22_11/propose），因为"模型输出"在一个测试里必须由某个人
   递进来 —— 真实的递入者是 assets/js/active-diary/active-plans.js 的
   planNextProactiveMessage（浏览器侧），它需要一整个浏览器。

   ── 为什么这个入口不是一条新的生产写路径 ─────────────────────────────
   它**不**绕过任何东西：它调用的顺序与生产链逐字相同 ——
       proposal → sanitizeActiveEconomyProposal（fail closed）
                → economyChannel.proposePurchase（有界超时/重试）
                → 23118 的 /internal/economy/command
   而且它只在被 require 为**主模块**（`require.main === module`）时存在。
   `services/active-message-service.js` 自己一个字节都没有为测试改动。

   ── 用法（只被 tests/test_p22_11_economy_active_bridge.js 使用）───────
     node tests/fixtures/p22-11-active-process.js --port=24931
   环境：
     IB_ECONOMY_CHANNEL_BASE / IB_ECONOMY_CHANNEL_TOKEN  —— Home Node 通道
     IB_ACTIVE_PORT                                      —— 出站来源端口
     IB_ACTIVE_DATA_DIR                                  —— 隔离状态目录
   ==================================================================== */

const http = require('node:http');

function argPort() {
  const fromArg = (process.argv.find(a => a.indexOf('--port=') === 0) || '').split('=')[1];
  const n = Number(fromArg || process.env.IB_P22_11_ACTIVE_PORT);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 24931;
}

const PORT = argPort();
const service = require('../../services/active-message-service.js');
const CHANNEL_COMMAND_PATH = service.economyChannel.path;

/* 与生产同一份净化器（见 services/active-message-service.js 的说明）。 */
const sanitize = service.sanitizeActiveEconomyProposal;

/* ── P11-3H · 合作停止面（与生产同一条拆除梯子）─────────────────────
   ★ 真实 companion 的 `require.main` 分支会为自己 listen 的那个 server
   挂上 runtime/service-control.js 的 stop route，并用
   `service.activeTeardown` 做拆除（见 services/active-message-service.js）。
   本 fixture 自己 listen 在另一个端口上，因此它必须自己挂 —— 用的是
   **同一份**判定与**同一份**拆除动作，因此"停得干不干净"与生产是同一
   件事。没有它时 F1 的"残留 child"就只能靠杀，而杀不是合作停止。 */
const serviceControl = require('../../runtime/service-control.js');
const stopDispatch = serviceControl.createStopDispatch({
  service: 'internal-beyond-active-messages',
  stop: () => service.activeTeardown('http'),
  server: () => server,
  exit: code => process.exit(code),
  onAccepted: info => console.log('[p22-11-active-fixture] stop requested (pid ' + info.pid + ')')
});

const server = http.createServer(async (request, response) => {
  if (typeof stopDispatch === 'function') {
    const decision = stopDispatch(request, response, (status, error) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error }));
    });
    if (decision) return;
  }
  try {
    await handle(request, response);
  } catch (error) {
    console.error('[p22-11-active-fixture] request failed: ' + String((error && error.stack) || error));
    try {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: false, fixtureError: String((error && error.message) || error).slice(0, 200) }));
    } catch (_) { /* 已经结束 */ }
  }
});

async function handle(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1:' + PORT);
  function json(status, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    json(200, { ok: true, service: 'p22-11-active-fixture', pid: process.pid });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/channel') {
    json(200, {
      configured: service.economyChannel.configured,
      describe: service.economyChannel.describe(),
      commandPath: CHANNEL_COMMAND_PATH,
      actionName: service.ACTIVE_ECONOMY_PROPOSAL_ACTION,
      identityKeys: service.ACTIVE_ECONOMY_IDENTITY_KEYS
    });
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/__p22_11/propose') {
    json(404, { error: 'not-found' });
    return;
  }
  let raw = '';
  request.on('data', chunk => { raw += chunk; });
  await new Promise(resolve => request.on('end', resolve));
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }

  /* ① 净化：与生产同一条链上的那一份。被拒时**不触碰**传输。 */
  const sanitized = sanitize(body || {});
  if (!sanitized) {
    json(400, { ok: false, sanitized: false, reachedTransport: false });
    return;
  }
  const identity = service.economyChannel.createCommandIdentity('probe');
  const commandId = body && typeof body.commandId === 'string' && body.commandId.trim()
    ? body.commandId.trim()
    : identity.commandId;
  const idempotencyKey = body && typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
    ? body.idempotencyKey.trim()
    : identity.idempotencyKey;

  /* ② 传输：真实出站（有界超时 / 有界重试 / 确定与未知的区分）。
     ★ body.command 只在测试里出现，而且它走的是**显式命名的测试入口**
       （sendCommand）—— 生产路径 proposePurchase 的命令名是写死的，
       没有参数可以改（见契约里 sendCommand 的说明）。 */
  const outcome = typeof body.command === 'string'
    ? await service.economyChannel.sendCommand({
      proposal: sanitized.proposal, idempotencyKey: idempotencyKey,
      commandId: commandId
    }, body.command)
    : await service.economyChannel.proposePurchase({
      proposal: sanitized.proposal,
      idempotencyKey: idempotencyKey,
      commandId: commandId
    });
  json(200, {
    ok: outcome.ok === true,
    sanitized: true,
    reachedTransport: true,
    delivery: outcome.delivery,
    delivered: outcome.delivered === true,
    commandId: commandId,
    idempotencyKey: idempotencyKey,
    attempts: outcome.attempts,
    detail: outcome.detail || null,
    errorName: outcome.errorName || null,
    localPortRetries: outcome.localPortRetries == null ? null : outcome.localPortRetries,
    httpStatus: outcome.httpStatus == null ? null : outcome.httpStatus,
    /* ★ 逐字保留服务端给的理由码（客户端**不**重命名它）：这一次请求是
       一次**确定的拒绝**（4xx），因此 reasonCode 就是服务端那句话。
       `result` 只在服务端真的走到适配器时才有值（拒绝发生在适配器之前
       时它是 null）—— 那正是"没碰适配器"的机器可读形式。 */
    reasonCode: outcome.reasonCode || null,
    downstreamReasonCode: outcome.downstreamReasonCode || null,
    adapterResultPresent: outcome.result != null,
    channelReachedAdapter: outcome.result ? outcome.result.reachedActionAdapter === true : false,
    source: outcome.source || null,
    channelReplay: outcome.channelReplay === true,
    intentCreated: outcome.intentCreated || null,
    purchaseFailed: outcome.purchaseFailed === true,
    purchaseDenied: outcome.purchaseDenied === true
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('p22-11-active-fixture listening on ' + PORT + ' pid=' + process.pid);
});
