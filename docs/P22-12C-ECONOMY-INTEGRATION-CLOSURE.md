# P22-12C · Agent Economy Integration Closure Audit

**性质**：只读总审计。本文件是全仓库**唯一**的产出。

**基线**：`c9d0d0c`（P22-12 · add Active Economy intent producer）· `5919644`（P22-12 · record the aggregate evidence）

**取证方式**：从当前生产代码反向取证，**不引用任何 P22 文档的结论**。每一条
判断都给出 `file:line`。本阶段允许的手段只有静态扫描与既有轻量单进程测试。

**资源纪律执行结果**

```text
child process（本审计自己 spawn 的） = 0
spawn / detached = 0        Desktop = 0     Electron = 0
Playwright = 0              DSH = 0
生产文件改动 = 0             schema 改动 = 0
prompt 改动 = 0             测试语义改动 = 0
```

唯一执行的命令是 `node tests/test_p22_*.js`（29 个已存在的单进程/既有测试，
两次共 44 次运行，见 §9）。**没有**重跑 P22-6～P22-11 已经证明过的多进程性质
——那些性质的证据在各自的 commit 里，本阶段只统计它们的**成本**。

---

## 0 · 结论摘要

```text
§1 canonical production chain        —— 成立（逐段 file:line 见正文）
§2 Authority Matrix                  —— 成立（Economy → Memory/Relationship/Provider/Payment = 0）
§3 四种钱隔离                        —— 全部结构性 NO
§4 模型 authority                    —— 只能决定 WANT；catalog grounding 成立；none 一等
§5 重复机制                          —— 三层，各有唯一 owner；无争权；一处**未被行使**（非缺陷）
§6 schema / migration                —— 闭合（watermark-first；退回 SCHEMA_TOO_NEW；不伪造历史）
§7 public surface                    —— 28 条 GET，0 条普通写；唯一跨进程 command 一个
§8 UI readiness                      —— 9 项 READY / 1 项 PARTIAL / 1 项 MISSING
§9 测试债务                          —— 1 个 load-sensitive flake；0 个 Economy regression
§10 Backend Core Closed              —— NO（1 个 blocker）
```

**唯一 blocker**：**批准决定的写入口在生产代码里没有调用方**。默认部署
（没有任何 autonomy policy）下 `AUTONOMY_DEFAULT_WHEN_NO_POLICY = REQUIRE_APPROVAL`
（`services/home-node/economy-contract.js:4108`），因此模型提出的每一条购买意图
都会走到 `WAITING_APPROVAL` 并**永久停在那里**：`decideApproval` 与
`resumeAgentPurchaseIntent` 在生产代码里的调用方数都是 0，HTTP 面为 0，
跨进程 command 面为 0。详见 §10.2。

这不是授权层的缺陷（三层授权逐条正确），而是**可达性**缺陷：一条已经写好的
canonical 生命周期在今天的产品组合里走不到终点。按"必须由当前代码证据决定"
的要求，答案是 NO。

---

## 1 · canonical production chain（重新取证）

### 1.1 浏览器侧（23114）

| # | 环节 | 位置 | 事实 |
|---|---|---|---|
| 1 | Active prompt 组装 | `assets/js/active-diary/active-plans.js:372` `buildPlanPrompt` | 经济段是**条件块**：`active-plans.js:386-387`（`economyCatalog.length>0` 才 `economyOffered`），动作示例 `active-plans.js:416-417`，说明段 `441-452` |
| 2 | 结构化输出解析 | 同文件 `_activeParsePlanJson`（`active-plans.js:88`） | **P22-12 一行未改** |
| 3 | 既有净化器（模型动作白名单） | `active-plans.js:107` `_activeValidatePlanResult` → `:117` 分流 → `:121` `_activeValidatePlanResultCore`（三个既有动作） / `:313` `_activeValidateEconomyPlanResult` | 经济动作**走同一个入口函数**，不是新的解析路径 |
| 3a | 构造式白名单 | `active-plans.js:260-308` | 顶层动作键白名单 `:263-266`；七个身份键双向拒绝 `:269-272`；proposal 键白名单 `:277-280`；`units` 不做字符串修复 `:296-300` |
| 3b | 身份注入（不由模型自报） | `active-plans.js:317-319` | `ctx.agentId` 来自本地角色配置；模型写 agentId 一律 `:279` 整条拒绝 |
| 3c | canonical 幂等身份 | `active-plans.js:343-348` + `:327` | 由 proposal 的指纹字段推导（不含 reason）；模型给的那个只留在 `modelIdempotencyKey` 旁证位 |
| 4 | 净化后出口 | `active-plans.js:590` `NS.activeEconomyProposalSink`（注入缺席即 fail closed 并记日志 `:592`） | 出口**只有**这一个；`:531/535/537/542/547` 是目录注入，与本出口无关 |
| 5 | 生产者侧闸门 | `assets/js/active-diary.js:1280-1284` `_activeEconomyGate` ← `:1310` 由 23114 `/health` 的 `economy_proposals_enabled` 驱动；离线收敛 `:1260`、`:1313` | 一个写入点，默认 false |
| 6 | 出口实现 | `assets/js/active-diary.js:1285-1302`，落 `NS.activeEconomyProposalSink = :1303` | 用**既有** companion 传输；不重试、不补偿；400 记为 `rejectedBeforeTransport`（`:1298`） |
| 7 | 23114 路由 | `active/http.js:518-545` | 净化（`:524`，**同一条链上的那一份**镜像 `sanitizeEconomyProposal`）→ `:529` 交给注入的通道客户端；未注入 ⇒ `:520` 404 |
| 8 | 23114 闸门事实 | `active/http.js:202` `economy_proposals_enabled: typeof economyPropose === 'function'` | prompt 里宣告动作与"这个部署真配好了通道"是**同一个条件** |
| 9 | 23114 装配 | `services/active-message-service.js:301-302` `createActiveEconomyChannelClient({})` → `:416-423` `economyPropose` / `sanitizeEconomyProposal` | 镜像名单 `:313-323`（比浏览器那份多 `agentId` 一个名字，理由在 `:324-334`） |
| 10 | 出站通道客户端 | `active/economy-channel-client.js:97-109` | `createEconomyCommandClient`（单一份契约实现）；来源端口 `:77-93`；`describe` 自述 `:111-125` |
| 11 | 目录事实（只读） | `assets/js/home-node-client.js:106` `economyCatalogFact`、`:189-199` `economyCatalogFacts`（**既有** `GET /economy/products`）；注入点 `assets/js/home-node-bootstrap.js:133-135` | 六个"商品是什么"的键，价格/币种不投影（`home-node-client.js:99-106`） |

### 1.2 跨进程（23114 → 23118）

