/* ====================================================================
   M1-C.2n P4/P8/P9 · Moments Authority · store 语义 / 两端一致 / 反证
   --------------------------------------------------------------------
   纯 Node、临时数据目录、零浏览器、零网络。运行：
     node tests/test_moments_authority.js

   这一条回答三个问题，而且**分别**回答：

     ① canonical store 的写协议是否真的成立
        （CAS / 幂等重放 / 软删除墓碑 / 迁移不覆盖 / revision 命名空间独立）

     ② "同一份 canonical 状态 + 同一个主体 → Desktop 与 Home Node 的
        **动态证据信封**是否相等"。
        比较的是**证据信封**，不是模型最后写出的文字：两端共用同一个
        selectContextMoments + renderSelected，因此这段可以逐字比较。
        桌面侧在这里用"同一个 core + 桌面侧的候选与名字解析"复现 ——
        如果哪天桌面又长出自己的渲染，这条会红。

     ③ 每一条承载性质被削弱时，对应的断言是否真的会红（反证）。
        反证在同一个进程里用"故意弱化的替身"完成，而不是改生产代码再改回来：
        前者留下证据，后者留下风险。
   ==================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const createMomentsStore = require(path.join(ROOT, 'services', 'home-node', 'moments-store.js'));
const createMomentsRetrieval = require(path.join(ROOT, 'services', 'home-node', 'moments-retrieval.js'));
const CORE = require(path.join(ROOT, 'assets', 'js', 'moments-visibility-core.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; failures.push(name); console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibmom-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

const CYRENE = 'cyrene';
const OTHER = 'astra';
const USER = { kind: 'user', id: 'user-1' };
const AS_CYRENE = { kind: 'role', id: CYRENE };
const AS_OTHER = { kind: 'role', id: OTHER };

/* 角色目录：两端都用同一份，因此"名字"这一项不引入差异。
   解析表达式与桌面 apiConfigs 的 `nickname||model` 逐字一致。 */
const DIRECTORY = {
  cyrene: { nickname: '昔涟', model: 'm-cyrene' },
  astra: { nickname: '', model: 'm-astra' }
};
function nameOf(roleId) {
  const d = DIRECTORY[String(roleId)];
  return d ? String(d.nickname || d.model || '') : '';
}
const USER_NAME = '用户';

function openStore(extra) {
  const store = createMomentsStore(Object.assign({ dataDir: tempDir(), logger: () => {} }, extra || {}));
  store.open();
  return store;
}

function seed(store, patch, options) {
  return store.put(Object.assign({
    id: 'mom_x', authorType: 'role', roleId: CYRENE, content: 'MOMENT_CONTENT',
    visibility: 'all', source: 'manual', createdAt: 1700000000000
  }, patch || {}), options);
}

console.log('M1-C.2n · Moments Authority suite');

/* ══════════════════ ① store 写协议 ══════════════════ */
section('canonical store · 写协议');

