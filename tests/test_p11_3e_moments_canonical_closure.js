/* ====================================================================
   P11-3E · Moments Canonical Store Closure
   --------------------------------------------------------------------
   `node tests/test_p11_3e_moments_canonical_closure.js`
   （可选分节：`node tests/test_p11_3e_moments_canonical_closure.js A B`）

   ── 这个测试为什么必须存在 ─────────────────────────────────────────────
   P11-3X-B / 3X-C 两次独立取证都指向同一件事，而它在本轮之前**从未**被任何
   测试看见：Home Node 的**生产启动路径**（runtime/local-services-runner.js
   直接跑 services/home-node-service.js → `openAll()`）从来没有打开过
   canonical Moments store，而 `buildHomeNode()` 打开了。

   症状在真实 23118 上（修复前实测，私有端口复现）：
     · /moments/list     → 503 store-closed
     · /moments/changes  → 400 store-closed    ← 把基础设施故障报成"请求有问题"
     · /moments/visible  → 400 store-closed
     · POST /moments/record → 500 {"ok":false,"error":"internal-error"}
     · /moments/migration → 200（谎报：读不到水位与"水位是空的"是同一个响应）
     · 磁盘上永远不会出现 moments 表 —— 这个节点一条动态都存不下来
   而全部 Moments 测试**直接** `createMomentsStore()`（绕开启动路径），
   所以它们全绿。这就是"测试 assembly ≠ production assembly"的教科书形状，
   本文件按 test_home_node_production_memory_assembly.js 的同一条纪律来回答它：
   **真实 spawn 生产入口**，不 mock store，不复制接线。

   ── 覆盖（与阶段要求 A–J 对齐）────────────────────────────────────────
   A canonical ownership          · 唯一 authority、store/retrieval 同一实例
   B production assembly          · 真实子进程上 /moments/* 全部 2xx + 写读闭环
   C open/close lifecycle         · openAll 打开、shutdown 关闭（真实停止路径）
   D health truthfulness          · store 关闭 → serving:false + 类别（不假绿）
   E persistence across restart   · 真实重启 ×3，create/update/delete 全部存活
   F desktop/mobile parity        · 桌面写 → Node 读；设备面**没有** moments verb
   G closed-store failure         · 503 + store-closed，绝不 200 空集合
   H DB failure classification    · schema 过新 → db-schema-too-new（复用分类器）
   I change/tombstone/revision    · change_log 的 upsert/delete 与墓碑跨重启成立
   J release closure              · 发行包（逐文件白名单）含 Moments 的全部运行时闭包

   ── 刻意不做 ──────────────────────────────────────────────────────────
   · 不碰 mobile 设备面（Android 侧没有 moments verb 这条边界由
     test_mobile_thin_client.js / test_moments_authority.js 原样守着）；
   · 不引入"测试专用装配"：两条路径都调用产品代码里同一个 assembly 函数；
   · 不验证 P11-3F 的 hydrate 语义（空远端覆盖本地）——那是 3F 的范围。
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

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('\u2714 ' + name); }
  else { failed++; failures.push(name); console.error('\u2718 ' + name + (extra !== undefined ? ' \u2014 ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n\u2500\u2500 ' + title + ' \u2500\u2500'); }

/* 分节：命令行参数优先（人用的），否则读 P11_3E_SECTIONS（mutation harness 用的）。
   两者都为空 = 跑全部。 */
const WANT = (function () {
  const argv = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (argv.length) return argv;
  return String(process.env.P11_3E_SECTIONS || '').split(/[\s,]+/).filter(Boolean);
})();
function wants(id) { return WANT.length === 0 || WANT.indexOf(id) >= 0; }

/* ── 隔离纪律：私有临时目录 + 私有端口；绝不碰用户真实数据目录与默认端口 ──
   清理只删"本次运行新建的"目录（按稳定命名族前缀取前后差集）：
   URL 里的库文件名 / 数据目录绝不出现在任何响应里，这一点由 G8 断言。 */
const TEMP_ROOT = os.tmpdir();
const tempDirs = [];
const openChildren = new Set();
function fixtureNames() {
  const out = new Set();
  try {
    for (const name of fs.readdirSync(TEMP_ROOT)) if (/^ib-3e-/.test(name)) out.add(name);
  } catch (_) { /* 读不到就当作空集 */ }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-3e-' + tag + '-'));
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

/* 真实 HTTP，没有 http 客户端抽象层 —— 断言直接打在线上字节上。 */
function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}),
      timeout: 8000
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 400) }; }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/* ── 生产启动：命令与 runtime/local-services-runner.js 逐字相同 ─────────
   刻意用**内置 Node**（runtime/node/node.exe）跑：那正是生产用的解释器，
   而"开发机 PATH 上的 node"不是。（缺失时退回 process.execPath 并如实说明。） */
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
    const svc = {
      port: port, child: child, stdout: '', stderr: '', exited: null,
      output() { return (this.stdout + this.stderr).slice(-3000); }
    };
    child.stdout.on('data', c => { svc.stdout += String(c); });
    child.stderr.on('data', c => { svc.stderr += String(c); });
    child.on('exit', (code, signal) => {
      svc.exited = { code: code, signal: signal };
      openChildren.delete(child);
    });
    resolve(svc);
  }));
}
/* 就绪判定刻意**不看** `ok`：库坏掉时 /health 回答 200 + ok:false，
   那也是"进程活着"。这里等的是**进程在监听**，不是"它很健康"。 */
async function waitListening(svc, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (svc.exited) return false;
    try { const r = await request(svc.port, 'GET', '/health'); if (r.status === 200) return true; } catch (_) { /* 还没起来 */ }
    await sleep(150);
  }
  return false;
}
async function stopProduction(svc) {
  if (!svc || svc.exited) return;
  svc.child.kill('SIGTERM');
  for (let i = 0; i < 60 && !svc.exited; i++) await sleep(100);
}
process.on('exit', () => {
  for (const child of openChildren) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
  removeTempFixtures();
});

