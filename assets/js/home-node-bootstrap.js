/* ====================================================================
   IB Home Node bootstrap — 把 canonical chat authority 接进浏览器数据层
   --------------------------------------------------------------------
   这是 M1-A 在浏览器侧**唯一**的写入点。它做四件事，每件都只有一处实现：
     1. 组装 local driver（镜像）与 remote driver（Home Node HTTP）；
     2. 用 assets/js/chat-authority.js 的策略层替换 chatMessages 的
        dbGet / dbGetAll / dbGetByIndex / dbPut / dbDelete（**仅这一个 store**）；
     3. 启动时做一次镜像同步（播种 + 增量）；
     4. 暴露 window.IB.homeNode 供诊断 / 迁移 / 状态展示使用。

   加载顺序（InternalBeyond.html）：core.js → provider-directory.js →
   ib-model-core.js → chat-core.js → chat-authority.js → home-node-client.js →
   home-node-bootstrap.js。本文件必须最后加载。

   回滚：localStorage['ib_home_node_mode'] = 'mirror' 即恢复 M1-A 之前的
   纯 IndexedDB 行为（不探测、不接管、不写 Home Node）。
   见 docs/HOME_NODE_CHAT.md §7 / §8。
   ==================================================================== */
(function (NS) {
'use strict';

/* ══ R4-A.6 · 启动期 canonical memory guard + 依赖诊断 ══════════════════
   为什么必须有这一段（机械事实，不是推测）：

   下面的依赖检查会在**安装 window.dbPut / window.dbDelete 覆盖之前**整体
   early-return。一旦早退，`memories` 的写就仍然解析到**原始 IndexedDB writer**：
   浏览器里静默出现一份"本地记忆真相"，而 Home Node 对此一无所知。
   这正是 A.5 留下的 R4A5-BOOTSTRAP-ABORT-SILENT-DOWNGRADE-1。

   A.5 已在**覆盖内部**修掉了 `MODE=canonical && !memoryAuthority` 的静默降级；
   但覆盖根本没安装时，那段守卫无从执行，因此必须在**任何依赖检查之前**先装一道
   provisional guard：

     · canonical-intended 且非 file:// ⇒ 拒绝 memories 的 put/delete（fail closed）；
     · MODE=mirror / off        ⇒ 逐字转发，合法 host-local 语义**不变**；
     · file://（显式 degraded 承载）⇒ 逐字转发，合法 host-local 语义**不变**；
     · 非 memories store        ⇒ 逐字转发给安装时的原函数，行为**不变**。

   正式 bootstrap 走到下面时用 `window.dbPut = function (...) {...}` **直接赋值替换**
   本 guard（不是套娃），因此正常路径只多一次被替换掉的赋值。
   安装是幂等的（window.__ibCanonicalMemoryGuard），重复执行不会叠加包装。
   ==================================================================== */

/* 启动期诊断：函数声明会被提升，因此在下面的早退点上也**可以**调用。
   刻意不依赖 LOG_TAG —— 那是 `var`，在早退点上还是 undefined。
   只记状态词 / store / op / dependency，**绝不**记正文、凭据或用户内容。 */
function bootNote(event, fields) {
  try {
    var ns = NS || (window.IB = window.IB || {});
    if (!ns.homeNodeLog) ns.homeNodeLog = [];
    ns.homeNodeLog.push(Object.assign({ at: Date.now(), event: event }, fields || {}));
    if (ns.homeNodeLog.length > 100) ns.homeNodeLog.shift();
  } catch (e) { /* 观测失败不影响功能 */ }
  try { console.warn('[HomeNode] ' + event, fields || ''); } catch (e) { /* 无 console */ }
}

/* canonical intent 判定：与下面 `var MODE = ...` 用**同一个表达式**，
   只是提前到任何依赖检查之前，好让 guard 在 bootstrap 早退时仍然知道
   自己"本来想 canonical"。file:// 是**显式**声明的 degraded 承载
   （Chrome 在网络层阻断 file://→loopback，见下方 FILE_ORIGIN 说明），
   那种承载下 host-local 是合法语义 ⇒ 不拦。读不出来时 fail safe（拦）。 */
function canonicalMemoryIntended() {
  try {
    if (typeof location !== 'undefined' && String(location.protocol) === 'file:') return false;
    return ((typeof window.ibHomeNodeMode === 'function') ? window.ibHomeNodeMode() : 'canonical') === 'canonical';
  } catch (e) { return true; }
}

/* 早退 / 初始化失败时对外可见的降级面：复用成功路径 `memory.status()` 的
   **同一形状**（available / authority / authorityEffective / degraded / degradedReason），
   不新造第二套 global health framework。
   刻意**不**暴露 remote —— 消费方（middle-brain-direct / moments / active-diary）
   一律用安全属性链 + `remote` 存在性判断，缺 remote 时自动走本地分支。 */
function exposeDegradedMemorySurface(reason) {
  try {
    var ns = NS || (window.IB = window.IB || {});
    if (!ns.homeNode) ns.homeNode = {};
    if (ns.homeNode.memory && typeof ns.homeNode.memory.status === "function") return;
    if (ns.homeNode.mode === undefined) ns.homeNode.mode = canonicalMemoryIntended() ? 'canonical' : 'local';
    ns.homeNode.degraded = true;
    ns.homeNode.degradedReason = reason;
    ns.homeNode.memory = {
      instance: null,
      available: false,
      authority: null,
      status: function () {
        return { store: 'memories', available: false, authority: 'indexeddb',
          authorityEffective: false, degraded: true, degradedReason: reason,
          canonicalIntended: canonicalMemoryIntended() };
      },
      sync: function () { return Promise.resolve({ ok: false, error: reason }); },
      migrate: function () { return Promise.resolve({ ok: false, error: reason }); },
      rebuildMirror: function () { return Promise.resolve({ ok: false, error: reason }); }
    };
    if (typeof ns.homeNode.status !== "function") {
      ns.homeNode.status = function () {
        return { available: false, degraded: true, degradedReason: reason, mode: ns.homeNode.mode };
      };
    }
  } catch (e) { /* 观测失败不影响功能 */ }
}

/* ── provisional canonical memory guard（见上方说明）────────────────── */
(function installCanonicalMemoryGuard() {
  if (window.__ibCanonicalMemoryGuard) return;
  var priorPut = window.dbPut;
  var priorDel = window.dbDelete;
  /* 没有可包装的原函数（core.js 未加载）⇒ 不装：此时 `window.dbPut` 本身
     就不是函数，memory 写会以 TypeError 失败，已经是 fail closed。 */
  if (typeof priorPut !== "function" && typeof priorDel !== "function") return;
  window.__ibCanonicalMemoryGuard = true;

  function refuse(op) {
    bootNote('memory-authority-not-ready', { store: 'memories', op: op, reason: 'bootstrap-not-installed' });
    var err = new Error('memory 的 canonical authority 未就绪（Home Node bootstrap 未完成安装）；拒绝写入本地镜像（fail closed）');
    err.code = 'memory-authority-not-ready';
    err.authority = 'home-node';
    return Promise.reject(err);
  }
  if (typeof priorPut === "function") {
    window.dbPut = function (store, data) {
      if (store === 'memories' && canonicalMemoryIntended()) return refuse('put');
      return priorPut.apply(this, arguments);
    };
  }
  if (typeof priorDel === "function") {
    window.dbDelete = function (store, key) {
      if (store === 'memories' && canonicalMemoryIntended()) return refuse('delete');
      return priorDel.apply(this, arguments);
    };
  }
})();

/* 策略层来自 assets/js/chat-authority.js（UMD，裸全局 IBChatAuthority ——
   与 chat-core.js / ib-model-core.js / provider-directory.js 同款约定，
   不是 IB.* 成员）。
   传输层来自 assets/js/home-node-client.js（按本仓库命名空间约定属于 IB.*）。
   两者位置不同是既有约定使然，必须各自读对：读错只会**静默早退**，
   表现成"页面完全没有 Home Node 能力"而没有任何可见错误（实测踩过）。 */
var _authorityFactory = (window.IBChatAuthority && typeof window.IBChatAuthority.createChatAuthority === 'function')
  ? window.IBChatAuthority.createChatAuthority
  : ((typeof window.createChatAuthority === 'function') ? window.createChatAuthority : null);
if (!_authorityFactory) {
  /* R4-A.6：此前这里**完全静默** —— 页面表现为"没有 Home Node 能力"
     而没有任何可见错误。现在给出稳定 reason code 与降级面。
     memory 写在 canonical-intended 下已由上面的 provisional guard 拒绝。 */
  bootNote('memory-bootstrap-dependency-missing', { dependency: 'chat-authority', canonicalIntended: canonicalMemoryIntended() });
  exposeDegradedMemorySurface('memory-bootstrap-dependency-missing:chat-authority');
  return;
}
if (!window.__ibCoreDb) {
  bootNote('memory-bootstrap-dependency-missing', { dependency: 'core-db', canonicalIntended: canonicalMemoryIntended() });
  exposeDegradedMemorySurface('memory-bootstrap-dependency-missing:core-db');
  console.warn('[HomeNode] core.js 接缝未就绪，跳过接管');
  return;
}

var DB = window.__ibCoreDb;
var MODE = (typeof window.ibHomeNodeMode === 'function') ? window.ibHomeNodeMode() : 'canonical';
var LOG_TAG = '[HomeNode]';

/* file:// 承载检测（实测结论，不是猜测）：
   Chrome 会在**网络层直接阻断** file:// 页面到 loopback 的 fetch ——
   实测 corsError = MissingAllowOriginHeader（GET）/
   PreflightMissingAllowOriginHeader（带自定义头的请求），
   请求根本不会到达服务端（服务端 trace 里一条都没有），与响应头怎么设无关。
   因此 file:// 下 Home Node 权威**不可能生效**。此时退回本地 IndexedDB 并如实
   声明 degraded：既不让桌面聊天坏掉，也不假装 Home Node 在生效。
   产品的正常启动链是 runtime/launch-internal-beyond.js:19 打开
   http://127.0.0.1:23120/InternalBeyond.html —— 那条路径完全正常。 */
var FILE_ORIGIN = (function () {
  try { return typeof location !== 'undefined' && String(location.protocol) === 'file:'; }
  catch (e) { return false; }
})();
if (FILE_ORIGIN) {
  try {
    console.warn(LOG_TAG + ' file:// 承载无法访问 Home Node（浏览器阻断 file://→loopback）；' +
      '本轮 chatMessages 走本地 IndexedDB。经启动器打开的 http://127.0.0.1:23120/InternalBeyond.html 使用 Home Node 权威。');
  } catch (e) { /* 无 console */ }
}

function warn(event, fields) {
  try { console.warn(LOG_TAG + ' ' + event, fields || ''); } catch (e) { /* 无 console */ }
}
function info(event, fields) {
  try { console.info(LOG_TAG + ' ' + event, fields || ''); } catch (e) { /* 无 console */ }
}

/* 可观测性：绝不记录正文、prompt、apiKey。只记 id / 计数 / revision / 状态词表。 */
function note(event, fields) {
  try {
    if (!NS.homeNodeLog) NS.homeNodeLog = [];
    NS.homeNodeLog.push(Object.assign({ at: Date.now(), event: event }, fields || {}));
    if (NS.homeNodeLog.length > 100) NS.homeNodeLog.shift();
  } catch (e) { /* 观测失败不影响功能 */ }
  var level = /fail|error|degraded|unreachable/.test(event) ? warn : info;
  level(event, fields || '');
}

/* ── local driver：Home Node 的物化镜像（IndexedDB chatMessages）────────
   读：直接读镜像。
   写：只由 authority 层在 Home Node 成功之后调用。
   失败语义：镜像写失败**不**回滚 Home Node 的成功 —— canonical 仍然是
   Home Node，authority 层会如实报告 mirrored:false。 */
var localDriver = {
  get: function (id) {
    return DB.get('chatMessages', id).then(function (row) { return row || null; });
  },
  getAll: function () {
    return DB.getAll('chatMessages').then(function (rows) { return rows || []; });
  },
  getByFriend: function (friendId) {
    return DB.getByIndex('chatMessages', 'byFriend', friendId).then(function (rows) { return rows || []; });
  },
  put: function (message) {
    return DB.put('chatMessages', message);
  },
  remove: function (id) {
    return DB.del('chatMessages', id);
  },
  applyUpserts: function (messages) {
    return DB.applyChatMirror(messages || [], []);
  },
  applyDeletes: function (deletes) {
    var ids = (deletes || []).map(function (d) { return d && d.messageId; }).filter(Boolean);
    return DB.applyChatMirror([], ids);
  },
  replaceAll: function (messages) {
    return DB.replaceChatMirror(messages || []);
  }
};

/* ── remote driver ─────────────────────────────────────────────────── */
/* 传输实现在 assets/js/home-node-client.js，按本仓库命名空间约定挂在 window.IB 下
   （不是裸全局）。这里必须读 IB —— 读裸全局会静默早退，表现为「页面完全没有
   Home Node 能力」而不是任何可见错误。 */
var _remoteFactory = (NS && typeof NS.createHomeNodeRemote === 'function')
  ? NS.createHomeNodeRemote
  : ((typeof window.createHomeNodeRemote === 'function') ? window.createHomeNodeRemote : null);
if (!_remoteFactory) {
  bootNote('memory-bootstrap-dependency-missing', { dependency: 'home-node-client', canonicalIntended: canonicalMemoryIntended() });
  exposeDegradedMemorySurface('memory-bootstrap-dependency-missing:home-node-client');
  warn('remote-driver-missing', { ibHas: typeof (NS && NS.createHomeNodeRemote) });
  return;
}
var remoteDriver = _remoteFactory({});

/* ── P22-12 §9 · Active planner 的**只读**目录事实 seam ─────────────────
   ★ 这只是把**既有**的 Home Node 只读客户端接到 Active 的规划器上：
     规划器（assets/js/active-diary/active-plans.js）不认识 23118、不发起
     任何请求、也不新增 Economy API —— 它读一个注入的只读 provider，而
     provider 就是上面那个 remote driver 上那个**已经做过构造式投影**的
     只读方法（economyCatalogFacts → 既有 GET /economy/products）。
   ★ 注册是无条件的，**宣告**不是：模型那边是否被告知可以提议购买，由
     IB.activeEconomyProposalEnabled 决定（它由 companion 是否真的配好了
     经济通道决定）。注册这个 provider 不会让任何东西开始花钱，也不会让
     任何一条读不到的路径变成"可以买"。
   ★ 失败不抛：客户端自己已经把不可达归类成 {ok:false, products:[]}，
     规划器拿到空目录的后果只有一个 —— 这次不宣告这个动作。因此这里
     只把 products 交出去（信封留给需要区分"取不到"与"目录真的是空的"
     的读者），而空/失败都收敛成 []。 */
if (remoteDriver && typeof remoteDriver.economyCatalogFacts === 'function') {
  NS.activeEconomyCatalogProvider = function (options) {
    return remoteDriver.economyCatalogFacts(options).then(function (res) {
      return (res && res.ok === true && Array.isArray(res.products)) ? res.products : [];
    }, function () { return []; });
  };
}

var authority = _authorityFactory({
  remote: remoteDriver,
  local: localDriver,
  mode: MODE,
  fileOrigin: FILE_ORIGIN,
  log: function (event, fields) { note(event, fields); }
});
/* chatAuthority 也走同一命名空间约定（expose 幂等）。 */
if (typeof NS.expose === 'function') NS.expose('chatAuthority', { instance: authority, MODES: authority.MODES });
else NS.chatAuthority = authority;

/* ── 接管数据访问助手（chatMessages + memories）──────────────────────
   只包装这两个 store；任何其它 store 逐字走原函数。
   返回形状必须与原来**完全一致**（数组 / 对象 / undefined），
   否则既有调用点会立刻坏掉。

   Memory 与 Chat 的接管顺序差异（刻意的）：
     · chatMessages：以同步值（数组/对象）为契约 —— 91 个调用点里有全表扫描，
       因此沿用 authority.get/getAll，且它们本来就是 Promise。
     · memories：读必须先**保证镜像已从 Home Node 补齐**（ensureReady），
       否则页面刚打开时会读到"迁移之前"的本地状态，而权威已经是 Home Node。
       两者最终都是 Promise，调用点无感。 */
function isChatStore(store) { return store === 'chatMessages'; }
function isMemoryStore(store) { return store === 'memories' && !!memoryAuthority; }
function isUnderstandingStore(store) { return store === 'understandings' && !!understandingAuthority; }
/* 理解域是否**结构性**由 Home Node 独占：canonical 模式且不是 file:// 承载。
   与 isUnderstandingStore 刻意不同：那个只说"这个 store 已被接管"，
   这个说"浏览器不允许再写它"。两者在 file:// / mode=off / mirror 下**必须分开** ——
   那些承载下权威不可达，本地写是 M1-C.2m 的回滚路径（与迁移之前逐字同行为）；
   把它们一并拒绝等于"关掉集成之后功能直接坏掉"，那不是回滚，那是移除。 */
function understandingWriteClosed() {
  return !!understandingAuthority && typeof understandingAuthority.authorityEffective === 'function'
    && understandingAuthority.authorityEffective() === true;
}

var original = {
  put: window.dbPut, get: window.dbGet, getAll: window.dbGetAll,
  getByIndex: window.dbGetByIndex, del: window.dbDelete
};
NS.homeNodeOriginalDb = original;

var MIRROR_WRITE_ATTEMPTS = 3;
var RETRY_BASE_MS = 120;

function withRetry(fn, attempts) {
  var left = attempts == null ? MIRROR_WRITE_ATTEMPTS : attempts;
  function attempt() {
    return Promise.resolve().then(fn).catch(function (error) {
      left--;
      /* 明确的拒绝（记录非法 / 未授权）不重试：重试同样的负载只会得到同样结果。 */
      if (!left || (error && (error.rejected || error.code === 'home-node-rejected'))) throw error;
      return new Promise(function (r) { setTimeout(r, RETRY_BASE_MS * (MIRROR_WRITE_ATTEMPTS - left)); }).then(attempt);
    });
  }
  return attempt();
}

function throwWriteError(result, fallbackId) {
  var err = new Error('Home Node 写入被拒绝（' + (result && result.error || 'unknown') + '）');
  err.code = (result && result.error) || 'home-node-write-failed';
  err.id = (result && result.id) || fallbackId || null;
  err.rejected = !!(result && result.rejected);
  err.authority = 'home-node';
  throw err;
}

window.dbPut = function (store, data) {
  if (store === 'memories' && MODE === 'canonical' && !memoryAuthority) {
    /* R4-A.5 · canonical-intended authority unavailable ⇒ **fail closed**。
       `isMemoryStore()` 要求 `!!memoryAuthority`，因此在 authority 缺席时它会返回 false，
       于是本函数此前会**静默**走 `original.put` —— 在"MODE=canonical"的环境里写下一份
       没有权威确认的本地真相。理解域与动态域早就有同款守卫
       （`understanding-write-closed` / `moments-write-closed`），记忆域此前没有。
       注意区分三种"没有可用写路径"：
         · MODE=mirror / off  ⇒ **合法**本地模式，走 original（下面那条分支，不拦）；
         · authority 存在但 mode=mirror/off ⇒ 合法，仍经 authority（isMemoryStore 为真）；
         · MODE=canonical 且 authority 缺席 ⇒ **初始化失败**，不是本地模式 ⇒ 拒绝并署名。 */
    note('memory-authority-unavailable', { store: store, mode: MODE });
    var unavailable = new Error('memory 是 Home Node 的 canonical 域，但 memoryAuthority 未装配；拒绝写入本地镜像（fail closed）');
    unavailable.code = 'memory-authority-unavailable';
    unavailable.authority = 'home-node';
    return Promise.reject(unavailable);
  }
  if (isMemoryStore(store)) {
    /* R4-A.5 · canonical content mutation **不自动重试**（AUTO_RETRY = NONE）。
       `withRetry` 对"传输层失败"会重发**同一个 payload**。对内容写而言这是危险的：
       第一次请求可能**已经在 Home Node 提交**（只是响应丢失），若期间有别的写者提交了
       新版本，重试会用旧内容覆盖新内容 —— 而 `contentFingerprint` 的幂等只在**状态未变**
       时成立（skipped），挡不住这件事。内容写没有 requestId、没有 CAS，store 是
       LAST-WRITE-WINS，因此唯一安全的做法是**不自动重放**：
         · 结局未知 ⇒ 镜像不动、把失败如实抛给调用方；
         · 用户再次点击保存 = 一次**独立的新请求**，允许。
       chat 域仍然保留原有的 withRetry（本修复只动 memory 分支）。 */
    return memoryAuthority.put(data).then(function (result) {
      if (!result || !result.ok) throwWriteError(result, data && data.id);
      note('memory-write', { id: data && data.id, outcome: result.outcome, revision: result.revision, mirrored: result.mirrored !== false });
      return undefined;
    });
  }
  if (isUnderstandingStore(store) && understandingWriteClosed()) {
    /* 理解（M1-C.2m）：**没有任何生产路径**会走到这里。
       这是一条**守卫**，而不是一条写路径 —— 它的存在是为了让"某个调用方
       又直接往 understandings 里 dbPut 一行"变成一次可见的失败，
       而不是一次静默的第二写者。所有合法写入都经 understandingAuthority：
         · 桌面请求派生 → `_understandingTick` → authority.requestDerivation
         · 用户更正     → authority.recordCorrection
       静默放行等于把 M1-C.2l 的缺陷（一个角色两份理解）重新打开。 */
    note('understanding-direct-write-blocked', { id: data && data.id, note: '写入必须经 IB.homeNode.understanding' });
    var blocked = new Error('understandings 是 Home Node 的 canonical 域；浏览器不得直接写入（fail closed）');
    blocked.code = 'understanding-write-closed';
    blocked.authority = 'home-node';
    return Promise.reject(blocked);
  }
  if (isMomentsStore(store) && momentsWriteClosed()) {
    /* 动态（M1-C.2n）：与理解**同款守卫**，但理由不完全一样。
       动态是用户可以正常编辑/删除的东西，所以这里**不是**"禁止写入"，
       而是"禁止**绕过权威**写入"。合法写法只有一条：
         · moments.js / social-network.js → IB.homeNode.moments.* → authority.put/remove
       这条守卫的作用是让"某个调用方又直接 dbPut('moments', row)"变成一次
       可见的失败，而不是一次静默的第二 canonical 写。
       静默放行等于把审计发现的那个形状重新打开：
       同一个域有两份权威，谁都不是真的权威。 */
    note('moments-direct-write-blocked', { id: data && data.id, note: '写入必须经 IB.homeNode.moments' });
    var refused = new Error('moments 是 Home Node 的 canonical 域；浏览器不得直接写入（fail closed）');
    refused.code = 'moments-write-closed';
    refused.authority = 'home-node';
    return Promise.reject(refused);
  }
  if (!isChatStore(store) || MODE !== 'canonical') return original.put(store, data);
  return withRetry(function () {
    return authority.put(data).then(function (result) {
      if (!result || !result.ok) throwWriteError(result, data && data.id);
      note('write', { id: data && data.id, outcome: result.outcome, revision: result.revision, mirrored: result.mirrored !== false });
      return undefined;   /* dbPut 原有契约就是 resolve(undefined) */
    });
  });
};

window.dbDelete = function (store, key) {
  if (store === 'memories' && MODE === 'canonical' && !memoryAuthority) {
    /* 同 dbPut：canonical-intended 且 authority 缺席 ⇒ fail closed，绝不静默本地删。 */
    note('memory-authority-unavailable', { store: store, mode: MODE, op: 'delete' });
    var unavailableDel = new Error('memory 是 Home Node 的 canonical 域，但 memoryAuthority 未装配；拒绝删除本地镜像（fail closed）');
    unavailableDel.code = 'memory-authority-unavailable';
    unavailableDel.authority = 'home-node';
    return Promise.reject(unavailableDel);
  }
  if (isMemoryStore(store)) {
    /* R4-A.5 · delete 同样是 canonical content mutation，同样**不自动重试**：
       重试的 soft delete 会删掉并发写者在两次尝试之间复原并写入的新内容。 */
    return memoryAuthority.remove(key).then(function (result) {
      if (!result || !result.ok) throwWriteError(result, key);
      note('memory-delete', { id: key, outcome: result.outcome, revision: result.revision });
      return undefined;
    });
  }
  if (isUnderstandingStore(store) && understandingWriteClosed()) {
    /* 同理：理解不是可以随手删掉的记录。用户的"我不想让你这样理解我"必须走
       更正（correction），而删除之后下一轮会重新长出同一句话 —— 正是 M1-C.2l
       的原始缺陷。这里明确拒绝，绝不静默。 */
    var refused = new Error('理解不能删除；请记录一次更正（correction）');
    refused.code = 'understanding-delete-refused';
    return Promise.reject(refused);
  }
  if (isMomentsStore(store) && momentsWriteClosed()) {
    /* 动态**可以**删除（那是正常产品能力），但必须经权威删除 —— 权威侧写墓碑、
       change_log 记 kind='delete'，镜像据此移除本地行。绕过权威直接删本地行
       会让"删除"只发生在这台机器上，另一台（或后台 companion）仍然看得见它。 */
    var refusedMoment = new Error('moments 是 Home Node 的 canonical 域；删除必须经 IB.homeNode.moments.remove');
    refusedMoment.code = 'moments-delete-closed';
    refusedMoment.authority = 'home-node';
    return Promise.reject(refusedMoment);
  }
  if (!isChatStore(store) || MODE !== 'canonical') return original.del(store, key);
  return withRetry(function () {
    return authority.remove(key).then(function (result) {
      if (!result || !result.ok) throwWriteError(result, key);
      note('delete', { id: key, outcome: result.outcome, revision: result.revision });
      return undefined;
    });
  });
};

window.dbGet = function (store, key) {
  if (isMemoryStore(store)) return memoryAuthority.get(key);
  if (isUnderstandingStore(store)) return understandingAuthority.get(key);
  /* M1-C.2n：moments 的读也走权威适配层 —— 它先 ensureReady()（把镜像补齐到
     权威的样子）再读镜像，因此页面刚打开时不会读到"迁移之前"的本地动态。
     返回形状与原来一致：Promise<row|null>（decorateRead 的标注只在诊断面用）。 */
  if (isMomentsStore(store)) return momentsAuthority.get(key).then(function (r) { return r && r.value ? r.value : null; });
  if (!isChatStore(store) || MODE !== 'canonical') return original.get(store, key);
  return authority.get(key);
};

window.dbGetAll = function (store) {
  if (isMemoryStore(store)) return memoryAuthority.getAll();
  if (isUnderstandingStore(store)) return understandingAuthority.getAll();
  if (isMomentsStore(store)) return momentsAuthority.getAll().then(function (r) { return (r && r.value) || []; });
  if (!isChatStore(store) || MODE !== 'canonical') return original.getAll(store);
  return authority.getAll();
};

window.dbGetByIndex = function (store, idx, val) {
  /* memories 在 core.js 里没有索引（召回走全表扫描 + 可见性前置过滤）。
     因此这里不接管：走原路径，保持"索引不存在时按字段过滤"的既有语义。 */
  if (isChatStore(store) && MODE === 'canonical' && idx === 'byFriend') return authority.getByFriend(val);
  /* M1-C.2m：`understandings` 只有一个索引 byCharacter，而它的唯一生产读点就是
     `unGetActive` / `unGetAll` —— 两者都必须先 await ensureReady()，否则页面刚打开时
     会读到"迁移之前"的本地理解，而权威此时已经是 Home Node。
     与 memories 的接管差异（刻意的）：memories 走全表扫描因此由 dbGetAll 接管；
     这里走索引，所以在索引函数上接管。 */
  if (isUnderstandingStore(store) && idx === 'byCharacter') return understandingAuthority.getAll(val);
  /* M1-C.2n：`moments` 的 byRole 索引同样先补齐镜像再读 —— `_momentsQueryByRole`
     是动态列表的第二个入口（第一个是 dbGetAll），漏掉它就会出现
     "按角色筛选看旧数据、总列表看新数据"这种最难查的不一致。 */
  if (isMomentsStore(store) && idx === 'byRole') return momentsAuthority.getByOwner(val).then(function (r) { return (r && r.value) || []; });
  /* 只有 byFriend 这一个索引存在（core.js:4）。其它索引名走原路径，
     保持"索引不存在时按字段过滤"的既有语义不变。 */
  return original.getByIndex(store, idx, val);
};

/* ── M1-C.2d Wave 2：canonical `memories` ─────────────────────────────
   与 chatMessages 同款三态（authority / mirror / fallback），只换一个 store。
   为什么必须在这里接管而不是"顺便镜像写一份"：
     如果浏览器继续把 IndexedDB 当权威、只把写入复制给 Node，那就是**假收敛**
     —— 两台 canonical 并存，谁都不是真的权威。因此记忆与聊天一样：
     写先到 Home Node，成功后才落镜像；Home Node 不在线就 fail closed。

   与 chatMessages 的一个**真实差异**：记忆是可变的（read-modify-write）。
     · 因此写用 Node 侧默认的 overwrite，而不是迁移期的 skip；
     · 内容等价判定排除激活遥测（否则每次强化都会让重跑变成"全部 updated"）；
     · 激活强化走**独立**通道（不推进 canonical revision）。 */
var _memoryAuthorityFactory = (window.IBMemoryAuthority && typeof window.IBMemoryAuthority.createMemoryAuthority === 'function')
  ? window.IBMemoryAuthority.createMemoryAuthority : null;
var _memoryRemoteFactory = (NS && typeof NS.createMemoryRemote === 'function')
  ? NS.createMemoryRemote : ((typeof window.createMemoryRemote === 'function') ? window.createMemoryRemote : null);

var memoryAuthority = null;
if (_memoryAuthorityFactory && _memoryRemoteFactory) {
  var memoryLocalDriver = {
    get: function (id) {
      return DB.get('memories', id).then(function (row) { return row || null; });
    },
    getAll: function () {
      return DB.getAll('memories').then(function (rows) { return rows || []; });
    },
    put: function (record) {
      return DB.put('memories', record);
    },
    remove: function (id) {
      return DB.del('memories', id);
    },
    /* 镜像侧的**激活**更新：只在两个字段上 +1。刻意逐条读改写而不是整表替换，
       因为整表替换会把 Home Node 上已删除的行重新种回来。 */
    bumpActivation: function (ids, at) {
      var list = (ids || []).map(String);
      var done = 0;
      function step(i) {
        if (i >= list.length) return Promise.resolve(done);
        return DB.get('memories', list[i]).then(function (row) {
          if (!row) return step(i + 1);
          row.activationCount = (row.activationCount || 0) + 1;
          row.lastActivated = at;
          return DB.put('memories', row).then(function () { done++; return step(i + 1); },
            function () { return step(i + 1); });
        }, function () { return step(i + 1); });
      }
      return step(0);
    },
    applyUpserts: function (records) {
      return DB.applyMemoryMirror(records || [], []);
    },
    applyDeletes: function (deletes) {
      var ids = (deletes || []).map(function (d) { return d && d.recordId; }).filter(Boolean);
      return DB.applyMemoryMirror([], ids);
    },
    /* 整表替换：Home Node 是来源。必须先清掉权威已不再拥有的行，
       否则旧影子会继续参与召回（她会"记得"一条已经被删除的记忆）。 */
    replaceAll: function (records) {
      return DB.replaceMemoryMirror(records || []);
    }
  };
  memoryAuthority = _memoryAuthorityFactory({
    remote: _memoryRemoteFactory({}),
    local: memoryLocalDriver,
    mode: MODE,
    fileOrigin: FILE_ORIGIN,
    log: function (event, fields) { note(event, fields); }
  });
  if (typeof NS.expose === 'function') NS.expose('memoryAuthority', { instance: memoryAuthority, MODES: memoryAuthority.MODES });
  else NS.memoryAuthority = memoryAuthority;
} else {
  warn('memory-authority-missing', {
    authority: !!_memoryAuthorityFactory, remote: !!_memoryRemoteFactory,
    note: 'memories 走本地 IndexedDB（Wave 2 之前的路径）'
  });
}

/* ── M1-C.2m：canonical `understandings` ──────────────────────────────
   与 chatMessages / memories 同款三态（authority / mirror / fallback），
   但写协议不同：理解是**单活文档 + 修订链 + CAS**，因此 authority 层暴露的是
   `rewrite(characterId, candidate, {expectedRevision})` 而不是 put(record)。

   与记忆的一个**真实差异**（也是本模块存在的全部理由）：
     记忆的写者一直是浏览器、权威后来才搬走；而理解的写者在 M1-C.2m 里
     **整个搬到了 Home Node**。因此这里不仅不镜像写，还**禁止**直接 dbPut ——
     一个还留着本地派生能力的浏览器就是第二个写者，正是要消灭的形状。

   local driver（镜像）：IndexedDB `understandings`。单活由 applyUpserts 结构性
   维持（权威说哪一条是 active，镜像里其它行就立刻退位），而不是靠"记得去改"。 */
var _understandingAuthorityFactory = (window.IBUnderstandingAuthority && typeof window.IBUnderstandingAuthority.createUnderstandingAuthority === 'function')
  ? window.IBUnderstandingAuthority.createUnderstandingAuthority : null;
var _understandingRemoteFactory = (NS && typeof NS.createUnderstandingRemote === 'function')
  ? NS.createUnderstandingRemote : ((typeof window.createUnderstandingRemote === 'function') ? window.createUnderstandingRemote : null);

var understandingAuthority = null;
if (_understandingAuthorityFactory && _understandingRemoteFactory) {
  var understandingLocalDriver = {
    get: function (id) {
      return DB.get('understandings', id).then(function (row) { return row || null; });
    },
    getActive: function (characterId) {
      return DB.getByIndex('understandings', 'byCharacter', characterId).then(function (rows) {
        var list = (rows || []).filter(function (u) {
          return u && u.active === true && String(u.characterId || '') === String(characterId);
        });
        /* 兼容**迁移前**的本地行（那时没有 active 布尔，只有 status 字符串）。
           这里只读不写：真正的归一由 applyUpserts / hydrate 完成。 */
        if (!list.length) {
          list = (rows || []).filter(function (u) {
            return u && u.active !== false && String(u.status || 'active') === 'active' && String(u.characterId || '') === String(characterId);
          });
        }
        list.sort(function (a, b) { return ((b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0)); });
        return list[0] || null;
      });
    },
    getAll: function (characterId) {
      if (characterId == null) return DB.getAll('understandings').then(function (rows) { return rows || []; });
      return DB.getByIndex('understandings', 'byCharacter', String(characterId)).then(function (rows) { return rows || []; });
    },
    /* 镜像写：只在权威返回之后调用。这里**不接受**任意候选 —— 它只写权威文档。 */
    put: function (doc) {
      return writeMirrorDoc(doc);
    },
    rewrite: function (characterId, next) {
      /* 非 canonical 承载（'mirror'/'off'/file://）下的本地写：沿用迁移前的
         read-modify-write 形状。这条路径**不声称**权威，status() 会如实标注。 */
      return understandingLocalDriver.getActive(String(characterId)).then(function (existing) {
        var now = Date.now();
        var doc = existing || { id: 'un_' + now.toString(36) + '_' + Math.floor(Math.random() * 46656).toString(36), characterId: String(characterId), createdAt: now };
        var current = {
          content: String((next && next.content) || '').trim(),
          conviction: Math.max(0, Math.min(100, Number(next && next.conviction) || 0)),
          evidenceIds: Array.isArray(next && next.evidenceIds) ? next.evidenceIds.slice(0, 100) : [],
          basis: String((next && next.basis) || 'ai_guess'),
          updatedAt: now,
          updatedBy: String((next && next.updatedBy) || '')
        };
        if (!current.content) return { ok: false, outcome: 'invalid', error: 'invalid-content' };
        doc.active = true;
        doc.status = 'active';
        doc.kind = 'understanding';
        doc.revision = Number(existing && existing.revision ? existing.revision : 0) + 1;
        doc.dimension = String((next && next.dimension) || 'context');
        doc.visibility = (next && next.stamp) || { visibility: 'private', visibleTo: [], excludeFrom: [] };
        doc.current = current;
        doc.lastUpdatedAt = now;
        return writeMirrorDoc(doc).then(function () {
          return { ok: true, outcome: existing ? 'updated' : 'created', id: doc.id, docRevision: doc.revision, document: doc };
        });
      });
    },
    applyUpserts: function (docs) {
      return applyUnderstandingUpserts(docs || []);
    },
    applyDeletes: function (ids) {
      var list = (ids || []).map(String);
      var work = Promise.resolve();
      for (var i = 0; i < list.length; i++) {
        work = work.then((function (id) { return function () { return DB.del('understandings', id); }; })(list[i]));
      }
      return work;
    },
    /* 整表替换：权威是来源。**镜像里的旧影子必须消失** —— 否则用户会在
       下一轮对话里继续被一份已经被权威删除的理解影响。 */
    replaceAll: function (docs) {
      return DB.getAll('understandings').then(function (existing) {
        var keep = {};
        (docs || []).forEach(function (d) { if (d && d.id != null) keep[String(d.id)] = true; });
        var stale = (existing || []).map(function (r) { return r && r.id; }).filter(function (id) { return id != null && !keep[String(id)]; });
        var work = Promise.resolve();
        for (var i = 0; i < stale.length; i++) {
          work = work.then((function (id) { return function () { return DB.del('understandings', id); }; })(stale[i]));
        }
        return work.then(function () { return applyUnderstandingUpserts(docs || []); });
      });
    }
  };

  /* 单活不变量的**镜像侧**维持点：权威说哪一条是 active，同一角色的其它行
     立刻退位（active=false / status='superseded'）。
     为什么必须在这里做而不能只信权威的 payload：镜像可能还留着迁移之前的旧行，
     而 unGetActive 是**只读**的 —— 它不会替我们清理。 */
  function applyUnderstandingUpserts(docs) {
    var work = Promise.resolve();
    docs.forEach(function (doc) {
      if (!doc || doc.id == null) return;
      work = work.then(function () { return writeMirrorDoc(doc); });
    });
    return work;
  }
  function writeMirrorDoc(doc) {
    if (!doc || doc.id == null || !doc.characterId) return Promise.resolve(false);
    return DB.getByIndex('understandings', 'byCharacter', String(doc.characterId)).then(function (rows) {
      var work = Promise.resolve();
      (rows || []).forEach(function (row) {
        if (!row || String(row.id) === String(doc.id)) return;
        if (row.active !== true && String(row.status || '') !== 'active') return;
        row.active = false;
        row.status = 'superseded';
        work = work.then(function () { return DB.put('understandings', row); });
      });
      return work.then(function () {
        var stored = Object.assign({}, doc, { active: true, status: 'active' });
        return DB.put('understandings', stored);
      });
    });
  }

  understandingAuthority = _understandingAuthorityFactory({
    remote: _understandingRemoteFactory({}),
    local: understandingLocalDriver,
    mode: MODE,
    fileOrigin: FILE_ORIGIN,
    log: function (event, fields) { note(event, fields); }
  });
  if (typeof NS.expose === 'function') NS.expose('understandingAuthority', { instance: understandingAuthority, MODES: understandingAuthority.MODES });
  else NS.understandingAuthority = understandingAuthority;
} else {
  warn('understanding-authority-missing', {
    authority: !!_understandingAuthorityFactory, remote: !!_understandingRemoteFactory,
    note: 'understandings 走本地 IndexedDB（M1-C.2m 之前的路径）'
  });
}

/* ── M1-B：角色目录发布（Desktop → Home Node）────────────────────────
    **这是 M1-B 唯一的 authority gap，必须说清楚而不是悄悄掩盖：**
     · chatMessages 的 authority 在 M1-A 已经搬到 Home Node；
     · apiConfigs（provider 配置 + 角色）**仍然是浏览器持有**，只有浏览器
       能读到明文 apiKey 与 systemPrompt。
    因此桌面按"临时目录快照"的模式把角色推给 Home Node：
       apiConfigs → mobile-dto.characterCatalogEntry()（白名单投影）
                  → POST /characters/publish
     Home Node 把 DTO 与 runtime spec 分成两张表：
       · characters               —— mobile-safe DTO，可以发给任何已认证设备；
       · character_runtime_specs  —— provider 凭据/端点/系统提示词，**永不**出站。
     于是"手机能发消息"与"手机永远看不到 apiKey"可以同时成立。

     为什么不是 Strategy B（Home Node 自己成为角色 registry）：那需要把
     apiConfigs 的 authority 整体搬到 Node，是另一个阶段的工作量，而且会立刻
     引出"谁能编辑角色"的问题。本阶段只做最小可用且**诚实**的依赖。

     发布是幂等的：Node 侧按 id upsert，未变化的目录重复发布不产生副作用。
     绝不因为发布失败而阻塞桌面 —— 首页照常打开，只是手机端会看到
     "该角色在 Home Node 上没有可运行配置"（明确报错，不静默）。 */
var CATALOG_PUBLISH_MIN_INTERVAL_MS = 5000;
var catalogPublishedAt = 0;
var catalogPublishInFlight = null;

function desktopCharacters() {
  try {
    /* window.apiConfigs 由 social.js:2445 用 ibSocialLive 注册成**活的 getter**
       （不是快照），因此这里每次读到的都是当前角色表。 */
    var configs = window.apiConfigs;
    if (!Array.isArray(configs)) return [];
    var dto = window.IBMobileDto;
    if (!dto || typeof dto.characterCatalog !== 'function') {
      /* 投影层没加载就不发布 —— 绝不"先把带 apiKey 的原始条目发出去再说"。 */
      warn('catalog-projection-missing', {});
      return null;
    }
    return dto.characterCatalog(configs, { withSpec: true });
  } catch (e) {
    warn('catalog-read-failed', { error: String((e && e.message) || e) });
    return null;
  }
}

/* P0 用户展示身份（M1-C.2c-A）。
   与 site-operations.js:66 的 buildSiteContext 同源：about/main。
   它决定手机上"她该怎么称呼我"。name 是展示信息，不是凭据。
   读不到就返回 null —— 绝不发一个空名字，因为那在 Node 侧等于
   "覆盖成空"，会让手机端在启动竞态里丢掉称呼。 */
function desktopUserProfile() {
  try {
    var dto = window.IBMobileDto;
    if (!dto || typeof dto.userProfileDto !== 'function') return null;
    var getter = (typeof dbGet === 'function') ? dbGet('about', 'main') : null;
    if (!getter || typeof getter.then !== 'function') return null;
    return getter.then(function (about) {
      return dto.userProfileDto(about) || null;
    }, function () { return null; });
  } catch (e) {
    warn('user-profile-read-failed', { error: String((e && e.message) || e) });
    return null;
  }
}

/* M1-C.2i · Middle Brain **执行策略** 投影（Desktop → Home Node）。
   为什么要发布：Home Node 要进入**同一个** Middle Brain 执行缝，就必须知道
   "这个用户把 Middle Brain 配成了什么"（是否参与、思考深度、Admission/Judge/
   Integrity 开关）。这些此前只存在于浏览器 IndexedDB 的 apiSettings['middle_brain']。

   为什么只发布策略、**绝不**发布凭据：
     投影唯一实现 = middle-brain-config-core.projectExecutionConfig()，它是构造式
     白名单，输出里根本没有 endpoint / model / apiKey 三个键。
     Home Node 因此恒"没有 Middle Brain 凭据" —— 它不需要：
       · 上下文压缩在 Node 侧只能走本地 pipeline（admission 因 apiKey 缺失 → local）；
       · Astra / Judge / Integrity 的模型调用在 Node 侧结构性不可达。
     也就是说桌面发布的是**策略**，不是**能力**。这是本阶段的核心边界。

   与角色目录的三处不同（都是刻意的）：
     ① 读的是 apiSettings['middle_brain'] 这一条**全局**记录，与角色无关；
     ② 投影失败（core 未加载）时返回 null = "这次不发布"，**绝不**退化成
        "把原始配置对象发出去再说" —— 那正是一次泄漏的形状；
     ③ 读不到配置（从未设置过）时也返回 null，不发布默认值：
        Home Node 侧缺席 = 保持已发布值；发布一份全默认的策略等于**关闭**它。 */
function desktopMiddleBrainConfig() {
  try {
    var core = window.IBMiddleBrainConfigCore;
    if (!core || typeof core.projectExecutionConfig !== 'function') {
      note('middle-brain-projection-missing', {});
      return null;
    }
    /* dbGet 是 async 的；发布路径已是 Promise 链，这里返回 Promise 由调用方 await。 */
    return Promise.resolve(window.dbGet ? dbGet('apiSettings', 'middle_brain') : null).then(function (stored) {
      if (!stored || typeof stored !== 'object') return null;
      return core.projectExecutionConfig(stored);
    }, function () { return null; });
  } catch (e) {
    note('middle-brain-read-failed', { error: String((e && e.message) || e) });
    return null;
  }
}

function publishCharacters(reason, options) {
  options = options || {};
  if (MODE !== 'canonical') return Promise.resolve({ ok: false, error: 'authority-disabled' });
  var now = Date.now();
  if (!options.force && now - catalogPublishedAt < CATALOG_PUBLISH_MIN_INTERVAL_MS) {
    return Promise.resolve({ ok: true, skipped: true });
  }
  if (catalogPublishInFlight) return catalogPublishInFlight;
  var characters = desktopCharacters();
  if (!characters) return Promise.resolve({ ok: false, error: 'catalog-unavailable' });
  if (!characters.length) {
    /* **空目录绝不发布。** Node 侧 publish 是 replace 语义（删掉不再存在的角色），
       因此"空列表"等于"把 Home Node 上整个角色目录清空"。
       启动早期 apiConfigs 还没 load 完就会出现空列表，一次空发布足以把已经配好
       的手机端目录抹掉 —— 实测在浏览器冒烟里就是这样把刚发布的角色弄丢的。
       没有角色可发布时什么都不做，并如实记一条日志。 */
    catalogPublishedAt = now;
    note('catalog-publish-skipped', { reason: reason, why: 'no-characters' });
    return Promise.resolve({ ok: true, skipped: true, reason: 'no-characters' });
  }
  /* 资料读取与目录发布并行；资料失败/缺席不阻塞目录发布。
     M1-C.2i：Middle Brain 执行策略与角色目录**同一次** POST —— 拆开会让
     "目录已更新但策略还没到"成为一个可观测的中间态（同一个角色短暂地
     在手机上用另一套认知策略）。投影失败仍发布目录，只是不带策略字段。 */
  var profilePromise = Promise.resolve(desktopUserProfile()).catch(function () { return null; });
  var mbPromise = Promise.resolve(desktopMiddleBrainConfig()).catch(function () { return null; });
  catalogPublishInFlight = Promise.all([profilePromise, mbPromise]).then(function (both) {
    var user = both[0], mbConfig = both[1];
    var publishOptions = {};
    if (user) publishOptions.user = user;
    if (mbConfig) publishOptions.middleBrain = mbConfig;
    return remoteDriver.publishCharacters(characters, publishOptions);
  }).then(function (result) {
    catalogPublishInFlight = null;
    if (result && result.ok) {
      catalogPublishedAt = Date.now();
      note('catalog-published', {
        reason: reason, count: (result.payload && result.payload.count) || characters.length,
        withSpec: result.payload && result.payload.withSpec,
        userProfile: !!(result.payload && result.payload.userProfile),
        middleBrain: !!(result.payload && result.payload.middleBrain)
      });
    } else {
      note('catalog-publish-failed', { reason: reason, error: (result && result.error) || 'unknown' });
    }
    return result;
  }, function (error) {
    catalogPublishInFlight = null;
    note('catalog-publish-failed', { reason: reason, error: String((error && error.message) || error) });
    return { ok: false, error: 'catalog-publish-failed' };
  });
  return catalogPublishInFlight;
}

/* ── 启动同步 ────────────────────────────────────────────────────────
   只在 canonical 模式下做。失败绝不阻塞页面：镜像可能稍后由
   visibilitychange / online 事件补齐。 */
var syncInFlight = null;
function syncOnce(reason, options) {
  if (MODE !== 'canonical') return Promise.resolve({ ok: true, skipped: true });
  if (syncInFlight) return syncInFlight;
  syncInFlight = authority.sync(options || {}).then(function (res) {
    syncInFlight = null;
    if (res && res.ok) note('sync', { reason: reason, cursor: res.cursor, upserts: res.upserts, deletes: res.deletes });
    else note('sync-degraded', { reason: reason, error: (res && res.error) || 'unknown' });
    return res;
  }, function (error) {
    syncInFlight = null;
    note('sync-fail', { reason: reason, error: String((error && error.message) || error) });
    return { ok: false, error: 'sync-failed' };
  });
  return syncInFlight;
}
NS.homeNodeSync = syncOnce;

function bootstrap() {
  if (MODE !== 'canonical') {
    note('authority-disabled', { mode: MODE, note: 'chatMessages + memories 走本地 IndexedDB（M1-A/Wave 2 之前的路径）' });
    return;
  }
  note('boot', { base: (typeof window.ibHomeNodeBase === 'function') ? window.ibHomeNodeBase() : '', mode: MODE });
  /* 第一件事：把**记忆镜像**从 Home Node 补齐（M1-C.2d Wave 2）。
     为什么必须在最前面、且必须主动做 —— 这是一个实测到的正确性要求，
     不是性能优化：

       记忆镜像的权威侧是 Home Node。如果推迟到"第一次读或第一次写"才补齐，
       那么在补齐发生之前写进镜像的行会被 hydrate 的整表替换清掉 ——
       因为它们此时还不在 Home Node 的返回里。实测症状：往 memories 连写 3 条
       （三条都确实落到了 Home Node），随后 dbGet 却返回 null，因为第 1 次写
       触发的 hydrate 清空了镜像，而第 2、3 条写只更新了自己那一行、
       没有重新同步。写成"读时补齐"会让失败看起来像"记忆丢了"。

     因此镜像必须在**任何**记忆写入之前就是完整的。放在最前面（早于角色目录
     发布与记忆设置发布）是关键：那两步都是网络请求，排在它们后面会重新打开
     同一个窗口。与 chatMessages 的做法一致（那次同步本来就在 boot 里做）。 */
  memorySyncOnce('boot', { full: true }).then(function () {
    return syncOnce('boot');
  }).then(function () {
    return understandingSyncOnce('boot', { full: true });
  }).then(function () {
    /* M1-C.2n：动态镜像也必须在**任何**动态写入或读取之前补齐。
       与上面两者同一条理由：读之前不补齐，页面刚打开时看到的是
       "迁移之前"的本地动态，而权威已经是 Home Node。 */
    return momentsSyncOnce('boot', { full: true });
  }).then(function () {
    return publishCharacters('boot');
  }).then(function () {
    publishMemorySettings('boot');
  });
  /* 页面重新可见 / 网络恢复时补一次同步：不在后台跑定时器，
     因为常驻 interval 会让测试 harness 无法自然退出（MEMORY.md 的测试纪律）。 */
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { syncOnce('visibility'); memorySyncOnce('visibility'); understandingSyncOnce('visibility'); momentsSyncOnce('visibility'); }
    });
    window.addEventListener('online', function () { syncOnce('online'); memorySyncOnce('online'); understandingSyncOnce('online'); momentsSyncOnce('online'); });
  } catch (e) { /* 无 document 的环境（测试）不影响功能 */ }
}

