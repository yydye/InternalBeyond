# P22-3 · Economy Reservation 与 Operation 生命周期

> 本阶段回答的问题：**一笔钱在被花掉之前"先被锁住"这件事，能不能被原子地、
> 可恢复地、幂等地、且不能超订地做完？**

P22-2 让 Economy 能回答"这个钱包有多少钱"（canonical = ledger entries）。
P22-3 要它回答第二个问题：**"这些钱现在能不能花？"** —— 答案不再只是余额，
而是

```text
ledgerBalance − Σ(active reservations) = availableBalance
```

本阶段**没有**做的事（留给后续阶段，一个字都没碰）：

```text
quote / purchase intent / approval / budget policy   （P22-4）
product / inventory / store                          （P22-5）
exchange                                             （P22-6）
compute 计价                                          （P22-7）
Decision / Action adapter                            （P22-8）
provider 适配                                         （P22-9）
UI / 浏览器镜像                                        （P22-11）
真实支付 / 充值 / provider 余额写路径                  （永久不做）
```

---

## 1. 两个实体，而不是一张会变状态的 ledger transaction

P22-2 的 ledger transaction 是**已经发生的经济事实**，append-only。
一次"可能成功、可能失败、可能过期"的操作**不是**一个已发生的事实 ——
把它的生命周期塞进 ledger transaction，就等于让一笔已提交的事实状态不断
变化，而那是 P22-3 §1 明确禁止的。

于是新增两个实体：

| 实体 | id 前缀 | 状态词表 | canonical 含义 |
|---|---|---|---|
| `economy_operations` | `econ_op_` | P22-1 §8 `TX_STATES`（CREATED → RESERVED → {COMMITTED, RELEASED, EXPIRED, FAILED}） | 一次**操作**的生命周期 |
| `economy_reservations` | `econ_res_` | P22-1 §12 `RESERVATION_STATE`（ACTIVE / COMMITTED / RELEASED / EXPIRED） | 一次**资金锁定** |

```text
Operation (econ_op_…)
    │
    ├── Reservation (econ_res_…)          ← 锁住钱，钱还在原钱包
    │
    └── on commit
          ↓
      Ledger Transaction (econ_tx_…)      ← append-only 经济事实
```

**为什么不合并成一张表。** 两张冻结词表的**终态集合不同**：reservation 没有
`FAILED`（一笔预留的资源后果只有"被用掉"或"被还回去"两种），operation 没有
`ACTIVE`。合并就必须给其中一个加成员或加别名 —— 那是破坏冻结契约，不是
实现它。两者由契约里的 `RESERVATION_STATE_OF_OPERATION` /
`OPERATION_STATE_OF_RESERVATION` 连接，而那份映射是**数据**（可枚举、
可断言、可穷举），不是散落在运行时的 `if`。

那份映射刻意**不是**双射，而且这一点写在数据里：

```js
RESERVATION_STATE_OF_OPERATION = {
  CREATED: null, RESERVED: 'ACTIVE', COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED', EXPIRED: 'EXPIRED', FAILED: null
}
```

`FAILED` 的 operation 其资源后果是"钱还回去了" ⇒ reservation 记
`RELEASED` + `releaseReason: 'OPERATION_FAILED'`。`null` 是**做不到**这件事的
诚实表示，而不是一个忘了填的洞。

**`operationId` 是第 13 种 id 种类**（`econ_op_`）：`econ_tx_` 已经被
"已发生的经济事实"占用，`econ_res_` 的词表里没有 `FAILED`。这是一次
**加法**的契约扩展，`P22-1 domain contract` 测试里跟着改的只有一处
"十三种 id 种类"的计数（断言语义一个字没变）。

---

## 2. `reservedBalance` 的 canonical truth

**canonical = active reservation 行。`wallets.reserved_balance_minor` 是派生缓存。**

```text
economy_reservations (status = 'ACTIVE')
        ↓  Σ(amount_minor)
   reservedBalance            ← 唯一算术入口：SQL.sumActiveReserved
        ↓
wallet.reserved_balance_minor ← 派生缓存（可重建、带漂移标记）
```

