# P22-14 · Economy Bootstrap / Admin Configuration

> 阶段目标（逐字）：
> **让一个 fresh install 在不改代码、不直接操作 SQLite 的情况下，可以安全完成
> Economy 的初始配置：初始 IB Credit、Budget Policy、Autonomy Policy。**
>
> 本阶段**不进入 UI**。

```text
基线     6c541e2  P22-13 · add Economy approval decision path
本阶段   P22-14 · add Economy bootstrap and configuration path
状态     P22-1～14 · Economy Backend Core v1 = CLOSED
         （fresh-install 可配置性缺口已闭合）
```

---

## 1 · 只读审计：这一阶段到底缺哪一段

审计结论全部来自读代码，没有一条来自提示词假设。

### 1.1 三个动词在生产代码里的调用方

| 动词 | 生产调用方 | 位置 |
|---|---|---|
| `mintForSystem` | **0** | 只在 `tests/` 与 `tests/fixtures/` |
| `putBudgetPolicy` | **0** | 同上 |
| `putAutonomyPolicy` | **0** | 同上 |

这与 P22-12C 对 `decideApproval` / `resumeAgentPurchaseIntent` /
`resumeApprovedPurchase` 的结论**同形**：运行时**有**，生产路径**没有**。
于是默认部署（`AUTONOMY_DEFAULT_WHEN_NO_POLICY = REQUIRE_APPROVAL`）下，
一个全新的库既没有余额、也没有预算政策、也没有自主政策，而把它配起来需要
人工打开 SQLite 或写一段脚本直接 require store。

### 1.2 复用的既有面（**没有**新造任何一套）

| 既有面 | 位置 | 本阶段如何用它 |
|---|---|---|
| HTTP transport | `services/home-node/http.js` | loopback 限制 + 桌面凭据（`X-IB-Home-Token` / `Bearer`，恒定时间比较）+ `/internal/` 桌面面归类 + 有界 body + 统一错误信封 |
| 桌面凭据 | `IB_HOME_NODE_TOKEN`（与 P22-13 同一个键） | 调用者身份的**唯一**来源 |
| `/security` introspection | `http.js` 的 `economyPolicy` | 加一节 `configuration`（**加法**） |
| 幂等机制 | `commitLedgerTransaction` 的账本幂等表 + `economy_meta` | 重试 exactly-once 与一次性事实 |
| 预算评估器 | `C.evaluateBudgetFor` / `putBudgetPolicy` | 一个字不改 |
| 自主评估器 | `C.evaluateAutonomousPurchase` / `putAutonomyPolicy` | 一个字不改 |

**没有新造**：Admin RPC framework、generic Economy mutation API、
`execute(method, args)`、通用 `store[...]` 分派。

### 1.3 一次性的正确落点：`economy-store.js`（**没有 schema 变更**）

§3 的硬要求是"初始化额度不能被同一个入口无限重复调用"。审计后的选择：

* **账户**：`economy_meta` 表（P22-1 起就存在，承载 `economy_schema` /
  `economy_revision` / `economy_engine_state`）。它是 **canonical、持久、
  跨重启**的 —— 因此"发过了"不是一个进程内 Set。
* **身份**：进账本幂等表的 key **不是调用方给的**，而是**派生**的
  `bootstrap-credit:<ownerId>:<partyType>:<currency>`。
* **结果**：marker 行的值里存着完整的 canonical 结果（walletId /
  transactionId / amount / at / revision），因此**即使账本幂等行被 TTL 或
  条数上限回收**之后，重放仍然能返回当初那条交易。

⇒ **schema version 不变（7）**，**没有 migration**，**没有新表**。

---

## 2 · 生产文件

```text
new      services/home-node/economy-configuration.js      （第七个 Economy 生产文件）
modified services/home-node/economy-store.js              （+bootstrapInitialCredit / +getInitialCreditBootstrap）
modified services/home-node/economy-action-adapter.js     （LOW_LEVEL_ECONOMY_VERBS +1）
modified services/home-node-service.js                    （装配 + 两条启动路径的导出）
modified services/home-node/http.js                       （一条新路由 + /security 一节）
```

