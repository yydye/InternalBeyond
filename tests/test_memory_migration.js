'use strict';
/* Internal Beyond · M1-C.2d Wave 2 · Memory 迁移（static，零依赖，零浏览器，零真实网络）
   运行：node tests/test_memory_migration.js

   这是 Wave 2 迁移的端到端验证：**真实的** canonical memory store（node:sqlite，
   临时目录）← 真实的 HTTP 响应形状 ← 真实的 assets/js/memory-authority.js 迁移逻辑
   ← mock 的浏览器 IndexedDB 内容。

   覆盖 §5 / §10 / T1-T3 / T5 要求的情形：
     · 空库迁移
     · 已有记忆迁移（provenance / consolidation / 可见性 / 遥测全部保留）
     · 重复迁移（幂等：不重复插入、不前进 revision、不覆盖 Node 已有内容）
     · 迁移中断后继续（不写 marker、水位可续、重跑安全）
     · **激活遥测不参与内容等价判定**（否则重跑幂等性立刻失效）
     · **可见性逐字保留**（missing visibility 必须保持 missing，不能被补成 public）
     · id 集合凭据：可编辑记录的增量核对依据
     · 绝不 clear IndexedDB（镜像保留为回滚影子）
     · 迁移不解析、不修复 evidenceIds */
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'memory-authority.js'));
const CONTRACT = require(path.join(ROOT, 'assets', 'js', 'memory-contract.js'));
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

/* ── mock local：浏览器 IndexedDB 镜像（迁移的**来源**）──────────── */
function mockLocal(seed) {
  const state = { rows: new Map(), calls: { replaceAll: 0, applyUpserts: 0, applyDeletes: 0, put: 0, remove: 0, bump: 0 } };
  for (const m of seed || []) if (m && m.id) state.rows.set(m.id, m);
  return {
    state,
    get: id => Promise.resolve(state.rows.get(id) || null),
    getAll: () => Promise.resolve(Array.from(state.rows.values())),
    put: m => { state.calls.put++; state.rows.set(m.id, m); return Promise.resolve(); },
    remove: id => { state.calls.remove++; state.rows.delete(id); return Promise.resolve(); },
    bumpActivation: () => { state.calls.bump++; return Promise.resolve(0); },
    applyUpserts: ms => { state.calls.applyUpserts++; for (const m of ms) state.rows.set(m.id, m); return Promise.resolve(); },
    applyDeletes: ds => { state.calls.applyDeletes++; for (const d of ds) state.rows.delete(d.recordId); return Promise.resolve(); },
    replaceAll: ms => { state.calls.replaceAll++; state.rows.clear(); for (const m of ms) state.rows.set(m.id, m); return Promise.resolve(); }
  };
}

/* ── remote：把真实 store 包成 HTTP 响应形状（与 memory-gateway 路由逐条对应，
      但不经过网络 —— 网络路径由 test_mobile_memory_continuity.js 覆盖）── */
function storeRemote(store, options) {
  options = options || {};
  const state = {
    offlineAfterBatch: options.offlineAfterBatch == null ? Infinity : options.offlineAfterBatch,
    batchCount: 0
  };
  function offline() { return { ok: false, error: 'home-node-unreachable', offline: true, retryable: true }; }
  return {
    state,
    health: () => Promise.resolve(store.isOpen() ? { ok: true, service: 'internal-beyond-home-node' } : offline()),
    list: function (query) {
      const res = store.listRecords(query || {});
      if (!res.ok) return Promise.resolve({ ok: false, error: res.error });
      return Promise.resolve({ ok: true, records: res.records, revision: res.revision, truncated: res.truncated });
    },
    changes: function (cursor) {
      const res = store.changesAfter(cursor, {});
      return Promise.resolve(res.ok
        ? { ok: true, cursor: res.cursor, upserts: res.upserts, deletes: res.deletes, hasMore: res.hasMore, revision: res.revision }
        : { ok: false, error: res.error });
    },
    put: function (record, opts) {
      return Promise.resolve(store.putRecord(record, {
        requestId: (opts && opts.requestId) || '',
        existingPolicy: (opts && opts.existingPolicy) || 'overwrite'
      }));
    },
    putBatch: function (records, opts) {
      state.batchCount++;
      if (state.batchCount > state.offlineAfterBatch) return Promise.resolve(offline());
      return Promise.resolve(store.putRecords(records, {
        requestId: (opts && opts.requestId) || '',
        existingPolicy: (opts && opts.existingPolicy) || 'overwrite'
      }));
    },
    remove: id => Promise.resolve(store.deleteRecord(id, {})),
    activate: (ids, opts) => Promise.resolve(store.recordActivation(ids, opts || {})),
    migrationState: source => Promise.resolve({ ok: true, source: source, state: store.getMigrationState(source) }),
    markMigration: (source, patch) => Promise.resolve(store.setMigrationState(source, patch)),
    putSettings: settings => Promise.resolve(store.setMemorySettings(settings))
  };
}

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-memmig-'));
  const store = createMemoryStore({ dataDir: dir, clock: () => 1700000000000 });
  store.open();
  return { store, dir };
}

