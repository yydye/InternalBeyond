# P22-2 · Economy canonical runtime（Ledger + Wallet）

> 实现：`services/home-node/economy-store.js`（唯一新增生产文件）。
> 契约：`services/home-node/economy-contract.js`（P22-1，**未被修改语义**；
> 仅 §19 白名单新增一条精确文件条目，理由见 §12）。
> 测试：`tests/test_p22_2_economy_store.js`（194 项）、
> `tests/test_p22_2_economy_runtime.js`（66 项，含真实子进程）。
> 本阶段**不包含**：reservation / quote / purchase intent / approval（P22-3/4）、
> product / inventory / store（P22-5）、exchange（P22-6）、compute 计价（P22-7）、
> Decision/Action adapter（P22-8）、provider 适配（P22-9）、UI 与浏览器镜像（P22-11）。

---

## 0. 一句话

**canonical financial truth 是 ledger entries；wallet 的余额只是从它派生出来的缓存。**

这条话在 P22-1 是设计意图，在 P22-2 变成结构事实：能改
`cached_balance_minor` 的 SQL 语句**只有一条**，它写入的值来自**本次交易的
entries**，而不是旧缓存。于是"缓存漂移"不可能变成"真实经济错误"——
最坏情况是缓存暂时不对，而 `rebuildWalletBalance()` 会把它拉回真值并留下一条
`BALANCE_REBUILT` 的审计记录。

---

## 1. 物理布局（刻意只有一个新文件）

```
services/home-node/
  economy-contract.js     P22-1（纯函数契约，零 require）
  economy-store.js        P22-2（SQLite Ledger + Wallet runtime）  ← 本阶段唯一新增
services/home-node-service.js   assembly only（+108 行）
services/home-node/http.js      minimal read-only routes（+146 行）
```

**没有** `services/home-node/economy/` 目录，**没有** manager / service /
repository 分层。P22 §1 明确要求"不要创建十几个 manager/service/repository"，
因此 store 是**一个**文件、**一个**工厂、**一张** `deps` 面。

Economy 生产文件数：**2**（契约 + runtime）。runtime 的 require 目标：**3**
（`node:sqlite`、`runtime/db-failure.js`、`./economy-contract.js`）。

---

## 2. SQLite schema（7 张表，全部 `economy_` 前缀）

| 表 | 作用 | 关键约束 |
|---|---|---|
| `economy_meta` | schema 水位 + revision 水位 + 引擎状态 | `key` 主键；**独立于共用的 `meta` 表** |
| `economy_ledger_accounts` | 记账实体（WALLET / SYSTEM） | `kind` 闭集；WALLET 行必须指回 wallet |
| `economy_wallets` | 面向 Agent 的聚合（owner + currency） | `UNIQUE(owner_id, currency)`；缓存列可被重建覆写 |
| `economy_transactions` | 经济事实 | **没有金额列**（见 §6）；有 `idempotency_key` + `fingerprint` |
| `economy_ledger_entries` | **canonical truth** | `amount_minor INTEGER`；`direction` ∈ {DEBIT, CREDIT}；无符号 |
| `economy_change_log` | 审计（余额为什么是这个数） | `revision INTEGER PRIMARY KEY`（= 版本号本身） |
| `economy_idempotency` | 业务请求 → 已提交结果 | `idempotency_key` 主键 + `fingerprint` + `result_json` |

**为什么 idempotency 不复用 chat 的 `idempotency` 表**（`chat-store.js:139`）：
那张表把 key 映射到 `message_id`，Economy 需要的是 key → transaction +
**request fingerprint** + 已提交结果。硬塞进去就得放宽它的列约束，而"放宽一张
既有表"比"新建一张自己的表"危险得多。

**允许被 UPDATE 的表只有两张**：`economy_wallets`（派生缓存）与
`economy_meta`（水位）。transactions / entries / change_log 是
**append-only**——boundary B11 与 store 测试 O9/O9b 逐字断言这一点。

---

## 3. Schema 版本行为

