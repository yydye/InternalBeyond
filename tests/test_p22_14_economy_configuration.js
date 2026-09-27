'use strict';
/* ====================================================================
   P22-14 · Economy Configuration Seam（单进程 · 无 HTTP · 无子进程）
   --------------------------------------------------------------------
   运行：node tests/test_p22_14_economy_configuration.js

   ── 这个文件证明什么（以及刻意不证明什么）────────────────────────────
   它证明**配置面本身**的性质：封闭三命令、信封白名单、身份不自报、
   未知命令 fail closed、与 P22-13 的决定面**分权**、以及"它到 store 的边
   恰好三条具名成员"。
   §9 的端到端 fresh-install closure（真实 HTTP + 真实 SQLite + 既有购买链）
   在 tests/test_p22_14_economy_bootstrap_runtime.js 里 —— 两份文件分工与
   P22-13 的两份逐字同款。

   ── 资源纪律（§14）────────────────────────────────────────────────────
   max concurrent child = 0 · total spawn = 0 · leftover child = 0。
   本文件连一个 socket 都不开：它用真实的 store（真实 SQLite，临时 dataDir）
   与真实的 seam，但**不经过 HTTP** —— HTTP 那一半在 runtime 文件里。
   ==================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const createStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const createSeam = require(path.join(ROOT, 'services', 'home-node', 'economy-configuration.js'));
const SERVICE = require(path.join(ROOT, 'services', 'home-node-service.js'));

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + J(extra) : ''));
  return false;
}
function section(title) { console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 62 - title.length))); }
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, ''); }
/* 与既有 P22 测试同款的"剥注释与字符串"扫描器：被禁止的是**引用**（一个真实
   的标识符），不是解释。 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (two === '/*') { i += 2; while (i < src.length && src.slice(i, i + 2) !== '*/') i += 1; i += 2; continue; }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
const tempDirs = [];
const closables = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-14-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
let keySeq = 0;
function K(prefix) { keySeq += 1; return (prefix || 'k') + '-14-' + keySeq; }
/* ★ 两个**不同**的键命名空间：seam 层（send/探针）与 store 层（G 组直接调用）
   各自编号。共用一串序号会让 G 组的键跟着 D 组一起往前跑，于是"同一个 owner
   的第一次 bootstrap"在第二次运行里撞上一条已经存在的幂等行 —— 那是一次
   真的、会被误读成产品缺陷的测试自伤。
   ★ 第二个参数是**调用点编号**（批量改写逐点生成的稳定序号）：每一个 bootstrap
   调用点得到互不相同的键，而"同一次请求重放"由显式复用键来表达（见 g5 / h2）。 */
function SK(prefix, n) { return 'store-' + (prefix || 'k') + '-14-' + n; }

const CUR = 'IB_CREDIT';
const AGENT = 'p14_agent';
const TOKEN = 'p14-desktop-token';
const CONFIG_PATH = createSeam.CONFIGURATION_PATH;
const DECISION_PATH = '/internal/economy/approval-decision';
const SEAM_REL = 'services/home-node/economy-configuration.js';
const HTTP_REL = 'services/home-node/http.js';
const STORE_REL = 'services/home-node/economy-store.js';

console.log('P22-14 · Economy Configuration Seam');

/* ══ 真实的隔离 store（真实 SQLite，一次性 dataDir）══════════════════ */
const dataDir = tmpDir('store');
const registry = require(path.join(ROOT, 'services', 'home-node', 'device-registry.js'))({
  dataDir: tmpDir('registry'), logger: () => {}
});
registry.open();
const store = createStore({
  dataDir: dataDir,
  ownerExists: party => (party && party.type === 'character'
    ? (() => { try { return !!registry.getCharacter(String(party.id)); } catch (_) { return false; } })()
    : true),
  logger: () => {}
});
store.open();
closables.push({ close: () => { try { store.close(); } catch (_) { } try { registry.close(); } catch (_) { } } });
registry.putCharacter(AGENT, { id: AGENT, nickname: 'P14 Agent' }, null);

/* ══════════════════════════════════════════════════════════════════════
   A · 公开面与"它到 store 的边恰好三条"
   ══════════════════════════════════════════════════════════════════════ */
section('A · 公开面（§1 不新造框架 / §7 封闭词表）');

const seamSrc = read(SEAM_REL);
const seamCode = stripCommentsAndStrings(seamSrc);
const httpCode = stripCommentsAndStrings(read(HTTP_REL));
const storeSrc = read(STORE_REL);

check('A1 ★ 路径恰好一条，而且**不在** /economy/ 前缀下（"POST /economy/* 一律 405"仍然逐字为真）',
  CONFIG_PATH === '/internal/economy/configuration' &&
  CONFIG_PATH.indexOf('/economy/') !== 0 &&
  seamSrc.indexOf("'/internal/economy/configuration'") >= 0,
  CONFIG_PATH);

check('A2 ★ 它是**第五**个 Economy 生产文件，而且只有装配层 require 它',
  fs.existsSync(path.join(ROOT, SEAM_REL)) &&
  (SERVICE.economyAssembly.toString().indexOf('economyConfigurationModule(') >= 0) &&
  /* 全仓库只有两处 require 它：装配层一次、测试若干次。 */
  (() => {
    const files = ['services/home-node-service.js', 'services/home-node/http.js',
      'services/home-node/economy-store.js', 'services/home-node/economy-contract.js',
      'services/home-node/economy-capability.js', 'services/home-node/economy-action-adapter.js',
      'services/home-node/economy-command-channel.js', 'services/home-node/economy-approval-decision.js'];
    return files.filter(rel => read(rel).indexOf('economy-configuration.js') >= 0).join(',') ===
      'services/home-node-service.js';
  })());

check('A3 ★ 实例的公开面**没有** store / 门 / 适配器，也没有通用分派',
  (() => {
    const shaped = createSeam({ store: null, desktopCredential: '' });
    const keys = Object.keys(shaped).sort();
    return keys.join(',') === ['COMMAND', 'COMMAND_LIST', 'CONFIG_KEYS', 'ENVELOPE_KEYS',
      'FORBIDDEN_IDENTITY_KEYS', 'REFUSAL', 'audit', 'describe', 'dispatch', 'path'].sort().join(',') &&
      shaped.store === undefined && shaped.gate === undefined &&
      shaped.adapter === undefined && shaped.execute === undefined &&
      shaped.run === undefined && shaped.invoke === undefined;
  })(),
  Object.keys(createSeam({ store: null, desktopCredential: '' })));

check('A4 ★★ 命令词表**恰好三个**，而且是那个封闭集合（§7 逐字）',
  createSeam.COMMAND_LIST.length === 3 &&
  createSeam.COMMAND_LIST.join(',') ===
  ['BOOTSTRAP_CREDIT', 'PUT_BUDGET_POLICY', 'PUT_AUTONOMY_POLICY'].join(','),
  createSeam.COMMAND_LIST);

check('A5 ★★ 被禁止的命令词在这份词表里**不存在**（不是"被过滤"）',
  ['BUY', 'SETTLE', 'RESERVE', 'GRANT_INVENTORY', 'APPROVE', 'REJECT', 'REFUND',
    'EXCHANGE', 'PROVIDER_TOPUP', 'REAL_PAYMENT', 'RAW_LEDGER_WRITE', 'MINT',
    'OPEN_WALLET', 'TRANSFER', 'TOPUP', 'GRANT'].every(w =>
      createSeam.COMMAND_LIST.indexOf(w) < 0) &&
  Object.keys(createSeam.COMMAND).length === 3,
  Object.keys(createSeam.COMMAND));

