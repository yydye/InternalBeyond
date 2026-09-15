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
     · 非 loopback 来源**整片**拒绝，除非装配层证明了"显式非 loopback 绑定
       且设备鉴权已就绪"（`deps.allowRemote`，见下面的 remoteAllowed()）；
     · 门开了之后：/mobile/v1/* 只认 device token；其余（桌面面）要求
       **已配置且匹配**的桌面 token —— 未配置 token 时远端一律 403
       `remote-admin-disabled`，因为放宽就等于把签发配对凭据与撤销设备的能力
       交给整个局域网；
     · 若设置了 home-node token（IB_HOME_NODE_TOKEN 或 config），则**所有**
       请求都必须携带；
     · **凭据铸造面在 loopback 上也不再默认放行**（P11-3A）：`/pairing/session`、
       `/mobile/v1/pairing/complete`、`/devices`、`/device/revoke`、
       `/characters/publish`、`/characters` 这些"签发或撤销凭据 / 改设备可见目录"
       的路径，在未配置桌面 token 时一律 403 `desktop-token-required`。
       未配置 token 时按 loopback 单用户模型放行只适用于**读取类**路径，但**不**
       回显 CORS 头给任意 Origin —— 只允许无 Origin（原生请求 / 同源 fetch）
       与显式白名单 Origin。
   ==================================================================== */
'use strict';

const http = require('http');
const crypto = require('crypto');

