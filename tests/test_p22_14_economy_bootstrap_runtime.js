'use strict';
/* ====================================================================
   P22-14 · Economy Bootstrap / Fresh-install closure runtime
   （真实 buildHomeNode + 真实 HTTP + 真实 SQLite · **零子进程**）
   --------------------------------------------------------------------
   运行：node tests/test_p22_14_economy_bootstrap_runtime.js

   ── 这是本阶段最重要的端到端证明（§9）─────────────────────────────────
   从真正的空 Economy DB 开始：

     fresh DB
       → BOOTSTRAP_CREDIT        （HTTP · 真实凭据）
       → PUT_BUDGET_POLICY       （HTTP · 真实凭据）
       → PUT_AUTONOMY_POLICY     （HTTP · 真实凭据）
       → 读回 canonical state
       → 经**既有 P22-11 → P22-10 → P22-9 → P22-8 → P22-7 → P22-6** 链
         真的买入一件 ITEM/COMPUTE fixture

   重点不是重测整个 P22，而是证明：
     > 不改代码、不碰 SQLite、不调用测试专用 store 方法，也能把一个 fresh
     > install 配到可运行状态。

   ★ 唯一**留在** store 内部 API 上的东西是**货架与商品**（putStore /
     putProduct）：本阶段的 configuration seam 只有三个命令，目录不在其中
     （§2 的"它只能配置"是一份封闭清单）。因此这条测试显式说明它用 store
     的内部 API 种了目录，而不是假装目录也走配置面 —— 目录的写入口是
     **未来的** Economy admin/policy 阶段的事，本阶段不偷偷扩词表。

   ── 为什么一个子进程都不开（§14）──────────────────────────────────────
   §14 逐字要求 max concurrent child = 0 · total spawn = 0 · leftover = 0。
   本阶段新增的东西是**一条 HTTP 路径**与**一条一次性规则**，而两者的真假
   分别由"一个真实监听 socket 的 server"与"同一个 dataDir 上重新打开一次
   store"回答 —— 两者都在**本进程**里就足够。目标里的产物是一个**临时**
   dataDir，它按定义就是"新开一个进程的 Home Node 也会看到同一个库"，
   因此"重启之后 one-shot 仍然成立"是**真实**的重新打开，而不是模拟。
   ==================================================================== */

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const CONFIG = require(path.join(ROOT, 'services', 'home-node', 'economy-configuration.js'));
const CHANNEL = require(path.join(ROOT, 'services', 'home-node', 'economy-command-channel.js'));
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