```js
ECONOMY_SCHEMA_VERSION = 1
```

| 库的状态 | open() 的行为 | 证据 |
|---|---|---|
| 新库 | 写入当前版本 | L1 |
| 同版本 | 无操作 | L2 |
| 更老的**受支持**版本 | 逐级应用 `MIGRATIONS`，抬水位 | L3、L4 |
| **更新的**版本 | **拒绝打开**（`SCHEMA_TOO_NEW` → `db-schema-too-new`） | L5–L9 |
| 水位不是合法整数 | 拒绝打开（不静默当成 0） | L10 |

`MIGRATIONS` 目前是**空数组**——框架存在而内容为空是刻意的：0 → 1 是初版，
但框架本身现在就受测试（L3 把水位降到 0，验证它真的被执行并把水位抬回来）。
第一次真的需要迁移时，被发现的不该是"这个框架从来没跑过"。

拒绝打开之后：`isOpen() === false`、state 是 **DEGRADED**（而不是 COLD——
"我们已经知道这一域服务不了"与"还没加载"是两件事，把它说成后者会让 UI
永远转圈）、库文件**一个字节都没被改动**（拒绝是只读的，不尝试"修复"）。

---

## 4. Revision 命名空间

**只属于 Economy**：`economy_meta['economy_revision']` + `economy_change_log`。

- 取值为 `max(meta 水位, change_log 的最大 revision)`——任何一侧被外部工具
  改写都不会让版本**回退**（回退会让镜像游标重放已消费的 revision）。
- **严格单调、不跳号、不复用**：store 测试 G6 与 I2 逐条断言序列恰好是
  `1,2,3,…`。
- 每一次 canonical mutation 恰好消耗一个 revision：开钱包、提交交易、以及
  **修复缓存漂移**（`BALANCE_REBUILT`）。最后这一条是有意的——"缓存曾经不对过"
  是一个不该静默消失的事实。
- **缓存正确时 rebuild 不推进 revision**（G7）：否则"重建一次"会变成一次
  虚假的经济事件。

---

## 5. Wallet：canonical vs derived

```js
{
  walletId, owner: {type,id}, currency, accountId,
  state,                    // COLD | READY | DEGRADED
  cachedBalanceMinor,       // **derived**：从 ledger 算出来的缓存
  reservedBalanceMinor,     // P22-3 的 reservation 会用它；P22-2 恒为 0
  availableBalanceMinor,    // **派生**：cached − reserved，非 READY 时为 null
  balanceKnown, revision, createdAt, updatedAt
}
```

| 字段 | 性质 | 谁写 |
|---|---|---|
| `availableBalanceMinor` | **派生**，从不存储 | 契约 `makeWalletView` |
| `cachedBalanceMinor` | **derived cache** | 唯一一条 `SET cached_balance_minor=?` |
| `reservedBalanceMinor` | 保留列（P22-3 用） | 同上 |
| ledger entries | **canonical** | 只能通过 `commitLedgerTransaction` 追加 |

**`wallet` 与 `ledger account` 刻意不是一回事**：gift 让两个 wallet account
相对记账，MINT 让一个 wallet account 与 `system:mint` 相对记账。把它们合成
一个东西，就会出现"`system:mint` 也是一个钱包"这种没有 owner 的钱包。
因此 `system` **不能**是 wallet owner（C7 断言它被拒绝）。

---

## 6. Transaction：P22-2 只是"ledger 的原子提交容器"

**transactions 表里没有金额列。** 金额只存在于 entries——交易上再存一份
金额就是第二个事实源，而它们会漂移。

`state` 列存在，但 P22-2 只在 COMMIT 的那一刻写入 `COMMITTED`，并且
**没有任何 UPDATE 路径**（O9b 断言）。也就是说 P22-1 §7 的状态机在 P22-2 是
靠"根本没有那条语句"来满足的，而不是靠一句运行时判断。reservation / quote /
purchase intent / approval **刻意没有实现**——它们属于 P22-3/4。

---

## 7. 原子性：一次 commit = 一个 SQLite 事务

