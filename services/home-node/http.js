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
/* P22-25 · 目录种子的**只读**描述（商品 id → 图片 key）。
   ★ 这里拿到的不是写能力：本文件导入它的**唯一**用途是把一个既有的
     asset key 变成 URL（见 withCatalogImage），而它导出的 `apply` 在
     本文件里零调用 —— P22-21 §9 的 T5 仍然逐字成立（http.js 的代码里
     `putStore` / `putProduct` 零调用形态）。
   ★ 它同时是一道载入期硬门：种子里若有图片引用了不存在的仓库文件，
     这个 require 会抛（见 catalog-bootstrap.js 的 missingSeedAssets）。 */
const catalogBootstrap = require('./catalog-bootstrap.js');
/* P11-3H：停止面的路径常量（唯一来源，不在这里再写一遍字面量）。 */
const serviceControl = require('../../runtime/service-control.js');
/* P32：Tauri 2 的 bundled WebView 使用 tauri.localhost；它仍然是本机
   应用来源，不应被误判成一个 LAN/公网 Origin。 */
const { isTauriOrigin } = require('../../runtime/host-origin.js');

const PROTOCOL_VERSION = 1;
/* P22-23 · 首次运行凭据交付面的**契约常量**（路径 + 请求头）。
   放在模块作用域而不是工厂内部，是因为它们是契约而不是实例状态：
   module.exports 下面要把它们交出去，客户端与测试都从这里取，
   因此"这条路径叫什么"全仓只有一份字面量。 */
const DESKTOP_CREDENTIAL_PATH = '/internal/desktop-credential';
/* P21-R4-PROD-1 · 认知控制面的**唯一**变更/读取路径（窄 route）。
   ★ 它落在 `/internal/` 前缀下 ⇒ 自动继承 isDesktopOnlyPath（远端未配置桌面
     token → 403）、桌面 token 判定与 loopback 语义，一行豁免都不加。 */
const COGNITIVE_POLICY_PATH = '/internal/runtime/cognitive-policy';
const DESKTOP_CREDENTIAL_HEADER = 'x-ib-bootstrap';
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

/* ── P22-25 · 目录图片引用（**唯一**取值点）─────────────────────────────
   图片生命周期：
     仓库代码资产 → Catalog seed（image key）→ Product image reference → UI
   而 store 的序列化视图里**没有**这一列，因为商品行不知道也不该知道
   "哪张图配它好看"：那个事实是**种子**的一部分，而种子住在
   catalog-bootstrap.js。于是这一层只做一次纯映射，绝不落库、绝不生成图、
   绝不接受调用方给的图片值 —— `productId` 是唯一的输入，因此一件用户
   或 Agent 造出来的商品拿到的是 `image: null`（诚实：它没有配图），
   而不是一个猜出来的默认图。

   三个值的字形是**结构性**的（catalog-bootstrap.assetKeyIsCanonical）：
      · `image`        = 'catalog/<name>.webp'   ← 只保存 asset key
      · `imageUrl`     = '/assets/economy/catalog/<name>.webp'
      · 非种子商品      = null（两个都是）
   字符串里没有 `:`，因此不可能是 data URL；没有 scheme，因此不可能是
   任何 provider 的临时链接；只有 [a-z0-9-]，因此不可能是 base64。 */