| # | 环节 | 位置 | 事实 |
|---|---|---|---|
| 12 | 出站 HTTP | `services/home-node/economy-command-channel.js:851` `fetchImpl(base + COMMAND_PATH, init)` | `COMMAND_PATH = /internal/economy/command`（`:109`） |
| 13 | 凭据头（不在 payload 里） | `economy-command-channel.js:842-846` `X-IB-Economy-Channel-Source: token` | payload 只有四个信封键（`:818-823`） |
| 14 | 出站 socket 绑定来源端口 | `economy-channel-client.js:107` → 传输 `economy-command-channel.js:693-707`（node:http，`localPort`） | 端口登记因此**在生产上有约束力**（`:667-692`） |
| 15 | 重试与身份复用 | `economy-command-channel.js:834-859` | 有界（`DEFAULT_MAX_ATTEMPTS/HARD_MAX_ATTEMPTS` `:271-272`）；DELIVERY_UNKNOWN 用**同一个**身份重试（`:856-859`） |
| 16 | 23118 路由识别 | `services/home-node/http.js:444-445` `isEconomyCommandPath` ← `:74` `deps.economyCommand` | 路径常量由通道持有，本文件不重写 |
| 17 | 23118 handler（三件事） | `services/home-node/http.js:490-519` | 有界 readBody `:493` → `:506` `dispatch` → `:507-517` 审计（只记 requestId/command/source/outcome/linkage） |
| 18 | 23118 分支位置 | `services/home-node/http.js:1728-1735`（在 `/economy/*` 全部分支**之前**） | 未注入 ⇒ 整条分支不存在 |
| 19 | 来源判定 | `economy-command-channel.js:337-365` | loopback `:339` → token 恒定时间比较且**不短路** `:346-352` → 登记端口 `:354-363` |
| 20 | 信封与身份自报 | `economy-command-channel.js:433-528` | 七个身份键逐名拒绝 `:442-456`；command 封闭集 `:467-475`；信封键白名单 `:477-489`；缺 commandId/idempotencyKey **拒绝而不生成** `:491-510` |
| 21 | commandId 记忆（有界） | `economy-command-channel.js:531-545`、`:385-392`（上限 `:199`） | 同 id 不同 payload ⇒ 409；同 id 同 payload ⇒ 标记 `channelReplay` |
| 22 | **唯一**适配器调用 | `economy-command-channel.js:548-553` | `adapter.performAction(action)` 恰好一处 |

### 1.3 Home Node 进程内（23118）

| # | 环节 | 位置 | 事实 |
|---|---|---|---|
| 23 | Action Adapter 净化 | `services/home-node/economy-action-adapter.js:407-441` `performAction` → `:408` `sanitizer.sanitizeAction` | 封闭动作集 `:92`（成员 1）；已知但未开放与完全未知是**两个**理由码 `:293-312` |
| 24 | 未开放动作登记 | `economy-action-adapter.js:104-119` | `NOT_OFFERED` 含 resume/approve/settle/execute 等九个名字 |
| 25 | 句柄调用（唯一一次字面成员访问） | `economy-action-adapter.js:394-399`、`:429` | 全文件对句柄只有 `proposePurchaseIntent` 这一个成员名 |
| 26 | 身份绑定（全仓唯一一次 bind） | `economy-action-adapter.js:491-496` `bindActiveAgentEconomyAdapter(gate)` → `gate.bind('active_agent_runtime')` | 装配点 `services/home-node-service.js:439-440` |
| 27 | Capability Gate 准入 | `services/home-node/economy-capability.js:300-313` `proposePurchaseIntent` → `:284-298` `decide` → `:131-147` `checkEconomyCapability`（配置损坏 ⇒ 全拒 `:123-124`） | 门只把**两个**白名单键转发给 store（`:212-218`） |
| 28 | 准入审计 | `economy-capability.js:161-183`、`:221-223` | 拒 ⇒ 写一行 DENIED 且**不碰 store**（`:200-204`）；重放/抑制**不写**（`:220`） |
| 29 | P22-8 提议入口 | `services/home-node/economy-store.js:12635` `proposeAgentPurchaseIntent` | ① 规范化（经济事实拒绝）`:12642-12669` → ② 身份 `:12673-12690` → ③ 有效期夹取 `:12692-12701` → ④ 指纹 `:12715-12723` → ⑤ 商品存在且 ACTIVE `:12728-12736` → ⑥ 写 intent `:12739` |
| 30 | intent 行 + 幂等 + 去重窗口 | `economy-store.js:11496-11602`（`createIntentRow`） | 一事务内：幂等冲突 `:11521-11528` → 重放 `:11529` → **60s 指纹窗口抑制** `:11530-11531` → 插入 `:11533-11547` |
| 31 | P22-7 权威判定 | `economy-store.js:11826-11845`（`resolveIntent` ⑤） | `evaluateAutonomousPurchaseFor` → 契约 `evaluatePurchaseIntentVerdict`；**每条 intent 都过，没有例外**（`:11823-11824`） |
| 32 | REQUIRE_APPROVAL 出口 | `economy-store.js:11853-11886` | **只**创建一条待批准记录然后停下；该路径里没有任何 P22-6 调用 |
| 33 | AUTO_ALLOW 出口 | `economy-store.js:12842` / `:12902`（`convergeIntentToEndpoint` / `executeIntent`） | 领执行权 `:11290-11314` 后进入执行 |
| 34 | P22-6 准备（锁钱） | `economy-store.js:8034` `preparePurchase` | Product-backed 硬门 `:8063-8076`；报价四元组一致 `:8081-8101`；结算形态来自商品不可变列 `:8103-8111` |
| 35 | P22-6 结算（**一个** SQLite 事务） | `economy-store.js:8894` `settlePurchase` → `withTransaction` `:8938` | ① 重读四事实 `:8940-8951` → ② Product-backed 复核 `:8956-8963` → ③ 预算**最终**复核 `:9162-9213` → ④ 消费批准（同事务）`:9229-9247` → ⑤ 预留→COMMITTED + ledger 交易 `:9254-9290` → ⑥ 报价 OPEN→CONSUMED + QUOTE_CONSUMED 事件 `:9300-9335` → ⑦ 结算原语 `:9338-9364` → ⑧ Purchase→COMPLETED `:9366-9376` |
| 36 | Ledger | `economy-store.js:2840` `commitLedgerTransactionInTx`（结算内复用 P22-3 内核）、派生余额 `:2089-2188` | canonical = entries；wallet 余额是派生缓存 |
| 37 | 库存 / Compute entitlement | `economy-store.js:9360-9362` `mutateInventoryInTx('grant', …)` | **同一条**原语；compute 额度的 assetKind 是 COMPUTE，单位名 `computeUnit`（契约 `:2514`）。刻意**不**新建 providerQuota/apiBalance/tokenBalance（`:9339-9343`） |
| 38 | 变更日志 | `appendChange` `:2353`；revision 分配 `:1949-1953`；读 `:2621` | revision 命名空间独立（`META_REVISION`），与 schema 水位（`META_SCHEMA`）分开 |

**链上每个环节都是串联的**：没有任何一段短路，也没有任何一段可以从别处进入
（§1.4 是这句话的否证搜索）。

### 1.4 旁路搜索（全仓）

搜索模式（只看**生产**目录，`tests/`、`tests/fixtures/` 单列）：

```text
require('…economy…')                   → 生产 5 处 + 1 处契约复用（见下）
store 的底层动词（mint/burn/commit/reserve/…/putProduct/decideApproval）在
  services/**/*.js 里的调用点              → 恰好 1 处（且是只读评估）
store 的写入口在 services/** 与 assets/** 里的调用点
  （propose/resume/authorizePurchaseIntent） → 恰好 2 处，都在 economy-capability.js
economyCapabilityGate.bind(…)           → 恰好 1 处（economy-action-adapter.js:495）
adapter.performAction(…)                → 恰好 1 处（economy-command-channel.js:553）
economyCommand.dispatch(…)              → 恰好 2 处（http.js:499、:506）
POST /economy/* 路由                    → 0 条
```