/* 记忆镜像同步（幂等）：只在 canonical 模式且 authority 存在时做。
   options.full 走 hydrate（整表以 Home Node 为准重建），否则走增量。
   boot 用 full:true —— 保证镜像在任何写入之前就是完整的。 */
var memorySyncInFlight = null;
function memorySyncOnce(reason, options) {
  if (MODE !== 'canonical' || !memoryAuthority) return Promise.resolve({ ok: true, skipped: true });
  if (memorySyncInFlight) return memorySyncInFlight;
  memorySyncInFlight = memoryAuthority.sync(options || {}).then(function (res) {
    memorySyncInFlight = null;
    if (res && res.ok) note('memory-sync', { reason: reason, cursor: res.cursor, upserts: res.upserts, deletes: res.deletes });
    else note('memory-sync-degraded', { reason: reason, error: (res && res.error) || 'unknown' });
    return res;
  }, function (error) {
    memorySyncInFlight = null;
    note('memory-sync-fail', { reason: reason, error: String((error && error.message) || error) });
    return { ok: false, error: 'sync-failed' };
  });
  return memorySyncInFlight;
}

/* ── M1-C.2n：canonical Moments 的挂载点 ──────────────────────────────
   与 memory / understanding **同款**三态与写纪律，但 local driver 不同：
   moments 有 byRole / byCreated 两个索引，没有 byCharacter/active 那一套。

   与理解的**关键差异**（也是本段存在的理由）：理解的写者在 M1-C.2m 整体搬到了
   Home Node，浏览器只发"请求派生"；而动态有两个真实写者（用户界面 + 后台
   companion），因此这里既要提供写通道，也必须在权威生效时**拒绝**绕过它的
   直接写 —— 一个还能自己落盘的浏览器就是第二个 canonical。 */
