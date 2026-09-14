'use strict';
/* Internal Beyond · P11-2G · Mobile / Home Node **记忆读取边界**（memory 组）
   运行：node tests/test_mobile_memory_read_boundary.js

   ── 本文件要钉住的东西（为什么必须存在）──────────────────────────────
   P11-2F 收尾时发现的事实：`/memory/list` 与 `/memory/changes` 按 ownerId 返回
   **原始** memory records，不做 visibility / visibleTo 判定。这条边界此前没有任何
   可执行的判据 —— 它只存在于注释与"反正设备面拿不到"的隐含假设里。

   本文件把这条边界变成**可断言**的三件事：
     1) 唯一 canonical 读谓词 canReadMemory：public / private / only / except /
        缺失 visibility / 畸形 / 未知 / 缺主体 —— 每一档都有确定结论，全部 fail closed；
     2) 服务端**序列化之前**过滤：未授权记录不进入响应（不是置空、不是打标记、
        不是交给客户端过滤），且分页顺序是"可读视图 → 分页 → 序列化"；
     3) 撤销语义：曾经可读、之后被收窄的记录必须产生一条 delete 让客户端删掉
        本地镜像 —— "以后不再发送"会让旧正文永久留在本地。

   ── 刻意不做 ──────────────────────────────────────────────────────────
   · 不改 canReadMemory 依赖的既有可见性语义（private 仍是"任何主体都不可注入"）；
   · 不引入第二套 ACL 规则（全部委托 assets/js/memory-visibility-core.js）；
   · 不碰 /mobile/v1（Android 没有 memory verb 这条边界由
     test_mobile_memory_continuity.js 原样守着，本文件只做回归断言）。 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
const createMemoryStore = require(path.join(ROOT, 'services', 'home-node', 'memory-store.js'));
const VIS = require(path.join(ROOT, 'assets', 'js', 'memory-visibility-core.js'));
const MEMORY_CONTRACT = require(path.join(ROOT, 'assets', 'js', 'memory-contract.js'));

const NOW = 1789000000000;
const ALICE = 'friend_alice';
const BOB = 'friend_bob';
/* P11-3X-A：设备面那一段需要**已配置的桌面 token**（P11-3A 的凭据铸造闸门）。
   它只作用于为该段单独构建的实例，不影响上面所有"未配置 token"的断言。 */
const DESKTOP_TOKEN = 'p11-2g-desktop-token';
const DEVICE = 'device-abcdef';

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n\u2500\u2500 ' + title + ' \u2500\u2500'); }

/* 一条契约合法的 canonical 记忆（字段与 memory-contract.validateRecord +
   test_mobile_memory_continuity.js 的种子同形）。 */
function mem(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: 'T-' + id, summary: '', content: 'BODY-' + id,
    domain: '\u65e5\u5e38', tags: [], valence: 0.5, arousal: 0.3, importance: 5, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: NOW, lastActivated: NOW,
    createdBy: 'user', createdByName: '', editedByUser: false,
    consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}

function tempDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p11-2g-' + tag + '-')); }

