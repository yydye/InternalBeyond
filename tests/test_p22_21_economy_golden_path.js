/* ══════════════════════════════════════════════════════════════════════
   P22-21 · Economy v1 Golden Path · Failure Golden Paths · Authority Graph
            · Exactly-Once（§1 / §5 / §9 / §10）

   运行：node tests/test_p22_21_economy_golden_path.js

   ── §9 · 这是本阶段最重要的整体证明 ───────────────────────────────────
     一次真正的 fresh install，从**空**的 Economy DB 开始，一路走到
     UI 纯层能显示 canonical 最终状态：

       Fresh DB
         ↓  POST /internal/economy/configuration     BOOTSTRAP_CREDIT
         ↓  POST /internal/economy/configuration     PUT_BUDGET_POLICY
         ↓  POST /internal/economy/configuration     PUT_AUTONOMY_POLICY
         ↓  目录 fixture（★ 显式标记：见下）
         ↓  POST /internal/economy/command           Agent WANT
         ↓  Intent（WAITING_APPROVAL）+ Approval（PENDING）
         ↓  POST /internal/economy/approval-decision APPROVED
         ↓  Resume（经 capability gate 的 RESUME_APPROVED_PURCHASE）
         ↓  Purchase（COMPLETED · 一次原子结算）
         ↓  Ledger（一笔平衡的交易）· Inventory（恰好发放一次）
         ↓  Read Model（八条 canonical GET）
         ↓  UI 纯层（economy-shell-core.js 的 buildPageView）

   ★ **唯一**一处不经过 HTTP 的是**目录**（putStore / putProduct）：
     目录的写入口**故意不在 v1 的公开面上**（manifest §11 `STORE_ADMIN`，
     §13 debt D1）。因此这里显式说明：catalog administration remains
     intentionally out of v1 public surface. 本测试不偷偷造一个 Store Admin，
     也**不**假装目录走的是配置面（配置面的三个命令是封闭的）。

   ── 与 P22-14 §9 的关系：**不是重跑** ────────────────────────────────
     P22-14 证明的是 AUTO_ALLOW 腿（一次 propose 就买完）。本条走的是
     **审批腿**：propose → WAITING_APPROVAL → 用户决定 → resume → 结算。
     那条腿在 P22-14 里根本没有被走到（它的 D2 断言 `AUTO_ALLOW`）。

   ── §1 · authority graph **从真实调用边生成** ─────────────────────────
     本测试在装配层允许的注入点上（`options.economyStore`）给 store 加一层
     **只读记账代理**：它记录每一次真实的 `(调用者文件:行 → store 方法)`。
     代理不改变任何行为（方法的返回原样透传）。因此 §1 的图和
     "shortcut edge = 0" 是对**这一次真实运行**的断言，而不是对一张图画的复述。

   ── §5 · exactly-once 七层重放（A～G）─────────────────────────────────
     每一层重放之后都断言三件事**一个都没动**：
     purchase 数量 · ledger delta · inventory 数量。

   ── §10 · 六条失败金路径 ─────────────────────────────────────────────
     预算拒绝 / 批准拒绝 / 批准过期 / 报价过期 / 重复请求 / 畸形权威注入。
     每一条都断言：没有未经授权的账本变更、没有未经授权的库存变更、
     终态**解释了**失败、读面能诚实地把它读出来。

   ── 资源 ─────────────────────────────────────────────────────────────
     child = 0 · spawn = 0 · browser = 0。HTTP：本进程 2 个实例
     （"重启"那一个）+ 每个实例恰好 1 个 socket，除此之外零 socket。
     临时目录在 `process.on('exit')` 统一退避重试删除（**含中途断言抛错**）。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + J(extra) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }

const C = require(path.join(ROOT, 'services/home-node/economy-contract.js'));
const CONFIG = require(path.join(ROOT, 'services/home-node/economy-configuration.js'));
const DECISION = require(path.join(ROOT, 'services/home-node/economy-approval-decision.js'));
const CHANNEL = require(path.join(ROOT, 'services/home-node/economy-command-channel.js'));
const STORE_MODULE = require(path.join(ROOT, 'services/home-node/economy-store.js'));
const SERVICE = require(path.join(ROOT, 'services/home-node-service.js'));

/* ══════════════════════════════════════════════════════════════════════
   0 · 临时目录 / 端口 / HTTP 工具（与 P22-14 逐字同源的既有约定）
   ══════════════════════════════════════════════════════════════════════ */
const tempDirs = [];
const closables = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-21gp-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
/* ★ 退避重试删除，而且挂在 `exit` 上 —— 中途断言抛错时它**仍然**会跑。
   ★ 但**只**挂 `exit` 是不够的。开发期实测（本条测试自己踩到）：在
   `process.exit()` 的那一刻 SQLite 的文件句柄仍然开着，Windows 会拒绝删除
   （EPERM），于是每一次运行都留下一个 `ib-p22-21gp-install-*` 目录 ——
   也就是说"资源报告里临时目录 = 0"这句话在那之前是假的。
   因此真正的删除发生在**句柄已经关掉之后**（收尾处与崩溃路径都显式调用
   `cleanupTempDirs()`），`exit` 上的这一份只是**兜底**。 */
process.on('exit', function () { cleanupTempDirs(); });
function sleepMs(ms) {
  /* 收尾是同步的，而 backoff 需要真的等 —— Atomics.wait 是唯一一个
     能在同步代码里睡一段时间的标准手段。 */
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { }
}
function cleanupTempDirs() {
  for (let round = 0; round < 6; round += 1) {
    for (let i = tempDirs.length - 1; i >= 0; i -= 1) {
      try {
        fs.rmSync(tempDirs[i], { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        tempDirs.splice(i, 1);
      } catch (_) { /* 下一轮再试 */ }
    }
    if (!tempDirs.length) break;
    sleepMs(200 * (round + 1));
  }
  return tempDirs.length;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => (e ? reject(e) : resolve(p))); });
  });
}
function request(port, method, urlPath, body, headers, opts) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const options = {
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}, headers || {}),
      timeout: 8000
    };
    if (opts && opts.localPort) { options.localPort = opts.localPort; options.localAddress = '127.0.0.1'; }
    const req = http.request(options, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw: raw.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('http request timeout')));
    if (data) req.write(data);
    req.end();
  });
}
/* 固定来源端口会与上一次连接的 TIME_WAIT 撞（Windows 上 EADDRINUSE 是随机的），
   那不是逻辑失败 —— 与 tests/test_p22_11_economy_command_channel.js 同源。 */
async function boundRequest(port, sourcePort, method, urlPath, body, headers) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { return await request(port, method, urlPath, body, headers, { localPort: sourcePort }); } catch (error) {
      lastError = error;
      if (!/EADDRINUSE/.test(String(error && (error.code || error.message)))) throw error;
      await new Promise(r => setTimeout(r, 80));
    }
  }
  throw lastError;
}

/* ══════════════════════════════════════════════════════════════════════
   1 · §1 · 只读记账代理（记录真实的调用边）
   ══════════════════════════════════════════════════════════════════════ */
const EDGES = [];
function callerFrameOf() {
  const stack = String(new Error().stack || '').split('\n');
  for (let i = 2; i < stack.length; i += 1) {
    const line = stack[i];
    if (/economy-store\.js/.test(line)) continue;
    if (/test_p22_21_economy_golden_path\.js/.test(line)) continue;
    if (/node:internal/.test(line)) continue;
    const m = /at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (!m) continue;
    let file = m[2].replace(/\\/g, '/');
    const at = file.indexOf('/InternalBeyond-main/');
    if (at >= 0) file = file.slice(at + '/InternalBeyond-main/'.length);
    else if (file.indexOf(ROOT.replace(/\\/g, '/')) === 0) file = file.slice(ROOT.length + 1);
    return { symbol: (m[1] || '<module>'), file: file, line: Number(m[3]) };
  }
  return { symbol: '<unknown>', file: '<unknown>', line: 0 };
}
function instrument(store) {
  return new Proxy(store, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return function () {
        const caller = callerFrameOf();
        if (caller.file !== '<unknown>') EDGES.push({ from: caller, to: String(prop) });
        return value.apply(target, arguments);
      };
    }
  });
}
const WRITE_VERBS = new Set(['bootstrapInitialCredit', 'putBudgetPolicy', 'putAutonomyPolicy',
  'decideApproval', 'proposeAgentPurchaseIntent', 'resumeAgentPurchaseIntent', 'appendCapabilityAudit',
  'preparePurchase', 'settlePurchase', 'cancelPurchase', 'reserveFunds', 'commitReservation',
  'releaseReservation', 'expireReservation', 'failReservation', 'expireDueReservations',
  'grantInventory', 'consumeInventory', 'mutateInventoryInTx', 'commitLedgerTransaction',
  'mintForSystem', 'burnForSystem', 'transferBetweenWallets', 'openWallet', 'rebuildWalletBalance',
  'createApprovalRequest', 'authorizePurchaseIntent', 'expireApproval', 'expireDueApprovals',
  'putStore', 'putProduct', 'createProductQuote', 'createQuote', 'expireQuote', 'expireDueQuotes']);
function edgesFrom(filePart) { return EDGES.filter(e => e.from.file.indexOf(filePart) >= 0); }

/* ══════════════════════════════════════════════════════════════════════
   2 · 常量
   ══════════════════════════════════════════════════════════════════════ */
const CUR = 'IB_CREDIT';
const AGENT = 'p2221gp_agent';
const OTHER = 'p2221gp_other';
const TOKEN = 'p2221-gp-desktop-token';
const SOURCE_TOKEN = 'p2221-gp-source-token';
const CONFIG_PATH = CONFIG.CONFIGURATION_PATH;
const DECISION_PATH = DECISION.DECISION_PATH;
const COMMAND_PATH = CHANNEL.COMMAND_PATH;
const AUTH = { 'X-IB-Home-Token': TOKEN };
const SOURCE_AUTH = { 'X-IB-Economy-Channel-Source': SOURCE_TOKEN };
const BOOT_AMOUNT = 1000000;
const UNIT_PRICE = 10000;
const GRANT_QUANTITY = 1000;
const OTHER_AMOUNT = 250000;
const OTHER_PRICE = 7000;
/* ★ 审批阈值**低于**单价 ⇒ 这条购买必然走审批腿（而不是 AUTO_ALLOW）。
   两个数字都从契约/常量算出来，不由测试"决定"结果。 */
const APPROVAL_ABOVE = 5000;

let keySeq = 0;
function K(p) { keySeq += 1; return 'p2221gp-' + (p || 'k') + '-' + keySeq; }

const DATA_DIR = tmpDir('install');
const REGISTRY_DIR = tmpDir('registry');

/* ★ 商品类别 → 交付方式 → 报价类别 → 结算方式 → 结算原语 → 资产类别：
   整条映射都由**契约**算出来，因此本测试里没有一处硬编码"COMPUTE_GRANT"。 */