var _momentsAuthorityFactory = (window.IBMomentsAuthority && typeof window.IBMomentsAuthority.createMomentsAuthority === 'function')
  ? window.IBMomentsAuthority.createMomentsAuthority : null;
var _momentsRemoteFactory = (NS && typeof NS.createMomentsRemote === 'function')
  ? NS.createMomentsRemote : ((typeof window.createMomentsRemote === 'function') ? window.createMomentsRemote : null);

var momentsAuthority = null;
if (_momentsAuthorityFactory && _momentsRemoteFactory) {
  var momentsLocalDriver = {
    get: function (id) {
      return DB.get('moments', id).then(function (row) { return row || null; });
    },
    getAll: function () {
      return DB.getAll('moments').then(function (rows) { return rows || []; });
    },
    getByOwner: function (roleId) {
      return DB.getByIndex('moments', 'byRole', String(roleId)).then(function (rows) { return rows || []; });
    },
    put: function (row) {
      if (!row || row.id == null) return Promise.resolve(false);
      return DB.put('moments', row).then(function () { return true; });
    },
    remove: function (id) {
      return DB.del('moments', id).then(function () { return true; });
    },
    /* 整表替换：权威是来源。**镜像里的旧影子必须消失** —— 否则用户会继续看到
       一条已经被权威删除的动态。

       P11-3F：这里改成 core.js 的 `replaceMomentsMirror`（clear + put 在**同一个**
       IndexedDB 事务里）。原先的"getAll 算 stale → 逐条 del → 逐条 put"是一串
       独立事务，中途失败会留下半旧半新的镜像 —— 与 memory / chatMessages 早在
       Wave 2 就用上的原语不一致，而一致性正是本阶段要的东西。 */
    replaceAll: function (rows) {
      return DB.replaceMomentsMirror(rows || []);
    },
    /* 迁移水位：存 meta 表（与 memory/understanding 同款），绝不写进 moments 行。 */
    markMigrated: function (source, patch) {
      return DB.put('meta', { key: 'migration:moments:' + String(source || 'default'), value: JSON.stringify(patch || {}) })
        .then(function () { return { ok: true, source: source, state: patch || {} }; }, function () { return { ok: false, error: 'meta-write-failed' }; });
    },
    /* ── P11-3G · 投递状态（delivery state）──────────────────────────────
       同一张 meta 表、同一个 store：存的是**投递记账**（ACK 水位 / attempts /
       终态），不是动态内容。因此它**不是**第二套 Moments authority ——
       权威仍然只有 Home Node 一份，镜像仍然只是镜像。

       键由 moments-authority 决定并作为参数传进来（键的格式只在一处定义）。
       读不出来时返回 null 而不是抛：调用方据此如实标注"投递状态不可持久"，
       而**不是**把"读不到"当成"没有欠账"。 */
    deliveryState: function (key) {
      return DB.get('meta', String(key)).then(function (row) {
        if (!row || typeof row.value !== 'string' || !row.value) return null;
        try { return JSON.parse(row.value); } catch (error) { return null; }
      });
    },
    saveDeliveryState: function (key, state) {
      return DB.put('meta', { key: String(key), value: JSON.stringify(state || {}) }).then(function () { return true; });
    }
  };

  momentsAuthority = _momentsAuthorityFactory({
    remote: _momentsRemoteFactory({}),
    local: momentsLocalDriver,
    mode: MODE,
    fileOrigin: FILE_ORIGIN,
    log: function (event, fields) { note(event, fields); }
  });
  if (typeof NS.expose === 'function') NS.expose('momentsAuthority', { instance: momentsAuthority, MODES: momentsAuthority.MODES });
  else NS.momentsAuthority = momentsAuthority;
} else {
  warn('moments-authority-missing', {
    authority: !!_momentsAuthorityFactory, remote: !!_momentsRemoteFactory,
    note: 'moments 走本地 IndexedDB（M1-C.2n 之前的路径）'
  });
}

