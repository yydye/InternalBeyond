# Economy v1 · 冻结契约清单 · `ECONOMY_V1_FROZEN_CONTRACT.md`

> 本文件是 **P22-21 · Economy v1 Final Closure & Freeze** 的交付物（§11）。
> 它不是散文：`tests/test_p22_21_economy_v1_freeze.js` 会**解析本文件的每一张表**，
> 并与**真实生产代码**（`services/home-node/http.js` 的路由判定、
> 三个 seam 的 `path` / 命令词表、契约的封闭集合、`economy-store.js` 的
> `SCHEMA_VERSION`、`assets/` 下的真实文件清单）逐格比对。
>
> ★ 这份清单的用途是**拦人**，不是记录：任何一格漂移都会让那条测试变红，
> 并且它报的是**具体新增/删除了哪个成员**（不是 `expected 7 got 8`）。
> 新增 `POST /economy/buy`、`REFUND`、`PROVIDER_TOPUP` 或第 8 个
> `services/home-node/economy-*.js`，都会命中 `FROZEN CONTRACT CHANGED`。
>
> ★ 结尾那一节是给下一个人的一句话：
> **不要静默扩 v1。声明一个新阶段 / 新版本。**
>
> 基线：P22-20 · `45335f7`。Economy 生产文件 **7 个**，schema 水位 **7**。
>
> ★ **P22-26 的三个例外，逐个点名（其余每一格仍然逐字有效）：**
>
> | 格 | P22-26 的处置 | 为什么 |
> | --- | --- | --- |
> | `ECONOMY_SCHEMA_VERSION` | **7 → 8**（§1 有完整的申报） | `quotes.units`：报价必须保存"买了几份"，否则 `units > 1` 的报价必然被自己的一致性检查拒绝 |
> | 目录种子（`catalog-bootstrap.js`） | **v1 → v2**：去掉那件 `SERVICE` 商品、每件商品加一个只用于展示的 `rarity` | 一个商店不得陈列买不了的商品；而 `rarity` 不进 `products` 表、不进 DTO、不被任何经济代码读 |
> | 库存消耗 | 新增**唯一**一条 runtime seam `consumeOwnedItem(input, context)` | 在此之前 `consumeInventory` 的**生产调用方是 0**，于是 `CONSUMABLE` 与 `DIGITAL_ITEM` 在运行时是同一个东西。它**不**是一个 capability、**不**在 HTTP 上、**不**在命令通道的词表里 |
>
> 这三条都不扩大 v1 的**公开面**（路由 / capability / 事件类型 / 生产文件
> 数量 / 币种 / 资产类别 / 状态机成员）。详见 `docs/history/economy/P22/P22-26-CATALOG-LIFECYCLE.md`。

---

## 1 · SCHEMA_VERSION

| key | value | 唯一真源 |
| --- | --- | --- |
| `ECONOMY_SCHEMA_VERSION` | `8` | `services/home-node/economy-store.js` |

schema 水位只在 P22-2（→1）、P22-3（→2）、P22-4（→3）、P22-5（→4）、
P22-6（→5）、P22-7（→6）、P22-8（→7）七处动过。P22-9 起**一个字节都没有**。

★ **P22-26 抬到 8 —— 这是本文件 §14 逐字要求的那种"声明"，不是一次静默扩张。**

| 阶段 | 水位 | 唯一的那一处改动 | 为什么它必须发生 |
| --- | --- | --- | --- |
| P22-26 | →8 | `quotes` 表加一列 `units INTEGER NOT NULL DEFAULT 1` | `quotes.quantity` 是**送达量**（units × grantQuantity），因此"买了几份"这个选择从来没有被落库过 —— 而 `preparePurchase` 却要拿它去重算金额与数量并比对。调用方不传 units 时那个缺省是 1，于是 `units > 1` 的报价**必然**被自己的重算判成 `QUOTE_MISMATCH`：**报价把 units 算进了 quantity 与 amount，报价自己却没有保存它。** 一次"一次买三份"的失败因此长得像"账目对不上"，而它是自主 Agent 最难自愈的那类拒绝 |

配套设施（全部已交付、且各自有独立的测试）：

