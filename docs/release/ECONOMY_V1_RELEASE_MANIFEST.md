# Economy v1 · Release Manifest · `ECONOMY_V1_RELEASE_MANIFEST.md`

> **P22-Economy v1 · Release Packaging** 的交付物。
>
> 这是**打包**阶段的清单，不是开发阶段的文档：它**不新增、不修改、不修复**
> 任何东西 —— 它只把 P22-1 ~ P22-21 已经冻结的东西**列清楚**，
> 让下一个人可以归档、交接、恢复。
>
> ★ 权威仍然只有一份：`docs/contracts/economy/ECONOMY_V1_FROZEN_CONTRACT.md`。
> 本文件**描述**它，**不替代**它；两者冲突时以冻结契约为准，并且
> `tests/test_p22_21_economy_v1_freeze.js` 会先红。
>
> 基线 commit：`3ca6edc`（`P22-21 · freeze Economy v1 contract`）。
> 本阶段的 production diff = **0**。

---

## 1 · Identity

| Field | Value |
| --- | --- |
| Version | **Economy v1** |
| Status | **CLOSED WITH DOCUMENTED NON-BLOCKING DEBT** |
| Included phases | **P22-1 ~ P22-21**（22 个 commit） |
| Frozen at | `3ca6edc` |
| Frozen at (predecessor) | `45335f7` · P22-20 |
| Schema | **version 7**（`ECONOMY_SCHEMA_VERSION`，唯一真源 `services/home-node/economy-store.js`） |
| Closure classification | **B · CLOSED WITH DOCUMENTED NON-BLOCKING DEBT** |
| Authority violations (C) | **0** —— 22 个 canonical authority 各恰好一个定义点 |
| Orphan authorities (D) | **0** —— 每个 owner 符号都在生产代码里真的被引用 |
| Suspicious write bypass | **0** —— 49 个写动词里生产可达 7 个，全在三个 seam 或那道门里 |
| Impossible-but-observed state combinations | **0** —— 观察 7 个，结构上界 630 个 |

`ECONOMY_SCHEMA_VERSION` 只在七个阶段动过：P22-2（→1）· P22-3（→2）·
P22-4（→3）· P22-5（→4）· P22-6（→5）· P22-7（→6）· P22-8（→7）。
**P22-9 起一个字节都没有。**

---

## 2 · Included phases

| Phase | Commit | Subject |
| --- | --- | --- |
| P22-1 | `23bbe66` | freeze Agent Economy domain contract |
| P22-2 | `76de2b8` | add canonical Economy ledger and wallet runtime |
| P22-3 | `55acf37` | add Economy transaction and reservation lifecycle |
| P22-4 | `a92a0d7` | add deterministic Economy budget and quote policy |
| P22-5 | `f843b3b` | add Economy store catalog and inventory |
| P22-6 | `5b14634` | add atomic Economy purchase settlement |
| P22-7 | `5a10940` | add Economy approval and autonomous purchase policy |
| P22-8 | `c3612cc` | add Agent Economy purchase intent bridge |
| P22-9 | `0480c37` | add Economy runtime capability gate |
| P22-10 | `7881e3a` | add Economy action adapter |
| P22-11 | `37275f3` | add authenticated Active Economy command channel |
| P22-11 | `6492440` | record the aggregate evidence for the command channel |
| P22-12 | `c9d0d0c` | add Active Economy intent producer |
| P22-12 | `5919644` | record the aggregate evidence for the intent producer |
| P22-12C | `801d3c5` | audit the Agent Economy integration closure (read-only) |
| P22-13 | `6c541e2` | add Economy approval decision path |
| P22-14 | `e92a789` | add Economy bootstrap and configuration path |
| P22-15 | `72eda34` | add Economy approval UI |
| P22-15C | `46864b5` | close cache and Middle Brain baseline test debt |
| P22-16 | `68c6913` | add Economy configuration UI |
| P22-17 | `8edcb34` | add Economy store wallet and inventory UI |
| P22-18 | `7ab1d57` | add Economy experience polish |
| P22-19 | `e0e9b8f` | close Economy owner-scoped read model |
| P22-20 | `45335f7` | freeze Economy external boundaries |
| P22-21 | `3ca6edc` | freeze Economy v1 contract |

★ **P22-15C** 是唯一没有独立 doc 的阶段（D4）。

---

## 3 · Production files — the 7-file closure

`services/home-node/economy-*.js` **恰好七个**。第 8 个文件必须走新版本。

| # | Path | Bytes | SHA256 |
| --- | --- | --- | --- |
| 1 | `services/home-node/economy-contract.js` | 375752 | `fd25ddf476096929c822f95d3249d50e73f6d00e2e7910337a093d7b934ea00d` |
| 2 | `services/home-node/economy-store.js` | 886057 | `910114f7445df0d84a509df718b55768282592c9b6b40ff83d21b36dfcfb25da` |
| 3 | `services/home-node/economy-capability.js` | 19473 | `50f7f73a11a9583172608d5c4ee6fb7bc80e8b3df27bb06e68b73c376187f954` |
| 4 | `services/home-node/economy-action-adapter.js` | 30174 | `caa921079075327129c854ba1b2b7e295791549faa6f4ace8516bff7ad9b21a6` |
| 5 | `services/home-node/economy-command-channel.js` | 54812 | `fb61646a9d49b3090235ae9fbfb40844b42e42c3edb0ac3cded482b17c5e8fd5` |
| 6 | `services/home-node/economy-approval-decision.js` | 40603 | `7a060700fdac5478e87327c6cedfc1ecfd7dd8dd99c0f04ff8ab8a223cac79fb` |
| 7 | `services/home-node/economy-configuration.js` | 45937 | `33f8de97d75acdcee7c0b9060234aa63ea53579df7d363be4a85cbe0677956b9` |