function withCatalogImage(payload) {
  if (!payload || payload.productId == null) return payload;
  return Object.assign({}, payload, {
    image: catalogBootstrap.imageKeyFor(payload.productId),
    imageUrl: catalogBootstrap.imageUrlFor(payload.productId)
  });
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
  /* ── P22-11 · Economy Command Channel（23114 → 23118 的唯一 command 面）──
     ★ 这里拿到的是一个**通道**，不是 store、不是门、不是适配器模块：
       `economyCommand` 的公开面只有 { path, commands, dispatch, audit,
       describe }，适配器在它内部，而 store 与门**根本不在**这条依赖里。
       因此"handler 变成新的 Economy authority"在结构上不可能 —— 本文件
       没有任何一行能派发到 store 的动词上。
     ★ 不注入时（分解装配、只看读面的测试、未配置通道的部署）这一整条
       分支**不存在**，行为与 P22-10 逐字一致。 */
  const economyCommand = deps.economyCommand || null;
  /* ── P22-13 · Economy Approval Decision Seam（用户的点头 / 摇头）────────
     ★ 与上面一行同款：这里拿到的**不是** store、不是门、不是适配器，而是
       一个窄对象（公开面只有 { path, dispatch, describe, audit }）。
       用户的决定由它自己判定与记录，本文件只负责"把请求送到它那里、
       把它的信封原样发出去"。
     ★ 它为什么可以上 HTTP，而门与适配器不能：它不判断任何经济事实
       （价格 / 预算 / 自主性 / 商品），它只是把一次**已认证的用户决定**
       写成一条 canonical 批准，然后把同一条 intent 交回 P22-8。
     ★ 不注入时（分解装配、只看读面的测试）这一整条分支**不存在**。 */
  const economyApprovalDecision = deps.economyApprovalDecision || null;
  /* ── P22-14 · Economy Configuration Seam（fresh install 的配置入口）────
     ★ 与上面两行同款：这里拿到的**不是** store、不是门、不是适配器，而是
       一个窄对象（公开面只有 { path, commands, dispatch, describe, audit }）。
       ★ 它为什么可以上 HTTP，而 store 的铸币原语不能：它不是通用 mutation
         入口 —— 它的命令词表**封闭三词**（BOOTSTRAP_CREDIT /
         PUT_BUDGET_POLICY / PUT_AUTONOMY_POLICY），而"初始额度恰好一次"
         由 store 的 canonical 事实持有，不由路由层"记得检查"。
       ★ 不注入时（分解装配、只看读面的测试）这一整条分支**不存在**。 */
  const economyConfiguration = deps.economyConfiguration || null;
  /* ── P21-R4-LIVE-2.1 · Runtime Interpretation（**运行时**解释边界）──────
     ★ 这里拿到的**不是** provider、不是凭据、不是 memory store：服务自己的
       依赖（registry / credentialAccess / modelPort / costPolicy）在装配层
       （services/home-node-service.js）注入，本层只拿到一个窄对象
       （公开面只有 { path, operations, describe, run }）。因此"HTTP 层变成
       第二个 provider 调用方"在结构上不可能 —— 本文件没有任何一行能发起
       一次模型调用，也没有任何一行能读 Vault。
     ★ 不注入时（分解装配、只看读面的测试、未接解释面的部署）这整条分支
       **不存在**，行为与本阶段之前逐字一致。
     ★ 本层**不**决定"这条路开不开"：付费闸门的唯一解释在服务的 costPolicy
       里，而唯一的启用入口是装配层传进来的 options.runtimeInterpretationPolicy。
       本文件不读任何 env、不写任何默认值（frozen：本阶段没有生产启用路径）。 */
  const runtimeInterpretation = deps.runtimeInterpretation || null;
  /* ── P21-R4-LIVE-3.3 · Runtime Recall（**运行时**召回边界）──────────────
     ★ 与上面那一行同款：拿到的是**服务窄对象**（{ path, operations, run,
       describe }），不是 memory store、不是召回器、不是 provider。"这一轮
       想起什么"仍然只有一份实现（services/home-node/memory-retrieval.js +
       共享可见性核），本文件一行都碰不到它。
     ★ 不注入时整条分支**不存在**：行为与接线前逐字一致。
     ★ 它与解释边界同级：同样在桌面凭据判定**之后**，同样没有
       isEconomyCommandPath 式豁免。 */
  const runtimeRecall = deps.runtimeRecall || null;
  /* P21-R4-PROD-1 · 认知控制面（产品级读写边界）。
     ★ 它**不是**第二份 policy 权威：持久化仍然只有 runtime-policy.js 一份
       （见 home-node-service.js 的装配）。本层只做状态矩阵与窄投影。
     ★ 不注入时整条分支不存在（与其它运行时面同款）。 */
  const runtimeCognitivePolicy = deps.runtimeCognitivePolicy || null;
  const executor = deps.executor || null;
  const gateway = deps.gateway || null;
  const clock = deps.clock || (() => Date.now());
  const token = String(deps.token || '');
  const version = String(deps.version || '0.0.0');
  const allowedOrigins = Array.isArray(deps.allowedOrigins) ? deps.allowedOrigins.map(String) : [];
  const logger = deps.logger || (() => {});
  /* ── P22-23 · 凭据来源与首次运行交付面 ──────────────────────────────
     `token` 是"这台节点接受什么凭据"；下面两个字段回答的是另外两个问题：
       · desktopCredentialSource —— 它是从哪来的（env / file / generated / null）。
         这决定 bootstrap 交付面**开不开**：env 显式配置的部署代表"部署方已经
         决定了凭据"，此时再让浏览器取一份就是在制造第二个来源。
       · desktopCredentialAutoProvision —— 本进程是否允许自动 provisioning。
     两者都不是凭据本体，都可以安全地出现在 /security 里。 */
  const credentialSource = deps.desktopCredentialSource === undefined
    ? null : (deps.desktopCredentialSource == null ? null : String(deps.desktopCredentialSource));
  const credentialAutoProvision = deps.desktopCredentialAutoProvision === true;
  /* bootstrap 交付面的诊断计数。**不是**闸门 —— 见上面"为什么没有一次性
     限制"。它只回答"这条面被用过没有、用了几次"，让诊断页与日志能说明白
     这台机器上到底发生过什么。 */
  let bootstrapHandoutCount = 0;
  let bootstrapLastHandoutAt = null;
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
    if (isTauriOrigin(value)) return true;           /* Tauri 2 bundled WebView */
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
     P11-3A 收紧了上面那一段"零门槛"的适用范围：凭据铸造面不再包含在内。
     ── P22-11：为什么 command 路径**不**走这条判定 ─────────────────────
     `/internal/economy/command` 的凭据是**来源凭据**（每个来源自己的
     token，恒定时间比较 + 管道登记 + loopback），它是另一套东西：
       · 桌面 token 回答的是"你有没有这台机器的桌面凭据"——它对 23114 与
         对任何本机进程是**同一个答案**，因此它确定不了来源身份；
       · 要求两者同时出示只会让 Active 也拿到桌面 token —— 那既没有更多
         保护，又把两套凭据的边界糊在一起。
     ⇒ 这里把它排除在这条判定之外，而不是"给它一个豁免"：它的准入完全
     由 economyCommand.dispatch 内部完成（fail closed），而**读**面
     （/economy/*）与桌面面的一切仍然逐字按既有规则。 */
  function isEconomyCommandPath(path) {
    return !!economyCommand && path === economyCommand.path;
  }
  /* ── P22-13 · 用户决定面的来源信息 ──────────────────────────────────
     ★ 与 economyCommandRequestInfo 同款，但**故意是两个函数**：它们带的是
       两种不同的凭据（来源 token vs 桌面 token），而"一个函数同时回答
       两套凭据"正是两套身份边界要被糊掉的地方。
     ★ 本文件仍然**不判定**：它把三个原始事实（是不是 loopback、请求头里的
       凭据、来源地址）交给 seam，判定与拒绝信封由 seam 唯一给出 ——
       与 P22-11 那条命令路径逐字同源。 */
  function economyApprovalDecisionRequestInfo(req) {
    const headerToken = String(req.headers['x-ib-home-token'] || '');
    const auth = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(.+)$/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
    return {
      loopback: isLoopback(req),
      remoteAddress: String((req.socket && req.socket.remoteAddress) || ''),
      desktopCredential: headerToken || bearer
    };
  }
  async function handleEconomyApprovalDecision(req, res) {
    let body = null;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      const code = (error && error.code) || 'read-error';
      record('warn', 'economy-approval-decision-unreadable', { code: code, loopback: isLoopback(req) });
      /* ★ 读不出来也走**同一个**拒绝信封（seam 自己给的），而不是本文件
         临时拼一个 —— 与 handleEconomyCommand 逐字同源。 */
      const refused = economyApprovalDecision.dispatch(economyApprovalDecisionRequestInfo(req), null);
      bad(res, code === 'too-large' ? 413 : 400, refused.reasonCode, {
        dispatched: false,
        unreadableBody: code
      }, req);
      return;
    }
    const decision = economyApprovalDecision.dispatch(economyApprovalDecisionRequestInfo(req), body);
    record(decision.ok === true ? 'info' : 'warn', 'economy-approval-decision', {
      /* ★ 审计只记这五样：批准 id、决定词、结果、续做的归类、linkage。
         凭据**绝不**进来（源头就不在 decision 里），决定者身份只记
         canonical 的 'user:user'。 */
      approvalId: decision.approvalId || null,
      decision: decision.decision || null,
      decider: decision.decider || null,
      outcome: decision.ok === true ? 'accepted' : String(decision.reasonCode || 'refused'),
      continuation: decision.continuation || null,
      linkage: (decision.continuationResult && decision.continuationResult.intentId) || null,
      /* 通道层自述：传输不是权威（跟着**每一次**判定一起落审计）。 */
      transportIsNotAnEconomyAuthority: true
    });
    sendJson(res, decision.status || 400, decision, req);
  }

  /* ── P22-14 · 配置面的来源信息 ──────────────────────────────────────
     ★ 与 economyApprovalDecisionRequestInfo **逐字同形**，但它是一个独立
       的函数：两条路径各自回答一次"调用者是谁"，而不是共用一个入口。
     ★ 本文件仍然**不判定**：它把三个原始事实（是不是 loopback、请求头里的
       凭据、来源地址）交给 seam，判定与拒绝信封由 seam 唯一给出。 */
  function economyConfigurationRequestInfo(req) {
    const headerToken = String(req.headers['x-ib-home-token'] || '');
    const auth = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+(.+)$/i.test(auth) ? auth.replace(/^Bearer\s+/i, '') : '';
    return {
      loopback: isLoopback(req),
      remoteAddress: String((req.socket && req.socket.remoteAddress) || ''),
      desktopCredential: headerToken || bearer
    };
  }
  async function handleEconomyConfiguration(req, res) {
    let body = null;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      const code = (error && error.code) || 'read-error';
      record('warn', 'economy-configuration-unreadable', { code: code, loopback: isLoopback(req) });
      /* ★ 读不出来也走**同一个**拒绝信封（seam 自己给的）——
         与两条既有写路径逐字同源。 */
      const refused = economyConfiguration.dispatch(economyConfigurationRequestInfo(req), null);
      bad(res, code === 'too-large' ? 413 : 400, refused.reasonCode, {
        dispatched: false,
        unreadableBody: code
      }, req);
      return;
    }
    const configured = economyConfiguration.dispatch(economyConfigurationRequestInfo(req), body);
    record(configured.ok === true ? 'info' : 'warn', 'economy-configuration', {
      /* ★ 审计只记这六样：命令词、配置目标、结果、下游原因码、有没有真的
         铸出钱。凭据**绝不**进来（源头就不在 configured 里）。 */
      command: configured.command || null,
      ownerId: configured.ownerId || null,
      outcome: configured.ok === true ? 'accepted' : String(configured.reasonCode || 'refused'),
      downstreamReasonCode: configured.downstreamReasonCode || null,
      creditMinted: configured.creditMinted === true,
      transportIsNotAnEconomyAuthority: true
    });
    sendJson(res, configured.status || 400, configured, req);
  }

  /* ── P21-R4-LIVE-2.1 · Runtime Interpretation 的**传输面** ──────────────
     ★ 本文件在这里只做四件事：有界读体 → 把请求的生命周期桥成 AbortSignal
       → 把 body 原样交给服务 → 把服务给的信封原样发出。**不解释**意图、
       **不选**角色、**不碰**凭据、**不判断**钱：那四件事分别在服务的
       registry 解析、credentialAccess、modelPort 与 costPolicy 里各有一份
       唯一实现（与 P22-11 / P22-13 / P22-14 三条 seam 同一条纪律）。
     ★ 审计只记**结构化元数据**（与文件头第 4 条一致）：operation /
       characterId / outcome / status / attempts / providerCalls / vaultReads /
       durationMs。正文、prompt、凭据**绝不**进来 —— 解释结果里可能有内容，
       而内容只存在于响应体里，不进日志环。 */
  function runtimeOperationName() {
    /* 操作名从服务自己的 operations 里取，本文件**不**再抄一份字面量：
       审计里的 operation 必须与路由认的那一份同源。 */
    const ops = runtimeInterpretation && Array.isArray(runtimeInterpretation.operations)
      ? runtimeInterpretation.operations : [];
    return ops.length ? String(ops[0]) : null;
  }
  /* 计数一律原样透传：0 是**有意义**的值（"一次 provider 都没调"），
     因此不能用 `|| null` 抹掉它；只有真读不到时才是 null。 */
  function metricOrNull(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  async function handleRuntimeInterpretation(req, res) {
    let body = null;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      const code = (error && error.code) || 'read-error';
      record('warn', 'runtime-interpretation-unreadable', {
        operation: runtimeOperationName(), outcome: 'refused', reasonCode: code, loopback: isLoopback(req)
      });
      /* 与既有 POST 写路径（/messages）**逐字同一条**读体纪律：太大是 413，
         其余（坏 JSON / 读错误）是 400。刻意不发明新词 —— 同一种失败在本
         文件里必须读出同一个样子。服务还没看到这个请求，因此任何"服务给出
         的理由"此刻都不存在，这里也不假装有。 */
      bad(res, code === 'too-large' ? 413 : 400, code || 'bad-body', { unreadableBody: code }, req);
      return;
    }
    /* 调用方断开 ⇒ 把取消**转发**给这次运行。**必须**桥接：一次 run 会花真实
       的 provider 预算，而"调用方已经走了"不该继续烧钱。两个事件都要听
       （缺一个就有一半的断线场景继续烧钱）：
         · req 'aborted' —— 请求体还没读完就断了；
         · res 'close'   —— 响应写不出去（读完之后客户端消失）。
       ★ 诚实边界：这条接线**只**转发取消信号，不宣称更多 —— 客户端断开
         并不能证明上游 provider 的执行已经停止（SERVER_EXECUTION_MAY_CONTINUE
         AFTER_CLIENT_DISCONNECT 不因这次转发而被推翻）。服务侧据此把
         attempts 记为 0 / 不记 providerCalls，那是它对"端口有没有真的被调用"
         的自述，而不是"世界已经安全"的证明。
       ★ 成对摘除，而且在**写响应之前**先摘一次：响应正常结束时的 'close'
         不该被读成本次运行的取消；finally 里再摘一次是幂等兜底（run 抛错时
         也一定摘掉），否则每个请求都会往这两个 EventEmitter 上留一个永不释放
         的监听器（长跑进程里的真实泄漏）。 */
    const controller = new AbortController();
    const onDisconnected = () => { try { controller.abort(); } catch (_) { /* 已中止 */ } };
    const detachDisconnect = () => {
      req.removeListener('aborted', onDisconnected);
      res.removeListener('close', onDisconnected);
    };
    req.on('aborted', onDisconnected);
    res.on('close', onDisconnected);
    const startedAtMs = clock();
    try {
      const result = await runtimeInterpretation.run(body, { signal: controller.signal });
      /* 服务承诺"永不抛、总是回信封"（冻结接口）。这一行不是为了兜住它，
         而是为了让**传输层**在任何情况下都不发出一个非信封的响应体：
         契约被破坏时给一个诚实的 500，而不是 JSON `null`。 */
      if (!result || typeof result !== 'object') {
        record('error', 'runtime-interpretation-envelope-missing', { operation: runtimeOperationName() });
        bad(res, 500, 'runtime-interpretation-failed', { durable: false }, req);
        return;
      }
      detachDisconnect();
      const ok = result.ok === true;
      /* 三个计数是**服务的自述事实**（传输层无法自己知道它们），而冻结信封
         把它们放在 `boundary` 块里（cost / vault / attempt 的自述块）。
         这里先看 boundary、再看顶层：两种形状都认，但绝不由本层编一个数 ——
         读不到就是 null。 */
      const boundary = (result.boundary && typeof result.boundary === 'object') ? result.boundary : {};
      /* 服务自己量到的耗时优先（它知道工作真正在哪一刻开始/结束）；没有时
         用本层量到的墙上时间 —— 被成本闸门或角色解析提前拒绝的请求就落后者。 */
      const reportedDuration = result.durationMs != null
        ? result.durationMs
        : (result.model && typeof result.model === 'object' ? result.model.latencyMs : null);
      const durationMs = (reportedDuration == null || !Number.isFinite(Number(reportedDuration)))
        ? Math.max(0, clock() - startedAtMs) : Number(reportedDuration);
      record(ok ? 'info' : 'warn', 'runtime-interpretation', {
        operation: result.operation || runtimeOperationName(),
        characterId: result.characterId || null,
        outcome: ok ? 'accepted' : String(result.reasonCode || result.error || 'refused'),
        status: metricOrNull(result.status),
        attempts: metricOrNull(boundary.attempts != null ? boundary.attempts : result.attempts),
        providerCalls: metricOrNull(boundary.providerCalls != null ? boundary.providerCalls : result.providerCalls),
        vaultReads: metricOrNull(boundary.vaultReads != null ? boundary.vaultReads : result.vaultReads),
        durationMs: durationMs
      });
      sendJson(res, Number(result.status) || (ok ? 200 : 400), result, req);
    } finally {
      /* 幂等兜底：正常路径上面已经摘过一次，这里覆盖 run 抛错与提前 return。 */
      detachDisconnect();
    }
  }

  /* ── P21-R4-LIVE-3.3 · Runtime Recall 的**传输面** ──────────────────────
     ★ 与解释边界逐字同一条纪律：本文件只做四件事：有界读体 → 把请求的
       生命周期桥成 AbortSignal → 把 body 原样交给服务 → 把服务给的信封
       原样发出。**不选**记忆、**不算**分数、**不读** store、**不碰** provider：
       那些在既有召回实现里有唯一一份。
     ★ 审计只记**有界**字段：operation / characterId / outcome / status /
       selected / candidates / eligible / channel / chars / durationMs。
       `message`（本轮用户原文）**绝不**进日志环 —— 它是这条边界上最敏感的
       输入，而诊断只需要知道"选了几条、走了哪个通道"。 */
  function runtimeRecallOperation() {
    const ops = runtimeRecall && Array.isArray(runtimeRecall.operations) ? runtimeRecall.operations : [];
    return ops.length ? String(ops[0]) : null;
  }
  async function handleRuntimeRecall(req, res) {
    let body = null;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      const code = (error && error.code) || 'read-error';
      record('warn', 'runtime-recall-unreadable', {
        operation: runtimeRecallOperation(), outcome: 'refused', reasonCode: code, loopback: isLoopback(req)
      });
      /* 与 /messages 和解释路由**逐字同一条**读体纪律（同一种失败在本文件里
         必须读出同一个样子），服务此时还没看到这个请求。 */
      bad(res, code === 'too-large' ? 413 : 400, code || 'bad-body', { unreadableBody: code }, req);
      return;
    }
    /* 取消桥接：与解释边界同一份实现、同一条诚实边界 —— 只**转发**信号，
       不宣称上游已经停止（召回是本地同步读，根本没有上游可停）。 */
    const controller = new AbortController();
    const onDisconnected = () => { try { controller.abort(); } catch (_) { /* 已中止 */ } };
    const detachDisconnect = () => {
      req.removeListener('aborted', onDisconnected);
      res.removeListener('close', onDisconnected);
    };
    req.on('aborted', onDisconnected);
    res.on('close', onDisconnected);
    const startedAtMs = clock();
    try {
      const result = await runtimeRecall.run(body, { signal: controller.signal });
      /* 服务承诺"永不抛、总是回信封"（冻结契约）。这一行保证**传输层**在任何
         情况下都不发出一个非信封的响应体（契约被破坏时给诚实的 500）。 */
      if (!result || typeof result !== 'object') {
        record('error', 'runtime-recall-envelope-missing', { operation: runtimeRecallOperation() });
        bad(res, 500, 'runtime-recall-failed', { durable: false }, req);
        return;
      }
      detachDisconnect();
      const ok = result.ok === true;
      const counts = (result.counts && typeof result.counts === 'object') ? result.counts : {};
      record(ok ? 'info' : 'warn', 'runtime-recall', {
        operation: result.operation || runtimeRecallOperation(),
        characterId: result.characterId || null,
        outcome: ok ? 'accepted' : String(result.reasonCode || result.error || 'refused'),
        /* 计数原样透传：0 是有意义的值（"一条都没选"），不用 `|| null` 抹掉。 */
        status: metricOrNull(result.status),
        selected: metricOrNull(counts.selected),
        candidates: metricOrNull(counts.candidates),
        eligible: metricOrNull(counts.eligible),
        channel: result.channel == null ? null : String(result.channel),
        chars: metricOrNull(result.chars),
        durationMs: Math.max(0, clock() - startedAtMs)
      });
      sendJson(res, Number(result.status) || (ok ? 200 : 400), result, req);
    } finally {
      detachDisconnect();
    }
  }

  /* ── P21-R4-PROD-1 · 认知控制面（**唯一**的读取/变更面 · POST）─────────
     闭集请求（两个 operation）：
       { operation:'read', characterId }
       { operation:'set',  characterId, autoInterpretationEnabled, autoExpectationEnabled }
     ★ 浏览器提交的是**意图**，不是权威：这里没有 dataDir / 路径 / version /
       provider / credential / endpoint / memoryId / behaviorEffect / 成本权威
       任何一个键 —— 多一个自有键就是 request-field-forbidden。
     ★ 响应是**窄投影**：只有 characterId + 两个布尔 + source/reason/cost。
       绝不返回整份 policy 文件、其它角色、路径或凭据。
     ★ 非法状态（I=OFF,E=ON）在**权威层**被拒绝（不是靠 UI 拦），并给出
       具名 reasonCode；坏文件 ⇒ policy-file-unusable（绝不静默覆盖）。 */
  const COGNITIVE_READ_FIELDS = Object.freeze(['operation', 'characterId']);
  const COGNITIVE_SET_FIELDS = Object.freeze(['operation', 'characterId',
    'autoInterpretationEnabled', 'autoExpectationEnabled']);
  /* 本文件局部的小工具（与其它路由内联写法同源）：只做形状判断与有界回显。 */
  function isPlainObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function boundedString(value, limit) { return String(value == null ? '' : value).slice(0, limit || 80); }
  function cognitivePolicyProjection(operation, view) {
    const out = {
      ok: view.ok === true,
      operation: operation,
      characterId: view.characterId,
      autoInterpretationEnabled: view.autoInterpretationEnabled === true,
      autoExpectationEnabled: view.autoExpectationEnabled === true,
      source: isPlainObject(view.source) ? view.source : null,
      reasonCode: isPlainObject(view.reasonCode) ? view.reasonCode : null,
      readable: view.readable === true,
      authoritySource: view.authoritySource,
      mutationAuthority: view.mutationAuthority,
      scope: view.scope,
      browserDirectPolicyAuthority: 'NO',
      behaviorEffectIndependentPolicy: 'NONE',
      cost: view.cost
    };
    if (view.updatedAt !== undefined && view.updatedAt !== null) out.updatedAt = Number(view.updatedAt);
    return out;
  }
  async function handleRuntimeCognitivePolicy(req, res) {
    if (!runtimeCognitivePolicy) {
      bad(res, 503, 'cognitive-policy-not-assembled', null, req);
      return;
    }
    let body = null;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      const code = (error && error.code) || 'read-error';
      record('warn', 'cognitive-policy-unreadable', { outcome: 'refused', reasonCode: code, loopback: isLoopback(req) });
      bad(res, code === 'too-large' ? 413 : 400, code || 'bad-body', { unreadableBody: code }, req);
      return;
    }
    if (!isPlainObject(body)) {
      bad(res, 400, 'body-not-an-object', null, req);
      return;
    }
    const operation = typeof body.operation === 'string' ? body.operation.trim() : '';
    if (operation !== 'read' && operation !== 'set') {
      bad(res, 400, 'operation-not-allowed', { allowedOperations: ['read', 'set'] }, req);
      return;
    }
    const allowed = operation === 'read' ? COGNITIVE_READ_FIELDS : COGNITIVE_SET_FIELDS;
    for (const key of Object.keys(body)) {
      if (allowed.indexOf(key) < 0) {
        record('warn', 'cognitive-policy-field-forbidden', { operation: operation, field: key, loopback: isLoopback(req) });
        bad(res, 400, 'request-field-forbidden', { field: boundedString(key, 80), detail: 'request-is-a-closed-schema' }, req);
        return;
      }
    }
    const characterId = typeof body.characterId === 'string' ? body.characterId.trim() : '';
    if (!characterId || characterId.length > 180) {
      bad(res, 400, 'invalid-character-id', { detail: 'characterId-must-be-a-bounded-non-empty-string' }, req);
      return;
    }
    if (operation === 'read') {
      const view = runtimeCognitivePolicy.readCharacter(characterId);
      record('info', 'cognitive-policy-read', {
        characterId: characterId, readable: view.readable === true,
        interpretation: view.autoInterpretationEnabled === true,
        expectation: view.autoExpectationEnabled === true, loopback: isLoopback(req)
      });
      sendJson(res, 200, cognitivePolicyProjection('cognitive-policy-read', view), req);
      return;
    }
    const hasI = Object.prototype.hasOwnProperty.call(body, 'autoInterpretationEnabled');
    const hasE = Object.prototype.hasOwnProperty.call(body, 'autoExpectationEnabled');
    if (!hasI || !hasE) {
      bad(res, 400, 'invalid-value', {
        field: !hasI ? 'autoInterpretationEnabled' : 'autoExpectationEnabled',
        detail: 'set requires BOTH booleans (the legal-state matrix is validated as a pair)'
      }, req);
      return;
    }
    const view = runtimeCognitivePolicy.setCharacter(characterId, {
      autoInterpretationEnabled: body.autoInterpretationEnabled,
      autoExpectationEnabled: body.autoExpectationEnabled
    });
    if (view.ok === true) {
      record('info', 'cognitive-policy-updated', {
        characterId: characterId,
        interpretation: view.autoInterpretationEnabled === true,
        expectation: view.autoExpectationEnabled === true, loopback: isLoopback(req)
      });
      sendJson(res, 200, cognitivePolicyProjection('cognitive-policy-set', view), req);
      return;
    }
    const wireCode = String(view.code || 'cognitive-policy-failed').toLowerCase().replace(/_/g, '-');
    const status = wireCode === 'policy-file-unusable' ? 409
      : (wireCode === 'illegal-cognitive-state' ? 400
        : (wireCode === 'invalid-character-id' ? 400 : 400));
    record('warn', 'cognitive-policy-refused', {
      characterId: characterId, reasonCode: wireCode, loopback: isLoopback(req)
    });
    sendJson(res, status, {
      ok: false,
      operation: 'cognitive-policy-set',
      characterId: characterId,
      error: wireCode,
      reasonCode: wireCode,
      field: view.field === undefined ? null : view.field,
      detail: view.reason === undefined ? null : view.reason,
      authoritySource: 'FILE_POLICY',
      mutationAuthority: 'HOME_NODE_AUTHENTICATED_INTERNAL_ROUTE'
    }, req);
  }

  /* ── P21-R4-LIVE-2.1 · /security 里的诚实自述（唯一取值点）───────────────
     ★ 这一节回答"这台节点上到底有没有一条运行时解释执行面、它开不开、
       它是什么范围"。四个 NOT 类字段刻意写成**机器可读**的，而不是躺在
       注释里：
         · transportScope: 'DESKTOP_ONLY' —— `/internal/` 前缀已在
           isDesktopOnlyPath 里，设备面拿不到（路由事实，不是打算）；
         · androidCompatibility: 'NOT_PROVEN' —— 安卓上没有验证过；
         · autoInvocation: 'NOT_IMPLEMENTED' —— 没有任何自动触发（回合、
           派生、定时器都不调用它）；
         · autoRetry: 'NONE' + maxAttempts: 1 —— 失败不自动重试，因此
           一次请求最多花一次 provider 预算；
         · durable: false —— 非持久化：内容不落库，进程结束即消失。
     ★ costPolicyEnabled 的取值路径**恰好一条**：
       `describe().costPolicy.memoryInterpretationEnabled` —— 服务自己解释
       costPolicy（undefined / false / true / 对象 / 函数），本层既不重写那份
       解释，也不认第二个字段名。"这条付费路径开不开"因此只有一个真源。
       describe() 无秘密、无正文，每请求读一次是安全的（与 /security 里
       economyConfiguration.describe() 同一条既有做法）。 */
  function runtimeInterpretationSecurity() {
    /* 未装配时也回**同一套九个键**，一个不少：诊断页不该因为某一域缺席而
       换一套形状（消费者会立刻分叉）。
       ★ `path` 只有**一个**来源 = 服务对象自己的 `path`。本层**刻意不写**
         那个字面量：字面量写在这里就是第二份"这条路径叫什么"，而它与
         `route()` 用的判定（`path === runtimeInterpretation.path`）、以及
         浏览器客户端里那份（它 require 不到 Node 模块，只能自带常量）三者
         一旦漂移，`/security` 会继续报告一条**已经不存在的路径** —— 诊断面
         撒谎比诊断面缺席更糟。未装配时如实报 null（"这个进程没有这条面"），
         而不是替服务声明一条它并不拥有的路径。 */
    const boundary = {
      transportScope: 'DESKTOP_ONLY',
      androidCompatibility: 'NOT_PROVEN',
      autoInvocation: 'NOT_IMPLEMENTED',
      maxAttempts: 1,
      autoRetry: 'NONE',
      runtimeOnly: true,
      durable: false
    };
    if (!runtimeInterpretation) {
      return Object.assign({ assembled: false, path: null, costPolicyEnabled: false }, boundary);
    }
    let enabled = false;
    try {
      const described = typeof runtimeInterpretation.describe === 'function' ? runtimeInterpretation.describe() : null;
      const policy = described && typeof described === 'object' ? described.costPolicy : null;
      enabled = !!(policy && typeof policy === 'object' && policy.memoryInterpretationEnabled === true);
    } catch (_) { enabled = false; /* describe() 坏了不该让整个 /security 500 */ }
    return Object.assign({
      assembled: true,
      path: runtimeInterpretation.path || null,
      costPolicyEnabled: enabled
    }, boundary);
  }
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

  /* ══════════════════════════════════════════════════════════════════
     P22-23 · 首次运行凭据交付面（bootstrap）

     ── 它为什么必须存在 ───────────────────────────────────────────────
     凭据现在由服务端生成并持久化（desktop-credential.js），但**桌面页面
     拿不到它**：浏览器读不了文件系统，而把 secret 写进 HTML / URL /
     localStorage 明文都是明确禁止的（§6 第 4 条）。所以需要一条交付通道。

     ── 为什么它不是一个"无鉴权 localhost 旁路"（§6 第 9/10 条）────────
     准入规则只有三条，而且**每一条都在拒绝某种具体的攻击者**：

      1. socket 必须是 loopback。这条拒绝 LAN 上的一切 —— 它是既有的
         isLoopback()，不是这里新写的判定。

      2. `Origin` 头必须**存在**且必须是 loopback 源（http://127.0.0.1:*、
         http://localhost:*、http://[::1]:*）。
         ★ 缺失 Origin ⇒ 拒绝。非浏览器客户端（脚本、另一个本机应用）能
           伪造这个头，但它同时也能直接读那个凭据文件 —— 它读文件不经过
           本面，所以本面不欠它任何东西。反过来，一个**没有** Origin 的
           请求正是"某个进程在打这条路径"的形状，而这条路径的存在理由
           只是"给桌面页面一份它自己无法读到的秘密"，因此没有 Origin 就
           没有理由放行。
         ★ `Origin: null` ⇒ 拒绝（它落在"必须存在且是 loopback 源"之外）。
           null 是 sandboxed iframe / data: URL 的形状，而本仓库早已把
           null 归入"配置了 token 之后不再信任"的那一类（见上面的 CORS
           注释），这里是同一条判断的延续。
         ★ 远端页面的 Origin 是它自己的源，无论如何都变不成 loopback 源，
           所以一个恶意网页既发不出这条请求（P11-3X-A 的 Origin 面会先
           403 掉非 mobile 的命名外来 Origin），也读不到它的响应。

      3. `X-IB-Protocol: 1`。它使这条请求**不是**一个 CORS 简单请求，
         从而必然先走预检；预检由既有的 originAllowed() 裁决，而它只回显
         loopback / `null`（后者在本面被第 2 条拒掉）。这一步把"盲写"这条
         路也一并关掉：没有预检通过的跨源页面连发都发不出来。

     ── 它交付什么，以及**为什么没有"一次性"限制** ─────────────────────
     同一份**长期**桌面凭据。它不签发第二类凭据（没有 session token、没有
     cookie）：那样会造出第二个 authority，而本阶段要做的恰恰是把凭据收敛
     成一份。

     ★ 这条面**可以**被重复调用，而这是刻意的，理由是一个真实的产品需求：
       浏览器只把凭据留在**内存**里（不写 localStorage / sessionStorage ——
       见 assets/js/home-node-client.js 的取舍），因此用户**刷新页面**之后
       必须能再取一次。一个"每进程只交付一次"的实现会让刷新变成永久 401。

     ★ 重复交付不构成权限扩大：交付的是**同一份**凭据，因此"多给一次"不会
       让请求方获得它本来没有的能力（它下一次请求本来就能带着同一份凭据）。
       真正的边界是上面第 2 条 —— loopback Origin 的**读**能力，而
       `Origin: null` / 缺失 / 外来源全部被拒。一个恶意网页因此既拿不到
       第一次，也拿不到"下一次"。

       ├─ 远端页面    Origin 是自己的源 → 预检不过 / 非 mobile 命名外来源被 403
       ├─ file://      Origin: null      → 拒（且 Chrome 在网络层就挡住 file→loopback）
       ├─ 沙箱 iframe  Origin: null      → 拒
       └─ 本机进程     能伪造 Origin，但它本来就能直接读那个凭据文件 → 不是新增暴露

     什么时候**整面关闭**（fail closed，503 bootstrap-not-available）：
       · token 为空（没有凭据可交付）；
       · 凭据来自 env 或显式文件 —— 部署方已经决定了凭据，浏览器应当继续
         用它自己的配置，而不是从服务端再取一份；
       · 自动 provisioning 被显式关闭。
     这是 §6 第 7 条"缺失/损坏时 fail closed"在本面上的形状：不开，并且
     说清楚为什么不开。

     ── 日志纪律 ──────────────────────────────────────────────────────
     只记 source / length / 累计交付次数。**凭据本体绝不进日志**，也绝不进
     任何响应头（它只在响应体里，且只有请求者读得到）。 */
  const BOOTSTRAP_PATH = DESKTOP_CREDENTIAL_PATH;
  const BOOTSTRAP_HEADER = DESKTOP_CREDENTIAL_HEADER;

  /* loopback 源的形状判定。刻意**不**复用 originAllowed()：那一个的语义是
     "能不能读我们的响应"，它对 `null` 有条件放行（file:// 兼容），而本面
     要的是更窄的一个问题——"这个请求是不是来自本机 loopback 页面"。两个
     问题混用一个函数，正是本仓库反复修掉的那类"一个函数回答两件事"。 */
  function loopbackOrigin(value) {
    const origin = String(value == null ? '' : value).trim();
    if (!origin) return false;
    return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(origin);
  }

  function bootstrapUnavailableReason() {
    if (!token) return 'no-desktop-credential';
    if (credentialSource === 'env' || credentialSource === 'file') return 'credential-supplied-by-deployment';
    if (!credentialAutoProvision) return 'automatic-provisioning-not-enabled-for-this-process';
    return null;
  }

  async function handleDesktopCredentialBootstrap(req, res) {
    const denied = (status, error, extra) => {
      record('warn', 'desktop-credential-bootstrap-refused', {
        error: error,
        loopback: isLoopback(req),
        loopbackOrigin: loopbackOrigin(req.headers && req.headers.origin)
      });
      bad(res, status, error, extra || {}, req);
    };

    if (!isLoopback(req)) {
      denied(403, 'loopback-only', {
        hint: 'the desktop credential is delivered to this machine only'
      });
      return;
    }
    const origin = String((req.headers && req.headers.origin) || '');
    if (!loopbackOrigin(origin)) {
      denied(403, 'origin-not-loopback', {
        hint: 'this path is for the desktop page served from a loopback origin',
        originSeen: origin ? 'present-but-not-loopback' : 'absent'
      });
      return;
    }
    if (String((req.headers && req.headers[BOOTSTRAP_HEADER]) || '') !== '1') {
      denied(400, 'bootstrap-header-required', {
        requiredHeader: 'X-IB-Bootstrap: 1',
        hint: 'this keeps the request out of the CORS simple-request set'
      });
      return;
    }

    const unavailable = bootstrapUnavailableReason();
    if (unavailable) {
      /* 503 而不是 403：这不是"你不够格"，而是"本进程现在没有可交付的东西"。
         两者的下一步不同 —— 前者去改凭据，后者去看 /security 的原因码。 */
      denied(503, 'bootstrap-not-available', {
        reason: unavailable,
        credentialConfigured: !!token,
        credentialSource: credentialSource,
        autoProvision: credentialAutoProvision
      });
      return;
    }

    bootstrapHandoutCount += 1;
    bootstrapLastHandoutAt = clock();
    /* ★ 这一行是**唯一**把凭据写进任何响应的地方，而且只在上面四条准入
       全部通过之后。只记来源/长度/次数 —— 与启动日志同一纪律。 */
    record('info', 'desktop-credential-handed-out', {
      source: credentialSource,
      length: token.length,
      handoutCount: bootstrapHandoutCount,
      /* 只记指纹，不记本体。 */
      fingerprint: crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12)
    });
    ok(res, {
      credential: token,
      source: credentialSource,
      deliveredAt: bootstrapLastHandoutAt
    }, req);
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-11 · Economy Command Channel —— 唯一一条**写**路径
     ══════════════════════════════════════════════════════════════════
     它在整条路由链上的**位置**是刻意的：本函数在 /economy/* 的一切之前、
     在桌面 token 与企业来源判定之后（见两边各自的注释）。

     ★ 为什么它不是 /economy/* 下的一条路由：
       `/economy/*` 上的每一件事都是只读（P22-2 起逐名断言）。把一条
       **写**路径放进去，会让"POST /economy/* 一律 405 economy-is-read-only"
       这句话变成半真 —— 这个仓库刚在 P22-6/7/8/10 里四次修掉"声明比
       真实路由更保守/更激进"的同一类病。路径常量只有一份，在通道里
       （economyCommand.path），本文件不重写那个字面量。

     ★ 归入桌面面：`/internal/` 前缀被上面那条 isDesktopOnlyPath 收进
       与 /memory/ /understanding/ /moments/ /economy/ 同一类保护 ——
       远端未配置桌面 token 时它在通道判定之前就被 403。本层因此**不**
       为它新写一套来源规则，而是复用它继承来的那一条。

     ★ 身份**不**来自 payload：handleEconomyCommand 从 socket 与来源头
       判定来源，payload 里出现身份键会被逐名拒绝。因此本文件不做任何
       "相信调用方自称的 consumer"的动作，也没有这样的代码可以写错。 */
  function economyCommandRequestInfo(req) {
    return {
      loopback: isLoopback(req),
      remoteAddress: String((req.socket && req.socket.remoteAddress) || ''),
      remotePort: (req.socket && Number(req.socket.remotePort)) || null,
      sourceToken: String(req.headers['x-ib-economy-channel-source'] || '')
    };
  }
  async function handleEconomyCommand(req, res) {
    let body = null;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      const code = (error && error.code) || 'read-error';
      record('warn', 'economy-command-unreadable', { code: code, loopback: isLoopback(req) });
      /* ★ 读不出来也走**同一个**拒绝信封（通道自己给的），而不是本文件
         临时拼一个 —— 否则"这条路径的答案长什么样"会有两个来源。 */
      const refused = economyCommand.dispatch(economyCommandRequestInfo(req), null);
      bad(res, code === 'too-large' ? 413 : 400, refused.reasonCode, {
        dispatched: false,
        unreadableBody: code
      }, req);
      return;
    }
    const decision = economyCommand.dispatch(economyCommandRequestInfo(req), body);
    record(decision.ok === true ? 'info' : 'warn', 'economy-command', {
      /* ★ 审计只记这四样 + 结果：requestId、command、来源身份、result/linkage。
         凭据**绝不**进来（源头就不在 decision 里）。 */
      requestId: decision.commandId || null,
      command: decision.command || null,
      source: decision.source || null,
      outcome: decision.ok === true ? 'accepted' : String(decision.reasonCode || 'refused'),
      linkage: (decision.result && decision.result.intentId) || null,
      /* 通道层自述：传输不是权威（这一句跟着**每一次**判定一起落审计）。 */
      transportIsNotAnEconomyAuthority: true
    });
    sendJson(res, decision.status || 400, decision, req);
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
    const isDesktopOnlyPath = path.indexOf('/memory/') === 0 || path.indexOf('/understanding/') === 0 || path.indexOf('/moments/') === 0 || path.indexOf('/economy/') === 0
      /* P22-11：`/internal/*` 是**进程间内部命令面**（目前只有一条
         Economy command）。它与上述几条同类 —— 承载世界数据/写能力，
         因此远端未配置桌面 token 时整片 403，而不是匿名可达。
         ★ 前缀守卫写 `/internal/` 而不是只写那一条完整路径：这是本仓库
         既有的做法（/memory/ /understanding/ /moments/ 都是前缀），
         而后缀式白名单正是 P11-3E 那次"装配缺口伪装成正常行为"的成因。 */
      || path.indexOf('/internal/') === 0;
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

    /* ── P22-23 · 首次运行凭据交付（必须在**凭据判定之前**）─────────────
       位置是刻意的：这条请求的意义正是"调用方还没有凭据"，让它先过
       authorized() 会得到一个永远解不开的死结（401 → 拿不到凭据 → 还是
       401）。它的准入完全由 handleDesktopCredentialBootstrap 自己的三条
       规则负责，而那三条里没有任何一条是"本机所以放行"。

       ★ 远端永远到不了这里：上面那条 Origin 面已经先 403 掉命名外来
         Origin，而本面自己再要一次 loopback socket。两道独立的门，任何
         一道都足以挡住 LAN。 */
    if (path === BOOTSTRAP_PATH && method === 'POST') {
      await handleDesktopCredentialBootstrap(req, res);
      return;
    }
    if (path === BOOTSTRAP_PATH) {
      /* 非 POST：告诉调用方这里只有一个动词，而不是落进下面的 404 ——
         "路径不存在"与"方法不对"是两件不同的事，而这条路径确实存在。 */
      bad(res, 405, 'method-not-allowed', { allowedMethods: ['POST'] }, req);
      return;
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
      if (!isEconomyCommandPath(path) && !authorized(req, url)) {
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

    /* ★ P22-11：Economy command 路径与 /mobile/v1/* 同款处理 —— 它有**自己**
       的凭据域（来源凭据），因此不走桌面 token 判定。见 authorized() 上方
       那段说明：这不是豁免，而是"这条路径的准入由另一个机制完整负责"。
       顺序仍然在远端规则**之后**，所以远端未配置桌面 token 时它照样
       在更早的那一条上被 403。 */
    if (!isEconomyCommandPath(path) && !authorized(req, url)) {
      record('warn', 'unauthorized', { path: path, loopback: isLoopback(req) });
      bad(res, 401, 'unauthenticated', null, req);
      return;
    }

    /* ══════════════════════════════════════════════════════════════════
       P21-R4-LIVE-2.1 · Runtime Interpretation（**唯一**一条运行时执行面 · POST）

       ★ 位置是刻意的，而且它本身就是一条安全属性：这一块在上面那条桌面
         凭据判定**之后**，并且这条路径**没有**任何 `isEconomyCommandPath`
         式的豁免 —— 它与 /memory/ · /understanding/ · /economy/ 逐字同级。
         因此"解释必须出示 Vault 侧的桌面凭据"不是服务内部的自觉，而是
         传输层的门：未配置凭据的远端在更早那条 403 remote-admin-disabled，
         配置了凭据而没带/带错在这里 401。
       ★ 它也不在 /mobile/ 下，因此上面 isDesktopOnlyPath 的 `/internal/`
         前缀守卫覆盖它：设备面**永远**看不到这条路径（/security 的
         androidCompatibility: 'NOT_PROVEN' 说的正是这件事，而不是"以后再说"）。
       ★ 本文件在这里只判定路径与方法：body 的解释、角色的解析、凭据的取用、
         钱的闸门全在服务里。未注入服务时整条分支**不存在**，落到下面的
         通用兜底 —— 与之前逐字一致。 */
    if (runtimeInterpretation && path === runtimeInterpretation.path) {
      if (method !== 'POST') {
        record('warn', 'runtime-interpretation-wrong-method', { method: method, loopback: isLoopback(req) });
        bad(res, 405, 'runtime-interpretation-is-post-only', { allowedMethods: ['POST'] }, req);
        return;
      }
      await handleRuntimeInterpretation(req, res);
      return;
    }

    /* ══════════════════════════════════════════════════════════════════
       P21-R4-LIVE-3.3 · Runtime Recall（**唯一**一条运行时召回面 · POST）

       ★ 与上面那块**逐字同级、逐字同门**：位置在桌面凭据判定之后，没有
         任何豁免；也不在 /mobile/ 下，因此 `/internal/` 前缀守卫覆盖它。
         一条"能读到她记得什么"的路径必须以桌面凭据为门，这不是可选加固。
       ★ 它与解释边界是**两条**路径，而不是一条路径上的两种 operation：
         一条回答"该想起谁"（本地、不花钱、纯影子），一条回答"这些记忆
         意味着什么"（出网、花预算、读 Vault）。合成一条会让"召回"与
         "解释"在审计里变成同一个动作。
       ★ 本文件在这里只判定路径与方法；未注入服务时整条分支**不存在**。 */
    if (runtimeRecall && path === runtimeRecall.path) {
      if (method !== 'POST') {
        record('warn', 'runtime-recall-wrong-method', { method: method, loopback: isLoopback(req) });
        bad(res, 405, 'runtime-recall-is-post-only', { allowedMethods: ['POST'] }, req);
        return;
      }
      await handleRuntimeRecall(req, res);
      return;
    }

    /* ══════════════════════════════════════════════════════════════════
       P21-R4-PROD-1 · Cognitive Runtime Control Plane（**唯一**控制面 · POST）

       ★ 位置与上面两条运行时面**逐字同级**：在桌面凭据判定之后，没有任何
         豁免；也不在 /mobile/ 下，因此 `/internal/` 前缀守卫覆盖它 ——
         远端未配置桌面 token → 403 remote-admin-disabled，配置了而没带/
         带错 → 401 unauthenticated。设备面拿不到这条路径（路由事实）。
       ★ 它是**产品控制面**，不是第四个认知层：只读写两个既有布尔
         （autoInterpretationEnabled / autoExpectationEnabled），
         持久化仍然只有 runtime-policy.js 一份权威。 */
    if (runtimeCognitivePolicy && path === COGNITIVE_POLICY_PATH) {
      if (method !== 'POST') {
        record('warn', 'cognitive-policy-wrong-method', { method: method, loopback: isLoopback(req) });
        bad(res, 405, 'cognitive-policy-is-post-only', { allowedMethods: ['POST'] }, req);
        return;
      }
      await handleRuntimeCognitivePolicy(req, res);
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
        /* ── P22-23 · 首次运行凭据的三个事实 ────────────────────────────
           在它存在之前，`/security` 只能回答 `tokenRequired`，而"没有凭据"
           与"凭据从没被创造过"是两件不同的事 —— 前者是部署决策，后者是
           本阶段修掉的那个缺陷。UI 需要后者才能给出正确的诊断
           （§8：区分 Home Node 未运行 / provisioning 失败 / mismatch）。

           ★ 这三个字段都**不含凭据**：来源名、布尔、原因码。
           ★ `bootstrap.available` 是公开的，这是刻意的：它不泄漏任何秘密
             （想取凭据的人本来就会去打那条路径），而它让"为什么这台机器
             取不到凭据"在诊断页上有一个可读的答案。 */
        credentialSource: credentialSource,
        credentialConfigured: !!token,
        bootstrap: {
          path: BOOTSTRAP_PATH,
          available: !!token && credentialSource === 'generated' && credentialAutoProvision,
          /* 用过了几次：**不是**闸门（这条面可以被重复调用 —— 见本文件里
             "为什么没有一次性限制"那段），只是让"这台机器上到底发生过什么"
             有一个可读的答案。 */
          handoutCount: bootstrapHandoutCount,
          lastHandoutAt: bootstrapLastHandoutAt,
          autoProvision: credentialAutoProvision,
          /* 未配置凭据时**明说**这是"这个进程没有凭据"，而不是让读者从
             available:false 反推。措辞命名的是状态，不是让用户去执行的指令。 */
          unavailableReason: bootstrapUnavailableReason()
        },
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
          /* P22-5 又新增了五个会改状态的方法（putStore / putProduct /
             grantInventory / consumeInventory / createProductQuote）——
             名单必须跟着能力长。purchaseExposed 是**显式**的 false：
             购买在本阶段不存在，而"不存在"必须是一个可断言的字段，
             而不是"路由表里碰巧没写"。 */
          storeWritesExposed: [],
          productWritesExposed: [],
          inventoryWritesExposed: [],
          purchaseExposed: false,
          mintingExposed: false,
          expirationIsNotATimer: true,
          /* P22-4 的三条自述：预算评估是**快照**、不是许可（§19）；
             它不锁任何钱；报价与预留是两件事（§7）。 */
          budgetEvaluationIsASnapshotOnly: true,
          budgetEvaluationReservesFunds: false,
          quoteLocksFunds: false,
          budgetTimezone: 'UTC',
          /* P22-5 的四条自述：库存不是余额（§12）；货架没有价格也没有
             拥有关系（§2）；目录不做推荐、不做个性化定价（§40/§41）。 */
          inventoryCanonical: 'sqlite-inventory-rows',
          inventoryIsABalance: false,
          storeHoldsPrices: false,
          storeHoldsOwnership: false,
          productPricingIsRelationshipFree: true,
          catalogIsPersonalized: false,
          /* ── P22-6：购买面 ────────────────────────────────────────────────
             这一层第一次有了**完整**的购买运行时，而它给出的仍然是一句
             彻底的否认。三条自述逐字对应 §60/§61：
               · 读路由**有**（两张）；
               · 写路由**没有**，而且是三项分开的名单（不是一句笼统的
                 "read-only"）—— 因为"哪一类写被挡住了"正是审计要问的。 */
          purchaseWritesExposed: [],
          settlementWritesExposed: [],
          policyApprovalWritesExposed: [],
          purchaseRuntimeImplemented: true,
          purchaseSettlementIsOneTransaction: true,
          purchaseAmountSource: 'quote-snapshot',
          purchaseHasRefund: false,
          purchaseCreatesPendingApprovalRecords: false,
          purchaseRewritesHistoricalQuotes: false,
          purchaseIsALedgerTransaction: false,
          purchaseTouchesProvider: false,
          purchaseTouchesPayment: false,
          /* ── P22-7：权限层 ────────────────────────────────────────────────
             ★ 这一节的四句话是"HTTP 面**没有**获得批准能力"的逐字形式：
               · approvalRuntimeImplemented —— 运行时**有**（同进程 API）；
               · approvalWritesExposed / autonomyWritesExposed —— 写路由
                 **没有**，而且是两项分开的名单；
               · approveViaHttpIsForsen —— 不存在任何一条"用户点批准"的
                 HTTP 入口，那个入口留给未来的 UI / Action authority 阶段。
             §14 逐字要求本阶段即使有了 Approval runtime 也不开放
             POST /economy/approve · /reject · /buy · /autonomy。 */
          approvalRuntimeImplemented: true,
          approvalWritesExposed: [],
          autonomyWritesExposed: [],
          approveViaHttpIsForbidden: true,
          approvalConsumptionIsInsideSettlement: true,
          approvalIsSingleUse: true,
          autonomyDefaultWhenNoPolicy: 'REQUIRE_APPROVAL',
          autonomyIsADecisionLayer: false,
          /* ── P22-8：Agent Purchase Intent 层 ─────────────────────────────
             ★ 这一节回答"HTTP 面**有没有**获得替 Agent 提出购买意图的
             能力"，而答案必须是**没有**：
               · intentBridgeImplemented —— 运行时**有**（同进程窄接口
                 proposeAgentPurchaseIntent / resumeAgentPurchaseIntent）；
               · intentWritesExposed —— 写路由**没有**（空名单，
                 `unreachable` 里逐名列出四条写形态）；
               · proposeViaHttpIsForbidden —— 不存在任何一条"提出意图"的
                 HTTP 入口。
             §15 逐字要求本阶段禁止 POST /economy/intent · /economy/buy ·
             /economy/execute · /economy/approve。
             ★ 另三句是本阶段三条边界的机器可读形式：Agent 的 reason 不是
             权限；每一个 intent 都必须过 P22-7 的权威闸门；而
             AUTO_ALLOW 仍然要过 P22-6 的预算与原子结算。 */
          intentBridgeImplemented: true,
          intentWritesExposed: [],
          proposeViaHttpIsForbidden: true,
          reasonIsAuthority: false,
          everyIntentPassesTheAuthorityGate: true,
          autoAllowStillRequiresBudget: true,
          approvalPathReservesNothing: true,
          intentIsAnEconomicFact: false,
          intentCarriesPrice: false,
          intentTouchesProvider: false,
          intentTouchesPayment: false,
          /* ── P22-9：准入层 ───────────────────────────────────────────────
             ★ 这一节回答"HTTP 面**有没有**获得准入能力"，答案同样必须是
             **没有**，而且这一次的"没有"比前几次更硬：
               · capabilityGateImplemented —— 运行时**有**（装配期构造的
                 economy-capability.js，门在 P22-8 上面）；
               · capabilityWritesExposed / capabilityReadsExposed —— 两个
                 **都**是空名单：门没有任何 HTTP 面，连读面都没有（矩阵
                 是同进程的装配事实，不是一项对外服务）；
               · capabilityIsNotEconomyAuthority —— 一次准入通过**不是**
                 预算通过、不是权威通过、不是批准。
             `unreachable` 里逐名列出六条"授权形态"的路径，因为那些路径
             一旦存在，权限就来自一个请求了。 */
          capabilityGateImplemented: true,
          capabilityWritesExposed: [],
          capabilityReadsExposed: [],
          capabilityGrantViaHttpIsForbidden: true,
          capabilityIsNotEconomyAuthority: true,
          capabilityIsNotABudgetDecision: true,
          desktopPaths: ['/economy/health', '/economy/wallet', '/economy/ledger',
            '/economy/transaction', '/economy/changes',
            '/economy/reservations', '/economy/reservation',
            '/economy/policies', '/economy/policy', '/economy/budget',
            '/economy/quotes', '/economy/quote',
            /* P22-5：三对只读路由。它们出现在这里，而对应的**写**路径
               出现在下面的 unreachable 里 —— 两张表必须同时更新，
               否则"声明"会落后于"真实路由"。 */
            '/economy/stores', '/economy/store',
            '/economy/products', '/economy/product',
            '/economy/inventory', '/economy/inventory-entry',
            /* P22-6：购买读面（一对）。 */
            '/economy/purchases', '/economy/purchase',
            /* P22-7：权限读面（三对五条）。`/economy/approval` 从
               unreachable 移到这里，而 `/economy/approvals` 从未在名单里；
               `/economy/autonomy-policy` 是新增的只读面，而写形态
               `/economy/autonomy` 与 `/economy/autonomy-policy` 的 POST
               落在下面那个兜底分支上（一律 405）。 */
            '/economy/approvals', '/economy/approval',
            '/economy/autonomy-policies', '/economy/autonomy-policy',
            '/economy/autonomy-evaluation',
            /* P22-8：Agent Purchase Intent 读面（一对）。这是本阶段新增的
               **全部** HTTP 面 —— 两条 GET，零条写路由。 */
            '/economy/intents', '/economy/intent'],
          /* P22-4：/economy/budget 与 /economy/quote **有**只读路由，
             因此它们不出现在 unreachable 里；而不存在的写路径
             （policy/quote 的 POST·PUT·DELETE、approve、evaluate 的写形态）
             逐条列出来。
             P22-5 从这份名单里**移走**三条（/economy/store、/economy/product、
             /economy/inventory）—— 它们现在真的有只读路由了。一条声明
             若比真实路由更保守，那么它就不再是在描述这个系统；因此移走
             它们不是放松，而是让这张表继续为真。
             ★ P22-6 同一条纪律的第二次应用：`/economy/purchase` 从这份
             名单里**移走**（它现在是一条真实的只读路由），而
             `/economy/purchases` 从未在名单里。同时**加进**这一次新增的
             写形态：prepare / settle / buy / cancel / refund —— 一个都不
             存在，而且它们的存在性必须被逐名断言（boundary B16）。 */
          unreachable: ['/economy/topup', '/economy/payment',
            '/economy/provider', '/economy/mint', '/economy/burn', '/economy/transfer',
            '/economy/reserve', '/economy/commit', '/economy/release', '/economy/expire',
            '/economy/fail', '/economy/sweep',
            /* ★ `/economy/approval` 在 P22-6 时还在这份名单里（那时它确实
               不存在）。P22-7 给了它一条**只读**路由，因此它必须被**移走**
               —— 一条声明若比真实路由更保守，它就不再是在描述这个系统。
               移走它**不是放松**：`/economy/approve` 与 `/economy/reject`
               （真正的写入口）仍然逐名留在这里。 */
            '/economy/approve', '/economy/reject',
            '/economy/inventory/grant', '/economy/inventory/consume',
            '/economy/store/create', '/economy/store/update',
            '/economy/product/create', '/economy/product/update',
            '/economy/prepare', '/economy/settle', '/economy/buy',
            '/economy/cancel', '/economy/refund', '/economy/reverse',
            '/economy/exchange', '/economy/autonomy', '/economy/autonomy-policy',
            /* ★ P22-8 新增的四条写形态，一个都不存在，而且必须被**逐名**
               断言（boundary 测试的 B 组）：`intent/propose` 与
               `intent/execute` 是"提出意图"与"执行意图"最自然会被写出来
               的两个路径名，而它们恰恰是本阶段最不该存在的东西 ——
               前者会让任何 HTTP 调用方获得 Agent 的购买权，后者会让模型
               绕过 权威判定 与 预算。`/economy/execute` 是"通用经济动作
               执行器"的路径名（§14 逐字禁止的那个形状），
               `/economy/approval/decide` 是"从 HTTP 替用户点头"。
               它们在这里而不是在别处，因为这份名单的**用途**就是让
               "声明"与"真实路由"无法分叉。 */
            '/economy/intent/propose', '/economy/intent/execute',
            '/economy/intent/resume', '/economy/execute', '/economy/approval/decide',
            '/economy/intent/create', '/economy/intents/create',
            /* ── P22-9：准入层的写形态 ────────────────────────────────────
               ★ 门**没有**任何 HTTP 面 —— 它是同进程的装配事实，而不是
               一个服务。因此这里列出的不是"还没做的路由"，而是**不许有**
               的路由：哪一天有人想从浏览器给一个 consumer 开权限，那一次
               授权就来自一个 HTTP 请求，而 §3 逐字禁止权限来自请求内容。
               `/economy/capability*` 与 `/economy/gate*` 是这件事最自然的
               两种写法，因此它们在这里。 */
            '/economy/capability', '/economy/capabilities',
            '/economy/capability/grant', '/economy/capability/revoke',
            '/economy/gate', '/economy/gate/check'],
          /* ── P22-11：进程间 command 通道（本阶段唯一一条**写**路径）────
             ★ 这一节不是"放松"。它把 P22-11 新增的那件事写成**可断言的
             字段**，而不是留给读者从路由表里推断：
                · commandWritesExposed —— 恰好一条，路径由通道持有
                  （本文件不重写字面量，见 handleEconomyCommand）；
                · capacityWritesExposed / approvalWritesExposed /
                  resumeWritesExposed —— 上面那三份名单**保持为空**：
                  跨进程只开放 ECONOMY_PROPOSE_PURCHASE 一个 command，
                  因此它们不是在 P22-11 被"搬到别处"，而是仍然不存在。
                · httpVerbs 仍然是 ['GET'] —— 那句话说的是 /economy/*，
                  而这条 command 路径**刻意不在** /economy/ 下（见上面
                  handleEconomyCommand 的注释）。两句话同时为真。
             ★ 通道未装配时（economyCommand == null）：`open:false`、
             名单为空 —— 一个没接线的部署不该被读成"有一个开放的写面"。
             ★ **装配了但关着**（登记册为空 = 生产未配置凭据）也必须是空
             名单：这条路径此刻不可达，而"不可达的写面"与"可达的写面"
             在审计里必须是两个答案。`implemented` 说"这个面在代码里
             存在"，`open` + 名单一起说"它此刻能不能被用"。 */
          commandChannel: economyCommand ? (() => {
            const d = economyCommand.describe();
            const open = d.open === true;
            return Object.assign({
              implemented: true,
              open: open,
              commandWritesExposed: open ? d.commands.slice() : [],
              sourceCount: d.sourceCount,
              identityComesFromTheTransportNotThePayload: true,
              capabilityWritesExposed: [],
              approvalWritesExposed: [],
              resumeWritesExposed: [],
              pathIsNotUnderEconomyReadPaths: String(economyCommand.path).indexOf('/economy/') !== 0,
              transportIsNotAnEconomyAuthority: true
            }, { path: economyCommand.path });
          })() : {
            implemented: false,
            open: false,
            commandWritesExposed: [],
            capabilityWritesExposed: [],
            approvalWritesExposed: [],
            resumeWritesExposed: []
          },
          /* ── P22-13：Approval Decision Seam（第二条、也是最后一条写路径）──
             ★ 这一节同样是**加法**，而且是"把已经发生的事实写成字段"：
               · approvalDecisionWritesExposed —— 恰好两个决定词
                 （APPROVE / REJECT），由 seam 持有；
               · decisionWritesThatAreNotAPPROVEorREJECT —— 恒为空：
                 BUY / SETTLE / RESERVE / GRANT / REFUND / LEDGER /
                 AUTO_ALLOW 在这条路径上**不存在**（不是被过滤，是不在词表里）；
               · bypassesTheResumeChain —— 恒 false：批准之后**只能**走
                 P22-8 的恢复路径，seam 里没有第二条到钱的边；
               · carriesEconomicFacts —— 恒 false：价格 / 金额 / 币种 /
                 预算 / 钱包 / 商品事实 / 结算方式 / 发放数量 / consumer /
                 capability 都不在这条路径的信封里（出现即拒）。
             ★ `open:false` 的两种情况（未配置桌面凭据 / 未装配）都必须是空名单：
               "不可达的写面"与"可达的写面"在审计里必须是两个答案。
             ★ 与 commandChannel 的关系逐字写出来：两条路径**不共用**
               consumer、不共用凭据、不代表同一件事。 */
          approvalDecision: economyApprovalDecision ? (() => {
            const d = economyApprovalDecision.describe();
            const open = d.open === true;
            return Object.assign({
              implemented: true,
              open: open,
              approvalDecisionWritesExposed: open ? d.decisions.slice() : [],
              decisionWritesThatAreNotAPPROVEorREJECT: [],
              capability: d.capability,
              capabilityConsumer: d.capabilityConsumer,
              proposalWritesExposed: [],
              bypassesTheResumeChain: false,
              carriesEconomicFacts: false,
              deciderComesFromTheAssemblyNotThePayload: true,
              identityComesFromTheTransportNotThePayload: true,
              requiresConfiguredDesktopCredential: true,
              commandMeans: d.differsFromTheCommandChannel.commandMeans,
              decisionMeans: d.differsFromTheCommandChannel.decisionMeans,
              sharesAConsumerWithTheCommandChannel: false,
              sharesACredentialWithTheCommandChannel: false,
              pathIsNotUnderEconomyReadPaths: String(economyApprovalDecision.path).indexOf('/economy/') !== 0,
              approvalIsNotAGuaranteedPurchase: true,
              transportIsNotAnEconomyAuthority: true
            }, { path: economyApprovalDecision.path });
          })() : {
            implemented: false,
            open: false,
            approvalDecisionWritesExposed: [],
            decisionWritesThatAreNotAPPROVEorREJECT: [],
            capability: null,
            capabilityConsumer: null,
            proposalWritesExposed: [],
            bypassesTheResumeChain: false,
            carriesEconomicFacts: false,
            requiresConfiguredDesktopCredential: true
          },
          /* ── P22-14：Configuration Seam（第三条、也是最后一条写路径）──────
             ★ 这一节同样是**加法**，而且是"把已经发生的事实写成字段"：
               · configurationCommandsExposed —— 恰好三个命令（BOOTSTRAP_CREDIT
                 / PUT_BUDGET_POLICY / PUT_AUTONOMY_POLICY），由 seam 持有；
               · configurationWritesThatAreNotOneOfThoseThree —— 恒为空：
                 BUY / SETTLE / RESERVE / GRANT_INVENTORY / APPROVE / REJECT /
                 REFUND / EXCHANGE / PROVIDER_TOPUP / REAL_PAYMENT /
                 RAW_LEDGER_WRITE 在这条路径上**不存在**（不是被过滤，是不在
                 词表里）；
               · exposesMintForSystem —— 恒 false：这条面拿到的 store 视图恰好
                 三个键，mintForSystem 不在其中；
               · initialCreditIsOneShot —— true，而且它的**持有者**是 store 的
                 canonical 事实（economy_meta 行），不是路由层的一次检查。
             ★ `open:false` 的两种情况（未配置桌面凭据 / 未装配）都必须是空名单：
               "不可达的写面"与"可达的写面"在审计里必须是两个答案。
             ★ 与 approvalDecision 的关系逐字写出来：两条路径**不共用**命令、
               不共用信封 —— 配置不能决定一条批准，决定也不能改配置。 */
          configuration: economyConfiguration ? (() => {
            const d = economyConfiguration.describe();
            const open = d.open === true;
            return Object.assign({
              implemented: true,
              open: open,
              configurationCommandsExposed: open ? d.commands.slice() : [],
              configurationWritesThatAreNotOneOfThoseThree: [],
              configurationCannotDecideAnApproval: true,
              approvalDecisionCannotConfigure: true,
              sharesACommandWithTheApprovalDecisionSeam: false,
              sharesAnEnvelopeWithTheApprovalDecisionSeam: false,
              exposesMintForSystem: false,
              exposesGenericDispatch: false,
              isAnAgentAuthority: false,
              isAPurchaseAuthority: false,
              isAPaymentAuthority: false,
              configurationTouchesProvider: false,
              configurationTouchesPayment: false,
              configurationWritesRawLedgerEntries: false,
              initialCreditIsOneShot: true,
              initialCreditOneShotLivesInTheCanonicalStore: true,
              budgetPolicyIsAVersionedUpdate: true,
              autonomyPolicyIsAVersionedUpdate: true,
              identityComesFromTheTransportNotThePayload: true,
              requiresConfiguredDesktopCredential: true,
              pathIsNotUnderEconomyReadPaths: String(economyConfiguration.path).indexOf('/economy/') !== 0,
              transportIsNotAnEconomyAuthority: true
            }, { path: economyConfiguration.path });
          })() : {
            implemented: false,
            open: false,
            configurationCommandsExposed: [],
            configurationWritesThatAreNotOneOfThoseThree: [],
            configurationCannotDecideAnApproval: true,
            approvalDecisionCannotConfigure: true,
            sharesACommandWithTheApprovalDecisionSeam: false,
            sharesAnEnvelopeWithTheApprovalDecisionSeam: false,
            exposesMintForSystem: false,
            exposesGenericDispatch: false,
            isAnAgentAuthority: false,
            isAPurchaseAuthority: false,
            isAPaymentAuthority: false,
            configurationTouchesProvider: false,
            configurationTouchesPayment: false,
            configurationWritesRawLedgerEntries: false,
            initialCreditIsOneShot: true,
            initialCreditOneShotLivesInTheCanonicalStore: true,
            budgetPolicyIsAVersionedUpdate: true,
            autonomyPolicyIsAVersionedUpdate: true,
            identityComesFromTheTransportNotThePayload: true,
            requiresConfiguredDesktopCredential: true
          }
        },
        /* ── P21-R4-LIVE-2.1 · Runtime Interpretation：运行时解释面的诚实自述 ──
           它为什么必须在这里、而且是**顶层**字段：这一节回答的是"这台节点
           到底有没有一条会花钱的解释执行面、它开不开、它是什么范围"。
           读它的消费者（诊断页、未来的 UI 门控）不该从路由表或环境变量里
           推断这件事 —— P22-15 / P22-16 的教训正是"开不开"必须是**可读的
           字段**，而那两处读的也是 /security。
           ★ 取值逻辑全在 runtimeInterpretationSecurity() 里，这一行不判断；
             未装配时那节报 assembled:false 与一份同形状的中性值。 */
        runtimeInterpretation: runtimeInterpretationSecurity(),
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
    /* ── P22-19 · change log 的 owner 作用域读面 ───────────────────────
       `GET /economy/changes?ownerId=<canonical-owner-id>[&order=desc]`

       ★ 为什么这里多了一个参数而不是新增一条路由：change log 是**全局**
         的，而 P22-18 的时间线需要的是"**这个 owner 的**最近活动"。之前
         的做法是取一页全局 change 再用 JS 筛 —— 那是错的，而且错在两个
         层次：字段层（生产 payload 的 `buyerId` 有两种 canonical 拼写，
         逐字比较必然漏掉 APPROVAL_APPROVED/REJECTED/CONSUMED；而
         APPROVAL_EXPIRED 的 payload 一个 owner 字段都没有），以及分页层
         （`revision` 上的 keyset 是从**最早**往新走的，截断时留下的是最旧
         的一段，把它叫"最近活动"就是错的）。见 docs §2/§3。

       ★ 过滤发生在 **canonical query**（economy-store 的
         `listChangesForOwner` → SQL 的 owner 谓词），**不是**在本函数里
         取全部再筛。本函数只做一件事：把参数透传下去，把结果和一句作用域
         自述一起交出去。断言这件事的测试是
         tests/test_p22_19_economy_owner_scope_http.js 的 A 组 —— 它扫本
         文件的源码，确认这里没有出现"取一段再 filter"的形状。

       ★ `order` **必须**与 `ownerId` 同时出现：全局读面的契约是
         `ORDER BY revision ASC`（P22-1 起，P22-2 的 C10 逐字钉住），而
         "要最新的一段"这个需求只在 owner 作用域下被证明过。带了 `order`
         却不带 `ownerId` 时一律 400 —— 静默忽略一个参数会让调用方以为
         自己拿到了 desc（那正是本阶段在别处反复拒绝的那种静默谎言）。

       ★ 不带 `ownerId` 时这条路由的行为与 P22-1 起**逐字相同**：
         同一条 SQL、同一个响应形状（没有多出 `ownerScope`）。 */
    if (path === '/economy/changes' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const ownerId = url.searchParams.get('ownerId');
      const order = url.searchParams.get('order');
      if (order && !ownerId) {
        bad(res, 400, 'change-order-requires-owner',
          { hint: 'order is only defined for the owner-scoped change read' }, req);
        return;
      }
      if (!ownerId) {
        const changes = economy.listChanges(url.searchParams.get('cursor') || 0, url.searchParams.get('limit') || undefined);
        ok(res, { changes: changes, revision: economy.getRevision() }, req);
        return;
      }
      const scoped = economy.listChangesForOwner({
        ownerId: ownerId,
        cursor: url.searchParams.get('cursor') || 0,
        limit: url.searchParams.get('limit') || undefined,
        order: order || undefined
      });
      if (!scoped.ok) {
        bad(res, 400, scoped.errors[0] || 'change-scope-read-failed', null, req);
        return;
      }
      ok(res, {
        changes: scoped.changes,
        revision: economy.getRevision(),
        /* 作用域写在响应里：于是"这一页是不是 owner-scoped"不用猜。 */
        ownerScope: scoped.scope,
        /* §8 逐字：这一层只做 filter / sort / project。它**不**重算余额、
           不重判预算决定、不重判批准有效性、不重判报价有效性、不重判购买
           结果、不重算库存数量、不重判自主裁决。 */
        recomputesEconomyFacts: false
      }, req);
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
      const result = economy.getQuote({
        quoteId: quoteId,
        /* provenance=1 会**额外**读一次 products 表，把"这份报价的商品行
           现在是什么样"附上。它默认关闭，因为 §22 选定的语义是
           "Product 是 provenance，不是报价有效性的依赖" —— 若它无条件
           发生，"报价可读"就会悄悄依赖"商品行还在"。 */
        withProvenance: url.searchParams.get('provenance') === '1'
      });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'quote-not-found', null, req); return; }
      ok(res, {
        quote: economy.serializeQuote(result.quote),
        productProvenance: result.productProvenance || null
      }, req);
      return;
    }
    /* ── P22-5 · 目录与库存（**同样只读**）──────────────────────────────
       这三对路由回答的问题逐条是 §46 说的那四个（有哪些商品 / 商品是什么 /
       当前报价是什么 / 角色拥有什么），一个都不多：

         GET /economy/stores          列出货架（可按 status 过滤）
         GET /economy/store           单个货架（storeId）
         GET /economy/products        列出商品（storeId / status / kind / currency）
         GET /economy/product         单个商品（productId）
         GET /economy/inventory       列出库存（ownerId 或 productId 之一必填）
         GET /economy/inventory-entry 单条库存（inventoryEntryId 或 ownerId+productId）

       **没有** POST /economy/product、POST /economy/store、
       POST /economy/inventory/grant、POST /economy/inventory/consume、
       POST /economy/purchase —— 它们落在下面那个兜底分支上，一律 405。
       这一层拿不到 putStore / putProduct / grantInventory /
       consumeInventory / createProductQuote 这五个方法名（boundary B15
       逐个点名断言），因此"通过 HTTP 改目录或发库存"在**路由表**上不存在，
       而不是靠一个 if 挡着。 */
    if (path === '/economy/stores' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listStores({
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'store-read-failed', null, req); return; }
      ok(res, {
        stores: result.stores.map(s => economy.serializeStore(s)),
        /* 货架里没有价格，也没有拥有关系（§2）。 */
        holdsPrices: false,
        holdsOwnership: false
      }, req);
      return;
    }
    if (path === '/economy/store' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const storeId = url.searchParams.get('storeId');
      if (!storeId) { bad(res, 400, 'missing-store-id', null, req); return; }
      const result = economy.getStore({ storeId: storeId });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'store-not-found', null, req); return; }
      ok(res, { store: economy.serializeStore(result.store) }, req);
      return;
    }
    if (path === '/economy/products' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listProducts({
        storeId: url.searchParams.get('storeId') || undefined,
        status: url.searchParams.get('status') || undefined,
        kind: url.searchParams.get('kind') || undefined,
        currency: url.searchParams.get('currency') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'product-read-failed', null, req); return; }
      ok(res, {
        products: result.products.map(p => withCatalogImage(economy.serializeProduct(p))),
        /* 目录是 canonical 的，不是推荐系统（§40）：这一层不认识"给谁看"。 */
        personalized: false,
        hasRecommendations: false,
        hasDiscounts: false
      }, req);
      return;
    }
    if (path === '/economy/product' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const productId = url.searchParams.get('productId');
      if (!productId) { bad(res, 400, 'missing-product-id', null, req); return; }
      const result = economy.getProduct({ productId: productId });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'product-not-found', null, req); return; }
      ok(res, {
        product: withCatalogImage(economy.serializeProduct(result.product)),
        /* 价格与关系无关（§41）；商品里没有拥有关系（§10）。 */
        pricingIsRelationshipFree: true,
        holdsOwnership: false
      }, req);
      return;
    }
    if (path === '/economy/inventory' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listInventory({
        ownerId: url.searchParams.get('ownerId') || undefined,
        productId: url.searchParams.get('productId') || undefined,
        assetKind: url.searchParams.get('assetKind') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'inventory-read-failed', null, req); return; }
      ok(res, {
        entries: result.entries.map(e => economy.serializeInventoryEntry(e)),
        /* 库存不是余额、不参与 available、不按币种聚合（§12）。 */
        isABalance: false,
        contributesToAvailableBalance: false,
        locksFunds: false
      }, req);
      return;
    }
    if (path === '/economy/inventory-entry' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const inventoryEntryId = url.searchParams.get('inventoryEntryId');
      const ownerId = url.searchParams.get('ownerId');
      const productId = url.searchParams.get('productId');
      if (!inventoryEntryId && !(ownerId && productId)) {
        bad(res, 400, 'missing-inventory-entry-id-or-owner-and-product', null, req); return;
      }
      const result = economy.getInventoryEntry({
        inventoryEntryId: inventoryEntryId || undefined,
        ownerId: ownerId || undefined,
        productId: productId || undefined
      });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'inventory-entry-not-found', null, req); return; }
      ok(res, { entry: economy.serializeInventoryEntry(result.entry) }, req);
      return;
    }
    /* ── P22-6 · 购买（**只读**）─────────────────────────────────────────
       GET /economy/purchases   列出购买（buyerId / recipientId / status /
                                productId / quoteId 过滤）
       GET /economy/purchase    单次购买（purchaseId），带三个小结

       ★ P22-6 第一次让 Economy 拥有**完整**的购买运行时，而这里依然
       **一条写路由都不开**（§60）。
       ★ P22-7 第一次让 Economy 拥有**完整的权限判定运行时**（自主策略 +
       批准记录），而这里同样**一条写路由都不开**（§14）：
         · 没有 POST /economy/approve、POST /economy/reject、
           POST /economy/buy、POST /economy/autonomy、
           POST /economy/autonomy-policy；
         · 它们全部落在下面那个兜底分支上，一律 405 economy-is-read-only；
         · 理由不是"还没写"，而是 **Decision / Action / 用户权限入口都还
           没有接入** —— 在那之前，"谁有权替谁点头"这个问题没有答案，
           而没有答案的写入口就是一个权限漏洞。真正的"用户点批准"入口
           留给未来的 UI / Action authority 阶段。
       mutation 只通过同进程 runtime fixture 触发（见 P22-7 focused tests）。 */
    if (path === '/economy/purchases' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listPurchases({
        buyerId: url.searchParams.get('buyerId') || undefined,
        recipientId: url.searchParams.get('recipientId') || undefined,
        status: url.searchParams.get('status') || undefined,
        productId: url.searchParams.get('productId') || undefined,
        quoteId: url.searchParams.get('quoteId') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'purchase-read-failed', null, req); return; }
      ok(res, {
        purchases: result.purchases,
        count: result.count,
        /* 三句逐字的自述（§80：这个读面不是个性化的）。 */
        personalized: false,
        recommended: false,
        ranked: false,
        exposesMutation: false
      }, req);
      return;
    }
    if (path === '/economy/purchase' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const purchaseId = url.searchParams.get('purchaseId');
      if (!purchaseId) { bad(res, 400, 'missing-purchase-id', null, req); return; }
      const result = economy.getPurchase({ purchaseId: purchaseId });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'purchase-not-found', null, req); return; }
      ok(res, Object.assign({
        /* 一句结构性的自述：Purchase 不是它所引用的任何一件事。 */
        isALedgerTransaction: false,
        isAReservation: false,
        isAQuote: false,
        /* P22-7：购买也不是一条批准，而且它不携带任何权限（权限是
           approvalId 那个一次性事实，不是这行记录）。 */
        isAnApproval: false,
        grantsAutonomy: false,
        grantsBudget: false,
        exposesMutation: false
      }, result), req);
      return;
    }

    /* ══════════════════════════════════════════════════════════════════
       P22-7 · 权限读面（五条 GET，**零**条写路由）

       ★ §14 逐字要求本阶段即使有了 Approval runtime 也不开放：
           POST /economy/approve · /economy/reject · /economy/buy ·
           /economy/autonomy
         真正"用户点批准"的入口留给未来的 UI / Action authority 阶段 ——
         在那之前，"谁有权替谁点头"这个问题没有答案，而没有答案的写入口
         就是一个权限漏洞。因此这里给的是**只读**的：
           GET /economy/approvals           列出批准（buyerId / quoteId / status）
           GET /economy/approval            单条（approvalId）
           GET /economy/autonomy-policies   列出自主策略（ownerId）
           GET /economy/autonomy-policy     单条（policyId 或 ownerId）
           GET /economy/autonomy-evaluation 对一份**已存在的报价**做一次
                                            只读的自主判定（§19 的快照语义）
       ★ 三条自述写在每一个响应上：这个读面不改任何状态、不创建任何记录、
       不消费任何批准。 */
    if (path === '/economy/approvals' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listApprovals({
        buyerId: url.searchParams.get('buyerId') || undefined,
        quoteId: url.searchParams.get('quoteId') || undefined,
        status: url.searchParams.get('status') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'approval-read-failed', null, req); return; }
      ok(res, {
        approvals: result.approvals,
        count: result.count,
        personalized: false,
        recommended: false,
        ranked: false,
        createsRecords: false,
        consumesApprovals: false,
        exposesMutation: false
      }, req);
      return;
    }
    if (path === '/economy/approval' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const approvalId = url.searchParams.get('approvalId');
      if (!approvalId) { bad(res, 400, 'missing-approval-id', null, req); return; }
      const result = economy.getApproval({ approvalId: approvalId });
      if (!result.ok) {
        /* ── P22-24 · §Not-Found wire contract（与 /economy/policy /economy/wallet
           逐字同一条规矩）────────────────────────────────────────────────
           ★ 这两个词表**不是**同一个词表，而且不能互相顶替：
             · reasonCode   = canonical **decision** vocabulary（DENY_REASON）
                              ——"这个作用域上没有生效的规则/记录"，它属于
                              评估与结算的裁决；
             · errors[0]    = store 给**客户端**的资源缺席 token
                              （'approval-not-found'），它属于读面。
           ★ 第一版写成 `reasonCode || errors[0] || …`，于是一条**资源缺席**
             被当成 client error token 发出去。那是一次 contract-layer
             violation：客户端被迫学习内部裁决词表才能说出一句人话，
             而这正是相邻的 /economy/wallet 与 /economy/policy 从来没有
             发生过的事（它们一直用 errors[0]）。
           ★ 顺序因此是 **errors[0] → 兜底**，与那两条同源；status 的判据
             （reasonCode 是不是 NOT_FOUND）**不变** —— 改的只是"这句话用
             哪个词说"，不是"这算不算 404"。 */
        bad(res, result.reasonCode === 'APPROVAL_NOT_FOUND' ? 404 : 400,
          result.errors[0] || 'approval-not-found', null, req);
        return;
      }
      ok(res, {
        approval: economy.serializeApproval(result.approval),
        createsRecords: false,
        consumesApprovals: false,
        exposesMutation: false,
        canApproveViaHttp: false,
        canRejectViaHttp: false
      }, req);
      return;
    }
    if (path === '/economy/autonomy-policies' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listAutonomyPolicies({
        ownerId: url.searchParams.get('ownerId') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'autonomy-policy-read-failed', null, req); return; }
      ok(res, {
        policies: result.policies,
        count: result.count,
        personalized: false,
        grantsBudget: false,
        isADecisionLayer: false,
        exposesMutation: false
      }, req);
      return;
    }
    if (path === '/economy/autonomy-policy' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const policyId = url.searchParams.get('policyId');
      const ownerId = url.searchParams.get('ownerId');
      if (!policyId && !ownerId) { bad(res, 400, 'missing-policy-id-or-owner-id', null, req); return; }
      const result = economy.getAutonomyPolicy({
        policyId: policyId || undefined, ownerId: ownerId || undefined
      });
      if (!result.ok) {
        /* ── P22-24 · §Not-Found wire contract ──────────────────────────
           ★ 与上面 /economy/approval 逐字同源，也与 /economy/policy 逐字同源：
             store 已经给了**客户端**该听到的那个 token
             （'autonomy-policy-not-found'），它就是线上要发的词。
           ★ 第一版发的是 `result.reasonCode`（= canonical DENY_REASON
             'POLICY_NOT_FOUND'），后果是**产品级**的：Economy 设置页
             「自主购买」那一格只把 'autonomy-policy-not-found' 认成
             "尚未配置"（state=absent → 渲染首次配置表单），拿到裁决词表
             则归成 state=unknown（"读不到自主规则" + 再试一次 + **没有
             表单**）。于是全新 owner 永远进不去首次配置。
           ★ status 的判据仍然是 reasonCode === 'POLICY_NOT_FOUND' → 404：
             "这个作用域上没有生效的规则"这个 canonical 语义一个字都没变，
             变的只是"这句话用哪个词说"。 */
        bad(res, result.reasonCode === 'POLICY_NOT_FOUND' ? 404 : 400,
          result.errors[0] || 'autonomy-policy-not-found', null, req);
        return;
      }
      ok(res, {
        policy: economy.serializeAutonomyPolicy(result.policy),
        defaultWhenNoPolicy: 'REQUIRE_APPROVAL',
        grantsBudget: false,
        isADecisionLayer: false,
        exposesMutation: false
      }, req);
      return;
    }
    if (path === '/economy/autonomy-evaluation' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const quoteId = url.searchParams.get('quoteId');
      const buyerId = url.searchParams.get('buyerId');
      if (!quoteId || !buyerId) { bad(res, 400, 'missing-quote-id-or-buyer-id', null, req); return; }
      const result = economy.evaluateAutonomousPurchaseFor({
        buyerId: buyerId, quoteId: quoteId,
        recipientId: url.searchParams.get('recipientId') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'autonomy-evaluation-failed', null, req); return; }
      ok(res, {
        decision: result.decision,
        quoteId: result.quoteId,
        buyerId: result.buyerId,
        recipientId: result.recipientId,
        productId: result.productId,
        productKind: result.productKind,
        settlementType: result.settlementType,
        currency: result.currency,
        amountMinor: result.amountMinor,
        autonomyPolicyId: result.autonomyPolicyId,
        autonomyPolicyPresent: result.autonomyPolicyPresent,
        spentTodayMinor: result.spentTodayMinor,
        /* ★ 逐字：这是一次**快照评估**，不是可执行的许可（§19）。
           它不 reserve、不创建批准、不创建购买。 */
        evaluatedOnly: true,
        notASpendPermit: result.notASpendPermit,
        reserved: false,
        createsRecords: false,
        consumesApprovals: false,
        exposesMutation: false
      }, req);
      return;
    }
    /* ══════════════════════════════════════════════════════════════════
       P22-8 · Agent Purchase Intent 读面（两条 GET，**零**条写路由）

       ★ §15 逐字要求本阶段：
           可以加 GET /economy/intents · GET /economy/intent
           禁止   POST /economy/intent · /economy/buy · /economy/execute ·
                  /economy/approve
       两条 POST 形态落在下面那个兜底分支上，一律 405 economy-is-read-only。

       ★ 本阶段第一次让**模型**有能力影响经济 —— 而 HTTP 上依然一条写路由
       都没有。这不是保守，而是 §14 那条边界在传输层的落点：
       `proposeAgentPurchaseIntent` 是同进程的**窄接口**，它的调用方是
       Decision Bridge（未来的 Decision/Action seam），而不是一个 HTTP 请求。
       把"提出购买意图"做成一个 HTTP 端点，等于让任何能发请求的东西获得
       Agent 的购买权 —— 而"谁有权替谁提出意图"这个问题在本阶段同样没有
       答案（与 P22-7 拒绝 POST /economy/approve 是同一条理由）。

       ★ 读面上四句自述：这个读面不改状态、不创建 intent、不执行任何购买、
       不消费任何批准。尤其 `reasonIsAuthority: false` —— Agent 给的理由随
       读面出来，但它在同一个响应里被标明"不是权限"。 */
    if (path === '/economy/intents' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const result = economy.listPurchaseIntents({
        agentId: url.searchParams.get('agentId') || undefined,
        productId: url.searchParams.get('productId') || undefined,
        state: url.searchParams.get('state') || undefined,
        limit: url.searchParams.get('limit') || undefined
      });
      if (!result.ok) { bad(res, 400, result.errors[0] || 'intent-read-failed', null, req); return; }
      ok(res, {
        intents: result.intents,
        count: result.count,
        /* 三句逐字的自述（与 purchases / approvals 同款）。 */
        personalized: false,
        recommended: false,
        ranked: false,
        createsIntents: false,
        executesPurchases: false,
        consumesApprovals: false,
        exposesMutation: false
      }, req);
      return;
    }
    if (path === '/economy/intent' && method === 'GET') {
      if (!economy) { bad(res, 501, 'economy-not-assembled', null, req); return; }
      const agentIntentId = url.searchParams.get('agentIntentId');
      if (!agentIntentId) { bad(res, 400, 'missing-agent-intent-id', null, req); return; }
      const result = economy.getPurchaseIntent({
        agentIntentId: agentIntentId,
        withChain: url.searchParams.get('withChain') === '1'
      });
      if (!result.ok) { bad(res, 404, result.errors[0] || 'intent-not-found', null, req); return; }
      ok(res, Object.assign({
        /* ── 这个读面**是**什么、**不是**什么（逐句可断言）──────────────
           · 它是一条编排事实，不是经济事实：钱、库存、账本各自有自己的
             canonical owner，而这个记录从不承载它们；
           · 它不是权限：一条 AUTO_ALLOW 的 intent 不蕴含"以后也放行"；
           · 它不携带价格：价格唯一来自 quote。
           这三句与 wallet / purchase / approval 上的自述是同一条纪律。 */
        isAnEconomicFact: false,
        isAnOrchestrationFact: true,
        isAnApproval: false,
        isAPurchase: false,
        isAQuote: false,
        grantsAutonomy: false,
        grantsBudget: false,
        carriesPrice: false,
        reasonIsAuthority: false,
        exposesMutation: false
      }, result), req);
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

    /* ══════════════════════════════════════════════════════════════════
       P22-11 · Economy Command Channel（唯一一条写路径 · POST）

       ★ 它在 `/economy/*` 一切分支**之前**，也在下面那条"其余 /economy/*
         一律 405 economy-is-read-only"之前 —— 而这条路径不在 /economy/
         前缀下，所以两件事不会互相遮挡：读面仍然全是 GET，写面只有这一条。

       ★ 这里只做三件事：readBody（有界）→ economyCommand.dispatch(...)
         → 把通道给出的状态码与信封原样发出。**没有**第四件事：本文件
         不解释 command、不解释 proposal、不挑 consumer、不看经济事实。
         那三件事分别在通道、P22-10、P22-8 里各有一份唯一实现。

       ★ 未注入通道时（economyCommand == null）整条分支不存在，落到
         下面的兜底：GET 404 / 非 GET 405 unknown-path，与 P22-10 逐字一致。 */
    if (economyCommand && path === economyCommand.path) {
      if (method !== 'POST') {
        record('warn', 'economy-command-wrong-method', { method: method, loopback: isLoopback(req) });
        bad(res, 405, 'economy-command-is-post-only', { allowedMethods: ['POST'] }, req);
        return;
      }
      await handleEconomyCommand(req, res);
      return;
    }

    /* ══════════════════════════════════════════════════════════════════
       P22-13 · Economy Approval Decision Seam（用户的点头 / 摇头 · POST）

       ★ 它与上面那条命令路径是**两条**路径，而不是一条路径上的两种
         command。一个代表 Agent WANT（ECONOMY_PROPOSE_PURCHASE），
         一个代表 User APPROVAL DECISION（APPROVE / REJECT）；两条各有
         自己的准入、自己的凭据要求、自己的 consumer，而它们**不共用**
         任何一样（见 seam 的 describe().differsFromTheCommandChannel）。
         把它们合成一条，就等于让"Agent 的传输"与"用户的传输"看起来是
         同一个东西 —— 而 P22-13 §2 的全部要点正是它们必须分开。

       ★ 本文件在这里仍然只做三件事：readBody（有界）→ dispatch → 原样
         发出它给的信封。**不解释**决定、**不挑**身份、**不看**经济事实，
         也没有任何一行能从这条路到达 store 或门。 */
    if (economyApprovalDecision && path === economyApprovalDecision.path) {
      if (method !== 'POST') {
        record('warn', 'economy-approval-decision-wrong-method', { method: method, loopback: isLoopback(req) });
        bad(res, 405, 'economy-approval-decision-is-post-only', { allowedMethods: ['POST'] }, req);
        return;
      }
      await handleEconomyApprovalDecision(req, res);
      return;
    }

    /* ══════════════════════════════════════════════════════════════════
       P22-14 · Economy Configuration Seam（fresh install 的配置 · POST）

       ★ 它是**第三条**写路径，而且必须是第三条而不是前两条上的新命令：
         · command 路径代表 Agent WANT（一个进程在提议）；
         · approval-decision 路径代表 User DECISION（用户对**一条**intent 点头）；
         · configuration 路径代表 User CONFIGURATION（用户**预设**这台节点的
           钱与规则）。
         三者的权威不同、词表不同、信封不同。把它们合并成"万能 user
         command endpoint"正是 §8 逐字禁止的那件事。

       ★ 本文件在这里仍然只做三件事：readBody（有界）→ dispatch → 原样发出
         它给的信封。**不解释**命令、**不挑**身份、**不看**经济事实，也没有
         任何一行能从这条路到达 store、门或适配器。 */
    if (economyConfiguration && path === economyConfiguration.path) {
      if (method !== 'POST') {
        record('warn', 'economy-configuration-wrong-method', { method: method, loopback: isLoopback(req) });
        bad(res, 405, 'economy-configuration-is-post-only', { allowedMethods: ['POST'] }, req);
        return;
      }
      await handleEconomyConfiguration(req, res);
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
      /* ★ 这个 handler 里**没有** `route()` 作用域里的那个 `path` 变量：
         它当初写成引用 `path` 时，每一个带 Origin 的预检都在这一行抛
         ReferenceError，请求**永远得不到响应**（客户端只看到超时 /
         Failed to fetch），而服务端日志里只有一条 uncaught-exception。
         实测症状：OPTIONS + loopback Origin → 挂死；OPTIONS 无 Origin → 204
         （因为无 Origin 时这一行根本不会被求值）。因此这里的路径必须从
         `url` 自己算，并且**只算一次**。 */
      const preflightPath = url.pathname.replace(/\/+$/, '') || '/';
      const headers = { Vary: 'Origin' };
      if (originAllowed(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, X-IB-Home-Token, X-IB-Protocol, Authorization';
        /* ── P22-23 · 交付面的预检必须允许它自己的头 ────────────────────
           这一行是**实测**补上的，不是防御性写法：凭据交付面要求
           `X-IB-Bootstrap: 1`（它让这条请求必然走预检，从而把盲写那条路
           关掉），而浏览器的预检会逐个检查请求头是否在允许名单里 —— 不在
           就**在请求到达服务端之前**把它拦掉。症状是一条
           `TypeError: Failed to fetch`，而服务端日志里**什么都没有**
           （实测：同一页面的 GET /health 是 200，只有这一条 POST 失败）。
           这正是本仓库已经记录过两次的同一类现象（见上面 PNA 那段：
           "请求根本没有落到服务端日志里"）。
           ★ 只对**这一条路径**放宽：别处没有理由带这个头，而 allow-headers
             是一条声明"哪些头会被读"的清单，不是全局开关。 */
        if (preflightPath === DESKTOP_CREDENTIAL_PATH) {
          headers['Access-Control-Allow-Headers'] += ', X-IB-Bootstrap';
        }
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
/* P22-23：交付面的路径与协议头是**契约**，由本文件唯一持有 —— 客户端
   （assets/js/home-node-client.js）与测试都从这里取，不各写一份字面量。
   这是本仓库对"路径常量只有一份"的既有做法（见 economyCommand.path）。 */
module.exports.DESKTOP_CREDENTIAL_PATH = DESKTOP_CREDENTIAL_PATH;
module.exports.DESKTOP_CREDENTIAL_HEADER = DESKTOP_CREDENTIAL_HEADER;
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