const PRODUCT_KIND = C.PRODUCT_KIND.COMPUTE_CREDIT;
const FULFILLMENT = C.FULFILLMENT_OF_PRODUCT_KIND[PRODUCT_KIND];
const QUOTE_KIND = C.productQuoteKindFor(FULFILLMENT).kind;
const SETTLEMENT_TYPE = C.settlementTypeOfQuoteKind(QUOTE_KIND);
const SETTLEMENT_PRIMITIVE = C.settlementPrimitiveOfFulfillment(FULFILLMENT).primitive;
const ASSET_KIND = C.ASSET_KIND_OF_PRODUCT_KIND[PRODUCT_KIND];

console.log('P22-21 · Economy v1 Golden Path');
console.log('  派生（全部来自契约）：kind=' + PRODUCT_KIND + ' → fulfillment=' + FULFILLMENT
  + ' → quoteKind=' + QUOTE_KIND + ' → settlementType=' + SETTLEMENT_TYPE
  + ' → primitive=' + SETTLEMENT_PRIMITIVE + ' → assetKind=' + ASSET_KIND);

/* ══════════════════════════════════════════════════════════════════════
   3 · 装配一个真实的 Home Node（含"重启"）
   ══════════════════════════════════════════════════════════════════════ */
let port = null;
let sourcePort = null;
let instance = null;
let store = null;
const ports = [];

async function boot(withProxy) {
  port = await freePort();
  ports.push(port);
  const options = {
    dataDir: DATA_DIR,
    registryDir: REGISTRY_DIR,
    host: '127.0.0.1',
    port: port,
    token: TOKEN,
    economyChannelSources: [{ consumer: CHANNEL.CONSUMER, token: SOURCE_TOKEN, boundPort: sourcePort }],
    logger: () => { }
  };
  /* ★ 装配层允许注入 store 实例（`options.economyStore`，见
     `services/home-node-service.js` 的 economyAssembly）。本测试在**第一次**
     装配时注入一个只读记账代理；"重启"那一次注入真实 store（§5-G 要的是
     重放而不是再记一遍边）。注入点不改变任何权威：三个写面仍然是唯一的
     写路径。 */
  if (withProxy) options.economyStore = instrument(STORE_MODULE({
    dataDir: DATA_DIR, logger: () => { }
  }));
  const inst = SERVICE.buildHomeNode(options);
  closables.push(inst);
  inst.open();
  await new Promise((resolve, reject) => {
    inst.server.once('error', reject);
    inst.server.listen(port, '127.0.0.1', resolve);
  });
  return inst;
}
async function shutdown(inst) {
  /* ★ 用**装配层自己的** `close()`（`buildHomeNode` 的导出），而不是只关
     economy store：同一个 dataDir 上还有 chat / memory / moments / registry
     的 SQLite 句柄，它们全都指着这个临时目录。开发期实测：只关 economy
     store 时 `home-node.db(-wal/-shm)` 仍然被别的句柄占着，于是收尾时
     `rmSync` 一直 EPERM，每次运行都留下一个目录 —— 而"临时目录 = 0"
     这句话在那之前是假的。 */
  try { inst.close(); } catch (_) {
    try { inst.economyStore.close(); } catch (_) { }
  }
  await new Promise(resolve => { try { inst.server.close(() => resolve()); } catch (_) { resolve(); } });
}

/* ── 读面快捷方式（全部走真实 HTTP）──────────────────────────────────── */
const get = (p) => request(port, 'GET', p, null, AUTH);
const configure = (envelope) => request(port, 'POST', CONFIG_PATH, envelope, AUTH);
const decide = (envelope) => request(port, 'POST', DECISION_PATH, envelope, AUTH);
function propose(envelope) { return boundRequest(port, sourcePort, 'POST', COMMAND_PATH, envelope, SOURCE_AUTH); }

/* ── 世界的**总账**：三个数字，重放前后必须完全不动 ───────────────────
   ★ 三个读面各自的参数语义都是 canonical 自己的（`/economy/ledger` 要求
     `transactionId` 或 `accountId`；`/economy/inventory` 的 owner 过滤是
     `ownerId`）。开发期实测：把 `/economy/ledger?limit=500` 当成"全账本"
     会静默拿到 400 —— 于是一个**恒为 0** 的三角量让所有重放断言都为真。
     这是本仓库反复出现过的那种"安静地为空气作证"，因此这里逐笔交易求和。 */
async function worldSnapshot(ownerId) {
  const purchases = await get('/economy/purchases?limit=200');
  const inventory = await get('/economy/inventory?ownerId=' + ownerId + '&limit=200');
  const rows = purchases.body.purchases || [];
  let delta = 0n;
  let ledgerEntries = 0;
  for (const p of rows) {
    const tx = await get('/economy/transaction?transactionId=' + p.ledgerTransactionId);
    const entries = (tx.body && tx.body.entries) || [];
    ledgerEntries += entries.length;
    for (const e of entries) {
      const amt = BigInt(String(e.amountMinor));
      delta += e.direction === C.ENTRY_DIRECTION.CREDIT ? amt : -amt;
    }
  }
  return {
    purchaseCount: rows.length,
    purchaseIds: rows.map(p => p.purchaseId).sort(),
    inventoryTotal: (inventory.body.entries || []).reduce((acc, e) => acc + Number(e.quantity), 0),
    inventoryRows: (inventory.body.entries || []).length,
    ledgerDelta: delta.toString(),
    ledgerEntries: ledgerEntries
  };
}

/* ══════════════════════════════════════════════════════════════════════
   4 · 主流程
   ══════════════════════════════════════════════════════════════════════ */