`economy-configuration.js` 的依赖**只有两个**（与 P22-13 逐字同源）：

```text
node:crypto                    恒定时间凭据比较（第三处，同一个用法）
./economy-contract.js          币种 / 幂等键 / 政策校验的规范
```

它**不** require store、不 require 门、不 require 适配器、不开服务器、
不起定时器、不开端口、不发请求（`B3.7d` 逐字断言）。

---

## 3 · 生产面（唯一一条新路径）

```text
POST /internal/economy/configuration
```

信封印封**恰好三个键**：

```text
command         BOOTSTRAP_CREDIT | PUT_BUDGET_POLICY | PUT_AUTONOMY_POLICY
config          该命令自己的 canonical 用户可配置字段
idempotencyKey  这一次配置动作的 canonical 幂等身份
```

每个命令的 `config` 白名单（这些**全部**是 store 三个入口签名的字段）：

```text
BOOTSTRAP_CREDIT      ownerId · currency · amountMinor
PUT_BUDGET_POLICY     ownerId · currency · limits · termEndsAt · autonomyLevel · ifRevision
PUT_AUTONOMY_POLICY   ownerId · enabled · perPurchaseLimitMinor · dailyAutonomousLimitMinor ·
                      approvalAboveMinor · allowedProductKinds · allowedSettlementTypes ·
                      allowGift · ifRevision
```

**被禁止的**（不是"被过滤"，是**不在词表里**）：`BUY` · `SETTLE` ·
`RESERVE` · `GRANT_INVENTORY` · `APPROVE` · `REJECT` · `REFUND` · `EXCHANGE` ·
`PROVIDER_TOPUP` · `REAL_PAYMENT` · `RAW_LEDGER_WRITE` · `MINT` ·
`OPEN_WALLET` · `TRANSFER`。未知命令 ⇒ `404 UNKNOWN_COMMAND`（fail closed）。

**被禁止的权威字段**（`§4`）：`currentBalance` · `spentToday` · `allow` ·
`decision` · `approval` · `price` · `ledger` · `ledgerState` · `balance` ·
`reserved` · `spent` · `status` —— 一个都不在 config 白名单里。

**被禁止的身份键**（21 个，逐名拒绝且**不触碰 store**）：`actor` · `caller` ·
`callerId` · `consumer` · `consumerId` · `capability` · `role` · `authority` ·
`admin` · `isAdmin` · `system` · `systemInitiated` · `approved` · `autoAllow` ·
`party` · `decidedBy` · `userId` · `agentId` · `sessionId` · `token` ·
`desktopToken`。

`ownerId` **不在**这份名单里，而且这个例外有理由：它是**配置目标**，不是
调用者身份。它无法提权 —— 它能做的只是让权威去校验另一个 owner 的存在性，
而 unknown owner 在 store 里被拒（`owner-not-found`）。owner 的**类型**不是
独立输入位：裸字符串经契约的 `makePartyRef` 提升（`'user' → user:user`，
其余 → `character:<id>`）。

---

## 4 · 初始 IB Credit（§3）

### 4.1 唯一入口

```text
POST /internal/economy/configuration  { command: 'BOOTSTRAP_CREDIT', config: {...} }
   ↓
economyConfiguration seam（凭据判定 · 信封校验 · 币种收窄）
   ↓
store.bootstrapInitialCredit({ owner, currency, amountMinor, idempotencyKey })
   ↓  一个事务
① 读一次性 marker（事务内再读一次：BEGIN IMMEDIATE 之后写锁已持有）
② openWallet（同一个 (owner, currency) 恰好一个钱包；它是**嵌套**事务，
   内层不 COMMIT —— 因此"钱包建出来"与"初始额度铸出来"共享同一个
   atomic boundary）
③ systemTransfer('MINT', …) ——— 唯一一条到账本的边
④ 写 marker（canonical 一次性事实 + 结果）
⑤ appendChange(ECONOMY_INITIAL_CREDIT_BOOTSTRAPPED)
```