```
BEGIN IMMEDIATE
  validate（契约 + 平衡 + system account 白名单 + 透支预检）
  insert transaction          ← 故障点 after-transaction-insert
  insert entries              ← 故障点 after-first-ledger-entry
  re-verify balance（从库里读回来的行）      ← 写入口的第二道
  update derived wallet cache ← 故障点 before-wallet-cache
  append change log           ← 故障点 before-change-log
  write idempotency result    ← 故障点 before-commit
COMMIT
```

任何一步抛错 → `ROLLBACK`。store 测试 J 组在四个位置**逐个**注入故障，
每次都用全新的库，并对**真实 SQLite** 断言：

| 断言 | 结果 |
|---|---|
| 0 条残留 transaction | J2 |
| 0 条残留 ledger entry | J3 |
| 0 条残留 change log | J4 |
| 0 幻影余额（缓存没被改） | J5 |
| revision 没有断裂（不消耗版本号、不留空洞） | J6 |
| 幂等表里没有留下结果（重试能真的提交） | J7 |
| 直接查库：没有孤儿 entry、没有指向不存在交易的 change | J8 |
| 回滚之后账本仍然逐币种平衡 | J9 |
| "交易行在、entry 不在"不可能（J10 单独再证一次） | J10 |

**故障注入是 test-only seam**：只在 `deps.faults` 上，装配层从不传它，
`http.js` 里没有任何路径能到达它，而 `economy-store.js` **不 require http**
（B11.5、O11）。

---

## 8. Double-entry enforcement（三处，而不是一处）

1. **契约** `checkLedgerBalance`（逐 currency、≥2 entries）。
2. **写入口再验一次**——P22-1 的校验不足以作为唯一依据：调用方可以在校验
   之后改数组（同一份引用），而"我们已经在契约层验过"正是那种只在一半路径上
   成立的理由。
3. **落库之后第三次验**——用的是 `SELECT` 读回来的真实行，而不是内存对象。
   `LEDGER_UNBALANCED_AS_STORED` / `LEDGER_ENTRY_COUNT_MISMATCH` 是这一步的
   两个失败模式。

### 8.1 MINT / BURN 的对手方约束（契约外的必要收紧）

契约允许 MINT/BURN 免除"两侧都是钱包"的拓扑，但**没有**说对手方可以是
任意账户。没有运行时的这一条，`MINT` 就能把任意账户当来源，而 ledger 依然
"平"——凭空增发会从一个被允许的名字里溜进来。因此：
MINT 的 system 对手方必须是 `system:mint`、BURN 必须是 `system:burn`，且
这两个账户**只允许**出现在 MINT / BURN 里（F7）。

### 8.2 记账符号

```
WALLET 账户： balance = Σ(DEBIT) − Σ(CREDIT)
SYSTEM 账户： balance = Σ(CREDIT) − Σ(DEBIT)      （control account）
```

system 反过来读，是为了让"整个账本恒等于 0"这条全局不变量在**任何**时刻
成立，包括增发之后（F10 断言两个币种都平衡）。MINT 后 `system:mint` 是
**正向**的增发量、`system:burn` 是**反向**的销毁量。

因为契约规定 canonical amount **无符号**（`serializeAmountMinor(-40n) === null`），
控制账户的负方向用**两个字段**表达：

```js
{ balanceMinor: "40", sign: "DEBIT" }     // 销毁方向累计 40
```

而不是一个 `"-40"` 字符串——"负金额"在契约里根本不是一个可表示的东西。

---

## 9. Idempotency

```
fingerprint = hash( type, actor, ownerId, recipientId,
                    sorted[ accountId | direction | amountMinor | currency ] )
```

- **不含 transactionId / ledgerEntryId**：否则"同一笔业务、两次派生的 id"
  会被判成不同请求，幂等性在重试路径上静默失效（P22 §14 第一条）。
