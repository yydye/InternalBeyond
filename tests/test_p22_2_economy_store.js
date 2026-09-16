'use strict';
/* ====================================================================
   P22-2 · Economy canonical store（Ledger + Wallet runtime）
   --------------------------------------------------------------------
   运行：node tests/test_p22_2_economy_store.js

   本文件回答的问题：
     「Wallet 的余额能不能**只**从 Ledger 完整重建？」
     「同一笔业务重放会不会造成第二次经济 mutation？」
     「任何一步失败会不会留下半写的账？」

   它**不**回答 HTTP / 装配 / 真实进程（那是 test_p22_2_economy_runtime.js）。

   ── 为什么每一步都要"先破坏再证明"────────────────────────────────────
   一个只测正常路径的 ledger 测试证明不了 append-only、幂等与原子性 ——
   这三条性质都只在**异常路径**上才可能被违反。因此本文件刻意：
     · 把缓存改坏，再证明 rebuild 能恢复（G 组）；
     · 在事务的四个位置注入故障，再证明 SQLite 里 0 残留（J 组）；
     · 重启后重放同一个 idempotencyKey（H 组）。

   ── 为什么金额那一组要逐个点名（E 组）────────────────────────────────
   P22-1 §3 冻结的是"runtime=BigInt / JSON=十进制字符串 / SQLite=INTEGER"。
   这三层之间每一次转换都是一个可能丢精度的缝，因此这里对
   MAX_SAFE_INTEGER、MAX+1、负数、小数、NaN、Infinity 逐个断言 ——
   而不是只测一个 100。
   ==================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
/* BigInt 不能进 JSON.stringify —— 这是 P22-1 §3 的既定事实，连**失败信息**
   都必须显式处理它，否则一次断言失败会变成一次 TypeError。 */
function replacer(k, v) { return typeof v === 'bigint' ? v.toString() + 'n' : v; }
function J(v) { return JSON.stringify(v, replacer); }

const tempDirs = [];
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-p22-2-' + tag + '-'));
  tempDirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of tempDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 句柄未释放 */ } }
});

/* 确定性 id：测试里"同一毫秒两笔交易"必须得到不同的 id，而随机源会让
   失败不可复现。生产用 store 缺省的那个，测试用这个计数器。 */
function deterministicIds() {
  let n = 0;
  return (kind) => { n += 1; return C.formatEconomyId(kind, 't' + n).id; };
}
function makeStore(extra) {
  const dir = (extra && extra.dataDir) || tmpDir('store');
  return createEconomyStore(Object.assign({
    dataDir: dir,
    logger: () => { },
    nextId: deterministicIds()
  }, extra || {}));
}
/* 一个有余额的钱包：mint 是唯一"从无到有"的路径。 */
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
function balanceString(store, walletId) {
  const g = store.getWallet({ walletId: walletId });
  if (!g.ok) return null;
  return g.wallet.availableBalanceMinor == null ? null : store.serializeWallet(g.wallet, {}).availableBalanceMinor;
}

console.log('P22-2 · Economy canonical store（Ledger + Wallet）');

/* ══════════════════════════════════════════════════════════════════
   A · Store lifecycle
   ══════════════════════════════════════════════════════════════════ */
section('A · Store lifecycle（create / open / close / reopen / double）');

{
  const dir = tmpDir('lifecycle');
  const store = makeStore({ dataDir: dir });

  check('A1 新建的 store 未打开（isOpen() === false）', store.isOpen() === false);
  check('A2 未打开时 health() 的 state 是 COLD，而不是抛错（抛错会诱使调用方 catch 成 0）',
    store.health().state === C.WALLET_STATE.COLD && store.health().open === false, store.health().state);
  check('A3 未打开时任何读操作是**明确失败**，不是返回空余额',
    (() => {
      try { if (store.getWallet({ ownerId: 'cfg_a', currency: 'IB_CREDIT' }).ok === true) return false; }
      catch (e) { if (e.code !== 'STORE_CLOSED') return false; }
      try { store.listWallets(); return false; } catch (e) { return e.code === 'STORE_CLOSED'; }
    })());
  check('A4 未打开时 getRevision() 是 0（不是抛错、也不是上次的残值）', store.getRevision() === 0);

  const opened = store.open();
  check('A5 open() 返回 schemaVersion 与文件路径', opened.ok === true && opened.schemaVersion === store.SCHEMA_VERSION && !!opened.file,
    opened);
  check('A6 打开后 isOpen() 为真且 health().state 是 READY', store.isOpen() === true && store.health().state === C.WALLET_STATE.READY);

  const again = store.open();
  check('A7 重复 open() 是幂等 no-op（alreadyOpen，不重建表、不重置状态）',
    again.ok === true && again.alreadyOpen === true);

  const closed = store.close();
  check('A8 close() 之后 isOpen() 为假，且 state 回到 COLD（余额再次未知）',
    closed.ok === true && store.isOpen() === false && store.health().state === C.WALLET_STATE.COLD);
  check('A9 重复 close() 是幂等 no-op（alreadyClosed，不抛错）',
    store.close().alreadyClosed === true);

  const reopened = store.open();
  check('A10 close → open 可再次打开同一个库（alreadyOpen 为 false）',
    reopened.ok === true && reopened.alreadyOpen === false && store.isOpen() === true);
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   B · Schema namespace 独立
   ══════════════════════════════════════════════════════════════════ */
section('B · 独立命名空间（不复用 chat / memory 的 revision 与 change_log）');

{
  const dir = tmpDir('namespace');
  const store = makeStore({ dataDir: dir });
  store.open();
  walletWith(store, 100n);
  const tables = store.TABLES;
  const metaKeys = store.META_KEYS;
  store.close();

  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(dir, 'home-node.db'));
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name));
  const metaRows = raw.prepare('SELECT key FROM ' + tables.META).all().map(r => String(r.key));
  raw.close();

  check('B1 Economy 的表带 economy_ 前缀（与 chat 的 messages / memory_records 不共用）',
    [tables.META, tables.WALLETS, tables.TRANSACTIONS, tables.ENTRIES, tables.CHANGE_LOG, tables.IDEMPOTENCY, tables.ACCOUNTS]
      .every(t => t.indexOf('economy_') === 0), names.filter(n => n.indexOf('economy') === 0));
  check('B2 Economy **没有**创建或使用 chat 的 change_log / idempotency 表',
    !names.includes('change_log') || tables.CHANGE_LOG !== 'change_log',
    { changeLog: tables.CHANGE_LOG, idempotency: tables.IDEMPOTENCY });
  check('B3 revision 水位存在 Economy **自己的** meta 表里，键名带 economy_ 前缀',
    metaKeys.REVISION === 'economy_revision' && metaRows.includes('economy_revision'), metaRows);
  check('B4 schema 水位也在 economy_meta（不是共用的 meta 表）',
    metaKeys.SCHEMA === 'economy_schema' && metaRows.includes('economy_schema'), metaRows);
  check('B5 meta 表本身就是 economy_meta（结构上不可能与其它 store 的 meta 键相撞）',
    tables.META === 'economy_meta');
}

/* ══════════════════════════════════════════════════════════════════
   C · Wallet
   ══════════════════════════════════════════════════════════════════ */
section('C · Wallet（owner / currency / 幂等开钱包 / 三态）');

{
  const store = makeStore();
  store.open();

  const first = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' });
  check('C1 打开角色钱包：created=true，并生成 canonical walletId / accountId',
    first.ok === true && first.created === true &&
    C.isEconomyId('WALLET', first.wallet.walletId) && C.isEconomyId('ACCOUNT', first.wallet.accountId),
    { walletId: first.wallet.walletId, accountId: first.wallet.accountId });
  check('C2 Wallet 自带 owner / currency / state / revision / 时间戳',
    first.wallet.owner.type === 'character' && first.wallet.owner.id === 'cfg_a' &&
    first.wallet.currency === 'IB_CREDIT' && first.wallet.state === C.WALLET_STATE.READY &&
    Number.isInteger(first.wallet.revision) && first.wallet.createdAt > 0 && first.wallet.updatedAt > 0);
  check('C3 新钱包的余额是 0 且**来自 ledger 重建**（debit/credit 计数都是 0）',
    first.wallet.availableBalanceMinor === 0n && first.ledgerEmpty === true, first.ledgerEmpty);

  const second = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' });
  check('C4 同一 (owner,currency) 再开一次返回**已有**钱包，不新建第二个账户（否则余额会被劈成两半）',
    second.ok === true && second.created === false && second.wallet.walletId === first.wallet.walletId);
  check('C5 同 owner 的**不同币种**是不同的钱包（一个 owner + 一个 currency 一个钱包）',
    store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'COMPUTE_PREMIUM' }).wallet.walletId !== first.wallet.walletId);

  check('C6 非法 owner 类型被拒绝（prompt / credential / provider 都不在 party 闭集里）',
    ['provider', 'credential', 'apikey', 'billing', ''].every(t =>
      store.openWallet({ owner: { type: t, id: 'x' }, currency: 'IB_CREDIT' }).ok === false));
  check('C7 system **不是** wallet owner（system:mint 只有 ledger account，没有钱包）',
    store.openWallet({ owner: { type: 'system', id: 'system:mint' }, currency: 'IB_CREDIT' }).ok === false);
  check('C8 真实货币 / provider 余额不能当 currency（wallet 层也过不去，不只是契约层）',
    ['USD', 'CNY', 'PROVIDER_BALANCE', 'OPENAI_BALANCE', 'TOKENS'].every(cur =>
      store.openWallet({ owner: { type: 'character', id: 'cfg_z' }, currency: cur }).ok === false));
  check('C9 未注册币种被拒绝（白名单与 deny-list 是两道闸门，都要过）',
    store.openWallet({ owner: { type: 'character', id: 'cfg_z' }, currency: 'GOLD_COIN' }).ok === false);

  /* 角色不存在就必须失败 —— 但 store 自己不做角色目录查询（那是注入的
     谓词），因此这里注入一个"只有 cfg_a 存在"的谓词来验证它真的被用。 */
  const strictDir = tmpDir('ownerexists');
  const strict = createEconomyStore({
    dataDir: strictDir, logger: () => { }, nextId: deterministicIds(),
    ownerExists: (party) => party.type !== 'character' || party.id === 'cfg_a'
  });
  strict.open();
  check('C10 ownerExists 谓词说"角色不存在"时，开钱包**失败**（不凭空创建角色）',
    strict.openWallet({ owner: { type: 'character', id: 'cfg_missing' }, currency: 'IB_CREDIT' }).ok === false &&
    strict.listWallets().length === 0);
  check("C11 ownerExists 谓词对 user party 放行（'user' 是既有 canonical 用户键）",
    strict.openWallet({ owner: { type: 'user', id: 'user' }, currency: 'IB_CREDIT' }).ok === true);
  strict.close();
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   D · Ledger account 模型（WALLET vs SYSTEM）
   ══════════════════════════════════════════════════════════════════ */
section('D · Ledger Account（wallet account / system 白名单）');