### 4.2 逐条满足 §3

| 要求 | 实现 |
|---|---|
| 只允许 `IB_CREDIT` | seam 收窄到 `C.CURRENCY.IB_CREDIT`（契约的币种 register 有 **6** 个成员，它们都是合法 Economy 币种 —— 所以"只有 IB_CREDIT"是**本阶段对初始额度的定义**，不是"store 已经管了"）。真实货币（`USD` 等）在契约的 `FORBIDDEN_CURRENCY_TOKENS` 里被逐字否认 |
| amount 用既有 minor-unit 契约 | `C.normalizeAmountMinor`（非负、上界、拒绝 `'1.0'` / `1.5` / `-5`） |
| amount ≥ 0 | 同上（`amount-minor-negative`） |
| 不能指定任意 ledger debit/credit account | config 里**没有** `debitAccountId` / `creditAccountId` / `accountId` 这些输入位 |
| 不能伪造 transactionId | config 里没有 `transactionId`；交易 id 由 `nextId('TRANSACTION')` 生成，且重放返回**当初那条** |
| 不能写 raw ledger entry | 没有 `ledgerEntryId` / `entries` / `direction`；唯一到账本的边是 `systemTransfer` |
| 不能产生 Provider quota | 依赖闭包里没有任何 provider 面（`B3.5`/`B3.7` 逐字断言） |
| 不能产生真实货币 | 币种在契约层被逐字否认；返回值自述 `isRealCurrency: false` |
| 重试 exactly-once | 见 §4.3 |

### 4.3 一次性与重试（§10）

```text
第一次            → ok, creditMinted: true（一条 canonical MINT）
response 丢失后重发同 key  → replayed: true + **同一** transactionId，余额不翻倍
换一个 idempotencyKey、同金额 → 同一笔逻辑交易（身份是派生的，调用方给不了第二个）
换一个 idempotencyKey、换金额 → 409 INITIAL_CREDIT_ALREADY_BOOTSTRAPPED
重启之后同 key 重发       → 同一笔交易
重启之后换金额           → 仍然 409
```

**为什么"换一个 key 再来"是重放而不是拒绝**：本函数**不用**调用方给的 key
做身份 —— 真正的身份是派生的 `bootstrap-credit:<owner>:<currency>`。于是
第二次调用手里**根本没有第二个身份可用**，它在结构上只能是一次重放。
调用方给的 key 逐字留在回答里（`result.requestedIdempotencyKey`），它是
**这一次请求**的证据，不是它的身份。

**为什么还需要 marker 行**（①已经够了？）：① 依赖账本幂等行，而幂等行会被
**回收**（`IDEMPOTENCY_TTL_MS` / `IDEMPOTENCY_MAX`）。回收之后同一个 key 会
变成"从未见过"，那时 ① 就悄悄失效了。`economy_meta` 行是**永久**的。

`B5` / `G3` / `G4` / `G5` / `G6` / `G7` / `G8` / `F1` / `F2` / `F3` 是这一节
的机器可读形式。

### 4.4 它**不是** `mintForSystem` 的别名

```text
mintForSystem             通用系统原语：无限次、任意金额、任意 wallet
bootstrapInitialCredit    这个 owner 的初始额度，恰好一次
```

两者并存而且实现不同（`G13` 逐字断言）。把前者挂到配置面上正是 §3 禁止的
`POST /mint { ownerId, amount }`。

---

## 5 · Budget / Autonomy（§4 / §5 / §11）

* 两个命令**都**走 canonical 的 `putBudgetPolicy` / `putAutonomyPolicy`：
  **没有**第二份评估器，**没有**第二份大小关系检查。
* 它们是**版本化更新**，不是一次性：revision 逐次累加，`ifRevision` 是可选
  的乐观并发，幂等键分别走 `POLICY` / `AUTONOMY_POLICY` scope。
* 坏配置 **fail closed**，而且**不**被"自动修正"成另一个策略：
  本层把 store 的拒绝**原样透出**（`downstreamReasonCode` 优先于本层归类）。
