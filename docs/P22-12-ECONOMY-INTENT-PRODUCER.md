# P22-12 · Active Economy Intent Producer

冻结基线：

```text
37275f3  P22-11 · add authenticated Active Economy command channel
6492440  P22-11 · record the aggregate evidence for the command channel
```

本阶段只做一件事：让 `active_agent_runtime` 的模型**真的**能在合适情况下
提出 `economy_propose_purchase`。

P22-11 结束时留下的那句话必须被兑现（P22-11 文档 §13.1）：

> **今天没有任何生产代码会主动发出 `economy_propose_purchase`。**
> 通道的一侧是完整的；另一侧只提供了**入口**，没有提供生产者。

P22-12 补上生产者 —— 而且只补生产者。

---

## §1 只读审计：Producer seam 到底在哪一层

审计的对象是"模型的一次结构化决策从哪来、经过谁、到哪去"。结论先说：
**这条链早就存在，而且只有一条。**

| 环节 | 真实位置 | 本阶段动它了吗 |
|---|---|---|
| Active prompt 构建 | `assets/js/active-diary/active-plans.js` 的 `buildPlanPrompt(args)` | **是**（加了一个条件块） |
| structured output / 解析 | 同文件的 `_activeParsePlanJson`（A 完整 JSON → B 围栏 → C prefill 续写 → D 首尾大括号） | 否（逐字未改） |
| 模型动作净化器 | 同文件的 `_activeValidatePlanResult` → `_activeValidatePlanResultCore`（封闭集 `['schedule','none','cancel_existing']`） | **是**（同一个函数，分流分支扩展） |
| 净化后的动作出口 | 同文件的 `planNextProactiveMessage` → `NS.activeEconomyProposalSink` | **是**（注入点在 P22-11 就存在，本阶段第一次有真实实现） |
| P22-11 新增动作目前被接受的层 | `_activeValidatePlanResult` 的**分流**（P22-11 §9），以及 23114 的 `sanitizeEconomyProposal` 镜像 | **是**（两层都收紧了） |
| 跨进程出口 | `assets/js/active-diary.js` 的 `_activeCompanionRequest` → 23114 `/economy/propose-purchase` → `active/http.js` → `active/economy-channel-client.js` | **是**（第一次真的有调用方） |

### 1.1 三条被审计排除的错误假设

1. **`sanitizeAiPlan` 不是模型动作净化器。** 它是 `active/plan-domain.js` 里的
   **计划记录**净化器（`PUT /plans/:id` 的入库形状），模型动作的白名单在浏览器
   那一份 `_activeValidatePlanResult` 里。把两者混为一谈会让"模型动作必须过
   sanitizer"这句话有两个答案。
2. **`services/active-message-service.js` 的 `validatePlanResult` 不是第二个权威。**
   它是浏览器那份的 companion 镜像，注释逐字写着"测试用"。模型**不**经过它。
3. **Node 侧没有第二个 planner。** `active/scheduler.js` 的 `buildPlanEvalPrompt`
   评的是**已经存在的计划**（send / reschedule / cancel），`active/model-client.js`
   的 `buildProactivePrompt` 生成的是**消息文本**。两者都不产生"新计划"或"新动作"。
   ⇒ 因此本阶段**没有**碰它们，也没有碰 Middle Brain。

### 1.2 为什么生产者必然是浏览器那一份

`_activeMaybePlanNext`（聊天回复完成后 600ms）→ `planNextProactiveMessage` →
一次模型调用 → 净化 → 出口。这是仓库里**唯一**一条"模型产出结构化动作"的链。
P22-9 的消费者登记册里 `active_agent_runtime` 锚在 `component-registry.js#active`
（23114），而这条链的产物正是经 23114 走出去的 —— 两件事在同一台机器上首尾相接。

---

## §2 唯一的一个动作

```text
ACTIVE_ECONOMY_PROPOSAL_ACTION = 'economy_propose_purchase'
```

冻结拼写逐字保留（P22-11 已冻结）。本阶段**没有** rename，也没有把
`econonomy_propose_purchase` 这种拼写分叉带进仓库。

模型**不能**产生八个禁止动作中的任何一个：

```text
buy / settle / reserve / approve / resume / grant / ledger / wallet_mutate / auto_allow
```

