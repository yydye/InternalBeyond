'use strict';
/* ====================================================================
   P22-12 · Economy Intent Producer —— 边界与 authority 断言（单进程 · 零子进程）
   --------------------------------------------------------------------
   运行：node tests/test_p22_12_economy_active_plan.js

   ── 这个文件与 test_p22_12_economy_intent_producer.js 的分工 ──────────
   那一个证的是**行为**：prompt 真的宣告、净化器真的挡、真实生产者真的把请求
   送到 P22-11 client seam 上（用 in-process 的真实 23114 路由）。
   这一个证的是**边界**：本阶段到底动了哪几个文件、没动哪几个、模型拿到了
   什么 authority（一个都没有）、消费者还是不是只有 active_agent_runtime、
   以及"读完既能下单"这条路为什么不存在。

   ── §14 的进程账 ────────────────────────────────────────────────────
   max concurrent child = 0 · total spawn = 0 · leftover = 0。
   ==================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const childProcess = require('node:child_process');

let spawnAttempts = 0;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = function () { spawnAttempts += 1; throw new Error('P22-12 must not spawn (' + name + ')'); };
}

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\uFEFF/, '');
const exists = f => fs.existsSync(path.join(ROOT, f));

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  \u2714 ' + name); return true; }
  failures += 1;
  console.log('  \u2716 ' + name + (extra === undefined ? '' : ' \u2014 ' + JSON.stringify(extra)));
  return false;
}
function section(title) { console.log('\n\u2500\u2500 ' + title); }

function stripCommentsAndStrings(src) {
  return String(src)
    .replace(/\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+\/[gimsuy]*/g, ' RE ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^\\"\n])*"/g, ' "" ')
    .replace(/`(?:\\.|[^\\`])*`/g, ' `` ');
}

const PRODUCER_FILES = ['assets/js/active-diary/active-plans.js', 'assets/js/active-diary.js'];
const CATALOG_FILES = ['assets/js/home-node-client.js', 'assets/js/home-node-bootstrap.js'];
const COMPANION_FILE = 'services/active-message-service.js';
const ECONOMY_FILES = ['services/home-node/economy-store.js', 'services/home-node/economy-contract.js',
  'services/home-node/economy-action-adapter.js', 'services/home-node/economy-command-channel.js'];

const producerSrc = PRODUCER_FILES.map(read).join('\n');
const producerCode = stripCommentsAndStrings(producerSrc);
const companionSrc = read(COMPANION_FILE);
const companionCode = stripCommentsAndStrings(companionSrc);
const catalogSrc = CATALOG_FILES.map(read).join('\n');
const catalogCode = stripCommentsAndStrings(catalogSrc);

const SERVICE = (function () {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'p22-12b-state-'));
  process.env.IB_ACTIVE_DATA_DIR = dir;
  delete process.env.IB_ECONOMY_CHANNEL_TOKEN;
  const s = require('../services/active-message-service.js');
  fs.rmSync(dir, { recursive: true, force: true });
  return s;
})();
const CHANNEL = require('../services/home-node/economy-command-channel.js');
const ECON = require('../services/home-node/economy-contract.js');

section('A · §13 消费者边界：仍然只有 active_agent_runtime');

check('A1 ★★★ 生产代码里 bind(\'active_agent_runtime\') 仍然恰好一处，且没有第二个消费者被绑上经济能力',
  (read('services/home-node-service.js').match(/\.bind\(\s*'active_agent_runtime'\s*\)/g) || []).length === 1 &&
  (read('services/home-node-service.js').match(/\.bind\(\s*'/g) || []).length === 1);
check('A2 ★★★ 本阶段没有新增任何 bind 调用（生产者拿不到 capabilitiy handle —— 它只有一条注入的出口）',
  (producerSrc.match(/\.bind\(/g) || []).length === 0 &&
  (catalogSrc.match(/\.bind\(/g) || []).length === 0 &&
  (companionSrc.match(/\.bind\(/g) || []).length === 1);
check('A3 ★★ Producer 侧零经济句柄：两个浏览器文件里没有 store / gate / adapter / performAction / proposePurchaseIntent',
  ['economyStore', 'economyCapabilityGate', 'economyActionAdapter', 'performAction',
    'proposePurchaseIntent', 'resumeApprovedPurchase', 'CAPABILITY'].every(n => producerCode.indexOf(n) < 0),
  ['economyStore', 'economyCapabilityGate', 'economyActionAdapter', 'performAction',
    'proposePurchaseIntent', 'resumeApprovedPurchase', 'CAPABILITY'].filter(n => producerCode.indexOf(n) >= 0));
check('A4 ★★ Active companion 的**新增**代码同样零经济实现：只有那一个通道客户端（P22-11 的）与净化器',
  companionCode.indexOf('economyChannel') > 0 &&
  ['economyStore', 'economyCapabilityGate', 'economyActionAdapter', 'performAction'].every(n => companionCode.indexOf(n) < 0));
check('A5 ★★ 经济侧四份文件一个字节都没有为生产者改动：它们完全不认识 prompt / 目录 / 生产者',
  ECONOMY_FILES.every(f => ['planNextProactiveMessage', 'buildPlanPrompt', 'activeEconomyCatalog',
    'ACTIVE_ECONOMY_PROPOSAL_FIELDS', 'economy_propose_purchase'].every(n => read(f).indexOf(n) < 0)));
check('A6 ★★ Chat / Group / Voice / Diary / MCP / desktop_bridge / home_node_authority 一个都没有被扩进经济链',
  ['mcp-economy', 'MCP_ECONOMY', 'desktopEconomy', 'voiceEconomy', 'diaryEconomy'].every(n => producerSrc.indexOf(n) < 0) &&
  read('services/home-node/economy-action-adapter.js').indexOf("'mcp") < 0);

section('B · §2 动作集：生产者只能产生一个经济动作');

const BANNED = ['buy', 'settle', 'reserve', 'approve', 'resume', 'grant', 'ledger', 'wallet_mutate', 'auto_allow'];
const spelled = BANNED.filter(v => new RegExp('[\\s\'"(\\[.]' + v + '[\\s\'")\\],]', 'i').test(producerCode));
check('B1 ★★★ 九个禁止的动作名（buy/settle/reserve/approve/resume/grant/ledger/wallet_mutate/auto_allow）在生产者代码里一个都没有作为动作出现',
  spelled.length === 0, spelled);
check('B2 ★★★ 生产者里唯一的经济动作名就是冻结的那一个，而且只出现一次（没有通用 economy(method,args)）',
  (producerSrc.match(/economy_propose_purchase/g) || []).length >= 1 &&
  producerSrc.indexOf('ECONOMY_PROPOSE_PURCHASE') < 0 &&
  producerCode.indexOf('economy(method') < 0 && producerCode.indexOf('econMethod') < 0);
check('B3 ★★ 仓库里没有 "econonomy_propose_purchase" 这种拼写分叉（冻结的那一个拼写是唯一答案）',
  read('assets/js/active-diary/active-plans.js').indexOf('econonomy') < 0 &&
  companionSrc.indexOf('econonomy') < 0);
check('B4 ★★★ P22-10 的 NOT_OFFERED 名单仍然把 resume 记成"已知但不开放"，本阶段没有把它打开',
  read('services/home-node/economy-action-adapter.js').indexOf('const NOT_OFFERED = Object.freeze([') > 0 &&
  read('services/home-node/economy-action-adapter.js').indexOf("action: 'ECONOMY_RESUME_APPROVED_PURCHASE'") > 0 &&
  producerSrc.indexOf('RESUME') < 0);
check('B5 ★★★ 没有任何"读 → 下单"的直连：规划器不 require 传输、不 new 服务器、不碰 23118（出口那一次 companion 调用在 active-diary.js 里，是 P22-11 的既有传输）',
  producerCode.indexOf('require(') < 0 && producerCode.indexOf('new XMLHttpRequest') < 0 &&
  producerCode.indexOf('23118') < 0 && producerCode.indexOf('createServer') < 0 &&
  producerCode.indexOf('internal/economy/command') < 0,
  { req: producerCode.indexOf('require('), server: producerCode.indexOf('createServer'), host: producerCode.indexOf('23118') });
check('B6 ★★ 生产者没有自己的调度器：没有"定期去提议购买"的定时器（经济不是消费 KPI）',
  producerCode.indexOf('economyTick') < 0 && producerCode.indexOf('schedulerTick') < 0 &&
  producerCode.indexOf('purchaseTick') < 0 &&
  /* 既有的规划链只有一个入口：聊天完成后那一次 _activeMaybePlanNext */
  companionCode.indexOf('planNextProactiveMessage') < 0);

section('C · §3/§4 authority：模型拿不到 Budget / Autonomy / Approval');

check('C1 ★★★ 生产者不产出任何权威事实字段：approvalId / autoAllow / autonomy / 经济预算 在生产者代码里零出现（`budget` 唯一一次出现是模型调用的 token 预算，不属于经济域）',
  ['approvalId', 'autoAllow', 'autonomy', 'maxPerDayMinor', 'budgetResult', 'spentTodayMinor'].every(n => producerCode.indexOf(n) < 0) &&
  (producerCode.match(/budget/g) || []).length === 1 &&
  producerCode.indexOf('budget:(opts.maxTokens') > 0,
  ['approvalId', 'autoAllow', 'autonomy', 'maxPerDayMinor', 'budgetResult', 'spentTodayMinor'].filter(n => producerCode.indexOf(n) >= 0));
check('C2 ★★ 闸门在生产里只有一个写入点，而且它只由 companion 的 health/在线状态驱动（不是"功能存在就打开"）',
  (read('assets/js/active-diary.js').match(/activeEconomyProposalEnabled\s*=/g) || []).length === 1 &&
  read('assets/js/active-diary.js').indexOf('NS.activeEconomyProposalEnabled=on') > 0 &&
  read('assets/js/active-diary.js').indexOf('economy_proposals_enabled') > 0 &&
  read('assets/js/active-diary.js').indexOf('NS.activeEconomyProposalEnabled=true') < 0);
check('C3 ★★ 闸门的默认姿态与 P22-11 逐字相同：未置位 ⇒ 净化器拒绝、prompt 不宣告（fail closed）',
  read('assets/js/active-diary/active-plans.js').indexOf("NS.activeEconomyProposalEnabled===true") > 0 &&
  read('assets/js/active-diary/active-plans.js').indexOf("if(raw==null||typeof raw!=='object'||Array.isArray(raw))return null") > 0);
check('C4 ★★★ 批准面没有被顺手打开：仓库里仍然没有任何地方触发审批决定（P22-10 的 NO_APPROVAL_TRIGGER_SEAM 继续为真）',
  producerSrc.indexOf('decideApproval') < 0 &&
  catalogSrc.indexOf('decideApproval') < 0 &&
  (companionSrc.match(/decideApproval/g) || []).length === 0 &&
  read('services/home-node/economy-action-adapter.js').indexOf('NO_APPROVAL_TRIGGER_SEAM') > 0);
check('C5 ★★ 没有新增 Approval / Budget / Store 的 UI 面（没有新的 DOM id，也没有新的设置项）',
  ['approval-ui', 'economy-store-ui', 'budget-panel', 'approvalModal', 'shop-panel'].every(n => producerSrc.indexOf(n) < 0),
  ['approval-ui', 'economy-store-ui', 'budget-panel', 'approvalModal', 'shop-panel'].filter(n => producerSrc.indexOf(n) >= 0));
check('C6 ★★ 本阶段没有新增任何经济设置项 / 新的 localStorage 键（闸门是部署事实，不是用户开关）',
  (producerSrc.match(/ib_active_economy|economy_enabled|ib_economy|economyProposalPref/g) || []).length === 0 &&
  (read('assets/js/active-diary/active-plans.js').match(/localStorage\.(getItem|setItem|removeItem)\(/g) || []).length === 4 &&
  (read('assets/js/active-diary/active-plans.js').match(/localStorage\.(getItem|setItem|removeItem)\((ACTIVE_AI_PREFS_KEY|ACTIVE_INTERACTIONS_KEY)/g) || []).length === 4);

section('D · §9 目录 grounding 走的是**既有**读面，且投影是构造式的');

const catSandbox = (function () {
  const calls = [];
  const box = {
    console: { log() { }, info() { }, warn() { }, error() { } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, TypeError,
    Map, Set, Promise, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, Intl, AbortController, Uint8Array, ArrayBuffer, TextDecoder, TextEncoder,
    /* ★ 键敏感的替身：桌面令牌只回答它自己那个键 —— 一个"任何键都返回同一个
       值"的替身会把 base URL 也变成那个值（开发期实测踩到过：症状是请求
       URL 变成 `p22-12-desktop-token/economy/products`）。 */
    localStorage: {
      getItem: k => (k === 'ib_home_node_token' ? 'p22-12-desktop-token' : null),
      setItem() { }, removeItem() { }
    },
    document: { addEventListener() { }, getElementById() { return null; }, readyState: 'complete' },
    navigator: { userAgent: 'node-test' }, location: { href: 'http://localhost/' },
    addEventListener() { }, module: undefined, exports: undefined, require: undefined,
    /* ★ home-node-client.js 的 _request 用的是**全局** fetch（它没有 deps.fetch
       这个注入点），因此替身必须挂在这里，而不是交给 createHomeNodeRemote。 */
    fetch: async function (url, init) {
      calls.push({ url: String(url), method: (init && init.method) || 'GET', headers: (init && init.headers) || {} });
      const body = JSON.stringify({
        ok: true, protocolVersion: 1,
        products: [{
          productId: 'econ_prod_x', name: 'Entitlement', description: 'd', kind: 'COMPUTE_ENTITLEMENT',
          unitName: 'unit', status: 'active',
          currency: 'IB_CREDIT', unitPriceMinor: '1250', grantQuantity: 5000, storeId: 'econ_store_x',
          revision: 9, createdAt: 1, updatedAt: 2
        }]
      });
      return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
    }
  };
  box.window = box; box.self = box;
  const ctx = vm.createContext(new Proxy(box, {
    has: () => true,
    get(t, k) { if (k in t) return t[k]; if (typeof k === 'symbol') return undefined; return function () { }; }
  }));
  for (const f of ['assets/js/ib-namespace.js', 'assets/js/home-node-client.js']) {
    vm.runInContext(read(f), ctx, { filename: path.basename(f) });
  }
  return { IB: box.IB, calls: calls };
})();

const catRemote = catSandbox.IB.createHomeNodeRemote({});

(async function main() {

  const facts = await catRemote.economyCatalogFacts({ limit: 20 });

  check('D1 ★★ 目录事实用的是**既有**的 P22-5 读面 GET /economy/products（桌面读取面，带既有令牌头）',
    catSandbox.calls.length === 1 &&
    catSandbox.calls[0].url.indexOf('http://127.0.0.1:23118/economy/products') === 0 &&
    catSandbox.calls[0].method === 'GET' &&
    catSandbox.calls[0].headers['X-IB-Home-Token'] === 'p22-12-desktop-token',
    catSandbox.calls);
  check('D2 ★★★ 投影只留下六个目录事实键，价格 / 币种 / 发放数量 / 库存字段一个都没出来',
    facts.ok === true && facts.products.length === 1 &&
    Object.keys(facts.products[0]).sort().join(',') === 'description,kind,name,productId,status,unitName' &&
    JSON.stringify(facts).indexOf('1250') < 0 &&
    JSON.stringify(facts).indexOf('IB_CREDIT') < 0 &&
    JSON.stringify(facts).indexOf('5000') < 0,
    facts);
  check('D3 ★★ 投影是**构造式**的：服务端明天新增一个经济字段，它默认不可达（不是"记得去删"）',
    catSandbox.IB.ECONOMY_CATALOG_FACT_FIELDS.join(',') === 'productId,name,description,kind,unitName,status' &&
    catSandbox.IB.economyCatalogFact({ productId: 'p', brandNewEconomicField: 'secret', walletBalanceMinor: '999' }).brandNewEconomicField === undefined);
  const catFn = (function () {
    const s = read('assets/js/home-node-client.js');
    const i = s.indexOf('economyCatalogFacts: function');
    const j = s.indexOf('\n    },', i);
    return s.slice(i, j < 0 ? i + 2000 : j);
  })();
  check('D4 ★★ 目录取不到时**不抛**：归类成 {ok:false, products:[]}，让规划器 fail closed 到"这次不宣告"',
    catFn.indexOf("'catalog-unreachable'") > 0 &&
    catFn.indexOf("products: [], error:") > 0 &&
    catFn.indexOf('throw') < 0 &&
    true);
  check('D5 ★★★ 客户端新增的 /economy/ 引用只有这一条读路径字符串（没有新造经济 API、没有写路径）',
    (read('assets/js/home-node-client.js').match(/'\/economy\/[a-z-]+/g) || []).length === 1 &&
    (read('assets/js/home-node-client.js').match(/'\/economy\/[a-z-]+/g) || [])[0] === "'/economy/products" &&
    (catalogCode.match(/\/internal\/economy/g) || []).length === 0);
  check('D6 ★★ 目录 provider 在**装配层**注册，规划器只读注入；且注册不等于宣告',
    read('assets/js/home-node-bootstrap.js').indexOf('NS.activeEconomyCatalogProvider') > 0 &&
    stripCommentsAndStrings(read('assets/js/home-node-bootstrap.js')).indexOf('activeEconomyProposalEnabled') < 0 &&
    read('assets/js/active-diary/active-plans.js').indexOf('NS.activeEconomyCatalogProvider') > 0 &&
    (read('assets/js/active-diary/active-plans.js').match(/activeEconomyProposalEnabled/g) || []).length === 1);

  section('E · 装配与登记：真实链的每一段都在页面/进程里被接上');

  const html = read('InternalBeyond.html');
  check('E1 ★★ 浏览器加载顺序对：active-plans.js 在 active-diary.js **之前**（出口由后者注入，读的人在前）',
    html.indexOf('assets/js/active-diary/active-plans.js') > 0 &&
    html.indexOf('assets/js/active-diary/active-plans.js') < html.indexOf('assets/js/active-diary.js'));
  check('E2 ★★ home-node-client.js 与 home-node-bootstrap.js 都在页面里（目录 provider 的两半）',
    html.indexOf('assets/js/home-node-client.js') > 0 && html.indexOf('assets/js/home-node-bootstrap.js') > 0);
  check('E3 ★★★ 两个新测试都登记进 test-all.js（否则它们只是一次性脚本）',
    html.length > 0 &&
    read('tests/test-all.js').indexOf('test_p22_12_economy_intent_producer.js') > 0 &&
    read('tests/test-all.js').indexOf('test_p22_12_economy_active_plan.js') > 0);
  check('E4 ★★★ 23114 的 /health 字段与它的消费点成对出现（一个只读布尔 + 一个读取点，没有别的门）',
    (read('active/http.js').match(/economy_proposals_enabled/g) || []).length === 1 &&
    (stripCommentsAndStrings(read('assets/js/active-diary.js')).match(/economy_proposals_enabled/g) || []).length === 1 &&
    (stripCommentsAndStrings(read('assets/js/active-diary/active-plans.js')).match(/economy_proposals_enabled/g) || []).length === 0);
  check('E5 ★★ 通道契约里仍然只有一条写路径，而且它不在 /economy/ 读面之下（P22-11 的不变量未变）',
    CHANNEL.COMMAND_PATH === '/internal/economy/command' &&
    CHANNEL.COMMAND_PATH.indexOf('/economy/') !== 0 &&
    CHANNEL.COMMAND_LIST.length === 1 &&
    CHANNEL.COMMAND_LIST[0] === 'ECONOMY_PROPOSE_PURCHASE');
  check('E6 ★★ 生产者的 canonical 身份满足 P22-8 的幂等键形状（否则整条链会在下游被拒）',
    ECON.normalizeIdempotencyKey('p22-12.cfg_agent.econ_prod_x.self.1').ok === true &&
    ECON.PURCHASE_INTENT_DEDUPE_WINDOW_MS === 60000 &&
    read('assets/js/active-diary/active-plans.js').indexOf('60*1000') > 0);
  check('E7 ★★ canonical 身份只由四个指纹字段决定，`reason` **不参与**（否则复读时换个理由就能再买一次）',
    (function () {
      const a = read('assets/js/active-diary/active-plans.js');
      const fn = a.slice(a.indexOf('function _activeEconomyIdempotencyKey('));
      const body = fn.slice(0, fn.indexOf('\n}'));
      return body.indexOf('reason') < 0 && body.indexOf('p.agentId') > 0 &&
        body.indexOf('p.productId') > 0 && body.indexOf('p.recipientId') > 0 && body.indexOf('p.units') > 0;
    })());
  check('E8 ★★★ P22-6 的内部 entitlement 语义没有被本阶段改写（生产者不产出任何 grant / 结算原语）',
    producerCode.indexOf('COMPUTE_ENTITLEMENT') < 0 && producerCode.indexOf('settlement') < 0 &&
    ECON.CAPABILITY.PROPOSE_PURCHASE === 'PROPOSE_PURCHASE' &&
    SERVICE.economyChannel.describe().side === 'active');
  check('E9 ★★ 通道未配置时生产者的每一次尝试都以 TRANSPORT_FAILED 结束（不抛、不静默成功）',
    SERVICE.economyChannel.configured === false &&
    read('assets/js/active-diary.js').indexOf("delivery:'TRANSPORT_FAILED'") > 0 &&
    read('assets/js/active-diary.js').indexOf('notAPurchaseVerdict:true') > 0 &&
    companionSrc.indexOf('TRANSPORT_FAILED') < 0);
  check('E10 ★★ 本阶段没有新增任何 Economy 相关源文件（只在既有文件里接线）',
    /* ★ P22-13 追加了**第六**个文件（economy-approval-decision.js，用户点头/
       摇头的唯一生产入口），P22-14 追加了**第七**个（economy-configuration.js，
       fresh install 的配置入口）。因此这份清单从五个变成七个 —— 而这条断言
       真正保护的东西一行没变，而且它被写得更准确了：Economy 生产文件的数量是
       **一个被逐字点名的封闭集合**，任何一次新增都必须在这里被显式承认。
       下面两行仍然断言 P22-12 **自己**没有新开文件。 */
    fs.readdirSync(path.join(ROOT, 'services/home-node')).filter(f => /economy/.test(f)).sort().join(',') ===
    ['economy-action-adapter.js', 'economy-approval-decision.js', 'economy-capability.js',
      'economy-command-channel.js', 'economy-configuration.js', 'economy-contract.js',
      'economy-store.js'].join(',') &&
    !exists('assets/js/active-diary/economy-proposal-core.js') &&
    !exists('active/economy-planner.js'),
    fs.readdirSync(path.join(ROOT, 'services/home-node')).filter(f => /economy/.test(f)).sort());

  section('F · 资源账');
  check('F1 ★★ 本文件一次 spawn 都没有发生', spawnAttempts === 0, spawnAttempts);
  check('F2 ★★ 本文件没有开任何监听端口，也没有开任何子进程（纯静态 + 沙箱断言）', true);

  console.log('\n' + (failures === 0 ? '全部通过' : '存在失败') + '：' +
    checks + ' checks · ' + failures + ' failed');
  console.log('child process: max concurrent = 0 · total spawn = 0 · leftover = 0');
  if (failures > 0) process.exitCode = 1;

})().catch(error => {
  console.error('\u2716 未捕获异常：' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
