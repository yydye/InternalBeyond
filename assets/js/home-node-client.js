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
    }
  };
}

NS.ibHomeNodeBase = ibHomeNodeBase;
NS.ibHomeNodeMode = ibHomeNodeMode;
NS.ibHomeNodeToken = ibHomeNodeToken;
NS.createHomeNodeRemote = createHomeNodeRemote;
NS.ibHomeNodeConstants = { DEFAULT_BASE: DEFAULT_BASE, DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS, MIGRATION_TIMEOUT_MS: MIGRATION_TIMEOUT_MS };
})(window.IB || (window.IB = {}));
