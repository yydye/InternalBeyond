/* ====================================================================
   IB Chat Authority — runtime-neutral authority / mirror / fallback policy
   --------------------------------------------------------------------
   UMD 双载（D10）：Browser <script src="assets/js/chat-authority.js"> → window.IBChatAuthority
                    Node   require('../assets/js/chat-authority.js')（测试用）

   本文件只做**策略**，不做 I/O：
     · remote —— Home Node 客户端（HTTP），由调用方注入
     · local  —— 浏览器 IndexedDB 镜像驱动，由调用方注入
   因此它可以在 Node 里用 mock 完整测试，而浏览器只负责把真实的
   fetch / IndexedDB 包装成两个驱动。

   ── 三者的定义（本阶段的验收要求，必须逐字成立）──────────────────────

   Authority（权威）= Home Node 的 canonical SQLite store。
       唯一拥有 message id 的分配权、revision 分配权与变更日志。
       任何一个字段如果不是从 Home Node 读到的，它就不是权威值。

   Mirror（镜像）= 浏览器 IndexedDB 的 chatMessages。
       **派生副本**，不是第二套事实。它存在的唯一理由是两个：
         (1) 历史读取的性能与离线可读性 —— 全库扫描（dbGetAll / byFriend）
             在浏览器里是 91 个既有调用点的共同形态，走本地副本才不会把
             几 MB 的内联 base64 图片反复搬过 HTTP；
         (2) 回滚影子 —— M1-A 期间旧路径必须随时可用。
       镜像永远可以被 Home Node 完整重建（rebuild()），
       因此它丢数据不是事故，Home Node 丢数据才是。

   Fallback（回退）= 当 Home Node **不可用**时的降级行为。
       读：继续从镜像读（可能是陈旧的），并标记 degraded；绝不假装是最新。
       写：**fail closed** —— 默认拒绝写入并返回明确错误，绝不在本机
           悄悄写一份"另一个 canonical"。这是审计 §1.7 明确禁止的双 canonical。
       唯一的例外是用户在配置里显式选择 'mirror' 模式（见 MODES）。

   ── 为什么写必须 fail closed ──────────────────────────────────────────
   审计 §3（R7）记录了「两个 writer 会打破 active-diary.js:1301 的 message_id
   存在性守卫」。如果浏览器在 Home Node 离线时继续写 IndexedDB 并认为成功，
   那么接下来会出现三条互不相认的历史（Home Node / 镜像 / 另一台客户端），
   而这正是整个 B 方案要消灭的东西。宁可让用户看到"发不出去"，
   也不要让世界分裂。

   ── 模式 ──────────────────────────────────────────────────────────────
     'canonical'（默认）—— Home Node 是权威；写失败即失败（fail closed）
     'mirror'           —— 兼容/回滚模式：完全按 M1-A 之前的方式本地读写，
                           **不**声称 Home Node 权威（用于用户明确选择回滚）
     'off'              —— 完全关闭 Home Node 集成（等同 'mirror'，但连
                           探测都不做；供诊断与 P7 隔离测试使用）
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('./chat-core.js')); }
  else { root.IBChatAuthority = factory(root.IBChatCore); }
})(typeof self !== 'undefined' ? self : this, function (CHAT_CORE) {
  'use strict';

  var MODES = ['canonical', 'mirror', 'off'];
  var DEFAULT_SYNC_INTERVAL_MS = 15000;

  function createChatAuthority(deps) {
    deps = deps || {};
    var remote = deps.remote || null;
    var local = deps.local || null;
    var clock = deps.clock || function () { return Date.now(); };
    var log = deps.log || function () {};
    var mode = MODES.indexOf(deps.mode) >= 0 ? deps.mode : 'canonical';
    /* file:// 承载：Chrome 会**在网络层直接阻断** file:// 页面到 loopback 的 fetch
       （实测 corsError=MissingAllowOriginHeader / 预检 PreflightMissingAllowOriginHeader，
       请求根本不会到达服务端），与响应头怎么设无关。
       产品的正常启动链是 runtime/launch-internal-beyond.js:19 打开
       http://127.0.0.1:23120/InternalBeyond.html，那条路径完全正常；
       双击 InternalBeyond.html（file://）是既有支持方式，但它**不可能**访问
       Home Node。此时唯一安全的做法是退回本地 IndexedDB 并显式声明未生效，
       既不假装权威生效，也不让桌面聊天坏掉。见 docs/HOME_NODE_CHAT.md §8。 */
    var fileOrigin = !!deps.fileOrigin;

    var ctx = {
      mode: mode,
      fileOrigin: fileOrigin,
      remoteOnline: null,      /* null = 尚未探测 */
      hydrated: false,         /* 镜像是否已经从 Home Node 补齐过 */
      cursor: 0,               /* 已应用到镜像的 revision */
      degradedReason: mode === 'canonical'
        ? (fileOrigin ? 'file-origin-cannot-reach-home-node' : 'not-probed')
        : (mode === 'mirror' ? 'mode-mirror' : 'mode-off'),
      lastSyncAt: 0,
      lastError: null,
      stats: { reads: 0, writes: 0, remoteReads: 0, remoteWrites: 0, skippedWrites: 0, failures: 0, syncs: 0, hydrations: 0, localOnlyWrites: 0 }
    };

    function remoteEnabled() { return !!remote && (mode === 'canonical') && !fileOrigin; }
    function ensureDrivers() {
      if (!local) throw new Error('chat-authority: local driver is required');
    }

    function fail(code, extra) {
      ctx.stats.failures++;
      return Object.assign({ ok: false, error: code, authority: mode === 'canonical' ? 'home-node' : 'indexeddb' }, extra || {});
    }
    function noteRemoteFailure(error) {
      ctx.remoteOnline = false;
      ctx.degradedReason = (error && error.code) || 'home-node-unreachable';
      ctx.lastError = String((error && error.message) || error || '');
    }

    /* ── 探测 ───────────────────────────────────────────────────────── */
    function probe() {
      if (!remoteEnabled()) {
        ctx.remoteOnline = false;
        ctx.degradedReason = fileOrigin ? 'file-origin-cannot-reach-home-node'
          : (mode === 'off' ? 'mode-off' : 'mode-mirror');
        return Promise.resolve({ online: false, reason: ctx.degradedReason });
      }
      return remote.health().then(function (health) {
        ctx.remoteOnline = !!(health && health.ok);
        if (ctx.remoteOnline) {
          ctx.degradedReason = ctx.hydrated ? null : 'not-hydrated';
          ctx.lastError = null;
        } else {
          ctx.degradedReason = 'home-node-unhealthy';
        }
        return { online: ctx.remoteOnline, reason: ctx.degradedReason };
      }, function (error) {
        noteRemoteFailure(error);
        return { online: false, reason: ctx.degradedReason };
      });
    }

    /* ── 同步：把 Home Node 的变更拉到镜像 ─────────────────────────────
       第一次调用（未 hydrate）先做一次有界播种：取最新 N 条放进镜像，
       然后把 cursor 推到服务端当前 revision。之后的每次调用只应用
       changesAfter(cursor) 的增量（含删除）。 */
    function sync(options) {
      options = options || {};
      ensureDrivers();
      if (!remoteEnabled()) return Promise.resolve({ ok: true, skipped: true, reason: ctx.degradedReason });
      if (!ctx.hydrated || options.full) return hydrate(options);
      return remote.changes(ctx.cursor, { limit: options.limit }).then(function (res) {
        if (!res || !res.ok) return Promise.resolve({ ok: false, error: (res && res.error) || 'changes-failed' });
        return applyChanges(res).then(function (applied) {
          ctx.cursor = res.cursor;
          ctx.remoteOnline = true;
          ctx.degradedReason = null;
          ctx.lastSyncAt = clock();
          ctx.stats.syncs++;
          if (applied) log('sync', { cursor: ctx.cursor, upserts: res.upserts.length, deletes: res.deletes.length, hasMore: !!res.hasMore });
          return { ok: true, cursor: ctx.cursor, upserts: res.upserts.length, deletes: res.deletes.length, hasMore: !!res.hasMore, applied: applied };
        });
      }, function (error) {
        noteRemoteFailure(error);
        return { ok: false, error: ctx.degradedReason, offline: true };
      });
    }

    function hydrate(options) {
      options = options || {};
      var seedLimit = options.seedLimit || CHAT_CORE.MAX_LIST_LIMIT;
      return remote.list({ limit: seedLimit }).then(function (page) {
        if (!page || !page.ok) return { ok: false, error: (page && page.error) || 'list-failed' };
        ctx.stats.hydrations++;
        /* 播种：只写镜像，不写 Home Node（Home Node 就是来源）。
           先清掉镜像里 Home Node 不再拥有的行，避免旧影子残留。 */
        return local.replaceAll(page.messages || []).then(function () {
          /* 播种是「最新 N 条」，服务端 revision 可能还包含更早的历史，
             因此不能直接跳到服务端 revision —— 用服务器返回的 revision 作为
             cursor 只对**增量**成立。这里从 0 开始应用完整变更日志是 O(历史)，
             对大库不划算；改为把 cursor 设到"已生效的最小 revision"：
             listMessages 返回的是当前 revision，而镜像只保证持有最新 N 条，
             因此我们诚实地记录 cursor = 服务端 revision，
             并把更早历史标记为「需要按需读取」（hasFullHistory=false）。 */
          ctx.cursor = Number(page.revision || 0);
          ctx.hydrated = true;
          ctx.remoteOnline = true;
          ctx.degradedReason = null;
          ctx.lastSyncAt = clock();
          ctx.hasFullHistory = !page.hasOlder;
          log('hydrate', { seeded: (page.messages || []).length, cursor: ctx.cursor, hasFullHistory: ctx.hasFullHistory });
          return { ok: true, hydrated: true, seeded: (page.messages || []).length, cursor: ctx.cursor, hasFullHistory: ctx.hasFullHistory };
        });
      }, function (error) {
        noteRemoteFailure(error);
        return { ok: false, error: ctx.degradedReason, offline: true };
      });
    }

    function applyChanges(res) {
      ensureDrivers();
      var work = Promise.resolve(true);
      if (res.deletes && res.deletes.length) {
        work = work.then(function () { return local.applyDeletes(res.deletes); });
      }
      if (res.upserts && res.upserts.length) {
        var messages = res.upserts.map(function (u) { return u.message; });
        work = work.then(function () { return local.applyUpserts(messages); });
      }
      return work;
    }

    /* ── 读路径 ──────────────────────────────────────────────────────
       镜像一旦 hydrate，读就走镜像（reason='mirror'）：它是 Home Node 的
       物化副本，且本地写入会先经过 Home Node 再落镜像，因此镜像不会比
       Home Node 新。未 hydrate 或 Home Node 离线时标记 degraded。

       为什么读不直接打 HTTP：91 个既有读取点里包含全表扫描
       （dbGetAll('chatMessages') × 14、byFriend × 30+），单条消息内联
       base64 图片可达数 MB —— 把这些搬到 HTTP 上既慢又浪费，
       而镜像本来就必须存在（回滚影子），因此让它承担读。 */
    function readSource() {
      if (!ctx.hydrated) return ctx.remoteOnline === false ? 'mirror-degraded' : 'mirror-cold';
      return 'mirror';
    }
    function decorateRead(result) {
      ctx.stats.reads++;
      if (typeof result === 'object' && result && typeof result.then !== 'function') {
        result.authority = 'home-node';
        result.readFrom = readSource();
        result.revision = ctx.cursor;
      }
      return result;
    }

    function get(id) {
      ensureDrivers();
      return Promise.resolve(local.get(String(id))).then(decorateRead);
    }
    function getAll() {
      ensureDrivers();
      return Promise.resolve(local.getAll()).then(decorateRead);
    }
    function getByFriend(friendId) {
      ensureDrivers();
      return Promise.resolve(local.getByFriend(String(friendId))).then(decorateRead);
    }

    /* ── 写路径（fail closed）──────────────────────────────────────────
       顺序严格为：Home Node → 镜像。绝不允许"镜像成功就算成功"。 */
    function put(message, options) {
      ensureDrivers();
      options = options || {};
      var requestId = options.requestId || null;
      if (!remoteEnabled()) {
        /* 'mirror' / 'off' 模式，或 file:// 承载（Chrome 阻断 file://→loopback）：
           明确退回本地写入，并且**不**宣称 Home Node 权威。
           这不是静默降级 —— status() 会带 degradedReason 说明原因。 */
        return Promise.resolve(local.put(message)).then(function () {
          ctx.stats.writes++;
          ctx.stats.localOnlyWrites++;
          return {
            ok: true,
            outcome: 'local-only',
            authority: 'indexeddb',
            mirrorOnly: true,
            reason: ctx.degradedReason
          };
        });
      }
      return remote.put(message, { requestId: requestId, existingPolicy: options.existingPolicy }).then(function (res) {
        if (!res || !res.ok) {
          /* Home Node 不可达（传输层失败，或客户端明确标记 offline）→ fail closed。
             绝不静默双写：宁可让用户看到"发不出去"，也不要制造第二份 canonical。 */
          if (!res || res.offline || /unreachable|transport|timeout/.test(String((res && res.error) || ''))) {
            ctx.stats.failures++;
            noteRemoteFailure({ code: (res && res.error) || 'home-node-unreachable', message: (res && res.detail) || '' });
            log('write-fail-closed', { id: message && message.id, reason: ctx.degradedReason });
            return fail('home-node-offline', {
              id: message && message.id,
              reason: ctx.degradedReason,
              detail: String((res && (res.detail || res.error)) || ''),
              hint: 'Home Node 不在线。桌面聊天写入已停止（fail closed），没有写入第二份 canonical。'
            });
          }
          /* Home Node**明确**拒绝（422/400）→ 这是"记录非法"，不是"离线"，不重试。 */
          ctx.stats.failures++;
          return { ok: false, error: (res && res.error) || 'home-node-rejected', rejected: true, authority: 'home-node' };
        }
        ctx.remoteOnline = true;
        if (res.revision != null) ctx.cursor = Math.max(ctx.cursor, Number(res.revision) || 0);
        if (res.outcome === 'skipped') ctx.stats.skippedWrites++;
        return Promise.resolve(local.put(message)).then(function () {
          ctx.stats.writes++;
          ctx.stats.remoteWrites++;
          return {
            ok: true,
            outcome: res.outcome,
            authority: 'home-node',
            revision: res.revision,
            id: res.id || message.id,
            mirrored: true
          };
        }, function (mirrorError) {
          /* Home Node 写成功、镜像失败：canonical 仍然是 Home Node。
             这不是写失败 —— 必须如实报告镜像未更新，而不是谎报成功。 */
          ctx.stats.writes++;
          ctx.stats.remoteWrites++;
          ctx.remoteOnline = true;
          log('mirror-write-failed', { id: message && message.id, error: String((mirrorError && mirrorError.message) || mirrorError) });
          return {
            ok: true,
            outcome: res.outcome,
            authority: 'home-node',
            revision: res.revision,
            id: res.id || message.id,
            mirrored: false,
            mirrorError: String((mirrorError && mirrorError.message) || mirrorError || '')
          };
        });
      }, function (error) {
        /* Home Node 不可达 → fail closed。绝不静默双写。 */
        noteRemoteFailure(error);
        log('write-fail-closed', { id: message && message.id, reason: ctx.degradedReason });
        return fail('home-node-offline', {
          id: message && message.id,
          reason: ctx.degradedReason,
          detail: String((error && error.message) || error || ''),
          hint: 'Home Node 不在线。桌面聊天写入已停止（fail closed），没有写入第二份 canonical。'
        });
      });
    }

    function remove(id, options) {
      ensureDrivers();
      options = options || {};
      if (!remoteEnabled()) {
        return Promise.resolve(local.remove(String(id))).then(function () {
          return { ok: true, outcome: 'local-only', authority: 'indexeddb', mirrorOnly: true };
        });
      }
      return remote.remove(String(id), { requestId: options.requestId }).then(function (res) {
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'home-node-rejected', rejected: true };
        ctx.remoteOnline = true;
        if (res.revision != null) ctx.cursor = Math.max(ctx.cursor, Number(res.revision) || 0);
        return Promise.resolve(local.remove(String(id))).then(function () {
          return { ok: true, outcome: res.outcome, authority: 'home-node', revision: res.revision, mirrored: true };
        }, function (mirrorError) {
          log('mirror-delete-failed', { id: String(id), error: String((mirrorError && mirrorError.message) || mirrorError) });
          return { ok: true, outcome: res.outcome, authority: 'home-node', revision: res.revision, mirrored: false };
        });
      }, function (error) {
        noteRemoteFailure(error);
        return fail('home-node-offline', { id: String(id), reason: ctx.degradedReason });
      });
    }

    /* ── 一次性迁移（幂等 / 可重复运行 / 中断可续）───────────────────
       浏览器 IndexedDB 旧历史 → Home Node。
       保证：
         · message id 保留（原样发送，Home Node 绝不重新编号）；
         · 不重复插入（内容完全相同 → skipped，revision 不动）；
         · 不覆盖 Home Node 已有的不同内容（existingPolicy='skip'）；
         · 迁移中断后可继续（按 source 记录已完成的 lastTimestamp 水位，
           以及已处理条数；重跑时从头再走一遍是**安全**的，
           因为重复插入会被 skipped —— 水位只是省时间的优化）；
         · 结束时写 migrated marker/version。
       绝不 clear IndexedDB：镜像在 M1-A 期间必须保留。 */
    function migrate(options) {
      options = options || {};
      ensureDrivers();
      var source = String(options.source || 'browser-indexeddb');
      var batchSize = CHAT_CORE.normalizeLimit(options.batchSize, CHAT_CORE.DEFAULT_MIGRATION_BATCH, CHAT_CORE.MAX_MIGRATION_BATCH);
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled', reason: ctx.degradedReason });
      return Promise.resolve(local.getAll()).then(function (all) {
        var messages = (all || []).slice().sort(function (a, b) {
          var ta = Number(a && a.timestamp) || 0, tb = Number(b && b.timestamp) || 0;
          if (ta !== tb) return ta - tb;
          return String((a && a.id) || '') < String((b && b.id) || '') ? -1 : 1;
        });
        var report = { ok: true, source: source, total: messages.length, created: 0, updated: 0, skipped: 0, batches: 0, batchesWithWork: 0, maxTimestamp: 0, fromWatermark: 0 };
        /* 每次迁移尝试使用独立的 requestId 命名空间：同一次运行内的重试仍然幂等
           （服务端 idempotency 表命中并返回同一结果），但**不同**尝试必须拿到真实
           统计 —— 否则第二次全量迁移会命中上一次的 requestId 记录、返回
           duplicate-request（不带 summary），使 created/skipped 恒为 0。 */
        var attemptToken = String(options.attemptId || (Date.now() + ':' + Math.random().toString(36).slice(2, 8)));
        return remote.migrationState(source).then(function (state) {
          /* Home Node 的 /migration 返回 {ok, state:{version,lastTimestamp,messages}}；
             兼容直接返回裸 state 的形态（测试与未来协议演进）。 */
          var info = (state && state.state) ? state.state : (state || {});
          var version = Number(info.version || 0);
          var watermark = Number(info.lastTimestamp || 0);
          report.fromWatermark = watermark;
          /* 水位只用来跳过已经确认过的**前缀**；同时间戳的多条消息必须整批重放，
             因此过滤条件是 timestamp < watermark 而不是 <=。 */
          var pending = watermark > 0 && !options.full ? messages.filter(function (m) { return (Number(m && m.timestamp) || 0) >= watermark; }) : messages;
          var index = 0;
          function step() {
            if (index >= pending.length || (options.maxBatches && report.batches >= options.maxBatches)) {
              return remote.markMigration(source, {
                version: version + 1,
                lastTimestamp: report.maxTimestamp || watermark,
                messages: report.created + report.updated + report.skipped
              }).then(function (mark) {
                report.ok = true;
                report.completed = index >= pending.length;
                report.nextTimestamp = report.maxTimestamp || watermark;
                report.marker = mark && mark.state ? mark.state : null;
                report.processed = index;
                report.pending = pending.length;
                log('migrate-done', report);
                return report;
              });
            }
            var slice = pending.slice(index, index + batchSize);
            index += slice.length;
            report.batches++;
            return remote.putBatch(slice, { requestId: 'migrate:' + source + ':' + attemptToken + ':' + report.batches, existingPolicy: 'skip' }).then(function (res) {
              if (!res || !res.ok) {
                report.ok = false;
                report.error = (res && res.error) || 'batch-failed';
                report.failedAt = index - slice.length;
                return report;   /* 中断：不写 marker，下次重跑从水位继续 */
              }
              var summary = res.summary || {};
              report.created += summary.created || 0;
              report.updated += summary.updated || 0;
              report.skipped += summary.skipped || 0;
              if ((summary.created || 0) + (summary.updated || 0) > 0) report.batchesWithWork++;
              for (var i = 0; i < slice.length; i++) {
                var ts = Number(slice[i] && slice[i].timestamp) || 0;
                if (ts > report.maxTimestamp) report.maxTimestamp = ts;
              }
              return step();
            }, function (error) {
              noteRemoteFailure(error);
              report.ok = false;
              report.error = 'home-node-offline';
              report.failedAt = index - slice.length;
              return report;
            });
          }
          return step();
        }, function (error) {
          noteRemoteFailure(error);
          return { ok: false, error: 'home-node-offline', reason: ctx.degradedReason };
        });
      });
    }

    /* 用 Home Node 完整重建镜像（镜像丢失/损坏时的恢复路径）。
       必须显式调用，绝不自动执行 —— 自动重建会在迁移未完成时清掉唯一副本。 */
    function rebuild(options) {
      options = options || {};
      ensureDrivers();
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled' });
      ctx.hydrated = false;
      ctx.cursor = 0;
      return hydrate(options);
    }

    function status() {
      var status = {
        mode: mode,
        authority: (mode === 'canonical' && !fileOrigin) ? 'home-node' : 'indexeddb',
        fileOrigin: fileOrigin,
        remoteOnline: ctx.remoteOnline,
        degraded: !!ctx.degradedReason,
        degradedReason: ctx.degradedReason,
        hydrated: ctx.hydrated,
        hasFullHistory: !!ctx.hasFullHistory,
        cursor: ctx.cursor,
        lastSyncAt: ctx.lastSyncAt,
        lastError: ctx.lastError,
        stats: Object.assign({}, ctx.stats)
      };
      return status;
    }

    return {
      probe: probe,
      sync: sync,
      hydrate: hydrate,
      rebuild: rebuild,
      get: get,
      getAll: getAll,
      getByFriend: getByFriend,
      put: put,
      remove: remove,
      migrate: migrate,
      status: status,
      /* 只读内部状态，供测试与诊断 */
      ctx: ctx,
      MODES: MODES
    };
  }

  return {
    createChatAuthority: createChatAuthority,
    MODES: MODES,
    DEFAULT_SYNC_INTERVAL_MS: DEFAULT_SYNC_INTERVAL_MS
  };
});
