'use strict';
/* Internal Beyond · Memory Home Node envelope 契约测试（static，零依赖，不开浏览器）
   运行：node tests/test_home_node_client_envelope.js

   为什么存在这个测试 —— 这是**已发生过的真实事故**，不是假想契约：

   `/memory/*` 由 services/home-node/mobile-gateway.js 服务，它把每个成功响应包成
   okBody() 信封 { v, ok:true, type, requestId, serverTime, payload:{…} }；
   而同一台 Home Node 的桌面聊天面（/list、/changes、/messages…）返回**裸对象**。
   两者形状不同，于是 assets/js/home-node-client.js 的 createMemoryRemote 与它的消费方
   assets/js/memory-authority.js 之间出现了 contract drift：

     · memory-authority hydrate() 读 `page.records` → undefined
       → `local.replaceAll(page.records || [])` 把浏览器镜像**清空**，
         随后仍置 `hydrated = true`（静默的假绿）；
     · memory-authority sync() 读 `res.upserts.length` → TypeError
       `Cannot read properties of undefined (reading 'length')`；
     · migrationState 读 `state.state` → undefined → 水位恒为 0，每次都全量重放。

   因此本测试逐端点断言"信封被解开、语义被保留"，并覆盖一个反向要求：
   **失败响应绝不能被解包成成功** —— 解包必须只发生在 ok:true 上。

   用 mock fetch 驱动**真实**的 createMemoryRemote（不是复制一份形状），
   因为漂移正好发生在这个边界上；mock 掉被测函数等于测不到它。 */

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'assets', 'js', 'home-node-client.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function section(title) { console.log('\n── ' + title + ' ──'); }

/* ── 浏览器环境替身 ──────────────────────────────────────────────────
   home-node-client.js 是 IIFE(window.IB)，并在模块顶层读 localStorage。
   只提供它真正用到的最小面：window、localStorage、fetch、AbortController。 */
function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); }
  };
}

/* 合成 res.text()/res.ok/res.status —— 与 _request 的实际读取面一致。
   字符串原样送出（用于"响应根本不是 JSON"的用例），其余对象 JSON 序列化。 */
function httpResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    text: () => Promise.resolve(typeof obj === 'string' ? obj : JSON.stringify(obj))
  };
}

function loadClient(seedStorage) {
  global.localStorage = makeStorage(seedStorage);
  global.AbortController = global.AbortController || require('abort-controller') || undefined;
  if (!global.AbortController) {
    /* 环境没有 AbortController 时 _request 会跳过超时装配（源码已容错），
       这会让 timeout 用例无从触发，因此提供一个最小实现。 */
    global.AbortController = class { constructor() { this.signal = {}; } abort() { this.signal.aborted = true; } };
  }
  global.window = {};
  delete require.cache[require.resolve(CLIENT)];
  require(CLIENT);
  return global.window.IB;
}

/* 服务端信封形状 —— 与 mobile-gateway.js okBody() 逐字段一致。 */
function okBody(type, payload) {
  return { v: 1, ok: true, type: type, requestId: null, serverTime: 1700000000000, payload: payload };
}
function errorBody(code, extra) {
  return {
    v: 1, ok: false, type: 'error', requestId: null, serverTime: 1700000000000,
    error: Object.assign({ code: code, message: code, retryable: false }, extra || {})
  };
}

/* 记录每一次出站请求，让断言可以证明"真的打到了哪条路径/方法"。 */
function recorder() {
  const calls = [];
  return { calls: calls, push: c => calls.push(c) };
}

function mem(id, over) {
  return Object.assign({
    id: id, kind: 'episodic', title: 'T' + id, summary: '', content: 'C' + id,
    domain: '日常', tags: [], valence: 0.5, arousal: 0.4, importance: 5, resolved: false,
    visibility: 'public', visibleTo: [], excludeFrom: [],
    activationCount: 0, created: 1000, lastActivated: 1000,
    createdBy: 'friend_a', createdByName: 'A', consolidatedFrom: [], lastConsolidatedAt: null
  }, over || {});
}

/* 用一个脚本化的 fetch 跑真实 remote；handler(pathname, init) 返回
   { status, body } 或直接抛错（模拟网络失败/超时）。 */