与 P22-2 的 ledger/cache 原则逐字同款，并有三条结构性保证：

1. **唯一一条写 reserved 的 SQL 是整体赋值**
   （`SET reserved_balance_minor=?, revision=?, updated_at=?`）。文件里
   不存在 `reserved += …`、`reserved_balance_minor = reserved_balance_minor + ?`
   这种形态 —— 不是"记得别那么写"，而是那种 SQL 根本没被写出来。
   （开发期真的抓到过一处：`walletAvailability` 曾在 JS 里重新累加了一遍。
   修法是让那段代码消失，而不是给规则开一个"本地累加不算"的例外。）
2. **求和只有一处定义**（那条 SQL）。同一个量有两个实现就必然有两个答案。
3. **`rebuildReservedBalance(walletId)`** 从 active reservation 行重建，
   输入只有 `walletId`，**从不读缓存参与计算**。漂移会被修好、写回，
   并留下一条 `RESERVATION_REBUILT` change log —— 漂移不许静默消失。

---

## 3. `availableBalance` 只在 READY 下存在，其余一律 `null`

```text
availableBalanceMinor = ledgerBalanceMinor − activeReservedBalanceMinor   （仅 READY）
```

两个输入都是 **canonical**（ledger 求和、reservation 求和），不是缓存。

P22-2 的读路径用的是 `cachedBalance − cachedReserved`。P22-3 把 available 的
两个输入都收到 canonical，理由是：一旦 reserved 这一层存在，"用缓存算
available"就等于允许一个被改坏的缓存**直接决定能不能花钱**。

于是读路径的语义变成：

| 字段 | 含义 |
|---|---|
| `ledgerBalanceMinor` | canonical（从 entries 求和） |
| `reservedBalanceMinor` | canonical（从 ACTIVE reservations 求和） |
| `availableBalanceMinor` | `ledger − reserved`（派生，唯一的用户可见结论） |
| `cachedBalanceMinor` | 派生缓存里那个数（**照实**报告） |
| `reservedBalanceCachedMinor` | 派生缓存里那个 reserved |
| `cachedBalanceDrifted` / `reservedCacheDrifted` | 缓存是否已经与事实不符 |

**先破坏，再证明**（`test_p22_2_economy_store.js` G 组、`test_p22_3…` J 组）：
把 `cached_balance_minor` 改成 `999999` / `0` / `1`，把
`reserved_balance_minor` 改成 `999999` / `0` / `1` / `49`，每次都不变的是
**available** —— 漂移只以标记的形式可见，修好之后标记消失。

读路径**同时**做完整性检查（账户引用链、每一条 reservation 行、每一条
operation）。任何一不成立就是 `DEGRADED`，`availableBalanceMinor` 是 `null`
而不是 0。一个"看起来很权威"的数字从一条断掉的引用链上算出来，比一句
"我不知道"危险得多。

---

## 4. 五个 mutation，各自恰好一个 SQLite 事务

### `reserveFunds`（§5/§8/§9）

```text
BEGIN IMMEDIATE
  validate（currency / amount>0 / expiresAt / wallet / READY）
  recompute ledger balance        ← canonical
  recompute active reservations   ← canonical
  check available >= amount
  insert operation (CREATED)
  CREATED → RESERVED              ← 经状态机，不是直接写终值
  insert reservation (ACTIVE)
  reserved 缓存 ← Σ(ACTIVE)        ← **求和**，不是 +=
  append change log
  write idempotency
COMMIT
```

**`CREATED` 是一次真的写入。** 状态机的第一条边必须被**真正执行**，否则
"CREATED 不能直接跳到 COMMITTED"这条规则从来没有在运行路径上被用过。
做法是先按 CREATED 插入、再用带 `AND status=?` 守卫的语句推进到 RESERVED；
两步在同一个事务里，因此**外部永远观察不到 CREATED**（故障注入点
`after-operation-created` 证明这个中间态一旦落单就整体回滚）。

**拒绝不留痕（§17）。** 余额不足是"这个请求没被接受"，不是"一次操作失败了"。
拒绝路径整体回滚，什么都不留 —— 不制造 persisted `FAILED`，不消耗
`operationId`，不消耗 revision。