- 非空迁移 `7 → 8`（`ALTER TABLE … ADD COLUMN units INTEGER NOT NULL DEFAULT 1`，
  带 `tableExists` 守卫与两处 `PRAGMA` 探测；**只加列**，没有任何 `UPDATE` /
  `DELETE` / `INSERT`，因此既有行一个字节都不被改写）；
- 三处下游（`preparePurchase` / `createApprovalRequest` /
  `authorizePurchaseIntent`）**不再从请求里读 units**，改为从报价那一列读
  （唯一实现 `quoteQuantitiesOf`）；
- `quotes.quantity` 与 `units` 变成两个各自被冻结的事实，关系
  `quantity = units × grantQuantity` 由一条载入期比对钉住。

**本阶段没有做的事**（因此 v1 的其余每一格都仍然逐字有效）：没有新增任何
`/economy/*` 路由、没有新增 capability、没有新增事件类型、没有新增
`services/home-node/economy-*.js` 文件、没有新增币种 / 资产类别 / 状态机成员。

详见 `docs/history/economy/P22/P22-26-CATALOG-LIFECYCLE.md`。

---

## 2 · READ_SURFACES

`GET /economy/*` 共 **28** 条，外加 **1** 条 `/security`（本机节点自述面）。
没有第九类。每一条都只读；非 `GET` 一律 `405 economy-is-read-only`
（`/security` 是**另一条**兜底：非 `GET` → `404 no-route`）。

| Method | Path |
| --- | --- |
| `GET` | `/economy/health` |
| `GET` | `/economy/wallet` |
| `GET` | `/economy/wallets` |
| `GET` | `/economy/ledger` |
| `GET` | `/economy/transaction` |
| `GET` | `/economy/changes` |
| `GET` | `/economy/reservations` |
| `GET` | `/economy/reservation` |
| `GET` | `/economy/policies` |
| `GET` | `/economy/policy` |
| `GET` | `/economy/budget` |
| `GET` | `/economy/quotes` |
| `GET` | `/economy/quote` |
| `GET` | `/economy/stores` |
| `GET` | `/economy/store` |
| `GET` | `/economy/products` |
| `GET` | `/economy/product` |
| `GET` | `/economy/inventory` |
| `GET` | `/economy/inventory-entry` |
| `GET` | `/economy/purchases` |
| `GET` | `/economy/purchase` |
| `GET` | `/economy/approvals` |
| `GET` | `/economy/approval` |
| `GET` | `/economy/autonomy-policies` |
| `GET` | `/economy/autonomy-policy` |
| `GET` | `/economy/autonomy-evaluation` |
| `GET` | `/economy/intents` |
| `GET` | `/economy/intent` |
| `GET` | `/security` |

### 2.1 排序权威（sort authority）

| Path | 排序 | 权威 | 说明 |
| --- | --- | --- | --- |
| `/economy/changes` | 无 `ownerId` 时按 `revision` 升序 keyset 分页；带 `ownerId` 时 `order` ∈ {`asc`,`desc`}，`order` 只能与 `ownerId` 同时出现 | canonical query（`listChanges` / `listChangesForOwner`） | 客户端**不得**重新排序；`ownerScope` 与 `recomputesEconomyFacts:false` 写在响应里 |
| `/economy/purchases` | `created_at ASC` | canonical query | 这是**最早**的一窗，不是最新一窗（见 §13 的 debt D2） |
| `/economy/intents` | `created_at ASC` | canonical query | 同上 |
| `/economy/products` | `sort_order ASC, created_at ASC` | canonical query | 目录顺序 = 读面顺序；**不做个性化、不做推荐、不做排序分数** |
| `/economy/inventory` | `updated_at DESC` | canonical query | — |

### 2.2 owner scope

| Path | owner 作用域 | 不变量 |
| --- | --- | --- |
| `/economy/changes` | 可选 `?ownerId=`（P22-19） | 过滤发生在 **canonical query** 里；投影层只做 filter / sort / project |
| `/economy/wallet`、`/economy/wallets`、`/economy/inventory`、`/economy/purchases`、`/economy/approvals`、`/economy/intents`、`/economy/policies`、`/economy/autonomy-policies` | `?ownerId=` 过滤 | 与上同款 |
| 其余 | 按实体 id | 一条记录 = 一次读 |