也不能产生通用 `economy(method,args)`。它们全部是"未知动作" ⇒ 净化器返回 `null`
⇒ 调用方放弃创建 ⇒ **不会到达传输层**。
（证据：`test_p22_12_economy_intent_producer.js` B9 十三个名字 × 大小写两种形态。）

---

## §3 Prompt 明确：提出 ≠ 获准

Prompt 里新增的这一段（只在真的能提议时出现）逐字写了：

> 提出购买**不等于**获准购买。你没有购买权、没有预算权、没有批准权：
> 能不能买、要不要先由用户批准、以及买完怎么结算，全部由内部经济层决定，
> 不由你决定。

而下面这些句子**一个都不存在**（逐句断言，见 A7）：

```text
你有权购买 · 你可以花 X · 余额足够就买 · 预算允许 · 用户已经批准
可以自动结算 · 有钱就花 · 定期消费 · 为了体验经济系统而购物 · 尽量使用预算
```

### 3.1 这一段只给语义，不给 authority

它给的是"**什么时候**值得提"和"**怎么**提"，以及"**不要**因为什么提"。
它不携带任何数值：没有余额、没有预算余量、没有自主权阈值、没有批准状态、
没有账本、没有任何内部结算原语。
（证据：A18 —— prompt 里 `approvalId` / `settlementType` / `ledger` /
`budgetResult` / `walletBalance` / `autoAllow` 逐字不存在。）

---

## §4 模型只能选择意图字段

### 4.1 构造式白名单

```text
ACTIVE_ECONOMY_PROPOSAL_FIELDS = ['productId','recipientId','units','reason']
```

这**恰好**是 P22-8 的 `PURCHASE_INTENT_PROPOSAL_KEYS` 减去两样（E7 用契约里
那份**真实**名单逐字对齐，不是靠注释承诺）：

| 减掉的 | 为什么 |
|---|---|
| `agentId` | 它是**本地配置事实**（这次购买以哪个角色名义），由运行环境填写，不由模型自报 |
| `expiresAt` | 有效期是"这个打算我想到什么时候为止"，P22-8 自己夹取，模型不选 |

不在表里的键让**整条提案** fail closed，而不是"转发给下游再拒一次"。
这是一份白名单，不是黑名单 —— 剥掉注释与字符串之后，净化器的代码里
**一个经济事实键名都没有**（B6）。

被逐名拒绝的（B4，二十二个）：`price` / `amountMinor` / `currency` / `balance` /
`walletBalance` / `budget` / `budgetResult` / `approvalId` / `approved` /
`autoAllow` / `settlementType` / `ledger` / `grantQuantity` / `consumerId` /
`consumer` / `capability` / `role` / `authority` / `unitsMinor` /
`unitPriceMinor` / `purchasedQuantity` …

### 4.2 `agentId` 为什么是注入的而不是模型自报的

一次购买必须以**某个角色**的名义发生，而"我是谁"不是模型能自报的东西
（P22-11 §3 已经为 `consumerId`/`capability` 立过同一条规矩）。
因此：

* 模型的 `proposal` 里出现 `agentId` ⇒ 不在白名单 ⇒ 整条拒绝（B2）；
* 运行环境缺席（没有 `ctx.agentId`）⇒ 整条拒绝（B3）——
  **不替模型编一个身份**。

### 4.3 两层净化器的方向性差异（这是一个被测试钉住的设计，不是漂移）

| 层 | 位置 | 白名单 | 为什么 |
|---|---|---|---|
| 模型边界 | `assets/js/active-diary/active-plans.js` | 四个意图字段 | 模型不许自报身份 |
| 传输边界 | `services/active-message-service.js`（23114 的镜像） | 四个意图字段 **+ `agentId`** | 到达 23114 的 payload **本来就应该**带着生产者补上的身份 |

差集**恰好**是 `['agentId']`，方向也由测试钉住（B15）。
开发期实测踩到过：两层写成一模一样的名单时，**每一次真实提议都在 23114 拿到
400 `economy-proposal-rejected`** —— 唯一的合法生产者被挡在门外。

而"顶层偷渡"这两层的处理**刻意不同**（B16 / B16b / B17）：

* **模型边界**：顶层多一个 `price`/`group` ⇒ 整条拒绝（模型写了不该写的
  东西必须被拒，不能被悄悄丢掉）；
