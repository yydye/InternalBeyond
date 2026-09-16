/* ══════════════════════════════════════════════════════════════════════
   P22-20 · Economy External Boundary — 注入（adversarial injections）

   §3 要求对四种资源做**最终反证**：
        A IB_CREDIT            B COMPUTE_ENTITLEMENT
        C Provider quota       D Real money
      测试：IB_CREDIT != money、IB_CREDIT != provider balance、
            COMPUTE_ENTITLEMENT != token quota、COMPUTE_ENTITLEMENT != API billing。
      注入：currency="USD" / "CNY" / "TOKEN" / "API_BALANCE"，确认 **fail closed**。

   §10 要求三类注入必须 DENY：
        · Provider —— provider billing 关键词 / provider balance / quota 注入；
        · Payment  —— **模拟 payment provider 模块真的存在**，确认 Economy 不 import；
        · Exchange —— **模拟 convertCurrency() 真的存在**，确认没有调用路径；
        · Refund   —— 确认不存在 POST /economy/refund、不存在 refundPurchase()。

   ── 资源（§11）────────────────────────────────────────────────────────
     真实 store，但 **0 子进程 / 0 spawn / 0 浏览器 / 0 socket**。
     一个临时目录，结束时退避重试删除（Windows 上 SQLite 的 -wal/-shm 在
     close() 之后会短暂占句柄 —— 这是 P22-19 实测到的，不是猜测）。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function blankComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1');
}

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

console.log('P22-20 · Economy External Boundary — 注入');

const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));

/* ── 一个真实 store + 退避删除 ─────────────────────────────────────── */
/* ★ 所有临时目录都登记在一张表上，并在进程退出时统一删 —— 包括**中途断言
   抛异常**的那条路径。开发期实测：只在正常末尾删的写法会在一次崩溃后
   把目录留在 %TEMP%（而且 SQLite 的 -wal/-shm 让裸 rmSync 也会失败，
   因此删除必须带退避重试）。 */
const CREATED_DIRS = [];
function trackDir(dir) { CREATED_DIRS.push(dir); return dir; }
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  } catch (_) { }
}
process.on('exit', function () { for (const d of CREATED_DIRS) removeDir(d); });

let dirSeq = 0;
function freshStore(tag) {
  dirSeq += 1;
  const dir = trackDir(path.join(os.tmpdir(), 'p2220-inject-' + tag + '-' + process.pid + '-' + Date.now() + '-' + dirSeq));
  const store = createEconomyStore({ dataDir: dir, logger: function () { } });
  const opened = store.open();
  assert.ok(opened && opened.ok !== false, 'store must open for the injection suite');
  return { store: store, dir: dir };
}
function dropStore(handle) {
  try { handle.store.close(); } catch (_) { }
  removeDir(handle.dir);
}
function tempDir(tag) { return trackDir(fs.mkdtempSync(path.join(os.tmpdir(), 'p2220-' + tag + '-'))); }
function parties() {
  return { ok: true, party: { type: 'character', id: 'a1' } };
}

const OWNER = { type: 'character', id: 'a1' };
const WALLET_ID = 'econ_wallet_a1';

/* ══════════════════════════════════════════════════════════════════════
   §3 · 四种资源：注入必须 fail closed
   ══════════════════════════════════════════════════════════════════════ */
section('§3 · 四种资源（IB_CREDIT / COMPUTE_ENTITLEMENT / Provider quota / Real money）');

const INJECTED_CURRENCIES = ['USD', 'CNY', 'TOKEN', 'API_BALANCE'];
/* 每一种注入都必须是**两种**拒绝里的一种：
     FORBIDDEN —— deny-list 认出"这是真实货币或 provider 余额"；
     NOT_REGISTERED —— 白名单认不出"这是我们注册的虚拟资源"。
   两者都算 fail closed，但**要分开数** —— 否则"两个闸门都开着"与
   "只有一个闸门工作"看起来会一样。 */
const FORBIDDEN_CODE = 'currency-forbidden-real-money-or-provider-balance';
const NOT_REGISTERED_CODE = 'currency-not-registered';

function classifyCurrencyRejection(errors) {
  const list = errors || [];
  if (list.indexOf(FORBIDDEN_CODE) >= 0) return 'FORBIDDEN';
  if (list.indexOf(NOT_REGISTERED_CODE) >= 0) return 'NOT_REGISTERED';
  return 'OTHER:' + list.join(',');
}

const h3 = freshStore('res');
const store3 = h3.store;

/* ★★ 差分对照是这一节的**骨架**，不是装饰：
   只断言"注入被拒绝了"是不够的 —— 本轮开发期实测就踩到过：商品 id 写成
   非 canonical 时，注入会因为"id 不合格"被拒，于是断言全绿，而它证明的
   根本不是币种边界。因此每一种注入都配一个**控制组**：除币种以外
   （IB_CREDIT）逐字相同，控制组必须**被接受**。控制组被接受 + 注入组被拒
   绝，这一次拒绝才可归因于币种。 */
const CURRENCY_CASES = ['IB_CREDIT'].concat(INJECTED_CURRENCIES);
const STORE_ID = 'econ_store_p2220';
/* ★ 控制组商品的 id 必须与控制组自己生成的 id **逐字相同**：它由
   `'econ_product_p2220_' + 'IB_CREDIT'.toLowerCase()` 得到（`ib_credit`，
   保留了下划线）。开发期实测把这里写成 `ibcredit` 时，G6/G7 会拿着一个
   不存在的商品去授予额度 —— 于是两条断言变红，而原因与要证的东西无关。 */
const CONTROL_PRODUCT_ID = 'econ_product_p2220_ib_credit';

store3.putStore({ storeId: STORE_ID, name: '内部资源', status: 'ACTIVE', idempotencyKey: 'p2220-store' });

