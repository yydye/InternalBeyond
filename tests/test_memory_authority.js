'use strict';
/* Internal Beyond · M1-C.2d Wave 2 · Memory Authority（static，零依赖，不开浏览器）
   运行：node tests/test_memory_authority.js

   验证 assets/js/memory-authority.js 的三态语义 —— 与 tests/test_chat_authority.js
   同一套断言结构，因为它们是**同一个**权威模式在两个 store 上的实例：
     · canonical：写必须**先**到 Home Node，成功后才落镜像；
     · Home Node 离线：写 fail closed（不产生第二份 canonical），读走镜像并标 degraded；
     · Home Node 明确拒绝（422）：rejected，不当作离线、不重试；
     · Home Node 接受但镜像写失败：canonical 仍是 Home Node，如实报告 mirrored:false；
     · 权威状态**显式**：authority / authorityEffective / degraded / degradedReason；
     · 镜像被独立篡改后，canonical 读仍返回 Home Node 真相（T4 的策略面）；
     · 激活强化走独立通道，不推进 canonical revision；
     · mirror / off 模式明确退回本地且不宣称权威。

   Wave 2 与 chat 的**真实差异**在这里被逐条断言：
     · 记忆是 read-modify-write：内容变化必须真的更新（而不是像聊天迁移那样 skip）；
     · 内容等价**排除激活遥测**，否则每次强化都会让重跑变成"全部 updated"。
   用 mock remote + mock local，不发任何真实网络请求。 */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'memory-authority.js'));
