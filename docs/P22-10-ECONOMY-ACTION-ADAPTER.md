# P22-10 · Economy Action Adapter

> 给现有 Agent / Action runtime 一个**极窄**的经济接口，使**只能**通过 P22-9 的
> bound capability handle 提出购买意图，绝不可能拿到 raw Economy Store 或底层经济
> 写能力。

冻结基线：`0480c37 P22-9 · add Economy runtime capability gate`

最终链：

```text
Agent / Action runtime（模型输出的一个结构化动作）
        ↓
Economy Action Adapter            ← 本阶段
        ↓
P22-9 bound capability handle
        ↓
P22-8 Agent Purchase Intent
        ↓
P22-7 Autonomy / Approval  →  P22-6 Atomic Purchase
```

---

## 1. §1 只读审计：这个仓库里真正的 Action seam 是什么

审计从代码出发，**没有一条结论来自提示词假设**。

### 1.1 没有通用 Action dispatcher —— 因此本阶段不新造一个

全仓库生产代码搜 `executeAction` / `dispatchAction` / `runAction` /
`actionDispatcher` / `ACTION_WHITELIST`：**零命中**。
（唯一命中 `executeAction` 的地方是 `economy-store.js` 的一句**否认清单**注释：
"`executeEconomyAction` / `runAction` / `settleForAgent` / `buyNow` 都不存在"。）

⇒ §1 逐字要求："如果仓库根本没有通用 Action dispatcher，不要为了 P22-10 新造一个。"
本阶段**没有**造。适配器不是 dispatcher：它的动作集恰好一个成员，对句柄的访问是
**一处字面成员调用**。

### 1.2 唯一真实的"模型输出 → 结构 → 封闭动作集 → 执行"链条

| 位置 | 是什么 | 封闭动作集 |
|---|---|---|
| `assets/js/active-diary/active-plans.js` → `_activeValidatePlanResult` | 浏览器侧 Active 规划器（模型输出 → `_activeParsePlanJson` → 白名单 → 执行） | `['schedule','none','cancel_existing']` |
| `active/scheduler.js` → `evaluatePlan` | Node Active companion 的到期二次评估（模型输出 → `parsePlanJson` → 白名单 → 执行） | `['send','reschedule','cancel']` |
| `active/plan-domain.js` → `sanitizeAiPlan` | 两者**共用**的计划形状权威（schema/sanitizer，不是 dispatcher） | — |

### 1.3 进程边界（这一条决定了本阶段能接什么、不能接什么）

* Active 的**决定**跑在两个进程：浏览器，以及 Active companion
  （`services/active-message-service.js`，端口 23114，`component-registry` id `active`）。
* canonical Economy store + 准入门只在 **Home Node**（端口 23118）进程里被装配
  （`services/home-node-service.js#economyAssembly`，P22-1 的 B4.2 逐字断言它是
  唯一的 require 点）。
* 两个进程之间**没有**经济通道：`active/*`、`services/active-message-service.js`、
  `assets/js/active-diary/*` 里对 `economy` 的引用数是 **0**（P22-10 runtime 测试 B3）。
* HTTP 上的经济写面从 P22-2 起就是 0，而 P22-9 §8 明说这扇门连读面都没有。

⇒ **造一条跨进程通道 = 造一条新的写面**，与 P22-2/P22-9 的边界直接冲突。因此本阶段
不造通道：适配器长在**句柄唯一可能存在的地方**（装配层），它的公开面到
`buildHomeNode()` 的返回值为止 —— 与门逐字同级。

P22-8 在 `services/home-node/http.js` 里已经把这件事写成了自己的话：

> `proposeAgentPurchaseIntent` 是同进程的**窄接口**，它的调用方是
> **Decision Bridge（未来的 Decision/Action seam）**，而不是一个 HTTP 请求。

本阶段就是那个 seam 的**经济面**。

### 1.4 Middle Brain 不在这条链上（§11：零改动）

`services/home-node/middle-brain.js` 是 Home Node 角色回合的**上下文/认知层**
（五个层 + facade 的宿主适配），没有动作集、没有 dispatcher、没有工具回合。
它对 `economy` 的引用数是 **0**（runtime 测试 B4）⇒ **零改动**。

---

## 2. §2 动作词表：只开放一个动作

```js
ACTION = { ECONOMY_PROPOSE_PURCHASE: 'ECONOMY_PROPOSE_PURCHASE' }   // 封闭集，成员 1
ACTION_LIST = ['ECONOMY_PROPOSE_PURCHASE']
```