### `commitReservation`（§10/§11）

```text
BEGIN IMMEDIATE
  re-read reservation（必须 ACTIVE）与 operation（必须 RESERVED）
  ★ reservation → COMMITTED          （先离开 ACTIVE）
  ★ reserved 缓存 ← Σ(ACTIVE)         （此时已不含本笔）
  ★ ledger transaction + entries      （**同一个**事务）
  ★ operation → COMMITTED（记下 transactionId）
  ★ change log + 幂等行
COMMIT
```

**为什么"预留先离开 ACTIVE"必须排在 ledger 之前。** P22-2 的
`applyDerivedBalances` 有一条真实守卫：若 `reserved > 结果 ledger balance`
就抛 `RESERVED_EXCEEDS_LEDGER_BALANCE`。余额 100、预留 70 时，先扣款会让
ledger 变成 30 而 reserved 仍是 70 ⇒ 守卫触发、整个 commit 回滚。先释放预留
再扣款则两数同步下降，守卫在任何中间时刻都成立。这不是绕过守卫：守卫仍然在，
只是被正确地喂了当前值。

**"恰好一笔 ledger transaction"是结构性的**，不靠纪律：

* `transactionId` 从 `reservationId` **确定性派生**（`econ_tx_<resSuffix>_c`），
  所以第二次 commit 撞的是同一个 id ⇒ `TRANSACTION_ID_ALREADY_COMMITTED`；
* `economy_reservations.transaction_id` 上有一条 **UNIQUE** 索引；
* 反方向（一笔预留两笔交易）由"`transaction_id` 是单个列"本身保证。

**金额与钱包只来自预留行。** 请求里给一个不同的 `amountMinor` ⇒ 拒绝；
给 `entries` ⇒ 拒绝（ledger 的写形态由 Economy 决定）；`counterparty` 只允许
`system:treasury` / `system:market`（`system:mint` / `system:burn` 被挡在门外，
否则"提交一笔预留"就能被写成一次披着 PURCHASE 外衣的增发）。

### `releaseReservation` / `expireReservation` / `failReservation`（§12/§13/§4/§17）

三者共用一个内核：reservation `ACTIVE → 终态`、operation `RESERVED → 终态`、
`reserved 缓存 ← Σ(ACTIVE)`、一条 change log、一条幂等记录。
**它们都不写 ledger** —— reserve 从来没有让钱离开钱包，因此"释放"不可能、
也不允许产生任何退款交易。这一点在测试里是逐字断言的：transaction 计数、
entry 计数、cached balance 全部不变，change log 的 payload 里写着
`ledgerMutation: false`。

三者刻意分开，因为"为什么这笔没成交"必须可回答：

| 操作 | reservation 状态 | operation 状态 | releaseReason |
|---|---|---|---|
| `releaseReservation` | `RELEASED` | `RELEASED` | `USER` / `SYSTEM` |
| `expireReservation` | `EXPIRED` | `EXPIRED` | `EXPIRED` |
| `failReservation` | `RELEASED` | **`FAILED`** | `OPERATION_FAILED` |

`releaseReservation` **只**接受 `USER` / `SYSTEM`：`EXPIRED` 只能由 expire
路径产生，`OPERATION_FAILED` 只能由 fail 路径产生。否则"为什么这笔没成交"
就又能被伪装。`failReservation` 的 `reasonCode` 必须来自契约的封闭
`DENY_REASON` 集合 —— 自由文本的失败原因会让审计里出现无法聚合的字符串。

`FAILED` 只被**显式**触发：一次普通的余额不足拒绝不会留下 FAILED 记录。

### `expireDueReservations(now)`（§15）

确定性 + 显式 `now` + 分批 + 幂等 + 不碰终态 + 每笔一条 change log。
**没有后台定时器**：真相是 `expires_at <= now` 这条比较，于是进程关机两小时
后重启，那笔预留依然是"到期的"，扫一次就落定。每笔一个自己的事务 ——
一笔坏数据不该让九十九笔好数据留着不动。