* **传输边界**：这一层是**投影**（返回值只含 `{proposal, idempotencyKey}`），
  顶层多出来的键本来就不会被转发 —— 再拒一次只会让一条无害的调用失败。
  **身份自报键在任何一层都是硬拒**，包括顶层。

> 这一条修得不容易，值得记下来：镜像最初也对顶层键做白名单，结果是 P22-11 的
> bridge 直接红 6 条 —— 那个 fixture 的测试入口把整条
> `{command, commandId, idempotencyKey, proposal}` 交给这同一个净化器，于是
> "未知 command 应该被 **23118** 拒"这条跨进程断言变成了"在 23114 就被拒"，
> 也就测不到它要测的东西了。

---

## §5 `none` 必须是一等路径

* 既有三个动作逐字仍在，`none` 的描述没有被本阶段改动（A2）；
* 经济段里写死了："正常情况下返回 `action:"none"` 是完全正确、完全正常的决定。
  不要为了'用上经济系统'、不要因为余额看起来充足、不要因为今天还没买过、
  不要为了提高好感度或亲密度而提出购买。**经济系统是一种可选能力，
  不是你要完成的指标。**"（A5、A7）
* 真实的 `none` 走完整条链之后：返回 `null`、**零次**经济请求、一个字都没发出去（D3）。

### 5.1 没有"消费 KPI"的机器版本

`buildPlanPrompt` 只在 `_activeEconomyProposalAllowed() && 目录事实非空` 时才
宣告这个动作（A6）。**没有商品可选**时连动作名都不出现 —— 一个"可以提出购买"
却没有任何 `productId` 可选的画面只会把模型推向编造商品。

而闸门默认是 **false**：一段"以后可能会用"的 prompt 如果默认打开，
那就是一条已经存在的写路径（P22-11 的原话）。

---

## §6 什么情况下可以提出

Prompt 给的是**语义**指导，不是 authority：

```text
可以：当前目标确实需要某个内部数字物品 / 真的要用到某个内部服务或内部物品 /
      你明确想把某个内部物品送给某个人
不可以：因为余额看起来充足 / 因为今天还没买过 / 为了提高好感度或亲密度 /
        为了"用上经济系统"
```

**Relationship / Memory 不是购买权限，也不是奖励函数。**
关系数据在 P22-12 里既没有进 prompt 的经济段，也没有进净化器的任何一份名单。

---

## §7 Compute / API quota 只是内部 entitlement

Prompt 逐字写了：

> 当你觉得"内部算力/额度不够"时，请不要把它说成充值：这里说的只是
> InternalBeyond 的**内部 entitlement**（内部额度），不是给任何外部 Provider
> 充值、不是购买真实 token、也不会调用任何 Provider 的计费。即使成功，
> 你得到的也只是这份内部额度本身。

而代码侧：`COMPUTE_ENTITLEMENT` / `settlement` / `grant` 在生产者里**零出现**（E8），
Prompt 里也没有 `recharge` / `quota` / `providerBilling` / `topup`（D2）。
成功之后仍然只有 P22-6 冻结的那一种内部发放 —— 本阶段没有碰它。

---

## §8 Gift 保持 WANT-only

模型可以表达"我想给角色 B 送 Product X"，做法就是 `recipientId` + `productId` +
`reason` 三个字段。它**不**输出任何"因为关系很好所以不用批准"的东西：

* 代码里没有 `skipApproval` / `relationshipBypass` / `approvedByRelationship`（D1）；
* Prompt 里明确写了"你没有'因为关系好所以不用批准'这种判断权：
  是否需要批准完全由内部审批层决定"（A14）。

是否允许 Gift、要不要走审批，继续**完全**属于 P22-7（本阶段那两份文件
一个字节都没动，A5）。

---

## §9 Catalog grounding

### 9.1 审计结论：Active 的既有上下文里**没有**目录

`buildPlanPrompt` 的既有输入是：角色设定、关系、聊天摘要/最近消息、长期记忆、
已发过的主动消息、当前计划、用户偏好、免打扰。**没有**任何商品信息。

### 9.2 最小只读注入（不造新的 Economy API）

```text
assets/js/home-node-client.js       ← 既有"浏览器侧唯一的 Home Node 传输实现"
  economyCatalogFacts()             ← 新增的**一个**只读方法
      GET /economy/products         ← 既有 P22-5 读面，一个字都没改
      → 构造式投影 → {productId,name,description,kind,unitName,status}
assets/js/home-node-bootstrap.js    ← 既有装配根：把上面那个方法注册成
  NS.activeEconomyCatalogProvider     一个注入的只读 provider
assets/js/active-diary/active-plans.js ← 规划器：只读注入，不认识 23118
```