function request(port, method, urlPath, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const data = options.body == null ? null : JSON.stringify(options.body);
    const headers = Object.assign({}, options.headers || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: method, timeout: 15000, headers: headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/* ── 固定种子：一条记录一种可见性档位 ──────────────────────────────────
   刻意让"被拒绝"的档位在数量上**远多于**可读档位，这样"隐藏行是否占用页槽 /
   是否影响 hasMore"才能在 pagination 小节里被真正检验。 */
function seedStore(dir) {
  const store = createMemoryStore({ dataDir: dir, logger: () => {} });
  store.open();
  /* 可读（ALICE）：public + only[ALICE] */
  store.putRecord(mem('mem_pub_a', { createdBy: ALICE }));
  store.putRecord(mem('mem_only_alice', { createdBy: ALICE, visibility: 'only', visibleTo: [ALICE] }));
  /* 被拒绝：private / only[BOB] / except[ALICE] / 缺失 / 未知 / 畸形 */
  store.putRecord(mem('mem_priv_a', { createdBy: ALICE, visibility: 'private' }));
  store.putRecord(mem('mem_only_bob', { createdBy: ALICE, visibility: 'only', visibleTo: [BOB] }));
  store.putRecord(mem('mem_except_a', { createdBy: ALICE, visibility: 'except', excludeFrom: [ALICE] }));
  const legacy = mem('mem_legacy', { createdBy: ALICE });
  delete legacy.visibility;                       /* 旧数据：完全缺 visibility */
  store.putRecord(legacy);
  store.putRecord(mem('mem_unknown', { createdBy: ALICE, visibility: 'friends' }));
  store.putRecord(mem('mem_emptyvis', { createdBy: ALICE, visibility: '' }));
  /* 另一分区（BOB）的记录：**限制为 BOB 可见**。
     刻意不用 public 做分区探针 —— public 按既有语义就是"任何读主体可读"，
     用它会让"分区"与"权限"两件事混在一起，断言就不再指向 ACL 本身
     （alice 读不到 BOB 的唯一记录，是因为权限，而不是因为分区）。 */
  store.putRecord(mem('mem_bob_only', { createdBy: BOB, visibility: 'only', visibleTo: [BOB] }));
  return store;
}

(async () => {
  const dirs = [];
  const mk = tag => { const d = tempDir(tag); dirs.push(d); return d; };

  /* ══ 1 · canonical 读谓词 ══ */
  section('T1 \u00b7 canReadMemory \u2014 唯一 canonical 读谓词（pure / fail closed）');
  const visOf = (v, extra) => {
    const r = mem('m1', extra || {});
    if (v === undefined) delete r.visibility; else r.visibility = v;
    return r;
  };
  check('T1.1 四档存储词表是既有词表（public/only/except/private），未新增档位',
    Array.isArray(VIS.VISIBILITY_CATEGORIES) &&
    VIS.VISIBILITY_CATEGORIES.slice().sort().join(',') === 'except,only,private,public',
    VIS.VISIBILITY_CATEGORIES);
  check('T1.2 谓词是 pure：同一输入两次调用给出逐字相同的判定',
    JSON.stringify(VIS.canReadMemory(visOf('only', { visibleTo: [ALICE] }), ALICE)) ===
    JSON.stringify(VIS.canReadMemory(visOf('only', { visibleTo: [ALICE] }), ALICE)));
  check('T1.3 谓词不修改入参（无副作用）',
    (() => { const r = visOf('public'); const snap = JSON.stringify(r); VIS.canReadMemory(r, ALICE); return JSON.stringify(r) === snap; })());

  /* ALLOW */
  check('T1.4 public \u2192 任何合法读主体可读',
    VIS.canReadMemory(visOf('public'), ALICE).ok === true &&
    VIS.canReadMemory(visOf('public'), BOB).ok === true);
  check('T1.5 only[ALICE] + viewer=ALICE \u2192 可读',
    VIS.canReadMemory(visOf('only', { visibleTo: [ALICE] }), ALICE).ok === true);
  check('T1.6 except[BOB] + viewer=ALICE \u2192 可读（不在排除集里）',
    VIS.canReadMemory(visOf('except', { excludeFrom: [BOB] }), ALICE).ok === true);

  /* DENY */
  check('T1.7 private \u2192 拒绝，**即使读主体就是写入者**（既有语义：private 从不注入任何 prompt）',
    VIS.canReadMemory(visOf('private', { createdBy: ALICE }), ALICE).ok === false,
    VIS.canReadMemory(visOf('private', { createdBy: ALICE }), ALICE));
  check('T1.8 only[BOB] + viewer=ALICE \u2192 拒绝',
    VIS.canReadMemory(visOf('only', { visibleTo: [BOB] }), ALICE).ok === false);
  check('T1.9 except[ALICE] + viewer=ALICE \u2192 拒绝',
    VIS.canReadMemory(visOf('except', { excludeFrom: [ALICE] }), ALICE).ok === false);
  check('T1.10 缺失 visibility \u2192 拒绝（fail closed，与既有召回一致）',
    VIS.canReadMemory(visOf(undefined), ALICE).ok === false &&
    VIS.canReadMemory(visOf(undefined), ALICE).reason === 'missing-visibility',
    VIS.canReadMemory(visOf(undefined), ALICE));
  check('T1.11 空串 visibility \u2192 拒绝（归为 missing）',
    VIS.canReadMemory(visOf(''), ALICE).reason === 'missing-visibility');
  check('T1.12 未知档位（"friends"）\u2192 拒绝，且 reason 可区分',
    VIS.canReadMemory(visOf('friends'), ALICE).reason === 'unknown-visibility');
  check('T1.13 畸形档位（非字符串）\u2192 拒绝，且 reason 可区分',
    VIS.canReadMemory(visOf(42), ALICE).reason === 'malformed-visibility');
  check('T1.14 缺读主体（null / 空串 / 空白）\u2192 拒绝，**包括 public**',
    VIS.canReadMemory(visOf('public'), null).reason === 'no-principal' &&
    VIS.canReadMemory(visOf('public'), '').reason === 'no-principal' &&
    VIS.canReadMemory(visOf('public'), '   ').reason === 'no-principal');
  check('T1.15 **设备身份不得冒充角色身份**：{kind:"device"} \u2192 拒绝',
    VIS.canReadMemory(visOf('public'), { kind: 'device', id: ALICE }).reason === 'no-principal');
  check('T1.16 {kind:"role",id} 形式可作读主体（规范化后与裸字符串等价）',
    VIS.canReadMemory(visOf('only', { visibleTo: [ALICE] }), { kind: 'role', id: ALICE }).ok === true);
  check('T1.17 设备 id 当读主体 \u2192 只按字面角色名匹配（不会因为"是设备"而被放行）',
    VIS.canReadMemory(visOf('only', { visibleTo: [ALICE] }), DEVICE).ok === false);
  check('T1.18 非对象记录 \u2192 拒绝（no-record）',
    VIS.canReadMemory(null, ALICE).reason === 'no-record');
  check('T1.19 判定**不依据 createdBy**：owner 身份不构成任何放行理由',
    VIS.canReadMemory(visOf('only', { visibleTo: [BOB], createdBy: ALICE }), ALICE).ok === false);
  check('T1.20 派生制品印章被拒 \u2192 在读谓词处即拒绝（印章先于证据）',
    VIS.canReadMemory(visOf('public'), ALICE, { stamp: { visibility: 'private' } }).reason === 'stamp-denied');
  check('T1.21 partitionByAccess 只返回计数与稳定原因，不返回正文',
    (() => {
      const p = VIS.partitionByAccess([visOf('public'), visOf('private'), visOf(undefined)], ALICE);
      return p.readable.length === 1 && p.refused.length === 2 &&
        JSON.stringify(p.byReason) === JSON.stringify({ hidden: 1, 'missing-visibility': 1 });
    })());

  /* ══ 2 · /memory/list 的服务端 ACL ══ */
  section('T2 \u00b7 /memory/list \u2014 服务端 ACL（授权视图 \u2192 分页 \u2192 序列化）');
  const store = seedStore(mk('list'));

  const full = store.listRecords({});
  check('T2.1 不传 viewer 时**完整镜像逐字不变**（桌面 memory-authority 的 hydrate/召回依赖完整候选集）',
    full.count === 9 && full.records.some(r => r.id === 'mem_priv_a'));
  check('T2.2 完整镜像里 private/only[别人]/缺失 全部存在（镜像≠读视图，读视图才是 ACL）',
    ['mem_priv_a', 'mem_only_bob', 'mem_legacy', 'mem_unknown'].every(id => full.records.some(r => r.id === id)));

  const al = store.listVisible({ viewer: ALICE });
  const alIds = al.records.map(r => r.id).sort();
  check('T2.3 viewer=ALICE 只拿到授权记录（public + only[ALICE]）',
    alIds.join(',') === 'mem_only_alice,mem_pub_a', alIds);
  check('T2.4 **未授权记录不进入响应**（逐条核对：private/only[别人]/except/缺失/未知/畸形 一条都不在）',
    ['mem_priv_a', 'mem_only_bob', 'mem_except_a', 'mem_legacy', 'mem_unknown', 'mem_emptyvis'].every(id => alIds.indexOf(id) < 0), alIds);
  check('T2.5 拒绝原因被如实归类（不是"静默丢弃"）',
    al.refusedByReason['hidden'] === 4 &&
    al.refusedByReason['missing-visibility'] === 2 &&
    al.refusedByReason['unknown-visibility'] === 1, al.refusedByReason);
  check('T2.6 拒绝清单只含 recordId + 稳定原因 + 分类，**不含正文**',
    al.refused.every(r => Object.keys(r).sort().join(',') === 'category,reason,recordId') &&
    JSON.stringify(al.refused).indexOf('BODY-') < 0, al.refused);
  check('T2.7 整条响应里不含任何被拒绝记录的正文（真正的"不进入响应"，不是置空/打标记）',
    JSON.stringify(al).indexOf('BODY-mem_priv_a') < 0 &&
    JSON.stringify(al).indexOf('BODY-mem_only_bob') < 0 &&
    JSON.stringify(al).indexOf('BODY-mem_legacy') < 0);

  const bob = store.listVisible({ viewer: BOB });
  check('T2.8 viewer=BOB 拿到的是**另一组**记录（只读[BOB] ×2 + 那个 public）—— ' +
    'private 仍被拒；且 mem_except_a（排除 ALICE）对 BOB 可读，证明 except 按读主体判定而不是按"是不是 owner"',
    bob.records.map(r => r.id).sort().join(',') === 'mem_bob_only,mem_except_a,mem_only_bob,mem_pub_a',
    bob.records.map(r => r.id).sort());

  const noViewer = store.listVisible({});
  check('T2.9 **无 viewer \u2192 空页 + 稳定 reason**（fail closed，绝不是"返回全部"）',
    noViewer.count === 0 && noViewer.reason === 'no-principal', noViewer.reason);

  const scoped = store.listVisible({ viewer: ALICE, ownerId: ALICE });
  check('T2.10 ownerId 只做**分区收窄**（owner_id 列 = createdBy），不参与放行',
    scoped.records.map(r => r.id).sort().join(',') === 'mem_only_alice,mem_pub_a', scoped.records.map(r => r.id));
  const scopedBob = store.listVisible({ viewer: BOB, ownerId: BOB });
  check('T2.11 分区收窄按 createdBy 生效（BOB 分区只有 mem_bob_only）',
    scopedBob.records.map(r => r.id).join(',') === 'mem_bob_only', scopedBob.records.map(r => r.id));

  check('T2.12 core 不可用 \u2192 空页 + reason=core-unavailable（不返回记录）',
    (() => {
      const nc = createMemoryStore({ dataDir: mk('nocore'), logger: () => {}, visibilityCore: null });
      nc.open(); nc.putRecord(mem('mem_x', { createdBy: ALICE }));
      const r = nc.listVisible({ viewer: ALICE });
      nc.close();
      return r.ok === true && r.count === 0 && r.records.length === 0 && r.reason === 'core-unavailable';
    })());

  /* ══ 3 · 分页 ══ */
  section('T3 \u00b7 分页 \u2014 被拒绝的行不占页槽、不影响 hasMore（无空洞 / 无数量侧信道）');
  const pagDir = mk('pag');
  const pagStore = createMemoryStore({ dataDir: pagDir, logger: () => {} });
  pagStore.open();
  let denyN = 0;
  for (let i = 0; i < 5; i++) {
    pagStore.putRecord(mem('mem_ok_' + i, { createdBy: ALICE }));
    for (let j = 0; j < 6; j++) { denyN++; pagStore.putRecord(mem('mem_deny_' + denyN, { createdBy: ALICE, visibility: 'private' })); }
  }
  check('T3.0 种子：5 条可读 + 30 条被拒绝（拒绝行数量远多于可读行）', pagStore.countRecords() === 35);

  const p1 = pagStore.listVisible({ viewer: ALICE, limit: 2 });
  check('T3.1 limit=2 拿到**满 2 条可读行**（隐藏行不消耗页槽，否则这里只有 0~1 条）',
    p1.count === 2 && p1.records.map(r => r.id).join(',') === 'mem_ok_0,mem_ok_1', p1.records.map(r => r.id));
  check('T3.2 页面无空洞：拿到的是**连续**的可读行，不是"前 2 条里恰好可读的那些"',
    p1.records.every(r => r.id.indexOf('mem_ok_') === 0));
  check('T3.3 hasMore/truncated 如实为真，且扫描确实继续推进（不是第一页就下结论）',
    p1.truncated === true && p1.scanned === 15 && p1.reachedScanLimit === true,
    { truncated: p1.truncated, scanned: p1.scanned, reachedScanLimit: p1.reachedScanLimit });
  check('T3.4 被拒绝的记录**一条都没有**泄漏进 records',
    p1.records.every(r => r.id.indexOf('mem_deny_') < 0) && p1.refused.every(r => r.recordId.indexOf('mem_deny_') === 0));
  check('T3.5 扫描到末尾时 truncated=false（不谎报"还有更多"）',
    (() => { const a = pagStore.listVisible({ viewer: ALICE, limit: 100 }); return a.count === 5 && a.truncated === false && a.scanned === 35; })());
  check('T3.6 limit 恰好等于可读条数、且后面没有可读行 \u2192 truncated=false',
    (() => { const e = pagStore.listVisible({ viewer: ALICE, limit: 5 }); return e.count === 5 && e.truncated === false; })());

  /* ══ 4 · /memory/changes 的撤销语义 ══ */
  section('T4 \u00b7 /memory/changes \u2014 撤销语义（客户端本地镜像必须被清掉）');
  const chDir = mk('changes');
  const chStore = createMemoryStore({ dataDir: chDir, logger: () => {} });
  chStore.open();
  chStore.putRecord(mem('mem_shared', { createdBy: ALICE, visibility: 'only', visibleTo: [BOB] }));

  /* T0：BOB 可读 → 客户端已缓存 */
  const t0 = chStore.changesVisibleAfter(0, { viewer: BOB });
  const cursor0 = t0.cursor;
  check('T4.1 T0：BOB 收到 upsert（这条对他可读，客户端据此写入本地镜像）',
    t0.upserts.length === 1 && t0.upserts[0].record.id === 'mem_shared', t0.upserts.map(u => u.record.id));

  /* T1：可见性收窄 → BOB 不再有权限 */
  chStore.putRecord(mem('mem_shared', { createdBy: ALICE, visibility: 'only', visibleTo: [ALICE] }));

  /* T2：BOB 再次 sync */
  const t2 = chStore.changesVisibleAfter(cursor0, { viewer: BOB });
  check('T4.2 T2：BOB **不再收到该记录**（不是继续发 upsert）',
    t2.upserts.length === 0, t2.upserts.map(u => u.record.id));
  check('T4.3 T2：BOB 收到一条 **delete（revoke）**，足以让他删掉本地副本 —— ' +
    '否则旧正文会永久留在本地（这正是"以后不再发送"做不到的事）',
    t2.deletes.length === 1 && t2.deletes[0].recordId === 'mem_shared' &&
    t2.deletes[0].reason === 'visibility-revoked', t2.deletes);
  check('T4.4 revoke 事件带**权威 revision**（客户端据此推进游标，不会卡在同一处反复拉取）',
    typeof t2.deletes[0].revision === 'number' && t2.deletes[0].revision > cursor0 &&
    t2.cursor === t2.deletes[0].revision, { rev: t2.deletes[0].revision, cursor: t2.cursor, before: cursor0 });
  check('T4.5 revoke 用的是**既有 delete 条目形状**（recordId/ownerId/revision 都在，客户端无需改动）',
    t2.deletes.every(d => d.recordId != null && d.ownerId != null && typeof d.revision === 'number'));
  check('T4.6 revoke 清单只含 recordId + 可见性分类，不含正文',
    JSON.stringify(t2.revoked).indexOf('BODY-') < 0 && t2.revoked[0].recordId === 'mem_shared', t2.revoked);
  check('T4.7 撤销后**已推进的游标**上不会重复下发同一条 revoke（幂等，不会反复删）',
    chStore.changesVisibleAfter(t2.cursor, { viewer: BOB }).deletes.length === 0);

  /* 永久删除仍走物理 delete */
  chStore.putRecord(mem('mem_gone', { createdBy: ALICE }));
  const beforeDel = chStore.changesVisibleAfter(0, { viewer: ALICE }).cursor;
  chStore.deleteRecord('mem_gone', {});
  const afterDel = chStore.changesVisibleAfter(beforeDel, { viewer: ALICE });
  check('T4.8 真删除仍发 delete（reason=deleted），与 revoke 在 reason 上可区分',
    afterDel.deletes.length === 1 && afterDel.deletes[0].recordId === 'mem_gone' &&
    afterDel.deletes[0].reason === 'deleted', afterDel.deletes);

  /* 撤销后重新变宽 → 必须重新 upsert（否则客户端永远拿不回来） */
  chStore.putRecord(mem('mem_shared', { createdBy: ALICE, visibility: 'only', visibleTo: [BOB, ALICE] }));
  const regrant = chStore.changesVisibleAfter(afterDel.cursor, { viewer: BOB });
  check('T4.9 可见性重新放宽 \u2192 重新下发 upsert（撤销不是单向的，客户端能拿回来）',
    regrant.upserts.some(u => u.record.id === 'mem_shared'), regrant.upserts.map(u => u.record.id));

  check('T4.10 无读主体 \u2192 **失败**（不是"返回完整变更流"）',
    (() => { const r = chStore.changesVisibleAfter(0, {}); return r.ok === false && r.error === 'no-principal'; })());
  check('T4.11 core 不可用 \u2192 **失败**（不是"返回完整变更流"）',
    (() => {
      const nc = createMemoryStore({ dataDir: mk('nocore2'), logger: () => {}, visibilityCore: null });
      nc.open(); nc.putRecord(mem('mem_y', { createdBy: ALICE }));
      const r = nc.changesVisibleAfter(0, { viewer: ALICE });
      nc.close();
      return r.ok === false && r.error === 'core-unavailable';
    })());
  check('T4.12 非法 cursor \u2192 拒绝（不静默归零）',
    chStore.changesVisibleAfter(-1, { viewer: ALICE }).error === 'bad-cursor');
  check('T4.13 ownerId 分区收窄：别的分区记录不出现在该分区主体的变更流里',
    (() => {
      const other = createMemoryStore({ dataDir: mk('changes2'), logger: () => {} });
      other.open();
      other.putRecord(mem('mem_a1', { createdBy: ALICE }));
      other.putRecord(mem('mem_b1', { createdBy: BOB }));
      const r = other.changesVisibleAfter(0, { viewer: ALICE, ownerId: ALICE });
      other.close();
      return r.upserts.map(u => u.record.id).join(',') === 'mem_a1';
    })());

  /* ══ 5 · HTTP 边界 + envelope 兼容 ══ */
  section('T5 \u00b7 HTTP \u2014 envelope 兼容（不 fork）与端到端 ACL');
  const svcDir = mk('http');
  const provider = { seen: [] };
  const providerServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      provider.seen.push(raw);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'stub', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  let svc = null;
  try {
    const providerPort = await listen(providerServer);
    svc = SERVICE.buildHomeNode({
      dataDir: svcDir,
      providerEndpoint: 'http://127.0.0.1:' + providerPort + '/v1/chat/completions',
      providerKey: 'stub-key',
      logger: () => {}
    });
    const port = await listen(svc.server);
    /* 与 test_mobile_memory_continuity.js 同款：buildHomeNode 返回装配体，
       store 由 open() 打开。少了这一步，桌面面全部 503（store-closed），
       T5 会变成"因为没开库所以没有泄漏"的假绿。 */
    svc.open();

    /* 直接经 canonical store 播种（HTTP 写路径由既有测试覆盖）。 */
    const hs = svc.memoryStore;
    hs.putRecord(mem('h_pub', { createdBy: ALICE }));
    hs.putRecord(mem('h_priv', { createdBy: ALICE, visibility: 'private' }));
    hs.putRecord(mem('h_only_alice', { createdBy: ALICE, visibility: 'only', visibleTo: [ALICE] }));
    hs.putRecord(mem('h_only_bob', { createdBy: ALICE, visibility: 'only', visibleTo: [BOB] }));

    /* A · 不传 viewer：envelope **逐字不变**（桌面 hydrate 依赖它） */
    const plain = await request(port, 'GET', '/memory/list?limit=100');
    check('T5.1 [A] 不传 viewer \u2192 2xx 且 envelope 仍是 okBody（payload 里 count/revision/truncated/records）',
      plain.status === 200 && plain.body.ok === true && typeof plain.body.payload === 'object' &&
      typeof plain.body.payload.count === 'number' && typeof plain.body.payload.revision === 'number' &&
      typeof plain.body.payload.truncated === 'boolean' && Array.isArray(plain.body.payload.records),
      { status: plain.status, keys: plain.body && plain.body.payload ? Object.keys(plain.body.payload) : null });
    check('T5.2 [A] 不传 viewer \u2192 记录形状不变（id/content/visibility 原样，未包装、未裁剪）',
      plain.body.payload.records.some(r => r.id === 'h_priv' && typeof r.content === 'string') &&
      plain.body.payload.records.some(r => r.id === 'h_pub' && r.visibility === 'public'));
    check('T5.3 [A] 不传 viewer \u2192 viewer=null / access=null（"这次读取没有读主体"是可观测事实，不是猜测）',
      plain.body.payload.viewer === null && plain.body.payload.access === null,
      { viewer: plain.body.payload.viewer, access: plain.body.payload.access });

    /* B · 传 viewer：服务端 ACL */
    const scopedHttp = await request(port, 'GET', '/memory/list?limit=100&viewer=' + ALICE);
    check('T5.4 [B] viewer=ALICE \u2192 200 且 envelope 形状**同一个**（只多字段，不改形状）',
      scopedHttp.status === 200 && scopedHttp.body.ok === true && typeof scopedHttp.body.payload === 'object' &&
      Array.isArray(scopedHttp.body.payload.records) && typeof scopedHttp.body.payload.count === 'number');
    check('T5.5 [B] **restricted record 不进入响应体**（原始报文逐字检查：正文标记一次都不出现）',
      scopedHttp.raw.indexOf('BODY-h_priv') < 0 && scopedHttp.raw.indexOf('BODY-h_only_bob') < 0,
      scopedHttp.raw.slice(0, 300));
    check('T5.6 [B] 只返回授权记录（h_pub + h_only_alice）',
      scopedHttp.body.payload.records.map(r => r.id).sort().join(',') === 'h_only_alice,h_pub',
      scopedHttp.body.payload.records.map(r => r.id));
    check('T5.7 [B] access 只含计数与稳定原因（无正文、无 visibleTo 原值）',
      scopedHttp.body.payload.access && scopedHttp.body.payload.access.refused === 2 &&
      JSON.stringify(scopedHttp.body.payload.access).indexOf('BODY-') < 0 &&
      JSON.stringify(scopedHttp.body.payload.access).indexOf('h_only_bob') < 0,
      scopedHttp.body.payload.access);
    check('T5.8 [B] viewer 被如实回显（调用方可以断言"这次读是用哪个主体做的"）',
      scopedHttp.body.payload.viewer === ALICE);
    check('T5.8b [B] viewer 字段**确实存在**（"缺字段"本身就是缺陷：调用方无法区分 ' +
      '"没有读主体"与"信封丢了读主体"）',
      Object.prototype.hasOwnProperty.call(scopedHttp.body.payload, 'viewer') &&
      Object.prototype.hasOwnProperty.call(scopedHttp.body.payload, 'access'),
      Object.keys(scopedHttp.body.payload));

    /* C · 非法 viewer：fail closed，不是"返回全部" */
    const badViewer = await request(port, 'GET', '/memory/list?limit=100&viewer=%20%20');
    check('T5.9 [C] viewer 是空白串 \u2192 200 但 **0 条**（fail closed；绝不能退化成完整镜像）',
      badViewer.status === 200 && badViewer.body.payload.count === 0 &&
      badViewer.body.payload.records.length === 0, badViewer.body.payload);

    /* D · 设备 id 冒充角色：不因为"是设备"而放行 */
    const devViewer = await request(port, 'GET', '/memory/list?limit=100&viewer=' + DEVICE);
    check('T5.10 [D] 用设备 id 当 viewer \u2192 拿不到任何角色记忆',
      devViewer.status === 200 && devViewer.body.payload.records.every(r => r.id !== 'h_only_alice' && r.id !== 'h_priv'),
      devViewer.body.payload.records.map(r => r.id));

    /* E · changes：envelope 兼容 + 撤销 */
    const chPlain = await request(port, 'GET', '/memory/changes?cursor=0&limit=500');
    check('T5.11 [E] 不传 viewer \u2192 changes envelope 逐字不变（cursor/serverTime/revision/upserts/deletes/hasMore）',
      chPlain.status === 200 && chPlain.body.ok === true &&
      typeof chPlain.body.payload.cursor === 'number' &&
      typeof chPlain.body.payload.revision === 'number' &&
      Array.isArray(chPlain.body.payload.upserts) && Array.isArray(chPlain.body.payload.deletes) &&
      typeof chPlain.body.payload.hasMore === 'boolean',
      Object.keys(chPlain.body.payload || {}));
    const chCursor = chPlain.body.payload.cursor;

    hs.putRecord(mem('h_only_bob', { createdBy: ALICE, visibility: 'only', visibleTo: [ALICE] }));
    const chScoped = await request(port, 'GET', '/memory/changes?cursor=' + chCursor + '&viewer=' + BOB);
    check('T5.12 [E] viewer=BOB 的 changes：该记录不再作为 upsert 下发',
      chScoped.status === 200 &&
      !(chScoped.body.payload.upserts || []).some(u => u.record && u.record.id === 'h_only_bob'),
      (chScoped.body.payload.upserts || []).map(u => u.record && u.record.id));
    check('T5.13 [E] viewer=BOB 的 changes：收到 visibility-revoked 的 delete（撤销经既有通道送达）',
      (chScoped.body.payload.deletes || []).some(d => d.recordId === 'h_only_bob' && d.reason === 'visibility-revoked'),
      chScoped.body.payload.deletes);
    check('T5.14 [E] changes 原始报文不含被撤销记录的正文',
      chScoped.raw.indexOf('BODY-h_only_bob') < 0, chScoped.raw.slice(0, 300));
    check('T5.15 [E] 撤销观测只报计数与分类，不含正文与 visibleTo 原值',
      chScoped.body.payload.access && chScoped.body.payload.access.revoked >= 1 &&
      JSON.stringify(chScoped.body.payload.access).indexOf('BODY-') < 0);

    /* F · Android 仍然没有 memory verb（回归：本阶段没有打开设备面）
       必须带**合法设备凭据**再断言 404：不带凭据的 401 证明不了"没有这个 verb"
       （它只证明"没认证"）。

       ── P11-3X-A 修正（本段此前是**红的**，且与本阶段的改动无关）──────────
       本文件写于 P11-3A 之前，旧的写法是 `headers: svc.token ? {'X-IB-Home-Token': svc.token} : {}`
       —— 但 buildHomeNode() 的返回值里从来没有 `token` 字段，所以它**恒**不带凭据；
       P11-3A 把 `/pairing/session` 收成"未配置桌面 token → 403 desktop-token-required"
       之后，这里就必然拿到 403，随后 `sPair.body.payload.pairingId` 抛 TypeError，
       整份套件在 T5.16 处中断（前面几十项其实全绿）。
       修法是**只改这一段**：为设备面单独建一个**显式带桌面 token** 的实例
       （buildHomeNode 早就支持 options.token），从而同时保住"设备面 404"的断言强度
       与上面所有"未配置 token"的断言语义。生产代码零改动。 */
    const authDir = mk('http-auth');
    const authSvc = SERVICE.buildHomeNode({ dataDir: authDir, token: DESKTOP_TOKEN, logger: () => {} });
    const authPort = await listen(authSvc.server);
    authSvc.open();
    try {
      const sPair = await request(authPort, 'POST', '/pairing/session', {
        headers: { 'X-IB-Home-Token': DESKTOP_TOKEN },
        body: { deviceName: 'P11-2G Phone', deviceType: 'android' }
      });
      check('T5.16q 配了对才有资格断言 404：桌面 token 在场时 /pairing/session 正常签发',
        sPair.status === 200 && sPair.body.payload && typeof sPair.body.payload.pairingId === 'string',
        { status: sPair.status, body: sPair.body });
      const cPair = await request(authPort, 'POST', '/mobile/v1/pairing/complete', {
        body: { v: 1, payload: { pairingId: sPair.body.payload.pairingId, secret: sPair.body.payload.secret, deviceName: 'P11-2G Phone', deviceType: 'android' } }
      });
      const devAuth = { Authorization: 'Bearer ' + cPair.body.payload.token };
      check('T5.16a 设备配对成功（否则下面的 404 断言证明不了任何事）',
        cPair.status === 200 && typeof cPair.body.payload.token === 'string', cPair.body);
      const mobileList = await request(authPort, 'GET', '/mobile/v1/memory/list', { headers: devAuth });
      const mobileChanges = await request(authPort, 'GET', '/mobile/v1/memory/changes', { headers: devAuth });
      check('T5.16 [F] **/mobile/v1/memory/list 仍然 404**（本阶段没有给设备面开任何读口）',
        mobileList.status === 404, mobileList.status);
      check('T5.17 [F] **/mobile/v1/memory/changes 仍然 404**', mobileChanges.status === 404, mobileChanges.status);
      check('T5.17b [F] 未配对设备同样拿不到（401，而不是先路由再拒绝）',
        (await request(authPort, 'GET', '/mobile/v1/memory/list')).status === 401);
      check('T5.17c [F] 设备面响应体里没有 memory 记录正文',
        mobileList.raw.indexOf('BODY-') < 0 && mobileChanges.raw.indexOf('BODY-') < 0,
        mobileList.raw.slice(0, 200));
    } finally {
      authSvc.close();
    }
    const sec = await request(port, 'GET', '/security');
    check('T5.18 [F] /security 仍如实声明"存储但不服务设备"（deviceVerbs 为空）',
      sec.status === 200 && sec.body.memoryPolicy && sec.body.memoryPolicy.stored === true &&
      sec.body.memoryPolicy.servedToDevices === false &&
      Array.isArray(sec.body.memoryPolicy.deviceVerbs) && sec.body.memoryPolicy.deviceVerbs.length === 0,
      sec.body.memoryPolicy);
  } finally {
    if (svc && svc.server) { try { svc.server.close(); } catch (_) { /* 已关闭 */ } }
    try { providerServer.close(); } catch (_) { /* 已关闭 */ }
    if (svc && svc.memoryStore && svc.memoryStore.close) { try { svc.memoryStore.close(); } catch (_) { /* 已关闭 */ } }
  }

  /* ══ 6 · 与既有语义的一致性（不是第二套规则）══ */
  section('T6 \u00b7 一致性 \u2014 读边界与既有注入边界同源');
  check('T6.1 canReadMemory 与 isMemoryVisibleTo 在每一档上结论一致（无第二套规则）',
    [['public', {}], ['private', {}], ['only', { visibleTo: [ALICE] }], ['only', { visibleTo: [BOB] }],
      ['except', { excludeFrom: [ALICE] }], ['except', { excludeFrom: [BOB] }]].every(([v, extra]) => {
      const r = mem('m2', Object.assign({ visibility: v }, extra));
      return VIS.canReadMemory(r, ALICE).ok === VIS.isMemoryVisibleTo(r, ALICE, false, false);
    }));
  check('T6.2 缺失 visibility 在两处都判不可见（fail closed 一致）',
    (() => { const r = mem('m3'); delete r.visibility;
      return VIS.canReadMemory(r, ALICE).ok === false && VIS.isMemoryVisibleTo(r, ALICE, false, false) === false; })());

  store.close(); pagStore.close(); chStore.close();
  dirs.forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } });

  console.log('\n' + (failed === 0 ? 'ALL PASS' : 'FAILED') + ' \u2014 passed=' + passed + ' failed=' + failed);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => {
  console.error('SUITE ERROR: ' + (error && error.stack || error));
  process.exit(1);
});
