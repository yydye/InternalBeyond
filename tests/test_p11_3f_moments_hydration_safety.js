/* ====================================================================
   P11-3F · Hydration / Mirror Safety
   --------------------------------------------------------------------
   `node tests/test_p11_3f_moments_hydration_safety.js`
   （可选分节：`node tests/test_p11_3f_moments_hydration_safety.js A B`）
   （浏览器分节 I4–I9 需要真实 Chrome：`... I --browser`）

   ── 这个测试为什么必须存在 ─────────────────────────────────────────────
   修复前实测（私有端口 + 私有数据目录 + 真实 spawn 生产入口）：

     authority 有 250 条，`/moments/list?limit=4000` → 200 条，**没有任何**
     截断信号（服务端当时把 limit 夹在 PAGE_MAX=200 上且不报告），
     于是 hydrate 回答 `ok:true, hydrated:true, seeded:200, cursor:250`：
     镜像被替换成 200 条，**50 条永久丢失**（cursor 已推进到 250，
     增量再也不会把它们补回来），而所有标志都是绿的。

   同一批取证还证明：

     · `200 {"ok":true}`（缺 payload）→ `page.records` 是 undefined →
       `|| []` → **镜像被清空**，`hydrated` 变真；
     · `200 {"ok":true,"payload":{"records":null}}` → 同样清空，且 cursor 跳到 9；
     · `truncated:true`（服务端明说只给了一页）→ 镜像被替换成那一页；
     · 真实 503 store-closed / 连接被拒 → 镜像确实保住了，但 `status.degraded`
       是 **false**、`degradedReason` 还停在 'not-probed'、`lastError` 是 null
       （"写不进权威却自称健康"的假绿）。

   本文件按 P11-3E 的同一条纪律回答它们：**真实链路**（真实 spawn / 真实 HTTP /
   真实 home-node-client 传输 / 真实 moments-authority / 真实 IndexedDB），
   不 mock store，不复制接线。

   ── 覆盖（与阶段要求 A–L 对齐）─────────────────────────────────────────
   A authoritative non-empty  · 镜像精确变成 [A,B]（正常替换仍工作）
   B authoritative empty      · 明确完整的空快照**必须**能清空镜像（反证）
   C store unavailable        · 真实 503 → 镜像保留 + 如实降级
   D terminal DB failure      · 真实 db-schema-too-new → 保留 + 终态分类
   E network failure          · 连接被拒 → 保留
   F timeout                  · 真实 AbortController 超时 → 保留
   G malformed success        · 200 + 坏形状 → 一律不碰镜像
   H partial snapshot         · 服务端明说截断 → 拒绝替换（不是替换成那一页）
   I atomic replacement       · 同一事务（结构断言 + 真实 IndexedDB 功能断言）
   J concurrent hydrate       · 旧 hydrate 不得覆盖新 hydrate
   K hydrate × changes race   · 旧快照不得把镜像拖回更早的版本
   L reconnect                · 离线保留 + 重连后才收敛
   M state honesty            · hydrated/degraded/lastError/cursor 彼此一致（H6）
   N forbidden shapes         · 被消灭的写法不许复活（M1/M10 的落点）
   R registered, NOT fixed    · 本阶段刻意不修的项（断言现状，防止静默变化）

   ── 刻意不做 ──────────────────────────────────────────────────────────
   · 不实现 P11-3G 的 ack/retry 上界；不实现 P11-3H 的 installer；
   · 不动 memory / understanding / chat 的 hydrate（不同原语，只登记，见报告）；
   · 不为测试改 hydrate 语义("把所有 empty 都改成不覆盖"是另一个极端)。
   ==================================================================== */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_FILE = 'services/home-node-service.js';
const SERVICE = require(path.join(ROOT, SERVICE_FILE));
const AUTH_PATH = path.join(ROOT, 'assets', 'js', 'moments-authority.js');
const CLIENT_PATH = path.join(ROOT, 'assets', 'js', 'home-node-client.js');
const PAGE_URL = pathToFileURL(path.join(ROOT, 'InternalBeyond.html')).href;

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
  return String(process.env.P11_3F_SECTIONS || '').split(/[\s,]+/).filter(Boolean);
})();
function wants(id) { return WANT.length === 0 || WANT.indexOf(id) >= 0; }
const BROWSER = process.argv.indexOf('--browser') >= 0;

/* ── 隔离纪律：私有临时目录 + 私有端口；只删本次新建的夹具 ───────────── */
const TEMP_ROOT = os.tmpdir();
const tempDirs = [];
const openChildren = new Set();
let chromeProc = null;
function fixtureNames() {
  const out = new Set();
  try { for (const name of fs.readdirSync(TEMP_ROOT)) if (/^ib-3f-/.test(name)) out.add(name); } catch (_) { /* 空集 */ }
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
  const dir = fs.mkdtempSync(path.join(TEMP_ROOT, 'ib-3f-' + tag + '-'));
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
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: 15000
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
process.on('exit', () => {
  for (const child of openChildren) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  if (chromeProc) { try { chromeProc.kill(); } catch (_) { /* 已退出 */ } }
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
function loadClient(seedStorage) {
  global.localStorage = makeStorage(seedStorage);
  global.AbortController = global.AbortController || class { constructor() { this.signal = {}; } abort() { this.signal.aborted = true; } };
  global.window = {};
  delete require.cache[require.resolve(CLIENT_PATH)];
  require(CLIENT_PATH);
  return global.window.IB;
}
function createAuthority(remote, mirror) {
  delete require.cache[require.resolve(AUTH_PATH)];
  const AUTH = require(AUTH_PATH);
  return AUTH.createMomentsAuthority({ remote, local: mirror, mode: 'canonical', fileOrigin: false, log: () => { } });
}
function remoteFor(port, deps) {
  const IB = loadClient({ ib_home_node_http: 'http://127.0.0.1:' + port, ib_home_node_mode: 'canonical' });
  return IB.createMomentsRemote(deps || {});
}

/* ── 镜像替身 ─────────────────────────────────────────────────────────
   形状与 home-node-bootstrap.js 的 moments local driver **逐字段一致**
   （get/getAll/getByOwner/put/remove/markMigrated/replaceAll）。
   这里的 replaceAll 刻意做成"先构造新表、再整体换掉"的**原子**语义：
   真实 IndexedDB 驱动是否原子由 I4–I9 在真实浏览器里证明，本替身不替它背书。
   它的作用只有一个：让"replaceAll 有没有被调用 / 收到什么"可被断言。 */
function makeMirror(initialRows) {
  let rows = new Map();
  (initialRows || []).forEach(r => rows.set(String(r.id), r));
  const calls = { replaceAll: 0, put: 0, remove: 0, markMigrated: 0, lastReplaceArg: null };
  return {
    calls,
    ids: () => Array.from(rows.keys()).sort(),
    has: id => rows.has(String(id)),
    size: () => rows.size,
    getAllRaw: () => Array.from(rows.values()),
    get: id => Promise.resolve(rows.get(String(id)) || null),
    getAll: () => Promise.resolve(Array.from(rows.values())),
    getByOwner: roleId => Promise.resolve(Array.from(rows.values()).filter(r => r && r.roleId === roleId)),
    put: row => { calls.put++; if (!row || row.id == null) return Promise.resolve(false); rows.set(String(row.id), row); return Promise.resolve(true); },
    remove: id => { calls.remove++; rows.delete(String(id)); return Promise.resolve(true); },
    markMigrated: () => { calls.markMigrated++; return Promise.resolve({ ok: true }); },
    replaceAll: function (incoming) {
      calls.replaceAll++;
      calls.lastReplaceArg = incoming;
      const next = new Map();
      (incoming || []).forEach(r => { if (r && r.id != null) next.set(String(r.id), r); });
      rows = next;
      return Promise.resolve(true);
    },
    /* 只给 I 之外的分节用：模拟"原子替换失败"（镜像必须保持原样）。 */
    failNextReplaceAll: false
  };
}

function momentOf(i, over) {
  return Object.assign({
    id: 'm_' + String(i).padStart(4, '0'),
    roleId: 'role_a', authorId: 'role_a', authorType: 'role',
    content: 'moment #' + i, visibility: 'all', visibleRoleIds: [],
    likes: 0, commentCount: 0, source: 'post',
    createdAt: 1700000000000 + i * 1000
  }, over || {});
}

/* ── 脚本化 fetch：只替换**服务端字节**，请求/解析/提交全是产品代码 ───────
   注意：`clearFetch()` 必须**恢复** Node 自带的 fetch，而不是 delete 掉它 ——
   `delete global.fetch` 会把 Node 24 的内建实现一起删掉，后面的真实 HTTP
   分节就会以 `fetch is not defined` 挂死（本条是写本文件时真的踩到的一次）。 */
const ORIGINAL_FETCH = global.fetch;
function withFetch(handler) {
  global.fetch = (url, init) => {
    const out = handler(String(url).replace('http://127.0.0.1:23118', ''), init || {});
    if (out === 'PENDING') {
      return new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (signal && signal.addEventListener) {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
          });
        }
      });
    }
    if (out === 'THROW') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({
      ok: out.status >= 200 && out.status < 300,
      status: out.status,
      /* rawBody：**不是** JSON 的响应体（用来验证"解析失败"与"形状不对"
         两条路径都不许碰镜像）。 */
      text: () => Promise.resolve(out.rawBody !== undefined ? out.rawBody : JSON.stringify(out.body))
    });
  };
}
function clearFetch() { global.fetch = ORIGINAL_FETCH; }
function okBody(type, payload) {
  return { v: 1, ok: true, type, requestId: null, serverTime: 1700000000000, payload };
}
/* 服务端错误体形状（与 mobile-gateway.js errorBody() 逐字段一致）。 */
function errorBody(code, status) {
  return {
    v: 1, ok: false, type: 'error', requestId: null, serverTime: 1700000000000,
    status,
    error: { code, message: code, retryable: /^db-/.test(code) ? false : true }
  };
}