到期扫描的幂等键由 `reservationId` **确定性派生**，因此同一次到期无论扫多少
次都不可能产生第二条 expiration。

---

## 5. 开库时的预留对账（§16）

`open()` 的最后一步跑 `reconcileReservations()`。对象刻意只是"有预留行或
reserved 缓存非零"的钱包（有意预留的钱包数量是 O(活跃经济活动规模)，
不是 O(钱包总数)）。

| 结局 | 行为 |
|---|---|
| 缓存一致 | **什么都不写**（尤其**不消耗 revision** —— 否则"重启一次"会变成一次虚假的经济事件） |
| 缓存漂移 | 从 canonical 重建 + 一条 `RESERVATION_REBUILT`（`source: 'open-time-reconciliation'`） |
| 结构损坏 | `DEGRADED`（fail closed），**不**尝试修复 |

对账失败不阻断 `open()`：库是开着的、账本是好的，只是"预留这一面不可信"。
把它说成"打不开"会让整个 Economy 消失，那是更大的谎。

**"被截肢的库"也测了**（M6）：手工删掉 reserved 行、缓存却还写着 50 时，
对账站在 **canonical 一边**，把 50 拉回 0 并留下审计 —— 而不是继续声称有 50
被锁着，也不是静默清零。

---

## 6. 幂等：scope + 指纹（§18/§19）

一个模糊的 key 空间会让 `reserve` 与 `commit` 共用同一个 key 时被判成
"同一个业务请求"（于是 commit 会被当成 reserve 的重放）。因此持久化身份是
**(scope, idempotencyKey)**，五个 scope：`RESERVE` / `COMMIT` / `RELEASE` /
`EXPIRE` / `FAIL`。

指纹只覆盖"这次业务是什么"，**刻意不含任何生成的 id**
（`operationId` / `reservationId` / `transactionId` 都是执行时才知道的）：

| scope | 指纹覆盖 |
|---|---|
| `RESERVE` | `walletId` + `currency` + `amountMinor` + `expiresAt` |
| `COMMIT` | `reservationId` + ledger 请求的结构身份（type / 参与方 / entry 的**结构**集合，排序后） |
| `RELEASE` | `reservationId` + `releaseReason` |
| `EXPIRE` | `reservationId`（**刻意不含 now**：换一个 now 再扫同一次到期是同一个业务决定） |
| `FAIL` | `reservationId` + `reasonCode` |

**幂等闸门排在终态检查之前。** 否则会出现一个自相矛盾的答案：同一个 commit
请求重放时，第一次成功了（预留因此变成 COMMITTED），第二次却被
"reservation-is-not-active" 拒绝。§11 要的恰恰是相反的：同一个请求 → 返回
当初那个结果。指纹只依赖请求本身，与当前状态无关，因此它可以、也应该在
状态之前被算出来。（开发期实测抓到过这个 bug：`repeated commit` 返回了
`TRANSITION_NOT_ALLOWED` 而不是 `replayed: true`。）

`expiresAt` 是**必填的绝对毫秒时间戳**，刻意不提供 `ttlMs` 便利：一个相对
时长会让"这次请求是什么"依赖于读时钟的那一刻，于是同一请求的两次重放会算出
两个不同的 `expiresAt`，指纹随之不同，幂等性在最需要它的重试路径上失效。

---

## 7. 崩溃注入（§23）：18 个故障点

每一个注入点都用一个**全新**的库，注入后逐项对真实 SQLite 断言。

**reserve 的 7 个点**：`after-reserve-validated` · `after-operation-created` ·
`after-operation-reserved` · `after-reservation-insert` · `before-reserve-change-log` ·
`before-reserve-idempotency` · `before-reserve-commit`

* 0 条残留 operation（CREATED 这个中间态绝不留在库里）
* 0 笔残留 reservation，锁定量没有幻影变化
* revision 不断裂、无空洞
* 幂等表没有残留（重试可以真的落地）
* 账本仍逐币种平衡

**commit 的 7 个点**：`after-commit-validated` · `after-reservation-committed` ·
`after-commit-reserved-cache` · `after-commit-ledger` · `after-commit-operation-status` ·
`before-commit-change-log` · `before-reservation-commit`