check('A6 ★★ 对 store 的访问是**三条具名成员**，一处不多：没有 `store[…]`、没有 execute/handler 分派',
  (seamCode.match(/store\.bootstrapInitialCredit\s*\(/g) || []).length === 1 &&
  (seamCode.match(/store\.putBudgetPolicy\s*\(/g) || []).length === 1 &&
  (seamCode.match(/store\.putAutonomyPolicy\s*\(/g) || []).length === 1 &&
  !/store\s*\[/.test(seamCode) &&
  seamCode.indexOf('executeEconomyAdminAction') < 0 &&
  seamCode.indexOf('handler[') < 0 &&
  !/\bhandler\s*\[/.test(seamCode) &&
  !/\bstore\s*\[/.test(seamCode),
  { computed: /store\s*\[/.test(seamCode) });

check('A7 ★★ 这个文件里**不存在**任何其它 store 写动词（作为标识符）',
  ['mintForSystem', 'burnForSystem', 'commitLedgerTransaction', 'openWallet',
    'transferBetweenWallets', 'reserveFunds', 'commitReservation', 'releaseReservation',
    'settlePurchase', 'preparePurchase', 'cancelPurchase', 'mutateInventory',
    'grantInventory', 'consumeInventory', 'createQuote', 'createProductQuote',
    'putStore', 'putProduct', 'decideApproval', 'createApprovalRequest',
    'authorizePurchaseIntent', 'proposeAgentPurchaseIntent', 'resumeAgentPurchaseIntent',
    'resumeApprovedPurchase'].every(v => !new RegExp('\\b' + v + '\\b').test(seamCode) || (() => {
      /* ★ `openWallet` 在**注释**里出现过（解释"初始额度会顺带建钱包"），
         而注释已经被剥掉；这里只对代码判。 */
      return false;
    })()),
  ['mintForSystem', 'burnForSystem', 'commitLedgerTransaction', 'openWallet',
    'transferBetweenWallets', 'reserveFunds', 'settlePurchase', 'mutateInventory',
    'grantInventory', 'decideApproval', 'resumeApprovedPurchase']
    .filter(v => new RegExp('\\b' + v + '\\b').test(seamCode)));

check('A8 ★★ §13 依赖闭包：这个文件只 require 契约与 node:crypto（不 require 任何支付/provider/凭据面）',
  (() => {
    const specs = (seamSrc.match(/require\((['"])([^'"]+)\1\)/g) || [])
      .map(s => s.replace(/require\((['"])([^'"]+)\1\)/, '$2'));
    return specs.length === 2 &&
      specs.indexOf('node:crypto') >= 0 &&
      specs.indexOf('./economy-contract.js') >= 0;
  })(),
  (seamSrc.match(/require\((['"])([^'"]+)\1\)/g) || []));

check('A9 ★★ §13 硬边界：配置面与它的依赖闭包里不存在 provider 计费 / quota / 支付 / 收银台 / 银行 / 真实货币写动词',
  (() => {
    const forbidden = ['credential-vault', 'character_runtime_specs', 'providerBilling',
      'topUpProvider', 'purchaseProviderCredits', 'updateProviderBalance', 'providerQuota',
      'pay-gate', 'alipay', 'paymentProvider', 'checkout', 'cashierUrl', 'paymentLink',
      'paymentIntent', 'bankAccount', 'cardNumber', 'realCurrency', 'exchangeRate'];
    return forbidden.every(v => seamCode.indexOf(v) < 0);
  })(),
  ['credential-vault', 'character_runtime_specs', 'providerBilling', 'providerQuota',
    'pay-gate', 'alipay', 'checkout', 'cashierUrl', 'paymentIntent', 'realCurrency']
    .filter(v => seamCode.indexOf(v) >= 0));

/* ══════════════════════════════════════════════════════════════════════
   B · 装配与 fail closed
   ══════════════════════════════════════════════════════════════════════ */
section('B · 装配与 fail closed（未配置凭据 ⇒ 整面关闭）');

check('B1 ★ buildHomeNode 的返回值里有这条 seam，而且它与 store / 门 / 决定面是同一次装配的实例',
  (() => {
    const built = SERVICE.buildHomeNode({ dataDir: tmpDir('build'), host: '127.0.0.1', port: 0, token: TOKEN, logger: () => {} });
    closables.push(built);
    return built.economyConfiguration != null &&
      built.economyStore != null && built.economyCapabilityGate != null &&
      built.economyApprovalDecision != null &&
      typeof built.economyConfiguration.dispatch === 'function' &&
      built.economyConfiguration.path === CONFIG_PATH;
  })());

check('B2 ★ 进程级装配（生产启动路径）也有它 —— 这一域被"装配好了但没接线"咬过三次',
  SERVICE.economyConfiguration != null &&
  typeof SERVICE.economyConfiguration.dispatch === 'function' &&
  SERVICE.economyConfiguration.path === CONFIG_PATH,
  Object.keys(SERVICE).filter(k => /economy/i.test(k)));

check('B3 ★★ 同一个 store 对象上**不存在**第四个成员被交给 seam（describe 自述键表，与真实注入一致）',
  (() => {
    const built = SERVICE.buildHomeNode({ dataDir: tmpDir('view'), host: '127.0.0.1', port: 0, token: TOKEN, logger: () => {} });
    closables.push(built);
    const d = built.economyConfiguration.describe();
    /* ★ 装配层那一行注入的键表（写死）与 describe 的自述必须逐字一致。 */
    const assembly = SERVICE.economyAssembly.toString();
    return d.storeViewKeys.join(',') === 'bootstrapInitialCredit,putBudgetPolicy,putAutonomyPolicy' &&
      d.storeViewKeyCount === 3 &&
      assembly.indexOf('bootstrapInitialCredit: economyStore.bootstrapInitialCredit') >= 0 &&
      assembly.indexOf('putBudgetPolicy: economyStore.putBudgetPolicy') >= 0 &&
      assembly.indexOf('putAutonomyPolicy: economyStore.putAutonomyPolicy') >= 0 &&
      assembly.indexOf('mintForSystem:') < 0 &&
      assembly.indexOf('openWallet:') < 0;
  })());

check('B4 ★★ 未配置桌面凭据 ⇒ 整面 503，而且**一个 store 调用都没有发生**（fail closed）',
  (() => {
    let reached = 0;
    const probe = {
      bootstrapInitialCredit: () => { reached += 1; return { ok: true }; },
      putBudgetPolicy: () => { reached += 1; return { ok: true }; },
      putAutonomyPolicy: () => { reached += 1; return { ok: true }; }
    };
    const closed = createSeam({ store: probe, desktopCredential: '' });
    const out = closed.dispatch({ loopback: true, desktopCredential: 'anything' },
      { command: 'BOOTSTRAP_CREDIT', config: { ownerId: AGENT, currency: CUR, amountMinor: 1 }, idempotencyKey: 'k' });
    return out.status === 503 &&
      out.reasonCode === createSeam.REFUSAL.CREDENTIAL_NOT_CONFIGURED &&
      out.reachedStore === false && reached === 0 &&
      closed.describe().open === false &&
      closed.describe().openRequires.desktopCredentialConfigured === false;
  })());

check('B5 ★★ 三个 store 入口缺任何一个 ⇒ 也是关的（"半个配置面"不允许存在）',
  (() => {
    const only = createSeam({
      store: { bootstrapInitialCredit: () => ({ ok: true }) },
      desktopCredential: TOKEN
    });
    return only.describe().open === false &&
      only.describe().openRequires.storeCanPutBudgetPolicy === false &&
      only.describe().openRequires.storeCanPutAutonomyPolicy === false &&
      only.dispatch({ loopback: true, desktopCredential: TOKEN }, {}).status === 503;
  })());

/* ══════════════════════════════════════════════════════════════════════
   C · 信封与身份（身份不自报 · 未知命令 fail closed）
   ══════════════════════════════════════════════════════════════════════ */
section('C · 信封与身份（§6 / §7）');

/* ★ 这一组用一个**计数探针** store：它让我们证明"被拒的请求一次都没碰过 store"。
   探针的每个入口都返回一个合法形状，因此任何"其实走通了"的情况都会在
   reached 上留下痕迹。 */
let reached = 0;
const probeStore = {
  bootstrapInitialCredit: () => { reached += 1; return { ok: true, replayed: false, walletId: 'w', transactionId: 't', amountMinor: '1' }; },
  putBudgetPolicy: () => { reached += 1; return { ok: true, result: { policyId: 'p', revision: 1 } }; },
  putAutonomyPolicy: () => { reached += 1; return { ok: true, result: { policyId: 'p', revision: 1 } }; }
};
const seam = createSeam({ store: probeStore, desktopCredential: TOKEN });
const INFO = { loopback: true, desktopCredential: TOKEN };
/* ★ 本阶段要求里逐字点名的身份键（§6）。它们必须**全部**在拒绝名单里 ——
   这一条是"名单漏了一个"的唯一防线。 */
const CH_KEYS = ['actor', 'caller', 'consumer', 'consumerId', 'capability', 'role',
  'authority', 'admin', 'system', 'systemInitiated', 'approved', 'party',
  'decidedBy', 'userId', 'agentId'];
function send(body, info) { const before = reached; const out = seam.dispatch(info || INFO, body); return { out: out, reachedStore: reached > before }; }
const OK_CONFIG = { ownerId: AGENT, currency: CUR, amountMinor: 1000 };

check('C1 ★ 一条合法请求真的到达 store（否则下面所有"没到达"的断言都没有意义）',
  (() => {
    const r = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('c1') });
    return r.out.ok === true && r.reachedStore === true && r.out.reachedStore === true;
  })());

check('C2 ★★ 信封印封恰好三个键：多一个键即拒，且**没碰 store**',
  (() => {
    const r = send({ command: 'PUT_BUDGET_POLICY', config: { ownerId: AGENT, currency: CUR, limits: {} }, idempotencyKey: K('c2'), amountMinor: 5 });
    return r.out.status === 400 &&
      r.out.reasonCode === createSeam.REFUSAL.UNEXPECTED_ENVELOPE_KEYS &&
      r.out.rejectedEnvelopeKeys.length === 1 && r.out.rejectedEnvelopeKeys[0] === 'amountMinor' &&
      r.reachedStore === false && r.out.reachedStore === false;
  })());

check('C3 ★★ §6 身份自报：每一个身份键都被逐名拒绝，而且**没碰 store**',
  (() => {
    const keys = createSeam.FORBIDDEN_IDENTITY_KEYS.slice();
    const results = keys.map(key => {
      const body = { command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('c3') };
      body[key] = 'whatever';
      const r = send(body);
      return {
        key: key, status: r.out.status, reachedStore: r.reachedStore,
        reasonCode: r.out.reasonCode
      };
    });
    return keys.length === 21 &&
      CH_KEYS.every(k => keys.indexOf(k) >= 0) &&
      results.every(r => r.status === 403 &&
        r.reasonCode === createSeam.REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT &&
        r.reachedStore === false);
  })(),
  createSeam.FORBIDDEN_IDENTITY_KEYS);

check('C4 ★★ 同样的身份键放进 **config** 里也被拒（信封与配置两个层面都收）',
  (() => {
    const r = send({
      command: 'BOOTSTRAP_CREDIT',
      config: Object.assign({}, OK_CONFIG, { systemInitiated: true }),
      idempotencyKey: K('c4')
    });
    return r.out.status === 400 &&
      r.out.reasonCode === createSeam.REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT &&
      r.reachedStore === false;
  })());

check('C5 ★★ 未知命令 fail closed（404 + UNKNOWN_COMMAND），而且被禁的那些词一个都不认',
  (() => {
    const words = ['BUY', 'SETTLE', 'RESERVE', 'GRANT_INVENTORY', 'APPROVE', 'REJECT',
      'REFUND', 'EXCHANGE', 'PROVIDER_TOPUP', 'REAL_PAYMENT', 'RAW_LEDGER_WRITE',
      'MINT', 'OPEN_WALLET', 'TRANSFER', 'nonsense'];
    const results = words.map(w => {
      const r = send({ command: w, config: OK_CONFIG, idempotencyKey: K('c5') });
      return { word: w, status: r.out.status, reasonCode: r.out.reasonCode, reachedStore: r.reachedStore };
    });
    return results.every(r => r.status === 404 &&
      r.reasonCode === createSeam.REFUSAL.UNKNOWN_COMMAND && r.reachedStore === false);
  })());

check('C6 ★ 缺命令 / 缺 config / 缺 ownerId / 缺幂等键各自有自己的拒绝码，且都没碰 store',
  (() => {
    const missingCommand = send({ config: OK_CONFIG, idempotencyKey: K('c6') });
    const unknownConfig = send({ command: 'PUT_BUDGET_POLICY', config: OK_CONFIG, idempotencyKey: K('c6') });
    const noOwner = send({ command: 'BOOTSTRAP_CREDIT', config: { currency: CUR, amountMinor: 1 }, idempotencyKey: K('c6') });
    const noKey = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG });
    return missingCommand.out.reasonCode === createSeam.REFUSAL.MISSING_COMMAND &&
      unknownConfig.out.reasonCode === createSeam.REFUSAL.UNEXPECTED_CONFIG_KEYS &&
      unknownConfig.out.rejectedConfigKeys.indexOf('amountMinor') >= 0 &&
      noOwner.out.reasonCode === createSeam.REFUSAL.MISSING_OWNER_ID &&
      noKey.out.reasonCode === createSeam.REFUSAL.MISSING_IDEMPOTENCY_KEY &&
      [missingCommand, unknownConfig, noOwner, noKey].every(r => r.reachedStore === false);
  })());

check('C7 ★ 非 loopback / 无凭据 / 错凭据三层分别拒绝，且都没碰 store',
  (() => {
    const notLoopback = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('c7') },
      { loopback: false, desktopCredential: TOKEN });
    const noCred = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('c7') },
      { loopback: true, desktopCredential: '' });
    const wrongCred = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('c7') },
      { loopback: true, desktopCredential: 'not-the-token' });
    return notLoopback.out.status === 401 && notLoopback.out.reasonCode === createSeam.REFUSAL.NOT_LOOPBACK &&
      noCred.out.status === 403 && noCred.out.reasonCode === createSeam.REFUSAL.MISSING_CONFIGURATION_CREDENTIAL &&
      wrongCred.out.status === 403 && wrongCred.out.reasonCode === createSeam.REFUSAL.WRONG_CONFIGURATION_CREDENTIAL &&
      [notLoopback, noCred, wrongCred].every(r => r.reachedStore === false);
  })());

check('C8 ★★ §12 Agent 的来源凭据换不到配置权威：这条路径根本不读来源凭据头',
  (() => {
    /* ★ "Agent credential cannot use the configuration seam" 的**结构性**形态：
       请求信息里根本没有那个字段可填。写进 requestInfo 的额外键不会被读，
       而我们显式证明"拿了来源凭据仍然是 403/401"。 */
    const asAgent = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('c8') },
      { loopback: true, desktopCredential: '', sourceCredential: 'p22-11-source-token', sourcePort: 24941 });
    const wrongAgentCred = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('c8') },
      { loopback: true, desktopCredential: 'p22-11-source-token' });
    return asAgent.out.status === 403 && asAgent.reachedStore === false &&
      wrongAgentCred.out.status === 403 &&
      wrongAgentCred.out.reasonCode === createSeam.REFUSAL.WRONG_CONFIGURATION_CREDENTIAL &&
      wrongAgentCred.reachedStore === false &&
      seamCode.indexOf('sourceCredential') < 0 &&
      seamCode.indexOf('IB_ECONOMY_CHANNEL_TOKEN') < 0;
  })());

check('C9 ★ 同一个幂等键先 BOOTSTRAP_CREDIT 再 PUT_BUDGET_POLICY ⇒ 409 冲突，且在触碰 store 之前',
  (() => {
    const key = K('c9');
    const first = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: key });
    const second = send({ command: 'PUT_BUDGET_POLICY', config: { ownerId: AGENT, currency: CUR, limits: {} }, idempotencyKey: key });
    return first.out.ok === true && second.out.status === 409 &&
      second.out.reasonCode === createSeam.REFUSAL.REQUEST_ID_CONFLICT &&
      second.out.previouslyUsedFor === 'BOOTSTRAP_CREDIT' &&
      second.reachedStore === false;
  })());

check('C10 ★ 命令词折大小写（一次显式、封闭的映射），别的什么都不折',
  (() => {
    const lower = send({ command: 'bootstrap_credit', config: OK_CONFIG, idempotencyKey: K('c10') });
    const mixed = send({ command: 'Put_Budget_Policy', config: { ownerId: AGENT, currency: CUR, limits: {} }, idempotencyKey: K('c10') });
    return lower.out.ok === true && lower.out.command === 'BOOTSTRAP_CREDIT' &&
      mixed.out.ok === true && mixed.out.command === 'PUT_BUDGET_POLICY';
  })());

check('C11 ★ 非对象 body ⇒ MALFORMED_ENVELOPE（读不出 body 的 HTTP 分支也走这里）',
  (() => {
    const bad = send(null);
    return bad.out.status === 400 && bad.out.reasonCode === createSeam.REFUSAL.MALFORMED_ENVELOPE &&
      bad.reachedStore === false;
  })());

/* ══════════════════════════════════════════════════════════════════════
   D · 三个命令各自到达**那一件** store 事，且只到那一件
   ══════════════════════════════════════════════════════════════════════ */
section('D · 封闭映射：每一个命令恰好一支 runner');

check('D1 ★★ 三个命令各自只调用它自己那一个 store 入口（探针逐名计数）',
  (() => {
    const calls = { bootstrap: 0, budget: 0, autonomy: 0 };
    const counting = {
      bootstrapInitialCredit: () => { calls.bootstrap += 1; return { ok: true, replayed: false, walletId: 'w', transactionId: 't', amountMinor: '1' }; },
      putBudgetPolicy: () => { calls.budget += 1; return { ok: true, result: { policyId: 'p', revision: 1 } }; },
      putAutonomyPolicy: () => { calls.autonomy += 1; return { ok: true, result: { policyId: 'p', revision: 1 } }; }
    };
    const s = createSeam({ store: counting, desktopCredential: TOKEN });
    s.dispatch(INFO, { command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('d1') });
    const afterBootstrap = { bootstrap: calls.bootstrap, budget: calls.budget, autonomy: calls.autonomy };
    s.dispatch(INFO, { command: 'PUT_BUDGET_POLICY', config: { ownerId: AGENT, currency: CUR, limits: {} }, idempotencyKey: K('d1') });
    const afterBudget = { bootstrap: calls.bootstrap, budget: calls.budget, autonomy: calls.autonomy };
    s.dispatch(INFO, { command: 'PUT_AUTONOMY_POLICY', config: { ownerId: AGENT, enabled: true }, idempotencyKey: K('d1') });
    return afterBootstrap.bootstrap === 1 && afterBootstrap.budget === 0 && afterBootstrap.autonomy === 0 &&
      afterBudget.budget === 1 && afterBudget.autonomy === 0 && afterBudget.bootstrap === 1 &&
      calls.autonomy === 1;
  })());

check('D2 ★★ 三个命令的**自述位**：BOOTSTRAP 会铸钱、两个政策写入恒为零账本动作',
  (() => {
    const r1 = send({ command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('d2') });
    const r2 = send({ command: 'PUT_BUDGET_POLICY', config: { ownerId: AGENT, currency: CUR, limits: {} }, idempotencyKey: K('d2') });
    const r3 = send({ command: 'PUT_AUTONOMY_POLICY', config: { ownerId: AGENT, enabled: true }, idempotencyKey: K('d2') });
    return [
      ['creditMinted', r1.out.creditMinted === true],
      ['isProviderQuota', r1.out.isProviderQuota === false],
      ['isRealCurrency', r1.out.isRealCurrency === false],
      ['b2-creditMinted', r2.out.creditMinted === false],
      ['b2-ledger', r2.out.ledgerMutation === false],
      ['b2-written', r2.out.budgetPolicyWritten === true],
      ['a3-creditMinted', r3.out.creditMinted === false],
      ['a3-ledger', r3.out.ledgerMutation === false],
      ['a3-written', r3.out.autonomyPolicyWritten === true],
      ['a3-noBudget', r3.out.grantsBudget === false],
      ['a3-notDecisionLayer', r3.out.isADecisionLayer === false],
      ['no-approve', [r1, r2, r3].every(r => r.out.canApproveOrReject === false)],
      ['no-settle', [r1, r2, r3].every(r => r.out.canSettleAPurchase === false)],
      ['no-resume', [r1, r2, r3].every(r => r.out.canResumeAnIntent === false)],
      ['no-mint-exposed', [r1, r2, r3].every(r => r.out.exposesMintForSystem === false)],
      ['no-inventory', [r1, r2, r3].every(r => r.out.inventoryMutation === false)],
      ['no-purchase', [r1, r2, r3].every(r => r.out.purchaseMutation === false)],
      ['no-approval-mutation', [r1, r2, r3].every(r => r.out.approvalMutation === false)],
      ['no-provider', [r1, r2, r3].every(r => r.out.providerMutation === false)],
      ['no-payment', [r1, r2, r3].every(r => r.out.paymentMutation === false)],
      /* ★ 这三句在**每一个**返回值上 —— 成功与拒绝都有：
         "这条面能不能批准"与"这次成没成"是两个不同的问题。 */
      ['refusal-no-approve', send({ command: 'BUY', config: OK_CONFIG, idempotencyKey: K('d2') }).out.canApproveOrReject === false],
      ['refusal-no-settle', send(null).out.canSettleAPurchase === false],
      ['refusal-no-resume', send(null).out.canResumeAnIntent === false]
    ];
  })().filter(x => x[1] !== true).map(x => x[0]));

check('D3 ★★ store 拒绝被**原样透出**（下游 reasonCode 优先于本层归类），且 status 按 denied 决定',
  (() => {
    const denied = createSeam({
      store: {
        bootstrapInitialCredit: () => ({ ok: false, denied: true, reasonCode: 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED', errors: ['x'] }),
        putBudgetPolicy: () => ({ ok: true }),
        putAutonomyPolicy: () => ({ ok: true })
      },
      desktopCredential: TOKEN
    });
    const soft = createSeam({
      store: {
        bootstrapInitialCredit: () => ({ ok: false, denied: false, reasonCode: null, errors: ['owner-not-found'] }),
        putBudgetPolicy: () => ({ ok: true }),
        putAutonomyPolicy: () => ({ ok: true })
      },
      desktopCredential: TOKEN
    });
    const hard = denied.dispatch(INFO, { command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('d3') });
    const softOut = soft.dispatch(INFO, { command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: K('d3') });
    return hard.status === 409 && hard.reasonCode === 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED' &&
      hard.downstreamReasonCode === 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED' &&
      softOut.status === 400 && softOut.reasonCode === createSeam.REFUSAL.CONFIGURATION_REFUSED &&
      softOut.errors.indexOf('owner-not-found') >= 0 &&
      softOut.downstreamReasonCode === null;
  })());

check('D4 ★★ 配置面**不做经济判断**：它把坏配置原样交给 store，而不是"自动修正"成另一个策略',
  (() => {
    /* 一个明显坏的限额外形（每日 < 每笔）在探针上被原样透传 —— 本层一个字都没改。 */
    let seenLimits = null;
    let seenPerPurchase = null;
    const capturing = {
      bootstrapInitialCredit: () => ({ ok: true, replayed: false }),
      putBudgetPolicy: input => { seenLimits = input.limits; return { ok: true, result: { policyId: 'p', revision: 1 } }; },
      putAutonomyPolicy: input => { seenPerPurchase = input.perPurchaseLimitMinor; return { ok: true, result: { policyId: 'p', revision: 1 } }; }
    };
    const s = createSeam({ store: capturing, desktopCredential: TOKEN });
    const badLimits = { perTransactionMinor: 500, dailyMinor: 100, weeklyMinor: 100, monthlyMinor: 100 };
    s.dispatch(INFO, { command: 'PUT_BUDGET_POLICY', config: { ownerId: AGENT, currency: CUR, limits: badLimits }, idempotencyKey: K('d4') });
    s.dispatch(INFO, { command: 'PUT_AUTONOMY_POLICY', config: { ownerId: AGENT, enabled: true, perPurchaseLimitMinor: 9e15 }, idempotencyKey: K('d4') });
    return J(seenLimits) === J(badLimits) && seenPerPurchase === 9e15 &&
      seamCode.indexOf('perTransactionMinor') < 0 &&
      seamCode.indexOf('dailyMinor') < 0;
  })());

check('D5 ★★ §4 被禁止的**权威字段**一个都不在 config 白名单里（它们由 authority 计算）',
  (() => {
    const all = [];
    for (const w of createSeam.COMMAND_LIST) all.push.apply(all, createSeam.CONFIG_KEYS[w]);
    return ['currentBalance', 'spentToday', 'allow', 'decision', 'approval', 'price',
      'ledger', 'ledgerState', 'balance', 'reserved', 'spent', 'status']
      .every(k => all.indexOf(k) < 0) &&
      all.indexOf('ownerId') >= 0 && all.indexOf('limits') >= 0 &&
      createSeam.CONFIG_KEYS.BOOTSTRAP_CREDIT.join(',') === 'ownerId,currency,amountMinor';
  })(),
  createSeam.CONFIG_KEYS);

check('D6 ★★ BOOTSTRAP_CREDIT 的 config **没有**账户 / 交易 id / raw entry / 币种以外的输入位',
  (() => {
    const keys = createSeam.CONFIG_KEYS.BOOTSTRAP_CREDIT;
    return ['debitAccountId', 'creditAccountId', 'accountId', 'transactionId',
      'ledgerEntryId', 'entries', 'direction', 'systemInitiated', 'walletId',
      'systemAccount'].every(k => keys.indexOf(k) < 0);
  })());

/* ══════════════════════════════════════════════════════════════════════
   E · §8 与 P22-13 的分权（两条路径互不接受对方的信封）
   ══════════════════════════════════════════════════════════════════════ */
section('E · §8 决定面与配置面完全分权');

const approvalSeam = require(path.join(ROOT, 'services', 'home-node', 'economy-approval-decision.js'));

check('E1 ★★ 两条路径不同：path 不同、命令/决定词不同、而且**没有交集**',
  CONFIG_PATH !== DECISION_PATH &&
  CONFIG_PATH !== createSeam.CONFIGURATION_PATH.replace('configuration', 'command') &&
  createSeam.COMMAND_LIST.filter(c => approvalSeam.DECISION_LIST.indexOf(c) >= 0).length === 0 &&
  approvalSeam.DECISION_LIST.filter(d => createSeam.COMMAND_LIST.indexOf(d) >= 0).length === 0 &&
  createSeam.ENVELOPE_KEYS.filter(k => approvalSeam.ENVELOPE_KEYS.indexOf(k) >= 0).join(',') === 'idempotencyKey',
  { configEnvelope: createSeam.ENVELOPE_KEYS, decisionEnvelope: approvalSeam.ENVELOPE_KEYS });

check('E2 ★★ 决定面的信封送进配置面 ⇒ UNKNOWN_COMMAND（APPROVE / REJECT 不是配置命令）',
  (() => {
    const approve = send({ approvalId: 'econ_approval_x', decision: 'APPROVE', idempotencyKey: K('e2') });
    const reject = send({ approvalId: 'econ_approval_x', decision: 'REJECT', idempotencyKey: K('e2') });
    return approve.out.status === 400 && approve.reachedStore === false &&
      reject.out.status === 400 && reject.reachedStore === false &&
      approve.out.reasonCode === createSeam.REFUSAL.UNEXPECTED_ENVELOPE_KEYS;
  })());

check('E3 ★★ 配置面的信封送进决定面 ⇒ 它自己的拒绝码（两条路径各自 fail closed）',
  (() => {
    const d = approvalSeam({
      store: { decideApproval: () => ({ ok: true }) },
      resumeHandle: { resumeApprovedPurchase: () => ({ ok: true }) },
      desktopCredential: TOKEN
    });
    const out = d.dispatch({ loopback: true, desktopCredential: TOKEN },
      { command: 'BOOTSTRAP_CREDIT', config: OK_CONFIG, idempotencyKey: 'k' });
    return out.status === 400 &&
      out.reasonCode === approvalSeam.REFUSAL.UNEXPECTED_ENVELOPE_KEYS &&
      out.reachedStore === false;
  })());

check('E4 ★★ 配置面**不能**批准/拒绝：它没有那个能力、没有那个词、也没有那条到 store 的边',
  (() => {
    const d = seam.describe();
    return d.canApproveOrReject === false && d.canResumeAnIntent === false &&
      d.differsFromTheApprovalDecisionSeam.configurationCannotDecideAnApproval === true &&
      d.differsFromTheApprovalDecisionSeam.approvalDecisionCannotConfigure === true &&
      d.differsFromTheApprovalDecisionSeam.sharesACommandWithTheApprovalDecisionSeam === false &&
      d.differsFromTheApprovalDecisionSeam.sharesAnEnvelopeWithTheApprovalDecisionSeam === false &&
      seamCode.indexOf('decideApproval') < 0;
  })());

check('E5 ★★ 决定面**不能** mint / 改预算 / 改自主：它的 store 视图只有一个键',
  (() => {
    const src = read('services/home-node/economy-approval-decision.js');
    const code = stripCommentsAndStrings(src);
    return code.indexOf('putBudgetPolicy') < 0 &&
      code.indexOf('putAutonomyPolicy') < 0 &&
      code.indexOf('bootstrapInitialCredit') < 0 &&
      code.indexOf('mintForSystem') < 0 &&
      code.indexOf('store[') < 0;
  })());

/* ══════════════════════════════════════════════════════════════════════
   F · http.js：第三条写路径，读面一字未动
   ══════════════════════════════════════════════════════════════════════ */
section('F · http.js（唯一一条新路由 · /economy/* 仍然全 GET）');

check('F1 ★★ http.js 里对配置面的成员访问恰好那几处，而且带的是**注入对象**（没有第二个字面量路径）',
  (httpCode.match(/economyConfiguration\.dispatch\(/g) || []).length === 2 &&
  (httpCode.match(/economyConfiguration\.path/g) || []).length === 3 &&
  (httpCode.match(/economyConfiguration\.describe\(\)/g) || []).length === 1 &&
  httpCode.indexOf("'/internal/economy/configuration'") < 0,
  {
    dispatch: (httpCode.match(/economyConfiguration\.dispatch\(/g) || []).length,
    path: (httpCode.match(/economyConfiguration\.path/g) || []).length,
    describe: (httpCode.match(/economyConfiguration\.describe\(\)/g) || []).length
  });

check('F2 ★★ http.js 里没有任何一行能从这条路到达 store / 门 / 适配器',
  ['bootstrapInitialCredit', 'putBudgetPolicy', 'putAutonomyPolicy', 'mintForSystem',
    'openWallet', 'commitLedgerTransaction', 'settlePurchase', 'grantInventory',
    'decideApproval', 'economyCapabilityGate', 'economyActionAdapter']
    .every(n => httpCode.indexOf(n) < 0),
  ['bootstrapInitialCredit', 'putBudgetPolicy', 'putAutonomyPolicy', 'mintForSystem',
    'openWallet', 'commitLedgerTransaction', 'settlePurchase', 'grantInventory',
    'decideApproval', 'economyCapabilityGate', 'economyActionAdapter']
    .filter(n => httpCode.indexOf(n) >= 0));

check('F3 ★★ /economy/* 的路由**全部**仍是 GET（§12：普通 /economy/* write = 0）',
  (() => {
    const blocks = read(HTTP_REL).match(/path === '\/economy\/[^']*' && method === '[A-Z]+'/g) || [];
    return blocks.length > 0 && blocks.every(b => /&& method === 'GET'$/.test(b));
  })());

check('F4 ★★ 配置面的**自然路径名**一个都没有被挂成路由，而且 /security 的 unreachable 继续逐名点名写形态',
  (() => {
    const src = read(HTTP_REL);
    const forms = ['/economy/config', '/economy/configure', '/economy/config/get',
      '/economy/bootstrap', '/economy/credit', '/economy/admin',
      '/economy/initialize', '/economy/setup'];
    const routed = forms.filter(f => new RegExp("path === '" + f.replace(/\//g, '\\/') + "'").test(src));
    /* ★ unreachable 有几份（每个阶段各一份），所以这里判**全文件**：
       P22-14 的三个命令对应的写形态（topup / mint / autonomy-policy /
       settle / approve）必须仍然逐名在里面。 */
    const named = ['/economy/topup', '/economy/mint', '/economy/payment',
      '/economy/autonomy-policy', '/economy/approve', '/economy/settle'];
    /* ★ 配置面自己的路径**不在**那份名单里：它是一条真实路由，
         而"让声明比真实路由更保守"正是 P22-7 移走 /economy/approval 的理由。 */
    return routed.length === 0 &&
      named.every(p => src.indexOf("'" + p + "'") >= 0) &&
      src.indexOf("'" + CONFIG_PATH + "'") < 0;
  })());

check('F5 ★★ /security 的 economyPolicy.configuration 是"把已发生的事实写成字段"',
  (() => {
    const built = SERVICE.buildHomeNode({ dataDir: tmpDir('security'), host: '127.0.0.1', port: 0, token: TOKEN, logger: () => {} });
    closables.push(built);
    const sectionSrc = read(HTTP_REL);
    return /configuration:\s*economyConfiguration\s*\?/.test(sectionSrc) &&
      /configurationCommandsExposed:\s*open\s*\?\s*d\.commands\.slice\(\)\s*:\s*\[\]/.test(sectionSrc) &&
      /configurationWritesThatAreNotOneOfThoseThree:\s*\[\]/.test(sectionSrc) &&
      /exposesMintForSystem:\s*false/.test(sectionSrc) &&
      /initialCreditIsOneShot:\s*true/.test(sectionSrc) &&
      /configurationCannotDecideAnApproval:\s*true/.test(sectionSrc) &&
      /approvalDecisionCannotConfigure:\s*true/.test(sectionSrc);
  })());

check('F6 ★★ 未装配配置面时，/security 那一节报 implemented:false 且两个名单都是空的',
  (() => {
    const src = read(HTTP_REL);
    return /implemented:\s*false,\s*\n\s*open:\s*false,\s*\n\s*configurationCommandsExposed:\s*\[\]/.test(src) &&
      /configurationWritesThatAreNotOneOfThoseThree:\s*\[\]/.test(src);
  })());

/* ══════════════════════════════════════════════════════════════════════
   G · store 层的一次性事实（真实 SQLite）
   ══════════════════════════════════════════════════════════════════════ */
section('G · store 的 one-shot（真实 SQLite · 真实 meta 行）');

check('g1 ★★ fresh store：这个 owner 的初始额度**还没发过**（而在那之前一分钱都没有）',
  (() => {
    const before = store.getInitialCreditBootstrap({ type: 'character', id: AGENT }, CUR);
    const wallet = store.getWallet({ ownerId: AGENT, currency: CUR });
    return before.ok === true && before.bootstrapped === false &&
      /* 没有钱包：fresh install 的诚实答案是"查不到"，而不是 0。 */
      wallet.ok === false;
  })());

const BOOT_AMOUNT = 1000000;
let firstBootstrap = null;
check('g2 ★★ 第一次 bootstrap 成功，而且它建出的是一条 canonical 的 MINT 交易 + 一个钱包余额',
  (() => {
    firstBootstrap = store.bootstrapInitialCredit({
      owner: { type: 'character', id: AGENT }, currency: CUR, amountMinor: BOOT_AMOUNT,
      idempotencyKey: SK('g2', 1)
    });
    if (!firstBootstrap || firstBootstrap.ok !== true) return false;
    const tx = store.getTransaction(firstBootstrap.transactionId);
    const wallet = store.getWallet({ ownerId: AGENT, currency: CUR });
    return tx.ok === true && tx.transaction.transactionType === C.TX_TYPE.MINT &&
      tx.transaction.actor.type === C.PARTY_TYPE.SYSTEM &&
      tx.transaction.actor.id === C.SYSTEM_ACCOUNT.MINT &&
      wallet.ok === true &&
      String(wallet.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT) &&
      String(wallet.wallet.ledgerBalanceMinor) === String(BOOT_AMOUNT) &&
      C.isEconomyId('TRANSACTION', firstBootstrap.transactionId) &&
      firstBootstrap.replayed === false && firstBootstrap.bootstrapAlreadyConsumed === false;
  })(), firstBootstrap);

check('g3 ★★ 同一个 owner 用**新的** idempotencyKey 再来（即使金额相同）⇒ 拒绝，余额不翻倍',
  (() => {
    /* ★ 新幂等键代表第二次调用；只有原键重发才是网络层安全重放。 */
    const again = store.bootstrapInitialCredit({
      owner: { type: 'character', id: AGENT }, currency: CUR, amountMinor: BOOT_AMOUNT,
      idempotencyKey: SK('g3', 2)
    });
    const wallet = store.getWallet({ ownerId: AGENT, currency: CUR });
    return again.ok === false && again.denied === true &&
      again.reasonCode === 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED' &&
      again.bootstrapAlreadyConsumed === true &&
      again.transactionId === firstBootstrap.transactionId &&
      again.walletId === firstBootstrap.walletId &&
      again.alreadyBootstrappedAmountMinor === String(BOOT_AMOUNT) &&
      again.requestedAmountMinor === String(BOOT_AMOUNT) &&
      /* ★ 没有第二笔交易，余额**一分不差**。 */
      String(wallet.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT) &&
      String(wallet.wallet.ledgerBalanceMinor) === String(BOOT_AMOUNT);
  })());

check('g4 ★★ 换一个**金额**再来 ⇒ 拒绝，而且明说它是一次性的（余额一分不变）',
  (() => {
    const bigger = store.bootstrapInitialCredit({
      owner: { type: 'character', id: AGENT }, currency: CUR, amountMinor: BOOT_AMOUNT * 10,
      idempotencyKey: SK('g4', 3)
    });
    const wallet = store.getWallet({ ownerId: AGENT, currency: CUR });
    return bigger.ok === false && bigger.denied === true &&
      bigger.reasonCode === 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED' &&
      bigger.bootstrapAlreadyConsumed === true &&
      /* ★ 这两个字段必须**真的有值**（开发期实测的一个真实缺陷：
         它一度恒为 undefined，因为取值写在了 marker 的顶层而金额在里层）。 */
      bigger.alreadyBootstrappedAmountMinor === String(BOOT_AMOUNT) &&
      bigger.requestedAmountMinor === String(BOOT_AMOUNT * 10) &&
      bigger.transactionId === firstBootstrap.transactionId &&
      String(wallet.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT);
  })());

check('g5 ★★ 逐字重放（同 owner / 同币种 / 同金额）⇒ replayed:true 且**返回当初那条交易**，余额不翻倍',
  (() => {
    const replay = store.bootstrapInitialCredit({
      owner: { type: 'character', id: AGENT }, currency: CUR, amountMinor: BOOT_AMOUNT,
      idempotencyKey: SK('g2', 1)
    });
    const wallet = store.getWallet({ ownerId: AGENT, currency: CUR });
    return replay.ok === true && replay.replayed === true &&
      replay.transactionId === firstBootstrap.transactionId &&
      replay.walletId === firstBootstrap.walletId &&
      String(wallet.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT) &&
      String(wallet.wallet.ledgerBalanceMinor) === String(BOOT_AMOUNT);
  })());

check('g6 ★★ 账本上只有**一笔** MINT 交易（"无限印钱"在账本事实上不成立）',
  (() => {
    /* ★ listTransactions 返回的是一个**数组**（与 listChanges 同款），
       不是 {ok, rows} —— 一个"照着另一个 API 的形状猜"的错误。 */
    const rows = store.listTransactions({ limit: 100 });
    const mints = rows.filter(t => String(t.transactionType) === C.TX_TYPE.MINT);
    return Array.isArray(rows) && rows.length >= 1 && mints.length === 1 &&
      String(mints[0].transactionId) === String(firstBootstrap.transactionId) &&
      String(mints[0].idempotencyKey).indexOf('bootstrap-credit:') === 0;
  })());

check('g7 ★★ 一次性事实是**持久**的（读回它自己，而不是靠再试一次问）',
  (() => {
    const readBack = store.getInitialCreditBootstrap({ type: 'character', id: AGENT }, CUR);
    return readBack.ok === true && readBack.bootstrapped === true &&
      readBack.amountMinor === String(BOOT_AMOUNT) &&
      readBack.transactionId === firstBootstrap.transactionId &&
      readBack.walletId === firstBootstrap.walletId &&
      typeof readBack.at === 'number';
  })());

check('g8 ★★ 一次性是**按 owner + 币种**的，不是按 wallet：另一个 owner 照样可以有自己的初始额度',
  (() => {
    /* ★ AGENT 的初始额度已经发过 ⇒ 即使金额是 0 也被拒（"发过了"与"发了多少"
       是同一件事实）。 */
    const alreadyDone = store.bootstrapInitialCredit({
      owner: { type: 'character', id: AGENT }, currency: CUR, amountMinor: 0, idempotencyKey: SK('g8', 5)
    });
    /* ★ 第二个 owner 用**契约的 canonical 用户身份**（裸字符串 'user' 经
       partyInput 提升成 user:user）—— 而不是这里编一个角色 id：编出来的角色
       在注册表里不存在，那样测到的是"owner-not-found"，不是"另一个 owner
       也能有自己的初始额度"。 */
    const fresh = store.bootstrapInitialCredit({
      owner: C.USER_PARTY_ID, currency: CUR, amountMinor: 500, idempotencyKey: SK('g8', 6)
    });
    const freshWallet = store.getWallet({ ownerId: C.USER_PARTY_ID, currency: CUR });
    return alreadyDone.ok === false &&
      alreadyDone.reasonCode === 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED' &&
      fresh.ok === true && fresh.replayed === false &&
      fresh.result.ownerId === C.USER_PARTY_ID && fresh.result.ownerType === C.PARTY_TYPE.USER &&
      freshWallet.ok === true && String(freshWallet.wallet.cachedBalanceMinor) === '500' &&
      fresh.walletId !== firstBootstrap.walletId &&
      fresh.transactionId !== firstBootstrap.transactionId &&
      /* ★ 两个 owner 的两条一次性事实**互不影响**。 */
      store.getInitialCreditBootstrap({ type: 'character', id: AGENT }, CUR).transactionId ===
        firstBootstrap.transactionId &&
      store.getInitialCreditBootstrap({ type: 'user', id: C.USER_PARTY_ID }, CUR).bootstrapped === true;
  })());

check('g9 ★★ 系统当事人不能拥有初始额度（那条既有的"system 不能拥有钱包"闸门在 store 里先成立）',
  (() => {
    const out = store.bootstrapInitialCredit({
      owner: { type: 'system', id: C.SYSTEM_ACCOUNT.TREASURY }, currency: CUR,
      amountMinor: 1, idempotencyKey: SK('g9', 7)
    });
    return out.ok === false &&
      out.errors.indexOf('system-party-cannot-own-a-wallet') >= 0 &&
      store.getInitialCreditBootstrap({ type: 'system', id: C.SYSTEM_ACCOUNT.TREASURY }, CUR).bootstrapped !== true;
  })());

check('g10 ★★ 坏金额（负数 / 非整数 / 溢出）在 store 被拒 —— 本层不"修正"它',
  (() => {
    const negative = store.bootstrapInitialCredit({
      owner: 'p14_bad_price_agent', currency: CUR, amountMinor: -5, idempotencyKey: SK('g10', 8)
    });
    const fractional = store.bootstrapInitialCredit({
      owner: 'p14_bad_price_agent', currency: CUR, amountMinor: 1.5, idempotencyKey: SK('g10', 9)
    });
    return negative.ok === false && negative.errors.indexOf('amount-minor-negative') >= 0 &&
      fractional.ok === false &&
      store.getInitialCreditBootstrap({ type: 'character', id: 'p14_bad_price_agent' }, CUR).bootstrapped === false;
  })());

check('g11 ★★ 只允许 IB_CREDIT（另外五个**合法的** Economy 币种都不许做初始额度）',
  (() => {
    const otherCurrencies = C.CURRENCIES.filter(x => x !== CUR);
    const results = otherCurrencies.map(x => store.bootstrapInitialCredit({
      owner: 'p14_currency_agent', currency: x, amountMinor: 100, idempotencyKey: SK('g11', 10)
    }));
    const realMoney = store.bootstrapInitialCredit({
      owner: 'p14_currency_agent', currency: 'USD', amountMinor: 100, idempotencyKey: SK('g11', 11)
    });
    return C.CURRENCIES.length === 6 && otherCurrencies.length === 5 &&
      results.every(r => r.ok === false) &&
      /* ★ 真实货币在一开始就被契约逐字否认（FORBIDDEN_CURRENCY_TOKENS）。 */
      realMoney.ok === false &&
      realMoney.errors.indexOf('currency-forbidden-real-money-or-provider-balance') >= 0 &&
      /* ★ 一个都没建出钱包：被拒的输入不该留下痕迹。 */
      store.getWallet({ ownerId: 'p14_currency_agent', currency: CUR }).ok === false;
  })(), C.CURRENCIES);

check('g12 ★★ systemAuthority 关掉时铸币权**不跟着来**（初始额度不是绕开它的第三扇门）',
  (() => {
    const gated = createStore({
      dataDir: tmpDir('gated'),
      ownerExists: () => true,
      systemAuthority: () => false,
      logger: () => {}
    });
    gated.open();
    const out = gated.bootstrapInitialCredit({
      owner: 'p14_gated_agent', currency: CUR, amountMinor: 100, idempotencyKey: SK('g12', 12)
    });
    const check12 = out.ok === false && out.errors.indexOf('system-authority-unavailable') >= 0 &&
      gated.getInitialCreditBootstrap('p14_gated_agent', CUR).bootstrapped === false;
    try { gated.close(); } catch (_) { }
    return check12;
  })());

check('g13 ★★ 它是**唯一**被导出的新方法（P22-1 ~ P22-13 的既有导出逐字不变）',
  (() => {
    const src = read(STORE_REL);
    return src.indexOf('bootstrapInitialCredit: bootstrapInitialCredit') >= 0 &&
      src.indexOf('getInitialCreditBootstrap: getInitialCreditBootstrap') >= 0 &&
      src.indexOf('mintForSystem: mintForSystem') >= 0 &&
      /* ★ 初始额度**不是** mintForSystem 的别名：两者都在，而且实现不同。 */
      read(STORE_REL).indexOf('function bootstrapInitialCredit') >= 0 &&
      /function mintForSystem\(input\) \{ return systemTransfer\('MINT', input\); \}/.test(storeSrc);
  })());

check('g14 ★★ §3 结构反向断言：bootstrapInitialCredit 里**没有** raw 写、没有第二条余额写法',
  (() => {
    const start = storeSrc.indexOf('function bootstrapInitialCredit');
    const end = storeSrc.indexOf('function getInitialCreditBootstrap');
    const body = storeSrc.slice(start, end > start ? end : start + 12000);
    const code = stripCommentsAndStrings(body);
    return code.indexOf('cached_balance') < 0 &&
      code.indexOf('systemTransfer') >= 0 &&
      /* ★ 唯一的到账本的边是 systemTransfer；它自己再走 commitLedgerTransaction。
         本函数**不**直接调用它，因此"两条到账本的路"在这段代码里不成立。 */
      code.indexOf('commitLedgerTransaction') < 0 &&
      code.indexOf('debitAccountId') < 0 &&
      code.indexOf('creditAccountId') < 0 &&
      code.indexOf('ledgerEntryId') < 0 &&
      /* ★ §13：provider quota 与真实货币的**写动词**。这份名单取自契约自己的
         BOUNDARY_FORBIDDEN_IDENTIFIERS —— 不另立一份。
         ★ 这里刻意**不**判裸词 'provider' / 'payment' / 'realCurrency'：
         返回值里那三个 `providerQuotaMutation: false` 风格的键是**自述位**
         （"这次写入没有碰 provider"），它们与"配置面能触达 provider"正好相反。
         把它们一并禁掉会把一句真话判成违规 —— 断言必须落在写动词上。 */
      C.BOUNDARY_FORBIDDEN_IDENTIFIERS.every(v => code.indexOf(v) < 0) &&
      ['providerQuotaMutation', 'realCurrencyMutation'].every(v => code.indexOf(v) >= 0) &&
      /* ★ 唯一的一次 SQL 读是钱包行（拿 wallet_id），一次都不多。 */
      (code.match(/db\.prepare\(/g) || []).length === 1;
  })());

/* ══════════════════════════════════════════════════════════════════════
   H · §11 政策 **不是** 一次性（版本化更新）
   ══════════════════════════════════════════════════════════════════════ */
section('H · §11 初始额度 one-shot，而两个政策可以改很多次');

check('h1 ★★ PUT_BUDGET_POLICY 走的是 canonical putBudgetPolicy，revision 逐次累加（不是一次性）',
  (() => {
    const first = store.putBudgetPolicy({
      ownerId: AGENT, currency: CUR,
      limits: { perTransactionMinor: 5000, dailyMinor: 10000, weeklyMinor: 50000, monthlyMinor: 100000 },
      idempotencyKey: SK('h1', 13)
    });
    if (!first || first.ok !== true) return false;
    const second = store.putBudgetPolicy({
      ownerId: AGENT, currency: CUR,
      limits: { perTransactionMinor: 6000, dailyMinor: 10000, weeklyMinor: 50000, monthlyMinor: 100000 },
      idempotencyKey: SK('h1', 14)
    });
    return second.ok === true && second.result.created === false &&
      second.result.revision > first.result.revision &&
      String(store.getBudgetPolicy({ ownerId: AGENT, currency: CUR }).policy.limits.perTransactionMinor) === '6000';
  })());

check('h2 ★★ PUT_AUTONOMY_POLICY 同款：可更新、revision 累加、幂等键重放返回同一个结果',
  (() => {
    const args = {
      ownerId: AGENT, currency: CUR, enabled: true,
      perPurchaseLimitMinor: 10000, dailyAutonomousLimitMinor: 20000,
      approvalAboveMinor: 10000, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], allowGift: false,
      idempotencyKey: SK('h2', 15)
    };
    const first = store.putAutonomyPolicy(args);
    if (!first || first.ok !== true) return false;
    const replay = store.putAutonomyPolicy(args);
    const updated = store.putAutonomyPolicy(Object.assign({}, args, {
      perPurchaseLimitMinor: 12000, idempotencyKey: SK('h2', 16)
    }));
    return replay.ok === true && replay.replayed === true &&
      updated.ok === true && updated.result.created === false &&
      updated.result.revision > first.result.revision &&
      String(updated.result.perPurchaseLimitMinor) === '12000';
  })());

check('h3 ★★ §5 大小关系仍然由 evaluateAutonomousPurchase 决定：approvalAbove > perPurchase 被拒（坏配置 fail closed）',
  (() => {
    const out = store.putAutonomyPolicy({
      ownerId: AGENT, currency: CUR, enabled: true,
      perPurchaseLimitMinor: 100, dailyAutonomousLimitMinor: 200,
      approvalAboveMinor: 5000, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], allowGift: false,
      idempotencyKey: SK('h3', 17)
    });
    return out.ok === false &&
      out.errors.indexOf('autonomy-approval-threshold-must-not-exceed-the-per-purchase-limit') >= 0;
  })());

check('h4 ★★ §5 一个被禁的输入位（alwaysApprove / skipBudget / forceSettlement …）在 config 白名单里不存在，而在 store 的参数里也不存在',
  (() => {
    const keys = [];
    for (const w of createSeam.COMMAND_LIST) keys.push.apply(keys, createSeam.CONFIG_KEYS[w]);
    return ['alwaysApprove', 'skipBudget', 'forceSettlement', 'ignoreQuoteExpiry',
      'providerTopup', 'realPayment', 'autoAllow', 'bypassBudget', 'bypassApproval',
      'grantsBudget', 'isADecisionLayer'].every(k => keys.indexOf(k) < 0) &&
      ['alwaysApprove', 'skipBudget', 'forceSettlement', 'ignoreQuoteExpiry']
        .every(v => seamCode.indexOf(v) < 0);
  })());

check('h5 ★★ §5 自主策略仍然**不能**绕预算：把自主额度调到远超余额，权威仍然拒绝',
  (() => {
    /* ★ 这条走的是 canonical 评估器（P22-7 的 evaluateAutonomousPurchase），
       本阶段**不重新实现**它。context 的键逐字来自 store 自己的
       autonomyContextOf —— 抄一份等于造第二份 canonical 输入。
       ★ "不能绕预算"的形态是：AUTO_ALLOW 只是**许可**（不授予预算、
       不是预算判断），而预算仍然由 P22-4 的评估器独立执行。 */
    const policy = store.getAutonomyPolicy({ ownerId: AGENT }).policy;
    const contextOf = over => Object.assign({
      ownerId: { type: 'character', id: AGENT },
      productKind: 'COMPUTE_CREDIT',
      settlementType: 'COMPUTE_GRANT',
      currency: CUR,
      amountMinor: 10n,
      gift: false,
      selfDirected: true,
      spentTodayMinor: 0n,
      timestamp: 1700000000000
    }, over || {});
    const decision = C.evaluateAutonomousPurchase(policy, contextOf());
    const overLimit = C.evaluateAutonomousPurchase(policy, contextOf({ amountMinor: 999999n }));
    const overDaily = C.evaluateAutonomousPurchase(policy, contextOf({ amountMinor: 10n, spentTodayMinor: 999999n }));
    return decision.outcome === C.AP_DECISION.AUTO_ALLOW &&
      decision.grantsBudget === false && decision.notABudgetDecision === true &&
      overLimit.outcome !== C.AP_DECISION.AUTO_ALLOW &&
      overDaily.outcome !== C.AP_DECISION.AUTO_ALLOW &&
      /* ★ 没有策略 ⇒ REQUIRE_APPROVAL（默认 fail closed，不是放行）。 */
      C.evaluateAutonomousPurchase(null, contextOf()).outcome === C.AP_DECISION.REQUIRE_APPROVAL;
  })());

/* ══ 收尾 ══════════════════════════════════════════════════════════════ */
for (const c of closables) { try { c.close(); } catch (_) { } }
for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { } }

console.log('\n' + (failures === 0 ? '✔' : '✖') + ' P22-14 configuration: ' +
  (checks - failures) + '/' + checks + ' checks passed');
if (failures) { console.error(failures + ' FAILED'); process.exit(1); }
