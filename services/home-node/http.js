/* ====================================================================
   IB Home Node · HTTP seam（领域层之上的薄传输层）
   --------------------------------------------------------------------
   这一层只做四件事：
     1. 解析 HTTP 请求 → 调用 chat-store / execution 的领域方法；
     2. 把领域结果序列化成稳定的 JSON 形状；
     3. 拒绝不该到达领域层的请求（体积、方法、token、跨域读）；
     4. 输出可观测日志（**绝不**包含正文、prompt、apiKey）。

   它**不**是 Mobile Gateway：
     · 不 import bridge/routes.js，因此不携带 /api/llm-proxy 与工具表；
     · 不暴露任何工具、支付、TTS、记忆、日记、图片接口；
     · 没有设备身份、没有配对、没有 LAN 绑定开关（M1-A 只绑 loopback）。

   安全模型（与仓库既有 D1 风险接受保持一致，见 docs/HOME_NODE_CHAT.md §8）：
     · 默认只 listen 127.0.0.1；
     · 若设置了 home-node token（IB_HOME_NODE_TOKEN 或 config），则**所有**请求都必须携带；
     · 未设置 token 时按 loopback 单用户模型放行，但**不**回显 CORS 头给任意 Origin ——
       只允许无 Origin（原生请求 / 同源 fetch）与显式白名单 Origin。
   ==================================================================== */
'use strict';

const http = require('http');
const crypto = require('crypto');

const CHAT_CORE = require('../../assets/js/chat-core.js');

const PROTOCOL_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024 * 1024;       /* 单条消息可能内联 base64 图片（IMG_MAX_BYTES=20MiB × 压缩前） */
const MAX_BATCH_ITEMS = CHAT_CORE.MAX_MIGRATION_BATCH;
const LOG_RING = 100;

/* 恒定时间字符串比较（与 bridge/util.js 的 constantTimeTokenMatch 同思路；
   不直接 require 它，因为那会把 Bridge 的工具依赖链拉进 Home Node）。 */
function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_) { return false; }
}

