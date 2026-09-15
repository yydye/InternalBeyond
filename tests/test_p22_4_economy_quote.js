'use strict';
/* ====================================================================
   P22-4 · Economy 报价（Quote）：价格命题 ≠ 资源锁定
   --------------------------------------------------------------------
   运行：node tests/test_p22_4_economy_quote.js

   本文件回答的问题：
     「如果这个经济请求现在执行，需要付出什么？」—— 而这个问题的答案
       必须是一份**冻结的价格命题**，不是一次资金占用。

   ── 为什么 Quote 与 Reservation 必须被证明是两件事 ────────────────────
   P22-1 §14 已经写过 Quote 存在的理由：消灭
       check price = 50 → price changes → commit 80
   这条序列。但"消灭它的动机"与"实现真的没锁钱"是两件事。最容易发生的
   错误是把 createQuote 写成"顺手 reserve 一下，反正马上要用"——那样
   报价一多，可用余额就被一堆没人要的报价吃光，而每一笔单独看都"对"。
   因此本文件的重量放在**分离性**上：
     · 创建报价前后，ledger 求和 / reserved 求和 / available / 交易数
       逐字比对（不是断言"我们没写"，而是断言"世界没变"）；
     · 评估报价同样什么都不改（§18：评估一份报价不能偷偷变成接受它）；
     · 报价过期不产生任何经济后果（它从来没有锁住什么，所以"还回去"
       这件事根本不存在）。
   以及三条本阶段独有的性质：
     · **金额与币种不可变** —— 静态扫 UPDATE 的 SET 列 + 运行时读回；
     · **过期不是定时器** —— 真相是 `expires_at <= now` 这条比较；
     · **kind / settlementType 是冻结的** —— API_QUOTA 这类未来商品
       今天就能被表达，而 provider 一个字节都没碰。

   ── 与方法名对应关系 ─────────────────────────────────────────────────
     A  schema 与自述              B  createQuote
     C  报价 ≠ 预留（分离性）       D  evaluateQuote（纯读）
     E  金额与币种不可变            F  状态机与终态不可回退
     G  到期（比较，不是定时器）    H  幂等
     I  崩溃注入                   J  重启恢复（含离线过期）
     K  API_QUOTA 未来兼容性        L  provider / payment 隔离
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-4q-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

function deterministicIds() {
  let n = 0;
  return (kind) => { n += 1; return C.formatEconomyId(kind, 't' + n).id; };
}
function mutableClock(start) {
  const box = { now: Number(start) || Date.UTC(2024, 0, 15, 12, 0, 0) };
  const fn = () => box.now;
  fn.box = box;
  fn.advance = (ms) => { box.now += Number(ms); return box.now; };
  fn.set = (t) => { box.now = Number(t); return box.now; };
  return fn;
}
function makeStore(extra) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir,
    logger: () => { },
    nextId: deterministicIds()
  }, extra || {}));
}
function walletWith(store, amountMinor, ownerId, currency) {
  const w = store.openWallet({ owner: { type: 'character', id: ownerId || 'cfg_a' }, currency: currency || 'IB_CREDIT' });
  assert.equal(w.ok, true, 'openWallet must succeed: ' + J(w.errors));
  if (amountMinor && BigInt(amountMinor) !== 0n) {
    const m = store.mintForSystem({
      systemInitiated: true, walletId: w.wallet.walletId, currency: currency || 'IB_CREDIT',
      amountMinor: amountMinor, idempotencyKey: 'seed-' + w.wallet.walletId
    });
    assert.equal(m.ok, true, 'mint must succeed: ' + J(m.errors));
  }
  return w.wallet;
}
let quoteSeq = 0;
function createQuoteOk(store, options) {
  const o = options || {};
  quoteSeq += 1;
  const out = store.createQuote(Object.assign({
    buyerId: 'cfg_a',
    currency: 'IB_CREDIT',
    amountMinor: 100,
    productId: 'widget',
    idempotencyKey: 'quote-' + quoteSeq
  }, o, o.idempotencyKey != null ? { idempotencyKey: o.idempotencyKey } : {}));
  assert.equal(out.ok, true, 'createQuote must succeed: ' + J(out.errors || out));
  return out.result;
}
let policySeq = 0;
function putPolicy(store, options) {
  const o = options || {};
  policySeq += 1;
  const out = store.putBudgetPolicy(Object.assign({
    ownerId: 'cfg_a',
    currency: 'IB_CREDIT',
    idempotencyKey: 'policy-' + policySeq
  }, o, o.idempotencyKey != null ? { idempotencyKey: o.idempotencyKey } : {}));
  assert.equal(out.ok, true, 'putBudgetPolicy must succeed: ' + J(out.errors || out));
  return out.result;
}
const SAMPLE_LIMITS = Object.freeze({
  perTransactionMinor: 300, dailyMinor: 500, weeklyMinor: 1000,
  monthlyMinor: 2000, approvalThresholdMinor: 200
});
/* 一个"经济状态指纹"：钱包、预留、政策、报价、账本拓扑、行数与 revision。
   任何一次读之后它必须逐字相同。 */
function economyFingerprint(store) {
  const h = store.health();
  return J({
    state: h.state, revision: h.revision, counts: h.counts,
    changes: store.listChanges(0, 500).length,
    topology: store.ledgerTopology(null),
    wallets: store.listWallets({ limit: 500 }).map(w => store.serializeWallet(w, {})),
    reservations: store.listReservations({ limit: 500 }).reservations.map(r => store.serializeReservation(r)),
    quotes: store.listQuotes({ limit: 500 }).quotes.map(q => store.serializeQuote(q))
  });
}
/* 只取**经济**的那一半（不含 quotes / policies / revision / changes）——
   用来证明"报价的存在 / 被评估 / 被扫描"都不影响账本。
   `withQuotes` 为真时**额外**把报价一起快照：那是给"读操作不该改变任何
   东西（包括报价自己的行）"那几条断言用的。 */
function economicFingerprint(store, withQuotes) {
  const h = store.health();
  const out = {
    /* 只取**经济**的那一半：账本拓扑、钱包（余额 / 锁定量）、预留、
       以及那四张"钱动了才有行"的表的计数。刻意**不含** quotes /
       budgetPolicies / revision / changes。 */
    counts: {
      wallets: h.counts.wallets, transactions: h.counts.transactions,
      entries: h.counts.entries, operations: h.counts.operations,
      reservations: h.counts.reservations, activeReservations: h.counts.activeReservations
    },
    topology: store.ledgerTopology(null),
    wallets: store.listWallets({ limit: 500 }).map(w => store.serializeWallet(w, {})),
    reservations: store.listReservations({ limit: 500 }).reservations.map(r => store.serializeReservation(r))
  };
  if (withQuotes === true) {
    out.quotes = store.listQuotes({ limit: 500 }).quotes.map(q => store.serializeQuote(q));
  }
  return J(out);
}

/* 一个**剥掉注释与字符串字面量**的代码扫描器。
   为什么需要它："报价这一层不碰 provider / 真实支付"这类性质必须扫
   **代码**，而不是扫文件文本 —— 否则一句解释"这里没有 topup"的注释、
   或者 doesNotExpose 里那个作为**数据**的 'topup' 字符串都会造成假阳性，
   而最坏的后果是有人为了让它变绿而删掉解释。 */
