/* ====================================================================
   IB Understanding Authority — `understandings` 的 authority / mirror / fallback
   --------------------------------------------------------------------
   UMD 双载：Browser <script src="assets/js/understanding-authority.js"> → window.IBUnderstandingAuthority
             Node   require('../assets/js/understanding-authority.js')（测试用）

   **这不是第三套迁移架构。** 它与 assets/js/chat-authority.js、
   assets/js/memory-authority.js 是同一个三态模式、同名的状态字段、同样的
   失败语义，只换了一个 store 和一处**真实差异**：

     ── 与 chat / memory 的唯一实质差异：写协议是"修订链 + 单活 + CAS" ──
     chat 的消息创建后不可变（existingPolicy:'skip' 就够）；
     memory 是可变映射（覆盖式，无 CAS）；
     understanding 是**每个角色恰好一份活文档**，重写必须带 expectedRevision：

         expectedRevision === 当前修订号 → 提交 revision+1
         否则                            → conflict，不做任何变更

     因此本模块的 put() 不是"写一条记录"，而是"提交一份候选理解"：
     它必须知道基版本，且必须能如实回报 conflict 而不是覆盖。
     失败时**绝不**退回本地写 —— 本地写就是第二份 canonical，
     正是本阶段要消灭的形状（见 M1-C.2l §9/§11）。

   ── 三种角色（与 memory-authority.js 逐字同义）──────────────────────
     Authority = Home Node 的 canonical understanding_records。
     Mirror    = 浏览器 IndexedDB 的 `understandings`。派生副本，可被完整重建
                 （rebuild），同时是回滚影子与迁移来源。
     Fallback  = Home Node 不可用时的降级：读 → 继续读镜像并标 degraded；
                 写 → **fail closed**（明确报错，不写第二份 canonical）。

   ── 模式（与 memory-authority 同款，回滚用同一个词表）──────────────
     'canonical'（默认）—— Home Node 权威；写失败即失败
     'mirror'           —— 回滚模式：完全按迁移之前的方式本地读写
     'off'              —— 关闭集成（等同 mirror 但不探测）
   ==================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./understanding-derivation-core.js'));
  } else {
    root.IBUnderstandingAuthority = factory(root.IBUnderstandingDerivation);
  }
})(typeof self !== 'undefined' ? self : this, function (CORE) {
  'use strict';

  var MODES = ['canonical', 'mirror', 'off'];
  var DEFAULT_SEED_LIMIT = 10000;

  function createUnderstandingAuthority(deps) {
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
      /* 权威是否**结构性生效**：canonical 模式且不是 file:// 承载。
         与 `remoteOnline` 刻意分开：那个是"此刻能不能连上"（会抖动），
         这个是"这台宿主上 Home Node 是不是唯一的理解写者"（不会抖动）。
         调用方据此决定"本地写"是合法的回滚路径（false）还是必须 fail closed（true）。
         把两者混用会让"Home Node 临时不可达"变成"悄悄在本地写第二份 canonical"。 */
      authorityEffective: (mode === 'canonical') && !fileOrigin,
      degradedReason: mode === 'canonical'
        ? (fileOrigin ? 'file-origin-cannot-reach-home-node' : 'not-probed')
        : (mode === 'mirror' ? 'mode-mirror' : 'mode-off'),
      lastSyncAt: 0,
      lastError: null,
      stats: {
        reads: 0, writes: 0, remoteReads: 0, remoteWrites: 0, skippedWrites: 0,
        conflicts: 0, failures: 0, syncs: 0, hydrations: 0, localOnlyWrites: 0,
        corrections: 0, deriveRequests: 0
      }
    };

    function remoteEnabled() { return !!remote && (mode === 'canonical') && !fileOrigin; }
    /* 权威生效 = canonical 且非 file://。**不看** remoteOnline：
       节点临时不可达时权威仍然是它，本地写必须 fail closed。 */
    function authorityEffective() { return ctx.authorityEffective === true; }
    function ensureDrivers() {
      if (!local) throw new Error('understanding-authority: local driver is required');
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
       首次（未 hydrate）做有界播种；之后只应用 changesAfter(cursor) 增量。
       播种用 replaceAll（整表替换）：本地遗留的多条 active 行必须被权威状态
       覆盖 —— 否则"镜像里还留着一份旧的、她自己以为有效的理解"。 */
    function sync(options) {
      options = options || {};
      ensureDrivers();
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
          log('understanding-sync', { cursor: ctx.cursor, upserts: (res.upserts || []).length, deletes: (res.deletes || []).length, hasMore: !!res.hasMore });
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
          log('understanding-hydrate', { seeded: (page.records || []).length, cursor: ctx.cursor, truncated: !!page.truncated });
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
        var ids = res.deletes.map(function (d) { return d && (d.recordId || d.id); }).filter(Boolean);
        work = work.then(function () { return local.applyDeletes(ids); });
      }
      if (res.upserts && res.upserts.length) {
        var records = res.upserts.map(function (u) { return u.record; });
        work = work.then(function () { return local.applyUpserts(records); });
      }
      return work;
    }

    /* canonical 模式下的**读**必须等镜像被权威补齐：否则页面刚打开时会读到
       "迁移之前"的本地状态，而权威此时已经是 Home Node。失败不缓存，
       下一次读会再试一次（用户可能刚把 Home Node 起起来）。 */
    var readyPromise = null;
    function ensureReady() {
      if (readyPromise) return readyPromise;
      if (!remoteEnabled()) { readyPromise = Promise.resolve({ ok: true, skipped: true, reason: ctx.degradedReason }); return readyPromise; }
      readyPromise = sync({ reason: 'ready' }).then(function (res) {
        if (!res || !res.ok) readyPromise = null;
        return res || { ok: false, error: 'sync-failed' };
      }, function (error) {
        readyPromise = null;
        return { ok: false, error: String((error && error.message) || error) };
      });
      return readyPromise;
    }
    function resetReady() { readyPromise = null; }

    function readSource() {
      if (!ctx.hydrated) return ctx.remoteOnline === false ? 'mirror-degraded' : 'mirror-cold';
      return 'mirror';
    }
    function decorateRead(result) {
      ctx.stats.reads++;
      if (result && typeof result === 'object' && typeof result.then !== 'function') {
        result.authority = 'home-node';
        result.readFrom = readSource();
        /* ⚠️ **不要**在这里写 `result.revision`。
           与 memory-authority 的关键差异：理解的 `revision` 是**文档修订号**
           （user 更正挂载在它上面、CAS 比较的是它），而镜像游标是 store 的
           全局版本。把游标盖到文档上会静默把 CAS 的基版本改成"别的角色改了
           几次理解"，于是**每一次重写都会被误判为冲突** —— 而且不会有任何报错，
           只会表现为"她的理解再也不更新了"。
           游标放在一个明确命名的字段里，绝不与文档字段重名。 */
        result.mirrorCursor = ctx.cursor;
      }
      return result;
    }
    function getActive(characterId) {
      ensureDrivers();
      return ensureReady().then(function () { return local.getActive(String(characterId)); }).then(decorateRead);
    }
    function get(id) {
      ensureDrivers();
      return ensureReady().then(function () { return local.get(String(id)); }).then(decorateRead);
    }
    function getAll(characterId) {
      ensureDrivers();
      return ensureReady().then(function () { return local.getAll(characterId == null ? null : String(characterId)); }).then(decorateRead);
    }

    /* ── 写：提交一份候选理解（唯一的结构写入路径）─────────────────────
       顺序严格为：Home Node → 镜像。绝不"镜像成功就算成功"。
       conflict 是**一级结果**：调用方必须能区分"我提交成功了""内容没变"
       与"我的基版本过期了"。把它折叠进 ok:false 会让调度器无法决定是
       重读一次还是放弃。 */
    function rewrite(characterId, next, options) {
      options = options || {};
      ensureDrivers();
      var owner = String(characterId || '');
      if (!remoteEnabled()) {
        /* 'mirror'/'off'/file:// —— 回滚与本地承载路径：按迁移之前的方式本地写。
           这条路径**不声称**权威，且 status() 会如实标 degraded。 */
        return Promise.resolve(local.rewrite(owner, next, options)).then(function (res) {
          ctx.stats.writes++;
          ctx.stats.localOnlyWrites++;
          return Object.assign({ authority: 'indexeddb', mirrorOnly: true, reason: ctx.degradedReason }, res || {});
        });
      }
      return remote.rewrite(owner, next, options).then(function (res) {
        if (!res || !res.ok) {
          if (res && (res.error === 'revision-conflict' || res.outcome === 'conflict')) {
            ctx.stats.conflicts++;
            return {
              ok: false, outcome: 'conflict', error: 'revision-conflict', rejected: true,
              authority: 'home-node', characterId: owner,
              expectedRevision: res.expectedRevision, actualRevision: res.actualRevision,
              activeId: res.activeId || null
            };
          }
          if (isTransportFailure(res)) {
            ctx.stats.failures++;
            noteRemoteFailure({ code: (res && res.error) || 'home-node-unreachable' });
            log('understanding-write-fail-closed', { characterId: owner, reason: ctx.degradedReason });
            return fail('home-node-offline', {
              characterId: owner, reason: ctx.degradedReason,
              hint: 'Home Node 不在线。理解写入已停止（fail closed），没有写入第二份 canonical。'
            });
          }
          ctx.stats.failures++;
          return { ok: false, error: (res && res.error) || 'home-node-rejected', rejected: true, authority: 'home-node' };
        }
        ctx.remoteOnline = true;
        if (res.revision != null) ctx.cursor = Math.max(ctx.cursor, Number(res.revision) || 0);
        if (res.outcome === 'skipped') ctx.stats.skippedWrites++;
        /* 镜像写的是**权威返回的那份文档**（而不是我们提交的候选）：
           canonical 可能补上了 history / storeRevision / 归一后的字段，
           镜像必须与权威逐字一致，否则"镜像 == 权威"就不再可断言。 */
        var doc = res.document || null;
        return Promise.resolve(doc ? local.put(doc) : true).then(function () {
          ctx.stats.writes++;
          ctx.stats.remoteWrites++;
          return {
            ok: true, outcome: res.outcome, authority: 'home-node', id: res.id || (doc && doc.id) || null,
            docRevision: res.docRevision, revision: res.revision, mirrored: !!doc,
            historyLength: res.historyLength, activeId: res.activeId || (doc && doc.id) || null
          };
        }, function (mirrorError) {
          ctx.stats.writes++;
          ctx.stats.remoteWrites++;
          log('understanding-mirror-write-failed', { characterId: owner, error: String((mirrorError && mirrorError.message) || mirrorError) });
          return {
            ok: true, outcome: res.outcome, authority: 'home-node', id: res.id || null,
            docRevision: res.docRevision, revision: res.revision, mirrored: false,
            mirrorError: String((mirrorError && mirrorError.message) || mirrorError || '')
          };
        });
      }, function (error) {
        noteRemoteFailure(error);
        log('understanding-write-fail-closed', { characterId: owner, reason: ctx.degradedReason });
        return fail('home-node-offline', {
          characterId: owner, reason: ctx.degradedReason,
          detail: String((error && error.message) || error || ''),
          hint: 'Home Node 不在线。理解写入已停止（fail closed），没有写入第二份 canonical。'
        });
      });
    }

    /* ── 更正（correction）：用户说"你这一点理解错了"的持久记录 ─────────
       语义见 M1-C.2m §1：它不是删除、不是忘记、不是清空历史，而是
       "未来修订必须知道这个判断被挑战过"。
       与 write 同款 fail closed：Home Node 不在线时**不**在本地记一条
       只有本机知道的更正 —— 那条更正会在下一次 canonical 派生时不存在。 */
    function recordCorrection(characterId, input) {
      ensureDrivers();
      var owner = String(characterId || '');
      var body = input || {};
      if (!remoteEnabled()) {
        if (typeof local.recordCorrection !== 'function') {
          return Promise.resolve({ ok: false, error: 'unsupported', authority: 'indexeddb', mirrorOnly: true });
        }
        return Promise.resolve(local.recordCorrection(owner, body)).then(function (res) {
          ctx.stats.corrections++;
          return Object.assign({ authority: 'indexeddb', mirrorOnly: true, reason: ctx.degradedReason }, res || {});
        });
      }
      return remote.correct(owner, body).then(function (res) {
        if (!res || !res.ok) {
          if (isTransportFailure(res)) {
            noteRemoteFailure({ code: (res && res.error) || 'home-node-unreachable' });
            return fail('home-node-offline', {
              characterId: owner, reason: ctx.degradedReason,
              hint: 'Home Node 不在线。更正未记录（fail closed）—— 记在本地等于它不存在于 canonical 历史里。'
            });
          }
          return { ok: false, error: (res && res.error) || 'home-node-rejected', rejected: true, authority: 'home-node' };
        }
        ctx.remoteOnline = true;
        if (res.revision != null) ctx.cursor = Math.max(ctx.cursor, Number(res.revision) || 0);
        ctx.stats.corrections++;
        return { ok: true, outcome: res.outcome, authority: 'home-node', correction: res.correction || null };
      }, function (error) {
        noteRemoteFailure(error);
        return fail('home-node-offline', { characterId: owner, reason: ctx.degradedReason });
      });
    }
    function listCorrections(characterId) {
      ensureDrivers();
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled', corrections: [] });
      return remote.corrections(String(characterId || '')).then(function (res) {
        if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'corrections-failed', corrections: [] };
        return { ok: true, corrections: res.corrections || [] };
      }, function (error) {
        return { ok: false, error: String((error && error.message) || error), corrections: [] };
      });
    }

    /* ── 派生触发：把"该不该派生"的决定权交给 canonical 那一侧 ──────────
       桌面**不**能直接派生（它已经没有派生规则了），它只能请求；
       Home Node 用水位判定，并以 {outcome:'ineligible', skipReason} 如实回报
       "这次没有调用模型"。这样"桌面开着就烧 token"在结构上不可能发生。 */
    function requestDerivation(characterId, options) {
      ensureDrivers();
      var owner = String(characterId || '');
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled', reason: ctx.degradedReason });
      ctx.stats.deriveRequests++;
      return remote.derive(owner, options || {}).then(function (res) {
        if (!res || !res.ok) {
          if (isTransportFailure(res)) { noteRemoteFailure({ code: (res && res.error) || 'home-node-unreachable' }); }
          return res || { ok: false, error: 'derive-failed' };
        }
        ctx.remoteOnline = true;
        /* 派生真的改了文档 → 顺手把镜像同步到新版本（一次增量，不是整表重建）。 */
        if (res.outcome === 'created' || res.outcome === 'updated') {
          return sync({}).then(function () { return res; }, function () { return res; });
        }
        return res;
      }, function (error) {
        noteRemoteFailure(error);
        return { ok: false, error: 'home-node-offline', reason: ctx.degradedReason };
      });
    }

    /* ── 一次性迁移（幂等 / 可重复运行 / 中断可续）────────────────────
       浏览器 IndexedDB `understandings` → Home Node canonical store。
       保证：
         · record id 原样发送（Node 绝不重新编号）；
         · 逐角色**只取一条** active（多条 active → fail closed，报告该角色，
           不猜、不合并、不静默丢弃）；
         · 旧的非 active 行（contested/stale）：**不重新激活**。它们的 current
           变成新文档的 history 条目，并作为一条 legacy 更正进入 canonical ——
           因为"用户否决过它"正是 M1-C.2m §1 要持久保存的那件事。
         · 中断可续：按 source 记水位；重跑安全；
         · 绝不 clear IndexedDB：镜像在过渡期是回滚影子。 */
    function migrate(options) {
      options = options || {};
      ensureDrivers();
      var source = String(options.source || 'browser-indexeddb:understanding');
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled', reason: ctx.degradedReason });
      return Promise.resolve(local.getAll(null)).then(function (all) {
        var rows = Array.isArray(all) ? all : [];
        var byCharacter = new Map();
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          if (!row || !row.characterId) continue;
          var key = String(row.characterId);
          if (!byCharacter.has(key)) byCharacter.set(key, { active: [], inactive: [] });
          if (String(row.status || 'active') === 'active' && row.current && row.current.content) {
            byCharacter.get(key).active.push(row);
          } else {
            byCharacter.get(key).inactive.push(row);
          }
        }
        var report = {
          ok: true, source: source, total: rows.length, characters: byCharacter.size,
          created: 0, updated: 0, skipped: 0, conflicts: 0, ambiguous: 0, preserved: 0,
          corrected: 0, failed: 0, failures: [], ambiguousCharacters: [], preservedCharacters: []
        };
        var work = Promise.resolve();
        var attemptToken = String(options.attemptId || (clock() + ':' + Math.random().toString(36).slice(2, 8)));
        Array.from(byCharacter.keys()).sort().forEach(function (characterId) {
          work = work.then(function () {
            var group = byCharacter.get(characterId);
            /* 多条 active：不猜哪一条是真的。如实报告并**跳过该角色** ——
               猜错一次，用户就永久得到一份不是自己的理解。 */
            if (group.active.length > 1) {
              report.ambiguous++;
              report.ambiguousCharacters.push({ characterId: characterId, active: group.active.length, ids: group.active.map(function (r) { return String(r.id); }) });
              return null;
            }
            var active = group.active[0] || null;
            var seed = active || group.inactive[group.inactive.length - 1] || null;
            if (!seed) return null;
            var history = [];
            /* 旧的非 active 行（用户否决 / 已失效）→ history 条目，**不**成为 current。 */
            var rejected = [];
            for (var k = 0; k < group.inactive.length; k++) {
              var old = group.inactive[k];
              if (!old.current || !old.current.content) continue;
              history.push({
                content: String(old.current.content).slice(0, 500),
                conviction: Number(old.current.conviction) || 0,
                evidenceIds: Array.isArray(old.current.evidenceIds) ? old.current.evidenceIds.slice() : [],
                basis: String(old.current.basis || 'ai_guess'),
                updatedAt: Number(old.current.updatedAt || old.createdAt || 0),
                updatedBy: String(old.current.updatedBy || ''),
                revision: null,
                archivedAt: Number(old.lastUpdatedAt || old.createdAt || clock()),
                legacyStatus: String(old.status || '')
              });
              if (String(old.status) === 'contested') rejected.push(old);
            }
            /* 旧 history 也搬过来（保持时间顺序：旧 → 新）。 */
            var priorHistory = Array.isArray(seed.history) ? seed.history : [];
            var merged = priorHistory.concat(history);
            if (merged.length > CORE.U_HISTORY_CAP) merged = merged.slice(-CORE.U_HISTORY_CAP);
            var candidate = {
              id: String(seed.id || ''),
              content: String((seed.current && seed.current.content) || '').slice(0, 500),
              conviction: Number((seed.current && seed.current.conviction) || 0),
              evidenceIds: Array.isArray(seed.current && seed.current.evidenceIds) ? seed.current.evidenceIds.slice() : [],
              basis: String((seed.current && seed.current.basis) || 'ai_guess'),
              dimension: String(seed.dimension || 'context'),
              stamp: seed.visibility || null,
              updatedBy: String((seed.current && seed.current.updatedBy) || ''),
              /* 历史行可能引用早已删除的记忆 —— 如实标记，由读时存证决定能否注入。 */
              unattested: merged.some(function (h) { return (h.evidenceIds || []).length === 0; }),
              legacyHistory: merged,
              requestId: 'migrate-understanding:' + source + ':' + attemptToken + ':' + characterId
            };
            return remote.migrateRecord(characterId, candidate).then(function (res) {
              if (!res || !res.ok) {
                if (res && (res.error === 'revision-conflict' || res.outcome === 'conflict')) { report.conflicts++; return null; }
                report.failed++;
                report.failures.push({ characterId: characterId, error: (res && res.error) || 'unknown' });
                return null;
              }
              if (res.outcome === 'created') report.created++;
              else if (res.outcome === 'updated') report.updated++;
              else report.skipped++;
              /* 旧否决行 → 一条 legacy 更正。这是"迁移不得静默复活被否决的理解"
                 的实现处：它进 canonical 是**作为更正**，不是作为 current。 */
              if (rejected.length) {
                report.preserved++;
                report.preservedCharacters.push(characterId);
                var chain = Promise.resolve();
                rejected.forEach(function (old) {
                  chain = chain.then(function () {
                    return remote.correct(characterId, {
                      text: String((old.closedReason || 'user-vetoed')),
                      basis: 'user_stated',
                      understandingId: String(old.id),
                      source: 'legacy-veto',
                      legacy: true
                    }).then(function (cres) {
                      if (cres && cres.ok) report.corrected++;
                      return null;
                    }, function () { return null; });
                  });
                });
                return chain;
              }
              return null;
            }, function (error) {
              report.failed++;
              report.failures.push({ characterId: characterId, error: String((error && error.message) || error) });
              return null;
            });
          });
        });
        return work.then(function () {
          return remote.markMigration(source, {
            version: 1,
            records: report.created + report.updated + report.skipped,
            idSet: Array.from(byCharacter.keys())
          }).then(function (mark) {
            report.completed = report.ambiguous === 0 && report.failed === 0;
            report.marker = mark && mark.state ? mark.state : null;
            log('understanding-migrate-done', {
              total: report.total, created: report.created, updated: report.updated,
              skipped: report.skipped, ambiguous: report.ambiguous, preserved: report.preserved, completed: report.completed
            });
            return report;
          }, function () { report.completed = false; return report; });
        });
      }, function (error) {
        noteRemoteFailure(error);
        return { ok: false, error: 'local-read-failed', detail: String((error && error.message) || error) };
      });
    }

    function rebuild(options) {
      ensureDrivers();
      if (!remoteEnabled()) return Promise.resolve({ ok: false, error: 'home-node-disabled' });
      ctx.hydrated = false;
      ctx.cursor = 0;
      return hydrate(options || {});
    }

    function status() {
      var authority = (mode === 'canonical' && !fileOrigin) ? 'home-node' : 'indexeddb';
      var effective = authority === 'home-node' && ctx.remoteOnline === true;
      return {
        store: 'understandings',
        mode: mode,
        authority: authority,
        authorityEffective: effective,
        fileOrigin: fileOrigin,
        remoteOnline: ctx.remoteOnline,
        degraded: !!ctx.degradedReason,
        degradedReason: ctx.degradedReason,
        hydrated: ctx.hydrated,
        cursor: ctx.cursor,
        lastSyncAt: ctx.lastSyncAt,
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
      getActive: getActive,
      getAll: getAll,
      rewrite: rewrite,
      recordCorrection: recordCorrection,
      listCorrections: listCorrections,
      requestDerivation: requestDerivation,
      migrate: migrate,
      status: status,
      /* 供调用方（memory.js 的 unSetStatus / rejectUnderstanding）判断
         "本地写是合法回滚路径，还是必须 fail closed"。 */
      authorityEffective: authorityEffective,
      ctx: ctx,
      MODES: MODES
    };
  }

  return {
    createUnderstandingAuthority: createUnderstandingAuthority,
    MODES: MODES,
    DEFAULT_SEED_LIMIT: DEFAULT_SEED_LIMIT
  };
});