---

## 3 · WRITE_SURFACES

写面**恰好三条**，全部是 `POST`，全部**不在** `/economy/` 下
（`/economy/*` 的只读性因此是一条不可绕过的结构性事实，而不是一种约定）。

| Method | Path | Envelope | Vocabulary | Credential | Consumer |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/internal/economy/configuration` | `command` · `config` · `idempotencyKey` | `BOOTSTRAP_CREDIT` · `PUT_BUDGET_POLICY` · `PUT_AUTONOMY_POLICY` | 桌面凭据（`IB_HOME_NODE_TOKEN`） | `home_node_authority` |
| `POST` | `/internal/economy/approval-decision` | `approvalId` · `decision` · `idempotencyKey` | `APPROVED` · `REJECTED` | 桌面凭据（`IB_HOME_NODE_TOKEN`） | `user_decision_seam` |
| `POST` | `/internal/economy/command` | `command` · `commandId` · `idempotencyKey` · `proposal` | `ECONOMY_PROPOSE_PURCHASE` | 来源凭据（`IB_ECONOMY_CHANNEL_TOKEN` + 已登记来源端口） | `active_agent_runtime` |

三条**不共用**命令词、**不共用**信封、**不共用** consumer、**不共用**凭据。
三条都要求 loopback；未配置凭据时整面 `503`。

### 3.1 可触达的 store mutation（写面 → 最终 SQL 写）

| Write surface | 直接调用的 store 方法 | 最终触达的 store 写 |
| --- | --- | --- |
| configuration | `bootstrapInitialCredit` · `putBudgetPolicy` · `putAutonomyPolicy` | `insertIdempotency` · `upsertMeta` · `openWallet` · `insertWallet` · `insertAccount` · `insertTransaction` · `insertEntry` · `insertChange` · `rebuildWalletBalance` · `insertBudgetPolicy` · `upsertBudgetPolicy` · `insertAutonomyPolicy` · `updateAutonomyPolicy` |
| approval-decision | `decideApproval` → `resumeHandle.resumeApprovedPurchase` | `setApprovalDecided` · `setApprovalConsumed` · ……（继续进入 intent 执行链） |
| command | `proposeAgentPurchaseIntent`（经 capability gate + action adapter） | `insertPurchaseIntent` · `insertQuote` · `insertApproval` · `insertOperation` · `insertOperationIdempotency` · `insertChange` |
| capability gate（审计，不是门） | `appendCapabilityAudit` | `insertChange` |

### 3.2 三条写面自述的"不存在的写形态"（`/security` 里逐字可读）

| Seam | 逐名否认的写形态 |
| --- | --- |
| configuration | `BUY` · `SETTLE` · `RESERVE` · `GRANT_INVENTORY` · `APPROVE` · `REJECT` · `REFUND` · `EXCHANGE` · `PROVIDER_TOPUP` · `REAL_PAYMENT` · `RAW_LEDGER_WRITE` |
| approval-decision | `BUY` · `SETTLE` · `RESERVE` · `GRANT` · `REFUND` · `LEDGER` · `AUTO_ALLOW` |
| command | `ECONOMY_BUY` · `ECONOMY_SETTLE` · `ECONOMY_RESERVE` · `ECONOMY_APPROVE` · `ECONOMY_RESUME` · `ECONOMY_GRANT` · `ECONOMY_LEDGER` · `ECONOMY_WALLET_MUTATE` |

---

## 4 · CAPABILITIES

| Capability | 持有者 | 含义 |
| --- | --- | --- |
| `PROPOSE_PURCHASE` | `active_agent_runtime` | **提出**一个购买意图（提出 ≠ 允许） |
| `RESUME_APPROVED_PURCHASE` | `active_agent_runtime` · `user_decision_seam` | 把一条**已被用户批准**的意图继续做完 |

`home_node_authority` 与 `desktop_bridge` 的能力表**是空的**。

### 4.1 CONSUMERS

| Consumer | Runtime anchor | Capabilities |
| --- | --- | --- |
| `active_agent_runtime` | `runtime/component-registry.js#active` | `PROPOSE_PURCHASE` · `RESUME_APPROVED_PURCHASE` |
| `home_node_authority` | `services/home-node-service.js#home-node` | （空） |
| `desktop_bridge` | `bridge/…`（桌面桥） | （空） |
| `user_decision_seam` | `services/home-node-service.js#user-decision` | `RESUME_APPROVED_PURCHASE` |

