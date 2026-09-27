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
     3 → 4（P22-5）仍然是空的 MIGRATIONS 条目：没有既有列需要改写，只有新表。

   ── P22-6：4 → 5 ────────────────────────────────────────────────────
     同一条纪律的第五次应用。P22-6 让这个库多出**一张**表
     （economy_purchases），于是：
       · 一个 P22-5 的 build 打开 P22-6 的库 → **拒绝**（SCHEMA_TOO_NEW）。
         如果它不拒绝，它就会看到一个"预留凭空变成 COMMITTED、报价凭空
         变成 CONSUMED、库存凭空多出来"的经济 —— 而它会把那些状态变化
         归因到它认识的 primitive 上（reserve / commit / inventory），
         于是审计给出的答案是**错的**。这比打不开严重。
       · 一个 P22-6 的 build 打开 P22-5 的库 → 受支持的老版本路径，
         DDL 补上那张表，水位抬到 5，**既有 ledger / reservation /
         policy / quote / store / product / inventory 行一个字节都不动**
         （focused 测试的 N 组逐条断言）。
     4 → 5 依然是空的 MIGRATIONS 条目：没有既有列需要改写，只有新表。

   ── P22-7：5 → 6 ────────────────────────────────────────────────────
     同一条纪律的第六次应用。P22-7 让这个库多出**两张**表
     （economy_autonomy_policies / economy_approvals）**外加 purchases 上的
     四个授权列**，于是：
       · 一个 P22-6 的 build 打开 P22-7 的库 → **拒绝**（SCHEMA_TOO_NEW）。
         如果它不拒绝，它就会看到一个"有些购买凭空成立、而没有任何规则
         说过它们可以"的经济 —— 它会把每一笔 COMPLETED 都当成"有人按了
         按钮"，于是审计里"这笔为什么没问用户"永远得不到答案。这比打不开
         严重。
       · 一个 P22-7 的 build 打开 P22-6 的库 → 受支持的老版本路径：
         DDL 补两张表，5 → 6 的 MIGRATIONS 给 purchases **补四个可空列**，
         水位抬到 6，**既有 ledger / reservation / policy / quote / store /
         product / inventory / purchase 行的经济内容一个字节都不动**。

     ★ 为什么 5 → 6 的 MIGRATIONS **不再是空的**（前五次都是）：
     前五次只多表，而这次 purchases 需要知道"这笔购买当初凭什么成立"。
     那是一个**既有行**上的新事实，因此必须真的 ALTER TABLE。SQLite 的
     `ALTER TABLE ... ADD COLUMN` 对既有行填 NULL —— 而 NULL 在这里恰好
     是正确的语义：**P22-7 之前写下的购买没有授权模式**，把它猜成
     AUTO_ALLOW 或 APPROVAL 都是伪造历史。integrity check 因此把
     "旧行的 approval_mode 为 NULL" 认成合法，而"新行没有它"认成问题。

     ★ 6 → 7（P22-8）又回到了**空**的迁移，而这不是退步：
     新增的只有一张表（economy_purchase_intents），没有任何既有列需要
     改写 —— 因为"一次打算买什么"在 P22-8 之前**根本不存在**：它不是
     既有行上的新事实，而是一个全新的实体。这与 5 → 6 恰好相反，而两者
     的差别正是这条纪律的判据：**新实体 → 空迁移 + 补表；既有实体上的
     新事实 → 非空迁移 + ALTER**。
     为什么这条差别值得写下来：一次"顺手也 ALTER 一下 purchases"的迁移
     会把 intent 的 id 塞进 purchase 行，而 purchase 行只该描述**已经
     预留了资金**的那件事（intent_id 留在 intent 那一侧，见下面的 DDL）。

     ★ 水位仍然要抬到 7，因为一个 P22-7 的 build 打开 P22-8 的库时**必须
     拒绝**：它看不到 economy_purchase_intents，于是会理直气壮地认为
     "这个经济里没有任何待批准的打算" —— 那个误读比打不开严重得多。 */
/* ── P22-26 · Schema 水位 8：`quotes.units` ───────────────────────────
   唯一被改的是 **quotes** 上的一列：`units`（这份报价买了几份）。

   ★ 为什么它必须在**报价**这一侧落库（而不是"prepare 时从请求里再要
   一次"）：`quotes.quantity` 是**送达量**（units × grantQuantity），
   因此"买了几份"这个**选择**在 P22-4 到 P22-25 之间从来没有被落库过 ——
   而 P22-6 的 preparePurchase 却要拿它去重算金额与数量并比对。调用方
   不传 units 时那个缺省是 1，于是 `units > 1` 的报价**必然**被自己的
   重算判成 QUOTE_MISMATCH：**报价把 units 算进了 quantity 与 amount，
   报价自己却没有保存它。** 一次"一次买三份"的失败因此长得像"账目对不
   上"，而它是自主 Agent 最难自愈的那类拒绝。

   修法是让报价**快照自足**（P22-4 的既有纪律）：units 与 quantity 变成
   两个各自被冻结的事实，关系（quantity = units × grantQuantity）由
   prepare 的比对钉住，而 prepare **不再从 payload 猜**。

   新列 NOT NULL DEFAULT 1：历史行确实没有落过这个事实，而它们全部走的
   是"一次一份"（那时 `quantity` 就等于 `grantQuantity`），因此 1 是对
   **旧行**唯一正确的答案。新写入一律由 createProductQuote 显式给出
   units；只有 raw createQuote（P22-4 的 primitive —— 它没有商品行，
   因而根本没有 grantQuantity 概念）才落到那个 1。

   ★ 水位抬到 8 是必须的：一个 P22-25 的 build 打开这张库时看不到
   `quotes.units`，于是会把每一份报价都读成"一次一份"，随后用那个 1 去
   重算并拒绝一份 units = 3 的报价。那个误读比打不开更隐蔽 —— 因此它
   必须打不开。 */
const ECONOMY_SCHEMA_VERSION = 8;
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
/* ── P22-6 ────────────────────────────────────────────────────────────
   第四张表（第五次抬水位）。Purchase 是**它自己的实体**，不是 ledger
   transaction 的一个视图、也不是 reservation 的别名：

     · 它引用的四件事（product / quote / reservation / ledger transaction）
       各自有自己的表与 id 前缀，因此 purchase 只需要**外键形状的列**；
     · 它自己带一个生命周期（RESERVED → {COMPLETED, RELEASED, FAILED}），
       而那个生命周期比任何一个被引用者的生命周期都长（一次购买可以在
       报价仍然 OPEN、预留已经 RELEASED 之后仍然存在）；
     · 它保存**结算所需的最小快照**（fulfillment / assetKind / quantity /
       unitName / currency / amountMinor），于是最终结算不需要回读一个
       可变的 Product 行。

   刻意**没有**的列：任何 ledger 金额的副本（金额只有一列，来自 Quote
   快照）、任何 provider/payment/memory/relationship 字段、任何正文。 */
const PURCHASES_TABLE = 'economy_purchases';
/* ── P22-7 ────────────────────────────────────────────────────────────
   第六张与第七张表（第六次抬水位）。两者的**不等式**正是本阶段的全部
   内容（§3 与 §5）：

     · economy_autonomy_policies —— "Agent 有没有权不问用户直接花"。
       ★ 它**不是** economy_budget_policies 的一张扩展表，也不是它的
       别名：Budget 回答"经济上最多允许花多少"，Autonomy 回答"是否有权
       不问用户直接花"。两张表并存，因为两句话可以**各自独立地**给出
       相反的答案（Budget ALLOW + Autonomy REQUIRE_APPROVAL 仍然必须问
       用户；Autonomy AUTO_ALLOW + Budget DENY 绝对不能买）。
       把它塞进预算政策表会让"这条额度是钱的上限还是权限的上限"成为
       同一行上的一个字段，而它决定了完全不同的两件事。
       它的记录**形状**（policyId / ownerId / enabled / …Minor / status）
       与预算政策同款是刻意的 —— 同一套 id 种类（econ_policy_）、同一套
       金额后缀纪律、同一条"规则不是许可"语义。

     · economy_approvals —— 一条**批准记录**。§5 的不等式是
       Approval ≠ Purchase：前者是"用户授权一个被冻结的购买意图继续执行"，
       后者是"这件事真的发生了"。一次批准可以存在而永远没有购买（用户
       批准了但 Agent 没买），而一笔购买可以没有任何批准（它是自主成立的）。
       它必须**绑定九个经济事实**（§6）而不是一个金额，因此它的列里有
       product_id / quote_id / recipient_* / grant_quantity / units ——
       一张只写"批准了 400"的记录无法拒绝"拿这 400 去买别的东西"。

   刻意**没有**的列（两张表都没有）：任何正文 / prompt / persona /
   relationship / memory / provider / payment 字段。自主策略的输入白名单
   在契约里是封闭的（AUTONOMY_POLICY_INPUT_KEYS），而这里连**地方**都
   不给它留 —— "Agent 觉得可以买"在这两张表上无处可写。 */
const AUTONOMY_POLICIES_TABLE = 'economy_autonomy_policies';
const APPROVALS_TABLE = 'economy_approvals';

/* ── P22-8 · Agent Purchase Intent（一次**打算**买什么）───────────────
   一张表，而且它刻意**不是** economy_purchases。

   ★ 为什么必须是两张表（这是本阶段最重要的一次切分）：
     · economy_purchases 的每一行都意味着一笔**已经预留了资金**的购买
       （P22-6：它的唯一入口状态是 RESERVED）。把"打算"写进去，就必须
       给 purchase 加一个"还没有预留"的状态 —— 而 P22-6 逐字拒绝过
       CREATED 状态，理由正是"尚未结算"与"还没有购买"会互相伪装。
     · 一条 Intent 可以**永远**不变成购买（WAITING_APPROVAL / DENIED /
       EXPIRED），可以在没有任何资金动作的情况下存在。它是**编排事实**，
       不是经济事实（§8）。编排事实与经济事实各有一张表，各自的
       canonical owner 才成立。

   刻意**没有**的列：amount_minor / currency / price / grant_quantity /
   settlement_type / wallet_id / reservation_id / transaction_id ——
   经济值一个都不在这里。价格事实唯一的家是 quotes（P22-4 冻结），
   而这正是 §4"Agent 不得提供经济事实"在**表结构**上的那一半：
   即使有人想从这条记录读价格，也读不到。

   唯一的例外是 `units`：它是**选择**而不是事实（"两杯咖啡"），
   而 P22-6 的 preparePurchase 也要求调用方说出 units，因此它必须被
   记下来，否则恢复路径无法用同一个数量重建同一次请求。 */
const PURCHASE_INTENTS_TABLE = 'economy_purchase_intents';

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

/* ── P22-19 · change log 的归属谓词与 owner 键 ────────────────────────
   ★ 归属只有**一处**实现（这里 + SQL.selectChangesByOwner{Asc,Desc}）。
     在此之前它在浏览器解释层（P22-18 的 changeBelongsTo），而那条规则
     有两个实测出来的结构性缺陷，见 listChangesForOwner 的说明。

   一个 owner 在 change log 里可能出现的样子：
   ★ 两种拼写**都是** canonical 的，因此这里不是"容错"，而是把契约的
     封闭 party 类型集合逐一列出来：`character:char_a` 与 `char_a` 指的是
     同一个 party，读面必须同时认。
   ★ 词表来自契约的 `PARTY_TYPES`（封闭三词），不在这里另写一份。 */
function ownerScopedChangeKeys(ownerKey, partyTypes) {
  const types = Array.isArray(partyTypes) ? partyTypes : [];
  const keys = [ownerKey];
  for (let i = 0; i < types.length; i += 1) {
    const t = String(types[i]);
    if (t) keys.push(t + ':' + ownerKey);
  }
  return keys;
}

/* owner 归属谓词（canonical `affectedOwner` 的**唯一**实现）。
   参数 `n` 是 owner 键的个数；四个证据分支见
   SQL.selectChangesByOwnerAsc 上面的说明。
   占位符的次序是固定的：E1、E2、E3×3、E4 —— 绑定侧必须逐个对应。 */
function changeOwnerPredicate(n) {
  const list = 'IN (' + new Array(n).fill('?').join(',') + ')';
  return '(' +
    'wallet_id IN (SELECT wallet_id FROM ' + WALLETS_TABLE + ' WHERE owner_id = ?)' +
    ' OR transaction_id IN (SELECT e.transaction_id FROM ' + ENTRIES_TABLE + ' e' +
      ' JOIN ' + WALLETS_TABLE + ' w ON w.account_id = e.account_id' +
      ' WHERE w.owner_id = ? AND e.transaction_id IS NOT NULL)' +
    ' OR (json_valid(payload_json) AND (' +
      'json_extract(payload_json, \'$.ownerId\') ' + list +
      ' OR json_extract(payload_json, \'$.buyerId\') ' + list +
      ' OR json_extract(payload_json, \'$.agentId\') ' + list + '))' +
    ' OR entity_id IN (SELECT approval_id FROM ' + APPROVALS_TABLE + ' WHERE buyer_id = ?)' +
    ')';
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
    /* ★ P22-7：system account 的创建是**并发安全**的（见 ensureSystemAccount
       的说明）。它与上面那条 insertAccount 并存而不是替换它：钱包账户的
       创建必须保持"撞主键 = 一次真实的错误"，因为一个重复的钱包账户
       意味着余额被劈成两半 —— 那种情况**不能**被静默忽略。
       system account 则相反：白名单只有四个，身份就是主键，"它已经存在"
       与"我刚创建了它"对调用方是同一个结果。 */
    insertAccountIfAbsent:
      'INSERT OR IGNORE INTO ' + ACCOUNTS_TABLE + ' (account_id, kind, owner_id, currency, wallet_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
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
    /* ── P22-19 · owner-scoped 的 change 读面（**唯一**的归属实现）────────
       ★ 为什么它必须在 SQL 里、而不是"取一段再在 JS 里筛"：change log 是
         **全局**的（所有 owner、所有货架、所有商品、所有 intent 共用一本），
         而分页是 `revision` 上的 keyset。先取一页再筛，筛出来的是"这一页
         里的那些"，不是"这个 owner 的那些" —— 见 docs §3.2 的对抗性反证。
       ★ 归属判据（canonical `affectedOwner`，四处证据的**析取**）：
         E1 `wallet_id` 属于该 owner 的钱包（列本身就是 canonical 的）；
         E2 这笔账本交易动到的钱包里有该 owner 的（**列只记 touched[0]**，
            所以必须走 entries；见 appendChange 的调用点与
            docs §2.4 的 `payload.wallets[]` 实测）；
         E3 payload 里的当事人字段（ownerId / buyerId / agentId）等于该
            owner —— 两种 canonical 拼写**都认**（裸 id，以及
            `<partyType>:<id>`；见 docs §2.3 的实测差异）；
         E4 该 change 的 entity_id 是一条**属于该 owner 的批准**
            （APPROVAL_* 的 owner 权威在 approvals 行上，不在 payload 里：
            APPROVAL_EXPIRED 的 payload **一个 owner 字段都没有**）。
         ★ 刻意**不含** `recipientId`：一次"买给别人"是**买家**的钱动了，
           收礼的人余额没有变化（P22-18 的决定，本阶段不倒退）。
         见 docs §6 的 gift 语义。
       ★ `json_valid` 守卫是必要的，不是防御性编程：`listChanges` 的 JS
         读取路径对坏 JSON 是 try/catch（返回 null），而 SQL 的
         `json_extract` 遇到坏 JSON 会**整个查询报错** —— 一行历史数据形状
         异常不该让整条时间线打不开。 */
    selectChangesByOwnerAsc:
      'SELECT revision, kind, entity_id, transaction_id, wallet_id, at, payload_json FROM ' + CHANGE_LOG_TABLE +
      ' WHERE revision > ? AND %PREDICATE% ORDER BY revision ASC LIMIT ?',
    selectChangesByOwnerDesc:
      'SELECT revision, kind, entity_id, transaction_id, wallet_id, at, payload_json FROM ' + CHANGE_LOG_TABLE +
      ' WHERE revision < ? AND %PREDICATE% ORDER BY revision DESC LIMIT ?',
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
      /* ── P22-26 · `units`（这份报价买了几份）─────────────────────────
         ★ 它与 `quantity` 是**两个各自被冻结的事实**，不是一个的两个名字：
           quantity = units × grantQuantity —— quantity 是**送达量**，
           而 units 是**选择**（"两杯咖啡"）。
         在 P22-26 之前这一列不存在，于是 preparePurchase 只能从请求里
         再要一次 units（默认 1），并用它重算金额与数量去比对报价 ——
         结果是 `units > 1` 的报价**必然**被自己的重算拒绝（见水位 8 的
         说明）。现在 prepare **读这一列**，不再从 payload 猜。
         NOT NULL DEFAULT 1 只服务于**历史行**：那些行确实只可能是"一次
         一份"。新行一律由 createProductQuote 显式写入 units；raw
         createQuote（P22-4 的 primitive，没有商品行）写 1。
         CHECK 与 purchases.units 同款：份数是一个**正的安全整数**。 */
      ' units INTEGER NOT NULL DEFAULT 1 CHECK (units >= 1),' +
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
      'INSERT INTO ' + QUOTES_TABLE + ' (quote_id, product_id, buyer_id, buyer_type, recipient_id, recipient_type, currency, amount_minor, quantity, units, quote_kind, service_role, state, expires_at, predecessor_quote_id, idempotency_key, fingerprint, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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

    /* ══ P22-6 · Purchase（高层生命周期 + 结算快照）══════════════════════
       这张表回答的是"这次购买是哪一次购买"，而不是"钱动了多少"——
       金额在 amount_minor（来自 Quote 快照），钱动没动在 ledger 里。

       四条约束故意都落在 SQLite 上，而不是只靠 JS：

       ① purchase_id PRIMARY KEY —— 身份唯一。
       ② ledger_transaction_id UNIQUE —— **一笔 ledger transaction 不可能
          被两笔 purchase 同时指向**。SQLite 的 UNIQUE 允许多个 NULL，
          因此它约束的恰好是"已结算"的那一侧。这是"一次购买最多一笔交易"
          的结构性一半。
       ③ quote_id UNIQUE —— **一份报价不可能被两笔 purchase 同时指向**。
          为什么是 UNIQUE 而不是 partial（只在非终态唯一）：一份 Quote 是
          一次性的价格命题（P22-4 §9），它只能被消费一次；而"这次购买
          释放了"并不让那份报价重新变成可用的价格命题 —— 重新买需要一份
          新的报价。这条约束**不依赖任何状态检查**就挡住了 §38 的
          "同一个 Quote 被第二个 Purchase 用掉"。
          它与 ② 一起给出完整的两半：③ 保证 quote 只被一笔 purchase 引用，
          ② 保证那笔 purchase 只可能有一笔交易。
       ④ status / fulfillment / asset_kind CHECK —— 词表成员由数据库本身
          把关（与 inventory 的 CHECK (quantity >= 0) 同款：约束不是注释）。

       刻意**没有**的列：provider_* / api_key / payment_intent / checkout_url /
       relationship_id / memory_ref / discount / coupon / recommended ——
       它们不是"暂时没填"，而是**没有地方可以填**。 */
    createPurchases:
      'CREATE TABLE IF NOT EXISTS ' + PURCHASES_TABLE + ' (' +
      ' purchase_id TEXT PRIMARY KEY,' +
      ' buyer_id TEXT NOT NULL,' +
      ' buyer_type TEXT NOT NULL,' +
      ' recipient_id TEXT,' +
      ' recipient_type TEXT,' +
      ' product_id TEXT NOT NULL,' +
      ' store_id TEXT,' +
      ' quote_id TEXT NOT NULL,' +
      ' reservation_id TEXT NOT NULL,' +
      ' ledger_transaction_id TEXT,' +
      ' currency TEXT NOT NULL,' +
      ' amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),' +
      ' quote_kind TEXT NOT NULL CHECK (quote_kind IN (\'PURCHASE\',\'GIFT\',\'COMPUTE_GRANT\')),' +
      ' settlement_type TEXT NOT NULL CHECK (settlement_type IN (\'INVENTORY_GRANT\',\'COMPUTE_GRANT\',\'SERVICE_EXECUTION\')),' +
      ' asset_kind TEXT CHECK (asset_kind IS NULL OR asset_kind IN (\'ITEM\',\'COMPUTE\')),' +
      ' granted_quantity INTEGER NOT NULL CHECK (granted_quantity >= 0),' +
      ' unit_name TEXT,' +
      ' status TEXT NOT NULL CHECK (status IN (\'RESERVED\',\'COMPLETED\',\'RELEASED\',\'FAILED\')),' +
      ' release_reason TEXT,' +
      ' reason_code TEXT,' +
      ' reservation_state TEXT NOT NULL,' +
      ' reservation_expires_at INTEGER,' +
      ' inventory_entry_id TEXT,' +
      ' consent_snapshot TEXT,' +
      /* ── P22-7：授权那一面的四个列（schema 5 → 6）────────────────────
          ★ 为什么它们必须在 **purchase** 这一侧：一句"这笔购买当初凭什么
          成立"是关于**购买**的事实，而它必须在结算时仍然可读（授权政策
          可能在 prepare 与 settle 之间被改掉）。因此它是购买自己的一列，
          而不是"去批准表里反查"。

             approval_mode         AUTO_ALLOW | APPROVAL（NULL = P22-7 之前的历史行）
             approval_id                被消费的那条批准（mode=APPROVAL 时非 NULL）
             autonomy_policy_id         做出 AUTO_ALLOW 结论的策略（可追溯"为什么没问用户"）
             approval_binding_fingerprint  授权那一刻的九元组身份（可独立重算）

          刻意**没有** approval_decision / approved_by / approval_expires_at
          这类副本：那些事实的 canonical 位置是 economy_approvals 那一行，
          抄一份到这里就会有两个会漂移的答案（P22-7 的 integrity check
          会逐行验证 approval_id 指向的行真的存在且确实被这笔购买消费）。 */
      ' approval_mode TEXT CHECK (approval_mode IS NULL OR approval_mode IN (\'AUTO_ALLOW\',\'APPROVAL\')),' +
      ' approval_id TEXT,' +
      ' autonomy_policy_id TEXT,' +
      ' approval_binding_fingerprint TEXT,' +
      /* ★ `units`（买了几份）是 P22-7 加的一列，而它不是冗余：Quote 行上的
         `quantity` 是**计算出来的发放份数**（grantQuantity × units），
         因此"买了几份"在 P22-6 里从来没有被落库过。而它是批准九元组里的
         一员（§6 逐字点了"数量"），所以结算时那句"这张许可证说的就是这
         一笔吗"的比对必须有一个权威来源 —— 从 granted_quantity 反推会
         在商品改过 grantQuantity 之后给出错误答案，而落一列不依赖任何假设。 */
      ' units INTEGER CHECK (units IS NULL OR units >= 1),' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' completed_at INTEGER' +
      ')',
    createPurchasesByBuyer: 'CREATE INDEX IF NOT EXISTS idx_econ_purchases_buyer ON ' + PURCHASES_TABLE + ' (buyer_id, status, created_at)',
    createPurchasesByRecipient: 'CREATE INDEX IF NOT EXISTS idx_econ_purchases_recipient ON ' + PURCHASES_TABLE + ' (recipient_id, status, created_at)',
    createPurchasesByStatus: 'CREATE INDEX IF NOT EXISTS idx_econ_purchases_status ON ' + PURCHASES_TABLE + ' (status, created_at)',
    createPurchasesByQuote: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_purchases_quote ON ' + PURCHASES_TABLE + ' (quote_id)',
    createPurchasesByProduct: 'CREATE INDEX IF NOT EXISTS idx_econ_purchases_product ON ' + PURCHASES_TABLE + ' (product_id, status)',
    /* 预留是 1:1 的，因此这条索引同时也是"一笔预留只属于一次购买"的
       结构性约束（NULL 仍然不参与）。 */
    createPurchasesByReservationLive: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_purchases_reservation ON ' + PURCHASES_TABLE + ' (reservation_id)',
    createPurchasesByLedgerTransaction: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_purchases_tx ON ' + PURCHASES_TABLE + ' (ledger_transaction_id)',
    /* P22-7 的两条索引。第一条让"这个 owner 今天自主花了多少"（结算时
       重新评估日自主额度的那次查询）走索引而不是全表扫；第二条让
       "这条批准被哪笔购买消费"能双向查（approve→purchase 是
       selectApprovalByConsumedPurchase，这里是 purchase→approval）。
       刻意**不**给 approval_id 加 UNIQUE：一笔购买恰好引用一条批准是
       业务事实，而"一条批准最多被一笔购买消费"已经由
       setApprovalConsumed 的谓词与 approvals 那一侧的 UNIQUE 索引保证
       —— 在购买侧再声明一次会给出两个都叫"唯一"而管的不是同一件事的约束。 */
    createPurchasesByApproval: 'CREATE INDEX IF NOT EXISTS idx_econ_purchases_approval ON ' + PURCHASES_TABLE + ' (autonomy_policy_id, approval_mode, status, completed_at)',
    createPurchasesByApproval: 'CREATE INDEX IF NOT EXISTS idx_econ_purchases_approval ON ' + PURCHASES_TABLE + ' (approval_id)',

    insertPurchase:
      'INSERT INTO ' + PURCHASES_TABLE + ' (purchase_id, buyer_id, buyer_type, recipient_id, recipient_type, product_id, store_id, quote_id, reservation_id, ledger_transaction_id, currency, amount_minor, quote_kind, settlement_type, asset_kind, granted_quantity, unit_name, status, release_reason, reason_code, reservation_state, reservation_expires_at, inventory_entry_id, consent_snapshot, approval_mode, approval_id, autonomy_policy_id, approval_binding_fingerprint, units, idempotency_key, fingerprint, revision, created_at, updated_at, completed_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectPurchase: 'SELECT * FROM ' + PURCHASES_TABLE + ' WHERE purchase_id=?',
    selectPurchaseByQuote: 'SELECT * FROM ' + PURCHASES_TABLE + ' WHERE quote_id=?',
    selectPurchaseByReservation: 'SELECT * FROM ' + PURCHASES_TABLE + ' WHERE reservation_id=?',
    selectPurchaseByLedgerTransaction: 'SELECT * FROM ' + PURCHASES_TABLE + ' WHERE ledger_transaction_id=?',
    /* 与其它 select*Filtered 同款：三个过滤条件全部在 SQL 里，LIMIT 在
       过滤**之后**生效。刻意**没有**"给谁看"的个性化参数（§80）：
       没有 recommendation、没有 analytics、没有全文检索。 */
    selectPurchasesFiltered:
      'SELECT * FROM ' + PURCHASES_TABLE + ' WHERE' +
      ' (? IS NULL OR buyer_id = ?)' +
      ' AND (? IS NULL OR recipient_id = ?)' +
      ' AND (? IS NULL OR status = ?)' +
      ' AND (? IS NULL OR product_id = ?)' +
      ' AND (? IS NULL OR quote_id = ?)' +
      ' ORDER BY created_at ASC, purchase_id ASC LIMIT ?',
    selectPurchasesAll: 'SELECT * FROM ' + PURCHASES_TABLE + ' ORDER BY created_at ASC, purchase_id ASC',
    /* P22-7：今日自主花费的求和源。判据逐字是三条（见
       autonomousSpentTodayMinor 的说明）：自主放行 + 仍然活着 + 落在本 UTC 日。
       ★ `approval_mode = 'AUTO_ALLOW'` 让被用户批准的购买**不**消耗
       自主额度 —— 额度约束的是"Agent 能自己决定多少"，不是"一共能花多少"。
       ★ 刻意**不**用 `status='COMPLETED'`：RESERVED 的购买已经占住了额度，
       而"先花再算"会让两次并发的自主购买各自看到一个旧数字。 */
    selectAutonomousSpendRows:
      'SELECT amount_minor FROM ' + PURCHASES_TABLE +
      " WHERE buyer_id = ? AND autonomy_policy_id = ? AND approval_mode = 'AUTO_ALLOW'" +
      " AND status IN ('RESERVED','COMPLETED') AND created_at >= ?",
    countPurchases: 'SELECT COUNT(*) AS c FROM ' + PURCHASES_TABLE,
    countPurchasesByStatus: 'SELECT COUNT(*) AS c FROM ' + PURCHASES_TABLE + ' WHERE status=?',
    countPurchasesByQuote: 'SELECT COUNT(*) AS c FROM ' + PURCHASES_TABLE + ' WHERE quote_id=?',
    /* ── 一次购买的**两个**状态推进语句（各自带乐观并发闸门）────────────
       `AND status=?` 让"终态不可回退"成为一条**并发安全**的 SQL 约束：
       两个进程同时结算同一次购买时，必然有一个 changes=0。

       SET 里刻意**没有**：purchase_id / buyer_* / recipient_* / product_id /
       store_id / quote_id / reservation_id / currency / amount_minor /
       quote_kind / settlement_type / asset_kind / granted_quantity /
       unit_name / created_at / idempotency_key / fingerprint。
       一次购买的经济内容写下之后**不可变**，能变的只有它的结局。

       ── 为什么 ledger_transaction_id 出现在结算语句里（这一条是算过的）──
       ★ 它在 RESERVED 期间必须是 **NULL**。"这次购买已经有交易了"是一个
       已发生的事实，而预留阶段钱一分都没动；把它预先写上会让
       `ledger_transaction_id IS NOT NULL` 不再等于"已结算"，而那条等价
       正是 getPurchase().settlement 判定的依据。
       完整性不靠"谁来写这一列"保证，而靠三层结构：
         · 它的值在 JS 里**确定性派生**自 purchaseId
           （C.derivePurchaseLedgerTransactionId），不是调用方给的；
         · 它一旦非 NULL 就落进 createPurchasesByLedgerTransaction 的
           **UNIQUE** 索引里（一笔交易不可能被两笔购买指向）；
         · integrity check 逐行验证被指向的 transaction 行**真的存在**。
       于是这一列有且只有一个写入者（结算语句），而那个写入者写下的值
       是可被独立验证的。 */
    setPurchaseSettled:
      'UPDATE ' + PURCHASES_TABLE + ' SET status=?, ledger_transaction_id=?, inventory_entry_id=?, revision=?, updated_at=?, completed_at=? WHERE purchase_id=? AND status=?',
    setPurchaseTerminal:
      'UPDATE ' + PURCHASES_TABLE + ' SET status=?, release_reason=?, reason_code=?, revision=?, updated_at=? WHERE purchase_id=? AND status=?',

    /* ══ P22-7 §23 · 自主策略与批准记录 ══════════════════════════════════
       ── economy_autonomy_policies ──────────────────────────────────────
       与 createBudgetPolicies 逐条对齐（同一套列命名与同一条"约束不是
       注释"纪律），而两处**刻意不同**：

       ① `enabled` 是 INTEGER 而不是 TEXT 词表。理由与预算政策的 status
          不同：预算政策的第三个状态（"暂停"与"从未启用"）是真实存在的，
          而自主购买只有"允许 / 不允许"两种事实 —— 缺省（没有行）本身
          就是第三种，因此不需要在 status 里表达它。
       ② allowed_product_kinds / allowed_settlement_types 用 JSON 数组，
          而不是三张关联表。理由是它们**不是实体**：它们是词表的子集，
          成员全部来自 P22-5 的 PRODUCT_KINDS / FULFILLMENTS（载入期就已
          封闭），因此"这条策略允许哪些种类"是一个值而不是一张关系。
          任何不在封闭词表里的成员在写入前就被拒绝（见 autonomyProblemsOf：
          读侧还会**再查一遍**，因为这一列可以被外部工具改坏）。 */
    createAutonomyPolicies:
      'CREATE TABLE IF NOT EXISTS ' + AUTONOMY_POLICIES_TABLE + ' (' +
      ' policy_id TEXT PRIMARY KEY,' +
      ' owner_id TEXT NOT NULL,' +
      ' owner_type TEXT NOT NULL,' +
      ' enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),' +
      ' per_purchase_limit_minor INTEGER NOT NULL CHECK (per_purchase_limit_minor >= 0),' +
      ' daily_autonomous_limit_minor INTEGER NOT NULL CHECK (daily_autonomous_limit_minor >= 0),' +
      ' approval_above_minor INTEGER NOT NULL CHECK (approval_above_minor >= 0),' +
      ' allowed_product_kinds TEXT NOT NULL,' +
      ' allowed_settlement_types TEXT NOT NULL,' +
      ' allow_gift INTEGER NOT NULL CHECK (allow_gift IN (0,1)),' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' CHECK (per_purchase_limit_minor <= daily_autonomous_limit_minor),' +
      ' CHECK (approval_above_minor <= per_purchase_limit_minor),' +
      ' CHECK (owner_type <> \'system\')' +
      ')',
    /* 一个 owner 恰好一条自主策略。它不是"多条里挑一条"的规则集合 ——
       §3 要求的是**唯一一层**权限判定，多条策略会让"这台 Agent 到底能
       不能自主买"出现两个答案。改它就是改那一行（并写一条 UPDATED 事件）。 */
    createAutonomyPoliciesByOwner:
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_autonomy_owner ON ' + AUTONOMY_POLICIES_TABLE + ' (owner_id)',
    insertAutonomyPolicy:
      'INSERT INTO ' + AUTONOMY_POLICIES_TABLE + ' (policy_id, owner_id, owner_type, enabled, per_purchase_limit_minor, daily_autonomous_limit_minor, approval_above_minor, allowed_product_kinds, allowed_settlement_types, allow_gift, idempotency_key, fingerprint, revision, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    updateAutonomyPolicy:
      'UPDATE ' + AUTONOMY_POLICIES_TABLE + ' SET enabled=?, per_purchase_limit_minor=?, daily_autonomous_limit_minor=?, approval_above_minor=?, allowed_product_kinds=?, allowed_settlement_types=?, allow_gift=?, idempotency_key=?, fingerprint=?, revision=?, updated_at=? WHERE policy_id=?',
    selectAutonomyPolicy: 'SELECT * FROM ' + AUTONOMY_POLICIES_TABLE + ' WHERE policy_id=?',
    selectAutonomyPolicyByOwner: 'SELECT * FROM ' + AUTONOMY_POLICIES_TABLE + ' WHERE owner_id=?',
    selectAutonomyPoliciesFiltered:
      'SELECT * FROM ' + AUTONOMY_POLICIES_TABLE + ' WHERE' +
      ' (? IS NULL OR owner_id = ?)' +
      ' ORDER BY created_at ASC, policy_id ASC LIMIT ?',
    selectAutonomyPoliciesAll: 'SELECT * FROM ' + AUTONOMY_POLICIES_TABLE + ' ORDER BY created_at ASC, policy_id ASC',
    countAutonomyPolicies: 'SELECT COUNT(*) AS c FROM ' + AUTONOMY_POLICIES_TABLE,

    /* ── economy_approvals ──────────────────────────────────────────────
       状态机的 CHECK 是**数据库本身**把的词表（与 purchases.status 同款）：
       五态之外的值写不进去，于是"一个批准处在什么状态"不需要靠代码自律。

       九个绑定事实的列名与契约的 APPROVAL_BINDING_KEYS 一一对应，而
       `binding_fingerprint` 是它们的 canonical 身份（纯函数算出，不含
       approvalId）—— 两处并存是刻意的：逐列比较给出**可读的**拒绝理由
       （"金额从 400 变成 450"），指纹给出**一个**可被独立重算的身份。

       决定者（decided_by_id / decided_by_type）是必填的（APPROVED /
       REJECTED 时）：一条"被批准了但不知道谁批的"记录在审计里等于没有。
       它与 buyer 必须**不同**（store 层结构性拒绝 self-approval）。

       consumed_by_purchase_id 是 §8/§16 的链接：批准 ↔ 购买。它只有在
       status=CONSUMED 时才允许非 NULL，而那条由 setApprovalConsumed 的
       谓词 + integrity check 两侧保证。 */
    createApprovals:
      'CREATE TABLE IF NOT EXISTS ' + APPROVALS_TABLE + ' (' +
      ' approval_id TEXT PRIMARY KEY,' +
      ' buyer_id TEXT NOT NULL,' +
      ' buyer_type TEXT NOT NULL,' +
      ' recipient_id TEXT,' +
      ' recipient_type TEXT,' +
      ' product_id TEXT NOT NULL,' +
      ' quote_id TEXT NOT NULL,' +
      ' quote_kind TEXT NOT NULL CHECK (quote_kind IN (\'PURCHASE\',\'GIFT\',\'COMPUTE_GRANT\')),' +
      ' currency TEXT NOT NULL,' +
      ' amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),' +
      ' settlement_type TEXT NOT NULL CHECK (settlement_type IN (\'INVENTORY_GRANT\',\'COMPUTE_GRANT\',\'SERVICE_EXECUTION\')),' +
      ' grant_quantity INTEGER NOT NULL CHECK (grant_quantity >= 0),' +
      ' units INTEGER NOT NULL CHECK (units >= 1),' +
      ' binding_fingerprint TEXT NOT NULL,' +
      ' approval_mode TEXT NOT NULL CHECK (approval_mode IN (\'AUTO_ALLOW\',\'APPROVAL\')),' +
      ' autonomy_policy_id TEXT,' +
      ' autonomy_outcome TEXT,' +
      ' autonomy_reason_code TEXT,' +
      ' status TEXT NOT NULL CHECK (status IN (\'PENDING\',\'APPROVED\',\'REJECTED\',\'EXPIRED\',\'CONSUMED\')),' +
      ' decided_by_id TEXT,' +
      ' decided_by_type TEXT,' +
      ' consume_reason TEXT,' +
      ' consumed_by_purchase_id TEXT,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' expires_at INTEGER NOT NULL,' +
      ' decided_at INTEGER,' +
      ' consumed_at INTEGER,' +
      ' CHECK (decided_by_type IS NULL OR decided_by_type <> \'system\'),' +
      ' CHECK (status <> \'CONSUMED\' OR consumed_by_purchase_id IS NOT NULL),' +
      ' CHECK (status <> \'CONSUMED\' OR consumed_at IS NOT NULL),' +
      ' CHECK (status = \'PENDING\' OR decided_at IS NOT NULL OR status = \'EXPIRED\')' +
      ')',
    /* ── §6 的结构性一半 ────────────────────────────────────────────────
       ★ 这条 UNIQUE 是"一个 Approval 最多被一笔 Purchase 消费"在数据库
       里的那一半（另一半是 setApprovalConsumed 的 `AND status='APPROVED'`
       谓词，以及 prepare/settle 各自事务里的 re-read）。NULL 不参与唯一性，
       因此 PENDING / APPROVED 的行可以有很多条。 */
    createApprovalsByConsumedPurchase:
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_approvals_consumed_by ON ' + APPROVALS_TABLE + ' (consumed_by_purchase_id)',
    createApprovalsByBuyer: 'CREATE INDEX IF NOT EXISTS idx_econ_approvals_buyer ON ' + APPROVALS_TABLE + ' (buyer_id, status, created_at)',
    createApprovalsByQuote: 'CREATE INDEX IF NOT EXISTS idx_econ_approvals_quote ON ' + APPROVALS_TABLE + ' (quote_id, status)',
    createApprovalsByStatus: 'CREATE INDEX IF NOT EXISTS idx_econ_approvals_status ON ' + APPROVALS_TABLE + ' (status, expires_at)',
    insertApproval:
      'INSERT INTO ' + APPROVALS_TABLE + ' (approval_id, buyer_id, buyer_type, recipient_id, recipient_type, product_id, quote_id, quote_kind, currency, amount_minor, settlement_type, grant_quantity, units, binding_fingerprint, approval_mode, autonomy_policy_id, autonomy_outcome, autonomy_reason_code, status, decided_by_id, decided_by_type, consume_reason, consumed_by_purchase_id, idempotency_key, fingerprint, revision, created_at, updated_at, expires_at, decided_at, consumed_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectApproval: 'SELECT * FROM ' + APPROVALS_TABLE + ' WHERE approval_id=?',
    selectApprovalsByQuote: 'SELECT * FROM ' + APPROVALS_TABLE + ' WHERE quote_id=? ORDER BY created_at ASC, approval_id ASC',
    selectApprovalByConsumedPurchase: 'SELECT * FROM ' + APPROVALS_TABLE + ' WHERE consumed_by_purchase_id=? LIMIT 1',
    selectApprovalsFiltered:
      'SELECT * FROM ' + APPROVALS_TABLE + ' WHERE' +
      ' (? IS NULL OR buyer_id = ?)' +
      ' AND (? IS NULL OR quote_id = ?)' +
      ' AND (? IS NULL OR status = ?)' +
      ' ORDER BY created_at ASC, approval_id ASC LIMIT ?',
    selectApprovalsAll: 'SELECT * FROM ' + APPROVALS_TABLE + ' ORDER BY created_at ASC, approval_id ASC',
    selectExpiredApprovals: 'SELECT * FROM ' + APPROVALS_TABLE + " WHERE status IN ('PENDING','APPROVED') AND expires_at <= ? ORDER BY expires_at ASC, approval_id ASC LIMIT ?",
    countApprovals: 'SELECT COUNT(*) AS c FROM ' + APPROVALS_TABLE,
    countApprovalsByStatus: 'SELECT COUNT(*) AS c FROM ' + APPROVALS_TABLE + ' WHERE status=?',
    /* 三条状态推进语句，各自带一个**乐观并发闸门**（`AND status=?`）。
       与 purchases 的两条同款：两个进程同时决定同一条批准时，必然有一个
       changes=0 —— 于是"只能一个成功"不是靠时间窗口，而是靠 SQL。
       SET 里刻意没有 buyer / product / quote / currency / amount /
       settlement_type / grant_quantity / units / binding_fingerprint：
       一条批准的**授权内容**写下之后不可变，能变的只有它的结局。 */
    setApprovalDecided:
      'UPDATE ' + APPROVALS_TABLE + ' SET status=?, decided_by_id=?, decided_by_type=?, revision=?, updated_at=?, decided_at=? WHERE approval_id=? AND status=?',
    setApprovalExpired:
      'UPDATE ' + APPROVALS_TABLE + ' SET status=?, revision=?, updated_at=? WHERE approval_id=? AND status=?',
    /* ★ 这条语句是 §8「一次性消费」的结构核心：WHERE 里硬编码的
       `status='APPROVED'` 让**第二次**消费返回 changes=0（那条批准已经
       是 CONSUMED 了），而 consumed_by_purchase_id 的 UNIQUE 索引兜住
       同一笔购买只出现一次。
       ★ 为什么 status 是**参数**而不是像同族语句那样写成 `'CONSUMED'`
       字面量：P22-2 的 O9j 用 `/SET ([^']*?) WHERE/` 逐列读 SET 子句，
       而那个模式要求 SET 与 WHERE 之间没有单引号。把状态写成参数之后，
       "SET 了哪些列"可以被机器断言，而"只能从 APPROVED 走到这里"仍然由
       WHERE 逐字保证。绑定的是 C.APPROVAL_STATE.CONSUMED。 */
    setApprovalConsumed:
      'UPDATE ' + APPROVALS_TABLE + ' SET status=?, consumed_by_purchase_id=?, consume_reason=?, revision=?, updated_at=?, consumed_at=? WHERE approval_id=? AND status=?',

    /* ══════════════════════════════════════════════════════════════════
       P22-8 §3–§14 · economy_purchase_intents（一次**打算**买什么）
       ══════════════════════════════════════════════════════════════════
       ★ 这张表里**没有**任何经济值列：没有 amount_minor、没有 currency、
       没有 price、没有 grant_quantity、没有 settlement_type、没有
       reservation_id、没有 transaction_id。这不是"我们记得不去读"，
       而是"没有地方可以读" —— §4 的那句话因此是**结构性**的。
       唯一的数量列是 units，而它是一个**选择**（"两杯咖啡"）而不是一个
       事实，且 P22-6 的 preparePurchase 也要求调用方说出 units。 */
    createPurchaseIntents:
      'CREATE TABLE IF NOT EXISTS ' + PURCHASE_INTENTS_TABLE + ' (' +
      ' agent_intent_id TEXT PRIMARY KEY,' +
      ' agent_id TEXT NOT NULL,' +
      ' agent_type TEXT NOT NULL,' +
      ' product_id TEXT NOT NULL,' +
      ' recipient_id TEXT,' +
      ' recipient_type TEXT,' +
      ' self_directed INTEGER NOT NULL CHECK (self_directed IN (0,1)),' +
      ' units INTEGER NOT NULL CHECK (units >= 1),' +
      ' store_id TEXT,' +
      ' quote_id TEXT,' +
      ' approval_id TEXT,' +
      ' purchase_id TEXT,' +
      ' state TEXT NOT NULL CHECK (state IN (\'PROPOSED\',\'WAITING_APPROVAL\',\'EXECUTING\',\'COMPLETED\',\'DENIED\',\'EXPIRED\',\'FAILED\')),' +
      ' authority_outcome TEXT CHECK (authority_outcome IS NULL OR authority_outcome IN (\'AUTO_ALLOW\',\'REQUIRE_APPROVAL\',\'DENY\')),' +
      ' authority_reason_code TEXT,' +
      ' reason_code TEXT,' +
      ' reason TEXT,' +
      ' intent_fingerprint TEXT NOT NULL,' +
      ' idempotency_key TEXT NOT NULL,' +
      ' fingerprint TEXT NOT NULL,' +
      ' revision INTEGER NOT NULL,' +
      ' created_at INTEGER NOT NULL,' +
      ' updated_at INTEGER NOT NULL,' +
      ' expires_at INTEGER NOT NULL,' +
      ' completed_at INTEGER,' +
      /* ── 三条结构约束，逐条对应一条纪律 ─────────────────────────────
       ① A 与 B 与 C 是**三件**事，因此三个各自为空/非空的判据都必须
          与状态一致：
            · self_directed 必须与 recipient_id 是否为空一致 —— 否则
              "这份礼物送给了谁"会因为读哪一个字段而有两个答案；
            · COMPLETED 必须有 purchase_id 与 completed_at —— 一条声称
              完成的 intent 指不出它买成了哪一笔，那是"假完成"；
            · quote_id 在四个"代码后面还会用这份报价"的状态上必须存在。
              PROPOSED 刻意**不**在这里：它是"刚被收下、报价可能还没
              生成完"的状态，而崩溃模拟恰恰要在那个缝上发生（§16）。
              把 PROPOSED 也要求 quote_id 会让"Intent created"与
              "Quote created"之间的那次崩溃变成**不可表示**的状态，
              于是恢复路径就只能靠猜。 */
      ' CHECK ((recipient_id IS NULL) = (self_directed = 1)),' +
      ' CHECK (state <> \'COMPLETED\' OR (purchase_id IS NOT NULL AND completed_at IS NOT NULL)),' +
      ' CHECK (state NOT IN (\'WAITING_APPROVAL\',\'EXECUTING\',\'COMPLETED\') OR quote_id IS NOT NULL),' +
      /* ② WAITING_APPROVAL 必须指得出那条待批准的记录 —— 否则"在等谁
          点头"没有答案。
          ★ 反过来**不**成立，而它一度写成"当且仅当"：开发期实测证明那是
          错的 —— 用户点头之后那条 intent 走到 EXECUTING / COMPLETED，而
          它**仍然**指着那张批准（那正是 §17 第五问"最后是谁批准的"要读的
          东西）。迁移时清空 approval_id 会让审计失去这个答案，留着它又
          违反"当且仅当"。正确的规则是**不对称**的：等待态**必须**有批准；
          其它状态**可以**有（它们只是不再需要它）。
          ★ 这里同样刻意**没有**"PROPOSED 时两个引用必须同时为空"的约束：
          PROPOSED 加上一个已挂好的 quote_id、而 approval_id 仍为空，是一个
          真实存在的状态（"报价已建、权威还没判"），而那正是 §16 要求可被
          崩溃打断的第二个边界。一条把真实状态判成非法的约束比没有约束更
          糟：它会在**写锁里**抛一次 SQLite 错误，而那个错误既不是业务拒绝，
          也无法被恢复路径理解。 */
      ' CHECK (state <> \'WAITING_APPROVAL\' OR approval_id IS NOT NULL)' +
      ')',
    /* ★ §10/§11 的重复抑制闸门。索引建在 intent_fingerprint 与 created_at
       上，于是"同一个 Agent 在窗口内对同一个商品 + 同一个 recipient 说过
       没有"是一次索引查找，而不是全表扫描。
       ★ 刻意**不是** UNIQUE：一条 COMPLETED 的 intent 之后允许出现一条新
       的同指纹 intent（用户明天还想买同一件东西），而 UNIQUE 会让"重复
       抑制"退化成"永久禁止"。窗口是时间语义，因此由 WHERE 表达。 */
    createPurchaseIntentsByFingerprint:
      'CREATE INDEX IF NOT EXISTS idx_econ_intents_fingerprint ON ' + PURCHASE_INTENTS_TABLE + ' (intent_fingerprint, created_at)',
    createPurchaseIntentsByAgent:
      'CREATE INDEX IF NOT EXISTS idx_econ_intents_agent ON ' + PURCHASE_INTENTS_TABLE + ' (agent_id, state, created_at)',
    createPurchaseIntentsByState:
      'CREATE INDEX IF NOT EXISTS idx_econ_intents_state ON ' + PURCHASE_INTENTS_TABLE + ' (state, expires_at)',
    createPurchaseIntentsByQuote:
      'CREATE INDEX IF NOT EXISTS idx_econ_intents_quote ON ' + PURCHASE_INTENTS_TABLE + ' (quote_id)',
    createPurchaseIntentsByApproval:
      'CREATE INDEX IF NOT EXISTS idx_econ_intents_approval ON ' + PURCHASE_INTENTS_TABLE + ' (approval_id)',
    /* ★ 这一条是"一条 intent 最多变成一笔 purchase"的结构性一半
       （另一半是 store 里的乐观闸门 —— 与 approvals 的
       idx_econ_approvals_consumed_by 逐字同款）。NULL 不参与唯一性，
       因此所有还没买成的 intent 可以有很多条。 */
    createPurchaseIntentsByPurchase:
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_econ_intents_purchase ON ' + PURCHASE_INTENTS_TABLE + ' (purchase_id)',
    insertPurchaseIntent:
      'INSERT INTO ' + PURCHASE_INTENTS_TABLE + ' (agent_intent_id, agent_id, agent_type, product_id, recipient_id, recipient_type, self_directed, units, store_id, quote_id, approval_id, purchase_id, state, authority_outcome, authority_reason_code, reason_code, reason, intent_fingerprint, idempotency_key, fingerprint, revision, created_at, updated_at, expires_at, completed_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    selectPurchaseIntent: 'SELECT * FROM ' + PURCHASE_INTENTS_TABLE + ' WHERE agent_intent_id=?',
    /* ── P22-13 修复一个**真实缺陷**（开发期实测）──────────────────────
       这条 SQL 曾经**不存在**：`resumeAgentPurchaseIntent` 的
       `else if (o.approvalId != null)` 那一支直接写了
       `db.prepare(SQL.selectPurchaseIntentByApproval)`，而那个常量从来没被
       定义过。于是这条分支的执行结果是
       `TypeError: The "sql" argument must be a string`
       —— 一条**裸的驱动异常**，而不是一次可解释的拒绝。

       ★ 它为什么一直没被发现：在 P22-13 之前，生产与测试里**每一次**
       resume 都带着 agentIntentId（P22-8 的调用方手里就有那个 id），
       于是 `if` 那一支永远先命中，`else if` 是一次**从未被执行过**的代码。
       P22-13 的 seam 刻意**不**传 agentIntentId（让"这条批准对应哪条
       intent"由 store 回答，而不是由调用方声明），于是第一次真的走到了它。

       ★ 修的是这条缺失的语句，而不是"让 seam 改传 agentIntentId"：
       按批准 id 定位是 P22-8 自己声明的能力（它的入参白名单里有
       approvalId），一条声明与它背后的实现必须同时为真。 */
    selectPurchaseIntentByApproval:
      'SELECT * FROM ' + PURCHASE_INTENTS_TABLE + ' WHERE approval_id=? ORDER BY created_at DESC, agent_intent_id DESC LIMIT 1',
    selectPurchaseIntentsAll: 'SELECT * FROM ' + PURCHASE_INTENTS_TABLE + ' ORDER BY created_at ASC, agent_intent_id ASC',
    selectPurchaseIntentsFiltered:
      'SELECT * FROM ' + PURCHASE_INTENTS_TABLE + ' WHERE' +
      ' (? IS NULL OR agent_id = ?)' +
      ' AND (? IS NULL OR product_id = ?)' +
      ' AND (? IS NULL OR state = ?)' +
      ' ORDER BY created_at ASC, agent_intent_id ASC LIMIT ?',
    selectPurchaseIntentIdempotency:
      'SELECT * FROM ' + PURCHASE_INTENTS_TABLE + ' WHERE idempotency_key=? AND fingerprint=?',
    selectPurchaseIntentByIdempotencyKey:
      'SELECT * FROM ' + PURCHASE_INTENTS_TABLE + ' WHERE idempotency_key=? LIMIT 1',
    /* §10 的重复窗口查询：**同指纹、在窗口内、且是"还活着或刚买成"的那些**。
       ★ 为什么把 COMPLETED 也算进"要抑制的"：模型复读二十次时，第一次
       可能**已经买成了** —— 那时正确的行为恰恰是"不要再买"，而不是
       "既然上一个完成了，那再来一个"。反过来 DENIED / EXPIRED / FAILED
       不抑制：那三条是"上一次没成"，而"没成"必须允许再试（否则一次
       暂时缺货就永久禁止了这件商品）。 */
    selectSuppressingIntents:
      'SELECT * FROM ' + PURCHASE_INTENTS_TABLE +
      ' WHERE intent_fingerprint=? AND created_at > ?' +
      ' AND state IN (\'PROPOSED\',\'WAITING_APPROVAL\',\'EXECUTING\',\'COMPLETED\')' +
      ' ORDER BY created_at ASC, agent_intent_id ASC',
    /* 三条状态推进语句，各自带一个**乐观并发闸门**（`AND state=?`）。
       与 purchases / approvals 的同款纪律：两个进程同时推进同一条
       intent 时，必然有一个 changes=0 —— 于是"只能一个成功"不是靠时间
       窗口，而是靠 SQL。
       ★ SET 里刻意没有 product / recipient / units / quote /
       intent_fingerprint：一条 intent 的**内容**写下之后不可变，能变的
       只有它的结局与它引用的那些 id。 */
    setPurchaseIntentState:
      'UPDATE ' + PURCHASE_INTENTS_TABLE + ' SET state=?, quote_id=?, approval_id=?, purchase_id=?, authority_outcome=?, authority_reason_code=?, reason_code=?, completed_at=?, revision=?, updated_at=? WHERE agent_intent_id=? AND state=?',
    /* ★ 挂报价与挂购买各自有一条语句，而且它们**不是**状态迁移。
          理由：一条 intent 的报价是**同一次打算的一部分**，把它写下来不改变
          "这次打算走到哪一步"。把它们压进 setPurchaseIntentState 会要求状态
          机里存在 PROPOSED → PROPOSED 这样的自环，而自环会让"静默重入同一
          状态"变成合法 —— §8 那张表刻意一个自环都没有（每一个状态迁移都
          意味着**真的动了**）。
          两张语句各自带 `AND state=?` 前置条件，于是"挂报价时这条 intent
          已经不在 PROPOSED 了"（另一个进程推进过它）会返回 changes=0。 */
    attachPurchaseIntentQuote:
      'UPDATE ' + PURCHASE_INTENTS_TABLE + ' SET quote_id=?, revision=?, updated_at=? WHERE agent_intent_id=? AND state=? AND quote_id IS NULL',
    attachPurchaseIntentPurchase:
      'UPDATE ' + PURCHASE_INTENTS_TABLE + ' SET purchase_id=?, revision=?, updated_at=? WHERE agent_intent_id=? AND state=? AND purchase_id IS NULL',
    /* ── 为什么是**一条**万能推进语句而不是七条（每个迁移一条）：七条会让
       "SET 了哪些列"随迁移不同而不同，于是"某次迁移顺手改了 quote_id"
       就再也无法被断言。一条语句 + 每次都显式传全所有列，意味着"这次
       迁移允许改哪些列"是一个**常量**，而每个调用点只决定**值**。
       代价是调用方必须把不变的列原样传回来 —— 那是可见的，因此比隐含的
       更安全。 */
    countPurchaseIntents: 'SELECT COUNT(*) AS c FROM ' + PURCHASE_INTENTS_TABLE,
    countPurchaseIntentsByState: 'SELECT COUNT(*) AS c FROM ' + PURCHASE_INTENTS_TABLE + ' WHERE state=?'
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
      db.exec(SQL.createPurchases);
      db.exec(SQL.createPurchasesByBuyer);
      db.exec(SQL.createPurchasesByRecipient);
      db.exec(SQL.createPurchasesByStatus);
      db.exec(SQL.createPurchasesByQuote);
      db.exec(SQL.createPurchasesByProduct);
      db.exec(SQL.createPurchasesByReservationLive);
      db.exec(SQL.createPurchasesByLedgerTransaction);
      db.exec(SQL.createPurchasesByApproval);
      db.exec(SQL.createPurchasesByApproval);
      /* P22-7 的两张表（schema 5 → 6）+ purchases 上的四个授权列。新表走
         CREATE TABLE IF NOT EXISTS，而四个**列**走 5 → 6 的 MIGRATIONS
         —— 那是本文件里第一条非空的迁移，因为"这笔购买当初凭什么成立"
         是既有行上的一个新事实，不是一张新表能承载的（见文件头的说明）。
         这两句同样排在 migrateSchema() 之后。 */
      db.exec(SQL.createAutonomyPolicies);
      db.exec(SQL.createAutonomyPoliciesByOwner);
      db.exec(SQL.createApprovals);
      db.exec(SQL.createApprovalsByConsumedPurchase);
      db.exec(SQL.createApprovalsByBuyer);
      db.exec(SQL.createApprovalsByQuote);
      db.exec(SQL.createApprovalsByStatus);
      /* P22-8 的一张表（schema 6 → 7）。6 → 7 的 MIGRATIONS 是**空**的：
         新实体只需要补表，没有任何既有列需要改写（见文件头的说明）。
         与前面四代一样，这几句排在 migrateSchema() **之后** ——
         SCHEMA_TOO_NEW 的库上不许悄悄多出空表。 */
      db.exec(SQL.createPurchaseIntents);
      db.exec(SQL.createPurchaseIntentsByFingerprint);
      db.exec(SQL.createPurchaseIntentsByAgent);
      db.exec(SQL.createPurchaseIntentsByState);
      db.exec(SQL.createPurchaseIntentsByQuote);
      db.exec(SQL.createPurchaseIntentsByApproval);
      db.exec(SQL.createPurchaseIntentsByPurchase);
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
       时候"那几列冻结齐了，再加一列只会制造第二个价格来源。
       4 → 5（P22-6）只**多**了一张表（economy_purchases），同样没有
       任何既有列或既有数据需要改写 —— 尤其是 quotes 与 reservations：
       P22-6 给它们加了**零**列，因为 P22-3/P22-4 已经把"锁了多少 /
       锁到什么时候 / 这份报价是什么"冻结齐了，而"这笔预留属于哪次购买"
       的事实属于 **purchase 那一侧**（purchase_id 是 purchase 自己的列），
       往 reservation 上加一列只会制造第二个归属来源。

     ★ 5 → 6（P22-7）是本文件里**第一条非空**的迁移，而它只做一件事：
     给 economy_purchases 补四个可空列。为什么它不能是空的：
       · 新表（autonomy policies / approvals）由 CREATE TABLE IF NOT EXISTS
         补上，那部分确实不需要迁移；
       · 但"这笔购买当初凭什么成立"是**既有购买行**上的一个新事实。一句
         `CREATE TABLE IF NOT EXISTS` 碰不到已经存在的行，所以必须有
         ALTER TABLE。
     为什么四个列全部可空、且**不**回填：
       · P22-7 之前写下的购买**没有**授权模式。把它猜成 AUTO_ALLOW 是
         伪造"这台 Agent 当时有权自主买"，猜成 APPROVAL 是伪造"当时有人
         批准过"。两种回填都会让审计指认一个从未发生的事实。
       · NULL 是一个**准确**的答案："这条记录早于授权层"。integrity check
         因此把旧行的 NULL 认成合法，而把新行缺这一列认成问题。
     为什么 ALTER 写成幂等的：SQLite 没有 `ADD COLUMN IF NOT EXISTS`，
     因此这里先读 `PRAGMA table_info` 再决定。迁移框架自己保证 5 → 6 只跑
     一次，但一条"在半个库上也能安全重跑"的迁移更难被误用 —— 尤其是
     有人手工改过水位的情况。 */
    {
      from: 5,
      to: 6,
      apply: function (handle) {
        /* ★★ 幂等的**两个**理由，而不是一个 ─────────────────────────────
        （一）SQLite 没有 `ADD COLUMN IF NOT EXISTS`，所以先读 table_info。
        （二）而更要紧的是：**这张表在这个时刻可能还根本不存在**。
        这个迁移框架的调用点排在所有 `CREATE TABLE IF NOT EXISTS` **之前**
        （P22-3 起冻结的纪律：SCHEMA_TOO_NEW 的库上不能悄悄多出空表），
        因此一个 schema 4 的库走 4→5→6 时，5→6 这一步面对的是一个还没有
        `economy_purchases` 的数据库 —— 那时它唯一正确的动作是**什么都不做**
        （稍后 DDL 会按当前的 CREATE 语句建出带这五列的表）。

        这是一个**真实缺陷**（开发期实测：P22-5 的迁移组在一个 schema 4 的
        库上打开时读作 `no such table: economy_purchases`）。迁移如果假设
        "更早版本负责过的表已经存在"，那么**跨两级**的升级路径会失败，而
        "跨一级"的路径是绿的 —— 后者恰好是大多数测试走的那条。 */
        const tableExists = handle.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(PURCHASES_TABLE);
        if (!tableExists) return;
        const columns = new Set(
          handle.prepare('PRAGMA table_info(' + PURCHASES_TABLE + ')').all().map(function (r) { return String(r.name); })
        );
        const additions = [
          ['approval_mode', 'TEXT'],
          ['approval_id', 'TEXT'],
          ['autonomy_policy_id', 'TEXT'],
          ['approval_binding_fingerprint', 'TEXT'],
          ['units', 'INTEGER']
        ];
        for (const entry of additions) {
          if (columns.has(entry[0])) continue;
          handle.exec('ALTER TABLE ' + PURCHASES_TABLE + ' ADD COLUMN ' + entry[0] + ' ' + entry[1]);
        }
      }
    },
    /* ── 6 → 7（P22-8）：空的，而且是**刻意**空的 ──────────────────────
       这是本文件里第二条空迁移，而它与第一条（5 → 6 那条非空的）合起来
       才构成完整的判据：

         新实体      → 空迁移 + CREATE TABLE IF NOT EXISTS 补表
         既有实体上的新事实 → 非空迁移 + ALTER TABLE（且列可空、不回填）

       P22-8 的 economy_purchase_intents 是前者：它是一张全新的表，没有任何
       既有行需要改写。★ 唯一**可能**让人想在这里 ALTER 的是 purchases
       （"这笔购买来自哪条 intent"），而那恰恰是错的：那条事实属于 intent
       那一侧（intents.purchase_id），因为 intent 才是可选的那一半 ——
       一笔 P22-6 的购买完全可以没有任何 intent（它由代码直接发起），
       往 purchases 上加一列会让那些行留下一个永远为 NULL 的、看起来像
       "缺失数据"的列，而它其实是"本来就没有"。 */
    { from: 6, to: 7, apply: function () { /* 新表，无既有行需要改写 */ } },

    /* ── 7 → 8（P22-26）：`quotes.units` ────────────────────────────────
       既有实体上的新事实 ⇒ 非空迁移 + ALTER TABLE（与 5→6 的 purchases
       同款，与 6→7 的空迁移相反）。

       ★ 为什么是**有默认值**的 NOT NULL，而不是"可空 + 读的时候补 1"：
       补 1 会把"这一行没有落过份数"与"这一行就是一份"写成同一件事，而
       本阶段的全部内容正是"不要猜"。DEFAULT 1 只在 ALTER 那一刻对**既有
       行**生效，此后每一次 INSERT 都必须显式给出 units（createQuote 的
       insert 语句里有这一列），因此它不是一个运行期的兜底。
       那 1 也是对旧行唯一正确的答案：在水位 8 之前，一份报价的 quantity
       就等于它那一份的交付量。

       ★ `tableExists` 守卫是**必须**的，而不是防御性编程：一个 schema 5
       或更早的库走 5→6→7→8 时，这一步面对的是一个还没有 economy_quotes
       的数据库（5→6 的注释里记着同一类真实缺陷：迁移如果假设"更早版本
       负责过的表已经存在"，跨级升级路径会以 `no such table` 失败，而
       跨一级的那条恰好是大多数测试走的）。那时唯一正确的动作是什么都
       不做 —— 稍后 DDL 会按当前的 CREATE 语句建出带 units 的表。

       ★ 三道防线（与 P22-5 库存的"守卫 + CHECK"同一种做法）：这里是
       ① tableExists；② PRAGMA 列探测（迁移被重复调用时不能出错）；
       ③ ALTER 之后 PRAGMA 再查一次，确认列**真的**在。第三道不是修辞：
       "迁移跑过了"与"列存在"是两件事，而它们的差集只会在很久以后以
       `quote-has-no-canonical-units` 的形式出现。 */
    {
      from: 7, to: 8,
      apply: function (handle) {
        const tableExists = handle.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(QUOTES_TABLE);
        if (!tableExists) return;
        const columnsOf = function () {
          return new Set(
            handle.prepare('PRAGMA table_info(' + QUOTES_TABLE + ')').all().map(function (r) { return String(r.name); })
          );
        };
        if (!columnsOf().has('units')) {
          handle.exec('ALTER TABLE ' + QUOTES_TABLE + ' ADD COLUMN units INTEGER NOT NULL DEFAULT 1');
        }
        const after = columnsOf();
        if (!after.has('units')) {
          const err = new Error('economy store migration 7 -> 8 did not add ' + QUOTES_TABLE + '.units');
          err.code = 'SCHEMA_MIGRATION_INCOMPLETE';
          throw err;
        }
      }
    }
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
    /* P22-6：关库必须把事务深度归零。留下一个非零深度会让下一次 open
       之后的第一个 withTransaction **跳过** BEGIN —— 那等于在没有事务
       的情况下写账本，而症状会是一堆无法回滚的半完成状态。
       这条不是防御性编程：close() 后面确实可以再 open()（测试就在这么做）。 */
    txDepth = 0;
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

  /* ── 事务深度（P22-6）─────────────────────────────────────────────────
     为什么需要它：P22-6 的 `settlePurchase` / `preparePurchase` 必须在
     **一个** SQLite atomic boundary 里完成所有 canonical 事实，而它们
     要复用的 canonical primitive（reserve / commit / release / inventory）
     各自都是"开自己事务"的公开出口。SQLite 不允许嵌套 BEGIN
     （`cannot start a transaction within a transaction`），因此只有两条路：
       · 复制那些 primitive 的实现（=第二份 validator 与第二份 SQL，禁止）；
       · 让事务**可重入**（本函数）。

     ★ 重入不等于"把错误吞掉"。决定性的一点是：**内层永不 COMMIT**。
       当 depth ≥ 1 时，内层只是直接跑 fn()，提交与否完全由最外层决定。
       于是"任何一步失败 ⇒ 整体回滚"这条性质在嵌套下仍然逐字成立 ——
       内层抛出的异常会一路穿过外层 fn()，由最外层的 catch 执行 ROLLBACK。
       内层自己的 catch（那些 translateRefusal 的调用点）会把它变成
       `{ok:false}` 返回值，而调用方看到 {ok:false} 之后按既有方式 `throw
       refuse(...)`，因此回滚仍然发生。 */

  let txDepth = 0;

  function withTransaction(fn) {
    if (txDepth > 0) {
      /* 已经在事务里：只增加深度，**不** BEGIN、**不** COMMIT。

         ★★ 这里**刻意不回滚**，而这是一次被撤销的改动留下来的结论。
         P22-7 开发期我一度在这条分支上加了一个 catch + ROLLBACK（理由：
         "嵌套事务里的故障必须由这一层回滚，否则外层不会回滚"）。那是**错的**，
         而且错得很危险：`settlePurchase` 的外层事务里嵌套着
         `commitReservationInTx`（它自己也调 withTransaction），因此内层
         的 ROLLBACK 会把**外层**整个回滚掉、同时把 `txDepth` 归零 ——
         于是外层最后那句 COMMIT 变成一次"没有活动事务"的提交（抛错被
         吞掉），而调用方拿到的是一个**看起来成功**的结果。
         实测症状：注入 `after-approval-consumed` 之后结算仍然报 ok:true，
         但库里留下了半完成状态。这比原来的问题严重得多。

         正确的语义（P22-6 冻结的那一条）：**只有最外层可以 BEGIN/COMMIT/
         ROLLBACK**，内层只管理深度。一个内层抛出的错误会冒泡到最外层，
         由最外层的 catch 回滚 —— 那是唯一正确的那一层。 */
      txDepth += 1;
      try {
        return fn();
      } finally {
        txDepth -= 1;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    txDepth = 1;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
      throw error;
    } finally {
      txDepth = 0;
    }
  }

  /* 只读的观测口：测试用它证明"结算发生在恰好一条事务里"不是一句注释。
     它是**读**，不是 seam —— 没有任何生产路径会根据它分支。 */
  function transactionDepth() { return txDepth; }

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
       真正的币种在 entry 上。control account 天然可以承载多种币种。

       ★ P22-7 修复一个**真实缺陷**（开发期实测，两个真实进程同时购买）：
       这里原来是一次裸的 `INSERT`，而它在 `preparePurchase` 里被调用时
       位于**事务之外**（`purchaseCounterpartyOf` 在 withTransaction 之前
       跑）。于是两个进程第一次同时购买同一个 quote kind 时，双方各自读到
       "账户不存在"，然后各自 INSERT —— 第二个拿到
       `UNIQUE constraint failed: economy_ledger_accounts.account_id`。

       那不是一个"罕见的竞态"：它恰好发生在**第一次**并发购买上，而正常
       路径永远看不到它。症状是一个裸的 SQLite 异常，而不是一次可解释的
       拒绝（§17 逐字要求区分"系统故障"与"业务拒绝"）。

       修法刻意是 `INSERT OR IGNORE` 而不是"把它包进事务"：这一行的身份
       就是它的主键，而"它已经存在"与"我刚创建了它"对调用方是同一个结果
       —— 白名单里只有四个 system account（P22-1 §6），因此 ignore 掉的
       唯一可能就是一个并发的同类 INSERT。包进事务只会把窗口缩小，不会
       关掉它。 */
    db.prepare(SQL.insertAccountIfAbsent).run(id, C.ACCOUNT_KIND.SYSTEM, null, '', null, clock());
    const after = db.prepare(SQL.selectSystemAccount).get(id);
    return { ok: true, accountId: id, created: !existing && !!after };
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

  /* ── P22-19 · change log 的一行 → 读面形状 ──────────────────────────
     刻意是**一个**函数：`listChanges`（全局）与 `listChangesForOwner`
     （owner-scoped）必须逐字给出同一种行。两处各写一遍映射迟早会漂移，
     而"同一个 revision 在两个读面上形状不同"是最难查的一类不一致。
     `payload_json` 坏了时返回 null 而不是抛 —— 与 P22-2 起的读法一致。 */
  function rowToChange(r) {
    return {
      domain: C.DOMAIN,
      revision: Number(r.revision),
      kind: String(r.kind),
      entityId: String(r.entity_id),
      transactionId: r.transaction_id == null ? null : String(r.transaction_id),
      walletId: r.wallet_id == null ? null : String(r.wallet_id),
      at: Number(r.at),
      payload: (() => { try { return JSON.parse(r.payload_json); } catch (_) { return null; } })()
    };
  }

  function listChanges(cursor, limit) {
    requireOpen();
    const from = Number(cursor) || 0;
    const size = Math.max(1, Math.min(500, Number(limit) || 200));
    const rows = db.prepare(SQL.selectChanges).all(from, size);
    return rows.map(rowToChange);
  }

  /* ══ P22-19 · owner-scoped change 读面 ═══════════════════════════════
     这是 Economy 里**唯一**一处"一条 change 是否属于某个 owner"的实现。
     在此之前，这条规则存在于浏览器解释层（P22-18 的 changeBelongsTo），
     而它有两个结构性缺陷（都是实测出来的，见 docs §2/§3）：

     ① 逐字比较撞上两种 canonical 拼写。生产 payload 里 `buyerId` 既可能
        是裸 party id（QUOTE_CREATED / PURCHASE_CREATED / APPROVAL_REQUESTED），
        也可能是 `<partyType>:<id>`（APPROVAL_APPROVED / REJECTED /
        CONSUMED —— 它们用的是 partyKeyOf）。逐字比较于是**必然漏掉**
        这三类，而它们恰好是"用户点过头的证据"。这一条不修写入侧：那三行
        的拼写在**别的**读面上是被冻结的 canonical 形状
        （serializeApproval().buyerId === 'character:…'，
        test_p22_7_economy_approval.js:468 逐字断言），而 change log 是
        已经写下的历史 —— 无论写入侧怎么改，历史行仍然是两种拼写并存。
        因此归一化**必须**发生在读的一条实现里。
     ② APPROVAL_EXPIRED 的 payload **没有任何 owner 字段**（只有
        approvalId）。它的 owner 权威在 approvals 行上，浏览器没有那张表，
        于是它永远无法归属。

     还有第三条，属于分页语义而不是字段语义：本函数之前的读法是"从最早
     往新的一页页取"，而 change log 是**全局**的。先取一页再在 JS 里筛，
     截断时留下的是**最旧**的一段 —— 那时页面把"最旧的一段"叫作"最近
     活动"就是错的（docs §3.2 的对抗性反证）。

     ★ 本函数**只**做 filter / sort / project：它不重算余额、不重判预算、
       不重判批准有效性、不重判报价有效性、不重判购买结果、不重算库存
       数量、不重判自主裁决。返回的每一行都是 change log 那一行本身。 */
  function listChangesForOwner(options) {
    requireOpen();
    const o = options || {};
    /* owner 键与其它 owner-scoped 读面**同一个词表**：裸 party id
       （`char_a`、或用户方 `user`）。ref 形态（`character:char_a`）在这里
       被拒，而不是被悄悄接受 —— "一个 owner 只有一种写下来的样子"，
       否则每个读面都要各自猜一次。 */
    const ref = partyInput(o.ownerId);
    if (!ref || ref.ok !== true) {
      return { ok: false, changes: [], errors: (ref && ref.errors) || ['party-ref-invalid'], scope: null };
    }
    const ownerKey = String(ref.party.id);
    const order = o.order == null ? 'asc' : String(o.order).toLowerCase();
    if (order !== 'asc' && order !== 'desc') {
      return { ok: false, changes: [], errors: ['change-order-not-supported'], scope: null };
    }
    const size = Math.max(1, Math.min(500, Number(o.limit) || 200));
    /* cursor 的语义按方向各自是 keyset：
         asc  —— "取 revision 大于它的"；缺省 0 即"从最早的那条开始"；
         desc —— "取 revision 小于它的"；缺省即"从**最新**的那条开始"。
       两个方向都用同一本账上的同一个键（revision），因此顺序是稳定的，
       而方向只决定从哪一端进入。 */
    const rawCursor = Number(o.cursor) || 0;
    const cursor = order === 'desc'
      ? (rawCursor > 0 ? rawCursor : Number.MAX_SAFE_INTEGER)
      : rawCursor;

    const ownerKeys = ownerScopedChangeKeys(ownerKey, C.PARTY_TYPES);
    const sqlText = (order === 'desc' ? SQL.selectChangesByOwnerDesc : SQL.selectChangesByOwnerAsc)
      .replace('%PREDICATE%', changeOwnerPredicate(ownerKeys.length));
    const params = [cursor];
    /* 占位符的次序与 changeOwnerPredicate 里的写法逐个对应。 */
    params.push(ownerKey);          /* E1 wallet 列 */
    params.push(ownerKey);          /* E2 账本交易动到的钱包 */
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < ownerKeys.length; j += 1) params.push(ownerKeys[j]); /* E3 ×3 字段 */
    params.push(ownerKey);          /* E4 批准行 */
    params.push(size);
    const rows = db.prepare(sqlText).all(...params);
    return {
      ok: true,
      changes: rows.map(rowToChange),
      errors: [],
      scope: { ownerId: ownerKey, ownerKeys: ownerKeys.slice(), order: order, scoped: true }
    };
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

  /* ══════════════════════════════════════════════════════════════════
     P22-14 · Initial IB Credit Bootstrap（**一次性** · 唯一的初始额度入口）
     ──────────────────────────────────────────────────────────────────
     §3/§4 的问题不是"能不能铸一次币"，而是"怎么让'初始额度'不能被同一个
     入口反复调用、变成普通充值接口"。答案在这段代码的结构里，而不是在
     某一句纪律里：

      ① **账本幂等键是派生的，不是调用方给的。**
         调用方给的 idempotencyKey 只标识安全重放，不形成新的 bootstrap 权限；
         P22-2 账本幂等表的 key 是 bootstrapCreditKeyFor(owner, currency)。
         固定 key 保证账本层永远没有第二把铸币 key；永久 marker 则拒绝带新 key 的
         bootstrap（拒绝 INITIAL_CREDIT_ALREADY_BOOTSTRAPPED）。
         原 key + 相同金额安全重放；新 key 代表第二次调用而被 marker 拒绝。

      ② **一次性事实写在 canonical 的 meta 行里**（economy_meta，与
         economy_schema / economy_revision 同一张表）。它落库、进同一个事
         务、跨重启仍然在 —— 因此它**不是**一个进程内 Set，也不是"这台机器
         记得"。marker 是 one-shot 的权威事实，也用于拒绝新幂等键发起的第二次请求。
         账本幂等行会被回收（IDEMPOTENCY_TTL_MS / IDEMPOTENCY_MAX）；marker
         不受 TTL 影响，因此 one-shot 不会因幂等记录清理而失效。它让"这个
         owner 的初始额度发过了"成为永久、可读、可审计、不可绕过的规范事实。

      ③ **它只产生 IB_CREDIT，而且只经由 commitLedgerTransaction。**
         它不接受 currency 以外的任何账户事实：没有 debit/credit account
         参数、没有 transactionId 参数、没有 raw entry。currency 由契约的
         validateCurrency 收窄到封闭集合（§3：只有 IB_CREDIT），金额走
         normalizeAmountMinor（minor unit、非负、上界）。
         ★ provider quota / 真实货币：本函数没有任何一行、任何一条依赖能
         表达它们 —— 它写的是 economy_ledger_entries 上的一对借贷。

      ★ 为什么它**不是** mintForSystem 的别名：mintForSystem 是"我可以凭空
        造任意一笔钱"的通用系统原语（无限次、任意金额、任意 wallet）；
        本函数是"这个 owner 的初始额度，恰好一次"。把前者挂到配置面上正是
        §3 逐字禁止的那件事（POST /mint {ownerId, amount}）。
      ★ 它仍然经过 systemTransfer，因此 systemInitiated / systemAuthority
        两道既有闸门逐字保留 —— 初始额度不是绕开它们的第三扇门。
      ══════════════════════════════════════════════════════════════════ */

  /* 初始额度的 canonical 身份：owner 的 partyRef + 币种。
     ★ 刻意**不含** walletId：walletId 由 nextId() 生成，它带进程 PID 与
     时钟 —— 重启后同一个 owner 会得到另一个 walletId。用它当身份等于
     "重启之后我认不出你发过了"。 */
  function bootstrapCreditKeyFor(ownerId, currency) {
    return 'bootstrap-credit:' + String(ownerId) + ':' + String(currency);
  }
  function bootstrapMarkerKeyFor(ownerId, currency) {
    return 'economy_bootstrap_credit:' + String(ownerId) + ':' + String(currency);
  }

  function bootstrapInitialCredit(input) {
    requireOpen();
    const o = input || {};
    const owner = normalizeOwner(o.owner);
    if (!owner.ok) return { ok: false, denied: false, reasonCode: null, errors: owner.errors };
    if (owner.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, denied: false, reasonCode: null, errors: ['system-party-cannot-hold-an-initial-credit'] };
    }
    const cur = C.validateCurrency(o.currency);
    if (!cur.ok) return { ok: false, denied: false, reasonCode: null, errors: cur.errors };
    const amt = C.normalizeAmountMinor(o.amountMinor);
    if (!amt.ok) return { ok: false, denied: false, reasonCode: null, errors: amt.errors };

    const ownerId = String(owner.party.id) + ':' + String(owner.party.type);
    const markerKey = bootstrapMarkerKeyFor(ownerId, cur.currency);
    /* ★ 调用方给的 key 只用于识别同一请求的安全重放；它不能为第二次初始额度
       打开新身份。one-shot 的持久身份仍然是 owner + currency 的 marker。 */
    const requestedKey = o.idempotencyKey == null ? null : String(o.idempotencyKey).trim();
    const ledgerKey = bootstrapCreditKeyFor(ownerId, cur.currency);

    /* ── ① canonical 一次性闸门（永久的 meta 事实）────────────────────
       ★ 它在事务**之前**读一次、在事务**之内**再读一次：前者让重放几乎
       零成本，后者才是权威（BEGIN IMMEDIATE 之后写锁已持有，因此
       "读过没有"与"写上"之间不存在第二个 writer）。 */
    const priorRaw = readMeta(markerKey);
    if (priorRaw != null) {
      const prior = parseJsonOrNull(priorRaw) || {};
      /* ★ 一个真实的缺陷（开发期实测）：这一行的取值一度写成
         `alreadyBootstrappedAmountMinor: prior.amountMinor` —— 而 marker 行是
         一个**两层**对象（canonical 事实在外层，store 的 result 在 `result` 里），
         于是它恒为 undefined。症状是"拒绝发生了，但被拒的那笔金额是多少"
         消失了（与 denial() 修过的那个 `.detail` 恒 undefined 的形状同源）。
         取值必须逐字落在 `prior.amountMinor` 上，且返回值自己会被断言。 */
      const priorAmount = prior.amountMinor == null ? null : String(prior.amountMinor);
      /* ★ 相同幂等键 + 相同金额才是同一次 HTTP 请求的安全重放。任何新键，
         即使金额逐字相同，也是第二次 bootstrap，必须明确拒绝；否则 UI 外部
         的调用方会把“已初始化”误读成一次成功的配置动作。 */
      const sameRequest = requestedKey != null && prior.requestedIdempotencyKey != null &&
        String(prior.requestedIdempotencyKey) === requestedKey;
      if (priorAmount !== C.serializeAmountMinor(amt.amountMinor) || !sameRequest) {
        return {
          ok: false, denied: true, replayed: false,
          reasonCode: 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED',
          errors: ['initial-credit-is-one-shot-per-owner-and-currency'],
          bootstrapAlreadyConsumed: true,
          alreadyBootstrappedAmountMinor: priorAmount,
          requestedAmountMinor: C.serializeAmountMinor(amt.amountMinor),
          transactionId: prior.transactionId == null ? null : String(prior.transactionId),
          walletId: prior.walletId == null ? null : String(prior.walletId)
        };
      }
      return {
        ok: true, denied: false, replayed: true,
        reasonCode: null, errors: [],
        bootstrapAlreadyConsumed: true,
        result: prior.result || null,
        walletId: prior.walletId == null ? null : String(prior.walletId),
        transactionId: prior.transactionId == null ? null : String(prior.transactionId),
        amountMinor: C.serializeAmountMinor(amt.amountMinor),
        currency: cur.currency,
        idempotencyKey: ledgerKey
      };
    }

    const at = clock();
    let committed = null;
    try {
      withTransaction(() => {
        /* ── ② 事务内权威复查（写锁已持有）─────────────────────────── */
        const insideRaw = readMeta(markerKey);
        if (insideRaw != null) {
          const inside = parseJsonOrNull(insideRaw) || {};
          const sameRequest = requestedKey != null && inside.requestedIdempotencyKey != null &&
            String(inside.requestedIdempotencyKey) === requestedKey;
          if (String(inside.amountMinor) !== C.serializeAmountMinor(amt.amountMinor) || !sameRequest) {
            throw refuse('INITIAL_CREDIT_ALREADY_BOOTSTRAPPED',
              ['initial-credit-is-one-shot-per-owner-and-currency'],
              { bootstrapAlreadyConsumed: true });
          }
          committed = { replayedInsideTheTransaction: true, prior: inside };
          return;
        }

        /* ── ③ 钱包：同一个 (owner, currency) 恰好一个 ────────────────
           ★ openWallet 自己也是事务（嵌套时只加深度、不提交），因此"钱包
           被创建"与"初始额度被铸出"共享同一个 atomic boundary —— 中途失败
           不会留下一个"有初始额度的钱包"或"钱包有了、钱没有"的中间态。 */
        const walletResult = openWallet({ owner: owner.party, currency: cur.currency });
        if (!walletResult || walletResult.ok !== true) {
          throw refuse(null, (walletResult && walletResult.errors) || ['wallet-not-opened']);
        }
        const walletRow = db.prepare(SQL.selectWallet).get(String(walletResult.wallet.walletId));
        if (!walletRow) throw refuse(null, ['wallet-row-missing-after-open']);

        /* ── ④ 唯一一条到账本的边：systemTransfer → commitLedgerTransaction ──
           ★ 这里**没有**第二处余额写法，也**没有**任何 raw entry。 */
        const minted = systemTransfer('MINT', {
          systemInitiated: true,
          walletId: String(walletRow.wallet_id),
          currency: cur.currency,
          amountMinor: amt.amountMinor,
          idempotencyKey: ledgerKey,
          transactionId: o.transactionId == null ? nextId('TRANSACTION') : String(o.transactionId)
        });
        if (!minted || minted.ok !== true) {
          throw refuse(null, (minted && minted.errors) || ['initial-credit-mint-refused'],
            { mintResult: minted || null });
        }

        /* ── ⑤ canonical 一次性事实 + 结果（重放与 TTL 回收之后都靠它）── */
        const revision = allocateRevision();
        const result = {
          domain: C.DOMAIN,
          kind: 'initial-credit-bootstrap',
          walletId: String(walletRow.wallet_id),
          ownerId: String(owner.party.id),
          ownerType: String(owner.party.type),
          currency: cur.currency,
          amountMinor: C.serializeAmountMinor(amt.amountMinor),
          transactionId: minted.transactionId == null ? null : String(minted.transactionId),
          ledgerRevision: minted.result ? Number(minted.result.revision) : null,
          ledgerKey: ledgerKey,
          requestedIdempotencyKey: requestedKey,
          /* 逐字：这条 change 说的是"初始额度发过了"，而它**不是**一次
             购买、不是一次预留、不是一次授权。 */
          isAPurchase: false,
          isAReservation: false,
          isAnApproval: false,
          isProviderQuota: false,
          isRealCurrency: false
        };
        writeMeta(markerKey, JSON.stringify({
          ownerId: String(owner.party.id),
          ownerType: String(owner.party.type),
          currency: cur.currency,
          amountMinor: C.serializeAmountMinor(amt.amountMinor),
          walletId: String(walletRow.wallet_id),
          transactionId: result.transactionId,
          ledgerKey: ledgerKey,
          requestedIdempotencyKey: requestedKey,
          at: Number(at),
          revision: Number(revision),
          result: result
        }));
        appendChange({
          revision: Number(revision), kind: 'ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED',
          entityId: String(walletRow.wallet_id), transactionId: result.transactionId,
          walletId: String(walletRow.wallet_id), at: Number(at),
          payload: {
            domain: C.DOMAIN,
            ownerId: result.ownerId, ownerType: result.ownerType,
            currency: cur.currency,
            amountMinor: result.amountMinor,
            oneShot: true,
            ledgerMutation: true,
            providerQuotaMutation: false,
            realCurrencyMutation: false,
            purchaseMutation: false
          }
        });
        committed = { replayedInsideTheTransaction: false, prior: null, result: result, revision: Number(revision) };
      });
    } catch (error) {
      const translated = translateRefusal(error);
      if (translated) {
        if (translated.reasonCode === 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED') {
          const current = readMeta(markerKey);
          const parsed = current == null ? {} : (parseJsonOrNull(current) || {});
          return {
            ok: false, denied: true, replayed: false,
            reasonCode: 'INITIAL_CREDIT_ALREADY_BOOTSTRAPPED',
            errors: ['initial-credit-is-one-shot-per-owner-and-currency'],
            bootstrapAlreadyConsumed: true,
            alreadyBootstrappedAmountMinor: parsed.amountMinor == null ? null : String(parsed.amountMinor),
            requestedAmountMinor: C.serializeAmountMinor(amt.amountMinor),
            transactionId: parsed.transactionId == null ? null : String(parsed.transactionId),
            walletId: parsed.walletId == null ? null : String(parsed.walletId)
          };
        }
        return translated;
      }
      throw error;
    }

    /* 事务内复查撞上了既有的 meta 行：这次调用**没有**产生第二笔铸币。 */
    if (committed && committed.replayedInsideTheTransaction === true) {
      const prior = committed.prior || {};
      return {
        ok: true, denied: false, replayed: true,
        reasonCode: null, errors: [],
        bootstrapAlreadyConsumed: true,
        result: prior.result || null,
        walletId: prior.walletId == null ? null : String(prior.walletId),
        transactionId: prior.transactionId == null ? null : String(prior.transactionId),
        amountMinor: C.serializeAmountMinor(amt.amountMinor),
        currency: cur.currency,
        idempotencyKey: ledgerKey
      };
    }

    return {
      ok: true, denied: false, replayed: false,
      reasonCode: null, errors: [],
      bootstrapAlreadyConsumed: false,
      result: committed.result,
      walletId: committed.result.walletId,
      transactionId: committed.result.transactionId,
      amountMinor: committed.result.amountMinor,
      currency: cur.currency,
      idempotencyKey: ledgerKey,
      ledgerResult: null
    };
  }

  /* 只读观测口：这一行 meta 事实本身。它让"一次性"可以被**核对**，
     而不是只能被相信（/security 与配置面都用它回答 alreadyBootstrapped）。
     ★ 它返回的键恰好六个，没有任何金额以外的经济事实。 */
  function getInitialCreditBootstrap(ownerId, currency) {
    requireOpen();
    const owner = normalizeOwner(ownerId);
    if (!owner.ok) return { ok: false, bootstrapped: false, errors: owner.errors };
    const cur = C.validateCurrency(currency);
    if (!cur.ok) return { ok: false, bootstrapped: false, errors: cur.errors };
    const normalizedOwnerId = String(owner.party.id) + ':' + String(owner.party.type);
    const raw = readMeta(bootstrapMarkerKeyFor(normalizedOwnerId, cur.currency));
    if (raw == null) {
      return {
        ok: true, bootstrapped: false, ownerId: String(owner.party.id),
        ownerType: String(owner.party.type), currency: cur.currency,
        amountMinor: null, walletId: null, transactionId: null, at: null
      };
    }
    const parsed = parseJsonOrNull(raw) || {};
    return {
      ok: true, bootstrapped: true,
      ownerId: String(owner.party.id), ownerType: String(owner.party.type),
      currency: cur.currency,
      amountMinor: parsed.amountMinor == null ? null : String(parsed.amountMinor),
      walletId: parsed.walletId == null ? null : String(parsed.walletId),
      transactionId: parsed.transactionId == null ? null : String(parsed.transactionId),
      at: parsed.at == null ? null : Number(parsed.at)
    };
  }
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
    /* ── P22-7：一个**真实缺陷**的单点修复（开发期实测）─────────────────
       这里曾经是 `Object.assign({...}, extra || {})`，而 extra 是调用方给的
       对象。当调用方把一个**别的拒绝对象**（或任何带 `reasonCode: undefined`
       的对象）当作 extra 传进来时，它会**覆盖**上面刚写好的正确值：

         denial(C.DENY_REASON.APPROVAL_EXPIRED, [...], someDenialObject)
         → someDenialObject.reasonCode === undefined
         → 返回里的 reasonCode 变成字面量字符串 "undefined"

       症状是"拒绝发生了，但为什么被拒绝消失了" —— 与 P22-6 在
       budgetRefusalOf 上踩到的那一类形状同源（那次是 `.detail` 恒为
       undefined）。修在这里而不是逐个调用点，因为**任何**后续调用点都
       可能再犯同一个错，而这个函数是所有拒绝的唯一出口。

       规则逐字是：extras 只有在**显式给出有意义的值**时才允许覆盖
       ok / denied / reasonCode。一个 undefined 不是"我要把它设成空"，
       而是"我没打算说这件事"。 */
    const out = {
      ok: false,
      denied: true,
      reasonCode: String(reasonCode),
      errors: Array.isArray(errors) ? errors.map(String) : [String(errors)]
    };
    const extras = extra || {};
    for (const key of Object.keys(extras)) {
      if (extras[key] === undefined && Object.prototype.hasOwnProperty.call(out, key)) continue;
      out[key] = extras[key];
    }
    return out;
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
  function commitReservationInTx(reservationId, at, fingerprint, o, plan) {
    const p = plan || {};
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

    /* 双保险：账本金额必须等于预留金额。指纹里已经含了它，因此这一条
       只在"有人绕过指纹把 expected 传错"时才可能触发 —— 而那种情况
       必须是一个硬错误，不是一次静默扣款。 */
    const resAmount = fromSqlAmount(r.amount_minor, 'reservation-amount');
    if (p.expectedAmountMinor != null && resAmount !== p.expectedAmountMinor) {
      throw refuse(C.DENY_REASON.INVALID_AMOUNT, ['commit-amount-must-equal-the-reserved-amount'], {
        reservationAmountMinor: C.serializeAmountMinor(resAmount),
        requestedAmountMinor: C.serializeAmountMinor(p.expectedAmountMinor)
      });
    }

    /* 对手方账户必须先存在（commitLedgerTransactionInTx 不会替你创建）。 */
    const sys = ensureSystemAccount(p.counterparty);
    if (!sys.ok) throw refuse(null, sys.errors);

    /* ── 收款人（§23）──────────────────────────────────────────────────
       ★ 这里曾经写成 `recipientId: null`（"ledger 不关心这个"，那是一个
       GIFT 的字面量）。但它其实**关心**：`rowToTransaction` 把
       recipient_id 读出来，而一次 Gift 的审计要回答"这笔钱是为谁花的"。
       写入的 payer 是 Purchase 的 buyer，收益人是 Purchase 的 recipient，
       两者在**同一行**上必须同时可读。 */
    const settledRecipientFromRes = db.prepare(SQL.selectPurchaseByReservation).get(String(reservationId));
    const ledgerRecipientId = p.ledgerRecipientId != null
      ? String(p.ledgerRecipientId)
      : (settledRecipientFromRes && settledRecipientFromRes.recipient_id != null
        ? String(settledRecipientFromRes.recipient_id) : null);

    /* 一个 revision 覆盖"预留关闭"这件事；ledger 提交自己会再分配
       一个用于那笔经济事实。两个 change 行、两个 revision，都在
       同一个事务里，因此 revision 序列仍然**无洞**（每一次
       allocateRevision 恰好配一条 change 行）。 */
    const revision = allocateRevision();
    faultPoint('after-commit-validated');

    const movedRes = db.prepare(SQL.setReservationStatus).run(
      C.RESERVATION_STATE.COMMITTED, p.transactionId, null,
      Number(revision), Number(at), String(reservationId), C.RESERVATION_STATE.ACTIVE
    );
    if (Number(movedRes.changes) !== 1) {
      throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['reservation-transition-affected-no-row']);
    }
    faultPoint('after-reservation-committed');

    applyReservedCache(String(r.wallet_id), revision, at);
    faultPoint('after-commit-reserved-cache');

    const ledger = commitLedgerTransactionInTx({
      transactionId: p.transactionId,
      type: p.type,
      idempotencyKey: p.ledgerIdempotencyKey,
      actor: p.actor,
      ownerId: String(wallet.owner_id),
      recipientId: ledgerRecipientId,
      entries: p.entries
    });
    if (ledger.ok !== true) {
      /* ledger 拒绝 ⇒ 整个 commit 回滚（预留在事务外仍是 ACTIVE）。
         这里刻意**不**把它变成 FAILED：一次被拒绝的提交不是"操作
         进入了生命周期后不可继续"，而是"这次提交不成立" —— 后者
         必须让调用方还能重试或显式 failExpired/fail。 */
      const ledgerErrors = ledger.errors || [];
      throw refuse(ledgerErrors.indexOf('insufficient-balance') >= 0
        ? C.DENY_REASON.INSUFFICIENT_BALANCE : null, ledgerErrors.length ? ledgerErrors : ['ledger-commit-refused'], {
        ledgerErrors: ledgerErrors,
        overdrafts: ledger.overdrafts || []
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
      amountMinor: C.serializeAmountMinor(resAmount),
      transactionId: String(ledger.transactionId),
      transactionType: p.type,
      counterparty: p.counterparty,
      revision: Number(revision),
      at: Number(at),
      idempotencyKey: p.callIdempotencyKey,
      ledger: ledger.result,
      /* 对 settlePurchase 有用的一条观测：这次 commit 的对手方是
         **system** 账户，因此"Store 是不是商家"这个问题的答案在这里
         就已经是结构性的（storeId 根本不出现在 entries 里）。 */
      counterpartyAccountId: String(p.counterparty)
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
        amountMinor: C.serializeAmountMinor(resAmount),
        currency: String(r.currency),
        counterparty: p.counterparty,
        ledgerRevision: ledger.result.revision
      }
    });
    faultPoint('before-commit-change-log');

    if (p.writeIdempotency !== false && p.idempotencyScope != null && p.idempotencyKey != null) {
      writeOperationIdempotency(p.idempotencyScope, p.idempotencyKey, fingerprint, {
        operationId: String(op.operation_id), reservationId: String(reservationId),
        transactionId: String(ledger.transactionId)
      }, result, revision, at);
    }
    faultPoint('before-reservation-commit');
    return result;
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
     都发生了，要么一件都没发生。J 组逐个故障点证明这一点。

     ★ P22-6：函数体被提取成 commitReservationInTx（**不自行 BEGIN**）。
     本函数是它唯一的公开包装，行为逐字不变（同一条 SQL、同一组闸门、
     同一个 idempotency scope）。P22-6 的 settlePurchase 调用的是同一个
     事务体，因此"预留提交"这件事在本仓库里**只有一份实现**。 */
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
      ledger: ledgerFingerprint,
      amountMinor: C.serializeAmountMinor(fromSqlAmount(resRow.amount_minor, 'reservation-amount'))
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
        committed = commitReservationInTx(String(reservationId), at, fingerprint, o, {
          type: built.type,
          counterparty: built.counterparty,
          transactionId: transactionId,
          actor: actor.party,
          entries: normalized.entries,
          idempotencyScope: C.OPERATION_SCOPE.COMMIT,
          idempotencyKey: key.key,
          ledgerIdempotencyKey: 'econ.commit+' + String(reservationId) + '+' + key.key,
          callIdempotencyKey: key.key,
          expectedAmountMinor: fromSqlAmount(resRow.amount_minor, 'reservation-amount')
        });
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
  /* ── settleReservationInTx（P22-3 内核，提取于 P22-6）────────────────
     ★ 它**不自行 BEGIN/COMMIT**：由调用方（settleReservation 的公开包装，
     或 P22-6 的 settlePurchase / cancelPurchase）拥有事务边界。

     提取是纯机械的：同一条 SQL、同一组状态机闸门、同一条 change log、
     同一条幂等写入。被改的只有三件事：
       · `at` / `fingerprint` 由调用方传入（settlePurchase 用它的事务时钟）；
       · 幂等写入可以按调用方的 (scope, key) 写，也可以**整个跳过**
         （当外层已经有自己的幂等闸门时 —— 见 cancelPurchase）；
       · 多了一个可选的 preCommit 钩子（cancelPurchase 用它把 Purchase 的
         终局写进**同一个**事务）。

     调用方负责的那些检查（用 plan.precheck）在公开包装里**原样保留**，
     并且在事务体内再执行一次 —— 因为公开包装的检查发生在拿写锁之前。 */
  function settleReservationInTx(reservationId, o, plan, opts) {
    const p = plan || {};
    const q = opts || {};
    const at = q.at;
    const fingerprint = q.fingerprint;
    const idem = p.idempotency || null;

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
    const resGate = C.assertReservationTransition(C.RESERVATION_STATE.ACTIVE, p.reservationState);
    if (!resGate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, resGate.errors);
    const opGate = C.assertTransactionTransition(C.TX_STATE.RESERVED, p.operationState);
    if (!opGate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, opGate.errors);
    if (p.requireDue && (r.expires_at == null || Number(r.expires_at) > at)) {
      throw refuse(null, ['reservation-not-yet-due'], { expiresAt: r.expires_at == null ? null : Number(r.expires_at), now: at });
    }
    /* 调用方在事务外做过的判断，在拿到写锁之后再回答一次。 */
    if (typeof q.enforce === 'function') {
      const pre = q.enforce(r, op, at);
      if (pre && pre.ok === false) {
        throw refuse(pre.reasonCode == null ? null : pre.reasonCode,
          (pre.errors && pre.errors.length) ? pre.errors : ['reservation-settlement-refused'],
          pre.detail || {});
      }
    }

    const revision = allocateRevision();
    faultPoint(p.faultPrefix + '-validated');

    const movedRes = db.prepare(SQL.setReservationStatus).run(
      p.reservationState, null, p.releaseReason,
      Number(revision), Number(at), String(reservationId), C.RESERVATION_STATE.ACTIVE
    );
    if (Number(movedRes.changes) !== 1) {
      throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['reservation-transition-affected-no-row']);
    }
    faultPoint(p.faultPrefix + '-after-status');

    /* reserved 缓存 ← Σ(ACTIVE)（本笔已经不在里面了）。 */
    const sum = applyReservedCache(String(r.wallet_id), revision, at);
    faultPoint(p.faultPrefix + '-after-reserved-cache');

    const movedOp = db.prepare(SQL.setOperationStatus).run(
      p.operationState, String(reservationId), null, p.reasonCode == null ? null : String(p.reasonCode),
      Number(revision), Number(at), String(op.operation_id), C.TX_STATE.RESERVED
    );
    if (Number(movedOp.changes) !== 1) {
      throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-transition-affected-no-row']);
    }

    const amountMinor = fromSqlAmount(r.amount_minor, 'reservation-amount');
    const result = {
      domain: C.DOMAIN,
      operationId: String(op.operation_id),
      operationStatus: p.operationState,
      reservationId: String(reservationId),
      reservationState: p.reservationState,
      walletId: String(r.wallet_id),
      currency: String(r.currency),
      amountMinor: C.serializeAmountMinor(amountMinor),
      releaseReason: p.releaseReason,
      reasonCode: p.reasonCode == null ? null : String(p.reasonCode),
      /* 逐字写明"这件事没有产生任何 ledger 事实"。字段名与 commit 路径
         用的是同一个（transactionId），因为它们是同一个概念；这里它
         恒为 null —— 一条"还回去"的操作不可能、也不允许有一笔交易。 */
      transactionId: null,
      revision: Number(revision),
      at: Number(at),
      idempotencyKey: idem ? idem.key : null,
      reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
      activeReservations: sum.activeCount
    };

    appendChange({
      revision: Number(revision), kind: p.changeKind,
      entityId: String(reservationId), transactionId: null,
      walletId: String(r.wallet_id), at: Number(at),
      payload: {
        domain: C.DOMAIN,
        operationId: String(op.operation_id),
        reservationId: String(reservationId),
        reservationState: p.reservationState,
        operationStatus: p.operationState,
        releaseReason: p.releaseReason,
        reasonCode: p.reasonCode == null ? null : String(p.reasonCode),
        amountMinor: C.serializeAmountMinor(amountMinor),
        currency: String(r.currency),
        /* 逐字写明"这件事没有产生任何 ledger 事实"：审计里"钱还回去了"
           与"账本动了"必须一眼可分。 */
        ledgerMutation: false,
        reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
        activeReservations: sum.activeCount
      }
    });
    faultPoint(p.faultPrefix + '-before-change-log');

    /* preCommit 钩子：把"认购方"的终局写进**同一个**事务。它只在
       Purchase 路径上存在；P22-3 自己的三个出口传 null，因此它们的
       行为逐字不变。 */
    if (typeof q.preCommit === 'function') q.preCommit({ reservation: r, operation: op, revision: revision, at: at, result: result });

    if (idem && idem.write !== false) {
      writeOperationIdempotency(idem.scope, idem.key, fingerprint, {
        operationId: String(op.operation_id), reservationId: String(reservationId), transactionId: null
      }, result, revision, at);
    }
    faultPoint('before-reservation-commit');
    return result;
  }

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
        /* ★ P22-6：幂等参数随 plan 一起传进事务体，因此"事务外算出的指纹"
           与"事务内写下的幂等行"是同一个值（不是各算一遍）。 */
        committed = settleReservationInTx(reservationId, o, Object.assign({}, plan, {
          idempotency: plan.idempotency === undefined ? { scope: plan.scope, key: key.key, write: true } : plan.idempotency
        }), { at: at, fingerprint: fingerprint });
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
         避开 Approval 这个词：本文件的凭据边界逐字断言
         "Economy 不读 Approval / Bearer"（boundary B6.3），
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
      /* ── P22-26 · `units`：这份报价买了几份 ──────────────────────────
         ★ 它与 `quantity`（送达量）是两个各自被冻结的事实。水位 8 之前
         写的行由迁移补上 1 —— 那是对它们唯一正确的答案（那时 quantity
         就等于 grantQuantity）。
         ★ 这里**不**做 `row.units == null ? 1 : …` 那种兜底：列是
         NOT NULL，兜底只会把"读不到"伪装成"读到 1"，而那正是本阶段修掉
         的那个缺陷的形态。 */
      units: Number(row.units),
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
      /* P22-26：报价的"买了几份"是**读面**上的一件事实（与 quantity 并列），
         因为它与 quantity 不是同一个数（units=3 × grant=1000 ⇒ qty=3000）。 */
      units: view.units,
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
    /* ── P22-26 · `units`：报价上的"买了几份" ─────────────────────────
       它是**选择**，因此与 quantity 分开校验、分开落库（见水位 8 与
       createQuotes 的 DDL 说明）。

       ★ 缺省是 1，而且这个缺省的位置是刻意的：raw createQuote 是 P22-4
       的 primitive，它**没有商品行**，因而 quantity 是调用方直接给的
       "送达量"而不是 units × grantQuantity —— 对它来说"一次一份"是唯一
       自洽的读法。真正需要精确 units 的是 createProductQuote，它**总是**
       显式传（见那里）。
       ★ 校验失败是 INVALID_AMOUNT 而不是新词：份数与数量同属"金额/数量
       这一族"的不合法输入，加一个新 reason code 等于为同一件事造第二个
       名字（P22-6 的 preparePurchase 用的也是这一个）。 */
    const units = o.units == null ? 1 : Number(o.units);
    if (!Number.isSafeInteger(units) || units < 1) {
      return denial(C.DENY_REASON.INVALID_AMOUNT, ['units-must-be-a-positive-safe-integer']);
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
      units: units,
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
          cur.currency, toSqlAmount(amt.amountMinor, 'quote-amount'), Number(qty), Number(units),
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
  /* P22-6：购买的几个观测计数。与上面同款 —— counting 是观测，不是判断。 */
  function countPurchases() { return Number((db.prepare(SQL.countPurchases).get() || {}).c || 0); }
  function countPurchasesByStatus(status) {
    return Number((db.prepare(SQL.countPurchasesByStatus).get(String(status)) || {}).c || 0);
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

  /* ── P22-26 · 报价的 `units`：三个下游调用方的**唯一**读法 ─────────────
     `units`（买了几份）从 P22-26 起是**报价自己的一列**，因为 `quantity`
     是送达量（units × grantQuantity）—— 报价把 units 算进了 quantity 与
     amount，就必须自己保存它，否则"这份报价说的是哪一件事"无法被重新
     回答（P22-4 的"快照必须自足"）。

     ★ 这个函数存在，是为了让"读 units"这件事只有**一份**实现：
     preparePurchase / createApprovalRequest / authorizePurchaseIntent 三者
     都要用 units 去重算金额、数量与九元组绑定，而它们过去各自写着
     `o.units == null ? 1 : Number(o.units)` —— 三处缺省、三处可能漂移，
     且它们**全部**与报价无关（报价里 units 是 3，它们却按 1 重算）。
     现在它们都从这里读，于是"prepare 从 payload 猜 units"在结构上不可能。

     ★ `units` 是一个**选择**而不是经济事实，因此它的权威位置是
     "当初写下这份报价的那一次请求" —— 也就是这一列。调用方**不能**再
     声明它：没有任何入参可以覆盖它（与"Agent 不得提供经济事实"同源）。 */
  function quoteUnitsOf(quoteRow) {
    const raw = quoteRow == null ? null : quoteRow.units;
    const units = Number(raw);
    /* 列是 NOT NULL CHECK (units >= 1)，因此这里的失败只可能是"拿到了一行
       根本不是报价行"。fail closed，不猜一个 1。 */
    if (!Number.isSafeInteger(units) || units < 1) {
      return { ok: false, units: null, errors: ['quote-has-no-canonical-units'] };
    }
    return { ok: true, units: units, errors: [] };
  }

  /* 报价的 units × 商品的 grantQuantity ⇒ 这一份报价的**送达量**。
     载入期关系断言：它必须逐字等于报价上已经冻结的 `quantity`。
     ── 为什么这条比对的存在理由是结构性的、而不是碰巧能过 ──────────────
     `grantQuantity` 是 `economy_products` 的**不可变**本体列（P22-5：
     唯一能改的两列是 status 与 unit_price_minor —— 见 updateProduct 的
     SET），因此 `units × grantQuantity` 在报价创建之后不可能改变。于是
     "quantity == units × grantQuantity" 是一条**只可能被绕过列约束的手工
     改库**破坏的不变量，而不是一个每天都可能漂移的比较。
     这正是把"份数"与"送达量"分成两个各自冻结的事实的代价 —— 而它换来
     的是 prepare 不再需要从请求里猜任何一个数。 */
  function quoteQuantitiesOf(product, quoteRow) {
    const u = quoteUnitsOf(quoteRow);
    if (!u.ok) return { ok: false, units: null, quantity: null, errors: u.errors };
    const derived = C.productQuoteQuantity(product, u.units);
    if (!derived.ok) return { ok: false, units: u.units, quantity: null, errors: derived.errors };
    if (Number(quoteRow.quantity) !== Number(derived.quantity)) {
      return {
        ok: false, units: u.units, quantity: null,
        errors: ['quote-quantity-must-equal-units-times-grant-quantity'],
        quoteQuantity: Number(quoteRow.quantity),
        derivedQuantity: Number(derived.quantity)
      };
    }
    return { ok: true, units: u.units, quantity: Number(derived.quantity), errors: [] };
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

    /* ── P22-26 · `units`（买了几份）：在这里校验，并**随报价一起落库** ──
       这个显式校验不是多余的（createQuote 也会校验一次）：createProductQuote
       是**唯一**知道 units 的经济含义的地方（quantity = units × grantQuantity），
       因此它必须是给出那个拒绝的地方 —— 与 kind / amount / quantity 同款。
       ★ 而真正的新东西在下面 `createQuote({... units: units ...})`：这是
       "报价自己保存份数"的那一行。没有它，prepare 只能从请求里再要一次。 */
    const units = o.units == null ? 1 : Number(o.units);
    if (!Number.isSafeInteger(units) || units < 1) {
      return denial(C.DENY_REASON.INVALID_AMOUNT, ['units-must-be-a-positive-safe-integer']);
    }

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
      /* ★ P22-26：份数随报价落库 —— 这就是本阶段修掉那个算错的那一列。
         它必须在这里，因为这是**唯一**同时知道"买了几份"与"一份交付多少"
         的地方，而报价的 quantity 只保存了那个乘积。 */
      units: units,
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
  /* ── mutateInventoryInTx（P22-5 内核，提取于 P22-6）──────────────────
     ★ 它**不自行 BEGIN/COMMIT**。由调用方（grantInventory / consumeInventory
     的公开包装，或 P22-6 的 settlePurchase）拥有事务边界。

     提取是纯机械的：同一条 canonical 读、同一对带算术守卫的 UPDATE、
     同一条 change log、同一条读回自检。写入方看到的只有：

       ctx = { owner, productRow, fingerprint, at, key, existingRow? }

     调用方负责的那些检查（owner / product 存在性 / assetKind）在公开包装
     里原样保留，并且**也**保留在这里 —— 因为 P22-6 的 settlePurchase 在
     同一个事务里直接调用它，而那时"商品行还是刚才那一行吗"必须在写锁
     之下再回答一次（Product 的 asset_kind 本身不可变，但这一条是**结构**
     性质，不该被当成跳过读取的理由）。 */
  function mutateInventoryInTx(mode, input, ctx) {
    const grant = String(mode) === 'grant';
    const o = input || {};
    const c = ctx || {};
    const owner = c.owner;
    const productRow = c.productRow;
    const ownerId = String(owner.party.id);
    const quantity = Number(o.quantity);
    const productId = String(c.productId);
    const key = c.key;
    const fingerprint = c.fingerprint;
    const idem = c.idempotency || null;

    /* ── 商品行在写锁之下再读一次（canonical，不是缓存）───────────── */
    const lockedProductRow = db.prepare(SQL.selectProduct).get(productId);
    if (!lockedProductRow) throw refuse(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: productId });
    const lockedProduct = rowToProduct(lockedProductRow);
    if (lockedProduct.assetKind == null) {
      throw refuse(C.DENY_REASON.EFFECT_NOT_ALLOWED,
        ['this-product-fulfillment-does-not-produce-inventory'],
        { productId: productId, fulfillment: lockedProduct.fulfillment });
    }
    /* 若调用方已经持有那一行，就断言它没有在锁外被换掉。这条不是防御性
       编程：settlePurchase 的 Ledger 金额与库存发放必须来自**同一次**
       商品快照，而"两次读之间被改过"是唯一能破坏它的情形。 */
    if (productRow && String(productRow.product_id) !== String(lockedProductRow.product_id)) {
      throw refuse(null, ['inventory-product-row-changed-under-the-transaction'], { productId: productId });
    }

    const at = c.at;
    const revision = allocateRevision();
    /* ── canonical 读：数量**只**从这一行来 ─────────────────────── */
    const existingRow = db.prepare(SQL.selectInventoryByOwnerProduct).get(ownerId, productId);
    let entryId;
    if (grant) {
      if (!existingRow) {
        entryId = c.requestedEntryId == null ? nextId('INVENTORY_ENTRY') : String(c.requestedEntryId);
        if (!C.isEconomyId('INVENTORY_ENTRY', entryId)) {
          throw refuse(null, ['inventory-entry-id-not-canonical']);
        }
        db.prepare(SQL.insertInventory).run(
          String(entryId), ownerId, String(owner.party.type), productId, String(lockedProduct.assetKind),
          Number(quantity), key, fingerprint, Number(revision), Number(at), Number(at)
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
          Number(quantity), key, fingerprint, Number(revision), Number(at),
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
        Number(quantity), key, fingerprint, Number(revision), Number(at),
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
    const view = rowToInventoryEntry(row, lockedProductRow);
    const eventKind = grant ? C.EVENT_TYPE.INVENTORY_GRANTED : C.EVENT_TYPE.INVENTORY_CONSUMED;
    const result = {
      domain: C.DOMAIN,
      inventoryEntryId: String(entryId),
      ownerId: ownerId,
      ownerType: String(owner.party.type),
      productId: productId,
      assetKind: String(lockedProduct.assetKind),
      quantity: after,
      previousQuantity: existingRow ? Number(existingRow.quantity) : 0,
      delta: grant ? Number(quantity) : -Number(quantity),
      grantedQuantity: grant ? Number(quantity) : 0,
      consumedQuantity: grant ? 0 : Number(quantity),
      eventKind: String(eventKind),
      revision: Number(revision),
      at: Number(at),
      idempotencyKey: idem ? idem.key : null,
      entry: serializeInventoryEntry(view),
      /* ── §13/§14：三句逐字的自述 ────────────────────────────────
         primitive 不动钱、不动钱包；它**自己**不是一次购买。
         P22-6 的 settlePurchase 仍然借用了这个 primitive，而它借用的
         那一刻恰好是"钱与货在同一个事务里"那一刻 —— 于是这三句在
         那条路径上依然为真（ledgerMutation 由 ledger 那一步负责，
         不属于 inventory 这一步）。 */
      ledgerMutation: false,
      walletMutation: false,
      isAPurchase: false,
      notAPurchase: (grant ? 'grantInventory' : 'consumeInventory') +
        ' is an inventory primitive; a purchase is quote + reservation + ledger + inventory in ONE transaction (see settlePurchase)'
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
        assetKind: String(lockedProduct.assetKind),
        quantity: after,
        previousQuantity: existingRow ? Number(existingRow.quantity) : 0,
        delta: grant ? Number(quantity) : -Number(quantity),
        ledgerMutation: false,
        walletMutation: false,
        isAPurchase: false
      }
    });
    faultPoint('before-inventory-change-log');
    if (idem && idem.write !== false) {
      writeOperationIdempotency(idem.scope, idem.key, fingerprint, {
        operationId: null, reservationId: null, transactionId: null
      }, result, revision, at);
    }
    faultPoint('before-inventory-commit');
    return result;
  }

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
        committed = mutateInventoryInTx(grant ? 'grant' : 'consume', o, {
          owner: owner, productRow: productRow, productId: productId,
          key: key.key, fingerprint: fingerprint, requestedEntryId: requestedEntryId, at: at,
          idempotency: { scope: scope, key: key.key, write: true }
        });
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

  function consumeOwnedItem(input, context) {
    requireOpen();
    const o = input || {};
    const ctx = context || {};

    /* ── ① owner 来自**权威上下文**，绝不来自 payload ──────────────────
       ★ 这一条是结构性的，不是纪律：下面引用的每一个身份字段都取自
       `ctx.ownerId`，而 `o.ownerId` / `o.characterId` / `o.buyerId` 在这个
       函数体里**一次都不出现**。于是"调用方自报身份"没有地方可以发生 ——
       与 economy command channel 的
       `NOT_ALLOWED_FOR_A_CONSUMER_TO_SELF_REPORT` 是同一条纪律的两种落地
       形态（那里是拒绝那个键，这里是根本没有读它的代码）。
       ★ 缺失时 fail closed，而不是回落到 payload 或某个缺省 owner：
       "谁的东西"是一次消耗的**全部**内容，猜一个等于替别人做决定。
       ★ 判据分两级，因为"没有上下文"与"上下文里的 owner 不合法"是两件
       事：第一级只回答"有没有一个非空的权威 owner"（`ctx.ownerId === ''`
       与"整个 context 是空对象"都算没有）。 */
    const authorityOwner = ctx.ownerId == null ? null : String(ctx.ownerId).trim();
    /* ownerType 同样来自上下文；缺省 `character` 与这一域里 owner 的实际
       形态一致（钱包与库存的 owner 都是 character）。它**不是**一个可自报
       的字段：payload 里的 ownerType 不参与。 */
    const authorityOwnerType = ctx.ownerType == null ? C.PARTY_TYPE.CHARACTER : String(ctx.ownerType);
    if (authorityOwner == null || authorityOwner === '') {
      return denial(C.DENY_REASON.ACCOUNT_NOT_ALLOWED,
        ['consume-owned-item-requires-an-authority-context-with-an-owner'],
        { identityComesFromThePayload: false, authorityContextRequired: true });
    }
    /* ── ★ 上下文准入：它必须是一份**说得通的权威身份** ────────────────
       与"这个字段存不存在"是两件事。一个空串、一个 system party、或者一个
       形状不对的 owner 都必须在这里被拒绝，而不是被下游翻译成一句关于
       别的什么事的话（开发期实测踩到过：缺上下文时下游回的是
       `party-id-required` —— 那是一句**关于 payload** 的抱怨，而真正的问题
       是"这次调用没有权威上下文"）。
       ★ system party 被拒绝的理由与库存 primitive 逐字相同：系统不持有
       库存，因此它也不可能消耗库存。 */
    const ownerRef = C.makePartyRef(authorityOwnerType, authorityOwner);
    if (!ownerRef.ok) {
      return denial(C.DENY_REASON.ACCOUNT_NOT_ALLOWED,
        ['authority-context-owner-is-not-a-canonical-party'],
        { ownerType: authorityOwnerType, ownerIsCanonical: false });
    }
    if (ownerRef.party.type === C.PARTY_TYPE.SYSTEM) {
      return denial(C.DENY_REASON.ACCOUNT_NOT_ALLOWED,
        ['system-party-cannot-hold-inventory-and-cannot-consume-it'],
        { ownerType: String(ownerRef.party.type) });
    }

    /* ── ② 目标持有物：productId 是 canonical 的商品 id ───────────────
       ★ 刻意**只**接受 productId，不接受 inventoryEntryId：库存的 canonical
       键是 (owner_id, product_id)（P22-5 §13），而一个 inventory_entry_id
       是一个**行 id** —— 接受它等于允许"拿别人的行 id 来扣"。用
       (owner, product) 表达"用掉我的一个 X"让越权在形状上不可表达。 */
    const productId = o.productId == null ? null : String(o.productId);
    if (!C.isEconomyId('PRODUCT', productId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['product-id-not-canonical'] };
    }
    const quantity = Number(o.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return denial(C.DENY_REASON.INVENTORY_INPUT_NOT_STRUCTURED,
        ['inventory-quantity-must-be-a-positive-safe-integer']);
    }
    /* 唯一物品在本阶段不可表示（与 mutateInventory 逐字同一条否认）。 */
    if (o.instanceId != null || o.serial != null || o.uniqueItemId != null) {
      return denial(C.DENY_REASON.INVENTORY_INPUT_NOT_STRUCTURED,
        ['unique-item-instances-are-not-modelled-in-this-schema']);
    }

    /* ── ③ 这件商品**是不是**消耗品：这是 CONSUMABLE 与 DIGITAL_ITEM
       真正分开的那一条，而它必须在这里 fail closed ──────────────────
       过去两个 kind 的 fulfillment 与 assetKind 逐字相同，因此它们在运行时
       是同一个东西；"消耗品"只是契约注释里的一句话。现在：
         · `kind === CONSUMABLE` ⇒ 可以被用掉；
         · 任何其它 kind（含 DIGITAL_ITEM / API_QUOTA / SERVICE）⇒
           EFFECT_NOT_ALLOWED，**一个字都不改**。
       ★ 为什么用 kind 而不是新加一个字段：`kind → fulfillment → assetKind`
       已经是"买完发生什么"的唯一编码（P22-5 冻结的派生表），再写一个
       effect 就是同一件事的第二个答案。
       ★ 这条检查在事务**之前**先做一次（快速失败、可读的拒绝），并在写锁里
       由 mutateInventoryInTx 的 assetKind 检查再兜一次。 */
    const productRowForKind = db.prepare(SQL.selectProduct).get(productId);
    if (!productRowForKind) {
      return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: productId });
    }
    if (String(productRowForKind.product_kind) !== C.PRODUCT_KIND.CONSUMABLE) {
      return denial(C.DENY_REASON.EFFECT_NOT_ALLOWED,
        ['only-a-consumable-can-be-consumed'],
        {
          productId: productId,
          productKind: String(productRowForKind.product_kind),
          consumable: false,
          /* 逐字：这不是"权限不够"，而是"这件东西根本不是消耗品"。 */
          aDurableItemIsNotConsumedByUsingIt: true
        });
    }

    /* ── ④ 真正的那一次调用：consume 方向，且**只有** consume 方向 ────
       ★ `'consume'` 在下面是一个**字面量**（不是参数）：这个接缝没有 grant
       的形态，因此"通过消耗接缝发一次库存"在结构上不可能。
       ★ ownerId 用的是权威上下文的那个字符串。 */
    const out = mutateInventory('consume', {
      /* ★ 写成 `{type, id}` 而不是裸字符串：`partyInput` 对裸字符串一律
         assume CHARACTER，而那会让"上下文说这是一个 user-party"被静默
         改写成 character。类型是身份的一半，不能由缺省补上。 */
      ownerId: { type: authorityOwnerType, id: authorityOwner },
      productId: productId,
      quantity: quantity,
      idempotencyKey: o.idempotencyKey
    });
    if (out.ok !== true) return out;

    return Object.assign({}, out, {
      result: Object.assign({}, out.result, {
        /* ── 自述位（与 inventory primitive 的三句同源）────────────────
           一次消耗**不动钱**：它不是一次支出，因此不需要预算、不需要批准、
           不需要"花别人的钱的许可"。它需要的是"这个 owner 决定用掉自己的
           东西" —— 而那个决定就是权威上下文。 */
        consumedItem: true,
        isAPurchase: false,
        ledgerMutation: false,
        walletMutation: false,
        budgetEvaluated: false,
        approvalRequired: false,
        ownerFromAuthorityContext: true,
        ownerFromPayload: false
      })
    });
  }

  function grantInventory(input) { return mutateInventory('grant', input); }
  function consumeInventory(input) { return mutateInventory('consume', input); }

  /* ══════════════════════════════════════════════════════════════════
     P22-6 · Purchase Orchestrator + Atomic Settlement

     这一层把六件既有的事实组织成一个高层生命周期：

       Product → Product-backed Quote → Budget → Reservation
               → Final Revalidation → Atomic Settlement
                 ├── Ledger Transaction
                 ├── Reservation → COMMITTED
                 ├── Quote → CONSUMED
                 ├── Inventory / Compute entitlement grant
                 ├── Wallet derived cache
                 ├── Economy change log
                 └── Idempotency

     ★ 本层最重要的一条性质写在 settlePurchase 里：**最终结算恰好是
     一个 SQLite 事务**。它不是靠"顺序调用几个都会自己开事务的方法"
     实现的，而是靠三件事同时成立：
       ① withTransaction 可重入（内层永不 COMMIT）；
       ② 每一步走的是 P22-2/P22-3/P22-5 的**同一个**事务体内核
          （commitLedgerTransactionInTx / commitReservationInTx /
          settleReservationInTx / mutateInventoryInTx），不是它们的拷贝；
       ③ 结算的故障注入点全部落在那个事务里面。
     ══════════════════════════════════════════════════════════════════ */

  /* ── 读模型（§2：Purchase 必须足以回答八个问题）─────────────────────
     一份 purchase 视图同时回答：
       谁买的（buyerId）· 给谁（recipientId 或 null = 自己）·
       买了什么（productId）· 按哪个 Quote（quoteId）· 多少钱
       （amountMinor + currency）· 锁的是哪笔 Reservation（reservationId）·
       最后是哪笔 Ledger Transaction（ledgerTransactionId）·
       settlement 给了什么（settlement 那一块）· 成功还是失败（status）。

     刻意**不**把 quote/reservation/ledger 的整行嵌进来（§79）：那是
     三个无界的对象，而 Purchase 是一个 canonical entity。 */

  /* recipientId 的**唯一**编码：'user' 与 'character' 的 id 空间可能
     重叠（一个角色可以就叫 cfg_a，而 canonical 用户分区键恰好也是
     user:{...} 的形状），因此裸 id 不足以回答"给谁"。P22-1 冻结的
     party ref 是二元组，这里把它写成 'type:id' 一个字符串。 */
  function partyKeyOf(type, id) {
    return String(type == null ? '' : type) + ':' + String(id == null ? '' : id);
  }

  /* ── 结算发放的**读面**自述（结算完整性用它与 canonical 库存行对账）──
     它回答："一条 COMPLETED 的购买说它发了 N 份，那一行库存真的在吗？"
     与 P22-5 的 inventoryProblemsOf 同款：**查询出来的前提**，不是假设。 */
  function inventorySettlementProblemsOf(purchase) {
    const problems = [];
    const prim = C.settlementPrimitiveOfFulfillment(purchase.settlementType);
    if (!prim.ok || prim.primitive == null) return problems;
    if (String(purchase.status) !== C.PURCHASE_STATE.COMPLETED) return problems;
    if (Number(purchase.settledQuantity) <= 0) return problems;
    const row = db.prepare(SQL.selectInventoryByOwnerProduct)
      .get(String(purchase.recipientId), String(purchase.productId));
    if (!row) return problems.concat(['a-completed-purchase-without-its-inventory-row']);
    if (purchase.inventoryEntryId != null && String(row.inventory_entry_id) !== String(purchase.inventoryEntryId)) {
      problems.push('a-completed-purchase-whose-inventory-row-is-not-the-one-it-references');
    }
    if (purchase.settledAssetKind != null && String(row.asset_kind) !== String(purchase.settledAssetKind)) {
      problems.push('a-completed-purchase-with-an-inventory-row-of-a-different-asset-kind');
    }
    return problems;
  }

  function rowToPurchase(row) {
    const quoteRow = db.prepare(SQL.selectQuote).get(String(row.quote_id));
    const resRow = db.prepare(SQL.selectReservation).get(String(row.reservation_id));
    const txRow = row.ledger_transaction_id == null
      ? null : db.prepare(SQL.selectTransaction).get(String(row.ledger_transaction_id));
    const invRow = row.inventory_entry_id == null
      ? null : db.prepare(SQL.selectInventoryEntry).get(String(row.inventory_entry_id));
    const settlementPrimitive = C.settlementPrimitiveOfFulfillment(row.settlement_type);
    return {
      domain: C.DOMAIN,
      namespace: C.NAMESPACES.PURCHASE,
      purchaseId: String(row.purchase_id),
      buyerId: partyKeyOf(row.buyer_type, row.buyer_id),
      buyerType: String(row.buyer_type),
      buyerRef: Object.freeze({ type: String(row.buyer_type), id: String(row.buyer_id) }),
      recipientId: row.recipient_id == null ? null : partyKeyOf(row.recipient_type, row.recipient_id),
      recipientType: row.recipient_id == null ? null : String(row.recipient_type),
      recipientRef: row.recipient_id == null ? null
        : Object.freeze({ type: String(row.recipient_type), id: String(row.recipient_id) }),
      /* 送到自己手上与送给别人是**两个不同的键**：null 与 'character:x'
         不是在同一个字段里混用 —— 这是 §23"不要默认 buyer == recipient"
         在读面上的落点。 */
      selfDirected: row.recipient_id == null,
      productId: String(row.product_id),
      storeId: row.store_id == null ? null : String(row.store_id),
      quoteId: String(row.quote_id),
      quoteState: quoteRow ? String(quoteRow.state) : null,
      quotePresent: !!quoteRow,
      reservationId: String(row.reservation_id),
      reservationState: resRow ? String(resRow.status) : null,
      reservationStateAtPrepare: String(row.reservation_state),
      reservationPresent: !!resRow,
      reservationExpiresAt: row.reservation_expires_at == null ? null : Number(row.reservation_expires_at),
      ledgerTransactionId: row.ledger_transaction_id == null ? null : String(row.ledger_transaction_id),
      ledgerTransactionPresent: !!txRow,
      ledgerTransactionType: txRow ? String(txRow.tx_type) : null,
      currency: String(row.currency),
      amountMinor: fromSqlAmount(row.amount_minor, 'purchase-amount'),
      quoteKind: String(row.quote_kind),
      /* settlementType **就是** Product 的 fulfillment（见契约 §22 的
         说明），因此它是"这次怎么结算"的那一个词。 */
      settlementType: String(row.settlement_type),
      settlementPrimitive: settlementPrimitive.ok ? settlementPrimitive.primitive : null,
      settledAssetKind: row.asset_kind == null ? null : String(row.asset_kind),
      /* granted_quantity 是**本次结算发放了多少份**（= 报价的 quantity ×
         一份交付量），不是 Product 行上的 grantQuantity。 */
      grantedQuantity: Number(row.granted_quantity),
      unitName: row.unit_name == null ? null : String(row.unit_name),
      inventoryEntryId: row.inventory_entry_id == null ? null : String(row.inventory_entry_id),
      inventoryEntryPresent: !!invRow,
      inventoryQuantityAfter: invRow ? Number(invRow.quantity) : null,
      status: String(row.status),
      terminal: C.PURCHASE_TERMINAL_STATES.indexOf(String(row.status)) >= 0,
      completed: String(row.status) === C.PURCHASE_STATE.COMPLETED,
      /* ── P22-7：授权那一面（§16 的四个问题全部落在这里）──────────────
         `approvalMode === null` 逐字表示"这条记录早于授权层"（P22-7
         之前的行，或没走闸门的直接 P22-6 用法）—— 它**不是**
         AUTO_ALLOW，也不是 APPROVAL，而是一个准确的历史事实。
         approvalStatus / approvedBy 从**落库的批准行**读（不是从 purchase
         行猜），因此"是谁批准的什么"只有一个出处。 */
      approvalMode: row.approval_mode == null ? null : String(row.approval_mode),
      gatedByP22_7: row.approval_mode != null,
      approvalId: row.approval_id == null ? null : String(row.approval_id),
      autonomyPolicyId: row.autonomy_policy_id == null ? null : String(row.autonomy_policy_id),
      approvalBindingFingerprint: row.approval_binding_fingerprint == null ? null : String(row.approval_binding_fingerprint),
      /* 买了几份（P22-7 的新列）。旧行是 null —— 那是一个准确的答案：
         P22-7 之前没有落过这个事实。 */
      units: row.units == null ? null : Number(row.units),
      autonomous: String(row.approval_mode) === C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW,
      requiredUserApproval: String(row.approval_mode) === C.PURCHASE_APPROVAL_MODE.APPROVAL,
      approval: row.approval_id == null ? null : (function () {
        const a = db.prepare(SQL.selectApproval).get(String(row.approval_id));
        if (!a) return null;
        return Object.freeze({
          approvalId: String(a.approval_id),
          status: String(a.status),
          decidedBy: a.decided_by_id == null ? null : partyKeyOf(String(a.decided_by_type), String(a.decided_by_id)),
          decidedAt: a.decided_at == null ? null : Number(a.decided_at),
          expiresAt: Number(a.expires_at),
          consumedByPurchaseId: a.consumed_by_purchase_id == null ? null : String(a.consumed_by_purchase_id),
          bindingFingerprint: String(a.binding_fingerprint)
        });
      })(),
      releaseReason: row.release_reason == null ? null : String(row.release_reason),
      reasonCode: row.reason_code == null ? null : String(row.reason_code),
      idempotencyKey: String(row.idempotency_key),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at == null ? null : Number(row.completed_at)
    };
  }

  /* 结算那一块的对外形态。**只有已完成的购买**才有 ledgerTransactionId 与
     一份真实交付；RESERVED / RELEASED / FAILED 三者在这里逐字写着
     `spentAnything: false` / `grantedAnything: false` —— 于是"钱还在不在"
     这个问题的答案在**读面**上也是结构性的，不需要再去查一遍账本。 */
  function purchaseSettlementOf(purchase) {
    const completed = String(purchase.status) === C.PURCHASE_STATE.COMPLETED;
    return {
      ledgerTransactionId: completed ? purchase.ledgerTransactionId : null,
      ledgerTransactionType: completed ? purchase.ledgerTransactionType : null,
      spentAmountMinor: completed ? C.serializeAmountMinor(purchase.amountMinor) : '0',
      currency: purchase.currency,
      settlementType: purchase.settlementType,
      settlementPrimitive: purchase.settlementPrimitive,
      assetKind: purchase.settledAssetKind,
      grantedQuantity: completed ? purchase.grantedQuantity : 0,
      unitName: purchase.unitName,
      inventoryEntryId: completed ? purchase.inventoryEntryId : null,
      /* ★ 收货人 **永远**有答案：买给自己时它就是买家。
         （Purchase 行上的 recipientId 是 null，那表示"这不是一份礼物"，
         不是"没有人收到"—— 两者混用会让 §52 的问题"B 收到了吗"
         在一个送礼给自己以外的人的场景里得到 null。） */
      recipientId: completed ? (purchase.recipientId == null ? purchase.buyerId : purchase.recipientId) : null,
      selfDirected: purchase.selfDirected === true,
      /* 逐字的自述，与 P22-5 的 inventory primitive 同款。 */
      spentAnything: completed,
      grantedAnything: completed,
      ledgerMutation: completed,
      providerMutation: false,
      paymentMutation: false,
      memoryMutation: false,
      relationshipMutation: false,
      amountSource: C.PURCHASE_AMOUNT_SOURCE,
      rewritesHistoricalQuotes: C.PURCHASE_REWRITES_HISTORICAL_QUOTES
    };
  }

  function serializePurchase(view) {
    return {
      domain: view.domain,
      namespace: view.namespace,
      purchaseId: view.purchaseId,
      buyerId: view.buyerId,
      recipientId: view.recipientId,
      selfDirected: view.selfDirected,
      productId: view.productId,
      storeId: view.storeId,
      quoteId: view.quoteId,
      reservationId: view.reservationId,
      ledgerTransactionId: view.ledgerTransactionId,
      currency: view.currency,
      amountMinor: C.serializeAmountMinor(view.amountMinor),
      quoteKind: view.quoteKind,
      settlementType: view.settlementType,
      settlementPrimitive: view.settlementPrimitive,
      assetKind: view.settledAssetKind,
      grantedQuantity: view.grantedQuantity,
      unitName: view.unitName,
      /* P22-7：买了几份。旧行是 null（P22-7 之前没落过这个事实）。 */
      units: view.units,
      inventoryEntryId: view.inventoryEntryId,
      status: view.status,
      terminal: view.terminal === true,
      completed: view.completed === true,
      releaseReason: view.releaseReason,
      reasonCode: view.reasonCode,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      completedAt: view.completedAt,
      /* ── P22-7：授权那一面（稳定读面）──────────────────────────────
         `approvalMode === null` 逐字表示"这条记录早于授权层"；
         它**不是** AUTO_ALLOW。这句话必须能被读出来，否则"这笔为什么
         没问用户"对旧行会得到一个编造的答案。 */
      approvalMode: view.approvalMode,
      gatedByP22_7: view.gatedByP22_7 === true,
      autonomous: view.autonomous === true,
      requiredUserApproval: view.requiredUserApproval === true,
      approvalId: view.approvalId,
      autonomyPolicyId: view.autonomyPolicyId,
      approvalBindingFingerprint: view.approvalBindingFingerprint,
      approval: view.approval,
      /* 三句与 P22-5 同款的逐字否认（§1：Purchase 不等于它们中的任何一个）。 */
      isALedgerTransaction: false,
      isAReservation: false,
      isAQuote: false,
      /* P22-7：购买也**不是**一条批准，而且它不携带任何权限（权限是
         approvalId 那个一次性事实，不是这行记录）。 */
      isAnApproval: false,
      grantsAutonomy: false,
      grantsBudget: false,
      hasRefund: C.PURCHASE_HAS_REFUND,
      exposesHttpMutation: C.PURCHASE_EXPOSES_HTTP_MUTATION
    };
  }

  /* ── getPurchase（§79：稳定形状，三个**小结**而不是三棵历史）───────── */
  function getPurchase(input) {
    requireOpen();
    const o = typeof input === 'string' ? { purchaseId: input } : (input || {});
    const purchaseId = o.purchaseId == null ? null : String(o.purchaseId);
    if (!C.isEconomyId(C.PURCHASE_ID_KIND, purchaseId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['purchase-id-not-canonical'] };
    }
    const row = db.prepare(SQL.selectPurchase).get(purchaseId);
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['purchase-not-found'] };
    const view = rowToPurchase(row);
    const quoteRow = db.prepare(SQL.selectQuote).get(view.quoteId);
    const resRow = db.prepare(SQL.selectReservation).get(view.reservationId);
    const productRow = db.prepare(SQL.selectProduct).get(view.productId);
    return {
      ok: true,
      purchase: serializePurchase(view),
      quoteSummary: quoteRow ? {
        quoteId: String(quoteRow.quote_id),
        state: String(quoteRow.state),
        amountMinor: C.serializeAmountMinor(fromSqlAmount(quoteRow.amount_minor, 'quote-amount')),
        currency: String(quoteRow.currency),
        quantity: Number(quoteRow.quantity),
        kind: String(quoteRow.quote_kind),
        expiresAt: Number(quoteRow.expires_at)
      } : null,
      reservationSummary: resRow ? {
        reservationId: String(resRow.reservation_id),
        state: String(resRow.status),
        amountMinor: C.serializeAmountMinor(fromSqlAmount(resRow.amount_minor, 'reservation-amount')),
        currency: String(resRow.currency),
        transactionId: resRow.transaction_id == null ? null : String(resRow.transaction_id),
        expiresAt: resRow.expires_at == null ? null : Number(resRow.expires_at)
      } : null,
      productSummary: productRow ? {
        productId: String(productRow.product_id),
        name: String(productRow.name),
        storeId: String(productRow.store_id),
        status: String(productRow.status),
        kind: String(productRow.kind),
        fulfillment: String(productRow.fulfillment),
        unitName: String(productRow.unit_name),
        grantQuantity: Number(productRow.grant_quantity),
        present: true,
        /* P22-5 的冻结结论在这里逐字重述：商品行只是**出处**，而这次
           购买的经济内容不依赖它 —— 一次改价/下架不会改写历史。 */
        purchaseEconomicContentDependsOnThisRow: false
      } : { productId: view.productId, present: false, purchaseEconomicContentDependsOnThisRow: false },
      /* P22-7：第**四**个小结 —— 与 quote / reservation / product 三者同级。
         §16 的两个问题（"是谁批准的什么""这个批准最终被哪笔 Purchase 消费"）
         在这里有一个稳定的读面答案，而不需要调用方自己拼接两张表。 */
      authorizationSummary: {
        mode: view.approvalMode,
        gatedByP22_7: view.gatedByP22_7 === true,
        autonomous: view.autonomous === true,
        requiredUserApproval: view.requiredUserApproval === true,
        approvalId: view.approvalId,
        autonomyPolicyId: view.autonomyPolicyId,
        approvalBindingFingerprint: view.approvalBindingFingerprint,
        approval: view.approval,
        approvalConsumedByThisPurchase: view.approval != null && String(view.approval.consumedByPurchaseId) === String(view.purchaseId),
        approvedBy: view.approval == null ? null : view.approval.decidedBy,
        approvalBindingFingerprint: view.approval == null ? null : view.approval.bindingFingerprint,
        oneApprovalAtMostOnePurchase: C.APPROVAL_IS_SINGLE_USE,
        approvalBypassesBudget: C.APPROVAL_BYPASSES_BUDGET,
        approvalBypassesQuoteExpiry: C.APPROVAL_BYPASSES_QUOTE_EXPIRY,
        budgetSeparatelyEvaluated: true
      },
      settlement: purchaseSettlementOf(view)
    };
  }

  function listPurchases(options) {
    requireOpen();
    const o = options || {};
    const limit = normalizeLimit(o.limit, 50, 500);
    const buyerId = o.buyerId == null ? null : String(o.buyerId);
    const recipientId = o.recipientId == null ? null : String(o.recipientId);
    const status = o.status == null ? null : String(o.status);
    const productId = o.productId == null ? null : String(o.productId);
    const quoteId = o.quoteId == null ? null : String(o.quoteId);
    if (status != null && !C.isPurchaseState(status)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['purchase-status-not-in-closed-set'], allowed: C.PURCHASE_STATES };
    }
    /* 调用方给的是**裸 id**（'cfg_a'），落库的是 'type:id'。这里做一次
       规范化，而且只在"给了"的情况下 —— 一条"必须给 buyerId"的规则会
       让"列出所有购买"变成不可能，而那是审计需要的操作。 */
    const rows = db.prepare(SQL.selectPurchasesFiltered).all(
      buyerId, buyerId, recipientId, recipientId,
      status, status,
      productId, productId,
      quoteId, quoteId,
      Number(limit)
    );
    return {
      ok: true,
      purchases: rows.map(r => serializePurchase(rowToPurchase(r))),
      count: rows.length,
      /* 逐字：这个列表**不是**个性化的（§40/§80）。没有推荐、没有排序
         分数、没有"给谁看"的参数 —— 它只是按 created_at 排的过滤结果。 */
      personalized: false,
      recommended: false,
      ranked: false
    };
  }

  /* ── 指纹（§36）───────────────────────────────────────────────────────
     描述的是**业务意图**，不是生成的 identity：purchaseId 与
     ledgerTransactionId 都不在里面，因此"同一件事重试"必然得到同一个
     指纹，而"改了一件事"必然得到不同的指纹。 */
  function purchaseFingerprint(scope, payload) {
    return fingerprintOf(stableStringify({ scope: String(scope), request: payload }));
  }

  /* ── 请求中"给谁"的归一化（§23）────────────────────────────────────
     必须显式区分两种情况，而不是给 recipientId 一个"缺省等于 buyer"的
     便利默认值：
       · 没给 recipientId          → 这次购买是买给自己的（selfDirected）；
       · 给了 recipientId 且 == buyer → 也要拒绝。
     第二条不是吹毛求疵：P22-4 的 GIFT 报价要求 recipient 存在，而
     "把一份 GIFT 报价拿来买给自己"会让"谁付钱 / 谁收货"在读面上
     变成同一个 id，于是审计无法回答 §52 的问题。 */
  function deriveRecipient(buyerParty, recipientInput) {
    if (recipientInput == null || String(recipientInput).trim() === '') {
      return { ok: true, party: null, selfDirected: true, errors: [] };
    }
    const r = partyInput(recipientInput);
    if (!r.ok) return { ok: false, party: null, selfDirected: false, errors: r.errors };
    if (r.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, party: null, selfDirected: false, errors: ['system-party-cannot-receive-a-purchase'] };
    }
    if (String(r.party.type) === String(buyerParty.type) && String(r.party.id) === String(buyerParty.id)) {
      return { ok: false, party: null, selfDirected: false, errors: ['a-recipient-must-differ-from-the-buyer'] };
    }
    return { ok: true, party: r.party, selfDirected: false, errors: [] };
  }

  /* 报价上的收件人与请求上的收件人必须是**同一个二元组**（类型 + id）。
     只比 id 是不够的：一个角色可以恰好叫 cfg_a，而 canonical 用户分区键
     的形状完全不同 —— 两者混为一谈会让"礼物送给了谁"出现两个答案。 */
  function recipientMatchesQuote(recipientParty, quoteRow) {
    const quoteHas = quoteRow.recipient_id != null && String(quoteRow.recipient_id).trim() !== '';
    if (recipientParty == null) return !quoteHas;
    if (!quoteHas) return false;
    return String(quoteRow.recipient_id) === String(recipientParty.id)
      && String(quoteRow.recipient_type == null ? '' : quoteRow.recipient_type) === String(recipientParty.type);
  }

  /* ── Budget 评价的读面（fail closed，§10/§30）───────────────────────
     空决策**不是** ALLOW。P22-4 的 evaluateBudgetFor 在"没有政策"或
     "政策不可信"时返回一个 systemFailure 决策，而这里把"没有任何决策"
     也归到同一条失败上：一次无法解释的预算评价不允许放行任何花钱的
     动作。 */
  function budgetDecisionOf(ownerId, currency, amountMinor, at) {
    const policyRow = policyForOwner(String(ownerId));
    const evalResult = evaluateBudgetFor({
      ownerId: String(ownerId), currency: String(currency), amountMinor: amountMinor, now: Number(at)
    });
    if (evalResult.ok !== true || !evalResult.decision) {
      return {
        ok: false,
        denial: denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, ['budget-evaluation-failed'], {
          systemFailure: true, ownerId: String(ownerId)
        })
      };
    }
    return {
      ok: true,
      /* ★ 用**决策自己**的 policyId，而不是从政策行再读一次：
         `policyForOwner` 返回的是 rowToBudgetPolicy 的**视图**（键名是
         `policyId`），而这里曾经写成 `policyRow.policy_id` —— 一个
         不存在的键，于是 `String(undefined)` 让返回里出现字面量
         `"undefined"`。决策对象上已经有权威的那个值，读它就不会有
         第二次命名机会出错。 */
      policyId: evalResult.decision.policyId == null ? null : String(evalResult.decision.policyId),
      policyPresent: !!policyRow,
      decision: evalResult.decision,
      snapshot: evalResult.snapshot || null
    };
  }

  /* 预算决策 → 一个**可解释的拒绝**。刻意分开三种形态：
     · DENY              → 规则说不（reasonCode 来自契约的封闭集合）；
     · REQUIRE_APPROVAL  → 规则说"要人点头"，而本阶段没有 Approval
                           workflow，因此它必须在**预留之前**停下（§10），
                           既不伪装成 FAILED，也不假装成 ALLOW（§11）；
     · systemFailure     → 规则这一面不可信 → fail closed。 */
  function budgetRefusalOf(budget, actionLabel) {
    const d = budget.decision;
    const detail = {
      outcome: d.outcome,
      priority: d.priority,
      policyId: budget.policyId,
      spentTodayMinor: d.spentTodayMinor,
      spentThisWeekMinor: d.spentThisWeekMinor,
      spentThisMonthMinor: d.spentThisMonthMinor,
      availableBalanceMinor: d.availableBalanceMinor,
      systemFailure: d.systemFailure === true,
      action: String(actionLabel)
    };
    if (d.outcome === C.BUDGET_DECISION.REQUIRE_APPROVAL) {
      return denial(C.DENY_REASON.PURCHASE_REQUIRES_APPROVAL,
        ['this-purchase-requires-approval-and-no-approval-workflow-exists'], detail);
    }
    return denial(d.reasonCode, ['budget-does-not-allow-this-spend'], detail);
  }

  /* ── ledger 对手方（§17/§18）──────────────────────────────────────────
     白名单来自 P22-1 的 SYSTEM_ACCOUNTS。★ Store **不是**商家：它没有
     价格、没有拥有关系，因此 storeId 不可能是一个 accounting account。
     这里把"对手方是谁"的判定放在契约里（settlementCounterpartyFor），
     运行层只负责把它落实成一行账户。 */
  function purchaseCounterpartyOf(quoteKind) {
    const cp = C.settlementCounterpartyFor(quoteKind);
    if (!cp.ok) return cp;
    const sys = ensureSystemAccount(cp.accountId);
    if (!sys.ok) return { ok: false, accountId: null, errors: sys.errors };
    return cp;
  }

  /* ── 结算条目的构造（**唯一一份**，§17）─────────────────────────────
     buyer wallet ──CREDIT──▶ system counterparty

     ★ 两件事都只从**已经落库的行**读，绝不接受调用方传入：
       · 金额   ← reservation 行（不是 Quote，不是请求，不是当前商品价）；
       · 账户   ← wallet 行的 account_id（**不是** wallet_id —— 钱包 id 与
                  它在 ledger 里的账户 id 是两个不同的东西，把后者写成前者
                  会得到一个"账户不存在"的拒绝，而更糟的写法会在某天
                  恰好同名时静默记错账）。
     与 P22-3 的 buildCommitEntries 同一条纪律："如果 commit 能自己指定
     金额，那它就不是一次提交，而是一次任意转账"。 */
  function buildPurchaseEntries(walletRow, reservationRow, counterparty) {
    const amountMinor = fromSqlAmount(reservationRow.amount_minor, 'reservation-amount');
    return normalizeEntries([
      { ledgerEntryId: null, accountId: String(walletRow.account_id), direction: C.ENTRY_DIRECTION.CREDIT, amountMinor: amountMinor, currency: String(reservationRow.currency) },
      { ledgerEntryId: null, accountId: String(counterparty), direction: C.ENTRY_DIRECTION.DEBIT, amountMinor: amountMinor, currency: String(reservationRow.currency) }
    ]);
  }

  /* ══════════════════════════════════════════════════════════════════
     §7 · preparePurchase（Prepare 阶段）

     它做四件事，而且**全部在一个 SQLite 事务里**：
       validate Product-backed Quote
       evaluate Budget（ALLOW 才继续）
       reserve funds（复用 P22-3 canonical 的 reserve 内核）
       create Purchase（RESERVED）

     Prepare 成功后世界的状态逐字是：
       Purchase = RESERVED · Reservation = ACTIVE · Quote = OPEN
       Ledger = unchanged · Inventory = unchanged

     ★ Quote 在 reserve 时**必须**保持 OPEN（§6）：资金只是被锁住，
     还没有最终 settlement。若此时就把它写成 CONSUMED，
     "reserve 成功 + 进程崩溃"会留下"报价已消费但商品没发"的**假事实**。
     ══════════════════════════════════════════════════════════════════ */
  function preparePurchase(input) {
    requireOpen();
    const o = input || {};

    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };
    if (o.purchaseId != null && !C.isEconomyId(C.PURCHASE_ID_KIND, o.purchaseId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['purchase-id-not-canonical'] };
    }
    /* ★ P22-26：这里**没有** `const units = o.units == null ? 1 : ...`。
       份数不是请求参数，而是**报价上已冻结的一列**；它在这份报价被读出
       之后、在写锁之内被读取（见下面的 quoteQuantitiesOf）。把它留在
       这里会让"从 payload 猜 units"有一个看起来合法的位置。 */

    const buyer = partyInput(o.buyerId != null ? o.buyerId : o.ownerId);
    if (!buyer.ok) return { ok: false, denied: false, reasonCode: null, errors: buyer.errors };
    if (buyer.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, denied: false, reasonCode: null, errors: ['system-party-cannot-buy'] };
    }
    const recipient = deriveRecipient(buyer.party, o.recipientId);
    if (!recipient.ok) return { ok: false, denied: false, reasonCode: null, errors: recipient.errors };

    const quoteId = o.quoteId == null ? null : String(o.quoteId);
    if (!C.isEconomyId('QUOTE', quoteId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['quote-id-not-canonical'] };
    }
    const quoteRow = db.prepare(SQL.selectQuote).get(quoteId);
    if (!quoteRow) return { ok: false, denied: false, reasonCode: null, errors: ['quote-not-found'] };

    /* ── §7：**只**接受 Product-backed Quote ──────────────────────────
       P22-4 的 raw createQuote 允许"随手给一个 productId"（它只做形状
       校验，deps.productExists 未注入时不查目录）。那种报价的 productId
       可能指向一个根本不存在的商品行，而 Purchase 的结算快照是从
       **products 行**派生 fulfillment / assetKind / unitName 的 ——
       对一份没有出处的报价，那三样只能靠猜。因此这里是硬门：目录里
       必须有这一行，而且它必须仍然 ACTIVE（报价**创建时**它必须是
       ACTIVE，这一条由 createProductQuote 保证；这里再确认一次，
       于是"手工改过库"不会绕过它）。 */
    const productRow = db.prepare(SQL.selectProduct).get(String(quoteRow.product_id));
    if (!productRow) {
      return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'],
        { productId: String(quoteRow.product_id), productBacked: false });
    }
    const product = rowToProduct(productRow);
    const provenance = C.QUOTE_PRODUCT_RELATION.PROVENANCE_ONLY;

    /* ── §7：报价的每一个可变属性都必须与请求一致 ───────────────────── */
    if (String(quoteRow.buyer_id) !== String(buyer.party.id) || String(quoteRow.buyer_type) !== String(buyer.party.type)) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['quote-buyer-does-not-match-the-purchase-buyer'],
        { quoteBuyerId: String(quoteRow.buyer_id), purchaseBuyerId: String(buyer.party.id) });
    }
    if (!recipientMatchesQuote(recipient.party, quoteRow)) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['quote-recipient-does-not-match-the-purchase-recipient'],
        { quoteRecipientId: quoteRow.recipient_id == null ? null : String(quoteRow.recipient_id) });
    }
    const quoteAmountMinor = fromSqlAmount(quoteRow.amount_minor, 'quote-amount');
    /* ── P22-26 · ★ 份数**只**来自报价，不再从请求里猜 ─────────────────
       这一段是本阶段修掉的那个算错的全部内容。过去这里是
         const units = o.units == null ? 1 : Number(o.units);
       也就是说：调用方不说 units 时我们**假定 1**，再拿这个 1 去重算金额
       与数量并与报价比对 —— 而报价里 units 可能是 3，于是那份报价被自己
       的一致性检查判成 QUOTE_MISMATCH（症状"账目对不上"）。

       ★ 现在权威是 `quoteRow.units`（报价创建时冻结的那一列）。请求里
       就算带了 units 也**不参与**：没有任何入参可以覆盖一份快照 ——
       "买几份"是当初那次请求的选择，它的家就是那份报价。
       ★ 同一次读取出 quantities，并顺带断言 quantity == units ×
       grantQuantity（见 quoteQuantitiesOf：grantQuantity 不可变，因此这是
       一条载入期不变量，而不是一个每天都会漂移的比较）。 */
    const quantities = quoteQuantitiesOf(product, quoteRow);
    if (!quantities.ok) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, quantities.errors, {
        quoteId: quoteId,
        quoteUnits: quantities.units,
        quoteQuantity: quantities.quoteQuantity === undefined ? null : quantities.quoteQuantity,
        derivedQuantity: quantities.derivedQuantity === undefined ? null : quantities.derivedQuantity
      });
    }
    const units = quantities.units;
    const expectedQuantity = {
      ok: true, quantity: quantities.quantity,
      deliveredPerUnit: quantities.quantity / units, errors: []
    };
    const expectedAmount = C.productQuoteAmountMinor(product, units);
    if (!expectedAmount.ok) return denial(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED, expectedAmount.errors);
    /* 金额仍然必须等于 `单价 × 份数`。这条**不是**多余：报价的金额是价格
       快照，而 unit_price_minor 是 P22-5 唯一可变的价格列 —— 因此"商品在
       报价之后改过价"正是在这里被发现并 fail closed 的。（H 组证明的是
       "已 Prepare 的购买不被改价影响"，不是"改价后的报价仍然可用"。） */
    if (expectedAmount.amountMinor !== quoteAmountMinor) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['purchase-amount-must-equal-the-quote-snapshot'], {
        quoteAmountMinor: C.serializeAmountMinor(quoteAmountMinor),
        requestedAmountMinor: C.serializeAmountMinor(expectedAmount.amountMinor),
        quoteQuantity: Number(quoteRow.quantity),
        requestedQuantity: expectedQuantity.quantity
      });
    }

    /* ── §7/§72：结算形态来自**不可变**的商品列 ───────────────────────
       fulfillment 与 asset_kind 是 Product 的本体列，P22-5 冻结了它们
       不可变（唯一能改的是 status 与 unit_price_minor）。因此从它们派生
       是安全的 —— 而**单价**绝不参与：价格事实只来自 Quote 快照。 */
    const fulfillment = C.fulfillmentOfProductKind(product.kind);
    if (!C.isFulfillment(fulfillment)) {
      return denial(C.DENY_REASON.EFFECT_NOT_ALLOWED, ['product-kind-has-no-fulfillment'], { kind: product.kind });
    }
    const primitive = C.settlementPrimitiveOfFulfillment(fulfillment);
    if (!primitive.ok) {
      /* §73：未知的 settlement 必须 **fail closed**，而且必须在 Ledger
         commit 之前 —— 绝不能出现"扣钱成功但不知道发什么"。 */
      return denial(C.DENY_REASON.PURCHASE_NOT_SUPPORTED, ['settlement-type-not-registered'], { fulfillment: String(fulfillment) });
    }
    if (primitive.primitive == null) {
      /* SERVICE_EXECUTION：本阶段没有可原子执行的结算原语（Action 层
         未接入），因此它必须在**预留之前**失败（§22/§54 fail early）。
         刻意不 reserve 之后再 release：那会白占一次 revision、一行预留
         与一次 change log，而"这件事还做不到"是一个**静态**事实。 */
      return denial(C.DENY_REASON.PURCHASE_NOT_SUPPORTED,
        ['service-settlement-requires-the-action-layer-and-is-not-implemented-in-this-phase'], {
        fulfillment: String(fulfillment),
        productKind: String(product.kind),
        settlementPrimitive: null,
        reservedNothing: true
      });
    }

    const tx = C.transactionTypeOfQuoteKind(String(quoteRow.quote_kind));
    if (!tx.ok) return denial(C.DENY_REASON.EFFECT_NOT_ALLOWED, tx.errors, { quoteKind: String(quoteRow.quote_kind) });
    const counterparty = purchaseCounterpartyOf(String(quoteRow.quote_kind));
    if (!counterparty.ok) return denial(C.DENY_REASON.ACCOUNT_NOT_ALLOWED, counterparty.errors);

    const currency = String(quoteRow.currency);
    const walletRow = findWalletRowBy({ ownerId: String(buyer.party.id), ownerType: String(buyer.party.type) }, currency);
    if (!walletRow) {
      return { ok: false, denied: false, reasonCode: null, errors: ['wallet-not-found'], hint: 'open a wallet for the buyer in the quote currency first' };
    }
    const walletId = String(walletRow.wallet_id);

    const now = clock();
    const expiresAt = normalizeExpiresAt(o.expiresAt);
    if (!expiresAt.ok) return { ok: false, denied: false, reasonCode: null, errors: expiresAt.errors };
    if (expiresAt.expiresAt <= now) {
      return denial(C.DENY_REASON.RESERVATION_EXPIRED, ['reserve-expires-at-is-not-in-the-future'],
        { expiresAt: expiresAt.expiresAt, now: now });
    }

    /* ── P22-7：授权那一面的**入参**（§10 的"P22-7 在 P22-6 入口前加
          authority gate"落点）─────────────────────────────────────────
       ★ 这里刻意**不**接受 `approvalMode`。"这笔购买是自主的还是被
       批准的"不是一个调用方可以声明的东西 —— 它由两份**证据**推导：
         · approvalId              ⇒ 模式 APPROVAL（而那张批准必须真的
                                      有效、且九个字段绑定这一笔）；
         · approvalBindingFingerprint ⇒ 模式 AUTO_ALLOW（而它必须重算一致，
                                      见 validateAutonomousApprovalInTx）。
       允许调用方自己写 mode 会让"我声称我是 AUTO_ALLOW"成为一条绕过批准
       的路。
       ★ 三者都不允许承载任何经济字段：金额 / recipient / 数量 / settlement
       仍然只从 quote 快照读。因此"批准一张 400 的报价、然后拿它去买一份
       500 的"在结构上不成立。 */
    const approvalIdInput = o.approvalId == null ? null : String(o.approvalId);
    if (approvalIdInput != null && !C.isEconomyId('APPROVAL', approvalIdInput)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-id-not-canonical'] };
    }
    const autonomyPolicyIdInput = o.autonomyPolicyId == null ? null : String(o.autonomyPolicyId);
    if (autonomyPolicyIdInput != null && !C.isEconomyId('BUDGET_POLICY', autonomyPolicyIdInput)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['autonomy-policy-id-not-canonical'] };
    }
    const approvalBindingFingerprintInput = o.approvalBindingFingerprint == null ? null : String(o.approvalBindingFingerprint);
    if (approvalBindingFingerprintInput != null && approvalBindingFingerprintInput.trim() === '') {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-fingerprint-must-not-be-empty'] };
    }
    /* ★ 两种证据**互斥**：一张批准与"自主放行"是互相排斥的两句话。
       同时给两个既不是"更安全"也不是"更宽松"，而是一次不能回答的声明 ——
       因此它被拒绝，而不是被某一方静默覆盖。 */
    if (approvalIdInput != null && approvalBindingFingerprintInput != null) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED,
        ['an-autonomous-fingerprint-and-an-approval-are-mutually-exclusive'], {
        approvalId: approvalIdInput, approvalBindingFingerprintProvided: true
      });
    }
    const approvalMode = approvalIdInput != null
      ? C.PURCHASE_APPROVAL_MODE.APPROVAL
      : (approvalBindingFingerprintInput != null ? C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW : null);
    const approvalIdColumn = approvalIdInput;
    const autonomyPolicyIdColumn = autonomyPolicyIdInput;
    /* ★ let 而不是 const：AUTO_ALLOW 模式下它会被**重算**出来的那个身份
       覆盖（两者已被证明逐字相同，但落库的应该是可独立重算的那一个）。 */
    let approvalBindingFingerprintColumn = approvalBindingFingerprintInput;
    if (approvalIdInput != null) {
      /* 一张批准只可能授权一笔**被冻结**的报价。这里先用 quoteId 做一次
         便宜的粗筛（不匹配就直接拒），九个字段的精确比对留在事务里。 */
      const approvalRow = db.prepare(SQL.selectApproval).get(approvalIdInput);
      if (!approvalRow) {
        return denial(C.DENY_REASON.APPROVAL_NOT_FOUND, ['approval-not-found'], { approvalId: approvalIdInput });
      }
      if (String(approvalRow.quote_id) !== quoteId) {
        return denial(C.DENY_REASON.APPROVAL_MISMATCH, ['this-approval-authorizes-a-different-quote'], {
          approvalId: approvalIdInput,
          approvalQuoteId: String(approvalRow.quote_id),
          purchaseQuoteId: quoteId,
          oneApprovalCannotBeMovedToAnotherPurchase: true
        });
      }
    }
    /* ★ AUTO_ALLOW 模式必须说得出**是哪条策略**放行的：§16 的第一问
       "为什么这笔购买没问用户"只有一个答案位置 ——
       purchases.autonomy_policy_id。缺了它 integrity check 会把这行判成
       "一次没有出处的自主购买"。 */
    if (approvalMode === C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW && autonomyPolicyIdColumn == null) {
      return denial(C.DENY_REASON.AUTONOMY_NOT_PERMITTED,
        ['an-autonomous-purchase-must-name-the-autonomy-policy-that-allowed-it'], {});
    }

    /* ── 指纹（**不含任何生成的 id**）────────────────────────────────── */
    const fingerprint = purchaseFingerprint(C.OPERATION_SCOPE.PURCHASE_PREPARE, {
      buyer: buyer.party,
      recipient: recipient.party,
      quoteId: quoteId,
      productId: String(quoteRow.product_id),
      currency: currency,
      amountMinor: C.serializeAmountMinor(quoteAmountMinor),
      units: units,
      reservationExpiresAt: Number(expiresAt.expiresAt),
      /* ★ 授权身份进指纹是刻意的：同一个 key 配一张**不同**的批准是两件事，
         而"我那次准备购入用的是哪张许可证"必须能被区分。 */
      approvalId: approvalIdColumn
    });

    /* ── 幂等闸门（在任何写之前，重放零成本、零副作用）──────────────── */
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.PURCHASE_PREPARE, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.PURCHASE_PREPARE, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    /* ── §7/§57：报价的状态与时间在这里先问一次（快速失败），事务里再问一次 */
    if (String(quoteRow.state) !== C.QUOTE_STATE.OPEN) {
      return denial(String(quoteRow.state) === C.QUOTE_STATE.CONSUMED ? C.DENY_REASON.QUOTE_MISMATCH : C.DENY_REASON.QUOTE_EXPIRED,
        ['quote-is-not-open'], { quoteState: String(quoteRow.state), quoteId: quoteId });
    }
    if (Number(quoteRow.expires_at) <= now) {
      return denial(C.DENY_REASON.QUOTE_EXPIRED, ['quote-is-past-its-expires-at'],
        { expiresAt: Number(quoteRow.expires_at), now: now, sweepRequired: true, expiredBeforePrepare: true });
    }

    /* ── 候选 id（来自注入的随机源，且形状受契约约束）────────────────── */
    const purchaseId = o.purchaseId != null ? String(o.purchaseId) : nextId(C.PURCHASE_ID_KIND);
    if (!C.isEconomyId(C.PURCHASE_ID_KIND, purchaseId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['purchase-id-not-canonical'] };
    }
    const operationId = nextId('OPERATION');
    const reservationId = nextId('RESERVATION');
    if (!C.isEconomyId('OPERATION', operationId) || !C.isEconomyId('RESERVATION', reservationId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['generated-id-not-canonical'] };
    }
    const ledgerTx = C.derivePurchaseLedgerTransactionId(purchaseId);
    if (!ledgerTx.ok) return { ok: false, denied: false, reasonCode: null, errors: ledgerTx.errors };

    const at = now;
    let committed = null;
    try {
      withTransaction(() => {
        /* ① 拿写锁之后**重新读**报价与商品：这是 §7 与 §51 的同一道闸门 */
        const q = db.prepare(SQL.selectQuote).get(quoteId);
        if (!q) throw refuse(null, ['quote-not-found']);
        const p = db.prepare(SQL.selectProduct).get(String(q.product_id));
        if (!p) throw refuse(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: String(q.product_id) });
        if (String(q.state) !== C.QUOTE_STATE.OPEN) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['quote-is-not-open'],
            { quoteState: String(q.state), quoteId: quoteId });
        }
        if (Number(q.expires_at) <= at) {
          throw refuse(C.DENY_REASON.QUOTE_EXPIRED, ['quote-is-past-its-expires-at'],
            { expiresAt: Number(q.expires_at), now: at, sweepRequired: true });
        }
        if (fromSqlAmount(q.amount_minor, 'quote-amount') !== quoteAmountMinor) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['quote-amount-changed-under-the-transaction']);
        }
        if (String(p.fulfillment) !== String(fulfillment)) {
          throw refuse(C.DENY_REASON.EFFECT_NOT_ALLOWED, ['product-fulfillment-changed-under-the-transaction']);
        }
        /* 商品在 prepare 与 settle 之间可以被停用/退役，但**报价的有效性
           不受影响**（P22-5 冻结结论）。因此这里刻意**不**检查
           product.status —— 一份在商品还 ACTIVE 时创建的报价，在商品
           RETIRED 之后依然可以被买到它那一刻表达的价格与交付。**

           注意这与 createProductQuote 的检查不矛盾：那条规则管的是
           "还能不能**创建**新报价"，这条管的是"已经存在的报价还能不能
           被用掉"。P22-5 的 F 组逐条冻结了这个区别。 */

        const rev = allocateRevision();

        /* ② Budget 评价 —— ★ 在**写锁里面**，与预留同一个事务（§10）。
              这让"检查规则"与"锁住钱"之间不存在窗口。ALLOW 之外的
              两种结局都在这里停下，且**一个字节都还没写**。 */
        const budget = budgetDecisionOf(String(buyer.party.id), currency, quoteAmountMinor, at);
        if (!budget.ok) throw refuse(budget.denial.reasonCode, budget.denial.errors, budget.denial);
        if (budget.decision.allowed !== true) {
          /* 早期实测踩到的一个真实缺陷：这里曾经写成
             `budgetRefusalOf(...).detail` —— 而 `denial()` 是把 extra
             **摊平**在顶层返回的（`{ok, denied, reasonCode, errors, ...extra}`），
             它没有 `detail` 字段。于是 `.detail` 恒为 undefined，`|| {}`
             把 outcome / spentToday / policyId 全部丢掉：拒绝仍然发生，
             但**为什么**被拒绝在返回里消失了。这不是一个"少几个字段"的
             小事 —— §48 要求的正是"仅通过 canonical facts 解释为什么
             这次没成"。因此这里直接用那个 denial 对象本身。 */
          throw refuse(budgetRefusalOf(budget, 'prepare').reasonCode,
            ['budget-does-not-allow-this-spend'], budgetRefusalOf(budget, 'prepare'));
        }
        faultPoint('after-purchase-budget');

        /* ── P22-7 ⑥ §10：授权 seam —— 在**写锁里**验证那张许可证 ────────
           ★ 位置是刻意的：它排在预算闸门**之后**。§11 说"Approval 不是预算
           豁免"，而把授权检查放在预算**之前**会让一张有效批准跳过预算 ——
           因为一旦通过授权就继续往下走了。反过来（预算在前、授权在后）
           则两句话同时成立：预算 DENY ⇒ 这里根本走不到；预算 ALLOW 但
           没有有效批准 ⇒ 在这里被拒，整个 prepare 回滚。
           ★ 它**不消费**批准（见 §27 的三条论证）：消费发生在结算事务里，
           于是"批准被消费 + 购买没成立"这种撕裂事实在结构上不可达。
           ★ 这里也做一致性复核：approvalMode 为 APPROVAL 而购买行上
           没有 approvalId 是不可能的（上面绑定了），但仍然显式断言一次，
           因为"一笔声称被批准的购买没有批准"是本阶段最严重的那类矛盾。 */
        if (approvalMode === C.PURCHASE_APPROVAL_MODE.APPROVAL) {
          if (approvalIdColumn == null) {
            throw refuse(C.DENY_REASON.APPROVAL_NOT_CONSUMED, ['an-approval-authorised-purchase-must-name-its-approval']);
          }
          /* ── APPROVAL 模式：九元组必须与那张批准逐项一致，然后把
             **重算**出来的身份落库。★ 为什么落库的是重算值而不是那条批准
             上抄下来的值：两者已被 validateApprovalForPreparationInTx 证明
             逐字相同，而"这条记录的可重算身份"必须来自这笔购买自己的事实
             —— 否则"同意指纹"会变成第二个事实源，而它的漂移只会在某一天
             被 integrity check 发现。 */
          const approvalBinding = {
            buyerId: partyKeyOf(buyer.party.type, buyer.party.id),
            recipientId: recipient.party == null ? null : partyKeyOf(recipient.party.type, recipient.party.id),
            productId: String(p.product_id),
            quoteId: quoteId,
            currency: currency,
            amountMinor: quoteAmountMinor,
            settlementType: String(fulfillment),
            grantQuantity: expectedQuantity.quantity,
            units: units
          };
          validateApprovalForPreparationInTx(approvalIdColumn, String(purchaseId), approvalBinding, at);
          const approvalFp = C.approvalFingerprint(approvalBinding);
          if (!approvalFp.ok) throw refuse(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, approvalFp.errors);
          approvalBindingFingerprintColumn = String(approvalFp.fingerprint);
        } else if (approvalMode === C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW) {
          /* AUTO_ALLOW 的授权面是**重算**出来的九元组身份（见 seam 的
             说明）：调用方提交的那个必须与这一笔完全一致。 */
          const recomputedBinding = {
            buyerId: partyKeyOf(buyer.party.type, buyer.party.id),
            recipientId: recipient.party == null ? null : partyKeyOf(recipient.party.type, recipient.party.id),
            productId: String(p.product_id),
            quoteId: quoteId,
            currency: currency,
            amountMinor: quoteAmountMinor,
            settlementType: String(fulfillment),
            grantQuantity: expectedQuantity.quantity,
            units: units
          };
          validateAutonomousApprovalInTx(autonomyPolicyIdColumn, approvalBindingFingerprintColumn, {
            buyerPartyId: String(buyer.party.id),
            buyerPartyType: String(buyer.party.type),
            binding: recomputedBinding
          });
          /* 把**重算**的那个身份落库（而不是调用方给的那个字面值）：
             两者已经被证明逐字相同，但落库的应该是可以被独立重算的那一个。 */
          const fp = C.approvalFingerprint(recomputedBinding);
          if (fp.ok) approvalBindingFingerprintColumn = String(fp.fingerprint);
        } else if (approvalMode !== null) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-approval-mode-not-in-closed-set']);
        }
        faultPoint('after-purchase-approval');

        /* ③ reservation（P22-3 的 canonical 形态，同一套列与状态机）────
              operation: CREATED → RESERVED；reservation: ACTIVE。
              缺省**不**开 enforceBudget：这一层刚刚在同一个锁里评估过，
              再评估一次只会读到同一个快照。P22-4 的开关语义一个字不改。 */
        db.prepare(SQL.insertOperation).run(
          String(operationId), C.TX_STATE.CREATED, walletId, currency,
          toSqlAmount(quoteAmountMinor, 'purchase-amount'), null, null,
          key.key, fingerprint, Number(expiresAt.expiresAt), null, Number(rev), Number(at), Number(at)
        );
        const preg = C.assertTransactionTransition(C.TX_STATE.CREATED, C.TX_STATE.RESERVED);
        if (!preg.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, preg.errors);
        const movedOp = db.prepare(SQL.setOperationStatus).run(
          C.TX_STATE.RESERVED, String(reservationId), null, null,
          Number(rev), Number(at), String(operationId), C.TX_STATE.CREATED
        );
        if (Number(movedOp.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['operation-transition-affected-no-row']);
        }
        const shape = C.validateReservation({
          reservationId: String(reservationId),
          operationId: String(operationId),
          walletId: walletId,
          currency: currency,
          amountMinor: quoteAmountMinor,
          idempotencyKey: key.key,
          status: C.RESERVATION_STATE.ACTIVE,
          expiresAt: Number(expiresAt.expiresAt)
        });
        if (!shape.ok) throw refuse(C.DENY_REASON.INVALID_AMOUNT, shape.errors);
        db.prepare(SQL.insertReservation).run(
          String(reservationId), String(operationId), walletId, currency,
          toSqlAmount(quoteAmountMinor, 'purchase-amount'), C.RESERVATION_STATE.ACTIVE,
          key.key, fingerprint, Number(expiresAt.expiresAt), null, null,
          Number(rev), Number(at), Number(at)
        );
        faultPoint('after-purchase-reservation');
        const sum = applyReservedCache(walletId, rev, at);

        /* ④ 余额与可用量在**预留之后**再确认一次。applyReservedCache 自己
              带有"Σ(ACTIVE) ≤ ledger 余额"的守卫，因此这一步的任何失败
              都会抛出并整体回滚 —— 于是"预留成功但钱不够"不可能留库。 */
        const availability = walletAvailability(db.prepare(SQL.selectWallet).get(walletId));
        if (!availability.ok) {
          throw refuse(C.DENY_REASON.WALLET_NOT_READY, ['wallet-integrity-failed'], { integrity: availability.problems });
        }

        /* ⑤ Purchase 行（RESERVED）。结算所需的最小快照写在这里 ────────
              四个"目标 id"（purchase / quote / reservation / ledger tx）
              都写下来，因此最终结算**不需要**再向调用方要任何东西。 */
        const purchaseShape = C.validatePurchase({
          purchaseId: String(purchaseId),
          buyer: buyer.party,
          recipient: recipient.party,
          quoteId: quoteId,
          reservationId: String(reservationId),
          productId: String(p.product_id),
          currency: currency,
          amountMinor: quoteAmountMinor,
          quoteKind: String(q.quote_kind),
          fulfillment: String(fulfillment),
          settledAssetKind: product.assetKind,
          settledQuantity: expectedQuantity.quantity,
          settledUnitName: product.unitName,
          status: C.PURCHASE_STATE.RESERVED,
          revision: Number(rev),
          createdAt: Number(at),
          updatedAt: Number(at)
        });
        if (!purchaseShape.ok) throw refuse(C.DENY_REASON.CATALOG_INPUT_NOT_STRUCTURED, purchaseShape.errors);

        /* ── 先做一次**结构化**的引用唯一性检查，再 INSERT ──────────────
           economy_purchases 上有两条 UNIQUE（quote_id 与 ledger_transaction_id），
           它们是"一份报价只能被一条购买指向"这条性质的结构性一半（§51）。
           但一个裸的 SQLite 约束异常（`UNIQUE constraint failed:
           economy_purchases.quote_id`）**不是**一次可解释的拒绝：它没有
           reasonCode、没有 detail，调用方拿到的是一个数据库错误，而不是
           "这份报价已经被另一次购买用掉了"。因此这里在检查之后再 INSERT
           （唯一索引是最后一道，不是唯一一道）—— 与 P22-5 的库存
           "quantity >= ? 守卫 + CHECK" 同时保留两道是同一种做法。 */
        const alreadyLinked = db.prepare(SQL.selectPurchaseByQuote).get(quoteId);
        if (alreadyLinked) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['this-quote-is-already-linked-to-a-purchase'], {
            quoteId: quoteId,
            existingPurchaseId: String(alreadyLinked.purchase_id),
            existingPurchaseStatus: String(alreadyLinked.status),
            oneQuoteToOneSuccessfulPurchase: true
          });
        }

        const consent = {
          quoteId: quoteId,
          quoteKind: String(q.quote_kind),
          settlementType: String(fulfillment),
          amountMinor: C.serializeAmountMinor(quoteAmountMinor),
          currency: currency,
          units: units,
          grantedQuantity: expectedQuantity.quantity,
          recipientId: recipient.party == null ? null : String(recipient.party.id),
          buyerId: String(buyer.party.id),
          capturedAt: Number(at)
        };

        db.prepare(SQL.insertPurchase).run(
          String(purchaseId), String(buyer.party.id), String(buyer.party.type),
          recipient.party == null ? null : String(recipient.party.id),
          recipient.party == null ? null : String(recipient.party.type),
          String(p.product_id), String(p.store_id),
          quoteId, String(reservationId),
          /* ★ ledger_transaction_id 在 RESERVED 期间必须是 **NULL** ——
             这里曾经传入派生出来的那个 id（因为它"反正要等于它"），
             而那让 `ledger_transaction_id IS NOT NULL` 不再等于
             "已结算"：一条**还没有花一分钱**的购买会看起来像"已经有一笔
             交易了"。实测症状是 getPurchase() 在 Prepare 之后返回一个
             非空的 ledgerTransactionId，而 settlement.spentAnything 仍是
             false —— 两个字段互相矛盾。列在结算语句里被填上，那才是它
             第一次成为事实的时刻。 */
          null,
          currency, toSqlAmount(quoteAmountMinor, 'purchase-amount'),
          String(q.quote_kind), String(fulfillment),
          product.assetKind == null ? null : String(product.assetKind),
          Number(expectedQuantity.quantity),
          product.unitName == null ? null : String(product.unitName),
          C.PURCHASE_STATE.RESERVED, null, null,
          C.RESERVATION_STATE.ACTIVE, Number(expiresAt.expiresAt), null,
          JSON.stringify(consent),
          /* ── P22-7：授权那一面的四列 ────────────────────────────────
             ★ 它们是**记录**，不是"结算时再推断一次"的输入：授权发生在
             闸门那一刻，而自主策略/批准状态之后都可能变。把这四个值冻在
             购买行上，于是"这笔购买当初凭什么成立"在结算时仍然可读。
             ★ approvalMode === null（调用方没走 P22-7 闸门）是合法的：
             P22-6 单独使用时购买没有任何授权层，而 NULL 逐字表示"这条记录
             没有授权模式"—— 把它兜成 AUTO_ALLOW 会伪造一条权限事实。 */
          approvalMode, approvalIdColumn, autonomyPolicyIdColumn, approvalBindingFingerprintColumn,
          Number(units),
          key.key, fingerprint, Number(rev), Number(at), Number(at), null
        );
        faultPoint('after-purchase-created');

        const purchaseRow = db.prepare(SQL.selectPurchase).get(String(purchaseId));
        if (!purchaseRow) throw refuse(null, ['purchase-row-missing-after-insert']);

        const result = {
          domain: C.DOMAIN,
          purchaseId: String(purchaseId),
          purchaseStatus: C.PURCHASE_STATE.RESERVED,
          buyerId: partyKeyOf(buyer.party.type, buyer.party.id),
          recipientId: recipient.party == null ? null : partyKeyOf(recipient.party.type, recipient.party.id),
          selfDirected: recipient.party == null,
          productId: String(p.product_id),
          storeId: String(p.store_id),
          quoteId: quoteId,
          quoteState: C.QUOTE_STATE.OPEN,
          productBacked: true,
          productProvenanceRelation: provenance,
          reservationId: String(reservationId),
          reservationState: C.RESERVATION_STATE.ACTIVE,
          reservationExpiresAt: Number(expiresAt.expiresAt),
          operationId: String(operationId),
          operationStatus: C.TX_STATE.RESERVED,
          walletId: walletId,
          currency: currency,
          amountMinor: C.serializeAmountMinor(quoteAmountMinor),
          quoteKind: String(q.quote_kind),
          settlementType: String(fulfillment),
          settlementPrimitive: primitive.primitive,
          assetKind: product.assetKind == null ? null : String(product.assetKind),
          grantedQuantity: expectedQuantity.quantity,
          unitName: product.unitName == null ? null : String(product.unitName),
          /* 预期的那笔 ledger 交易 id（它还没有发生）。写出来是为了让
             "这次购买最终会记在哪笔交易上"在 Prepare 之后就是可预测的，
             而**不是**为了假装它已经发生 —— ledger_transaction_id 列在
             RESERVED 期间仍然是 NULL。 */
          expectedLedgerTransactionId: ledgerTx.id,
          budget: {
            outcome: budget.decision.outcome,
            priority: budget.decision.priority,
            policyId: budget.policyId,
            spentTodayMinor: budget.decision.spentTodayMinor,
            spentThisWeekMinor: budget.decision.spentThisWeekMinor,
            spentThisMonthMinor: budget.decision.spentThisMonthMinor,
            availableBalanceMinor: budget.decision.availableBalanceMinor,
            /* ★ Prepare 的预算结论只是**解释性历史**，不是 capability
               （§33）。最终使用的永远是 settlement 事务里最新的事实。 */
            isACapability: false,
            revalidatedAtSettlement: true
          },
          /* ── P22-7：授权的那一面 ────────────────────────────────────
             ★ 四句逐字的自述（§8/§10）：
               · approvalConsumed = false —— prepare **不**消费批准；
               · isACapability = false —— 它不是一张可以传递的许可证；
               · budgetIsSeparatelyEvaluated —— 授权与预算各判一次。 */
          authorization: {
            mode: approvalMode,
            approvalId: approvalIdColumn,
            autonomyPolicyId: autonomyPolicyIdColumn,
            /* 授权模式为 null 表示这次购买**没有走** P22-7 闸门（P22-6 的
               直接用法）。逐字写出这句话，而不是让调用方从 null 猜。 */
            gatedByP22_7: approvalMode != null,
            approvalConsumed: false,
            approvalConsumedAtSettlement: approvalMode === C.PURCHASE_APPROVAL_MODE.APPROVAL,
            autonomous: approvalMode === C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW,
            requiredUserApproval: approvalMode === C.PURCHASE_APPROVAL_MODE.APPROVAL,
            /* Prepare 的授权结论同样只是**解释性历史**：许可证的真正校验
               与消费在结算事务里再各自做一次。 */
            isACapability: false,
            revalidatedAtSettlement: true,
            budgetIsSeparatelyEvaluated: true,
            approvalBypassesBudget: C.APPROVAL_BYPASSES_BUDGET
          },
          reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
          activeReservations: sum.activeCount,
          revision: Number(rev),
          at: Number(at),
          idempotencyKey: key.key,
          ledgerMutation: false,
          inventoryMutation: false,
          quoteConsumed: false
        };

        appendChange({
          revision: Number(rev), kind: C.EVENT_TYPE.PURCHASE_CREATED,
          entityId: String(purchaseId), transactionId: null, walletId: walletId, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            purchaseId: String(purchaseId),
            purchaseStatus: C.PURCHASE_STATE.RESERVED,
            buyerId: String(buyer.party.id),
            recipientId: recipient.party == null ? null : String(recipient.party.id),
            productId: String(p.product_id),
            storeId: String(p.store_id),
            quoteId: quoteId,
            reservationId: String(reservationId),
            currency: currency,
            amountMinor: C.serializeAmountMinor(quoteAmountMinor),
            settlementType: String(fulfillment),
            grantedQuantity: expectedQuantity.quantity,
            ledgerMutation: false,
            inventoryMutation: false,
            /* ★ 两条 Prepare 事件各写**两句**否认。为什么都要写全（而不是
               各写一句）：只写一半的 payload 会让"这条事件有没有声称发货"
               变成一个"字段存不存在"的问题，而 read 侧要么写
               `=== false`（对缺字段的事件为 false ⇒ 断言无声失败），
               要么写 `!== true`（对**任何**缺失都为 true ⇒ 断言永不失败）。
               两种写法都不会失败得**有意义**。写全之后，`=== false` 是
               一条真断言。 */
            grantedAnything: false,
            quoteConsumed: false
          }
        });
        /* ★ 第二条事件**自己分配**一个 revision。P22-3 的纪律是"每一次
           allocateRevision 恰好配一条 change 行"，而
           economy_change_log.revision 是**主键** —— 两条事件共用同一个
           数字会直接撞 UNIQUE 约束（开发期实测踩到，症状是一条
           `UNIQUE constraint failed: economy_change_log.revision`）。
           因此下面 result.revision 用的是**最后**那一个，而幂等行也用它：
           它描述的是"这次 prepare 结束在哪一个 revision 上"。 */
        const revReserved = allocateRevision();
        appendChange({
          revision: Number(revReserved), kind: C.EVENT_TYPE.PURCHASE_RESERVED,
          entityId: String(purchaseId), transactionId: null, walletId: walletId, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            purchaseId: String(purchaseId),
            purchaseStatus: C.PURCHASE_STATE.RESERVED,
            reservationId: String(reservationId),
            reservationState: C.RESERVATION_STATE.ACTIVE,
            quoteId: quoteId,
            quoteState: C.QUOTE_STATE.OPEN,
            amountMinor: C.serializeAmountMinor(quoteAmountMinor),
            reservedBalanceMinor: C.serializeAmountMinor(sum.reservedMinor),
            /* ★ 两句逐字的自述（§5/§6）：Prepare 不发货、也不消费报价。 */
            quoteConsumed: false,
            grantedAnything: false,
            ledgerMutation: false,
            inventoryMutation: false
          }
        });
        faultPoint('before-purchase-prepare-change-log');

        result.revision = Number(revReserved);
        writeOperationIdempotency(C.OPERATION_SCOPE.PURCHASE_PREPARE, key.key, fingerprint, {
          operationId: String(operationId), reservationId: String(reservationId), transactionId: null
        }, result, Number(revReserved), at);
        faultPoint('before-purchase-prepare-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger('economy-purchase-prepared', {
      purchaseId: committed.purchaseId,
      reservationId: committed.reservationId,
      quoteId: committed.quoteId,
      buyerId: committed.buyerId,
      currency: committed.currency,
      amountMinor: committed.amountMinor,
      revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ══════════════════════════════════════════════════════════════════
     §28 · releaseReservationInTx —— "把钱还回去"的事务内核

     它只是 P22-3 的 settleReservationInTx 在 (RELEASED, RELEASED) 上的
     一次固定调用。抽出来只有一个理由：cancelPurchase 与 settlePurchase
     的失败分支都需要**在同一个事务里**释放预留，而它们不该各自复制
     一遍 plan 的字面值 —— 一份 plan、一个 scope、一条 change log 类型。
     ══════════════════════════════════════════════════════════════════ */
  function releaseReservationInTx(reservationId, at, hooks) {
    return settleReservationInTx(reservationId, { reservationId: String(reservationId) }, {
      scope: C.OPERATION_SCOPE.RELEASE,
      reservationState: C.RESERVATION_STATE.RELEASED,
      operationState: C.TX_STATE.RELEASED,
      releaseReason: RELEASE_REASON.SYSTEM,
      reasonCode: null,
      changeKind: C.EVENT_TYPE.RESERVATION_RELEASED,
      faultPrefix: 'after-purchaserelease',
      logEvent: 'economy-reservation-released',
      /* ★ 刻意**不**写 RELEASE scope 的幂等行：
         · 幂等身份已经由 Purchase 那一侧持有（PURCHASE_SETTLE /
           PURCHASE_CANCEL 的 scope），一次重试会在那里就被识别为
           "回放"而根本走不到这里；
         · 而如果这里也写一行 RELEASE scope 的记录，就会出现两个
           "这次释放成没成"的答案，且其中一个的 key 是内部派生的 ——
           调用方永远问不到它。这正是 P22-3 §18 要避免的那种含糊。 */
      idempotency: null
    }, { at: at, fingerprint: null, enforce: hooks && hooks.enforce, preCommit: hooks && hooks.preCommit });
  }

  /* ══════════════════════════════════════════════════════════════════
     §28/§29/§32 · cancelPurchase（结算之前终止）

     它只对**未完成**的 Purchase 生效，效果恰好两件：
       release 活跃的 Reservation + Purchase 进入一个不可逆的终态。
     它**不**产生任何 Ledger refund（钱从来没有离开钱包，§28）。

     reasonCode 的映射（这是"为什么结束"的唯一答案）：
       quote 已过期                  → RESERVATION_EXPIRED + Quote → EXPIRED
       预留已过期                    → RESERVATION_EXPIRED
       结算时预算变成 REQUIRE_APPROVAL → PURCHASE_REQUIRES_APPROVAL
       其它结算时预算不允许            → 契约给出的那个 reasonCode
       显式取消                       → null（没有"原因"这个东西）
     ══════════════════════════════════════════════════════════════════ */
  function cancelPurchase(input) {
    requireOpen();
    const o = input || {};
    const purchaseId = o.purchaseId == null ? null : String(o.purchaseId);
    if (!C.isEconomyId(C.PURCHASE_ID_KIND, purchaseId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['purchase-id-not-canonical'] };
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };
    if (o.reasonCode != null && !C.isDenyReasonCode(o.reasonCode)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['reason-code-not-in-closed-set'] };
    }

    const row = db.prepare(SQL.selectPurchase).get(purchaseId);
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['purchase-not-found'] };

    const fingerprint = purchaseFingerprint(C.OPERATION_SCOPE.PURCHASE_CANCEL, {
      purchaseId: purchaseId,
      reasonCode: o.reasonCode == null ? null : String(o.reasonCode)
    });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.PURCHASE_CANCEL, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.PURCHASE_CANCEL, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    /* 幂等之后才是终态检查 —— 与 commit/release 同一条纪律：一次成功的
       取消，它的重放必须返回当初那个结果，而不是"已经终态"的拒绝。 */
    if (String(row.status) !== C.PURCHASE_STATE.RESERVED) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-is-already-terminal'],
        { purchaseStatus: String(row.status), reservationState: String(row.reservation_state) });
    }
    const gate = C.assertPurchaseTransition(C.PURCHASE_STATE.RESERVED, C.PURCHASE_STATE.RELEASED);
    if (!gate.ok) return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, gate.errors);

    const at = clock();
    const reasonCode = o.reasonCode == null ? null : String(o.reasonCode);
    let committed = null;
    try {
      withTransaction(() => {
        const locked = db.prepare(SQL.selectPurchase).get(purchaseId);
        if (!locked) throw refuse(null, ['purchase-not-found']);
        if (String(locked.status) !== C.PURCHASE_STATE.RESERVED) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-is-already-terminal'],
            { purchaseStatus: String(locked.status) });
        }
        const rev = allocateRevision();
        /* ① 释放预留（P22-3 的同一条内核；预留如果已经是终态，这一步会
              抛出 —— 那意味着另一个 writer 抢先动了它，整体回滚）。 */
        const res = releaseReservationInTx(String(locked.reservation_id), at, null);
        faultPoint('after-purchase-cancel-release');
        /* ② Purchase → RELEASED（与释放同一个事务） */
        const moved = db.prepare(SQL.setPurchaseTerminal).run(
          C.PURCHASE_STATE.RELEASED, RELEASE_REASON.SYSTEM, reasonCode,
          Number(rev), Number(at), purchaseId, C.PURCHASE_STATE.RESERVED
        );
        if (Number(moved.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-transition-affected-no-row']);
        }
        faultPoint('after-purchase-cancel-status');

        const result = {
          domain: C.DOMAIN,
          purchaseId: purchaseId,
          purchaseStatus: C.PURCHASE_STATE.RELEASED,
          buyerId: partyKeyOf(locked.buyer_type, locked.buyer_id),
          recipientId: locked.recipient_id == null ? null : partyKeyOf(locked.recipient_type, locked.recipient_id),
          quoteId: String(locked.quote_id),
          reservationId: String(locked.reservation_id),
          reservationState: C.RESERVATION_STATE.RELEASED,
          currency: String(locked.currency),
          amountMinor: C.serializeAmountMinor(fromSqlAmount(locked.amount_minor, 'purchase-amount')),
          reasonCode: reasonCode,
          releaseReason: RELEASE_REASON.SYSTEM,
          ledgerTransactionId: null,
          revision: Number(rev),
          at: Number(at),
          idempotencyKey: key.key,
          reservedBalanceMinor: res.reservedBalanceMinor,
          activeReservations: res.activeReservations,
          /* ── §28 的三句自述 ────────────────────────────────────────
             "钱还回去了"不等于"退了一笔款"：这次操作没有产生任何 ledger
             事实，因为钱从来没有离开过钱包。 */
          ledgerMutation: false,
          refundIssued: false,
          inventoryGranted: false,
          quoteConsumed: false,
          /* §58：Purchase 的取消 ≠ Quote 的取消。一份报价是否仍然可用
             只由它自己的 state 与 expiresAt 决定。 */
          quoteState: 'unchanged-by-this-operation'
        };

        appendChange({
          revision: Number(rev), kind: C.EVENT_TYPE.PURCHASE_RELEASED,
          entityId: purchaseId, transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            purchaseId: purchaseId,
            purchaseStatus: C.PURCHASE_STATE.RELEASED,
            reservationId: String(locked.reservation_id),
            reservationState: C.RESERVATION_STATE.RELEASED,
            quoteId: String(locked.quote_id),
            currency: String(locked.currency),
            amountMinor: C.serializeAmountMinor(fromSqlAmount(locked.amount_minor, 'purchase-amount')),
            reasonCode: reasonCode,
            ledgerMutation: false,
            refundIssued: false,
            inventoryGranted: false,
            quoteConsumed: false
          }
        });
        faultPoint('before-purchase-cancel-change-log');
        writeOperationIdempotency(C.OPERATION_SCOPE.PURCHASE_CANCEL, key.key, fingerprint, {
          operationId: null, reservationId: String(locked.reservation_id), transactionId: null
        }, result, rev, at);
        faultPoint('before-purchase-cancel-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    pruneOperationIdempotency(at);
    logger('economy-purchase-released', {
      purchaseId: committed.purchaseId,
      reservationId: committed.reservationId,
      reasonCode: committed.reasonCode,
      revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ══════════════════════════════════════════════════════════════════
     §14 · settlePurchase —— 本阶段的核心

     ★ 它恰好是**一个** SQLite 事务。事务里的顺序是刻意的，而且每一步
     都被 J/K 组的故障注入点钉住：

       BEGIN IMMEDIATE
         re-read Purchase / Quote / Reservation / Wallet
         revalidate（状态、时间、四元组一致性、商品不可变的交付形态）
         Quote/预留已过期？            → 释放预留 + Purchase FAILED（同一事务）
         evaluateBudgetInTx（**最新**规则，§30/§31/§33）
           不允许                       → 释放预留 + Purchase FAILED/RELEASED
         commitReservationInTx（预留 → COMMITTED；ledger transaction + entries）
         buildPurchaseEntries（金额只来自 reservation 行）
         commitLedgerTransactionInTx（同一个事务体，不是第二次提交）
         Quote OPEN → CONSUMED
         结算原语（INVENTORY → mutateInventoryInTx；COMPUTE → 同一条，
                    因为 assetKind 决定了那是"额度"还是"物品"）
         Purchase RESERVED → COMPLETED（completedAt 与 commit 同事务）
         change log + 幂等行
       COMMIT

     为什么"预留先离开 ACTIVE"必须排在 ledger 之前：见 commitReservation
     的说明（P22-2 的 applyDerivedBalances 守卫）。settlePurchase 沿用
     **同一个**事务体，因此那条性质不是"这里也记得这样做"，而是"这里
     调用的是同一份实现"。

     失败的两种形态刻意分开：
       · **瞬时**失败（余额不够、账本拒绝、注入的故障）→ 整个事务回滚，
         Purchase 仍然 RESERVED，预留仍然 ACTIVE，可以用**另一个**幂等键
         重试（§49）。绝不留下半完成状态。
       · **确定性**失败（报价/预留已过期、预算不允许、结算形态不支持）
         → 在同一个事务里"释放 + 终结"，返回一个具名拒绝。
         §11/§32：REQUIRE_APPROVAL **不伪装**成 FAILED —— 它进入
         RELEASED（"流程被放弃"）而不是 FAILED（"试过了、不成立"）。
     ══════════════════════════════════════════════════════════════════ */
  function settlePurchase(input) {
    requireOpen();
    const o = input || {};
    const purchaseId = o.purchaseId == null ? null : String(o.purchaseId);
    if (!C.isEconomyId(C.PURCHASE_ID_KIND, purchaseId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['purchase-id-not-canonical'] };
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };
    const now = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(now) || now < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }

    const row = db.prepare(SQL.selectPurchase).get(purchaseId);
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['purchase-not-found'] };

    /* ── §40：指纹里**只有** purchaseId ────────────────────────────────
       不是"我们决定不收金额"，而是**入参名单里根本没有金额**
       （C.PURCHASE_SETTLE_INPUT_KEYS 恰好三个键）。于是"settle 时改价"
       这句话在结构上不成立 —— 没有字段可以承载它。 */
    const fingerprint = purchaseFingerprint(C.OPERATION_SCOPE.PURCHASE_SETTLE, { purchaseId: purchaseId });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.PURCHASE_SETTLE, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.PURCHASE_SETTLE, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    if (String(row.status) !== C.PURCHASE_STATE.RESERVED) {
      /* 已经完成的购买被再次 settle：回一个**终态冲突**而不是假装成功。
         注意它不会是"第二次扣款"—— 见 §37 的结构性证明。
         ★ `terminal: true` 是刻意的：调用方必须能一眼区分"这次请求不成立、
         你可以改一改再来"与"这件事已经定局、不要再试了"。 */
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-is-already-terminal'],
        {
          terminal: true,
          purchaseStatus: String(row.status),
          completedAt: row.completed_at == null ? null : Number(row.completed_at)
        });
    }
    const gate = C.assertPurchaseTransition(C.PURCHASE_STATE.RESERVED, C.PURCHASE_STATE.COMPLETED);
    if (!gate.ok) return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, gate.errors);

    const at = now;
    let committed = null;
    try {
      withTransaction(() => {
        /* ── ① re-read 四个 canonical 事实 ──────────────────────────── */
        const purchase = db.prepare(SQL.selectPurchase).get(purchaseId);
        if (!purchase) throw refuse(null, ['purchase-not-found']);
        if (String(purchase.status) !== C.PURCHASE_STATE.RESERVED) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-is-already-terminal'],
            { purchaseStatus: String(purchase.status) });
        }
        const quote = db.prepare(SQL.selectQuote).get(String(purchase.quote_id));
        if (!quote) throw refuse(null, ['quote-not-found']);
        const reservation = db.prepare(SQL.selectReservation).get(String(purchase.reservation_id));
        if (!reservation) throw refuse(null, ['reservation-not-found']);
        const wallet = db.prepare(SQL.selectWallet).get(String(reservation.wallet_id));
        if (!wallet) throw refuse(null, ['wallet-not-found']);

        /* ── ② §7：Product-backed 与四元组一致性（**每个可变属性**）────
           settle 请求里没有这些字段，因此"它们不一致"只可能来自一次
           被篡改或被外部工具改过的库 —— 那必须 fail closed。 */
        const productRow = db.prepare(SQL.selectProduct).get(String(purchase.product_id));
        if (!productRow) {
          throw refuse(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: String(purchase.product_id) });
        }
        const product = rowToProduct(productRow);
        if (String(purchase.quote_id) !== String(quote.quote_id) ||
          String(purchase.product_id) !== String(quote.product_id)) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['purchase-does-not-point-at-the-quote-it-was-created-with']);
        }
        /* 交付形态必须与 purchase 冻结的那一个一致。fulfillment 是
           Product 的**不可变**本体列（P22-5），因此这一条同时也是
           "没有人偷偷换了这件商品的结算方式"。 */
        if (String(product.fulfillment) !== String(purchase.settlement_type)) {
          throw refuse(C.DENY_REASON.EFFECT_NOT_ALLOWED,
            ['product-fulfillment-does-not-match-the-frozen-purchase-settlement-type'],
            { purchaseSettlementType: String(purchase.settlement_type), productFulfillment: String(product.fulfillment) });
        }
        const quoteKind = String(quote.quote_kind);
        if (String(purchase.quote_kind) !== quoteKind) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['purchase-quote-kind-does-not-match-the-quote']);
        }
        /* settlement_type == "我把这份报价当作哪一种结算"。
           契约里 QUOTE_SETTLEMENT_TYPE 把三个 quote kind 各自映到自己，
           因此这个等式的成立是 P22-4 冻结表的结果，不是本阶段的约定。 */
        if (String(quote.service_role) !== quoteKind) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['quote-service-role-does-not-match-its-quote-kind'],
            { quoteKind: quoteKind, serviceRole: String(quote.service_role) });
        }
        if (String(purchase.currency) !== String(quote.currency) || String(purchase.currency) !== String(reservation.currency)) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['purchase-currency-does-not-match-the-quote-snapshot'],
            { purchaseCurrency: String(purchase.currency), quoteCurrency: String(quote.currency) });
        }
        const purchaseAmount = fromSqlAmount(purchase.amount_minor, 'purchase-amount');
        const reservationAmount = fromSqlAmount(reservation.amount_minor, 'reservation-amount');
        if (purchaseAmount !== reservationAmount) {
          throw refuse(C.DENY_REASON.INVALID_AMOUNT, ['purchase-amount-must-equal-the-reserved-amount'],
            { purchaseAmountMinor: C.serializeAmountMinor(purchaseAmount), reservationAmountMinor: C.serializeAmountMinor(reservationAmount) });
        }
        /* 收件人 / 购买人：请求里根本没有这两个字段（§39），因此这里比的是
           **两行持久化事实** —— purchase 与 quote。 */
        if (String(purchase.buyer_id) !== String(quote.buyer_id) || String(purchase.buyer_type) !== String(quote.buyer_type)) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['purchase-buyer-does-not-match-the-quote-buyer']);
        }
        const quoteRecipientId = quote.recipient_id == null ? null : String(quote.recipient_id);
        const purchaseRecipientId = purchase.recipient_id == null ? null : String(purchase.recipient_id);
        if (quoteRecipientId !== purchaseRecipientId) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['purchase-recipient-does-not-match-the-quote-recipient']);
        }
        /* 结算原语 + 账户白名单：未知一律 fail closed，且必须在 Ledger
           commit **之前**（§73）。 */
        const primitive = C.settlementPrimitiveOfFulfillment(String(purchase.settlement_type));
        if (!primitive.ok || primitive.primitive == null) {
          throw refuse(C.DENY_REASON.PURCHASE_NOT_SUPPORTED,
            ['this-settlement-type-has-no-atomic-primitive'], { settlementType: String(purchase.settlement_type) });
        }
        const tx = C.transactionTypeOfQuoteKind(quoteKind);
        if (!tx.ok) throw refuse(C.DENY_REASON.EFFECT_NOT_ALLOWED, tx.errors);
        const counterparty = purchaseCounterpartyOf(quoteKind);
        if (!counterparty.ok) throw refuse(C.DENY_REASON.ACCOUNT_NOT_ALLOWED, counterparty.errors);

        /* 结算目标：selfDirected ⇒ 买家自己收货；否则是报价上的收件人。 */
        const targetId = purchaseRecipientId == null ? String(purchase.buyer_id) : purchaseRecipientId;
        const targetType = purchaseRecipientId == null ? String(purchase.buyer_type) : String(purchase.recipient_type);
        const target = partyInput(C.makePartyRef(targetType, targetId).party);
        if (!target.ok) throw refuse(C.DENY_REASON.PARTY_NOT_ALLOWED, target.errors);

        const expiresAtMs = Number(quote.expires_at);
        const reservationExpiresAt = reservation.expires_at == null ? null : Number(reservation.expires_at);

        /* ── ③ §29/§57：报价与预留在**结算这一刻**都必须仍然有效 ────────
           "12:04 reserve 时有效"不是"12:06 可以按过期报价扣钱"的理由。
           已经过期时**先终结再拒绝**：释放预留 + Purchase FAILED，
           两者与"没有花钱、没有发货"处在同一个事务里。 */
        const quoteExpired = expiresAtMs <= at;
        const reservationExpired = reservationExpiresAt != null && reservationExpiresAt <= at;
        if (quoteExpired || reservationExpired) {
          const revRelease = allocateRevision();
          releaseReservationInTx(String(purchase.reservation_id), at, null);
          const rev = allocateRevision();
          const moved = db.prepare(SQL.setPurchaseTerminal).run(
            C.PURCHASE_STATE.FAILED, RELEASE_REASON.EXPIRED, C.DENY_REASON.RESERVATION_EXPIRED,
            Number(rev), Number(at), purchaseId, C.PURCHASE_STATE.RESERVED
          );
          if (Number(moved.changes) !== 1) {
            throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-transition-affected-no-row']);
          }
          /* 报价进入 EXPIRED 是它**自己的**状态机（P22-4 canonical 语义），
             而"谁把它变成 EXPIRED 的"在这里只有一个答案。 */
          let quoteMoved = null;
          if (quoteExpired && String(quote.state) === C.QUOTE_STATE.OPEN) {
            const qGate = C.assertQuoteTransition(C.QUOTE_STATE.OPEN, C.QUOTE_STATE.EXPIRED);
            if (!qGate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, qGate.errors);
            quoteMoved = Number(db.prepare(SQL.setQuoteState).run(
              C.QUOTE_STATE.EXPIRED, Number(rev), Number(at), String(purchase.quote_id), C.QUOTE_STATE.OPEN
            ).changes) === 1;
            if (quoteMoved) {
              /* ★ QUOTE_EXPIRED 与 PURCHASE_FAILED 是**两条** change 行，
                 因此各自需要**自己**的 revision（economy_change_log.revision
                 是主键）。开发期实测踩到：两条共用 `rev` 会撞 UNIQUE 约束，
                 而症状是"报价过期的整条路径抛错"。 */
              const revQuote = allocateRevision();
              appendChange({
                revision: Number(revQuote), kind: C.EVENT_TYPE.QUOTE_EXPIRED,
                entityId: String(purchase.quote_id), transactionId: null, walletId: null, at: Number(at),
                payload: {
                  domain: C.DOMAIN, quoteId: String(purchase.quote_id), quoteState: C.QUOTE_STATE.EXPIRED,
                  expiredAtSettlement: true, purchaseId: purchaseId,
                  ledgerMutation: false, inventoryMutation: false
                }
              });
            }
          }
          appendChange({
            revision: Number(rev), kind: C.EVENT_TYPE.PURCHASE_FAILED,
            entityId: purchaseId, transactionId: null, walletId: String(reservation.wallet_id), at: Number(at),
            payload: {
              domain: C.DOMAIN,
              purchaseId: purchaseId,
              purchaseStatus: C.PURCHASE_STATE.FAILED,
              reservationId: String(purchase.reservation_id),
              reservationState: C.RESERVATION_STATE.RELEASED,
              quoteId: String(purchase.quote_id),
              quoteState: quoteMoved ? C.QUOTE_STATE.EXPIRED : String(quote.state),
              reasonCode: C.DENY_REASON.RESERVATION_EXPIRED,
              quoteExpiredAtSettlement: quoteExpired,
              reservationExpiredAtSettlement: reservationExpired,
              ledgerMutation: false,
              refundIssued: false,
              inventoryGranted: false
            }
          });
          faultPoint('before-purchase-settle-commit');
          committed = {
            ok: false, denied: true, terminal: true,
            reasonCode: C.DENY_REASON.RESERVATION_EXPIRED,
            errors: [quoteExpired ? 'quote-is-past-its-expires-at' : 'reservation-is-past-its-expires-at'],
            /* ★ 终局的两个状态写在**顶层**（detail 里也留一份给"完整原因"）：
               `x.purchaseStatus` 是调用方读这个结果时第一件想做的事，而
               把它埋在 detail 里会让每一个调用点都要先知道这个方法的形状
               约定。形状一致比字段最少更重要。 */
            purchaseStatus: C.PURCHASE_STATE.FAILED,
            reservationState: C.RESERVATION_STATE.RELEASED,
            quoteState: quoteMoved ? C.QUOTE_STATE.EXPIRED : String(quote.state),
            ledgerMutation: false,
            inventoryMutation: false,
            refundIssued: false,
            detail: {
              purchaseId: purchaseId,
              purchaseStatus: C.PURCHASE_STATE.FAILED,
              reservationState: C.RESERVATION_STATE.RELEASED,
              quoteState: quoteMoved ? C.QUOTE_STATE.EXPIRED : String(quote.state),
              quoteExpiresAt: expiresAtMs,
              reservationExpiresAt: reservationExpiresAt,
              now: at,
              ledgerMutation: false,
              inventoryMutation: false
            }
          };
          return;
        }

        /* ── ④ §30/§31/§33：Budget **最终**再评估（在写锁里，用最新事实）──
           T1 prepare ALLOW + reserve；T2 另一笔购买落定；T3 settle A。
           此时日/周/月窗口已经变了。预留保证的是"这笔钱不会被别的预留
           花掉"，它**不**保证预算没有被别的已提交交易用掉。因此最终结算
           必须同时满足"预留仍然有效"与"预算仍然允许"。 */
        const budget = budgetDecisionOf(String(purchase.buyer_id), String(purchase.currency), purchaseAmount, at);
        if (!budget.ok) {
          const rev = allocateRevision();
          releaseReservationInTx(String(purchase.reservation_id), at, null);
          const moved = db.prepare(SQL.setPurchaseTerminal).run(
            C.PURCHASE_STATE.FAILED, RELEASE_REASON.SYSTEM, budget.denial.reasonCode,
            Number(rev), Number(at), purchaseId, C.PURCHASE_STATE.RESERVED
          );
          if (Number(moved.changes) !== 1) {
            throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-transition-affected-no-row']);
          }
          appendChange({
            revision: Number(rev), kind: C.EVENT_TYPE.PURCHASE_FAILED,
            entityId: purchaseId, transactionId: null, walletId: String(reservation.wallet_id), at: Number(at),
            payload: {
              domain: C.DOMAIN, purchaseId: purchaseId, purchaseStatus: C.PURCHASE_STATE.FAILED,
              reservationId: String(purchase.reservation_id), reservationState: C.RESERVATION_STATE.RELEASED,
              reasonCode: budget.denial.reasonCode, budgetOutcome: null, budgetSystemFailure: true,
              ledgerMutation: false, refundIssued: false, inventoryGranted: false
            }
          });
          faultPoint('before-purchase-settle-commit');
          committed = {
            ok: false, denied: true, terminal: true,
            reasonCode: budget.denial.reasonCode, errors: budget.denial.errors, detail: budget.denial.detail || {}
          };
          return;
        }
        if (budget.decision.allowed !== true) {
          /* ★ REQUIRE_APPROVAL 走 RELEASED 而不是 FAILED（§11/§32）：
             请求本身是合法的，只是规则要人点头 —— 而本阶段没有人能点头。
             于是"流程被放弃"是准确的描述，"不成立"不是。 */
          /* ★ 词表判错会**静默**走错分支，这是一个真实缺陷（开发期实测）：
             这里曾经写 `budget.decision.outcome === C.APPROVAL.USER_APPROVAL_REQUIRED`，
             而预算决策的 outcome 来自 **P22-4 的 BUDGET_DECISION**
             （ALLOW / DENY / REQUIRE_APPROVAL），不是 P22-1 §4 的 APPROVAL
             （AUTO_APPROVED / USER_APPROVAL_REQUIRED / DENIED）。两个词表
             没有一个成员相同，因此那个比较恒为 false：需要批准的购买被
             记成了 **FAILED**（"试过了、不成立"）而不是 RELEASED
             （"流程被放弃"）—— 而 §11/§32 要求区分这两件事。 */
          const needsApproval = budget.decision.outcome === C.BUDGET_DECISION.REQUIRE_APPROVAL;
          const terminalState = needsApproval ? C.PURCHASE_STATE.RELEASED : C.PURCHASE_STATE.FAILED;
          const reasonCode = needsApproval ? C.DENY_REASON.PURCHASE_REQUIRES_APPROVAL : budget.decision.reasonCode;
          const rev = allocateRevision();
          releaseReservationInTx(String(purchase.reservation_id), at, null);
          const moved = db.prepare(SQL.setPurchaseTerminal).run(
            terminalState, RELEASE_REASON.SYSTEM, reasonCode,
            Number(rev), Number(at), purchaseId, C.PURCHASE_STATE.RESERVED
          );
          if (Number(moved.changes) !== 1) {
            throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-transition-affected-no-row']);
          }
          appendChange({
            revision: Number(rev),
            kind: needsApproval ? C.EVENT_TYPE.PURCHASE_RELEASED : C.EVENT_TYPE.PURCHASE_FAILED,
            entityId: purchaseId, transactionId: null, walletId: String(reservation.wallet_id), at: Number(at),
            payload: {
              domain: C.DOMAIN, purchaseId: purchaseId, purchaseStatus: terminalState,
              reservationId: String(purchase.reservation_id), reservationState: C.RESERVATION_STATE.RELEASED,
              reasonCode: reasonCode, budgetOutcome: budget.decision.outcome,
              /* 逐字：本阶段**没有**创建任何待批准记录（§11）。 */
              pendingApprovalRecordCreated: false,
              ledgerMutation: false, refundIssued: false, inventoryGranted: false
            }
          });
          faultPoint('before-purchase-settle-commit');
          committed = {
            ok: false, denied: true, terminal: true,
            reasonCode: reasonCode,
            errors: ['budget-does-not-allow-this-spend'],
            purchaseStatus: terminalState,
            reservationState: C.RESERVATION_STATE.RELEASED,
            ledgerMutation: false,
            inventoryMutation: false,
            quoteConsumed: false,
            refundIssued: false,
            pendingApprovalRecordCreated: false,
            detail: {
              outcome: budget.decision.outcome,
              priority: budget.decision.priority,
              policyId: budget.policyId,
              spentTodayMinor: budget.decision.spentTodayMinor,
              spentThisWeekMinor: budget.decision.spentThisWeekMinor,
              spentThisMonthMinor: budget.decision.spentThisMonthMinor,
              availableBalanceMinor: budget.decision.availableBalanceMinor,
              purchaseStatus: terminalState,
              reservationState: C.RESERVATION_STATE.RELEASED,
              pendingApprovalRecordCreated: false
            }
          };
          return;
        }
        faultPoint('after-purchase-settle-budget');

        /* ── P22-7 ④b §8/§10/§11：消费那条批准（**与结算同一个事务**）────
           ★ 位置是刻意的：它排在预算最终复核**之后**、ledger commit **之前**。
           三句话因此同时成立：
             · 预算 DENY ⇒ 上面已经 return，批准**原封不动**（§11：批准
               绝不是预算豁免）；
             · 批准在这里消费 ⇒ 它和"钱真的动了"在同一个原子单位里，
               因此"批准已消费但购买没成立"不可达（§10）；
             · 下面的任何一步抛错 ⇒ 整个事务回滚 ⇒ 批准回到 APPROVED，
               可以安全重试（而不是被烧掉）。
           ★ 只对 approval_mode='APPROVAL' 的购买执行。NULL（P22-7
           之前的历史行）与 'AUTO_ALLOW'（自主放行，没有许可证可消费）
           两者都不消费任何东西 —— 前者尤其重要：**不能**为一条旧行凭空
           找回一张批准。 */
        let approvalConsumption = null;
        const purchaseApprovalMode = purchase.approval_mode == null ? null : String(purchase.approval_mode);
        if (purchaseApprovalMode === C.PURCHASE_APPROVAL_MODE.APPROVAL) {
          if (purchase.approval_id == null) {
            /* 一笔声称被批准、却没有任何批准的购买是结构性矛盾 —— fail
               closed，且**在 ledger commit 之前**。 */
            throw refuse(C.DENY_REASON.APPROVAL_NOT_CONSUMED,
              ['an-approval-authorised-purchase-carries-no-approval-id'], {
              purchaseId: purchaseId, approvalMode: purchaseApprovalMode
            });
          }
          approvalConsumption = consumeApprovalForPurchaseInTx(String(purchase.approval_id), purchase, quote, at);
          faultPoint('after-approval-consumed');
        } else if (purchaseApprovalMode != null && purchaseApprovalMode !== C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW) {
          /* 一个不在封闭集合里的授权模式：有人在库里写了第三个词。 */
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-approval-mode-not-in-closed-set'], {
            purchaseId: purchaseId, approvalMode: purchaseApprovalMode
          });
        }

        /* ── ⑤ 预留 → COMMITTED，并写入 ledger transaction + entries ────
           走的是 P22-3 的**同一个**事务体内核。它内部按顺序做：
             reservation → COMMITTED、reserved 缓存 ← Σ(ACTIVE)、
             commitLedgerTransactionInTx(...)、operation → COMMITTED。
           任何一步抛错 → 整个结算回滚（预留在库外仍然是 ACTIVE）。 */
        const entryShape = buildPurchaseEntries(wallet, reservation, counterparty.accountId);
        if (!entryShape.ok) throw refuse(C.DENY_REASON.LEDGER_UNBALANCED, entryShape.errors);
        const ledgerFingerprint = transactionFingerprint({
          type: tx.type,
          actor: C.makePartyRef(String(purchase.buyer_type), String(purchase.buyer_id)).party,
          ownerId: String(purchase.buyer_id),
          recipientId: purchaseRecipientId
        }, entryShape.entries);

        /* ★ 交易 id **在结算这一刻派生**，不从 purchase 行读。
           原因是一个真实缺陷（开发期实测）：purchase 行上的
           ledger_transaction_id 在 RESERVED 期间**必须是 NULL**（见
           insertPurchase 那里的说明），因此在结算时读它会拿到 null，
           而 commitReservationInTx 会以 `transaction-id-not-canonical`
           拒绝 —— 一次永远无法完成的结算。派生值本身是确定的
           （C.derivePurchaseLedgerTransactionId 只依赖 purchaseId），
           因此"读"与"派生"必须得到同一个答案，而派生是唯一在两种状态下
           都成立的那一个。 */
        const settleTxId = C.derivePurchaseLedgerTransactionId(String(purchaseId));
        if (!settleTxId.ok) throw refuse(null, settleTxId.errors);

        const settlementCommit = commitReservationInTx(String(purchase.reservation_id), at, ledgerFingerprint, o, {
          type: tx.type,
          counterparty: counterparty.accountId,
          transactionId: settleTxId.id,
          actor: C.makePartyRef(String(purchase.buyer_type), String(purchase.buyer_id)).party,
          entries: entryShape.entries,
          /* ★ 幂等身份**只由 settlePurchase 写一次**（见函数末尾）。
             commitReservationInTx 的 (scope, key) 写入在这里被关掉，理由是
             一个具体的事实：operation_idempotency 的主键是
             (scope, idempotency_key)，而 P22-4 给 INSERT 加了
             `ON CONFLICT DO NOTHING`（"幂等记录是第一次执行的证据，
             后来的重试没有权力覆盖它"）。
             两条写入用同一个 (scope, key) 时，第二条会被**静默丢弃** ——
             于是重放 settle 会拿到 commit 那一层的 result，而不是这次
             购买的 result。开发期实测踩到：`settlePurchase` 的重放返回
             `{ok:false}`（因为 commit 的 result 里没有 purchase 的那几个
             字段）。一次写入、一个结果，才是幂等该有的样子。 */
          idempotencyScope: null,
          idempotencyKey: null,
          ledgerIdempotencyKey: 'econ.purchase+' + String(purchaseId) + '+ledger',
          callIdempotencyKey: key.key,
          expectedAmountMinor: purchaseAmount
        });
        faultPoint('after-purchase-ledger');

        /* ── ⑥ Quote → CONSUMED（OPEN → CONSUMED 是它唯一的一条出边）──── */
        if (String(quote.state) !== C.QUOTE_STATE.OPEN) {
          throw refuse(String(quote.state) === C.QUOTE_STATE.CONSUMED ? C.DENY_REASON.QUOTE_MISMATCH : C.DENY_REASON.QUOTE_EXPIRED,
            ['quote-is-not-open-at-settlement'], { quoteState: String(quote.state) });
        }
        const qGate = C.assertQuoteTransition(C.QUOTE_STATE.OPEN, C.QUOTE_STATE.CONSUMED);
        if (!qGate.ok) throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, qGate.errors);
        const consumed = db.prepare(SQL.setQuoteState).run(
          C.QUOTE_STATE.CONSUMED, Number(settlementCommit.revision), Number(at),
          String(purchase.quote_id), C.QUOTE_STATE.OPEN
        );
        if (Number(consumed.changes) !== 1) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['quote-consumption-affected-no-row']);
        }
        /* ── ★ 一次成功结算必须留下 QUOTE_CONSUMED ────────────────────────
           这里曾经**只**改状态、不写事件（因为"ledger 那一条已经记过这笔
           交易了"）—— 那是一个真实缺陷：P22-4 的事件词表里早就冻结了
           QUOTE_CONSUMED，而审计要回答的是"这份报价**为什么**不再 OPEN"。
           ledger 记的是钱，报价状态记的是命题被用掉；两件事各有一条事件，
           合并会让"报价被消费"在 change log 里变得不可见。 */
        const revQuoteConsumed = allocateRevision();
        appendChange({
          revision: Number(revQuoteConsumed), kind: C.EVENT_TYPE.QUOTE_CONSUMED,
          entityId: String(purchase.quote_id), transactionId: String(settlementCommit.transactionId),
          walletId: String(settlementCommit.walletId), at: Number(at),
          payload: {
            domain: C.DOMAIN,
            quoteId: String(purchase.quote_id),
            quoteState: C.QUOTE_STATE.CONSUMED,
            purchaseId: purchaseId,
            transactionId: String(settlementCommit.transactionId),
            consumedByASinglePurchase: true,
            ledgerMutation: true,
            inventoryMutation: false
          }
        });
        faultPoint('after-purchase-quote-consumed');

        /* ── ⑦ 结算原语（§19/§20/§21/§22）──────────────────────────────
           INVENTORY 与 COMPUTE_ENTITLEMENT **走的是同一条**原语：P22-5
           已经用 economy_inventory 表达"已发生的拥有事实"，而 compute
           额度的 assetKind 是 COMPUTE —— 于是"1000 computeUnit 的额度"
           与"1 件物品"是同一种东西的两种单位。
           刻意**不**新建 providerQuota / apiBalance / tokenBalance：
           §21 明确禁止，而 computeUnit 是 P22-1 冻结的单位名。 */
        const grantQuantity = Number(purchase.granted_quantity);
        let settlementGrant = null;
        if (grantQuantity > 0) {
          const invCtx = {
            owner: target,
            productRow: productRow,
            productId: String(purchase.product_id),
            key: 'econ.purchase+' + String(purchaseId) + '+inventory',
            fingerprint: fingerprint,
            at: at,
            /* 幂等身份由 Purchase 持有（见 releaseReservationInTx 的同一条
               说明）：这里刻意**不**写第二行 inventory scope 的幂等记录，
               否则"这次发放成没成"会有两个答案。 */
            idempotency: null
          };
          settlementGrant = mutateInventoryInTx('grant', {
            ownerId: targetId, productId: String(purchase.product_id), quantity: grantQuantity
          }, invCtx);
        }
        faultPoint('after-purchase-settlement-grant');

        /* ── ⑧ Purchase → COMPLETED（completedAt 与 commit 同事务）────── */
        const movedPurchase = db.prepare(SQL.setPurchaseSettled).run(
          C.PURCHASE_STATE.COMPLETED,
          String(settlementCommit.transactionId),
          settlementGrant ? String(settlementGrant.inventoryEntryId) : null,
          Number(settlementCommit.revision), Number(at), Number(at),
          purchaseId, C.PURCHASE_STATE.RESERVED
        );
        if (Number(movedPurchase.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['purchase-transition-affected-no-row']);
        }
        faultPoint('after-purchase-completed');

        const settledView = rowToPurchase(db.prepare(SQL.selectPurchase).get(purchaseId));
        const result = {
          domain: C.DOMAIN,
          purchaseId: purchaseId,
          purchaseStatus: C.PURCHASE_STATE.COMPLETED,
          buyerId: settledView.buyerId,
          recipientId: settledView.recipientId,
          selfDirected: settledView.selfDirected,
          productId: settledView.productId,
          storeId: settledView.storeId,
          quoteId: settledView.quoteId,
          quoteState: C.QUOTE_STATE.CONSUMED,
          reservationId: settledView.reservationId,
          reservationState: C.RESERVATION_STATE.COMMITTED,
          operationId: String(settlementCommit.operationId),
          operationStatus: C.TX_STATE.COMMITTED,
          walletId: String(settlementCommit.walletId),
          currency: settledView.currency,
          amountMinor: C.serializeAmountMinor(settledView.amountMinor),
          quoteKind: settledView.quoteKind,
          settlementType: settledView.settlementType,
          settlementPrimitive: primitive.primitive,
          assetKind: settledView.settledAssetKind,
          grantedQuantity: settledView.grantedQuantity,
          unitName: settledView.unitName,
          inventoryEntryId: settlementGrant ? String(settlementGrant.inventoryEntryId) : null,
          ledgerTransactionId: String(settlementCommit.transactionId),
          ledgerTransactionType: String(settlementCommit.transactionType),
          counterparty: String(settlementCommit.counterparty),
          /* 结算之后这个钱包的**派生**缓存值（来自 ledger，不是增量）。 */
          buyerBalanceAfterMinor: (() => {
            const touched = settlementCommit.ledger.wallets.find(w => String(w.walletId) === String(settlementCommit.walletId));
            return touched ? String(touched.balanceMinor) : null;
          })(),
          reservedBalanceMinor: (() => {
            const touched = settlementCommit.ledger.wallets.find(w => String(w.walletId) === String(settlementCommit.walletId));
            return touched ? String(touched.reservedBalanceMinor) : null;
          })(),
          budget: {
            outcome: budget.decision.outcome,
            priority: budget.decision.priority,
            policyId: budget.policyId,
            /* ★ 这是**最终**结论用的那个快照，不是 Prepare 时的历史。 */
            evaluatedAtSettlement: true,
            spentTodayMinor: budget.decision.spentTodayMinor,
            spentThisWeekMinor: budget.decision.spentThisWeekMinor,
            spentThisMonthMinor: budget.decision.spentThisMonthMinor,
            availableBalanceMinor: budget.decision.availableBalanceMinor
          },
          revision: Number(settlementCommit.revision),
          at: Number(at),
          idempotencyKey: key.key,
          ledgerMutation: true,
          inventoryMutation: !!settlementGrant,
          quoteConsumed: true,
          reservationCommitted: true,
          purchaseCompleted: true,
          /* ★ 授权那一面**逐字**来自 settledView（即刚被读回来的那行购买），
             而不是在这里再查一次批准行 —— 一个字段只有一个出处。
             这四句合起来回答 §16 的第四问："这个批准最终被哪笔 Purchase
             消费"（consumedByPurchaseId === purchaseId）。 */
          authorization: {
            mode: settledView.approvalMode,
            gatedByP22_7: settledView.gatedByP22_7 === true,
            approvalId: settledView.approvalId,
            autonomyPolicyId: settledView.autonomyPolicyId,
            approvalBindingFingerprint: settledView.approvalBindingFingerprint,
            approvalConsumedHere: approvalConsumption != null,
            consumedByPurchaseId: approvalConsumption == null ? null : purchaseId,
            approvalStatusAfter: settledView.approval == null ? null : String(settledView.approval.status),
            approvedBy: settledView.approval == null ? null : settledView.approval.decidedBy,
            autonomous: settledView.autonomous === true,
            requiredUserApproval: settledView.requiredUserApproval === true,
            oneApprovalAtMostOnePurchase: C.APPROVAL_IS_SINGLE_USE,
            budgetWasIndependentlyEvaluated: true,
            approvalBypassedBudget: false,
            approvalBypassedQuoteExpiry: false
          },
          /* 四句逐字的否认（§17/§18/§62/§63）。 */
          providerMutation: false,
          paymentMutation: false,
          memoryMutation: false,
          relationshipMutation: false,
          storeIsAMerchant: false,
          amountSource: C.PURCHASE_AMOUNT_SOURCE
        };

        /* ★ 高层事件用**它自己**的 revision（`settlementCommit.revision`
           已经被 RESERVATION_COMMITTED 那条 change 行用掉了，而
           economy_change_log.revision 是主键）。这不是记账事实的第二个
           版本号 —— canonical 记账事实的 revision 仍然是 ledger 那一条；
           这里分配的是"这次购买结束在哪个 revision 上"。 */
        const revCompleted = allocateRevision();
        result.revision = Number(revCompleted);
        appendChange({
          revision: Number(revCompleted), kind: C.EVENT_TYPE.PURCHASE_COMPLETED,
          entityId: purchaseId, transactionId: String(settlementCommit.transactionId),
          walletId: String(settlementCommit.walletId), at: Number(at),
          payload: {
            domain: C.DOMAIN,
            purchaseId: purchaseId,
            purchaseStatus: C.PURCHASE_STATE.COMPLETED,
            buyerId: String(purchase.buyer_id),
            recipientId: purchaseRecipientId,
            productId: String(purchase.product_id),
            storeId: purchase.store_id == null ? null : String(purchase.store_id),
            quoteId: String(purchase.quote_id),
            quoteState: C.QUOTE_STATE.CONSUMED,
            reservationId: String(purchase.reservation_id),
            reservationState: C.RESERVATION_STATE.COMMITTED,
            transactionId: String(settlementCommit.transactionId),
            transactionType: String(settlementCommit.transactionType),
            counterparty: String(settlementCommit.counterparty),
            currency: String(purchase.currency),
            amountMinor: C.serializeAmountMinor(purchaseAmount),
            settlementType: String(purchase.settlement_type),
            settlementPrimitive: primitive.primitive,
            assetKind: settledView.settledAssetKind,
            grantedQuantity: settledView.grantedQuantity,
            unitName: settledView.unitName,
            inventoryEntryId: settlementGrant ? String(settlementGrant.inventoryEntryId) : null,
            ledgerMutation: true,
            inventoryMutation: !!settlementGrant,
            providerMutation: false,
            paymentMutation: false,
            memoryMutation: false,
            relationshipMutation: false,
            storeIsAMerchant: false,
            /* P22-7：结算这一条事件同时回答"这笔购买当初凭什么成立"。
               新行一定有；P22-7 之前的历史行是 null（那时没有授权层）。 */
            approvalMode: purchase.approval_mode == null ? null : String(purchase.approval_mode),
            approvalId: purchase.approval_id == null ? null : String(purchase.approval_id),
            autonomyPolicyId: purchase.autonomy_policy_id == null ? null : String(purchase.autonomy_policy_id)
          }
        });
        faultPoint('before-purchase-settle-change-log');

        /* Purchase 自己的幂等行在**这里**写（scope = PURCHASE_SETTLE），
           而且上面 commitReservationInTx 的幂等写入被刻意关掉了
           （见那里的说明）：一个请求恰好一行、一个结果。 */
        writeOperationIdempotency(C.OPERATION_SCOPE.PURCHASE_SETTLE, key.key, fingerprint, {
          operationId: String(settlementCommit.operationId),
          reservationId: String(purchase.reservation_id),
          transactionId: String(settlementCommit.transactionId)
        }, result, Number(settlementCommit.revision), at);
        faultPoint('before-purchase-settle-commit');
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }

    /* ── 结算的**两种结局**共用同一个出口形状 ────────────────────────────
       ★ 一个真实的 API 形状缺陷（开发期实测踩到）：成功路径返回
       `{ok:true, replayed:false, idempotencyKey, result}`，而"已经在事务里
       终结这笔购买"的三条路径（报价/预留过期、预算 DENY、预算
       REQUIRE_APPROVAL）把结果写进 `committed` 之后走到同一个出口 ——
       于是它们在 `result` 里被包了一层 `ok:true`。同一个方法对同一类问题
       给出两种形状，调用方必须写 `res.result || res`，而任何一处漏写都会
       **静默**读到 `undefined`（`res.reasonCode` 与 `res.terminal` 都是
       undefined）—— 这是最难查的一类 bug。

       现在终局路径在最外层**直接返回它自己**，成功路径才返回包装。
       形状由"这件事是不是成功了"决定，而不由"它是在哪一行被决定的"决定。 */
    if (committed && committed.terminal === true) {
      pruneOperationIdempotency(at);
      pruneIdempotency(at);
      logger('economy-purchase-settle-refused', {
        purchaseId: purchaseId,
        reasonCode: committed.reasonCode,
        purchaseStatus: committed.detail ? committed.detail.purchaseStatus : null
      });
      return committed;
    }

    pruneOperationIdempotency(at);
    pruneIdempotency(at);
    logger('economy-purchase-settled', {
      purchaseId: committed.purchaseId,
      transactionId: committed.ledgerTransactionId,
      reservationId: committed.reservationId,
      quoteId: committed.quoteId,
      amountMinor: committed.amountMinor,
      grantedQuantity: committed.grantedQuantity,
      settlementPrimitive: committed.settlementPrimitive,
      revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

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
    /* ── P22-26：份数也是报价行自己的一句事实 ──────────────────────────
       它必须与 quantity（送达量）**一起**被检查，因为这两列的关系
       （quantity = units × grantQuantity）是 prepare 那一条载入期断言的
       依据。这里不重复那次乘法（那需要一行商品；quoteProblemsOf 刻意只
       读报价自己那一行 —— 与 §22 "报价的可解释性不依赖商品行是否存在"
       同款），只回答"这一个数本身说得通吗"。 */
    if (!Number.isSafeInteger(Number(row.units)) || Number(row.units) < 1) {
      problems.push(id + ':units-not-a-positive-safe-integer'); return problems;
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
    for (const row of db.prepare(SQL.selectPurchasesAll).all()) {
      problems.push.apply(problems, purchaseProblemsOf(row));
    }
    /* ── P22-7 的三层 ────────────────────────────────────────────────────
       ① 自主策略行自身的形状（与 policyProblemsOf 同级，但查得更细：
          两个枚举数组的成员必须在 P22-5 的封闭词表里）；
       ② 批准行自身 + 九元组指纹的**可重算性**（"绑定"因此不是注释）；
       ③ 一条已完成的购买与它所引用的批准之间的一致性（在
          purchaseProblemsOf 里，因为它是购买那一侧的完整性）。
       规模：O(自主策略数 + 批准数)，两者都随"配置变更"与"用户决策次数"
       增长，而不是随聊天或订单量增长。 */
    for (const row of db.prepare(SQL.selectAutonomyPoliciesAll).all()) {
      problems.push.apply(problems, autonomyPolicyProblemsOf(row));
    }
    for (const row of db.prepare(SQL.selectApprovalsAll).all()) {
      problems.push.apply(problems, approvalProblemsOf(row));
    }
    return problems;
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-7 §24 · Autonomous Purchase Policy（权限层，不是决策层）

     这一节回答**一个**问题：

       "这台 Agent 有没有权不问用户直接花这笔钱？"

     它刻意**不**回答"这笔钱花得起吗"（那是 P22-4 的 Budget，冻结未改）
     也不回答"Agent 想不想买"（那是一个 Decision，本阶段不存在）。
     §3 的整套内容落在下面这四行里：

       Budget ALLOW  AND  (Autonomy AUTO_ALLOW OR valid Approval)

     本文件里没有一行把三者合并成一个布尔 —— prepare 与 settle 各自分别
     执行预算闸门与授权闸门，因为它们的**失败后果不同**（预算拒绝是
     "钱不够/超额度"，授权拒绝是"没人有权花"）。合并它们会让审计失去
     "为什么没成"的答案。

     ★ 输入只来自 canonical Economy facts：buyer / recipient / product kind /
     settlement type / currency / amountMinor / 策略行 / 今日已自主花掉的
     金额。**没有** LLM 输出、Memory、Relationship、affection/trust、
     聊天内容。这不是"记得别传"，而是三层结构性约束：
       ① 契约的 AUTONOMY_POLICY_INPUT_KEYS 是白名单，未知键 = 拒绝；
       ② 这里构造 context 时**只**从 quote / product / autonomy policy /
          purchases 四个 canonical 来源读字段；
       ③ 载入期不变量检查白名单里不含任何正文类键。
     ══════════════════════════════════════════════════════════════════ */

  /* ── 行 → 视图。金额一律 BigInt（SQLite 的是 Number），与其它 rowTo* 同款。
     ★ `unusable` 与 `unusableErrors` 是刻意的：一条形状坏掉的策略行不是
     "没有策略"，它是"规则这一面不可信"。两者必须是**两个**答案，因为
     没有策略 → REQUIRE_APPROVAL（回到默认：问用户），而策略坏了 → DENY
     （有人在改规则而改到一半，这时放行比拒绝危险得多）。 */
  function rowToAutonomyPolicy(row) {
    const problems = autonomyPolicyProblemsOf(row);
    const kinds = parseJsonArray(row.allowed_product_kinds);
    const settlements = parseJsonArray(row.allowed_settlement_types);
    return {
      domain: C.DOMAIN,
      namespace: C.NAMESPACES.BUDGET,
      kind: 'autonomy',
      policyId: String(row.policy_id),
      ownerId: Object.freeze({ type: String(row.owner_type), id: String(row.owner_id) }),
      enabled: Number(row.enabled) === 1,
      perPurchaseLimitMinor: fromSqlAmount(row.per_purchase_limit_minor, 'autonomy-per-purchase-limit'),
      dailyAutonomousLimitMinor: fromSqlAmount(row.daily_autonomous_limit_minor, 'autonomy-daily-limit'),
      approvalAboveMinor: fromSqlAmount(row.approval_above_minor, 'autonomy-approval-threshold'),
      allowedProductKinds: Object.freeze(kinds.ok ? kinds.items : []),
      allowedSettlementTypes: Object.freeze(settlements.ok ? settlements.items : []),
      allowGift: Number(row.allow_gift) === 1,
      unusable: problems.length > 0,
      unusableErrors: problems,
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  /* JSON 数组列的读侧。坏掉的 JSON **不**静默变成空数组 —— 一个读不懂的
     白名单与一个空白的白名单后果完全不同（后者是"什么都不允许"，前者是
     "我们不知道允许什么"），而把它兜成 [] 会让后者伪装成前者。 */
  function parseJsonArray(raw) {
    if (raw == null) return { ok: false, items: [], errors: ['json-array-column-is-null'] };
    let parsed = null;
    try { parsed = JSON.parse(String(raw)); } catch (error) {
      return { ok: false, items: [], errors: ['json-array-column-is-not-parseable'] };
    }
    if (!Array.isArray(parsed)) return { ok: false, items: [], errors: ['json-array-column-is-not-an-array'] };
    return { ok: true, items: parsed.map(x => String(x)), errors: [] };
  }

  /* 一条自主策略行是否**结构上**可信。与 policyProblemsOf / quoteProblemsOf /
     productProblemsOf 同款：逐行回答"这一行本身是不是一句说得通的话"。
     这里多查两件预算政策不需要查的事：
       · 两个枚举数组的成员必须都在 P22-5 的封闭词表里（一个拼错的
         COMPUTE_CREDITS 会让"允许买算力额度"静默地不生效）；
       · per_purchase ≤ daily ≤ approval ≤ per_purchase 三条序关系 ——
         即便 CHECK 约束已经在库里把关，读侧还要再查一遍，因为"手工改过
         库"正是这一层存在的理由。 */
  function autonomyPolicyProblemsOf(row) {
    const problems = [];
    const id = String(row.policy_id);
    if (!C.isEconomyId('BUDGET_POLICY', id)) { problems.push(id + ':autonomy-policy-id-not-canonical'); return problems; }
    if (String(row.owner_id).trim() === '') { problems.push(id + ':owner-id-empty'); return problems; }
    if (String(row.owner_type) === C.PARTY_TYPE.SYSTEM) { problems.push(id + ':system-cannot-own-an-autonomy-policy'); return problems; }
    for (const field of ['per_purchase_limit_minor', 'daily_autonomous_limit_minor', 'approval_above_minor']) {
      try { fromSqlAmount(row[field], 'autonomy-' + field); }
      catch (error) { problems.push(id + ':limit-not-canonical:' + field); return problems; }
    }
    const perPurchase = fromSqlAmount(row.per_purchase_limit_minor, 'autonomy-per-purchase-limit');
    const daily = fromSqlAmount(row.daily_autonomous_limit_minor, 'autonomy-daily-limit');
    const threshold = fromSqlAmount(row.approval_above_minor, 'autonomy-approval-threshold');
    if (perPurchase > daily) { problems.push(id + ':per-purchase-limit-exceeds-the-daily-autonomous-limit'); return problems; }
    if (threshold > perPurchase) { problems.push(id + ':approval-threshold-exceeds-the-per-purchase-limit'); return problems; }
    if (Number(row.enabled) !== 0 && Number(row.enabled) !== 1) { problems.push(id + ':enabled-is-not-a-boolean'); return problems; }
    if (Number(row.allow_gift) !== 0 && Number(row.allow_gift) !== 1) { problems.push(id + ':allow-gift-is-not-a-boolean'); return problems; }
    const kinds = parseJsonArray(row.allowed_product_kinds);
    if (!kinds.ok) { problems.push(id + ':allowed-product-kinds-not-readable'); return problems; }
    for (const k of kinds.items) {
      if (!C.isProductKind(k)) { problems.push(id + ':allowed-product-kind-not-in-closed-set:' + k); return problems; }
    }
    const settlements = parseJsonArray(row.allowed_settlement_types);
    if (!settlements.ok) { problems.push(id + ':allowed-settlement-types-not-readable'); return problems; }
    for (const s of settlements.items) {
      if (!C.isFulfillment(s)) { problems.push(id + ':allowed-settlement-type-not-in-closed-set:' + s); return problems; }
    }
    return problems;
  }

  function autonomyPolicyForOwner(ownerId) {
    const row = db.prepare(SQL.selectAutonomyPolicyByOwner).get(String(ownerId));
    return row ? rowToAutonomyPolicy(row) : null;
  }

  function autonomyPolicyFingerprint(payload) {
    return fingerprintOf(stableStringify({ scope: C.OPERATION_SCOPE.AUTONOMY_POLICY, request: payload }));
  }

  /* ── putAutonomyPolicy：一个 owner 恰好一条自主策略 ───────────────────
     与 putBudgetPolicy 同款（同一套幂等语义、同一条"拒绝整体回滚"纪律），
     但有三处**刻意不同**：

     ① 没有 `disable` 开关。预算政策的停用是一条真实的历史事件
        （"有人在上周二关掉了它"），而自主策略的停用就是 enabled=false
        —— 那是它的**内容**。再给一个 disable 会让"为什么这条策略不生效"
        有两个答案。
     ② 没有 `autonomyLevel`。P22-4 的那个字段是预算政策上的一个**记录列**
        （四条词，P22-4 从未据它分支）；P22-7 的自主权限是**结构化**的
        （额度 + 白名单 + 开关），把一个自由度极低的三态词放进来说明
        "能自主到什么程度"会让策略层出现两套并存的权限表达。
     ③ currency 不在这张表上。自主额度按 **owner** 计，跨币种合并计数是
        错的，而"按币种各一条策略"会让"这台 Agent 能不能自主买"出现多个
        答案。金额字段仍然带 Minor 后缀（§4），因此这里不存在裸 limit。 */
  function putAutonomyPolicy(input) {
    requireOpen();
    const o = input || {};
    const owner = partyInput(o.ownerId);
    if (!owner.ok) return { ok: false, denied: false, reasonCode: null, errors: owner.errors };
    if (owner.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, denied: false, reasonCode: null, errors: ['system-party-cannot-own-an-autonomy-policy'] };
    }
    const ownerId = String(owner.party.id);
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };
    if (o.ifRevision != null && (!Number.isSafeInteger(Number(o.ifRevision)) || Number(o.ifRevision) < 0)) {
      return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, ['autonomy-if-revision-must-be-a-non-negative-safe-integer']);
    }

    const existingRow = db.prepare(SQL.selectAutonomyPolicyByOwner).get(ownerId);
    const existing = existingRow ? rowToAutonomyPolicy(existingRow) : null;
    const policyId = existing ? existing.policyId
      : (o.policyId != null ? String(o.policyId) : nextId('BUDGET_POLICY'));
    if (!C.isEconomyId('BUDGET_POLICY', policyId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['autonomy-policy-id-not-canonical'] };
    }

    const shape = C.validateAutonomyPolicy({
      policyId: policyId,
      ownerId: owner.party,
      enabled: o.enabled,
      perPurchaseLimitMinor: o.perPurchaseLimitMinor,
      dailyAutonomousLimitMinor: o.dailyAutonomousLimitMinor,
      approvalAboveMinor: o.approvalAboveMinor,
      allowedProductKinds: o.allowedProductKinds,
      allowedSettlementTypes: o.allowedSettlementTypes,
      allowGift: o.allowGift
    });
    if (!shape.ok) return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, shape.errors);
    const policy = shape.policy;

    const fingerprint = autonomyPolicyFingerprint({
      ownerId: ownerId, ownerType: String(owner.party.type),
      enabled: policy.enabled,
      perPurchaseLimitMinor: C.serializeAmountMinor(policy.perPurchaseLimitMinor),
      dailyAutonomousLimitMinor: C.serializeAmountMinor(policy.dailyAutonomousLimitMinor),
      approvalAboveMinor: C.serializeAmountMinor(policy.approvalAboveMinor),
      allowedProductKinds: policy.allowedProductKinds.slice().sort().join(','),
      allowedSettlementTypes: policy.allowedSettlementTypes.slice().sort().join(','),
      allowGift: policy.allowGift
    });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.AUTONOMY_POLICY, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.AUTONOMY_POLICY, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    if (existing && o.ifRevision != null && Number(o.ifRevision) !== existing.revision) {
      return {
        ok: false, denied: false, reasonCode: null,
        errors: ['autonomy-policy-revision-mismatch'],
        expectedRevision: Number(o.ifRevision), actualRevision: existing.revision, policyId: existing.policyId
      };
    }

    const at = clock();
    const created = !existing;
    let committed = null;
    try {
      withTransaction(() => {
        const rev = allocateRevision();
        if (created) {
          db.prepare(SQL.insertAutonomyPolicy).run(
            policyId, ownerId, String(owner.party.type), policy.enabled ? 1 : 0,
            toSqlAmount(policy.perPurchaseLimitMinor, 'autonomy-per-purchase-limit'),
            toSqlAmount(policy.dailyAutonomousLimitMinor, 'autonomy-daily-limit'),
            toSqlAmount(policy.approvalAboveMinor, 'autonomy-approval-threshold'),
            JSON.stringify(policy.allowedProductKinds.slice()),
            JSON.stringify(policy.allowedSettlementTypes.slice()),
            policy.allowGift ? 1 : 0,
            key.key, fingerprint, Number(rev), Number(at), Number(at)
          );
        } else {
          const moved = db.prepare(SQL.updateAutonomyPolicy).run(
            policy.enabled ? 1 : 0,
            toSqlAmount(policy.perPurchaseLimitMinor, 'autonomy-per-purchase-limit'),
            toSqlAmount(policy.dailyAutonomousLimitMinor, 'autonomy-daily-limit'),
            toSqlAmount(policy.approvalAboveMinor, 'autonomy-approval-threshold'),
            JSON.stringify(policy.allowedProductKinds.slice()),
            JSON.stringify(policy.allowedSettlementTypes.slice()),
            policy.allowGift ? 1 : 0,
            key.key, fingerprint, Number(rev), Number(at), policyId
          );
          if (Number(moved.changes) !== 1) {
            throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['autonomy-policy-update-affected-no-row']);
          }
        }
        faultPoint('after-autonomy-policy-written');

        const view = rowToAutonomyPolicy(db.prepare(SQL.selectAutonomyPolicy).get(policyId));
        const result = {
          domain: C.DOMAIN,
          namespace: C.NAMESPACES.BUDGET,
          kind: 'autonomy',
          policyId: policyId,
          ownerId: partyKeyOf(owner.party.type, owner.party.id),
          enabled: view.enabled,
          perPurchaseLimitMinor: C.serializeAmountMinor(view.perPurchaseLimitMinor),
          dailyAutonomousLimitMinor: C.serializeAmountMinor(view.dailyAutonomousLimitMinor),
          approvalAboveMinor: C.serializeAmountMinor(view.approvalAboveMinor),
          allowedProductKinds: view.allowedProductKinds.slice(),
          allowedSettlementTypes: view.allowedSettlementTypes.slice(),
          allowGift: view.allowGift,
          created: created,
          revision: Number(rev),
          at: Number(at),
          idempotencyKey: key.key,
          /* 三条自述：这条策略是**权限**，它不授予预算、不替代预算、
             也不是一次决策。 */
          grantsBudget: C.AUTONOMY_POLICY_GRANTS_BUDGET,
          replacesBudget: C.AUTONOMY_REPLACES_BUDGET,
          isADecisionLayer: C.AUTONOMY_POLICY_IS_A_DECISION_LAYER,
          readsLlmOutput: C.AUTONOMY_POLICY_READS_LLM_OUTPUT,
          readsMemory: C.AUTONOMY_POLICY_READS_MEMORY,
          readsRelationship: C.AUTONOMY_POLICY_READS_RELATIONSHIP
        };
        appendChange({
          revision: Number(rev),
          kind: created ? C.EVENT_TYPE.AUTONOMY_POLICY_CREATED : C.EVENT_TYPE.AUTONOMY_POLICY_UPDATED,
          entityId: policyId, transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN, policyId: policyId, ownerId: ownerId,
            enabled: view.enabled,
            perPurchaseLimitMinor: result.perPurchaseLimitMinor,
            dailyAutonomousLimitMinor: result.dailyAutonomousLimitMinor,
            approvalAboveMinor: result.approvalAboveMinor,
            allowedProductKinds: result.allowedProductKinds,
            allowedSettlementTypes: result.allowedSettlementTypes,
            allowGift: view.allowGift,
            grantsBudget: false,
            isADecisionLayer: false,
            ledgerMutation: false, inventoryMutation: false,
            providerMutation: false, paymentMutation: false,
            memoryMutation: false, relationshipMutation: false
          }
        });
        faultPoint('before-autonomy-policy-commit');
        writeOperationIdempotency(C.OPERATION_SCOPE.AUTONOMY_POLICY, key.key, fingerprint,
          { policyId: policyId, ownerId: ownerId, transactionId: null }, result, Number(rev), at);
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }
    pruneOperationIdempotency(at);
    logger('economy-autonomy-policy-written', {
      policyId: policyId, ownerId: ownerId, created: created,
      enabled: committed.enabled, revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  function getAutonomyPolicy(input) {
    requireOpen();
    const o = input || {};
    if (o.policyId != null) {
      const row = db.prepare(SQL.selectAutonomyPolicy).get(String(o.policyId));
      if (!row) return { ok: false, denied: true, reasonCode: C.DENY_REASON.POLICY_NOT_FOUND, errors: ['autonomy-policy-not-found'], policyId: String(o.policyId) };
      return { ok: true, policy: rowToAutonomyPolicy(row) };
    }
    const owner = partyInput(o.ownerId);
    if (!owner.ok) return { ok: false, denied: false, reasonCode: null, errors: owner.errors };
    const row = db.prepare(SQL.selectAutonomyPolicyByOwner).get(String(owner.party.id));
    if (!row) return { ok: false, denied: true, reasonCode: C.DENY_REASON.POLICY_NOT_FOUND, errors: ['autonomy-policy-not-found'], ownerId: String(owner.party.id) };
    return { ok: true, policy: rowToAutonomyPolicy(row) };
  }

  function listAutonomyPolicies(options) {
    requireOpen();
    const o = options || {};
    const limit = normalizeLimit(o.limit, 50, 500);
    const ownerId = o.ownerId == null ? null : String(o.ownerId);
    const rows = db.prepare(SQL.selectAutonomyPoliciesFiltered).all(ownerId, ownerId, Number(limit));
    return {
      ok: true,
      policies: rows.map(r => serializeAutonomyPolicy(rowToAutonomyPolicy(r))),
      count: rows.length,
      personalized: false, recommended: false, ranked: false
    };
  }

  function serializeAutonomyPolicy(view) {
    return {
      domain: view.domain,
      namespace: view.namespace,
      kind: view.kind,
      policyId: view.policyId,
      ownerId: partyKeyOf(view.ownerId.type, view.ownerId.id),
      enabled: view.enabled,
      perPurchaseLimitMinor: C.serializeAmountMinor(view.perPurchaseLimitMinor),
      dailyAutonomousLimitMinor: C.serializeAmountMinor(view.dailyAutonomousLimitMinor),
      approvalAboveMinor: C.serializeAmountMinor(view.approvalAboveMinor),
      allowedProductKinds: view.allowedProductKinds.slice(),
      allowedSettlementTypes: view.allowedSettlementTypes.slice(),
      allowGift: view.allowGift,
      usable: view.unusable !== true,
      problems: view.unusable === true ? view.unusableErrors.slice() : [],
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      grantsBudget: false,
      replacesBudget: false,
      isADecisionLayer: false
    };
  }

  /* ── 今日已自主花掉的金额（canonical 事实，不是计数器）────────────────
     与 P22-4 的 spendingWindows 同一条纪律：**每一个数都来自落库的行**，
     没有缓存、没有 UI 计数器、没有"记忆"。

     判据是逐字的三条：
       · `approval_mode = 'AUTO_ALLOW'` —— **只**统计自主放行的那些。
         一条被用户批准的购买不消耗自主额度，因为额度约束的是"Agent 能
         自己决定多少"，而不是"这台 Agent 一共能花多少"（后者是 Budget）。
         把两者混起来会让"用户批准了一笔大额"顺手把 Agent 未来的自主权
         收窄 —— 那是一个没有任何规则要求过的副作用。
       · `status IN ('RESERVED','COMPLETED')` —— RESERVED 的购买**已经**
         占住了额度：它的钱被锁住了，会成交或会释放，而"先花再算"会让
         两次并发的自主购买各自看到同一个旧数字。
       · 窗口是 **UTC 日**，用 P22-4 冻结的 utcDayStart 算 —— 与预算的
         日窗口是同一个边界，不引入第二个"今天"。

     ★ 时间列用 `created_at`（授权那一刻），不是 completed_at：额度是
     **授权**的度量。用 completed_at 会让一笔今天授权、明天成交的购买
     落进明天的额度里，于是"今天已经自主花了多少"在成交前是 0 —— 而
     两笔并发的自主购买会同时看到那个 0。 */
  function autonomousSpentTodayMinor(ownerId, policyId, at) {
    const dayStart = C.utcDayStart(at);
    if (dayStart == null) return { ok: false, total: null, errors: ['autonomy-window-start-is-not-representable'] };
    const rows = db.prepare(SQL.selectAutonomousSpendRows).all(
      String(ownerId), String(policyId), Number(dayStart)
    );
    let total = 0n;
    for (const row of rows) {
      /* 任何一行读不懂 ⇒ 整个求和失败（fail closed）。一个偏小的
         "今天已花"会让一次超额的自主购买看起来合规。 */
      let amt = null;
      try { amt = fromSqlAmount(row.amount_minor, 'autonomous-spend-amount'); }
      catch (error) { return { ok: false, total: null, errors: ['autonomous-spend-row-is-not-canonical'] }; }
      total += amt;
    }
    return { ok: true, total: total, dayStart: Number(dayStart), rows: rows.length, errors: [] };
  }

  /* ── §2 的落点：把 canonical facts 组装成契约评估器认识的 context ────
     ★ 这个函数是"策略输入只能来自 canonical Economy facts"的**唯一**
     构造点。它只从五个来源读字段：quote 行、product 行、autonomy policy
     行、purchases 求和、以及调用方给出的 buyer/recipient（那两个本身
     由 partyInput 规范化）。因此 prompt / persona / relationship /
     llmOutput 在这里**无处可放** —— 不是被过滤掉，而是没有字段可承载。 */
  function autonomyContextOf(quoteRow, productRow, buyerParty, recipientParty, policy, at) {
    const spent = autonomousSpentTodayMinor(String(buyerParty.id), policy ? policy.policyId : '', at);
    if (!spent.ok) return { ok: false, errors: spent.errors };
    return {
      ok: true,
      context: {
        ownerId: Object.freeze({ type: String(buyerParty.type), id: String(buyerParty.id) }),
        recipientId: recipientParty == null ? null : Object.freeze({ type: String(recipientParty.type), id: String(recipientParty.id) }),
        productId: String(quoteRow.product_id),
        productKind: String(productRow.product_kind),
        settlementType: String(productRow.fulfillment),
        currency: String(quoteRow.currency),
        amountMinor: fromSqlAmount(quoteRow.amount_minor, 'quote-amount'),
        gift: recipientParty != null,
        selfDirected: recipientParty == null,
        spentTodayMinor: spent.total,
        timestamp: Number(at)
      },
      spentTodayMinor: spent.total,
      spentRowsToday: spent.rows
    };
  }

  /* 给调用方（与测试）用的**只读**评估：它不改任何状态、不锁任何钱。
     与 evaluateBudgetFor 同级 —— `evaluatedOnly: true` 是逐字写下的。 */
  function evaluateAutonomousPurchaseFor(input) {
    requireOpen();
    const o = input || {};
    const buyer = partyInput(o.buyerId != null ? o.buyerId : o.ownerId);
    if (!buyer.ok) return { ok: false, denied: false, reasonCode: null, errors: buyer.errors };
    const quoteId = o.quoteId == null ? null : String(o.quoteId);
    if (!C.isEconomyId('QUOTE', quoteId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['quote-id-not-canonical'] };
    }
    const quoteRow = db.prepare(SQL.selectQuote).get(quoteId);
    if (!quoteRow) return { ok: false, denied: false, reasonCode: null, errors: ['quote-not-found'] };
    const productRow = db.prepare(SQL.selectProduct).get(String(quoteRow.product_id));
    if (!productRow) return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: String(quoteRow.product_id) });

    const recipient = deriveRecipient(buyer.party, o.recipientId);
    if (!recipient.ok) return { ok: false, denied: false, reasonCode: null, errors: recipient.errors };

    const at = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(at) || at < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const policy = autonomyPolicyForOwner(String(buyer.party.id));
    const built = autonomyContextOf(quoteRow, productRow, buyer.party, recipient.party, policy, at);
    if (!built.ok) return { ok: false, denied: false, reasonCode: null, errors: built.errors };
    return {
      ok: true,
      decision: C.evaluateAutonomousPurchase(policy, built.context),
      /* 逐字：这是**一次快照评估**，不是可执行的许可（§19 的同一条纪律）。 */
      evaluatedOnly: true,
      notASpendPermit: 'AUTO_ALLOW is an autonomy snapshot, not a spendable permission; it is re-derived inside the transaction that reserves, and budget is still evaluated separately',
      quoteId: quoteId,
      buyerId: String(buyer.party.id),
      recipientId: recipient.party == null ? null : String(recipient.party.id),
      resolvedRecipientId: recipient.party == null ? null : String(recipient.party.id),
      resolvedRecipientType: recipient.party == null ? null : String(recipient.party.type),
      productId: String(quoteRow.product_id),
      productKind: String(productRow.product_kind),
      settlementType: String(productRow.fulfillment),
      currency: String(quoteRow.currency),
      amountMinor: C.serializeAmountMinor(fromSqlAmount(quoteRow.amount_minor, 'quote-amount')),
      autonomyPolicyId: policy ? policy.policyId : null,
      autonomyPolicyPresent: !!policy,
      spentTodayMinor: C.serializeAmountMinor(built.spentTodayMinor),
      spentRowsToday: built.spentRowsToday,
      reserved: false
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-7 §25 · Approval（一条批准记录的生命周期）

     §5：一条 Approval 表达的是"用户授权某个被冻结的购买意图继续执行"。
     它与 Purchase **是两个实体**：
       · 一条批准可以存在而永远没有购买（用户批了，Agent 没买）；
       · 一笔购买可以没有任何批准（它是自主成立的）。
     因此它有自己的表、自己的 id 前缀（econ_approval_）、自己的状态机。

     §6：批准**必须绑定具体经济事实**。九个绑定字段逐字来自
     C.APPROVAL_BINDING_KEYS，而 binding_fingerprint 是它们的纯函数身份。
     批准之后换掉商品 / 价格 / recipient / 数量 / settlement 中的任何一个，
     验证就会失败 —— 因为验证比的是**九个字段**，不是"一个金额"。
     ══════════════════════════════════════════════════════════════════ */

  function rowToApproval(row) {
    const binding = {
      buyerId: partyKeyOf(row.buyer_type, row.buyer_id),
      recipientId: row.recipient_id == null ? null : partyKeyOf(row.recipient_type, row.recipient_id),
      productId: String(row.product_id),
      quoteId: String(row.quote_id),
      currency: String(row.currency),
      amountMinor: fromSqlAmount(row.amount_minor, 'approval-amount'),
      settlementType: String(row.settlement_type),
      grantQuantity: Number(row.grant_quantity),
      units: Number(row.units)
    };
    const status = String(row.status);
    const expiresAt = Number(row.expires_at);
    return {
      domain: C.DOMAIN,
      namespace: C.NAMESPACES.APPROVAL,
      approvalId: String(row.approval_id),
      buyerId: binding.buyerId,
      buyerType: String(row.buyer_type),
      buyerRef: Object.freeze({ type: String(row.buyer_type), id: String(row.buyer_id) }),
      recipientId: binding.recipientId,
      recipientType: row.recipient_id == null ? null : String(row.recipient_type),
      recipientRef: row.recipient_id == null ? null
        : Object.freeze({ type: String(row.recipient_type), id: String(row.recipient_id) }),
      selfDirected: row.recipient_id == null,
      productId: binding.productId,
      quoteId: binding.quoteId,
      quoteKind: String(row.quote_kind),
      currency: binding.currency,
      amountMinor: binding.amountMinor,
      settlementType: binding.settlementType,
      grantQuantity: binding.grantQuantity,
      units: binding.units,
      binding: Object.freeze(binding),
      bindingFingerprint: String(row.binding_fingerprint),
      approvalMode: String(row.approval_mode),
      autonomyPolicyId: row.autonomy_policy_id == null ? null : String(row.autonomy_policy_id),
      autonomyOutcome: row.autonomy_outcome == null ? null : String(row.autonomy_outcome),
      autonomyReasonCode: row.autonomy_reason_code == null ? null : String(row.autonomy_reason_code),
      status: status,
      terminal: C.isApprovalTerminalState(status),
      /* 三个时间事实。`expiredByTime` 与 `status` 是**两个**字段，理由与
         rowToBudgetPolicy 的 expiredByTerm 逐字同源：到期是**比较**出来的
         （同一个 now 永远同一个答案），不是任何调度写下来的。 */
      expiresAt: expiresAt,
      expiredByTime: (status === C.APPROVAL_STATE.PENDING || status === C.APPROVAL_STATE.APPROVED) && expiresAt <= clock(),
      decidedBy: row.decided_by_id == null ? null : partyKeyOf(row.decided_by_type, row.decided_by_id),
      decidedByRef: row.decided_by_id == null ? null
        : Object.freeze({ type: String(row.decided_by_type), id: String(row.decided_by_id) }),
      decidedAt: row.decided_at == null ? null : Number(row.decided_at),
      consumedByPurchaseId: row.consumed_by_purchase_id == null ? null : String(row.consumed_by_purchase_id),
      consumedAt: row.consumed_at == null ? null : Number(row.consumed_at),
      consumeReason: row.consume_reason == null ? null : String(row.consume_reason),
      idempotencyKey: String(row.idempotency_key),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  function serializeApproval(view) {
    return {
      domain: view.domain,
      namespace: view.namespace,
      approvalId: view.approvalId,
      buyerId: view.buyerId,
      /* ★ 拆开的两半在读面上逐字保留（'type:id' 是一个可比较的键，而两半
         各自可查询 —— 这与 serializePurchase 的 buyerId/recipientId 同款）。 */
      buyerRef: view.buyerRef,
      recipientId: view.recipientId,
      recipientRef: view.recipientRef,
      selfDirected: view.selfDirected,
      productId: view.productId,
      quoteId: view.quoteId,
      quoteKind: view.quoteKind,
      currency: view.currency,
      amountMinor: C.serializeAmountMinor(view.amountMinor),
      settlementType: view.settlementType,
      grantQuantity: view.grantQuantity,
      units: view.units,
      bindingFingerprint: view.bindingFingerprint,
      approvalMode: view.approvalMode,
      autonomyPolicyId: view.autonomyPolicyId,
      autonomyOutcome: view.autonomyOutcome,
      autonomyReasonCode: view.autonomyReasonCode,
      status: view.status,
      terminal: view.terminal,
      expiresAt: view.expiresAt,
      expiredByTime: view.expiredByTime,
      decidedBy: view.decidedBy,
      decidedByRef: view.decidedByRef,
      decidedAt: view.decidedAt,
      consumedByPurchaseId: view.consumedByPurchaseId,
      consumedAt: view.consumedAt,
      consumeReason: view.consumeReason,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      /* 逐字的自述（§5/§17）：一条批准**不是**一笔购买，也**不是**预算豁免。 */
      isAPurchase: false,
      isBudgetAuthority: false,
      singleUse: C.APPROVAL_IS_SINGLE_USE,
      boundToAQuoteSnapshot: C.APPROVAL_IS_BOUND_TO_A_QUOTE,
      bypassesBudget: C.APPROVAL_BYPASSES_BUDGET,
      bypassesQuoteExpiry: C.APPROVAL_BYPASSES_QUOTE_EXPIRY,
      memoryMutation: false,
      relationshipMutation: false,
      providerMutation: false,
      paymentMutation: false
    };
  }

  function approvalProblemsOf(row) {
    const problems = [];
    const id = String(row.approval_id);
    if (!C.isEconomyId('APPROVAL', id)) { problems.push(id + ':approval-id-not-canonical'); return problems; }
    if (String(row.buyer_id).trim() === '') { problems.push(id + ':buyer-id-empty'); return problems; }
    if (String(row.buyer_type) === C.PARTY_TYPE.SYSTEM) { problems.push(id + ':system-party-cannot-buy'); return problems; }
    if (!C.isEconomyId('PRODUCT', row.product_id)) { problems.push(id + ':product-id-not-canonical'); return problems; }
    if (!C.isEconomyId('QUOTE', row.quote_id)) { problems.push(id + ':quote-id-not-canonical'); return problems; }
    if (!C.isQuoteKind(String(row.quote_kind))) { problems.push(id + ':quote-kind-not-in-closed-set'); return problems; }
    if (!C.isFulfillment(String(row.settlement_type))) { problems.push(id + ':settlement-type-not-in-closed-set'); return problems; }
    if (!C.CURRENCIES.some(c => c === String(row.currency))) { problems.push(id + ':currency-not-registered'); return problems; }
    try { fromSqlAmount(row.amount_minor, 'approval-amount'); }
    catch (error) { problems.push(id + ':amount-not-canonical'); return problems; }
    if (!Number.isSafeInteger(Number(row.grant_quantity)) || Number(row.grant_quantity) < 0) {
      problems.push(id + ':grant-quantity-not-a-non-negative-safe-integer'); return problems;
    }
    if (!Number.isSafeInteger(Number(row.units)) || Number(row.units) < 1) {
      problems.push(id + ':units-not-a-positive-safe-integer'); return problems;
    }
    if (!C.isApprovalState(String(row.status))) { problems.push(id + ':approval-status-not-in-closed-set'); return problems; }
    if (!C.isPurchaseApprovalMode(String(row.approval_mode))) {
      problems.push(id + ':approval-mode-not-in-closed-set'); return problems;
    }
    /* GIFT 与 recipient 的两个方向（与 quoteProblemsOf 同款）。 */
    if (String(row.quote_kind) === C.QUOTE_KIND.GIFT && row.recipient_id == null) {
      problems.push(id + ':gift-approval-without-a-recipient'); return problems;
    }
    if (String(row.quote_kind) !== C.QUOTE_KIND.GIFT && row.recipient_id != null) {
      problems.push(id + ':recipient-on-a-non-gift-approval'); return problems;
    }
    /* ── 指纹必须真的描述那九个字段 ────────────────────────────────────
       这一条把"绑定"从一句注释变成一句**可验证**的话：有人直接改库里的
       amount_minor（而不改 fingerprint）会在这里被发现。 */
    const recomputed = C.approvalFingerprint({
      buyerId: partyKeyOf(row.buyer_type, row.buyer_id),
      recipientId: row.recipient_id == null ? null : partyKeyOf(row.recipient_type, row.recipient_id),
      productId: String(row.product_id),
      quoteId: String(row.quote_id),
      currency: String(row.currency),
      amountMinor: fromSqlAmount(row.amount_minor, 'approval-amount'),
      settlementType: String(row.settlement_type),
      grantQuantity: Number(row.grant_quantity),
      units: Number(row.units)
    });
    if (!recomputed.ok || String(recomputed.fingerprint) !== String(row.binding_fingerprint)) {
      problems.push(id + ':binding-fingerprint-does-not-describe-the-bound-facts'); return problems;
    }
    /* 决定那一半：一条已经不是 PENDING 的记录必须有决定者与决定时间；
       而决定者**不能**是买方自己（self-approval 是结构性禁止的）。 */
    if (String(row.status) !== C.APPROVAL_STATE.PENDING) {
      if (row.decided_by_id == null) { problems.push(id + ':non-pending-approval-has-no-decider'); return problems; }
      if (String(row.decided_by_id) === String(row.buyer_id) && String(row.decided_by_type) === String(row.buyer_type)) {
        problems.push(id + ':self-approval-is-not-a-decision'); return problems;
      }
    }
    if (String(row.status) === C.APPROVAL_STATE.APPROVED && row.decided_at == null) {
      problems.push(id + ':approved-approval-has-no-decided-at'); return problems;
    }
    /* 消费那一半（§8）：CONSUMED 必须指向一笔购买，而非 CONSUMED 不许指向。 */
    if (String(row.status) === C.APPROVAL_STATE.CONSUMED
      && (row.consumed_by_purchase_id == null || row.consumed_at == null)) {
      problems.push(id + ':consumed-approval-has-no-consuming-purchase'); return problems;
    }
    if (String(row.status) !== C.APPROVAL_STATE.CONSUMED && row.consumed_by_purchase_id != null) {
      problems.push(id + ':a-non-consumed-approval-names-a-consuming-purchase'); return problems;
    }
    if (!Number.isSafeInteger(Number(row.expires_at)) || Number(row.expires_at) < 0) {
      problems.push(id + ':expires-at-not-a-non-negative-safe-integer'); return problems;
    }
    /* 有效期上界（§6：一条"永久有效"的批准与"以后随便花 500"是同一种东西）。 */
    if (Number(row.expires_at) - Number(row.created_at) > C.APPROVAL_MAX_LIFETIME_MS) {
      problems.push(id + ':approval-lifetime-exceeds-the-frozen-maximum'); return problems;
    }
    return problems;
  }

  /* 一条批准与一笔购买是否说的是**同一件事**。九个字段逐个比，而比较的
     右侧一律来自 canonical 行（quote / product / purchase 的 consent 快照），
     绝不来自请求参数。 */
  function approvalBindingMismatch(approval, expected) {
    const diffs = [];
    for (const key of C.APPROVAL_BINDING_KEYS) {
      const a = approval[key];
      const b = expected[key];
      const av = a == null ? null : (typeof a === 'bigint' ? C.serializeAmountMinor(a) : String(a));
      const bv = b == null ? null : (typeof b === 'bigint' ? C.serializeAmountMinor(b) : String(b));
      if (av !== bv) diffs.push({ field: key, approval: av, observed: bv });
    }
    return diffs;
  }

  /* ── createApprovalRequest：请求批准（§5 的第一条边）───────────────────
     它**只**做两件事：把自主结论固化下来 + 写一条 PENDING 记录。
     它不锁钱、不碰库存、不消耗报价、不创建购买 —— 一次"请求批准"不是
     一次购买（§5）。

     ★ 授权模式恒为 'APPROVAL'：一条待批准记录只可能由"策略要求批准"或
     "策略拒绝"两种情形产生。**DENY 的自主结论也会写一条 PENDING 记录**
     是刻意的吗？不是 —— 见 authorizePurchaseIntent：DENY 在那里就停下了，
     它连批准记录都不创建（§"DENY → stop"）。本函数因此只接受
     REQUIRE_APPROVAL 的自主结论。 */
  function createApprovalRequest(input) {
    requireOpen();
    const o = input || {};
    const buyer = partyInput(o.buyerId != null ? o.buyerId : o.ownerId);
    if (!buyer.ok) return { ok: false, denied: false, reasonCode: null, errors: buyer.errors };
    if (buyer.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, denied: false, reasonCode: null, errors: ['system-party-cannot-buy'] };
    }
    const buyerType = String(buyer.party.type);
    const buyerId = String(buyer.party.id);
    const quoteId = o.quoteId == null ? null : String(o.quoteId);
    if (!C.isEconomyId('QUOTE', quoteId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['quote-id-not-canonical'] };
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const quoteRow = db.prepare(SQL.selectQuote).get(quoteId);
    if (!quoteRow) return { ok: false, denied: false, reasonCode: null, errors: ['quote-not-found'] };
    const productRow = db.prepare(SQL.selectProduct).get(String(quoteRow.product_id));
    if (!productRow) return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: String(quoteRow.product_id) });

    if (String(quoteRow.buyer_id) !== buyerId || String(quoteRow.buyer_type) !== buyerType) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['quote-buyer-does-not-match-the-approval-buyer'],
        { quoteBuyerId: String(quoteRow.buyer_id), approvalBuyerId: buyerId });
    }
    const recipient = deriveRecipient(buyer.party, o.recipientId);
    if (!recipient.ok) return { ok: false, denied: false, reasonCode: null, errors: recipient.errors };
    if (!recipientMatchesQuote(recipient.party, quoteRow)) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['quote-recipient-does-not-match-the-approval-recipient'],
        { quoteRecipientId: quoteRow.recipient_id == null ? null : String(quoteRow.recipient_id) });
    }

    /* ── §7：批准针对的是 **Quote 快照**，不是 mutable Product。因此
       这里把报价那一刻的金额 / 数量 / 交付形态**快照进批准记录**，
       而 product 只提供两个**不可变**的本体列（fulfillment / grantQuantity）。
       报价之后商品改价（unit_price_minor 是 P22-5 唯一可变的价格列）
       对这条批准没有任何影响 —— 它绑的是 Q。 */
    /* ── P22-26 · 份数只来自报价（与 preparePurchase 同一条纪律）───────
       过去这里是 `o.units == null ? 1 : Number(o.units)`：一条请求里没带
       units 的批准请求会把一份 units = 3 的报价判成 QUOTE_MISMATCH ——
       也就是说"请求批准买三份"会以"数量对不上"失败。现在权威是报价上
       冻结的那一列，而且 quantity == units × grantQuantity 在这里同样
       被断言（一条批准绑的是**报价快照**，不是别人报上来的一个数）。 */
    const quantities = quoteQuantitiesOf(rowToProduct(productRow), quoteRow);
    if (!quantities.ok) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, quantities.errors, {
        quoteId: quoteId, quoteUnits: quantities.units
      });
    }
    const units = quantities.units;
    const quoteAmountMinor = fromSqlAmount(quoteRow.amount_minor, 'quote-amount');
    const expectedQuantity = { ok: true, quantity: quantities.quantity, errors: [] };
    const fulfillment = String(productRow.fulfillment);

    const now = clock();
    const expiresAt = normalizeExpiresAt(o.expiresAt);
    if (!expiresAt.ok) return { ok: false, denied: false, reasonCode: null, errors: expiresAt.errors };
    if (expiresAt.expiresAt <= now) {
      return denial(C.DENY_REASON.APPROVAL_REQUIRED, ['approval-expires-at-is-not-in-the-future'],
        { expiresAt: expiresAt.expiresAt, now: now });
    }
    /* ★ 上界（24h）。一条"永久有效"的批准与"以后随便花 500"是同一种东西。 */
    if (Number(expiresAt.expiresAt) - now > C.APPROVAL_MAX_LIFETIME_MS) {
      return denial(C.DENY_REASON.INVALID_AMOUNT, ['approval-lifetime-must-not-exceed-the-frozen-maximum'],
        { maxLifetimeMs: C.APPROVAL_MAX_LIFETIME_MS, requestedLifetimeMs: Number(expiresAt.expiresAt) - now });
    }

    const binding = {
      buyerId: partyKeyOf(buyerType, buyerId),
      recipientId: recipient.party == null ? null : partyKeyOf(recipient.party.type, recipient.party.id),
      productId: String(quoteRow.product_id),
      quoteId: quoteId,
      currency: String(quoteRow.currency),
      amountMinor: quoteAmountMinor,
      settlementType: fulfillment,
      grantQuantity: expectedQuantity.quantity,
      units: units
    };
    const bindingFp = C.approvalFingerprint(binding);
    if (!bindingFp.ok) return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, bindingFp.errors);

    const fingerprint = purchaseFingerprint(C.OPERATION_SCOPE.APPROVAL_REQUEST, {
      buyerId: partyKeyOf(buyerType, buyerId),
      recipientId: binding.recipientId,
      quoteId: quoteId,
      units: units,
      expiresAt: Number(expiresAt.expiresAt)
    });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.APPROVAL_REQUEST, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.APPROVAL_REQUEST, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    const approvalId = o.approvalId != null ? String(o.approvalId) : nextId('APPROVAL');
    if (!C.isEconomyId('APPROVAL', approvalId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-id-not-canonical'] };
    }
    const shape = C.validateApproval({
      approvalId: approvalId, buyerId: buyer.party, recipientId: recipient.party,
      productId: String(quoteRow.product_id), quoteId: quoteId, quoteKind: String(quoteRow.quote_kind),
      currency: String(quoteRow.currency), amountMinor: quoteAmountMinor,
      settlementType: fulfillment, grantQuantity: expectedQuantity.quantity, units: units,
      status: C.APPROVAL_STATE.PENDING, approvalMode: C.PURCHASE_APPROVAL_MODE.APPROVAL,
      expiresAt: Number(expiresAt.expiresAt)
    });
    if (!shape.ok) return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, shape.errors);

    const at = now;
    let committed = null;
    try {
      withTransaction(() => {
        /* 事务内重读报价：写锁拿到之后它不可能被另一个 writer 改动。 */
        const q = db.prepare(SQL.selectQuote).get(quoteId);
        if (!q) throw refuse(null, ['quote-not-found']);
        if (fromSqlAmount(q.amount_minor, 'quote-amount') !== quoteAmountMinor) {
          throw refuse(C.DENY_REASON.QUOTE_MISMATCH, ['quote-amount-changed-under-the-transaction']);
        }
        const rev = allocateRevision();
        db.prepare(SQL.insertApproval).run(
          approvalId, buyerId, buyerType,
          binding.recipientId == null ? null : String(binding.recipientId),
          recipient.party == null ? null : String(recipient.party.type),
          binding.productId, quoteId, String(q.quote_kind), binding.currency,
          toSqlAmount(quoteAmountMinor, 'approval-amount'), fulfillment,
          Number(expectedQuantity.quantity), units,
          String(bindingFp.fingerprint),
          C.PURCHASE_APPROVAL_MODE.APPROVAL,
          o.autonomyPolicyId == null ? null : String(o.autonomyPolicyId),
          o.autonomyOutcome == null ? null : String(o.autonomyOutcome),
          o.autonomyReasonCode == null ? null : String(o.autonomyReasonCode),
          C.APPROVAL_STATE.PENDING,
          null, null, null, null,
          key.key, fingerprint, Number(rev), Number(at), Number(at), Number(expiresAt.expiresAt),
          null, null
        );
        faultPoint('after-approval-requested');

        const view = rowToApproval(db.prepare(SQL.selectApproval).get(approvalId));
        const result = Object.assign(serializeApproval(view), {
          revision: Number(rev),
          at: Number(at),
          idempotencyKey: key.key,
          /* ★ 逐字：一次请求批准**不是**一次购买。 */
          purchaseCreated: false,
          fundsReserved: false,
          ledgerMutation: false,
          inventoryMutation: false,
          quoteConsumed: false
        });
        appendChange({
          revision: Number(rev), kind: C.EVENT_TYPE.APPROVAL_REQUESTED,
          entityId: approvalId, transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            approvalId: approvalId,
            buyerId: buyerId,
            recipientId: binding.recipientId,
            productId: binding.productId,
            quoteId: quoteId,
            currency: binding.currency,
            amountMinor: C.serializeAmountMinor(quoteAmountMinor),
            settlementType: fulfillment,
            grantQuantity: expectedQuantity.quantity,
            units: units,
            bindingFingerprint: String(bindingFp.fingerprint),
            approvalStatus: C.APPROVAL_STATE.PENDING,
            approvalMode: C.PURCHASE_APPROVAL_MODE.APPROVAL,
            autonomyOutcome: o.autonomyOutcome == null ? null : String(o.autonomyOutcome),
            autonomyReasonCode: o.autonomyReasonCode == null ? null : String(o.autonomyReasonCode),
            autonomyPolicyId: o.autonomyPolicyId == null ? null : String(o.autonomyPolicyId),
            purchaseCreated: false,
            fundsReserved: false,
            ledgerMutation: false, inventoryMutation: false,
            providerMutation: false, paymentMutation: false,
            memoryMutation: false, relationshipMutation: false
          }
        });
        faultPoint('before-approval-request-commit');
        writeOperationIdempotency(C.OPERATION_SCOPE.APPROVAL_REQUEST, key.key, fingerprint,
          { approvalId: approvalId, quoteId: quoteId, transactionId: null }, result, Number(rev), at);
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }
    pruneOperationIdempotency(at);
    logger('economy-approval-requested', {
      approvalId: approvalId, buyerId: buyerId, quoteId: quoteId,
      amountMinor: committed.amountMinor, revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ── decideApproval：用户点头 / 摇头（§9）─────────────────────────────
     ★ 三条结构性纪律：

     ① **self-approval 被拒绝**。买方不能批准自己的购买 —— 否则"需要用户
        批准"这条规则对一个自己就能点头的 Agent 等于零。这不是一句约定：
        decidedBy 必须是一个 canonical party，而它与 buyer 相同即拒绝。
        于是"Agent 自己批准自己"在类型上不可表达。
     ② 终态不可倒退。REJECTED / EXPIRED / CONSUMED 上再做任何决定都会被
        assertApprovalTransition 拒绝（§9 逐字点名那三条禁止的边）。
     ③ 并发：两个进程同时 APPROVE / REJECT 同一条 PENDING 批准时，只有
        一个 changes=1（`AND status='PENDING'` 谓词）。另一个拿到
        TRANSITION_NOT_ALLOWED + terminal 标记，**绝不**覆盖已写下的决定。 */
  function decideApproval(input) {
    requireOpen();
    const o = input || {};
    const approvalId = o.approvalId == null ? null : String(o.approvalId);
    if (!C.isEconomyId('APPROVAL', approvalId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-id-not-canonical'] };
    }
    const decision = o.decision == null ? null : String(o.decision);
    if (decision !== C.APPROVAL_STATE.APPROVED && decision !== C.APPROVAL_STATE.REJECTED) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED,
        ['a-decision-must-be-approved-or-rejected'], { decision: decision });
    }
    const decider = partyInput(o.decidedBy != null ? o.decidedBy : (o.decidedById != null ? o.decidedById : o.by));
    if (!decider.ok) return denial(C.DENY_REASON.PARTY_NOT_ALLOWED, ['a-decision-must-name-the-deciding-party'], { errors: decider.errors });
    if (decider.party.type === C.PARTY_TYPE.SYSTEM) {
      return denial(C.DENY_REASON.PARTY_NOT_ALLOWED, ['system-party-cannot-decide-an-approval'], { deciderId: String(decider.party.id) });
    }
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    const row = db.prepare(SQL.selectApproval).get(approvalId);
    if (!row) {
      return denial(C.DENY_REASON.APPROVAL_NOT_FOUND, ['approval-not-found'], { approvalId: approvalId });
    }
    /* ★ self-approval：买方 == 决定者 ⇒ 拒绝。 */
    if (String(row.buyer_id) === String(decider.party.id) && String(row.buyer_type) === String(decider.party.type)) {
      return denial(C.DENY_REASON.PARTY_NOT_ALLOWED,
        ['the-buyer-cannot-approve-its-own-purchase'],
        {
          approvalId: approvalId,
          buyerId: partyKeyOf(row.buyer_type, row.buyer_id),
          deciderId: partyKeyOf(decider.party.type, decider.party.id),
          selfApprovalRejected: true
        });
    }
    const gate = C.assertApprovalTransition(String(row.status), decision);

    /* ── 幂等闸门**排在状态闸门之前**（与 P22-3 的 commit/release、
         P22-6 的 cancel 同一条纪律）─────────────────────────────────────
       ★ 这里曾经把 assertApprovalTransition 写在幂等查找**之前**，那是一
       个真实缺陷（开发期实测）：一次成功的决定之后，它的重放会先撞上状态
       闸门 —— 因为 APPROVED 不是 PENDING，于是重放收到
       `TRANSITION_NOT_ALLOWED`，而不是**当初那个结果**。
       "一次成功的决定，它的重放必须返回当初那个结果"正是幂等的定义；把
       状态检查放在它前面，会让"这条批准被批准过没有"对一个重试的调用方
       永远回答"不，它已经不是待决定状态了"。
       终态判定仍然对**新 key** 的请求生效（见下面的 gate2）。 */
    const fingerprint = purchaseFingerprint(C.OPERATION_SCOPE.APPROVAL_DECIDE, {
      approvalId: approvalId, decision: decision,
      decidedBy: partyKeyOf(decider.party.type, decider.party.id)
    });
    const seen = operationIdempotencyLookup(C.OPERATION_SCOPE.APPROVAL_DECIDE, key.key, fingerprint);
    if (seen.found && seen.conflict) return operationIdempotencyConflict(C.OPERATION_SCOPE.APPROVAL_DECIDE, key.key, seen);
    if (seen.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: seen.result };

    /* 状态闸门在这里做**快速失败**（重放已经被上面接走了）。 */
    if (gate.allowed !== true) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, gate.errors, {
        approvalId: approvalId, approvalStatus: String(row.status), to: decision,
        terminal: gate.terminal === true, hint: gate.hint
      });
    }

    const at = clock();
    let committed = null;
    /* ★ 终局路径（有效期内没被决定）用它**自己**的变量 —— 见事务里那段说明。 */
    let expiredOutcome = null;
    try {
      withTransaction(() => {
        const locked = db.prepare(SQL.selectApproval).get(approvalId);
        if (!locked) throw refuse(C.DENY_REASON.APPROVAL_NOT_FOUND, ['approval-not-found'], { approvalId: approvalId });
        /* 过期检查在**写锁里**再做一次：一条已经过了 expires_at 的 PENDING
           不能被批准 —— 否则"过期"这件事可以被一次恰好赶到的点击绕过。 */
        if (Number(locked.expires_at) <= at) {
          const revExpired = allocateRevision();
          const expired = db.prepare(SQL.setApprovalExpired).run(
            C.APPROVAL_STATE.EXPIRED, Number(revExpired), Number(at),
            approvalId, C.APPROVAL_STATE.PENDING
          );
          if (Number(expired.changes) !== 1) {
            throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['approval-expiry-affected-no-row']);
          }
          appendChange({
            revision: Number(revExpired), kind: C.EVENT_TYPE.APPROVAL_EXPIRED,
            entityId: approvalId, transactionId: null, walletId: null, at: Number(at),
            payload: {
              domain: C.DOMAIN, approvalId: approvalId,
              approvalStatus: C.APPROVAL_STATE.EXPIRED,
              fromStatus: C.APPROVAL_STATE.PENDING,
              expiresAt: Number(locked.expires_at),
              consumedByPurchaseId: null,
              ledgerMutation: false, inventoryMutation: false
            }
          });
          faultPoint('before-approval-decision-commit');
          /* ★ 终局路径写进**它自己**的变量，而不是共用的 `committed`。
             一个真实缺陷（开发期实测）：两者共用一个变量会撞上下面那句
             `committed.terminal === true` 的判据 —— 而**一次成功的 REJECTED
             决定的 result 上也带着 terminal: true**（那条批准现在处在终态）。
             于是每一次成功的摇头都被当成"批准过期了"，返回出去的是一个
             **没有 ok 字段**的裸对象。形状必须由"这件事是不是成功了"决定，
             而不由"结果里某个字段的值"决定 —— 这与 P22-6 settlePurchase 的
             那条同源教训逐字相同。 */
          expiredOutcome = {
            ok: false, denied: true, terminal: true,
            reasonCode: C.DENY_REASON.APPROVAL_EXPIRED,
            errors: ['approval-expired-before-the-decision'],
            approvalId: approvalId,
            approvalStatus: C.APPROVAL_STATE.EXPIRED,
            requestedDecision: decision,
            decidedAt: null,
            consumedByPurchaseId: null,
            purchaseCreated: false,
            ledgerMutation: false,
            inventoryMutation: false,
            revision: Number(revExpired),
            at: Number(at)
          };
          return;
        }
        const gate2 = C.assertApprovalTransition(String(locked.status), decision);
        if (gate2.allowed !== true) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, gate2.errors,
            { approvalStatus: String(locked.status), to: decision, terminal: gate2.terminal === true });
        }
        const rev = allocateRevision();
        const moved = db.prepare(SQL.setApprovalDecided).run(
          decision, String(decider.party.id), String(decider.party.type),
          Number(rev), Number(at), Number(at), approvalId, String(locked.status)
        );
        if (Number(moved.changes) !== 1) {
          /* 另一个 writer 抢先决定了它 —— 整体回滚，不覆盖任何决定。 */
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['approval-was-decided-by-another-writer'], {
            approvalId: approvalId, expectedStatus: String(locked.status)
          });
        }
        faultPoint('after-approval-decided');

        const view = rowToApproval(db.prepare(SQL.selectApproval).get(approvalId));
        const result = Object.assign(serializeApproval(view), {
          revision: Number(rev),
          at: Number(at),
          idempotencyKey: key.key,
          decision: decision,
          purchaseCreated: false,
          ledgerMutation: false,
          inventoryMutation: false
        });
        appendChange({
          revision: Number(rev),
          kind: decision === C.APPROVAL_STATE.APPROVED ? C.EVENT_TYPE.APPROVAL_APPROVED : C.EVENT_TYPE.APPROVAL_REJECTED,
          entityId: approvalId, transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN,
            approvalId: approvalId,
            buyerId: partyKeyOf(locked.buyer_type, locked.buyer_id),
            recipientId: locked.recipient_id == null ? null : partyKeyOf(locked.recipient_type, locked.recipient_id),
            productId: String(locked.product_id),
            quoteId: String(locked.quote_id),
            currency: String(locked.currency),
            amountMinor: C.serializeAmountMinor(fromSqlAmount(locked.amount_minor, 'approval-amount')),
            approvalStatus: decision,
            fromStatus: C.APPROVAL_STATE.PENDING,
            decidedBy: partyKeyOf(String(decider.party.type), String(decider.party.id)),
            bindingFingerprint: String(locked.binding_fingerprint),
            purchaseCreated: false,
            ledgerMutation: false, inventoryMutation: false,
            providerMutation: false, paymentMutation: false,
            memoryMutation: false, relationshipMutation: false
          }
        });
        faultPoint('before-approval-decision-commit');
        writeOperationIdempotency(C.OPERATION_SCOPE.APPROVAL_DECIDE, key.key, fingerprint,
          { approvalId: approvalId, decision: decision, transactionId: null }, result, Number(rev), at);
        committed = result;
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }
    pruneOperationIdempotency(at);
    if (expiredOutcome != null) {
      logger('economy-approval-expired-at-decision', { approvalId: approvalId, requestedDecision: decision });
      return expiredOutcome;
    }
    logger('economy-approval-decided', {
      approvalId: approvalId, decision: decision,
      decidedBy: committed.decidedBy, revision: committed.revision
    });
    return { ok: true, replayed: false, idempotencyKey: key.key, result: committed };
  }

  /* ── expireApproval / expireDueApprovals（§9）─────────────────────────
     到期判定与 P22-3/P22-4 的 expire 类同款：**比较**，不是定时器。
     PENDING → EXPIRED 与 APPROVED → EXPIRED 两条边都由状态机允许，
     而终态（REJECTED / CONSUMED）永远不会被它碰到。 */
  function expireApproval(input) {
    requireOpen();
    const o = input || {};
    const approvalId = o.approvalId == null ? null : String(o.approvalId);
    if (!C.isEconomyId('APPROVAL', approvalId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-id-not-canonical'] };
    }
    const row = db.prepare(SQL.selectApproval).get(approvalId);
    if (!row) return denial(C.DENY_REASON.APPROVAL_NOT_FOUND, ['approval-not-found'], { approvalId: approvalId });
    const at = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(at) || at < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    if (Number(row.expires_at) > at) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['approval-is-not-past-its-expires-at'], {
        approvalId: approvalId, approvalStatus: String(row.status),
        expiresAt: Number(row.expires_at), now: Number(at)
      });
    }
    if (C.isApprovalTerminalState(String(row.status))) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['approval-is-already-terminal'], {
        approvalId: approvalId, approvalStatus: String(row.status), terminal: true
      });
    }
    const gate = C.assertApprovalTransition(String(row.status), C.APPROVAL_STATE.EXPIRED);
    if (gate.allowed !== true) {
      return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, gate.errors, { approvalStatus: String(row.status), hint: gate.hint });
    }
    const from = String(row.status);
    let revision = null;
    try {
      withTransaction(() => {
        const rev = allocateRevision();
        const moved = db.prepare(SQL.setApprovalExpired).run(
          C.APPROVAL_STATE.EXPIRED, Number(rev), Number(at), approvalId, from
        );
        if (Number(moved.changes) !== 1) {
          throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['approval-expiry-affected-no-row']);
        }
        appendChange({
          revision: Number(rev), kind: C.EVENT_TYPE.APPROVAL_EXPIRED,
          entityId: approvalId, transactionId: null, walletId: null, at: Number(at),
          payload: {
            domain: C.DOMAIN, approvalId: approvalId,
            approvalStatus: C.APPROVAL_STATE.EXPIRED, fromStatus: from,
            expiresAt: Number(row.expires_at),
            consumedByPurchaseId: null,
            ledgerMutation: false, inventoryMutation: false
          }
        });
        revision = Number(rev);
      });
    } catch (error) {
      const refusal = translateRefusal(error);
      if (!refusal) throw error;
      return refusal;
    }
    logger('economy-approval-expired', { approvalId: approvalId, fromStatus: from, revision: revision });
    return {
      ok: true, replayed: false,
      result: { approvalId: approvalId, approvalStatus: C.APPROVAL_STATE.EXPIRED, fromStatus: from, revision: revision, at: Number(at) }
    };
  }

  function expireDueApprovals(options) {
    requireOpen();
    const o = options || {};
    const at = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(at) || at < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const limit = normalizeLimit(o.limit, 100, 1000);
    const rows = db.prepare(SQL.selectExpiredApprovals).all(Number(at), Number(limit));
    const expired = [];
    for (const row of rows) {
      const out = expireApproval({ approvalId: String(row.approval_id), now: at });
      /* 一条已经被另一个 writer 终结的批准会让这里返回拒绝 —— 那是
         **正常**的，不是失败：扫描不重试、不报错，只把它跳过。 */
      if (out.ok === true) expired.push(out.result.approvalId);
    }
    return { ok: true, expired: expired, count: expired.length, at: Number(at), isATimer: false };
  }

  function getApproval(input) {
    requireOpen();
    const o = input || {};
    if (o.approvalId == null) {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-id-required'] };
    }
    const approvalId = String(o.approvalId);
    if (!C.isEconomyId('APPROVAL', approvalId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-id-not-canonical'] };
    }
    const row = db.prepare(SQL.selectApproval).get(approvalId);
    if (!row) return denial(C.DENY_REASON.APPROVAL_NOT_FOUND, ['approval-not-found'], { approvalId: approvalId });
    /* ★ 返回的是 **serialize** 过的视图（而不是裸的 rowToApproval 输出）。
       理由与 P22-6 的 getPurchase 同源：一个实体只有一个对外形态。裸视图
       缺少那八句"这条批准**不是**一笔购买 / 不是预算豁免 / 一次性 / 绑定
       于报价快照"的自述，于是"读一条批准"与"读一批批准"会给出两种形状 ——
       而 `binding`（九元组本身）仍然逐字带着，它是这条记录的**内容**，
       不是一句自述。 */
    const view = rowToApproval(row);
    return { ok: true, approval: Object.assign(serializeApproval(view), { binding: view.binding }) };
  }

  function listApprovals(options) {
    requireOpen();
    const o = options || {};
    const limit = normalizeLimit(o.limit, 50, 500);
    const buyerId = o.buyerId == null ? null : String(o.buyerId);
    const quoteId = o.quoteId == null ? null : String(o.quoteId);
    const status = o.status == null ? null : String(o.status);
    if (status != null && !C.isApprovalState(status)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-status-not-in-closed-set'], allowed: C.APPROVAL_STATES };
    }
    const rows = db.prepare(SQL.selectApprovalsFiltered).all(
      buyerId, buyerId, quoteId, quoteId, status, status, Number(limit)
    );
    return {
      ok: true,
      approvals: rows.map(r => serializeApproval(rowToApproval(r))),
      count: rows.length,
      personalized: false, recommended: false, ranked: false
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-8 §3–§14 · Agent Purchase Intent（Decision Bridge 的 canonical 一半）

     这一块是"模型说出它想买什么"与"canonical Economy 决定能不能买"之间
     的**唯一**接缝，而它的形状是被 §14 钉死的：

       窄接口 proposeAgentPurchaseIntent(proposal)  →  确定性 runtime 接管

     ★ 为什么这里**没有** executeEconomyAction(modelOutput) 这种东西：
     一个"让模型指定 method"的通用入口会把下面整块变成一句"模型可以调用
     settlePurchase"。本块的公开面只有三个动词（propose / resume /
     读），而它们各自接受的字段是**封闭白名单**。

     ★ 三层各守各的边界，逐字对应 §1 的三句话：
         Agent decides WANT   → proposeAgentPurchaseIntent（本块）
         Economy decides MAY  → evaluateAutonomousPurchaseFor（P22-7）
         Runtime executes     → preparePurchase / settlePurchase（P22-6）

     ★ 本块**从不**自己扣钱、发资产、写 ledger。它只调用 P22-6 的两个
     canonical 入口，而那两个入口自己带事务、预算复核、幂等与原子结算。
     ══════════════════════════════════════════════════════════════════ */

  /* ── 读面（§17）──────────────────────────────────────────────────────
     `reasonIsAuthority: false` 与 reason 并列出现是刻意的：一个读到
     agent 理由的消费者，**同时**读到"它不是权限"。 */
  function rowToPurchaseIntent(row) {
    const state = String(row.state);
    return {
      domain: C.DOMAIN,
      namespace: C.NAMESPACES.AGENT_INTENT,
      agentIntentId: String(row.agent_intent_id),
      state: state,
      terminal: C.isPurchaseIntentTerminalState(state),
      /* §8：这一句在每一个读面上都在。 */
      stateIsAnOrchestrationFact: true,
      stateIsNotAnEconomicFact: true,

      agentId: String(row.agent_id),
      agentType: String(row.agent_type),
      agentRef: Object.freeze({ type: String(row.agent_type), id: String(row.agent_id) }),
      productId: String(row.product_id),
      recipientId: row.recipient_id == null ? null : String(row.recipient_id),
      recipientType: row.recipient_id == null ? null : String(row.recipient_type),
      recipientRef: row.recipient_id == null ? null
        : Object.freeze({ type: String(row.recipient_type), id: String(row.recipient_id) }),
      selfDirected: Number(row.self_directed) === 1,
      units: Number(row.units),
      storeId: row.store_id == null ? null : String(row.store_id),

      quoteId: row.quote_id == null ? null : String(row.quote_id),
      approvalId: row.approval_id == null ? null : String(row.approval_id),
      purchaseId: row.purchase_id == null ? null : String(row.purchase_id),

      authorityOutcome: row.authority_outcome == null ? null : String(row.authority_outcome),
      authorityReasonCode: row.authority_reason_code == null ? null : String(row.authority_reason_code),
      reasonCode: row.reason_code == null ? null : String(row.reason_code),

      /* ── §3：reason 是**解释文本**，它在这一行里被逐字标明身份 ──────── */
      reason: row.reason == null ? null : String(row.reason),
      reasonIsAuthority: false,
      reasonIsTelemetry: true,
      reasonParticipatesInDecisions: false,

      intentFingerprint: String(row.intent_fingerprint),
      idempotencyKey: String(row.idempotency_key),
      fingerprint: String(row.fingerprint),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      expiresAt: Number(row.expires_at),
      expiredByTime: !C.isPurchaseIntentTerminalState(state) && Number(row.expires_at) <= clock(),
      completedAt: row.completed_at == null ? null : Number(row.completed_at)
    };
  }

  function serializePurchaseIntent(view) {
    const out = {};
    for (const k of C.PURCHASE_INTENT_SUMMARY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(view, k)) out[k] = view[k];
    }
    return out;
  }

  /* ── 参与者归一化（与 P22-6 的 partyInput 同一条纪律）────────────────
     ★ 契约层校验**语法**（非空、无冒号、有界），store 校验**语义**
     （这个 id 是一个用户还是角色）。两层都要：只有语法会让 'nobody'
     变成一笔"给不存在的角色"的礼物；只有语义会让一个带注入字符的 id
     被当成角色名。 */
  function intentPartyOf(value, label) {
    const shape = C.normalizeIntentPartyId(value);
    if (!shape.ok) return { ok: false, party: null, errors: shape.errors.map(e => (label || 'party') + ':' + e) };
    const ref = partyInput(shape.id);
    if (!ref || ref.ok !== true) {
      return { ok: false, party: null, errors: (ref && ref.errors) || [(label || 'party') + ':invalid'] };
    }
    if (ref.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, party: null, errors: [(label || 'party') + ':system-party-is-not-an-agent'] };
    }
    return { ok: true, party: ref.party, errors: [] };
  }

  /* ── §3：canonical 提议的**唯一**规范化出口 ──────────────────────────
     契约的 normalizePurchaseIntentProposal 只做形状；这里补上 store 才知道
     的事：这个 agent 在不在、这个商品在不在。 */

  /* ── 状态推进的唯一出口 ──────────────────────────────────────────────
     两个闸门叠在一起，而它们拦的是**不同**的东西：
       · C.assertPurchaseIntentTransition —— "这条迁移在状态机里存在吗"
         （§8 的三条禁令在这里被执行）；
       · SQL 的 `AND state=?` —— "我读到的那个状态现在还是那个状态吗"
         （两个进程同时推进时的乐观并发闸门）。

     ★ 为什么两者都要：第一条是**规则**，第二条是**并发**。只有规则会让
     两个进程都通过检查、然后都写；只有并发会让一条 COMPLETED 的 intent
     被推进到 EXECUTING（因为 UPDATE 的谓词恰好匹配）。
     与 approvals / purchases 的 setXxx 同款，而这里多一层 assert 是因为
     intent 的合法迁移比那两者更"分叉"（PROPOSED 有五个出口）。 */
  function transitionPurchaseIntent(intentId, fromState, toState, columns) {
    const cols = columns || {};
    const from = String(fromState);
    const to = String(toState);
    const allowed = C.assertPurchaseIntentTransition(from, to);
    if (allowed.allowed !== true) {
      return { ok: false, reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE, transition: allowed };
    }
    const row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    if (!row) return { ok: false, reasonCode: null, errors: ['intent-not-found'] };
    if (String(row.state) !== from) {
      /* 另一个进程先动了。返回它**当前**的状态，于是调用方不需要再查一次。 */
      return {
        ok: false,
        reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE,
        concurrent: true,
        currentState: String(row.state),
        errors: ['intent-state-changed-under-the-transition']
      };
    }
    const rev = allocateRevision();
    const at = clock();
    const info = db.prepare(SQL.setPurchaseIntentState).run(
      to,
      cols.quoteId === undefined ? row.quote_id : (cols.quoteId == null ? null : String(cols.quoteId)),
      cols.approvalId === undefined ? row.approval_id : (cols.approvalId == null ? null : String(cols.approvalId)),
      cols.purchaseId === undefined ? row.purchase_id : (cols.purchaseId == null ? null : String(cols.purchaseId)),
      cols.authorityOutcome === undefined
        ? row.authority_outcome : (cols.authorityOutcome == null ? null : String(cols.authorityOutcome)),
      cols.authorityReasonCode === undefined
        ? row.authority_reason_code : (cols.authorityReasonCode == null ? null : String(cols.authorityReasonCode)),
      cols.reasonCode === undefined ? row.reason_code : (cols.reasonCode == null ? null : String(cols.reasonCode)),
      cols.completedAt === undefined ? row.completed_at : (cols.completedAt == null ? null : Number(cols.completedAt)),
      Number(rev), Number(at),
      String(intentId), from
    );
    if (Number(info.changes) !== 1) {
      return {
        ok: false,
        reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE,
        concurrent: true,
        errors: ['intent-state-changed-under-the-transition']
      };
    }
    return { ok: true, revision: Number(rev), at: Number(at), from: from, to: to };
  }

  /* 一条 intent 的每一次结局都写一行 change log。它**不是**经济事件：
     ledgerMutation / inventoryMutation 全 false —— Intent 自己从不动钱。 */
  function appendIntentChange(intent, eventType, payload) {
    const rev = allocateRevision();
    appendChange({
      revision: Number(rev),
      kind: eventType,
      entityId: String(intent.agentIntentId),
      transactionId: intent.purchaseId == null ? null : String(intent.purchaseId),
      walletId: null,
      at: Number(clock()),
      payload: Object.assign({
        domain: C.DOMAIN,
        agentIntentId: String(intent.agentIntentId),
        agentId: String(intent.agentId),
        agentType: String(intent.agentType),
        productId: String(intent.productId),
        recipientId: intent.recipientId,
        quoteId: intent.quoteId,
        approvalId: intent.approvalId,
        purchaseId: intent.purchaseId,
        ledgerMutation: false,
        inventoryMutation: false,
        providerMutation: false,
        paymentMutation: false,
        memoryMutation: false,
        relationshipMutation: false
      }, payload || {})
    });
    return Number(rev);
  }

  /* ── §7 的准入审计（P22-9）──────────────────────────────────────────
     这条方法**不是**门的一部分：门在 economy-capability.js 里，它决定
     ALLOW / DENY。这里只做一件事 —— 把一次已经发生的准入决定**如实**记进
     canonical change log。

     ★ 为什么它必须由 store 写，而不是由门自己开一张表：
       审计事实只能有一个地方，而这个仓库里"经济事实的唯一真源"是
       economy_store.db 的 change log。门自建一张表会让"这台机器上发生过
       什么"变成两个答案。

     ★ 为什么 store 要**重新校验**它被要求写下的 consumer / capability：
       那是"伪造一行审计"在结构上不成立的地方。一个不在闭集里的 consumer
       （例如模型输出的 'gpt'）写不下去 —— 这不是一条策略，是一次类型错误。
       如果这里只是 `String(o.consumerId)`，那么"consumer 身份不得来自
       模型输出"就退化成一句注释。

     ★ 为什么它不是一次经济动作：record 里的六个 mutation 位全 false，
       而且它**不参与**任何判定 —— 没有任何经济路径读这张行来决定什么。 */
  function appendCapabilityAudit(input) {
    requireOpen();
    const o = input || {};
    const made = C.makeCapabilityAuditRecord({
      consumerId: o.consumerId,
      capability: o.capability,
      decision: o.decision,
      reasonCode: o.reasonCode == null ? null : o.reasonCode,
      agentIntentId: o.agentIntentId == null ? null : o.agentIntentId
    });
    if (made.ok !== true) {
      /* 一行都写不下去。调用方会把这个失败**带出去**（门把它放进
         `auditFailure`），而不是被这里吞掉。 */
      return { ok: false, denied: false, reasonCode: null, errors: made.errors, written: false };
    }
    const record = made.record;
    /* entity_id 指向这次决定**关于**的那件事：有 intent 时是那条 intent
       （于是"哪个 consumer 提出了它"与那条 intent 在 change log 里同键），
       没有 intent 时（一次被拒的提议）是提出请求的 consumer。 */
    const entityId = record.agentIntentId == null ? String(record.consumerId) : String(record.agentIntentId);
    const out = withTransaction(() => {
      const rev = allocateRevision();
      appendChange({
        revision: Number(rev),
        kind: C.EVENT_TYPE.ECONOMY_CAPABILITY_DECIDED,
        entityId: entityId,
        transactionId: null,
        walletId: null,
        at: Number(clock()),
        payload: record
      });
      return { ok: true, revision: Number(rev), kind: C.EVENT_TYPE.ECONOMY_CAPABILITY_DECIDED, entityId: entityId, written: true };
    });
    return out;
  }

  /* ── §10 的重复抑制查询 ───────────────────────────────────────────── */
  function suppressingIntentFor(intentFingerprint, at) {
    const since = Number(at) - C.PURCHASE_INTENT_DEDUPE_WINDOW_MS;
    const rows = db.prepare(SQL.selectSuppressingIntents).all(String(intentFingerprint), since);
    return rows.length ? rows[0] : null;
  }

  /* ── §11 幂等读：找一个 (key, fingerprint) 的既有 intent ──────────── */
  function intentByIdempotencyKey(key, fingerprint) {
    const row = db.prepare(SQL.selectPurchaseIntentIdempotency).get(String(key), String(fingerprint));
    if (row) return { found: true, conflict: false, row: row };
    const any = db.prepare(SQL.selectPurchaseIntentByIdempotencyKey).get(String(key));
    if (any) {
      return {
        found: true, conflict: true, row: any,
        storedFingerprint: String(any.fingerprint),
        presentedFingerprint: String(fingerprint)
      };
    }
    return { found: false, conflict: false, row: null };
  }

  const EXECUTABLE_INTENT_STATES = Object.freeze([
    C.PURCHASE_INTENT_STATE.PROPOSED,
    C.PURCHASE_INTENT_STATE.WAITING_APPROVAL
  ]);

  /* ── ★★ 执行权的**唯一**闸门（多进程实测逼出来的设计）────────────────
     两个真实进程同时提同一份提议（模型复读的形态）时，两者都会认为
     "这条 intent 可以执行"。若两者都去执行，它们会各自 prepare 同一份
     报价（P22-6 的幂等闸门会给出**同一笔**购买 —— 那是幂等性在起作用，
     不是缺陷），而随后两条路径会各自把 purchase 挂到同一条 intent 上、
     各自尝试结算 —— 症状是"赢家报 COMPLETED，输家报 QUOTE_MISMATCH"，
     也就是**两个进程读到两个世界**。

     修法不是在各个闸门上打补丁，而是让"能不能执行"这个问题只有**一个**
     答案、而且只能有**一个**赢家：

       把 state 从 {PROPOSED, WAITING_APPROVAL} 原子地推到 EXECUTING。
       一条 `UPDATE ... WHERE agent_intent_id=? AND state=?` 恰好只有一个
       进程能拿到 changes=1 —— 而**state 本身就是执行权的令牌**。
       拿到的人执行；没拿到的人不再尝试，而是等赢家写下结局
       （见 waitForIntentEndpoint）。

     ★ 为什么这个闸门不能提前到 propose 的更上游（例如"只有创建 intent 的
     那个人能执行"）：崩溃恢复要求**任何**进程都能接着把一条 EXECUTING 的
     intent 做完 —— 令牌是**状态**，不是进程身份。 */
  function claimIntentForExecution(intentId) {
    const row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    if (!row) return { ok: false, owned: false, errors: ['intent-not-found'] };
    const from = String(row.state);
    if (from === C.PURCHASE_INTENT_STATE.EXECUTING) {
      /* 已经有人在执行（或者它是崩溃留下的）。★ 这里**不**抢：抢会让
         两个进程同时跑 prepare。返回 owned:false，由调用方去等结局；
         如果那位执行者真的崩了，它留下的 EXECUTING 会在**下一次**调用里
         被同一句话读到，而那时……它仍然不会抢。因此下面还有一条出口。 */
      return { ok: true, owned: false, state: from, reason: 'already-executing' };
    }
    if (EXECUTABLE_INTENT_STATES.indexOf(from) < 0) {
      return { ok: true, owned: false, state: from, reason: 'not-executable' };
    }
    const rev = allocateRevision();
    const moved = db.prepare(SQL.setPurchaseIntentState).run(
      C.PURCHASE_INTENT_STATE.EXECUTING, row.quote_id, row.approval_id, row.purchase_id,
      row.authority_outcome, row.authority_reason_code, row.reason_code, row.completed_at,
      Number(rev), Number(clock()), String(intentId), from
    );
    if (Number(moved.changes) !== 1) {
      return { ok: true, owned: false, state: from, reason: 'lost-the-claim' };
    }
    return { ok: true, owned: true, from: from, revision: Number(rev) };
  }

  /* ── 等一条 intent 写下结局（输家的动作）─────────────────────────────
     ★ 判据是"**它到达了一个终态**"，而不是"它不再是我输掉的那个瞬态"。
     开发期实测（D 组）踩到的一次真实竞态，值得逐字写下来：

       赢家：领走 → EXECUTING → prepare → attach → settle → COMPLETED
       输家：claim 失败 → 等

     输家在一次**不巧**的采样上会看到赢家刚领走、还没推进的那一行
     （state 仍是 PROPOSED、quote_id 还是 NULL）。若那时就返回，两个进程
     会报告两个世界。中间态 EXECUTING 同样不够 —— 那时赢家还没写完结局。
     只有**终态**才是一个可以对外回答的读数。
     60 × 25ms = 1.5 秒的上界是量出来的：一次 AUTO_ALLOW 的完整执行
     （报价 → 权威 → 准备 → 结算 → 完成）在本机上约 30～80ms。 */
  function waitForIntentEndpoint(intentId) {
    /* ★★ 循环的形状是**先等再读**，而不是先读再等。开发期实测（D 组，
       两个进程同时提同一份提议）踩到的一次真实竞态，而它值得逐字写下来：

       输家在一次**不巧**的采样上会读到赢家**刚领走、还没把结局写完**的
       那一行（state 仍是 PROPOSED）—— 甚至读到赢家领走**之前**的那一版。
       如果循环是"先判、再等"，那个陈旧样本会让第一次迭代立刻 `break`，
       于是输家报 PROPOSED、赢家报 COMPLETED：两个进程读到两个世界。

       先等一个采样周期再读，就把"我读到的是不是别人的中间态"这个问题交给
       时间解决 —— 而 60 × 25ms = 1.5 秒的上界是量出来的：一次 AUTO_ALLOW
       的完整执行（报价 → 权威 → 准备 → 结算 → 完成）在本机上约 30～80ms，
       即使两个进程在同一个 SQLite 文件上互相等锁也远低于这个上界。 */
    let current = null;
    for (let i = 0; i < 60; i += 1) {
      const until = Date.now() + 25;
      while (Date.now() < until) { /* 有界等待：让执行者把结局写完 */ }
      current = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
      if (current != null && C.isPurchaseIntentTerminalState(String(current.state))) break;
    }
    return current;
  }

  /* 输家（或任何"这条 intent 已经不属于我"的调用方）的统一出口。
     ★ 它**不**伪装成功，也不把瞬态当成结局：读到终态就如实返回终态，
     读到中间态就如实说"另一个进程正在处理它"。 */
  function endpointOfIntentAfterLoss(intentId) {
    const current = waitForIntentEndpoint(intentId);
    const view = current == null ? null : rowToPurchaseIntent(current);
    const state = current == null ? null : String(current.state);
    if (state === C.PURCHASE_INTENT_STATE.COMPLETED) {
      return {
        ok: true, replayed: true, alreadyCompleted: true,
        intentId: String(intentId),
        intent: view,
        purchaseId: current.purchase_id == null ? null : String(current.purchase_id),
        quoteId: current.quote_id == null ? null : String(current.quote_id),
        approvalId: current.approval_id == null ? null : String(current.approval_id),
        mayExecute: false, nextAction: 'none',
        purchaseCreated: false, completedByAnotherProcess: true
      };
    }
    if (C.isPurchaseIntentTerminalState(state)) {
      /* DENIED / EXPIRED / FAILED：那是**结局**，不是"我正在忙"。 */
      return {
        ok: true, replayed: true, terminal: true,
        intentId: String(intentId),
        intent: view,
        reasonCode: view == null ? null : view.reasonCode,
        mayExecute: false, nextAction: 'none',
        purchaseCreated: false, terminalByAnotherProcess: true
      };
    }
    return {
      ok: true, replayed: true,
      intentId: String(intentId),
      intent: view,
      quoteId: current == null || current.quote_id == null ? null : String(current.quote_id),
      approvalId: current == null || current.approval_id == null ? null : String(current.approval_id),
      mayExecute: false,
      nextAction: state === C.PURCHASE_INTENT_STATE.EXECUTING ? 'execute' : 'none',
      claimedByAnotherProcess: true,
      reservedNothing: true,
      purchaseCreated: false
    };
  }

  function intentOutcomeOf(row) {
    return {
      agentIntentId: String(row.agent_intent_id),
      state: String(row.state),
      quoteId: row.quote_id == null ? null : String(row.quote_id),
      approvalId: row.approval_id == null ? null : String(row.approval_id),
      purchaseId: row.purchase_id == null ? null : String(row.purchase_id),
      authorityOutcome: row.authority_outcome == null ? null : String(row.authority_outcome),
      reasonCode: row.reason_code == null ? null : String(row.reason_code)
    };
  }

  /* ── §5 Intent → Product-backed Quote ───────────────────────────────
     价格**只能**从 canonical Product 派生：createProductQuote 的参数列表里
     没有 amountMinor / currency / quantity / kind，因此"模型指定价格"在这
     一层不是被拒绝，而是**没有地方可放**。

     ★ 报价的有效期与 intent 的有效期是**同一个数**。这不是省事：§7 要求
     "批准不得复活已经过期的报价"，而如果 intent 活得比它的报价久，那么
     "intent 还有效但报价已经死了"就会变成一个只能靠运行时兜的缝隙。
     两者同寿之后，"intent 没过期"蕴含"它那份报价也没过期" —— 不变量，
     而不是检查。 */
  function ensureIntentQuote(intent, productRow, at) {
    if (intent.quoteId != null) {
      const existing = db.prepare(SQL.selectQuote).get(String(intent.quoteId));
      if (!existing) {
        return { ok: false, reasonCode: C.DENY_REASON.QUOTE_MISMATCH, errors: ['intent-names-a-quote-that-does-not-exist'] };
      }
      return { ok: true, quoteRow: existing, created: false };
    }
    /* ★ 报价 id 由 intent 确定性派生 —— 于是"同一条 intent 的报价"永远是
       同一份，重放时找到的是它而不是第二份。前缀仍然是 econ_quote_，
       因为它的**种类**就是报价（P22-4 冻结），只是名字里指出了出处。 */
    const derived = C.formatEconomyId('QUOTE', 'from_' + String(intent.agentIntentId).replace(/^econ_agentintent_/, ''));
    if (derived.ok !== true) {
      return { ok: false, reasonCode: C.DENY_REASON.QUOTE_MISMATCH, errors: derived.errors };
    }
    const quoteId = derived.id;
    const existing = db.prepare(SQL.selectQuote).get(quoteId);
    if (existing) return { ok: true, quoteRow: existing, created: false };

    const created = createProductQuote({
      productId: String(intent.productId),
      buyerId: String(intent.agentId),
      recipientId: intent.recipientId,
      units: Number(intent.units),
      expiresAt: Number(intent.expiresAt),
      quoteId: quoteId,
      idempotencyKey: 'econ.intent.quote+' + String(intent.agentIntentId)
    });
    if (created.ok !== true) {
      return {
        ok: false,
        denial: created,
        reasonCode: created.reasonCode == null ? C.DENY_REASON.PRODUCT_DISABLED : created.reasonCode,
        errors: created.errors || []
      };
    }
    const row = db.prepare(SQL.selectQuote).get(quoteId);
    if (!row) return { ok: false, reasonCode: C.DENY_REASON.QUOTE_MISMATCH, errors: ['quote-vanished-after-creation'] };
    /* ── §16 第二个可崩溃边界：**Quote created** ────────────────────────
       ★ 这个点排在 attachPurchaseIntentQuote **之前**，因此命中时那条
       intent 仍然停在 PROPOSED、而它手里**没有** quote_id —— 于是"崩溃
       落在报价已建、绑定未写"这个缝上时，恢复路径必须能从"一条 PROPOSED
       的 intent"重新走到同一份报价（报价 id 由 intent 确定性派生，因此
       第二次会找到**同一份**，而不是造第二份）。 */
    faultPoint('after-intent-quote-created');
    return { ok: true, quoteRow: row, created: true };
  }

  /* ── §6 权威输入的组装 ─────────────────────────────────────────────
     AUTO_ALLOW 需要两样东西递进 P22-6：那条策略的 id，与**九元组授权身份**。
     后者不是一个可以声明的值，而是从 canonical Quote 快照 + 商品行 +
     双方 party 重算出来的身份（P22-6 会在自己的写锁里**再算一遍**并逐字
     比对，因此这里算错只会被拒绝，不会被接受）。

     ★ 为什么 P22-8 要自己算一遍而不是让 P22-6 从 quote 推：因为
     `preparePurchase` 的入参里就要求它，而"授权身份"是**授权那一刻**的
     事实 —— P22-6 重算是为了证明它没被篡改，不是为了替代它。 */
  function intentBindingOf(quoteRow, productRow, buyerParty, recipientParty, units) {
    const binding = {
      buyerId: partyKeyOf(String(buyerParty.type), String(buyerParty.id)),
      recipientId: recipientParty == null ? null : partyKeyOf(String(recipientParty.type), String(recipientParty.id)),
      productId: String(quoteRow.product_id),
      quoteId: String(quoteRow.quote_id),
      currency: String(quoteRow.currency),
      amountMinor: fromSqlAmount(quoteRow.amount_minor, 'quote-amount'),
      settlementType: String(productRow.fulfillment),
      grantQuantity: C.productQuoteQuantity(rowToProduct(productRow), units).quantity,
      units: Number(units)
    };
    const fp = C.approvalFingerprint(binding);
    if (!fp.ok) return { ok: false, binding: binding, errors: fp.errors };
    return { ok: true, binding: binding, fingerprint: String(fp.fingerprint), errors: [] };
  }

  /* ── §6/§16 Phase A：创建 canonical Intent（可崩溃边界 #1）──────────
     这一次事务**只**做一件事：把那条 intent 写下来。它不读目录、不生成
     报价、不看权威。于是"Intent created"是一个真实的、可被崩溃打断的
     状态 —— 恢复路径必须能处理一个"存在但还没有报价"的 intent。 */
  function createIntentRow(proposal, key, intentFingerprint, at) {
    const intentId = nextId('AGENT_INTENT');
    if (!C.isEconomyId('AGENT_INTENT', intentId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['generated-id-not-canonical'] };
    }
    const fingerprint = purchaseFingerprint(C.OPERATION_SCOPE.AGENT_INTENT_PROPOSE, {
      agentId: proposal.agentId,
      productId: proposal.productId,
      recipientId: proposal.recipientId,
      units: proposal.units,
      selfDirected: proposal.selfDirected
      /* ★ `expiresAt` **刻意不在**这里。开发期实测踩到的一次真实缺陷：
         它一度在，于是"同一次提议请求"在两次调用之间（默认有效期按 now
         重新计算）会得到**两个不同的指纹**，而幂等闸门因此把一次纯重试
         读成"你换了另一个意图" —— 症状是第一条 intent 明明已经写下来了，
         调用方却收到 IDEMPOTENCY 冲突。
         更根本的理由与契约里"expiresAt 不进 intent 指纹"逐字同源：
         有效期是"这个打算我想到什么时候为止"，不是"这是哪一件事"。
         同一个 key 申请两次不同有效期仍然是**同一个**打算。 */
    });
    let suppressed = null;
    let committed = null;
    try {
      withTransaction(() => {
        const seen = intentByIdempotencyKey(key, fingerprint);
        if (seen.found && seen.conflict) {
          throw refuse(C.DENY_REASON.DUPLICATE_REQUEST, ['this-intent-key-was-used-for-a-different-intent'], {
            idempotencyKey: String(key),
            storedFingerprint: seen.storedFingerprint,
            presentedFingerprint: seen.presentedFingerprint,
            existingAgentIntentId: String(seen.row.agent_intent_id)
          });
        }
        if (seen.found) { committed = { replayedExisting: true, row: seen.row }; return; }
        suppressed = suppressingIntentFor(intentFingerprint, at);
        if (suppressed) { committed = { suppressedBy: String(suppressed.agent_intent_id) }; return; }
        const rev = allocateRevision();
        db.prepare(SQL.insertPurchaseIntent).run(
          intentId, String(proposal.agentId), String(proposal.agentType),
          String(proposal.productId),
          proposal.recipientId == null ? null : String(proposal.recipientId),
          proposal.recipientId == null ? null : String(proposal.recipientType),
          proposal.selfDirected ? 1 : 0,
          Number(proposal.units),
          null, null, null, null,
          C.PURCHASE_INTENT_STATE.PROPOSED,
          null, null, null,
          proposal.reason == null ? null : String(proposal.reason),
          String(intentFingerprint), String(key), String(fingerprint),
          Number(rev), Number(at), Number(at), Number(proposal.expiresAt),
          null
        );
        /* ── §16 第一个可崩溃边界：**Intent created** ────────────────────
           ★ 这一个点排在 COMMIT **之前**，因此命中时整条事务回滚 —— 库里
           连这条 intent 都不存在，"重试"就是一次干净的首次尝试。
           它与下面那几个点合起来覆盖 §16 点名的六个边界，而每一个都必须
           有它自己的可观察后果（否则"崩溃测试"只是在测一次正常路径）。 */
        faultPoint('after-intent-created');
        committed = { created: true };
      });
    } catch (error) {
      if (isRefusal(error)) {
        return denial(error.reasonCode, error.errors, Object.assign({
          domain: C.DOMAIN,
          idempotencyKey: String(key),
          agentIntentId: null,
          quoteId: null,
          createdAt: clock(),
          expiresAt: Number(proposal.expiresAt)
        }, error.extra || {}));
      }
      throw error;
    }
    if (committed.replayedExisting) {
      const row = db.prepare(SQL.selectPurchaseIntent).get(String(committed.row.agent_intent_id));
      return { ok: true, replayed: true, idempotencyKey: String(key), intent: rowToPurchaseIntent(row) };
    }
    if (committed.suppressedBy) {
      const row = db.prepare(SQL.selectPurchaseIntent).get(String(committed.suppressedBy));
      const suppressedView = rowToPurchaseIntent(row);
      const attempted = Object.assign(rowToPurchaseIntent(row), {
        agentIntentId: null,
        state: C.PURCHASE_INTENT_STATE.DENIED,
        terminal: true,
        reasonCode: C.DENY_REASON.DUPLICATE_REQUEST,
        reason: proposal.reason == null ? null : String(proposal.reason),
        expiresAt: Number(proposal.expiresAt),
        createdAt: Number(at)
      });
      return {
        ok: true,
        suppressed: true,
        suppressReason: 'DUPLICATE_INTENT_WINDOW',
        idempotencyKey: String(key),
        /* ★ 返回的是**已经存在**的那一条，而不是一条新的。§10 的"同一个
           模型输出重复 20 次不得买 20 次"就落在这一行上。 */
        intent: suppressedView,
        intentId: String(suppressed.agent_intent_id),
        attempted: attempted,
        /* 逐字：抑制不是预算。 */
        dedupeIsNotABudget: C.PURCHASE_INTENT_DEDUPE_IS_NOT_A_BUDGET,
        dedupeWindowMs: C.PURCHASE_INTENT_DEDUPE_WINDOW_MS
      };
    }
    const inserted = db.prepare(SQL.selectPurchaseIntent).get(intentId);
    return { ok: true, created: true, idempotencyKey: String(key), intent: rowToPurchaseIntent(inserted) };
  }

  /* ── §6 Phase B：报价 + 权威（可崩溃边界 #2）──────────────────────── */
  const RESOLVED_INTENT_STATES = Object.freeze([
    C.PURCHASE_INTENT_STATE.WAITING_APPROVAL,
    C.PURCHASE_INTENT_STATE.EXECUTING,
    C.PURCHASE_INTENT_STATE.COMPLETED,
    C.PURCHASE_INTENT_STATE.DENIED,
    C.PURCHASE_INTENT_STATE.EXPIRED,
    C.PURCHASE_INTENT_STATE.FAILED
  ]);

  function resolveIntent(intentId, options) {
    const o = options || {};
    requireOpen();
    let row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['intent-not-found'] };

    /* 已经定局（或已经越过 PROPOSED）：恢复路径要的是"现在能做什么"，
       而不是"再做一遍"。 */
    if (RESOLVED_INTENT_STATES.indexOf(String(row.state)) >= 0 && o.force !== true) {
      const view = rowToPurchaseIntent(row);
      return {
        ok: true, replayed: true, intent: view,
        mayExecute: String(row.state) === C.PURCHASE_INTENT_STATE.EXECUTING,
        nextAction: String(row.state) === C.PURCHASE_INTENT_STATE.EXECUTING ? 'execute' : 'none'
      };
    }

    /* ── ★★ 乐观闸门：把这条 intent 从 PROPOSED "领走" ──────────────────
       这是多进程实测暴露出的一个**真实竞态**，而不是一次理论担忧：

       两个真实进程同时提同一份提议（模型复读的形态）时，两者的
       (key, 指纹) 不同，因此**都**会走到这里；两者都在 §10 的重复窗口里
       看到对方（或都没看到），于是两条都尝试推进同一条 intent。
       没有这个闸门时，输的那一方会在状态推进处拿到 changes=0，然后返回
       一句 `intent-state-could-not-be-advanced` —— 而它的世界里那条 intent
       其实**已经被赢了的那一方推到 COMPLETED**。

       症状是"两个进程读到两个世界"，而正确答案只有一个。

       闸门的形状：把这条 intent 的 state 写成它**当前**的值（PROPOSED），
       并带一个 `AND state='PROPOSED'` 的谓词。于是：
         · 只有一个进程能拿到 changes=1（它领走了这条 intent）；
         · 其他的拿到 changes=0，并且**再读一次**那行 —— 那一次读到的是
           赢家写下的结局，于是它们返回同一个答案。
       这不是锁：没有任何进程被阻塞，输的一方只多做一次读。 */
    const claimRev = allocateRevision();
    const claim = db.prepare(SQL.setPurchaseIntentState).run(
      C.PURCHASE_INTENT_STATE.PROPOSED, row.quote_id, row.approval_id, row.purchase_id,
      row.authority_outcome, row.authority_reason_code, row.reason_code, row.completed_at,
      Number(claimRev), Number(clock()), String(intentId), C.PURCHASE_INTENT_STATE.PROPOSED
    );
    if (Number(claim.changes) !== 1) {
      /* ── 输了这一次领走：不是错误，而是"另一个进程正在替我们回答" ─────
         ★ 这里刻意**等一小会儿**再读，而不是立刻返回它当时看到的那一行。
         开发期实测（多进程崩溃组）踩到的一次真实竞态：赢家从领走到
         COMPLETED 要跨三次事务（报价 → 权威 → 执行），而输家如果立刻返回，
         它读到的是一行**还在 PROPOSED** 的 intent —— 于是它对外报告
         "mayExecute: false, nextAction: none"，而**真正**的结局（那笔
         购买）已经或即将由赢家写下。调用方于是拿到一个瞬态的半成品，
         而"两个进程读到两个世界"这条断言就是把这件事抓出来的。

         等待是**有界**的（见下面的循环），而且它只在竞争真的发生时发生：
         changes=1 的那条路一次都不等。等待结束后无论读到什么，返回的
         都是那一行的**真实**状态 —— 超时不会被伪装成成功。 */
      let current = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
      for (let i = 0; i < 60; i += 1) {
        /* ★★ 等待的判据是"**它到达了一个终态**"，而不是"它不再是我输掉的
           那个瞬态"。开发期实测（D 组，两个进程同时提同一份提议）踩到的
           一次真实竞态，而它值得被写下来：

             赢家：领走 → EXECUTING → prepare → attach → settle → COMPLETED
             输家：claim 失败 → 等

           而输家在一次**不巧**的采样上会看到赢家刚领走、还没推进的那一行
           （state 仍是 PROPOSED、quote_id 还是 NULL）。那时若就返回，
           两个进程会报告两个世界：赢家报 COMPLETED、输家报 PROPOSED。
           中间态 EXECUTING 同样不够 —— 那时赢家还没写完结局。
           因此只有**终态**（COMPLETED / DENIED / EXPIRED / FAILED）才是一个
           可以对外回答的读数；在那之前继续等。
           60 × 25ms = 1.5 秒的上界是量出来的：一次 AUTO_ALLOW 的完整执行
           （报价 → 权威 → 准备 → 结算 → 完成）在本机上约 30～80ms。 */
        const st = current == null ? null : String(current.state);
        if (current != null && C.isPurchaseIntentTerminalState(st)) break;
        const until = Date.now() + 25;
        while (Date.now() < until) { /* 有界等待：让赢家把结局写完 */ }
        current = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
      }
      const view = rowToPurchaseIntent(current);
      /* ★★ 输家**不**自己去执行一遍。开发期实测：让两边都执行会让它们各自
         prepare 同一份报价（P22-6 的幂等闸门会给出同一笔购买 —— 那是幂等性
         在起作用，不是缺陷），而随后两条路径会各自尝试把 purchase 挂到同
         一条 intent 上、各自尝试结算，症状是"赢家报 COMPLETED、输家报
         QUOTE_MISMATCH"。正确的分工是：**领走的人执行，其他人等它的结局**。
         因此这里只报告读到的那一行以及"我正在被别人处理"这个事实。
         ★ 待办语义仍然成立：若赢家在执行中途真的崩了，那条 intent 会停在
         EXECUTING，而**下一次** propose / resume 会重新领走它并接着做完
         （见 executeIntent 开头的认领段）。 */
      const state = current == null ? null : String(current.state);
      return {
        ok: true,
        replayed: true,
        claimedByAnotherProcess: true,
        intent: view,
        mayExecute: false,
        nextAction: state === C.PURCHASE_INTENT_STATE.EXECUTING ? 'execute' : 'none'
      };
    }
    /* 领到之后重新读一次：赢家的世界与我们读到的那一行之间可能已经有
       别的变化（例如那条 intent 已经被推进过又被别的东西读了）。 */
    row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));

    const at = clock();
    const agent = intentPartyOf(row.agent_id, 'agentId');
    if (!agent.ok) return { ok: false, denied: false, reasonCode: null, errors: agent.errors };

    /* ① 商品必须在场、必须 ACTIVE、必须属于一个开着的货架。三条都由
          canonical 行回答，而 DISABLED / RETIRED / missing 一律 fail closed。 */
    const productRow = db.prepare(SQL.selectProduct).get(String(row.product_id));
    if (!productRow) {
      const moved = transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.PROPOSED, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: C.DENY_REASON.PRODUCT_NOT_FOUND
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state, reasonCode: C.DENY_REASON.PRODUCT_NOT_FOUND, productMissing: true
      });
      return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'],
        { intent: view, transitioned: moved.ok === true, productBacked: false });
    }
    if (String(productRow.status) !== C.PRODUCT_STATUS.ACTIVE) {
      const code = String(productRow.status) === C.PRODUCT_STATUS.RETIRED
        ? C.DENY_REASON.PRODUCT_DISABLED : C.DENY_REASON.PRODUCT_DISABLED;
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.PROPOSED, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: code
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state, reasonCode: code, productStatus: String(productRow.status)
      });
      return denial(code, ['product-is-not-active'], {
        intent: view, productStatus: String(productRow.status), productBacked: true
      });
    }
    const storeRow = db.prepare(SQL.selectStore).get(String(productRow.store_id));
    if (!storeRow || String(storeRow.status) !== C.STORE_STATUS.ACTIVE) {
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.PROPOSED, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: C.DENY_REASON.PRODUCT_DISABLED
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state, reasonCode: C.DENY_REASON.PRODUCT_DISABLED, storeInactive: true
      });
      return denial(C.DENY_REASON.PRODUCT_DISABLED, ['store-is-not-active-or-missing'], {
        intent: view, storeId: productRow.store_id == null ? null : String(productRow.store_id)
      });
    }

    /* ② 有效期。★ 到这里才检查，是因为前面的失败**更具体**：一件不存在的
          商品与一件过期的打算，前者是更好的答案。 */
    if (Number(row.expires_at) <= at) {
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.PROPOSED, C.PURCHASE_INTENT_STATE.EXPIRED, {
        reasonCode: C.DENY_REASON.INTENT_EXPIRED
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state, reasonCode: C.DENY_REASON.INTENT_EXPIRED, expiresAt: Number(row.expires_at)
      });
      return denial(C.DENY_REASON.INTENT_EXPIRED, ['intent-expired-before-its-quote-was-created'],
        { intent: view, expiresAt: Number(row.expires_at), now: at });
    }

    /* ③ 报价（Product-backed，价格从商品行派生）。 */
    let quoteRow = null;
    if (row.quote_id != null) {
      quoteRow = db.prepare(SQL.selectQuote).get(String(row.quote_id));
      if (!quoteRow) {
        transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.PROPOSED, C.PURCHASE_INTENT_STATE.FAILED, {
          reasonCode: C.DENY_REASON.QUOTE_MISMATCH
        });
        const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        return denial(C.DENY_REASON.QUOTE_MISMATCH, ['intent-names-a-quote-that-does-not-exist'], { intent: view });
      }
    } else {
      const quoted = ensureIntentQuote(rowToPurchaseIntent(row), productRow, at);
      if (quoted.ok !== true) {
        transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.PROPOSED, C.PURCHASE_INTENT_STATE.FAILED, {
          reasonCode: quoted.reasonCode || C.DENY_REASON.PRODUCT_DISABLED
        });
        const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
          state: view.state, reasonCode: quoted.reasonCode || C.DENY_REASON.PRODUCT_DISABLED, quoteFailed: true
        });
        return denial(quoted.reasonCode || C.DENY_REASON.PRODUCT_DISABLED,
          (quoted.errors && quoted.errors.length) ? quoted.errors : ['quote-could-not-be-created-from-the-product'],
          { intent: view, productId: String(row.product_id) });
      }
      quoteRow = quoted.quoteRow;
    }

    /* ④ 把报价挂到 intent 上（这一步是"Quote created"这个可崩溃边界）。
          ★ 报价与 intent 的绑定必须是**持久**的：批准之后恢复时用的
          必须是这一份报价，而不是重新生成一份可能不同价的。
          ★ 它**不是**一次状态迁移（见 attachPurchaseIntentQuote 的说明）。 */
    if (row.quote_id == null) {
      const rev = allocateRevision();
      const info = db.prepare(SQL.attachPurchaseIntentQuote).run(
        String(quoteRow.quote_id), Number(rev), Number(at), String(intentId), C.PURCHASE_INTENT_STATE.PROPOSED
      );
      if (Number(info.changes) !== 1) {
        /* 另一个进程在这中间推进了它 —— 那条路径会给出一致的答案，
           因此这里只报告竞争，不覆盖。 */
        return {
          ok: false, denied: false, reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE,
          errors: ['intent-quote-could-not-be-attached'], concurrent: true
        };
      }
    }
    row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));

    /* ⑤ 权威判定（P22-7）。★ 每一个 intent 都必须经过这里 —— 没有例外，
          没有"上一笔放行了所以这一笔也放行"。 */
    const recipientParty = row.recipient_id == null ? null : partyInput(String(row.recipient_id)).party;
    const authority = evaluateAutonomousPurchaseFor({
      buyerId: String(row.agent_id),
      quoteId: String(quoteRow.quote_id),
      recipientId: row.recipient_id == null ? null : String(row.recipient_id),
      now: at
    });
    const verdict = C.evaluatePurchaseIntentVerdict({
      now: at,
      intentStatus: String(row.state),
      expiresAt: Number(row.expires_at),
      productId: String(row.product_id),
      productStatus: String(productRow.status),
      quoteState: String(quoteRow.state),
      quoteExpired: Number(quoteRow.expires_at) <= at,
      authority: authority,
      approvalStatus: null
    });
    if (verdict.ok !== true) {
      return { ok: false, denied: false, reasonCode: verdict.reasonCode || null, errors: verdict.errors };
    }

    let nextState = null;
    if (verdict.outcome === C.INTENT_VERDICT.DENY) nextState = C.PURCHASE_INTENT_STATE.DENIED;
    else if (verdict.outcome === C.INTENT_VERDICT.FAIL) nextState = C.PURCHASE_INTENT_STATE.FAILED;
    else if (verdict.outcome === C.INTENT_VERDICT.WAIT_FOR_APPROVAL) nextState = C.PURCHASE_INTENT_STATE.WAITING_APPROVAL;
    else nextState = C.PURCHASE_INTENT_STATE.EXECUTING;

    /* ⑥ REQUIRE_APPROVAL：**只**创建一条待批准的记录，然后停下。
          ★ 这里绝不 reserve、绝不扣钱、绝不发库存 —— §6 的那句话在
          这一行上没有分支可以走偏：下面那条路径里没有任何 P22-6 调用。 */
    let approvalId = null;
    if (nextState === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL) {
      const pending = db.prepare(SQL.selectApprovalsByQuote).all(String(quoteRow.quote_id));
      const live = pending.filter(r => String(r.status) === C.APPROVAL_STATE.PENDING);
      if (live.length) {
        /* 同一个 intent 恢复两次 → 复用那一条待批准记录，而不是再建一条。
           （P22-7 的 createApprovalRequest 有自己的幂等 key，但"一条
           intent 同时有两条待批准"本身就不该存在。） */
        approvalId = String(live[0].approval_id);
      } else {
        const expiresAt = Number(row.expires_at);
        const created = createApprovalRequest({
          buyerId: String(row.agent_id),
          quoteId: String(quoteRow.quote_id),
          recipientId: row.recipient_id == null ? null : String(row.recipient_id),
          units: Number(row.units),
          expiresAt: expiresAt,
          /* ★ 幂等 key 由 intent 派生：同一条 intent 的"请求批准"永远
             是**那一次**请求。 */
          idempotencyKey: 'econ.intent.approval+' + String(intentId)
        });
        if (created.ok !== true) {
          transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.PROPOSED, C.PURCHASE_INTENT_STATE.FAILED, {
            reasonCode: created.reasonCode || C.DENY_REASON.APPROVAL_REQUIRED
          });
          const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
          return denial(created.reasonCode || C.DENY_REASON.APPROVAL_REQUIRED,
            (created.errors && created.errors.length) ? created.errors : ['approval-request-could-not-be-created'],
            { intent: view, quoteId: String(quoteRow.quote_id), approvalCreated: false });
        }
        approvalId = String(created.result.approvalId);
        /* ── §16 第三个可崩溃边界：**Approval created** ──────────────────
           ★ 这个点在 createApprovalRequest **提交之后**，因此命中时那条
           批准**真的存在**（PENDING）而 intent 仍然停在 PROPOSED、没有
           approval_id。恢复路径因此必须做两件事：重新解出权威结论、并且
           **复用**那一条已经存在的 PENDING 批准（而不是再建一条）。 */
        faultPoint('after-intent-approval-created');
      }
    }

    const moved = transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.PROPOSED, nextState, {
      quoteId: String(quoteRow.quote_id),
      approvalId: approvalId,
      authorityOutcome: verdict.authorityOutcome == null ? null : String(verdict.authorityOutcome),
      authorityReasonCode: verdict.reasonCode == null ? null : String(verdict.reasonCode),
      reasonCode: verdict.reasonCode == null ? null : String(verdict.reasonCode)
    });
    if (moved.ok !== true) {
      return { ok: false, denied: false, reasonCode: moved.reasonCode || null,
        errors: moved.errors || ['intent-state-could-not-be-advanced'], transition: moved };
    }
    const finalRow = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    const view = rowToPurchaseIntent(finalRow);

    if (nextState === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL) {
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_AWAITING_APPROVAL, {
        state: view.state,
        authorityOutcome: view.authorityOutcome,
        reasonCode: view.reasonCode,
        reservedNothing: true,
        ledgerMutation: false
      });
    } else if (nextState === C.PURCHASE_INTENT_STATE.EXECUTING) {
      /* AUTO_ALLOW 是**唯一**会立刻执行的出口，而它的"为什么没问用户"
       必须有出处：authorityOutcome 与 autonomy_policy_id 一起回答它
       （后者在 executeIntent 里落进 P22-6 的 purchase 行）。 */
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state,
        authorityOutcome: view.authorityOutcome,
        reasonCode: view.reasonCode,
        autonomyPolicyId: authority.autonomyPolicyId == null ? null : String(authority.autonomyPolicyId),
        budgetStillRequired: true
      });
    } else {
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state, authorityOutcome: view.authorityOutcome, reasonCode: view.reasonCode, terminal: true
      });
    }

    return {
      ok: true,
      intent: view,
      verdict: verdict,
      authorityPolicyId: authority.autonomyPolicyId == null ? null : String(authority.autonomyPolicyId),
      authorityOutcome: verdict.authorityOutcome == null ? null : String(verdict.authorityOutcome),
      authorityBindingFingerprint: null,
      quoteId: String(quoteRow.quote_id),
      approvalId: approvalId,
      mayExecute: nextState === C.PURCHASE_INTENT_STATE.EXECUTING,
      nextAction: nextState === C.PURCHASE_INTENT_STATE.EXECUTING ? 'execute'
        : (nextState === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL ? 'await-approval' : 'none')
    };
  }

  /* ── §6/§16 Phase C：执行（P22-6 的两次 canonical 调用）────────────
     ★ 三次调用各自带事务，**故意不合并**：
       preparePurchase  —— 自己的事务（预算、预留、purchase 行）
       settlePurchase   —— 自己的事务（结算、扣钱、发资产、消费批准）
       状态推进          —— 自己的事务（intent 的结局）

     为什么必须分开：崩溃模拟要能在**每一段之后**发生，而如果它们在一个
     大事务里，那么"purchase settled 但 intent 没完成"这个真实的中断就
     不可表示 —— 而它恰恰是 §16 点名要求处理的那一个。分开之后，恢复
     路径可以只根据 intent 的**持久状态**决定下一步：
       EXECUTING + 有 purchaseId + purchase=COMPLETED → 补写 COMPLETED
       EXECUTING + 无 purchaseId                        → 重新执行（幂等）
     两句话都不需要猜。 */
  function executeIntent(intentId, options) {
    const o = options || {};
    requireOpen();
    let row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['intent-not-found'] };
    const at = clock();

    /* ── ★★ 第一件事：**拿执行权**（见 claimIntentForExecution 的说明）────
       没有这一道闸门时，两个真实进程同时提同一份提议会让两者都去执行，
       而它们随后各自把同一笔购买挂到同一条 intent 上 —— 症状是"赢家报
       COMPLETED、输家报 QUOTE_MISMATCH"，也就是两个进程读到两个世界。

       ★ `options.owned === true` 是**同一个调用栈内部**的交接：`resolveIntent`
       刚刚用同一道闸门把这条 intent 推到 EXECUTING，它把所有权直接交给
       这里，而不是让这里再去抢一次（第二次抢必然拿到 owned:false ——
       因为 state 已经是 EXECUTING，而那会让每一次正常的 AUTO_ALLOW 都
       变成"我以为别人在忙"）。这个参数刻意**不进公开面**：它只能由本文件
       内部传，任何外部调用方都拿不到它。 */
    if (o.owned === true) {
      row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    } else {
      /* ── 领执行权。★ 领不到时的分支由 `originallyProposed` 区分，而那一
         区分是开发期实测逼出来的（见下面两段的说明）。 */
      const originallyProposed = String(row.state) === C.PURCHASE_INTENT_STATE.PROPOSED;
      const claim = claimIntentForExecution(intentId);
      if (claim.ok !== true) return claim;
      if (claim.owned !== true) {
        /* ── 情形一：我读到的**本来就是** PROPOSED，而领走失败了 ──────────
           ★★ 这是最要紧的一支，也是开发期实测花了最久的一支。

           两个真实进程同时提同一份提议时，**两个都会先读到 PROPOSED** ——
           然后其中一个领走了它。输的那一个手里握着的是一个**过期快照**，
           而它**不能**因此就报"我读到的是 PROPOSED"：那个状态在它读到之后
           已经不存在了（赢家把它推到了 COMPLETED）。

           实测症状：赢家报 COMPLETED、输家报 PROPOSED，而输家无论再等多久
           都读不到那个终态（它持有的是一个陈旧的读视图）。这正是 §16 要挡
           的那件事 —— 两个进程读到两个世界。

           正确的动作是**接着把同一条 intent 做完**：`resolveIntent` 与
           `executeIntent` 的每一步都带自己的幂等闸门（`claim` / `attach`
           的 `AND <col> IS NULL` 谓词、`preparePurchase` / `settlePurchase`
           的 (scope, key) 记录、`finalizeIntent` 的终态检查），因此重复
           走一遍**不会**产生第二笔购买、第二次扣款或第二次发货；它保证的是
           **两个进程都到达那个唯一的最终事实**。
           ★ 判据用的是**我读到的**那个状态（`originallyProposed`），而不是
           再读一次 —— 再读一次得到的仍然是同一个过期快照。 */
        if (originallyProposed) {
          const resolvedAgain = resolveIntent(intentId, { force: true });
          if (resolvedAgain.ok !== true) return resolvedAgain;
          if (resolvedAgain.mayExecute === true) {
            /* 领到了（或者它已经在 EXECUTING）—— 继续往下做。 */
            row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
            if (String(row.state) === C.PURCHASE_INTENT_STATE.EXECUTING) {
              /* 已经是 EXECUTING：直接接着执行，不再抢一次。 */
            } else {
              return endpointOfIntentAfterLoss(intentId);
            }
          } else {
            /* 它已经定局（或落在等待路径上）：如实返回。 */
            return endpointOfIntentAfterLoss(intentId);
          }
        } else {
          /* ── 情形二：我读到的**本来就是** EXECUTING ─────────────────────
             它要么是"另一个进程正在做"，要么是"上一次崩在这里"（§16 的
             第四个边界）。两者从库里读不出来，因此**接着做**是唯一既安全
             又正确的选择：那些幂等闸门保证重复走不会产生第二笔购买，而
             "崩溃留下的那一条必须能被接着做完"也由同一句话满足。 */
          const recheck = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
          const recheckState = recheck == null ? null : String(recheck.state);
          if (recheckState === C.PURCHASE_INTENT_STATE.EXECUTING) {
            row = recheck;
          } else if (C.isPurchaseIntentTerminalState(recheckState)) {
            return endpointOfIntentAfterLoss(intentId);
          } else {
            /* 它回到了 PROPOSED 或落在等待路径上：让它自己走一遍。 */
            const resolvedAgain = resolveIntent(intentId, { force: true });
            if (resolvedAgain.ok !== true) return resolvedAgain;
            if (resolvedAgain.mayExecute !== true) return endpointOfIntentAfterLoss(intentId);
            row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
          }
        }
      } else {
        row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
      }
    }

    row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));

    /* ── 领到执行权之后，state 一定是 EXECUTING；下面这些分支是**防御性**的
       （例如另一个进程在我们领到之后、我们重读之前把它推到了终态）。 */
    if (String(row.state) === C.PURCHASE_INTENT_STATE.COMPLETED) {
      /* ★ §16 的"不得重复买"：一个已经完成的 intent 再次被要求执行，
         正确的答案是**把它自己**还回去，而不是再买一次。 */
      return { ok: true, replayed: true, alreadyCompleted: true,
        intentId: String(intentId),
        intent: rowToPurchaseIntent(row),
        quoteId: row.quote_id == null ? null : String(row.quote_id),
        purchaseId: row.purchase_id == null ? null : String(row.purchase_id),
        mayExecute: false, nextAction: 'none', purchaseCreated: false };
    }
    if (C.isPurchaseIntentTerminalState(String(row.state))) {
      return denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE, ['intent-is-terminal'], {
        terminal: true, intent: rowToPurchaseIntent(row)
      });
    }
    if (String(row.state) !== C.PURCHASE_INTENT_STATE.EXECUTING) {
      /* 到不了这里（领走已经把 state 推成 EXECUTING）。保留这一支是为了让
         "某天有人改了领走的语义"表现为一个具名拒绝，而不是让后续代码在
         一个没有执行权的 intent 上动手。 */
      return denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE, ['intent-has-not-been-granted-the-right-to-execute'], {
        intentState: String(row.state),
        requiresApproval: String(row.state) === C.PURCHASE_INTENT_STATE.WAITING_APPROVAL,
        intent: rowToPurchaseIntent(row)
      });
    }
    /* ── ★★ 恢复路径的第一件事：**先把账对准**（多进程实测暴露的真实缺口）
       一条 EXECUTING 的 intent 可能出在两种完全不同的处境上：
         ① `purchase_id` 已经写下 → 那笔购买就在那里，按它的状态续做；
         ② `purchase_id` **没有**写下，但报价上**已经有**一笔购买 ——
            这是 §16 第四个可崩溃边界（"Purchase prepared"）留下的形状。
       开发期实测：漏掉 ② 时，重试会走到 preparePurchase，而 P22-6 的
       `selectPurchaseByQuote` 会以 `this-quote-is-already-linked-to-a-purchase`
       拒绝 —— 于是那条 intent 永久卡在 EXECUTING，而库里躺着一笔 RESERVED
       的购买与一次**没有释放**的预留。那既不是"重复买"，也不是"假完成"，
       而是第三种更坏的东西：一笔锁住的钱没有主人。
       正确的动作是**认领**它（把那笔购买挂回 intent）然后结算它。 */
    if (row.purchase_id == null && row.quote_id != null) {
      const orphan = db.prepare(SQL.selectPurchaseByQuote).get(String(row.quote_id));
      if (orphan) {
        const orphanId = String(orphan.purchase_id);
        const revAdopt = allocateRevision();
        const adopted = db.prepare(SQL.attachPurchaseIntentPurchase).run(
          orphanId, Number(revAdopt), Number(clock()), String(intentId), C.PURCHASE_INTENT_STATE.EXECUTING
        );
        if (Number(adopted.changes) === 1) {
          row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
          appendIntentChange(rowToPurchaseIntent(row), C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
            state: String(row.state), adoptedOrphanPurchase: true, purchaseId: orphanId,
            recoveredAt: 'execution'
          });
        }
      }
    }
    if (Number(row.expires_at) <= at) {
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.EXPIRED, {
        reasonCode: C.DENY_REASON.INTENT_EXPIRED
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state, reasonCode: C.DENY_REASON.INTENT_EXPIRED, atExecution: true
      });
      return denial(C.DENY_REASON.INTENT_EXPIRED, ['intent-expired-before-execution'], { intent: view });
    }
    if (row.quote_id == null) {
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: C.DENY_REASON.QUOTE_MISMATCH
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['an-executing-intent-must-name-its-quote'], { intent: view });
    }

    const quoteRow = db.prepare(SQL.selectQuote).get(String(row.quote_id));
    if (!quoteRow) {
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: C.DENY_REASON.QUOTE_MISMATCH
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['intent-names-a-quote-that-does-not-exist'], { intent: view });
    }
    const productRow = db.prepare(SQL.selectProduct).get(String(quoteRow.product_id));
    if (!productRow) {
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: C.DENY_REASON.PRODUCT_NOT_FOUND
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { intent: view });
    }

    /* ── 恢复：已经有一笔 purchase 挂在 intent 上 ───────────────────── */
    if (row.purchase_id != null) {
      const purchaseRow = db.prepare(SQL.selectPurchase).get(String(row.purchase_id));
      if (!purchaseRow) {
        transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
          reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE
        });
        const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        return denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE, ['intent-names-a-purchase-that-does-not-exist'], { intent: view });
      }
      const pstate = String(purchaseRow.status);
      if (pstate === C.PURCHASE_STATE.COMPLETED) {
        return finalizeIntent(intentId, String(row.purchase_id), at, { recoveredCompletion: true });
      }
      if (pstate === C.PURCHASE_STATE.RELEASED || pstate === C.PURCHASE_STATE.FAILED) {
        transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
          reasonCode: purchaseRow.reason_code == null ? C.DENY_REASON.INTENT_NOT_EXECUTABLE : String(purchaseRow.reason_code)
        });
        const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
          state: view.state, reasonCode: view.reasonCode, purchaseStatus: pstate
        });
        return denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE,
          ['the-purchase-this-intent-prepared-was-not-completed'],
          { intent: view, purchaseStatus: pstate });
      }
      /* RESERVED：结算没走完（崩溃在这里）。继续结算 —— 它是幂等的。 */
      return settleIntentPurchase(intentId, String(row.purchase_id), at, { resumedSettlement: true });
    }

    /* ── 恢复：intent 上没有 purchase_id，但**报价上**可能已经有一笔 ──────
       ★ 这是 §16 第四个可崩溃边界（"Purchase prepared"）的正确恢复语义，
       而它是一次真实发现：崩溃发生在 preparePurchase **提交之后**、
       `attachPurchaseIntentPurchase` **之前**时，库里有：
         · 一条 INTENT_STATE=EXECUTING、purchase_id 为 NULL 的 intent；
         · 一笔 RESERVED 的 purchase（挂在同一份报价上）；
         · 一次被占用的预留。
       此时**不能**重新 prepare —— P22-6 的 UNIQUE(quote_id) 会以
       `this-quote-is-already-linked-to-a-purchase` 拒绝，而那不是缺陷，
       那正是"一份报价最多一笔购买"这条性质在起作用。
       正确的动作是**接着做**：把那笔已经存在的购买挂回 intent 上，然后
       结算它。这与 P22-7 worker 的 'resume' 模式是同一条纪律（先找既有
       的 RESERVED 购买，有就续做），只是这次它由 runtime 自己完成。 */
    const existingForQuote = db.prepare(SQL.selectPurchaseByQuote).get(String(row.quote_id));
    if (existingForQuote) {
      const existingId = String(existingForQuote.purchase_id);
      const revAdopt = allocateRevision();
      const adopted = db.prepare(SQL.attachPurchaseIntentPurchase).run(
        existingId, Number(revAdopt), Number(at), String(intentId), C.PURCHASE_INTENT_STATE.EXECUTING
      );
      if (Number(adopted.changes) !== 1) {
        return { ok: false, denied: false, reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE,
          errors: ['an-existing-purchase-could-not-be-adopted-by-the-intent'], purchaseId: existingId };
      }
      const existingState = String(existingForQuote.status);
      if (existingState === C.PURCHASE_STATE.COMPLETED) {
        return finalizeIntent(intentId, existingId, at, { recoveredCompletion: true, adoptedExistingPurchase: true });
      }
      if (existingState === C.PURCHASE_STATE.RESERVED) {
        return settleIntentPurchase(intentId, existingId, at, { resumedSettlement: true, adoptedExistingPurchase: true });
      }
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: existingForQuote.reason_code == null
          ? C.DENY_REASON.INTENT_NOT_EXECUTABLE : String(existingForQuote.reason_code)
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      return denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE,
        ['the-purchase-already-linked-to-this-quote-was-not-completed'],
        { intent: view, purchaseId: existingId, purchaseStatus: existingState });
    }

    /* ── 首次执行：preparePurchase（P22-6 的 canonical 入口）────────── */
    const agent = intentPartyOf(row.agent_id, 'agentId');
    if (!agent.ok) return { ok: false, denied: false, reasonCode: null, errors: agent.errors };
    const recipientRef = row.recipient_id == null ? null : partyInput(String(row.recipient_id));
    const recipientParty = recipientRef == null ? null : (recipientRef.ok === true ? recipientRef.party : null);

    /* ★ 授权那一面由 intent 的**引用**决定，而不是由 `authority_outcome`
       这一个字段决定 —— 这是开发期实测踩到的一次真实缺陷：
       `authority_outcome` 记的是**权威判定的结论**
       （AUTO_ALLOW / REQUIRE_APPROVAL / DENY），而 P22-6 要的是
       **购买的授权模式**（PURCHASE_APPROVAL_MODE 只有两个词）。
       两者看起来都能回答"这算不算自主"，但它们**不是**同一个词表：
       REQUIRE_APPROVAL 是一个结论，而不是一种购买模式 —— 它变成购买模式
       的唯一方式是**那条批准真的存在**。因此判据是：
         approval_id 存在 → APPROVAL 模式（把那张批准的 id 递进去）
         否则             → AUTO_ALLOW 模式（把重算出来的授权身份递进去）
       用 authority_outcome 去选模式会让一条被批准过的 intent 走进
       "AUTO_ALLOW"分支，而它手里握着的是一张批准 —— 那正是 §6 禁止的
       "把批准当成一次自主放行"。 */
    const mode = row.approval_id != null
      ? C.PURCHASE_APPROVAL_MODE.APPROVAL
      : C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW;
    let prepareInput = {
      quoteId: String(row.quote_id),
      buyerId: String(row.agent_id),
      recipientId: row.recipient_id == null ? null : String(row.recipient_id),
      /* ★ P22-26：这里**刻意没有** `units`。preparePurchase 从**报价**读
         份数（那是它唯一的权威），因此"intent 说自己买几份"与"报价说这份
         报价买几份"之间的比对发生在下面 intentBindingOf 里（它用 intent
         行上的 units 重算九元组），而不是靠把一个数递进 prepare。 */
      expiresAt: Number(row.expires_at),
      /* ★ 幂等 key 由 intent 派生：同一条 intent 的"准备购入"永远是
         那一次，于是重放返回的是**同一笔** purchase，而不是第二笔。 */
      idempotencyKey: 'econ.intent.prepare+' + String(intentId)
    };
    if (mode === C.PURCHASE_APPROVAL_MODE.APPROVAL) {
      if (row.approval_id == null) {
        transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
          reasonCode: C.DENY_REASON.APPROVAL_NOT_FOUND
        });
        const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        return denial(C.DENY_REASON.APPROVAL_NOT_FOUND, ['approval-mode-without-an-approval-id'], { intent: view });
      }
      /* §7：恢复执行带的是**那条批准**，而它绑定的必须是**这一份**报价。
         P22-6 会在自己的写锁里逐字复核九个字段，因此"拿批准 A 去买 B"
         在这里不可能成立。 */
      prepareInput.approvalId = String(row.approval_id);
    } else if (mode === C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW) {
      if (row.approval_id != null) {
        transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
          reasonCode: C.DENY_REASON.TRANSITION_NOT_ALLOWED
        });
        const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED,
          ['an-autonomous-intent-must-not-carry-an-approval-id'], { intent: view });
      }
      /* ★ 策略 id 从**当前**策略重读，而不是从 intent 行里读一个可能已经
         被改掉 / 删掉的 id：P22-6 会在自己的写锁里把 (策略身份, 九元组)
         一起重算，因此这里读到的那一个必须与它算出来的一致。
         ★ 这里**不**重新判定"是不是 AUTO_ALLOW"（那已经在 Phase B 由
         P22-7 做过，结论落库在 authority_outcome 上）。这里只取策略的
         **身份**，而 P22-6 用这个身份证明"当初放行的那条规则现在仍然说
         得通"。两者合起来才是"权威判定不是一次性的声明"。 */
      const policy = autonomyPolicyForOwner(String(row.agent_id));
      if (!policy) {
        transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
          reasonCode: C.DENY_REASON.AUTONOMY_NOT_PERMITTED
        });
        const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        return denial(C.DENY_REASON.AUTONOMY_NOT_PERMITTED,
          ['the-autonomy-policy-that-allowed-this-intent-is-no-longer-present'], { intent: view });
      }
      const binding = intentBindingOf(quoteRow, productRow, agent.party, recipientParty, Number(row.units));
      if (binding.ok !== true) {
        transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
          reasonCode: C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED
        });
        const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, binding.errors, { intent: view });
      }
      prepareInput.autonomyPolicyId = String(policy.policyId);
      prepareInput.approvalBindingFingerprint = String(binding.fingerprint);
    } else {
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED,
        ['an-executing-intent-must-name-a-canonical-authority-outcome'],
        { intent: view, authorityOutcome: row.authority_outcome == null ? null : String(row.authority_outcome) });
    }

    const prepared = preparePurchase(prepareInput);
    if (prepared.ok !== true) {
      /* ★ 预算 DENY / 预留不足 / 报价改动都会到这里，而它们的正确结局是
         **FAILED**：intent 说自己拿到了执行权，但 P22-6 拒绝了这笔钱。
         §6 的"仍必经 Budget + Reservation"就落在这里 —— 这句话不是
         "我们会记得检查"，而是"唯一通往结算的路要经过那两个函数"。 */
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: prepared.reasonCode == null ? C.DENY_REASON.INTENT_NOT_EXECUTABLE : prepared.reasonCode
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state,
        reasonCode: view.reasonCode,
        prepareFailed: true,
        reservedNothing: prepared.reservedNothing === true || prepared.denied === true
      });
      return denial(prepared.reasonCode == null ? C.DENY_REASON.INTENT_NOT_EXECUTABLE : prepared.reasonCode,
        (prepared.errors && prepared.errors.length) ? prepared.errors : ['purchase-could-not-be-prepared'],
        { intent: view, prepareDenied: prepared.denied === true, purchasePrepared: false });
    }
    const purchaseId = String(prepared.result.purchaseId);
    /* ── §16 第四个可崩溃边界：**Purchase prepared** ────────────────────
       ★ 这个点在 preparePurchase **提交之后**、attach 之前：命中时库里
       有一笔 RESERVED 的购买与一笔被占用的预留，而 intent 仍然停在
       EXECUTING 且**没有** purchase_id。恢复路径因此不能只看 intent 的
       purchase_id 就下结论 —— 它必须能从"报价 → 购买"这条既有链上找到
       那一笔（见 executeIntent 开头的认领段）。 */
    faultPoint('after-intent-purchase-prepared');
    /* 把 purchase 挂到 intent 上（恢复路径的锚点）。同样**不是**状态迁移：
       EXECUTING 还是 EXECUTING，变的只是"它已经进行到哪一笔购买"。 */
    const attachRev = allocateRevision();
    const attachInfo = db.prepare(SQL.attachPurchaseIntentPurchase).run(
      purchaseId, Number(attachRev), Number(at), String(intentId), C.PURCHASE_INTENT_STATE.EXECUTING
    );
    if (Number(attachInfo.changes) !== 1) {
      /* ★★ 挂不上 purchase 有**两个**完全不同的原因，而它们必须分开回答：
         ① 另一个进程已经在这条 intent 上挂好并结算完了 —— 那**不是**失败，
            它的世界是正确的，而正确的动作是**读回那个结局**；
         ② 这条 intent 已经不在 EXECUTING 了（被别的路径推进）—— 同样读回。
       开发期实测（E 组，两个真实进程同时 resume 同一条 APPROVED intent）：
       `preparePurchase` 的幂等闸门让输的那一方**拿到了赢家的同一笔购买**
       （这正是幂等性在起作用），于是它手里的 purchaseId 与 intent 上已经
       写着的那一个**逐字相同**，而 attach 的 `AND purchase_id IS NULL`
       谓词让它拿到 changes=0。少了下面这一段时，结果是"输的一方报
       INTENT_NOT_EXECUTABLE，而它的世界里一切正常" —— 两个进程读到两个
       世界，而这正是 §16 要挡的东西。 */
      const settledRow = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
      const settledState = settledRow == null ? null : String(settledRow.state);
      const samePurchase = settledRow != null && settledRow.purchase_id != null &&
        String(settledRow.purchase_id) === purchaseId;
      if (settledState === C.PURCHASE_INTENT_STATE.COMPLETED) {
        return {
          ok: true,
          replayed: true,
          alreadyCompleted: true,
          intentId: String(intentId),
          intent: rowToPurchaseIntent(settledRow),
          purchaseId: purchaseId,
          quoteId: settledRow.quote_id == null ? null : String(settledRow.quote_id),
          mayExecute: false,
          nextAction: 'none',
          purchaseCreated: false,
          completedByAnotherProcess: true
        };
      }
      if (samePurchase && settledState === C.PURCHASE_INTENT_STATE.EXECUTING) {
        /* 同一笔购买、同一条 intent、还在执行中：**接着把它结算完**。
           settlePurchase 是幂等的（自己的 (scope, key) 记录），因此赢家先
           做完也只会得到同一个答案 —— 而这一支是多进程实测补上的第三类
           原因：挂不上不等于冲突。 */
        return settleIntentPurchase(intentId, purchaseId, at, { adoptedSamePurchase: true });
      }
      /* 那条 intent 上挂着的是**另一笔**购买：这是一次真实的冲突，应当
         如实报告，而不是把它悄悄改成"成功"。 */
      return { ok: false, denied: false, reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE,
        errors: ['purchase-could-not-be-attached-to-the-intent'],
        purchaseId: purchaseId,
        intentState: settledState,
        attachedPurchaseId: settledRow == null || settledRow.purchase_id == null
          ? null : String(settledRow.purchase_id) };
    }
    return settleIntentPurchase(intentId, purchaseId, at, { prepared: true, replayedPrepare: prepared.replayed === true });
  }

  /* settlePurchase → 成功则把 intent 记为 COMPLETED（可崩溃边界 #4）。 */
  function settleIntentPurchase(intentId, purchaseId, at, meta) {
    const settled = settlePurchase({
      purchaseId: String(purchaseId),
      idempotencyKey: 'econ.intent.settle+' + String(intentId)
    });
    if (settled.ok !== true) {
      /* ★★ "结算没成功"有两种截然不同的意思，而合并它们会让一条**正确**的
         实现被判成失败 —— 这是多进程实测踩到的一次真实缺陷：

         ① 另一个进程**已经把它结算完了**（或它已经不是 RESERVED 了）：
            P22-6 的终态闸门会以 TRANSITION_NOT_ALLOWED + terminal:true 拒绝。
            那不是失败 —— 那笔购买已经完成，正确的动作是把它与 intent 一起
            推到终点。
         ② 结算**真的**失败了（预算在最后一道复核处说不、余额不足、预留
            过期…）：那才是 FAILED。

         判据是"那笔 purchase 现在是不是 COMPLETED"。少了这一区分时，症状
         是"两个进程同时结算同一笔购买 → 输的那个把 intent 写成 FAILED，
         而那笔购买其实是 COMPLETED"：一条**假失败**的 intent 对应一笔已经
         完成的购买，而两个进程从此读到两个世界。 */
      const purchaseNow = db.prepare(SQL.selectPurchase).get(String(purchaseId));
      const purchaseNowState = purchaseNow == null ? null : String(purchaseNow.status);
      if (purchaseNowState === C.PURCHASE_STATE.COMPLETED) {
        /* 它已经完成了：**照常完成 intent**，而不是报一次失败。
           （`finalizeIntent` 自己会在终态闸门上认出并发完成并返回同一个结局。） */
        faultPoint('after-intent-purchase-settled');
        return finalizeIntent(intentId, String(purchaseId), at,
          Object.assign({ settledByAnotherProcess: true }, meta || {}));
      }
      if (settled.terminal === true && purchaseNowState === C.PURCHASE_STATE.RESERVED) {
        /* terminal 拒绝、而购买仍停在 RESERVED：这是"另一个进程正在结算"的
           中间视图。
           ★★ 这里**不能**就此放手 —— 多进程实测（D 组）踩到过一次"一笔
           RESERVED 的购买没有主人"：赢家被撞了一下、而输家读到中间态就走了，
           于是那笔钱一直锁着，而 intent 停在 EXECUTING。
           正确的动作是**有界地再试一次**：赢家写完结局之后，这一次读到的就是
           终态（或者我们领到并把它做完）。上限 20 × 25ms = 0.5 秒 —— 与
           一次完整执行同量级。 */
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const until = Date.now() + 25;
          while (Date.now() < until) { /* 有界等待 */ }
          const now = db.prepare(SQL.selectPurchase).get(String(purchaseId));
          const nowState = now == null ? null : String(now.status);
          if (nowState === C.PURCHASE_STATE.COMPLETED) {
            faultPoint('after-intent-purchase-settled');
            return finalizeIntent(intentId, String(purchaseId), at,
              Object.assign({ settledByAnotherProcess: true, waitedForSettlement: true }, meta || {}));
          }
          if (nowState !== C.PURCHASE_STATE.RESERVED) break;
          /* 还是 RESERVED：再试一次结算 —— 它自己是幂等的，而且写锁会让
             两个进程串行化。 */
          const retry = settlePurchase({
            purchaseId: String(purchaseId),
            idempotencyKey: 'econ.intent.settle+' + String(intentId)
          });
          if (retry.ok === true) {
            faultPoint('after-intent-purchase-settled');
            return finalizeIntent(intentId, String(purchaseId), at,
              Object.assign({ settled: true, retriedSettlement: true }, meta || {}));
          }
          if (retry.reasonCode !== settled.reasonCode) {
            /* 换了一个拒绝码：那才是真的失败。 */
            transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
              reasonCode: retry.reasonCode == null ? C.DENY_REASON.INTENT_NOT_EXECUTABLE : retry.reasonCode
            });
            const failedView = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
            appendIntentChange(failedView, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
              state: failedView.state, reasonCode: failedView.reasonCode, settleFailed: true
            });
            return denial(retry.reasonCode == null ? C.DENY_REASON.INTENT_NOT_EXECUTABLE : retry.reasonCode,
              (retry.errors && retry.errors.length) ? retry.errors : ['purchase-could-not-be-settled'],
              { intent: failedView, purchaseId: String(purchaseId), purchaseSettled: false });
          }
        }
        /* 有界重试用完，而它仍然停在 RESERVED：如实报告"我读到的是中间态"。
           下一次调用会接着做（`executeIntent` 的恢复段认识 EXECUTING +
           RESERVED 的组合）。 */
        const pendingView = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
        return {
          ok: true, replayed: true, pendingSettlement: true,
          intentId: String(intentId),
          intent: pendingView,
          purchaseId: String(purchaseId),
          quoteId: pendingView == null ? null : pendingView.quoteId,
          mayExecute: false,
          nextAction: 'execute',
          purchaseCreated: true
        };
      }
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: settled.reasonCode == null ? C.DENY_REASON.INTENT_NOT_EXECUTABLE : settled.reasonCode
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state, reasonCode: view.reasonCode, settleFailed: true
      });
      return denial(settled.reasonCode == null ? C.DENY_REASON.INTENT_NOT_EXECUTABLE : settled.reasonCode,
        (settled.errors && settled.errors.length) ? settled.errors : ['purchase-could-not-be-settled'],
        { intent: view, purchaseId: String(purchaseId), purchaseSettled: false,
          reasonCodes: settled.reasonCodes || null });
    }
    /* ── §16 第五个可崩溃边界：**Purchase settled** ─────────────────────
       ★ 这个点在 settlePurchase **提交之后**、intent 记成 COMPLETED
       **之前**。命中时库里是"钱扣了、资产发了、报价消费了、批准消费了，
       而 intent 仍然写着 EXECUTING" —— 也就是一条**看起来还没完成**的
       intent 对应一笔**已经完成**的购买。
       恢复路径必须能认出这个组合并且只做一件事：把 intent 补写成
       COMPLETED。它**绝不能**重新结算（那会试图再扣一次钱），而
       settlePurchase 的终态闸门会拒绝第二次，因此这里的安全性是双重的。 */
    faultPoint('after-intent-purchase-settled');
    return finalizeIntent(intentId, String(purchaseId), at, Object.assign({ settled: true }, meta || {}));
  }

  /* ── ★★ 收尾：一条 intent 必须收敛到终态（`owned` 路径的纪律）──────────
     多进程实测（D / G 组）反复暴露同一类症状：赢家完成了、而**另一个**进程
     报的是中间态（PROPOSED / EXECUTING）。让每一个调用方各自实现"再等等、
     再做一次"的循环，等于把同一条不变量抄写在十处。

     因此它被收敛成一个出口：**有界地重复执行，直到那条 intent 到达终态、
     或直到上界用完**。每一次重复都经过 `executeIntent` —— 而它的每一步都带
     自己的幂等闸门（claim / attach 的 `AND <col> IS NULL` 谓词、prepare /
     settle 的 (scope, key) 记录、finalize 的终态检查），因此重复**不会**
     产生第二笔购买、第二次扣款或第二次发货。
     上界 8 × 每轮 0.5 秒 = 4 秒，与"一次完整执行约 30～80ms"差两个数量级。 */
  function convergeIntentToEndpoint(intentId, options) {
    const o = options || {};
    let last = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      last = executeIntent(intentId, o);
      const row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
      if (row == null) break;
      if (C.isPurchaseIntentTerminalState(String(row.state))) break;
      /* 它没到终态：等一会儿再来一次。
         ★ 而"再来一次"必须走**同一条**入口（`executeIntent`），因此它会
         重新领执行权 —— 领到的人接着做，领不到的人继续等。
         两条路都由各自的幂等闸门保证只发生一次经济动作。 */
      const until = Date.now() + 500;
      while (Date.now() < until) { /* 有界等待：让另一个进程把结局写完 */ }
    }
    const finalRow = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    if (finalRow != null && C.isPurchaseIntentTerminalState(String(finalRow.state))) {
      const view = rowToPurchaseIntent(finalRow);
      /* ★★ `ok` 的语义必须在这里被**算一次**，而不能无条件写成 true ——
         多进程实测（B / C 组）踩到的一次真实缺陷：这一支一度硬编码
         `ok: true`，于是"预算说不、intent 走 FAILED"被报成一次成功，
         而 C1 恰好断言 `ok === false`。

         语义定下来是这一句：**`ok` 回答"这条 intent 最后买成了吗"**，
         而不是"这次调用有没有抛错"。
           · COMPLETED          → ok:true（买成了）；
           · DENIED / EXPIRED / FAILED → ok:false，并带回那个拒绝码 ——
             它是一次**有答案的拒绝**，不是一个未定义的结果。
         调用方要区分"被拒绝"与"出了故障"，看 `reasonCode` 是否落在契约的
         封闭集合里（`isDenyReasonCode`）。 */
      const completed = String(finalRow.state) === C.PURCHASE_INTENT_STATE.COMPLETED;
      return Object.assign({}, last, {
        ok: completed,
        intentId: String(intentId),
        intent: view,
        quoteId: view.quoteId,
        approvalId: view.approvalId,
        purchaseId: view.purchaseId,
        mayExecute: false,
        nextAction: 'none',
        purchaseCreated: view.purchaseId != null,
        reasonCode: completed ? null : view.reasonCode,
        terminalState: String(finalRow.state),
        converged: true
      });
    }
    return last;
  }

  /* 结算成功之后把 intent 记为 COMPLETED。**只有当 P22-6 的那一行真的是
     COMPLETED 时**才允许 —— 这条读是"不得假完成"的结构保证。 */
  function finalizeIntent(intentId, purchaseId, at, meta) {
    const purchaseRow = db.prepare(SQL.selectPurchase).get(String(purchaseId));
    if (!purchaseRow) {
      return { ok: false, denied: false, reasonCode: null, errors: ['purchase-not-found-after-settlement'] };
    }
    if (String(purchaseRow.status) !== C.PURCHASE_STATE.COMPLETED) {
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.FAILED, {
        reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(String(intentId)));
      return denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE,
        ['an-intent-may-only-complete-on-a-completed-purchase'],
        { intent: view, purchaseStatus: String(purchaseRow.status), purchaseId: String(purchaseId) });
    }
    const moved = transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.EXECUTING, C.PURCHASE_INTENT_STATE.COMPLETED, {
      purchaseId: String(purchaseId),
      /* ★ 一条成功的 intent 没有拒绝码。写成 `null` 而不是留旧值：
         它曾经带着 authority 的 reasonCode（可能是一条"为什么需要批准"
         的解释），而那条解释在成功的记录上会变成一句误导。 */
      reasonCode: null,
      completedAt: Number(at)
    });
    if (moved.ok !== true) {
      /* 并发：另一个进程先把它完成了。**不是**错误 —— 那正是"最多一次"
         想要的结果。 */
      const current = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
      const view = rowToPurchaseIntent(current);
      if (String(current.state) === C.PURCHASE_INTENT_STATE.COMPLETED) {
        return { ok: true, replayed: true, intent: view, purchaseId: String(purchaseId),
          concurrentCompletion: true };
      }
      return { ok: false, denied: false, reasonCode: moved.reasonCode || null,
        errors: moved.errors || ['intent-could-not-be-completed'], transition: moved, intent: view };
    }
    const finalRow = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    const view = rowToPurchaseIntent(finalRow);
    /* ── §16 第六个可崩溃边界：**Intent completed** ─────────────────────
       ★ 这个点排在状态推进**之后**、change log 之前：命中时那条 intent
       已经是 COMPLETED，而它缺一条 AGENT_INTENT_DETERMINED 的 change log。
       这是六个边界里**唯一**一个"事实已经全部成立、只是少了一条解释"的
       情形 —— 因此恢复路径对它的正确答案是"什么都不用重做"（终态闸门会
       把任何重试挡回去），而 change log 里少一条是**可接受**的：审计读的
       是 intent 的状态与它引用的购买，而不是某一条日志行是否写下了。 */
    faultPoint('after-intent-completed');
    appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, Object.assign({
      state: view.state,
      reasonCode: null,
      /* ★ 最终买了多少钱的**唯一**答案来自 canonical 行，而不是 intent。 */
      quoteId: String(purchaseRow.quote_id),
      transactionId: purchaseRow.ledger_transaction_id == null ? null : String(purchaseRow.ledger_transaction_id),
      reservationId: String(purchaseRow.reservation_id),
      inventoryEntryId: purchaseRow.inventory_entry_id == null ? null : String(purchaseRow.inventory_entry_id),
      ledgerMutation: true,
      inventoryMutation: purchaseRow.inventory_entry_id != null,
      completed: true
    }, meta || {}));
    return {
      ok: true,
      intentId: String(intentId),
      intent: view,
      quoteId: String(purchaseRow.quote_id),
      purchaseId: String(purchaseId),
      completed: true
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-8 §14 · proposeAgentPurchaseIntent —— **唯一**的提议入口

     它接受的是**一条提议**（六个字段的白名单），而不是一个经济请求。
     ★ 它的名字里没有 "execute"、没有 "settle"、没有 "approve"：
     那些词属于本函数**调用**的确定性 runtime，不属于它的调用方。
     ══════════════════════════════════════════════════════════════════ */
  function proposeAgentPurchaseIntent(input) {
    requireOpen();
    const o = input || {};
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };

    /* ① 规范化（§4 的经济事实拒绝发生在这里，排在一切之前）。 */
    const normalized = C.normalizePurchaseIntentProposal(o.proposal);
    if (normalized.ok !== true) {
      const code = normalized.reasonCode == null ? null : normalized.reasonCode;
      if (normalized.suppliedEconomicFacts && normalized.suppliedEconomicFacts.length) {
        /* ★ 这是一次**信任边界违规**，不是一次格式错误。 */
        return denial(C.DENY_REASON.MODEL_SUPPLIED_ECONOMIC_FACT,
          normalized.errors,
          {
            suppliedEconomicFacts: normalized.suppliedEconomicFacts,
            unknownKeys: normalized.unknownKeys,
            /* 这三句是"这些字段必须重新从 canonical Economy facts 派生"的
               可读版本 —— 递进来也不会被采纳。 */
            rejectedFieldsAreDerivedFromCanonicalFacts: true,
            acceptedProposalKeys: C.PURCHASE_INTENT_PROPOSAL_KEYS,
            proposedNothing: true
          });
      }
      return {
        ok: false, denied: false, reasonCode: code, errors: normalized.errors,
        unknownKeys: normalized.unknownKeys || [],
        /* ★ 这两个字段在**两种**拒绝上都在：一条"我拒了，而且我没读到任何
           经济事实"与一条"我拒了，因为你递了经济事实"必须是同一个形状，
           否则调用方就得靠 `undefined` 去猜自己撞上了哪一种。 */
        suppliedEconomicFacts: normalized.suppliedEconomicFacts || [],
        acceptedProposalKeys: C.PURCHASE_INTENT_PROPOSAL_KEYS,
        proposedNothing: true
      };
    }
    const proposal = normalized.proposal;
    const at = clock();

    /* ② 语义归一化：agent 必须是 canonical 角色 / 用户；recipient 同理。 */
    const agent = intentPartyOf(proposal.agentId, 'agentId');
    if (!agent.ok) return { ok: false, denied: false, reasonCode: null, errors: agent.errors };
    let recipient = null;
    if (proposal.recipientId != null) {
      const r = intentPartyOf(proposal.recipientId, 'recipientId');
      if (!r.ok) return { ok: false, denied: false, reasonCode: null, errors: r.errors };
      recipient = r.party;
      if (String(recipient.id) === String(agent.party.id)) {
        /* 与 P22-6 的 deriveRecipient 同一条纪律：给自己买就是 selfDirected，
           而不是"recipient 恰好等于 buyer"。 */
        return {
          ok: false, denied: false, reasonCode: C.DENY_REASON.INTENT_NOT_EXECUTABLE,
          errors: ['a-recipient-must-differ-from-the-agent'],
          hint: 'omit recipientId for a self-directed purchase'
        };
      }
    }

    /* ③ 有效期：夹在 [now, now + 上限] 之内。 */
    const requested = proposal.expiresAt == null ? null : Number(proposal.expiresAt);
    let expiresAt = requested == null ? at + C.PURCHASE_INTENT_DEFAULT_LIFETIME_MS : requested;
    if (expiresAt > at + C.PURCHASE_INTENT_MAX_LIFETIME_MS) {
      expiresAt = at + C.PURCHASE_INTENT_MAX_LIFETIME_MS;
    }
    if (expiresAt <= at) {
      return denial(C.DENY_REASON.INTENT_EXPIRED, ['intent-expires-at-is-not-in-the-future'],
        { expiresAt: Number(expiresAt), now: at, proposedNothing: true });
    }

    const canonical = {
      agentId: String(agent.party.id),
      agentType: String(agent.party.type),
      productId: String(proposal.productId),
      recipientId: recipient == null ? null : String(recipient.id),
      recipientType: recipient == null ? null : String(recipient.type),
      selfDirected: recipient == null,
      units: Number(proposal.units),
      reason: proposal.reason,
      expiresAt: Number(expiresAt)
    };

    /* ④ 身份（不含 reason，不含 expiresAt，不含任何生成的 id）。 */
    const fp = C.purchaseIntentFingerprint({
      agentId: canonical.agentId,
      productId: canonical.productId,
      recipientId: canonical.recipientId,
      units: canonical.units,
      selfDirected: canonical.selfDirected
    });
    if (fp.ok !== true) return denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE, fp.errors);

    /* ⑤ 那个商品此刻**存在**吗。这一条必须在写任何东西之前：一条指向
       不存在商品的 intent 连自己的报价都生成不出来，而"先写一条注定
       失败的记录"会让审计里多出一堆没有信息量的行。 */
    const productRow = db.prepare(SQL.selectProduct).get(canonical.productId);
    if (!productRow) {
      return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'],
        { productId: canonical.productId, proposedNothing: true, productBacked: false });
    }
    if (String(productRow.status) !== C.PRODUCT_STATUS.ACTIVE) {
      return denial(C.DENY_REASON.PRODUCT_DISABLED, ['product-is-not-active'],
        { productId: canonical.productId, productStatus: String(productRow.status), proposedNothing: true });
    }

    /* ⑥ Phase A：写下这条 intent（可崩溃边界 #1）。 */
    const created = createIntentRow(canonical, key.key, fp.fingerprint, at);
    if (created.ok !== true) return created;
    if (created.suppressed) return created;

    const intentId = created.intent.agentIntentId;
    /* ★ 重放的处理有一个真实的分支，而不是"原样返回当初那个结果"：
         ① 那条 intent 已经**越过** PROPOSED → 原样返回它当初的结局，
            但返回形状必须与首次调用**一致**（`intentId` / `quoteId` /
            `approvalId` 三个顶层字段都要在）。开发期实测踩到的一次真实
            缺陷：这一支曾经直接把 createIntentRow 的结果交出去，于是重放
            时 `intentId` 变成 undefined —— 一个"偶发缺失的 id"比一句错误
            难查得多，因为调用方会拿 undefined 去做下一步。
         ② 那条 intent **还停在** PROPOSED → 上一次调用在写完之后就中断了
            （§16 的第一个可崩溃边界）。此时"重放"的正确含义是**继续**，
            而不是把一条半成品当成答案 —— 否则这条 intent 会永久卡在
            PROPOSED 上，而调用方每次重试都拿到同一句"已存在"。
       两条都不是猜测：判据是那条 canonical 行自己的 state。 */
    if (created.replayed && RESOLVED_INTENT_STATES.indexOf(String(created.intent.state)) >= 0) {
      /* ★★ 而"越过 PROPOSED"里还有**两种**情形，它们的正确动作不同：
         · 那条 intent 还在 EXECUTING —— 上一次调用在结算前后中断了。此时
           "重放"= **继续把它做完**（`executeIntent` 自己会认出它有没有一笔
           已准备的购买，见 executeIntent 的恢复段）；
         · 任何终态 —— 原样返回它当初的结局。
        开发期实测（多进程崩溃组）踩到：少了上面那一条时，崩溃在
        "Purchase prepared" 之后的那条 intent 永久卡在 EXECUTING ——
        每次重试都回一句"已存在"，而库里躺着一次没有释放的预留。 */
      if (String(created.intent.state) === C.PURCHASE_INTENT_STATE.EXECUTING && created.intent.purchaseId == null) {
        /* ★ `owned` **不**传 true：这一支是从库里读到的 EXECUTING，而它究竟
           是"我上一次崩在这里"还是"另一个进程正在做"**读不出来**。执行权
           必须由 `claimIntentForExecution` 回答 —— 而它对 EXECUTING 的回答
           是 owned:false（不抢），于是这一支会走 `endpointOfIntentAfterLoss`：
           等那位执行者写完结局；如果根本没有执行者（崩溃留下的），那它写不出
           结局，于是本次调用如实回答"我正在被别人处理"。
           ★ 而"崩溃留下的 EXECUTING 必须能被接着做完"这条要求由**另一条
           路**满足：同一条 intent 的下一次 propose 会走到 `resolveIntent`，
           而它里面的认领段（`purchase_id == null && quote_id != null` →
           从报价上找回那笔 RESERVED 的购买并续做）正是为此存在的。
           开发期实测：把 `owned: true` 传进这一支会让两个进程**都**执行，
           而那正是 D 组与 E 组反复出现的不一致。 */
        const resumedExecution = executeIntent(intentId, {});
        return Object.assign({
          ok: resumedExecution.ok === true,
          intentId: intentId,
          quoteId: created.intent.quoteId,
          approvalId: created.intent.approvalId,
          mayExecute: true,
          replayedResolution: true,
          authorityOutcome: created.intent.authorityOutcome
        }, resumedExecution);
      }
      return {
        ok: true,
        replayed: true,
        idempotencyKey: String(key),
        intentId: created.intent.agentIntentId,
        intent: created.intent,
        quoteId: created.intent.quoteId,
        approvalId: created.intent.approvalId,
        purchaseId: created.intent.purchaseId,
        mayExecute: created.intent.state === C.PURCHASE_INTENT_STATE.EXECUTING,
        nextAction: created.intent.state === C.PURCHASE_INTENT_STATE.EXECUTING ? 'execute' : 'none'
      };
    }
    if (!created.replayed) {
      appendIntentChange(created.intent, C.EVENT_TYPE.AGENT_INTENT_PROPOSED, {
        state: C.PURCHASE_INTENT_STATE.PROPOSED,
        intentFingerprint: String(fp.fingerprint),
        /* ★ reason 进 change log 的 payload（可解释性），但**不进**指纹、
           不进任何判定 —— 见契约里那条载入期不变量。 */
        reason: canonical.reason == null ? null : String(canonical.reason),
        reasonIsAuthority: false,
        reasonParticipatesInDecisions: false,
        dedupeWindowMs: C.PURCHASE_INTENT_DEDUPE_WINDOW_MS
      });
    }

    /* ⑦ Phase B：报价 + 权威。 */
    const resolved = resolveIntent(intentId, {});
    if (resolved.ok !== true) {
      return Object.assign({}, resolved, { intentId: intentId, proposalAccepted: true });
    }
    /* ★ 一条已经拿到执行权的 intent 被重新提起时（`resolved.mayExecute`），
       "重放"的正确含义是**继续把它做完**，不是"原样返回一个还没做完的
       半成品"。开发期实测（多进程崩溃组）踩到的一次真实缺陷：少了这一段
       时，崩溃在 "Purchase prepared" 与 "Intent completed" 之间的那条
       intent 会永久卡在 EXECUTING —— 每一次重试都回一句"可以执行"然后
       什么都不做，而库里躺着一笔 RESERVED 的购买与一次**没有释放**的预留。

       ★ 而"要不要真的动手"由 `executeIntent` 自己决定：它第一件事就是去
       领执行权（`claimIntentForExecution`）。**领到的人执行，领不到的人
       等结局** —— 这条分工是多进程实测逼出来的，见那一处的说明。
       ★★ 反之，`resolved.claimedByAnotherProcess === true`（另一个进程正在
       处理它）**绝不能**走进执行 —— 那会让两个进程都动手，而它们的症状
       正是"赢家报 COMPLETED、输家报 QUOTE_MISMATCH"。
       （开发期实测：这一条曾经误写成 `mayExecute || claimedByAnotherProcess`，
       于是每一次正常的 AUTO_ALLOW 都变成"我以为别人在忙"而永不执行。） */
    if (resolved.mayExecute === true) {
      /* ★ 收尾之后把**权威那两句话**补回来：`convergeIntentToEndpoint` 只
         回答"这条 intent 最后怎么样了"，而"它为什么没问用户"由
         `authorityOutcome` / `autonomyPolicyId` 回答 —— 那是 §17 第四问的
         答案，不能因为多了一层收尾就丢掉。
         （开发期实测：少了这三行时，`propose` 在 AUTO_ALLOW 路径上不再返回
         `authorityOutcome`，而 D 组与 B 组都会把它读成 undefined。） */
      const converged = convergeIntentToEndpoint(intentId, { owned: true });
      /* `ok` 回答的是"**这次调用**成不成"，而一次"预算说不"的拒绝也是一次
         成立的调用 —— 但它必须与"它买成了"区分开，因此另给一位
         `purchaseCompleted`。（B/C 组的断言各自读它们要的那一位。） */
      const convergedOk = converged.ok === true;
      return Object.assign({
        ok: convergedOk,
        intentId: intentId,
        quoteId: resolved.quoteId == null ? converged.quoteId : resolved.quoteId,
        approvalId: resolved.approvalId == null ? null : resolved.approvalId,
        mayExecute: true,
        replayedResolution: resolved.replayed === true,
        authorityOutcome: resolved.authorityOutcome == null ? null : String(resolved.authorityOutcome),
        autonomyPolicyId: resolved.authorityPolicyId
      }, converged);
    }
    /* ★ 另一个进程正在处理这条 intent：**不**伪装成功，也**不**自己动手。
       如实返回它引用的东西与"我正在被别人处理"这个事实。 */
    if (resolved.claimedByAnotherProcess === true) {
      return {
        ok: true,
        intentId: intentId,
        intent: resolved.intent,
        quoteId: resolved.intent == null ? null : resolved.intent.quoteId,
        approvalId: resolved.intent == null ? null : resolved.intent.approvalId,
        mayExecute: false,
        nextAction: resolved.nextAction,
        claimedByAnotherProcess: true,
        /* 逐字：这条路径**没有**由本进程 reserve / 扣钱 / 发货。 */
        reservedNothing: true,
        purchaseCreated: false
      };
    }
    if (resolved.mayExecute !== true) {
      return {
        ok: true,
        intentId: intentId,
        intent: resolved.intent,
        verdict: resolved.verdict,
        /* ★ 这两个字段必须显式带出来，而不是靠"resolved 里有"。开发期实测
           踩到的一次真实缺陷：这个分支一度只手写了 8 个字段，于是
           `authorityOutcome` 在**不执行**的三条出口上都是 undefined ——
           而"这笔为什么没直接买"恰恰是那三条出口上最该被读到的答案。
           一个手写返回对象会把"加了一层"变成"少了一个字段"，而后者在
           JSON 里表现为**消失**，不是 null。 */
        authorityOutcome: resolved.authorityOutcome == null ? null : String(resolved.authorityOutcome),
        authorityPolicyId: resolved.authorityPolicyId == null ? null : String(resolved.authorityPolicyId),
        quoteId: resolved.quoteId,
        approvalId: resolved.approvalId,
        mayExecute: false,
        nextAction: resolved.nextAction,
        /* 逐字：这条路径**没有** reserve / 扣钱 / 发货。 */
        reservedNothing: true,
        purchaseCreated: false
      };
    }

    /* ⑧ Phase C：执行（P22-6）。★ 所有权交接：resolveIntent 刚刚把这条
       intent 领到 EXECUTING，因此这里直接以 owned: true 进入执行，而不是
       再抢一次（见 executeIntent 的说明）。 */
    const executed = executeIntent(intentId, { owned: true });
    return Object.assign({
      ok: executed.ok === true,
      intentId: intentId,
      quoteId: resolved.quoteId,
      approvalId: null,
      mayExecute: true,
      authorityOutcome: resolved.verdict.authorityOutcome,
      autonomyPolicyId: resolved.authorityPolicyId
    }, executed);
  }

  /* ── §7 Approval 恢复路径 ───────────────────────────────────────────
     ★ 它**不问模型第二次**：这条 intent 的 agent / 商品 / recipient /
     数量 / 报价全部来自 canonical 行，函数根本不接受这些参数。

     ★ 它也**不重新生成报价**：用的就是 intent 上挂的那一份。于是"批准
     一份 400 的报价、然后执行一份 500 的"在结构上不成立。

     ★ 如果那份报价已经过期：P22-6 的 preparePurchase 会用
     QUOTE_EXPIRED 拒绝，而 intent 走到 EXPIRED。**批准不会复活报价** ——
     这不是一句承诺，而是"preparePurchase 在写锁里重新比较 expires_at"
     的必然结果。 */
  function resumeAgentPurchaseIntent(input) {
    requireOpen();
    const o = input || {};
    const key = C.normalizeIdempotencyKey(o.idempotencyKey);
    if (!key.ok) return { ok: false, denied: false, reasonCode: null, errors: key.errors };
    if (o.agentIntentId != null && !C.isEconomyId('AGENT_INTENT', o.agentIntentId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['agent-intent-id-not-canonical'] };
    }
    if (o.approvalId != null && !C.isEconomyId('APPROVAL', o.approvalId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['approval-id-not-canonical'] };
    }
    const at = clock();

    /* 定位那条 intent：可以按 intentId，也可以按 approvalId（用户刚决定
       的就是那一条批准）。两条路都只**读** canonical 行。 */
    let row = null;
    if (o.agentIntentId != null) {
      row = db.prepare(SQL.selectPurchaseIntent).get(String(o.agentIntentId));
    } else if (o.approvalId != null) {
      const byApproval = db.prepare(SQL.selectPurchaseIntentByApproval).get(String(o.approvalId));
      row = byApproval || null;
    }
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['intent-not-found'] };
    const intentId = String(row.agent_intent_id);

    const seen = purchaseFingerprint(C.OPERATION_SCOPE.AGENT_INTENT_EXECUTE, {
      agentIntentId: intentId,
      approvalId: row.approval_id == null ? null : String(row.approval_id)
    });
    const replay = operationIdempotencyLookup(C.OPERATION_SCOPE.AGENT_INTENT_EXECUTE, key.key, seen);
    if (replay.found && replay.conflict) {
      return operationIdempotencyConflict(C.OPERATION_SCOPE.AGENT_INTENT_EXECUTE, key.key, replay);
    }
    if (replay.found) return { ok: true, replayed: true, idempotencyKey: key.key, result: replay.result };

    const state = String(row.state);
    if (state === C.PURCHASE_INTENT_STATE.COMPLETED) {
      /* ★ 一条已经完成的 intent 在被要求继续时，正确的答案是**重放它当初
         的结局**，而不是再走一遍裁决。
         ★ 开发期实测踩到的一次真实缺陷：这里一度先走裁决表，而裁决表看到
         "它那份报价已经被结算消费掉了（CONSUMED）"于是给出 INTENT_FAILED /
         QUOTE_MISMATCH —— 把一次**成功的**购买读成一次失败。报价被消费是
         购买成立的**结果**，不是它失败的原因；因此"已经完成"必须在读报价
         之前被回答，而且它不是一个裁决。 */
      return recordIntentExecution(key.key, seen, {
        ok: true, replayed: true, alreadyCompleted: true,
        intentId: intentId,
        intent: rowToPurchaseIntent(row),
        purchaseId: row.purchase_id == null ? null : String(row.purchase_id),
        quoteId: row.quote_id == null ? null : String(row.quote_id),
        mayExecute: false,
        nextAction: 'none',
        purchaseCreated: false
      }, intentId);
    }
    if (C.isPurchaseIntentTerminalState(state)) {
      const err = denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE, ['intent-is-terminal'],
        { terminal: true, intent: rowToPurchaseIntent(row) });
      return recordIntentExecution(key.key, seen, err, intentId);
    }
    if (state === C.PURCHASE_INTENT_STATE.EXECUTING) {
      /* 崩溃在"报价已建、权威已放行、购买还没开始"之后 —— 继续执行。
         ★ 这里**不**传 owned：那条 EXECUTING 究竟是"我上一次崩在这里"还是
         "另一个进程正在做"从库里读不出来，而执行权必须由
         `claimIntentForExecution` 回答（它对 EXECUTING 的回答是"不抢"）。
         于是本调用要么自己领到并接着做完，要么等赢家的结局 —— 两条都由
         `executeIntent` 自己决定。 */
      const executed = executeIntent(intentId, {});
      return recordIntentExecution(key.key, seen, executed, intentId);
    }
    if (state !== C.PURCHASE_INTENT_STATE.WAITING_APPROVAL) {
      /* PROPOSED：还没经过权威。先把它解出来。 */
      const resolved = resolveIntent(intentId, {});
      if (resolved.ok !== true) return recordIntentExecution(key.key, seen, resolved, intentId);
      if (resolved.mayExecute !== true) {
        /* ★ 领不到（另一个进程正在处理）或它落在等待路径上：如实返回，
           **不**伪装成功。 */
        return recordIntentExecution(key.key, seen, {
          ok: true, intentId: intentId, intent: resolved.intent,
          quoteId: resolved.quoteId == null ? null : resolved.quoteId,
          mayExecute: false,
          nextAction: resolved.nextAction,
          claimedByAnotherProcess: resolved.claimedByAnotherProcess === true,
          reservedNothing: true, purchaseCreated: false
        }, intentId);
      }
      /* ★ 所有权交接：resolveIntent 刚刚把这条 intent 领到 EXECUTING。 */
      const executed = convergeIntentToEndpoint(intentId, { owned: true });
      return recordIntentExecution(key.key, seen, executed, intentId);
    }

    /* ── WAITING_APPROVAL：唯一的恢复分支 ──────────────────────────────
       它的裁决**完全**由 P22-7 的那条批准记录决定，而 P22-8 不做任何
       "信任 / 好感 / 关系"的判断（§12）。 */
    const approvalRow = row.approval_id == null ? null
      : db.prepare(SQL.selectApproval).get(String(row.approval_id));
    if (!approvalRow) {
      const err = denial(C.DENY_REASON.APPROVAL_NOT_FOUND, ['the-approval-this-intent-waits-on-is-missing'],
        { intent: rowToPurchaseIntent(row) });
      return recordIntentExecution(key.key, seen, err, intentId);
    }
    const approvalStatus = rowToApproval(approvalRow).status;
    /* ★ 用户**还没有决定**时，"继续执行"的正确答案是"还没有" —— 而不是
       把这次 continue 当成一次拒绝。开发期实测踩到的一次真实缺陷：少了这
       一句，一次在用户决定**之前**发出的 continue 会走进下面的裁决表，
       而裁决表看到 status=PENDING 会给出 DENY，于是那条 intent 被**终结**
       成 DENIED —— 用户随后点头就再也没有东西可以继续了。
       因此这里必须先回答"还没决定"，而且**不写任何东西**（不迁移状态、
       不写 change log）。这条判断属于 P22-8 而不是裁决表，因为裁决表回答
       的是"这条 intent 现在能做什么"，而"批准还没决定"是 P22-7 的那张
       记录的状态，不是裁决的一部分。 */
    if (String(approvalStatus) === C.APPROVAL_STATE.PENDING) {
      const notYet = denial(C.DENY_REASON.APPROVAL_REQUIRED,
        ['the-approval-this-intent-waits-on-has-not-been-decided-yet'],
        {
          /* ★ `intentId` 必须在：它与每一条别的出口一样，是调用方接下来
             要用它去继续做事的那个身份。开发期实测踩到的一次真实缺陷：
             这一支一度漏了它，于是"还没决定"这一条**唯一**正常的、会发生
             很多次的返回里，调用方拿到的 intentId 是 undefined。 */
          intentId: String(intentId),
          intent: rowToPurchaseIntent(row),
          approvalId: String(row.approval_id),
          approvalStatus: String(approvalStatus),
          intentState: String(row.state),
          purchaseCreated: false,
          reservedNothing: true
        });
      return recordIntentExecution(key.key, seen, notYet, intentId);
    }
    const authority = evaluateAutonomousPurchaseFor({
      buyerId: String(row.agent_id),
      quoteId: String(row.quote_id),
      recipientId: row.recipient_id == null ? null : String(row.recipient_id),
      now: at
    });
    const verdict = C.evaluatePurchaseIntentVerdict({
      now: at,
      intentStatus: String(row.state),
      expiresAt: Number(row.expires_at),
      productId: String(row.product_id),
      quoteState: row.quote_id == null ? null : (db.prepare(SQL.selectQuote).get(String(row.quote_id)) || {}).state,
      authority: authority,
      approvalStatus: approvalStatus
    });
    if (verdict.ok !== true) return recordIntentExecution(key.key, seen, verdict, intentId);

    if (verdict.outcome === C.INTENT_VERDICT.DENY) {
      const to = String(approvalStatus) === C.APPROVAL_STATE.REJECTED
        ? C.PURCHASE_INTENT_STATE.DENIED : C.PURCHASE_INTENT_STATE.DENIED;
      const moved = transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.WAITING_APPROVAL, to, {
        reasonCode: verdict.reasonCode == null ? C.DENY_REASON.APPROVAL_REQUIRED : String(verdict.reasonCode)
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(intentId));
      appendIntentChange(view, C.EVENT_TYPE.AGENT_INTENT_DETERMINED, {
        state: view.state, reasonCode: view.reasonCode, approvalStatus: String(approvalStatus),
        rejectedByUser: String(approvalStatus) === C.APPROVAL_STATE.REJECTED,
        approvalAlreadySpent: verdict.approvalAlreadySpent === true
      });
      const err = denial(verdict.reasonCode == null ? C.DENY_REASON.APPROVAL_REQUIRED : verdict.reasonCode,
        ['the-approval-path-ended-without-executing'], {
          intent: view, approvalStatus: String(approvalStatus), transitioned: moved.ok === true, purchaseCreated: false
        });
      return recordIntentExecution(key.key, seen, err, intentId);
    }
    if (verdict.outcome === C.INTENT_VERDICT.FAIL) {
      const to = verdict.reasonCode === C.DENY_REASON.INTENT_EXPIRED
        ? C.PURCHASE_INTENT_STATE.EXPIRED : C.PURCHASE_INTENT_STATE.FAILED;
      transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.WAITING_APPROVAL, to, {
        reasonCode: verdict.reasonCode == null ? C.DENY_REASON.APPROVAL_EXPIRED : String(verdict.reasonCode)
      });
      const view = rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(intentId));
      const err = denial(verdict.reasonCode == null ? C.DENY_REASON.APPROVAL_EXPIRED : verdict.reasonCode,
        [to === C.PURCHASE_INTENT_STATE.EXPIRED
          ? 'the-intent-expired-before-its-approval-could-be-used'
          : 'the-approved-path-could-not-be-executed'],
        { intent: view, approvalStatus: String(approvalStatus), purchaseCreated: false,
          approvalCannotReviveAnExpiredQuote: true });
      return recordIntentExecution(key.key, seen, err, intentId);
    }
    if (verdict.outcome !== C.INTENT_VERDICT.EXECUTE_APPROVED) {
      const err = denial(C.DENY_REASON.APPROVAL_REQUIRED, ['the-approval-is-not-yet-approved'],
        { intent: rowToPurchaseIntent(row), approvalStatus: String(approvalStatus), purchaseCreated: false });
      return recordIntentExecution(key.key, seen, err, intentId);
    }

    /* ── 用户点头了：WAITING_APPROVAL → EXECUTING → P22-6 ───────────────
       ★★ 这一步同时是**执行权的领取**（与 propose 路径共用同一个答案：
       领到的人执行，领不到的人等结局）。开发期实测（E / F 组，两个真实
       进程同时 resume 同一条 APPROVED intent）踩到过两种都错的写法：

         ① 两边都执行 —— 它们各自 prepare 同一份报价（P22-6 的幂等闸门会
            给出同一笔购买，那是幂等性在起作用），随后各自把 purchase 挂到
            同一条 intent 上、各自结算。症状是"赢家报 COMPLETED、输家报
            QUOTE_MISMATCH"，以及库里留下一笔 RESERVED 的购买与一次
            **没有释放**的预留；
         ② 把并发失败报成一次业务拒绝（`intent-state-changed-under-the-
            transition`）—— 而输家的世界其实**完全正确**（赢家已经结算完
            了）。这会让两个进程读到两个世界。

       正确的形状：这一句 UPDATE 的 `changes` 就是执行权的判决 ——
       changes=1 的人继续做（并以 `owned: true` 进入 executeIntent，因为
       所有权刚刚到手）；changes=0 的人去 `endpointOfIntentAfterLoss`
       读赢家写下的结局（有界等待到终态为止）。 */
    const moved = transitionPurchaseIntent(intentId, C.PURCHASE_INTENT_STATE.WAITING_APPROVAL,
      C.PURCHASE_INTENT_STATE.EXECUTING, { reasonCode: null });
    if (moved.ok !== true) {
      if (moved.concurrent === true) {
        const lost = endpointOfIntentAfterLoss(intentId);
        return recordIntentExecution(key.key, seen, lost, intentId);
      }
      const err = denial(C.DENY_REASON.INTENT_NOT_EXECUTABLE, moved.errors || ['intent-could-not-enter-execution'],
        { transition: moved, intent: rowToPurchaseIntent(db.prepare(SQL.selectPurchaseIntent).get(intentId)) });
      return recordIntentExecution(key.key, seen, err, intentId);
    }
    const executed = convergeIntentToEndpoint(intentId, { owned: true });
    return recordIntentExecution(key.key, seen, executed, intentId);
  }

  /* §11：跨重启的幂等结果。**只在对端有定论时写** —— 一条"还没决定"的
     结果不该被记成可重放的答案。 */
  function recordIntentExecution(key, fingerprint, result, intentId) {
    const row = db.prepare(SQL.selectPurchaseIntent).get(String(intentId));
    const settledState = row ? String(row.state) : null;
    const definite = settledState != null && C.isPurchaseIntentTerminalState(settledState);
    if (definite && result && result.ok === true) {
      try {
        withTransaction(() => {
          db.prepare(SQL.insertOperationIdempotency).run(
            C.OPERATION_SCOPE.AGENT_INTENT_EXECUTE, String(key), String(fingerprint),
            /* operation_id / reservation_id / transaction_id 三列在这里是
               null：这条 scope 锁的是一次**执行尝试**，它自己的身份就是
               (scope, key)，而它产生的 operation/reservation/transaction
               属于 purchase 那一侧、各有自己的 id。塞一个 purchaseId 进去
               会让"operation_id 指向什么"变成一个问题。 */
            null, null, null,
            JSON.stringify({ intentId: String(intentId), state: settledState }),
            Number(allocateRevision()), Number(clock())
          );
        });
      } catch (error) {
        if (!isRefusal(error)) throw error;
      }
    }
    return result;
  }

  /* ── 读面（§15/§17）──────────────────────────────────────────────── */
  function getPurchaseIntent(input) {
    requireOpen();
    const o = typeof input === 'string' ? { agentIntentId: input } : (input || {});
    const id = o.agentIntentId != null ? String(o.agentIntentId) : null;
    if (!C.isEconomyId('AGENT_INTENT', id)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['agent-intent-id-not-canonical'] };
    }
    const row = db.prepare(SQL.selectPurchaseIntent).get(id);
    if (!row) return { ok: false, denied: false, reasonCode: null, errors: ['intent-not-found'], agentIntentId: id };
    const view = rowToPurchaseIntent(row);
    const out = {
      ok: true,
      agentIntentId: view.agentIntentId,
      intent: serializePurchaseIntent(view),
      personalized: false,
      recommended: false,
      ranked: false
    };
    if (o.withChain === true) {
      out.chain = intentChainOf(view);
    }
    return out;
  }

  /* §17：仅凭 canonical facts 就能回答那六个问题。这个函数把那条链拼出来，
     而它**不**读 reason 来做任何判断 —— reason 只是被带出来给人看。 */
  function intentChainOf(view) {
    const chain = {
      agentIntentId: view.agentIntentId,
      whyThisPurchaseExists: { agentIntentId: view.agentIntentId },
      whatTheAgentWanted: {
        productId: view.productId, recipientId: view.recipientId, units: view.units,
        reason: view.reason, reasonIsAuthority: false
      },
      whyItDidNotBuyDirectly: view.authorityOutcome === C.AP_DECISION.REQUIRE_APPROVAL
        ? { authorityOutcome: view.authorityOutcome, reasonCode: view.authorityReasonCode } : null,
      whyItBoughtDirectly: view.authorityOutcome === C.AP_DECISION.AUTO_ALLOW
        ? { authorityOutcome: view.authorityOutcome, budgetWasStillRequired: true } : null,
      approval: null,
      quote: null,
      purchase: null
    };
    if (view.approvalId != null) {
      const a = db.prepare(SQL.selectApproval).get(String(view.approvalId));
      if (a) {
        chain.approval = {
          approvalId: String(a.approval_id),
          status: String(a.status),
          consumedByPurchaseId: a.consumed_by_purchase_id == null ? null : String(a.consumed_by_purchase_id),
          bindingFingerprint: String(a.binding_fingerprint)
        };
      }
    }
    if (view.quoteId != null) {
      const q = db.prepare(SQL.selectQuote).get(String(view.quoteId));
      if (q) {
        chain.quote = {
          quoteId: String(q.quote_id), state: String(q.state), currency: String(q.currency),
          amountMinor: C.serializeAmountMinor(fromSqlAmount(q.amount_minor, 'quote-amount')),
          quantity: Number(q.quantity), quoteKind: String(q.quote_kind),
          productId: String(q.product_id), expiresAt: Number(q.expires_at)
        };
      }
    }
    if (view.purchaseId != null) {
      const p = db.prepare(SQL.selectPurchase).get(String(view.purchaseId));
      if (p) {
        chain.purchase = {
          purchaseId: String(p.purchase_id), status: String(p.status),
          quoteId: String(p.quote_id), reservationId: String(p.reservation_id),
          ledgerTransactionId: p.ledger_transaction_id == null ? null : String(p.ledger_transaction_id),
          approvalMode: p.approval_mode == null ? null : String(p.approval_mode),
          autonomyPolicyId: p.autonomy_policy_id == null ? null : String(p.autonomy_policy_id),
          inventoryEntryId: p.inventory_entry_id == null ? null : String(p.inventory_entry_id),
          amountMinor: C.serializeAmountMinor(fromSqlAmount(p.amount_minor, 'purchase-amount')),
          currency: String(p.currency)
        };
      }
    }
    return chain;
  }

  function listPurchaseIntents(options) {
    requireOpen();
    const o = options || {};
    const agentShape = o.agentId == null ? null : C.normalizeIntentPartyId(o.agentId);
    if (agentShape != null && agentShape.ok !== true) {
      return { ok: false, denied: false, reasonCode: null, errors: agentShape.errors };
    }
    const productId = o.productId == null ? null : String(o.productId);
    if (productId != null && !C.isEconomyId('PRODUCT', productId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['product-id-not-canonical'] };
    }
    const state = o.state == null ? null : String(o.state);
    if (state != null && !C.isPurchaseIntentState(state)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['intent-state-not-in-closed-set'],
        allowed: C.PURCHASE_INTENT_STATES };
    }
    let limit = o.limit == null ? 50 : Number(o.limit);
    if (!Number.isSafeInteger(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;
    const rows = db.prepare(SQL.selectPurchaseIntentsFiltered).all(
      agentShape == null ? null : agentShape.id, agentShape == null ? null : agentShape.id,
      productId, productId,
      state, state,
      Number(limit)
    );
    return {
      ok: true,
      intents: rows.map(r => serializePurchaseIntent(rowToPurchaseIntent(r))),
      count: rows.length,
      personalized: false,
      recommended: false,
      ranked: false
    };
  }

  function countPurchaseIntents(state) {
    if (!isOpen()) return 0;
    if (state == null) return Number(db.prepare(SQL.countPurchaseIntents).get().c);
    return Number(db.prepare(SQL.countPurchaseIntentsByState).get(String(state)).c);
  }

  function intentStateCounts() {
    const out = {};
    for (const s of C.PURCHASE_INTENT_STATES) out[s] = countPurchaseIntents(s);
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-7 §26 · authorizePurchaseIntent（授权闸门）

     §10 的四个出口，逐字对应下面四条 return：

       AUTO_ALLOW        → allowed:true, mode:AUTO_ALLOW, proceedToPrepare:true
       REQUIRE_APPROVAL  → allowed:false, approvalRequired:true, 并**创建**
                           一条 PENDING 记录（除非调用方只要评估）
       valid APPROVED    → allowed:true, mode:APPROVAL, proceedToPrepare:true
       DENY              → allowed:false, denied:true（**不**创建任何记录）

     ★ 它**不**调用 preparePurchase。§10 那张图里
     `authorizePurchaseIntent → preparePurchase → settlePurchase` 是三次
     独立的调用，而合并它们会让"授权"与"买"变成一个不可分开观察的动作 ——
     于是"Gate 说可以但购买因为其它原因失败"这个真实情形在审计里消失。
     调用方（测试、未来的 Action 层）按顺序调用它们。

     ★ 它**不**评估预算。Budget 与 Autonomy 是两个独立闸门（§3），
     合并会让"为什么没成"丢掉一个答案。 */
  function authorizePurchaseIntent(input) {
    requireOpen();
    const o = input || {};
    const buyer = partyInput(o.buyerId != null ? o.buyerId : o.ownerId);
    if (!buyer.ok) return { ok: false, denied: false, reasonCode: null, errors: buyer.errors };
    if (buyer.party.type === C.PARTY_TYPE.SYSTEM) {
      return { ok: false, denied: false, reasonCode: null, errors: ['system-party-cannot-buy'] };
    }
    const buyerType = String(buyer.party.type);
    const buyerId = String(buyer.party.id);
    const quoteId = o.quoteId == null ? null : String(o.quoteId);
    if (!C.isEconomyId('QUOTE', quoteId)) {
      return { ok: false, denied: false, reasonCode: null, errors: ['quote-id-not-canonical'] };
    }
    const quoteRow = db.prepare(SQL.selectQuote).get(quoteId);
    if (!quoteRow) return { ok: false, denied: false, reasonCode: null, errors: ['quote-not-found'] };
    const productRow = db.prepare(SQL.selectProduct).get(String(quoteRow.product_id));
    if (!productRow) return denial(C.DENY_REASON.PRODUCT_NOT_FOUND, ['product-not-found'], { productId: String(quoteRow.product_id) });

    const recipient = deriveRecipient(buyer.party, o.recipientId);
    if (!recipient.ok) return { ok: false, denied: false, reasonCode: null, errors: recipient.errors };
    if (String(quoteRow.buyer_id) !== buyerId || String(quoteRow.buyer_type) !== buyerType) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['quote-buyer-does-not-match-the-authorized-buyer'],
        { quoteBuyerId: String(quoteRow.buyer_id), authorizedBuyerId: buyerId });
    }
    if (!recipientMatchesQuote(recipient.party, quoteRow)) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, ['quote-recipient-does-not-match-the-authorized-recipient'],
        { quoteRecipientId: quoteRow.recipient_id == null ? null : String(quoteRow.recipient_id) });
    }

    const at = o.now != null ? Number(o.now) : clock();
    if (!Number.isSafeInteger(at) || at < 0) {
      return { ok: false, denied: false, reasonCode: null, errors: ['now-must-be-a-non-negative-safe-integer'] };
    }
    const product = rowToProduct(productRow);
    /* ── P22-26 · 份数只来自报价 ───────────────────────────────────────
       这里是三处"从 payload 猜 units"的最后一处，而它的后果最隐蔽：
       这一段的 `expected` 是**九元组绑定**（budget / approval 都拿它与
       自己的记录逐项比对）。用请求里的 units 去重建它，会让一份 units = 3
       的报价在授权判定里被表达成 units = 1 —— 于是批准九元组与实际要执行
       的那一笔**不是同一件事**，而判定仍然"通过"。
       权威是报价上冻结的那一列，且 quantity == units × grantQuantity 在此
       同样被断言。 */
    const quantities = quoteQuantitiesOf(product, quoteRow);
    if (!quantities.ok) {
      return denial(C.DENY_REASON.QUOTE_MISMATCH, quantities.errors, {
        quoteId: quoteId, quoteUnits: quantities.units
      });
    }
    const units = quantities.units;
    const quoteAmountMinor = fromSqlAmount(quoteRow.amount_minor, 'quote-amount');
    const expected = {
      buyerId: partyKeyOf(buyerType, buyerId),
      recipientId: recipient.party == null ? null : partyKeyOf(recipient.party.type, recipient.party.id),
      productId: String(quoteRow.product_id),
      quoteId: quoteId,
      currency: String(quoteRow.currency),
      amountMinor: quoteAmountMinor,
      settlementType: String(product.fulfillment),
      grantQuantity: quantities.quantity,
      units: units
    };

    /* ── ① 有效批准优先：一条 APPROVED 且未过期的批准就是许可证 ────────
       ★ "有效"逐字是三个条件：状态是 APPROVED、没有过期、
       **九个绑定字段与这一笔完全一致**。第三条是 §6 的全部内容 —— 拿
       "用户批准过 400" 去执行另一笔 400 会在这里被 approvalBindingMismatch
       拦下，因为它比的是 buyer/recipient/product/quote/currency/amount/
       settlement/grantQuantity/units 九项，而不是一个金额。 */
    let approved = null;
    if (o.approvalId != null) {
      const approvalId = String(o.approvalId);
      if (!C.isEconomyId('APPROVAL', approvalId)) {
        return { ok: false, denied: false, reasonCode: null, errors: ['approval-id-not-canonical'] };
      }
      const row = db.prepare(SQL.selectApproval).get(approvalId);
      if (!row) return denial(C.DENY_REASON.APPROVAL_NOT_FOUND, ['approval-not-found'], { approvalId: approvalId });
      const approval = rowToApproval(row);
      const diffs = approvalBindingMismatch(approval, expected);
      if (diffs.length) {
        return denial(C.DENY_REASON.APPROVAL_MISMATCH,
          ['this-approval-authorizes-a-different-purchase'],
          {
            /* ★ 三个显式的字段让拒绝的形状与它周围两条闸门分支**一致**：
               一条拒绝必须能回答"允不允许 / 拒不拒绝 / 是否终局"，
               否则调用方拿到的是 ok===undefined（开发期实测踩到）。 */
            allowed: false, denied: true, terminal: false,
            approvalId: approvalId,
            approvalStatus: approval.status,
            mismatchedFields: diffs.map(d => d.field),
            differences: diffs,
            approvalBoundFingerprint: approval.bindingFingerprint,
            requestedBindingFingerprint: (C.approvalFingerprint(expected).fingerprint || null),
            oneApprovalCannotBeMovedToAnotherPurchase: true
          });
      }
      if (C.isApprovalTerminalState(approval.status)) {
        return denial(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['this-approval-is-already-terminal'], {
          approvalId: approvalId, approvalStatus: approval.status, terminal: true
        });
      }
      if (approval.status !== C.APPROVAL_STATE.APPROVED) {
        return denial(C.DENY_REASON.APPROVAL_REQUIRED, ['this-approval-is-still-pending-a-decision'], {
          approvalId: approvalId, approvalStatus: approval.status, approvalRequired: true
        });
      }
      if (Number(approval.expiresAt) <= at) {
        return denial(C.DENY_REASON.APPROVAL_EXPIRED, ['this-approval-is-past-its-expires-at'], {
          approvalId: approvalId, approvalStatus: approval.status,
          expiresAt: approval.expiresAt, now: at, sweepRequired: true
        });
      }
      approved = approval;
    }

    if (approved) {
      return {
        ok: true,
        allowed: true,
        denied: false,
        mode: C.PURCHASE_APPROVAL_MODE.APPROVAL,
        approvalMode: C.PURCHASE_APPROVAL_MODE.APPROVAL,
        autonomyOutcome: null,
        autonomyPolicyId: approved.autonomyPolicyId,
        approvalId: approved.approvalId,
        /* ★ 这两句是"把这张许可证交给 preparePurchase"的**字面**做法：
           调用方把 approvalId / approvalBindingFingerprint / autonomyPolicyId
           三个值原样传下去，而模式由它们推导（preparePurchase 不接受 mode）。 */
        prepareInput: Object.freeze({
          approvalId: approved.approvalId,
          approvalBindingFingerprint: null,
          autonomyPolicyId: approved.autonomyPolicyId
        }),
        approvalStatus: approved.status,
        approvalRequired: false,
        approvalCreated: false,
        proceedToPrepare: true,
        purchaseCreated: false,
        fundsReserved: false,
        ledgerMutation: false,
        inventoryMutation: false,
        bindingFingerprint: approved.bindingFingerprint,
        expectedBinding: expected,
        reasonCode: null,
        at: Number(at),
        /* 逐字：许可证只覆盖授权；预算与报价有效性都还要各自过一遍。 */
        approvalBypassesBudget: C.APPROVAL_BYPASSES_BUDGET,
        approvalBypassesQuoteExpiry: C.APPROVAL_BYPASSES_QUOTE_EXPIRY,
        note: 'a valid approval authorises this exact purchase; budget and quote validity are still evaluated by P22-6'
      };
    }

    /* ── ② 没有批准 ⇒ 自主策略判定 ─────────────────────────────────── */
    const policy = autonomyPolicyForOwner(buyerId);
    const built = autonomyContextOf(quoteRow, productRow, buyer.party, recipient.party, policy, at);
    if (!built.ok) {
      return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, built.errors, { autonomyPolicyId: policy ? policy.policyId : null });
    }
    const decision = C.evaluateAutonomousPurchase(policy, built.context);
    const base = {
      buyerId: partyKeyOf(buyerType, buyerId),
      recipientId: expected.recipientId,
      quoteId: quoteId,
      productId: String(quoteRow.product_id),
      productKind: String(productRow.product_kind),
      settlementType: String(product.fulfillment),
      currency: String(quoteRow.currency),
      amountMinor: C.serializeAmountMinor(quoteAmountMinor),
      units: units,
      grantQuantity: quantities.quantity,
      expectedBinding: expected,
      autonomyOutcome: decision.outcome,
      autonomyReasonCode: decision.reasonCode,
      autonomyPolicyId: policy ? policy.policyId : null,
      autonomyPolicyPresent: !!policy,
      autonomyDecisionPriority: decision.priority,
      autonomyRule: decision.rule == null ? null : String(decision.rule),
      autonomySnapshot: decision.snapshot,
      spentTodayMinor: C.serializeAmountMinor(built.spentTodayMinor),
      resolvedRecipientId: expected.recipientId,
      purchaseCreated: false,
      fundsReserved: false,
      ledgerMutation: false,
      inventoryMutation: false,
      at: Number(at)
    };

    if (decision.outcome === C.AP_DECISION.DENY) {
      /* ── DENY：**不创建任何记录**。一次被规则排除的尝试不是一条待批准
             的事 —— 创建一个永远没人该处理的 PENDING 记录会把"被拒绝"
             伪装成"等待中"（§10 逐字：DENY → stop）。 */
      return Object.assign(denial(decision.reasonCode, ['autonomy-policy-denies-this-purchase'], Object.assign({}, base, {
        allowed: false, mode: null, approvalRequired: false, approvalCreated: false,
        approvalId: null, proceedToPrepare: false, purchaseCreated: false
      })), {
        denied: true,
        terminal: false,
        autonomyOutcome: decision.outcome
      });
    }

    /* ── REQUIRE_APPROVAL：创建一条 PENDING 记录，然后停下 ─────────────
       ★ 这条分支**必须**由 decision.outcome 把关。它下面就是 AUTO_ALLOW
       的出口，因此"没有把关"会让每一次自主放行都先要求一个
       approvalExpiresAt 并在这里返回 APPROVAL_REQUIRED —— 那是一个
       静默的功能性缺陷（开发期实测踩到：策略明确说 AUTO_ALLOW，而
       闸门回答"需要用户批准"）。 */
    if (decision.outcome === C.AP_DECISION.AUTO_ALLOW) {
      /* 落到下面那个出口 —— 见 §"AUTO_ALLOW" 一段。 */
    } else {
      const approvalId = o.approvalId != null ? String(o.approvalId) : null;
      if (!Number.isSafeInteger(Number(o.approvalExpiresAt)) || Number(o.approvalExpiresAt) < 0) {
        return denial(C.DENY_REASON.APPROVAL_REQUIRED,
          ['an-approval-request-must-carry-a-future-approval-expires-at'],
          Object.assign({}, base, {
            allowed: false, mode: null, approvalRequired: true,
            approvalCreated: false, proceedToPrepare: false
          }));
      }
      const created = createApprovalRequest({
        buyerId: buyer.party,
        recipientId: recipient.party,
        quoteId: quoteId,
        units: units,
        expiresAt: Number(o.approvalExpiresAt),
        approvalId: o.approvalRecordId != null ? String(o.approvalRecordId) : approvalId,
        idempotencyKey: o.approvalIdempotencyKey != null ? o.approvalIdempotencyKey : o.idempotencyKey,
        autonomyPolicyId: policy ? policy.policyId : null,
        autonomyOutcome: decision.outcome,
        autonomyReasonCode: decision.reasonCode
      });
      if (created.ok !== true) return created;
      return Object.assign({}, base, {
        ok: true,
        allowed: false,
        denied: true,
        terminal: false,
        mode: null,
        approvalMode: null,
        approvalBindingFingerprint: null,
        approvalRequired: true,
        approvalCreated: created.replayed !== true,
        approvalReplayed: created.replayed === true,
        approvalId: created.result.approvalId,
        approvalStatus: created.result.status,
        approvalExpiresAt: created.result.expiresAt,
        proceedToPrepare: false,
        reasonCode: C.DENY_REASON.APPROVAL_REQUIRED,
        errors: ['this-purchase-requires-user-approval'],
        approvalRequestIdempotencyKey: created.idempotencyKey
      });
    }

    /* ── AUTO_ALLOW：把九元组身份算出来交给调用方，然后放行 ────────────
       ★ 这个指纹是"这台 Agent 有权不问用户直接买**这一笔**"的凭据，
       而它不是一张可以被挪用的许可证：preparePurchase 会把它连同这一笔
       的九元组一起**重算**一遍（见 validateAutonomousApprovalInTx），
       因此它只能在它本来描述的那一笔上生效。 */
    const autoBinding = C.approvalFingerprint(expected);
    if (!autoBinding.ok) {
      return denial(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, autoBinding.errors, base);
    }
    return Object.assign({}, base, {
      ok: true,
      allowed: true,
      denied: false,
      terminal: false,
      mode: C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW,
      approvalMode: C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW,
      approvalBindingFingerprint: String(autoBinding.fingerprint),
      approvalBindingFingerprintSource: 'recomputed-from-canonical-facts',
      approvalId: null,
      approvalStatus: null,
      approvalRequired: false,
      approvalCreated: false,
      proceedToPrepare: true,
      reasonCode: null,
      errors: [],
      /* ★ 调用方把这三个值原样交给 preparePurchase（模式由它们推导）。 */
      prepareInput: Object.freeze({
        approvalId: null,
        approvalBindingFingerprint: String(autoBinding.fingerprint),
        autonomyPolicyId: policy ? policy.policyId : null
      }),
      approvalBypassesBudget: C.APPROVAL_BYPASSES_BUDGET,
      approvalBypassesQuoteExpiry: C.APPROVAL_BYPASSES_QUOTE_EXPIRY,
      note: 'the autonomy policy allows this agent to buy this exact purchase without asking the user; budget and quote validity are still evaluated by P22-6'
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-7 §27 · 与 P22-6 的两个事务内 seam

     两者的存在理由都是同一条：**授权的消费必须与购买的落定在同一个
     SQLite 事务里**，否则会出现"批准已消费但购买没成立"的撕裂事实（§10）。

     ★ 为什么消费发生在**结算**而不是 prepare（这是本阶段最重要的一个
     判断，逐条论证）：

     ① §8 要求「成功进入对应 Purchase 后」才 APPROVED → CONSUMED。哪一
        刻算"成功进入"？两种候选：
          · prepare 成功（Purchase 行 RESERVED）—— 若此后进程崩溃或购买
            被取消，库外会留下"批准已消费 + 购买 RESERVED 然后 RELEASED"，
            即一条被烧掉的批准对应一次失败的购买。§10 逐字禁止这个形状；
          · settle 成功（钱真的动了）—— 崩溃只留下"批准仍 APPROVED +
            购买 RESERVED"，可安全重试。
     ② §15 要求「两个进程拿同一个 APPROVED Approval 买 ⇒ 最多一个
        Purchase」。这一条**不**依赖消费时刻：
          · setApprovalConsumed 的 `AND status='APPROVED'` 谓词让第二次
            消费 changes=0；
          · 而且授权绑定的 quoteId 与 purchase 的 `quote_id` UNIQUE 索引
            一起保证"一份报价最多一笔购买"—— 两个进程拿同一条批准去
            prepare 同一份报价时，第二个会撞上那条 UNIQUE 或那张已消费的
            报价。
     ③ §11 要求「Approval 绝不能绕过 P22-4/P22-6」。在结算事务里消费
        恰好把"批准"与"最终预算复核"放在同一个原子单位里：预算 DENY 时
        整个事务回滚，批准回到 APPROVED，钱一分不动 —— 于是"批准不能
        当预算豁免"不仅是一句话，而是同一个 ROLLBACK 的两个后果。
     ══════════════════════════════════════════════════════════════════ */

  /* ── validateApprovalForPreparationInTx（在 prepare 的写锁里调用）────
     它**不**消费批准，只回答"这张许可证现在还有效吗，而且它说的就是
     这一笔吗"。任何不成立都抛 refuse ⇒ 整个 prepare 回滚（§10：一条
     无效的批准不能换来一次预留）。 */
  function validateApprovalForPreparationInTx(approvalId, purchaseId, expected, at) {
    const row = db.prepare(SQL.selectApproval).get(String(approvalId));
    if (!row) throw refuse(C.DENY_REASON.APPROVAL_NOT_FOUND, ['approval-not-found'], { approvalId: String(approvalId) });
    const approval = rowToApproval(row);
    const diffs = approvalBindingMismatch(approval, expected);
    if (diffs.length) {
      throw refuse(C.DENY_REASON.APPROVAL_MISMATCH, ['this-approval-authorizes-a-different-purchase'], {
        approvalId: String(approvalId),
        mismatchedFields: diffs.map(d => d.field),
        differences: diffs,
        oneApprovalCannotBeMovedToAnotherPurchase: true
      });
    }
    if (C.isApprovalTerminalState(approval.status)) {
      throw refuse(C.DENY_REASON.TRANSITION_NOT_ALLOWED, ['this-approval-is-already-terminal'], {
        approvalId: String(approvalId), approvalStatus: approval.status, terminal: true
      });
    }
    if (approval.status !== C.APPROVAL_STATE.APPROVED) {
      throw refuse(C.DENY_REASON.APPROVAL_REQUIRED, ['this-approval-is-not-approved'], {
        approvalId: String(approvalId), approvalStatus: approval.status, approvalRequired: true
      });
    }
    if (Number(approval.expiresAt) <= Number(at)) {
      throw refuse(C.DENY_REASON.APPROVAL_EXPIRED, ['this-approval-is-past-its-expires-at'], {
        approvalId: String(approvalId), expiresAt: approval.expiresAt, now: Number(at)
      });
    }
    /* 一笔批准最多被一笔购买消费。若它已经指向某笔购买而这个 purchaseId
       不是那一笔，就说明有人试图把同一张许可证用第二次。 */
    const linked = db.prepare(SQL.selectApprovalByConsumedPurchase).get(String(purchaseId));
    if (linked && String(linked.approval_id) !== String(approvalId)) {
      throw refuse(C.DENY_REASON.APPROVAL_MISMATCH, ['this-purchase-is-already-linked-to-another-approval'], {
        purchaseId: String(purchaseId), existingApprovalId: String(linked.approval_id)
      });
    }
    return approval;
  }

  /* ── validateAutonomousApprovalInTx（在 prepare 的写锁里调用）────
     它是 AUTO_ALLOW 模式的对应物：**重算**九元组身份并与调用方提交的那个
     比较。为什么这一条必须是"重算"而不是"相信"：

       授权指纹是自主闸门在放行那一刻算出的九元组身份。如果 prepare 只
       把它**存下来**，那么"拿着一条真实的指纹去准备一笔经济内容完全不同
       的购买"就会成功 —— 因为指纹本身不会被验证。重算之后，这条路的
       安全性与 APPROVAL 模式逐字相同：两种模式**都必须**证明自己说的就是
       这一笔，区别只在证据是一张批准行还是一个可重算的身份。

     ★ 它还要求那份策略**存在且属于买家**，以及……**它不是**在结算时再判
     一次策略（那是结算事务里的事，见 §11）。这里只回答"这个指纹描述的是
     这一笔吗，而它是从这位买家的策略算出来的吗"。 */
  function validateAutonomousApprovalInTx(policyId, fingerprintClaim, expected) {
    if (policyId == null) {
      throw refuse(C.DENY_REASON.AUTONOMY_NOT_PERMITTED,
        ['an-autonomous-purchase-must-name-the-autonomy-policy-that-allowed-it']);
    }
    const row = db.prepare(SQL.selectAutonomyPolicy).get(String(policyId));
    if (!row) {
      throw refuse(C.DENY_REASON.POLICY_NOT_FOUND, ['autonomy-policy-not-found'], { autonomyPolicyId: String(policyId) });
    }
    const policy = rowToAutonomyPolicy(row);
    if (policy.unusable === true) {
      throw refuse(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, ['the-autonomy-policy-row-is-not-trustworthy'],
        { autonomyPolicyId: String(policyId), problems: policy.unusableErrors });
    }
    /* 策略的主人必须就是买家 —— 否则"这笔为什么没问用户"会指向一条不
       属于买家的规则。 */
    if (String(policy.ownerId.id) !== String(expected.buyerPartyId)
      || String(policy.ownerId.type) !== String(expected.buyerPartyType)) {
      throw refuse(C.DENY_REASON.AUTONOMY_NOT_PERMITTED,
        ['the-autonomy-policy-does-not-belong-to-the-buyer'], {
        autonomyPolicyId: String(policyId),
        policyOwnerId: partyKeyOf(policy.ownerId.type, policy.ownerId.id),
        buyerId: partyKeyOf(expected.buyerPartyType, expected.buyerPartyId)
      });
    }
    const recomputed = C.approvalFingerprint(expected.binding);
    if (!recomputed.ok) {
      throw refuse(C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED, recomputed.errors);
    }
    if (String(recomputed.fingerprint) !== String(fingerprintClaim)) {
      throw refuse(C.DENY_REASON.APPROVAL_MISMATCH,
        ['the-autonomous-approval-fingerprint-does-not-describe-this-purchase'], {
        claimedFingerprint: String(fingerprintClaim),
        recomputedFingerprint: String(recomputed.fingerprint),
        oneAutonomyFingerprintCannotBeMovedToAnotherPurchase: true
      });
    }
    return policy;
  }

  /* ── consumeApprovalForPurchaseInTx（在 settle 的写锁里调用）──────────
     ★ §8/§15 的结构核心。三个条件逐条被检查，任何一条不成立即抛：
       ① 状态**恰好**是 APPROVED（不是 PENDING、不是已 CONSUMED）；
       ② 九个绑定字段与这笔购买一致（从 purchase 行与 quote 行读，
          **不**从请求参数读）；
       ③ 它没有被另一笔购买消费过。
     然后 setApprovalConsumed 的 `AND status='APPROVED'` 谓词给出第二道
     并发保护：两个进程同时结算两笔购买而它们指向同一条批准时，必然有
     一个 changes=0 ⇒ 整个事务回滚 ⇒ 那笔购买不会被扣款。 */
  function consumeApprovalForPurchaseInTx(approvalId, purchase, quote, at) {
    const expected = {
      buyerId: partyKeyOf(String(purchase.buyer_type), String(purchase.buyer_id)),
      recipientId: purchase.recipient_id == null ? null : partyKeyOf(String(purchase.recipient_type), String(purchase.recipient_id)),
      productId: String(purchase.product_id),
      quoteId: String(purchase.quote_id),
      currency: String(purchase.currency),
      amountMinor: fromSqlAmount(purchase.amount_minor, 'purchase-amount'),
      settlementType: String(purchase.settlement_type),
      grantQuantity: Number(purchase.granted_quantity),
      units: Number(purchase.units)
    };
    const approval = validateApprovalForPreparationInTx(String(approvalId), String(purchase.purchase_id), expected, at);
    const rev = allocateRevision();
    const moved = db.prepare(SQL.setApprovalConsumed).run(
      C.APPROVAL_STATE.CONSUMED,
      String(purchase.purchase_id),
      'consumed-by-a-completed-purchase',
      Number(rev), Number(at), Number(at),
      String(approvalId),
      C.APPROVAL_STATE.APPROVED
    );
    if (Number(moved.changes) !== 1) {
      /* 这条路径**不可达**（上面刚验证过 status=APPROVED），除非另一个
         进程在两次读之间消费了它 —— 而整个结算在一个 BEGIN IMMEDIATE
         里，因此那不可能发生。留这条守卫是为了让"不可能"变成"不成立即
         整体回滚"，而不是一次静默的第二次消费。 */
      throw refuse(C.DENY_REASON.APPROVAL_NOT_CONSUMED, ['the-approval-was-not-consumed-exactly-once'], {
        approvalId: String(approvalId), purchaseId: String(purchase.purchase_id)
      });
    }
    appendChange({
      revision: Number(rev), kind: C.EVENT_TYPE.APPROVAL_CONSUMED,
      entityId: String(approvalId), transactionId: null, walletId: null, at: Number(at),
      payload: {
        domain: C.DOMAIN,
        approvalId: String(approvalId),
        approvalStatus: C.APPROVAL_STATE.CONSUMED,
        fromStatus: C.APPROVAL_STATE.APPROVED,
        consumedByPurchaseId: String(purchase.purchase_id),
        quoteId: String(purchase.quote_id),
        buyerId: partyKeyOf(String(purchase.buyer_type), String(purchase.buyer_id)),
        currency: String(purchase.currency),
        amountMinor: C.serializeAmountMinor(fromSqlAmount(purchase.amount_minor, 'purchase-amount')),
        bindingFingerprint: String(approval.bindingFingerprint),
        oneApprovalAtMostOnePurchase: true,
        /* ★ 六句逐字的否认。消费一条批准只改**这一行批准**的状态：它不动
           ledger、不动库存、更不碰 provider / payment / memory /
           relationship。写全（而不是只写其中一句）是刻意的 —— 只写一半会
           让"这条事件有没有声称付过款"变成一个"字段存不存在"的问题，而
           read 侧要么写 `=== false`（对缺字段为 false ⇒ 断言无声失败），
           要么写 `!== true`（对任何缺失都为 true ⇒ 断言永不失败）。 */
        ledgerMutation: false,
        inventoryMutation: false,
        providerMutation: false,
        paymentMutation: false,
        memoryMutation: false,
        relationshipMutation: false
      }
    });
    return { approvalId: String(approvalId), revision: Number(rev), bindingFingerprint: approval.bindingFingerprint };
  }

  /* ══════════════════════════════════════════════════════════════════
     P22-6 · 结算完整性（§48 fail closed 的落点）

     与 P22-4/P22-5 的 *ProblemsOf 同款：每一行的**自述**必须与它引用的
     事实一致。任何一条不成立即"这次购买这一面不可信"，而不可信必须
     fail closed。
     ══════════════════════════════════════════════════════════════════ */
  function purchaseProblemsOf(row) {
    const problems = [];
    const id = String(row.purchase_id);
    const status = String(row.status);
    const push = (msg) => problems.push(id + ':' + msg);

    if (!C.isEconomyId(C.PURCHASE_ID_KIND, id)) push('not-a-canonical-purchase-id');
    if (!C.isPurchaseState(status)) { push('status-not-in-closed-set'); return problems; }
    if (!C.isFulfillment(row.settlement_type)) push('settlement-type-not-in-closed-set');
    if (!C.isQuoteKind(row.quote_kind)) push('quote-kind-not-in-closed-set');

    /* 身份分离：purchaseId 不得等于它引用的任何一件事的 id（§3）。 */
    if (String(row.quote_id) === id) push('purchase-id-equals-its-quote-id');
    if (String(row.reservation_id) === id) push('purchase-id-equals-its-reservation-id');
    if (row.ledger_transaction_id != null && String(row.ledger_transaction_id) === id) {
      push('purchase-id-equals-its-ledger-transaction-id');
    }

    /* 引用必须存在。 */
    if (!db.prepare(SQL.selectQuote).get(String(row.quote_id))) push('quote-row-missing');
    if (!db.prepare(SQL.selectReservation).get(String(row.reservation_id))) push('reservation-row-missing');
    if (!db.prepare(SQL.selectProduct).get(String(row.product_id))) push('product-row-missing');
    if (row.store_id != null && !db.prepare(SQL.selectStore).get(String(row.store_id))) push('store-row-missing');

    /* 一个收件人与买家**相同**的购买是一个读面上无法回答"给谁"的记录。 */
    if (row.recipient_id != null &&
      String(row.recipient_id) === String(row.buyer_id) &&
      String(row.recipient_type) === String(row.buyer_type)) {
      push('recipient-equals-the-buyer');
    }

    /* 经济内容：金额与交付量只能是**非负安全整数**，而金额以原子单位存。 */
    let amountMinor = null;
    try { amountMinor = fromSqlAmount(row.amount_minor, 'purchase-amount'); }
    catch (_) { push('amount-is-not-a-canonical-non-negative-safe-integer'); }
    const granted = Number(row.granted_quantity);
    if (!Number.isSafeInteger(granted) || granted < 0) push('granted-quantity-is-not-a-non-negative-safe-integer');
    if (String(row.settlement_type) === C.FULFILLMENT.SERVICE_EXECUTION && granted !== 0) {
      push('service-settlement-must-not-grant-inventory');
    }
    if (String(row.settlement_type) !== C.FULFILLMENT.SERVICE_EXECUTION && granted <= 0) {
      /* 非 service 的交付形态必然产生一个正数的交付量：一份"发了 0 个"
         的已完成购买与"没发"在读面上无法区分。 */
      push('a-non-service-settlement-must-grant-a-positive-quantity');
    }
    if (row.asset_kind != null && !C.isAssetKind(row.asset_kind)) push('asset-kind-not-in-closed-set');
    if (row.unit_name != null && !C.isUnitName(row.unit_name)) push('unit-name-not-canonical');
    if (row.asset_kind == null && String(row.settlement_type) !== C.FULFILLMENT.SERVICE_EXECUTION) {
      push('a-fulfillment-that-produces-inventory-must-name-an-asset-kind');
    }

    /* consent 快照必须可解析（它是"这次购买是什么"在它自己那一侧的记录）。 */
    if (row.consent_snapshot != null) {
      try { JSON.parse(String(row.consent_snapshot)); }
      catch (_) { push('consent-snapshot-is-not-valid-json'); }
    }

    /* 预留列的自述。 */
    if (String(row.reservation_state) !== C.RESERVATION_STATE.ACTIVE) {
      push('reservation-state-at-prepare-must-be-active');
    }

    const completed = status === C.PURCHASE_STATE.COMPLETED;
    if (completed) {
      if (row.ledger_transaction_id == null) { push('completed-without-a-ledger-transaction'); return problems; }
      const txId = String(row.ledger_transaction_id);
      const tx = db.prepare(SQL.selectTransaction).get(txId);
      if (!tx) { push('completed-ledger-transaction-missing'); return problems; }
      if (String(tx.state) !== C.TX_STATE.COMMITTED) push('completed-with-an-uncommitted-ledger-transaction');
      /* ★ 交易 id 必须**确定性地**派生自 purchaseId：这一条把"这笔购买
         的交易"从"某笔交易"变成一个可独立验证的事实。 */
      const derived = C.derivePurchaseLedgerTransactionId(id);
      if (!derived.ok || String(derived.id) !== txId) {
        push('completed-ledger-transaction-id-is-not-the-derived-one');
      }
      const expectedType = C.transactionTypeOfQuoteKind(row.quote_kind);
      if (expectedType.ok && String(tx.tx_type) !== String(expectedType.type)) {
        push('completed-with-a-ledger-transaction-of-the-wrong-type');
      }
      const byTx = db.prepare(SQL.selectPurchaseByLedgerTransaction).get(txId);
      if (!byTx || String(byTx.purchase_id) !== id) {
        push('completed-but-its-transaction-points-at-another-purchase');
      }
      const quoteRow = db.prepare(SQL.selectQuote).get(String(row.quote_id));
      if (!quoteRow || String(quoteRow.state) !== C.QUOTE_STATE.CONSUMED) push('completed-without-consuming-its-quote');
      const resRow = db.prepare(SQL.selectReservation).get(String(row.reservation_id));
      if (!resRow || String(resRow.status) !== C.RESERVATION_STATE.COMMITTED) {
        push('completed-without-committing-its-reservation');
      } else if (String(resRow.transaction_id == null ? '' : resRow.transaction_id) !== txId) {
        push('completed-but-the-reservation-points-at-another-transaction');
      }
      if (row.completed_at == null || !Number.isSafeInteger(Number(row.completed_at))) {
        push('completed-without-a-completed-at');
      } else if (Number(row.completed_at) !== Number(row.updated_at)) {
        /* completedAt 与成功的 commit 是**同一刻**：两者分开会制造
           "它什么时候完成的"两个答案。 */
        push('completed-at-does-not-match-the-update-that-completed-it');
      }
      if (row.reason_code != null) push('completed-with-a-reason-code');
      if (row.release_reason != null) push('completed-with-a-release-reason');
      problems.push.apply(problems, inventorySettlementProblemsOf({
        status: status,
        settlementType: String(row.settlement_type),
        settledQuantity: granted,
        settledAssetKind: row.asset_kind == null ? null : String(row.asset_kind),
        recipientId: row.recipient_id == null ? String(row.buyer_id) : String(row.recipient_id),
        productId: String(row.product_id),
        inventoryEntryId: row.inventory_entry_id == null ? null : String(row.inventory_entry_id)
      }));
    } else {
      /* 未完成的购买**不许**留下任何结算痕迹（§14"禁止任何半完成状态"）。 */
      if (row.ledger_transaction_id != null) push('not-completed-but-claims-a-ledger-transaction');
      if (row.completed_at != null) push('not-completed-but-has-a-completed-at');
      if (row.inventory_entry_id != null) push('not-completed-but-claims-an-inventory-entry');
      const quoteRow = db.prepare(SQL.selectQuote).get(String(row.quote_id));
      if (quoteRow && String(quoteRow.state) === C.QUOTE_STATE.CONSUMED) {
        push('not-completed-but-its-quote-was-consumed');
      }
      const resRow = db.prepare(SQL.selectReservation).get(String(row.reservation_id));
      if (resRow && String(resRow.status) === C.RESERVATION_STATE.COMMITTED) {
        push('not-completed-but-its-reservation-was-committed');
      }
      if (status === C.PURCHASE_STATE.RESERVED) {
        /* 一条 RESERVED 的购买必须有一笔**活跃**的预留，反之就是一条
           "锁已经没了却还说自己锁着"的记录。 */
        if (!resRow || String(resRow.status) !== C.RESERVATION_STATE.ACTIVE) push('reserved-without-an-active-reservation');
        if (row.release_reason != null) push('reserved-with-a-release-reason');
        if (row.reason_code != null) push('reserved-with-a-reason-code');
      }
      if (status === C.PURCHASE_STATE.RELEASED || status === C.PURCHASE_STATE.FAILED) {
        if (resRow && String(resRow.status) === C.RESERVATION_STATE.ACTIVE) {
          push('terminal-but-its-reservation-is-still-active');
        }
      }
    }

    /* ── P22-7：授权那一面的结构完整性 ──────────────────────────────────
       ★ NULL 是合法的（P22-7 之前的行、或没走闸门的 P22-6 直接用法），
       而**非 NULL 必须自洽**。四条判据：
         · 模式必须是封闭集合的成员（库里写了第三个词 ⇒ 不可信）；
         · APPROVAL ⇒ 必须有一个 approvalId；
         · AUTO_ALLOW ⇒ **不许**有 approvalId（"自主放行"与"有人批准"
           是互相排斥的两句话）；
         · 任何非 NULL 模式都必须有授权指纹。 */
    const mode = row.approval_mode == null ? null : String(row.approval_mode);
    if (mode != null) {
      if (!C.isPurchaseApprovalMode(mode)) { push('approval-mode-not-in-closed-set'); return problems; }
      if (row.approval_binding_fingerprint == null || String(row.approval_binding_fingerprint).trim() === '') {
        push('gated-purchase-has-no-approval-fingerprint');
      }
      /* 走了闸门的行必须落过 units —— 它是批准九元组的一员，缺了它
         "这张许可证说的就是这一笔吗"在结算时没有权威来源。 */
      if (row.units == null || !Number.isSafeInteger(Number(row.units)) || Number(row.units) < 1) {
        push('gated-purchase-has-no-canonical-units');
      }
      if (mode === C.PURCHASE_APPROVAL_MODE.APPROVAL) {
        if (row.approval_id == null) { push('approval-authorised-purchase-has-no-approval-id'); return problems; }
        if (!C.isEconomyId('APPROVAL', row.approval_id)) { push('approval-id-not-canonical'); return problems; }
        const approvalRow = db.prepare(SQL.selectApproval).get(String(row.approval_id));
        if (!approvalRow) { push('approval-authorised-purchase-names-a-missing-approval'); return problems; }
        /* ★ 第**五**条判据是 P22-7 的核心不变量，逐字落在 integrity 里：
           一笔已完成的购买所指的那条批准必须**恰好**被它消费 —— 于是
           "一条批准被两笔购买消费"或"批准已消费但没有购买"这两种撕裂
           事实在读侧就能被发现，而不用等到有人对账。 */
        if (String(approvalRow.consumed_by_purchase_id == null ? '' : approvalRow.consumed_by_purchase_id) !== String(row.purchase_id)) {
          if (status === C.PURCHASE_STATE.COMPLETED) {
            push('completed-approval-authorised-purchase-did-not-consume-its-approval');
          }
        }
        if (String(approvalRow.status) !== C.APPROVAL_STATE.CONSUMED && status === C.PURCHASE_STATE.COMPLETED) {
          push('completed-purchase-whose-approval-is-not-consumed');
        }
      }
      if (mode === C.PURCHASE_APPROVAL_MODE.AUTO_ALLOW) {
        if (row.approval_id != null) { push('an-autonomous-purchase-must-not-name-an-approval'); return problems; }
        if (row.autonomy_policy_id == null || String(row.autonomy_policy_id).trim() === '') {
          push('an-autonomous-purchase-must-name-the-autonomy-policy-that-allowed-it');
          return problems;
        }
        if (!C.isEconomyId('BUDGET_POLICY', row.autonomy_policy_id)) { push('autonomy-policy-id-not-canonical'); return problems; }
        const policyRow = db.prepare(SQL.selectAutonomyPolicy).get(String(row.autonomy_policy_id));
        if (!policyRow) { push('an-autonomous-purchase-names-a-missing-autonomy-policy'); return problems; }
        /* 策略的主人必须就是买家 —— 否则"这笔为什么没问用户"会指向一条
           不属于买家的规则。 */
        if (String(policyRow.owner_id) !== String(row.buyer_id)) {
          push('autonomy-policy-does-not-belong-to-the-buyer');
        }
      }
    } else {
      /* 没有模式的行**不许**带任何授权引用 —— 半填的授权面比空白的更糟：
         它会让"这条记录到底有没有授权层"无法回答。 */
      if (row.approval_id != null) push('ungated-purchase-names-an-approval');
      if (row.autonomy_policy_id != null) push('ungated-purchase-names-an-autonomy-policy');
      if (row.approval_binding_fingerprint != null) push('ungated-purchase-carries-an-approval-fingerprint');
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
      inventoryEntries: 0, inventoryTotalQuantity: 0,
      purchases: 0, reservedPurchases: 0, completedPurchases: 0,
      releasedPurchases: 0, failedPurchases: 0,
      autonomyPolicies: 0, enabledAutonomyPolicies: 0,
      approvals: 0, pendingApprovals: 0, approvedApprovals: 0,
      rejectedApprovals: 0, expiredApprovals: 0, consumedApprovals: 0,
      purchaseIntents: 0, intentsProposed: 0, intentsWaitingApproval: 0,
      intentsExecuting: 0, intentsCompleted: 0, intentsDenied: 0,
      intentsExpired: 0, intentsFailed: 0
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
          inventoryTotalQuantity: totalInventoryQuantity(),
          /* P22-6：四个按状态分的计数。它们是"现在有几笔购买处在哪个阶段"
             的唯一观测口，而 0 绝不等于"没有人买过"（那是 purchases 的事）。 */
          purchases: countPurchases(),
          reservedPurchases: countPurchasesByStatus(C.PURCHASE_STATE.RESERVED),
          completedPurchases: countPurchasesByStatus(C.PURCHASE_STATE.COMPLETED),
          releasedPurchases: countPurchasesByStatus(C.PURCHASE_STATE.RELEASED),
          failedPurchases: countPurchasesByStatus(C.PURCHASE_STATE.FAILED),
          /* P22-7：权限层的规模。五个按状态分的批准计数是"现在有几条
             批准处在哪个阶段"的唯一观测口，而 **pendingApprovals 是这一层
             唯一会需要人去做点什么**的数字 —— 因此它必须可读。
             0 绝不等于"这台 Agent 不需要批准"（那是 enabledAutonomyPolicies
             与策略本身的事）。 */
          autonomyPolicies: countAutonomyPolicies(),
          enabledAutonomyPolicies: countEnabledAutonomyPolicies(),
          approvals: countApprovals(),
          pendingApprovals: countApprovalsByStatus(C.APPROVAL_STATE.PENDING),
          approvedApprovals: countApprovalsByStatus(C.APPROVAL_STATE.APPROVED),
          rejectedApprovals: countApprovalsByStatus(C.APPROVAL_STATE.REJECTED),
          expiredApprovals: countApprovalsByStatus(C.APPROVAL_STATE.EXPIRED),
          consumedApprovals: countApprovalsByStatus(C.APPROVAL_STATE.CONSUMED),
          /* ── P22-8：一次打算的七态计数。它们与 purchases / approvals 同级
             出现在 health 上，因为"有多少条打算正在等用户点头"是这个经济
             此刻最重要的一个操作读数 —— 而它**不是**钱：七个数里没有一个
             回答"花了多少"。 */
          purchaseIntents: countPurchaseIntents(),
          intentsProposed: countPurchaseIntents(C.PURCHASE_INTENT_STATE.PROPOSED),
          intentsWaitingApproval: countPurchaseIntents(C.PURCHASE_INTENT_STATE.WAITING_APPROVAL),
          intentsExecuting: countPurchaseIntents(C.PURCHASE_INTENT_STATE.EXECUTING),
          intentsCompleted: countPurchaseIntents(C.PURCHASE_INTENT_STATE.COMPLETED),
          intentsDenied: countPurchaseIntents(C.PURCHASE_INTENT_STATE.DENIED),
          intentsExpired: countPurchaseIntents(C.PURCHASE_INTENT_STATE.EXPIRED),
          intentsFailed: countPurchaseIntents(C.PURCHASE_INTENT_STATE.FAILED)
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
         budgetEvaluationIsNotAnApproval：本层产出的 ALLOW 是一次
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
      /* ── P22-6：这几句是**目录与购买之间**那条界线的自述。上面那句
         `purchaseIsNotImplementedInThisPhase` 在 P22-5 是真的，而本阶段
         第一次让它变成假的 —— 因此它必须被**替换**而不是被保留：
         一个恒为 true 的字段在它变成 false 的那一天不会自己消失。 */
      purchaseImplemented: true,
      purchaseIsNotALedgerTransaction: true,
      purchaseIsNotAReservation: true,
      purchaseIsNotAQuote: true,
      purchaseCanonical: 'sqlite-purchases',
      purchaseSettlementIsOneTransaction: C.PURCHASE_SETTLEMENT_IS_ONE_TRANSACTION,
      purchaseAmountSource: C.PURCHASE_AMOUNT_SOURCE,
      purchaseRequiresABudgetAllow: C.PURCHASE_PREPARE_REQUIRES_BUDGET_ALLOW,
      purchaseRevalidatesBudgetAtSettlement: C.PURCHASE_SETTLE_REVALIDATES_BUDGET,
      purchaseRewritesHistoricalQuotes: C.PURCHASE_REWRITES_HISTORICAL_QUOTES,
      purchaseCancelIssuesARefund: C.PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND,
      purchaseCancelCancelsTheQuote: C.PURCHASE_CANCEL_CANCELS_THE_QUOTE,
      purchaseHasRefund: C.PURCHASE_HAS_REFUND,
      quoteConsumptionIsPartial: C.PURCHASE_QUOTE_CONSUMPTION_IS_PARTIAL,
      purchaseHasCartQuantity: C.PURCHASE_HAS_CART_QUANTITY,
      purchaseCreatesPendingApprovalRecords: C.PURCHASE_CREATES_PENDING_APPROVAL_RECORDS,
      purchaseExposesHttpMutation: C.PURCHASE_EXPOSES_HTTP_MUTATION,
      purchaseSettlementReadsMutableProductFields: C.PURCHASE_SETTLEMENT_MAY_READ_MUTABLE_PRODUCT_FIELDS,
      purchaseTouchesProvider: C.PURCHASE_TOUCHES_PROVIDER,
      purchaseTouchesPayment: C.PURCHASE_TOUCHES_PAYMENT,
      purchaseTouchesMemory: C.PURCHASE_TOUCHES_MEMORY,
      purchaseTouchesRelationship: C.PURCHASE_TOUCHES_RELATIONSHIP,
      storeIsAMerchant: false,
      walletDerivedCacheRebuiltAtSettlement: true,
      /* ── P22-7：权限层的 canonical 来源与十三句边界自述 ────────────────
         ★ 三句话是这一阶段最要紧的：
           · autonomyPolicyIsNotADecisionLayer —— 这一层判"有没有权"，
             不判"想不想买"。本进程没有任何一行读 LLM 输出（§17）；
           · approvalIsNotBudgetAuthority —— 一条批准**不是**预算豁免
             （§11）。它在结算事务里被消费，而最终预算复核在**同一个事务
             里**先执行；预算 DENY 时两者一起回滚；
           · autonomyAndBudgetAreSeparateGates —— §3 的整条边界。 */
      autonomyPolicyCanonical: 'sqlite-autonomy-policies',
      autonomyPolicyIsNotADecisionLayer: C.AUTONOMY_POLICY_IS_A_DECISION_LAYER,
      autonomyPolicyReadsLlmOutput: C.AUTONOMY_POLICY_READS_LLM_OUTPUT,
      autonomyPolicyReadsMemory: C.AUTONOMY_POLICY_READS_MEMORY,
      autonomyPolicyReadsRelationship: C.AUTONOMY_POLICY_READS_RELATIONSHIP,
      autonomyPolicyGrantsBudget: C.AUTONOMY_POLICY_GRANTS_BUDGET,
      autonomyReplacesBudget: C.AUTONOMY_REPLACES_BUDGET,
      autonomyDefaultWhenNoPolicy: C.AUTONOMY_DEFAULT_WHEN_NO_POLICY,
      autonomyPolicyInputKeys: C.AUTONOMY_POLICY_INPUT_KEYS.slice(),
      autonomyAndBudgetAreSeparateGates: true,
      approvalCanonical: 'sqlite-approvals',
      approvalStateVocabulary: 'APPROVAL_STATE (P22-7 §1)',
      approvalIsSingleUse: C.APPROVAL_IS_SINGLE_USE,
      approvalIsBoundToAQuoteSnapshot: C.APPROVAL_IS_BOUND_TO_A_QUOTE,
      approvalBindingKeys: C.APPROVAL_BINDING_KEYS.slice(),
      approvalIsNotAPurchase: true,
      approvalIsNotBudgetAuthority: C.APPROVAL_BYPASSES_BUDGET === false,
      approvalBypassesQuoteExpiry: C.APPROVAL_BYPASSES_QUOTE_EXPIRY,
      approvalConsumedInsideTheSettlementTransaction: true,
      approvalExpiryIsNotATimer: true,
      selfApprovalIsRejectedByStructure: true,
      autonomyTouchesProvider: false,
      autonomyTouchesPayment: false,
      autonomyTouchesMemory: false,
      autonomyTouchesRelationship: false
    };
  }

  function isDegraded() { return !!engineReason; }

  function countWallets() { return Number((db.prepare(SQL.countWallets).get() || {}).c || 0); }
  /* P22-7 的两个计数口。enabledAutonomyPolicies 不是"有几条策略"，
     而是"有几台 Agent 真的被允许自主购买" —— 这一点决定了 §4 的
     fail-closed 默认在实际系统里被触发多少次。 */
  function countAutonomyPolicies() { return Number((db.prepare(SQL.countAutonomyPolicies).get() || {}).c || 0); }
  function countEnabledAutonomyPolicies() {
    const row = db.prepare(SQL.selectAutonomyPoliciesAll).all().filter(r => Number(r.enabled) === 1);
    return row.length;
  }
  function countApprovals() { return Number((db.prepare(SQL.countApprovals).get() || {}).c || 0); }
  function countApprovalsByStatus(status) { return Number((db.prepare(SQL.countApprovalsByStatus).get(String(status)) || {}).c || 0); }  function countTransactions() { return Number((db.prepare(SQL.countTransactions).get() || {}).c || 0); }
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
      STORES: STORES_TABLE, PRODUCTS: PRODUCTS_TABLE, INVENTORY: INVENTORY_TABLE,
      PURCHASES: PURCHASES_TABLE
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
    /* P22-19：owner-scoped 的 change 读面。它是 Economy 里**唯一**一处
       "一条 change 属于谁"的实现；HTTP 侧只把 ownerId 透传过来。 */
    listChangesForOwner: listChangesForOwner,
    ledgerTopology: ledgerTopology,

    /* 唯一写入口 */
    commitLedgerTransaction: commitLedgerTransaction,
    mintForSystem: mintForSystem,
    burnForSystem: burnForSystem,
    transferBetweenWallets: transferBetweenWallets,

    /* ── P22-14：初始 IB Credit（**一次性**）────────────────────────────
       ★ 它为什么**不是** mintForSystem 的别名，因此必须与它并存：
         mintForSystem 是通用系统原语（无限次、任意金额、任意 wallet），
         而"初始额度"必须恰好一次。把前者接到配置面上就是 §3 逐字禁止的
         `POST /mint { ownerId, amount }`。
       ★ 它与 P22-3 的六个 mutation 同级：只对同进程调用方开放，不在任何
         HTTP 路由上（boundary B11/B12 会逐字断言这一点）。
       ★ `getInitialCreditBootstrap` 是**只读**的一半：它让"这个 owner 的初始
         额度发过了没有"成为一个可核对的答案，而不是靠"再试一次"去问。 */
    bootstrapInitialCredit: bootstrapInitialCredit,
    getInitialCreditBootstrap: getInitialCreditBootstrap,

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
    /* ── P22-26 · 消耗的**唯一** runtime seam ──────────────────────────
       上面两个是 primitive（P22-5 冻结的公开面，语义一个字没改）；而
       `consumeOwnedItem(input, context)` 是本阶段新增的那一条缝：它把
       owner 的来源钉在**权威上下文**上，并只对 `CONSUMABLE` 生效。
       生产代码里**没有**任何调用方 —— HTTP 上没有路由、capability 句柄里
       没有这个方法、适配器把它列为不提供（P22-10 的 NOT_OFFERED）。它存在
       的意义是：当那条缝被接上时，接上的**是**这一个，而不是 P22-5 的
       primitive —— 于是"谁的东西可以被用掉"这个问题永远只有一个答案。 */
    consumeOwnedItem: consumeOwnedItem,
    getInventoryEntry: getInventoryEntry,
    listInventory: listInventory,
    inventoryQuantity: inventoryQuantity,
    serializeInventoryEntry: serializeInventoryEntry,
    productProvenanceOf: productProvenanceOf,

    /* ── P22-6：Purchase 编排 + 原子结算 ────────────────────────────────
       写的一半（preparePurchase / settlePurchase / cancelPurchase）与
       P22-3/P22-4/P22-5 的所有 mutation 同级：只对同进程调用方开放，
       **不在任何 HTTP 路由上**（boundary B16 逐名断言，§60）。
       读的一半（getPurchase / listPurchases / serializePurchase）可以被
       HTTP 只读面使用。

       ★ 刻意**没有** refundPurchase / reversePurchase / chargeback（§59）：
       一次 COMPLETED 的购买是不可变的历史，退款将来必须是一条新的
       补偿性经济操作，而不是对旧事实的改写。 */
    preparePurchase: preparePurchase,
    settlePurchase: settlePurchase,
    cancelPurchase: cancelPurchase,
    getPurchase: getPurchase,
    listPurchases: listPurchases,
    serializePurchase: serializePurchase,
    purchaseSettlementOf: purchaseSettlementOf,

    /* ── P22-7 §23-§26：自主策略 + 批准记录 + 授权闸门 ──────────────────
       写的一半（putAutonomyPolicy / createApprovalRequest / decideApproval /
       expireApproval / expireDueApprovals / authorizePurchaseIntent）与 P22-3
       的六个 mutation 同级：只对同进程调用方开放，不在任何 HTTP 路由上
       （boundary B16 与 B17 会逐字断言这一层的方法名不出现在 http.js 里）。
       读的一半（get/list/serialize/evaluateAutonomousPurchaseFor）可以被
       HTTP 只读面使用 —— 与 P22-4 的 evaluateBudgetFor 完全同款。 */
    putAutonomyPolicy: putAutonomyPolicy,
    getAutonomyPolicy: getAutonomyPolicy,
    listAutonomyPolicies: listAutonomyPolicies,
    serializeAutonomyPolicy: serializeAutonomyPolicy,
    evaluateAutonomousPurchaseFor: evaluateAutonomousPurchaseFor,
    authorizePurchaseIntent: authorizePurchaseIntent,
    createApprovalRequest: createApprovalRequest,
    decideApproval: decideApproval,
    expireApproval: expireApproval,
    expireDueApprovals: expireDueApprovals,
    getApproval: getApproval,
    listApprovals: listApprovals,
    serializeApproval: serializeApproval,
    autonomousSpentTodayMinor: autonomousSpentTodayMinor,

    /* ── P22-8 §14 · Agent Purchase Intent + Decision Bridge ─────────────
       ★ 公开面上只有**三个**动词，而它们各自的名字里就写着边界：
         · proposeAgentPurchaseIntent —— "提出一条打算"（唯一的写入口，
           接受的是六字段的提议白名单，不是一次经济请求）；
         · resumeAgentPurchaseIntent  —— "在用户决定之后继续**同一条**打算"
           （不接受 agentId / productId / recipientId / units / 报价 ——
           它要的东西全部来自 canonical 行）；
         · 读面三个。
       ★ 刻意**没有**的公开成员（§14 的禁令在这里是"不存在"而不是"不推荐"）：
         executeEconomyAction / runAction / settleForAgent / buyNow /
         approveForAgent / grantForAgent。模型能到达的最远的地方是
         proposeAgentPurchaseIntent，而它之后的每一步都由本文件里的确定性
         代码决定。
       ★ 与 P22-7 的八个 mutation 同级：只对同进程调用方开放。http.js 里
         没有它们的名字（boundary 测试逐字断言这一点），而 HTTP 上新增的
         只有两条**只读**路由。 */
    proposeAgentPurchaseIntent: proposeAgentPurchaseIntent,
    resumeAgentPurchaseIntent: resumeAgentPurchaseIntent,
    getPurchaseIntent: getPurchaseIntent,
    listPurchaseIntents: listPurchaseIntents,
    serializePurchaseIntent: serializePurchaseIntent,
    countPurchaseIntentStates: intentStateCounts,

    /* ── P22-9 §7 · 准入审计（**加法**，不是门）─────────────────────────
       ★ 它为什么不是"门的一部分"：它不做任何准入判定，也不读任何经济
       事实来决定什么。它只是把一次**已经发生**的准入决定如实记下来。
       门（economy-capability.js）是它唯一的调用方，而它与 P22-3 起那些
       mutation 同级：只对同进程调用方开放，**不在任何 HTTP 路由上**。

       ★ 它与 P22-8 写入口的关系：零。proposeAgentPurchaseIntent 与
       resumeAgentPurchaseIntent **一行都没有改** —— 本阶段的纪律是
       P22-6 ~ P22-8 的 canonical ownership 保持不变，而"门在上面一层"
       正是那条纪律的推论。 */
    appendCapabilityAudit: appendCapabilityAudit,

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
    /* ★ P22-8：两个**结构性**断言用的只读口。它们存在的理由与众多个
       *ProblemsOf 同源：有一条纪律（"这张表里没有地方可以读价格"）只能
       在**列这一层**被证伪，而"我们没有写那一列"这句话如果只能靠读源码
       来相信，它就不是一条被执行的规则。两者都只读、都不在 HTTP 面上。 */
    /* ★ P22-13：一次**只读**的幂等记录查询。它的理由与下面几个
       *ForTest 逐字同源：有一条纪律（"一次成功的决定，它的重放必须返回
       当初那个结果"）只能在**那张表**这一层被证伪，而"我们写了那条记录"
       这句话如果只能靠读源码来相信，它就不是一条被执行的规则。
       只读、只回形状，不回任何经济事实，也不在 HTTP 面上。 */
    operationIdempotencyRowForTest: function (scope, key) {
      if (!isOpen()) return null;
      const row = db.prepare(SQL.selectOperationIdempotency).get(String(scope), String(key));
      if (!row) return null;
      return {
        scope: String(row.scope),
        idempotencyKey: String(row.idempotency_key),
        fingerprint: String(row.fingerprint),
        revision: Number(row.revision),
        at: Number(row.at)
      };
    },
    tableColumnsForTest: function (tableName) {
      if (!isOpen()) return null;
      const name = String(tableName);
      /* 表名来自测试常量，但仍然受一次白名单检查：一个能任意拼表名的
         读口等于把整个库的 schema 变成一个 HTTP 可达面。 */
      const known = [PURCHASE_INTENTS_TABLE, PURCHASES_TABLE, APPROVALS_TABLE,
        QUOTES_TABLE, RESERVATIONS_TABLE, AUTONOMY_POLICIES_TABLE];
      if (known.indexOf(name) < 0) return null;
      return db.prepare('PRAGMA table_info(' + name + ')').all().map(r => String(r.name));
    },
    schemaVersionForTest: function () { return ECONOMY_SCHEMA_VERSION; },
    dataDirForTest: function () { return dataDir; },

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
      purchaseProblemsOf: purchaseProblemsOf,
      /* ── P22-7：权限层的三个检查面 ──────────────────────────────────────
         与上面七个 *ProblemsOf 同级：测试用它们证明"每一行自述都成立"
         可以被单独证伪，而不必构造一整棵引用链。 */
      autonomyPolicyProblemsOf: autonomyPolicyProblemsOf,
      approvalProblemsOf: approvalProblemsOf,
      approvalBindingMismatch: approvalBindingMismatch,
      rowToApproval: rowToApproval,
      rowToAutonomyPolicy: rowToAutonomyPolicy,
      purchaseFingerprint: purchaseFingerprint,
      budgetDecisionOf: budgetDecisionOf,
      buildPurchaseEntries: buildPurchaseEntries,
      /* 事务深度**只读**观测口：测试用它证明"结算发生在恰好一条事务里"
         不是一句注释。它没有任何生产分支依赖它。 */
      transactionDepth: transactionDepth,
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
  STORES: STORES_TABLE, PRODUCTS: PRODUCTS_TABLE, INVENTORY: INVENTORY_TABLE,
  PURCHASES: PURCHASES_TABLE
});
module.exports.releaseReason = RELEASE_REASON;
module.exports.maxInventoryQuantity = MAX_INVENTORY_QUANTITY;
module.exports.fnv1a64Hex = fnv1a64Hex;
module.exports.stableStringify = stableStringify;











