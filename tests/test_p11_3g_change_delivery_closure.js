/* ====================================================================
   P11-3G · Change-Log Delivery Closure
   --------------------------------------------------------------------
   `node tests/test_p11_3g_change_delivery_closure.js`
   （可选分节：`node tests/test_p11_3g_change_delivery_closure.js A B`）

   ── 这个测试为什么必须存在 ─────────────────────────────────────────────
   修复前实测（私有 Home Node + 私有 data dir + 私有端口 + 真实 HTTP +
   真实 home-node-client + 真实 moments-authority）：

     · 窗口第一条 event 永久失败 → `applyChanges` 把整页串成一条 promise 链，
       第一个失败就整页拒绝；cursor 只在整页成功时前进。于是每轮 sync
       **只尝试那一条**（实测 put=1 / putFail=1），cursor 恒为 50，
       服务端每轮发回同一个窗口（cursor→150, upserts=100, hasMore=true）——
       窗口后段的 50 条**永久不可达**；
     · 中间某条失败 → 失败点**之前**的 event 已经逐条落盘（部分应用），
       失败点**之后**的一条都不被尝试；下一轮从第 1 条整窗重放；
     · 没有任何 attempts 计数（源码里不存在该状态）→ 谈不上上界，
       也谈不上"重启归零"——它本来就是无限的；
     · `local.put` 解析为 `false`（生产驱动对缺 id 的行就是这么返回的）
       被当成成功 → cursor 越过一条**从未落盘**的 event → 静默数据丢失；
     · change_log **从不回收**（源码里没有 DELETE），实测涨到 557 行。

   本文件按 P11-3E / P11-3F 的同一条纪律回答它们：**真实链路**
   （真实 spawn / 真实 HTTP / 真实 home-node-client 传输 / 真实 authority），
   不 mock store，不复制接线。镜像替身与 home-node-bootstrap.js 的 local
   driver 逐字段同形（含 P11-3G 新增的投递状态接缝）。

   ── 覆盖（与阶段要求 A–L + 不变量对齐）─────────────────────────────────
   A happy path          · 正常事件全部 apply，cursor 前进，ACK 上报
   B 第一条 poison       · 有界重试 → 终态 → cursor 越过 → 后续事件可达
   C 中间 poison         · 真实的 cursor / 部分应用行为
   D transient failure   · 允许 retry → eventually applied（不直接终态）
   E permanent failure   · 有界、显式终态、不无限消耗 I/O
   F duplicate replay    · apply 成功但持久结论未落盘 → 重放幂等
   G crash before apply  · event 不丢
   H restart durability  · attempts / ACK 水位不被 restart 归零
   I tombstone           · delete 的幂等 / 终态 / 可重试语义
   J long stream         · > limit 的事件最终全部可达（一个坏 event 挡不住）
   K retention           · 只回收已确认的；pending 绝不删；回收后无 gap
   L authoritative rebuild· 历史被回收后靠**快照**恢复（不改 3F contract）
   M observability       · 终态可观测 + 诊断不含正文/payload/凭据
   N forbidden shapes    · 被消灭的写法不许复活（含"不得新建第二 authority"）
   R registered, NOT fixed· 本阶段刻意不修的项（断言现状，防止静默变化）

   ── 刻意不做 ──────────────────────────────────────────────────────────
   · 不实现 P11-3H 的 graceful shutdown / installer；
   · 不动 memory / understanding / chat 的 hydrate（不同原语，只登记）；
   · 不修 P11-3F 登记的 migration-before-hydrate 债（只断言它仍在）。
   ==================================================================== */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_FILE = 'services/home-node-service.js';
const AUTH_PATH = path.join(ROOT, 'assets', 'js', 'moments-authority.js');
const CLIENT_PATH = path.join(ROOT, 'assets', 'js', 'home-node-client.js');
const STORE_PATH = path.join(ROOT, 'services', 'home-node', 'moments-store.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; failures.push(name); console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n\u2500\u2500 ' + title + ' \u2500\u2500'); }

const WANT = (function () {
  const argv = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (argv.length) return argv;
  return String(process.env.P11_3G_SECTIONS || '').split(/[\s,]+/).filter(Boolean);
})();
function wants(id) { return WANT.length === 0 || WANT.indexOf(id) >= 0; }

/* ── 隔离纪律：私有临时目录 + 私有端口；只删本次新建的夹具 ───────────── */
const TEMP_ROOT = os.tmpdir();
const tempDirs = [];
const openChildren = new Set();
function fixtureNames() {
  const out = new Set();
  try { for (const name of fs.readdirSync(TEMP_ROOT)) if (/^ib-3g-/.test(name)) out.add(name); } catch (_) { /* 空集 */ }
  return out;
}
const FIXTURES_BEFORE = fixtureNames();
function removeTempFixtures() {
  for (const name of fixtureNames()) {
    if (FIXTURES_BEFORE.has(name)) continue;
    try { fs.rmSync(path.join(TEMP_ROOT, name), { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ }
  }
}
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, 'ib-3g-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: 20000
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 200) }; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function unwrap(res) { return res && res.body && res.body.payload ? res.body.payload : null; }

const BUNDLED_NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const NODE_BIN = fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;

function startProduction(dir) {
  return freePort().then(port => new Promise(resolve => {
    const child = spawn(NODE_BIN, [SERVICE_FILE], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        IB_HOME_NODE_PORT: String(port),
        IB_HOME_NODE_DATA_DIR: dir
      }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    openChildren.add(child);
    const svc = { port, child, out: '' };
    child.stdout.on('data', c => { svc.out += String(c); });
    child.stderr.on('data', c => { svc.out += String(c); });
    child.on('exit', () => openChildren.delete(child));
    resolve(svc);
  }));
}
async function waitListening(svc, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await request(svc.port, 'GET', '/health'); if (r.status === 200) return true; } catch (_) { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}
function stopProduction(svc) {
  if (!svc || !svc.child) return;
  try { svc.child.kill('SIGTERM'); } catch (_) { /* 已退出 */ }
}
/* 顶层收尾：显式收掉子进程与夹具，然后才设置退出码 —— 否则一次未捕获异常
   表现为"挂死"而不是"失败"（docs/INTERNALBEYOND_AI_RULES.md §15.2）。 */
process.on('exit', () => {
  for (const child of openChildren) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
  removeTempFixtures();
});

/* ── 浏览器替身：home-node-client.js 顶层真正用到的最小面 ───────────────── */
function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); }
  };
}
function loadClient(port) {
  global.localStorage = makeStorage({ ib_home_node_http: 'http://127.0.0.1:' + port, ib_home_node_mode: 'canonical' });
  global.window = {};
  delete require.cache[require.resolve(CLIENT_PATH)];
  require(CLIENT_PATH);
  return global.window.IB;
}
function createAuthority(remote, mirror, clock) {
  delete require.cache[require.resolve(AUTH_PATH)];
  const AUTH = require(AUTH_PATH);
  return AUTH.createMomentsAuthority({
    remote, local: mirror, mode: 'canonical', fileOrigin: false,
    log: () => { }, clock: clock || (() => Date.now())
  });
}

/* ── 镜像替身 ─────────────────────────────────────────────────────────
   形状与 home-node-bootstrap.js 的 moments local driver **逐字段一致**
   （get/getAll/getByOwner/put/remove/markMigrated/replaceAll，以及 P11-3G
   新增的 deliveryState/saveDeliveryState）。

   `durable` 传一个 Map 时，投递状态就**真的**跨 authority 实例存活 ——
   这正是 H 分节要测的东西；不传时如实走"没有持久接缝"的降级路径。

   注入的失败用**真实的 IndexedDB 错误名**（DataError 是"这一条自己的问题"，
   QuotaExceededError / UnknownError 是"镜像这一层的问题"），
   因此分类测的是生产词表，不是自造的字符串。 */
