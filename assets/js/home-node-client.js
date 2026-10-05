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

   ── P22-23 · 凭据是**取来**的，不是要求用户填的 ─────────────────────
   在这一阶段之前，这一层是唯一的凭据来源，而**没有任何代码写过那个
   localStorage 键**：正常安装的用户两边都是空的（服务端 process.env 空、
   浏览器 localStorage 空），于是 Economy 的配置面永远 503 "请先设置环境
   变量"。真正的问题不是那句话，是"凭据从来没有被创造过"。

   现在：Home Node 自己生成并持久化凭据（services/home-node/desktop-credential.js），
   本层在**自己那份为空时**向它取一次（POST /internal/desktop-credential，
   仅 loopback + loopback Origin）。

   ★ 取来的凭据**只存在于内存**（下面的 _sessionToken 闭包变量）：
     不写 localStorage、不写 sessionStorage、不进 URL、不进 DOM、不进日志。
     页面刷新即丢失，下一次请求重新取一次 —— 这是刻意的取舍：一份长期凭据
     在浏览器存储里落盘的价值很小（它换来的只是少一次本机请求），而代价是
     它从此留在磁盘上，且任何同源脚本都能读到。
   ★ localStorage['ib_home_node_token'] 继续**优先**：显式配置过的部署
     （developer / headless / 测试）语义一个字没变，而且那种部署下服务端的
     bootstrap 面是关着的，取也取不到。
   ★ 全部失败时**不**发明一个假凭据：写请求会带着空凭据发出去，由服务端
     fail closed（401/403），而这一层把"为什么没有凭据"如实传上去。 */