async function withFetch(handler, fn) {
  const rec = recorder();
  global.fetch = (url, init) => {
    const pathname = String(url).replace('http://127.0.0.1:23118', '');
    rec.push({ pathname: pathname, method: (init && init.method) || 'GET' });
    let out;
    try { out = handler(pathname, init || {}); }
    catch (error) { return Promise.reject(error); }
    if (!out || typeof out.then === 'function') return Promise.resolve(out);
    return Promise.resolve(httpResponse(out.status == null ? 200 : out.status, out.body));
  };
  try { return await fn(rec); } finally { delete global.fetch; }
}

(async function main() {

  /* ══════════════════════════════════════════════════════════════════
     A. /memory/list —— hydrate 的播种读取
     memory-authority.js:161 `local.replaceAll(page.records || [])`
     memory-authority.js:162 `ctx.cursor = Number(page.revision || 0)`
     ══════════════════════════════════════════════════════════════════ */
  section('A. /memory/list');

  const IB = loadClient({ ib_home_node_http: 'http://127.0.0.1:23118' });
  const remote = IB.createMemoryRemote({});
  const seeded = [mem('mem_1'), mem('mem_2'), mem('mem_3'), mem('mem_4'), mem('mem_5')];

  await withFetch(() => ({ status: 200, body: okBody('memory.list', { count: 5, revision: 5, truncated: false, records: seeded }) }), async (rec) => {
    const page = await remote.list({ limit: 500 });

    check('A1 请求打到 /memory/list 且带 limit', rec.calls.length === 1 && /^\/memory\/list\?limit=500$/.test(rec.calls[0].pathname), rec.calls);
    check('A2 records 是数组且长度为 5（不是 undefined）', Array.isArray(page.records) && page.records.length === 5, page.records && page.records.length);
    check('A3 count === 5', page.count === 5, page.count);
    check('A4 revision === 5', page.revision === 5, page.revision);
    check('A5 失败语义不受影响：page.ok === true', page.ok === true, page.ok);
    check('A6 信封元数据未被解包吞掉（status/protocolVersion 仍在）', page.status === 200 && page.protocolVersion === 1, { status: page.status, pv: page.protocolVersion });
    check('A7 记录正文保真（id 逐个一致）', page.records.map(r => r.id).join(',') === 'mem_1,mem_2,mem_3,mem_4,mem_5', page.records.map(r => r.id));
  });

  /* ownerId 过滤同样走这条路径，且不能被信封修复顺带弄坏。 */
  await withFetch(() => ({ status: 200, body: okBody('memory.list', { count: 1, revision: 5, truncated: false, records: [mem('mem_9')] }) }), async (rec) => {
    await remote.list({ ownerId: 'friend_x y', limit: 10 });
    check('A8 ownerId 被正确转义进 query', rec.calls[0].pathname === '/memory/list?ownerId=friend_x%20y&limit=10', rec.calls[0].pathname);
  });

  /* ══════════════════════════════════════════════════════════════════
     B. /memory/changes —— 增量同步
     memory-authority.js:138 `ctx.cursor = res.cursor`
     memory-authority.js:143 `res.upserts.length` / `res.deletes.length`
     （这一行就是线上抛 TypeError 的那一行）
     ══════════════════════════════════════════════════════════════════ */
  section('B. /memory/changes');

  await withFetch(() => ({
    status: 200,
    body: okBody('memory.changes', { cursor: 5, serverTime: 1700000000000, revision: 5, upserts: [{ record: mem('mem_1'), revision: 1 }], deletes: [], hasMore: false })
  }), async (rec) => {
    const res = await remote.changes(4, { limit: 200 });

    check('B1 请求打到 /memory/changes 且带 cursor/limit', rec.calls[0].pathname === '/memory/changes?cursor=4&limit=200', rec.calls[0].pathname);
    check('B2 upserts 是数组（不是 undefined）—— 这是线上 TypeError 的根因', Array.isArray(res.upserts), typeof res.upserts);
    check('B3 upserts.length 可安全读取', res.upserts.length === 1, res.upserts.length);
    check('B4 deletes 是数组（空也必须是数组）', Array.isArray(res.deletes) && res.deletes.length === 0, res.deletes);
    check('B5 cursor 正常（=== 5）', res.cursor === 5, res.cursor);
    check('B6 hasMore 保留', res.hasMore === false, res.hasMore);
    check('B7 upsert 元素形状保留（.record 可取到）', res.upserts[0].record.id === 'mem_1', res.upserts[0]);
    check('B8 ok 仍为 true', res.ok === true, res.ok);
  });

  /* cursor 为 0（未 hydrate 过）与非法 cursor 都要照常编码，不得 NaN。 */
  await withFetch(() => ({ status: 200, body: okBody('memory.changes', { cursor: 0, upserts: [], deletes: [], hasMore: false }) }), async (rec) => {
    await remote.changes(null);
    check('B9 非法 cursor 归一为 0（不产生 NaN）', rec.calls[0].pathname === '/memory/changes?cursor=0', rec.calls[0].pathname);
  });

  /* ══════════════════════════════════════════════════════════════════
     C. 空 canonical —— 必须返回空 records，而不是因信封读取失败产生 undefined
     这是"清空镜像"事故的最小复现形态：一旦这里是 undefined，
     memory-authority 会执行 replaceAll([]) 并宣布 hydrated=true。
     ══════════════════════════════════════════════════════════════════ */
  section('C. 空 canonical');

  await withFetch(() => ({ status: 200, body: okBody('memory.list', { count: 0, revision: 0, truncated: false, records: [] }) }), async () => {
    const page = await remote.list({ limit: 500 });
    check('C1 空 canonical：records 是空数组而非 undefined', Array.isArray(page.records) && page.records.length === 0, page.records);
    check('C2 空 canonical：count === 0 / revision === 0', page.count === 0 && page.revision === 0, { count: page.count, revision: page.revision });
    check('C3 空 canonical：ok === true（空不是失败）', page.ok === true, page.ok);
  });

  await withFetch(() => ({ status: 200, body: okBody('memory.changes', { cursor: 0, upserts: [], deletes: [], hasMore: false }) }), async () => {
    const res = await remote.changes(0);
    check('C4 空增量：upserts/deletes 均为空数组，length 可读', res.upserts.length === 0 && res.deletes.length === 0, res);
  });

  /* ══════════════════════════════════════════════════════════════════
     D. 失败语义 —— 解包**只能**发生在成功响应上
     反例（必须挡住）：若解包无条件执行，错误信封没有 payload，
     res.ok 仍是 false，调用方本来也不会误判；真正的危险是"把错误 payload
     当成功"，因此这里同时断言 ok 与非 ok 两类失败。
     ══════════════════════════════════════════════════════════════════ */
  section('D. 失败语义');

  await withFetch(() => ({ status: 422, body: errorBody('BAD_REQUEST', { detail: 'invalid-record' }) }), async () => {
    const res = await remote.put({ id: '' }, { requestId: 'r1' });
    check('D1 422：ok === false（错误 payload 绝不被当成功）', res.ok === false, res.ok);
    check('D2 422：error.code 保留', !!(res.error && res.error.code === 'BAD_REQUEST'), res.error);
    check('D3 422：HTTP status 保留（不改变错误处理路径）', res.status === 422, res.status);
    check('D4 422：没有把 payload 摊平（无 records 之类的幻影字段）', res.records === undefined, res.records);
  });

  await withFetch(() => ({ status: 501, body: errorBody('UNSUPPORTED') }), async () => {
    const res = await remote.list({});
    check('D5 501（memoryStore 未装配）：ok === false 且 records 为 undefined', res.ok === false && res.records === undefined, res);
    check('D6 501：error.code === UNSUPPORTED', res.error && res.error.code === 'UNSUPPORTED', res.error);
  });

  await withFetch(() => ({ status: 400, body: errorBody('BAD_REQUEST', { detail: 'bad-cursor' }) }), async () => {
    const res = await remote.changes(-1);
    check('D7 changes 400：ok === false，upserts 仍为 undefined（不被伪装成空数组）', res.ok === false && res.upserts === undefined, res);
  });

  /* 非 JSON 响应：_request 自行合成 invalid-response，无 payload，必须原样透出。 */
  await withFetch(() => ({ status: 200, body: '<html>proxy error</html>' }), async () => {
    const res = await remote.list({});
    check('D8 非 JSON 200：落回 invalid-response 语义，不抛异常', res && res.ok === false && res.error === 'invalid-response', res);
  });

  /* 传输失败：离线分类保持既有词表（memory-authority 依赖它判 retryable）。 */
  await withFetch(() => { throw new TypeError('Failed to fetch'); }, async () => {
    const res = await remote.list({});
    check('D9 网络失败：offline 分类与 retryable 语义不变', res.ok === false && res.offline === true && res.retryable === true && res.error === 'home-node-unreachable', res);
  });

  await withFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, async () => {
    const res = await remote.changes(0);
    check('D10 超时中止：classify 为 timeout（解包未介入）', res.ok === false && res.error === 'timeout' && res.retryable === true, res);
  });

  /* ══════════════════════════════════════════════════════════════════
     E. 其余 memory 端点 —— 不允许留下第二个同类 contract drift
     逐个核对 services/home-node/mobile-gateway.js 的实际返回：
       memory/records  POST → okBody('memory.put', …)      payload{outcome,id,revision,summary,results}
       memory/record   DEL  → okBody('memory.delete', …)   payload{outcome,id,revision,deleted}
       memory/activate POST → okBody('memory.activation',…) payload{updated,at,revisionTouched,revision}
       memory/settings POST → okBody('memory.settings', …)  payload{settings}
       memory/settings GET  → okBody('memory.settings', …)  （客户端无 GET 方法）
       memory/migration GET → okBody('memory.migration', …) payload{state}
       memory/migrate  POST → okBody('memory.migration', …) payload{ok,source,state}
     ══════════════════════════════════════════════════════════════════ */
  section('E. 其余端点');

  await withFetch(() => ({ status: 200, body: okBody('memory.put', { outcome: 'created', id: 'mem_1', revision: 5, summary: null, results: null }) }), async (rec) => {
    const res = await remote.put(mem('mem_1'), { requestId: 'w1', existingPolicy: 'overwrite' });
    check('E1 put：打到 POST /memory/records', rec.calls[0].pathname === '/memory/records' && rec.calls[0].method === 'POST', rec.calls[0]);
    check('E2 put：outcome / id / revision 到位', res.outcome === 'created' && res.id === 'mem_1' && res.revision === 5, res);
    check('E3 put：ok 保留', res.ok === true, res.ok);
  });

  await withFetch(() => ({ status: 200, body: okBody('memory.put', { outcome: 'batch', id: null, revision: 7, summary: { created: 2, updated: 0, skipped: 0, rejected: 0 }, results: [] }) }), async () => {
    const res = await remote.putBatch([mem('mem_1'), mem('mem_2')], { requestId: 'b1' });
    check('E4 putBatch：summary 可取（migration 的统计来源）', !!(res.summary && res.summary.created === 2), res.summary);
    check('E5 putBatch：results 是数组', Array.isArray(res.results), res.results);
    check('E6 putBatch：revision === 7', res.revision === 7, res.revision);
  });

  await withFetch(() => ({ status: 200, body: okBody('memory.delete', { outcome: 'deleted', id: 'mem_1', revision: 8, deleted: true }) }), async () => {
    const res = await remote.remove('mem_1', { requestId: 'd1' });
    check('E7 remove：outcome / deleted / revision 到位', res.outcome === 'deleted' && res.deleted === true && res.revision === 8, res);
    check('E8 remove：revision != null（memory-authority 靠它推游标）', res.revision != null, res.revision);
  });

  await withFetch(() => ({ status: 200, body: okBody('memory.activation', { updated: 3, at: 1700000000123, revisionTouched: false, revision: 8 }) }), async () => {
    const res = await remote.activate(['mem_1', 'mem_2', 'mem_3'], { at: 1700000000123 });
    check('E9 activate：updated === 3', res.updated === 3, res.updated);
    check('E10 activate：revisionTouched 被如实透出', res.revisionTouched === false, res.revisionTouched);
  });

  await withFetch(() => ({ status: 200, body: okBody('memory.settings', { settings: { budget: 12, contentLen: 300 } }) }), async () => {
    const res = await remote.putSettings({ budget: 12, contentLen: 300 });
    check('E11 settings：res.settings 可取（原来会是 undefined → settings:null）', !!(res.settings && res.settings.budget === 12), res.settings);
    check('E12 settings：ok 保留', res.ok === true, res.ok);
  });

  await withFetch(() => ({ status: 200, body: okBody('memory.migration', { state: { source: 'default', version: 3, lastTimestamp: 1700, records: 5, idSet: ['mem_1'] } }) }), async () => {
    const res = await remote.migrationState('default');
    check('E13 migrationState：res.state 可取（memory-authority 读 state.state）', !!(res.state && res.state.version === 3), res.state);
    check('E14 migrationState：水位 lastTimestamp 保真（否则每次全量重放）', res.state.lastTimestamp === 1700, res.state && res.state.lastTimestamp);
  });

  await withFetch(() => ({ status: 200, body: okBody('memory.migration', { ok: true, source: 'default', state: { source: 'default', version: 4, lastTimestamp: 1800, records: 5, idSet: [] } }) }), async () => {
    const res = await remote.markMigration('default', { version: 4, lastTimestamp: 1800 });
    check('E15 markMigration：mark.state 可取', !!(res.state && res.state.version === 4), res.state);
    check('E16 markMigration：payload 里嵌套的 ok:true 不破坏信封 ok', res.ok === true, res.ok);
  });

  /* /health 不带 payload —— 解包必须对此完全无副作用。 */
  await withFetch(() => ({ status: 200, body: { v: 1, ok: true, service: 'internal-beyond-home-node', protocolVersion: 1 } }), async () => {
    const res = await remote.health();
    check('E17 /health（无 payload）：原样返回，不被解包破坏', res.ok === true && res.service === 'internal-beyond-home-node', res);
  });

  /* ══════════════════════════════════════════════════════════════════
     F. 反向断言：解包是"摊平"而不是"替换"
     信封元数据一旦丢失，登录/诊断/协议版本校验会静默失效。
     ══════════════════════════════════════════════════════════════════ */
  section('F. 元数据保留');

  await withFetch(() => ({ status: 200, body: okBody('memory.list', { count: 1, revision: 2, truncated: true, records: [mem('mem_1')] }) }), async () => {
    const page = await remote.list({});
    check('F1 元数据保留：ok / status / protocolVersion', page.ok === true && page.status === 200 && page.protocolVersion === 1, { ok: page.ok, status: page.status, pv: page.protocolVersion });
    check('F2 元数据保留：type / v / serverTime', page.type === 'memory.list' && page.v === 1 && page.serverTime === 1700000000000, { type: page.type, v: page.v, serverTime: page.serverTime });
    check('F3 payload 字段与元数据共存（truncated 也在顶层）', page.truncated === true, page.truncated);
  });

  /* ══════════════════════════════════════════════════════════════════
     G. 与 memory-authority 的真实消费形态联调（最小回环）
     前面都是逐字段断言；这里直接复刻 memory-authority 里那两行线上代码，
     证明修复后它们不再产生"清空镜像"和 TypeError。
     ══════════════════════════════════════════════════════════════════ */
  section('G. 消费侧回环');

  await withFetch(() => ({ status: 200, body: okBody('memory.list', { count: 5, revision: 5, truncated: false, records: seeded }) }), async () => {
    const page = await remote.list({ limit: 500 });
    let replacedWith = null;
    const local = { replaceAll: rows => { replacedWith = rows; return Promise.resolve(); } };
    /* memory-authority.js:161 原文 */
    await local.replaceAll(page.records || []);
    check('G1 hydrate 回环：replaceAll 收到 5 条而非空数组（镜像不再被清空）', Array.isArray(replacedWith) && replacedWith.length === 5, replacedWith && replacedWith.length);
    /* memory-authority.js:162 原文 */
    check('G2 hydrate 回环：cursor 落到 revision（5）', Number(page.revision || 0) === 5, page.revision);
  });

  await withFetch(() => ({ status: 200, body: okBody('memory.changes', { cursor: 5, upserts: [{ record: mem('mem_1') }], deletes: [], hasMore: false }) }), async () => {
    const res = await remote.changes(4);
    let threw = null, upsertsLen = null;
    try { upsertsLen = res.upserts.length; } catch (error) { threw = error; }
    check('G3 sync 回环：res.upserts.length 不再抛 TypeError', threw === null && upsertsLen === 1, threw ? String(threw.message) : upsertsLen);
    /* memory-authority.js:184 原文 */
    const records = res.upserts.map(u => u.record);
    check('G4 sync 回环：upserts.map(u => u.record) 得到真实记录', records.length === 1 && records[0].id === 'mem_1', records);
  });

  console.log('\n' + (failed === 0 ? '全部通过' : '存在失败') + '：' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;

})().catch(error => {
  console.error('✖ 未捕获异常：' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
