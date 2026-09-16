/* ====================================================================
   IB Home Node Client — 浏览器侧唯一的 Home Node 传输实现
   --------------------------------------------------------------------
   职责边界（刻意收窄）：
     · 只做 HTTP + 响应形状校验 + 错误分类；
     · 不含任何权威/镜像/回退策略（那是 assets/js/chat-authority.js 的事）；
     · 不含 IndexedDB 访问（那是 core.js 的 local driver）。
   这样 chat-authority 可以在 Node 里用 mock 完整测试，
   而真正的网络与本地存储各自只有一个实现。

   地址与开关（全部走既有约定，不引入新的配置存储）：
     · localStorage['ib_home_node_http'] 覆盖地址（与 ib_bridge_http 同款约定）
     · localStorage['ib_home_node_mode'] = canonical（默认）| mirror | off
     · localStorage['ib_home_node_token'] 可选令牌（与 Bridge 的 token 同一思路）
   三项都是**私有的本地配置**，不进 apiSettings、不进导出、不进日志。
   ==================================================================== */
(function (NS) {
'use strict';

var DEFAULT_BASE = 'http://127.0.0.1:23118';
var DEFAULT_TIMEOUT_MS = 15000;
var MIGRATION_TIMEOUT_MS = 60000;

function _ls(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function ibHomeNodeBase() {
  var v = _ls('ib_home_node_http');
  if (v) return String(v).replace(/\/+$/, '');
  return DEFAULT_BASE;
}
function ibHomeNodeMode() {
  var v = String(_ls('ib_home_node_mode') || 'canonical').trim().toLowerCase();
  return (v === 'mirror' || v === 'off') ? v : 'canonical';
}
function ibHomeNodeToken() {
  return String(_ls('ib_home_node_token') || '').trim();
}
window.ibHomeNodeBase = ibHomeNodeBase;
window.ibHomeNodeMode = ibHomeNodeMode;
window.ibHomeNodeToken = ibHomeNodeToken;

/* 错误分类词表：调用方据此分支，禁止用错误文案匹配。 */
function _classifyFetchError(error) {
  var name = String((error && error.name) || '');
  var msg = String((error && error.message) || error || '');
  if (name === 'AbortError' || /abort/i.test(msg)) return { code: 'timeout', retryable: true, message: msg };
  if (/Failed to fetch|NetworkError|ECONNREFUSED|load failed/i.test(msg)) return { code: 'home-node-unreachable', retryable: true, message: msg };
  return { code: 'home-node-transport-error', retryable: true, message: msg };
}

function _request(pathname, options) {
  options = options || {};
  var url = ibHomeNodeBase() + pathname;
  var headers = { 'X-IB-Protocol': '1' };
  var token = ibHomeNodeToken();
  if (token) headers['X-IB-Home-Token'] = token;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  var controller = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = null;
  var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* 已结束 */ } }, timeoutMs);
  function finish(promise) {
    return promise.then(function (res) { if (timer) clearTimeout(timer); return res; },
      function (err) { if (timer) clearTimeout(timer); throw err; });
  }
  var init = {
    method: options.method || 'GET',
    headers: headers,
    cache: 'no-store'
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (controller) init.signal = controller.signal;
  return finish(fetch(url, init)).then(function (res) {
    return res.text().then(function (raw) {
      var parsed = null;
      try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) { parsed = null; }
      if (parsed == null) return { ok: false, error: 'invalid-response', status: res.status, protocolVersion: 1 };
      /* 合法 JSON 但**不是对象**（`"text"` / `42` / `[1,2]`）也是坏信封。
         P11-3F 之前这里会继续往下走并在字符串上赋属性 → TypeError 从一个
         成功解析的响应里抛出来，调用方只看到"传输失败"。形状不对就该在
         这里、以既有词表里的 `invalid-response` 结束 —— 而不是变成一个异常。 */
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'invalid-response', status: res.status, protocolVersion: 1 };
      }
      if (!res.ok && parsed.ok !== false) parsed.ok = false;
      parsed.status = res.status;
      if (parsed.protocolVersion == null) parsed.protocolVersion = 1;
      return parsed;
    });
  }, function (error) {
    var classified = _classifyFetchError(error);
    return { ok: false, error: classified.code, retryable: classified.retryable, detail: classified.message, offline: true };
  });
}

