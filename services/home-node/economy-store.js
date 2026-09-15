/* ====================================================================
   IB Home Node · Agent Economy canonical store（P22-2）
   --------------------------------------------------------------------
   本文件是 Economy 的**第一块 canonical runtime**，回答且只回答两个问题：

     「这个钱包现在有多少？（= 从 ledger 重建出来的数）」
     「这个余额是被哪些 transaction 的哪些 entry 变成这样的？」

   canonical financial truth 是 **ledger entries**（SQLite）。
   Wallet 的 cachedBalance 只是**派生缓存** —— 任何写路径都不得以它为
   输入算新余额（P22-1 §6.1）。这一点不是注释里的约定，而是结构上的：
   本文件里唯一能改 cached_balance_minor 的语句在一个私有函数里被调用
   一次，而它写入的值来自**本次 transaction 的 entries**，不是旧缓存。

   ── 为什么沿用 memory-store.js / chat-store.js 的形状 ────────────────
   同一个 SQLite 文件、同一套 PRAGMA、同一套 deps 工厂 / `const SQL = {}`
   / withTransaction / 迁移水位 / `schema 太新即拒绝`。
   **但 revision / change_log / idempotency 三者的命名空间完全独立**
   （economy_meta / economy_change_log / economy_idempotency），理由与
   memory-store.js:12-16 的既有决定逐字相同：一个权威域一个版本键。
   若共用 chat 的 change_log，一次余额变化会让**聊天**镜像游标失效。
   而 idempotency 尤其不能共用：chat 的 `idempotency` 表把 key 映射到
   `message_id`，Economy 需要的是 key → transaction + **request fingerprint**
   （见 §13），两者的列不同，硬塞进一张表就得放宽它的约束。

   ── 本阶段**刻意**没有的东西 ────────────────────────────────────────
     reservation（P22-3）· quote / purchase intent / approval（P22-3/4）
     product / inventory / store（P22-5）· exchange（P22-6）
     compute 计价（P22-7）· Decision/Action adapter（P22-8）
     provider 适配（P22-9）· UI / 浏览器镜像（P22-11）
   transactions 表里有一列 `state`，但 P22-2 只在 COMMIT 的那一刻写入
   `COMMITTED`，且**不再更新**（append-only）。状态机本身属于 P22-3；
   这里只把"终态不可回退"这条契约用"根本没有 UPDATE 路径"来满足。

   ── 依赖纪律（boundary B3.1 白名单）──────────────────────────────────
   本文件只 require：`node:sqlite`、`node:fs`、经白名单前缀的相对模块。
   **不 require crypto / net / http / child_process**，也**不 require**
   Memory / Relationship / Provider Router / 真实支付 —— Ledger + Wallet
   根本不需要这些依赖。契约（./economy-contract.js）从**注入**进来，
   于是"契约的物理位置"不进入本文件的静态 require 闭包。
   ==================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const dbFailure = require('../../runtime/db-failure.js');

/* ── schema ──────────────────────────────────────────────────────────
   版本单调递增。运行时遇到**更新的**库一律拒绝打开（见 open()），
   绝不"尽力而为"地降级 —— 一个由新 build 写过的 ledger，用旧代码
   去读会把不认识的列当成不存在的语义。 */
const ECONOMY_SCHEMA_VERSION = 1;
const DEFAULT_DB_FILENAME = 'home-node.db';

const META_TABLE = 'economy_meta';
const CHANGE_LOG_TABLE = 'economy_change_log';
const IDEMPOTENCY_TABLE = 'economy_idempotency';
const ACCOUNTS_TABLE = 'economy_ledger_accounts';
const WALLETS_TABLE = 'economy_wallets';
const TRANSACTIONS_TABLE = 'economy_transactions';
const ENTRIES_TABLE = 'economy_ledger_entries';

/* meta 的键。**独立命名空间**：全部带 economy_ 前缀，且存在
   economy_meta 表里（不是共用的 meta 表），因此任何其它 store 都不可能
   覆盖它们 —— 这是"revision namespace 只属于 Economy"的结构保证。 */
const META_SCHEMA = 'economy_schema';
const META_REVISION = 'economy_revision';
const META_ENGINE_STATE = 'economy_engine_state';
const META_ENGINE_REASON = 'economy_engine_reason';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_MAX = 2000;

/* SQLite INTEGER 是 64 位有符号；契约上界是 MAX_SAFE_INTEGER，
   因此 canonical 金额永远装得下。这里仍然显式断言一次：
   "装得下"必须是查出来的，不是想出来的。 */
const MAX_AMOUNT_MINOR = 9007199254740991;

function loadSqlite() {
  try { return require('node:sqlite'); }
  catch (error) {
    const err = new Error('node:sqlite is unavailable in this runtime: ' + (error && error.message || error));
    err.code = 'SQLITE_UNAVAILABLE';
    throw err;
  }
}

/* ── 确定性 fingerprint（非加密）──────────────────────────────────────
   idempotency 需要"同一个业务请求"的判定。这里刻意用 FNV-1a 双通道
   拼一个 64 位十六进制串，而**不是** require('crypto')：
     · 它不是安全边界 —— key 的所有权本来就不构成信任（能提交同一个 key
       的人本来就能提交那笔业务），它挡的是"无意中把两个不同请求合成一个"；
     · boundary B3.7 明确否认 Economy 依赖加密原语，这条纪律不该为了
       一个非安全用途而破例。
   注入 deps.fingerprint 可替换（测试用）。 */
function fnv1a64Hex(text) {
  const s = String(text);
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x9e3779b97f4a7c15n;
  const P1 = 0x100000001b3n;
  const P2 = 0x2545f4914f6cdd1dn;
  for (let i = 0; i < s.length; i++) {
    const c = BigInt(s.charCodeAt(i));
    h1 = ((h1 ^ c) * P1) & 0xffffffffffffffffn;
    /* 第二条通道读的是倒序位置，于是字符换位不会静默同值。 */
    h2 = ((h2 ^ (c + BigInt(s.length - i))) * P2) & 0xffffffffffffffffn;
  }
  return h1.toString(16).padStart(16, '0') + h2.toString(16).padStart(16, '0');
}

/* 稳定串行化：键排序、BigInt 显式转十进制字符串、函数/undefined 拒绝。
   不直接用 JSON.stringify，因为 BigInt 会让它抛 TypeError，而"抛了"
   在这里的后果是"幂等性静默失效"（catch 一下就过去了）。 */
function stableStringify(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'bigint') return '"' + value.toString() + '"';
  if (t === 'number' || t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (t === 'undefined') return 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
  }
  /* function / symbol：不可序列化的东西不能进入 fingerprint，否则
     "同样的请求"会有不稳定的身份。显式写成类型名，让它可见而不是抛错。 */
  return JSON.stringify('<unserializable:' + t + '>');
}