**生产方 `require` 清单（全仓）**

| 文件 | 行 | require 谁 |
|---|---|---|
| `services/home-node-service.js` | 48 / 52 / 58 / 67 | store / gate / adapter / command-channel（**唯一**装配点） |
| `active/economy-channel-client.js` | 42 | command-channel（只取通道契约） |
| `services/active-message-service.js` | 301 | `../active/economy-channel-client.js` |
| `services/home-node/economy-{store,capability,action-adapter,command-channel}.js` | store:361、cap:58、adapter:86、channel:99 | 只 require **契约** |
| `services/home-node/economy-store.js` | 63 / 64 / 65 / 302 | `path` / `fs` / `runtime/db-failure.js` / `node:sqlite`（惰性） |

⇒ **Economy 生产文件的依赖闭包**（去掉注释后逐条列出）：

```text
path, fs, node:sqlite, runtime/db-failure.js, ./economy-contract.js,
node:crypto（仅 command-channel 的 token 摘要/指纹）, node:http（仅出站传输）
```

**没有任何一条边通向记忆 / 关系 / provider / 凭据 / 支付 / MCP / 桌面桥。**

唯一一处需要单独说明的调用点：`services/home-node/http.js:1603`
`economy.evaluateAutonomousPurchaseFor(...)` —— 它是 `GET /economy/autonomy-evaluation`
的**只读快照评估**，返回体逐字自述 `evaluatedOnly:true` / `reserved:false` /
`createsRecords:false` / `consumesApprovals:false` / `exposesMutation:false`
（`http.js:1621-1628`），且该函数体内 `reserved:false`（`economy-store.js:10234`）。
它不 reserve、不建批准、不建购买。

**第二名 orchestrator / 第二个净化器搜索**

| 假设 | 搜索 | 结果 |
|---|---|---|
| 有第二个购买编排器 | `services/**` 里 `preparePurchase` / `settlePurchase` 的调用点 | 0（除 store 内部） |
| 有第二个模型动作白名单 | `sanitizeAction` / `performAction` 的定义 | 只有 `economy-action-adapter.js` 一份 |
| Node 侧有第二个 planner | `buildProactivePrompt` / `buildPlanEvalPrompt` | 前者产消息文本、后者评既有计划，都不产动作；P22-12 未碰 |
| 23114 有第二份净化器（**镜像**） | `services/active-message-service.js:313-334` | 存在且**是刻意的**：它是镜像、不是权威，由 `tests/test_p22_12_economy_active_plan.js` 的等价矩阵逐条钉住两份的同答案性 |

---

## 2 · Authority Matrix

重读代码后的最终 owner（不引用旧结论）：

| Domain | canonical owner | Economy 的权限 |
|---|---|---|
| Memory | `services/home-node/memory-store.js`（bucket `memory-store`，装配层注入） | **read = 0**（Economy 不 require 也不持有它）· **event = 0** · **write = 0** |
| Relationship | 浏览器侧 relationship / social 编排（`assets/js/role-dm-social*.js` 等）；Node 侧无 canonical relationship store | **read/event/write = 0**；Economy 里连这个词都只作为否认出现（`economy-store.js:7713/9461/11183/13793`） |
| Decision | 分层：Agent 决定 WANT（`proposeAgentPurchaseIntent`）；P22-7 决定 MAY（`evaluateAutonomousPurchaseFor`）；P22-4 决定 MAY-SPEND（`evaluateBudgetFor`） | Economy **就是**这三层的 owner；三者互相不能替代（契约 `:4860/4863` 断言词表不相交） |
| Action | `services/home-node/economy-action-adapter.js`（唯一动作面，成员 1） | 拥有动作面，但**动作成功 ≠ 购买**（`:440` SELF_FALSE_BITS；`:463`） |
| Wallet | `economy-store.js`（`economy_wallets` + 派生缓存 `:2110` / 读 `:2188`） | owner；canonical 是 ledger，wallet 余额是派生 |
| Ledger | 同上（`economy_entries`，唯一算术入口 `:2061/2840`） | owner |
| Budget | `economy-store.js`（`economy_budget_policies` + committed ledger 事实） | owner；评估是**快照**，不是许可（`:14171`） |
| Autonomy | `economy-store.js`（`economy_autonomy_policies`） | owner；`AUTONOMY_POLICY_READS_LLM_OUTPUT` 在契约里自述为 false |
| Approval | `economy-store.js`（`economy_approvals`，单一使用 `契约:4106`） | owner |
| Purchase | `economy-store.js`（`economy_purchases`，`preparePurchase`/`settlePurchase`） | owner；唯一结算事务 `:8938` |
| Inventory | `economy-store.js`（`economy_inventory` 行；`inventoryDerived:'none'` `:14189`） | owner |
| Compute entitlement | **同一个** inventory 行（assetKind=COMPUTE，单位 `computeUnit`） | owner；它是 IB 内部 entitlement，不是 provider 额度 |
| Provider billing / quota | provider 适配与凭据面（Economy 的依赖闭包里**没有**它） | **read = 0 · write = 0**：Economy 生产文件里 `provider` 只作为否认字段出现 |
| Real payment | `bridge/pay-gate.js` · `bridge/payment-provider.js` · `bridge/alipay-provider.js` | **0 引用**（`bridge/`、`runtime/`、`scripts/` 全域扫 `economy` = 0 命中） |

**四句重点证明（按调用点 / require / HTTP / adapter 路径核过，不是扫文件名）**

```text
Economy → Memory writes            = 0   依赖闭包无 memory-store；store 无该 require
Economy → Relationship mutation    = 0   依赖闭包无任何 relationship 模块；无该 require
Economy → Provider billing mutation = 0  依赖闭包无 provider 适配 / 无凭据面 / 无网络出站（除 P22-11 的 loopback 通道）
Economy → real payment mutation    = 0   bridge/ 全域 0 引用；HTTP 面 0 条支付/充值路径
```

补充一条容易漏的边：Economy 唯一的出站网络能力是
`node:http`（`economy-command-channel.js:95`），且只对**部署环境给的 base**
（默认 `127.0.0.1:23118`）发一条 command（`:851`）。它没有任何 provider
endpoint、没有任何凭据读取路径。

---

## 3 · 四种"钱"的隔离证明

```text
A. IB_CREDIT / Economy virtual wallet          —— economy_wallets/entries
B. Economy COMPUTE_ENTITLEMENT                 —— economy_inventory 行（assetKind=COMPUTE）
C. Provider API quota / billing                —— 不在 Economy 依赖闭包内
D. 真实人民币/美元/支付                          —— bridge/ 支付面，Economy 0 引用
```