/* Moments 域是否**结构性**由 Home Node 独占（与 understandingWriteClosed 同款）。
   与 isMomentsStore 刻意不同：那个只说"这个 store 已被接管"（读走权威），
   这个说"浏览器不允许再直接写它"。两者在 file:// / mode=off / mirror 下必须分开 ——
   那些承载下权威不可达，本地写是回滚路径，一并拒绝等于"关掉集成之后功能直接坏掉"。 */
function momentsWriteClosed() {
  return !!momentsAuthority && typeof momentsAuthority.authorityEffective === 'function'
    && momentsAuthority.authorityEffective() === true;
}
function isMomentsStore(store) { return store === 'moments' && !!momentsAuthority; }

/* 理解镜像同步（幂等）：与 memorySyncOnce 同款，只换 store。
   boot 用 full:true —— 保证镜像在任何读取之前就是权威的样子（否则页面刚打开时
   会读到"迁移之前"的本地理解，而权威此时已经是 Home Node）。 */
var understandingSyncInFlight = null;
function understandingSyncOnce(reason, options) {
  if (MODE !== 'canonical' || !understandingAuthority) return Promise.resolve({ ok: true, skipped: true });
  if (understandingSyncInFlight) return understandingSyncInFlight;
  understandingSyncInFlight = understandingAuthority.sync(options || {}).then(function (res) {
    understandingSyncInFlight = null;
    if (res && res.ok) note('understanding-sync', { reason: reason, cursor: res.cursor, upserts: res.upserts, deletes: res.deletes });
    else note('understanding-sync-degraded', { reason: reason, error: (res && res.error) || 'unknown' });
    return res;
  }, function (error) {
    understandingSyncInFlight = null;
    note('understanding-sync-fail', { reason: reason, error: String((error && error.message) || error) });
    return { ok: false, error: 'sync-failed' };
  });
  return understandingSyncInFlight;
}