| File | 角色 |
| --- | --- |
| `economy-contract.js` | 唯一**词汇与语义**真源：币种、资产类别、事件类型、状态机、封闭集、否认清单 |
| `economy-store.js` | 唯一**持久化**真源：SQLite schema v7、账本、派生余额、目录、库存、购买、审批、自主策略、意图 |
| `economy-capability.js` | 唯一**准入门**（capability gate，审计不是门） |
| `economy-action-adapter.js` | Agent/Action runtime ↔ Economy 的**适配器**（`bindActiveAgentEconomyAdapter`） |
| `economy-command-channel.js` | Active(23114) → HomeNode 的**命令通道**（唯一出站腿） |
| `economy-approval-decision.js` | 用户对等待中审批的**决定 seam** |
| `economy-configuration.js` | fresh install 的**配置 seam**（初始额度 / 预算 / 自主规则） |

### 3.1 Assembly integration points（不属于七文件闭包，但属于生产面）

这些文件**不是** Economy 依赖闭包的一部分（Economy 自己不 require 它们），
它们是**把 Economy 接进节点**的装配点。Economy 的依赖闭包到
`node:*` · 七个 `economy-*.js` · `runtime/db-failure.js` 为止（§9）。

| Path | Bytes | SHA256 | 角色 |
| --- | --- | --- | --- |
| `services/home-node-service.js` | 86079 | `a7e8e4977df10c871325e61622d47c0d81d2b2ea6449505db6e1272269a55c56` | `economyAssembly(options)` —— 全仓库**唯一**一处 Economy 装配（P22-2） |
| `services/home-node/http.js` | 142148 | `e2714d3e7743246219ee010ed8c079b08a62f6e5e421beb7ba790bfb74c301d6` | 路由判定：`/economy/*` 全是 GET，非 GET → `405 economy-is-read-only` |
| `services/active-message-service.js` | 28524 | `e2c1a09f254f4d7147709a15ddb0fc914202da99de8b344fadfe0cb071555596` | Active 侧提议生产 + 身份净化 |
| `active/economy-channel-client.js` | 8947 | `a06dd6bfc2418c9d54e14ecac9fbd1ce543831ea7c26b6f762ccc032ce5ee74a` | 23114 → 23118 的**唯一**出站腿 |
| `active/http.js` | 38491 | `e2db8c62c49c87d1c755860a0f4d19af029d3a14e90b2e06d0c46e1050e7afc6` | `POST /economy/propose-purchase` 的注入点（缺省时该路由不存在） |
| `assets/js/home-node-client.js` | 36182 | `964801fb59472eccfbce98a321e54cf24e4ab532935bf2b849111af983789208` | 浏览器 ↔ Home Node 的读面客户端 |
| `assets/js/home-node-bootstrap.js` | 66369 | `433be876aea4778ff46c35c204d50d3188065326c322e1a4fe493be420f95ebf` | 启动装配 |
| `runtime/db-failure.js` | 13649 | `4bdc213934581ed7366cb922b61d3b0ea1db0d23495013defde8ddd2b63c6065` | 唯一被允许的非 Economy 依赖（§9） |

---

## 4 · UI modules — exactly nine (six JS + three CSS)

| Kind | Path | Bytes | SHA256 |
| --- | --- | --- | --- |
| js | `assets/js/economy-approval-core.js` | 39634 | `e8ebb1823ad33c00e7e6a994567b95497f50e86c655616a7f2549dfd8ea11db6` |
| js | `assets/js/economy-approval.js` | 30068 | `8f53a907de8a389e5e40c149ac39d5918d9add461ace16005798828f01e94e1f` |
| js | `assets/js/economy-configuration-core.js` | 61863 | `a84690e16deeffa7f8e4f0803e9bb39a8f534da484fd5c9b8a4a54937a9d6da0` |
| js | `assets/js/economy-configuration.js` | 50813 | `6be275a70f5f96ee23753dfbafa2c1f6bb1b7b305a8c92a512626a653e3b4238` |
| js | `assets/js/economy-shell-core.js` | 85259 | `3142b0d46ca1f010aca0992e69778de3c1317de777d0775f867c1dea21225ebf` |
| js | `assets/js/economy-shell.js` | 67105 | `a39874e8ffed7b76b2fce31b3e0374f3cfa3cefba023cc4cfb1d682427073e55` |
| css | `assets/css/economy-approval.css` | 18386 | `f36a5620692ea66b2e9c7fe0e24f6e64509deea2831033ff7a4e0ee660359222` |
| css | `assets/css/economy-configuration.css` | 27076 | `5fb228963692a5ba1a989f6996718fbadad7305e4e53d71a1a686ab5fc793d32` |
| css | `assets/css/economy-shell.css` | 36303 | `ec2c8bc2f2e7f6bb048a772a002bf78d27419853036ce7f5947e6d5f8402aae9` |

`assets/` 下**没有第十个** Economy 文件（多一个 UI 模块也会让冻结守卫变红）。
全部是 `<script>` / `<link>` 直载：没有 bundler、没有框架、**没有第二份实现**。

| 交付阶段 | 模块 |
| --- | --- |
| P22-15 · approval UI | `economy-approval-core.js` · `economy-approval.js` · `economy-approval.css` |
| P22-16 · configuration UI | `economy-configuration-core.js` · `economy-configuration.js` · `economy-configuration.css` |
| P22-17/18 · store / experience | `economy-shell-core.js` · `economy-shell.js` · `economy-shell.css` |

★ 浏览器**只允许四类动作**：查看 · 解释 · **批准**（→ `POST /internal/economy/approval-decision`）
· **配置**（→ `POST /internal/economy/configuration`）。页面**不得**自己重算余额、
自己判断预算是否允许、自己判断批准是否有效、自己判断购买是否成功、自己判断报价是否有效。

---

## 5 · Read surfaces — 28 + 1

`GET /economy/*` 共 **28** 条，外加 **1** 条本机节点自述面 `/security`。
**没有第九类**（没有 POST/PUT/PATCH/DELETE 的读变体）。每一条都只读；
`/economy/*` 上的非 `GET` 一律 `405 economy-is-read-only`
（`/security` 走**另一条**兜底：非 `GET` → `404 no-route`）。