### 4.2 不是 consumer 的面（`CAPABILITY_SURFACES_NOT_PRESENT`）

| Surface | 为什么它没有经济能力 |
| --- | --- |
| `chat` | 浏览器侧编排；到 store 的通道只有 HTTP，而 HTTP 经济写面为 0 |
| `group_chat` | 浏览器侧编排；不是 Node 运行时消费者 |
| `voice` | 浏览器侧音频工作单元；与经济域零引用 |
| `active_diary` | 浏览器侧时间线渲染；不是提议发起者 |
| `moments_ui` | canonical Moments 的 consumer 是浏览器读面 |
| `mcp_client` | 本阶段不接 MCP；外部工具没有任何经济能力 |
| `llm` | 模型输出不是一个消费者：它连身份都没有 |

---

## 5 · CURRENCIES

| Currency | 单位 | 说明 |
| --- | --- | --- |
| `IB_CREDIT` | 十进制字符串（minor） | Economy 的**内部账本计价单位**。不是法币、不是稳定币、不是可提现余额 |
| `COMPUTE_STANDARD` | `computeUnit` | 算力计价单位（标准档） |
| `COMPUTE_PREMIUM` | `computeUnit` | 算力计价单位（高级档） |
| `ACTIVITY_POINT` | 十进制字符串（minor） | 活动积分 |
| `IMAGE_CREDIT` | 十进制字符串（minor） | 图像额度计价单位 |
| `VOICE_CREDIT` | 十进制字符串（minor） | 语音额度计价单位 |

封闭集**恰好六个**。法币与 provider 计费不在其中，而且被**逐字否认**
（`FORBIDDEN_CURRENCY_TOKENS`，41 个 token）。

---

## 6 · ASSET_KINDS

| Asset kind | 它是什么 | 它不是什么 |
| --- | --- | --- |
| `ITEM` | 库存资产（`economy_inventory` 行，`assetKind = ITEM`） | **不是**余额 |
| `COMPUTE` | 算力**权限（entitlement）**资产（`assetKind = COMPUTE`，单位 `computeUnit`） | **不是** provider quota、**不是** provider 余额、**不是**可换成钱的额度 |

封闭集**恰好两个**。`COMPUTE_ENTITLEMENT` 是 inventory asset 的一种
settlement primitive（`SETTLEMENT_PRIMITIVES` = `INVENTORY` ·
`COMPUTE_ENTITLEMENT` · `SERVICE_EXECUTION`），不是 provider 侧的资源。

---

## 7 · EVENT_TYPES

封闭集**恰好 52 个**（P22-1 冻结 14 个，P22-3 +3，P22-4 +8，P22-5 +8，
P22-6 +5，P22-7 +10，P22-8 +3，P22-9 +1）。