/* 动态镜像同步（幂等）：与上面两者同款，只换 store。 */
var momentsSyncInFlight = null;
function momentsSyncOnce(reason, options) {
  if (MODE !== 'canonical' || !momentsAuthority) return Promise.resolve({ ok: true, skipped: true });
  if (momentsSyncInFlight) return momentsSyncInFlight;
  momentsSyncInFlight = momentsAuthority.sync(options || {}).then(function (res) {
    momentsSyncInFlight = null;
    if (res && res.ok) note('moments-sync', { reason: reason, cursor: res.cursor, upserts: res.upserts, deletes: res.deletes });
    else note('moments-sync-degraded', { reason: reason, error: (res && res.error) || 'unknown' });
    return res;
  }, function (error) {
    momentsSyncInFlight = null;
    note('moments-sync-fail', { reason: reason, error: String((error && error.message) || error) });
    return { ok: false, error: 'sync-failed' };
  });
  return momentsSyncInFlight;
}

/* 把桌面的记忆预算发布给 Home Node。
   必须发布：预算/contentLen 直接决定哪些记忆进入 prompt。Node 用自己的缺省
   而桌面用用户设置，会让两边在**同一份** canonical 数据上给出不同召回。
   失败绝不阻塞桌面 —— 这只是同步一个设置值。 */