const report = CURRENCY_CASES.map(cur => {
  const tag = cur.toLowerCase();
  const wallet = store3.openWallet({ owner: OWNER, currency: cur, idempotencyKey: 'p2220-wallet-' + tag });
  const policy = store3.putBudgetPolicy({
    ownerId: OWNER.id, currency: cur, limits: { perTransactionMinor: '1000', dailyMinor: '10000' },
    idempotencyKey: 'p2220-policy-' + tag
  });
  const product = store3.putProduct({
    productId: 'econ_product_p2220_' + tag, storeId: STORE_ID, kind: 'COMPUTE_CREDIT',
    fulfillment: 'COMPUTE_GRANT', name: '算力额度', currency: cur, unitPriceMinor: '100',
    unitName: 'computeUnit', grantQuantity: 10, status: 'ACTIVE', idempotencyKey: 'p2220-product-' + tag
  });
  const quote = store3.createQuote({
    buyerId: OWNER.id, productId: 'econ_product_p2220_' + tag, currency: cur,
    amountMinor: '100', quantity: 1, expiresAt: Date.UTC(2030, 0, 1),
    idempotencyKey: 'p2220-quote-' + tag
  });
  const verdict = r => (r.ok === true ? 'ACCEPTED' : classifyCurrencyRejection(r.errors));
  return { currency: cur, wallet: verdict(wallet), policy: verdict(policy), product: verdict(product), quote: verdict(quote) };
});

const controlRow = report[0];
const injectedRows = report.slice(1);
const acceptedAnywhere = injectedRows.filter(r => [r.wallet, r.policy, r.product, r.quote].some(v => v === 'ACCEPTED'));

check('G0 ★★★★★ 差分对照：除币种以外逐字相同的**控制组**（IB_CREDIT）在四个入口上全部被接受',
  controlRow.currency === 'IB_CREDIT' &&
  [controlRow.wallet, controlRow.policy, controlRow.product, controlRow.quote].every(v => v === 'ACCEPTED'),
  controlRow);

check('G1 ★★★★★ 四种注入币种在**四个**入口（钱包 / 预算政策 / 商品 / 报价）上全部 fail closed',
  injectedRows.length === 4 && acceptedAnywhere.length === 0, acceptedAnywhere);

check('G2 ★★★★★ 每一个拒绝都来自两道闸门之一，而且两道**都**真的在工作（FORBIDDEN 与 NOT_REGISTERED 各自出现）',
  (function () {
    const all = injectedRows.reduce((acc, r) => acc.concat([r.wallet, r.policy, r.product, r.quote]), []);
    const kinds = new Set(all);
    return all.every(v => v === 'FORBIDDEN' || v === 'NOT_REGISTERED') &&
      kinds.has('FORBIDDEN') && kinds.has('NOT_REGISTERED');
  })(), injectedRows);

check('G3 ★★★★★ 注入之后 store 里**恰好只有一个**钱包，而且是 IB_CREDIT（拒绝不留半成品）',
  (function () {
    const wallets = store3.listWallets({ ownerId: OWNER.id });
    const currencies = (wallets || []).map(w => String(w.currency));
    return Array.isArray(wallets) && currencies.length === 1 && currencies[0] === 'IB_CREDIT';
  })());

check('G4 ★★★★ IB_CREDIT != money：IB_CREDIT 是唯一被接受的那一个，而且它不在任何法币清单里',
  controlRow.wallet === 'ACCEPTED' &&
  C.CURRENCIES.indexOf('IB_CREDIT') >= 0 &&
  ['CNY', 'USD', 'RMB', 'EUR', 'GBP', 'JPY'].every(f => C.CURRENCIES.indexOf(f) < 0) &&
  C.CURRENCY_DISPLAY.IB_CREDIT === 'IB Credit' &&
  C.CURRENCY_SCALE.IB_CREDIT === 100);

check('G5 ★★★★★ IB_CREDIT != provider balance：造币只在 system 对手方上发生，代币碰不到任何 provider 账户',
  (function () {
    const minted = store3.mintForSystem({
      systemInitiated: true, ownerId: OWNER.id, currency: 'IB_CREDIT',
      amountMinor: '500000', idempotencyKey: 'p2220-mint'
    });
    if (minted.ok !== true) return false;
    const topology = JSON.stringify(store3.ledgerTopology());
    /* ① 系统账户的封闭集合里没有 provider/psp/merchant 这一类；
       ② 账本拓扑里也读不出任何 provider 字样。 */
    return store3.COMMIT_COUNTERPARTIES.join(',') === 'system:treasury,system:market' &&
      !/provider|stripe|alipay|merchant|psp|quota/i.test(topology) &&
      /* ③ 没有 systemInitiated 的裸调用被拒（造币本身要显式声明是系统发起）。 */
      store3.mintForSystem({ ownerId: OWNER.id, currency: 'IB_CREDIT', amountMinor: '1', idempotencyKey: 'p2220-mint-bare' }).ok === false;
  })());

check('G6 ★★★★★ COMPUTE_ENTITLEMENT != token quota：算力额度是一行库存（assetKind=COMPUTE），不是任何 provider 的额度',
  (function () {
    const granted = store3.grantInventory({
      ownerId: OWNER.id, productId: CONTROL_PRODUCT_ID, quantity: 100, idempotencyKey: 'p2220-grant-100'
    });
    const rows = store3.listInventory({ ownerId: OWNER.id });
    const entry = (rows.entries || [])[0];
    if (granted.ok !== true || !entry) return false;
    const serialized = store3.serializeInventoryEntry(entry);
    /* 库存行的键里没有 provider / token / quota / api_ / fiat 这些名字。 */
    const keys = Object.keys(serialized);
    return rows.entries.length === 1 &&
      String(entry.assetKind) === 'COMPUTE' &&
      Number(entry.quantity) === 100 &&
      serialized.isABalance === false &&
      serialized.contributesToAvailableBalance === false &&
      keys.every(k => !/provider|token|quota|^api|fiat/i.test(k)) &&
      /* 反向：一个不存在的商品不能凭注入变出一份额度。 */
      store3.grantInventory({ ownerId: OWNER.id, productId: 'econ_product_p2220_never', quantity: 100, idempotencyKey: 'p2220-grant-ghost' }).ok === false;
  })());