const CONTRACT = require(path.join(ROOT, 'assets', 'js', 'memory-contract.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

/* 默认 public + 由该角色写入（对 role-a 可见）。 */
function mem(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: '标题' + id, summary: '', content: '内容' + id,
    domain: '日常', tags: [], valence: 0.5, arousal: 0.4, importance: 5, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: 1000, lastActivated: 1000,
    createdBy: 'role-a', createdByName: 'A', consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}

/* ── mock remote：可编程的 Home Node canonical memory store ─────────── */
function mockRemote(options) {
  options = options || {};
  const state = {
    online: options.online !== false,
    stored: new Map(),
    revOf: new Map(),
    revision: 0,
    calls: { put: [], putBatch: [], changes: [], list: [], remove: [], activate: [], health: 0, mark: [], migrationState: 0 },
    migration: {},
    failPut: null,
    activationTouchesRevision: false
  };
  function offline() { return { ok: false, error: 'home-node-unreachable', offline: true, retryable: true }; }
  /* 内容指纹：与 Node 侧同一条规则（排除激活遥测）。 */
  const fp = r => CONTRACT.contentFingerprint(r);
  return {
    state,
    health() {
      state.calls.health++;
      return Promise.resolve(state.online ? { ok: true, service: 'internal-beyond-home-node' } : offline());
    },
    list(query) {
      state.calls.list.push(query || {});
      if (!state.online) return Promise.resolve(offline());
      const all = Array.from(state.stored.values()).sort((a, b) => CONTRACT.createdAtOf(a) - CONTRACT.createdAtOf(b));
      const limit = (query && query.limit) || 100000;
      return Promise.resolve({ ok: true, records: all.slice(0, limit), revision: state.revision, truncated: all.length > limit });
    },
    changes(cursor) {
      state.calls.changes.push(cursor);
      if (!state.online) return Promise.resolve(offline());
      /* 只报 cursor 之后的内容变更（激活不产生 change 行）。 */
      const upserts = [];
      for (const r of state.stored.values()) if (Number(state.revOf.get(r.id) || 0) > cursor) upserts.push({ record: r, revision: state.revOf.get(r.id) });
      return Promise.resolve({ ok: true, cursor: state.revision, upserts: upserts, deletes: [], hasMore: false, revision: state.revision });
    },
    put(record, opts) {
      state.calls.put.push({ record: record, opts: opts || {} });
      if (state.failPut === 'offline' || !state.online) return Promise.resolve(offline());
      if (state.failPut === 'rejected') return Promise.resolve({ ok: false, error: 'invalid-record', status: 422 });
      const existing = state.stored.get(record.id);
      /* 内容等价判定与 Node 侧同源：**必须**用 memory-contract，而不是
         JSON.stringify —— 后者会把激活遥测算进内容，让每次强化都变成内容变化。 */
      if (existing && fp(existing) === fp(record)) {
        return Promise.resolve({ ok: true, outcome: 'skipped', id: record.id, revision: state.revision, reason: 'identical' });
      }
      if (existing && opts && opts.existingPolicy === 'skip') {
        return Promise.resolve({ ok: true, outcome: 'skipped', id: record.id, revision: state.revision, reason: 'exists-on-node' });
      }
      state.revision++;
      /* 存**原样**的 record，不塞额外字段：多出来的 __rev 会被
         memory-contract 当成内容的一部分（它不是已知遥测字段），
         于是"同内容重写"永远判成 updated —— 那正是真实 Node 侧不会发生的事。
         版本号单独记在 revOf 里。 */
      state.stored.set(record.id, Object.assign({}, record));
      state.revOf.set(record.id, state.revision);
      return Promise.resolve({ ok: true, outcome: existing ? 'updated' : 'created', id: record.id, revision: state.revision });
    },
    putBatch(records, opts) {
      state.calls.putBatch.push({ records: records, opts: opts || {} });
      if (state.failPut === 'offline' || !state.online) return Promise.resolve(offline());
      const summary = { created: 0, updated: 0, skipped: 0 };
      for (const r of records) {
        const existing = state.stored.get(r.id);
        if (existing && opts && opts.existingPolicy === 'skip') { summary.skipped++; continue; }
        if (existing && fp(existing) === fp(r)) { summary.skipped++; continue; }
        state.revision++;
        state.stored.set(r.id, Object.assign({}, r));
        state.revOf.set(r.id, state.revision);
        if (existing) summary.updated++; else summary.created++;
      }
      return Promise.resolve({ ok: true, outcome: 'batch', summary: summary, revision: state.revision, count: records.length });
    },
    remove(id) {
      state.calls.remove.push(id);
      if (!state.online) return Promise.resolve(offline());
      const had = state.stored.delete(id);
      if (had) state.revision++;
      return Promise.resolve({ ok: true, outcome: had ? 'deleted' : 'not-present', id: id, revision: state.revision, deleted: had });
    },
    /* 激活通道：**刻意**不碰 revision。revisionTouched 恒 false。 */
    activate(ids, opts) {
      state.calls.activate.push({ ids: ids.slice(), opts: opts || {} });
      if (!state.online) return Promise.resolve(offline());
      let n = 0;
      for (const id of ids) {
        const r = state.stored.get(id);
        if (!r) continue;
        r.activationCount = (r.activationCount || 0) + 1;
        r.lastActivated = (opts && opts.at) || Date.now();
        n++;
      }
      /* 断言用：如果哪天有人让 activate 推进 revision，这里会记录下来。 */
      if (state.activationTouchesRevision) state.revision++;
      const out = { ok: true, updated: n, at: (opts && opts.at) || null, revisionTouched: false, revision: state.revision };
      /* R2-H2：模拟 endpoint 的 **additive** 权威返回值。默认关闭 =
         老服务端（只回 updated）⇒ 调用方必须保持 mirror stale、不得猜 delta。 */
      if (state.returnActivationTelemetry) {
        out.activations = ids.map(id => {
          const r = state.stored.get(id) || {};
          return { id: id, activationCount: Number(r.activationCount || 0), lastActivated: (opts && opts.at) || null };
        });
      }
      return Promise.resolve(out);
    },
    migrationState(source) {
      state.calls.migrationState++;
      return Promise.resolve({ ok: true, source: source, state: state.migration[source] || { version: 0, lastTimestamp: 0, records: 0, idSet: [] } });
    },
    markMigration(source, patch) {
      state.calls.mark.push({ source: source, patch: patch });
      const cur = state.migration[source] || { version: 0, lastTimestamp: 0, records: 0, idSet: [] };
      state.migration[source] = {
        version: Math.max(cur.version, patch.version || 0),
        lastTimestamp: Math.max(cur.lastTimestamp, patch.lastTimestamp || 0),
        records: patch.records,
        idSet: patch.idSet || cur.idSet
      };
      return Promise.resolve({ ok: true, source: source, state: state.migration[source] });
    },
    putSettings(settings) {
      state.calls.settings = settings;
      return Promise.resolve({ ok: true, settings: settings });
    }
  };
}

/* ── mock local：可编程的 IndexedDB 镜像 ─────────────────────────────
   接受两种形状：bare array（= 预置记录）或 {seed}。
   为什么要两种：调用点里两种写法都会出现，而"传了数组但 helper 只认
   {seed}"会**静默**变成空镜像 —— 迁移测试于是在"没东西可迁"上假绿。
   显式归一，让这个错误不可能再发生。 */
function mockLocal(options) {
  const seed = Array.isArray(options) ? options : ((options && options.seed) || []);
  const state = { rows: new Map(), failPut: false, failBump: false, calls: { put: 0, remove: 0, replaceAll: 0, applyUpserts: 0, applyDeletes: 0, bump: 0 } };
  for (const r of seed) if (r && r.id) state.rows.set(r.id, r);
  return {
    state,
    get(id) { return Promise.resolve(state.rows.get(id) || null); },
    getAll() { return Promise.resolve(Array.from(state.rows.values())); },
    put(r) {
      state.calls.put++;
      if (state.failPut) return Promise.reject(new Error('IndexedDB mirror write failed'));
      state.rows.set(r.id, r);
      return Promise.resolve();
    },
    remove(id) { state.calls.remove++; state.rows.delete(id); return Promise.resolve(); },
    bumpActivation(ids, at) {
      state.calls.bump++;
      if (state.failBump) return Promise.reject(new Error('bump failed'));
      let n = 0;
      for (const id of ids) {
        const r = state.rows.get(id);
        if (!r) continue;
        r.activationCount = (r.activationCount || 0) + 1;
        r.lastActivated = at;
        n++;
      }
      return Promise.resolve(n);
    },
    applyUpserts(rs) { state.calls.applyUpserts++; for (const r of rs) state.rows.set(r.id, r); return Promise.resolve(); },
    applyDeletes(ds) { state.calls.applyDeletes++; for (const d of ds) state.rows.delete(d.recordId); return Promise.resolve(); },
    replaceAll(rs) {
      state.calls.replaceAll++;
      state.rows.clear();
      for (const r of rs) state.rows.set(r.id, r);
      return Promise.resolve();
    }
  };
}

(async () => {

  /* ══════════════ T1 · canonical：写先到 Home Node，再落镜像 ══════════════ */
  section('T1 · canonical 写顺序与权威标注');
  {
    const remote = mockRemote();
    const local = mockLocal();
    const order = [];
    const remotePut = remote.put.bind(remote);
    remote.put = (r, o) => { order.push('remote'); return remotePut(r, o); };
    const localPut = local.put.bind(local);
    local.put = (r) => { order.push('local'); return localPut(r); };
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 5000 });
    const res = await authority.put(mem('m1'));
    check('T1.1 put 成功且权威标注 home-node', res.ok === true && res.authority === 'home-node', res);
    check('T1.2 写入顺序 = remote 先、local 后', order.join(',') === 'remote,local', order);
    check('T1.3 落到 Home Node canonical store', remote.state.stored.has('m1'));
    check('T1.4 镜像同步更新', local.state.rows.has('m1'));
    check('T1.5 报告 mirrored:true', res.mirrored === true);
    check('T1.6 采用 Home Node 返回的 revision', res.revision === 1, res.revision);
    check('T1.7 id 由 canonical 决定（未重新编号）', res.id === 'm1');
  }

  /* ══════════════ T2 · mirror：被独立篡改也不改变 canonical 读 ═══════════ */
  section('T2 · 镜像不是隐形权威');
  {
    const remote = mockRemote();
    const local = mockLocal();
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 5000 });
    await authority.put(mem('m1', { content: 'CANONICAL-CONTENT' }));
    /* 独立篡改镜像（模拟"浏览器侧仍是真权威"的情形） */
    local.state.rows.set('m1', mem('m1', { content: 'TAMPERED-MIRROR-CONTENT' }));
    check('T2.1 篡改后镜像确实不同（否则本断言无意义）',
      local.state.rows.get('m1').content === 'TAMPERED-MIRROR-CONTENT');
    /* canonical 真相仍在 Home Node */
    check('T2.2 Home Node 里仍是 canonical 内容',
      remote.state.stored.get('m1').content === 'CANONICAL-CONTENT');
    /* rebuild 后镜像被 canonical 覆盖回去 */
    await authority.rebuild();
    check('T2.3 rebuild 用 Home Node 覆盖镜像（镜像可被完整重建）',
      local.state.rows.get('m1').content === 'CANONICAL-CONTENT', local.state.rows.get('m1').content);
    /* 镜像里多出来的行必须被清掉：它会继续参与召回 */
    local.state.rows.set('ghost', mem('ghost', { content: 'GHOST-ONLY-IN-MIRROR' }));
    await authority.rebuild();
    check('T2.4 rebuild 清掉 Home Node 没有的行（旧影子不再参与召回）',
      !local.state.rows.has('ghost'), Array.from(local.state.rows.keys()));
    check('T2.5 删除后 canonical 读不返回它', (await authority.get('ghost')) === null);
  }

  /* ══════════════ T3 · 离线：写 fail closed ═══════════════════════════════ */
  section('T3 · Home Node 离线 → fail closed');
  {
    const remote = mockRemote({ online: false });
    const local = mockLocal();
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 5000 });
    const res = await authority.put(mem('m-offline'));
    check('T3.1 写被拒绝（不假装成功）', res.ok === false, res);
    check('T3.2 错误码是 home-node-offline', res.error === 'home-node-offline', res.error);
    check('T3.3 **没有**写入第二份 canonical（镜像里也没有）',
      !local.state.rows.has('m-offline'), Array.from(local.state.rows.keys()));
    check('T3.4 失败计入 failures', authority.status().stats.failures >= 1);
    check('T3.5 status.authorityEffective 为 false（不假装权威生效）',
      authority.status().authorityEffective === false);
    check('T3.6 status.degraded 为 true 且给出原因',
      authority.status().degraded === true && typeof authority.status().degradedReason === 'string',
      authority.status().degradedReason);
  }

  /* ══════════════ T4 · 明确拒绝 ≠ 离线 ════════════════════════════════════ */
  section('T4 · Home Node 明确拒绝');
  {
    const remote = mockRemote();
    const local = mockLocal();
    remote.state.failPut = 'rejected';
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 5000 });
    const res = await authority.put(mem('m-bad'));
    check('T4.1 标记 rejected（不是离线）', res.ok === false && res.rejected === true, res);
    check('T4.2 错误码来自 Node 的拒绝语义（而**不是** home-node-offline —— 离线性必须可区分）',
      res.error === 'invalid-record' && res.error !== 'home-node-offline', res.error);
    check('T4.3 非法记录不落镜像', !local.state.rows.has('m-bad'));
  }

  /* ══════════════ T5 · 镜像写失败：canonical 仍是 Home Node ═══════════════ */
  section('T5 · 镜像写失败不谎报失败');
  {
    const remote = mockRemote();
    const local = mockLocal();
    local.state.failPut = true;
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 5000 });
    const res = await authority.put(mem('m-mirrorfail'));
    check('T5.1 整体仍报告成功（canonical 已落 Home Node）', res.ok === true, res);
    check('T5.2 如实报告 mirrored:false', res.mirrored === false, res);
    check('T5.3 带 mirrorError 字段', typeof res.mirrorError === 'string' && res.mirrorError.length > 0, res.mirrorError);
    check('T5.4 Home Node 里确实有这条', remote.state.stored.has('m-mirrorfail'));
    check('T5.5 镜像里确实没有这条', !local.state.rows.has('m-mirrorfail'));
  }

  /* ══════════════ T6 · 记忆可变：内容变化必须真的更新 ═════════════════════ */
  section('T6 · read-modify-write（与聊天迁移的真实差异）');
  {
    const remote = mockRemote();
    const local = mockLocal();
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 5000 });
    const first = await authority.put(mem('m1', { content: 'BEFORE-EDIT' }));
    check('T6.1 首次写入 created', first.outcome === 'created', first.outcome);
    const edit = await authority.put(mem('m1', { content: 'AFTER-EDIT' }));
    check('T6.2 内容编辑必须真的更新（不是像聊天迁移那样 skip）',
      edit.outcome === 'updated', edit.outcome);
    check('T6.3 Home Node 里是新内容', remote.state.stored.get('m1').content === 'AFTER-EDIT');
    const again = await authority.put(mem('m1', { content: 'AFTER-EDIT' }));
    check('T6.4 同内容重写 = skipped（幂等，revision 不动）',
      again.outcome === 'skipped' && again.revision === edit.revision, again);
    /* **Wave 2 的关键规则**：激活遥测不参与内容等价判定。 */
    const telemetry = await authority.put(mem('m1', { content: 'AFTER-EDIT', activationCount: 77, lastActivated: 999999 }));
    check('T6.5 仅激活遥测不同 → 仍然 skipped（否则重跑幂等性立刻失效）',
      telemetry.outcome === 'skipped', { outcome: telemetry.outcome, revision: telemetry.revision, expected: edit.revision });
  }

  /* ══════════════ T7 · 激活强化走独立通道 ════════════════════════════════ */
  section('T7 · 激活不推进结构版本');
  {
    const remote = mockRemote();
    const local = mockLocal();
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 5000 });
    await authority.put(mem('m1'));
    const revisionBefore = remote.state.revision;
    const res = await authority.recordActivation(['m1', 'm1'], {});
    check('T7.1 强化已 flush 到 Home Node', res.ok === true && res.flushed === true, res);
    check('T7.2 revisionTouched 为 false', res.revisionTouched === false, res);
    check('T7.3 **canonical revision 一个字都没动**',
      remote.state.revision === revisionBefore, { before: revisionBefore, after: remote.state.revision });
    check('T7.4 强化确实更新了 Home Node 的激活计数',
      remote.state.stored.get('m1').activationCount === 1, remote.state.stored.get('m1').activationCount);
    /* R2-H2 更新（原断言冻结的是 mirror-first 形状，与 R2-H1 的 normative contract 冲突）：
       canonical 成功但服务端**没有**回权威 telemetry（老服务端）时，镜像必须保持 stale ——
       禁止按 delta 猜一个可能已经过时的值（AUTHORITY §2.2，Strategy D 被禁）。 */
    check('T7.5 无权威 telemetry 时镜像**不**被猜测式 +1（保持 stale）',
      local.state.rows.get('m1').activationCount === 0 && res.mirrorStale === true,
      { mirror: local.state.rows.get('m1').activationCount, res: res });
    {
      /* R2-H2 新增：服务端回权威 per-id 值时，镜像 SET 成 canonical 值。 */
      const remoteT = mockRemote();
      remoteT.state.returnActivationTelemetry = true;
      const localT = mockLocal([mem('m1')]);
      const authorityT = AUTHORITY.createMemoryAuthority({ remote: remoteT, local: localT, mode: 'canonical', clock: () => 5000 });
      await authorityT.put(mem('m1'));   /* 先让 canonical 侧真的存在这条记录 */
      const resT = await authorityT.recordActivation(['m1'], {});
      check('T7.5b 权威 telemetry ⇒ 镜像 SET 成 canonical 值（不猜 delta）',
        resT.mirrorSynced === 1 && localT.state.rows.get('m1').activationCount === 1,
        { synced: resT.mirrorSynced, mirror: localT.state.rows.get('m1').activationCount });
    }
    check('T7.6 空选择是 no-op（不发起请求）',
      (await authority.recordActivation([], {})) .updated === 0);
    /* 强化失败绝不抛出（排名提示不是事实） */
    const remote2 = mockRemote({ online: false });
    const authority2 = AUTHORITY.createMemoryAuthority({ remote: remote2, local: mockLocal([mem('m1')]), mode: 'canonical', clock: () => 5000 });
    let threw = false;
    let failedRes = null;
    try { failedRes = await authority2.recordActivation(['m1'], {}); } catch (e) { threw = true; }
    check('T7.7 Home Node 离线时强化失败**不抛出**', threw === false, { threw: threw });
    check('T7.8 失败仍如实报告 flushed:false', failedRes && failedRes.ok === false && failedRes.flushed === false, failedRes);
    check('T7.9 强化失败计入 activationFailures',
      authority2.status().stats.activationFailures >= 1);
  }

  /* ══════════════ T8 · 迁移：幂等 / 可续 / id 集合凭据 ═══════════════════ */
  section('T8 · 迁移幂等与续跑');
  {
    const seed = [mem('m1', { created: 100 }), mem('m2', { created: 200 }), mem('m3', { created: 300 })];
    const remote = mockRemote();
    const local = mockLocal(seed);
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 5000 });

    const run1 = await authority.migrate({ source: 'browser-indexeddb:memory' });
    check('T8.0 镜像备好 3 条（否则下面的断言会因"没东西可迁"而假绿）',
      (await local.getAll()).length === 3, (await local.getAll()).length);
    check('T8.1 首跑迁移成功且写入 3 条',
      run1.ok === true && run1.created === 3, { created: run1.created, total: run1.total, error: run1.error, report: run1 });
    check('T8.2 首跑报告 completed', run1.completed === true);
    check('T8.3 迁移报告带 id 集合（可编辑记录的增量核对凭据）',
      Array.isArray(run1.idSet) && run1.idSet.length === 3, run1.idSet);
    const revAfter1 = remote.state.revision;

    const run2 = await authority.migrate({ source: 'browser-indexeddb:memory', full: true });
    check('T8.4 重跑不产生新版本（全部 skipped，revision 不动）',
      run2.skipped === 3 && remote.state.revision === revAfter1,
      { skipped: run2.skipped, revision: remote.state.revision, before: revAfter1 });
    check('T8.5 重跑不重复插入（总数仍为 3）', remote.state.stored.size === 3, remote.state.stored.size);

    /* 中断 → 续跑：第一批之后失败，marker 不写，水位停在已确认前缀。 */
    const remote2 = mockRemote();
    const local2 = mockLocal([mem('a', { created: 100 }), mem('b', { created: 200 }), mem('c', { created: 300 }), mem('d', { created: 400 })]);
    const authority2 = AUTHORITY.createMemoryAuthority({ remote: remote2, local: local2, mode: 'canonical', clock: () => 5000 });
    const interrupted = await authority2.migrate({ source: 'browser-indexeddb:memory', batchSize: 2, maxBatches: 1 });
    check('T8.6 中断报告 ok=true 但 completed=false', interrupted.completed === false, interrupted);
    check('T8.7 中断后 Home Node 上只有第一批', remote2.state.stored.size === 2, remote2.state.stored.size);
    check('T8.8 中断仍写了水位 marker（可续跑的前提）',
      remote2.state.calls.mark.length >= 1, remote2.state.calls.mark.length);

    const resumed = await authority2.migrate({ source: 'browser-indexeddb:memory', batchSize: 2 });
    check('T8.9 续跑补齐剩余记录', remote2.state.stored.size === 4, remote2.state.stored.size);
    check('T8.10 续跑后 completed', resumed.completed === true);
    check('T8.11 续跑不丢不重（id 集合一致）',
      Array.from(remote2.state.stored.keys()).sort().join(',') === 'a,b,c,d',
      Array.from(remote2.state.stored.keys()).sort());

    /* 离线迁移：明确失败、不写 marker。 */
    const remote3 = mockRemote({ online: false });
    const authority3 = AUTHORITY.createMemoryAuthority({ remote: remote3, local: mockLocal([mem('x')]), mode: 'canonical', clock: () => 5000 });
    const off = await authority3.migrate({ source: 's' });
    check('T8.12 Home Node 离线时迁移明确失败', off.ok === false, off);
    check('T8.13 离线迁移不写水位 marker（下次重跑安全）',
      remote3.state.calls.mark.length === 0, remote3.state.calls.mark.length);

    /* 迁移绝不 clear IndexedDB */
    check('T8.14 迁移后镜像仍然完整（回滚影子）',
      local2.state.rows.size === 4 && local2.state.calls.replaceAll === 0,
      { rows: local2.state.rows.size, replaceAll: local2.state.calls.replaceAll });
  }

  /* ══════════════ T9 · mirror / off 模式 ═════════════════════════════════ */
  section('T9 · mirror / off 模式不宣称权威');
  {
    for (const mode of ['mirror', 'off']) {
      const remote = mockRemote();
      const local = mockLocal();
      const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: mode, clock: () => 5000 });
      const res = await authority.put(mem('m-' + mode));
      check('T9 ' + mode + '：写退回本地并标注 indexeddb',
        res.ok === true && res.authority === 'indexeddb' && res.mirrorOnly === true, res);
      check('T9 ' + mode + '：**没有**请求 Home Node',
        remote.state.calls.put.length === 0, remote.state.calls.put.length);
      check('T9 ' + mode + '：status.authority = indexeddb 且 effective=false',
        authority.status().authority === 'indexeddb' && authority.status().authorityEffective === false,
        authority.status());
      check('T9 ' + mode + '：本地确实写入了', local.state.rows.has('m-' + mode));
    }
    /* off 模式连探测都不做 */
    const remoteOff = mockRemote();
    const authOff = AUTHORITY.createMemoryAuthority({ remote: remoteOff, local: mockLocal(), mode: 'off', clock: () => 5000 });
    await authOff.sync();
    check('T9.off：不探测 Home Node（跳过同步）', remoteOff.state.calls.health === 0 && remoteOff.state.calls.list.length === 0);
  }

  /* ══════════════ T10 · file:// 承载：显式声明未生效 ═════════════════════ */
  section('T10 · file:// 承载');
  {
    const remote = mockRemote();
    const local = mockLocal();
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', fileOrigin: true, clock: () => 5000 });
    const res = await authority.put(mem('m-file'));
    check('T10.1 file:// 下写走本地（不让桌面记忆面板坏掉）',
      res.ok === true && res.authority === 'indexeddb', res);
    check('T10.2 明确声明原因为 file-origin-cannot-reach-home-node',
      authority.status().degradedReason === 'file-origin-cannot-reach-home-node', authority.status().degradedReason);
    check('T10.3 不假装权威生效', authority.status().authorityEffective === false);
    check('T10.4 file:// 下不请求 Home Node', remote.state.calls.put.length === 0);
  }

  /* ══════════════ T11 · 契约：遥测字段与 owner 取值 ══════════════════════ */
  section('T11 · memory-contract 纯函数语义');
  {
    check('T11.1 内容等价忽略 activationCount / lastActivated',
      CONTRACT.contentIdentical(
        { id: 'x', title: 'T', activationCount: 1, lastActivated: 5 },
        { id: 'x', title: 'T', activationCount: 99, lastActivated: 999 }) === true);
    check('T11.2 内容等价**不**忽略真实内容差异',
      CONTRACT.contentIdentical({ id: 'x', title: 'T' }, { id: 'x', title: 'U' }) === false);
    check('T11.3 键顺序不影响等价判定',
      CONTRACT.contentIdentical({ id: 'x', a: 1, b: 2 }, { b: 2, id: 'x', a: 1 }) === true);
    check('T11.4 owner 缺省为 user（既有 production 语义）',
      CONTRACT.ownerIdOf({ id: 'x' }) === 'user' && CONTRACT.ownerIdOf({ id: 'x', createdBy: '' }) === 'user');
    check('T11.5 owner 保留真实 createdBy', CONTRACT.ownerIdOf({ id: 'x', createdBy: 'role-a' }) === 'role-a');
    check('T11.6 缺失 visibility **不**被补成 public（C1 fail-closed 依赖它保持缺失）',
      CONTRACT.stripTelemetry({ id: 'x', visibility: undefined }).visibility === undefined);
    check('T11.7 结构校验拒绝无 id 的记录',
      CONTRACT.validateRecord({ title: 'T' }).ok === false);
    check('T11.8 结构校验拒绝非字符串 visibility（语义合法性刻意不检查）',
      CONTRACT.validateRecord({ id: 'x', visibility: 123 }).ok === false);
    check('T11.9 缺失 visibility 的记录**通过**结构校验（语义由 C1 决定）',
      CONTRACT.validateRecord({ id: 'x' }).ok === true);
    /* 时间戳损坏时不能落到"现在"：那会把它排到最新，改变召回顺序。 */
    check('T11.10 无法解析的 created 落 0（不落 now）', CONTRACT.createdAtOf({ created: 'not-a-number' }) === 0);
    check('T11.11 lastActivated 缺席为 null（不是 0，0 会参与衰减计算）',
      CONTRACT.lastActivatedAtOf({}) === null);
  }

  console.log('\nMemory authority: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch(error => {
  console.error('test crashed:', error);
  process.exit(1);
});
