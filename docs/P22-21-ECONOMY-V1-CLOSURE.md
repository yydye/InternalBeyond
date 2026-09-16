# P22-21 · Economy v1 Final Closure & Freeze

> 本文件是 **P22-21** 的阶段记录与审计全文。
> 它的交付物还有两份机器可检查的东西：
> `docs/ECONOMY_V1_FROZEN_CONTRACT.md`（冻结契约清单 · §11）
> 与三条新测试（§12 / §13）。
>
> **最终分类：B · CLOSED WITH DOCUMENTED NON-BLOCKING DEBT。**
> 理由在 §14，债务逐条在 §13。

---

## §0 · 这一阶段做了什么、没做什么

**做了**：对 P22-1 ～ P22-20 已交付的 Economy 做一次整体闭包审计，回答
"Economy v1 是否可以被正式冻结为一个 internally-consistent /
authority-closed / read-write-separated / externally-isolated 的完整子系统"，
并把回答写成三份**可被代码推翻**的东西。

**没做**（逐条）：

| 项 | 结果 |
| --- | --- |
| production diff | **0 行**（`git status` 里只有 `tests/test-all.js` 这一个非新增文件的改动，且它是测试登记） |
| 新 schema / 迁移 | 0（水位仍是 **7**） |
| 新 route | 0 |
| 新 capability / consumer | 0 |
| 新 event type | 0 |
| 新 UI | 0 |
| Refund / Exchange / Payment / Provider Billing / Human Direct Buy | **没有实现**，而且逐条断言"没有能力" |
| 进入 P22-22 | 没有 |

---

## §1 · §0 阶段账本审计（Phase Ledger）

22 个 commit（P22-1 ～ P22-20 + P22-12C + P22-15C），全部在 `git log --all`
里可见，没有任何一条在最近 60 条之外。`runtime/` 目录**没有任何一个 P22
阶段碰过**。

其中 **3 个阶段的 production diff = 0**：P22-12C（doc-only 只读审计）、
P22-15C（test-only，**唯一没有 doc** 的阶段）、P22-20（doc + tests，
自述「0 行」）。

### 1.1 文件共享 ≠ 权威重复

`services/home-node/http.js` 被 **12** 个阶段改过，`economy-store.js` **11**
个，`economy-contract.js` **10** 个，`home-node-service.js` **6** 个；另有 16
个文件被 2 个以上阶段改过。

★ 这件事**不是** authority 重复：那四个文件是**分层的**，每个阶段往各自的
层里加自己的那一小块（http.js 每阶段加 2～6 条只读路由与一行 `unreachable`
声明；store 每阶段加一组新方法）。而 §0 要问的是**权威**，判据因此是
"每一个 canonical 权威是否恰好有一个 owner 符号"，而不是"哪个文件被谁改过"。

### 1.2 分类结果

| 分类 | 数量 | 证据 |
| --- | --- | --- |
| A · 唯一 owner | **22** | 22 个 canonical 权威各恰好一个定义点（见 §2） |
| B · delegated / projection | 3 | 浏览器三个纯层：只投影，不持权威（§8） |
| C · duplicated authority | **0** | `P0-1` 逐权威断言定义点恰好一个 |
| D · orphan authority | **0** | `P0-2` 断言每一个 owner 符号都在生产代码里被引用 |

**"后来阶段偷偷改变早期阶段的语义"** 的机器形式也一并断言了：五个封闭词表
（币种 / 购买状态 / 批准状态 / 事件类型 / 资产类别）在**整个生产代码 + 六个
浏览器文件**里只有**一个**定义点（契约）。P22-1 冻结的 `DOMAIN` /
`ID_KINDS`(16) / `ID_MAX_LENGTH`(128) 到今天逐字未变。

---

## §2 · 权威图（§1）：从**真实调用边**生成

不是照抄目标里那张图。本阶段的 `test_p22_21_economy_golden_path.js` 在
装配层允许的注入点上（`options.economyStore`）给 store 加了一层**只读记账
代理**，记录这一次真实运行里发生的每一条 `(调用者文件:行 → store 方法)`。
一次金路径跑出 **83 条边**，涉及 **5 个生产文件**。

| # | 边（source → target） | authority carried |
| --- | --- | --- |
| 1 | `economy-configuration.js` → `bootstrapInitialCredit` | 初始额度（一次性，canonical meta 行持有） |
| 2 | `economy-configuration.js` → `putBudgetPolicy` | 预算规则 |
| 3 | `economy-configuration.js` → `putAutonomyPolicy` | 自主规则 |
| 4 | `economy-capability.js` → `proposeAgentPurchaseIntent` | Agent 的 WANT（**提出**，不是允许） |
| 5 | `economy-approval-decision.js` → `decideApproval` | 用户的决定（APPROVE / REJECT） |
| 6 | `economy-capability.js` → `resumeAgentPurchaseIntent` | 批准之后的继续权（`RESUME_APPROVED_PURCHASE`） |
| 7 | store 内部 → `preparePurchase` / `settlePurchase` / `mutateInventoryInTx` / `commitLedgerTransactionInTx` | 结算（一个事务） |
| 8 | `http.js` → `get*` / `list*` / `evaluate*` | 只读投影（`mutation = false`） |

### 2.1 shortcut edge = 0（逐条）

