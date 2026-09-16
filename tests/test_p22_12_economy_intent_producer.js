'use strict';
/* ====================================================================
   P22-12 · Economy Intent Producer（单进程 · 真实文件 · 零子进程）
   --------------------------------------------------------------------
   运行：node tests/test_p22_12_economy_intent_producer.js

   ── 这个文件证明什么，以及**不**证明什么 ─────────────────────────────
   证明：`active_agent_runtime` 的模型**真的**能产生
   `economy_propose_purchase`，而不只是"净化器认得这个动作"：
     真实 prompt 构建器（assets/js/active-diary/active-plans.js 的
     buildPlanPrompt）真的会向模型宣告这个动作，真实生产者入口
     （planNextProactiveMessage）真的把模型的输出送回同一条净化链，真实出口
     （assets/js/active-diary.js 的 NS.activeEconomyProposalSink）真的把那条
     请求发到 23114 的 /economy/propose-purchase 上，而那条请求被**真实的**
     active/http.js 路由 + **真实的** P22-11 通道客户端接住。

   不证明（那些是别的阶段的证据，本阶段**不**重做）：
     · 23114 与 23118 是两个真实 OS 进程 —— P22-11 的 bridge 已经证明过；
     · 经济层最终判定（P22-7 预算 / 审批、P22-6 结算）—— P22-6 ~ P22-10。

   ── §14 的进程账 ────────────────────────────────────────────────────
   max concurrent child = 0 · total spawn = 0 · leftover = 0。
   "跨进程"在这里的意义是跨 HTTP transport：23114 路由**在同一个进程里**
   被真实创建、真实 listen、真实收发，因此没有 child 需要被证明干净。

   ── 唯一的网络替身，以及它替换掉了什么 ───────────────────────────────
   浏览器侧的那一个 fetch 是本文件里**唯一**的替身。它把浏览器实际发出的
   请求（方法 / 头 / body 一字不改）转发到 in-process 的真实 23114 路由上，
   并且把它记录下 来供断言。因此"producer → 真实路由 → 真实通道客户端"
   这一段里，**没有**任何一环被替换掉；被替换掉的只有操作系统的 loopback
   栈本身（因为 127.0.0.1:23114 在这个测试里没有真实监听者）。
   ==================================================================== */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const childProcess = require('node:child_process');

/* ★ §14 的进程账在**本文件自己的这一行**上变成可断言的：任何一处真正去开
   子进程的尝试都会被计数并当场抛错。因此 G1 不是一句自我声明 —— 它是
   "这个测试文件从头到尾一次 spawn 都没有发生过"的机器版本。 */
let spawnAttempts = 0;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = function () {
    spawnAttempts += 1;
    throw new Error('P22-12 must not spawn a child process (' + name + ')');
  };
}

const ROOT = path.resolve(__dirname, '..');
/* ★ 必须在 require active-message-service.js **之前**：它的组合根会
   fs.mkdirSync(DATA_DIR)，不隔离就会写到真实的用户目录里。 */
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-12-state-'));
process.env.IB_ACTIVE_DATA_DIR = STATE_DIR;
delete process.env.IB_ECONOMY_CHANNEL_TOKEN;
delete process.env.IB_ECONOMY_CHANNEL_BASE;
delete process.env.IB_ECONOMY_CHANNEL_SOURCE_PORT;

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^\uFEFF/, '');
const browserPlanSrc = read('assets/js/active-diary/active-plans.js');
const activeDiarySrc = read('assets/js/active-diary.js');

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) { console.log('  \u2714 ' + name); return true; }
  failures += 1;
  console.log('  \u2716 ' + name + (extra === undefined ? '' : ' \u2014 ' + JSON.stringify(extra)));
  return false;
}
function section(title) { console.log('\n\u2500\u2500 ' + title); }

/* 剥注释与字符串字面量：本仓库既有纪律（test_p22_1 / test_p22_10 / P22-11 同款）。
   理由在本阶段格外具体：解释"模型不得输出 price"的那句注释**必须**能提到
   price，否则最坏的结果是让人删掉解释。 */