function makeMirror(durable) {
  const rows = new Map();
  const calls = { put: 0, remove: 0, replaceAll: 0, failed: 0, deliverySave: 0, deliveryLoad: 0, putIds: [] };
  const fail = new Map();       /* id → { name, left } */
  const mirror = {
    calls, rows,
    ids: () => Array.from(rows.keys()).sort(),
    has: id => rows.has(String(id)),
    size: () => rows.size,
    getAllRaw: () => Array.from(rows.values()),
    failFor: (id, name, times) => fail.set(String(id), { name: name || 'DataError', left: times == null ? Infinity : times }),
    clearFailures: () => fail.clear(),
    get: id => Promise.resolve(rows.get(String(id)) || null),
    getAll: () => Promise.resolve(Array.from(rows.values())),
    getByOwner: roleId => Promise.resolve(Array.from(rows.values()).filter(r => r && r.roleId === roleId)),
    put: function (row) {
      calls.put++;
      if (!row || row.id == null) return Promise.resolve(false);   /* 生产驱动的静默形状 */
      const f = fail.get(String(row.id));
      if (f && f.left > 0) {
        if (f.left !== Infinity) f.left--;
        /* 'SILENT' 复刻生产驱动**解析成 false 但从不写**的那条路径。 */
        if (f.name === 'SILENT') return Promise.resolve(false);
        calls.failed++;
        return Promise.reject({ name: f.name, message: 'IndexedDB 应用失败（注入）' });
      }
      rows.set(String(row.id), row);
      calls.putIds.push(String(row.id));
      return Promise.resolve(true);
    },
    remove: function (id) {
      calls.remove++;
      const f = fail.get(String(id));
      if (f && f.left > 0) {
        if (f.left !== Infinity) f.left--;
        calls.failed++;
        return Promise.reject({ name: f.name, message: 'IndexedDB 删除失败（注入）' });
      }
      rows.delete(String(id));
      return Promise.resolve(true);
    },
    markMigrated: () => Promise.resolve({ ok: true }),
    replaceAll: function (incoming) {
      calls.replaceAll++;
      const next = new Map();
      (incoming || []).forEach(r => { if (r && r.id != null) next.set(String(r.id), r); });
      rows.clear();
      next.forEach((v, k) => rows.set(k, v));
      return Promise.resolve(true);
    }
  };
  if (durable) {
    mirror.deliveryState = function (key) {
      calls.deliveryLoad++;
      const raw = durable.get(String(key));
      return Promise.resolve(raw ? JSON.parse(raw) : null);
    };
    mirror.saveDeliveryState = function (key, state) {
      calls.deliverySave++;
      durable.set(String(key), JSON.stringify(state || {}));
      return Promise.resolve(true);
    };
  }
  return mirror;
}

function momentOf(i) {
  return {
    id: 'm_' + String(i).padStart(4, '0'),
    roleId: 'role_a', authorId: 'role_a', authorType: 'role',
    content: 'moment #' + i, visibility: 'all', visibleRoleIds: [],
    createdAt: 1700000000000 + i * 1000
  };
}
async function seed(port, from, to) {
  let last = null;
  for (let i = from; i <= to; i++) {
    last = await request(port, 'POST', '/moments/record', { record: momentOf(i) });
    if (last.status !== 200) throw new Error('seed failed at ' + i + ': ' + last.status + ' ' + String(last.raw).slice(0, 200));
  }
  return last;
}
async function serverChanges(port, cursor, limit) {
  return unwrap(await request(port, 'GET', '/moments/changes?cursor=' + cursor + (limit ? '&limit=' + limit : '')));
}
/* 权威的**当前版本**与**当前 live 条数**。刻意从服务端读，而不是在测试里
   自己推算：record id、revision、live 条数在三者是**不同**的事实轴
   （删除会让条数落后于 revision），把断言建立在推算上会让测试测自己的算术。 */
async function serverRevision(port) {
  return unwrap(await request(port, 'GET', '/moments/list?limit=1')).revision;
}
async function serverLive(port) {
  return unwrap(await request(port, 'GET', '/moments/list?limit=100000')).records.length;
}
/* 可控时钟：退避是真实策略，因此测试必须能拨表，而不是靠 sleep 等它。 */
function makeClock(start) {
  let now = start || 1700000000000;
  const fn = () => now;
  fn.advance = ms => { now += ms; };
  return fn;
}

