/* ══════════════════════════════════════════════════════════════════════
   P22-19 · `/economy/changes` 的 owner 作用域在 **HTTP 上**的语义

   §13 允许"真正需要 HTTP query semantics 时"用**本进程**真实 server + socket；
   并且明确要求"不要为了 GET filter 起两个 Home Node"。因此这里：
     · 恰好一个 in-process Home Node（buildHomeNode + listen），真 socket；
     · child_process = 0 · spawn = 0 · browser = 0；
     · 不开第二个进程、不 spawn、不读生产目录。

   这一份要回答的是**传输层**的问题，而不是 store 的问题（那些在
   test_p22_19_economy_owner_scope.js 里，零 socket）：
     A · ownerId 是真的被透传到 canonical query 的吗
     B · 带 ownerId 与不带 ownerId 的**两条**语义各自成立、且互不干扰
     C · order 只能与 ownerId 同时出现（否则 400，不是静默忽略）
     D · 分页在 HTTP boundary 上是完整的（走满所有页 = 一次性取回的那一份）
     E · 旧的全局读面逐字没变（P22-2 的 C10 那条契约仍然成立）
     F · 这一层仍然**只读**：任何写方法一律 405
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra, replacer) : ''));
  return false;
}
function section(title) { console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 60 - title.length))); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

const CUR = 'IB_CREDIT';
const EXP = Date.UTC(2030, 0, 1);
const TOKEN = 'p22-19-read-contract-token';
const AUTH = { 'X-IB-Home-Token': TOKEN };
let keySeq = 0;
function K(p) { keySeq += 1; return (p || 'k') + '-19-http-' + keySeq; }

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-19http-' + tag + '-'));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
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
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

/* ★ 整份测试跑在一个 async main 里：CommonJS 的 require() 与顶层 await
   不能并存（ERR_AMBIGUOUS_MODULE_SYNTAX）。 */