**不存在**（不是"还没开放"，是在这份词表里根本没有这个名字）：

```text
ECONOMY_BUY · ECONOMY_SETTLE · ECONOMY_RESERVE · ECONOMY_GRANT · ECONOMY_APPROVE · ECONOMY_LEDGER
```

载入期不变量逐名断言这六个名字不在**任何**一份名单里 —— 它们只能是"未知动作"。

### 2.1 §9 为什么连"保守的 resume"都不开

`ECONOMY_RESUME_APPROVED_PURCHASE` 登记在 `NOT_OFFERED` 里（这是一份**拒绝名单**，
不是第二个词表）：

| 字段 | 值 |
|---|---|
| `action` | `ECONOMY_RESUME_APPROVED_PURCHASE` |
| `capability` | `RESUME_APPROVED_PURCHASE`（门**确实**把它授予了 `active_agent_runtime`） |
| `reasonCode` | `NO_APPROVAL_TRIGGER_SEAM` |
| `evidence` | `services/home-node/economy-store.js#decideApproval` 的**生产调用方数 = 0**（唯一调用方是 `tests/*`）；`services/home-node/http.js` 把"用户点批准"的入口逐字标为留给未来的 UI / Action authority 阶段 |

⇒ 今天这个仓库里**不存在**一条可靠的"用户已批准"触发 seam。§9 逐字要求：
"如果当前真实 runtime 没有可靠的用户已批准触发 seam，本阶段不要接 resume。
宁可只做 propose。" —— 因此只做 propose。

**已知但不开放**与**完全未知**是两个不同的理由码（`ACTION_NOT_OFFERED` vs
`UNKNOWN_ECONOMY_ACTION`）：把它们并成一个会让"我们故意没开"看起来像"模型胡说了"。

**结构性后果**：适配器的**代码视图**（剥注释与字符串之后）里**没有**
`resumeApprovedPurchase` 这个成员名（focused test D6 / I2 逐字断言）——
它连"能 resume"都不是一个可选分支。

---

## 3. §3 依赖方向：只持有 bound handle

```js
createEconomyActionAdapter(economyCapabilityHandle)   // ✅ §3 要求的签名
createEconomyActionAdapter(economyStore)              // ❌ **构造期就抛**
```

抛出的依据是 `LOW_LEVEL_ECONOMY_VERBS`（37 个 canonical store 成员名）：
一个对象只要露出其中任何一个名字，它就是一个 store，而不是 capability handle。
这不是"不推荐"，是"传不进去"（focused test D1/D2）。

句柄本身（P22-9 产出）的键恰好五个：

```text
consumer · anchor · capabilities · proposePurchaseIntent · resumeApprovedPurchase
```

适配器实例的键恰好七个：

```text
consumer · capabilities · actions · notOfferedActions · sanitizeAction · performAction · describe
```

**没有** `store`、**没有** `gate`、**没有** `handle`、**没有**任何底层动词
（focused test A4/D3/D5）。全文件对句柄的访问是**一处字面成员名**：

```js
boundHandle.proposePurchaseIntent({ proposal, idempotencyKey })
```

源码里没有 `handle[…]` 形式的计算型分派，没有 `executeEconomyAction(method,args)`，
没有 `economy(method,args)`（focused test I1–I3：`performAction.length === 1`，
`sanitizeAction.length === 1`，`createEconomyActionAdapter.length === 1`）。

---

## 4. §4 模型输入最小化

动作对象的白名单**恰好三个键**：

| 键 | 谁判定 | 说明 |
|---|---|---|
| `action` | **适配器**（封闭集，逐字匹配） | 不 trim、不折大小写、不容错 |
| `proposal` | 形状由适配器（"是不是普通对象"），**语义 100% 由 P22-8** | 原样转发，适配器一个字都不解释 |
| `idempotencyKey` | 形状由适配器（非空字符串），**规范化由 P22-8** | 逐字转发 |

### 4.1 九个禁止偷渡的键，两层各挡一次

§4 点名的 `price / amountMinor / currency / budget / approval / autoAllow /
settlementType / wallet / ledger`：

* **放在动作层** → 适配器以 `UNEXPECTED_ACTION_KEYS` **列名**拒绝；
* **放进 proposal** → 原样交给 P22-8：
  * `price` / `amountMinor` / `currency` / `autoAllow` / `settlementType` 等契约认识的
    事实 → `MODEL_SUPPLIED_ECONOMIC_FACT`（**信任边界违规**）并逐名列出；
  * `budget` / `approval` / `wallet` / `ledger` 这种裸词 → `intent-proposal-key-not-whitelisted`
    （也是拒绝，只是理由不同）。
