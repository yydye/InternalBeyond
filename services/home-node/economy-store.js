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
     quote / purchase intent / approval（P22-4）· budget policy（P22-4）
     product / inventory / store（P22-5）· exchange（P22-6）
     compute 计价（P22-7）· Decision/Action adapter（P22-8）
     provider 适配（P22-9）· UI / 浏览器镜像（P22-11）
   transactions 表里有一列 `state`，但 P22-2 只在 COMMIT 的那一刻写入
   `COMMITTED`，且**不再更新**（append-only）。状态机本身属于 P22-3；
   这里只把"终态不可回退"这条契约用"根本没有 UPDATE 路径"来满足。P22-3 给
   两个新的**生命周期**表（operations / reservations）加了显式状态推进，
   但 ledger 的三个事实表一个字都没松。

   ── P22-3：operation 生命周期 + reservation（资金锁定）──────────────────
   这一层回答第三个问题：「这些钱现在**能不能花**？」答案不再只是余额，
   而是 availableBalance = cachedBalance − Σ(active reservations)。
   刻意分成**两个实体**，而不是把状态加到 ledger transaction 上：
     · economy_operations    —— 生命周期。词表 = P22-1 §8 TX_STATES
       （CREATED → RESERVED → {COMMITTED, RELEASED, EXPIRED, FAILED}），
       id 前缀 econ_op_。
     · economy_reservations  —— 资金锁定。词表 = P22-1 §12
       RESERVATION_STATE（ACTIVE / COMMITTED / RELEASED / EXPIRED），
       id 前缀 econ_res_。
   为什么不合并：两张词表的**终态集合不同**（reservation 没有 FAILED），
   而 P22-1 把两者都冻结了。合并就必须给其中一个加成员或加别名 —— 那是
   破坏冻结契约，不是实现它。两者由契约的 RESERVATION_STATE_OF_OPERATION
   映射连接，而那份映射是**数据**，不是散落在运行时的 if。
   reservedBalance 的 canonical truth 是 **active reservation 行**，
   wallets.reserved_balance_minor 只是派生缓存（与 cachedBalance 同款）。

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
   去读会把不认识的列当成不存在的语义。

   ── P22-3：1 → 2 ────────────────────────────────────────────────────
   为什么这是一次**真的**版本变更而不是"反正 CREATE TABLE IF NOT EXISTS
   会补上"：watermark 回答的是"这个库属于哪一代 schema"，而 P22-3 让这个
   库多出了三张表。抬水位带来两个方向都正确的行为：
     · 一个 P22-2 的 build 打开 P22-3 的库 → **拒绝**（SCHEMA_TOO_NEW），
       而不是"读得到余额但完全不知道有预留"；
     · 一个 P22-3 的 build 打开 P22-2 的库 → 走受支持的老版本路径，
       DDL 补上新表，水位抬到 2，**既有 ledger 行一个字节都不动**
       （tests/test_p22_3_economy_reservation.js 的 M 组逐条断言）。
   1 → 2 的 MIGRATIONS 条目为空，因为没有任何既有列或既有数据需要改写；
   空数组是**刻意**的，它让"没有数据迁移"这件事本身可被断言。

   ── P22-4：2 → 3 ────────────────────────────────────────────────────
    同一条纪律的第三次应用。P22-4 让这个库多出两张表（预算政策与报价），
    于是：
      · 一个 P22-3 的 build 打开 P22-4 的库 → **拒绝**（SCHEMA_TOO_NEW）。
        如果它不拒绝，它就会看到一个"没有政策、没有报价"的经济 —— 而
        那是一个**错误的**世界：它会认为任何消费都没有规则约束。
        这正是"读得到账本但不认识规则"最危险的形态，比打不开严重得多。
      · 一个 P22-4 的 build 打开 P22-3 的库 → 受支持的老版本路径，
        DDL 补上两张表，水位抬到 3，**既有 ledger / reservation 行一个
        字节都不动**。
    2 → 3 同样是空的 MIGRATIONS 条目：没有既有列需要改写，只有新表。

   ── P22-5：3 → 4 ────────────────────────────────────────────────────
     同一条纪律的第四次应用。P22-5 让这个库多出三张表（货架 / 商品 /
     库存），于是：
       · 一个 P22-4 的 build 打开 P22-5 的库 → **拒绝**（SCHEMA_TOO_NEW）。
         如果它不拒绝，它就会看到一个"什么都没得卖"的经济 —— 而那是一份
         **错误的**目录：任何基于"这件商品不存在"的判断都会在错误的
         前提上成立。
       · 一个 P22-5 的 build 打开 P22-4 的库 → 受支持的老版本路径，
         DDL 补上三张表，水位抬到 4，**既有 ledger / reservation /
         policy / quote 行一个字节都不动**（focused 测试的 N 组逐条断言）。
     3 → 4 仍然是空的 MIGRATIONS 条目：没有既有列需要改写，只有新表。 */
const ECONOMY_SCHEMA_VERSION = 4;
const DEFAULT_DB_FILENAME = 'home-node.db';

const META_TABLE = 'economy_meta';
const CHANGE_LOG_TABLE = 'economy_change_log';
const IDEMPOTENCY_TABLE = 'economy_idempotency';
const ACCOUNTS_TABLE = 'economy_ledger_accounts';
const WALLETS_TABLE = 'economy_wallets';
const TRANSACTIONS_TABLE = 'economy_transactions';
const ENTRIES_TABLE = 'economy_ledger_entries';
/* ── P22-3 ───────────────────────────────────────────────────────────
   两张表而不是一张，理由见文件头。第三张是**操作级**幂等键空间：
   它与 economy_idempotency（ledger 提交的键空间）刻意分开，因为
   "这次 reserve 请求做过没有"与"这笔 ledger 业务提交过没有"是两个
   不同的问题、映射到不同的东西（operation 结果 vs transaction）。
   分开的直接好处：reserve 用一个 key、commit 用同一个 key，两者不会
   被误判成同一个业务请求（P22-3 §18），而且 P22-2 已落库的裸 key
   语义一个字都不用改（跨版本重放安全）。 */
const OPERATIONS_TABLE = 'economy_operations';
const RESERVATIONS_TABLE = 'economy_reservations';
const OPERATION_IDEMPOTENCY_TABLE = 'economy_operation_idempotency';
/* P22-4：预算政策与报价。两者都是**规则 / 命题**，不是经济事实，
   因此它们是自己的两张表，而不是往 ledger 或 operation 里塞列。 */
const BUDGET_POLICIES_TABLE = 'economy_budget_policies';
const QUOTES_TABLE = 'economy_quotes';
/* ── P22-5 ────────────────────────────────────────────────────────────
   三张表而不是一张，理由与 P22-3/P22-4 同源，而且这里更硬：
     · economy_stores    —— 组织方式（哪个货架）。
     · economy_products  —— 价格与交付形态。
     · economy_inventory —— 已经发生的**拥有事实**。
   P22-5 §1 把这条写成了六条不等式（Product ≠ Quote，Product ≠ Inventory，
   Inventory ≠ Wallet …），而把它们塞进一张表的直接后果是：一次改价会
   同时写到一个"拥有关系"旁边，于是"这件商品我是什么时候有的"与
   "它现在多少钱"变成同一行的两个字段 —— 前者是历史，后者是现在。 */
const STORES_TABLE = 'economy_stores';
const PRODUCTS_TABLE = 'economy_products';
const INVENTORY_TABLE = 'economy_inventory';

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

/* ── P22-5 · 库存数量的上界 ───────────────────────────────────────────
   与金额同源：canonical 表示必须 ⊆ JS 能精确表示的。库存数量的 canonical
   形态刻意是**安全整数**而不是 BigInt —— 它是一次计数，不是一笔钱；而
   用 BigInt 表示"我拥有几个"会让 2^53 个物品这种不可能的状态变得可表示。
   上界仍然是一条被**查出来**的规则：增长后的数量必须仍然安全，否则拒绝。 */
const MAX_INVENTORY_QUANTITY = 9007199254740991;

/* ── P22-3 · 资金被还回去的**原因**（封闭集合）────────────────────────
   为什么它不在 P22-1 契约里：它不是一个跨模块载荷的形状规则，而是本
   store 为了回答"这笔预留为什么没成交"而持久化的审计元数据（P22 §16）。
   P22-1 已经冻结的是**状态**词表；这里区分的是同一状态下的不同原因 ——
   把原因塞进状态，正是 P22-3 §13 明确禁止的合并。
   放在**模块**作用域（而不是工厂里）：它是一个常量，没有 per-instance
   状态，而且要让 `module.exports.releaseReason` 能把它交出去。 */
const RELEASE_REASON = Object.freeze({
  USER: 'USER',
  SYSTEM: 'SYSTEM',
  EXPIRED: 'EXPIRED',
  OPERATION_FAILED: 'OPERATION_FAILED'
});