- **不含 entry 顺序**：两笔 entry 的先后是记账实现细节。
- 指纹在**任何写入之前**算出来并查表 → 重放根本不进入事务体。
- idempotency 行与 transaction / entries / change_log **在同一个 SQLite 事务
  里**写入 → "记了幂等但没记交易"不可能发生，而这正是**跨重启幂等**的基础。

| 情形 | 结果 | 证据 |
|---|---|---|
| 同 key + 同业务 | 返回**原来那笔**（`replayed: true`），零副作用 | H1–H5 |
| 同 key + 不同金额/类型/钱包 | `IDEMPOTENCY_CONFLICT`（不静默返回第一次结果） | H6、H7 |
| 冲突被拒之后 | 账本完全没变（冲突检测在任何写入之前） | H8 |
| 同 transactionId + 不同 key | `TRANSACTION_ID_ALREADY_COMMITTED`，**不覆盖** | H9、H10 |
| 同 key + 不同 transactionId | 仍然返回原来那笔，不生成第二笔事实 | H11 |
| `12345` 与 `'12345'` | 归一成同一个 key | H12 |
| **跨进程重启** | 仍然 `replayed: true`，行数与 revision 不变 | H16–H18、**F1–F4（真实子进程）** |

---

## 10. 余额重建

```
rebuildWalletBalance(walletId)
  ① 结构完整性预检（三条，任何一条不成立即 DEGRADED）
       · account 行存在
       · account.kind === WALLET
       · account 指回这个 wallet，且币种一致
  ② balance = Σ(DEBIT) − Σ(CREDIT)   （逐 account + currency）
  ③ 缓存 != 重建值 ⇒ 覆写缓存 + 记 BALANCE_REBUILT + revision++
```

**① 不是装饰**：没有它，"账户行被删掉"会静默变成**零余额**——
`computeLedgerBalance` 对一个不存在的账户求和得到 0，于是"我不知道这个钱包
有多少钱"被回答成"它有 0 元"。那就是 P22-0 R5 的同一个根因换了一个入口
（N5–N9 就是针对它的测试：把账户行删掉，rebuild 必须失败并让 store 降级）。

---

## 11. COLD / READY / DEGRADED：fail closed 的落点

| engine state | 什么时候 | `availableBalanceMinor` |
|---|---|---|
| **COLD** | 库从未打开过 | **`null`** |
| **READY** | 库打开、无降级、行 state 是 READY | 派生值（BigInt → 十进制字符串） |
| **DEGRADED** | open 失败过 / 重建失败 / 行不满足契约 | **`null`** |

判定**只有一处**（`engineStateNow()`），因此 `health()` 与 wallet 读取不可能
给出两个不同的答案。

关键的 fail-closed 细节：
- 非 READY 时**连缓存列都不读**——"读出来再记得别用"是注释级保证，不是结构级的。
- 库关闭后 `getWallet()` / `rebuildWalletBalance()` **抛 `STORE_CLOSED`**，
  而不是返回一个 0 余额的钱包。
- `health()` 在库关闭时**返回 state 而不是抛错**——抛错会诱使调用方写
  `catch { return 0 }`。
- 一次**成功**的 open 会清掉降级结论（否则"库修好了"永远无法被表达）；
  一次**失败**的 open 会让它粘住。

---

## 12. 金额的三层表示与边界

| 层 | 表示 | 转换点 |
|---|---|---|
| runtime | **BigInt** | — |
| JSON | **十进制字符串** | `serializeAmountMinor` |
| SQLite | `INTEGER` | `toSqlAmount` / `fromSqlAmount` |

两个方向的转换都**先证明再转换**：
- 写：`Number(v)` 之后必须满足 `BigInt(Number(v)) === v`，否则抛
  `AMOUNT_NOT_REPRESENTABLE`。于是 `Number(bigint)` 从来没被用作"正常路径"。
- 读：必须是安全非负整数，否则抛 `AMOUNT_READ_BACK_INVALID`。