| # | Event type |
| --- | --- |
| 1 | `WALLET_OPENED` |
| 2 | `TRANSACTION_CREATED` |
| 3 | `RESERVATION_CREATED` |
| 4 | `RESERVATION_RELEASED` |
| 5 | `RESERVATION_EXPIRED` |
| 6 | `RESERVATION_COMMITTED` |
| 7 | `RESERVATION_REBUILT` |
| 8 | `OPERATION_FAILED` |
| 9 | `BUDGET_POLICY_CREATED` |
| 10 | `BUDGET_POLICY_UPDATED` |
| 11 | `BUDGET_POLICY_DISABLED` |
| 12 | `BUDGET_POLICY_EXPIRED` |
| 13 | `QUOTE_CREATED` |
| 14 | `QUOTE_EXPIRED` |
| 15 | `QUOTE_CONSUMED` |
| 16 | `QUOTE_CANCELLED` |
| 17 | `PURCHASE_COMMITTED` |
| 18 | `PURCHASE_DENIED` |
| 19 | `PURCHASE_CREATED` |
| 20 | `PURCHASE_RESERVED` |
| 21 | `PURCHASE_COMPLETED` |
| 22 | `PURCHASE_RELEASED` |
| 23 | `PURCHASE_FAILED` |
| 24 | `AUTONOMY_POLICY_CREATED` |
| 25 | `AUTONOMY_POLICY_UPDATED` |
| 26 | `APPROVAL_REQUESTED` |
| 27 | `APPROVAL_APPROVED` |
| 28 | `APPROVAL_REJECTED` |
| 29 | `APPROVAL_EXPIRED` |
| 30 | `APPROVAL_CONSUMED` |
| 31 | `PURCHASE_AUTHORIZED` |
| 32 | `AUTONOMY_PURCHASE_AUTO_ALLOWED` |
| 33 | `AUTONOMY_PURCHASE_REQUIRES_APPROVAL` |
| 34 | `ITEM_GIFTED` |
| 35 | `ITEM_CONSUMED` |
| 36 | `COMPUTE_CREDIT_GRANTED` |
| 37 | `COMPUTE_CREDIT_CONSUMED` |
| 38 | `EXCHANGE_COMMITTED` |
| 39 | `MINT_COMMITTED` |
| 40 | `BURN_COMMITTED` |
| 41 | `STORE_CREATED` |
| 42 | `STORE_UPDATED` |
| 43 | `PRODUCT_CREATED` |
| 44 | `PRODUCT_UPDATED` |
| 45 | `PRODUCT_DISABLED` |
| 46 | `PRODUCT_RETIRED` |
| 47 | `INVENTORY_GRANTED` |
| 48 | `INVENTORY_CONSUMED` |
| 49 | `AGENT_INTENT_PROPOSED` |
| 50 | `AGENT_INTENT_AWAITING_APPROVAL` |
| 51 | `AGENT_INTENT_DETERMINED` |
| 52 | `ECONOMY_CAPABILITY_DECIDED` |

★ `EXCHANGE_COMMITTED` 与 `MINT_COMMITTED` / `BURN_COMMITTED` 是**账本交易类型**
在词表里的登记（`TX_TYPES`），不是已实现的能力。`REFUND` 同样是 `TX_TYPES`
的一员而没有对应的事件类型 —— 这件事逐格记录在 §12。

---

## 8 · STATE_MACHINES

六个状态机的**状态集与转移集**都是契约里的封闭对象。
`—` 表示该状态没有后继（终态）。

| Machine | State | Terminal | Successors |
| --- | --- | --- | --- |
| `PURCHASE_INTENT` | `PROPOSED` | no | `WAITING_APPROVAL` · `EXECUTING` · `DENIED` · `EXPIRED` · `FAILED` |
| `PURCHASE_INTENT` | `WAITING_APPROVAL` | no | `EXECUTING` · `DENIED` · `EXPIRED` · `FAILED` |
| `PURCHASE_INTENT` | `EXECUTING` | no | `COMPLETED` · `EXPIRED` · `FAILED` |
| `PURCHASE_INTENT` | `COMPLETED` | yes | — |
| `PURCHASE_INTENT` | `DENIED` | yes | — |
| `PURCHASE_INTENT` | `EXPIRED` | yes | — |
| `PURCHASE_INTENT` | `FAILED` | yes | — |
| `APPROVAL` | `PENDING` | no | `APPROVED` · `REJECTED` · `EXPIRED` |
| `APPROVAL` | `APPROVED` | no | `CONSUMED` · `EXPIRED` |
| `APPROVAL` | `REJECTED` | yes | — |
| `APPROVAL` | `EXPIRED` | yes | — |
| `APPROVAL` | `CONSUMED` | yes | — |
| `PURCHASE` | `RESERVED` | no | `COMPLETED` · `RELEASED` · `FAILED` |
| `PURCHASE` | `COMPLETED` | yes | — |
| `PURCHASE` | `RELEASED` | yes | — |
| `PURCHASE` | `FAILED` | yes | — |
| `QUOTE` | `OPEN` | no | `CONSUMED` · `EXPIRED` |
| `QUOTE` | `CONSUMED` | yes | — |
| `QUOTE` | `EXPIRED` | yes | — |
| `RESERVATION` | `ACTIVE` | no | `COMMITTED` · `RELEASED` · `EXPIRED` |
| `RESERVATION` | `COMMITTED` | yes | — |
| `RESERVATION` | `RELEASED` | yes | — |
| `RESERVATION` | `EXPIRED` | yes | — |
| `TRANSACTION` | `CREATED` | no | `RESERVED` · `FAILED` |
| `TRANSACTION` | `RESERVED` | no | `COMMITTED` · `RELEASED` · `EXPIRED` · `FAILED` |
| `TRANSACTION` | `COMMITTED` | yes | — |
| `TRANSACTION` | `RELEASED` | yes | — |
| `TRANSACTION` | `EXPIRED` | yes | — |
| `TRANSACTION` | `FAILED` | yes | — |

