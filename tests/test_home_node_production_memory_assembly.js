'use strict';
/* Internal Beyond · Home Node **生产装配** parity 回归（service 组）
   运行：node tests/test_home_node_production_memory_assembly.js

   ── 这个测试为什么必须存在（一次真实事故的教训）────────────────────────
   `c655891` 把 canonical memory 提升为正式域，并给网关加了 /memory/* 路由。
   测试全绿 —— 因为它们只覆盖 `buildHomeNode()`；而**生产启动路径**
   （runtime/local-services-runner.js 直接跑 services/home-node-service.js）
   在进程级 createMobileGateway({...}) 里**没有**传 memoryStore/memoryRetrieval。
   结果是 23118 上 /memory/* 全部落到 `if (!memoryStore) return 501`，
   浏览器侧表现为记忆镜像永远补不上、/memory/list 404/501 刷屏。

   所以本文件刻意**只**验证真实进程装配，不碰 buildHomeNode 的行为断言：
     1) 真实 spawn services/home-node-service.js（随机端口 + 临时数据目录）——
        与生产启动命令逐字相同；
     2) 三个 GET canonical memory route 必须在**真实 handler** 里返回 2xx
        （404 no-route = 路由没进进程；501 UNSUPPORTED = 路由进了但 store 没接线）；
     3) 写入一条记忆后必须能从 HTTP 读回 —— 证明端到端真的连到 canonical store，
        而不是"返回了一个空壳 200";
     4) 装配漂移守卫：生产装配与 buildHomeNode 装配必须给出**同一套** canonical
        memory 依赖定义（同一个函数出来的同一组属性），且两边的 store 都真的可用。

   ── 刻意不做 ──────────────────────────────────────────────────────────
   · 不改 memory-authority 的 ensureReady 自愈语义、不碰 retry/backoff；
   · 不碰 mobile 面（/mobile/v1 没有 memory verb 这条边界由
     test_mobile_memory_continuity.js 原样守着）；
   · 不引入第二套测试专用装配：下面两条路径都调用**产品代码里同一个**
     assembly 函数。 */
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 24900 + Math.floor(Math.random() * 400);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-hn-prodmem-'));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(BASE + urlPath, {
      method: method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed, raw: raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForHealth(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200 && r.body.ok) return r.body;
    } catch (_) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