/* 一份典型的浏览器旧记忆库：覆盖 provenance / consolidation / 四种可见性 /
   激活遥测 / 缺失字段（老数据）。 */
function browserMemories() {
  return [
    { id: 'mem_1', kind: 'episodic', title: '第一次见面', content: '用户在图书馆遇到她。', domain: '情感', tags: ['初见'], valence: 0.7, arousal: 0.5, importance: 8, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [], activationCount: 4, created: 1700000000001, lastActivated: 1700000000100, createdBy: 'user', createdByName: '', editedByUser: false },
    { id: 'mem_2', kind: 'semantic', title: '用户在做的项目', content: '用户在做 InternalBeyond。', domain: '思考', tags: ['项目'], valence: 0.6, arousal: 0.4, importance: 9, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [], activationCount: 12, created: 1700000000002, lastActivated: 1700000000200, createdBy: 'user', createdByName: '', consolidatedFrom: ['mem_1', 'mem_3'], lastConsolidatedAt: 1700000000500 },
    { id: 'mem_3', kind: 'episodic', title: '只有她能看到', content: '用户只对她说了这件事。', domain: '日常', tags: [], valence: 0.5, arousal: 0.3, importance: 7, resolved: false, visibility: 'only', visibleTo: ['friend_1'], excludeFrom: [], activationCount: 1, created: 1700000000003, lastActivated: 1700000000300, createdBy: 'friend_1', createdByName: '昔涟' },
    { id: 'mem_4', kind: 'episodic', title: '除了某人都能看到', content: '这条对 friend_9 隐藏。', domain: '日常', tags: [], valence: 0.5, arousal: 0.3, importance: 5, resolved: true, visibility: 'except', visibleTo: [], excludeFrom: ['friend_9'], activationCount: 0, created: 1700000000004, lastActivated: 1700000000400, createdBy: 'user' },
    /* 老数据：完全没有 visibility 字段。**必须原样保留缺失** —— C1 的
       fail-closed 正是靠"缺失保持缺失"成立；补一个 public 会把它变成公开记忆。 */
    { id: 'mem_legacy', title: '老数据没有可见性字段', content: '旧版本写入的记忆。', domain: '日常', tags: [], importance: 6, resolved: false, activationCount: 0, created: 1700000000005, lastActivated: 1700000000500, createdBy: 'user' },
    /* 私有：对任何角色都不可见。 */
    { id: 'mem_private', kind: 'episodic', title: '完全私密', content: '用户从不对任何人说。', domain: '思考', tags: [], valence: 0.4, arousal: 0.3, importance: 10, resolved: false, visibility: 'private', visibleTo: [], excludeFrom: [], activationCount: 0, created: 1700000000006, lastActivated: 1700000000600, createdBy: 'user' },
    /* 带 evidence 语义的派生记录：迁移**不得**解析或修复它。 */
    { id: 'mem_with_evidence', kind: 'semantic', title: '带证据的派生记忆', content: '从证据归纳出来的。', domain: '思考', tags: [], valence: 0.5, arousal: 0.3, importance: 7, resolved: false, visibility: 'public', visibleTo: [], excludeFrom: [], activationCount: 0, created: 1700000000007, lastActivated: 1700000000700, createdBy: 'user', evidenceIds: ['mem_1', 'mem_does_not_exist'], unknownFutureField: { nested: true, list: [1, 2, 3] } }
  ];
}