| 禁止的边 | 断言 | 结果 |
| --- | --- | --- |
| Agent → Ledger | `economy-capability.js` → 任何账本原语 | **0** |
| UI → store | 任何一条边的调用者来自 `assets/` | **0** |
| Approval UI → Purchase settle | `economy-approval-decision.js` → settle / prepare / commitLedger | **0** |
| Configuration → Purchase | 配置面 → 购买 / 库存 / 结算 / 账本 | **0** |
| Read Model → mutation | `http.js` → 39 个经济 mutation 动词 | **0** |
| Inventory → Wallet mutation | `applyDerivedBalances` / `applyReservedCache` 的**直接**写恰好是 `setWalletBalance` / `setWalletReserved` 两个缓存列 | 成立 |
| Change Log → authority decision | `appendChange` 只写 `insertChange`，不读任何东西来做判定 | 成立 |
| Transport → store | `economy-command-channel.js` / `economy-action-adapter.js` → store | **0**（两者都不持有 store） |

---

## §3 · 写面普查（§2）

**39** 个改变 canonical 经济事实的 store 方法，逐个算 production caller：

| 分类 | 数量 | 说明 |
| --- | --- | --- |
| 1 · reachable and authorized | **7** | `bootstrapInitialCredit` · `putBudgetPolicy` · `putAutonomyPolicy` · `decideApproval` · `proposeAgentPurchaseIntent` · `resumeAgentPurchaseIntent` · `appendCapabilityAudit` —— 调用者全部在三个 seam 或那道门里 |
| 2 · internal-only | **32** | 由 store 内部的编排调用（`executeIntent` → `preparePurchase`/`settlePurchase` 等）；`http.js` 里一个名字都没有 |
| 3 · tests-only | **0** | —— |
| 4 · dead / unreachable | **0** | —— |
| 5 · **suspicious bypass** | **0** | **没有任何经济 mutation 从三个 seam 之外的生产文件被调用** |

### 3.1 唯一一处"读面传递可达写"，以及它为什么不是绕过

`http.js` 调 `getWallet` / `listWallets`，而这两个方法**传递可达**一次写。
写的是 `economy_wallets` 的**两个派生缓存列**（`cached_balance_minor` /
`reserved_balance_minor`），而它们的值是**从 canonical 行重算**的
（P22-2 §11 的既定语义："余额只是缓存，必须能从 ledger 重建"）。
断言把这件事写成三句：直接写集合恰好 `{setWalletBalance}` / `{setWalletReserved}`、
没有碰任何经济表、重建确实读 canonical。

### 3.2 公开写面（三条，逐条）