* 客户端新增的 `/economy/` 字符串只有**一条**，而且是读路径（D5）；
* 投影是**构造式白名单**（D3）：服务端 `serializeProduct` 里真的有
  `currency` / `unitPriceMinor` / `grantQuantity`，而它们**默认不可达** ——
  一份"删字段"的实现会在服务端新增一个经济字段时静默泄漏它（D2 逐字断言）；
* 取不到目录时**不抛**，归类成 `{ok:false, products:[]}`，规划器于是 fail closed
  到"这次不宣告"（D4、A6）。

**绝不注入 prompt 的**：wallet balance / budget decision / autonomy threshold /
approval state / ledger / 内部 settlement primitive。A18 逐名断言它们不在 prompt 里。

---

## §10 防止购买循环：复用 P22-8，不建第二套

### 10.1 一条真实的发现：模型给的 key 原本上不了路

`active/economy-channel-client.js` 的 `sendCommand` 只在**同时**给出 `commandId`
与 `idempotencyKey` 时才用调用方的身份，否则 `createCommandIdentity()` 现生成一个。
P22-11 的 23114 路由只传了 `idempotencyKey` —— 于是**通道每次都新生成一个身份**，
模型那个稳定 key 被丢掉。

后果不是"买错东西"，而是：P22-8 的重复抑制有两条腿（**意图指纹** +
**幂等键**），而幂等那条腿看不到生产者算好的身份，只剩它自己的 60s 指纹窗口兜着。

### 10.2 修法：canonical 身份由**生产者**从指纹字段推导

```text
_activeEconomyIdempotencyKey(proposal)
  = 'p22-12.' + agentId + '.' + productId + '.' + (recipientId|self) + '.' + units
```

* 四个字段**恰好**是 P22-8 的 `PURCHASE_INTENT_FINGERPRINT_KEYS` 减去
  `selfDirected`（它由 `recipientId` 是否存在推导）；**`reason` 不参与**（E7）——
  否则"复读二十次、每次换个理由"就能买二十次；
* 形状满足 P22-8 的 `IDEMPOTENCY_KEY_RE`（E6，用契约自己的
  `normalizeIdempotencyKey` 判定，而不是抄一份正则）；
* 模型自己写的那个 key **不上路**（C6c），只作为 `modelIdempotencyKey` 留在
  返回值里当旁证；
* 23114 的路由把同一个值同时作为 `commandId` 与 `idempotencyKey` 交给通道
  （C6b）—— 这不是新增语义，只是**不再把调用方已经算好的身份丢掉**。

### 10.3 生产者层的轻量约束（**不是**第二套 dedupe）

一个会话内、有界（≤64 条）、可清空的抑制表：

```text
窗口 = 60_000 ms   ← 数值与 P22-8 的 PURCHASE_INTENT_DEDUPE_WINDOW_MS 相同，
                      并由测试钉住两者相等（C8）—— 契约改窗口时这里会跟着红
```

它只决定"这条完全相同的提议要不要再发一次"：
**不裁决任何经济结论**、返回值是 `null` 而不是"被拒绝"、绕过或清空它结论不变
（同一份模型输出仍然给出同一个 canonical 身份）。
P22-8 的指纹 + 60s 窗口 + 幂等 + CAS 仍然是唯一的收敛权威。

★ 只有 `delivery === 'DELIVERED'` 才记账（E5）。一次 `DELIVERY_UNKNOWN` /
传输失败**不**被写成"已经提议过" —— 那恰好是把"未知"当成"买过了"。

---

## §11 真实 Producer 接线（本阶段存在的东西）

```text
Active context（角色 / 记忆 / 聊天 / 计划 / 偏好）
    ↓  buildPlanPrompt（**只在闸门开且有目录事实时**宣告这个动作）
LLM structured decision（既有 callApiChat，jsonMode）
    ↓  _activeParsePlanJson（逐字未改）
existing sanitizer（_activeValidatePlanResult → _activeValidateEconomyPlanResult）
    ↓  构造式白名单 + 本地注入的 agentId + canonical 身份
econonomy_propose_purchase
    ↓  planNextProactiveMessage 的出口分支（净化**之后**）
P22-11 client seam
    ↓  _activeCompanionRequest → POST 127.0.0.1:23114/economy/propose-purchase
真实 23114 路由（active/http.js）→ 真实镜像净化器 → 真实通道客户端
    ↓  POST 127.0.0.1:23118/internal/economy/command（来源凭据在头里）
P22-10 → P22-9 → P22-8 → P22-7 → P22-6
```

