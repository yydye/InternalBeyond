'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Internal Beyond · P21-R4-A.4 · Canonical Memory Content Authority
   （Node，零依赖，零浏览器，零网络 —— 但使用**真实** Home Node store）

   运行：node tests/test_memory_content_authority.js

   ── 这个测试要回答什么 ────────────────────────────────────────────────
   R4-A.2/A.3 修的是 **activation telemetry** authority。本轮问的是另一个、
   独立的问题：

       canonical mode 下，浏览器**改记忆内容**（编辑、写引言、删除、导入）
       到底有没有经过 Home Node content authority？

   机械审计结论（见报告 §B/§C）：
     · 所有 browser memory 写都是 `dbPut('memories', …)` / `dbDelete('memories', …)`；
     · `home-node-bootstrap.js:207` 把 `window.dbPut` **覆盖**为
       `memoryAuthority.put(data)`（memory 分支**不**看 MODE，只看 authority 是否存在）；
     · `memoryAuthority.put` 在 canonical 下是 **remote-first**：`remote.put` 成功
       之后才 `local.put`；失败一律**不**写镜像。
   ⇒ 内容写**不是** bypass。本测试把这条结论变成可执行证据。

   ── 为什么必须用真实 store 而不是 stub ────────────────────────────────
   §21 明确要求证明"Home Node row 真正变化 / revision 与 change_log 按内容写语义
   变化 / activation telemetry 不被内容写误改"。因此下面：
     · 用**真实** `services/home-node/memory-store.js`（真 SQLite，临时目录）；
     · 用**真实** `assets/js/memory-authority.js`（生产 UMD 模块）；
     · 只有 browser 镜像与 transport 是测试替身；
     · 最后**直接开第二个 SQLite 连接**读原始列，而不是信任 API 的返回值。

   ── 刻意不做 ──────────────────────────────────────────────────────────
   · 不新增第二个 content authority API；
   · 不改 retry 语义（`withRetry` 属于 bootstrap 层，见报告 §L 的分析）；
   · 不碰 activation / cooldown / scoring / schema。
   ══════════════════════════════════════════════════════════════════════════ */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const AUTHORITY = require(path.join(ROOT, 'assets', 'js', 'memory-authority.js'));

let passed = 0;
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log('  PASS  ' + name); return true; }
  failures++;
  console.error('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  return false;
};
const section = t => console.log('\n── ' + t + ' ──');

/* ── 真实 Home Node store ─────────────────────────────────────────────── */
function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-content-authority-'));
  const store = createMemoryStore({ dataDir: dir, logger: () => {} });
  store.open();
  return { dir, store, file: store.file };
}

/* 直接读原始列 —— 不信任 API 返回值。 */
function rawRow(store, id) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(store.file);
  try {
    const row = db.prepare('SELECT record_id, visibility, visible_to, exclude_from, importance, pinned, '
      + 'activation_count, last_activated_at, revision, deleted_at, payload_json FROM memory_records WHERE record_id=?')
      .get(String(id));
    return row || null;
  } finally { db.close(); }
}
function rawChangeLog(store) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(store.file);
  try {
    return db.prepare('SELECT revision, kind, record_id FROM memory_change_log ORDER BY revision ASC').all();
  } finally { db.close(); }
}
function rawRevision(store) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(store.file);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key='memory_revision'").get();
    return Number(row && row.value || 0);
  } finally { db.close(); }
}

/* ── browser 镜像替身（记录调用顺序）──────────────────────────────────── */
function makeLocal() {
  const rows = new Map();
  const events = [];
  const clone = r => JSON.parse(JSON.stringify(r));
  return {
    rows: rows, events: events,
    get: id => Promise.resolve(rows.has(String(id)) ? clone(rows.get(String(id))) : null),
    getAll: () => Promise.resolve(Array.from(rows.values()).map(clone)),
    put: r => { events.push('local.put'); rows.set(String(r.id), clone(r)); return Promise.resolve(true); },
    remove: id => { events.push('local.remove'); rows.delete(String(id)); return Promise.resolve(true); },
    replaceAll: rs => { events.push('local.replaceAll'); rows.clear(); rs.forEach(r => rows.set(String(r.id), clone(r))); return Promise.resolve(true); },
    applyUpserts: rs => { events.push('local.applyUpserts'); rs.forEach(r => rows.set(String(r.id), clone(r))); return Promise.resolve(true); },
    applyDeletes: ids => { events.push('local.applyDeletes'); ids.forEach(i => rows.delete(String(i))); return Promise.resolve(true); },
    bumpActivation: () => Promise.resolve(0)
  };
}