/* 真实 `remote.list()` **解包之后**的形状（payload 字段被摊平到顶层）。
   J / K 分节直接替换 remote 的方法（为了控制完成顺序），因此必须返回
   与生产 transport 逐字段同形的对象 —— 否则测的是"我自己造的另一个协议"。 */
function unwrappedPage(records, revision, truncated) {
  return {
    v: 1, ok: true, type: 'moments.list', requestId: null, serverTime: 1700000000000,
    status: 200, protocolVersion: 1,
    count: records.length, revision: revision, truncated: truncated === true, records: records
  };
}
function unwrappedChanges(cursor, revision, upserts, deletes) {
  return {
    v: 1, ok: true, type: 'moments.changes', requestId: null, serverTime: 1700000000000,
    status: 200, protocolVersion: 1,
    cursor: cursor, revision: revision, upserts: upserts || [], deletes: deletes || [], hasMore: false
  };
}

(async function main() {

  /* ══════════════════════════════════════════════════════════════════
     A · authoritative non-empty：正常替换仍然工作
     ══════════════════════════════════════════════════════════════════ */
  if (wants('A')) {
    section('A · authoritative non-empty（正常替换必须仍然工作）');
    const dir = tmpDir('nonempty');
    const svc = await startProduction(dir);
    const up = await waitListening(svc, 25000);
    check('A0 生产入口（真实 spawn services/home-node-service.js）在私有端口上活着', up, svc.out.slice(-300));

    if (up) {
      /* 3 条：两条 + 一条用于后面证明"权威没有的行会被清掉"。 */
      for (const m of [momentOf(1), momentOf(2), momentOf(3)]) {
        const w = await request(svc.port, 'POST', '/moments/record', { requestId: 'a-' + m.id, record: m });
        if (w.status !== 200) { console.error('seed failed', w.status, JSON.stringify(w.body).slice(0, 200)); }
      }
      /* 权威侧删掉第 3 条 → 它成为"镜像里必须消失的旧影子"。 */
      await request(svc.port, 'DELETE', '/moments/record?id=' + momentOf(3).id + '&expectedRev=1');

      const raw = await request(svc.port, 'GET', '/moments/list?limit=20000');
      const payload = (raw.body && raw.body.payload) || {};
      check('A1 远端权威的 /moments/list 如实声明完整性（truncated===false）',
        raw.status === 200 && payload.truncated === false, { status: raw.status, truncated: payload.truncated });
      check('A2 远端 revision 是数字（不是缺失/字符串）', typeof payload.revision === 'number' && payload.revision > 0, payload.revision);

      const mirror = makeMirror([{ id: 'OLD_1', roleId: 'role_a', content: '旧影子', visibility: 'all', createdAt: 1 },
      { id: 'OLD_2', roleId: 'role_a', content: '旧影子 2', visibility: 'all', createdAt: 2 }]);
      const auth = createAuthority(remoteFor(svc.port), mirror);
      const res = await auth.hydrate();
      check('A3 hydrate 成功且自报 authoritative-success', res.ok === true && res.outcome === 'authoritative-success', res);
      check('A4 镜像**精确**变成权威的存活集合（旧影子全部消失）',
        mirror.ids().join(',') === [momentOf(1).id, momentOf(2).id].sort().join(','),
        { got: mirror.ids(), want: [momentOf(1).id, momentOf(2).id].sort() });
      check('A5 权威里已删除的那条不在镜像里（墓碑不是靠"本地自己猜"实现的）',
        mirror.has(momentOf(3).id) === false);
      check('A6 cursor === mirrorRevision === 权威 revision（快照版本被完整接住）',
        auth.status().cursor === payload.revision && auth.status().mirrorRevision === payload.revision,
        auth.status());
      check('A7 replaceAll 只被调用一次（先收齐、再提交，不是边抓边改）', mirror.calls.replaceAll === 1, mirror.calls.replaceAll);
      check('A8 成功之后 degraded===false 且没有残留原因',
        auth.status().degraded === false && auth.status().degradedReason === null && auth.status().lastError === null,
        auth.status());
    }
    stopProduction(svc);
  }

  /* ══════════════════════════════════════════════════════════════════
     B · authoritative empty：真正的"空"必须能清空镜像（反证）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('B')) {
    section('B · authoritative empty（本阶段**不是**"禁止清空"）');
    const dir = tmpDir('empty');
    const svc = await startProduction(dir);
    const up = await waitListening(svc, 25000);
    check('B0 生产入口在私有端口上活着', up, svc.out.slice(-300));

    if (up) {
      const raw = await request(svc.port, 'GET', '/moments/list?limit=20000');
      const payload = (raw.body && raw.body.payload) || {};
      check('B1 全新节点的权威快照：ok + records:[] + truncated:false + 合法 revision',
        raw.status === 200 && Array.isArray(payload.records) && payload.records.length === 0 &&
        payload.truncated === false && payload.revision === 0,
        { status: raw.status, records: payload.records, truncated: payload.truncated, revision: payload.revision });

      const mirror = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '本地遗留', visibility: 'all', createdAt: 1 }]);
      const auth = createAuthority(remoteFor(svc.port), mirror);
      const res = await auth.hydrate();
      check('B2 明确完整的空快照 → hydrate 成功（不是被"保护"成失败）',
        res.ok === true && res.outcome === 'authoritative-success', res);
      check('B3 镜像被清空（LOCAL_KEEP 必须消失）—— 禁止的是"无证据清空"，不是清空',
        mirror.size() === 0, { size: mirror.size(), ids: mirror.ids() });
      check('B4 hydrate 收到的是**真空数组**，不是被兜底出来的 []',
        Array.isArray(mirror.calls.lastReplaceArg) && mirror.calls.lastReplaceArg.length === 0,
        mirror.calls.lastReplaceArg);
      check('B5 hydrated===true 且 cursor/mirrorRevision 落在权威的 0',
        auth.status().hydrated === true && auth.status().cursor === 0 && auth.status().mirrorRevision === 0,
        auth.status());
    }
    stopProduction(svc);
  }

  /* ══════════════════════════════════════════════════════════════════
     C · store unavailable（真实 503 store-closed）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('C')) {
    section('C · store unavailable（真实 503；镜像必须保留 + 如实降级）');
    const dir = tmpDir('closed');
    const app = SERVICE.buildHomeNode({ dataDir: dir, logger: () => { } });
    app.open();
    app.momentsStore.put(momentOf(500));
    app.momentsStore.close();
    const port = await freePort();
    await new Promise(r => app.server.listen(port, '127.0.0.1', r));

    const raw = await request(port, 'GET', '/moments/list?limit=20000');
    check('C1 真实 HTTP 503 + store-closed（P11-3E 的语义没有被本阶段改坏）',
      raw.status === 503 && raw.body.error && raw.body.error.code === 'store-closed',
      { status: raw.status, body: raw.body });

    const mirror = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '必须活下来', visibility: 'all', createdAt: 1 }]);
    const auth = createAuthority(remoteFor(port), mirror);
    const before = auth.status();
    const res = await auth.hydrate();
    check('C2 不可用 → hydrate 明确失败', res.ok === false, res);
    check('C3 失败被归类为 unavailable（不是 terminal-failure）',
      res.outcome === 'unavailable' && res.retryable === true, res);
    check('C4 error 是**字符串码**（服务端返回的 error 是对象，必须被归一化）',
      typeof res.error === 'string' && res.error === 'store-closed' && res.snapshotStatus === 503, res);
    check('C5 replaceAll **一次都没有被调用**（不可用绝不构成 destructive replace）',
      mirror.calls.replaceAll === 0, mirror.calls.replaceAll);
    check('C6 镜像逐字节保留（LOCAL_KEEP 还在，条目数不变）',
      mirror.size() === 1 && mirror.has('LOCAL_KEEP'), { size: mirror.size(), ids: mirror.ids() });
    const after = auth.status();
    check('C7 hydrated 不许假绿（失败后仍是 false）', after.hydrated === false, after.hydrated);
    check('C8 degraded===true 且 degradedReason 是真实原因（不是停在 not-probed）',
      after.degraded === true && after.degradedReason === 'store-closed', after);
    check('C9 lastError 如实记录（修复前是 null）', after.lastError === 'store-closed', after.lastError);
    check('C10 remoteOnline===false（权威此刻不能服务）', after.remoteOnline === false, after.remoteOnline);
    check('C11 cursor / mirrorRevision **没有前进**',
      after.cursor === before.cursor && after.mirrorRevision === before.mirrorRevision, { before, after });
    check('C12 统计没有谎报：hydrations 计数不因失败而增加',
      after.stats.hydrations === before.stats.hydrations, { before: before.stats.hydrations, after: after.stats.hydrations });
    app.close();
  }

  /* ══════════════════════════════════════════════════════════════════
     D · terminal DB failure（真实 db-schema-too-new）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('D')) {
    section('D · terminal DB failure（真实 db-schema-too-new）');
    const dir = tmpDir('dbfail');
    const setup = SERVICE.momentsAssembly({ dataDir: dir });
    setup.momentsStore.open();
    setup.momentsStore.writeMeta('moments_schema', '9999');
    setup.momentsStore.close();

    const app = SERVICE.buildHomeNode({ dataDir: dir, logger: () => { } });
    app.open();
    const port = await freePort();
    await new Promise(r => app.server.listen(port, '127.0.0.1', r));
    const raw = await request(port, 'GET', '/moments/list?limit=20000');
    check('D1 终态库故障回答 500 + db-schema-too-new（P11-3E 语义未被改坏）',
      raw.status === 500 && raw.body.error && raw.body.error.code === 'db-schema-too-new',
      { status: raw.status, body: raw.body });

    const mirror = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '必须活下来', visibility: 'all', createdAt: 1 }]);
    const auth = createAuthority(remoteFor(port), mirror);
    const res = await auth.hydrate();
    check('D2 终态故障被归类为 terminal-failure（与"稍后重试"可区分）',
      res.ok === false && res.outcome === 'terminal-failure' && res.retryable === false, res);
    check('D3 error 码就是既有闭集里的 db-schema-too-new（没有第二套词表）',
      res.error === 'db-schema-too-new', res.error);
    check('D4 镜像完整保留', mirror.size() === 1 && mirror.has('LOCAL_KEEP') && mirror.calls.replaceAll === 0,
      { size: mirror.size(), replaceAll: mirror.calls.replaceAll });
    check('D5 状态如实（degraded + 类别 + hydrated 未变真）',
      auth.status().degraded === true && auth.status().degradedReason === 'db-schema-too-new' &&
      auth.status().hydrated === false, auth.status());
    app.close();
  }

  /* ══════════════════════════════════════════════════════════════════
     E · network failure（真实连接被拒）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('E')) {
    section('E · network failure（连接被拒）');
    const deadPort = await freePort();
    const mirror = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '必须活下来', visibility: 'all', createdAt: 1 }]);
    const auth = createAuthority(remoteFor(deadPort), mirror);
    const res = await auth.hydrate();
    check('E1 hydrate 失败且被归类为 unavailable', res.ok === false && res.outcome === 'unavailable', res);
    check('E2 失败码来自传输层既有词表（unreachable / transport）',
      /unreachable|transport/.test(String(res.error)), res.error);
    check('E3 镜像完整保留、replaceAll 零调用',
      mirror.size() === 1 && mirror.has('LOCAL_KEEP') && mirror.calls.replaceAll === 0, mirror.calls.replaceAll);
    check('E4 degraded===true 且原因是真实传输原因（修复前是 degraded:false）',
      auth.status().degraded === true && /unreachable|transport/.test(String(auth.status().degradedReason)),
      auth.status());
  }

  /* ══════════════════════════════════════════════════════════════════
     F · timeout（真实 AbortController）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('F')) {
    section('F · timeout（真实 AbortController 超时）');
    const IB = loadClient({ ib_home_node_http: 'http://127.0.0.1:23118', ib_home_node_mode: 'canonical' });
    withFetch(() => 'PENDING');
    const mirror = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '必须活下来', visibility: 'all', createdAt: 1 }]);
    const auth = createAuthority(IB.createMomentsRemote({ batchTimeoutMs: 60, healthTimeoutMs: 60 }), mirror);
    const res = await auth.hydrate();
    check('F1 超时被如实分类（timeout），不是"权威说没有"',
      res.ok === false && res.error === 'timeout', res);
    check('F2 镜像完整保留、replaceAll 零调用',
      mirror.size() === 1 && mirror.has('LOCAL_KEEP') && mirror.calls.replaceAll === 0, mirror.calls.replaceAll);
    check('F3 状态如实降级且 hydrated 未变真',
      auth.status().degraded === true && auth.status().degradedReason === 'timeout' && auth.status().hydrated === false,
      auth.status());
    clearFetch();
  }

  /* ══════════════════════════════════════════════════════════════════
     G · malformed successful response
     ══════════════════════════════════════════════════════════════════ */
  if (wants('G')) {
    section('G · malformed success（200 + 坏形状一律不许碰镜像）');
    const cases = [
      ['G1 200 {}（没有信封）', { body: {}, status: 200 }, 'list-failed'],
      ['G2 200 {"ok":true}（无 payload）', { body: { ok: true }, status: 200 }, 'invalid-response'],
      ['G3 200 ok:true + type 但没有 payload', { body: { ok: true, type: 'moments.list' }, status: 200 }, 'invalid-response'],
      ['G4 200 ok:true + payload:{}', { body: okBody('moments.list', {}), status: 200 }, 'invalid-response'],
      ['G5 200 records:null', { body: okBody('moments.list', { records: null, revision: 9, truncated: false }), status: 200 }, 'invalid-response'],
      ['G6 200 裸 {"records":[]}（没有信封）', { body: { records: [] }, status: 200 }, 'list-failed'],
      ['G7 200 非 JSON 文本', { rawBody: 'not json at all', status: 200 }, 'invalid-response'],
      ['G7b 200 JSON **字符串**（合法 JSON，但不是信封）', { body: 'not json at all', status: 200 }, 'invalid-response'],
      ['G8 200 缺 truncated 声明（老服务端形状）', { body: okBody('moments.list', { records: [momentOf(1)], revision: 9 }), status: 200 }, 'invalid-response'],
      ['G9 200 truncated 不是布尔（字符串 "false"）', { body: okBody('moments.list', { records: [momentOf(1)], revision: 9, truncated: 'false' }), status: 200 }, 'invalid-response'],
      ['G10 200 revision:null', { body: okBody('moments.list', { records: [], revision: null, truncated: false }), status: 200 }, 'invalid-response'],
      ['G11 200 revision 缺失', { body: okBody('moments.list', { records: [], truncated: false }), status: 200 }, 'invalid-response'],
      ['G12 200 records 不是数组（对象）', { body: okBody('moments.list', { records: { a: 1 }, revision: 3, truncated: false }), status: 200 }, 'invalid-response']
    ];
    for (const [label, out, wantCode] of cases) {
      const IB = loadClient({ ib_home_node_http: 'http://127.0.0.1:23118', ib_home_node_mode: 'canonical' });
      withFetch(() => out);
      const mirror = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '必须活下来', visibility: 'all', createdAt: 1 }]);
      const auth = createAuthority(IB.createMomentsRemote({}), mirror);
      const res = await auth.hydrate();
      const ok = res.ok === false &&
        mirror.size() === 1 && mirror.has('LOCAL_KEEP') &&
        mirror.calls.replaceAll === 0 &&
        auth.status().hydrated === false &&
        auth.status().degraded === true &&
        res.error === wantCode;
      check(label + ' → 拒绝、镜像不动、hydrated 不假绿（error=' + wantCode + '）', ok,
        { res, size: mirror.size(), replaceAll: mirror.calls.replaceAll, status: auth.status() });
      clearFetch();
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     H · partial snapshot（服务端明说截断）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('H')) {
    section('H · partial / truncated snapshot（收齐 → 校验 → 提交，不是边抓边改）');
    const dir = tmpDir('partial');
    const svc = await startProduction(dir);
    const up = await waitListening(svc, 25000);
    check('H0 生产入口在私有端口上活着', up, svc.out.slice(-300));

    if (up) {
      /* 25 条真实动态；然后**故意**只要 10 条的播种上限 → 服务端必须如实说截断。 */
      const bulk = [];
      for (let i = 0; i < 25; i++) bulk.push(momentOf(i));
      for (let off = 0; off < bulk.length; off += 25) {
        const w = await request(svc.port, 'POST', '/moments/records', { records: bulk.slice(off, off + 25) });
        if (w.status !== 200) console.error('seed failed', w.status, JSON.stringify(w.body).slice(0, 200));
      }
      const rawSmall = await request(svc.port, 'GET', '/moments/list?limit=10');
      const pSmall = (rawSmall.body && rawSmall.body.payload) || {};
      check('H1 取满上限时服务端**如实**声明 truncated:true（不是静默截断）',
        pSmall.truncated === true && pSmall.records.length === 10, { truncated: pSmall.truncated, n: pSmall.records.length });
      const rawFull = await request(svc.port, 'GET', '/moments/list?limit=20000');
      const pFull = (rawFull.body && rawFull.body.payload) || {};
      check('H2 上限足够时同一读口声明 truncated:false 且给出全部 25 条',
        pFull.truncated === false && pFull.records.length === 25, { truncated: pFull.truncated, n: pFull.records.length });

      const mirror = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '必须活下来', visibility: 'all', createdAt: 1 }]);
      const auth = createAuthority(remoteFor(svc.port), mirror);
      const res = await auth.hydrate({ seedLimit: 10 });
      check('H3 截断的快照被拒绝为 incomplete（**不是**替换成那一页）',
        res.ok === false && res.outcome === 'incomplete' && res.error === 'incomplete-snapshot', res);
      check('H4 镜像没有被替换成第一页（LOCAL_KEEP 在、条目数仍是 1）',
        mirror.size() === 1 && mirror.has('LOCAL_KEEP'), { size: mirror.size(), ids: mirror.ids() });
      check('H5 replaceAll 零调用 —— 证明是 COLLECT→VALIDATE→COMMIT，不是 FETCH PAGE→MUTATE',
        mirror.calls.replaceAll === 0, mirror.calls.replaceAll);
      check('H6 拒绝时 cursor 不前进（否则截断会被永久固化）',
        auth.status().cursor === 0 && auth.status().mirrorRevision === 0, auth.status());
      check('H7 状态如实降级（degraded + incomplete-snapshot）',
        auth.status().degraded === true && auth.status().degradedReason === 'incomplete-snapshot', auth.status());

      /* 上限足够时同一条路径必须成功 —— 证明拒绝是**关于完整性**的，不是一律拒绝。 */
      const mirror2 = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '必须活下来', visibility: 'all', createdAt: 1 }]);
      const auth2 = createAuthority(remoteFor(svc.port), mirror2);
      const res2 = await auth2.hydrate();
      check('H8 上限足够时同一 hydrate 成功并收齐 25 条（拒绝不等于永远拒绝）',
        res2.ok === true && mirror2.size() === 25 && mirror2.calls.replaceAll === 1,
        { res: res2, size: mirror2.size(), replaceAll: mirror2.calls.replaceAll });
    }
    stopProduction(svc);
  }

  /* ══════════════════════════════════════════════════════════════════
     I · atomic replacement
     ══════════════════════════════════════════════════════════════════ */
  if (wants('I')) {
    section('I · atomic replacement（同一事务；结构断言 + 真实 IndexedDB）');
    const coreSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'core.js'), 'utf8');
    const bootSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'home-node-bootstrap.js'), 'utf8');

    const fnBody = (function () {
      const at = coreSrc.indexOf('replaceMomentsMirror');
      if (at < 0) return '';
      return coreSrc.slice(at, at + 900);
    })();
    check('I1 core.js 存在 replaceMomentsMirror（复用既有 replaceMemoryMirror 的形状）',
      /replaceMomentsMirror\s*:\s*async function/.test(fnBody), fnBody.slice(0, 120));
    check('I2 它只开**一个** readwrite 事务，且 clear + put 都在这个事务里',
      (fnBody.match(/db\.transaction\('moments','readwrite'\)/g) || []).length === 1 &&
      /store\.clear\(\)/.test(fnBody) && /store\.put\(m\)/.test(fnBody), fnBody.slice(0, 200));
    check('I3 排队时同步抛错会**显式 abort**（否则 clear + 前半批 put 会被照常提交）',
      /catch\(e\)\{try\{t\.abort\(\)\}catch\(_\)\{\}fail\(e\);return\}/.test(fnBody) && /t\.onabort/.test(fnBody),
      fnBody.slice(0, 200));
    check('I3b 同一个接缝对象里的**全部五个**镜像写入器都补齐了同一条 abort（不留同类缺陷在隔壁）',
      (coreSrc.match(/catch\(e\)\{try\{t\.abort\(\)\}catch\(_\)\{\}fail\(e\);return\}/g) || []).length === 5,
      (coreSrc.match(/catch\(e\)\{try\{t\.abort\(\)\}catch\(_\)\{\}fail\(e\);return\}/g) || []).length);
    check('I4 moments 镜像驱动已经改用它（原先的 getAll→逐条 del→逐条 put 已经消失）',
      /replaceAll:\s*function\s*\(rows\)\s*\{\s*return DB\.replaceMomentsMirror\(rows \|\| \[\]\);/.test(
        bootSrc.replace(/\s+/g, ' ').replace(/\/\*[\s\S]*?\*\//g, '').replace(/replaceAll: function \(rows\) \{ return DB\.replaceMomentsMirror\(rows \|\| \[\]\); \}/, 'replaceAll: function (rows) { return DB.replaceMomentsMirror(rows || []); }')),
      'bootstrap moments driver');
    check('I5 旧的非原子形状在 bootstrap 里已经不存在（不再逐条 DB.del/DB.put moments）',
      !/DB\.del\('moments'/.test(bootSrc) || !/replaceAll: function \(rows\) \{\s*return DB\.getAll\('moments'\)/.test(bootSrc),
      'bootstrap');

    if (!BROWSER) {
      console.log('   （I6–I9 需要真实 Chrome：加 --browser 运行）');
    } else {
      const chrome = (function () {
        for (const c of [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        ]) { try { if (fs.existsSync(c)) return c; } catch (_) { /* 继续 */ } }
        return null;
      })();
      if (!chrome) {
        check('I6 本机存在可用浏览器（原子性的真实 IndexedDB 证据）', false, 'no chrome');
      } else {
        const port = await freePort();
        chromeProc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
          '--allow-file-access-from-files', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port,
          '--user-data-dir=' + tmpDir('chrome'), 'about:blank'], { stdio: 'ignore', windowsHide: true });
        let up = false;
        for (let i = 0; i < 150; i++) { try { await (await fetch('http://127.0.0.1:' + port + '/json/version')); up = true; break; } catch (_) { await sleep(150); } }
        if (!up) {
          check('I6 CDP 起来了', false, 'cdp not up');
        } else {
          const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(PAGE_URL), { method: 'PUT' })).json();
          const cdp = await wsConnect(tab.webSocketDebuggerUrl);
          await cdp.send('Runtime.enable');
          const ready = await waitFor(cdp, "typeof window.__ibCoreDb==='object'&&typeof window.__ibCoreDb.replaceMomentsMirror==='function'", 40000);
          check('I6 真实页面里 __ibCoreDb.replaceMomentsMirror 可用', ready);

          if (ready) {
            const seed = await ev(cdp, "(async function(){ await window.__ibCoreDb.replaceMomentsMirror([{id:'atom_a',content:'A'},{id:'atom_b',content:'B'}]); var r=await window.__ibCoreDb.getAll('moments'); return r.map(function(x){return x.id}).sort().join(','); })()");
            check('I7 种子写入：镜像 = atom_a,atom_b', seed === 'atom_a,atom_b', seed);

            /* 一次**注定失败**的替换：第二条记录不可结构化克隆。
               IndexedDB 事务必须整体回滚 —— 旧镜像完整保留、绝不半新半旧。 */
            const afterFail = await ev(cdp, "(async function(){ var threw=null; try{ await window.__ibCoreDb.replaceMomentsMirror([{id:'atom_c',content:'C'},{id:'atom_d',bad:function(){}}]); }catch(e){ threw=String(e&&e.name||e); } var r=await window.__ibCoreDb.getAll('moments'); return {threw:threw, ids:r.map(function(x){return x.id}).sort().join(','), n:r.length}; })()");
            check('I8 失败的整表替换被拒绝（并且不是静默成功）',
              afterFail && typeof afterFail.threw === 'string' && afterFail.threw.length > 0, afterFail);
            check('I9 原子性成立：旧镜像 **完整保留**（不是半新半旧、也不是清空后的空库）',
              afterFail && afterFail.ids === 'atom_a,atom_b' && afterFail.n === 2, afterFail);

            /* 对照：成功的替换必须真的换掉（不是"因为怕丢就永远不换"）。 */
            const afterOk = await ev(cdp, "(async function(){ await window.__ibCoreDb.replaceMomentsMirror([{id:'atom_z',content:'Z'}]); var r=await window.__ibCoreDb.getAll('moments'); return r.map(function(x){return x.id}).sort().join(','); })()");
            check('I10 成功的替换真的整表换掉（含清空旧行）', afterOk === 'atom_z', afterOk);
            const afterEmpty = await ev(cdp, "(async function(){ await window.__ibCoreDb.replaceMomentsMirror([]); var r=await window.__ibCoreDb.getAll('moments'); return r.length; })()");
            check('I11 空快照能合法清空镜像（authoritative empty 在真实 IndexedDB 上也成立）', afterEmpty === 0, afterEmpty);
          }
          try { chromeProc.kill(); } catch (_) { /* 已退出 */ }
          chromeProc = null;
        }
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     J · concurrent hydrate（旧 hydrate 不得覆盖新的）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('J')) {
    section('J · concurrent hydrate（代次；旧的不得覆盖新的）');
    const IB = loadClient({ ib_home_node_http: 'http://127.0.0.1:23118', ib_home_node_mode: 'canonical' });
    const remote = IB.createMomentsRemote({});
    let pendingResolve = null;
    let call = 0;
    remote.list = function () {
      call++;
      if (call === 1) {
        /* H1：先发起、**后**完成，携带旧快照 rev=5 */
        return new Promise(resolve => { pendingResolve = resolve; });
      }
      /* H2：后发起、先完成，携带新快照 rev=10 */
      return Promise.resolve(unwrappedPage([momentOf(2, { content: 'NEW' })], 10, false));
    };
    const mirror = makeMirror([{ id: 'OLD', roleId: 'role_a', content: 'old', visibility: 'all', createdAt: 1 }]);
    const auth = createAuthority(remote, mirror);

    const h1 = auth.hydrate();                 /* 旧：拿 rev=5 */
    await sleep(10);
    const h2 = auth.hydrate();                 /* 新：拿 rev=10，先完成 */
    const r2 = await h2;
    check('J1 新的 hydrate 先完成并提交', r2.ok === true && r2.revision === 10, r2);
    check('J2 镜像已是新快照（OLD 被清掉）', mirror.ids().join(',') === momentOf(2).id && mirror.has('OLD') === false, mirror.ids());

    pendingResolve(unwrappedPage([momentOf(1, { content: 'OLD' })], 5, false));
    const r1 = await h1;
    check('J3 旧 hydrate 被拒为 superseded（不是"静默成功"）',
      r1.ok === false && r1.outcome === 'superseded' && r1.reason === 'newer-hydration-started', r1);
    check('J4 旧结果**没有**覆盖新结果（镜像仍是新快照）',
      mirror.ids().join(',') === momentOf(2).id, mirror.ids());
    check('J5 cursor / mirrorRevision 没有因旧快照而后退',
      auth.status().cursor === 10 && auth.status().mirrorRevision === 10, auth.status());
    check('J6 replaceAll 只发生了 1 次（串行化 + 代次共同保证）', mirror.calls.replaceAll === 1, mirror.calls.replaceAll);
    check('J7 被拒的那一次没有把 hydrated 弄假（仍是 true）', auth.status().hydrated === true);
  }

  /* ══════════════════════════════════════════════════════════════════
     K · hydrate × incremental changes race
     ══════════════════════════════════════════════════════════════════ */
  if (wants('K')) {
    section('K · hydrate × incremental changes（旧快照不得把镜像拖回更早的版本）');
    const dir = tmpDir('race');
    const svc = await startProduction(dir);
    const up = await waitListening(svc, 25000);
    check('K0 生产入口在私有端口上活着', up, svc.out.slice(-300));

    if (up) {
      /* 全部数据来自**真实权威**：唯一被控制的是"哪一次 hydrate 的取数在什么时候返回"，
         而那个快照本身是真实的、并且在被提交时确实已经过期。 */
      await request(svc.port, 'POST', '/moments/record', { requestId: 'k-1', record: momentOf(1, { content: 'A' }) });
      const realRemote = remoteFor(svc.port);
      const mirror = makeMirror([]);
      const auth = createAuthority(realRemote, mirror);

      const first = await auth.hydrate();
      check('K1 前置：首次 hydrate 成功拿到真实快照', first.ok === true && auth.status().mirrorRevision >= 1, first);
      const revAfterFirst = auth.status().mirrorRevision;

      /* 抓住一份**真实**快照，先扣在手里不返回。 */
      const captured = await realRemote.list({ limit: 20000 });
      check('K2 抓到的真实快照形状合法（ok / truncated:false / records 数组 / 数字 revision）',
        captured.ok === true && captured.truncated === false && Array.isArray(captured.records) &&
        typeof captured.revision === 'number', { ok: captured.ok, truncated: captured.truncated, rev: captured.revision });

      /* 权威继续前进：新增一条。 */
      await request(svc.port, 'POST', '/moments/record', { requestId: 'k-2', record: momentOf(2, { content: 'B' }) });

      /* 现在发起 hydrate：它会拿到那份**已经过期**的快照，但故意晚返回。 */
      let release = null;
      const originalList = realRemote.list;
      realRemote.list = function () { return new Promise(resolve => { release = () => resolve(captured); }); };
      const stale = auth.hydrate();
      await sleep(10);

      /* 增量同步先完成：真实 /moments/changes。 */
      const inc = await auth.sync({});
      check('K3 增量同步成功并把镜像推进到更新版本',
        inc.ok === true && auth.status().mirrorRevision > revAfterFirst,
        { inc, mirrorRevision: auth.status().mirrorRevision, revAfterFirst });
      check('K4 增量写入的行已经在镜像里（来自真实 change_log 的 upsert）',
        mirror.has(momentOf(2).id), mirror.ids());

      /* 再让那份旧快照返回：它已经没有资格落盘。 */
      release();
      const r = await stale;
      check('K5 晚提交的旧快照被拒为 superseded/stale-snapshot',
        r.ok === false && r.outcome === 'superseded' && r.reason === 'stale-snapshot', r);
      check('K6 镜像**没有**被旧快照拖回去（B 行仍在，条目数是 2）',
        mirror.has(momentOf(2).id) && mirror.size() === 2, { ids: mirror.ids(), size: mirror.size() });
      check('K7 mirrorRevision 没有倒退',
        auth.status().mirrorRevision === Number(inc.cursor), { mirrorRevision: auth.status().mirrorRevision, cursor: inc.cursor });
      check('K8 旧快照没有触发第二次 replaceAll（增量不是"整表替换"）',
        mirror.calls.replaceAll === 1, mirror.calls.replaceAll);
      realRemote.list = originalList;
    }
    stopProduction(svc);
  }

  /* ══════════════════════════════════════════════════════════════════
     L · reconnect
     ══════════════════════════════════════════════════════════════════ */
  if (wants('L')) {
    section('L · reconnect（离线保留 → 重连后才收敛）');
    const dir = tmpDir('reconnect');
    const svc = await startProduction(dir);
    const up = await waitListening(svc, 25000);
    check('L0 生产入口在私有端口上活着', up, svc.out.slice(-300));

    if (up) {
      for (const m of [momentOf(1), momentOf(2)]) {
        await request(svc.port, 'POST', '/moments/record', { requestId: 'l-' + m.id, record: m });
      }
      /* ① 离线：先用一个**没有服务**的端口，镜像必须保留。 */
      const deadPort = await freePort();
      const mirror = makeMirror([{ id: 'LOCAL_KEEP', roleId: 'role_a', content: '离线期间必须活下来', visibility: 'all', createdAt: 1 }]);
      const offline = createAuthority(remoteFor(deadPort), mirror);
      const r1 = await offline.hydrate();
      check('L1 离线时 hydrate 失败、镜像保留、状态如实降级',
        r1.ok === false && mirror.size() === 1 && mirror.has('LOCAL_KEEP') &&
        offline.status().degraded === true, { r1, size: mirror.size(), status: offline.status() });

      /* ② 重连：同一个镜像，换成真实存活的权威。 */
      const online = createAuthority(remoteFor(svc.port), mirror);
      const r2 = await online.hydrate();
      const want = [momentOf(1).id, momentOf(2).id].sort().join(',');
      check('L2 重连后拿到完整权威快照 → 镜像才允许收敛',
        r2.ok === true && mirror.ids().join(',') === want, { r2, ids: mirror.ids() });
      check('L3 收敛后 degraded===false 且原因被清空',
        online.status().degraded === false && online.status().degradedReason === null, online.status());
      check('L4 离线期间的那条本地影子在收敛后被权威状态替换掉（镜像 = 权威）',
        mirror.has('LOCAL_KEEP') === false, mirror.ids());
    }
    stopProduction(svc);
  }

  /* ══════════════════════════════════════════════════════════════════
     M · state honesty（H6）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('M')) {
    section('M · state honesty（hydrated / degraded / lastError / cursor 彼此一致）');
    const IB = loadClient({ ib_home_node_http: 'http://127.0.0.1:23118', ib_home_node_mode: 'canonical' });
    withFetch((pathname) => {
      if (pathname.indexOf('/moments/list') === 0) {
        return { status: 200, body: okBody('moments.list', { count: 1, revision: 7, truncated: false, records: [momentOf(1)] }) };
      }
      return { status: 200, body: okBody('moments.changes', { cursor: 7, revision: 7, upserts: [], deletes: [], hasMore: false }) };
    });
    const mirror = makeMirror([]);
    const auth = createAuthority(IB.createMomentsRemote({}), mirror);
    const s0 = auth.status();
    check('M1 初始态是**诚实的未知**（不是"健康"）：degraded 为真、原因是 not-probed',
      s0.degraded === true && s0.degradedReason === 'not-probed' && s0.hydrated === false, s0);
    check('M2 status 暴露 mirrorRevision（版本水位的唯一事实源）', typeof s0.mirrorRevision === 'number', s0);

    const ok = await auth.hydrate();
    const s1 = auth.status();
    check('M3 成功之后四条标志彼此一致（hydrated:true / degraded:false / reason:null / lastError:null）',
      ok.ok === true && s1.hydrated === true && s1.degraded === false &&
      s1.degradedReason === null && s1.lastError === null && s1.remoteOnline === true, s1);
    check('M4 成功之后 cursor === mirrorRevision === 权威 revision', s1.cursor === 7 && s1.mirrorRevision === 7, s1);

    /* 读路径的 degraded 必须与 status 一致（此前是两处各写一份公式）。 */
    const read = await auth.getAll();
    check('M5 读返回的 degraded 与 status() 同源（没有第二份公式）',
      read.degraded === s1.degraded && read.degradedReason === s1.degradedReason, { read: read.degraded, status: s1.degraded });

    /* 一次失败的 hydrate 之后：hydrated 保持 true（镜像确实还是权威的样子），
       但 degraded 必须变真、原因必须换成真实原因 —— 不许"失败后仍然全绿"。 */
    withFetch(() => ({ status: 503, body: errorBody('store-closed', 503) }));
    const bad = await auth.hydrate();
    const s2 = auth.status();
    check('M6 失败后 hydrated 保持 true（镜像仍然是上一次成功的样子，不谎报为"没有镜像"）',
      bad.ok === false && s2.hydrated === true, { bad, s2 });
    check('M7 失败后 degraded:true + 真实原因 + lastError（不假绿）',
      s2.degraded === true && s2.degradedReason === 'store-closed' && s2.lastError === 'store-closed', s2);
    check('M8 失败后 cursor / mirrorRevision 未被触碰', s2.cursor === 7 && s2.mirrorRevision === 7, s2);
    clearFetch();
  }

  /* ══════════════════════════════════════════════════════════════════
     N · forbidden shapes
     ══════════════════════════════════════════════════════════════════ */
  if (wants('N')) {
    section('N · forbidden shapes（被消灭的写法不许复活）');
    const src = fs.readFileSync(AUTH_PATH, 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('N1 `replaceAll(page.records || [])` 已经不存在（把"缺字段"与"权威空集合"压成同一个状态的写法）',
      !/replaceAll\([^)]*records\s*\|\|\s*\[\]/.test(code), 'moments-authority.js');
    check('N2 hydrate 的提交路径不再有任何 `|| []` 兜底喂给 replaceAll',
      !/replaceAll\([^)]*\|\|/.test(code), 'moments-authority.js');
    check('N3 完整性声明是硬判据（truncated 必须显式为 false）',
      /truncated\s*!==\s*false/.test(code) && /'incomplete-snapshot'/.test(code), 'moments-authority.js');
    check('N4 revision 不再被 `Number(page.revision || 0)` 兜底（缺失必须是 invalid-response）',
      !/Number\(page\.revision\s*\|\|\s*0\)/.test(code) && /revision-missing/.test(code), 'moments-authority.js');
    check('N5 代次与镜像锁都在（旧的 hydrate 不能覆盖新的）',
      /hydrateGen/.test(code) && /withMirrorLock/.test(code), 'moments-authority.js');
    check('N6 版本水位存在且被 put/remove/增量推进',
      (code.match(/mirrorRevision/g) || []).length >= 8, (code.match(/mirrorRevision/g) || []).length);
    const hydrateBody = (function () {
      const at = code.indexOf('function hydrate(');
      if (at < 0) return '';
      return code.slice(at, code.indexOf('function applyChanges'));
    })();
    check('N7 hydrate 的数据来源仍是 remote（不是拿本地镜像冒充权威）',
      /remote\.list\(/.test(hydrateBody) && !/\blocal\.(getAll|get)\b/.test(hydrateBody),
      hydrateBody.slice(0, 160));
    check('N8 没有新增第二套错误词表：客户端**不复制**服务端的码（store-closed / db-* 一律原样转发）',
      !/'store-closed'/.test(code) && !/'db-[a-z-]+'/.test(code) && !/new Error\(/.test(code),
      'moments-authority.js');
    check('N8b 客户端自造的新码只有契约里声明的那几个（invalid-response / incomplete-snapshot / superseded / mirror-write-failed）',
      ["'invalid-response'", "'incomplete-snapshot'", "'superseded'", "'mirror-write-failed'"]
        .every(c => code.indexOf(c) >= 0), 'moments-authority.js');
    const storeSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'moments-store.js'), 'utf8');
    check('N9 服务端镜像播种读口如实报告完整性（truncated）',
      /truncated:\s*rows\.length >= limit/.test(storeSrc), 'moments-store.js');
    check('N10 行集与版本号出自同一个读事务（否则 revision 会比行集新，游标会跳过一条变更）',
      /withTransaction\(\(\)\s*=>\s*\{[\s\S]{0,400}?revision = getRevision\(\);[\s\S]{0,80}?\},\s*'read'\)/.test(storeSrc),
      'moments-store.js');
    const gwSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'mobile-gateway.js'), 'utf8');
    check('N11 网关把 truncated 透传给客户端（信封字段名与 memory 同款，不新造词）',
      /okBody\('moments\.list'[\s\S]{0,300}?truncated:\s*!!page\.truncated/.test(gwSrc), 'mobile-gateway.js');
  }

  /* ══════════════════════════════════════════════════════════════════
     R · registered, NOT fixed（断言现状，防止静默变化）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('R')) {
    section('R · 登记但**刻意不修**（断言现状，防止静默变化）');
    console.log('   说明：这一节不是在断言"这是对的"，而是在断言"这是当前**已知**的债"。');
    console.log('   任何一次无意的行为变化都会让下面的断言变红，从而被迫显式面对。');

    /* ① 未迁移的浏览器遗留动态：boot hydrate 会先于任何 migrate 执行，
          而权威里还没有这些行 —— 于是它们被整表替换清掉。
          P11-3F 刻意**不**用"本地非空 + 远端空 → 不覆盖"来挡这一条：
          那会直接违反 H4（authoritative empty 必须能清空镜像）。
          正确修法是让 migrate 与首个 hydrate 定序（迁移水位），属于 migration /
          upgrade 的范围（roadmap Q5），不在本阶段。 */
    const dir = tmpDir('registered');
    const svc = await startProduction(dir);
    const up = await waitListening(svc, 25000);
    if (up) {
      const mirror = makeMirror([
        { id: 'LEGACY_1', roleId: 'role_a', content: '迁移之前的本地动态 1', visibility: 'all', createdAt: 1 },
        { id: 'LEGACY_2', roleId: 'role_a', content: '迁移之前的本地动态 2', visibility: 'all', createdAt: 2 }
      ]);
      const auth = createAuthority(remoteFor(svc.port), mirror);
      check('R1 前置：镜像里没有迁移水位（这批遗留行从未被迁移过）',
        mirror.calls.markMigrated === 0, mirror.calls.markMigrated);
      const res = await auth.hydrate();
      check('R2 【已知债】权威为空 + 未迁移的本地遗留行 → hydrate 清空镜像（H4 要求如此）',
        res.ok === true && mirror.size() === 0, { res: res, size: mirror.size() });
      check('R3 因此 migrate() 之后读到的来源已经是权威的子集（浏览器回滚影子不再完整）',
        mirror.getAllRaw().length === 0, mirror.getAllRaw().length);
    }
    stopProduction(svc);

    /* ② memory / understanding / chat 的 hydrate 是**各自**的实现（不是共用原语），
          因此它们不在本阶段范围内；但它们的形状必须仍然"看得见"，
          以便未来阶段处置时不必重新取证。 */
    const memSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'memory-authority.js'), 'utf8');
    const undSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'understanding-authority.js'), 'utf8');
    const chatSrc = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'chat-authority.js'), 'utf8');
    check('R4 【已知债】memory-authority 的 hydrate 仍然用 `page.records || []` 做兜底（不同原语，本阶段不动）',
      /replaceAll\(page\.records \|\| \[\]\)/.test(memSrc), 'memory-authority.js');
    check('R5 【已知债】memory-authority 已经知道 truncated，却仍然用它替换镜像（只记 hasFullHistory）',
      /page\.truncated/.test(memSrc) && /replaceAll\(page\.records \|\| \[\]\)/.test(memSrc), 'memory-authority.js');
    check('R6 【已知债】understanding / chat 同款形状仍然存在（登记，不扩大范围）',
      /replaceAll\(page\.(records|docs|messages) \|\| \[\]\)/.test(undSrc) &&
      /replaceAll\(page\.(records|docs|messages) \|\| \[\]\)/.test(chatSrc),
      { understanding: /replaceAll\(page\.\w+ \|\| \[\]\)/.test(undSrc), chat: /replaceAll\(page\.\w+ \|\| \[\]\)/.test(chatSrc) });
    console.log('   登记结论：memory / understanding / chat 各自持有**独立的** hydrate 实现，');
    console.log('   与 moments 不共用原语，因此"不修就无法保证本阶段不变量"这一条件不成立 ——');
    console.log('   按阶段硬边界只登记、取证、分类（详见 P11-3F 报告 §15）。');
  }

  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
  if (failed > 0) process.exitCode = 1;

})().catch(error => {
  console.error('\u2718 未捕获异常：' + (error && error.stack ? error.stack : error));
  /* 未捕获异常时必须**主动**收掉夹具：spawn 出来的子进程会一直占着事件循环，
     否则一次异常会表现为"套件挂死"而不是"套件失败"（写本文件时真的踩到过）。 */
  hardCleanup();
  clearFetch();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});