逐条验证（E 组）：`MAX_SAFE_INTEGER` 完整往返、`MAX+1` 被拒、负数/小数/
`NaN`/`Infinity`/`'1.5'`/`'1e3'`/`'0x10'`/`'1,000'`/`'+1'` 全部被拒，
`0`/`'1000'`/`'007'` 被接受，并且**直接查库**确认存的是 `typeof === 'integer'`。

一条运行时收紧（**比契约严，不与它矛盾**）：0 金额的交易被拒绝。契约允许
"两侧都为 0"（`checkLedgerBalance` 放行），但那是一次没有经济内容的事实——
它只会污染审计并消耗 revision。E6/E6b 同时断言"契约放行"与"运行时拒绝"，
于是这条收紧是**可见的**而不是藏起来的。

---

## 13. Home Node 两条装配路径（P22 §20/§21）

| 路径 | 位置 | 证据 |
|---|---|---|
| `buildHomeNode().open()/close()` | `home-node-service.js` | B1–B6（真的 open + close） |
| 生产 `openAll()` | 同上（`require.main` 分支调用的同一个函数） | B7–B11 |

两条路径**共用** `economyAssembly()` —— 它同时定义"创建"与"打开"，因此
"某个 canonical 域没有接线"不可能只在一侧发生。

### 13.1 真实子进程实测（本阶段最重要的机器证据）

`tests/test_p22_2_economy_runtime.js` 的 D/E/F 组真的 spawn
`services/home-node-service.js`（内置 `runtime/node/node.exe`，与生产启动器
逐字相同）：

```
D1  进程在私有端口 + 私有数据目录上起来了
D2  GET /economy/health → 200
D3  state === 'READY'
D4  库就在它自己的 IB_HOME_NODE_DATA_DIR 下
D5  启动日志里有 economy-opened
D6  POST /economy/purchase → 405
D7  POST /economy/mint     → 405
D9  干净停机（合作停止面 /__shutdown，不是 TerminateProcess）
D10 日志里有 shutdown / stopped / economy-closed 且拆除梯子五步跑完
E5  同一库重启 → revision 从原值继续
E6  重启后余额逐字相同（777），且是从 ledger 重建的
E7  重启后 ?rebuild=1 报告没有漂移
E8  重启后 transaction 与两笔 entry 都还在
E9  重启后 change log 逐条还在，revision 序列没有断
F1  **跨进程重启**重放同一 idempotencyKey → replayed=true
F2  行数与 revision 都没变
F3  余额仍然是 777（不是 1554）
F4  跨重启同 key 换金额 → IDEMPOTENCY_CONFLICT
```

### 13.2 这个测试**当场抓到的**一个真实缺口

第一次运行时（修复前）：子进程日志里**明明**有 `economy-opened`，
而 `GET /economy/health` 回 **501 `economy-not-assembled`**。

原因是生产路径的 `createHttp({...})` 没有把 `economy.economyStore` 传下去 ——
`openAll()` 打开了 store，但 HTTP 层拿不到它。这正是 memory / understanding /
moments 那三次缺口的**第四次形态**：装配做了、打开做了、只差**一行接线**，
而所有直接 `createEconomyStore()` 的测试全绿。

修复就是 `services/home-node-service.js` 里的一行，并由 D2 长期守住。

G 组反过来证明这个断言不是空的：手工造一个**不传** `economyStore` 的 http 层，
断言 `/economy/*` 回 **501 `economy-not-assembled`**，而**不是 404**——
前者是"这一域没接线"（一个可修的装配缺口），后者会被读成"这个路径不存在"
（设计如此）。P11-3E 的教训正是"装配缺口伪装成正常行为"。

---

## 14. HTTP surface（**只读**）

| 路由 | 作用 |
|---|---|
| `GET /economy/health` | state（三态）、schema、revision、counts、`doesNotExpose` |
| `GET /economy/wallet?ownerId=&currency=` / `?walletId=` / `?rebuild=1` | 余额（字符串）；`rebuild=1` 会从 ledger 重算 |
| `GET /economy/wallets?ownerId=` | 列钱包 |
| `GET /economy/ledger?transactionId=` / `?accountId=&currency=` | entries + 逐币种 topology + `scope` |
| `GET /economy/transaction?transactionId=` | 一笔交易与它的 entries |
| `GET /economy/changes?cursor=&limit=` | change log（审计） |

