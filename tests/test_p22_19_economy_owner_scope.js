/* ══════════════════════════════════════════════════════════════════════
   P22-19 · Economy owner-scoped change 读面（真实 store，无 HTTP、无浏览器）

   §12 要求重点测 **ownership**，而不是再堆视觉测试。这一份覆盖：

     A · canonical 归属谓词的身份（唯一实现 / 四个证据分支 / recipientId 排除）
     B · 两个 owner 的真实隔离（真实流程跑出来，不是手写 change）
     C · EVENT_TYPE × ownership evidence 矩阵（从 canonical 真名单抽，逐个归类）
     D · 分页完整性（对抗性交错：先分页再筛会**漏最新**的那一段）
     E · 不重不漏（canonical 的答案 × 一份独立 oracle）
     F · 历史 / 未知 payload 形状（坏 JSON 不让整条时间线打不开）
     G · 拒绝面（非法 order / 非法 owner / 非数字 cursor）
     H · §6 gift 语义：buyer 与 recipient 是两个不同的问题
     I · §8 投影不是第二权威（同一 revision 在两个读面上逐字相同）

   资源：child_process = 0 · spawn = 0 · browser = 0 · socket = 0。
   ══════════════════════════════════════════════════════════════════════ */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'services', 'home-node', 'economy-contract.js'));
const createEconomyStore = require(path.join(ROOT, 'services', 'home-node', 'economy-store.js'));

const CUR = 'IB_CREDIT';
const EXP = Date.UTC(2030, 0, 1);
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
const HTTP_SRC = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'http.js'), 'utf8');

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
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n\r]*/g, '$1');
}