* 两种情形下钱包余额逐字不变、`listPurchaseIntents().count === 0`、`listPurchases().count === 0`
  （focused test C1/C2）。

### 4.2 适配器**不带**第二份经济事实名单

`MODEL_SUPPLIED_ECONOMIC_FACT`、`amountMinor`、`settlementType`、`unitPriceMinor`、
`PURCHASE_INTENT_ECONOMIC_FACTS`、`FORBIDDEN_PRODUCT_FIELDS` 在适配器源码里
**一个都不出现**（focused test B10，按"剥注释+字符串"的代码视图断言）。
理由：§4 要求"P22-8 validation 必须继续是 authority"，而两处各自维护一份事实名单
必然漂移 —— 而且 P22-8 的答案更准（它会**列名**）。

---

## 5. §5 Action ≠ Authority

每一个返回值（成功与拒绝）都带着同一组**恒 false** 的位：

```text
isAnEconomyAuthority · isABudgetDecision · isAnAutonomyDecision · isAnApproval
isAPurchasePermission · authorizesSpending · grantsBudget · grantsApproval
grantsSettlement · permitsSettlement · isAutoAllow
bypassesAutonomy · bypassesBudget · bypassesQuoteExpiry
```

外加四句结构性自述：`actionIsNotAuthority: true` ·
`actionSuccessIsNotAPurchase: true` · `interpretsEconomicFacts: false` ·
`holdsRawStore: false`。

一句成功的 `ECONOMY_PROPOSE_PURCHASE` 只代表"Agent 请求提出购买意图"。下游逐层：

```text
P22-9 准入   → 你能不能开口
P22-8 提议   → 这条打算能不能被写下来（经济事实拒绝 / 商品存在 / 有效期 / 指纹 / 幂等）
P22-7 权威   → AUTO_ALLOW 还是 REQUIRE_APPROVAL，以及自主额度与 per-purchase 上限
P22-6 执行   → 报价快照 + 预算 + 预留 + 恰好一个 SQLite 事务
```

适配器的返回值**原样透出**下游的字段（`ok` / `intentId` / `quoteId` / `approvalId` /
`purchaseId` / `authorityOutcome` / `replayed` / `suppressed` / `reservedNothing` …），
只**加上**自己的自述位 —— 一个手写返回对象会把"多了一层"变成"少了一个字段"。

---

## 6. §6 接入：只接 `active_agent_runtime`，全仓库唯一一次 bind

### 6.1 装配点

`services/home-node-service.js#economyAssembly`（**唯一**一处）：

```js
const economyCapabilityGate = options.economyGate || createEconomyCapabilityGate({ store: economyStore, ... });
const economyActionAdapter = options.economyActionAdapter
  || economyActionAdapterModule.bindActiveAgentEconomyAdapter(economyCapabilityGate);
return { economyStore, economyCapabilityGate, economyActionAdapter };
```

`bindActiveAgentEconomyAdapter(gate)` 内部就是那**唯一**一次
`gate.bind(C.ECONOMY_CONSUMER.ACTIVE_AGENT_RUNTIME)`。

**为什么这算一次真的接线**：P22-9 造好了门、导出了门，但在生产代码里
`bind(` 的调用数是 **0** —— "谁被授予了 `PROPOSE_PURCHASE`"只是一个声明。
本阶段让那个被声明的身份**第一次被实例化**，并把唯一能使用它的东西放上去。

### 6.2 只绑一个消费者

| consumer | 锚点 | 本阶段 |
|---|---|---|
| `active_agent_runtime` | `runtime/component-registry.js#active`（23114，`services/active-message-service.js`） | **绑定** |
| `home_node_authority` | `#homeNode` | 不绑 |
| `desktop_bridge` | `#bridge` | 不绑 |

`Chat / Group / Voice / Diary / MCP` 一个都不绑 —— P22-9 已经证明它们作为 Node
运行时消费者**不存在**（`CAPABILITY_SURFACES_NOT_PRESENT`），凭空绑一个等于凭空
发明一个已经授予的权限。focused test B5 逐名断言：生产代码里**没有**任何一处
bind `DESKTOP_BRIDGE` / `HOME_NODE_AUTHORITY`，也没有硬编码的
`bind('active_agent_runtime')`（必须走契约常量）。