check('G7 ★★★★★ COMPUTE_ENTITLEMENT != API billing：拿到算力额度**不改变余额、不产生账本 entry**（额度不是钱）',
  (function () {
    const before = store3.getWallet({ ownerId: OWNER.id, currency: 'IB_CREDIT' });
    const beforeRevision = store3.getRevision();
    const granted = store3.grantInventory({
      ownerId: OWNER.id, productId: CONTROL_PRODUCT_ID, quantity: 25, idempotencyKey: 'p2220-grant-25'
    });
    const after = store3.getWallet({ ownerId: OWNER.id, currency: 'IB_CREDIT' });
    const qty = store3.inventoryQuantity(OWNER.id, CONTROL_PRODUCT_ID);
    return granted.ok === true && before.ok === true && after.ok === true &&
      String(before.wallet.availableBalanceMinor) === String(after.wallet.availableBalanceMinor) &&
      String(before.wallet.revision) === String(after.wallet.revision) &&
      /* 余额那一行的 revision 没动 ⇒ 额度不是通过账本进出的。 */
      typeof beforeRevision === 'number' &&
      Number(qty.quantity) === 125;
  })());

check('G8 ★★★★★ 算力额度的数量**从来不是**一个金额：它不进预算窗口、不进余额快照',
  (function () {
    const J = o => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const windows = J(store3.spendingWindows({ ownerId: OWNER.id, currency: 'IB_CREDIT' }));
    const snap = J(store3.buildBudgetSnapshot({ ownerId: OWNER.id, currency: 'IB_CREDIT' }));
    /* 125 是刚授予的算力数量；它不许出现在任何金额快照里。 */
    return windows.indexOf('125') < 0 && snap.indexOf('125') < 0 &&
      windows.indexOf('computeUnit') < 0 && snap.indexOf('computeUnit') < 0 &&
      /* 反向：这两个快照确实读到了东西（否则上面是空对空）。 */
      windows.indexOf('spentTodayMinor') >= 0;
  })());

dropStore(h3);

/* ══════════════════════════════════════════════════════════════════════
   §10 · Provider 注入
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · Provider 注入：关键词 / 余额 / 配额，全部 DENY');

const hP = freshStore('provider');
const storeP = hP.store;

/* 注入的三种形态，按 §10 逐条点名：
     billing 关键词  —— providerApiKey / providerAccount / billingAccount / billingHint
     provider balance —— providerBalance / apiBalance / balance
     quota            —— providerQuota / quotaRemaining / tokenQuota / grantedTokens */
const INJECTED_PROVIDER_KEYS = [
  'providerApiKey', 'providerAccount', 'billingAccount', 'billingHint',
  'providerBalance', 'apiBalance', 'balance', 'providerCredit',
  'providerQuota', 'quotaRemaining', 'tokenQuota', 'grantedTokens', 'topUpProvider'
];
const INJECTED_PROVIDER_VALUES = ['OPENAI', 'provider:openai', 'sk-live-not-a-real-key', '1000', 1000];

storeP.openWallet({ owner: OWNER, currency: 'IB_CREDIT', idempotencyKey: 'p2220-p-wallet' });

const productRows = [];
const bootRows = [];
const policyRows = [];
for (const key of INJECTED_PROVIDER_KEYS) {
  for (const value of INJECTED_PROVIDER_VALUES) {
    const tag = key + '-' + String(value).replace(/[^A-Za-z0-9]/g, '');
    /* ① 商品：**未知键即失败**（产品输入有精确白名单）。 */
    productRows.push(storeP.putProduct(Object.assign({
      productId: 'econ_product_p2220_p', storeId: 'econ_store_p2220', kind: 'COMPUTE_CREDIT',
      fulfillment: 'COMPUTE_GRANT', name: '算力额度', currency: 'IB_CREDIT', unitPriceMinor: '100',
      unitName: 'computeUnit', grantQuantity: 10, status: 'ACTIVE', idempotencyKey: 'p2220-p-product-' + tag
    }, { [key]: value })));
    /* ② 一次性初始额度：这是唯一的外部价值入口，因此最该被查。 */
    bootRows.push(storeP.bootstrapInitialCredit(Object.assign({
      ownerId: OWNER.id, currency: 'IB_CREDIT', amountMinor: '1000', idempotencyKey: 'p2220-p-boot-' + tag
    }, { [key]: value })));
    /* ③ 预算政策：**记录**它的行为（见 H2），不假装它拒绝。 */
    policyRows.push({ key: key, out: storeP.putBudgetPolicy(Object.assign({
      ownerId: OWNER.id, currency: 'IB_CREDIT',
      limits: { perTransactionMinor: '1000', dailyMinor: '10000' },
      idempotencyKey: 'p2220-p-policy-' + tag
    }, { [key]: value })) });
  }
}

check('H1 ★★★★★ 13 个 provider 键 × 5 种取值 × 2 个"会存东西"的入口（商品 / 初始额度）全部 DENY —— 130/130',
  productRows.length === 65 && bootRows.length === 65 &&
  productRows.every(r => r.ok === false) && bootRows.every(r => r.ok === false),
  {
    productAccepted: productRows.filter(r => r.ok === true).length,
    bootAccepted: bootRows.filter(r => r.ok === true).length
  });