| 问题 | 答案 | 结构性证据 |
|---|---|---|
| A 能否变成 D？ | **NO** | A 的币种是 `validateCurrency` 的白名单；法币/稳定币/加密货币在 `FORBIDDEN_CURRENCY_TOKENS`（契约 `:162-164`）里被**逐字否认**，校验顺序是"先否认、再白名单"（`:217-226`，注释 `:218` 说明顺序反了会怎样）。Economy 里**没有**任何兑换/提现/结算到法币的动词（`/economy/exchange` 在 `http.js:982` 与 `:1005` 的 unreachable 名单里）。bridge 支付面对 Economy 的引用 = 0。 |
| A 能否直接充值 C？ | **NO** | "充值 provider 额度"需要一个 provider 计费动词与一个 provider 凭据面，Economy 两者都没有：生产文件里 `provider` 逐处都是 `false` 自述（`economy-store.js:7710-7713` 等 12 处），`http.js:967-968` 把 `/economy/topup` `/economy/provider` 逐名列为 unreachable。 |
| B 是否只是 IB 内部 entitlement？ | **YES** | B 就是 inventory 行：`settlement_type COMPUTE_GRANT` + `assetKind COMPUTE` + 单位 `computeUnit`（契约 `:2514`），走**同一条** `mutateInventoryInTx`（`economy-store.js:9360`）。`:9339-9343` 明确不新建 providerQuota/apiBalance/tokenBalance。上下文自述 `providerMutation:false`（`:9458`）。 |
| Economy 能否触碰真实 Provider API key / billing endpoint？ | **NO** | 依赖闭包逐条列出（§1.4）：没有 provider 适配、没有凭据读取、没有第二个网络目标。`economics-store.js` 不 require crypto/net/http/child_process（`:56` 注释 + 实测 require 清单）。 |
| Economy 能否触碰 pay-gate / Alipay / checkout？ | **NO** | `bridge/pay-gate.js` / `bridge/alipay-provider.js` / `bridge/payment-provider.js` 与 Economy 之间零引用（双向：`bridge/` 全域扫 `economy` = 0；Economy 侧无 `bridge` 引用）。`checkout` 只作为"刻意没有的列/方法"出现在注释与 `tests` 断言里（`economy-store.js:1104`）。 |
| 字段名 / 单位名碰撞风险 | **有意的、已封住的** | 见下 |

**碰撞面逐条核过**

1. `currency` 列在 Economy 的每张表里都存在，但值域由 `validateCurrency` 单点
   收口（`economy-store.js:2438/3176/3237/3703/5074/5138/5489/5941/6929` 等）。
   写入路径全部经过它 ⇒ "有人往 currency 里塞 `CNY`"在**写入**时被拒，不是读取时。
2. `computeUnit` 是**单位名**（`unit_name`），不是币种。它与 `IB_CREDIT` 不共享
   命名空间（一个在 `CURRENCY`，一个在 `COMPUTE_UNIT_NAME`），且
   `productProblemsOf` 断言 COMPUTE_GRANT 商品的 unitName 必须是它
   （`economy-store.js:9694`）。
3. `amount_minor` 是整数 minor unit，BigInt↔SQLite 双向显式转换并**先证明再转换**
   （`:1970/1995`），禁止把 `Number()` / `parseFloat` 当 canonical 路径（`:1964-1967`）。
   ⇒ 不存在"单位混用导致的静默精度损失"这一形态。
4. 名字碰撞最危险的一处是 `balance`：Economy 有 wallet 余额（ledger 派生）与
   reserved 余额（reservation 行派生）**两套**，都在自述里分开写了 canonical 与
   derived（`:14149-14154`）。**它们都不是 provider 余额**。

⇒ **四个答案全部是结构性 NO/YES，无 blocker。**

---

## 4 · 模型 Authority Audit

### 4.1 模型能决定什么

从**最终代码**看，模型输出的动作对象在到达任何经济逻辑之前要穿过三层白名单：

| 层 | 位置 | 允许的键 |
|---|---|---|
| ① 浏览器净化器（模型边界） | `active-plans.js:263-266`（动作对象键）、`:277-280`（proposal 键） | `action/proposal/idempotencyKey/reason` + `productId/recipientId/units/reason` |
| ② 23114 镜像（传输边界） | `services/active-message-service.js:313-323` | 同上 + `agentId`（生产者合法补上） |
| ③ P22-10 净化器 + P22-8 规范化 | `economy-action-adapter.js:132`、`economy-store.js:12642` | `action/proposal/idempotencyKey` + `PURCHASE_INTENT_PROPOSAL_KEYS`（契约 `:5129-5131`，六个键） |

`PURCHASE_INTENT_PROPOSAL_KEYS = [agentId, productId, recipientId, units, reason, expiresAt]`
（契约 `:5129-5131`）。除此之外的一切键 ⇒ `MODEL_SUPPLIED_ECONOMIC_FACT`
（`economy-store.js:12647`），并且拒绝体里把"这些字段必须从 canonical Economy
facts 派生"写成可读字段（`:12650-12656`）。

| 模型**不能**决定 | 在哪一层被结构性命中 |
|---|---|
| PRICE | 不在任何白名单里；价格只来自 quote 快照（`PURCHASE_AMOUNT_SOURCE='quote-snapshot'` 契约 `:4657`；结算入参只有 `purchaseId`，`economy-store.js:8911-8915`） |
| BALANCE | 无该键；余额一律 `computeLedgerBalance` 派生（`:2061`） |
| BUDGET | 无该键；预算在 Prepare `:8298` 与 **Settle 最终复核** `:9162` 各评一次 |
| AUTO_ALLOW | 身份键之一（`active-plans.js:202` 七个键之列），浏览器与镜像双向拒；且决定来自 `evaluateAutonomousPurchase` |
| APPROVAL | `approved` 是身份键（同上一行）；批准只有一条 canonical 生命周期 |
| SETTLEMENT | 结算形态来自**商品不可变列**（`:8103-8111`），不是请求字段 |
| LEDGER | 无该键；交易 id 由 `derivePurchaseLedgerTransactionId` 确定性派生（`:9272`） |
| GRANT | 发放量来自商品 `grant_quantity`（`:9345`），不是请求字段 |
| CONSUMER IDENTITY | `consumerId/consumer/capability/role/authority` 是身份键（`active-plans.js:202`、`economy-command-channel.js:136`、`active-message-service.js:314`）；真实身份来自 ① socket+登记凭据（`:337-365`）② 装配期 `gate.bind`（`economy-action-adapter.js:495`） |

**同时检查 prompt 侧**：`active-plans.js:441-452` 的经济段只给"目录里有什么"与
"这是一个可选动作"，不出现任何消费鼓励；`:452` 的目录投影只有
`ACTIVE_ECONOMY_CATALOG_FIELDS`（`:226`，六项）。`P22-12` 的测试 A7/A8/A9 逐句
断言过这件事——本审计不重跑它们（§9），只确认代码形状未变。

### 4.2 catalog grounding

**是。** 模型只能选**真实目录里给它的 productId**，而且三重收口：

1. prompt 只在 `economyCatalog.length>0` 时才宣告这个动作（`active-plans.js:386-387`，
   `416-417`；注释 `:383-385` 写明"没有 productId 可选的画面只会把模型推向编造商品"）；
2. 净化器要求 `productId` 是非空字符串且有界（`:281-283`）；
3. 运行时硬门：商品必须**存在**（`:12635` 的 ⑤ `:12728-12736`）且 ACTIVE；
   报价必须 Product-backed（`preparePurchase` `:8063-8076`），结算时再复核一次
   （`:8956-8963`）。

编造 productId ⇒ `PRODUCT_NOT_FOUND` / `PRODUCT_DISABLED`，且**在写任何东西之前**
（`:12725-12727` 的注释就是这条纪律）。编造价格 ⇒ 在触到传输之前就整条 fail closed
（`:12645-12657`）。

### 4.3 `none` 是否仍是一等正常路径

**是。** 结构上的三条：

1. 经济动作在 prompt 里是**第 4 个可选动作**，而"什么都不做"是既有合法输出
   （`_activeValidatePlanResultCore` 的三个既有动作与 `none` 路径未改）；