| # | Path | # | Path |
| --- | --- | --- | --- |
| 1 | `GET /economy/health` | 15 | `GET /economy/product` |
| 2 | `GET /economy/wallet` | 16 | `GET /economy/inventory` |
| 3 | `GET /economy/wallets` | 17 | `GET /economy/inventory-entry` |
| 4 | `GET /economy/ledger` | 18 | `GET /economy/purchases` |
| 5 | `GET /economy/transaction` | 19 | `GET /economy/purchase` |
| 6 | `GET /economy/changes` | 20 | `GET /economy/approvals` |
| 7 | `GET /economy/reservations` | 21 | `GET /economy/approval` |
| 8 | `GET /economy/reservation` | 22 | `GET /economy/autonomy-policies` |
| 9 | `GET /economy/policies` | 23 | `GET /economy/autonomy-policy` |
| 10 | `GET /economy/policy` | 24 | `GET /economy/autonomy-evaluation` |
| 11 | `GET /economy/budget` | 25 | `GET /economy/intents` |
| 12 | `GET /economy/quotes` | 26 | `GET /economy/intent` |
| 13 | `GET /economy/quote` | 27 | `GET /economy/store` |
| 14 | `GET /economy/stores` | 28 | `GET /economy/products` |
| +1 | `GET /security` | | |

### 5.1 排序权威（客户端**不得**重新排序）

| Path | 排序 | 权威 |
| --- | --- | --- |
| `/economy/changes` | 无 `ownerId`：`revision` 升序 keyset；带 `ownerId`：`order` ∈ {`asc`,`desc`}（且只能与 `ownerId` 同时出现） | canonical query |
| `/economy/purchases` · `/economy/intents` | `created_at ASC` —— **最早**一窗，不是最新一窗（D2） | canonical query |
| `/economy/products` | `sort_order ASC, created_at ASC` —— 不做个性化、不推荐、无排序分数 | canonical query |
| `/economy/inventory` | `updated_at DESC` | canonical query |

### 5.2 Owner scope

可选 `?ownerId=` 的面：`wallet` · `wallets` · `inventory` · `purchases` ·
`approvals` · `intents` · `policies` · `autonomy-policies` · `changes`（P22-19）。
过滤发生在 **canonical query** 里；投影层只做 filter / sort / project，
并且响应里逐字写着 `ownerScope` 与 `recomputesEconomyFacts:false`。

---

## 6 · Write surfaces — exactly three

写面**恰好三条**，全部 `POST`，**全部不在 `/economy/` 下**。
`/economy/*` 的只读性因此是一条**结构性事实**，不是一种约定。

| Method | Path | Envelope | Vocabulary | Credential | Consumer |
| --- | --- | --- | --- | --- | --- |
| `POST` | `/internal/economy/configuration` | `command` · `config` · `idempotencyKey` | `BOOTSTRAP_CREDIT` · `PUT_BUDGET_POLICY` · `PUT_AUTONOMY_POLICY` | 桌面凭据 `IB_HOME_NODE_TOKEN` | `home_node_authority` |
| `POST` | `/internal/economy/approval-decision` | `approvalId` · `decision` · `idempotencyKey` | `APPROVED` · `REJECTED` | 桌面凭据 `IB_HOME_NODE_TOKEN` | `user_decision_seam` |
| `POST` | `/internal/economy/command` | `command` · `commandId` · `idempotencyKey` · `proposal` | `ECONOMY_PROPOSE_PURCHASE` | 来源凭据 `IB_ECONOMY_CHANNEL_TOKEN` + 已登记来源端口 | `active_agent_runtime` |

三条**不共用**命令词、**不共用**信封、**不共用** consumer、**不共用**凭据。
三条都要求 loopback；**未配置凭据时整面 `503`**。

### 6.1 三条写面自述的"不存在的写形态"（`/security` 里逐字可读）

| Seam | 逐名否认 |
| --- | --- |
| configuration | `BUY` · `SETTLE` · `RESERVE` · `GRANT_INVENTORY` · `APPROVE` · `REJECT` · `REFUND` · `EXCHANGE` · `PROVIDER_TOPUP` · `REAL_PAYMENT` · `RAW_LEDGER_WRITE` |
| approval-decision | `BUY` · `SETTLE` · `RESERVE` · `GRANT` · `REFUND` · `LEDGER` · `AUTO_ALLOW` |
| command | `ECONOMY_BUY` · `ECONOMY_SETTLE` · `ECONOMY_RESERVE` · `ECONOMY_APPROVE` · `ECONOMY_RESUME` · `ECONOMY_GRANT` · `ECONOMY_LEDGER` · `ECONOMY_WALLET_MUTATE` |

### 6.2 生产可达的 store 写（恰好七个动词）

`bootstrapInitialCredit` · `putBudgetPolicy` · `putAutonomyPolicy` ·
`decideApproval` · `proposeAgentPurchaseIntent` · `appendCapabilityAudit`
（+ 审批续做链上的 `resumeApprovedPurchase`）。
49 个 store 写动词的普查结果：**生产可达 7 个** · **store 内部编排 32 个** ·
**tests-only 0** · **dead/unreachable 0** · **suspicious bypass 0**。

---

## 7 · Capabilities — exactly two

| Capability | 持有者 | 含义 |
| --- | --- | --- |
| `PROPOSE_PURCHASE` | `active_agent_runtime` | **提出**一个购买意图（提出 ≠ 允许） |
| `RESUME_APPROVED_PURCHASE` | `active_agent_runtime` · `user_decision_seam` | 把一条**已被用户批准**的意图继续做完 |

`home_node_authority` 与 `desktop_bridge` 的能力表**是空的**。

---

## 8 · Consumers — four

| Consumer | Runtime anchor | Capabilities |
| --- | --- | --- |
| `active_agent_runtime` | `runtime/component-registry.js#active`（端口 23114） | `PROPOSE_PURCHASE` · `RESUME_APPROVED_PURCHASE` |
| `home_node_authority` | `services/home-node-service.js#home-node`（端口 23118） | （空） |
| `desktop_bridge` | `bridge/…`（桌面桥） | （空） |
| `user_decision_seam` | `services/home-node-service.js#user-decision` | `RESUME_APPROVED_PURCHASE` |

### 8.1 不是 consumer 的面（`CAPABILITY_SURFACES_NOT_PRESENT`）

`chat` · `group_chat` · `voice` · `active_diary` · `moments_ui` · `mcp_client` · `llm`