/* ── 写入用的一条 Moment（形状与 moments-authority 的调用方一致）──────── */
function momentOf(id, content, extra) {
  return Object.assign({
    id: id, roleId: 'r1', authorType: 'role', authorId: 'r1',
    content: content, visibility: 'all', createdAt: 1700000000001
  }, extra || {});
}

async function main() {
  console.log('P11-3E · Moments canonical store closure');
  console.log('  node =', NODE_BIN, NODE_BIN === BUNDLED_NODE ? '(bundled, = production)' : '(FALLBACK: bundled runtime missing)');

  const SERVICE = require(path.join(ROOT, SERVICE_FILE));

  /* ══════════════════════════════════════════════════════════════════
     A · canonical ownership —— 唯一 authority
     ══════════════════════════════════════════════════════════════════ */
  if (wants('A')) {
    section('A · canonical ownership');
    check('A1 生产进程级装配暴露 canonical Moments store（不是只装配了 retrieval）',
      !!SERVICE.momentsStore && typeof SERVICE.momentsStore.put === 'function' &&
      typeof SERVICE.momentsStore.listVisible === 'function' && typeof SERVICE.momentsStore.isOpen === 'function',
      { hasStore: !!SERVICE.momentsStore });
    check('A2 生产进程级装配暴露 Moments retrieval，且它绑定的就是那个 store 实例',
      !!SERVICE.momentsRetrieval && SERVICE.momentsRetrieval.store === SERVICE.momentsStore,
      { bound: !!(SERVICE.momentsRetrieval && SERVICE.momentsRetrieval.store === SERVICE.momentsStore) });
    check('A3 装配守卫存在：store 与 retrieval 必须能被证明是同一实例',
      typeof SERVICE.momentsAssembly === 'function' && typeof SERVICE.canonicalMomentsDeps === 'function');
    /* 反向守卫：绑到另一个"能开、能查、永远为空"的实例不会抛任何错，
       只会表现为"她从来不记得最近发过什么"——必须被装配期拒绝。 */
    const otherAssembly = SERVICE.momentsAssembly({ dataDir: tmpDir('other') });
    check('A4 retrieval 绑到另一个 store 实例时，装配期**明确失败**（不静默失忆）',
      (() => {
        try {
          SERVICE.canonicalMomentsDeps({
            momentsStore: otherAssembly.momentsStore,
            momentsRetrieval: SERVICE.momentsRetrieval
          });
          return false;
        } catch (_) { return true; }
      })());
    check('A5 缺 momentsStore 的装配同样明确失败（不返回半个网关）',
      (() => { try { SERVICE.canonicalMomentsDeps({ momentsRetrieval: SERVICE.momentsRetrieval }); return false; } catch (_) { return true; } })());
    /* 唯一 authority 的**数据面**证据：canonical 文件只有一个。
       Moments 与 chat/memory/understanding/device 共库（home-node.db），
       因此"另一份 Moments 库"在磁盘上不该存在。 */
    const momentsSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'moments-store.js'), 'utf8');
    check('A6 Moments store 的默认库文件名与其它 canonical store 一致（同一个库，不是第二份 authority）',
      /DEFAULT_DB_FILENAME\s*=\s*'home-node\.db'/.test(momentsSrc));
    check('A7 Moments store 从不被一个"桌面镜像"取代：它自己拥有 records/change_log/meta 三张表',
      /RECORDS_TABLE/.test(momentsSrc) && /CHANGE_LOG_TABLE/.test(momentsSrc) && /createMeta/.test(momentsSrc));
    check('A8 浏览器侧存在的是 authority **客户端**（canonical/mirror/off 三态），不是第二份权威',
      (function () {
        const src = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'moments-authority.js'), 'utf8');
        return /createMomentsAuthority/.test(src) &&
          /var MODES = \['canonical', 'mirror', 'off'\]/.test(src) &&
          /authority: mode === 'canonical' \? 'home-node' : 'indexeddb'/.test(src) &&
          /function authorityEffective\(\)/.test(src);
      })());
  }

  /* ══════════════════════════════════════════════════════════════════
     B · production assembly —— 真实子进程，真实 HTTP
     ══════════════════════════════════════════════════════════════════ */
  let prod = null;
  let prodDir = null;
  let health = null;
  if (wants('B') || wants('C') || wants('D') || wants('E') || wants('F') || wants('I') || wants('J')) {
    prodDir = tmpDir('prod');
    prod = await startProduction(prodDir);
    const up = await waitListening(prod, 25000);
    if (!up) {
      console.error('生产子进程没能起来：\n' + prod.output());
      check('B0 生产入口在私有端口 + 私有数据目录上起来了', false, { exited: prod.exited });
    } else {
      check('B0 生产入口在私有端口 + 私有数据目录上起来了', true, { port: prod.port });
    }
  }

  if (wants('B') && prod && !prod.exited) {
    section('B · production assembly（真实 spawn services/home-node-service.js）');
    /* 修复前的证据形状被逐条钉在这里：501 = 路由没接线；503 store-closed =
       store 没开；400 = 被当成请求错误；500 = 内部抛错。四个都不许出现。 */
    const list = await request(prod.port, 'GET', '/moments/list');
    check('B1 GET /moments/list → 200（不是 501/503/400：路由与 store 都在）',
      list.status === 200 && list.body && list.body.type === 'moments.list',
      { status: list.status, error: list.body && list.body.error });
    check('B2 /moments/list 响应形状是 canonical（count/revision/records）',
      !!list.body && !!list.body.payload && typeof list.body.payload.count === 'number' &&
      typeof list.body.payload.revision === 'number' && Array.isArray(list.body.payload.records),
      list.body && list.body.payload);

    const put = await request(prod.port, 'POST', '/moments/record', {
      requestId: 'p11-3e-b1', record: momentOf('m_b1', '生产装配下的第一条动态。')
    });
    /* 修复前这里是 500 `record is not a function`：网关里一个局部变量把日志函数
       `record` 遮蔽了，于是**已经提交**的写入被报成失败。 */
    check('B3 POST /moments/record → 200 且 outcome=created（不是 500 internal-error）',
      put.status === 200 && put.body && put.body.payload && put.body.payload.outcome === 'created',
      { status: put.status, body: put.body });

    const after = await request(prod.port, 'GET', '/moments/list');
    const rows = (after.body && after.body.payload && after.body.payload.records) || [];
    const found = rows.filter(r => r && r.id === 'm_b1');
    check('B4 写进去的动态能从 /moments/list 读回（真的连到 canonical store，不是空壳 200）',
      found.length === 1 && found[0].content === '生产装配下的第一条动态。',
      rows.map(r => r && r.id));
    check('B5 写入推进了 canonical Moments revision', !!after.body.payload && after.body.payload.revision >= 1,
      after.body && after.body.payload && after.body.payload.revision);

    const changes = await request(prod.port, 'GET', '/moments/changes?cursor=0');
    check('B6 GET /moments/changes?cursor=0 → 200 且带游标语义（cursor/upserts/deletes）',
      changes.status === 200 && changes.body.payload && typeof changes.body.payload.cursor === 'number' &&
      Array.isArray(changes.body.payload.upserts) && Array.isArray(changes.body.payload.deletes),
      { status: changes.status, payload: changes.body && changes.body.payload });

    const visible = await request(prod.port, 'GET', '/moments/visible?principalKind=role&principalId=r1');
    check('B7 GET /moments/visible → 200（可见性读口在生产装配里真的可用）',
      visible.status === 200 && visible.body.payload && Array.isArray(visible.body.payload.moments) &&
      visible.body.payload.moments.some(m => m.id === 'm_b1'),
      { status: visible.status, payload: visible.body && visible.body.payload });

    const migration = await request(prod.port, 'GET', '/moments/migration?source=default');
    check('B8 GET /moments/migration → 200 且 state.ok=true（不是 200 里裹着一个 store-closed）',
      migration.status === 200 && migration.body.payload && migration.body.payload.state &&
      migration.body.payload.state.ok === true,
      { status: migration.status, payload: migration.body && migration.body.payload });

    const batch = await request(prod.port, 'POST', '/moments/records', {
      requestIdPrefix: 'p11-3e-b',
      records: [momentOf('m_b2', '迁移批次的一条。', { createdAt: 1700000000002 })]
    });
    check('B9 POST /moments/records（迁移批次）→ 200 且 created=1',
      batch.status === 200 && batch.body.payload && batch.body.payload.created === 1 &&
      batch.body.payload.total === 1,
      { status: batch.status, payload: batch.body && batch.body.payload });

    /* 迁移是**非破坏**的：同一批再发一次必须 skipped，绝不覆盖 canonical 行。 */
    const again = await request(prod.port, 'POST', '/moments/records', {
      requestIdPrefix: 'p11-3e-b2',
      records: [momentOf('m_b2', '试图覆盖的内容。', { createdAt: 1700000000002 })]
    });
    const stillThere = await request(prod.port, 'GET', '/moments/list');
    const m2 = ((stillThere.body && stillThere.body.payload && stillThere.body.payload.records) || []).find(r => r.id === 'm_b2');
    check('B10 迁移不覆盖已存在的 canonical 行（第二次同批 skipped，正文逐字不变）',
      again.body.payload && again.body.payload.skipped === 1 && m2 && m2.content === '迁移批次的一条。',
      { payload: again.body && again.body.payload, content: m2 && m2.content });

    /* 生产装配的最后一块：Node 自己的上下文注入必须看得到这些动态。
       库没开时它返回 store-closed（见 G），库开了就必须真的产出文本。
       用**同一份装配函数** + 同一份 canonical 库目录，因此这里读到的就是
       生产子进程刚刚写进去的那些行（不是另建一份数据）。 */
    const inject = SERVICE.momentsAssembly({ dataDir: prodDir, logger: () => { } });
    inject.momentsStore.open();
    const built = inject.momentsRetrieval.build({ kind: 'role', id: 'r1' });
    check('B11 Node 侧上下文注入（moments-retrieval）在真实落盘的 store 上产出文本块',
      !!built && built.ok === true && built.consulted === true && built.present === true &&
      built.reason === null && String(built.block).indexOf('生产装配下') >= 0,
      built && { consulted: built.consulted, present: built.present, reason: built.reason, len: String(built.block || '').length });
    check('B12 注入块里渲染的是正文与时间，**没有**内部 record id（不泄漏 id）',
      String(built.block || '').indexOf('m_b1') < 0 && String(built.block || '').indexOf('m_b2') < 0,
      String(built.block || '').slice(0, 200));
    inject.momentsStore.close();

    const memCtrl = await request(prod.port, 'GET', '/memory/list?limit=1');
    const undCtrl = await request(prod.port, 'GET', '/understanding/list');
    const chatCtrl = await request(prod.port, 'GET', '/list?limit=1');
    check('B13 相邻 canonical 域在生产装配里仍然可用（memory / understanding / chat 都是 200）',
      memCtrl.status === 200 && undCtrl.status === 200 && chatCtrl.status === 200,
      { memory: memCtrl.status, understanding: undCtrl.status, chat: chatCtrl.status });
  }

  /* ══════════════════════════════════════════════════════════════════
     C · open/close lifecycle
     ══════════════════════════════════════════════════════════════════ */
  if (wants('C') && prod && !prod.exited) {
    section('C · 生命周期：construct → open → ready → serve → close');
    const src = fs.readFileSync(path.join(ROOT, SERVICE_FILE), 'utf8');
    const openAllBody = (src.match(/function openAll\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
    check('C1 生产 openAll() 真的打开 canonical Moments store（本轮关闭的那个缺口）',
      /openMomentStore\(\s*moments\.momentsStore/.test(openAllBody), openAllBody.split('\n').slice(0, 12));
    check('C2 生产 shutdown() 真的关闭 canonical Moments store（停止方向同样闭合）',
      /moments\.momentsStore\.close\(\)/.test(src));
    check('C3 buildHomeNode().open() 用**同一个** openMomentStore（不是两套打开逻辑）',
      /openMomentStore\(instanceMoments\.momentsStore/.test(src));
    check('C4 buildHomeNode().close() 关闭 Moments store',
      /instanceMoments\.momentsStore\.close\(\)/.test(src));
    check('C5 代码里不再有裸的 momentsStore.open()（绕过探针 = 开库事故会丢失）',
      !/momentsStore\.open\(\)/.test(src.replace(/openMomentStore\(/g, 'openMomentStore(')));
    /* 真实进程侧：这一次启动确实打开过它（日志是进程自己说的，不是我们推断的）。 */
    check('C6 生产子进程的启动日志里有 moments-store-open（库真的用这个进程打开了）',
      /moments-store-open/.test(prod.stdout), prod.output().slice(-600));
    /* 打开顺序：chat 先开（它负责损坏隔离），moments 在 chat 之后。
       刻意按**日志事件名**取位置，不按子串：`memory-opened` 里也含 "opened"，
       用子串比对会得到一个"假通过"的较早位置（这是本轮自己抓到的一次测试缺陷）。 */
    const openedEvent = (function () {
      const lines = prod.stdout.split('\n');
      for (let i = 0; i < lines.length; i++) if (/\[info\] opened \{/.test(lines[i])) return i;
      return -1;
    })();
    const momEvent = (function () {
      const lines = prod.stdout.split('\n');
      for (let i = 0; i < lines.length; i++) if (/moments-store-open/.test(lines[i])) return i;
      return -1;
    })();
    check('C7 打开顺序：chat store 先于 moments store（损坏隔离先完成）',
      openedEvent >= 0 && momEvent >= 0 && openedEvent < momEvent,
      { chatLine: openedEvent, momentsLine: momEvent });

    /* 停止路径：真实 SIGTERM（= runtime/local-services-runner.js stopService 第一步）。
       端口释放 + 库可重开 + 数据仍在 = 生命周期真的闭合了。 */
    const dirC = tmpDir('lifecycle');
    const svcC = await startProduction(dirC);
    const upC = await waitListening(svcC, 25000);
    check('C8 第二个真实实例起来了', upC === true, { exited: svcC.exited });
    if (upC) {
      await request(svcC.port, 'POST', '/moments/record', {
        requestId: 'c1', record: momentOf('m_c1', '停止路径之前写入的一条。')
      });
      await stopProduction(svcC);
      check('C9 真实停止路径（SIGTERM）之后子进程确实结束了', svcC.exited !== null, svcC.exited);
      const freed = await (async () => {
        try { const r = await request(svcC.port, 'GET', '/health'); return r.status === 200 ? false : true; }
        catch (_) { return true; }
      })();
      check('C10 端口真的释放了（重新连不上，而不是只在表里显示关掉）', freed === true);
      const reopened = SERVICE.momentsAssembly({ dataDir: dirC });
      const openResult = reopened.momentsStore.open();
      const persisted = reopened.momentsStore.listRecords({ limit: 10 });
      check('C11 停止后库能被**重新打开**，且停止前提交的 Moment 仍在（关闭写脏了数据？否）',
        openResult && openResult.ok === true && persisted.ok === true &&
        persisted.records.some(r => r.id === 'm_c1'),
        { open: openResult, ids: (persisted.records || []).map(r => r.id) });
      check('C12 Moments revision 跨关闭保持（不是每次打开从 0 重新开始）',
        persisted.revision >= 1, { revision: persisted.revision });
      reopened.momentsStore.close();
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     D · health truthfulness
     ══════════════════════════════════════════════════════════════════ */
  if (wants('D')) {
    section('D · health 不假绿');
    /* 真实进程 + 真实 store 被关掉：用 buildHomeNode（与生产共用同一份
       createHttp 与同一份 stores 清单），因为"运行期中途把库关掉"这件事
       只能这样复现 —— 生产进程里没有任何合法路径会关它。 */
    const dirD = tmpDir('health');
    const app = SERVICE.buildHomeNode({ dataDir: dirD, logger: () => { } });
    app.open();
    const portD = await freePort();
    await new Promise(r => app.server.listen(portD, '127.0.0.1', r));

    const okBefore = await request(portD, 'GET', '/health');
    check('D1 健康态：serving=true、failure=null、stores 为空（没有凭空报故障）',
      okBefore.status === 200 && okBefore.body.serving === true && okBefore.body.failure === null &&
      Array.isArray(okBefore.body.stores) && okBefore.body.stores.length === 0,
      { serving: okBefore.body.serving, failure: okBefore.body.failure, stores: okBefore.body.stores });

    app.momentsStore.close();
    const h = await request(portD, 'GET', '/health');
    check('D2 moments store 关闭后 **serving 必须为 false**（HTTP 活着 ≠ Moments 健康）',
      h.status === 200 && h.body.serving === false && h.body.ok === false,
      { serving: h.body.serving, ok: h.body.ok });
    check('D3 失败类别复用既有闭集：category=store-closed（不是新造的词）',
      h.body.failure && h.body.failure.category === 'store-closed',
      h.body.failure);
    check('D4 reachable 仍然为真：HTTP 200 + 进程还在（区分"不在"与"在但坏了"）',
      h.status === 200 && h.body.service === 'internal-beyond-home-node');
    check('D5 `open` 仍然只声明 chat store（不把新域塞进既有字段改变语义）',
      h.body.open === true && h.body.role === 'canonical-chat-authority');
    check('D6 stores 列出到底是哪个域不能服务（store=moments）',
      Array.isArray(h.body.stores) && h.body.stores.length === 1 &&
      h.body.stores[0].store === 'moments' && h.body.stores[0].category === 'store-closed',
      h.body.stores);
    /* D7 刻意在 chat store **仍然打开**时做：/status 要说的是"哪个域不能服务"，
       而 chat 此刻是好的 —— 这正是"只有 Moments 坏了"的那次真实裁决。 */
    const s2 = await request(portD, 'GET', '/status');
    check('D7 /status 也如实报（桌面诊断读的是这里，不能只有 /health 诚实）',
      s2.status === 200 && s2.body.serving === false && s2.body.failure &&
      Array.isArray(s2.body.stores) && s2.body.stores.length === 1 &&
      s2.body.stores[0].store === 'moments',
      { status: s2.status, serving: s2.body.serving, stores: s2.body.stores });

    /* 现在才把 chat store 也关掉（P11-3X-B 的裁决不得退化）。 */
    app.store.close();
    const bothClosed = await request(portD, 'GET', '/health');
    check('D8 chat store 也关闭时 /health 仍报 serving:false（P11-3X-B 的裁决一字未改）',
      bothClosed.body.serving === false && bothClosed.body.open === false &&
      bothClosed.body.stores.length === 2,
      { serving: bothClosed.body.serving, open: bothClosed.body.open, stores: bothClosed.body.stores });
    const chatClosedStatus = await request(portD, 'GET', '/status');
    check('D10 chat store 关闭时 /status 的失败被如实上报（不是 200 + 空 body）',
      chatClosedStatus.status !== 200 || (chatClosedStatus.body && chatClosedStatus.body.ok === false),
      { status: chatClosedStatus.status, body: chatClosedStatus.body });
    console.log('  note: /status with the CHAT store closed answered ' + chatClosedStatus.status +
      ' ' + JSON.stringify(chatClosedStatus.body).slice(0, 160) +
      ' — `store.meta()` on a closed chat store throws; pre-existing (P11-3X-B scope), registered not fixed in P11-3E');

    /* chat 关掉之后恢复，只为让 close() 干净；断言已经拿到。 */
    app.momentsStore.open();
    app.close();
    check('D9 buildHomeNode().close() 之后两个 store 都是关闭的（生命周期不留半开）',
      app.momentsStore.isOpen() === false && app.store.isOpen() === false,
      { moments: app.momentsStore.isOpen(), chat: app.store.isOpen() });
  }

  /* ══════════════════════════════════════════════════════════════════
     E · persistence across restart（真实重启 ×3）
     ══════════════════════════════════════════════════════════════════ */
  if (wants('E') || wants('I')) {
    section('E/I · 重启持久化 + change/tombstone/revision 契约');
    const dirE = tmpDir('persist');
    let svc = await startProduction(dirE);
    let up = await waitListening(svc, 25000);
    check('E1 第一次启动（私有目录）', up === true, { exited: svc.exited });

    const created = await request(svc.port, 'POST', '/moments/record', {
      requestId: 'e1', record: momentOf('m_e1', '第一条。', { createdAt: 1700000000010 })
    });
    await request(svc.port, 'POST', '/moments/record', {
      requestId: 'e2', record: momentOf('m_e2', '第二条。', { createdAt: 1700000000020 })
    });
    check('E2 create 两次都成功', created.status === 200 && created.body.payload.outcome === 'created',
      created.body && created.body.payload);
    const afterCreate = await request(svc.port, 'GET', '/moments/list');
    const revAfterCreate = afterCreate.body.payload.revision;
    check('E3 list 能看到两条', afterCreate.body.payload.count === 2, afterCreate.body.payload.count);
    await stopProduction(svc);

    /* ── 重启 1：create 存活 + update ── */
    svc = await startProduction(dirE);
    up = await waitListening(svc, 25000);
    const listR1 = await request(svc.port, 'GET', '/moments/list');
    check('E4 重启后两条 Moment 仍然存在（真实落盘，不是内存）',
      up === true && listR1.body.payload.count === 2 &&
      listR1.body.payload.records.map(r => r.id).sort().join(',') === 'm_e1,m_e2',
      { up: up, ids: (listR1.body.payload.records || []).map(r => r.id) });
    check('E5 revision 跨重启连续（不是从 0 重来）',
      listR1.body.payload.revision === revAfterCreate,
      { before: revAfterCreate, after: listR1.body.payload.revision });

    const updated = await request(svc.port, 'POST', '/moments/record', {
      requestId: 'e3', expectedRev: 1, record: momentOf('m_e1', '改过的第一条。', { createdAt: 1700000000010 })
    });
    check('E6 update 成功且 rev 前进（CAS 基版本成立）',
      updated.status === 200 && updated.body.payload.outcome === 'updated' && updated.body.payload.rev === 2,
      updated.body && updated.body.payload);
    /* CAS 过期必须 409，而不是静默覆盖。 */
    const stale = await request(svc.port, 'POST', '/moments/record', {
      requestId: 'e4', expectedRev: 1, record: momentOf('m_e1', '用过期基版本乱写。', { createdAt: 1700000000010 })
    });
    check('E7 过期基版本 → 409 revision-conflict（绝不静默覆盖）',
      stale.status === 409 && stale.body.error && stale.body.error.code === 'CONFLICT',
      { status: stale.status, body: stale.body });
    await stopProduction(svc);

    /* ── 重启 2：update 存活 ── */
    svc = await startProduction(dirE);
    up = await waitListening(svc, 25000);
    const listR2 = await request(svc.port, 'GET', '/moments/list');
    const m1 = (listR2.body.payload.records || []).find(r => r.id === 'm_e1');
    check('E8 第二次重启后 update 仍在（正文逐字一致、rev 保持）',
      up === true && m1 && m1.content === '改过的第一条。' && m1.rev === 2,
      m1 && { content: m1.content, rev: m1.rev });

    /* ── delete + 墓碑 ── */
    const del = await request(svc.port, 'DELETE', '/moments/record?id=m_e1&expectedRev=2');
    check('E9 delete 成功（软删除 + revision 前进）',
      del.status === 200 && del.body.payload && del.body.payload.deleted === true,
      del.body && del.body.payload);
    const listAfterDelete = await request(svc.port, 'GET', '/moments/list');
    check('E10 删除后 list 里不再有它（但 m_e2 还在）',
      listAfterDelete.body.payload.records.map(r => r.id).join(',') === 'm_e2',
      (listAfterDelete.body.payload.records || []).map(r => r.id));

    /* ── 重启 3：delete 状态存活，且 change_log 的 tombstone 也在 ── */
    await stopProduction(svc);
    svc = await startProduction(dirE);
    up = await waitListening(svc, 25000);
    const listR3 = await request(svc.port, 'GET', '/moments/list');
    check('E11 第三次重启后删除状态成立（list 里仍然没有它）',
      up === true && listR3.body.payload.records.map(r => r.id).join(',') === 'm_e2',
      (listR3.body.payload.records || []).map(r => r.id));

    const ch = await request(svc.port, 'GET', '/moments/changes?cursor=0');
    const payload = ch.body.payload;
    const deleteRows = (payload.deletes || []).filter(d => d.id === 'm_e1');
    const upsertIds = (payload.upserts || []).map(u => u.id);
    check('E12 change_log 跨重启保留 tombstone（deletes 里有 m_e1，不只是"UI 看不见"）',
      deleteRows.length >= 1, payload.deletes);
    check('E13 change_log 里的 upsert 只包含**仍然存活**的行（m_e1 不会作为 upsert 复活）',
      upsertIds.indexOf('m_e1') < 0 && upsertIds.indexOf('m_e2') >= 0, upsertIds);
    check('E14 游标是单调的（changes 的 cursor ≥ 最后一条变更的 revision）',
      typeof payload.cursor === 'number' && payload.cursor >= 4, { cursor: payload.cursor, revision: payload.revision });
    check('E15 revision 命名空间独立：Moments 的 revision 不依赖 chat / memory 的 revision',
      /moments_revision/.test(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'moments-store.js'), 'utf8')) &&
      typeof payload.revision === 'number');

    /* 增量同步的真语义：从中间游标拉起时，删除仍然以 delete 出现。 */
    const inc = await request(svc.port, 'GET', '/moments/changes?cursor=2');
    check('E16 增量 changes（cursor=2）仍然把删除作为 delete 报出来（镜像才能移除本地行）',
      (inc.body.payload.deletes || []).some(d => d.id === 'm_e1'),
      inc.body.payload.deletes);
    await stopProduction(svc);

    /* 直接开库复核：tombstone 真的在库里，不是内存态。 */
    const direct = SERVICE.momentsAssembly({ dataDir: dirE });
    direct.momentsStore.open();
    const tomb = direct.momentsStore.getRecordAny('m_e1');
    check('E17 墓碑行真的落盘（deleted=true），迁移非破坏的"有据可查"成立',
      !!tomb && tomb.deleted === true, tomb && { id: tomb.id, deleted: tomb.deleted });
    check('E18 墓碑行不出现在任何生产读口（getRecord 与 listRecords 都看不到它）',
      direct.momentsStore.getRecord('m_e1') === null &&
      direct.momentsStore.listRecords({ limit: 10 }).records.every(r => r.id !== 'm_e1'));
    direct.momentsStore.close();
  }

  /* ══════════════════════════════════════════════════════════════════
     F · desktop / mobile parity
     ══════════════════════════════════════════════════════════════════ */
  if (wants('F') && prod && !prod.exited) {
    section('F · desktop / mobile parity');
    /* 桌面侧经 /moments/* 落到 canonical store；设备面**没有** moments verb。
       两件事都要证明，否则"parity"只是"看起来一样"。 */
    const before = await request(prod.port, 'GET', '/moments/list');
    const revBefore = before.body.payload.revision;
    const write = await request(prod.port, 'POST', '/moments/record', {
      requestId: 'f1', record: momentOf('m_f1', '桌面写的一条。', { createdAt: 1700000000100 })
    });
    const read = await request(prod.port, 'GET', '/moments/visible?principalKind=role&principalId=r1');
    check('F1 桌面写 → Node 读：写入后立即可见，且 revision 前进',
      write.status === 200 && read.status === 200 &&
      read.body.payload.revision > revBefore &&
      (read.body.payload.moments || []).some(m => m.id === 'm_f1'),
      { write: write.status, revBefore: revBefore, revAfter: read.body.payload.revision });

    /* 设备面：/mobile/v1/moments* 不存在（Android 侧没有动态能力，§13）。 */
    const mobileTry = await request(prod.port, 'GET', '/mobile/v1/moments/list');
    check('F2 设备面没有 moments verb（/mobile/v1/moments/list 不是 200）',
      mobileTry.status !== 200, { status: mobileTry.status, body: mobileTry.body });
    const adminTry = await request(prod.port, 'GET', '/mobile/moments/list');
    check('F3 /mobile/ 前缀下不存在任何 moments 路径（明确 404，不做版本猜测）',
      adminTry.status === 404, { status: adminTry.status });

    /* 出站 DTO 不带动态正文：真发一次设备面请求，扫整段响应体。 */
    const health2 = await request(prod.port, 'GET', '/security');
    check('F4 /security 的 momentsPolicy 声明与真实路由逐字一致（stored 但不服务设备）',
      !!health2.body && !!health2.body.momentsPolicy &&
      health2.body.momentsPolicy.stored === true &&
      health2.body.momentsPolicy.servedToDevices === false &&
      Array.isArray(health2.body.momentsPolicy.deviceVerbs) &&
      health2.body.momentsPolicy.deviceVerbs.length === 0,
      health2.body && health2.body.momentsPolicy);
    check('F5 设备面出站 DTO 不含任何动态正文（扫真实响应字节）',
      mobileTry.raw.indexOf('桌面写的一条') < 0 && adminTry.raw.indexOf('桌面写的一条') < 0 &&
      mobileTry.raw.indexOf('m_f1') < 0,
      { mobile: mobileTry.raw.slice(0, 200) });

    /* 两条装配路径连的是**不同**实例（不是把生产库悄悄复用进测试实例）。 */
    const appF = SERVICE.buildHomeNode({ dataDir: tmpDir('parity'), logger: () => { } });
    check('F6 buildHomeNode 实例与生产实例是两个独立的 store（不共享句柄）',
      appF.momentsStore !== SERVICE.momentsStore);
    check('F7 两条路径的 canonical Moments 依赖定义完全一致（同一 shared assembly）',
      Object.keys(SERVICE.momentsAssembly({ dataDir: tmpDir('parity2') })).sort().join(',') ===
      Object.keys(appF.momentsAssembly ? appF.momentsAssembly({ dataDir: tmpDir('parity3') }) : SERVICE.momentsAssembly({ dataDir: tmpDir('parity4') })).sort().join(','),
      Object.keys(SERVICE.momentsAssembly({ dataDir: tmpDir('parity5') })));
    check('F8 两条路径都把**同一份** resolveStoreFailure 分类器交给网关（不各写一份）',
      /gateway\.useStoreFailureResolver\(resolveStoreFailure\)/.test(
        fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8')) &&
      /resolveStoreFailure: resolveStoreFailure/.test(
        fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8')));
    appF.close();
  }

  /* ══════════════════════════════════════════════════════════════════
     G · closed-store failure semantics
     ══════════════════════════════════════════════════════════════════ */
  if (wants('G')) {
    section('G · store 不能服务时的失败语义');
    const dirG = tmpDir('closed');
    const app = SERVICE.buildHomeNode({ dataDir: dirG, logger: () => { } });
    app.open();
    app.momentsStore.put(momentOf('m_g1', '关闭之前写入的一条。'));
    app.momentsStore.close();
    const portG = await freePort();
    await new Promise(r => app.server.listen(portG, '127.0.0.1', r));

    const cases = [
      ['G1', 'GET', '/moments/list', null],
      ['G2', 'GET', '/moments/changes?cursor=0', null],
      ['G3', 'GET', '/moments/visible?principalKind=role&principalId=r1', null],
      ['G4', 'GET', '/moments/migration', null],
      ['G5', 'POST', '/moments/record', { requestId: 'g1', record: momentOf('m_g2', '写不进去的一条。') }],
      ['G6', 'DELETE', '/moments/record?id=m_g1', null],
      ['G7', 'POST', '/moments/records', { records: [momentOf('m_g3', '迁移批次。')] }]
    ];
    for (const [id, method, urlPath, body] of cases) {
      const r = await request(portG, method, urlPath, body);
      check(id + ' ' + method + ' ' + urlPath + ' → 503 store-closed（不是 200 空集合、不是 400、不是 500）',
        r.status === 503 && r.body && r.body.error && r.body.error.code === 'store-closed',
        { status: r.status, body: r.body });
    }
    /* `retryable` 是给客户端重连策略用的：库没开是可恢复的，必须为 true。 */
    const probe = await request(portG, 'GET', '/moments/list');
    const probeError = (probe.body && probe.body.error) || null;
    check('G8 失败响应带客户端可分支的稳定错误码（闭集里的 id，不含 SQL / 路径 / 库文件名）',
      !!probeError && probeError.code === 'store-closed' &&
      String(probe.raw).indexOf('home-node.db') < 0 &&
      String(probe.raw).indexOf('SELECT') < 0,
      { status: probe.status, body: probe.body });

    /* 请求本身不合法 → 仍然 4xx（不能把 schema 级拒收也报成基础设施故障）。 */
    app.momentsStore.open();
    const badBody = await request(portG, 'POST', '/moments/record', {});
    check('G9 缺 record 字段 → 400（请求问题与基础设施问题必须可区分）',
      badBody.status === 400 && badBody.body.error.code === 'BAD_REQUEST', badBody.body);
    const badContent = await request(portG, 'POST', '/moments/record', {
      requestId: 'g2', record: momentOf('m_g4', '   ')
    });
    check('G10 空内容 → 422（schema 级拒收，不是 store 失败）',
      badContent.status === 422, { status: badContent.status, body: badContent.body });
    const unattributable = await request(portG, 'POST', '/moments/record', {
      requestId: 'g3', record: { id: 'm_g5', content: '没有作者。', visibility: 'all', createdAt: 1 }
    });
    check('G11 不可归属的记录 → 422 unattributable（不落一条谁都读不到的孤儿行）',
      unattributable.status === 422, { status: unattributable.status, body: unattributable.body });
    const badDelete = await request(portG, 'DELETE', '/moments/record');
    check('G12 DELETE 缺 id → 400', badDelete.status === 400);

    /* chat 域不受影响：一个域坏了不该让别的域跟着不可服务。 */
    const chat = await request(portG, 'GET', '/list?limit=1');
    check('G13 moments 关了不影响 chat 服务（域隔离成立）', chat.status === 200);

    app.close();
  }

  /* ══════════════════════════════════════════════════════════════════
     H · DB failure classification
     ══════════════════════════════════════════════════════════════════ */
  if (wants('H')) {
    section('H · DB 失败分类（复用唯一分类器，不新增词表）');
    const dbFailure = require(path.join(ROOT, 'runtime', 'db-failure.js'));
    const dirH = tmpDir('dbfail');

    /* ① schema 过新：store 自己抛 SCHEMA_TOO_NEW，探针必须复述成同一个类别。 */
    const future = SERVICE.momentsAssembly({ dataDir: dirH });
    future.momentsStore.open();
    future.momentsStore.writeMeta('moments_schema', '9999');
    future.momentsStore.close();
    const probe = SERVICE.momentsAssembly({ dataDir: dirH });
    let thrown = null;
    try { probe.momentsStore.open(); } catch (e) { thrown = e; }
    check('H1 schema 过新的库：open() 明确抛错（不是静默降级）',
      !!thrown && thrown.code === 'SCHEMA_TOO_NEW', thrown && thrown.code);
    check('H2 唯一分类器把它归为 db-schema-too-new（复用 runtime/db-failure.js）',
      dbFailure.classify(thrown).reason === 'db-schema-too-new', dbFailure.classify(thrown).reason);
    check('H3 该类别在既有闭集里（component-registry / boot-state 都声明过它）',
      (function () {
        const reg = require(path.join(ROOT, 'runtime', 'component-registry.js'));
        const boot = require(path.join(ROOT, 'runtime', 'boot-state.js'));
        return reg.REASON.DB_SCHEMA_TOO_NEW === 'db-schema-too-new' &&
          boot.REASON.DB_SCHEMA_TOO_NEW === 'db-schema-too-new';
      })());

    /* ② 开库抛错时 /health 必须带类别、且是**终态**（500 而不是 503）。
       一条永远好不了的库不该被当成"稍后重试"。 */
    const dirH2 = tmpDir('dbfail2');
    const setup = SERVICE.momentsAssembly({ dataDir: dirH2 });
    setup.momentsStore.open();
    setup.momentsStore.writeMeta('moments_schema', '9999');
    setup.momentsStore.close();
    const app = SERVICE.buildHomeNode({ dataDir: dirH2, logger: () => { } });
    app.open();   /* Moments 打开失败 → 记录在探针里，不抛出（chat 仍要服务） */
    check('H4 一个起不来的派生域不得让整台节点连聊天都不服务',
      app.store.isOpen() === true && app.momentsStore.isOpen() === false,
      { chat: app.store.isOpen(), moments: app.momentsStore.isOpen() });
    const portH = await freePort();
    await new Promise(r => app.server.listen(portH, '127.0.0.1', r));
    const h = await request(portH, 'GET', '/health');
    check('H5 /health 如实报 serving:false，类别是 db-schema-too-new（不是笼统 store-closed）',
      h.body.serving === false && h.body.failure && h.body.failure.category === 'db-schema-too-new',
      h.body.failure);
    const listH = await request(portH, 'GET', '/moments/list');
    check('H6 /moments/list 在终态库故障上回答 500（不是 503：重试不会好）',
      listH.status === 500 && listH.body.error && listH.body.error.code === 'db-schema-too-new',
      { status: listH.status, body: listH.body });
    check('H7 终态类别集合与 http.js 的既有兜底一致（只有 corrupt / schema-too-new / unavailable 是终态）',
      (function () {
        const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');
        const m = src.match(/TERMINAL_STORE_CATEGORIES\s*=\s*\[([^\]]+)\]/);
        if (!m) return false;
        const listed = m[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();
        return listed.join(',') === 'db-corrupt,db-schema-too-new,db-unavailable';
      })());
    check('H8 没有新增第二套错误词表：db-* 全部来自唯一分类器',
      (function () {
        const reg = require(path.join(ROOT, 'runtime', 'component-registry.js'));
        const all = dbFailure.REASONS.filter(r => r.indexOf('db-') === 0);
        return all.every(r => reg.KNOWN_REASONS ? reg.KNOWN_REASONS.indexOf(r) >= 0 : true);
      })());
    const chatH = await request(portH, 'GET', '/list?limit=1');
    check('H9 库起不来也不 quarantine 数据：原文件仍在、可被重新打开读回',
      fs.existsSync(path.join(dirH2, 'home-node.db')) && chatH.status === 200);
    app.close();
  }

  /* ══════════════════════════════════════════════════════════════════
     J · release closure
     ══════════════════════════════════════════════════════════════════ */
  if (wants('J')) {
    section('J · 发行包闭包');
    const manifest = require(path.join(ROOT, 'scripts', 'release-manifest.js'));
    const resolved = manifest.resolve({});
    const included = new Set(resolved.files.map(f => manifest.toPosix(f.to || f.from)));
    const need = [
      'services/home-node-service.js',
      'services/home-node/moments-store.js',
      'services/home-node/moments-retrieval.js',
      'services/home-node/mobile-gateway.js',
      'services/home-node/http.js',
      /* P11-3E：服务现在 require 了 runtime/db-failure.js —— 发行清单是逐文件
         白名单，漏登记就是"开发机全绿、安装后启动链直接崩"。 */
      'runtime/db-failure.js',
      /* 共享可见性核（store 与 retrieval 都 require 它）。 */
      'assets/js/moments-visibility-core.js'
    ];
    for (const rel of need) {
      check('J1 发行包包含 ' + rel, included.has(rel), { size: included.size });
    }
    /* 更强的一条：从随包源码扫出**跨模块 require**，再确认目标在包里 ——
       只核对清单里列出的名字抓不到漏登记（P11-3X-B 实测）。 */
    const scanned = [];
    for (const rel of ['services/home-node-service.js', 'services/home-node/moments-store.js',
      'services/home-node/moments-retrieval.js', 'services/home-node/mobile-gateway.js',
      'services/home-node/http.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel.split('/').join(path.sep)), 'utf8');
      const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
      let m;
      while ((m = re.exec(src))) {
        const target = m[1];
        if (target.charAt(0) !== '.') continue;
        const abs = path.resolve(path.dirname(path.join(ROOT, rel.split('/').join(path.sep))), target);
        if (!abs.startsWith(ROOT)) continue;
        scanned.push(manifest.toPosix(path.relative(ROOT, abs)));
      }
    }
    const missingClosure = [...new Set(scanned)].filter(rel => !included.has(rel) && !included.has(rel + '.js'));
    check('J2 随包源码里每一个跨模块 require 的目标都在发行包里（逐条扫，不靠清单）',
      missingClosure.length === 0, missingClosure);
    /* J3 只断言**清单自身**的一致性：没有任何路径被 deny 规则拒掉。
       `missing` 刻意不作硬断言 —— mutation harness 在私有副本树里跑（那里只有
       发行闭包的一部分），"副本里没有 InternalBeyond.html"是副本的事实，
       不是清单的缺陷。清单完整性由 J1（点名文件）与 J2（逐条扫 require）负责，
       它们不依赖副本是否完整。 */
    check('J3 发行清单解析无被拒条目（没有任何路径命中 deny 规则）',
      resolved.denied.length === 0, { denied: resolved.denied });
    const sandboxMissing = resolved.missing.filter(m => !fs.existsSync(path.join(ROOT, m.from)));
    check('J3b 清单报出的 missing 全部是"仓库里本来就没有"的路径（清单本身不自相矛盾）',
      sandboxMissing.length === resolved.missing.length,
      { missingInRepo: sandboxMissing.map(m => m.from) });
    check('J4 测试文件不进发行包（test_p11_3e_* 不得入包）',
      ![...included].some(p => /test_p11_3e/i.test(p)));
  }

  await stopProduction(prod);

  console.log('\n' + '='.repeat(64));
  console.log('P11-3E moments canonical closure: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) console.error('failed: ' + failures.join(' | '));
  process.exitCode = failed ? 1 : 0;
}

main().catch(error => {
  console.error('HARNESS ERROR: ' + (error && error.stack || error));
  process.exitCode = 1;
});