function loadSqlite() {  try { return require('node:sqlite'); }
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
     clock + 计数器，**不**使用 Math.random —— 它没有任何跨进程保证。

     ── P22-3 修好了一个真实缺陷：缺省 id 在**多进程**下会撞车 ─────────
     P22-2 的缺省实现是 `clock().toString(36) + '_' + idSeq`，而 idSeq 是
     **每进程**从 1 开始的计数器。于是两个进程在同一毫秒各自做第一次
     生成时，会得到**逐字相同**的 id —— 如果它们写同一个库，第二次插入
     撞 PRIMARY KEY，抛出一个 UNIQUE constraint 异常。
     P22-2 的注释当时把这归为"失败方向是安全的"，但那句话只在一个进程
     独占地写库时成立。P22-3 让它变成真实可达的：一次 reserve 要生成
     **两个** id（operation + reservation），而多进程同时动手正是 §20
     要求被证明的场景。实测（tests/test_p22_3_economy_runtime.js 的 P 组，
     修复前）：4 个真实进程同时 reserve，3 个以
     `UNIQUE constraint failed: economy_operations.operation_id` **崩溃**。

     修法刻意是**最小的**：把进程身份放进 id。PID 在同一台机器上对
     **存活**进程唯一，而"共享同一个 SQLite 文件"正是它唯一的适用范围 ——
     因此它恰好覆盖了唯一会出问题的那种并发。仍然不需要随机源，
     仍然不需要时钟单调，仍然可以只用 clock() 做前缀。
     （跨机器共享文件不在范围内：SQLite 本来就不支持网络文件系统。） */
  let idSeq = 0;
  const processTag = (typeof process !== 'undefined' && process && process.pid)
    ? Number(process.pid).toString(36) : '0';
  const nextId = typeof deps.nextId === 'function'
    ? deps.nextId
    : (kind) => {
      idSeq += 1;
      const t = clock().toString(36);
      return C.formatEconomyId(kind, t + '_' + processTag + '_' + idSeq.toString(36)).id;
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
    deleteIdempotency: 'DELETE FROM ' + IDEMPOTENCY_TABLE + ' WHERE idempotency_key=?',

    /* ══ P22-3 · operation 生命周期 ══════════════════════════════════════
       没有 amount 之外的任何业务负载：quote / product / provider /
       approval 都不在这里（P22-4/5）。expires_at 允许 NULL = 不过期，
       但 reserveFunds 总是给出一个（TTL 是预留的定义之一）。 */
    createOperations:
      'CREATE TABLE IF NOT EXISTS ' + OPERATIONS_TABLE + ' (' +
      ' operation_id TEXT PRIMARY KEY,' +
      ' status TEXT NOT NULL,' +
      ' wallet_id TEXT NOT NULL,' +
      ' currency TEXT NOT NULL,' +
      ' amount_minor INTEGER NOT NULL,' +
      ' reservation_id TEXT,' +
      ' transaction_id TEXT,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' expires_at INTEGER,' +
      ' reason_code TEXT,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL' +
      ')',
    createOperationsByWallet: 'CREATE INDEX IF NOT EXISTS idx_econ_ops_wallet ON ' + OPERATIONS_TABLE + ' (wallet_id, status)',
    createOperationsByStatus: 'CREATE INDEX IF NOT EXISTS idx_econ_ops_status ON ' + OPERATIONS_TABLE + ' (status, created_at)',
    createOperationsByReservation: 'CREATE INDEX IF NOT EXISTS idx_econ_ops_res ON ' + OPERATIONS_TABLE + ' (reservation_id)',
    createOperationsByKey: 'CREATE INDEX IF NOT EXISTS idx_econ_ops_key ON ' + OPERATIONS_TABLE + ' (idempotency_key)',

    /* ══ P22-3 · reservation（资金锁定）══════════════════════════════════
       transaction_id 上有一条 **UNIQUE** 索引，这是"一次 commit 的预留
       ↔ 恰好一笔 ledger transaction"的**结构性**约束（P22-3 §11）：
       SQLite 的 UNIQUE 允许多个 NULL（未提交的预留），因此它约束的是
       "一笔 ledger transaction 不可能被两笔预留同时指向"。
       反方向（一笔预留不会有两笔 transaction）由"transaction_id 是单个列"
       本身保证 —— 两个方向都不靠代码自律。 */
    createReservations:
      'CREATE TABLE IF NOT EXISTS ' + RESERVATIONS_TABLE + ' (' +
      ' reservation_id TEXT PRIMARY KEY,' +
      ' operation_id TEXT NOT NULL,' +
      ' wallet_id TEXT NOT NULL,' +
      ' currency TEXT NOT NULL,' +
      ' amount_minor INTEGER NOT NULL,' +
      ' status TEXT NOT NULL,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' expires_at INTEGER,' +
      ' transaction_id TEXT,' +
      ' release_reason TEXT,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL' +
      ')',
    /* 这条索引是 reservedBalance 重建的入口：Σ(amount) WHERE wallet+ACTIVE。 */
    createReservationsByWalletStatus: 'CREATE INDEX IF NOT EXISTS idx_econ_res_wallet_status ON ' + RESERVATIONS_TABLE + ' (wallet_id, status)',
    createReservationsByOperation: 'CREATE INDEX IF NOT EXISTS idx_econ_res_op ON ' + RESERVATIONS_TABLE + ' (operation_id)',
    createReservationsByExpiry: 'CREATE INDEX IF NOT EXISTS idx_econ_res_expiry ON ' + RESERVATIONS_TABLE + ' (status, expires_at)',
    createReservationsByTransaction: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_res_tx ON ' + RESERVATIONS_TABLE + ' (transaction_id)',

    insertOperation:
      'INSERT INTO ' + OPERATIONS_TABLE + ' (operation_id, status, wallet_id, currency, amount_minor, reservation_id, transaction_id, idempotency_key, fingerprint, expires_at, reason_code, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectOperation: 'SELECT * FROM ' + OPERATIONS_TABLE + ' WHERE operation_id=?',
    selectOperationByReservation: 'SELECT * FROM ' + OPERATIONS_TABLE + ' WHERE reservation_id=?',
    selectOperations: 'SELECT * FROM ' + OPERATIONS_TABLE + ' ORDER BY created_at ASC, operation_id ASC LIMIT ?',
    selectOperationsByWallet: 'SELECT * FROM ' + OPERATIONS_TABLE + ' WHERE wallet_id=? ORDER BY created_at ASC, operation_id ASC LIMIT ?',
    selectOperationsByStatus: 'SELECT * FROM ' + OPERATIONS_TABLE + ' WHERE status=? ORDER BY created_at ASC, operation_id ASC LIMIT ?',
    countOperations: 'SELECT COUNT(*) AS c FROM ' + OPERATIONS_TABLE,
    countOperationsByStatus: 'SELECT COUNT(*) AS c FROM ' + OPERATIONS_TABLE + ' WHERE status=?',
    /* ── operation 的**唯一**状态推进语句 ────────────────────────────────
       `AND status=?` 是乐观并发：只有"我以为的那个状态"才允许被推进，
       于是两次并发推进里必然有一次 changes=0（被调用点当成拒绝）。
       刻意**只能**赋这六列：wallet_id / currency / amount_minor /
       idempotency_key / fingerprint / operation_id / created_at 都改不了 ——
       一次操作的经济内容写下之后不可变，能变的只有它的生命周期。
       reservation_id 在这里被"原值写回"（提交时传的是行里读到的同一个值），
       它只在 CREATED → RESERVED 那一次真正从 NULL 变成 id。 */
    setOperationStatus:
      'UPDATE ' + OPERATIONS_TABLE + ' SET status=?, reservation_id=?, transaction_id=?, reason_code=?, revision=?, updated_at=? WHERE operation_id=? AND status=?',

    insertReservation:
      'INSERT INTO ' + RESERVATIONS_TABLE + ' (reservation_id, operation_id, wallet_id, currency, amount_minor, status, idempotency_key, fingerprint, expires_at, transaction_id, release_reason, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectReservation: 'SELECT * FROM ' + RESERVATIONS_TABLE + ' WHERE reservation_id=?',
    selectReservationByOperation: 'SELECT * FROM ' + RESERVATIONS_TABLE + ' WHERE operation_id=?',
    selectReservations: 'SELECT * FROM ' + RESERVATIONS_TABLE + ' ORDER BY created_at ASC, reservation_id ASC LIMIT ?',
    /* 不带 LIMIT 的全表读：open 时的对账必须看到**全部**预留行。 */
    selectReservationsAll: 'SELECT * FROM ' + RESERVATIONS_TABLE + ' ORDER BY created_at ASC, reservation_id ASC',
    selectReservationsByWallet: 'SELECT * FROM ' + RESERVATIONS_TABLE + ' WHERE wallet_id=? ORDER BY created_at ASC, reservation_id ASC LIMIT ?',
    selectReservationsByStatus: 'SELECT * FROM ' + RESERVATIONS_TABLE + ' WHERE status=? ORDER BY created_at ASC, reservation_id ASC LIMIT ?',
    /* ── canonical reserved truth ────────────────────────────────────────
       reservedBalance 的**唯一**算术入口：ACTIVE 行的 amount 之和。
       没有"带符号的净额"、没有"增量"—— 与 ledger 的 sumDebit/sumCredit
       同款：先求和，再把和写进缓存。 */
    sumActiveReserved: 'SELECT COALESCE(SUM(amount_minor), 0) AS total, COUNT(*) AS n FROM ' + RESERVATIONS_TABLE + ' WHERE wallet_id=? AND status=\'ACTIVE\'',
    /* 不带 LIMIT 的整钱包读：完整性检查与对账必须看到**全部**行，
       一个 LIMIT 会让"第 501 行坏了"这件事永远不可见。 */
    selectReservationsByWalletAll: 'SELECT * FROM ' + RESERVATIONS_TABLE + ' WHERE wallet_id=? ORDER BY created_at ASC, reservation_id ASC',
    countActiveReservations: 'SELECT COUNT(*) AS c FROM ' + RESERVATIONS_TABLE + ' WHERE status=\'ACTIVE\'',
    selectWalletsWithReservedCache: 'SELECT * FROM ' + WALLETS_TABLE + ' WHERE reserved_balance_minor != 0 ORDER BY wallet_id ASC',
    /* 到期扫描：status='ACTIVE' AND expires_at <= now。
       刻意**不用**任何定时器 —— 真相是这条 WHERE，不是某个 setTimeout。
       ORDER BY 让"批量扫描"有确定顺序（同一次 sweep 的两次运行结果一致）。 */
    selectDueReservations:
      'SELECT * FROM ' + RESERVATIONS_TABLE + ' WHERE status=\'ACTIVE\' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at ASC, reservation_id ASC LIMIT ?',
    countReservations: 'SELECT COUNT(*) AS c FROM ' + RESERVATIONS_TABLE,
    countReservationsByStatus: 'SELECT COUNT(*) AS c FROM ' + RESERVATIONS_TABLE + ' WHERE status=?',
    /* ── reservation 的**唯一**状态推进语句 ──────────────────────────────
       同样只允许赋生命周期列。wallet_id / currency / amount_minor /
       operation_id / idempotency_key / created_at 全部不在 SET 里 ——
       "锁了多少钱、锁给谁"在预留写下之后就是历史，不能改。
       `AND status=?` 让"终态不可回退"成为一条**并发安全**的 SQL 约束：
       一个已经 COMMITTED 的预留不可能被第二次推进（changes=0）。 */
    setReservationStatus:
      'UPDATE ' + RESERVATIONS_TABLE + ' SET status=?, transaction_id=?, release_reason=?, revision=?, updated_at=? WHERE reservation_id=? AND status=?',

    /* ── 派生缓存：reserved 列的唯一写语句 ───────────────────────────────
       它写的是**从 active reservations 求和得到的值**，不是"在旧值上加"。
       刻意与 setWalletBalance 分开：那条语句写的是 cached（从 ledger 求和），
       这条写的是 reserved（从 reservations 求和）—— 两个派生量的
       canonical 来源不同，用同一条语句写会让"它到底代表什么"含糊。
       本语句里**没有** cached_balance_minor（因此"唯一一条写 cached 的
       语句"这条 P22-2 断言仍然恰好只匹配到 setWalletBalance）。 */
    setWalletReserved:
      'UPDATE ' + WALLETS_TABLE + ' SET reserved_balance_minor=?, revision=?, updated_at=? WHERE wallet_id=?',

    /* ══ P22-3 · 操作级幂等键空间（scope + key）══════════════════════════
       主键是二元组：reserve / commit / release / expire / fail 各占一个
       scope，于是"reserve 用 key X"与"commit 用 key X"是两条不同的记录，
       不会被误判成同一个业务请求。 */
    createOperationIdempotency:
      'CREATE TABLE IF NOT EXISTS ' + OPERATION_IDEMPOTENCY_TABLE + ' (' +
      ' scope TEXT NOT NULL,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' operation_id TEXT,' +
      ' reservation_id TEXT,' +
      ' transaction_id TEXT,' +
      ' result_json TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' at INTEGER NOT NULL,' +
      ' PRIMARY KEY (scope, idempotency_key)' +
      ')',
    createOperationIdempotencyByOp: 'CREATE INDEX IF NOT EXISTS idx_econ_opidem_op ON ' + OPERATION_IDEMPOTENCY_TABLE + ' (operation_id)',
    createOperationIdempotencyByAt: 'CREATE INDEX IF NOT EXISTS idx_econ_opidem_at ON ' + OPERATION_IDEMPOTENCY_TABLE + ' (at)',
    selectOperationIdempotency: 'SELECT * FROM ' + OPERATION_IDEMPOTENCY_TABLE + ' WHERE scope=? AND idempotency_key=?',
    insertOperationIdempotency:
      'INSERT INTO ' + OPERATION_IDEMPOTENCY_TABLE + ' (scope, idempotency_key, fingerprint, operation_id, reservation_id, transaction_id, result_json, revision, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      /* P22-4：见 writeOperationIdempotency 的说明 —— 幂等记录是**第一次**
         执行的证据，后来的重试没有权力覆盖它，也不该因此崩溃。 */
      ' ON CONFLICT(scope, idempotency_key) DO NOTHING',
    pruneOperationIdempotency: 'DELETE FROM ' + OPERATION_IDEMPOTENCY_TABLE + ' WHERE at < ?',
    countOperationIdempotency: 'SELECT COUNT(*) AS c FROM ' + OPERATION_IDEMPOTENCY_TABLE,
    oldestOperationIdempotency: 'SELECT scope, idempotency_key FROM ' + OPERATION_IDEMPOTENCY_TABLE + ' ORDER BY at ASC LIMIT ?',
    deleteOperationIdempotency: 'DELETE FROM ' + OPERATION_IDEMPOTENCY_TABLE + ' WHERE scope=? AND idempotency_key=?',

    /* ══ P22-4 · 预算政策（规则，不是经济事实）══════════════════════════
       UNIQUE(owner_id) 而不是 UNIQUE(owner_id, currency)：**一个 owner 恰好
       一条政策**，而政策自身说它作用在哪个币种上。若按二元组唯一，一个
       owner 就能同时拥有"IB_CREDIT 的政策"和"COMPUTE 的政策"，而评估
       时必须先选一条 —— 那是一次没有正确答案的选择（两条都"对"）。
       把 scope 变成政策的属性之后，"有没有规则"这个问题只有一个是非答案。

       五个限额列全部带 _minor 后缀（§4）。term_ends_at 允许 NULL
       （= 没有期限）；hard_stop 与 status 分开，因为"被显式停用"与
       "期限走完了"是两件在审计里必须可分的事。

       刻意**没有**的列：provider / apiKey / paymentIntent / relationship /
       memory / realCurrency。政策只描述"允不允许花多少"。 */
    createBudgetPolicies:
      'CREATE TABLE IF NOT EXISTS ' + BUDGET_POLICIES_TABLE + ' (' +
      ' policy_id TEXT PRIMARY KEY,' +
      ' owner_id TEXT NOT NULL,' +
      ' owner_type TEXT NOT NULL,' +
      ' currency TEXT NOT NULL,' +
      ' status TEXT NOT NULL,' +
      ' max_per_tx_minor INTEGER,' +
      ' max_per_day_minor INTEGER,' +
      ' max_per_week_minor INTEGER,' +
      ' max_per_month_minor INTEGER,' +
      ' approval_above_minor INTEGER,' +
      ' cooldown_ms INTEGER,' +
      ' autonomy_level TEXT,' +
      ' term_ends_at INTEGER,' +
      ' hard_stop INTEGER NOT NULL DEFAULT 0,' +
      ' hard_stopped_at INTEGER,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' UNIQUE (owner_id)' +
      ')',
    createBudgetPoliciesByStatus: 'CREATE INDEX IF NOT EXISTS idx_econ_policy_status ON ' + BUDGET_POLICIES_TABLE + ' (status, owner_id)',
    createBudgetPoliciesByTerm: 'CREATE INDEX IF NOT EXISTS idx_econ_policy_term ON ' + BUDGET_POLICIES_TABLE + ' (status, term_ends_at)',
    insertBudgetPolicy:
      'INSERT INTO ' + BUDGET_POLICIES_TABLE + ' (policy_id, owner_id, owner_type, currency, status, max_per_tx_minor, max_per_day_minor, max_per_week_minor, max_per_month_minor, approval_above_minor, cooldown_ms, autonomy_level, term_ends_at, hard_stop, hard_stopped_at, idempotency_key, fingerprint, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectBudgetPolicy: 'SELECT * FROM ' + BUDGET_POLICIES_TABLE + ' WHERE policy_id=?',
    selectBudgetPolicyByOwner: 'SELECT * FROM ' + BUDGET_POLICIES_TABLE + ' WHERE owner_id=?',
    selectBudgetPolicies: 'SELECT * FROM ' + BUDGET_POLICIES_TABLE + ' ORDER BY created_at ASC, policy_id ASC LIMIT ?',
    selectBudgetPoliciesByStatus: 'SELECT * FROM ' + BUDGET_POLICIES_TABLE + ' WHERE status=? ORDER BY created_at ASC, policy_id ASC LIMIT ?',
    /* 到期扫描的入口：与 reservation / quote 同一条形状 —— 真相是一条
       WHERE（status='ACTIVE' AND term_ends_at <= now），不是某个调度。 */
    selectPoliciesDue:
      'SELECT * FROM ' + BUDGET_POLICIES_TABLE + ' WHERE hard_stop=0 AND status=? AND term_ends_at IS NOT NULL AND term_ends_at <= ? ORDER BY term_ends_at ASC, policy_id ASC LIMIT ?',
    countBudgetPolicies: 'SELECT COUNT(*) AS c FROM ' + BUDGET_POLICIES_TABLE,
    countBudgetPoliciesByStatus: 'SELECT COUNT(*) AS c FROM ' + BUDGET_POLICIES_TABLE + ' WHERE status=?',
    /* ── 政策的**唯一**写语句 ────────────────────────────────────────────
       它同时承担 create 与 update 两种语义（update = upsert），因此
       SET 里可以出现经济内容列 —— 这是本文件里唯一一条允许改规则内容的
       UPDATE，而它改的是**规则**，不是任何一笔已经发生的经济事实。
       仍然有 `AND status=?` 形式的并发信息吗？没有，而且这是刻意的：
       政策的期望状态是一个**乐观并发问题**，解法在 store 层（见
       putBudgetPolicy 的 `ifRevision` 参数），而不是再写一条 SQL。
       真正不可变的是 policy_id / owner_id / created_at。 */
    upsertBudgetPolicy:
      'UPDATE ' + BUDGET_POLICIES_TABLE + ' SET currency=?, status=?, max_per_tx_minor=?, max_per_day_minor=?, max_per_week_minor=?, max_per_month_minor=?, approval_above_minor=?, cooldown_ms=?, autonomy_level=?, term_ends_at=?, hard_stop=?, hard_stopped_at=?, idempotency_key=?, fingerprint=?, revision=?, updated_at=? WHERE policy_id=?',
    /* 停用只动两列：状态与停用时刻。限额一个字都不改 —— 停用不是
       "把额度改成 0"，那会让重新启用时需要把五个数字再猜一遍。 */
    setPolicyStatus:
      'UPDATE ' + BUDGET_POLICIES_TABLE + ' SET status=?, hard_stop=?, hard_stopped_at=?, revision=?, updated_at=? WHERE policy_id=? AND status=?',

    /* ══ P22-4 · 报价（价格命题，不是资源锁定）══════════════════════════
       service_role TEXT NOT NULL —— 结算形态在**创建时**就派生并写下来，
       而不是在结算时重新推导。理由与"报价存在的意义"同源：将来真正
       执行时读到的必须是与报价一起冻结的那个答案。

       UNIQUE(predecessor_quote_id)：一份报价只可能被"重新报价"一次。
       这不是业务规则，而是一条**结构性**事实：链是用来回答"这个价格
       是从哪来的"，而一个分叉的链回答不了。

       刻意**没有**的列：inventory_count / owned_items /
       provider_quota_balance / api_key / payment_link（§28：报价不得
       变成隐蔽库存，也不得携带凭据或真实支付信息）。 */
    createQuotes:
      'CREATE TABLE IF NOT EXISTS ' + QUOTES_TABLE + ' (' +
      ' quote_id TEXT PRIMARY KEY,' +
      ' product_id TEXT NOT NULL,' +
      ' buyer_id TEXT NOT NULL,' +
      ' buyer_type TEXT NOT NULL,' +
      ' recipient_id TEXT,' +
      ' recipient_type TEXT,' +
      ' currency TEXT NOT NULL,' +
      ' amount_minor INTEGER NOT NULL,' +
      ' quantity INTEGER NOT NULL,' +
      ' quote_kind TEXT NOT NULL,' +
      ' service_role TEXT NOT NULL,' +
      ' state TEXT NOT NULL,' +
      ' expires_at INTEGER NOT NULL,' +
      ' predecessor_quote_id TEXT,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL' +
      ')',
    createQuotesByBuyer: 'CREATE INDEX IF NOT EXISTS idx_econ_quotes_buyer ON ' + QUOTES_TABLE + ' (buyer_id, state, created_at)',
    createQuotesByProduct: 'CREATE INDEX IF NOT EXISTS idx_econ_quotes_product ON ' + QUOTES_TABLE + ' (product_id)',
    createQuotesByExpiry: 'CREATE INDEX IF NOT EXISTS idx_econ_quotes_expiry ON ' + QUOTES_TABLE + ' (state, expires_at)',
    createQuotesByPredecessor: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_quotes_predecessor ON ' + QUOTES_TABLE + ' (predecessor_quote_id)',
    insertQuote:
      'INSERT INTO ' + QUOTES_TABLE + ' (quote_id, product_id, buyer_id, buyer_type, recipient_id, recipient_type, currency, amount_minor, quantity, quote_kind, service_role, state, expires_at, predecessor_quote_id, idempotency_key, fingerprint, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectQuote: 'SELECT * FROM ' + QUOTES_TABLE + ' WHERE quote_id=?',
    selectQuoteByPredecessor: 'SELECT * FROM ' + QUOTES_TABLE + ' WHERE predecessor_quote_id=?',
    selectQuotes: 'SELECT * FROM ' + QUOTES_TABLE + ' ORDER BY created_at ASC, quote_id ASC LIMIT ?',
    selectQuotesByBuyer: 'SELECT * FROM ' + QUOTES_TABLE + ' WHERE buyer_id=? ORDER BY created_at ASC, quote_id ASC LIMIT ?',
    selectQuotesByBuyerAndState: 'SELECT * FROM ' + QUOTES_TABLE + ' WHERE buyer_id=? AND state=? ORDER BY created_at ASC, quote_id ASC LIMIT ?',
    selectQuotesByState: 'SELECT * FROM ' + QUOTES_TABLE + ' WHERE state=? ORDER BY created_at ASC, quote_id ASC LIMIT ?',
    selectQuotesAll: 'SELECT * FROM ' + QUOTES_TABLE + ' ORDER BY created_at ASC, quote_id ASC',
    /* 报价与政策共用一条到期形状：status='OPEN' AND expires_at <= now。 */
    selectDueQuotes:
      'SELECT * FROM ' + QUOTES_TABLE + ' WHERE state=? AND expires_at <= ? ORDER BY expires_at ASC, quote_id ASC LIMIT ?',
    countQuotes: 'SELECT COUNT(*) AS c FROM ' + QUOTES_TABLE,
    countQuotesByState: 'SELECT COUNT(*) AS c FROM ' + QUOTES_TABLE + ' WHERE state=?',
    /* ── 报价的**唯一**状态推进语句（§9：金额与币种不可变）──────────────
       SET 里**没有** amount_minor / currency / buyer_id / product_id /
       quantity / quote_kind / service_role / expires_at / created_at。
       于是 P22-4 §9 的 immutable 不是一句纪律，而是"那些列根本没有
       出现在任何 UPDATE 的 SET 里"。

       `AND state=?` 在这里承担两件事：
         ① 乐观并发（两个 expire 只有一个 changes=1）；
         ② **终态不可回退** —— 一个已经 CONSUMED 的报价不可能再被
            expire（changes=0 ⇒ 调用点拒绝）。 */
    setQuoteState:
      'UPDATE ' + QUOTES_TABLE + ' SET state=?, revision=?, updated_at=? WHERE quote_id=? AND state=?',

    /* ── P22-4 · 消费窗口的 canonical 求和入口（§14）─────────────────────
       一次查询取回"这个钱包在最早窗口之后的每一笔**消费**"，由 JS 按
       UTC 边界分桶。分桶之所以放在 JS 而不是三条 SQL 里：三个窗口的边界
       来自契约的三个纯函数，把它们翻译成三条 WHERE 会让"窗口是什么"
       有两个定义（一条在契约、一条在 SQL），而两者会漂移。

       三处刻意：
       ① 金额只从 `e.amount_minor` 读 —— transactions 表没有金额列（P22-2 §6）。
       ② 方向只从 `e.direction` 读，**绝不**用 `e.amount_minor < 0` 猜：
          canonical amount 是无符号的（P22-1 §8），靠符号判断会永远得到 0，
          而只喂正数的测试会是绿的。
       ③ "哪些 type 算消费"是**参数**（契约的 BUDGET_SPENDING_TYPES），
          不是在 SQL 里再写一遍 IN 列表。

       ── 为什么是 `direction = 'CREDIT'` 而不是 DEBIT（这一条是算出来的）
         WALLET 账户的 balance = Σ(DEBIT) − Σ(CREDIT)   （P22-2 §8.2）
       因此"钱从这个钱包出去"记成一条 **CREDIT**（余额减少），而增发
       （MINT）记成一条 DEBIT。也就是说：在这份账本里"花掉"与"增加"的
       方向**正好与直觉相反**。一个按"负数金额"或"DEBIT = 支出"写的实现
       会永远得到 0，并且看起来完全正常 —— 这正是 §14 要求按**冻结的
       transaction type** 判断、而不是按符号或方向直觉判断的原因。
       （实测：这条查询最初写成 DEBIT，于是所有消费窗口恒为 0，
       而除了"窗口应该是 120"之外的每一条断言都还是绿的。）

       还有一道**结构性**前提：一个钱包在它自己的币种上恰好有一个
       WALLET 账户。JS 侧用 countWalletAccounts 数一遍 —— 0 个意味着
       引用链断了，≥2 个意味着余额被劈成两半，那时任何求和都是错的。 */
    selectSpendingRows:
      'SELECT e.ledger_entry_id, e.transaction_id, e.account_id, e.direction, e.amount_minor, ' +
      '       e.currency AS entry_currency, e.created_at AS at, ' +
      '       t.tx_type, t.state AS tx_state, ' +
      '       a.kind AS account_kind, a.wallet_id AS account_wallet_id, a.currency AS account_currency ' +
      'FROM ' + ENTRIES_TABLE + ' e ' +
      'JOIN ' + TRANSACTIONS_TABLE + ' t ON t.transaction_id = e.transaction_id ' +
      'LEFT JOIN ' + ACCOUNTS_TABLE + ' a ON a.account_id = e.account_id ' +
      'WHERE e.account_id = ? ' +
      '  AND e.currency = ? ' +
      '  AND e.direction = \'CREDIT\' ' +
      '  AND e.created_at >= ? ' +
      'ORDER BY e.created_at ASC, e.ledger_entry_id ASC',
    /* 钱包的 WALLET 账户必须**恰好一个**：0 个意味着引用链断了，
       ≥2 个意味着余额被劈成两半而两边各自的账都平。两种情况都必须
       fail closed，因此它是一条被查询出来的前提，而不是一个假设。 */
    countWalletAccounts:
      'SELECT COUNT(*) AS c FROM ' + ACCOUNTS_TABLE + ' WHERE wallet_id=? AND currency=? AND kind=\'WALLET\'',

    /* ══ P22-5 · 货架（组织方式，不是价格事实）══════════════════════════
       §2 逐条点了名：不要把 priceMinor / currency / stock / owned /
       providerBalance 塞进 Store。因此这张表的列**恰好**是
       id + 呈现 + 状态 + 排序 + 记账元数据，一条经济事实都没有。
       sort_order 是展示顺序，它不参与任何判定 —— 因此它没有索引意义，
       也不允许出现"按 sort_order 决定能不能买"的写法。 */
    createStores:
      'CREATE TABLE IF NOT EXISTS ' + STORES_TABLE + ' (' +
      ' store_id TEXT PRIMARY KEY,' +
      ' name TEXT NOT NULL,' +
      ' description TEXT,' +
      ' status TEXT NOT NULL,' +
      ' sort_order INTEGER NOT NULL DEFAULT 0,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL' +
      ')',
    createStoresByStatus: 'CREATE INDEX IF NOT EXISTS idx_econ_stores_status ON ' + STORES_TABLE + ' (status, sort_order, store_id)',
    insertStore:
      'INSERT INTO ' + STORES_TABLE + ' (store_id, name, description, status, sort_order, idempotency_key, fingerprint, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectStore: 'SELECT * FROM ' + STORES_TABLE + ' WHERE store_id=?',
    selectStores: 'SELECT * FROM ' + STORES_TABLE + ' ORDER BY sort_order ASC, created_at ASC, store_id ASC LIMIT ?',
    selectStoresByStatus: 'SELECT * FROM ' + STORES_TABLE + ' WHERE status=? ORDER BY sort_order ASC, created_at ASC, store_id ASC LIMIT ?',
    selectStoresAll: 'SELECT * FROM ' + STORES_TABLE + ' ORDER BY created_at ASC, store_id ASC',
    countStores: 'SELECT COUNT(*) AS c FROM ' + STORES_TABLE,
    countStoresByStatus: 'SELECT COUNT(*) AS c FROM ' + STORES_TABLE + ' WHERE status=?',
    /* ── 货架的**唯一**写语句 ────────────────────────────────────────────
       SET 里没有 store_id（身份）与 created_at（出生时刻）。
       刻意**没有**任何 DELETE 语句：§23 要求"不得物理删除经济历史"，
       而下架由 status 表达。本文件里根本没有一条 DELETE FROM
       economy_stores —— 这不是纪律，是"那条语句不存在"。 */
    updateStore:
      'UPDATE ' + STORES_TABLE + ' SET name=?, description=?, status=?, sort_order=?, idempotency_key=?, fingerprint=?, revision=?, updated_at=? WHERE store_id=?',

    /* ══ P22-5 · 商品（价格与交付形态）══════════════════════════════════
       金额列叫 unit_price_minor 而不是 price：§3 禁止没有单位的金额字段，
       而 unit_price_minor + currency 两者一起才是价格。（§4 的检查把它与
       真实人民币域的字形彻底分开。）

       CHECK (unit_price_minor >= 0) / CHECK (grant_quantity >= 0) 是**结构
       约束**而不是注释：一个负价格是一次反向流动，它不应该只被 JS 层的
       一个 if 挡着。免费商品是合法的（0 是被允许的值，见契约 §22），
       因此这里用的是 >= 而不是 >。

       fulfillment 与 asset_kind 是**派生列**（由 kind 决定），但它们被写
       下来而不是每次推导：理由是 §27 —— "买完发生什么"必须与商品一起
       冻结，这样将来某个商品 kind 的映射变了，历史行仍然说着当时的话。
       asset_kind 允许 NULL：SERVICE_EXECUTION 的商品没有任何库存形态。 */
    createProducts:
      'CREATE TABLE IF NOT EXISTS ' + PRODUCTS_TABLE + ' (' +
      ' product_id TEXT PRIMARY KEY,' +
      ' store_id TEXT NOT NULL,' +
      ' product_kind TEXT NOT NULL,' +
      ' fulfillment TEXT NOT NULL,' +
      ' name TEXT NOT NULL,' +
      ' description TEXT,' +
      ' currency TEXT NOT NULL,' +
      ' unit_price_minor INTEGER NOT NULL CHECK (unit_price_minor >= 0),' +
      ' unit_name TEXT NOT NULL,' +
      ' grant_quantity INTEGER NOT NULL DEFAULT 0 CHECK (grant_quantity >= 0),' +
      ' asset_kind TEXT,' +
      ' status TEXT NOT NULL,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL' +
      ')',
    createProductsByStore: 'CREATE INDEX IF NOT EXISTS idx_econ_products_store ON ' + PRODUCTS_TABLE + ' (store_id, status, product_id)',
    createProductsByStatus: 'CREATE INDEX IF NOT EXISTS idx_econ_products_status ON ' + PRODUCTS_TABLE + ' (status, product_id)',
    createProductsByKind: 'CREATE INDEX IF NOT EXISTS idx_econ_products_kind ON ' + PRODUCTS_TABLE + ' (product_kind, status)',
    insertProduct:
      'INSERT INTO ' + PRODUCTS_TABLE + ' (product_id, store_id, product_kind, fulfillment, name, description, currency, unit_price_minor, unit_name, grant_quantity, asset_kind, status, idempotency_key, fingerprint, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectProduct: 'SELECT * FROM ' + PRODUCTS_TABLE + ' WHERE product_id=?',
    selectProducts: 'SELECT * FROM ' + PRODUCTS_TABLE + ' ORDER BY created_at ASC, product_id ASC LIMIT ?',
    /* ── 目录读取的**唯一**查询（§29 的最小过滤）────────────────────────
       四个过滤条件全部在 SQL 里，而不是"取一页再在 JS 里筛"。
       后者看起来等价，其实是**错的**：LIMIT 在过滤**之前**生效，于是
       `listProducts({storeId: X, status: 'ACTIVE', limit: 50})` 会在
       "X 的前 50 件商品"里挑出 ACTIVE 的几件 —— 而 X 明明有 200 件在卖。
       那种少返回不会报错，只会让调用方以为"就这么多"。
       `(? IS NULL OR col = ?)` 的写法让四个条件是同一个语句里的四组开关，
       于是"用哪条 SQL"不再是一个需要判断的问题（判断错了就是这个 bug）。 */
    selectProductsFiltered:
      'SELECT * FROM ' + PRODUCTS_TABLE + ' WHERE' +
      ' (? IS NULL OR store_id = ?)' +
      ' AND (? IS NULL OR status = ?)' +
      ' AND (? IS NULL OR product_kind = ?)' +
      ' AND (? IS NULL OR currency = ?)' +
      ' ORDER BY created_at ASC, product_id ASC LIMIT ?',
    selectProductsAll: 'SELECT * FROM ' + PRODUCTS_TABLE + ' ORDER BY created_at ASC, product_id ASC',
    countProducts: 'SELECT COUNT(*) AS c FROM ' + PRODUCTS_TABLE,
    countProductsByStatus: 'SELECT COUNT(*) AS c FROM ' + PRODUCTS_TABLE + ' WHERE status=?',
    /* ── 商品的**两条**写语句，各自只碰自己那一半（§8/§20/§9）───────────
       updateProduct 的 SET 里**没有** product_id / store_id /
       product_kind / fulfillment / asset_kind / created_at —— 前五个是
       "这件商品本体是什么"（改它们等于换了一件商品，正确形态是新建一个
       product，而不是改这个 id 的语义），最后一个是出生时刻。
       它也**没有** status：状态推进走下面那条带守卫的语句。

       于是一条很强的、可静态断言的性质成立了：
         · 改价格的语句里没有状态列；
         · 改状态的语句里没有价格列。
       "改价不得顺带改变上架状态"因此不是纪律，而是两条语句各自都做不到。 */
    updateProduct:
      'UPDATE ' + PRODUCTS_TABLE + ' SET name=?, description=?, currency=?, unit_price_minor=?, unit_name=?, grant_quantity=?, idempotency_key=?, fingerprint=?, revision=?, updated_at=? WHERE product_id=?',
    /* ── 商品状态推进（§9）───────────────────────────────────────────────
       只动状态列；`AND status=?` 同时承担乐观并发与**终态保护**
       （一个 RETIRED 的商品不可能再被 disable 或重新上架：changes=0
       ⇒ 调用点拒绝，而"RETIRED 是终态"因此在 SQL 层就成立）。 */
    setProductStatus:
      'UPDATE ' + PRODUCTS_TABLE + ' SET status=?, idempotency_key=?, fingerprint=?, revision=?, updated_at=? WHERE product_id=? AND status=?',

    /* ══ P22-5 · 库存（已发生的拥有事实）════════════════════════════════
       canonical 键是 UNIQUE (owner_id, product_id)：一个 owner 对一件商品
       **恰好一行**。§51 要求的"不能按 productId 全局扣库存"因此是结构性的
       —— 每一行都带着它的 owner，而所有写语句都以行 id（或 owner+product）
       为条件，没有任何一条按 product_id 单独更新。

       CHECK (quantity >= 0) 是**结构**保证：§16 要求"两个并发 consume
       不可能把数量扣成负数"，而即使事务纪律被将来某次重构破坏，这条
       CHECK 也会让那次写入**失败**而不是静默产生一个负库存。

       quantity = 0 的行**保留**（§23：优先 quantity = 0，保留行和审计）。
       因此本文件里没有 DELETE FROM economy_inventory。

       刻意**没有**的列：inventory_cached_quantity（§17：不要为了和 Wallet
       对称而人为造一个缓存再写 rebuild）、owned/stock/count 这类与 product
       重复的列、以及任何 serial/instanceId（唯一物品在本阶段不可表示，
       契约用 INVENTORY_UNIQUE_ITEMS_MODELLED = false 逐字否认）。 */
    createInventory:
      'CREATE TABLE IF NOT EXISTS ' + INVENTORY_TABLE + ' (' +
      ' inventory_entry_id TEXT PRIMARY KEY,' +
      ' owner_id TEXT NOT NULL,' +
      ' owner_type TEXT NOT NULL,' +
      ' product_id TEXT NOT NULL,' +
      ' asset_kind TEXT NOT NULL,' +
      ' quantity INTEGER NOT NULL CHECK (quantity >= 0),' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' UNIQUE (owner_id, product_id)' +
      ')',
    createInventoryByOwner: 'CREATE INDEX IF NOT EXISTS idx_econ_inventory_owner ON ' + INVENTORY_TABLE + ' (owner_id, asset_kind, product_id)',
    createInventoryByProduct: 'CREATE INDEX IF NOT EXISTS idx_econ_inventory_product ON ' + INVENTORY_TABLE + ' (product_id)',
    insertInventory:
      'INSERT INTO ' + INVENTORY_TABLE + ' (inventory_entry_id, owner_id, owner_type, product_id, asset_kind, quantity, idempotency_key, fingerprint, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectInventoryEntry: 'SELECT * FROM ' + INVENTORY_TABLE + ' WHERE inventory_entry_id=?',
    selectInventoryByOwnerProduct: 'SELECT * FROM ' + INVENTORY_TABLE + ' WHERE owner_id=? AND product_id=?',
    /* 与 selectProductsFiltered 同款：三个过滤条件全部在 SQL 里，
       LIMIT 在过滤**之后**生效。附加的一条：owner 或 product 至少给一个，
       那个规则在 JS 里判（它是一条**业务**规则，不是一条查询形状）。 */
    selectInventoryFiltered:
      'SELECT * FROM ' + INVENTORY_TABLE + ' WHERE' +
      ' (? IS NULL OR owner_id = ?)' +
      ' AND (? IS NULL OR product_id = ?)' +
      ' AND (? IS NULL OR asset_kind = ?)' +
      ' ORDER BY asset_kind ASC, product_id ASC LIMIT ?',
    selectInventoryAll: 'SELECT * FROM ' + INVENTORY_TABLE + ' ORDER BY created_at ASC, inventory_entry_id ASC',
    countInventory: 'SELECT COUNT(*) AS c FROM ' + INVENTORY_TABLE,
    countInventoryByAssetKind: 'SELECT COUNT(*) AS c FROM ' + INVENTORY_TABLE + ' WHERE asset_kind=?',
    sumInventoryQuantity: 'SELECT COALESCE(SUM(quantity), 0) AS total FROM ' + INVENTORY_TABLE,
    /* ── 库存的两条写语句，各自带一条**算术守卫** ────────────────────────
       grow  ：`quantity + ? <= <上界>` —— 溢出被 SQL 拒绝，而不是让
               JS 静默地把一个不精确的数写进去。
       shrink：`quantity >= ?` —— 这一条是**第二道**防线（第一道是
               BEGIN IMMEDIATE 里的 canonical 读 + 校验，第三道是表上的
               CHECK）。三道同时存在是有意的：§16 要求的"不可能为负"
               不该只依赖某一个机制的正确性。
       两条语句的 SET 都**只**碰 quantity 与记账元数据 —— owner / product /
       asset_kind / created_at 一次都不出现。 */
    growInventory:
      'UPDATE ' + INVENTORY_TABLE + ' SET quantity = quantity + ?, idempotency_key=?, fingerprint=?, revision=?, updated_at=? WHERE inventory_entry_id=? AND quantity + ? <= ?',
    shrinkInventory:
      'UPDATE ' + INVENTORY_TABLE + ' SET quantity = quantity - ?, idempotency_key=?, fingerprint=?, revision=?, updated_at=? WHERE inventory_entry_id=? AND quantity >= ?',
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
      /* ── P22-3：水位检查被**提到最前面** ──────────────────────────────
         之前是"建完所有表再查水位"。那时 SCHEMA_TOO_NEW 的库上已经悄悄
         多出了几张空表 —— 而 L9 的断言是"拒绝是只读的，不尝试修复"。
         把 meta + 水位放在**任何其它 DDL 之前**之后，那句话才在字面上
         也成立（见 P22-3 测试的 M 组：被拒绝的库上连 economy_reservations
         都不会被创建）。 */
      db.exec(SQL.createMeta);
      migrateSchema();
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
      /* P22-3 的三张表。它们对旧库来说是**新增**的（schema 1 → 2），
         CREATE TABLE IF NOT EXISTS 让"补表"成为幂等操作，而 1 → 2
         没有任何既有数据需要改写（MIGRATIONS 里那条注释说明为什么它是空的）。 */
      db.exec(SQL.createOperations);
      db.exec(SQL.createOperationsByWallet);
      db.exec(SQL.createOperationsByStatus);
      db.exec(SQL.createOperationsByReservation);
      db.exec(SQL.createOperationsByKey);
      db.exec(SQL.createReservations);
      db.exec(SQL.createReservationsByWalletStatus);
      db.exec(SQL.createReservationsByOperation);
      db.exec(SQL.createReservationsByExpiry);
      db.exec(SQL.createReservationsByTransaction);
      db.exec(SQL.createOperationIdempotency);
      db.exec(SQL.createOperationIdempotencyByOp);
      db.exec(SQL.createOperationIdempotencyByAt);
      /* P22-4 的两张表（schema 2 → 3）。同样只有新表，没有既有列改写。 */
      db.exec(SQL.createBudgetPolicies);
      db.exec(SQL.createBudgetPoliciesByStatus);
      db.exec(SQL.createBudgetPoliciesByTerm);
      db.exec(SQL.createQuotes);
      db.exec(SQL.createQuotesByBuyer);
      db.exec(SQL.createQuotesByProduct);
      db.exec(SQL.createQuotesByExpiry);
      db.exec(SQL.createQuotesByPredecessor);
      /* P22-5 的三张表（schema 3 → 4）。同样只有新表，没有既有列改写。
         注意它们的 DDL 排在 migrateSchema() **之后** —— 那条纪律在
         P22-3 就被提到最前面（见上面的说明），P22-5 只是继续遵守它：
         一个 SCHEMA_TOO_NEW 的库上不能悄悄多出这三张空表。 */
      db.exec(SQL.createStores);
      db.exec(SQL.createStoresByStatus);
      db.exec(SQL.createProducts);
      db.exec(SQL.createProductsByStore);
      db.exec(SQL.createProductsByStatus);
      db.exec(SQL.createProductsByKind);
      db.exec(SQL.createInventory);
      db.exec(SQL.createInventoryByOwner);
      db.exec(SQL.createInventoryByProduct);
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
    /* ── P22-3 · 开库时的预留一致性对账 ─────────────────────────────────
       与 P22-2 的"余额从 ledger 重建"同一纪律，只是对象换成了
       reserved：**canonical 是 active reservation 行，缓存是派生量**。

       为什么必须是 open() 的一部分，而不是"等第一次读的时候再说"：
       reserved 缓存被改坏而没人发现，等于把已经锁定的钱重新变成可花的钱
       ——那正是 P22-0 R5 的同一个根因换了个字段。因此每次建立权威时
       都对一次账。

       三种结局刻意分开（见 reconcileReservations）：
         · 缓存一致          → 什么都不做（**不消耗 revision**）；
         · 缓存漂移          → 从 canonical 重建 + 一条 RESERVATION_REBUILT；
         · 结构损坏 / 读不了 → DEGRADED（fail closed），**绝不**当成 0。
       对账失败本身不阻断 open：库是开着的、账本是好的，只是"预留这一面
       不可信"——把它说成"打不开"会让整个 Economy 消失，那是更大的谎。 */
    let reconciled = null;
    try {
      reconciled = reconcileReservations({ at: lastOpenedAt });
    } catch (error) {
      degrade('reservation-reconcile-failed:' + String(error && (error.code || error.message)));
      reconciled = { ok: false, errors: ['reservation-reconcile-failed'] };
    }
    logger('economy-opened', {
      file: dbFile,
      schemaVersion: ECONOMY_SCHEMA_VERSION,
      revision: getRevision(),
      wallets: countWallets(),
      transactions: countTransactions(),
      entries: countEntries(),
      operations: countOperations(),
      reservations: countReservations(),
      activeReservations: countReservationsByStatus(C.RESERVATION_STATE.ACTIVE),
      reservationsReconciled: !!(reconciled && reconciled.ok === true),
      reservationRepairs: (reconciled && reconciled.repaired && reconciled.repaired.length) || 0
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
    /* from → to。空数组是**刻意**的，而且现在它有两层含义：
         · 版本 1 是初版（P22-2），没有更早的版本需要迁移；
         · 1 → 2（P22-3）只**多**了三张表，没有任何既有列或既有数据
           需要改写（DDL 用 CREATE TABLE IF NOT EXISTS 补表即可）。
       框架存在而内容为空是有意的：框架本身要有测试（P22-2 store 测试的
       L 组），否则第一次真的需要迁移时才发现它从来没跑过。
       于是"这一步没有数据迁移"这件事本身也被断言了 —— 而且现在是被
       **两代**迁移各自断言一次（P22-3 的 M 组、P22-4 的 N 组）。
       2 → 3（P22-4）只**多**了两张表（budget policies / quotes），
       同样没有任何既有列或既有数据需要改写。
        3 → 4（P22-5）只**多**了三张表（stores / products / inventory），
       同样没有任何既有列或既有数据需要改写 —— 尤其是 quotes 表：
       P22-5 给它加了**零**列，因为 P22-4 已经把"什么 / 多少钱 / 到什么
       时候"那几列冻结齐了，再加一列只会制造第二个价格来源。 */
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

  /* ── 钱包的**结构**完整性（引用链）───────────────────────────────────
     这三条必须在任何"算余额"之前成立。没有它们的话，"账户行被删掉"
     会静默变成一个**零余额**：computeLedgerBalance 对一个不存在的账户
     求和得到 0，于是"我不知道这个钱包有多少钱"被回答成"它有 0 元"——
     这正是 P22-0 R5 的同一个根因换了一个入口。
     P22-3 把这段抽出来，是因为**读路径**也要用它：一个"看起来很权威"
     的数字从一条断掉的引用链上算出来，比一句"我不知道"危险得多。 */
  function walletStructuralProblems(wallet) {
    const structural = [];
    if (!wallet) return ['wallet-row-missing'];
    const account = db.prepare(SQL.selectAccount).get(String(wallet.account_id));
    if (!account) structural.push('account-row-missing');
    else {
      if (String(account.kind) !== C.ACCOUNT_KIND.WALLET) structural.push('account-kind-is-not-wallet');
      if (account.wallet_id == null || String(account.wallet_id) !== String(wallet.wallet_id)) {
        structural.push('account-does-not-point-back-to-this-wallet');
      }
      if (String(account.currency) !== String(wallet.currency)) {
        structural.push('account-currency-differs-from-wallet-currency');
      }
    }
    return structural;
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
    const structural = walletStructuralProblems(wallet);
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

  /* ── 钱包的对外视图（P22-3 §7 的落点）────────────────────────────────
     available 的两个输入都是 **canonical**：
       ledgerBalance   ← ledger entries 求和
       reservedBalance ← ACTIVE reservations 求和
     不是 `cached − cachedReserved`。P22-2 的读路径用的是缓存；P22-3 把它
     收到 canonical，理由写在这里而不是藏在 diff 里：一旦 reserved 这一
     层存在，"用缓存算 available"就等于允许一个被改坏的缓存**直接决定
     能不能花钱**。于是现在的语义是：
       · available 永远是"从事实算出来的"（读路径也要做完整性检查）；
       · 缓存列照实报告，并且带一个 `cachedBalanceDrifted` /
         `reservedCacheDrifted` 标记 —— 漂移可见、可修（?rebuild=1 /
         rebuildReservedBalance），但它**不可能**再去影响那个数字。
     代价是每次读多几次小查询（都在索引上）。这是刻意的交换：一个
     便宜的错数比一个贵一点的对数危险得多。 */
  function rowToWalletView(row, options) {
    options = options || {};
    let st = walletStateOfRow(row);
    const cacheCached = st.state === C.WALLET_STATE.READY
      ? fromSqlAmount(row.cached_balance_minor, 'cached-balance') : null;
    const cacheReserved = st.state === C.WALLET_STATE.READY
      ? fromSqlAmount(row.reserved_balance_minor, 'reserved-balance') : null;
    let ledgerMinor = cacheCached;
    let reservedMinor = cacheReserved;
    if (st.state === C.WALLET_STATE.READY) {
      const availability = walletAvailability(row);
      if (!availability.ok) {
        /* 完整性事故 ⇒ DEGRADED ⇒ available 变 null。**不是** 0。 */
        degrade('wallet-integrity:' + availability.problems.join(','));
        st = walletStateOfRow(row);
      } else {
        ledgerMinor = availability.ledgerMinor;
        reservedMinor = availability.reservedMinor;
      }
    }
    const ready = st.state === C.WALLET_STATE.READY;
    /* 只有 READY 才去读缓存列。COLD / DEGRADED 下连读都不读 —— 读出来
       再"记得别用"是注释级保证，而不是结构级保证。 */
    const cached = ready ? ledgerMinor : 0n;
    const reserved = ready ? reservedMinor : 0n;
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
        currency: row.currency,
        /* 不可信时这些**全部**是 null —— 一个也不行。让"未知"在结构上
           没有别的表示方式，是 P22-0 R5 之后这一域唯一可接受的形状。 */
        cachedBalanceMinor: null,
        ledgerBalanceMinor: null,
        reservedBalanceCachedMinor: null,
        cachedBalanceDrifted: null,
        reservedCacheDrifted: null
      });
    }
    return Object.assign({}, made.wallet, {
      walletId: String(row.wallet_id),
      owner: { type: String(row.owner_type), id: String(row.owner_id) },
      accountId: String(row.account_id),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      degradedReason: ready ? null : (st.reason || null),
      /* cachedBalanceMinor 保持 P22-2 的含义：**缓存里那个数**。
         它是可观测的派生量，不是 available 的输入。 */
      cachedBalanceMinor: ready ? cacheCached : null,
      ledgerBalanceMinor: ready ? ledgerMinor : null,
      reservedBalanceCachedMinor: ready ? cacheReserved : null,
      cachedBalanceDrifted: ready ? (cacheCached !== ledgerMinor) : null,
      reservedCacheDrifted: ready ? (cacheReserved !== reservedMinor) : null
    });
  }

  /* ── 对外 JSON 形态：金额一律**十进制字符串**（契约 §3）──────────────
     不在这里用 JSON.stringify —— BigInt 会让它抛错，而"抛错"的下一步
     往往是被某个 catch 兜住然后静默变成别的东西。

     P22-3 加了三个字段，它们各自回答一个不同的问题：
       cachedBalanceMinor        派生缓存里那个数（= 上次写进去的）
       ledgerBalanceMinor        canonical（available 的基数）
       reservedBalanceMinor      canonical active reservations 之和
       reservedBalanceCachedMinor 派生缓存里那个 reserved
       cachedBalanceDrifted / reservedCacheDrifted  缓存是否已经与事实不符
     "漂移"这件事必须是**可见**的：看不见的漂移就是下一次经济错误的种子。 */
  function serializeWallet(view, options) {
    options = options || {};
    const ready = view.state === C.WALLET_STATE.READY;
    const out = {
      domain: view.domain,
      walletId: view.walletId,
      owner: view.owner,
      currency: view.currency,
      accountId: view.accountId,
      state: view.state,
      balanceKnown: view.balanceKnown,
      cachedBalanceMinor: ready ? C.serializeAmountMinor(view.cachedBalanceMinor) : null,
      ledgerBalanceMinor: ready ? C.serializeAmountMinor(view.ledgerBalanceMinor) : null,
      reservedBalanceMinor: ready ? C.serializeAmountMinor(view.reservedBalanceMinor) : null,
      reservedBalanceCachedMinor: ready ? C.serializeAmountMinor(view.reservedBalanceCachedMinor) : null,
      cachedBalanceDrifted: ready ? view.cachedBalanceDrifted === true : null,
      reservedCacheDrifted: ready ? view.reservedCacheDrifted === true : null,
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

     ── 为什么分成 InTx 事务体 + 公开 wrapper（P22-3）──────────────────
     P22-3 的 commitReservation 要求"ledger transaction 与 reservation
     状态变化处于**同一个** SQLite atomic boundary"（P22-3 §10）。SQLite
     不允许嵌套 BEGIN，因此 commitReservation 不能从自己的事务里调用一个
     会自己 BEGIN 的函数。拆法刻意是**最薄**的：
       · commitLedgerTransactionInTx = 校验 + 幂等闸门 + 事务体（不 BEGIN）；
       · commitLedgerTransaction     = withTransaction(它) + 提交后清理与日志。
     两半的**语义完全不变**：公开出口的行为与 P22-2 逐字相同（校验与幂等
     查询仍在写任何东西之前，idempotency 行仍与事实同事务）。
     唯一的形状差异是"清理 + 日志"移到了 wrapper —— 这一步只有在真的
     提交之后才允许发生，而嵌套调用点还没提交。
     */
  function commitLedgerTransactionInTx(spec) {
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
    /* 事务体。**不再自己 BEGIN** —— 见函数头说明：它既要能被公开出口包在
       withTransaction 里，也要能被 commitReservation 放进**它自己的**
       事务里（那样 ledger 与 reservation 才共享一个 atomic boundary）。 */
    const body = () => {
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
    };
    body();

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

  /* ── commitLedgerTransaction（公开出口）──────────────────────────────
     它只做三件事：开一个事务、跑上面那个事务体、在**提交之后**才清理
     幂等表并记日志。把 prune/logger 放在 wrapper 而不是事务体里，是因为
     P22-3 会从**外层**事务调用事务体（见 commitReservation）——那时
     "提交了"这句话还没成立，先记一条 economy-transaction-committed
     会在外层回滚时变成一条假日志。 */
  function commitLedgerTransaction(spec) {
    requireOpen();
    const out = withTransaction(() => commitLedgerTransactionInTx(spec));
    if (out.ok === true && out.replayed === false) {
      pruneIdempotency(clock());
      logger('economy-transaction-committed', {
        transactionId: out.transactionId,
        type: out.result.transactionType,
        revision: out.result.revision,
        entries: out.result.entries.length,
        wallets: out.result.wallets.length
      });
    }
    return out;
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

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · 拒绝 / 拒绝的**形状**
     ══════════════════════════════════════════════════════════════════ */

  /* 资金被还回去的**原因**见模块顶部的 RELEASE_REASON（封闭集合）。
     它写进行里，也写进 change log。 */

  /* ── 业务拒绝的形状 ────────────────────────────────────────────────
     与 P22-2 的 `{ok:false, errors:[...]}` 兼容（多两个字段），并且
     reasonCode 一定来自契约的**封闭** DENY_REASON 集合。这一点是刻意的：
     "为什么买不成"必须是机器可判的稳定代码，而不是一句自由文本。
     denied=false 的那些失败（wallet-not-found / reservation-not-found /
     idempotency-conflict）刻意**不**带 reasonCode —— 它们不是"业务被拒"，
     而是"这个请求本身不成立"，把两者混成一个字段会让审计失真。 */
  function denial(reasonCode, errors, extra) {
    return Object.assign({
      ok: false,
      denied: true,
      reasonCode: String(reasonCode),
      errors: Array.isArray(errors) ? errors.map(String) : [String(errors)]
    }, extra || {});
  }

  /* 事务**内部**的拒绝：必须抛错才能让 withTransaction 回滚，因此这里把
     "被拒绝"编码成一个具名错误，由外层 catch 翻译回 denial。 */
  function refuse(reasonCode, errors, extra) {
    const err = new Error('economy-refused' + (reasonCode ? ':' + reasonCode : ''));
    err.code = 'ECONOMY_REFUSED';
    err.reasonCode = reasonCode == null ? null : String(reasonCode);
    err.errors = Array.isArray(errors) ? errors.map(String) : [String(errors == null ? 'refused' : errors)];
    err.extra = extra || null;
    return err;
  }
  function isRefusal(error) {
    return !!error && error.code === 'ECONOMY_REFUSED';
  }

  /* 所有入口的异常出口都走这里：具名拒绝 → denial；其它异常原样抛出
     （一个真正的 bug 不该被伪装成一次业务拒绝）。 */
  function translateRefusal(error) {
    if (!isRefusal(error)) return null;
    return error.reasonCode
      ? denial(error.reasonCode, error.errors, error.extra || undefined)
      : { ok: false, denied: false, reasonCode: null, errors: error.errors };
  }

  function parseJsonOrNull(raw) {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · canonical reserved 求和 / 完整性
     ══════════════════════════════════════════════════════════════════ */

  /* reservedBalance 的**唯一**算术入口：ACTIVE 行的 amount 之和。
     与 ledger 的 sumDebit/sumCredit 同款 —— 先求和，再把和写进缓存。
     本函数**不读缓存**，因此"缓存是派生量"这句话是可执行的。 */
  function computeReservedBalance(walletId) {
    const row = db.prepare(SQL.sumActiveReserved).get(String(walletId));
    return {
      reservedMinor: fromSqlAmount((row && row.total) || 0, 'reserved-total'),
      activeCount: Number((row && row.n) || 0)
    };
  }

  /* operation 与 reservation 的状态是否指的是同一件事。
     前四个状态由契约的 RESERVATION_STATE_OF_OPERATION 给出（那份映射是
     数据）；FAILED / CREATED 在契约里刻意是 null（它们没有属于自己的
     预留状态），这里补上**运行时**的唯一合法解释：
       FAILED  → 钱必须已经还回去了 → RELEASED
       CREATED → 还没有预留这回事 → 不匹配任何已落库的行 */
  function operationAgreesWithReservation(operationStatus, reservationStatus) {
    const op = String(operationStatus);
    const res = String(reservationStatus);
    const expected = C.RESERVATION_STATE_OF_OPERATION[op];
    if (expected != null) return expected === res;
    if (op === C.TX_STATE.FAILED) return res === C.RESERVATION_STATE.RELEASED;
    return false;
  }

  /* 一个钱包的预留行是否**结构上**可信。任何一条不成立都意味着
     "reserved 这个数不可信"，而不可信必须回答 null，不能回答 0 ——
     这正是 P22-0 R5 的教训换到了 reserved 字段上。 */
  function reservationProblemsOf(walletRow, rows) {
    const problems = [];
    for (const r of rows) {
      const id = String(r.reservation_id);
      if (String(r.wallet_id) !== String(walletRow.wallet_id)) { problems.push(id + ':wallet-mismatch'); continue; }
      if (String(r.currency) !== String(walletRow.currency)) { problems.push(id + ':currency-differs-from-wallet'); continue; }
      if (C.RESERVATION_STATES.indexOf(String(r.status)) < 0) { problems.push(id + ':status-not-in-closed-set'); continue; }
      let amount = null;
      try { amount = fromSqlAmount(r.amount_minor, 'reservation-amount'); }
      catch (error) { problems.push(id + ':amount-not-canonical'); continue; }
      if (amount === 0n) { problems.push(id + ':zero-amount-reservation'); continue; }
      const op = db.prepare(SQL.selectOperation).get(String(r.operation_id));
      if (!op) { problems.push(id + ':operation-row-missing'); continue; }
      if (String(op.reservation_id == null ? '' : op.reservation_id) !== id) {
        problems.push(id + ':operation-does-not-point-back-to-this-reservation'); continue;
      }
      if (C.TX_STATES.indexOf(String(op.status)) < 0) { problems.push(id + ':operation-status-not-in-closed-set'); continue; }
      if (!operationAgreesWithReservation(op.status, r.status)) {
        problems.push(id + ':operation-and-reservation-disagree'); continue;
      }
      if (String(r.status) === C.RESERVATION_STATE.COMMITTED) {
        if (r.transaction_id == null) { problems.push(id + ':committed-without-a-ledger-transaction'); continue; }
        if (!db.prepare(SQL.selectTransaction).get(String(r.transaction_id))) {
          problems.push(id + ':committed-ledger-transaction-missing'); continue;
        }
      } else if (r.transaction_id != null) {
        /* 未成交的预留**不可能**指向一笔 ledger transaction：reserve /
           release / expire / fail 都不写 ledger（P22-3 §12/§13）。 */
        problems.push(id + ':not-committed-but-claims-a-ledger-transaction');
        continue;
      }
      if (String(r.status) === C.RESERVATION_STATE.ACTIVE && r.expires_at != null) {
        if (!Number.isSafeInteger(Number(r.expires_at)) || Number(r.expires_at) < 0) {
          problems.push(id + ':expires-at-not-a-non-negative-safe-integer');
        }
      }
    }
    return problems;
  }

  /* 一个钱包此刻的**可用**余额。三个输入全部 canonical：
       ledgerBalance（从 entries 求和）
       reservedBalance（从 ACTIVE reservations 求和）
       结构完整性（账户引用链 + 每一条预留行 + 每一条 operation）
     任何一不成立都返回 ok:false ⇒ 调用方必须 fail closed（null，不是 0）。
     为什么读路径也要做完整性检查：一个"看起来权威"的数字从一条断掉的
     引用链上算出来，比一句"我不知道"危险得多。 */
  function walletAvailability(walletRow) {
    const structural = walletStructuralProblems(walletRow);
    if (structural.length) return { ok: false, problems: structural };
    let derived = null;
    try { derived = computeLedgerBalance(walletRow.account_id, walletRow.currency); }
    catch (error) {
      return { ok: false, problems: ['ledger-read-failed:' + String(error && (error.code || error.message))] };
    }
    const rows = db.prepare(SQL.selectReservationsByWalletAll).all(String(walletRow.wallet_id));
    const problems = reservationProblemsOf(walletRow, rows);
    if (problems.length) return { ok: false, problems: problems };
    /* ── 求和**只有一处定义**（computeReservedBalance 的那条 SQL）───────
       这里刻意不再用 `let reserved = 0n; … reserved += …` 在 JS 里重算
       一遍：同一个量有两个实现就必然有两个答案，而且 `reserved +=` 正是
       P22-3 §22 点名要禁掉的形状。禁掉它的正确方式不是给这条规则开一个
       "本地累加不算"的例外（例外会让规则在下一个读者手里失效），
       而是让那段代码根本不存在。 */
    const sum = computeReservedBalance(String(walletRow.wallet_id));
    if (sum.reservedMinor > derived.balanceMinor) {
      /* 不变量被破坏：被锁定的钱超过了账本上的钱。这不是一次可修复的
         漂移，而是"两个数里有一个是错的，而我们不知道该改哪一个"。 */
      return { ok: false, problems: ['active-reservations-exceed-ledger-balance'] };
    }
    return {
      ok: true,
      ledgerMinor: derived.balanceMinor,
      reservedMinor: sum.reservedMinor,
      activeReservations: sum.activeCount,
      reservationRows: rows.length
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · operation / reservation 的行 ↔ DTO
     ══════════════════════════════════════════════════════════════════ */

  function rowToOperation(row) {
    return {
      domain: C.DOMAIN,
      operationId: String(row.operation_id),
      status: String(row.status),
      terminal: C.TX_TERMINAL_STATES.indexOf(String(row.status)) >= 0,
      walletId: String(row.wallet_id),
      currency: String(row.currency),
      amountMinor: fromSqlAmount(row.amount_minor, 'operation-amount'),
      reservationId: row.reservation_id == null ? null : String(row.reservation_id),
      transactionId: row.transaction_id == null ? null : String(row.transaction_id),
      idempotencyKey: String(row.idempotency_key),
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      reasonCode: row.reason_code == null ? null : String(row.reason_code),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  function rowToReservation(row, operationRow) {
    const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
    /* "到期了没有"是**比较**出来的，不是某个定时器说出来的：进程关机
       两小时再起来，这个比较依然成立（P22-3 §14）。 */
    const expiredByTime = expiresAt != null && Number.isFinite(expiresAt) && expiresAt <= clock();
    const state = String(row.status);
    return {
      domain: C.DOMAIN,
      reservationId: String(row.reservation_id),
      operationId: String(row.operation_id),
      walletId: String(row.wallet_id),
      currency: String(row.currency),
      amountMinor: fromSqlAmount(row.amount_minor, 'reservation-amount'),
      state: state,
      terminal: C.RESERVATION_TERMINAL_STATES.indexOf(state) >= 0,
      idempotencyKey: String(row.idempotency_key),
      expiresAt: expiresAt,
      expiredByTime: expiredByTime,
      sweepableNow: expiredByTime && state === C.RESERVATION_STATE.ACTIVE,
      transactionId: row.transaction_id == null ? null : String(row.transaction_id),
      releaseReason: row.release_reason == null ? null : String(row.release_reason),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      operation: operationRow ? {
        operationId: String(operationRow.operation_id),
        status: String(operationRow.status),
        terminal: C.TX_TERMINAL_STATES.indexOf(String(operationRow.status)) >= 0,
        transactionId: operationRow.transaction_id == null ? null : String(operationRow.transaction_id),
        reasonCode: operationRow.reason_code == null ? null : String(operationRow.reason_code)
      } : null
    };
  }

  /* ── 对外 JSON 形态：金额一律十进制字符串，**且刻意不含 idempotencyKey**
     幂等键是调用方的请求标识：把它放进 HTTP 响应，等于让任何一个能读
     经济状态的人看到别人用过哪些请求 id。它不是秘密，但它也不需要被
     广播 —— 少一个字段就少一类可被关联的痕迹。 */
  function serializeReservation(view) {
    return {
      domain: view.domain,
      reservationId: view.reservationId,
      operationId: view.operationId,
      walletId: view.walletId,
      currency: view.currency,
      state: view.state,
      terminal: view.terminal === true,
      amountMinor: C.serializeAmountMinor(view.amountMinor),
      expiresAt: view.expiresAt,
      expiredByTime: view.expiredByTime === true,
      sweepableNow: view.sweepableNow === true,
      transactionId: view.transactionId,
      releaseReason: view.releaseReason,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      operation: view.operation
    };
  }

  function serializeOperation(view) {
    return {
      domain: view.domain,
      operationId: view.operationId,
      status: view.status,
      terminal: view.terminal === true,
      walletId: view.walletId,
      currency: view.currency,
      amountMinor: C.serializeAmountMinor(view.amountMinor),
      reservationId: view.reservationId,
      transactionId: view.transactionId,
      expiresAt: view.expiresAt,
      reasonCode: view.reasonCode,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · 操作级幂等（scope + key）
     ══════════════════════════════════════════════════════════════════ */

  /* 请求的**确定性身份**。只覆盖"这次业务是什么"：
     刻意不含任何**生成的** id（operationId / reservationId / transactionId
     都是执行时才知道的东西），否则"同一个请求重放"会因为新生成的 id
     而得到不同的指纹 —— 幂等性会在重试路径上静默失效（P22-2 §14 的
     第一条要防的正是这件事）。 */
  function operationFingerprint(scope, payload) {
    return fingerprintOf(stableStringify({ scope: String(scope), request: payload }));
  }

  function operationIdempotencyLookup(scope, key, fingerprint) {
    const row = db.prepare(SQL.selectOperationIdempotency).get(String(scope), String(key));
    if (!row) return { found: false, conflict: false, row: null, result: null };
    if (String(row.fingerprint) !== String(fingerprint)) {
      return { found: true, conflict: true, row: row, result: null };
    }
    return { found: true, conflict: false, row: row, result: parseJsonOrNull(row.result_json) };
  }

  function operationIdempotencyConflict(scope, key, seen) {
    return {
      ok: false,
      denied: false,
      errors: ['IDEMPOTENCY_CONFLICT'],
      scope: String(scope),
      idempotencyKey: String(key),
      detail: 'the same idempotency key was used with a different request in this scope',
      recordedReservationId: seen && seen.row && seen.row.reservation_id != null ? String(seen.row.reservation_id) : null,
      recordedOperationId: seen && seen.row && seen.row.operation_id != null ? String(seen.row.operation_id) : null
    };
  }

  /* 写一条幂等记录。**为什么不是裸 INSERT**：P22-4 加上了两种"目标行
     可以被重建"的 mutation —— 政策（自然键是 owner_id）与报价
     （自然键是 quote_id，且可以由调用方显式指定，就像 reserve 可以指定
     reservationId）。那意味着"同一个 key 在清理窗口之后重试"可能撞上
     一条已经存在的幂等行。裸 INSERT 会在那种情况下抛出一个 UNIQUE 约束
     异常 —— 那是**崩溃**，不是拒绝，而且它把一次无害的重试变成了 500。

     ON CONFLICT DO NOTHING 让"保留先到的那一条"成为一条确定的规则：
     幂等记录是**第一次**执行的证据，后来的重试没有权力覆盖它。
     这不放松任何东西 —— 真正需要的重放路径早就在这个函数**之前**
     由 operationIdempotencyLookup 返回了（`replayed: true`），
     而指纹不同则在那之前被判为 IDEMPOTENCY_CONFLICT。 */
  function writeOperationIdempotency(scope, key, fingerprint, ids, result, revision, at) {
    db.prepare(SQL.insertOperationIdempotency).run(
      String(scope), String(key), String(fingerprint),
      ids.operationId == null ? null : String(ids.operationId),
      ids.reservationId == null ? null : String(ids.reservationId),
      ids.transactionId == null ? null : String(ids.transactionId),
      JSON.stringify(result), Number(revision), Number(at)
    );
  }

  function pruneOperationIdempotency(now) {
    if (!isOpen()) return;
    try {
      db.prepare(SQL.pruneOperationIdempotency).run(Number(now) - IDEMPOTENCY_TTL_MS);
      const count = Number((db.prepare(SQL.countOperationIdempotency).get() || {}).c || 0);
      if (count > IDEMPOTENCY_MAX) {
        const oldest = db.prepare(SQL.oldestOperationIdempotency).all(count - IDEMPOTENCY_MAX);
        for (const row of oldest) db.prepare(SQL.deleteOperationIdempotency).run(String(row.scope), String(row.idempotency_key));
      }
    } catch (_) { /* 清理失败不影响已提交的事实 */ }
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · reserveFunds（资金锁定）
     ══════════════════════════════════════════════════════════════════ */

  function findWalletRowBy(input, currency) {
    const o = input || {};
    if (o.walletId != null && String(o.walletId).trim() !== '') {
      return db.prepare(SQL.selectWallet).get(String(o.walletId));
    }
    if (o.ownerId != null && String(o.ownerId).trim() !== '') {
      return db.prepare(SQL.selectWalletByOwner).get(String(o.ownerId), String(currency));
    }
    return null;
  }

  /* expiresAt 必须由调用方**显式**给出一个绝对毫秒时间戳：
     刻意不提供 ttlMs 便利 —— 一个相对时长会让"这次请求是什么"依赖于
     读时钟的那一刻，于是同一请求的两次重放会算出两个不同的 expiresAt，
     指纹随之不同，幂等性在最需要它的重试路径上失效。绝对时间戳让
     "这次请求"在数据上就是确定的（P22-3 §14「明确 timestamp
     representation」）。 */
  function normalizeExpiresAt(value) {
    if (value == null) return { ok: false, errors: ['reservation-expires-at-required'] };
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, errors: ['reservation-expires-at-not-a-number'] };
    if (!Number.isSafeInteger(n)) return { ok: false, errors: ['reservation-expires-at-not-a-safe-integer'] };
    if (n < 0) return { ok: false, errors: ['reservation-expires-at-negative'] };
    return { ok: true, expiresAt: n };
  }

  /* ── reserveFunds（P22-3 §5/§8/§9）──────────────────────────────────
     一次 reserve 恰好一个 SQLite 事务：

       BEGIN IMMEDIATE
         validate（currency / amount / expiresAt / wallet / READY）
         recompute ledger balance      ← canonical
         recompute active reservations ← canonical
         check available >= amount
         insert operation (CREATED)
         transition CREATED → RESERVED（守卫：只有合法迁移）
         insert reservation (ACTIVE)
         update reserved cache ← Σ(ACTIVE)   （**求和**，不是 +=）
         append change log
         write idempotency
       COMMIT

     失败 → ROLLBACK。因此不存在"预留行在、缓存没变"或反过来的中间态。

     ── 为什么 CREATED 是一次真的写入，而不是跳过的中间步骤 ─────────────
     状态机的第一条边（CREATED → RESERVED）必须**被真正执行**，否则
     "CREATED 不能直接跳到 COMMITTED"这条规则从来没有在运行路径上被
     用过。做法是：先按 CREATED 插入，再用守卫语句推进到 RESERVED ——
     两步在同一个事务里，因此**外部永远观察不到 CREATED**（一个没有
     预留的操作不该存在）。故障注入点 after-operation-created 会证明
     这个中间态一旦落单就整体回滚（见测试的 J 组）。

     ── 为什么 deny 不落一条 FAILED 记录（§17）─────────────────────────
     余额不足是"这个请求没被接受"，不是"一次操作失败了"。造一条
     persisted FAILED 会把拒绝伪装成历史事实，并且会精确地消耗一个
     operationId。因此拒绝路径整体回滚，**什么都不留**。 */
  function reserveFunds(input) {
    requireOpen();
    const o = input || {};

    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return denial(C.DENY_REASON.INVALID_CURRENCY, cur.errors);
    const amt = C.normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) return denial(C.DENY_REASON.INVALID_AMOUNT, amt.errors);
    /* 0 金额的预留锁不住任何东西，却会占一条可以过期的行、消耗一个
       revision、并让"active reservations 有几笔"这个计数失去意义。
       契约允许 0（§3 的下界就是 0），运行层在这里收紧 —— 与 P22-2 拒绝
       0 金额 ledger transaction 是同一条纪律。 */
    if (amt.amountMinor === 0n) {
      return denial(C.DENY_REASON.INVALID_AMOUNT, ['reserve-amount-must-be-positive']);
    }
    const exp = normalizeExpiresAt(o.expiresAt);
    if (!exp.ok) return { ok: false, denied: false, reasonCode: null, errors: exp.errors };
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const now = clock();
    const walletRow = findWalletRowBy(o, cur.currency);
    if (!walletRow) return { ok: false, denied: false, reasonCode: null, errors: ['wallet-not-found'] };
    if (String(walletRow.currency) !== cur.currency) {
      return denial(C.DENY_REASON.INVALID_CURRENCY, ['wallet-currency-mismatch']);
    }

    const walletId = String(walletRow.wallet_id);
    const fingerprint = operationFingerprint(C.OPERATION_SCOPE.RESERVE, {
      walletId: walletId,
      currency: cur.currency,
      amountMinor: C.serializeAmountMinor(amt.amountMinor),
      expiresAt: exp.expiresAt
    });
    /* 幂等闸门排在"到期 / READY"检查**之前**：一次已经成功过的 reserve，
       它的重放必须在任何**当前**状态判定之前被识别出来。否则一个 TTL
       已经过去的预留会让同一次重试拿到"RESERVATION_EXPIRED"——
       而客户端问的是"我那次请求到底成没成"，答案已经在表里了。 */
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.RESERVE, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.RESERVE, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    if (exp.expiresAt <= now) {
      return denial(C.DENY_REASON.RESERVATION_EXPIRED,
        ['reserve-expires-at-is-not-in-the-future'], { expiresAt: exp.expiresAt, now: now });
    }
    const st = walletStateOfRow(walletRow);
    if (st.state !== C.WALLET_STATE.READY) {
      return denial(C.DENY_REASON.WALLET_NOT_READY, ['wallet-is-not-ready'],
        { walletState: st.state, walletStateReason: st.reason || null });
    }

    const operationId = o.operationId != null ? o.operationId : nextId('OPERATION');
    const reservationId = o.reservationId != null ? o.reservationId : nextId('RESERVATION');
    if (!C.isEconomyId('OPERATION', operationId)) return { ok: false, denied: false, reasonCode: null, errors: ['operation-id-not-canonical'] };
    if (!C.isEconomyId('RESERVATION', reservationId)) return { ok: false, denied: false, reasonCode: null, errors: ['reservation-id-not-canonical'] };

    const at = now;
    let committed = null;
    try {
      withTransaction(() => {
        /* ① 事务内重读：BEGIN IMMEDIATE 之后我们持有写锁，因此这一段
              看到的 ledger 与 reservations 不可能被另一个 writer 改动，
              而**检查与写入发生在同一个锁里**正是"两个同时 reserve
              不可能超订"的结构原因（不是靠 read-then-write 的运气）。 */
        const wallet = db.prepare(SQL.selectWallet).get(walletId);
        if (!wallet) throw refuse(null, ['wallet-not-found']);
        const walletState = walletStateOfRow(wallet);
        if (walletState.state !== C.WALLET_STATE.READY) {
          throw refuse(C.DENY_REASON.WALLET_NOT_READY, ['wallet-is-not-ready'], { walletState: walletState.state });
        }
        const availability = walletAvailability(wallet);
        if (!availability.ok) {
          degrade('reservation-integrity:' + availability.problems.join(','));
          throw refuse(C.DENY_REASON.WALLET_NOT_READY, ['wallet-integrity-failed'], { integrity: availability.problems });
        }
        const available = availability.ledgerMinor - availability.reservedMinor;
        if (available < amt.amountMinor) {
          throw refuse(C.DENY_REASON.INSUFFICIENT_AVAILABLE_BALANCE, ['insufficient-available-balance'], {
            ledgerBalanceMinor: C.serializeAmountMinor(availability.ledgerMinor),
            reservedBalanceMinor: C.serializeAmountMinor(availability.reservedMinor),
            availableBalanceMinor: C.serializeAmountMinor(available),
            requestedAmountMinor: C.serializeAmountMinor(amt.amountMinor)
          });
        }

        /* ── P22-4 §31：预算检查的**未来**落点，就在这个事务里面 ────────
           为什么必须在这里：§19 冻结的语义是"ALLOW at T1 不保证 ALLOW
           at T2"，因此任何"先前评估过、现在直接花"的做法都存在
           TOCTOU。真正执行的那一次必须在**同一个锁里**重新组装快照并
           重新评估 —— 那样"检查预算"与"锁住钱"之间不存在窗口。

           为什么缺省**不**强制（`enforceBudget` 未给时不检查）：这条
           reservation 路径是 P22-3 的冻结面，而"没有政策 ⇒ 拒绝一切"
           会改变 P22-3 已经冻结的行为（那些测试里没有政策，它们校验的是
           余额与锁定量）。因此强制是一个**显式**开关，由将来的 purchase
           流程（P22-5）打开；本阶段提供的是这个可以原子调用的接缝，
           而不是替 P22-5 决定它的语义。

           注意它**不是**在事务外评估然后传进来："组装 + 判定"都在这里
           发生，因此调用方没有机会把一个过期的 ALLOW 塞进来。 */
        if (o.enforceBudget === true) {
          const budgetPolicy = policyForOwner(String(wallet.owner_id));
          const budget = evaluateBudgetFor({
            ownerId: String(wallet.owner_id), currency: cur.currency, amountMinor: amt.amountMinor, now: at
          });
          if (budget.ok !== true || !budget.decision) {
            throw refuse(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, ['budget-evaluation-failed'], { systemFailure: true });
          }
          if (budget.decision.allowed !== true) {
            /* 两种 outcome 都走这条拒绝：DENY 是"规则不允许"，
               REQUIRE_APPROVAL 是"需要用户点头"—— 而 reserve 是**执行**，
               执行的前置条件是一个 ALLOW，不是一个待批准。把
               REQUIRE_APPROVAL 当成可以继续会让"审批"这一层消失。 */
            throw refuse(budget.decision.reasonCode, ['budget-does-not-allow-this-spend'], {
              outcome: budget.decision.outcome,
              priority: budget.decision.priority,
              policyId: budgetPolicy ? budgetPolicy.policyId : null,
              spentTodayMinor: budget.decision.spentTodayMinor,
              spentThisWeekMinor: budget.decision.spentThisWeekMinor,
              spentThisMonthMinor: budget.decision.spentThisMonthMinor,
              availableBalanceMinor: budget.decision.availableBalanceMinor,
              systemFailure: budget.decision.systemFailure === true
            });
          }
        }

        const revision = allocateRevision();

        /* ② operation 以 CREATED 落库（§4 的第一态）。 */
        faultPoint('after-reserve-validated');
        db.prepare(SQL.insertOperation).run(
          String(operationId), C.TX_STATE.CREATED, walletId, cur.currency,
          toSqlAmount(amt.amountMinor, 'reserve-amount'), null, null,
          key.key, fingerprint, Number(exp.expiresAt), null, Number(revision), Number(at), Number(at)
        );
        faultPoint('after-operation-created');

        /* ③ CREATED → RESERVED：**必须**经状态机，不是直接写终值。 */
        const gate = C.assertTransactionTransition(C.TX_STATE.CREATED, C.TX_STATE.RESERVED);
        if (!gate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, gate.errors);
        const movedOp = db.prepare(SQL.setOperationStatus).run(
          C.TX_STATE.RESERVED, String(reservationId), null, null,
          Number(revision), Number(at), String(operationId), C.TX_STATE.CREATED
        );
        if (Number(movedOp.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-transition-affected-no-row']);
        }
        faultPoint('after-operation-reserved');

        /* ④ reservation 以 ACTIVE 落库。契约 validateReservation 是唯一的
             形状判定（含 idempotencyKey 必填、expiresAt 必须是数字）。 */
        const shape = C.validateReservation({
          reservationId: String(reservationId),
          operationId: String(operationId),
          walletId: walletId,
          currency: cur.currency,
          amountMinor: amt.amountMinor,
          idempotencyKey: key.key,
          status: C.RESERVATION_STATE.ACTIVE,
          expiresAt: Number(exp.expiresAt)
        });
        if (!shape.ok) throw refuse(C.DENY_REASON.INVALID_AMOUNT, shape.errors);
        db.prepare(SQL.insertReservation).run(
          String(reservationId), String(operationId), walletId, cur.currency,
          toSqlAmount(amt.amountMinor, 'reserve-amount'), C.RESERVATION_STATE.ACTIVE,
          key.key, fingerprint, Number(exp.expiresAt), null, null,
          Number(revision), Number(at), Number(at)
        );
        faultPoint('after-reservation-insert');

        /* ⑤ reserved 缓存 ← Σ(ACTIVE)。此刻这一步必然会包含刚插入的那一行，
              因为求和发生在**写入之后**。 */
        const sum = applyReservedCache(walletId, revision, at);
        faultPoint('before-reserve-change-log');

        const result = {
          domain: C.DOMAIN,
          operationId: String(operationId),
          operationStatus: C.TX_STATE.RESERVED,
          reservationId: String(reservationId),
          reservationState: C.RESERVATION_STATE.ACTIVE,
          walletId: walletId,
          currency: cur.currency,
          amountMinor: C.serializeAmountMinor(amt.amountMinor),
          expiresAt: Number(exp.expiresAt),
          revision: Number(revision),
          at: Number(at),
          idempotencyKey: key.key,
          reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
          activeReservations: sum.activeCount
        };

        appendChange({
          revision: Number(revision), kind: C.EVENT_TYPE.RESERVATION_CREATED,
          entityId: String(reservationId), transactionId: null, walletId: walletId, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            operationId: String(operationId),
            reservationId: String(reservationId),
            reservationState: C.RESERVATION_STATE.ACTIVE,
            operationStatus: C.TX_STATE.RESERVED,
            amountMinor: C.serializeAmountMinor(amt.amountMinor),
            currency: cur.currency,
            expiresAt: Number(exp.expiresAt),
            reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
            activeReservations: sum.activeCount
          }
        });
        faultPoint('before-reserve-idempotency');

        writeOperationIdempotency(C.OPERATION_SCOPE.RESERVE, key.key, fingerprint, {
          operationId: String(operationId), reservationId: String(reservationId), transactionId: null
        }, result, revision, at);
        faultPoint('before-reserve-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger('economy-reservation-created', {
      reservationId: committed.reservationId,
      operationId: committed.operationId,
      walletId: committed.walletId,
      currency: committed.currency,
      revision: committed.revision,
      activeReservations: committed.activeReservations
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ── reserved 缓存 ← Σ(ACTIVE)（唯一写这条缓存的地方）────────────────
     它写的是**求和结果**，不是"在旧值上加"。因此不存在
     `reserved += amount` 这种形态 —— 那种形态正是 P22-3 §22 要禁掉的
     东西：一旦缓存可以增量更新，它就会漂移，而漂移的后果是"已经锁定的钱
     重新变成可花的钱"。
     顺带做一条真正的不变量检查：Σ(ACTIVE) 不允许超过 ledger 余额。 */
  function applyReservedCache(walletId, revision, at) {
    const wallet = db.prepare(SQL.selectWallet).get(String(walletId));
    if (!wallet) throw refuse(null, ['wallet-not-found']);
    const sum = computeReservedBalance(walletId);
    const ledger = computeLedgerBalance(wallet.account_id, wallet.currency).balanceMinor;
    if (sum.reservedMinor > ledger) {
      throw refuse(null, ['active-reservations-exceed-ledger-balance'], {
        reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
        ledgerBalanceMinor: C.serializeAmountMinor(ledger)
      });
    }
    db.prepare(SQL.setWalletReserved).run(
      toSqlAmount(sum.reservedMinor, 'derived-reserved'),
      Number(revision), Number(at), String(walletId)
    );
    return sum;
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · commitReservation（预留 → 真实经济事实）
     ══════════════════════════════════════════════════════════════════ */

  /* commit 产生的 ledger transaction id **确定性派生**自 reservationId。
     这不是省事：它让"一次成功的预留恰好对应一笔 ledger transaction"
     成为**结构性**约束而不是纪律（P22-3 §11）——
       · 第二次 commit 会撞上同一个 transactionId，
         commitLedgerTransactionInTx 直接回 TRANSACTION_ID_ALREADY_COMMITTED；
       · reservations.transaction_id 上还有一条 UNIQUE 索引兜底；
       · 幂等重放拿到的自然是同一笔。
     后缀剥掉 econ_res_ 前缀再加 _c，长度远低于契约的 128 上限。 */
  function deriveCommitTransactionId(reservationId) {
    const suffix = String(reservationId).slice(String(C.ID_PREFIX.RESERVATION).length);
    return String(C.ID_PREFIX.TRANSACTION) + suffix + '_c';
  }

  /* commit 允许的对手方。刻意**只有两个**控制账户，而且是白名单而不是
     黑名单：system:mint / system:burn 被排除在外 —— 否则"提交一笔预留"
     就能被写成一次披着 PURCHASE 外衣的增发/销毁（P22-2 的 assertBalanced
     会拒，但那是第二道闸；第一道闸在这里就不该放行）。 */
  const COMMIT_COUNTERPARTIES = Object.freeze([C.SYSTEM_ACCOUNT.TREASURY, C.SYSTEM_ACCOUNT.MARKET]);

  function buildCommitEntries(reservationRow, input) {
    const o = input || {};
    const currency = String(reservationRow.currency);
    const amount = fromSqlAmount(reservationRow.amount_minor, 'reservation-amount');
    /* ── 金额与钱包**只**来自预留行，绝不来自请求 ─────────────────────
       这是本阶段最重要的一条安全性质：如果 commit 能自己指定金额，
       那么"预留 70、提交 999999"就是一条合法路径，而 reserved 这一层
       存在的全部意义会当场消失。因此这里不是"默认取预留值"，而是
       "请求里给了不一样的金额就直接拒绝"。 */
    if (o.amountMinor != null) {
      const given = C.normalizeAmountMinor(o.amountMinor);
      if (!given.ok || given.amountMinor !== amount) {
        return { ok: false, errors: ['commit-amount-must-equal-the-reserved-amount'] };
      }
    }
    if (o.entries != null) {
      /* 接受任意 entries 等于把 ledger 的写权限交出去。reserve/commit 的
         记账形态由 Economy 自己决定（P22-3 §10 的顺序是它规定的）。 */
      return { ok: false, errors: ['commit-entries-are-derived-not-accepted'] };
    }
    const counterparty = o.counterparty == null ? C.SYSTEM_ACCOUNT.TREASURY : String(o.counterparty);
    if (COMMIT_COUNTERPARTIES.indexOf(counterparty) < 0) {
      return { ok: false, errors: ['commit-counterparty-not-allowed'] };
    }
    const type = o.type == null ? C.TX_TYPE.PURCHASE : String(o.type);
    if (type !== C.TX_TYPE.PURCHASE && type !== C.TX_TYPE.GIFT) {
      return { ok: false, errors: ['commit-type-not-allowed'] };
    }
    const wallet = db.prepare(SQL.selectWallet).get(String(reservationRow.wallet_id));
    if (!wallet) return { ok: false, errors: ['wallet-not-found'] };
    return {
      ok: true,
      counterparty: counterparty,
      type: type,
      wallet: wallet,
      entries: [
        /* 钱包 CREDIT（钱离开），对手方 DEBIT。与 transferBetweenWallets
           的 from 侧同款方向约定（WALLET 余额 = Σ(DEBIT) − Σ(CREDIT)）。 */
        { ledgerEntryId: null, accountId: String(wallet.account_id), direction: C.ENTRY_DIRECTION.CREDIT, amountMinor: amount, currency: currency },
        { ledgerEntryId: null, accountId: counterparty, direction: C.ENTRY_DIRECTION.DEBIT, amountMinor: amount, currency: currency }
      ]
    };
  }

  /* ── commitReservation（P22-3 §10/§11）─────────────────────────────
     恰好一个 SQLite 事务，顺序是刻意的：

       BEGIN IMMEDIATE
         re-read reservation（必须 ACTIVE）与 operation（必须 RESERVED）
         ★ reservation → COMMITTED（先离开 ACTIVE）
         ★ reserved 缓存 ← Σ(ACTIVE)（此时已不含本笔）
         ★ ledger transaction + entries（同一事务）
         ★ operation → COMMITTED（并记下 transactionId）
         ★ change log + 幂等行
       COMMIT

     为什么"预留先离开 ACTIVE"必须排在 ledger 之前：P22-2 的
     applyDerivedBalances 有一条真实守卫 —— 若 reserved > resulting ledger
     balance 就抛 RESERVED_EXCEEDS_LEDGER_BALANCE。余额 100、预留 70 时，
     先扣款会让 ledger 变成 30 而 reserved 仍是 70 ⇒ 守卫触发、整个 commit
     回滚。先释放预留再扣款则两数同步下降，守卫在任何中间时刻都成立。
     这不是"绕过守卫"：守卫仍然在，只是被正确地喂了当前值。

     crash 语义：这四步在同一个事务里，因此**不存在**
     "Ledger 已扣款而 Reservation 仍 RESERVED"的中间态 —— 要么两件事
     都发生了，要么一件都没发生。J 组逐个故障点证明这一点。 */
  function commitReservation(input) {
    requireOpen();
    const o = input || {};
    const reservationId = o.reservationId;
    if (!C.isEconomyId('RESERVATION', reservationId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['reservation-id-not-canonical'] };
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const resRow = db.prepare(SQL.selectReservation).get(String(reservationId));
    if (!resRow) return { ok: false, denied: false, reasonCode: null, errors: ['reservation-not-found'] };
    const opRow = db.prepare(SQL.selectOperation).get(String(resRow.operation_id));
    if (!opRow) return { ok: false, denied: false, reasonCode: null, errors: ['operation-not-found'] };

    const walletCheck = db.prepare(SQL.selectWallet).get(String(resRow.wallet_id));
    if (!walletCheck) return { ok: false, denied: false, reasonCode: null, errors: ['wallet-not-found'] };
    const built = buildCommitEntries(resRow, o);
    if (!built.ok) return { ok: false, denied: false, reasonCode: null, errors: built.errors };

    const actor = o.actor == null
      ? C.makePartyRef(String(walletCheck.owner_type), String(walletCheck.owner_id))
      : partyInput(o.actor);
    if (!actor || actor.ok !== true) {
      return { ok: false, denied: false, reasonCode: null, errors: (actor && actor.errors) || ['actor-required'] };
    }
    const normalized = normalizeEntries(built.entries);
    if (!normalized.ok) return { ok: false, denied: false, reasonCode: null, errors: normalized.errors };
    const balanced = assertBalanced(normalized.entries, built.type);
    if (!balanced.ok) return { ok: false, denied: false, reasonCode: null, errors: balanced.errors };

    const ledgerFingerprint = transactionFingerprint({
      type: built.type, actor: actor.party,
      ownerId: String(walletCheck.owner_id), recipientId: null
    }, normalized.entries);
    const fingerprint = operationFingerprint(C.OPERATION_SCOPE.COMMIT, {
      reservationId: String(reservationId),
      ledger: ledgerFingerprint
    });

    /* ── 幂等闸门必须在**终态检查之前** ────────────────────────────────
       否则会出现一个自相矛盾的答案：同一个 commit 请求重放时，第一次
       成功了（预留因此变成 COMMITTED），第二次却被"reservation-is-not-active"
       拒绝。§11 要的恰恰是相反的：**同一个请求 → 返回当初那个结果**。
       指纹只依赖请求本身（reservationId + ledger 结构），与当前状态无关，
       因此它可以、也应该在状态之前被算出来。终态检查随后只负责回答
       "另一个请求能不能再动它"。 */
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.COMMIT, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.COMMIT, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    /* 终态检查：commit 两次、release 之后 commit、expire 之后 commit
       都必须是"已经终态"，而不是走到一半才失败。 */
    if (String(resRow.status) !== C.RESERVATION_STATE.ACTIVE) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['reservation-is-not-active'],
        { reservationState: String(resRow.status), operationStatus: String(opRow.status) });
    }
    if (String(opRow.status) !== C.TX_STATE.RESERVED) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-is-not-reserved'],
        { reservationState: String(resRow.status), operationStatus: String(opRow.status) });
    }

    const now = clock();
    if (resRow.expires_at != null && Number(resRow.expires_at) <= now) {
      /* 到期**不**在这里偷偷变成 EXPIRED：§13 要求状态如实，而且
         "谁把它变成 EXPIRED 的"必须只有一个答案（expire 路径）。
         这里只如实拒绝，并告诉调用方去 sweep。 */
      return denial(C.DENY_REASON.RESERVATION_EXPIRED, ['reservation-is-past-its-expires-at'],
        { expiresAt: Number(resRow.expires_at), now: now, sweepRequired: true });
    }

    const transactionId = deriveCommitTransactionId(reservationId);
    const at = now;
    let committed = null;
    try {
      withTransaction(() => {
        const r = db.prepare(SQL.selectReservation).get(String(reservationId));
        if (!r) throw refuse(null, ['reservation-not-found']);
        const op = db.prepare(SQL.selectOperation).get(String(r.operation_id));
        if (!op) throw refuse(null, ['operation-not-found']);
        if (String(r.status) !== C.RESERVATION_STATE.ACTIVE) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['reservation-is-not-active'],
            { reservationState: String(r.status) });
        }
        if (String(op.status) !== C.TX_STATE.RESERVED) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-is-not-reserved'],
            { operationStatus: String(op.status) });
        }
        if (r.expires_at != null && Number(r.expires_at) <= at) {
          throw refuse(C.DENY_REASON.RESERVATION_EXPIRED, ['reservation-is-past-its-expires-at'],
            { sweepRequired: true });
        }
        const wallet = db.prepare(SQL.selectWallet).get(String(r.wallet_id));
        if (!wallet) throw refuse(null, ['wallet-not-found']);
        const walletState = walletStateOfRow(wallet);
        if (walletState.state !== C.WALLET_STATE.READY) {
          throw refuse(C.DENY_REASON.WALLET_NOT_READY, ['wallet-is-not-ready'], { walletState: walletState.state });
        }
        /* 状态机闸门：RESERVED → COMMITTED 必须被**执行**，不是被假设。 */
        const gate = C.assertTransactionTransition(C.TX_STATE.RESERVED, C.TX_STATE.COMMITTED);
        if (!gate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, gate.errors);
        const resGate = C.assertReservationTransition(C.RESERVATION_STATE.ACTIVE, C.RESERVATION_STATE.COMMITTED);
        if (!resGate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, resGate.errors);

        /* 对手方账户必须先存在（commitLedgerTransactionInTx 不会替你创建）。 */
        const sys = ensureSystemAccount(built.counterparty);
        if (!sys.ok) throw refuse(null, sys.errors);

        /* 一个 revision 覆盖"预留关闭"这件事；ledger 提交自己会再分配
           一个用于那笔经济事实。两个 change 行、两个 revision，都在
           同一个事务里，因此 revision 序列仍然**无洞**（每一次
           allocateRevision 恰好配一条 change 行）。 */
        const revision = allocateRevision();
        faultPoint('after-commit-validated');

        const movedRes = db.prepare(SQL.setReservationStatus).run(
          C.RESERVATION_STATE.COMMITTED, transactionId, null,
          Number(revision), Number(at), String(reservationId), C.RESERVATION_STATE.ACTIVE
        );
        if (Number(movedRes.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['reservation-transition-affected-no-row']);
        }
        faultPoint('after-reservation-committed');

        applyReservedCache(String(r.wallet_id), revision, at);
        faultPoint('after-commit-reserved-cache');

        const ledger = commitLedgerTransactionInTx({
          transactionId: transactionId,
          type: built.type,
          idempotencyKey: 'econ.commit+' + String(reservationId) + '+' + key.key,
          actor: actor.party,
          ownerId: String(wallet.owner_id),
          recipientId: null,
          entries: normalized.entries
        });
        if (ledger.ok !== true) {
          /* ledger 拒绝 ⇒ 整个 commit 回滚（预留在事务外仍是 ACTIVE）。
             这里刻意**不**把它变成 FAILED：一次被拒绝的提交不是"操作
             进入了生命周期后不可继续"，而是"这次提交不成立" —— 后者
             必须让调用方还能重试或显式 failExpired/fail。 */
          throw refuse(ledger.errors && ledger.errors.indexOf('insufficient-balance') >= 0
            ? C.DENY_REASON.INSUFFICIENT_BALANCE : null, ledger.errors || ['ledger-commit-refused'], {
            ledgerErrors: ledger.errors || []
          });
        }
        faultPoint('after-commit-ledger');

        const movedOp = db.prepare(SQL.setOperationStatus).run(
          C.TX_STATE.COMMITTED, String(reservationId), String(ledger.transactionId), null,
          Number(revision), Number(at), String(op.operation_id), C.TX_STATE.RESERVED
        );
        if (Number(movedOp.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-transition-affected-no-row']);
        }
        faultPoint('after-commit-operation-status');

        const result = {
          domain: C.DOMAIN,
          operationId: String(op.operation_id),
          operationStatus: C.TX_STATE.COMMITTED,
          reservationId: String(reservationId),
          reservationState: C.RESERVATION_STATE.COMMITTED,
          walletId: String(r.wallet_id),
          currency: String(r.currency),
          amountMinor: C.serializeAmountMinor(fromSqlAmount(r.amount_minor, 'reservation-amount')),
          transactionId: String(ledger.transactionId),
          transactionType: built.type,
          counterparty: built.counterparty,
          revision: Number(revision),
          at: Number(at),
          idempotencyKey: key.key,
          ledger: ledger.result
        };

        appendChange({
          revision: Number(revision), kind: C.EVENT_TYPE.RESERVATION_COMMITTED,
          entityId: String(reservationId), transactionId: String(ledger.transactionId),
          walletId: String(r.wallet_id), at: Number(at),
          payload: {
            domain: C.DOMAIN,
            operationId: String(op.operation_id),
            reservationId: String(reservationId),
            reservationState: C.RESERVATION_STATE.COMMITTED,
            operationStatus: C.TX_STATE.COMMITTED,
            transactionId: String(ledger.transactionId),
            amountMinor: C.serializeAmountMinor(fromSqlAmount(r.amount_minor, 'reservation-amount')),
            currency: String(r.currency),
            counterparty: built.counterparty,
            ledgerRevision: ledger.result.revision
          }
        });
        faultPoint('before-commit-change-log');

        writeOperationIdempotency(C.OPERATION_SCOPE.COMMIT, key.key, fingerprint, {
          operationId: String(op.operation_id), reservationId: String(reservationId),
          transactionId: String(ledger.transactionId)
        }, result, revision, at);
        faultPoint('before-reservation-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    pruneIdempotency(at);
    logger('economy-reservation-committed', {
      reservationId: committed.reservationId,
      operationId: committed.operationId,
      transactionId: committed.transactionId,
      walletId: committed.walletId,
      currency: committed.currency,
      revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · release / expire / fail（三种"钱还回去"，三种不同的原因）
     ══════════════════════════════════════════════════════════════════ */

  /* 三者共用一个内核。共同点：reservation ACTIVE → 终态、operation
     RESERVED → 终态、reserved 缓存 ← Σ(ACTIVE)、一条 change log、
     一条幂等记录。**共同点的核心是：都不写 ledger。**
     reserve 从来没有让钱离开钱包，因此"释放"不可能、也不允许产生任何
     退款交易（P22-3 §12）。这条性质在测试里是逐字断言的：transaction
     计数、entry 计数、cached balance 全部不变。 */
  function settleReservation(input, plan) {
    const o = input || {};
    const reservationId = o.reservationId;
    if (!C.isEconomyId('RESERVATION', reservationId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['reservation-id-not-canonical'] };
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };
    const now = plan.now != null ? Number(plan.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }

    const resRow = db.prepare(SQL.selectReservation).get(String(reservationId));
    if (!resRow) return { ok: false, denied: false, reasonCode: null, errors: ['reservation-not-found'] };
    const opRow = db.prepare(SQL.selectOperation).get(String(resRow.operation_id));
    if (!opRow) return { ok: false, denied: false, reasonCode: null, errors: ['operation-not-found'] };

    /* 与 commitReservation 同一个理由：幂等闸门排在终态检查**之前** ——
       否则"同一个 release 请求重放"会在第一次成功之后开始被拒，
       而 §11 要的是"返回当初那个结果"。指纹只依赖请求（reservationId 与
       原因），与当前状态无关。 */
    const fingerprint = operationFingerprint(plan.scope, plan.fingerprintPayload(resRow));
    const seen = operationIdempotencyLookup(plan.scope, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(plan.scope, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    if (String(resRow.status) !== C.RESERVATION_STATE.ACTIVE) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['reservation-is-already-terminal'],
        { reservationState: String(resRow.status), operationStatus: String(opRow.status) });
    }
    if (String(opRow.status) !== C.TX_STATE.RESERVED) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-is-not-reserved'],
        { reservationState: String(resRow.status), operationStatus: String(opRow.status) });
    }
    const pre = plan.precheck ? plan.precheck(resRow, opRow, now) : null;
    if (pre && pre.ok !== true) return pre;

    const at = now;
    let committed = null;
    try {
      withTransaction(() => {
        const r = db.prepare(SQL.selectReservation).get(String(reservationId));
        if (!r) throw refuse(null, ['reservation-not-found']);
        const op = db.prepare(SQL.selectOperation).get(String(r.operation_id));
        if (!op) throw refuse(null, ['operation-not-found']);
        if (String(r.status) !== C.RESERVATION_STATE.ACTIVE) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['reservation-is-already-terminal'],
            { reservationState: String(r.status) });
        }
        if (String(op.status) !== C.TX_STATE.RESERVED) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-is-not-reserved'],
            { operationStatus: String(op.status) });
        }
        /* 两个状态机各自被**执行**一次。终态不可回退在这里不是一句注释：
           assert* 会对 ACTIVE→X 与 RESERVED→Y 分别给出 allowed。 */
        const resGate = C.assertReservationTransition(C.RESERVATION_STATE.ACTIVE, plan.reservationState);
        if (!resGate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, resGate.errors);
        const opGate = C.assertTransactionTransition(C.TX_STATE.RESERVED, plan.operationState);
        if (!opGate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, opGate.errors);
        if (plan.requireDue && (r.expires_at == null || Number(r.expires_at) > at)) {
          throw refuse(null, ['reservation-not-yet-due'], { expiresAt: r.expires_at == null ? null : Number(r.expires_at), now: at });
        }

        const revision = allocateRevision();
        faultPoint(plan.faultPrefix + '-validated');

        const movedRes = db.prepare(SQL.setReservationStatus).run(
          plan.reservationState, null, plan.releaseReason,
          Number(revision), Number(at), String(reservationId), C.RESERVATION_STATE.ACTIVE
        );
        if (Number(movedRes.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['reservation-transition-affected-no-row']);
        }
        faultPoint(plan.faultPrefix + '-after-status');

        /* reserved 缓存 ← Σ(ACTIVE)（本笔已经不在里面了）。 */
        const sum = applyReservedCache(String(r.wallet_id), revision, at);
        faultPoint(plan.faultPrefix + '-after-reserved-cache');

        const movedOp = db.prepare(SQL.setOperationStatus).run(
          plan.operationState, String(reservationId), null, plan.reasonCode == null ? null : String(plan.reasonCode),
          Number(revision), Number(at), String(op.operation_id), C.TX_STATE.RESERVED
        );
        if (Number(movedOp.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-transition-affected-no-row']);
        }

        const result = {
          domain: C.DOMAIN,
          operationId: String(op.operation_id),
          operationStatus: plan.operationState,
          reservationId: String(reservationId),
          reservationState: plan.reservationState,
          walletId: String(r.wallet_id),
          currency: String(r.currency),
          amountMinor: C.serializeAmountMinor(fromSqlAmount(r.amount_minor, 'reservation-amount')),
          releaseReason: plan.releaseReason,
          reasonCode: plan.reasonCode == null ? null : String(plan.reasonCode),
          /* 逐字写明"这件事没有产生任何 ledger 事实"。字段名与 commit 路径
             用的是同一个（transactionId），因为它们是同一个概念；这里它
             恒为 null —— 一条"还回去"的操作不可能、也不允许有一笔交易。 */
          transactionId: null,
          revision: Number(revision),
          at: Number(at),
          idempotencyKey: key.key,
          reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
          activeReservations: sum.activeCount
        };

        appendChange({
          revision: Number(revision), kind: plan.changeKind,
          entityId: String(reservationId), transactionId: null,
          walletId: String(r.wallet_id), at: Number(at),
          payload: {
            domain: C.DOMAIN,
            operationId: String(op.operation_id),
            reservationId: String(reservationId),
            reservationState: plan.reservationState,
            operationStatus: plan.operationState,
            releaseReason: plan.releaseReason,
            reasonCode: plan.reasonCode == null ? null : String(plan.reasonCode),
            amountMinor: C.serializeAmountMinor(fromSqlAmount(r.amount_minor, 'reservation-amount')),
            currency: String(r.currency),
            /* 逐字写明"这件事没有产生任何 ledger 事实"：审计里"钱还回去了"
               与"账本动了"必须一眼可分。 */
            ledgerMutation: false,
            reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
            activeReservations: sum.activeCount
          }
        });
        faultPoint(plan.faultPrefix + '-before-change-log');

        writeOperationIdempotency(plan.scope, key.key, fingerprint, {
          operationId: String(op.operation_id), reservationId: String(reservationId), transactionId: null
        }, result, revision, at);
        faultPoint('before-reservation-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger(plan.logEvent, {
      reservationId: committed.reservationId,
      operationId: committed.operationId,
      walletId: committed.walletId,
      currency: committed.currency,
      revision: committed.revision,
      releaseReason: committed.releaseReason,
      reasonCode: committed.reasonCode
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ── releaseReservation（§12）───────────────────────────────────────
     主动放弃（用户取消 / 上游动作失败）。故意**只**接受 USER / SYSTEM：
     EXPIRED 只能由 expire 路径产生，OPERATION_FAILED 只能由 fail 路径产生。
     如果 release 也能写这两个原因，那么"为什么这笔没成交"就又能被伪装，
     而 P22 §16 要求的正是它必须可回答。 */
  function releaseReservation(input) {
    requireOpen();
    const o = input || {};
    const reason = o.releaseReason == null ? RELEASE_REASON.USER : String(o.releaseReason);
    if (reason !== RELEASE_REASON.USER && reason !== RELEASE_REASON.SYSTEM) {
      return {
        ok: false, denied: false, reasonCode: null,
        errors: ['release-reason-must-be-user-or-system'],
        hint: 'EXPIRED is produced only by expireReservation; OPERATION_FAILED only by failReservation'
      };
    }
    return settleReservation(o, {
      scope: C.OPERATION_SCOPE.RELEASE,
      reservationState: C.RESERVATION_STATE.RELEASED,
      operationState: C.TX_STATE.RELEASED,
      releaseReason: reason,
      reasonCode: null,
      changeKind: C.EVENT_TYPE.RESERVATION_RELEASED,
      faultPrefix: 'after-release',
      logEvent: 'economy-reservation-released',
      requireDue: false,
      fingerprintPayload: (row) => ({
        reservationId: String(row.reservation_id), releaseReason: reason
      })
    });
  }

  /* ── expireReservation（§13/§14）────────────────────────────────────
     与 RELEASED 在**资源效果**上完全相同（钱还回去），但 canonical 状态
     必须是 EXPIRED —— 否则"为什么这笔没成交"就丢了。now 可以被显式传入，
     因为真相是一个**比较**（expires_at <= now），而不是一个定时器。 */
  function expireReservation(input) {
    requireOpen();
    const o = input || {};
    return settleReservation(o, {
      scope: C.OPERATION_SCOPE.EXPIRE,
      now: o.now,
      reservationState: C.RESERVATION_STATE.EXPIRED,
      operationState: C.TX_STATE.EXPIRED,
      releaseReason: RELEASE_REASON.EXPIRED,
      reasonCode: C.DENY_REASON.RESERVATION_EXPIRED,
      changeKind: C.EVENT_TYPE.RESERVATION_EXPIRED,
      faultPrefix: 'after-expire',
      logEvent: 'economy-reservation-expired',
      requireDue: true,
      /* 到期判定在事务**外**先做一次（便宜且给出可读的拒绝），事务内再做
         一次（权威）。两次用的是同一个 now，因此不可能出现"外面说到期了、
         里面说没到期"的抖动。 */
      precheck: (row, op, now) => {
        if (row.expires_at == null) return { ok: false, denied: false, reasonCode: null, errors: ['reservation-has-no-expires-at'] };
        if (Number(row.expires_at) > now) {
          return { ok: false, denied: false, reasonCode: null, errors: ['reservation-not-yet-due'], expiresAt: Number(row.expires_at), now: now };
        }
        return { ok: true };
      },
      fingerprintPayload: (row) => ({ reservationId: String(row.reservation_id) })
    });
  }

  /* ── failReservation（§4/§17）──────────────────────────────────────
     FAILED 是**操作层面**的"不可继续"，而且它必须被**显式**触发。
     §17 明确要求不要把普通拒绝写成 persisted FAILED：余额不足根本不
     创建任何行（reserve 整体回滚），因此在这里进入 FAILED 的只有
     "已经进入生命周期、之后确定无法完成"的操作。
     资源后果与 release 相同（钱还回去），但两个词表各自记下真相：
       operation → FAILED        （有 FAILED 的只有这一张词表）
       reservation → RELEASED    （RESERVATION_STATE 没有 FAILED，也不该有）
     reasonCode 必须来自契约的封闭集合 —— 一个自由文本的失败原因会让
     审计里出现无法聚合的字符串。 */
  function failReservation(input) {
    requireOpen();
    const o = input || {};
    const reasonCode = String(o.reasonCode == null ? '' : o.reasonCode);
    if (!C.isDenyReasonCode(reasonCode)) {
      return {
        ok: false, denied: false, reasonCode: null,
        errors: ['failure-reason-code-not-in-closed-set'],
        allowed: C.DENY_REASONS
      };
    }
    return settleReservation(o, {
      scope: C.OPERATION_SCOPE.FAIL,
      reservationState: C.RESERVATION_STATE.RELEASED,
      operationState: C.TX_STATE.FAILED,
      releaseReason: RELEASE_REASON.OPERATION_FAILED,
      reasonCode: reasonCode,
      changeKind: C.EVENT_TYPE.OPERATION_FAILED,
      faultPrefix: 'after-fail',
      logEvent: 'economy-operation-failed',
      requireDue: false,
      fingerprintPayload: (row) => ({ reservationId: String(row.reservation_id), reasonCode: reasonCode })
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · expireDueReservations（到期扫描）
     ══════════════════════════════════════════════════════════════════ */

  /* 确定性 + 显式 now + 分批 + 幂等 + 不处理终态 + 每笔一条 change log。
     刻意**没有**后台定时器：真相是 `expires_at <= now` 这条比较，于是
     进程关机两小时后重启，那笔预留依然是"到期的"，扫一次就落定
     （P22-3 §14/§15）。
     每笔一个自己的事务：一笔失败不会回滚其它笔 —— 批量操作里"要么全成
     要么全不成"是错的目标（一笔坏数据不该让九十九笔好数据留着不动）。 */
  function expireDueReservations(input) {
    requireOpen();
    const o = input || {};
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const limit = Math.max(1, Math.min(1000, Number(o.limit) || 100));
    const due = db.prepare(SQL.selectDueReservations).all(Number(now), limit);
    const expired = [];
    const skipped = [];
    const failed = [];
    for (const row of due) {
      const reservationId = String(row.reservation_id);
      /* 扫描的幂等键由 reservationId **确定性派生**：同一次到期无论扫多少
         次都是同一个业务请求，因此第二次扫描要么被 skip（已终态）、要么
         命中幂等重放，**不可能**产生第二条 expiration。 */
      const out = expireReservation({
        reservationId: reservationId,
        now: now,
        idempotencyKey: 'econ.sweep.expire+' + reservationId
      });
      if (out.ok === true && out.replayed === true) skipped.push({ reservationId: reservationId, reason: 'already-expired-by-an-earlier-sweep' });
      else if (out.ok === true) expired.push(out.result);
      else if (out.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED) skipped.push({ reservationId: reservationId, reason: 'already-terminal' });
      else failed.push({ reservationId: reservationId, errors: out.errors, reasonCode: out.reasonCode || null });
    }
    return {
      ok: true,
      now: now,
      limit: limit,
      scanned: due.length,
      expired: expired,
      skipped: skipped,
      failed: failed,
      usedTimers: false
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · rebuildReservedBalance / reconcileReservations
     ══════════════════════════════════════════════════════════════════ */

  /* 从 **active reservations** 重建 reserved 缓存（P22-3 §6）。
     与 rebuildWalletBalance 同一个形状与同一个理由：canonical 是行，
     缓存是派生量，漂移要修好并留下审计。输入只有 walletId，**从不读缓存
     参与计算** —— 否则"重建"会变成"把缓存抄一遍"。 */
  function rebuildReservedBalance(walletId, options) {
    options = options || {};
    requireOpen();
    const wallet = db.prepare(SQL.selectWallet).get(String(walletId));
    if (!wallet) return { ok: false, walletId: String(walletId), errors: ['wallet-not-found'] };
    const rows = db.prepare(SQL.selectReservationsByWalletAll).all(String(walletId));
    const problems = walletStructuralProblems(wallet).concat(reservationProblemsOf(wallet, rows));
    if (problems.length) {
      /* 结构损坏 ⇒ 不可信 ⇒ DEGRADED。**绝不**返回 0：把"我不知道锁了
         多少钱"回答成"没锁"正是 P22-0 R5 的同一个根因换了个字段。 */
      degrade('reservation-rebuild-failed:' + problems.join(','));
      return { ok: false, walletId: String(walletId), errors: ['rebuild-failed'], integrity: problems };
    }
    const canonical = computeReservedBalance(String(walletId));
    const cached = fromSqlAmount(wallet.reserved_balance_minor, 'cached-reserved');
    const drifted = cached !== canonical.reservedMinor;
    const repaired = drifted && options.repair !== false;
    if (repaired) {
      const revision = allocateRevision();
      const at = clock();
      db.prepare(SQL.setWalletReserved).run(
        toSqlAmount(canonical.reservedMinor, 'rebuilt-reserved'),
        Number(revision), Number(at), String(walletId)
      );
      appendChange({
        revision: Number(revision), kind: C.EVENT_TYPE.RESERVATION_REBUILT,
        entityId: String(walletId), transactionId: null, walletId: String(walletId), at: Number(at),
        payload: {
          domain: C.DOMAIN,
          previousReservedBalanceMinor: C.serializeAmountMinor(cached),
          rebuiltReservedBalanceMinor: C.serializeAmountMinor(canonical.reservedMinor),
          activeReservations: canonical.activeCount,
          currency: String(wallet.currency)
        }
      });
      logger('economy-reserved-balance-rebuilt', {
        walletId: String(walletId), currency: String(wallet.currency),
        previous: C.serializeAmountMinor(cached), rebuilt: C.serializeAmountMinor(canonical.reservedMinor)
      });
    }
    return {
      ok: true,
      walletId: String(walletId),
      currency: String(wallet.currency),
      reservedBalanceMinor: canonical.reservedMinor,
      cachedReservedBalanceMinor: cached,
      activeReservations: canonical.activeCount,
      reservationRows: rows.length,
      drifted: drifted,
      repaired: repaired
    };
  }

  /* ── 开库时的预留对账（P22-3 §16）────────────────────────────────────
     对象刻意**只**是"有预留行或 reserved 缓存非零"的钱包：没有预留的
     钱包本来就没有可漂移的东西，扫全表是纯粹的浪费。有意留下预留的
     钱包数量是 O(活跃经济活动的规模)，而不是 O(钱包总数)。
     两种结局分开：
       · 缓存漂移  → 从 canonical 重建 + 一条 RESERVATION_REBUILT；
       · 结构损坏  → DEGRADED（fail closed），且**不**尝试修复。
     一致性正常时**什么都不写** —— 尤其是**不消耗 revision**：否则"重启
     一次"会变成一次虚假的经济事件，而 revision 是镜像游标的语义基础。 */
  function reconcileReservations(options) {
    options = options || {};
    requireOpen();
    const at = Number.isFinite(options.at) ? Number(options.at) : clock();
    const all = db.prepare(SQL.selectReservationsAll).all();
    const walletIds = [];
    const seenIds = Object.create(null);
    const addWallet = (id) => {
      const s = String(id);
      if (seenIds[s]) return;
      seenIds[s] = true;
      walletIds.push(s);
    };
    for (const row of all) addWallet(row.wallet_id);
    for (const row of db.prepare(SQL.selectWalletsWithReservedCache).all()) addWallet(row.wallet_id);

    const repaired = [];
    const integrity = [];
    let checked = 0;
    for (const walletId of walletIds) {
      const wallet = db.prepare(SQL.selectWallet).get(walletId);
      if (!wallet) { integrity.push(walletId + ':wallet-row-missing'); continue; }
      checked += 1;
      const rows = db.prepare(SQL.selectReservationsByWalletAll).all(walletId);
      const problems = walletStructuralProblems(wallet).concat(reservationProblemsOf(wallet, rows));
      if (problems.length) { integrity.push.apply(integrity, problems.map(p => walletId + ':' + p)); continue; }
      const canonical = computeReservedBalance(walletId);
      let ledger = null;
      try { ledger = computeLedgerBalance(wallet.account_id, wallet.currency).balanceMinor; }
      catch (error) { integrity.push(walletId + ':ledger-read-failed'); continue; }
      if (canonical.reservedMinor > ledger) { integrity.push(walletId + ':active-reservations-exceed-ledger-balance'); continue; }
      const cached = fromSqlAmount(wallet.reserved_balance_minor, 'cached-reserved');
      if (cached === canonical.reservedMinor) continue;
      if (options.repair === false) {
        repaired.push({ walletId: walletId, cachedReservedBalanceMinor: C.serializeAmountMinor(cached), reservedBalanceMinor: C.serializeAmountMinor(canonical.reservedMinor), repaired: false });
        continue;
      }
      const revision = allocateRevision();
      db.prepare(SQL.setWalletReserved).run(
        toSqlAmount(canonical.reservedMinor, 'reconciled-reserved'), Number(revision), Number(at), walletId
      );
      appendChange({
        revision: Number(revision), kind: C.EVENT_TYPE.RESERVATION_REBUILT,
        entityId: walletId, transactionId: null, walletId: walletId, at: at,
        payload: {
          domain: C.DOMAIN,
          previousReservedBalanceMinor: C.serializeAmountMinor(cached),
          rebuiltReservedBalanceMinor: C.serializeAmountMinor(canonical.reservedMinor),
          activeReservations: canonical.activeCount,
          currency: String(wallet.currency),
          source: 'open-time-reconciliation'
        }
      });
      repaired.push({
        walletId: walletId,
        cachedReservedBalanceMinor: C.serializeAmountMinor(cached),
        reservedBalanceMinor: C.serializeAmountMinor(canonical.reservedMinor),
        repaired: true
      });
    }
    if (integrity.length) {
      degrade('reservation-reconcile:' + integrity.join(','));
      return { ok: false, walletsChecked: checked, reservationRows: all.length, repaired: repaired, integrity: integrity };
    }
    return { ok: true, walletsChecked: checked, reservationRows: all.length, repaired: repaired, integrity: [] };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-3 · 读取
     ══════════════════════════════════════════════════════════════════ */

  function getReservation(input) {
    requireOpen();
    const o = typeof input === 'string' ? { reservationId: input } : (input || {});
    let row = null;
    if (o.reservationId) row = db.prepare(SQL.selectReservation).get(String(o.reservationId));
    else if (o.operationId) row = db.prepare(SQL.selectReservationByOperation).get(String(o.operationId));
    if (!row) return { ok: false, reservation: null, errors: ['reservation-not-found'] };
    const op = db.prepare(SQL.selectOperation).get(String(row.operation_id));
    return { ok: true, reservation: rowToReservation(row, op) };
  }

  function listReservations(options) {
    options = options || {};
    requireOpen();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const status = options.status == null ? null : String(options.status);
    if (status != null && C.RESERVATION_STATES.indexOf(status) < 0) {
      return { ok: false, reservations: null, errors: ['reservation-status-not-in-closed-set'] };
    }
    let rows;
    if (options.walletId) {
      rows = db.prepare(SQL.selectReservationsByWallet).all(String(options.walletId), limit);
      if (status) rows = rows.filter(r => String(r.status) === status);
    } else if (options.ownerId) {
      /* owner 维度要跨这个 owner 的所有币种钱包。这里刻意**不**用一条
         JOIN：预留行的 wallet_id 是唯一索引入口，逐钱包查是正确的形状。 */
      const wallets = db.prepare(SQL.selectWalletsByOwner).all(String(options.ownerId));
      rows = [];
      for (const w of wallets) {
        for (const r of db.prepare(SQL.selectReservationsByWallet).all(String(w.wallet_id), limit)) {
          if (!status || String(r.status) === status) rows.push(r);
        }
      }
      rows.sort((a, b) => (Number(a.created_at) - Number(b.created_at)) || String(a.reservation_id).localeCompare(String(b.reservation_id)));
      rows = rows.slice(0, limit);
    } else if (status) {
      rows = db.prepare(SQL.selectReservationsByStatus).all(status, limit);
    } else {
      rows = db.prepare(SQL.selectReservations).all(limit);
    }
    return {
      ok: true,
      reservations: rows.map(r => rowToReservation(r, db.prepare(SQL.selectOperation).get(String(r.operation_id)))),
      scope: options.walletId ? 'wallet' : (options.ownerId ? 'owner' : (status ? 'status' : 'all'))
    };
  }

  function getOperation(operationId) {
    requireOpen();
    if (!C.isEconomyId('OPERATION', operationId)) {
      return { ok: false, operation: null, errors: ['operation-id-not-canonical'] };
    }
    const row = db.prepare(SQL.selectOperation).get(String(operationId));
    if (!row) return { ok: false, operation: null, errors: ['operation-not-found'] };
    return { ok: true, operation: rowToOperation(row) };
  }

  function listOperations(options) {
    options = options || {};
    requireOpen();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    let rows;
    if (options.walletId) rows = db.prepare(SQL.selectOperationsByWallet).all(String(options.walletId), limit);
    else if (options.status) {
      if (C.TX_STATES.indexOf(String(options.status)) < 0) {
        return { ok: false, operations: null, errors: ['operation-status-not-in-closed-set'] };
      }
      rows = db.prepare(SQL.selectOperationsByStatus).all(String(options.status), limit);
    } else rows = db.prepare(SQL.selectOperations).all(limit);
    return { ok: true, operations: rows.map(rowToOperation) };
  }

  function countOperations() { return Number((db.prepare(SQL.countOperations).get() || {}).c || 0); }
  function countReservations() { return Number((db.prepare(SQL.countReservations).get() || {}).c || 0); }
  function countReservationsByStatus(status) {
    return Number((db.prepare(SQL.countReservationsByStatus).get(String(status)) || {}).c || 0);
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-4 · 预算政策（规则）+ 报价（价格命题）+ 确定性评估
     一条必须先说清楚的边界（P22-4 §1）：

        Wallet      回答"有没有这么多钱？"        ← P22-2/P22-3
        Budget      回答"规则允不允许花？"        ← 本节的**读**一半
        Approval    回答"需不需要用户批准？"      ← 本节只**分类**，不执行
        Decision    回答"Agent 想不想买？"        ← 不属于 Economy
        Action      回答"是否真的执行？"          ← 不属于 Economy

     Budget **不是**第二个 Wallet：它的输入里既有 wallet 事实，也有规则，
     而它产出的东西只有三个词（ALLOW / DENY / REQUIRE_APPROVAL）。
     它**没有**能力让钱动 —— 本节一个 ledger 写入、一个 reservation 写入
     都没有，而且这件事是结构性的：本节的每一个函数都不调用
     commitLedgerTransactionInTx / applyReservedCache / setWalletBalance。
     ══════════════════════════════════════════════════════════════════ */

  /* ── 政策行 ↔ DTO ───────────────────────────────────────────────────
     五个限额列按契约的 POLICY_LIMIT_TABLE **生成**，因此"哪一列对应哪个
     冻结的 limit 键"只有一处定义。approval_above_minor 与 cooldown_ms
     单独处理：前者对应 approvalThresholdMinor，后者是**时长**——
     把它们混进同一张金额表会让 90000ms 变成一个金额。 */
  function policyLimitsFromRow(row) {
    const out = {};
    for (const entry of C.POLICY_LIMIT_TABLE) {
      const raw = row[entry.field];
      if (raw == null) continue;
      out[entry.name] = fromSqlAmount(raw, 'policy-limit-' + entry.name);
    }
    if (row.approval_above_minor != null) {
      out.approvalThresholdMinor = fromSqlAmount(row.approval_above_minor, 'policy-approval-threshold');
    }
    if (row.cooldown_ms != null) out[C.COOLDOWN_KEY] = Number(row.cooldown_ms);
    return out;
  }

  function rowToBudgetPolicy(row) {
    const termEndsAt = row.term_ends_at == null ? null : Number(row.term_ends_at);
    return {
      domain: C.DOMAIN,
      namespace: C.NAMESPACES.BUDGET,
      policyId: String(row.policy_id),
      ownerId: Object.freeze({ type: String(row.owner_type), id: String(row.owner_id) }),
      currency: String(row.currency),
      status: String(row.status),
      limits: policyLimitsFromRow(row),
      termEndsAt: termEndsAt,
      /* "到期了没有"与"是不是被停用了"是两个问题，因此是两个字段。
         到期是**比较**出来的（同一个 now 永远同一个答案），不是任何
         调度写下来的。 */
      expiredByTerm: termEndsAt != null && Number.isFinite(termEndsAt) && termEndsAt <= clock(),
      hardStop: Number(row.hard_stop) === 1,
      hardStoppedAt: row.hard_stopped_at == null ? null : Number(row.hard_stopped_at),
      autonomyLevel: row.autonomy_level == null ? null : String(row.autonomy_level),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  /* 政策的**生效性判定只有一处**。契约的 policyIsEffectiveAt 是纯函数，
     这里只负责把行翻译成它认识的形状并补上运行时才知道的硬停用事实。
     任何未知状态 ⇒ 不生效（fail closed，§17）。 */
  function policyEffectiveness(policy, now) {
    if (!policy) return { ok: true, effective: false, reason: 'POLICY_NOT_FOUND', errors: [] };
    if (!C.isPolicyStatus(policy.status)) {
      return { ok: false, effective: false, reason: 'POLICY_NOT_FOUND', errors: ['policy-status-not-in-closed-set'] };
    }
    if (policy.hardStop === true || String(policy.status) !== C.POLICY_STATUS.ACTIVE) {
      return { ok: true, effective: false, reason: 'POLICY_NOT_FOUND', errors: [] };
    }
    return C.policyIsEffectiveAt({ status: policy.status, termEndsAt: policy.termEndsAt }, now);
  }

  /* ── 消费窗口的 canonical 求和（§12/§13/§14）─────────────────────────
     三个数全部来自 **committed ledger 事实**，一次查询取回窗口内的每一笔
     消费，再按 UTC 窗口边界分桶。没有任何一个数来自缓存、UI 计数器、
     localStorage 或"记忆"。

     判决权的三处细节，每一处都是刻意的：

     ① **金额只从 entry 读。** transactions 表**没有**金额列（P22-2 §6：
        交易上再存一份金额就是第二个事实源）。因此求和的对象是
        economy_ledger_entries，而 transactions 只提供 tx_type 与 state。

     ② **方向只从 direction 列读，绝不用 `amount < 0` 猜。** ledger 的
        canonical amount 是**无符号**的（P22-1 §8），所以"负数金额"在
        数据里根本不存在 —— 靠它判断消费的代码在真实数据上永远得到 0，
        而只喂正数的测试会是绿的。谓词是 `direction='DEBIT'`。

     ③ **"哪些 type 算消费"来自契约的封闭表**（BUDGET_SPENDING_TYPES），
        不是这里现写的 IN 列表。新增一个 transaction type 却忘了分类会
        在契约载入期失败，而不是在这里静默地少算一笔。

     LEFT JOIN 而不是 INNER：账户行缺失时 WHERE 的每个条件都为 false，
     于是那一笔**不计入**求和 —— 而"读不到就是没花"是一种危险的沉默。
     因此这里额外做一次结构检查（account 行必须存在、kind 必须是
     WALLET、wallet_id 必须指回本钱包、币种必须一致），任何一条不成立
     就让整个快照失败（fail closed），而不是给出一个偏小的窗口值。 */
  function spendingWindowBounds(now) {
    const dayStart = C.utcDayStart(now);
    const weekStart = C.utcWeekStart(now);
    const monthStart = C.utcMonthStart(now);
    if (dayStart == null || weekStart == null || monthStart == null) return null;
    return {
      day: dayStart, week: weekStart, month: monthStart,
      /* 三个窗口里最早的那个 —— 一次查询就够了，而且顺序是确定的。 */
      earliest: Math.min(dayStart, weekStart, monthStart),
      now: Number(now)
    };
  }

  function spendingRowsSince(walletRow, sinceAt) {
    return db.prepare(SQL.selectSpendingRows).all(
      String(walletRow.account_id), String(walletRow.currency), Number(sinceAt)
    );
  }

  function sumSpendingInWindow(rows, walletRow, windowStart) {
    let total = 0n;
    let count = 0;
    for (const row of rows) {
      if (Number(row.at) < Number(windowStart)) continue;
      /* 结构完整性：账户行必须存在且确实是**这个**钱包的 WALLET 账户，
         币种必须一致。不成立就抛 —— 一个"读不到所以是 0"的窗口值会让
         一次超预算的消费看起来合规。 */
      if (row.account_id == null) throw refuse(null, ['spending-entry-account-row-missing']);
      if (String(row.account_kind) !== C.ACCOUNT_KIND.WALLET) throw refuse(null, ['spending-entry-account-is-not-a-wallet']);
      if (String(row.account_wallet_id == null ? '' : row.account_wallet_id) !== String(walletRow.wallet_id)) {
        throw refuse(null, ['spending-entry-account-belongs-to-another-wallet']);
      }
      if (String(row.account_currency) !== String(walletRow.currency)) throw refuse(null, ['spending-entry-currency-differs-from-wallet']);
      if (String(row.account_id) !== String(walletRow.account_id)) throw refuse(null, ['spending-entry-account-id-differs-from-the-wallet-row']);
      if (String(row.entry_currency) !== String(walletRow.currency)) throw refuse(null, ['spending-entry-currency-differs-from-wallet']);
      if (row.tx_state !== C.TX_STATE.COMMITTED) continue;    /* 只统计已提交的事实 */
      if (row.tx_type == null || !C.isSpendingTransactionType(row.tx_type)) continue;
      total += fromSqlAmount(row.amount_minor, 'spending-entry-amount');
      count += 1;
    }
    return { total: total, count: count };
  }

  /* 一个 owner 在某个币种上"已经花了多少"。返回的三个数就是评估上下文的
     usage，因此它们**必须**是 canonical —— 这里没有第二个来源。 */
  function spendingWindows(input) {
    const o = input || {};
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const owner = partyInput(o.ownerId);
    if (!owner.ok) return { ok: false, errors: owner.errors };
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return { ok: false, errors: cur.errors };
    const walletRow = db.prepare(SQL.selectWalletByOwner).get(String(owner.party.id), cur.currency);
    if (!walletRow) return { ok: false, errors: ['wallet-not-found'], ownerId: String(owner.party.id), currency: cur.currency };
    /* 结构前提：这个钱包在它自己的币种上恰好一个 WALLET 账户。
       0 个 ⇒ 引用链断了；≥2 个 ⇒ 余额被劈成两半。两者都让"花了多少"
       无法被诚实地回答，因此 fail closed，而不是给出一个偏小的数。 */
    const accountCount = Number((db.prepare(SQL.countWalletAccounts).get(
      String(walletRow.wallet_id), cur.currency) || {}).c || 0);
    if (accountCount !== 1) {
      return {
        ok: false, errors: ['wallet-must-have-exactly-one-ledger-account-in-its-currency'],
        walletId: String(walletRow.wallet_id), walletAccounts: accountCount
      };
    }
    const bounds = spendingWindowBounds(now);
    if (!bounds) return { ok: false, errors: ['now-is-not-a-representable-instant'] };
    const rows = spendingRowsSince(walletRow, bounds.earliest);
    const day = sumSpendingInWindow(rows, walletRow, bounds.day);
    const week = sumSpendingInWindow(rows, walletRow, bounds.week);
    const month = sumSpendingInWindow(rows, walletRow, bounds.month);
    return {
      ok: true,
      ownerId: String(owner.party.id),
      ownerType: String(owner.party.type),
      currency: cur.currency,
      walletId: String(walletRow.wallet_id),
      spentTodayMinor: day.total,
      spentThisWeekMinor: week.total,
      spentThisMonthMinor: month.total,
      countedTransactions: month.count,
      windows: {
        timezone: C.BUDGET_TIMEZONE,
        dayStartsAt: bounds.day,
        weekStartsAt: bounds.week,
        monthStartsAt: bounds.month,
        evaluatedAt: now
      },
      /* 被统计的 transaction type 一并回带：审计该看得到"这个数是怎么
         数出来的"，而不是只能相信它。 */
      spendingTypes: C.BUDGET_SPENDING_TYPES
    };
  }

  /* ── 快照（§12）──────────────────────────────────────────────────────
     一次评估需要的**全部**输入，全部 canonical，全部由一个显式的 now
     决定：

       walletState / availableBalanceMinor   ← walletAvailability（P22-3）
       spentToday/Week/Month                  ← committed ledger 事实
       limits                                 ← 政策行（规则）

     刻意把"组装"与"判定"分开：判定是契约里的纯函数 evaluateBudget，
     组装在这里。于是后者可以在未来任何一个事务**内部**被重新调用
     （§31），而前者读到的仍然是同一套 canonical 事实。 */
  function buildBudgetSnapshot(input) {
    const o = input || {};
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, snapshot: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const owner = partyInput(o.ownerId);
    if (!owner.ok) return { ok: false, snapshot: null, errors: owner.errors };
    const ownerId = String(owner.party.id);
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return { ok: false, snapshot: null, errors: cur.errors };

    const policy = policyForOwner(ownerId);
    if (policy && String(policy.currency) !== cur.currency) {
      return {
        ok: false, snapshot: null, scopeMismatch: true,
        errors: ['budget-policy-currency-does-not-match'],
        policyId: policy.policyId, policyCurrency: policy.currency, currency: cur.currency
      };
    }

    const walletRow = db.prepare(SQL.selectWalletByOwner).get(ownerId, cur.currency);
    if (!walletRow) return { ok: false, snapshot: null, errors: ['wallet-not-found'], ownerId: ownerId, currency: cur.currency };

    const st = walletStateOfRow(walletRow);
    const availability = st.state === C.WALLET_STATE.READY ? walletAvailability(walletRow) : null;
    const availabilityOk = !!(availability && availability.ok === true);
    /* 不可信 ⇒ available 是 **null**，绝不是 0 —— 把"我不知道"回答成
       "没有钱"正是 P22-0 R5 的根因，只是换了一个入口（§17）。 */
    const available = availabilityOk ? availability.ledgerMinor - availability.reservedMinor : null;

    const amount = C.normalizeAmountMinor(o.amountMinor);
    if (!amount.ok) return { ok: false, snapshot: null, errors: amount.errors };

    /* ── 余额不可信时**仍然**返回一个快照，而不是 null ──────────────────
       这是一个刻意的选择，而且它把 §17 的两个要求同时满足：
         · 快照里每个"我们不知道"的数都是 **null**（不是 0）；
         · 决策是 DENY + WALLET_NOT_READY + systemFailure —— **系统故障**，
           不是"余额不足"。
       如果这里返回 snapshot:null，调用方只能看到一个"组装失败"，于是
       "wallet 的引用链断了"与"now 不是安全整数"会给出同一个回答，
       而那正是 §17 要求区分开的两件事。
       （开发期实测抓到了这一点：最初在这里提前返回，于是引用链一断就从
       WALLET_NOT_READY 退化成 POLICY_INPUT_NOT_STRUCTURED —— 一个把
       系统故障说成"输入不对"的答案。**而且那次还省掉了后面的窗口读取**，
       于是连"窗口也是未知的"都没被表达出来。） */
    if (!availabilityOk) {
      return {
        ok: true,
        errors: [],
        walletUnavailable: true,
        snapshot: Object.freeze({
          domain: C.DOMAIN,
          ownerId: Object.freeze({ type: owner.party.type, id: ownerId }),
          currency: cur.currency,
          walletId: String(walletRow.wallet_id),
          walletState: st.state,
          walletStateReason: st.reason || null,
          ledgerBalanceMinor: null,
          reservedBalanceMinor: null,
          availableBalanceMinor: null,
          walletIntegrity: (availability && availability.problems) || ['wallet-state-does-not-allow-spend'],
          spentTodayMinor: null,
          spentThisWeekMinor: null,
          spentThisMonthMinor: null,
          windows: null,
          countedTransactions: null,
          policyId: policy ? policy.policyId : null,
          policyStatus: policy ? policy.status : null,
          policyTermEndsAt: policy ? policy.termEndsAt : null,
          policyLimits: policy ? policy.limits : {},
          amountMinor: amount.amountMinor,
          now: now,
          timezone: C.BUDGET_TIMEZONE
        })
      };
    }

    const windows = spendingWindows({ ownerId: ownerId, currency: cur.currency, now: now });
    if (!windows.ok) {
      return {
        ok: true,
        errors: [],
        walletUnavailable: true,
        snapshot: Object.freeze({
          domain: C.DOMAIN,
          ownerId: Object.freeze({ type: owner.party.type, id: ownerId }),
          currency: cur.currency,
          walletId: String(walletRow.wallet_id),
          walletState: st.state,
          walletStateReason: st.reason || null,
          ledgerBalanceMinor: availability.ledgerMinor,
          reservedBalanceMinor: availability.reservedMinor,
          availableBalanceMinor: available,
          walletIntegrity: windows.errors,
          spentTodayMinor: null,
          spentThisWeekMinor: null,
          spentThisMonthMinor: null,
          windows: null,
          countedTransactions: null,
          policyId: policy ? policy.policyId : null,
          policyStatus: policy ? policy.status : null,
          policyTermEndsAt: policy ? policy.termEndsAt : null,
          policyLimits: policy ? policy.limits : {},
          amountMinor: amount.amountMinor,
          now: now,
          timezone: C.BUDGET_TIMEZONE
        })
      };
    }

    const policyLimits = policy ? policy.limits : {};
    return {
      ok: true,
      errors: [],
      snapshot: Object.freeze({
        domain: C.DOMAIN,
        ownerId: Object.freeze({ type: owner.party.type, id: ownerId }),
        currency: cur.currency,
        walletId: String(walletRow.wallet_id),
        walletState: st.state,
        walletStateReason: st.reason || null,
        ledgerBalanceMinor: availability.ledgerMinor,
        reservedBalanceMinor: availability.reservedMinor,
        availableBalanceMinor: available,
        walletIntegrity: [],
        spentTodayMinor: windows.spentTodayMinor,
        spentThisWeekMinor: windows.spentThisWeekMinor,
        spentThisMonthMinor: windows.spentThisMonthMinor,
        windows: windows.windows,
        countedTransactions: windows.countedTransactions,
        policyId: policy ? policy.policyId : null,
        policyStatus: policy ? policy.status : null,
        policyTermEndsAt: policy ? policy.termEndsAt : null,
        policyLimits: policyLimits,
        amountMinor: amount.amountMinor,
        now: now,
        timezone: C.BUDGET_TIMEZONE
      })
    };
  }

  /* ── 评估上下文的**唯一**构造点 ──────────────────────────────────────
     它产出的对象的所有键都来自 P22-1 §13 的 BUDGET_INPUT_KEYS 白名单
     （ownerId / currency / amountMinor / usage / limits / walletState /
     timestamp）。于是 evaluateBudget 的输入里**没有地方**可以放
     prompt / persona / relationship / llmOutput —— 契约的
     normalizeBudgetInput 会拒绝任何多出来的键，而这里连一个都没有。
     这不是"记得别传正文"，而是"没有那个字段"。 */
  function budgetContextFromSnapshot(snapshot) {
    /* 三个窗口累计在 canonical 层是 BigInt，但**评估上下文是一个数据
       对象**，而契约的 normalizeBudgetInput 明确要求 usage / limits 的
       值是标量（number / string / boolean）。因此这里显式走
       serializeAmountMinor 转成十进制字符串 —— 与 HTTP 面是同一套表示。
       刻意不写 `Number(v)`：那会在超过安全整数时静默丢精度，而这里的
       三个数正是"已经花了多少"，丢精度就是在伪造一次合规。 */
    const usage = {};
    for (const key of C.BUDGET_USAGE_WINDOW_KEYS) usage[key] = C.serializeAmountMinor(snapshot[key]);
    const limits = { availableBalanceMinor: C.serializeAmountMinor(snapshot.availableBalanceMinor) };
    for (const k of Object.keys(snapshot.policyLimits)) {
      limits[k] = k === C.COOLDOWN_KEY
        ? Number(snapshot.policyLimits[k])
        : C.serializeAmountMinor(snapshot.policyLimits[k]);
    }
    return {
      ownerId: snapshot.ownerId,
      currency: snapshot.currency,
      amountMinor: C.serializeAmountMinor(snapshot.amountMinor),
      walletState: snapshot.walletState,
      timestamp: snapshot.now,
      usage: usage,
      limits: limits
    };
  }

  function budgetEvaluationFromSnapshot(snapshot, policy) {
    if (snapshot.walletState !== C.WALLET_STATE.READY) {
      /* canonical 不可信 ⇒ 在**任何**规则判断之前就拒绝，而且带
         systemFailure:true。系统故障与业务拒绝必须可区分（§17）。 */
      return Object.assign(C.budgetDecision(C.BUDGET_DECISION.DENY, C.DENY_REASON.WALLET_NOT_READY, {
        errors: ['wallet-state-does-not-allow-spend'],
        priority: C.BUDGET_EVALUATION_PRIORITY[1],
        walletState: snapshot.walletState,
        walletStateReason: snapshot.walletStateReason,
        systemFailure: true
      }), { policyId: snapshot.policyId, currency: snapshot.currency });
    }
    /* READY 但**读不到**任何一项必需事实 —— 引用链断了、窗口求和失败、
       available 是未知。三种成因都是**系统故障**，因此它们共用这一条
       出口，而且都带 systemFailure:true 与具体的 integrity 列表。
       走到这里的路径里 availableBalanceMinor 必然是 null（快照只在
       availabilityOk 时才会填它），因此这一条同时覆盖了"unknown ≠ 0"。 */
    if (snapshot.availableBalanceMinor == null || snapshot.spentTodayMinor == null) {
      return Object.assign(C.budgetDecision(C.BUDGET_DECISION.DENY, C.DENY_REASON.WALLET_NOT_READY, {
        errors: ['wallet-availability-is-not-established'],
        priority: C.BUDGET_EVALUATION_PRIORITY[1],
        walletState: snapshot.walletState,
        integrity: snapshot.walletIntegrity,
        systemFailure: true
      }), { policyId: snapshot.policyId, currency: snapshot.currency });
    }
    const evaluated = C.evaluateBudget(policy, budgetContextFromSnapshot(snapshot));
    return Object.assign(evaluated, {
      policyId: snapshot.policyId,
      currency: snapshot.currency,
      /* 逐字说明：这是一次评估，产出的东西不是可执行的许可。
         见契约里 budgetDecision 的 snapshot 块。 */
      snapshotRef: {
        policyId: snapshot.policyId,
        walletId: snapshot.walletId,
        evaluatedAt: snapshot.now
      }
    });
  }

  /* ── evaluateBudgetFor（§18）：读，而且**只是**读 ─────────────────────
     整个函数体里没有任何 BEGIN / INSERT / UPDATE / DELETE。这一点由
     §11 与 §38 的断言逐字守住（"评估不会 reserve、不会动 ledger"）。
     这正是 §18 强调的那件事：**"评估报价"不能偷偷变成"接受报价"**。 */
  function evaluateBudgetFor(input) {
    requireOpen();
    const o = input || {};
    const scope = partyInput(o.ownerId);
    if (!scope.ok) return { ok: false, errors: scope.errors };
    const ownerId = String(scope.party.id);
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return { ok: false, errors: cur.errors };

    const built = buildBudgetSnapshot({
      ownerId: ownerId, currency: cur.currency, amountMinor: o.amountMinor, now: o.now
    });
    if (!built.ok) {
      /* 快照组不起来有两种成因，必须分开：
         ① 作用域不匹配 / 金额非法 / 钱包不存在 —— 这是一次**业务**
            拒绝，给出具名 reasonCode；
         ② 读失败（完整性检查不过、now 无法表示）—— 这是**系统**故障。 */
      const policy = policyForOwner(ownerId);
      if (built.scopeMismatch) {
        return {
          ok: true,
          decision: Object.assign(C.budgetDecision(C.BUDGET_DECISION.DENY, C.DENY_REASON.INVALID_CURRENCY, {
            errors: built.errors, priority: C.BUDGET_EVALUATION_PRIORITY[2],
            policyCurrency: built.policyCurrency, contextCurrency: built.currency
          }), { policyId: built.policyId, currency: built.currency }),
          snapshot: null
        };
      }
      if (built.errors.indexOf('wallet-not-found') >= 0) {
        /* 钱包不存在是**业务**结论，不是 systemFailure：一个还没有钱包的
           owner 不是"库坏了"，而是"这个作用域上还没有可用的余额事实"。
           两者的运维含义完全相反，因此它们必须是两个回答。 */
        return {
          ok: true,
          decision: Object.assign(C.budgetDecision(C.BUDGET_DECISION.DENY, C.DENY_REASON.WALLET_NOT_READY, {
            errors: ['no-wallet-in-this-scope'], priority: C.BUDGET_EVALUATION_PRIORITY[1],
            systemFailure: false
          }), { policyId: policy ? policy.policyId : null, currency: cur.currency }),
          snapshot: null
        };
      }
      return {
        ok: true,
        decision: Object.assign(C.budgetDecision(C.BUDGET_DECISION.DENY, C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, {
          errors: built.errors, priority: C.BUDGET_EVALUATION_PRIORITY[0], systemFailure: true
        }), { policyId: policy ? policy.policyId : null, currency: cur.currency }),
        snapshot: null
      };
    }
    const policy = built.snapshot.policyId == null ? null : policyForOwner(ownerId);
    return {
      ok: true,
      decision: budgetEvaluationFromSnapshot(built.snapshot, policy),
      snapshot: built.snapshot,
      /* 明写这一句，让调用方在**读**结果的时候就看到它。字段名刻意
         避开 Authorization 这个词：本文件的凭据边界逐字断言
         "Economy 不读 Authorization / Bearer"（boundary B6.3），
         而给那条安全断言开一个例外正是它最容易失效的方式。 */
      evaluatedOnly: true,
      notASpendPermit: 'ALLOW is a snapshot evaluation, not a spendable permission; re-evaluate inside the transaction that reserves',
      reserved: false
    };
  }

  /* 快照的对外形态：金额一律十进制字符串。
     `snapshot` 可能是 null（当**连快照都组装不起来**时 —— 例如 now 不是
     安全整数）。那是"我们没有东西可报告"，而不是"数字是 0"：因此这里
     返回 null，而调用点必须显式处理它。 */
  function serializeBudgetSnapshot(snapshot) {
    if (!snapshot) return null;
    return {
      domain: snapshot.domain,
      ownerId: snapshot.ownerId,
      currency: snapshot.currency,
      walletId: snapshot.walletId,
      walletState: snapshot.walletState,
      walletStateReason: snapshot.walletStateReason,
      ledgerBalanceMinor: C.serializeAmountMinor(snapshot.ledgerBalanceMinor),
      reservedBalanceMinor: C.serializeAmountMinor(snapshot.reservedBalanceMinor),
      availableBalanceMinor: C.serializeAmountMinor(snapshot.availableBalanceMinor),
      spentTodayMinor: C.serializeAmountMinor(snapshot.spentTodayMinor),
      spentThisWeekMinor: C.serializeAmountMinor(snapshot.spentThisWeekMinor),
      spentThisMonthMinor: C.serializeAmountMinor(snapshot.spentThisMonthMinor),
      windows: snapshot.windows,
      countedTransactions: snapshot.countedTransactions,
      policyId: snapshot.policyId,
      policyStatus: snapshot.policyStatus,
      policyTermEndsAt: snapshot.policyTermEndsAt,
      amountMinor: C.serializeAmountMinor(snapshot.amountMinor),
      now: snapshot.now,
      timezone: snapshot.timezone
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-4 · 预算政策的持久化（§20/§21/§22）
     ══════════════════════════════════════════════════════════════════ */

  function policyForOwner(ownerId) {
    const row = db.prepare(SQL.selectBudgetPolicyByOwner).get(String(ownerId));
    return row ? rowToBudgetPolicy(row) : null;
  }

  /* 政策的确定性身份：覆盖"这条规则是什么"，不含 policyId 与时间戳
     （两者都是执行时才知道的）。 */
  function policyFingerprint(payload) {
    return fingerprintOf(stableStringify({ scope: C.OPERATION_SCOPE.POLICY, request: payload }));
  }

  function policyLimitsSql(limits) {
    const byField = {};
    for (const entry of C.POLICY_LIMIT_TABLE) {
      const v = limits[entry.name];
      byField[entry.field] = v == null ? null : toSqlAmount(v, 'policy-' + entry.name);
    }
    const approval = limits.approvalThresholdMinor;
    byField.approval_above_minor = approval == null ? null : toSqlAmount(approval, 'policy-approval-threshold');
    byField.cooldown_ms = limits[C.COOLDOWN_KEY] == null ? null : Number(limits[C.COOLDOWN_KEY]);
    return byField;
  }

  /* ── putBudgetPolicy：create + update + disable，一个入口 ────────────
     为什么合成一个：它们是**同一个**幂等作用域（POLICY）下的同一类请求，
     而三个入口会让"同一个 key 既 create 又 disable"变成一个必须被解释
     的边界情况。用 `disable: true` 表达停用则是一个封闭的、可断言的开关。

     为什么"拒绝"整体回滚：与 reserve 同款（P22-3 §17）—— "这次改动没被
     接受"不是"一次改动失败了"，造一条 persisted 记录会把拒绝伪装成历史。

     `ifRevision` 是可选的乐观并发：给了一个不对的 revision 就拒绝，且
     拒绝时**不消耗** revision。政策是需要人类改的东西，"两个人同时改、
     后者静默覆盖前者"正是这里最该避免的失败。 */
  function putBudgetPolicy(input) {
    requireOpen();
    const o = input || {};
    const owner = partyInput(o.ownerId);
    if (!owner.ok) return { ok: false, denied: false, reasonCode: null, errors: owner.errors };
    if (owner.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, denied: false, reasonCode: null, errors: ['system-party-cannot-own-a-budget-policy'] };
    }
    const ownerId = String(owner.party.id);
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return denial(C.DENY_REASON.INVALID_CURRENCY, cur.errors);
    const limits = C.normalizePolicyLimits(o.limits);
    if (!limits.ok) return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, limits.errors);
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    let termEndsAt = null;
    if (o.termEndsAt != null) {
      const end = Number(o.termEndsAt);
      if (!Number.isSafeInteger(end) || end < 0) {
        return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, ['policy-term-ends-at-must-be-a-non-negative-safe-integer']);
      }
      termEndsAt = end;
    }
    let autonomyLevel = null;
    if (o.autonomyLevel != null) {
      const al = String(o.autonomyLevel);
      if (C.AUTONOMY_LEVELS.indexOf(al) < 0) {
        return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, ['policy-autonomy-level-not-in-closed-set']);
      }
      autonomyLevel = al;
    }
    if (typeof deps.ownerExists === 'function' && deps.ownerExists(owner.party) !== true) {
      return { ok: false, denied: false, reasonCode: null, errors: ['owner-not-found'] };
    }

    const now = clock();
    const existingRow = db.prepare(SQL.selectBudgetPolicyByOwner).get(ownerId);
    const existing = existingRow ? rowToBudgetPolicy(existingRow) : null;
    const disable = o.disable === true;
    /* 停用**只**改状态：限额一个字都不动（见 setPolicyStatus 的说明），
       因此重放/重新启用时不需要把五个数字猜回来。 */
    const effectiveLimits = disable && existing ? existing.limits : limits.limits;
    const effectiveStatus = disable ? C.POLICY_STATUS.DISABLED : C.POLICY_STATUS.ACTIVE;
    const effectiveTerm = disable && existing ? existing.termEndsAt : termEndsAt;
    const effectiveAutonomy = disable && existing ? existing.autonomyLevel : autonomyLevel;

    const fingerprint = policyFingerprint({
      ownerId: ownerId, ownerType: String(owner.party.type), currency: cur.currency,
      status: effectiveStatus,
      limits: Object.keys(effectiveLimits).sort().map(k => k + '=' + C.serializeAmountMinor(effectiveLimits[k]) + (typeof effectiveLimits[k] === 'number' ? '' : '')).join(','),
      cooldownMs: effectiveLimits[C.COOLDOWN_KEY] == null ? null : Number(effectiveLimits[C.COOLDOWN_KEY]),
      termEndsAt: effectiveTerm, autonomyLevel: effectiveAutonomy
    });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.POLICY, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.POLICY, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    if (existing && o.ifRevision != null && Number(o.ifRevision) !== existing.revision) {
      return {
        ok: false, denied: false, reasonCode: null,
        errors: ['budget-policy-revision-mismatch'],
        expectedRevision: Number(o.ifRevision), actualRevision: existing.revision, policyId: existing.policyId
      };
    }

    const policyId = existing ? existing.policyId : (o.policyId != null ? o.policyId : nextId('BUDGET_POLICY'));
    if (!C.isEconomyId('BUDGET_POLICY', policyId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['budget-policy-id-not-canonical'] };
    }
    const shape = C.validateBudgetPolicy({
      policyId: String(policyId), ownerId: owner.party, currency: cur.currency,
      status: effectiveStatus, limits: effectiveLimits, termEndsAt: effectiveTerm,
      autonomyLevel: effectiveAutonomy
    });
    if (!shape.ok) return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, shape.errors);

    const at = now;
    const created = !existing;
    let committed = null;
    try {
      withTransaction(() => {
        /* 事务内重读：BEGIN IMMEDIATE 之后写锁已经拿到，因此这一段看到的
           政策行不可能被另一个 writer 改动 —— "检查 revision"与"写新
           revision"发生在同一个锁里。 */
        const currentRow = db.prepare(SQL.selectBudgetPolicyByOwner).get(ownerId);
        if (!currentRow && !created) throw refuse(null, ['budget-policy-disappeared-inside-the-transaction']);
        if (currentRow && created) throw refuse(null, ['budget-policy-was-created-concurrently']);
        if (currentRow && o.ifRevision != null) {
          const actual = Number(currentRow.revision);
          if (actual !== Number(o.ifRevision)) {
            throw refuse(null, ['budget-policy-revision-mismatch'], { expectedRevision: Number(o.ifRevision), actualRevision: actual });
          }
        }
        const revision = allocateRevision();
        const cols = policyLimitsSql(effectiveLimits);

        if (created) {
          db.prepare(SQL.insertBudgetPolicy).run(
            String(policyId), ownerId, String(owner.party.type), cur.currency, effectiveStatus,
            cols.max_per_tx_minor, cols.max_per_day_minor, cols.max_per_week_minor, cols.max_per_month_minor,
            cols.approval_above_minor, cols.cooldown_ms, effectiveAutonomy,
            effectiveTerm == null ? null : Number(effectiveTerm), 0, null,
            key.key, fingerprint, Number(revision), Number(at), Number(at)
          );
          faultPoint('after-policy-insert');
        } else {
          db.prepare(SQL.upsertBudgetPolicy).run(
            cur.currency, effectiveStatus,
            cols.max_per_tx_minor, cols.max_per_day_minor, cols.max_per_week_minor, cols.max_per_month_minor,
            cols.approval_above_minor, cols.cooldown_ms, effectiveAutonomy,
            effectiveTerm == null ? null : Number(effectiveTerm),
            /* ── 重新启用必须**清掉**硬停用标记（P22-4 开发期抓到的一个真实缺陷）
               第一版的写法是"停用时写 1，否则保留原值"，于是流程
               "停用 → 重新启用"之后行上仍然是 hard_stop=1，而
               policyEffectiveness 看到 hardStop 就判不生效 —— **政策永远
               回不来了**，而 status 列明明写着 ACTIVE。
               那是一种特别难发现的坏：两个字段各自都自洽（status=ACTIVE
               是对的、hardStop 曾经也是对的），只有把它们放在一起看才
               矛盾；而 policyEffectiveness 读的是 hardStop。
               修法是把这一个开关绑定到**本次写入的意图**上：disable 为真
               就置 1 并记时刻，为假就置 0 并清空时刻。于是
               "status 与 hardStop 必须一致"不再是一条纪律，而是同一个
               布尔值的两种表达。 */
            disable ? 1 : 0, disable ? Number(at) : null,
            key.key, fingerprint, Number(revision), Number(at), String(policyId)
          );
          faultPoint('after-policy-update');
        }

        const row = db.prepare(SQL.selectBudgetPolicy).get(String(policyId));
        if (!row) throw refuse(null, ['budget-policy-row-missing-after-write']);
        const view = rowToBudgetPolicy(row);
        const eventKind = created ? C.EVENT_TYPE.BUDGET_POLICY_CREATED
          : (disable ? C.EVENT_TYPE.BUDGET_POLICY_DISABLED : C.EVENT_TYPE.BUDGET_POLICY_UPDATED);
        const result = {
          domain: C.DOMAIN,
          policyId: String(policyId),
          created: created,
          eventKind: String(eventKind),
          previousStatus: existing ? existing.status : null,
          previousLimits: existing ? serializePolicyLimits(existing.limits) : null,
          policy: serializeBudgetPolicy(view),
          revision: Number(revision),
          at: Number(at),
          idempotencyKey: key.key,
          /* 逐字写明：改规则**不是**经济运动。审计里"政策变了"与
             "账本动了"必须一眼可分。 */
          ledgerMutation: false
        };
        appendChange({
          revision: Number(revision), kind: String(eventKind),
          entityId: String(policyId), transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            policyId: String(policyId),
            ownerId: ownerId,
            ownerType: String(owner.party.type),
            currency: cur.currency,
            status: effectiveStatus,
            hardStop: disable,
            previousStatus: existing ? existing.status : null,
            limits: serializePolicyLimits(effectiveLimits),
            termEndsAt: effectiveTerm == null ? null : Number(effectiveTerm),
            autonomyLevel: effectiveAutonomy,
            /* 逐字：这条 change 没有产生任何 ledger 事实。 */
            ledgerMutation: false
          }
        });
        faultPoint('before-policy-change-log');

        writeOperationIdempotency(C.OPERATION_SCOPE.POLICY, key.key, fingerprint, {
          operationId: null, reservationId: null, transactionId: null
        }, result, revision, at);
        faultPoint('before-policy-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger('economy-budget-policy-written', {
      policyId: committed.policyId, ownerId: ownerId, currency: cur.currency,
      status: effectiveStatus, created: created, revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  function serializePolicyLimits(limits) {
    const out = {};
    for (const k of Object.keys(limits)) {
      out[k] = k === C.COOLDOWN_KEY ? Number(limits[k]) : C.serializeAmountMinor(limits[k]);
    }
    return out;
  }

  function serializeBudgetPolicy(view) {
    return {
      domain: view.domain,
      namespace: view.namespace,
      policyId: view.policyId,
      ownerId: view.ownerId,
      currency: view.currency,
      status: view.status,
      limits: serializePolicyLimits(view.limits),
      termEndsAt: view.termEndsAt,
      expiredByTerm: view.expiredByTerm === true,
      hardStop: view.hardStop === true,
      hardStoppedAt: view.hardStoppedAt,
      autonomyLevel: view.autonomyLevel,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt
    };
  }

  function getBudgetPolicy(input) {
    requireOpen();
    const o = typeof input === 'string' ? { ownerId: input } : (input || {});
    let row = null;
    if (o.policyId) row = db.prepare(SQL.selectBudgetPolicy).get(String(o.policyId));
    else if (o.ownerId) row = db.prepare(SQL.selectBudgetPolicyByOwner).get(String(o.ownerId));
    if (!row) return { ok: false, policy: null, errors: ['budget-policy-not-found'] };
    return { ok: true, policy: rowToBudgetPolicy(row) };
  }

  function listBudgetPolicies(options) {
    options = options || {};
    requireOpen();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    let rows;
    if (options.status != null) {
      if (!C.isPolicyStatus(options.status)) {
        return { ok: false, policies: null, errors: ['policy-status-not-in-closed-set'] };
      }
      rows = db.prepare(SQL.selectBudgetPoliciesByStatus).all(String(options.status), limit);
    } else {
      rows = db.prepare(SQL.selectBudgetPolicies).all(limit);
    }
    if (options.ownerId) rows = rows.filter(r => String(r.owner_id) === String(options.ownerId));
    return { ok: true, policies: rows.map(rowToBudgetPolicy) };
  }

  /* ── expireDuePolicies（§10 同一条纪律用到政策上）────────────────────
     显式 now、确定性、幂等、分批、每笔一个自己的事务、**没有定时器**。

     与 reservation / quote 的关键差别：政策到期的资源后果是**零**——
     没有钱要还、没有预留要放、没有报价要作废。因此这里的 mutation 只写
     一行状态并留一条审计。 */
  function expirePolicy(input) {
    requireOpen();
    const o = input || {};
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const policyId = o.policyId;
    if (!C.isEconomyId('BUDGET_POLICY', policyId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['budget-policy-id-not-canonical'] };
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey != null ? o.idempotencyKey : ('econ.sweep.policy+' + String(policyId)));
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const row = db.prepare(SQL.selectBudgetPolicy).get(String(policyId));
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['budget-policy-not-found'] };
    const fingerprint = policyFingerprint({ policyId: String(policyId), termExpiry: true });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.POLICY, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.POLICY, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    if (String(row.status) !== C.POLICY_STATUS.ACTIVE) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['budget-policy-is-already-terminal'],
        { policyStatus: String(row.status) });
    }
    if (row.term_ends_at == null) {
      return { ok: false, denied: false, reasonCode: null, errors: ['budget-policy-has-no-term-ends-at'] };
    }
    if (Number(row.term_ends_at) > now) {
      return { ok: false, denied: false, reasonCode: null, errors: ['budget-policy-term-not-yet-due'], termEndsAt: Number(row.term_ends_at), now: now };
    }

    let committed = null;
    try {
      withTransaction(() => {
        const current = db.prepare(SQL.selectBudgetPolicy).get(String(policyId));
        if (!current) throw refuse(null, ['budget-policy-not-found']);
        if (String(current.status) !== C.POLICY_STATUS.ACTIVE) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['budget-policy-is-already-terminal']);
        }
        if (current.term_ends_at == null || Number(current.term_ends_at) > now) {
          throw refuse(null, ['budget-policy-term-not-yet-due']);
        }
        const revision = allocateRevision();
        faultPoint('after-policy-expire-validated');
        const moved = db.prepare(SQL.setPolicyStatus).run(
          C.POLICY_STATUS.DISABLED, Number(current.hard_stop), current.hard_stopped_at,
          Number(revision), Number(now), String(policyId), C.POLICY_STATUS.ACTIVE
        );
        if (Number(moved.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['budget-policy-transition-affected-no-row']);
        }
        faultPoint('after-policy-expired');
        const result = {
          domain: C.DOMAIN,
          policyId: String(policyId),
          status: C.POLICY_STATUS.DISABLED,
          reason: C.POLICY_TERM.EXPIRED,
          termEndsAt: Number(current.term_ends_at),
          revision: Number(revision),
          at: Number(now),
          ledgerMutation: false
        };
        appendChange({
          revision: Number(revision), kind: C.EVENT_TYPE.BUDGET_POLICY_EXPIRED,
          entityId: String(policyId), transactionId: null, walletId: null, at: Number(now),
          payload: {
            domain: C.DOMAIN, policyId: String(policyId), ownerId: String(current.owner_id),
            currency: String(current.currency), termEndsAt: Number(current.term_ends_at),
            ledgerMutation: false
          }
        });
        faultPoint('before-policy-expire-change-log');
        writeOperationIdempotency(C.OPERATION_SCOPE.POLICY, key.key, fingerprint, {
          operationId: null, reservationId: null, transactionId: null
        }, result, revision, now);
        faultPoint('before-policy-expire-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }
    pruneOperationIdempotency(now);
    logger('economy-budget-policy-expired', { policyId: committed.policyId, revision: committed.revision });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  function expireDuePolicies(input) {
    requireOpen();
    const o = input || {};
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const limit = Math.max(1, Math.min(1000, Number(o.limit) || 100));
    const due = db.prepare(SQL.selectPoliciesDue).all(C.POLICY_STATUS.ACTIVE, Number(now), limit);
    const expired = [];
    const skipped = [];
    const failed = [];
    for (const row of due) {
      const policyId = String(row.policy_id);
      const out = expirePolicy({ policyId: policyId, now: now });
      if (out.ok === true && out.replayed === true) skipped.push({ policyId: policyId, reason: 'already-expired-by-an-earlier-sweep' });
      else if (out.ok === true) expired.push(out.result);
      else if (out.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED) skipped.push({ policyId: policyId, reason: 'already-terminal' });
      else failed.push({ policyId: policyId, errors: out.errors, reasonCode: out.reasonCode || null });
    }
    return { ok: true, now: now, limit: limit, scanned: due.length, expired: expired, skipped: skipped, failed: failed, usedTimers: false };
  }

  function countBudgetPolicies() { return Number((db.prepare(SQL.countBudgetPolicies).get() || {}).c || 0); }
  function countBudgetPoliciesByStatus(status) {
    return Number((db.prepare(SQL.countBudgetPoliciesByStatus).get(String(status)) || {}).c || 0);
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-4 · 报价（§6/§7/§8/§9/§10/§11）
     ══════════════════════════════════════════════════════════════════ */

  function rowToQuote(row, options) {
    const o = options || {};
    const expiresAt = Number(row.expires_at);
    const state = String(row.state);
    /* "到期了没有"是一个**比较**（P22-3 §14 的纪律搬到报价上）。比较的
       右边默认是**这个 store 的时钟**，但可以被显式覆盖 ——
       evaluateQuote 接受一个显式的 now，而那份快照里的每个判断都必须
       用**同一个** now。否则会出现一个自相矛盾的答案：预算窗口是按显式
       now 算的，而"报价过没过期"是按环境时钟算的（开发期实测踩到：
       evaluateQuote({now: T+120s}) 返回 ALLOW，而报价早已过期）。 */
    const referenceNow = o.now != null ? Number(o.now) : clock();
    const expiredByTime = Number.isFinite(expiresAt) && expiresAt <= referenceNow;
    return {
      domain: C.DOMAIN,
      namespace: C.NAMESPACES.QUOTE,
      quoteId: String(row.quote_id),
      productId: String(row.product_id),
      buyerId: Object.freeze({ type: String(row.buyer_type), id: String(row.buyer_id) }),
      recipientId: row.recipient_id == null ? null : Object.freeze({
        type: String(row.recipient_type == null ? '' : row.recipient_type), id: String(row.recipient_id)
      }),
      currency: String(row.currency),
      amountMinor: fromSqlAmount(row.amount_minor, 'quote-amount'),
      quantity: Number(row.quantity),
      kind: String(row.quote_kind),
      settlementType: String(row.service_role),
      state: state,
      terminal: C.QUOTE_TERMINAL_STATES.indexOf(state) >= 0,
      expiresAt: expiresAt,
      expiredByTime: expiredByTime,
      consumptionRequiredNow: expiredByTime && state === C.QUOTE_STATE.OPEN,
      predecessorQuoteId: row.predecessor_quote_id == null ? null : String(row.predecessor_quote_id),
      idempotencyKey: String(row.idempotency_key),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  /* 对外形态。`settlementType` 是**派生并冻结**的结算 transaction type，
     与"将来怎么结算"同义；`kind` 是报价的种类。两者都在这里，因为
     把"价格命题"与"它的结算形态"分开看是这份设计的要点。 */
  function serializeQuote(view) {
    return {
      domain: view.domain,
      namespace: view.namespace,
      quoteId: view.quoteId,
      productId: view.productId,
      buyerId: view.buyerId,
      recipientId: view.recipientId,
      currency: view.currency,
      amountMinor: C.serializeAmountMinor(view.amountMinor),
      quantity: view.quantity,
      kind: view.kind,
      settlementType: view.settlementType,
      state: view.state,
      terminal: view.terminal === true,
      expiresAt: view.expiresAt,
      expiredByTime: view.expiredByTime === true,
      predecessorQuoteId: view.predecessorQuoteId,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt
    };
  }

  function quoteFingerprint(payload) {
    return fingerprintOf(stableStringify({ scope: C.OPERATION_SCOPE.QUOTE, request: payload }));
  }

  /* ── createQuote（§6/§7/§11）─────────────────────────────────────────
     一份报价**只描述**：什么、多少钱、到什么时候。它不锁任何资源。

     结构性证据（而不是注释）：本函数体里没有一次 applyReservedCache、
     没有一次 ledger 写入、没有一次钱包缓存写入。测试的 S 组在创建报价
     前后逐项比对 ledger 求和、reserved 求和、available 与 revision
     （只有报价自己的 revision 会动，因为"创建了一份报价"是一条审计事实）。

     报价**不做**的事，逐条：
       · 不 reserve（§7：Quote ≠ Reservation）；
       · 不改 wallet / reserved 缓存；
       · 不写 ledger transaction；
       · 不碰 provider（§24）。

     为什么 expiresAt 必填且必须是**绝对**毫秒时间戳：与 reservation 同款
     （P22-3 §14）。相对时长会让"这次请求是什么"依赖读时钟的那一刻，于是
     同一请求的两次重放会算出两个 expiresAt，指纹随之不同 —— 幂等性在最
     需要它的重试路径上失效。 */
  function createQuote(input) {
    requireOpen();
    const o = input || {};
    const buyer = partyInput(o.buyerId != null ? o.buyerId : o.ownerId);
    if (!buyer.ok) return { ok: false, denied: false, reasonCode: null, errors: buyer.errors };
    if (buyer.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, denied: false, reasonCode: null, errors: ['system-party-cannot-buy'] };
    }
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return denial(C.DENY_REASON.INVALID_CURRENCY, cur.errors);
    const amt = C.normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) return denial(C.DENY_REASON.INVALID_AMOUNT, amt.errors);
    /* 0 元报价没有价格内容，却会占一行、消耗一个 revision，并让
       "有几份报价"这个计数失去意义。与 reserve 拒绝 0 金额同款。 */
    if (amt.amountMinor === 0n) {
      return denial(C.DENY_REASON.INVALID_AMOUNT, ['quote-amount-must-be-positive']);
    }
    const qty = o.quantity == null ? 1 : Number(o.quantity);
    if (!Number.isSafeInteger(qty) || qty < 1) {
      return denial(C.DENY_REASON.INVALID_AMOUNT, ['quote-quantity-must-be-positive-safe-integer']);
    }
    const exp = normalizeExpiresAt(o.expiresAt);
    if (!exp.ok) return { ok: false, denied: false, reasonCode: null, errors: exp.errors };
    const kind = o.kind == null ? C.QUOTE_KIND.PURCHASE : String(o.kind);
    if (!C.isQuoteKind(kind)) {
      return denial(C.DENY_REASON.EFFECT_NOT_ALLOWED, ['quote-kind-not-in-closed-set'], { allowed: C.QUOTE_KINDS });
    }
    /* ── productId 的两种形态（P22-5 修好的一个真实缺陷）────────────────
       P22-4 这里写的是 formatEconomyId('PRODUCT', o.productId)，也就是把
       入参当成**后缀**。对 'widget' 那种写法没问题；但如果调用方给的是
       一个**已经是 canonical 的** id（P22-5 的 createProductQuote 必须给
       全 id，因为它从 products 行读出来的就是全 id），结果会是
       `econ_product_econ_product_x` —— 一个指向不存在商品的 id。

       那不是"两种风格"，那是一个**悬空引用**：报价会被写下来，而它的
       provenance 永远查不到。因此这里把规范化改成"已经是 canonical 就
       原样使用，否则才补前缀"。
       这是**加法**：任何以裸后缀传入的调用（P22-4 的全部测试与用法）得到
       逐字相同的结果；唯一被改变的是那种以前必然产生死引用的输入。 */
    const productId = C.isEconomyId('PRODUCT', o.productId)
      ? String(o.productId)
      : C.formatEconomyId('PRODUCT', String(o.productId == null ? '' : o.productId)).id;
    if (!C.isEconomyId('PRODUCT', productId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['product-id-not-canonical'] };
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    let recipient = null;
    if (o.recipientId != null && String(o.recipientId).trim() !== '') {
      const r = partyInput(o.recipientId);
      if (!r.ok) return denial(C.DENY_REASON.PARTY_NOT_ALLOWED, r.errors);
      recipient = r.party;
    }
    /* 买给别人的报价只有一种形态是自洽的：GIFT。
       一份 PURCHASE 报价带着 recipientId 意味着"我要买给自己、但记在
       别人头上"，而那在结算时会同时写两个意思。 */
    if (recipient && kind !== C.QUOTE_KIND.GIFT) {
      return denial(C.DENY_REASON.PARTY_NOT_ALLOWED, ['a-recipient-requires-the-gift-quote-kind'], { kind: kind });
    }
    if (kind === C.QUOTE_KIND.GIFT && !recipient) {
      return denial(C.DENY_REASON.PARTY_NOT_ALLOWED, ['the-gift-quote-kind-requires-a-recipient']);
    }

    const buyerId = String(buyer.party.id);
    if (typeof deps.ownerExists === 'function' && deps.ownerExists(buyer.party) !== true) {
      return { ok: false, denied: false, reasonCode: null, errors: ['owner-not-found'] };
    }
    /* 商品是否存在由**注入的谓词**回答（与 owner 同款，P22-2 §16）。
       未注入时不做校验 —— 注入缝是 P22-4 的公开面，**语义一个字不改**。
       P22-5 补上的是另一半：目录**真的存在**时（本 store 自己拥有它），
       这条 primitive 必须尊重它的状态。 */
    if (typeof deps.productExists === 'function' && deps.productExists(productId) !== true) {
      return denial(C.DENY_REASON.PRODUCT_DISABLED, ['product-not-found'], { productId: productId });
    }
    /* ── P22-5：raw primitive 现在**认识**真实的目录 ─────────────────────
       行为只在一个方向上加严，而且只在"目录里真的有这个 productId"时：
       一件被 disable / retire 的商品，或者它所在货架被关掉之后，不能
       再通过 raw createQuote 生成新报价。

       为什么这条加强不破坏 P22-4：那个阶段的库里**没有** products 表，
       因而这条查询永远返回 undefined —— P22-4 的全部断言继续逐字成立
       （它们的 productId 都是随手起的 econ_product_*）。真正被改写的只有
       "目录里确实有这件商品、而它已经不再卖"这一种新情况，而它在
       P22-5 之前根本不可表示。
       注意这里**刻意不**改用 PRODUCT_NOT_FOUND：raw primitive 报的是
       PRODUCT_DISABLED（P22-4 冻结的行为），product-backed 路径才用
       新的 PRODUCT_NOT_FOUND。 */
    const catalogRow = db.prepare(SQL.selectProduct).get(productId);
    if (catalogRow) {
      const availability = productAvailabilityForQuote(productId);
      if (!availability.ok) return availability.denial;
    }

    /* 报价必须挂在一个**真实存在**的钱包上：一份"买不起也存不进"的报价
       是一张空头支票。这一步是读，不改任何东西。
       ── 为什么它排在幂等闸门**之后** ─────────────────────────────────
       "这个请求做过没有"是第一个问题，而"它现在能不能做"是第二个。
       顺序反了会产生一个自相矛盾的答案：同一个 key 换个买家（或换个
       币种）重放时，第二次会因为"那个买家没有钱包"被拒 —— 而调用方问的
       是"我那次请求到底成没成"，正确回答是 IDEMPOTENCY_CONFLICT。
       （开发期实测踩到：H 组的"同 key 不同买家/币种"两条拿到的是
       wallet-not-found 而不是冲突。） */
    const settlementType = C.settlementTypeOfQuoteKind(kind);
    const predecessor = o.predecessorQuoteId == null ? null : String(o.predecessorQuoteId);
    if (predecessor != null && !C.isEconomyId('QUOTE', predecessor)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['predecessor-quote-id-not-canonical'] };
    }
    const now = clock();
    const fingerprint = quoteFingerprint({
      productId: productId,
      buyerId: buyerId,
      buyerType: String(buyer.party.type),
      recipientId: recipient ? recipient.id : null,
      currency: cur.currency,
      amountMinor: C.serializeAmountMinor(amt.amountMinor),
      quantity: qty,
      kind: kind,
      expiresAt: exp.expiresAt
      /* 刻意**不含** quoteId（§11）与 predecessorQuoteId：前者是执行时
         才知道的，后者是"这份报价替代了哪一份"的元信息，不改变
         "这次请求是什么"。 */
    });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.QUOTE, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.QUOTE, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    /* 报价必须挂在一个**真实存在**的钱包上 —— 排在幂等闸门**之后**，
       理由见上面那段说明。 */
    const walletRow = db.prepare(SQL.selectWalletByOwner).get(buyerId, cur.currency);
    if (!walletRow) return { ok: false, denied: false, reasonCode: null, errors: ['wallet-not-found'] };

    if (exp.expiresAt <= now) {
      return denial(C.DENY_REASON.QUOTE_EXPIRED,
        ['quote-expires-at-is-not-in-the-future'], { expiresAt: exp.expiresAt, now: now });
    }

    const quoteId = o.quoteId != null ? o.quoteId : nextId('QUOTE');
    if (!C.isEconomyId('QUOTE', quoteId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['quote-id-not-canonical'] };
    }
    const shape = C.validateQuote({
      quoteId: String(quoteId), productId: productId, buyerId: buyerId, recipientId: recipient ? recipient.id : null,
      currency: cur.currency, amountMinor: amt.amountMinor, quantity: qty, kind: kind,
      expiresAt: exp.expiresAt, state: C.QUOTE_STATE.OPEN, createdAt: now
    }, now);
    if (!shape.ok) return denial(C.DENY_REASON.QUOTE_MISMATCH, shape.errors);
    /* ── 链上的唯一性：一份被替代的报价只能有一条后继 ─────────────────
       predecessor_quote_id 上有一条 UNIQUE 索引，因此第二次插入会撞约束。
       这里**先显式查一次**，理由是一条 SQLite 约束错误不是业务语言：
       调用方拿到 ERR_SQLITE_ERROR 之后不知道该说什么，而"这份报价已经
       有过一次重新报价"是一句可以被上层处理的话。索引仍然在（并发下
       它才是权威，见下面 insertQuote 的 try/catch）。 */
    if (predecessor != null) {
      const successor = db.prepare(SQL.selectQuoteByPredecessor).get(String(predecessor));
      if (successor) {
        return denial(C.DENY_REASON.DUPLICATE_REQUEST, ['this-quote-already-has-a-successor'], {
          predecessorQuoteId: String(predecessor),
          successorQuoteId: String(successor.quote_id)
        });
      }
    }

    const at = now;
    let committed = null;
    try {
      withTransaction(() => {
        const revision = allocateRevision();
        db.prepare(SQL.insertQuote).run(
          String(quoteId), productId, buyerId, String(buyer.party.type),
          recipient ? recipient.id : null, recipient ? recipient.type : null,
          cur.currency, toSqlAmount(amt.amountMinor, 'quote-amount'), Number(qty),
          kind, String(settlementType), C.QUOTE_STATE.OPEN, Number(exp.expiresAt),
          predecessor, key.key, fingerprint, Number(revision), Number(at), Number(at)
        );
        faultPoint('after-quote-insert');

        const row = db.prepare(SQL.selectQuote).get(String(quoteId));
        if (!row) throw refuse(null, ['quote-row-missing-after-write']);
        const view = rowToQuote(row);
        const result = {
          domain: C.DOMAIN,
          quoteId: String(quoteId),
          productId: productId,
          buyerId: buyerId,
          recipientId: recipient ? recipient.id : null,
          currency: cur.currency,
          amountMinor: C.serializeAmountMinor(amt.amountMinor),
          quantity: Number(qty),
          kind: kind,
          settlementType: String(settlementType),
          state: C.QUOTE_STATE.OPEN,
          expiresAt: Number(exp.expiresAt),
          revision: Number(revision),
          at: Number(at),
          idempotencyKey: key.key,
          quote: serializeQuote(view),
          /* 逐字写明：一份报价没有锁住任何东西。 */
          reservedFunds: false,
          ledgerMutation: false
        };
        appendChange({
          revision: Number(revision), kind: C.EVENT_TYPE.QUOTE_CREATED,
          entityId: String(quoteId), transactionId: null, walletId: String(walletRow.wallet_id), at: Number(at),
          payload: {
            domain: C.DOMAIN,
            quoteId: String(quoteId),
            productId: productId,
            buyerId: buyerId,
            currency: cur.currency,
            amountMinor: C.serializeAmountMinor(amt.amountMinor),
            quantity: Number(qty),
            kind: kind,
            settlementType: String(settlementType),
            state: C.QUOTE_STATE.OPEN,
            expiresAt: Number(exp.expiresAt),
            predecessorQuoteId: predecessor,
            reservedFunds: false,
            ledgerMutation: false
          }
        });
        faultPoint('before-quote-change-log');
        writeOperationIdempotency(C.OPERATION_SCOPE.QUOTE, key.key, fingerprint, {
          operationId: null, reservationId: null, transactionId: null
        }, result, revision, at);
        faultPoint('before-quote-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      /* ── 并发下的兜底：另一个连接可能在我们查过之后插入了后继 ─────────
         UNIQUE 索引才是权威，而这里把那个约束错误翻译成**同一句**拒绝 ——
         于是无论先后，调用方看到的都是同一种失败（而不是一半人拿到
         DUPLICATE_REQUEST、另一半人拿到一次 SQLite 崩溃）。 */
      if (!refusal) {
        if (predecessor != null && /UNIQUE constraint failed/.test(String(error && error.message)) &&
          String(error.message).indexOf('predecessor_quote_id') >= 0) {
          return denial(C.DENY_REASON.DUPLICATE_REQUEST, ['this-quote-already-has-a-successor'], {
            predecessorQuoteId: String(predecessor)
          });
        }
        throw error;
      }
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger('economy-quote-created', {
      quoteId: committed.quoteId, buyerId: buyerId, currency: cur.currency,
      kind: committed.kind, revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  function getQuote(input) {
    requireOpen();
    const o = typeof input === 'string' ? { quoteId: input } : (input || {});
    if (!o.quoteId) return { ok: false, quote: null, errors: ['quote-id-required'] };
    const row = db.prepare(SQL.selectQuote).get(String(o.quoteId));
    if (!row) return { ok: false, quote: null, errors: ['quote-not-found'] };
    /* ── P22-5 §22：来历是**可选的**额外信息，不是报价的一部分 ──────────
       只有显式要求时才去读 products 表。这条设计本身就在说那句话：
       报价的可解释性**不依赖**商品行是否存在（若依赖，这里就必须无条件
       查询，并在查不到时让整条读失败）。 */
    if (o.withProvenance === true) {
      return {
        ok: true,
        quote: rowToQuote(row, { now: o.now }),
        productProvenance: productProvenanceOf(String(row.product_id))
      };
    }
    return { ok: true, quote: rowToQuote(row, { now: o.now }) };
  }

  function listQuotes(options) {
    options = options || {};
    requireOpen();
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const state = options.state == null ? null : String(options.state);
    if (state != null && !C.isQuoteState(state)) {
      return { ok: false, quotes: null, errors: ['quote-state-not-in-closed-set'] };
    }
    let rows;
    if (options.buyerId && state) rows = db.prepare(SQL.selectQuotesByBuyerAndState).all(String(options.buyerId), state, limit);
    else if (options.buyerId) rows = db.prepare(SQL.selectQuotesByBuyer).all(String(options.buyerId), limit);
    else if (state) rows = db.prepare(SQL.selectQuotesByState).all(state, limit);
    else rows = db.prepare(SQL.selectQuotes).all(limit);
    return { ok: true, quotes: rows.map(r => rowToQuote(r, { now: options.now })) };
  }

  /* ── expireQuote / expireDueQuotes（§10）─────────────────────────────
     与 reservation 的到期**逐条同构**：显式 now、确定性、幂等、分批、
     每份一个自己的事务、没有定时器、不碰终态。

     资源后果是零：过期一份报价**不**释放任何东西（因为它从来没有锁住
     任何东西）。因此这里既不写 ledger，也不动 reserved 缓存 ——
     这一点在测试里是逐字断言的（过期前后 ledger 求和、reserved 求和、
     available 全部不变）。 */
  function expireQuote(input) {
    requireOpen();
    const o = input || {};
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const quoteId = o.quoteId;
    if (!C.isEconomyId('QUOTE', quoteId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['quote-id-not-canonical'] };
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey != null ? o.idempotencyKey : ('econ.sweep.quote+' + String(quoteId)));
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const row = db.prepare(SQL.selectQuote).get(String(quoteId));
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['quote-not-found'] };
    /* 幂等闸门排在状态检查之前 —— 与 P22-3 §19 同一条纪律：一个已经成功
       过的到期请求，它的重放必须返回当初那个结果，而不是"声明已终态"。 */
    const fingerprint = quoteFingerprint({ quoteId: String(quoteId), expiration: true });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.QUOTE, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.QUOTE, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    if (String(row.state) !== C.QUOTE_STATE.OPEN) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['quote-is-already-terminal'],
        { quoteState: String(row.state) });
    }
    if (Number(row.expires_at) > now) {
      return { ok: false, denied: false, reasonCode: null, errors: ['quote-not-yet-due'], expiresAt: Number(row.expires_at), now: now };
    }

    let committed = null;
    try {
      withTransaction(() => {
        const current = db.prepare(SQL.selectQuote).get(String(quoteId));
        if (!current) throw refuse(null, ['quote-not-found']);
        /* 状态机被**执行**一次，而不是直接写终值：OPEN → EXPIRED 必须
           是允许的转移，而 CONSUMED → EXPIRED 必须不是。 */
        const gate = C.assertQuoteTransition(String(current.state), C.QUOTE_STATE.EXPIRED);
        if (!gate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, gate.errors, { detail: gate.detail || null });
        if (Number(current.expires_at) > now) throw refuse(null, ['quote-not-yet-due']);
        const revision = allocateRevision();
        faultPoint('after-quote-expire-validated');
        /* `AND state=?`（setQuoteState 的最后一个参数）让"终态不可回退"
           成为一条并发安全的 SQL 约束：第二次推进 changes=0 ⇒ 拒绝。 */
        const moved = db.prepare(SQL.setQuoteState).run(
          C.QUOTE_STATE.EXPIRED, Number(revision), Number(now), String(quoteId), C.QUOTE_STATE.OPEN
        );
        if (Number(moved.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['quote-transition-affected-no-row']);
        }
        faultPoint('after-quote-expired');
        const result = {
          domain: C.DOMAIN,
          quoteId: String(quoteId),
          state: C.QUOTE_STATE.EXPIRED,
          expiresAt: Number(current.expires_at),
          revision: Number(revision),
          at: Number(now),
          reservedFunds: false,
          ledgerMutation: false
        };
        appendChange({
          revision: Number(revision), kind: C.EVENT_TYPE.QUOTE_EXPIRED,
          entityId: String(quoteId), transactionId: null, walletId: null, at: Number(now),
          payload: {
            domain: C.DOMAIN, quoteId: String(quoteId), productId: String(current.product_id),
            buyerId: String(current.buyer_id), currency: String(current.currency),
            amountMinor: C.serializeAmountMinor(fromSqlAmount(current.amount_minor, 'quote-amount')),
            expiresAt: Number(current.expires_at),
            reservedFunds: false,
            ledgerMutation: false
          }
        });
        faultPoint('before-quote-expire-change-log');
        writeOperationIdempotency(C.OPERATION_SCOPE.QUOTE, key.key, fingerprint, {
          operationId: null, reservationId: null, transactionId: null
        }, result, revision, now);
        faultPoint('before-quote-expire-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }
    pruneOperationIdempotency(now);
    logger('economy-quote-expired', { quoteId: committed.quoteId, revision: committed.revision });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  function expireDueQuotes(input) {
    requireOpen();
    const o = input || {};
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const limit = Math.max(1, Math.min(1000, Number(o.limit) || 100));
    const due = db.prepare(SQL.selectDueQuotes).all(C.QUOTE_STATE.OPEN, Number(now), limit);
    const expired = [];
    const skipped = [];
    const failed = [];
    for (const row of due) {
      const quoteId = String(row.quote_id);
      const out = expireQuote({ quoteId: quoteId, now: now });
      if (out.ok === true && out.replayed === true) skipped.push({ quoteId: quoteId, reason: 'already-expired-by-an-earlier-sweep' });
      else if (out.ok === true) expired.push(out.result);
      else if (out.reasonCode === C.DENY_REASON.TRANSITION_NOT_ALLOWED) skipped.push({ quoteId: quoteId, reason: 'already-terminal' });
      else failed.push({ quoteId: quoteId, errors: out.errors, reasonCode: out.reasonCode || null });
    }
    return { ok: true, now: now, limit: limit, scanned: due.length, expired: expired, skipped: skipped, failed: failed, usedTimers: false };
  }

  function countQuotes() { return Number((db.prepare(SQL.countQuotes).get() || {}).c || 0); }
  function countQuotesByState(state) {
    return Number((db.prepare(SQL.countQuotesByState).get(String(state)) || {}).c || 0);
  }
  /* P22-5 的四个计数。它们与上面同款：只被 health() 与测试读，从不参与
     任何判定 —— "现在有几件商品"绝不该成为"能不能买"的一个输入。 */
  function countStores() { return Number((db.prepare(SQL.countStores).get() || {}).c || 0); }
  function countStoresByStatus(status) {
    return Number((db.prepare(SQL.countStoresByStatus).get(String(status)) || {}).c || 0);
  }
  function countProducts() { return Number((db.prepare(SQL.countProducts).get() || {}).c || 0); }
  function countProductsByStatus(status) {
    return Number((db.prepare(SQL.countProductsByStatus).get(String(status)) || {}).c || 0);
  }
  function countInventory() { return Number((db.prepare(SQL.countInventory).get() || {}).c || 0); }
  function totalInventoryQuantity() {
    return Number((db.prepare(SQL.sumInventoryQuantity).get() || {}).total || 0);
  }

  /* ── evaluateQuote（§18）：一次**读**，产出四样东西 ─────────────────
       quote            —— 那份价格命题（可能已经过期，如实报告）
       walletSnapshot   —— canonical 的钱包事实
       budgetSnapshot   —— canonical 的窗口累计
       decision         —— 三态 + 稳定 reasonCode

     刻意**不**做任何写：它不 reserve、不消费报价、不改状态。这正是
     §18 点名的那件事：**"评估报价"不能偷偷变成"接受报价"**。
     因此返回对象里带着 `evaluatedOnly: true`，而它旁边没有任何
     "consumed" / "reserved" 字段 —— 不是忘了加，是这一层没有那个概念。 */
  function evaluateQuote(input) {
    requireOpen();
    const o = input || {};
    const quoteId = o.quoteId;
    if (!C.isEconomyId('QUOTE', quoteId)) {
      return { ok: false, errors: ['quote-id-not-canonical'] };
    }
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const row = db.prepare(SQL.selectQuote).get(String(quoteId));
    if (!row) return { ok: false, errors: ['quote-not-found'] };
    const quote = rowToQuote(row, { now: now });

    const built = buildBudgetSnapshot({
      ownerId: quote.buyerId.id, currency: quote.currency, amountMinor: quote.amountMinor, now: now
    });

    const decisionBase = built.ok
      ? budgetEvaluationFromSnapshot(built.snapshot, built.snapshot.policyId == null ? null : policyForOwner(quote.buyerId.id))
      : Object.assign(C.budgetDecision(C.BUDGET_DECISION.DENY, C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, {
        errors: built.errors, priority: C.BUDGET_EVALUATION_PRIORITY[0], systemFailure: true
      }), { policyId: null, currency: quote.currency });

    /* 报价这一面的两条硬规则，排在预算结论**之前或之上**取决于它们是
       关于"这份报价还能不能用"的，而预算结论是关于"这笔钱能不能花"的。
       两者都可能说不，因此这里把它们**合成**成一个结论，并保留各自的
       reasonCode：`quoteCode`（报价侧）与 `decision.reasonCode`（预算侧）。
       规则是：报价侧说不 ⇒ 整个结论是 DENY（一份不能用的报价没有任何
       预算讨论的余地）。 */
    let decision = decisionBase;
    let quoteCode = null;
    if (quote.state !== C.QUOTE_STATE.OPEN) {
      quoteCode = quote.state === C.QUOTE_STATE.EXPIRED ? C.DENY_REASON.QUOTE_EXPIRED : C.DENY_REASON.QUOTE_MISMATCH;
    } else if (quote.expiredByTime) {
      quoteCode = C.DENY_REASON.QUOTE_EXPIRED;
    }
    if (quoteCode != null) {
      decision = Object.assign(C.budgetDecision(C.BUDGET_DECISION.DENY, quoteCode, {
        errors: ['the-quote-cannot-be-consumed-in-its-current-state'],
        priority: C.BUDGET_EVALUATION_PRIORITY[0],
        quoteState: quote.state,
        expiredByTime: quote.expiredByTime,
        budgetReasonCode: decisionBase.reasonCode
      }), { policyId: decisionBase.policyId, currency: quote.currency });
    }

    return {
      ok: true,
      quote: serializeQuote(quote),
      walletSnapshot: built.ok ? {
        walletId: built.snapshot.walletId,
        walletState: built.snapshot.walletState,
        ledgerBalanceMinor: C.serializeAmountMinor(built.snapshot.ledgerBalanceMinor),
        reservedBalanceMinor: C.serializeAmountMinor(built.snapshot.reservedBalanceMinor),
        availableBalanceMinor: C.serializeAmountMinor(built.snapshot.availableBalanceMinor)
      } : null,
      budgetSnapshot: built.ok ? serializeBudgetSnapshot(built.snapshot) : null,
      decision: decision,
      reasonCode: decision.reasonCode,
      quoteReasonCode: quoteCode,
      budgetReasonCode: decisionBase.reasonCode,
      /* 三个"没有做"的逐字声明。 */
      evaluatedOnly: true,
      reserved: false,
      consumed: false,
      notASpendPermit: 'ALLOW is a snapshot evaluation, not a spendable permission; nothing has been reserved and the quote has not been consumed'
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-5 · 货架（Store）/ 商品（Product）/ 库存（Inventory）
     ══════════════════════════════════════════════════════════════════ */

  /* 这一节回答三个问题，并且**只**回答这三个：
       「有哪些货架 / 有哪些商品？」   —— 读，不判定
       「一份商品是什么？」            —— kind / fulfillment / 价格 + 单位
       「谁拥有什么？」                —— canonical 库存行
     它不回答「Agent 应该买什么」（Decision），也不执行「买」（future
     Purchase）。P22-5 §46 把这条写得很直白：本阶段只回答
     "有哪些商品 / 商品是什么 / 当前报价是什么 / 角色拥有什么"。

     ── 一个刻意的结构决定：库存**没有**派生缓存 ─────────────────────────
     P22-2/P22-3 的 wallets 表有两列派生缓存（cached_balance_minor /
     reserved_balance_minor），因此那两代都配了 rebuild + 开库对账。
     P22-5 **不**复制那个形状（§17 明确要求先判断需不需要）：
     canonical 库存**就是** economy_inventory 的那一行，没有第二个数。
     于是"重建"这个问题根本不存在 —— 而"为了对称而造一个缓存再写重建"
     会凭空引入一类新的漂移 bug（缓存与行不一致），换来的是零收益。
     health() 里那两句 inventoryCanonical / inventoryDerived 就是这件事的
     可断言形式。 */

  /* ── 行 ↔ DTO ───────────────────────────────────────────────────────
     金额进出 SQLite 一律经 toSqlAmount / fromSqlAmount（P22-2 §8）；
     数量（grantQuantity / quantity）刻意是**安全整数**：它们是一次计数，
     不是一笔钱（§35 允许"沿用现有边界"，而数量的天然边界就是安全整数）。 */

  function rowToStore(row) {
    return {
      storeId: String(row.store_id),
      name: String(row.name),
      description: row.description == null ? null : String(row.description),
      status: String(row.status),
      sortOrder: Number(row.sort_order),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      idempotencyKey: String(row.idempotency_key)
    };
  }

  function rowToProduct(row) {
    return {
      productId: String(row.product_id),
      storeId: String(row.store_id),
      kind: String(row.product_kind),
      fulfillment: String(row.fulfillment),
      name: String(row.name),
      description: row.description == null ? null : String(row.description),
      currency: String(row.currency),
      unitPriceMinor: fromSqlAmount(row.unit_price_minor, 'product-unit-price'),
      unitName: String(row.unit_name),
      grantQuantity: Number(row.grant_quantity),
      assetKind: row.asset_kind == null ? null : String(row.asset_kind),
      status: String(row.status),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      idempotencyKey: String(row.idempotency_key)
    };
  }

  /* 库存行的 DTO。productPresent 是**provenance**，不是有效性
     （§22：Product 行是 provenance，报价/库存自己的经济内容才是事实）。
     一个商品被 RETIRED 之后，用户手里的东西仍然在，而这一行仍然说得清
     "这是什么" —— 因为 asset_kind 与 quantity 都写在这一行上。 */
  function rowToInventoryEntry(row, productRow) {
    return {
      inventoryEntryId: String(row.inventory_entry_id),
      ownerId: String(row.owner_id),
      ownerType: String(row.owner_type),
      productId: String(row.product_id),
      assetKind: String(row.asset_kind),
      quantity: Number(row.quantity),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      idempotencyKey: String(row.idempotency_key),
      productPresent: !!productRow
    };
  }

  /* ── 对外 JSON 形态 ──────────────────────────────────────────────────
     三个 serialize* 都逐字写下该层**不是**什么。这些字段不是修辞：
     §2 / §12 / §41 都要求"没有的东西"可被断言，而最容易被误读的三件事
     恰好是"货架里有价格"、"商品里有拥有关系"、"库存里有余额"。 */
  function serializeStore(view) {
    return {
      domain: C.DOMAIN,
      storeId: view.storeId,
      name: view.name,
      description: view.description,
      status: view.status,
      sortOrder: view.sortOrder,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      /* 货架**不**拥有价格事实，也**不**拥有拥有关系（§2）。 */
      holdsPrices: false,
      holdsOwnership: false,
      holdsInventory: false
    };
  }

  function serializeProduct(view) {
    return {
      domain: C.DOMAIN,
      productId: view.productId,
      storeId: view.storeId,
      kind: view.kind,
      fulfillment: view.fulfillment,
      name: view.name,
      description: view.description,
      currency: view.currency,
      unitPriceMinor: C.serializeAmountMinor(view.unitPriceMinor),
      unitName: view.unitName,
      grantQuantity: view.grantQuantity,
      assetKind: view.assetKind,
      status: view.status,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      /* 价格与关系无关（§41），而拥有关系不属于商品（§10/§24）。 */
      pricingIsRelationshipFree: C.PRICING_IS_RELATIONSHIP_FREE,
      holdsOwnership: false,
      grantsInventory: String(view.fulfillment) !== C.FULFILLMENT.SERVICE_EXECUTION,
      hasDiscount: false,
      hasRecommendation: false
    };
  }

  function serializeInventoryEntry(view) {
    return {
      domain: C.DOMAIN,
      inventoryEntryId: view.inventoryEntryId,
      ownerId: view.ownerId,
      ownerType: view.ownerType,
      productId: view.productId,
      assetKind: view.assetKind,
      quantity: view.quantity,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      productPresent: view.productPresent,
      /* 库存 ≠ 钱包（§12）：它不是余额、不参与 available、不按币种聚合。 */
      isABalance: false,
      contributesToAvailableBalance: false,
      countsAsPaymentCurrency: false
    };
  }

  /* ── 幂等身份（§19/§15）──────────────────────────────────────────────
     三条指纹各自只覆盖"这次请求是什么"：**不含**任何生成的 id
     （storeId / productId / inventoryEntryId 都可能由调用方显式给出，
     但它们是执行结果的身份，不是请求的身份），也不含时间戳。 */
  function storeFingerprint(payload) {
    return fingerprintOf(stableStringify({ scope: C.OPERATION_SCOPE.STORE, request: payload }));
  }

  function productFingerprint(payload) {
    return fingerprintOf(stableStringify({ scope: C.OPERATION_SCOPE.PRODUCT, request: payload }));
  }

  function inventoryFingerprint(scope, payload) {
    return fingerprintOf(stableStringify({ scope: String(scope), request: payload }));
  }

  function normalizeLimit(value, fallback, max) {
    return Math.max(1, Math.min(max || 500, Number(value) || fallback || 100));
  }

  /* ── productAvailabilityForQuote（§9 / §33 的落点）────────────────────
     一份报价只可能在**一件正在卖的商品**上生成。这条规则有两个半边：
       · product.status 必须是 ACTIVE；
       · 它所属的 store 也必须是 ACTIVE —— 否则"把货架关掉"这个动作
         没有任何后果，而 DISABLED 就退化成一个装饰性的字段。
     返回的是一个**拒绝形状**（而不是抛错），因为它同时被 createQuote
     （事务之外）与 createProductQuote 使用，而两者都在写任何东西之前。 */
  function productAvailabilityForQuote(productId) {
    const row = db.prepare(SQL.selectProduct).get(String(productId));
    if (!row) {
      return {
        ok: false,
        denial: denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: String(productId) })
      };
    }
    const product = rowToProduct(row);
    if (product.status !== C.PRODUCT_STATUS.ACTIVE) {
      /* 注意这里是 PRODUCT_DISABLED 而不是一个新代码：DISABLED 与 RETIRED
         对调用方的含义相同（"这件商品现在买不了"），差别在 detail 里 ——
         而 detail 里的那个词正是审计需要的（§9：两者在事件里分开，
         在拒绝里合并是刻意的：调用方的正确反应完全一样）。 */
      return {
        ok: false,
        denial: denial(C.DENY_REASON.PRODUCT_DISABLED, ['product-status-is-not-active'],
          { productId: product.productId, productStatus: product.status })
      };
    }
    const storeRow = db.prepare(SQL.selectStore).get(product.storeId);
    if (!storeRow) {
      return {
        ok: false,
        denial: denial(C.DENY_REASON.STORE_NOT_FOUND, ['store-not-found'],
          { productId: product.productId, storeId: product.storeId })
      };
    }
    const store = rowToStore(storeRow);
    if (store.status !== C.STORE_STATUS.ACTIVE) {
      return {
        ok: false,
        denial: denial(C.DENY_REASON.PRODUCT_DISABLED, ['store-status-is-not-active'],
          { productId: product.productId, storeId: store.storeId, storeStatus: store.status })
      };
    }
    return { ok: true, product: product, store: store, denial: null };
  }

  /* ── 读：货架 ────────────────────────────────────────────────────────
     listStores 刻意**不**接受任何"给谁看"的参数（§40）：没有 ownerId、
     没有 relationshipId、没有推荐输入。货架顺序是 sortOrder，一个只被
     人改的整数，而不是一个被算出来的分数。 */
  function getStore(input) {
    requireOpen();
    const o = typeof input === 'string' ? { storeId: input } : (input || {});
    if (!o.storeId) return { ok: false, store: null, errors: ['store-id-required'] };
    const row = db.prepare(SQL.selectStore).get(String(o.storeId));
    if (!row) return { ok: false, store: null, errors: ['store-not-found'] };
    return { ok: true, store: rowToStore(row) };
  }

  function listStores(options) {
    requireOpen();
    const o = options || {};
    const limit = normalizeLimit(o.limit, 100, 500);
    const rows = o.status != null
      ? db.prepare(SQL.selectStoresByStatus).all(String(o.status), limit)
      : db.prepare(SQL.selectStores).all(limit);
    return { ok: true, stores: rows.map(rowToStore) };
  }

  /* ── 读：商品 ────────────────────────────────────────────────────────
     过滤条件是 storeId / status / kind / currency / limit（§29 的最小集），
     全部落在**一条** SQL 里。刻意没有全文搜索、没有排序学习、没有"相关性"，
     也没有"取一页再筛" —— 后者会因为 LIMIT 先于过滤生效而**少返回**。 */
  function getProduct(input) {
    requireOpen();
    const o = typeof input === 'string' ? { productId: input } : (input || {});
    if (!o.productId) return { ok: false, product: null, errors: ['product-id-required'] };
    const row = db.prepare(SQL.selectProduct).get(String(o.productId));
    if (!row) return { ok: false, product: null, errors: ['product-not-found'] };
    return { ok: true, product: rowToProduct(row) };
  }

  function listProducts(options) {
    requireOpen();
    const o = options || {};
    const limit = normalizeLimit(o.limit, 100, 500);
    const storeId = o.storeId == null ? null : String(o.storeId);
    const status = o.status == null ? null : String(o.status);
    const kind = o.kind == null ? null : String(o.kind);
    const currency = o.currency == null ? null : String(o.currency);
    const rows = db.prepare(SQL.selectProductsFiltered).all(
      storeId, storeId, status, status, kind, kind, currency, currency, limit
    );
    return { ok: true, products: rows.map(rowToProduct) };
  }

  /* ── 读：库存 ────────────────────────────────────────────────────────
     唯一的 canonical 读入口。inventoryQuantity 是 §30 点名要的那个查询，
     而它回答 0 的两种含义刻意分开：present=false 表示"从来没有过这一行"，
     quantity=0 表示"曾经有过、现在用光了"（§23：行保留）。 */
  function getInventoryEntry(input) {
    requireOpen();
    const o = typeof input === 'string' ? { inventoryEntryId: input } : (input || {});
    let row = null;
    if (o.inventoryEntryId != null) {
      row = db.prepare(SQL.selectInventoryEntry).get(String(o.inventoryEntryId));
    } else if (o.ownerId != null && o.productId != null) {
      row = db.prepare(SQL.selectInventoryByOwnerProduct).get(String(o.ownerId), String(o.productId));
    } else {
      return { ok: false, entry: null, errors: ['inventory-entry-id-or-owner-and-product-required'] };
    }
    if (!row) return { ok: false, entry: null, errors: ['inventory-entry-not-found'] };
    const productRow = db.prepare(SQL.selectProduct).get(String(row.product_id));
    return { ok: true, entry: rowToInventoryEntry(row, productRow) };
  }

  function listInventory(options) {
    requireOpen();
    const o = options || {};
    const limit = normalizeLimit(o.limit, 100, 500);
    const ownerId = o.ownerId == null ? null : String(o.ownerId);
    const productId = o.productId == null ? null : String(o.productId);
    const assetKind = o.assetKind == null ? null : String(o.assetKind);
    /* §51：ownerId 是**必须**的过滤条件之一。没有 owner 的"列库存"是一次
       全局查询，而它正是"按 productId 全局扣库存"这类错误的温床 ——
       因此这里拒绝，而不是返回一个跨 owner 的大列表。 */
    if (ownerId == null && productId == null) {
      return { ok: false, entries: [], errors: ['inventory-listing-requires-an-owner-or-a-product'] };
    }
    const rows = db.prepare(SQL.selectInventoryFiltered).all(
      ownerId, ownerId, productId, productId, assetKind, assetKind, limit
    );
    /* 列表形态不解引用商品（那会变成一次 N+1 查询）：因此 productPresent
       在这里一律是 false。它的意思是"这次读取没有顺带查商品"，
       而不是"商品不存在" —— 单条读（getInventoryEntry）会给真值。 */
    return { ok: true, entries: rows.map(r => rowToInventoryEntry(r, null)) };
  }

  function inventoryQuantity(ownerId, productId) {
    requireOpen();
    const row = db.prepare(SQL.selectInventoryByOwnerProduct).get(String(ownerId), String(productId));
    if (!row) {
      return {
        ok: true, present: false, ownerId: String(ownerId), productId: String(productId),
        quantity: 0, assetKind: null, inventoryEntryId: null
      };
    }
    return {
      ok: true, present: true, ownerId: String(row.owner_id), productId: String(row.product_id),
      quantity: Number(row.quantity), assetKind: String(row.asset_kind),
      inventoryEntryId: String(row.inventory_entry_id)
    };
  }

  /* ── putStore：货架的创建与修改 ──────────────────────────────────────
     为什么 create 与 update 合成一个入口：与 putBudgetPolicy 同款 ——
     它们是**同一个**幂等 scope 下的同一类请求，而两个入口会让"同一个 key
     既 create 又 update"变成一个必须被解释的边界情况。
     `ifRevision` 是可选的乐观并发：货架名与顺序是需要人改的东西，
     "两个人同时改、后者静默覆盖前者"是这里最该避免的失败。 */
  function putStore(input) {
    requireOpen();
    const o = input || {};
    /* 契约的 validateStore 收的是**原始**输入（含未知键），因此
       "多传了一个字段"在这里就会被拒绝 —— 而不是被静默忽略。 */
    const shape = C.validateStore(o);
    if (!shape.ok) return denial(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED, shape.errors);
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const name = String(o.name).trim();
    const description = o.description == null ? null : String(o.description);
    const status = o.status == null ? C.STORE_STATUS.ACTIVE : String(o.status);
    const sortOrder = o.sortOrder == null ? 0 : Number(o.sortOrder);
    const storeId = o.storeId != null ? String(o.storeId) : nextId('STORE');
    if (!C.isEconomyId('STORE', storeId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['store-id-not-canonical'] };
    }

    const fingerprint = storeFingerprint({
      name: name, description: description, status: status, sortOrder: sortOrder
    });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.STORE, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.STORE, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    const existingRow = db.prepare(SQL.selectStore).get(storeId);
    const existing = existingRow ? rowToStore(existingRow) : null;
    if (existing && o.ifRevision != null && Number(o.ifRevision) !== existing.revision) {
      return {
        ok: false, denied: false, reasonCode: null,
        errors: ['store-revision-mismatch'],
        expectedRevision: Number(o.ifRevision), actualRevision: existing.revision, storeId: storeId
      };
    }

    const at = clock();
    const created = !existing;
    let committed = null;
    try {
      withTransaction(() => {
        /* 事务内重读：BEGIN IMMEDIATE 之后写锁已经拿到，因此这一段看到的
           货架行不可能被另一个 writer 改动。 */
        const currentRow = db.prepare(SQL.selectStore).get(storeId);
        if (!currentRow && !created) throw refuse(null, ['store-disappeared-inside-the-transaction']);
        if (currentRow && created) throw refuse(null, ['store-was-created-concurrently']);
        if (currentRow && o.ifRevision != null && Number(currentRow.revision) !== Number(o.ifRevision)) {
          throw refuse(null, ['store-revision-mismatch'],
            { expectedRevision: Number(o.ifRevision), actualRevision: Number(currentRow.revision) });
        }
        const revision = allocateRevision();
        if (created) {
          db.prepare(SQL.insertStore).run(
            storeId, name, description, status, Number(sortOrder),
            key.key, fingerprint, Number(revision), Number(at), Number(at)
          );
          faultPoint('after-store-insert');
        } else {
          db.prepare(SQL.updateStore).run(
            name, description, status, Number(sortOrder),
            key.key, fingerprint, Number(revision), Number(at), storeId
          );
          faultPoint('after-store-update');
        }
        const row = db.prepare(SQL.selectStore).get(storeId);
        if (!row) throw refuse(null, ['store-row-missing-after-write']);
        const view = rowToStore(row);
        const eventKind = created ? C.EVENT_TYPE.STORE_CREATED : C.EVENT_TYPE.STORE_UPDATED;
        const result = {
          domain: C.DOMAIN,
          storeId: String(storeId),
          created: created,
          eventKind: String(eventKind),
          previousStatus: existing ? existing.status : null,
          store: serializeStore(view),
          revision: Number(revision),
          at: Number(at),
          idempotencyKey: key.key,
          /* 逐字写明：改货架**不是**经济运动，也不是"改价"（§2）。 */
          ledgerMutation: false,
          priceMutation: false,
          ownershipMutation: false
        };
        appendChange({
          revision: Number(revision), kind: String(eventKind),
          entityId: String(storeId), transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            storeId: String(storeId),
            name: name,
            status: status,
            sortOrder: Number(sortOrder),
            previousStatus: existing ? existing.status : null,
            ledgerMutation: false,
            priceMutation: false,
            ownershipMutation: false
          }
        });
        faultPoint('before-store-change-log');
        writeOperationIdempotency(C.OPERATION_SCOPE.STORE, key.key, fingerprint, {
          operationId: null, reservationId: null, transactionId: null
        }, result, revision, at);
        faultPoint('before-store-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger('economy-store-written', {
      storeId: committed.storeId, created: created, status: status, revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ── putProduct：商品的创建、改价、改状态 ────────────────────────────
     一条必须说清楚的语义（§8）：**更新商品不会重写过去**。
       · 历史 Quote 不变 —— 因为报价的金额/币种/数量/种类都在它自己的列
         上，而本函数一个字节都不碰 quotes 表；
       · 历史 Inventory 不变 —— 同上（也不碰 inventory 表）；
       · 历史 Ledger 不变 —— 本函数没有一次 commitLedgerTransactionInTx。
     这三句话的结构性证据是同一件事：本函数体的写语句集合里只有
     insertProduct / updateProduct / setProductStatus / appendChange /
     writeOperationIdempotency。 */
  function putProduct(input) {
    requireOpen();
    const o = input || {};
    const shape = C.validateProduct(o);
    if (!shape.ok) return denial(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED, shape.errors);
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const kind = String(o.kind);
    const fulfillment = C.fulfillmentOfProductKind(kind);
    const assetKind = C.assetKindOfProductKind(kind);
    const name = String(o.name).trim();
    const description = o.description == null ? null : String(o.description);
    const currency = C.validateCurrency(o.currency).currency;
    const price = C.normalizeAmountMinor(o.unitPriceMinor);
    if (!price.ok) return denial(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED, price.errors);
    const unitName = o.unitName == null ? C.unitNameOfProductKind(kind) : String(o.unitName);
    const grantQuantity = o.grantQuantity == null ? 0 : Number(o.grantQuantity);
    const status = o.status == null ? C.PRODUCT_STATUS.ACTIVE : String(o.status);
    const storeId = String(o.storeId);
    const productId = o.productId != null ? String(o.productId) : nextId('PRODUCT');
    if (!C.isEconomyId('PRODUCT', productId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['product-id-not-canonical'] };
    }

    const fingerprint = productFingerprint({
      storeId: storeId, kind: kind, name: name, description: description,
      currency: currency, unitPriceMinor: C.serializeAmountMinor(price.amountMinor),
      unitName: String(unitName), grantQuantity: grantQuantity, status: status
    });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.PRODUCT, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.PRODUCT, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    const existingRow = db.prepare(SQL.selectProduct).get(productId);
    const existing = existingRow ? rowToProduct(existingRow) : null;
    if (existing && o.ifRevision != null && Number(o.ifRevision) !== existing.revision) {
      return {
        ok: false, denied: false, reasonCode: null,
        errors: ['product-revision-mismatch'],
        expectedRevision: Number(o.ifRevision), actualRevision: existing.revision, productId: productId
      };
    }
    /* ── "商品本体"不可变（§20）────────────────────────────────────────
       改 kind / fulfillment / storeId 不是"改一件商品"，而是换了一件商品：
       交付形态变了、或者它搬到了另一个货架上，而历史报价里的
       settlementType 仍然说着当时的话。允许它们在同一个 productId 下变化
       会让那个 id 的两个时刻说出不同的话。正确形态是新建一个 product。 */
    if (existing) {
      if (existing.kind !== kind) {
        return denial(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED,
          ['product-kind-is-immutable-a-different-kind-is-a-different-product'],
          { productId: productId, currentKind: existing.kind, requestedKind: kind });
      }
      if (existing.storeId !== storeId) {
        return denial(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED,
          ['product-store-is-immutable-relisting-is-a-new-product'],
          { productId: productId, currentStoreId: existing.storeId, requestedStoreId: storeId });
      }
    }
    /* ── 状态推进必须走状态机（§9）─────────────────────────────────────
       RETIRED 是终态，因此"退役后重新上架"在这里被拒绝，而不是让它变成
       一条 payload 上写着 RETIRED→ACTIVE 的 change log。 */
    const statusChanged = !existing || existing.status !== status;
    if (existing && statusChanged) {
      const transition = C.assertProductStatusTransition(existing.status, status);
      if (!transition.ok) {
        return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, transition.errors,
          { from: existing.status, to: status, detail: transition.detail || null, productId: productId });
      }
    }

    const at = clock();
    const created = !existing;
    let committed = null;
    try {
      withTransaction(() => {
        const currentRow = db.prepare(SQL.selectProduct).get(productId);
        if (!currentRow && !created) throw refuse(null, ['product-disappeared-inside-the-transaction']);
        if (currentRow && created) throw refuse(null, ['product-was-created-concurrently']);
        if (currentRow && o.ifRevision != null && Number(currentRow.revision) !== Number(o.ifRevision)) {
          throw refuse(null, ['product-revision-mismatch'],
            { expectedRevision: Number(o.ifRevision), actualRevision: Number(currentRow.revision) });
        }
        /* 货架必须在**事务内**存在：否则一个并发的 store 删除
           （本阶段没有这条路径，但将来可能有）会留下一个悬空引用。 */
        const storeRow = db.prepare(SQL.selectStore).get(storeId);
        if (!storeRow) {
          throw refuse(C.DENY_REASON.STORE_NOT_FOUND, ['store-not-found'], { storeId: storeId });
        }
        const revision = allocateRevision();
        if (created) {
          db.prepare(SQL.insertProduct).run(
            productId, storeId, kind, String(fulfillment), name, description, currency,
            toSqlAmount(price.amountMinor, 'product-unit-price'), String(unitName), Number(grantQuantity),
            assetKind == null ? null : String(assetKind), status,
            key.key, fingerprint, Number(revision), Number(at), Number(at)
          );
          faultPoint('after-product-insert');
        } else {
          /* 两条语句，各管一半：内容（含价格）与状态（含终态守卫）。
             金额列只出现在第一条里，状态列只出现在第二条里 —— 因此
             "改价顺带改状态"在语句层面做不到。 */
          db.prepare(SQL.updateProduct).run(
            name, description, currency, toSqlAmount(price.amountMinor, 'product-unit-price'),
            String(unitName), Number(grantQuantity),
            key.key, fingerprint, Number(revision), Number(at), productId
          );
          faultPoint('after-product-update');
          if (statusChanged) {
            const guarded = db.prepare(SQL.setProductStatus).run(
              status, key.key, fingerprint, Number(revision), Number(at), productId, String(currentRow.status)
            );
            if (Number(guarded.changes) !== 1) {
              throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['product-status-transition-was-not-applied'],
                { productId: productId, from: String(currentRow.status), to: status });
            }
            faultPoint('after-product-status-transition');
          }
        }
        const row = db.prepare(SQL.selectProduct).get(productId);
        if (!row) throw refuse(null, ['product-row-missing-after-write']);
        const view = rowToProduct(row);
        /* ── 事件类型是**四选一**，而且顺序必须这样写 ────────────────────
           开发期抓到的真实缺陷：第一版写的是
             created ? PRODUCT_CREATED
                     : (statusChanged ? (status === RETIRED ? RETIRED : DISABLED)
                                      : UPDATED)
           然后在下面补了一句"状态回到 ACTIVE 时归回 UPDATED"。那两句组合
           起来让**新建**一个 ACTIVE 商品也报成 PRODUCT_UPDATED —— 因为
           `statusChanged` 的定义是 `!existing || existing.status !== status`，
           对一次创建来说它是 true，而 status 恰好是 ACTIVE。
           症状很隐蔽：商品建对了、状态对了、payload 里 previousStatus 也
           是 null，只有 kind 这一个字段在说谎，而"有几件商品被创建过"
           这个审计问题因此答不出来。
           修法是把**创建**放在最前面，让后面三个分支只处理"已存在的商品
           的状态推进"：
             created                        → PRODUCT_CREATED
             !statusChanged                 → PRODUCT_UPDATED（改价/改名）
             status === RETIRED             → PRODUCT_RETIRED（终态）
             status === DISABLED            → PRODUCT_DISABLED
             status === ACTIVE（重新上架）  → PRODUCT_UPDATED
           payload 里始终带着 previousStatus 与 status 两个字段，
           因此"从上架到停用"与"从停用到上架"在审计里永远可分。 */
        const eventKind = created
          ? C.EVENT_TYPE.PRODUCT_CREATED
          : (!statusChanged
            ? C.EVENT_TYPE.PRODUCT_UPDATED
            : (status === C.PRODUCT_STATUS.RETIRED
              ? C.EVENT_TYPE.PRODUCT_RETIRED
              : (status === C.PRODUCT_STATUS.DISABLED
                ? C.EVENT_TYPE.PRODUCT_DISABLED
                : C.EVENT_TYPE.PRODUCT_UPDATED)));
        const namedKind = eventKind;
        const result = {
          domain: C.DOMAIN,
          productId: String(productId),
          created: created,
          statusChanged: statusChanged,
          previousStatus: existing ? existing.status : null,
          eventKind: String(namedKind),
          product: serializeProduct(view),
          previousUnitPriceMinor: existing ? C.serializeAmountMinor(existing.unitPriceMinor) : null,
          revision: Number(revision),
          at: Number(at),
          idempotencyKey: key.key,
          /* ── §8：更新商品**不**重写过去。这三句是可断言的自述，
             而它们的证据是"本函数没有碰 quotes / inventory / ledger"。 */
          rewriteOfHistoricalQuotes: false,
          rewriteOfHistoricalInventory: false,
          ledgerMutation: false
        };
        appendChange({
          revision: Number(revision), kind: String(namedKind),
          entityId: String(productId), transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            productId: String(productId),
            storeId: storeId,
            kind: kind,
            fulfillment: String(fulfillment),
            currency: currency,
            unitPriceMinor: C.serializeAmountMinor(price.amountMinor),
            previousUnitPriceMinor: existing ? C.serializeAmountMinor(existing.unitPriceMinor) : null,
            grantQuantity: Number(grantQuantity),
            status: status,
            previousStatus: existing ? existing.status : null,
            rewriteOfHistoricalQuotes: false,
            ledgerMutation: false
          }
        });
        faultPoint('before-product-change-log');
        writeOperationIdempotency(C.OPERATION_SCOPE.PRODUCT, key.key, fingerprint, {
          operationId: null, reservationId: null, transactionId: null
        }, result, revision, at);
        faultPoint('before-product-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger('economy-product-written', {
      productId: committed.productId, storeId: storeId, kind: kind, created: created,
      status: status, revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ── createProductQuote（§6/§7/§21）──────────────────────────────────
     这是 P22-5 的**canonical 报价路径**：价格、币种、数量、种类全部从
     Product 的 canonical 行派生，调用方**没有地方**传一个金额进来。
     这一点是结构性的：本函数只把五个**派生出来的**值交给 createQuote，
     而 o.amountMinor / o.currency / o.quantity / o.kind 即使被传进来也
     不会被读到 —— 它们不在参数列表里。

     P22-4 的 raw createQuote **保留不动**（§21：不要为了"接口统一"破坏
     P22-4）。两者的分工写在名字里：一个从商品生成报价，一个是冻结的
     底层 primitive。 */

  /* ── provenance（§22）───────────────────────────────────────────────
     参数是**请求的 productId**，而不是一行。这个签名本身就在表达那句
     语义：provenance 回答的是"这个 id 现在指向什么"，而"什么都没有"
     是一个**完整的**答案（present:false），不是一次失败。
     如果它收一行，调用方就必须先决定"查不到时怎么办" —— 而那个决定
     正是 §22 要求被明确下来的那一个。 */
  function productProvenanceOf(productId) {
    const id = productId == null ? null : String(productId);
    const row = id == null ? null : db.prepare(SQL.selectProduct).get(id);
    if (!row) {
      return {
        productId: id,
        present: false,
        relation: C.QUOTE_PRODUCT_RELATION.PROVENANCE_ONLY,
        name: null,
        storeId: null,
        storePresent: false,
        storeStatus: null,
        status: null,
        fulfillment: null,
        revision: null,
        /* 逐字：报价的**经济事实**不在这里，它在报价自己的列上。 */
        quoteEconomicContentDependsOnThisRow: false
      };
    }
    const storeRow = db.prepare(SQL.selectStore).get(String(row.store_id));
    return {
      productId: String(row.product_id),
      present: true,
      relation: C.QUOTE_PRODUCT_RELATION.PROVENANCE_ONLY,
      name: String(row.name),
      storeId: String(row.store_id),
      storePresent: !!storeRow,
      storeStatus: storeRow ? String(storeRow.status) : null,
      status: String(row.status),
      fulfillment: String(row.fulfillment),
      revision: Number(row.revision),
      quoteEconomicContentDependsOnThisRow: false
    };
  }

  function createProductQuote(input) {
    requireOpen();
    const o = input || {};
    const productId = o.productId == null ? null : String(o.productId);
    if (!C.isEconomyId('PRODUCT', productId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['product-id-not-canonical'] };
    }
    /* 幂等闸门必须在**任何派生之前**：同一个 key 换个商品重放时，
       正确回答是冲突，而不是"那个商品的报价"。 */
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const units = o.units == null ? 1 : Number(o.units);

    const available = productAvailabilityForQuote(productId);
    if (!available.ok) return available.denial;
    const product = available.product;

    const derivedQuantity = C.productQuoteQuantity(product, units);
    if (!derivedQuantity.ok) return denial(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED, derivedQuantity.errors);
    const derivedAmount = C.productQuoteAmountMinor(product, units);
    if (!derivedAmount.ok) return denial(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED, derivedAmount.errors);

    const hasRecipient = o.recipientId != null && String(o.recipientId).trim() !== '';
    const derivedKind = C.productQuoteKindFor(product.fulfillment, hasRecipient);
    if (!derivedKind.ok) return denial(C.DENY_REASON.EFFECT_NOT_ALLOWED, derivedKind.errors);

    const out = createQuote({
      buyerId: o.buyerId != null ? o.buyerId : o.ownerId,
      recipientId: o.recipientId,
      currency: product.currency,
      amountMinor: derivedAmount.amountMinor,
      quantity: derivedQuantity.quantity,
      kind: derivedKind.kind,
      productId: product.productId,
      expiresAt: o.expiresAt,
      predecessorQuoteId: o.predecessorQuoteId,
      quoteId: o.quoteId,
      idempotencyKey: o.idempotencyKey
    });
    if (out.ok !== true) return out;

    const provenance = productProvenanceOf(product.productId);
    const result = Object.assign({}, out.result, {
      productBacked: true,
      derivedFrom: 'sqlite-products',
      /* 这份报价**派生自**哪些 canonical 值。写下来是为了让"价格是从哪
         来的"在审计里可读，而不是让下游再推导一次。 */
      derived: {
        currency: product.currency,
        unitPriceMinor: C.serializeAmountMinor(product.unitPriceMinor),
        units: units,
        quantity: derivedQuantity.quantity,
        kind: derivedKind.kind,
        settlementType: C.settlementTypeOfQuoteKind(derivedKind.kind),
        unitName: product.unitName,
        grantQuantity: product.grantQuantity
      },
      productProvenance: provenance
    });
    return Object.assign({}, out, { result: result });
  }

  /* ── mutateInventory：grant 与 consume 的**同一个**实现 ──────────────
     一个函数两个方向而不是两个函数：两者的差别**只有**符号、守卫与
     scope —— 三样都是参数。分成两份拷贝会让"并发安全"这条性质必须被
     证明两次，而其中一次的证明通常会被漏掉。

     ── §13：这是**底层 primitive**，不是 Purchase ────────────────────
     它不动钱（没有一次 ledger 写入）、不动钱包缓存、不创建 operation /
     reservation，也不消费任何报价。因此它的结果里逐字写着
     ledgerMutation: false / walletMutation: false / isAPurchase: false。
     未来的 Purchase 会在**同一个事务**里做 ledger + inventory 两件事，
     而那时它调用的是本函数（或者它同一层的实现），不是"再 grant 一次"。

     ── §16：并发安全的三道防线 ────────────────────────────────────────
       ① BEGIN IMMEDIATE —— 写锁在**读 canonical 数量之前**拿到，
          因此"读到的数"与"写回的数"之间不可能插入另一个 writer；
       ② 带算术守卫的 UPDATE（grow: `quantity + ? <= 上界`，
          shrink: `quantity >= ?`）—— 结果为 0 行即拒绝；
       ③ 表上的 CHECK (quantity >= 0) —— 即使前两道都被将来的重构破坏，
          负数量也进不了库。
     三道同时存在是有意的：§16 要求的是"结构性保证"，而"结构性"在这里
     意味着**不依赖任何单点**。 */
  function mutateInventory(mode, input) {
    requireOpen();
    const grant = String(mode) === 'grant';
    const scope = grant ? C.OPERATION_SCOPE.INVENTORY_GRANT : C.OPERATION_SCOPE.INVENTORY_CONSUME;
    const o = input || {};
    const owner = partyInput(o.ownerId != null ? o.ownerId : o.characterId);
    if (!owner.ok) return { ok: false, denied: false, reasonCode: null, errors: owner.errors };
    if (owner.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, denied: false, reasonCode: null, errors: ['system-party-cannot-hold-inventory'] };
    }
    const ownerId = String(owner.party.id);
    const productId = o.productId == null ? null : String(o.productId);
    if (!C.isEconomyId('PRODUCT', productId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['product-id-not-canonical'] };
    }
    const quantity = Number(o.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return denial(C.DENY_REASON.INVENTORY_INPUT_NOT_STRUCTURED,
        ['inventory-quantity-must-be-a-positive-safe-integer']);
    }
    /* 唯一物品在本阶段**不可表示**：契约用一个封闭集合 + 一条显式否认
       表达它，而这里把"有人试图按实例发放"变成一个明确的失败。 */
    if (o.instanceId != null || o.serial != null || o.uniqueItemId != null) {
      return denial(C.DENY_REASON.INVENTORY_INPUT_NOT_STRUCTURED,
        ['unique-item-instances-are-not-modelled-in-this-schema']);
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const fingerprint = inventoryFingerprint(scope, {
      ownerId: ownerId, ownerType: String(owner.party.type), productId: productId, quantity: quantity
    });
    /* 幂等闸门在任何写之前 —— 重放零成本、零副作用（P22-2 §14）。 */
    const seen = operationIdempotencyLookup(scope, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(scope, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    const productRow = db.prepare(SQL.selectProduct).get(productId);
    if (!productRow) {
      return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: productId });
    }
    const product = rowToProduct(productRow);
    if (product.assetKind == null) {
      /* SERVICE 商品不产生库存（§27/§54）。"给一次服务发库存"是一次
         建模错误，而它必须失败得明确，而不是悄悄写下一行数量。 */
      return denial(C.DENY_REASON.EFFECT_NOT_ALLOWED,
        ['this-product-fulfillment-does-not-produce-inventory'],
        { productId: productId, fulfillment: product.fulfillment });
    }
    let requestedEntryId = null;
    if (o.inventoryEntryId != null) {
      requestedEntryId = String(o.inventoryEntryId);
      if (!C.isEconomyId('INVENTORY_ENTRY', requestedEntryId)) {
        return { ok: false, denied: false, reasonCode: null, errors: ['inventory-entry-id-not-canonical'] };
      }
    }

    const at = clock();
    let committed = null;
    try {
      withTransaction(() => {
        const revision = allocateRevision();
        /* ── canonical 读：数量**只**从这一行来 ─────────────────────── */
        const existingRow = db.prepare(SQL.selectInventoryByOwnerProduct).get(ownerId, productId);
        let entryId;
        if (grant) {
          if (!existingRow) {
            entryId = requestedEntryId == null ? nextId('INVENTORY_ENTRY') : requestedEntryId;
            if (!C.isEconomyId('INVENTORY_ENTRY', entryId)) {
              throw refuse(null, ['inventory-entry-id-not-canonical']);
            }
            db.prepare(SQL.insertInventory).run(
              String(entryId), ownerId, String(owner.party.type), productId, String(product.assetKind),
              Number(quantity), key.key, fingerprint, Number(revision), Number(at), Number(at)
            );
            faultPoint('after-inventory-insert');
          } else {
            entryId = String(existingRow.inventory_entry_id);
            const before = Number(existingRow.quantity);
            /* JS 侧的溢出预判（给出可读的拒绝），SQL 侧的守卫是第二道。 */
            if (!Number.isSafeInteger(before + quantity) || before + quantity > MAX_INVENTORY_QUANTITY) {
              throw refuse(C.DENY_REASON.INVENTORY_INPUT_NOT_STRUCTURED,
                ['inventory-quantity-would-exceed-the-safe-integer-range'],
                { ownerId: ownerId, productId: productId, current: before, requested: quantity });
            }
            const grown = db.prepare(SQL.growInventory).run(
              Number(quantity), key.key, fingerprint, Number(revision), Number(at),
              String(entryId), Number(quantity), Number(MAX_INVENTORY_QUANTITY)
            );
            if (Number(grown.changes) !== 1) {
              throw refuse(C.DENY_REASON.INVENTORY_INPUT_NOT_STRUCTURED,
                ['inventory-quantity-growth-was-not-applied'],
                { ownerId: ownerId, productId: productId, current: before, requested: quantity });
            }
            faultPoint('after-inventory-write');
          }
        } else {
          /* ── 不足的两种形态，同一个 reason code，不同的 detail ──────
             "从来没有过这一行"与"有过但现在不够"对调用方是同一件事
             （拿不出这么多），因此共用一个代码；而 available / requested
             两个数把差别说清楚（§50："consume 8 → DENY，quantity 仍为 7"）。 */
          if (!existingRow) {
            throw refuse(C.DENY_REASON.INSUFFICIENT_INVENTORY, ['inventory-entry-not-found'],
              { ownerId: ownerId, productId: productId, available: 0, requested: quantity });
          }
          entryId = String(existingRow.inventory_entry_id);
          const before = Number(existingRow.quantity);
          if (before < quantity) {
            throw refuse(C.DENY_REASON.INSUFFICIENT_INVENTORY, ['inventory-quantity-is-insufficient'],
              { ownerId: ownerId, productId: productId, available: before, requested: quantity });
          }
          const shrunk = db.prepare(SQL.shrinkInventory).run(
            Number(quantity), key.key, fingerprint, Number(revision), Number(at),
            String(entryId), Number(quantity)
          );
          if (Number(shrunk.changes) !== 1) {
            throw refuse(C.DENY_REASON.INSUFFICIENT_INVENTORY, ['inventory-decrement-was-not-applied'],
              { ownerId: ownerId, productId: productId, available: before, requested: quantity });
          }
          faultPoint('after-inventory-write');
        }
        const row = db.prepare(SQL.selectInventoryEntry).get(String(entryId));
        if (!row) throw refuse(null, ['inventory-row-missing-after-write']);
        /* ── 一次**读回**的自检：写进去的数量必须等于我们算出来的那个数。
           它不是防御性编程，而是把"quantity 是这个账户唯一的真相"变成
           一条每次都被检查的性质（缓存不存在，因此这里读的就是它）。 */
        const after = Number(row.quantity);
        const expected = grant
          ? (existingRow ? Number(existingRow.quantity) + quantity : quantity)
          : Number(existingRow.quantity) - quantity;
        if (after !== expected || after < 0) {
          throw refuse(C.DENY_REASON.INVENTORY_INPUT_NOT_STRUCTURED,
            ['inventory-quantity-does-not-match-the-expected-result'],
            { ownerId: ownerId, productId: productId, before: existingRow ? Number(existingRow.quantity) : 0, expected: expected, actual: after });
        }
        const view = rowToInventoryEntry(row, productRow);
        const eventKind = grant ? C.EVENT_TYPE.INVENTORY_GRANTED : C.EVENT_TYPE.INVENTORY_CONSUMED;
        const result = {
          domain: C.DOMAIN,
          inventoryEntryId: String(entryId),
          ownerId: ownerId,
          ownerType: String(owner.party.type),
          productId: productId,
          assetKind: String(product.assetKind),
          quantity: after,
          previousQuantity: existingRow ? Number(existingRow.quantity) : 0,
          delta: grant ? Number(quantity) : -Number(quantity),
          grantedQuantity: grant ? Number(quantity) : 0,
          consumedQuantity: grant ? 0 : Number(quantity),
          eventKind: String(eventKind),
          revision: Number(revision),
          at: Number(at),
          idempotencyKey: key.key,
          entry: serializeInventoryEntry(view),
          /* ── §13/§14：三句逐字的自述 ────────────────────────────────
             primitive 不动钱、不动钱包；它不是一次购买。 */
          ledgerMutation: false,
          walletMutation: false,
          isAPurchase: false,
          notAPurchase: (grant ? 'grantInventory' : 'consumeInventory') +
            ' is an inventory primitive; a purchase is quote + reservation + ledger + inventory in ONE transaction (a later phase)'
        };
        appendChange({
          revision: Number(revision), kind: String(eventKind),
          entityId: String(entryId), transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            inventoryEntryId: String(entryId),
            ownerId: ownerId,
            ownerType: String(owner.party.type),
            productId: productId,
            assetKind: String(product.assetKind),
            quantity: after,
            previousQuantity: existingRow ? Number(existingRow.quantity) : 0,
            delta: grant ? Number(quantity) : -Number(quantity),
            ledgerMutation: false,
            walletMutation: false,
            isAPurchase: false
          }
        });
        faultPoint('before-inventory-change-log');
        writeOperationIdempotency(scope, key.key, fingerprint, {
          operationId: null, reservationId: null, transactionId: null
        }, result, revision, at);
        faultPoint('before-inventory-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger('economy-inventory-mutated', {
      mode: grant ? 'grant' : 'consume', ownerId: ownerId, productId: productId,
      quantity: committed.quantity, revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  function grantInventory(input) { return mutateInventory('grant', input); }
  function consumeInventory(input) { return mutateInventory('consume', input); }

  /* ══════════════════════════════════════════════════════════════════
     P22-4 · 评估完整性（§17 fail closed 的落点）
     ══════════════════════════════════════════════════════════════════ */

  /* 政策行是否**结构上**可信。任何一条不成立即"规则这一面不可信"，而
     不可信必须 fail closed（DENY），不能假装"没有规则所以随便花"。 */
  function policyProblemsOf(row) {
    const problems = [];
    const id = String(row.policy_id);
    if (!C.isEconomyId('BUDGET_POLICY', id)) { problems.push(id + ':policy-id-not-canonical'); return problems; }
    if (String(row.owner_id).trim() === '') { problems.push(id + ':owner-id-empty'); return problems; }
    if (String(row.owner_type) === C.PARTY_TYPE.SYSTEM) { problems.push(id + ':system-cannot-own-a-policy'); return problems; }
    if (!C.CURRENCIES.some(c => c === String(row.currency))) { problems.push(id + ':currency-not-registered'); return problems; }
    if (!C.isPolicyStatus(String(row.status))) { problems.push(id + ':status-not-in-closed-set'); return problems; }
    for (const entry of C.POLICY_LIMIT_TABLE) {
      const raw = row[entry.field];
      if (raw == null) continue;
      try { fromSqlAmount(raw, 'policy-limit-' + entry.name); }
      catch (error) { problems.push(id + ':limit-not-canonical:' + entry.name); return problems; }
    }
    if (row.approval_above_minor != null) {
      try { fromSqlAmount(row.approval_above_minor, 'policy-approval-threshold'); }
      catch (error) { problems.push(id + ':approval-threshold-not-canonical'); return problems; }
    }
    if (row.term_ends_at != null && !Number.isSafeInteger(Number(row.term_ends_at))) {
      problems.push(id + ':term-ends-at-not-a-safe-integer'); return problems;
    }
    return problems;
  }

  /* 报价行是否结构上可信。三条要点：
       · 结算形态必须与**种类**一致 —— 它是派生列，不一致意味着有人改过
         其中一列，而"将来怎么结算"因此有了两个答案；
       · 未终态的报价不可能有 successor；
       · 金额与数量必须是 canonical 量。 */
  function quoteProblemsOf(row) {
    const problems = [];
    const id = String(row.quote_id);
    if (!C.isEconomyId('QUOTE', id)) { problems.push(id + ':quote-id-not-canonical'); return problems; }
    if (!C.isEconomyId('PRODUCT', row.product_id)) { problems.push(id + ':product-id-not-canonical'); return problems; }
    if (!C.isQuoteKind(String(row.quote_kind))) { problems.push(id + ':quote-kind-not-in-closed-set'); return problems; }
    const expected = C.settlementTypeOfQuoteKind(row.quote_kind);
    if (String(row.service_role) !== String(expected)) {
      problems.push(id + ':settlement-type-does-not-match-the-quote-kind'); return problems;
    }
    if (!C.isQuoteState(String(row.state))) { problems.push(id + ':quote-state-not-in-closed-set'); return problems; }
    if (!C.CURRENCIES.some(c => c === String(row.currency))) { problems.push(id + ':currency-not-registered'); return problems; }
    try { fromSqlAmount(row.amount_minor, 'quote-amount'); }
    catch (error) { problems.push(id + ':amount-not-canonical'); return problems; }
    if (!Number.isSafeInteger(Number(row.quantity)) || Number(row.quantity) < 1) {
      problems.push(id + ':quantity-not-a-positive-safe-integer'); return problems;
    }
    if (!Number.isSafeInteger(Number(row.expires_at)) || Number(row.expires_at) < 0) {
      problems.push(id + ':expires-at-not-a-non-negative-safe-integer'); return problems;
    }
    if (String(row.quote_kind) === C.QUOTE_KIND.GIFT && row.recipient_id == null) {
      problems.push(id + ':gift-quote-without-a-recipient'); return problems;
    }
    if (String(row.quote_kind) !== C.QUOTE_KIND.GIFT && row.recipient_id != null) {
      problems.push(id + ':recipient-on-a-non-gift-quote'); return problems;
    }
    if (row.predecessor_quote_id != null && !C.isEconomyId('QUOTE', row.predecessor_quote_id)) {
      problems.push(id + ':predecessor-quote-id-not-canonical'); return problems;
    }
    return problems;
  }

  /* ── P22-5：目录与库存的结构完整性 ───────────────────────────────────
     与 policyProblemsOf / quoteProblemsOf 同款：逐行回答"这一行本身是不是
     一句说得通的话"。四个新函数各自对应一层，因为它们的**失败后果不同**：
       · storeProblemsOf      —— 组织方式坏了（没有任何经济后果，但目录乱了）
       · productProblemsOf    —— 商品坏了（价格/交付形态不可信 ⇒ 不可报价）
       · inventoryProblemsOf  —— 拥有的东西坏了（**这是经济事实**，最严重）
       · quoteProvenanceProblemsOf —— 报价的**来历**断了（§22：报价本身仍然
         说得清，断掉的是目录那一面 —— 因此它与 quoteProblemsOf 分开报） */
  function storeProblemsOf(row) {
    const problems = [];
    const id = String(row.store_id);
    if (!C.isEconomyId('STORE', id)) { problems.push(id + ':store-id-not-canonical'); return problems; }
    if (String(row.name).trim() === '') { problems.push(id + ':store-name-empty'); return problems; }
    if (!C.isStoreStatus(String(row.status))) { problems.push(id + ':store-status-not-in-closed-set'); return problems; }
    if (!Number.isSafeInteger(Number(row.sort_order))) { problems.push(id + ':sort-order-not-a-safe-integer'); return problems; }
    return problems;
  }

  /* 商品行是否结构上可信。三条要点：
       · 交付形态与资产形态必须与 **kind** 一致 —— 它们是派生列，不一致
         意味着有人改过其中一列，而"买完给什么"因此有了两个答案；
       · 单位名必须对 compute 两类恰是 computeUnit（否则"卖 token"这句话
         会在盘面上重新变得可能）；
       · grantQuantity 必须非负，且服务商品必须是 0。 */
  function productProblemsOf(row) {
    const problems = [];
    const id = String(row.product_id);
    if (!C.isEconomyId('PRODUCT', id)) { problems.push(id + ':product-id-not-canonical'); return problems; }
    if (!C.isEconomyId('STORE', row.store_id)) { problems.push(id + ':store-id-not-canonical'); return problems; }
    if (!C.isProductKind(String(row.product_kind))) { problems.push(id + ':product-kind-not-in-closed-set'); return problems; }
    const kind = String(row.product_kind);
    const expectedFulfillment = C.fulfillmentOfProductKind(kind);
    if (String(row.fulfillment) !== String(expectedFulfillment)) {
      problems.push(id + ':fulfillment-does-not-match-the-product-kind'); return problems;
    }
    const expectedAsset = C.assetKindOfProductKind(kind);
    const actualAsset = row.asset_kind == null ? null : String(row.asset_kind);
    if (actualAsset !== (expectedAsset == null ? null : String(expectedAsset))) {
      problems.push(id + ':asset-kind-does-not-match-the-product-kind'); return problems;
    }
    if (!C.isProductStatus(String(row.status))) { problems.push(id + ':product-status-not-in-closed-set'); return problems; }
    if (!C.CURRENCIES.some(c => c === String(row.currency))) { problems.push(id + ':currency-not-registered'); return problems; }
    try { fromSqlAmount(row.unit_price_minor, 'product-unit-price'); }
    catch (error) { problems.push(id + ':unit-price-not-canonical'); return problems; }
    const grant = Number(row.grant_quantity);
    if (!Number.isSafeInteger(grant) || grant < 0) { problems.push(id + ':grant-quantity-not-a-non-negative-safe-integer'); return problems; }
    if (expectedFulfillment === C.FULFILLMENT.SERVICE_EXECUTION && grant !== 0) {
      problems.push(id + ':a-service-product-must-not-grant-inventory-quantity'); return problems;
    }
    if (expectedFulfillment !== C.FULFILLMENT.SERVICE_EXECUTION && grant < 1) {
      problems.push(id + ':a-delivering-product-must-grant-a-positive-quantity'); return problems;
    }
    const unitName = String(row.unit_name);
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(unitName) || C.isForbiddenComputeAlias(unitName)) {
      problems.push(id + ':unit-name-is-not-canonical'); return problems;
    }
    if (expectedFulfillment === C.FULFILLMENT.COMPUTE_GRANT && unitName !== C.COMPUTE_UNIT_NAME) {
      problems.push(id + ':a-compute-product-must-use-the-frozen-compute-unit-name'); return problems;
    }
    return problems;
  }

  /* 库存行是**经济事实**，因此它的问题列表比目录两条更长：数量、owner、
     asset_kind 与商品的一致性，逐条查。 */
  function inventoryProblemsOf(row) {
    const problems = [];
    const id = String(row.inventory_entry_id);
    if (!C.isEconomyId('INVENTORY_ENTRY', id)) { problems.push(id + ':inventory-entry-id-not-canonical'); return problems; }
    if (String(row.owner_id).trim() === '') { problems.push(id + ':owner-id-empty'); return problems; }
    if (String(row.owner_type) === C.PARTY_TYPE.SYSTEM) { problems.push(id + ':system-cannot-hold-inventory'); return problems; }
    if (!C.isEconomyId('PRODUCT', row.product_id)) { problems.push(id + ':product-id-not-canonical'); return problems; }
    if (C.ASSET_KINDS.indexOf(String(row.asset_kind)) < 0) { problems.push(id + ':asset-kind-not-in-closed-set'); return problems; }
    const qty = Number(row.quantity);
    /* 这一条是 CHECK 约束的**读侧**对应物：一个负数不只是在库里不该存在，
       它在读出来之后也必须被认成"这一面不可信"而不是"欠我 3 个"。 */
    if (!Number.isSafeInteger(qty) || qty < 0) { problems.push(id + ':quantity-not-a-non-negative-safe-integer'); return problems; }
    const productRow = db.prepare(SQL.selectProduct).get(String(row.product_id));
    if (productRow && String(productRow.asset_kind) !== String(row.asset_kind)) {
      problems.push(id + ':asset-kind-differs-from-its-product'); return problems;
    }
    return problems;
  }

  /* 报价的来历。§22 选的语义是"Product 行是 provenance，不是有效性依赖"，
     因此这里报的是**悬挂引用**，而不是"这份报价坏了"。两句同时成立：
     报价照常可读、可评估；而目录这一面确实断了一根线。 */
  function quoteProvenanceProblemsOf(row) {
    const id = String(row.quote_id);
    if (!db.prepare(SQL.selectProduct).get(String(row.product_id))) {
      return [id + ':product-provenance-missing-the-quote-is-still-explainable'];
    }
    return [];
  }

  /* 整个 Economy 的**结构**是否可信。P22-3 逐钱包查引用链；P22-4 在这里
     加上"规则这一面"（政策行）与"命题这一面"（报价行）的全表扫描。
     P22-5 再加三层：货架 / 商品 / 库存 + 报价的来历。
     规模是 O(货架数 + 商品数 + 库存行数 + 报价数)。库存行**会**随经济
     活动增长，但它一个 owner 一件商品恰好一行，因此上界是
     (owner 数 × 商品数) —— 与订单数无关。 */
  function economyIntegrityCheck() {
    const problems = [];
    for (const row of db.prepare(SQL.selectBudgetPolicies).all(100000)) {
      problems.push.apply(problems, policyProblemsOf(row));
    }
    for (const row of db.prepare(SQL.selectQuotesAll).all()) {
      problems.push.apply(problems, quoteProblemsOf(row));
      problems.push.apply(problems, quoteProvenanceProblemsOf(row));
    }
    for (const row of db.prepare(SQL.selectStoresAll).all()) {
      problems.push.apply(problems, storeProblemsOf(row));
    }
    for (const row of db.prepare(SQL.selectProductsAll).all()) {
      problems.push.apply(problems, productProblemsOf(row));
    }
    for (const row of db.prepare(SQL.selectInventoryAll).all()) {
      problems.push.apply(problems, inventoryProblemsOf(row));
    }
    return problems;
  }

  /* test-only：把 reserved 缓存改坏，用来证明"它能从 active reservations
     重建"。与 corruptCachedBalanceForTest 同款，同样不在 HTTP 面上。 */
  function corruptReservedCacheForTest(walletId, value) {
    requireOpen();
    const n = C.normalizeAmountMinor(value);
    if (!n.ok) return { ok: false, errors: n.errors };
    const row = db.prepare(SQL.selectWallet).get(String(walletId));
    if (!row) return { ok: false, errors: ['wallet-not-found'] };
    db.prepare(SQL.setWalletReserved).run(
      toSqlAmount(n.amountMinor, 'test-corruption'),
      Number(row.revision), Number(row.updated_at), String(walletId)
    );
    return { ok: true, walletId: String(walletId), corruptedTo: C.serializeAmountMinor(n.amountMinor) };
  }

  /* 从 reservations **独立**算一遍（不碰缓存、不修缓存）。
     测试用它做对照：rebuild 的结果必须等于它。 */
  function reservedBalanceOf(walletId) {
    requireOpen();
    const row = db.prepare(SQL.selectWallet).get(String(walletId));
    if (!row) return { ok: false, errors: ['wallet-not-found'] };
    const canonical = computeReservedBalance(String(walletId));
    return {
      ok: true,
      walletId: String(walletId),
      currency: String(row.currency),
      reservedBalanceMinor: C.serializeAmountMinor(canonical.reservedMinor),
      activeReservations: canonical.activeCount,
      cachedReservedBalanceMinor: C.serializeAmountMinor(fromSqlAmount(row.reserved_balance_minor, 'cached-reserved'))
    };
  }

  function health() {
    const open = isOpen();
    let counts = {
      wallets: 0, transactions: 0, entries: 0, changes: 0, operations: 0, reservations: 0,
      activeReservations: 0, budgetPolicies: 0, activeBudgetPolicies: 0, quotes: 0, openQuotes: 0,
      stores: 0, activeStores: 0, products: 0, activeProducts: 0,
      inventoryEntries: 0, inventoryTotalQuantity: 0
    };
    let revision = 0;
    let schema = ECONOMY_SCHEMA_VERSION;
    if (open) {
      try {
        counts = {
          wallets: countWallets(), transactions: countTransactions(),
          entries: countEntries(), changes: Number((db.prepare(SQL.countChanges).get() || {}).c || 0),
          /* P22-3：counting 是观测，不是判断。把"现在有几笔钱被锁着"
             变成一个可断言的字段，比让运维去猜有用得多。 */
          operations: countOperations(), reservations: countReservations(),
          activeReservations: countReservationsByStatus(C.RESERVATION_STATE.ACTIVE),
          /* P22-4：规则与命题各有几个。同样只是观测 —— 尤其
             activeBudgetPolicies：它是"有几个 owner 真的受规则约束"，
             而 0 绝不等于"大家都没规则"，后者只能在评估时被回答。 */
          budgetPolicies: countBudgetPolicies(),
          activeBudgetPolicies: countBudgetPoliciesByStatus(C.POLICY_STATUS.ACTIVE),
          quotes: countQuotes(),
          openQuotes: countQuotesByState(C.QUOTE_STATE.OPEN),
          /* P22-5：目录与库存的规模。inventoryTotalQuantity 是"这个世界
             一共持有多少件东西"的一个横截面 —— 它同样只是观测，不是判定：
             没有任何规则读它（§40：货架不读关系，也不读总量来做推荐）。 */
          stores: countStores(),
          activeStores: countStoresByStatus(C.STORE_STATUS.ACTIVE),
          products: countProducts(),
          activeProducts: countProductsByStatus(C.PRODUCT_STATUS.ACTIVE),
          inventoryEntries: countInventory(),
          inventoryTotalQuantity: totalInventoryQuantity()
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
         而不是一句注释。P22-3 追加 reservation-writes：这一阶段新增了
         六个**会改状态**的方法（reserve/commit/release/expire/fail/
         sweep），而它们一个都不在 HTTP 面上 —— 这句话必须可断言。
         P22-4 追加 policy-writes / quote-writes：同样是"新增了会改状态
         的方法，而它们一个都不在 HTTP 上"。 */
      doesNotExpose: ['payments', 'credentials', 'provider-billing', 'topup', 'real-money',
        'reservation-writes', 'policy-writes', 'quote-writes',
        /* P22-5 又新增了五个会改状态的方法（putStore / putProduct /
           grantInventory / consumeInventory / createProductQuote）—— 名单
           必须跟着能力长，否则新能力会落在断言之外，而"没被断言"在实践
           中与"被允许"很难区分。 */
        'store-writes', 'product-writes', 'inventory-writes', 'purchase'],
      canonical: 'sqlite-ledger-entries',
      derived: 'wallet-cached-balance',
      /* reserved 这一面把 canonical 与 derived 各写一遍，因为它们是
         **两套**：余额来自 ledger，锁定量来自 reservation 行。 */
      reservedCanonical: 'sqlite-active-reservations',
      reservedDerived: 'wallet-reserved-balance-cache',
      reservationStateVocabulary: 'RESERVATION_STATE (P22-1 §12)',
      operationStateVocabulary: 'TX_STATE (P22-1 §8)',
      expirationIsNotATimer: true,
      /* ── P22-4：规则与命题的 canonical 来源，以及两条**边界自述** ────
         budgetWindowsCanonical：三个窗口累计从 committed ledger 事实算
         （不是缓存、不是 UI 计数器、不是任何"记忆"）。
         budgetSpendingTypes：哪些 transaction type 算消费 —— 由契约的
         封闭表给出，而不是靠"金额是不是负数"猜。
         budgetEvaluationIsNotAnAuthorization：本层产出的 ALLOW 是一次
         **快照评估**，不是可以拿去执行的许可。把它写成一个可断言字段，
         是因为这一条最容易被下游误当成凭证。 */
      budgetCanonical: 'sqlite-budget-policies + committed-ledger-facts',
      budgetDerived: 'none',
      budgetWindowsCanonical: 'UTC day/week/month buckets over committed ledger debits',
      budgetTimezone: C.BUDGET_TIMEZONE,
      budgetSpendingTypes: C.BUDGET_SPENDING_TYPES.slice(),
      budgetEvaluationIsNotASpendPermit: true,
      quoteCanonical: 'sqlite-quotes',
      quoteStateVocabulary: 'QUOTE_STATE (P22-1 §14)',
      quoteLocksNothing: true,
      /* ── P22-5：目录与库存的 canonical 来源，以及四句边界自述 ──────────
         inventoryDerived: 'none' 是这一节最要紧的一句（§17）：库存**没有**
         派生缓存，因此没有 rebuild，也没有开库对账 —— canonical 就是那一行。
         productPricingIsRelationshipFree / storeHasNoRecommendations 是
         §40/§41 的可断言形式：定价与关系无关、货架不是推荐系统。
         aGrantIsNotAPurchase 是 §13 的可断言形式：库存原语不动钱。 */
      storeCanonical: 'sqlite-stores',
      storeHoldsPrices: false,
      storeHoldsOwnership: false,
      storeHasNoRecommendations: true,
      productCanonical: 'sqlite-products',
      productPricingIsRelationshipFree: C.PRICING_IS_RELATIONSHIP_FREE,
      productSnapshotsAreFrozenInQuotes: true,
      inventoryCanonical: 'sqlite-inventory-rows',
      inventoryDerived: 'none',
      /* 这句话与 P22-2/P22-3 的 rebuild 是**两种**答案，因此它必须被写出
         来：不是因为"忘了写 rebuild"，而是因为这里根本没有缓存可重建。 */
      inventoryHasNoDerivedCacheToRebuild: true,
      inventoryIsNotABalance: true,
      inventoryUniqueItemsModelled: C.INVENTORY_UNIQUE_ITEMS_MODELLED,
      aGrantIsNotAPurchase: true,
      purchaseIsNotImplementedInThisPhase: true
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
    /* P22-3：资金被还回去的原因是一个**封闭**集合，与状态词表分开
       （见 RELEASE_REASON 的说明）。导出它是为了让测试与将来的审计
       读者不必硬编码这些字符串。 */
    RELEASE_REASON: RELEASE_REASON,
    COMMIT_COUNTERPARTIES: COMMIT_COUNTERPARTIES,
    TABLES: Object.freeze({
      META: META_TABLE, CHANGE_LOG: CHANGE_LOG_TABLE, IDEMPOTENCY: IDEMPOTENCY_TABLE,
      ACCOUNTS: ACCOUNTS_TABLE, WALLETS: WALLETS_TABLE,
      TRANSACTIONS: TRANSACTIONS_TABLE, ENTRIES: ENTRIES_TABLE,
      OPERATIONS: OPERATIONS_TABLE, RESERVATIONS: RESERVATIONS_TABLE,
      OPERATION_IDEMPOTENCY: OPERATION_IDEMPOTENCY_TABLE,
      BUDGET_POLICIES: BUDGET_POLICIES_TABLE, QUOTES: QUOTES_TABLE,
      STORES: STORES_TABLE, PRODUCTS: PRODUCTS_TABLE, INVENTORY: INVENTORY_TABLE
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

    /* ── P22-3：reservation 生命周期 ────────────────────────────────────
       这六个方法会**改状态**，因此它们与铸币同级：只对同进程调用方开放，
       不在任何 HTTP 路由上（http.js 的 /economy/* 全是 GET，而且
       boundary B11/B12 会逐字断言这一层的方法名不出现在 http.js 里）。 */
    reserveFunds: reserveFunds,
    commitReservation: commitReservation,
    releaseReservation: releaseReservation,
    expireReservation: expireReservation,
    failReservation: failReservation,
    expireDueReservations: expireDueReservations,
    rebuildReservedBalance: rebuildReservedBalance,
    reconcileReservations: reconcileReservations,

    /* P22-3：读取（可被 HTTP 只读面使用） */
    getReservation: getReservation,
    listReservations: listReservations,
    getOperation: getOperation,
    listOperations: listOperations,
    serializeReservation: serializeReservation,
    serializeOperation: serializeOperation,

    /* ── P22-4：预算政策 ────────────────────────────────────────────────
       写的一半与 P22-3 的六个 mutation 同级：只对同进程调用方开放，
       不在任何 HTTP 路由上。读的一半（get/list/serialize）可以被
       HTTP 只读面使用。 */
    putBudgetPolicy: putBudgetPolicy,
    expirePolicy: expirePolicy,
    expireDuePolicies: expireDuePolicies,
    getBudgetPolicy: getBudgetPolicy,
    listBudgetPolicies: listBudgetPolicies,
    serializeBudgetPolicy: serializeBudgetPolicy,
    /* 纯读：组装 canonical 快照并交给契约的确定性评估器。 */
    buildBudgetSnapshot: buildBudgetSnapshot,
    spendingWindows: spendingWindows,
    evaluateBudgetFor: evaluateBudgetFor,
    serializeBudgetSnapshot: serializeBudgetSnapshot,

    /* ── P22-4：报价（价格命题，不是资源锁定）────────────────────────── */
    createQuote: createQuote,
    expireQuote: expireQuote,
    expireDueQuotes: expireDueQuotes,
    getQuote: getQuote,
    listQuotes: listQuotes,
    serializeQuote: serializeQuote,
    /* evaluateQuote **只读**：它不 reserve、不消费报价、不改状态（§18）。
       因此它与 get/list 同级，可以被 HTTP 只读面使用。 */
    evaluateQuote: evaluateQuote,

    /* ── P22-5：货架 / 商品 / 库存 ──────────────────────────────────────
       写的一半（putStore / putProduct / grantInventory / consumeInventory /
       createProductQuote）与 P22-3/P22-4 的 mutation 同级：只对同进程
       调用方开放，**不在任何 HTTP 路由上**（boundary B15 逐名断言）。
       读的一半（get/list/serialize）可以被 HTTP 只读面使用。 */
    putStore: putStore,
    putProduct: putProduct,
    getStore: getStore,
    listStores: listStores,
    getProduct: getProduct,
    listProducts: listProducts,
    serializeStore: serializeStore,
    serializeProduct: serializeProduct,
    /* createProductQuote 是**唯一** canonical 的报价生成路径：它从商品
       派生价格/币种/数量/种类。P22-4 的 createQuote 保留为冻结的底层
       primitive（§21），两者的分工写在名字里。 */
    createProductQuote: createProductQuote,
    /* 库存原语。**不是** Purchase（§13）：它不动钱、不动钱包。 */
    grantInventory: grantInventory,
    consumeInventory: consumeInventory,
    getInventoryEntry: getInventoryEntry,
    listInventory: listInventory,
    inventoryQuantity: inventoryQuantity,
    serializeInventoryEntry: serializeInventoryEntry,
    productProvenanceOf: productProvenanceOf,

    /* 观测 */
    health: health,
    isDegraded: isDegraded,
    getRevision: getRevision,

    /* test-only（不在 HTTP 面上） */
    corruptCachedBalanceForTest: corruptCachedBalanceForTest,
    corruptReservedCacheForTest: corruptReservedCacheForTest,
    ledgerBalanceOf: ledgerBalanceOf,
    reservedBalanceOf: reservedBalanceOf,
    systemAccountBalance: systemAccountBalance,

    /* 内部工具，供 boundary/装配断言"没有别的余额写路径"时点名 */
    _internal: Object.freeze({
      stableStringify: stableStringify,
      fingerprint: fingerprintOf,
      deriveEntryId: deriveEntryId,
      deriveCommitTransactionId: deriveCommitTransactionId,
      operationFingerprint: operationFingerprint,
      policyFingerprint: policyFingerprint,
      quoteFingerprint: quoteFingerprint,
      walletStructuralProblems: walletStructuralProblems,
      reservationProblemsOf: reservationProblemsOf,
      policyProblemsOf: policyProblemsOf,
      quoteProblemsOf: quoteProblemsOf,
      storeProblemsOf: storeProblemsOf,
      productProblemsOf: productProblemsOf,
      inventoryProblemsOf: inventoryProblemsOf,
      quoteProvenanceProblemsOf: quoteProvenanceProblemsOf,
      economyIntegrityCheck: economyIntegrityCheck,
      spendingWindowBounds: spendingWindowBounds,
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
  TRANSACTIONS: TRANSACTIONS_TABLE, ENTRIES: ENTRIES_TABLE,
  OPERATIONS: OPERATIONS_TABLE, RESERVATIONS: RESERVATIONS_TABLE,
  OPERATION_IDEMPOTENCY: OPERATION_IDEMPOTENCY_TABLE,
  BUDGET_POLICIES: BUDGET_POLICIES_TABLE, QUOTES: QUOTES_TABLE,
  STORES: STORES_TABLE, PRODUCTS: PRODUCTS_TABLE, INVENTORY: INVENTORY_TABLE
});
module.exports.releaseReason = RELEASE_REASON;
module.exports.maxInventoryQuantity = MAX_INVENTORY_QUANTITY;
module.exports.fnv1a64Hex = fnv1a64Hex;
module.exports.stableStringify = stableStringify;