---

## 9 · EXTERNAL_BOUNDARIES

Economy 的依赖闭包**到此为止**：`node:sqlite` · `node:crypto` · `node:http`
（唯一一个出站原语，服务 Active→HomeNode 的 loopback 命令腿）· `node:path` ·
`node:fs`（唯一用途是 `mkdirSync(dataDir)`）· `runtime/db-failure.js` ·
彼此。零 SDK、零支付库、零凭据库、零 `process.env` 读取。

| 类别 | 冻结内容 |
| --- | --- |
| 允许的模块前缀 | `node:` · `services/home-node/economy-` · `./economy-` · `./economy/` · `../economy/` · `runtime/db-failure.js` |
| 禁止的模块（10） | `bridge/pay-gate.js` · `bridge/alipay-provider.js` · `bridge/payment-provider.js` · `active/payment-auth.js` · `active/shopping-execution.js` · `active/credential-vault.js` · `active/commerce.js` · `assets/js/commerce-adapter.js` · `assets/js/shopping-review.js` · `assets/js/payment-settings.js` |
| 禁止的标识符（13） | `topUpProvider` · `purchaseProviderCredits` · `updateProviderBalance` · `providerPayment` · `providerBillingMutation` · `purchaseRealCredits` · `sendPayment` · `submitPayment` · `submit_payment` · `commitSpend` · `pay_register_checkout` · `pay_set_config` · `pay_request_confirm` |
| 出站网络 | 只有 `node:http`；`createServer` / `listen` 在 Economy 闭包内为 0 |
| 实际 require 说明符（8） | `node:sqlite` · `node:crypto` · `node:http` · `crypto` · `fs` · `path` · `./economy-contract.js` · `../../runtime/db-failure.js` |

★ **标识符禁止 ≠ capability 禁止**：`FORBIDDEN_*` 的名字本身在 Economy 代码里
出现在**否认清单常量**中（那正是它们的用途）。因此这条边界由
**调用形态**判定，不由裸词扫描判定（P22-20 的教训）。

---

## 10 · UI_MODULES

Economy 的浏览器面**恰好九个文件**（六个 JS + 三个 CSS），
全部是 `<script>` / `<link>` 直载，没有 bundler、没有框架、没有第二份实现：

| Kind | Path |
| --- | --- |
| js | `assets/js/economy-approval-core.js` |
| js | `assets/js/economy-approval.js` |
| js | `assets/js/economy-configuration-core.js` |
| js | `assets/js/economy-configuration.js` |
| js | `assets/js/economy-shell-core.js` |
| js | `assets/js/economy-shell.js` |
| css | `assets/css/economy-approval.css` |
| css | `assets/css/economy-configuration.css` |
| css | `assets/css/economy-shell.css` |

### 10.1 浏览器只允许四类动作

| 类别 | 内容 | 它写什么 |
| --- | --- | --- |
| 查看 | 切页签 / 切筛选 / 展开细节 | 不写 |
| 解释 | 读时间线、读 Agent 的理由（原样展示） | 不写 |
| 批准 | 「允许继续」/「拒绝请求」 | `POST /internal/economy/approval-decision` |
| 配置 | 保存预算 / 自主规则、发一次初始额度 | `POST /internal/economy/configuration` |

### 10.2 UI authority 规则

