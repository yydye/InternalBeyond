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
  if (isMemoryStore(store)) {
    /* 记忆：fail closed。写失败必须让调用方看到失败，绝不静默写第二份 canonical。
       与 chat 一样重试镜像/传输层的瞬时失败，但不重试明确的拒绝。 */
    return withRetry(function () {
      return memoryAuthority.put(data).then(function (result) {
        if (!result || !result.ok) throwWriteError(result, data && data.id);
        note('memory-write', { id: data && data.id, outcome: result.outcome, revision: result.revision, mirrored: result.mirrored !== false });
        return undefined;
      });
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
  if (isMemoryStore(store)) {
    return withRetry(function () {
      return memoryAuthority.remove(key).then(function (result) {
        if (!result || !result.ok) throwWriteError(result, key);
        note('memory-delete', { id: key, outcome: result.outcome, revision: result.revision });
        return undefined;
      });
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
  if (!isChatStore(store) || MODE !== 'canonical') return original.get(store, key);
  return authority.get(key);
};

window.dbGetAll = function (store) {
  if (isMemoryStore(store)) return memoryAuthority.getAll();
  if (isUnderstandingStore(store)) return understandingAuthority.getAll();
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
    return publishCharacters('boot');
  }).then(function () {
    publishMemorySettings('boot');
  });
  /* 页面重新可见 / 网络恢复时补一次同步：不在后台跑定时器，
     因为常驻 interval 会让测试 harness 无法自然退出（MEMORY.md 的测试纪律）。 */
  try {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { syncOnce('visibility'); memorySyncOnce('visibility'); understandingSyncOnce('visibility'); }
    });
    window.addEventListener('online', function () { syncOnce('online'); memorySyncOnce('online'); understandingSyncOnce('online'); });
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
  }
};

/* 按本仓库命名空间约定注册（IB.expose 幂等合并，支持点路径）。
   直接赋值 NS.homeNode 也可以，但走 expose 与其余 50 个领域文件一致，
   并且未来给 IB 加只读保护时不会静默失效。 */
if (typeof NS.expose === 'function') NS.expose('homeNode', surface);
else NS.homeNode = surface;

bootstrap();

})(window.IB || (window.IB = {}));