* 自主策略仍然**不能**绕预算：`AUTO_ALLOW` 只是许可（`grantsBudget: false`、
  `notABudgetDecision: true`），预算仍由 P22-4 独立执行；`H5` 用 canonical
  评估器逐字证明"超额度 / 超当日 ⇒ 不是 AUTO_ALLOW"。
* 大小关系（`C6` 逐条实测）：

```text
approvalAbove ≤ perPurchase ≤ daily        （approvalAbove 缺省 = perPurchase）
```

### 5.1 一个被撤销的坏配置假设（诚实记录）

第一版 `C6` 把"缺一档额度"当成坏配置（`limits: { perTransactionMinor: 3× }`）。
那是**错的**：在 P22-4 的契约里 `null` 逐字等于"该档不启用"
（`normalizePolicyLimits` 的既有语义），因此那是一个**合法**配置，而
断言在它上面会变成一句假话。改成六个**真正非法**的输入（负数 / 小数 /
字符串 / 未知限额键 / cooldown 非整数 / limits 不是对象）。

---

## 6 · 与 P22-13 的分权（§8）

```text
/internal/economy/command             Agent WANT        （来源凭据 · 按端口登记）
/internal/economy/approval-decision   User DECISION     （桌面凭据 · APPROVE/REJECT）
/internal/economy/configuration       User CONFIGURATION（桌面凭据 · 三个命令）
```

三条路径的机器可读关系（`E1`–`E5` / `C8` 逐条断言）：

| 断言 | 值 |
|---|---|
| 配置命令 ∩ 决定词 | 空集 |
| 配置信封 ∩ 决定信封 | 只有 `idempotencyKey` |
| 决定信封送进配置面 | `400 UNEXPECTED_ENVELOPE_KEYS`，**没碰 store** |
| 配置信封送进决定面 | `400 UNEXPECTED_ENVELOPE_KEYS`，**没碰 store** |
| 配置面能批准/续做/结算 | `false` / `false` / `false`（自述位 + 源码逐字） |
| 决定面能 mint / 改预算 / 改自主 | 否（它的 store 视图**只有一个键** `decideApproval`） |

**为什么不合并成"万能 user command endpoint"**：那会让"允许 Agent 自主花
多少钱"与"批准这一笔"在审计里变成同一件事 —— 而它们恰好是 §2 明令区分开的
两种权威（配置权 vs 决定权）。

---

## 7 · Store 视图：结构性隔离

```text
P22-13  approval seam  ← Object.freeze({ decideApproval })
P22-14  config seam    ← Object.freeze({ bootstrapInitialCredit, putBudgetPolicy, putAutonomyPolicy })
```

因此在这两个文件里 `mintForSystem` / `burnForSystem` /
`commitLedgerTransaction` / `openWallet` / `reserveFunds` /
`settlePurchase` / `preparePurchase` / `mutateInventory` / `grantInventory` /
`transferBetweenWallets` / `decideApproval` / `resumeAgentPurchaseIntent`
**不存在** —— 不是"被过滤"，是**没有那个成员名**。
也**没有** `store[...]`、`handler[action]`、`executeEconomyAdminAction(...)`。

---

## 8 · `/security`（§12）

`economyPolicy` 新增一节 `configuration`，让下面四件事**机器可判定**：

```text
ordinary /economy/* HTTP writes   = 0                                （既有 httpVerbs: ['GET'] + writesExposed: []）
Agent command surface             = PROPOSE only                     （既有 commandChannel 三个空名单）
Approval surface                  = APPROVE / REJECT only            （既有 approvalDecision 两词）
Configuration surface             = BOOTSTRAP_CREDIT,
                                    PUT_BUDGET_POLICY,
                                    PUT_AUTONOMY_POLICY              （本节 configurationCommandsExposed）
```

新增字段（每一句都是"把已经发生的事实写成字段"）：