| Method | Path | Envelope | Vocabulary | Credential | Consumer |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/internal/economy/configuration` | `command` · `config` · `idempotencyKey` | `BOOTSTRAP_CREDIT` · `PUT_BUDGET_POLICY` · `PUT_AUTONOMY_POLICY` | 桌面凭据 | `home_node_authority` |
| `POST` | `/internal/economy/approval-decision` | `approvalId` · `decision` · `idempotencyKey` | `APPROVED` · `REJECTED` | 桌面凭据 | `user_decision_seam` |
| `POST` | `/internal/economy/command` | `command` · `commandId` · `idempotencyKey` · `proposal` | `ECONOMY_PROPOSE_PURCHASE` | 来源凭据 + 已登记来源端口 | `active_agent_runtime` |

三条**都不在** `/economy/` 下，因此"`POST /economy/*` 一律 405"是一条结构性
事实而不是一种约定。

---

## §4 · 读面普查（§3）

**28** 条 `GET /economy/*` + **1** 条 `GET /security`。双向 diff：

| 比较 | CODE − DOC | DOC − CODE |
| --- | --- | --- |
| 代码 ↔ `ECONOMY_V1_FROZEN_CONTRACT.md` | **0** | **0** |
| 两份文档互相（manifest ↔ `ECONOMY_PUBLIC_SURFACE.md`） | **0** | **0** |

★ 比较只覆盖 **Economy 的读面**：`http.js` 同时服务 `/health` `/status`
`/message` 等路由，把它们算进来会报出七条与该契约无关的假差异。

### 4.1 顺序权威与 owner 作用域

| Path | 顺序 | owner 作用域 |
| --- | --- | --- |
| `/economy/changes` | 无 `ownerId` 时按 `revision` 升序 keyset；带 `ownerId` 时 `order` ∈ {`asc`,`desc`}，且 `order` 只能与 `ownerId` 同时出现 | canonical query（`listChangesForOwner`） |
| `/economy/purchases` · `/economy/intents` | `created_at ASC` | `buyerId` / `ownerId` 过滤 |
| `/economy/products` | `sort_order ASC, created_at ASC` | 无个性化、无推荐、无排序分数 |
| `/economy/inventory` | `updated_at DESC` | `ownerId` 过滤（**不带时那条 canonical query 返回空集**） |

### 4.2 owner-scope 对抗性 fixture（交错噪声，不是顺序写入）

两个 owner 的 canonical 事实**逐条交错**产生（A 报价 → B 发放 → A 发放 →
B 报价 → A 批准 → B 发放 …），然后断言：

* A 的每一条事实都在 A 的时间线里，B 的一条都不在，反之亦然；
* `desc` 之下 revision **严格递减**；
* `limit=3` 恰好是 desc 的**头三条**（不是尾三条）—— 分页截断取的是最新的一段；
* `scope` 自述（`scoped:true` / `ownerId` / `order`）写在响应里；
* 这个投影**不重算**任何经济事实。

真实 HTTP 的那一腿（`GET /economy/changes?ownerId=&order=desc`）由
`test_p22_21_economy_golden_path.js` 的 G24/G25/G26 在同一阶段内真跑一遍
（那里本来就有 server），以及 P22-19 的三条既有测试持有。本文件因此**不为了
"再证明一次"多开一个 socket**。

---

## §5 · 状态机叉积审计（§4）

四个状态机（Intent × Approval × Purchase × Quote）的**可达组合从真实运行时
生成**：在同一个 store 上把七条真实路径走一遍（AUTO_ALLOW 成功 / 等待审批 /
用户批准 / resume 完成 / 用户拒绝 / 报价过期 / 权威放行但预算拒绝），每一步
记录四元组。

| 项 | 结果 |
| --- | --- |
| 观察到的组合 | **7** 个 |
| 结构上界（状态集叉积） | **630** |
| impossible but observable | **0** |
| terminal combinations | **≥ 1**（S1 里真实走到了"三者同时终态"） |
| forbidden combinations | **6**，逐条证伪（见下） |
| unknown / unproven | **0** |

| 候选异常 | 证伪方式 |
| --- | --- |
| approval CONSUMED 但 purchase 不存在 | 结构性：`consumeApprovalForPurchaseInTx` 必须带 `purchaseId`，且在结算事务内 |
| purchase COMPLETED 而 intent 还在等 | 真实 fixture + 契约：`PROPOSED` / `WAITING_APPROVAL` 的转移集里没有 `COMPLETED` |
| rejected approval 配 executing purchase | 真实 fixture + 契约：`REJECTED` 的后继是空集 |
| expired quote 配新完成的 purchase | 契约：`EXPIRED` 后继空集 + `PURCHASE_INTENT_BYPASSES_QUOTE_EXPIRY = false`（且真实跑过） |
| terminal state resurrection | 六个状态机的每一个终态后继**都是空集** |
| failed intent 留下可变 continuation | 真实 fixture：预算拒绝之后 intent 落终态且 `purchaseId` 为 null |

---

## §6 · exactly-once 端到端（§5）

七层身份重新画成一张图（identity / owner / lifetime / persistence / conflict）：

| 层 | identity | owner | 持久化 | 冲突语义 |
| --- | --- | --- | --- | --- |
| producer | 生产者算出的稳定 key | Active 运行环境 | 不持久化 | 同一份模型输出 ⇒ 同一个 key |
| transport（command channel） | `commandId` + `idempotencyKey` | 通道（`economy_command_*` 内存环 + 审计环） | 内存 | 同 `commandId` ⇒ `channelReplay:true` |
| intent | `idempotencyKey` + 60s 指纹窗口 | store（`economy_operation_idempotency`） | **SQLite** | 同 key ⇒ `replayed:true`；同指纹不同 key ⇒ 抑制 |
| quote / reservation / operation | `idempotencyKey` + scope | store | SQLite | 同 key ⇒ 重放 |
| approval decision | `idempotencyKey` → 派生的 resume key（`decision-resume:<key>`） | seam + store | SQLite | 同 key ⇒ `replayed:true` |
| settlement | `PURCHASE_SETTLE` scope + `idempotencyKey` | store | SQLite | 终态 ⇒ 拒绝（不可复活） |
| inventory | `(ownerId, productId)` 唯一键 + 幂等键 | store | SQLite | 同 key ⇒ 重放 |

**七层重放（A～G）之后，三件事逐字不变**：购买数量 **1** · 库存总量
**1000** · 账本 delta **0**。

| 重放 | 形式 | 结果 |
| --- | --- | --- |
| A · producer 重发 | 同 `commandId` + 同 `idempotencyKey` | 同一条 intent，无新购买 |
| B · transport 重发 | 同 `idempotencyKey` + **换一个** `commandId` | 通道认为是新 command，**下游**仍认成同一条 intent |
| C · intent 重发 | store 的 canonical 幂等 | `replayed:true` |
| D · approval decision 重发 | 同 `idempotencyKey` | `replayed:true`，`purchaseCreatedNow` 不是 true |
| E · resume 重发 | **换一个**决定幂等键 + 同一个已消费的 approval | 拒绝（`CONSUMED` 是终态），零经济动作 |
| F · settlement 重发 | 换一个幂等键 | 拒绝（终态不可复活） |
| G · restart 之后重发 | 关掉 server + store，在**同一个 dataDir** 上重新装配，再重发 producer 与 decision | 世界在重启前后与重放之后**逐字相同** |

★ **没有第二套 dedupe**：三层身份各有唯一 owner，且互不争权 —— B 那一条正是
"通道身份丢了、下游仍然认得出"的证明。

---

## §7 · 崩溃边界（§6）

### 7.1 静态：哪些在同一事务，哪些是事务后副作用

一次结算（`settlePurchase`）的**传递 SQL 写集合**包含：

```text
insertTransaction · insertEntry · insertChange        （账本 + 变更记录）
insertInventory / growInventory                       （库存发放）
setApprovalConsumed                                   （批准消费）
setPurchaseSettled                                    （购买完成）
setQuoteState                                         （报价消费）
setReservationStatus / setOperationStatus             （预留提交）
```

`settlePurchase` 里 `withTransaction(` 恰好出现 **1** 次；而
`db.exec('BEGIN IMMEDIATE' | 'COMMIT' | 'ROLLBACK')` 这**三件事务控制语句**
在整个 store 里只出现在 `withTransaction` 一个函数体内。

★ 判据必须是**事务控制语句的字面量**。开发期实测：用 `/COMMIT/` 去扫会命中
契约里那个叫做 `COMMIT` 的 operation scope 常量，于是 `commitOwner` 列出了
**10 个与事务无关的函数** —— 一条看起来很严格、实际上在断言别的东西的规则。

### 7.2 三个"半完成"问题

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| Ledger 已扣 / Inventory 未发 / Purchase 却 COMPLETED | **不可能** | 六样在同一个 `BEGIN IMMEDIATE` 事务里；任何一步抛错 → `ROLLBACK` |
| Inventory 已发 / Ledger rollback | **不可能** | 同上（同一事务） |
| Approval CONSUMED / Purchase 永远不存在 | **不可能** | 消费发生在结算事务内，且 `consumeApprovalForPurchaseInTx` 必须带 `purchaseId`（该购买行在同一事务里被写成 COMPLETED） |

### 7.3 崩溃注入**不重跑**

P22-3 / P22-6 / P22-7 的阶段测试与它们的 worker fixture 已经持有 18 个故障点
的事务级证明（`faultPoint` 在 store 里有大量调用点），本阶段因此**不为了
"再证明一次"spawn 多进程**。本阶段只做了一条**静态**证明（7.1）与一条引用
断言（既有崩溃测试 + 故障点都在）。

---

## §8 · 四资源命名空间最终冻结（§7）

| | storage | unit | authority | mutation path | external convertibility |
| --- | --- | --- | --- | --- | --- |
| **A · IB_CREDIT** | sqlite ledger entries + wallet 派生缓存 | `IB_CREDIT`（minor，十进制字符串） | store（ledger 是唯一真源） | 三条写面 → 结算事务 | **无** |
| **B · COMPUTE_ENTITLEMENT** | sqlite inventory 行（`assetKind = COMPUTE`） | `computeUnit` | store（inventory 行） | 购买结算 / 显式 grant | **无** |
| **C · provider quota** | **不存在**（Economy 里没有这张表 / 这一列） | — | provider 官网 + 用户 | — | — |
| **D · real money** | **不存在**（闭包里没有支付模块） | — | Bridge + Active | — | — |

四条"无路径"由**四个结构性事实**成立（不是 grep 不到）：

1. `computeExchangeAmount`（唯一的汇率算术）在 Economy 生产文件与装配层里
   **零调用方**；
2. 法币与 provider 计费**不在**币种封闭集里，而且被 39 个 token 逐字否认
   （`USD`/`CNY`/`USDT`/`USDC`/`PROVIDER_BALANCE`/`API_CREDIT` …）；
3. Economy 的 **require 说明符恰好 8 个**（`node:sqlite` / `node:crypto` /
   `node:http` / `crypto` / `fs` / `path` / `./economy-contract.js` /
   `../../runtime/db-failure.js`），没有任何支付 / 凭据 / provider SDK；
4. store 的 schema 里没有任何 `provider_*` / `api_balance` 列。

并且两句话被逐字钉住：**`COMPUTE_ENTITLEMENT` 是 inventory asset，不是
provider quota**（它是 `SETTLEMENT_PRIMITIVES` 的一员，而 `token` /
`providerBalance` 在 `FORBIDDEN_COMPUTE_ALIASES` 里）；**`IB_CREDIT` 是内部
账本计价单位，不是法币、不是稳定币、不可提现**。

---

## §9 · UI authority 审计（§8）

六个浏览器文件（三个纯层 + 三个 DOM 层）逐字段分类：**AUTHORITY 透传 /
PROJECTION / DERIVED / COPY**。规则的可证伪形式与结果：

| 规则 | 断言 | 结果 |
| --- | --- | --- |
| 不自己重算余额 | 六个文件里没有 `availableBalanceMinor ± …` | **0 命中** |
| 不自己判断预算允许 | 没有 `decision === 'ALLOW'/'DENY'` | **0 命中** |
| 不自己判断批准有效 | 没有 `expiresAt <> now` 这类**分支** | **0 命中** |
| 不自己判断报价有效 | 没有 `quoteValid =` | **0 命中** |
| 不自己判断购买成功 | 没有"拿金额推 completed" | **0 命中** |
| 不自己算总价 | 没有 `unitPriceMinor *` | **0 命中** |
| 不用定时器驱动状态 | 没有 `setInterval` / 倒计时 | **0 命中** |
| 结构上拿不到 store | 六个文件里没有 `require` / SQLite / `/internal/economy/` | 成立 |
| 页面自己算的东西被**标明** | `buildSpendingModel` 带 `computedByThisPage:true` | 成立 |
| 只有两类写动作 | 批准决定（恰好三个键）+ 配置（按命令白名单） | 成立 |
| 三态完整 | `complete` / `truncated` / `unknown` 是三个不同的词 | 成立 |
| 不复制契约的**集合** | 没有第二份 `CURRENCIES` / `*_STATES` / `EVENT_TYPES` | 成立 |

**UI authority leak = 0。**

### 9.1 诚实的边界：三处页面自己算的东西

它们是**被声明的** DERIVED，不是泄漏：

1. **「已完成合计」**（`buildSpendingModel`）：把窗口内 `completed` 的购买金额
   相加，带 `computedByThisPage:true`、饱和窗口警告、以及"权威的当日累计在
   「预算」那一格"的说明。它是**第二个**"花了多少"的数字，可能与权威的
   `spentTodayMinor` 不同 —— 代码把两者在视觉上分开。
2. **预算进度条的 `ratio` / `over`**：`used / limit` 的比值与 `used > limit`，
   只用于 `style.width` 与一个 CSS class；没有任何东西在它上面分支。
3. **时间线的完整性**：客户端给自己的读窗口标 `complete` / `truncated` /
   `unknown`。契约**不发送** `completeness`，因此这个判决来自客户端自己的
   分页器 + `unorderable` 计数。它的错误方向是**保守的**（读失败 ⇒ 说
   truncated，不冒充 complete）。

---

## §10 · Fresh install → First Purchase（金路径）

一次真正的 fresh install，从空的 Economy DB 走到 UI 纯层能显示 canonical
最终状态：

```text
Fresh DB（没有钱包 · 没有政策 · 没有购买 · 没有 intent）
  ↓  POST /internal/economy/configuration   BOOTSTRAP_CREDIT        （真实 MINT）
  ↓  POST /internal/economy/configuration   PUT_BUDGET_POLICY
  ↓  POST /internal/economy/configuration   PUT_AUTONOMY_POLICY     （enabled，但阈值 ⇒ REQUIRE_APPROVAL）
  ↓  目录 fixture ★（见下）
  ↓  POST /internal/economy/command         Agent WANT
  ↓  Intent = WAITING_APPROVAL + Approval = PENDING（**不预留任何钱**）
  ↓  GET /economy/autonomy-evaluation       一次**快照**评估（不锁钱、不建记录）
  ↓  POST /internal/economy/approval-decision   APPROVED
  ↓  Resume（经 capability gate 的 RESUME_APPROVED_PURCHASE）
  ↓  Purchase = COMPLETED（一个事务：账本 + 库存 + 批准消费 + 报价消费）
  ↓  Ledger（2 条 entry，Σ DEBIT = Σ CREDIT，金额恰好 10000）
  ↓  Inventory（一行 · 1000 computeUnit · assetKind COMPUTE · **不是**余额）
  ↓  八条 canonical GET
  ↓  UI 纯层 buildPageView（`economy-shell-core.js`）
```

**最终状态的逐条证明**：

| 断言 | 结果 |
| --- | --- |
| 钱包余额变化正确 | `1000000 → 990000`，且 `cachedBalanceMinor === ledgerBalanceMinor`、`cachedBalanceDrifted === false` |
| 账本恰好一笔期望的交易 | 2 条 entry · 平衡 · `state = COMMITTED` · 与 purchase 的 `ledgerTransactionId` 相同 |
| purchase 是终态成功 | `status = COMPLETED` · `terminal = true` · `completed = true` · `amountMinor = 10000` |
| inventory 恰好变化一次 | 1 行 · 1000 · `inventoryEntryId` 与 purchase 一致 |
| intent 终态 | `COMPLETED` · `terminal` · 记着 purchaseId 与 approvalId |
| approval 终态且单次使用 | `CONSUMED` · `consumedByPurchaseId` 指向那一笔 |
| timeline 含相关 canonical revision 且 newest-first | 严格递减 · 含那一次购买的 revision |
| owner 作用域不泄漏 | 另一个 owner 的报价 / 库存记录一条都不在 |
| UI 投影显示 canonical 最终状态 | 余额逐位相同 · 购买 COMPLETED · 资产 1000 · 时间线 owner 一致 |

★ **唯一一处不经过 HTTP 的是目录**（`putStore` / `putProduct`）。这一点是
**显式标记**的：

```text
catalog administration remains intentionally out of v1 public surface
```

配置面的三个命令是封闭的，里面没有任何一个是目录写入（测试逐字断言这一点）。
本阶段**没有**偷偷造一个 Store Admin —— 那是 debt D1（§13）。

---

## §11 · 六条失败金路径（§10）

| # | 路径 | 关键断言 | 结果 |
| --- | --- | --- | --- |
| A | 预算拒绝 | 自主规则故意**宽**（AUTO_ALLOW），因此拒绝只能来自预算；intent 终态 `FAILED`、`purchaseId = null`、理由码属于**预算族**（`AMOUNT_EXCEEDS_PER_TRANSACTION`） | ✔ |
| B | 批准拒绝 | approval 立刻 `REJECTED`；`resumeAttempted = false`；拒绝之后再点头被拒（409）；世界逐字不变 | ✔ |
| C | 批准过期 | 到期用**真实的 `expires_at` 语义**（`now` 越过 `expiresAt`）；之后 APPROVE 被拒；`purchaseId = null` | ✔ |
| D | 报价过期 | quote `EXPIRED`（终态）；批准不绕过报价有效期；`purchaseId = null` | ✔ |
| E | 重复请求 | 同一份输出发两次 ⇒ 通道 `channelReplay:true`、`sameIntent:true`；intent 完成后第三次仍回同一条；世界增量**恰好 1** 笔购买 | ✔ |
| F | 畸形权威注入 | 命令信封里塞 `consumerId` / `capability` / `approved` / `autoAllow` / `amountMinor` / `currency:USD` 全被拒；决定面 `AUTO_ALLOW` 被拒；配置面 `BUY` 被拒；世界逐字不变 | ✔ |

**联合结论**：六条里**恰好一条**（E）产生了一笔购买 —— 那一条本来就是用来证明
"重复请求只买一次"的。账本与库存的增量与它精确对应。

★ 开发期实测踩到的两个"安静地证明错东西"的形状，都写进了测试注释：

1. **把自主上限也压到 100**：判决变成 `AUTONOMY_LIMIT` 而不是预算拒绝 ——
   断言照样"通过"（它也是 DENY），但它证明的**不是**预算那一层。这与 P22-20
   §3 的差分控制组同一个教训。
2. **把报价类别当结算方式**（`allowedSettlementTypes: ['PURCHASE']`）：自主规则
   写入**静默失败**，而规则不存在时权威默认 `REQUIRE_APPROVAL`，于是 fixture
   变成一个"永远等待审批"的场景。封闭集是 `FULFILLMENTS`，不是 `QUOTE_KINDS`。

---

## §12 · 冻结契约清单（§11）与漂移守卫（§12）

`docs/ECONOMY_V1_FROZEN_CONTRACT.md` 是一份**机器可解析的 manifest**，
包含 §11 要求的十二节：`SCHEMA_VERSION` · `READ_SURFACES`（含顺序权威与
owner 作用域）· `WRITE_SURFACES`（含信封 / 词表 / 凭据 / 消费者 /
"可触达的 store mutation"）· `CAPABILITIES` / `CONSUMERS` · `CURRENCIES` ·
`ASSET_KINDS` · `EVENT_TYPES`(52) · `STATE_MACHINES`(6) ·
`EXTERNAL_BOUNDARIES` · `UI_MODULES` · `FUTURE_NOT_PRESENT`。

### 12.1 `FUTURE_NOT_PRESENT` 这 11 个词必须区分"标识符"与"能力"

| Word | status | 它到底在哪里 |
| --- | --- | --- |
| `REFUND` | `identifier-present` | `TX_TYPE.REFUND`（账本交易类型，对预算窗口 NEUTRAL）+ `PURCHASE_HAS_REFUND = false`；**没有**事件类型、操作、路由、UI |
| `EXCHANGE` | `identifier-present` | `EXCHANGE_COMMITTED` 事件类型 + `computeExchangeAmount`（休眠算术，零调用方）+ `EXCHANGE_CROSS_DOMAIN_FORBIDDEN` 拒绝码 |
| `PROVIDER_BILLING` | `identifier-present` | 以 `TOP_UP_PROVIDER` / `PROVIDER_TOPUP` 出现在**否认清单**里 |
| `PROVIDER_QUOTA` | `identifier-present` | 以 `providerQuota` / `providerBalance` 出现在**禁止字段 / 别名**清单里 |
| `REAL_PAYMENT` | `identifier-present` | 以 `SEND_PAYMENT` / `submitPayment` 出现在**否认清单**里 |
| `HUMAN_DIRECT_BUY` | `identifier-present` | `/economy/buy` 在 `unreachable` 名单里；`PURCHASE_EXPOSES_HTTP_MUTATION = false` |
| `STORE_ADMIN` | `identifier-present` | `/economy/store/create` · `/economy/product/update` 在 `unreachable` 名单里 |
| `MERCHANT` | `identifier-present` | `merchant:alipay` / `seller:external` 在 `FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS` 里；`COMMIT_COUNTERPARTIES` 恰好是 `system:treasury` / `system:market` 两个 |
| `PROMOTION` · `DISCOUNT` · `COUPON` | `identifier-present` | 三者都在 `FORBIDDEN_PRODUCT_FIELDS` 里；商品表里没有这些列 |

测试对 `identifier-present` 的每一行断言三件事：标识符**真的存在**（文档不得
过度声称"没有"）· 它**不在**任何 capability / command / decision / event /
route 集合里 · 它的休眠算术**零调用方**。

★ 而 `TX_TYPES` 刻意**不算能力面**：它是账本**词汇**。把词汇表当能力面会制造
一批假命中（`REFUND` / `EXCHANGE` 恰好在里面）—— 与 P22-20 的裸词扫描是同一个
错误。词汇那一侧单独断言：这两个词**只**出现在 `TX_TYPES` 里。

### 12.2 守卫必须报**成员名**

`tests/test_p22_21_economy_v1_freeze.js` 的每一个集合比较都走
`diffSets()`，失败信封里永远是 `newInCode_notInManifest` /
`inManifest_butGoneFromCode` 两个**成员名单**，外加一句 verdict：

```text
Economy v1 frozen contract changed;
declare a new phase/version instead of silently extending v1.
```

并且有**灵敏度自测**（`Y1`～`Y4`）：往能力面注入一个哨兵，断言 diff 逐名报出
它；往 manifest 的**内存副本**里注入一条多出来的事件类型，用**同一个解析器**
再读一遍，断言它同样被逐名报出。上一句如果只能靠读源码来相信，它就不是一条
被执行的规则。

---

## §13 · 已知的、非阻塞的债务

| id | 债务 | 为什么不破坏 v1 的 authority / safety / correctness |
| --- | --- | --- |
| **D1** | 目录（store / product）**没有** production 管理面：`putStore` / `putProduct` 的生产调用方是 0 | 目录只决定"有什么可买"，不决定"能不能买"。它由预算 / 自主 / 每一次结算的闸门约束；空目录的结果是"没有商品"，不是"越权"。金路径因此显式标记它，而不是偷偷造一个 Store Admin |
| **D2** | `/economy/purchases` · `/economy/intents` 是 `created_at ASC` 的**最早**一窗，而 UI 把这一窗称为"近期" | 这是**读窗口的措辞**问题，不是权威问题：窗口满时页面显式说明（`saturated`），余额与预算的权威数字来自另外两条读面 |
| **D3** | 过期扫描（`expireDue*`）**不是定时器**：它由 `open()` 的对账与显式调用驱动 | 到期在**读**侧被如实回答（`expiredByTime` / `EXPIRED` 状态）；fail closed 不依赖扫描是否跑过。store 里连一个 `setInterval` 都没有（测试断言） |
| **D4** | `P22-15C` 是唯一**没有 doc** 的阶段（只有 commit subject） | 它的 production diff 为 0，只改了两条既有测试；v1 的契约面不受影响 |
| **D5** | store 有 **19** 个 `const *_TABLE` 表名常量，`TABLES` 只导出 **16** 项（未导出：`AUTONOMY_POLICIES_TABLE` · `APPROVALS_TABLE` · `PURCHASE_INTENTS_TABLE`） | 纯描述性缺口：三个未导出的表都有独立的、被断言的访问路径。两个数字与三个名字都被测试逐字冻结 |
| **D6** | **批准被拒绝之后，Intent 保持 `WAITING_APPROVAL`**（终态化是**惰性**的，下一次执行时才被判失败） | 它**不能**产生任何经济事实：approval 是终态 `REJECTED`（单次使用），再点头被 409 拒绝，propose 重发只回同一条 intent，世界逐字不变 —— 三条都真跑过。而 intent 的 state 在契约里**自述**是"编排事实，不是经济事实"（`stateIsAnEconomicFact: false`）。★ 它仍然是一条债务：一个"等待审批"的 intent 配一条终态批准，读起来会让人以为还有事要发生 |

D6 是本阶段**新发现**的唯一一条语义债务。它不构成 blocker（fail closed 已被
三条真实路径证明），因此本阶段**不修改生产代码** —— 记住这条纪律：本阶段默认
production diff = 0，只有"真实、可复现、会破坏已声明 invariant"的缺陷才允许改。

---

## §14 · 最终分类

# **B · CLOSED WITH DOCUMENTED NON-BLOCKING DEBT**

理由，逐条对应 §13：

* **internally consistent** —— 22 个 authority 各恰好一个定义点（C = 0），
  没有一个孤儿（D = 0）；五个封闭词表只有一个真源；P22-1 冻结的域标记与 id
  形状到今天逐字未变。
* **authority-closed** —— 39 个经济 mutation 动词全部被分类：生产可达 7 /
  内部编排 32 / tests-only 0 / dead 0 / **suspicious bypass 0**；真实的
  83 条调用边里，八类 shortcut edge 全部为 0。
* **read-write-separated** —— 28 条 `GET /economy/*` + 1 条 `/security` 与
  两份文档**三向一致**；`http.js` 对经济 mutation 动词零调用；三条写面全部
  不在 `/economy/` 下，因此"`POST /economy/*` 一律 405"是结构性的。
* **externally isolated** —— require 说明符恰好 8 个；法币 / provider 计费 /
  真实支付 / 商户全部**没有路径**（四条结构性证明）；四条 shortcut 边为 0。
* **整体** —— fresh install 能走完一次真实的 Economy 金路径（含审批腿），
  七层重放之下世界逐字不变，六条失败金路径全部 fail closed。

**为什么不是 A**：D1～D6 六条债务里，D2（读窗口措辞）、D6（拒绝后 intent 的
惰性终态）是**真实的观察**，把它们说成"没有"就是把 audit 写成宣传。它们不破坏
authority / safety / correctness（每一条都给了理由与证明），因此是 B 而不是 C。

**为什么不是 C**：没有任何一条债务会让一个**越权**的经济事实成立，也没有任何
一条会让 fail closed 失效。

---

## §15 · Stop Gate 逐条回答

| # | 问题 | 回答 |
| --- | --- | --- |
| 1 | P22-1～20 是否存在 authority 重叠或 orphan？ | **没有**。22 个权威各恰好一个定义点（C = 0）；每一个 owner 符号都被生产代码引用（D = 0）。文件被多阶段共享（http.js 12 个阶段）**不是**权威重复 |
| 2 | canonical write path 是否只有已登记路径？ | **是**。恰好三条公开写面 + 那七个生产可达的 store 动词；suspicious bypass = 0 |
| 3 | canonical read path 是否与文档逐条一致？ | **是**。代码 ↔ manifest：双向差 0；manifest ↔ `ECONOMY_PUBLIC_SURFACE.md`：双向差 0 |
| 4 | Intent/Approval/Purchase/Quote 状态组合是否闭合？ | **是**。7 个真实观察到的组合全部在结构上界内；6 个禁止候选逐条证伪；unknown = 0 |
| 5 | exactly-once 是否从 producer 一直到 inventory 成立？ | **是**。七层重放之后购买数 1 / 库存 1000 / 账本 delta 0；没有第二套 dedupe |
| 6 | transaction/crash 边界是否不存在半完成经济事实？ | **是**。一次结算 = 恰好一个事务，六样写全在同一个 `BEGIN IMMEDIATE` 里；`COMMIT` 只出现在 `withTransaction` |
| 7 | 四种资源是否仍严格隔离？ | **是**。四条"无路径"由四个结构性事实证明；`COMPUTE_ENTITLEMENT` 是 inventory asset；`IB_CREDIT` 是内部计价单位 |
| 8 | UI 是否仍只是 authority projection？ | **是**。六条泄漏形态零命中；三处页面自己算的东西被显式标明 |
| 9 | Fresh DB 能否走完一次真实 Economy Golden Path？ | **能**。含审批腿，且最终状态九项逐条证明 |
| 10 | 六条 Failure Golden Path 是否 fail closed？ | **是**。六条全过，且联合增量恰好等于那一条允许成功的购买 |
| 11 | owner-scoped read model 是否仍正确？ | **是**。交错噪声下不泄漏、desc 严格递减、分页取最新一段、`recomputesEconomyFacts:false` |
| 12 | External Boundary 是否仍冻结？ | **是**。八个 require 说明符、零支付/凭据/provider 模块、`COMMIT_COUNTERPARTIES` 只有两个 system 对手方 |
| 13 | Economy v1 manifest 是否与生产代码机器一致？ | **是**。51 条断言逐表比对，含守卫灵敏度自测 |
| 14 | production diff 是多少？ | **0 行**（`git status` 里只有 `tests/test-all.js` 的测试登记改动） |
| 15 | schema version 是否仍为 7？ | **是** |
| 16 | 是否新增 route/capability/event/schema？ | **都没有**（各 0） |
| 17 | child/spawn/browser/socket/leftover？ | freeze 与 closure audit：全 0（纯 Node 静态 + 真实 store，不 open 任何 socket）。golden path：child **0** · spawn **0** · browser **0** · 两个实例按顺序创建/关闭，任一时刻恰好 **1** 个 socket（整轮共 2）· 结束时仓库相关的 node 进程 **0** · 临时目录残留 **0**（见 §16.2）· 仓库新增 PNG **0** |
| 18 | 最终分类 A/B/C 是什么？为什么？ | **B**。见 §14 |

---

## §16 · 提交与产出

```text
d3be80d  P22-21 . freeze Economy v1 contract
```

（提交名里的分隔符与 P22-20 的 `P22-20 . freeze Economy external boundaries`
同款：`·` 是这个仓库文档里的分隔符，commit subject 用 `.`。）

新增文件：

* `docs/ECONOMY_V1_FROZEN_CONTRACT.md`（§11 机器可解析 manifest）
* `docs/P22-21-ECONOMY-V1-CLOSURE.md`（本文件）
* `tests/test_p22_21_economy_v1_freeze.js`（§12 漂移守卫 · 51 条断言）
* `tests/test_p22_21_economy_golden_path.js`（§1/§5/§9/§10 · 57 条断言）
* `tests/test_p22_21_economy_v1_closure_audit.js`（§0/§2/§3/§4/§6/§7/§8 · 40 条断言）

修改文件：`tests/test-all.js`（登记三条新测试）。

**production diff = 0。**

### 16.1 测试与资源

| 测试 | 断言 | child | spawn | browser | socket |
| --- | --- | --- | --- | --- | --- |
| `test_p22_21_economy_v1_freeze.js` | 51 | 0 | 0 | 0 | 0 |
| `test_p22_21_economy_golden_path.js` | 57 | 0 | 0 | 0 | 1（任一时刻） |
| `test_p22_21_economy_v1_closure_audit.js` | 40 | 0 | 0 | 0 | 0 |
| **合计** | **148** | | | | |

`node tests/test-all.js --quick`：static **112 项** 全部通过 ·
p22-ui **17 项** 全部通过（P22-21 之前是 14 项）。

### 16.2 一个真实踩到的资源纪律问题（本阶段顺手修好）

P22-21 的三条测试一开始把临时目录的清理**只**挂在 `process.on('exit')` 上。
开发期实测：在 `process.exit()` 的那一刻 SQLite 的文件句柄仍然开着，Windows
会拒绝删除（EPERM），于是**每一次运行都留下一个
`ib-p22-21gp-install-*` 目录** —— 也就是说"临时目录 = 0"这句话在那之前是假的。

修法是两条：

1. 收尾用**装配层自己的** `close()`（`buildHomeNode` 的导出），而不是只关
   economy store：同一个 dataDir 上还有 chat / memory / moments / registry
   的 SQLite 句柄；
2. **句柄关掉之后**才调 `cleanupTempDirs()`（多轮退避重试），`exit` 上的那一份
   降级为兜底。三条测试现在都会在收尾时打印"临时目录：残留 N 个（目标 0）"。

★ 顺带记一条**更大范围**的观察（不是本阶段引入的）：`%TEMP%` 下还留着
**P22-2 ～ P22-20 各阶段**运行时的 `ib-p22-*` 目录（数量以百计）。那是既有的
模式，不是 P22-21 的产出；本阶段没有删它们（它们不是本阶段的产物，也不是
仓库里的文件），只把自己那 18 个清零。