锚点本身是**可核对**的，不是一句声明：runtime 测试 B1 从
`CONSUMER_RUNTIME_ANCHOR` 取出 `#active`，回到 `component-registry` 读到
`serviceFile === 'services/active-message-service.js'`、`defaultPort === 23114`、
`portEnv === 'IB_ACTIVE_PORT'`，并断言那个文件真的在磁盘上。

### 6.3 既有 Active 动作链**一行未改**

| 断言 | 证据 |
|---|---|
| 两条既有封闭动作集逐字未变，且**不含**任何 `ECONOMY_` | runtime B2 |
| `active/` + `assets/js/active-diary/` + `services/active-message-service.js` 里 `economy` 引用数 = **0** | runtime B3 |
| Middle Brain 里 `economy` 引用数 = **0** | runtime B4 |
| 装配层对 Economy 的 require 恰好三个，没有第二个 store owner | runtime A6 |
| 适配器不在 `httpLayer` 上，不在任何 `/economy/*` 路由上 | runtime A5 / B6 |

⇒ **没有**为了接 Economy 新造第二套 Action framework：适配器是那条既有链**旁边**的
一个新的窄出口，而不是一个新的 dispatcher；既有链本身逐字未动。

---

## 7. §7 模型动作必须经过既有 sanitizer 链

```text
模型输出
  → 解析（Active 自己的 _activeParsePlanJson / parsePlanJson）
  → 既有封闭动作集（['schedule','none','cancel_existing'] / ['send','reschedule','cancel']）
  → 执行
        ↳ 当且仅当这一步要开口向经济域说话时：
            sanitizeEconomyAction（本适配器 · 封闭动作集）  ← 不是旁路，是这条链的下一环
              → performAction → bound handle → 门 → P22-8
```

**禁止的直连形态**（`模型输出 → Economy Adapter`）在本阶段不存在，理由有两层：

1. 适配器的唯一入口就是 `sanitizeAction` + `performAction`，而 `performAction`
   **先净化、后转发**：净化不通过就返回拒绝，句柄一次都不被调用
   （focused test D4：用一个"一被调用就抛错"的句柄证伪 —— 拒绝路径返回一条拒绝，
   而合法动作**真的**让它抛了，证明这个机关是有效的而不是永远不响的）。
2. Active 的既有动作集里没有任何经济动词（§6.3），因此模型今天**没有**一条
   "直接说出经济动作"的路径 —— 它必须先落到那个封闭动作集里。

净化器的拒绝码是封闭集：

```text
ACTION_NOT_A_PLAIN_OBJECT · MISSING_ACTION · UNKNOWN_ECONOMY_ACTION · ACTION_NOT_OFFERED
UNEXPECTED_ACTION_KEYS · MISSING_PROPOSAL · PROPOSAL_NOT_A_PLAIN_OBJECT
MISSING_IDEMPOTENCY_KEY · ECONOMY_ACTION_ADAPTER_NOT_BOUND
```

**不猜修复**是硬性质：`'economy_propose_purchase'`、`'ECONOMY_PROPOSE_PURCHASE '`
都是"未知动作"，而不是"帮你修好"。一条"帮你修好"的净化器会把"模型胡说了什么"
变成一次看不见的失误。

---

## 8. §8 重复 Action 不得重复购买

适配器**没有**第二套 Economy dedupe —— 它**零状态**：没有表、没有 Map/Set、
没有窗口常量、没有缓存、没有计数器（focused test F3，按代码视图逐名断言）。

它做的只有一件事：把 `idempotencyKey` **逐字**传下去（focused test F4 用一个
记录型句柄断言 store 收到的键恰好是 `idempotencyKey,proposal` 两个，没有第三个）。

于是 P22-8 的两道机制各自负责一半：

| 情形 | 机制 | 结果 |
|---|---|---|
| 同一个动作对象调用两次（同一幂等身份） | P22-8 的 idempotency 记录 | 第二次 `replayed: true`，**同一个** `intentId`，库里 1 条 intent / 1 笔购买 |
| 同一意图换一个幂等键复读（60 秒窗口内） | P22-8 的 `PURCHASE_INTENT_DEDUPE_WINDOW_MS` | 第二次 `suppressed: true`，它给出的 id 是**已经存在**的那条 intent（`WAITING_APPROVAL`），库里仍然 1 条 |

两条都由 focused test F1/F2（以及 runtime C4）在真实 store 上断言。

**缺幂等键 → 拒绝**，而不是这里生成一个：生成它等于把"同一动作重复两次"变成
"两次不同的提议" —— 那正是"自己造了一套 dedupe"的反面。