const tempDirs = [];
const closables = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-14rt-' + tag + '-'));
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
function request(port, method, urlPath, body, headers, opts) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const options = {
      host: '127.0.0.1', port: port, method: method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}),
      timeout: 8000
    };
    /* ★ P22-11 的既有语义：来源身份包含**来源端口**，因此一条真实 command
       必须从一个**登记的、固定的**本机端口发出。这是 transport 的事实，
       不是测试的方便 —— 与 tests/test_p22_11_economy_command_channel.js 的
       boundRequest 逐字同源。 */
    if (opts && opts.localPort) {
      options.localPort = opts.localPort;
      options.localAddress = '127.0.0.1';
    }
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
    req.on('timeout', () => { req.destroy(new Error('http request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

/* 从**固定**来源端口发一次请求。固定 localPort 会与上一次连接的 TIME_WAIT
   撞（Windows 上是随机的 EADDRINUSE），那不是逻辑失败。 */
async function boundRequest(port, sourcePort, method, urlPath, body, headers) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await request(port, method, urlPath, body, headers, { localPort: sourcePort });
    } catch (error) {
      lastError = error;
      if (!/EADDRINUSE/.test(String(error && (error.code || error.message)))) throw error;
      await new Promise(r => setTimeout(r, 80));
    }
  }
  throw lastError;
}

const CUR = 'IB_CREDIT';
const AGENT = 'p14rt_agent';
const TOKEN = 'p14-runtime-desktop-token';
const SOURCE_TOKEN = 'p14-runtime-source-token';
const CONFIG_PATH = CONFIG.CONFIGURATION_PATH;
const COMMAND_PATH = '/internal/economy/command';
const AUTH = { 'X-IB-Home-Token': TOKEN };
const SOURCE_AUTH = { 'X-IB-Economy-Channel-Source': SOURCE_TOKEN };

let keySeq = 0;
function K(p) { keySeq += 1; return 'p14rt-' + (p || 'k') + '-' + keySeq; }

const BOOT_AMOUNT = 1000000;
const PER_TX = 100000;

console.log('P22-14 · Economy Bootstrap / Fresh-install closure runtime');

/* ══════════════════════════════════════════════════════════════════════
   贯穿整份测试的**同一个临时 dataDir** —— 它就是"这台机器上的一次 fresh
   install"。所有实例（包括"重启"那一个）都开在它上面。
   ══════════════════════════════════════════════════════════════════════ */
const DATA_DIR = tmpDir('install');
const REGISTRY_DIR = tmpDir('registry');

async function main() {
  /* ── 一次性端口：Home Node 自己的，以及 Active 来源登记的那个（**不被
        监听**的那个 —— 与 P22-11 的登记语义逐字相同）。 */
  const port = await freePort();
  const sourcePort = await freePort();

  /* 每一条写路径自己的 header 名字 —— 两条凭据域不共用。 */
  async function configure(envelope, extra) {
    return request(port, 'POST', CONFIG_PATH,
      envelope, Object.assign({}, AUTH, extra || {}));
  }
  async function propose(envelope) {
    return boundRequest(port, sourcePort, 'POST', COMMAND_PATH, envelope, SOURCE_AUTH);
  }

  function boot(options) {
    const instance = SERVICE.buildHomeNode(Object.assign({
      dataDir: DATA_DIR,
      registryDir: REGISTRY_DIR,
      host: '127.0.0.1',
      port: port,
      token: TOKEN,
      economyChannelSources: [{ consumer: CHANNEL.CONSUMER, token: SOURCE_TOKEN, boundPort: sourcePort }],
      logger: () => {}
    }, options || {}));
    closables.push(instance);
    return instance;
  }

  /* ══════════════════════════════════════════════════════════════════
     A · fresh install 的**初始状态**（一个真正的空 Economy DB）
     ══════════════════════════════════════════════════════════════════ */
  section('A · fresh DB 的初始状态（诚实答案，而不是 0）');

  let instance = boot();
  instance.open();
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(port, '127.0.0.1', resolve);
  });
  const store = instance.economyStore;

  check('A1 ★★ 这是一个**真正的空** Economy DB（没有任何钱包、政策、购买、intent）',
    store.listWallets({}).length === 0 &&
    store.listBudgetPolicies({}).policies.length === 0 &&
    store.listAutonomyPolicies({}).policies.length === 0 &&
    store.listPurchases({}).purchases.length === 0 &&
    store.listPurchaseIntents({}).intents.length === 0 &&
    store.listTransactions({ limit: 10 }).length === 0,
    { wallets: store.listWallets({}).length, budgets: store.listBudgetPolicies({}).policies.length,
      autonomy: store.listAutonomyPolicies({}).policies.length,
      purchases: store.listPurchases({}).purchases.length });

  const freshWalletBefore = await request(port, 'GET', '/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR, null, AUTH);
  check('A2 ★★ 还没有配置之前，读面诚实地回答"查不到钱包"（而不是一个 0 余额）',
    freshWalletBefore.status === 404 &&
    String(freshWalletBefore.body.error || '').indexOf('wallet') >= 0,
    freshWalletBefore.body);

  check('A3 ★★ 配置面在真实装配里是**开**的（凭据 + 三个 store 入口都就绪）',
    instance.economyConfiguration.describe().open === true &&
    instance.economyConfiguration.describe().openRequires.desktopCredentialConfigured === true &&
    instance.economyConfiguration.describe().openRequires.storeCanBootstrapInitialCredit === true,
    instance.economyConfiguration.describe().openRequires);

  const security = await request(port, 'GET', '/security', null, AUTH);
  const securityBody = security.body || {};
  const securitySection = securityBody.security || securityBody;
  const ep = securitySection.economyPolicy || null;
  check('A4 ★★ 未配置时：自主策略还没有（权威因此**默认** REQUIRE_APPROVAL，而不是放行），而配置面已经开',
    (() => {
      const autonomy = store.getAutonomyPolicy({ ownerId: AGENT });
      const decision = C.evaluateAutonomousPurchase(null, {
        ownerId: { type: 'character', id: AGENT }, productKind: 'COMPUTE_CREDIT',
        settlementType: 'COMPUTE_GRANT', currency: CUR, amountMinor: 10000n,
        gift: false, selfDirected: true, spentTodayMinor: 0n, timestamp: 1700000000000
      });
      return security.status === 200 && ep != null &&
        autonomy.ok === false &&
        decision.outcome === C.AP_DECISION.REQUIRE_APPROVAL &&
        ep.configuration && ep.configuration.open === true &&
        ep.configuration.configurationCommandsExposed.length === 3;
    })(), { securityStatus: security.status, keys: Object.keys(securityBody),
      ep: ep && ep.configuration });

  /* ── 登记角色（canonical identity registry 的既有路径）────────────── */
  const registered = instance.registry.putCharacter(AGENT, { nickname: 'P14 Runtime Agent' });
  if (!registered || registered.ok !== true) {
    console.error('registry.putCharacter 失败 — ' + J(registered));
    failures += 1;
  }

  /* ══════════════════════════════════════════════════════════════════
     B · §3 初始 IB Credit（一次 HTTP 请求 → 一条 canonical 账本交易）
     ══════════════════════════════════════════════════════════════════ */
  section('B · §3 初始 IB Credit（HTTP · 真实凭据 · 真实 SQLite）');

  const bootstrapEnv = {
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: AGENT, currency: CUR, amountMinor: BOOT_AMOUNT },
    idempotencyKey: K('boot')
  };
  const bootstrap1 = await configure(bootstrapEnv);
  check('B1 ★★ 一条 authenticated 的 BOOTSTRAP_CREDIT 真的动了钱（而且是**一次** canonical MINT）',
    bootstrap1.status === 200 && bootstrap1.body.ok === true &&
    bootstrap1.body.command === 'BOOTSTRAP_CREDIT' &&
    bootstrap1.body.creditMinted === true &&
    bootstrap1.body.initialCreditMintedNow === true &&
    bootstrap1.body.ledgerMutation === true &&
    bootstrap1.body.isProviderQuota === false && bootstrap1.body.isRealCurrency === false &&
    C.isEconomyId('TRANSACTION', bootstrap1.body.transactionId) &&
    typeof bootstrap1.body.walletId === 'string',
    bootstrap1.body);

  const walletAfter = await request(port, 'GET', '/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR, null, AUTH);
  check('B2 ★★ 只读面读到的余额**就是**那个初始额度（十进制字符串，来自派生缓存 + canonical 账本）',
    walletAfter.status === 200 &&
    String(walletAfter.body.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT) &&
    String(walletAfter.body.wallet.ledgerBalanceMinor) === String(BOOT_AMOUNT),
    walletAfter.body.wallet && {
      cached: walletAfter.body.wallet.cachedBalanceMinor,
      ledger: walletAfter.body.wallet.ledgerBalanceMinor
    });

  const txRead = await request(port, 'GET', '/economy/transaction?transactionId=' + bootstrap1.body.transactionId, null, AUTH);
  check('B3 ★★ 那笔交易的类型是 MINT、actor 是 system:mint、而且两端平衡',
    txRead.status === 200 &&
    txRead.body.transaction.transactionType === C.TX_TYPE.MINT &&
    txRead.body.transaction.actor.type === C.PARTY_TYPE.SYSTEM &&
    txRead.body.transaction.actor.id === C.SYSTEM_ACCOUNT.MINT &&
    txRead.body.entries.length === 2,
    txRead.body.transaction);

  /* ── §10 replay：同一个请求重发（response 丢失的模拟）────────────── */
  const bootstrapReplay = await configure(bootstrapEnv);
  const walletAfterReplay = await request(port, 'GET', '/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR, null, AUTH);
  check('B4 ★★ §10 同 idempotencyKey 重发 ⇒ 同一笔逻辑交易，余额**不翻倍**',
    bootstrapReplay.status === 200 && bootstrapReplay.body.ok === true &&
    bootstrapReplay.body.transactionId === bootstrap1.body.transactionId &&
    String(walletAfterReplay.body.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT) &&
    store.listTransactions({ limit: 50 }).filter(t => String(t.transactionType) === C.TX_TYPE.MINT).length === 1,
    { tx: bootstrapReplay.body.transactionId, first: bootstrap1.body.transactionId,
      balance: walletAfterReplay.body.wallet.cachedBalanceMinor });

  const bootstrapOtherKey = await configure(Object.assign({}, bootstrapEnv, {
    idempotencyKey: K('boot'), config: Object.assign({}, bootstrapEnv.config, { amountMinor: BOOT_AMOUNT * 5 })
  }));
  /* ★ 余额读的是**那个真的被 bootstrap 过的 owner** —— 而不是另一个身份：
     另一个 owner 从没被 bootstrap 过，那样读到的是 404 wallet-not-found，
     而不是"余额没动"。 */
  const walletAfterOtherKey = await request(port, 'GET',
    '/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR, null, AUTH);
  check('B5 ★★ §3/§10 换一个 idempotencyKey 且换一个金额 ⇒ **拒绝**（初始额度是一次性的），余额不动',
    bootstrapOtherKey.status === 409 &&
    bootstrapOtherKey.body.reasonCode === 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED' &&
    String(bootstrapOtherKey.body.result.alreadyBootstrappedAmountMinor) === String(BOOT_AMOUNT) &&
    String(walletAfterOtherKey.body.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT),
    { status: bootstrapOtherKey.status, reason: bootstrapOtherKey.body.reasonCode,
      walletStatus: walletAfterOtherKey.status,
      balance: walletAfterOtherKey.body.wallet && walletAfterOtherKey.body.wallet.cachedBalanceMinor });

  /* ── §3 只允许 IB_CREDIT ─────────────────────────────────────────── */
  const otherCurrency = await configure({
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: AGENT, currency: 'ACTIVITY_POINT', amountMinor: 1000 },
    idempotencyKey: K('boot')
  });
  const realMoney = await configure({
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: AGENT, currency: 'USD', amountMinor: 1000 },
    idempotencyKey: K('boot')
  });
  check('B6 ★★ §3 只有 IB_CREDIT 能做初始额度（另一个合法的 Economy 币种与真实货币都不行）',
    otherCurrency.status === 400 &&
    otherCurrency.body.reasonCode === CONFIG.REFUSAL.INITIAL_CREDIT_CURRENCY_MUST_BE_IB_CREDIT &&
    otherCurrency.body.creditMinted === false &&
    realMoney.status === 400 && realMoney.body.creditMinted === false &&
    store.listTransactions({ limit: 50 }).filter(t => String(t.transactionType) === C.TX_TYPE.MINT).length === 1,
    { other: otherCurrency.body.reasonCode, real: realMoney.body.reasonCode });

  /* ══════════════════════════════════════════════════════════════════
     C · §4/§5 两个策略（版本化更新，不是一次性）
     ══════════════════════════════════════════════════════════════════ */
  section('C · §4/§5 Budget 与 Autonomy（配置面 · 版本化）');

  const budgetLimits = {
    perTransactionMinor: PER_TX, dailyMinor: PER_TX * 4,
    weeklyMinor: PER_TX * 20, monthlyMinor: PER_TX * 60,
    approvalThresholdMinor: PER_TX, cooldownMs: 0
  };
  const budgetEnv = {
    command: 'PUT_BUDGET_POLICY',
    config: { ownerId: AGENT, currency: CUR, limits: budgetLimits },
    idempotencyKey: K('budget')
  };
  const budget1 = await configure(budgetEnv);
  check('C1 ★★ PUT_BUDGET_POLICY 真的落下了一条 canonical 策略（revision 是权威给的）',
    budget1.status === 200 && budget1.body.ok === true &&
    budget1.body.command === 'PUT_BUDGET_POLICY' &&
    budget1.body.budgetPolicyWritten === true && budget1.body.ledgerMutation === false &&
    typeof budget1.body.policyId === 'string' && Number.isSafeInteger(budget1.body.policyRevision),
    budget1.body && { reason: budget1.body.reasonCode, errors: budget1.body.errors });

  const budgetRead = await request(port, 'GET', '/economy/policy?ownerId=' + AGENT, null, AUTH);
  check('C2 ★★ 读回的预算策略**逐字**等于写进去的那份（四个额度 + 批准线）',
    budgetRead.status === 200 &&
    String(budgetRead.body.policy.limits.perTransactionMinor) === String(PER_TX) &&
    String(budgetRead.body.policy.limits.dailyMinor) === String(PER_TX * 4) &&
    String(budgetRead.body.policy.limits.approvalThresholdMinor) === String(PER_TX),
    budgetRead.body && budgetRead.body.policy && budgetRead.body.policy.limits);

  const autonomyEnv = {
    command: 'PUT_AUTONOMY_POLICY',
    config: {
      ownerId: AGENT, enabled: true,
      perPurchaseLimitMinor: PER_TX, dailyAutonomousLimitMinor: PER_TX * 4,
      approvalAboveMinor: PER_TX,
      allowedProductKinds: ['COMPUTE_CREDIT'], allowedSettlementTypes: ['COMPUTE_GRANT'],
      allowGift: false
    },
    idempotencyKey: K('autonomy')
  };
  const autonomy1 = await configure(autonomyEnv);
  check('C3 ★★ PUT_AUTONOMY_POLICY 落下的是一条**权限**（不是决策层、不授予预算）',
    autonomy1.status === 200 && autonomy1.body.ok === true &&
    autonomy1.body.autonomyPolicyWritten === true &&
    autonomy1.body.grantsBudget === false && autonomy1.body.isADecisionLayer === false &&
    autonomy1.body.ledgerMutation === false,
    autonomy1.body && { reason: autonomy1.body.reasonCode, errors: autonomy1.body.errors });

  const autonomyRead = await request(port, 'GET', '/economy/autonomy-policy?ownerId=' + AGENT, null, AUTH);
  check('C4 ★★ 读回的自主策略逐字相同（三个额度 + 两个白名单 + allowGift）',
    autonomyRead.status === 200 &&
    String(autonomyRead.body.policy.perPurchaseLimitMinor) === String(PER_TX) &&
    String(autonomyRead.body.policy.approvalAboveMinor) === String(PER_TX) &&
    autonomyRead.body.policy.allowedProductKinds.join(',') === 'COMPUTE_CREDIT' &&
    autonomyRead.body.policy.allowedSettlementTypes.join(',') === 'COMPUTE_GRANT' &&
    autonomyRead.body.policy.allowGift === false &&
    autonomyRead.body.policy.enabled === true,
    autonomyRead.body && autonomyRead.body.policy);

  /* ★ §11：政策**不是**一次性 —— 再改一次必须成功，而且 revision 前进。 */
  const budget2 = await configure(Object.assign({}, budgetEnv, {
    config: Object.assign({}, budgetEnv.config, {
      limits: Object.assign({}, budgetLimits, { perTransactionMinor: PER_TX * 2 })
    }),
    idempotencyKey: K('budget')
  }));
  check('C5 ★★ §11 政策可以改很多次（revision 前进），而初始额度**不能**',
    budget2.status === 200 && budget2.body.ok === true &&
    budget2.body.policyRevision > budget1.body.policyRevision &&
    budget2.body.replayed !== true,
    { first: budget1.body.policyRevision, second: budget2.body.policyRevision });

  /* ── 坏配置 fail closed，而且**不**被自动修正 ───────────────────── */
  /* ★ 一个**真正非法**的预算配置：限额不是金额（负数 / 小数 / 字符串）、
     以及一个不在封闭集合里的限额键。它们全部必须 fail closed。
     ★ 这里刻意不用"缺一档额度"当坏配置：在 P22-4 的契约里 null 逐字
     等于"该档不启用"（normalizePolicyLimits 的既有语义），因此那种写法是
     **合法的**配置，不是坏配置 —— 把它当成坏配置会让这条断言变成一句假话。 */
  const badBudgetInputs = [
    { name: 'negative', limits: { perTransactionMinor: -1 } },
    { name: 'fractional', limits: { perTransactionMinor: 1.5 } },
    { name: 'stringified', limits: { perTransactionMinor: '1.0' } },
    { name: 'unknown-key', limits: { perTransactionMinor: PER_TX, mysteryLimitMinor: 5 } },
    { name: 'cooldown-as-string', limits: { perTransactionMinor: PER_TX, cooldownMs: 'soon' } },
    { name: 'limits-not-an-object', limits: 'all the money' }
  ];
  const badBudgetResults = [];
  for (const bad of badBudgetInputs) {
    badBudgetResults.push({
      name: bad.name,
      res: await configure({
        command: 'PUT_BUDGET_POLICY',
        config: { ownerId: AGENT, currency: CUR, limits: bad.limits },
        /* ★ 每一次坏配置用它**自己的**幂等键：共用一把键会让第二次撞上
           REQUEST_ID_CONFLICT（409），于是这条测试测到的是幂等冲突，
           而不是"坏配置被契约拒绝"。 */
        idempotencyKey: K('bad-budget')
      }),
      body: null
    });
  }
  const badAutonomy = await configure({
    command: 'PUT_AUTONOMY_POLICY',
    config: { ownerId: AGENT, enabled: true, perPurchaseLimitMinor: 100, dailyAutonomousLimitMinor: 50,
      approvalAboveMinor: 5000, allowedProductKinds: ['COMPUTE_CREDIT'],
      allowedSettlementTypes: ['COMPUTE_GRANT'], allowGift: false },
    idempotencyKey: K('autonomy')
  });
  const budgetStillGood = await request(port, 'GET', '/economy/policy?ownerId=' + AGENT, null, AUTH);
  check('C6 ★★ §4/§5 坏配置 fail closed，而且那份**好的**策略一个字都没被改动',
    badBudgetResults.every(r => r.res.status === 400 && r.res.body.ok === false &&
      Array.isArray(r.res.body.errors) && r.res.body.errors.length > 0) &&
    badAutonomy.status === 400 && badAutonomy.body.ok === false && badAutonomy.body.reachedStore === true &&
    /* ★ 自主策略的两个大小关系在 **store** 的 canonical 校验里被拒
       （P22-7 的 validateAutonomyPolicy），而本层把它**原样透出** ——
       本阶段不重新实现它，也不"自动修正"成另一个策略。 */
    String(badAutonomy.body.errors.join(','))
      .indexOf('autonomy-per-purchase-limit-must-not-exceed-the-daily-autonomous-limit') >= 0 &&
    String(badAutonomy.body.errors.join(','))
      .indexOf('autonomy-approval-threshold-must-not-exceed-the-per-purchase-limit') >= 0 &&
    /* ★ 而那份好的策略一个字节都没动（C5 把 perTransaction 改成了 2×，
       所以"C5 之后的那份好策略"就是这里的基准值）。 */
    String(budgetStillGood.body.policy.limits.perTransactionMinor) === String(PER_TX * 2) &&
    String(budgetStillGood.body.policy.limits.dailyMinor) === String(PER_TX * 4) &&
    (await request(port, 'GET', '/economy/autonomy-policy?ownerId=' + AGENT, null, AUTH))
      .body.policy.allowedProductKinds.join(',') === 'COMPUTE_CREDIT',
    { rejected: badBudgetResults.map(r => r.name + ':' + r.res.status),
      accepted: badBudgetResults.filter(r => r.res.status !== 400).map(r => r.name + ':' + r.res.status + ':' + r.res.body.reasonCode),
      autonomy: badAutonomy.body && badAutonomy.body.errors });

  /* ── §12 身份与分权（真实 HTTP）──────────────────────────────────── */
  const selfReported = await configure(Object.assign({}, budgetEnv, {
    idempotencyKey: K('x'), actor: 'admin', authority: 'admin'
  }), {});
  check('C7 ★★ §6/§12 payload 自报权威 ⇒ 403，而且**没碰 store**（reachedStore === false）',
    selfReported.status === 403 &&
    selfReported.body.reasonCode === CONFIG.REFUSAL.NOT_ALLOWED_FOR_A_CALLER_TO_SELF_REPORT &&
    selfReported.body.reachedStore === false &&
    selfReported.body.rejectedIdentityKeys.length === 2,
    selfReported.body);

  const approvalSideways = await configure({
    command: 'APPROVE', config: { approvalId: 'econ_approval_x' }, idempotencyKey: K('x')
  });
  check('C8 ★★ §8 决定面的词送进配置面 ⇒ UNKNOWN_COMMAND（两条路径互不接受对方的信封）',
    approvalSideways.status === 404 &&
    approvalSideways.body.reasonCode === CONFIG.REFUSAL.UNKNOWN_COMMAND &&
    approvalSideways.body.reachedStore === false &&
    approvalSideways.body.acceptedCommands.length === 3,
    approvalSideways.body);

  const agentCredAttempt = await configure({
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: AGENT, currency: CUR, amountMinor: 1 },
    idempotencyKey: K('x')
  }, { 'X-IB-Home-Token': SOURCE_TOKEN });
  const mintCountAfterAgentAttempt = store.listTransactions({ limit: 50 })
    .filter(t => String(t.transactionType) === C.TX_TYPE.MINT).length;
  check('C9 ★★ §12 Agent 的**来源凭据**换不到配置权威（它在传输层就被 401 挡下，一个字节都到不了 seam）',
    /* ★ 这是**更强**的答案，不是更弱的：错的桌面凭据在 authorized() 那一层
       就被 401 挡下，配置面连一次 dispatch 都没有发生过。而"未配置桌面凭据
       时 seam 自己报 403"那条在单进程测试里逐字证明过（B4/C7 组）。 */
    agentCredAttempt.status === 401 &&
    agentCredAttempt.body.reachedStore === undefined &&
    mintCountAfterAgentAttempt === 1,
    { status: agentCredAttempt.status, error: agentCredAttempt.body.error,
      mints: mintCountAfterAgentAttempt });

  /* ══════════════════════════════════════════════════════════════════
     D · §9 经**既有 P22 链**做一次真实购买
     ══════════════════════════════════════════════════════════════════ */
  section('D · §9 既有购买链仍然可达（Agent WANT → authority → purchase）');

  /* ★ 唯一留在 store 内部 API 上的东西：**货架与商品**（见文件头说明）。
     inventory 由 grantQuantity 在商品创建时一次生成（P22-5 的既有语义）。 */
  const storeRow = store.putStore({ name: 'P14 Fixture Store', idempotencyKey: K('store') });
  const productRow = store.putProduct({
    storeId: storeRow.result.store.storeId, kind: 'COMPUTE_CREDIT', name: 'Compute x100',
    currency: CUR, unitPriceMinor: 10000, grantQuantity: 1000, idempotencyKey: K('product')
  });
  check('D1 ★ fixture：货架 + 商品（price 10000，100 单位/件，1000 件库存）',
    storeRow.ok === true && productRow.ok === true &&
    String(productRow.result.product.unitPriceMinor) === '10000',
    { store: storeRow.ok, product: productRow.ok });

  const units = 1;
  const commandIdentity = CHANNEL.createCommandIdentity('p14rt');
  const proposed = await propose({
    command: CHANNEL.COMMAND.ECONOMY_PROPOSE_PURCHASE,
    commandId: commandIdentity.commandId,
    idempotencyKey: commandIdentity.idempotencyKey,
    proposal: {
      agentId: AGENT, productId: productRow.result.product.productId, units: units,
      reason: 'compute is running low'
    }
  });

  check('D2 ★★ 配置完成后，一条真实的 Active command 走完 P22-10 → P22-9 → P22-8 → P22-7 → P22-6：**购买真的发生了**',
    proposed.status === 200 && proposed.body.ok === true &&
    proposed.body.source === C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME &&
    proposed.body.result && proposed.body.result.purchaseCreated === true &&
    proposed.body.result.authorityOutcome === C.AP_DECISION.AUTO_ALLOW &&
    typeof proposed.body.result.intentId === 'string',
    proposed.body && {
      status: proposed.status, reason: proposed.body.reasonCode,
      downstream: proposed.body.downstreamReasonCode,
      result: proposed.body.result && {
        ok: proposed.body.result.ok, purchaseCreated: proposed.body.result.purchaseCreated,
        authorityOutcome: proposed.body.result.authorityOutcome,
        reasonCode: proposed.body.result.reasonCode
      }
    });

  const purchasesRead = await request(port, 'GET', '/economy/purchases', null, AUTH);
  const intentsRead = await request(port, 'GET', '/economy/intents', null, AUTH);
  const walletAfterPurchase = await request(port, 'GET', '/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR, null, AUTH);
  check('D3 ★★ 只读面读到的购买、intent 与**余额变化**三者自洽（10000 minor 真的被花掉了）',
    purchasesRead.status === 200 && purchasesRead.body.purchases.length === 1 &&
    purchasesRead.body.purchases[0].status === C.PURCHASE_STATE.COMPLETED &&
    intentsRead.status === 200 && intentsRead.body.intents.length === 1 &&
    intentsRead.body.intents[0].state === C.PURCHASE_INTENT_STATE.COMPLETED &&
    String(walletAfterPurchase.body.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT - 10000 * units),
    { purchases: purchasesRead.body && purchasesRead.body.purchases && purchasesRead.body.purchases.length,
      intents: intentsRead.body && intentsRead.body.intents && intentsRead.body.intents.length,
      balance: walletAfterPurchase.body && walletAfterPurchase.body.wallet && walletAfterPurchase.body.wallet.cachedBalanceMinor });

  const purchaseFact = purchasesRead.body.purchases[0] || {};
  const ledgerTx = await request(port, 'GET',
    '/economy/transaction?transactionId=' + purchaseFact.ledgerTransactionId, null, AUTH);
  check('D4 ★★ 那笔购买在账本上是一笔**平衡的**交易（canonical ledger 仍然是唯一事实源）',
    ledgerTx.status === 200 && ledgerTx.body.entries.length >= 2 &&
    ledgerTx.body.entries.reduce((acc, e) => {
      const amt = BigInt(String(e.amountMinor));
      return e.direction === C.ENTRY_DIRECTION.CREDIT ? acc + amt : acc - amt;
    }, 0n) === 0n,
    ledgerTx.body && ledgerTx.body.entries);

  /* ══════════════════════════════════════════════════════════════════
     E · §2/§9/§12 边界（都在真实 HTTP 上）
     ══════════════════════════════════════════════════════════════════ */
  section('E · §2/§12 边界（/economy/* 仍然只读 · 配置面不是代理人）');

  const writeForms = ['/economy/approve', '/economy/reject', '/economy/approval/decide',
    '/economy/intent/propose', '/economy/intent/resume', '/economy/execute',
    '/economy/settle', '/economy/buy', '/economy/mint', '/economy/topup',
    '/economy/config', '/economy/bootstrap'];
  const writeResults = [];
  for (const form of writeForms) {
    writeResults.push({ form: form, res: await request(port, 'POST', form, { anything: true }, AUTH) });
  }
  check('E1 ★★ §12 十二条最自然的写形态在真实 server 上**全部** 405 economy-is-read-only / unknown-economy-path',
    writeResults.every(r => r.res.status === 405 &&
      (r.res.body.error === 'economy-is-read-only' || r.res.body.error === 'unknown-economy-path')),
    writeResults.filter(r => !(r.res.status === 405)).map(r => r.form + ':' + r.res.status));

  const configGet = await request(port, 'GET', CONFIG_PATH, null, AUTH);
  const configNoAuth = await request(port, 'POST', CONFIG_PATH, {
    command: 'BOOTSTRAP_CREDIT', config: { ownerId: AGENT, currency: CUR, amountMinor: 1 },
    idempotencyKey: K('x')
  }, {});
  const configWrongAuth = await request(port, 'POST', CONFIG_PATH, {
    command: 'BOOTSTRAP_CREDIT', config: { ownerId: AGENT, currency: CUR, amountMinor: 1 },
    idempotencyKey: K('x')
  }, { 'X-IB-Home-Token': 'not-the-desktop-token' });
  check('E2 ★★ 配置面只有 POST（GET → 405），而且缺凭据 / 错凭据在**传输层**就被拒绝（fail closed）',
    configGet.status === 405 && configGet.body.error === 'economy-configuration-is-post-only' &&
    configNoAuth.status === 401 && configWrongAuth.status === 401 &&
    /* ★ 两条都没到 seam：传输层的拒绝信封里根本没有 seam 的那些位。 */
    configNoAuth.body.reachedStore === undefined && configWrongAuth.body.reachedStore === undefined,
    { getStatus: configGet.status, getError: configGet.body.error,
      noAuthStatus: configNoAuth.status, wrongAuthStatus: configWrongAuth.status });

  const buysThroughConfig = await configure({
    command: 'BUY', config: { ownerId: AGENT, productId: productRow.result.product.productId },
    idempotencyKey: K('x')
  });
  const settleThroughConfig = await configure({
    command: 'SETTLE', config: { purchaseId: purchaseFact.purchaseId }, idempotencyKey: K('x')
  });
  const approveThroughConfig = await configure({
    command: 'APPROVE', config: { approvalId: 'econ_approval_x' }, idempotencyKey: K('x')
  });
  check('E3 ★★ §2 购买 / 结算 / 批准**不是**配置命令（404 UNKNOWN_COMMAND，且一个都没碰 store）',
    [buysThroughConfig, settleThroughConfig, approveThroughConfig].every(r =>
      r.status === 404 && r.body.reasonCode === CONFIG.REFUSAL.UNKNOWN_COMMAND &&
      r.body.reachedStore === false) &&
    store.listPurchases({}).purchases.length === 1,
    [buysThroughConfig.body.reasonCode, settleThroughConfig.body.reasonCode, approveThroughConfig.body.reasonCode]);

  const securityAfter = await request(port, 'GET', '/security', null, AUTH);
  const securityAfterBody = securityAfter.body || {};
  const policy = (securityAfterBody.security || securityAfterBody).economyPolicy;
  check('E4 ★★ §12 /security 让这四件事机器可判定：/economy/* 写 = 0、Agent 只能提议、决定面只能点头/摇头、配置面恰好三命令',
    policy.httpVerbs.join(',') === 'GET' &&
    policy.writesExposed.length === 0 &&
    policy.commandChannel.commandWritesExposed.join(',') === 'ECONOMY_PROPOSE_PURCHASE' &&
    policy.commandChannel.capabilityWritesExposed.length === 0 &&
    policy.commandChannel.approvalWritesExposed.length === 0 &&
    policy.commandChannel.resumeWritesExposed.length === 0 &&
    policy.approvalDecision.approvalDecisionWritesExposed.length === 2 &&
    policy.approvalDecision.decisionWritesThatAreNotAPPROVEorREJECT.length === 0 &&
    policy.configuration.configurationCommandsExposed.join(',') ===
      'BOOTSTRAP_CREDIT,PUT_BUDGET_POLICY,PUT_AUTONOMY_POLICY' &&
    policy.configuration.configurationWritesThatAreNotOneOfThoseThree.length === 0 &&
    policy.configuration.exposesMintForSystem === false &&
    policy.configuration.initialCreditIsOneShot === true &&
    policy.configuration.configurationCannotDecideAnApproval === true &&
    policy.approvalDecision.sharesAConsumerWithTheCommandChannel === false &&
    policy.configuration.sharesACommandWithTheApprovalDecisionSeam === false &&
    policy.configuration.isAnAgentAuthority === false &&
    policy.configuration.isAPurchaseAuthority === false &&
    policy.configuration.isAPaymentAuthority === false &&
    policy.configuration.configurationTouchesProvider === false &&
    policy.configuration.configurationTouchesPayment === false,
    { httpVerbs: policy.httpVerbs, cfg: policy.configuration, cmd: policy.commandChannel });

  /* ══════════════════════════════════════════════════════════════════
     F · §10 重启：one-shot 状态必须是 canonical / persistent
     ══════════════════════════════════════════════════════════════════ */
  section('F · §10 重启之后 one-shot 仍然成立（同一个 dataDir 上重新打开）');

  /* ★ 真实地关掉这个实例（server + context + store），然后在**同一个
     dataDir** 上重新装配一个 —— 那不是"模拟重启"，那是重启本身。 */
  const oldPort = port;
  await new Promise(resolve => instance.server.close(resolve));
  instance.close();

  const port2 = await freePort();
  const restarted = SERVICE.buildHomeNode({
    dataDir: DATA_DIR,
    registryDir: REGISTRY_DIR,
    host: '127.0.0.1',
    port: port2,
    token: TOKEN,
    economyChannelSources: [{ consumer: CHANNEL.CONSUMER, token: SOURCE_TOKEN, boundPort: sourcePort }],
    logger: () => {}
  });
  closables.push(restarted);
  restarted.open();
  await new Promise((resolve, reject) => {
    restarted.server.once('error', reject);
    restarted.server.listen(port2, '127.0.0.1', resolve);
  });
  const store2 = restarted.economyStore;

  check('F1 ★★ 重启之后那条一次性事实**仍然在**（它是一个 canonical meta 行，不是一个进程内 Set）',
    store2.getInitialCreditBootstrap({ type: 'character', id: AGENT }, CUR).bootstrapped === true &&
    String(store2.getInitialCreditBootstrap({ type: 'character', id: AGENT }, CUR).amountMinor) === String(BOOT_AMOUNT),
    store2.getInitialCreditBootstrap({ type: 'character', id: AGENT }, CUR));

  const bootstrapAfterRestart = await request(port2, 'POST', CONFIG_PATH, {
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: AGENT, currency: CUR, amountMinor: BOOT_AMOUNT },
    idempotencyKey: K('boot-restart')
  }, AUTH);
  const walletAfterRestart = await request(port2, 'GET', '/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR, null, AUTH);
  check('F2 ★★ §10 重启之后再 bootstrap 同一个 owner ⇒ 同一笔交易，余额不翻倍',
    bootstrapAfterRestart.status === 200 && bootstrapAfterRestart.body.ok === true &&
    bootstrapAfterRestart.body.transactionId === bootstrap1.body.transactionId &&
    String(walletAfterRestart.body.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT - 10000 * units),
    { tx: bootstrapAfterRestart.body.transactionId, first: bootstrap1.body.transactionId,
      balance: walletAfterRestart.body.wallet && walletAfterRestart.body.wallet.cachedBalanceMinor });

  const bootstrapBiggerAfterRestart = await request(port2, 'POST', CONFIG_PATH, {
    command: 'BOOTSTRAP_CREDIT',
    config: { ownerId: AGENT, currency: CUR, amountMinor: BOOT_AMOUNT * 3 },
    idempotencyKey: K('boot-restart')
  }, AUTH);
  const walletAfterRestart2 = await request(port2, 'GET', '/economy/wallet?ownerId=' + AGENT + '&currency=' + CUR, null, AUTH);
  check('F3 ★★ §10 重启之后换金额再 bootstrap ⇒ **拒绝**（one-shot 是持久的，不是"这台进程记得"）',
    bootstrapBiggerAfterRestart.status === 409 &&
    bootstrapBiggerAfterRestart.body.reasonCode === 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED' &&
    String(walletAfterRestart2.body.wallet.cachedBalanceMinor) === String(BOOT_AMOUNT - 10000 * units),
    bootstrapBiggerAfterRestart.body);

  const readsAfterRestart = await request(port2, 'GET', '/economy/purchases', null, AUTH);
  const budgetAfterRestart = await request(port2, 'GET', '/economy/policy?ownerId=' + AGENT, null, AUTH);
  const autonomyAfterRestart = await request(port2, 'GET', '/economy/autonomy-policy?ownerId=' + AGENT, null, AUTH);
  check('F4 ★★ §9/§10 重启之后**整个已配置状态**都还在：购买、预算、自主策略逐字可读',
    readsAfterRestart.status === 200 && readsAfterRestart.body.purchases.length === 1 &&
    budgetAfterRestart.status === 200 &&
    /* ★ C5 把 perTransaction 改成了 2×（政策是**版本化更新**），因此重启之后
       读到的必须是那一次**改动之后**的值 —— 而不是最初写进去的那个。 */
    String(budgetAfterRestart.body.policy.limits.perTransactionMinor) === String(PER_TX * 2) &&
    autonomyAfterRestart.status === 200 && autonomyAfterRestart.body.policy.enabled === true,
    { purchases: readsAfterRestart.body.purchases && readsAfterRestart.body.purchases.length,
      budget: budgetAfterRestart.status, autonomy: autonomyAfterRestart.status });

  /* ★ §10 的另一半：政策在重启之后**仍然可以改**（它不是一次性）。 */
  const budgetAfterRestartWrite = await request(port2, 'POST', CONFIG_PATH, {
    command: 'PUT_BUDGET_POLICY',
    config: {
      ownerId: AGENT, currency: CUR,
      limits: Object.assign({}, budgetLimits, { dailyMinor: PER_TX * 8 })
    },
    idempotencyKey: K('budget-restart')
  }, AUTH);
  check('F5 ★★ §11 重启之后政策**照样能改**（"三个命令全做成一次性"是错的）',
    budgetAfterRestartWrite.status === 200 && budgetAfterRestartWrite.body.ok === true &&
    budgetAfterRestartWrite.body.policyRevision > budget1.body.policyRevision,
    budgetAfterRestartWrite.body && { status: budgetAfterRestartWrite.status,
      reason: budgetAfterRestartWrite.body.reasonCode, rev: budgetAfterRestartWrite.body.policyRevision });

  /* ══════════════════════════════════════════════════════════════════
     G · §13 provider / payment 硬边界（真实装配上的反向断言）
     ══════════════════════════════════════════════════════════════════ */
  section('G · §13 Provider / Payment 硬边界');

  check('G1 ★★ 整条配置链之后，economy store 里**没有**任何 provider / payment 痕迹（账本里只有 MINT 与购买两笔经济事实）',
    (() => {
      const txs = store2.listTransactions({ limit: 100 });
      const types = txs.map(t => String(t.transactionType)).sort();
      return types.indexOf(C.TX_TYPE.MINT) >= 0 &&
        types.every(t => t === C.TX_TYPE.MINT || t === C.TX_TYPE.PURCHASE || t === C.TX_TYPE.COMPUTE_GRANT) &&
        /* ★ 被逐字禁止的那三类交易（refund / exchange / provider top-up）一笔都没有。 */
        txs.every(t => [C.TX_TYPE.REFUND, C.TX_TYPE.EXCHANGE, C.TX_TYPE.BURN].indexOf(String(t.transactionType)) < 0);
    })());

  check('G2 ★★ §13 配置面的 store 视图恰好三个键 —— 因此 mintForSystem / openWallet / settlePurchase 在这条依赖上不存在',
    restarted.economyConfiguration.describe().storeViewKeys.join(',') ===
      'bootstrapInitialCredit,putBudgetPolicy,putAutonomyPolicy' &&
    restarted.economyConfiguration.describe().exposesMintForSystem === false &&
    restarted.economyConfiguration.describe().canTopUpAProvider === false &&
    restarted.economyConfiguration.describe().canWriteRawLedgerEntries === false &&
    restarted.economyConfiguration.describe().canForgeATransactionId === false &&
    restarted.economyConfiguration.describe().canChooseLedgerAccounts === false);

  /* ══ 收尾 ══ */
  for (const c of closables) { try { c.close(); } catch (_) { } }
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { } }

  console.log('\n' + (failures === 0 ? '✔' : '✖') + ' P22-14 bootstrap runtime: ' +
    (checks - failures) + '/' + checks + ' checks passed');
  if (failures) { console.error(failures + ' FAILED'); process.exit(1); }
}

main().catch(error => {
  console.error('P22-14 runtime 崩溃 — ' + String((error && error.stack) || error));
  for (const c of closables) { try { c.close(); } catch (_) { } }
  process.exit(1);
});