function stripCommentsAndStrings(src) {
  return String(src)
    .replace(/\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+\/[gimsuy]*/g, ' RE ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1')
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^\\"\n])*"/g, ' "" ')
    .replace(/`(?:\\.|[^\\`])*`/g, ' `` ');
}
const browserPlanCode = stripCommentsAndStrings(browserPlanSrc);
const activeDiaryCode = stripCommentsAndStrings(activeDiarySrc);

/* ── 依赖：真实 Node 侧组合根（require.main guard 保证它不 listen）───── */
const SERVICE = require('../services/active-message-service.js');
const planDomain = require('../active/plan-domain.js')({
  getState: () => SERVICE.getState(), armedUsers: new Set(), saveNow: () => { }
});
const createActiveHttp = require('../active/http.js');
const createActiveEconomyChannelClient = require('../active/economy-channel-client.js');
const CHANNEL = require('../services/home-node/economy-command-channel.js');
const ECON = require('../services/home-node/economy-contract.js');

const ACTION = 'economy_propose_purchase';
const AGENT = 'cfg_agent';
const TOKEN = 'p22-12-test-source-token';
const PRODUCT = 'econ_prod_p22_12_compute';
const COMPANION_PORT = 23114;   /* 与 active-diary.js 的 ACTIVE_COMPANION_URL 同值 */

const config = ECON.CONFIG || null;
void config;

/* ══════════════════════════════════════════════════════════════════
   in-process 的真实 23114：**真实的** active/http.js 工厂
   ══════════════════════════════════════════════════════════════════ */
function buildCompanion(options) {
  options = options || {};
  const outbound = [];
  const channel = options.channel === true ? createActiveEconomyChannelClient({
    token: TOKEN,
    base: 'http://127.0.0.1:23118',
    fetch: async (url, init) => {
      outbound.push({ url: String(url), init: init });
      const body = JSON.stringify({
        ok: true, source: ECON.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME,
        result: { intentId: 'econ_agentintent_p22_12' }
      });
      return { ok: true, status: 200, text: async () => body };
    }
  }) : null;
  const layer = createActiveHttp({
    HOST: '127.0.0.1', PORT: COMPANION_PORT, maxBody: 4 * 1024 * 1024,
    getState: () => SERVICE.getState(), armedUsers: new Set(), saveNow: () => { },
    publicPlan: planDomain.publicPlan, sanitizeAiPlan: planDomain.sanitizeAiPlan,
    buildTaskReplacement: planDomain.buildTaskReplacement, recordUserId: planDomain.recordUserId,
    trimText: planDomain.trimText, deepClone: planDomain.deepClone, finiteTimestamp: planDomain.finiteTimestamp,
    sanitizeMomentSchedule: SERVICE.sanitizeMomentSchedule,
    publicMomentSchedule: SERVICE.publicMomentSchedule,
    proactiveTrace: SERVICE.proactiveTrace, credentialVault: SERVICE.credentialVault,
    /* ★ 与 services/active-message-service.js 里那一行的表达式**逐字同款**：
       同一个通道客户端、同一个方法、同一个身份传递（P22-12）。 */
    economyPropose: channel
      ? input => channel.proposePurchase({
        proposal: input.proposal,
        commandId: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey
      })
      : undefined,
    sanitizeEconomyProposal: SERVICE.sanitizeActiveEconomyProposal
  });
  return { server: layer.server, outbound: outbound, channel: channel };
}

const closables = [];
const tempDirs = [STATE_DIR];
function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      closables.push(server);
      resolve(server.address().port);
    });
  });
}

/* ══════════════════════════════════════════════════════════════════
   浏览器沙箱：加载**真实文件**（目录顺序与 InternalBeyond.html 一致）
   ══════════════════════════════════════════════════════════════════ */
function makeSandbox(options) {
  options = options || {};
  const records = [];
  const store = {};
  const modelReplies = options.modelReplies ? options.modelReplies.slice() : [];
  const sandbox = {
    console: { log() { }, info() { }, warn() { }, error() { }, debug() { } },
    /* ★ 沙箱里的定时器一律 unref：沙箱只是为了把真实文件跑起来，它自己的
       心跳不该让测试进程活着（本文件必须能自己退出，而不是靠 process.exit
       去截断还没 flush 的输出）。 */
    setTimeout: function (fn, ms) { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearTimeout, setInterval: function (fn, ms) { const t = setInterval(fn, ms); if (t && t.unref) t.unref(); return t; },
    clearInterval, queueMicrotask,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, TypeError,
    Map, Set, WeakMap, Promise, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, Intl, AbortController,
    Uint8Array, ArrayBuffer, TextDecoder, TextEncoder,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; }
    },
    document: {
      addEventListener() { }, removeEventListener() { },
      getElementById() { return null; }, querySelector() { return null; },
      querySelectorAll() { return []; }, body: {}, readyState: 'complete'
    },
    navigator: { userAgent: 'node-test', language: 'zh-CN' },
    location: { href: 'http://127.0.0.1/', protocol: 'http:', reload() { } },
    addEventListener() { }, removeEventListener() { },
    currentPage: 'active',
    apiConfigs: [{ id: AGENT, provider: 'custom', model: 'm', endpoint: 'http://127.0.0.1:1/v1', apiKey: 'k' }],
    _cachedUserName: 'User',
    dbGet: async () => null,
    dbPut: async () => null,
    dbGetAll: async () => [],
    dbGetByIndex: async () => [],
    dbDelete: async () => null,
    _ibApiReady: () => true,
    isMemoryVisibleTo: () => true,
    _calcRelevance: () => 0,
    _extractKeywords: () => [],
    toast() { }, ibActiveLive() { },
    IBERR: { err: m => new Error(m), report: () => null, show() { } },
    /* 模型：返回脚本化的模型输出（本阶段要证的正是"模型输出去哪了"）。 */
    callApiChat: async () => (modelReplies.length ? modelReplies.shift() : '{}'),
    /* 唯一的网络替身：见文件头。 */
    fetch: async function (url, init) {
      const target = String(url);
      records.push({ url: target, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body });
      const parsed = new URL(target);
      const forwarded = 'http://127.0.0.1:' + options.companionPort + parsed.pathname + parsed.search;
      const res = await fetch(forwarded, { method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body: init && init.body });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text: async () => text };
    },
    module: undefined, exports: undefined, require: undefined
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(new Proxy(sandbox, {
    has: () => true,
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'symbol') return undefined;
      return function () { };
    }
  }));
  const loaded = [];
  let loadError = '';
  for (const f of ['assets/js/ib-namespace.js', 'assets/js/home-node-client.js',
    'assets/js/active-diary/active-plans.js', 'assets/js/active-diary.js']) {
    try { vm.runInContext(read(f), ctx, { filename: path.basename(f) }); loaded.push(f); }
    catch (e) { loadError = f + ': ' + String((e && e.message) || e); break; }
  }
  return { sandbox: sandbox, IB: sandbox.IB, records: records, loaded: loaded, loadError: loadError, modelReplies: modelReplies };
}

function basePromptArgs(economyCatalog) {
  const args = {
    character: { id: AGENT, nickname: 'Aria', systemPrompt: '你是 Aria。', relationship: '朋友' },
    user: { name: 'User' }, memories: [], recentMessages: [], recentProactiveMessages: [],
    currentTime: new Date('2026-09-16T12:00:00Z'), chatSummary: '', prefs: {}
  };
  if (economyCatalog !== undefined) args.economyCatalog = economyCatalog;
  return args;
}
/* 服务端那份**完整**商品序列化（含价格 / 币种 / 发放数量）+ 一个只有
   目录事实的投影 —— 两者都喂进 prompt 构建器，看它留下什么。 */
const SERVER_PRODUCT = {
  domain: 'economy', productId: PRODUCT, storeId: 'econ_store_x', kind: 'COMPUTE_ENTITLEMENT',
  fulfillment: 'GRANT_INVENTORY', name: 'Internal Compute Entitlement', description: 'IB 内部算力额度',
  currency: 'IB_CREDIT', unitPriceMinor: '1250', unitName: 'unit', grantQuantity: 5000,
  assetKind: 'COMPUTE_ENTITLEMENT', status: 'active', revision: 3,
  createdAt: 1, updatedAt: 2, pricingIsRelationshipFree: true, holdsOwnership: false,
  grantsInventory: true, hasDiscount: false, hasRecommendation: false
};

(async function main() {

  /* ══════════════════════════════════════════════════════════════ */
  section('S · 真实文件在沙箱里加载 + 真实 23114 在进程内 listen');
  /* ══════════════════════════════════════════════════════════════ */

  const companion = buildCompanion({});
  const companionPort = await listen(companion.server);
  /* ★ 第二个 in-process 23114：**配好了通道**的那一个（economyPropose 注入
     存在）。section C 用它，因为"真实 producer 到达 P22-11 client seam"
     只在一个真的接了通道的部署上才有意义。 */
  const wired = buildCompanion({ channel: true });
  const wiredPort = await listen(wired.server);
  const sandbox = makeSandbox({ companionPort: companionPort });
  const IB = sandbox.IB;
  const PLANS = IB && IB.active && IB.active.plans;

  check('S1 四个真实浏览器文件全部求值成功（目录顺序与 InternalBeyond.html 一致）',
    sandbox.loaded.length === 4, sandbox.loadError || sandbox.loaded);
  check('S2 真实的 prompt 构建器与真实的净化器都在（不是本文件里的复制品）',
    typeof sandbox.sandbox.buildPlanPrompt === 'function' &&
    typeof sandbox.sandbox._activeValidatePlanResult === 'function' &&
    typeof PLANS._activeValidateEconomyProposal === 'function');
  check('S3 真实的生产者入口与真实的出口都在',
    typeof sandbox.sandbox.planNextProactiveMessage === 'function' &&
    typeof IB.activeEconomyProposalSink === 'function');
  check('S4 ★★ 闸门的默认值是 false（模型默认不被告知可以提议购买）',
    IB.activeEconomyProposalEnabled === undefined && PLANS._activeEconomyProposalAllowed() === false,
    IB.activeEconomyProposalEnabled);
  check('S5 ★★ 真实 23114 的路线图里确实有那条出口路由，且它先过净化器再交给通道客户端',
    /url\.pathname === '\/economy\/propose-purchase'/.test(read('active/http.js')) &&
    read('active/http.js').indexOf('sanitizeEconomyProposal(raw)') > 0);

  /* companion 未注入通道 ⇒ /health 的字段必须是 false */
  const healthOff = await (await fetch('http://127.0.0.1:' + companionPort + '/health')).json();
  check('S6 未配通道的 23114：/health 的 economy_proposals_enabled === false（而且这个字段只回答这一件事）',
    healthOff.economy_proposals_enabled === false &&
    healthOff.ok === true && healthOff.service === 'internal-beyond-active-messages',
    healthOff);
  check('S7 ★ /health 里**没有**任何权威事实（余额 / 预算 / 批准 / 账本 / 门）',
    Object.keys(healthOff).every(k => !/balance|budget|approv|ledger|capabilit|wallet|gate/i.test(k)),
    Object.keys(healthOff));

  /* ══════════════════════════════════════════════════════════════ */
  section('A · 模型真的被告知可以提出 —— 而且只在真的可以时');
  /* ══════════════════════════════════════════════════════════════ */

  IB.activeEconomyProposalEnabled = false;
  const promptOff = sandbox.sandbox.buildPlanPrompt(basePromptArgs([SERVER_PRODUCT]));
  check('A1 ★★ 闸门为 false 时，prompt 里**连动作名都不出现**（P22-11 的默认姿态逐字保留）',
    promptOff.prompt.indexOf(ACTION) < 0 && promptOff.prompt.indexOf('【关于提议购买') < 0);
  check('A2 闸门为 false 时，既有三个动作逐字仍在（封闭集没有被本阶段改动）',
    promptOff.prompt.indexOf('"action":"schedule"') > 0 &&
    promptOff.prompt.indexOf('"action":"none"') > 0 &&
    promptOff.prompt.indexOf('"action":"cancel_existing"') > 0);

  IB.activeEconomyProposalEnabled = true;
  const promptOn = sandbox.sandbox.buildPlanPrompt(basePromptArgs([SERVER_PRODUCT]));
  check('A3 ★★ 闸门为 true 且有目录事实时，prompt 真的宣告了 ' + ACTION,
    promptOn.prompt.indexOf(ACTION) > 0 && promptOn.prompt.indexOf('【关于提议购买') > 0);
  check('A4 ★★ 宣告用的是仓库冻结的拼写，且只宣告了这一个经济动作（没有通用 economy(method,args)）',
    promptOn.prompt.indexOf(ACTION) >= 0 &&
    promptOn.prompt.indexOf('econonomy') < 0 &&
    promptOn.prompt.indexOf('"action":"economy"') < 0 &&
    promptOn.prompt.indexOf('"method"') < 0);
  check('A5 ★★ `none` 仍是一等输出：它既在动作清单里，也在经济段里被明确写成正常决定',
    promptOn.prompt.indexOf('"action":"none"') > 0 &&
    promptOn.prompt.indexOf('"none" 是完全正确、完全正常的决定') > 0);
  check('A6 ★★ 目录为空时**不宣告**（没有 productId 可选的"可以购买"只会让模型编造商品）',
    sandbox.sandbox.buildPlanPrompt(basePromptArgs([])).prompt.indexOf(ACTION) < 0 &&
    sandbox.sandbox.buildPlanPrompt(basePromptArgs(undefined)).prompt.indexOf(ACTION) < 0);

  /* ── §3 · 只给语义，不给 authority ───────────────────────────── */
  const FORBIDDEN_PROMPT_PHRASES = [
    '你有权购买', '你可以花', '余额足够就买', '预算允许', '用户已经批准', '可以自动结算',
    '有钱就花', '定期消费', '为了体验经济系统而购物', '尽量使用预算', '你应该消费',
    '多使用经济系统', '余额充足就可以买', '无需批准'
  ];
  const leaked = FORBIDDEN_PROMPT_PHRASES.filter(p => promptOn.prompt.indexOf(p) >= 0);
  check('A7 ★★ prompt 里没有任何"你有权 / 有钱就花 / 预算允许 / 已批准 / 自动结算"式的授权或激励语言',
    leaked.length === 0, leaked);
  check('A8 ★★ 反过来说，它明确写了"提出 ≠ 获准"，并且把 MAY 全部推给内部经济层',
    promptOn.prompt.indexOf('提出购买**不等于**获准购买') > 0 &&
    promptOn.prompt.indexOf('全部由内部经济层决定') > 0);
  check('A9 ★★ 模型不拥有 Budget / Autonomy / Approval authority（prompt 逐条点名）',
    promptOn.prompt.indexOf('没有预算权') > 0 && promptOn.prompt.indexOf('没有批准权') > 0 &&
    promptOn.prompt.indexOf('内部审批层决定') > 0);
  check('A10 ★ §9 · 目录事实注入，且价格 / 币种 / 发放数量 / 余额一个都没进 prompt',
    promptOn.prompt.indexOf(PRODUCT) > 0 &&
    promptOn.prompt.indexOf('Internal Compute Entitlement') > 0 &&
    promptOn.prompt.indexOf('1250') < 0 && promptOn.prompt.indexOf('IB_CREDIT') < 0 &&
    promptOn.prompt.indexOf('5000') < 0 && promptOn.prompt.indexOf('unitPriceMinor') < 0 &&
    promptOn.prompt.indexOf('currency') < 0);
  check('A11 ★★ 目录投影是**构造式白名单**：注入一个塞满额外经济字段的对象，结果里只剩六个键',
    JSON.stringify(PLANS._activeEconomyCatalogFacts([SERVER_PRODUCT])) ===
    JSON.stringify([{ productId: PRODUCT, name: 'Internal Compute Entitlement', description: 'IB 内部算力额度', kind: 'COMPUTE_ENTITLEMENT', unitName: 'unit', status: 'active' }]),
    PLANS._activeEconomyCatalogFacts([SERVER_PRODUCT]));
  check('A12 目录投影的有界性：上限条数 + 畸形条目直接丢弃（不猜修复）',
    PLANS._activeEconomyCatalogFacts(new Array(50).fill(SERVER_PRODUCT)).length === PLANS.ACTIVE_ECONOMY_CATALOG_MAX_ITEMS &&
    PLANS._activeEconomyCatalogFacts([null, {}, { productId: '' }, 'x']).length === 0);
  check('A13 ★ §7 · prompt 明确"内部 entitlement"，并逐句否掉 Provider 充值 / 真实 token / Provider 计费',
    promptOn.prompt.indexOf('内部 entitlement') > 0 &&
    promptOn.prompt.indexOf('不是给任何外部 Provider 充值') > 0 &&
    promptOn.prompt.indexOf('不是购买真实 token') > 0 &&
    promptOn.prompt.indexOf('不会调用任何 Provider 的计费') > 0);
  check('A14 ★ §8 · 送礼只表达"想送什么给谁"，并且明确否掉"关系好所以不用批准"',
    promptOn.prompt.indexOf('想送什么、给谁') > 0 &&
    promptOn.prompt.indexOf('因为关系好所以不用批准') > 0 &&
    promptOn.prompt.indexOf('完全由内部审批层决定') > 0);
  check('A15 ★ §4 · prompt 明确列出模型**不能**写的经济事实（价 格 / 金额 / 币种 / 余额 / 预算结果 / 批准状态 / 结算方式）',
    promptOn.prompt.indexOf('不要**写出价格、金额、币种、余额、预算结果、批准状态或结算方式') > 0);
  check('A16 ★ §4 · prompt 明确"身份由运行环境填写，你不要写"（agentId 不由模型自报）',
    promptOn.prompt.indexOf('谁在买（身份）由运行环境填写，你不要写') > 0);
  check('A17 ★ §6 · prompt 给出的"可以提议"的语义理由只有"确实需要"，没有关系 / 情绪理由',
    promptOn.prompt.indexOf('确实需要') > 0 &&
    promptOn.prompt.indexOf('为了提高好感度或亲密度而提出购买') > 0);
  check('A18 ★★ prompt 里**没有**任何一条经济 authority 数据面（余额值 / 预算结果 / 批准 id / 账本 / 内部结算原语）',
    !/approvalId|settlementType|ledger|budgetResult|walletBalance|autoAllow/.test(promptOn.prompt) &&
    promptOn.prompt.indexOf('"approved"') < 0);

  /* ══════════════════════════════════════════════════════════════ */
  section('B · 净化器：模型只能选择意图字段');
  /* ══════════════════════════════════════════════════════════════ */

  const CTX = { agentId: AGENT };
  const V = raw => PLANS._activeValidatePlanResult(raw, Date.now(), {}, CTX);
  const rawOf = proposal => ({ action: ACTION, proposal: proposal, idempotencyKey: 'p22-12-key-1', reason: '为什么' });

  const good = V(rawOf({ productId: PRODUCT, units: 2, reason: '需要算力', recipientId: '' }));
  check('B1 ★★ 模型选出的四个意图字段 + 本地注入的身份 = 一条规范化提案',
    !!good && good.action === ACTION &&
    JSON.stringify(good.proposal) === JSON.stringify({ agentId: AGENT, productId: PRODUCT, units: 2, reason: '需要算力' }),
    good);
  check('B2 ★★ agentId 来自本地角色配置，**不是**模型输出：模型写了 agentId 会被白名单拒掉',
    V(rawOf({ productId: PRODUCT, agentId: 'character_someone_else' })) === null &&
    V(rawOf({ productId: PRODUCT })) !== null);
  check('B3 ★★ 注入上下文缺席时整条 fail closed（不替模型编一个身份）',
    PLANS._activeValidatePlanResult(rawOf({ productId: PRODUCT }), Date.now(), {}, null) === null &&
    PLANS._activeValidatePlanResult(rawOf({ productId: PRODUCT }), Date.now(), {}, {}) === null);

  const FACTS = ['price', 'amountMinor', 'currency', 'balance', 'walletBalance', 'budget',
    'budgetResult', 'approvalId', 'approved', 'autoAllow', 'settlementType', 'ledger',
    'grantQuantity', 'grantQuantityEconomic', 'consumerId', 'consumer', 'capability',
    'role', 'authority', 'unitsMinor', 'unitPriceMinor', 'purchasedQuantity'];
  const factAccepted = FACTS.filter(k => {
    const p = { productId: PRODUCT };
    p[k] = k === 'units' ? 1 : (k === 'grantQuantity' ? 5000 : 'x');
    return V(rawOf(p)) !== null;
  });
  check('B4 ★★★ §4 · 二十二个经济事实 / authority 键逐个被拒（模型偷渡不进去）',
    factAccepted.length === 0, factAccepted);
  check('B5 ★★ 顶层（动作对象上）偷渡同样被拒，而不只是 proposal 里',
    V({ action: ACTION, proposal: { productId: PRODUCT }, idempotencyKey: 'k', price: 1 }) === null &&
    V({ action: ACTION, proposal: { productId: PRODUCT }, idempotencyKey: 'k', approved: true }) === null);
  check('B6 ★★ 这是**白名单**而不是"把危险词列出来"：剥掉注释与字符串之后，净化器代码里一个经济事实键名都没有（`role` 除外 —— 它是聊天消息的既有属性 m.role，不是经济键，它的拒绝由 B4 逐条行为断言）',
    FACTS.filter(k => k !== 'role' && browserPlanCode.indexOf(k) >= 0).length === 0 &&
    browserPlanCode.indexOf('ACTIVE_ECONOMY_PROPOSAL_FIELDS') > 0 &&
    browserPlanCode.indexOf('ACTIVE_ECONOMY_ACTION_FIELDS') > 0,
    FACTS.filter(k => k !== 'role' && browserPlanCode.indexOf(k) >= 0));
  check('B7 ★★ 白名单恰好是 P22-8 的 PURCHASE_INTENT_PROPOSAL_KEYS 减去 agentId / expiresAt（不是第二份名单）',
    JSON.stringify(PLANS.ACTIVE_ECONOMY_PROPOSAL_FIELDS) ===
    JSON.stringify(ECON.PURCHASE_INTENT_PROPOSAL_KEYS.filter(k => k !== 'agentId' && k !== 'expiresAt')) &&
    PLANS.ACTIVE_ECONOMY_REASON_MAX === ECON.PURCHASE_INTENT_REASON_MAX,
    { browser: PLANS.ACTIVE_ECONOMY_PROPOSAL_FIELDS, contract: ECON.PURCHASE_INTENT_PROPOSAL_KEYS });

  const MALFORMED = [
    null, undefined, 42, 'buy it', [], { action: ACTION },
    { action: ACTION, proposal: null, idempotencyKey: 'k' },
    { action: ACTION, proposal: [], idempotencyKey: 'k' },
    { action: ACTION, proposal: 'buy', idempotencyKey: 'k' },
    { action: ACTION, proposal: { productId: '' }, idempotencyKey: 'k' },
    { action: ACTION, proposal: { productId: 42 }, idempotencyKey: 'k' },
    { action: ACTION, proposal: { productId: PRODUCT }, idempotencyKey: '' },
    { action: ACTION, proposal: { productId: PRODUCT }, idempotencyKey: '   ' },
    { action: ACTION, proposal: { productId: PRODUCT, units: '2' }, idempotencyKey: 'k' },
    { action: ACTION, proposal: { productId: PRODUCT, units: 0 }, idempotencyKey: 'k' },
    { action: ACTION, proposal: { productId: PRODUCT, units: 1.5 }, idempotencyKey: 'k' },
    { action: ACTION, proposal: { productId: PRODUCT, reason: 42 }, idempotencyKey: 'k' }
  ];
  check('B8 ★★ 畸形模型输出一律 fail closed（不猜修复：`"2"` 不会被解析成 2）',
    MALFORMED.every(r => V(r) === null),
    MALFORMED.map(r => V(r)));

  const BANNED_ACTIONS = ['buy', 'settle', 'reserve', 'approve', 'resume', 'grant',
    'ledger', 'wallet_mutate', 'auto_allow', 'economy', 'purchase', 'checkout', 'topup'];
  const bannedAccepted = BANNED_ACTIONS.filter(a => V({ action: a, proposal: { productId: PRODUCT }, idempotencyKey: 'k' }) !== null);
  check('B9 ★★★ §2 · 十三个禁止的动作名（含通用 economy(method,args) 与全部大写变体）逐个 fail closed',
    bannedAccepted.length === 0 &&
    BANNED_ACTIONS.every(a => V({ action: a.toUpperCase(), proposal: { productId: PRODUCT }, idempotencyKey: 'k' }) === null),
    bannedAccepted);
  check('B10 ★★ 封闭动作集逐字未变，且它仍然不认识任何经济动词（P22-10 的 B2 断言继续为真）',
    browserPlanSrc.indexOf("['schedule','none','cancel_existing']") > 0 &&
    browserPlanCode.indexOf('ACTIONS_WITH_ECONOMY') < 0 &&
    browserPlanSrc.indexOf('function _activeValidatePlanResultCore(') > 0);
  check('B11 ★ 净化器不做大小写折叠式的猜测修复：大写变体是未知动作；前导空格的 trim 是**既有**动作分派的行为（P22-11 逐字保留），不是本阶段新加',
    V({ action: ACTION.toUpperCase(), proposal: { productId: PRODUCT }, idempotencyKey: 'k' }) === null &&
    V({ action: ACTION + ' ', proposal: { productId: PRODUCT }, idempotencyKey: 'k' }) !== null &&
    browserPlanSrc.indexOf("String(raw.action||'').trim()") > 0);
  check('B12 ★★ §5 · `none` 仍然是一等正常输出（净化后不是 null，也不会走到任何经济出口）',
    JSON.stringify(V({ action: 'none', reason: '现在没有理由' })) ===
    JSON.stringify({ action: 'none', reason: '现在没有理由' }));
  check('B13 既有 schedule 路径逐字可用（本阶段没有把第四个成员塞进封闭集）',
    !!V({ action: 'schedule', scheduledAt: new Date(Date.now() + 3600000).toISOString(), intent: '问候' }));

  /* ── 浏览器净化器 × companion 镜像：等价矩阵 ──────────────────── */
  const mirror = SERVICE.sanitizeActiveEconomyProposal;
  const EQUIV = [
    { proposal: { productId: PRODUCT, units: 1, reason: 'r' }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, recipientId: 'cfg_b', units: 2 }, idempotencyKey: 'k' },
    { proposal: { productId: '' }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, units: '2' }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, units: 0 }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, reason: 42 }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, price: 1 }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, approved: true }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, consumerId: 'x' }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, capability: 'x' }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT, ledger: 'x' }, idempotencyKey: 'k' },
    { proposal: { productId: PRODUCT }, idempotencyKey: '' },
    { proposal: { productId: PRODUCT, recipientId: '  ' }, idempotencyKey: 'k' },
    { proposal: 'buy', idempotencyKey: 'k' },
    { proposal: [], idempotencyKey: 'k' }
  ];
  const disagreements = EQUIV.filter(raw => {
    /* ★ 喂给镜像的是**生产者实际会送出的那份形状**：模型选出的字段 +
       运行环境附上的身份。这正是"同一个模型输出在两条边界上得到同一个
       结论"的正确比较对象（两份名单的差集恰好是 agentId，见 B15）。 */
    const wire = Object.assign({ agentId: AGENT }, raw.proposal);
    const a = mirror({ action: ACTION, proposal: wire, idempotencyKey: raw.idempotencyKey }) !== null;
    const b = PLANS._activeValidateEconomyProposal({ action: ACTION, proposal: raw.proposal, idempotencyKey: raw.idempotencyKey }) !== null;
    return a !== b;
  });
  check('B14 ★★ 两层净化器在**十五种**输入上给出逐条相同的接受/拒绝（它们不是两份会漂移的白名单）',
    disagreements.length === 0, disagreements);
  check('B15 ★★★ 两份名单的差集**恰好**是 [agentId]，而且方向是对的：模型不许自报、生产者必须附上',
    JSON.stringify(SERVICE.ACTIVE_ECONOMY_WIRE_FIELDS.filter(k => PLANS.ACTIVE_ECONOMY_PROPOSAL_FIELDS.indexOf(k) < 0)) === JSON.stringify(['agentId']) &&
    PLANS.ACTIVE_ECONOMY_PROPOSAL_FIELDS.every(k => SERVICE.ACTIVE_ECONOMY_WIRE_FIELDS.indexOf(k) >= 0) &&
    PLANS._activeValidateEconomyProposal({ action: ACTION, proposal: { productId: PRODUCT, agentId: AGENT }, idempotencyKey: 'k' }) === null &&
    mirror({ action: ACTION, proposal: { productId: PRODUCT, agentId: AGENT }, idempotencyKey: 'k' }) !== null);
  check('B16 ★★ 镜像这一层是**投影**而不是拒绝非身份键：顶层多出来的键被丢掉，绝不进通道 payload（它不裁决，只转发 {proposal, idempotencyKey}）',
    (function () {
      const out = mirror({ action: ACTION, proposal: { productId: PRODUCT, agentId: AGENT }, idempotencyKey: 'k', price: 1, command: 'ECONOMY_BUY' });
      return !!out && Object.keys(out).sort().join(',') === 'idempotencyKey,proposal' &&
        JSON.stringify(out).indexOf('price') < 0 &&
        JSON.stringify(out).indexOf('ECONOMY_BUY') < 0;
    })());
  check('B16b ★★★ 而**身份自报键**在任何一层都是硬拒 —— 包括顶层（P22-11 的不变量逐字保留）',
    mirror({ action: ACTION, proposal: { productId: PRODUCT, agentId: AGENT }, idempotencyKey: 'k', approved: true }) === null &&
    mirror({ action: ACTION, proposal: { productId: PRODUCT, agentId: AGENT }, idempotencyKey: 'k', autoAllow: true }) === null &&
    mirror({ action: ACTION, proposal: { productId: PRODUCT, agentId: AGENT, consumerId: 'x' }, idempotencyKey: 'k' }) === null);
  check('B17 ★★★ 而"模型写了不该写的东西"在**模型边界**上必须被拒（不是被悄悄丢掉）：同一个顶层偷渡在浏览器那侧是 fail closed',
    PLANS._activeValidateEconomyProposal({ action: ACTION, proposal: { productId: PRODUCT }, idempotencyKey: 'k', price: 1 }) === null &&
    PLANS._activeValidateEconomyProposal({ action: ACTION, proposal: { productId: PRODUCT }, idempotencyKey: 'k', group: 'x' }) === null);

  /* ══════════════════════════════════════════════════════════════ */
  section('C · 真实生产者：模型输出真的到达 P22-11 client seam');
  /* ══════════════════════════════════════════════════════════════ */

  const MODEL_JSON = JSON.stringify({
    action: ACTION,
    proposal: { productId: PRODUCT, units: 1, reason: '当前任务需要这份内部算力' },
    idempotencyKey: 'p22-12-stable-key-1',
    reason: '任务确实需要'
  });
  IB.activeEconomyProposalEnabled = true;
  IB.activeEconomyCatalogProvider = () => [SERVER_PRODUCT];
  const producerReplies = [MODEL_JSON, MODEL_JSON, MODEL_JSON];
  const prod = makeSandbox({ companionPort: wiredPort, modelReplies: producerReplies });
  prod.IB.activeEconomyProposalEnabled = true;
  prod.IB.activeEconomyCatalogProvider = () => [SERVER_PRODUCT];

  const outcome = await prod.sandbox.planNextProactiveMessage({
    character: prod.sandbox.apiConfigs[0], conversation: AGENT,
    userMessage: { content: '帮我看看' }, assistantMessage: { content: '好的' },
    userMessageId: 'm1', assistantMessageId: 'm2'
  });
  const proposals = prod.records.filter(r => r.url.indexOf('/economy/propose-purchase') >= 0);
  check('C1 ★★★ 真实生产者入口把模型的输出真的发出去了（一次 POST，目标就是 23114 的那条路由）',
    proposals.length === 1 &&
    proposals[0].url === 'http://127.0.0.1:23114/economy/propose-purchase' &&
    proposals[0].method === 'POST',
    prod.records.map(r => r.method + ' ' + r.url));
  const sentBody = proposals.length ? JSON.parse(proposals[0].body) : null;
  check('C2 ★★ payload 只含净化后的意图 + 本地身份，一个经济事实都没有',
    !!sentBody && Object.keys(sentBody).sort().join(',') === 'idempotencyKey,proposal' &&
    Object.keys(sentBody.proposal).sort().join(',') === 'agentId,productId,reason,units' &&
    sentBody.proposal.agentId === AGENT && sentBody.proposal.productId === PRODUCT,
    sentBody);
  check('C3 ★★ 结果如实回传：delivery=DELIVERED、intentCreated 是下游给的 id，而**不是**"购买成功"',
    !!outcome && outcome.ok === true && outcome.delivery === 'DELIVERED' &&
    outcome.intentCreated === 'econ_agentintent_p22_12' &&
    outcome.purchaseFailed === false && outcome.purchaseDenied === false &&
    outcome.transportIsNotAnEconomyAuthority === true,
    outcome);
  check('C4 ★★ 23114 收到的正是浏览器发的那条 body（真实路由 + 真实净化器 + 真实通道客户端都跑过了）',
    wired.outbound.length === 1 &&
    wired.outbound[0].url === 'http://127.0.0.1:23118' + CHANNEL.COMMAND_PATH,
    wired.outbound.map(o => o.url));
  const outboundInit = wired.outbound.length ? wired.outbound[0].init : null;
  check('C5 ★★★ outbound 请求带的是 P22-11 的来源凭据头，而请求体里**没有**身份自报',
    !!outboundInit &&
    outboundInit.headers['X-IB-Economy-Channel-Source'] === TOKEN &&
    outboundInit.headers['X-IB-Protocol'] === '1' &&
    outboundInit.method === 'POST',
    outboundInit && outboundInit.headers);
  const outboundBody = outboundInit ? JSON.parse(outboundInit.body) : null;
  check('C6 ★★★ 通道上的 command 就是唯一那一个，payload 里没有 consumerId / capability / 价格',
    !!outboundBody && outboundBody.command === 'ECONOMY_PROPOSE_PURCHASE' &&
    typeof outboundBody.commandId === 'string' && outboundBody.commandId.length > 0 &&
    JSON.stringify(outboundBody).indexOf('consumerId') < 0 &&
    JSON.stringify(outboundBody).indexOf('capability') < 0 &&
    JSON.stringify(outboundBody).indexOf('price') < 0,
    outboundBody);
  check('C6b ★★★ canonical 身份一路上到传输层（而不是被通道新生成一个）：命令身份 = 生产者从指纹字段推导的那一个',
    !!outboundBody &&
    outboundBody.commandId === 'p22-12.' + AGENT + '.' + PRODUCT + '.self.1' &&
    outboundBody.idempotencyKey === outboundBody.commandId &&
    PLANS._activeEconomyIdempotencyKey(sentBody.proposal) === outboundBody.commandId,
    outboundBody && outboundBody.commandId);
  check('C6c ★★ 模型自己写的那个 key **不**上路（它只是旁证）；而上路的那个满足 P22-8 的 IDEMPOTENCY_KEY_RE',
    typeof outboundBody.idempotencyKey === 'string' &&
    /^[A-Za-z0-9_.:+-]{1,200}$/.test(outboundBody.idempotencyKey) &&
    outboundBody.idempotencyKey !== 'p22-12-stable-key-1' &&
    JSON.stringify(outboundBody).indexOf('p22-12-stable-key-1') < 0);
  check('C7 ★★ §10 · 同一条模型输出再跑一次不会形成第二次购买（生产者层的轻量约束先收敛）',
    (await prod.sandbox.planNextProactiveMessage({
      character: prod.sandbox.apiConfigs[0], conversation: AGENT,
      userMessage: { content: '帮我看看' }, assistantMessage: { content: '好的' },
      userMessageId: 'm3', assistantMessageId: 'm4'
    })) === null &&
    prod.records.filter(r => r.url.indexOf('/economy/propose-purchase') >= 0).length === 1);
  check('C8 ★★★ 而这一层不是权威：同一身份 + 同一 idempotencyKey 会算成**同一条**逻辑 Intent（P22-8 的指纹字段一个不差）',
    JSON.stringify(PLANS._activeEconomyProposalIdentity({ agentId: AGENT, productId: PRODUCT, units: 1 })) ===
    JSON.stringify(PLANS._activeEconomyProposalIdentity({ agentId: AGENT, productId: PRODUCT, units: 1 })) &&
    PLANS.ACTIVE_ECONOMY_REPROPOSE_WINDOW_MS === ECON.PURCHASE_INTENT_DEDUPE_WINDOW_MS &&
    browserPlanCode.indexOf('PURCHASE_INTENT_DEDUPE_WINDOW_MS') < 0,
    PLANS.ACTIVE_ECONOMY_REPROPOSE_WINDOW_MS);
  check('C9 ★★ 生产者层的抑制表是**有界**的（不会变成一个无限增长的第二套去重状态）',
    PLANS.ACTIVE_ECONOMY_REPROPOSE_MAX_ENTRIES > 0 &&
    PLANS.ACTIVE_ECONOMY_REPROPOSE_MAX_ENTRIES <= 1024 &&
    browserPlanCode.indexOf('ACTIVE_ECONOMY_REPROPOSE_WINDOW_MS') > 0);

  /* ── 闸门：由真实 /health 驱动 ─────────────────────────────────── */
  const gated = makeSandbox({ companionPort: companionPort });
  gated.IB.activeEconomyProposalEnabled = false;
  const online = await gated.sandbox._activeCheckCompanion(false, true);
  check('C10 ★★ 通道未配置的部署：真实的 health 往返把闸门留在 false（模型那边什么都不变）',
    online === true && gated.IB.activeEconomyProposalEnabled === false);

  const healthOn = await (await fetch('http://127.0.0.1:' + wiredPort + '/health')).json();
  check('C11 ★★ 配好通道的部署：/health 的 economy_proposals_enabled === true（同一个布尔，来自同一个注入点）',
    healthOn.economy_proposals_enabled === true);
  const gated2 = makeSandbox({ companionPort: wiredPort });
  gated2.IB.activeEconomyProposalEnabled = false;
  await gated2.sandbox._activeCheckCompanion(false, true);
  check('C12 ★★★ 闸门真的由 health 置位：同一个真实往返在配好通道的部署上把闸门打开',
    gated2.IB.activeEconomyProposalEnabled === true);
  check('C13 ★★ 服务不可达时闸门立刻收敛回 false（不是"上一轮说 true 就一直 true"）',
    (function () {
      gated2.IB.activeEconomyProposalEnabled = true;
      gated2.sandbox._activeSetServiceStatus(false);
      return gated2.IB.activeEconomyProposalEnabled === false;
    })());

  /* ══════════════════════════════════════════════════════════════ */
  section('D · Gift / compute / none 的真实路径');
  /* ══════════════════════════════════════════════════════════════ */

  const gift = V(rawOf({ productId: PRODUCT, recipientId: 'cfg_friend', units: 1, reason: '想送给他' }));
  check('D1 ★★ §8 · 送礼只是一条 proposal（收件人 + 商品 + 理由），没有任何"因为关系好所以不用批准"的字段',
    !!gift && gift.proposal.recipientId === 'cfg_friend' &&
    Object.keys(gift.proposal).sort().join(',') === 'agentId,productId,reason,recipientId,units' &&
    browserPlanCode.indexOf('skipApproval') < 0 && browserPlanCode.indexOf('relationshipBypass') < 0);
  check('D2 ★★ §7 · compute 提案里唯一的"额度"就是内部 entitlement 商品本身，Producer 不产出任何 quota 语义',
    browserPlanCode.indexOf('quota') < 0 && browserPlanCode.indexOf('recharge') < 0 &&
    browserPlanCode.indexOf('providerBilling') < 0 && browserPlanCode.indexOf('topup') < 0);

  const noneReplies = makeSandbox({ companionPort: wiredPort, modelReplies: [JSON.stringify({ action: 'none', reason: '没有自然理由' })] });
  noneReplies.IB.activeEconomyProposalEnabled = true;
  noneReplies.IB.activeEconomyCatalogProvider = () => [SERVER_PRODUCT];
  const noneOutcome = await noneReplies.sandbox.planNextProactiveMessage({
    character: noneReplies.sandbox.apiConfigs[0], conversation: AGENT,
    userMessage: { content: '晚安' }, assistantMessage: { content: '晚安' },
    userMessageId: 'n1', assistantMessageId: 'n2'
  });
  check('D3 ★★★ `none` 走完整条真实链之后：返回 null、零次经济请求、一个字都没发出去',
    noneOutcome === null &&
    noneReplies.records.filter(r => r.url.indexOf('propose-purchase') >= 0).length === 0,
    noneReplies.records.map(r => r.url));

  /* ══════════════════════════════════════════════════════════════ */
  section('E · §12 Failure semantics：未知 ≠ 购买失败，且没有重试');
  /* ══════════════════════════════════════════════════════════════ */

  /* ① 模型输出 malformed */
  const malformed = makeSandbox({ companionPort: wiredPort, modelReplies: ['not json at all', '{oops'] });
  malformed.IB.activeEconomyProposalEnabled = true;
  malformed.IB.activeEconomyCatalogProvider = () => [SERVER_PRODUCT];
  const malformedOutcome = await malformed.sandbox.planNextProactiveMessage({
    character: malformed.sandbox.apiConfigs[0], conversation: AGENT,
    userMessage: { content: 'x' }, assistantMessage: { content: 'y' },
    userMessageId: 'e1', assistantMessageId: 'e2'
  });
  check('E1 ★★ malformed 模型输出：返回 null，零请求，零重试',
    malformedOutcome === null &&
    malformed.records.filter(r => r.url.indexOf('propose-purchase') >= 0).length === 0);

  /* ② 未知商品 / 偷渡经济事实：模型说了一件非法的事 —— 净化器在触到传输之前就拦下 */
  const illegal = makeSandbox({ companionPort: wiredPort, modelReplies: [
    JSON.stringify({ action: ACTION, proposal: { productId: PRODUCT, price: 1 }, idempotencyKey: 'k' })
  ] });
  illegal.IB.activeEconomyProposalEnabled = true;
  illegal.IB.activeEconomyCatalogProvider = () => [SERVER_PRODUCT];
  const illegalOutcome = await illegal.sandbox.planNextProactiveMessage({
    character: illegal.sandbox.apiConfigs[0], conversation: AGENT,
    userMessage: { content: 'x' }, assistantMessage: { content: 'y' },
    userMessageId: 'e3', assistantMessageId: 'e4'
  });
  check('E2 ★★★ 偷渡价格：净化器拒绝 ⇒ 传输一次都没发生（不是"发出去让下游拒"）',
    illegalOutcome === null &&
    illegal.records.filter(r => r.url.indexOf('propose-purchase') >= 0).length === 0);

  /* ③ Home Node offline / transport timeout：sink 如实返回未知，绝不写成购买失败，也不重试 */
  const offline = makeSandbox({ companionPort: 9 /* 没有监听者 */, modelReplies: [
    JSON.stringify({ action: ACTION, proposal: { productId: PRODUCT, units: 1 }, idempotencyKey: 'k-offline' })
  ] });
  offline.IB.activeEconomyProposalEnabled = true;
  offline.IB.activeEconomyCatalogProvider = () => [SERVER_PRODUCT];
  const offlineOutcome = await offline.sandbox.planNextProactiveMessage({
    character: offline.sandbox.apiConfigs[0], conversation: AGENT,
    userMessage: { content: 'x' }, assistantMessage: { content: 'y' },
    userMessageId: 'e5', assistantMessageId: 'e6'
  });
  check('E3 ★★★ Home Node / companion 不可达：结论是 TRANSPORT_FAILED，而**不是** purchase failed / denied',
    !!offlineOutcome && offlineOutcome.ok === false &&
    offlineOutcome.delivery === 'TRANSPORT_FAILED' &&
    offlineOutcome.notAPurchaseVerdict === true &&
    offlineOutcome.purchaseFailed === undefined && offlineOutcome.purchaseDenied === undefined,
    offlineOutcome);
  /* ★ 抽取要按行尾自适应：仓库里这些文件是 CRLF，硬写 '\n}\n' 会切到**文件末尾**
     （开发期实测踩到过：症状是"出口函数体里出现了 for( 与 setTimeout"，
     而真相是那段抽样把后面半个文件都包进来了）。 */
  const sinkMatch = activeDiaryCode.match(/async function _activeEconomyProposalSink\(input\)\{[\s\S]*?\r?\n\}/);
  const sinkBody = sinkMatch ? sinkMatch[0] : '';
  check('E4a ★★ 一次不可达只发一次（生产者没有循环、没有补偿、没有第二轮）',
    offline.records.filter(r => r.url.indexOf('propose-purchase') >= 0).length === 1,
    offline.records.map(r => r.url));
  check('E4b ★★ 出口里没有 while / for / setTimeout / retry 之类的重试结构',
    sinkBody.length > 0 && !/while\s*\(|for\s*\(|setTimeout|retry/i.test(sinkBody),
    sinkBody.slice(0, 200));
  check('E5 ★★ 失败**不**被记入生产者窗口 —— 一次超时不会被写成"已经提议过"（那正好把未知当成买过了）',
    browserPlanSrc.indexOf("outcome.delivery==='DELIVERED'") > 0 &&
    browserPlanSrc.indexOf('_activeEconomyNoteProposal(identity,at)') > 0);
  check('E6 ★★ 出口里没有任何重试 / 轮询 / 补偿循环（一次失败就是一次失败）',
    activeDiaryCode.indexOf('_activeEconomyProposalSink') > 0 &&
    !/while\s*\(|for\s*\(.*attempt/i.test(activeDiaryCode.slice(activeDiaryCode.indexOf('async function _activeEconomyProposalSink'), activeDiaryCode.indexOf('async function _activeEconomyProposalSink') + 900)));
  check('E7 ★★ 错误文本不会变成"让模型自己调用底层补偿动作"的入口：模型输出里出现补偿动词一样 fail closed',
    ['refund', 'reverse', 'cancelPurchase', 'releaseReservation', 'settleNow'].every(a =>
      V({ action: a, proposal: { productId: PRODUCT }, idempotencyKey: 'k' }) === null) &&
    browserPlanCode.indexOf('refund') < 0 && browserPlanCode.indexOf('reverse') < 0);

  /* ══════════════════════════════════════════════════════════════ */
  section('F · §13 只扩 active_agent_runtime；没有第二套 planner / dispatcher');
  /* ══════════════════════════════════════════════════════════════ */

  check('F1 ★★ 本阶段没有新增第二个 planner / dispatcher / prompt 构建器',
    browserPlanCode.indexOf('function buildPlanPrompt(') > 0 &&
    browserPlanCode.indexOf('function planNextProactiveMessage(') > 0 &&
    browserPlanCode.indexOf('function buildEconomyPlanPrompt(') < 0 &&
    browserPlanCode.indexOf('economyDispatcher') < 0 && browserPlanCode.indexOf('dispatchEconomy') < 0);
  check('F2 ★★ Producer 不 require 任何经济实现：浏览器文件里零 store / 零 gate / 零 adapter / 零通道客户端',
    ['economyStore', 'economyCapabilityGate', 'economyActionAdapter', 'performAction',
      'economy-command-channel', 'economy-channel-client', 'require('].every(n => browserPlanCode.indexOf(n) < 0),
    ['economyStore', 'economyCapabilityGate', 'economyActionAdapter', 'performAction',
      'economy-command-channel', 'economy-channel-client', 'require('].filter(n => browserPlanCode.indexOf(n) >= 0));
  check('F3 ★★ 出口是**注入**的，没有注入时 fail closed 且如实记日志（不是静默成功）',
    browserPlanSrc.indexOf('NS.activeEconomyProposalSink') > 0 &&
    browserPlanSrc.indexOf('economy proposal sink is not wired') > 0 &&
    browserPlanSrc.indexOf('NS.activeEconomyProposalSink=') < 0);
  check('F4 ★★ 模型输出必须经过 sanitizer 才会到达出口：出口调用点在净化之后、并且用的**只有** validated 的值',
    browserPlanCode.indexOf('if(validated.action===ACTIVE_ECONOMY_PROPOSAL_ACTION)') > 0 &&
    browserPlanCode.indexOf('validated.proposal') > 0 &&
    browserPlanCode.indexOf('validated.idempotencyKey') > 0 &&
    browserPlanCode.indexOf('parsed.proposal') < 0 &&
    browserPlanCode.indexOf('sink({proposal:parsed') < 0);
  check('F5 ★ 本阶段没有把 Chat / Group / Voice / Diary / MCP 接进经济链（一律 zero-reference）',
    ['groupEconomy', 'voiceEconomy', 'diaryEconomy', 'mcpEconomy', 'chatEconomy'].every(n => browserPlanCode.indexOf(n) < 0) &&
    browserPlanSrc.indexOf("startsWith('group_')") > 0);

  /* ══════════════════════════════════════════════════════════════ */
  section('G · 资源账');
  /* ══════════════════════════════════════════════════════════════ */
  check('G1 ★★ 本文件一次 spawn 都没有发生（child_process 的七个入口全被计数并会当场抛错）',
    spawnAttempts === 0, spawnAttempts);
  check('G2 ★★ 23114 是在**本进程里**被真实创建并 listen 的（因此不存在"残留 child"这一类问题）',
    companionPort > 0 && wiredPort > 0 && companionPort !== wiredPort);

  for (const c of closables.slice().reverse()) { try { c.close(); } catch (_) { } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { } }

  console.log('\n' + (failures === 0 ? '全部通过' : '存在失败') + '：' +
    checks + ' checks · ' + failures + ' failed');
  console.log('child process: max concurrent = 0 · total spawn = 0 · leftover = 0');
  if (failures > 0) process.exitCode = 1;

})().catch(error => {
  for (const c of closables.slice().reverse()) { try { c.close(); } catch (_) { } }
  console.error('\u2716 未捕获异常：' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