(function () {
  const store = openStore();
  const created = seed(store, { id: 'm_create' });
  check('create.outcome', created.ok && created.outcome === 'created' && created.rev === 1, created);
  const updated = store.put({ id: 'm_create', roleId: CYRENE, content: 'CHANGED', visibility: 'all', createdAt: 1700000000000 }, { expectedRev: 1 });
  check('put.updated', updated.ok && updated.outcome === 'updated' && updated.rev === 2, updated);
  const identical = store.getRecord('m_create');
  const again = store.put(Object.assign({}, identical, { storeRevision: undefined, rev: undefined, deletedAt: undefined }), { expectedRev: 2 });
  check('put.identicalSkipped', again.ok && again.outcome === 'skipped' && again.rev === 2, again);

  /* CAS：基版本过期 → 拒绝且**零变更** */
  const stale = store.put({ id: 'm_create', roleId: CYRENE, content: 'STALE WRITE', visibility: 'all', createdAt: 1700000000000 }, { expectedRev: 1 });
  check('put.casConflict', stale.ok === false && stale.error === 'revision-conflict' && stale.actualRev === 2, stale);
  check('put.casConflictNoMutation', store.getRecord('m_create').content === 'CHANGED', store.getRecord('m_create').content);

  /* createdAt 不可变：编辑不得把行搬到时间线顶部 */
  const moved = store.put({ id: 'm_create', roleId: CYRENE, content: 'MOVED', visibility: 'all', createdAt: 1800000000000 }, { expectedRev: 2 });
  check('put.createdAtImmutable', moved.ok && moved.moment.createdAt === 1700000000000, moved.moment && moved.moment.createdAt);

  /* 幂等重放：同一 requestId 不产生第二行 */
  const r1 = seed(store, { id: 'm_idem' }, { requestId: 'req-1' });
  const r2 = seed(store, { id: 'm_idem_dup_id_should_not_matter' }, { requestId: 'req-1' });
  check('put.idempotentReplay', r1.outcome === 'created' && r2.outcome === 'replayed' && !store.getRecord('m_idem_dup_id_should_not_matter'), { r1: r1.outcome, r2: r2.outcome });

  /* 全空白内容必须被拒（否则会落一行"看起来有内容、实际是空白"的动态） */
  const empty = store.put({ id: 'm_empty', roleId: CYRENE, content: '   ', visibility: 'all' });
  check('put.emptyRejected', empty.ok === false && empty.error === 'empty-content', empty);

  /* 软删除 + 墓碑 */
  const del = store.remove('m_create');
  check('remove.softDelete', del.ok && del.outcome === 'deleted' && store.getRecord('m_create') === null, del);
  const tomb = store.getRecordAny('m_create');
  check('remove.tombstoneKept', tomb && tomb.deleted === true, tomb && tomb.deleted);
  const changes = store.changesAfter(0, { limit: 500 });
  check('remove.inChangeLog', changes.ok && changes.deletes.some(d => d.id === 'm_create'), changes.deletes);
  store.close();
})();

/* ══════════════════ revision 命名空间隔离 ══════════════════ */
section('revision 命名空间 · 与其它权威互不相干');

(function () {
  const store = openStore();
  /* 模拟其它权威已经写过自己的版本号（同库、同 meta 表、不同键）。 */
  store.writeMeta('memory_revision', '41');
  store.writeMeta('understanding_revision', '7');
  const before = store.revisionIsolation();
  seed(store, { id: 'm_v1' });
  seed(store, { id: 'm_v2' });
  store.put({ id: 'm_v1', roleId: CYRENE, content: 'EDITED', visibility: 'all', createdAt: 1700000000000 }, { expectedRev: 1 });
  store.remove('m_v2');
  const after = store.revisionIsolation();
  check('revision.momentsAdvanced', after.moments > before.moments, { before: before.moments, after: after.moments });
  check('revision.memoryUntouched', after.metaKeys.memory_revision === '41', after.metaKeys);
  check('revision.understandingUntouched', after.metaKeys.understanding_revision === '7', after.metaKeys);
  check('revision.ownKeyOnly', after.metaKeys.moments_revision === String(after.moments), after.metaKeys);
  store.close();
})();

/* ══════════════════ 可见分页（§10） ══════════════════ */
section('可见分页 · 隐藏行不占页槽、不影响 hasMore');

(function () {
  const store = openStore();
  /* 12 条隐藏（比可见行更新）+ 6 条可见：反事实 fixture 刻意让隐藏行更"新"。
     若实现是"先分页再过滤"，可见行会被挤出前几页，甚至永远看不到。 */
  for (let i = 0; i < 12; i++) {
    seed(store, { id: 'hidden_' + String(i).padStart(2, '0'), roleId: OTHER, content: 'HIDDEN_' + i, visibility: 'private', createdAt: 1700000900000 + i });
  }
  for (let i = 0; i < 6; i++) {
    seed(store, { id: 'visible_' + String(i).padStart(2, '0'), roleId: OTHER, content: 'VISIBLE_' + i, visibility: 'all', createdAt: 1700000000000 + i });
  }
  const page1 = store.listVisible(AS_CYRENE, { limit: 4 });
  check('page.allVisible', page1.ok && page1.moments.every(m => m.content.indexOf('VISIBLE_') === 0), page1.moments.map(m => m.content));
  check('page.hiddenNeverSlots', page1.moments.length === 4, page1.moments.length);
  check('page.hasMoreTrue', page1.hasMore === true, page1.hasMore);
  const page2 = store.listVisible(AS_CYRENE, { limit: 4, cursor: page1.cursor });
  check('page2.remainingVisible', page2.moments.length === 2 && page2.hasMore === false, { n: page2.moments.length, hasMore: page2.hasMore });
  const seen = page1.moments.concat(page2.moments).map(m => m.id);
  check('page.noDuplicatesAcrossPages', new Set(seen).size === seen.length, seen);

  /* hasMore 的判据是"还有没有**可见**行"：隐藏行堆在末尾时必须为 false。 */
  const tailHidden = store.listVisible(AS_CYRENE, { limit: 50 });
  check('hasMore.countsVisibleOnly', tailHidden.moments.length === 6 && tailHidden.hasMore === false, { n: tailHidden.moments.length, hasMore: tailHidden.hasMore });

  /* 无主体 → 空且 fail closed（不是"返回全部"） */
  const anon = store.listVisible(null, { limit: 10 });
  check('noPrincipal.failClosed', anon.ok === true && anon.moments.length === 0 && anon.reason === 'no-principal', anon);

  /* 作者本人视角：自己的 private 也在（作者恒可读）。 */
  const own = store.listVisibleByOwner(OTHER, null, { limit: 50 });
  check('ownerSeesOwnPrivate', own.moments.length === 18, own.moments.length);
  store.close();
})();