★ 尤其：**`mcp_client` 零经济能力**，**`llm` 连身份都没有**，因此
"模型说买"不是一条授权路径。

---

## 9 · Frozen closed sets

| Set | 数量 | 成员 |
| --- | --- | --- |
| `CURRENCIES` | **6** | `IB_CREDIT` · `COMPUTE_STANDARD` · `COMPUTE_PREMIUM` · `ACTIVITY_POINT` · `IMAGE_CREDIT` · `VOICE_CREDIT` |
| `ASSET_KINDS` | **2** | `ITEM` · `COMPUTE` |
| `EVENT_TYPES` | **52** | 见 `ECONOMY_V1_FROZEN_CONTRACT.md` §7 |
| `SETTLEMENT_PRIMITIVES` | **3** | `INVENTORY` · `COMPUTE_ENTITLEMENT` · `SERVICE_EXECUTION` |
| State machines | **6** | `PURCHASE_INTENT` · `APPROVAL` · `PURCHASE` · `QUOTE` · `RESERVATION` · `TRANSACTION` |
| `FORBIDDEN_CURRENCY_TOKENS` | **41** | 法币与 provider 计费**逐字否认** |

`EVENT_TYPES` 的 52 个来源：P22-1 冻结 14 · P22-3 +3 · P22-4 +8 · P22-5 +8 ·
P22-6 +5 · P22-7 +10 · P22-8 +3 · P22-9 +1。

★ `EXCHANGE_COMMITTED` / `MINT_COMMITTED` / `BURN_COMMITTED` / `REFUND` 是
**账本交易类型**（`TX_TYPES`）在词表里的登记，**不是已实现的能力**。

---

## 10 · External boundaries — external = absent

Economy 的依赖闭包**到此为止**：

```text
node:sqlite · node:crypto · node:http · node:path · node:fs（唯一用途 mkdirSync(dataDir)）
runtime/db-failure.js
七个 economy-*.js 彼此
```

零 SDK · 零支付库 · 零凭据库 · **零 `process.env` 读取**。`createServer` / `listen`
在 Economy 闭包内为 **0**；唯一出站原语是 `node:http`，只服务 Active→HomeNode 的
loopback 命令腿。

| 类别 | 冻结内容 |
| --- | --- |
| 允许的模块前缀 | `node:` · `services/home-node/economy-` · `./economy-` · `./economy/` · `../economy/` · `runtime/db-failure.js` |
| 禁止的模块（**10**） | `bridge/pay-gate.js` · `bridge/alipay-provider.js` · `bridge/payment-provider.js` · `active/payment-auth.js` · `active/shopping-execution.js` · `active/credential-vault.js` · `active/commerce.js` · `assets/js/commerce-adapter.js` · `assets/js/shopping-review.js` · `assets/js/payment-settings.js` |
| 禁止的标识符（**13**） | `topUpProvider` · `purchaseProviderCredits` · `updateProviderBalance` · `providerPayment` · `providerBillingMutation` · `purchaseRealCredits` · `sendPayment` · `submitPayment` · `submit_payment` · `commitSpend` · `pay_register_checkout` · `pay_set_config` · `pay_request_confirm` |
| 实际 require 说明符（**8**） | `node:sqlite` · `node:crypto` · `node:http` · `crypto` · `fs` · `path` · `./economy-contract.js` · `../../runtime/db-failure.js` |

### 10.1 `FUTURE_NOT_PRESENT`（11 个词：**没有能力** ≠ **没有标识符**）

| Word | status | 说明 |
| --- | --- | --- |
| `REFUND` | `identifier-present` | `TX_TYPE.REFUND` 已登记且对预算窗口 NEUTRAL；`PURCHASE_HAS_REFUND = false`；**没有**事件类型、操作、路由、UI |
| `EXCHANGE` | `identifier-present` | `EXCHANGE_COMMITTED` 事件类型 + `computeExchangeAmount`（休眠算术，**零生产调用方**）+ `EXCHANGE_CROSS_DOMAIN_FORBIDDEN` 拒绝码；没有 capability / 路由 / UI |
| `PROVIDER_BILLING` | `identifier-present` | 以 `PROVIDER_TOPUP` / `topUpProvider` 出现在**否认清单**里；闭包内零 provider 模块、零出站 |
| `PROVIDER_QUOTA` | `identifier-present` | 以 `PROVIDER_BALANCE` / `provider-quota` 出现在**否认清单**与商品禁用字段里；没有任何读取 provider 余额/配额的路径 |
| `REAL_PAYMENT` | `identifier-present` | 以 `SEND_PAYMENT` / `submitPayment` / `commitSpend` 出现在**否认清单**里；闭包内零支付模块 |
| `HUMAN_DIRECT_BUY` | `identifier-present` | 以 `BUY` / `/economy/buy` 出现在**拒绝码**与 `unreachable` 名单里；没有路由、命令、UI 按钮 |
| `STORE_ADMIN` | `identifier-present` | 以 `/economy/store/create` · `/economy/product/update` 等出现在 `unreachable` 名单里；目录写入面**故意不在 v1 公开面**（D1） |
| `MERCHANT` | `identifier-present` | 以 `merchant:alipay` / `seller:external` 出现在 `FORBIDDEN_PURCHASE_LEDGER_ACCOUNTS` 里；`COMMIT_COUNTERPARTIES` 只有 `system:treasury` / `system:market`，**结构上点名不了一个商户** |
| `PROMOTION` | `identifier-present` | 以 `promo` / `promotion` 出现在 `FORBIDDEN_PRODUCT_FIELDS` 里；商品表没有该列 |
| `DISCOUNT` | `identifier-present` | 以 `discount` / `discountRate` 出现在 `FORBIDDEN_PRODUCT_FIELDS` 与 `PURCHASE_INTENT_DERIVED_ECONOMIC_FACTS` 里；没有任何折扣算术 |
| `COUPON` | `identifier-present` | 以 `coupon` 出现在同上两处；没有兑换路径 |

这 11 个词的**能力面**（capability / command / event / route 四个封闭集合）
命中数 = **0**。而它们的**标识符**出现在**否认清单与拒绝码**里 ——
那正是它们的用途。

---

## 11 · Known non-blocking debt