{
  const store = makeStore();
  store.open();
  const w = walletWith(store, 500n);

  const acct = store.getLedgerAccount(w.accountId);
  check('D1 钱包的 ledger account 是 WALLET kind，并指回它的 walletId',
    acct.ok === true && acct.account.kind === C.ACCOUNT_KIND.WALLET && acct.account.walletId === w.walletId, acct.account);
  check('D2 任意自造账户 id 被拒绝（account 要么是白名单 system，要么是本地生成的 econ_account_*）',
    store.getLedgerAccount('system:evil').ok === false &&
    store.getLedgerAccount('econ_account_fake').ok === false &&
    store.getLedgerAccount('pay_123').ok === false);
  check('D3 白名单里的四个 system account 都通过契约校验（mint / burn / treasury / market）',
    C.SYSTEM_ACCOUNTS.length === 4 && C.SYSTEM_ACCOUNTS.every(a => C.validateSystemAccountId(a).ok === true));
  check('D4 system:mint 的余额从 ledger 算出，且是**负的控制账户**方向（增发量的对置）',
    store.systemAccountBalance('system:mint', 'IB_CREDIT').balanceMinor === '500',
    store.systemAccountBalance('system:mint', 'IB_CREDIT'));

  const two = store.transferBetweenWallets({
    fromWalletId: w.walletId,
    toWalletId: store.openWallet({ owner: { type: 'user', id: 'user' }, currency: 'IB_CREDIT' }).wallet.walletId,
    currency: 'IB_CREDIT', amountMinor: 200n, idempotencyKey: 'tr-d1'
  });
  check('D5 两个钱包之间的相对记账：转出方 CREDIT / 转入方 DEBIT，双方余额都从 ledger 重建',
    two.ok === true && two.result.wallets.length === 2 &&
    two.result.wallets.map(x => x.balanceMinor).sort().join(',') === '200,300',
    two.ok ? two.result.wallets : two.errors);
  check('D6 整本账在每个币种上恒等平衡（∑DEBIT === ∑CREDIT）',
    store.ledgerTopology(null).every(t => t.balanced === true) && store.ledgerTopology(null).length === 1,
    store.ledgerTopology(null));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   E · Amount（BigInt ↔ 十进制字符串 ↔ SQLite INTEGER）
   ══════════════════════════════════════════════════════════════════ */
section('E · Amount 的三层表示与边界');

{
  const store = makeStore();
  store.open();
  const MAX = C.MAX_AMOUNT_MINOR;

  const big = walletWith(store, BigInt(MAX), 'cfg_max');
  check('E1 MAX_SAFE_INTEGER 可以完整往返（BigInt → SQLite INTEGER → BigInt）',
    store.ledgerBalanceOf(big.walletId).balanceMinor === String(MAX),
    store.ledgerBalanceOf(big.walletId));
  check('E2 MAX_SAFE_INTEGER 在 JSON 边界是**十进制字符串**，不是 number',
    typeof store.serializeWallet(store.getWallet({ walletId: big.walletId }).wallet, {}).availableBalanceMinor === 'string');
  check('E3 JSON.stringify 不能序列化 BigInt —— 因此 serializeWallet 是必经之路（这条断言把理由钉住）',
    (() => { try { JSON.stringify({ v: 1n }); return false; } catch (e) { return e instanceof TypeError; } })());

  const bounds = [
    ['MAX_SAFE_INTEGER + 1', BigInt(MAX) + 1n, false],
    ['负数', -1n, false],
    ['小数', 1.5, false],
    ['NaN', NaN, false],
    ['Infinity', Infinity, false],
    ['字符串小数', '1.5', false],
    ['科学计数', '1e3', false],
    ['十六进制', '0x10', false],
    ['千分位', '1,000', false],
    ['带正号', '+1', false],
    ['零', 0n, true],
    ['十进制字符串', '1000', true],
    ['带前导零', '007', true]
  ];
  for (const [label, value, shouldPass] of bounds) {
    const amt = C.normalizeAmountMinor(value);
    check('E4 normalizeAmountMinor(' + label + ') → ' + (shouldPass ? '接受' : '拒绝'),
      amt.ok === shouldPass, amt.errors);
  }

  /* 溢出必须被**存储层**拒绝，而不只是契约层：SQLite INTEGER 装得下
     64 位，因此"装得下"不是理由，"canonical 装得下"才是。 */
  const overflow = store.mintForSystem({
    systemInitiated: true, walletId: big.walletId, currency: 'IB_CREDIT',
    amountMinor: BigInt(MAX) + 1n, idempotencyKey: 'overflow-1'
  });
  check('E5 超过 MAX_SAFE_INTEGER 的金额被 mint 拒绝（不静默截断成 64 位）',
    overflow.ok === false && overflow.errors.indexOf('amount-minor-overflow') >= 0, overflow.errors);

  const zero = store.mintForSystem({
    systemInitiated: true, walletId: big.walletId, currency: 'IB_CREDIT',
    amountMinor: 0n, idempotencyKey: 'zero-1'
  });
  check('E6 金额 0 的交易被**运行层**拒绝（契约允许"两侧都为 0"，但一次没有经济内容的事实不该进账本）',
    zero.ok === false && zero.errors.indexOf('ledger-transaction-must-move-a-non-zero-amount') >= 0, zero.errors);
  check('E6b 这条收紧只发生在运行时：契约本身对两侧都为 0 的 entry 是放行的（于是"更严"是可被看见的）',
    C.checkLedgerBalance([
      { currency: 'IB_CREDIT', direction: 'CREDIT', amountMinor: 0n },
      { currency: 'IB_CREDIT', direction: 'DEBIT', amountMinor: 0n }
    ]).balanced === true);

  /* 直接读回 SQLite 里的字节，证明存的是 INTEGER 而不是浮点或文本。 */
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(store.file));
  const row = raw.prepare('SELECT amount_minor, typeof(amount_minor) AS t FROM ' + store.TABLES.ENTRIES + ' LIMIT 1').get();
  raw.close();
  check('E7 SQLite 里存的是 INTEGER 类型（typeof 是 integer），且值逐位相等',
    String(row.t) === 'integer' && String(row.amount_minor) === String(MAX), row);
  check('E8 修复上界溢出后，余额本身没有被改动（拒绝是原子的，不是"先扣再报错"）',
    store.ledgerBalanceOf(big.walletId).balanceMinor === String(MAX));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   F · Ledger 平衡与拓扑
   ══════════════════════════════════════════════════════════════════ */
section('F · Double-entry（逐 currency 平衡 / 非法账户 / 不平衡拒绝）');

{
  const store = makeStore();
  store.open();
  const a = walletWith(store, 1000n, 'cfg_a');
  const b = store.openWallet({ owner: { type: 'character', id: 'cfg_b' }, currency: 'IB_CREDIT' }).wallet;

  /* 不平衡：只写一半。契约层的 checkLedgerBalance 会给出 unbalanced。 */
  const unbalanced = store.commitLedgerTransaction({
    transactionId: 'econ_tx_unbal1', type: C.TX_TYPE.GIFT, idempotencyKey: 'f-unbal',
    actor: { type: 'character', id: 'cfg_a' }, ownerId: 'cfg_a',
    entries: [{ accountId: a.accountId, direction: 'CREDIT', amountMinor: 100n, currency: 'IB_CREDIT' }]
  });
  /* P22-1 的 checkLedgerBalance 对"单边"给出的错误是 ledger-unbalanced：
     它先逐币种求和（此时另一侧是 0），只有两侧都平且 entry 不足 2 条时
     才给 ledger-needs-at-least-two-entries。两种拒绝都比"看起来像一笔
     合法交易"好，因此这里断言的是**它被拒绝了**，而不是它用了哪一句话。 */
  check('F1 单边 ledger 被拒绝（0/100 不平衡，被 ledger-unbalanced 拦下）',
    unbalanced.ok === false && unbalanced.errors.indexOf('ledger-unbalanced') >= 0, unbalanced.errors);
  check('F1b 契约层对"两侧都为 0 的单边 entry"给的是 ledger-needs-at-least-two-entries（两条规则都存在）',
    C.checkLedgerBalance([{ currency: 'IB_CREDIT', direction: 'CREDIT', amountMinor: 0n }]).errors
      .indexOf('ledger-needs-at-least-two-entries') >= 0);

  const lopsided = store.commitLedgerTransaction({
    transactionId: 'econ_tx_unbal2', type: C.TX_TYPE.GIFT, idempotencyKey: 'f-unbal2',
    actor: { type: 'character', id: 'cfg_a' }, ownerId: 'cfg_a',
    entries: [
      { accountId: a.accountId, direction: 'CREDIT', amountMinor: 100n, currency: 'IB_CREDIT' },
      { accountId: b.accountId, direction: 'DEBIT', amountMinor: 99n, currency: 'IB_CREDIT' }
    ]
  });
  check('F2 两侧金额不等的交易被拒绝（ledger-unbalanced）',
    lopsided.ok === false && lopsided.errors.indexOf('ledger-unbalanced') >= 0, lopsided.errors);

  /* 逐 currency 平衡：跨币种求和是错的 —— 100 IB_CREDIT + 20 COMPUTE
     会让"看起来平"。 */
  const crossCurrency = store.commitLedgerTransaction({
    transactionId: 'econ_tx_cross1', type: C.TX_TYPE.GIFT, idempotencyKey: 'f-cross',
    actor: { type: 'character', id: 'cfg_a' }, ownerId: 'cfg_a',
    entries: [
      { accountId: a.accountId, direction: 'CREDIT', amountMinor: 100n, currency: 'IB_CREDIT' },
      { accountId: b.accountId, direction: 'DEBIT', amountMinor: 100n, currency: 'COMPUTE_PREMIUM' }
    ]
  });
  check('F3 **逐 currency** 平衡：100 IB_CREDIT 对 100 COMPUTE_PREMIUM 被拒绝（跨币种求和不成立）',
    crossCurrency.ok === false && crossCurrency.errors.indexOf('ledger-unbalanced') >= 0, crossCurrency.errors);

  /* 混合币种各自平衡：两对，每对各平，必须通过。 */
  const mixedOwner = store.openWallet({ owner: { type: 'user', id: 'user' }, currency: 'COMPUTE_PREMIUM' }).wallet;
  store.mintForSystem({
    systemInitiated: true, walletId: mixedOwner.walletId, currency: 'COMPUTE_PREMIUM',
    amountMinor: 50n, idempotencyKey: 'seed-compute'
  });
  const mixed = store.commitLedgerTransaction({
    transactionId: 'econ_tx_mixed1', type: C.TX_TYPE.GIFT, idempotencyKey: 'f-mixed',
    actor: { type: 'character', id: 'cfg_a' }, ownerId: 'cfg_a',
    entries: [
      { accountId: a.accountId, direction: 'CREDIT', amountMinor: 100n, currency: 'IB_CREDIT' },
      { accountId: b.accountId, direction: 'DEBIT', amountMinor: 100n, currency: 'IB_CREDIT' },
      { accountId: a.accountId, direction: 'CREDIT', amountMinor: 7n, currency: 'COMPUTE_PREMIUM' },
      { accountId: mixedOwner.accountId, direction: 'DEBIT', amountMinor: 7n, currency: 'COMPUTE_PREMIUM' }
    ]
  });
  check('F4 多 entry、多币种的交易各自平衡时通过（4 条 entry 一个事务）',
    mixed.ok === true && mixed.result.entries.length === 4, mixed.errors || '');
  check('F5 返回的拓扑逐币种给出 debit/credit 总和，且两个币种都平',
    mixed.ok === true && mixed.result.topology.length === 2 &&
    mixed.result.topology.every(t => t.debitTotal === t.creditTotal) &&
    mixed.result.topology.map(t => t.currency).join(',') === 'COMPUTE_PREMIUM,IB_CREDIT',
    mixed.ok ? J(mixed.result.topology) : null);

  const ghost = store.commitLedgerTransaction({
    transactionId: 'econ_tx_ghost1', type: C.TX_TYPE.GIFT, idempotencyKey: 'f-ghost',
    actor: { type: 'character', id: 'cfg_a' }, ownerId: 'cfg_a',
    entries: [
      { accountId: 'econ_account_ghost', direction: 'CREDIT', amountMinor: 10n, currency: 'IB_CREDIT' },
      { accountId: b.accountId, direction: 'DEBIT', amountMinor: 10n, currency: 'IB_CREDIT' }
    ]
  });
  check('F6 指向不存在的账户被拒绝（不静默创建账户 —— 那会让"造一个 system account"从被拒变成被满足）',
    ghost.ok === false && ghost.errors.indexOf('entry-account-not-found') >= 0, ghost.errors);

  const mintMisuse = store.commitLedgerTransaction({
    transactionId: 'econ_tx_mintmisuse', type: C.TX_TYPE.PURCHASE, idempotencyKey: 'f-mint-misuse',
    actor: { type: 'character', id: 'cfg_a' }, ownerId: 'cfg_a',
    entries: [
      { accountId: a.accountId, direction: 'DEBIT', amountMinor: 10n, currency: 'IB_CREDIT' },
      { accountId: 'system:mint', direction: 'CREDIT', amountMinor: 10n, currency: 'IB_CREDIT' }
    ]
  });
  check('F7 system:mint 只允许出现在 MINT 交易里（否则"写一笔 PURCHASE 但对手方是 mint"能绕过显式命名）',
    mintMisuse.ok === false && String(mintMisuse.errors[0]).indexOf('mint-burn-account-only-allowed') === 0, mintMisuse.errors);

  const badDirection = store.commitLedgerTransaction({
    transactionId: 'econ_tx_baddir', type: C.TX_TYPE.GIFT, idempotencyKey: 'f-baddir',
    actor: { type: 'character', id: 'cfg_a' }, ownerId: 'cfg_a',
    entries: [
      { accountId: a.accountId, direction: 'DEBIT', amountMinor: -100n, currency: 'IB_CREDIT' },
      { accountId: b.accountId, direction: 'DEBIT', amountMinor: 100n, currency: 'IB_CREDIT' }
    ]
  });
  check('F8 负数金额被拒绝（ledger 金额恒为无符号，方向由 direction 表达）',
    badDirection.ok === false &&
    badDirection.errors.some(e => String(e).indexOf('amount-minor') >= 0), badDirection.errors);

  check('F9 被拒绝的交易没有留下任何行（拒绝是原子的）',
    store.getTransaction('econ_tx_unbal2').ok === false &&
    store.getTransaction('econ_tx_cross1').ok === false &&
    store.getTransaction('econ_tx_ghost1').ok === false &&
    store.listTransactions({ limit: 100 }).map(t => t.transactionId).join(',')
      .indexOf('unbal2') < 0);
  check('F10 全局拓扑在每个币种上恒等平衡 —— 这是 append-only 账本最核心的不变量',
    store.ledgerTopology(null).every(t => t.balanced === true) && store.ledgerTopology(null).length === 2,
    store.ledgerTopology(null));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   G · 余额重建（canonical = ledger，cache = derived）
   ══════════════════════════════════════════════════════════════════ */
section('G · rebuildWalletBalance（缓存不是事实源）');

{
  const store = makeStore();
  store.open();
  const w = walletWith(store, 750n);
  const before = store.ledgerBalanceOf(w.walletId);

  check('G1 ledgerBalanceOf 独立给出余额与两侧合计（不读缓存）',
    before.ok === true && before.balanceMinor === '750' && before.debitTotalMinor === '750' && before.creditTotalMinor === '0', before);

  /* 故意破坏缓存 —— 三个方向都试。 */
  const corruptions = [999999n, 0n, 1n];
  for (const bad of corruptions) {
    const c = store.corruptCachedBalanceForTest(w.walletId, bad);
    const view = store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {});
    check('G2 缓存被改坏为 ' + bad.toString() + '（模拟外部工具 / 崩溃后的漂移）',
      c.ok === true && view.cachedBalanceMinor === bad.toString() && view.cachedBalanceDrifted === true,
      { corruptedTo: c.corruptedTo, view: view });
    /* ── P22-3 把这条断言**加强**了，而不是放松 ───────────────────────
       P22-2 时这里写的是 `balanceString(...) === bad`：读路径的 available
       直接来自缓存，因此缓存被改坏 ⇒ available 跟着坏。
       P22-3 §7 明确要求 available = ledgerBalance − activeReservedBalance
       （两个输入都是 canonical），于是同一个场景现在必须得到**相反**的
       答案：数字不动，而"缓存与事实不符"作为漂移标记单独可见。
       被换掉的是一条"错误可见"的断言，换上的是"错误不可能影响资金判定"。
       缓存本身仍在 G3/G4 被 rebuild 修好并留下 BALANCE_REBUILT 审计。 */
    check('G2b 缓存被改坏之后 available **仍然**是 ledger 的值（一个坏缓存不能决定能不能花钱）',
      balanceString(store, w.walletId) === '750', balanceString(store, w.walletId));
    const rebuilt = store.rebuildWalletBalance(w.walletId);
    check('G3 rebuild 把余额恢复成 ledger 的值 ' + before.balanceMinor + '（而非缓存的值）',
      rebuilt.ok === true && rebuilt.cachedBalanceMinor === 750n && rebuilt.drifted === true && rebuilt.repaired === true,
      rebuilt.ok ? rebuilt.cachedBalanceMinor.toString() : rebuilt.errors);
    check('G4 rebuild 之后读出来的 available 也等于 ledger 的值，且漂移标记消失',
      balanceString(store, w.walletId) === '750' &&
      store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}).cachedBalanceDrifted === false,
      store.serializeWallet(store.getWallet({ walletId: w.walletId }).wallet, {}));
  }

  check('G5 缓存漂移被修复时留下一条 BALANCE_REBUILT change log（漂移不会静默消失）',
    store.listChanges(0, 100).filter(c => c.kind === 'BALANCE_REBUILT').length === 3,
    store.listChanges(0, 100).map(c => c.kind));
  check('G6 修复会推进 revision（它是一次 canonical 变更），且 revision 严格单调',
    (() => {
      const revs = store.listChanges(0, 100).map(c => c.revision);
      return revs.every((r, i) => i === 0 ? r === 1 : r === revs[i - 1] + 1);
    })(), store.listChanges(0, 100).map(c => c.revision));

  /* 缓存**没有**漂移时不写 change log，也不推进 revision ——
     否则"重建一次"会变成一次虚假的经济事件。 */
  const revBefore = store.getRevision();
  const clean = store.rebuildWalletBalance(w.walletId);
  check('G7 缓存正确时 rebuild 是只读的（drifted=false，revision 不动）',
    clean.ok === true && clean.drifted === false && clean.repaired === false && store.getRevision() === revBefore,
    { drifted: clean.drifted, revision: store.getRevision(), before: revBefore });

  const compute = store.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'COMPUTE_STANDARD' }).wallet;
  const c1 = store.mintForSystem({
    systemInitiated: true, walletId: compute.walletId, currency: 'COMPUTE_STANDARD',
    amountMinor: 12n, idempotencyKey: 'g-compute'
  });
  check('G8 compute 币种（scale=1）与 IB_CREDIT 在同一 store 里各自独立记账',
    c1.ok === true && store.ledgerBalanceOf(compute.walletId).balanceMinor === '12' &&
    store.ledgerBalanceOf(w.walletId).balanceMinor === '750');
  check('G9 重建只影响它自己的账户（另一个账户的余额与缓存都不动）',
    store.rebuildWalletBalance(compute.walletId).cachedBalanceMinor === 12n &&
    balanceString(store, w.walletId) === '750');
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   H · Idempotency
   ══════════════════════════════════════════════════════════════════ */