(function (NS) {
'use strict';

var DEFAULT_BASE = 'http://127.0.0.1:23118';
var DEFAULT_TIMEOUT_MS = 15000;
var MIGRATION_TIMEOUT_MS = 60000;
/* 交付面的路径与请求头（与服务端 services/home-node/http.js 的
   DESKTOP_CREDENTIAL_PATH / DESKTOP_CREDENTIAL_HEADER 是同一份契约）。
   浏览器侧不能 require，因此这里只能写字面量 —— 而为了让它不漂移，
   tests/test_p22_23_home_node_provisioning.js 会逐字比对两处。 */
var CREDENTIAL_PATH = '/internal/desktop-credential';
var CREDENTIAL_HEADER = 'X-IB-Bootstrap';

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

/* Canonical Tauri desktop host detection + IPC invoker.
   The canonical desktop page is served from http://tauri.localhost, which the
   Home Node HTTP bootstrap refuses (loopback origin only). Inside the Tauri
   WebView the host exposes an IPC command that returns the Home Node desktop
   credential through the native seam; a plain browser page has no
   window.__TAURI__, so this path is host-only. */
function _ibTauriInvoke() {
  try {
    var tauri = (typeof window !== 'undefined') ? window.__TAURI__ : null;
    if (!tauri) return null;
    var invoke = (tauri.core && tauri.core.invoke) || tauri.invoke;
    return (typeof invoke === 'function') ? invoke : null;
  } catch (e) { return null; }
}

/* ══ P22-23 · 凭据会话（**只在内存里**）══════════════════════════════
   两个闭包变量，没有第三个：
     _sessionToken       本轮页面生命周期内已经取到 / 已经显式配置的凭据。
                         **不落任何存储** —— 见文件头那段取舍。
     _provisionFailure   上一轮取凭据为什么失败（原因码 + 是否可重试）。
                         它存在的意义是给 UI 一个**可区分的诊断**：
                         "Home Node 没在跑"与"凭据没取到"是两件不同的事，
                         而以前它们都表现为同一句空状态文案。
   状态查询本身是同步的（ibHomeNodeToken），因为它在 _request 里被调用；
   取凭据是异步的，只发生一次。 */
var _sessionToken = null;          /* null = 还没试过；'' = 试过且没有 */
var _provisionPromise = null;
var _provisionFailure = null;

/* 已经可用的凭据：显式配置（localStorage）优先，其次是本次会话取到的。
   没有第三个来源 —— 这一层绝不发明凭据。 */
function ibHomeNodeEffectiveToken() {
  var configured = ibHomeNodeToken();
  if (configured) return configured;
  return _sessionToken == null ? '' : String(_sessionToken);
}

/* 取一次凭据（POST /internal/desktop-credential）。
   并发去重：同一页面里几个渲染器同时发第一个请求时，只打一次。
   失败**不抛错**：返回一个形状稳定的对象，让调用方继续用空凭据发请求 ——
   服务端 fail closed 是权威的拒绝者，这一层不抢它的活。 */
function ibHomeNodeProvisionCredential(options) {
  options = options || {};
  if (ibHomeNodeToken()) {
    /* 显式配置过：不取。这条分支同时让"测试注入 token"的既有路径零改动。 */
    return Promise.resolve({ ok: true, source: 'local-storage-configured' });
  }
  if (_sessionToken != null && _sessionToken !== '') {
    return Promise.resolve({ ok: true, source: 'session' });
  }
  if (_provisionPromise) return _provisionPromise;
  var _nativeInvoke = _ibTauriInvoke();
  if (_nativeInvoke) {
    /* Canonical Tauri desktop host: get the credential over the native IPC seam
       instead of the loopback-only HTTP bootstrap. This does not widen the Home
       Node's HTTP admission (browsers/plain HTTP clients cannot invoke IPC). */
    _provisionPromise = _nativeInvoke('home_node_desktop_credential').then(function (result) {
      var credential = (result && typeof result.credential === 'string') ? result.credential : '';
      if (credential) {
        _sessionToken = credential;
        _provisionFailure = null;
        return { ok: true, source: 'tauri-host-bridge' };
      }
      _sessionToken = '';
      _provisionFailure = { code: 'home-node-credential-unavailable', status: 0, reason: 'tauri-host-bridge-empty', retryable: true };
      return { ok: false, error: _provisionFailure.code, reason: _provisionFailure.reason, retryable: true };
    }, function (error) {
      _sessionToken = '';
      _provisionFailure = {
        code: 'home-node-credential-unavailable',
        status: 0,
        reason: String((error && error.message) || error || 'tauri-host-bridge-failed').slice(0, 80),
        retryable: true
      };
      return { ok: false, error: _provisionFailure.code, reason: _provisionFailure.reason, retryable: true };
    }).then(function (result) {
      _provisionPromise = null;
      return result;
    });
    return _provisionPromise;
  }
  var url = ibHomeNodeBase() + CREDENTIAL_PATH;
  var controller = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = null;
  var init = {
    method: 'POST',
    cache: 'no-store',
    headers: { 'X-IB-Protocol': '1' }
  };
  /* 自定义头 ⇒ 跨源时必然先走预检，因此这条请求不会以 CORS 简单请求的
     形态出现（服务端把这一点当作准入条件之一）。 */
  init.headers[CREDENTIAL_HEADER] = '1';
  if (controller) {
    init.signal = controller.signal;
    timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* 已结束 */ } }, options.timeoutMs || 4000);
  }
  _provisionPromise = fetch(url, init).then(function (res) {
    return res.text().then(function (raw) {
      var parsed = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
      if (res.ok && parsed && typeof parsed === 'object' && typeof parsed.credential === 'string' && parsed.credential) {
        _sessionToken = parsed.credential;
        _provisionFailure = null;
        return { ok: true, source: String(parsed.source || 'bootstrap') };
      }
      /* ★ 失败形状只保留**服务端说的原因码**，不保留任何响应正文片段：
         这一层从不回显服务端返回的字段，因为那些字段里可能有凭据形状的东西。 */
      _sessionToken = '';
      _provisionFailure = {
        code: 'home-node-credential-unavailable',
        status: res.status,
        reason: (parsed && typeof parsed.reason === 'string') ? parsed.reason
          : ((parsed && typeof parsed.error === 'string') ? parsed.error : 'credential-not-delivered'),
        retryable: false
      };
      return { ok: false, error: _provisionFailure.code, reason: _provisionFailure.reason, status: res.status };
    });
  }, function (error) {
    var classified = _classifyFetchError(error);
    _sessionToken = '';
    /* 连不上与"拒绝交付"是**不同**的诊断，因此这里保留传输层的词表，
       而不是把它们都折成 credential-unavailable。 */
    _provisionFailure = { code: classified.code, status: 0, reason: classified.code, retryable: true };
    return { ok: false, error: classified.code, reason: classified.code, retryable: true };
  }).then(function (result) {
    if (timer) clearTimeout(timer);
    _provisionPromise = null;
    return result;
  });
  return _provisionPromise;
}

/* 上一次取凭据失败的原因（没有失败时为 null）。UI 用它区分诊断。 */
function ibHomeNodeCredentialState() {
  var configured = ibHomeNodeToken();
  return {
    configured: !!configured,
    source: configured ? 'local-storage' : (_sessionToken ? 'home-node-bootstrap' : null),
    provisionedInThisSession: !!_sessionToken,
    lastFailure: _provisionFailure ? {
      code: _provisionFailure.code,
      status: _provisionFailure.status,
      reason: _provisionFailure.reason,
      retryable: _provisionFailure.retryable === true
    } : null
  };
}

