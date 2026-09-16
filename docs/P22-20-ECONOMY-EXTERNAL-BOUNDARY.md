# P22-20 · Economy External Boundary Audit

> 基线：**P22-19 · `e0e9b8f`**。
> 本阶段**不新增任何 Economy 能力**，也不实现 Exchange / Refund / Payment。
> 它回答一个问题：**Economy Core 今天到底和外部世界隔离到了什么程度。**
>
> 结论一句话：**它已经隔离到"结构性不可能"的程度**，而且这个"不可能"不是一句
> 承诺 —— 它由 96 条机器断言、一个把支付模块**真的做成可解析**的注入实验、
> 以及一次对真实 HTTP 面的穷举证明。
>
> 提交名因此是 `P22-20 · freeze Economy external boundaries`（**审计**），
> 不是 `close ... leak`：本阶段没有发现需要修的边界漏洞。
> 生产代码 **0 行改动**。

---

## 0 · 审计方法

三条方法上的纪律贯穿全文，它们各自对应一次**真实踩到的坑**：

1. **"存在"由证据决定，不由名字决定。** 矩阵里每一行的"有 / 没有"都要在真实
   文件里找到逐字证据（文件 + 字符串），找不到就红。测试 `A1`/`A2` 负责这件事，
   而且 `A2` 是一条 canary（把一条**确实存在**的证据放进去，扫描器必须找到它）
   —— 一个永远返回"没找到"的扫描器会让整张矩阵变成一片假绿。

2. **`require` → `function call` → `data mutation` 逐层确认，而不是关键词匹配。**
   三轮扫描各自需要不同的预处理：
   * `require` —— 模块名本身是**字符串字面量**，因此必须**保留字符串**；
   * 调用形态 —— 必须**挖掉字符串**，否则 Economy 自己的否认词表会命中；
   * 数据变更 —— 表名在 SQL 拼接里，**字符串里根本没有表名**（见 §1.3）。

3. **词法器，而不是正则。** 最初用 `/'([^'\\]|\\.)*'/g` 一步挖字符串：一旦某行
   有一个未闭合的引号（注释里的 `don't`、字符串里的 `//`），配对就会整体错位
   —— 实测把一整个文件"吞"成一行 **49,043 字符**的假代码，7 个命中里 **5 个是
   假的**。改成逐字符小词法器（**换行处恢复**）之后，命中从 7 降到 2，而且剩下
   的 2 个是真的。`tests/test_p22_20_economy_external_boundary.js` 头部把这段
   教训写在了代码里。

---

## 1 · §1 External Capability Audit

### 1.1 矩阵

| 外部能力 | 是否存在 | 当前 owner | Economy 引用 |
| --- | --- | --- | --- |
| Provider billing | **部分**：仓库内只有**给人看的一句话**（`provider-directory.js` 的 `billingHint`，22 处），**没有任何计费能力** | provider 官网（仓库外）+ 用户 | **0** |
| Provider quota | **否**：全仓没有任何读取 provider 余额/配额的路径 | provider 官网（仓库外） | **0** |
| Real payment | **是（完整）**：`bridge/alipay-provider.js` 真的 `spawnSync('alipay-bot','submit-payment',…)`；`bridge/pay-gate.js` 的 `commitSpend` 是服务端唯一提交入口；`active/payment-auth.js` 的 `under_limit` 是授权唯一来源 | Bridge + Active（真实购物域） | **0** |
| Refund | **否**：Economy 里只有"没有退款"这条自述（`refundIssued: false` 等 7 处 + `PURCHASE_HAS_REFUND = false`） | — | **0** |
| Exchange | **词表有、能力没有**：契约 §17 冻结了汇率**算术**（`computeExchangeAmount` / `validateExchangeRate`），**零调用方** | — | **0** |
| Merchant | **是（完整）**：`active/commerce.js`（`merchant` 5 处）、`active/payment-auth.js`（6 处） | Active 购物域 | **0** |
| External order | **是（完整）**：`bridge/pay-gate.js`（`orderId` 40 处）、`active/commerce.js`（`paymentIntent` 16 处） | Bridge / Active | **0** |

**"Economy 引用 = 0"是三层各自算出来的**（测试 `A4`/`A5`/`A6`/`A7`）：

* **A4 require**：Economy 七个生产文件的模块名里没有一个落在
  `pay|billing|alipay|stripe|provider|merchant|commerce|shopping|credential|vault`
  这些命名空间里；
* **A5/A6 调用形态**：成员调用（`.payX(` / `.refundX(` / `.convertX(` …）、
  裸调用、以及支付网关标识符（`alipay` / `stripe` / `checkoutUrl` /
  `paymentIntent` / `pay_register_checkout` / `commitSpend` …）在 Economy 生产代码
  与六个 UI 文件里各 **0 次**；
* **A7 数据变更**：Economy 的表常量 **20 个**、导出的表名 **16 个**，全部是
  `economy_*`，没有一张是外部概念。