```text
configurationWritesThatAreNotOneOfThoseThree: []    恒为空
configurationCannotDecideAnApproval:         true
approvalDecisionCannotConfigure:             true
sharesACommandWithTheApprovalDecisionSeam:   false
sharesAnEnvelopeWithTheApprovalDecisionSeam: false
exposesMintForSystem:                        false
exposesGenericDispatch:                      false
isAnAgentAuthority / isAPurchaseAuthority / isAPaymentAuthority: false
configurationTouchesProvider / configurationTouchesPayment:      false
configurationWritesRawLedgerEntries / canForgeATransactionId /
canChooseLedgerAccounts:                     false
initialCreditIsOneShot:                      true
initialCreditOneShotLivesInTheCanonicalStore: true
budgetPolicyIsAVersionedUpdate / autonomyPolicyIsAVersionedUpdate: true
```

`open: false`（未配置凭据 / 未装配）时两个名单**都是空的**：不可达的写面与
可达的写面在审计里必须是两个答案。

---

## 9 · 开发期抓到并修掉的三个真实缺陷

### 缺陷 1 · 派生的幂等键里有一个契约不接受的字符

第一版的派生身份写成 `bootstrap-credit:<owner>|<type>:<currency>`，而契约的
`IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:+-]{1,200}$/` **不接受 `|`**。
症状：每一次 bootstrap 都以 `idempotency-key-not-canonical` 被拒 —— 一个
"派生出来的标识符自己不合契约"的错误，而且它只在 G 组第一次跑时才现形。
修法：分隔符改成契约既有的 `:`。

### 缺陷 2 · marker 里读错了一层（`alreadyBootstrappedAmountMinor` 恒 undefined）

marker 行是**两层**结构（canonical 事实在外层，store 的 `result` 在
`result` 里），而拒绝分支一度写成 `alreadyBootstrappedAmountMinor:
prior.amountMinor` —— 于是它**恒为 undefined**。这与 P22-7 在 `denial()`
里修过的 `.detail` 恒 undefined **形状同源**：拒绝发生了，但"被拒的那笔金额
是多少"消失了。修法：取值必须逐字落在 `prior.amountMinor`（外层）上，而且
返回值自己会被 `g4` 断言。

### 缺陷 3 · 每一类 store 拒绝都被说成 409 Conflict

第一版 `storeRefusal` 写成 `outcome.denied === true ? 409 : 400`，而 store 把
"你这份配置根本不成形"也标成 `denied`
（`C.DENY_REASON.POLICY_INPUT_NOT_STRUCTURED`）—— 于是一个**畸形请求**
回答 `409 Conflict`。那是接口在**说错话**：409 的语义是"你的请求没问题，
是当前状态不允许"，而 400 是"你的请求本身不成形"。调用方会因为 409 去
重读状态，而它真正该做的是改 payload。

修法：按理由**分类**（`statusForRefusal`），名单逐字取自 store 自己的拒绝码：

```text
POLICY_NOT_FOUND / PRODUCT_NOT_FOUND                     → 404
POLICY_INPUT_NOT_STRUCTURED / INVALID_CURRENCY /
INVALID_AMOUNT / CATALOG_INPUT_NOT_STRUCTURED            → 400
INITIAL_CREDIT_ALREADY_BOOTSTRAPPED / TRANSITION_NOT_ALLOWED /
APPROVAL_EXPIRED / AUTONOMY_NOT_PERMITTED                → 409
未登记的拒绝码                                            → 400（保守）
```

---

## 10 · §9 Fresh-install closure（本阶段最重要的证明）

`tests/test_p22_14_economy_bootstrap_runtime.js` 从**真正的空 Economy DB**
开始，全程真实 `buildHomeNode` + 真实 HTTP + 真实 SQLite：