/* ── P22-12 §9 · 商品 → 目录事实的**唯一**投影 ─────────────────────────
   白名单构造式：结果里只有这六个键，而且值是字符串且长度有界。
   ★ 它刻意**不**是 `delete` 列表：`/economy/products` 现在返回的字段里就有
   currency / unitPriceMinor / grantQuantity，服务端将来还可能新增别的经济
   字段 —— 白名单让那些字段**默认不可达**，而不是"记得去删它"。
   ★ 这里也不判断"这个商品能不能买"：availability（status）只是事实，
   能不能买是 P22-7/P22-8 的判定，不属于本函数。 */
var ECONOMY_CATALOG_FACT_FIELDS = ['productId', 'name', 'description', 'kind', 'unitName', 'status'];
var ECONOMY_CATALOG_FACT_MAX = 200;
function economyCatalogFact(product) {
  var src = (product && typeof product === 'object') ? product : {};
  var fact = {};
  for (var i = 0; i < ECONOMY_CATALOG_FACT_FIELDS.length; i++) {
    var key = ECONOMY_CATALOG_FACT_FIELDS[i];
    if (src[key] == null) continue;
    fact[key] = String(src[key]).slice(0, ECONOMY_CATALOG_FACT_MAX);
  }
  return fact;
}

/* ── remote driver（chat-authority 的注入契约）────────────────────── */
function createHomeNodeRemote(deps) {
  deps = deps || {};
  return {
    /* 只读探针：绝不带任何世界数据，因此不需要 token。 */
    health: function () {
      return _request('/health', { timeoutMs: deps.healthTimeoutMs || 4000 });
    },
    status: function () {
      return _request('/status');
    },
    list: function (query) {
      query = query || {};
      var qs = [];
      if (query.conversationId) qs.push('conversationId=' + encodeURIComponent(query.conversationId));
      if (query.friendId) qs.push('friendId=' + encodeURIComponent(query.friendId));
      if (query.threadId) qs.push('threadId=' + encodeURIComponent(query.threadId));
      if (query.limit) qs.push('limit=' + encodeURIComponent(query.limit));
      return _request('/list' + (qs.length ? '?' + qs.join('&') : ''));
    },
    changes: function (cursor, options) {
      options = options || {};
      return _request('/changes?cursor=' + encodeURIComponent(Number(cursor) || 0) +
        (options.limit ? '&limit=' + encodeURIComponent(options.limit) : ''));
    },
    put: function (message, options) {
      options = options || {};
      var payload = { message: message };
      if (options.requestId) payload.requestId = String(options.requestId);
      if (options.existingPolicy) payload.existingPolicy = String(options.existingPolicy);
      return _request('/messages', { method: 'POST', body: payload, timeoutMs: deps.writeTimeoutMs });
    },
    putBatch: function (messages, options) {
      options = options || {};
      var payload = { messages: messages, forceBatch: true };
      if (options.requestId) payload.requestId = String(options.requestId);
      if (options.existingPolicy) payload.existingPolicy = String(options.existingPolicy);
      return _request('/messages', { method: 'POST', body: payload, timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS });
    },
    remove: function (id, options) {
      options = options || {};
      return _request('/message?id=' + encodeURIComponent(id) +
        (options.requestId ? '&requestId=' + encodeURIComponent(options.requestId) : ''), { method: 'DELETE' });
    },
    migrationState: function (source) {
      return _request('/migration?source=' + encodeURIComponent(source || 'default'));
    },
    markMigration: function (source, patch) {
      return _request('/migrate', { method: 'POST', body: Object.assign({ source: source || 'default' }, patch || {}), timeoutMs: MIGRATION_TIMEOUT_MS });
    },
    verify: function () {
      return _request('/verify', { timeoutMs: MIGRATION_TIMEOUT_MS });
    },
    security: function () {
      return _request('/security');
    },

    /* ── P22-12 §9 · 目录事实（只读 · 构造式投影）────────────────────
       数据源是**既有**的 P22-5 读面 `GET /economy/products`（本文件不认识
       任何新的 Economy API，也不新增端点）。它做且只做一件事：把服务端
       那条**完整**的商品序列化投影成"商品是什么"。

       ★ 为什么投影是构造式的而不是"删掉几个字段"：服务端的
       serializeProduct 里真的有 currency / unitPriceMinor / grantQuantity
       （`/economy/products` 是**桌面**读面，它的读者本来就有权看价格）。
       而这份投影的唯一消费者是**模型 prompt**，因此价格、币种、发放数量
       一律不进结果 —— 不是靠调用方记得别传，而是白名单里根本没有它们。
       一份"减字段"的实现会在服务端**新增**一个经济字段时静默泄漏它。

       ★ 返回形状：`{ok, products:[…], unreachable|error}`。失败**不抛**：
       目录取不到只是"这次不宣告这个动作"，绝不能让一次网络抖动打断
       规划链（调用方 fail closed 到空目录）。 */
    economyCatalogFacts: function (options) {
      options = options || {};
      var qs = ['limit=' + encodeURIComponent(Number(options.limit) || 20)];
      if (options.storeId) qs.push('storeId=' + encodeURIComponent(String(options.storeId)));
      if (options.status) qs.push('status=' + encodeURIComponent(String(options.status)));
      return _request('/economy/products?' + qs.join('&'), { timeoutMs: deps.catalogTimeoutMs || DEFAULT_TIMEOUT_MS })
        .then(function (res) {
          if (!res || res.ok !== true || !Array.isArray(res.products)) {
            return { ok: false, products: [], error: (res && res.error) || 'catalog-unavailable' };
          }
          return { ok: true, products: res.products.map(economyCatalogFact), error: null };
        }, function (error) {
          return { ok: false, products: [], error: 'catalog-unreachable', detail: String((error && error.message) || error) };
        });
    },

    /* ── M1-B：桌面管理面（配对 / 设备 / 角色目录）─────────────────────
       这些路径**不是** mobile namespace：它们走 Home Node 既有的 loopback +
       token 保护，属于"本机特权客户端"的能力。设备 API 在 /mobile/v1/* 下，
       由 per-device token 保护，桌面不碰它。 */

    /* 创建一次性配对载荷。返回 {pairingId, secret, expiresAt, endpoints, …}，
       主进程之外不落盘、不进日志。 */
    pairingSession: function (options) {
      options = options || {};
      var payload = {};
      if (options.deviceName) payload.deviceName = String(options.deviceName);
      if (options.deviceType) payload.deviceType = String(options.deviceType);
      return _request('/pairing/session', { method: 'POST', body: payload });
    },
    devices: function () {
      return _request('/devices');
    },
    revokeDevice: function (deviceId) {
      return _request('/device/revoke', { method: 'POST', body: { deviceId: String(deviceId || '') } });
    },
    characterCatalog: function () {
      return _request('/characters');
    },
    /* 发布角色目录。调用方（home-node-bootstrap）传入的条目已经过
       assets/js/mobile-dto.js 的 characterCatalogEntry 投影；
       Node 侧会**再**用同一份实现收口一次，因此即使这里漏了字段，
       出站也不可能带上凭据。
       options.user：P0 用户展示身份（{id,name}），同样已过 userProfileDto
       白名单投影。缺席时 Node 保持上一次已知值，不清空。
       options.middleBrain（M1-C.2i）：Middle Brain **执行策略**投影，
       已过 middle-brain-config-core.projectExecutionConfig 的构造式白名单
       （其中根本没有 endpoint/model/apiKey）。同样"缺席不清空"。 */
    publishCharacters: function (characters, options) {
      options = options || {};
      var body = { characters: characters || [], merge: !!options.merge };
      if (options.user) body.user = options.user;
      if (options.middleBrain) body.middleBrain = options.middleBrain;
      return _request('/characters/publish', {
        method: 'POST',
        body: body,
        /* 目录可能含内联头像 base64，给足超时（与迁移同一量级）。 */
        timeoutMs: options.timeoutMs || MIGRATION_TIMEOUT_MS
      });
    }
  };
}