> ★ 一处**描述性缺口**（不是边界问题，如实记录）：store 里实际有 20 个
> `*_TABLE` 常量，而 `TABLES` 导出只有 16 项 —— 少的是 P22-7/8/14 建的
> `APPROVALS` / `AUTONOMY_POLICIES` / `POLICY_LIMIT` / `PURCHASE_INTENTS` 四张。
> 这不影响任何一条边界（读面走的是具名 getter，不是这张表），但"导出即描述"
> 在这里是不完整的。测试 `A7` 把 **20 与 16 两个数字都断言下来**，于是将来谁
> 补齐或谁再加表都会被提醒。**本阶段不改它**（审计阶段不做无谓的生产改动）。

### 1.2 "代码里出现的每一个外部词都被点名解释"

这一条比"零出现"更强，也更有信息量：Economy 代码里允许出现的**全部**外部词，
必须在两类声明里 —— **冻结词表**（契约里的 tx type / event type / reason code /
product kind）或 **恒 false 自述**（`providerMutation: false` 这类）。测试 `A8`
扫出全集并逐条比对，`A8b` 断言声明表里**没有僵尸条目**，`A9` 断言每一个
"恒 false 位"在源码里真的是 `false`（字面量，或引用一个契约里为 `false` 的常量）。

实测扫出的全集（这是本阶段最有信息量的一张清单）：

```
refund        REFUND · PURCHASE_HAS_REFUND · PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND
              refundIssued · hasRefund · purchaseHasRefund · purchaseCancelIssuesARefund · canRefund
exchange      EXCHANGE · EXCHANGE_RATE · EXCHANGE_ROUNDING · EXCHANGE_RATE_INDEX_PREFIX
              EXCHANGE_APPLY · EXCHANGE_COMMITTED · EXCHANGE_RATE_UNKNOWN
              EXCHANGE_ROUNDS_TO_ZERO · EXCHANGE_CROSS_DOMAIN_FORBIDDEN
              computeExchangeAmount · validateExchangeRate · exchangeRateId
              canExchange
provider      API_QUOTA · PURCHASE_TOUCHES_PROVIDER · PURCHASE_INTENT_TOUCHES_PROVIDER
              autonomyTouchesProvider · canTopUpAProvider · isProviderQuota
              providerMutation · providerQuotaMutation · purchaseTouchesProvider
real payment  PURCHASE_TOUCHES_PAYMENT · PURCHASE_INTENT_TOUCHES_PAYMENT
              configurationAuthorityIsNotPaymentAuthority（正向否认句，值为 true）
              autonomyTouchesPayment · countsAsPaymentCurrency · isAPaymentAuthority
              paymentMutation · purchaseTouchesPayment
merchant      storeIsAMerchant
externalOrder （一个都没有）
```

**没有一个词是"用上了"**；每一个都是"被写下来的否认"或"冻结的槽位"。

---

## 2 · §2 Economy → External Dependency Closure

### 2.1 闭包（实测）

```
services/home-node/economy-store.js            ← node:sqlite · node:path · node:fs
                                                 runtime/db-failure.js · economy-contract.js
services/home-node/economy-contract.js         ← （零依赖）
services/home-node/economy-action-adapter.js   ← economy-contract.js
services/home-node/economy-capability.js       ← economy-contract.js
services/home-node/economy-command-channel.js  ← node:crypto · node:http · economy-contract.js
services/home-node/economy-configuration.js    ← node:crypto · economy-contract.js
services/home-node/economy-approval-decision.js← node:crypto · economy-contract.js
runtime/db-failure.js                          ← （数据库失败分类的**唯一**实现）
                                                 → 到此为止，stop
```

| 断言 | 结果 |
| --- | --- |
| `B1` 闭包恰好 7 个 Economy 文件 + `runtime/db-failure.js` | ✔ 8 个，一个不多一个不少 |
| `B2` 指向白名单之外的**文件**依赖 | ✔ 0 条 |
| `B3` 内建依赖 | ✔ 恰好 `node:sqlite` / `node:crypto` / `node:http` / `node:path` / `node:fs` |
| `B4` 裸 specifier | ✔ 只有 `path` 与 `fs` |
| `B5` SDK / 支付库 / 凭据库（`axios` / `undici` / `stripe` / `alipay-sdk` / `@aws-sdk/*` / `openai` / `keytar` / `dotenv` / `vault` …） | ✔ 0 |
| `B6` `process.env` | ✔ **0** —— Economy 不持有凭据，也不持有任何外部端点配置 |
| `B7` `fs` 的用途 | ✔ 只有 `fs.mkdirSync(dataDir)`，没有第二种文件写入 |
| `B8` 网络原语 | ✔ 只有 `node:http` 的**一个出站** transport；**没有** `createServer` / `listen` |
| `B9` 有限且终止 | ✔ 8 个文件 / 13 条边，无环 |

### 2.2 那个唯一的网络原语是什么

它必须被说清楚，而不是被"0 network call"一句话盖过去。

* 它是 `economy-command-channel.js` 的 `createNodeTransport`：一个**出站**的
  HTTP 客户端，只被 `createEconomyCommandClient` 用；