D1–D5 在 `docs/contracts/economy/ECONOMY_V1_FROZEN_CONTRACT.md` §13 逐格冻结；
**D6 只在 `docs/P22-21-ECONOMY-V1-CLOSURE.md` §13**（冻结契约本身是 P22-21 的
交付物，本打包阶段**不改它**）。

| id | Debt | 为什么不阻塞 | 权威位置 |
| --- | --- | --- | --- |
| **D1** | 目录（store / product）**没有** production 管理面：`putStore` / `putProduct` 的生产调用方 = **0** | 目录只决定"有什么可买"，不决定"能不能买"；它被预算 / 自主 / 每一次结算的闸门约束。空目录的结果是"没有商品"，不是"越权" | 契约 §13 · 闭合 §13 |
| **D2** | `/economy/purchases` · `/economy/intents` 是 `created_at ASC` 的**最早**一窗，而 UI 把这一窗称为"近期" | 读**窗口措辞**问题，不是权威问题：窗口满时页面显式说明（`saturated` / `truncated`）；余额与预算的权威数字来自另外两条读面 | 契约 §13 · 闭合 §13 |
| **D3** | 过期扫描（`expireDue*`）**不是定时器**：由 `open()` 的对账与显式调用驱动 | 逾期在**读**侧被如实回答（`expiredByTime`）；fail closed 不依赖扫描是否跑过。store 里连一个 `setInterval` 都没有（测试断言） | 契约 §13 · 闭合 §13 |
| **D4** | `P22-15C` 是唯一**没有 doc** 的阶段（只有 commit subject） | 它的 production diff = 0，只改了两条**既有**测试；v1 契约面不受影响 | 契约 §13 · 闭合 §13 |
| **D5** | store 有 **19** 个 `const *_TABLE` 表名常量，`TABLES` 只导出 **16** 项（未导出：`AUTONOMY_POLICIES_TABLE` · `APPROVALS_TABLE` · `PURCHASE_INTENTS_TABLE`） | 纯描述性缺口：三个未导出的表都有独立的、被断言的访问路径。两个数字与三个名字都被测试逐字冻结 | 契约 §13 · 闭合 §13 |
| **D6** | **批准被拒绝之后，Intent 保持 `WAITING_APPROVAL`**（终态化是**惰性**的，下一次执行时才被判失败） | 它**不能**产生任何经济事实：approval 是终态 `REJECTED`（单次使用），再点头被 `409` 拒绝，propose 重发只回同一条 intent，世界逐字不变 —— 三条都真跑过。intent 的 state 在契约里**自述**"编排事实，不是经济事实"（`stateIsAnEconomicFact: false`）。仍记为债务：读起来会让人以为还有事要发生 | **仅闭合 §13** |

**六条债务没有一条**会让越权事实成立或让 fail closed 失效。
这就是最终分类是 **B** 而不是 **C** 的理由。

---

## 12 · How this release is guarded

| 断言 | 在哪 |
| --- | --- |
| 冻结契约每一张表 ↔ 真实路由 / seam / 封闭集 / `SCHEMA_VERSION` / 文件清单 | `tests/test_p22_21_economy_v1_freeze.js`（**51** 项，含灵敏度自测 Y1–Y4） |
| Fresh DB → 一次真实购买（审批腿）→ 账本 / 库存 / 读面 / UI 纯层 | `tests/test_p22_21_economy_golden_path.js`（**57** 项） |
| 阶段账本 · 写面普查 · 读面普查 · 状态机叉积 · 崩溃边界 · 四资源隔离 · UI authority | `tests/test_p22_21_economy_v1_closure_audit.js`（**40** 项） |
| 全仓库登记 | `tests/test-all.js`（`--quick` = `static` + `p22-ui`） |

合计经济闭包 **148** 条断言。`test_p22_21_economy_v1_freeze.js` 是**打包前必须
全绿**的那一条：它不绿就说明"你打的不是冻结的那个版本"。

---

## 13 · 完整的 P22 测试清单（54 个文件）

| 文件 | 是否登记在 `tests/test-all.js` |
| --- | --- |
| `tests/test_p22_1_economy_boundary.js` | ✅ |
| `tests/test_p22_1_economy_domain_contract.js` | ✅ |
| `tests/test_p22_2_economy_runtime.js` | ✅ |
| `tests/test_p22_2_economy_store.js` | ✅ |
| `tests/test_p22_3_economy_reservation.js` | ✅ |
| `tests/test_p22_3_economy_runtime.js` | ✅ |
| `tests/test_p22_4_economy_budget.js` | ✅ |
| `tests/test_p22_4_economy_quote.js` | ✅ |
| `tests/test_p22_4_economy_runtime.js` | ✅ |
| `tests/test_p22_5_economy_catalog.js` | ✅ |
| `tests/test_p22_5_economy_inventory.js` | ✅ |
| `tests/test_p22_5_economy_runtime.js` | ✅ |
| `tests/test_p22_6_economy_purchase.js` | ✅ |
| `tests/test_p22_6_economy_runtime.js` | ✅ |
| `tests/test_p22_6_economy_settlement.js` | ✅ |
| `tests/test_p22_7_economy_approval.js` | ✅ |
| `tests/test_p22_7_economy_autonomy.js` | ✅ |
| `tests/test_p22_7_economy_runtime.js` | ✅ |
| `tests/test_p22_8_economy_decision_bridge.js` | ✅ |
| `tests/test_p22_8_economy_intent.js` | ✅ |
| `tests/test_p22_8_economy_runtime.js` | ✅ |
| `tests/test_p22_9_economy_capability.js` | ✅ |
| `tests/test_p22_9_economy_runtime.js` | ✅ |
| `tests/test_p22_10_economy_action_adapter.js` | ✅ |
| `tests/test_p22_10_economy_active_runtime.js` | ✅ |
| `tests/test_p22_11_economy_active_bridge.js` | ✅ |
| `tests/test_p22_11_economy_command_channel.js` | ✅ |
| `tests/test_p22_12_economy_active_plan.js` | ✅ |
| `tests/test_p22_12_economy_intent_producer.js` | ✅ |
| `tests/test_p22_13_economy_approval_decision.js` | ✅ |
| `tests/test_p22_13_economy_approval_runtime.js` | ✅ |
| `tests/test_p22_14_economy_bootstrap_runtime.js` | ❌ **未登记** |
| `tests/test_p22_14_economy_configuration.js` | ❌ **未登记** |
| `tests/test_p22_14_economy_configuration_ui.js` | ✅ |
| `tests/test_p22_15_economy_approval_ui.js` | ✅ |
| `tests/test_p22_15_economy_approval_ui_core.js` | ✅ |
| `tests/test_p22_15_economy_approval_visual.js` | ✅ |
| `tests/test_p22_16_economy_configuration_ui.js` | ✅ |
| `tests/test_p22_16_economy_configuration_ui_core.js` | ✅ |
| `tests/test_p22_16_economy_configuration_visual.js` | ✅ |
| `tests/test_p22_17_economy_store_ui.js` | ✅ |
| `tests/test_p22_17_economy_store_ui_core.js` | ✅ |
| `tests/test_p22_17_economy_store_visual.js` | ❌ **未登记** |
| `tests/test_p22_18_economy_experience_ui.js` | ✅ |
| `tests/test_p22_18_economy_experience_ui_core.js` | ✅ |
| `tests/test_p22_18_economy_experience_visual.js` | ✅ |
| `tests/test_p22_19_economy_owner_scope.js` | ✅ |
| `tests/test_p22_19_economy_owner_scope_http.js` | ✅ |
| `tests/test_p22_19_economy_read_contract.js` | ✅ |
| `tests/test_p22_20_economy_boundary_injection.js` | ✅ |
| `tests/test_p22_20_economy_external_boundary.js` | ✅ |
| `tests/test_p22_20_economy_public_surface.js` | ✅ |
| `tests/test_p22_21_economy_golden_path.js` | ✅ |
| `tests/test_p22_21_economy_v1_closure_audit.js` | ✅ |
| `tests/test_p22_21_economy_v1_freeze.js` | ✅ |