2. 目录为空时**连动作名都不出现在 prompt 里**（`active-plans.js:386-387`），
   因此"经济不可用"不会把模型逼向任何动作；
3. 净化器对缺席经济动作不做任何补充（`:117` 只在 `action===ACTIVE_ECONOMY_PROPOSAL_ACTION`
   时分流），因此 `none` 不经过任何经济代码。

P22-12 的 D 组用过真实链证明"`none` ⇒ 零请求"，本审计不重跑。

---

## 5 · 重复机制审计

### 5.1 各层负责什么

| 机制 | owner（唯一） | 作用域与存储 | 负责的**那一件事** |
|---|---|---|---|
| `requestId` | **不存在于 Economy** | 聊天 / 记忆 / Moments 的传输幂等（`chat-store.js:773-793`、`memory-store.js:423-441`、`moments-store.js:467-539`） | Economy 用**别的**名字：`commandId` + `idempotencyKey`。`http.js:510` 里的 `requestId:` 只是 23118 审计字段名（值取 `decision.commandId`），不是一套独立去重 |
| `commandId` | `economy-command-channel.js:385-392`（内存 Map，上限 `:199` = 256） | 传输层，**进程内、有界、不落盘** | "同一个 commandId 换了 payload ⇒ 409"（`:531-543`）。它不是购买去重 |
| `idempotencyKey` | ① 生产者为**同一份模型输出**推导同一个 key（`active-plans.js:343-348`）；② 通道要求它必须存在且**不替你生成**（`:500-510`）；③ 下游按 (scope,key)+指纹认幂等 | 跨进程、跨重启（落 SQLite） | "同一个逻辑请求重放 ⇒ 同一个结果，不产生第二条" |
| `fingerprint` | `economy-store.js`：操作级 `:3579-3617`、intent 级 `:11501-11515`、购买级 `:7888`、交易级 `:2662`、报价级 `:5919`、政策级 `:5453` | store | "同一个 key 配不同的内容 ⇒ 冲突而不是重放" |
| `duplicate window`（60s） | `economy-store.js:11244-11248` + `:11530-11531`；窗口常量契约 `:5150` | store | "同一个模型输出被连续喂二十次"（`PURCHASE_INTENT_DEDUPE_IS_NOT_A_BUDGET=true` 契约 `:5163`） |
| `CAS`（`UPDATE … WHERE … AND state=?`） | `claimIntentForExecution` `:11290-11314`；各状态迁移的 `changes===1` 断言（如 `:9311`、`:9374`、`:11812`） | store | "两个进程只有一个赢家"（执行权令牌 = state 本身） |
| `UNIQUE` | 表级 `UNIQUE(owner_id,currency)`（`:443`）、`(scope,idempotency_key)` 主键（`:807`/`:1607`）、approval 消费索引等 | SQLite | 最后一道物理保证 |
| `ledger transaction id` | `C.derivePurchaseLedgerTransactionId(purchaseId)`（`:9272`） | store | "这笔购买的账只有一条交易"，派生而非读 |

### 5.2 有没有两层在争夺同一个 authority？

**没有。** 逐对核过：

| 这一对 | 判据 | 结论 |
|---|---|---|
| 通道 `commandId` vs store `idempotencyKey` | 通道把 `idempotencyKey` **原样**透传（`:551`），自己**不**写任何 store 幂等记录（`transportAddsASecondPurchaseDedupe:false` `:186`） | 不同 authority：一个是"这条命令身份被复用了吗"，一个是"这个逻辑请求做过吗" |
| 通道 `commandId` vs `idempotencyKey` | 通道**要求**两者都存在，且都进指纹（`:376-382`） | 不冲突：缺任何一个都是拒绝 |
| 生产者 60s Map vs store 60s 指纹窗口 | 生产者那份只决定"要不要发"（`active-plans.js:355-367`），失败即 fail closed；store 那份决定"要不要新写一条 intent" | 是**两层同向**（都叫 DUPLICATE_REQUEST），不是争权：store 是 canonical，Map 只是生产者的行为约束 |
| P22-8 intent 幂等 vs P22-6 purchase 幂等 | 不同 scope（`AGENT_INTENT_PROPOSE` vs `PURCHASE_PREPARE`/`PURCHASE_SETTLE`），不同实体 | 不冲突 |
| P22-3 reservation `commit` 幂等 vs P22-6 `settle` 幂等 | `settlePurchase` **显式关掉** commit 层的 (scope,key) 写入（`:9281-9290` 的注释与实测记录） | 已解决的历史争权：现在只有一个写入者 |
| 库存 grant 幂等 vs 购买结算 | `invCtx.idempotency = null`（`:9355-9358`）：发放的幂等身份由 Purchase 持有 | 已解决：一个事实一个出处 |

### 5.3 有没有后阶段让前阶段某套 dedupe 变成死代码？

**没有死代码，但有一处"未被行使"**，如实记下来：

* **被行使的**：`commandId` 冲突支（`:531-543`）在**生产上真的可达**——生产者算出的
  canonical `idempotencyKey` 对同一份模型输出是**相同的**，而每次调用生成**新的**
  `commandId`（`createCommandIdentity` `:658-665`，随机种子）。因此"同一 idempotencyKey、
  不同 commandId"是**生产常态**，而"同一 commandId、不同 payload"是重试路径
  （同一 `sendCommand` 调用内的重试复用同一个 `identity`，`:834-859`）。
* **未被行使的**：`commandIdMemory` 的**重放**支（`known === commandId` 且指纹相同 ⇒
  `channelReplay=true`）在生产上只有"同一身份在同一个 sendCommand 内重试且服务端
  第一次已经处理过"这一种情形能触发。这是**真实的**（超时重试），不是死码。
* 逐条否证"后阶段取代前阶段"：P22-9（门）、P22-10（适配器）、P22-11（通道）三层都
  自述 `addsASecondDedupe:false` / `transportAddsASecondPurchaseDedupe:false`
  （`economy-action-adapter.js:181`、`economy-command-channel.js:186`），而代码层面确实
  没有第二份幂等表。

⇒ §5 结论：**没有重复 authority，没有死机制。**

---

## 6 · Schema / Migration Audit

**当前水位**：`ECONOMY_SCHEMA_VERSION = 7`（`economy-store.js:157`）。
迁移框架 `MIGRATIONS`（`:1728-1819`）：1→2 / 2→3 / 3→4 / 4→5 / 6→7 为空（只有新表），
5→6 为**唯一非空**迁移（给 `economy_purchases` 补五个可空列，`:1767-1803`）。

| 场景 | 代码路径 | 结论 |
|---|---|---|
| fresh install | `migrateSchema` `:1821-1826`：`raw == null` ⇒ 只写水位，不跑任何迁移 | 正确（不跑空迁移也不跑 ALTER） |
| old supported DB → latest | `:1838-1843`：`for step of MIGRATIONS`，条件 `step.from < stored \|\| step.from >= ECONOMY_SCHEMA_VERSION` ⇒ **跳过** | 正确（`stored=3` 只跑 3→4…6→7） |
| **跨多个版本升级** | 5→6 的 apply 先查 `sqlite_master` 里 `economy_purchases` 是否存在（`:1784-1787`），不存在就 `return` | **已修的真实缺陷**（`:1780-1783` 记录了"schema 4 的库跨两级读作 no such table"） |
| 重复 migration | 水位在跑完后写（`:1843`）；5→6 的 ALTER 自己读 `PRAGMA table_info` 去重（`:1788-1801`） | 幂等 |
| 中途失败后重启 | 迁移发生在 `CREATE TABLE` **之前**（`:1577-1578` vs `:1579+`），水位最后写 ⇒ 失败则水位留在旧值，下次重跑 | 正确 |
| schema 过新 | `:1833-1837`：抛 `SCHEMA_TOO_NEW`，**拒绝打开**；且拒绝发生在任何 DDL 之前 | 正确（`P22-3` 实测修过的缺口，`:1571-1576`） |
| 水位被手工改成 0 但库里有行 | `:1725-1727` 说明的断言：拒绝 | 正确（"在真实余额上假装迁移"） |