* **不存在 "Ledger 已扣款而 reservation 仍 RESERVED"** ——
  断言形式是 `!(ledger 变了 && reservation 还是 ACTIVE)` 与
  `!(ledger 没变 && reservation 已经 COMMITTED)`
* 没有第二笔 ledger transaction、没有半笔 entry
* 回滚之后那笔预留仍然 ACTIVE 且仍锁着 70（钱没丢，也没被重复锁）
* 直接查库：没有孤儿 operation、没有指向不存在交易的 reservation

**release / expire / fail 各 4 个点**：`…-validated` · `…-after-status` ·
`…-after-reserved-cache` · `…-before-change-log`

* 状态与锁定量**同生共死**
* 没有 ledger 变化
* revision 不断裂，且重试能真的落地

---

## 8. 重启恢复（§24）

```text
open → mint 100 → reserve 70 → close → open
```

必须是 `ledger=100 / reserved=70 / available=30 / reservation ACTIVE`，
而且**对账什么都没写**（revision 不动）。重启之后 commit 仍然只能花一次；
重放同一个 commit key 仍然 `replayed: true`。

进程离线期间到期：

```text
reserve(expiresAt = T) → close → 时钟推进 2 小时 → open
```

重新开库后那笔预留在**数据上仍然是 ACTIVE**（到期是一个比较，不是后台定时器
做的），`expiredByTime` / `sweepableNow` 为 `true`；扫一次 → `EXPIRED`、
锁定量归零、available 回到满额、**没有**任何 ledger 事实。

---

## 9. 并发（§20）

**必须诚实地说明一半。** `node:sqlite` 的 `DatabaseSync` 是**同步** API，
因此同一线程内两个 `reserve` 不可能真正交错 —— `Promise.all` 只是"同一 tick
连续到达"。这一点写在测试的名字里，否则那条断言会被误读成"并发安全已被证明"。

因此真正的证明在另外两处：

1. **两个独立连接**（两个 store 实例打同一个库）：连接 A 预留 60 之后，
   连接 B 必须看得见（独立连接不是独立事实源）⇒ 50 被拒、40 放行、再要 1 被拒。
2. **四个真实子进程**（`tests/fixtures/p22-3-reserve-worker.js`）：在同一墙钟
   起跑线上同时 `reserve(40)` 打 100 余额 ⇒ **恰好 2 个成功、2 个以
   `INSUFFICIENT_AVAILABLE_BALANCE` 被拒**，`Σactive = 80 ≤ ledger = 100`。

结构性原因不是运气：写事务用 `BEGIN IMMEDIATE`，**写锁在"读可用余额"之前**
就拿到了，因此"检查 available"与"插入 reservation"发生在同一个锁里。

### 这一组当场抓到一个真实缺陷

修复前，4 个真实进程同时 reserve 时 **3 个直接崩溃**：

```text
Error: UNIQUE constraint failed: economy_operations.operation_id
```

根因在**缺省 id 生成器**（P22-2 留下的）：`clock().toString(36) + '_' + idSeq`，
而 `idSeq` 是**每进程**从 1 开始的计数器。两个进程在同一毫秒各自做第一次
生成时会得到**逐字相同**的 id，第二个插入就撞 PRIMARY KEY。P22-2 的注释当时
把这归为"失败方向是安全的"，但那句话只在一个进程独占地写库时成立。

修法刻意最小：把进程身份放进 id（`…_<pid36>_<seq>`）。PID 在同一台机器上对
**存活**进程唯一，而"共享同一个 SQLite 文件"正是它唯一的适用范围 —— 于是它
恰好覆盖了唯一会出问题的那种并发。仍然不需要随机源，仍然不需要时钟单调。
（跨机器共享文件不在范围内：SQLite 本来就不支持网络文件系统。）

---

## 10. schema 1 → 2

```text
ECONOMY_SCHEMA_VERSION = 2
```

为什么这是一次**真的**版本变更：`economy_meta['economy_schema']` 回答的是
"这个库属于哪一代 schema"，而 P22-3 让这个库多出了三张表。抬水位带来两个
方向都正确的行为：