function stripCommentsAndStrings(src) {
  return String(src)
    .replace(/\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^\/\\\n])+\/[gimsuy]*/g, ' RE ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^\\"\n])*"/g, ' "" ')
    .replace(/`(?:\\.|[^\\`])*`/g, ' `` ');
}

console.log('P22-4 · Economy quote（价格命题 ≠ 资源锁定）');

/* ══════════════════════════════════════════════════════════════════
   A · schema 与自述
   ══════════════════════════════════════════════════════════════════ */
section('A · 报价表、状态词表、以及"它不锁任何东西"的自述');

{
  const clock = mutableClock();
  const dir = tmpDir('schema');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 1000n);

  check('A1 quotes 表在 economy_ 命名空间下，且 schema 水位 ≥ 3',
    store.TABLES.QUOTES === 'economy_quotes' && store.SCHEMA_VERSION >= 3);
  check('A2 报价的列逐字是"什么 / 多少钱 / 到什么时候"那几列（PRAGMA 读回来的真实列）',
    (() => {
      const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
      const cols = raw.prepare('PRAGMA table_info(' + store.TABLES.QUOTES + ')').all().map(r => String(r.name));
      raw.close();
      const required = ['quote_id', 'product_id', 'buyer_id', 'buyer_type', 'currency', 'amount_minor',
        'quantity', 'quote_kind', 'service_role', 'state', 'expires_at', 'idempotency_key',
        'fingerprint', 'revision', 'created_at', 'updated_at'];
      const banned = ['api_key', 'payment_link', 'checkout_url', 'provider', 'inventory_count',
        'owned_items', 'provider_quota_balance', 'relationship', 'memory', 'cny', 'usd'];
      return required.every(c => cols.indexOf(c) >= 0) && banned.every(c => cols.indexOf(c) < 0) &&
        cols.length === required.length + 3;   /* + recipient_id, recipient_type, predecessor_quote_id */
    })());
  check('A3 health() 自述报价的 canonical 来源与"不锁任何东西"',
    store.health().quoteCanonical === 'sqlite-quotes' &&
    store.health().quoteStateVocabulary.indexOf('QUOTE_STATE') >= 0 &&
    store.health().quoteLocksNothing === true);
  check('A4 报价状态词表是契约冻结的三个（OPEN / CONSUMED / EXPIRED），没有 CANCELLED',
    C.QUOTE_STATES.join(',') === 'OPEN,CONSUMED,EXPIRED' &&
    C.QUOTE_TERMINAL_STATES.slice().sort().join(',') === 'CONSUMED,EXPIRED');
  check('A5 doesNotExpose 里有 quote-writes（这一阶段的三个写方法一个都不在 HTTP 上）',
    store.health().doesNotExpose.indexOf('quote-writes') >= 0);
  check('A6 新建库 quotes / openQuotes 都是 0（观测面跟着能力长）',
    store.health().counts.quotes === 0 && store.health().counts.openQuotes === 0);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   B · createQuote
   ══════════════════════════════════════════════════════════════════ */
section('B · createQuote：一份冻结的价格命题');

{
  const clock = mutableClock();
  const dir = tmpDir('create');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 1000n);

  const q = createQuoteOk(store, { amountMinor: 250, expiresAt: clock() + 60000 });
  check('B1 报价的 id 是 econ_quote_ 前缀（第 9 种 id 种类，P22-1 就已冻结）',
    C.isEconomyId('QUOTE', q.quoteId) && q.quoteId.indexOf('econ_quote_') === 0);
  check('B2 报价带回六个必需字段，且金额是十进制字符串（对外形态唯一出口）',
    q.currency === 'IB_CREDIT' && q.amountMinor === '250' && q.quantity === 1 &&
    q.state === 'OPEN' && q.expiresAt === clock() + 60000 &&
    q.kind === 'PURCHASE' && typeof q.amountMinor === 'string',
    q);
  check('B3 settlementType 被**冻结**在报价上（不是结算时再推导一次）',
    q.settlementType === C.settlementTypeOfQuoteKind(q.kind) &&
    q.settlementType === 'PURCHASE');
  check('B4 结果里逐字写着"没有锁钱、没有动账本"',
    q.reservedFunds === false && q.ledgerMutation === false);
  check('B5 change log 里有一条 QUOTE_CREATED，payload 里也写着 ledgerMutation:false',
    (() => {
      const changes = store.listChanges(0, 500).filter(c => c.kind === 'QUOTE_CREATED');
      return changes.length === 1 && changes[0].payload.ledgerMutation === false &&
        changes[0].payload.reservedFunds === false &&
        changes[0].entityId === q.quoteId;
    })());
  check('B6 读回来的是同一份（getQuote 按 id 认，不存在的 id 明确失败）',
    store.getQuote({ quoteId: q.quoteId }).quote.quoteId === q.quoteId &&
    store.getQuote({ quoteId: 'econ_quote_nope' }).ok === false);
  check('B7 listQuotes 支持按 buyer / state 过滤，且过滤条件非法时明确失败',
    store.listQuotes({ buyerId: 'cfg_a' }).quotes.length === 1 &&
    store.listQuotes({ buyerId: 'cfg_a', state: 'OPEN' }).quotes.length === 1 &&
    store.listQuotes({ buyerId: 'cfg_a', state: 'CONSUMED' }).quotes.length === 0 &&
    store.listQuotes({ state: 'NOPE' }).ok === false);
  check('B8 报价必须挂在一个**真实存在**的钱包上（空头支票造不出来）',
    store.createQuote({
      buyerId: 'cfg_ghost', currency: 'IB_CREDIT', amountMinor: 100,
      productId: 'widget', expiresAt: clock() + 60000, idempotencyKey: 'ghost-1'
    }).ok === false);
  check('B9 0 金额报价被拒绝（没有价格内容，却会占一行、消耗一个 revision）',
    store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 0,
      productId: 'widget', expiresAt: clock() + 60000, idempotencyKey: 'zero-1'
    }).reasonCode === 'INVALID_AMOUNT');
  check('B10 quantity 必须是正整数，且它被写进报价（"买几份"是报价的一部分）',
    store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, quantity: 0,
      productId: 'widget', expiresAt: clock() + 60000, idempotencyKey: 'qty-1'
    }).ok === false &&
    createQuoteOk(store, { amountMinor: 10, quantity: 3, expiresAt: clock() + 60000 }).quantity === 3);
  check('B11 productId 必须能构成 canonical 的 econ_product_ id（裸字符串会被规范化或拒绝）',
    (() => {
      const bare = store.createQuote({
        buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, productId: 'widget',
        expiresAt: clock() + 60000, idempotencyKey: 'prod-1'
      });
      const bad = store.createQuote({
        buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, productId: '',
        expiresAt: clock() + 60000, idempotencyKey: 'prod-2'
      });
      return bare.ok === true && bad.ok === false &&
        /^econ_product_/.test(bare.result.productId);
    })());
  check('B12 expiresAt 必须显式给出、且是**未来**的绝对毫秒时间戳（过去的时间点直接拒绝）',
    store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, productId: 'widget',
      idempotencyKey: 'exp-missing'
    }).ok === false &&
    store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, productId: 'widget',
      expiresAt: clock() - 1, idempotencyKey: 'exp-past'
    }).reasonCode === 'QUOTE_EXPIRED');

  /* ── 买给别人的报价只有 GIFT 一种自洽形态 ───────────────────────── */
  check('B13 recipientId 只允许出现在 GIFT 报价上（PURCHASE + recipient 是两个意思）',
    store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, productId: 'widget',
      recipientId: 'cfg_b', expiresAt: clock() + 60000, idempotencyKey: 'rec-1'
    }).reasonCode === 'PARTY_NOT_ALLOWED' &&
    store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, productId: 'widget',
      kind: 'GIFT', expiresAt: clock() + 60000, idempotencyKey: 'rec-2'
    }).reasonCode === 'PARTY_NOT_ALLOWED' &&
    createQuoteOk(store, {
      amountMinor: 10, productId: 'widget', kind: 'GIFT', recipientId: 'cfg_b',
      expiresAt: clock() + 60000
    }).recipientId === 'cfg_b');
  check('B14 GIFT 的结算形态仍然落在 P22-3 允许的对手方之内（system:market）',
    (() => {
      const gift = store.listQuotes({ buyerId: 'cfg_a' }).quotes.filter(q => q.kind === 'GIFT');
      return gift.length === 1 && gift[0].settlementType === 'GIFT' &&
        store.COMMIT_COUNTERPARTIES.indexOf(C.SYSTEM_ACCOUNT.MARKET) >= 0 &&
        store.COMMIT_COUNTERPARTIES.indexOf(C.SYSTEM_ACCOUNT.MINT) < 0 &&
        store.COMMIT_COUNTERPARTIES.indexOf(C.SYSTEM_ACCOUNT.BURN) < 0;
    })());
  check('B15 未知的 kind 被拒绝（自由字符串会让"将来怎么结算"无法回答）',
    store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 10, productId: 'widget',
      kind: 'API_QUOTA', expiresAt: clock() + 60000, idempotencyKey: 'kind-1'
    }).reasonCode === 'EFFECT_NOT_ALLOWED');
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   C · 报价 ≠ 预留（本阶段最需要被证明的分离性）
   ══════════════════════════════════════════════════════════════════ */
section('C · 报价 ≠ 预留：创建与读取报价都不改变任何经济事实');

{
  const clock = mutableClock();
  const dir = tmpDir('separation');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 1000n);
  putPolicy(store, { limits: SAMPLE_LIMITS });

  const economicBefore = economicFingerprint(store);
  const availableBefore = store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}).availableBalanceMinor;

  /* 连开三份报价，而且故意让它们的总额**超过**可用余额 ——
     如果创建报价会锁钱，第一份之后余额就该变了。 */
  const quotes = [
    createQuoteOk(store, { amountMinor: 400, expiresAt: clock() + 60000 }),
    createQuoteOk(store, { amountMinor: 400, expiresAt: clock() + 60000 }),
    createQuoteOk(store, { amountMinor: 400, expiresAt: clock() + 60000 })
  ];
  const economicAfter = economicFingerprint(store);
  const walletAfter = store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {});

  check('C1 三份总额 1200 > 可用余额 1000 的报价之后，账本 / 预留 / 钱包**逐字未变**',
    economicAfter === economicBefore,
    { before: economicBefore.slice(0, 300), after: economicAfter.slice(0, 300) });
  check('C2 available 一动不动（报价从不占用可用余额）',
    walletAfter.availableBalanceMinor === availableBefore &&
    walletAfter.availableBalanceMinor === '1000' &&
    walletAfter.reservedBalanceMinor === '0');
  check('C3 没有产生任何 ledger transaction / entry / reservation / operation',
    store.health().counts.transactions === 1 && store.health().counts.entries === 2 &&
    store.health().counts.reservations === 0 && store.health().counts.operations === 0,
    store.health().counts);
  check('C4 三份报价各自**没有** transactionId 之外的链接（报价只有 price proposition 这一层含义）',
    quotes.every(q => q.reservedFunds === false && q.ledgerMutation === false &&
      q.state === C.QUOTE_STATE.OPEN) &&
    store.listQuotes({ buyerId: 'cfg_a' }).quotes.every(q => !('reservationId' in q)));
  check('C5 只有 quotes 那一层的计数在变（三份报价 → openQuotes 3）',
    store.health().counts.quotes === 3 && store.health().counts.openQuotes === 3);

  /* 反向：**真的** reserve 一次，证明这套指纹确实能发现经济变化
     （否则 C1 可能只是"指纹不敏感"）。 */
  const res = store.reserveFunds({
    walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 100,
    expiresAt: clock() + 60000, idempotencyKey: 'control-reserve'
  });
  check('C6 对照组：真的做一次 reserve 时，同一个指纹**确实**会变（证明 C1 不是假绿）',
    res.ok === true && economicFingerprint(store) !== economicBefore &&
    store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}).availableBalanceMinor === '900');
  store.releaseReservation({ reservationId: res.result.reservationId, idempotencyKey: 'control-release' });
  check('C7 对照组收尾：release 之后 available 回到 1000，而报价一份没少',
    store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}).availableBalanceMinor === '1000' &&
    store.health().counts.quotes === 3);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · evaluateQuote（§18：读，而且**只是**读）
   ══════════════════════════════════════════════════════════════════ */
section('D · evaluateQuote：评估一份报价不能偷偷变成接受它');

{
  const clock = mutableClock();
  const dir = tmpDir('evaluate');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  const w = walletWith(store, 1000n);
  putPolicy(store, { limits: SAMPLE_LIMITS });

  const cheap = createQuoteOk(store, { amountMinor: 100, expiresAt: clock() + 60000 });
  const needsApproval = createQuoteOk(store, { amountMinor: 250, expiresAt: clock() + 60000 });
  const tooBig = createQuoteOk(store, { amountMinor: 350, expiresAt: clock() + 60000 });
  const tooPricey = createQuoteOk(store, { amountMinor: 900, expiresAt: clock() + 60000 });

  const before = economicFingerprint(store, true);
  const evaluated = [
    store.evaluateQuote({ quoteId: cheap.quoteId }),
    store.evaluateQuote({ quoteId: needsApproval.quoteId }),
    store.evaluateQuote({ quoteId: tooBig.quoteId }),
    store.evaluateQuote({ quoteId: tooPricey.quoteId })
  ];
  check('D1 四份报价各自得到正确的三态结论（ALLOW / REQUIRE_APPROVAL / DENY 各就各位）',
    evaluated[0].decision.outcome === 'ALLOW' &&
    evaluated[1].decision.outcome === 'REQUIRE_APPROVAL' &&
    evaluated[1].decision.reasonCode === 'AMOUNT_EXCEEDS_APPROVAL_THRESHOLD' &&
    evaluated[2].decision.outcome === 'DENY' &&
    evaluated[2].decision.reasonCode === 'AMOUNT_EXCEEDS_PER_TRANSACTION' &&
    evaluated[3].decision.outcome === 'DENY',
    evaluated.map(e => e.decision.outcome + ':' + e.decision.reasonCode));
  check('D2 两千次评估之后，账本 / 预留 / 钱包 / **报价状态** 全部逐字未变',
    (() => {
      for (let i = 0; i < 2000; i++) store.evaluateQuote({ quoteId: cheap.quoteId });
      return economicFingerprint(store, true) === before;
    })());
  check('D3 评估结果里带着三个"没有做"的逐字声明（evaluatedOnly / reserved / consumed）',
    evaluated.every(e => e.evaluatedOnly === true && e.reserved === false && e.consumed === false &&
      typeof e.notASpendPermit === 'string' && e.notASpendPermit.length > 0));
  check('D4 评估**不消费**报价：结论是 ALLOW 的那一份仍然是 OPEN',
    store.getQuote({ quoteId: cheap.quoteId }).quote.state === 'OPEN' &&
    store.getQuote({ quoteId: cheap.quoteId }).quote.terminal === false);
  check('D5 评估带回四样东西：quote / walletSnapshot / budgetSnapshot / decision（§18 要求的那四样）',
    (() => {
      const e = evaluated[0];
      return e.quote.quoteId === cheap.quoteId &&
        e.walletSnapshot.walletState === 'READY' &&
        e.walletSnapshot.availableBalanceMinor === '1000' &&
        e.walletSnapshot.ledgerBalanceMinor === '1000' &&
        e.walletSnapshot.reservedBalanceMinor === '0' &&
        e.budgetSnapshot.spentTodayMinor === '0' &&
        e.budgetSnapshot.timezone === 'UTC' &&
        typeof e.decision.reasonCode === 'string';
    })(),
    evaluated[0].walletSnapshot);
  check('D6 报价侧的拒绝与预算侧的拒绝**各自**回带（同一个结果里两个原因都可读）',
    (() => {
      const degraded = makeStore({ dataDir: tmpDir('no-policy'), clock: clock });
      degraded.open();
      walletWith(degraded, 1000n);
      const q = createQuoteOk(degraded, { amountMinor: 100, expiresAt: clock() + 60000 });
      const e = degraded.evaluateQuote({ quoteId: q.quoteId });
      degraded.close();
      /* 没有政策 ⇒ 预算侧说不 ⇒ 结论是 DENY，且 quoteReasonCode 为 null。 */
      return e.decision.outcome === 'DENY' && e.decision.reasonCode === 'POLICY_NOT_FOUND' &&
        e.quoteReasonCode === null && e.budgetReasonCode === 'POLICY_NOT_FOUND';
    })());
  check('D7 过期但还没被扫的报价：评估**立刻**说不（QUOTE_EXPIRED），而数据上仍是 OPEN',
    (() => {
      const q = createQuoteOk(store, { amountMinor: 100, expiresAt: clock() + 1000 });
      clock.advance(2000);
      const e = store.evaluateQuote({ quoteId: q.quoteId });
      clock.advance(-2000);
      return e.decision.outcome === 'DENY' && e.reasonCode === 'QUOTE_EXPIRED' &&
        e.quoteReasonCode === 'QUOTE_EXPIRED' &&
        e.quote.expiredByTime === true && e.quote.state === 'OPEN';
    })());
  check('D8 评估一份已经终态的报价：结论是 DENY，且原因与"预算不够"分开',
    (() => {
      /* 用一条已经 EXPIRED 的报价（sweep 之后）。 */
      const q = createQuoteOk(store, { amountMinor: 100, expiresAt: clock() + 1000 });
      clock.advance(2000);
      store.expireQuote({ quoteId: q.quoteId, now: clock() });
      const e = store.evaluateQuote({ quoteId: q.quoteId, now: clock() });
      clock.advance(-2000);
      return e.decision.outcome === 'DENY' && e.quoteReasonCode === 'QUOTE_EXPIRED' &&
        e.quote.state === 'EXPIRED' && e.quote.terminal === true;
    })());
  check('D9 评估一份不存在的报价 / 非法 id：明确失败，不返回"一份空报价"',
    store.evaluateQuote({ quoteId: 'econ_quote_nope' }).ok === false &&
    store.evaluateQuote({ quoteId: 'not-a-quote-id' }).ok === false);
  check('D10 显式 now 被采纳（同一份报价在两个时刻可以得到两个结论）',
    (() => {
      const q = createQuoteOk(store, { amountMinor: 100, expiresAt: clock() + 60000 });
      const early = store.evaluateQuote({ quoteId: q.quoteId, now: clock() });
      const late = store.evaluateQuote({ quoteId: q.quoteId, now: clock() + 120000 });
      return early.decision.outcome === 'ALLOW' && late.reasonCode === 'QUOTE_EXPIRED';
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · 金额与币种不可变（§9）
   ══════════════════════════════════════════════════════════════════ */
section('E · 金额 / 币种 / 买家不可变：改价必须开一份新报价');

{
  const clock = mutableClock();
  const dir = tmpDir('immutable');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  walletWith(store, 1000n);

  const q = createQuoteOk(store, { amountMinor: 250, expiresAt: clock() + 60000 });
  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));

  /* 静态证据：唯一写 quotes 的 UPDATE 的 SET 列里没有经济内容列。 */
  const stmt = String(store._internal.SQL.setQuoteState);
  check('E1 唯一一条写 quotes 的 UPDATE 的 SET 列**逐列**是生命周期列',
    /SET state=\?, revision=\?, updated_at=\? WHERE quote_id=\? AND state=\?/.test(stmt) &&
    ['amount_minor', 'currency', 'buyer_id', 'product_id', 'quantity', 'quote_kind',
      'service_role', 'expires_at', 'created_at'].every(c => stmt.indexOf(c) < 0),
    stmt);
  check('E2 生产文件里**没有**第二形态的写语句（不存在 UPDATE quotes SET amount_minor 这类）',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
      return !/SET[^']*amount_minor[^']*WHERE quote_id/.test(src) &&
        !/SET[^']*currency[^']*WHERE quote_id/.test(src);
    })());

  /* 运行时证据：**正确**的改价形态是开一份新报价并链回旧的；而已有的
     报价行一旦写下，它的金额就不该再被任何代码路径改写。这里的做法是
     直接对**真实 SQLite** 做一次"外部工具式"的篡改，再看 store 的反应 ——
     这比读一遍 SQL 更能说明问题：篡改能改到那个数（SQLite 不管语义），
     但**没有任何 store API 会造成它**，而且派生列一旦不一致，
     store 的完整性检查会说"报价这一面不可信"。 */
  check('E3 唯一写 quotes 的那条 SQL 是**唯一**入口：store 的公开面上不存在 updateQuoteAmount 之类的 API',
    Object.keys(store).concat(Object.keys(store._internal)).every(k =>
      !/^setQuote(?!State)|updateQuote|changeQuote|reprice/i.test(k)) &&
    /SET state=\?, revision=\?, updated_at=\?/.test(String(store._internal.SQL.setQuoteState)));
  check('E4 结算形态（派生列）被外部改坏时，完整性检查会抓住它（不是静默接受）',
    (() => {
      const db = new DatabaseSync(store.health().file);
      db.prepare('UPDATE ' + store.TABLES.QUOTES + ' SET service_role=? WHERE quote_id=?').run('GIFT', q.quoteId);
      const row = db.prepare('SELECT * FROM ' + store.TABLES.QUOTES + ' WHERE quote_id=?').get(q.quoteId);
      db.close();
      const found = store._internal.quoteProblemsOf(row);
      /* 复原。 */
      const d2 = new DatabaseSync(store.health().file);
      d2.prepare('UPDATE ' + store.TABLES.QUOTES + ' SET service_role=? WHERE quote_id=?')
        .run(C.settlementTypeOfQuoteKind('PURCHASE'), q.quoteId);
      d2.close();
      return found.length === 1 && found[0].indexOf('settlement-type-does-not-match-the-quote-kind') >= 0;
    })(),
    (() => {
      const db = new DatabaseSync(store.health().file);
      const row = db.prepare('SELECT * FROM ' + store.TABLES.QUOTES + ' WHERE quote_id=?').get(q.quoteId);
      db.close();
      return store._internal.quoteProblemsOf(row);
    })());
  check('E5 改价的**正确**形态：开一份新报价并链回旧的那一份（历史报价不被修改）',
    (() => {
      const newer = createQuoteOk(store, {
        amountMinor: 300, expiresAt: clock() + 120000, predecessorQuoteId: q.quoteId
      });
      const old = store.getQuote({ quoteId: q.quoteId }).quote;
      /* 两种表示刻意不同：createQuote 的**结果**是序列化形态（十进制
         字符串），getQuote 的读回是 canonical（BigInt）。 */
      return newer.amountMinor === '300' && old.amountMinor === 250n &&
        newer.quote.predecessorQuoteId === q.quoteId && old.predecessorQuoteId === null &&
        old.state === 'OPEN';
    })());
  check('E6 链上不允许分叉：同一份被替代的报价只可能有一条后继（UNIQUE 索引兜底）',
    (() => {
      const second = store.createQuote({
        buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 400, productId: 'widget',
        predecessorQuoteId: q.quoteId, expiresAt: clock() + 60000, idempotencyKey: 'fork-1'
      });
      /* 两种可以接受的结局：写成一次**明确的拒绝**，或者抛出一个能读懂的
         错误 —— 但**绝不能**是一个静默的第二次插入。 */
      const successors = store.listQuotes({ buyerId: 'cfg_a' }).quotes
        .filter(x => x.predecessorQuoteId === q.quoteId);
      return second.ok === false && successors.length === 1;
    })(),
    (() => {
      const second = store.createQuote({
        buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 401, productId: 'widget',
        predecessorQuoteId: q.quoteId, expiresAt: clock() + 60000, idempotencyKey: 'fork-2'
      });
      return { ok: second.ok, errors: second.errors, code: second.code };
    })());
  check('E7 predecessorQuoteId 必须是 canonical 的 econ_quote_ id',
    store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 400, productId: 'widget',
      predecessorQuoteId: 'nope', expiresAt: clock() + 60000, idempotencyKey: 'pred-1'
    }).ok === false);
  raw.close();
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · 状态机与终态不可回退（§8）
   ══════════════════════════════════════════════════════════════════ */
section('F · 报价状态机：OPEN 是唯一的非终态，CONSUMED / EXPIRED 不可回退');

{
  const clock = mutableClock();
  const dir = tmpDir('state');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  walletWith(store, 1000n);

  check('F1 契约的转移表：OPEN → {CONSUMED, EXPIRED}，其余三条边全部不允许',
    C.canTransitionQuote('OPEN', 'CONSUMED').allowed === true &&
    C.canTransitionQuote('OPEN', 'EXPIRED').allowed === true &&
    C.canTransitionQuote('OPEN', 'OPEN').allowed === false &&
    C.CONSUMED === undefined &&
    C.QUOTE_STATES.every(to => C.canTransitionQuote('CONSUMED', to).allowed === false) &&
    C.QUOTE_STATES.every(to => C.canTransitionQuote('EXPIRED', to).allowed === false));
  check('F2 终态回退的失败信息指出"必须开一份新报价"（而不是一句泛泛的非法转移）',
    C.assertQuoteTransition('CONSUMED', 'OPEN').detail.indexOf('must-create-a-new-quote') >= 0 &&
    C.assertQuoteTransition('EXPIRED', 'OPEN').detail.indexOf('must-create-a-new-quote') >= 0);

  const q = createQuoteOk(store, { amountMinor: 100, expiresAt: clock() + 1000 });
  clock.advance(2000);
  const first = store.expireQuote({ quoteId: q.quoteId, now: clock() });
  check('F3 OPEN → EXPIRED 成功，且事件是 QUOTE_EXPIRED（不是 RELEASED、不是别的词）',
    first.ok === true && first.result.state === 'EXPIRED' &&
    first.result.ledgerMutation === false && first.result.reservedFunds === false &&
    store.listChanges(0, 500).filter(c => c.kind === 'QUOTE_EXPIRED').length === 1);
  check('F4 第二次 expire 是**幂等重放**（返回当初那个结果），不是"已经终态"的拒绝',
    (() => {
      const again = store.expireQuote({ quoteId: q.quoteId, now: clock() });
      return again.ok === true && again.replayed === true &&
        again.result.state === 'EXPIRED' && again.result.revision === first.result.revision;
    })());
  check('F5 换一个 idempotencyKey 再 expire：这一次是明确的拒绝（终态不可回退）',
    (() => {
      const other = store.expireQuote({ quoteId: q.quoteId, now: clock(), idempotencyKey: 'different-key' });
      return other.ok === false && other.reasonCode === 'TRANSITION_NOT_ALLOWED' &&
        store.getQuote({ quoteId: q.quoteId }).quote.state === 'EXPIRED';
    })());
  check('F6 终态不会被"再操作一次"改写：revision 与 updatedAt 都没动',
    (() => {
      const before = store.getQuote({ quoteId: q.quoteId }).quote;
      store.expireQuote({ quoteId: q.quoteId, now: clock() });
      const after = store.getQuote({ quoteId: q.quoteId }).quote;
      return J(before) === J(after);
    })());
  check('F7 未到期的报价不能被 expire（不提前作废别人的报价）',
    (() => {
      const fresh = createQuoteOk(store, { amountMinor: 100, expiresAt: clock() + 60000 });
      const out = store.expireQuote({ quoteId: fresh.quoteId, now: clock() });
      return out.ok === false && out.errors.indexOf('quote-not-yet-due') >= 0 &&
        store.getQuote({ quoteId: fresh.quoteId }).quote.state === 'OPEN';
    })());
  check('F8 状态推进带 `AND state=?` 守卫（并发安全 + 终态不可回退是一条 SQL 约束）',
    /SET state=\?, revision=\?, updated_at=\? WHERE quote_id=\? AND state=\?/
      .test(String(store._internal.SQL.setQuoteState)));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   G · 到期：显式 now、确定性、幂等、批量、无定时器
   ══════════════════════════════════════════════════════════════════ */
section('G · 到期是一个比较（expires_at <= now），不是任何调度');

{
  const clock = mutableClock();
  const dir = tmpDir('expiry');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  walletWith(store, 1000n);

  const due = [
    createQuoteOk(store, { amountMinor: 10, expiresAt: clock() + 1000 }),
    createQuoteOk(store, { amountMinor: 20, expiresAt: clock() + 2000 }),
    createQuoteOk(store, { amountMinor: 30, expiresAt: clock() + 3000 })
  ];
  const later = createQuoteOk(store, { amountMinor: 40, expiresAt: clock() + 600000 });
  const economicBefore = economicFingerprint(store);
  const revisionBefore = store.getRevision();

  check('G1 未到期时扫描什么都不做（scanned 0，revision 不动）',
    (() => {
      const sweep = store.expireDueQuotes({ now: clock() });
      return sweep.ok === true && sweep.scanned === 0 && sweep.expired.length === 0 &&
        sweep.usedTimers === false && store.getRevision() === revisionBefore;
    })());

  clock.advance(1500);
  check('G2 时间越过第一份的 expiresAt 之后：只有它到期，其余两份仍是 OPEN',
    (() => {
      const sweep = store.expireDueQuotes({ now: clock() });
      const states = due.map(q => store.getQuote({ quoteId: q.quoteId }).quote.state);
      return sweep.scanned === 1 && sweep.expired.length === 1 &&
        sweep.expired[0].quoteId === due[0].quoteId &&
        states.join(',') === 'EXPIRED,OPEN,OPEN';
    })());

  clock.advance(2000);
  check('G3 扫描是**分批且有序**的（按 expires_at 升序，同一次扫描顺序确定）',
    (() => {
      const sweep = store.expireDueQuotes({ now: clock() });
      return sweep.scanned === 2 && sweep.expired.length === 2 &&
        sweep.expired[0].quoteId === due[1].quoteId &&
        sweep.expired[1].quoteId === due[2].quoteId &&
        store.getQuote({ quoteId: later.quoteId }).quote.state === 'OPEN';
    })());
  check('G4 到期**不产生任何经济后果**：账本 / 预留 / available / 交易数逐字未变',
    economicFingerprint(store) === economicBefore,
    { before: economicBefore.slice(0, 240), after: economicFingerprint(store).slice(0, 240) });
  check('G5 到期扫描幂等：再扫一次什么都不做（同一次到期不可能有第二条 expiration）',
    (() => {
      const sweep = store.expireDueQuotes({ now: clock() });
      const kinds = store.listChanges(0, 500).map(c => c.kind);
      return sweep.scanned === 0 && sweep.expired.length === 0 &&
        kinds.filter(k => k === 'QUOTE_EXPIRED').length === 3;
    })());
  check('G6 每份到期各自消耗一个 revision，且 change log 仍是无洞序列',
    (() => {
      const all = store.listChanges(0, 500);
      return all.length === store.getRevision() && all.every((c, i) => Number(c.revision) === i + 1);
    })());
  check('G7 生产文件的**代码**里没有 setTimeout / setInterval（"到期"从来不靠一个调度）',
    !/\bset(?:Timeout|Interval)\b/.test(stripCommentsAndStrings(
      fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8'))),
    /* 注释里出现过这个词（解释"为什么不用定时器"）—— 扫代码而不是扫文本，
       否则唯一让它变绿的办法就是删掉那句解释。 */
    { hits: (stripCommentsAndStrings(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8'))
      .match(/set(?:Timeout|Interval)/g) || []) });
  check('G8 到期扫描接受**显式** now，并且刻意不把它算进幂等指纹（换一个 now 扫同一次到期是同一个决定）',
    (() => {
      const q = createQuoteOk(store, { amountMinor: 50, expiresAt: clock() + 1000 });
      clock.advance(2000);
      const a = store.expireQuote({ quoteId: q.quoteId, now: clock(), idempotencyKey: 'sweep-key' });
      const b = store.expireQuote({ quoteId: q.quoteId, now: clock() + 999999, idempotencyKey: 'sweep-key' });
      clock.advance(-2000);
      return a.ok === true && b.ok === true && b.replayed === true &&
        b.result.revision === a.result.revision;
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   H · 幂等（§11）
   ══════════════════════════════════════════════════════════════════ */
section('H · 幂等：同一个 key 在 QUOTE scope 下的重放与冲突');

{
  const clock = mutableClock();
  const dir = tmpDir('idem');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  walletWith(store, 1000n);

  const payload = { amountMinor: 120, expiresAt: clock() + 60000 };
  const first = createQuoteOk(store, Object.assign({ idempotencyKey: 'same-key' }, payload));
  const replay = store.createQuote(Object.assign({
    buyerId: 'cfg_a', currency: 'IB_CREDIT', productId: 'widget', idempotencyKey: 'same-key'
  }, payload));
  check('H1 同 key 同 payload ⇒ replayed:true，返回**原来**那份报价',
    replay.ok === true && replay.replayed === true &&
    replay.result.quoteId === first.quoteId && replay.result.revision === first.revision);
  check('H2 重放零副作用：报价数不变、revision 不动、QUOTE_CREATED 只有一条',
    store.health().counts.quotes === 1 && store.getRevision() === first.revision &&
    store.listChanges(0, 500).filter(c => c.kind === 'QUOTE_CREATED').length === 1);

  const variations = [
    ['金额', { amountMinor: 999 }],
    ['币种', { currency: 'COMPUTE_PREMIUM' }],
    ['买家', { buyerId: 'cfg_b' }],
    ['种类', { kind: 'GIFT', recipientId: 'cfg_b' }],
    ['到期时间', { expiresAt: clock() + 120000 }]
  ];
  variations.forEach(([label, over], i) => {
    const out = store.createQuote(Object.assign({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', productId: 'widget', idempotencyKey: 'same-key'
    }, payload, over));
    check('H' + (3 + i) + ' 同 key 不同' + label + ' ⇒ IDEMPOTENCY_CONFLICT（不静默返回第一次的结果）',
      out.ok === false && out.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0,
      out.errors);
  });
  check('H8 冲突被拒之后报价表与 revision **完全没变**（冲突检测在任何写入之前）',
    store.health().counts.quotes === 1 && store.getRevision() === first.revision);
  check('H9 quoteId 刻意**不在**指纹里：显式给一个不同的 quoteId 仍然是重放（不是冲突）',
    (() => {
      const out = store.createQuote(Object.assign({
        buyerId: 'cfg_a', currency: 'IB_CREDIT', productId: 'widget', idempotencyKey: 'same-key',
        quoteId: 'econ_quote_explicit_other'
      }, payload));
      return out.ok === true && out.replayed === true && out.result.quoteId === first.quoteId;
    })());
  check('H10 数字与字符串 key 归一成同一个身份',
    (() => {
      const a = store.createQuote({
        buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 5, productId: 'widget',
        expiresAt: clock() + 60000, idempotencyKey: 4242
      });
      const b = store.createQuote({
        buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 5, productId: 'widget',
        expiresAt: clock() + 60000, idempotencyKey: '4242'
      });
      return a.ok === true && b.replayed === true && b.result.quoteId === a.result.quoteId;
    })());
  check('H11 QUOTE 与 POLICY / RESERVE 是三个 scope：同一个 key 在别处不被误判',
    (() => {
      const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
      const rows = raw.prepare('SELECT scope, idempotency_key FROM ' + store.TABLES.OPERATION_IDEMPOTENCY)
        .all().filter(r => String(r.idempotency_key) === 'same-key');
      raw.close();
      return rows.length === 1 && String(rows[0].scope) === 'QUOTE';
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   I · 崩溃注入（§33）
   ══════════════════════════════════════════════════════════════════ */
section('I · 崩溃注入：报价写入的每一个故障点都必须整体回滚');

const QUOTE_FAULTS = [
  'after-quote-insert',
  'before-quote-change-log',
  'before-quote-commit',
  'after-quote-expire-validated',
  'after-quote-expired',
  'before-quote-expire-change-log',
  'before-quote-expire-commit'
];

QUOTE_FAULTS.forEach((fault, index) => {
  const dir = tmpDir('crash-' + index);
  let bang = false;
  const store = makeStore({
    dataDir: dir,
    faults: { hit: (name) => { if (name === fault && !bang) { bang = true; const e = new Error('injected:' + name); e.code = 'INJECTED_FAULT'; throw e; } } }
  });
  store.open();
  const w = walletWith(store, 500n);

  const expiring = fault.indexOf('expire') >= 0;
  let quoteId = null;
  if (expiring) {
    /* 先在不注入的状态下建一份报价（withdraw 之后需要它存在），
       再把它的 expiresAt 改到过去 —— 到期是一条数据，不是一个调度。 */
    const seedStore = store;
    const created = (() => {
      const out = seedStore.createQuote({
        buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 30, productId: 'widget',
        expiresAt: Date.now() + 1000, idempotencyKey: 'seed-quote'
      });
      assert.equal(out.ok, true, 'seed quote must succeed: ' + J(out.errors || out));
      return out.result;
    })();
    quoteId = created.quoteId;
    const rawSeed = new DatabaseSync(store.health().file);
    rawSeed.prepare('UPDATE ' + store.TABLES.QUOTES + ' SET expires_at=? WHERE quote_id=?')
      .run(Number(Date.now()) - 1000, quoteId);
    rawSeed.close();
  }

  /* 注入**之前**取真实基线。 */
  const rawBefore = new DatabaseSync(store.health().file);
  const base = {
    quotes: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.QUOTES).get().c),
    openQuotes: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.QUOTES + " WHERE state='OPEN'").get().c),
    changes: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.CHANGE_LOG).get().c),
    idempotency: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.OPERATION_IDEMPOTENCY).get().c),
    transactions: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.TRANSACTIONS).get().c),
    entries: Number(rawBefore.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.ENTRIES).get().c),
    revision: store.getRevision(),
    economics: economicFingerprint(store, true)
  };
  rawBefore.close();

  let threw = null;
  try {
    if (expiring) store.expireQuote({ quoteId: quoteId, now: Date.now() });
    else store.createQuote({
      buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 70, productId: 'widget',
      expiresAt: Date.now() + 60000, idempotencyKey: 'crash-quote'
    });
  } catch (error) { threw = error; }

  check('I' + (index + 1) + ' 故障点 ' + fault + '：抛出的是注入的错误（不是被吞掉）',
    threw !== null && threw.code === 'INJECTED_FAULT', threw && (threw.code || threw.message));

  const raw = new DatabaseSync(store.health().file);
  const quotes = raw.prepare('SELECT * FROM ' + store.TABLES.QUOTES).all();
  const idem = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.OPERATION_IDEMPOTENCY).get();
  const changes = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.CHANGE_LOG).get();
  const txs = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.TRANSACTIONS).get();
  const entries = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.ENTRIES).get();
  raw.close();

  check('I' + (index + 1) + 'b 故障点 ' + fault + '：没有留下部分报价（行数与状态都回到注入前）',
    quotes.length === base.quotes &&
    quotes.filter(r => String(r.state) === 'OPEN').length === base.openQuotes,
    { after: quotes.length, before: base.quotes });
  check('I' + (index + 1) + 'c 故障点 ' + fault + '：幂等表回到注入前的行数（重试能真的落地）',
    Number(idem.c) === base.idempotency, { after: Number(idem.c), before: base.idempotency });
  check('I' + (index + 1) + 'd 故障点 ' + fault + '：change log / 账本 / revision 全部回到注入前',
    Number(changes.c) === base.changes && Number(txs.c) === base.transactions &&
    Number(entries.c) === base.entries && store.getRevision() === base.revision &&
    economicFingerprint(store, true) === base.economics,
    { changes: Number(changes.c), before: base.changes, revision: store.getRevision(), revBefore: base.revision });

  /* 回滚之后**重试必须真的能落地**：这是"没有残留幂等行"的可执行含义。 */
  if (!expiring) {
    check('I' + (index + 1) + 'e 故障点 ' + fault + '：回滚之后用同一个 key 重试**真的**成功（且只成功一次）',
      (() => {
        /* `expiresAt` 必须**只算一次**：指纹覆盖它，两次调用各算一遍会
           ——哪怕只差一毫秒—— 得到两个不同的指纹，于是"重试"被判成
           IDEMPOTENCY_CONFLICT。这是 P22-3 §14 那条"绝对时间戳而不是
           ttlMs"的纪律在**测试**里的同一个形状。 */
        const expiresAt = Date.now() + 60000;
        const payload = {
          buyerId: 'cfg_a', currency: 'IB_CREDIT', amountMinor: 70, productId: 'widget',
          expiresAt: expiresAt, idempotencyKey: 'crash-quote'
        };
        const retry = store.createQuote(payload);
        const again = store.createQuote(payload);
        return retry.ok === true && retry.replayed === false &&
          again.ok === true && again.replayed === true &&
          again.result.quoteId === retry.result.quoteId &&
          store.health().counts.quotes === base.quotes + 1;
      })(),
      { quotes: store.health().counts.quotes, base: base.quotes });
  }
  store.close();
});

/* ══════════════════════════════════════════════════════════════════
   J · 重启恢复（§34）
   ══════════════════════════════════════════════════════════════════ */
section('J · 重启恢复：报价与它的一致性在 close → open 之后逐字相同');

{
  const clock = mutableClock();
  const dir = tmpDir('restart');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  walletWith(store, 1000n);
  const open1 = createQuoteOk(store, { amountMinor: 100, expiresAt: clock() + 600000 });
  const open2 = createQuoteOk(store, { amountMinor: 200, quantity: 2, expiresAt: clock() + 600000, kind: 'GIFT', recipientId: 'cfg_b' });
  const before = {
    quotes: store.listQuotes({ buyerId: 'cfg_a' }).quotes.map(q => store.serializeQuote(q)),
    revision: store.getRevision(),
    economics: economicFingerprint(store, true)
  };
  store.close();

  const reopened = makeStore({ dataDir: dir, clock: clock });
  const opened = reopened.open();
  check('J1 重启之后两份报价逐字还在（含 kind / settlementType / quantity / recipient）',
    J(reopened.listQuotes({ buyerId: 'cfg_a' }).quotes.map(q => reopened.serializeQuote(q))) === J(before.quotes),
    { before: before.quotes, after: reopened.listQuotes({ buyerId: 'cfg_a' }).quotes.map(q => reopened.serializeQuote(q)) });
  check('J2 重启**不**消耗 revision，也不写任何审计（一致性正常时什么都不写）',
    opened.ok === true && reopened.getRevision() === before.revision &&
    reopened.listChanges(0, 500).filter(c => c.kind === 'QUOTE_CREATED').length === 2);
  check('J3 重启之后账本 / 预留 / available 逐字未变（报价的存在没有影响过它们）',
    economicFingerprint(reopened, true) === before.economics);

  /* 离线过期：关机跨过 expiresAt。 */
  const beforeOffline = reopened.getRevision();
  reopened.close();
  clock.advance(30 * 24 * 3600 * 1000);      /* 离线 30 天 */
  const offline = makeStore({ dataDir: dir, clock: clock });
  offline.open();
  check('J4 离线跨过 expiresAt 之后，数据上那两份报价**仍然是 OPEN**（到期是比较出来的，不是调度写下来的）',
    offline.listQuotes({ buyerId: 'cfg_a' }).quotes.every(q => q.state === 'OPEN') &&
    offline.listQuotes({ buyerId: 'cfg_a' }).quotes.every(q => q.expiredByTime === true) &&
    offline.listQuotes({ buyerId: 'cfg_a' }).quotes.every(q => q.consumptionRequiredNow === true));
  check('J5 开库的对账**没有**把报价自动改状态（对账管的是缓存漂移，不是生命周期）',
    offline.getRevision() === beforeOffline &&
    offline.listChanges(0, 500).filter(c => c.kind === 'QUOTE_EXPIRED').length === 0);
  check('J6 离线过期之后评估立刻说不（不需要任何扫描就能回答"这份报价还能不能用"）',
    (() => {
      const e = offline.evaluateQuote({ quoteId: open1.quoteId, now: clock() });
      return e.decision.outcome === 'DENY' && e.reasonCode === 'QUOTE_EXPIRED';
    })());
  check('J7 扫一次之后两份都落定为 EXPIRED，且**没有**任何经济后果',
    (() => {
      /* 扫描**只**改报价的状态：账本 / 预留 / 钱包那一半必须逐字不变，
         而报价那一半当然会变（那是这次扫描的**目的**）。两个指纹分开比。 */
      const economics = economicFingerprint(offline);
      const quotes = economicFingerprint(offline, true);
      const sweep = offline.expireDueQuotes({ now: clock() });
      return sweep.expired.length === 2 &&
        offline.getQuote({ quoteId: open1.quoteId }).quote.state === 'EXPIRED' &&
        offline.getQuote({ quoteId: open2.quoteId }).quote.state === 'EXPIRED' &&
        economicFingerprint(offline) === economics &&
        economicFingerprint(offline, true) !== quotes &&
        offline.health().counts.openQuotes === 0;
    })());
  check('J8 再扫一次什么都不做（幂等），且两份报价各自恰好一条 QUOTE_EXPIRED',
    (() => {
      const sweep = offline.expireDueQuotes({ now: clock() });
      const kinds = offline.listChanges(0, 500).map(c => c.kind);
      return sweep.scanned === 0 && sweep.expired.length === 0 &&
        kinds.filter(k => k === 'QUOTE_EXPIRED').length === 2;
    })());
  offline.close();
}

/* ══════════════════════════════════════════════════════════════════
   K · API_QUOTA / COMPUTE_CREDIT 未来兼容性（§29）
   ══════════════════════════════════════════════════════════════════ */
section('K · 未来兼容性：模型今天就能表达 API_QUOTA / COMPUTE_CREDIT 报价，而 provider 一个字节都没碰');

{
  const clock = mutableClock();
  const dir = tmpDir('api-quota');
  const store = makeStore({ dataDir: dir, clock: clock });
  store.open();
  /* 买"算力额度"的钱包：币种是 COMPUTE_PREMIUM（compute tier），
     而**支付**用的是 IB_CREDIT —— 这两件事在报价里是两个字段。 */
  const wCredit = walletWith(store, 1000n, 'cfg_a', 'IB_CREDIT');
  const wCompute = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'COMPUTE_PREMIUM' });
  assert.equal(wCompute.ok, true, 'compute wallet must open: ' + J(wCompute.errors));
  store.mintForSystem({
    systemInitiated: true, walletId: wCompute.wallet.walletId, currency: 'COMPUTE_PREMIUM',
    amountMinor: 50n, idempotencyKey: 'seed-compute'
  });
  putPolicy(store, {
    limits: { perTransactionMinor: 100000, dailyMinor: 100000, weeklyMinor: 100000, monthlyMinor: 100000 }
  });

  const quota = createQuoteOk(store, {
    amountMinor: 400,                       /* 400 IB_CREDIT */
    quantity: 1000,                          /* 1000 个 computeUnit */
    productId: 'api-quota-premium-1000',
    kind: 'COMPUTE_GRANT',
    expiresAt: clock() + 600000
  });
  check('K1 一份 API 额度报价被如实表达：支付币种、数量、种类、结算形态四者齐全',
    quota.currency === 'IB_CREDIT' && quota.amountMinor === '400' &&
    quota.quantity === 1000 && quota.kind === 'COMPUTE_GRANT' &&
    quota.settlementType === 'COMPUTE_GRANT' &&
    quota.productId === 'econ_product_api-quota-premium-1000',
    quota);
  check('K2 结算形态落在**冻结的** transaction type 里（不需要新造 transaction 语义）',
    C.TX_TYPES.indexOf(quota.settlementType) >= 0 &&
    quota.settlementType === C.TX_TYPE.COMPUTE_GRANT &&
    C.QUOTE_SETTLEMENT_TYPE.COMPUTE_GRANT === C.TX_TYPE.COMPUTE_GRANT);
  check('K3 COMPUTE_GRANT 是 NEUTRAL：它不花这个 owner 的日额度（额度是**被授予**的）',
    C.isSpendingTransactionType('COMPUTE_GRANT') === false &&
    C.BUDGET_SPENDING_TYPES.indexOf('COMPUTE_GRANT') < 0);
  check('K4 评估这份报价仍然走同一套预算逻辑（用支付币种 IB_CREDIT 的窗口）',
    (() => {
      const e = store.evaluateQuote({ quoteId: quota.quoteId });
      return e.decision.outcome === 'ALLOW' &&
        e.walletSnapshot.availableBalanceMinor === '1000' &&
        e.budgetSnapshot.currency === 'IB_CREDIT';
    })(),
    store.evaluateQuote({ quoteId: quota.quoteId }).decision);
  check('K5 compute 币种**没有**被误当成支付币种：那份报价的预算作用域是 IB_CREDIT',
    (() => {
      const rows = new DatabaseSync(store.health().file)
        .prepare('SELECT currency FROM ' + store.TABLES.QUOTES + ' WHERE quote_id=?').get(quota.quoteId);
      return String(rows.currency) === 'IB_CREDIT';
    })());
  check('K6 Economy 的币种表里**只有**内部资源，没有任何 provider 余额代币（§24）',
    C.CURRENCIES.indexOf('PROVIDER_CREDITS') < 0 &&
    C.CURRENCIES.indexOf('OPENAI_BALANCE') < 0 &&
    C.FORBIDDEN_CURRENCY_TOKENS.indexOf('PROVIDER_CREDITS') >= 0 &&
    C.FORBIDDEN_CURRENCY_TOKENS.indexOf('PROVIDER_BALANCE') >= 0);
  check('K7 报价不携带 provider 额度余额（"隐蔽库存"的另一种形态）',
    (() => {
      const raw = new DatabaseSync(store.health().file);
      const cols = raw.prepare('PRAGMA table_info(' + store.TABLES.QUOTES + ')').all().map(r => String(r.name));
      raw.close();
      return !cols.some(c => /quota|provider|balance|credit_balance/i.test(c));
    })());
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   L · provider / payment 隔离（静态）
   ══════════════════════════════════════════════════════════════════ */
section('L · 报价这一层不碰 provider 与真实支付');

{
  const storeCode = stripCommentsAndStrings(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8'));
  const contractCode = stripCommentsAndStrings(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'), 'utf8'));
  const VERBS = ['topUpProvider', 'purchaseProviderCredits', 'updateProviderBalance', 'providerPayment',
    'sendPayment', 'submitPayment', 'commitSpend', 'topUp', 'topup'];
  check('L1 生产文件的**代码**里没有任何 provider 充值 / 支付 / 凭据动词',
    VERBS.every(v => storeCode.indexOf(v) < 0) &&
    ['topUpProvider', 'purchaseProviderCredits', 'updateProviderBalance', 'providerPayment',
      'sendPayment', 'submitPayment'].every(v => contractCode.indexOf(v) < 0),
    { store: VERBS.filter(v => storeCode.indexOf(v) >= 0), contract: VERBS.filter(v => contractCode.indexOf(v) >= 0) });
  check('L2 没有 require 到支付 / 购物 / 凭据模块',
    (() => {
      const reqs = (fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8')
        .match(/require\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g) || []).join(' ');
      return !/commerce|pay-gate|alipay|payment|credential-vault|shopping/.test(reqs);
    })());
  check('L3 "topup" 只作为**否认数据**出现（doesNotExpose 的那一项），代码里没有这个动词',
    storeCode.toLowerCase().indexOf('topup') < 0 &&
    /doesNotExpose: \[[^\]]*'topup'/.test(fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8')));
  check('L4 报价的读取面刻意不含 idempotencyKey（请求标识不需要被广播）',
    (() => {
      const q = { domain: 'ib.economy', namespace: 'ib.economy.quote', quoteId: 'econ_quote_x',
        productId: 'p', buyerId: { type: 'character', id: 'a' }, recipientId: null,
        currency: 'IB_CREDIT', amountMinor: 1n, quantity: 1, kind: 'PURCHASE',
        settlementType: 'PURCHASE', state: 'OPEN', terminal: false, expiresAt: 1,
        expiredByTime: false, predecessorQuoteId: null, idempotencyKey: 'secret', revision: 1,
        createdAt: 1, updatedAt: 1 };
      const store = makeStore({ dataDir: tmpDir('serialize') });
      store.open();
      const out = store.serializeQuote(q);
      store.close();
      return !('idempotencyKey' in out) && out.amountMinor === '1';
    })());
}
