/* ====================================================================
   IB Moments Authority — 浏览器侧"Home Node 说了算"的适配层（M1-C.2n P5/P6）
   --------------------------------------------------------------------
   - Browser: <script src="assets/js/moments-authority.js"> → window.IBMomentsAuthority
   - Node   : require('../assets/js/moments-authority.js').createMomentsAuthority

   与 memory / understanding 同款三态（canonical / mirror / off），**但写协议
   是第四种**，因为动态与它们都不同：

     只读的认知状态（理解）   写完就没人能改，写者也只有派生器一个
     可变的映射（记忆）       覆盖式，无 CAS
     **动态**                 多条、可编辑、可删除、可点赞、可评论；
                             两个真实写者（用户界面 + 后台 companion）

   因此本层的三件关键事情是：

     ① **写先到 Home Node**，成功之后才更新镜像（不是"先写本地再同步"）。
        后者是假收敛：两台 canonical 并存，谁都不是权威。

     ② **CAS 由书写者携带**：编辑/删除带 expectedRev，服务端拒绝过期基版本。
        没有这一条，"用户在编辑"与"角色在点赞"同时发生时会静默覆盖。

     ③ **幂等键随写带上**：动态的创建可能因为网络重试而被提交两次。
        服务端按 requestId 重放，因此重试不产生第二条动态（R7）。

   ── 为什么本地镜像仍然必须存在 ───────────────────────────────────────
   它不是"第二权威"，而是：
     · 桌面渲染的读来源（读镜像，不每帧打网络）；
     · 迁移的来源（搬家之前的老数据在这里）；
     · 回滚影子（file:// / mode=off / mirror 时行为与迁移前逐字相同）。

   ── 镜像读的纪律 ─────────────────────────────────────────────────────
   读之前必须 `ensureReady()`（先补齐镜像）。否则页面刚打开时会读到
   "迁移之前"的本地动态，而权威已经是 Home Node。这条与 memory/understanding
   完全同款：那是本仓库吃过一次的亏。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMomentsAuthority = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODES = ['canonical', 'mirror', 'off'];
  var DEFAULT_SEED_LIMIT = 4000;
  var DEFAULT_MIGRATE_BATCH = 100;

  function createMomentsAuthority(deps) {
    deps = deps || {};
    var remote = deps.remote || null;
    var local = deps.local || null;
    var clock = deps.clock || function () { return Date.now(); };
    var log = deps.log || function () {};
    var mode = MODES.indexOf(deps.mode) >= 0 ? deps.mode : 'canonical';
    var fileOrigin = !!deps.fileOrigin;

    var ctx = {
      mode: mode,
      fileOrigin: fileOrigin,
      remoteOnline: null,
      hydrated: false,
      cursor: 0,
      /* 与 memory / understanding 逐字同款：权威是否**结构性生效**
         （canonical 且非 file://）。刻意不看 remoteOnline —— 节点临时不可达时
         权威仍然是它，本地写必须 fail closed，而不是"悄悄写第二份 canonical"。 */
      authorityEffective: (mode === 'canonical') && !fileOrigin,
      degradedReason: mode === 'canonical'
        ? (fileOrigin ? 'file-origin-cannot-reach-home-node' : 'not-probed')
        : (mode === 'mirror' ? 'mode-mirror' : 'mode-off'),
      lastSyncAt: 0,
      lastError: null,
      stats: {
        reads: 0, writes: 0, readsRemote: 0, writesRemote: 0,
        conflicts: 0, failures: 0, syncs: 0, hydrations: 0,
        migrated: 0, migrateSkipped: 0, migrateRejected: 0, replays: 0
      }
    };

    var readyPromise = null;
    function remoteEnabled() { return !!remote && (mode === 'canonical') && !fileOrigin; }
    function authorityEffective() { return ctx.authorityEffective === true; }
    function fail(code, extra) {
      ctx.stats.failures++;
      return Object.assign({ ok: false, error: code, authority: mode === 'canonical' ? 'home-node' : 'indexeddb' }, extra || {});
    }
    function noteRemoteFailure(error) {
      ctx.remoteOnline = false;
      ctx.degradedReason = (error && error.code) || 'home-node-unreachable';
      ctx.lastError = String((error && error.message) || error || '');
    }
    function isTransportFailure(res) {
      return !res || res.offline || /unreachable|transport|timeout/.test(String((res && res.error) || ''));
    }

    function probe() {
      if (!remoteEnabled()) {
        ctx.remoteOnline = false;
        ctx.degradedReason = fileOrigin ? 'file-origin-cannot-reach-home-node'
          : (mode === 'off' ? 'mode-off' : 'mode-mirror');
        return Promise.resolve({ online: false, reason: ctx.degradedReason });
      }
      return remote.health().then(function (health) {
        ctx.remoteOnline = !!(health && health.ok);
        ctx.degradedReason = ctx.remoteOnline ? (ctx.hydrated ? null : 'not-hydrated') : 'home-node-unhealthy';
        if (ctx.remoteOnline) ctx.lastError = null;
        return { online: ctx.remoteOnline, reason: ctx.degradedReason };
      }, function (error) {
        noteRemoteFailure(error);
        return { online: false, reason: ctx.degradedReason };
      });
    }

    /* ── 同步：把 Home Node 的变更拉到镜像 ─────────────────────────────
       首次（未 hydrate）做有界播种，之后只应用 changesAfter(cursor) 增量。
       播种用 replaceAll：本地遗留的、权威已经不认的行必须消失 ——
       否则"镜像里还留着一条已经被删掉的动态"，而 UI 会把它渲染出来。 */
    function sync(options) {
      options = options || {};
      if (!remoteEnabled()) return Promise.resolve({ ok: true, skipped: true, reason: ctx.degradedReason });
      if (!ctx.hydrated || options.full) return hydrate(options);
      return remote.changes(ctx.cursor, { limit: options.limit }).then(function (res) {
        if (!res || !res.ok) return Promise.resolve({ ok: false, error: (res && res.error) || 'changes-failed' });
        return applyChanges(res).then(function () {
          ctx.cursor = Number(res.cursor) || ctx.cursor;
          ctx.remoteOnline = true;
          ctx.degradedReason = null;
          ctx.lastSyncAt = clock();
          ctx.stats.syncs++;
          log('moments-sync', { cursor: ctx.cursor, upserts: (res.upserts || []).length, deletes: (res.deletes || []).length, hasMore: !!res.hasMore });
          return { ok: true, cursor: ctx.cursor, upserts: (res.upserts || []).length, deletes: (res.deletes || []).length, hasMore: !!res.hasMore };
        });
      }, function (error) {
        noteRemoteFailure(error);
        return { ok: false, error: ctx.degradedReason, offline: true };
      });
    }

    function hydrate(options) {
      options = options || {};
      var seedLimit = options.seedLimit || DEFAULT_SEED_LIMIT;
      return remote.list({ limit: seedLimit }).then(function (page) {
        if (!page || !page.ok) return { ok: false, error: (page && page.error) || 'list-failed' };
        ctx.stats.hydrations++;
        return local.replaceAll(page.records || []).then(function () {
          ctx.cursor = Number(page.revision || 0);
          ctx.hydrated = true;
          ctx.remoteOnline = true;
          ctx.degradedReason = null;
          ctx.lastSyncAt = clock();
          log('moments-hydrate', { seeded: (page.records || []).length, cursor: ctx.cursor });
          return { ok: true, hydrated: true, seeded: (page.records || []).length, cursor: ctx.cursor };
        });
      }, function (error) {
        noteRemoteFailure(error);
        return { ok: false, error: ctx.degradedReason, offline: true };
      });
    }

    function applyChanges(res) {
      var work = Promise.resolve();
      (res.upserts || []).forEach(function (row) {
        work = work.then(function () { return local.put(row); });
      });
      (res.deletes || []).forEach(function (row) {
        work = work.then(function () { return local.remove(row && row.id); });
      });
      return work;
    }

    /* 读之前先补齐镜像。失败**不抛**：读路径要能降级（离线时读本地镜像），
       但把 degradedReason 留下，不把"读不到权威"伪装成"权威说没有"。 */
    function ensureReady() {
      if (!remoteEnabled()) return Promise.resolve({ ok: true, skipped: true, reason: ctx.degradedReason });
      if (readyPromise) return readyPromise;
      readyPromise = sync({}).then(function (res) {
        if (!res || !res.ok) readyPromise = null;   /* 失败允许下次重试 */
        return res;
      }, function (error) {
        readyPromise = null;
        noteRemoteFailure(error);
        return { ok: false, error: ctx.degradedReason, offline: true };
      });
      return readyPromise;
    }
    function resetReady() { readyPromise = null; }

    function readSource() { return authorityEffective() ? 'home-node' : 'indexeddb'; }

    /* ── 读：返回镜像行，并标注权威来源 ───────────────────────────────
       decorateRead 刻意**只加标注、不改行**：镜像行的形状必须与迁移前逐字相同，
       否则 moments.js 里每一处 `m.visibility` / `m.roleId` 的读法都要跟着改。 */
    function decorateRead(result) {
      ctx.stats.reads++;
      if (authorityEffective()) ctx.stats.readsRemote++;
      return {
        ok: true, authority: readSource(), authorityEffective: authorityEffective(),
        degraded: !authorityEffective() || ctx.remoteOnline === false,
        degradedReason: authorityEffective() ? ctx.degradedReason : ctx.degradedReason,
        value: result
      };
    }

    function get(id) {
      return ensureReady().then(function () { return local.get(id); }).then(decorateRead);
    }
    function getAll() {
      return ensureReady().then(function () { return local.getAll(); }).then(decorateRead);
    }
    function getByOwner(roleId) {
      return ensureReady().then(function () { return local.getByOwner(roleId); }).then(decorateRead);
    }

    /* ── 写：Node 优先 ─────────────────────────────────────────────────
       `expectedRev` 语义：
         · 新建            → 不传（服务端按"不存在则创建"处理）
         · 编辑/删除       → 传当前 rev；过期 → conflict，**不清本地**
       返回形状与 memory-authority 对齐（{ok, outcome, revision, ...}），
       唯一的例外是 conflict 会把服务端的 expectedRev/actualRev 带回给调用方，
       因为"我拿的是哪一版"是调用方唯一能修的东西。 */
    function put(record, options) {
      options = options || {};
      if (!remoteEnabled()) {
        /* 非 canonical 承载（mirror / off / file://）：本地写是**合法回滚路径**，
           行为与迁移之前逐字相同。status() 会如实标注权威不是 Home Node。 */
        ctx.stats.writes++;
        return local.put(record).then(function () {
          return { ok: true, outcome: 'local', authority: 'indexeddb', authorityEffective: false };
        });
      }
      return remote.put(record, {
        requestId: options.requestId,
        expectedRev: options.expectedRev
      }).then(function (res) {
        if (!res || !res.ok) {
          if (isTransportFailure(res)) { noteRemoteFailure(res); return fail(ctx.degradedReason, { offline: true }); }
          if (String(res.error || '') === 'CONFLICT' || res.error === 'revision-conflict') {
            ctx.stats.conflicts++;
            /* 冲突**不**写镜像：镜像必须保持权威的样子。把冲突的候选写进镜像，
               就是让镜像与权威不一致 —— 而这正是本阶段要消灭的形状。 */
            return {
              ok: false, error: 'revision-conflict', outcome: 'conflict', authority: 'home-node',
              expectedRev: res.expectedRev == null ? null : Number(res.expectedRev),
              actualRev: res.actualRev == null ? null : Number(res.actualRev)
            };
          }
          return fail(res.error || 'home-node-rejected', { rejected: true, detail: res });
        }
        ctx.stats.writes++;
        ctx.stats.writesRemote++;
        if (res.outcome === 'replayed') ctx.stats.replays++;
        /* 成功之后才更新镜像，且**用服务端回传的权威行**（不是本地候选）——
           否则并发情境下镜像会与权威漂移。 */
        var authoritative = res.moment || record;
        return local.put(authoritative).then(function () {
          return {
            ok: true, outcome: res.outcome || 'updated', authority: 'home-node',
            id: res.id || (record && record.id) || null, rev: res.rev == null ? null : Number(res.rev),
            revision: res.revision, moment: authoritative
          };
        });
      }, function (error) {
        noteRemoteFailure(error);
        return fail(ctx.degradedReason, { offline: true });
      });
    }

    function remove(id, options) {
      options = options || {};
      if (!remoteEnabled()) {
        return local.remove(id).then(function () {
          return { ok: true, outcome: 'local', deleted: true, authority: 'indexeddb', authorityEffective: false };
        });
      }
      return remote.remove(id, { requestId: options.requestId, expectedRev: options.expectedRev }).then(function (res) {
        if (!res || !res.ok) {
          if (isTransportFailure(res)) { noteRemoteFailure(res); return fail(ctx.degradedReason, { offline: true }); }
          if (String(res.error || '') === 'CONFLICT') {
            ctx.stats.conflicts++;
            return { ok: false, error: 'revision-conflict', outcome: 'conflict', authority: 'home-node', id: id };
          }
          return fail(res.error || 'home-node-rejected', { rejected: true });
        }
        /* 服务端已软删除（墓碑 + change_log）→ 镜像侧同步移除。
           镜像保留墓碑没有意义：读路径本来就不该看到已删除的行。 */
        return local.remove(id).then(function () {
          return { ok: true, outcome: res.outcome || 'deleted', deleted: true, authority: 'home-node', id: id, revision: res.revision };
        });
      }, function (error) {
        noteRemoteFailure(error);
        return fail(ctx.degradedReason, { offline: true });
      });
    }

    /* ── 迁移：浏览器遗留行 → canonical（幂等、非破坏、可续跑）─────────
       关键性质（§9）：
         · 不覆盖已存在的 canonical 行（服务端 writeMigrated 保证）；
         · **不删除**本地行 —— 浏览器副本就是回滚影子；
         · 缺失档位原样留空（服务端迁移模式不套用"未标注=公开"的写入默认），
           因此旧行在搬家途中不会从"仅作者可见"变成公开；
         · 不可归属（既无作者又无档位）的行**拒收并如实报告**，不落孤儿行。
       绝不自动执行：什么时候搬家是用户/运维的决定。 */
    function migrate(options) {
      options = options || {};
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'authority-disabled', reason: ctx.degradedReason });
      var source = String(options.source || 'browser-indexeddb:moments');
      var batchSize = Math.max(1, Math.min(500, Number(options.batchSize) || DEFAULT_MIGRATE_BATCH));
      var rows = null;
      return local.getAll().then(function (all) {
        rows = Array.isArray(all) ? all : [];
        var report = {
          ok: true, source: source, total: rows.length, created: 0, skipped: 0, replayed: 0,
          rejected: [], batches: 0, revision: null, authority: 'home-node'
        };
        if (!rows.length) {
          report.completed = true;
          return local.markMigrated(source, report).then(function () { return report; });
        }
        var batches = [];
        for (var i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));
        var chain = Promise.resolve();
        batches.forEach(function (batch, index) {
          chain = chain.then(function () {
            return remote.migrateBatch(batch, { prefix: source }).then(function (res) {
              report.batches++;
              if (!res || !res.ok) {
                report.ok = false;
                report.error = (res && res.error) || 'migrate-batch-failed';
                return;
              }
              report.created += Number(res.created) || 0;
              report.skipped += Number(res.skipped) || 0;
              report.revision = res.revision == null ? report.revision : res.revision;
              (res.rejected || []).forEach(function (r) { report.rejected.push(r); });
              log('moments-migrate-batch', { batch: index + 1, of: batches.length, created: res.created, skipped: res.skipped, invalid: res.invalid });
            }, function (error) {
              noteRemoteFailure(error);
              report.ok = false;
              report.error = ctx.degradedReason;
            });
          });
        });
        return chain.then(function () {
          report.migrateRejected = report.rejected.length;
          report.completed = report.ok === true;
          ctx.stats.migrated += report.created;
          ctx.stats.migrateSkipped += report.skipped;
          ctx.stats.migrateRejected += report.rejected.length;
          /* 水位如实记录：即使有 rejected 也记（否则每次重跑都会重来一遍）。 */
          return local.markMigrated(source, {
            version: 1, records: report.total, created: report.created,
            skipped: report.skipped, rejectedCount: report.rejected.length, completedAt: clock()
          }).then(function () { return report; });
        });
      }, function (error) {
        return { ok: false, error: 'local-read-failed', detail: String((error && error.message) || error) };
      });
    }

    /* 用 Home Node 完整重建镜像。显式调用，绝不自动执行。 */
    function rebuild(options) {
      options = options || {};
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'authority-disabled' });
      return hydrate(Object.assign({}, options, { seedLimit: options.seedLimit || DEFAULT_SEED_LIMIT }));
    }

    function status() {
      return {
        store: 'moments',
        mode: mode,
        authority: authorityEffective() ? 'home-node' : 'indexeddb',
        authorityEffective: authorityEffective(),
        remoteOnline: ctx.remoteOnline,
        hydrated: ctx.hydrated,
        cursor: ctx.cursor,
        degraded: !authorityEffective() || ctx.remoteOnline === false,
        degradedReason: ctx.degradedReason,
        lastSyncAt: ctx.lastSyncAt,
        lastError: ctx.lastError,
        stats: Object.assign({}, ctx.stats)
      };
    }

    return {
      MODES: MODES,
      probe: probe,
      sync: sync,
      hydrate: hydrate,
      ensureReady: ensureReady,
      resetReady: resetReady,
      put: put,
      remove: remove,
      get: get,
      getAll: getAll,
      getByOwner: getByOwner,
      migrate: migrate,
      rebuild: rebuild,
      status: status,
      authorityEffective: authorityEffective,
      remoteEnabled: remoteEnabled,
      applyChanges: applyChanges,
      remote: remote,
      local: local
    };
  }

  return { createMomentsAuthority: createMomentsAuthority, MODES: MODES };
});