★ **54 个文件在盘，51 个登记在 `tests/test-all.js`。** 未登记的三个**全部真跑过
并通过**（`34/34` · `61/61` · `92/92`）—— 这不是"坏了"，而是**登记集的缺口**：
`static` 组不跑它们。这是打包阶段**发现**的事实，打包阶段**不修**它（禁止修复债务）。

---

## 14 · 给下一个人

```text
Economy v1 的公开面、写面、能力、币种、资产类别、事件类型、状态机、
外部边界与 UI 模块集合在 P22-21 冻结。

要新增它们中的任何一个 —— 一条路由、一个 capability、一个事件类型、
一个 schema 版本、一个 Economy 生产文件 —— 请声明一个新阶段 / 新版本
（例如 P23-x，或 ECONOMY_SCHEMA_VERSION = 8 + 一份新的 frozen contract）。
不要静默扩 v1。

Economy v1 frozen contract changed; declare a new phase/version instead of
silently extending v1.
```

恢复这个版本的最短路径：

```bash
node tests/test_p22_21_economy_v1_freeze.js    # 必须 51/51 PASS
```

它不绿 = 你手上的不是 Economy v1。

---

## 15 · Release package

### 15.1 Artifacts

| Artifact | Path | Bytes |
| --- | --- | --- |
| Packaged tree | `Economy-v1-release/` | `7103030`（文件内容） |
| Integrity manifest | `Economy-v1-release/ECONOMY_V1_CHECKSUMS.txt` | — |
| Build & verify script | `Economy-v1-release/build-package.js` | — |
| Orientation | `Economy-v1-release/README.txt` | — |

| Field | Value |
| --- | --- |
| 校验行条数 | **`152`** |
| 打包树文件数 | **`154`**（= 校验行条数 + `ECONOMY_V1_CHECKSUMS.txt` + `README.txt`） |
| Root directory after extraction | `InternalBeyond-Economy-v1/` |

★ 本节只描述**形态**；所有实值在 §16.4 的**唯一**一张表里。

★ **本文件刻意不写包自身的 `manifestSha256` 摘要。** 这不是省略，是**不可自指
规则**：本文件**在包里**，而那个摘要的输入里**包含本文件**。把它写进本文件，
`build-package.js` 就会读到一个由自己上一轮写下的值 —— 一个**永不收敛的循环**
（本阶段实测到它：连跑 10 轮，每轮摘要都不同）。

因此身份分成两处，各自**都能独立复算**：

| 谁的身份 | 写在哪 | 怎么复算 |
| --- | --- | --- |
| **包**的身份（`ENTRY_COUNT` + `manifestSha256`） | `ECONOMY_V1_CHECKSUMS.txt` 的**注释头**里（注释不参与摘要，所以不循环） | `node build-package.js --verify .` |
| **归档**的身份（`ARCHIVE_BYTES` + `ARCHIVE_SHA256` + 成员数） | **包外面**：仓库这份 manifest + `.sha256` sidecar | `sha256sum -c InternalBeyond-Economy-v1.tar.gz.sha256` |

★ `校验行条数` 与 `打包树文件数` 可以写在本文件里，因为它们**不依赖本文件的
字节内容**：多一个数字不改变行数，也不改变任何被摘要的文件的内容。
`PACKAGED_BYTES` 同理（占位符与实值的位数在构建时是固定的）。

### 15.1.1 The archive measures itself **outside** the package**

```text
InternalBeyond-Economy-v1.tar.gz            the seal
InternalBeyond-Economy-v1.tar.gz.sha256     the seal's digest, beside it
```

★ **归档的摘要刻意不写进包内。** 这不是省略，是**不可自指规则**的第二次应用：
本文件**在包里**，在文件里写下压缩包自身的摘要，会让摘要随被摘要的内容变化 ——
一个永远收敛不了的循环。

因此身份的**单一自洽点**是**包内那一对**：

```bash
node build-package.js --verify .    # 重算 ENTRY_COUNT 与 manifestSha256 并比对
```

而**归档**的身份写在包**外面**（`.sha256` sidecar），并且它本身是**可复现**的 ——
而且不是"希望它可复现"，是**改成可复现**：