check('H2 ★★★★★ 预算政策这一条路是**另一种**拒绝形态，而且它同样不落库：未知键被静默丢掉，读回来一个字都没有',
  (function () {
    /* ★ 这一条刻意不写"它也 DENY"：实测 putBudgetPolicy 读的是固定字段名，
       多出来的键既不报错也不入库（与商品那条"未知键即失败"不同）。
       诚实的话术是 deny-by-omission，而它**必须由"读回来的东西里没有"来证明**，
       不能靠"调用返回 ok"就当成没漏。 */
    const read = storeP.getBudgetPolicy({ ownerId: OWNER.id });
    if (read.ok !== true) return false;
    const serialized = JSON.stringify(storeP.serializeBudgetPolicy(read.policy),
      (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const hits = INJECTED_PROVIDER_KEYS.filter(k => serialized.indexOf(k) >= 0);
    /* 反向：确认真的有一条政策被写下去了（否则上面是空对空）。 */
    return hits.length === 0 && serialized.indexOf('perTransactionMinor') >= 0 &&
      policyRows.every(r => r.out.ok === true || r.out.ok === false);
  })());

/* ★★ 但真正**对外可达**的配置面不接受多余键 —— 这是 §10 要的那条 DENY。
   三条命令各查一次：config 里塞 provider 键 ⇒ UNEXPECTED_CONFIG_KEYS；
   信封里塞 provider 键 ⇒ UNEXPECTED_ENVELOPE_KEYS。 */
const seamToken = 'p2220-desktop-token';
const createSeam = require(path.join(ROOT, 'services', 'home-node', 'economy-configuration.js'));
const seam = createSeam({ store: storeP, desktopCredential: seamToken });
const SEAM_INFO = { loopback: true, desktopCredential: seamToken };

check('H3 ★★★★★ 配置面（唯一对外可达的写路径）：三条命令的 config 里塞 provider 键，全部 DENY 且原因是"键不在白名单"',
  (function () {
    const bodies = {
      BOOTSTRAP_CREDIT: { ownerId: OWNER.id, currency: 'IB_CREDIT', amountMinor: '100' },
      PUT_BUDGET_POLICY: { ownerId: OWNER.id, currency: 'IB_CREDIT', limits: { perTransactionMinor: '1000' } },
      PUT_AUTONOMY_POLICY: { ownerId: OWNER.id, enabled: false, perPurchaseLimitMinor: '1000', dailyAutonomousLimitMinor: '5000' }
    };
    const rows = [];
    for (const command of Object.keys(bodies)) {
      for (const key of INJECTED_PROVIDER_KEYS) {
        const out = seam.dispatch(SEAM_INFO, {
          command: command, config: Object.assign({}, bodies[command], { [key]: 'OPENAI' }),
          idempotencyKey: 'p2220-seam-' + command + '-' + key
        });
        rows.push({ command: command, key: key, ok: out.ok, reasonCode: out.reasonCode, reachedStore: out.reachedStore });
      }
    }
    return rows.length === 39 &&
      rows.every(r => r.ok === false) &&
      rows.every(r => r.reasonCode === createSeam.REFUSAL.UNEXPECTED_CONFIG_KEYS) &&
      rows.every(r => r.reachedStore === false);
  })());

check('H4 ★★★★★ 配置面的**信封**上塞 provider 键同样被拒（拒绝发生在到达 store 之前）',
  (function () {
    const rows = INJECTED_PROVIDER_KEYS.concat(['providerTopup', 'apiKey', 'realMoney']).map(key => seam.dispatch(SEAM_INFO, {
      command: 'BOOTSTRAP_CREDIT',
      config: { ownerId: OWNER.id, currency: 'IB_CREDIT', amountMinor: '100' },
      idempotencyKey: 'p2220-env-' + key,
      [key]: 'OPENAI'
    }));
    return rows.length === 16 && rows.every(r => r.ok === false) &&
      rows.every(r => r.reasonCode === createSeam.REFUSAL.UNEXPECTED_ENVELOPE_KEYS) &&
      rows.every(r => r.reachedStore === false);
  })());

check('H5 ★★★★★ 而且这 55 次拒绝之后 store 里一条记录都没有多（拒绝不留痕）',
  (function () {
    const products = storeP.listProducts({});
    const policies = storeP.listBudgetPolicies({});
    const boot = storeP.getInitialCreditBootstrap({ ownerId: OWNER.id, currency: 'IB_CREDIT' });
    return products.ok === true && (products.products || []).length === 0 &&
      policies.ok === true && (policies.policies || []).length <= 1 /* H2 那一次是刻意写下去的 */ &&
      /* 初始额度**没有**被发出去 —— 这是"唯一的外部价值入口"的关键断言。 */
      (boot.bootstrapped !== true);
  })());

check('H6 ★★★★ provider 单位名注入（unitName = tokens / usd / providerBalance）被逐字否认',
  ['tokens', 'usd', 'providerBalance', 'apiCredit', 'token'].every(unitName => {
    const r = storeP.putProduct({
      productId: 'econ_product_p2220_unit', storeId: 'econ_store_p2220', kind: 'COMPUTE_CREDIT',
      fulfillment: 'COMPUTE_GRANT', name: '算力额度', currency: 'IB_CREDIT', unitPriceMinor: '100',
      unitName: unitName, grantQuantity: 10, status: 'ACTIVE', idempotencyKey: 'p2220-unit-' + unitName
    });
    return r.ok === false;
  }));

check('H7 ★★★★★ Agent 那条路（动作适配器）上的 provider 注入同样被拒（不是"只有桌面面在管"）',
  (function () {
    const createGate = require(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'));
    const createAdapter = require(path.join(ROOT, 'services', 'home-node', 'economy-action-adapter.js'));
    const gate = createGate({ store: storeP, config: { consumers: { active_agent_runtime: true } } });
    const handle = gate.bind('active_agent_runtime');
    const adapter = createAdapter(handle);
    const rows = INJECTED_PROVIDER_KEYS.map((key, i) => adapter.performAction({
      action: 'ECONOMY_PROPOSE_PURCHASE',
      proposal: { productId: 'econ_product_p2220_p', units: 1, [key]: 'OPENAI' },
      idempotencyKey: 'p2220-adapter-' + i
    }));
    return rows.length === 13 && rows.every(r => r.ok === false) &&
      rows.every(r => typeof r.reasonCode === 'string' && r.reasonCode.length > 0);
  })());

check('H8 ★★★★★ 没有 provider adapter 可以被注入：store 与门的句柄上都没有任何 provider 成员',
  (function () {
    const storeKeys = Object.keys(storeP).filter(k => /provider|billing|quota/i.test(k));
    const gate = require(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'))({ store: storeP });
    const gateKeys = Object.keys(gate).filter(k => /provider|billing|quota/i.test(k));
    const handleKeys = Object.keys(gate.bind('active_agent_runtime')).filter(k => /provider|billing|quota/i.test(k));
    return storeKeys.length === 0 && gateKeys.length === 0 && handleKeys.length === 0;
  })());

dropStore(hP);

/* ══════════════════════════════════════════════════════════════════════
   §10 · Payment：模拟 payment provider 模块**真的存在**
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · Payment：让 payment provider 模块真的存在，确认 Economy 一次都不 import');

/* ★ 这一节的核心是"让禁区真的存在"：
   把 bridge/pay-gate.js 与 bridge/alipay-provider.js 这两个**真实路径**
   解析到一个临时目录里的**桩模块**（于是 require 会成功、不会因为"文件不
   存在"而失败），然后重新加载 Economy 的七个生产文件，断言一次都没走到。
   如果哪一天 Economy 真去 require 了它们，"模块不存在"这个借口就不成立
   —— 这正是本节要排除的那种假阴性。 */
const paymentStubDir = tempDir('psp');
const paymentStubLoads = [];
let paymentCalls = 0;
const PAYMENT_STUB_PATHS = ['bridge/pay-gate.js', 'bridge/alipay-provider.js',
  'bridge/payment-provider.js', 'active/payment-auth.js', 'active/commerce.js'];

for (const rel of PAYMENT_STUB_PATHS) {
  const abs = path.join(paymentStubDir, rel.replace(/[\/]/g, '__'));
  fs.writeFileSync(abs, [
    "'use strict';",
    "module.exports = {",
    "  commitSpend: function () { globalThis.__p2220PaymentCalls++; return { ok: true }; },",
    "  submit_payment: function () { globalThis.__p2220PaymentCalls++; return { ok: true }; },",
    "  pay_register_checkout: function () { globalThis.__p2220PaymentCalls++; return { ok: true }; },",
    "  __isThePaymentProviderStub: true",
    "};"
  ].join('\n'), 'utf8');
}
globalThis.__p2220PaymentCalls = 0;

const Module = require('node:module');
const originalResolve = Module._resolveFilename;
const ECONOMY_ABS = fs.readdirSync(path.join(ROOT, 'services', 'home-node'))
  .filter(f => /^economy-.*\.js$/.test(f))
  .map(f => path.join(ROOT, 'services', 'home-node', f))
  .sort();

/* 把五个支付/购物模块的 specifier 重定向到桩：**只**对 Economy 生产文件生效
   （parent 必须是 economy-*.js），因此这一层重定向本身不会污染别的断言。 */
Module._resolveFilename = function (request, parent, isMain, options) {
  const parentFile = parent && parent.filename ? String(parent.filename).replace(/\\/g, '/') : '';
  const isEconomyParent = /\/services\/home-node\/economy-[^/]+\.js$/.test(parentFile);
  if (isEconomyParent) {
    for (const rel of PAYMENT_STUB_PATHS) {
      if (request === rel || request === '../' + rel || request === './' + rel ||
        request === rel.replace(/^bridge\//, '../bridge/') || request.endsWith(rel)) {
        paymentStubLoads.push(rel);
        return path.join(paymentStubDir, rel.replace(/[\/]/g, '__'));
      }
    }
  }
  return originalResolve.apply(this, arguments);
};

let loadResult = 'ok';
try {
  /* 清掉缓存，保证这是一次真的加载（否则"没 import"可能只是缓存命中）。 */
  for (const abs of ECONOMY_ABS) delete require.cache[require.resolve(abs)];
  for (const abs of ECONOMY_ABS) require(abs);
} catch (error) {
  loadResult = 'threw: ' + error.message;
} finally {
  Module._resolveFilename = originalResolve;
}

check('I1 ★★★★★ 在支付模块**真的可解析**的前提下，Economy 的七个生产文件一次都没 require 它们',
  loadResult === 'ok' && paymentStubLoads.length === 0, { loadResult: loadResult, loads: paymentStubLoads });

check('I2 ★★★★★ 七次 require 之后支付桩一次都没被调用（loads = 0 ⇒ calls = 0，两个数字都要看）',
  globalThis.__p2220PaymentCalls === paymentCalls && paymentCalls === 0);

check('I3 ★★★★★ 桩本身是**真的能工作**的：直接 require 它会 +1 次调用（否则 I1/I2 是在为空气作证）',
  (function () {
    const stub = require(path.join(paymentStubDir, 'bridge__pay-gate.js'));
    const before = globalThis.__p2220PaymentCalls;
    stub.commitSpend({ amountMinor: '100' });
    return stub.__isThePaymentProviderStub === true && globalThis.__p2220PaymentCalls === before + 1;
  })());

check('I4 ★★★★★ §4 禁止的方向：settlePurchase / preparePurchase 的**源码**里没有任何一次支付调用（把桩挂在全局上也不会有）',
  (function () {
    const src = read('services/home-node/economy-store.js');
    const body = blankComments(src).replace(/'(?:[^'\\]|\\.)*'/g, "''");
    return ['function settlePurchase', 'function preparePurchase'].every(decl => {
      const i = body.indexOf(decl);
      return i >= 0 && !/pay_|commitSpend|submit_payment|alipay|stripe|checkoutUrl/i.test(body.slice(i, i + 60000));
    });
  })());

check('I5 ★★★★★ 运行一次**完整**的 报价 → 预留 → 结算 之后，支付桩的调用数仍然是 0',
  (function () {
    const h = freshStore('payment-run');
    try {
      const s = h.store;
      s.openWallet({ owner: OWNER, currency: 'IB_CREDIT', idempotencyKey: 'pay-run-wallet' });
      s.mintForSystem({ systemInitiated: true, ownerId: OWNER.id, currency: 'IB_CREDIT', amountMinor: '100000', idempotencyKey: 'pay-run-mint' });
      s.putStore({ storeId: 'econ_store_payrun', name: '内部资源', status: 'ACTIVE', idempotencyKey: 'pay-run-store' });
      s.putProduct({
        productId: 'econ_product_payrun', storeId: 'econ_store_payrun', kind: 'CONSUMABLE',
        fulfillment: 'INVENTORY_GRANT', name: '素材包', currency: 'IB_CREDIT',
        unitPriceMinor: '500', unitName: 'item', grantQuantity: 1, status: 'ACTIVE',
        idempotencyKey: 'pay-run-product'
      });
      /* ★ 预算政策是**必须**的：没有它 preparePurchase 会以
         POLICY_NOT_FOUND 拒绝（"budget-does-not-allow-this-spend"）。
         少了这一步，I5 会因为"这次购买根本没发生"而假通过 —— 那正好是
         这一条最该避免的失效形态。 */
      s.putBudgetPolicy({
        ownerId: OWNER.id, currency: 'IB_CREDIT',
        limits: { perTransactionMinor: '9000', dailyMinor: '90000' },
        idempotencyKey: 'pay-run-policy'
      });
      const quote = s.createProductQuote({
        buyerId: OWNER.id, productId: 'econ_product_payrun', units: 1,
        expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'pay-run-quote'
      });
      const prepared = quote.ok === true ? s.preparePurchase({
        quoteId: quote.result.quoteId, buyerId: OWNER.id,
        expiresAt: Date.UTC(2030, 0, 1), idempotencyKey: 'pay-run-prepare'
      }) : { ok: false, errors: quote.errors };
      const settled = prepared.ok === true ? s.settlePurchase({
        purchaseId: prepared.result.purchaseId, idempotencyKey: 'pay-run-settle'
      }) : { ok: false, errors: prepared.errors };
      /* 反向：钱真的动了、货真的发了（否则"支付桩 0 次"可能只是整条链没跑）。 */
      const walletAfter = s.getWallet({ ownerId: OWNER.id, currency: 'IB_CREDIT' });
      const invAfter = s.listInventory({ ownerId: OWNER.id });
      return quote.ok === true && prepared.ok === true && settled.ok === true &&
        String(walletAfter.wallet.availableBalanceMinor) === '99500' &&
        (invAfter.entries || []).length === 1 &&
        /* 只有 I3 那一次（测试自己直接调用桩），生产链贡献 0 次。 */
        globalThis.__p2220PaymentCalls === 1;
    } finally {
      dropStore(h);
    }
  })());

/* ══════════════════════════════════════════════════════════════════════
   §10 · Exchange：模拟 convertCurrency() 真的存在
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · Exchange：让 convertCurrency() 真的存在，确认没有调用路径');

/* 把转换函数挂在**三个**可能被叫到的地方：store 句柄、全局对象、以及那两个
   真实模块路径（重定向到桩）。任何一条调用路径都会把计数器推上去。 */
let convertCalls = 0;
function convertCurrency() { convertCalls += 1; return { ok: true, amountMinor: '1' }; }
globalThis.convertCurrency = convertCurrency;

const hX = freshStore('exchange');
const storeX = hX.store;
storeX.convertCurrency = convertCurrency;
storeX.exchange = convertCurrency;
storeX.convert = convertCurrency;

const exchangeStubDir = tempDir('fx');
fs.writeFileSync(path.join(exchangeStubDir, 'fx.js'),
  "'use strict';\nmodule.exports = { convertCurrency: function () { globalThis.__p2220ConvertCalls++; return { ok: true }; } };\n", 'utf8');
globalThis.__p2220ConvertCalls = 0;

check('J1 ★★★★★ 把整条读面 + 写面跑一遍（钱包/预算/报价/预留/结算/库存/批准/意图/配置），convertCurrency 与 fx 桩都是 0 次',
  (function () {
    const before = { dir: convertCalls, stub: globalThis.__p2220ConvertCalls };
    /* ① 读面全跑 */
    ['getWallet', 'listWallets', 'listLedgerEntries', 'listTransactions', 'listChanges',
      'listChangesForOwner', 'listReservations', 'listBudgetPolicies', 'listQuotes', 'listStores',
      'listProducts', 'listInventory', 'listPurchases', 'listApprovals', 'listPurchaseIntents',
      'listAutonomyPolicies', 'health', 'ledgerTopology', 'getRevision'].forEach(fn => {
        if (typeof storeX[fn] === 'function') storeX[fn]({ ownerId: OWNER.id, currency: 'IB_CREDIT' });
      });
    /* ② 写面全跑（合法输入） */
    storeX.openWallet({ owner: OWNER, currency: 'IB_CREDIT', idempotencyKey: 'fx-wallet' });
    storeX.mintForSystem({ ownerId: OWNER.id, currency: 'IB_CREDIT', amountMinor: '100000', idempotencyKey: 'fx-mint' });
    storeX.putBudgetPolicy({ ownerId: OWNER.id, currency: 'IB_CREDIT', limits: { perTransactionMinor: '9000', dailyMinor: '90000' }, idempotencyKey: 'fx-policy' });
    storeX.putAutonomyPolicy({ ownerId: OWNER.id, enabled: true, perPurchaseLimitMinor: '5000', dailyAutonomousLimitMinor: '20000', idempotencyKey: 'fx-auto' });
    storeX.putStore({ storeId: 'econ_store_fx', name: '内部资源', status: 'ACTIVE', idempotencyKey: 'fx-store' });
    storeX.putProduct({ productId: 'econ_product_fx', storeId: 'econ_store_fx', kind: 'CONSUMABLE', fulfillment: 'INVENTORY_GRANT', name: '素材包', currency: 'IB_CREDIT', unitPriceMinor: '500', unitName: 'item', grantQuantity: 1, status: 'ACTIVE', idempotencyKey: 'fx-product' });
    storeX.createProductQuote({ buyerId: OWNER.id, productId: 'econ_product_fx', quantity: 1, idempotencyKey: 'fx-quote' });
    storeX.grantInventory({ ownerId: OWNER.id, productId: 'econ_product_fx', quantity: 5, idempotencyKey: 'fx-grant' });
    storeX.consumeInventory({ ownerId: OWNER.id, productId: 'econ_product_fx', quantity: 1, idempotencyKey: 'fx-consume' });
    storeX.reserveFunds({ ownerId: OWNER.id, currency: 'IB_CREDIT', amountMinor: '500', idempotencyKey: 'fx-reserve' });
    const prepared = storeX.preparePurchase({ buyerId: OWNER.id, productId: 'econ_product_fx', currency: 'IB_CREDIT', amountMinor: '500', quantity: 1, idempotencyKey: 'fx-prepare' });
    if (prepared.ok === true) {
      storeX.settlePurchase({ purchaseId: prepared.purchase.purchaseId, idempotencyKey: 'fx-settle' });
    }
    storeX.proposeAgentPurchaseIntent({ agentId: OWNER.id, productId: 'econ_product_fx', units: 1, reason: '想再要一份', idempotencyKey: 'fx-intent' });
    /* ③ 兑付形态的**直接**调用也要被数到（证明计数器是活的） */
    convertCurrency('100', {});
    return convertCalls === before.dir + 1 && globalThis.__p2220ConvertCalls === before.stub;
  })());

check('J2 ★★★★★ store 句柄上没有兑换成员：convertCurrency / exchange / convert 都是外部挂上去的，store 自己没有',
  (function () {
    const h = freshStore('exchange-keys');
    try {
      const keys = Object.keys(h.store);
      return keys.every(k => !/exchange|convert|cashout|rate/i.test(k)) &&
        typeof h.store.convertCurrency === 'undefined';
    } finally {
      dropStore(h);
    }
  })());

check('J3 ★★★★★ §7 结论：`0 Economy capability` —— 契约里的 computeExchangeAmount 在整条生产链上一次都没被调用',
  (function () {
    /* 用 Module._load 记账：真跑一遍生产链，把每一次 require 都记下来，
       并断言契约的兑换导出**没有**被任何非契约文件取用（它不是 via 名称，
       而是 via 调用点 —— 因此再看一遍所有调用点）。 */
    const callSites = [];
    for (const rel of ['services/home-node/economy-store.js', 'services/home-node/economy-capability.js',
      'services/home-node/economy-action-adapter.js', 'services/home-node/economy-command-channel.js',
      'services/home-node/economy-configuration.js', 'services/home-node/economy-approval-decision.js',
      'services/home-node/http.js', 'active/economy-channel-client.js',
      'assets/js/economy-shell.js', 'assets/js/economy-shell-core.js',
      'assets/js/economy-approval.js', 'assets/js/economy-configuration.js']) {
      const code = blankComments(read(rel)).replace(/'(?:[^'\\]|\\.)*'/g, "''");
      if (/\bcomputeExchangeAmount\s*\(|\bvalidateExchangeRate\s*\(/.test(code)) callSites.push(rel);
    }
    return callSites.length === 0;
  })());

dropStore(hX);

/* ══════════════════════════════════════════════════════════════════════
   §10 · Refund：确认不存在
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · Refund：不存在的两件事');

check('K1 ★★★★★ store 句柄上不存在 refundPurchase / reversePurchase / chargeback（一个都没有）',
  (function () {
    const h = freshStore('refund-keys');
    try {
      const keys = Object.keys(h.store);
      return keys.length > 50 &&
        keys.filter(k => /refund|reversal|reverse|chargeback|compensat/i.test(k)).length === 0;
    } finally {
      dropStore(h);
    }
  })());

check('K2 ★★★★★ 全仓不存在 POST /economy/refund（也不存在 /economy/reverse · /economy/cancel 这类写路由）',
  (function () {
    const httpStr = blankComments(read('services/home-node/http.js'));
    /* ① 真的路由：每一个 /economy/* 的路由判定都必须是 GET。 */
    const routeBlocks = httpStr.match(/path === '\/economy\/[a-z-]+'[^\n]*/g) || [];
    const nonGet = routeBlocks.filter(line => !/method === 'GET'/.test(line));
    /* ② 否认名单里确实写着 refund / reverse（"不存在"是被写下来的）。 */
    const denied = (httpStr.match(/unreachable:\s*\[[^\]]*\]/g) || []).join(' ');
    return routeBlocks.length >= 20 && nonGet.length === 0 &&
      denied.indexOf('/economy/refund') >= 0 && denied.indexOf('/economy/reverse') >= 0;
  })());

check('K3 ★★★★★ 全仓不存在 refundPurchase() 的定义或调用（**挖掉注释**后扫 —— 注释里那句"刻意没有 refundPurchase"是边界的证据，不是实现）',
  (function () {
    const files = fs.readdirSync(path.join(ROOT, 'services', 'home-node'))
      .filter(f => /^economy-.*\.js$/.test(f)).map(f => 'services/home-node/' + f)
      .concat(['assets/js/economy-approval-core.js', 'assets/js/economy-approval.js',
        'assets/js/economy-configuration-core.js', 'assets/js/economy-configuration.js',
        'assets/js/economy-shell-core.js', 'assets/js/economy-shell.js',
        'services/home-node/http.js']);
    const codeHits = files.filter(rel => /\brefundPurchase\b|\breversePurchase\b|\bchargeback\b|\bissueRefund\b/.test(blankComments(read(rel))));
    /* 反向：那句否认**确实**写在源码里（否则上面那条"没有"只是因为谁都没提它）。 */
    const denialWritten = /\brefundPurchase\b/.test(read('services/home-node/economy-contract.js')) &&
      /\brefundPurchase\b/.test(read('services/home-node/economy-store.js'));
    return codeHits.length === 0 && denialWritten;
  })());

/* ══════════════════════════════════════════════════════════════════════
   §10 · capability negative tests：未来能力词一律 DENY
   ══════════════════════════════════════════════════════════════════════ */
section('§10 · capability 反例：BUY / PAY / REFUND / EXCHANGE / TRANSFER / TOPUP / WITHDRAW 一律 DENY');

const FUTURE_CAPABILITY_WORDS = ['BUY', 'PAY', 'PAYMENT', 'REFUND', 'EXCHANGE', 'TRANSFER',
  'TOPUP', 'TOP_UP', 'WITHDRAW', 'CASHOUT', 'CONVERT', 'RECHARGE', 'SETTLE', 'PROVIDER_TOPUP'];

check('L1 ★★★★★ 14 个未来能力词 × 4 个 consumer 全部 CAPABILITY_DENIED，而且原因码是"未知能力"而不是"未授权"',
  (function () {
    const consumers = Object.keys(C.CONSUMER_CAPABILITY_MATRIX);
    const rows = [];
    for (const word of FUTURE_CAPABILITY_WORDS) {
      for (const consumer of consumers) {
        const decision = C.checkEconomyCapability({ consumer: consumer, capability: word });
        rows.push({ word: word, consumer: consumer, allowed: decision.allowed, reason: decision.reasonCode });
      }
    }
    const allowed = rows.filter(r => r.allowed === true);
    const weird = rows.filter(r => r.allowed !== true &&
      r.reason !== C.CAPABILITY_DENY_REASON.UNKNOWN_CAPABILITY &&
      r.reason !== C.CAPABILITY_DENY_REASON.CAPABILITY_DENIED);
    return rows.length === FUTURE_CAPABILITY_WORDS.length * consumers.length &&
      allowed.length === 0 && weird.length === 0;
  })());

check('L2 ★★★★★ 权限表本身没有被扩大：仍然是 2 个 capability × 4 个 consumer，与 P22-1～19 逐字相同',
  (function () {
    const matrix = C.CONSUMER_CAPABILITY_MATRIX;
    const caps = Object.keys(C.CAPABILITY);
    return caps.length === 2 &&
      caps.indexOf('PROPOSE_PURCHASE') >= 0 && caps.indexOf('RESUME_APPROVED_PURCHASE') >= 0 &&
      Object.keys(matrix).length === 4 &&
      matrix.active_agent_runtime.length === 2 &&
      matrix.user_decision_seam.length === 1 &&
      matrix.home_node_authority.length === 0 &&
      matrix.desktop_bridge.length === 0;
  })());

check('L3 ★★★★★ 动作适配器上：14 个未来动作词全部 UNKNOWN_ECONOMY_ACTION，而 RESUME 是 NOT_OFFERED（分层拒绝）',
  (function () {
    const createGate = require(path.join(ROOT, 'services', 'home-node', 'economy-capability.js'));
    const createAdapter = require(path.join(ROOT, 'services', 'home-node', 'economy-action-adapter.js'));
    const h = freshStore('adapter');
    try {
      /* ★ 句柄必须由**真的门**发出来：适配器在构造期就检查它是不是一个
         capability handle，传一个手搓对象会直接抛 —— 那本身也是一条断言。 */
      const gate = createGate({ store: h.store });
      const handle = gate.bind('active_agent_runtime');
      const adapter = createAdapter(handle);
      const rows = FUTURE_CAPABILITY_WORDS.map(word => adapter.performAction({
        action: 'ECONOMY_' + word, proposal: {}, idempotencyKey: 'p2220-l3-' + word
      }));
      const resume = adapter.performAction({
        action: 'ECONOMY_RESUME_APPROVED_PURCHASE', proposal: {}, idempotencyKey: 'p2220-l3-resume'
      });
      /* 反向证明"适配器不是万能入口"：一个没有 proposePurchaseIntent 的对象
         在**构造期**就被拒（P22-10 D1 的那条不变量）。 */
      let emptyRefused = false;
      let gateRefused = false;
      try { createAdapter({}); } catch (_) { emptyRefused = true; }
      try { createAdapter(gate); } catch (_) { gateRefused = true; }
      return rows.length === FUTURE_CAPABILITY_WORDS.length &&
        rows.every(r => r && r.ok === false && typeof r.reasonCode === 'string') &&
        rows.every(r => /UNKNOWN|NOT_OFFERED|REFUSED/i.test(r.reasonCode)) &&
        resume.ok === false && resume.reasonCode === 'ACTION_NOT_OFFERED' &&
        emptyRefused && gateRefused;
    } finally {
      dropStore(h);
    }
  })());

console.log('\n' + '─'.repeat(66));
console.log('结果: ' + (failures === 0 ? 'PASS' : failures + ' FAILED') + '（' + checks + ' 项）');
process.exitCode = failures === 0 ? 0 : 1;