### 11.1 闸门：一个条件、一个来源

```text
active/http.js  GET /health
   economy_proposals_enabled: typeof economyPropose === 'function'
        ↓（浏览器已有的那次 health 往返）
assets/js/active-diary.js  _activeEconomyGate(health.economy_proposals_enabled)
        ↓
NS.activeEconomyProposalEnabled   ← 唯一一个写入点（C2）
        ↓
buildPlanPrompt 是否宣告 · 净化器是否接受
```

也就是说：**"prompt 里宣告了这个动作"与"这个部署真的配好了 command 通道"
是同一个条件。** 未配置通道的部署（默认！）里，模型那边什么都不变。
服务一旦不可达，闸门立刻收敛回 false（C13）—— 不是"上一轮说 true 就一直 true"。

★ `/health` 上新增的是一个**只读布尔**，不携带任何权威事实：
没有余额、没有预算、没有批准状态、没有账本、没有门（S7 逐名断言键名不相交）。
它也不放宽任何东西：为 false 时那条 POST 分支根本不存在（P22-11 的 404 逐字保留）。

### 11.2 出口为什么不是第二套 transport

`NS.activeEconomyProposalSink` 用的是**既有**的 `_activeCompanionRequest`
（`assets/js/active-diary.js` 里那条通向 23114 的既有传输）。
规划器（`active-plans.js`）不认识 23118、不认识凭据、`require` 零次、
不 `new` 任何服务器（F2、B5）。
P22-11 的 loopback + 凭据 + 信封 + 有界 body + 来源登记一条都没改。

---

## §12 Failure semantics

| 情况 | 结果 | 证据 |
|---|---|---|
| 模型输出 malformed | `null`，**零**请求，零重试 | E1 |
| 模型输出未知 / 禁止动作 | `null`（净化器在触到传输**之前**拒绝） | B9、E2 |
| 模型偷渡经济事实 | `null`，**传输一次都没发生** | E2、B4 |
| 下游 `DENY` / `REQUIRE_APPROVAL` | 只是 `delivery` + `reasonCode` 如实回传；`purchaseFailed`/`purchaseDenied` 恒 false | C3 |
| transport timeout / Home Node offline | `DELIVERY_UNKNOWN` / `TRANSPORT_FAILED`，`notAPurchaseVerdict:true`；**不**被写成购买失败或被拒 | E3 |
| 400（本机守护在触到传输前拒绝） | `TRANSPORT_FAILED` + `rejectedBeforeTransport:true`；**仍然不是**一条购买裁决 | E3 |

**Transport unknown ≠ Purchase failed。**

**没有重试。** 出口函数体里没有 `while` / `for` / `setTimeout` / `retry`（E4b），
这条链每次聊天只走一次，失败就如实结束（E4a）。
错误文本也不会变成"让模型自己调用底层补偿动作"的入口：`refund` / `reverse` /
`cancelPurchase` / `releaseReservation` / `settleNow` 这些动作名一样是未知动作 ⇒ fail closed（E7）。

---

## §13 不扩 consumer

* `active_agent_runtime` 仍然是**唯一**被绑上经济能力的消费者；
  `.bind('active_agent_runtime')` 与 `.bind('` 的总数都仍然是 **1**（A1）；
* 本阶段没有新增任何 `bind` 调用：生产者手里只有一条注入的出口，没有 capability handle（A2）；
* Chat / Group / Voice / Diary / MCP / desktop_bridge / home_node_authority
  一个都没有被接进经济链（A6）；
* Middle Brain 一个字节都没动（§1.1 的审计结论：它不是 Producer 必经 seam）。

---

## §14 测试与资源纪律

```text
tests/test_p22_12_economy_intent_producer.js   76 checks
tests/test_p22_12_economy_active_plan.js       36 checks
                                   合计        112 checks · 0 failed
```