`tar -czf` **不可复现**（tar 记 mtime、gzip 记打包那一刻的墙钟时间），这一点在
本阶段被**实测到**：同一棵树连封两次，两个摘要不同。因此归档改由
`build-package.js` 自己写：固定成员顺序（目录名排序）、固定 `mtime = 0`、
固定 `mode/uid/gid`、gzip 带 `mtime:0` 且不写文件名。之后连封两次得到
**同一个摘要**（§16.4）。

★ `ECONOMY_V1_CHECKSUMS.txt` **不给自己**算 checksum，`README.txt` 记录的是
identity 而不是自身摘要 —— 两者都不可自指。身份由 `fileCount` +
`manifestSha256`（对全部校验行的摘要）给出，`build-package.js --verify .`
会**重算**这两个值再比对，所以"文件数量一致"不是靠数数，而是靠一个可复算的摘要。

### 15.2 打包内容（151 个 release 文件，按角色）

| 角色 | 数量 | 内容 |
| --- | --- | --- |
| Core production（**7 文件闭包**） | 7 | `services/home-node/economy-*.js` |
| Assembly seams | 5 | `services/home-node-service.js` · `services/home-node/http.js` · `services/active-message-service.js` · `active/economy-channel-client.js` · `active/http.js` |
| UI modules | 9 | 六个 `assets/js/economy-*.js` + 三个 `assets/css/economy-*.css` |
| Tests | 54 | 整个 `tests/test_p22_*.js` |
| Test fixtures | 7 | `tests/fixtures/p22-*.js`（崩溃注入 worker + 真实进程 fixture） |
| Docs | 4 | 冻结契约 · 闭合 · **本 manifest** · 公开面 |
| Per-phase docs | 23 | `docs/P22-*-ECONOMY-*.md` |
| Support plane | 40 | 装配层真实 `require` 闭包所带出的传递依赖（不在上面任何一类里的） |
| Meta | 2 | `LICENSE` · `VERSION` |

**Support plane 是怎么进包的**：不是手列的。`build-package.js` 从三个装配文件
出发走**真实 require 闭包**（含 `path.join(__dirname, …)` 与
`path.join(ASSETS_JS, …)` 这种字面扫描看不见的边 —— 金路径测试恰好踩在
`thread-retrieval.js → assets/js/thread-derivation-core.js` 这条上），
并且**在闭包里剪掉 §9 的那十个禁止模块**。

| 证明 | 结果 |
| --- | --- |
| 十个禁止模块出现在包里 | **0** —— `bridge/` 整个目录不在包里 |
| 包内 `require` 的闭合性 | 由 §16 的实跑证明：三条守卫在解压副本里全绿 |

### 15.3 明确**不在**包里

| 排除项 | 理由 |
| --- | --- |
| `node_modules/` · 缓存 · 日志 · `*.sqlite` / `*.db` / `-wal` / `-shm` | 要求 |
| 截图（`*.png` 等） | 要求；P22-15~19 的视觉截图都在 `%TEMP%`，本来就不在仓库里 |
| 用户数据 | 要求 |
| `.git/` | 这不是 checkout，是 release |
| `bridge/*` 与六个支付/commerce 模块 | **§9 的十个禁止模块** —— 它们**在功能上不属于** Economy 闭包 |
| `InternalBeyond.html` + 其余 114 个应用外壳资产 | ★ 见下 |

★ **浏览器视觉三测不能从这个包里跑**，这是**刻意的取舍**，不是遗漏：

```text
test_p22_15_economy_approval_visual.js
test_p22_16_economy_configuration_visual.js
test_p22_17_economy_store_visual.js
```

这三条测试用 `file://` 打开 `InternalBeyond.html`。而 `InternalBeyond.html`
是一个引用了 **137 个资产**的单体应用外壳：其中 **114 个属于别的域**
（`assets/js/memory/*` · `role-dm/*` · `game/*` · 20 个别的 CSS …），
**其中六个正是 Economy 被冻结"永不依赖"的支付/commerce 模块**
（`active/commerce.js` · `active/payment-auth.js` · `active/shopping-execution.js` ·
`assets/js/commerce-adapter.js` · `assets/js/shopping-review.js` ·
`assets/js/payment-settings.js`）。

把它们装进来，这个包就不再是 **Economy v1** 的发布包，而是整个应用
（多 4.5 MB、多 114 个与 Economy 无关的文件、并且**亲手推翻了 §9 的那条边界**）。
因此选择是：**包保持 Economy 作用域**，那三条视觉测试属于**全仓库 CI**，
不属于发布包。P22-21 的 148 条经济闭包断言**没有一条**依赖它们。

### 15.4 归档形态

```text
InternalBeyond-Economy-v1.tar.gz
└── InternalBeyond-Economy-v1/
    ├── README.txt
    ├── ECONOMY_V1_CHECKSUMS.txt
    ├── build-package.js
    ├── LICENSE · VERSION
    ├── docs/                 （27 个 .md）
    ├── services/             （home-node-service.js · active-message-service.js · home-node/…）
    ├── active/               （economy-channel-client.js · http.js · 传递依赖）
    ├── runtime/              （db-failure.js · service-control.js）
    ├── assets/js · assets/css（九个 Economy 模块）
    └── tests/ + tests/fixtures/
```

仓库相对路径在解压根之下**逐段保持**（`docs/` · `services/home-node/` ·
`assets/js/` · `tests/`）。tar 成员时间戳被归一到 `2024-01-01T00:00:00Z`，
所以同内容两次打包产生同序成员。

---

## 16 · Final verification

### 16.1 打包前

```text
node tests/test_p22_21_economy_v1_freeze.js
P22-21 · freeze drift guard：51 / 51 通过      ← PASS（要求的那一条）
临时目录：残留 0 个（目标 0）
```

### 16.2 打包后 · 解压到临时目录再验证