**逐条回答要求**

| 要求 | 结论 | 证据 |
|---|---|---|
| 不清库 | **成立** | 迁移里没有任何 DROP/DELETE；store 不做损坏隔离（`:1562-1564`：quarantine 由 chat-store 负责，第二个 opener 去 rename 会互相踩） |
| 不伪造历史 Approval / Autonomy | **成立** | 5→6 的五个新列**全部可空且不回填**（`:1757-1762`）：P22-7 之前的购买**没有**授权模式。猜 AUTO_ALLOW 就是伪造"当时有权自主买"，猜 APPROVAL 就是伪造"当时有人批准过"。`approvalProblemsOf`（`:10366`）与 `purchaseProblemsOf`（`:13806`）把旧行 NULL 认成合法 |
| revision namespace 独立 | **成立** | schema 水位用 `META_SCHEMA`，revision 用 `META_REVISION`（`:14358-14362` 的 `META_KEYS`），`getRevision` 取 meta 与 `change_log` 的**较大值**（`:1940-1948`）⇒ 外部工具改写不会让版本回退 |
| change log 可继续重放 | **成立** | `appendChange` `:2353`、`listChanges(cursor,limit)` `:2621`；每次分配独立 revision（`:1949`），且高层事件用**自己的** revision（`:9466-9472` 说明"不是记账事实的第二个版本号"） |
| 引用关系无孤儿 | **成立** | 索引面覆盖 purchases→quote/reservation/approval/ledger_tx（`:1632-1641`）、intents→quote/approval/fingerprint（`:1658-1663`）；`economyIntegrityCheck` `:9738` 逐域检查（policy/quote/store/product/inventory/purchase/quoteProvenance）；另有 `reconcileReservations` `:4773`、`rebuildReservedBalance` `:4711`、`rebuildWalletBalance` `:2110` 三条对账口 |

**本阶段未做任何破坏性迁移**（资源纪律）；上述结论来自代码路径与既有测试
（`test_p22_2/3/4/5` 的迁移组，本阶段 44 次运行中全绿）。

---

## 7 · Public Surface Audit（最终清单）

### 7.1 普通 HTTP 读面：28 条，**全部 GET**

```text
/economy/health  /economy/wallet  /economy/wallets  /economy/ledger
/economy/transaction  /economy/changes
/economy/reservations  /economy/reservation
/economy/policies  /economy/policy  /economy/budget
/economy/quotes  /economy/quote
/economy/stores  /economy/store  /economy/products  /economy/product
/economy/inventory  /economy/inventory-entry
/economy/purchases  /economy/purchase
/economy/approvals  /economy/approval
/economy/autonomy-policies  /economy/autonomy-policy  /economy/autonomy-evaluation
/economy/intents  /economy/intent
```

每一条都是 `path === '…' && method === 'GET'`（脚本核过：28/28 带 `method === 'GET'`）。
其余 `/economy/*` 落在 `http.js:1707-1711`：`GET` ⇒ 404 `unknown-economy-path`，
**非 GET ⇒ 405 `economy-is-read-only`**。

### 7.2 写面

| 面 | 结论 |
|---|---|
| **普通 `/economy/*` HTTP write** | **0**（`http.js` 里 `economy.*` 的 49 次调用全部是 `health/get*/list*/serialize*/evaluate*`；无一个写动词） |
| **内部 command** | **1 条**：`POST /internal/economy/command`（`economy-command-channel.js:109`），命令词表**一个**成员（`:112-115`） |
| **MCP Economy write** | **0**（仓库无 `mcp/` 目录；`bridge/` 与 Economy 双向零引用） |
| **UI** | 0（浏览器侧只有目录读投影 + 一条提议出口；无钱包 / 批准 / 购买 UI） |
| **Active** | 读 1（`GET /economy/products` 经由 `home-node-client.js:189`）+ 提议出口 1（`active/http.js:518`） |
| **Chat / Group / Voice / Diary** | **0**（Economy 依赖闭包不引用它们；契约 `:5701-5709` 把 chat / group_chat / voice / active_diary / moments_ui / mcp_client / llm 逐条登记为"核对过、不是消费者"） |
| **desktop_bridge / home_node_authority** | **0**（契约矩阵 `:5690-5694`：两者能力列表为**空**；Economy 侧无 bind） |

### 7.3 /security 的自我声明（可断言字段）

`http.js:804-1046` 的 `economyPolicy`：

```text
httpVerbs: ['GET']                        writesExposed: []
reservationWritesExposed / budgetWritesExposed / quoteWritesExposed /
storeWritesExposed / productWritesExposed / inventoryWritesExposed = []
purchaseExposed: false   mintingExposed: false
capabilityWritesExposed / capabilityReadsExposed = []
commandChannel.commandWritesExposed = open ? ['ECONOMY_PROPOSE_PURCHASE'] : []
commandChannel.capabilityWritesExposed / approvalWritesExposed / resumeWritesExposed = []
commandChannel.pathIsNotUnderEconomyReadPaths: true
```

**特别确认（逐条）**

```text
普通 /economy/* HTTP write = 0                ✔
MCP Economy write = 0                          ✔
Chat/Group/Voice/Diary Economy = 0             ✔
唯一自主 consumer = active_agent_runtime       ✔（§1.4：全仓 bind 恰好 1 处）
唯一跨进程 command = ECONOMY_PROPOSE_PURCHASE  ✔（词表成员 1；适配器的 NOT_OFFERED 把其余九个名字逐个拒绝）
```

**★ 通道默认是关的**：`IB_ECONOMY_CHANNEL_TOKEN` 缺席 ⇒ 登记册为空
（`services/home-node-service.js:483-504`）⇒ `open:false`、`commandWritesExposed:[]`。
也就是说：**今天一个未配置通道的部署，跨进程经济写面是 0，而且 prompt 里连动作名
都不出现**（闸门同一条件，§1.1 第 8 行）。

---

## 8 · UI Readiness（不写 UI，只报 read model 现状）