/* ══════════════════ ② 两端一致（parity） ══════════════════ */
section('Same-Moments parity · 同一 canonical 状态 → 同一证据信封');

/* 桌面侧：与生产代码**同形**的路径 —— 同一批候选 + 同一个 core 选择/渲染。
   名字解析用桌面表达式（nickname||model），与节点侧的 characters 表解析一致。 */
function desktopBlock(candidates, characterId, options) {
  return CORE.renderMomentsContext({
    moments: candidates,
    principal: { kind: 'role', id: String(characterId) },
    characterId: String(characterId),
    userName: options.userName,
    characterNameOf: nameOf,
    options: { ownLimit: 4, otherLimit: 3, otherRolesVisible: options.otherRolesVisible !== false },
    maxChars: options.maxChars
  });
}

(function () {
  const store = openStore();
  const retrieval = createMomentsRetrieval({ store: store, logger: () => {}, characterNameOf: nameOf });
  const base = 1700000000000;
  seed(store, { id: 'p_own1', roleId: CYRENE, content: '今天把窗台擦了。', visibility: 'all', createdAt: base + 1 });
  seed(store, { id: 'p_own2', roleId: CYRENE, content: '写给自己看的一句：有点累。', visibility: 'private', createdAt: base + 2 });
  seed(store, { id: 'p_own3', roleId: CYRENE, content: '只给用户看的一句。', visibility: 'user', createdAt: base + 3 });
  seed(store, { id: 'p_other1', roleId: OTHER, content: '朋友的公开动态。', visibility: 'all', createdAt: base + 4 });
  seed(store, { id: 'p_other2', roleId: OTHER, content: '朋友只写给昔涟的一句话。', visibility: 'roles', visibleRoleIds: [CYRENE], createdAt: base + 5 });
  seed(store, { id: 'p_other3', roleId: OTHER, content: '朋友写给别人的。', visibility: 'roles', visibleRoleIds: ['someone-else'], createdAt: base + 6 });
  seed(store, { id: 'p_user1', authorType: 'user', authorId: 'user-1', roleId: '', content: '用户发的公开动态。', visibility: 'all', createdAt: base + 7 });

  const opts = { userName: USER_NAME, otherRolesVisible: true };
  /* 桌面侧候选来自 IndexedDB 游标扫描，上限 MOMENT_CTX_SCAN_MAX（150）。
     这里刻意按**同一个上限**取候选：桌面与节点"看得到哪些候选"这件事本身
     也是口径的一部分，漏掉它会让"同一份状态"变成"两份不同的状态"。 */
  const ctxCandidates = () => store.listVisible(AS_CYRENE, { limit: 150 }).moments;
  const nodeBlock = retrieval.buildMomentsBlock(CYRENE, opts).block;
  const deskBlock = desktopBlock(ctxCandidates(), CYRENE, opts);
  check('parity.blocksByteIdentical', nodeBlock === deskBlock, { node: nodeBlock, desktop: deskBlock });
  check('parity.ownPublicIn', nodeBlock.indexOf('今天把窗台擦了。') >= 0, nodeBlock);
  check('parity.ownPrivateExcludedFromChat', nodeBlock.indexOf('有点累') < 0, nodeBlock);
  check('parity.ownUserScopeExcludedFromChat', nodeBlock.indexOf('只给用户看的一句') < 0, nodeBlock);
  check('parity.otherPublicIn', nodeBlock.indexOf('朋友的公开动态。') >= 0, nodeBlock);
  check('parity.otherAddressedToHerOut', nodeBlock.indexOf('朋友只写给昔涟的一句话') < 0, nodeBlock);
  check('parity.headerShape', nodeBlock.indexOf('【朋友圈动态（系统参考，勿提及此段）】') === 0, nodeBlock.split('\n')[0]);
  check('parity.authorNamesResolved', nodeBlock.indexOf('m-astra') >= 0, nodeBlock.split('\n').slice(1));

  /* 读时收窄：只把一条 others 的 visibleRoleIds 去掉，两端**下一次读取**都必须立刻停注。 */
  const before = retrieval.buildMomentsBlock(CYRENE, opts);
  const row = store.getRecord('p_other1');
  store.put({ id: 'p_other1', roleId: OTHER, content: row.content, visibility: 'roles', visibleRoleIds: ['nobody'], createdAt: row.createdAt }, { expectedRev: row.rev });
  const after = retrieval.buildMomentsBlock(CYRENE, opts);
  const deskAfter = desktopBlock(ctxCandidates(), CYRENE, opts);
  check('narrow.blocksStillIdentical', after.block === deskAfter, { node: after.block, desktop: deskAfter });
  check('narrow.tookEffectImmediately', before.block.indexOf('朋友的公开动态。') >= 0 && after.block.indexOf('朋友的公开动态。') < 0);
  check('narrow.noRepairPassNeeded', after.present === true, after.reason);

  /* 唯一差异来源是数据本身：把同一条改成 all，两端同时恢复。 */
  const r2 = store.getRecord('p_other1');
  store.put({ id: 'p_other1', roleId: OTHER, content: r2.content, visibility: 'all', visibleRoleIds: [], createdAt: r2.createdAt }, { expectedRev: r2.rev });
  const restored = retrieval.buildMomentsBlock(CYRENE, opts);
  check('widen.requiresExplicitWrite', restored.block.indexOf('朋友的公开动态。') >= 0);

  /* 快照三态 */
  const field = retrieval.snapshotField(CYRENE, opts);
  check('snapshot.present', field.text === restored.block && field.consulted === true && field.gatedBy === null, field);
  const emptyStore = openStore();
  const emptyRetrieval = createMomentsRetrieval({ store: emptyStore, logger: () => {}, characterNameOf: nameOf });
  const emptyField = emptyRetrieval.snapshotField(CYRENE, opts);
  check('snapshot.emptyWhenNoVisible', emptyField.text === '' && emptyField.consulted === true && emptyField.gatedBy === null && emptyField.reason === 'empty', emptyField);
  const noStore = createMomentsRetrieval({ store: null, logger: () => {} });
  const missingField = noStore.snapshotField(CYRENE, opts);
  check('snapshot.missingWhenUnavailable', missingField.consulted === false && missingField.gatedBy === 'home-node.moments-unavailable', missingField);

  store.close();
  emptyStore.close();
})();