function publishMemorySettings(reason) {
  if (MODE !== 'canonical' || !memoryAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
  var settingsPromise = (typeof getMemorySettings === 'function')
    ? Promise.resolve(getMemorySettings()).catch(function () { return null; })
    : Promise.resolve(null);
  return settingsPromise.then(function (settings) {
    if (!settings) return { ok: false, error: 'settings-unavailable' };
    return memoryAuthority.publishSettings(settings).then(function (res) {
      note(res && res.ok ? 'memory-settings-published' : 'memory-settings-publish-failed', {
        reason: reason, budget: settings.budget, contentLen: settings.contentLen, error: res && res.error
      });
      return res;
    });
  }, function () { return { ok: false, error: 'settings-publish-failed' }; });
}

/* ── R4-C LIVE-2.1：运行时记忆解释（**唯一**动词 · 非持久 · 显式调用）────────
   与 memory / understanding / moments 三个 surface 的**结构性**差异：

     · 这里没有 authority、没有 mirror、没有 sync、没有回退。那三套语义存在的
       理由是它们身后有一条持久权威链（revision / CAS / 水位 / 迁移），而运行时
       解释按定义是**非持久**的（服务端自述 durable:false）：它不写任何 store、
       不推进任何 revision。给它配一个"镜像"就等于凭空造出第二个状态源。

     · 工厂缺席时**如实**降级并留一条可诊断的 warn，而不是发明一个会静默失败的
       对象 —— 与上面三个 remote 同一条纪律。

   ★ 无定时器、无 per-turn hook、**无自动调用**：这一层不决定"什么时候解释"，
     那是调用方显式的事。这也是本阶段"零自动成本"的结构性保证 ——
     没有调用点，就没有 token 消耗。 */
var _runtimeRemoteFactory = (NS && typeof NS.createRuntimeRemote === 'function')
  ? NS.createRuntimeRemote : ((typeof window.createRuntimeRemote === 'function') ? window.createRuntimeRemote : null);
var runtimeRemote = _runtimeRemoteFactory ? _runtimeRemoteFactory({}) : null;
if (!runtimeRemote) {
  warn('runtime-authority-missing', {
    remote: !!_runtimeRemoteFactory,
    note: '运行时解释边界不可用（home-node-client.js 未加载或版本不匹配）'
  });
}

/* ── public surface：诊断 / 迁移 / 状态 ────────────────────────────── */
var surface = {
  mode: MODE,
  authority: authority,
  status: function () { return authority.status(); },
  sync: syncOnce,
  probe: function () { return authority.probe().then(function (r) { note('probe', r); return r; }); },
  /* 一次性迁移：浏览器旧历史 → Home Node canonical store。幂等、可重复运行。 */
  migrate: function (options) {
    options = options || {};
    note('migrate-start', { source: options.source || 'browser-indexeddb' });
    return authority.migrate(options).then(function (report) {
      note(report && report.ok ? 'migrate-done' : 'migrate-fail', {
        created: report && report.created, skipped: report && report.skipped,
        total: report && report.total, error: report && report.error,
        completed: report && report.completed
      });
      return report;
    });
  },
  /* 用 Home Node 完整重建镜像。显式调用，绝不自动执行。 */
  rebuildMirror: function (options) { return authority.rebuild(options); },
  /* M1-B：把当前 apiConfigs 投影成 mobile-safe 角色目录并发布到 Home Node。
     桌面在角色保存后可以显式调用；启动时也会自动发一次。
     返回的是 Home Node 的响应（ok/payload）或 {ok:false,error}。 */
  publishCharacters: function (reason, options) { return publishCharacters(reason || 'manual', options); },
  /* M1-B：设备与配对（桌面特权面，localhost only）。 */
  pairing: {
    create: function (options) { return remoteDriver.pairingSession(options || {}); },
    list: function () { return remoteDriver.devices(); },
    revoke: function (deviceId) { return remoteDriver.revokeDevice(deviceId); }
  },
  characters: function () { return remoteDriver.characterCatalog(); },
  remote: remoteDriver,
  log: function () { return (NS.homeNodeLog || []).slice(); },
  /* ── M1-C.2d Wave 2：canonical memory 的可观测面 ────────────────────
     权威状态必须**显式**可读，而不是让用户/支持人员去猜 IndexedDB 还是
     Home Node 说了算。status() 给出 authority / authorityEffective /
     degraded / degradedReason，与 chat 的 status() 同形。 */
  memory: {
    instance: memoryAuthority,
    available: !!memoryAuthority,
    authority: memoryAuthority,
    status: function () {
      if (!memoryAuthority) {
        return { store: 'memories', available: false, authority: 'indexeddb', authorityEffective: false, degraded: true, degradedReason: 'memory-authority-missing' };
      }
      return memoryAuthority.status();
    },
    sync: memorySyncOnce,
    /* 一次性迁移：浏览器 memories → Home Node canonical store。幂等、可重复运行。 */
    migrate: function (options) {
      options = options || {};
      if (!memoryAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      note('memory-migrate-start', { source: options.source || 'browser-indexeddb:memory', full: !!options.full });
      return memoryAuthority.migrate(options).then(function (report) {
        note(report && report.ok ? 'memory-migrate-done' : 'memory-migrate-fail', {
          created: report && report.created, skipped: report && report.skipped,
          total: report && report.total, error: report && report.error,
          completed: report && report.completed
        });
        return report;
      });
    },
    /* 用 Home Node 完整重建记忆镜像。显式调用，绝不自动执行。 */
    rebuildMirror: function (options) {
      if (!memoryAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return memoryAuthority.rebuild(options || {});
    },
    publishSettings: publishMemorySettings,
    /* 本轮记忆选择的来源自检：读一次但不落任何强化（诊断用）。 */
    peek: function (characterId, options) {
      if (!memoryAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return memoryAuthority.getAll().then(function (rows) {
        var core = window.IBMemoryRetrievalCore;
        if (!core) return { ok: false, error: 'retrieval-core-missing' };
        var opts = options || {};
        return core.buildMemoryContext(rows || [], {
          apiId: String(characterId || ''),
          now: Date.now(),
          random: Math.random,
          userMessage: opts.userMessage || '',
          isGroup: false,
          groupMemEnabled: false,
          maxChars: opts.maxChars || core.DEFAULT_BUDGET_CHARS,
          contentLen: opts.contentLen || core.DEFAULT_CONTENT_LEN
        });
      });
    }
  },
  /* ── M1-C.2m：canonical Understanding 的可观测面 ──────────────────────
     与 memory 同款：权威状态必须显式可读，而不是让人去猜"到底谁说了算"。
     这里的 `derive` 是**请求**而不是"派生"：真正的派生发生在 Home Node，
     由它的持久水位决定要不要调模型，并把 {outcome:'ineligible', skipReason}
     如实回报 —— 因此"桌面开着就烧 token"在结构上不可能发生。 */
  understanding: {
    instance: understandingAuthority,
    available: !!understandingAuthority,
    authority: understandingAuthority,
    status: function () {
      if (!understandingAuthority) {
        return { store: 'understandings', available: false, authority: 'indexeddb', authorityEffective: false, degraded: true, degradedReason: 'understanding-authority-missing' };
      }
      return understandingAuthority.status();
    },
    sync: understandingSyncOnce,
    /* 请求 Home Node 派生一次（是否真的派生由节点水位判定）。 */
    derive: function (characterId, options) {
      if (!understandingAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return understandingAuthority.requestDerivation(characterId, options || {}).then(function (res) {
        note('understanding-derive-request', {
          characterId: characterId, outcome: res && res.outcome, skipReason: res && res.skipReason
        });
        return res;
      });
    },
    /* 用户更正：durable evidence about the understanding itself（§1）。 */
    correct: function (characterId, input) {
      if (!understandingAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return understandingAuthority.recordCorrection(characterId, input || {}).then(function (res) {
        note(res && res.ok ? 'understanding-correction-recorded' : 'understanding-correction-failed', {
          characterId: characterId, outcome: res && res.outcome, error: res && res.error
        });
        return res;
      });
    },
    corrections: function (characterId) {
      if (!understandingAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled', corrections: [] });
      return understandingAuthority.listCorrections(characterId);
    },
    /* 一次性迁移：浏览器遗留理解 → Home Node canonical store（幂等、可重跑）。
       绝不自动执行：它会把本地行发布到权威，而"什么时候发布"是用户/运维的决定。 */
    migrate: function (options) {
      options = options || {};
      if (!understandingAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      note('understanding-migrate-start', { source: options.source || 'browser-indexeddb:understanding', full: !!options.full });
      return understandingAuthority.migrate(options).then(function (report) {
        note(report && report.ok ? 'understanding-migrate-done' : 'understanding-migrate-fail', {
          created: report && report.created, skipped: report && report.skipped, total: report && report.total,
          ambiguous: report && report.ambiguous, preserved: report && report.preserved,
          error: report && report.error, completed: report && report.completed
        });
        return report;
      });
    },
    /* 用 Home Node 完整重建镜像。显式调用，绝不自动执行。 */
    rebuildMirror: function (options) {
      if (!understandingAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return understandingAuthority.rebuild(options || {});
    }
  },
  /* ── M1-C.2n：canonical Moments 的可观测面 ────────────────────────────
     与 memory / understanding 同款：权威状态必须显式可读，而不是让人去猜
     "IndexedDB 还是 Home Node 说了算"。
     与理解的关键差异：动态**有正常写通道**（用户发帖/编辑/删除、后台 companion
     回传），因此这里提供 put / remove 而不是 requestDerivation。 */
  moments: {
    instance: momentsAuthority,
    available: !!momentsAuthority,
    authority: momentsAuthority,
    status: function () {
      if (!momentsAuthority) {
        return { store: 'moments', available: false, authority: 'indexeddb', authorityEffective: false, degraded: true, degradedReason: 'moments-authority-missing' };
      }
      return momentsAuthority.status();
    },
    sync: momentsSyncOnce,
    /* 写一条动态：成功之后**才**更新镜像；冲突**不**写镜像（镜像必须保持权威的样子）。 */
    put: function (record, options) {
      options = options || {};
      if (!momentsAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return momentsAuthority.put(record, options).then(function (res) {
        note(res && res.ok ? 'moments-put' : 'moments-put-rejected', {
          id: res && res.id, outcome: res && res.outcome, error: res && res.error, revision: res && res.revision
        });
        return res;
      });
    },
    remove: function (id, options) {
      options = options || {};
      if (!momentsAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return momentsAuthority.remove(id, options).then(function (res) {
        note(res && res.ok ? 'moments-remove' : 'moments-remove-rejected', {
          id: id, outcome: res && res.outcome, error: res && res.error
        });
        return res;
      });
    },
    /* 一次性迁移：浏览器遗留动态 → Home Node canonical store（幂等、可重跑）。
       绝不自动执行：它会把本地行发布到权威，而"什么时候发布"是用户/运维的决定。 */
    migrate: function (options) {
      options = options || {};
      if (!momentsAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      note('moments-migrate-start', { source: options.source || 'browser-indexeddb:moments' });
      return momentsAuthority.migrate(options).then(function (report) {
        note(report && report.ok ? 'moments-migrate-done' : 'moments-migrate-fail', {
          created: report && report.created, skipped: report && report.skipped,
          total: report && report.total, rejected: report && report.migrateRejected,
          error: report && report.error, completed: report && report.completed
        });
        return report;
      });
    },
    rebuildMirror: function (options) {
      if (!momentsAuthority) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return momentsAuthority.rebuild(options || {});
    }
  },
  /* ── R4-C LIVE-2.1：运行时记忆解释的可观测面 ──────────────────────────
     与上面三个面**故意不同形**：没有 status()/sync()/migrate()/rebuildMirror()，
     因为那些动词都属于"持久权威的三态语义"，而这个边界按定义非持久。
     这里只有 instance（诊断用）与那两个**具名边界**动词
     （LIVE-3.4 加了召回：两条边界，不是一个通用出口）。 */
  runtime: {
    instance: runtimeRemote,
    available: !!runtimeRemote,
    /* 唯一的动词。工厂缺席时返回一个**形状稳定**的失败对象（而不是抛异常）：
       调用方不必为"这一层没加载"写一条 try/catch，而失败理由也不会伪装成
       服务端的裁决词 —— `runtime-remote-missing` 是**客户端**诊断，
       服务端的词表（timeout-authority-missing / credential-unavailable /
       request-field-forbidden …）只由服务端给出。 */
    runMemoryInterpretation: function (input, options) {
      if (!runtimeRemote) {
        return Promise.resolve({
          ok: false, durable: false, items: [], rejected: [], missingFor: [],
          counts: { requested: 0, returned: 0 },
          model: { providerClass: null, modelId: null, latencyMs: null, status: 'runtime-remote-missing', attempts: 0 },
          reasonCodes: ['runtime-remote-missing'],
          metaMemoryState: null, recollectionQuality: null,
          error: 'runtime-remote-missing'
        });
      }
      return runtimeRemote.runMemoryInterpretation(input || {}, options || {});
    },
    /* ── R4-C LIVE-3.4：运行时**召回**边界 ───────────────────────────────
       与上面那个动词**逐字同门**（同一个 remote、同一条凭据路径、同一套错误
       信封纪律），但它是**另一条边界**：召回在本地读 canonical 记忆、不出网；
       解释才出网花钱。所以这里不是"给解释加了个参数"，而是第二个具名动词。
       工厂缺席时的降级信封与**服务端的召回失败信封同形**（14 键 + error），
       于是调用方读 `res.ok` / `res.selectedIds` / `res.boundary` 时不必先判断
       "这一层有没有加载"。`operation` 在这里是客户端字面量：服务端那份权威
       常量在 services/home-node/runtime-recall.js#PATH / #OPERATION。 */
    runMemoryRecall: function (input, options) {
      if (!runtimeRemote) {
        return Promise.resolve({
          ok: false, durable: false, operation: 'memory-recall',
          characterId: null, turnIdentity: null, selectedIds: [],
          activationPolicy: null, channel: null, reason: null, fingerprint: null,
          counts: { candidates: 0, eligible: 0, selected: 0 }, chars: 0,
          boundary: {
            pureShadow: true, exposureWrites: 0, activationWrites: 0, providerCalls: 0,
            sessionMutation: 'NONE', transportScope: 'DESKTOP_ONLY',
            recallSelectionAuthority: 'CALLER_PROPOSED', attempts: 0
          },
          error: 'runtime-remote-missing', reasonCode: 'runtime-remote-missing'
        });
      }
      return runtimeRemote.runMemoryRecall(input || {}, options || {});
    }
  }
};

/* 按本仓库命名空间约定注册（IB.expose 幂等合并，支持点路径）。
   直接赋值 NS.homeNode 也可以，但走 expose 与其余 50 个领域文件一致，
   并且未来给 IB 加只读保护时不会静默失效。 */
if (typeof NS.expose === 'function') NS.expose('homeNode', surface);
else NS.homeNode = surface;

bootstrap();

})(window.IB || (window.IB = {}));