```text
fresh DB（wallets/policies/purchases/intents/transactions 全为空）
  → POST /internal/economy/configuration  BOOTSTRAP_CREDIT      → 一条 canonical MINT
  → POST /internal/economy/configuration  PUT_BUDGET_POLICY
  → POST /internal/economy/configuration  PUT_AUTONOMY_POLICY
  → GET  /economy/wallet · /economy/policy · /economy/autonomy-policy   读回 canonical state
  → POST /internal/economy/command        ECONOMY_PROPOSE_PURCHASE
       （真实 Active 来源凭据 + **登记的来源端口**）
  → P22-10 → P22-9 → P22-8 → P22-7 → P22-6
  → GET  /economy/purchases · /economy/intents · /economy/wallet · /economy/transaction
       （购买 COMPLETED、intent COMPLETED、余额少了 10000、账本两端平衡）
  → 重启（同一个 dataDir 上重新装配）⇒ 一次性仍然成立、政策仍然可改、状态逐字还在
```

### 10.1 一条必须说出来的边界：货架与商品**不**在配置面上

§2 的"它只能配置"是一份**封闭清单**（初始额度 / 预算 / 自主），目录不在其中。
因此 runtime 测试显式说明它用 store 的内部 API 种了**货架与商品**，而不是
假装目录也走配置面。目录的写入口是**未来的** Economy admin/policy 阶段的事；
本阶段**不偷偷扩词表**。

⇒ 因此 `D1` 的那两行是**有意**留在 store 内部 API 上的，而 §9 的重点
（"不改代码、不碰 SQLite、不调用测试专用 store 方法把 fresh install 配到
可运行"）由 `A`–`C` 与 `F` 组逐字覆盖。

### 10.2 为什么一个子进程都不开（§14）

本阶段新增的是**一条 HTTP 路径**与**一条一次性规则**：

* "一条 HTTP 路径真的可达"由**本进程内**真实监听 socket 的 server + 真实
  fetch 回答；
* "重启之后 one-shot 仍然成立"由**同一个 dataDir 上重新装配一次**
  回答 —— 那不是模拟重启，那就是重启（目标产物是一个**临时** dataDir，
  按定义新进程会看到同一个库）。

资源账：`max concurrent child = 0` · `total spawn = 0` · `leftover = 0`。
**没有**重跑 P22-6～P22-8 的 crash/race matrix。

---

## 11 · 上游契约改动的逐条说明

### 11.1 store 的新增导出

```text
bootstrapInitialCredit      一次性初始额度（唯一入口）
getInitialCreditBootstrap   只读的一半：这个 owner 的初始额度发过了没有
```

P22-1～P22-13 的**既有导出逐字不变**（`G13` 断言）。schema 版本不变（7）。

### 11.2 `LOW_LEVEL_ECONOMY_VERBS` +1

`economy-action-adapter.js` 的"认出传进来的是不是 store"名单加上了
`bootstrapInitialCredit`。理由：那份名单的用途是**认出 store**，而不是列一份
历史遗留；store 多了一个成员而名单没跟上，那道构造期防线就会出现一个它认不
出来的 store。

### 11.3 `PRODUCTION_FILES` 与依赖闭包的加法

| 位置 | 旧 | 新 | 为什么这是加法而不是放松 |
|---|---|---|---|
| `test_p22_1_economy_boundary.js` `B2.1` | 6 个生产文件 | 7 个 | 新文件被**逐字点名**，而且 `B15.1` 断言它没有一张表 |
| `B3.7` / `B15.2b` `node:crypto` | 2 处 | 3 处 | 第三次是**同一个用法**（桌面凭据的恒定时间比较），`B3.7d` 逐字断言它没有 http / net / listen / 定时器 |
| `B15.2` require 条目数 | 10 | 12 | **目标集合一个成员都没变**（仍然只有契约、node:sqlite、db-failure、crypto、http） |
| `B4.2` 装配层允许的 economy require | 5 处 | 6 处 | 新的一处是配置 seam，它必须在装配层成形（store 视图恰好三个键） |
| `test_p22_10` `A6` | 5 个 | 6 个 | 同上 |
| `test_p22_12` `E10` / `test_p22_6` `K6` | 6 个文件 | 7 个 | "封闭集合，任何新增都必须显式承认" |
| `test_p22_4` `A2` / `test_p22_5` `A2` / `test_p22_6` `A2` | 剥注释前判 | 剥注释后判 | 与 P22-1 `B3.7` 同款纪律：被禁止的是**引用**，不是**解释**。装配层必须能说明"结算 / 库存的写入口不在任何 seam 上"，而那句说明里当然会写出那个成员名 |

