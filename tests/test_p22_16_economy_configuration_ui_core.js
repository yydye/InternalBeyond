'use strict';
/* ====================================================================
   P22-16 · Economy Configuration UI — 纯层（assets/js/economy-configuration-core.js）
   --------------------------------------------------------------------
   运行：node tests/test_p22_16_economy_configuration_ui_core.js

   ★ 这一条测试要证明的是四件事，而它们都必须**由环境或真实源码**回答，
     不能由纯层的注释回答：

     ① 它真的纯：加载进一个没有 document、没有 fetch、没有 location 的
        沙箱里照样工作，而且源码里根本没有那三个名字；
     ② 它投影的是**真的** canonical 契约：命令词表 / 信封键 / 每个命令的
        config 键白名单 / 币种 scale / limits 键 / 自主等级 / 商品类别 /
        交付方式，逐表与 services/home-node/economy-configuration.js 和
        economy-contract.js 比对 —— 服务端加一个字段而这少一个键，这里
        必须变红，而不是静默地少发一个配置；
     ③ 它在结构上做不到危险的事：没有铸造 / 账本 / 转账 / 购买 / 结算
        的词，没有身份参数位，请求体的键恰好是白名单里的那些；
     ④ 它不说假话：保存成功的文案里没有一句"现在可以买了"；未登记的
        拒绝码不编句子；预算快照里的 decision **不进视图模型**。

   零子进程、零 socket、零浏览器。
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const CORE_REL = 'assets/js/economy-configuration-core.js';
const SEAM_REL = 'services/home-node/economy-configuration.js';
const CONTRACT_REL = 'services/home-node/economy-contract.js';
const CONTRACT = require(path.join(ROOT, CONTRACT_REL));

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  ✔ ' + name); return true; }
  failures += 1;
  console.error('  ✖ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : ''));
  return false;
}
function section(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 62 - t.length))); }
function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }

console.log('P22-16 · Economy Configuration UI core（纯层）');

/* ── 沙箱：只有一个 window，没有 document、没有 fetch、没有 location ──
   ★ 这是刻意的：core 的"纯"由**环境**证明，不由它的注释证明。 */
const box = { console: { log() {}, warn() {}, error() {}, info() {} } };
box.window = box; box.self = box;
const sandbox = vm.createContext(box);
let core = null;
try {
  vm.runInContext(read(CORE_REL), sandbox, { filename: 'economy-configuration-core.js' });
  core = box.IB && box.IB.economyConfigurationCore;
} catch (error) {
  console.error('  加载纯层失败 — ' + String((error && error.stack) || error));
  failures += 1;
}
const coreSrc = read(CORE_REL);
const coreCode = coreSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const seamSrc = read(SEAM_REL);

if (!core) {
  console.error('\n纯层没有加载出来，后续断言无意义。');
  console.log('\n结果: ' + checks + ' 通过, ' + (failures + 1) + ' 失败');
  process.exit(1);
}

/* ══════════════════════════════════════════════════════════════════════ */
section('A · 纯层存在，而且它真的纯');

check('A1 ★★ 纯层加载成功并挂在 window.IB.economyConfigurationCore 上',
  !!core && typeof core.buildBootstrapRequest === 'function' &&
  typeof core.buildBudgetRequest === 'function' &&
  typeof core.buildAutonomyRequest === 'function' &&
  typeof core.buildPageView === 'function');

check('A2 ★★★ 沙箱里**没有** document / fetch / XMLHttpRequest / location —— 纯层不碰 DOM、不发请求',
  typeof box.document === 'undefined' && typeof box.fetch === 'undefined' &&
  typeof box.XMLHttpRequest === 'undefined' && typeof box.location === 'undefined' &&
  coreCode.indexOf('document') < 0 && coreCode.indexOf('fetch') < 0 &&
  coreCode.indexOf('XMLHttpRequest') < 0 && coreCode.indexOf('localStorage') < 0,
  { document: typeof box.document, fetch: typeof box.fetch });

/* ══════════════════════════════════════════════════════════════════════ */
section('B · 镜像表与 canonical 契约逐字一致（服务端改了这里必须红）');

/* 从 seam 源码里取真的那几张表。
   ★ 为什么用正则而不是 require：seam 的 module.exports 是一个工厂函数，
   它的表是闭包内的常量，拿不到。而"拿不到就跳过"会让这一组变成永远
   绿的空断言 —— 因此宁可解析源码，并在解析不到时明确失败。 */