第一个文件的证法值得写下来：四个**真实**浏览器文件
（`ib-namespace.js` / `home-node-client.js` / `active-diary/active-plans.js` /
`active-diary.js`，顺序与 `InternalBeyond.html` 一致）在一个 `vm` 沙箱里求值，
23114 用**真实的** `active/http.js` 工厂在本进程里 listen，
出站腿用**真实的** P22-11 通道客户端（只有 outbound fetch 是替身）。
唯一被替换掉的是浏览器的网络栈：沙箱的 `fetch` 把请求（方法/头/body 一字不改）
转发到 in-process 的真实路由上。

### 14.1 §14 的资源账

```text
max concurrent child = 0 · total spawn = 0 · leftover = 0
```

`child_process` 的七个入口在两个文件里都被替换成"计数并当场抛错"，
因此这一行不是自我声明，而是机器可判定的（G1 / F1）。
P22-11 已经用两个真实进程证明过跨进程通道，本阶段**没有**重跑那套证明；
本阶段自有的 invariant 全部是单进程可判定的。

没有启动 Desktop / Electron / Playwright / DSH / 浏览器 UI。

### 14.2 开发期踩到、并已修的四个真实问题

1. **镜像白名单少一个名字** ⇒ 每次真实提议都在 23114 拿到 400（§4.3）。
2. **镜像对顶层键做白名单** ⇒ P22-11 的 bridge 红 6 条，因为那个 fixture 把
   `{command, commandId, …}` 交给同一个净化器（§4.3）。
3. **模型给的 key 上不了路** ⇒ 通道每次新生成命令身份，P22-8 的幂等那条腿看不见
   生产者算好的身份（§10.1）。
4. **测试替身不区分 localStorage 键** ⇒ base URL 变成令牌本身
   （症状：请求 URL 是 `p22-12-desktop-token/economy/products`）。
   同一类问题还有一处：抽函数体时硬写 `'\n}\n'` 在 CRLF 文件上会切到文件末尾
   （症状：出口函数体里"出现"了 `for(` 与 `setTimeout`）。

---

## §15 回归与提交

* `tests/test-all.js` 登记了两个新文件（同一个 GROUPS 块里）。
* P22-1 ~ P22-12 **全量 29 个文件**：`ran=29 failed=0`。
* 聚合（static + service）结果见提交信息与 §16。

---

## §16 本阶段**没有**做的事（逐条说明，而不是省略）

1. **没有改任何生产 prompt 的既有部分** —— 新增的是一个**条件块**，
   闸门关着时 prompt 与 P22-11 逐字节相同（A1、A2）。
2. **没有开 Approval UI / 用户批准入口。** P22-10 的 `NO_APPROVAL_TRIGGER_SEAM`
   依然成立（C4）。
3. **没有接 `resume`**（B4 逐字断言它仍然只在 `NOT_OFFERED` 里）。
4. **没有 MCP / Chat / Group / Voice / Diary / 商店 UI / 素材 / Exchange /
   Refund / 真实 Provider quota / 真实支付**（A6、C5）。
5. **没有新造 planner / dispatcher / prompt framework / transport**（F1、F2、B5）。
6. **没有为 Economy 新增任何源文件**（E10：`services/home-node/*economy*` 仍然是
   那五个；没有 `economy-proposal-core.js`，也没有 `active/economy-planner.js`）。
7. **没有把凭据写进任何文件**：来源凭据仍然只从部署环境来（P22-11 §14）。
8. **没有为"让 Agent 更积极使用 Economy"改一个字。**
   `none` 仍然是一等正常决定；经济系统是一种可选能力，不是消费 KPI。

---

## §17 生产启用需要什么（在 P22-11 §14 之上的增量）

P22-11 §14 的四行环境变量**不变**（23118 与 23114 各两个键，成对）。
P22-12 之后，那把钥匙第一次同时打开**两边**：

```text
未配置  → /health 报 economy_proposals_enabled:false
        → 浏览器闸门 false → prompt 里连动作名都不出现 → 模型不知道可以提议
        → 23114 的 /economy/propose-purchase 分支不存在（404，P22-11 逐字保留）

已配置  → /health 报 true → 闸门 true → prompt 宣告这个动作（且必须真的有目录）
        → 生产者把模型选出的意图字段送进 P22-11 通道
```

仍然**没有**用户侧开关：闸门是**部署事实**，不是偏好设置（C6）。

---

## §18 Stop Gate 九问