function createEconomyStore(deps) {
  deps = deps || {};
  const dataDir = deps.dataDir || process.cwd();
  const dbFile = deps.dbFile || path.join(dataDir, DEFAULT_DB_FILENAME);
  const clock = deps.clock || (() => Date.now());
  const logger = deps.logger || (() => {});
  const sqlite = deps.sqlite || loadSqlite();
  /* 契约从注入进来。缺省时在工厂内部 require —— 刻意**不**在模块顶部，
     这样"契约从哪里来"是一个装配决定，而不是本文件的一条静态依赖。 */
  const C = deps.contract || require('./economy-contract.js');
  const fingerprintOf = typeof deps.fingerprint === 'function' ? deps.fingerprint : fnv1a64Hex;
  /* 唯一 id 生成。契约刻意不提供随机源（P22-1 §4.1），因此随机来自
     装配层：生产传 deps.nextId，测试传确定性的计数器。缺省实现走
     clock + 计数器 + 一点抖动，**不**使用 Math.random —— 它在同毫秒内
     可能重复，而重复的 id 会撞上 PRIMARY KEY（失败方向是安全的，
     但会让"同一毫秒两笔交易"变成一个随机失败，不可接受）。 */
  let idSeq = 0;
  const nextId = typeof deps.nextId === 'function'
    ? deps.nextId
    : (kind) => {
      idSeq += 1;
      const t = clock().toString(36);
      return C.formatEconomyId(kind, t + '_' + idSeq.toString(36)).id;
    };
  /* ── 故障注入（test-only seam，P22 §17）────────────────────────────
     只在 commitLedgerTransaction 的固定位置被调用。**不暴露到 HTTP**：
     装配层从不传它，http.js 也没有任何路由能写它。它存在的唯一理由是
     "任何一步失败都必须整体回滚"这条性质可以被**真实地**测出来 ——
     否则只能靠读代码相信它。 */
  const faults = deps.faults || null;
  function faultPoint(name) {
    if (!faults || typeof faults.hit !== 'function') return;
    faults.hit(String(name));
  }

  let db = null;
  let opened = false;
  let lastOpenedAt = 0;
  /* 本实例的降级原因。**不是**持久事实，而是"这次会话里 canonical 已经
     不可信"的粘性标记。 */
  let engineReason = null;
  /* open() 是否**失败过**。它与 engineReason 分开，因为两者的诚实回答
     不同：从未打开 → COLD（余额未知，但没人说它坏了）；
     打开失败 → DEGRADED（我们已经知道这一域服务不了）。
     把后者说成 COLD 会让 UI 显示"正在加载"而不是"不可用"。 */
  let openFailed = false;

  const SQL = {
    createMeta: 'CREATE TABLE IF NOT EXISTS ' + META_TABLE + ' (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    createAccounts:
      'CREATE TABLE IF NOT EXISTS ' + ACCOUNTS_TABLE + ' (' +
      ' account_id TEXT PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' owner_id TEXT,' +
      ' currency TEXT NOT NULL,' +
      ' wallet_id TEXT,' +
      ' created_at INTEGER NOT NULL' +
      ')',
    createAccountsByOwner: 'CREATE INDEX IF NOT EXISTS idx_econ_accounts_owner ON ' + ACCOUNTS_TABLE + ' (owner_id, currency)',
    createAccountsByWallet: 'CREATE INDEX IF NOT EXISTS idx_econ_accounts_wallet ON ' + ACCOUNTS_TABLE + ' (wallet_id)',
    createWallets:
      'CREATE TABLE IF NOT EXISTS ' + WALLETS_TABLE + ' (' +
      ' wallet_id TEXT PRIMARY KEY,' +
      ' owner_id TEXT NOT NULL,' +
      ' owner_type TEXT NOT NULL,' +
      ' currency TEXT NOT NULL,' +
      ' account_id TEXT NOT NULL,' +
      ' cached_balance_minor INTEGER NOT NULL DEFAULT 0,' +
      ' reserved_balance_minor INTEGER NOT NULL DEFAULT 0,' +
      ' state TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' UNIQUE (owner_id, currency)' +
      ')',
    createWalletsByOwner: 'CREATE INDEX IF NOT EXISTS idx_econ_wallets_owner ON ' + WALLETS_TABLE + ' (owner_id)',
    createTransactions:
      'CREATE TABLE IF NOT EXISTS ' + TRANSACTIONS_TABLE + ' (' +
      ' transaction_id TEXT PRIMARY KEY,' +
      ' tx_type TEXT NOT NULL,' +
      ' state TEXT NOT NULL,' +
      ' actor_type TEXT NOT NULL,' +
      ' actor_id TEXT NOT NULL,' +
      ' owner_id TEXT NOT NULL,' +
      ' recipient_id TEXT,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL' +
      /* 刻意**没有** amount_minor 列：金额只存在于 entries。
         交易上再存一份金额就会有两个事实源，而它们会漂移。 */
      ')',
    createTransactionsByKey: 'CREATE INDEX IF NOT EXISTS idx_econ_tx_key ON ' + TRANSACTIONS_TABLE + ' (idempotency_key)',
    createTransactionsByRevision: 'CREATE INDEX IF NOT EXISTS idx_econ_tx_rev ON ' + TRANSACTIONS_TABLE + ' (revision)',
    createEntries:
      'CREATE TABLE IF NOT EXISTS ' + ENTRIES_TABLE + ' (' +
      ' ledger_entry_id TEXT PRIMARY KEY,' +
      ' transaction_id TEXT NOT NULL,' +
      ' account_id TEXT NOT NULL,' +
      ' direction TEXT NOT NULL,' +
      ' amount_minor INTEGER NOT NULL,' +
      ' currency TEXT NOT NULL,' +
      ' seq INTEGER NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL' +
      ')',
    createEntriesByAccount: 'CREATE INDEX IF NOT EXISTS idx_econ_entries_account ON ' + ENTRIES_TABLE + ' (account_id, currency)',
    createEntriesByTx: 'CREATE INDEX IF NOT EXISTS idx_econ_entries_tx ON ' + ENTRIES_TABLE + ' (transaction_id, seq)',
    createEntriesByRevision: 'CREATE INDEX IF NOT EXISTS idx_econ_entries_rev ON ' + ENTRIES_TABLE + ' (revision)',
    createChangeLog:
      'CREATE TABLE IF NOT EXISTS ' + CHANGE_LOG_TABLE + ' (' +
      ' revision INTEGER PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' entity_id TEXT NOT NULL,' +
      ' transaction_id TEXT,' +
      ' wallet_id TEXT,' +
      ' at INTEGER NOT NULL,' +
      ' payload_json TEXT NOT NULL DEFAULT \'{}\'' +
      ')',
    createChangeLogByTx: 'CREATE INDEX IF NOT EXISTS idx_econ_changes_tx ON ' + CHANGE_LOG_TABLE + ' (transaction_id)',
    createIdempotency:
      'CREATE TABLE IF NOT EXISTS ' + IDEMPOTENCY_TABLE + ' (' +
      ' idempotency_key TEXT PRIMARY KEY,' +
      ' kind TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' transaction_id TEXT,' +
      ' result_json TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' at INTEGER NOT NULL' +
      ')',

    selectMeta: 'SELECT value FROM ' + META_TABLE + ' WHERE key=?',
    upsertMeta: 'INSERT INTO ' + META_TABLE + ' (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',

    insertAccount:
      'INSERT INTO ' + ACCOUNTS_TABLE + ' (account_id, kind, owner_id, currency, wallet_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    selectAccount: 'SELECT * FROM ' + ACCOUNTS_TABLE + ' WHERE account_id=?',
    selectSystemAccount: 'SELECT * FROM ' + ACCOUNTS_TABLE + ' WHERE account_id=? AND kind=\'SYSTEM\'',

    insertWallet:
      'INSERT INTO ' + WALLETS_TABLE + ' (wallet_id, owner_id, owner_type, currency, account_id, cached_balance_minor, reserved_balance_minor, state, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)',
    selectWallet: 'SELECT * FROM ' + WALLETS_TABLE + ' WHERE wallet_id=?',
    selectWalletByOwner: 'SELECT * FROM ' + WALLETS_TABLE + ' WHERE owner_id=? AND currency=?',
    selectWalletsByOwner: 'SELECT * FROM ' + WALLETS_TABLE + ' WHERE owner_id=? ORDER BY currency ASC',
    selectWallets: 'SELECT * FROM ' + WALLETS_TABLE + ' ORDER BY created_at ASC, wallet_id ASC LIMIT ?',
    /* 唯一一条能改余额的语句。它把**从本次 entries 算出来的**值写进缓存，
       并把 state 一起写成 READY。它不含任何 `balance + ?` 形态 —— 
       增量式更新正是 P22 §12 要禁掉的那件事（缓存漂移会变成真实经济错误）。 */
    setWalletBalance:
      'UPDATE ' + WALLETS_TABLE + ' SET cached_balance_minor=?, reserved_balance_minor=?, state=?, revision=?, updated_at=? WHERE wallet_id=?',
    countWallets: 'SELECT COUNT(*) AS c FROM ' + WALLETS_TABLE,

    insertTransaction:
      'INSERT INTO ' + TRANSACTIONS_TABLE + ' (transaction_id, tx_type, state, actor_type, actor_id, owner_id, recipient_id, idempotency_key, fingerprint, revision, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectTransaction: 'SELECT * FROM ' + TRANSACTIONS_TABLE + ' WHERE transaction_id=?',
    selectTransactions: 'SELECT * FROM ' + TRANSACTIONS_TABLE + ' ORDER BY revision ASC LIMIT ?',
    countTransactions: 'SELECT COUNT(*) AS c FROM ' + TRANSACTIONS_TABLE,

    insertEntry:
      'INSERT INTO ' + ENTRIES_TABLE + ' (ledger_entry_id, transaction_id, account_id, direction, amount_minor, currency, seq, revision, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectEntriesByTx: 'SELECT * FROM ' + ENTRIES_TABLE + ' WHERE transaction_id=? ORDER BY seq ASC',
    selectEntriesByTxAll: 'SELECT * FROM ' + ENTRIES_TABLE + ' ORDER BY revision ASC, seq ASC',
    selectEntriesByAccount: 'SELECT * FROM ' + ENTRIES_TABLE + ' WHERE account_id=? AND currency=? ORDER BY revision ASC, seq ASC LIMIT ?',
    countEntries: 'SELECT COUNT(*) AS c FROM ' + ENTRIES_TABLE,
    /* 余额重建的唯一算术入口：**逐 currency、逐方向**求和。
       两个 SUM 分开而不是一个带符号的和，是为了让"永远没有负数金额"
       这件事在 SQL 里也是显然的。
       字面量一律用单引号：SQLite 把 "DEBIT" 当**标识符**，那是一列，
       不是一个字符串 —— 双引号在这里会静默变成"比较列与列"。 */
    sumDebit: 'SELECT COALESCE(SUM(amount_minor), 0) AS total, COUNT(*) AS n FROM ' + ENTRIES_TABLE + ' WHERE account_id=? AND currency=? AND direction=\'DEBIT\'',
    sumCredit: 'SELECT COALESCE(SUM(amount_minor), 0) AS total, COUNT(*) AS n FROM ' + ENTRIES_TABLE + ' WHERE account_id=? AND currency=? AND direction=\'CREDIT\'',

    insertChange:
      'INSERT INTO ' + CHANGE_LOG_TABLE + ' (revision, kind, entity_id, transaction_id, wallet_id, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    selectChanges: 'SELECT revision, kind, entity_id, transaction_id, wallet_id, at, payload_json FROM ' + CHANGE_LOG_TABLE + ' WHERE revision > ? ORDER BY revision ASC LIMIT ?',
    maxChangeRevision: 'SELECT MAX(revision) AS m FROM ' + CHANGE_LOG_TABLE,
    countChanges: 'SELECT COUNT(*) AS c FROM ' + CHANGE_LOG_TABLE,

    selectIdempotency: 'SELECT * FROM ' + IDEMPOTENCY_TABLE + ' WHERE idempotency_key=?',
    insertIdempotency:
      'INSERT INTO ' + IDEMPOTENCY_TABLE + ' (idempotency_key, kind, fingerprint, transaction_id, result_json, revision, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    pruneIdempotency: 'DELETE FROM ' + IDEMPOTENCY_TABLE + ' WHERE at < ?',
    countIdempotency: 'SELECT COUNT(*) AS c FROM ' + IDEMPOTENCY_TABLE,
    oldestIdempotency: 'SELECT idempotency_key FROM ' + IDEMPOTENCY_TABLE + ' ORDER BY at ASC LIMIT ?',
    deleteIdempotency: 'DELETE FROM ' + IDEMPOTENCY_TABLE + ' WHERE idempotency_key=?'
  };

  /* ══════════════════════════════════════════════════════════════════
     生命周期
     ══════════════════════════════════════════════════════════════════ */

  function open() {
    if (opened) return { ok: true, alreadyOpen: true, file: dbFile, schemaVersion: ECONOMY_SCHEMA_VERSION };
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* 目录已存在 */ }
    /* 一次成功的 open 会把上一次的失败结论清掉 —— 否则"库修好了"这个
       事实永远无法被表达。这与"close 不清 engineReason"是两件事：
       close 是生命周期，open 是重新建立权威。 */
    openFailed = false;
    engineReason = null;
    /* 本模块**不**做损坏隔离：同一个文件上 chat-store 负责 quarantine
       （它会 rename 坏库），第二个 opener 去 rename 会互相踩。
       这与 memory-store.js:182-185 的既有纪律逐字相同。 */
    try {
      db = new sqlite.DatabaseSync(dbFile);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(SQL.createMeta);
      db.exec(SQL.createAccounts);
      db.exec(SQL.createAccountsByOwner);
      db.exec(SQL.createAccountsByWallet);
      db.exec(SQL.createWallets);
      db.exec(SQL.createWalletsByOwner);
      db.exec(SQL.createTransactions);
      db.exec(SQL.createTransactionsByKey);
      db.exec(SQL.createTransactionsByRevision);
      db.exec(SQL.createEntries);
      db.exec(SQL.createEntriesByAccount);
      db.exec(SQL.createEntriesByTx);
      db.exec(SQL.createEntriesByRevision);
      db.exec(SQL.createChangeLog);
      db.exec(SQL.createChangeLogByTx);
      db.exec(SQL.createIdempotency);
      migrateSchema();
    } catch (error) {
      try { if (db) db.close(); } catch (_) { /* 已关闭 */ }
      db = null;
      opened = false;
      const wrapped = dbFailure.toError(error);
      /* 开库失败必须**粘住**：否则一次成功的 close + 再次 open 会把它
         洗掉，而"上一次 canonical 打不开"是一个不该消失的事实。
	     原因写进 economy_meta 的尝试本身也可能失败（库就是开不起来），
	     因此它只是 best-effort —— 内存里的 engineReason 与 openFailed
	     一定成立。 */
      engineReason = String(wrapped.category || wrapped.code || 'db-open-failed');
      openFailed = true;
      throw wrapped;
    }
    opened = true;
    lastOpenedAt = clock();
    logger('economy-opened', {
      file: dbFile,
      schemaVersion: ECONOMY_SCHEMA_VERSION,
      revision: getRevision(),
      wallets: countWallets(),
      transactions: countTransactions(),
      entries: countEntries()
    });
    return { ok: true, alreadyOpen: false, file: dbFile, schemaVersion: ECONOMY_SCHEMA_VERSION };
  }

  /* ── schema 版本行为（P22 §19）─────────────────────────────────────
     四条路径逐条明确：
       · 新库               → 写入当前版本；
       · 同版本库           → 无操作；
       · 更老的受支持版本   → 逐级应用 MIGRATIONS（0 → 1 起就有框架）；
       · 更新的版本         → **拒绝打开**（SCHEMA_TOO_NEW），不降级。
     以及一条这里独有的断言：已存在的库里若 `economy_schema` 说 0.x 而
     实际已有 ledger 行，说明有人手工改过水位 —— 直接拒绝，因为
     "在一份有真实余额的账本上假装迁移"是能造成经济错误的操作。 */
  const MIGRATIONS = [
    /* from → to。空数组表示"版本 1 就是初版，没有更早的版本需要迁移"。
       框架存在而内容为空是**刻意**的：框架本身要有测试（见
       tests/test_p22_2_economy_store.js 的 schema 组），否则第一次真的
       需要迁移时才发现它从来没跑过。 */
  ];

  function migrateSchema() {
    const raw = readMeta(META_SCHEMA);
    if (raw == null) {
      writeMeta(META_SCHEMA, String(ECONOMY_SCHEMA_VERSION));
      return;
    }
    const stored = Number(raw);
    if (!Number.isInteger(stored) || stored < 0) {
      const err = new Error('economy store schema watermark is not a non-negative integer: ' + raw);
      err.code = 'SCHEMA_MALFORMED';
      throw err;
    }
    if (stored > ECONOMY_SCHEMA_VERSION) {
      const err = new Error('economy store schema is newer than this build (' + stored + ' > ' + ECONOMY_SCHEMA_VERSION + ')');
      err.code = 'SCHEMA_TOO_NEW';
      throw err;
    }
    if (stored === ECONOMY_SCHEMA_VERSION) return;
    for (const step of MIGRATIONS) {
      if (step.from < stored || step.from >= ECONOMY_SCHEMA_VERSION) continue;
      step.apply(db);
    }
    writeMeta(META_SCHEMA, String(ECONOMY_SCHEMA_VERSION));
  }

  function close() {
    if (!db) return { ok: true, alreadyClosed: true, store: 'economy' };
    try { db.close(); } catch (_) { /* 已关闭 */ }
    db = null;
    opened = false;
    /* 关库也要留一行**具名**观测：生产停机日志里"哪一个 store 关掉了"
       必须是可读的，否则"Economy 到底有没有被干净地关闭"只能靠猜。
       这与 memory/moments 的 `closed` 行同类，只是多带了名字。 */
    logger('economy-closed', { file: dbFile, revision: 0, wallets: 0 });
    return { ok: true, alreadyClosed: false, store: 'economy' };
  }
  function isOpen() { return opened && !!db; }
  function requireOpen() {
    if (!isOpen()) {
      const err = new Error('economy store is not open');
      err.code = 'STORE_CLOSED';
      throw err;
    }
  }

  /* 内部小工具 —— 与 memory-store.js:245-272 同款。 */
  function readMeta(key) {
    const row = db.prepare(SQL.selectMeta).get(key);
    return row ? row.value : null;
  }
  function writeMeta(key, value) { db.prepare(SQL.upsertMeta).run(key, String(value)); }
  function withTransaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
      throw error;
    }
  }
  function getRevision() {
    if (!isOpen()) return 0;
    const stored = Number(readMeta(META_REVISION) || 0);
    const inLog = db.prepare(SQL.maxChangeRevision).get();
    const logged = (inLog && inLog.m) || 0;
    /* 双保险：meta 与 change_log 取大值。任何一侧被外部工具改写都不会
       让版本**回退** —— 版本回退会让镜像游标重放已消费的 revision。 */
    return Math.max(stored, logged);
  }
  function allocateRevision() {
    const next = getRevision() + 1;
    writeMeta(META_REVISION, String(next));
    return next;
  }

  /* ══════════════════════════════════════════════════════════════════
     金额的 SQLite 边界（P22 §8）
     ──────────────────────────────────────────────────────────────────
     契约层是 BigInt，SQLite 是 INTEGER。node:sqlite 不接受 BigInt 绑定，
     因此出入两个方向都必须**显式**转换，而且转换本身要受检：

       写：BigInt → Number，且必须先证明 Number(x) 是精确的；
       读：Number → BigInt，且必须先证明它落在安全整数区间内。

     `Number(bigint)` / `parseFloat` / `Math.round` 作为 canonical amount
     path 是被禁止的（它们会静默丢精度）。这里的 toSqlAmount 里确实有
     Number(...)，但它在**证明之后**才执行 —— 证明失败即抛错，因此
     不存在"用一个丢精度的转换当作正常路径"的情形。
     ══════════════════════════════════════════════════════════════════ */

  function toSqlAmount(amountMinor, label) {
    const n = C.normalizeAmountMinor(amountMinor);
    if (!n.ok) {
      const err = new Error('economy amount is not canonical (' + (label || 'amount') + '): ' + n.errors.join(','));
      err.code = 'AMOUNT_NOT_CANONICAL';
      err.errors = n.errors;
      throw err;
    }
    const v = n.amountMinor;
    if (v > BigInt(MAX_AMOUNT_MINOR)) {
      const err = new Error('economy amount exceeds the canonical bound (' + (label || 'amount') + ')');
      err.code = 'AMOUNT_OUT_OF_RANGE';
      throw err;
    }
    /* 证明：BigInt(Number(v)) === v。只有在这个等式成立时，写进
       SQLite INTEGER 的字节才与 canonical 值逐位相同。 */
    const asNumber = Number(v);
    if (!Number.isSafeInteger(asNumber) || BigInt(asNumber) !== v) {
      const err = new Error('economy amount cannot be represented exactly at the SQLite boundary (' + (label || 'amount') + ')');
      err.code = 'AMOUNT_NOT_REPRESENTABLE';
      throw err;
    }
    return asNumber;
  }

  function fromSqlAmount(value, label) {
    if (typeof value === 'bigint') {
      /* 驱动在某些配置下会回 BigInt —— 那时**不**做 Number 转换，
         直接用它，于是零精度风险。 */
      if (value < 0n || value > BigInt(MAX_AMOUNT_MINOR)) {
        const err = new Error('economy amount read back from SQLite is out of range (' + (label || 'amount') + ')');
        err.code = 'AMOUNT_OUT_OF_RANGE';
        throw err;
      }
      return value;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT_MINOR) {
      const err = new Error('economy amount read back from SQLite is not a canonical non-negative safe integer (' + (label || 'amount') + '): ' + String(value));
      err.code = 'AMOUNT_READ_BACK_INVALID';
      throw err;
    }
    return BigInt(value);
  }

  /* ══════════════════════════════════════════════════════════════════
     降级判定（P22-1 §6 · P22 §7）
     ══════════════════════════════════════════════════════════════════ */

  function degrade(reason) {
    if (!engineReason) engineReason = String(reason);
    return engineReason;
  }

  /* 本实例此刻的 engine state。三态判定**只在这里**发生，于是
     health() 与 wallet 读取不可能给出两个不同的答案。 */
  function engineStateNow() {
    if (openFailed) return { state: C.WALLET_STATE.DEGRADED, reason: engineReason || 'db-open-failed' };
    if (engineReason) return { state: C.WALLET_STATE.DEGRADED, reason: engineReason };
    if (!isOpen()) return { state: C.WALLET_STATE.COLD, reason: 'store-not-open' };
    return { state: C.WALLET_STATE.READY, reason: null };
  }

  /* 单个钱包此刻的 canonical state。**派生**，不是存储字段照着念：
     库没开 → COLD（余额未知）；本会话已降级 → DEGRADED（余额不可信）；
     行的 state 列不是 READY → 照实返回（未来的 P22-3 会写 RESERVED 之类）。
     关键点：**任何**非 READY 的路径都不返回 0，而是让调用方拿到 null。 */
  function walletStateOfRow(row) {
    const engine = engineStateNow();
    if (engine.state !== C.WALLET_STATE.READY) return engine;
    const stored = String((row && row.state) || '');
    if (stored === C.WALLET_STATE.READY) return { state: C.WALLET_STATE.READY, reason: null };
    if (C.WALLET_STATES.indexOf(stored) >= 0) return { state: stored, reason: 'wallet-row-state' };
    return { state: C.WALLET_STATE.DEGRADED, reason: 'wallet-state-not-in-closed-set' };
  }

  /* ══════════════════════════════════════════════════════════════════
     余额重建（canonical：ledger entries）
     ══════════════════════════════════════════════════════════════════ */

  /* 记账符号约定（**唯一**一处定义）：
       WALLET 账户： balance = Σ(DEBIT) − Σ(CREDIT)
       SYSTEM 账户： balance = Σ(CREDIT) − Σ(DEBIT)
     为什么 system 反过来：system:mint / system:burn / system:treasury 是
     **控制账户**（standard control account）。IB_CREDIT 的记账单位为 1
     （scale=100），钱包持有 5.00 IB_CREDIT 记 500 minor；system:mint 以
     −500 对置，于是"整个账本恒等于 0"这条全局不变量在任何时刻成立，
     包括 MINT 之后。把 system 也按钱包那套读会让"增发了多少"没有符号
     可言，而"增发了多少"恰恰是 MINT 唯一要回答的问题。
     P22-1 §10/§12 只说 entry 的 `accountId` 必须存在且必须是 canonical
     account（没有规定它的列名），因此这个方向属于**运行时**决定，
     不是对契约的修改。 */
  function computeLedgerBalance(accountId, currency) {
    const kind = C.accountKindOf(accountId);
    if (!kind) {
      const err = new Error('economy ledger account is not canonical: ' + String(accountId));
      err.code = 'ACCOUNT_NOT_CANONICAL';
      throw err;
    }
    const debit = db.prepare(SQL.sumDebit).get(accountId, currency);
    const credit = db.prepare(SQL.sumCredit).get(accountId, currency);
    const debitTotal = fromSqlAmount((debit && debit.total) || 0, 'debit-total');
    const creditTotal = fromSqlAmount((credit && credit.total) || 0, 'credit-total');
    return {
      kind: kind,
      debitTotal: debitTotal,
      creditTotal: creditTotal,
      debitCount: Number((debit && debit.n) || 0),
      creditCount: Number((credit && credit.n) || 0),
      balanceMinor: kind === C.ACCOUNT_KIND.SYSTEM ? (creditTotal - debitTotal) : (debitTotal - creditTotal)
    };
  }

  /* 从 Ledger 重建一个钱包的余额。
     返回值里同时给出 `repaired`：缓存与重建值不一致时**修好它**并记一条
     change log（kind='BALANCE_REBUILT'）—— 于是"缓存曾经漂移过"不会
     静默消失，而是留下一条可审计的记录。 */
  function rebuildWalletBalance(walletId, options) {
    options = options || {};
    requireOpen();
    const wallet = db.prepare(SQL.selectWallet).get(String(walletId));
    if (!wallet) return { ok: false, walletId: String(walletId), errors: ['wallet-not-found'] };
    /* ── 重建前的结构完整性预检（三条，任何一条不成立即 DEGRADED）──────
       没有这三条的话，"账户行被删掉"会静默变成一个**零余额**：
       computeLedgerBalance 对一个不存在的账户求和得到 0，于是
       "我不知道这个钱包有多少钱"被回答成"它有 0 元"——这正是 P22-0 R5
       的同一个根因换了一个入口。因此先证明这一行的引用链是完整的。 */
    const account = db.prepare(SQL.selectAccount).get(String(wallet.account_id));
    const structural = [];
    if (!account) structural.push('account-row-missing');
    else {
      if (String(account.kind) !== C.ACCOUNT_KIND.WALLET) structural.push('account-kind-is-not-wallet');
      if (account.wallet_id == null || String(account.wallet_id) !== String(walletId)) structural.push('account-does-not-point-back-to-this-wallet');
      if (String(account.currency) !== String(wallet.currency)) structural.push('account-currency-differs-from-wallet-currency');
    }
    if (structural.length) {
      degrade('wallet-integrity:' + structural.join(','));
      return { ok: false, walletId: String(walletId), errors: ['rebuild-failed'], integrity: structural };
    }
    let derived;
    try {
      derived = computeLedgerBalance(wallet.account_id, wallet.currency);
    } catch (error) {
      /* 重建失败 ⇒ 这个钱包的余额不可信。**不**返回 0。 */
      degrade('rebuild-failed:' + String(error && (error.code || error.message)));
      return { ok: false, walletId: String(walletId), errors: ['rebuild-failed'], detail: String(error && error.message) };
    }
    const cached = fromSqlAmount(wallet.cached_balance_minor, 'cached-balance');
    const reserved = fromSqlAmount(wallet.reserved_balance_minor, 'reserved-balance');
    const drifted = cached !== derived.balanceMinor || reserved > derived.balanceMinor;
    const repaired = drifted && options.repair !== false;
    if (repaired) {
      const revision = allocateRevision();
      const at = clock();
      db.prepare(SQL.setWalletBalance).run(
        toSqlAmount(derived.balanceMinor, 'rebuilt-balance'),
        toSqlAmount(reserved > derived.balanceMinor ? 0n : reserved, 'rebuilt-reserved'),
        C.WALLET_STATE.READY,
        revision, at, String(walletId)
      );
      appendChange({
        revision: revision, kind: 'BALANCE_REBUILT', entityId: String(walletId),
        transactionId: null, walletId: String(walletId), at: at,
        payload: {
          domain: C.DOMAIN,
          previousCachedBalanceMinor: C.serializeAmountMinor(cached),
          rebuiltBalanceMinor: C.serializeAmountMinor(derived.balanceMinor),
          currency: wallet.currency
        }
      });
      logger('economy-balance-rebuilt', {
        walletId: String(walletId), currency: wallet.currency,
        previous: C.serializeAmountMinor(cached), rebuilt: C.serializeAmountMinor(derived.balanceMinor)
      });
    }
    return {
      ok: true,
      walletId: String(walletId),
      currency: wallet.currency,
      accountId: wallet.account_id,
      cachedBalanceMinor: derived.balanceMinor,
      reservedBalanceMinor: reserved > derived.balanceMinor ? 0n : reserved,
      drifted: drifted,
      repaired: repaired,
      debitCount: derived.debitCount,
      creditCount: derived.creditCount
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     行 ↔ DTO
     ══════════════════════════════════════════════════════════════════ */

  function rowToWalletView(row, options) {
    options = options || {};
    const st = walletStateOfRow(row);
    const ready = st.state === C.WALLET_STATE.READY;
    /* 只有 READY 才去读缓存列。COLD / DEGRADED 下连读都不读 —— 读出来
       再"记得别用"是注释级保证，而不是结构级保证。 */
    let cached = 0n;
    let reserved = 0n;
    if (ready) {
      cached = fromSqlAmount(row.cached_balance_minor, 'cached-balance');
      reserved = fromSqlAmount(row.reserved_balance_minor, 'reserved-balance');
    }
    const made = C.makeWalletView({
      currency: row.currency,
      state: st.state,
      cachedBalanceMinor: cached,
      reservedBalanceMinor: reserved
    });
    if (!made.ok) {
      /* 行本身不满足契约（例如 reserved > cached）。这不是"余额 0"，
         而是"这行不可信" —— 于是降级并如实地回答 null。 */
      degrade('wallet-row-invalid:' + made.errors.join(','));
      const degraded = C.makeWalletView({
        currency: C.CURRENCY.IB_CREDIT, state: C.WALLET_STATE.DEGRADED,
        cachedBalanceMinor: 0n, reservedBalanceMinor: 0n
      });
      return Object.assign({}, degraded.wallet, {
        walletId: String(row.wallet_id),
        owner: { type: String(row.owner_type), id: String(row.owner_id) },
        accountId: String(row.account_id),
        revision: Number(row.revision),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        degradedReason: engineReason,
        currency: row.currency
      });
    }
    return Object.assign({}, made.wallet, {
      walletId: String(row.wallet_id),
      owner: { type: String(row.owner_type), id: String(row.owner_id) },
      accountId: String(row.account_id),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      degradedReason: ready ? null : (st.reason || null)
    });
  }

  /* ── 对外 JSON 形态：金额一律**十进制字符串**（契约 §3）──────────────
     不在这里用 JSON.stringify —— BigInt 会让它抛错，而"抛错"的下一步
     往往是被某个 catch 兜住然后静默变成别的东西。 */
  function serializeWallet(view, options) {
    options = options || {};
    const out = {
      domain: view.domain,
      walletId: view.walletId,
      owner: view.owner,
      currency: view.currency,
      accountId: view.accountId,
      state: view.state,
      balanceKnown: view.balanceKnown,
      cachedBalanceMinor: view.state === C.WALLET_STATE.READY
        ? C.serializeAmountMinor(view.cachedBalanceMinor) : null,
      reservedBalanceMinor: view.state === C.WALLET_STATE.READY
        ? C.serializeAmountMinor(view.reservedBalanceMinor) : null,
      availableBalanceMinor: view.availableBalanceMinor == null
        ? null : C.serializeAmountMinor(view.availableBalanceMinor),
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      degradedReason: view.degradedReason || null
    };
    if (options.rebuild) out.rebuilt = true;
    return out;
  }

  /* ── 有符号余额的**显式**表示（只用于控制账户）──────────────────────
     契约规定 canonical amount 是**无符号**的（MIN_AMOUNT_MINOR = 0），
     因此 serializeAmountMinor 对负数返回 null —— 这是对的：一个负的
     "金额"不是一个合法金额。

     但 system 控制账户的余额**可以**是负的，而且这个符号是有意义的：
       system:mint 累计增发 → 正向（记 CREDIT）
       system:burn 累计销毁 → 反向（记 DEBIT）
     把符号悄悄丢掉（或让 serializeAmountMinor 返回 null）会让
     "销毁了多少"变成不可读。因此这里用**两个字段**表达它：
       { balanceMinor: "40", sign: "DEBIT" }   = 销毁方向累计 40
     而不是一个带负号的数字字符串 —— "−40" 会被读成一个负金额，
     而负金额在契约里根本不存在。 */
  function formatSignedMinor(value) {
    const v = BigInt(value);
    return {
      balanceMinor: C.serializeAmountMinor(v < 0n ? -v : v),
      sign: v === 0n ? 'ZERO' : (v < 0n ? 'DEBIT' : 'CREDIT')
    };
  }

  function rowToEntry(row) {
    return {
      domain: C.DOMAIN,
      ledgerEntryId: String(row.ledger_entry_id),
      transactionId: String(row.transaction_id),
      accountId: String(row.account_id),
      direction: String(row.direction),
      amountMinor: fromSqlAmount(row.amount_minor, 'entry-amount'),
      currency: String(row.currency),
      seq: Number(row.seq),
      revision: Number(row.revision),
      createdAt: Number(row.created_at)
    };
  }

  function rowToTransaction(row) {
    return {
      domain: C.DOMAIN,
      transactionId: String(row.transaction_id),
      transactionType: String(row.tx_type),
      state: String(row.state),
      actor: { type: String(row.actor_type), id: String(row.actor_id) },
      ownerId: String(row.owner_id),
      recipientId: row.recipient_id == null ? null : String(row.recipient_id),
      idempotencyKey: String(row.idempotency_key),
      revision: Number(row.revision),
      createdAt: Number(row.created_at)
    };
  }

  function appendChange(change) {
    db.prepare(SQL.insertChange).run(
      Number(change.revision), String(change.kind), String(change.entityId),
      change.transactionId == null ? null : String(change.transactionId),
      change.walletId == null ? null : String(change.walletId),
      Number(change.at), JSON.stringify(change.payload || {})
    );
  }

  /* ══════════════════════════════════════════════════════════════════
     Wallet + Ledger Account 创建（P22 §5/§6）
     ══════════════════════════════════════════════════════════════════ */

  /* owner 只能是 canonical party（character / user / system）。
     **不涉及任何角色表**：Economy 不读 characters，更不读那张持有角色
     执行配置（也就是凭据面）的表 —— boundary B6 把后者逐字列为禁止词，
     而它的**唯一**登记处是契约（这里连名字都不写，免得把"登记"变成
     "引用"）。
     `deps.ownerExists` 若被装配层注入，则用它做存在性校验；
     未注入时不假装校验 —— 打开一个不存在的 owner 是 P22-3/4 的
     拒绝理由，而不是本阶段可以凭空发明的规则。 */
  /* party 归一：契约的 promotePartyRef 只接受裸字符串，因此这里显式分派，
     并且**两条路都经由 makePartyRef** —— 于是 "system?" / "me" / "self"
     这类输入在一条路径上被拒，不会因为走了另一条而漏过。 */
  function partyInput(value) {
    if (value && typeof value === 'object') return C.makePartyRef(value.type, value.id);
    if (value == null || String(value).trim() === '') {
      return { ok: false, party: null, errors: ['party-id-required'] };
    }
    const s = String(value);
    if (s === C.USER_PARTY_ID) return C.makePartyRef(C.PARTY_TYPE.USER, C.USER_PARTY_ID);
    return C.makePartyRef(C.PARTY_TYPE.CHARACTER, s);
  }

  function normalizeOwner(owner) {
    const ref = partyInput(owner);
    if (!ref || ref.ok !== true) {
      return { ok: false, errors: (ref && ref.errors) || ['party-ref-invalid'] };
    }
    if (ref.party.type === C.PARTY_TYPE.SYSTEM) {
      /* system **不是** wallet owner：system 只有 ledger account，
         没有钱包。这条拒绝让"系统钱包"这个概念在数据上不存在。 */
      return { ok: false, errors: ['system-party-cannot-own-a-wallet'] };
    }
    return { ok: true, party: ref.party };
  }

  function ensureSystemAccount(accountId) {
    const d = C.validateSystemAccountId(accountId);
    if (!d.ok) return { ok: false, errors: d.errors };
    const id = d.accountId;
    const existing = db.prepare(SQL.selectSystemAccount).get(id);
    if (existing) return { ok: true, accountId: id, created: false };
    /* system account 的 currency 列只用于"这一行属于哪个币种索引"，
       真正的币种在 entry 上。control account 天然可以承载多种币种。 */
    db.prepare(SQL.insertAccount).run(id, C.ACCOUNT_KIND.SYSTEM, null, '', null, clock());
    return { ok: true, accountId: id, created: true };
  }

  /* 打开一个钱包。幂等：同一个 (owner, currency) 再来返回**已存在**的
     那个，不新建第二个账户 —— 否则"两个钱包记同一个 owner"会让余额
     被劈成两半，而两边各自的账都平。 */
  function openWallet(input) {
    requireOpen();
    const o = input || {};
    const owner = normalizeOwner(o.owner);
    if (!owner.ok) return { ok: false, wallet: null, errors: owner.errors };
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return { ok: false, wallet: null, errors: cur.errors };
    if (typeof deps.ownerExists === 'function') {
      let exists = false;
      try { exists = deps.ownerExists(owner.party) === true; }
      catch (error) { return { ok: false, wallet: null, errors: ['owner-lookup-failed'] }; }
      if (!exists) return { ok: false, wallet: null, errors: ['owner-not-found'] };
    }
    const ownerId = owner.party.id;
    const currency = cur.currency;

    const existing = db.prepare(SQL.selectWalletByOwner).get(ownerId, currency);
    if (existing) {
      return { ok: true, created: false, wallet: rowToWalletView(existing) };
    }

    const walletId = nextId('WALLET');
    const accountId = nextId('ACCOUNT');
    const at = clock();
    let created = null;
    try {
      withTransaction(() => {
        const revision = allocateRevision();
        db.prepare(SQL.insertWallet).run(
          walletId, ownerId, owner.party.type, currency, accountId,
          C.WALLET_STATE.READY, revision, at, at
        );
        db.prepare(SQL.insertAccount).run(accountId, C.ACCOUNT_KIND.WALLET, ownerId, currency, walletId, at);
        appendChange({
          revision: revision, kind: C.EVENT_TYPE.WALLET_OPENED, entityId: walletId,
          transactionId: null, walletId: walletId, at: at,
          payload: {
            domain: C.DOMAIN,
            ownerType: owner.party.type,
            currency: currency,
            accountId: accountId
          }
        });
        created = db.prepare(SQL.selectWallet).get(walletId);
      });
    } catch (error) {
      /* 唯一约束是被**并发**触发的正常路径（两次 openWallet 竞速）。
         此时把已存在的那一行返回，而不是把一个 PRIMARY KEY 冲突
         抛给调用方 —— 幂等性是这条 API 的一部分。 */
      const raced = db.prepare(SQL.selectWalletByOwner).get(ownerId, currency);
      if (raced) return { ok: true, created: false, wallet: rowToWalletView(raced) };
      throw error;
    }
    /* 新钱包的缓存余额**从账本算出来**（此时是 0），而不是写死 0：
       如果将来 openWallet 变成"带初始余额"，这里不需要改。 */
    const rebuilt = rebuildWalletBalance(walletId, { repair: true });
    const row = db.prepare(SQL.selectWallet).get(walletId);
    return {
      ok: true,
      created: true,
      wallet: rowToWalletView(row || created),
      ledgerEmpty: rebuilt.ok ? (rebuilt.debitCount === 0 && rebuilt.creditCount === 0) : null
    };
  }

  function getWallet(input) {
    const o = typeof input === 'string' ? { walletId: input } : (input || {});
    requireOpen();
    let row = null;
    if (o.walletId) row = db.prepare(SQL.selectWallet).get(String(o.walletId));
    else if (o.ownerId && o.currency) row = db.prepare(SQL.selectWalletByOwner).get(String(o.ownerId), String(o.currency));
    if (!row) return { ok: false, wallet: null, errors: ['wallet-not-found'] };
    if (o.rebuild === true) {
      const rebuilt = rebuildWalletBalance(row.wallet_id, { repair: o.repair !== false });
      if (!rebuilt.ok) return { ok: false, wallet: null, errors: rebuilt.errors };
      row = db.prepare(SQL.selectWallet).get(row.wallet_id);
    }
    return { ok: true, wallet: rowToWalletView(row), rebuilt: o.rebuild === true };
  }

  function listWallets(options) {
    options = options || {};
    requireOpen();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const rows = options.ownerId
      ? db.prepare(SQL.selectWalletsByOwner).all(String(options.ownerId))
      : db.prepare(SQL.selectWallets).all(limit);
    return rows.map(r => rowToWalletView(r));
  }

  function getLedgerAccount(accountId) {
    requireOpen();
    const d = C.validateLedgerAccountId(accountId);
    if (!d.ok) return { ok: false, account: null, errors: d.errors };
    const row = db.prepare(SQL.selectAccount).get(String(accountId));
    if (!row) return { ok: false, account: null, errors: ['account-not-found'] };
    return {
      ok: true,
      account: {
        domain: C.DOMAIN,
        accountId: String(row.account_id),
        kind: String(row.kind),
        ownerId: row.owner_id == null ? null : String(row.owner_id),
        currency: String(row.currency),
        walletId: row.wallet_id == null ? null : String(row.wallet_id),
        createdAt: Number(row.created_at)
      }
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     Ledger 读取（审计用：回答"余额为什么是这个数"）
     ══════════════════════════════════════════════════════════════════ */

  function listLedgerEntries(options) {
    options = options || {};
    requireOpen();
    const limit = Math.max(1, Math.min(1000, Number(options.limit) || 200));
    let rows;
    if (options.transactionId) {
      rows = db.prepare(SQL.selectEntriesByTx).all(String(options.transactionId));
    } else {
      const currency = C.validateCurrency(options.currency || C.CURRENCY.IB_CREDIT);
      if (!currency.ok) return { ok: false, entries: null, errors: currency.errors };
      rows = db.prepare(SQL.selectEntriesByAccount).all(String(options.accountId || ''), currency.currency, limit);
    }
    return {
      ok: true,
      entries: rows.map(rowToEntry),
      /* 逐 currency 的平衡摘要就是"这份账现在平不平"的答案本身。
         刻意从**本次真正读出来的行**算，而不是再查一次：
         两者若不同源，"返回的 entries"与"声称的平衡"就可能互相矛盾。
         每次读取都算一次，因为它很便宜，而"上次算过是平的"不是证据。 */
      topology: topologyOfRows(rows),
      /* scope 让 balanced 的含义没有歧义：账户维度的求和天然是单边的
         （另一侧记在对手方账户上），因此那里的 balanced 只说明
         "这一份切片自身平不平"，不说明整本账。全局答案在
         topology()（不带 scope）与 /economy/health 上。 */
      scope: options.transactionId ? 'transaction' : 'account'
    };
  }

  function topologyOfRows(rows) {
    const buckets = Object.create(null);
    for (const row of rows) {
      const amount = fromSqlAmount(row.amount_minor, 'topology-amount');
      const b = buckets[row.currency] || (buckets[row.currency] = { debit: 0n, credit: 0n, entries: 0 });
      if (String(row.direction) === C.ENTRY_DIRECTION.DEBIT) b.debit += amount;
      else b.credit += amount;
      b.entries += 1;
    }
    return Object.keys(buckets).sort().map(currency => ({
      currency: currency,
      debitTotal: C.serializeAmountMinor(buckets[currency].debit),
      creditTotal: C.serializeAmountMinor(buckets[currency].credit),
      balanced: buckets[currency].debit === buckets[currency].credit,
      entries: buckets[currency].entries
    }));
  }

  function ledgerTopology(transactionId) {
    requireOpen();
    if (transactionId) {
      return topologyOfRows(db.prepare(SQL.selectEntriesByTx).all(String(transactionId)));
    }
    /* 不带 scope 时给的是**整本账**的逐币种摘要 —— 它才是有意义的
       "全局平不平"。 */
    return topologyOfRows(db.prepare(SQL.selectEntriesByTxAll).all());
  }

  function getTransaction(transactionId) {
    requireOpen();
    const row = db.prepare(SQL.selectTransaction).get(String(transactionId));
    if (!row) return { ok: false, transaction: null, entries: null, errors: ['transaction-not-found'] };
    return {
      ok: true,
      transaction: rowToTransaction(row),
      entries: db.prepare(SQL.selectEntriesByTx).all(String(transactionId)).map(rowToEntry)
    };
  }

  function listTransactions(options) {
    options = options || {};
    requireOpen();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    return db.prepare(SQL.selectTransactions).all(limit).map(rowToTransaction);
  }

  function listChanges(cursor, limit) {
    requireOpen();
    const from = Number(cursor) || 0;
    const size = Math.max(1, Math.min(500, Number(limit) || 200));
    const rows = db.prepare(SQL.selectChanges).all(from, size);
    return rows.map(r => ({
      domain: C.DOMAIN,
      revision: Number(r.revision),
      kind: String(r.kind),
      entityId: String(r.entity_id),
      transactionId: r.transaction_id == null ? null : String(r.transaction_id),
      walletId: r.wallet_id == null ? null : String(r.wallet_id),
      at: Number(r.at),
      payload: (() => { try { return JSON.parse(r.payload_json); } catch (_) { return null; } })()
    }));
  }

  /* ══════════════════════════════════════════════════════════════════
     Atomic ledger transaction（P22 §9/§10/§11/§13/§14）
     ══════════════════════════════════════════════════════════════════ */

  /* Ledger entry 的 id **确定性派生**，而不是生成。
     理由不是省事，而是幂等性：一笔交易的 entry 集合是它的一部分，
     如果 entry id 每次调用都随机，那么"同一笔业务重放"就不可能返回
     逐字相同的对象。派生形式 `econ_entry_<tx suffix>_<seq>` 满足契约
     的 suffix 语法（[A-Za-z0-9_-]{1,64}），且 transactionId 里的
     `econ_tx_` 前缀被剥掉后总长仍然很短。
     调用方仍可显式传入 ledgerEntryId（P22-3 起可能来自上游），
     那时契约会照常校验它的形状。 */
  function deriveEntryId(transactionId, seq) {
    const txSuffix = String(transactionId).slice(String(C.ID_PREFIX.TRANSACTION).length);
    return String(C.ID_PREFIX.LEDGER_ENTRY) + txSuffix + '_' + seq;
  }

  /* 业务请求的**确定性身份**。指纹只覆盖"这笔业务是什么"：
     类型、参与方、以及 entry 的**结构身份**（账户 / 方向 / 金额 / 币种）。
     刻意**不含** transactionId 与 ledgerEntryId —— 否则"同一笔业务、
     两次派生的 id"会被判成不同请求，而幂等性在重试路径上静默失效
     （这正是 P22 §14 第一条要防的事）。
     刻意**不含 entry 顺序**：两笔 entry 的先后是记账实现细节，把顺序
     放进身份会让"同样两笔 entry 反序"变成冲突。 */
  function transactionFingerprint(spec, entries) {
    const structural = entries.map(e => [
      String(e.accountId), String(e.direction),
      C.serializeAmountMinor(e.amountMinor), String(e.currency)
    ].join('|')).sort();
    return fingerprintOf(stableStringify({
      type: String(spec.type),
      actor: spec.actor ? { type: String(spec.actor.type), id: String(spec.actor.id) } : null,
      ownerId: spec.ownerId == null ? null : String(spec.ownerId),
      recipientId: spec.recipientId == null ? null : String(spec.recipientId),
      entries: structural
    }));
  }

  /* 归一 entry 的**业务字段**。刻意不要求调用方提供 transactionId /
     ledgerEntryId：那两个是记账身份，由 commitLedgerTransaction 统一
     派生，于是"重放"在所有 id 上都逐字可复现。传了的话仍然校验形状。 */
  function normalizeEntries(rawEntries) {
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
      return { ok: false, errors: ['entries-required'] };
    }
    const out = [];
    for (let i = 0; i < rawEntries.length; i++) {
      const raw = rawEntries[i] || {};
      const errors = [];
      const cur = C.validateCurrency(raw.currency);
      if (!cur.ok) errors.push.apply(errors, cur.errors);
      const amt = C.normalizeAmountMinor(raw.amountMinor);
      if (!amt.ok) errors.push.apply(errors, amt.errors);
      const direction = String(raw.direction == null ? '' : raw.direction);
      if (C.ENTRY_DIRECTIONS.indexOf(direction) < 0) errors.push('entry-direction-not-in-closed-set');
      if (raw.accountId == null || String(raw.accountId).trim() === '') errors.push('account-id-required');
      if (errors.length) return { ok: false, errors: errors.map(e => 'entry[' + i + ']:' + e) };
      /* 账户必须是 canonical account。**不**在写入口静默创建账户：
         那会让"造一个 system account"从"被拒绝"变成"被自动满足"。 */
      const kind = C.accountKindOf(raw.accountId);
      if (!kind) return { ok: false, errors: ['entry[' + i + ']:account-id-not-a-canonical-economy-account'] };
      if (raw.ledgerEntryId != null && !C.isEconomyId('LEDGER_ENTRY', raw.ledgerEntryId)) {
        return { ok: false, errors: ['entry[' + i + ']:ledger-entry-id-not-canonical'] };
      }
      out.push(Object.freeze({
        ledgerEntryId: raw.ledgerEntryId == null ? null : String(raw.ledgerEntryId),
        accountId: String(raw.accountId),
        direction: direction,
        amountMinor: amt.amountMinor,
        currency: cur.currency,
        kind: kind
      }));
    }
    return { ok: true, entries: out };
  }

  /* 复式平衡在**写入口再验一次**。P22-1 的契约校验不足以作为唯一依据：
     调用方可以在校验之后改数组（同一份引用），而"我们已经在契约层验过"
     正是那种只在一半路径上成立的理由。 */
  function assertBalanced(entries, type) {
    const balance = C.checkLedgerBalance(entries.map(e => ({
      currency: e.currency, direction: e.direction, amountMinor: e.amountMinor
    })));
    if (balance.ok !== true || balance.balanced !== true) {
      return { ok: false, errors: balance.errors, unbalancedCurrencies: balance.unbalancedCurrencies || [] };
    }
    /* MINT / BURN 的方向与对手方的**双重**约束。契约允许它们免除
       "两侧都是钱包"的拓扑，但**没有**允许免除"对手方必须是那个
       system account"。没有这一条，`MINT` 就能把一个任意账户当来源，
       而 ledger 依然"平" —— 凭空增发会从一个被允许的名字里溜进来。 */
    const needsTopology = C.requiresBalanceTopology(String(type));
    const systemAccounts = entries.filter(e => e.kind === C.ACCOUNT_KIND.SYSTEM).map(e => e.accountId);
    if (!needsTopology) {
      const expected = String(type) === C.TX_TYPE.MINT ? C.SYSTEM_ACCOUNT.MINT : C.SYSTEM_ACCOUNT.BURN;
      const wrong = systemAccounts.filter(a => a !== expected);
      if (wrong.length) return { ok: false, errors: ['mint-burn-counterparty-must-be-' + expected], offender: wrong[0] };
      if (systemAccounts.indexOf(expected) < 0) {
        return { ok: false, errors: ['mint-burn-requires-' + expected + '-counterparty'] };
      }
    } else if (systemAccounts.indexOf(C.SYSTEM_ACCOUNT.MINT) >= 0 || systemAccounts.indexOf(C.SYSTEM_ACCOUNT.BURN) >= 0) {
      /* mint / burn account 只允许出现在 MINT / BURN 里。P22-2 刻意
         把它做成硬拒绝（而不是留给 P22-6 的 exchange）：否则
         "写一笔 PURCHASE，但把对手方写成 system:mint"就能绕过
         MINT 的显式命名要求。 */
      return { ok: false, errors: ['mint-burn-account-only-allowed-in-mint-or-burn'] };
    }
    return { ok: true, errors: [] };
  }

  /* ── 唯一的余额写路径 ────────────────────────────────────────────────
     它的输入是**本次 transaction 的 entries**，不是旧缓存。于是
     `UPDATE ... SET balance = balance + ?` 这种形态在本文件里不存在 ——
     这是 P22 §12 的落点，而且 boundary B11 会逐字检查它。

     调用点唯一：commitLedgerTransaction 的事务体内。 */
  function applyDerivedBalances(entries, revision, at) {
    const touched = [];
    const byAccount = new Map();
    for (const entry of entries) {
      if (entry.kind !== C.ACCOUNT_KIND.WALLET) continue;
      const key = entry.accountId;
      if (!byAccount.has(key)) byAccount.set(key, []);
      byAccount.get(key).push(entry);
    }
    for (const [accountId, own] of byAccount) {
      const account = db.prepare(SQL.selectAccount).get(accountId);
      const wallet = account && account.wallet_id
        ? db.prepare(SQL.selectWallet).get(String(account.wallet_id)) : null;
      if (!wallet) {
        const err = new Error('economy ledger account has no wallet: ' + accountId);
        err.code = 'ACCOUNT_WITHOUT_WALLET';
        throw err;
      }
      /* 重建（canonical）→ 覆写（derived）。即便缓存被外部改坏了，
         下一次 commit 也会把它拉回真值。 */
      const derived = computeLedgerBalance(accountId, wallet.currency);
      if (derived.balanceMinor > BigInt(MAX_AMOUNT_MINOR)) {
        const err = new Error('economy balance would exceed the canonical bound: ' + wallet.wallet_id);
        err.code = 'BALANCE_OUT_OF_RANGE';
        throw err;
      }
      const reserved = fromSqlAmount(wallet.reserved_balance_minor, 'reserved-balance');
      if (reserved > derived.balanceMinor) {
        const err = new Error('economy reserved balance exceeds the ledger balance: ' + wallet.wallet_id);
        err.code = 'RESERVED_EXCEEDS_LEDGER_BALANCE';
        throw err;
      }
      faultPoint('before-wallet-cache');
      db.prepare(SQL.setWalletBalance).run(
        toSqlAmount(derived.balanceMinor, 'derived-balance'),
        toSqlAmount(reserved, 'derived-reserved'),
        C.WALLET_STATE.READY,
        revision, at, wallet.wallet_id
      );
      touched.push({
        walletId: wallet.wallet_id,
        accountId: accountId,
        currency: wallet.currency,
        ownerId: wallet.owner_id,
        balanceMinor: derived.balanceMinor,
        reservedBalanceMinor: reserved,
        entryCount: own.length
      });
    }
    return touched;
  }

  /* commitLedgerTransaction · P22-2 的**核心**
     ─────────────────────────────────────────────────────────────────
     一次 commit 恰好是一个 SQLite 事务，顺序与 P22 §9 逐条对应：

       BEGIN
         validate（契约 + 平衡 + system account 白名单）
         insert transaction
         insert entries
         assert balance（写入口再验一次：用**从库里读回**的 entries）
         update derived wallet cache
         append change log
         write idempotency result
       COMMIT

     任何一步抛错 → ROLLBACK。因此不存在"transaction 在、entries 半写、
     缓存变了、change_log 缺失"的中间态：它们要么全在，要么全不在。

     ── 幂等的顺序是刻意的 ─────────────────────────────────────────────
     fingerprint 在**任何写入之前**算出来并查表，因此"重放"根本不会
     进入事务体。而 idempotency 行与 transaction / entries / change_log
     **在同一个 SQLite 事务里**写入，因此"记了幂等但没记交易"也不可能
     发生 —— 跨重启的幂等性依赖的正是这一点。
     */
  function commitLedgerTransaction(spec) {
    requireOpen();
    const s = spec || {};
    const errors = [];

    const key = C.normalizeIdempotencyKey(s.idempotencyKey);
    if (!key.ok) return { ok: false, errors: key.errors };
    const transactionId = s.transactionId;
    if (!C.isEconomyId('TRANSACTION', transactionId)) return { ok: false, errors: ['transaction-id-not-canonical'] };
    const type = String(s.type == null ? '' : s.type);
    if (C.TX_TYPES.indexOf(type) < 0) return { ok: false, errors: ['transaction-type-not-in-closed-set'] };

    const actor = s.actor == null ? null : partyInput(s.actor);
    if (!actor || actor.ok !== true) {
      return { ok: false, errors: (actor && actor.errors) || ['actor-required'] };
    }

    const normalized = normalizeEntries(s.entries);
    if (!normalized.ok) return { ok: false, errors: normalized.errors };

    const balanced = assertBalanced(normalized.entries, type);
    if (!balanced.ok) {
      return { ok: false, errors: balanced.errors, unbalancedCurrencies: balanced.unbalancedCurrencies || [] };
    }

    /* ── 0 金额的交易：契约允许"两侧都为 0"，但它是一次没有经济内容的
       事实。运行层在这里**收紧**（比契约严，不与它矛盾）：
          · 一条 ledger transaction 必须真的移动了钱；
          · 否则"提交一笔 0 元交易"会成为一个可重放的、无副作用的、
            却仍然消耗 revision 的经济事件 —— 它只会污染审计。
       这只是运行时的拒绝，不改任何交易语义。 */
    if (!normalized.entries.some(e => e.amountMinor > 0n)) {
      return { ok: false, errors: ['ledger-transaction-must-move-a-non-zero-amount'] };
    }

    /* 每个 entry 都必须指到一个**已存在**的 canonical account。 */
    for (const entry of normalized.entries) {
      const account = db.prepare(SQL.selectAccount).get(entry.accountId);
      if (!account) return { ok: false, errors: ['entry-account-not-found'], accountId: entry.accountId };
      if (String(account.kind) !== entry.kind) {
        return { ok: false, errors: ['entry-account-kind-mismatch'], accountId: entry.accountId };
      }
      if (entry.kind === C.ACCOUNT_KIND.SYSTEM) {
        const sys = C.validateSystemAccountId(entry.accountId);
        if (!sys.ok) return { ok: false, errors: sys.errors };
      }
    }

    /* ── 透支预检（在事务体内的版本只作为最后一道保险）──────────────────
       "余额变负"不是一个可表示状态，因此它必须是一个**被拒绝的业务**，
       而不是一个从 applyDerivedBalances 里抛出来的运行时异常。这里在写
       任何东西之前，按本次 entries 的净效应预测每个钱包的结果余额。
       注意：预测的输入是 **ledger 重建出来的余额**，不是缓存 ——
       否则缓存漂移会变成一个真实的透支许可。 */
    const overdrafts = [];
    const projected = Object.create(null);
    for (const entry of normalized.entries) {
      if (entry.kind !== C.ACCOUNT_KIND.WALLET) continue;
      if (!(entry.accountId in projected)) {
        const account = db.prepare(SQL.selectAccount).get(entry.accountId);
        const wallet = account && account.wallet_id
          ? db.prepare(SQL.selectWallet).get(String(account.wallet_id)) : null;
        if (!wallet) return { ok: false, errors: ['entry-account-not-found'], accountId: entry.accountId };
        const derived = computeLedgerBalance(entry.accountId, String(wallet.currency));
        projected[entry.accountId] = { walletId: wallet.wallet_id, currency: wallet.currency, balance: derived.balanceMinor };
      }
      const slot = projected[entry.accountId];
      slot.balance = entry.direction === C.ENTRY_DIRECTION.DEBIT
        ? slot.balance + entry.amountMinor
        : slot.balance - entry.amountMinor;
    }
    for (const accountId of Object.keys(projected)) {
      if (projected[accountId].balance < 0n) {
        overdrafts.push({
          accountId: accountId,
          walletId: projected[accountId].walletId,
          currency: projected[accountId].currency,
          resultingBalanceMinor: formatSignedMinor(projected[accountId].balance).balanceMinor,
          resultingBalanceSign: formatSignedMinor(projected[accountId].balance).sign
        });
      }
    }
    if (overdrafts.length) {
      return { ok: false, errors: ['insufficient-balance'], overdrafts: overdrafts };
    }

    const fingerprint = transactionFingerprint({
      type: type,
      actor: actor.party,
      ownerId: s.ownerId,
      recipientId: s.recipientId
    }, normalized.entries);

    /* ── 幂等闸门（在事务之外，故重放零成本、零副作用）─────────────── */
    const seen = db.prepare(SQL.selectIdempotency).get(key.key);
    if (seen) {
      if (String(seen.fingerprint) !== fingerprint) {
        return {
          ok: false,
          errors: ['IDEMPOTENCY_CONFLICT'],
          detail: 'the same idempotency key was used with a different request',
          idempotencyKey: key.key,
          committedTransactionId: seen.transaction_id == null ? null : String(seen.transaction_id)
        };
      }
      return {
        ok: true,
        replayed: true,
        transactionId: seen.transaction_id == null ? null : String(seen.transaction_id),
        idempotencyKey: key.key,
        result: (() => { try { return JSON.parse(seen.result_json); } catch (_) { return null; } })()
      };
    }

    /* 同一个 transactionId 被换一个 key 再用：**不覆盖**，也不假装成功。
       这正是 P22 §14 的第二条（same transactionId / different key）。 */
    const existingTx = db.prepare(SQL.selectTransaction).get(transactionId);
    if (existingTx) {
      return {
        ok: false,
        errors: ['TRANSACTION_ID_ALREADY_COMMITTED'],
        detail: 'a transaction with this id already exists; a retry must reuse its idempotency key',
        transactionId: transactionId,
        committedIdempotencyKey: String(existingTx.idempotency_key)
      };
    }

    const at = clock();
    let committed = null;
    withTransaction(() => {
      const revision = allocateRevision();
      db.prepare(SQL.insertTransaction).run(
        transactionId, type, C.TX_STATE.COMMITTED,
        actor.party.type, actor.party.id,
        s.ownerId == null ? actor.party.id : String(s.ownerId),
        s.recipientId == null ? null : String(s.recipientId),
        key.key, fingerprint, revision, at
      );
      /* 故障注入点：交易已插入、entry 还没写。回滚必须让它消失。 */
      faultPoint('after-transaction-insert');

      const rows = [];
      /* 派生出来的 entry id 收集在这里：返回结果必须给出**真正落库**的
         那组 id，而不是调用方传进来的（可能是 null）。 */
      const committedEntryIds = [];
      for (let i = 0; i < normalized.entries.length; i++) {
        const entry = normalized.entries[i];
        /* id **确定性地**派生自 transactionId + 序号：重放同一笔业务会
           得到同一组 id，于是"两次返回逐字相同"成立。 */
        const ledgerEntryId = entry.ledgerEntryId || deriveEntryId(transactionId, i);
        if (!C.isEconomyId('LEDGER_ENTRY', ledgerEntryId)) {
          const err = new Error('economy ledger entry id is not canonical: ' + String(ledgerEntryId));
          err.code = 'LEDGER_ENTRY_ID_NOT_CANONICAL';
          throw err;
        }
        db.prepare(SQL.insertEntry).run(
          ledgerEntryId, transactionId, entry.accountId, entry.direction,
          toSqlAmount(entry.amountMinor, 'entry-amount'), entry.currency, i, revision, at
        );
        committedEntryIds.push(ledgerEntryId);
        rows.push(entry);
        if (i === 0) faultPoint('after-first-ledger-entry');
      }

      /* ── 写入口的平衡复查（用的是真实落库的行）──────────────────── */
      const storedRows = db.prepare(SQL.selectEntriesByTx).all(transactionId);
      const storedTopology = storedRows.map(r => ({
        currency: String(r.currency),
        direction: String(r.direction),
        amountMinor: fromSqlAmount(r.amount_minor, 'stored-entry-amount')
      }));
      const storedBalance = C.checkLedgerBalance(storedTopology);
      if (!storedBalance.balanced) {
        const err = new Error('economy ledger transaction is unbalanced as stored: ' + storedBalance.errors.join(','));
        err.code = 'LEDGER_UNBALANCED_AS_STORED';
        err.unbalancedCurrencies = storedBalance.unbalancedCurrencies || [];
        throw err;
      }
      if (storedRows.length !== normalized.entries.length) {
        const err = new Error('economy ledger transaction stored a different number of entries than validated');
        err.code = 'LEDGER_ENTRY_COUNT_MISMATCH';
        throw err;
      }

      const touched = applyDerivedBalances(normalized.entries, revision, at);
      faultPoint('before-change-log');

      appendChange({
        revision: revision, kind: String(type) + '_COMMITTED', entityId: transactionId,
        transactionId: transactionId, walletId: touched.length ? touched[0].walletId : null, at: at,
        payload: {
          domain: C.DOMAIN,
          transactionType: type,
          state: C.TX_STATE.COMMITTED,
          currencies: Array.from(new Set(normalized.entries.map(e => e.currency))).sort(),
          entryCount: normalized.entries.length,
          wallets: touched.map(w => ({
            walletId: w.walletId,
            balanceMinor: C.serializeAmountMinor(w.balanceMinor)
          }))
        }
      });

      const result = {
        domain: C.DOMAIN,
        transactionId: transactionId,
        transactionType: type,
        state: C.TX_STATE.COMMITTED,
        revision: revision,
        at: at,
        idempotencyKey: key.key,
        currencies: Array.from(new Set(normalized.entries.map(e => e.currency))).sort(),
        /* 逐币种拓扑。金额一律**十进制字符串** —— 与钱包、entry 的对外
           形态一致，于是 result 整体可 JSON 序列化，而"重放返回逐字相同
           的对象"这条性质可以被直接比较（BigInt 与字符串混在一个对象里
           会让 JSON.stringify 直接失败）。 */
        topology: (() => {
          const buckets = Object.create(null);
          for (const e of storedTopology) {
            const b = buckets[e.currency] || (buckets[e.currency] = { debit: 0n, credit: 0n });
            if (e.direction === C.ENTRY_DIRECTION.DEBIT) b.debit += e.amountMinor;
            else b.credit += e.amountMinor;
          }
          return Object.keys(buckets).sort().map(currency => ({
            currency: currency,
            debitTotal: C.serializeAmountMinor(buckets[currency].debit),
            creditTotal: C.serializeAmountMinor(buckets[currency].credit),
            balanced: buckets[currency].debit === buckets[currency].credit
          }));
        })(),
        wallets: touched.map(w => ({
          walletId: w.walletId,
          currency: w.currency,
          ownerId: w.ownerId,
          balanceMinor: C.serializeAmountMinor(w.balanceMinor),
          reservedBalanceMinor: C.serializeAmountMinor(w.reservedBalanceMinor)
        })),
        entries: normalized.entries.map((e, i) => ({
          ledgerEntryId: committedEntryIds[i],
          accountId: String(e.accountId),
          direction: String(e.direction),
          amountMinor: C.serializeAmountMinor(e.amountMinor),
          currency: String(e.currency),
          seq: i
        }))
      };

      /* 幂等行存的就是同一个对象。**必须逐字相同** —— 重放路径返回
         storedResult，而首次返回 result；两者若不同，"重试拿到的结果"与
         "当初的结果"就会静默分叉。 */
      const serializable = result;

      db.prepare(SQL.insertIdempotency).run(
        key.key, type, fingerprint, transactionId, JSON.stringify(serializable), revision, at
      );
      faultPoint('before-commit');
      committed = { result: result, idempotency: serializable };
    });

    pruneIdempotency(at);
    logger('economy-transaction-committed', {
      transactionId: transactionId,
      type: type,
      revision: committed.result.revision,
      entries: committed.result.entries.length,
      wallets: committed.result.wallets.length
    });
    return {
      ok: true,
      replayed: false,
      transactionId: transactionId,
      idempotencyKey: key.key,
      result: committed.result,
      /* 重放时返回**当初那条**幂等记录的内容，因此两次返回逐字相同。 */
      storedResult: committed.idempotency
    };
  }

  function pruneIdempotency(now) {
    if (!isOpen()) return;
    try {
      db.prepare(SQL.pruneIdempotency).run(Number(now) - IDEMPOTENCY_TTL_MS);
      const countRow = db.prepare(SQL.countIdempotency).get();
      const count = Number((countRow && countRow.c) || 0);
      if (count > IDEMPOTENCY_MAX) {
        const oldest = db.prepare(SQL.oldestIdempotency).all(count - IDEMPOTENCY_MAX);
        for (const row of oldest) db.prepare(SQL.deleteIdempotency).run(String(row.idempotency_key));
      }
    } catch (_) { /* 清理失败不影响已提交的事实 */ }
  }

  /* ══════════════════════════════════════════════════════════════════
     系统级 MINT / BURN（P22 §11）
     ──────────────────────────────────────────────────────────────────
     **只有**这两个函数能造出/销毁钱，而且它们：
       · 不经任何 HTTP 路由暴露（http.js 里没有对应路径）；
       · 对手方被强制成 system:mint / system:burn（validate 层 + 这里）；
       · 依旧走 commitLedgerTransaction，因此进 ledger、进 change_log、
         受幂等约束、可被 rebuild 重建。
     禁止的形态在这里是**不存在**的：本文件没有任何一句
     `UPDATE economy_wallets SET cached_balance_minor = ?` 出现在
     这两个函数里。
     ══════════════════════════════════════════════════════════════════ */

  function systemTransfer(direction, input) {
    const o = input || {};
    /* system initiated only：调用方必须显式声明自己是系统发起，
       而这个入口本身不在 HTTP 面上。`deps.systemAuthority` 若被装配层
       注入，还要再问它一次 —— 于是"未来某个路由不小心透传到这里"
       不会自动获得铸币权。 */
    if (o.systemInitiated !== true) {
      return { ok: false, errors: ['system-initiated-required'] };
    }
    if (typeof deps.systemAuthority === 'function' && deps.systemAuthority() !== true) {
      return { ok: false, errors: ['system-authority-unavailable'] };
    }
    const isMint = direction === 'MINT';
    const systemAccount = isMint ? C.SYSTEM_ACCOUNT.MINT : C.SYSTEM_ACCOUNT.BURN;
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return { ok: false, errors: cur.errors };
    const amt = C.normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) return { ok: false, errors: amt.errors };

    let walletRow = null;
    if (o.walletId) walletRow = db.prepare(SQL.selectWallet).get(String(o.walletId));
    else if (o.ownerId) walletRow = db.prepare(SQL.selectWalletByOwner).get(String(o.ownerId), cur.currency);
    if (!walletRow) return { ok: false, errors: ['wallet-not-found'] };
    if (String(walletRow.currency) !== cur.currency) {
      return { ok: false, errors: ['wallet-currency-mismatch'] };
    }

    const sys = ensureSystemAccount(systemAccount);
    if (!sys.ok) return { ok: false, errors: sys.errors };

    /* 记账方向：
         MINT ：system:mint  CREDIT   ←→  wallet  DEBIT
         BURN ：wallet       CREDIT   ←→  system:burn  DEBIT
       于是"钱从哪来 / 到哪去"在 direction 上就是可读的，而 system
       control account 的余额（见 computeLedgerBalance）符号相反。

       entry 的 id 刻意留空（null）：它由 commitLedgerTransaction 从
       transactionId 确定性派生，因此重放不会产生第二组 id。 */
    const transactionId = o.transactionId == null ? nextId('TRANSACTION') : o.transactionId;
    const walletEntry = {
      ledgerEntryId: null,
      accountId: walletRow.account_id,
      direction: isMint ? C.ENTRY_DIRECTION.DEBIT : C.ENTRY_DIRECTION.CREDIT,
      amountMinor: amt.amountMinor,
      currency: cur.currency
    };
    const systemEntry = {
      ledgerEntryId: null,
      accountId: systemAccount,
      direction: isMint ? C.ENTRY_DIRECTION.CREDIT : C.ENTRY_DIRECTION.DEBIT,
      amountMinor: amt.amountMinor,
      currency: cur.currency
    };

    return commitLedgerTransaction({
      transactionId: transactionId,
      type: isMint ? C.TX_TYPE.MINT : C.TX_TYPE.BURN,
      idempotencyKey: o.idempotencyKey,
      actor: { type: C.PARTY_TYPE.SYSTEM, id: systemAccount },
      ownerId: walletRow.owner_id,
      recipientId: null,
      entries: [walletEntry, systemEntry]
    });
  }

  function mintForSystem(input) { return systemTransfer('MINT', input); }
  function burnForSystem(input) { return systemTransfer('BURN', input); }

  /* 两个钱包之间的原子转账。它**不是** P22-3 的购买流程：没有 quote、
     没有 reservation、没有 approval、没有商品。它只是"两笔 entry 一个
     事务"这个能力的最小可测形态，而且它是 P22-2 里唯一能证明
     "wallet 之间相对记账"的路径。 */
  function transferBetweenWallets(input) {
    const o = input || {};
    requireOpen();
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return { ok: false, errors: cur.errors };
    const amt = C.normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) return { ok: false, errors: amt.errors };
    if (amt.amountMinor <= 0n) return { ok: false, errors: ['transfer-amount-must-be-positive'] };
    const from = o.fromWalletId ? db.prepare(SQL.selectWallet).get(String(o.fromWalletId)) : null;
    const to = o.toWalletId ? db.prepare(SQL.selectWallet).get(String(o.toWalletId)) : null;
    if (!from || !to) return { ok: false, errors: ['wallet-not-found'] };
    if (String(from.currency) !== cur.currency || String(to.currency) !== cur.currency) {
      return { ok: false, errors: ['transfer-currency-mismatch'] };
    }
    if (from.wallet_id === to.wallet_id) return { ok: false, errors: ['transfer-to-self'] };

    const actor = o.actor == null
      ? C.makePartyRef(String(from.owner_type), String(from.owner_id))
      : partyInput(o.actor);
    if (!actor || actor.ok !== true) return { ok: false, errors: (actor && actor.errors) || ['actor-required'] };

    const transactionId = o.transactionId == null ? nextId('TRANSACTION') : o.transactionId;
    return commitLedgerTransaction({
      transactionId: transactionId,
      type: o.type || C.TX_TYPE.GIFT,
      idempotencyKey: o.idempotencyKey,
      actor: actor.party,
      ownerId: from.owner_id,
      recipientId: to.owner_id,
      entries: [
        {
          ledgerEntryId: null, accountId: from.account_id,
          direction: C.ENTRY_DIRECTION.CREDIT,
          amountMinor: amt.amountMinor, currency: cur.currency
        },
        {
          ledgerEntryId: null, accountId: to.account_id,
          direction: C.ENTRY_DIRECTION.DEBIT,
          amountMinor: amt.amountMinor, currency: cur.currency
        }
      ]
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     健康 / 观测
     ══════════════════════════════════════════════════════════════════ */

  function health() {
    const open = isOpen();
    let counts = { wallets: 0, transactions: 0, entries: 0, changes: 0 };
    let revision = 0;
    let schema = ECONOMY_SCHEMA_VERSION;
    if (open) {
      try {
        counts = {
          wallets: countWallets(), transactions: countTransactions(),
          entries: countEntries(), changes: Number((db.prepare(SQL.countChanges).get() || {}).c || 0)
        };
        revision = getRevision();
        schema = Number(readMeta(META_SCHEMA) || ECONOMY_SCHEMA_VERSION);
      } catch (error) {
        degrade('health-read-failed:' + String(error && (error.code || error.message)));
      }
    }
    /* state 是**三态**，不是 ok/not-ok：COLD 明确表示"余额未知"，
       DEGRADED 表示"canonical 不可信"。两者都**不是** 0。
       注意：本函数在库关着时也返回一个 state（而不是抛错）——
       抛错会诱使调用方写 `catch { return 0 }`。 */
    const engine = engineStateNow();
    return {
      domain: C.DOMAIN,
      namespace: C.NAMESPACES.WALLET,
      open: open,
      state: engine.state,
      degradedReason: engine.state === C.WALLET_STATE.DEGRADED ? (engine.reason || null) : null,
      schemaVersion: schema,
      expectedSchemaVersion: ECONOMY_SCHEMA_VERSION,
      revision: revision,
      file: dbFile,
      lastOpenedAt: lastOpenedAt || null,
      counts: counts,
      /* 可检查的自述：Economy **没有**这些能力。与 http.js 的
         doesNotExpose 同一传统 —— 让"没有"成为一个可以被断言的字段，
         而不是一句注释。 */
      doesNotExpose: ['payments', 'credentials', 'provider-billing', 'topup', 'real-money'],
      canonical: 'sqlite-ledger-entries',
      derived: 'wallet-cached-balance'
    };
  }

  function isDegraded() { return !!engineReason; }

  function countWallets() { return Number((db.prepare(SQL.countWallets).get() || {}).c || 0); }
  function countTransactions() { return Number((db.prepare(SQL.countTransactions).get() || {}).c || 0); }
  function countEntries() { return Number((db.prepare(SQL.countEntries).get() || {}).c || 0); }

  /* ══════════════════════════════════════════════════════════════════
     test-only 检查面
     ──────────────────────────────────────────────────────────────────
     这些不是产品 API，而是让"缓存不是事实源"这条性质可以被**真实地**
     证伪再证实：先把缓存改坏，再用 rebuild 恢复，并断言恢复值等于
     从 ledger 独立算出来的值。它不在 HTTP 面上（http.js 没有任何路由
     能到达这里），因此不构成一条改余额的后门。
     ══════════════════════════════════════════════════════════════════ */

  function corruptCachedBalanceForTest(walletId, value) {
    requireOpen();
    const n = C.normalizeAmountMinor(value);
    if (!n.ok) return { ok: false, errors: n.errors };
    const row = db.prepare(SQL.selectWallet).get(String(walletId));
    if (!row) return { ok: false, errors: ['wallet-not-found'] };
    db.prepare(SQL.setWalletBalance).run(
      toSqlAmount(n.amountMinor, 'test-corruption'),
      toSqlAmount(fromSqlAmount(row.reserved_balance_minor, 'reserved'), 'test-corruption-reserved'),
      C.WALLET_STATE.READY, Number(row.revision), Number(row.updated_at), String(walletId)
    );
    return { ok: true, walletId: String(walletId), corruptedTo: C.serializeAmountMinor(n.amountMinor) };
  }

  /* 从 Ledger **独立**算一遍（不碰缓存、不修缓存）。
     测试用它做对照：rebuild 的结果必须等于它。 */
  function ledgerBalanceOf(walletId) {
    requireOpen();
    const row = db.prepare(SQL.selectWallet).get(String(walletId));
    if (!row) return { ok: false, errors: ['wallet-not-found'] };
    const derived = computeLedgerBalance(row.account_id, row.currency);
    return {
      ok: true,
      walletId: String(walletId),
      accountId: String(row.account_id),
      currency: String(row.currency),
      balanceMinor: C.serializeAmountMinor(derived.balanceMinor),
      debitTotalMinor: C.serializeAmountMinor(derived.debitTotal),
      creditTotalMinor: C.serializeAmountMinor(derived.creditTotal),
      entryCount: derived.debitCount + derived.creditCount
    };
  }

  /* 系统账户余额（= 增发总量等）。同样从 ledger 算，不存。 */
  function systemAccountBalance(accountId, currency) {
    requireOpen();
    const sys = C.validateSystemAccountId(accountId);
    if (!sys.ok) return { ok: false, errors: sys.errors };
    const cur = C.validateCurrency(currency);
    if (!cur.ok) return { ok: false, errors: cur.errors };
    const derived = computeLedgerBalance(sys.accountId, cur.currency);
    const signed = formatSignedMinor(derived.balanceMinor);
    return {
      ok: true,
      accountId: sys.accountId,
      currency: cur.currency,
      /* 控制账户：balanceMinor 是**无符号幅值**，方向由 sign 表达。
         见 formatSignedMinor 的说明 —— 负号不会以"负金额"的形态出现。 */
      balanceMinor: signed.balanceMinor,
      sign: signed.sign,
      creditTotalMinor: C.serializeAmountMinor(derived.creditTotal),
      debitTotalMinor: C.serializeAmountMinor(derived.debitTotal)
    };
  }

  return {
    /* 常量（测试与装配层读，避免再次硬编码） */
    SCHEMA_VERSION: ECONOMY_SCHEMA_VERSION,
    DB_FILENAME: DEFAULT_DB_FILENAME,
    TABLES: Object.freeze({
      META: META_TABLE, CHANGE_LOG: CHANGE_LOG_TABLE, IDEMPOTENCY: IDEMPOTENCY_TABLE,
      ACCOUNTS: ACCOUNTS_TABLE, WALLETS: WALLETS_TABLE,
      TRANSACTIONS: TRANSACTIONS_TABLE, ENTRIES: ENTRIES_TABLE
    }),
    META_KEYS: Object.freeze({
      SCHEMA: META_SCHEMA, REVISION: META_REVISION,
      ENGINE_STATE: META_ENGINE_STATE, ENGINE_REASON: META_ENGINE_REASON
    }),
    contract: C,

    /* 生命周期 */
    open: open,
    close: close,
    isOpen: isOpen,
    file: dbFile,

    /* Wallet */
    openWallet: openWallet,
    getWallet: getWallet,
    listWallets: listWallets,
    getLedgerAccount: getLedgerAccount,
    rebuildWalletBalance: rebuildWalletBalance,
    /* 对外 JSON 形态的唯一出口：金额一律十进制字符串。HTTP 层与未来的
       浏览器镜像都走它，于是"BigInt 泄漏成 number"没有第二个机会。 */
    serializeWallet: serializeWallet,

    /* Ledger 读取 */
    listLedgerEntries: listLedgerEntries,
    getTransaction: getTransaction,
    listTransactions: listTransactions,
    listChanges: listChanges,
    ledgerTopology: ledgerTopology,

    /* 唯一写入口 */
    commitLedgerTransaction: commitLedgerTransaction,
    mintForSystem: mintForSystem,
    burnForSystem: burnForSystem,
    transferBetweenWallets: transferBetweenWallets,

    /* 观测 */
    health: health,
    isDegraded: isDegraded,
    getRevision: getRevision,

    /* test-only（不在 HTTP 面上） */
    corruptCachedBalanceForTest: corruptCachedBalanceForTest,
    ledgerBalanceOf: ledgerBalanceOf,
    systemAccountBalance: systemAccountBalance,

    /* 内部工具，供 boundary/装配断言"没有别的余额写路径"时点名 */
    _internal: Object.freeze({
      stableStringify: stableStringify,
      fingerprint: fingerprintOf,
      deriveEntryId: deriveEntryId,
      SQL: SQL
    })
  };
}

module.exports = createEconomyStore;
module.exports.SCHEMA_VERSION = ECONOMY_SCHEMA_VERSION;
module.exports.MAX_AMOUNT_MINOR = MAX_AMOUNT_MINOR;
module.exports.tables = Object.freeze({
  META: META_TABLE, CHANGE_LOG: CHANGE_LOG_TABLE, IDEMPOTENCY: IDEMPOTENCY_TABLE,
  ACCOUNTS: ACCOUNTS_TABLE, WALLETS: WALLETS_TABLE,
  TRANSACTIONS: TRANSACTIONS_TABLE, ENTRIES: ENTRIES_TABLE
});
module.exports.fnv1a64Hex = fnv1a64Hex;
module.exports.stableStringify = stableStringify;