---

## 9. §10 Audit / trace：谁被连起来了

适配器**不复制** Ledger / Purchase / Approval 的任何审计。它只产生**必要 linkage**：

```text
哪个 Active action 发起？    → action 名（ECONOMY_PROPOSE_PURCHASE）
哪个 consumer？              → active_agent_runtime（门写进 capability audit）
形成哪个 Agent Intent？      → P22-8 的 intentId（门把它与 consumer 连起来）
最后为什么买/没买？          → P22-7 的 authorityOutcome + P22-6 的 canonical facts
```

门的审计仍然只记两种**有业务意义**的事（P22-9 §7 不变）：一次被拒的提议写一行
`DENIED`，一次真的走到 intent 的提议写一行 `GRANTED` 并带上 `agentIntentId`；
纯检查、幂等重放与去重窗口内的抑制**不写**。

---

## 10. §11 HTTP / MCP / UI 不变

| 面 | 本阶段数字 |
|---|---|
| HTTP Economy 写路由 | **0**（`/economy/*` 仍然全是 GET；runtime B6 逐块断言） |
| HTTP 上的适配器 | **0**（`httpLayer` 上没有它；`http.js` 源码里没有它的名字） |
| MCP Economy tool | **0**（`assets/js/integrations.js` 里 `economy` 引用数 0） |
| UI | **0**（本阶段没有改任何 `InternalBeyond.html` 或 `assets/js`） |
| Provider mutation | **0** |
| Payment | **0** |
| network | **0**（适配器 require 的目标恰好一个：`./economy-contract.js`；无 `http`/`net`/`child_process`/`fetch`） |
| Middle Brain 改动 | **0** |

---

## 11. §12 测试资源纪律

| 指标 | P22-10 |
|---|---|
| 最大同时 child process | **0** |
| 总 spawn 次数 | **0** |
| 遗留 child | **否**（没有 child 可遗留） |
| 每个 child 加载的主要模块 | 不适用 |
| 峰值 RSS | 未测量（§12：不为此引入监控系统） |

**为什么是 0**：本阶段的自有 invariant 全部是"一个纯净化器 + 一次窄转发 + 一次
同进程 store 调用"。唯一跨进程的性质属于 P22-8 的 store（同一提议在两个真实进程里
恰好产生一条 intent），已经在 `tests/fixtures/p22-8-intent-worker.js` 的两进程组里
证明过 —— §12 明确不要重做。P22-9 已经用真实 socket 证明过"HTTP 上没有门的任何面"，
本文件不重做，只断言 HTTP 源码里仍然没有适配器。

没有测试宿主：不启动 Desktop / Electron / Playwright / 浏览器 / DSH / IB UI。
runtime 测试里的"真实装配"是**同进程**的两次函数调用（`buildHomeNode()` 与模块级
装配），不是两个操作系统进程。

**隔离**：每个组一次性临时目录 + 独立 store；runtime 测试在 `require` 本服务
**之前**把 `IB_HOME_NODE_DATA_DIR` 指到临时目录，因此连**进程级装配**那条路径也不碰
生产 dataDir。两个文件末尾各自断言：所有 store/server 已关闭、临时目录已删除、
`child_process` 未加载。

---

## 12. §13 focused tests

```text
tests/test_p22_10_economy_action_adapter.js    52 checks
tests/test_p22_10_economy_active_runtime.js    19 checks
```

| §13 要求的锁 | 断言 |
|---|---|
| valid action → bound handle | B1 · C1 · G3 · runtime C1 |
| unknown action rejected | B2 · B4 · E2 · H1（`ECONOMY_BUY` 等） |
| malformed proposal rejected | B5 · B6 |
| economic facts cannot be injected | **C1**（action 层列名拒绝）· **C2/C3**（proposal 层由 P22-8 拒） |
| raw store inaccessible | **D1**（传 store 构造期就抛）· D2 · D5 |
| bottom-level mutation inaccessible | D5（12 个动词的成员调用一个都没有）· D6 · I1 · I2 |
| **P22-9 cannot be bypassed** | **G1**（被拒消费者由**门**拒绝）· H1/H2（全仓库唯一调用点/唯一绑定点） |
| duplicate action doesn't duplicate purchase | **F1** · **F2** · **F3**（零去重状态）· runtime C4 |
| denied capability produces no Intent | G1 · G2 · runtime C3 |
| AUTO_ALLOW still passes full downstream authority | G3 · G4（预算说不 → FAILED、余额逐字不变）· runtime C1 |
| REQUIRE_APPROVAL still stops | G5 · runtime C2 |
| §9 resume 不接 | A3 · G6 · D6 · I2 |
| §6 只接 Active | runtime B1–B6 |
| child process = 0 | 两个文件末尾 R2 各自自报 |