### 1. Active 模型现在是否真的能产生 `economy_propose_purchase`，而不只是 sanitizer 能识别？

**是。** 四个真实浏览器文件在沙箱里求值，真实的 `buildPlanPrompt` 在闸门开且
有目录事实时真的宣告这个动作（A3）；真实的 `planNextProactiveMessage` 把模型
输出送回同一条净化链，真实的出口把它 POST 到 23114 的
`/economy/propose-purchase`（C1、C2），**真实的** `active/http.js` 路由 +
**真实的** P22-11 通道客户端接住它，并在 outbound 请求上带出
`X-IB-Economy-Channel-Source` 与唯一的那个 command（C4、C5、C6）。

★ 必须同时说清的另一半：**通道与实际送出都完整，但闸门默认是关的。**
未配置通道的部署里模型不会被告知这个动作存在 —— 这是刻意的（§11.1），
不是缺陷。

### 2. 模型是否只能提出 WANT，完全不能决定 Budget / Autonomy / Approval / Settlement？

**是。** 四个意图字段的白名单（B4、B7）；二十一个经济事实 / authority 键逐名拒绝；
`approved` / `autoAllow` 在**任何一层**（包括顶层）都是硬拒（B16b）；
prompt 里那些"你有权 / 足够就买 / 预算允许 / 已批准 / 自动结算"逐句不存在（A7），
而"没有预算权 / 没有批准权 / 全部由内部经济层决定 / 由内部审批层决定"逐句在（A8、A9）。

### 3. `none` 是否仍是一等正常输出，而不是被诱导消费？

**是。** 真实的 `none` 走完整条链：返回 `null`、零次经济请求、零字节发出（D3）；
prompt 里 `none` 仍是第 2 个可选动作，且经济段里写死了"当……是完全正确、
完全正常的决定"（A5）；消费激励短语零命中（A7）；
目录为空时连动作名都不出现（A6）。

### 4. 模型是否不能凭空编造价格、余额、批准或经济事实？

**是。** 编造的价格 / 金额 / 币种 / 余额 / 预算 / 批准 / 结算 / 账本 /
发放数量一律让整条提案 fail closed，而且是在**触到传输之前**（E2、B4）。
prompt 侧也拿不到这些事实：目录投影只有六个"商品是什么"的键（A10、A11、D2），
authority 数据面逐名不存在（A18）。

### 5. Gift 是否仍只表达"想送"，权限继续属于 P22-7？

**是。** 送礼就是 `recipientId` + `productId` + `reason` 三个字段（D1）；
代码里没有 `skipApproval` / `relationshipBypass`；prompt 明确否掉
"因为关系好所以不用批准"。经济侧那两份文件（含 P22-7 的审批）一个字节都没改（A5）。

### 6. Compute/API quota 是否仍明确只是 IB 内部 entitlement？

**是。** Prompt 逐字写了"内部 entitlement，不是 Provider 充值、不是真实 token、
不调用 Provider 计费"（A13）；代码里 `recharge` / `quota` / `providerBilling` /
`topup` / `COMPUTE_ENTITLEMENT` / `settlement` 在生产者里零出现（D2、E8）。

### 7. 模型输出是否必经既有 sanitizer → P22-11，而不存在直连 Economy Store 的路径？

**是。** 出口调用点在净化分支**之后**，而且只使用 `validated.*`（F4）；
规划器里没有 `require`、没有 23118、没有 `createServer`、没有 store / gate /
adapter / capability handle（F2、B5、A3）；出口是**注入**的，缺席即 fail closed
并如实记日志（F3）。

### 8. 是否只扩 `active_agent_runtime`，没有顺手扩 Chat/Group/Voice/Diary/MCP？

**是。** `.bind(` 总数仍是 1，且绑的仍是 `active_agent_runtime`（A1）；
本阶段没有新增任何 `bind`（A2）；Chat / Group / Voice / Diary / MCP /
desktop_bridge / home_node_authority 零引用（A6、C5）；Middle Brain 零改动（§1.1）。

### 9. 本阶段 max concurrent child / total spawn / leftover 分别是多少？

```text
max concurrent = 0 · total spawn = 0 · leftover = 0
```

两个测试文件都把 `child_process` 的七个入口替换成"计数并当场抛错"，
因此这是机器可判定的（G1 / F1），而不是一句自我声明。