* 默认目标是 `http://127.0.0.1:23118`（与 `home-node-client.js` 的 `DEFAULT_BASE`
  同源约定），由 `IB_ECONOMY_CHANNEL_BASE` / `IB_HOME_NODE_PORT` 注入；
* **服务端那一半拒绝非 loopback 来源**（`info.loopback !== true` →
  `ECONOMY_COMMAND_NOT_LOOPBACK`），而且要求**已登记**的来源端口 + 来源凭据；
* 凭据（`IB_ECONOMY_CHANNEL_TOKEN`）的解释在 `active/economy-channel-client.js`
  与装配层 —— 也就是**闭包之外**。Economy 自己一个 `process.env` 都不读；
* 走这条路的信封里**不携带任何经济事实**（价格 / 金额 / 币种 / 预算 / 钱包 /
  商品 / 结算 / 发放 / consumer / capability 都不在信封里，出现即拒），
  因此"把 Economy 事实发到网上"这条捷径在**形状上**就不成立。

---

## 3 · §3 四种资源的最终反证

四种资源：**A** `IB_CREDIT` · **B** `COMPUTE_ENTITLEMENT` · **C** Provider quota ·
**D** Real money。

### 3.1 注入（带差分控制组）

注入 `currency = "USD" / "CNY" / "TOKEN" / "API_BALANCE"` 到四个入口：
钱包 / 预算政策 / 商品 / 报价。

**★ 差分对照是这一节的骨架。** 只断言"注入被拒绝了"是不够的 —— 开发期实测
踩到过：商品 id 写成非 canonical 时，注入会因为"id 不合格"被拒，断言全绿，
而它证明的根本不是币种边界。因此每一种注入都配一个**控制组**（除币种以外逐字
相同，币种 = `IB_CREDIT`），控制组必须**被接受**；控制组被接受 + 注入组被拒绝，
这次拒绝才可归因于币种。

| | 钱包 | 预算政策 | 商品 | 报价 |
| --- | --- | --- | --- | --- |
| 控制组 `IB_CREDIT` | ACCEPTED | ACCEPTED | ACCEPTED | ACCEPTED |
| `USD` | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `CNY` | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `TOKEN` | FORBIDDEN | FORBIDDEN | FORBIDDEN | FORBIDDEN |
| `API_BALANCE` | NOT_REGISTERED | NOT_REGISTERED | NOT_REGISTERED | NOT_REGISTERED |

两个拒绝码刻意分开数：

* `currency-forbidden-real-money-or-provider-balance` —— **deny-list 认出"这是
  真实货币或 provider 余额"**；
* `currency-not-registered` —— **白名单认不出"这是我们注册的虚拟资源"**。

`G2` 断言两道闸门**都**在工作（两类码各自出现）—— 否则"两个闸门都开着"与
"只有一个在工作"看起来会一样。注入之后 store 里**恰好只有一个**钱包且是
`IB_CREDIT`（`G3`）：拒绝不留半成品。

### 3.2 四条身份断言

| 断言 | 证据 |
| --- | --- |
| `IB_CREDIT != money` | `CURRENCY` 白名单 6 员，`IB_CREDIT` 是唯一被接受的那个；`CNY/USD/RMB/EUR/GBP/JPY` 都不在；`CURRENCY_DISPLAY.IB_CREDIT = 'IB Credit'` |
| `IB_CREDIT != provider balance` | 造币（`mintForSystem`）要求 `systemInitiated: true`；`COMMIT_COUNTERPARTIES` **恒等于** `['system:treasury','system:market']`；账本拓扑里读不出任何 provider 字样 |
| `COMPUTE_ENTITLEMENT != token quota` | 算力额度落成**一行库存**：`assetKind = COMPUTE`，序列化后 `isABalance:false` / `contributesToAvailableBalance:false`，键里没有 `provider|token|quota|api|fiat`；不存在的商品不能凭注入变出一份额度 |
| `COMPUTE_ENTITLEMENT != API billing` | 授予算力**不改变余额、不改变钱包行的 revision、不产生账本 entry**；授予量（125）**从不**出现在预算窗口或余额快照里 |

---

## 4 · §4 Payment Boundary Audit

### 4.1 方向

```
允许（今天**已经存在**，而且是唯一的外部价值入口）
  External Payment
        ↓  Payment Adapter（**不存在**，也在 Economy 闭包之外）
  Economy Bootstrap / Credit Grant
        = POST /internal/economy/configuration { command: BOOTSTRAP_CREDIT }
        → store.bootstrapInitialCredit（一次性；oneShot 是 canonical store 的
          事实（`economy_meta` 行），不是路由层的一次检查）

禁止（今天**没有代码**）
  Economy Ledger
        ↓  支付宝 / Stripe
        ↓  真实扣款                     ← 一条边都没有
```

### 4.2 三条机器证明

* **`C3` 模块级拦截**：把 `Module._load` 包起来，**真** `require` 七个 Economy
  生产文件，记录每一次模块请求 → 请求里**没有一次**落在
  `pay|billing|alipay|stripe|provider|merchant|commerce|shopping|credential|vault`。