const CHAT_CORE = require('../../assets/js/chat-core.js');
/* P11-3H：停止面的路径常量（唯一来源，不在这里再写一遍字面量）。 */
const serviceControl = require('../../runtime/service-control.js');

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
  /* P22-2 · Economy 的**只读**句柄。若装配层没传，`/economy/*` 回答
     501 economy-not-assembled —— 而不是静默地 404。两者的区别很重要：
     前者是"这一域没有接线"（一个可修的装配缺口），后者会被读成
     "这个路径不存在"（设计如此）。P11-3E 的教训正是"装配缺口伪装成
     正常行为"。本层**不**从 store 取得任何写能力：mint / burn /
     commitLedgerTransaction 一律不可达。 */
  const economy = deps.economyStore || null;
  const executor = deps.executor || null;
  const gateway = deps.gateway || null;
  const clock = deps.clock || (() => Date.now());
  const token = String(deps.token || '');
  const version = String(deps.version || '0.0.0');
  const allowedOrigins = Array.isArray(deps.allowedOrigins) ? deps.allowedOrigins.map(String) : [];
  const logger = deps.logger || (() => {});
  const startedAt = clock();
  const logRing = [];

  /* P11-3H · 合作停止面。装配层传一个**取值器**（route 需要用到装配层作用域里的
     teardown，而本层在它之前被构造出来）；不传、传 null 或取值器返回 null 时，
     全部停止相关行为不存在（修复前的语义）。 */
  const stopRouteSource = typeof deps.stopRoute === 'function' ? deps.stopRoute : () => null;
  function stopRouteNow() {
    try { return stopRouteSource() || null; } catch (_) { return null; }
  }

  /* ── LAN 门（M1-C blocker：allowRemote）──────────────────────────────
     `deps.allowRemote` 既可以是布尔，也可以是**函数**。允许函数不是风格
     问题，而是这条规则本身的要求：

       "是否允许非 loopback 客户端"取决于**设备鉴权此刻是否真的就绪**
       （设备注册表是否真的打开、鉴权查询是否真的能回答）。而 http 层是在
       `open()` **之前**被构造出来的 —— 把判定结果在构造时固化成布尔，等于
       把一个尚未被证实的前提写进安全决策里：装配顺序一变（比如先 listen
       后 open），门就会在鉴权子系统还没就绪时先开着。

       因此这里每次请求都重新问一次；判定抛异常时**拒绝**（fail-closed）。 */
  const allowRemoteSource = typeof deps.allowRemote === 'function' ? deps.allowRemote : () => !!deps.allowRemote;
  function remoteAllowed() {
    try { return !!allowRemoteSource(); } catch (_) { return false; }
  }

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
    applyCors(headers, req);
    res.writeHead(status, headers);
    res.end(body);
  }

  /* ── CORS：为什么必须允许 `Origin: null`（实测结论，不是疏忽）─────────────
     产品的第一类运行方式是**双击 InternalBeyond.html（file://）**（见
     communication.js:100-104 与 WEB_PAGE 注释）。在这个 origin 下浏览器发出的
     跨域请求带的是 `Origin: null`，而任何"只回显白名单 Origin"的写法都会让
     **桌面自己在 file:// 下完全读不到 Home Node**：请求会到达，但读取响应体时
     被 CORS 拦掉 —— 表现为 authority 一直停在 'not-probed'，没有任何可见错误。
     本文件最初的实现正是这样，被 M1-A 浏览器冒烟抓出来。

     因此默认策略是：
       · 无 Origin（原生请求）→ 不加 CORS 头，也不需要；
       · `null`（file://）或 loopback Origin → 回显，允许读取；
       · 其它 Origin → 不回显（浏览器会拦掉读取），除非显式列入白名单；
       · 一旦配置了 token（IB_HOME_NODE_TOKEN），**null origin 不再被信任**：
         所有请求都必须带 token，本机 file:// 也一样。
     与 D1（docs/DECISIONS.md:6-13）已有的风险接受一致：这是本机单用户应用、
     loopback 绑定；把 Home Node 绑到 LAN 属于 M1-B/M1-C 的范围，本阶段不做。 */
  function originAllowed(origin) {
    const value = origin == null ? '' : String(origin);
    if (!value) return false;                       /* 无 Origin：不需要 CORS 头 */
    if (allowedOrigins.indexOf(value) >= 0) return true;
    if (value === 'null') return !token;             /* file:// —— 仅在无 token 时信任 */
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(value)) return true;
    return false;
  }
  function applyCors(headers, req) {
    const origin = req && req.headers ? req.headers.origin : null;
    if (originAllowed(origin)) {
      headers['Access-Control-Allow-Origin'] = String(origin);
      headers['Vary'] = 'Origin';
    }
  }

  function ok(res, payload, req) { sendJson(res, 200, Object.assign({ ok: true, protocolVersion: PROTOCOL_VERSION, serverTime: clock() }, payload), req); }
  function bad(res, status, error, extra, req) { sendJson(res, status, Object.assign({ ok: false, error: error }, extra || {}), req); }

  /* ── A store that cannot serve is not a bad request (P11-3X-B) ──────────
   *
   * `store-closed` and the database failure classes used to answer 400 through the
   * generic "the store said no" path. 400 means "your request was malformed" and
   * sends the caller to fix a payload that was in fact fine — while the device face
   * already answered 503 for the very same condition, so the two faces of one
   * service disagreed about one fact. Only the class changes: every other error
   * keeps the status its call site already chose. */
  const UNAVAILABLE_STORE_ERRORS = [
    'store-closed', 'db-readonly', 'db-permission-denied', 'db-busy',
    'db-locked', 'db-disk-full', 'db-open-failed', 'db-unavailable'
  ];
  function storeError(res, error, extra, req, fallbackStatus) {
    if (UNAVAILABLE_STORE_ERRORS.indexOf(String(error)) >= 0) { bad(res, 503, error, extra, req); return; }
    bad(res, Number(fallbackStatus) || 400, error, extra, req);
  }

  /* ── Canonical store inventory + ONE failure vocabulary (P11-3E) ─────────
   *
   * P11-3X-B made `/health` able to say "reachable, but not serving". It answered
   * that question for exactly one store, because at the time exactly one store was
   * opened by every path that serves. P11-3E closed the gap that made a second one
   * unsafe to mention: Home Node's production start path now opens the canonical
   * Moments store, so a closed one is a real, tracked failure instead of a known
   * assembly gap. Folding it into the verdict is therefore a truthful report, not a
   * permanent false alarm.
   *
   * The taxonomy is deliberately NOT new and NOT restated here as a second list:
   *   · `store-closed` is the value runtime/component-registry.js and
   *     runtime/boot-state.js already carry (REASON.STORE_CLOSED);
   *   · every other category is a reason id produced by the ONE classifier,
   *     runtime/db-failure.js — the module is injected, never re-implemented.
   * A category this file cannot name keeps its own class rather than being dressed
   * up: `classify` only answers for database failures, so a programming bug is not
   * allowed to become `db-open-failed` (see db-failure.isDatabaseError). */
  const TERMINAL_STORE_CATEGORIES = ['db-corrupt', 'db-schema-too-new', 'db-unavailable'];

  /* The canonical stores this process is a promise about. `role` matters: health is
     a verdict about a declared role, and `/health` publishes exactly one such role.
     A second store is folded in only as evidence ABOUT that role — which is what
     P11-3E settled: the Moments store is part of what serving this node means. */
  const DEFAULT_STORES = [{ store: store, name: 'chat', role: 'canonical-chat-authority' }];

  const classifyFailure = typeof deps.classifyFailure === 'function' ? deps.classifyFailure : null;

  /* Report every canonical store that cannot serve right now, in declaration order.
     `probe` is what makes "failed to open" reportable after the fact: a store that
     threw during open() has no `isOpen()` to consult, so the assembly layer hands a
     function that answers "how did it fail, the last time it was asked to open". */
  function storeFailures() {
    const inventory = Array.isArray(deps.stores) && deps.stores.length ? deps.stores : DEFAULT_STORES;
    const failures = [];
    for (const entry of inventory) {
      if (!entry || !entry.store || !entry.name) continue;
      const probe = typeof entry.probe === 'function' ? entry.probe : null;
      if (entry.store.isOpen()) continue;
      const classified = probe ? probe() : null;
      const category = (classified && classified.category) || 'store-closed';
      const message = (classified && classified.message) ||
        ('the canonical ' + entry.name + ' store is not open, so this node cannot serve its role');
      failures.push({
        store: String(entry.name),
        role: String(entry.role || ''),
        category: String(category),
        message: String(message)
      });
    }
    return failures;
  }

  /* One closed store may be reported to two different surfaces — `/health`, and a
     canonical route that has to answer an HTTP status. Both must classify it the
     same way, so the resolution lives here, once, instead of being re-decided at
     each call site. The terminal classes are exactly the ones the generic
     unhandled-error path already treats as terminal: a corrupt database or one
     written by a newer build will not be fixed by retrying, while a locked, busy,
     read-only or full one might be. */
  function resolveStoreFailure(failure) {
    const category = String((failure && failure.category) || 'store-closed');
    const terminal = TERMINAL_STORE_CATEGORIES.indexOf(category) >= 0;
    return {
      category: category,
      status: terminal ? 500 : 503,
      code: String((failure && failure.code) || category),
      store: String((failure && failure.store) || ''),
      message: String((failure && failure.message) || 'the requested store cannot serve right now')
    };
  }

  /* ── Failure reporter for the OTHER canonical stores (P11-3E) ────────────
   *
   * `store.isOpen()` can only report a store that was successfully constructed and
   * then closed. It cannot report one whose `open()` threw: that store has never
   * been open, and the exception is the only evidence there is. This factory turns
   * the two cases into one honest answer by asking the classifier about the LAST
   * attempt — which is why the assembly layer keeps the thrown error instead of
   * swallowing it.
   *
   * The class is decided by `classifyFailure` (runtime/db-failure.js) and only for
   * genuine database failures: a bug that happened to be thrown while opening a
   * store keeps its own identity and is reported as `store-closed` rather than
   * being dressed up as a disk problem. That is db-failure's own documented rule
   * (`isDatabaseError`), reused rather than restated. */
  function createStoreFailureProbe(spec) {
    return module.exports.createStoreFailureProbe(spec, {
      classifyFailure: classifyFailure,
      isDatabaseError: typeof deps.isDatabaseError === 'function' ? deps.isDatabaseError : null
    });
  }

  function healthFailure() {
    const failures = storeFailures();
    if (!failures.length) return null;
    const chat = failures.filter(f => f.role === 'canonical-chat-authority');
    const named = chat.length ? chat[0] : failures[0];
    return {
      category: named.category,
      message: named.message,
      stores: failures
    };
  }

  /* ── canonical health contract (P11-3X-B) ────────────────────────────────
   *
   * What `/health` is allowed to mean. The four answers the component model and
   * the diagnostics page need are NOT four fields invented here — they are the
   * four outcomes the probe layer already distinguishes, and this payload's job is
   * to make each of them derivable without asking a second question:
   *
   *   service reachable   ← the HTTP response itself (`reachable`/`offline`/
   *                          `timeout` in the probe report; a closed store never
   *                          pretends the process is gone)
   *   store open          ← `open`  (the declared role's canonical store)
   *   degraded            ← `ok:false` + `serving:false` + `failure.category`
   *   unavailable         ← no answer at all: the probe never reaches this code
   *
   * Before this, `ok` was unconditionally true, so a Home Node whose canonical
   * store was closed answered `{ok:true, open:false}` and every consumer that only
   * looks at `ok` (the runner's probe, the component registry, the boot record)
   * called it `healthy`. Measured, before the fix: /health → 200 `{ok:true,
   * open:false}` and registry.probeComponent → `{state:'healthy', healthy:true}`.
   * A process that cannot serve a single chat request was reported as a working
   * component, and the supervisor's only evidence of health said so too — which is
   * also why it could never recover one.
   *
   * `role` is what makes `serving` decidable without a store inventory: the
   * declared role names the canonical store it is a promise about
   * (`canonical-chat-authority` → the chat store). P11-3X-B deliberately stopped
   * there, because at the time the Moments store was not opened by the production
   * start path at all — folding a KNOWN assembly gap into health would have turned
   * a tracked defect into a permanent false alarm and a recovery loop. P11-3E
   * closed that gap FIRST (see services/home-node-service.js `openAll`/`shutdown`)
   * and only then folded the Moments store in. The order is the point: readiness
   * may only be reported once it is actually true.
   *
   * HTTP 200 with `ok:false` is deliberate. The transport succeeded — the caller
   * really did reach the process — and that is information the component report
   * needs (`reachable:true` next to `state:'error'`). Collapsing it into a 503
   * would erase the difference between "not there" and "there but broken", which
   * is the exact distinction this phase exists to protect. `identityRequiresOk`
   * stays false for this component, so a name-only identity check (ib-stop, the
   * installer's stop chain) still recognises the process and can still stop it. */
  function healthPayload() {
    const failures = storeFailures();
    const failure = healthFailure();
    /* `open` keeps meaning exactly what it always meant: the **declared role's**
       own canonical store, chat. `stores` below reports the rest without
       overloading a field the desktop diagnostics already read. */
    const open = store.isOpen();
    return {
      service: 'internal-beyond-home-node',
      version: version,
      role: 'canonical-chat-authority',
      open: open,
      /* `serving` is the role-level verdict. Adding it (rather than overloading
         `open`) keeps "the chat store is open" and "this node can do its job"
         separable — today they are the same question, and the day they are not is
         the day a health check silently becomes a lie. */
      serving: !failure,
      /* Every canonical store this process is a promise about, with its own
         verdict. `/health` publishes one role, so `failure` names the declared
         role's store; this list is how a consumer can tell WHICH domain is down
         without a second request or a guess. */
      stores: failures.map(f => ({ store: f.store, open: false, category: f.category })),
      revision: open ? store.getRevision() : 0,
      messages: open ? store.countMessages() : 0,
      schemaVersion: store.schemaVersion,
      failure: failure
    };
  }

  /* One sender for /health, so the two call sites (loopback probe and the
     token-authenticated remote probe) cannot drift into different verdicts. */
  function sendHealth(res, req) {
    const payload = healthPayload();
    sendJson(res, 200, Object.assign({
      ok: payload.serving !== false,
      protocolVersion: PROTOCOL_VERSION,
      serverTime: clock()
    }, payload), req);
  }

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

  /* ── 凭据铸造面（P11-3A）────────────────────────────────────────────
     这些路径**签发或撤销凭据**，或改变设备的可见目录。它们与"读自己的数据"
     不是同一类风险：读泄露一次；铸造出来的 device token 在撤销之前一直有效，
     而且能走完整条设备面。

     为什么它们不能再靠 loopback 私密性保护：`isLoopback()` 证明的是
     "请求来自本机网络栈"，而不是"来自桌面产品"。本机上任何用户态进程 ——
     脚本、扩展、另一个应用 —— 都能连上 loopback，因此"未配置 token 就放行"
     等于把签发配对凭据的能力交给本机每一个进程。实测（.dsh-research/
     p11-3a-probe.js）：无 Origin 的本地进程 POST /pairing/session 拿到 secret，
     再 POST /mobile/v1/pairing/complete 即拿到 device token。

     因此本面要求**已配置的桌面 token**。未配置时不是"放行"，也不是
     "401 请带凭据再来"（不存在任何能奏效的凭据），而是 403 + 一条可执行的
     指路：设置 IB_HOME_NODE_TOKEN。这与远端那条 `remote-admin-disabled`
     的写法同源 —— 缺凭据就明说缺什么，而不是给一个永远失败的入口。 */
  const CREDENTIAL_MINTING_PATHS = [
    '/pairing/session', '/devices', '/device/revoke', '/characters/publish'
  ];
  function isCredentialMintingPath(path) {
    if (CREDENTIAL_MINTING_PATHS.indexOf(path) >= 0) return true;
    /* 设备面里**唯一**不需要 device token 的端点：它的凭据就是 pairing secret，
       所以它本身就是凭据铸造端点，必须与 /pairing/session 同门。 */
    return path === '/mobile/v1/pairing/complete';
  }
  function credentialMintingBlocked(path) {
    if (token) return false;
    return isCredentialMintingPath(path);
  }

  /* token 只在「配置了 token」时才强制 —— 默认安装（loopback 单用户）保持零门槛，
     与 D1 的风险接受范围一致；一旦用户显式设置 token，则没有豁免路径。
     P11-3A 收紧了上面那一段"零门槛"的适用范围：凭据铸造面不再包含在内。 */
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

  async function route(req, res, url, method, remote) {
    const path = url.pathname.replace(/\/+$/, '') || '/';

    /* ── P11-3H · 合作停止面（本地停止请求，不是世界数据路径）─────────────
       必须在**所有**凭据/来源规则之前处理，理由很具体：Home Node 可以被显式绑到
       LAN（IB_HOME_NODE_HOST），而未配置桌面 token 时远端**一切**桌面路径都是
       403 `remote-admin-disabled`。停止请求来自本机（runtime/local-services-runner.js
       或 installer 的 tools/ib-stop.js），准入判定由注入的 stopRoute 自己做；
       如果让它走桌面凭据链，一次合法的本机停止会在 LAN 绑定下被 403 ——
       installer 于是只能退回 kill，而"合作停止"在那种部署里静默失效。

       这一层不自己实现判定：`deps.stopRoute` 就是 runtime/service-control.js 的
       `createStopRoute()`，唯一的准入规则与唯一的拆除梯子都在那里。
       **不注入 stopRoute 时本分支整体不存在**，行为与修复前逐字一致。 */
    if (path === serviceControl.STOP_PATH) {
      const stopRoute = stopRouteNow();
      if (stopRoute) {
        const handled = await stopRoute(req, res);
        if (handled) return;
      }
    }

    /* ── Origin 授权（P11-3X-A）：命名的外来 Origin 一律拒绝 ─────────────
       `originAllowed()` 的语义是"**能不能读**我们的响应"：它只决定要不要回 ACAO
       头。而请求的**副作用**与 CORS 无关 —— CORS 从不阻止请求被执行。于是本文件
       声明的策略（"未配置 token 时按 loopback 单用户模型放行只适用于**读取类**
       路径，但**不**回显 CORS 头给任意 Origin"）在**写**这一半上只是注释：
       一个 `Origin: http://evil.example` 的页面发出 `Content-Type: text/plain`
       的**简单请求**（不触发预检），readBody() 照样 JSON.parse，写就落地了。
       实测（.dsh-research/p11-3x-a-probe.js G3，修复前）：
         POST /migrate（Origin: http://evil.example, text/plain）
         → 200，且 GET /migration?source=csrf-canary 的版本由 0 变成 4242。
       响应读不到（没有 ACAO），所以这是一条**盲写**：攻击者不需要读到任何东西。

       本仓库的同类本地服务早就是这个语义，不是新模型：
         · active/http.js                    → 403 { error: 'Origin is not allowed' }
         · runtime/local-services-runner.js  → 403 { error: 'origin-denied' }
         · services/internal-beyond-server.js→ 403 { error: 'origin-denied' }
       这里把 Home Node 的**桌面面**对齐到同一条既有策略。

       刻意只覆盖桌面面，且**不碰 `Origin: null`**：
         · `/mobile/v1/*` 是设备面，身份是 device token，Origin 在那里只是
           "能不能读"的兼容开关（网关自己判定，且它连 capacitor:// 都要放行）；
           把桌面策略套上去会让手机永远无法在 LAN 上配对；
         · `Origin: null`（file://）与无 Origin（原生调用方）继续沿用既有的
           P11-3A 规则（配置 token 后不再信任 null），本行不改那件事。 */
    const rawOrigin = String(req.headers.origin || '').trim();
    if (rawOrigin && rawOrigin !== 'null' && path.indexOf('/mobile/') !== 0 && !originAllowed(rawOrigin)) {
      record('warn', 'rejected-origin', { path: path, origin: rawOrigin, loopback: isLoopback(req) });
      bad(res, 403, 'origin-denied', { hint: 'a browser page on a foreign origin may not reach the Home Node' }, req);
      return;
    }

    /* ── 远端（非 loopback）**非 mobile** 路径：统一凭据规则 ─────────────
       为什么这条必须存在：`authorized()` 在**未配置 token** 时对一切放行
       （loopback 单用户模型，见文件头 §安全模型）。这在 loopback 上是对的 ——
       能连上 loopback 就等价于"坐在本机"。但一旦 allowRemote 打开，同一个函数
       会让整个**桌面面**（/status、/meta、/health、/pairing/session、/devices、
       /device/revoke、/characters、/characters/publish）对所有 LAN 客户端匿名
       可用，其中包括**签发配对凭据**和**撤销设备**这两件事。
       所以：除非真的配置了桌面 token，否则远端一律碰不到桌面面。

       403 而不是 401：没配 token 意味着"这套凭据不存在"，401 会暗示
       "带上凭据再来"，而这里不存在任何能奏效的凭据。

       刻意**不覆盖** /mobile/v1/*：那是设备面，凭据是 device token，由网关
       自己判定。若这条也管 mobile，手机就永远无法在 LAN 上配对 —— 而那正是
       允许 LAN 的全部意义。 */
    const isMobilePath = path.indexOf('/mobile/') === 0;
    /* `/memory/*` 是**桌面面**（M1-C.2d Wave 2）而不是设备面：它承载 canonical
       记忆正文与召回。因此它必须走与 /status /characters 同一套保护 ——
       远端未配置桌面 token 时 403，而不是匿名可读。
       把记忆排除在这条规则之外，等于把"她的长期记忆"暴露给整个局域网。
       M1-C.2m：`/understanding/*` 同理，而且是**更私密**的一类内容 ——
       它是角色对用户的私有认知状态（含用户更正原文）。前缀守卫必须与
       /memory/ 逐字同款，否则默认绑 0.0.0.0 的部署会让局域网读到"她怎么看你"。 */
    const isDesktopOnlyPath = path.indexOf('/memory/') === 0 || path.indexOf('/understanding/') === 0 || path.indexOf('/moments/') === 0 || path.indexOf('/economy/') === 0;
    if (remote && (!isMobilePath || isDesktopOnlyPath)) {
      if (!token) {
        record('warn', 'rejected-remote-non-mobile', { path: path, reason: 'no-desktop-token-configured' });
        bad(res, 403, 'remote-admin-disabled', { hint: 'set IB_HOME_NODE_TOKEN to reach desktop paths from the network' }, req);
        return;
      }
      if (!authorized(req, url)) {
        record('warn', 'unauthorized', { path: path, loopback: false });
        bad(res, 401, 'unauthenticated', null, req);
        return;
      }
    }

    /* ── 凭据铸造面（P11-3A）：loopback 上也不再默认放行 ──────────────────
       放在这里而不是 `authorized()` 里，是因为它们要用**不同的状态码与理由**：
       `authorized()` 的 401 语义是"带上凭据再来"，而这里在未配置 token 时
       根本不存在能奏效的凭据 —— 给 401 会让调用方以为补一个头就能过。
       顺序也刻意在远端规则**之后**：远端未配置 token 时已经 403
       `remote-admin-disabled`，那条理由更先成立、也更准确。 */
    if (credentialMintingBlocked(path)) {
      record('warn', 'rejected-credential-minting', { path: path, remote: !!remote, reason: 'no-desktop-token-configured' });
      bad(res, 403, 'desktop-token-required', {
        hint: 'set IB_HOME_NODE_TOKEN to enable pairing and device management'
      }, req);
      return;
    }

    /* ── 委派：Mobile Gateway + 桌面配对/设备管理（M1-B）────────────────
       这一层刻意**不自己判断**哪些 mobile 路径存在：网关是那份 allowlist 的
       唯一持有者（services/home-node/mobile-gateway.js 的 handles()）。
       http.js 只负责"桌面内部 API 的既有保护"（token + loopback），
       设备鉴权在网关的 /mobile/v1 分支里发生。
       注意顺序：委派发生在 token 校验**之后**，因此桌面管理面
       （/pairing/session、/devices、/device/revoke、/characters、
       /characters/publish）继承 Home Node 既有的 loopback/token 保护；
       而 /mobile/v1/* 自己的 device token 才是设备的凭据。 */
    if (gateway && typeof gateway.handles === 'function' && gateway.handles(path)) {
      /* P11-3E：canonical store 失败的分类与状态码由**本文件唯一决定**（见
         UNAVAILABLE_STORE_ERRORS / TERMINAL_STORE_CATEGORIES），网关只是借用它。
         把这一条做成注入而不是让网关自己再写一份，是因为"同一个事实在服务面上
         有两个答案"正是 P11-3X-B 修掉的那个缺陷 —— 桌面路由回答 503、设备面
         回答 400。注入发生在走通这条委派之前，所以网关的任何一条路由都能用到同一份。 */
      if (typeof gateway.useStoreFailureResolver === 'function') {
        try { gateway.useStoreFailureResolver(resolveStoreFailure); } catch (_) { /* 网关不可注入时保持原语义 */ }
      }
      if (isMobilePath && !isDesktopOnlyPath) {
        /* 设备 API：不要求桌面 token（设备有自己的 token），
           但**仍然**受 loopback/allowRemote 与体积上限约束 —— 那两条在
           server 层已经处理，这里只是不再套桌面 token。 */
        return gateway.dispatch(path, req, res, url);
      }
      if (!authorized(req, url)) {
        record('warn', 'unauthorized', { path: path, loopback: isLoopback(req) });
        bad(res, 401, 'unauthenticated', null, req);
        return;
      }
      return gateway.dispatch(path, req, res, url);
    }

    /* ── 只读探针（不需要 token，但也绝不返回任何世界数据）──
       loopback：不带 token 也回答 —— 桌面 local-services-runner / 诊断页就是
       这样打它的，既有行为不变。
       远端：这是**本机诊断探针**，不是给网络用的。它确实会泄漏 revision 与消息
       条数，而"局域网里任何人都能读到这个世界有多大"不是我们愿意用便利换来的
       东西；因此远端必须先过上面那条远端规则（未配置桌面 token → 403；
       配了 token 但没带/带错 → 401）。 */
    if (path === '/health' && method === 'GET' && !remote) {
      sendHealth(res, req);
      return;
    }

    if (!authorized(req, url)) {
      record('warn', 'unauthorized', { path: path, loopback: isLoopback(req) });
      bad(res, 401, 'unauthenticated', null, req);
      return;
    }

    /* 远端探针：走到这里说明已经出示了**已配置且正确**的桌面 token，
       因此可以回答（持有桌面 token 的就是桌面自己）。放在凭据规则之后，
       是为了让它复用同一套判定，而不是自己再写一遍。 */
    if (path === '/health' && method === 'GET') {
      sendHealth(res, req);
      return;
    }

    if (path === '/status' && method === 'GET') {
      /* P11-3X-B：/health 的裁决必须在这里也能看到。/status 是桌面诊断真正读的
         地方（它比 /health 详细），如果只有 /health 诚实、/status 不提，用户就
         会看到"服务在线、日志正常、但什么都写不进去"。 */
      const statusFailure = healthFailure();
      const statusStores = storeFailures();
      ok(res, {
        meta: store.meta(),
        serving: !statusFailure,
        failure: statusFailure,
        /* P11-3E：逐域的诚实状态。"哪个域不能服务"是可观测事实，
           不该让读者从 failure 的单个 message 里推断。 */
        stores: statusStores.map(f => ({ store: f.store, open: false, category: f.category })),
        log: logRing.slice(-40),
        startedAt: startedAt,
        mobile: gateway ? gateway.meta() : null
      }, req);
      return;
    }
    if (path === '/meta' && method === 'GET') {
      ok(res, { meta: store.meta(), conversations: store.listConversations() }, req);
      return;
    }
    if (path === '/security' && method === 'GET') {
      /* 明确暴露本进程**没有**什么，供诊断与未来的 gateway 决策使用。 */
      const allowed = remoteAllowed();
      ok(res, {
        loopbackOnly: !allowed,
        allowRemote: allowed,
        tokenRequired: !!token,
        /* ── P11-3A：诚实地把"残余暴露"也说出来 ─────────────────────────
           改这条之前这里只报告 tokenRequired，读者很容易得出"没配 token 就
           什么都没保护、配了就全保护"的二分结论，而真实形状是三类：
             · credentialMintingPaths：**永远**要求桌面 token（未配置即 403）；
             · loopbackReadablePaths：loopback 上未配置 token 时仍可匿名读
               （既有 D1 风险接受，P11-3A 有意不动它，留待 P12）；
             · 远端：未配置 token 时整片 403。
           把第三类写成可检查的字段，是为了让"我们到底接受了什么风险"能被
           断言与审计，而不是继续藏在注释里。 */
        credentialMintingPaths: {
          requiresDesktopToken: true,
          enabled: !!token,
          paths: CREDENTIAL_MINTING_PATHS.concat(['/mobile/v1/pairing/complete']),
          whenTokenMissing: '403 desktop-token-required'
        },
        loopbackReadableWithoutToken: ['/status', '/meta', '/security', '/list', '/changes',
          '/message', '/messages', '/verify', '/migration', '/migrate', '/characters'],
        corsAllowlist: allowedOrigins,
        exposes: ['chat-store', 'character-turn', 'mobile-gateway', 'memory-store'],
        /* M1-C.2d Wave 2 的诚实更新：Home Node **现在确实存储** canonical
           `memories`。原先这里写 'memory' 属于 doesNotExpose —— 那句话曾经为真，
           现在会误导。精确的新声明是：
             · memory **不对任何设备提供**（/mobile/v1 没有 memory verb，
               出站 DTO 也不含记忆行）；
             · 它只在**本机执行缝**里被读出来注入 provider。
           因此把它从 doesNotExpose 移出、改为一个可检查的具体断言
           （tests/test_mobile_thin_client.js 与 tests/test_mobile_memory_continuity.js
           都验证"设备拿不到记忆"这一条仍然成立）。 */
        memoryPolicy: {
          stored: true,
          servedToDevices: false,
          deviceVerbs: [],
          injection: 'home-node-execution-only',
          desktopPaths: ['/memory/list', '/memory/changes', '/memory/records', '/memory/record',
            '/memory/activate', '/memory/settings', '/memory/migration', '/memory/migrate']
        },
        /* M1-C.2m：理解是**私有认知状态**（含用户更正原文），因此与记忆同款：
           存在 Node、经执行缝注入、**绝不**出现在任何设备面。这里的断言是
           可检查的（test_mobile_thin_client / test_understanding_authority）。 */
        understandingPolicy: {
          stored: true,
          servedToDevices: false,
          deviceVerbs: [],
          injection: 'home-node-execution-only',
          derivation: 'home-node-single-writer',
          desktopPaths: ['/understanding/list', '/understanding/changes', '/understanding/records',
            '/understanding/correct', '/understanding/corrections', '/understanding/derive',
            '/understanding/migration', '/understanding/migrate']
        },
        /* M1-C.2n：动态（Moments）也搬进 Node 了 —— 与 memory / understanding
           同款：存在 Node、经执行缝注入、**绝不**出现在任何设备面。
           刻意把 'moments' 从 doesNotExpose 移出来：那句话在 M1-C.2d 对 memory
           就已经不再为真，留着一个已经不成立的断言比没有断言更危险
           （它会让人以为"没有动态路径"是被检查过的）。
           取而代之的是可检查的具体断言：deviceVerbs 为空、
           desktopPaths 与 ADMIN_PATHS 逐字一致（见 test_moments_authority）。
           P11-3G 加了 `/moments/ack`：它是**投递确认**（consumer → 权威），
           证明的是"consumer 对 revision ≤ watermark 的每个 event 都已得出持久结论"，
           服务端只拿它决定 change_log 哪些行可以回收。它同样只存在于桌面/运行时面。 */
        momentsPolicy: {
          stored: true,
          servedToDevices: false,
          deviceVerbs: [],
          injection: 'home-node-execution-only',
          visibility: 'moments-visibility-core (shared with desktop)',
          desktopPaths: ['/moments/list', '/moments/changes', '/moments/records', '/moments/record',
            '/moments/ack', '/moments/visible', '/moments/migration', '/moments/migrate']
        },
        /* P22-2：Agent Economy 进入 Node —— 与 memory / understanding /
           moments 同款，而且这一域的 doesNotExpose 比它们**更**重要：
           一个叫 "economy" 的东西最容易被误读成"这里能充值 / 能付款"。
           因此这里的声明是逐条的、可检查的：
             · 没有 POST /economy/*（本文件的 /economy/* 全是 GET）；
             · 没有 topup / purchase / payment / provider 任何入口；
             · provider 计费与凭据**不在** exposes 里，也不在 doesNotExpose
               的"未来可能会加"意义上 —— 它们由依赖闭包保证（boundary B3：
               Economy 的可达依赖里没有任何一个能碰 provider 或凭据）。
           铸币（mintForSystem）与提交交易（commitLedgerTransaction）是
           **store 的内部 API**，不在这一层上 —— 这是刻意的：HTTP 面只读。 */
        economyPolicy: {
          stored: true,
          canonical: 'sqlite-ledger-entries',
          derived: 'wallet-cached-balance-cache',
          /* P22-3：reserved 这一面同样是"canonical 行 + 派生缓存"，
             而且它决定了 available —— 因此它的两个来源也写在这里。 */
          reservedCanonical: 'sqlite-active-reservations',
          reservedDerived: 'wallet-reserved-balance-cache',
          availableFormula: 'ledgerBalanceMinor - activeReservedBalanceMinor (READY only, otherwise null)',
          servedToDevices: false,
          deviceVerbs: [],
          httpVerbs: ['GET'],
          writesExposed: [],
          /* P22-3 新增了六个会改状态的方法（reserve / commit / release /
             expire / fail / sweep），而它们在路由表上依然**一个都不存在**。
             这条字段就是为了让"没有"可以被断言，而不是被相信。 */
          reservationWritesExposed: [],
          /* P22-4 又新增了六个会改状态的方法（putBudgetPolicy /
             expirePolicy / expireDuePolicies / createQuote / expireQuote /
             expireDueQuotes）—— 名单必须跟着能力长，否则新能力会落在
             断言之外，而"没被断言"在实践中与"被允许"很难区分。 */
          budgetWritesExposed: [],
          quoteWritesExposed: [],
          mintingExposed: false,
          expirationIsNotATimer: true,
          /* P22-4 的三条自述：预算评估是**快照**、不是许可（§19）；
             它不锁任何钱；报价与预留是两件事（§7）。 */
          budgetEvaluationIsASnapshotOnly: true,
          budgetEvaluationReservesFunds: false,
          quoteLocksFunds: false,
          budgetTimezone: 'UTC',
          desktopPaths: ['/economy/health', '/economy/wallet', '/economy/ledger',
            '/economy/transaction', '/economy/changes',
            '/economy/reservations', '/economy/reservation',
            '/economy/policies', '/economy/policy', '/economy/budget',
            '/economy/quotes', '/economy/quote'],
          /* P22-4：/economy/budget 与 /economy/quote **有**只读路由，
             因此它们不出现在 unreachable 里；而不存在的写路径
             （policy/quote 的 POST·PUT·DELETE、approve、evaluate 的写形态）
             逐条列出来。 */
          unreachable: ['/economy/topup', '/economy/purchase', '/economy/payment',
            '/economy/provider', '/economy/mint', '/economy/burn', '/economy/transfer',
            '/economy/reserve', '/economy/commit', '/economy/release', '/economy/expire',
            '/economy/fail', '/economy/sweep',
            '/economy/approve', '/economy/approval', '/economy/inventory',
            '/economy/product', '/economy/store', '/economy/exchange']
        },
        doesNotExpose: ['llm-proxy', 'tools', 'payments', 'diary', 'letters', 'images', 'tts'],
        /* M1-B：设备身份 + 移动边界。mobile 面**只有** allowlist 里的 verb。 */
        deviceAuth: { scheme: 'per-device opaque token', storedAs: 'sha256', constantTimeCompare: true, revoke: 'immediate' },
        mobile: gateway ? {
          namespace: '/mobile/v1',
          protocolVersion: gateway.PROTOCOL_VERSION,
          transport: 'http+text/event-stream',
          verbs: ['pairing.complete', 'handshake', 'device.self', 'device.token.rotate', 'device.revoke', 'device.rename',
            'presence', 'presence.report', 'character.list', 'character.get', 'chat.history', 'chat.send', 'chat.retry',
            'chat.stream', 'sync.changes'],
          adminPaths: gateway.ADMIN_PATHS,
          unreachable: ['/api/llm-proxy', 'submit_payment', 'pay_register_checkout', 'pay_set_config', 'webhook', 'tool catalog', 'bridge resident chat']
        } : null
      }, req);
      return;
    }

    /* ── P22-2 · Agent Economy（**只读**观测面）──────────────────────────
       本阶段刻意只加"看"的路由。逐条说明为什么：

         · **没有** POST /economy/*。铸造（mintForSystem）、销毁
           （burnForSystem）、提交交易（commitLedgerTransaction）都是 store
           的内部 API，只对同进程调用方开放 —— 因此"通过 HTTP 凭空造钱"
           这条路在**路由表**上就不存在，而不是靠一个 if 挡着。
         · **没有** /economy/topup · /purchase · /payment · /provider。
           本文件的 doesNotExpose 一直写着 'payments'，而一个叫 economy 的
           命名空间最容易让人以为"这里能充值"，所以这条不只是省略：
           /security 的 economyPolicy.unreachable 把它写成了**可断言的字段**。
         · 读到的余额来自 `store.health()` / `getWallet()`，而状态是**三态**：
           COLD / DEGRADED 时 availableBalanceMinor 是 null，绝不是 0。
           这条在 HTTP 层不需要任何特判 —— store 自己就那么回答，而这一层
           若把 null 兜成 0 就会把 R5 重新引进来，因此这里原样透传。

       授权模型刻意与 /memory/ · /moments/ 逐字相同（见上面的
       isDesktopOnlyPath）：远端未配置桌面 token → 403；配了 token → 401/放行。
       **不给 /economy/* 任何 loopback 豁免例外**：它承载的是这个世界的
       经济事实，与记忆同级。 */
    if (path === '/economy/health' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      ok(res, { economy: economy.health() }, req);
      return;
    }
    if (path === '/economy/wallet' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const ownerId = url.searchParams.get('ownerId');
      const walletId = url.searchParams.get('walletId');
      const currency = url.searchParams.get('currency') || undefined;
      if (!ownerId && !walletId) { bad(res, 400, 'missing-wallet-or-owner', null, req); return; }
      let result;
      try {
        result = economy.getWallet({
          walletId: walletId || undefined,
          ownerId: ownerId || undefined,
          currency: currency,
          /* `rebuild=1` 会**从 ledger 重算**再回答，并在缓存漂移时修好它。
             默认不重算（读路径要便宜），但这条参数让"余额可被完整重建"
             变成一个可以被真实请求验证的性质。 */
          rebuild: url.searchParams.get('rebuild') === '1'
        });
      } catch (error) {
        storeError(res, error.code || 'economy-read-failed', { reason: String(error && error.message) }, req, 400);
        return;
      }
      if (!result.ok) { bad(res, 404, result.errors[0] || 'wallet-not-found', null, req); return; }
      ok(res, { wallet: economy.serializeWallet(result.wallet, { rebuild: result.rebuilt }) }, req);
      return;
    }
    if (path === '/economy/wallets' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const wallets = economy.listWallets({
        ownerId: url.searchParams.get('ownerId') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      ok(res, { wallets: wallets.map(w => economy.serializeWallet(w, {})) }, req);
      return;
    }
    if (path === '/economy/ledger' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const transactionId = url.searchParams.get('transactionId');
      const accountId = url.searchParams.get('accountId');
      if (!transactionId && !accountId) { bad(res, 400, 'missing-transaction-or-account', null, req); return; }
      const result = economy.listLedgerEntries({
        transactionId: transactionId || undefined,
        accountId: accountId || undefined,
        currency: url.searchParams.get('currency') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'ledger-read-failed', null, req); return; }
      ok(res, {
        entries: result.entries.map(e => Object.assign({}, e, {
          amountMinor: economy.contract.serializeAmountMinor(e.amountMinor)
        })),
        topology: result.topology,
        /* scope 让 topology 的含义没有歧义：账户维度天然是单边的
           （另一侧记在对手方账户上），那里 balanced=false 不代表账本坏了。
           一笔交易的两端是否平衡，看 /economy/transaction 返回的那几笔 entry。 */
        scope: result.scope
      }, req);
      return;
    }
    if (path === '/economy/transaction' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const transactionId = url.searchParams.get('transactionId');
      if (!transactionId) { bad(res, 400, 'missing-transaction', null, req); return; }
      const result = economy.getTransaction(transactionId);
      if (!result.ok) { bad(res, 404, result.errors[0] || 'transaction-not-found', null, req); return; }
      const serialize = economy.contract.serializeAmountMinor;
      ok(res, {
        transaction: result.transaction,
        entries: result.entries.map(e => Object.assign({}, e, { amountMinor: serialize(e.amountMinor) }))
      }, req);
      return;
    }
    if (path === '/economy/changes' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const changes = economy.listChanges(url.searchParams.get('cursor') || 0, url.searchParams.get('limit') || undefined);
      ok(res, { changes: changes, revision: economy.getRevision() }, req);
      return;
    }
    /* ── P22-3 · reservation 的两条**只读**路由 ─────────────────────────
       为什么这一阶段加了"预留"却仍然一个字都不给写：
       预留的语义是"先锁住资源、之后要么成交要么还回去"，而**谁有权
       决定成交**（预算策略 / 用户审批 / 动作结果）属于 P22-4 与 P22-8。
       在那些层存在之前把 reserve / commit / release 挂到 HTTP 上，
       等于让任何一个能发请求的人替 Agent 决定花钱 —— 那正是 P22 §6
       要避免的"LLM 说想要就通过"。因此这里只开"看"：
         GET /economy/reservations   列出（可按 walletId / ownerId / status 过滤）
         GET /economy/reservation    单笔（按 reservationId 或 operationId）
       金额一律十进制字符串（与 /wallet 同款），并且**不带 idempotencyKey**
       —— 请求标识没有必要被广播。 */
    if (path === '/economy/reservations' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listReservations({
        walletId: url.searchParams.get('walletId') || undefined,
        ownerId: url.searchParams.get('ownerId') || undefined,
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'reservation-read-failed', null, req); return; }
      ok(res, {
        reservations: result.reservations.map(r => economy.serializeReservation(r)),
        scope: result.scope,
        /* 这个计数是"此刻有几笔钱被锁住"的直接答案，也是
           "active reservations 不超过 ledger" 那条不变量的观测入口。 */
        activeReservations: result.reservations.filter(r => r.state === 'ACTIVE').length
      }, req);
      return;
    }
    if (path === '/economy/reservation' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const reservationId = url.searchParams.get('reservationId');
      const operationId = url.searchParams.get('operationId');
      if (!reservationId && !operationId) { bad(res, 400, 'missing-reservation-or-operation', null, req); return; }
      const result = economy.getReservation({
        reservationId: reservationId || undefined,
        operationId: operationId || undefined
      });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'reservation-not-found', null, req); return; }
      ok(res, { reservation: economy.serializeReservation(result.reservation) }, req);
      return;
    }

    /* ── P22-4 · 预算政策（**只读**）与报价（**只读**）────────────────
       本阶段新增两类东西：**规则**（预算政策）与**价格命题**（报价）。
       两者都有会改状态的 store 方法（putBudgetPolicy / expirePolicy /
       expireDuePolicies / createQuote / expireQuote / expireDueQuotes），
       而它们在路由表上**一个都不存在**。理由与 P22-3 逐字相同、并且更强：
         · 改预算规则是**权限**问题（"谁有权替一个角色决定它一天能花
           多少"），而本仓库还没有任何权限模型；在没有它之前开放一个
           POST，等于让任何一个能发请求的人改所有人的花钱规则；
         · 创建报价是**定价**问题（"这个价格是谁定的"），而定价属于
           P22-5 的商品目录。
       因此这里只开"看"：
         GET /economy/policies     列出预算政策
         GET /economy/policy       单条（policyId 或 ownerId）
         GET /economy/quotes       列出一份报价集合
         GET /economy/quote        单份（quoteId）
         GET /economy/budget       对给定 ownerId/currency/amountMinor 做一次
                                   **快照评估**（纯读；不 reserve、不消费）
       报价的读取面刻意**不含** idempotencyKey（与 reservation 同款）。 */
    if (path === '/economy/policies' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listBudgetPolicies({
        ownerId: url.searchParams.get('ownerId') || undefined,
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'policy-read-failed', null, req); return; }
      ok(res, {
        policies: result.policies.map(p => economy.serializeBudgetPolicy(p)),
        /* 一句可被机器读到的声明：预算评估不是许可。 */
        evaluationIsNotASpendPermit: true
      }, req);
      return;
    }
    if (path === '/economy/policy' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const policyId = url.searchParams.get('policyId');
      const ownerId = url.searchParams.get('ownerId');
      if (!policyId && !ownerId) { bad(res, 400, 'missing-policy-or-owner', null, req); return; }
      const result = economy.getBudgetPolicy({ policyId: policyId || undefined, ownerId: ownerId || undefined });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'budget-policy-not-found', null, req); return; }
      ok(res, { policy: economy.serializeBudgetPolicy(result.policy) }, req);
      return;
    }
    if (path === '/economy/budget' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const ownerId = url.searchParams.get('ownerId');
      const currency = url.searchParams.get('currency') || 'IB_CREDIT';
      const amountMinor = url.searchParams.get('amountMinor');
      if (!ownerId || amountMinor == null) { bad(res, 400, 'missing-owner-or-amount', null, req); return; }
      const result = economy.evaluateBudgetFor({
        ownerId: ownerId, currency: currency, amountMinor: amountMinor,
        now: url.searchParams.get('now') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'budget-evaluation-failed', null, req); return; }
      /* 决策本身是 200：DENY 是一个**结论**，不是一次 HTTP 失败。
         真正的读错误（库没开、id 不合法）在上面那条 400 里。 */
      ok(res, {
        decision: result.decision,
        snapshot: economy.serializeBudgetSnapshot(result.snapshot),
        evaluatedOnly: result.evaluatedOnly === true,
        notASpendPermit: result.notASpendPermit,
        /* 这一层从不 reserve：显式写出来，免得下游把 ALLOW 读成"钱已锁"。 */
        reserved: false
      }, req);
      return;
    }
    if (path === '/economy/quotes' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const buyerId = url.searchParams.get('buyerId') || url.searchParams.get('ownerId') || undefined;
      const state = url.searchParams.get('state') || undefined;
      const result = economy.listQuotes({
        buyerId: buyerId, state: state, limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'quote-read-failed', null, req); return; }
      ok(res, {
        quotes: result.quotes.map(q => economy.serializeQuote(q)),
        /* 报价不锁任何东西 —— 这句话是可断言的，不是修辞。 */
        locksFunds: false
      }, req);
      return;
    }
    if (path === '/economy/quote' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const quoteId = url.searchParams.get('quoteId');
      if (!quoteId) { bad(res, 400, 'missing-quote-id', null, req); return; }
      /* evaluate=1 会**额外**做一次预算评估，但仍然什么都不改：
         "评估一份报价"与"接受一份报价"是两件事（§18）。 */
      if (url.searchParams.get('evaluate') === '1') {
        const evaluated = economy.evaluateQuote({
          quoteId: quoteId, now: url.searchParams.get('now') || undefined
        });
        if (!evaluated.ok) { bad(res, 404, evaluated.errors[0] || 'quote-not-found', null, req); return; }
        ok(res, {
          quote: evaluated.quote,
          walletSnapshot: evaluated.walletSnapshot,
          budgetSnapshot: evaluated.budgetSnapshot,
          decision: evaluated.decision,
          reasonCode: evaluated.reasonCode,
          evaluatedOnly: evaluated.evaluatedOnly === true,
          reserved: false,
          consumed: false,
          notASpendPermit: evaluated.notASpendPermit
        }, req);
        return;
      }
      const result = economy.getQuote({ quoteId: quoteId });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'quote-not-found', null, req); return; }
      ok(res, { quote: economy.serializeQuote(result.quote) }, req);
      return;
    }
    /* 其余 /economy/* 一律 404 —— 尤其 POST 到上面任何一条路径。
       显式放在这里而不是靠"没匹配上就落到通用 404"，是为了让
       "写入口不存在"这件事有一个**有意为之**的分支。 */
    if (path.indexOf('/economy/') === 0) {
      record('warn', 'economy-unsupported', { path: path, method: method, loopback: isLoopback(req) });
      bad(res, method === 'GET' ? 404 : 405, method === 'GET' ? 'unknown-economy-path' : 'economy-is-read-only',
        method === 'GET' ? null : { hint: 'the economy HTTP surface exposes reads only' }, req);
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
      if (!result.ok) { storeError(res, result.error, null, req, 400); return; }
      ok(res, result, req);
      return;
    }
    if (path === '/changes' && method === 'GET') {
      const cursor = url.searchParams.get('cursor');
      const result = store.changesAfter(cursor == null ? 0 : Number(cursor), { limit: url.searchParams.get('limit') || undefined });
      if (!result.ok) { storeError(res, result.error, null, req, 400); return; }
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
      const existingPolicy = payload.existingPolicy === 'skip' ? 'skip' : 'overwrite';
      const result = batch.length === 1 && !payload.forceBatch
        ? store.putMessage(batch[0], { requestId: requestId, existingPolicy: existingPolicy })
        : store.putMessages(batch, { requestId: requestId, existingPolicy: existingPolicy });
      if (!result.ok) {
        record('warn', 'put-rejected', { error: result.error, index: result.index, errors: result.errors });
        storeError(res, result.error, { index: result.index, errors: result.errors, id: result.id }, req,
          result.error === 'invalid-message' ? 422 : 400);
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
      if (!result.ok) { storeError(res, result.error, null, req, 400); return; }
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
      if (url.searchParams.get('backup') === '1') {
        const made = store.backup();
        if (!made.ok) { bad(res, 500, made.error || 'backup-failed', null, req); return; }
        record('info', 'backup', { bytes: made.bytes, revision: made.revision });
        ok(res, { integrity: store.integrityCheck(), meta: store.meta(), backup: { file: require('path').basename(made.file), bytes: made.bytes, revision: made.revision } }, req);
        return;
      }
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
    if (process.env.IB_HOME_NODE_TRACE === '1') {
      record('info', 'trace-in', { method: method, path: url.pathname, origin: String(req.headers.origin || ''), pna: String(req.headers['access-control-request-private-network'] || '') });
    }

    /* 跨域预检：先看是不是 mobile 面 —— mobile 有自己的 Origin 策略
       （capacitor://localhost / null / loopback），与桌面内部 API 的白名单不同。
       不先分流的话，移动端客户端的预检会拿到桌面策略的响应（不回显 Origin），
       浏览器就会拦掉后续请求，而服务端日志里看不出任何异常。 */
    if (method === 'OPTIONS' && gateway && typeof gateway.handles === 'function' && gateway.handles(url.pathname.replace(/\/+$/, '') || '/')) {
      return gateway.dispatch(url.pathname.replace(/\/+$/, '') || '/', req, res, url);
    }

    /* 跨域预检：只对允许的 Origin 放行，且只声明本服务真正实现的方法。 */
    if (method === 'OPTIONS') {
      const origin = String(req.headers.origin || '');
      const headers = { Vary: 'Origin' };
      if (originAllowed(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, X-IB-Home-Token, X-IB-Protocol, Authorization';
        headers['Access-Control-Max-Age'] = '600';
        /* Private Network Access（PNA）：Chrome 对「从 file:// 或公网 origin 发起、
           目标为 loopback/私网地址」的请求会先发一个带
           `Access-Control-Request-Private-Network: true` 的预检，并要求响应显式
           `Access-Control-Allow-Private-Network: true`，否则**整个请求在到达服务器前
           就被拦掉**（实测 corsError: PreflightMissingAllowOriginHeader /
           请求根本没有落到服务端日志里）。
           本产品第一类运行方式就是双击 InternalBeyond.html（file://）访问本机服务，
           所以这一项是必需的，不是可选加固。 */
        if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
          headers['Access-Control-Allow-Private-Network'] = 'true';
        }
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    /* ── 非 loopback 来源：整片拒绝，除非调用方证明 LAN 模式已就绪 ──────
       这一条在路由**之前**执行，因此覆盖 mobile 命名空间在内的每一个路径：
       "门没开"必须等于"什么都不到达"。`remoteAllowed()` 由装配层提供
       （services/home-node-service.js），它的定义是"显式非 loopback 绑定
       且设备鉴权已就绪"，本身 fail-closed。 */
    const remote = !isLoopback(req);
    if (remote && !remoteAllowed()) {
      record('warn', 'rejected-non-loopback', {
        remote: String((req.socket && req.socket.remoteAddress) || ''),
        path: url.pathname
      });
      bad(res, 403, 'loopback-only', null, req);
      return;
    }

    Promise.resolve()
      .then(() => route(req, res, url, method, remote))
      .catch(error => {
        /* P11-3X-B：数据库失败要带**类别**回答，而不是一句 internal-error。
           调用方（桌面镜像同步、手机网关、诊断页）靠这个类别决定是重试、报告
           还是走兼容回退；把它压成 500 就等于让每一个消费者各自去猜。
           类别是闭集里的稳定 id，**不含**驱动原文、SQL、路径或任何数据，因此可以
           安全地出现在响应体里。环境类（只读/权限/忙/满/打不开）是可重试的 503；
           损坏与 schema 过新是终态，回答 500。 */
        const reason = error && error.dbReason;
        record('error', 'unhandled', { path: url.pathname, dbReason: reason || null, error: String((error && error.message) || error).slice(0, 300) });
        if (!res.headersSent) {
          if (reason) {
            const terminal = reason === 'db-corrupt' || reason === 'db-schema-too-new' || reason === 'db-unavailable';
            bad(res, terminal ? 500 : 503, reason, null, req);
          } else {
            bad(res, 500, 'internal-error', null, req);
          }
        } else { try { res.end(); } catch (_) { /* 已断开 */ } }
      });
  });

  /* 单个请求的异常不得杀死常驻服务（与 active-message-service.js 同一纪律）。 */
  server.on('clientError', (error, socket) => {
    record('warn', 'client-error', { code: String((error && error.code) || '') });
    try { socket.destroy(); } catch (_) { /* 已销毁 */ }
  });

  return {
    server: server,
    record: record,
    logRing: logRing,
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    /* P11-3E：装配层用它把"这一层唯一一份 canonical store 失败分类"接到网关，
       以及让"同一份失败词表"可以被真实子进程断言，而不是靠读代码比对。 */
    resolveStoreFailure: resolveStoreFailure,
    createStoreFailureProbe: createStoreFailureProbe,
    storeFailures: storeFailures,
    healthFailure: healthFailure
  };
}

module.exports = createHomeNodeHttp;
module.exports.PROTOCOL_VERSION = PROTOCOL_VERSION;
module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;

/* ── The ONE implementation of "why can't this canonical store serve"? ────
 *
 * Module-level (not a closure inside the HTTP factory) because TWO layers need the
 * same answer and only one of them owns an HTTP server:
 *
 *   · http.js itself, for `/health` / `/status` / status codes;
 *   · the assembly layer, which is the only place that knows how a store's `open()`
 *     actually failed.
 *
 * The alternative — letting the service keep its own copy of this classification —
 * is exactly the "same fact, two answers" defect P11-3E exists to remove. The
 * classifier is still INJECTED (`classifyFailure` / `isDatabaseError` come from
 * runtime/db-failure.js, the single source) rather than required here, so this
 * module keeps its zero-dependency load surface.
 *
 * A category this function cannot name stays `store-closed`: a programming bug
 * thrown while opening a store must not be dressed up as a disk problem. */
function createStoreFailureProbe(spec, deps) {
  const config = spec || {};
  const helpers = deps || {};
  if (!config.store || !config.name) return null;
  const name = String(config.name);
  const role = String(config.role || '');
  const isDbError = typeof helpers.isDatabaseError === 'function' ? helpers.isDatabaseError : null;
  const classifyFailure = typeof helpers.classifyFailure === 'function' ? helpers.classifyFailure : null;
  return function probe() {
    if (typeof config.store.isOpen === 'function' && config.store.isOpen()) return null;
    const error = typeof config.lastError === 'function' ? config.lastError() : null;
    let category = 'store-closed';
    let message = 'the canonical ' + name + ' store is not open, so this node cannot serve its role';
    if (error && isDbError && isDbError(error) && classifyFailure) {
      const classified = classifyFailure(error);
      if (classified && classified.reason) {
        category = classified.reason;
        message = 'the canonical ' + name + ' store could not be opened (' + category + ')';
      }
    }
    return { store: name, role: role, category: category, message: message };
  };
}
module.exports.createStoreFailureProbe = createStoreFailureProbe;