**没有** `POST /economy/*`。铸币（`mintForSystem`）、销毁（`burnForSystem`）、
提交交易（`commitLedgerTransaction`）都是 **store 的内部 API**，因此
"通过 HTTP 凭空造钱"这条路在**路由表**上就不存在，而不是靠一个 `if` 挡着。
测试 C11 逐个 POST 那 9 条路径，全部 405 `economy-is-read-only`；
C12 断言这些写尝试之后账本一个字节都没变。

`/economy/*` 里未登记的其他路径回 404 `unknown-economy-path` ——
"不存在"与"不允许"是两个不同的回答。

---

## 15. 安全边界

| 项 | 处理 | 证据 |
|---|---|---|
| 桌面面 | `/economy/*` 归入 `isDesktopOnlyPath`（与 `/memory/` `/understanding/` `/moments/` 同类） | C19 |
| loopback 豁免 | **不给**：`/economy/*` 不在 `loopbackReadableWithoutToken` 清单里 | C20 |
| 已配置 token | 不带 token → 401；带对 → 200 | C21、C22 |
| `/health` 既有豁免 | **未受影响**（仍 200） | C23 |
| `ADMIN_PATHS` | 未改动（Economy 不是 mobile verb） | C16 |
| `doesNotExpose` | `payments` 一个字都没动 | C17 |
| 凭据铸造面 | `/pairing/session` `/devices` `/characters/publish` 仍是那三条 | C18 |
| mobile verbs | Economy **不给设备**：`servedToDevices: false`、`deviceVerbs: []` | C16 |
| `/security` | 新增可检查的 `economyPolicy`：`httpVerbs:['GET']`、`writesExposed:[]`、`mintingExposed:false`、`unreachable:[topup,purchase,payment,provider,mint,burn,transfer]` | C14、C15 |

**`/economy/*` 一律免授权**这条路没有被走，也没有被"为了方便"走。

---

## 16. Character ownership

- wallet 的 owner 只能是 canonical party：`{type:'character'|'user', id}`。
- `system` **不能**当 wallet owner（它只有 ledger account）。
- 角色是否存在，由一个**注入的谓词**回答（装配层接到 device-registry 的
  `getCharacter` 上）。于是：
  - Economy 的依赖闭包里**没有**角色目录，更没有持有角色执行配置的那张表
    （凭据面）——boundary B3/B6/B7 逐字断言；
  - "角色不存在 ⇒ 失败"仍然是真的（C10），**不自动凭空创建角色**；
  - 注册表未打开时谓词回答 `false`（fail closed），而不是"查不到就说存在"。

---

## 17. 契约的**唯一**一次修改（并且是加法的）

`BOUNDARY_ALLOWED_MODULE_PREFIXES` 新增一条**精确文件**条目：

```js
'runtime/db-failure.js'
```

理由：它是仓库里**唯一**一处数据库失败分类器（`memory-store.js:46` 与
`http.js:193` 都以同样的理由用它）。P22-2 的 store 在 `open()` 失败时也必须
给出**同一个** category，否则"为什么打不开"会有两个答案，而 http.js 的
`resolveStoreFailure` 只认那一个。

这是**加法**，不是放松：
- 加的是精确路径（不是 `'runtime/'` 前缀）——它覆盖**一个文件**，不是一个目录；
- 钉住的是"失败分类只有一份"这条**既有**纪律，不是引入新的依赖面；
- 它仍然是一条白名单条目，B3.1 的正向断言继续成立。
- 真正被禁的那些东西（凭据 / 真实支付 / provider / Memory / Relationship）
  一个都没有靠近这条白名单。

**契约的任何语义（币种、金额、状态机、平衡规则、effect、event、矩阵）都没有
被改动。** 实现没有为了让代码好写而修改契约，也没有修改实现去迁就契约的缺陷——
唯一一次"契约与实现不一致"是 §8.1 与 §12 的两处**运行时收紧**，两处都写成
"契约放行 + 运行时拒绝"并被测试同时断言，因此它们是可见的决策，不是静默的偏离。