| 分类 | 规则 |
| --- | --- |
| AUTHORITY | 必须能追到一条 canonical `GET` 字段（逐字透传） |
| PROJECTION | 只能重排 / 连接 / 格式化，不得改变含义 |
| DERIVED | 必须**显式标明**是页面自己算的（`computedByThisPage:true` 之类） |
| COPY | 静态文案，不得伪装成经济事实 |

页面**不得**自己重算余额、自己判断预算是否允许、自己判断批准是否有效、
自己判断购买是否成功、自己判断报价是否有效。

---

## 11 · FUTURE_NOT_PRESENT

下面每一个词在 Economy v1 里都**没有能力**。★ 但"没有能力"与"没有标识符"
是**两件不同的事**，因此每一行都必须给出 `status`，而且两栏都机器可验：

* `absent` —— 该标识符在 Economy 闭包里**一个都找不到**；
* `identifier-present` —— 标识符**存在**（在拒绝码 / 文档 / 休眠算术里），
  而**能力**不存在：生产调用方 0 · 路由 0 · capability 0 · command 0 · UI 入口 0。

| Word | status | 证据 |
| --- | --- | --- |
| `REFUND` | `identifier-present` | `TX_TYPE.REFUND` 已登记且对预算窗口 NEUTRAL；`PURCHASE_HAS_REFUND = false` · `PURCHASE_CANCEL_PRODUCES_A_LEDGER_REFUND = false`；**没有** `REFUND` 事件类型、没有操作、没有路由、没有 UI |
| `EXCHANGE` | `identifier-present` | `EXCHANGE_COMMITTED` 事件类型 + `computeExchangeAmount`（休眠算术，**零生产调用方**）+ `EXCHANGE_CROSS_DOMAIN_FORBIDDEN` 拒绝码；没有 capability、没有路由、没有 UI |
| `PROVIDER_BILLING` | `identifier-present` | 以 `PROVIDER_TOPUP` / `topUpProvider` 等词出现在**否认清单**里；Economy 闭包内零 provider 模块、零出站到 provider |
| `PROVIDER_QUOTA` | `identifier-present` | 以 `PROVIDER_BALANCE` / `provider-quota` 出现在**否认清单**与商品禁用字段里；没有任何读取 provider 余额/配额的路径 |
| `REAL_PAYMENT` | `identifier-present` | 以 `SEND_PAYMENT` / `submitPayment` / `commitSpend` 等词出现在**否认清单**里；Economy 闭包内零支付模块 |
| `HUMAN_DIRECT_BUY` | `identifier-present` | 以 `BUY` / `/economy/buy` 出现在**拒绝码**与 `/security` 的 `unreachable` 名单里；没有路由、没有命令、没有 UI 按钮 |
| `STORE_ADMIN` | `identifier-present` | 以 `/economy/store/create` · `/economy/store/update` · `/economy/product/create` · `/economy/product/update` 出现在 `unreachable` 名单里；目录写入面**故意不在 v1 公开面上**（§13 debt D1） |
| `MERCHANT` | `identifier-present` | 以 `merchant:alipay` / `merchant:external` / `seller:external` 出现在 `FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS` 里；`COMMIT_COUNTERPARTIES` 只有 `system:treasury` / `system:market`，**结构上点名不了一个商户** |
| `PROMOTION` | `identifier-present` | 以 `promo` / `promotion` 出现在 `FORBIDDEN_PRODUCT_FIELDS` 里；商品表里没有该列 |
| `DISCOUNT` | `identifier-present` | 以 `discount` / `discountRate` 出现在 `FORBIDDEN_PRODUCT_FIELDS` 与 `PURCHASE_INTENT_DERIVED_ECONOMIC_FACTS` 里；没有任何折扣算术 |
| `COUPON` | `identifier-present` | 以 `coupon` 出现在 `FORBIDDEN_PRODUCT_FIELDS` 与 `PURCHASE_INTENT_DERIVED_ECONOMIC_FACTS` 里；没有兑换路径 |

---

## 12 · 怎么被守住