section('H · Idempotency（重放 / 冲突 / txId ≠ key / 跨重启）');

{
  const dir = tmpDir('idem');
  const store = makeStore({ dataDir: dir });
  store.open();
  const w = walletWith(store, 0n);

  const args = {
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 400n, idempotencyKey: 'key-1'
  };
  const first = store.mintForSystem(args);
  check('H1 第一次提交成功并给出 transactionId',
    first.ok === true && first.replayed === false && C.isEconomyId('TRANSACTION', first.transactionId), first.errors || '');

  const countsAfterFirst = store.health().counts;
  const replay = store.mintForSystem(args);
  check('H2 相同 idempotencyKey + 相同业务 → 返回**原来那笔** transaction（replayed=true）',
    replay.ok === true && replay.replayed === true && replay.transactionId === first.transactionId,
    { first: first.transactionId, replay: replay.transactionId });
  check('H3 重放**没有**第二次铸币：entries / transactions / revision 全部不动',
    J(store.health().counts) === J(countsAfterFirst) && store.getRevision() === first.result.revision,
    { before: countsAfterFirst, after: store.health().counts, revision: store.getRevision() });
  check('H4 重放**没有**多一条 change_log（否则"重试"会在审计里看起来像一次新事件）',
    store.listChanges(0, 100).filter(c => c.transactionId === first.transactionId).length === 1);
  check('H5 余额只增加了一次',
    store.ledgerBalanceOf(w.walletId).balanceMinor === '400', store.ledgerBalanceOf(w.walletId).balanceMinor);

  /* 相同 key + 不同 payload ⇒ fail closed，不允许静默返回第一次结果。 */
  const conflicts = [
    ['金额不同', Object.assign({}, args, { amountMinor: 500n })],
    ['钱包不同', Object.assign({}, args, { walletId: 'econ_wallet_other' })],
    ['币种不同', Object.assign({}, args, { currency: 'COMPUTE_STANDARD' })],
    ['类型不同（burn）', Object.assign({}, args, { systemInitiated: true, amountMinor: 400n, idempotencyKey: 'key-1', __burn: true })]
  ];
  const c1 = store.mintForSystem(conflicts[0][1]);
  check('H6 相同 key + 不同金额 ⇒ IDEMPOTENCY_CONFLICT（不是静默返回第一次结果）',
    c1.ok === false && c1.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0 && c1.committedTransactionId === first.transactionId,
    c1.errors);
  const burnSameKey = store.burnForSystem(conflicts[3][1]);
  check('H7 相同 key 但换成 BURN ⇒ 也是冲突（指纹覆盖交易类型，不只是金额）',
    burnSameKey.ok === false && burnSameKey.errors.indexOf('IDEMPOTENCY_CONFLICT') >= 0, burnSameKey.errors);
  check('H8 冲突被拒绝之后账本完全没变（冲突检测发生在任何写入之前）',
    store.ledgerBalanceOf(w.walletId).balanceMinor === '400' &&
    store.getRevision() === first.result.revision);

  /* transactionId ≠ idempotencyKey：同一个 txId 换一个 key。 */
  const reusedTxId = store.commitLedgerTransaction({
    transactionId: first.transactionId, type: C.TX_TYPE.MINT, idempotencyKey: 'key-OTHER',
    actor: { type: 'system', id: 'system:mint' }, ownerId: w.owner.id,
    entries: [
      { accountId: w.accountId, direction: 'DEBIT', amountMinor: 400n, currency: 'IB_CREDIT' },
      { accountId: 'system:mint', direction: 'CREDIT', amountMinor: 400n, currency: 'IB_CREDIT' }
    ]
  });
  check('H9 same transactionId / different idempotencyKey ⇒ 拒绝，**不覆盖**已有 transaction',
    reusedTxId.ok === false && reusedTxId.errors.indexOf('TRANSACTION_ID_ALREADY_COMMITTED') >= 0, reusedTxId.errors);
  check('H10 被拒绝的覆盖尝试之后，原 transaction 的幂等键没有被改写',
    store.getTransaction(first.transactionId).transaction.idempotencyKey === 'key-1');

  /* same key / different transactionId：显式给一个**新** txId，仍然必须
     返回原来那笔 —— 这就是"重试不得变成再买一次"。 */
  const explicitNewTx = store.mintForSystem(Object.assign({}, args, { transactionId: 'econ_tx_brandnew' }));
  check('H11 same key / different transactionId ⇒ 仍然返回**原来那笔**，不生成第二笔事实',
    explicitNewTx.ok === true && explicitNewTx.replayed === true &&
    explicitNewTx.transactionId === first.transactionId &&
    store.getTransaction('econ_tx_brandnew').ok === false,
    { returned: explicitNewTx.transactionId, first: first.transactionId });

  /* 数值与字符串 key 必须归一成同一个 key（否则 123 与 '123' 会被判成两个）。 */
  const kNum = store.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 7n, idempotencyKey: 12345
  });
  const kStr = store.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 7n, idempotencyKey: '12345'
  });
  check("H12 数值 key 与字符串 key 归一为同一个（12345 与 '12345' 是同一个业务请求）",
    kNum.ok === true && kStr.replayed === true && kStr.transactionId === kNum.transactionId);

  /* 非 canonical 的 key 被拒绝 */
  check('H13 非 canonical 的 idempotencyKey 被拒绝（空串 / 非整数 / 超长 / 非 string|number）',
    [null, undefined, '', 1.5, {}, [], Infinity].every(k => store.mintForSystem(Object.assign({}, args, { idempotencyKey: k })).ok === false));

  /* ── 跨重启 ─────────────────────────────────────────────────── */
  const revisionBefore = store.getRevision();
  const countsBefore = store.health().counts;
  store.close();
  const reopened = makeStore({ dataDir: dir });
  reopened.open();
  check('H14 重启后 revision 从原值继续（不回退、不复用）',
    reopened.getRevision() === revisionBefore, { after: reopened.getRevision(), before: revisionBefore });
  check('H15 重启后行数不变（ledger 与 wallet 都是持久的）',
    J(reopened.health().counts) === J(countsBefore), { after: reopened.health().counts, before: countsBefore });
  const replayAfterRestart = reopened.mintForSystem(args);
  check('H16 **跨重启**重放同一个 idempotencyKey：仍然返回原来那笔，不造成第二次 mutation',
    replayAfterRestart.ok === true && replayAfterRestart.replayed === true &&
    replayAfterRestart.transactionId === first.transactionId,
    replayAfterRestart.errors || replayAfterRestart.transactionId);
  check('H17 跨重启重放之后行数与 revision 都没有变',
    J(reopened.health().counts) === J(countsBefore) && reopened.getRevision() === revisionBefore);
  check('H18 跨重启后余额不变',
    reopened.ledgerBalanceOf(w.walletId).balanceMinor === '407', reopened.ledgerBalanceOf(w.walletId).balanceMinor);
  reopened.close();
}