* 一个 P22-2 的 build 打开 P22-3 的库 ⇒ **拒绝**（`SCHEMA_TOO_NEW` /
  `db-schema-too-new`），而不是"读得到余额但完全不知道有预留"；
* 一个 P22-3 的 build 打开 P22-2 的库 ⇒ 走受支持的老版本路径，DDL 补上新表、
  水位抬到 2，**既有 ledger 行一个字节都不动**（测试逐条比对行数、revision、
  余额、拓扑、change log）。

`1 → 2` 的 `MIGRATIONS` 条目为空，因为没有任何既有列或既有数据需要改写 ——
空数组是刻意的，它让"这一步没有数据迁移"这件事本身可被断言。

**一处顺带的顺序修正**：水位检查被提到**任何其它 DDL 之前**（之前是
"建完所有表再查水位"）。因此 `SCHEMA_TOO_NEW` 的库上连
`economy_reservations` 都不会被创建 —— P22-2 那句"拒绝是只读的"现在在字面上
也成立（M9 断言这一点）。

---

## 11. HTTP 面：这一阶段**仍然**一个字都不给写

```text
GET /economy/reservations     列出（walletId / ownerId / status / limit）
GET /economy/reservation      单笔（reservationId 或 operationId）
```

**没有** `POST /economy/reserve` · `/commit` · `/release` · `/expire` · `/fail`
· `/sweep`。理由不是保守：预留的语义是"先锁住资源、之后要么成交要么还回去"，
而**谁有权决定成交**（预算策略 / 用户审批 / 动作结果）属于 P22-4 与 P22-8。
在那些层存在之前把写能力挂到 HTTP 上，等于让任何一个能发请求的人替 Agent
决定花钱 —— 那正是 P22 §6 要避免的"LLM 说想要就通过"。

`/security` 的 `economyPolicy` 把"没有"写成了可断言字段：

```js
httpVerbs: ['GET']
writesExposed: []
reservationWritesExposed: []          // P22-3 新增
mintingExposed: false
expirationIsNotATimer: true
availableFormula: 'ledgerBalanceMinor - activeReservedBalanceMinor (READY only, otherwise null)'
unreachable: [… '/economy/reserve', '/economy/commit', '/economy/release',
              '/economy/expire', '/economy/fail', '/economy/sweep']
```

HTTP 层读到的 reservation **不带 `idempotencyKey`**：请求标识没有必要被广播。

---

## 12. 生产文件仍然是 2 个

```text
services/home-node/economy-contract.js
services/home-node/economy-store.js
```

P22-3 **没有**新增生产文件。这不是为了省一个文件：把 Reservation 拆成独立
模块就必须把 `db` / `withTransaction` / `allocateRevision` / `appendChange` /
`computeLedgerBalance` / `commitLedgerTransactionInTx` 这些私有件暴露出去，
而那会把 §10 要求的"ledger 与 reservation 同一个 atomic boundary"从**结构
保证**降级成跨模块约定。

依赖闭包仍然是 3 个 require 目标（`node:sqlite`、`runtime/db-failure.js`、
`./economy-contract.js`）—— 没有 Memory / Relationship / Middle Brain /
Provider Router / 工具执行面 / 真实支付 / 凭据面。

---

## 13. 一处刻意的代码拆分：`commitLedgerTransactionInTx`

SQLite 不允许嵌套 `BEGIN`，因此 `commitReservation` 不能从自己的事务里调用
一个会自己 `BEGIN` 的函数。拆法刻意是**最薄**的：

```text
commitLedgerTransactionInTx  = 校验 + 幂等闸门 + 事务体（不 BEGIN）
commitLedgerTransaction      = withTransaction(它) + 提交后清理与日志
```

两半的**语义完全不变**：公开出口的行为与 P22-2 逐字相同。唯一的形状差异是
"清理 + 日志"移到了 wrapper —— 那一步只有在真的提交之后才允许发生，
而嵌套调用点还没提交（在外层回滚时先记一条 `economy-transaction-committed`
会变成一条假日志）。
