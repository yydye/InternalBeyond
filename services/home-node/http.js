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
  const gateway = deps.gateway || null;
  const clock = deps.clock || (() => Date.now());
  const token = String(deps.token || '');
  const version = String(deps.version || '0.0.0');
  const allowedOrigins = Array.isArray(deps.allowedOrigins) ? deps.allowedOrigins.map(String) : [];
  const logger = deps.logger || (() => {});
  const startedAt = clock();
  const logRing = [];

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

  function healthPayload() {
    return {
      service: 'internal-beyond-home-node',
      version: version,
      role: 'canonical-chat-authority',
      open: store.isOpen(),
      revision: store.isOpen() ? store.getRevision() : 0,
      messages: store.isOpen() ? store.countMessages() : 0,
      schemaVersion: store.schemaVersion
    };
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
    const isDesktopOnlyPath = path.indexOf('/memory/') === 0 || path.indexOf('/understanding/') === 0 || path.indexOf('/moments/') === 0;
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
      ok(res, healthPayload(), req);
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
      ok(res, healthPayload(), req);
      return;
    }

    if (path === '/status' && method === 'GET') {
      ok(res, {
        meta: store.meta(),
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
           desktopPaths 与 ADMIN_PATHS 逐字一致（见 test_moments_authority）。 */
        momentsPolicy: {
          stored: true,
          servedToDevices: false,
          deviceVerbs: [],
          injection: 'home-node-execution-only',
          visibility: 'moments-visibility-core (shared with desktop)',
          desktopPaths: ['/moments/list', '/moments/changes', '/moments/records', '/moments/record',
            '/moments/visible', '/moments/migration', '/moments/migrate']
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
      const existingPolicy = payload.existingPolicy === 'skip' ? 'skip' : 'overwrite';
      const result = batch.length === 1 && !payload.forceBatch
        ? store.putMessage(batch[0], { requestId: requestId, existingPolicy: existingPolicy })
        : store.putMessages(batch, { requestId: requestId, existingPolicy: existingPolicy });
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