/* 与 tests/test_home_node_http.js:58 同款：真实 spawn 生产入口，只换端口与数据目录。 */
function spawnService() {
  const child = spawn(process.execPath, ['services/home-node-service.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      IB_HOME_NODE_PORT: String(PORT),
      IB_HOME_NODE_DATA_DIR: DATA_DIR,
      /* 刻意不设 IB_HOME_NODE_TOKEN：桌面面在 loopback 下的默认姿态就是本测试要验的
         （生产默认安装即无 token；带 token 是另一条由 test_home_node_http.js 覆盖的路径）。
         ★ P22-23：产品默认会在首次启动时**自动**生成并持久化一份桌面凭据
         （Economy 首次使用链闭合的前提）。本测试要的是"没有凭据"这个部署形态
         —— 它依然合法（env 是 developer / headless override），所以这里显式
         关掉自动 provisioning，而不是依赖一个会随产品演进的默认值。
         自动 provisioning 本身由 tests/test_p22_23_* 覆盖。 */
      IB_HOME_NODE_TOKEN_AUTOPROVISION: '0'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', c => out += c);
  child.stderr.on('data', c => out += c);
  return { child, output: () => out };
}

/* 一条契约合法的 canonical 记忆（字段与 assets/js/memory-contract.js 的
   validateRecord + test_mobile_memory_continuity.js 的种子同形）。 */
function mem(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: '生产装配守卫', summary: '', content: 'PROD-ASSEMBLY-MEMORY',
    domain: '日常', tags: [], valence: 0.5, arousal: 0.3, importance: 5, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: 1789000000000, lastActivated: 1789000000000,
    createdBy: 'user', createdByName: '', editedByUser: false,
    consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}

(async () => {
  let svc = null;

  /* ══ T1 · 真实进程装配下的 canonical memory routes ══ */
  section('T1 · production assembly（真实 spawn，随机端口 + 临时数据目录）');
  svc = spawnService();
  try {
    const health = await waitForHealth(15000);
    check('T1.0 生产入口启动并响应 /health', !!health, svc.output().slice(-400));
    if (!health) { console.error(svc.output()); return; }

    /* 逐条看 status 与 error code：404 no-route 说明路由没进这个进程，
       501 UNSUPPORTED 说明路由进了但 memoryStore 没被交给网关。两者都必须失败。 */
    const list = await req('GET', '/memory/list?limit=10');
    check('T1.1 GET /memory/list → 2xx（不是 404 no-route，也不是 501 UNSUPPORTED）',
      list.status === 200, { status: list.status, error: list.body && list.body.error });
    check('T1.2 /memory/list 响应形状是 canonical（count/revision/records）',
      !!list.body && typeof list.body.payload === 'object' && list.body.payload !== null &&
      typeof list.body.payload.count === 'number' && typeof list.body.payload.revision === 'number' &&
      Array.isArray(list.body.payload.records),
      list.body && list.body.payload);

    const settings = await req('GET', '/memory/settings');
    check('T1.3 GET /memory/settings → 2xx（真实 handler，不是兜底 404/501）',
      settings.status === 200, { status: settings.status, error: settings.body && settings.body.error });
    /* 全新节点的诚实回答是 `{ok:true, settings:null}`（桌面还没发布过预算）——
       这条断言就是"没接线"与"接好了但还没人发布"的区分点。 */
    check('T1.4 全新节点 /memory/settings 如实返回 settings:null（不是 501/404）',
      !!settings.body && settings.body.ok === true && settings.body.payload &&
      settings.body.payload.settings === null,
      settings.body && settings.body.payload);
    /* 发布 → 读回：证明 settings handler 真的读写 canonical memory store 的 meta。 */
    const putSettings = await req('POST', '/memory/settings', { budget: 1500, contentLen: 120 });
    check('T1.4b POST /memory/settings → 2xx 且回显 budget/contentLen',
      putSettings.status === 200 && putSettings.body.payload &&
      putSettings.body.payload.settings &&
      putSettings.body.payload.settings.budget === 1500 &&
      putSettings.body.payload.settings.contentLen === 120,
      putSettings.body && putSettings.body.payload);
    const settingsAgain = await req('GET', '/memory/settings');
    check('T1.4c 发布后的 settings 能从 canonical store 读回',
      settingsAgain.status === 200 && settingsAgain.body.payload.settings &&
      settingsAgain.body.payload.settings.budget === 1500,
      settingsAgain.body && settingsAgain.body.payload);

    const changes = await req('GET', '/memory/changes?cursor=0');
    check('T1.5 GET /memory/changes?cursor=0 → 2xx（真实 handler）',
      changes.status === 200, { status: changes.status, error: changes.body && changes.body.error });
    check('T1.6 /memory/changes 返回游标语义（cursor/upserts/deletes）',
      !!changes.body && !!changes.body.payload &&
      typeof changes.body.payload.cursor === 'number' &&
      Array.isArray(changes.body.payload.upserts) && Array.isArray(changes.body.payload.deletes),
      changes.body && changes.body.payload);

    /* ══ T2 · 端到端：HTTP 写入 → HTTP 读回（证明真的连到 canonical store）══ */
    section('T2 · 写读闭环（排除"空壳 200"）');
    const seeded = mem('mem_prod_assembly_guard');
    const put = await req('POST', '/memory/records', { record: seeded });
    check('T2.1 POST /memory/records → 2xx 且 outcome=created',
      put.status === 200 && put.body && put.body.payload && put.body.payload.outcome === 'created',
      put.body && put.body.payload);

    const after = await req('GET', '/memory/list?limit=10');
    const rows = (after.body && after.body.payload && after.body.payload.records) || [];
    const found = rows.filter(r => r && r.id === 'mem_prod_assembly_guard');
    check('T2.2 写进去的记忆能从 /memory/list 读回（同一个 canonical store）',
      found.length === 1, rows.map(r => r && r.id));
    check('T2.3 读回的正文与提交一致（不是被投影/丢字段的壳）',
      found.length === 1 && found[0].content === 'PROD-ASSEMBLY-MEMORY',
      found[0] && found[0].content);
    check('T2.4 写入推进了 canonical memory revision',
      !!after.body.payload && after.body.payload.revision >= 1,
      after.body && after.body.payload && after.body.payload.revision);

    /* ══ T3 · 装配漂移守卫 ══
       两条装配路径（生产进程级 / buildHomeNode）必须给出**同一套** canonical
       memory 依赖，且都不允许缺席。断言直接打在共享装配函数的输出上，
       因此"某个域只在一侧接线"这种漂移不可能再悄悄发生。 */
    section('T3 · assembly 漂移守卫');
    const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));
    check('T3.1 生产进程级装配暴露 canonical memory store',
      !!SERVICE.memoryStore && typeof SERVICE.memoryStore.listRecords === 'function');
    check('T3.2 生产进程级装配暴露 memory retrieval（不是只建了 store）',
      !!SERVICE.memoryRetrieval && typeof SERVICE.memoryRetrieval.retrieve === 'function');
    check('T3.3 两条路径都由**同一个** shared assembly 函数产出（不是两套代码）',
      typeof SERVICE.memoryAssembly === 'function' &&
      typeof SERVICE.canonicalMemoryDeps === 'function');

    /* 生产侧依赖必须完整：缺任何一项都要在装配期抛错，而不是运行期静默降级。 */
    const prodShape = SERVICE.canonicalMemoryDeps({
      memoryStore: SERVICE.memoryStore, memoryRetrieval: SERVICE.memoryRetrieval
    });
    check('T3.4 canonicalMemoryDeps 对生产依赖给出恰好 memoryStore + memoryRetrieval',
      Object.keys(prodShape).sort().join(',') === 'memoryRetrieval,memoryStore',
      Object.keys(prodShape));
    check('T3.5 缺 memoryStore 的装配**在装配期明确失败**（不返回半个网关）',
      (() => { try { SERVICE.canonicalMemoryDeps({ memoryRetrieval: SERVICE.memoryRetrieval }); return false; }
        catch (_) { return true; } })());
    check('T3.6 缺 memoryRetrieval 的装配同样明确失败',
      (() => { try { SERVICE.canonicalMemoryDeps({ memoryStore: SERVICE.memoryStore }); return false; }
        catch (_) { return true; } })());
    /* 反向守卫：召回器必须绑在**同一个** store 上。
       绑到另一个"能开、能查、永远返回空"的实例不会抛任何错，
       只会表现为失忆（这个坑在本轮修复中真的踩到过一次）——
       因此装配层必须能直接拒绝这种组合。 */
    const MISBOUND = require(path.join(ROOT, 'services', 'home-node', 'memory-retrieval.js'));
    const otherStore = SERVICE.memoryAssembly({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ib-hn-prodmem-t3b-')) });
    check('T3.6b 召回器暴露它绑定的 store（否则装配期无法校验）',
      SERVICE.memoryRetrieval.store === SERVICE.memoryStore,
      { retrievalStoreIsProcessStore: SERVICE.memoryRetrieval.store === SERVICE.memoryStore });
    check('T3.6c 召回器绑到另一个 store 实例时，装配期明确失败（不静默失忆）',
      (() => {
        try {
          SERVICE.canonicalMemoryDeps({
            memoryStore: otherStore.memoryStore,
            memoryRetrieval: MISBOUND({ store: SERVICE.memoryRetrieval.store, logger: () => {} })
          });
          return false;
        } catch (_) { return true; }
      })());

    /* 与 buildHomeNode 对照：同一函数 → 同一属性集合（这就是"不得再次漂移"）。 */
    const t3Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-hn-prodmem-t3-'));
    const app = SERVICE.buildHomeNode({ dataDir: t3Dir, logger: () => {} });
    app.open();
    const appShape = SERVICE.canonicalMemoryDeps({
      memoryStore: app.memoryStore, memoryRetrieval: app.memoryRetrieval
    });
    check('T3.7 buildHomeNode 与生产装配的 canonical memory 依赖定义完全一致',
      Object.keys(appShape).sort().join(',') === Object.keys(prodShape).sort().join(','),
      { production: Object.keys(prodShape), buildHomeNode: Object.keys(appShape) });
    check('T3.8 两边都真的持有可用 memory store（不是同一函数产出的 null）',
      !!prodShape.memoryStore && !!appShape.memoryStore &&
      typeof prodShape.memoryStore.listRecords === 'function' &&
      typeof appShape.memoryStore.listRecords === 'function');
    check('T3.9 生产侧与 buildHomeNode 侧是两个独立实例（不是把生产库悄悄复用进测试实例）',
      prodShape.memoryStore !== appShape.memoryStore);
    app.close();
  } finally {
    if (svc) { try { svc.child.kill(); } catch (_) { /* 已退出 */ } }
    await new Promise(r => setTimeout(r, 250));
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) { /* 尽力而为 */ }
  }

  console.log('');
  if (failed) {
    console.error('Home Node production memory assembly 测试失败：' + failed + ' 项 ✖（通过 ' + passed + '）');
    process.exitCode = 1;
  } else {
    console.log('Home Node production memory assembly tests passed ✔ (' + passed + ' 项)');
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