/* ══════════════════════════════════════════════════════════════════
   I · Change log（可审计性）
   ══════════════════════════════════════════════════════════════════ */
section('I · Change log（余额为什么是这个数？）');

{
  const store = makeStore();
  store.open();
  const w = walletWith(store, 300n);
  const mint = store.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
    amountMinor: 100n, idempotencyKey: 'i-1'
  });

  const changes = store.listChanges(0, 100);
  check('I1 每一次 canonical mutation 都追加了 change log（开钱包 + 两笔 mint）',
    changes.length === 3 && changes[0].kind === C.EVENT_TYPE.WALLET_OPENED && changes[1].kind === 'MINT_COMMITTED',
    changes.map(c => c.kind));
  check('I2 revision 严格单调递增、不跳号、不复用',
    changes.every((c, i) => c.revision === i + 1), changes.map(c => c.revision));
  const mintChange = changes.filter(c => c.transactionId === mint.transactionId)[0];
  check('I3 交易相关的 change 同时带 transactionId 与 walletId（可追溯到具体事实与具体钱包）',
    !!mintChange && mintChange.walletId === w.walletId &&
    mintChange.entityId === mint.transactionId && Number.isFinite(mintChange.at),
    mintChange);
  check('I3b WALLET_OPENED 的 change 带 entityId 与 walletId，transactionId 为 null（它不是一笔交易）',
    changes[0].entityId === w.walletId && changes[0].walletId === w.walletId &&
    changes[0].transactionId === null && Number.isFinite(changes[0].at), changes[0]);
  check('I4 P22 §16 的四个问题都能被回答：哪笔 transaction 改变了它、有哪些 entries、顺序如何',
    (() => {
      const ledger = store.getTransaction(mint.transactionId);
      return ledger.ok === true && ledger.entries.length === 2 &&
        ledger.entries[0].seq === 0 && ledger.entries[1].seq === 1 &&
        ledger.entries.every(e => e.transactionId === mint.transactionId);
    })());
  check('I5 change log 里**没有**完整对象、没有凭据、没有正文 —— 只有最小元数据',
    (() => {
      const raw = J(changes);
      return raw.indexOf('apiKey') < 0 && raw.indexOf('Bearer') < 0 &&
        raw.indexOf('character_runtime_specs') < 0 && raw.length < 20000;
    })(), J(changes).length);
  check('I6 cursor 语义：从某个 revision 之后读取，得到的是**之后**的那些',
    store.listChanges(2, 100).map(c => c.revision).join(',') === '3');
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   J · 原子性 / 崩溃回滚（故障注入）
   ══════════════════════════════════════════════════════════════════ */
section('J · Atomicity（任何一个位置失败都必须整体回滚）');

{
  /* 四个位置逐个注入。每一次都用一个**全新**的库，因此"上一次的残留"
     不可能是这一次断言失败的原因。 */
  const points = ['after-transaction-insert', 'after-first-ledger-entry', 'before-wallet-cache', 'before-change-log'];
  for (const point of points) {
    const dir = tmpDir('fault-' + point);
    const hit = [];
    /* `armed` 是**必要的**：walletWith() 自己要先 mint 一次种子金额，
       而那个故障点会被它先触发。故障注入必须是可在运行期开关的，
       否则"播种"这一步会直接失败或者被迫跳过一段真实路径。 */
    const faults = {
      armed: false,
      hit(name) { hit.push(name); if (faults.armed && name === point) throw new Error('injected@' + point); }
    };
    const store = createEconomyStore({
      dataDir: dir, logger: () => { }, nextId: deterministicIds(), faults: faults
    });
    store.open();
    const w = walletWith(store, 250n);
    const before = { counts: store.health().counts, revision: store.getRevision(), balance: store.ledgerBalanceOf(w.walletId).balanceMinor };
    faults.armed = true;

    let threw = null;
    try {
      store.mintForSystem({
        systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
        amountMinor: 500n, idempotencyKey: 'fault-' + point
      });
    } catch (error) { threw = error; }
    faults.armed = false;

    /* 真实 SQLite 里逐项检查残留。 */
    const after = { counts: store.health().counts, revision: store.getRevision(), balance: store.ledgerBalanceOf(w.walletId).balanceMinor };
    check('J1[' + point + '] 注入的故障真的被触发了（断言的前提成立）',
      threw !== null && hit.indexOf(point) >= 0, { threw: threw && threw.message, hit: hit });
    check('J2[' + point + '] 0 条残留 transaction（半写的交易不存在）',
      after.counts.transactions === before.counts.transactions, { before: before.counts, after: after.counts });
    check('J3[' + point + '] 0 条残留 ledger entry（entries 不会写一半）',
      after.counts.entries === before.counts.entries, { before: before.counts, after: after.counts });
    check('J4[' + point + '] 0 条残留 change log（不会出现"事件记了、钱没动"）',
      after.counts.changes === before.counts.changes, { before: before.counts, after: after.counts });
    check('J5[' + point + '] 0 幻影余额（缓存没有被改）',
      after.balance === before.balance, { before: before.balance, after: after.balance });
    check('J6[' + point + '] revision 没有断裂（回滚不消耗版本号也不留空洞）',
      after.revision === before.revision, { before: before.revision, after: after.revision });
    check('J7[' + point + '] 幂等表里**没有**留下结果（否则重试会拿到一笔并不存在的交易 id）',
      store.mintForSystem({
        systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT',
        amountMinor: 500n, idempotencyKey: 'fault-' + point
      }).ok === true, 'retry after rollback must be able to actually commit');

    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(store.file));
    const orphanEntries = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.ENTRIES +
      ' WHERE transaction_id NOT IN (SELECT transaction_id FROM ' + store.TABLES.TRANSACTIONS + ')').get();
    const orphanChanges = raw.prepare('SELECT COUNT(*) AS c FROM ' + store.TABLES.CHANGE_LOG +
      ' WHERE transaction_id IS NOT NULL AND transaction_id NOT IN (SELECT transaction_id FROM ' + store.TABLES.TRANSACTIONS + ')').get();
    raw.close();
    check('J8[' + point + '] 直接查库：没有孤儿 entry、没有指向不存在交易的 change',
      Number(orphanEntries.c) === 0 && Number(orphanChanges.c) === 0, { entries: orphanEntries.c, changes: orphanChanges.c });
    check('J9[' + point + '] 回滚之后账本仍然**逐币种平衡**（不变量在异常路径上也成立）',
      store.ledgerTopology(null).every(t => t.balanced === true), store.ledgerTopology(null));
    store.close();
  }

  /* 故障发生在 transaction 插入之后：这一条**单独**再证一次"交易行本身
     也没有残留" —— 因为那是"先写交易再写 entry"这个顺序最容易漏的一环。 */
  const dir2 = tmpDir('fault-tx-only');
  const s2Faults = { armed: false, hit(name) { if (s2Faults.armed && name === 'after-transaction-insert') throw new Error('injected'); } };
  const s2 = createEconomyStore({
    dataDir: dir2, logger: () => { }, nextId: deterministicIds(), faults: s2Faults
  });
  s2.open();
  const w2 = walletWith(s2, 0n);
  const txCountBefore = s2.listTransactions({ limit: 100 }).length;
  s2Faults.armed = true;
  try {
    s2.mintForSystem({ systemInitiated: true, walletId: w2.walletId, currency: 'IB_CREDIT', amountMinor: 50n, idempotencyKey: 'k' });
  } catch (_) { /* 预期 */ }
  s2Faults.armed = false;
  check('J10 交易行与它的 entries 同生共死（不存在"交易在、entry 不在"）',
    s2.listTransactions({ limit: 100 }).length === txCountBefore, s2.listTransactions({ limit: 100 }).length);
  s2.close();
}