(async function main() {
  sourcePort = await freePort();
  instance = await boot(true);
  store = instance.economyStore;

  /* ══════════════════════════════════════════════════════════════════
     §9-A · fresh DB：诚实的空，而不是 0
     ══════════════════════════════════════════════════════════════════ */
  section('§9-A · fresh DB 的初始状态');

  const freshWallet = await get('/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR);
  check('G1 ★★★★★ fresh DB 上的钱包读面回答"查不到钱包"（404 `wallet-not-found`），**不是**一个 0 余额',
    freshWallet.status === 404 && String(freshWallet.body.error).indexOf('wallet') >= 0,
    { status: freshWallet.status, error: freshWallet.body.error });

  const freshSec = await get('/security');
  const sec = (freshSec.body.security || freshSec.body);
  check('G2 ★★★★★ 装配后三个写面**都开着**（凭据已配置 + 三个 store 入口就绪），而且各自路径都不在 /economy/ 下',
    sec.economyPolicy.configuration.open === true &&
    sec.economyPolicy.approvalDecision.open === true &&
    sec.economyPolicy.commandChannel.open === true &&
    sec.economyPolicy.configuration.pathIsNotUnderEconomyReadPaths === true &&
    sec.economyPolicy.approvalDecision.pathIsNotUnderEconomyReadPaths === true &&
    sec.economyPolicy.commandChannel.pathIsNotUnderEconomyReadPaths === true,
    { configuration: sec.economyPolicy.configuration.open,
      approvalDecision: sec.economyPolicy.approvalDecision.open,
      commandChannel: sec.economyPolicy.commandChannel.open });

  /* ══════════════════════════════════════════════════════════════════
     §9-B · 配置腿：三个命令，全部经过真实 HTTP + 真实凭据
     ══════════════════════════════════════════════════════════════════ */
  section('§9-B · Configuration seam（BOOTSTRAP_CREDIT → PUT_BUDGET_POLICY → PUT_AUTONOMY_POLICY）');

  instance.registry.putCharacter(AGENT, { nickname: 'P22-21 Golden Agent' });
  instance.registry.putCharacter(OTHER, { nickname: 'P22-21 Other Owner' });

  const boot1 = await configure({
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: AGENT, currency: CUR, amountMinor: BOOT_AMOUNT },
    idempotencyKey: K('boot')
  });
  check('G3 ★★★★★ BOOTSTRAP_CREDIT：一条 authenticated 请求 → 一次 canonical MINT + 一条真实账本交易',
    boot1.status === 200 && boot1.body.ok === true &&
    boot1.body.creditMinted === true && boot1.body.initialCreditMintedNow === true &&
    boot1.body.ledgerMutation === true && boot1.body.isProviderQuota === false &&
    boot1.body.isRealCurrency === false &&
    C.isEconomyId('TRANSACTION', boot1.body.transactionId),
    { status: boot1.status, body: boot1.body && { ok: boot1.body.ok, code: boot1.body.reasonCode, minted: boot1.body.creditMinted } });

  const budget1 = await configure({
    command: 'PUT_BUDGET_POLICY',
    config: {
      ownerId: AGENT, currency: CUR,
      limits: {
        perTransactionMinor: String(BOOT_AMOUNT), dailyMinor: String(BOOT_AMOUNT),
        weeklyMinor: String(BOOT_AMOUNT), monthlyMinor: String(BOOT_AMOUNT)
      }
    },
    idempotencyKey: K('budget')
  });
  check('G4 ★★★★★ PUT_BUDGET_POLICY：预算政策落在 canonical 行上（policyId + revision 都是真的）',
    budget1.status === 200 && budget1.body.ok === true && budget1.body.budgetPolicyWritten === true &&
    C.isEconomyId('BUDGET_POLICY', budget1.body.policyId) &&
    budget1.body.ledgerMutation === false,
    { status: budget1.status, code: budget1.body.reasonCode, policyId: budget1.body.policyId });

  /* ★ 自主策略：`enabled:true` 但审批阈值低于单价 ⇒ 结果必须是
     REQUIRE_APPROVAL（而不是 AUTO_ALLOW，也不是 DENY）。这件事由
     P22-7 的权威层决定，本测试只是让那条判决**有机会**发生。 */
  const autonomy1 = await configure({
    command: 'PUT_AUTONOMY_POLICY',
    config: {
      ownerId: AGENT, enabled: true,
      perPurchaseLimitMinor: String(BOOT_AMOUNT),
      dailyAutonomousLimitMinor: String(BOOT_AMOUNT),
      approvalAboveMinor: String(APPROVAL_ABOVE),
      allowedProductKinds: [PRODUCT_KIND],
      allowedSettlementTypes: [SETTLEMENT_TYPE],
      allowGift: false
    },
    idempotencyKey: K('autonomy')
  });
  check('G5 ★★★★★ PUT_AUTONOMY_POLICY：自主规则落盘，而且它**不是**一个放行开关（`enabled:true` 仍然可以判 REQUIRE_APPROVAL）',
    autonomy1.status === 200 && autonomy1.body.ok === true && autonomy1.body.autonomyPolicyWritten === true &&
    C.AUTONOMY_REPLACES_BUDGET === false && C.AUTONOMY_POLICY_GRANTS_BUDGET === false,
    { status: autonomy1.status, code: autonomy1.body.reasonCode, body: autonomy1.body && { ok: autonomy1.body.ok } });

  const autonomyEval = await get('/economy/autonomy-evaluation?ownerId=' + AGENT);
  check('G6 ★★★★★ 自主评估读面**可达**，而且它要求真的经济参数（`quoteId` + `buyerId`）—— 一条只读路由，不是一个"给我开权限"的入口',
    autonomyEval.status === 400 && autonomyEval.body.error === 'missing-quote-id-or-buyer-id',
    { status: autonomyEval.status, error: autonomyEval.body.error });

  /* ══════════════════════════════════════════════════════════════════
     §9-C · 目录 fixture（★ 显式标记：目录的管理面**故意不在** v1 公开面上）
     ══════════════════════════════════════════════════════════════════ */
  section('§9-C · 目录 fixture（catalog administration remains intentionally out of v1 public surface）');

  const storeRow = store.putStore({ name: 'P22-21 Golden Store', idempotencyKey: K('store') });
  const productRow = store.putProduct({
    storeId: storeRow.result.store.storeId, kind: PRODUCT_KIND, name: 'Compute bundle',
    currency: CUR, unitPriceMinor: UNIT_PRICE, grantQuantity: GRANT_QUANTITY,
    idempotencyKey: K('product')
  });
  const PRODUCT_ID = productRow.result.product.productId;

  check('G7 ★★★★★ 目录 fixture 用的是 store 内部 API —— 而且这一点的**理由**被逐字断言：配置面的三个命令里没有任何一个是目录写入',
    storeRow.ok === true && productRow.ok === true &&
    CONFIG.COMMAND_LIST.length === 3 &&
    CONFIG.COMMAND_LIST.indexOf('PUT_STORE') < 0 && CONFIG.COMMAND_LIST.indexOf('PUT_PRODUCT') < 0 &&
    CONFIG.CONFIG_KEYS.BOOTSTRAP_CREDIT.length === 3,
    { commands: CONFIG.COMMAND_LIST });

  check('G8 ★★★★★ 商品的价格与发放数量都来自 canonical 行（单价 ' + UNIT_PRICE + ' · 每份 ' + GRANT_QUANTITY + ' 件 · 资产类别 ' + ASSET_KIND + '）',
    String(productRow.result.product.unitPriceMinor) === String(UNIT_PRICE) &&
    Number(productRow.result.product.grantQuantity) === GRANT_QUANTITY &&
    productRow.result.product.assetKind === ASSET_KIND &&
    productRow.result.product.settlementType == null,
    { product: productRow.result.product && {
      unitPriceMinor: productRow.result.product.unitPriceMinor,
      grantQuantity: productRow.result.product.grantQuantity,
      assetKind: productRow.result.product.assetKind } });

  /* ══════════════════════════════════════════════════════════════════
     §9-D · Active producer → Intent → Approval
     ══════════════════════════════════════════════════════════════════ */
  section('§9-D · Agent WANT → Intent（WAITING_APPROVAL）+ Approval（PENDING）');

  const walletBefore = await get('/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR);
  const identity = CHANNEL.createCommandIdentity(K('producer'));
  const PROPOSAL = {
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
    proposal: { agentId: AGENT, productId: PRODUCT_ID, units: 1, reason: 'compute is running low' }
  };
  const proposed = await propose(PROPOSAL);

  check('G9 ★★★★★ 一条真实的 Active command 走完 command channel → action adapter → capability gate → intent：结果是 **WAIT_FOR_APPROVAL**，而且这一次**没有**创建任何购买',
    proposed.status === 200 && proposed.body.ok === true &&
    proposed.body.source === C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME &&
    proposed.body.result.verdict.outcome === C.INTENT_VERDICT.WAIT_FOR_APPROVAL &&
    proposed.body.result.authorityOutcome === C.AP_DECISION.REQUIRE_APPROVAL &&
    proposed.body.result.purchaseCreated === false &&
    proposed.body.result.reservedNothing === true &&
    proposed.body.result.nextAction === 'await-approval',
    { status: proposed.status, result: proposed.body.result && {
      outcome: proposed.body.result.verdict && proposed.body.result.verdict.outcome,
      authorityOutcome: proposed.body.result.authorityOutcome,
      purchaseCreated: proposed.body.result.purchaseCreated } });

  const INTENT_ID = proposed.body.result.intentId;
  const APPROVAL_ID = proposed.body.result.approvalId;

  const walletAfterProposal = await get('/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR);
  check('G10 ★★★★★ 审批腿**不预留**任何钱：余额与可用余额在 propose 之后逐字不变（`APPROVAL_PATH_RESERVES_NOTHING`）',
    String(walletAfterProposal.body.wallet.cachedBalanceMinor) === String(walletBefore.body.wallet.cachedBalanceMinor) &&
    String(walletAfterProposal.body.wallet.availableBalanceMinor) === String(walletBefore.body.wallet.availableBalanceMinor) &&
    String(walletAfterProposal.body.wallet.reservedBalanceMinor) === '0' &&
    C.PURCHASE_INTENT_APPROVAL_PATH_RESERVES_NOTHING === true,
    { before: walletBefore.body.wallet.availableBalanceMinor,
      after: walletAfterProposal.body.wallet.availableBalanceMinor,
      reserved: walletAfterProposal.body.wallet.reservedBalanceMinor });

  const intentRead = await get('/economy/intent?agentIntentId=' + INTENT_ID);
  const approvalRead = await get('/economy/approval?approvalId=' + APPROVAL_ID);
  check('G11 ★★★★★ Intent 与 Approval 都通过**只读 HTTP**读到，而且状态与 propose 的回答逐字一致',
    intentRead.status === 200 && intentRead.body.intent.state === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL &&
    approvalRead.status === 200 && approvalRead.body.approval.status === C.APPROVAL_STATE.PENDING &&
    approvalRead.body.approval.singleUse === true &&
    approvalRead.body.approval.boundToAQuoteSnapshot === true,
    { intent: intentRead.body.intent && intentRead.body.intent.state,
      approval: approvalRead.body.approval && approvalRead.body.approval.status });

  check('G12 ★★★★★ 那条 Approval 的绑定快照**逐字**等于 canonical 事实（quoteId / currency / amountMinor / settlementType / grantQuantity）',
    approvalRead.body.approval.quoteId === intentRead.body.intent.quoteId &&
    approvalRead.body.approval.currency === CUR &&
    String(approvalRead.body.approval.amountMinor) === String(UNIT_PRICE) &&
    approvalRead.body.approval.settlementType === SETTLEMENT_TYPE &&
    approvalRead.body.approval.settlementType === approvalRead.body.approval.quoteKind &&
    Number(approvalRead.body.approval.grantQuantity) === GRANT_QUANTITY,
    { approval: approvalRead.body.approval && {
      quoteId: approvalRead.body.approval.quoteId, amountMinor: approvalRead.body.approval.amountMinor,
      settlementType: approvalRead.body.approval.settlementType, grantQuantity: approvalRead.body.approval.grantQuantity } });

  const worldBeforeApproval = await worldSnapshot(AGENT);
  check('G13 ★★★★★ 批准之前的世界：0 笔购买 · 0 条库存 · 账本只有 BOOTSTRAP 那一条 MINT（世界此刻是诚实的空）',
    worldBeforeApproval.purchaseCount === 0 && worldBeforeApproval.inventoryRows === 0,
    worldBeforeApproval);

  /* ★ 用一个**真实存在的 quoteId** 做一次自主评估：它必须是快照评估，
     不锁钱、不建记录、不消费批准。 */
  const autonomyEval2 = await get('/economy/autonomy-evaluation?buyerId=' + AGENT + '&quoteId=' + intentRead.body.intent.quoteId);
  check('G13b ★★★★★ 自主评估是一次**快照**：`evaluatedOnly:true` · 不预留 · 不是预算决定 · 而且它的判决就是 REQUIRE_APPROVAL',
    autonomyEval2.status === 200 &&
    autonomyEval2.body.evaluatedOnly === true &&
    autonomyEval2.body.reserved === false &&
    autonomyEval2.body.decision && autonomyEval2.body.decision.outcome === C.AP_DECISION.REQUIRE_APPROVAL &&
    autonomyEval2.body.decision.evaluatedOnly === true &&
    autonomyEval2.body.decision.notABudgetDecision === true &&
    autonomyEval2.body.decision.grantsBudget === false &&
    autonomyEval2.body.decision.rule === 'amount-exceeds-the-autonomy-approval-threshold',
    { status: autonomyEval2.status, body: autonomyEval2.body && {
      evaluatedOnly: autonomyEval2.body.evaluatedOnly, reserved: autonomyEval2.body.reserved,
      decision: autonomyEval2.body.decision && autonomyEval2.body.decision.outcome } });

  /* ══════════════════════════════════════════════════════════════════
     §9-E · User decision seam → Resume → Purchase
     ══════════════════════════════════════════════════════════════════ */
  section('§9-E · User decision seam（APPROVE）→ Resume → Purchase（COMPLETED）');

  const DECISION_KEY = K('decision');
  const decided = await decide({ approvalId: APPROVAL_ID, decision: DECISION.DECISION.APPROVE, idempotencyKey: DECISION_KEY });

  check('G14 ★★★★★ 用户点头 → seam 记录决定 → 经 capability gate 的 RESUME_APPROVED_PURCHASE 继续 → 购买真的发生',
    decided.status === 200 && decided.body.ok === true &&
    decided.body.decision === C.APPROVAL_STATE.APPROVED &&
    decided.body.decider === 'user:user' &&
    decided.body.reachedResumeHandle === true &&
    decided.body.continuationOk === true &&
    decided.body.purchaseCreated === true &&
    decided.body.purchaseCreatedNow === true &&
    decided.body.continuedIntentState === C.PURCHASE_INTENT_STATE.COMPLETED &&
    decided.body.continuationResult.capability === C.CAPABILITY.RESUME_APPROVED_PURCHASE &&
    decided.body.continuationResult.consumer === C.ECONOMY_CONSUMER.USER_DECISION_SEAM,
    { status: decided.status, code: decided.body.reasonCode,
      continuation: decided.body.continuation, continuationOk: decided.body.continuationOk,
      purchaseCreated: decided.body.purchaseCreated });

  check('G15 ★★★★★ 决定本身**不是**一次购买许可的复制品：seam 自述决定不等于购买，而且批准**不绕过**预算与报价有效期',
    decided.body.approvalDoesNotGuaranteeAPurchase === true &&
    decided.body.budgetWasNotBypassed === true &&
    decided.body.quoteValidityWasNotBypassed === true &&
    C.APPROVAL_BYPASSES_BUDGET === false && C.APPROVAL_BYPASSES_QUOTE_EXPIRY === false,
    { doesNotGuarantee: decided.body.approvalDoesNotGuaranteeAPurchase });

  const PURCHASE_ID = decided.body.continuedPurchaseId;

  /* ══════════════════════════════════════════════════════════════════
     §9-F · canonical 结算审计
     ══════════════════════════════════════════════════════════════════ */
  section('§9-F · canonical 结算审计（钱包 / 账本 / 库存 / 终态 / 单次使用）');

  const walletAfter = await get('/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR);
  check('G16 ★★★★★ 钱包余额的**差**恰好等于那一笔金额（' + BOOT_AMOUNT + ' − ' + UNIT_PRICE + '），而且缓存与账本两个来源仍然相等',
    String(walletAfter.body.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT - UNIT_PRICE) &&
    String(walletAfter.body.wallet.ledgerBalanceMinor) === String(BOOT_AMOUNT - UNIT_PRICE) &&
    String(walletAfter.body.wallet.availableBalanceMinor) === String(BOOT_AMOUNT - UNIT_PRICE) &&
    walletAfter.body.wallet.cachedBalanceDrifted === false &&
    String(walletAfter.body.wallet.reservedBalanceMinor) === '0',
    { wallet: walletAfter.body.wallet && {
      cached: walletAfter.body.wallet.cachedBalanceMinor,
      ledger: walletAfter.body.wallet.ledgerBalanceMinor,
      reserved: walletAfter.body.wallet.reservedBalanceMinor } });

  const purchaseRead = await get('/economy/purchase?purchaseId=' + PURCHASE_ID);
  const purchase = purchaseRead.body.purchase;
  check('G17 ★★★★★ 购买是**终态成功**：COMPLETED · terminal · completed（三个词逐字都是 true），并且金额来源是 quote snapshot',
    purchaseRead.status === 200 && purchase.status === C.PURCHASE_STATE.COMPLETED &&
    purchase.terminal === true && purchase.completed === true &&
    String(purchase.amountMinor) === String(UNIT_PRICE) &&
    purchase.currency === CUR && purchase.assetKind === ASSET_KIND &&
    purchase.requiredUserApproval === true && purchase.autonomous === false &&
    C.PURCHASE_AMOUNT_SOURCE === 'quote-snapshot',
    { purchase: purchase && { status: purchase.status, completed: purchase.completed, amountMinor: purchase.amountMinor } });

  check('G18 ★★★★★ 购买**不是**账本交易 / **不是**预留 / **不是**报价 / **不是**批准，也没有退款（四个 isA* 与 hasRefund 逐字为 false）',
    purchase.isALedgerTransaction === false && purchase.isAReservation === false &&
    purchase.isAQuote === false && purchase.isAnApproval === false &&
    purchase.hasRefund === false && purchase.exposesHttpMutation === false,
    { purchase: purchase && { ledger: purchase.isALedgerTransaction, refund: purchase.hasRefund } });

  const txRead = await get('/economy/transaction?transactionId=' + purchase.ledgerTransactionId);
  const entries = txRead.body.entries || [];
  const signed = entries.reduce((acc, e) => {
    const amt = BigInt(String(e.amountMinor));
    return e.direction === C.ENTRY_DIRECTION.CREDIT ? acc + amt : acc - amt;
  }, 0n);
  check('G19 ★★★★★ 账本恰好**一笔**交易，而且它是**平衡的**（Σ DEBIT = Σ CREDIT），金额恰好是那一笔',
    txRead.status === 200 && entries.length === 2 && signed === 0n &&
    txRead.body.transaction.state === C.TX_STATE.COMMITTED &&
    String(purchase.ledgerTransactionId).indexOf('econ_tx_') === 0 &&
    txRead.body.transaction.transactionId === purchase.ledgerTransactionId &&
    entries.reduce((acc, e) => acc + BigInt(String(e.amountMinor)), 0n) === BigInt(UNIT_PRICE) * 2n,
    { entries: entries.length, signed: signed.toString(), state: txRead.body.transaction.state,
      txId: txRead.body.transaction.transactionId, purchaseTxId: purchase.ledgerTransactionId,
      sum: entries.reduce((acc, e) => acc + BigInt(String(e.amountMinor)), 0n).toString() });

  const invRead = await get('/economy/inventory?ownerId=' + AGENT);
  const invRows = invRead.body.entries || [];
  check('G20 ★★★★★ 库存**恰好发放一次**：一行 · 数量 ' + GRANT_QUANTITY + ' · 资产类别 ' + ASSET_KIND + ' · 而且它明确**不是**余额',
    invRows.length === 1 && Number(invRows[0].quantity) === GRANT_QUANTITY &&
    invRows[0].assetKind === ASSET_KIND && invRows[0].productId === PRODUCT_ID &&
    invRows[0].isABalance === false && invRead.body.isABalance === false &&
    invRows[0].contributesToAvailableBalance === false,
    { rows: invRows.length, quantity: invRows[0] && invRows[0].quantity });

  check('G21 ★★★★★ 结算原语与资产类别都是契约判定的那一格：`' + SETTLEMENT_PRIMITIVE + '` / `' + ASSET_KIND + '`（不是 provider quota）',
    purchase.settlementPrimitive === SETTLEMENT_PRIMITIVE &&
    purchase.settlementType === SETTLEMENT_TYPE &&
    purchase.grantedQuantity === Number(approvalRead.body.approval.grantQuantity) &&
    purchase.inventoryEntryId === invRows[0].inventoryEntryId,
    { primitive: purchase.settlementPrimitive, settlementType: purchase.settlementType,
      grantedQuantity: purchase.grantedQuantity });

  const intentAfter = await get('/economy/intent?agentIntentId=' + INTENT_ID);
  check('G22 ★★★★★ Intent 是**终态**：COMPLETED · terminal · 而且它记着那笔购买的 id（intent 链闭合）',
    intentAfter.body.intent.state === C.PURCHASE_INTENT_STATE.COMPLETED &&
    intentAfter.body.intent.terminal === true &&
    intentAfter.body.intent.purchaseId === PURCHASE_ID &&
    intentAfter.body.intent.approvalId === APPROVAL_ID &&
    C.PURCHASE_INTENT_TERMINAL_STATES.indexOf(intentAfter.body.intent.state) >= 0,
    { state: intentAfter.body.intent.state, purchaseId: intentAfter.body.intent.purchaseId });

  const approvalAfter = await get('/economy/approval?approvalId=' + APPROVAL_ID);
  check('G23 ★★★★★ Approval 是**终态且单次使用**：CONSUMED · 指向那一笔购买 · 而且消费发生在**结算**里（`consumedByPurchaseId` 有值）',
    approvalAfter.body.approval.status === C.APPROVAL_STATE.CONSUMED &&
    approvalAfter.body.approval.consumedByPurchaseId === PURCHASE_ID &&
    approvalAfter.body.approval.singleUse === true &&
    C.APPROVAL_TERMINAL_STATES.indexOf(approvalAfter.body.approval.status) >= 0 &&
    C.APPROVAL_IS_SINGLE_USE === true,
    { status: approvalAfter.body.approval.status, consumedBy: approvalAfter.body.approval.consumedByPurchaseId });

  /* ══════════════════════════════════════════════════════════════════
     §9-G · owner-scoped timeline
     ══════════════════════════════════════════════════════════════════ */
  section('§9-G · owner-scoped timeline（含另一个 owner 的噪声，用来证伪"泄漏"）');

  /* ★ 造一个**第二个 owner** 的真实活动：如果 owner 作用域是假的，
     这些行一定会出现在 AGENT 的时间线 / 库存读面里。
     ★ 这里刻意**不**做一次完整购买：那会需要给第二个 owner 配一整套
     预算 + 自主规则，而"证明不发生泄漏"需要的只是**归属第二个 owner 的
     canonical 行**。因此用两条最小的事实生成路径：
       ① 一条 buyerId = OTHER 的报价（价格命题）；
       ② 一次 ownerId = OTHER 的库存发放（资产事实）。 */
  await configure({
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: OTHER, currency: CUR, amountMinor: OTHER_AMOUNT },
    idempotencyKey: K('other-boot')
  });
  const otherStore = store.putStore({ name: 'Other Store', idempotencyKey: K('other-store') });
  const otherProduct = store.putProduct({
    storeId: otherStore.result.store.storeId, kind: C.PRODUCT_KIND.DIGITAL_ITEM, name: 'Other item',
    currency: CUR, unitPriceMinor: OTHER_PRICE, grantQuantity: 5, idempotencyKey: K('other-product')
  });
  const OTHER_PRODUCT_ID = otherProduct.result.product.productId;
  const otherQuote = store.createProductQuote({
    buyerId: OTHER, productId: OTHER_PRODUCT_ID, units: 1,
    expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: K('other-quote')
  });
  const otherGrant = store.grantInventory({
    ownerId: OTHER, productId: OTHER_PRODUCT_ID, quantity: 7, idempotencyKey: K('other-grant')
  });
  const OTHER_INVENTORY_ID = otherGrant.result.inventoryEntryId;

  const scoped = await get('/economy/changes?ownerId=' + AGENT + '&order=desc&limit=300');
  const scopedIds = (scoped.body.changes || []).map(c => String(c.entityId));
  const scopedRevs = (scoped.body.changes || []).map(c => Number(c.revision));
  const otherInventoryRead = await get('/economy/inventory?ownerId=' + OTHER);
  const agentInventoryRead = await get('/economy/inventory?ownerId=' + AGENT);

  check('G24 ★★★★★ owner 作用域**不泄漏**另一个 owner：另一个 owner 的报价 / 库存记录一个都没有出现在这条时间线里，而且两个 owner 的库存读面互不相交',
    otherQuote.ok === true && otherGrant.ok === true &&
    scopedIds.indexOf(otherQuote.result.quoteId) < 0 &&
    scopedIds.indexOf(OTHER_INVENTORY_ID) < 0 &&
    (otherInventoryRead.body.entries || []).length === 1 &&
    (otherInventoryRead.body.entries || [])[0].ownerId === OTHER &&
    (agentInventoryRead.body.entries || []).every(e => e.ownerId === AGENT) &&
    (agentInventoryRead.body.entries || []).every(e => e.inventoryEntryId !== OTHER_INVENTORY_ID) &&
    scoped.body.ownerScope.scoped === true && scoped.body.ownerScope.ownerId === AGENT,
    { ownerScope: scoped.body.ownerScope,
      leaked: scopedIds.filter(id => [otherQuote.result.quoteId, OTHER_INVENTORY_ID].indexOf(id) >= 0),
      otherInventory: (otherInventoryRead.body.entries || []).length,
      agentInventory: (agentInventoryRead.body.entries || []).length });

  check('G25 ★★★★★ 这条时间线包含这一次购买的 canonical revision，而且**newest-first**（严格递减）',
    scopedIds.indexOf(PURCHASE_ID) >= 0 &&
    scopedRevs.every((r, i) => i === 0 || r < scopedRevs[i - 1]) &&
    scoped.body.ownerScope.order === 'desc' &&
    scopedRevs.length >= 5,
    { revisions: scopedRevs.slice(0, 6), count: scopedRevs.length });

  check('G26 ★★★★★ §8 逐字：这条读面**不重算**任何经济事实（`recomputesEconomyFacts:false`），而且过滤发生在 canonical query 里',
    scoped.body.recomputesEconomyFacts === false,
    { recomputes: scoped.body.recomputesEconomyFacts });

  /* ══════════════════════════════════════════════════════════════════
     §9-H · UI 纯层投影
     ══════════════════════════════════════════════════════════════════ */
  section('§9-H · UI 纯层（economy-shell-core.js 的 buildPageView）显示 canonical 最终状态');

  const uiSandbox = (() => {
    const b = { console: { log() { }, warn() { }, error() { }, info() { } } };
    b.window = b; b.self = b;
    return vm.createContext(b);
  })();
  vm.runInContext(read('assets/js/economy-configuration-core.js'), uiSandbox, { filename: 'economy-configuration-core.js' });
  vm.runInContext(read('assets/js/economy-shell-core.js'), uiSandbox, { filename: 'economy-shell-core.js' });
  const CORE = uiSandbox.IB.economyShellCore;

  const sources = {
    owner: AGENT,
    wallet: (await get('/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR)).body,
    policy: (await get('/economy/policy?ownerId=' + AGENT)).body,
    budgetSnapshot: (await get('/economy/budget?ownerId=' + AGENT + '&amountMinor=0')).body,
    purchases: (await get('/economy/purchases?ownerId=' + AGENT + '&limit=200')).body,
    products: (await get('/economy/products?limit=200')).body,
    stores: (await get('/economy/stores?limit=200')).body,
    inventory: invRead.body,
    changes: scoped.body,
    intents: (await get('/economy/intents?limit=200')).body
  };
  const view = CORE.buildPageView(sources);

  /* ★ 金额的"逐字透传"怎么断言才诚实：canonical 把它序列化成**十进制字符串**
     （`availableBalanceMinor = "990000"`），而 UI 的第一格是一个**排版过的**
     数字（`"9,900.00"`，币种 scale 由契约持有）。因此判据是
     "把小数字符一位不差地取出后等于 canonical 的那串数字" —— 既不重算，
     也不假装两者形状相同。这比 `===` 更强：任何一位数字被页面改动都会红。 */
  const digitsOf = (s) => String(s).replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  const canonicalAvailable = sources.wallet.wallet.availableBalanceMinor;

  check('G27 ★★★★★ UI 纯层显示的余额**就是** canonical 字段 `availableBalanceMinor`（逐位相同，不做减法、不做重算）',
    view.wallet.present === true && view.wallet.known === true &&
    String(view.wallet.primary).length > 0 &&
    digitsOf(view.wallet.primary) === digitsOf(canonicalAvailable) &&
    digitsOf(view.wallet.primary) === String(BOOT_AMOUNT - UNIT_PRICE),
    { primary: view.wallet.primary, canonical: canonicalAvailable,
      primaryDigits: digitsOf(view.wallet.primary), canonicalDigits: digitsOf(canonicalAvailable) });

  const purchaseRow = (view.purchases.rows || []).filter(r => String(r.purchaseId) === String(PURCHASE_ID))[0];
  const activityRow = (view.activity.rows || []).filter(r => String(r.purchaseId) === String(PURCHASE_ID))[0];
  check('G28 ★★★★★ UI 纯层显示的那一笔购买是 canonical 的 COMPLETED，而且金额**原样**带着 canonical 的十进制金额（`amountMinor` 一位不改）',
    purchaseRow != null && purchaseRow.completed === true && purchaseRow.terminal === true &&
    purchaseRow.status === C.PURCHASE_STATE.COMPLETED &&
    digitsOf(purchaseRow.amountText) === String(UNIT_PRICE) &&
    activityRow != null && String(activityRow.amountMinor) === String(UNIT_PRICE) &&
    purchaseRow.productId === PRODUCT_ID,
    { purchaseRow: purchaseRow && { status: purchaseRow.status, completed: purchaseRow.completed, amountText: purchaseRow.amountText },
      activityRowAmountMinor: activityRow && activityRow.amountMinor,
      rows: (view.purchases.rows || []).map(r => r.purchaseId) });

  const assetRows = (view.assets.groups || []).reduce((acc, g) => acc.concat(g.rows || []), []);
  check('G29 ★★★★★ UI 纯层显示的资产数量**就是** canonical 的库存数量（' + GRANT_QUANTITY + ' · ' + ASSET_KIND + '），而且它明确不是余额',
    assetRows.some(r => String(r.productId) === String(PRODUCT_ID) &&
      Number(r.quantity) === GRANT_QUANTITY && r.assetKind === ASSET_KIND && r.isABalance === false),
    { rows: assetRows.map(r => ({ productId: r.productId, quantity: r.quantity, assetKind: r.assetKind })),
      groups: (view.assets.groups || []).map(g => ({ kind: g.assetKind, n: (g.rows || []).length })) });

  check('G30 ★★★★★ UI 纯层的时间线指向同一个 owner，而且它把 completeness 如实说出（`complete` / `truncated` / `unknown` 三态之一）',
    view.timeline.ownerId === AGENT &&
    [CORE.COMPLETENESS.COMPLETE, CORE.COMPLETENESS.TRUNCATED, CORE.COMPLETENESS.UNKNOWN].indexOf(view.timeline.completeness) >= 0,
    { ownerId: view.timeline.ownerId, completeness: view.timeline.completeness });

  check('G31 ★★★★★ UI 纯层里没有**任何**"页面自己算出来的权威"：余额 / 预算允许 / 批准有效性 / 购买成功 / 报价有效性五个判断都不在纯层做',
    (() => {
      const src = read('assets/js/economy-shell-core.js');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      const forbidden = [
        { what: '自己算可用余额', re: /availableBalanceMinor\s*-\s*|\-\s*reservedBalanceMinor/ },
        { what: '自己判预算 allowed', re: /decision\s*===\s*'ALLOW'|budgetDecision\s*===\s*'ALLOW'/ },
        { what: '自己判批准有效', re: /approval[A-Za-z]*\.status\s*===\s*'APPROVED'\s*&&/ },
        { what: '自己判购买成功', re: /amountMinor\s*[<>]=?\s*|completed\s*=\s*amountMinor/ },
        { what: '自己判报价有效', re: /expiresAt\s*[<>]\s*Date\.now|quoteValid\s*=/ }
      ];
      const hits = forbidden.filter(f => f.re.test(code)).map(f => f.what);
      return { ok: hits.length === 0, hits: hits };
    })().ok,
    (() => {
      const code = read('assets/js/economy-shell-core.js').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
      return ['availableBalanceMinor\\s*-', 'decision\\s*===\\s*\'ALLOW\'', 'expiresAt\\s*[<>]\\s*Date\\.now']
        .filter(re => new RegExp(re).test(code));
    })());

  const worldAfterGolden = await worldSnapshot(AGENT);

  /* ══════════════════════════════════════════════════════════════════
     §1 · authority graph（从**真实记录的调用边**生成）
     ══════════════════════════════════════════════════════════════════ */
  section('§1 · authority graph：真实调用边与 shortcut edge = 0');

  const graphFiles = Array.from(new Set(EDGES.map(e => e.from.file))).sort();
  check('A1 ★★★★★ 这次金路径上记录到的调用边**真的来自生产文件**（而不是测试文件自己调 store）',
    EDGES.length > 0 &&
    graphFiles.indexOf('services/home-node/economy-configuration.js') >= 0 &&
    graphFiles.indexOf('services/home-node/economy-approval-decision.js') >= 0 &&
    graphFiles.indexOf('services/home-node/economy-capability.js') >= 0 &&
    graphFiles.indexOf('services/home-node/http.js') >= 0,
    { edgeCount: EDGES.length, files: graphFiles });

  function hasEdge(file, verb) {
    return EDGES.some(e => e.from.file.indexOf(file) >= 0 && e.to === verb);
  }
  function edgesTo(verbs, files) {
    return EDGES.filter(e => verbs.indexOf(e.to) >= 0 &&
      (!files || files.some(f => e.from.file.indexOf(f) >= 0)));
  }

  check('A2 ★★★★★ 配置权威边：`economy-configuration.js` → bootstrapInitialCredit / putBudgetPolicy / putAutonomyPolicy（三条都真实发生过）',
    hasEdge('economy-configuration.js', 'bootstrapInitialCredit') &&
    hasEdge('economy-configuration.js', 'putBudgetPolicy') &&
    hasEdge('economy-configuration.js', 'putAutonomyPolicy'),
    edgesFrom('economy-configuration.js').map(e => e.to));

  check('A3 ★★★★★ 用户决定权威边：`economy-approval-decision.js` → decideApproval，然后 **capability gate** 才是 resume 的发起者',
    hasEdge('economy-approval-decision.js', 'decideApproval') &&
    hasEdge('economy-capability.js', 'resumeAgentPurchaseIntent') &&
    hasEdge('economy-capability.js', 'proposeAgentPurchaseIntent'),
    { approvalDecision: edgesFrom('economy-approval-decision.js').map(e => e.to),
      capability: edgesFrom('economy-capability.js').map(e => e.to) });

  check('A4 ★★★★★ 读模型权威边：`http.js` 只调**只读**方法（这一次运行里 http.js 一次写动词都没有调）',
    edgesTo(Array.from(WRITE_VERBS), ['http.js']).length === 0,
    edgesTo(Array.from(WRITE_VERBS), ['http.js']));

  check('A5 ★★★★★ SHORTCUT①  **UI → store**：这次运行里没有任何一条边的调用者来自 `assets/`（浏览器结构上拿不到 store）',
    EDGES.filter(e => e.from.file.indexOf('assets/') >= 0).length === 0,
    EDGES.filter(e => e.from.file.indexOf('assets/') >= 0).slice(0, 5));

  check('A6 ★★★★★ SHORTCUT②  **Approval → Purchase settle**：`economy-approval-decision.js` 一次都没有直接调 settlePurchase / preparePurchase / commitLedgerTransaction',
    edgesTo(['settlePurchase', 'preparePurchase', 'cancelPurchase', 'commitLedgerTransaction'], ['economy-approval-decision.js']).length === 0,
    edgesTo(['settlePurchase', 'preparePurchase', 'cancelPurchase', 'commitLedgerTransaction'], ['economy-approval-decision.js']));

  check('A7 ★★★★★ SHORTCUT③  **Configuration → Purchase**：配置面一次都没有碰购买 / 库存 / 结算 / 账本',
    edgesTo(['settlePurchase', 'preparePurchase', 'grantInventory', 'consumeInventory',
      'commitLedgerTransaction', 'mintForSystem', 'reserveFunds', 'commitReservation',
      'mutateInventoryInTx', 'buildCommitEntries'], ['economy-configuration.js']).length === 0,
    edgesFrom('economy-configuration.js').map(e => e.to));

  check('A8 ★★★★★ SHORTCUT④  **Agent → Ledger**：capability gate 一次都没有直接调账本原语（它只会 propose / resume）',
    edgesTo(['mintForSystem', 'burnForSystem', 'commitLedgerTransaction', 'settlePurchase',
      'preparePurchase', 'reserveFunds', 'grantInventory'], ['economy-capability.js']).length === 0,
    edgesFrom('economy-capability.js').map(e => e.to));

  check('A9 ★★★★★ SHORTCUT⑤  **Transport → store**：command channel 与 action adapter 都不持有 store，因此它们到 store 的边为 0',
    edgesFrom('economy-command-channel.js').length === 0 &&
    edgesFrom('economy-action-adapter.js').length === 0,
    { channel: edgesFrom('economy-command-channel.js').length,
      adapter: edgesFrom('economy-action-adapter.js').length });

  check('A10 ★★★★★ 每条边的 `authority carried` 都可判定：调用者文件是生产文件，而被调用的方法在 manifest §3.1 的七动词之内或**只读**',
    (() => {
      const bad = EDGES.filter(e => /test_p22_21/.test(e.from.file));
      return bad.length === 0;
    })(),
    EDGES.filter(e => /test_p22_21/.test(e.from.file)).slice(0, 5));

  /* ══════════════════════════════════════════════════════════════════
     §5 · exactly-once 七层重放
     ══════════════════════════════════════════════════════════════════ */
  section('§5 · exactly-once：七层重放之后，世界逐字不变');

  /* A · producer 重发（同一 commandId + 同一 idempotencyKey） */
  const replayA = await propose(PROPOSAL);
  const worldA = await worldSnapshot(AGENT);
  check('R-A ★★★★★ producer 重发（同 commandId + 同 idempotencyKey）：拿到**同一条** intent，而且这一次**没有**新建购买，世界逐字不变',
    replayA.status === 200 &&
    replayA.body.result.intentId === INTENT_ID &&
    replayA.body.result.purchaseCreated !== true &&
    J(worldA) === J(worldAfterGolden),
    { world: worldA, expected: worldAfterGolden,
      intentId: replayA.body.result && replayA.body.result.intentId, expectedIntentId: INTENT_ID,
      purchaseCreated: replayA.body.result && replayA.body.result.purchaseCreated });

  /* B · transport 重发（同一 idempotencyKey，但**换一个** commandId：
     模拟通道身份丢失 / 通道重启后重发）*/
  const freshIdentity = CHANNEL.createCommandIdentity(K('producer-retry'));
  const replayB = await propose({
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE,
    commandId: freshIdentity.commandId,
    idempotencyKey: PROPOSAL.idempotencyKey,
    proposal: PROPOSAL.proposal
  });
  const worldB = await worldSnapshot(AGENT);
  check('R-B ★★★★★ transport 重发（同 idempotencyKey · **换一个** commandId）：通道认为是一条新 command，而**下游**把它认成同一条 intent，仍然没有第二笔购买',
    replayB.status === 200 &&
    replayB.body.commandId !== PROPOSAL.commandId &&
    J(worldB) === J(worldAfterGolden),
    { world: worldB, commandIdChanged: replayB.body.commandId !== PROPOSAL.commandId,
      downstreamReason: replayB.body.downstreamReasonCode, ok: replayB.body.ok });

  /* C · intent 层重发（同进程 canonical API 的幂等那一层）*/
  const intentReplay = store.proposeAgentPurchaseIntent({
    proposal: PROPOSAL.proposal, idempotencyKey: PROPOSAL.idempotencyKey
  });
  const worldC = await worldSnapshot(AGENT);
  check('R-C ★★★★★ intent 层重发（store 的 canonical 幂等）：回答是**重放**而不是新事实，世界仍然逐字不变',
    intentReplay.ok === true && intentReplay.replayed === true &&
    intentReplay.intentId === INTENT_ID &&
    J(worldC) === J(worldAfterGolden),
    { ok: intentReplay.ok, replayed: intentReplay.replayed, intentId: intentReplay.intentId });

  /* D · approval decision 重发（同 idempotencyKey）*/
  const replayD = await decide({ approvalId: APPROVAL_ID, decision: DECISION.DECISION.APPROVE, idempotencyKey: DECISION_KEY });
  const worldD = await worldSnapshot(AGENT);
  check('R-D ★★★★★ 批准决定重发（同 idempotencyKey）：seam 回答 `replayed:true`，**这一次没有**新建购买（`purchaseCreatedNow` 才是增量），世界逐字不变',
    replayD.status === 200 && replayD.body.ok === true && replayD.body.replayed === true &&
    replayD.body.purchaseCreatedNow !== true &&
    J(worldD) === J(worldAfterGolden),
    { replayed: replayD.body.replayed, purchaseCreatedNow: replayD.body.purchaseCreatedNow, purchaseExists: replayD.body.purchaseExists, world: worldD });

  /* E · resume 重发（**换一个** decision idempotencyKey，同一个已消费的 approval）*/
  const replayE = await decide({ approvalId: APPROVAL_ID, decision: DECISION.DECISION.APPROVE, idempotencyKey: K('decision-2') });
  const worldE = await worldSnapshot(AGENT);
  check('R-E ★★★★★ resume 重发（换一个决定幂等键 · 同一个已被消费的 approval）：单次使用**赢**，拒绝且零经济动作',
    replayE.status !== 200 &&
    replayE.body.ok !== true &&
    replayE.body.purchaseCreatedNow !== true &&
    J(worldE) === J(worldAfterGolden),
    { status: replayE.status, reasonCode: replayE.body.reasonCode, world: worldE });

  /* F · settlement 重发（同进程 canonical API）*/
  const replayF = store.settlePurchase({ purchaseId: PURCHASE_ID, idempotencyKey: K('settle-2') });
  const worldF = await worldSnapshot(AGENT);
  check('R-F ★★★★★ 结算重发（同进程 canonical API · 换一个幂等键）：终态**不可复活**，拒绝且世界逐字不变',
    replayF.ok !== true &&
    J(worldF) === J(worldAfterGolden),
    { ok: replayF.ok, reasonCode: replayF.reasonCode, errors: replayF.errors, world: worldF });

  /* G · restart 之后重发 */
  await shutdown(instance);
  instance = await boot(false);
  store = instance.economyStore;
  const worldAfterRestart = await worldSnapshot(AGENT);
  const replayG1 = await propose(PROPOSAL);
  const replayG2 = await decide({ approvalId: APPROVAL_ID, decision: DECISION.DECISION.APPROVE, idempotencyKey: DECISION_KEY });
  const worldG = await worldSnapshot(AGENT);
  check('R-G ★★★★★ 重启之后重发（producer + approval decision 两条都重发）：世界在重启前后**逐字相同**，而且重放之后仍然逐字相同',
    J(worldAfterRestart) === J(worldAfterGolden) &&
    J(worldG) === J(worldAfterGolden) &&
    replayG1.status === 200 &&
    replayG2.status === 200 &&
    replayG2.body.purchaseCreatedNow !== true,
    { afterRestart: worldAfterRestart, afterReplay: worldG, expected: worldAfterGolden,
      g1: { status: replayG1.status, purchaseCreated: replayG1.body.result && replayG1.body.result.purchaseCreated },
      g2: { status: replayG2.status, purchaseCreatedNow: replayG2.body.purchaseCreatedNow, replayed: replayG2.body.replayed } });

  check('R-SUMMARY ★★★★★ 七层重放**联合**结论：购买数量 1 · 库存总量 ' + GRANT_QUANTITY + ' · 账本 delta 0 —— 三层身份（producer / transport / store）没有争权，也没有第二套 dedupe',
    worldG.purchaseCount === 1 && worldG.inventoryTotal === GRANT_QUANTITY &&
    worldG.ledgerDelta === '0' &&
    worldG.ledgerEntries === worldAfterGolden.ledgerEntries,
    worldG);

  /* ══════════════════════════════════════════════════════════════════
     §10 · 六条失败金路径
     ══════════════════════════════════════════════════════════════════ */
  section('§10 · 六条失败金路径（全部 fail closed）');

  /* 失败金路径要一个新的、干净的世界（另一个 owner），
     这样"没有未经授权的变更"是一个可读的差。 */
  const FAIL_OWNER = 'p2221gp_fail';
  /* ★ `REJECT_OWNER` 在这里就声明（而不是在 case B 那里）：它在
     `failWorld()` 的 owner 名单里，而 TDZ 会让"先声明后使用"变成一条
     运行期崩溃而不是一条编译错误 —— 开发期实测踩到过。 */
  const REJECT_OWNER = 'p2221gp_reject';
  instance.registry.putCharacter(FAIL_OWNER, { nickname: 'Failure Owner' });
  await configure({
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: FAIL_OWNER, currency: CUR, amountMinor: 100000 },
    idempotencyKey: K('fail-boot')
  });
  /* 预算：单笔上限 100 minor ⇒ 买 10000 的那件必然被拒。 */
  await configure({
    command: 'PUT_BUDGET_POLICY',
    config: {
      ownerId: FAIL_OWNER, currency: CUR,
      limits: { perTransactionMinor: '100', dailyMinor: '100', weeklyMinor: '100', monthlyMinor: '100' }
    },
    idempotencyKey: K('fail-budget')
  });
  await configure({
    command: 'PUT_AUTONOMY_POLICY',
    config: {
      ownerId: FAIL_OWNER, enabled: true,
      perPurchaseLimitMinor: '1000000', dailyAutonomousLimitMinor: '1000000',
      approvalAboveMinor: '1000000',
      allowedProductKinds: [PRODUCT_KIND], allowedSettlementTypes: [SETTLEMENT_TYPE], allowGift: false
    },
    idempotencyKey: K('fail-autonomy')
  });
  /* ★ 这一格的用意必须写清楚：自主规则**故意**宽（AUTO_ALLOW），于是这一条
     拒绝**只能**来自预算。开发期实测：一开始把自主上限也压到 100 时，
     判决是 `AUTONOMY_LIMIT` 而不是预算拒绝 —— 断言照样"通过"（它也是
     DENY），但它证明的**不是**预算那一层。这与 P22-20 §3 的差分控制组
     同一个教训：只断言"被拒绝了"不足以证明是**哪一道**闸门拒绝的。 */

  /* ★ 失败金路径涉及**三个** owner（FAIL_OWNER / REJECT_OWNER / AGENT），而
     /economy/inventory 的 owner 过滤是必填语义（不带 ownerId 时那条
     canonical query 返回空集）。因此这里的"库存总量"是**按 owner 逐个读**再
     相加 —— 一个恒为 0 的三角量会让每一条 fail-closed 断言都变成空话。 */
  const OWNERS_IN_PLAY = function () { return [AGENT, FAIL_OWNER, REJECT_OWNER, OTHER]; };
  async function failWorld() {
    const purchases = await get('/economy/purchases?limit=200');
    let inventoryRows = 0;
    /* ★ 名单在**调用时**才求值：`REJECT_OWNER` 在下面的 case B 里才声明，
       而在这一行求值会撞上 TDZ（开发期实测：`Cannot access
       'REJECT_OWNER' before initialization`）。 */
    for (const owner of OWNERS_IN_PLAY()) {
      const inv = await get('/economy/inventory?ownerId=' + owner + '&limit=200');
      inventoryRows += (inv.body.entries || []).length;
    }
    return { purchases: (purchases.body.purchases || []).length, inventoryRows: inventoryRows };
  }
  const failBefore = await failWorld();
  const failResults = [];

  /* ── A · Budget deny ──────────────────────────────────────────── */
  const idA = CHANNEL.createCommandIdentity(K('fail-budget'));
  const A = await propose({
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE, commandId: idA.commandId, idempotencyKey: idA.idempotencyKey,
    proposal: { agentId: FAIL_OWNER, productId: PRODUCT_ID, units: 1, reason: 'over budget' }
  });
  const failAState = await get('/economy/intents?limit=200');
  const failAIntent = (failAState.body.intents || []).filter(i => i.agentIntentId === A.body.result.intentId)[0];
  /* ★ 这一条**只能**由预算拒绝：自主规则故意宽（AUTO_ALLOW），因此判决走到
     了执行腿，而执行腿在 prepare 的预算再评估上失败。断言的形状因此是
     "终态解释了失败 + 理由码属于**预算族**"，而不是一个写死的状态名 ——
     写死状态名会把"它其实被自主上限拒了"这种错因也判成绿。 */
  const BUDGET_DENIAL_CODES = [C.DENY_REASON.PER_TX_LIMIT, C.DENY_REASON.AMOUNT_EXCEEDS_PER_TRANSACTION,
    C.DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE,
    C.DENY_REASON.INSUFFICIENT_BALANCE, C.DENY_REASON.DAILY_LIMIT, C.DENY_REASON.EMERGENCY_RESERVE];
  failResults.push({
    name: 'A · Budget deny',
    /* ★ 这一条测的是**预算**那一道闸门，而它只可能由预算拒绝：自主规则故意
       宽（AUTO_ALLOW），所以判决走到了执行腿，然后执行腿在 prepare 的
       预算再评估上失败。开发期实测：一开始把自主上限也压到 100，判决是
       `AUTONOMY_LIMIT` 而不是预算拒绝 —— 断言照样"通过"（它也是 DENY），
       但它证明的**不是**预算那一层。这与 P22-20 §3 的差分控制组同一个教训。
       ★ 而 HTTP 状态不写死：通道把一次**下游经济拒绝**如实报成一次投递结果
       （它自己的 DELIVERY 词表），而不是一个 200 —— 因此这里断言的形状是
       "no purchase + 预算理由码 + 终态解释了失败"，而不是一个状态码。 */
    ok: A.body.result.purchaseCreated !== true &&
      A.body.result.authorityOutcome === C.AP_DECISION.AUTO_ALLOW &&
      failAIntent && failAIntent.terminal === true && failAIntent.purchaseId === null &&
      BUDGET_DENIAL_CODES.indexOf(failAIntent.reasonCode) >= 0 &&
      BUDGET_DENIAL_CODES.indexOf(A.body.result.reasonCode) >= 0 &&
      (failAIntent.state === C.PURCHASE_INTENT_STATE.FAILED || failAIntent.state === C.PURCHASE_INTENT_STATE.DENIED),
    detail: { httpStatus: A.status, delivery: A.body.delivery,
      authorityOutcome: A.body.result && A.body.result.authorityOutcome,
      outcome: A.body.result && A.body.result.verdict && A.body.result.verdict.outcome,
      reasonCode: A.body.result && A.body.result.reasonCode,
      state: failAIntent && failAIntent.state,
      intentReasonCode: failAIntent && failAIntent.reasonCode,
      intentTerminal: failAIntent && failAIntent.terminal,
      intentPurchaseId: failAIntent && failAIntent.purchaseId,
      conditions: {
        noPurchase: A.body.result.purchaseCreated !== true,
        autoAllowed: A.body.result.authorityOutcome === C.AP_DECISION.AUTO_ALLOW,
        terminal: !!(failAIntent && failAIntent.terminal === true),
        noPurchaseId: !!(failAIntent && failAIntent.purchaseId === null),
        budgetCodeOnIntent: !!(failAIntent && BUDGET_DENIAL_CODES.indexOf(failAIntent.reasonCode) >= 0),
        budgetCodeOnResult: BUDGET_DENIAL_CODES.indexOf(A.body.result.reasonCode) >= 0,
        terminalState: !!(failAIntent && (failAIntent.state === C.PURCHASE_INTENT_STATE.FAILED ||
          failAIntent.state === C.PURCHASE_INTENT_STATE.DENIED))
      } }
  });

  /* ── B · Approval reject ──────────────────────────────────────── */
  /* 先造一条**等待审批**的 intent：预算放宽到能过、审批阈值压到必然要求审批。 */
  instance.registry.putCharacter(REJECT_OWNER, { nickname: 'Reject Owner' });
  await configure({
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: REJECT_OWNER, currency: CUR, amountMinor: 500000 },
    idempotencyKey: K('rej-boot')
  });
  await configure({
    command: 'PUT_BUDGET_POLICY',
    config: {
      ownerId: REJECT_OWNER, currency: CUR,
      limits: { perTransactionMinor: '500000', dailyMinor: '500000', weeklyMinor: '500000', monthlyMinor: '500000' }
    },
    idempotencyKey: K('rej-budget')
  });
  await configure({
    command: 'PUT_AUTONOMY_POLICY',
    config: {
      ownerId: REJECT_OWNER, enabled: true, perPurchaseLimitMinor: '500000',
      dailyAutonomousLimitMinor: '500000', approvalAboveMinor: String(APPROVAL_ABOVE),
      allowedProductKinds: [PRODUCT_KIND], allowedSettlementTypes: [SETTLEMENT_TYPE], allowGift: false
    },
    idempotencyKey: K('rej-autonomy')
  });
  const idB = CHANNEL.createCommandIdentity(K('rej'));
  const B = await propose({
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE, commandId: idB.commandId, idempotencyKey: idB.idempotencyKey,
    proposal: { agentId: REJECT_OWNER, productId: PRODUCT_ID, units: 1, reason: 'please approve' }
  });
  const rejApprovalId = B.body.result.approvalId;
  const B2 = await decide({ approvalId: rejApprovalId, decision: DECISION.DECISION.REJECT, idempotencyKey: K('rej-decide') });
  const rejApproval = await get('/economy/approval?approvalId=' + rejApprovalId);
  const rejIntent = await get('/economy/intent?agentIntentId=' + B.body.result.intentId);
  /* ★ 一条**真实的语义发现**（本阶段记录为 debt D6，见 docs §13）：
     REJECT 之后 Approval 立刻是终态 REJECTED，而 Intent **保持**
     WAITING_APPROVAL —— seam 在 REJECT 上刻意没有 continuation
     （`rejectHasNoContinuation: true`），因此那条 intent 的终态化是**惰性**的
     （下一次执行时才会被判 DENIED/FAILED）。
     ★ 因此这条断言证明的不是"intent 立刻变 DENIED"，而是更强的那件事：
     **一条带终态批准的 intent 无法再产生任何经济事实**。证法是把后续的
     每一条可达路径都走一遍：再点一次 APPROVE（换幂等键）被拒、
     propose 重发只回同一条 intent、世界逐字不变。 */
  const rejReplay = await decide({ approvalId: rejApprovalId, decision: DECISION.DECISION.APPROVE, idempotencyKey: K('rej-approve-after-reject') });
  const rejWorldAfter = await failWorld();
  failResults.push({
    name: 'B · Approval reject',
    ok: B2.status === 200 && B2.body.ok === true &&
      B2.body.decision === C.APPROVAL_STATE.REJECTED &&
      B2.body.purchaseCreatedNow !== true && B2.body.resumeAttempted === false &&
      /* ★ "REJECT 没有 continuation" 是 seam 的**自述位**（在 `describe()` 上），
         不是 dispatch 响应上的字段 —— 开发期实测把它当响应字段读会恒为
         undefined，于是那一条断言**永远**为假而看起来像一条真实的不变量。
         行为形式是 `resumeAttempted === false`（上面那一条），自述形式在这里。 */
      instance.economyApprovalDecision.describe().rejectHasNoContinuation === true &&
      rejApproval.body.approval.status === C.APPROVAL_STATE.REJECTED &&
      C.APPROVAL_TERMINAL_STATES.indexOf(rejApproval.body.approval.status) >= 0 &&
      rejIntent.body.intent.purchaseId === null &&
      /* 终态不可复活：拒绝之后再点头，refused 且零经济动作。 */
      rejReplay.status !== 200 && rejReplay.body.ok !== true &&
      rejReplay.body.purchaseCreatedNow !== true &&
      rejWorldAfter.purchases === failBefore.purchases &&
      rejWorldAfter.inventoryRows === failBefore.inventoryRows,
    detail: { decision: B2.body.decision, resumeAttempted: B2.body.resumeAttempted,
      rejectHasNoContinuation: B2.body.rejectHasNoContinuation,
      seamSaysRejectHasNoContinuation: instance.economyApprovalDecision.describe().rejectHasNoContinuation,
      approval: rejApproval.body.approval && rejApproval.body.approval.status,
      intent: rejIntent.body.intent && rejIntent.body.intent.state,
      intentPurchaseId: rejIntent.body.intent.purchaseId,
      approveAfterReject: { status: rejReplay.status, code: rejReplay.body.reasonCode,
        ok: rejReplay.body.ok, purchaseCreatedNow: rejReplay.body.purchaseCreatedNow },
      world: rejWorldAfter, before: failBefore,
      conditions: {
        b2status: B2.status === 200, b2ok: B2.body.ok === true,
        decisionRejected: B2.body.decision === C.APPROVAL_STATE.REJECTED,
        noNewPurchase: B2.body.purchaseCreatedNow !== true,
        noResume: B2.body.resumeAttempted === false,
        rejectNoContinuation: instance.economyApprovalDecision.describe().rejectHasNoContinuation === true,
        approvalRejected: rejApproval.body.approval.status === C.APPROVAL_STATE.REJECTED,
        approvalTerminal: C.APPROVAL_TERMINAL_STATES.indexOf(rejApproval.body.approval.status) >= 0,
        intentNoPurchase: rejIntent.body.intent.purchaseId === null,
        replayRefused: rejReplay.status !== 200 && rejReplay.body.ok !== true,
        replayNoPurchase: rejReplay.body.purchaseCreatedNow !== true,
        worldPurchases: rejWorldAfter.purchases === failBefore.purchases,
        worldInventory: rejWorldAfter.inventoryRows === failBefore.inventoryRows
      } }
  });

  /* ── C · Approval expire（★ 到期是**时间**事实，不是定时器：store 的
        `expireApproval` 要求 `now` 已经越过 `expires_at` —— 这正是
        开库对账会做的事。这里显式把 `now` 放在 expiresAt 之后，
        因此这一条测的是**真实的到期语义**，不是"手动改状态"。）──────── */
  const idC = CHANNEL.createCommandIdentity(K('exp'));
  const Cp = await propose({
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE, commandId: idC.commandId, idempotencyKey: idC.idempotencyKey,
    proposal: { agentId: REJECT_OWNER, productId: PRODUCT_ID, units: 2, reason: 'will expire' }
  });
  const expApprovalId = Cp.body.result.approvalId;
  const expApprovalBefore = await get('/economy/approval?approvalId=' + expApprovalId);
  const pastNow = Number(expApprovalBefore.body.approval.expiresAt) + 1000;
  const expired = store.expireApproval({ approvalId: expApprovalId, now: pastNow });
  const C2 = await decide({ approvalId: expApprovalId, decision: DECISION.DECISION.APPROVE, idempotencyKey: K('exp-decide') });
  const expApproval = await get('/economy/approval?approvalId=' + expApprovalId);
  const expIntent = await get('/economy/intent?agentIntentId=' + Cp.body.result.intentId);
  failResults.push({
    name: 'C · Approval expire',
    ok: expired.ok === true && expApproval.body.approval.status === C.APPROVAL_STATE.EXPIRED &&
      C2.status !== 200 && C2.body.ok !== true &&
      C2.body.purchaseCreatedNow !== true &&
      expIntent.body.intent.purchaseId === null,
    detail: { expiredOk: expired.ok, errors: expired.errors,
      approval: expApproval.body.approval && expApproval.body.approval.status,
      decideStatus: C2.status, decideCode: C2.body.reasonCode,
      intentPurchaseId: expIntent.body.intent.purchaseId }
  });

  /* ── D · Quote expire ─────────────────────────────────────────── */
  const idD = CHANNEL.createCommandIdentity(K('qexp'));
  const Dp = await propose({
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE, commandId: idD.commandId, idempotencyKey: idD.idempotencyKey,
    proposal: { agentId: REJECT_OWNER, productId: PRODUCT_ID, units: 3, reason: 'quote will expire' }
  });
  const quoteIdD = Dp.body.result.quoteId;
  /* ★ 报价的 `expires_at` 是 canonical 的时间事实，而到期是**时间**事实：
     这里把 `now` 放在任何可能的报价寿命之后（+3 天），而不是去猜它
     究竟多长。过期由 store 的 `expireQuote` 在 canonical 行上落定。 */
  const quoteExpired = store.expireQuote({ quoteId: quoteIdD, now: Date.now() + 3 * 86400000 });
  const D2 = await decide({ approvalId: Dp.body.result.approvalId, decision: DECISION.DECISION.APPROVE, idempotencyKey: K('qexp-decide') });
  const quoteAfterD = await get('/economy/quote?quoteId=' + quoteIdD);
  const intentAfterD = await get('/economy/intent?agentIntentId=' + Dp.body.result.intentId);
  failResults.push({
    name: 'D · Quote expire',
    ok: quoteExpired.ok === true &&
      quoteAfterD.status === 200 && quoteAfterD.body.quote.state === C.QUOTE_STATE.EXPIRED &&
      C.PURCHASE_INTENT_BYPASSES_QUOTE_EXPIRY === false &&
      intentAfterD.body.intent.purchaseId === null &&
      D2.body.purchaseCreated !== true,
    detail: { quoteExpiredOk: quoteExpired.ok, errors: quoteExpired.errors,
      quoteState: quoteAfterD.body.quote && quoteAfterD.body.quote.state,
      purchaseCreated: D2.body.purchaseCreated,
      continuationOk: D2.body.continuationOk, continuationReason: D2.body.continuationReasonCode,
      intentPurchaseId: intentAfterD.body.intent.purchaseId }
  });

  /* ── E · duplicate request ────────────────────────────────────── */
  const dupWorldBefore = await worldSnapshot(AGENT);
  const idE = CHANNEL.createCommandIdentity(K('dup'));
  const Env = {
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE, commandId: idE.commandId, idempotencyKey: idE.idempotencyKey,
    proposal: { agentId: REJECT_OWNER, productId: PRODUCT_ID, units: 4, reason: 'duplicate' }
  };
  const E1 = await propose(Env);
  const E2 = await propose(Env);
  await decide({ approvalId: E1.body.result.approvalId, decision: DECISION.DECISION.APPROVE, idempotencyKey: K('dup-decide') });
  const E3 = await propose(Env);
  /* ★ 这一条测的是**三层身份叠在一起**时的结果：producer 同一份输出发两次
     （通道重放）、批准一次、然后再发一次（此时 intent 已经 COMPLETED）。
     世界增量必须恰好是 1 笔购买 —— 不是"≤ 2"，也不是"渠道说自己重放了
     所以一定没买"：增量才是事实。 */
  const dupWorldAfter = await worldSnapshot(AGENT);
  const dupPurchases = dupWorldAfter.purchaseCount - dupWorldBefore.purchaseCount;
  failResults.push({
    name: 'E · duplicate request',
    ok: E1.status === 200 && E2.status === 200 && E3.status === 200 &&
      E2.body.result.intentId === E1.body.result.intentId &&
      E2.body.result.purchaseCreated !== true &&
      E3.body.result.intentId === E1.body.result.intentId &&
      E2.body.channelReplay === true &&
      dupPurchases === 1,
    detail: { sameIntent: E2.body.result.intentId === E1.body.result.intentId,
      sameIntentAfterCompletion: E3.body.result.intentId === E1.body.result.intentId,
      replayPurchaseCreated: E2.body.result.purchaseCreated,
      delta: dupPurchases, channelReplay: E2.body.channelReplay }
  });

  /* ── F · malformed authority injection ───────────────────────── */
  const failWorldBeforeF = await worldSnapshot(AGENT);
  const idF = CHANNEL.createCommandIdentity(K('inj'));
  const inject = await propose({
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE, commandId: idF.commandId, idempotencyKey: idF.idempotencyKey,
    proposal: { agentId: REJECT_OWNER, productId: PRODUCT_ID, units: 5, reason: 'inject' },
    consumerId: 'active_agent_runtime', capability: 'PROPOSE_PURCHASE', approved: true, autoAllow: true,
    amountMinor: '1', currency: 'USD', price: '0', budget: '999999', walletId: 'w', approval: 'ok'
  });
  const badDecision = await decide({
    approvalId: E1.body.result.approvalId, decision: 'AUTO_ALLOW', idempotencyKey: K('inj-decide'),
    amountMinor: '0', currency: 'CNY', approved: true
  });
  const badConfig = await configure({
    command: 'BUY', config: { ownerId: REJECT_OWNER, productId: PRODUCT_ID, amountMinor: 1 },
    idempotencyKey: K('inj-config'), approved: true, consumerId: 'active_agent_runtime'
  });
  const failWorldAfterF = await worldSnapshot(AGENT);
  failResults.push({
    name: 'F · malformed authority injection',
    ok: inject.status !== 200 && inject.body.ok !== true &&
      badDecision.status !== 200 && badDecision.body.ok !== true &&
      badConfig.status !== 200 && badConfig.body.ok !== true &&
      J(failWorldBeforeF) === J(failWorldAfterF),
    detail: { inject: { status: inject.status, code: inject.body.reasonCode || inject.body.error },
      decision: { status: badDecision.status, code: badDecision.body.reasonCode },
      config: { status: badConfig.status, code: badConfig.body.reasonCode },
      worldUnchanged: J(failWorldBeforeF) === J(failWorldAfterF) }
  });

  const failAfter = await failWorld();
  for (const r of failResults) {
    check('F-' + r.name + ' ★★★★★ fail closed：没有未经授权的账本 / 库存变更，而且终态解释了失败',
      r.ok, r.detail);
  }
  /* ★ 精确的联合结论：六条里**恰好一条**（E · duplicate request）产生了一笔
     购买 —— 它本来就是用来证明"重复请求只买一次"的那一条。其余五条一条
     都不能多出来。开发期实测：写宽上界（<= before + 2）会让"预算拒绝
     其实也偷偷买了一笔"这种情况**照样变绿**。 */
  check('F-SUMMARY ★★★★★ 六条失败金路径**联合**结论：账本与库存的增量恰好等于那一条允许成功的购买，没有第二条越权事实',
    failAfter.purchases === failBefore.purchases + 1 &&
    failAfter.inventoryRows === failBefore.inventoryRows + 1 &&
    failResults.every(r => r.ok),
    { before: failBefore, after: failAfter, results: failResults.map(r => ({ name: r.name, ok: r.ok })) });

  /* ══════════════════════════════════════════════════════════════════
     收尾
     ══════════════════════════════════════════════════════════════════ */
  await shutdown(instance);

  console.log('\n' + '═'.repeat(66));
  console.log('P22-21 · golden path：' + (checks - failures) + ' / ' + checks + ' 通过'
    + (failures ? ' · ' + failures + ' 条红' : ''));
  console.log('记录到的真实调用边：' + EDGES.length + ' 条 · 涉及生产文件 '
    + Array.from(new Set(EDGES.map(e => e.from.file))).length + ' 个');
  /* ★ 句柄已经关掉了，现在才删得掉（见 cleanupTempDirs 的说明）。 */
  console.log('临时目录：残留 ' + cleanupTempDirs() + ' 个（目标 0）');
  process.exitCode = failures ? 1 : 0;
  /* ★ 显式退出：本测试持有真实的 server / SQLite 句柄，而一个**尚未关闭**的
     socket 会让事件循环永远活着。这不是"多加一行"，而是资源纪律的一部分：
     一条中途崩溃的测试也必须**退出**（开发期实测：崩溃之后进程挂住，
     于是 `process.exitCode` 根本没机会被读到）。 */
  process.exit(failures ? 1 : 0);
})().catch(error => {
  console.error('P22-21 golden path 崩溃：' + (error && error.stack || error));
  /* 崩溃路径也必须把真实句柄关掉，否则进程不会退出 —— 而且要在关掉之后
     才删临时目录。 */
  for (const inst of closables) {
    try { inst.close(); } catch (_) { try { inst.economyStore.close(); } catch (_) { } }
    try { inst.server.close(); } catch (_) { }
  }
  console.log('临时目录：残留 ' + cleanupTempDirs() + ' 个（目标 0）');
  process.exitCode = 1;
  process.exit(1);
});











