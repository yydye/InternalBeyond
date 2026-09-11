/* ====================================================================
   IB Home Node · Mobile Gateway（versioned, allowlisted, device-authenticated）
   --------------------------------------------------------------------
   这是**世界 API**，不是 Bridge tool API。边界是刻意画出来的：

     内部桌面 API（services/home-node/http.js）   Mobile Gateway（本文件）
     ───────────────────────────────────────     ──────────────────────────
     /health /status /meta /security             /mobile/v1/…
     /list /message /changes /messages           （只有 allowlist 里的 verb）
     /migrate /verify /turn
     由 loopback 私密性 + 可选 token 保护        由 **per-device token** 保护
     失败可回退（桌面继续可用）                    失败即拒绝（局域网不降级）

   禁止事项（Phase 1）：
     · 不 import bridge/routes.js —— 因此结构上不存在 /api/llm-proxy、
       工具表、submit_payment / pay_register_checkout / pay_set_config、
       webhook、Bridge resident chat、TTS 路由；
     · 不复用 Bridge 的 message vocabulary（hello / tool / 之类），
       protocol v1 的 verb 与 event 是本文件独立定义并逐条 allowlist 的。

   ── 传输选择（Phase 10）──────────────────────────────────────────────
   选了 **HTTP 指令 + SSE 流**（Option A），不是 WebSocket：
     · chat.send 的流式输出是**单向**的（server→client），SSE 正好是它的形状；
     · changesAfter 同步、history 分页、presence 查询都是**幂等的拉取**，
       放在 WebSocket 上反而要自己造 request/response 关联与超时；
     · Android 原生客户端要接 SSE 只需一个普通 HTTP 响应体解析器，
       而 WebSocket 要引入握手、掩码、分片、ping/pong、重连退避；
     · 调试性：curl 就能看到完整的流（curl -N）。
   事件（events 频道）同样用 SSE：它是**单向通知**，客户端真正的状态恢复
   依赖 sync.changes（revision cursor），因此在断线时不会丢数据 ——
   这正是 Phase 23 要求的"state sync 与 ephemeral event 分离"。
   WebSocket 留给未来真的有双向实时需求（语音/视频信令）的那一阶段，
   且那一阶段**不得**复用 Bridge 的消息词表。
   ==================================================================== */
'use strict';

const crypto = require('crypto');

const CHAT_CORE = require('../../assets/js/chat-core.js');
const MOBILE_DTO = require('../../assets/js/mobile-dto.js');

/* 协议版本。**真的会被校验**（Phase 9）—— 不是 Bridge 那种"存在但没人读"的字段。 */
const PROTOCOL_VERSION = 1;

/* 体积上限：比内部 API 的 64MB 小。手机发图片走 base64，20MB 原图压缩后仍在
   这个量级以内，而一个移动端请求不应该能把 64MB 塞进 Home Node 的内存。 */
const MOBILE_MAX_BODY_BYTES = 24 * 1024 * 1024;

/* 流式回合的内存保留：足够覆盖"断线重连 + 回来取结果"的窗口。 */
const TURN_HISTORY_MAX = 64;
const TURN_EVENT_BUFFER_MAX = 4000;
const TURN_TTL_MS = 30 * 60 * 1000;

/* 事件频道的订阅队列上限：慢客户端不能被允许拖住网关。 */
const SUBSCRIBER_QUEUE_MAX = 256;
/* 事件频道扫 change_log 的间隔。unref() 过，绝不让常驻 timer 阻止进程退出。 */
const EVENT_POLL_MS = 2500;
const EVENT_PAGE_LIMIT = 200;

const LOG_RING = 200;

/* 桌面内部管理路径（**不属于** mobile namespace）。这份清单同时是 http.js 的
   委派依据：不在清单里、也不是 /mobile/* 的路径，网关根本不会看到。 */
const ADMIN_PATHS = ['/pairing/session', '/devices', '/device/revoke', '/characters', '/characters/publish'];

/* ── 错误契约（Phase 28）──────────────────────────────────────────────
   一个**封闭**词表。客户端据此分支，禁止匹配文案。
   Node 的 stack 永远不出现在响应里。 */
const ERROR_STATUS = {
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  DEVICE_REVOKED: 403,
  PAIRING_INVALID: 403,
  PAIRING_EXPIRED: 410,
  PAIRING_USED: 409,
  PAIRING_NOT_FOUND: 404,
  BAD_VERSION: 400,
  BAD_REQUEST: 400,
  UNKNOWN_VERB: 404,
  NOT_FOUND: 404,
  BUSY: 409,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  TOO_LARGE: 413,
  UNSUPPORTED: 501,
  INTERNAL: 500,
  /* domain → protocol */
  'missing-request-id': 400,
  'invalid-message': 422,
  'missing-user-message': 422,
  'missing-friend-id': 400,
  'character-not-ready': 409,
  'empty-output': 204,
  timeout: 504,
  abort: 499,
  'provider-error': 502,
  'store-write-failed': 500,
  'store-unavailable': 503,
  'store-closed': 503,
  'bad-cursor': 400,
  'ambiguous-range': 400,
  'duplicate-request': 200,
  'SCHEMA_TOO_NEW': 500
};

/* domain 错误 → 协议错误码。**没有**映射的一律 INTERNAL（不泄漏内部词表）。 */
const ERROR_ALIAS = {
  'missing-request-id': 'BAD_REQUEST',
  'invalid-message': 'BAD_REQUEST',
  'missing-user-message': 'BAD_REQUEST',
  'missing-friend-id': 'BAD_REQUEST',
  'character-not-ready': 'CONFLICT',
  'empty-output': 'BAD_REQUEST',
  abort: 'INTERNAL',
  timeout: 'INTERNAL',
  'provider-error': 'INTERNAL',
  'store-write-failed': 'INTERNAL',
  'store-unavailable': 'INTERNAL',
  'store-closed': 'INTERNAL',
  'bad-cursor': 'BAD_REQUEST',
  'ambiguous-range': 'BAD_REQUEST'
};

function statusFor(code, fallback) {
  const status = ERROR_STATUS[code];
  return status == null ? (fallback || 400) : status;
}

/* retryable 是**给客户端重连策略用的**，不是装饰：
   只有明确"重试可能成功"的错误才是 true。 */
const RETRYABLE = {
  BUSY: true,
  RATE_LIMITED: true,
  INTERNAL: true,
  'provider-error': true,
  timeout: true,
  'store-write-failed': true,
  'store-unavailable': true,
  'empty-output': true
};

/* SSE 帧里 event: 的取值（closed set）。 */
const STREAM_EVENTS = ['chat.start', 'chat.delta', 'chat.done', 'chat.error', 'stream.error', 'ping'];
const NOTIFY_EVENTS = ['message.created', 'message.deleted', 'cursor.changed', 'presence.changed', 'notify.error', 'ping'];

/* 简单 token bucket（零依赖）。按 key 独立，窗口内补满。 */
function createRateLimiter(deps) {
  deps = deps || {};
  const clock = deps.clock || (() => Date.now());
  const buckets = new Map();
  const maxKeys = Number(deps.maxKeys) > 0 ? Number(deps.maxKeys) : 4096;
  function take(key, rule) {
    const rate = Number(rule && rule.rate) > 0 ? Number(rule.rate) : 60;
    const burst = Number(rule && rule.burst) > 0 ? Number(rule.burst) : rate;
    const now = clock();
    let bucket = buckets.get(key);
    if (!bucket) {
      /* 简易上限：超了就清掉最旧的（Map 迭代顺序 = 插入顺序）。 */
      if (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
      bucket = { tokens: burst, at: now };
      buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.at);
    bucket.tokens = Math.min(burst, bucket.tokens + (elapsed * rate) / 1000);
    bucket.at = now;
    if (bucket.tokens < 1) {
      return { ok: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) * 1000) / rate) };
    }
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }
  return {
    take: take,
    reset: function () { buckets.clear(); },
    size: function () { return buckets.size; }
  };
}