NS.ibHomeNodeBase = ibHomeNodeBase;
NS.ibHomeNodeMode = ibHomeNodeMode;
NS.ibHomeNodeToken = ibHomeNodeToken;
NS.createHomeNodeRemote = createHomeNodeRemote;
NS.economyCatalogFact = economyCatalogFact;
NS.ECONOMY_CATALOG_FACT_FIELDS = ECONOMY_CATALOG_FACT_FIELDS;
NS.ibHomeNodeConstants = { DEFAULT_BASE: DEFAULT_BASE, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS, MIGRATION_TIMEOUT_MS: MIGRATION_TIMEOUT_MS };

/* ── memory remote driver（memory-authority 的注入契约）──────────────
   M1-C.2d Wave 2。刻意与 chat 的 remote driver **分开**：
     · 两者的方法名不同（putBatch 语义、activate、putSettings）；
     · 合并成一个对象会让"某一边多了一个方法"这种接线错误无法被发现
       （chat-authority 会拿到一个看起来合法但不该存在的 driver）。
   只做 HTTP + 形状校验，不含任何权威/镜像/回退策略。

   ⚠️ 信封（envelope）与 chat 不同 —— 这是**服务端既成事实**，不是客户端选择：
   `/memory/*` 由 services/home-node/mobile-gateway.js 服务，它用 okBody() 把
   每个成功响应包成 { v, ok:true, type, requestId, serverTime, payload:{…} }；
   而 `/list` `/changes` 等桌面聊天面返回**裸对象**。memory-authority 是按
   裸形状（page.records / res.upserts / res.cursor / res.settings / state.state）
   写的，因此每次调用都必须先解一层 payload —— 否则 list 会读到 undefined.records
   并把镜像 replaceAll([]) 清空，changes 会因 res.upserts.length 抛 TypeError。
   解包是**统一**的（不逐端点特判），失败响应刻意不解包：错误语义必须原样保留。 */