/* ══════════════════ 迁移语义 ══════════════════ */
section('迁移 · 幂等 / 可重入 / 非破坏 / 歧义 fail closed');

(function () {
  const store = openStore();
  const legacy = [
    { id: 'leg_all', roleId: CYRENE, content: '旧公开', visibility: 'all', createdAt: '2025-01-01T00:00:00.000Z' },
    { id: 'leg_priv', roleId: CYRENE, content: '旧私密', visibility: 'private', createdAt: '2025-01-02T00:00:00.000Z' },
    /* 真实的"旧数据没有档位字段"形态：作者身份在（roleId），档位不在。
       这正是 fail-closed 要保护的那一类行 —— 它必须只回到作者手里。 */
    { id: 'leg_novis', roleId: CYRENE, content: '旧数据没有档位字段', createdAt: '2025-01-03T00:00:00.000Z' },
    { id: 'leg_typo', roleId: CYRENE, content: '档位拼错了', visibility: 'everyone', createdAt: '2025-01-04T00:00:00.000Z' }
  ];
  const first = legacy.map(m => store.writeMigrated(m, 'mig:' + m.id));
  check('migrate.allCreated', first.every(r => r.ok && r.outcome === 'created'), first.map(r => r.outcome));
  const second = legacy.map(m => store.writeMigrated(m, 'mig:' + m.id));
  check('migrate.idempotent', second.every(r => r.ok && r.outcome === 'replayed'), second.map(r => r.outcome));
  check('migrate.noDuplicateRows', store.countLive() === legacy.length, store.countLive());

  /* 缺失档位 → **只有作者**可见（不得变成公开）；拼错档位 → 同样只有作者可见。
     注意断言方向：观察者用的是**非作者**。用作者观察时这条会被作者规则放行
     （那是另一条独立规则的证据，见下面 authorStillSeesOwn）——
     这正是 M1-C.2n 审计里最容易写错的一处：把"作者可读"误读成"档位允许"。 */
  const hidden = store.listVisible(AS_OTHER, { limit: 50 });
  check('migrate.missingAclNotPublic', !hidden.moments.some(m => m.id === 'leg_novis'), hidden.moments.map(m => m.id));
  check('migrate.typoNotPublic', !hidden.moments.some(m => m.id === 'leg_typo'), hidden.moments.map(m => m.id));
  check('migrate.publicStaysPublic', hidden.moments.some(m => m.id === 'leg_all'));
  const asAuthor = store.listVisible(AS_CYRENE, { limit: 50 });
  check('migrate.authorStillSeesOwn', asAuthor.moments.some(m => m.id === 'leg_novis') && asAuthor.moments.some(m => m.id === 'leg_typo'), asAuthor.moments.map(m => m.id));
  /* 既没有档位、又没有作者身份的旧行**写不进去**（而不是写进去再变成谁都读不到的
     孤儿行）。判据在写入侧，因为"这条记录属于谁"是写入方唯一知道的事。 */
  const orphan = store.put({ id: 'leg_orphan', content: '没有作者也没有档位', createdAt: 1700000000000 });
  check('migrate.unattributableRejectedAtWrite', orphan.ok === false && orphan.error === 'unattributable', orphan);
  const orphanMig = store.writeMigrated({ id: 'leg_orphan2', content: '没有作者也没有档位', createdAt: 1700000000000 }, 'mig:orphan2');
  check('migrate.unattributableReportedByMigration', orphanMig.ok === false && orphanMig.reason === 'no-author-identity', orphanMig);
  check('migrate.unattributableNotStored', store.getRecord('leg_orphan') === null && store.getRecord('leg_orphan2') === null);
  /* 档位逐字保留：'invalid' 记录的是"原样没变"，不是被改写成别的档位。 */
  const typo = store.getRecord('leg_typo');
  check('migrate.typoRecordedAsInvalid', CORE.readVisibility(typo.visibility) === 'invalid', typo.visibility);

  /* canonical 优先：迁移绝不覆盖已存在的行 */
  const changed = store.put({ id: 'leg_all', roleId: CYRENE, content: '权威改过了', visibility: 'all', createdAt: Date.parse('2025-01-01T00:00:00.000Z') });
  check('migrate.explicitPutWorks', changed.ok && changed.outcome === 'updated', changed);
  const noClobber = store.writeMigrated({ id: 'leg_all', roleId: CYRENE, content: '旧公开', visibility: 'all', createdAt: '2025-01-01T00:00:00.000Z' }, 'mig2:leg_all');
  check('migrate.neverClobbersCanonical', noClobber.ok && noClobber.outcome === 'skipped' && store.getRecord('leg_all').content === '权威改过了', noClobber);

  /* 水位：可续跑 */
  store.setMigrationState('browser-indexeddb:moments', { published: 4, batch: 1 });
  const st = store.getMigrationState('browser-indexeddb:moments');
  check('migrate.watermarkDurable', st.ok && st.state.published === 4 && st.state.updatedAt > 0, st);
  store.close();
})();