function seamCommandValues(src) {
  const block = (src.match(/const COMMAND = Object\.freeze\(\{([\s\S]*?)\n\}\);/) || [])[1];
  if (!block) return null;
  return [...block.matchAll(/([A-Z_]+)\s*:\s*'([A-Z_]+)'/g)].map(m => m[2]);
}
function seamArrayLiteral(src, name) {
  const m = src.match(new RegExp('const ' + name + ' = Object\\.freeze\\(\\[([^\\]]*)\\]\\)'));
  if (!m) return null;
  return JSON.parse('[' + m[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');
}
function seamConfigKeys(src) {
  const block = (src.match(/const CONFIG_KEYS = Object\.freeze\(\{([\s\S]*?)\n\}\);/) || [])[1];
  if (!block) return null;
  const out = {};
  for (const m of block.matchAll(/([A-Z_]+)\s*:\s*Object\.freeze\(\[([\s\S]*?)\]\)/g)) {
    out[m[1]] = JSON.parse('[' + m[2].replace(/'/g, '"') + ']');
  }
  return out;
}
function seamPath(src) {
  const m = src.match(/const CONFIGURATION_PATH = '([^']+)';/);
  return m ? m[1] : null;
}
function seamRunners(src) {
  const m = src.match(/const RUNNERS = Object\.freeze\(\{([\s\S]*?)\n  \}\);/);
  if (!m) return null;
  return [...m[1].matchAll(/^\s*([A-Z_]+)\s*:/gm)].map(x => x[1]);
}
function seamRefusalCodes(src) {
  const block = (src.match(/const REFUSAL = Object\.freeze\(\{([\s\S]*?)\n\}\);/) || [])[1];
  if (!block) return null;
  return [...block.matchAll(/'([A-Z][A-Z0-9_]{6,})'/g)].map(m => m[1]);
}

const seamCommands = seamCommandValues(seamSrc);
const seamEnvelope = seamArrayLiteral(seamSrc, 'ENVELOPE_KEYS');
const seamConfig = seamConfigKeys(seamSrc);
const seamRunnerNames = seamRunners(seamSrc);
const seamRefusals = seamRefusalCodes(seamSrc);

check('B1 ★★★ 三个命令词与 seam 的 COMMAND 逐字一致（而且恰好三个，顺序也一样）',
  Array.isArray(seamCommands) && seamCommands.length === 3 &&
  JSON.stringify(core.COMMANDS) === JSON.stringify(seamCommands) &&
  JSON.stringify(Object.keys(core.COMMAND).map(k => core.COMMAND[k])) === JSON.stringify(seamCommands),
  { core: core.COMMANDS, seam: seamCommands });

check('B2 ★★★ 命令词表恰好被 seam 的 RUNNERS 受理的三个 —— 没有第四个命令可发',
  Array.isArray(seamRunnerNames) &&
  JSON.stringify(seamRunnerNames.slice().sort()) === JSON.stringify(core.COMMANDS.slice().sort()),
  { seamRunners: seamRunnerNames });

check('B3 ★★★ 信封键恰好三个，且与 seam 的 ENVELOPE_KEYS 逐字一致',
  Array.isArray(seamEnvelope) && seamEnvelope.length === 3 &&
  JSON.stringify(core.ENVELOPE_KEYS) === JSON.stringify(seamEnvelope), { seam: seamEnvelope });

check('B4 ★★★ 每个命令的 config 键白名单与 seam 的 CONFIG_KEYS 逐字一致（三支都比）',
  !!seamConfig && Object.keys(core.CONFIG_KEYS).length === Object.keys(seamConfig).length &&
  Object.keys(seamConfig).every(function (c) {
    return JSON.stringify(core.CONFIG_KEYS[c]) === JSON.stringify(seamConfig[c]);
  }),
  { core: core.CONFIG_KEYS, seam: seamConfig });

check('B5 ★★★ 唯一的写路径就是 seam 的那一条字面量，且它不落在 /economy/ 前缀下',
  core.WRITE_PATH === seamPath(seamSrc) &&
  core.WRITE_PATH === '/internal/economy/configuration' &&
  core.WRITE_PATH.indexOf('/economy/') !== 0);

check('B6 ★★★ 币种 scale / limits 键 / 自主等级 / 商品类别 / 交付方式五张表与 canonical 契约逐字一致',
  JSON.stringify(core.CURRENCY_SCALE) === JSON.stringify(CONTRACT.CURRENCY_SCALE) &&
  JSON.stringify(core.LIMIT_KEYS) === JSON.stringify(CONTRACT.BUDGET_LIMIT_KEYS) &&
  core.COOLDOWN_KEY === CONTRACT.COOLDOWN_KEY &&
  JSON.stringify(core.AUTONOMY_LEVELS) === JSON.stringify(CONTRACT.AUTONOMY_LEVELS) &&
  JSON.stringify(core.PRODUCT_KINDS) === JSON.stringify(CONTRACT.PRODUCT_KINDS) &&
  JSON.stringify(core.FULFILLMENTS) === JSON.stringify(CONTRACT.FULFILLMENTS),
  {
    limits: core.LIMIT_KEYS.length, levels: core.AUTONOMY_LEVELS.length,
    kinds: core.PRODUCT_KINDS.length, fulfillments: core.FULFILLMENTS.length
  });

check('B7 ★★ 界面暴露的 limit 档位是契约受理键的**子集**（不暴露一个契约不认的档）',
  core.LIMIT_FIELDS.every(f => core.LIMIT_KEYS.indexOf(f.key) >= 0) &&
  core.LIMIT_FIELDS.length >= 4);

check('B8 ★★★ 只读面恰好是五条既有 GET（本阶段一条新读路径都没有）',
  JSON.stringify(Object.keys(core.READS).sort()) === JSON.stringify(['AUTONOMY_POLICY', 'BUDGET', 'POLICY', 'SECURITY', 'WALLET']) &&
  core.READS.WALLET === '/economy/wallet' && core.READS.POLICY === '/economy/policy' &&
  core.READS.AUTONOMY_POLICY === '/economy/autonomy-policy' && core.READS.BUDGET === '/economy/budget' &&
  core.READS.SECURITY === '/security');

check('B8b ★★★ 覆盖的是**四条**既有写面声明：每个 seam 拒绝码都有一句人话（或明确留给兜底）',
  Array.isArray(seamRefusals) && seamRefusals.length >= 15 &&
  seamRefusals.every(c => typeof core.REFUSAL_TEXT[c] === 'string'),
  Array.isArray(seamRefusals) ? seamRefusals.filter(c => typeof core.REFUSAL_TEXT[c] !== 'string') : null);

check('B8c ★★★ 配置面开不开是**搬**来的：configurationGate 只读 /security 的两个字段，读不到答 null',
  core.configurationGate({ economyPolicy: { configuration: { implemented: true, open: true, configurationCommandsExposed: ['BOOTSTRAP_CREDIT'] } } }).open === true &&
  core.configurationGate({ economyPolicy: { configuration: { implemented: true, open: false, configurationCommandsExposed: [] } } }).open === false &&
  core.configurationGate({}) === null && core.configurationGate(null) === null && core.configurationGate('nope') === null);

check('B8d ★★★ 命令名单关着时**一定是空的**：即使 open 被读成 true，没有名单也不发按钮',
  core.canConfigure({ open: true, commands: [] }, 'BOOTSTRAP_CREDIT') === false &&
  core.canConfigure({ open: false, commands: ['BOOTSTRAP_CREDIT'] }, 'BOOTSTRAP_CREDIT') === false &&
  core.canConfigure({ open: true, commands: ['BOOTSTRAP_CREDIT'] }, 'BOOTSTRAP_CREDIT') === true &&
  core.canConfigure({ open: true, commands: ['BOOTSTRAP_CREDIT'] }, 'MINT') === false &&
  core.canConfigure(null, 'BOOTSTRAP_CREDIT') === false);

/* ══════════════════════════════════════════════════════════════════════ */
section('C · 结构上做不到的事：没有铸造 / 账本 / 转账 / 购买 / 结算的词');

const forbidden = ['mintForSystem', 'burnForSystem', 'commitLedgerTransaction', 'transferBetweenWallets',
  'reserveFunds', 'commitReservation', 'settlePurchase', 'grantInventory', 'consumeInventory',
  'createQuote', 'decideApproval', 'resumeAgentPurchaseIntent', 'putStore', 'putProduct',
  'refund', 'exchange', 'topup', 'providerQuota', 'payment'];
check('C1 ★★★ 十九个经济 mutation / 支付相关的名字在纯层里一个都不存在',
  forbidden.every(w => coreCode.indexOf(w) < 0),
  forbidden.filter(w => coreCode.indexOf(w) >= 0));

check('C2 ★★★ 命令词里没有 BUY / SETTLE / RESERVE / GRANT / APPROVE / REJECT / REFUND / EXCHANGE / TOPUP',
  ['BUY', 'SETTLE', 'RESERVE', 'GRANT_INVENTORY', 'APPROVE', 'REJECT', 'REFUND', 'EXCHANGE', 'PROVIDER_TOPUP', 'RAW_LEDGER_WRITE']
    .every(w => core.COMMANDS.indexOf(w) < 0 && Object.keys(core.COMMAND).indexOf(w) < 0));

check('C3 ★★★ CLI 里没有 mint / ledger / transfer / buy / refund / exchange / topup 这些**命令字样**',
  ['MINT', 'LEDGER_WRITE', 'TRANSFER', 'BUY', 'REFUND', 'EXCHANGE', 'TOPUP']
    .every(w => coreCode.indexOf("'" + w + "'") < 0));

/* ── 两个问题必须分开问，否则会得到一个错的通过 ─────────────────────────
   ① 请求体构造点里，有没有位置塞身份 / 权威？
      → 那里才是"发得出去"的地方，因此断言**只**看那一段源码。
   ② 整个文件里有没有把这些名字作为属性写出？
      → `token` 这个名字在纯层里确实作为属性出现过 —— 它是**拒绝码的词**
        （refusalText 的 `token:`），不是凭据。把两者混成一个断言会得到
        一条"为了通过而必须删掉一个正确实现"的假红，因此这里把它排除，
        但保留其余八个身份 / 权威名。 */
function writtenAsProperty(src, key) {
  const re = new RegExp('(?:^|[^A-Za-z0-9_$])' + key + '\\s*[:=](?!=)', 'm');
  return re.test(src);
}
const bodySlice = (function () {
  const start = coreSrc.indexOf('function envelope(');
  const end = coreSrc.indexOf('function pickFromClosedSet');
  return (start >= 0 && end > start) ? coreSrc.slice(start, end) : '';
})();
check('C4 ★★★ 三个请求体构造点的源码里，九个身份 / 权威名一个都不作为属性被写出',
  bodySlice.length > 500 &&
  ['actor', 'caller', 'consumerId', 'decidedBy', 'authority', 'approved', 'autoAllow', 'isAdmin', 'token']
    .every(k => !writtenAsProperty(bodySlice, k)) &&
  /* 那一整段里写出的属性只有信封的三个键 + 白名单里的 config 键。 */
  (function () {
    const written = (bodySlice.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gm) || [])
      .map(s => s.replace(/[\s:]/g, ''));
    const allowed = ['command', 'config', 'idempotencyKey', 'ownerId', 'currency', 'amountMinor',
      'limits', 'termEndsAt', 'autonomyLevel', 'ifRevision', 'enabled', 'perPurchaseLimitMinor',
      'dailyAutonomousLimitMinor', 'approvalAboveMinor', 'allowedProductKinds', 'allowedSettlementTypes',
      'allowGift', 'ok', 'code', 'body', 'keys', 'configKeys', 'text', 'field'];
    return written.every(w => allowed.indexOf(w) >= 0);
  })(),
  { slice: bodySlice.length });

check('C4b ★★★ 整个纯层里，八个身份 / 权威名也从不作为属性被写出',
  ['actor', 'caller', 'consumerId', 'decidedBy', 'authority', 'approved', 'autoAllow', 'isAdmin']
    .every(k => !writtenAsProperty(coreCode, k)),
  ['actor', 'caller', 'consumerId', 'decidedBy', 'authority', 'approved', 'autoAllow', 'isAdmin']
    .filter(k => writtenAsProperty(coreCode, k)));

/* ══════════════════════════════════════════════════════════════════════ */
section('D · ① 初始额度：一次性、只能 IB Credit、不接受 0');

const OWNER = 'p16_owner_agent';

const boot1 = core.buildBootstrapRequest(OWNER, '1000', 'ui-k-boot');
check('D1 ★★★ 合法输入：信封恰好三个键，config 恰好 ownerId / currency / amountMinor',
  boot1.ok === true &&
  JSON.stringify(Object.keys(boot1.body)) === JSON.stringify(['command', 'config', 'idempotencyKey']) &&
  JSON.stringify(Object.keys(boot1.body.config)) === JSON.stringify(['ownerId', 'currency', 'amountMinor']) &&
  boot1.body.command === 'BOOTSTRAP_CREDIT' &&
  boot1.body.config.ownerId === OWNER &&
  boot1.body.config.currency === 'IB_CREDIT' &&
  boot1.body.config.amountMinor === '100000' &&
  boot1.body.idempotencyKey === 'ui-k-boot');

check('D2 ★★★ 函数签名恰好三个位置参数 —— 调用方**没有**第四个位置可以放身份或币种',
  core.buildBootstrapRequest.length === 3 &&
  core.buildBudgetRequest.length === 3 &&
  core.buildAutonomyRequest.length === 3);

check('D3 ★★★ 空 / 0 / 负数 / 非数 → 一律 fail closed（不发请求），一分钱都铸不出来',
  core.buildBootstrapRequest(OWNER, '', 'k').ok === false &&
  core.buildBootstrapRequest(OWNER, '   ', 'k').ok === false &&
  core.buildBootstrapRequest(OWNER, '0', 'k').ok === false &&
  core.buildBootstrapRequest(OWNER, '0.00', 'k').ok === false &&
  core.buildBootstrapRequest(OWNER, '-5', 'k').ok === false &&
  core.buildBootstrapRequest(OWNER, 'abc', 'k').ok === false &&
  core.buildBootstrapRequest(OWNER, '1e5', 'k').ok === false);

check('D4 ★★★ 没有 ownerId 就不构造（配置目标是必填的）',
  core.buildBootstrapRequest(null, '100', 'k').ok === false &&
  core.buildBootstrapRequest('', '100', 'k').ok === false &&
  core.buildBootstrapRequest('  ', '100', 'k').ok === false);

check('D5 ★★ 金额按币种 scale 解析：IB Credit 是两位小数，且**不猜**',
  core.parseMinorInput('1000', 'IB_CREDIT').minor === '100000' &&
  core.parseMinorInput('1000.5', 'IB_CREDIT').minor === '100050' &&
  core.parseMinorInput('1000.55', 'IB_CREDIT').minor === '100055' &&
  core.parseMinorInput('0.01', 'IB_CREDIT').minor === '1' &&
  core.parseMinorInput('1,000.00', 'IB_CREDIT').minor === '100000' &&
  core.parseMinorInput('1000.555', 'IB_CREDIT').ok === false &&
  core.parseMinorInput('007', 'IB_CREDIT').minor === '700' &&
  core.parseMinorInput('', 'IB_CREDIT').minor === null);

/* ══════════════════════════════════════════════════════════════════════ */
section('E · ② 预算规则：留空 = 不设；填了才发；投影严格落在 canonical 上');

const budget = core.buildBudgetRequest(OWNER, {
  perTransactionMinor: '50', dailyMinor: '200', approvalThresholdMinor: '30',
  weeklyMinor: '', monthlyMinor: '', cooldownMs: '', termEndsAt: '', autonomyLevel: '',
  ifRevision: ''
}, 'ui-k-budget');

check('E1 ★★★ 只发送用户真的填了的档位（留空 = 这一档不设，而不是填 0）',
  budget.ok === true &&
  JSON.stringify(Object.keys(budget.body.config.limits)) === JSON.stringify(['perTransactionMinor', 'dailyMinor', 'approvalThresholdMinor']) &&
  budget.body.config.limits.perTransactionMinor === '5000' &&
  budget.body.config.limits.dailyMinor === '20000' &&
  budget.body.config.limits.approvalThresholdMinor === '3000');

check('E2 ★★★ config 的键**只能**是白名单里的（逐键检查，一个越界键都不发）',
  Object.keys(budget.body.config).every(k => core.CONFIG_KEYS.PUT_BUDGET_POLICY.indexOf(k) >= 0) &&
  Object.keys(budget.body.config.limits).every(k => core.LIMIT_KEYS.indexOf(k) >= 0 || k === core.COOLDOWN_KEY));

check('E3 ★★★ 币种被钉死成 IB Credit —— 调用方没有位置换一个币种',
  budget.body.config.currency === 'IB_CREDIT' &&
  core.buildBudgetRequest(OWNER, { currency: 'USD' }, 'k').body.config.currency === 'IB_CREDIT');

check('E4 ★★★ 显式的 0 是一个**有含义**的值（一分钱都不许），不会被当成"没填"',
  (function () {
    const b = core.buildBudgetRequest(OWNER, { perTransactionMinor: '0' }, 'k');
    return b.ok === true && b.body.config.limits.perTransactionMinor === '0' &&
      Object.prototype.hasOwnProperty.call(b.body.config.limits, 'perTransactionMinor');
  })());

check('E5 ★★★ 非法金额 fail closed：整个请求都不构造（不做"跳过这一档"的静默降级）',
  core.buildBudgetRequest(OWNER, { perTransactionMinor: '12.345' }, 'k').ok === false &&
  core.buildBudgetRequest(OWNER, { perTransactionMinor: '12.345' }, 'k').field === 'perTransactionMinor' &&
  core.buildBudgetRequest(OWNER, { dailyMinor: 'abc' }, 'k').ok === false &&
  core.buildBudgetRequest(OWNER, { cooldownMs: '1.5' }, 'k').ok === false &&
  core.buildBudgetRequest(OWNER, { termEndsAt: '2026/01/01' }, 'k').ok === false &&
  core.buildBudgetRequest(OWNER, { autonomyLevel: 'UNLIMITED' }, 'k').ok === false);

check('E6 ★★ 有效期：界面上的那一天 → 那一天的**结束**时刻（UTC 毫秒）',
  (function () {
    const b = core.buildBudgetRequest(OWNER, { termEndsAt: '2026-03-04' }, 'k');
    const end = Date.UTC(2026, 2, 4, 23, 59, 59, 999);
    return b.ok === true && b.body.config.termEndsAt === end &&
      core.dateInputOf(end) === '2026-03-04';
  })());

check('E7 ★★ ifRevision 只在给了权威 revision 时才带上（否则不带，而不是带一个猜的数）',
  core.buildBudgetRequest(OWNER, { ifRevision: '7' }, 'k').body.config.ifRevision === 7 &&
  !Object.prototype.hasOwnProperty.call(core.buildBudgetRequest(OWNER, {}, 'k').body.config, 'ifRevision') &&
  core.buildBudgetRequest(OWNER, { ifRevision: '-1' }, 'k').ok === false);

/* ══════════════════════════════════════════════════════════════════════ */
section('F · ③ 自主规则：两个上限必填；空选集 = 省略（canonical 的"什么都不自主买"）');

const auto = core.buildAutonomyRequest(OWNER, {
  enabled: true, perPurchaseLimitMinor: '80', dailyAutonomousLimitMinor: '300',
  approvalAboveMinor: '40',
  allowedProductKinds: ['SERVICE', 'DIGITAL_ITEM', 'SERVICE'],
  allowedSettlementTypes: ['COMPUTE_GRANT'],
  allowGift: false, ifRevision: '3'
}, 'ui-k-auto');

check('F1 ★★★ 合法输入：config 里的键全部在白名单里，选集按闭集顺序稳定排列（幂等指纹稳定）',
  auto.ok === true &&
  Object.keys(auto.body.config).every(k => core.CONFIG_KEYS.PUT_AUTONOMY_POLICY.indexOf(k) >= 0) &&
  JSON.stringify(auto.body.config.allowedProductKinds) === JSON.stringify(['DIGITAL_ITEM', 'SERVICE']) &&
  JSON.stringify(auto.body.config.allowedSettlementTypes) === JSON.stringify(['COMPUTE_GRANT']) &&
  auto.body.config.perPurchaseLimitMinor === '8000' &&
  auto.body.config.dailyAutonomousLimitMinor === '30000' &&
  auto.body.config.approvalAboveMinor === '4000' &&
  auto.body.config.enabled === true && auto.body.config.allowGift === false &&
  auto.body.config.ifRevision === 3);

check('F2 ★★★ 两个上限是契约的必填项：空着就 fail closed（不发请求，也不替用户猜一个数）',
  core.buildAutonomyRequest(OWNER, { enabled: true, perPurchaseLimitMinor: '', dailyAutonomousLimitMinor: '10' }, 'k').ok === false &&
  core.buildAutonomyRequest(OWNER, { enabled: true, perPurchaseLimitMinor: '10', dailyAutonomousLimitMinor: '' }, 'k').ok === false &&
  core.buildAutonomyRequest(OWNER, { enabled: true, perPurchaseLimitMinor: '0', dailyAutonomousLimitMinor: '10' }, 'k').ok === false &&
  core.buildAutonomyRequest(OWNER, { enabled: true, perPurchaseLimitMinor: '10', dailyAutonomousLimitMinor: '-1' }, 'k').ok === false);

check('F3 ★★★ 一个都不选时**省略**字段（= canonical 的空集"不自主买任何东西"），绝不发空数组、也绝不变成"全选"',
  (function () {
    const b = core.buildAutonomyRequest(OWNER, {
      enabled: true, perPurchaseLimitMinor: '10', dailyAutonomousLimitMinor: '20',
      allowedProductKinds: [], allowedSettlementTypes: []
    }, 'k');
    return b.ok === true &&
      !Object.prototype.hasOwnProperty.call(b.body.config, 'allowedProductKinds') &&
      !Object.prototype.hasOwnProperty.call(b.body.config, 'allowedSettlementTypes');
  })());

check('F4 ★★★ 闭集外的成员 → 整个请求不构造（不静默丢弃，因为那会变成一次内容不同的写入）',
  core.buildAutonomyRequest(OWNER, { enabled: true, perPurchaseLimitMinor: '1', dailyAutonomousLimitMinor: '2', allowedProductKinds: ['NOPE'] }, 'k').ok === false &&
  core.buildAutonomyRequest(OWNER, { enabled: true, perPurchaseLimitMinor: '1', dailyAutonomousLimitMinor: '2', allowedSettlementTypes: ['INSTANT'] }, 'k').ok === false &&
  core.buildAutonomyRequest(OWNER, { enabled: true, perPurchaseLimitMinor: '1', dailyAutonomousLimitMinor: '2', allowedProductKinds: 'SERVICE' }, 'k').ok === false);

check('F5 ★★★ 用户没勾"允许送礼"时它**是** false，而不是缺席 —— 缺席意味着"保持上一次的值"',
  core.buildAutonomyRequest(OWNER, { enabled: false, perPurchaseLimitMinor: '1', dailyAutonomousLimitMinor: '2' }, 'k').body.config.allowGift === false &&
  core.buildAutonomyRequest(OWNER, { enabled: false, perPurchaseLimitMinor: '1', dailyAutonomousLimitMinor: '2' }, 'k').body.config.enabled === false);

check('F6 ★★ 语义约束（单次 ≤ 每日、确认线 ≤ 单次）**不在这里判**：形状合法就发出去，让权威回答',
  (function () {
    /* 这是刻意的：界面只校验形状，语义由经济权威判定 —— 一份"界面自己
       也判一遍"的实现会造出第二个答案，而它与权威不一致时用户看到的
       是两句话。因此这里要求**构造成功**（请求发得出去），并另有 P1 断言
       canonical 的拒绝会被显示出来。 */
    const b = core.buildAutonomyRequest(OWNER, {
      enabled: true, perPurchaseLimitMinor: '500', dailyAutonomousLimitMinor: '100'
    }, 'k');
    return b.ok === true && b.body.config.perPurchaseLimitMinor === '50000' &&
      b.body.config.dailyAutonomousLimitMinor === '10000';
  })());

/* ══════════════════════════════════════════════════════════════════════ */
section('G · ④ 回答归类：成功只说"已保存"，未登记的码不编句子');

const okBudget = core.classifyConfigurationResponse({
  ok: true, command: 'PUT_BUDGET_POLICY', configuredAnything: true, budgetPolicyWritten: true,
  replayed: false, ledgerMutation: false, purchaseMutation: false, approvalMutation: false,
  policyId: 'econ_bp_1', policyRevision: 2
});
check('G1 ★★★ "预算规则已保存"就是全部结论 —— 文案里没有"可以买"/"现在可以"/"放权"/"无限"',
  okBudget.ok === true && okBudget.outcome === 'configured' &&
  okBudget.text === core.COPY.budgetSaved &&
  ['可以买', '现在可以', '放权', '无限', '已解锁', '已开启购买'].every(w => okBudget.text.indexOf(w) < 0));

check('G2 ★★★ 自主规则的保存文案同样不提"可以买"，而且正文里有一句"仍受约束"',
  (function () {
    const a = core.classifyConfigurationResponse({
      ok: true, command: 'PUT_AUTONOMY_POLICY', configuredAnything: true, autonomyPolicyWritten: true, replayed: false
    });
    return a.ok === true && a.text === core.COPY.autonomySaved &&
      a.text.indexOf('可以买') < 0 && a.text.indexOf('现在可以') < 0 &&
      core.COPY.autonomyAuthorityNote.indexOf('仍受') >= 0 &&
      core.COPY.autonomyAuthorityNote.indexOf('Budget') > 0 &&
      core.COPY.autonomyAuthorityNote.indexOf('Approval') > 0;
  })());

check('G3 ★★★ 初始额度的"这次真的铸了"与"早就发过了"是**两个**结论（不许把重放说成新发）',
  (function () {
    const fresh = core.classifyConfigurationResponse({
      ok: true, command: 'BOOTSTRAP_CREDIT', configuredAnything: true,
      initialCreditMintedNow: true, initialCreditBootstrapped: true, alreadyBootstrappedBeforeThisRequest: false
    });
    const replay = core.classifyConfigurationResponse({
      ok: true, command: 'BOOTSTRAP_CREDIT', configuredAnything: true,
      initialCreditMintedNow: false, initialCreditBootstrapped: true, alreadyBootstrappedBeforeThisRequest: true
    });
    return fresh.outcome === 'configured' && fresh.mintedNow === true && fresh.text === core.COPY.walletJustSet &&
      replay.outcome === 'replayed' && replay.mintedNow === false && replay.text === core.COPY.walletAlreadySet;
  })());

check('G4 ★★★ 回执说成功但没确认改了什么 → 不当作已保存（并且给出一个可能原因）',
  core.classifyConfigurationResponse({ ok: true, command: 'PUT_BUDGET_POLICY' }).ok === false &&
  core.classifyConfigurationResponse({ ok: true, command: 'PUT_BUDGET_POLICY', configuredAnything: true }).ok === false &&
  core.classifyConfigurationResponse({ ok: true, command: 'MINT', configuredAnything: true }).ok === false);

check('G5 ★★★ 二次初始额度：canonical 的拒绝码被翻成人话（用户不该看到大写下划线）',
  (function () {
    const r = core.classifyConfigurationResponse({
      ok: false, refused: true, reachedStore: true, status: 409,
      command: 'BOOTSTRAP_CREDIT', reasonCode: 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED',
      downstreamReasonCode: 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED',
      errors: ['initial-credit-is-one-shot-per-owner-and-currency']
    });
    return r.ok === false && r.outcome === 'refused' &&
      r.text === core.ERROR_TOKEN_TEXT['initial-credit-is-one-shot-per-owner-and-currency'] &&
      r.text.indexOf('BOOTSTRAP') < 0 && r.text.indexOf('_') < 0;
  })());

check('G6 ★★★ store 的具名 validation 词优先于拒绝码 —— 因为它更准确（这是"单次 ≤ 每日"那条）',
  (function () {
    const r = core.classifyConfigurationResponse({
      ok: false, refused: true, reachedStore: true, status: 400,
      command: 'PUT_AUTONOMY_POLICY', reasonCode: 'POLICY_INPUT_NOT_STRUCTURED',
      errors: ['autonomy-per-purchase-limit-must-not-exceed-the-daily-autonomous-limit']
    });
    return r.text === core.ERROR_TOKEN_TEXT['autonomy-per-purchase-limit-must-not-exceed-the-daily-autonomous-limit'] &&
      r.text.indexOf('每日') > 0;
  })());

check('G7 ★★★ 未登记的拒绝码**不编句子**：给兜底句 + 把原词留在 detail 里',
  (function () {
    const r = core.classifyConfigurationResponse({
      ok: false, refused: true, reasonCode: 'ECONOMY_CONFIGURATION_SOMETHING_NEW',
      errors: ['some-brand-new-token']
    });
    return r.ok === false && r.text === '这次改动没有被接受' &&
      r.unregisteredCode === 'ECONOMY_CONFIGURATION_SOMETHING_NEW' &&
      String(r.detail).indexOf('ECONOMY_CONFIGURATION_SOMETHING_NEW') >= 0 &&
      r.text.indexOf('SOMETHING') < 0;
  })());

check('G8 ★★ transport 层的失败也有句人话（不是一个 undefined）',
  ['home-node-unreachable', 'home-node-transport-error', 'timeout', 'invalid-response'].every(function (code) {
    const r = core.classifyConfigurationResponse({ ok: false, error: code });
    return typeof r.text === 'string' && r.text.length > 0 && r.text.indexOf('undefined') < 0;
  }) &&
  core.classifyConfigurationResponse(null).text === '没有收到本机节点的回答' &&
  core.classifyConfigurationResponse('nope').text === '没有收到本机节点的回答');

/* ══════════════════════════════════════════════════════════════════════ */
section('H · 视图模型：读面 → 界面，**不重算**任何经济事实');

check('H1 ★★★ 钱包：读面说 wallet-not-found → "还没有初始额度"；有钱包 → "已设置"（不是猜的）',
  core.buildWalletView({ ok: false, error: 'wallet-not-found' }).state === 'absent' &&
  core.buildWalletView({ ok: false, error: 'home-node-unreachable' }).state === 'unknown' &&
  core.buildWalletView(null).state === 'unknown' &&
  core.buildWalletView({ ok: true, wallet: { currency: 'IB_CREDIT', state: 'READY', balanceKnown: true, availableBalanceMinor: '100000' } }).state === 'present' &&
  core.buildWalletView({ ok: true, wallet: 'nope' }).state === 'malformed' &&
  core.buildWalletView({ ok: true, wallet: { currency: 'ACTIVITY_POINT' } }).state === 'malformed');

check('H2 ★★★ 余额不可信时 available 是 **null**，不是 0（"我不知道"不等于"没有钱"）',
  (function () {
    const v = core.buildWalletView({
      ok: true, wallet: { currency: 'IB_CREDIT', state: 'DEGRADED', balanceKnown: false, availableBalanceMinor: '999' }
    });
    return v.state === 'present' && v.ready === false && v.availableMinor === null;
  })());

check('H3 ★★★ 预算：没有政策是 **absent**（未配置 ≠ 读失败），canonical 的默认是"都要问"而不是"禁止"',
  core.buildBudgetView({ ok: false, error: 'budget-policy-not-found' }).state === 'absent' &&
  core.buildBudgetView({ ok: false, error: 'timeout' }).state === 'unknown' &&
  core.buildBudgetView({ ok: true, policy: { limits: { dailyMinor: '20000' }, revision: 2 } }).state === 'present' &&
  core.COPY.budgetAbsent.indexOf('需要你确认') > 0);

check('H4 ★★★ 每日刻度：两个数都来自读面；缺一个就**不编进度**，退化成纯额度刻度',
  (function () {
    const known = core.buildMeterView({ dailyMinor: '20000' }, { ok: true, snapshot: { spentTodayMinor: '5000' } });
    const noPolicy = core.buildMeterView(null, { ok: true, snapshot: { spentTodayMinor: '5000' } });
    const noSnapshot = core.buildMeterView({ dailyMinor: '20000' }, { ok: false, error: 'wallet-not-found' });
    const unknownUsage = core.buildMeterView({ dailyMinor: '20000' }, { ok: true, snapshot: { spentTodayMinor: null } });
    const over = core.buildMeterView({ dailyMinor: '100' }, { ok: true, snapshot: { spentTodayMinor: '250' } });
    return known.known === true && known.usedMinor === 5000 && known.limitMinor === 20000 &&
      known.ratioCapped === 0.25 && known.over === false &&
      noPolicy.known === false && noPolicy.reason === 'no-daily-limit' && noPolicy.limitMinor === null &&
      noSnapshot.known === false && noSnapshot.ratioCapped === null &&
      unknownUsage.known === false && unknownUsage.usedMinor === null &&
      over.known === true && over.over === true && over.ratioCapped === 1;
  })());

check('H5 ★★★ 预算快照里的 decision **不进视图模型** —— 界面拿不到"能不能买"这个结论',
  (function () {
    const m = core.buildMeterView({ dailyMinor: '100' }, {
      ok: true, snapshot: { spentTodayMinor: '1' }, decision: { outcome: 'ALLOW', reasonCode: 'BUDGET_ALLOWED' }
    });
    const keys = Object.keys(m).join(',');
    return keys.indexOf('decision') < 0 && keys.indexOf('outcome') < 0 && keys.indexOf('reasonCode') < 0 &&
      JSON.stringify(m).indexOf('ALLOW') < 0;
  })());

check('H6 ★★★ buildPageView 也不带 decision / outcome：整页模型里没有"可以买"这一位',
  (function () {
    const v = core.buildPageView({
      security: { ok: true, economyPolicy: { configuration: { implemented: true, open: true, configurationCommandsExposed: core.COMMANDS.slice() } } },
      wallet: { ok: false, error: 'wallet-not-found' },
      policy: { ok: false, error: 'budget-policy-not-found' },
      autonomyPolicy: { ok: false, error: 'autonomy-policy-not-found' },
      budgetSnapshot: { ok: true, snapshot: { spentTodayMinor: '0' }, decision: { outcome: 'ALLOW' } }
    });
    const blob = JSON.stringify(v);
    return v.canBootstrap === true && v.canPutBudget === true && v.canPutAutonomy === true &&
      v.configurable === true && v.wallet.state === 'absent' && v.budget.state === 'absent' &&
      v.autonomy.state === 'absent' && blob.indexOf('ALLOW') < 0 && blob.indexOf('decision') < 0;
  })());

check('H7 ★★★ 配置面关着 / 读不到时，三个"能不能发"的位全是 false（不给假按钮）',
  (function () {
    const closed = core.buildPageView({
      security: { ok: true, economyPolicy: { configuration: { implemented: true, open: false, configurationCommandsExposed: [] } } }
    });
    const unknown = core.buildPageView({ security: null });
    const noSecurityField = core.buildPageView({ security: { ok: true } });
    return closed.canBootstrap === false && closed.canPutBudget === false && closed.canPutAutonomy === false &&
      closed.configurable === false && closed.gateKnown === true &&
      unknown.canBootstrap === false && unknown.gateKnown === false && unknown.securityUnreadable === true &&
      noSecurityField.gateKnown === false && noSecurityField.canBootstrap === false;
  })());

check('H8 ★★★ 表单初值**来自权威读面**：没有默认值兜底，改哪一格就发哪一格',
  (function () {
    const bf = core.budgetFormFromView(core.buildBudgetView({
      ok: true, policy: { limits: { perTransactionMinor: '5000', dailyMinor: '20000' }, revision: 4, autonomyLevel: 'LIMITED' }
    }));
    const af = core.autonomyFormFromView(core.buildAutonomyView({
      ok: true, policy: {
        enabled: true, perPurchaseLimitMinor: '8000', dailyAutonomousLimitMinor: '30000',
        approvalAboveMinor: '4000', allowedProductKinds: ['SERVICE'], allowedSettlementTypes: ['COMPUTE_GRANT'],
        allowGift: true, revision: 5
      }
    }));
    const empty = core.budgetFormFromView(core.buildBudgetView({ ok: false, error: 'budget-policy-not-found' }));
    return bf.perTransactionMinor === '50.00' && bf.dailyMinor === '200.00' && bf.weeklyMinor === '' &&
      bf.ifRevision === '4' && bf.autonomyLevel === 'LIMITED' &&
      af.perPurchaseLimitMinor === '80.00' && af.allowGift === true &&
      JSON.stringify(af.allowedProductKinds) === JSON.stringify(['SERVICE']) && af.ifRevision === '5' &&
      JSON.stringify(Object.keys(empty)) === JSON.stringify([]);
  })());

check('H9 ★★ 配置对象是**从 apiConfigs 读出来的角色**，而且不建第二套角色表',
  (function () {
    const opts = core.ownerOptions(
      [{ id: 'a1', nickname: '阿尔法' }, { id: 'a2', model: 'gpt-x' }, { id: 'a1', nickname: '重复' }, { nope: 1 }],
      [{ id: 'old1', nickname: '归档的' }]
    );
    return opts.length === 3 && opts[0].id === 'a1' && opts[0].label === '阿尔法' &&
      opts[1].label === 'gpt-x' && opts[2].id === 'old1' && opts[2].archived === true &&
      core.resolveOwner(opts, 'a2').id === 'a2' && core.resolveOwner(opts, 'nope').id === 'a1' &&
      core.resolveOwner([], 'x') === null;
  })());

/* ══════════════════════════════════════════════════════════════════════ */
section('I · §1 的禁用词一个都不出现，也没有 emoji');

const allCopy = Object.keys(core.COPY).map(k => String(core.COPY[k])).join('\n');
const allTables = Object.keys(core.REFUSAL_TEXT).map(k => core.REFUSAL_TEXT[k]).join('\n') +
  '\n' + Object.keys(core.ERROR_TOKEN_TEXT).map(k => core.ERROR_TOKEN_TEXT[k]).join('\n');
const banned = ['充值', '提现', '银行卡', '支付', '余额充值', 'Provider Top-up', 'Top-up', 'top-up',
  '法币', '人民币', '美元', '汇率', '信用卡', '钱包充值'];
check('I1 ★★★ 面向用户的全部文案里没有充值 / 提现 / 银行卡 / 支付 / 法币这些词',
  banned.every(w => allCopy.indexOf(w) < 0 && allTables.indexOf(w) < 0),
  banned.filter(w => allCopy.indexOf(w) >= 0 || allTables.indexOf(w) >= 0));

check('I2 ★★★ 也没有货币符号（¥ / $ / € / £）—— 这是内部虚拟额度，不是钱',
  ['¥', '￥', '$', '€', '£'].every(s => allCopy.indexOf(s) < 0),
  ['¥', '￥', '$', '€', '£'].filter(s => allCopy.indexOf(s) >= 0));

/* ★ 判据对象是**去掉注释的代码 + 全部面向用户的文案**：`★` 在本仓库是
   注释里的分级记号（P22-15 也是这么用的），把它算成 emoji 会得到一条
   "为了通过必须删掉一个正确注释"的假红；而真正要防的是文案里出现
   💰 / 🪙 / 🛒 这一类。 */
check('I3 ★★ 去注释的代码与全部面向用户的文案里都没有 emoji',
  !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u.test(coreCode + '\n' + allCopy + '\n' + allTables) &&
  !/[💰🪙💳🛒✨🎉🔒⚙️]/u.test(coreCode + '\n' + allCopy));

check('I4 ★★★ P6 文案契约：底层词只出现在技术说明的文案里，不进正文',
  (function () {
    /* 正文（用户默认看到的句子）里不该出现环境变量名 / 端口 / 协议词。 */
    const primary = [
      core.COPY.title, core.COPY.walletTitle, core.COPY.budgetTitle, core.COPY.autonomyTitle,
      core.COPY.walletBootstrapped, core.COPY.budgetSaved, core.COPY.autonomySaved,
      core.COPY.walletAbsentBody, core.COPY.autonomyIntro, core.COPY.budgetIntro
    ].join('\n');
    return ['IB_HOME_NODE_TOKEN', 'localhost', '127.0.0.1', 'HTTP', 'POST', 'SQLite', 'Node.js']
      .every(w => primary.indexOf(w) < 0) &&
      core.COPY.closedTechnical.indexOf('IB_HOME_NODE_TOKEN') > 0;
  })());

check('I5 ★★★ §4 逐条要求表达的那几项都有对应文案；canonical 里没有的"商店范围"被明说成不存在',
  core.COPY.autonomyEnabled.length > 0 && core.COPY.autonomyPerPurchase.length > 0 &&
  core.COPY.autonomyDaily.length > 0 && core.COPY.autonomyApproval.length > 0 &&
  core.COPY.autonomyKinds.length > 0 && core.COPY.autonomySettlements.length > 0 &&
  core.COPY.autonomyGift.length > 0 &&
  core.COPY.autonomyNoStoreScope.indexOf('没有') > 0 &&
  Object.keys(core).indexOf('allowedStores') < 0);

check('I6 ★★ 没有"完全放权 / 无限自主"这一类按钮文案',
  ['完全放权', '无限自主', '随便花', '不限额', '不再询问'].every(w => allCopy.indexOf(w) < 0) &&
  core.COPY.autonomyEnabledHint.indexOf('都会先来问你') > 0);

check('I7 ★★ 幂等键是 canonical 形状（[a-z0-9-]），并且一次手势一个身份',
  (function () {
    const k = core.newIdempotencyKey('econ-cfg-budget');
    return /^[a-z0-9-]+$/.test(k) && k.indexOf('ui-') === 0 && k.length <= 96 &&
      core.newIdempotencyKey('') !== '' && core.newIdempotencyKey(null).indexOf('ui-') === 0;
  })());

/* ══════════════════════════════════════════════════════════════════════ */
console.log('\n结果: ' + checks + ' 通过, ' + failures + ' 失败');
process.exit(failures ? 1 : 0);