function hardCleanup() {
  for (const child of openChildren) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  openChildren.clear();
  if (chromeProc) { try { chromeProc.kill(); } catch (_) { /* 已退出 */ } chromeProc = null; }
}

/* ══════════════════════════════════════════════════════════════════════
   最小 CDP 客户端（与 test_moments_browser_authority.js 同一份实现：
   客户端帧**必须**掩码 —— 未掩码帧会被 Chrome 静默忽略，症状是挂死而不是失败）。
   ══════════════════════════════════════════════════════════════════════ */
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''),
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (res, socket) => {
      const client = { socket, buf: Buffer.alloc(0), seq: 0, pending: new Map() };
      socket.on('data', (d) => {
        client.buf = Buffer.concat([client.buf, d]);
        for (;;) {
          if (client.buf.length < 2) return;
          const b1 = client.buf[1] & 0x7f; let off = 2, len = b1;
          if (b1 === 126) { if (client.buf.length < 4) return; len = client.buf.readUInt16BE(2); off = 4; }
          else if (b1 === 127) { if (client.buf.length < 10) return; len = Number(client.buf.readBigUInt64BE(2)); off = 10; }
          let maskKey = null;
          if (client.buf[1] & 0x80) {
            if (client.buf.length < off + 4) return;
            maskKey = client.buf.subarray(off, off + 4); off += 4;
          }
          if (client.buf.length < off + len) return;
          let payload = client.buf.subarray(off, off + len); client.buf = client.buf.subarray(off + len);
          if (maskKey) {
            const out = Buffer.alloc(len);
            for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
            payload = out;
          }
          let msg; try { msg = JSON.parse(payload.toString()); } catch (_) { continue; }
          if (msg.id && client.pending.has(msg.id)) {
            const p = client.pending.get(msg.id); client.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result || {});
          }
        }
      });
      socket.on('error', (e) => { for (const p of client.pending.values()) p.reject(e); client.pending.clear(); });
      client.send = (method, params) => new Promise((res2, rej2) => {
        const id = ++client.seq; client.pending.set(id, { resolve: res2, reject: rej2 });
        const body = Buffer.from(JSON.stringify({ id, method, params: params || {} }));
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(body.length);
        for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ mask[i & 3];
        let frame;
        if (body.length < 126) frame = Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
        else if (body.length < 65536) {
          const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0x80 | 126; h.writeUInt16BE(body.length, 2);
          frame = Buffer.concat([h, mask, masked]);
        } else {
          const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(body.length), 2);
          frame = Buffer.concat([h, mask, masked]);
        }
        socket.write(frame);
      });
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}
async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __exception: JSON.stringify(r.exceptionDetails.exception) };
  return r.result && r.result.value;
}
async function waitFor(cdp, expression, timeout) {
  const end = Date.now() + (timeout || 20000);
  while (Date.now() < end) {
    const v = await ev(cdp, expression);
    if (v === true) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}