(async () => {

  /* ══════════════ 1 · 空库迁移 ══════════════════════════════════════════ */
  section('1 · 空库迁移');
  {
    const { store } = freshStore();
    const local = mockLocal([]);
    const authority = AUTHORITY.createMemoryAuthority({ remote: storeRemote(store), local, mode: 'canonical', clock: () => 1700000000000 });
    const res = await authority.migrate({ source: 'browser-indexeddb:memory' });
    check('migrate-empty 空库迁移成功', res.ok === true && res.total === 0 && res.completed === true, res);
    check('migrate-empty 不产生任何记录', store.countRecords() === 0, store.countRecords());
    check('migrate-empty revision 仍为 0', store.getRevision() === 0, store.getRevision());
    check('migrate-empty 仍写 marker（表示"迁移过且当时为空"）',
      store.getMigrationState('browser-indexeddb:memory').version >= 1, store.getMigrationState('browser-indexeddb:memory'));
    store.close();
  }

  /* ══════════════ 2 · T1 · 已有记忆迁移：语义逐条保留 ═══════════════════ */
  section('2 · T1 迁移完整性（语义逐条保留）');
  {
    const { store } = freshStore();
    const local = mockLocal(browserMemories());
    const authority = AUTHORITY.createMemoryAuthority({ remote: storeRemote(store), local, mode: 'canonical', clock: () => 1700000000000 });
    const res = await authority.migrate({ source: 'browser-indexeddb:memory' });

    check('T1.1 全部 7 条迁移完成', res.ok === true && res.created === 7 && res.completed === true,
      { created: res.created, total: res.total, error: res.error });
    check('T1.2 canonical 里确实有 7 条', store.countRecords() === 7, store.countRecords());

    /* 逐字段：**逐字**等价（不是"看起来差不多"）。 */
    const before = new Map(browserMemories().map(m => [m.id, m]));
    let mismatched = [];
    for (const [id, original] of before) {
      const after = store.getRecord(id);
      if (!after) { mismatched.push(id + ':missing'); continue; }
      /* 内容投影必须逐字相等（激活遥测由提升列回填，值也必须一致）。 */
      if (CONTRACT.contentFingerprint(original) !== CONTRACT.contentFingerprint(after)) {
        mismatched.push(id + ':content');
      }
      if (Number(original.activationCount || 0) !== Number(after.activationCount || 0)) mismatched.push(id + ':activationCount');
      if (Number(original.lastActivated || 0) !== Number(after.lastActivated || 0)) mismatched.push(id + ':lastActivated');
    }
    check('T1.3 每条记录的内容投影逐字相等（含未知字段往返）', mismatched.length === 0, mismatched);

    /* provenance 必须活下来。 */
    const consolidated = store.getRecord('mem_2');
    check('T1.4 consolidation provenance 保留（kind / consolidatedFrom / lastConsolidatedAt）',
      consolidated.kind === 'semantic' &&
      Array.isArray(consolidated.consolidatedFrom) && consolidated.consolidatedFrom.join(',') === 'mem_1,mem_3' &&
      consolidated.lastConsolidatedAt === 1700000000500,
      { kind: consolidated.kind, from: consolidated.consolidatedFrom, at: consolidated.lastConsolidatedAt });

    /* 未知字段必须能往返（约束 5）。 */
    const withEvidence = store.getRecord('mem_with_evidence');
    check('T1.5 evidenceIds 原样保留（迁移**不**解析、**不**修复）',
      Array.isArray(withEvidence.evidenceIds) &&
      withEvidence.evidenceIds.join(',') === 'mem_1,mem_does_not_exist',
      withEvidence.evidenceIds);
    check('T1.6 未知字段逐字往返（未来字段不会被投影掉）',
      JSON.stringify(withEvidence.unknownFutureField) === JSON.stringify({ nested: true, list: [1, 2, 3] }),
      withEvidence.unknownFutureField);

    /* ── 可见性 **逐字保留**（§6 的 byte-for-contract 要求）── */
    const legacy = store.getRecord('mem_legacy');
    check('T1.7 **缺失 visibility 保持缺失**（不被补成 public，否则 fail-closed 失效）',
      legacy.visibility === undefined && !('visibility' in legacy),
      { visibility: legacy.visibility, hasKey: 'visibility' in legacy });

    const only = store.getRecord('mem_3');
    check('T1.8 visibility=only + visibleTo 逐字保留',
      only.visibility === 'only' && only.visibleTo.join(',') === 'friend_1', { v: only.visibility, to: only.visibleTo });
    const except = store.getRecord('mem_4');
    check('T1.9 visibility=except + excludeFrom 逐字保留',
      except.visibility === 'except' && except.excludeFrom.join(',') === 'friend_9', { v: except.visibility, ex: except.excludeFrom });
    const priv = store.getRecord('mem_private');
    check('T1.10 visibility=private 逐字保留', priv.visibility === 'private', priv.visibility);

    /* owner 分区：createdBy 逐字保留，缺省由既有 production 语义补 'user'。 */
    check('T1.11 owner 分区键来自 createdBy（friend_1 的记录归 friend_1）',
      store.listRecords({ ownerId: 'friend_1' }).count === 1, store.listRecords({ ownerId: 'friend_1' }).count);
    check('T1.12 迁移报告带 id 集合（7 条）', Array.isArray(res.idSet) && res.idSet.length === 7, res.idSet);

    /* 绝不 clear IndexedDB */
    check('T1.13 迁移绝不 clear IndexedDB（镜像完整保留为回滚影子）',
      local.state.rows.size === 7 && local.state.calls.replaceAll === 0,
      { rows: local.state.rows.size, replaceAll: local.state.calls.replaceAll });
    check('T1.14 迁移不删除本地任何记录', local.state.calls.remove === 0, local.state.calls.remove);

    /* ══════════ 3 · T2 · 幂等重跑 ══════════ */
    section('3 · T2 幂等重跑');
    const revAfterFirst = store.getRevision();
    const run2 = await authority.migrate({ source: 'browser-indexeddb:memory', full: true });
    check('T2.1 重跑全部 skipped（无重复插入）', run2.skipped === 7 && run2.created === 0, { skipped: run2.skipped, created: run2.created });
    check('T2.2 重跑不推进 revision', store.getRevision() === revAfterFirst,
      { after: store.getRevision(), before: revAfterFirst });
    check('T2.3 重跑后总数不变', store.countRecords() === 7, store.countRecords());

    /* **关键规则**：激活遥测不参与内容等价判定。
       模拟"迁移之后浏览器侧强化过"：只改 activationCount / lastActivated。 */
    const bumped = browserMemories();
    for (const m of bumped) { m.activationCount = (m.activationCount || 0) + 50; m.lastActivated = 1799999999999; }
    const local2 = mockLocal(bumped);
    const authority2 = AUTHORITY.createMemoryAuthority({ remote: storeRemote(store), local: local2, mode: 'canonical', clock: () => 1700000000000 });
    const run3 = await authority2.migrate({ source: 'browser-indexeddb:memory', full: true });
    check('T2.4 **仅激活遥测漂移时重跑仍然全部 skipped**（否则幂等性立刻失效）',
      run3.skipped === 7 && run3.updated === 0 && run3.created === 0,
      { skipped: run3.skipped, updated: run3.updated, created: run3.created });
    check('T2.5 遥测漂移不推进 revision', store.getRevision() === revAfterFirst, store.getRevision());
    check('T2.6 Node 自己的激活计数**没有**被旧快照回退',
      store.getRecord('mem_2').activationCount === 12, store.getRecord('mem_2').activationCount);

    /* 不覆盖 Node 已有内容（skip 策略）：Node 上内容更新时，迁移不得覆盖它。 */
    store.putRecord(Object.assign({}, browserMemories()[1], { content: 'NODE-IS-NEWER' }));
    const run4 = await authority.migrate({ source: 'browser-indexeddb:memory', full: true });
    check('T2.7 迁移不覆盖 Node 已有的不同内容', run4.updated === 0, { updated: run4.updated });
    check('T2.8 Node 上更新的内容被保留', store.getRecord('mem_2').content === 'NODE-IS-NEWER',
      store.getRecord('mem_2').content);
    store.close();
  }

  /* ══════════════ 4 · T3 · 中断 / 续跑 ══════════════════════════════════ */
  section('4 · T3 中断与续跑');
  {
    const { store } = freshStore();
    const local = mockLocal(browserMemories());
    /* offlineAfterBatch=1：第一批成功，第二批传输失败。 */
    const remote = storeRemote(store, { offlineAfterBatch: 1 });
    const authority = AUTHORITY.createMemoryAuthority({ remote, local, mode: 'canonical', clock: () => 1700000000000 });

    const interrupted = await authority.migrate({ source: 'browser-indexeddb:memory', batchSize: 3 });
    check('T3.1 中断时报告 ok=false 且给出失败位置',
      interrupted.ok === false && typeof interrupted.failedAt === 'number',
      { ok: interrupted.ok, failedAt: interrupted.failedAt, error: interrupted.error });
    check('T3.2 中断后只落了第一批（3 条）', store.countRecords() === 3, store.countRecords());
    /* 失败时**完全不写** marker（与 chat-authority.js:406 同一语义）。
       因此水位停在 0 —— 这不是缺陷：续跑不是靠"部分水位"成立的，而是靠
       「从头重放 + 内容相同即 skipped」，所以重放已提交的前缀是安全的。
       写一个只覆盖部分前缀的水位反而更危险：它会让下一次运行跳过
       尚未确认的记录。 */
    check('T3.3 中断时**不写**水位 marker（水位停 0，重放全靠 skip 保证幂等）',
      store.getMigrationState('browser-indexeddb:memory').version === 0,
      store.getMigrationState('browser-indexeddb:memory'));
    check('T3.4 中断时 completed=false', interrupted.completed !== true, interrupted.completed);

    /* 另一种中断：批次上限把运行**主动**截断（不是传输失败）。
       这种情形下已完成的批次是已确认的，因此必须写水位 —— 否则
       "受控分段迁移"就失去了续跑依据。 */
    {
      const { store: store2 } = freshStore();
      const remote2 = storeRemote(store2);
      const authority2 = AUTHORITY.createMemoryAuthority({
        remote: remote2, local: mockLocal(browserMemories()), mode: 'canonical', clock: () => 1700000000000
      });
      const capped = await authority2.migrate({ source: 'browser-indexeddb:memory', batchSize: 3, maxBatches: 1 });
      check('T3.4b 批次上限截断时 completed=false 但 ok=true',
        capped.ok === true && capped.completed === false, { ok: capped.ok, completed: capped.completed });
      check('T3.4c 批次上限截断时**写出**水位（已确认前缀的凭据）',
        store2.getMigrationState('browser-indexeddb:memory').version >= 1,
        store2.getMigrationState('browser-indexeddb:memory'));
      check('T3.4d 截断点之后剩余 4 条未迁移',
        store2.countRecords() === 3 && capped.pending === 7 && capped.processed === 3,
        { records: store2.countRecords(), pending: capped.pending, processed: capped.processed });
      store2.close();
    }

    /* 续跑（远端恢复）。最终结果必须与"一次跑完"**完全一致**。 */
    remote.state.offlineAfterBatch = Infinity;
    const resumed = await authority.migrate({ source: 'browser-indexeddb:memory', batchSize: 3 });
    check('T3.5 续跑完成', resumed.completed === true && resumed.ok === true, resumed);
    check('T3.6 续跑后总数为 7（不丢不重）', store.countRecords() === 7, store.countRecords());

    /* 与不间断迁移逐条比对：内容投影必须完全一致。 */
    const { store: reference } = freshStore();
    const refAuthority = AUTHORITY.createMemoryAuthority({
      remote: storeRemote(reference), local: mockLocal(browserMemories()), mode: 'canonical', clock: () => 1700000000000
    });
    await refAuthority.migrate({ source: 'browser-indexeddb:memory', batchSize: 100 });
    let diff = [];
    for (const m of browserMemories()) {
      const a = store.getRecord(m.id), b = reference.getRecord(m.id);
      if (!a || !b) { diff.push(m.id + ':missing'); continue; }
      if (CONTRACT.contentFingerprint(a) !== CONTRACT.contentFingerprint(b)) diff.push(m.id + ':content');
      if (Number(a.activationCount || 0) !== Number(b.activationCount || 0)) diff.push(m.id + ':activation');
      if (a.visibility !== b.visibility) diff.push(m.id + ':visibility');
    }
    check('T3.7 **续跑结果与不间断迁移逐条相等**（内容/遥测/可见性）', diff.length === 0, diff);
    check('T3.8 续跑同样保留缺失 visibility（老数据不变形）',
      store.getRecord('mem_legacy').visibility === undefined &&
      reference.getRecord('mem_legacy').visibility === undefined);
    /* 首跑的 created 全是 3；续跑只补剩余 —— 合计恰好 7，无重复。 */
    check('T3.9 第一次只 created 3 条（中断点之前的证据）', interrupted.created === 3, interrupted.created);
    check('T3.10 续跑 created 剩余 4 条', resumed.created === 4, resumed.created);
    store.close();
    reference.close();
  }

  /* ══════════════ 5 · id 集合凭据（可编辑记录的增量核对）════════════════ */
  section('5 · id 集合凭据');
  {
    const { store } = freshStore();
    const local = mockLocal(browserMemories());
    const authority = AUTHORITY.createMemoryAuthority({ remote: storeRemote(store), local, mode: 'canonical', clock: () => 1700000000000 });
    const res = await authority.migrate({ source: 'browser-indexeddb:memory' });
    const marker = store.getMigrationState('browser-indexeddb:memory');
    check('5.1 水位里带着完整 id 集合',
      Array.isArray(marker.idSet) && marker.idSet.length === 7, marker.idSet && marker.idSet.length);
    check('5.2 id 集合与 canonical 的 id 集合一致',
      marker.idSet.slice().sort().join(',') === store.listRecordIds().ids.slice().sort().join(','),
      { marker: marker.idSet.slice().sort(), canonical: store.listRecordIds().ids.slice().sort() });

    /* 为什么需要它：memories 可编辑，一条**旧**记录的内容变了而 created 不变，
       只靠时间戳水位发现不了。id 集合让"新增/缺失"可被核对。 */
    const edited = browserMemories();
    edited.push({ id: 'mem_added_later', title: '迁移后才写的', content: '新记录', domain: '日常', importance: 5, visibility: 'public', created: 1700000000008, lastActivated: 1700000000800, createdBy: 'user' });
    const local2 = mockLocal(edited);
    const authority2 = AUTHORITY.createMemoryAuthority({ remote: storeRemote(store), local: local2, mode: 'canonical', clock: () => 1700000000000 });
    const res2 = await authority2.migrate({ source: 'browser-indexeddb:memory', full: true });
    check('5.3 全量重跑时新增的记录被带入', store.getRecord('mem_added_later') !== null, store.countRecords());
    check('5.4 重跑报告的新 id 集合含新增项',
      res2.idSet.indexOf('mem_added_later') > -1, res2.idSet.length);
    check('5.5 旧记录仍然只 created 一次（没有因重跑而重复）',
      store.listRecords({}).records.filter(r => r.id === 'mem_1').length === 1);
    store.close();
  }

  /* ══════════════ 6 · T5 · 可见性逐字保留 → 召回顺序不变 ════════════════ */
  section('6 · T5 可见性逐字保留（迁移前后召回一致）');
  {
    const CORE = require(path.join(ROOT, 'assets', 'js', 'memory-retrieval-core.js'));
    const { store } = freshStore();
    const memories = browserMemories();
    const local = mockLocal(memories);
    const authority = AUTHORITY.createMemoryAuthority({ remote: storeRemote(store), local, mode: 'canonical', clock: () => 1700000000000 });
    await authority.migrate({ source: 'browser-indexeddb:memory' });

    const opts = { apiId: 'friend_1', now: 1700000100000, random: () => 0, userMessage: '项目', maxChars: 4000, contentLen: 300 };
    /* 迁移**前**（浏览器侧，直接在 mock 数据上召回） */
    const before = CORE.buildMemoryContext(memories, opts);
    /* 迁移**后**（canonical store 里读回来再召回） */
    const after = CORE.buildMemoryContext(store.listRecords({}).records, opts);
    check('T5.1 迁移前后选中的 id 集合完全一致',
      before.selected.map(s => s.id).join(',') === after.selected.map(s => s.id).join(','),
      { before: before.selected.map(s => s.id), after: after.selected.map(s => s.id) });
    check('T5.2 迁移前后渲染的上下文逐字一致',
      before.text === after.text, { beforeLen: before.text.length, afterLen: after.text.length });
    check('T5.3 private 记忆在两边都不入选（可见性是迁移不变量）',
      after.selected.every(s => s.id !== 'mem_private') && before.selected.every(s => s.id !== 'mem_private'),
      after.selected.map(s => s.id));
    check('T5.4 缺失 visibility 的老数据在两边都不入选（fail closed 被迁移保留）',
      after.selected.every(s => s.id !== 'mem_legacy') && before.selected.every(s => s.id !== 'mem_legacy'),
      after.selected.map(s => s.id));
    check('T5.5 only/visibleTo 命中的记录仍对 friend_1 可见',
      after.selected.some(s => s.id === 'mem_3') === before.selected.some(s => s.id === 'mem_3'),
      { after: after.selected.map(s => s.id), before: before.selected.map(s => s.id) });
    store.close();
  }

  console.log('\nMemory migration: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch(error => {
  console.error('test crashed:', error && error.stack || error);
  process.exit(1);
});