解压目标：`%TEMP%\ib-econ-v1-verify\`（不在仓库里）。

| 检查 | 结果 |
| --- | --- |
| 解压后顶层 | 恰好一个目录 `InternalBeyond-Economy-v1/` |
| Manifest 存在 | `docs/ECONOMY_V1_RELEASE_MANIFEST.md` ✓ · `docs/ECONOMY_V1_FROZEN_CONTRACT.md` ✓ · `docs/P22-21-ECONOMY-V1-CLOSURE.md` ✓ |
| `ECONOMY_V1_CHECKSUMS.txt` 存在 | ✓ |
| Checksum 一致 | **逐行逐字节相同**，`mismatches: []` |
| 文件数量一致 | `entriesExpected` = `entriesFound` → `countMatch: true` |
| identity 摘要一致 | `manifestSha256` 由**解压副本自己重算**，`Matches: true` |
| 完整性总判 | `{"ok": true}` |
| 实值 | 全部在 §16.4 的**唯一**一张表里 |

### 16.3 打包后 · 从**解压副本**真跑三条守卫

```text
node tests/test_p22_21_economy_v1_freeze.js        51 / 51 通过
node tests/test_p22_21_economy_golden_path.js      57 / 57 通过
node tests/test_p22_21_economy_v1_closure_audit.js 40 / 40 通过
                                                    合计 148 / 148
临时目录：残留 0 个（目标 0）
```

★ 这 148 条**不是**在仓库里跑的复述：它们是在解压出来的那一份代码上跑的，
`entriesFound` 与 `manifestSha256` 都从**那一份**文件重算。

### 16.4 实测值 · 唯一权威表（全部来自真实运行）

| # | 量 | 值 | 权威位置 |
| --- | --- | --- | --- |
| 1 | `ENTRY_COUNT` | **`152`** | 本文件 + `ECONOMY_V1_CHECKSUMS.txt` |
| 2 | `PACKAGED_FILES` | **`154`** | 本文件 |
| 3 | `PACKAGED_BYTES` | **`7103030`** | 本文件 |
| 4 | 包身份 `manifestSha256` | 见 `ECONOMY_V1_CHECKSUMS.txt` 注释头（**不写在本文件** —— 它哈希本文件，写进来就是自指） | `ECONOMY_V1_CHECKSUMS.txt` |
| 5 | `ARCHIVE_BYTES`（归档字节数） | **`2073722`** | 本文件 + `.sha256` sidecar |
| 6 | `ARCHIVE_MEMBERS`（归档文件成员数） | **`154`** | 本文件 |
| 7 | `ARCHIVE_SHA256` | `d26177f5f7758154056879f731ba9038ee79d96e1112096e78d1c90fd5ef4ca3` | 本文件 + `.sha256` sidecar |
| 8 | 归档连封三次是否同摘要 | **是**（三次逐字节相同） | 本文件（finalize 断言） |
| 9 | `tar -czf` 连封三次是否同摘要 | **否** —— 这就是为什么归档不用 `tar` 写 | 本文件（finalize 实测） |
| 10 | 归档里是否出现它自己的摘要 | **否**（`archiveDigestLeaksIntoArchive: false`） | 本文件（finalize 断言） |
| 11 | Sidecar | `InternalBeyond-Economy-v1.tar.gz.sha256`（与归档同级，**不在包内**） | 本文件 |

### 16.5 三条"为什么这么设计"（每条都由一次失败换来）

| 设计 | 之前是什么样 | 为什么现在是这样 |
| --- | --- | --- |
| 包身份摘要**不**写进本文件 | 曾写进本文件的一行里 | `build-package.js` 会读回自己上一轮写下的值 → **连跑 10 轮都不收敛**。改成写在 `ECONOMY_V1_CHECKSUMS.txt` 的**注释头**（注释不参与摘要）之后，一轮收敛 |
| 归档摘要**只**写在包外面 | 曾试图写进包内 | 摘要在包内 → 摘要随被摘要内容变化 → 永不收敛。现在写进仓库这份 manifest 与 `.sha256` sidecar |
| 归档**不用** `tar -czf` | 曾用 `tar -czf` | 同一棵树连封两次得到**两个不同摘要**（tar 记 mtime、gzip 记墙钟）。改成固定成员顺序 + `mtime = 0` + `gzip {mtime:0}` 之后，连封三次同摘要 |

★ 这一份是**仓库副本**：第 5/6/7 格写的是**实测数值**（与 `.sha256` sidecar 互证）。包内那一份同样的三格写的是"见 sidecar" —— 归档包含那份文件，写进去就是自指。两份除这三格外逐字节相同。

---

## 17 · Known debt carried into this release

**D1–D6 六条，一条不少。** 打包阶段**不修**任何一条（禁止修复债务），
也不新增任何一条语义债务 —— §13 的编号与内容在这里逐字延续。

打包阶段**新发现并记录**的两条**打包性**事实（不是经济语义债务，因此
不占用 D 编号）：

| id | 事实 | 影响 |
| --- | --- | --- |
| **P-1** | `tests/test_p22_14_economy_bootstrap_runtime.js` · `tests/test_p22_14_economy_configuration.js` · `tests/test_p22_17_economy_store_visual.js` 三个文件在盘上但**未登记**在 `tests/test-all.js`（54 在盘 / 51 登记） | 三条**全部真跑过并通过**（`34/34` · `61/61` · `92/92`）。`static` 组因此不跑它们。修复它 = 改 `tests/test-all.js` = 下一步的事，不是这一步 |
| **P-2** | `InternalBeyond.html` 单页引用 **137** 个资产，其中 **114** 个与 Economy 无关、**6** 个是 §9 的禁止模块 | 三条浏览器视觉测试必须留在全仓库 CI，不能进发布包（§15.3） |

---

## 18 · 给下一个人的一句话（打包版）

```text
这个包能跑、能验、能归档，但它是 Economy 的包，不是整个应用的包。

收下它 = 收下 Economy v1 的冻结面 + 它的装配缝 + 它的九个 UI 模块 +
它的 54 条 P22 测试 + 让它真的能加载的那点传递依赖。

包里没有的东西**不是漏了**：
  · 十个禁止模块 —— 因为 §9 说 Economy 永不依赖它们；
  · 应用外壳与另外 114 个资产 —— 因为那属于别的域；
  · 三条浏览器视觉测试 —— 因为它们需要的是那个外壳。

要动这个包里的任何一个字节，先想清楚：你改的是发布物，还是仓库？
发布物改了 = 校验和会红；仓库改了 = 冻结守卫会红。两个都会告诉你。
```