* **`C4` 对手方封闭**：`commitLedgerTransaction` 里
  `COMMIT_COUNTERPARTIES.indexOf(counterparty) < 0 → 拒绝`，而那个集合只有
  `system:treasury` 与 `system:market`。**账本结构上点名不了一个商户或支付机构**
  —— 这不是"我们不会写"，而是"写不进去"。
* **`C2` / `I4` 函数体内零支付调用**：`settlePurchase` / `preparePurchase` 的
  函数体里没有任何支付**调用形态**。

> ★ 这里有一处必须点名的**方法学细节**：第一次写 `C2` 时用的是裸词扫描
> （`/payment|provider|…/`），它立刻红了 —— 因为 `settlePurchase` 的返回值上
> 带着 `providerMutation: false` / `paymentMutation: false` 这些**自述**。
> 裸词会把"边界的证据"算成"越界"。改成**调用形态**扫描之后才是对的：这一条
> 与 §0 第 2 条纪律是同一件事。

### 4.3 I 组：让支付模块**真的存在**

§10 要求"模拟 payment provider module exists，确认 Economy 不 import"。
`I` 组把这件事做到位：

1. 在临时目录里造五个**能工作的**桩模块，并用 `Module._resolveFilename` 只对
   `economy-*.js` 作为 parent 的请求，把 `bridge/pay-gate.js` /
   `bridge/alipay-provider.js` / `bridge/payment-provider.js` /
   `active/payment-auth.js` / `active/commerce.js` 重定向到它们 ——
   于是"文件不存在"这个借口被彻底移除；
2. 清掉 `require.cache`，重新加载七个 Economy 文件；
3. `I1`：`paymentStubLoads.length === 0`（一次都没 require）；
   `I3`：**桩本身是活的** —— 直接 require 它并调用 `commitSpend`，计数器 +1
   （否则 `I1`/`I2` 是在为空气作证）；
4. `I5`：跑一次**完整**的 报价 → 预留 → 结算（并且断言钱真的动了 99500、
   货真的发了一行），生产链对桩的贡献是 **0 次**。

---

## 5 · §5 Provider Boundary Audit（Compute）

### 5.1 结构

| 断言 | 结果 |
| --- | --- |
| `assetKind` 是封闭两员 `{ITEM, COMPUTE}` | ✔ 只有 `API_QUOTA` / `COMPUTE_CREDIT` 映射到 `COMPUTE`；`SERVICE` 是 `null` |
| 结算原语 | ✔ `COMPUTE_ENTITLEMENT` 与 `INVENTORY` 同级；`SERVICE_EXECUTION` 指向 `null`（做不成就拒绝） |
| 计量单位名 | ✔ 只有一个 `computeUnit`；别名只有 `computeUnit` / `computeUnits` |
| 被逐字否认的单位名 | ✔ `token` / `tokens` / `virtualToken` / `usd` / `cny` / `balance` / `providerBalance` / `providerCredit` / `apiCredit` / `realCredit` |
| `grantQuantity` | ✔ compute 必须 ≥ 1；服务商品必须**恰好 0** |
| provider 字段注入 | ✔ `providerApiKey` / `providerBalance` / `providerQuota` … 在商品输入上被**逐个列名**拒绝 |

### 5.2 "是否可能误解" —— 与 §5 允许的唯一一种改动

§5 说："如果需要：只允许 display label improvement。" 审计结论：**需要的东西
已经在了，而且是真的在页面上**（不是只写在 COPY 表里）：

* 纯层把 `note: kindKey === 'COMPUTE' ? COPY.assetsComputeNote : null` 放进
  COMPUTE 那一组；
* **渲染器真的把它 append 上去**（`if (grp.note) box.appendChild(note(grp.note…`）
  —— 纯层有而渲染器不画等于没有，因此这两步必须**分开**断言（`D5`）；
* 那句话本身是否认句：「**IB 内部的算力额度（Compute Entitlement），不是任何
  外部服务的余额或额度。**」
* 展示层的单位名只有「算力单位」一个说法（`UNIT_FACE.computeUnit`）。

**没有新增 provider adapter**（`D6`：没有 `provider-*` 生产文件，也没有
`providerAdapter` / `createProviderAdapter` / `providerClient` 这类标识符），
三处自述字段（`isProviderQuota:false` / `providerQuotaMutation:false` /
`configurationTouchesProvider:false`）把这件事写成可断言的常量（`D7`）。

### 5.3 Provider 注入（H 组）

| 注入面 | 次数 | 结果 |
| --- | --- | --- |
| 商品输入（13 键 × 5 值） | 65 | 全部 DENY（未知键**逐个列名**） |
| 一次性初始额度（13 键 × 5 值） | 65 | 全部 DENY |
| 配置面三条命令的 `config`（13 键 × 3 命令） | 39 | 全部 DENY，原因码 `…_UNEXPECTED_CONFIG_KEYS`，且 `reachedStore === false` |
| 配置面的**信封**（16 键） | 16 | 全部 DENY，原因码 `…_UNEXPECTED_ENVELOPE_KEYS`，且 `reachedStore === false` |
| Agent 那条路（动作适配器，13 键） | 13 | 全部 DENY |
| **预算政策**（13 键 × 5 值） | 65 | ★ 见下 |

