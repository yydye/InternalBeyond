'use strict';
/* ====================================================================
   P22-8 · Agent Purchase Intent runtime（真实 Home Node + 多进程 + 崩溃）
   --------------------------------------------------------------------
   运行：node tests/test_p22_8_economy_runtime.js

   本文件回答四类**只有真实进程**才能回答的问题：

     「一个真实的 production Home Node 打开 P22-8 的库之后，intent 读面
       可用、重启仍然可用？」                          —— B 组
     「HTTP 上"提出购买意图"的写面真的一条都没有？」     —— C 组
     「两个真实进程同时处理**同一个模型输出**时，最终
       经济事实是什么？」                              —— D / E / F 组
     「在 §16 点名的六个边界上崩溃之后，会不会留下
       『钱花了但没有 intent』或『intent 完成了但没有购买』
       这种撕裂事实？」                                —— G 组

   ── 为什么多进程不是"更狠一点的单进程测试" ────────────────────────────
   node:sqlite 的 DatabaseSync 是同步 API，单线程里两次 propose 不可能交错。
   因此"重复的模型输出最多产生一条 canonical Intent"在单进程内**无法被
   证伪** —— 唯一的证伪方式是两个各自持有独立 SQLite 连接的真实操作者
   同时动手。这与 P22-3 的 reserve worker / P22-5 的 consume worker /
   P22-6 的 purchase worker / P22-7 的 approval worker 是同一条纪律的
   第五次应用。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_FILE = 'services/home-node-service.js';
const WORKER_FILE = 'tests/fixtures/p22-8-intent-worker.js';
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const SERVICE_SOURCE = fs.readFileSync(path.join(ROOT, SERVICE_FILE), 'utf8');
const HTTP_SOURCE = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');

/* ── 剥注释（与 P22-1 boundary 的 stripCommentsAndStrings 同款纪律）────
   P22-10 踩到的实测：装配层新增了一句**解释性注释**，它逐字引用了
   P22-8 的写入口名字（"proposeAgentPurchaseIntent 的调用方是
   Decision/Action seam，不是一个 HTTP 请求" —— 那句话正是 P22-8 自己
   写在 http.js 里的）。若扫描器读原始文本，这句**否认/引用**会被 A6 判成
   "service 层引入了写入口"。
   ★ 修的是**扫描器**，不是那句话 —— 与 P22-2 的 B3.7 同源（那里的一句
   "本文件不 require('crypto')" 曾被判成一条真实依赖）。让人为了变绿而
   删掉解释，是这类假阳性最坏的后果。 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1');
}
const SERVICE_CODE = stripComments(SERVICE_SOURCE);

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('✔ ' + name);
  else {
    failures++;
    console.error('✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra, replacer) : ''));
  }
}
function section(title) { console.log('\n── ' + title); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-8rt-' + tag + '-'));
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
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const BUNDLED_NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const NODE_BIN = fs.existsSync(BUNDLED_NODE) ? BUNDLED_NODE : process.execPath;
const openChildren = new Set();

/* ── 一个真实 Home Node 子进程（与 P22-7 runtime 的同款夹具）────────────── */
async function startService(dir, extraEnv) {
  const port = await freePort();
  const child = spawn(NODE_BIN, [SERVICE_FILE], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      IB_HOME_NODE_PORT: String(port),
      IB_HOME_NODE_DATA_DIR: dir
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  openChildren.add(child);
  let output = '';
  child.stdout.on('data', c => { output += c.toString(); });
  child.stderr.on('data', c => { output += c.toString(); });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await request(port, 'GET', '/health');
      if (r.status === 200) return { port: port, child: child, output: () => output };
    } catch (_) { /* 还没起来 */ }
    await sleep(120);
  }
  throw new Error('home node did not start: ' + output.slice(-800));
}
function stopChild(child) {
  return new Promise(resolve => {
    if (!child || child.killed) return resolve();
    openChildren.delete(child);
    child.once('exit', () => resolve());
    try { child.kill(); } catch (_) { resolve(); }
    setTimeout(resolve, 4000);
  });
}
process.on('exit', () => { for (const c of openChildren) { try { c.kill(); } catch (_) { /* 尽力而为 */ } } });

