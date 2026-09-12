/* ====================================================================
   M1-C.2m P1/P2 · Canonical Understanding store 契约闭合
   --------------------------------------------------------------------
   这一条测的是**存储契约本身**（Node 直连，无浏览器、无 HTTP）：
     ① 单活不变量：per character active ∈ {0,1}，而且由**部分唯一索引**强制
        （不是约定）；旁路写法插第二行必须被数据库拒绝。
     ② 修订链：新文档 revision=1；重写 revision+1 且上一版 current 进 history；
        history cap 20；内容逐字相同 → skipped 且 **revision 不动**。
     ③ CAS：expectedRevision 不符 → conflict，且**零变更**（不是"尽力覆盖"）。
     ④ 并发：两个 store 实例（两个连接）同时从同一理由版本插入 → 恰好一个成功。
     ⑤ 更正契约：更正挂载在 (document, revision) 上、幂等、不删文档、不清历史，
        并且能被"仍生效"口径读出来（这是它约束未来派生的前提）。
     ⑥ 修正/迁移：migrate 分支不走 CAS，权威已有 active 时只 skipped，
        旧 history 原样搬过来且旧否决行**不**成为 current。
     ⑦ 删除默认被拒（理解不是随手可删的记录）。
   运行：node test_understanding_contract_closure.js
   ==================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const createStore = require(path.join(ROOT, 'services', 'home-node', 'understanding-store.js'));
const CORE = require(path.join(ROOT, 'assets', 'js', 'understanding-derivation-core.js'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});
function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-un-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}

const STAMP_PUBLIC = { visibility: 'public', visibleTo: [], excludeFrom: [] };
function candidate(content, extra) {
  return Object.assign({
    content: content,
    conviction: 70,
    dimension: 'context',
    basis: 'user_corroborated',
    evidenceIds: ['m1', 'm2'],
    stamp: STAMP_PUBLIC
  }, extra || {});
}

function main() {
  const dir = tempDir('store');
  const store = createStore({ dataDir: dir, logger: () => {} });
  const opened = store.open();
  check('store.open', opened.ok && opened.schemaVersion === 1, opened);

  /* ── ① 首版：revision=1，history 空 ─────────────────────────────────── */
  const first = store.rewrite('char-a', candidate('她更信任把话说明白，而不是被安慰。'), { expectedRevision: 0 });
  check('create.outcome', first.ok && first.outcome === 'created', first);
  check('create.revision1', first.docRevision === 1 && first.historyLength === 0, first);
  const active1 = store.getActive('char-a');
  check('create.activeReadback', !!active1 && active1.id === first.id && active1.revision === 1, active1 && active1.revision);
  check('create.stampStored', active1 && active1.visibility && active1.visibility.visibility === 'public', active1 && active1.visibility);
  check('create.evidenceStored', active1 && active1.current.evidenceIds.length === 2, active1 && active1.current.evidenceIds);

  /* 印章缺失 → private（fail closed：无法证明它不宽，就不声明它宽） */
  const noStamp = store.rewrite('char-stamp', { content: '缺印章的候选', conviction: 50, evidenceIds: ['m1'] }, { expectedRevision: 0 });
  const noStampDoc = store.getActive('char-stamp');
  check('stamp.missingFailsClosed', noStamp.ok && noStampDoc.visibility.visibility === 'private', noStampDoc && noStampDoc.visibility);

  /* ── ② 内容逐字相同 → skipped 且 revision 不动（R9）─────────────────── */
  const same = store.rewrite('char-a', candidate('她更信任把话说明白，而不是被安慰。'), { expectedRevision: 1 });
  check('identical.skipped', same.ok && same.outcome === 'skipped' && same.reason === 'identical', same);
  check('identical.revisionUntouched', store.getActive('char-a').revision === 1, store.getActive('char-a').revision);

  /* ── ③ CAS：错误的基版本 → conflict 且零变更 ───────────────────────── */
  /* 先真正推进一版（内容不同），再拿**旧的**基版本号去写 —— 这才是
     "两次派生从同一基版本出发"的真实形状（identical 不推进修订号，
     因此用 identical 之后的状态测 CAS 是测不出来的）。 */
  const advanced = store.rewrite('char-a', candidate('她更信任把话说明白，而且会直接说出来。'), { expectedRevision: 1 });
  check('cas.advanceToRevision2', advanced.ok && advanced.outcome === 'updated' && advanced.docRevision === 2, advanced);
  const stale = store.rewrite('char-a', candidate('一条基于过期基版本的错误理解'), { expectedRevision: 1 });
  check('cas.staleRejected', !stale.ok && stale.error === 'revision-conflict' && stale.outcome === 'conflict', stale);
  check('cas.noMutation', store.getActive('char-a').current.content.indexOf('过期基版本') < 0, store.getActive('char-a').current.content);
  check('cas.reportsBothRevisions', stale.expectedRevision === 1 && stale.actualRevision === 2, stale);
  check('cas.freshBaseAccepted', store.rewrite('char-a', candidate('基于最新基版本的候选'), { expectedRevision: 2 }).ok === true);

  const noDoc = store.rewrite('char-never', candidate('凭空出现的理解'), { expectedRevision: 3 });
  check('cas.expectedButNoDocument', !noDoc.ok && noDoc.error === 'revision-conflict' && noDoc.actualRevision === 0, noDoc);

  /* ── ④ 修订链 + history cap 20 ─────────────────────────────────────── */
  let rev = store.getActive('char-a').revision;   /* 此刻 = 3 */
  for (let i = 1; i <= 25; i++) {
    const res = store.rewrite('char-a', candidate('第 ' + i + ' 版理解'), { expectedRevision: rev });
    if (res.ok && res.outcome === 'updated') rev = res.docRevision;
  }
  const grown = store.getActive('char-a');
  check('history.capped20', grown.history.length === 20, grown.history.length);
  check('history.revisionAdvanced', grown.revision === 28, grown.revision);
  check('history.keepsPreviousContent', grown.history[grown.history.length - 1].content === '第 24 版理解', grown.history[grown.history.length - 1].content);
  check('history.entryCarriesRevision', grown.history[grown.history.length - 1].revision === 27, grown.history[grown.history.length - 1].revision);

  /* ── ⑤ 单活不变量：结构性强制 ─────────────────────────────────────── */
  const inv = store.invariantViolations();
  check('invariant.noViolations', inv.ok && inv.violations.length === 0, inv);
  check('invariant.oneActivePerCharacter', store.countActiveAll() === store.countRecords() - countInactive(store), { active: store.countActiveAll() });

  /* ── ⑥ 更正契约 ───────────────────────────────────────────────────── */
  const cur = store.getActive('char-a');
  const corr = store.addCorrection('char-a', { text: '我并不是更信任把话说明白，我只是不喜欢被敷衍', basis: 'user_stated' });
  check('correction.created', corr.ok && corr.outcome === 'created', corr);
  check('correction.targetsRevision', corr.correction && corr.correction.revision === cur.revision, corr.correction);
  check('correction.freezesRejectedContent', corr.correction && corr.correction.correctedContent === cur.current.content, corr.correction && corr.correction.correctedContent);
  const corrAgain = store.addCorrection('char-a', { text: '我并不是更信任把话说明白，我只是不喜欢被敷衍', basis: 'user_stated' });
  check('correction.idempotent', corrAgain.ok && corrAgain.outcome === 'existing' && corrAgain.correction.id === corr.correction.id, corrAgain.outcome);
  const activeCorr = store.activeCorrections('char-a');
  check('correction.readableAsActive', activeCorr.length === 1 && activeCorr[0].text.indexOf('不喜欢被敷衍') >= 0, activeCorr);
  check('correction.documentStillActive', !!store.getActive('char-a') && store.getActive('char-a').id === cur.id);
  check('correction.historyPreserved', store.getActive('char-a').history.length === 20);

  /* 重写之后：更正必须**仍然约束派生** —— 它针对的正是刚被替换掉的那一版，
     "之后每一版都不得重新提出"是它存在的意义。它绝不能因为被读过一次就消失。
     约束口径是 `constrainingCorrections()`（按版本关系算）；status 只是记账，
     因此这里断言的是"约束集里还在"，而不是某个 status 字面量。 */
  const afterCorr = store.rewrite('char-a', candidate('她需要的不是被安慰，而是被认真对待。'), { expectedRevision: cur.revision });
  check('correction.rewriteSucceeds', afterCorr.ok && afterCorr.outcome === 'updated', afterCorr);
  const corrApplied = store.listCorrections('char-a', {});
  check('correction.keptAfterRewrite', corrApplied.ok && corrApplied.corrections.length === 1, corrApplied.corrections);
  check('correction.stillConstrainsFuture',
    store.constrainingCorrections('char-a').some(c => c.text.indexOf('不喜欢被敷衍') >= 0),
    store.constrainingCorrections('char-a').map(c => ({ r: c.revision, st: c.status })));
  check('correction.oldRevisionInHistory', store.getActive('char-a').history.some(h => h.content === cur.current.content), store.getActive('char-a').history.length);
  /* 一条更正约束"它针对的那一版**及之后**"的每一次派生，直到被撤回/取代。 */
  const bump29 = store.rewrite('char-a', candidate('又往前走了一版'), { expectedRevision: store.getActive('char-a').revision });
  check('correction.rewriteAccepted', bump29.ok && bump29.outcome === 'updated', bump29);
  check('correction.constrainsNextRevision',
    store.constrainingCorrections('char-a').some(c => c.revision === cur.revision),
    store.constrainingCorrections('char-a').map(c => c.revision));
  const oldRevCorr = store.addCorrection('char-a', { text: '更早那一版也说错了', revision: 1, basis: 'user_stated' });
  check('correction.olderRevisionAccepted', oldRevCorr.ok && oldRevCorr.correction.revision === 1, oldRevCorr.correction);
  const bump30 = store.rewrite('char-a', candidate('再往前走一版'), { expectedRevision: store.getActive('char-a').revision });
  check('correction.olderRevisionApplied', bump30.ok && store.listCorrections('char-a', { status: 'applied' }).corrections.some(c => c.revision === 1), store.listCorrections('char-a', { status: 'applied' }).corrections.map(c => c.revision));
  const bump31 = store.rewrite('char-a', candidate('第三版之后'), { expectedRevision: store.getActive('char-a').revision });
  check('correction.bothApplied', bump31.ok && store.listCorrections('char-a', { status: 'applied' }).corrections.length === 2, store.listCorrections('char-a', { status: 'applied' }).corrections.map(c => c.revision));
  check('correction.neverDeleted', store.listCorrections('char-a', {}).corrections.length === 2);
  /* 记录状态与**约束口径**是两件事：两条更正 status 都是 applied，但**都仍然
     约束派生**（没有任何一版在它们之后把被否定的判断重新提出过）。 */
  check('correction.constraintIndependentOfStatus',
    store.constrainingCorrections('char-a').length === 2,
    store.constrainingCorrections('char-a').map(c => ({ r: c.revision, st: c.status })));
  /* 撤回之后才真的不再约束。 */
  const toRetract = store.constrainingCorrections('char-a')[0];
  const retracted = store.setCorrectionStatus(toRetract.id, 'retracted', {});
  check('correction.retractWorks', retracted.ok && retracted.correction.status === 'retracted', retracted);
  check('correction.retractedStopsConstraining', store.constrainingCorrections('char-a').length === 1, store.constrainingCorrections('char-a').map(c => c.id));

  /* 更正不允许在没有 active 文档时创建（悬空更正会约束一份它没见过的文档） */
  const orphan = store.addCorrection('char-never', { text: '无文档的更正' });
  check('correction.requiresDocument', !orphan.ok && orphan.error === 'no-active-document', orphan);

  /* ── ⑦ 删除默认被拒 ───────────────────────────────────────────────── */
  const refused = store.remove(store.getActive('char-a').id, {});
  check('delete.refusedByDefault', !refused.ok && refused.error === 'delete-refused', refused);
  check('delete.stillThere', !!store.getActive('char-a'));

  /* ── ⑧ 迁移分支 ───────────────────────────────────────────────────── */
  const migStore = createStore({ dataDir: dir, logger: () => {} });
  migStore.open();
  /* 同一个库文件、第二个连接：WAL 允许，但这里只读一次再看行为 */
  const migrated = migStore.rewrite('char-legacy', {
    id: 'un_legacy_1',
    content: '她对设备瓶颈敏感',
    conviction: 75,
    evidenceIds: ['g1'],
    basis: 'user_corroborated',
    dimension: 'context',
    stamp: STAMP_PUBLIC,
    unattested: false,
    legacyHistory: [
      { content: '旧版一', conviction: 40, evidenceIds: ['gone'], basis: 'ai_guess', updatedAt: 1, legacyStatus: 'contested' },
      { content: '旧版二', conviction: 60, evidenceIds: ['g1'], basis: 'ai_inference', updatedAt: 2, legacyStatus: 'stale' }
    ]
    /* 刻意**不传** expectedRevision：迁移路径没有 CAS 语义 */
  }, { migrate: true });
  check('migrate.created', migrated.ok && migrated.outcome === 'created' && migrated.migrated === true, migrated);
  const migDoc = migStore.getActive('char-legacy');
  check('migrate.idPreserved', migDoc && migDoc.id === 'un_legacy_1', migDoc && migDoc.id);
  check('migrate.historyCarried', migDoc && migDoc.history.length === 2 && migDoc.history[1].content === '旧版二', migDoc && migDoc.history.length);
  check('migrate.revisionFollowsHistory', migDoc && migDoc.revision === 3, migDoc && migDoc.revision);
  check('migrate.legacyStatusKept', migDoc && migDoc.history[0].legacyStatus === 'contested', migDoc && migDoc.history[0]);
  check('migrate.rejectedNotCurrent', migDoc && migDoc.current.content === '她对设备瓶颈敏感', migDoc && migDoc.current.content);
  const remigrate = migStore.rewrite('char-legacy', { id: 'un_legacy_1', content: '不同内容', evidenceIds: [], stamp: STAMP_PUBLIC }, { migrate: true });
  check('migrate.neverOverwritesCanonical', remigrate.ok && remigrate.outcome === 'skipped' && remigrate.reason === 'exists-on-node', remigrate);

  /* ── ⑨ 并发：两个 store 实例同时从同一理由版本插入 ─────────────────── */
  /* 用两个独立连接（两个 store 对象）模拟"两个进程/两次 tick"。
     node:sqlite 的 BEGIN IMMEDIATE 写锁把它们串行化：先到者提交，
     后到者看到的是提交后的世界 → CAS 判定生效 → 恰好一个成功。 */
  const storeA = createStore({ dataDir: dir, logger: () => {} });
  const storeB = createStore({ dataDir: dir, logger: () => {} });
  storeA.open(); storeB.open();
  const seed = storeA.rewrite('char-race', candidate('竞态之前的第一版'), { expectedRevision: 0 });
  check('race.seed', seed.ok && seed.docRevision === 1, seed);
  const resA = storeA.rewrite('char-race', candidate('竞态候选 A'), { expectedRevision: 1 });
  const resB = storeB.rewrite('char-race', candidate('竞态候选 B'), { expectedRevision: 1 });
  const winners = [resA, resB].filter(r => r && r.ok && (r.outcome === 'created' || r.outcome === 'updated')).length;
  const losers = [resA, resB].filter(r => r && !r.ok && r.error === 'revision-conflict').length;
  check('race.exactlyOneCommit', winners === 1, { winners: winners, a: resA.outcome, b: resB.outcome });
  check('race.loserGetsConflict', losers === 1, { a: resA.error, b: resB.error });
  const raceDoc = storeA.getActive('char-race');
  check('race.stillOneActive', raceDoc && raceDoc.revision === 2, raceDoc && raceDoc.revision);
  check('race.noViolations', storeA.invariantViolations().violations.length === 0);
  storeA.close(); storeB.close();

  /* ── ⑩ 两个 store 同时**首次**生成：靠唯一索引兜底（不是靠 CAS）─────
     两边 expectedRevision 都是 0，CAS 都通过；能挡住第二行的只有
     部分唯一索引 —— 这正是"约定"与"不变量"的区别。 */
  const storeC = createStore({ dataDir: dir, logger: () => {} });
  const storeD = createStore({ dataDir: dir, logger: () => {} });
  storeC.open(); storeD.open();
  const firstA = storeC.rewrite('char-first', candidate('首次生成 A'), { expectedRevision: 0 });
  const firstB = storeD.rewrite('char-first', candidate('首次生成 B'), { expectedRevision: 0 });
  const firstWins = [firstA, firstB].filter(r => r && r.ok).length;
  const firstLose = [firstA, firstB].filter(r => r && !r.ok && r.error === 'revision-conflict').length;
  check('firstGen.exactlyOne', firstWins === 1 && firstLose === 1, { a: firstA.outcome || firstA.error, b: firstB.outcome || firstB.error });
  check('firstGen.translatedToCasConflict', firstLose === 1, { a: firstA, b: firstB });
  check('firstGen.singleActiveRow', storeC.getActive('char-first').revision === 1 && storeC.invariantViolations().violations.length === 0);
  storeC.close(); storeD.close();

  /* ── ⑪ 旁路写：唯一索引必须挡住"绕过 store 的第二个 active 行" ─────── */
  const bypassStore = createStore({ dataDir: dir, logger: () => {} });
  bypassStore.open();
  let bypassBlocked = false;
  try {
    /* 直接构造一行 active（模拟"未来某个忘了检查的调用方"或另一个工具）。 */
    const row = bypassStore.getActive('char-a');
    check('bypass.precondition', !!row, row);
    const sqlite = require('node:sqlite');
    const raw = new sqlite.DatabaseSync(path.join(dir, 'home-node.db'));
    try {
      raw.prepare('INSERT INTO understanding_records (record_id, character_id, active, status, dimension, doc_revision, conviction, evidence_count, unattested, created_at, updated_at, revision, created_rev, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run('un_bypass', 'char-a', 1, 'active', 'context', 9, 50, 0, 0, Date.now(), Date.now(), 999999, 999999, '{}');
    } catch (error) {
      bypassBlocked = /UNIQUE|constraint/i.test(String((error && error.message) || error));
    }
    raw.close();
  } catch (error) {
    bypassBlocked = false;
  }
  check('invariant.blocksBypassInsert', bypassBlocked === true);
  check('invariant.stillClean', bypassStore.invariantViolations().violations.length === 0);
  bypassStore.close();

  /* ── ⑫ 水位（成本护栏的持久状态）───────────────────────────────────── */
  const wm0 = store.getWatermark('char-a');
  check('watermark.emptyShape', wm0.evidenceFingerprint === null && wm0.lastDerivedAt === 0 && wm0.skipReason === 'never-derived', wm0);
  store.setWatermark('char-a', { evidenceFingerprint: 'ef1:2:abc', lastDerivedAt: 12345, lastAttemptAt: 12345, lastOutcome: 'created', lastAccepted: true, skipReason: null, attempts: 0 });
  const wm1 = store.getWatermark('char-a');
  check('watermark.roundTrip', wm1.evidenceFingerprint === 'ef1:2:abc' && wm1.lastDerivedAt === 12345 && wm1.lastAccepted === true, wm1);
  /* 重开一个 store（模拟进程重启）：水位必须还在 —— 这是"C6 重置水位→红"的前提 */
  const reopened = createStore({ dataDir: dir, logger: () => {} });
  reopened.open();
  const wm2 = reopened.getWatermark('char-a');
  check('watermark.survivesRestart', wm2.evidenceFingerprint === 'ef1:2:abc' && wm2.lastDerivedAt === 12345, wm2);
  reopened.close();

  /* ── ⑬ 指纹：只见 id+内容，不见时间戳/顺序 ────────────────────────── */
  const base = [{ id: 'a', kind: 'episodic', visibility: 'public', title: 't', content: 'c' }];
  const reordered = [{ id: 'b', kind: 'episodic', visibility: 'public', title: 't2', content: 'c2' }, { id: 'a', kind: 'episodic', visibility: 'public', title: 't', content: 'c' }];
  const shuffled = [reordered[1], reordered[0]];
  check('fingerprint.orderInsensitive', CORE.evidenceFingerprint(reordered) === CORE.evidenceFingerprint(shuffled));
  check('fingerprint.contentSensitive', CORE.evidenceFingerprint(base) !== CORE.evidenceFingerprint([{ id: 'a', kind: 'episodic', visibility: 'public', title: 't', content: 'c2' }]));
  check('fingerprint.ignoresTelemetry', CORE.evidenceFingerprint([Object.assign({}, base[0], { activationCount: 99, lastActivated: 123 })]) === CORE.evidenceFingerprint(base));

  store.close();
  console.log('\nUnderstanding contract closure: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

/* 该角色有多少条**非 active** 的存活行（用于不变量断言：active = 总数 - 非 active） */
function countInactive(store) {
  const page = store.listRecords({});
  return (page.records || []).filter(r => r.active !== true).length;
}

main();