登记：`tests/test-all.js` 的 static 组尾部新增两条。

---

## 13. §14 aggregate

```text
P22 全量 25 个文件（P22-1 ~ P22-10）· 2506 checks · 0 failed（提交后复跑）
P22-10 新增 71 checks（adapter 52 + runtime 19）；P22-9 时是 2435，2435 + 71 = 2506
aggregate（提交后）：
  static  106 项 · 349.6s · 2 失败
  service  29 项 · 107.4s · 全部通过
```

那 2 项 static 失败是**已知基线失败**，与 Economy 无关、economy 引用数为 0，
而且 P22-8 阶段已经在裸基线 `5a10940` 上反证过：

```text
test_cache_audit.js                          （第 242 行读 undefined.text 崩溃）
test_middle_brain_convergence_counterproof.js（它的变异 harness 连 base.copyIsGreen 都起不来）
```

★ 提交**之前**同一份 aggregate 是 3 失败：多出来的是
`test_astra_readiness_observe.js` 的 `Z1.noProductionFileChanged` —— 那条断言读的是
`git diff --name-only HEAD -- assets services InternalBeyond.html` 必须为**空**，也就是
"工作树里没有任何未提交的生产改动"。本阶段改了 `services/home-node-service.js`，
所以在提交前它必然红。提交后它逐字变绿（实测：`PASS Z1.noProductionFileChanged`，
该文件 0 failed）—— 这同时是对"第 3 项失败不是回归"的**独立证据**。

---

## 14. §15 未进入（本阶段刻意不做）

```text
MCP Economy tools        Chat / Group / Voice / Diary Economy        UI / 素材
Exchange                 Refund                                      真实 Provider quota
真实支付                 跨进程经济通道（= 新的写面）                 通用 RBAC / 持久化准入配置
resume（见 §2.1：没有触发 seam）
```

---

## 15. §16 已知限制（诚实记录）

1. **适配器是进程内的一层，不是操作系统沙箱。** 它做到的是：拿不到 store、
   拿不到底层动词、动作集恰好一个、唯一一次 `bind` 在装配层。任何能拿到
   `buildHomeNode()` 返回值或 `require` 到 store 的代码**在进程内**仍然可以直接
   调用 store —— 这是既有架构的事实（P22-2 起 store 就在同进程 API 上）。
   本阶段把"绕过"从一句自觉变成一次会让 H1/H2 变红的改动。
2. **Active 的决策循环跑在另一个进程里。** 适配器长在句柄唯一可能存在的地方
   （Home Node 的装配层），而 Active companion 在 23114 —— 两者之间今天**没有**
   经济通道，而本阶段**刻意没有造**（造通道就是造一条新的写面，与 P22-2/P22-9
   的边界直接冲突）。因此今天这条链的"模型侧发起者"是**同进程的 Decision/Action
   seam**，而不是 23114 那个进程。这是本阶段最需要被读准的一句话。
3. **`active_agent_runtime` 今天还没有在生产上真的提议过购买。** 本阶段证明的是：
   当它接线时，它只能经适配器 → 门 → P22-8；而适配器已经在装配层、已经绑定、
   已经端到端测过。
4. **幂等身份由调用方（runtime 步骤）提供。** 一个模型若能连幂等键一起复读，
   它能绕开 P22-8 的 idempotency —— 但绕不开 60 秒的重复窗口（focused test F2）。
   适配器不生成幂等键，因为"生成"就是自己造 dedupe 的反面（§8）。
5. **`proposal.agentId` 仍在 P22-8 的六键白名单里**，因此模型仍然"选"由哪个
   canonical 角色提出意图（P22-8 会把它核对成 canonical 角色/用户）。适配器
   **不**替它填、**不**改写它 —— 那是 P22-8 的 authority。
6. **生产文件从三个变成四个。** 这是本阶段唯一一次"多一个文件"，理由写在
   `test_p22_1_economy_boundary.js` 的 `PRODUCTION_FILES` 与
   `test_p22_6_economy_purchase.js` 的 K6 里（"适配器必须长在门的上面"）。
   依赖闭包**没有**变宽：新文件 require 的仍是那份已有的契约。