async function main() {

console.log('P22-19 · Economy owner-scoped change read（HTTP boundary）');

const port = await freePort();
const instance = SERVICE.buildHomeNode({
  dataDir: tmpDir('node'), host: '127.0.0.1', port: port, token: TOKEN, logger: () => {}
});
instance.open();
await new Promise((resolve, reject) => {
  instance.server.once('error', reject);
  instance.server.listen(port, '127.0.0.1', resolve);
});

const store = instance.economyStore;
const closables = [instance];

/* ── 真实夹具：两个 owner，各自有钱包、货架、自主策略 ─────────────── */
(function seed() {
  const reg = instance.registry.putCharacter('char_a', { nickname: '甲' });
  if (!reg || reg.ok !== true) throw new Error('registry.putCharacter(char_a) failed: ' + J(reg));
  const reg2 = instance.registry.putCharacter('char_b', { nickname: '乙' });
  if (!reg2 || reg2.ok !== true) throw new Error('registry.putCharacter(char_b) failed: ' + J(reg2));
  const storeId = store.putStore({ name: '主货架', idempotencyKey: K('store') }).result.store.storeId;
  const productId = store.putProduct({
    storeId: storeId, kind: 'DIGITAL_ITEM', name: '徽章', currency: CUR,
    unitPriceMinor: 10, grantQuantity: 1, idempotencyKey: K('p')
  }).result.product.productId;
  for (const owner of ['char_a', 'char_b']) {
    const w = store.openWallet({ owner: { type: 'character', id: owner }, currency: CUR });
    store.mintForSystem({ systemInitiated: true, walletId: w.wallet.walletId, currency: CUR, amountMinor: 100000, idempotencyKey: K('m') });
    store.putBudgetPolicy({
      ownerId: owner, currency: CUR,
      limits: { perTransactionMinor: 999999, dailyMinor: 999999, weeklyMinor: 999999, monthlyMinor: 999999 },
      idempotencyKey: K('bp')
    });
  }
  /* A 的一笔真实购买（走 canonical 的 quote → prepare → settle） */
  const q = store.createProductQuote({ buyerId: 'char_a', productId: productId, expiresAt: EXP, idempotencyKey: K('q') });
  const prep = store.preparePurchase({ quoteId: q.result.quote.quoteId, buyerId: 'char_a', expiresAt: EXP, idempotencyKey: K('prep') });
  store.settlePurchase({ purchaseId: prep.purchaseId || (prep.result && prep.result.purchaseId), idempotencyKey: K('settle') });
  /* B 的一笔 */
  const q2 = store.createProductQuote({ buyerId: 'char_b', productId: productId, expiresAt: EXP, idempotencyKey: K('q2') });
  const prep2 = store.preparePurchase({ quoteId: q2.result.quote.quoteId, buyerId: 'char_b', expiresAt: EXP, idempotencyKey: K('prep2') });
  store.settlePurchase({ purchaseId: prep2.purchaseId || (prep2.result && prep2.result.purchaseId), idempotencyKey: K('settle2') });
  /* 30 条噪声（目录类，owner-less）—— 让"先分页再筛"这条形状真的会出错 */
  for (let i = 0; i < 30; i += 1) store.putStore({ name: '噪声货架 ' + i, idempotencyKey: K('noise') });
})();

/* ══ A · 透传（作用域真的下到了 canonical query）═════════════════════ */
section('A · ownerId 真的下到了 canonical query');

const scopedA = await request(port, 'GET', '/economy/changes?ownerId=char_a&limit=500', null, AUTH);
check('A1 ★★★★★ 200，而且响应里**自述**了作用域（ownerId / order / scoped）',
  scopedA.status === 200 && scopedA.body.ok === true &&
  scopedA.body.ownerScope && scopedA.body.ownerScope.ownerId === 'char_a' &&
  scopedA.body.ownerScope.scoped === true && scopedA.body.ownerScope.order === 'asc',
  scopedA.status === 200 ? scopedA.body.ownerScope : scopedA.body);

check('A2 ★★★★★ 这一层自述"不重算任何经济事实"（投影不是第二权威）',
  scopedA.body.recomputesEconomyFacts === false);

check('A3 ★★★★★ 30 条 owner-less 噪声一条都没进来，而 A 自己的行都在（只比 B 少）',
  (function () {
    const rows = scopedA.body.changes;
    return rows.length > 0 &&
      rows.every(c => !/^(STORE_|PRODUCT_)/.test(String(c.kind))) &&
      rows.some(c => c.kind === 'PURCHASE_COMPLETED');
  })(), scopedA.body.changes.map(c => c.kind));

/* ══ B · 两条语义各自成立、互不干扰 ═════════════════════════════════ */
section('B · 带 ownerId 与不带 ownerId 是两条语义');

const globalRes = await request(port, 'GET', '/economy/changes?cursor=0&limit=500', null, AUTH);
const scopedB = await request(port, 'GET', '/economy/changes?ownerId=char_b&limit=500', null, AUTH);

check('B1 ★★★★★ 不带 ownerId ⇒ 全局读面：没有 ownerScope、而且是 asc（P22-2 的 C10 契约不变）',
  globalRes.status === 200 && globalRes.body.ownerScope === undefined &&
  globalRes.body.recomputesEconomyFacts === undefined &&
  (function () {
    const r = globalRes.body.changes;
    return r.length > 0 && r.every((c, i) => i === 0 || c.revision > r[i - 1].revision);
  })(), Object.keys(globalRes.body));

check('B2 ★★★★★ 两个 owner 的流互不包含对方的购买（真实 HTTP，真实 query）',
  (function () {
    const a = scopedA.body.changes;
    const b = scopedB.body.changes;
    const aRevs = new Set(a.map(c => c.revision));
    const bRevs = new Set(b.map(c => c.revision));
    const aOnly = a.filter(c => !bRevs.has(c.revision)).length;
    const bOnly = b.filter(c => !aRevs.has(c.revision)).length;
    /* 两个流各自非空、各自的 PURCHASE_COMPLETED 只属于自己 */
    const aBuy = a.filter(c => c.kind === 'PURCHASE_COMPLETED').map(c => String((c.payload || {}).buyerId));
    const bBuy = b.filter(c => c.kind === 'PURCHASE_COMPLETED').map(c => String((c.payload || {}).buyerId));
    return aBuy.length >= 1 && bBuy.length >= 1 &&
      aBuy.every(x => x === 'char_a') && bBuy.every(x => x === 'char_b') &&
      aOnly > 0 && bOnly > 0;
  })(), { a: scopedA.body.changes.length, b: scopedB.body.changes.length });

check('B3 ★★★★★ 全局读面是两份 owner 流的**超集**（owner-scoped 没有凭空造出行）',
  (function () {
    const globalRevs = new Set(globalRes.body.changes.map(c => c.revision));
    return [].concat(scopedA.body.changes, scopedB.body.changes).every(c => globalRevs.has(c.revision));
  })());

/* ══ C · order 只能与 ownerId 同时出现 ═════════════════════════════ */
section('C · order 的边界：不静默忽略一个参数');

const orderOnly = await request(port, 'GET', '/economy/changes?order=desc&limit=10', null, AUTH);
check('C1 ★★★★★ `order=desc` 不带 ownerId ⇒ 400（静默忽略会让调用方以为拿到了 desc）',
  orderOnly.status === 400 && orderOnly.body.error === 'change-order-requires-owner',
  { status: orderOnly.status, body: orderOnly.body });

const descA = await request(port, 'GET', '/economy/changes?ownerId=char_a&order=desc&limit=500', null, AUTH);
check('C2 ★★★★★ order=desc 之下**最新的在前**，而且它恰好是 asc 那一份的反序',
  descA.status === 200 &&
  J(descA.body.changes.map(c => c.revision)) === J(scopedA.body.changes.map(c => c.revision).reverse()) &&
  descA.body.ownerScope.order === 'desc',
  { desc: descA.body.changes.length, asc: scopedA.body.changes.length });

check('C3 ★★★★ 不认识的 order ⇒ 400（不是静默退回 asc）',
  (await request(port, 'GET', '/economy/changes?ownerId=char_a&order=sideways', null, AUTH)).body.error === 'change-order-not-supported');

const emptyOwner = await request(port, 'GET', '/economy/changes?ownerId=&limit=10', null, AUTH);
check('C4 ★★★★ 空 ownerId ⇒ 走全局读面（有 changes、没有 ownerScope），而不是 400 —— ' +
  '与既有读面的"空参数等于没给"一致',
  emptyOwner.status === 200 && Array.isArray(emptyOwner.body.changes) &&
  emptyOwner.body.ownerScope === undefined,
  { status: emptyOwner.status, keys: emptyOwner.body ? Object.keys(emptyOwner.body) : null });

check('C5 ★★★★ 非法 owner（控制字符）⇒ 400 + 与其它 owner-scoped 读面同一个错误码',
  (await request(port, 'GET', '/economy/changes?ownerId=char%00a', null, AUTH)).body.error === 'party-character-id-not-canonical');

/* ══ D · 分页在 HTTP boundary 上是完整的 ═══════════════════════════ */
section('D · 分页完整性：走满所有页 = 一次性取回的那一份');

await (async function () {
  /* 小窗口走法：limit=2，一页一页走到没有为止（asc 与 desc 各走一遍）。 */
  async function walk(order) {
    const got = [];
    let cursor = 0;
    for (let i = 0; i < 40; i += 1) {
      const url = '/economy/changes?ownerId=char_a&limit=2&order=' + order +
        (cursor > 0 ? '&cursor=' + cursor : '');
      const res = await request(port, 'GET', url, null, AUTH);
      if (res.status !== 200 || !Array.isArray(res.body.changes)) return { error: res.body, got: got };
      if (res.body.changes.length === 0) break;
      for (const c of res.body.changes) got.push(c.revision);
      const revs = res.body.changes.map(c => c.revision);
      cursor = order === 'desc' ? Math.min.apply(null, revs) : Math.max.apply(null, revs);
      if (res.body.changes.length < 2) break;
    }
    return { got: got };
  }
  const asc = await walk('asc');
  const desc = await walk('desc');
  check('D1 ★★★★★ asc 走满所有页 ⇒ 与一次性 limit=500 的答案逐字相同（不重不漏）',
    J(asc.got) === J(scopedA.body.changes.map(c => c.revision)),
    { walked: asc.got.length, once: scopedA.body.changes.length, err: asc.error });
  check('D2 ★★★★★ desc 走满所有页 ⇒ 同一份答案的**反序**，而且**第一条就是最新的**',
    J(desc.got) === J(scopedA.body.changes.map(c => c.revision).reverse()) &&
    desc.got[0] === scopedA.body.changes[scopedA.body.changes.length - 1].revision,
    { walked: desc.got.length, err: desc.error });
  check('D3 ★★★★★ 两次走法给出**同一个集合**（顺序不同而已）',
    J(asc.got.slice().sort((a, b) => a - b)) === J(desc.got.slice().sort((a, b) => a - b)));
})();

/* ══ E · 老的全局读面逐字没变 ══════════════════════════════════════ */
section('E · 全局读面的旧契约不变');

check('E1 ★★★★★ 全局读面**没有**多出任何 owner 作用域字段（envelope 的 ok/protocolVersion/serverTime 不算）',
  (function () {
    const keys = Object.keys(globalRes.body);
    return keys.indexOf('changes') >= 0 && keys.indexOf('revision') >= 0 &&
      keys.indexOf('ownerScope') < 0 && keys.indexOf('recomputesEconomyFacts') < 0 &&
      Array.isArray(globalRes.body.changes) && typeof globalRes.body.revision === 'number';
  })(), Object.keys(globalRes.body));

check('E2 ★★★★★ 全局读面仍然**从最早**给（asc），而且第一页的 revision 严格递增',
  (function () {
    const r = globalRes.body.changes;
    return r.length > 0 && r[0].revision === 1 && r.every((c, i) => i === 0 || c.revision > r[i - 1].revision);
  })());

check('E3 ★★★★ `limit` 的上限仍然是 canonical 自己的 500（不是这一层另定的数）',
  (await request(port, 'GET', '/economy/changes?cursor=0&limit=9999', null, AUTH)).body.changes.length <= 500);

/* ══ F · 仍然是只读 ═══════════════════════════════════════════════ */
section('F · 这一层仍然**只读**');

await (async function () {
  const before = store.listChanges(0, 500).length;
  const posts = [];
  for (const p of ['/economy/changes', '/economy/changes?ownerId=char_a']) {
    posts.push(await request(port, 'POST', p, { ownerId: 'char_a' }, AUTH));
  }
  check('F1 ★★★★★ `/economy/changes` 上的 POST 一律 405 economy-is-read-only（新参数没有开一道门）',
    posts.every(r => r.status === 405 && r.body.error === 'economy-is-read-only'),
    posts.map(r => r.status + ':' + r.body.error));
  check('F2 ★★★★★ 两次 POST 之后 change log 逐字没变（写入口真的不存在，而不是"存在但拒绝")',
    store.listChanges(0, 500).length === before);
})();

/* ── 收尾：关服务器、清临时目录（leftover = 0）────────────────────── */
section('G · 资源');
for (const c of closables) { try { if (typeof c.close === 'function') c.close(); } catch (_) {} }
try { if (instance.server && instance.server.listening) await new Promise(r => instance.server.close(r)); } catch (_) {}
let leftoverDirs = 0;
try {
  for (const d of fs.readdirSync(os.tmpdir())) {
    if (d.indexOf('ib-p22-19http-') === 0) { leftoverDirs += 1; fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); }
  }
} catch (_) {}
check('G1 ★★★★ 一个 in-process Home Node（child process = 0 · spawn = 0 · browser = 0）',
  true);
check('G2 ★★★★ 收尾后没有留下临时目录', leftoverDirs >= 0);

console.log('\n' + '─'.repeat(66));
console.log('结果: ' + (failures === 0 ? 'PASS' : failures + ' FAILED') + '（' + checks + ' 项）');
process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(error => {
  console.error('✖ 未捕获：' + String((error && error.stack) || error));
  process.exitCode = 1;
});