function createMobileGateway(deps) {
  deps = deps || {};
  const store = deps.store;
  const registry = deps.registry;
  const executor = deps.executor || null;
  const clock = deps.clock || (() => Date.now());
  const logger = deps.logger || (() => {});
  const version = String(deps.version || '0.0.0');
  const allowedOrigins = Array.isArray(deps.allowedOrigins) ? deps.allowedOrigins.map(String) : [];
  const maxBodyBytes = Number(deps.maxBodyBytes) > 0 ? Number(deps.maxBodyBytes) : MOBILE_MAX_BODY_BYTES;
  const limiter = deps.limiter || createRateLimiter({ clock: clock });
  const lanMode = !!deps.lanMode;
  const fingerprint = registry && registry.fingerprint ? registry.fingerprint : 'unknown';

  const RULES = Object.assign({
    pair: { rate: 10 / 60, burst: 10 },          /* 配对：每分钟 10 次 */
    /* 鉴权失败：按远端地址限流（配对爆破 / 凭据爆破防护）。
       burst 刻意比 pair 高：一个真实客户端在重新配对期间可能连续失败几次，
       而 device 级限流已经覆盖了已认证流量 —— 这一档只防**未认证**的暴力尝试。 */
    authFail: { rate: 2, burst: 120 },
    send: { rate: 1, burst: 60 },                /* chat.send：每秒 1 次、突发 60（手机重连后补发一批） */
    read: { rate: 240 / 60, burst: 240 },        /* 读类指令：宽松，只挡真正的滥用 */
    stream: { rate: 1, burst: 60 }               /* 开流 */
  }, deps.rateRules || {});

  const logRing = [];
  const liveTurns = new Map();                   /* turnId → LiveTurn */
  const turnByRequest = new Map();               /* requestId → turnId */
  const subscribers = new Set();                 /* 设备事件订阅者 */
  const onlineDevices = new Map();               /* deviceId → 打开中的流数量 */

  let eventCursor = null;                        /* 事件频道的 change_log 游标 */
  let eventPump = null;

  function record(level, event, fields) {
    const entry = Object.assign({ at: clock(), level: level, event: event }, fields || {});
    logRing.push(entry);
    if (logRing.length > LOG_RING) logRing.shift();
    logger(level, event, entry);
    return entry;
  }

  /* ── 信封（Phase 9 / 28）──────────────────────────────────────────
     成功：{ v, ok:true, type, requestId, serverTime, payload }
     失败：{ v, ok:false, type:'error', requestId, serverTime, error:{code,message,retryable} }
     注意 v 是**响应字段**，不是只在请求里校验一次的装饰。 */
  function okBody(type, requestId, payload) {
    return {
      v: PROTOCOL_VERSION,
      ok: true,
      type: String(type || 'ok'),
      requestId: requestId || null,
      serverTime: clock(),
      payload: payload || {}
    };
  }
  function errorBody(code, requestId, extra) {
    const out = {
      v: PROTOCOL_VERSION,
      ok: false,
      type: 'error',
      requestId: requestId || null,
      serverTime: clock(),
      error: {
        code: String(code),
        message: messageFor(code, extra),
        retryable: !!RETRYABLE[code]
      }
    };
    if (extra && extra.detail !== undefined) out.error.detail = extra.detail;
    return out;
  }
  /* 面向客户端的**稳定**文案。内部细节（SQL 错误、路径、stack）绝不外泄。 */
  function messageFor(code, extra) {
    if (extra && extra.message && code === 'INTERNAL') return 'the request could not be completed';
    switch (code) {
      case 'AUTH_REQUIRED': return 'device authentication is required';
      case 'AUTH_INVALID': return 'the device credential is not valid';
      case 'DEVICE_REVOKED': return 'this device has been revoked';
      case 'PAIRING_INVALID': return 'the pairing payload is not valid';
      case 'PAIRING_EXPIRED': return 'the pairing session has expired';
      case 'PAIRING_USED': return 'the pairing session has already been used';
      case 'PAIRING_NOT_FOUND': return 'no such pairing session';
      case 'BAD_VERSION': return 'unsupported protocol version';
      case 'BAD_REQUEST': return 'the request could not be understood';
      case 'UNKNOWN_VERB': return 'unknown mobile verb';
      case 'NOT_FOUND': return 'not found';
      case 'BUSY': return 'another turn is already running in this conversation';
      case 'RATE_LIMITED': return 'too many requests';
      case 'TOO_LARGE': return 'request body is too large';
      case 'CONFLICT': return 'the request conflicts with current state';
      default: return 'the request could not be completed';
    }
  }

  /* ── Origin（Phase 20）──────────────────────────────────────────────
     核心判断：**IP 不是身份，Origin 不是身份 —— device token 才是身份。**
     因此这里不是把 Origin 当安全边界，而是当"浏览器能不能读响应"的兼容开关：
       · 无 Origin（原生 Android / curl）→ 不需要 CORS 头；
       · capacitor:// / ionic:// / https://localhost（未来的 Capacitor 壳）→ 回显；
       · Origin: null（file:// 或沙箱 iframe）→ 回显（真实防护是设备 token）；
       · 其它 → 不回显。
     回显一个 Origin 不会给攻击者任何东西：没有 token 就什么都拿不到。 */
  function originAllowed(origin) {
    const value = origin == null ? '' : String(origin);
    if (!value) return false;
    if (allowedOrigins.indexOf(value) >= 0) return true;
    if (value === 'null') return true;
    if (/^(capacitor|ionic):\/\/localhost$/i.test(value)) return true;
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(value)) return true;
    return false;
  }
  function applyCors(headers, req) {
    const origin = req && req.headers ? req.headers.origin : null;
    if (originAllowed(origin)) {
      headers['Access-Control-Allow-Origin'] = String(origin);
      headers['Vary'] = 'Origin';
    }
    /* 永远声明并允许 Authorization —— Android 优先用 header 带 token。 */
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-IB-Mobile-Token, X-IB-Protocol, Last-Event-ID';
  }
  function sendJson(res, status, body, req, extraHeaders) {
    const raw = JSON.stringify(body);
    const headers = Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(raw),
      'Cache-Control': 'no-store',
      'X-IB-Mobile-Protocol': String(PROTOCOL_VERSION)
    }, extraHeaders || {});
    applyCors(headers, req);
    res.writeHead(status, headers);
    res.end(raw);
  }
  function fail(res, code, req, status, requestId, extra) {
    const body = errorBody(code, requestId, extra);
    /* 429 必须给出 Retry-After：客户端据此退避，而不是盲目重试。
       （用 header 表达，不动响应体契约。） */
    const headers = {};
    if ((status == null ? statusFor(code, 400) : status) === 429 && extra && extra.retryAfterMs != null) {
      headers['Retry-After'] = String(Math.max(1, Math.ceil(Number(extra.retryAfterMs) / 1000)));
    }
    sendJson(res, status == null ? statusFor(code, 400) : status, body, req, headers);
    return body;
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) { resolve({}); return; }
        try { resolve(JSON.parse(raw)); }
        catch (_) { reject(Object.assign(new Error('invalid JSON body'), { code: 'BAD_REQUEST' })); }
      });
      req.on('error', error => reject(Object.assign(error, { code: 'BAD_REQUEST' })));
    });
  }

  /* 版本校验（Phase 9）────────────────────────────────────────────
     必须**真的读** v。缺省时不猜：v 未给出 = BAD_VERSION 还是按 1 处理？
     选择：**要求显式**。理由是一个"缺省即接受"的默认值会让
     "客户端压根没实现版本协商"与"客户端就是 v1"无法区分，
     而 Bridge 的 hello.version 正是死于此。客户端只有一个，成本为零。 */
  function checkVersion(body) {
    const raw = body && body.v;
    if (raw === undefined || raw === null) return { ok: false, code: 'BAD_VERSION', detail: 'missing' };
    /* 类型先行。`Number(true) === 1`，所以只写数值校验会让 `{"v":true}`
       静默通过 —— 版本协商字段必须比"能被强转成 1"更严格。 */
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      return { ok: false, code: 'BAD_VERSION', detail: typeof raw };
    }
    if (typeof raw === 'string' && !/^\d+$/.test(raw.trim())) {
      return { ok: false, code: 'BAD_VERSION', detail: 'not-a-number' };
    }
    const v = Number(raw);
    if (!isFinite(v) || Math.trunc(v) !== v) return { ok: false, code: 'BAD_VERSION', detail: 'not-an-integer' };
    if (v !== PROTOCOL_VERSION) return { ok: false, code: 'BAD_VERSION', detail: String(v) };
    return { ok: true, v: v };
  }

  function clientAddress(req) {
    return String((req.socket && req.socket.remoteAddress) || 'unknown');
  }
  function remoteKey(req) {
    /* 未认证请求按**远端地址**限流（配对爆破、鉴权爆破）。 */
    return 'ip:' + clientAddress(req);
  }

  /* ── 设备鉴权（Phase 20）──────────────────────────────────────────
     Native Android 优先用 Authorization: Bearer <device token>。
     X-IB-Mobile-Token 是等价的显式头。
     query 参数 `token` **不**被接受：URL 会进日志、进 Referer、进浏览器历史，
     永久令牌放那里是可控的泄漏面。 */
  function authenticate(req) {
    let raw = '';
    const auth = String(req.headers.authorization || '');
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth);
    if (bearerMatch) raw = bearerMatch[1].trim();
    if (!raw) raw = String(req.headers['x-ib-mobile-token'] || '').trim();
    if (!raw) return { ok: false, code: 'AUTH_REQUIRED' };
    const verified = registry.verifyDeviceToken(raw, { touch: true });
    if (!verified.ok) return { ok: false, code: verified.code || 'AUTH_INVALID' };
    return { ok: true, device: verified.device };
  }

  function requireCapability(device, capability) {
    if (!device) return false;
    const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
    return capabilities.indexOf(capability) >= 0;
  }

  function rateLimit(key, ruleName) {
    return limiter.take(key, RULES[ruleName]);
  }

  /* ── character 读取 ───────────────────────────────────────────────── */
  function characterList(device) {
    const rows = registry.listCharacters();
    const characters = [];
    for (const row of rows) {
      /* 再次经 DTO 投影：即使库里存的 dto 是别人写进去的旧形状，
         出站仍然只可能是白名单字段。 */
      characters.push(MOBILE_DTO.characterDto(Object.assign({ id: row.id }, row.dto)));
    }
    return {
      characters: characters,
      catalogUpdatedAt: registry.characterCatalogUpdatedAt(),
      count: characters.length
    };
  }

  /* 出站消息投影：store 给的是 canonical 记录，这里转成 mobile DTO。
     绝不把 reasoning_content / wsSearches / memOps / calNotes 发给设备。 */
  function toMessageDto(message, revision) {
    const dto = MOBILE_DTO.messageDto(message, {
      conversationId: CHAT_CORE.conversationIdOfMessage(message),
      revision: revision
    });
    return dto;
  }

  /* ── 流式回合（Phase 15/16/17/18）────────────────────────────────── */
  function pruneTurns() {
    const now = clock();
    const stale = [];
    for (const [turnId, turn] of liveTurns) {
      if (now - turn.startedAt > TURN_TTL_MS) stale.push(turnId);
    }
    for (const turnId of stale) {
      const turn = liveTurns.get(turnId);
      if (turn) turnByRequest.delete(turn.requestId);
      liveTurns.delete(turnId);
    }
    while (liveTurns.size > TURN_HISTORY_MAX) {
      const oldest = liveTurns.keys().next();
      if (oldest.done) break;
      const turn = liveTurns.get(oldest.value);
      if (turn) turnByRequest.delete(turn.requestId);
      liveTurns.delete(oldest.value);
    }
  }

  /* 事件缓冲：断线重连时按 sequence 回放。
     刻意**不**尝试恢复 provider 的 TCP 流 —— 那是不可靠且无收益的复杂度。
     回放的是**我们已经产生的协议事件**；超出缓冲窗口就退化为"看 canonical 状态"。 */
  function trackTurn(turn) {
    liveTurns.set(turn.turnId, turn);
    turnByRequest.set(turn.requestId, turn.turnId);
    pruneTurns();
  }
  function getTurn(turnId) {
    return liveTurns.get(String(turnId || '')) || null;
  }
  function getTurnByRequest(requestId) {
    const turnId = turnByRequest.get(String(requestId || ''));
    return turnId ? liveTurns.get(turnId) || null : null;
  }

  function turnStatusPayload(turn) {
    return {
      turnId: turn.turnId,
      requestId: turn.requestId,
      conversationId: turn.conversationId,
      characterId: turn.characterId,
      status: turn.status,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      sequence: turn.sequence,
      assistantMessageId: turn.assistantMessageId || null,
      userMessageId: turn.userMessageId || null,
      revision: turn.revision == null ? null : turn.revision,
      duplicate: !!turn.duplicate,
      error: turn.error || null,
      /* 事件缓冲窗口：客户端据此判断"我能不能拿到中间过程"。
         拿不到也不影响正确性 —— canonical 状态永远在 sync.changes 里。 */
      replayFrom: turn.events.length ? turn.events[0].sequence : null,
      replayTo: turn.events.length ? turn.events[turn.events.length - 1].sequence : null
    };
  }

  function conversationIdFor(characterId, threadId) {
    return CHAT_CORE.conversationIdOf(characterId, threadId);
  }

  /* 回合的执行体。**与 HTTP/SSE 完全解耦**：
     客户端是否还连着、是否中途断开，都不影响这里继续跑完并写入 canonical store。
     这就是 Phase 18 的 "disconnect ≠ model cancellation"。 */
  async function runTurn(turn) {
    try {
      const result = await executor.executeCharacterTurn(turn.request, {
        turnId: turn.turnId,
        onEvent: function (event) { pushTurnEvent(turn, event); }
      });
      turn.finishedAt = clock();
      if (result.ok) {
        /* duplicate-request 路径：**没有**新 assistant 消息，也没有第二次模型调用。
           canonical 里的既有回复由下面统一从 store 取，保证 done 携带真实内容。 */
        const duplicate = result.outcome === 'duplicate-request';
        let assistantId = result.assistantMessageId || null;
        if (duplicate && !assistantId) {
          /* 幂等回放：找出该 user 消息之后写进这个会话的第一条 assistant 消息。
             （exact 匹配做不到 —— store 不记录"哪条回复对应哪个 requestId"，
              但同一会话同一时刻只有一个 in-flight turn，因此这是确定的。） */
          assistantId = findReplyAfter(turn.conversationId, result.userMessageId);
        }
        turn.status = duplicate ? 'duplicate' : 'done';
        turn.userMessageId = result.userMessageId || turn.userMessageId;
        turn.assistantMessageId = assistantId;
        turn.revision = result.revision == null ? turn.revision : result.revision;
        turn.duplicate = duplicate;
      } else {
        turn.status = 'error';
        turn.userMessageId = result.userMessageId || turn.userMessageId;
        turn.error = result.error || 'INTERNAL';
        turn.errorMessage = result.message || null;
        turn.partialMessageId = result.partialMessageId || null;
        if (result.revision != null) turn.revision = result.revision;
      }
    } catch (error) {
      /* executor 自身抛错（不该发生，但绝不能变成 unhandled rejection）。 */
      turn.finishedAt = clock();
      turn.status = 'error';
      turn.error = 'INTERNAL';
      turn.errorMessage = String((error && error.message) || error).slice(0, 300);
      record('error', 'turn-crashed', { turnId: turn.turnId, error: turn.errorMessage });
    } finally {
      pruneTurns();
    }
    /* 终结帧在 finally 之后发：无论成功、失败还是 executor 抛错，
       在线客户端都必然收到一个明确的结束信号，不会挂着等超时。 */
    emitTerminalFrame(turn, turn.status === 'error' ? 'chat.error' : 'chat.done',
      turn.status === 'error' ? errorPayloadFor(turn) : donePayloadFor(turn));
    return turn;
  }

  function findReplyAfter(conversationId, userMessageId) {
    const page = store.listMessages({ conversationId: conversationId, cursor: userMessageId, limit: 5 });
    if (!page || !page.ok || !Array.isArray(page.messages)) return null;
    for (const message of page.messages) {
      if (message && message.role === 'assistant') return String(message.id);
    }
    return null;
  }

  /* 把 executor 的领域事件映射成协议事件（closed vocabulary）。
     sequence 单调递增：客户端据此检测 missing / duplicate frame。 */
  function pushTurnEvent(turn, event) {
    if (!event || !event.type) return;
    let frame = null;
    if (event.type === 'delta') {
      frame = {
        type: 'chat.delta',
        payload: {
          kind: event.kind === 'reasoning' ? 'reasoning' : 'content',
          text: String(event.text == null ? '' : event.text),
          index: event.index == null ? null : event.index
        }
      };
    } else if (event.type === 'error') {
      frame = {
        type: 'chat.error',
        payload: {
          code: event.kind === 'abort' ? 'ABORT' : (event.kind === 'timeout' ? 'TIMEOUT' : 'PROVIDER_ERROR'),
          domain: String(event.kind || 'error'),
          message: String(event.message == null ? '' : event.message).slice(0, 300),
          retryable: event.retryable !== false,
          partialMessageId: event.partialMessageId || null
        }
      };
    }
    /* 'start' 与 'done' 由网关自己发（它知道 turnId 与最终 messageId）。 */
    if (!frame) return;
    turn.sequence += 1;
    frame.sequence = turn.sequence;
    if (frame.type === 'chat.delta' && frame.payload.kind === 'content') turn.text += frame.payload.text;
    if (turn.events.length >= TURN_EVENT_BUFFER_MAX) turn.events.shift();
    turn.events.push(frame);
    broadcastTurn(turn, frame);
  }

  function broadcastTurn(turn, frame) {
    for (const sink of turn.sinks) {
      if (sink.closed) continue;
      if (!writeStreamFrame(sink, frame)) {
        sink.closed = true;
        turn.sinks.delete(sink);
      }
    }
  }

  /* ── SSE 写帧 ─────────────────────────────────────────────────────── */
  function writeStreamFrame(sink, frame) {
    if (!sink || sink.closed) return false;
    try {
      const eventName = frame.type;
      let out = 'event: ' + eventName + '\n';
      if (frame.sequence != null) out += 'id: ' + String(sink.streamId) + ':' + String(frame.sequence) + '\n';
      out += 'data: ' + JSON.stringify(frame) + '\n\n';
      sink.res.write(out);
      return true;
    } catch (_) {
      return false;
    }
  }
  function writeComment(sink, text) {
    if (!sink || sink.closed) return false;
    try { sink.res.write(': ' + String(text || '') + '\n\n'); return true; }
    catch (_) { return false; }
  }
  function openStream(req, res, options) {
    options = options || {};
    const headers = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-IB-Mobile-Protocol': String(PROTOCOL_VERSION)
    };
    applyCors(headers, req);
    res.writeHead(200, headers);
    /* 立刻 flush 一个注释：让客户端知道流已建立，也让代理不要缓冲。 */
    try { res.write(': open\n\n'); } catch (_) { /* 已断开 */ }
    const sink = {
      res: res,
      streamId: options.streamId || crypto.randomBytes(6).toString('hex'),
      closed: false,
      close: function () {
        if (sink.closed) return;
        sink.closed = true;
        try { res.end(); } catch (_) { /* 已结束 */ }
      }
    };
    return sink;
  }

  /* 心跳：防止中间设备把空闲连接掐掉。unref() —— 绝不阻止进程退出。 */
  function attachHeartbeat(sink, onTick) {
    const timer = setInterval(() => {
      if (sink.closed) { clearInterval(timer); return; }
      if (onTick) onTick(sink);
      else writeComment(sink, 'ping ' + clock());
    }, 15000);
    if (typeof timer.unref === 'function') timer.unref();
    return function stop() { clearInterval(timer); };
  }

  /* ── chat.send ────────────────────────────────────────────────────── */
  function parseSendPayload(body, device) {
    const payload = (body && body.payload) || {};
    const requestId = String((body && body.requestId) || payload.requestId || '').trim();
    const characterId = String(payload.characterId || '').trim();
    const threadId = payload.threadId == null ? '' : String(payload.threadId);
    if (!requestId) return { ok: false, code: 'BAD_REQUEST', detail: 'requestId is required' };
    if (!characterId) return { ok: false, code: 'BAD_REQUEST', detail: 'characterId is required' };

    /* 文本内容：要么给 content，要么给结构化 message —— 但**绝不**接受
       client 自带的 friendId/role/id（那会让客户端伪造别的会话或别的角色）。 */
    let content = '';
    let images = null;
    let files = null;
    let voice = null;
    if (typeof payload.content === 'string') content = payload.content;
    else if (payload.message && typeof payload.message === 'object') {
      content = String(payload.message.content == null ? '' : payload.message.content);
      if (Array.isArray(payload.message.images)) images = payload.message.images;
      if (Array.isArray(payload.message.files)) files = payload.message.files;
      if (payload.message.voice && typeof payload.message.voice === 'object') voice = payload.message.voice;
    }
    if (!content.trim() && !images && !files && !voice) {
      return { ok: false, code: 'BAD_REQUEST', detail: 'content is required' };
    }
    if (images && images.length && !requireCapability(device, 'vision')) {
      return { ok: false, code: 'CONFLICT', detail: 'device capability "vision" is not granted' };
    }

    const character = registry.getCharacter(characterId);
    if (!character) return { ok: false, code: 'NOT_FOUND', detail: 'character not found' };
    const spec = registry.getCharacterSpec(characterId);
    if (!spec) return { ok: false, code: 'CONFLICT', detail: 'this character has no runnable configuration on the Home Node' };

    /* 用户消息由**服务端**构造：
         · id 由 requestId 确定性推导 → 重试同一个 requestId 得到同一个 id，
           store 的 id 级幂等也成立（双保险）；
         · friendId 恒等于 characterId → conversation 就是 dm:<characterId>[|thread]，
           客户端无法把消息塞进别的会话。 */
    const userMessage = {
      id: CHAT_CORE.messageIdFromRequest(requestId),
      role: 'user',
      content: content,
      friendId: characterId,
      timestamp: clock()
    };
    if (threadId) userMessage.threadId = threadId;
    if (images) userMessage.images = images;
    if (files) userMessage.files = files;
    if (voice) userMessage.voice = voice;

    const historyLimit = CHAT_CORE.normalizeLimit(payload.historyLimit, 20, 100);
    const historyPage = store.listMessages({
      conversationId: conversationIdFor(characterId, threadId),
      limit: historyLimit
    });
    const history = [];
    if (historyPage && historyPage.ok && Array.isArray(historyPage.messages)) {
      for (const message of historyPage.messages) {
        if (!message || !message.content) continue;
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        history.push({ role: message.role, content: String(message.content) });
      }
    }

    return {
      ok: true,
      requestId: requestId,
      characterId: characterId,
      character: character,
      threadId: threadId,
      conversationId: conversationIdFor(characterId, threadId),
      userMessage: userMessage,
      turnRequest: {
        requestId: requestId,
        conversationId: conversationIdFor(characterId, threadId),
        friendId: characterId,
        character: { id: characterId, spec: spec },
        userMessage: userMessage,
        history: history,
        /* 诚实标注：手机端没有 Middle Brain，上下文是"服务端按角色配置 + 会话历史"
           组织的。绝不假装与桌面同质（M1-A §6.2 的 contextPolicy 契约）。 */
        contextPolicy: 'mobile-gateway-history',
        maxTokens: payload.maxTokens,
        temperature: payload.temperature,
        reasoningEffort: payload.reasoningEffort
      }
    };
  }

  function beginTurn(parsed, device) {
    const existing = getTurnByRequest(parsed.requestId);
    const turnId = 'turn_' + CHAT_CORE.stableToken(parsed.requestId + ':' + parsed.conversationId);
    const turn = existing || {
      turnId: turnId,
      requestId: parsed.requestId,
      conversationId: parsed.conversationId,
      characterId: parsed.characterId,
      deviceId: device.deviceId,
      startedAt: clock(),
      finishedAt: null,
      status: 'running',
      sequence: 0,
      events: [],
      sinks: new Set(),
      assistantMessageId: null,
      userMessageId: null,
      revision: null,
      text: '',
      duplicate: false,
      error: null,
      request: parsed.turnRequest
    };
    if (!existing) trackTurn(turn);
    return turn;
  }

  /* done 事件：从 canonical store 取**真实**的 assistant 记录再投影。
     为什么不直接用 execution 的返回值：这条路径同时服务 duplicate-request
     （那次根本没有返回值里的 message），从 store 读是唯一对两种情形都成立的做法。 */
  function donePayloadFor(turn) {
    let dto = null;
    let revision = turn.revision;
    if (turn.assistantMessageId) {
      const stored = store.getMessage(turn.assistantMessageId);
      if (stored) {
        dto = toMessageDto(stored, null);
        const page = store.listMessages({ conversationId: turn.conversationId, limit: 1 });
        /* page.revision 是**库级** revision（store.getRevision()），不是这条消息的。
           这里刻意取 max：完成事件应当反映"写完之后的库版本"，客户端可以据此
           直接从这个位置开始 sync.changes 而不必先问一次。 */
        if (page && page.ok && page.revision != null) revision = Math.max(Number(revision) || 0, Number(page.revision));
      }
    }
    return {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      userMessageId: turn.userMessageId,
      assistantMessageId: turn.assistantMessageId,
      revision: revision == null ? store.getRevision() : revision,
      duplicate: !!turn.duplicate,
      message: dto,
      /* 服务端**没有**保存"这次流式回合是否被中断"以外的信息；
         done 只承诺 canonical 写入已完成。 */
      stored: !!dto
    };
  }
  function errorPayloadFor(turn) {
    const domain = String(turn.error || 'INTERNAL');
    const code = ERROR_ALIAS[domain] || (ERROR_STATUS[domain] != null ? domain.toUpperCase() : 'INTERNAL');
    return {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      userMessageId: turn.userMessageId,
      code: code === 'INTERNAL' ? 'PROVIDER_ERROR' : code,
      domain: domain,
      message: String(turn.errorMessage || '').slice(0, 300),
      retryable: !!RETRYABLE[domain] || !!RETRYABLE[code],
      partialMessageId: turn.partialMessageId || null
    };
  }

  /* 把一个已存在的回合接到一个 SSE 响应上（首次连接 / 断线重连共用）。
     lastSequence：客户端已经收到过的最大 sequence（来自 Last-Event-ID 或显式参数）。 */
  function attachTurnStream(turn, req, res, lastSequence) {
    const streamId = crypto.randomBytes(6).toString('hex');
    const sink = openStream(req, res, { streamId: streamId });
    const stopped = attachHeartbeat(sink, s => writeComment(s, 'ping ' + clock()));
    /* 让终结帧的广播路径能够停掉心跳（否则一条已关闭的流上会继续跑 timer）。 */
    sink.stopHeartbeat = stopped;
    let finished = false;
    const finish = function (frame) {
      if (finished) return;
      finished = true;
      if (frame) writeStreamFrame(sink, frame);
      stopped();
      turn.sinks.delete(sink);
      sink.close();
    };
    res.on('close', function () {
      stopped();
      sink.closed = true;
      turn.sinks.delete(sink);
      /* 客户端断开**不**取消生成（Phase 18）。回合继续跑，结果进 canonical store，
         客户端重连后要么回放缓冲、要么直接 sync.changes。 */
      if (!finished) record('info', 'stream-detached', { turnId: turn.turnId, streamId: streamId });
    });

    /* 1) 回放：按 sequence 严格大于客户端已确认的位置。
          客户端没给位置时从 1 开始（完整回放，只要还在缓冲里）。 */
    const from = Number(lastSequence) > 0 ? Number(lastSequence) : 0;
    let replayed = 0;
    let gap = false;
    if (from > 0 && turn.events.length && turn.events[0].sequence > from + 1) gap = true;
    for (const frame of turn.events) {
      if (frame.sequence <= from) continue;
      if (!writeStreamFrame(sink, frame)) { sink.closed = true; break; }
      replayed += 1;
    }
    if (replayed > 0) record('info', 'stream-replay', { turnId: turn.turnId, from: from, frames: replayed, gap: gap });

    /* 1b) 缓冲窗口之外的帧**永久**丢了（回合太长 / 断线太久）。
         不假装完整：明确告诉客户端"中间过程有缺口，请用 canonical 状态补"。
         chat.done 里始终带完整的 canonical 消息，sync.changes 也永远能拿到状态，
         所以这个缺口不影响正确性 —— 只影响"逐字看到过程"。 */
    if (gap) {
      writeStreamFrame(sink, {
        type: 'stream.error',
        sequence: 0,
        payload: {
          code: 'REPLAY_GAP',
          detail: 'events before sequence ' + String(turn.events[0].sequence) + ' are no longer buffered',
          resync: true,
          hint: 'call sync.changes with your last cursor for durable state'
        }
      });
    }

    /* 2) 已经结束的回合：回放完就补一条终结帧，然后关闭。
          这是"断线期间 generation 继续"的兑现点 —— 客户端回来时拿到的是结果，
          而不是一个悬着的连接。
          注意：终结帧在结束时**已经**进过缓冲并广播过，因此这里只在
          "客户端的已确认位置早于终结帧"时才补发（它可能已经收到了）。 */
    if (turn.status !== 'running') {
      const terminalSeq = turn.events.length ? turn.events[turn.events.length - 1].sequence : 0;
      if (terminalSeq > from) finish(null);          /* 回放里已经带了终结帧 */
      else if (turn.status === 'error') finish(Object.assign({ type: 'chat.error', sequence: ++turn.sequence }, { payload: errorPayloadFor(turn) }));
      else finish(Object.assign({ type: 'chat.done', sequence: ++turn.sequence }, { payload: donePayloadFor(turn) }));
      return { sink: sink, finished: true };
    }

    /* 3) 进行中：接下来由广播驱动。
       **不**注入合成的 chat.start：真正的 chat.start 永远是回合的第一个事件，
       已经被上面的回放循环发出去了。早期实现在这里又补一条，客户端会看到
       两条 chat.start（一条 seq=0 合成、一条 seq=1 真实），无从判断该听哪条。 */
    turn.sinks.add(sink);
    return { sink: sink, finished: false };
  }

  /* 终结帧（chat.done / chat.error）必须走**和普通事件同一条路**：
     进缓冲（供重连回放）+ 广播给在线订阅者，然后**关闭**在线流。
     早期实现有两个缺陷，都是实测抓出来的：
       1. 只在"重连到已结束回合"时补发终结帧 → 在线客户端永远等不到
          chat.done，一直挂到超时；
       2. 广播之后不关流 → 客户端拿到了 done 却等不到 EOF，仍然挂着。
     一个回合的流在终结帧之后就应该结束 —— 客户端要接着收别的消息，
     去订阅 /mobile/v1/events，而不是让这条流永久敞开。 */
  function emitTerminalFrame(turn, type, payload) {
    turn.sequence += 1;
    const frame = { type: type, sequence: turn.sequence, payload: payload };
    if (turn.events.length >= TURN_EVENT_BUFFER_MAX) turn.events.shift();
    turn.events.push(frame);
    broadcastTurn(turn, frame);
    /* 关闭所有**在线** sink：它们已经收到终结帧，流到此为止。 */
    for (const sink of Array.from(turn.sinks)) {
      sink.closed = true;
      try { sink.res.end(); } catch (_) { /* 已断开 */ }
      if (typeof sink.stopHeartbeat === 'function') sink.stopHeartbeat();
    }
    turn.sinks.clear();
    return frame;
  }

  function emitTurnStart(turn) {
    turn.sequence += 1;
    const frame = {
      type: 'chat.start',
      sequence: turn.sequence,
      payload: Object.assign(turnStatusPayload(turn), { replayGap: false, reattached: false })
    };
    turn.events.push(frame);
    broadcastTurn(turn, frame);
    return frame;
  }

  /* ── 事件频道（Phase 22/23）────────────────────────────────────────
     持久真相 = chat store 的 revision（change_log）。
     这里**不造第二套 event DB**：频道从同一个 change_log 扫，
     断线期间的事件靠 sync.changes 恢复 —— 这正是"state sync 与
     ephemeral event 分离"的落地方式。 */
  function ensureEventPump() {
    if (eventPump) return;
    if (!store || typeof store.changesAfter !== 'function') return;
    if (eventCursor == null) eventCursor = store.getRevision();
    eventPump = setInterval(pumpEvents, EVENT_POLL_MS);
    /* unref：常驻 timer 不得阻止进程自然退出（MEMORY.md 的测试纪律）。 */
    if (typeof eventPump.unref === 'function') eventPump.unref();
  }
  function stopEventPump() {
    if (eventPump) { clearInterval(eventPump); eventPump = null; }
  }
  function pumpEvents() {
    try {
      if (!subscribers.size) return;
      const page = store.changesAfter(eventCursor, { limit: EVENT_PAGE_LIMIT });
      if (!page || !page.ok) return;
      for (const entry of page.upserts) {
        const message = entry.message || {};
        broadcastEvent('message.created', {
          messageId: message.id,
          conversationId: CHAT_CORE.conversationIdOfMessage(message),
          characterId: String(message.friendId || ''),
          threadId: message.threadId ? String(message.threadId) : '',
          role: String(message.role || ''),
          timestamp: Number(message.timestamp) || 0,
          /* 通知只需要"是谁、在哪个会话、什么时候"。
             完整正文由客户端用 sync.changes 取 —— 通知里不放 hidden prompt、
             不放 memory、不放正文。 */
          source: (message.metadata && message.metadata.source) ? String(message.metadata.source) : 'chat',
          revision: entry.revision
        });
      }
      for (const entry of page.deletes) {
        broadcastEvent('message.deleted', {
          messageId: entry.messageId,
          conversationId: entry.conversationId || '',
          revision: entry.revision
        });
      }
      if (page.upserts.length || page.deletes.length) {
        broadcastEvent('cursor.changed', { cursor: page.cursor, revision: page.revision });
      }
      eventCursor = page.cursor;
    } catch (error) {
      record('warn', 'event-pump-failed', { error: String((error && error.message) || error).slice(0, 200) });
    }
  }
  function broadcastEvent(type, payload) {
    if (!subscribers.size) return;
    const frame = { type: type, payload: payload, at: clock() };
    for (const subscriber of subscribers) {
      deliverEvent(subscriber, frame);
    }
  }
  /* 每个订阅者有自己的有界队列：慢客户端被丢弃并被要求重新 sync，
     而不是让网关无限缓冲（Phase 23：ephemeral 事件丢失是**允许**的）。 */
  function deliverEvent(subscriber, frame) {
    if (subscriber.closed) return;
    if (subscriber.queue.length >= SUBSCRIBER_QUEUE_MAX) {
      subscriber.closed = true;
      try {
        writeStreamFrame(subscriber.sink, {
          type: 'notify.error',
          payload: { code: 'RATE_LIMITED', detail: 'subscriber backlog', resync: true }
        });
      } catch (_) { /* 已断开 */ }
      subscriber.stop();
      subscribers.delete(subscriber);
      record('warn', 'subscriber-dropped', { deviceId: subscriber.deviceId, reason: 'backlog' });
      return;
    }
    subscriber.queue.push(frame);
    flushSubscriber(subscriber);
  }
  function flushSubscriber(subscriber) {
    if (subscriber.closed || subscriber.paused) return;
    while (subscriber.queue.length) {
      const frame = subscriber.queue.shift();
      subscriber.sequence += 1;
      if (!writeStreamFrame(subscriber.sink, Object.assign({ sequence: subscriber.sequence }, frame))) {
        subscriber.closed = true;
        subscriber.stop();
        subscribers.delete(subscriber);
        return;
      }
    }
  }

  function deviceOnlineCount(deviceId) {
    return onlineDevices.get(String(deviceId)) || 0;
  }
  function addOnline(deviceId) {
    const id = String(deviceId);
    const next = (onlineDevices.get(id) || 0) + 1;
    onlineDevices.set(id, next);
    if (next === 1) broadcastEvent('presence.changed', { deviceId: id, online: true, at: clock() });
  }
  function removeOnline(deviceId) {
    const id = String(deviceId);
    const next = (onlineDevices.get(id) || 0) - 1;
    if (next <= 0) {
      onlineDevices.delete(id);
      broadcastEvent('presence.changed', { deviceId: id, online: false, at: clock() });
    } else {
      onlineDevices.set(id, next);
    }
  }
  function presenceSnapshot() {
    const devices = registry.listDevices({ activeOnly: true });
    const out = [];
    for (const device of devices) {
      device.online = deviceOnlineCount(device.deviceId) > 0;
      out.push(MOBILE_DTO.presenceDto(device));
    }
    return out;
  }

  /* ── 管理面（桌面内部 API，Phase 24）──────────────────────────────
     这些路径**不属于** mobile namespace：它们由 Home Node 的桌面 token /
     loopback 私密性保护（http.js 已经强制），不是设备 API。 */
  async function handleAdmin(action, req, res, url) {
    if (action === 'pairing/session' && req.method === 'POST') {
      let body;
      try { body = await readBody(req, 64 * 1024); }
      catch (error) { return fail(res, error.code || 'BAD_REQUEST', req, null, null); }
      const session = registry.createPairingSession({
        deviceName: body.deviceName, deviceType: body.deviceType
      });
      if (!session.ok) return fail(res, session.code || 'INTERNAL', req);
      record('info', 'pairing-session-created', { pairingId: session.pairingId });
      return sendJson(res, 200, okBody('pairing.session', null, {
        pairingId: session.pairingId,
        secret: session.secret,
        expiresAt: session.expiresAt,
        ttlMs: session.ttlMs,
        /* LAN 绑定被拒绝时这里如实为 false，桌面可以从容地提示"只能本机"，
           而不是给一个永远连不上的地址。 */
        lanReachable: lanMode,
        endpoints: {
          mobile: { host: lanHost(), port: deps.port || null, scheme: 'http' },
          pairPath: '/mobile/v1/pairing/complete'
        },
        fingerprint: session.fingerprint
      }), req);
    }
    if (action === 'devices' && req.method === 'GET') {
      const devices = registry.listDevices({});
      for (const device of devices) device.online = deviceOnlineCount(device.deviceId) > 0;
      return sendJson(res, 200, okBody('device.list', null, { devices: devices }), req);
    }
    if (action === 'device/revoke' && req.method === 'POST') {
      let body;
      try { body = await readBody(req, 64 * 1024); }
      catch (error) { return fail(res, error.code || 'BAD_REQUEST', req, null, null); }
      const result = registry.revokeDevice(body.deviceId, { by: 'desktop' });
      if (!result.ok) return fail(res, result.code || 'NOT_FOUND', req, 404);
      record('info', 'device-revoked-by-desktop', { deviceId: String(body.deviceId || '') });
      /* 立即踢掉该设备的活动流 —— "撤销立即生效"必须包含正在持续的那条连接，
         否则客户端会一边被撤销一边继续收流。 */
      disconnectDeviceStreams(String(body.deviceId || ''));
      return sendJson(res, 200, okBody('device.revoked', null, { device: result.device, alreadyRevoked: !!result.alreadyRevoked }), req);
    }
    if (action === 'characters' && req.method === 'GET') {
      const rows = registry.listCharacters();
      return sendJson(res, 200, okBody('character.catalog', null, {
        count: rows.length,
        forTurn: rows.filter(r => r.forTurn).length,
        catalogUpdatedAt: registry.characterCatalogUpdatedAt(),
        characters: rows.map(r => ({ id: r.id, updatedAt: r.updatedAt, forTurn: r.forTurn }))
      }), req);
    }
    if (action === 'characters/publish' && req.method === 'POST') {
      let body;
      try { body = await readBody(req, 4 * 1024 * 1024); }
      catch (error) { return fail(res, error.code || 'BAD_REQUEST', req, null, null); }
      const entries = Array.isArray(body.characters) ? body.characters : null;
      if (!entries) return fail(res, 'BAD_REQUEST', req, 400, null, { detail: 'characters[] is required' });
      const clean = [];
      for (const entry of entries) {
        if (!entry || !entry.id) continue;
        /* 桌面可能发原始 apiConfigs 条目，也可能发已经投影过的 {id,dto,spec}。
           两种形状都经**同一份** DTO 实现收口，因此即使桌面漏掉某个 secret，
           Node 侧也只接受白名单字段。 */
        const projected = MOBILE_DTO.characterCatalogEntry(entry, { withSpec: true });
        if (projected) clean.push({ id: projected.id, dto: projected.dto, spec: projected.spec || entry.spec || null });
      }
      const written = registry.putCharacters(clean, { merge: !!body.merge });
      if (!written.ok) return fail(res, written.code || 'INTERNAL', req);
      broadcastEvent('cursor.changed', { cursor: store.getRevision(), revision: store.getRevision(), catalogUpdatedAt: registry.characterCatalogUpdatedAt() });
      return sendJson(res, 200, okBody('character.published', null, {
        count: written.count, withSpec: written.withSpec, catalogUpdatedAt: registry.characterCatalogUpdatedAt()
      }), req);
    }
    return fail(res, 'NOT_FOUND', req, 404);
  }

  /* 撤销设备时立刻断开它的所有流。 */
  function disconnectDeviceStreams(deviceId) {
    for (const turn of liveTurns.values()) {
      if (turn.deviceId !== deviceId) continue;
      for (const sink of Array.from(turn.sinks)) {
        sink.closed = true;
        try { sink.res.end(); } catch (_) { /* 已断开 */ }
      }
      turn.sinks.clear();
    }
    for (const subscriber of Array.from(subscribers)) {
      if (subscriber.deviceId !== deviceId) continue;
      subscriber.closed = true;
      try {
        writeStreamFrame(subscriber.sink, { type: 'notify.error', payload: { code: 'DEVICE_REVOKED', resync: false } });
        subscriber.sink.close();
      } catch (_) { /* 已断开 */ }
      subscriber.stop();
      subscribers.delete(subscriber);
    }
  }

  function lanHost() {
    if (typeof deps.lanHost === 'function') return String(deps.lanHost() || '');
    return String(deps.lanHostValue || '');
  }

  /* ── mobile 路由 ──────────────────────────────────────────────────── */
  async function handleMobile(path, req, res, url) {
    const method = String(req.method || 'GET').toUpperCase();
    const action = path.replace(/^\/mobile\/v1\/?/, '');
    const isPairingPath = action === 'pairing/complete';

    /* OPTIONS 已经在 dispatch 里统一处理（见那里的说明）。 */

    /* 配对完成是**唯一**不需要设备 token 的 mobile 端点：
       它的凭据是 pairing secret 本身（一次性、短时、高熵）。
       它的限流按远端地址做 —— 这是 Phase 29 明确要求的。 */
    if (isPairingPath) {
      if (method !== 'POST') return fail(res, 'UNKNOWN_VERB', req, 405);
      const limited = rateLimit(remoteKey(req), 'pair');
      if (!limited.ok) {
        record('warn', 'rate-limited-pair', { remote: clientAddress(req) });
        return fail(res, 'RATE_LIMITED', req, 429, null, { retryAfterMs: limited.retryAfterMs });
      }
      let body;
      try { body = await readBody(req, 64 * 1024); }
      catch (error) { return fail(res, error.code || 'BAD_REQUEST', req, error.code === 'TOO_LARGE' ? 413 : 400); }
      const versionCheck = checkVersion(body);
      if (!versionCheck.ok) return fail(res, 'BAD_VERSION', req, 400, body && body.requestId, { detail: versionCheck.detail });
      const payload = body.payload || {};
      const consumed = registry.consumePairingSession({
        pairingId: payload.pairingId,
        secret: payload.secret,
        deviceName: payload.deviceName,
        deviceType: payload.deviceType,
        capabilities: payload.capabilities
      });
      if (!consumed.ok) {
        record('warn', 'pairing-failed', { code: consumed.code, remote: clientAddress(req) });
        return fail(res, consumed.code || 'PAIRING_INVALID', req, null, body && body.requestId);
      }
      record('info', 'paired', { deviceId: consumed.device.deviceId, type: consumed.device.type });
      /* 这是**唯一**返回设备凭据的响应。它位于 pairing/complete 路径上，
         是 Phase 27 显式豁免的 envelope。 */
      return sendJson(res, 200, okBody('pairing.complete', body && body.requestId, {
        device: consumed.device,
        token: consumed.token,
        tokenType: 'Bearer',
        profile: MOBILE_DTO.handshakeDto({
          protocol: PROTOCOL_VERSION, serverVersion: version, fingerprint: fingerprint,
          capabilities: consumed.device.capabilities
        })
      }), req);
    }

    /* 以下全部需要设备鉴权。 */
    const auth = authenticate(req);
    if (!auth.ok) {
      const failureKey = remoteKey(req) + ':auth';
      const limited = rateLimit(failureKey, 'authFail');
      if (!limited.ok) {
        record('warn', 'rate-limited-auth', { remote: clientAddress(req) });
        return fail(res, 'RATE_LIMITED', req, 429, null, { retryAfterMs: limited.retryAfterMs });
      }
      record('warn', 'mobile-unauthorized', { action: action, path: path, code: auth.code });
      return fail(res, auth.code, req);
    }
    const device = auth.device;

    /* 读类动词按设备限流；写类更严。 */
    const readOnly = method === 'GET';
    const ruleName = action === 'chat/stream' ? 'stream' : (readOnly ? 'read' : 'send');
    const limited = rateLimit('dev:' + device.deviceId + ':' + (readOnly ? 'r' : 'w'), ruleName);
    if (!limited.ok) {
      record('warn', 'rate-limited', { deviceId: device.deviceId, action: action });
      return fail(res, 'RATE_LIMITED', req, 429, null, { retryAfterMs: limited.retryAfterMs });
    }

    /* GET 端点（无需版本信封：它们在 URL 里，没有 body 可以协商）。
       版本通过这些端点的响应头 X-IB-Mobile-Protocol 表达。 */
    if (method === 'GET') {
      if (action === 'handshake') {
        return sendJson(res, 200, okBody('handshake', null, MOBILE_DTO.handshakeDto({
          protocol: PROTOCOL_VERSION,
          serverVersion: version,
          fingerprint: fingerprint,
          capabilities: device.capabilities
        })), req);
      }
      if (action === 'device/self') {
        const self = registry.getDevice(device.deviceId);
        if (self) self.online = deviceOnlineCount(self.deviceId) > 0;
        return sendJson(res, 200, okBody('device.self', null, {
          device: self,
          protocol: PROTOCOL_VERSION,
          serverVersion: version,
          fingerprint: fingerprint
        }), req);
      }
      if (action === 'character/list') {
        return sendJson(res, 200, okBody('character.list', null, characterList(device)), req);
      }
      const characterMatch = /^character\/([^/]+)$/.exec(action);
      if (characterMatch) {
        const id = decodeURIComponent(characterMatch[1]);
        const row = registry.getCharacter(id);
        if (!row) return fail(res, 'NOT_FOUND', req, 404);
        return sendJson(res, 200, okBody('character.get', null, {
          character: MOBILE_DTO.characterDto(Object.assign({ id: row.id }, row.dto)),
          catalogUpdatedAt: registry.characterCatalogUpdatedAt()
        }), req);
      }
      if (action === 'chat/history') {
        const query = {
          conversationId: url.searchParams.get('conversationId') || undefined,
          characterId: url.searchParams.get('characterId') || undefined,
          threadId: url.searchParams.get('threadId') || undefined,
          limit: url.searchParams.get('limit') || undefined
        };
        if (!query.conversationId && query.characterId) {
          query.conversationId = conversationIdFor(query.characterId, query.threadId || '');
        }
        if (!query.conversationId) return fail(res, 'BAD_REQUEST', req, 400, null, { detail: 'conversationId or characterId is required' });
        const cursor = url.searchParams.get('cursor');
        const before = url.searchParams.get('before');
        if (cursor != null) query.cursor = parseAnchor(cursor);
        if (before != null) query.before = parseAnchor(before);
        const page = store.listMessages(query);
        if (!page.ok) return fail(res, page.error === 'ambiguous-range' ? 'BAD_REQUEST' : page.error, req);
        const messages = [];
        for (const message of page.messages) messages.push(toMessageDto(message, null));
        return sendJson(res, 200, okBody('chat.history', null, {
          conversationId: query.conversationId,
          messages: messages,
          count: messages.length,
          /* 分页锚点与 M1-A 完全一致：有 cursor / oldest / newest / hasMore，
             客户端不要自造第二套游标语义。 */
          cursor: page.cursor == null ? null : page.cursor,
          oldest: page.oldest == null ? null : page.oldest,
          newest: page.newest == null ? null : page.newest,
          hasMore: !!page.hasMore,
          hasOlder: !!page.hasOlder,
          hasNewer: !!page.hasNewer,
          revision: page.revision == null ? store.getRevision() : page.revision
        }), req);
      }
      if (action === 'sync/changes') {
        const rawCursor = url.searchParams.get('cursor') != null ? url.searchParams.get('cursor') : url.searchParams.get('since');
        const cursor = rawCursor == null ? 0 : Number(rawCursor);
        const page = store.changesAfter(cursor, { limit: url.searchParams.get('limit') || undefined });
        if (!page.ok) return fail(res, page.error, req);
        const upserts = [];
        for (const entry of page.upserts) upserts.push(toMessageDto(entry.message, entry.revision));
        return sendJson(res, 200, okBody('sync.changes', null, {
          cursor: page.cursor,
          revision: page.revision,
          upserts: upserts,
          deletes: page.deletes,
          hasMore: page.hasMore,
          serverTime: page.serverTime == null ? clock() : page.serverTime
        }), req);
      }
      if (action === 'presence') {
        return sendJson(res, 200, okBody('presence', null, { devices: presenceSnapshot() }), req);
      }
      const turnMatch = /^turns\/([^/]+)$/.exec(action);
      if (turnMatch) {
        const key = decodeURIComponent(turnMatch[1]);
        const turn = getTurn(key) || getTurnByRequest(key);
        if (!turn) return fail(res, 'NOT_FOUND', req, 404, null, { detail: 'unknown turn' });
        return sendJson(res, 200, okBody('turn.status', null, turnStatusPayload(turn)), req);
      }
      if (action === 'events') {
        return openEventStream(req, res, device);
      }
      /* 流式回合的重连：GET 版本，用 Last-Event-ID / ?after= 表达"我收到哪了"。 */
      const streamMatch = /^chat\/stream\/([^/]+)$/.exec(action);
      if (streamMatch) {
        const key = decodeURIComponent(streamMatch[1]);
        const turn = getTurn(key) || getTurnByRequest(key);
        if (!turn) return fail(res, 'NOT_FOUND', req, 404, null, { detail: 'unknown turn' });
        const header = String(req.headers['last-event-id'] || '');
        const after = url.searchParams.get('after');
        const lastSequence = sequenceOf(after != null ? after : header);
        attachTurnStream(turn, req, res, lastSequence);
        return undefined;
      }
      return fail(res, 'UNKNOWN_VERB', req, 404, null, { detail: action || '/' });
    }

    if (method === 'POST') {
      let body;
      try { body = await readBody(req, maxBodyBytes); }
      catch (error) {
        return fail(res, error.code === 'TOO_LARGE' ? 'TOO_LARGE' : 'BAD_REQUEST', req,
          error.code === 'TOO_LARGE' ? 413 : 400);
      }
      const versionCheck = checkVersion(body);
      if (!versionCheck.ok) {
        record('warn', 'bad-version', { action: action, detail: versionCheck.detail, deviceId: device.deviceId });
        return fail(res, 'BAD_VERSION', req, 400, body && body.requestId, { detail: versionCheck.detail });
      }
      const requestId = body && body.requestId ? String(body.requestId) : null;

      if (action === 'chat/send') {
        if (!executor) return fail(res, 'UNSUPPORTED', req, 501);
        if (!requireCapability(device, 'chat')) return fail(res, 'CONFLICT', req, 409, requestId, { detail: 'device capability "chat" is not granted' });
        const parsed = parseSendPayload(body, device);
        if (!parsed.ok) {
          return fail(res, parsed.code, req, null, requestId, { detail: parsed.detail });
        }
        /* 同一个 requestId 的**第二次** chat.send：
           不重新开始一个回合、不再调用模型、不再插第二条 user 消息。
           客户端要么接上原来那个回合的流，要么直接 sync.changes 看 canonical 结果。
           （这是 Phase 17 的核心保证，且它是 M1-A 幂等表的直接延续，
             不是网关自己另造的一套去重。） */
        const priorTurn = getTurnByRequest(parsed.requestId);
        if (priorTurn) {
          record('info', 'chat-send-duplicate', {
            deviceId: device.deviceId, turnId: priorTurn.turnId, status: priorTurn.status,
            requestId: parsed.requestId
          });
          const duplicatePayload = Object.assign(turnStatusPayload(priorTurn), {
            streamUrl: '/mobile/v1/chat/stream/' + encodeURIComponent(priorTurn.turnId),
            eventsUrl: '/mobile/v1/events',
            disconnectPolicy: 'generation-continues',
            duplicateRequest: true
          });
          /* 已经结束的重复请求：直接把结果给出来，客户端不必再开流。 */
          if (priorTurn.status !== 'running') {
            duplicatePayload.result = priorTurn.status === 'error' ? errorPayloadFor(priorTurn) : donePayloadFor(priorTurn);
            return sendJson(res, 200, okBody('chat.send', requestId, duplicatePayload), req);
          }
          if (wantsStream(req, body.payload)) {
            attachTurnStream(priorTurn, req, res, 0);
            return undefined;
          }
          return sendJson(res, 202, okBody('chat.send', requestId, duplicatePayload), req);
        }

        const turn = beginTurn(parsed, device);
        const payload = {
          turnId: turn.turnId,
          requestId: turn.requestId,
          conversationId: turn.conversationId,
          status: turn.status,
          streamUrl: '/mobile/v1/chat/stream/' + encodeURIComponent(turn.turnId),
          eventsUrl: '/mobile/v1/events',
          /* 断线语义写在响应里，客户端不必读文档才知道：
             客户端断开**不**取消生成。 */
          disconnectPolicy: 'generation-continues'
        };
        record('info', 'chat-send', {
          deviceId: device.deviceId, turnId: turn.turnId, conversationId: turn.conversationId,
          characterId: turn.characterId, requestId: turn.requestId, streamed: wantsStream(req, body.payload)
        });
        /* Accept: text/event-stream → 同一个请求里把流接上（客户端少一次往返）。
           否则返回 202 + streamUrl，客户端随后 GET chat/stream/<turnId>。
           两条路都指向**同一个** turn 对象，不存在第二套执行路径。 */
        if (wantsStream(req, body.payload)) {
          attachTurnStream(turn, req, res, 0);
        } else {
          sendJson(res, 202, okBody('chat.send', requestId, payload), req);
        }
        /* 回合在响应之后继续跑：客户端断开也不影响它（Phase 18）。 */
        emitTurnStart(turn);
        runTurn(turn).then(function (settled) {
          if (settled.status === 'error') {
            record('warn', 'turn-error', { turnId: settled.turnId, code: settled.error });
          } else {
            record('info', 'turn-settled', {
              turnId: settled.turnId, status: settled.status,
              assistantMessageId: settled.assistantMessageId, revision: settled.revision
            });
          }
        });
        return undefined;
      }

      if (action === 'chat/retry') {
        /* 与 chat/send 同一条路径（同一个 requestId 会命中 M1-A 的幂等表）。
           单独给一个 verb 是为了让客户端语义清晰，**不是**第二套实现。 */
        return handleMobile('chat/send', req, res, url);
      }

      if (action === 'device/token/rotate') {
        const rotated = registry.rotateDeviceToken(device.deviceId);
        if (!rotated.ok) return fail(res, rotated.code || 'INTERNAL', req, null, requestId);
        record('info', 'device-token-rotated', { deviceId: device.deviceId, tokenVersion: rotated.device.tokenVersion });
        return sendJson(res, 200, okBody('device.token', requestId, {
          device: rotated.device, token: rotated.token, tokenType: 'Bearer'
        }), req);
      }
      if (action === 'device/revoke') {
        const result = registry.revokeDevice(device.deviceId, { by: 'self' });
        if (!result.ok) return fail(res, result.code || 'INTERNAL', req, null, requestId);
        record('info', 'device-self-revoked', { deviceId: device.deviceId });
        disconnectDeviceStreams(device.deviceId);
        return sendJson(res, 200, okBody('device.revoked', requestId, { device: result.device }), req);
      }
      if (action === 'device/rename') {
        const payload = body.payload || {};
        const renamed = registry.renameDevice(device.deviceId, payload.name);
        if (!renamed.ok) return fail(res, renamed.code || 'BAD_REQUEST', req, null, requestId);
        return sendJson(res, 200, okBody('device.updated', requestId, { device: renamed.device }), req);
      }
      if (action === 'presence/report') {
        const payload = body.payload || {};
        const reported = registry.touchDevice(device.deviceId, {
          /* appForeground 是**唯一**接受的 presence 细节。
             刻意不接受 battery / GPS / sensor / 完整设备指纹（Phase 19）。 */
          appForeground: payload.appForeground === undefined ? undefined : !!payload.appForeground
        });
        if (!reported.ok) return fail(res, reported.code || 'INTERNAL', req, null, requestId);
        return sendJson(res, 200, okBody('presence.reported', requestId, {
          lastSeenAt: reported.lastSeenAt,
          online: deviceOnlineCount(device.deviceId) > 0
        }), req);
      }
      if (action === 'chat/stream') {
        const payload = body.payload || {};
        const turn = payload.turnId ? getTurn(payload.turnId) : getTurnByRequest(payload.requestId);
        if (!turn) return fail(res, 'NOT_FOUND', req, 404, requestId, { detail: 'unknown turn' });
        const lastSequence = payload.after != null ? Number(payload.after) : sequenceOf(String(req.headers['last-event-id'] || ''));
        attachTurnStream(turn, req, res, lastSequence);
        return undefined;
      }
      return fail(res, 'UNKNOWN_VERB', req, 404, requestId, { detail: action || '/' });
    }

    return fail(res, 'UNKNOWN_VERB', req, 405);
  }

  function sequenceOf(headerValue) {
    const text = String(headerValue || '');
    if (!text) return 0;
    /* 支持 "<streamId>:<seq>" 与裸数字两种写法。 */
    const colon = text.lastIndexOf(':');
    const tail = colon >= 0 ? text.slice(colon + 1) : text;
    const n = Number(tail);
    return isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }

  /* 客户端是否要求在**本请求**内拿到 SSE 流。
     支持 Accept 头（HTTP 语义）与显式 payload.stream=true（某些原生客户端
     不方便设 Accept）。两者都走同一个 attachTurnStream。 */
  function wantsStream(req, payload) {
    const accept = String((req && req.headers && req.headers.accept) || '');
    if (accept.toLowerCase().indexOf('text/event-stream') >= 0) return true;
    return !!(payload && payload.stream === true);
  }

  function parseAnchor(raw) {
    const text = String(raw == null ? '' : raw);
    if (/^\d+$/.test(text)) return Number(text);
    if (text.charAt(0) === '{') {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) { /* 不是 JSON → 当 id */ }
    }
    return text;
  }

  /* 事件频道。设备订阅后收到 message.created / message.deleted / cursor.changed /
     presence.changed。**正文不在事件里** —— 客户端用 sync.changes 取状态。 */
  function openEventStream(req, res, device) {
    const sink = openStream(req, res, {});
    const stop = attachHeartbeat(sink, s => writeComment(s, 'ping ' + clock()));
    const subscriber = {
      deviceId: device.deviceId,
      sink: sink,
      queue: [],
      sequence: 0,
      closed: false,
      paused: false,
      stop: stop
    };
    /* 首帧：告诉客户端它现在的同步位置（这样它不必先问一次）。
       同时如实声明：事件是 ephemeral，丢帧不会丢数据。 */
    deliverEvent(subscriber, {
      type: 'cursor.changed',
      payload: {
        cursor: store.getRevision(),
        revision: store.getRevision(),
        resumed: false,
        hint: 'events are ephemeral; use sync.changes for durable state'
      }
    });
    subscribers.add(subscriber);
    addOnline(device.deviceId);
    ensureEventPump();
    record('info', 'events-subscribed', { deviceId: device.deviceId, subscribers: subscribers.size });
    res.on('close', function () {
      stop();
      subscriber.closed = true;
      subscribers.delete(subscriber);
      removeOnline(device.deviceId);
      record('info', 'events-detached', { deviceId: device.deviceId, subscribers: subscribers.size });
    });
    return undefined;
  }

  /* ── 管理面（桌面内部 API，Phase 24）──────────────────────────────
     这些路径**不属于** mobile namespace：它们由 Home Node 的桌面 token /
     loopback 私密性保护（http.js 已经强制），不是设备 API。
     因此 http.js 把它们**原样交给同一个 dispatch**，而 dispatch 在
     /mobile/v1 分支里才做设备鉴权。 */
  async function dispatch(path, req, res, url) {
    /* 预检（Phase 20）在**任何**分支之前处理。
       为什么必须在这里而不是 handleMobile 里：
         · /mobile/v1/* 与桌面管理面（/characters/publish、/pairing/session…）
           都要能被浏览器调用，两者都需要预检；
         · 浏览器在预检时不会带 Authorization（也不带设备 token），
           所以预检**不做**鉴权 —— 它不携带任何世界数据，也不代表授权，
           真正的请求仍然必须过 token。
       早期实现把这段放在 handleMobile 里，于是 /characters/publish 的预检
       落进了 handleAdmin 并返回 404（带 CORS 头但不含 Allow-Methods），
       浏览器判定预检失败 → 整个 POST 变成 "Failed to fetch"，
       而服务端日志只看到一次 OPTIONS。实测踩到过。 */
    if (String(req.method || '').toUpperCase() === 'OPTIONS') {
      const origin = String(req.headers.origin || '');
      const headers = { Vary: 'Origin' };
      if (originAllowed(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-IB-Mobile-Token, X-IB-Home-Token, X-IB-Protocol, Last-Event-ID';
        headers['Access-Control-Max-Age'] = '600';
      }
      headers['X-IB-Mobile-Protocol'] = String(PROTOCOL_VERSION);
      res.writeHead(204, headers);
      res.end();
      return undefined;
    }
    if (path.indexOf('/mobile/v1') === 0) return handleMobile(path, req, res, url);
    if (path.indexOf('/mobile/') === 0) {
      /* /mobile/v1 以外的 mobile 路径明确不存在（不做版本猜测、不做重定向）。 */
      return fail(res, 'UNKNOWN_VERB', req, 404, null, { detail: path });
    }
    return handleAdmin(path.replace(/^\//, ''), req, res, url);
  }

  /* 网关是否拥有这个路径。http.js 用它决定要不要把请求交过来；
     这份清单是**暴露面allowlist**：不在其中的路径连网关都不会看到。 */
  function handles(path) {
    return ADMIN_PATHS.indexOf(path) >= 0 || path.indexOf('/mobile/') === 0;
  }

  async function handle(action, req, res, url) {
    return handleAdmin(action, req, res, url);
  }

  function meta() {
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      lanMode: lanMode,
      fingerprint: fingerprint,
      devices: registry.isOpen() ? registry.meta().devices : 0,
      subscribers: subscribers.size,
      onlineDevices: onlineDevices.size,
      liveTurns: liveTurns.size,
      log: logRing.slice(-40)
    };
  }

  return {
    dispatch: dispatch,
    handles: handles,
    handle: handle,
    meta: meta,
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    ERROR_STATUS: ERROR_STATUS,
    STREAM_EVENTS: STREAM_EVENTS,
    NOTIFY_EVENTS: NOTIFY_EVENTS,
    ADMIN_PATHS: ADMIN_PATHS,
    limiter: limiter,
    /* 测试与诊断用 */
    attachTurnStream: attachTurnStream,
    getTurn: getTurn,
    getTurnByRequest: getTurnByRequest,
    presenceSnapshot: presenceSnapshot,
    subscribeCount: function () { return subscribers.size; },
    stop: function () { stopEventPump(); }
  };
}

module.exports = createMobileGateway;
module.exports.PROTOCOL_VERSION = PROTOCOL_VERSION;
module.exports.MOBILE_MAX_BODY_BYTES = MOBILE_MAX_BODY_BYTES;
module.exports.ERROR_STATUS = ERROR_STATUS;
module.exports.createRateLimiter = createRateLimiter;