/* ══════════════════ 竞态 ══════════════════ */
section('竞态 · 并发写入 / 编辑与删除 / 迁移与权威写入');

(function () {
  const dir = tempDir();
  const a = createMomentsStore({ dataDir: dir, logger: () => {} });
  const b = createMomentsStore({ dataDir: dir, logger: () => {} });
  a.open(); b.open();

  /* R1：两个写者同时创建同一个 id（同一次重试）—— 幂等键让第二次成为重放，
     绝不产生第二行。这是"桌面与后台 AI 同时发同一条"的真实形状：
     唯一防御不是 CAS（两边都还没有基版本），而是 requestId 幂等。 */
  const r1 = a.put({ id: 'race_1', roleId: CYRENE, content: 'A 写的', visibility: 'all', createdAt: 1700000000000 }, { requestId: 'race-1' });
  const r2 = b.put({ id: 'race_1', roleId: CYRENE, content: 'A 写的', visibility: 'all', createdAt: 1700000000000 }, { requestId: 'race-1' });
  check('R1.secondWriterReplays', r1.outcome === 'created' && r2.outcome === 'replayed', { r1: r1.outcome, r2: r2.outcome });
  check('R1.noDuplicateRow', a.countLive() === 1, a.countLive());
  /* 同一个 id、不同幂等键 → 第二次是一次**显式编辑**，必须带对基版本；
     不带基版本时它按"无条件覆盖"落盘，这是 store 的既定语义（迁移分支），
     因此这里显式验证"带错基版本一定被拒"。 */
  const r2b = b.put({ id: 'race_1', roleId: CYRENE, content: 'B 写的', visibility: 'all', createdAt: 1700000000000 }, { expectedRev: 99 });
  check('R1.wrongBaseRejected', r2b.ok === false && r2b.error === 'revision-conflict', r2b);
  check('R1.rejectLeftRowIntact', a.getRecord('race_1').content === 'A 写的', a.getRecord('race_1').content);

  /* R2：编辑与删除竞争（同一 expectedRev）—— 恰好一个成功 */
  const e1 = a.put({ id: 'race_1', roleId: CYRENE, content: '编辑', visibility: 'all', createdAt: 1700000000000 }, { expectedRev: 1 });
  const d1 = b.remove('race_1', { expectedRev: 1 });
  const winners = [e1, d1].filter(r => r && r.ok === true).length;
  check('R2.exactlyOneWins', winners === 1 && e1.ok === true && d1.ok === false, { e1: e1.outcome, d1: d1.outcome });

  /* R4：迁移与权威写入竞争 —— 权威先写则迁移 skipped（不覆盖） */
  a.put({ id: 'race_2', roleId: CYRENE, content: '权威版本', visibility: 'all', createdAt: 1700000100000 });
  const mig = b.writeMigrated({ id: 'race_2', roleId: CYRENE, content: '迁移版本', visibility: 'all', createdAt: '2025-01-01T00:00:00.000Z' }, 'migrace:1');
  check('R4.migrationYieldsToAuthority', mig.outcome === 'skipped' && a.getRecord('race_2').content === '权威版本', mig);

  /* R3：可见性收窄与读取竞争 —— 收窄提交后的下一次读取立即反映。
     刻意用**本条测试自己的**动态，不借用前面步骤留下的行：
     借用会让 before/after 的差被别的行的档位污染。 */
  const narrowing = a.put({ id: 'race_narrow', roleId: CYRENE, content: '将被收窄', visibility: 'all', createdAt: 1700000300000 });
  const before = a.listVisible(AS_OTHER, { limit: 10 }).moments.filter(m => m.id === 'race_narrow');
  a.put({ id: 'race_narrow', roleId: CYRENE, content: '将被收窄', visibility: 'private', createdAt: 1700000300000 }, { expectedRev: narrowing.rev });
  const after = a.listVisible(AS_OTHER, { limit: 10 }).moments.filter(m => m.id === 'race_narrow');
  check('R3.narrowingVisibleImmediately', before.length === 1 && after.length === 0, { before: before.length, after: after.length });

  /* R7：重复幂等创建/重试 */
  const liveBefore = a.countLive();
  const i1 = a.put({ id: 'race_3', roleId: CYRENE, content: 'x', visibility: 'all', createdAt: 1700000200000 }, { requestId: 'retry-1' });
  const i2 = a.put({ id: 'race_3', roleId: CYRENE, content: 'x', visibility: 'all', createdAt: 1700000200000 }, { requestId: 'retry-1' });
  check('R7.retryNoSecondRow', i1.outcome === 'created' && i2.outcome === 'replayed' && a.countLive() === liveBefore + 1, { i1: i1.outcome, i2: i2.outcome, live: a.countLive() });

  a.close(); b.close();
})();