/* 服务端说"你没带凭据 / 你带的凭据不对"时，丢掉本轮会话里那份并允许重取。
   这件事必须存在，理由很具体：Home Node 重启会重新读取（或重新生成）凭据，
   而页面还活着。没有这条，用户会看到一个**永久**的 401，直到手动刷新页面 ——
   一个"重启服务就再也配不了"的故障，正是本阶段要消灭的那一类。 */
function ibHomeNodeForgetCredential() {
  _sessionToken = null;
  _provisionPromise = null;
  _provisionFailure = null;
}

/* ── 保证"这一次请求会带凭据"（已经取到就立刻返回）────────────────────
   ★ 它把"取凭据"变成**请求的前置步骤**，而不是事后补救。理由见 _request
     里那段：先发再补会让用户先看到一次假失败。
   ★ 一次失败**不**永久关闭自动重试：下一次请求还会再试一次（Home Node 可能
     只是还没起来）。真正的节流来自"同一时刻只打一次"（_provisionPromise），
     而不是"失败之后永不再试"。 */
function ensureCredential() {
  if (ibHomeNodeToken()) return Promise.resolve();   /* 显式配置：不用取 */
  if (_sessionToken) return Promise.resolve();        /* 本轮已经取到 */
  if (_provisionFailure && _provisionFailure.retryable !== true) {
    /* 服务端**明确拒绝交付**（例如凭据来自部署、或自动 provisioning 关着）。
       这不是暂时故障，重试同一个答案没有意义 —— 但也不缓存成"永久失败"：
       下一次请求仍会重新问一次（服务端状态可能已经变了，例如重启过）。 */
    return Promise.resolve();
  }
  return ibHomeNodeProvisionCredential({ timeoutMs: 4000 }).then(function () { });
}

/* 错误分类词表：调用方据此分支，禁止用错误文案匹配。 */
function _classifyFetchError(error) {
  var name = String((error && error.name) || '');
  var msg = String((error && error.message) || error || '');
  if (name === 'AbortError' || /abort/i.test(msg)) return { code: 'timeout', retryable: true, message: msg };
  if (/Failed to fetch|NetworkError|ECONNREFUSED|load failed/i.test(msg)) return { code: 'home-node-unreachable', retryable: true, message: msg };
  return { code: 'home-node-transport-error', retryable: true, message: msg };
}

/* ── P22-23 · 一次尝试（不带凭据重取）───────────────────────────────
   把"发一次请求"与"凭据该不该重取"分开：_attempt 只负责一次传输，
   _request 负责在服务端明确说"凭据不对/没带"时重取一次并重发。

   重试**只**发生在 401 / 403 上，而且**只**发生一次：
     · 401 = 带了凭据但不匹配；403 = 没带凭据（或凭据铸造面未配置）。
       两者都可能意味着"服务端重启后换了凭据，而页面还活着"。
     · 其余状态码（503 配置面关闭、400 信封错、409 冲突……）都不是凭据问题，
       重发一次只会把同一个事实问第二遍 —— 因此不重试。
   ★ 这条重试**不会**把任何写变成"自动成功"：它重发的是同一个请求体，
     幂等键也一模一样，因此 canonical store 的一次性语义不受影响。 */