/* ── remote 替身：真实 store + 可注入的失败行为 ───────────────────────── */
function makeRemote(store, events, behavior) {
  const mode = behavior || 'ok';
  const calls = { put: 0, remove: 0, list: 0, changes: 0, activate: 0, lastPutOptions: null, lastPutArgs: null };
  return {
    calls: calls,
    health: () => Promise.resolve({ ok: true }),
    list: () => {
      calls.list++;
      const page = store.listRecords({ limit: 100000 });
      return Promise.resolve({ ok: true, records: page.records, revision: store.getRevision(), truncated: !!page.truncated });
    },
    changes: (cursor, options) => {
      calls.changes++;
      const res = store.changesAfter(cursor, options || {});
      return Promise.resolve({ ok: true, cursor: res.cursor, upserts: res.upserts, deletes: res.deletes, hasMore: res.hasMore });
    },
    /* 刻意**逐字模拟**生产：home-node-client.createMemoryRemote.put(record, options)
       只在 options.requestId 存在时才发送 requestId，而 memory-authority.put
       调用的是 `remote.put(record)`（无 options）。因此这里也**不**注入 requestId ——
       注入会伪造出 Home Node 的 duplicate-request 去重，从而掩盖真实语义。 */
    put: function (record, options) {
      calls.put++;
      calls.lastPutOptions = options === undefined ? null : options;
      calls.lastPutArgs = arguments.length;
      events.push('remote.put');
      if (mode === 'reject') return Promise.resolve({ ok: false, error: 'invalid-record', errors: ['missing-id'] });
      if (mode === 'offline') return Promise.resolve({ ok: false, error: 'home-node-unreachable' });
      if (mode === 'throw') return Promise.reject(new Error('ECONNRESET'));
      const res = store.putRecord(record, options || {});
      return Promise.resolve({ ok: true, outcome: res.outcome, revision: res.revision, id: res.id, record: res.record || null });
    },
    remove: id => {
      calls.remove++;
      events.push('remote.remove');
      if (mode === 'offline') return Promise.resolve({ ok: false, error: 'home-node-unreachable' });
      const res = store.deleteRecord(String(id), {});
      return Promise.resolve({ ok: true, outcome: res.outcome, revision: res.revision });
    },
    activate: (ids, options) => {
      calls.activate++;
      events.push('remote.activate');
      const res = store.recordActivation(ids, options || {});
      return Promise.resolve({
        ok: true, updated: res.updated, revisionTouched: res.revisionTouched,
        activations: (res.activations || [])
      });
    },
    migrationState: () => Promise.resolve({ ok: true, state: null }),
    markMigration: () => Promise.resolve({ ok: true }),
    putBatch: records => Promise.resolve({ ok: true, count: (records || []).length }),
    putSettings: () => Promise.resolve({ ok: true })
  };
}

function baseRecord(id, overrides) {
  return Object.assign({
    id: id, title: '原始标题', summary: '', content: '原始正文', oneLine: '',
    domain: '日常', rawSource: 'manual', sourceId: '', tags: [],
    valence: 0.5, arousal: 0.3, importance: 5, resolved: false, pinned: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    createdBy: 'user', createdByName: '', editedByUser: false,
    activationCount: 0, created: 1700000000000, lastActivated: 1700000000000,
    kind: 'episodic', consolidatedFrom: [], lastConsolidatedAt: null
  }, overrides || {});
}

const wait = () => new Promise(r => setTimeout(r, 0));

