/* ====================================================================
   IB Memory Authority — `memories` 的 authority / mirror / fallback 策略
   --------------------------------------------------------------------
   UMD 双载：Browser <script src="assets/js/memory-authority.js"> → window.IBMemoryAuthority
             Node   require('../assets/js/memory-authority.js')（测试用）

   **这不是第二套迁移架构。** 它与 assets/js/chat-authority.js 是同一个三态
   模式，同名的状态字段、同样的失败语义，只换了一个 store 和一处**真实差异**：

     ── 与 chatMessages 的唯一实质差异：记录可变 ──────────────────────
     chat 的消息创建后基本不可变，所以既有实现可以只用 existingPolicy:'skip'
     做迁移，不需要"更新"路径。`memories` 是 read-modify-write 的：
     用户会编辑、置顶、标记已解决，consolidation 会改写 kind/provenance。
     因此本模块：
       · 新增 put() 的常规更新语义（Node 侧 existingPolicy:'overwrite'）；
       · 内容等价由 **共享的** memory-contract.contentIdentical 判定，
         且**排除激活遥测** —— 否则每次强化都会把重跑变成"全部 updated"，
         幂等性立刻失效。
     这是 Wave 2 唯一需要新设计的部分，其余全部是既有语义的复用。

   ── 三种角色的定义（与 chat-authority.js 逐字同义）──────────────────
     Authority = Home Node 的 canonical memory_records。
       唯一拥有"哪条记忆为真"的判定权与 revision 分配权。
     Mirror    = 浏览器 IndexedDB 的 `memories`。**派生副本**，可被 Home Node
       完整重建（rebuild），因此它丢数据不是事故，Home Node 丢数据才是。
       它同时是回滚影子与迁移来源。
     Fallback  = Home Node 不可用时的降级：
       读 → 继续读镜像并标 degraded（镜像是物化副本，不是权威声明）；
       写 → **fail closed**，默认拒绝并返回明确错误，绝不在本机悄悄写第二份
            canonical。唯一例外是用户显式选择 'mirror' 模式。

   ── 模式 ──────────────────────────────────────────────────────────
     'canonical'（默认）—— Home Node 权威；写失败即失败（fail closed）
     'mirror'           —— 回滚模式：完全按迁移之前的方式本地读写，
                            **不**声称 Home Node 权威
     'off'              —— 关闭集成（等同 'mirror' 但不探测），供诊断与
                            隔离测试使用
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./memory-contract.js'));
  } else {
    root.IBMemoryAuthority = factory(root.IBMemoryContract);
  }
})(typeof self !== 'undefined' ? self : this, function (CONTRACT) {
  'use strict';

  var MODES = ['canonical', 'mirror', 'off'];
  var DEFAULT_MIGRATION_BATCH = 200;
  var MAX_MIGRATION_BATCH = 1000;
  var DEFAULT_SEED_LIMIT = 100000;   /* 召回需要完整候选集，见 chat-authority 的对照说明 */

  function createMemoryAuthority(deps) {
    deps = deps || {};
    var remote = deps.remote || null;
    var local = deps.local || null;
    var clock = deps.clock || function () { return Date.now(); };
    var log = deps.log || function () {};
    var mode = MODES.indexOf(deps.mode) >= 0 ? deps.mode : 'canonical';
    /* file:// 承载：Chrome 在网络层直接阻断 file://→loopback 的 fetch
       （请求根本不到服务端）。此时唯一安全的做法是退回本地 IndexedDB 并
       **显式声明未生效** —— 既不假装权威生效，也不让桌面记忆面板坏掉。
       与 chat-authority.js:64-72 同款判断，理由相同。 */
    var fileOrigin = !!deps.fileOrigin;

    var ctx = {
      mode: mode,
      fileOrigin: fileOrigin,
      remoteOnline: null,
      hydrated: false,
      cursor: 0,
      degradedReason: mode === 'canonical'
        ? (fileOrigin ? 'file-origin-cannot-reach-home-node' : 'not-probed')
        : (mode === 'mirror' ? 'mode-mirror' : 'mode-off'),
      lastSyncAt: 0,
      lastError: null,
      lastActivationFlushAt: 0,
      stats: {
        reads: 0, writes: 0, remoteReads: 0, remoteWrites: 0, skippedWrites: 0,
        failures: 0, syncs: 0, hydrations: 0, localOnlyWrites: 0,
        activationFlushes: 0, activationRecords: 0, activationFailures: 0
      }
    };

    function remoteEnabled() { return !!remote && (mode === 'canonical') && !fileOrigin; }
    function ensureDrivers() {
      if (!local) throw new Error('memory-authority: local driver is required');
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
    function noteMirrorFailure(reason, error) {
      /* Home Node committed, but the materialized IndexedDB view is stale.
         Force the next read through a full hydrate and keep the UI degraded
         until that replacement succeeds. */
      ctx.hydrated = false;
      ctx.hasFullHistory = false;
      ctx.remoteOnline = true;
      ctx.degradedReason = reason;
      ctx.lastError = String((error && error.message) || error || reason);
      readyPromise = null;
    }
    function isTransportFailure(res) {
      return !res || res.offline || /unreachable|transport|timeout/.test(String((res && res.error) || ''));
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

    /* ── 同步：把 Home Node 的变更拉到镜像 ───────────────────────────
       首次（未 hydrate）做有界播种；之后只应用 changesAfter(cursor) 增量。
       播种用 replaceAll（**整表替换**）：召回要在完整候选集上排名，截断的
       镜像会让浏览器与 Node 对同一份数据给出不同的 top-k。 */
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
          if (applied) log('memory-sync', { cursor: ctx.cursor, upserts: res.upserts.length, deletes: res.deletes.length, hasMore: !!res.hasMore });
          return { ok: true, cursor: ctx.cursor, upserts: res.upserts.length, deletes: res.deletes.length, hasMore: !!res.hasMore, applied: applied };
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
        /* 播种只写镜像：Home Node 是来源。
           先整表替换，避免 Home Node 已删除的行作为旧影子留在镜像里
           （那会让"她记得"与"她不该记得"在浏览器里继续生效）。 */
        return local.replaceAll(page.records || []).then(function () {
          ctx.cursor = Number(page.revision || 0);
          ctx.hydrated = true;
          ctx.remoteOnline = true;
          ctx.degradedReason = null;
          ctx.lastSyncAt = clock();
          ctx.hasFullHistory = !page.truncated;
          log('memory-hydrate', { seeded: (page.records || []).length, cursor: ctx.cursor, truncated: !!page.truncated });
          return { ok: true, hydrated: true, seeded: (page.records || []).length, cursor: ctx.cursor, truncated: !!page.truncated };
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
        var records = res.upserts.map(function (u) { return u.record; });
        work = work.then(function () { return local.applyUpserts(records); });
      }
      return work;
    }

    /* ── 一次性播种（幂等，可被多个并发调用共享）──────────────────────
       canonical 模式下的**读**必须在镜像被 Home Node 补齐之前挡住：
       否则页面刚打开时，读到的镜像还是"迁移之前"的本地状态，而权威此时
       已经是 Home Node —— 用户会看到一份既不是权威、也不是最新的记忆列表。
       因此 reads 先 await ensureReady()。

       刻意不做成自动定时同步：常驻 interval 会让测试 harness 无法自然退出
       （仓库的测试纪律），且失败也不该阻塞页面 —— 失败时 ensureReady()
       仍然 resolve，读退回镜像并标 degraded（诚实降级，不假装权威生效）。 */
    var readyPromise = null;
    function ensureReady() {
      if (readyPromise) return readyPromise;
      if (!remoteEnabled()) { readyPromise = Promise.resolve({ ok: true, skipped: true, reason: ctx.degradedReason }); return readyPromise; }
      readyPromise = sync({ reason: 'ready' }).then(function (res) {
        /* 失败**不**缓存：下一次读会再试一次（用户可能刚把 Home Node 起起来）。 */
        if (!res || !res.ok) readyPromise = null;
        return res || { ok: false, error: 'sync-failed' };
      }, function (error) {
        readyPromise = null;
        return { ok: false, error: String((error && error.message) || error) };
      });
      return readyPromise;
    }
    /* 显式重置 readiness（rebuild / 模式切换 / 测试用）。 */
    function resetReady() { readyPromise = null; }

    /* ── 读路径 ──────────────────────────────────────────────────────
       镜像一旦 hydrate，读就走镜像（它是 Home Node 的物化副本，且本地写入
       先经过 Home Node 再落镜像，因此镜像不会比 Home Node 新）。
       未 hydrate 或离线 → 标 degraded，绝不假装是最新。 */
    function readSource() {
      if (!ctx.hydrated) return ctx.remoteOnline === false ? 'mirror-degraded' : 'mirror-cold';
      return 'mirror';
    }
    function decorateRead(result) {
      ctx.stats.reads++;
      if (result && typeof result === 'object' && typeof result.then !== 'function') {
        result.authority = 'home-node';
        result.readFrom = readSource();
        result.revision = ctx.cursor;
      }
      return result;
    }
    function get(id) {
      ensureDrivers();
      return ensureReady().then(function () { return local.get(String(id)); }).then(decorateRead);
    }
    function getAll() {
      ensureDrivers();
      return ensureReady().then(function () { return local.getAll(); }).then(decorateRead);
    }

    /* ── 写路径（fail closed）────────────────────────────────────────
       顺序严格为：Home Node → 镜像。绝不允许"镜像成功就算成功"。
       与 chat 的唯一差异是 **没有** existingPolicy:'skip' —— 记忆是可变的，
       Node 侧用默认的 overwrite（内容不同则更新）。 */
    function put(record, options) {
      options = options || {};
      ensureDrivers();
      if (!remoteEnabled()) {
        return Promise.resolve(local.put(record)).then(function () {
          ctx.stats.writes++;
          ctx.stats.localOnlyWrites++;
          return { ok: true, outcome: 'local-only', authority: 'indexeddb', mirrorOnly: true, reason: ctx.degradedReason };
        });
      }
      var pendingPut = Object.keys(options).length ? remote.put(record, options) : remote.put(record);
      return pendingPut.then(function (res) {
        if (!res || !res.ok) {
          if (isTransportFailure(res)) {
            ctx.stats.failures++;
            noteRemoteFailure({ code: (res && res.error) || 'home-node-unreachable', message: (res && res.detail) || '' });
            log('memory-write-fail-closed', { id: record && record.id, reason: ctx.degradedReason });
            return fail('home-node-offline', {
              id: record && record.id,
              reason: ctx.degradedReason,
              detail: String((res && (res.detail || res.error)) || ''),
              hint: 'Home Node 不在线。记忆写入已停止（fail closed），没有写入第二份 canonical。'
            });
          }
          /* Home Node **明确**拒绝（422/400）→ 记录非法，不重试、不当作离线。 */
          ctx.stats.failures++;
          return { ok: false, error: (res && res.error) || 'home-node-rejected', rejected: true, authority: 'home-node', errors: (res && res.errors) || null };
        }
        ctx.remoteOnline = true;
        if (res.revision != null) ctx.cursor = Math.max(ctx.cursor, Number(res.revision) || 0);
        if (res.outcome === 'skipped') ctx.stats.skippedWrites++;
        /* 镜像写的是**我们提交的那一条**。Node 报告 skipped 说明内容等价，
           因此镜像与 canonical 仍然一致（激活遥测不参与等价判定，
           而镜像里的计数由强化阶段的 flush 单独维护）。 */
        return Promise.resolve(local.put(record)).then(function () {
          ctx.stats.writes++;
          ctx.stats.remoteWrites++;
          return { ok: true, outcome: res.outcome, authority: 'home-node', revision: res.revision, id: res.id || (record && record.id), mirrored: true };
        }, function (mirrorError) {
          ctx.stats.writes++;
          ctx.stats.remoteWrites++;
          noteMirrorFailure('memory-mirror-write-failed', mirrorError);
          log('memory-mirror-write-failed', { id: record && record.id, error: String((mirrorError && mirrorError.message) || mirrorError) });
          return {
            ok: true, outcome: res.outcome, authority: 'home-node', revision: res.revision,
            id: res.id || (record && record.id), mirrored: false,
            mirrorError: String((mirrorError && mirrorError.message) || mirrorError || '')
          };
        });
      }, function (error) {
        noteRemoteFailure(error);
        log('memory-write-fail-closed', { id: record && record.id, reason: ctx.degradedReason });
        return fail('home-node-offline', {
          id: record && record.id,
          reason: ctx.degradedReason,
          detail: String((error && error.message) || error || ''),
          hint: 'Home Node 不在线。记忆写入已停止（fail closed），没有写入第二份 canonical。'
        });
      });
    }

    function remove(id) {
      ensureDrivers();
      if (!remoteEnabled()) {
        return Promise.resolve(local.remove(String(id))).then(function () {
          return { ok: true, outcome: 'local-only', authority: 'indexeddb', mirrorOnly: true };
        });
      }
      return remote.remove(String(id)).then(function (res) {
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'home-node-rejected', rejected: true };
        ctx.remoteOnline = true;
        if (res.revision != null) ctx.cursor = Math.max(ctx.cursor, Number(res.revision) || 0);
        return Promise.resolve(local.remove(String(id))).then(function () {
          return { ok: true, outcome: res.outcome, authority: 'home-node', revision: res.revision, mirrored: true };
        }, function (mirrorError) {
          noteMirrorFailure('memory-mirror-delete-failed', mirrorError);
          log('memory-mirror-delete-failed', { id: String(id), error: String((mirrorError && mirrorError.message) || mirrorError) });
          return { ok: true, outcome: res.outcome, authority: 'home-node', revision: res.revision, mirrored: false };
        });
      }, function (error) {
        noteRemoteFailure(error);
        return fail('home-node-offline', { id: String(id), reason: ctx.degradedReason });
      });
    }

    /* ── 激活强化（**与结构写入分离的唯一副作用**）─────────────────────
       Wave 1 已把"计算选择"与"持久化强化"拆开；这里接上 Node 侧：
         · 走**专用**通道 remote.activate()，它不推进 canonical revision，
           因此每轮对话不会让任何镜像游标失效（§7.6b / §9）；
         · 不写 payload、不写 change_log；
         · 失败只记账，绝不抛出 —— 强化是排名提示，不是事实，
           不能因为它失败而毁掉用户这一轮对话（Wave 1 既有语义）。
       镜像侧同时更新两个字段，使浏览器看到的计数与 Node 一致。 */
    function recordActivation(ids, options) {
      options = options || {};
      ensureDrivers();
      var list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
      /* 去重：同一轮里同一条记忆被记录两次会让计数虚高，而计数参与排名
         （activationFactor）—— 一次选择必须只算一次强化。
         上游通常已经给了唯一 id，但"通常"不是契约：这里保证它成立。 */
      if (list.length > 1) {
        var seenIds = {}, unique = [];
        for (var i = 0; i < list.length; i++) {
          if (seenIds[list[i]]) continue;
          seenIds[list[i]] = 1;
          unique.push(list[i]);
        }
        list = unique;
      }
      if (!list.length) return Promise.resolve({ ok: true, updated: 0, flushed: false, revisionTouched: false });
      var at = (typeof clock === 'function') ? clock() : Date.now();
      /* ── R2-H1 §2.1 / AUTHORITY §2.1（R2-H2 接线）─────────────────────────
         canonical mode：activation 必须 **remote-first**。
         旧的"镜像先落 +1，再 best-effort 发远端"形状被**禁止** ——
         它会在远端失败时留下一个未经 canonical 确认的本地增量，
         而 TELEMETRY_FAIL_CLOSED 要求失败时两侧都不增加。

         canonical 成功**之后**才允许更新 mirror cache，而且**只**用服务端返回的
         权威 per-id 值 SET（Strategy C）。拿不到权威值时**保持 stale**，
         绝不按 delta 猜测（Strategy D 被禁止：无法证明 mirror 的前值与远端前值相等）。 */
      if (!remoteEnabled()) {
        /* mirror / off：无 canonical authority 生效 ⇒ 既有 host-local 语义原样保留
           （NON-CANONICAL / HOST-LOCAL，见 AUTHORITY §2.5）。 */
        var mirrorWork = local.bumpActivation ? local.bumpActivation(list, at) : Promise.resolve(0);
        return Promise.resolve(mirrorWork).then(function (n) {
          return { ok: true, updated: n || 0, flushed: false, authority: 'indexeddb', mirrorOnly: true, revisionTouched: false };
        }, function () {
          return { ok: true, updated: 0, flushed: false, authority: 'indexeddb', mirrorOnly: true, revisionTouched: false };
        });
      }
      /* 用权威 telemetry SET mirror cache：只更新**已存在**的镜像行，
         绝不凭一次 activation 造出半条记录；失败只记账，绝不抛出。 */
      function setMirrorFromCanonical(entries) {
        var n = 0;
        var work = Promise.resolve();
        entries.forEach(function (e) {
          if (!e || e.id == null) return;
          work = work.then(function () {
            return local.get(String(e.id)).then(function (row) {
              if (!row) return null;
              row.activationCount = Number(e.activationCount || 0);
              if (e.lastActivated != null) row.lastActivated = Number(e.lastActivated);
              return local.put(row).then(function () { n++; }, function () { return null; });
            }, function () { return null; });
          });
        });
        return work.then(function () { return n; });
      }
      return remote.activate(list, { at: at }).then(function (res) {
        if (!res || !res.ok) {
          /* DEFINITE_FAILURE：服务端**明确**回了失败 ⇒ 它没有 commit。
             canonical 与 mirror 都不增加（TELEMETRY_FAIL_CLOSED）。
             R2-H3：`outcome` 把这一类与下面的 ambiguous 明确区分开 ——
             不得把网络层错误一律说成"canonical 一定没增加"。 */
          ctx.stats.activationFailures++;
          noteRemoteFailure({ code: (res && res.error) || 'activation-failed' });
          log('memory-activation-failed', { count: list.length, error: (res && res.error) || 'unknown' });
          return {
            ok: false, error: (res && res.error) || 'activation-failed', flushed: false,
            revisionTouched: false, mirrorUnchanged: true,
            outcome: 'definite-failure', canonical: 'unchanged'
          };
        }
        ctx.stats.activationFlushes++;
        ctx.stats.activationRecords += list.length;
        ctx.lastActivationFlushAt = at;
        ctx.remoteOnline = true;
        /* canonical 已确认。有权威 per-id 值 ⇒ SET mirror；没有 ⇒ 保持 stale。 */
        var authoritative = Array.isArray(res.activations) ? res.activations : [];
        if (!authoritative.length) {
          return { ok: true, updated: res.updated || 0, flushed: true, at: at, revisionTouched: !!res.revisionTouched, mirrorSynced: 0, mirrorStale: true };
        }
        return setMirrorFromCanonical(authoritative).then(function (synced) {
          return { ok: true, updated: res.updated || 0, flushed: true, at: at, revisionTouched: !!res.revisionTouched, mirrorSynced: synced || 0 };
        }, function () {
          return { ok: true, updated: res.updated || 0, flushed: true, at: at, revisionTouched: !!res.revisionTouched, mirrorSynced: 0, mirrorStale: true };
        });
      }, function (error) {
        /* AMBIGUOUS_OUTCOME：transport 层失败（reset / timeout / throw）。
         服务端**可能已经 commit**，也可能没有 —— caller 无从得知。
         R2-H3 冻结的处置：不自动 retry（AUTO_RETRY=NONE）、不 queue、
         mirror 不做任何猜测；canonical 的最终状态由下一次与 canonical 的
         交互（hydrate）纠正。这**不是** rollback 保证。 */
        ctx.stats.activationFailures++;
        noteRemoteFailure(error);
        log('memory-activation-failed', { count: list.length, error: String((error && error.message) || error) });
        return {
          ok: false, error: String((error && error.message) || error), flushed: false,
          revisionTouched: false, mirrorUnchanged: true,
          outcome: 'ambiguous', canonical: 'unknown-to-caller', retried: false
        };
      });
    }

    /* ── 一次性迁移（幂等 / 可重复运行 / 中断可续）────────────────────
       浏览器 IndexedDB `memories` → Home Node canonical store。
       保证（逐条对应 chat 的既有保证）：
         · memory id 原样发送，Node 绝不重新编号；
         · 不重复插入（**内容**完全相同 → skipped，revision 不动）；
         · 不覆盖 Node 已有的不同内容（existingPolicy='skip'）；
         · 中断可续：按 source 记录已完成水位；重跑从头走一遍也是**安全**的；
         · 结束时写 marker/version。
       与 chat 的差异：水位凭据额外记录 **id 集合**。memories 可编辑，
       一条旧记录的 created 不变而内容已变，只靠时间戳水位发现不了它 ——
       因此 report 额外给出 idSet 供调用方做增量核对（§11.3 step 5）。
       绝不 clear IndexedDB：镜像在过渡期是回滚影子。 */
    function migrate(options) {
      options = options || {};
      ensureDrivers();
      var source = String(options.source || 'browser-indexeddb:memory');
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled', reason: ctx.degradedReason });
      return Promise.resolve(local.getAll()).then(function (all) {
        var records = (all || []).slice().sort(function (a, b) {
          var ta = CONTRACT.createdAtOf(a), tb = CONTRACT.createdAtOf(b);
          if (ta !== tb) return ta - tb;
          return String((a && a.id) || '') < String((b && b.id) || '') ? -1 : 1;
        });
        var report = {
          ok: true, source: source, total: records.length,
          created: 0, updated: 0, skipped: 0, invalid: 0,
          batches: 0, batchesWithWork: 0, maxTimestamp: 0, fromWatermark: 0,
          idSet: records.map(function (r) { return String((r && r.id) || ''); }).filter(Boolean)
        };
        /* 每次迁移尝试使用独立的 requestId 命名空间：同一次运行内的重试仍然幂等
           （服务端 idempotency 命中并返回同一结果），但**不同**尝试必须拿到真实统计
           —— 否则第二次全量迁移会命中上一次的 requestId 记录、返回 duplicate-request
           （不带 summary），使 created/skipped 恒为 0。 */
        var attemptToken = String(options.attemptId || (clock() + ':' + Math.random().toString(36).slice(2, 8)));
        return remote.migrationState(source).then(function (state) {
          var info = (state && state.state) ? state.state : (state || {});
          var version = Number(info.version || 0);
          var watermark = Number(info.lastTimestamp || 0);
          report.fromWatermark = watermark;
          /* 水位只跳过已确认的**前缀**；同时间戳的记录必须整批重放，
             因此条件用 >= 而不是 >。 */
          var pending = (watermark > 0 && !options.full)
            ? records.filter(function (r) { return CONTRACT.createdAtOf(r) >= watermark; })
            : records;
          var batchSize = Number(options.batchSize);
          if (!isFinite(batchSize) || batchSize <= 0) batchSize = DEFAULT_MIGRATION_BATCH;
          batchSize = Math.min(Math.max(1, Math.trunc(batchSize)), MAX_MIGRATION_BATCH);
          var index = 0;
          function step() {
            if (index >= pending.length || (options.maxBatches && report.batches >= options.maxBatches)) {
              return remote.markMigration(source, {
                version: version + 1,
                lastTimestamp: report.maxTimestamp || watermark,
                records: report.created + report.updated + report.skipped,
                idSet: report.idSet
              }).then(function (mark) {
                report.completed = index >= pending.length;
                report.nextTimestamp = report.maxTimestamp || watermark;
                report.marker = mark && mark.state ? mark.state : null;
                report.processed = index;
                report.pending = pending.length;
                log('memory-migrate-done', {
                  total: report.total, created: report.created, updated: report.updated, skipped: report.skipped, completed: report.completed
                });
                return report;
              });
            }
            var slice = pending.slice(index, index + batchSize);
            index += slice.length;
            report.batches++;
            return remote.putBatch(slice, { requestId: 'migrate-memory:' + source + ':' + attemptToken + ':' + report.batches, existingPolicy: 'skip' })
              .then(function (res) {
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
                  var ts = CONTRACT.createdAtOf(slice[i]);
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
      ensureDrivers();
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled' });
      ctx.hydrated = false;
      ctx.cursor = 0;
      return hydrate(options || {});
    }

    /* 把桌面的记忆预算发布给 Home Node。
       必须发布的理由：预算/contentLen 直接决定哪些记忆进入 prompt。
       若 Node 用自己的缺省而桌面用用户设置，两边会在**同一份** canonical 数据上
       给出不同召回 —— 正是本波要消灭的漂移。
       失败绝不阻塞桌面（设置发布不是聊天的前置条件）。 */
    function publishSettings(settings) {
      ensureDrivers();
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled' });
      if (!remote || typeof remote.putSettings !== 'function') return Promise.resolve({ ok: false, error: 'unsupported' });
      return remote.putSettings({
        budget: settings && settings.budget != null ? Number(settings.budget) : null,
        contentLen: settings && settings.contentLen != null ? Number(settings.contentLen) : null
      }).then(function (res) {
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'settings-failed' };
        return { ok: true, settings: res.settings || null };
      }, function (error) {
        return { ok: false, error: String((error && error.message) || error) };
      });
    }

    function status() {
      var authority = (mode === 'canonical' && !fileOrigin) ? 'home-node' : 'indexeddb';
      /* 诚实标注权威是否真的生效：canonical + Home Node 可达 + 已 hydrate
         才等于"权威生效"。其余情况必须能从 status 一眼看出来，而不是靠猜。 */
      var effective = authority === 'home-node' && ctx.remoteOnline === true;
      return {
        store: 'memories',
        mode: mode,
        authority: authority,
        authorityEffective: effective,
        fileOrigin: fileOrigin,
        remoteOnline: ctx.remoteOnline,
        degraded: !!ctx.degradedReason,
        degradedReason: ctx.degradedReason,
        hydrated: ctx.hydrated,
        fullHistory: !!ctx.hasFullHistory,
        cursor: ctx.cursor,
        lastSyncAt: ctx.lastSyncAt,
        lastActivationFlushAt: ctx.lastActivationFlushAt,
        lastError: ctx.lastError,
        stats: Object.assign({}, ctx.stats)
      };
    }

    return {
      probe: probe,
      sync: sync,
      hydrate: hydrate,
      rebuild: rebuild,
      ensureReady: ensureReady,
      resetReady: resetReady,
      get: get,
      getAll: getAll,
      put: put,
      remove: remove,
      recordActivation: recordActivation,
      migrate: migrate,
      publishSettings: publishSettings,
      status: status,
      ctx: ctx,
      MODES: MODES
    };
  }

  return {
    createMemoryAuthority: createMemoryAuthority,
    MODES: MODES,
    DEFAULT_MIGRATION_BATCH: DEFAULT_MIGRATION_BATCH,
    MAX_MIGRATION_BATCH: MAX_MIGRATION_BATCH
  };
});
