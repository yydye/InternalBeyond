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

   ══ canonical hydration contract（P11-3F）══════════════════════════════
   ONE CANONICAL REMOTE STATE → ONE LOCAL MIRROR。
   镜像的**破坏性整表替换**（replaceAll）只允许发生在下面这一条成立之后：

       远端 authority 已成功返回一个**完整、权威、可解释**的 snapshot

   判据（四条缺一不可，全部看**服务端明说的东西**，不看推断）：

     ① `res.ok === true`          —— 传输层没有把它合成为失败；
     ② `Array.isArray(records)`   —— 字段**存在且是数组**（不是 undefined/null）；
     ③ `res.truncated === false`  —— 服务端**显式声明**这一页是完整的；
     ④ `typeof revision === 'number' && isFinite(revision)`

   于是下面这些状态**永远不构成** authoritative empty，**永远不许**碰镜像：

     HTTP/network failure · timeout · 503 store-closed · 500 db-* ·
     malformed JSON · 缺 payload / 错信封 · records 缺失或 null ·
     分页被截断 · revision 缺失 · 任何 `catch` 兜底出来的 `[]`

   而**真正的** authoritative empty（`ok:true` + `truncated:false` + `records:[]`
   + 合法 revision）**必须**能够合法地清空镜像 —— 这不矛盾：
   禁止的是"没有证据的清空"，不是"清空"。

   失败时：**不碰镜像**，只如实记 `degradedReason` / `lastError`，
   `hydrated` 不许变真，`cursor` / `mirrorRevision` 不许前进。

   另两条并发不变量：

     · **串行化**：所有会改镜像的路径（hydrate 提交 / 增量 / put / remove）
       排在同一条 promise 链上，"检查代次"与"真正落盘"之间因此没有窗口；
     · **代次 + 水位**：`hydrateGen` 保证旧的 hydrate 不能覆盖更新的 hydrate；
       `mirrorRevision`（已落盘的最高权威版本）保证晚提交的旧快照不能把
       镜像拖回更早的状态（hydrate × 增量 changes 的竞争）。

   `[]` 是**数据**，不是错误兜底 —— 这一条是本层最容易写反的地方。
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.IBMomentsAuthority = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MODES = ['canonical', 'mirror', 'off'];
  /* 镜像播种的上界。刻意**不**用一个小小的默认值：那会让"库里的动态比它多"
     变成"镜像被静默截断"。攒不够时由服务端的 `truncated` 如实报告，
     本层据此**拒绝**破坏性替换（镜像保持原样 + 如实降级），而不是截断它。 */
  var DEFAULT_SEED_LIMIT = 20000;
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
      /* 已经**落盘到镜像**的最高权威版本（P11-3F）。它比 `cursor` 严：
         `cursor` 只说"增量读到哪里了"，`mirrorRevision` 说"镜像里的内容对应哪一版"。
         put / remove 会推进它（它们只走一条行、不动 cursor），
         而 hydrate 提交旧快照时会与它比较 —— 低于它的快照一律拒收（superseded）。 */
      mirrorRevision: 0,
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
    /* 降级的**唯一**判据（原先 status() 与 decorateRead() 各写一份，已经是一致的
       形状，但仍然是可以漂移的两处）。P11-3F 把"有 degradedReason"也算进来：
       镜像写入失败时节点其实是可达的，此前的公式会说 degraded:false ——
       一个"写不进镜像却自称健康"的假绿。 */
    function isDegraded() {
      return !authorityEffective() || ctx.remoteOnline === false || ctx.degradedReason != null;
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
    function isTransportFailure(res) {
      return !res || res.offline || /unreachable|transport|timeout/.test(String((res && res.error) || ''));
    }

    /* ── 失败响应的码：服务端的 error 是**对象**（{code,message,retryable}），
       传输层自己合成的失败是**字符串**（'timeout' / 'invalid-response' / …）。
       这里只做归一化，不新增词表：拿到的永远是既有闭集里的那个 id。 */
    function errorCodeOf(res) {
      if (!res) return 'list-failed';
      var raw = res.error;
      if (raw && typeof raw === 'object') return String(raw.code || raw.error || 'home-node-error');
      var code = String(raw == null ? '' : raw);
      return code || 'list-failed';
    }
    /* 终态判据与 P11-3E 的**同一套**：`runtime/db-failure.js` 分类出来的 db-*
       是"重试也不会好"的那一类；其余（store-closed / 传输）都可重试。 */
    function isTerminalCode(code) { return /^db-/.test(String(code || '')); }

    /* ── 快照裁决：唯一能授权破坏性替换的判据 ──────────────────────────────
       刻意**只**看服务端明说的字段。任何一处缺失 → 拒绝，且不猜。 */
    function validateSnapshot(page) {
      if (!page || page.ok !== true) {
        var code = errorCodeOf(page);
        var terminal = isTerminalCode(code);
        return {
          ok: false, error: code, status: (page && page.status) || null,
          outcome: terminal ? 'terminal-failure' : 'unavailable',
          retryable: !terminal
        };
      }
      /* 完整性必须**被声明**。缺失（老服务端 / 坏信封）不算完整 —— 这正是
         "缺字段"与"权威空集合"被压成同一个状态的入口。 */
      if (page.truncated !== false) {
        if (page.truncated === true) {
          return { ok: false, error: 'incomplete-snapshot', outcome: 'incomplete', status: page.status || null, detail: 'authority-declared-incomplete' };
        }
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', status: page.status || null, detail: 'missing-completeness-declaration' };
      }
      if (!Array.isArray(page.records)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', status: page.status || null, detail: 'records-missing' };
      }
      /* revision 必须真的存在。`Number(page.revision || 0)` 会把"没有版本号"
         悄悄变成 0，而 0 是一个**合法的**版本（全新库）—— 于是"缺失"与
         "确实还没有任何写入"再次压成同一个状态。 */
      if (typeof page.revision !== 'number' || !isFinite(page.revision)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', status: page.status || null, detail: 'revision-missing' };
      }
      return { ok: true, records: page.records, revision: page.revision, count: page.records.length };
    }

    /* 非权威结论的统一落地：**不碰镜像**，只把真实状态留在 ctx 里。
       `hydrated` 保持原值（绝不因为一次失败就变真），cursor / mirrorRevision 不动。 */
    function noteSnapshotFailure(verdict) {
      ctx.stats.failures++;
      ctx.remoteOnline = false;
      ctx.degradedReason = verdict.error;
      ctx.lastError = verdict.detail ? verdict.error + ':' + verdict.detail : verdict.error;
      log('moments-hydrate-refused', {
        outcome: verdict.outcome, error: verdict.error,
        detail: verdict.detail || null, status: verdict.status || null
      });
      return {
        ok: false, error: verdict.error, outcome: verdict.outcome, authority: 'home-node',
        retryable: verdict.retryable !== false, snapshotStatus: verdict.status || null
      };
    }

    /* 镜像写入串行化。所有会改镜像的路径都排在同一条链上，因此
       "检查代次 / 水位"与"真正落盘"之间不存在可插入的窗口。
       链上的失败被吞掉（只影响本次调用的返回值），否则一次失败会让后续全部卡死。 */
    var mirrorChain = Promise.resolve();
    function withMirrorLock(task) {
      var run = mirrorChain.then(task, task);
      mirrorChain = run.then(function () { }, function () { });
      return run;
    }
    /* 最近一次 hydrate 的代次（只有最新那一次有权提交镜像）。 */
    var hydrateGen = 0;

    /* 镜像的事故（原子替换失败 → IndexedDB 事务已回滚，旧镜像完整）。
       如实上报并留下原因；**绝不**在失败路径上置 hydrated / 推进版本。 */
    function noteMirrorFailure(error, event) {
      ctx.stats.failures++;
      ctx.degradedReason = 'mirror-write-failed';
      ctx.lastError = String((error && error.message) || error || 'mirror-write-failed');
      log(event, { error: ctx.lastError });
      return {
        ok: false, error: 'mirror-write-failed', outcome: 'mirror-write-failed',
        authority: 'home-node', detail: ctx.lastError
      };
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
        if (!res || res.ok !== true) return Promise.resolve(noteSnapshotFailure(changesVerdict(res)));
        /* 增量信封同样必须先验证再应用：一份 `ok:true` 但没有 upserts/deletes
           的回应如果被"当作没有变更"并推进游标，那些变更就**永久**不会再来 ——
           与"空快照清空镜像"是同一类错误的另一面。 */
        var invalid = validateChanges(res);
        if (invalid) return Promise.resolve(noteSnapshotFailure(invalid));
        var next = Number(res.cursor);
        return withMirrorLock(function () {
          return applyChanges(res).then(function () {
            /* 游标只许前进：回退的游标会让已经应用过的变更被反复重放，
               而更糟的是它会让 mirrorRevision 与镜像内容脱节。 */
            if (isFinite(next) && next > ctx.cursor) ctx.cursor = next;
            if (isFinite(next) && next > ctx.mirrorRevision) ctx.mirrorRevision = next;
            ctx.remoteOnline = true;
            ctx.degradedReason = null;
            ctx.lastError = null;
            ctx.lastSyncAt = clock();
            ctx.stats.syncs++;
            log('moments-sync', { cursor: ctx.cursor, upserts: (res.upserts || []).length, deletes: (res.deletes || []).length, hasMore: !!res.hasMore });
            return { ok: true, cursor: ctx.cursor, upserts: (res.upserts || []).length, deletes: (res.deletes || []).length, hasMore: !!res.hasMore };
          }, function (error) {
            return noteMirrorFailure(error, 'moments-sync-mirror-failed');
          });
        });
      }, function (error) {
        noteRemoteFailure(error);
        return { ok: false, error: ctx.degradedReason, offline: true };
      });
    }

    /* `changes` 的信封裁决。与 validateSnapshot 同一条纪律：字段必须存在且形状正确，
       否则**不动镜像、不动游标**，如实上报。 */
    function validateChanges(res) {
      if (!Array.isArray(res.upserts)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', detail: 'upserts-missing', retryable: true };
      }
      if (!Array.isArray(res.deletes)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', detail: 'deletes-missing', retryable: true };
      }
      if (typeof res.cursor !== 'number' || !isFinite(res.cursor)) {
        return { ok: false, error: 'invalid-response', outcome: 'invalid-response', detail: 'cursor-missing', retryable: true };
      }
      return null;
    }
    function changesVerdict(res) {
      var code = errorCodeOf(res);
      var terminal = isTerminalCode(code);
      return {
        ok: false, error: code, outcome: terminal ? 'terminal-failure' : 'unavailable',
        retryable: !terminal, status: (res && res.status) || null
      };
    }

    function hydrate(options) {
      options = options || {};
      var seedLimit = options.seedLimit || DEFAULT_SEED_LIMIT;
      /* 代次在这里领取：只有**最新**的一次 hydrate 有权提交镜像。
         旧的那次即使后到，也只会得到 superseded（不写、不改版本）。 */
      var gen = ++hydrateGen;
      return remote.list({ limit: seedLimit }).then(function (page) {
        var verdict = validateSnapshot(page);
        if (!verdict.ok) return noteSnapshotFailure(verdict);
        return withMirrorLock(function () {
          if (gen !== hydrateGen) {
            log('moments-hydrate-superseded', { reason: 'newer-hydration-started', snapshotRevision: verdict.revision });
            return { ok: false, error: 'superseded', outcome: 'superseded', reason: 'newer-hydration-started', authority: 'home-node' };
          }
          /* 镜像里已经有**更新**的权威状态（例如增量 changes 或一次写入先落了盘）
             → 这份旧快照无权把镜像拖回去。 */
          if (verdict.revision < ctx.mirrorRevision) {
            log('moments-hydrate-superseded', { reason: 'stale-snapshot', snapshotRevision: verdict.revision, mirrorRevision: ctx.mirrorRevision });
            return {
              ok: false, error: 'superseded', outcome: 'superseded', reason: 'stale-snapshot',
              snapshotRevision: verdict.revision, mirrorRevision: ctx.mirrorRevision, authority: 'home-node'
            };
          }
          return local.replaceAll(verdict.records).then(function () {
            /* 元数据在**落盘成功之后**才推进 —— 顺序反了就会留下
               "hydrated=true 但镜像还是旧的"这种假绿。 */
            ctx.cursor = verdict.revision;
            ctx.mirrorRevision = verdict.revision;
            ctx.hydrated = true;
            ctx.remoteOnline = true;
            ctx.degradedReason = null;
            ctx.lastError = null;
            ctx.lastSyncAt = clock();
            ctx.stats.hydrations++;
            log('moments-hydrate', { seeded: verdict.count, cursor: ctx.cursor, revision: verdict.revision });
            return {
              ok: true, hydrated: true, outcome: 'authoritative-success',
              seeded: verdict.count, cursor: ctx.cursor, revision: verdict.revision
            };
          }, function (error) {
            /* 原子替换失败 → 事务已回滚，旧镜像**完整保留**。 */
            return noteMirrorFailure(error, 'moments-hydrate-mirror-failed');
          });
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
        degraded: isDegraded(),
        degradedReason: ctx.degradedReason,
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
           否则并发情境下镜像会与权威漂移。
           走同一条镜像锁：一次写入与一次 hydrate 提交不允许交错。
           版本水位一并推进 —— 否则"先写一行、再提交一份更旧的快照"会让这行回退。 */
        var authoritative = res.moment || record;
        var wroteRev = Number(res.revision);
        return withMirrorLock(function () {
          return local.put(authoritative).then(function () {
            if (isFinite(wroteRev) && wroteRev > ctx.mirrorRevision) ctx.mirrorRevision = wroteRev;
            return {
              ok: true, outcome: res.outcome || 'updated', authority: 'home-node',
              id: res.id || (record && record.id) || null, rev: res.rev == null ? null : Number(res.rev),
              revision: res.revision, moment: authoritative
            };
          }, function (error) {
            return noteMirrorFailure(error, 'moments-put-mirror-failed');
          });
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
           镜像保留墓碑没有意义：读路径本来就不该看到已删除的行。
           同一条镜像锁 + 同一个版本水位（理由与 put 逐条相同）。 */
        var removedRev = Number(res.revision);
        return withMirrorLock(function () {
          return local.remove(id).then(function () {
            if (isFinite(removedRev) && removedRev > ctx.mirrorRevision) ctx.mirrorRevision = removedRev;
            return { ok: true, outcome: res.outcome || 'deleted', deleted: true, authority: 'home-node', id: id, revision: res.revision };
          }, function (error) {
            return noteMirrorFailure(error, 'moments-remove-mirror-failed');
          });
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
        mirrorRevision: ctx.mirrorRevision,
        degraded: isDegraded(),
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
