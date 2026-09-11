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

/* 策略层来自 assets/js/chat-authority.js（UMD，裸全局 IBChatAuthority ——
   与 chat-core.js / ib-model-core.js / provider-directory.js 同款约定，
   不是 IB.* 成员）。
   传输层来自 assets/js/home-node-client.js（按本仓库命名空间约定属于 IB.*）。
   两者位置不同是既有约定使然，必须各自读对：读错只会**静默早退**，
   表现成"页面完全没有 Home Node 能力"而没有任何可见错误（实测踩过）。 */
var _authorityFactory = (window.IBChatAuthority && typeof window.IBChatAuthority.createChatAuthority === 'function')
  ? window.IBChatAuthority.createChatAuthority
  : ((typeof window.createChatAuthority === 'function') ? window.createChatAuthority : null);
if (!_authorityFactory) return;
if (!window.__ibCoreDb) { console.warn('[HomeNode] core.js 接缝未就绪，跳过接管'); return; }

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
if (!_remoteFactory) { warn('remote-driver-missing', { ibHas: typeof (NS && NS.createHomeNodeRemote) }); return; }
var remoteDriver = _remoteFactory({});

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

/* ── 接管 chatMessages 的五个数据访问助手 ─────────────────────────────
   只包装 chatMessages；任何其它 store 逐字走原函数。
   返回形状必须与原来**完全一致**（数组 / 对象 / undefined），
   否则 91 个调用点里的某些会立刻坏掉。 */
function isChatStore(store) { return store === 'chatMessages'; }

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
  if (!isChatStore(store) || MODE !== 'canonical') return original.get(store, key);
  return authority.get(key);
};

window.dbGetAll = function (store) {
  if (!isChatStore(store) || MODE !== 'canonical') return original.getAll(store);
  return authority.getAll();
};

window.dbGetByIndex = function (store, idx, val) {
  if (!isChatStore(store) || MODE !== 'canonical') return original.getByIndex(store, idx, val);
  /* 只有 byFriend 这一个索引存在（core.js:4）。其它索引名走原路径，
     保持"索引不存在时按字段过滤"的既有语义不变。 */
  if (idx !== 'byFriend') return original.getByIndex(store, idx, val);
  return authority.getByFriend(val);
};

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
  /* 资料读取与目录发布并行；资料失败/缺席不阻塞目录发布。 */
  var profilePromise = Promise.resolve(desktopUserProfile()).catch(function () { return null; });
  catalogPublishInFlight = profilePromise.then(function (user) {
    return remoteDriver.publishCharacters(characters, user ? { user: user } : {});
  }).then(function (result) {
    catalogPublishInFlight = null;
    if (result && result.ok) {
      catalogPublishedAt = Date.now();
      note('catalog-published', {
        reason: reason, count: (result.payload && result.payload.count) || characters.length,
        withSpec: result.payload && result.payload.withSpec,
        userProfile: !!(result.payload && result.payload.userProfile)
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
    note('authority-disabled', { mode: MODE, note: 'chatMessages 走本地 IndexedDB（M1-A 之前的路径）' });
    return;
  }
  note('boot', { base: (typeof window.ibHomeNodeBase === 'function') ? window.ibHomeNodeBase() : '', mode: MODE });
  /* 先同步聊天镜像，再发布角色目录。
     顺序刻意如此：目录发布失败不该影响镜像同步，而镜像同步成功说明 Home Node
     在线，此时发布才有意义（否则只是白跑一次网络请求）。 */
  syncOnce('boot').then(function () {
    publishCharacters('boot');
  });
  /* 页面重新可见 / 网络恢复时补一次同步：不在后台跑定时器，
     因为常驻 interval 会让测试 harness 无法自然退出（MEMORY.md 的测试纪律）。 */
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') syncOnce('visibility');
    });
    window.addEventListener('online', function () { syncOnce('online'); });
  } catch (e) { /* 无 document 的环境（测试）不影响功能 */ }
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
  log: function () { return (NS.homeNodeLog || []).slice(); }
};

/* 按本仓库命名空间约定注册（IB.expose 幂等合并，支持点路径）。
   直接赋值 NS.homeNode 也可以，但走 expose 与其余 50 个领域文件一致，
   并且未来给 IB 加只读保护时不会静默失效。 */
if (typeof NS.expose === 'function') NS.expose('homeNode', surface);
else NS.homeNode = surface;

bootstrap();

})(window.IB || (window.IB = {}));