> ★ **一处必须如实写出来的不对称**：`putBudgetPolicy` 读的是**固定字段名**，
> 多出来的键**既不报错也不入库**（与商品那条"未知键即失败"不同）。诚实的话术
> 是 **deny-by-omission**，而且它只能由"读回来的东西里没有"来证明 —— 不能靠
> "调用返回 ok"就当成没漏。`H2` 就是这么断言的：把那 65 次调用之后读回来的
> 政策序列化，断言 13 个 provider 键**一个都没出现**，同时断言
> `perTransactionMinor` 真的在（否则是空对空）。
>
> 而**真正对外可达**的写路径不接受多余键：配置面三条命令的 `config` 与信封
> 各有精确白名单（`H3`/`H4`，55 次全部 DENY 且 `reachedStore === false`），
> 初始额度在 130 次注入后仍然**没有发出去**（`H5`）。

---

## 6 · §6 Refund / Reverse Semantics Audit

**不实现 Refund。只回答"模型里有没有位置"。**

### 6.1 现状是冻结的 `false`

* `PURCHASE_HAS_REFUND === false`
* `PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND === false`
* `settlePurchase` 的返回值上恒有 `refundIssued: false`
* 全仓没有 `refundPurchase` / `reversePurchase` / `chargeback` 的**实现或调用**
  （注释里那句"刻意没有 refundPurchase"是边界的证据，因此扫描必须先挖注释）

### 6.2 位置：有三处

| 位置 | 证据 |
| --- | --- |
| ① 不可变性 + 补偿语义 | 契约逐字：「a terminal purchase is immutable; **a refund must be a new compensating economic operation**」，以及 `terminal-state-cannot-transition-must-compensate-with-a-new-transaction` |
| ② 账本词表槽位 | `TX_TYPE.REFUND` **已登记**在封闭词表里，且对消费窗口是 `NEUTRAL`（补偿不该被算成一次新的消费） |
| ③ 库存补偿原语 | `grantInventory` 存在，因此"把货加回去"是可表达的 |

### 6.3 缺口：四处（这就是 future extension point）

| 四张记录 | 缺什么 |
| --- | --- |
| Ledger | `TX_TYPE.REFUND` 已登记，但**没有产生它的操作**（0 调用方） |
| Purchase | 终端 Purchase 不可变，**没有补偿性 Purchase 的写路径** |
| Inventory | `grantInventory` 可表达补偿，但**没有 purchase → 反向授予**的路径 |
| Change log | **没有** REFUND / REVERSAL 的 event type（`EVENT_TYPE` 里只有 `EXCHANGE_COMMITTED` / `MINT_COMMITTED` / `BURN_COMMITTED`） |
| Approval | `CONSUMED` 是终端状态，**没有** `REVOKED` |

**结论**：未来要做退款时，落点是"一笔**新的**补偿性经济操作"，它需要
（a）一个产生 `TX_TYPE.REFUND` 的 store 操作、（b）一个补偿性 Purchase 行、
（c）一条反向库存授予路径、（d）一个新的 event type、（e）一个 `REFUND_APPLY`
审计操作。**这五样今天一样都没有**，而 `E7` 把它们写成了数据 —— 将来谁补上
退款，这份审计会红并提醒更新结论。

---

## 7 · §7 Exchange Audit

**不实现 Exchange。**

### 7.1 结果：`0 Economy capability`，但不是"0 词汇"

必须如实说：契约 §17 里**有**一套汇率算术。

| 有 | 没有 |
| --- | --- |
| `EXCHANGE_ROUNDING = 'floor-toward-zero-favoring-the-house'` | 没有 store 方法（句柄上零个 `exchange|convert|cashout` 成员） |
| `EXCHANGE_RATE_INDEX_PREFIX = 'econ_rate_'` | 没有 HTTP 路由（真实路由判定里零个 exchange/convert） |
| `validateExchangeRate()` / `computeExchangeAmount()` | 没有 command（`COMMAND_LIST` 与 `FORBIDDEN_COMMANDS` 里都没有） |
| `TX_TYPE.EXCHANGE` / `EVENT_TYPE.EXCHANGE_COMMITTED` / `AUDIT_OPERATION.EXCHANGE_APPLY` | 没有 capability（`CAPABILITY` 只有两个，都不是兑换） |
| `EXCHANGE_RATE_UNKNOWN` / `EXCHANGE_ROUNDS_TO_ZERO` / `EXCHANGE_CROSS_DOMAIN_FORBIDDEN`（拒绝码） | 没有调用方：`computeExchangeAmount` / `validateExchangeRate` 在整条生产链上**零调用** |