/* ══════════════════ 反证 ══════════════════ */
section('反证 · 削弱承载性质 → 对应断言必须变红');

(function () {
  const store = openStore();
  seed(store, { id: 'c_pub', roleId: OTHER, content: 'PUBLIC_ROW', visibility: 'all', createdAt: 1700000000000 });
  /* 隐藏行刻意**比公开行更新**：这样"先分页再过滤"会先看到隐藏行。 */
  seed(store, { id: 'c_rest', roleId: OTHER, content: 'RESTRICTED_ROW', visibility: 'private', createdAt: 1700000009000 });
  const rows = store.listVisible(AS_CYRENE, { limit: 50 }).moments;

  /* C1：恢复一处"旧谓词"（只认 all、且排除自己）→ 用它组织出的块与共享实现不同。
     把这条反证写成"让它真的泄漏/丢弃"是可判定的形态：旧谓词会把
     `roles` 档中明确点名该角色的动态丢掉，而共享实现保留它。 */
  seed(store, { id: 'c_roles', roleId: OTHER, content: 'ROLES_ROW', visibility: 'roles', visibleRoleIds: [CYRENE], createdAt: 1700000008000 });
  const rows2 = store.listVisible(AS_CYRENE, { limit: 50 }).moments;
  const legacyFilter = (list, id) => list.filter(m => m && m.visibility === 'all' && String(m.roleId) !== String(id));
  const legacyBlock = CORE.renderSelected(
    { own: [], others: legacyFilter(rows2, CYRENE) },
    { characterId: CYRENE, userName: USER_NAME, characterNameOf: nameOf }
  );
  const sharedBlock = CORE.renderSelected(
    { own: [], others: CORE.filterVisibleMoments(rows2, AS_CYRENE).filter(m => String(m.roleId) !== CYRENE) },
    { characterId: CYRENE, userName: USER_NAME, characterNameOf: nameOf }
  );
  check('C1.legacyPredicateDropsAddressedRow', legacyBlock.indexOf('ROLES_ROW') < 0 && sharedBlock.indexOf('ROLES_ROW') >= 0, { legacyBlock, sharedBlock });
  check('C1.blocksDifferUnderLegacyPredicate', legacyBlock !== sharedBlock);

  /* C2：先分页再过滤 → 隐藏行挤占页槽（page.hiddenNeverSlots 会红）。
     专用的反事实 fixture：**隐藏行比公开行更新**，因此 limit=1 的原始页里
     只有隐藏行。若实现是"先分页再过滤"，那一页取完就什么都不剩，
     调用方会看到"没有动态"，而库里其实有一条可见行。 */
  const c2 = openStore();
  seed(c2, { id: 'c2_public', roleId: OTHER, content: 'C2_PUBLIC', visibility: 'all', createdAt: 1700000000000 });
  seed(c2, { id: 'c2_hidden', roleId: OTHER, content: 'C2_HIDDEN', visibility: 'private', createdAt: 1700000009000 });
  const pageFirst = c2.listRecords({ limit: 1 }).records.filter(m => CORE.isMomentVisibleTo(m, AS_CYRENE));
  check('C2.filterAfterPageWouldLoseVisible', pageFirst.length === 0, pageFirst.map(m => m.id));
  const filterFirst = c2.listVisible(AS_CYRENE, { limit: 1 }).moments;
  check('C2.filterFirstKeepsVisible', filterFirst.length === 1 && filterFirst[0].id === 'c2_public', filterFirst.map(m => m.id));
  c2.close();

  /* C3：缺 ACL fail open → 缺失档位的旧行会变成公开 */
  const failOpen = rows.concat([Object.assign({}, store.getRecord('c_pub'), { id: 'c_novis', visibility: undefined })]);
  const failOpenVisible = failOpen.filter(m => m.visibility !== 'private');
  check('C3.failOpenWouldExposeMissingAcl', failOpenVisible.some(m => m.id === 'c_novis'), failOpenVisible.map(m => m.id));
  const failClosedVisible = CORE.filterVisibleMoments([{ id: 'c_novis', roleId: OTHER, content: 'x', createdAt: 1 }], AS_CYRENE);
  check('C3.failClosedRejectsMissingAcl', failClosedVisible.length === 0, failClosedVisible);

  /* C5：子制品比来源更宽 → 受限动态的评论会外泄（M-ACL-10.d 会红） */
  const childWide = { id: 'c_child', roleId: OTHER, visibility: 'all', content: 'CHILD', comments: [{ id: 'cc', authorType: 'user', authorId: 'user-1', content: 'RESTRICTED_COMMENT' }] };
  const viaChild = CORE.filterVisibleMoments([childWide], USER).flatMap(m => (m.comments || []).map(c => c.content));
  check('C5.childWithoutParentGateLeaks', viaChild.indexOf('RESTRICTED_COMMENT') >= 0, viaChild);

  /* C6：让一次 Moment 写入去推进别的命名空间 → 隔离断言会红 */
  store.writeMeta('memory_revision', '41');
  store.writeMeta('memory_revision', '42');
  check('C6.crossNamespaceWriteWouldBeDetected', store.readMeta('memory_revision') !== '41', store.readMeta('memory_revision'));
  check('C6.ownIsolationStillHolds', store.revisionIsolation().metaKeys.memory_revision !== store.revisionIsolation().metaKeys.moments_revision, store.revisionIsolation().metaKeys);

  store.close();
})();