/* ══════════════════════════════════════════════════════════════════
   K · 持久化（close / reopen）
   ══════════════════════════════════════════════════════════════════ */
section('K · Persistence（close → open 之后账本原样）');

{
  const dir = tmpDir('persist');
  const store = makeStore({ dataDir: dir });
  store.open();
  const a = walletWith(store, 1000n, 'cfg_a');
  const b = store.openWallet({ owner: { type: 'character', id: 'cfg_b' }, currency: 'IB_CREDIT' }).wallet;
  store.transferBetweenWallets({
    fromWalletId: a.walletId, toWalletId: b.walletId,
    currency: 'IB_CREDIT', amountMinor: 250n, idempotencyKey: 'k-gift'
  });
  const snapshot = {
    revision: store.getRevision(),
    counts: store.health().counts,
    a: store.ledgerBalanceOf(a.walletId),
    b: store.ledgerBalanceOf(b.walletId),
    changes: store.listChanges(0, 100),
    transactions: store.listTransactions({ limit: 100 }),
    topology: store.ledgerTopology(null)
  };
  /* entries 必须在 close **之前**读出来 —— 关掉之后 store 会（正确地）
     拒绝读取，而那不是本组要测的东西。 */
  snapshot.entriesByTx = snapshot.transactions.map(t => ({
    transactionId: t.transactionId,
    entries: store.getTransaction(t.transactionId).entries
  }));
  store.close();

  const reopened = makeStore({ dataDir: dir });
  reopened.open();
  check('K1 重开后 revision 连续（不重置、不回退）',
    reopened.getRevision() === snapshot.revision, { after: reopened.getRevision(), before: snapshot.revision });
  check('K2 重开后行数逐项相同（wallet / transaction / entry / change）',
    J(reopened.health().counts) === J(snapshot.counts), { after: reopened.health().counts, before: snapshot.counts });
  check('K3 重开后两个钱包的余额**逐位相同**（来自 ledger，不是来自某个缓存文件）',
    J(reopened.ledgerBalanceOf(a.walletId)) === J(snapshot.a) &&
    J(reopened.ledgerBalanceOf(b.walletId)) === J(snapshot.b),
    { a: reopened.ledgerBalanceOf(a.walletId), b: reopened.ledgerBalanceOf(b.walletId) });
  check('K4 重开后 change log 逐条相同（revision / kind / entityId / payload）',
    J(reopened.listChanges(0, 100)) === J(snapshot.changes));
  check('K5 重开后 transaction 逐条相同（含 transactionId / revision / state）',
    J(reopened.listTransactions({ limit: 100 })) === J(snapshot.transactions));
  check('K5b 重开后每笔交易的 entries 逐条相同（含派生的 entry id 与 seq）',
    snapshot.entriesByTx.every(one =>
      J(reopened.getTransaction(one.transactionId).entries) === J(one.entries)),
    snapshot.entriesByTx.map(one => one.transactionId));
  check('K6 重开后全局拓扑仍然平衡',
    J(reopened.ledgerTopology(null)) === J(snapshot.topology) &&
    reopened.ledgerTopology(null).every(t => t.balanced === true));

  /* 重开之后缓存与 ledger 依然一致 —— 也就是说"持久化的是事实，
     不是那份派生缓存"。 */
  const v = reopened.getWallet({ walletId: a.walletId, rebuild: true });
  check('K7 重开后 rebuild 报告**没有漂移**（持久化的是 ledger，缓存是从它派生出来的）',
    v.ok === true && reopened.rebuildWalletBalance(a.walletId).drifted === false);
  reopened.close();
}

/* ══════════════════════════════════════════════════════════════════
   L · Schema 版本行为
   ══════════════════════════════════════════════════════════════════ */
section('L · Schema（fresh / same / older / newer-than-runtime）');

{
  const { DatabaseSync } = require('node:sqlite');

  /* fresh */
  const freshDir = tmpDir('schema-fresh');
  const fresh = makeStore({ dataDir: freshDir });
  const freshOpen = fresh.open();
  fresh.close();
  const rawFresh = new DatabaseSync(path.join(freshDir, 'home-node.db'));
  const schemaRow = rawFresh.prepare('SELECT value FROM ' + fresh.TABLES.META + ' WHERE key=?').get(fresh.META_KEYS.SCHEMA);
  rawFresh.close();
  check('L1 新库：open() 写入当前 schema 版本',
    String(schemaRow.value) === String(fresh.SCHEMA_VERSION) && freshOpen.schemaVersion === fresh.SCHEMA_VERSION);

  /* same version：直接再开一次 */
  const same = makeStore({ dataDir: freshDir });
  check('L2 同版本库：正常打开，不迁移、不改水位',
    same.open().ok === true && Number(same.health().schemaVersion) === same.SCHEMA_VERSION);
  same.close();

  /* older supported version：把水位降到 0，模拟"这个库是更早的 build 建的"。
     本阶段只有 0 → 1 这一步，但框架与它的测试必须现在就固定下来。 */
  const rawOlder = new DatabaseSync(path.join(freshDir, 'home-node.db'));
  rawOlder.prepare('UPDATE ' + fresh.TABLES.META + ' SET value=? WHERE key=?').run('0', fresh.META_KEYS.SCHEMA);
  rawOlder.close();
  const older = makeStore({ dataDir: freshDir });
  const olderOpen = older.open();
  const rawAfter = new DatabaseSync(path.join(freshDir, 'home-node.db'));
  const schemaAfter = rawAfter.prepare('SELECT value FROM ' + fresh.TABLES.META + ' WHERE key=?').get(fresh.META_KEYS.SCHEMA);
  rawAfter.close();
  check('L3 更老的受支持版本：迁移路径被执行并把水位抬到当前版本（0 → 1）',
    olderOpen.ok === true && String(schemaAfter.value) === String(fresh.SCHEMA_VERSION),
    { opened: olderOpen.ok, watermark: schemaAfter.value });
  check('L4 迁移期间账本没有被清空（迁移是水位操作，不是重建）',
    older.listWallets().length === 0 && older.listChanges(0, 10).length === 0);
  older.close();

  /* newer-than-runtime：必须**拒绝打开**，且不降级。 */
  const futureDir = tmpDir('schema-future');
  const seed = makeStore({ dataDir: futureDir });
  seed.open();
  walletWith(seed, 123n, 'cfg_future');
  seed.close();
  const rawFuture = new DatabaseSync(path.join(futureDir, 'home-node.db'));
  rawFuture.prepare('UPDATE ' + seed.TABLES.META + ' SET value=? WHERE key=?')
    .run(String(seed.SCHEMA_VERSION + 1), seed.META_KEYS.SCHEMA);
  rawFuture.close();

  const future = makeStore({ dataDir: futureDir });
  let threw = null;
  try { future.open(); } catch (error) { threw = error; }
  check('L5 比本 build 新的 schema：open() **拒绝**（SCHEMA_TOO_NEW / db-schema-too-new），绝不自动降级',
    threw !== null &&
    String(threw.message).indexOf('newer than this build') >= 0 &&
    threw.code === 'SCHEMA_TOO_NEW' &&
    /* dbFailure.toError 把类别也放进消息前缀：[db-schema-too-new] —— 
       于是上层（http.js / 探针）不需要 require 本模块就能分类。 */
    String(threw.message).indexOf('[db-schema-too-new]') >= 0,
    { message: threw && threw.message, code: threw && threw.code });
  check('L6 拒绝打开之后 isOpen() 是 false（没有半开的连接）', future.isOpen() === false);
  check('L7 拒绝打开之后 state 是 DEGRADED 而**不是** COLD —— 我们已经知道这一域服务不了，'
    + '把它说成"正在加载"会让 UI 永远转圈',
    future.health().state === C.WALLET_STATE.DEGRADED && !!future.health().degradedReason,
    { after: future.health().state, reason: future.health().degradedReason });
  check('L8 拒绝打开之后读任何钱包都拿不到余额（fail closed：null 而不是 0）',
    (() => {
      let got = null;
      try { got = future.getWallet({ ownerId: 'cfg_future', currency: 'IB_CREDIT' }); }
      catch (error) { return error.code === 'STORE_CLOSED'; }
      return got.ok === false;
    })());
  check('L9 未来的库文件没有被改动（拒绝是只读的，不尝试"修复"）',
    (() => {
      const raw = new DatabaseSync(path.join(futureDir, 'home-node.db'));
      const row = raw.prepare('SELECT value FROM ' + seed.TABLES.META + ' WHERE key=?').get(seed.META_KEYS.SCHEMA);
      const wallets = raw.prepare('SELECT COUNT(*) AS c FROM ' + seed.TABLES.WALLETS).get();
      raw.close();
      return String(row.value) === String(seed.SCHEMA_VERSION + 1) && Number(wallets.c) === 1;
    })());
  future.close();

  /* 水位不是合法整数时必须拒绝（而不是当成 0 然后"迁移"）。 */
  const junkDir = tmpDir('schema-junk');
  const junkSeed = makeStore({ dataDir: junkDir });
  junkSeed.open(); junkSeed.close();
  const rawJunk = new DatabaseSync(path.join(junkDir, 'home-node.db'));
  rawJunk.prepare('UPDATE ' + junkSeed.TABLES.META + ' SET value=? WHERE key=?').run('v1', junkSeed.META_KEYS.SCHEMA);
  rawJunk.close();
  const junk = makeStore({ dataDir: junkDir });
  check('L10 schema 水位不是合法整数时拒绝打开（不静默当成 0）',
    (() => { try { junk.open(); return false; } catch (e) { return String(e.message).indexOf('watermark') >= 0; } })());
}

/* ══════════════════════════════════════════════════════════════════
   M · 系统级 MINT / BURN 的授权与方向
   ══════════════════════════════════════════════════════════════════ */
section('M · mintForSystem / burnForSystem（system initiated only）');