`F3` 逐文件扫调用点（七个生产文件 + 六个 UI + `active/economy-channel-client.js`
+ `http.js`），`F2` 只看**真实路由判定** —— 因为 `/security` 的 `unreachable`
名单里**故意**写着 `/economy/exchange`，把它算成一条路由正好读反了。

### 7.2 `IB_CREDIT ↔ 真实货币 / provider 余额` 的两道闸门

第一道（**当前生效的那一道**）：`validateCurrency` 的 deny-list 逐条否认
`USD / CNY / RMB / TOKEN / API_CREDIT / PROVIDER_BALANCE / OPENAI_BALANCE / …`，
所以一个带 USD 的汇率命题**连形状都建不起来**。

第二道：`computeExchangeAmount` 里还有 `isForbiddenCurrencyToken(from/to) →
exchange-cross-domain-forbidden`。

> ★ **审计发现（写下来，不假装它被触发过）**：第二道闸门在"第一道闸门是唯一
> 币种权威"的前提下**不可达** —— `validateExchangeRate` 只在两个币种都通过了
> `validateCurrency` 之后才成功，而 deny-list 已经在那一关把它们拒掉了。
> 它是**纵深防御**，不是当前生效的那一道。`F1` 因此断言的是
> ① deny-list 拒绝、② 第一道闸门给出的拒绝码、③ 带 USD 的汇率命题整条被拒、
> ④ **第二道闸门的代码确实被写着**、⑤ 反向证明（Economy 内部两种币之间的
> 兑换**是**可表达的，否则 ③ 可能只是因为整个函数坏掉了）。
> 这正是 P22-13 留下的那条教训的另一面：「未被执行过的分支就是未验证的代码」
> —— 只不过这里的结论是"它确实不可达"，而不是"它没有被测到"。

### 7.3 展示层

UI 代码里的兑换标识符**恰好三个**：`EXCHANGE_RATE_UNKNOWN` /
`EXCHANGE_ROUNDS_TO_ZERO` / `EXCHANGE_CROSS_DOMAIN_FORBIDDEN`，而它们全都是
**canonical 拒绝码的中文标签表**里的**键**（一个错误码的说法），不是功能入口
（`F4` 逐个断言键属于 `DENY_REASONS`）。

---

## 8 · §8 Public Surface Freeze

交付物：**`docs/ECONOMY_PUBLIC_SURFACE.md`**。

它不是散文：`tests/test_p22_20_economy_public_surface.js` 逐行解析它的三张表，
再与**真实代码**比对。

| 面 | 内容 | 比对对象 |
| --- | --- | --- |
| Read | **28 条** `GET /economy/*` + `GET /security` | `http.js` 里真实的 `path === '…' && method === 'GET'` 判定 —— 逐个相同（`N1`），而且**没有一条** `/economy/*` 接受别的 method（`N2`） |
| Write | **3 条**：`POST /internal/economy/configuration`（3 个命令）· `…/approval-decision`（`APPROVED` · `REJECTED`）· `…/command`（1 个命令） | 三个 seam 的 `path` 常量 + 模块词表常量 + `describe()` 的**自述**（三者一致，`N3`/`N4`） |
| Capability | `PROPOSE_PURCHASE` · `RESUME_APPROVED_PURCHASE` | 契约的 `CAPABILITY`（`N5`）；矩阵仍是 2 × 4，`home_node_authority` 与 `desktop_bridge` 的能力表**为空** |
| Not present | `BUY` · `PAY` · `REFUND` · `EXCHANGE` · `TRANSFER` · `TOPUP` · `WITHDRAW` | 这七个词**真的**不在任何 capability / command / 路由里（`N7`），而且**被写进**了 `/security` 的 `unreachable` 名单（`N8`，42 条） |

> ★ 文档写错过一次，而且是被测试抓住的：Write 表最初写的是
> `APPROVE` / `REJECT`，而 seam 的 `decisions` 与模块常量都是
> **`APPROVED` / `REJECTED`**。这正是"文档 ↔ 代码逐个比对"要的失效形态。

### 8.1 真实 HTTP（socket = 1）

一个 in-process Home Node（**一个** server + **一个** socket，不 spawn、不开
第二个）：

| 断言 | 结果 |
| --- | --- |
| `O1` 29 条读面全部可达 | ✔ 没有一条 404 |
| `O2` 对 28 条 `/economy/*` 读面发 POST | ✔ 全部 **405 `economy-is-read-only`** |
| `O2b` `POST /security` | ✔ **404 `no-route`** —— 两条兜底**分开**，不混用（这本身是一个要断言的事实） |
| `O3` 九个未来能力路径（refund / reverse / exchange / topup / buy / payment / provider / transfer / withdraw） | ✔ GET **404 `unknown-economy-path`**，POST **405 `economy-is-read-only`** |
| `O4` 这一整轮之后 change log | ✔ **逐字没变**，revision 没动 |
| `O5` 三条写面匿名 / 错凭据 | ✔ 6 次全部非 2xx，且**没有一条 404**（不是"根本没装配"） |
| `O6` `/security` 的自述 | ✔ 三条写面都在；`isAPaymentAuthority:false` / `configurationTouchesPayment:false` / `configurationTouchesProvider:false` / `purchaseHasRefund:false` / `purchaseTouchesProvider:false` / `purchaseTouchesPayment:false` |