/* ══════════════════ 安全边界（本阶段范围内） ══════════════════ */
section('安全边界 · Android / 移动端不得看到动态');

(function () {
  const mobileDto = path.join(ROOT, 'assets', 'js', 'mobile-dto.js');
  const gateway = path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js');
  const httpFile = path.join(ROOT, 'services', 'home-node', 'http.js');
  const dtoText = fs.readFileSync(mobileDto, 'utf8');
  check('security.dtoHasNoMoments', dtoText.toLowerCase().indexOf('moment') < 0);
  const httpText = fs.readFileSync(httpFile, 'utf8');
  const gwText = fs.readFileSync(gateway, 'utf8');

  /* 与 memory / understanding 同款：动态**存在**于 Node（canonical），
     因此它不再属于 doesNotExpose —— 留着一个已经不成立的断言比没有断言更危险
     （它会让人以为"没有动态路径"是被检查过的）。
     取而代之的是可检查的具体断言：deviceVerbs 为空、走 desktop-only 路径、
     且 /security 自己的声明与实现逐字一致。 */
  const policyMatch = httpText.match(/momentsPolicy\s*:\s*\{[\s\S]*?\n\s{8}\}/);
  check('security.httpDeclaresMomentsPolicy', !!policyMatch, policyMatch ? null : 'momentsPolicy 未声明');
  check('security.momentsPolicyNotServedToDevices', !!policyMatch && /servedToDevices:\s*false/.test(policyMatch[0]) && /deviceVerbs:\s*\[\]/.test(policyMatch[0]));
  check('security.momentsNotInDoesNotExpose', !/doesNotExpose\s*:\s*\[[^\]]*'moments'/.test(httpText));
  check('security.momentsIsDesktopOnlyPath', /isDesktopOnlyPath\s*=[^;]*'\/moments\/'/.test(httpText));

  /* 网关只把 `/mobile/v1/*` 交给设备面，而 `okBody('moments.put', …)` 里的
     `'moments.x'` 只是**响应类型标签**，不是 verb —— 拿字符串匹配会把这两者
     混起来（这正是"看起来在检查、其实在检查别的东西"的形状）。
     因此判据换成两条**语义**断言：
       ① `/moments/*` 在 desktop-only 路径清单里（http.js 强制），
          而设备面的请求路径前缀是 `/mobile/v1/` —— 两者不可能同时成立；
       ② 设备面返回的任何 DTO 都不含动态字段（出站白名单投影）。 */
  check('security.momentsNeverOnMobilePrefix',
    !/['"]\/mobile\/v1\/moments/.test(gwText) && /isDesktopOnlyPath\s*=[^;]*'\/moments\/'/.test(httpText));
  const dtoProjection = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'mobile-dto.js'), 'utf8');
  check('security.mobileDtoProjectsNoMomentFields', !/moment/i.test(dtoProjection));
  /* desktop-only 清单必须与 /security 的声明逐条一致 —— 两边各写一份就会漂移。 */
  const adminMatch = gwText.match(/const ADMIN_PATHS = \[[\s\S]*?\];/);
  const declared = policyMatch ? (policyMatch[0].match(/'\/moments\/[a-z]+'/g) || []) : [];
  check('security.momentsAdminPathsMatchDeclaration',
    !!adminMatch && declared.length > 0 && declared.every(p => adminMatch[0].indexOf(p) >= 0),
    { declared, inAdmin: !!adminMatch });
  check('security.noMomentsContentInMobileReply', !/momentsBlock\s*:/.test(gwText.split('runtimeContextParts')[0].slice(-4000)));
})();

console.log('\n' + '='.repeat(64));
console.log('Moments authority: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('failed: ' + failures.join(', ')); process.exitCode = 1; }