| 项 | 状态 | canonical read model | 证据 | 缺口 |
|---|---|---|---|---|
| Wallet | **READY** | `GET /economy/wallet`（+ `/wallets`） | `http.js:1090-1123`；`getWallet` `:2498`、`serializeWallet` `:2274`；余额是 ledger 派生，且带 `rebuild` 标记 | — |
| Stores | **READY** | `GET /economy/stores` / `/store` | `http.js:1348-1370`；`listStores` `:6688`、`serializeStore` `:6544` | — |
| Products | **READY** | `GET /economy/products` / `/product` | `http.js:1372-1403`；过滤条件 storeId/status/kind/currency（`:6699`） | — |
| Quotes | **READY** | `GET /economy/quotes` / `/quote`（可带评估） | `http.js:1276-1331`；`listQuotes` `:6215`、`evaluateQuote` `:6387` | — |
| Purchases | **READY** | `GET /economy/purchases` / `/purchase`（带三个小结） | `http.js:1458-1499`；`serializePurchase` `:7719`、`purchaseSettlementOf` `:7687` | — |
| Inventory | **READY** | `GET /economy/inventory` / `/inventory-entry` | `http.js:1405-1439`；`serializeInventoryEntry` `:6589`（含 assetKind / unitName ⇒ COMPUTE entitlement 可展示） | — |
| Approvals | **READY（读）** | `GET /economy/approvals` / `/approval` | `http.js:1518-1552`；`serializeApproval` `:10314`；`health.counts.pendingApprovals`（`:14094`）是"需要人做点什么"的唯一数字 | 读面完备 |
| Agent intents | **READY** | `GET /economy/intents` / `/intent?withChain=1` | `http.js:1652-1703`；`intentChainOf` `:13198-13252` 已经把 `whatTheAgentWanted / whyItDidNotBuyDirectly / whyItBoughtDirectly / approval / quote / purchase` 串成一条链 | — |
| Budget / autonomy policy | **READY** | `GET /economy/policies` `/policy` `/budget` `/autonomy-policies` `/autonomy-policy` `/autonomy-evaluation` | `http.js:1228-1630`；`serializeBudgetPolicy` `:5679`、`serializeBudgetSnapshot` `:5416`、`serializeAutonomyPolicy` `:10096` | — |
| Audit / change log | **READY** | `GET /economy/changes?cursor=` + `revision` | `http.js:1161-1165`；`listChanges` `:2621`、`getRevision` `:1940` | — |
| **"用户对一条待批准点头 / 摇头"的**端到端**能力** | **MISSING** | 读模型**有**（上两行），但**写侧在生产上不存在** | `decideApproval`（`economy-store.js:10670`）与 `resumeAgentPurchaseIntent`（`:12925`）在生产代码里的调用方 = 0；HTTP 面 = 0（`/economy/approve` `/economy/reject` 在 `http.js:976` 的 unreachable 名单里）；跨进程 command 面 = 0（词表成员 1，且适配器 `NOT_OFFERED` 明确不含 resume） | **见 §10.2** |

**最小缺口（只报缺口，不建议给 Economy schema 加展示字段）**

UI 要展示 `intentChainOf` 已经给不出新东西——它连 approval / quote / purchase 三者
的 id 与状态都串好了。真正缺的不是**读模型**，而是一条**决定路径**：

```text
读：GET /economy/approvals?status=PENDING        —— 已有
读：GET /economy/intent?agentIntentId=…&withChain=1 —— 已有
写：把 APPROVED / REJECTED 写到那条 approval 上，
    并（APPROVED 时）让同一条 intent 从 WAITING_APPROVAL 继续到终态
```

这一条路径今天**没有任何生产入口可以被 UI 调用**。UI 阶段的第一件事因此不是
"加展示字段"，而是"给这条已有的 canonical 生命周期一个生产调用方"。

---

## 9 · 测试债务

### 9.1 本阶段实测（唯一允许的手段：既有单进程测试）

**全量 P22 专项 · 第 1 轮**（29 文件，各一次）：

```text
ran = 29   failed = 0   total = 144.0 s
最慢：test_p22_6_economy_runtime 15.4s · test_p22_7_economy_runtime 13.5s
      test_p22_3_economy_runtime 12.4s · test_p22_8_economy_runtime 12.2s
```

**多进程 race 组的稳定性抽样**（P22-3/5/6/7/8 runtime，各连跑 3 次）：

```text
15 runs   failed = 0
```

⇒ 在**空载**条件下，多进程组是稳定的。

### 9.2 债务分类

| 类别 | 项 | 判据 |
|---|---|---|
| **Economy regression** | **0 项** | 44 次运行、29 个文件全绿；且 P22-12 提交后的 aggregate 里 `test_astra_readiness_observe#Z1.noProductionFileChanged`（断言工作树无生产改动）已经由红转绿——那不是回归 |
| **baseline failure** | 2 项（**非 Economy**） | `test_cache_audit`、`test_middle_brain_convergence_counterproof` = 已知基线，与 Economy 零关系 |
| **load-sensitive flake** | **1 项** | `test_p22_7_economy_runtime.js`：P22-12 的 aggregate 运行中红过一次，单独跑（含 3 次连跑）全绿。属**负载抖动**，不是逻辑缺陷已知证据 |
| **obsolete phase guard** | **0 项** | `tests/test-all.js:381-722` 的 P22 条目与 29 个文件一一对应；没有"某阶段守则已过期"的条目（P22-9 明确禁止重做 P22-6~8 的多进程证明，那条纪律在 `test-all.js:632-633` 的注里，仍然成立） |

### 9.3 多进程组是不是整套测试的主要不稳定源？

**是，而且是可量化的。** 按"源码里 child/worker 入口的出现次数"统计：

```text
test_p22_1_economy_boundary       spawn/fork=1   worker=5
test_p22_2_economy_runtime        spawn/fork=1   worker=0
test_p22_3_economy_runtime        spawn/fork=2   worker=2
test_p22_4_economy_runtime        spawn/fork=1   worker=0
test_p22_5_economy_runtime        spawn/fork=2   worker=2
test_p22_6_economy_runtime        spawn/fork=2   worker=12
test_p22_7_economy_runtime        spawn/fork=2   worker=17
test_p22_8_economy_runtime        spawn/fork=2   worker=18
test_p22_11_economy_command_channel spawn/fork=2 worker=0
test_p22_11_economy_active_bridge spawn/fork=1   worker=0
test_p22_12_*                     spawn/fork=2   worker=0
```

五个 `*_runtime.js` 组（P22-3/5/6/7/8）合计承载了**几乎全部** `Worker` 使用，
并且它们的耗时（8.0/12.4/15.4/13.5/12.2 s）占了 144 s 里的 61.5 s（43%）。
**一次 aggregate 失败的那个文件正好属于这一组。**

★ 统计口径说明（如实）：上表数的是**源码里这些标识符的出现次数**（其中一部分是
测试自己把 `child_process` 的入口换成"计数并当场抛错"的守卫），**不是**运行期真实
spawn 数。本审计**没有**为了量准这个数而运行任何多进程测试——那是资源纪律禁止的。

### 9.4 后续测试治理建议（**本阶段不顺手重构**）

1. **给 load-sensitive flake 一个显式归类**：把 P22-3/5/6/7/8 的 `*_runtime.js`
   标成一个独立的 `race` 分组，使其在 aggregate 里可以单独串行执行（不与其它
   测试并行争 CPU 与 SQLite 锁），而不是让它"偶然红"。
2. **失败重跑要留痕**：一条 aggregate 里的红只报告"最终绿/红"会掩盖抖动。建议
   记录"首次红 + 重跑结果"两列，这样"load-sensitive"与"regression"在报告层就分开。
3. **不要为了减少 flake 而放宽断言**：`waitForIntentEndpoint` 的 1.5 s 上界
   （`economy-store.js:11327`）是**量出来的**（`:11327-11328`），改成更长只会掩盖
   "两个进程读到两个世界"这类真实缺陷。

---

## 10 · Backend Core Closed？

### 10.1 已经成立的部分（逐条对应 P22-1～P22-12）