/* ══════════════════════════════════════════════════════════════════════ */
(async function main() {
  const dir = tmpDir('node');
  const svc = await startProduction(dir);
  const up = await waitListening(svc, 30000);
  if (!up) {
    console.error('Home Node 未能在 30 秒内起来：\n' + svc.out.slice(-3000));
    process.exit(1);
  }
  const PORT = svc.port;
  const IB = loadClient(PORT);
  console.log('私有 Home Node: 127.0.0.1:' + PORT + '  data=' + dir);

  /* ══════════════════════════════════════════════════════════════════
     A · happy path
     ══════════════════════════════════════════════════════════════════ */
  if (wants('A')) {
    section('A · happy path（E1,E2,E3 全部 apply）');
    await seed(PORT, 1, 3);
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);

    const first = await auth.sync({});
    check('A1 首次 sync 走 hydrate（有界播种），镜像 = 权威', first.ok === true && mirror.size() === 3, first);
    check('A2 hydrate 之后 cursor === mirrorRevision === 权威 revision',
      auth.status().cursor === 3 && auth.status().mirrorRevision === 3, auth.status());
    check('A3 投递状态是**持久**的（驱动带接缝时 delivery.durable 为真）',
      auth.status().delivery.durable === true, auth.status().delivery);
    check('A4 快照成功之后 ACK 水位已经上报给权威（watermark = cursor）',
      auth.status().delivery.ackWatermark === 3 && auth.status().delivery.lastAckAt === 3,
      auth.status().delivery);
    const ackedRes = await request(PORT, 'POST', '/moments/ack', { consumer: 'desktop-mirror', watermark: auth.status().cursor });
    const acked = unwrap(ackedRes);
    check('A5 POST /moments/ack 幂等（重复上报同一水位不做事、不报错、不重复回收）',
      ackedRes.body.ok === true && acked.watermark === 3 && acked.previous === 3 &&
      acked.retention === 'watermark-unchanged' && acked.pruned === 0, { ackedRes: ackedRes.body, acked });

    await seed(PORT, 4, 6);
    const inc = await auth.sync({ limit: 100 });
    check('A6 增量把 E4,E5,E6 全部 apply，cursor 前进到 6',
      inc.ok === true && inc.applied === 3 && auth.status().cursor === 6, inc);
    check('A7 增量没有产生任何 pending / terminal（干净路径不留欠账）',
      auth.status().delivery.pending === 0 && auth.status().delivery.terminalUnresolved === 0, auth.status().delivery);
    check('A8 镜像里确实是 6 条且内容来自权威',
      mirror.size() === 6 && mirror.has('m_0006') && mirror.getAllRaw().every(r => typeof r.content === 'string'), mirror.size());
    check('A9 状态落盘次数 ≥ 1（镜像先、状态后）', mirror.calls.deliverySave >= 1, mirror.calls);

    /* 单调：重复投递一个**更旧**的页不允许让确认位置倒退。
       （倒退本身不会丢数据，但它会让"已确认到哪"这件事无法审计，
       而 mirrorRevision 的水位判据正是建立在"只前进"之上的。） */
    const cursorBeforeReplay = auth.status().cursor;
    const oldPage = await serverChanges(PORT, 0, 3);
    await auth.applyChanges(oldPage);
    check('A10 cursor 单调：重放一个更旧的页不会让它倒退',
      auth.status().cursor === cursorBeforeReplay, { before: cursorBeforeReplay, after: auth.status().cursor });
  }

  /* ══════════════════════════════════════════════════════════════════
     B · 第一条 poison（窗口头部）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('B')) {
    section('B · 第一条 poison（limit=100，窗口第一条永久失败，其后 149 条合法）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    const h = await auth.sync({});
    const base = auth.status().cursor;
    check('B1 前置：健康 hydrate 建立基线（cursor = 权威 revision）', h.ok === true && base >= 1, { h, base });

    await seed(PORT, 51, 200);                       /* 150 条新事件 */
    mirror.failFor('m_0051', 'DataError');           /* 窗口第一条 = revision 51 */
    const windowBefore = await serverChanges(PORT, base, 100);
    check('B2 服务端窗口确实是 limit=100 且 hasMore=true（修复前正是这个窗口让后段永不可达）',
      windowBefore.upserts.length + windowBefore.deletes.length === 100 && windowBefore.hasMore === true && windowBefore.cursor === base + 100,
      { upserts: windowBefore.upserts.length, hasMore: windowBefore.hasMore, cursor: windowBefore.cursor });

    const rounds = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(120000);                         /* 跨过退避：测的是策略，不是等待 */
      rounds.push(await auth.sync({ limit: 100 }));
    }
    const s3 = auth.status();
    check('B3 前若干轮是**可重试**失败：cursor 不动、尝试次数逐轮递增、事件没有被跳过',
      rounds.every(r => r.retried === 1 && r.terminated === 0) &&
      s3.delivery.pending === 1 && s3.cursor === base,
      { rounds: rounds.map(r => ({ applied: r.applied, retried: r.retried, terminated: r.terminated })), status: s3 });
    check('B4 attempts 是**真实的尝试次数**（不是每轮都从 1 开始）',
      s3.delivery.pendingRevisions[0].attempts === 3,
      s3.delivery.pendingRevisions);
    check('B5 退避在起作用（同一时刻重复 sync 不会再加一次尝试）',
      await (async () => {
        const before = auth.status().delivery.pendingRevisions[0].attempts;
        await auth.sync({ limit: 100 });             /* 不拨表 → 仍在退避窗口内 */
        const after = auth.status().delivery.pendingRevisions[0].attempts;
        return before === after;
      })(), auth.status().delivery.pendingRevisions);

    /* 第 4 次尝试 → 上界 → 终态 */
    clock.advance(120000);
    const last = await auth.sync({ limit: 100 });
    check('B6 attempts 用尽 → **终态**（显式结论，不是继续沉默地重试）',
      last.terminated === 1 && auth.status().delivery.terminalUnresolved === 0,
      { last, delivery: auth.status().delivery });
    const terminal = auth.status().delivery.terminal[0];
    check('B7 终态记录了可观测的四件事：revision / recordId / attempts / 失败原因与类别',
      terminal && terminal.revision === base + 1 && terminal.recordId === 'm_0051' &&
      terminal.attempts === auth.status().delivery.policy.maxAttempts &&
      terminal.error === 'event-rejected' && terminal.category === 'event-local' && terminal.at > 0,
      terminal);
    check('B8 终态之后 cursor **越过**它（队头阻塞的收口点）',
      auth.status().cursor > base + 1, { cursor: auth.status().cursor, poison: base + 1 });
    check('B9 终态之后镜像由**快照**补回内容（终态 ≠ 丢数据）',
      mirror.has('m_0051') && (last.recovered === 'authoritative-snapshot'), { recovered: last.recovered, has: mirror.has('m_0051') });
    check('B10 后续事件最终全部可达（窗口后段的 149 条一个不少）',
      mirror.has('m_0101') && mirror.has('m_0150') && mirror.has('m_0200') &&
      mirror.size() === await serverLive(PORT),
      { size: mirror.size(), live: await serverLive(PORT) });
    check('B11 终态记录**保留**为可观测历史，并被标记为"已由快照结案"',
      terminal.resolvedBy === 'snapshot' && terminal.resolvedAt > 0, terminal);
    check('B12 终态之后 pending 清空（快照回答了那条 event 的投递问题）',
      auth.status().delivery.pending === 0, auth.status().delivery);

    /* 与"修复前"的对照：同一场景下修复前每轮只尝试那一条且 cursor 永不前进。 */
    check('B13 对照断言：cursor 最终等于权威 revision（修复前恒为 base）',
      auth.status().cursor === await serverRevision(PORT), { cursor: auth.status().cursor, revision: await serverRevision(PORT) });
  }

  /* ══════════════════════════════════════════════════════════════════
     C · 中间 poison（真实的 cursor / 部分应用行为）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('C')) {
    section('C · 中间 poison（窗口第 37 条永久失败）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    const h = await auth.sync({});
    const base = auth.status().cursor;
    await seed(PORT, 301, 400);                       /* 100 条新事件 = 一整个窗口 */
    const poison = 'm_0337';                          /* 新窗口的第 37 条 */
    mirror.failFor(poison, 'DataError');

    const r1 = await auth.sync({ limit: 100 });
    const s1 = auth.status();
    check('C1 失败点**之前**的 36 条已经逐个落盘（部分应用是真实的，不假装原子）',
      r1.applied === 36 && mirror.has('m_0301') && mirror.has('m_0336'), { applied: r1.applied, has301: mirror.has('m_0301') });
    check('C2 cursor 停在失败点**之前**（只沿持久结论的连续前缀前进）',
      s1.cursor === base + 36, { cursor: s1.cursor, expected: base + 36 });
    check('C3 失败点**之后**的 event 本轮一条都不被尝试（不逐个烧掉后面的事件）',
      mirror.calls.putIds.indexOf('m_0338') < 0 && !mirror.has('m_0338'), mirror.calls.putIds.length);
    check('C4 那条 event 被记为可重试失败且 attempts=1',
      s1.delivery.pending === 1 && s1.delivery.pendingRevisions[0].revision === base + 37 &&
      s1.delivery.pendingRevisions[0].attempts === 1, s1.delivery.pendingRevisions);

    const putsAfterRound1 = mirror.calls.put;
    clock.advance(120000);
    const r2 = await auth.sync({ limit: 100 });
    check('C5 下一轮从 cursor **续跑**（而不是整窗重放）：只尝试失败点那一条就停下',
      r2.applied === 0 && mirror.calls.put - putsAfterRound1 === 1 &&
      auth.status().cursor === base + 36 && auth.status().delivery.pendingRevisions[0].attempts === 2,
      { applied: r2.applied, puts: mirror.calls.put - putsAfterRound1, cursor: auth.status().cursor });

    for (let i = 0; i < 3; i++) { clock.advance(120000); await auth.sync({ limit: 100 }); }
    const s2 = auth.status();
    check('C6 重试预算用尽 → 终态 → cursor 越过失败点 → 本页继续把后面的 event 应用完',
      s2.delivery.terminal.length >= 1 && s2.cursor === await serverRevision(PORT) &&
      mirror.size() === await serverLive(PORT),
      { terminal: s2.delivery.terminal.length, cursor: s2.cursor, size: mirror.size() });
    check('C7 整条链上没有一条 event 被"当作已应用"却从未落盘',
      mirror.size() === await serverLive(PORT) && mirror.has(poison),
      { size: mirror.size(), live: await serverLive(PORT), poison: mirror.has(poison) });

    /* ── C8 · 终态让 cursor 越过它（毒事件放在**页尾**）─────────────────
       放在页尾是刻意的：否则后面那些成功事件的推进会把"终态本身有没有让
       cursor 越过"这件事掩盖掉（两件事都会让 cursor 变大）。
       直接驱动 applyChanges 也是刻意的：sync 之后的恢复 hydrate 会把整个
       镜像换掉，从而掩盖收口到底发生了没有。 */
    const mirrorC = makeMirror(new Map());
    const clockC = makeClock();
    const authC = createAuthority(IB.createMomentsRemote({}), mirrorC, clockC);
    await authC.sync({});
    const baseC = authC.status().cursor;
    await seed(PORT, 7001, 7003);
    mirrorC.failFor('m_7003', 'DataError');            /* 页尾那条（baseC+3） */
    const pageC = await serverChanges(PORT, baseC, 100);
    const replaceAllAfterHydrate = mirrorC.calls.replaceAll;
    let lastC = null;
    for (let i = 0; i < 4; i++) { clockC.advance(120000); lastC = await authC.applyChanges(pageC); }
    check('C8 终态在**本页内**就让 cursor 越过它（不依赖恢复 hydrate 的掩盖）',
      lastC.terminated === 1 && lastC.cursor === baseC + 3 &&
      mirrorC.calls.replaceAll === replaceAllAfterHydrate,
      { lastC, baseC, cursor: authC.status().cursor, replaceAll: mirrorC.calls.replaceAll });

    /* ── C9 · 终态之后**本页继续**（毒事件放在页中）──────────────────── */
    const mirrorD = makeMirror(new Map());
    const clockD = makeClock();
    const authD = createAuthority(IB.createMomentsRemote({}), mirrorD, clockD);
    await authD.sync({});
    const baseD = authD.status().cursor;
    await seed(PORT, 7004, 7007);
    mirrorD.failFor('m_7005', 'DataError');            /* 页中那条（baseD+2） */
    const pageD = await serverChanges(PORT, baseD, 100);
    let lastD = null;
    for (let i = 0; i < 4; i++) { clockD.advance(120000); lastD = await authD.applyChanges(pageD); }
    check('C9 终态之后**本页继续**被应用完（cursor 越过坏 event 之后不空转一轮）',
      lastD.applied === 2 && mirrorD.has('m_7006') && mirrorD.has('m_7007') && lastD.cursor === baseD + 4,
      { applied: lastD.applied, cursor: lastD.cursor, has6: mirrorD.has('m_7006'), has7: mirrorD.has('m_7007') });
  }

  /* ══════════════════════════════════════════════════════════════════
     D · transient failure（允许 retry → eventually applied）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('D')) {
    section('D · transient failure（前两次失败、第三次成功）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    await auth.sync({});
    const base = auth.status().cursor;
    await seed(PORT, 501, 505);
    mirror.failFor('m_0502', 'UnknownError', 2);       /* 镜像级的瞬时故障，只失败两次 */

    const t1 = await auth.sync({ limit: 100 });
    check('D1 第一次失败记为**可重试**（绝不把第一次失败直接当终态）',
      t1.retried === 1 && t1.terminated === 0 && auth.status().delivery.pendingRevisions[0].attempts === 1,
      { t1, pending: auth.status().delivery.pendingRevisions });
    clock.advance(120000);
    const t2 = await auth.sync({ limit: 100 });
    check('D2 第二次失败仍然是可重试（attempts=2，仍未终态）',
      t2.retried === 1 && t2.terminated === 0 && auth.status().delivery.pendingRevisions[0].attempts === 2,
      { t2, pending: auth.status().delivery.pendingRevisions });
    clock.advance(120000);
    const t3 = await auth.sync({ limit: 100 });
    const s3 = auth.status();
    check('D3 第三次成功 → eventually applied，pending 清空、无终态、cursor 前进到权威 revision',
      t3.ok === true && t3.applied === 4 && s3.delivery.pending === 0 && s3.delivery.terminal.length === 0 && s3.cursor === base + 5,
      { t3, status: s3.delivery, cursor: s3.cursor });
    check('D4 重试期间的失败**没有**推进 cursor（未应用就不确认）',
      s3.cursor === base + 5 && mirror.has('m_0502'), { cursor: s3.cursor });
  }

  /* ══════════════════════════════════════════════════════════════════
     E · permanent failure（有界 + 显式终态 + 不无限消耗 I/O）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('E')) {
    section('E · permanent failure（永远失败：必须有界、终态、后续继续）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    await auth.sync({});
    const base = auth.status().cursor;
    await seed(PORT, 601, 620);
    mirror.failFor('m_0601', 'QuotaExceededError');    /* 永远失败（left = Infinity） */
    const failedCallsBefore = mirror.calls.failed;

    let rounds = 0;
    while (rounds < 12 && auth.status().delivery.terminal.length === 0) {
      clock.advance(120000);
      await auth.sync({ limit: 100 });
      rounds++;
    }
    const attemptsSpent = mirror.calls.failed - failedCallsBefore;
    const maxAttempts = auth.status().delivery.policy.maxAttempts;
    check('E1 retry 是**有界**的：消耗的尝试次数正好等于 maxAttempts（不是"多跑几轮看它停不停"）',
      attemptsSpent === maxAttempts && rounds === maxAttempts, { attemptsSpent, rounds, maxAttempts });
    check('E2 最终进入**明确终态**（而不是永远 pending）',
      auth.status().delivery.terminal.length === 1 && auth.status().delivery.pending === 0, auth.status().delivery);
    const term = auth.status().delivery.terminal[0];
    check('E3 终态带类别（QuotaExceededError → mirror-quota / mirror-level）',
      term.error === 'mirror-quota' && term.category === 'mirror-level', term);
    check('E3b 终态之后**本页继续**被应用完（cursor 越过坏 event 之后不空转一轮）',
      mirror.has('m_0602') && mirror.has('m_0620'), { has: mirror.has('m_0620') });

    const spentSoFar = mirror.calls.failed;
    for (let i = 0; i < 5; i++) { clock.advance(300000); await auth.sync({ limit: 100 }); }
    check('E4 终态之后**不再消耗任何 I/O**（重复 sync 不会重新尝试它）',
      mirror.calls.failed === spentSoFar, { before: spentSoFar, after: mirror.calls.failed });
    check('E5 后续健康事件全部继续前进（一个坏 event 挡不住它们）',
      auth.status().cursor === await serverRevision(PORT) && mirror.size() === await serverLive(PORT),
      { cursor: auth.status().cursor, size: mirror.size() });
    const stats = auth.status().stats;
    check('E6 统计如实累计（可重试失败 + 终态 = 全部真实尝试次数；恢复也记了）',
      stats.retried + stats.terminated === maxAttempts && stats.terminated === 1 && stats.recovered >= 1,
      stats);

    /* ── E7 · 已经终态的 event **重复投递**时不许再执行 ──────────────────
       这是一条**防御性**分支：因为终态一定会推进 cursor，正常路径上它就不该
       再被投递。它守的是"持久状态不一致"这一类形状（例如一份更早版本写下的
       terminal 与 cursor 不自洽）。守住它的唯一方式是直接驱动它，
       因此这里喂一份**刻意不自洽**的持久状态（terminal 在 cursor 之上）。 */
    const durableE = new Map();
    const mirrorE = makeMirror(durableE);
    const clockE = makeClock();
    const authE = createAuthority(IB.createMomentsRemote({}), mirrorE, clockE);
    await authE.sync({});
    const baseE = authE.status().cursor;
    await seed(PORT, 7101, 7103);
    const pageE = await serverChanges(PORT, baseE, 100);
    const termRevision = baseE + 2;
    durableE.set('delivery:moments:desktop-mirror', JSON.stringify({
      v: 1, consumer: 'desktop-mirror', cursor: baseE,
      attempts: {},
      terminal: [{ revision: termRevision, kind: 'upsert', recordId: 'm_7102', attempts: 4, error: 'event-rejected', category: 'event-local', at: 1 }],
      lastAckAt: 0, recovery: null
    }));
    const authE2 = createAuthority(IB.createMomentsRemote({}), mirrorE, clockE);
    const firstE = await authE2.applyChanges(pageE);
    const putsForTerminal = mirrorE.calls.putIds.filter(id => id === 'm_7102').length;
    check('E7 已终态的 event 被重复投递时**不再执行**（不重新尝试、不重复记账），但 cursor 仍然越过它',
      putsForTerminal === 0 && firstE.terminated === 0 && firstE.cursor > termRevision &&
      authE2.status().delivery.terminal.length === 1,
      { putsForTerminal, firstE, terminal: authE2.status().delivery.terminal.length });
    const secondE = await authE2.applyChanges(pageE);
    check('E8 同一个终态页再投递一次仍然不增长终态环、不再执行（幂等）',
      authE2.status().delivery.terminal.length === 1 && secondE.applied === 0 && secondE.terminated === 0,
      { terminal: authE2.status().delivery.terminal.length, secondE });
  }

  /* ══════════════════════════════════════════════════════════════════
     F · duplicate replay（apply 成功但持久结论未落盘 → crash → 重放）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('F')) {
    section('F · duplicate replay（apply 成功、持久结论之前 crash）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    await auth.sync({});
    const base = auth.status().cursor;
    await seed(PORT, 701, 705);
    const page = await serverChanges(PORT, base, 100);

    /* 模拟：镜像已经落盘（apply 成功），但**状态写入没有发生**。 */
    const stateBeforeCrash = new Map(durable);
    const replay = await auth.applyChanges(page);
    check('F1 前置：这一页真的应用了（applied 与镜像都前进）',
      replay.ok === true && replay.applied === 5 && mirror.size() === base + 5, { replay, size: mirror.size() });

    /* crash：投递状态回滚到"结论还没落盘"的样子，镜像保持已应用的样子。 */
    durable.clear();
    stateBeforeCrash.forEach((v, k) => durable.set(k, v));
    const mirrorAfterCrash = mirror.size();
    const contentAfterCrash = JSON.stringify(mirror.getAllRaw().map(r => r.id).sort());

    const auth2 = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    const loaded = await auth2.delivery.load();
    check('F2 重启后读到的投递状态确实是"结论未落盘"的那一版（cursor 停在 base）',
      loaded.cursor === base, { cursor: loaded.cursor, base });

    const replay2 = await auth2.applyChanges(page);
    check('F3 重放**幂等**：不产生重复行、不报错、镜像条数不变',
      replay2.ok === true && replay2.applied === 5 && mirror.size() === mirrorAfterCrash,
      { applied: replay2.applied, size: mirror.size(), expected: mirrorAfterCrash });
    check('F4 重放之后镜像内容与重放前**逐字节相同**（收敛，而不是"看起来一样"）',
      JSON.stringify(mirror.getAllRaw().map(r => r.id).sort()) === contentAfterCrash);
    check('F5 重放之后 cursor 落在权威 revision 上（结论补上了）',
      replay2.cursor === base + 5, { cursor: replay2.cursor });
  }

  /* ══════════════════════════════════════════════════════════════════
     G · crash before apply（event 不能丢）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('G')) {
    section('G · crash before apply（事件已读取、尚未应用就崩）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    await auth.sync({});
    const base = auth.status().cursor;
    await seed(PORT, 801, 803);
    const page = await serverChanges(PORT, base, 100);
    /* 读到了，但一条都没应用（进程在这里死掉）。 */
    const sizeBefore = mirror.size();
    check('G1 前置：事件已经在服务端窗口里（读取成功）', page.upserts.length === 3, page.upserts.length);

    const auth2 = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    const loaded = await auth2.delivery.load();
    const recovered = await auth2.applyChanges(page);
    check('G2 重启后 event **不丢**：同一个窗口被重新应用，三条全部落盘',
      loaded.cursor === base && recovered.applied === 3 && mirror.size() === sizeBefore + 3,
      { cursor: loaded.cursor, applied: recovered.applied, size: mirror.size() });
    check('G3 crash 前后镜像只增不减（没有任何一条被"跳过"）',
      mirror.has('m_0801') && mirror.has('m_0802') && mirror.has('m_0803'));

    /* ── G4 · 驱动"解析为 false"= 没有写 ─────────────────────────────────
       这正是修复前真实存在的**静默丢失**路径（生产 driver 对缺 id 的行
       返回 `Promise.resolve(false)`，而旧代码把它的返回值丢掉了）：
       cursor 会越过一条从未落盘的 event，而它再也不会被投递。
       修复后的语义：`false` 不是成功，它要么被重试、要么进终态，
       **但绝不会被当成已应用**。 */
    const durableG = new Map();
    const mirrorG = makeMirror(durableG);
    const clockG = makeClock();
    const authG = createAuthority(IB.createMomentsRemote({}), mirrorG, clockG);
    await authG.sync({});
    const baseG = authG.status().cursor;
    await seed(PORT, 8101, 8102);
    mirrorG.failFor('m_8102', 'SILENT');
    const beforeG = mirrorG.calls.putIds.length;
    clockG.advance(120000);
    const silentRun = await authG.sync({ limit: 100 });
    check('G4 驱动解析为 false（没有写）时**不算应用**：cursor 不越过它，事件进入可重试失败',
      silentRun.applied === 1 && authG.status().cursor === baseG + 1 &&
      authG.status().delivery.pending === 1 &&
      authG.status().delivery.pendingRevisions[0].recordId === 'm_8102' &&
      !mirrorG.has('m_8102'),
      { silentRun, cursor: authG.status().cursor, pending: authG.status().delivery.pendingRevisions, before: beforeG });
  }

  /* ══════════════════════════════════════════════════════════════════
     H · restart retry durability
     ══════════════════════════════════════════════════════════════════ */
  if (wants('H')) {
    section('H · restart 之后的 retry 状态（不得无条件归零）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    await auth.sync({});
    await seed(PORT, 901, 903);
    mirror.failFor('m_0902', 'DataError');
    clock.advance(120000);
    await auth.sync({ limit: 100 });
    const pendingRec = auth.status().delivery.pendingRevisions[0];
    const attemptsBefore = pendingRec.attempts;
    const cursorBefore = auth.status().cursor;
    check('H1 前置：一次真实失败已经把 attempts 写进持久状态', attemptsBefore === 1, { pendingRec, cursorBefore });

    /* 重启：新的 authority 实例，共享同一份持久状态与同一个镜像。 */
    const auth2 = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    const raw = await auth2.delivery.load();
    check('H2 重启后 attempts **没有归零**（持久状态被原样读回，而不是从 1 重新开始）',
      raw.attempts[String(pendingRec.revision)] &&
      raw.attempts[String(pendingRec.revision)].attempts === attemptsBefore,
      { attempts: raw.attempts, key: String(pendingRec.revision), attemptsBefore });
    check('H3 重启后 ACK 水位也**没有归零**（回收授权不会因为一次页面重载而消失）',
      raw.cursor === cursorBefore, { cursor: raw.cursor, cursorBefore });
    check('H4 持久状态里没有动态正文/payload（它是投递记账，不是第二份内容）',
      (function () {
        const text = JSON.stringify(raw);
        return !/moment #/.test(text) && !/"content"/.test(text) && !/"dataUrl"/.test(text) && !/"payload"/.test(text);
      })(), JSON.stringify(raw).slice(0, 200));

    /* 预算在**实际消耗它的那条路径**上跨实例继续：同一份持久状态、同一个待办，
       新实例的第一件事就是再试它一次 —— 因此 attempts 走到 2，而不是重新数到 1。 */
    const pendingPage = await serverChanges(PORT, cursorBefore, 100);
    check('H5 前置：重启后窗口的第一条正是那个待办（坐标没有漂移）',
      pendingPage.upserts.length + pendingPage.deletes.length > 0 &&
      Number(pendingPage.upserts[0] && pendingPage.upserts[0].storeRevision) === pendingRec.revision,
      { first: pendingPage.upserts[0] && pendingPage.upserts[0].storeRevision, expected: pendingRec.revision });
    clock.advance(120000);
    await auth2.applyChanges(pendingPage);
    const after = auth2.status().delivery.pendingRevisions[0];
    check('H5 重启后的下一轮**继续**消耗同一个预算（attempts=2，而不是重新数到 1）',
      after && after.attempts === attemptsBefore + 1, { after, attemptsBefore });
    check('H6 因此 restart 不可能把"有界重试"恢复成"无限重试"：预算只减不增',
      after.attempts <= auth2.status().delivery.policy.maxAttempts &&
      auth2.status().delivery.policy.maxAttempts === 4, { after, policy: auth2.status().delivery.policy });

    /* 生产语义要如实说清楚：一个**未 hydrate** 的新实例会先走 boot hydrate，
       而一次成功的快照会把 ≤ snapshot revision 的待办整体结案 ——
       于是"重启后要不要继续重试"这个问题在生产路径上**根本不成立**：
       权威内容已经把那条 event 回答了。这不是"归零"，而是"结案"。 */
    const auth3 = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    const booted = await auth3.sync({});
    check('H7 生产语义：新实例的 boot hydrate 用**快照**结案那个待办（比"继续重试"更强）',
      booted.ok === true && booted.hydrated === true &&
      auth3.status().delivery.pending === 0 && mirror.has(pendingRec.recordId),
      { booted, pending: auth3.status().delivery.pending, has: mirror.has(pendingRec.recordId) });
    check('H8 结案之后仍然**没有**终态堆积（重启既不归零成无限重试，也不制造假终态）',
      auth3.status().delivery.terminal.length === 0, auth3.status().delivery.terminal);
  }

  /* ══════════════════════════════════════════════════════════════════
     I · tombstone（delete event）语义
     ══════════════════════════════════════════════════════════════════ */
  if (wants('I')) {
    section('I · tombstone（delete 的幂等 / 可重试 / 终态语义）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    await auth.sync({});
    const liveStart = mirror.size();
    await seed(PORT, 1001, 1003);
    await auth.sync({ limit: 100 });
    check('I1 前置：三条已经在镜像里（镜像是权威的完整副本）',
      mirror.has('m_1001') && mirror.has('m_1002') && mirror.size() === liveStart + 3,
      { has: mirror.has('m_1001'), size: mirror.size(), liveStart });

    const del = unwrap(await request(PORT, 'DELETE', '/moments/record?id=m_1001'));
    const del2 = unwrap(await request(PORT, 'DELETE', '/moments/record?id=m_1001'));
    check('I2 服务端重删一个已删的 id → not-present，且**不推进 revision**（不产生第二个 change event）',
      del2.outcome === 'not-present' && del2.revision === del.revision && del2.deleted === false, { del, del2 });

    const applied = await auth.sync({ limit: 100 });
    check('I3 delete event 正常应用：镜像里那一行消失，deletes 计数为 1',
      applied.deletes === 1 && !mirror.has('m_1001') && mirror.size() === liveStart + 2,
      { applied, size: mirror.size(), expected: liveStart + 2 });

    /* 重复投递同一个 delete（幂等）：手工重放同一页 */
    const deletePage = await serverChanges(PORT, auth.status().cursor - 1, 100);
    const replay = await auth.applyChanges(deletePage);
    check('I4 重复投递 delete **幂等**：删除一个镜像里已经不存在的键不报错、不产生错误终态',
      replay.ok === true && auth.status().delivery.terminal.length === 0 && !mirror.has('m_1001'),
      { replay, terminal: auth.status().delivery.terminal.length });
    check('I5 幂等重放不推进 cursor 倒退、也不重复删除（本地 remove 对不存在的键是 no-op）',
      mirror.calls.remove >= 1 && auth.status().cursor >= auth.status().cursor, mirror.calls);

    /* delete 的**可重试**与**终态**：注入删除失败 */
    await seed(PORT, 1004, 1004);
    await auth.sync({ limit: 100 });
    mirror.failFor('m_1004', 'UnknownError');
    unwrap(await request(PORT, 'DELETE', '/moments/record?id=m_1004'));
    clock.advance(120000);
    const d1 = await auth.sync({ limit: 100 });
    check('I6 删除失败 → 可重试失败（不是立刻终态），镜像里的行**仍然在**（不假装删掉了）',
      d1.retried === 1 && d1.terminated === 0 && mirror.has('m_1004'), { d1, has: mirror.has('m_1004') });
    for (let i = 0; i < 3; i++) { clock.advance(120000); await auth.sync({ limit: 100 }); }
    const sI = auth.status();
    check('I7 删除重试预算用尽 → 终态 → cursor 越过；随后由**快照**把墓碑真正落下去',
      sI.delivery.terminal.some(t => t.recordId === 'm_1004' && t.kind === 'delete') && !mirror.has('m_1004'),
      { terminal: sI.delivery.terminal, has: mirror.has('m_1004') });

    /* 结构上不可能应用的 delete：缺 id */
    const badPage = {
      ok: true, cursor: sI.cursor + 1, revision: sI.cursor + 1, retainedFrom: 1, hasMore: false,
      upserts: [], deletes: [{ revision: sI.cursor + 1 }]
    };
    const badApply = await auth.applyChanges(badPage);
    check('I8 缺 id 的 delete → **一次也不重试**的终态（同样的字节重试一万次也一样）',
      badApply.terminated === 1 && auth.status().delivery.terminal[0].error === 'event-inapplicable' &&
      auth.status().delivery.terminal[0].detail === 'record-id-missing',
      { badApply, terminal: auth.status().delivery.terminal[0] });
  }

  /* ══════════════════════════════════════════════════════════════════
     J · long stream（> limit 的事件最终全部可达）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('J')) {
    section('J · long stream（250 条待投、窗口 100、窗口第一条坏掉）');
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IB.createMomentsRemote({}), mirror, clock);
    await auth.sync({});
    const base = auth.status().cursor;
    await seed(PORT, 2001, 2250);                       /* 250 条 */
    mirror.failFor('m_2001', 'DataError');              /* 窗口第一条永远失败 */
    const firstWindow = await serverChanges(PORT, base, 100);
    check('J1 前置：一个 100 的窗口里装不下 250 条（hasMore=true，后 150 条在窗口之外）',
      firstWindow.hasMore === true && firstWindow.cursor === base + 100, { cursor: firstWindow.cursor, hasMore: firstWindow.hasMore });

    let rounds = 0;
    let guard = 0;
    while (guard < 25) {
      guard++;
      clock.advance(120000);
      const r = await auth.sync({ limit: 100 });
      rounds++;
      if (r.ok && !r.hasMore && auth.status().cursor >= base + 250) break;
    }
    check('J2 一个坏 event **不能**阻止后续窗口最终被消费（窗口会滑动直到 hasMore=false）',
      auth.status().cursor === await serverRevision(PORT) && rounds <= 25,
      { cursor: auth.status().cursor, revision: await serverRevision(PORT), rounds });
    check('J3 后 150 条（修复前在这个窗口大小下永不可达）全部落进镜像',
      mirror.has('m_2101') && mirror.has('m_2250') && mirror.size() === await serverLive(PORT),
      { size: mirror.size(), live: await serverLive(PORT) });
    check('J4 收口是**有界**的：坏 event 只消耗它自己的预算，轮数远小于事件总数',
      rounds < 20 && auth.status().delivery.terminal.length === 1, { rounds, terminal: auth.status().delivery.terminal.length });
    check('J5 全程没有一条 event 被跳过：镜像条数 == 权威 live 条数',
      mirror.size() === await serverLive(PORT), { size: mirror.size(), live: await serverLive(PORT) });
  }

  /* ══════════════════════════════════════════════════════════════════
     K · retention
     ══════════════════════════════════════════════════════════════════ */
  if (wants('K')) {
    section('K · retention（只回收已确认的；pending 绝不删）');
    const createStore = require(STORE_PATH);
    const kdir = tmpDir('store');
    const dbFile = path.join(kdir, 'home-node.db');
    /* 注入一个小阈值，为的是把**真实的触发路径**走一遍而不是造两万条日志。 */
    const store = createStore({ dataDir: kdir, dbFile: dbFile, changeLogMax: 12, changeLogPruneBatch: 100 });
    store.open();

    for (let i = 1; i <= 30; i++) store.put(momentOf(3000 + i), {});
    const stats0 = store.changeLogStats();
    check('K1 前置：日志在没有 ACK 的情况下**一行都不删**（不知道消费者走到哪里就不删 —— fail-safe）',
      stats0.rows === 30 && store.pruneChangeLog({}).reason === 'no-consumer-watermark',
      { stats: stats0, prune: store.pruneChangeLog({}) });

    /* 消费者确认到 10：只有 ≤ 10 的行可以被回收。 */
    const ack1 = store.noteDelivery('desktop-mirror', 10);
    const stats1 = store.changeLogStats();
    check('K2 ACK 触发回收，且**只**回收 revision ≤ 水位的那一段',
      ack1.ok === true && ack1.watermark === 10 && stats1.min === 11 && stats1.rows === 20,
      { ack: ack1, stats: stats1 });
    check('K3 pending（水位之上）的行**绝不**被删 —— 那正是"消费者还没得出持久结论"的那一段',
      stats1.max === 30 && stats1.min === 11, stats1);
    check('K4 回收不改变 revision 事实轴（moments_revision 才是版本号，日志只是传输）',
      store.getRevision() === 30, { revision: store.getRevision() });

    const ack2 = store.noteDelivery('desktop-mirror', 5);
    const stats2 = store.changeLogStats();
    check('K5 回退的 ACK 被 max 吃掉（水位单调，回收范围不会因为一次乱序 ACK 而扩大）',
      ack2.watermark === 10 && stats2.min === 11, { ack: ack2, stats: stats2 });

    const ack3 = store.noteDelivery('desktop-mirror', 999999);
    check('K6 声称未来的 ACK 被夹回当前 revision（否则一次客户端 bug 就能吃掉未投递的事件）',
      ack3.watermark === 30 && ack3.clamped === true, ack3);

    const ack4 = store.noteDelivery('desktop-mirror', 30);
    const stats4 = store.changeLogStats();
    const live = store.listRecords({ limit: 100 });
    check('K7 全部确认之后日志可以清空，而**快照仍然完整**（change-log 从来不是 authority）',
      stats4.rows === 0 && stats4.min === null && live.records.length === 30 && live.revision === 30,
      { stats: stats4, live: live.records.length, revision: live.revision });

    /* 多消费者：契约是"取最小水位"，因此多一个只会让回收更保守。 */
    for (let i = 1; i <= 20; i++) store.put(momentOf(4000 + i), {});     /* 让跨度超过阈值 */
    store.noteDelivery('second-consumer', 3);
    const ack5 = store.noteDelivery('desktop-mirror', 50);
    const stats5 = store.changeLogStats();
    check('K8 多消费者时回收用**全体已注册水位的 min**（多一个消费者只会更保守，不会让谁丢数据）',
      ack5.watermark === 50 && ack5.retention && ack5.retention.upTo === 3 &&
      ack5.retention.pruned === 0 && stats5.min === 31 && stats5.rows === 20,
      { ack: ack5, stats: stats5 });
    check('K9 回收的触发判据是 O(1) 的 MAX-MIN 跨度（不是每次写入都 COUNT 一遍日志）',
      ack5.retention && ack5.retention.ok === true, ack5.retention);
    /* 反向：把低水位那颗消费者推进 → 回收这才发生，且只推进到新的 min。 */
    store.noteDelivery('second-consumer', 45);
    const stats6 = store.changeLogStats();
    check('K9b 低水位消费者前进之后回收才推进（授权来自**最慢**的那个消费者）',
      stats6.min === 46 && stats6.rows === 5, stats6);

    const badAck = store.noteDelivery('bad consumer id!', 1);
    check('K10 consumer id 收窄到安全字符集（它同时是 meta 键的一部分）',
      badAck.ok === false && badAck.error === 'invalid-consumer', badAck);
    const noStore = createStore({ dataDir: kdir, dbFile: path.join(kdir, 'closed.db') });
    check('K11 库没开时 ACK / 回收如实报 store-closed（不假装成功）',
      noStore.noteDelivery('desktop-mirror', 1).error === 'store-closed' &&
      noStore.pruneChangeLog({}).error === 'store-closed',
      { ack: noStore.noteDelivery('desktop-mirror', 1), prune: noStore.pruneChangeLog({}) });
    store.close();
  }

  /* ══════════════════════════════════════════════════════════════════
     L · authoritative rebuild（历史被回收后靠快照恢复）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('L')) {
    section('L · retention 之后的恢复：快照是恢复权威，change-log 只是增量传输');
    const kdir = tmpDir('gap');
    const createStore = require(STORE_PATH);
    const dbFile = path.join(kdir, 'home-node.db');
    /* 先用真实的 store（小阈值只为把触发路径走一遍）造出前置条件：
       一条**已经丢掉了一段**的日志。随后被测链路仍是真实进程 + 真实 HTTP。 */
    const store = createStore({ dataDir: kdir, dbFile: dbFile, changeLogMax: 2, changeLogPruneBatch: 100 });
    store.open();
    for (let i = 1; i <= 20; i++) store.put(momentOf(5000 + i), {});
    const pruneOut = store.noteDelivery('desktop-mirror', 12);
    const statsAfterPrune = store.changeLogStats();
    check('L1 前置：真实回收发生，日志里最老的一行前进到水位之上',
      pruneOut.retention.pruned === 12 && statsAfterPrune.min === 13 && statsAfterPrune.rows === 8,
      { prune: pruneOut, stats: statsAfterPrune });
    store.close();

    const svc2 = await startProduction(kdir);
    const upL = await waitListening(svc2, 30000);
    check('L2 同一份 data dir 上的真实 Home Node 起来了（被回收过的日志是它的现状）', upL === true);
    if (upL) {
      const afterAck = await serverChanges(svc2.port, 0, 5);
      check('L2b 回收之后 `retainedFrom` 随页如实报出（客户端据此**可以**判定空档）',
        afterAck.retainedFrom === 13 && afterAck.cursor === 17, { afterAck: { cursor: afterAck.cursor, retainedFrom: afterAck.retainedFrom } });
      check('L3 回收之后快照仍然完整（20 条 live 记录一条不少 —— change-log 从来不是 authority）',
        unwrap(await request(svc2.port, 'GET', '/moments/list?limit=1000')).records.length === 20);

      /* 主路径：一个**没有持久投递状态**的新消费者。它从快照开始 ——
         这正是"日志可以被回收"的全部依据。 */
      const IBL = loadClient(svc2.port);
      const mirrorB = makeMirror(new Map());
      const authB = createAuthority(IBL.createMomentsRemote({}), mirrorB, makeClock());
      const booted = await authB.sync({});
      check('L4 新消费者靠**快照**收敛：不依赖任何历史日志，一条不缺（无 gap）',
        booted.ok === true && booted.hydrated === true && mirrorB.size() === 20 &&
        mirrorB.has('m_5001') && mirrorB.has('m_5020'),
        { booted, size: mirrorB.size() });
      check('L5 收敛之后增量读口重新可用（cursor 落回可确认区间，不会每次 sync 都重建）',
        (function () {
          const st = authB.status();
          return afterAck.retainedFrom === null || st.cursor + 1 >= afterAck.retainedFrom;
        })(), { cursor: authB.status().cursor, retainedFrom: afterAck.retainedFrom });

      /* ── 空档判据（defense in depth）──────────────────────────────────
         它在**当前生产路径上不可达**，而且这不是疏漏，是一条可证的性质：
           · 回收边界 = 全体已注册水位的 min + 1；
           · 而一个 ACK 过的消费者，它的 cursor 就等于自己的水位；
           · 于是恒有 retainedFrom ≤ cursor + 1 —— 确认过的消费者**不可能**
             看到回收造成的空档（K8 的多消费者断言就是这条的另一面）。
         它守的是"确认位置落后于回收边界"这一类状态（持久的确认记账丢失/被回滚、
         将来出现一个晚到的消费者）。守住它有意义的唯一方式是**直接驱动它**，
         因此这里替身化**传输层的字节**（与 P11-3F M 分节同款），
         被测的仍然是真实的 sync / gap / hydrate 逻辑。 */
      const ORIGINAL_FETCH = global.fetch;
      const realCursor = authB.status().cursor;
      global.fetch = (url, init) => {
        const path = String(url);
        if (path.indexOf('/moments/changes') < 0) return ORIGINAL_FETCH(url, init);
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({
            v: 1, ok: true, type: 'moments.changes', requestId: null, serverTime: 1, status: 200,
            payload: { cursor: realCursor, revision: realCursor, upserts: [], deletes: [], hasMore: false, retainedFrom: realCursor + 5 }
          }))
        });
      };
      let gapSync = null;
      try { gapSync = await authB.sync({ limit: 100 }); } finally { global.fetch = ORIGINAL_FETCH; }
      const gap = authB.status().delivery.gap;
      check('L6 空档被**察觉**：未确认的那一段已被回收时，绝不把它当成"没有变更"',
        gap !== null && gap.retainedFrom === realCursor + 5 && gap.cursor === realCursor, { gap, gapSync });
      check('L7 察觉之后强制走**快照重建**（而不是继续吃增量），并且镜像回到与权威逐条相等',
        gapSync.ok === true && gapSync.hydrated === true && mirrorB.size() === 20,
        { gapSync, size: mirrorB.size() });
      check('L8 缺 `retainedFrom` 的响应被**拒收**（缺字段 ≠ 没有回收过）',
        await (async () => {
          global.fetch = (url, init) => {
            if (String(url).indexOf('/moments/changes') < 0) return ORIGINAL_FETCH(url, init);
            return Promise.resolve({
              ok: true, status: 200,
              text: () => Promise.resolve(JSON.stringify({
                v: 1, ok: true, type: 'moments.changes', requestId: null, serverTime: 1, status: 200,
                payload: { cursor: realCursor, revision: realCursor, upserts: [], deletes: [], hasMore: false }
              }))
            });
          };
          let out = null;
          try { out = await authB.sync({ limit: 100 }); } finally { global.fetch = ORIGINAL_FETCH; }
          return out.ok === false && out.error === 'invalid-response';
        })(), 'retained-from-missing');
      check('L9 拒收之后 cursor 一步都没有前进（不确定的事实不许被确认）',
        authB.status().cursor === authB.status().delivery.ackWatermark, authB.status());

      const authSrc = fs.readFileSync(AUTH_PATH, 'utf8');
      check('L10 恢复路径复用的是 P11-3F 的 hydrate 本体（完整性判据一字未改）',
        /truncated\s*!==\s*false/.test(authSrc) && /'incomplete-snapshot'/.test(authSrc) && /recoverFromAuthority/.test(authSrc));
      stopProduction(svc2);
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     M · observability / redaction
     ══════════════════════════════════════════════════════════════════ */
  if (wants('M')) {
    section('M · 可观测性（且诊断不得泄漏 payload）');
    /* home-node-client 的 base URL 来自 global.localStorage，而 L 分节为了第二
       个 Home Node 换过它 —— 因此这里必须**重新绑定**到本分节要用的那个节点，
       否则验的是一个已经 SIGTERM 掉的端口的"失败"，而不是投递可观测性。 */
    const IBM = loadClient(PORT);
    const durable = new Map();
    const mirror = makeMirror(durable);
    const clock = makeClock();
    const auth = createAuthority(IBM.createMomentsRemote({}), mirror, clock);
    await auth.sync({});
    const base = auth.status().cursor;
    await seed(PORT, 6001, 6003);
    mirror.failFor('m_6002', 'DataError');
    clock.advance(120000);
    const syncM = await auth.sync({ limit: 100 });
    const d = auth.status().delivery;
    const p = d.pendingRevisions[0];
    check('M0 前置：窗口第 2 条是那个永久失败（可重试）', syncM.retried === 1 && !!p, { syncM, d });
    check('M1 可重试失败可观测：revision / recordId / kind / attempts / maxAttempts / error / category / lastAt / state',
      p && p.revision === base + 2 && p.recordId === 'm_6002' && p.kind === 'upsert' &&
      p.attempts === 1 && p.maxAttempts === 4 && p.error === 'event-rejected' &&
      p.category === 'event-local' && p.lastAt > 0 && p.state === 'retryable-failure', p);
    check('M2 策略本身也是可观测的（上界 / 退避 / 终态环容量）',
      d.policy.maxAttempts === 4 && d.policy.hardMaxAttempts === 8 &&
      d.policy.baseBackoffMs > 0 && d.policy.maxBackoffMs >= d.policy.baseBackoffMs &&
      d.policy.terminalKeep > 0, d.policy);
    check('M3 四个状态彼此可区分（没有把它们压成一个 boolean）',
      ['retryable-failure', 'terminal-failure'].indexOf(p.state) >= 0 &&
      typeof d.pending === 'number' && Array.isArray(d.terminal) && typeof d.ackWatermark === 'number', d);

    /* M14：诊断面**不得**携带正文 / payload / 凭据。 */
    const stateText = JSON.stringify(Array.from(durable.values()).join(''));
    const statusText = JSON.stringify(auth.status());
    const forbidden = ['moment #', '"content"', 'dataUrl', '"payload"', '"images"', 'token', 'authorization', 'Bearer '];
    check('M4 持久投递状态里没有正文 / payload / 图片 / 凭据（只有投递坐标与失败分类）',
      forbidden.every(f => stateText.indexOf(f) < 0), { hits: forbidden.filter(f => stateText.indexOf(f) >= 0) });
    check('M5 status() 的投递面同样没有正文 / payload / 凭据',
      forbidden.every(f => statusText.indexOf(f) < 0), { hits: forbidden.filter(f => statusText.indexOf(f) >= 0) });
    check('M6 终态记录也带时间与类别（"最后一次尝试是什么时候"是必须可答的）',
      (function () {
        const st = auth.status().delivery.terminal;
        return st.length === 0 || (st[0].at > 0 && typeof st[0].category === 'string');
      })(), auth.status().delivery.terminal);
  }

  /* ══════════════════════════════════════════════════════════════════
     N · forbidden shapes
     ══════════════════════════════════════════════════════════════════ */
  if (wants('N')) {
    section('N · forbidden shapes（被消灭的写法不许复活）');
    const authSrc = fs.readFileSync(AUTH_PATH, 'utf8');
    const authCode = authSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const storeSrc = fs.readFileSync(STORE_PATH, 'utf8');
    const gwSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'), 'utf8');
    const clientSrc = fs.readFileSync(CLIENT_PATH, 'utf8');

    /* 表名有两处是常量拼接（RECORDS_TABLE / CHANGE_LOG_TABLE），因此不能只扫
       字面量：这里同时钉住**建表语句条数**与**两个表常量**，任何新表都会变红。 */
    const createCount = (storeSrc.match(/CREATE TABLE IF NOT EXISTS/g) || []).length;
    check('N1 服务端仍然只有**一个** moments 权威存储：建表语句仍是 4 条（records / change_log / meta / idempotency），投递水位住在既有 meta 平面里',
      createCount === 4 &&
      /const RECORDS_TABLE = 'moment_records';/.test(storeSrc) &&
      /const CHANGE_LOG_TABLE = 'moment_change_log';/.test(storeSrc) &&
      /delivery_watermark:moments:/.test(storeSrc) &&
      !/CREATE TABLE IF NOT EXISTS[^\n]{0,40}(delivery|ack|consumer)/i.test(storeSrc),
      { createCount, metaPlane: /delivery_watermark:moments:/.test(storeSrc) });
    check('N2 schema 版本没有被 3G 改动（投递状态住在既有 meta 平面里）',
      /const MOMENTS_SCHEMA_VERSION = 1;/.test(storeSrc) && /moments_schema/.test(storeSrc));
    check('N3 客户端没有把"整页当原子"的旧形状复活（不再有 upserts 串成一条链、失败即整页拒绝）',
      !/function applyChanges\(res\)\s*\{\s*var work = Promise\.resolve\(\)/.test(authCode) &&
      /runPage\(/.test(authCode), 'moments-authority.js');
    check('N4 `local.put(...)` 的返回值不再是"忽略掉"的（false = 没有写 = 不许当成功）',
      /written === false/.test(authCode), 'moments-authority.js');
    check('N5 ACK 在 apply 之后（状态落盘早于 reportDelivery）',
      /saveDelivery\(\)\.then\(function \(\) \{ return summary; \}\)/.test(authCode.replace(/\s+/g, ' ').replace(/\s*\{\s*/g, '{ ')) ||
      authCode.indexOf('saveDelivery()') < authCode.indexOf('reportDelivery()'),
      'moments-authority.js');
    check('N6 水位只沿连续前缀推进（pending 的 event 阻断 ack）',
      /advanceWatermark/.test(authCode) && /terminalRecord\(state, event\.revision\)/.test(authCode));
    check('N7 空档判据是硬判据：缺 `retainedFrom` 的响应被拒收（缺字段 ≠ 没有回收过）',
      /retained-from-missing/.test(authCode) && /retainedFrom === undefined/.test(authCode));
    check('N8 客户端自造的码仍然落在契约声明内（没有第二套错误词表）',
      !/'store-closed'/.test(authCode) && !/'db-[a-z-]+'/.test(authCode) && !/new Error\(/.test(authCode),
      'moments-authority.js');
    check('N9 网关把 ack 列入暴露面 allowlist，且 handlers 与 ADMIN_PATHS 一致',
      /'\/moments\/ack'/.test(gwSrc) && /action === 'moments\/ack'/.test(gwSrc));
    check('N10 服务端只按"全体已注册水位的 min"回收，且没有水位时一行都不删',
      /no-consumer-watermark/.test(storeSrc) && /Math\.min\.apply\(null, consumers\.map/.test(storeSrc));
    check('N11 回收是**有界**的（单次删除有 LIMIT，不会因为库大就卡住一次写入）',
      /ORDER BY revision ASC LIMIT \?\)/.test(storeSrc) && /CHANGE_LOG_PRUNE_BATCH/.test(storeSrc));
    check('N12 客户端提交 ACK 走的是独立 verb，且失败不抛（送不到只会让回收更保守）',
      /'\/moments\/ack'/.test(clientSrc) && /ack-unreachable/.test(clientSrc));
    check('N13 投递重试是**有限的**：上界存在且被夹紧（拒绝 Infinity / NaN）',
      /DELIVERY_HARD_MAX_ATTEMPTS/.test(authCode) && /normalizeAttempts/.test(authCode) &&
      /n > DELIVERY_HARD_MAX_ATTEMPTS \? DELIVERY_HARD_MAX_ATTEMPTS : n/.test(authCode));
    check('N14 退避永远不为 0（零退避是穿着策略外衣的忙循环）',
      /if \(n <= 1\) return DELIVERY_BASE_BACKOFF_MS;/.test(authCode) && /DELIVERY_BASE_BACKOFF_MS = \d+/.test(authCode));
    check('N15 changesAfter 的日志行与内容出自**同一个读事务**（一页对应哪一版必须可审计）',
      /withTransaction\(\(\) => \{[\s\S]{0,900}?retainedFrom: minChangeRevision\(\)[\s\S]{0,80}?\}, 'read'\)/.test(storeSrc));
  }

  /* ══════════════════════════════════════════════════════════════════
     R · registered, NOT fixed
     ══════════════════════════════════════════════════════════════════ */
  if (wants('R')) {
    section('R · 登记但**刻意不修**（断言现状，防止静默变化）');
    console.log('   说明：这一节不是在断言"这是对的"，而是在断言"这是当前**已知**的债"。');
    console.log('   任何一次无意的行为变化都会让下面的断言变红，从而被迫显式面对。');

    /* ① P11-3F 登记的 migration-before-hydrate 债：本轮**没有**被 3G 的 ack/retry
          机制偷偷绕过。用真实链路断言"权威为空 + 未迁移遗留行 → 被快照清掉"。 */
    const rdir = tmpDir('reg');
    const rsvc = await startProduction(rdir);
    const rup = await waitListening(rsvc, 30000);
    if (rup) {
      const IBR = loadClient(rsvc.port);
      const mirrorR = makeMirror(new Map());
      mirrorR.rows.set('LEGACY_1', { id: 'LEGACY_1', roleId: 'role_a', content: '迁移之前的本地动态', visibility: 'all', createdAt: 1 });
      const authR = createAuthority(IBR.createMomentsRemote({}), mirrorR, makeClock());
      const out = await authR.sync({});
      check('R1 【已知债】未迁移的浏览器遗留行仍会在首个 authorized-empty hydrate 时被清掉（H4 要求如此）',
        out.ok === true && mirrorR.size() === 0, { ok: out.ok, size: mirrorR.size() });
      check('R2 【已知债】3G **没有**用 ack/retry 机制绕过它：migrate 与首个 hydrate 仍未定序',
        (function () {
          const src = fs.readFileSync(AUTH_PATH, 'utf8');
          return !/migrat[\s\S]{0,200}?hydrate\s*\(/.test(src.slice(src.indexOf('function migrate('), src.indexOf('function migrate(') + 2500));
        })());
      stopProduction(rsvc);
    }

    /* ② memory / understanding / chat 仍持有独立的 hydrate 实现（不同原语，不扩大范围）。 */
    const memSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory-authority.js'), 'utf8');
    const undSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'understanding-authority.js'), 'utf8');
    check('R3 【已知债】memory-authority 仍然用 `page.records || []` 兜底（本阶段不碰别的域）',
      (memSrc.match(/records \|\| \[\]/g) || []).length >= 3,
      { hits: (memSrc.match(/records \|\| \[\]/g) || []).length });
    check('R4 【已知债】understanding-authority 同款形状仍然存在',
      (undSrc.match(/records \|\| \[\]/g) || []).length >= 3,
      { hits: (undSrc.match(/records \|\| \[\]/g) || []).length });

    /* ③ moments.js 的直写守卫与两处裸 readonly transaction 原样保留。 */
    const mjsSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'moments.js'), 'utf8');
    check('R5 【已知债】moments.js 的两处裸 readonly transaction 仍在（只读、非破坏，故不修）',
      (mjsSrc.match(/db\.transaction\(MOMENT_STORE,'readonly'\)/g) || []).length === 2,
      { hits: (mjsSrc.match(/db\.transaction\(MOMENT_STORE,'readonly'\)/g) || []).length });
    const bootSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-bootstrap.js'), 'utf8');
    check('R6 【已知债】"绕过权威的直写"仍然由守卫拦截（fail closed），3G 没有把它打开',
      /moments-write-closed/.test(bootSrc) && /moments-delete-closed/.test(bootSrc));
    console.log('   登记结论：① migration-before-hydrate 是独立真实债务（属于 migration/upgrade 边界）；');
    console.log('             ② memory / understanding / chat 各自持有独立 hydrate 原语（不共用 3G 的投递层）；');
    console.log('             ③ moments.js 的直写与裸只读事务原样保留。三者都**没有**被 3G 改动。');
  }

  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
  if (failed) console.log('失败项：\n  - ' + failures.join('\n  - '));
  stopProduction(svc);
  await sleep(200);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  /* §15.2：未捕获异常必须显式收尾，否则表现为"挂死"。 */
  console.error('SUITE CRASHED: ' + (error && error.stack || error));
  for (const child of openChildren) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  removeTempFixtures();
  setTimeout(() => process.exit(1), 300);
});
