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
       白名单投影。缺席时 Node 保持上一次已知值，不清空。 */
    publishCharacters: function (characters, options) {
      options = options || {};
      var body = { characters: characters || [], merge: !!options.merge };
      if (options.user) body.user = options.user;
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
NS.ibHomeNodeConstants = { DEFAULT_BASE: DEFAULT_BASE, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS, MIGRATION_TIMEOUT_MS: MIGRATION_TIMEOUT_MS };

/* ── memory remote driver（memory-authority 的注入契约）──────────────
   M1-C.2d Wave 2。刻意与 chat 的 remote driver **分开**：
     · 两者的方法名不同（putBatch 语义、activate、putSettings）；
     · 合并成一个对象会让"某一边多了一个方法"这种接线错误无法被发现
       （chat-authority 会拿到一个看起来合法但不该存在的 driver）。
   只做 HTTP + 形状校验，不含任何权威/镜像/回退策略。 */
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
      return _request('/memory/list' + (qs.length ? '?' + qs.join('&') : ''), { timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS });
    },
    changes: function (cursor, options) {
      options = options || {};
      return _request('/memory/changes?cursor=' + encodeURIComponent(Number(cursor) || 0) +
        (options.limit ? '&limit=' + encodeURIComponent(options.limit) : ''));
    },
    put: function (record, options) {
      options = options || {};
      var payload = { record: record };
      if (options.requestId) payload.requestId = String(options.requestId);
      if (options.existingPolicy) payload.existingPolicy = String(options.existingPolicy);
      return _request('/memory/records', { method: 'POST', body: payload, timeoutMs: deps.writeTimeoutMs });
    },
    putBatch: function (records, options) {
      options = options || {};
      var payload = { records: records, forceBatch: true };
      if (options.requestId) payload.requestId = String(options.requestId);
      if (options.existingPolicy) payload.existingPolicy = String(options.existingPolicy);
      return _request('/memory/records', { method: 'POST', body: payload, timeoutMs: deps.batchTimeoutMs || MIGRATION_TIMEOUT_MS });
    },
    remove: function (id, options) {
      options = options || {};
      return _request('/memory/record?id=' + encodeURIComponent(id) +
        (options.requestId ? '&requestId=' + encodeURIComponent(options.requestId) : ''), { method: 'DELETE' });
    },
    /* 激活强化：**独立**通道。它不推进 canonical revision，因此每轮对话
       都不会让任何镜像游标失效（见 memory-authority.js 的说明）。 */
    activate: function (ids, options) {
      options = options || {};
      var payload = { ids: ids || [] };
      if (options.at != null) payload.at = Number(options.at);
      if (options.delta != null) payload.delta = Number(options.delta);
      return _request('/memory/activate', { method: 'POST', body: payload, timeoutMs: deps.writeTimeoutMs });
    },
    putSettings: function (settings) {
      return _request('/memory/settings', { method: 'POST', body: settings || {} });
    },
    migrationState: function (source) {
      return _request('/memory/migration?source=' + encodeURIComponent(source || 'default'));
    },
    markMigration: function (source, patch) {
      return _request('/memory/migrate', { method: 'POST', body: Object.assign({ source: source || 'default' }, patch || {}), timeoutMs: MIGRATION_TIMEOUT_MS });
    }
  };
}
NS.createMemoryRemote = createMemoryRemote;
})(window.IB || (window.IB = {}));