| 命题 | 证据 |
|---|---|
| canonical ownership 成立 | §2 矩阵，14 个域逐条给出 owner 与权限 |
| 安全边界成立 | §3 四种钱全部结构性隔离；§7 写面清单；§1.4 旁路搜索 0 命中 |
| 生产调用链成立 | §1 从 prompt 到 inventory 的 38 段逐段 `file:line` |
| 模型 authority 受限 | §4：只能决定 WANT；九类 authority 逐条被结构性命中；catalog grounding 三重收口；`none` 一等 |
| 重复机制无争权/死码 | §5 |
| schema / migration 闭合 | §6 |
| 测试债务清楚 | §9：0 个 Economy regression，1 个 load-sensitive flake，2 个无关基线 |
| 资源纪律 | 本审计自身 0 child / 0 spawn / 0 Desktop / 0 Electron / 0 Playwright / 0 DSH |

### 10.2 blocker（唯一一个）

**B1 · 批准决定在生产代码里没有调用方 ⇒ 默认部署下自主购买链不可达终点**

```text
默认部署：没有任何 autonomy policy
  ⇒ AUTONOMY_DEFAULT_WHEN_NO_POLICY = REQUIRE_APPROVAL
     （services/home-node/economy-contract.js:4108）
  ⇒ 每条 intent 都走到 WAITING_APPROVAL
     （services/home-node/economy-store.js:11826-11850）
  ⇒ 永久停在那里
```

**三条出路全为 0（逐条取证）**

| 出路 | 代码位置 | 生产调用方 |
|---|---|---|
| 同进程写 `decideApproval` | `economy-store.js:10670`（store 公开面 `:14499`） | **0**（全仓搜索：只在 `tests/fixtures/p22-7-approval-worker.js` 与 tests 里被调用） |
| 同进程写 `resumeAgentPurchaseIntent` | `economy-store.js:12925` | 只有 `economy-capability.js:243`（门内），而门的 `resumeApprovedPurchase`（`:315-326`）**没有任何生产调用方**：装配层只导出对象（`home-node-service.js:979`），适配器对 resume 走 `NOT_OFFERED`（`economy-action-adapter.js:104-119`、`:465`） |
| 跨进程 command | `economy-command-channel.js:112-115` 词表成员 **1**（`ECONOMY_PROPOSE_PURCHASE`） | **0**：没有 resume 类 command，且通道 `describe()` 自述 `theContinuationVerbIsNotRegisteredOnThisChannel:true`（`:624`） |
| HTTP 写 | `http.js:967-1005` 的 unreachable 名单 | **0**：`/economy/approve` `/economy/reject` 逐名列出；`/security` 自述 `approvalWritesExposed: []`、`resumeWritesExposed: []`（`http.js:1034-1035`） |

**为什么这构成 blocker（而不是"设计如此"）**

* 授权三层**全部正确**：门正确地把 `RESUME_APPROVED_PURCHASE` 当作 `active_agent_runtime`
  的第二项能力（契约 `:5691`），store 有完整的批准生命周期与单一使用约束
  （`decideApproval` / `consumeApprovalForPurchaseInTx` `:13736`），intent 有 `WAITING_APPROVAL`
  状态与恢复路径。**缺的不是机制，是生产入口。**
* 可达性后果是实测可复现的：一个全新部署里，模型提出一条购买意图 ⇒ 库里出现一条
  `WAITING_APPROVAL` 的 intent 与一条 PENDING 的 approval，而**任何生产代码都不能
  把它们推到终态**。这不是"UI 还没做"，而是"后端还没有一条能完成它的路径"。
* 这正是本仓库反复出现的同一个缺口形态（P22-9 的门曾经"没有任何 production
  调用方 bind 过它"，见 `home-node-service.js:980-983`），而它被明确当作缺陷处理。
* 唯一今天可达终点的路径是 AUTO_ALLOW，而它**需要预先存在** autonomy policy +
  budget policy + 有余额的钱包 —— 而这三样东西的生产写入面（`putAutonomyPolicy` /
  `putBudgetPolicy` / `mintForSystem`）在生产代码里的调用方也全部是 0（§1.4）。
  也就是说：**一个真实部署今天无法在不改代码的情况下让任何一次自主购买到达 Ledger。**

**最小缺口的具体形状**（三选一即可，本阶段**不实现**）：

```text
(a) HTTP 写面：POST /economy/approval/decide  —— 与 P22-7 明令禁止 POST /economy/approve 冲突，
    若走这条，必须先明确"桌面 token + loopback"是否足以代表用户点头（这是个**产品安全决定**）；
(b) 跨进程 command：给通道登记第二个 command（resume）—— 与 P22-11 冻结的"唯一一个 command"
    冲突，且必须同时让适配器的 NOT_OFFERED 收口，改动面最大；
(c) 同进程桌面编排：由 Home Node 进程内的一个已鉴权路径（与 23118 同进程）调用
    `gate.bind(...).resumeApprovedPurchase(...)` —— 这一条**不动任何既有边界**
    （门的能力此前已经在矩阵里），只补一个调用方与一个入口。
```

选哪一条是下一阶段要拍板的事；本审计只指出：**今天一条都没有**。

### 10.3 结论

```text
NO — blockers:

B1 · 批准决定的写入口在生产代码里的调用方 = 0（decideApproval / resumeAgentPurchaseIntent /
     resumeApprovedPurchase 三者皆无生产调用方；HTTP 写面 0；跨进程 command 面 0）。
     默认部署（无 autonomy policy ⇒ REQUIRE_APPROVAL，economy-contract.js:4108）下，
     模型提出的每一条购买意图都会停在 WAITING_APPROVAL，而没有任何生产路径能把它
     推到终态 —— 一条已经写好的 canonical 生命周期在产品组合里走不到终点。
     证据：economy-store.js:10670 / :12925 / :11853-11886 · economy-capability.js:315-326 ·
     economy-action-adapter.js:104-119 · economy-command-channel.js:112-115 · http.js:976 / :1034-1035
```

**这不是为了进入 UI 阶段而给 YES 的反面**：§1～§9 的九项审计全部成立，阻塞点是一处
**可达性**而不是授权正确性。修掉 B1（补一个生产调用方）之后本审计的其余部分不需要
重做——因为它们证明的是"这些层各自正确且写面为 0"，而那仍然会是真的（新入口会是
**第四条**被登记的面，必须同时进 §7 的那几张自述表）。

---

## 11 · 复现命令（本审计实际执行过的）

```powershell
# 生产面静态核对（无副作用）
Get-ChildItem services/home-node -Filter '*economy*'
Select-String -Path services/**/*.js -Pattern 'require\([^)]*economy'
Select-String -Path services/**/*.js -Pattern '\.(mintForSystem|preparePurchase|settlePurchase|decideApproval|…)\(`'
([regex]::Matches((Get-Content services/home-node/http.js -Raw), "path === '(/economy/[a-z-]+)' && method === 'GET'")).Count

# 专项测试（既有单进程/既有测试；两次共 44 次运行）
foreach ($t in $29测试清单) { node "tests/$t" }
foreach ($r in 1..3) { foreach ($t in @('test_p22_3/5/6/7/8_economy_runtime.js')) { node "tests/$t" } }
```

**未执行**（按资源纪律）：任何多进程性质的**重新证明**、任何 Desktop / Electron /
Playwright / DSH、任何破坏性迁移、任何生产文件修改。