{
  const store = makeStore();
  store.open();
  const w = walletWith(store, 0n);

  check('M1 缺少 systemInitiated 标记的铸币请求被拒绝（内部入口也需要显式声明自己是系统发起）',
    store.mintForSystem({ walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 10n, idempotencyKey: 'm1' })
      .errors.indexOf('system-initiated-required') >= 0);

  /* 注入一个"授权当前不可用"的谓词 —— 证明"即使有人把某个路由接到铸币上，
     铸币权也不会自动跟着来"。 */
  const dirNoAuth = tmpDir('no-auth');
  const noAuth = createEconomyStore({
    dataDir: dirNoAuth, logger: () => { }, nextId: deterministicIds(),
    systemAuthority: () => false
  });
  noAuth.open();
  const wNoAuth = noAuth.openWallet({ owner: { type: 'character', id: 'cfg_a' }, currency: 'IB_CREDIT' }).wallet;
  check('M2 授权谓词说"不可用"时铸币被拒绝（HTTP 面没有这个入口，这是第二道）',
    noAuth.mintForSystem({
      systemInitiated: true, walletId: wNoAuth.walletId, currency: 'IB_CREDIT',
      amountMinor: 10n, idempotencyKey: 'm2'
    }).errors.indexOf('system-authority-unavailable') >= 0);
  check('M3 授权被拒时账本一行也没写',
    noAuth.health().counts.transactions === 0 && noAuth.health().counts.entries === 0);
  noAuth.close();

  const mint = store.mintForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 100n, idempotencyKey: 'm-mint'
  });
  const entries = store.getTransaction(mint.transactionId).entries;
  check('M4 MINT：钱包侧 DEBIT、system:mint 侧 CREDIT（"钱从哪来"在 direction 上可读）',
    entries.length === 2 &&
    entries[0].accountId === w.accountId && entries[0].direction === 'DEBIT' &&
    entries[1].accountId === 'system:mint' && entries[1].direction === 'CREDIT',
    entries.map(e => e.accountId + ':' + e.direction));
  check('M5 MINT 的 actor 是 system:mint（不是"某个角色"），ownerId 是钱包的 owner',
    store.getTransaction(mint.transactionId).transaction.actor.id === 'system:mint' &&
    store.getTransaction(mint.transactionId).transaction.ownerId === 'cfg_a');

  const burn = store.burnForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 40n, idempotencyKey: 'm-burn'
  });
  const burnEntries = store.getTransaction(burn.transactionId).entries;
  check('M6 BURN：钱包侧 CREDIT、system:burn 侧 DEBIT（销毁的方向与增发相反）',
    burnEntries.length === 2 &&
    burnEntries[0].accountId === w.accountId && burnEntries[0].direction === 'CREDIT' &&
    burnEntries[1].accountId === 'system:burn' && burnEntries[1].direction === 'DEBIT',
    burnEntries.map(e => e.accountId + ':' + e.direction));
  check('M7 MINT 与 BURN 之后余额是正确的净额（100 − 40 = 60）',
    store.ledgerBalanceOf(w.walletId).balanceMinor === '60', store.ledgerBalanceOf(w.walletId).balanceMinor);
  /* 控制账户的符号是**显式**的：balanceMinor 是无符号幅值，方向由 sign
     表达 —— 契约规定 canonical amount 无符号，因此"−40"这种负金额
     字符串不允许出现（serializeAmountMinor 会直接返回 null）。 */
  const mintAcct = store.systemAccountBalance('system:mint', 'IB_CREDIT');
  const burnAcct = store.systemAccountBalance('system:burn', 'IB_CREDIT');
  check('M8 system:mint 累计增发是 CREDIT 方向的正向幅值（控制账户，符号用 sign 表达）',
    mintAcct.ok === true && mintAcct.balanceMinor === '100' && mintAcct.sign === 'CREDIT' &&
    mintAcct.creditTotalMinor === '100' && mintAcct.debitTotalMinor === '0', mintAcct);
  check('M8b system:burn 累计销毁是 DEBIT 方向的幅值（不是"−40"这种负金额字符串）',
    burnAcct.ok === true && burnAcct.balanceMinor === '40' && burnAcct.sign === 'DEBIT' &&
    C.serializeAmountMinor(-40n) === null, burnAcct);

  /* 余额不足的 BURN 也必须被拒绝 —— 不是靠"读缓存判断够不够"，
     而是靠重建后的余额与 entries 的一致性。 */
  const overdraft = store.burnForSystem({
    systemInitiated: true, walletId: w.walletId, currency: 'IB_CREDIT', amountMinor: 100000n, idempotencyKey: 'm-over'
  });
  check('M9 超额销毁被**业务化地拒绝**（insufficient-balance + 透支明细），而不是从深处抛异常',
    overdraft.ok === false && overdraft.errors.indexOf('insufficient-balance') >= 0 &&
    Array.isArray(overdraft.overdrafts) && overdraft.overdrafts.length === 1 &&
    overdraft.overdrafts[0].resultingBalanceSign === 'DEBIT',
    overdraft);
  check('M10 被拒绝的超额销毁之后余额不变，且账本仍然平衡',
    store.ledgerBalanceOf(w.walletId).balanceMinor === '60' &&
    store.ledgerTopology(null).every(t => t.balanced === true));
  store.close();
}

/* ══════════════════════════════════════════════════════════════════
   N · degraded / fail-closed
   ══════════════════════════════════════════════════════════════════ */
section('N · Fail closed（绝不存在 catch { return 0 }）');

{
  const dir = tmpDir('degraded');
  const store = makeStore({ dataDir: dir });
  store.open();
  const w = walletWith(store, 900n, 'cfg_a');
  store.close();

  /* 库关掉之后：COLD，且 available 是 null。 */
  check('N1 库关闭后 health().state 是 COLD，且**不是** 0 余额',
    store.health().state === C.WALLET_STATE.COLD);
  check('N2 库关闭后 getWallet() 抛 STORE_CLOSED（而不是返回一个 0 余额的钱包）',
    (() => { try { store.getWallet({ walletId: w.walletId }); return false; } catch (e) { return e.code === 'STORE_CLOSED'; } })());
  check('N3 库关闭后 rebuildWalletBalance 也抛 STORE_CLOSED（重建不可能在无库时"成功"）',
    (() => { try { store.rebuildWalletBalance(w.walletId); return false; } catch (e) { return e.code === 'STORE_CLOSED'; } })());
  check('N4 库关闭后余额的**任何**读取路径都不返回数字',
    store.health().counts.wallets === 0 && store.health().revision === 0);

  /* 重建失败 ⇒ DEGRADED ⇒ 之后所有 wallet 读都不给数字。 */
  const degDir = tmpDir('degraded2');
  const deg = createEconomyStore({
    dataDir: degDir, logger: () => { }, nextId: deterministicIds(),
    faults: null
  });
  deg.open();
  const dw = walletWith(deg, 500n, 'cfg_a');
  /* 删掉账户行：wallet 指向一个不存在的 ledger account。这是一个真正的
     结构完整性事故，而**降级**必须是它的答案 —— 因为 computeLedgerBalance
     会对一个不存在的账户求和得到 0，于是"我不知道"会被回答成"0 元"，
     那正是 P22-0 R5 的同一个根因换了一个入口。 */
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(degDir, 'home-node.db'));
  raw.prepare('DELETE FROM ' + deg.TABLES.ACCOUNTS + ' WHERE account_id=?').run(dw.accountId);
  raw.close();

  const failed = deg.rebuildWalletBalance(dw.walletId);
  check('N5 重建发现"钱包指向一个不存在的账户"时返回失败（而不是把 0 当成余额）',
    failed.ok === false && failed.errors.indexOf('rebuild-failed') >= 0 &&
    Array.isArray(failed.integrity) && failed.integrity.indexOf('account-row-missing') >= 0, failed);
  check('N6 重建失败之后 store 进入 DEGRADED（粘性），health() 如实上报原因',
    deg.health().state === C.WALLET_STATE.DEGRADED && !!deg.health().degradedReason,
    { state: deg.health().state, reason: deg.health().degradedReason });
  const degradedWallet = deg.getWallet({ walletId: dw.walletId });
  check('N7 DEGRADED 之后钱包读出来的 availableBalanceMinor 是 **null**，绝不是 0',
    degradedWallet.ok === true &&
    deg.serializeWallet(degradedWallet.wallet, {}).availableBalanceMinor === null &&
    deg.serializeWallet(degradedWallet.wallet, {}).balanceKnown === false,
    deg.serializeWallet(degradedWallet.wallet, {}));
  check('N8 DEGRADED 之后连"余额是 0"这个可表示状态都不存在（cachedBalanceMinor 也是 null）',
    deg.serializeWallet(degradedWallet.wallet, {}).cachedBalanceMinor === null);
  check('N9 DEGRADED 不让任何花费被允许（walletStateAllowsSpend 为 false）',
    C.walletStateAllowsSpend(deg.health().state) === false);
  deg.close();

  /* 一次成功的 open 会清掉降级结论 —— 否则"库修好了"无法被表达。 */
  const recovered = makeStore({ dataDir: dir });
  recovered.open();
  check('N10 重新打开一个健康的库会回到 READY（降级不是永久的、也不掩盖真实状态）',
    recovered.health().state === C.WALLET_STATE.READY && recovered.health().degradedReason === null);
  recovered.close();
}

/* ══════════════════════════════════════════════════════════════════
   O · Economy runtime 的依赖纪律（静态）
   ══════════════════════════════════════════════════════════════════ */
section('O · Runtime 依赖纪律（静态：本条与 boundary 测试互补）');