function _unwrapMemoryEnvelope(res) {
  /* 失败优先：ok 不为真（含 offline / timeout / invalid-response 本地合成结果，
     它们没有 payload）时原样返回，调用方继续按 res.ok / res.error 分支。 */
  if (!res || res.ok !== true) return res;
  var payload = res.payload;
  /* payload 缺席（如 /health）或不是普通对象时不动它 —— 保持既有可观测形状。 */
  if (!payload || typeof payload !== 'object') return res;
  /* 就地合并：payload 的字段成为顶层字段，信封元数据（ok/status/type/
     serverTime/protocolVersion/requestId）全部保留。 */
  for (var key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) res[key] = payload[key];
  }
  return res;
}

function createMemoryRemote(deps) {
  deps = deps || {};
  return {
    health: function () {
      return _request('/health', { timeoutMs: deps.healthTimeoutMs || 4000 });
    },
    list: function (query) {
      query = query || {};
      var qs = [];
      if (query.ownerId) qs.push('ownerId=' + encodeURIComponent(query.ownerId));
      if (query.limit) qs.push('limit=' + encodeURIComponent(query.limit));
      return _request('/memory/list' + (qs.length ? '?' + qs.join('&') : ''), { timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    },
    changes: function (cursor, options) {
      options = options || {};
      return _request('/memory/changes?cursor=' + encodeURIComponent(Number(cursor) || 0) +
        (options.limit ? '&limit=' + encodeURIComponent(options.limit) : '')).then(_unwrapMemoryEnvelope);
    },
    put: function (record, options) {
      options = options || {};
      var payload = { record: record };
      if (options.requestId) payload.requestId = String(options.requestId);
      if (options.existingPolicy) payload.existingPolicy = String(options.existingPolicy);
      return _request('/memory/records', { method: 'POST', body: payload, timeoutMs: deps.writeTimeoutMs }).then(_unwrapMemoryEnvelope);
    },
    putBatch: function (records, options) {
      options = options || {};
      var payload = { records: records, forceBatch: true };
      if (options.requestId) payload.requestId = String(options.requestId);
      if (options.existingPolicy) payload.existingPolicy = String(options.existingPolicy);
      return _request('/memory/records', { method: 'POST', body: payload, timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    },
    remove: function (id, options) {
      options = options || {};
      return _request('/memory/record?id=' + encodeURIComponent(id) +
        (options.requestId ? '&requestId=' + encodeURIComponent(options.requestId) : ''), { method: 'DELETE' }).then(_unwrapMemoryEnvelope);
    },
    /* 激活强化：**独立**通道。它不推进 canonical revision，因此每轮对话
       都不会让任何镜像游标失效（见 memory-authority.js 的说明）。 */
    activate: function (ids, options) {
      options = options || {};
      var payload = { ids: ids || [] };
      if (options.at != null) payload.at = Number(options.at);
      if (options.delta != null) payload.delta = Number(options.delta);
      return _request('/memory/activate', { method: 'POST', body: payload, timeoutMs: deps.writeTimeoutMs }).then(_unwrapMemoryEnvelope);
    },
    putSettings: function (settings) {
      return _request('/memory/settings', { method: 'POST', body: settings || {} }).then(_unwrapMemoryEnvelope);
    },
    migrationState: function (source) {
      return _request('/memory/migration?source=' + encodeURIComponent(source || 'default')).then(_unwrapMemoryEnvelope);
    },
    markMigration: function (source, patch) {
      return _request('/memory/migrate', { method: 'POST', body: Object.assign({ source: source || 'default' }, patch || {}), timeoutMs: MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    }
  };
}
NS.createMemoryRemote = createMemoryRemote;

/* ── understanding remote driver（understanding-authority 的注入契约）────
   M1-C.2m。与 memory 的 remote 分开（理由同 memory 与 chat 分开：合并会让
   "某一边多了一个方法"这种接线错误无法被发现）。

   信封与 `/memory/*` **完全相同**（同一个 mobile-gateway、同一个 okBody），
   因此复用 `_unwrapMemoryEnvelope`。解包失败会静默把 `res.records` 读成
   undefined，进而 `replaceAll([])` 清空镜像 —— 那条注释里的教训同样适用。

   端点形状刻意与 memory 对齐（list / changes / records / correct / derive /
   migration / migrate），只把「写一条记录」换成「提交一份候选理解（带
   expectedRevision）」，因为理解的写协议本来就是修订链 + CAS。 */
function createUnderstandingRemote(deps) {
  deps = deps || {};
  return {
    health: function () {
      return _request('/health', { timeoutMs: deps.healthTimeoutMs || 4000 });
    },
    list: function (query) {
      query = query || {};
      var qs = [];
      if (query.characterId) qs.push('characterId=' + encodeURIComponent(query.characterId));
      if (query.limit) qs.push('limit=' + encodeURIComponent(query.limit));
      return _request('/understanding/list' + (qs.length ? '?' + qs.join('&') : ''), { timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    },
    changes: function (cursor, options) {
      options = options || {};
      return _request('/understanding/changes?cursor=' + encodeURIComponent(Number(cursor) || 0) +
        (options.limit ? '&limit=' + encodeURIComponent(options.limit) : '')).then(_unwrapMemoryEnvelope);
    },
    /* 提交候选理解：expectedRevision 是**必须**的（0 = 期望"还没有理解"）。
       服务端把基版本过期如实回报为 conflict，绝不覆盖。 */
    rewrite: function (characterId, next, options) {
      options = options || {};
      var payload = {
        characterId: String(characterId || ''),
        expectedRevision: options.expectedRevision == null ? null : Number(options.expectedRevision),
        candidate: next || {}
      };
      if (options.requestId) payload.requestId = String(options.requestId);
      return _request('/understanding/records', { method: 'POST', body: payload, timeoutMs: deps.writeTimeoutMs }).then(_unwrapMemoryEnvelope);
    },
    /* 一次性迁移：把浏览器遗留行**原样**送到 canonical（含旧 history）。
       与常规 rewrite 分开是刻意的 —— 迁移不是"派生了一份新理解"，
       它没有 expectedRevision 语义，而是"把权威状态搬过来"。 */
    migrateRecord: function (characterId, candidate) {
      return _request('/understanding/records', {
        method: 'POST',
        body: { characterId: String(characterId || ''), migrate: true, candidate: candidate || {} },
        timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS
      }).then(_unwrapMemoryEnvelope);
    },
    /* 更正：用户说"你这一点理解错了"的持久记录。 */
    correct: function (characterId, input) {
      return _request('/understanding/correct', {
        method: 'POST',
        body: Object.assign({ characterId: String(characterId || '') }, input || {}),
        timeoutMs: deps.writeTimeoutMs
      }).then(_unwrapMemoryEnvelope);
    },
    corrections: function (characterId) {
      return _request('/understanding/corrections?characterId=' + encodeURIComponent(String(characterId || ''))).then(_unwrapMemoryEnvelope);
    },
    /* 派生触发：桌面**不能**派生，只能请求；服务端按持久水位决定跑不跑，
       并以 outcome:'ineligible' + skipReason 如实回报"这次没调模型"。 */
    derive: function (characterId, options) {
      options = options || {};
      var payload = { characterId: String(characterId || '') };
      if (options.force) payload.force = true;
      return _request('/understanding/derive', { method: 'POST', body: payload, timeoutMs: deps.deriveTimeoutMs || MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    },
    migrationState: function (source) {
      return _request('/understanding/migration?source=' + encodeURIComponent(source || 'default')).then(_unwrapMemoryEnvelope);
    },
    markMigration: function (source, patch) {
      return _request('/understanding/migrate', { method: 'POST', body: Object.assign({ source: source || 'default' }, patch || {}), timeoutMs: MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    }
  };
}
NS.createUnderstandingRemote = createUnderstandingRemote;

/* ── moments remote driver（moments-authority 的注入契约）───────────────
   M1-C.2n。与 memory / understanding 的 remote 分开（理由同上：合并会让
   "某一边多了一个方法"这种接线错误无法被发现）。

   信封与 `/memory/*` 完全相同（同一个 mobile-gateway、同一个 okBody），
   因此复用 `_unwrapMemoryEnvelope` —— 解包失败会把 `res.records` 读成
   undefined，而那正是 memory 当初"镜像被清空"的成因。

   写协议与理解**不同**：动态是**可编辑的多条记录**，每行有自己的 rev，
   因此提交一条动态带 `expectedRev`（0/缺省 = 新建），并且**必须**带
   `requestId` 才能幂等重放（R7：重试不产生第二条）。 */
function createMomentsRemote(deps) {
  deps = deps || {};
  return {
    health: function () {
      return _request('/health', { timeoutMs: deps.healthTimeoutMs || 4000 });
    },
    list: function (query) {
      query = query || {};
      var qs = [];
      if (query.ownerRoleId) qs.push('ownerRoleId=' + encodeURIComponent(query.ownerRoleId));
      if (query.limit) qs.push('limit=' + encodeURIComponent(query.limit));
      return _request('/moments/list' + (qs.length ? '?' + qs.join('&') : ''), { timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    },
    changes: function (cursor, options) {
      options = options || {};
      return _request('/moments/changes?cursor=' + encodeURIComponent(Number(cursor) || 0) +
        (options.limit ? '&limit=' + encodeURIComponent(options.limit) : '')).then(_unwrapMemoryEnvelope);
    },
    /* P11-3G · 投递确认（ACK）。它是**唯一**一个消费者→权威的投递控制面，
       证明的东西只有一个：consumer 对 revision ≤ watermark 的每个 event
       都已经得出持久结论。它不是"我读到了"，也不是"我试过了"。
       失败**不抛**：ACK 送不到只会让回收变保守（保留更多日志），
       而不会让任何事件被跳过 —— 因此调用方不需要为它做重试编排。 */
    ack: function (watermark, options) {
      options = options || {};
      var payload = { consumer: String(options.consumer || ''), watermark: Number(watermark) || 0 };
      if (options.requestId) payload.requestId = String(options.requestId);
      return _request('/moments/ack', { method: 'POST', body: payload, timeoutMs: deps.ackTimeoutMs }).then(
        _unwrapMemoryEnvelope,
        function (error) {
          return { ok: false, offline: true, error: 'ack-unreachable', detail: String((error && error.message) || error) };
        }
      );
    },
    /* 按主体分页读：可见性由**服务端**用共享核判定，因此隐藏行不占页槽。
       客户端不提交"我能看什么"，只提交"我是谁"。 */
    visible: function (principal, query) {
      principal = principal || {};
      query = query || {};
      var qs = ['principalKind=' + encodeURIComponent(principal.kind === 'user' ? 'user' : 'role')];
      qs.push('principalId=' + encodeURIComponent(String(principal.id || '')));
      if (query.ownerRoleId) qs.push('ownerRoleId=' + encodeURIComponent(query.ownerRoleId));
      if (query.limit) qs.push('limit=' + encodeURIComponent(query.limit));
      if (query.cursor && query.cursor.createdAt != null) {
        qs.push('cursorCreatedAt=' + encodeURIComponent(Number(query.cursor.createdAt) || 0));
        qs.push('cursorId=' + encodeURIComponent(String(query.cursor.id || '')));
      }
      return _request('/moments/visible?' + qs.join('&'), { timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    },
    /* 写一条动态（新建或编辑）。expectedRev 是 CAS 的比较对象：
       新建 = 1 期望（服务端用 rev>0 表示已存在），编辑 = 当前 rev。 */
    put: function (record, options) {
      options = options || {};
      var payload = { record: record };
      if (options.requestId) payload.requestId = String(options.requestId);
      if (options.expectedRev != null) payload.expectedRev = Number(options.expectedRev);
      return _request('/moments/record', { method: 'POST', body: payload, timeoutMs: deps.writeTimeoutMs }).then(_unwrapMemoryEnvelope);
    },
    /* 删除：与理解的"拒绝删除"不同 —— 动态**是**用户可以删除的东西，
       因此这是一个正常的软删除（墓碑 + change_log 的 kind='delete'，
       镜像据此移除本地行）。仍然带基版本：避免把别人的编辑覆盖掉。 */
    remove: function (id, options) {
      options = options || {};
      var qs = ['id=' + encodeURIComponent(String(id || ''))];
      if (options.requestId) qs.push('requestId=' + encodeURIComponent(String(options.requestId)));
      if (options.expectedRev != null) qs.push('expectedRev=' + encodeURIComponent(Number(options.expectedRev)));
      return _request('/moments/record?' + qs.join('&'), { method: 'DELETE', timeoutMs: deps.writeTimeoutMs }).then(_unwrapMemoryEnvelope);
    },
    /* 一次性迁移批次：逐条走 writeMigrated（**永不**覆盖 canonical 已存在的行）。 */
    migrateBatch: function (records, options) {
      options = options || {};
      var payload = { records: records || [] };
      if (options.prefix) payload.requestIdPrefix = String(options.prefix);
      return _request('/moments/records', { method: 'POST', body: payload, timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS }).then(_unwrapMemoryEnvelope);
    },
    migrationState: function (source) {
      return _request('/moments/migration?source=' + encodeURIComponent(source || 'default')).then(_unwrapMemoryEnvelope);
    },
    markMigration: function (source, patch) {
      /* 水位由服务端在批次里自行推进；这一条只用于显式记录"这一轮搬到哪了"。 */
      return _request('/moments/migration?source=' + encodeURIComponent(source || 'default')).then(_unwrapMemoryEnvelope).then(function (res) {
        if (res && res.ok) res.marked = patch || {};
        return res;
      });
    }
  };
}
NS.createMomentsRemote = createMomentsRemote;
})(window.IB || (window.IB = {}));