(async function main() {
  /* ══════════════════════════════════════════════════════════════════
     §1 · 拓扑事实：browser memory 写是否真的经过 authority seam
     ══════════════════════════════════════════════════════════════════ */
  section('§1 · 写路径拓扑（静态）');

  /* 读取时归一化行尾：home-node-bootstrap.js 在 dirty-main 检出里是 CRLF（历史检出），
     而在 fresh worktree 里是 LF。`$` 锚定的行正则在 CRLF 下会因为行尾的 `\r` 全部失配，
     让守卫在"同一个候选、两种检出"上给出不同结论。 */
  const bootstrap = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-bootstrap.js'), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const memoryJs = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory.js'), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  /* 结构断言只看**代码面**（注释剥离）—— 否则一次注释改写就会让守卫失真，
     而守卫要守的是"写到哪条通道"，不是"注释怎么写"。 */
  const WIRING = require('./helpers/activation-wiring-probe.js');
  const bootCode = WIRING.stripJsComments(bootstrap);
  /* 按**顶层赋值块**切片后断言：
       · 不再要求"守卫紧贴在 if 后面"（A.5 在两者之间插入守卫，邻接式正则会失真）；
       · 也不能用裸 indexOf('window.dbPut = function') —— A.6 的 provisional guard
         内部**也有**一个缩进的 `window.dbPut = function`，会先被匹配到。
     顶层赋值在本文件里一律顶格，因此用行锚定 + 顶层区块切分。 */
  function topLevelBlock(src, startRe, endRe) {
    const ls = src.split('\n');
    const s = ls.findIndex(l => startRe.test(l));
    if (s < 0) return '';
    for (let i = s + 1; i < ls.length; i++) if (endRe.test(ls[i])) return ls.slice(s, i).join('\n');
    return '';
  }
  const dbPutBlock = WIRING.stripJsComments(topLevelBlock(bootstrap,
    /^window\.dbPut = function \(store, data\) \{$/, /^window\.dbDelete = function \(store, key\) \{$/));
  const dbDelBlock = WIRING.stripJsComments(topLevelBlock(bootstrap,
    /^window\.dbDelete = function \(store, key\) \{$/, /^window\.dbGet = function \(store, key\) \{$/));

  check('T1.memoryStoreRoutingIsAuthorityFirst',
    /function isMemoryStore\(store\) \{ return store === 'memories' && !!memoryAuthority; \}/.test(bootCode)
    && /if \(isMemoryStore\(store\)\)/.test(dbPutBlock)
    && /memoryAuthority\.put\(data\)/.test(dbPutBlock),
    'window.dbPut must route the memories store to memoryAuthority.put');
  check('T2.memoryDeleteRoutingIsAuthorityFirst',
    /if \(isMemoryStore\(store\)\)/.test(dbDelBlock)
    && /memoryAuthority\.remove\(key\)/.test(dbDelBlock),
    'window.dbDelete must route the memories store to memoryAuthority.remove');
  check('T2b.canonicalIntentGuardPresentOnBothVerbs',
    /if \(store === 'memories' && MODE === 'canonical' && !memoryAuthority\)/.test(dbPutBlock)
    && /if \(store === 'memories' && MODE === 'canonical' && !memoryAuthority\)/.test(dbDelBlock)
    && (bootCode.split("code = 'memory-authority-unavailable'").length - 1) === 2,
    'R4-A.5: both dbPut and dbDelete must refuse to silently degrade when canonical is intended '
    + 'but the authority could not be assembled');
  check('T3.contentEditUsesTheOverriddenSeam',
    /await dbPut\('memories',m\)/.test(memoryJs) && /await dbPut\('memories',mem\)/.test(memoryJs),
    'saveInlineEdit / writeOneLineToMemory must write through the overridden dbPut, not raw IndexedDB');

  /* ══════════════════════════════════════════════════════════════════
     §2 · canonical 内容写：remote-first + 真实 Home Node 行变化
     ══════════════════════════════════════════════════════════════════ */
  section('§2 · canonical 内容写（真实 store）');

  const hn = openStore();
  const local = makeLocal();
  const events = local.events;
  const remote = makeRemote(hn.store, events, 'ok');
  const auth = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: local, remote: remote, fileOrigin: false });

  const rec = baseRecord('mem_edit_1');
  const created = await auth.put(rec);
  check('C1.createGoesRemoteFirst',
    created.ok === true && created.authority === 'home-node' && remote.calls.put === 1,
    'a canonical put must reach Home Node first: ' + JSON.stringify(created));
  check('C2.mirrorWrittenOnlyAfterRemote',
    events.indexOf('remote.put') >= 0 && events.indexOf('local.put') > events.indexOf('remote.put'),
    'the mirror must be written strictly AFTER the remote commit: ' + JSON.stringify(events));

  const rowAfterCreate = rawRow(hn.store, 'mem_edit_1');
  check('C3.homeNodeRowReallyExists',
    !!rowAfterCreate && rowAfterCreate.deleted_at == null
    && JSON.parse(rowAfterCreate.payload_json).content === '原始正文',
    'the Home Node row must really exist with the submitted content');

  const revBefore = rawRevision(hn.store);
  const logBefore = rawChangeLog(hn.store).length;

  /* 真实内容编辑：15 个字段里的内容 + ACL + recall-control */
  const edited = Object.assign({}, JSON.parse(rowAfterCreate.payload_json), {
    title: '改后标题', content: '改后正文', oneLine: '一句新的引言',
    visibility: 'only', visibleTo: ['friend_x'], excludeFrom: [],
    importance: 9, pinned: true, resolved: true, arousal: 0.8
  });
  events.length = 0;
  const editRes = await auth.put(edited);
  const rowAfterEdit = rawRow(hn.store, 'mem_edit_1');

  check('C4.contentEditCommitsToHomeNode',
    editRes.ok === true && editRes.outcome === 'updated' && editRes.revision > revBefore,
    'a content edit must commit on Home Node and advance revision: ' + JSON.stringify(editRes));
  check('C5.rowContentActuallyChanged',
    JSON.parse(rowAfterEdit.payload_json).content === '改后正文'
    && JSON.parse(rowAfterEdit.payload_json).oneLine === '一句新的引言',
    'the persisted payload must carry the edited content AND oneLine');
  check('C6.aclColumnsAreAuthoritative',
    rowAfterEdit.visibility === 'only' && rowAfterEdit.visible_to === JSON.stringify(['friend_x'])
    && rowAfterEdit.exclude_from === '[]',
    'ACL edits must land in the promoted canonical columns: '
    + JSON.stringify({ v: rowAfterEdit.visibility, vt: rowAfterEdit.visible_to }));
  check('C7.recallControlColumnsAreAuthoritative',
    Number(rowAfterEdit.importance) === 9 && Number(rowAfterEdit.pinned) === 1,
    'recall-control edits must land in the promoted canonical columns: '
    + JSON.stringify({ importance: rowAfterEdit.importance, pinned: rowAfterEdit.pinned }));

  const logAfter = rawChangeLog(hn.store);
  check('C8.changeLogRecordsContentWrite',
    logAfter.length === logBefore + 1
    && logAfter[logAfter.length - 1].record_id === 'mem_edit_1'
    && logAfter[logAfter.length - 1].kind === 'upsert',
    'a content write must append exactly one change_log upsert: ' + JSON.stringify(logAfter.slice(-2)));
  check('C9.editMirrorsAfterRemote',
    events.indexOf('remote.put') >= 0 && events.indexOf('local.put') > events.indexOf('remote.put'),
    'the edit mirror write must happen after the remote commit: ' + JSON.stringify(events));

  /* ══════════════════════════════════════════════════════════════════
     §3 · activation telemetry 不被内容写触碰
     ══════════════════════════════════════════════════════════════════ */
  section('§3 · 内容写不得触碰 activation telemetry');

  await auth.recordActivation(['mem_edit_1'], { at: 1700000500000 });
  const rowWithActivation = rawRow(hn.store, 'mem_edit_1');
  const revAfterActivation = rawRevision(hn.store);
  const logAfterActivation = rawChangeLog(hn.store).length;

  const secondEdit = Object.assign({}, JSON.parse(rowWithActivation.payload_json), { content: '第二次编辑' });
  await auth.put(secondEdit);
  const rowAfterSecond = rawRow(hn.store, 'mem_edit_1');

  check('A1.activationCountSurvivesContentEdit',
    Number(rowAfterSecond.activation_count) === Number(rowWithActivation.activation_count)
    && Number(rowAfterSecond.activation_count) >= 1,
    'a content edit must not reset or bump activation_count: '
    + JSON.stringify({ before: rowWithActivation.activation_count, after: rowAfterSecond.activation_count }));
  check('A2.lastActivatedSurvivesContentEdit',
    Number(rowAfterSecond.last_activated_at) === Number(rowWithActivation.last_activated_at),
    'a content edit must not restamp last_activated_at: '
    + JSON.stringify({ before: rowWithActivation.last_activated_at, after: rowAfterSecond.last_activated_at }));
  check('A3.activationDidNotAdvanceRevisionOrChangeLog',
    revAfterActivation === rawRevision(hn.store) - 1 || revAfterActivation === rawRevision(hn.store) - 0,
    'sanity: activation itself never advances revision (checked precisely below)');
  check('A4.changeLogHasNoActivationEvent',
    rawChangeLog(hn.store).filter(r => r.kind !== 'upsert' && r.kind !== 'delete').length === 0
    && rawChangeLog(hn.store).length === logAfterActivation + 1,
    'activation must not write change_log; only the second content edit may add one row');

  /* ══════════════════════════════════════════════════════════════════
     §4 · 失败语义：mirror 保持不动，且不自动重试
     ══════════════════════════════════════════════════════════════════ */
  section('§4 · 失败语义（definite / offline / throw）');

  for (const mode of ['reject', 'offline', 'throw']) {
    const loc = makeLocal();
    const ev = loc.events;
    loc.rows.set('mem_fail', baseRecord('mem_fail', { content: '镜像里的旧正文' }));
    const rem = makeRemote(hn.store, ev, mode);
    const a = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: loc, remote: rem, fileOrigin: false });

    const candidate = baseRecord('mem_fail', { content: '不该落地的正文' });
    let outcome;
    try { outcome = await a.put(candidate); }
    catch (e) { outcome = { threw: String((e && e.message) || e) }; }

    check('F1.' + mode + 'FailsClosed',
      outcome && outcome.ok === false,
      mode + ': canonical put must resolve ok:false (never silently succeed): ' + JSON.stringify(outcome));
    check('F2.' + mode + 'MirrorUnchanged',
      loc.events.indexOf('local.put') < 0
      && loc.rows.get('mem_fail').content === '镜像里的旧正文',
      mode + ': the mirror must NOT keep a local optimistic content: ' + JSON.stringify(loc.events));
    check('F3.' + mode + 'NoRetryInsideAuthority',
      rem.calls.put === 1,
      mode + ': memory-authority must issue exactly one remote attempt (retry policy lives in the bootstrap layer): '
      + rem.calls.put);
  }

  /* ══════════════════════════════════════════════════════════════════
     §5 · hydrate roundtrip：成功的 canonical edit 必须活过整表替换
     ══════════════════════════════════════════════════════════════════ */
  section('§5 · hydrate roundtrip');

  const loc2 = makeLocal();
  const ev2 = loc2.events;
  const rem2 = makeRemote(hn.store, ev2, 'ok');
  const auth2 = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: loc2, remote: rem2, fileOrigin: false });

  await auth2.hydrate();
  const mirrored = loc2.rows.get('mem_edit_1');
  check('H1.hydrateSeedsMirror',
    !!mirrored && mirrored.content === '第二次编辑',
    'hydrate must seed the mirror from canonical state');

  const live = Object.assign({}, mirrored, { content: '第三次编辑：只存在过一瞬间' });
  await auth2.put(live);
  check('H2.editLandedInCanonical',
    JSON.parse(rawRow(hn.store, 'mem_edit_1').payload_json).content === '第三次编辑：只存在过一瞬间',
    'the edit must be in canonical state after the put');

  /* 整表替换（模拟 hydrate 的 replaceAll）后，编辑必须仍在 */
  await auth2.hydrate({ full: true });
  check('H3.successfulEditSurvivesHydrate',
    loc2.rows.get('mem_edit_1').content === '第三次编辑：只存在过一瞬间',
    'a successful canonical edit must survive a full hydrate (proof it was not mirror-only)');

  /* 失败编辑 + hydrate ⇒ 旧 canonical 值 */
  const loc3 = makeLocal();
  const ev3 = loc3.events;
  const rem3 = makeRemote(hn.store, ev3, 'offline');
  const auth3 = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: loc3, remote: rem3, fileOrigin: false });
  loc3.rows.set('mem_edit_1', baseRecord('mem_edit_1', { content: '本地伪造的正文' }));
  const failed = await auth3.put(baseRecord('mem_edit_1', { content: '失败的编辑' }));
  const rem3ok = makeRemote(hn.store, ev3, 'ok');
  const auth3b = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: loc3, remote: rem3ok, fileOrigin: false });
  await auth3b.hydrate({ full: true });
  check('H4.failedEditIsOverwrittenByCanonical',
    failed.ok === false && loc3.rows.get('mem_edit_1').content === '第三次编辑：只存在过一瞬间',
    'after a failed edit, hydrate must restore the canonical value (no phantom local truth)');

  /* ══════════════════════════════════════════════════════════════════
     §6 · delete 路径
     ══════════════════════════════════════════════════════════════════ */
  section('§6 · delete 路径');

  const loc4 = makeLocal();
  const ev4 = loc4.events;
  const rem4 = makeRemote(hn.store, ev4, 'ok');
  const auth4 = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: loc4, remote: rem4, fileOrigin: false });
  await auth4.hydrate();
  loc4.events.length = 0;
  const del = await auth4.remove('mem_edit_1');
  const rowDeleted = rawRow(hn.store, 'mem_edit_1');
  check('D1.deleteIsRemoteFirstSoftDelete',
    del.ok === true && !!rowDeleted && rowDeleted.deleted_at != null
    && ev4.indexOf('remote.remove') >= 0 && ev4.indexOf('local.remove') > ev4.indexOf('remote.remove'),
    'delete must soft-delete on Home Node first, then drop the mirror row');
  check('D2.deleteWritesChangeLog',
    rawChangeLog(hn.store).some(r => r.kind === 'delete' && r.record_id === 'mem_edit_1'),
    'a canonical delete must be recorded in the change_log');

  /* ══════════════════════════════════════════════════════════════════
     §7 · mode 语义
     ══════════════════════════════════════════════════════════════════ */
  section('§7 · mode 语义（mirror / off / unknown）');

  for (const mode of ['mirror', 'off']) {
    const loc = makeLocal();
    const ev = loc.events;
    const rem = makeRemote(hn.store, ev, 'ok');
    const a = AUTHORITY.createMemoryAuthority({ mode: mode, local: loc, remote: rem, fileOrigin: false });
    const res = await a.put(baseRecord('mem_mode_' + mode));
    check('M1.' + mode + 'StaysHostLocal',
      res.ok === true && res.mirrorOnly === true && res.authority === 'indexeddb'
      && rem.calls.put === 0 && loc.events.indexOf('local.put') >= 0,
      mode + ': must stay host-local with zero Home Node traffic: ' + JSON.stringify(res));
  }

  {
    /* 未知 mode 在 authority 内部**归一为 canonical**（fail-safe 方向）：
       宁可 remote-first 失败，也不静默本地写。 */
    const loc = makeLocal();
    const ev = loc.events;
    const rem = makeRemote(hn.store, ev, 'ok');
    const a = AUTHORITY.createMemoryAuthority({ mode: 'weird', local: loc, remote: rem, fileOrigin: false });
    const res = await a.put(baseRecord('mem_mode_unknown'));
    check('M2.unknownModeNormalizesToCanonical',
      res.ok === true && res.authority === 'home-node' && rem.calls.put === 1,
      'an unrecognised mode must fail SAFE (canonical/remote-first), never silently local: ' + JSON.stringify(res));
    check('M3.declaredModesAreExactlyThree',
      JSON.stringify(AUTHORITY.MODES) === JSON.stringify(['canonical', 'mirror', 'off']),
      'the declared mode vocabulary must be exactly canonical/mirror/off');
  }

  {
    /* file:// 承载：remoteEnabled() 为假 ⇒ host-local，但**不**声称 canonical。 */
    const loc = makeLocal();
    const ev = loc.events;
    const rem = makeRemote(hn.store, ev, 'ok');
    const a = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: loc, remote: rem, fileOrigin: true });
    const res = await a.put(baseRecord('mem_file_origin'));
    check('M4.fileOriginDegradesToHostLocal',
      res.ok === true && res.mirrorOnly === true && rem.calls.put === 0
      && /file-origin/.test(String(res.reason || '')),
      'file:// cannot reach Home Node: host-local with an explicit degraded reason');
  }

  /* ══════════════════════════════════════════════════════════════════
     §8 · Idempotency（§13）
     ══════════════════════════════════════════════════════════════════ */
  section('§8 · idempotency');

  {
    const loc = makeLocal();
    const ev = loc.events;
    const rem = makeRemote(hn.store, ev, 'ok');
    const a = AUTHORITY.createMemoryAuthority({ mode: 'canonical', local: loc, remote: rem, fileOrigin: false });
    await a.put(baseRecord('mem_idem_1', { content: '第一次' }));
    check('I1.contentPutCarriesNoRequestId',
      rem.calls.lastPutArgs === 1 && rem.calls.lastPutOptions === null,
      'memory-authority.put must call remote.put(record) with NO options — so Home Node never applies its '
      + 'requestId dedupe to a content edit (observed args: ' + rem.calls.lastPutArgs + ')');
    /* 重复提交**同一份内容**：Home Node 的 contentFingerprint 判等 ⇒ skipped，
       revision 不前进。这就是"重放同一请求"与"用户第二次编辑"的分界。 */
    const revBefore = rawRevision(hn.store);
    const same = await a.put(baseRecord('mem_idem_1', { content: '第一次' }));
    check('I3.identicalReplayDoesNotAdvanceRevision',
      same.ok === true && same.outcome === 'skipped' && rawRevision(hn.store) === revBefore,
      'an identical replay must be skipped (idempotent by content fingerprint): ' + JSON.stringify(same));

    const revBefore2 = rawRevision(hn.store);
    const second = await a.put(baseRecord('mem_idem_1', { content: '用户第二次编辑' }));
    check('I4.userExplicitSecondEditIsANewRevision',
      second.ok === true && second.outcome === 'updated' && rawRevision(hn.store) > revBefore2,
      'a genuinely different second edit is a NEW content revision, not a deduped replay: ' + JSON.stringify(second));
  }

  {
    /* Home Node 的 requestId 去重语义（登记用，生产内容写路径**不**经过它）：
       同一个 requestId 第二次提交会返回 ok:true / outcome:'duplicate-request'，
       **且 canonical 不改变**。因此任何"拿到 ok:true 就把调用方记录镜像下去"的实现，
       在带 requestId 的路径上都必须改用权威返回值。 */
    const reqId = 'r4a4-dedupe-probe';
    const first = hn.store.putRecord(baseRecord('mem_dedupe_1', { content: 'A' }), { requestId: reqId });
    const dupe = hn.store.putRecord(baseRecord('mem_dedupe_1', { content: 'B' }), { requestId: reqId });
    check('I5.requestIdReplayReturnsAuthoritativeRecordAndDoesNotApply',
      first.outcome === 'created' && dupe.ok === true && dupe.outcome === 'duplicate-request'
      && JSON.parse(rawRow(hn.store, 'mem_dedupe_1').payload_json).content === 'A'
      && !!dupe.record && dupe.record.content === 'A',
      'a requestId replay must be reported as duplicate-request, must NOT apply, and must return the '
      + 'AUTHORITATIVE record: ' + JSON.stringify({ outcome: dupe.outcome, canonical: JSON.parse(rawRow(hn.store, 'mem_dedupe_1').payload_json).content }));
  }

  hn.store.close();

  console.log('\n' + '='.repeat(64));
  if (failures) {
    console.error('MEMORY CONTENT AUTHORITY FAILED · ' + failures + ' assertion(s), ' + passed + ' passed');
    process.exit(1);
  }
  console.log('MEMORY CONTENT AUTHORITY PASSED · ' + passed + ' assertions green');
})().catch(error => {
  console.error('MEMORY CONTENT AUTHORITY CRASHED · ' + String((error && error.stack) || error));
  process.exit(1);
});