{
  const rawSrc = fs.readFileSync(path.join(ROOT, 'services', 'home-node', 'economy-store.js'), 'utf8');
  /* 先剥注释再扫 —— 否则一段**解释**为什么不用 crypto 的注释会被当成
     "require 了 crypto"。这是静态检查最容易自欺的一步。 */
  const src = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const requires = [];
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) requires.push(m[1]);

  /* ── 两层判定，检查的是同一件事，但规范来源不同 ─────────────────────
     ① 契约层：BOUNDARY_ALLOWED_MODULE_PREFIXES（node: 内建 + Economy 目录
        + runtime/db-failure.js）。
     ② 运行时层：boundary 测试用的仓库根相对路径（path.resolve 之后）。
     两种归一是**判定之前**做的映射，不是放宽判定：
       · 'path' / 'fs' 归一成 'node:path' / 'node:fs'（同一个东西的两种写法）；
       · '../../runtime/db-failure.js' 归一成 'runtime/db-failure.js'
         （否则它与白名单里的精确条目会被判成两条不同的依赖）。 */
  const BARE_BUILTIN = /^(?:path|fs|os|sqlite|crypto|url|util|events|stream|assert)$/;
  const STORE_FILE = path.join(ROOT, 'services', 'home-node', 'economy-store.js');
  const toRepoRelative = (spec) => {
    if (/^node:/.test(spec)) return spec;
    if (!/^\.{1,2}\//.test(spec)) return spec;
    return path.relative(ROOT, path.resolve(path.dirname(STORE_FILE), spec)).split(path.sep).join('/');
  };
  const normalized = requires.map(s =>
    BARE_BUILTIN.test(s) ? 'node:' + s : toRepoRelative(s));

  check('O1 归一后的 require 目标全部落在契约的允许前缀内（白名单，不是黑名单）',
    normalized.every(s => C.BOUNDARY_ALLOWED_MODULE_PREFIXES.some(p => s.indexOf(p) === 0)),
    normalized);
  check('O2 不 require 进程/网络/加密原语（child_process / net / http / https / crypto）',
    normalized.every(s => !/^(?:node:)?(child_process|net|http|https|tls|dgram|crypto|worker_threads)$/.test(s)), requires);
  check('O3 不 require Memory / Relationship / Middle Brain / Provider Router / 工具执行面',
    requires.every(s => !/(memory|role-dm|middle-brain|ib-model-core|provider-directory|node-model-port|integrations|tool-execution-guard|home-node\/execution)/i.test(s)),
    requires);
  check('O3b 不 require 真实支付 / 凭据面（pay-gate / alipay / payment-auth / credential-vault / commerce）',
    requires.every(s => !/(pay-gate|alipay|payment-provider|payment-auth|credential-vault|commerce)/i.test(s)), requires);
  check('O4 契约经 deps 注入（deps.contract），且有且仅有一处**惰性** require 作为缺省值',
    /const C = deps\.contract \|\| require\('\.\/economy-contract\.js'\)/.test(src) &&
    requires.filter(s => s === './economy-contract.js').length === 1,
    requires);
  /* 这条是 P22 §12 的核心：不存在任何"直接改余额"的写法。 */
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^\\'\n])*'/g, " '' ")
    .replace(/"(?:\\.|[^\\"\n])*"/g, ' "" ');
  check('O5 不存在 setBalance / incrementBalance / decrementBalance 形态的 API',
    !/\b(?:setBalance|incrementBalance|decrementBalance|addBalance|creditBalance|debitBalance|adjustBalance)\b/.test(stripped),
    (stripped.match(/\b\w*[Bb]alance\w*\s*\(/g) || []).slice(0, 20));
  check('O6 不存在 `balance += / -=` 形态（余额变化只能来自 committed entries）',
    !/balance\w*\s*(?:\+=|-=|\+\+|--)/i.test(stripped) &&
    !/cached_balance_minor\s*=\s*cached_balance_minor\s*[+\-]/i.test(src));
  check('O7 唯一改缓存的语句是"赋成从 ledger 算出来的值"，而不是"在旧值上加"',
    /SET cached_balance_minor=\?, reserved_balance_minor=\?/.test(src) &&
    (src.match(/SET cached_balance_minor/g) || []).length === 1,
    (src.match(/SET cached_balance_minor/g) || []).length);  /* ── P22-3 修正了一处**名字比断言大**的地方 ─────────────────────────
     原断言叫"该语句只出现在一个私有函数里（调用点唯一），且只被 commit
     路径调用"，但它实际只检查了 `>= 1` 次出现与"没有导出"。P22-3 确实
     从 reserveFunds / commitReservation 的路径上写过缓存列（setWalletBalance
     一次，setWalletReserved 三次），因此那句名字现在是**假的**。
     这里换成两句各自成立的话：语句存在，且**没有任何公开 API 直接暴露
     它**（缓存列不可能被外部当成 setter 用）。 */
  check('O8 两条缓存写语句都只出现在私有函数里 —— 它们没有被任何公开 API 暴露出去',
    (src.match(/SQL\.setWalletBalance/g) || []).length >= 1 &&
    (src.match(/SQL\.setWalletReserved/g) || []).length >= 1 &&
    !/exports\.setWalletBalance/.test(src) && !/exports\.setWalletReserved/.test(src) &&
    !/setWalletBalance:\s*setWalletBalance/.test(src) &&
    !/setWalletReserved:\s*setWalletReserved/.test(src));
  /* P22-3 §22：reserved 缓存**只能**被整体赋值成"从 active reservations
     求和得到的值"。因此"在旧值上加/减"的形态必须一个都不存在 —— 不是
     "我们记得别那么写"，而是"那种 SQL 根本没被写出来"。 */
  check('O8b 不存在"在旧 reserved 上加/减"的写法：唯一写它的语句是整体赋值',
    /SET reserved_balance_minor=\?, revision=\?, updated_at=\? WHERE wallet_id=\?/.test(src) &&
    !/reserved_balance_minor\s*[+\-]=/.test(src) &&
    !/reserved_balance_minor\s*=\s*reserved_balance_minor\s*[+\-]/.test(src) &&
    !/reserved_balance_minor\s*\+\s*\?/.test(src) &&
    !/reserved_balance_minor\s*-\s*\?/.test(src));
  /* append-only：交易与 entry 一旦写下就不再被 UPDATE / DELETE。
     这条不是在数 SQL 字符串，而是在证明**那两条语句根本不存在** ——
     状态机（P22-3）的状态推进必须走新的列/新的方法，不能偷偷在这里加
     一条 UPDATE。

     ── P22-3 修好了一个**假绿**（这条断言此前什么都没检查）──────────
     旧版扫描器的两个正则都期望表名**紧跟**在 UPDATE 后面：
       /(?<!CONFLICT )(?:UPDATE|DELETE\s+FROM)\s+(?:\+\s*)?[A-Za-z_]\w*(?=[\s'"]?\+)/
     而本文件的 SQL 一律写成 `'UPDATE ' + WALLETS_TABLE + ' ...'` ——
     表名前面隔着一个引号与一个空格，于是两个正则**都匹配不到任何东西**，
     mutatedTables 恒为 `[]`，而 `[].every(...)` 恒为 true。
     实测（P22-3 开发期）：`node -e` 跑这两个正则，两个结果都是 `[]`。
     也就是说 P22-2 的 O9/O9b 在"保护空气"。
     修法是两件事，缺一不可：
       ① 让扫描器认得 `'UPDATE ' + TABLE_CONST` 这种真实形状；
       ② 加一条**非空断言**（O9-pre）：如果扫描器又变瞎，测试立刻失败，
          而不是安静地通过。一条静态检查若不知道自己抓到了什么，
          它就不是检查，是一句注释。 */
  const MUTATION_RE = /(?:UPDATE|DELETE\s+FROM)\s*['"]?\s*\+\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  const mutatingStatements = [];
  const mutatedTables = [];
  let mm;
  while ((mm = MUTATION_RE.exec(src))) {
    const table = mm[1];
    mutatingStatements.push(mm[0].replace(/\s+/g, ' '));
    if (mutatedTables.indexOf(table) < 0) mutatedTables.push(table);
  }
  /* ON CONFLICT(...) DO UPDATE SET 是 upsert 的语法，不是对某张表的
     UPDATE。它在同一个 INSERT 语句里，因此**不**出现在 MUTATION_RE 的
     结果里（表名不在 UPDATE 之后）—— 这一点本身也是被断言的。 */
  check('O9-pre （输入存在）扫描器真的抓到了那些 mutation 语句 —— 否则 O9/O9b 是在保护空气',
    mutatingStatements.length >= 3 &&
    mutatedTables.indexOf('WALLETS_TABLE') >= 0 &&
    mutatedTables.indexOf('IDEMPOTENCY_TABLE') >= 0 &&
    mutatedTables.indexOf('OPERATIONS_TABLE') >= 0 &&
    mutatedTables.indexOf('RESERVATIONS_TABLE') >= 0,
    { statements: mutatingStatements, tables: mutatedTables });
  /* meta 的水位不是靠 UPDATE 改的，而是靠 upsert（一条 INSERT）。
     它必须**单独**被断言，否则 MUTABLE_TABLES 里的 META_TABLE 会在
     "扫描器根本看不到它"的情况下显得像是被允许的。 */
  check('O9-pre2 meta 水位走的是 upsert（ON CONFLICT ... DO UPDATE SET），而不是一条独立的 UPDATE',
    /INSERT INTO ' \+ META_TABLE \+ ' \(key, value\) VALUES \(\?, \?\) ON CONFLICT\(key\) DO UPDATE SET value=excluded\.value/.test(src) &&
    mutatedTables.indexOf('META_TABLE') < 0,
    mutatedTables);

  /* 允许被改的表：派生缓存（wallets）、revision 水位（meta）、
     P22-3 的两个**生命周期**表（operations / reservations，
     只允许改状态与链接列，见 O9c），两张按 TTL 清理的幂等表，
     以及 P22-4 的**规则表**与**命题表**（budget_policies / quotes ——
     它们改的是规则与报价的状态，不是任何一笔已发生的经济事实；
     quotes 的金额/币种/买家不可变由 P22-4 测试逐列断言）。
     ACCOUNTS 与三个 ledger 事实表**不**在允许集合里。

     ── P22-5 再扩三张（同样的理由，第三次）────────────────────────────
     stores / products / inventory 各自有一条 UPDATE：
       · stores     —— 改的是组织方式（名字 / 顺序 / 状态），不是价格事实；
       · products   —— 改的是**商品现在**的价格与状态。它改不到任何一笔
                       已经发生的经济事实：报价的金额在报价自己的列上，
                       而 P22-5 的 focused 测试逐条断言"改价之后历史报价
                       与历史库存逐字节不变"；
       · inventory  —— 只改 quantity 与记账元数据（owner / product /
                       asset_kind / created_at 一次都不出现，P22-5 测试
                       的静态断言逐列检查）。
     三个 ledger 事实表与 ACCOUNTS 仍然**不**在允许集合里，O9b 继续逐字
     断言这一点。

     ── P22-6 再扩一张（第四次）────────────────────────────────────────
     purchases 有两条 UPDATE：结算（status / ledger_transaction_id /
     inventory_entry_id / revision / updated_at / completed_at）与终结
     （status / release_reason / reason_code / revision / updated_at）。
     它们改的是**这次购买现在处在哪个结局**，改不到任何一笔已经发生的
     经济事实：金额在 amount_minor（Prepare 时从 Quote 快照写下，两条
     语句的 SET 里都没有它），钱动没动在 ledger 里（那三张表仍然被 O9b
     挡着）。O9f/O9g 追加逐列断言。

     ── P22-7 再扩两张（第五次）────────────────────────────────────────
     autonomy_policies 与 approvals 各有一条 UPDATE：
       · autonomy_policies —— 改的是**规则**（enabled / 三个额度 /
                              两个白名单 / allow_gift），不是任何一笔已发生
                              的经济事实；
       · approvals         —— 改的是**这条批准处在哪个结局**（status /
                              决定者 / 决定时间 / 消费链接）。九条**绑定
                              事实**（buyer / recipient / product / quote /
                              currency / amount / settlement / grantQuantity /
                              units）与 binding_fingerprint 一次都不出现在
                              任何 UPDATE 的 SET 里 —— 那正是 §6 的落点：
                              "批准之后换掉商品/价格/recipient/数量/settlement，
                              批准必须失效"意味着批准的**内容**不可变，
                              唯一能变的是它的结局。O9i/O9j 追加逐列断言。 */
  const MUTABLE_TABLES = ['WALLETS_TABLE', 'META_TABLE', 'IDEMPOTENCY_TABLE',
    'OPERATIONS_TABLE', 'RESERVATIONS_TABLE', 'OPERATION_IDEMPOTENCY_TABLE',
    'BUDGET_POLICIES_TABLE', 'QUOTES_TABLE',
    'STORES_TABLE', 'PRODUCTS_TABLE', 'INVENTORY_TABLE',
    'PURCHASES_TABLE', 'AUTONOMY_POLICIES_TABLE', 'APPROVALS_TABLE',
    /* ★ P22-8：一次 Agent 打算的**结局**是可以变的（PROPOSED → … →
       COMPLETED／DENIED／EXPIRED／FAILED），因此它的行必须可 UPDATE。这与
       P22-3 的 reservations / P22-6 的 purchases / P22-7 的 approvals 是
       同一类：一条**生命周期行**，而"它走到哪一步了"正是那个会变的事实。
       ★ 它变不了的东西由另外两条断言守着（P22-8 的 L 组：那张表里没有
       任何经济值列），而不是靠"不许 UPDATE"来守 —— 把一条会走到终态的
       记录写成 append-only，等于要求"打算"在写下的那一刻就知道自己的
       结局，那正是本阶段刻意不要的东西。 */
    'PURCHASE_INTENTS_TABLE'];
  check('O9 被 UPDATE / DELETE 的表只可能是"派生缓存 / 水位 / 生命周期行 / 幂等表"这四类，'
    + 'ACCOUNTS 与三个 ledger 事实表都不在内',
    mutatedTables.every(t => MUTABLE_TABLES.indexOf(t) >= 0), mutatedTables);
  check('O9b 三个 append-only 表（transactions / entries / change_log）不出现在任何 UPDATE / DELETE 里',
    mutatingStatements.every(s => !/(TRANSACTIONS_TABLE|ENTRIES_TABLE|CHANGE_LOG_TABLE)/.test(s)),
    mutatingStatements);

  /* ── O9c · 生命周期行里**经济内容**不可变（P22-3 的落点）────────────
     允许 UPDATE reservations 的 status 与链接列，**不等于**允许改它锁了
     多少钱、锁给谁。因此这里把两条 UPDATE 的 SET 子句逐列读出来断言：
     能赋的列是一个精确集合，而经济内容列一次都不出现。
     这一条比"grep 一个词"强：它检查的是**语句的语义**（SET 了哪些列）。 */
  const statementWindow = (name) => {
    const at = src.indexOf(name + ':');
    if (at < 0) return null;
    const rest = src.slice(at);
    /* 语句体可能跨行（缩进 6 空格），下一条 SQL 字段是 4 空格 + 字母。 */
    const boundary = rest.search(/\n {4}[A-Za-z]/);
    return boundary < 0 ? rest : rest.slice(0, boundary);
  };
  const setColumnsOf = (name) => {
    const window = statementWindow(name);
    if (!window) return null;
    const m = /SET ([^']*?) WHERE/.exec(window);
    if (!m) return null;
    return m[1].split(',').map(s => s.trim().split('=')[0].trim()).sort();
  };
  const opSetColumns = setColumnsOf('setOperationStatus');
  const resSetColumns = setColumnsOf('setReservationStatus');
  const ECONOMIC_CONTENT_COLUMNS = ['wallet_id', 'currency', 'amount_minor', 'operation_id', 'idempotency_key', 'fingerprint', 'created_at'];
  check('O9c economy_operations 的 UPDATE 只能赋生命周期列（status / reservation_id / transaction_id / reason_code / revision / updated_at）',
    opSetColumns != null &&
    opSetColumns.join(',') === 'reason_code,reservation_id,revision,status,transaction_id,updated_at' &&
    ECONOMIC_CONTENT_COLUMNS.every(c => opSetColumns.indexOf(c) < 0),
    opSetColumns);
  check('O9d economy_reservations 的 UPDATE 只能赋生命周期列（status / transaction_id / release_reason / revision / updated_at）',
    resSetColumns != null &&
    resSetColumns.join(',') === 'release_reason,revision,status,transaction_id,updated_at' &&
    ECONOMIC_CONTENT_COLUMNS.every(c => resSetColumns.indexOf(c) < 0),
    resSetColumns);
  check('O9e 两条生命周期 UPDATE 都带 `AND status=?`（终态不可回退是一条**并发安全**的 SQL 约束，不是一句注释）',
    /WHERE operation_id=\? AND status=\?/.test(statementWindow('setOperationStatus') || '') &&
    /WHERE reservation_id=\? AND status=\?/.test(statementWindow('setReservationStatus') || ''),
    [statementWindow('setOperationStatus'), statementWindow('setReservationStatus')]);
  /* ── O9f/O9g · P22-6：purchase 的两条 UPDATE 逐列读出 ────────────────
     它们能赋的列是一个**精确集合**，而经济内容列（buyer / recipient /
     product / store / quote / reservation / currency / amount / 交付形态 /
     交付量 / 单位名 / created_at / idempotency_key / fingerprint）一次都
     不出现。这一条正是 §1"Purchase 不是 ledger transaction 的视图、
     它的经济内容写下之后不可变"的静态落点。 */
  const purchaseSettledColumns = setColumnsOf('setPurchaseSettled');
  const purchaseTerminalColumns = setColumnsOf('setPurchaseTerminal');
  const PURCHASE_ECONOMIC_COLUMNS = ['buyer_id', 'buyer_type', 'recipient_id', 'recipient_type',
    'product_id', 'store_id', 'quote_id', 'reservation_id', 'currency', 'amount_minor',
    'quote_kind', 'settlement_type', 'asset_kind', 'granted_quantity', 'unit_name',
    'created_at', 'idempotency_key', 'fingerprint', 'consent_snapshot'];
  check('O9f economy_purchases 的结算 UPDATE 只能赋结局列（status / ledger_transaction_id / inventory_entry_id / revision / updated_at / completed_at）',
    purchaseSettledColumns != null &&
    purchaseSettledColumns.join(',') === 'completed_at,inventory_entry_id,ledger_transaction_id,revision,status,updated_at' &&
    PURCHASE_ECONOMIC_COLUMNS.every(c => purchaseSettledColumns.indexOf(c) < 0),
    purchaseSettledColumns);
  check('O9g economy_purchases 的终结 UPDATE 只能赋结局列（status / release_reason / reason_code / revision / updated_at）',
    purchaseTerminalColumns != null &&
    purchaseTerminalColumns.join(',') === 'reason_code,release_reason,revision,status,updated_at' &&
    PURCHASE_ECONOMIC_COLUMNS.every(c => purchaseTerminalColumns.indexOf(c) < 0),
    purchaseTerminalColumns);
  check('O9h 两条 purchase UPDATE 都带 `AND status=?`（"一个终态不可回退"由 SQL 承担，不靠 JS 的 if）',
    /WHERE purchase_id=\? AND status=\?/.test(statementWindow('setPurchaseSettled') || '') &&
    /WHERE purchase_id=\? AND status=\?/.test(statementWindow('setPurchaseTerminal') || ''),
    [statementWindow('setPurchaseSettled'), statementWindow('setPurchaseTerminal')]);
  /* ── O9i/O9j · P22-7：approval 的三条 UPDATE 逐列读出 ────────────────
     ★ 这一组比 O9f/O9g **更强**：除了"经济内容不可变"，它还要求九条
     **绑定事实**与 binding_fingerprint 不在任何 SET 里（§6：批准之后换掉
     商品 / 价格 / recipient / 数量 / settlement，批准必须失效 —— 那句话
     的静态一半就是"批准的授权内容不可变"）。
     三条语句各自带一个 `AND status=?` 闸门：两个进程同时决定同一条批准时，
     必然有一个 changes=0。 */
  const approvalDecidedColumns = setColumnsOf('setApprovalDecided');
  const approvalExpiredColumns = setColumnsOf('setApprovalExpired');
  const APPROVAL_BINDING_COLUMNS = ['buyer_id', 'buyer_type', 'recipient_id', 'recipient_type',
    'product_id', 'quote_id', 'quote_kind', 'currency', 'amount_minor', 'settlement_type',
    'grant_quantity', 'units', 'binding_fingerprint', 'authorization_mode',
    'approvalMode', 'autonomy_policy_id', 'autonomy_outcome', 'autonomy_reason_code',
    'created_at', 'idempotency_key', 'fingerprint'];
  check('O9i economy_approvals 的决定 UPDATE 只能赋结局列（status / 决定者 / revision / updated_at / decided_at），'
    + '九条绑定事实一次都不出现',
    approvalDecidedColumns != null &&
    approvalDecidedColumns.join(',') === 'decided_at,decided_by_id,decided_by_type,revision,status,updated_at' &&
    APPROVAL_BINDING_COLUMNS.every(c => approvalDecidedColumns.indexOf(c) < 0),
    approvalDecidedColumns);
  check('O9j economy_approvals 的过期与消费 UPDATE 只能赋结局列，且消费语句把"只能从 APPROVED 走到 CONSUMED"写进 WHERE'
    + '（一次性消费是一条 SQL 谓词，不是一句约定）',
    approvalExpiredColumns != null &&
    approvalExpiredColumns.join(',') === 'revision,status,updated_at' &&
    APPROVAL_BINDING_COLUMNS.every(c => approvalExpiredColumns.indexOf(c) < 0) &&
    (() => {
      const consumed = setColumnsOf('setApprovalConsumed');
      if (consumed == null) return false;
      return consumed.join(',') === 'consume_reason,consumed_at,consumed_by_purchase_id,revision,status,updated_at' &&
        APPROVAL_BINDING_COLUMNS.every(c => consumed.indexOf(c) < 0) &&
        /WHERE approval_id=\? AND status=\?/.test(statementWindow('setApprovalConsumed') || '') &&
        (() => {
          /* ★ 谓词的**实参**也必须逐字是 APPROVED：语句里写的是
             `AND status=?`，因此"只能从 APPROVED 消费"这句话要靠绑定值
             落实。这一条断言的是调用点，而不是 SQL 文本。 */
          const call = /SQL\.setApprovalConsumed\)\.run\(([\s\S]{0,400}?)\);/.exec(src);
          return call != null && /C\.APPROVAL_STATE\.APPROVED/.test(call[1]) &&
            /C\.APPROVAL_STATE\.CONSUMED/.test(call[1]);
        })();
    })(),
    [approvalExpiredColumns, setColumnsOf('setApprovalConsumed')]);
  check('O9k 三条 approval UPDATE 都带 `AND status=?`，且自主策略的 UPDATE 只改规则列',
    /WHERE approval_id=\? AND status=\?/.test(statementWindow('setApprovalDecided') || '') &&
    /WHERE approval_id=\? AND status=\?/.test(statementWindow('setApprovalExpired') || '') &&
    /WHERE approval_id=\? AND status=\?/.test(statementWindow('setApprovalConsumed') || '') &&
    (() => {
      const policyCols = setColumnsOf('updateAutonomyPolicy');
      if (policyCols == null) return false;
      return policyCols.join(',') === 'allow_gift,allowed_product_kinds,allowed_settlement_types,'
        + 'approval_above_minor,daily_autonomous_limit_minor,enabled,fingerprint,idempotency_key,'
        + 'per_purchase_limit_minor,revision,updated_at';
    })(),
    [statementWindow('setApprovalDecided'), statementWindow('setApprovalConsumed'), setColumnsOf('updateAutonomyPolicy')]);
  check('O11 故障注入只在 deps.faults 上，且没有任何 HTTP 层能写它（本文件不 require http）',
    /const faults = deps\.faults \|\| null/.test(src) && requires.indexOf('node:http') < 0);
  check('O12 test-only 的破坏辅助被**显式命名**为 ForTest（读代码时不会被误当成产品 API）',
    /corruptCachedBalanceForTest/.test(src) && /_internal/.test(src));
  check('O13 文件里不出现 character_runtime_specs / 凭据头的读法 / Bearer（凭据边界）',
    stripped.indexOf('character_runtime_specs') < 0 &&
    /* ★ 这里断言的是**读凭据头**这件事，而不是 "authorization" 这个词。
       P22-7 引入了 authorization 这一层（购买行上的授权模式与读面的
       authorizationSummary），于是"出现这个词"与"读一个凭据头"不再等价 ——
       继续用词禁会把它变成对命名的禁令，而那种断言只会逼出为绕过它而起的
       名字。逐条点名真正的读法，反例由 http.js 提供（见 P22-1 的 B6.3）。 */
    !/req\.headers\s*\.\s*authorization/i.test(stripped) &&
    !/req\.headers\s*\[\s*['"]authorization['"]\s*\]/i.test(stripped) &&
    !/headers\s*\.\s*authorization/i.test(stripped) &&
    stripped.indexOf('Bearer') < 0);
}

/* ══════════════════════════════════════════════════════════════════
   汇总
   ══════════════════════════════════════════════════════════════════ */
console.log('\n' + '═'.repeat(64));
if (failures === 0) {
  console.log('P22-2 store: 全部通过 ✔');
  process.exitCode = 0;
} else {
  console.error('P22-2 store: ' + failures + ' 项失败 ✘');
  process.exitCode = 1;
}