---

## 18. 边界测试的扩展（P22-1 全部继续生效）

| 组 | P22-2 的变化 |
|---|---|
| B2 | `PRODUCTION_FILES` 加入 `economy-store.js`；B2.1 强制清单与磁盘一致 |
| B3 | 继续生效（**扫描器被修好**：见下）；新增的 runtime 只 require 白名单内的东西 |
| B4 | **B4.2 被重写**：启动链**只允许** `home-node-service.js` require `economy-store.js`，且是精确实例；新增 B4.3（依赖方向单向：store 不 require 启动链）、B4.4（http 层拿不到写能力） |
| B5–B8 | 继续生效，未改动 |
| B9 | **真实覆盖新文件**：B9.1/B9.2 现在遍历 2 个文件及其 require 闭包（含 `runtime/db-failure.js`），B9.4 `denied` 为空 |
| B10 | 继续生效 |
| **B11（新增）** | 9 条"余额直接改写形态"逐个点名不存在 + 唯一一条缓存写语句 + runtime 用同一个契约 + 命名空间独立 + 故障注入不可 HTTP 触达 + 铸币需 `systemInitiated` + 两条**输入存在**的反向断言 |

### 18.1 扫描器被修好（一个真实的假阳性）

第一次跑扩展后的 boundary 时，`B3.7` 报 `economy-store.js` require 了 `crypto`。
真相是：文件里有一句注释在解释**为什么不用** crypto（`require('crypto')`
不是安全边界，而是一个非安全用途不该破例）。旧 `scanRequires` 在**原文**上扫
（注释未剥），于是把这句话当成了依赖。

修的是**扫描器**，不是那句话：`scanRequires` 现在跳过落在 `//` 之后或未闭合
`/* */` 里的候选。修错的选项（删掉注释）会让仓库失去一段重要的解释——
而那正是这个仓库最不该丢的东西。

---

## 19. 发行包（P22 §27）

`release-manifest.resolve({})` 的 `{from:'services/home-node', dir:true}` 是
**目录级**规则，因此 `economy-store.js` 自动入包。P22-1 说"不要因为 B9 绿就
假定新增文件自动没问题"——所以 B9.1/B9.2 是**逐文件**断言，现在遍历
**2 个文件 + 3 个 require 目标**，全部在 `resolved.files[].to` 里；B9.4
断言 `denied` 为空。这一条无需改动 manifest，**但断言确实重跑过**。

---

## 20. 本阶段刻意**没有**做的事

```
reservation / wallet reserved 的实际占用（列已留，逻辑属 P22-3）
quote · purchase intent · approval（P22-3/4）
product · inventory · store（P22-5）
exchange（P22-6）
compute 计价与消耗（P22-7）
Decision/Action adapter（P22-8）
provider 适配 / provider telemetry（P22-9）
UI · 浏览器镜像（P22-11）
第二个 Middle Brain · 第二份 provider metadata · 第二份角色表
virtualToken · realCostUsd 作为可消费余额
```

---

## 21. 给后续阶段的接入纪律

P22-3 起每加一个 Economy 生产文件，必须同步四处（P22-1 的三处 + 新增一处）：

1. `tests/test_p22_1_economy_boundary.js` 的 `PRODUCTION_FILES`（否则 B2 立刻失败
   ——这正是它存在的意义）；
2. `tests/test-all.js` 的 `GROUPS`；
3. `scripts/release-manifest.js`（若新模块被**启动链** require —— 目录规则已覆盖，
   这条判断由 B9 逐次复核）；
4. **`services/home-node-service.js` 的 `createHttp({...})` 里那一次接线**
   ——§13.2 的 501 就是漏了它。凡是新加一个"HTTP 要读它"的 canonical 域，
   第 4 条都是必须的，而 D 组的真实子进程断言会抓住漏掉它的那一天。