`test_p22_4` 的 `A2` 还被写得**更准确**了：它现在断言
`putBudgetPolicy: economyStore.putBudgetPolicy` 这一种**具名交付**形态恰好
出现一处（而不是"这个名字不出现"），因为 P22-14 的配置面确实需要那份视图。

### 11.4 一个**没有**改的东西

`P22-13` 的 approval seam、`P22-11` 的 command channel、P22-1～P22-12 的
canonical 契约（除上面那条**加法**）**一个字都没有变**。Backend Core v1 的
冻结契约没有被解冻。

---

## 12 · Stop Gate 的逐条回答

| # | 问题 | 答案 | 证据 |
|---|---|---|---|
| 1 | fresh install 能否不改代码完成初始 Economy 配置？ | **YES** | `test_p22_14_economy_bootstrap_runtime.js` A–D 组 |
| 2 | 初始 IB Credit 是否只能 bootstrap 一次，且 retry 不翻倍？ | **YES** | `B4` / `B5` / `G3`–`G8` / `F2` / `F3` |
| 3 | 是否不存在通用 mint / raw ledger 写入口？ | **YES** | `A6`–`A9` / `D6` / `G2` / `G14` / `F2` |
| 4 | Budget Policy 是否仍由 canonical evaluator 决定结果？ | **YES** | `C6` / `H1` / `H3`（`putBudgetPolicy` + `C.evaluateBudgetFor` 一个字未改） |
| 5 | Autonomy Policy 是否仍不能绕 Approval/Budget？ | **YES** | `H4` / `H5` / `E4` |
| 6 | Agent 是否不能调用 configuration seam？ | **YES** | `C9`（来源凭据在传输层 401）+ `C7`（自报身份 403 且没碰 store） |
| 7 | Approval seam 与 configuration seam 是否完全分权？ | **YES** | `E1`–`E5` / `C8` / `E4`（`/security` 四个字段） |
| 8 | 是否仍然无法触碰 Provider billing/quota 与真实支付？ | **YES** | `A9` / `G1` / `G2` / `B6` |
| 9 | 普通 `/economy/*` write 是否仍为 0？ | **YES** | `F3` / `E1`（十二条写形态真实 405）/ `E4` |
| 10 | restart 后 bootstrap one-shot 是否仍成立？ | **YES** | `F1` / `F2` / `F3` |
| 11 | fresh DB → configured → existing purchase chain 是否真实可达？ | **YES** | `D2` / `D3` / `D4` |

---

## 13 · 测试

```text
tests/test_p22_14_economy_configuration.js        61 checks   单进程 · 无 HTTP · 真实 SQLite
tests/test_p22_14_economy_bootstrap_runtime.js    34 checks   真实 buildHomeNode + 真实 HTTP + 重启
```

资源账（两份都是）：

```text
max concurrent child   0
total spawn            0
leftover child         0
```

---

## 14 · 冻结事实（供后续阶段引用）

```text
用户配置本节点 Economy 的唯一生产入口是 POST /internal/economy/configuration
（services/home-node/economy-configuration.js，第七个 Economy 生产文件），
信封恰好 { command, config, idempotencyKey }，命令恰好三个
（BOOTSTRAP_CREDIT / PUT_BUDGET_POLICY / PUT_AUTONOMY_POLICY）。
初始额度一次性由 store 的 bootstrapInitialCredit 持有：身份是**派生**的
bootstrap-credit:<owner>:<partyType>:<currency>，一次性事实是 canonical 的
economy_meta 行（schema 不变，永久，跨重启），因此"换一个 key 再 bootstrap"
在结构上等于重放，而"换一个金额"是 409。配置面与 P22-13 的决定面是两种权威：
不共用命令、不共用信封，也不能互相调用。
```