function _attempt(url, init) {
  return fetch(url, init).then(function (res) {
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

function _request(pathname, options) {
  options = options || {};
  var url = ibHomeNodeBase() + pathname;
  var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  function send() {
    var headers = { 'X-IB-Protocol': '1' };
    var token = ibHomeNodeEffectiveToken();
    if (token) headers['X-IB-Home-Token'] = token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = null;
    if (controller) timer = setTimeout(function () { try { controller.abort(); } catch (e) { /* 已结束 */ } }, timeoutMs);
    var init = {
      method: options.method || 'GET',
      headers: headers,
      cache: 'no-store'
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (controller) init.signal = controller.signal;
    return _attempt(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (error) {
      if (timer) clearTimeout(timer);
      throw error;
    });
  }

  /* ── 先取凭据，再发请求 ──────────────────────────────────────────────
     ★ 顺序是这一层的核心，而且曾经写错过一次：先发再补的话，**用户看到的是
       一次真实失败** —— 配置页第一次进入时会显示"读不到钱包 / unauthenticated"，
       几百毫秒后才自愈。那不是一个无害的闪烁：这一页要回答的第一个问题就是
       "这台节点现在能不能配"，用一次假失败回答它，正好是本阶段要消灭的
       那种"看起来正常/看起来坏了"的错位。
     ★ 没有凭据可取时（显式关掉了自动 provisioning、或 Home Node 拒绝交付）
       ensureCredential 会如实返回失败，请求照发 —— 拒绝由服务端权威给出，
       这一层不抢它的活。 */
  return ensureCredential().then(function () {
    return send();
  }).then(function (res) {
    /* ── 凭据被服务端拒绝（401 / 403）──────────────────────────────────
       这一条的存在理由同样具体：Home Node 重启会重新读取凭据，而页面还活着。
       没有它，用户会看到一个**永久**的 401，直到手动刷新页面 —— 一个
       "重启服务就再也配不了"的故障。

       只在两种情况下重取：
         · 凭据是**本次会话取来的**（用户显式配置在 localStorage 里的那份
           不该被我们偷偷换掉，而且服务端也不会交付）；
         · 状态码确实是 401 / 403。其余状态码（503 配置面关闭、400 信封错、
           409 冲突……）都不是凭据问题，重发只会把同一个事实问第二遍。
       ★ 重发的是**同一个请求体**、同一个幂等键，因此 canonical store 的
         一次性语义不受影响；这条重试不可能把一次写"自动变成成功"。 */
    var credentialRejected = res && (res.status === 401 || res.status === 403);
    if (!credentialRejected) return res;
    if (ibHomeNodeToken()) return res;      /* 显式配置的凭据：重取没有意义 */
    if (!_sessionToken) return res;         /* 本来就没有凭据可取 */
    ibHomeNodeForgetCredential();
    return ibHomeNodeProvisionCredential({ timeoutMs: 4000 }).then(function () {
      return send();
    });
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
      if (query.cursor != null) qs.push('cursor=' + encodeURIComponent(typeof query.cursor === 'object' ? JSON.stringify(query.cursor) : String(query.cursor)));
      if (query.before != null) qs.push('before=' + encodeURIComponent(typeof query.before === 'object' ? JSON.stringify(query.before) : String(query.before)));
      if (query.after != null) qs.push('after=' + encodeURIComponent(typeof query.after === 'object' ? JSON.stringify(query.after) : String(query.after)));
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

    /* ── P22-15 · 用户对一条等待中的请求点头 / 摇头 ──────────────────
       数据源是 **P22-13** 那条 authenticated seam
       （/internal/economy/approval-decision），而这里刻意只做一件事：
       把调用方给的**三个**字段原样发出去。

       ★ 为什么把方法放在本文件而不是让 UI 自己 fetch()：
         §15 逐字要求 UI 不得出现 `fetch('/economy/...', {method:'POST'})`。
         这一层的存在让"哪一条路径、什么方法、什么凭据头"只有**一处**
         实现 —— 与 memory / chat / catalog 的 remote driver 同一条纪律。
       ★ 为什么 body 用**白名单构造**而不是把 options 直接传下去：
         一个 `_request(path, {body: options})` 会让 UI 有机会顺手塞进
         amountMinor / productId / approved 之类的字段。构造式让那些字段
         在结构上不可达 —— 不是"记得别传"，而是这里没有那个位置。
       ★ 它**不**解释回答：信封的判定在 economy-approval-core.js 里。 */
    approvalDecision: function (options) {
      options = options || {};
      var body = {
        approvalId: String(options.approvalId || ''),
        decision: String(options.decision || ''),
        idempotencyKey: String(options.idempotencyKey || '')
      };
      return _request('/internal/economy/approval-decision', {
        method: 'POST',
        body: body,
        timeoutMs: deps.decisionTimeoutMs || DEFAULT_TIMEOUT_MS
      });
    },

    /* ── P22-16 · 用户配置这台节点的钱与规则 ──────────────────────────
       数据源是 **P22-14** 那条 authenticated seam
       （/internal/economy/configuration），而这里刻意只做一件事：
       把调用方给的**三个**字段原样发出去 —— 命令、该命令自己的 config、
       幂等键。

       ★ 为什么把方法放在本文件而不是让 UI 自己 fetch()：
         §5 逐字要求 UI 只能走配置 seam。这一层的存在让"哪一条路径、
         什么方法、什么凭据头"只有**一处**实现 —— 与 approvalDecision /
         memory / chat / catalog 的 remote driver 同一条纪律。
       ★ 为什么信封是构造出来的：一个 `_request(path, {body: options})`
         会让 UI 有机会顺手塞进 actor / amountMinor / approved 之类的
         **顶层**字段。构造式让顶层恰好三个键在结构上成立 —— 不是
         "记得别传"，而是这里没有第四个位置。
       ★ 为什么 config 是**原样透传**而不是在这里再抄一份每命令白名单：
         那份白名单已经有两个权威 —— 纯层
         （assets/js/economy-configuration-core.js 的 CONFIG_KEYS，在构造
         时逐键拒绝）与服务端的 economy-configuration.js
         （UNEXPECTED_CONFIG_KEYS，在 body 解析之后逐键拒绝）。第三份副本
         只会多一个能漂移的地方，而它漂移的方向是**静默少发一个字段**。
         这里只保证 config 是一个普通对象。
       ★ 它**不**解释回答：信封的判定在 economy-configuration-core.js 里。 */
    economyConfiguration: function (options) {
      options = options || {};
      var raw = options.config;
      var config = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
      var body = {
        command: String(options.command || ''),
        config: config,
        idempotencyKey: String(options.idempotencyKey || '')
      };
      return _request('/internal/economy/configuration', {
        method: 'POST',
        body: body,
        timeoutMs: deps.configurationTimeoutMs || DEFAULT_TIMEOUT_MS
      });
    },

    /* ── P22-15 · 通用只读 GET ────────────────────────────────────────
       P22-15 的 UI 要读**三条既有**只读面（intents / approvals / products）。
       与其为每条路径各写一个方法，这里给一个只做 GET 的读取器：
         · 方法被钉死成 GET（它没有 method 参数）；
         · 路径必须是一个以 '/' 开头的路径段，且**不得**包含 '://'
           （于是它不可能被用来打别的主机）；
         · query 只支持字符串或一层的键值对，值一律 encodeURIComponent。
       ★ 它到不了任何写面：这一层没有任意 POST 的入口 —— 两个写方法分别叫
         approvalDecision 与 economyConfiguration，它们的路径与信封都是
         构造出来的。
       ★ 缺 query 时只发路径，不做任何默认过滤：过滤条件是调用方的事。 */
    getJson: function (pathname, query) {
      var p = String(pathname == null ? '' : pathname);
      if (p.charAt(0) !== '/' || p.indexOf('://') >= 0 || p.indexOf('..') >= 0) {
        return Promise.resolve({ ok: false, error: 'invalid-read-path' });
      }
      var qs = '';
      if (typeof query === 'string' && query) {
        qs = query.charAt(0) === '?' ? query : ('?' + query);
      } else if (query && typeof query === 'object') {
        var parts = [];
        for (var k in query) {
          if (!Object.prototype.hasOwnProperty.call(query, k)) continue;
          if (query[k] == null) continue;
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])));
        }
        if (parts.length) qs = '?' + parts.join('&');
      }
      return _request(p + qs, {});
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
/* P22-23：凭据会话的三个入口。`ibHomeNodeEffectiveToken` 也是**唯一**回答
   "这次请求会带什么凭据"的函数 —— 其余两个分别是"取"与"忘"。 */
NS.ibHomeNodeEffectiveToken = ibHomeNodeEffectiveToken;
NS.ibHomeNodeProvisionCredential = ibHomeNodeProvisionCredential;
NS.ibHomeNodeCredentialState = ibHomeNodeCredentialState;
NS.ibHomeNodeForgetCredential = ibHomeNodeForgetCredential;
NS.createHomeNodeRemote = createHomeNodeRemote;
NS.economyCatalogFact = economyCatalogFact;
NS.ECONOMY_CATALOG_FACT_FIELDS = ECONOMY_CATALOG_FACT_FIELDS;
NS.ibHomeNodeConstants = {
  DEFAULT_BASE: DEFAULT_BASE,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  MIGRATION_TIMEOUT_MS: MIGRATION_TIMEOUT_MS,
  /* 交付面的路径与头也是常量的一部分：测试要逐字比对服务端契约。 */
  CREDENTIAL_PATH: CREDENTIAL_PATH,
  CREDENTIAL_HEADER: CREDENTIAL_HEADER
};

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

/* ── runtime remote driver（R4-C LIVE · 运行时记忆解释边界的**唯一**入口）──
   P21-R4-C-LIVE-2.1 建立，P21-R4-C-LIVE-3 收窄为"只送 id"。
   与上面三个 remote 的两点**结构性**差异，都是刻意的：

     · **只有一个动词**。memory / understanding / moments 各自是一整套 CRUD 面，
       因为它们服务的是"持久权威"；而运行时解释按定义是**非持久**的
       （durable:false，见 memory-interpretation-core 的 noDurable），它不写任何
       store、不推进任何 revision，因此这里没有 put / remove / sync，也**没有**
       runRuntimeModel / deriveAnything 这类通用模型入口 —— 一个"可以指定
       provider / model / prompt 的运行时调用"就是第二条绕过 Vault 与成本护栏的
       模型通道，正是本阶段要消灭的形状。加一个"顺手也能跑别的"的动词，等于把
       这一层从**一个边界**降级成**一个通用出口**。同理**没有**"读一条记忆"的
       动词：浏览器需要的 id 来自它已经持有的镜像，而**内容**必须由服务端从
       canonical store 自己取（否则同一个内容通道又从客户端打开一遍）。

     · **不做信封解包**。`/memory/*`、`/understanding/*`、`/moments/*` 由
       mobile-gateway 包成 `{ok, payload:{…}}`，因此那三个 driver 都走
       `_unwrapMemoryEnvelope`；而 `/internal/runtime/memory-interpretation`
       返回的信封**本来就是平的**（`{ok, durable, items, model, boundary…}`）。
       再解一次 payload 会把真正的事实（items / model.attempts / durable）
       推进一个不存在的 payload 里 —— 调用方读到 undefined，与当年
       "镜像被清空"是同一类事故。这里因此**逐字不动**地透出，解包只发生在
       该发生的那三条路径上。

   ── P21-R4-C-LIVE-3 · 浏览器不再提交 canonical 记忆内容 ──────────────
   LIVE-2.2 机械地证明了 `inputEnvelope.records` 是一条**调用方控制的数据
   通道**：谁调用这个动词，谁就能决定模型读到什么"事实"。LIVE-3 把这条通道
   从**协议层**关掉：请求里能表达的东西收窄成"要解释哪几条"（selectedMemoryIds）
   加两个**非 canonical** 的当前状态输入（currentState / roleName）。
   内容、可见性、归属、证据状态全部由 Home Node 从 canonical store 解析。

   ── 闭集构造（这是安全性质，不是代码风格）────────────────────────────
   payload 由**显式字段列表**拼出：operation 是模块常量，三个调用方输入逐字列出。
   调用方即使传 `{records, content, evidenceState, inputEnvelope, provider, model,
   apiKey, prompt, …}`，这些键也**一个都到不了 wire** —— 它们不是被删除的，
   而是从来没有被复制过（`delete` 列表会随服务端新增字段而漂移，白名单不会）。
   服务端仍会独立复核（canonical 字段用 `caller-attempted-to-supply-canonical-
   evidence` 指名拒绝，绝不是静默忽略），但浏览器侧不把"拦住它"当成服务端的责任。

   ── 超时权威 ───────────────────────────────────────────────────────
   这里**不发明**默认超时。调用方不给 timeoutMs，body 里就是 null，服务端以
   timeout-authority-missing 拒绝 —— 一个由浏览器凭空发明的"20 秒策略"
   正是 R4-C.1 §12 删掉的那件东西。`_request` 那一层的 DEFAULT_TIMEOUT_MS
   只是**传输层的上界**（socket 不能永远挂着），不是 provider policy，
   两者不可互相冒充。 */
var RUNTIME_OPERATION = 'memory-interpretation';
var RUNTIME_PATH = '/internal/runtime/memory-interpretation';
/* ── P21-R4-LIVE-3.4 · 召回边界的契约常量（与上面同一份纪律）──────────────
   路径与 operation 在浏览器侧只有**这一份**字面量；服务端那条路径的常量在
   services/home-node/runtime-recall.js#PATH（装配层从那里取，两处是同一份契约）。 */
var RECALL_OPERATION = 'memory-recall';
var RECALL_PATH = '/internal/runtime/memory-recall';
/* ── P21-R4-PROD-1 · 认知控制面（产品级读写边界）──────────────────────────
   路径与 operation 在浏览器侧只有**这一份**字面量（服务端那份在
   services/home-node/http.js#COGNITIVE_POLICY_PATH）。
   ★ 这一层是**窄动词**，不是通用配置写入：只允许 read / set 两个 operation，
     set 只允许两个布尔。任何别的东西（provider / credentialRef / dataDir /
   version / autoBehaviorEffectEnabled / …）在**构造层**就没有位置可放。 */
var COGNITIVE_POLICY_PATH = '/internal/runtime/cognitive-policy';
var COGNITIVE_POLICY_OPERATIONS = ['read', 'set'];
/* 允许**从调用方复制**的输入只有三个：selectedMemoryIds（必需）与
   currentState / roleName（可选）。canonical 证据（records / content /
   evidenceState / …）与执行权威（provider / model / apiKey / …）都不在这里，
   因此它们在**构造层**就没有机会出现 —— 白名单不是"记得去删"。
   currentState 在契约里也只是两个键（R4-C normalizeInput 真正消费的那两个）。 */
var RUNTIME_STATE_KEYS = ['relationship', 'emotion'];

function _runtimeHasOwn(obj, key) { return !!obj && Object.prototype.hasOwnProperty.call(obj, key); }
function _runtimeIsPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function createRuntimeRemote(deps) {
  /* deps 与其余三个 driver 同形（装配层总是 `factory({})` 调用）。这里**刻意**
     不从 deps 读任何超时或模型默认值：超时权威在调用方，模型与凭据在服务端，
     浏览器侧没有第三个可以决定它们的地方。 */
  deps = deps || {};
  return {
    /* input  = { characterId, selectedMemoryIds, currentState?, roleName? }
       options = { timeoutMs } —— 除这两个入参以外，本动词不接受任何其它参数。 */
    runMemoryInterpretation: function (input, options) {
      options = options || {};
      var src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
      /* 一个 timeoutMs 同时决定 body 里的**权威声明**与传输层的等待上界。
         两者取同一个数，是为了让"服务端以为的超时"与"客户端等待的超时"
         不会各自漂移；也正因为它们是同一个数，缺省时这里是 NaN，
         body 里落成 null 而由服务端拒绝 —— 而不是被悄悄填成 15000。 */
      var timeoutMs = Number(options.timeoutMs);
      var payload = {
        operation: RUNTIME_OPERATION,
        characterId: String(src.characterId == null ? '' : src.characterId),
        timeoutMs: timeoutMs
      };
      /* selectedMemoryIds：**只**带 id，而且是浅拷贝 —— 请求体要等
         ensureCredential() 之后才序列化，浅拷贝让"调用方随后改这个数组"
         不会改变这一次请求的事实。非数组**原样带上**：客户端不替调用方
         "修好"一个坏输入，也不静默丢掉它（那会让一次失败的输入看起来成功）。 */
      if (_runtimeHasOwn(src, 'selectedMemoryIds')) {
        var ids = src.selectedMemoryIds;
        payload.selectedMemoryIds = Array.isArray(ids) ? ids.slice() : ids;
      }
      /* currentState：契约只冻结 relationship / emotion 两个键，因此这里也
         **闭集构造**。浅拷贝会把调用方塞在里面的 records / content 原样带上
         wire —— 那是同一条内容通道的**嵌套变体**，而这一层的职责正是让它
         在构造层不存在。非对象同样原样带上（同上：不静默丢弃坏输入）。 */
      if (_runtimeHasOwn(src, 'currentState')) {
        var state = src.currentState;
        if (_runtimeIsPlainObject(state)) {
          var closedState = {};
          for (var i = 0; i < RUNTIME_STATE_KEYS.length; i++) {
            var stateKey = RUNTIME_STATE_KEYS[i];
            if (Object.prototype.hasOwnProperty.call(state, stateKey)) closedState[stateKey] = state[stateKey];
          }
          payload.currentState = closedState;
        } else {
          payload.currentState = state;
        }
      }
      /* roleName 是**显示名**，不是权威：原样转发，由服务端与核心裁剪。 */
      if (_runtimeHasOwn(src, 'roleName')) payload.roleName = src.roleName;
      return _request(RUNTIME_PATH, {
        method: 'POST',
        body: payload,
        timeoutMs: timeoutMs
      });
    },

    /* ── P21-R4-LIVE-3.4 · 桌面召回边界（第二个**具名**运行时动词）──────────
       它与 runMemoryInterpretation 是**两条边界**，不是一个动词的两种参数：
       一条回答"这一轮该想起谁"（本地、不花钱、mode 决定影子/权威），一条回答
       "这些记忆意味着什么"（出网、花预算、读 Vault）。这里加第二个动词因此
       不违背上面那段"只有一个动词"的收窄原则 —— 那条禁止的是**通用出口**
       （runRuntimeModel / deriveAnything / 可指定 provider 的调用），
       而不是"第二条具名边界"。本动词同样没有内容通道、没有 provider 参数。

       input  = { mode?, characterId, requestId, conversationId, message,
                  isFirstTurn?, conversationSignalAvailable? }
       options = { timeoutMs }

       body 由**显式字段列表**按冻结顺序拼出（闭集构造是安全性质，不是风格）：
         · operation / timeoutMs 恒在：timeoutMs 缺省时是 NaN ⇒ wire 上落成 null
           ⇒ 服务端拒绝。这一层**不发明**默认超时（与解释动词逐字同一条理由）；
         · 四个身份/文本字段恒在：null/undefined ⇒ ''（由服务端以 shape 拒绝），
           绝不把 'undefined' / 'null' 当正文送上线；
         · mode / isFirstTurn / conversationSignalAvailable **只在调用方给了**
           的时候带。`mode` 缺席时服务端默认 'shadow' —— 那个默认是**服务端的**
           决定，浏览器不替它写死（写了就等于把一条服务端策略复制到客户端）。
       调用方即使传 { selectedIds, candidateRecords, records, scores, budget,
       maxChars, cooldown, seatPlan, exploration, random, now, query, settings, … }，
       这些键也**一个都到不了 wire**：它们不是被删除的（删除列表会随服务端新增
       字段而漂移），而是从来没有被复制过。服务端仍会独立复核（权威字段用
       caller-attempted-to-supply-recall-authority 逐名拒绝），但浏览器侧不把
       "拦住它"当成服务端的责任。

       ★ `mode` 是**能力请求**（要哪条生命周期：'shadow' | 'authoritative'），
         不是数据权威：这一层原样转发，闭集校验与语义都由服务端给出；
         客户端不替调用方"修好"一个坏值，也不静默丢掉它。

       ★ 不做信封解包：与解释边界一样，这条路径返回的信封本来就是**平的**
         （ok / selectedIds / counts / boundary …），再解一次 payload 会把
         真正的选召事实推进一个不存在的 payload 里。 */
    runMemoryRecall: function (input, options) {
      options = options || {};
      var src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
      /* 一个 timeoutMs 同时决定 body 里的**权威声明**与传输层的等待上界
         （与解释动词同源：两者取同一个数，缺省是 NaN ⇒ wire 上 null）。 */
      var timeoutMs = Number(options.timeoutMs);
      var payload = { operation: RECALL_OPERATION };
      if (_runtimeHasOwn(src, 'mode')) payload.mode = src.mode;
      payload.characterId = String(src.characterId == null ? '' : src.characterId);
      payload.requestId = String(src.requestId == null ? '' : src.requestId);
      payload.conversationId = String(src.conversationId == null ? '' : src.conversationId);
      payload.message = String(src.message == null ? '' : src.message);
      if (_runtimeHasOwn(src, 'isFirstTurn')) payload.isFirstTurn = src.isFirstTurn;
      if (_runtimeHasOwn(src, 'conversationSignalAvailable')) {
        payload.conversationSignalAvailable = src.conversationSignalAvailable;
      }
      /* P21-R4-LIVE-3.4 · 群聊回合声明。
         ★ 少了这一行，桌面群聊的召回会被**当成单聊**评估：seam 传了 `isGroup:true`，
           而这一层白名单不复制它 ⇒ wire 上没有该键 ⇒ 服务端按 DM 语义算可见性
           （只读 only/except）而不是群聊语义（仅 public）。这是真实浏览器验证
           （task-25）抓到的 seam→wire 缺口，不是理论问题。
         与 mode 同规矩：只在调用方给了才带；值原样转发，坏值由服务端 shape 拒绝 ——
         客户端既不"修好"也不静默丢弃。 */
      if (_runtimeHasOwn(src, 'isGroup')) payload.isGroup = src.isGroup;
      payload.timeoutMs = timeoutMs;
      return _request(RECALL_PATH, {
        method: 'POST',
        body: payload,
        timeoutMs: timeoutMs
      });
    },
    /* ── P21-R4-PROD-1 · 认知控制面：按角色读/写两个认知开关 ─────────────
       与 runMemoryRecall 同一套传输与凭据路径（`_request` 用同一个桌面
       token 来源），但**只**构造两套闭集请求体：
         { operation:'read', characterId }
         { operation:'set',  characterId, autoInterpretationEnabled, autoExpectationEnabled }
       浏览器提交的是**意图**；状态矩阵由服务端权威层裁决（OFF/ON 会被拒）。
       本地不做任何 policy 缓存/镜像：每次调用都是一次真实的服务端往返。 */
    runCognitivePolicy: function (input, options) {
      options = options || {};
      var src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
      var operation = String(src.operation == null ? '' : src.operation);
      if (COGNITIVE_POLICY_OPERATIONS.indexOf(operation) < 0) {
        return Promise.resolve({ ok: false, operation: null, error: 'invalid-operation', reasonCode: 'invalid-operation' });
      }
      var timeoutMs = Number(options.timeoutMs);
      var payload = {
        operation: operation,
        characterId: String(src.characterId == null ? '' : src.characterId)
      };
      if (operation === 'set') {
        if (typeof src.autoInterpretationEnabled !== 'boolean' || typeof src.autoExpectationEnabled !== 'boolean') {
          return Promise.resolve({ ok: false, operation: operation, characterId: payload.characterId, error: 'invalid-value', reasonCode: 'invalid-value' });
        }
        payload.autoInterpretationEnabled = src.autoInterpretationEnabled;
        payload.autoExpectationEnabled = src.autoExpectationEnabled;
      }
      return _request(COGNITIVE_POLICY_PATH, {
        method: 'POST',
        body: payload,
        timeoutMs: timeoutMs
      });
    }
  };
}
NS.createRuntimeRemote = createRuntimeRemote;
})(window.IB || (window.IB = {}));