| 断言 | 在哪 |
| --- | --- |
| 本文件每一张表 ↔ 真实路由 / seam / 契约封闭集 / `SCHEMA_VERSION` / 文件清单 | `tests/test_p22_21_economy_v1_freeze.js` |
| Fresh DB → 一次真实购买（含审批腿）→ 账本 / 库存 / 读面 / UI 纯层 | `tests/test_p22_21_economy_golden_path.js` |
| 六条失败金路径 fail closed | 同上 |
| §0 阶段账本 · §2 写面普查 · §3 读面普查 · §4 状态机叉积 · §6 崩溃边界 · §7 四资源隔离 · §8 UI authority | `tests/test_p22_21_economy_v1_closure_audit.js` |
| 审计全文与最终分类 | `docs/history/economy/P22/P22-21-ECONOMY-V1-CLOSURE.md` |

---

## 13 · 已知的、非阻塞的债务（不破坏 v1 的 authority / safety / correctness）

| id | 债务 | 为什么不阻塞 |
| --- | --- | --- |
| D1 | 目录（store / product）**没有** production 管理面：`putStore` / `putProduct` 的生产调用方是 0 | 目录**只**决定"有什么可买"，不决定"能不能买"。它由 `PUT_BUDGET_POLICY` / `PUT_AUTONOMY_POLICY` 与购买链上的每一条闸门约束；一个空目录的结果是"没有商品"，不是"越权" |
| D1-amend · P22-25 | ★ **这一行的前半句在 P22-25 变更了；后半句（"目录不决定能不能买"）一字未改。** `putStore` / `putProduct` 现在各有**恰好一个**生产调用方：`services/home-node/catalog-bootstrap.js`（目录 bootstrap 的**唯一** authority）。它由**装配层**在 `economyStore.open()` 之后调用一次、**早于任何请求**，而且**只在目录为空时**才进入写路径。D1 的原意（"没有管理面"）因此仍然成立：**没有任何 HTTP 路由、没有任何 GUI、没有任何 capability 能让用户 / Agent / AI 创建货架或商品** —— P22-21 §9 的 T5（http.js 的**代码**里 28 个 store 写动词零调用形态）一字未改。详见 `docs/P22-25-CATALOG-BOOTSTRAP.md` |
| D2 | `/economy/purchases` · `/economy/intents` 是 `created_at ASC` 的**最早**一窗，而 UI 把这一窗称为"近期" | 这是**读窗口**的措辞问题，不是权威问题：窗口不完整时页面显式说明（`saturated` / `truncated`）；余额与预算的权威数字来自另外两条读面 |
| D3 | 过期扫描（`expireDue*`）不是定时器：它由 `open()` 的对账与显式调用驱动 | 逾期状态在**读**侧被如实回答（`expiredByTime`）；`fail closed` 不依赖扫描是否跑过 |
| D4 | `P22-15C` 是唯一没有 doc 的阶段（只有 commit subject） | 它的 production diff 为 0；它只改了两条**既有**测试。v1 的契约面不受影响 |
| D5 | store 有 **19** 个 `const *_TABLE = '…'` 表名常量，`TABLES` 导出只有 **16** 项 —— 未导出的是 `AUTONOMY_POLICIES_TABLE` · `APPROVALS_TABLE` · `PURCHASE_INTENTS_TABLE`（另有 `POLICY_LIMIT_TABLE` 是**数组**而非表名常量，不计入 19） | 纯描述性缺口：三个未导出的表都有独立的、被断言的访问路径；不影响任何边界。★ 两个数字与三个名字都被测试逐字断言 |

---

## 14 · 给下一个人的一句话

```text
Economy v1 的公开面、写面、能力、币种、资产类别、事件类型、状态机、
外部边界与 UI 模块集合在 P22-21 冻结。

要新增它们中的任何一个 —— 一条路由、一个 capability、一个事件类型、
一个 schema 版本、一个 Economy 生产文件 —— 请**声明一个新阶段 / 新版本**
（例如 P23-x，或 ECONOMY_SCHEMA_VERSION = 8 + 一份新的 frozen contract）。
**不要静默扩 v1。**

Economy v1 frozen contract changed; declare a new phase/version instead of
silently extending v1.

`tests/test_p22_21_economy_v1_freeze.js` 会拦住你，并且它会告诉你
**具体是哪一个成员**多了或少了。
```