> ★ `/economy/purchase` **不在**"幽灵路径"表里：它是一条**真的**读面
> （`GET /economy/purchase?purchaseId=…`）。开发期实测把它写进那张表时，
> GET 会以 400（缺参数）回答 —— 那正是"这条路由存在"的证据。

---

## 9 · §9 UI 不允许提前出现入口

把**三个真实渲染器**（P22-15 批准面、P22-16 配置面、P22-17/18 外壳）各自挂在
一个 DOM 桩上渲染出来，然后把页面上**每一个按钮的文案**收出来。

实测收出的全集（**30 个按钮位**，去重后 **23 条文案** ——「待处理」在外壳与配置面
各出现一次，是同一个页签的两个入口）：

```
外壳        概览 · 商店 · 我的资产 · 待处理 · 设置 · 重新读取 · 技术说明 · 展开 · 只看这家
批准面      刷新 · 拒绝请求 · 允许继续 · 细节
配置面      待处理 · 钱包与初始额度 · 预算限制 · 自主购买 · 高级设置 · 展开 · 关闭
            有限 · 常规 · 放宽 · 保存 · 再试一次
```

| 断言 | 结果 |
| --- | --- |
| `P1` 三个渲染器都真的画出了按钮 | ✔ 15 / 4 / 11（否则下面每一条都是空断言） |
| `P2` 没有一个按钮文案是禁止的**动作** | ✔ 0（判据是"就是该词"或"以该词开头"） |
| `P3` 按钮文案的**全集**与冻结词表逐个相同 | ✔ 多一个红、少一个也红 |
| `P3b` 含"购买"字样的按钮只能是那一格**页签** | ✔ 唯一一个是「自主购买」，类名带 `tab` —— 它是设置页的一格名字，不是入口 |
| `P4` 允许的动作确实都在 | ✔ 批准（允许继续 / 拒绝请求）+ 配置（保存）+ 查看（重新读取 / 再试一次 / 展开）三类各至少一个 |
| `P5` 商品卡上**没有任何按钮** | ✔ 商店那一格是纯展示（canonical 到今天没有人类直接购买这条接缝） |
| `P6` 没有表单 / 没有 `type=submit` / 没有 `onclick` 属性 / 没有 `<a href>` | ✔ 不存在第二条提交路径 |
| `P7` 渲染过程在 `/economy/*` 上零写请求 | ✔ |

> ★ 判据本身也修过一次：第一版用 `FORBIDDEN_ACTION_RE = /购买|充值|…/` 直接匹配
> 文案，于是「**自主购买**」立刻红了 —— 那是一格设置的名字（一个名词短语），
> 不是一次购买。判据改成"就是该词或以该词开头" + "含该字样的按钮必须是页签"
> 之后才是对的。**一个太宽的判据与一个太窄的判据一样会让人放弃它。**

---

## 10 · §10 测试要求

| 要求 | 落在哪 |
| --- | --- |
| boundary tests | `test_p22_20_economy_external_boundary.js`（42 项） |
| dependency closure | 同上 §2（B1–B9） |
| capability negative tests | `test_p22_20_economy_boundary_injection.js`（L1–L3：14 词 × 4 consumer） |
| Provider：billing 关键词 / balance / quota 注入必须 DENY | 同上 H1–H8（195 + 55 + 13 次注入） |
| Payment：模拟 payment provider 模块存在，确认 Economy 不 import | 同上 I1–I5 |
| Exchange：模拟 `convertCurrency()` 存在，确认无调用路径 | 同上 J1–J3（跑完整读写面，两个计数器） |
| Refund：不存在 `POST /economy/refund`、不存在 `refundPurchase()` | 同上 K1–K3 + `test_p22_20_economy_public_surface.js` O3 |

**合计 96 条断言**（42 + 31 + 23）。

---

## 11 · §11 资源

| | child | spawn | browser | socket |
| --- | --- | --- | --- | --- |
| `test_p22_20_economy_external_boundary.js` | 0 | 0 | 0 | 0 |
| `test_p22_20_economy_boundary_injection.js` | 0 | 0 | 0 | 0 |
| `test_p22_20_economy_public_surface.js` | 0 | 0 | 0 | **1（本进程 server + socket）** |

* 不启动 Desktop / Electron / DSH / Playwright；
* 三个测试各自把所有临时目录登记在一张表上，并在 `process.on('exit')` 统一
  退避重试删除（**包括中途断言抛异常的路径**）—— 结束后 `%TEMP%` 里
  `p2220-*` 目录数 = **0**；
* 仓库新增 PNG = **0**（本阶段没有视觉测试：§9 用 DOM 桩取真实渲染器的按钮
  文案，不需要像素）。

---

## 12 · 本阶段的 production diff

**0 行。** 改动只有：

* 新增 3 个测试文件（96 条断言）；
* 新增 `docs/ECONOMY_PUBLIC_SURFACE.md`（§8 的交付物）与本文件；
* `tests/test-all.js` 登记三条新测试（注释 + 三个数组项）。