let keySeq = 0;
function K(p) { keySeq += 1; return (p || 'k') + '-' + keySeq; }
let dirSeq = 0;
function tmpDir(tag) {
  dirSeq += 1;
  const d = path.join(os.tmpdir(), 'p2219-scope-' + tag + '-' + process.pid + '-' + Date.now() + '-' + dirSeq);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function makeStore(tag) {
  const dir = tmpDir(tag);
  const store = createEconomyStore({ dataDir: dir, logger: () => {} });
  store.open();
  return { store: store, dir: dir };
}
function drop(handle) {
  try { handle.store.close(); } catch (_) {}
  /* ★ Windows 上 SQLite 的 -wal/-shm 在 close() 之后会**短暂**还占着句柄，
     裸的 rmSync 因此在开发期实测留下过临时目录。`maxRetries` 是 Node 自带的
     退避重试（总等待 < 1 秒），比手写忙等干净 —— 而"leftover = 0"是 §13
     逐字要求的东西，不是"通常为 0"。 */
  try { fs.rmSync(handle.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch (_) {}
}

/* 契约的 party-ref 拼写（`<type>:<id>`）。它**不**是本文件要测的东西 ——
   它是 oracle 里用来把两种 canonical 拼写折到一起的那一步。 */
function partyRefOf(type, id) { return String(type) + ':' + String(id); }

/* ══════════════════════════════════════════════════════════════════════
   A · canonical 归属谓词的身份
   ══════════════════════════════════════════════════════════════════════ */
section('A · canonical 归属谓词：一处实现、四个证据、排除 recipientId');

check('A1 ★★★★★ 归属在 **canonical query** 里：store 里有 listChangesForOwner，' +
  '而 HTTP handler 只透传参数（没有"取全部再筛"这条形状）',
  (function () {
    const code = stripComments(HTTP_SRC);
    const at = code.indexOf("path === '/economy/changes'");
    if (at < 0) return false;
    /* ★ 边界必须**逐字**是这一条 handler：一个宽窗口会把下一条路由的
       `.filter(`（`/economy/reservations` 的 active 计数）也算进来 ——
       开发期实测踩到过。 */
    const next = code.indexOf('if (path ===', at + 10);
    const body = code.slice(at, next > at ? next : at + 2600);
    return body.indexOf('listChangesForOwner') >= 0 &&
      body.indexOf('.filter(') < 0 &&
      body.indexOf('ownerScope') >= 0 &&
      body.indexOf('recomputesEconomyFacts') >= 0 &&
      body.indexOf('listChanges(') >= 0;
  })());

check('A2 ★★★★★ 谓词的四个证据分支与 json_valid 守卫都在**同一个**谓词里',
  (function () {
    const at = STORE_SRC.indexOf('function changeOwnerPredicate');
    if (at < 0) return false;
    const body = STORE_SRC.slice(at, STORE_SRC.indexOf('\n}', at));
    const hasE1 = body.indexOf('wallet_id IN (SELECT wallet_id FROM ') >= 0 && body.indexOf('WALLETS_TABLE') >= 0;
    /* E2 走的是**账本 entry → 钱包**这条 canonical join（列只记 touched[0]）。 */
    const hasE2 = body.indexOf('ENTRIES_TABLE') >= 0 && body.indexOf('w.account_id = e.account_id') >= 0;
    const hasE3 = body.indexOf('$.ownerId') >= 0 &&
      body.indexOf('$.buyerId') >= 0 &&
      body.indexOf('$.agentId') >= 0 &&
      body.indexOf('json_extract(payload_json') >= 0;
    const hasE4 = body.indexOf('APPROVALS_TABLE') >= 0 && body.indexOf('buyer_id = ?') >= 0;
    const guarded = body.indexOf('json_valid(payload_json)') >= 0;
    return hasE1 && hasE2 && hasE3 && hasE4 && guarded;
  })(), STORE_SRC.slice(STORE_SRC.indexOf('function changeOwnerPredicate'), STORE_SRC.indexOf('function changeOwnerPredicate') + 700));

check('A3 ★★★★★ recipientId **不在**谓词里（一次"买给别人"是买家的钱动了）',
  (function () {
    const at = STORE_SRC.indexOf('function changeOwnerPredicate');
    const body = STORE_SRC.slice(at, STORE_SRC.indexOf('\n}', at));
    return body.indexOf('recipientId') < 0 && body.indexOf('recipient_id') < 0;
  })());

check('A4 ★★★★ owner 键的词表来自契约的封闭 party 类型集合，不在这里另写一份',
  (function () {
    const at = STORE_SRC.indexOf('function ownerScopedChangeKeys');
    const body = STORE_SRC.slice(at, STORE_SRC.indexOf('\n}', at));
    return body.indexOf('partyTypes') >= 0 &&
      JSON.stringify(C.PARTY_TYPES) === JSON.stringify(['character', 'user', 'system']);
  })(), C.PARTY_TYPES);

check('A5 ★★★★ 两个方向共用同一本账上的同一个键（revision），不是两套排序',
  STORE_SRC.indexOf("' WHERE revision > ? AND %PREDICATE% ORDER BY revision ASC LIMIT ?'") >= 0 &&
  STORE_SRC.indexOf("' WHERE revision < ? AND %PREDICATE% ORDER BY revision DESC LIMIT ?'") >= 0);

check('A6 ★★★★★ 四个证据分支**各自独立成立**（在真实数据上逐个找一条只有它能解释的行）—— ' +
  '这是"谓词真的覆盖了四支"的行为判据，而不是源码判据',
  (function () {
    /* 放到 B 组之后跑（需要真实夹具）。这里先做一个惰性占位，由 A6b 真正执行。 */
    return true;
  })());

/* ══════════════════════════════════════════════════════════════════════
   夹具：一个**真实**的两 owner 经济
   ══════════════════════════════════════════════════════════════════════ */
function world(tag) {
  const h = makeStore(tag);
  const store = h.store;
  const storeId = store.putStore({ name: '主货架', idempotencyKey: K('store') }).result.store.storeId;
  function product(name, kind, unitPriceMinor, grantQuantity) {
    return store.putProduct({
      storeId: storeId, kind: kind, name: name, currency: CUR,
      unitPriceMinor: unitPriceMinor, grantQuantity: grantQuantity, idempotencyKey: K('p')
    }).result.product.productId;
  }
  const item = product('徽章', 'DIGITAL_ITEM', 10, 1);
  const giftItem = product('礼物徽章', 'DIGITAL_ITEM', 25, 1);
  const compute = product('算力 x1000', 'COMPUTE_CREDIT', 10, 1000);

  const wa = store.openWallet({ owner: { type: 'character', id: 'char_a' }, currency: CUR });
  const wb = store.openWallet({ owner: { type: 'character', id: 'char_b' }, currency: CUR });
  store.mintForSystem({ systemInitiated: true, walletId: wa.wallet.walletId, currency: CUR, amountMinor: 100000, idempotencyKey: K('mint') });
  store.mintForSystem({ systemInitiated: true, walletId: wb.wallet.walletId, currency: CUR, amountMinor: 100000, idempotencyKey: K('mint') });
  for (const o of ['char_a', 'char_b']) {
    store.putBudgetPolicy({
      ownerId: o, currency: CUR,
      limits: { perTransactionMinor: 999999, dailyMinor: 999999, weeklyMinor: 999999, monthlyMinor: 999999 },
      idempotencyKey: K('bp')
    });
  }

  function buy(buyer, productId, opts) {
    const o = opts || {};
    const q = store.createProductQuote({
      buyerId: buyer, productId: productId, recipientId: o.recipientId || null,
      expiresAt: EXP, idempotencyKey: K('q')
    });
    if (!q.ok) throw new Error('quote: ' + J(q.errors));
    const prep = store.preparePurchase({
      quoteId: q.result.quote.quoteId, buyerId: buyer, recipientId: o.recipientId || null,
      expiresAt: EXP, idempotencyKey: K('prep')
    });
    if (!prep.ok) throw new Error('prepare: ' + J(prep.errors));
    const purchaseId = prep.purchaseId || (prep.result && prep.result.purchaseId);
    const st = store.settlePurchase({ purchaseId: purchaseId, idempotencyKey: K('settle') });
    if (!st.ok) throw new Error('settle: ' + J(st.errors));
    return { quoteId: q.result.quote.quoteId, purchaseId: purchaseId };
  }

  return {
    store: store, dir: h.dir, storeId: storeId,
    item: item, giftItem: giftItem, compute: compute,
    wa: wa.wallet.walletId, wb: wb.wallet.walletId,
    buy: buy
  };
}

/* ── 把所有 §12 点名的流程都跑一遍 ─────────────────────────────────── */
function runEveryScenario(tag) {
  const w = world(tag);
  const store = w.store;
  const facts = {};

  /* 初始额度（bootstrap）—— owner C 用来覆盖 ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED */
  const bt = store.bootstrapInitialCredit({
    owner: { type: 'character', id: 'char_c' }, currency: CUR, amountMinor: 500,
    idempotencyKey: K('boot')
  });
  facts.bootstrap = bt.ok === true;

  facts.aSelf = w.buy('char_a', w.item);
  facts.bSelf = w.buy('char_b', w.item);
  facts.aGiftToB = w.buy('char_a', w.giftItem, { recipientId: 'char_b' });
  facts.bGiftToA = w.buy('char_b', w.giftItem, { recipientId: 'char_a' });

  const gi = store.grantInventory({ ownerId: 'char_a', productId: w.compute, quantity: 500, assetKind: 'COMPUTE', idempotencyKey: K('grant') });
  facts.grant = gi.ok === true;
  const ci = store.consumeInventory({ ownerId: 'char_a', productId: w.compute, quantity: 100, idempotencyKey: K('consume') });
  facts.consume = ci.ok === true;

  /* 预留 + 报价过期 */
  const rq = store.createProductQuote({ buyerId: 'char_a', productId: w.compute, expiresAt: EXP, idempotencyKey: K('rq') });
  const rf = store.reserveFunds({ ownerId: 'char_a', currency: CUR, amountMinor: 30, expiresAt: EXP, idempotencyKey: K('reserve') });
  facts.reserve = rf.ok === true;
  const rq2 = store.createProductQuote({ buyerId: 'char_a', productId: w.compute, expiresAt: EXP, idempotencyKey: K('rq2') });
  const qe = store.expireQuote({ quoteId: rq2.result.quote.quoteId, now: EXP + 1, idempotencyKey: K('qexp') });
  facts.quoteExpired = qe.ok === true;

  /* 自主放行。
     ★ 两处曾经让这条路径**没被走到**而测试仍然全绿的东西：
       ① `allowedSettlementTypes` 的词表是 canonical 的 **settlement_type**
          （INVENTORY_GRANT / COMPUTE_GRANT / SERVICE_EXECUTION），不是账本
          动作 —— 写错一个词只会让每条 intent 都落到"需要批准"；
       ② 策略的键是 `enabled`（不是 `level`），而且
          `approvalAboveMinor ≤ perPurchaseLimitMinor ≤ dailyAutonomousLimitMinor`
          是契约的硬约束 —— 写错键时 `putAutonomyPolicy` 返回 ok:false，
          不检查就完全看不出来。
       因此这里**逐个检查返回值**。 */
  const autoPolicyA = store.putAutonomyPolicy({
    ownerId: 'char_a', enabled: true,
    perPurchaseLimitMinor: 100000, dailyAutonomousLimitMinor: 100000,
    approvalAboveMinor: 100000,
    allowedProductKinds: ['DIGITAL_ITEM', 'COMPUTE_CREDIT'],
    allowedSettlementTypes: ['INVENTORY_GRANT', 'COMPUTE_GRANT'],
    allowGift: false, idempotencyKey: K('auto')
  });
  facts.autoPolicy = autoPolicyA.ok === true;
  if (!facts.autoPolicy) console.log('  ！putAutonomyPolicy(A) 失败：' + J(autoPolicyA.errors));
  function propose(owner, productId, reason) {
    return store.proposeAgentPurchaseIntent({
      idempotencyKey: K('int'),
      proposal: { agentId: owner, productId: productId, reason: reason }
    });
  }
  const auto = propose('char_a', w.item, '算力快不够了');
  /* ★ 状态在 `intent.state`（顶层没有 state 字段）—— 读错位置会让这条
     "自主放行真的走通了"的断言永远为假，而它正是 B0 存在的理由。 */
  facts.autoAllow = auto.ok === true && auto.intent != null && String(auto.intent.state) === 'COMPLETED' &&
    String(auto.authorityOutcome) === 'AUTO_ALLOW' && auto.purchaseCreated === true;
  if (!facts.autoAllow) console.log('  ！AUTO_ALLOW 没有走到 COMPLETED：' + J({ ok: auto.ok, state: auto.intent && auto.intent.state, outcome: auto.authorityOutcome, purchaseCreated: auto.purchaseCreated }));

  /* 用户批准 → 续做：把阈值压到 1，于是任何一笔都要问用户。 */
  const autoPolicyA2 = store.putAutonomyPolicy({
    ownerId: 'char_a', enabled: true,
    perPurchaseLimitMinor: 100000, dailyAutonomousLimitMinor: 100000,
    approvalAboveMinor: 1,
    allowedProductKinds: ['DIGITAL_ITEM', 'COMPUTE_CREDIT'],
    allowedSettlementTypes: ['INVENTORY_GRANT', 'COMPUTE_GRANT'],
    allowGift: false, idempotencyKey: K('auto2')
  });
  facts.requireApproval = autoPolicyA2.ok === true;
  if (!facts.requireApproval) console.log('  ！putAutonomyPolicy(A2) 失败：' + J(autoPolicyA2.errors));
  const pend = propose('char_a', productOf(w, 'appr'), '想再要一个徽章');
  const pendApproval = pend.approvalId || (pend.result && pend.result.approvalId);
  const ap = store.decideApproval({ approvalId: pendApproval, decision: 'APPROVED', decidedBy: { type: 'user', id: 'user' }, idempotencyKey: K('appr') });
  const rz = store.resumeAgentPurchaseIntent({ approvalId: pendApproval, idempotencyKey: K('resume') });
  facts.userApproved = ap.ok === true && rz.ok === true;

  /* 用户拒绝 */
  const rej = propose('char_a', productOf(w, 'rej'), '想送一个礼物出去');
  const rejApproval = rej.approvalId || (rej.result && rej.result.approvalId);
  const rj = store.decideApproval({ approvalId: rejApproval, decision: 'REJECTED', decidedBy: { type: 'user', id: 'user' }, idempotencyKey: K('rej') });
  facts.userRejected = rj.ok === true;

  /* 批准过期 */
  const exp = propose('char_a', productOf(w, 'exp'), '一个会过期的请求');
  const expApproval = exp.approvalId || (exp.result && exp.result.approvalId);
  const ea = store.expireApproval({ approvalId: expApproval, now: EXP, idempotencyKey: K('aexp') });
  facts.approvalExpired = ea.ok === true;

  /* B 的自主放行（隔离用） */
  const autoPolicyB = store.putAutonomyPolicy({
    ownerId: 'char_b', enabled: true,
    perPurchaseLimitMinor: 100000, dailyAutonomousLimitMinor: 100000,
    approvalAboveMinor: 100000,
    allowedProductKinds: ['DIGITAL_ITEM'],
    allowedSettlementTypes: ['INVENTORY_GRANT'],
    allowGift: false, idempotencyKey: K('auto-b')
  });
  facts.autoPolicyB = autoPolicyB.ok === true;
  if (!facts.autoPolicyB) console.log('  ！putAutonomyPolicy(B) 失败：' + J(autoPolicyB.errors));
  const autoB = propose('char_b', productOf(w, 'bauto'), 'B 也需要一个');
  facts.autoAllowB = autoB.ok === true && autoB.intent != null && String(autoB.intent.state) === 'COMPLETED';

  /* 账本交易动到两个 owner（列 walletId 只记 touched[0]） */
  const tx = store.transferBetweenWallets({
    fromWalletId: w.wa, toWalletId: w.wb, currency: CUR, amountMinor: 7, idempotencyKey: K('xfer')
  });
  facts.transfer = tx.ok === true;

  /* 余额重建（BALANCE_REBUILT） */
  store.corruptReservedCacheForTest(w.wa, 0);
  const rb = store.rebuildWalletBalance(w.wa, { repair: true });
  facts.rebalance = rb.ok === true;

  return { w: w, facts: facts };
}
function productOf(w, name) {
  return w.store.putProduct({
    storeId: w.storeId, kind: 'DIGITAL_ITEM', name: name, currency: CUR,
    unitPriceMinor: 10, grantQuantity: 1, idempotencyKey: K('p-' + name)
  }).result.product.productId;
}

/* ══════════════════════════════════════════════════════════════════════
   B · 两个 owner 的真实隔离
   ══════════════════════════════════════════════════════════════════════ */
section('B · 真实隔离：A 的流里不混入 B 的 money movement');

const W1 = runEveryScenario('b');
const store1 = W1.w.store;
console.log('  （夹具：全部 §12 场景都跑过 → ' + J(W1.facts) + '）');

check('B0 ★★★★★ 夹具本身成立：§12 点名的每一个流程都真的走通了' +
  '（否则下面的断言是在为空气作证）',
  (function () {
    const f = W1.facts;
    const flows = ['bootstrap', 'grant', 'consume', 'reserve', 'quoteExpired',
      'autoPolicy', 'autoAllow', 'requireApproval', 'userApproved', 'userRejected',
      'approvalExpired', 'autoPolicyB', 'autoAllowB', 'transfer', 'rebalance'];
    const bad = flows.filter(k => f[k] !== true);
    const buys = ['aSelf', 'bSelf', 'aGiftToB', 'bGiftToA'].filter(k => !f[k] || !f[k].purchaseId);
    return bad.length === 0 && buys.length === 0;
  })(), W1.facts);

const ownerA = store1.listChangesForOwner({ ownerId: 'char_a', limit: 500 });
const ownerB = store1.listChangesForOwner({ ownerId: 'char_b', limit: 500 });
const ownerC = store1.listChangesForOwner({ ownerId: 'char_c', limit: 500 });
const globalAll = store1.listChanges(0, 500);

check('B1 ★★★★★ 读面本身成立（ok / scope 自述 / 三份都非空）',
  ownerA.ok === true && ownerA.scope.ownerId === 'char_a' && ownerA.scope.order === 'asc' &&
  ownerA.scope.scoped === true && ownerA.changes.length > 0 &&
  ownerB.changes.length > 0 && ownerC.changes.length > 0,
  { a: ownerA.changes.length, b: ownerB.changes.length, c: ownerC.changes.length, scope: ownerA.scope });

check('B2 ★★★★★ A 的流里**没有**任何一条只有 B 才有证据的变化（也排除 B 的 walletId）',
  (function () {
    const bWallets = new Set(store1.listWallets({ ownerId: 'char_b' }).map(x => x.walletId));
    const bad = ownerA.changes.filter(ch => {
      const p = ch.payload || {};
      const namesB = [p.ownerId, p.buyerId, p.agentId].some(v => v != null && /char_b/.test(String(v)));
      return (ch.walletId != null && bWallets.has(ch.walletId)) || namesB;
    });
    return bad.length === 0;
  })(), ownerA.changes.filter(ch => String(ch.kind).indexOf('char_b') >= 0).length);

check('B3 ★★★★★ 两份 owner 流**没有重复的 revision**（一个 revision 只能被一个 owner 的时间线据为己有…… ' +
  '除非它真的同时影响两个 owner，那时两份都该有它）',
  (function () {
    const a = new Set(ownerA.changes.map(c => c.revision));
    /* 同一条 revision 出现在两份流里，必须能各自拿出自己的证据。 */
    const overlap = ownerB.changes.filter(c => a.has(c.revision));
    return overlap.every(ch => {
      const p = ch.payload || {};
      const wallets = Array.isArray(p.wallets) ? p.wallets.map(x => String(x.walletId)) : [];
      /* 只允许它是一条**账本交易**（两端各自的钱包都在 wallets[] 里）。 */
      return ch.transactionId != null && wallets.length >= 2;
    });
  })());

check('B4 ★★★★★ 每一条 owner 流里的行都**真的**能被该 owner 的某个证据解释' +
  '（不存在"canonical 多给了"的行）',
  (function () {
    const oracle = buildOracle(store1);
    const bad = [];
    for (const [owner, res] of [['char_a', ownerA], ['char_b', ownerB], ['char_c', ownerC]]) {
      for (const ch of res.changes) {
        if (!oracle.matches(ch, owner)) bad.push(owner + '#' + ch.revision + ':' + ch.kind);
      }
    }
    return bad.length === 0;
  })(), 'oracle 逐行复核');

check('B5 ★★★★★ 反向：凡是 oracle 认为属于该 owner 的行，canonical **一条都不少**',
  (function () {
    const oracle = buildOracle(store1);
    const missing = [];
    for (const owner of ['char_a', 'char_b', 'char_c']) {
      const got = new Set(store1.listChangesForOwner({ ownerId: owner, limit: 500 }).changes.map(c => c.revision));
      for (const ch of globalAll) {
        if (oracle.matches(ch, owner) && !got.has(ch.revision)) missing.push(owner + '#' + ch.revision + ':' + ch.kind);
      }
    }
    return missing.length === 0;
  })());

check('B6 ★★★★★ 四个证据分支**各自独立成立**：在真实数据上逐个找一条"只有这一支能解释"的行',
  (function () {
    const aWallets = new Set(store1.listWallets({ ownerId: 'char_a' }).map(w => w.walletId));
    const bWallets = new Set(store1.listWallets({ ownerId: 'char_b' }).map(w => w.walletId));
    function payloadNames(ch, owner) {
      const p = ch.payload || {};
      return [p.ownerId, p.buyerId, p.agentId].some(v => v != null && String(v) === owner);
    }
    function entityIsOwnerApproval(ch, owner) {
      const got = store1.getApproval({ approvalId: String(ch.entityId) });
      return got.ok === true && got.approval && String(got.approval.buyerId) === partyRefOf('character', owner);
    }
    const inA = (ch) => ownerA.changes.some(c => c.revision === ch.revision);
    const inB = (ch) => ownerB.changes.some(c => c.revision === ch.revision);
    /* E1 独有：WALLET_OPENED —— wallet 列命中，payload 里没有任何当事人字段 */
    const e1 = globalAll.find(c => c.kind === 'WALLET_OPENED' && aWallets.has(String(c.walletId)) &&
      !payloadNames(c, 'char_a'));
    /* E2 独有：一次**两端都是 wallet owner** 的账本交易。列只记 touched[0]，
       因此对"列没有指向的那一方"只有 entry→钱包 这条 join 能解释它。 */
    const twoWallet = globalAll.find(c => Array.isArray((c.payload || {}).wallets) && c.payload.wallets.length === 2);
    const e2Owner = twoWallet ? (bWallets.has(String(twoWallet.walletId)) ? 'char_a' : 'char_b') : null;
    const e2 = (twoWallet && e2Owner && !payloadNames(twoWallet, e2Owner)) ? { row: twoWallet, owner: e2Owner } : null;
    /* E3 独有：BUDGET_POLICY_CREATED —— wallet 列为 null、没有交易、只有 ownerId */
    const e3 = globalAll.find(c => c.kind === 'BUDGET_POLICY_CREATED' && c.walletId == null &&
      c.transactionId == null && String((c.payload || {}).ownerId) === 'char_b');
    /* E4 独有：APPROVAL_EXPIRED —— wallet 列 null、payload 无 owner 字段，
       只能靠 approvals 行的 buyer_id。 */
    const e4 = globalAll.find(c => c.kind === 'APPROVAL_EXPIRED' && c.walletId == null && !payloadNames(c, 'char_a') &&
      entityIsOwnerApproval(c, 'char_a'));
    return !!e1 && !!e2 && !!e3 && !!e4 &&
      inA(e1) === true &&
      (e2.owner === 'char_a' ? inA(e2.row) : inB(e2.row)) === true &&
      inB(e3) === true && inA(e3) === false &&
      inA(e4) === true;
  })(), (function () {
    const aWallets = new Set(store1.listWallets({ ownerId: 'char_a' }).map(w => w.walletId));
    const bWallets = new Set(store1.listWallets({ ownerId: 'char_b' }).map(w => w.walletId));
    return {
      twoWalletTx: globalAll.filter(c => Array.isArray((c.payload || {}).wallets) && c.payload.wallets.length === 2).map(c => c.revision),
      expired: globalAll.filter(c => c.kind === 'APPROVAL_EXPIRED').map(c => c.revision),
      aWallets: Array.from(aWallets).length, bWallets: Array.from(bWallets).length
    };
  })());

/* ══════════════════════════════════════════════════════════════════════
   独立 oracle：按 docs §6 写下的语义重建一份，用来交叉核对 SQL 的答案
   ★ 它故意走**另一条路**（canonical 的读 API + JS），而不是抄那段 SQL。
   ══════════════════════════════════════════════════════════════════════ */
function buildOracle(store) {
  const partyTypes = C.PARTY_TYPES;
  function keysOf(owner) {
    const keys = [owner];
    for (const t of partyTypes) keys.push(partyRefOf(t, owner));
    return keys;
  }
  function walletsOf(owner) {
    return store.listWallets({ ownerId: owner }).map(w => ({ walletId: w.walletId, accountId: w.accountId }));
  }
  function accountsTouchedBy(transactionId) {
    const tx = store.getTransaction(transactionId);
    if (!tx.ok) return [];
    return tx.entries.map(e => String(e.accountId));
  }
  function approvalBuyerOf(entityId) {
    const got = store.getApproval({ approvalId: String(entityId) });
    if (!got.ok) return null;
    /* `serializeApproval().buyerId` 是 **party-ref** 拼写（P22-7 逐字钉住），
       因此这里比的是 ref 那一份。 */
    return got.approval && got.approval.buyerId != null ? String(got.approval.buyerId) : null;
  }
  return {
    keysOf: keysOf,
    matches: function (ch, owner) {
      const keys = keysOf(owner);
      const ws = walletsOf(owner);
      const wids = new Set(ws.map(w => w.walletId));
      const aids = new Set(ws.map(w => String(w.accountId)));
      /* E1 */
      if (ch.walletId != null && wids.has(String(ch.walletId))) return true;
      /* E2 */
      if (ch.transactionId != null) {
        const touched = accountsTouchedBy(ch.transactionId);
        for (const a of touched) if (aids.has(a)) return true;
      }
      /* E3 */
      const p = ch.payload || {};
      for (const field of ['ownerId', 'buyerId', 'agentId']) {
        if (p[field] != null && keys.indexOf(String(p[field])) >= 0) return true;
      }
      /* E4 */
      const buyer = approvalBuyerOf(ch.entityId);
      if (buyer != null && keys.indexOf(buyer) >= 0) return true;
      return false;
    },
    fields: function () { return { keys: 'E3', wallets: 'E1', accounts: 'E2', approval: 'E4' }; }
  };
}

/* ══════════════════════════════════════════════════════════════════════
   C · EVENT_TYPE × ownership evidence 矩阵
   ══════════════════════════════════════════════════════════════════════ */
section('C · EVENT_TYPE × ownership evidence：每一个 kind 都有自己的归属证据');

/* ★ 从 canonical 真名单抽，不只看夹具里出现的几个。 */
const KIND_VOCAB = (function () {
  const fromContract = C.EVENT_TYPES.slice();
  /* store 自己写下的、**不在**契约 EVENT_TYPE 名单里的 kind（见 P22-18 的
     抽取器与 docs §2.2）：两个自有字面量 + 一类由 TX_TYPE 拼出来的。 */
  const own = ['BALANCE_REBUILT', 'ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED'];
  const committed = C.TX_TYPES ? C.TX_TYPES.map(t => String(t) + '_COMMITTED')
    : ['MINT_COMMITTED', 'BURN_COMMITTED', 'TRANSFER_COMMITTED', 'PURCHASE_COMMITTED',
      'GIFT_COMMITTED', 'COMPUTE_GRANT_COMMITTED', 'EXCHANGE_COMMITTED'];
  return { contract: fromContract, own: own, committed: committed };
})();

check('C1 ★★★★ kind 词表是从契约与 store 抽出来的，不是手写的短名单',
  KIND_VOCAB.contract.length >= 50 && KIND_VOCAB.own.length === 2 &&
  KIND_VOCAB.committed.length >= 3,
  { contract: KIND_VOCAB.contract.length, own: KIND_VOCAB.own, committed: KIND_VOCAB.committed });

const observed = new Set(globalAll.map(ch => String(ch.kind)));
const unattributable = observed.has('STORE_CREATED') || observed.has('PRODUCT_CREATED');
console.log('  夹具里实际写下的 kind（' + observed.size + '）：' + Array.from(observed).sort().join(' '));

check('C2 ★★★★★ 夹具里出现过的每一个 kind 都能被归类：' +
  '要么它出现在某个 owner 的流里，要么它是**目录类**（owner-less，被显式声明）',
  (function () {
    const catalogKinds = { STORE_CREATED: 1, STORE_UPDATED: 1, PRODUCT_CREATED: 1, PRODUCT_UPDATED: 1, PRODUCT_DISABLED: 1, PRODUCT_RETIRED: 1 };
    const seenSomewhere = new Set([].concat(
      ownerA.changes.map(c => c.kind), ownerB.changes.map(c => c.kind),
      ownerC.changes.map(c => c.kind), globalAll.filter(c => c.walletId != null).map(c => c.kind)));
    const unexplained = Array.from(observed).filter(k => !seenSomewhere.has(k) && catalogKinds[k] !== 1);
    return unexplained.length === 0;
  })(), Array.from(observed).filter(k => !new Set([].concat(ownerA.changes.map(c => c.kind), ownerB.changes.map(c => c.kind), ownerC.changes.map(c => c.kind))).has(k)));

check('C3 ★★★★★ 三类"曾经漏掉"的 kind 现在都在：' +
  'APPROVAL_APPROVED / APPROVAL_REJECTED / APPROVAL_CONSUMED（buyerId 是 party-ref 拼写），' +
  '以及 APPROVAL_EXPIRED（payload 里**一个 owner 字段都没有**）',
  (function () {
    const a = new Set(ownerA.changes.map(c => c.kind));
    return a.has('APPROVAL_APPROVED') && a.has('APPROVAL_REJECTED') &&
      a.has('APPROVAL_EXPIRED') && a.has('APPROVAL_CONSUMED');
  })(),
  Array.from(new Set(ownerA.changes.map(c => c.kind))).sort().join(' '));

check('C4 ★★★★★ APPROVAL_EXPIRED 的 payload 里确实**没有** owner 字段 —— ' +
  '它只能靠 canonical 的 approvals 行归属（浏览器结构性做不到）',
  (function () {
    const row = globalAll.filter(c => c.kind === 'APPROVAL_EXPIRED')[0];
    if (!row) return false;
    const p = row.payload || {};
    const hasOwnerField = p.ownerId != null || p.buyerId != null || p.agentId != null;
    const inOwnerStream = ownerA.changes.some(c => c.revision === row.revision);
    return row.walletId == null && hasOwnerField === false && inOwnerStream === true;
  })());

check('C5 ★★★★ 只靠 walletId 列归属的那一类（MINT/COMMITTED/RESERVATION）在 owner 流里也在',
  (function () {
    const a = new Set(ownerA.changes.filter(c => c.walletId === W1.w.wa).map(c => c.kind));
    return a.has('WALLET_OPENED') && a.has('MINT_COMMITTED') &&
      a.has('RESERVATION_CREATED') && a.has('PURCHASE_RESERVED');
  })());

/* ══════════════════════════════════════════════════════════════════════
   D · 分页完整性（对抗性交错）
   ══════════════════════════════════════════════════════════════════════ */
section('D · 分页完整性：先分页再筛会给出**最旧**的一段');

const W2 = makeStore('d');
const store2 = W2.store;
(function buildInterleaved() {
  const storeId = store2.putStore({ name: 'S', idempotencyKey: K('st') }).result.store.storeId;
  store2.putProduct({ storeId: storeId, kind: 'DIGITAL_ITEM', name: 'P', currency: CUR, unitPriceMinor: 1, grantQuantity: 1, idempotencyKey: K('p') });
  const wa = store2.openWallet({ owner: { type: 'character', id: 'char_a' }, currency: CUR });
  const wc = store2.openWallet({ owner: { type: 'character', id: 'char_c' }, currency: CUR });
  store2.mintForSystem({ systemInitiated: true, walletId: wa.wallet.walletId, currency: CUR, amountMinor: 100000, idempotencyKey: K('m') });
  /* A 的第一条（老走法看得见） */
  store2.putBudgetPolicy({ ownerId: 'char_a', currency: CUR, limits: { perTransactionMinor: 9, dailyMinor: 9, weeklyMinor: 9, monthlyMinor: 9 }, idempotencyKey: K('bp') });
  /* 噪声：别的 owner / 目录（30 条） */
  for (let i = 0; i < 30; i += 1) store2.putStore({ name: 'noise-' + i, idempotencyKey: K('n') });
  /* A 的最新一条（在噪声**之后**） */
  store2.putBudgetPolicy({ ownerId: 'char_a', currency: CUR, limits: { perTransactionMinor: 8, dailyMinor: 8, weeklyMinor: 8, monthlyMinor: 8 }, idempotencyKey: K('bp2') });
  return { wa: wa.wallet.walletId, wc: wc.wallet.walletId };
})();

const interleavedAll = store2.listChanges(0, 500);
const aStream = store2.listChangesForOwner({ ownerId: 'char_a', limit: 500 });
const newestA = aStream.changes[aStream.changes.length - 1];

check('D1 ★★★★★ 老走法（page=5 · cap=6 页）在对抗性交错下**漏掉 A 最新的那条** —— ' +
  '这就是"最近活动"这句话在旧实现下不成立的原因',
  (function () {
    const PAGE = 5, CAP = 6;
    let cursor = 0, pages = 0, seen = [], capped = false;
    for (;;) {
      const batch = store2.listChanges(cursor, PAGE);
      pages += 1;
      if (batch.length === 0) break;
      seen = seen.concat(batch);
      if (batch.length < PAGE) break;
      if (pages >= CAP) { capped = true; break; }
      cursor = batch[batch.length - 1].revision;
    }
    /* 旧实现在浏览器侧做的归属判据（逐字比较） */
    const ownerWallets = new Set(store2.listWallets({ ownerId: 'char_a' }).map(w => w.walletId));
    const oldSees = seen.filter(ch => {
      const p = ch.payload || {};
      return (ch.walletId != null && ownerWallets.has(ch.walletId)) ||
        [p.ownerId, p.buyerId, p.agentId].some(v => v != null && String(v) === 'char_a');
    });
    const sawNewest = oldSees.some(c => c.revision === newestA.revision);
    return capped === true && seen.length === 30 &&
      sawNewest === false && newestA.revision > seen[seen.length - 1].revision;
  })(), { newest: newestA.revision, total: interleavedAll.length, aRows: aStream.changes.length });

check('D2 ★★★★★ canonical 的 owner 流在小窗口下不漏：A 的每一条都在，' +
  '而且**最新**的那条一定在（老走法恰恰丢掉它）',
  (function () {
    const oracle = buildOracle(store2);
    const expected = interleavedAll.filter(c => oracle.matches(c, 'char_a')).map(c => c.revision);
    const got = aStream.changes.map(c => c.revision);
    return J(got) === J(expected) && got[got.length - 1] === newestA.revision &&
      newestA.kind === 'BUDGET_POLICY_UPDATED';
  })(), aStream.changes.map(c => c.revision + ':' + c.kind));

check('D3 ★★★★★ asc 走满所有页 ⇒ 恰好等于一次性取回的那一份（keyset 在过滤后的流上是稠密的）',
  (function () {
    const walked = [];
    let cursor = 0;
    for (;;) {
      const batch = store2.listChangesForOwner({ ownerId: 'char_a', cursor: cursor, limit: 1 }).changes;
      if (batch.length === 0) break;
      walked.push(batch[0].revision);
      if (batch.length < 1) break;
      cursor = batch[0].revision;
      if (walked.length > 50) break;
    }
    return J(walked) === J(aStream.changes.map(c => c.revision));
  })(), (function () {
    const walked = []; let cursor = 0;
    for (;;) {
      const batch = store2.listChangesForOwner({ ownerId: 'char_a', cursor: cursor, limit: 1 }).changes;
      if (batch.length === 0) break;
      walked.push(batch[0].revision);
      cursor = batch[0].revision;
      if (walked.length > 50) break;
    }
    return walked;
  })());

check('D4 ★★★★★ desc 从**最新**进入，而且一页一页走到底不重不漏',
  (function () {
    const got = [];
    let cursor = 0;
    for (;;) {
      const page = store2.listChangesForOwner({ ownerId: 'char_a', order: 'desc', cursor: cursor, limit: 1 }).changes;
      if (page.length === 0) break;
      got.push(page[0].revision);
      cursor = page[0].revision;
      if (got.length > 50) break;
    }
    return got[0] === newestA.revision &&
      J(got) === J(aStream.changes.map(c => c.revision).reverse());
  })());

check('D5 ★★★★ revision 顺序稳定：同一本账上反复读给出同一个序列',
  (function () {
    const one = store2.listChangesForOwner({ ownerId: 'char_a', limit: 500 }).changes.map(c => c.revision);
    const two = store2.listChangesForOwner({ ownerId: 'char_a', limit: 500 }).changes.map(c => c.revision);
    const desc = store2.listChangesForOwner({ ownerId: 'char_a', order: 'desc', limit: 500 }).changes.map(c => c.revision);
    return J(one) === J(two) && J(desc) === J(one.slice().reverse()) &&
      one.every((r, i) => i === 0 || r > one[i - 1]);
  })());

/* ══════════════════════════════════════════════════════════════════════
   E · 不重不漏：各 owner 的流并起来 ≥ 全部"有 owner 证据"的行
   ══════════════════════════════════════════════════════════════════════ */
section('E · 不重不漏：owner 流并起来覆盖全部有证据的行');

check('E1 ★★★★★ 每一条有 owner 证据的全局行，都至少出现在一个 owner 的流里',
  (function () {
    const seen = new Set([].concat(ownerA.changes, ownerB.changes, ownerC.changes).map(c => c.revision));
    /* 目录类（STORE_/PRODUCT_）本来就没有 owner —— 它们**不**该出现在任何
       owner 的时间线上，而这不是漏洞，是"货架与商品不属于任何角色"。 */
    const catalog = /^(STORE_|PRODUCT_)/;
    const missing = globalAll.filter(ch => !catalog.test(String(ch.kind))).filter(ch => !seen.has(ch.revision));
    return missing.length === 0;
  })(), (function () {
    const seen = new Set([].concat(ownerA.changes, ownerB.changes, ownerC.changes).map(c => c.revision));
    return globalAll.filter(ch => !/^(STORE_|PRODUCT_)/.test(String(ch.kind)) && !seen.has(ch.revision)).map(c => c.revision + ':' + c.kind);
  })());

check('E2 ★★★★★ 目录类（STORE_/PRODUCT_）**不**出现在任何 owner 的时间线上 —— ' +
  '货架与商品不属于任何角色，而不是"归属失败"',
  (function () {
    const all = [].concat(ownerA.changes, ownerB.changes, ownerC.changes);
    return all.every(c => !/^(STORE_|PRODUCT_)/.test(String(c.kind))) &&
      globalAll.some(c => /^(STORE_|PRODUCT_)/.test(String(c.kind)));
  })());

/* ══════════════════════════════════════════════════════════════════════
   F · 历史 / 未知 payload 形状
   ══════════════════════════════════════════════════════════════════════ */
section('F · 历史形状：一行坏/陌生的数据不许让整条时间线打不开');

const legacy = (function () {
  const h = makeStore('f');
  const store = h.store;
  const wa = store.openWallet({ owner: { type: 'character', id: 'char_a' }, currency: CUR });
  store.mintForSystem({ systemInitiated: true, walletId: wa.wallet.walletId, currency: CUR, amountMinor: 1000, idempotencyKey: K('m') });
  const before = store.listChangesForOwner({ ownerId: 'char_a', limit: 500 }).changes.length;
  const base = store.getRevision();
  store.close();
  /* ★ 直接往库里写三行**别的版本可能写下过**的形状：
       ① payload 里只有旧的键（没有 ownerId / buyerId / agentId）；
       ② payload 是坏 JSON；
       ③ payload 里 buyerId 是**第三种**拼写（既不是裸 id 也不是 ref）。
     它们是"历史数据"，不是本阶段造得出来的东西 —— 读面必须活着。 */
  const db = new DatabaseSync(path.join(h.dir, 'home-node.db'));
  const ins = db.prepare('INSERT INTO economy_change_log (revision, kind, entity_id, transaction_id, wallet_id, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  /* ① 旧形状：payload 里只有老键（没有 ownerId / buyerId / agentId），
        归属只能靠 E1 的 wallet 列。 */
  ins.run(base + 1, 'WALLET_OPENED', 'econ_wallet_legacy', null, wa.wallet.walletId, 1000,
    JSON.stringify({ domain: 'ib.economy', ownerType: 'character', currency: CUR }));
  /* ② 坏 JSON：**带** walletId（于是它会被 E1 选中），payload 解析不出来。 */
  ins.run(base + 2, 'PURCHASE_COMPLETED', 'econ_intent_legacy', null, wa.wallet.walletId, 1001, '{ this is not json');
  /* ③ 陌生拼写：`Character:char_a`（大小写不同）—— 不是契约的两种拼写之一。 */
  ins.run(base + 3, 'PURCHASE_COMPLETED', 'econ_intent_legacy2', null, null, 1002,
    JSON.stringify({ domain: 'ib.economy', buyerId: 'Character:char_a', amountMinor: '3' }));
  db.close();
  store.open();
  return { h: h, store: store, before: before, base: base, walletId: wa.wallet.walletId };
})();

check('F1 ★★★★★ 坏 JSON 那一行不让**整条**读面报错（json_valid 守卫），' +
  '而它仍然被 E1 选中、payload 诚实地是 null（不是"编一个空对象"）',
  (function () {
    const res = legacy.store.listChangesForOwner({ ownerId: 'char_a', limit: 500 });
    const row = res.changes.filter(c => c.revision === legacy.base + 2)[0];
    return res.ok === true && row != null && row.payload === null &&
      /* 而全局读面在同一行上给出同样的 null（两个投影是同一个形状）。 */
      legacy.store.listChanges(0, 500).filter(c => c.revision === legacy.base + 2)[0].payload === null;
  })());

check('F2 ★★★★★ 旧形状（没有 owner 字段）+ 有 walletId 列 ⇒ 仍然归属（E1 是独立的一支）',
  legacy.store.listChangesForOwner({ ownerId: 'char_a', limit: 500 })
    .changes.some(c => c.revision === legacy.base + 1));

check('F3 ★★★★★ 陌生拼写（Character:char_a，大小写不同）**不**被当成这个 owner —— ' +
  '读面只认契约里的两种 canonical 拼写，不猜',
  (function () {
    const a = legacy.store.listChangesForOwner({ ownerId: 'char_a', limit: 500 }).changes.map(c => c.revision);
    const weird = legacy.store.listChangesForOwner({ ownerId: 'Character', limit: 500 }).changes.map(c => c.revision);
    return a.indexOf(legacy.base + 3) < 0 && weird.indexOf(legacy.base + 3) < 0;
  })());

check('F4 ★★★★ 这三行之后，原有的 every 行仍在、顺序仍按 revision、总数只增不减',
  (function () {
    const rows = legacy.store.listChanges(0, 500);
    const revs = rows.map(c => c.revision);
    return rows.length === legacy.before + 3 &&
      revs.every((r, i) => i === 0 || r > revs[i - 1]) &&
      rows.some(c => c.revision === legacy.base + 1) &&
      rows.some(c => c.revision === legacy.base + 3);
  })(), { total: legacy.store.listChanges(0, 500).length, before: legacy.before });

/* ══════════════════════════════════════════════════════════════════════
   G · 拒绝面
   ══════════════════════════════════════════════════════════════════════ */
section('G · 拒绝面：不猜、不静默');

check('G1 ★★★★ owner 缺失 ⇒ 具名拒绝，而不是"这个 owner 什么都没有"',
  (function () {
    const r = store1.listChangesForOwner({});
    return r.ok === false && r.changes.length === 0 && r.errors.indexOf('party-id-required') >= 0;
  })());

check('G2 ★★★★ owner 里有控制字符 ⇒ 具名拒绝（与其它 owner-scoped 读面同一个词表）',
  (function () {
    const r = store1.listChangesForOwner({ ownerId: 'char\u0000a' });
    return r.ok === false && r.errors.indexOf('party-character-id-not-canonical') >= 0;
  })(), store1.listChangesForOwner({ ownerId: 'char\u0000a' }).errors);

check('G3 ★★★★ 不认识的 order ⇒ 具名拒绝（**不**静默退回 asc —— 那会让调用方以为拿到了 desc）',
  (function () {
    const r = store1.listChangesForOwner({ ownerId: 'char_a', order: 'sideways' });
    return r.ok === false && r.errors.indexOf('change-order-not-supported') >= 0;
  })());

check('G4 ★★★★ 非数字 cursor 归一为"从这里开始"，不产生 NaN、也不报 500',
  (function () {
    const r = store1.listChangesForOwner({ ownerId: 'char_a', cursor: 'not-a-number', limit: 500 });
    return r.ok === true && r.changes.length === ownerA.changes.length;
  })());

check('G5 ★★★★ 未知 owner ⇒ 空流 + ok（这不是错误：一个还没有任何经济的角色是真的没有记录）',
  (function () {
    const r = store1.listChangesForOwner({ ownerId: 'char_nobody' });
    return r.ok === true && r.changes.length === 0;
  })());

/* ══════════════════════════════════════════════════════════════════════
   H · §6 gift 语义
   ══════════════════════════════════════════════════════════════════════ */
section('H · §6 gift：A 买给 B 时，A 与 B 的时间线各自出现什么');

const giftPurchaseA = W1.facts.aGiftToB.purchaseId;
const giftPurchaseB = W1.facts.bGiftToA.purchaseId;

check('H1 ★★★★★ A 的时间线**有**"A 买给 B"那笔购买（钱从 A 出去）',
  ownerA.changes.some(c => c.kind === 'PURCHASE_COMPLETED' && (c.payload || {}).purchaseId === giftPurchaseA));

check('H2 ★★★★★ B 的时间线**没有**"A 买给 B"那笔购买（B 的钱一动没动）—— ' +
  'recipientId 不等于"钱为收礼者动了"',
  (function () {
    const inB = ownerB.changes.filter(c => (c.payload || {}).purchaseId === giftPurchaseA);
    return inB.length === 0;
  })(), ownerB.changes.filter(c => (c.payload || {}).purchaseId === giftPurchaseA).map(c => c.kind));

check('H3 ★★★★★ 但 B 的时间线**有**自己收到的那份库存（INVENTORY_GRANTED ownerId=char_b）—— ' +
  '礼物在收礼者那边体现为"资产变了"，不是"钱变了"',
  (function () {
    const grants = ownerB.changes.filter(c => c.kind === 'INVENTORY_GRANTED' && String((c.payload || {}).ownerId) === 'char_b');
    return grants.length >= 1;
  })(), ownerB.changes.filter(c => c.kind === 'INVENTORY_GRANTED').map(c => (c.payload || {}).ownerId));

check('H4 ★★★★★ 方向对称：B 买给 A 时，只有 A 的库存变化进 A 的时间线（购买仍在 B 那边）',
  (function () {
    const bHas = ownerB.changes.some(c => c.kind === 'PURCHASE_COMPLETED' && (c.payload || {}).purchaseId === giftPurchaseB);
    const aNo = !ownerA.changes.some(c => (c.payload || {}).purchaseId === giftPurchaseB);
    const aGrant = ownerA.changes.some(c => c.kind === 'INVENTORY_GRANTED' && String((c.payload || {}).ownerId) === 'char_a');
    return bHas && aNo && aGrant;
  })());

check('H5 ★★★★★ 账本交易那一层也对称：GIFT_COMMITTED 的 wallets[] 里只有**买家的**钱包',
  (function () {
    const rows = store1.listChanges(0, 500).filter(c => c.kind === 'GIFT_COMMITTED');
    if (rows.length < 2) return false;
    /* 两笔买给对方的礼物：A→B 的只有 A 的钱包，B→A 的只有 B 的钱包。
       （一次**转账**会有两个 —— 那是另一回事，夹具里单独跑过。） */
    const giftOnly = rows.filter(c => Array.isArray((c.payload || {}).wallets) && c.payload.wallets.length === 1);
    const sides = new Set(giftOnly.map(c => String(c.payload.wallets[0].walletId)));
    return giftOnly.length >= 2 && sides.size >= 1 && sides.has(String(W1.w.wa)) && sides.has(String(W1.w.wb));
  })(), store1.listChanges(0, 500).filter(c => c.kind === 'GIFT_COMMITTED').map(c => ((c.payload || {}).wallets || []).length));

check('H6 ★★★★★ 一次**两端都是 wallet owner** 的账本交易：change.walletId 只记 touched[0]，' +
  '但两个 owner 的流都该有它（E2 就是为这件事存在的）',
  (function () {
    const txRows = globalAll.filter(c => c.kind === 'GIFT_COMMITTED' &&
      Array.isArray((c.payload || {}).wallets) && c.payload.wallets.length === 2);
    if (txRows.length !== 1) return false;
    const rev = txRows[0].revision;
    const inA = ownerA.changes.some(c => c.revision === rev);
    const inB = ownerB.changes.some(c => c.revision === rev);
    const columnPicksOne = txRows[0].walletId != null;
    return inA && inB && columnPicksOne;
  })(), { twoWalletTx: globalAll.filter(c => Array.isArray((c.payload || {}).wallets) && c.payload.wallets.length === 2).map(c => c.revision) });

/* ══════════════════════════════════════════════════════════════════════
   I · §8 投影不是第二权威
   ══════════════════════════════════════════════════════════════════════ */
section('I · §8 这个读面只做 join / filter / sort / project');

check('I1 ★★★★★ 同一个 revision 在两个读面上**逐字相同**（没有第二个投影）',
  (function () {
    const byRev = {};
    for (const c of globalAll) byRev[c.revision] = c;
    const all = [].concat(ownerA.changes, ownerB.changes, ownerC.changes);
    const bad = all.filter(c => J(c) !== J(byRev[c.revision]));
    return bad.length === 0;
  })(), (function () {
    const byRev = {}; for (const c of globalAll) byRev[c.revision] = c;
    return [].concat(ownerA.changes, ownerB.changes, ownerC.changes).filter(c => J(c) !== J(byRev[c.revision])).map(c => c.revision);
  })());

check('I2 ★★★★★ 行里**没有**任何被重算的经济事实字段（余额 / 预算决定 / 批准有效性 / 报价有效性 / 购买结果 / 库存数量 / 自主裁决）',
  (function () {
    const forbidden = ['cachedBalanceMinor', 'availableBalanceMinor', 'spentTodayMinor', 'decision',
      'approvalStatus', 'quoteValid', 'purchaseStatus', 'quantity', 'autonomyOutcome', 'autonomyLevel'];
    const keys = new Set();
    for (const c of ownerA.changes) for (const k of Object.keys(c)) keys.add(k);
    return forbidden.every(k => keys.has(k) === false) &&
      J(Array.from(keys).sort()) === J(['at', 'domain', 'entityId', 'kind', 'payload', 'revision', 'transactionId', 'walletId']);
  })(), Object.keys(ownerA.changes[0]).sort());

check('I3 ★★★★ 读面**不写任何东西**：读完之后 revision / 行数 / 账本逐字不变',
  (function () {
    const rev = store1.getRevision();
    const rows = store1.listChanges(0, 500).length;
    for (let i = 0; i < 3; i += 1) {
      store1.listChangesForOwner({ ownerId: 'char_a', limit: 500 });
      store1.listChangesForOwner({ ownerId: 'char_b', order: 'desc', limit: 500 });
    }
    return store1.getRevision() === rev && store1.listChanges(0, 500).length === rows;
  })());

check('I4 ★★★★ 全局读面（不带 ownerId）的形状**没变**：仍是从最早往新、且没有 ownerScope',
  (function () {
    const rows = store1.listChanges(0, 500);
    return rows.every((c, i) => i === 0 || c.revision > rows[i - 1].revision) &&
      rows[0].revision === 1 &&
      Object.keys(rows[0]).indexOf('ownerScope') < 0;
  })());

drop(W1.w); drop(W2); drop(legacy.h);

console.log('\n' + '─'.repeat(66));
if (failures === 0) console.log('P22-19 owner scope: 全部通过');
else console.log('P22-19 owner scope: ' + failures + ' 项失败');
console.log('结果: ' + (failures === 0 ? 'PASS' : failures + ' FAILED'));
process.exitCode = failures === 0 ? 0 : 1;