function createHomeNodeHttp(deps) {
  deps = deps || {};
  const store = deps.store;
  const executor = deps.executor || null;
  const clock = deps.clock || (() => Date.now());
  const token = String(deps.token || '');
  const version = String(deps.version || '0.0.0');
  const allowedOrigins = Array.isArray(deps.allowedOrigins) ? deps.allowedOrigins.map(String) : [];
  const logger = deps.logger || (() => {});
  const startedAt = clock();
  const logRing = [];

  /* 观测环：只保留**结构化元数据**。任何调用方都不允许往这里塞正文。 */
  function record(level, event, fields) {
    const entry = Object.assign({ at: clock(), level: level, event: event }, fields || {});
    logRing.push(entry);
    if (logRing.length > LOG_RING) logRing.shift();
    logger(level, event, entry);
    return entry;
  }

  function sendJson(res, status, payload, req) {
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-IB-Protocol': String(PROTOCOL_VERSION)
    };
    /* CORS：只对显式白名单 Origin 回显；绝不对任意 Origin 回显（Bridge 的
       Access-Control-Allow-Origin:<requester> 是已记录的既有风险，不在这里复制）。 */
    const origin = req && req.headers ? req.headers.origin : null;
    if (origin && allowedOrigins.indexOf(String(origin)) >= 0) {
      headers['Access-Control-Allow-Origin'] = String(origin);
      headers['Vary'] = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(body);
  }

  function ok(res, payload, req) { sendJson(res, 200, Object.assign({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: clock() }, payload), req); }
  function bad(res, status, error, extra, req) { sendJson(res, status, Object.assign({ ok: false, error: error }, extra || {}), req); }

  /* URL 查询串里的 anchor：纯数字 = 毫秒时间戳；'{...}' = 上一步返回的游标对象；
     其余 = message id（由 store 校验存在性）。 */
  function parseAnchor(raw) {
    const text = String(raw == null ? '' : raw);
    if (/^\d+$/.test(text)) return Number(text);
    if (text.charAt(0) === '{') {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) { /* 不是 JSON → 当作 id 走下面 */ }
    }
    return text;
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { reject(Object.assign(new Error('body too large'), { code: 'too-large' })); req.destroy(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) { resolve({}); return; }
        try { resolve(JSON.parse(raw)); }
        catch (error) { reject(Object.assign(new Error('invalid JSON body'), { code: 'bad-json' })); }
      });
      req.on('error', error => reject(Object.assign(error, { code: 'read-error' })));
    });
  }

  /* token 只在「配置了 token」时才强制 —— 默认安装（loopback 单用户）保持零门槛，
     与 D1 的风险接受范围一致；一旦用户显式设置 token，则没有豁免路径。 */
  function authorized(req, url) {
    if (!token) return true;
    const headerToken = req.headers['x-ib-home-token'] || '';
    const auth = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(.+)$/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
    const queryToken = url.searchParams.get('token') || '';
    return constantTimeEqual(headerToken, token) || constantTimeEqual(bearer, token) || constantTimeEqual(queryToken, token);
  }

  function isLoopback(req) {
    const addr = String((req.socket && req.socket.remoteAddress) || '');
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  async function route(req, res, url, method) {
    const path = url.pathname.replace(/\/+$/, '') || '/';

    /* ── 只读探针（不需要 token，但也绝不返回任何世界数据）── */
    if (path === '/health' && method === 'GET') {
      ok(res, {
        service: 'internal-beyond-home-node',
        version: version,
        role: 'canonical-chat-authority',
        open: store.isOpen(),
        revision: store.isOpen() ? store.getRevision() : 0,
        messages: store.isOpen() ? store.countMessages() : 0,
        schemaVersion: store.schemaVersion
      }, req);
      return;
    }
    if (!authorized(req, url)) {
      record('warn', 'unauthorized', { path: path, loopback: isLoopback(req) });
      bad(res, 401, 'unauthenticated', null, req);
      return;
    }

    if (path === '/status' && method === 'GET') {
      ok(res, { meta: store.meta(), log: logRing.slice(-40), startedAt: startedAt }, req);
      return;
    }
    if (path === '/meta' && method === 'GET') {
      ok(res, { meta: store.meta(), conversations: store.listConversations() }, req);
      return;
    }
    if (path === '/security' && method === 'GET') {
      /* 明确暴露本进程**没有**什么，供诊断与未来的 gateway 决策使用。 */
      ok(res, {
        loopbackOnly: true,
        tokenRequired: !!token,
        corsAllowlist: allowedOrigins,
        exposes: ['chat-store', 'character-turn'],
        doesNotExpose: ['llm-proxy', 'tools', 'payments', 'memory', 'moments', 'diary', 'letters', 'images', 'tts']
      }, req);
      return;
    }

    /* ── 读 ── */
    if (path === '/message' && method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) { bad(res, 400, 'missing-id', null, req); return; }
      const message = store.getMessage(id, { includeDeleted: url.searchParams.get('includeDeleted') === '1' });
      if (!message) { bad(res, 404, 'not-found', null, req); return; }
      const row = store.listMessages({ conversationId: CHAT_CORE.conversationIdOfMessage(message), limit: 1 });
      ok(res, { message: message, revision: row.revision }, req);
      return;
    }
    if ((path === '/list' || path === '/messages') && method === 'GET') {
      const query = {
        conversationId: url.searchParams.get('conversationId') || undefined,
        friendId: url.searchParams.get('friendId') || undefined,
        threadId: url.searchParams.get('threadId') || undefined,
        limit: url.searchParams.get('limit') || undefined
      };
      const before = url.searchParams.get('before');
      const after = url.searchParams.get('after');
      const cursor = url.searchParams.get('cursor');
      /* anchor 可以是 message id、毫秒时间戳、'{...}' JSON 锚点对象，
         或（cursor）上一次响应里的 oldest/cursor。 */
      if (cursor != null) query.cursor = parseAnchor(cursor);
      if (before != null) query.before = parseAnchor(before);
      if (after != null) query.after = parseAnchor(after);
      const result = store.listMessages(query);
      if (!result.ok) { bad(res, 400, result.error, null, req); return; }
      ok(res, result, req);
      return;
    }
    if (path === '/changes' && method === 'GET') {
      const cursor = url.searchParams.get('cursor');
      const result = store.changesAfter(cursor == null ? 0 : Number(cursor), { limit: url.searchParams.get('limit') || undefined });
      if (!result.ok) { bad(res, 400, result.error, null, req); return; }
      ok(res, result, req);
      return;
    }
    if (path === '/migration' && method === 'GET') {
      ok(res, { state: store.getMigrationState(url.searchParams.get('source') || 'default') }, req);
      return;
    }

    /* ── 写 ── */
    if (path === '/messages' && method === 'POST') {
      let payload;
      try { payload = await readBody(req, MAX_BODY_BYTES); }
      catch (error) { bad(res, error.code === 'too-large' ? 413 : 400, error.code || 'bad-body', null, req); return; }

      const batch = Array.isArray(payload.messages) ? payload.messages
        : (payload.message ? [payload.message] : null);
      if (!batch) { bad(res, 400, 'missing-message', null, req); return; }
      if (batch.length > MAX_BATCH_ITEMS) { bad(res, 413, 'batch-too-large', { max: MAX_BATCH_ITEMS, got: batch.length }, req); return; }

      const requestId = payload.requestId ? String(payload.requestId) : '';
      const result = batch.length === 1 && !payload.forceBatch
        ? store.putMessage(batch[0], { requestId: requestId })
        : store.putMessages(batch, { requestId: requestId });
      if (!result.ok) {
        record('warn', 'put-rejected', { error: result.error, index: result.index, errors: result.errors });
        bad(res, result.error === 'invalid-message' ? 422 : 400, result.error, { index: result.index, errors: result.errors, id: result.id }, req);
        return;
      }
      record('info', 'put', {
        outcome: result.outcome, count: result.count || 1, revision: result.revision,
        conversationId: result.conversationId || null, requestId: requestId || null
      });
      ok(res, {
        outcome: result.outcome,
        id: result.id || null,
        revision: result.revision,
        conversationId: result.conversationId || null,
        summary: result.summary || null,
        results: result.results || null,
        droppedFields: result.droppedFields || undefined
      }, req);
      return;
    }

    if (path === '/message' && method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) { bad(res, 400, 'missing-id', null, req); return; }
      const result = store.deleteMessage(id, { requestId: url.searchParams.get('requestId') || '' });
      if (!result.ok) { bad(res, 400, result.error, null, req); return; }
      record('info', 'delete', { outcome: result.outcome, id: result.id, revision: result.revision });
      ok(res, { outcome: result.outcome, id: result.id, revision: result.revision, deleted: !!result.deleted }, req);
      return;
    }

    if (path === '/migrate' && method === 'POST') {
      let payload;
      try { payload = await readBody(req, MAX_BODY_BYTES); }
      catch (error) { bad(res, error.code === 'too-large' ? 413 : 400, error.code || 'bad-body', null, req); return; }
      const source = String(payload.source || 'default');
      const state = store.setMigrationState(source, {
        version: payload.version,
        lastTimestamp: payload.lastTimestamp,
        messages: payload.messages
      });
      record('info', 'migration-mark', { source: source, version: state.state.version, lastTimestamp: state.state.lastTimestamp, messages: state.state.messages });
      ok(res, state, req);
      return;
    }

    if (path === '/verify' && method === 'GET') {
      const integrity = store.integrityCheck();
      ok(res, { integrity: integrity, meta: store.meta() }, req);
      return;
    }

    if (path === '/turn' && method === 'POST') {
      if (!executor) { bad(res, 501, 'execution-unavailable', null, req); return; }
      let payload;
      try { payload = await readBody(req, MAX_BODY_BYTES); }
      catch (error) { bad(res, error.code === 'too-large' ? 413 : 400, error.code || 'bad-body', null, req); return; }
      /* 非流式的规范回合：事件收进数组一起返回（M1-A 不在此层做 WebSocket 推送，
         那属于 Mobile Gateway 的范围）。流式消费走 executor 的 onEvent。 */
      const events = [];
      const result = await executor.executeCharacterTurn(payload, { onEvent: e => events.push(e) });
      if (!result.ok) {
        const status = result.error === 'busy' ? 409 : (result.error === 'invalid-message' || result.error === 'missing-request-id' ? 422 : 502);
        record('warn', 'turn-failed', { error: result.error, conversationId: result.conversationId || null, requestId: payload && payload.requestId ? String(payload.requestId) : null });
        bad(res, status, result.error, { turnId: result.turnId || null, userMessageId: result.userMessageId || null, conversationId: result.conversationId || null, message: result.message || null, partialMessageId: result.partialMessageId || null }, req);
        return;
      }
      ok(res, {
        outcome: result.outcome,
        turnId: result.turnId || null,
        conversationId: result.conversationId,
        userMessageId: result.userMessageId,
        assistantMessageId: result.assistantMessageId || null,
        revision: result.revision,
        events: events,
        message: result.message || null
      }, req);
      return;
    }

    bad(res, 404, 'no-route', { path: path, method: method }, req);
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch (_) { bad(res, 400, 'bad-url', null, req); return; }
    const method = String(req.method || 'GET').toUpperCase();

    /* 跨域预检：只对白名单 Origin 放行，且只声明本服务真正实现的方法。 */
    if (method === 'OPTIONS') {
      const origin = String(req.headers.origin || '');
      if (origin && allowedOrigins.indexOf(origin) >= 0) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-IB-Home-Token, Authorization',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin'
        });
        res.end();
        return;
      }
      res.writeHead(204, { Vary: 'Origin' });
      res.end();
      return;
    }

    if (!isLoopback(req) && !deps.allowRemote) {
      record('warn', 'rejected-non-loopback', { remote: String((req.socket && req.socket.remoteAddress) || '') });
      bad(res, 403, 'loopback-only', null, req);
      return;
    }

    Promise.resolve()
      .then(() => route(req, res, url, method))
      .catch(error => {
        record('error', 'unhandled', { path: url.pathname, error: String((error && error.message) || error).slice(0, 300) });
        if (!res.headersSent) bad(res, 500, 'internal-error', null, req);
        else { try { res.end(); } catch (_) { /* 已断开 */ } }
      });
  });

  /* 单个请求的异常不得杀死常驻服务（与 active-message-service.js 同一纪律）。 */
  server.on('clientError', (error, socket) => {
    record('warn', 'client-error', { code: String((error && error.code) || '') });
    try { socket.destroy(); } catch (_) { /* 已销毁 */ }
  });

  return { server: server, record: record, logRing: logRing, PROTOCOL_VERSION: PROTOCOL_VERSION };
}

module.exports = createHomeNodeHttp;
module.exports.PROTOCOL_VERSION = PROTOCOL_VERSION;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