理由：审计证明**不需要**任何生产改动。§5 允许的"display label improvement"
在 P22-17/18 就已经落地并且真的被渲染（`D5`）；§3/§4/§7/§10 要求的所有 DENY
都已经存在。按 P22-19 的用户纪律，`production diff = 0` 是更干净的完成方式 ——
不为了"有生产代码可提交"而硬改后端。

---

## 13 · Stop Gate：13 个问题的回答

1. **Economy 是否完全不依赖 Payment？** 是。闭包里 0 个支付模块；`Module._load`
   拦截下七个文件加载时 0 次支付模块请求；把五个支付/购物模块**做成真的可解析**
   之后仍然是 0；`settlePurchase` / `preparePurchase` 体内 0 次支付调用；
   `COMMIT_COUNTERPARTIES` 只有 `system:treasury` 与 `system:market`。
2. **Economy 是否完全不依赖 Provider billing？** 是。仓库里根本没有 provider
   计费能力（只有 `provider-directory.js` 给人看的一句话）；Economy 零 `process.env`、
   零 provider 适配器；195 次 provider 键注入全部被拒。
3. **IB_CREDIT 是否仍只是内部 ledger 单位？** 是。六个注册币种全是虚拟资源；
   法币与 provider 余额在 deny-list 上被**逐字否认**；`IB_CREDIT` 是唯一被接受的
   那个；账本对手方封闭在 `system:*`。
4. **Compute entitlement 是否仍只是内部 inventory？** 是。它就是一行库存
   （`assetKind = COMPUTE`，`isABalance:false`），授予**不动余额、不动账本**，
   数量从不进预算窗口；展示层带着"不是任何外部服务的余额或额度"这句否认。
5. **是否不存在 Exchange capability？** 是（0 capability：无方法、无路由、
   无 command、无 capability），但**词表存在**（契约 §17 的汇率算术，
   **零调用方**）—— 这一点如实记录，不粉饰。
6. **是否不存在 Refund capability？** 是。`PURCHASE_HAS_REFUND = false`，
   无操作、无路由、无 event type、无 `REFUND_APPLY`。模型里的"位置"有三处、
   缺口有四处，全部记为 future extension point。
7. **是否不存在 Merchant / Store write capability？** Merchant 域整体在
   Active/Bridge（Economy 引用 0）；Economy 的 `putStore` / `putProduct` 是
   **同进程 store 原语**，不在任何路由上（`/economy/store/create` 等在
   `unreachable` 名单里）。
8. **Public write surface 是否仍只有三条？** 是，而且逐字比对过：
   `/internal/economy/{configuration, approval-decision, command}`，
   共 3 + 2 + 1 = **6** 个词，三条都不在 `/economy/` 下。
9. **Agent capability 是否没有扩大？** 是。仍然是 2 个 capability × 4 个
   consumer，`home_node_authority` 与 `desktop_bridge` 为空；14 个未来能力词
   × 4 个 consumer 全部 DENY。
10. **UI 是否没有提前暴露未来能力？** 是。30 个按钮位、23 条文案的全集被冻结
    并与真实渲染结果逐个比对；商品卡上零按钮；无表单 / 无 submit。
11. **P22-1～19 regression 是否通过？** 通过（见 §14）。
12. **production diff 是多少？** **0**。3 个新测试 + 2 个新文档 + `test-all.js`
    的登记。
13. **child / spawn / browser / socket / leftover？** 0 / 0 / 0 / 前两条 0、
    第三条 1（in-process server + socket）→ 结束时 leftover 进程 0、
    临时目录 0、仓库新增 PNG 0。

---

## 14 · Regression

本阶段**没有改任何生产文件、没有任何 UI 文件改动**（`git diff --stat` 只涉及
`tests/test-all.js`，其余是新增文件）。因此按既有的阶段验证纪律
（"不全量重跑 mutation/regression，只复跑失败项"），**没有**逐条重跑
P22-15～19 —— 它们的实现逐字未变，重跑不增加任何信息。实际跑的是一次

```text
node tests/test-all.js --quick
  static  112 项 · 387.0s · 全部通过
  p22-ui   14 项 ·   7.3s · 全部通过      （P22-15～19 的 core/ui 都在这一组里）
  总耗时  394.4s · 全部通过 ✔

三条新测试各自单跑：
  test_p22_20_economy_external_boundary.js   42 项 PASS · 0 子进程 / 0 socket / 0 浏览器
  test_p22_20_economy_boundary_injection.js  31 项 PASS · 真实 store · 0 子进程 / 0 socket
  test_p22_20_economy_public_surface.js      23 项 PASS · 本进程 1 个 server + 1 个 socket

P22-15～19 的视觉矩阵（approval / configuration / store / experience visual）
本阶段**不跑**：§9 不靠像素，它把三个真实渲染器挂在 DOM 桩上取**按钮文案**，
因此没有引入新的视觉断言，也就没有理由重跑既有矩阵。
```