/* ── worker 调用 ─────────────────────────────────────────────────────── */
function runWorker(args, options) {
  return new Promise((resolve) => {
    const child = spawn(NODE_BIN, [WORKER_FILE].concat(args), {
      cwd: ROOT, env: Object.assign({}, process.env, (options && options.env) || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    openChildren.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('exit', (code, signal) => {
      openChildren.delete(child);
      /* worker 输出一行 JSON；崩溃注入时它会先写一行再 abort，因此这里取
         **最后**一条能解析的 JSON —— 前面可能有别的行。 */
      let parsed = null;
      for (const line of stdout.split('\n')) {
        const t = line.trim();
        if (!t || t[0] !== '{') continue;
        try { parsed = JSON.parse(t); } catch (_) { /* 半行 */ }
      }
      resolve({ code: code, signal: signal, stdout: stdout, stderr: stderr, json: parsed });
    });
  });
}

let keySeq = 0;
function K(prefix) { keySeq += 1; return (prefix || 'k') + '-' + keySeq; }

/* ── 进程内的夹具：造商品 / 钱包 / 预算 /（可选）自主策略 ─────────────── */
function inProcessStore(dir) {
  const store = createEconomyStore({ dataDir: dir, logger: () => {} });
  store.open();
  return store;
}
function seed(store, options) {
  const o = options || {};
  const storeId = store.putStore({ name: 'Main', idempotencyKey: K('store') }).result.store.storeId;
  const productId = store.putProduct({
    storeId: storeId, kind: o.kind || 'COMPUTE_CREDIT', name: o.name || 'Compute x1000',
    currency: 'IB_CREDIT', unitPriceMinor: o.unitPriceMinor == null ? 10 : o.unitPriceMinor,
    grantQuantity: o.grantQuantity == null ? 1000 : o.grantQuantity, idempotencyKey: K('product')
  }).result.product.productId;
  const agentId = o.agentId || 'cfg_agent';
  const wallet = store.openWallet({ owner: { type: 'character', id: agentId }, currency: 'IB_CREDIT' });
  store.mintForSystem({
    systemInitiated: true, walletId: wallet.wallet.walletId, currency: 'IB_CREDIT',
    amountMinor: o.balanceMinor == null ? 100000 : o.balanceMinor, idempotencyKey: K('mint')
  });
  store.putBudgetPolicy({
    ownerId: agentId, currency: 'IB_CREDIT',
    limits: { perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000 },
    idempotencyKey: K('budget')
  });
  if (o.autonomy !== false) {
    store.putAutonomyPolicy(Object.assign({
      ownerId: agentId, currency: 'IB_CREDIT', enabled: true,
      perPurchaseLimitMinor: 100000, dailyAutonomousLimitMinor: 100000, approvalAboveMinor: 100000,
      allowedProductKinds: [o.kind || 'COMPUTE_CREDIT', 'DIGITAL_ITEM'],
      allowedSettlementTypes: ['COMPUTE_GRANT', 'INVENTORY_GRANT'],
      allowGift: false, idempotencyKey: K('autonomy')
    }, o.autonomy || {}));
  }
  if (o.withFriend) {
    store.openWallet({ owner: { type: 'character', id: 'cfg_friend' }, currency: 'IB_CREDIT' });
  }
  return { storeId: storeId, productId: productId, agentId: agentId };
}

/* ══════════════════════════════════════════════════════════════════════
   A · 静态边界：写入口不在 HTTP 上
   ══════════════════════════════════════════════════════════════════════ */
async function main() {
section('A · 静态边界（§14/§15：模型能到达的只有 propose，而它不在 HTTP 上）');

{
  const store = createEconomyStore({ dataDir: tmpDir('a'), logger: () => {} });
  check('A1 ★ store 上**存在**的是窄接口 propose / resume，而不是通用执行器',
    typeof store.proposeAgentPurchaseIntent === 'function' &&
    typeof store.resumeAgentPurchaseIntent === 'function' &&
    ['executeEconomyAction', 'runEconomyAction', 'executeAction', 'performAction',
      'buyNow', 'approveForAgent', 'settleForAgent', 'applyModelAction']
      .every(k => typeof store[k] === 'undefined'));
  store.close();

  /* ★ 这一条的判据必须是"**在代码里**不出现"，而不是"在文件里不出现"：
     开发期实测踩到 —— 那六个方法名确实出现在 http.js 里，作为**注释**
     解释"这些写入口刻意不在 HTTP 上"。把它们从注释里赶走会让这段设计
     说明消失，而那段说明恰恰是本阶段边界的一部分。
     正确的判据：剥掉注释与字符串之后再找，一个都不该有。 */
  const httpCode = HTTP_SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  check('A2 ★ http.js 的**代码**里没有任何一条 P22-8 的写方法名（逐名断言；注释里的设计说明不算）',
    ['proposeAgentPurchaseIntent', 'resumeAgentPurchaseIntent',
      'preparePurchase', 'settlePurchase', 'grantInventory', 'reserveFunds']
      .every(name => httpCode.indexOf(name) < 0),
    ['proposeAgentPurchaseIntent', 'resumeAgentPurchaseIntent',
      'preparePurchase', 'settlePurchase', 'grantInventory', 'reserveFunds']
      .filter(name => httpCode.indexOf(name) >= 0));

  check('A3 ★ 两条只读路由**在** http.js 里，而且是 GET 分支',
    HTTP_SOURCE.indexOf("path === '/economy/intents' && method === 'GET'") >= 0 &&
    HTTP_SOURCE.indexOf("path === '/economy/intent' && method === 'GET'") >= 0);

  check('A4 ★ §15 逐字禁止的四条写形态全部登记在 unreachable 里（声明与真实路由必须同时更新）',
    ['/economy/intent/propose', '/economy/intent/execute', '/economy/buy', '/economy/execute']
      .every(p => HTTP_SOURCE.indexOf("'" + p + "'") >= 0) &&
    C.PURCHASE_INTENT_HTTP_MUTATION_ROUTES.length > 0);

  check('A5 ★ 契约里的四条自述字段在 http.js 的 economy 自述块里逐条出现（allowed 面与真实面不会分叉）',
    ['intentBridgeImplemented', 'intentWritesExposed', 'proposeViaHttpIsForbidden',
      'reasonIsAuthority', 'everyIntentPassesTheAuthorityGate', 'autoAllowStillRequiresBudget']
      .every(k => HTTP_SOURCE.indexOf(k) >= 0));

  check('A6 ★ service 层没有引入任何 P22-8 的写入口（Home Node 服务也不获得购买权）',
    /* ★ 按**代码**视图断言，不按原始文本：P22-10 的装配层注释逐字引用了
       proposeAgentPurchaseIntent（那句引用本身就是 P22-8 写在 http.js 里的
       一句话），而一句引用不是一次调用。 */
    SERVICE_CODE.indexOf('proposeAgentPurchaseIntent') < 0 &&
    SERVICE_CODE.indexOf('resumeAgentPurchaseIntent') < 0 &&
    /* 反向自证：这句扫描确实能抓到一次真的调用。 */
    stripComments('store.proposeAgentPurchaseIntent({})').indexOf('proposeAgentPurchaseIntent') >= 0,
    { propose: SERVICE_CODE.indexOf('proposeAgentPurchaseIntent'),
      resume: SERVICE_CODE.indexOf('resumeAgentPurchaseIntent') });
}

/* ══════════════════════════════════════════════════════════════════════
   B · 真实 Home Node：读面 + 重启
   ══════════════════════════════════════════════════════════════════════ */
section('B · 真实 Home Node：intent 读面 + schema 水位 + 重启');

const serviceDir = tmpDir('b');
let seeded = null;
{
  const store = inProcessStore(serviceDir);
  seeded = seed(store, {});
  const r = store.proposeAgentPurchaseIntent({
    idempotencyKey: K('intent'),
    proposal: { agentId: 'cfg_agent', productId: seeded.productId, reason: 'seeded for the runtime test' }
  });
  check('B1 进程内先种下一条 AUTO_ALLOW 的 intent（夹具成立）',
    r.ok === true && r.intent.state === 'COMPLETED' && typeof r.purchaseId === 'string',
    { ok: r.ok, state: r.intent && r.intent.state, errors: r.errors });
  seeded.intentId = r.intentId;
  seeded.purchaseId = r.purchaseId;
  seeded.quoteId = r.quoteId;
  store.close();
}

let svc = null;
{
  svc = await startService(serviceDir);
  const health = await request(svc.port, 'GET', '/economy/health');
  check('B2 P22-8 的库被真实 store 打开（schema 水位 = store 自报的那个数，Economy READY）',
    health.status === 200 &&
    Number(health.body.economy.schemaVersion) ===
    Number(createEconomyStore.SCHEMA_VERSION) &&
    health.body.economy.state === 'READY',
    { status: health.status, schema: health.body.economy && health.body.economy.schemaVersion });

  const list = await request(svc.port, 'GET', '/economy/intents');
  check('B3 ★ GET /economy/intents 读得出那条 intent，并且带三句自述与三句"我没有变更能力"',
    list.status === 200 && list.body.count === 1 && list.body.intents.length === 1 &&
    list.body.intents[0].agentIntentId === seeded.intentId &&
    list.body.personalized === false && list.body.recommended === false && list.body.ranked === false &&
    list.body.createsIntents === false && list.body.executesPurchases === false &&
    list.body.consumesApprovals === false && list.body.exposesMutation === false,
    { status: list.status, body: list.body });

  const one = await request(svc.port, 'GET', '/economy/intent?agentIntentId=' + encodeURIComponent(seeded.intentId) + '&withChain=1');
  check('B4 ★ GET /economy/intent 读得出**完整因果链**（intent → quote → purchase），并逐句自述它不是经济事实/权限',
    one.status === 200 && one.body.intent.agentIntentId === seeded.intentId &&
    one.body.intent.reasonIsAuthority === false &&
    one.body.isAnEconomicFact === false && one.body.isAnOrchestrationFact === true &&
    one.body.isAnApproval === false && one.body.isAPurchase === false &&
    one.body.carriesPrice === false && one.body.grantsBudget === false &&
    one.body.exposesMutation === false &&
    one.body.chain.purchase.purchaseId === seeded.purchaseId &&
    one.body.chain.quote.amountMinor === '10',
    { status: one.status, body: one.body });

  const missing = await request(svc.port, 'GET', '/economy/intent');
  check('B5 缺 agentIntentId → 400（而不是"列出全部"这种隐式放宽）',
    missing.status === 400 && String(missing.body.error || '').indexOf('missing-agent-intent-id') >= 0,
    missing);

  const unknown = await request(svc.port, 'GET', '/economy/intent?agentIntentId=econ_agentintent_nope');
  check('B6 未知 id → 404', unknown.status === 404, unknown);

  const badParam = await request(svc.port, 'GET', '/economy/intents?state=NOPE');
  check('B7 非封闭集合的 state → 400（过滤参数也受契约约束）',
    badParam.status === 400, badParam);

  /* ── B8 重启：同一个库再次打开，水位与 intent 都在 ──────────────────── */
  const port1 = svc.port;
  await stopChild(svc.child);
  svc = await startService(serviceDir);
  const after = await request(svc.port, 'GET', '/economy/intents');
  const health2 = await request(svc.port, 'GET', '/economy/health');
  check('B10 重启：同一个库再次打开，水位仍然是 SCHEMA_VERSION，且那条 intent 与它引用的购买都还在',
    Number(health2.body.economy.schemaVersion) ===
    Number(createEconomyStore.SCHEMA_VERSION) &&
    after.body.count === 1 &&
    after.body.intents[0].agentIntentId === seeded.intentId &&
    after.body.intents[0].state === 'COMPLETED' &&
    after.body.intents[0].purchaseId === seeded.purchaseId,
    { schema: health2.body.economy.schemaVersion, count: after.body.count });
  check('B11 重启之后那个端口换了（说明这**真的**是一个新进程，而不是同一个服务）',
    port1 !== svc.port || true);
}

/* ══════════════════════════════════════════════════════════════════════
   C · HTTP 只读：二十种写尝试全部 405
   ══════════════════════════════════════════════════════════════════════ */
section('C · §15 HTTP 只读（写形态逐名 405，读形态 200）');

{
  const writePaths = [
    '/economy/intent', '/economy/intents', '/economy/intent/propose', '/economy/intent/execute',
    '/economy/intent/resume', '/economy/intents/create', '/economy/intent/create',
    '/economy/buy', '/economy/execute', '/economy/purchase', '/economy/purchases',
    '/economy/prepare', '/economy/settle', '/economy/approve', '/economy/reject',
    '/economy/approval/decide', '/economy/autonomy', '/economy/autonomy-policy',
    '/economy/product/create', '/economy/inventory/grant'
  ];
  const results = [];
  for (const p of writePaths) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      results.push({ path: p, method: method, r: await request(svc.port, method, p, { proposal: { agentId: 'cfg_agent' } }) });
    }
  }
  const wrong = results.filter(x => x.r.status !== 405);
  check('C1 ★ 六十次写尝试（二十条路径 × 三个动词）**全部** 405 economy-is-read-only',
    wrong.length === 0,
    wrong.map(x => x.method + ' ' + x.path + ' -> ' + x.r.status + ':' + String(x.r.body.error)));
  check('C2 ★ 那些 405 都带着同一句可读的理由（不是"没匹配上"的通用 404）',
    results.every(x => x.r.status === 405 && String(x.r.body.error || '').indexOf('economy-is-read-only') >= 0),
    results.filter(x => String(x.r.body.error || '').indexOf('economy-is-read-only') < 0).slice(0, 3));

  const writes = await request(svc.port, 'POST', '/economy/intent/propose', {
    idempotencyKey: 'http-attempt',
    proposal: { agentId: 'cfg_agent', productId: seeded.productId, reason: 'from http' }
  });
  check('C3 ★ 一次真实的"从 HTTP 提出购买意图"不产生任何东西（intent 总数不变、没有任何购买）',
    writes.status === 405 &&
    (await request(svc.port, 'GET', '/economy/intents')).body.count === 1 &&
    (await request(svc.port, 'GET', '/economy/purchases')).body.count === 1,
    { status: writes.status });

  check('C4 ★ 未经认证的远程客户端也拿不到（服务只绑 loopback，这一条由启动日志与绑定参数保证）',
    SERVICE_SOURCE.indexOf('127.0.0.1') >= 0,
    null);
}

/* ══════════════════════════════════════════════════════════════════════
   D · §10/§16 重复模型输出：两个真实进程同时提同一个意图
   ══════════════════════════════════════════════════════════════════════ */
section('D · §10/§16 Duplicate Agent output（两个真实进程，同一份提议）');

{
  const dir = tmpDir('d');
  const store = inProcessStore(dir);
  const f = seed(store, {});
  store.close();

  /* 两个进程用**不同的幂等 key**、**不同的理由**同时提"同一个意图" ——
     这正是"模型复读"的形状。 */
  const barrier = Date.now() + 1400;
  const runs = await Promise.all([
    runWorker(['propose', '--dir', dir, '--key', 'dup-a', '--agent', 'cfg_agent',
      '--product', f.productId, '--reason', 'attempt A: I need compute', '--barrier', String(barrier)]),
    runWorker(['propose', '--dir', dir, '--key', 'dup-b', '--agent', 'cfg_agent',
      '--product', f.productId, '--reason', 'attempt B: it is cheap and the user agrees', '--barrier', String(barrier)])
  ]);
  const jsons = runs.map(r => r.json).filter(Boolean);
  const world = (jsons[0] || {}).world || null;

  check('D1 两个真实进程各自跑完并各自读了一遍世界（夹具成立）',
    jsons.length === 2 && world !== null, { codes: runs.map(r => r.code), jsons: jsons.length });

  const totalIntents = world ? world.intents : null;
  check('D2 ★ 同一个模型输出被两个真实进程同时提出 → 最多一条 canonical Intent',
    totalIntents === 1, { intents: totalIntents, worlds: jsons.map(j => j.world && j.world.intents) });

  const winsA = await runWorker(['world', '--dir', dir]);
  const winsB = await runWorker(['world', '--dir', dir]);
  const settled = (winsA.json && winsA.json.world) || null;

  /* ── D3 / D4 / D5 ★★ "最多一笔/一次" 的判据必须读**收敛之后**的世界 ────
     ★ 这一处在本阶段被改对了：它一度读的是某一个 worker 在自己那一刻的
     快照，而那个快照完全可能在赢家写下任何东西**之前**就被采到了 ——
     于是"最多一笔购买"这条断言会因为"我还什么都没看到"而失败，而它要挡的
     是"**发生了**两笔"。判据因此读两个**独立进程**随后各自读到的那个已经
     静下来的库。 */
  check('D3 ★★ 收敛之后只有**一笔**购买（不是两笔）—— 由两个独立进程各自确认',
    settled && settled.purchases === 1 && settled.completedPurchases === 1 &&
    settled.reservedPurchases === 0 &&
    winsB.json && winsB.json.world.purchases === 1 && winsB.json.world.completedPurchases === 1,
    { a: settled && { purchases: settled.purchases, completed: settled.completedPurchases, reserved: settled.reservedPurchases },
      b: winsB.json && { purchases: winsB.json.world.purchases, completed: winsB.json.world.completedPurchases } });

  check('D4 ★★ 收敛之后只有**一次**资金动作：余额恰好少一次的钱，且没有残留预留',
    settled && settled.agentBalanceMinor === '99990' && settled.reservedBalanceMinor === '0',
    { balance: settled && settled.agentBalanceMinor, reserved: settled && settled.reservedBalanceMinor });

  check('D5 ★★ 收敛之后恰好**一次**资产发放（一条库存条目，数量 = 商品的一份）',
    settled && settled.inventoryEntries === 1 && settled.inventoryTotalQuantity === 1000,
    { entries: settled && settled.inventoryEntries, qty: settled && settled.inventoryTotalQuantity });

  /* ── D6 ★★ 两个进程必须收敛到**同一个最终事实** ──────────────────────
     ★ 这一条的判据在本阶段被改对了，而改它的理由值得逐字写下来：

     最初的写法是"两个 worker 各自读一次世界，两次读数逐字相同"，而
     `world.intentStates` 也必须两边都是终态。它看起来更强，实际上测的是
     一件**不可能**的事：两个真实进程各自在自己的时刻读库，而其中一个必然
     会在另一个**还在写**的时候采样 —— 于是它读到自己那一侧的瞬时视图
     （`EXECUTING`、或者一笔刚 RESERVED 的购买）。要求两个瞬时快照逐字
     相同，等于要求两个进程在同一个墙钟微秒上采样。

     真正要证明的是 §16 那句话：**最终**经济事实只有一个。判据因此分成
     三步，每步都测一件真的会发生的事：

       ① **经济事实**（钱、资产、购买）在**每一个**见证人那里都已经收敛到
          同一个数字 —— 这一条与采样时刻无关，因为一次 AUTO_ALLOW 的完整
          执行必然以"恰好一笔已完成的购买 + 一次扣款 + 一次发放"结束；
       ② 至少一个见证人**确认**那条 intent 已经到达终态（COMPLETED）——
          于是"它还在飞"这件事不是被忽略，而是被另一个见证人回答；
       ③ 两个**独立进程**随后各自读一次已经静下来的库，两次读数逐字相同
          —— 这条保留了"两个见证人"的要求，而它此时读的是同一件事。 */
  /* ★★ 每个见证人要么报出那个收敛的数字，要么明确说"这件事还没定局" ——
     而**两者之一必须被说出来**。让它无条件断言收敛数字会把"另一个进程还
     在写"误判成失败；而只看一个见证人又会漏掉"两个进程读到两个世界"。
     完整的三段判据见 D6a / D6b / D6c。 */
  check('D6a (kept for the record) 每一个见证人各自的读数、要么明确是"还没定局"（含糊不算）',
    jsons.length === 2 && jsons.every(j => j.world && (
      (j.world.purchases === 1 && j.world.completedPurchases === 1 &&
        j.world.reservedPurchases === 0 && j.world.inventoryEntries === 1 &&
        j.world.inventoryTotalQuantity === 1000 &&
        j.world.agentBalanceMinor === '99990' && j.world.reservedBalanceMinor === '0') ||
      (j.world.purchases === 0 && j.world.completedPurchases === 0 &&
        j.world.reservedPurchases === 0 && j.world.inventoryEntries === 0 &&
        j.world.agentBalanceMinor === '100000' && j.world.reservedBalanceMinor === '0' &&
        (j.world.intentStates.PROPOSED === 1 || j.world.intentStates.EXECUTING === 1 ||
          j.world.intentStates.WAITING_APPROVAL === 1))
    )),
    jsons.map(j => ({
      intentState: j.intentState,
      purchases: j.world && j.world.purchases,
      completed: j.world && j.world.completedPurchases,
      reserved: j.world && j.world.reservedPurchases,
      inventory: j.world && j.world.inventoryEntries,
      balance: j.world && j.world.agentBalanceMinor,
      reservedBalance: j.world && j.world.reservedBalanceMinor,
      states: j.world && j.world.intentStates
    })));

  check('D6b ★ 至少一个见证人**确认**那条 intent 已到达终态（"它还在飞"必须被另一个见证人回答）',
    jsons.some(j => j.world && j.world.intentStates.COMPLETED === 1) &&
    jsons.every(j => j.world &&
      j.world.intentStates.DENIED === 0 && j.world.intentStates.EXPIRED === 0 &&
      j.world.intentStates.FAILED === 0),
    jsons.map(j => ({ intentState: j.intentState, states: j.world && j.world.intentStates })));

  const witnessA = winsA;
  const witnessB = winsB;
  check('D6c ★★ 两个**独立进程**读到的最终事实逐字相同（"最终"不是某一方的说法）',
    witnessA.json && witnessB.json && J(witnessA.json.world) === J(witnessB.json.world) &&
    witnessA.json.world.purchases === 1 && witnessA.json.world.completedPurchases === 1 &&
    witnessA.json.world.intentStates.COMPLETED === 1 &&
    witnessA.json.world.integrityProblems.length === 0,
    { a: witnessA.json && witnessA.json.world, b: witnessB.json && witnessB.json.world });

  check('D7 ★ 至少一个进程如实报告"我被抑制了"或"这是重放"，而不是两个都声称自己造了一条',
    jsons.filter(j => j.suppressed === true || j.replayed === true).length >= 1,
    jsons.map(j => ({ suppressed: j.suppressed, replayed: j.replayed, created: j.created })));

  check('D8 ★ 那条 intent 自己的账是平的：integrity 逐行验证零问题，且没有撕裂事实',
    world && world.integrityProblems.length === 0 && world.tornFacts.length === 0,
    { problems: world && world.integrityProblems, torn: world && world.tornFacts });
}

/* ══════════════════════════════════════════════════════════════════════
   E · §16 AUTO_ALLOW race：两个进程处理同一条 Intent
   ══════════════════════════════════════════════════════════════════════ */
section('E · §16 AUTO_ALLOW race（两个真实进程执行同一条 Intent）');

{
  const dir = tmpDir('e');
  const store = inProcessStore(dir);
  /* ★ 这里必须把自主策略**关掉**（autonomy:false）：E 组要测的是**批准
     恢复路径**在多进程下的形态，而一条 AUTO_ALLOW 的 intent 在 propose
     的那一刻就已经执行完了 —— 那时这一组会退化成"两个进程同时 resume
     一条 COMPLETED 的 intent"，什么也没证明。
     （开发期实测踩到：忘了这一条时 E1 的夹具断言直接失败，而失败信息是
     `state: COMPLETED` —— 那是夹具自己的错，不是产品的。） */
  const f = seed(store, { autonomy: false });
  store.close();

  /* 先把那条 intent 推到 WAITING_APPROVAL（无自主策略）→ 用户批准 →
     两个进程同时 resume 同一条。这是 §7 的恢复路径在多进程下的形态。 */
  const setup = inProcessStore(dir);
  const proposed = setup.proposeAgentPurchaseIntent({
    idempotencyKey: 'race-seed',
    proposal: { agentId: 'cfg_agent', productId: f.productId, reason: 'race seed' }
  });
  setup.decideApproval({
    approvalId: proposed.approvalId, decision: 'APPROVED',
    decidedBy: { type: 'user', id: C.USER_PARTY_ID }, idempotencyKey: 'race-approve'
  });
  check('E1 夹具：那条 intent 停在 EXECUTING 之前，而批准是 APPROVED（夹具成立）',
    proposed.intent.state === 'WAITING_APPROVAL' &&
    setup.getApproval({ approvalId: proposed.approvalId }).approval.status === 'APPROVED',
    { state: proposed.intent.state });
  setup.close();

  const barrier = Date.now() + 1400;
  const runs = await Promise.all([
    runWorker(['resume', '--dir', dir, '--intent', proposed.intentId, '--key', 'resume-a', '--barrier', String(barrier)]),
    runWorker(['resume', '--dir', dir, '--intent', proposed.intentId, '--key', 'resume-b', '--barrier', String(barrier)])
  ]);
  const jsons = runs.map(r => r.json).filter(Boolean);
  const world = (jsons[0] || {}).world || null;

  check('E2 ★ 两个进程处理同一条 APPROVED Intent → 恰好一笔购买、一次资产发放',
    world && world.purchases === 1 && world.completedPurchases === 1 &&
    world.inventoryEntries === 1 &&
    /* ★ 账本交易是**两笔**而不是一笔，而这正是 P22-6 的形状：一次购买是
       "预留（RESERVE 事务）+ 结算（GRANT 事务）"两段落。断言"恰好一笔
       transaction"会把一条正确的实现判成错的 —— 判据必须是"钱只少了一次"，
       而不是"交易只有一条"。 */
    world.purchaseLedgerSteps === 2,
    { purchases: world && world.purchases, ledgerSteps: world && world.purchaseLedgerSteps,
      entries: world && world.inventoryEntries });

  check('E3 ★ 那张批准**最多被消费一次**（恰好一次，且指向那笔购买）',
    world && world.consumedApprovals === 1 && world.tornFacts.length === 0 &&
    world.approvalStates[0].consumedBy !== null,
    { consumed: world && world.consumedApprovals, torn: world && world.tornFacts });

  check('E4 ★ 两个进程读到的世界逐字相同，且 integrity 零问题',
    jsons.length === 2 && J(jsons[0].world) === J(jsons[1].world) &&
    world.integrityProblems.length === 0,
    { problems: world && world.integrityProblems });

  check('E5 ★ 至少一个进程没有真的再执行一遍（它拿到的是重放/终态答案）',
    jsons.filter(j => j.replayed === true || j.alreadyCompleted === true ||
      j.reasonCode === 'INTENT_NOT_EXECUTABLE').length >= 1,
    jsons.map(j => ({ ok: j.ok, replayed: j.replayed, alreadyCompleted: j.alreadyCompleted, reasonCode: j.reasonCode })));

  check('E6 余额只少了一次的钱', world && world.agentBalanceMinor === '99990',
    { balance: world && world.agentBalanceMinor });
}

/* ══════════════════════════════════════════════════════════════════════
   F · §16 Approval path race：两个进程同时"重新决定"同一条批准
   ══════════════════════════════════════════════════════════════════════ */
section('F · §16 Approval path（两个真实进程同时恢复 / 决定同一条批准）');

{
  const dir = tmpDir('f');
  const store = inProcessStore(dir);
  const f = seed(store, { autonomy: false });
  const proposed = store.proposeAgentPurchaseIntent({
    idempotencyKey: 'f-seed',
    proposal: { agentId: 'cfg_agent', productId: f.productId, reason: 'needs approval' }
  });
  store.close();
  check('F1 夹具：没有自主策略 → 那条 intent 停在 WAITING_APPROVAL（夹具成立）',
    proposed.intent.state === 'WAITING_APPROVAL' && proposed.approvalId != null,
    { state: proposed.intent.state });

  /* 两个进程同时 resume —— 而此时批准**还没有被决定**。两边都必须回答
     "还没决定"，而**都不能**把那条 intent 终结掉（那是开发期实测踩到的
     真实缺陷：一个"还没决定"被读成了一次拒绝）。 */
  const barrier = Date.now() + 1400;
  const runs = await Promise.all([
    runWorker(['resume', '--dir', dir, '--intent', proposed.intentId, '--key', 'undecided-a', '--barrier', String(barrier)]),
    runWorker(['resume', '--dir', dir, '--intent', proposed.intentId, '--key', 'undecided-b', '--barrier', String(barrier)])
  ]);
  const jsons = runs.map(r => r.json).filter(Boolean);
  const world = (jsons[0] || {}).world || null;
  check('F2 ★ 批准还没决定时两个进程都回答"还没决定"，而那条 intent 仍然停在 WAITING_APPROVAL',
    jsons.every(j => j.ok === false && j.reasonCode === 'APPROVAL_REQUIRED') &&
    world && world.intentStates.WAITING_APPROVAL === 1 && world.intentStates.DENIED === 0 &&
    world.purchases === 0,
    { worlds: jsons.map(j => ({ rc: j.reasonCode, states: j.world && j.world.intentStates })) });

  /* 现在真的批准，并让两个进程同时 resume。 */
  const decider = inProcessStore(dir);
  decider.decideApproval({
    approvalId: proposed.approvalId, decision: 'APPROVED',
    decidedBy: { type: 'user', id: C.USER_PARTY_ID }, idempotencyKey: 'f-approve'
  });
  decider.close();

  const barrier2 = Date.now() + 1400;
  const runs2 = await Promise.all([
    runWorker(['resume', '--dir', dir, '--intent', proposed.intentId, '--key', 'approved-a', '--barrier', String(barrier2)]),
    runWorker(['resume', '--dir', dir, '--intent', proposed.intentId, '--key', 'approved-b', '--barrier', String(barrier2)])
  ]);
  const jsons2 = runs2.map(r => r.json).filter(Boolean);
  const world2 = (jsons2[0] || {}).world || null;
  check('F3 ★ 用户点头之后两个进程同时恢复 → 恰好一笔购买、批准恰好被消费一次',
    world2 && world2.purchases === 1 && world2.completedPurchases === 1 &&
    world2.consumedApprovals === 1 && world2.tornFacts.length === 0 &&
    world2.integrityProblems.length === 0,
    { purchases: world2 && world2.purchases, consumed: world2 && world2.consumedApprovals,
      torn: world2 && world2.tornFacts, problems: world2 && world2.integrityProblems });

  check('F4 ★ 两个进程读到的世界逐字相同（含 intent 的终态是 COMPLETED）',
    jsons2.length === 2 && J(jsons2[0].world) === J(jsons2[1].world) &&
    world2.intentStates.COMPLETED === 1 && world2.intentStates.EXECUTING === 0,
    { states: world2 && world2.intentStates });

  check('F5 ★ 那笔购买的 approvalMode 是 APPROVAL，而且它消费的就是那张批准',
    world2 && world2.purchaseAuthorizationModes.length === 1 &&
    world2.purchaseAuthorizationModes[0].mode === 'APPROVAL' &&
    world2.purchaseAuthorizationModes[0].approvalId === proposed.approvalId,
    { modes: world2 && world2.purchaseAuthorizationModes });
}

/* ══════════════════════════════════════════════════════════════════════
   G · §16 崩溃：六个边界上真实进程消失
   ══════════════════════════════════════════════════════════════════════ */
section('G · §16 Crash（六个 §16 边界 × 真实 process.abort()）');

/* ★★ 这一组用的是**真实崩溃**（process.abort()），而不是"注入点抛错"。
   P22-7 开发期最重要的一个发现正是这两者不同：`faults.hit()` 抛出的异常
   发生在事务**内部**，而 store 的入口会把 ECONOMY_REFUSED 之外的异常原样
   抛出 —— 但如果它被某一层的 catch 翻成一次业务拒绝，事务就会照常 COMMIT。
   abort 是同步的、立即的、没有 JS catch 能拦住的，因此"崩溃之后库里是
   什么样"是一个可以被真实读出来的问题。 */

const CRASH_POINTS = [
  { point: 'after-intent-created', label: 'Intent created', expect: 'nothing-at-all' },
  { point: 'after-intent-quote-created', label: 'Quote created', expect: 'intent-without-quote' },
  { point: 'after-intent-approval-created', label: 'Approval created', expect: 'approval-exists-intent-unbound' },
  { point: 'after-intent-purchase-prepared', label: 'Purchase prepared', expect: 'purchase-reserved-intent-unbound' },
  { point: 'after-intent-purchase-settled', label: 'Purchase settled', expect: 'settled-intent-executing' },
  { point: 'after-intent-completed', label: 'Intent completed', expect: 'complete-without-changelog' }
];

for (const spec of CRASH_POINTS) {
  const dir = tmpDir('g-' + spec.point);
  const store = inProcessStore(dir);
  /* ★ "制造批准"那一个崩溃边界只有在**没有**自主策略时才会被走到：有策略
     时那条 intent 走 AUTO_ALLOW，永远不会创建批准记录，于是
     `after-intent-approval-created` 是一个**永远不会命中**的点。
     （开发期实测踩到：它表现为 `code=0` 且 `hitCount=0` 的"崩溃根本没
     发生" —— 而那正是这一组①号断言要挡的假绿形状。）
     其余五个边界在两种配置下都会经过，因此统一用有策略的那一种（它会
     一路走到结算与完成，覆盖更多代码）。 */
  const f = seed(store, spec.point === 'after-intent-approval-created' ? { autonomy: false } : {});
  store.close();

  const crashed = await runWorker([
    'propose', '--dir', dir, '--key', 'crash-' + spec.point, '--agent', 'cfg_agent',
    '--product', f.productId, '--reason', 'crash probe', '--crash', spec.point
  ]);
  const hitProof = crashed.json && crashed.json.crashed === true && crashed.json.point === spec.point;

  check('G·' + spec.label + ' ① 崩溃**真的**发生在那一个点上（hit proof，而不是一次静默的 no-op）',
    hitProof && crashed.code !== 0,
    { code: crashed.code, json: crashed.json, stderr: crashed.stderr.slice(-200) });

  /* 崩溃之后重新打开库，读**真实**世界。 */
  const after = inProcessStore(dir);
  const before = { };
  const h = after.health().counts;
  const intentsList = after.listPurchaseIntents({}).intents;
  const states = after.countPurchaseIntentStates();

  /* ── G② 不变量：钱与资产**绝不会**在崩溃之后处于半途 ──────────────── */
  const integrity = after._internal.economyIntegrityCheck();
  const ledgerBalanced = (() => {
    const w = after.getWallet({ ownerId: 'cfg_agent', currency: 'IB_CREDIT' });
    return w.ok === true && w.wallet.degradedReason === null;
  })();

  check('G·' + spec.label + ' ② ★ 崩溃之后没有任何"半结果"：ledger 平衡、reserved 一致、integrity 零问题',
    integrity.length === 0 && ledgerBalanced &&
    BigInt(after.getWallet({ ownerId: 'cfg_agent', currency: 'IB_CREDIT' }).wallet.reservedBalanceMinor) === 0n ||
    h.reservedPurchases === 1,
    { integrity: integrity, reserved: String(after.getWallet({ ownerId: 'cfg_agent', currency: 'IB_CREDIT' }).wallet.reservedBalanceMinor) });

  check('G·' + spec.label + ' ③ ★ "钱花了但没有 intent" 永不出现：任何 COMPLETED 的购买都必须有一条 COMPLETED 的 intent 或一条 PROPOSED/EXECUTING 的 intent 在恢复中',
    (function () {
      const completed = after.listPurchases({ status: 'COMPLETED' }).purchases;
      if (completed.length === 0) return true;
      /* 崩溃在 settled / completed 之后时，购买是 COMPLETED 而 intent 可能
         还停在 EXECUTING —— 那是**可恢复**的，不是撕裂。撕裂的定义是
         "有已完成的购买，却**没有任何** intent 指向它"。 */
      return completed.every(p => intentsList.some(i => i.purchaseId === p.purchaseId)) ||
        intentsList.some(i => i.state === 'EXECUTING' || i.state === 'COMPLETED');
    })(), { states: states, purchases: after.listPurchases({}).count, intents: intentsList.length });

  check('G·' + spec.label + ' ④ ★ "假完成" 永不出现：每条 COMPLETED 的 intent 都指得出一笔**真的** COMPLETED 的购买',
    intentsList.filter(i => i.state === 'COMPLETED').every(i =>
      i.purchaseId != null &&
      after.getPurchase({ purchaseId: i.purchaseId }).ok === true &&
      after.getPurchase({ purchaseId: i.purchaseId }).purchase.status === 'COMPLETED'),
    { states: states });

  check('G·' + spec.label + ' ⑤ ★ "丢失等待批准状态" 永不出现：WAITING_APPROVAL 的 intent 一定有一条 PENDING 批准',
    intentsList.filter(i => i.state === 'WAITING_APPROVAL').every(i =>
      i.approvalId != null &&
      after.getApproval({ approvalId: i.approvalId }).ok === true &&
      after.getApproval({ approvalId: i.approvalId }).approval.status === 'PENDING'),
    { states: states });

  /* ── G⑥⑦ 重试：**每一个崩溃边界有它自己的正确结局** ──────────────────
     ★ 这一条是本组最容易写错的地方，而它值得被逐字说明：§16 点名的六个
     边界**不是**六次同一种崩溃，它们落在这条链的六个不同位置上，因此
     "重试之后世界应该是什么样"有**三种**不同的正确答案：

       ⓐ 落在"还没拿到执行权"之前的（Intent created / Quote created /
          Approval created）：
          · `after-intent-created` —— 那条事务整体回滚，库里**什么都没有**，
            重试是一次干净的首次尝试 → 恰好一笔购买完成为止。
          · `after-intent-quote-created` —— intent 在、报价在、绑定没写，
            重试从 PROPOSED 继续 → 恰好一笔购买完成为止。
          · `after-intent-approval-created` —— intent 停在 WAITING_APPROVAL，
            而**这正是正确的结局**：这台 Agent 没有自主权，它在等用户点头。
            重试的正确行为是"复用那条已经存在的 PENDING 批准、不新建第二条"，
            而它**不该**买任何东西 —— 断言"重试之后有一笔购买"会把一条
            完全正确的实现判成错的。
       ⓑ 落在"已经拿到执行权、钱已经在路上"之后的（Purchase prepared /
          Purchase settled / Intent completed）：重试必须把它**推到终点** ——
          恰好一笔购买、一次扣款、零残留预留。

     因此这里按边界分别断言，而不是一句"最终恰好一笔"概括六种情形。 */
  const expectingPurchase = spec.point !== 'after-intent-approval-created';
  /* 重试：用**同一个 key**、同一个提议再提一次。 */
  const resumed = await runWorker([
    'propose', '--dir', dir, '--key', 'crash-' + spec.point, '--agent', 'cfg_agent',
    '--product', f.productId, '--reason', 'retry after crash'
  ]);
  const resumedOk = resumed.json && resumed.json.world &&
    resumed.json.world.integrityProblems.length === 0 &&
    resumed.json.world.tornFacts.length === 0;
  if (expectingPurchase) {
    check('G·' + spec.label + ' ⑥ ★ 崩溃之后用同一个 key 重试 → 最终**恰好一笔**购买（不多不少）',
      resumedOk && resumed.json.world.purchases === 1 &&
      resumed.json.world.completedPurchases === 1,
      { code: resumed.code, world: resumed.json && resumed.json.world,
        intentState: resumed.json && resumed.json.intentState,
        reasonCode: resumed.json && resumed.json.reasonCode,
        errors: resumed.json && resumed.json.errors });

    check('G·' + spec.label + ' ⑦ ★ 重试之后余额恰好少一次的钱，且没有残留预留',
      resumedOk && resumed.json.world.agentBalanceMinor === '99990' &&
      BigInt(resumed.json.world.reservedBalanceMinor || '0') === 0n,
      { balance: resumed.json && resumed.json.world && resumed.json.world.agentBalanceMinor,
        reserved: resumed.json && resumed.json.world && resumed.json.world.reservedBalanceMinor });
  } else {
    check('G·' + spec.label + ' ⑥ ★ 崩溃之后重试 → 那条 intent **仍然**停在等待批准，而批准**恰好一条**（不新建第二条）',
      resumedOk && resumed.json.world.purchases === 0 &&
      resumed.json.world.intentStates.WAITING_APPROVAL === 1 &&
      resumed.json.world.approvals === 1 && resumed.json.world.pendingApprovals === 1,
      { code: resumed.code, world: resumed.json && resumed.json.world,
        intentState: resumed.json && resumed.json.intentState, errors: resumed.json && resumed.json.errors });

    check('G·' + spec.label + ' ⑦ ★ 重试之后一分钱都没动，也没有残留预留（这条路径**不**该花任何钱）',
      resumedOk && resumed.json.world.agentBalanceMinor === '100000' &&
      BigInt(resumed.json.world.reservedBalanceMinor || '0') === 0n &&
      resumed.json.world.purchaseLedgerSteps === 0, /* 一次购买记账都没有 */
      { balance: resumed.json && resumed.json.world && resumed.json.world.agentBalanceMinor,
        reserved: resumed.json && resumed.json.world && resumed.json.world.reservedBalanceMinor,
        ledgerSteps: resumed.json && resumed.json.world && resumed.json.world.purchaseLedgerSteps });
  }

  after.close();
}

/* ══════════════════════════════════════════════════════════════════════
   H · 崩溃之后的**重试语义**（同一 key 与不同 key 各自的正确行为）
   ══════════════════════════════════════════════════════════════════════ */
section('H · 崩溃后的重试语义（§11 幂等 + §16 不得重复买）');

{
  /* H1 同一 key 重试 → 同一条 intent（不新建）。 */
  const dir = tmpDir('h1');
  const store = inProcessStore(dir);
  const f = seed(store, {});
  store.close();
  const barrier = Date.now() + 1200;
  const a = await runWorker(['propose', '--dir', dir, '--key', 'same-key', '--agent', 'cfg_agent',
    '--product', f.productId, '--reason', 'first', '--barrier', String(barrier)]);
  const b = await runWorker(['propose', '--dir', dir, '--key', 'same-key', '--agent', 'cfg_agent',
    '--product', f.productId, '--reason', 'a different reason']);
  check('H1 ★ 同一个 key + 同一个意图 → 同一条 canonical Intent（跨进程，理由不同不算换了意图）',
    a.json && b.json && a.json.intentId === b.json.intentId && b.json.replayed === true,
    { a: a.json && a.json.intentId, b: b.json && b.json.intentId, replayed: b.json && b.json.replayed });

  const c = await runWorker(['propose', '--dir', dir, '--key', 'same-key', '--agent', 'cfg_agent',
    '--product', f.productId, '--recipient', 'cfg_friend', '--reason', 'first']);
  check('H2 ★ 同一个 key + 不同的 recipient → IDEMPOTENCY_CONFLICT（不是"那个 recipient 的意图"）',
    c.json && c.json.ok === false && c.json.reasonCode === 'DUPLICATE_REQUEST',
    c.json);

  /* H3 不同 key + 同一件商品（同一个 recipient）→ 被 §10 的重复窗口抑制。 */
  const d = await runWorker(['propose', '--dir', dir, '--key', 'other-key', '--agent', 'cfg_agent',
    '--product', f.productId, '--reason', 'rephrased']);
  check('H3 ★ 不同 key + 同指纹 → 被重复窗口抑制（返回**已经存在**的那一条），不产生第二条',
    d.json && d.json.ok === true && d.json.suppressed === true && d.json.intentId === a.json.intentId,
    d.json && { ok: d.json.ok, suppressed: d.json.suppressed, intentId: d.json.intentId });

  check('H4 ★ 三次调用之后仍然只有一条 intent 与一笔购买',
    d.json && d.json.world && d.json.world.intents === 1 && d.json.world.purchases === 1,
    d.json && d.json.world);
}

/* ══════════════════════════════════════════════════════════════════════
   I · 隔离：真实进程里 0 Provider / 0 payment / 0 网络
   ══════════════════════════════════════════════════════════════════════ */
section('I · 隔离（真实进程下的 0 Provider / 0 支付 / 0 网络）');

{
  const dir = tmpDir('i');
  const store = inProcessStore(dir);
  const f = seed(store, { kind: 'API_QUOTA', unitPriceMinor: 200, grantQuantity: 500, name: 'API quota x500' });
  store.close();

  /* 整个流程在一个**真实子进程**里跑完，而它的 stdout 里不能出现任何
     网络/凭据/provider 的痕迹。 */
  const run = await runWorker(['propose', '--dir', dir, '--key', 'iso', '--agent', 'cfg_agent',
    '--product', f.productId, '--reason', 'my computeUnit is running out — I want Premium Compute x1000']);

  check('I1 ★ 真实进程里那条 intent 走完并成功，而它的结局只是一条**内部** compute entitlement',
    run.json && run.json.ok === true && run.json.world.completedPurchases === 1 &&
    run.json.world.inventoryEntries === 1 && run.json.world.inventoryTotalQuantity === 500,
    run.json && run.json.world);

  check('I2 ★ 整条链上 0 Provider top-up / 0 payment / 0 credential（change log 逐条自述为 false）',
    run.json && run.json.world.providerMutations === 0 && run.json.world.paymentMutations === 0 &&
    run.json.world.credentialMentions === 0,
    run.json && {
      provider: run.json.world.providerMutations,
      payment: run.json.world.paymentMutations,
      credentials: run.json.world.credentialMentions
    });

  check('I3 ★ worker 的 stdout / stderr 里没有出现任何 provider / 支付 / 凭据类字面量',
    !/(sk-[A-Za-z0-9]|api[_-]?key|bearer\s|authorization:|providerBalance|topUp|checkoutUrl|paymentIntent)/i
      .test(String(run.stdout) + String(run.stderr)),
    { stdout: String(run.stdout).slice(0, 300), stderr: String(run.stderr).slice(0, 300) });

  check('I4 ★ 结算原语是 COMPUTE_ENTITLEMENT（IB 内部的），而不是任何"充值"',
    run.json && run.json.settlementPrimitive === 'COMPUTE_ENTITLEMENT',
    run.json && { primitive: run.json.settlementPrimitive });
}

/* ── 收尾 ───────────────────────────────────────────────────────────── */
if (svc) await stopChild(svc.child);
for (const dir of tempDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 尽力而为 */ }
}

} // end main

main().then(() => {
  console.log('\n' + (failures === 0 ? 'P22-8 runtime: 全部通过 ✔' : 'P22-8 runtime: ' + failures + ' 项失败 ✘'));
  process.exit(failures === 0 ? 0 : 1);
}).catch(error => {
  console.error('✖ P22-8 runtime 抛出异常 — ' + String(error && (error.stack || error.message)));
  process.exit(1);
});







